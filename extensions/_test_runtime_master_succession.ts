/**
 * _test_runtime_master_succession.ts — Phase 5.5 M5：Proposal-driven Handoff State
 *
 * 覆盖（隔离运行时目录）：
 *   非 owner / 未达线 / 无读数 → 不提议
 *   owner 达线 → pending 落盘 + proposed 事件；同代重复 → 去重
 *   pending 提醒文案；新代覆盖（隐式 supersede）
 *   decide 接受/拒绝/坏路径；adopt 认领；complete 闭环
 *
 * 运行：npm run test:runtime-master-succession
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "runtime-master-succession-env-"));

import { attachCurrentSession, issueMasterHandoffToken } from "./runtime/master-control.ts";
import {
	adoptTransfer,
	completeProposalForTransfer,
	decideProposal,
	getPendingReminder,
	maybePropose,
	readProposal,
} from "./runtime/master-succession.ts";
import { listRuntimeEnvelopes } from "./runtime/journal.ts";
// R1 回归网：session-hooks 仅定义无顶层执行，导入即验证全部 import 绑定可解析
// （strip-types --check 只查语法，此导入补命名解析层）。
import "./session-hooks.ts";

let n = 0;
const ok = (name: string) => { n++; console.log(`ok ${n} - ${name}`); };
const OWNER = "sess_owner_m5";

{
	const a = attachCurrentSession({ sessionId: OWNER });
	assert.equal(a.ok, true);
	ok("genesis 接管");
}

{
	const r1 = maybePropose({ sessionId: "nobody", generation: 1, reading: { tokens: null, contextWindow: null, percent: 90 } });
	assert.equal(r1.proposed, false);
	const r2 = maybePropose({ sessionId: OWNER, generation: 1, reading: { tokens: 1, contextWindow: 2, percent: 30 } });
	assert.equal(r2.proposed, false);
	const r3 = maybePropose({ sessionId: OWNER, generation: 1, reading: { tokens: null, contextWindow: null, percent: null } });
	assert.equal(r3.proposed, false);
	assert.equal(readProposal(), null);
	ok("非 owner / 未达线 / 无读数 → 不提议");
}

let proposalId = "";
{
	const r = maybePropose({ sessionId: OWNER, generation: 1, reading: { tokens: 152000, contextWindow: 200000, percent: 76 } });
	assert.equal(r.proposed, true);
	if (!r.proposed) throw new Error("unreachable");
	proposalId = r.proposal.proposalId;
	assert.match(proposalId, /^hp_/);
	assert.equal(r.proposal.status, "pending");
	const dup = maybePropose({ sessionId: OWNER, generation: 1, reading: { tokens: 198000, contextWindow: 200000, percent: 99 } });
	assert.equal(dup.proposed, false);
	assert.equal(readProposal()?.proposalId, proposalId);
	const types = listRuntimeEnvelopes().envelopes.map((e) => e.type);
	assert.ok(types.includes("master.handoff.proposed"));
	const reminder = getPendingReminder();
	assert.ok(reminder?.includes("master-transfer") && reminder?.includes(proposalId));
	ok("达线提议 + 同代去重 + 提醒文案");
}

{
	const bad = decideProposal({ sessionId: "nobody", decision: "accepted" });
	assert.equal(bad.ok, false);
	const acc = decideProposal({ sessionId: OWNER, decision: "accepted" });
	assert.equal(acc.ok, true);
	const again = decideProposal({ sessionId: OWNER, decision: "declined" });
	assert.equal(again.ok, false);
	const types = listRuntimeEnvelopes().envelopes.map((e) => e.type);
	assert.ok(types.includes("master.handoff.accepted"));
	ok("decide：非 owner 拒绝 + 接受落 accepted + 重复拒绝");
}

{
	const no = adoptTransfer({ transferId: "tr_x", fromGeneration: 1 });
	assert.equal(no.adopted, false); // 已 accepted，非 pending
	const none = completeProposalForTransfer("tr_nope");
	assert.equal(none.completed, false);
	assert.equal(getPendingReminder(), null);
	ok("adopt/complete 非 pending 即 no-op");
}

{
	const tok = issueMasterHandoffToken({ sessionId: OWNER });
	assert.equal(tok.ok, true);
	if (!tok.ok || !("token" in tok) || !tok.token) throw new Error("unreachable");
	const a2 = attachCurrentSession({ sessionId: "sess_m5_gen2", token: tok.token });
	assert.equal(a2.ok, true);
	const r = maybePropose({ sessionId: "sess_m5_gen2", generation: 2, reading: { tokens: 160000, contextWindow: 200000, percent: 80 } });
	assert.equal(r.proposed, true);
	if (!r.proposed) throw new Error("unreachable");
	assert.notEqual(r.proposal.proposalId, proposalId);
	const ad = adoptTransfer({ transferId: "tr_demo", fromGeneration: 2 });
	assert.equal(ad.adopted, true);
	assert.equal(readProposal()?.status, "transferring");
	const done = completeProposalForTransfer("tr_demo");
	assert.equal(done.completed, true);
	assert.equal(readProposal()?.status, "completed");
	ok("新代覆盖 + adopt→transferring + complete 闭环");
}

// ── R2（plans/0921_G52_patch_review.md 必修 2）：代级 claim / 原子 create 协议 ──
{
	const claimsDir = join(process.env.PI_RUNTIME_DIR!, "state", "master-succession.claims");
	mkdirSync(claimsDir, { recursive: true });

	// ① 超龄 crash claim（赢家 claim 后写盘前崩溃，无 proposal）→ 接管创建成功（可恢复）
	const tok3 = issueMasterHandoffToken({ sessionId: "sess_m5_gen2" });
	assert.equal(tok3.ok, true);
	if (!tok3.ok || !("token" in tok3) || !tok3.token) throw new Error("unreachable");
	const a3 = attachCurrentSession({ sessionId: "sess_m5_gen3", token: tok3.token });
	assert.equal(a3.ok, true);
	const staleClaim = join(claimsDir, "gen-3.claim");
	writeFileSync(staleClaim, JSON.stringify({ pid: -1, acquiredAt: "2026-09-20T00:00:00.000Z" }));
	const old = new Date(Date.now() - 11_000);
	utimesSync(staleClaim, old, old);
	const adopt = maybePropose({ sessionId: "sess_m5_gen3", generation: 3, reading: { tokens: 150000, contextWindow: 200000, percent: 85 } });
	assert.equal(adopt.proposed, true, `超龄 claim 被接管：${JSON.stringify(adopt)}`);
	if (!adopt.proposed) throw new Error("unreachable");
	assert.equal(readProposal()?.generation, 3);
	assert.equal(readProposal()?.proposalId, adopt.proposal.proposalId);
	const dup3 = maybePropose({ sessionId: "sess_m5_gen3", generation: 3, reading: { tokens: 150000, contextWindow: 200000, percent: 90 } });
	assert.equal(dup3.proposed, false);
	if (dup3.proposed === false) assert.equal(dup3.reason, "already-proposed");
	ok("R2 超龄 claim 接管创建 + 同代去重语义保持");

	// ② 新鲜 crash claim（接管窗口内）→ 保守 already-proposed，绝不覆盖/二次创建
	const tok4 = issueMasterHandoffToken({ sessionId: "sess_m5_gen3" });
	assert.equal(tok4.ok, true);
	if (!tok4.ok || !("token" in tok4) || !tok4.token) throw new Error("unreachable");
	const a4 = attachCurrentSession({ sessionId: "sess_m5_gen4", token: tok4.token });
	assert.equal(a4.ok, true);
	const freshClaim = join(claimsDir, "gen-4.claim");
	writeFileSync(freshClaim, JSON.stringify({ pid: -1, acquiredAt: new Date().toISOString() }));
	const blocked = maybePropose({ sessionId: "sess_m5_gen4", generation: 4, reading: { tokens: 150000, contextWindow: 200000, percent: 85 } });
	assert.equal(blocked.proposed, false, "新鲜 claim 窗口内不让权强建");
	if (blocked.proposed === false) assert.equal(blocked.reason, "already-proposed");
	assert.equal(readProposal()?.generation, 3, "同代无 proposal 时不越权创建（等接管窗口）");
	ok("R2 新鲜 claim 窗口内保守让权（proposal 永不覆盖）");
}

console.log(`\n# pass ${n}`);
