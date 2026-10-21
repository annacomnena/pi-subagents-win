/**
 * _test_turn_collapse.ts — 「任务执行完毕自动折叠工作过程」判定规则的回归门（2026-10-21）。
 *
 * 规则在 `turnCollapse.ts`（纯函数）；这里逐条钉死 8 个边界。夹具按**真实行形状**造
 * （R-4：每行都带 rowId / turnIndex / at 等运行时会有的字段，缺字段会让判定退化）。
 *
 * 运行：npm run test:gui-turn-collapse
 */

import assert from "node:assert/strict";
// 仓库惯例：strip-types 直跑必须带 .ts 扩展名（gui 应用内 import 则相反，不带 —— 见 gui/README.md）
import type { TranscriptRow } from "./api/types.ts";
import { planTurnCollapse } from "./turnCollapse.ts";

let n = 0;
const ok = (name: string): void => {
	n += 1;
	console.log(`ok ${n} - ${name}`);
};

const START = "2026-10-21T00:00:00.000Z";
const at = (ms: number): string => new Date(Date.parse(START) + ms).toISOString();

const H = (turnIndex: number, durationMs?: number): TranscriptRow => ({
	kind: "turnHeader",
	rowId: `t_${turnIndex}`,
	turnIndex,
	startedAt: START,
	...(durationMs === undefined ? {} : { durationMs }),
});
const U = (turnIndex: number, ms = 0): TranscriptRow => ({
	kind: "userInput",
	rowId: `r_${turnIndex}_u`,
	turnIndex,
	at: at(ms),
	text: "帮我看看这个",
});
const A = (turnIndex: number, ms: number, text = "答复正文"): TranscriptRow => ({
	kind: "assistantText",
	rowId: `r_${turnIndex}_a${ms}`,
	turnIndex,
	at: at(ms),
	text,
	model: "test-model",
	provider: "test",
});
const R = (turnIndex: number, ms: number, text = "我先想一下"): TranscriptRow => ({
	kind: "reasoning",
	rowId: `r_${turnIndex}_r${ms}`,
	turnIndex,
	at: at(ms),
	text,
	model: "test-model",
	provider: "test",
});
const C = (turnIndex: number, ms: number, name = "read_file"): TranscriptRow => ({
	kind: "toolCall",
	rowId: `r_${turnIndex}_c${ms}`,
	turnIndex,
	at: at(ms),
	callId: `call_${ms}`,
	name,
	arguments: {},
	status: "done",
	output: "ok",
});

// ── ① 已结束的轮：过程折叠，用户气泡 + 最终答复留着 ─────────────────
{
	const rows = [H(1, 89_000), U(1), R(1, 5_000), C(1, 20_000), A(1, 40_000, "我先读文件。"), C(1, 60_000), A(1, 89_000, "最终答复")];
	const plan = planTurnCollapse(rows, { running: false, opened: {} });
	const s = plan.summaryByHeaderId.get("t_1");
	assert.ok(s !== undefined, "已结束的轮要给出摘要（供折叠线渲染）");
	assert.equal(s.durationMs, 89_000, "时长直接用 turnHeader.durationMs");
	assert.equal(s.steps, 3, "步骤数 = reasoning 1 + toolCall 2");
	assert.equal(s.rows, 4, "折叠区 4 行 = 思考 + 工具 + 旁白 + 工具");
	assert.equal(s.expanded, false, "默认折叠");
	assert.deepEqual(
		[...plan.hidden].sort(),
		["r_1_a40000", "r_1_c20000", "r_1_c60000", "r_1_r5000"],
		"隐藏的正是过程那 4 行（含中间旁白）",
	);
	assert.ok(!plan.hidden.has("r_1_u"), "用户气泡永不折叠");
	assert.ok(!plan.hidden.has("r_1_a89000"), "最终答复必须常显");
	ok("① 已结束的轮：折叠过程、保留用户气泡与最终答复");
}

// ── ② 跑着的轮：一律不折叠 ─────────────────────────────────────────
{
	const rows = [H(1), U(1), R(1, 5_000), C(1, 20_000), A(1, 40_000, "最终答复")];
	const plan = planTurnCollapse(rows, { running: true, opened: {} });
	assert.equal(plan.hidden.size, 0, "running=true 时一行都不藏");
	assert.equal(plan.summaryByHeaderId.size, 0, "跑着的轮不给摘要（不渲染折叠线）");
	ok("② 跑着的轮不折叠");
}

// ── ③ 用户手动展开：不隐藏，但仍给摘要（label 要显示时长/步数）──────
{
	const rows = [H(1, 30_000), U(1), R(1, 5_000), C(1, 10_000), A(1, 30_000)];
	const plan = planTurnCollapse(rows, { running: false, opened: { t_1: true } });
	assert.equal(plan.hidden.size, 0, "展开后不隐藏任何行");
	const s = plan.summaryByHeaderId.get("t_1");
	assert.ok(s !== undefined);
	assert.equal(s.expanded, true, "摘要标记为已展开");
	assert.equal(s.steps, 2);
	ok("③ 用户展开优先于自动折叠");
}

// ── ④ 整轮只有文字：没有过程可折叠，保持原样 ───────────────────────
{
	const rows = [H(1, 8_000), U(1), A(1, 8_000)];
	const plan = planTurnCollapse(rows, { running: false, opened: {} });
	assert.equal(plan.summaryByHeaderId.size, 0, "没有 reasoning/toolCall ⇒ 不可折叠");
	assert.equal(plan.hidden.size, 0);
	ok("④ 纯文字轮不折叠");
}

// ── ⑤ 收尾是工具行（尾部没有 assistantText）：不乱藏 ────────────────
{
	const rows = [H(1, 20_000), U(1), R(1, 5_000), A(1, 8_000, "中间旁白"), C(1, 20_000)];
	const plan = planTurnCollapse(rows, { running: false, opened: {} });
	assert.equal(plan.hidden.size, 0, "无法判断哪段是答复 ⇒ 整轮不折叠（宁可多显示）");
	ok("⑤ 以工具收尾的轮不折叠");
}

// ── ⑥ 窗口从轮中间开始（没有 turnHeader）：不折叠 ───────────────────
{
	const rows = [R(1, 5_000), C(1, 20_000), A(1, 40_000, "最终答复")];
	const plan = planTurnCollapse(rows, { running: false, opened: {} });
	assert.equal(plan.hidden.size, 0, "没有 header 就没有可点的入口，不能藏");
	assert.equal(plan.summaryByHeaderId.size, 0);
	ok("⑥ 缺 turnHeader 的残轮不折叠");
}

// ── ⑦ 最后一轮（durationMs 缺失）+ 会话空闲：按最后一行时间估算时长 ──
{
	const rows = [H(1), U(1), R(1, 30_000), C(1, 60_000), A(1, 89_000)];
	const plan = planTurnCollapse(rows, { running: false, opened: {} });
	const s = plan.summaryByHeaderId.get("t_1");
	assert.ok(s !== undefined, "空闲会话的最后一轮也应折叠");
	assert.equal(s.durationMs, 89_000, "估算 = 最后一行 at − startedAt");
	assert.equal(plan.hidden.size, 2, "只藏思考 + 工具两行（用户气泡与最终答复留着）");
	ok("⑦ 最后一轮用最后一行时间估算时长");
}

// ── ⑧ 多轮混合：前几轮折叠、正在跑的那轮不折叠 ─────────────────────
{
	const rows = [
		H(1, 40_000), U(1), R(1, 5_000), C(1, 10_000), A(1, 40_000, "第一轮答复"),
		H(2), U(2), R(2, 5_000), C(2, 10_000), A(2, 20_000, "第二轮答复"),
	];
	const plan = planTurnCollapse(rows, { running: true, opened: {} });
	assert.ok(plan.summaryByHeaderId.has("t_1"), "已关闭的第 1 轮折叠");
	assert.ok(!plan.summaryByHeaderId.has("t_2"), "正在跑的第 2 轮不折叠");
	assert.ok(plan.hidden.has("r_1_r5000") && plan.hidden.has("r_1_c10000"));
	assert.ok(!plan.hidden.has("r_2_r5000"), "跑着的轮一行都不藏");
	ok("⑧ 多轮：只折叠已结束的轮");
}

// ── ⑨ 时刻都取不到 ⇒ 不编造时长（null）──────────────────────────
{
	const rows: TranscriptRow[] = [
		{ kind: "turnHeader", rowId: "t_9", turnIndex: 9, startedAt: "not-a-date" },
		{ kind: "userInput", rowId: "r_9_u", turnIndex: 9, at: "bad", text: "x" },
		{ kind: "reasoning", rowId: "r_9_r", turnIndex: 9, at: "bad", text: "y" },
		{ kind: "assistantText", rowId: "r_9_a", turnIndex: 9, at: "bad", text: "z" },
	];
	const plan = planTurnCollapse(rows, { running: false, opened: {} });
	const s = plan.summaryByHeaderId.get("t_9");
	assert.ok(s !== undefined);
	assert.equal(s.durationMs, null, "时刻无效时给 null，不编一个 0");
	ok("⑨ 时长拿不到时给 null");
}

console.log(`\n_test_turn_collapse: all assertions passed (${n})`);
