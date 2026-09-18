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
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "runtime-master-succession-env-"));

import { attachCurrentSession, issueMasterHandoffToken } from "./runtime/master-control.ts";
import {
	adoptTransfer,
	completeProposalForGeneration,
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
	const dup = maybePropose({ sessionId: OWNER, generation: 1, reading: { tokens: 1, contextWindow: 2, percent: 99 } });
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
	const none = completeProposalForGeneration(1);
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
	const r = maybePropose({ sessionId: "sess_m5_gen2", generation: 2, reading: { tokens: 1, contextWindow: 2, percent: 80 } });
	assert.equal(r.proposed, true);
	if (!r.proposed) throw new Error("unreachable");
	assert.notEqual(r.proposal.proposalId, proposalId);
	const ad = adoptTransfer({ transferId: "tr_demo", fromGeneration: 2 });
	assert.equal(ad.adopted, true);
	assert.equal(readProposal()?.status, "transferring");
	const done = completeProposalForGeneration(2);
	assert.equal(done.completed, true);
	assert.equal(readProposal()?.status, "completed");
	ok("新代覆盖 + adopt→transferring + complete 闭环");
}

console.log(`\n# pass ${n}`);
