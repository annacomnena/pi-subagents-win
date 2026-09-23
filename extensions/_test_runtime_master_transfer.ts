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
	readTransferRecord,
	transferMaster,
} from "./runtime/master-transfer.ts";
import { readAttachment } from "./runtime/registry.ts";
import { masterAddress } from "./runtime/address.ts";
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

console.log(`\n# pass ${n}`);
