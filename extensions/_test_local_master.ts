/**
 * _test_local_master.ts — 二级 master v1（per-repo local master，0920 L2 计划）测试
 *
 * 覆盖（隔离 PI_RUNTIME_DIR；fake pi + 注入 spawn，不真开终端；git 临时仓真实落盘）：
 *
 * 单测（计划 §5 清单 10 项）：
 *   U1  scope 键：git toplevel basename / 无 git 回退 cwd basename / worktree -worktree 后缀 /
 *       C:\a 与 C:a 归一 / 结果无 / 可被 parseObjectAddress 解析
 *       + L4 返修：M1 origin 反例（local-dir + unrelated-remote → 键仍 local-dir）/ 同 origin 不同目录分键
 *       M2 带空格 basename 可逆编码（parseObjectAddress + attachment 可读回，a b≠a_b）
 *       M3 normalizeDriveColon 精确输出 + drive-relative/absolute git 分支等价
 *   U2  静默 genesis：无 owner → attach（agent=scope, gen=1, detail=toplevel 全路径）；
 *       已有 owner（任何 generation）→ attachment 逐字节不变；identity="unknown" → no-op 无异常；
 *       bad-session/owner-active 静默吞掉
 *   U3  genesis 原子性（真实并发两子进程）：一个 gen-1 胜出，另一个 owner-active；胜者 detail 落 cwd
 *   U4  preInject recipient 参数化：不传 → 与现状逐字节一致（回归，审计无 recipient 字段）；
 *       传 scope + 本会话为 scope owner → inject；非 scope owner → suppress 且 extra 含 recipient；
 *       dispatcherWake 优先级高于 owner 判定
 *   U5  scope 谓词（S7）：wake/命令类 → 处理；REPORT 形态 → skip 且无 claim/无审计
 *   U6  registerScopeWakeLoop：cutover off → 空转（Q4）；无信 → 不 spawn；
 *       wake 信 → spawn 且 cwd = scope 仓 toplevel（读回 attachment.detail）
 *   U7  scope 派发门（S5，纯函数 gate 以 scope attachment 注入）：scope owner 可派（via owner）；
 *       主会话恒可（Q3，via main）；subagent/tab/普通会话拒绝
 *   U8  脑裂回归：同仓第二会话 session_start 后，在位者 attachment 逐字节不变、第二会话不消费
 *   U9  succession 零改动断言：scope-only owner 的 agent_end 不触碰
 *       master-succession.json / master-auto.json / master-transfers/ / 全局 master-attention.json
 *   U10 既有全量测试回归（shell 侧跑 npm run test:* 全绿）
 *
 * E2E（计划 §5 可打勾验收 5 项）：
 *   E1  仓 A 启动 pi-1（静默成 scope owner），再启 pi-2（同仓）：pi-2 不 attach、不唤醒，pi-1 无感
 *   E2  主会话给仓 A 的 scope 发 wake 信 → pi-1 唤醒本仓 tab（cwd 正确、信 acked、wake-state 落盘）
 *   E3  主会话跨仓代派（master-dispatch gate，Q3）：isMain → via main 恒放行
 *   E4  全局 cutover off → scope 消费端空转（Q4）
 *   E5  同会话双身份（全局 owner + scope owner）：agent_end 后 master-attention.json 与
 *       local-master-attention/<scope>.json 各自独立写入，不共享 marker 文件
 *
 * 运行：npm run test:local-master
 */

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "runtime-local-master-env-"));
delete process.env.PI_SUBAGENT; // 测试进程非子 agent（继承值会误触 isSubagent 门）
delete process.env.PI_TAB_RUN_ID; // 测试进程非标签页
const RUNTIME = process.env.PI_RUNTIME_DIR!;
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

import { parseObjectAddress } from "./runtime/address.ts";
import {
	attachMaster,
	detachMaster,
	readAttachment,
	readCutover,
	setCutover,
	type MasterAttachment,
} from "./runtime/registry.ts";
import { deliverCommand, deliverLetter, mailboxDirFor, newMessageId, type Letter } from "./runtime/mailbox.ts";
import { masterAddress } from "./runtime/address.ts";
import { preInject } from "./injection-gate.ts";
import {
	localMasterAddress,
	localMasterScope,
	silentScopeGenesis,
	isScopeWakeLetter,
	evaluateScopeWake,
	confirmScopeWakeSpawn,
	readScopeAttention,
	buildScopeWakePrompt,
	encodeScopeSegment,
	decodeScopeSegment,
} from "./runtime/scope.ts";
import { readWakeState } from "./runtime/wake.ts";
import { gitToplevel, repoName, normalizeDriveColon } from "./launch.ts";
import { registerScopeWakeLoop } from "./mailbox-consumer.ts";
import { masterDispatchGate } from "./master-tools.ts";
import { registerSessionHooks } from "./session-hooks.ts";
import type { CommandFrame, MessageFrame } from "./runtime/protocol.ts";
import type { ObjectAddress } from "./runtime/address.ts";
import type { ScopeWakeDecision } from "./runtime/scope.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const readBytes = (p: string): string => (existsSync(p) ? readFileSync(p, "utf8") : "");
const readJson = (p: string): unknown | null => {
	try {
		return JSON.parse(readFileSync(p, "utf8"));
	} catch {
		return null;
	}
};

// attachment 文件路径（与 registry.attachmentPathFor 同 sanitize 规则）
const attFileOf = (addr: ObjectAddress): string =>
	join(RUNTIME, "registry", "attachments", `${addr.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);

// ── 工具：临时仓 / fake pi ─────────────────────────────────────────

let tmpRoot = mkdtempSync(join(tmpdir(), "local-master-tmp-"));
/** 建一个临时 git 仓（无 commit；rev-parse --show-toplevel 可用），返回目录（= toplevel）。 */
function mkGitRepo(name: string): { cwd: string; toplevel: string } {
	const dir = join(tmpRoot, name);
	mkdirSync(join(dir, "sub"), { recursive: true });
	execFileSync("git", ["init", "-q", dir], { stdio: ["ignore", "ignore", "ignore"] });
	return { cwd: dir, toplevel: gitToplevel(dir) ?? dir };
}
/** 建一个非 git 普通目录。 */
function mkPlainDir(name: string): string {
	const dir = join(tmpRoot, name);
	mkdirSync(dir, { recursive: true });
	return dir;
}

interface FakePi {
	on: (event: string, cb: (event: unknown, ctx?: { sessionManager?: { sessionId?: string } }) => void) => void;
	handlers: Record<string, Array<(event: unknown, ctx?: { sessionManager?: { sessionId?: string } }) => void>>;
	start: (sessionId: string) => void;
}
function fakePi(): FakePi {
	const handlers: FakePi["handlers"] = {};
	const pi = {
		on: (event: string, cb: FakePi["handlers"][number]) => {
			(handlers[event] ??= []).push(cb);
		},
	};
	return {
		...pi,
		handlers,
		start: (sessionId: string) => {
			for (const cb of handlers["session_start"] ?? []) cb({}, { sessionManager: { sessionId } });
		},
	};
}

function wakeCommand(to: ObjectAddress, key: string, payload?: Record<string, unknown>): CommandFrame {
	return {
		frame: "command",
		type: "agent.wake",
		to,
		issuedBy: masterAddress(),
		commandKey: key,
		issuedAt: new Date().toISOString(),
		...(payload ? { payload } : {}),
	};
}

function reportMessage(to: ObjectAddress, tabRunId: string): MessageFrame {
	return {
		frame: "message",
		id: newMessageId(),
		kind: "REPORT",
		from: masterAddress(),
		to,
		subject: `run://tab/${tabRunId}`,
		requiresAck: true,
		sentAt: new Date().toISOString(),
		body: { summary: `tab ${tabRunId} done`, details: { tabRunId, status: "completed" } },
	};
}

// ════════════════════════════════════════════════════════════════════
// U1 — scope 键（S1）
// ════════════════════════════════════════════════════════════════════
{
	// git toplevel basename（子目录 → toplevel，不是子目录名）
	const repoA = mkGitRepo("repoA");
	assert.equal(localMasterScope(repoA.cwd), "repoA");
	assert.equal(localMasterScope(join(repoA.cwd, "sub")), "repoA", "子目录归一到 toplevel basename");

	// 无 git 回退 cwd basename
	const plain = mkPlainDir("plainCwd");
	assert.equal(localMasterScope(plain), "plainCwd");

	// worktree 加 -worktree 后缀（launch-tabs 标题惯例），与非 worktree 同名分键
	const wt = join(mkPlainDir("base"), "worktrees", "proj");
	mkdirSync(wt, { recursive: true });
	const notWt = join(mkPlainDir("base2"), "proj");
	mkdirSync(notWt, { recursive: true });
	assert.equal(localMasterScope(wt), "proj-worktree");
	assert.equal(localMasterScope(notWt), "proj");
	assert.notEqual(localMasterScope(wt), localMasterScope(notWt), "worktree 与非 worktree 同名分键");

	// C:\a 与 C:a 归一到同一 basename（不用原始路径 → 无 sanitize 碰撞）
	const s1 = localMasterScope("C:\\a");
	const s2 = localMasterScope("C:a");
	assert.equal(s1, s2, "C:\\a 与 C:a 归一（basename 键）");
	assert.equal(s1, "a");

	// 结果无 / 且可被 parseObjectAddress 解析（agent 单段命名空间）
	for (const scope of ["repoA", "plainCwd", s1, localMasterScope(REPO_ROOT)]) {
		assert.ok(!scope.includes("/"), `scope 无 /: ${scope}`);
		const parsed = parseObjectAddress(localMasterAddress(scope));
		assert.ok(parsed, `可解析: ${localMasterAddress(scope)}`);
		assert.equal(parsed?.scheme, "agent");
		assert.equal(parsed && parsed.scheme === "agent" ? parsed.value : null, `master_local_${scope}`);
	}
	assert.ok(repoName(REPO_ROOT).length > 0);

	// ── M1：scope 不用 origin remote 名（toplevel basename 契约反例）──
	// 目录 local-dir + origin=unrelated-remote.git → scope 必须是 local-dir（旧实现会返回 unrelated-remote）
	const repoM1a = mkGitRepo("local-dir");
	execFileSync("git", ["-C", repoM1a.cwd, "remote", "add", "origin", "https://example.invalid/unrelated-remote.git"], {
		stdio: ["ignore", "ignore", "ignore"],
	});
	assert.equal(localMasterScope(repoM1a.cwd), "local-dir", "M1: scope = toplevel basename，非 origin 名");
	// 同 origin 不同目录 → 不得共享 scope 键
	const repoM1b = mkGitRepo("other-dir");
	execFileSync("git", ["-C", repoM1b.cwd, "remote", "add", "origin", "https://example.invalid/unrelated-remote.git"], {
		stdio: ["ignore", "ignore", "ignore"],
	});
	assert.equal(localMasterScope(repoM1b.cwd), "other-dir");
	assert.notEqual(localMasterScope(repoM1a.cwd), localMasterScope(repoM1b.cwd), "M1: 同 origin 不同目录分键");

	// ── M2：带空格/折叠字符 basename 可逆无歧义单段编码 ──
	const spDir = mkPlainDir("my repo");
	const spScope = localMasterScope(spDir);
	assert.notEqual(spScope, "my repo", "M2: 含空格不裸进键");
	assert.equal(decodeScopeSegment(spScope), "my repo", "M2: 编码可逆");
	assert.ok(!/[\s]/.test(spScope) && !spScope.includes("/"), "M2: 编码后无空白/无 /");
	const spParsed = parseObjectAddress(localMasterAddress(spScope));
	assert.ok(spParsed && spParsed.scheme === "agent", `M2: 编码后 parseObjectAddress 可解析: ${localMasterAddress(spScope)}`);
	// a b 与 a_b 不得碰撞（不得裸空格→下划线）
	assert.notEqual(localMasterScope(join(tmpRoot, "a b")), localMasterScope(join(tmpRoot, "a_b")), "M2: a b ≠ a_b");
	assert.notEqual(encodeScopeSegment("a b"), encodeScopeSegment("a_b"));
	// e39 保留命名空间的普通名也编码（保持注入性）且可逆
	const e39Dir = mkPlainDir("e39raw");
	assert.notEqual(localMasterScope(e39Dir), "e39raw", "M2: e39 前缀普通名也编码");
	assert.equal(decodeScopeSegment(localMasterScope(e39Dir)), "e39raw", "M2: e39 编码可逆");
	// 安全名 passthrough 分支（可读、decode 恒等）
	assert.equal(encodeScopeSegment("plainCwd"), "plainCwd");
	assert.equal(decodeScopeSegment("plainCwd"), "plainCwd");
	// attachment key 可读回：带空格目录静默 genesis 后，readAttachment(编码地址) 非空
	const rSp = silentScopeGenesis("sess-m2-sp", spDir);
	assert.equal(rSp.outcome, "attached", "M2: 带空格目录可正常 genesis");
	const attSp = readAttachment(localMasterAddress(spScope));
	assert.ok(attSp && attSp.sessionId === "sess-m2-sp", "M2: readAttachment 按编码地址读回 owner");
	assert.ok(existsSync(attFileOf(localMasterAddress(spScope))), "M2: attachment 落盘于编码 key 文件名");

	// ── M3：驱动器相对归一（C:a → C:/a）精确输出 + git 分支等价 ──
	assert.equal(normalizeDriveColon("C:a"), "C:/a", "M3: C:a → C:/a（旧实现会产出 $1:/a）");
	assert.equal(normalizeDriveColon("d:xyz/ab"), "d:/xyz/ab", "M3: 小写盘符");
	assert.equal(normalizeDriveColon("C:"), "C:/", "M3: 盘符根");
	assert.equal(normalizeDriveColon("C:\\a"), "C:\\a", "M3: 已归一不变");
	assert.equal(normalizeDriveColon("C:/a"), "C:/a", "M3: 斜杠形式不变");
	assert.equal(normalizeDriveColon("plain/x"), "plain/x", "M3: 非盘符路径不变");
	// git 分支等价（M3）：`C:a` 风格输入与 `C:\a` 指向同一目录（产品语义：驱动器根绝对路径，
	// 驱动器冒号归一后两者同串 → 同一 git 调用）；未归一的 drive-relative 形式 git 解析不到仓。
	if (process.platform === "win32") {
		const repoM3 = mkGitRepo("driveEq");
		const abs = repoM3.cwd; // C:\Users\...\driveEq
		const rel = abs.replace(/^([A-Za-z]):[\\/]/, "$1:"); // C:Users\...（C:a 风格，同一目录）
		assert.match(rel, /^[A-Za-z]:[^\\/]/, "M3: 构造出 C:a 风格变体");
		assert.equal(normalizeDriveColon(rel), abs.replace(/^([A-Za-z]):\\/, "$1:/"), "M3: 归一输出 = 斜杠形式同目录");
		assert.equal(gitToplevel(rel), gitToplevel(abs), "M3: gitToplevel 调用前归一，两形式解析同一仓");
		assert.equal(localMasterScope(rel), localMasterScope(abs), "M3: 两输入经 scope 路径（git 调用前归一）同键");
		assert.equal(localMasterScope(rel), "driveEq", "M3: git 分支下仍取 toplevel basename");
	}
}

// ════════════════════════════════════════════════════════════════════
// U2 — 静默 genesis（S2）
// ════════════════════════════════════════════════════════════════════
const repoG = mkGitRepo("repoGenesis");
const scopeG = localMasterScope(repoG.cwd);
const addrG = localMasterAddress(scopeG);
{
	// 无 owner → attach 成功，agent=scope、gen=1、detail = toplevel 完整路径（主会话拍板）
	const r1 = silentScopeGenesis("sess-g1", repoG.cwd);
	assert.equal(r1.outcome, "attached");
	assert.equal(r1.outcome === "attached" ? r1.scope : null, scopeG);
	const att1 = readAttachment(addrG)!;
	assert.equal(att1.agentAddress, addrG);
	assert.equal(att1.sessionId, "sess-g1");
	assert.equal(att1.generation, 1);
	assert.equal(att1.detail, gitToplevel(repoG.cwd), "toplevel 完整路径落 detail");

	// 已有 owner（gen 1）→ 完全不动（逐字节）
	const bytes1 = readBytes(attFileOf(addrG));
	const r2 = silentScopeGenesis("sess-g2", repoG.cwd);
	assert.equal(r2.outcome, "skipped");
	assert.equal(r2.outcome === "skipped" ? r2.reason : null, "owner-active");
	assert.equal(readBytes(attFileOf(addrG)), bytes1, "在位者 attachment 逐字节不变");

	// 已有 owner（gen 2，任何 generation 一律不动）
	const bump = attachMaster({ sessionId: "sess-g3", agent: addrG, forceStale: true, staleAfterMs: -1 });
	assert.equal(bump.ok, true);
	assert.equal(bump.ok && bump.attachment.generation, 2);
	const r3 = silentScopeGenesis("sess-g4", repoG.cwd);
	assert.equal(r3.outcome, "skipped");
	assert.equal(r3.outcome === "skipped" ? r3.reason : null, "owner-active");
	assert.equal(readAttachment(addrG)!.sessionId, "sess-g3");

	// identity="unknown" / 空 → no-op 无异常（M1 哨兵）
	assert.doesNotThrow(() => assert.equal(silentScopeGenesis("unknown", repoG.cwd).outcome, "skipped"));
	assert.doesNotThrow(() => assert.equal(silentScopeGenesis("", repoG.cwd).outcome, "skipped"));
	const attUnknown = readAttachment(addrG)!;
	assert.equal(attUnknown.sessionId, "sess-g3", "unknown 身份不触碰 attachment");

	// 无 git 回退：detail = cwd 本身
	const plain2 = mkPlainDir("plainGenesis");
	const rPlain = silentScopeGenesis("sess-p1", plain2);
	assert.equal(rPlain.outcome, "attached");
	const attP = readAttachment(localMasterAddress(localMasterScope(plain2)))!;
	assert.equal(attP.detail, plain2, "无 git 时 detail 回退 cwd");
}

// ════════════════════════════════════════════════════════════════════
// U3 — genesis 原子性（真实并发两子进程，wx 单赢）
// ════════════════════════════════════════════════════════════════════
{
	const repoC = mkGitRepo("repoConcurrent");
	const scopeC = localMasterScope(repoC.cwd);
	const scopeUrl = pathToFileURL(join(REPO_ROOT, "extensions", "runtime", "scope.ts")).href;
	const helper = join(tmpRoot, "_scope_genesis_helper.mts");
	writeFileSync(
		helper,
		`import { silentScopeGenesis } from ${JSON.stringify(scopeUrl)};\n` +
		`const r = silentScopeGenesis(process.argv[2], process.argv[3]);\n` +
		`process.stdout.write(r.outcome);\n`,
		"utf8",
	);
	const env = { ...process.env, PI_RUNTIME_DIR: RUNTIME };
	const child = (sid: string): Promise<string> =>
		new Promise((resolve) => {
			const p = spawn(process.execPath, ["--experimental-strip-types", helper, sid, repoC.cwd], {
				env,
				stdio: ["ignore", "pipe", "ignore"],
			});
			let out = "";
			p.stdout!.on("data", (d: Buffer) => (out += d.toString()));
			p.on("close", () => resolve(out.trim()));
		});
	// 并发启动（两个进程同时 genesis；结果与顺序无关）
	const [a, b] = await Promise.all([child("sess-c1"), child("sess-c2")]);
	const results = [a, b].sort();
	assert.deepEqual(results, ["attached", "skipped"], `并发单赢（got: ${a}/${b}）`);
	const att = readAttachment(localMasterAddress(scopeC))!;
	assert.equal(att.generation, 1, "胜者 gen-1");
	assert.equal(att.sessionId === "sess-c1" ? a : b, "attached", "输家 owner-active");
	assert.equal(att.detail, gitToplevel(repoC.cwd), "胜者 detail 落 cwd（toplevel）");
}

// ════════════════════════════════════════════════════════════════════
// U4 — preInject recipient 参数化（S6）
// ════════════════════════════════════════════════════════════════════
const suppressionsPath = join(RUNTIME, "suppressions.jsonl");
const lastSuppression = (): Record<string, unknown> | null => {
	const raw = readBytes(suppressionsPath).trim();
	if (!raw) return null;
	const lines = raw.split("\n").filter(Boolean);
	try {
		return JSON.parse(lines[lines.length - 1]);
	} catch {
		return null;
	}
};
{
	// 回归 0：未切换（无 cutover）→ legacy inject:true，行为与现状一致
	assert.equal(readCutover(), null, "前置：cutover 未设（保证后续回归断言干净）");
	const vLegacy = preInject({ key: "k-legacy", sessionId: "whoever", path: "mailbox-consumer" });
	assert.equal(vLegacy.inject, true);
	assert.equal(vLegacy.inject && vLegacy.holder, "mailbox-consumer:whoever", "holder 形状与现状一致");

	// 回归 1：cutover on + 全局 owner：不传 recipient → 行为逐字节一致（审计记录无 recipient 字段）
	setCutover(true, "u4-test");
	attachMaster({ sessionId: "sess-global" });
	const vOwner = preInject({ key: "k-owner", sessionId: "sess-global", path: "mailbox-consumer" });
	assert.equal(vOwner.inject, true, "全局 owner 注入（现状）");
	const vStranger = preInject({ key: "k-stranger", sessionId: "stranger", path: "mailbox-consumer" });
	assert.deepEqual(vStranger, { inject: false, reason: "suppressed-not-owner" });
	const rec = lastSuppression()!;
	assert.equal(rec.selfSession, "stranger");
	assert.ok(!("recipient" in rec), "全局路径审计形状不变（无 recipient 字段）");

	// scope：本会话是 scope owner → inject（按 scope 归属判，不读全局 attachment）
	const g2 = silentScopeGenesis("sess-s1", repoG.cwd); // U2 已建 owner（sess-g3）→ 换会话需先 detach
	assert.equal(g2.outcome, "skipped");
	const det1 = detachMaster({ sessionId: "sess-g3", generation: 2, agent: addrG });
	assert.equal(det1.ok, true);
	const att1b = attachMaster({ sessionId: "sess-s1", agent: addrG, token: det1.token! });
	assert.equal(att1b.ok, true);
	const vScopeOwner = preInject({ key: "k-scope-owner", sessionId: "sess-s1", path: "mailbox-consumer", recipient: addrG });
	assert.equal(vScopeOwner.inject, true, "scope owner 按 scope 归属注入");

	// scope：非 scope owner → suppress 且 extra 含 recipient
	const vScopeStranger = preInject({ key: "k-scope-stranger", sessionId: "stranger", path: "mailbox-consumer", recipient: addrG });
	assert.deepEqual(vScopeStranger, { inject: false, reason: "suppressed-not-owner" });
	const rec2 = lastSuppression()!;
	assert.equal(rec2.recipient, addrG, "scope 侧 suppress 审计带 recipient");
	assert.equal(rec2.selfSession, "stranger");

	// dispatcherWake 优先级高于 owner 判定（run 级豁免最优先）
	const vDispatch = preInject({ key: "k-dispatcher", sessionId: "stranger", path: "legacy-eventbus", dispatcherWake: true });
	assert.equal(vDispatch.inject, true, "dispatcherWake 跳过 owner 压制");
}

// ════════════════════════════════════════════════════════════════════
// U5 — scope 谓词（S7）：wake 类处理 / REPORT skip 且无 claim 无审计
// ════════════════════════════════════════════════════════════════════
{
	const repoW = mkGitRepo("repoWake");
	const scopeW = localMasterScope(repoW.cwd);
	const addrW = localMasterAddress(scopeW);
	silentScopeGenesis("sess-w1", repoW.cwd);

	// 谓词本身
	const cmd: CommandFrame = wakeCommand(addrW, "pred-1");
	assert.equal(isScopeWakeLetter({ frame: cmd, status: "pending" }), true, "command → wake 类");
	const rep: MessageFrame = reportMessage(addrW, "tab_rep1");
	assert.equal(isScopeWakeLetter({ frame: rep, status: "pending" }), false, "REPORT 形态 → skip");
	const plain: MessageFrame = { ...rep, id: newMessageId(), subject: "task://T1" };
	assert.equal(isScopeWakeLetter({ frame: plain, status: "pending" }), true, "非 REPORT message → 放行（防御）");

	// REPORT 信进 scope 目录 → 不 claim、不 suppress 审计（只是防御性跳过）
	const supCountBefore = readBytes(suppressionsPath).trim().split("\n").filter(Boolean).length;
	deliverLetter(rep);
	const d1 = evaluateScopeWake({ sessionId: "sess-w1", scope: scopeW });
	assert.equal(d1.fire, false);
	assert.equal(d1.reason, "no-mail", "REPORT 信不算 wake 输入");
	const repDir = mailboxDirFor(addrW);
	const repFile = join(repDir, `${rep.id}.json`);
	const repLetter = JSON.parse(readFileSync(repFile, "utf8")) as { status: string };
	assert.equal(repLetter.status, "pending", "REPORT 信未被 claim");
	const supCountAfter = readBytes(suppressionsPath).trim().split("\n").filter(Boolean).length;
	assert.equal(supCountAfter, supCountBefore, "REPORT skip 不产生 suppress 审计");

	// wake 命令 → 处理（claim 全 inbox，fire + prompt）
	deliverCommand(wakeCommand(addrW, "pred-2", { note: "推进" }));
	const d2 = evaluateScopeWake({ sessionId: "sess-w1", scope: scopeW });
	assert.equal(d2.fire, true);
	assert.equal(d2.letters.length, 1);
	assert.equal(d2.letters[0].summary, "command agent.wake");
	assert.ok(d2.prompt?.includes(`仓库 ${scopeW}`));
	assert.equal(d2.repoCwd, gitToplevel(repoW.cwd));
	const cmdDir = mailboxDirFor(addrW);
	const stillPending = readdirSync(cmdDir).filter((f) => f.endsWith(".json"))
		.map((f) => JSON.parse(readFileSync(join(cmdDir, f), "utf8")) as Letter)
		.filter((l) => l.status === "pending" && isScopeWakeLetter(l));
	assert.equal(stillPending.length, 0, "wake 类信被 claim（REPORT 形态恒 pending 是 S7 设计）");

	// confirm 后 ack + wake-state 以 <scope> 命名落盘
	confirmScopeWakeSpawn(scopeW, "tab_fake_confirm", { sessionId: "sess-w1" });
	const ws = readWakeState(scopeW);
	assert.equal(ws.workstreamId, scopeW);
	assert.equal(ws.lastTabRunId, "tab_fake_confirm");
	// 非 owner → not-owner（归属判定）
	const d3 = evaluateScopeWake({ sessionId: "someone-else", scope: scopeW });
	assert.equal(d3.reason, "not-owner");
}

// ════════════════════════════════════════════════════════════════════
// U6 — registerScopeWakeLoop（S4）
// ════════════════════════════════════════════════════════════════════
{
	// (a) cutover off → 静默 genesis 仍认领 ownership（Q4 只门消费端），tick 空转
	setCutover(false, "u6-test");
	const repoOff = mkGitRepo("repoCutoverOff");
	const scopeOff = localMasterScope(repoOff.cwd);
	const spawnedOff: Array<ScopeWakeDecision & { sid: string }> = [];
	const piOff = fakePi();
	registerScopeWakeLoop(piOff, {
		cwd: repoOff.cwd,
		intervalMs: 5,
		spawn: (d, sid) => {
			spawnedOff.push({ ...d, sid: sid! });
			return "tab_off";
		},
	});
	piOff.start("sess-off");
	assert.equal(readAttachment(localMasterAddress(scopeOff))!.sessionId, "sess-off", "cutover off 也静默认领（ownership 与 cutover 分离）");
	deliverCommand(wakeCommand(localMasterAddress(scopeOff), "off-1"));
	await sleep(80);
	assert.equal(spawnedOff.length, 0, "cutover off → 消费端空转，不 spawn");

	// (a2) cutover 重开 → 同一已注册循环立刻生效（tick 每轮新鲜读 cutover）
	setCutover(true, "u6-test");
	await sleep(80);
	assert.equal(spawnedOff.length, 1, "cutover 重开 → 已注册 tick 生效");
	assert.equal(spawnedOff[0].repoCwd, gitToplevel(repoOff.cwd), "spawn cwd = scope 仓 toplevel（读回 detail）");

	// (b) 无信 → 不 spawn
	const repoQ = mkGitRepo("repoQuiet");
	const spawnedQ: string[] = [];
	const piQ = fakePi();
	registerScopeWakeLoop(piQ, {
		cwd: repoQ.cwd,
		intervalMs: 5,
		spawn: () => {
			spawnedQ.push("x");
			return "tab_q";
		},
	});
	piQ.start("sess-q");
	await sleep(80);
	assert.equal(spawnedQ.length, 0, "scope mailbox 无信 → 不 spawn");

	// (c) wake 信 → spawn 且 cwd 正确（见上 (a2) 同型断言；这里再验 letters 传递）
	const repoOn = mkGitRepo("repoOn");
	const scopeOn = localMasterScope(repoOn.cwd);
	const spawnedOn: Array<ScopeWakeDecision> = [];
	const piOn = fakePi();
	registerScopeWakeLoop(piOn, {
		cwd: repoOn.cwd,
		intervalMs: 5,
		spawn: (d, _sid) => {
			spawnedOn.push(d);
			return `tab_on_${spawnedOn.length}`;
		},
	});
	piOn.start("sess-on");
	deliverCommand(wakeCommand(localMasterAddress(scopeOn), "on-1", { note: "hi" }));
	await sleep(100);
	assert.equal(spawnedOn.length, 1, "有 wake 信 → spawn 一次（claim 屏障防重复）");
	assert.equal(spawnedOn[0].repoCwd, gitToplevel(repoOn.cwd));
	assert.equal(spawnedOn[0].letters[0].summary, "command agent.wake");
	assert.ok(buildScopeWakePrompt(scopeOn, spawnedOn[0].letters, spawnedOn[0].repoCwd).length > 0);
}

// ════════════════════════════════════════════════════════════════════
// U7 — scope 派发门（S5，纯函数 gate 以 scope attachment 注入）
// ════════════════════════════════════════════════════════════════════
{
	const repoD = mkGitRepo("repoDispatch");
	const scopeD = localMasterScope(repoD.cwd);
	const addrD = localMasterAddress(scopeD);
	silentScopeGenesis("sess-d1", repoD.cwd);
	const scopeReader = (): MasterAttachment | null => readAttachment(addrD);

	// scope owner（tab 形态）可派 → via owner
	const g1 = masterDispatchGate({ sessionId: "sess-d1", isSub: false, isTab: true, isMain: false, readAttachment: scopeReader });
	assert.deepEqual(g1, { ok: true, via: "owner", attachment: readAttachment(addrD) });

	// 主会话恒可（Q3：全局编排权延续）
	const g2 = masterDispatchGate({ sessionId: "sess-main", isSub: false, isTab: false, isMain: true, readAttachment: scopeReader });
	assert.equal(g2.ok, true);
	assert.equal(g2.ok && g2.via, "main");

	// 普通会话 / subagent / 非 owner tab 拒绝（gate 同构）
	assert.deepEqual(masterDispatchGate({ sessionId: "sess-x", isSub: false, isTab: false, isMain: false, readAttachment: scopeReader }), { ok: false, reason: "not-owner" });
	assert.deepEqual(masterDispatchGate({ sessionId: "sess-x", isSub: true, isTab: false, isMain: false, readAttachment: scopeReader }), { ok: false, reason: "subagent" });
	assert.deepEqual(masterDispatchGate({ sessionId: "sess-x", isSub: false, isTab: true, isMain: false, readAttachment: scopeReader }), { ok: false, reason: "tab-session" });
	assert.deepEqual(masterDispatchGate({ sessionId: "unknown", isSub: false, isTab: false, isMain: false, readAttachment: scopeReader }), { ok: false, reason: "unknown-session" });
}

// ════════════════════════════════════════════════════════════════════
// U8 — 脑裂回归（同仓第二会话：在位者无感、第二会话不消费）
// ════════════════════════════════════════════════════════════════════
{
	const repoB2 = mkGitRepo("repoBrainSplit");
	const scopeB2 = localMasterScope(repoB2.cwd);
	const addrB2 = localMasterAddress(scopeB2);
	const attFile = attFileOf(addrB2);

	const spawned1: Array<{ sid: string; d: ScopeWakeDecision }> = [];
	const spawned2: Array<{ sid: string; d: ScopeWakeDecision }> = [];
	const pi1 = fakePi();
	const pi2 = fakePi();
	registerScopeWakeLoop(pi1, {
		cwd: repoB2.cwd,
		intervalMs: 5,
		spawn: (d, sid) => {
			spawned1.push({ sid: sid!, d });
			return "tab_b1";
		},
	});
	registerScopeWakeLoop(pi2, {
		cwd: repoB2.cwd,
		intervalMs: 5,
		spawn: (d, sid) => {
			spawned2.push({ sid: sid!, d });
			return "tab_b2";
		},
	});
	pi1.start("sess-b1"); // 静默成 scope owner
	const bytesAfter1 = readBytes(attFile);
	pi2.start("sess-b2"); // 第二会话：无 owner 门不过 → 不 attach、不注册 tick
	assert.equal(readBytes(attFile), bytesAfter1, "第二会话 session_start 后在位者 attachment 逐字节不变");
	assert.equal(readAttachment(addrB2)!.sessionId, "sess-b1");

	deliverCommand(wakeCommand(addrB2, "bs-1"));
	await sleep(100);
	assert.equal(spawned1.length, 1, "在位者照常唤醒");
	assert.equal(spawned2.length, 0, "第二会话不消费（scope consumer 未注册）");
	assert.equal(readBytes(attFile), bytesAfter1, "全程在位者无感（无 bump、无心跳更新）");
}

// ════════════════════════════════════════════════════════════════════
// U9 — succession 零改动断言（scope-only owner 的 agent_end 不碰全局文件）
// ════════════════════════════════════════════════════════════════════
let agentEndHandler: ((event: unknown, ctx?: { sessionManager?: { sessionId?: string } }) => void) | null = null;
{
	// 本测试进程 cwd = 仓库根；agent_end 的 scope 分支读 process.cwd() → 用真实仓 scope
	const repoScope = localMasterScope(REPO_ROOT);
	const repoAddr = localMasterAddress(repoScope);
	const r = silentScopeGenesis("sess-s9", REPO_ROOT);
	assert.equal(r.outcome, "attached", "测试会话成为本仓（仓库根）scope owner");

	// 种子全局 succession 文件 + 快照（content + mtime）
	const stateDir = join(RUNTIME, "state");
	mkdirSync(join(stateDir, "master-transfers"), { recursive: true });
	const seeds: Array<[string, string]> = [
		[join(stateDir, "master-succession.json"), JSON.stringify({ version: 1, pending: null })],
		[join(stateDir, "master-auto.json"), JSON.stringify({ version: 1, lastAttemptGeneration: 0, lastAttemptAt: "1970-01-01T00:00:00.000Z", lastOutcome: "failed" })],
		[join(stateDir, "master-transfers", "tr_seed.json"), JSON.stringify({ status: "completed" })],
		[join(stateDir, "master-attention.json"), JSON.stringify([{ id: "attn_seed", at: "1970-01-01T00:00:00.000Z", kind: "auto-handoff-failed", transferId: "tr_seed", error: "seed", generation: 1, pressure: null }])],
	];
	for (const [p, c] of seeds) writeFileSync(p, c, "utf8");
	const snap = seeds.map(([p]) => ({ p, content: readBytes(p), mtime: statSync(p).mtimeMs }));

	// 给本仓 scope mailbox 投一条 wake 信（agent_end scope 分支要读它）
	deliverCommand(wakeCommand(repoAddr, "u9-1", { note: "u9" }));

	// 注册 session-hooks（fake pi），捕获 agent_end
	const piHooks = fakePi();
	registerSessionHooks(piHooks, {
		cleanups: [],
		isNotifyEnabled: () => false,
		pkgDir: REPO_ROOT,
	});
	agentEndHandler = (piHooks.handlers["agent_end"] ?? [])[0] ?? null;
	assert.ok(agentEndHandler, "agent_end handler 已注册");

	// scope-only owner（非全局 owner：全局 owner 是 U4 的 sess-global）跑 agent_end
	agentEndHandler!({}, { sessionManager: { sessionId: "sess-s9" } });

	// 断言 1：succession 三件 + 全局 attention 逐字节 + mtime 不变
	for (const s of snap) {
		assert.equal(readBytes(s.p), s.content, `未触碰: ${s.p}`);
		assert.equal(statSync(s.p).mtimeMs, s.mtime, `mtime 未变: ${s.p}`);
	}
	assert.deepEqual(
		readdirSync(join(stateDir, "master-transfers")),
		["tr_seed.json"],
		"master-transfers 无新文件",
	);

	// 断言 2：scope 分支只写 per-scope 本地 attention（与本仓 wake 信对应）
	const scopeItems = readScopeAttention(repoScope);
	assert.ok(scopeItems.some((i) => i.kind === "wake-pending" && i.letterId === "cmd:u9-1"), "scope attention 落 wake-pending");
	const globalItems = readJson(join(stateDir, "master-attention.json")) as Array<{ kind: string }>;
	assert.ok(!globalItems.some((i) => i.kind === "wake-pending"), "全局 attention 不混入 scope 事件（不共享 marker 文件）");

	// 收尾：摘掉本仓 scope owner，给 E5 让位
	const det = detachMaster({ sessionId: "sess-s9", generation: readAttachment(repoAddr)!.generation, agent: repoAddr });
	assert.equal(det.ok, true);
}

// ════════════════════════════════════════════════════════════════════
// E1 — 仓 A：pi-1 静默成 scope owner；pi-2（同仓）不 attach、不唤醒，pi-1 无感
// ════════════════════════════════════════════════════════════════════
{
	const repoA2 = mkGitRepo("repoE1");
	const scopeA2 = localMasterScope(repoA2.cwd);
	const addrA2 = localMasterAddress(scopeA2);
	const attFile = attFileOf(addrA2);

	const spawned1: number = [0];
	const spawned2: number = [0];
	const pi1 = fakePi();
	const pi2 = fakePi();
	registerScopeWakeLoop(pi1, {
		cwd: repoA2.cwd,
		intervalMs: 5,
		spawn: () => {
			spawned1[0]++;
			return "tab_e1";
		},
	});
	registerScopeWakeLoop(pi2, {
		cwd: repoA2.cwd,
		intervalMs: 5,
		spawn: () => {
			spawned2[0]++;
			return "tab_e1";
		},
	});
	pi1.start("sess-e1a");
	assert.equal(readAttachment(addrA2)!.sessionId, "sess-e1a", "pi-1 静默成 scope owner");
	const before = readBytes(attFile);
	pi2.start("sess-e2a");
	assert.equal(readBytes(attFile), before, "pi-2 不 attach（在位者 attachment 不变）");
	assert.equal(readAttachment(addrA2)!.sessionId, "sess-e1a");
	await sleep(80);
	assert.equal(spawned2[0], 0, "pi-2 不唤醒（scope consumer 未注册）");
}

// ════════════════════════════════════════════════════════════════════
// E2 — 主会话给仓 A 的 scope 发 wake 信 → pi-1 唤醒本仓 tab（cwd 正确）
// ════════════════════════════════════════════════════════════════════
{
	const repoA3 = mkGitRepo("repoE2");
	const scopeA3 = localMasterScope(repoA3.cwd);
	const addrA3 = localMasterAddress(scopeA3);
	const toplevel = gitToplevel(repoA3.cwd)!;
	const decisions: Array<ScopeWakeDecision> = [];
	const pi1 = fakePi();
	registerScopeWakeLoop(pi1, {
		cwd: repoA3.cwd,
		intervalMs: 5,
		spawn: (d, _sid) => {
			decisions.push(d);
			return `tab_e2_${decisions.length}`;
		},
	});
	pi1.start("sess-e2b");
	// 主会话（全局编排者）投递 scope wake 命令（mailbox 是影子通道，投递方不限身份）
	deliverCommand(wakeCommand(addrA3, "e2-1", { note: "主会话指令：推进本仓" }));
	await sleep(100);
	assert.equal(decisions.length, 1, "pi-1 唤醒一次");
	assert.equal(decisions[0].repoCwd, toplevel, "spawn cwd = scope 仓 toplevel（生产 spawn 闭包以 decision.repoCwd 为 cwd）");
	assert.equal(decisions[0].letters[0].summary, "command agent.wake");
	// 信被 ack + wake-state 落盘（回收链与 workstream wake 同构）
	const letterFile = join(mailboxDirFor(addrA3), readdirSync(mailboxDirFor(addrA3)).find((f) => f.endsWith(".json"))!);
	const letter = JSON.parse(readFileSync(letterFile, "utf8")) as { status: string };
	assert.equal(letter.status, "acked", "wake 信 ack（不重注不重派）");
	assert.equal(readWakeState(scopeA3).lastTabRunId, "tab_e2_1");
}

// ════════════════════════════════════════════════════════════════════
// E3 — 主会话跨仓代派（Q3）：master-dispatch gate 主会话恒可
// ════════════════════════════════════════════════════════════════════
{
	const globalReader = (): MasterAttachment | null => readAttachment(masterAddress());
	// 主会话对任意仓（含非本仓 scope）的派发门恒放行（launch 层 cwd 参数不变，零改动）
	const g = masterDispatchGate({ sessionId: "sess-e3-main", isSub: false, isTab: false, isMain: true, readAttachment: globalReader });
	assert.equal(g.ok, true);
	assert.equal(g.ok && g.via, "main");
	// 对照：非主会话非 owner 仍被拒（跨仓代派只是主会话的特权）
	const g2 = masterDispatchGate({ sessionId: "sess-e3-other", isSub: false, isTab: false, isMain: false, readAttachment: globalReader });
	assert.equal(g2.ok, false);
}

// ════════════════════════════════════════════════════════════════════
// E4 — 全局 cutover off → scope 消费端空转（Q4 继承）
// ════════════════════════════════════════════════════════════════════
{
	setCutover(false, "e4-test");
	const repoE4 = mkGitRepo("repoE4");
	const scopeE4 = localMasterScope(repoE4.cwd);
	const addrE4 = localMasterAddress(scopeE4);
	const spawned: number = [0];
	const pi = fakePi();
	registerScopeWakeLoop(pi, {
		cwd: repoE4.cwd,
		intervalMs: 5,
		spawn: () => {
			spawned[0]++;
			return "tab_e4";
		},
	});
	pi.start("sess-e4");
	assert.equal(readAttachment(addrE4)!.sessionId, "sess-e4", "cutover off 不影响 ownership 认领");
	deliverCommand(wakeCommand(addrE4, "e4-1"));
	await sleep(100);
	assert.equal(spawned[0], 0, "cutover off → 消费端空转，wake 信不触发 spawn");
	setCutover(true, "e4-test"); // 恢复（E5 需要）
}

// ════════════════════════════════════════════════════════════════════
// E5 — 同会话双身份：agent_end 后两 attention 文件各自独立写入
// ════════════════════════════════════════════════════════════════════
{
	const repoScope = localMasterScope(REPO_ROOT);
	const repoAddr = localMasterAddress(repoScope);
	const globalAddr = masterAddress();
	const stateDir = join(RUNTIME, "state");

	// 双身份会话：先成为全局 owner（token 交接自 U4 的 sess-global）
	const attG = readAttachment(globalAddr)!;
	assert.equal(attG.sessionId, "sess-global");
	const detG = detachMaster({ sessionId: "sess-global", generation: attG.generation, agent: globalAddr });
	assert.equal(detG.ok, true);
	const attG2 = attachMaster({ sessionId: "sess-dual", agent: globalAddr, token: detG.token! });
	assert.equal(attG2.ok, true, "双身份会话成为全局 owner");

	// 再成为本仓 scope owner（U9 已 detach sess-s9，凭 token 接管）
	const attS = readAttachment(repoAddr)!;
	const detS = detachMaster({ sessionId: attS.sessionId, generation: attS.generation, agent: repoAddr });
	assert.equal(detS.ok, true);
	const attS2 = attachMaster({ sessionId: "sess-dual", agent: repoAddr, token: detS.token! });
	assert.equal(attS2.ok, true, "双身份会话成为本仓 scope owner");

	// 给本仓 scope mailbox 投 wake 信（scope 分支要读它）
	deliverCommand(wakeCommand(repoAddr, "e5-1", { note: "双身份" }));

	// 快照：全局 attention（U9 种子 = 一条 auto-handoff-failed）
	const globalAttnPath = join(stateDir, "master-attention.json");
	const globalBefore = readBytes(globalAttnPath);
	const globalMtimeBefore = statSync(globalAttnPath).mtimeMs;

	// agent_end（双身份：全局分支 + scope 分支都跑；ctx 无 getContextUsage → S2/S3 跳过，与现状同）
	assert.ok(agentEndHandler, "复用 U9 注册的 agent_end handler");
	agentEndHandler!({}, { sessionManager: { sessionId: "sess-dual" } });

	// 全局 master-attention.json：不被 scope 分支写（内容 + mtime 不变）
	assert.equal(readBytes(globalAttnPath), globalBefore, "全局 attention 不被 scope 分支写");
	assert.equal(statSync(globalAttnPath).mtimeMs, globalMtimeBefore);

	// 本地 local-master-attention/<scope>.json：scope 分支写入 wake-pending（e5-1）
	const scopeItems = readScopeAttention(repoScope);
	assert.ok(scopeItems.some((i) => i.kind === "wake-pending" && i.letterId === "cmd:e5-1"), "scope attention 独立落 e5-1");
	const scopeRaw = readBytes(join(stateDir, "local-master-attention", `${repoScope}.json`));
	assert.ok(!scopeRaw.includes("auto-handoff-failed"), "scope 文件不混入全局 S3 事件（不共享 marker）");
	assert.ok(globalBefore.includes("auto-handoff-failed") && !globalBefore.includes("e5-1"), "全局文件保持全局事件（无 e5-1）");

	// 双身份 attachment 键隔离（两文件并存，数据无冲突）
	assert.equal(readAttachment(globalAddr)!.sessionId, "sess-dual");
	assert.equal(readAttachment(repoAddr)!.sessionId, "sess-dual");
}

rmSync(tmpRoot, { recursive: true, force: true });
rmSync(RUNTIME, { recursive: true, force: true });
console.log("_test_local_master: all assertions passed (U1-U9 + E1-E5)");
