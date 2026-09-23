/**
 * _test_gui_master_unlock.ts — L3 本机受信 GUI→master 注入窄路径测试
 * （plans/0923_gui_master_unlock_impl.md §测试矩阵）。
 *
 *   E1 本机受信路径可注入（trustedLocal+gui+alive → accepted + outbox 落盘 + 审计行无正文）
 *   E2 无 policy/无 cookie 等价（header token）/gui 关 → 仍 403 master-session-protected
 *   E3 to===agent://master_default → 仍 403（回归，trusted 全开也不放宽）
 *   E4 非 master 目标 → 行为不变（accepted，不记审计）
 *   E5 master 离线 → master-offline（409）且零副作用（无 outbox、无审计）
 *   M2 同一 commandKey 离线 409 不占键 → 上线后同 key 真执行（非重放）+ 已执行 key 重放标记
 *   E6 审计行字段白名单独立用例（键集合精确、无 text/payload/token/cookie）
 *   U2 Host/Origin 混淆矩阵单测（evil 域/127.0.0.2/0.0.0.0/大小写/尾点/Host 缺失/
 *      Origin 端口错/Referer 单独/Origin:null/file:// 坏源/无 Origin+cookie 显式 accepted/
 *      header+cookie 双 present 以 cookie 为准）
 *   U3 审计文件 0600 + 超 ~1MB 轮转 `.1` 单测
 *   S1 Server 面：cookie+loopback Origin → 200；header-only → 403；坏 Origin → 403；
 *      gui-off → 403；离线 → 409；agent 地址 → 403；被拒三类记 denied 审计行（M3）
 *   S2 Bootstrap：OTT 签发→exchange 302+HttpOnly/SameSite=Strict cookie→复用 403；
 *      gui-off 签发 403；长 token 不进 body
 *   S1⑦ gui-off 服务器：cookie 也 403（通道不存在）+ denied 审计行（M3；bootstrap 403 不记审计）
 *   S3 对抗矩阵（HTTP 层）：Host 混淆（evil/127.0.0.2/0.0.0.0/大小写 200/尾点/缺失）/
 *      Origin 端口错/Referer 单独坏源/Origin:null/file:// 无 Origin+cookie 显式 accepted/
 *      header+cookie 双 present/OTT 并发双换（302+403 各一）/mint 后 gui-off 再 exchange → 403/
 *      未知 OTT → 403/bootstrap 方法错误 405/bootstrap 超大 body 413/
 *      被拒 denied 审计行断言（字段同 accepted、无正文/密钥）
 *   U1 checkTrustedLocalChannel/BootstrapStore/readGuiEnabled 单测
 *   F1 前端静态断言：master 输入框不再灰显 + 受信通道标注 + master-offline 映射保留
 *   B 派生单测（U1：确定性/≠本体/派生 cookie 授信）+ S2（Set-Cookie 精确串/堵自续期/派生 header 401）
 *     + S4（派生 cookie 命令面 200/旧本体 cookie 仍 200/gui-off 403+清除 cookie
 *     + L4 必修①预言机回归：/v1/challenge nonce=域常量 的 mac ≠ 派生值，且当 sw_gui_token
 *       打 /v1/commands → 401；WS 握手侧同断言在 _test_runtime_host_ws T11）
 *   R2：userinfo Host 单测（U2）/ gui-off 不核销 OTT（S3）/ exchange Host 缺失（S3）
 *
 * 运行：npm run test:gui-master-unlock
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 隔离（先于 import）
process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "gui-master-unlock-env-"));
const ROOT = process.env.PI_RUNTIME_DIR!;
const STATE = join(ROOT, "state");
const JOURNAL = join(ROOT, "events.jsonl");

import { masterAddress } from "./runtime/address.ts";
import { newCommandFrame, type CommandFrame } from "./runtime/protocol.ts";
import { executeCommand, type CommandOutcome, type ExecuteCommandOptions } from "./runtime/command-executor.ts";
import { attachMaster, readAttachment } from "./runtime/registry.ts";
import { attachmentPathFor } from "./runtime/registry.ts";
import { listOutboxItems, outboxDir } from "./runtime/message-outbox.ts";
import {
	BOOTSTRAP_OTT_TTL_MS,
	MASTER_INJECTION_AUDIT_FILE,
	MASTER_INJECTION_AUDIT_MAX_BYTES,
	GUI_COOKIE_MAX_AGE_SECONDS,
	GUI_COOKIE_NAME,
	auditMasterInjection,
	checkTrustedLocalChannel,
	createBootstrapStore,
	deriveGuiToken,
	readGuiEnabled,
} from "./runtime/master-injection.ts";
import { touchSessionHeartbeat } from "./timers.ts";
import { createRuntimeHostServer } from "./runtime-host/server.ts";
import { readFileSync as readFs } from "node:fs";

const MASTER_SID = "m1111111-2222-3333-4444-555555555555";
const OTHER_SID = "c2222222-3333-4444-5555-666666666666";
let tick = 0;
const iso = (): string => new Date(Date.now() + tick++).toISOString();

function sessionFrame(to: string, commandKey: string, text = "hello master"): CommandFrame {
	return newCommandFrame({
		type: "session.message",
		to: to as CommandFrame["to"],
		issuedBy: "agent://runtime-host" as CommandFrame["issuedBy"],
		commandKey,
		issuedAt: iso(),
		payload: { text },
	});
}

function exec(f: CommandFrame, opts: ExecuteCommandOptions = {}): CommandOutcome {
	return executeCommand(f, { stateDir: STATE, journalPath: JOURNAL, sessionsDir: SESSIONS, ...opts });
}

function writeSessionFile(dir: string, sid: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, `2026-09-23T00-00-00-000Z_${sid}.jsonl`),
		`{"type":"session","version":3,"id":"${sid}","timestamp":"2026-09-23T00:00:00.000Z","cwd":"C:\\\\ws"}\n`,
		"utf8",
	);
}

function outboxCount(): number {
	return listOutboxItems(outboxDir(STATE)).length;
}

function auditLines(): string[] {
	const f = join(STATE, "master-injections.jsonl");
	if (!existsSync(f)) return [];
	return readFileSync(f, "utf8").split("\n").filter((l) => l.trim().length > 0);
}

const SESSIONS = join(ROOT, "sessions");
writeSessionFile(SESSIONS, MASTER_SID);
writeSessionFile(SESSIONS, OTHER_SID);
touchSessionHeartbeat(join(ROOT, "timers"), MASTER_SID);
attachMaster({ sessionId: MASTER_SID });
assert.equal(readAttachment(masterAddress())?.sessionId, MASTER_SID, "附件基线：master owner = MASTER_SID");

const TRUSTED = { trustedLocal: true, guiEnabled: true, masterAlive: true, source: "127.0.0.1 test" };

// ── E1：受信路径可注入 ─────────────────────────────────────────────
{
	const before = outboxCount();
	const o = exec(sessionFrame(`pi://${MASTER_SID}`, "e1-trusted-ok"), { trustedMasterInjection: TRUSTED });
	assert.equal(o.status, "accepted", `E1 受信 master 注入 accepted（实际 ${JSON.stringify(o)}）`);
	assert.equal(outboxCount(), before + 1, "E1 outbox +1（两段式第一段落盘）");
	const lines = auditLines();
	assert.equal(lines.length, 1, "E1 审计行 +1");
	const rec = JSON.parse(lines[0]) as Record<string, unknown>;
	assert.equal(rec.result, "accepted");
	assert.equal(rec.targetSessionId, MASTER_SID);
	assert.equal(rec.commandKey, "e1-trusted-ok");
	assert.ok(!("text" in rec), "E1 审计无正文字段");
	assert.ok(!JSON.stringify(rec).includes("hello master"), "E1 审计不含正文内容");
}

// ── E2：缺省/坏策略 → 仍 403 ───────────────────────────────────────
{
	for (const [name, pol] of [
		["no-policy", undefined],
		["header-channel", { ...TRUSTED, trustedLocal: false }],
		["gui-off", { ...TRUSTED, guiEnabled: false }],
	] as const) {
		const before = outboxCount();
		const aBefore = auditLines().length;
		const o = exec(sessionFrame(`pi://${MASTER_SID}`, `e2-${name}`), pol === undefined ? {} : { trustedMasterInjection: pol });
		assert.equal(o.status, "rejected", `E2 ${name} 拒绝`);
		assert.equal((o as { reason?: string }).reason, "master-session-protected", `E2 ${name} 仍 403 master-session-protected`);
		assert.equal(outboxCount(), before, `E2 ${name} 零 outbox 副作用`);
		assert.equal(auditLines().length, aBefore, `E2 ${name} 零审计副作用`);
	}
}

// ── E3：agent://master_default 永不放宽 ─────────────────────────────
{
	const f = newCommandFrame({
		type: "session.message",
		to: masterAddress(),
		issuedBy: "agent://runtime-host" as CommandFrame["issuedBy"],
		commandKey: "e3-master-addr",
		issuedAt: iso(),
		payload: { text: "x" },
	});
	const o = exec(f, { trustedMasterInjection: TRUSTED });
	assert.equal(o.status, "rejected");
	assert.equal((o as { reason?: string }).reason, "master-session-protected", "E3 agent 地址 trusted 全开仍 403");
}

// ── E4：非 master 目标行为不变（accepted，不记审计）─────────────────
{
	const aBefore = auditLines().length;
	const o = exec(sessionFrame(`pi://${OTHER_SID}`, "e4-other", "hi other"), { trustedMasterInjection: TRUSTED });
	assert.equal(o.status, "accepted", "E4 非 master 目标 accepted");
	assert.equal(auditLines().length, aBefore, "E4 非 master 不记 master 审计");
}

// ── E5：master 离线 → master-offline + 零副作用 ─────────────────────
{
	const before = outboxCount();
	const aBefore = auditLines().length;
	const o = exec(sessionFrame(`pi://${MASTER_SID}`, "e5-offline"), {
		trustedMasterInjection: { ...TRUSTED, masterAlive: false },
	});
	assert.equal(o.status, "rejected");
	assert.equal((o as { reason?: string }).reason, "master-offline", "E5 master-offline");
	assert.ok(((o as { detail?: string }).detail ?? "").includes("请在电脑端打开 master 会话"), "E5 文案含开机会话指引");
	assert.equal(outboxCount(), before, "E5 零 outbox 副作用");
	assert.equal(auditLines().length, aBefore, "E5 零审计副作用");
}

// ── M2：离线 409 不占 commandKey，上线后同 key 真执行 ─────────────────
{
	const before = outboxCount();
	const off = exec(sessionFrame(`pi://${MASTER_SID}`, "m2-retry-key"), {
		trustedMasterInjection: { ...TRUSTED, masterAlive: false },
	});
	assert.equal(off.status, "rejected");
	assert.equal((off as { reason?: string }).reason, "master-offline", "M2 离线预检 409");
	assert.equal((off as { replayed?: boolean }).replayed, false);
	assert.equal(outboxCount(), before, "M2 离线零 outbox（预检在 claim 之前）");
	// 同 key 上线后重发 → 真正执行（accepted 且非重放），而非重放 409
	const on = exec(sessionFrame(`pi://${MASTER_SID}`, "m2-retry-key"), { trustedMasterInjection: TRUSTED });
	assert.equal(on.status, "accepted", `M2 同 key 上线后真执行（实际 ${JSON.stringify(on)}）`);
	assert.equal((on as { replayed?: boolean }).replayed, false, "M2 非重放（key 未被离线 409 消耗）");
	assert.equal(outboxCount(), before + 1, "M2 outbox +1");
	// 已执行的 key 再重发 → replayed accepted（幂等语义对照）
	const rp = exec(sessionFrame(`pi://${MASTER_SID}`, "m2-retry-key"), { trustedMasterInjection: TRUSTED });
	assert.equal(rp.status, "accepted");
	assert.equal((rp as { replayed?: boolean }).replayed, true, "M2 已执行 key 重放标记");
	assert.equal(outboxCount(), before + 1, "M2 重放零二次副作用");
}

// ── E6：审计行字段白名单（独立用例）──────────────────────────────────
{
	const lines = auditLines();
	assert.ok(lines.length >= 2, `E6 审计行存在（E1+M2 accepted，实际 ${lines.length} 行）`);
	for (const line of lines) {
		const rec = JSON.parse(line) as Record<string, unknown>;
		assert.deepEqual(Object.keys(rec).sort(), ["at", "by", "commandKey", "result", "source", "targetSessionId"], "E6 审计键集合精确（无新增/缺失字段）");
		assert.ok(!("text" in rec) && !("payload" in rec) && !("token" in rec) && !("cookie" in rec), "E6 无正文/payload/token/cookie 字段");
		assert.ok(["accepted", "denied"].includes(rec.result as string), "E6 result 词表内");
	}
}

// ── U1：策略库单测 ─────────────────────────────────────────────────
{
	const fakeReq = (headers: Record<string, string | string[] | undefined>, remote = "127.0.0.1"): never =>
		({ headers, socket: { remoteAddress: remote } }) as never;
	const port = 4321;
	const tok = "tok-abc-123";
	const okReq = fakeReq({ host: `127.0.0.1:${port}`, cookie: `sw_host_token=${tok}`, origin: `http://127.0.0.1:${port}` });
	const r1 = checkTrustedLocalChannel(okReq as never, tok, port);
	assert.equal(r1.ok, true, "U1 cookie+loopback+同源授信");
	assert.equal(r1.via, "cookie");
	// header 通道不授信
	const r2 = checkTrustedLocalChannel(
		fakeReq({ host: `127.0.0.1:${port}`, "x-command-token": tok }) as never, tok, port,
	);
	assert.equal(r2.ok, false, "U1 header token 不授信");
	assert.equal(r2.reason, "header-token-not-cookie-channel");
	// 坏 Origin / 跨站
	const r3 = checkTrustedLocalChannel(
		fakeReq({ host: `127.0.0.1:${port}`, cookie: `sw_host_token=${tok}`, origin: "https://evil.example" }) as never, tok, port,
	);
	assert.equal(r3.ok, false, "U1 跨站 Origin 拒绝");
	// 非 loopback socket
	const r4 = checkTrustedLocalChannel(fakeReq({ host: `127.0.0.1:${port}`, cookie: `sw_host_token=${tok}` }, "10.0.0.9") as never, tok, port);
	assert.equal(r4.ok, false, "U1 非回环 socket 拒绝");
	// 无 cookie
	const r5 = checkTrustedLocalChannel(fakeReq({ host: `127.0.0.1:${port}` }) as never, tok, port);
	assert.equal(r5.ok, false, "U1 无 cookie 拒绝");

	// B 案派生：确定性、≠本体、hex 64 字符、不可逆（HMAC 单向；不同本体不同派生）
	{
		const g1 = deriveGuiToken(tok);
		assert.equal(g1, deriveGuiToken(tok), "B 派生确定性（同本体同值）");
		assert.equal(g1.length, 64, "B 派生 hex 64 字符");
		assert.ok(!g1.includes(tok) && !tok.includes(g1), "B 派生值≠本体（双向不含子串）");
		assert.notEqual(deriveGuiToken("other-token"), g1, "B 不同本体不同派生");
		assert.equal(deriveGuiToken(""), "", "B 空本体无派生");
		assert.equal(deriveGuiToken(null), "", "B null 本体无派生");
	}
	// B 案：派生 cookie 呈现授信（via cookie）；派生值当 header 用不授信
	{
		const gui = deriveGuiToken(tok);
		const r = checkTrustedLocalChannel(
			fakeReq({ host: `127.0.0.1:${port}`, cookie: `${GUI_COOKIE_NAME}=${gui}` }) as never, tok, port,
		);
		assert.equal(r.ok, true, "B 派生 cookie 授信");
		assert.equal(r.via, "cookie");
	}

	// OTT：签发→核销一次→复用失败；过期失败；非串失败
	const store = createBootstrapStore(() => 1_000);
	const { ott } = store.mint(60_000);
	assert.equal(ott.length, 32, "U1 OTT 32 hex");
	assert.equal(store.consume(ott), true, "U1 首次核销ok");
	assert.equal(store.consume(ott), false, "U1 复用拒绝");
	assert.equal(store.consume("f".repeat(32)), false, "U1 未知 OTT 拒绝");
	assert.equal(store.consume("short"), false, "U1 非法形状拒绝");
	const exp = createBootstrapStore(() => 1_000);
	const m2 = exp.mint(10);
	const exp2 = createBootstrapStore(() => 2_000);
	// 跨实例不共享（进程内存）；同实例过期：用可变 now
	let now = 1_000;
	const s3 = createBootstrapStore(() => now);
	const m3 = s3.mint(100);
	now = 5_000;
	assert.equal(s3.consume(m3.ott), false, "U1 过期 OTT 拒绝");
	void m2;
	void exp2;

	// gui 开关
	const cfgOn = join(ROOT, "cfg-on.json");
	const cfgOff = join(ROOT, "cfg-off.json");
	writeFileSync(cfgOn, JSON.stringify({ gui: { autoStart: true } }), "utf8");
	writeFileSync(cfgOff, JSON.stringify({ gui: { autoStart: false } }), "utf8");
	assert.equal(readGuiEnabled(cfgOn), true, "U1 gui on");
	assert.equal(readGuiEnabled(cfgOff), false, "U1 gui off");
	assert.equal(readGuiEnabled(join(ROOT, "nope.json")), false, "U1 缺文件默认 OFF");
	assert.equal(BOOTSTRAP_OTT_TTL_MS, 60_000, "U1 OTT TTL 60s");
}

// ── U2：Host/Origin 混淆矩阵（与 HTTP 层同一判定实现）──────────────────
{
	const fakeReq = (headers: Record<string, string | string[] | undefined>, remote = "127.0.0.1"): never =>
		({ headers, socket: { remoteAddress: remote } }) as never;
	const port = 4321;
	const tok = "tok-abc-123";
	const ck = `sw_host_token=${tok}`;
	// Host 混淆：evil 后缀 / 127.0.0.2 / 0.0.0.0 / 尾点 / 缺失 → 拒绝
	for (const [name, host] of [
		["evil", "evil-localhost.com"],
		["127.0.0.2", `127.0.0.2:${port}`],
		["0.0.0.0", `0.0.0.0:${port}`],
		["trailing-dot", "localhost."],
		["suffix", "127.0.0.1.evil.com"],
	] as const) {
		const r = checkTrustedLocalChannel(fakeReq({ host, cookie: ck }) as never, tok, port);
		assert.equal(r.ok, false, `U2 Host 混淆 ${name} 拒绝`);
		assert.equal(r.reason, "non-loopback-host", `U2 Host 混淆 ${name} 原因码`);
	}
	// Host 缺失 → 拒绝
	{
		const r = checkTrustedLocalChannel(fakeReq({ cookie: ck }) as never, tok, port);
		assert.equal(r.ok, false, "U2 Host 缺失拒绝");
		assert.equal(r.reason, "non-loopback-host");
	}
	// R2①：Host 含 userinfo（user@127.0.0.1）→ 拒绝（fail-closed：normHost 不剥 userinfo，不在封闭集）
	{
		const r = checkTrustedLocalChannel(fakeReq({ host: `user@127.0.0.1:${port}`, cookie: ck }) as never, tok, port);
		assert.equal(r.ok, false, "R2 userinfo Host 拒绝");
		assert.equal(r.reason, "non-loopback-host");
	}
	// 大小写 → 接受（fail-closed 方向外、可用性方向内：toLowerCase 归一）
	{
		const r = checkTrustedLocalChannel(fakeReq({ host: `LOCALHOST:${port}`, cookie: ck }) as never, tok, port);
		assert.equal(r.ok, true, "U2 大小写 Host 接受");
	}
	// Origin: null / file:// → 拒绝
	for (const [name, origin] of [["null", "null"], ["file", "file:///etc/passwd"]] as const) {
		const r = checkTrustedLocalChannel(fakeReq({ host: `127.0.0.1:${port}`, cookie: ck, origin }) as never, tok, port);
		assert.equal(r.ok, false, `U2 Origin ${name} 拒绝`);
		assert.equal(r.reason, "bad-origin");
	}
	// 无 Origin + 有效 cookie → 显式 accepted（curl -b 本地行为，预期行为固化，防后人误判为漏洞）
	{
		const r = checkTrustedLocalChannel(fakeReq({ host: `127.0.0.1:${port}`, cookie: ck }) as never, tok, port);
		assert.equal(r.ok, true, "U2 无 Origin+cookie 显式 accepted");
		assert.equal(r.via, "cookie");
	}
	// Origin 端口≠daemon 端口 → 拒绝
	{
		const r = checkTrustedLocalChannel(
			fakeReq({ host: `127.0.0.1:${port}`, cookie: ck, origin: "http://127.0.0.1:9999" }) as never, tok, port,
		);
		assert.equal(r.ok, false, "U2 Origin 端口错拒绝");
		assert.equal(r.reason, "bad-origin");
	}
	// Referer 单独出现：坏 → 拒绝；好 → 接受（与 Origin 同规则）
	{
		const bad = checkTrustedLocalChannel(
			fakeReq({ host: `127.0.0.1:${port}`, cookie: ck, referer: `http://127.0.0.1:9999/x` }) as never, tok, port,
		);
		assert.equal(bad.ok, false, "U2 坏 Referer 单独出现拒绝");
		const good = checkTrustedLocalChannel(
			fakeReq({ host: `127.0.0.1:${port}`, cookie: ck, referer: `http://127.0.0.1:${port}/` }) as never, tok, port,
		);
		assert.equal(good.ok, true, "U2 好 Referer 单独出现接受");
	}
	// header+cookie 双 present → 以 cookie 为准（header 坏也不影响）
	{
		const r = checkTrustedLocalChannel(
			fakeReq({ host: `127.0.0.1:${port}`, cookie: ck, "x-command-token": "wrong" }) as never, tok, port,
		);
		assert.equal(r.ok, true, "U2 双 present 以 cookie 为准");
		assert.equal(r.via, "cookie");
	}
	// OTT 过期（推进时钟）：同一 consume 路径，HTTP 层 60s 语义由此保证
	{
		let now = 1_000;
		const s = createBootstrapStore(() => now);
		const m = s.mint(60_000);
		now = 61_001;
		assert.equal(s.consume(m.ott), false, "U2 OTT 过期拒绝");
	}
}

// ── U3：审计文件 0600 + 超限轮转 ─────────────────────────────────────
{
	const ad = mkdtempSync(join(tmpdir(), "gui-master-unlock-audit-"));
	try {
		const rec = (key: string) => ({
			at: new Date().toISOString(), by: "agent://runtime-host", targetSessionId: MASTER_SID,
			source: "127.0.0.1 test", result: "accepted" as const, commandKey: key,
		});
		assert.equal(auditMasterInjection(ad, rec("u3-a")), true, "U3 审计写入ok");
		const f = join(ad, MASTER_INJECTION_AUDIT_FILE);
		assert.ok(existsSync(f), "U3 审计文件落盘");
		if (process.platform !== "win32") {
			assert.equal(statSync(f).mode & 0o777, 0o600, "U3 审计文件 0600");
		}
		// 体积上限：pad 超 ~1MB 后再记一行 → 旧文件轮转为 .1，主文件只剩新行
		writeFileSync(f, `${"x".repeat(MASTER_INJECTION_AUDIT_MAX_BYTES + 8)}\n`, "utf8");
		assert.equal(auditMasterInjection(ad, rec("u3-b")), true, "U3 超限后仍可记");
		assert.ok(existsSync(`${f}.1`), "U3 超限轮转 .1");
		assert.ok(statSync(f).size < MASTER_INJECTION_AUDIT_MAX_BYTES, "U3 主文件已轮转截断");
		assert.ok(readFileSync(f, "utf8").includes("u3-b"), "U3 新行在主文件");
	} finally {
		rmSync(ad, { recursive: true, force: true });
	}
}

// ── F1：前端静态断言 ───────────────────────────────────────────────
{
	const chat = readFs("gui/src/pages/ChatPage.tsx", "utf8");
	assert.ok(chat.includes("Master 会话拒绝远程输入"), "F1 旧文案短语保留（zcode 回归）");
	assert.ok(chat.includes("经本机受信通道注入"), "F1 受信通道 UI 标注");
	assert.ok(!chat.includes("disabled={activeId === null || isMasterSession}"), "F1 master 输入框不再灰显");
	const store = readFs("gui/src/store.ts", "utf8");
	assert.ok(store.includes("master-offline"), "F1 store 映射 master-offline");
	assert.ok(store.includes("请在电脑端打开 master 会话"), "F1 离线指引文案");
}

// ── S1/S2：Server 面 ───────────────────────────────────────────────
{
	const D = mkdtempSync(join(tmpdir(), "gui-master-unlock-srv-"));
	const sessionsDir = join(D, "sessions");
	writeSessionFile(sessionsDir, MASTER_SID);
	writeSessionFile(sessionsDir, OTHER_SID);
	const timersDir = join(D, "timers");
	touchSessionHeartbeat(timersDir, MASTER_SID);
	const cfgOn = join(D, "config-on.json");
	const cfgOff = join(D, "config-off.json");
	writeFileSync(cfgOn, JSON.stringify({ gui: { autoStart: true } }), "utf8");
	writeFileSync(cfgOff, JSON.stringify({ gui: { autoStart: false } }), "utf8");

	const h = await createRuntimeHostServer({
		hostPath: join(D, "host.json"),
		stateDir: join(D, "state"),
		journalPath: join(D, "events.jsonl"),
		timersDir,
		mailboxDir: join(D, "mailbox"),
		sessionsDir,
		configPath: cfgOn,
		lockWaitMs: 1000,
	});
	try {
		const base = `http://127.0.0.1:${h.info.port}`;
		const tok = h.info.token!;
		const sm = (key: string, to: string) => ({
			frame: "command", type: "session.message", to, commandKey: key,
			issuedAt: new Date().toISOString(), payload: { text: "srv-hello" },
		});
		const post = async (body: unknown, headers: Record<string, string>): Promise<{ status: number; body: never }> => {
			const res = await fetch(`${base}/v1/commands`, {
				method: "POST",
				headers: { "content-type": "application/json", ...headers },
				body: JSON.stringify(body),
			});
			return { status: res.status, body: (await res.json()) as never };
		};
		const cookie = { Cookie: `sw_host_token=${tok}`, Origin: `http://127.0.0.1:${h.info.port}` };

		// S1① cookie+同源 → 200
		const ok = await post(sm("s1-ok", `pi://${MASTER_SID}`), cookie);
		assert.equal(ok.status, 200, `S1 cookie 受信 200（实际 ${ok.status} ${JSON.stringify(ok.body)}）`);
		assert.equal((ok.body as { status?: string }).status, "accepted");
		// 审计落盘且无正文
		const auditF = join(D, "state", "master-injections.jsonl");
		assert.ok(existsSync(auditF), "S1 审计文件落盘");
		const aline = readFileSync(auditF, "utf8").trim();
		assert.ok(!aline.includes("srv-hello") && !aline.includes('"text"'), "S1 审计无正文");

		// S1② header-only → 403（非浏览器通道）
		const hdr = await post(sm("s1-hdr", `pi://${MASTER_SID}`), { "x-command-token": tok });
		assert.equal(hdr.status, 403, "S1 header-only 仍 403");
		assert.equal((hdr.body as { reason?: string }).reason, "master-session-protected");

		// S1③ 坏 Origin → 403
		const evil = await post(sm("s1-evil", `pi://${MASTER_SID}`), {
			Cookie: `sw_host_token=${tok}`, Origin: "https://evil.example",
		});
		assert.equal(evil.status, 403, "S1 跨站 Origin 仍 403");

		// S1④ agent 地址 trusted 全开 → 仍 403
		const ma = await post({ ...sm("s1-ma", masterAddress()) }, cookie);
		assert.equal(ma.status, 403, "S1 agent://master_default 仍 403");

		// S1⑤ 非 master 目标 cookie → 200（不变）
		const other = await post(sm("s1-other", `pi://${OTHER_SID}`), cookie);
		assert.equal(other.status, 200, "S1 非 master 目标行为不变");

		// S2 bootstrap：签发→exchange→复用拒绝；长 token 不进 body
		const bRes = await fetch(`${base}/v1/bootstrap`, { method: "POST", headers: { "x-command-token": tok } });
		assert.equal(bRes.status, 200, "S2 OTT 签发 200");
		const bBody = (await bRes.json()) as { ott?: unknown };
		assert.equal(typeof bBody.ott, "string", "S2 OTT 为串");
		assert.ok(!(JSON.stringify(bBody).includes(tok)), "S2 长 token 不进 body");
		const ex = await fetch(`${base}/v1/bootstrap/exchange?ott=${bBody.ott}`, { redirect: "manual" });
		assert.equal(ex.status, 302, "S2 exchange 302");
		// B 案 Set-Cookie 精确断言：名 sw_gui_token + 值=派生值 + HttpOnly + SameSite=Strict + Path=/ + Max-Age=43200，且不含 host token 明文
		const sc = ex.headers.get("set-cookie") ?? "";
		const guiTok = deriveGuiToken(tok);
		assert.ok(sc.startsWith(`${GUI_COOKIE_NAME}=`), `S2 cookie 名 sw_gui_token（实际 ${sc.slice(0, 40)}…）`);
		assert.ok(sc.includes(`${GUI_COOKIE_NAME}=${guiTok};`), "S2 cookie 值=派生值");
		assert.ok(sc.includes("HttpOnly"), "S2 HttpOnly");
		assert.ok(sc.includes("SameSite=Strict"), "S2 SameSite=Strict");
		assert.ok(sc.includes("Path=/"), "S2 Path=/");
		assert.ok(sc.includes(`Max-Age=${GUI_COOKIE_MAX_AGE_SECONDS}`), "S2 Max-Age=43200（12h）");
		assert.ok(!sc.includes(tok), "S2 Set-Cookie 不含 host token 明文（浏览器不再持本体）");
		assert.equal(GUI_COOKIE_MAX_AGE_SECONDS, 43200, "S2 TTL 常量 12h");
		assert.ok(!(await ex.text()).includes(tok), "S2 exchange 响应体不含 token");
		const reuse = await fetch(`${base}/v1/bootstrap/exchange?ott=${bBody.ott}`, { redirect: "manual" });
		assert.equal(reuse.status, 403, "S2 OTT 复用 403");
		// B 案堵自续期：/v1/bootstrap + sw_gui_token（cookie 或 header）→ 401
		{
			const g1 = await fetch(`${base}/v1/bootstrap`, { method: "POST", headers: { Cookie: `${GUI_COOKIE_NAME}=${guiTok}` } });
			assert.equal(g1.status, 401, "S2 bootstrap + 派生 cookie → 401（无自续期）");
			const g2 = await fetch(`${base}/v1/bootstrap`, { method: "POST", headers: { "x-command-token": guiTok } });
			assert.equal(g2.status, 401, "S2 bootstrap + 派生 header → 401");
		}
		// B 案：X-Command-Token: <派生值> 打 /v1/commands → 401（派生值不得当 header 用）
		{
			const bad = await post(sm("s2-gui-header", `pi://${MASTER_SID}`), { "x-command-token": guiTok });
			assert.equal(bad.status, 401, "S2 派生 header 打 commands → 401");
		}

		// S1⑥ 离线 → 409 master-offline 且零副作用（删心跳模拟从未来过/过期）
		rmSync(join(timersDir, "sessions"), { recursive: true, force: true });
		const obBefore = readdirSync(join(D, "state", "message-outbox")).length;
		const off = await post(sm("s1-off", `pi://${MASTER_SID}`), cookie);
		assert.equal(off.status, 409, "S1 离线 409");
		assert.equal((off.body as { reason?: string }).reason, "master-offline");
		assert.ok((((off.body as { detail?: string }).detail) ?? "").includes("请在电脑端打开 master 会话"), "S1 离线文案");
		assert.equal(readdirSync(join(D, "state", "message-outbox")).length, obBefore, "S1 离线零 outbox 副作用");

		// M3：窄路径被拒三类（header-only/坏 Origin/离线）各记一行 denied（字段同 accepted、无正文/密钥）
		{
			const lines = readFileSync(auditF, "utf8").split("\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
			const byKey = new Map(lines.map((r) => [r.commandKey, r] as const));
			assert.equal(byKey.get("s1-ok")?.result, "accepted", "S1 accepted 行仍在");
			for (const k of ["s1-hdr", "s1-evil", "s1-off"]) {
				const r = byKey.get(k);
			assert.equal(r?.result, "denied", `S1 ${k} 记 denied`);
				assert.equal(r?.targetSessionId, MASTER_SID, `S1 ${k} 目标为 master`);
				assert.deepEqual(Object.keys(r).sort(), ["at", "by", "commandKey", "result", "source", "targetSessionId"], `S1 ${k} 字段同 accepted`);
				const s = JSON.stringify(r);
				assert.ok(!s.includes("srv-hello") && !s.includes(tok), `S1 ${k} 无正文/密钥`);
			}
			// 非窄路径拒绝不记 denied：agent 地址（无 policy）与非 master 目标（accepted 不记）
			assert.ok(!byKey.has("s1-ma") && !byKey.has("s1-other"), "S1 非窄路径零 denied");
		}
	} finally {
		await h.close();
		rmSync(D, { recursive: true, force: true });
	}

	// S1⑦ gui-off 服务器：cookie 也 403（通道不存在）
	{
		const D2 = mkdtempSync(join(tmpdir(), "gui-master-unlock-off-"));
		const sessionsDir2 = join(D2, "sessions");
		writeSessionFile(sessionsDir2, MASTER_SID);
		const timersDir2 = join(D2, "timers");
		touchSessionHeartbeat(timersDir2, MASTER_SID);
		const h2 = await createRuntimeHostServer({
			hostPath: join(D2, "host.json"),
			stateDir: join(D2, "state"),
			journalPath: join(D2, "events.jsonl"),
			timersDir: timersDir2,
			mailboxDir: join(D2, "mailbox"),
			sessionsDir: sessionsDir2,
			configPath: cfgOff,
			lockWaitMs: 1000,
		});
		try {
			const base = `http://127.0.0.1:${h2.info.port}`;
			const res = await fetch(`${base}/v1/commands`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					Cookie: `sw_host_token=${h2.info.token}`,
					Origin: `http://127.0.0.1:${h2.info.port}`,
				},
				body: JSON.stringify({
					frame: "command", type: "session.message", to: `pi://${MASTER_SID}`,
					commandKey: "s1-off-cfg", issuedAt: new Date().toISOString(), payload: { text: "x" },
				}),
			});
			assert.equal(res.status, 403, "S1 gui-off 通道不存在（仍 403）");
			// M3：gui-off 被拒记一行 denied（字段同 accepted、无正文）；bootstrap 403 不记审计
			const auditF2 = join(D2, "state", "master-injections.jsonl");
			assert.ok(existsSync(auditF2), "S1 gui-off denied 落盘");
			{
				const lines = readFileSync(auditF2, "utf8").split("\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
				assert.equal(lines.length, 1, "S1 gui-off 仅一行 denied");
				assert.equal(lines[0].result, "denied");
				assert.equal(lines[0].commandKey, "s1-off-cfg");
				assert.deepEqual(Object.keys(lines[0]).sort(), ["at", "by", "commandKey", "result", "source", "targetSessionId"]);
			}
			// bootstrap 签发亦 403
			const b = await fetch(`${base}/v1/bootstrap`, { method: "POST", headers: { "x-command-token": h2.info.token! } });
			assert.equal(b.status, 403, "S1 gui-off bootstrap 403");
			assert.equal(readFileSync(auditF2, "utf8").split("\n").filter((l) => l.trim().length > 0).length, 1, "S1 bootstrap 403 不记 denied（仅注入门记）");
		} finally {
			await h2.close();
			rmSync(D2, { recursive: true, force: true });
		}
	}
}

// ── S4：B 案浏览器凭据作用域化（派生 cookie 命令面 + gui-off 机会式清除）──
{
	const D4 = mkdtempSync(join(tmpdir(), "gui-cookie-scoping-"));
	const sessionsDir4 = join(D4, "sessions");
	writeSessionFile(sessionsDir4, MASTER_SID);
	writeSessionFile(sessionsDir4, OTHER_SID);
	const timersDir4 = join(D4, "timers");
	touchSessionHeartbeat(timersDir4, MASTER_SID);
	const cfg4 = join(D4, "config.json");
	writeFileSync(cfg4, JSON.stringify({ gui: { autoStart: true } }), "utf8");
	const h4 = await createRuntimeHostServer({
		hostPath: join(D4, "host.json"),
		stateDir: join(D4, "state"),
		journalPath: join(D4, "events.jsonl"),
		timersDir: timersDir4,
		mailboxDir: join(D4, "mailbox"),
		sessionsDir: sessionsDir4,
		configPath: cfg4,
		lockWaitMs: 1000,
	});
	try {
		const base = `http://127.0.0.1:${h4.info.port}`;
		const tok4 = h4.info.token!;
		const gui4 = deriveGuiToken(tok4);
		assert.ok(gui4.length === 64 && gui4 !== tok4, "S4 派生值≠本体先决");
		const sm4 = (key: string, to: string) => JSON.stringify({
			frame: "command", type: "session.message", to, commandKey: key,
			issuedAt: new Date().toISOString(), payload: { text: "gui-hello" },
		});
		const cmd = async (key: string, to: string, headers: Record<string, string>): Promise<{ status: number; body: never; setCookie: string }> => {
			const res = await fetch(`${base}/v1/commands`, {
				method: "POST",
				headers: { "content-type": "application/json", ...headers },
				body: sm4(key, to),
			});
			return { status: res.status, body: (await res.json()) as never, setCookie: res.headers.get("set-cookie") ?? "" };
		};
		const origin = { Origin: `http://127.0.0.1:${h4.info.port}` };
		// L4 必修①预言机回归：无认证 /v1/challenge 取 nonce=域常量，mac 必须 ≠ 派生值，
		// 且不得作为 sw_gui_token 过 /v1/commands（堵“挑战端点铸造派生凭据”洞）。
		{
			const ch = await fetch(`${base}/v1/challenge`, {
				method: "POST", headers: { "content-type": "application/json" },
				body: JSON.stringify({ nonce: "pi:gui-cookie:v1" }),
			});
			assert.equal(ch.status, 200, "S4 挑战端点仍 200（协议形状不变）");
			const mac = ((await ch.json()) as { mac?: string }).mac ?? "";
			assert.equal(mac.length, 64, "S4 预言机 mac 为 64 hex");
			assert.notEqual(mac, gui4, "S4 预言机 nonce=域常量 ≠ 派生值（key/msg 已互换，洞已堵）");
			const r = await cmd("s4-oracle-mac", `pi://${OTHER_SID}`, { Cookie: `${GUI_COOKIE_NAME}=${mac}`, ...origin });
			assert.equal(r.status, 401, `S4 预言机 mac 当 sw_gui_token 打 commands → 401（实际 ${r.status}）`);
		}
		// 派生 cookie 打 master 目标 → 200（受信通道经派生凭据成立）
		{
			const r = await cmd("s4-gui-ok", `pi://${MASTER_SID}`, { Cookie: `${GUI_COOKIE_NAME}=${gui4}`, ...origin });
			assert.equal(r.status, 200, `S4 派生 cookie 受信 200（实际 ${r.status} ${JSON.stringify(r.body)}）`);
			assert.equal((r.body as { status?: string }).status, "accepted");
		}
		// 派生 cookie 打非 master 目标 → 200（行为不变）
		{
			const r = await cmd("s4-gui-other", `pi://${OTHER_SID}`, { Cookie: `${GUI_COOKIE_NAME}=${gui4}`, ...origin });
			assert.equal(r.status, 200, "S4 派生 cookie 非 master 目标 200");
		}
		// 旧本体 cookie 仍过（dev/既有测试兼容；_test_runtime_commands cookie 用例同语义）
		{
			const r = await cmd("s4-host-legacy", `pi://${MASTER_SID}`, { Cookie: `sw_host_token=${tok4}`, ...origin });
			assert.equal(r.status, 200, "S4 旧本体 cookie 仍 200");
		}
		// gui-off 后带派生 cookie → 403 + 附清除 cookie（机会式清除；HttpOnly 前端无法自清）
		writeFileSync(cfg4, JSON.stringify({ gui: { autoStart: false } }), "utf8");
		{
			const r = await cmd("s4-gui-off", `pi://${OTHER_SID}`, { Cookie: `${GUI_COOKIE_NAME}=${gui4}`, ...origin });
			assert.equal(r.status, 403, "S4 gui-off + 派生 cookie → 403");
			assert.ok(r.setCookie.includes(`${GUI_COOKIE_NAME}=;`), `S4 附清除 cookie（实际 ${r.setCookie}）`);
			assert.ok(r.setCookie.includes("Max-Age=0"), "S4 清除 cookie Max-Age=0");
		}
		// gui-off 但仅旧本体 cookie（无派生 cookie）→ 走旧语义（非 master 目标仍 200，不误清）
		{
			const r = await cmd("s4-host-off", `pi://${OTHER_SID}`, { Cookie: `sw_host_token=${tok4}`, ...origin });
			assert.equal(r.status, 200, "S4 gui-off 无派生 cookie 不误伤旧语义");
			assert.ok(!r.setCookie.includes(GUI_COOKIE_NAME), "S4 无派生 cookie 不附清除头");
		}
	} finally {
		await h4.close();
		rmSync(D4, { recursive: true, force: true });
	}
}

// ── S3：HTTP 层对抗矩阵（Host/源/OTT 并发/方法/体积/denied 审计）────────
{
	const D3 = mkdtempSync(join(tmpdir(), "gui-master-unlock-adv-"));
	const sessionsDir3 = join(D3, "sessions");
	writeSessionFile(sessionsDir3, MASTER_SID);
	writeSessionFile(sessionsDir3, OTHER_SID);
	const timersDir3 = join(D3, "timers");
	touchSessionHeartbeat(timersDir3, MASTER_SID);
	const cfg3 = join(D3, "config.json");
	writeFileSync(cfg3, JSON.stringify({ gui: { autoStart: true } }), "utf8");
	const h3 = await createRuntimeHostServer({
		hostPath: join(D3, "host.json"),
		stateDir: join(D3, "state"),
		journalPath: join(D3, "events.jsonl"),
		timersDir: timersDir3,
		mailboxDir: join(D3, "mailbox"),
		sessionsDir: sessionsDir3,
		configPath: cfg3,
		lockWaitMs: 1000,
	});
	try {
		const port3 = h3.info.port;
		const tok3 = h3.info.token!;
		const sm3 = (key: string) => JSON.stringify({
			frame: "command", type: "session.message", to: `pi://${MASTER_SID}`, commandKey: key,
			issuedAt: new Date().toISOString(), payload: { text: "adv-hello" },
		});
		// 可覆盖 Host 头的原始 HTTP 请求（fetch 禁止 Host，由此走 M1 白名单各分支）
		const rawReq = (method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; text: string; headers: Record<string, string | undefined> }> =>
			new Promise((resolveP, rejectP) => {
				// agent:false：每请求独立连接（401/413 destroy 路径会污染池化 socket，长连接复用下 RST 时序不稳定）
				const req = httpRequest({ hostname: "127.0.0.1", port: port3, method, path, headers, agent: false }, (res) => {
					const chunks: Buffer[] = [];
					let done = false;
					const finish = (): void => {
						if (done) return;
						done = true;
						resolveP({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8"), headers: res.headers as Record<string, string | undefined> });
					};
					res.on("data", (c: Buffer) => chunks.push(c));
					res.on("end", finish);
					// 服务端 destroy 路径（401/413）可能在响应后 RST 复用连接：以已收状态为准，不崩
					res.on("error", finish);
				});
				req.on("error", rejectP);
				if (body !== undefined) req.write(body);
				req.end();
			});
		const ck3 = `sw_host_token=${tok3}`;
		const cmdHeaders = (extra: Record<string, string> = {}): Record<string, string> =>
			({ "content-type": "application/json", Host: `127.0.0.1:${port3}`, ...extra });

		// Host 混淆矩阵（/v1/commands，cookie 有效也 403）
		for (const [name, host] of [
			["evil", "evil-localhost.com"],
			["127.0.0.2", `127.0.0.2:${port3}`],
			["zero", `0.0.0.0:${port3}`],
			["trailing-dot", "localhost."],
		] as const) {
			const r = await rawReq("POST", "/v1/commands", cmdHeaders({ Host: host, Cookie: ck3 }), sm3(`s3-host-${name}`));
			assert.equal(r.status, 403, `S3 Host 混淆 ${name} → 403`);
		}
		// 大小写 Host → 200（归一接受）
		{
			const r = await rawReq("POST", "/v1/commands", cmdHeaders({ Host: `LOCALHOST:${port3}`, Cookie: ck3 }), sm3("s3-host-upper"));
			assert.equal(r.status, 200, "S3 大小写 Host → 200");
		}
		// Host 缺失（原始 socket、无 Host 行，HTTP/1.0 绕过协议层 Host 强制）→ 403
		{
			const st: number = await new Promise((resolveP) => {
				const sock = netConnect(port3, "127.0.0.1", () => {
					sock.write(`POST /v1/commands HTTP/1.0\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(sm3("s3-nohost"))}\r\nCookie: ${ck3}\r\nConnection: close\r\n\r\n${sm3("s3-nohost")}`);
				});
				let buf = "";
				sock.on("data", (c: Buffer) => { buf += c.toString("utf8"); });
				sock.on("close", () => resolveP(Number((/^HTTP\/1\.1 (\d+)/.exec(buf) ?? [])[1] ?? 0)));
				sock.on("error", () => resolveP(0));
			});
			assert.equal(st, 403, "S3 Host 缺失 → 403");
		}
		// Origin 端口≠daemon → 403；Referer 单独坏源 → 403
		{
			const r1 = await rawReq("POST", "/v1/commands", cmdHeaders({ Cookie: ck3, Origin: "http://127.0.0.1:9999" }), sm3("s3-origin-port"));
			assert.equal(r1.status, 403, "S3 Origin 端口错 → 403");
			const r2 = await rawReq("POST", "/v1/commands", cmdHeaders({ Cookie: ck3, Referer: "https://evil.example/x" }), sm3("s3-referer"));
			assert.equal(r2.status, 403, "S3 Referer 单独坏源 → 403");
		}
		// Origin:null / file:// → 403
		{
			const r1 = await rawReq("POST", "/v1/commands", cmdHeaders({ Cookie: ck3, Origin: "null" }), sm3("s3-null"));
			assert.equal(r1.status, 403, "S3 Origin:null → 403");
			const r2 = await rawReq("POST", "/v1/commands", cmdHeaders({ Cookie: ck3, Origin: "file:///x" }), sm3("s3-file"));
			assert.equal(r2.status, 403, "S3 file:// Origin → 403");
		}
		// 无 Origin + 有效 cookie → 显式 accepted（预期行为固化）
		{
			const r = await rawReq("POST", "/v1/commands", cmdHeaders({ Cookie: ck3 }), sm3("s3-noorigin-ok"));
			assert.equal(r.status, 200, "S3 无 Origin+cookie 显式 accepted");
		}
		// header+cookie 双 present：均有效 → 200（受信判定以 cookie 为准，见 U2）；
		// header 坏+cookie 好 → 401（authorize 门 header 优先的既有语义，非本轮范围，固化防误改）
		{
			const r = await rawReq("POST", "/v1/commands", cmdHeaders({ Cookie: ck3, "x-command-token": tok3 }), sm3("s3-dual"));
			assert.equal(r.status, 200, "S3 双 present 均有效 → 200");
			const rBad = await rawReq("POST", "/v1/commands", cmdHeaders({ Cookie: ck3, "x-command-token": "wrong" }), sm3("s3-dual-bad"));
			assert.equal(rBad.status, 401, "S3 坏 header+好 cookie → 401（auth 门既有语义）");
		}
		// bootstrap 方法错误 → 405
		{
			const r1 = await rawReq("GET", "/v1/bootstrap", {});
			assert.equal(r1.status, 405, "S3 GET /v1/bootstrap → 405");
			const r2 = await rawReq("POST", "/v1/bootstrap/exchange?ott=x", {});
			assert.equal(r2.status, 405, "S3 POST exchange → 405");
		}
		// bootstrap 超大 body → 413（1KB 真实上限）
		{
			const r = await rawReq("POST", "/v1/bootstrap", { Host: `127.0.0.1:${port3}`, "x-command-token": tok3 }, "y".repeat(2048));
			assert.equal(r.status, 413, "S3 bootstrap 超大 body → 413");
		}
		// M1：bootstrap 面 Host 白名单（evil Host 签发/exchange 均 403；exchange 失败不核销 OTT）
		{
			const b = await rawReq("POST", "/v1/bootstrap", { Host: "evil-localhost.com", "x-command-token": tok3 }, "{}");
			assert.equal(b.status, 403, "S3 bootstrap evil Host → 403");
			const mint = await rawReq("POST", "/v1/bootstrap", { Host: `127.0.0.1:${port3}`, "x-command-token": tok3 }, "{}");
			assert.equal(mint.status, 200, "S3 bootstrap 正常签发 200");
			const ott = (JSON.parse(mint.text) as { ott: string }).ott;
			const evilEx = await rawReq("GET", `/v1/bootstrap/exchange?ott=${ott}`, { Host: "evil-localhost.com" });
			assert.equal(evilEx.status, 403, "S3 exchange evil Host → 403");
			const goodEx = await rawReq("GET", `/v1/bootstrap/exchange?ott=${ott}`, { Host: `127.0.0.1:${port3}` });
			assert.equal(goodEx.status, 302, "S3 Host 失败不核销 OTT（同 OTT 好 Host 可换）");
		}
		// OTT 并发双换：同一 OTT 两个请求，只允许一个成功
		{
			const mint = await rawReq("POST", "/v1/bootstrap", { Host: `127.0.0.1:${port3}`, "x-command-token": tok3 }, "{}");
			const ott = (JSON.parse(mint.text) as { ott: string }).ott;
			const [a, b] = await Promise.all([
				rawReq("GET", `/v1/bootstrap/exchange?ott=${ott}`, { Host: `127.0.0.1:${port3}` }),
				rawReq("GET", `/v1/bootstrap/exchange?ott=${ott}`, { Host: `127.0.0.1:${port3}` }),
			]);
			assert.deepEqual([a.status, b.status].sort(), [302, 403], "S3 OTT 并发双换一胜一负");
		}
		// 未知 OTT → 403；mint 后 gui-off 再 exchange → 403；R2② re-enable 后同 OTT 仍可换（锁定 gui-off 不核销 OTT）
		{
			const r = await rawReq("GET", `/v1/bootstrap/exchange?ott=${"f".repeat(32)}`, { Host: `127.0.0.1:${port3}` });
			assert.equal(r.status, 403, "S3 未知 OTT → 403");
			const mint = await rawReq("POST", "/v1/bootstrap", { Host: `127.0.0.1:${port3}`, "x-command-token": tok3 }, "{}");
			const ott = (JSON.parse(mint.text) as { ott: string }).ott;
			writeFileSync(cfg3, JSON.stringify({ gui: { autoStart: false } }), "utf8");
			const off = await rawReq("GET", `/v1/bootstrap/exchange?ott=${ott}`, { Host: `127.0.0.1:${port3}` });
			assert.equal(off.status, 403, "S3 mint 后 gui-off 再 exchange → 403");
			writeFileSync(cfg3, JSON.stringify({ gui: { autoStart: true } }), "utf8");
			const re = await rawReq("GET", `/v1/bootstrap/exchange?ott=${ott}`, { Host: `127.0.0.1:${port3}` });
			assert.equal(re.status, 302, "R2 gui-off 不核销 OTT（re-enable 后同 OTT 仍可换）");
		}
		// R2③：bootstrap exchange Host 缺失 → 403，且不核销 OTT（同 OTT 好 Host 随后可换）
		{
			const mint = await rawReq("POST", "/v1/bootstrap", { Host: `127.0.0.1:${port3}`, "x-command-token": tok3 }, "{}");
			const ott = (JSON.parse(mint.text) as { ott: string }).ott;
			const st: number = await new Promise((resolveP) => {
				const sock = netConnect(port3, "127.0.0.1", () => {
					sock.write(`GET /v1/bootstrap/exchange?ott=${ott} HTTP/1.0\r\nConnection: close\r\n\r\n`);
				});
				let buf = "";
				sock.on("data", (c: Buffer) => { buf += c.toString("utf8"); });
				sock.on("close", () => resolveP(Number((/^HTTP\/1\.1 (\d+)/.exec(buf) ?? [])[1] ?? 0)));
				sock.on("error", () => resolveP(0));
			});
			assert.equal(st, 403, "R2 exchange Host 缺失 → 403");
			const good = await rawReq("GET", `/v1/bootstrap/exchange?ott=${ott}`, { Host: `127.0.0.1:${port3}` });
			assert.equal(good.status, 302, "R2 Host 缺失不核销 OTT（同 OTT 好 Host 可换）");
		}
		// S3 被拒 denied 审计行断言（Host/源三类；上行 S3 拒绝 key 均在列）
		{
			const f = join(D3, "state", "master-injections.jsonl");
			assert.ok(existsSync(f), "S3 审计文件落盘");
			const lines = readFileSync(f, "utf8").split("\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
			const byKey = new Map(lines.map((r) => [r.commandKey, r] as const));
			for (const k of ["s3-host-evil", "s3-host-127.0.0.2", "s3-host-zero", "s3-host-trailing-dot", "s3-origin-port", "s3-referer", "s3-null", "s3-file"]) {
				assert.equal(byKey.get(k)?.result, "denied", `S3 ${k} 记 denied`);
			}
			assert.equal(byKey.get("s3-noorigin-ok")?.result, "accepted", "S3 无 Origin accepted 行");
			for (const r of lines) {
				const s = JSON.stringify(r);
				assert.ok(!s.includes("adv-hello") && !s.includes(tok3), "S3 审计无正文/密钥");
			}
		}
	} finally {
		await h3.close();
		rmSync(D3, { recursive: true, force: true });
	}
}

// 还原 env 注册表（本文件 attach 的 MASTER_SID 不污染其它测试进程——进程级 env 已隔离）
rmSync(attachmentPathFor(masterAddress()), { force: true });
console.log("gui-master-unlock tests: all passed");
