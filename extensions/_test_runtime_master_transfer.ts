/**
 * _test_runtime_master_transfer.ts — Phase 5.5 M3：Transactional Master Transfer
 *
 * 覆盖（隔离运行时目录，fake spawn）：
 *   非 owner 拒绝（无记录、无 token）
 *   全流程：owner 校验→fresh handoff→token→spawn→spawned 记录→attachment 保留
 *   spawn 抛错 → failed，旧主仍是 owner（无空窗 §6）
 *   confirm 握手：后继凭真 token attach（gen+1）→ confirm completed
 *   confirm 坏路径：未知 id / 会话错配 / 重复确认
 *
 * 2026-10-12 L4 M1-fix 回归：
 *   transferMaster 把交接主体 agent 传给 spawn（global→global / local→local，反例）
 *   emitPostSpawnFailureEvent 失败事件审计归属（缺省回退 global / local 记 local）
 *
 * 2026-10-12 L4 nice-to-have #3：异步 spawn 失败收尾
 *   failTransferPostSpawn：record spawned→failed + 清该 agent 窗口（global/local 反例）
 *   成功路径零变化 + 晚到失败不误清新交接窗口（竞态守卫）
 *
 * 运行：npm run test:runtime-master-transfer
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "runtime-master-transfer-env-"));

/** home 守卫迁移（0923）：控制层必填 cwd/initialCwd；存量用例以真实 home 通过门（仅作比较，不写 home）。 */
const HOME = homedir();

import {
	attachCurrentSession,
	issueMasterHandoffToken,
} from "./runtime/master-control.ts";
import {
	buildMasterSuccessorTitle,
	buildSuccessorPrompt,
	confirmTransferAttach,
	emitPostSpawnFailureEvent,
	failTransferPostSpawn,
	readTransferRecord,
	transferMaster,
} from "./runtime/master-transfer.ts";
import { attachMaster, readAttachment, readTransferWindow } from "./runtime/registry.ts";
import { masterAddress } from "./runtime/address.ts";
import { localMasterAddress, localMasterScope } from "./runtime/scope.ts";
import { listRuntimeEnvelopes } from "./runtime/journal.ts";

let n = 0;
const ok = (name: string) => { n++; console.log(`ok ${n} - ${name}`); };
const fakeSpawn = (runId: string) => () => ({ successorRunId: runId });

// ① 非 owner 拒绝
{
	const r = transferMaster({ sessionId: "nobody", spawn: fakeSpawn("x") });
	assert.equal(r.ok, false);
	ok("非 owner 拒绝");
}

// ② 全流程（fake spawn）
const OWNER = "sess_owner_m3";
let transferId = "";
let token = "";
{
	const a = attachCurrentSession({ sessionId: OWNER, cwd: HOME, initialCwd: HOME });
	assert.equal(a.ok, true);
	const r = transferMaster({ sessionId: OWNER, reason: "m3-test", spawn: fakeSpawn("run_succ_1") });
	assert.equal(r.ok, true);
	if (!r.ok) throw new Error("unreachable");
	transferId = r.transferId;
	token = r.token;
	assert.match(transferId, /^tr_/);
	assert.match(token, /^ho_/);
	assert.equal(r.successorRunId, "run_succ_1");
	const rec = readTransferRecord(transferId);
	assert.equal(rec?.status, "spawned");
	assert.equal(rec?.fromSession, OWNER);
	assert.equal(rec?.fromGeneration, 1);
	assert.equal(readAttachment(masterAddress())?.sessionId, OWNER);
	const types = listRuntimeEnvelopes().envelopes.map((e) => e.type);
	assert.ok(types.includes("master.handoff.started"));
	assert.ok(types.includes("master.handoff.spawned"));
	const prompt = buildSuccessorPrompt({ transferId, token, handoffPath: r.handoffPath, fromGeneration: 1 });
	assert.ok(prompt.includes(token) && prompt.includes(transferId) && prompt.includes("master-attach"));
	ok("全流程：handoff→token→spawn→spawned，旧主保留");
}

// ③ spawn 失败
{
	const r = transferMaster({
		sessionId: OWNER,
		spawn: () => { throw new Error("no wt"); },
	});
	assert.equal(r.ok, false);
	if (r.ok) throw new Error("unreachable");
	assert.equal(r.reason, "spawn-failed");
	const rec = readTransferRecord(r.transferId!);
	assert.equal(rec?.status, "failed");
	assert.equal(readAttachment(masterAddress())?.sessionId, OWNER);
	ok("spawn 失败→failed，旧主仍是 owner");
}

// ④ confirm 握手（后继凭真 token 接管；取最新有效 token）
{
	const fresh = issueMasterHandoffToken({ sessionId: OWNER, reason: "succession" });
	assert.equal(fresh.ok, true);
	if (!fresh.ok || !("token" in fresh) || !fresh.token) throw new Error("unreachable");
	const a = attachCurrentSession({ sessionId: "sess_succ_1", token: fresh.token, cwd: HOME, initialCwd: HOME });
	assert.equal(a.ok, true);
	if (a.ok) assert.equal(a.attachment.generation, 2);
	const c = confirmTransferAttach({ transferId, sessionId: "sess_succ_1" });
	assert.equal(c.ok, true);
	assert.equal(readTransferRecord(transferId)?.status, "completed");
	const types = listRuntimeEnvelopes().envelopes.map((e) => e.type);
	assert.ok(types.includes("master.handoff.attached"));
	assert.ok(types.includes("master.handoff.completed"));
	ok("confirm：gen+1 接管→completed");
}

// ⑤ 坏路径
{
	const c1 = confirmTransferAttach({ transferId: "tr_nope", sessionId: "x" });
	assert.equal(c1.ok, false);
	const c2 = confirmTransferAttach({ transferId, sessionId: "sess_succ_1" });
	assert.equal(c2.ok, false); // 已 completed，非 spawned
	ok("confirm 坏路径：未知 id / 重复确认拒绝");
}

// ⑥ 未 attach 即 confirm → generation-mismatch
{
	const r = transferMaster({ sessionId: "sess_succ_1", spawn: fakeSpawn("run_succ_2") });
	assert.equal(r.ok, true);
	if (!r.ok) throw new Error("unreachable");
	const c = confirmTransferAttach({ transferId: r.transferId, sessionId: "sess_succ_1" });
	assert.equal(c.ok, false);
	ok("confirm 未接管即确认 → generation-mismatch");
}

// ⑧ buildMasterSuccessorTitle：master-时间-主要工作
{
	const at = new Date(2026, 8, 23, 14, 30); // 本地时间注入
	assert.equal(
		buildMasterSuccessorTitle("tr_abc123", 5, "影像tile缓存", at),
		"master-0923-1430-影像tile缓存",
	);
	assert.equal(
		buildMasterSuccessorTitle("tr_abc123", 5, "影像 tile 缓存", at),
		"master-0923-1430-影像-tile-缓存",
	);
	ok("中文 reason slug");
}
{
	const at = new Date(2026, 8, 23, 14, 30);
	const t = buildMasterSuccessorTitle("tr_x", 5, "fix: bug#123!!", at);
	assert.equal(t, "master-0923-1430-fix-bug123");
	ok("非法字符清洗");
}
{
	const at = new Date(2026, 8, 23, 14, 30);
	assert.equal(buildMasterSuccessorTitle("tr_x", 5, undefined, at), "master-0923-1430-gen5");
	assert.equal(buildMasterSuccessorTitle("tr_x", 5, "", at), "master-0923-1430-gen5");
	assert.equal(buildMasterSuccessorTitle("tr_x", 5, "!!!///", at), "master-0923-1430-gen5");
	ok("无 reason 回退 gen<N>");
}
{
	const at = new Date(2026, 8, 23, 14, 30);
	const t = buildMasterSuccessorTitle("tr_x", 5, "ab" + "😀".repeat(30) + "影像缓存测试超长截断", at);
	const slug = t.slice("master-0923-1430-".length);
	assert.ok(Array.from(slug).length <= 24, `slug 超长: ${slug}`);
	assert.ok(slug.isWellFormed(), "slug 切散代理对");
	assert.ok(!/--+/.test(slug) && !/^-|-$/.test(slug), `slug 规范: ${slug}`);
	ok("超长截断（按码点，不切散 emoji）");
}
{
	const a = buildMasterSuccessorTitle("tr_x", 5, "r", new Date(2026, 8, 23, 14, 30));
	const b = buildMasterSuccessorTitle("tr_x", 5, "r", new Date(2026, 11, 1, 8, 5));
	assert.ok(a.startsWith("master-0923-1430-"), a);
	assert.ok(b.startsWith("master-1201-0805-"), b);
	assert.ok(!a.includes("tr_x") && !b.includes("tr_x"), "transferId 不进标题");
	ok("now 注入决定时间部分");
}

// ⑨ transferMaster 传递可读标题给 spawn
{
	let title = "";
	const r = transferMaster({
		sessionId: "sess_succ_1",
		reason: "影像 tile 缓存",
		spawn: (args) => { title = args.title; return { successorRunId: "run_title_1" }; },
	});
	assert.equal(r.ok, true);
	assert.match(title, /^master-\d{4}-\d{4}-影像-tile-缓存$/);
	ok("transferMaster 用可读标题 spawn 后继");
}

// ⑩ M1-fix：交接主体地址确实传给 spawn（修复前 spawn 入参无 agent 字段）
{
	// global（缺省 agent）：spawn 收到全局 masterAddress()
	let capturedGlobal: string | undefined;
	const r = transferMaster({
		sessionId: "sess_succ_1",
		spawn: (args) => { capturedGlobal = args.agent; return { successorRunId: "run_m1_g" }; },
	});
	assert.equal(r.ok, true);
	assert.equal(capturedGlobal, masterAddress());
	ok("M1 global：spawn 收到 global 地址");
}
{
	// local（反例）：spawn 收到 local 地址（≠ global），修复前两者都拿不到 agent
	const localAddr = localMasterAddress(localMasterScope(join(HOME, "m1-probe-repo")));
	attachMaster({ sessionId: "sess_local_m1", agent: localAddr, detail: "m1-probe" });
	let capturedLocal: string | undefined;
	const r = transferMaster({
		sessionId: "sess_local_m1",
		agent: localAddr,
		spawn: (args) => { capturedLocal = args.agent; return { successorRunId: "run_m1_l" }; },
	});
	assert.equal(r.ok, true);
	assert.equal(capturedLocal, localAddr);
	assert.notEqual(capturedLocal, masterAddress());
	ok("M1 local：spawn 收到 local 地址（≠ global，反例）");
}

// ⑪ M1-fix：异步 spawn 失败事件的审计归属（index.ts onSpawnError 现走本函数）
{
	const failedOf = (id: string) => listRuntimeEnvelopes<{ payload?: { transferId?: string } }>()
		.envelopes.filter((e) => e.type === "master.handoff.failed" && e.payload?.transferId === id);
	// 缺省（global）：source/subject = global，行为与修复前一致
	emitPostSpawnFailureEvent({ transferId: "tr_m1_global", sessionId: "sess_m1_g", error: "boom" });
	const g = failedOf("tr_m1_global");
	assert.equal(g.length, 1);
	assert.equal(g[0].source, masterAddress());
	assert.equal(g[0].subject, masterAddress());
	ok("M1 失败事件（缺省）：source/subject = global");
	// local（反例）：source/subject = local，不再被误记为 global
	const localAddr = localMasterAddress(localMasterScope(join(HOME, "m1-evt-repo")));
	emitPostSpawnFailureEvent({ transferId: "tr_m1_local", sessionId: "sess_m1_l", error: "boom", agent: localAddr });
	const l = failedOf("tr_m1_local");
	assert.equal(l.length, 1);
	assert.equal(l[0].source, localAddr);
	assert.equal(l[0].subject, localAddr);
	assert.notEqual(l[0].subject, masterAddress());
	ok("M1 失败事件（local）：source/subject = local（反例）");
}

// ⑫ nice-to-have #3：异步 spawn 失败 → record spawned→failed + 该 agent 窗口清除（global）
{
	const GOWNER = readAttachment(masterAddress())!.sessionId;
	const r = transferMaster({ sessionId: GOWNER, reason: "n3-global", spawn: fakeSpawn("run_n3_g") });
	assert.equal(r.ok, true);
	if (!r.ok) throw new Error("unreachable");
	assert.equal(readTransferRecord(r.transferId)?.status, "spawned");
	assert.equal(readTransferWindow(masterAddress())?.transferId, r.transferId);
	failTransferPostSpawn({ transferId: r.transferId, sessionId: GOWNER, error: "async boom g" });
	assert.equal(readTransferRecord(r.transferId)?.status, "failed", "N3 global：record 收尾 failed");
	assert.equal(readTransferRecord(r.transferId)?.error, "async boom g");
	assert.equal(readTransferWindow(masterAddress()), null, "N3 global：窗口已清除");
	const ev = listRuntimeEnvelopes<{ payload?: { transferId?: string } }>()
		.envelopes.filter((e) => e.type === "master.handoff.failed" && e.payload?.transferId === r.transferId);
	assert.equal(ev.length, 1, "N3 global：失败事件落盘一次");
	assert.equal(ev[0].source, masterAddress());
	assert.equal(ev[0].subject, masterAddress());
	ok("N3 global：异步失败→record failed + 窗口清除 + 事件归属 global");
}

// ⑬ nice-to-have #3（local 反例）：清的是 local agent 的窗口，不误伤 global 窗口
{
	// 先在 global 占一个在途窗口（用于验证 local 清理不跨 agent）
	const GOWNER = readAttachment(masterAddress())!.sessionId;
	const g = transferMaster({ sessionId: GOWNER, reason: "n3-guard", spawn: fakeSpawn("run_n3_guard") });
	assert.equal(g.ok, true);
	if (!g.ok) throw new Error("unreachable");
	const localAddr = localMasterAddress(localMasterScope(join(HOME, "n3-probe-repo")));
	const LSID = "sess_local_n3";
	attachMaster({ sessionId: LSID, agent: localAddr, detail: "n3-probe" });
	const l = transferMaster({ sessionId: LSID, agent: localAddr, spawn: fakeSpawn("run_n3_l") });
	assert.equal(l.ok, true);
	if (!l.ok) throw new Error("unreachable");
	assert.equal(readTransferWindow(localAddr)?.transferId, l.transferId);
	failTransferPostSpawn({ transferId: l.transferId, sessionId: LSID, error: "async boom l", agent: localAddr });
	assert.equal(readTransferWindow(localAddr), null, "N3 local：local 窗口已清除（反例）");
	assert.equal(readTransferWindow(masterAddress())?.transferId, g.transferId, "N3 local 清理不误伤 global 窗口");
	assert.equal(readTransferRecord(l.transferId)?.status, "failed");
	const ev = listRuntimeEnvelopes<{ payload?: { transferId?: string } }>()
		.envelopes.filter((e) => e.type === "master.handoff.failed" && e.payload?.transferId === l.transferId);
	assert.equal(ev.length, 1);
	assert.equal(ev[0].source, localAddr);
	assert.notEqual(ev[0].subject, masterAddress());
	ok("N3 local（反例）：清 local 窗口 + 不误伤 global + 事件归属 local");
}

// ⑭ nice-to-have #3 回归：成功路径零变化（不经过 failTransferPostSpawn → 窗口保留、停 spawned）
{
	const GOWNER = readAttachment(masterAddress())!.sessionId;
	const r = transferMaster({ sessionId: GOWNER, reason: "n3-success", spawn: fakeSpawn("run_n3_ok") });
	assert.equal(r.ok, true);
	if (!r.ok) throw new Error("unreachable");
	assert.equal(readTransferRecord(r.transferId)?.status, "spawned", "N3 成功：record 仍 spawned");
	assert.equal(readTransferWindow(masterAddress())?.transferId, r.transferId, "N3 成功：窗口按原语义保留");
	ok("N3 成功路径回归：record 停 spawned + 窗口保留（零变化）");
}

// ⑮ nice-to-have #3 竞态守卫：旧 transfer 的晚到失败不得清新 transfer 的窗口
{
	const GOWNER = readAttachment(masterAddress())!.sessionId;
	const a = transferMaster({ sessionId: GOWNER, reason: "n3-a", spawn: fakeSpawn("run_a") });
	const b = transferMaster({ sessionId: GOWNER, reason: "n3-b", spawn: fakeSpawn("run_b") });
	assert.equal(a.ok, true);
	assert.equal(b.ok, true);
	if (!a.ok || !b.ok) throw new Error("unreachable");
	assert.equal(readTransferWindow(masterAddress())?.transferId, b.transferId, "窗口已被新交接覆盖");
	failTransferPostSpawn({ transferId: a.transferId, sessionId: GOWNER, error: "late boom a" });
	assert.equal(readTransferWindow(masterAddress())?.transferId, b.transferId, "N3 竞态：不清新交接窗口");
	assert.equal(readTransferRecord(a.transferId)?.status, "failed", "N3 竞态：旧 record 仍收尾 failed");
	ok("N3 竞态守卫：晚到失败不误清新交接窗口");
}

console.log(`\n# pass ${n}`);
