/**
 * _test_local_master_transfer.ts — Local Master 自动交接专项（0924 L3-fix，L4 7 条 must-fix 回归）
 *
 * 覆盖（隔离 PI_RUNTIME_DIR；fake spawn stub；子进程仅验 subagent 门，不真开终端）：
 *   T1  local happy：prompt 含 token + 交接包 + `local: true` + 目标 local 地址；spawn cwd=仓库；
 *       旧 owner 保持；token attach → gen+1；confirm → completed（record 含 to 快照 + tokenConsumedAt）
 *   T2  prompt 形态：global（缺省）文案逐字保持；local 文案带 local:true + 地址
 *   T3  gate 非 owner：masterTransferLogic 拒绝
 *   T4  gate subagent：真实 tool execute（PI_SUBAGENT=1 子进程）拒绝
 *   T5  gate home-local：local:true + exact-home cwd fail-closed，零写（slash/tool 共用同一判定）
 *   T6  cross-scope 零写：local token→空 global / global token→空 local / global token→非空 local
 *       全部 bad-token 且目标 attachment 文件不落盘/逐字节不变
 *   T7  expired（token 过期零写）/ reused（重放 generation-mismatch，owner 不变）
 *   T8  spawn 失败：owner 保持、record failed、无窗口 marker
 *   T9  交接窗口抑制：transfer 在途 → forceStale / stale takeover 均拒（transfer-in-progress）；
 *       token attach（后继本人）不受抑制；confirm 清理窗口，接管恢复
 *   T10 明确 human cancel 越过窗口并清理 marker
 *   T11 local transfer 不触碰 global succession state（字节不变）+ 事件主体为 local 地址
 *   T12 四要素回报：发起/confirm text 含 scope + 新旧 sid12/gen + token 状态；token 值不进普通 UI text
 *   T13 global 回归：global transfer 四要素 + prompt 无 local:true（12 项 global suite 之外的逻辑层回归）
 *
 * 运行：npx tsx extensions/_test_local_master_transfer.ts
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "runtime-local-master-transfer-env-"));
delete process.env.PI_SUBAGENT; // 测试进程非子 agent
delete process.env.PI_TAB_RUN_ID;
const RUNTIME = process.env.PI_RUNTIME_DIR!;
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

import { masterAddress, type ObjectAddress } from "./runtime/address.ts";
import {
	attachMaster,
	detachMaster,
	readAttachment,
	readTransferWindow,
	takeoverMaster,
} from "./runtime/registry.ts";
import {
	buildSuccessorPrompt,
	confirmTransferAttach,
	readTransferRecord,
	transferMaster,
} from "./runtime/master-transfer.ts";
import { localMasterAddress, localMasterScope } from "./runtime/scope.ts";
import { masterTransferConfirmLogic, masterTransferLogic } from "./master-tools.ts";
import { listRuntimeEnvelopes } from "./runtime/journal.ts";

let n = 0;
const ok = (name: string) => { n++; console.log(`ok ${n} - ${name}`); };
const readBytes = (p: string): string => (existsSync(p) && !statIsDir(p) ? readFileSync(p, "utf8") : "");
const statIsDir = (p: string): boolean => { try { return statSync(p).isDirectory(); } catch { return false; } };
const readdirSafe = (p: string): string[] => { try { return readdirSync(p).sort(); } catch { return []; } };
const attFileOf = (addr: ObjectAddress): string =>
	join(RUNTIME, "registry", "attachments", `${addr.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
const handoffFileOf = (addr: ObjectAddress): string =>
	join(RUNTIME, "registry", "handoff", `${addr.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);

let tmpRoot = mkdtempSync(join(tmpdir(), "local-master-transfer-tmp-"));
const mkDir = (name: string): string => {
	const d = join(tmpRoot, name);
	mkdirSync(d, { recursive: true });
	return d;
};
// home 夹具：与仓库目录不同的精确 home（home-local 门注入 env 用）
const HOME = mkDir("homeBase");
const ENV = { home: HOME, platform: process.platform as NodeJS.Platform };
const stubSpawn = (runId: string) => (() => ({ successorRunId: runId })) as (a: unknown) => { successorRunId: string };
const localAddrOf = (cwd: string): ObjectAddress => localMasterAddress(localMasterScope(cwd));
const sid12 = (s: string) => s.slice(0, 12);

try {
// ─────────────────────────────────────────────────────────────────
// T1 local happy：prompt/order + gen+1 + record 快照
// ─────────────────────────────────────────────────────────────────
{
	const repo = mkDir("repoHappy");
	const addr = localAddrOf(repo);
	const oldSid = "session_local_old_h1";
	attachMaster({ sessionId: oldSid, agent: addr, detail: repo });
	assert.equal(readAttachment(addr)?.generation, 1);

	let captured: { prompt: string; cwd?: string; title: string } = { prompt: "", title: "" };
	const out = masterTransferLogic(oldSid, {
		reason: "local 自动交接",
		local: true,
		cwd: repo,
		env: ENV,
		spawn: (a) => { captured = { prompt: a.prompt, cwd: a.cwd, title: a.title }; return { successorRunId: "run_lh_1" }; },
	});
	assert.equal(out.isError, undefined, `T1 发起应成功：${out.text}`);
	const token = out.details?.token as string;
	const transferId = out.details?.transferId as string;

	// prompt：token + 交接包 + local:true + 目标地址 + master-attach；cwd=仓库
	assert.ok(captured.prompt.includes(token), "T1 prompt 含 token");
	assert.ok(captured.prompt.includes(String(out.details?.handoffPath)), "T1 prompt 含交接包路径");
	assert.ok(captured.prompt.includes("local: true"), "T1 promptLocal:true（L4 实测 false → 修复）");
	assert.ok(captured.prompt.includes(addr), `T1 prompt 指示写回同一 local 地址 ${addr}`);
	assert.ok(captured.prompt.includes("master-attach"), "T1 prompt 指示 master-attach");
	assert.equal(captured.cwd, repo, "T1 spawn cwd = 仓库");
	assert.match(captured.title, /^master-/);

	// 四要素（发起）：scope + 旧 owner 快照 + 预期 gen + token 未消费；token 不进 text
	assert.ok(out.text.includes(`local ${addr}`), `T1 发起 text 标 local scope：${out.text}`);
	assert.ok(out.text.includes(`${sid12(oldSid)}/gen1`), `T1 发起 text 旧 owner 快照：${out.text}`);
	assert.ok(out.text.includes("gen2"), `T1 发起 text 预期 generation：${out.text}`);
	assert.ok(out.text.includes("token 已发放未消费"), `T1 发起 text token 状态：${out.text}`);
	assert.ok(!out.text.includes(token), "T1 token 值不进普通 UI text（发起）");
	assert.equal(out.details?.tokenConsumed, false);

	// 旧 owner 保持（detach 不删 attachment，§6）
	assert.equal(readAttachment(addr)?.sessionId, oldSid);

	// record：agent 地址 + 状态
	const rec = readTransferRecord(transferId)!;
	assert.equal(rec.agentAddress, addr, "T1 record agent = local 地址");
	assert.equal(rec.status, "spawned");
	assert.equal(rec.fromSession, oldSid);
	assert.equal(rec.fromGeneration, 1);
	assert.equal(rec.toSession, undefined, "T1 发起时新 owner 快照未写（未 attach）");
	assert.equal(rec.tokenConsumedAt, undefined, "T1 发起时 token 未消费");

	// 后继 token attach → gen+1
	const a = attachMaster({ sessionId: "session_local_new_h1", agent: addr, token });
	assert.equal(a.ok, true, `T1 后继 attach：${a.ok ? "" : a.reason}`);
	assert.equal(a.attachment.generation, 2, "T1 gen+1");

	// confirm → completed + 四要素
	const c = masterTransferConfirmLogic("session_local_new_h1", { transferId });
	assert.equal(c.isError, undefined, `T1 confirm：${c.text}`);
	const rec2 = readTransferRecord(transferId)!;
	assert.equal(rec2.status, "completed");
	assert.equal(rec2.toSession, "session_local_new_h1", "T1 record 新 owner 快照");
	assert.equal(rec2.toGeneration, 2, "T1 record 新 generation");
	assert.ok(typeof rec2.tokenConsumedAt === "string", "T1 record token 消费时刻");
	assert.ok(c.text.includes(`${sid12(oldSid)}/gen1`), `T1 confirm 旧 owner：${c.text}`);
	assert.ok(c.text.includes(`${sid12("session_local_new_h1")}/gen2`), `T1 confirm 新 owner：${c.text}`);
	assert.ok(c.text.includes("token 已消费"), `T1 confirm token 已消费：${c.text}`);
	assert.ok(!c.text.includes(token), "T1 token 值不进普通 UI text（confirm）");
	assert.equal(c.details?.tokenConsumed, true);
	ok("T1 local happy：prompt(token+包+local:true+地址)/order/gen+1/record 快照");
}

// ─────────────────────────────────────────────────────────────────
// T2 prompt 形态：global 文案逐字保持；local 带 local:true
// ─────────────────────────────────────────────────────────────────
{
	const g = buildSuccessorPrompt({ transferId: "tr_t2", token: "ho_t2", handoffPath: "/tmp/h.md", fromGeneration: 3 });
	assert.ok(g.includes("master-attach") && g.includes("只在 home 会话接 global") && !g.includes("local: true"), "T2 global prompt 原样");
	const l = buildSuccessorPrompt({ transferId: "tr_t2", token: "ho_t2", handoffPath: "/tmp/h.md", fromGeneration: 3, local: true, agent: "agent://master_local_repoT2" });
	assert.ok(l.includes("local: true") && l.includes("agent://master_local_repoT2") && l.includes("4"), "T2 local prompt 带 local:true + 地址 + gen+1");
	assert.ok(l.includes("不要接 global"), "T2 local prompt 明示不接 global");
	ok("T2 prompt 形态：global 原样 / local 带 local:true + 目标地址");
}

// ─────────────────────────────────────────────────────────────────
// T3 gate 非 owner
// ─────────────────────────────────────────────────────────────────
{
	const repo = mkDir("repoGate");
	const addr = localAddrOf(repo);
	attachMaster({ sessionId: "session_local_ga01", agent: addr, detail: repo });
	const out = masterTransferLogic("session_nobody_xx", { local: true, cwd: repo, env: ENV, spawn: stubSpawn("run_x") });
	assert.equal(out.isError, true, "T3 非 owner 拒绝");
	assert.match(out.text, /不是当前 owner/);
	assert.equal(readAttachment(addr)?.sessionId, "session_local_ga01", "T3 零写");
	ok("T3 gate 非 owner：拒绝且零写");
}

// ─────────────────────────────────────────────────────────────────
// T4 gate subagent（真实 tool execute，PI_SUBAGENT=1 子进程）
// ─────────────────────────────────────────────────────────────────
{
	const repo = mkDir("repoSub");
	const helper = join(tmpRoot, "_transfer_subagent_helper.mts");
	writeFileSync(
		helper,
		`import { registerMasterTools } from ${JSON.stringify(pathToFileURL(join(REPO_ROOT, "extensions", "master-tools.ts")).href)};\n` +
		`const tools = new Map<string, any>();\n` +
		`registerMasterTools({ registerTool: (t: any) => tools.set(t.name, t) } as never, { spawnSuccessor: () => ({ successorRunId: "x" }) });\n` +
		`const tool = tools.get("master-transfer");\n` +
		`tool.execute("tc", { local: true, reason: "sub" }, undefined, undefined, { cwd: process.argv[2] })\n` +
		`  .then((r: any) => process.stdout.write(JSON.stringify({ text: r.content[0].text, isError: r.isError })))\n` +
		`  .catch((e: any) => { process.stdout.write(JSON.stringify({ error: String(e) })); process.exitCode = 1; });\n`,
		"utf8",
	);
	const outStr = execFileSync(process.execPath, ["--experimental-strip-types", helper, repo], {
		env: { ...process.env, PI_SUBAGENT: "1" },
		encoding: "utf8",
	});
	const parsed = JSON.parse(outStr);
	assert.equal(parsed.isError, true, `T4 subagent 拒绝：${outStr}`);
	assert.match(parsed.text, /子 agent 不可发起交接/);
	ok("T4 gate subagent：真实 tool execute 拒绝（PI_SUBAGENT=1）");
}

// ─────────────────────────────────────────────────────────────────
// T5 gate home-local：local:true + exact-home cwd fail-closed，零写
// ─────────────────────────────────────────────────────────────────
{
	const repo = mkDir("repoHomeLocal");
	const addr = localAddrOf(repo);
	const owner = "session_local_hl01";
	attachMaster({ sessionId: owner, agent: addr, detail: repo });
	const attBefore = readBytes(attFileOf(addr));
	const transferDir = join(RUNTIME, "state", "master-transfers");
	const transferDirBefore = readdirSafe(transferDir);

	// home 会话（cwd == env.home 精确相等）调 local → 拒
	const out = masterTransferLogic(owner, { local: true, cwd: HOME, env: ENV, spawn: stubSpawn("run_hl") });
	assert.equal(out.isError, true, `T5 home 调 local 拒绝：${out.text}`);
	assert.equal(out.details?.reason, "home-local", "T5 reason=home-local");
	assert.match(out.text, /home 会话只持 global/);
	// 零写：local attachment 不变、无新 transfer 记录
	assert.equal(readBytes(attFileOf(addr)), attBefore, "T5 local attachment 零写");
	assert.deepEqual(readdirSafe(transferDir), transferDirBefore, "T5 无新 transfer 记录目录内容变化");

	// 对照：仓库 cwd（非 home）调 local 放行（guard 不误伤）
	const out2 = masterTransferLogic(owner, { local: true, cwd: repo, env: ENV, spawn: stubSpawn("run_hl2") });
	assert.equal(out2.isError, undefined, `T5 仓库 cwd 放行：${out2.text}`);
	ok("T5 gate home-local：exact-home + local:true fail-closed（零写）；仓库 cwd 不误伤");
}

// ─────────────────────────────────────────────────────────────────
// T6 cross-scope 零写（L4 安全级）
// ─────────────────────────────────────────────────────────────────
{
	// ① local token → 空 global：bad-token，global attachment 文件不落盘
	const repoA = mkDir("repoXa");
	const addrA = localAddrOf(repoA);
	attachMaster({ sessionId: "session_local_xa01", agent: addrA, detail: repoA });
	const dA = detachMaster({ sessionId: "session_local_xa01", generation: 1, agent: addrA });
	assert.equal(dA.ok, true);
	assert.equal(readAttachment(masterAddress()), null, "T6 前提：global 为空");
	const g = attachMaster({ sessionId: "session_bad_global1", agent: masterAddress(), token: dA.token! });
	assert.deepEqual(g, { ok: false, reason: "bad-token" }, "T6 local token 不得 genesis 到 global");
	assert.equal(existsSync(attFileOf(masterAddress())), false, "T6 global 零写（无半写）");
	assert.equal(readAttachment(addrA)?.sessionId, "session_local_xa01", "T6 源 local 不变");

	// ② global token → 空 local：bad-token，local attachment 文件不落盘
	const gOld = "session_g_tok_gl01";
	attachMaster({ sessionId: gOld }); // 若已被 T13 占用则 bump
	const gAtt = readAttachment(masterAddress())!;
	const dG = detachMaster({ sessionId: gAtt.sessionId, generation: gAtt.generation });
	assert.equal(dG.ok, true);
	const repoB = mkDir("repoXb");
	const addrB = localAddrOf(repoB);
	assert.equal(readAttachment(addrB), null, "T6 前提：local 为空");
	const l = attachMaster({ sessionId: "session_bad_local1", agent: addrB, token: dG.token! });
	assert.deepEqual(l, { ok: false, reason: "bad-token" }, "T6 global token 不得 genesis 到 local");
	assert.equal(existsSync(attFileOf(addrB)), false, "T6 local 零写（无半写）");

	// ③ global token → 非空 local：bad-token（目标 handoff 文件无此 token），逐字节不变
	attachMaster({ sessionId: "session_local_xb01", agent: addrB, detail: repoB });
	const before = readBytes(attFileOf(addrB));
	const l2 = attachMaster({ sessionId: "session_bad_local2", agent: addrB, token: dG.token! });
	assert.deepEqual(l2, { ok: false, reason: "bad-token" }, "T6 非空 local 目标仍 bad-token");
	assert.equal(readBytes(attFileOf(addrB)), before, "T6 非空 local 逐字节不变");
	ok("T6 cross-scope：local→global / global→local（空/非空）全 bad-token 零写");
}

// ─────────────────────────────────────────────────────────────────
// T7 expired / reused（fail-closed 零写）
// ─────────────────────────────────────────────────────────────────
{
	// expired：tokenTtlMs=1000，attach now=+2s → token-expired，attachment 不变
	const repoE = mkDir("repoExpired");
	const addrE = localAddrOf(repoE);
	attachMaster({ sessionId: "session_local_ex01", agent: addrE, detail: repoE });
	const dE = detachMaster({ sessionId: "session_local_ex01", generation: 1, agent: addrE, tokenTtlMs: 1000, now: new Date() });
	const before = readBytes(attFileOf(addrE));
	const e = attachMaster({ sessionId: "session_local_ex02", agent: addrE, token: dE.token!, now: new Date(Date.now() + 2000) });
	assert.deepEqual(e, { ok: false, reason: "token-expired" });
	assert.equal(readBytes(attFileOf(addrE)), before, "T7 expired 零写");

	// reused：首个 attach 成功 gen+1；重放同 token → generation-mismatch，owner 不变
	const repoR = mkDir("repoReused");
	const addrR = localAddrOf(repoR);
	attachMaster({ sessionId: "session_local_rr01", agent: addrR, detail: repoR });
	const dR = detachMaster({ sessionId: "session_local_rr01", generation: 1, agent: addrR });
	const first = attachMaster({ sessionId: "session_local_rr02", agent: addrR, token: dR.token! });
	assert.equal(first.ok, true);
	assert.equal(first.attachment?.generation, 2);
	const second = attachMaster({ sessionId: "session_local_rr03", agent: addrR, token: dR.token! });
	assert.deepEqual(second, { ok: false, reason: "generation-mismatch" }, "T7 重放被 generation 检查拒");
	assert.equal(readAttachment(addrR)?.sessionId, "session_local_rr02", "T7 重放后 owner 不变");
	ok("T7 expired / reused：均 fail-closed 且零写");
}

// ─────────────────────────────────────────────────────────────────
// T8 spawn 失败：owner 保持、record failed、无窗口 marker
// ─────────────────────────────────────────────────────────────────
{
	const repo = mkDir("repoSpawnFail");
	const addr = localAddrOf(repo);
	attachMaster({ sessionId: "session_local_sf01", agent: addr, detail: repo });
	const r = transferMaster({
		sessionId: "session_local_sf01",
		agent: addr,
		repoRoot: repo,
		spawn: () => { throw new Error("stub fail"); },
	});
	assert.equal(r.ok, false);
	if (r.ok) throw new Error("unreachable");
	assert.equal(r.reason, "spawn-failed");
	assert.equal(readAttachment(addr)?.sessionId, "session_local_sf01", "T8 旧主仍是 owner（无空窗）");
	const rec = readTransferRecord(r.transferId!)!;
	assert.equal(rec.status, "failed");
	assert.equal(rec.error, "stub fail");
	assert.equal(readTransferWindow(addr), null, "T8 失败路径无窗口 marker");
	ok("T8 spawn 失败：owner 保持 + record failed + 无窗口");
}

// ─────────────────────────────────────────────────────────────────
// T9 交接窗口抑制 + confirm 清理
// ─────────────────────────────────────────────────────────────────
{
	const repo = mkDir("repoWindow");
	const addr = localAddrOf(repo);
	const oldSid = "session_local_wd01";
	attachMaster({ sessionId: oldSid, agent: addr, detail: repo });
	const r = transferMaster({ sessionId: oldSid, agent: addr, repoRoot: repo, spawn: () => ({ successorRunId: "run_w" }) });
	assert.equal(r.ok, true);

	// marker 可查询：{agent, fromGeneration, transferId}
	const w = readTransferWindow(addr)!;
	assert.equal(w.transferId, r.transferId, "T9 marker transferId");
	assert.equal(w.agentAddress, addr, "T9 marker agent");
	assert.equal(w.fromGeneration, 1, "T9 marker fromGeneration");

	// forceStale 被抑制（stale 判据本可过：staleAfterMs=0 + now+30min）
	const f = attachMaster({
		sessionId: "session_force_w1", agent: addr, forceStale: true,
		staleAfterMs: 0, now: new Date(Date.now() + 30 * 60 * 1000),
	});
	assert.deepEqual(f, { ok: false, reason: "transfer-in-progress" }, "T9 窗口内 forceStale 拒");
	assert.equal(readAttachment(addr)?.sessionId, oldSid, "T9 forceStale 零写");

	// stale takeover 被抑制
	const t = takeoverMaster({ sessionId: "session_take_w1", agent: addr, expected: { sessionId: oldSid, generation: 1 } });
	assert.deepEqual(t, { ok: false, reason: "transfer-in-progress" }, "T9 窗口内 stale takeover 拒");

	// token attach（后继本人）不受窗口抑制 → gen+1
	const a = attachMaster({ sessionId: "session_local_wd02", agent: addr, token: r.token });
	assert.equal(a.ok, true, "T9 后继 token attach 不受窗口抑制");
	assert.equal(a.attachment?.generation, 2);

	// confirm 清理窗口；之后 takeover 恢复
	const c = confirmTransferAttach({ transferId: r.transferId, sessionId: "session_local_wd02" });
	assert.equal(c.ok, true, `T9 confirm：${c.ok ? "" : c.reason}`);
	assert.equal(readTransferWindow(addr), null, "T9 confirm 后窗口 marker 已清理");
	const t2 = takeoverMaster({ sessionId: "session_take_w2", agent: addr, expected: { sessionId: "session_local_wd02", generation: 2 } });
	assert.equal(t2.ok, true, "T9 窗口清理后 takeover 恢复");
	ok("T9 窗口抑制：forceStale/takeover 拒、token attach 放行、confirm 清理");
}

// ─────────────────────────────────────────────────────────────────
// T10 明确 human cancel 越过窗口并清理 marker
// ─────────────────────────────────────────────────────────────────
{
	const repo = mkDir("repoHumanCancel");
	const addr = localAddrOf(repo);
	attachMaster({ sessionId: "session_local_hc01", agent: addr, detail: repo });
	const r = transferMaster({ sessionId: "session_local_hc01", agent: addr, repoRoot: repo, spawn: () => ({ successorRunId: "run_hc" }) });
	assert.equal(r.ok, true);
	assert.notEqual(readTransferWindow(addr), null, "T10 窗口在位");

	// human cancel：越过抑制，接管成功，marker 清理
	const t = takeoverMaster({
		sessionId: "session_human_cancel1",
		agent: addr,
		expected: { sessionId: "session_local_hc01", generation: 1 },
		humanCancel: true,
	});
	assert.equal(t.ok, true, `T10 human cancel 越过：${t.ok ? "" : t.reason}`);
	assert.equal(t.attachment?.generation, 2);
	assert.equal(readTransferWindow(addr), null, "T10 human cancel 清理 marker");

	// 窗口已清：普通 forceStale 不再被抑制（stale 判据可过 → 成功）
	const f = attachMaster({
		sessionId: "session_force_hc2", agent: addr, forceStale: true,
		staleAfterMs: 0, now: new Date(Date.now() + 30 * 60 * 1000),
	});
	assert.equal(f.ok, true, `T10 窗口清理后 forceStale 放行：${f.ok ? "" : f.reason}`);
	ok("T10 human cancel：越过窗口 + 清理 marker + 后续接管恢复");
}

// ─────────────────────────────────────────────────────────────────
// T11 local transfer 不触碰 global succession state + 事件主体 local
// ─────────────────────────────────────────────────────────────────
{
	// 先种一份 global proposal（transferring 候选），快照 global succession 文件字节
	const stateDir = join(RUNTIME, "state");
	mkdirSync(stateDir, { recursive: true });
	const successionPath = join(stateDir, "master-succession.json");
	const seeded = {
		version: 1, proposalId: "hp_seed_local_probe", generation: 9, sessionId: "session_g_seed",
		pressure: 91, status: "pending", proposedAt: "2026-09-24T00:00:00.000Z",
	};
	writeFileSync(successionPath, `${JSON.stringify(seeded, null, 2)}\n`, "utf8");
	const successionBefore = readBytes(successionPath);
	const globalAttBefore = readAttachment(masterAddress());

	// 完整 local transfer + confirm
	const repo = mkDir("repoGlobalState");
	const addr = localAddrOf(repo);
	const oldSid = "session_local_gs01";
	attachMaster({ sessionId: oldSid, agent: addr, detail: repo });
	const r = transferMaster({ sessionId: oldSid, agent: addr, repoRoot: repo, spawn: () => ({ successorRunId: "run_gs" }) });
	assert.equal(r.ok, true);
	// local transfer 不得把 global proposal 改成 transferring（旧实现 adoptTransfer 会改）
	assert.equal(readBytes(successionPath), successionBefore, "T11 local transfer 后 global succession 字节不变");
	assert.deepEqual(readAttachment(masterAddress()), globalAttBefore, "T11 global attachment 不变");

	const a = attachMaster({ sessionId: "session_local_gs02", agent: addr, token: r.token });
	assert.equal(a.ok, true);
	const c = confirmTransferAttach({ transferId: r.transferId, sessionId: "session_local_gs02" });
	assert.equal(c.ok, true);
	assert.equal(readBytes(successionPath), successionBefore, "T11 local confirm 后 global succession 字节不变");
	assert.deepEqual(readAttachment(masterAddress()), globalAttBefore, "T11 global attachment 仍不变");

	// 事件主体：本 transfer 的 master.handoff.* envelope 的 subject/source = local 地址（非 global）
	const mine = listRuntimeEnvelopes<Record<string, unknown> & { payload?: { transferId?: string } }>()
		.envelopes
		.filter((e) => e.type.startsWith("master.handoff.") && e.payload?.transferId === r.transferId);
	assert.ok(mine.length >= 4, `T11 本 transfer 事件 ≥4（got ${mine.length}）`);
	for (const e of mine) {
		assert.equal(e.subject, addr, `T11 事件 subject=${addr}（${e.type}）`);
		assert.equal(e.source, addr, `T11 事件 source=${addr}（${e.type}）`);
	}
	ok("T11 local transfer：global succession 字节不变 + 事件主体 local");
}

// ─────────────────────────────────────────────────────────────────
// T12 四要素 observability（record 字段 + 失败路径不回退旧文案断言）
// ─────────────────────────────────────────────────────────────────
{
	// 用一个新 local 走完发起→attach→confirm，核对 record 全字段
	const repo = mkDir("repoObs");
	const addr = localAddrOf(repo);
	const oldSid = "session_local_obs01";
	attachMaster({ sessionId: oldSid, agent: addr, detail: repo });
	const r = transferMaster({ sessionId: oldSid, agent: addr, repoRoot: repo, spawn: () => ({ successorRunId: "run_obs" }) });
	assert.equal(r.ok, true);
	assert.equal(r.from?.sessionId, oldSid, "T12 发起 result 旧 owner sid");
	assert.equal(r.from?.generation, 1, "T12 发起 result 旧 owner gen");
	assert.equal(r.agent, addr, "T12 发起 result agent");
	assert.equal(r.local, true, "T12 发起 result local");
	attachMaster({ sessionId: "session_local_obs02", agent: addr, token: r.token });
	const c = confirmTransferAttach({ transferId: r.transferId, sessionId: "session_local_obs02" });
	assert.equal(c.ok, true);
	assert.deepEqual(c.from, { sessionId: oldSid, generation: 1 }, "T12 confirm result 旧快照");
	assert.deepEqual(c.to, { sessionId: "session_local_obs02", generation: 2 }, "T12 confirm result 新快照");
	assert.ok(typeof c.tokenConsumedAt === "string" && c.tokenConsumedAt.length > 0, "T12 confirm result tokenConsumedAt");
	assert.equal(c.handoffPath, r.handoffPath, "T12 confirm result handoffPath");
	const rec = readTransferRecord(r.transferId)!;
	assert.equal(rec.toSession, "session_local_obs02");
	assert.equal(rec.toGeneration, 2);
	assert.ok(rec.tokenConsumedAt);
	ok("T12 四要素：result/record 均含新旧 owner 快照 + token 消费");
}

// ─────────────────────────────────────────────────────────────────
// T13（最后跑 global）：global 回归 —— 四要素 + prompt 无 local:true
//（放最后：前面的 local 用例不依赖 global attachment 为空，T13 容忍已有 owner）
// ─────────────────────────────────────────────────────────────────
{
	const gOld = "session_g_global_old1";
	const g0 = readAttachment(masterAddress());
	if (!g0) {
		const g = attachMaster({ sessionId: gOld }); // global genesis
		assert.equal(g.ok, true, "T13 global genesis");
	} else if (g0.sessionId !== gOld) {
		// 前置用例已留 global owner：凭 token 收回为已知会话，隔离断言
		const d = detachMaster({ sessionId: g0.sessionId, generation: g0.generation });
		assert.equal(d.ok, true, "T13 收回 global");
		const g = attachMaster({ sessionId: gOld, token: d.token! });
		assert.equal(g.ok, true, "T13 收回 global attach");
	}
	const gGen0 = readAttachment(masterAddress())!.generation;
	const gNew = "session_g_global_new1";
	const captured: { prompt: string } = { prompt: "" };
	const out = masterTransferLogic(gOld, {
		reason: "g regression",
		cwd: HOME,
		spawn: (a) => { captured.prompt = a.prompt; return { successorRunId: "run_g" }; },
	});
	assert.equal(out.isError, undefined, `T13 发起应成功：${out.text}`);
	assert.ok(out.text.includes("global"), `T13 发起 text 标 global：${out.text}`);
	assert.ok(out.text.includes(`${sid12(gOld)}/gen${gGen0}`), `T13 发起 text 含旧 owner 快照：${out.text}`);
	assert.ok(out.text.includes(`gen${gGen0 + 1}`), `T13 发起 text 含预期 generation：${out.text}`);
	assert.ok(!out.text.includes(String(out.details?.token)), "T13 token 值不进普通 UI text");
	assert.ok(captured.prompt.includes("master-attach") && !captured.prompt.includes("local: true"), "T13 global prompt 无 local:true");
	const a = attachMaster({ sessionId: gNew, token: out.details?.token as string });
	assert.equal(a.ok, true, `T13 后继 attach：${a.ok ? "" : a.reason}`);
	assert.equal(a.attachment?.generation, gGen0 + 1);
	const c = masterTransferConfirmLogic(gNew, { transferId: out.details?.transferId as string });
	assert.equal(c.isError, undefined, `T13 confirm：${c.text}`);
	assert.ok(c.text.includes(`${sid12(gOld)}/gen${gGen0}`) && c.text.includes(`${sid12(gNew)}/gen${gGen0 + 1}`), `T13 confirm 四要素：${c.text}`);
	assert.ok(c.text.includes("token 已消费") && c.text.includes("global"), `T13 confirm token 消费：${c.text}`);
	ok("T13 global 回归：四要素回报 + prompt 无 local:true");
}

	console.log(`\n# pass ${n}`);
	rmSync(tmpRoot, { recursive: true, force: true });
	tmpRoot = "";
} catch (e) {
	if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
	throw e;
}
