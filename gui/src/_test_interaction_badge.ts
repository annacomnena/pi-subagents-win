/**
 * _test_interaction_badge.ts — G6-P3 GUI 徽标映射测试（pendingDecisionBadge 纯函数性质）。
 *
 * 覆盖：
 *   B1 同 state 同输出（确定性：两次映射 deepEqual + 字节一致）
 *   B2 空态 → {count:0, tone:"gray"}
 *   B3 计数 = 带 response 的可决投影条数；tone 阶梯：无可决项 → gray；可决项无 critical → yellow；任一可决 critical → red
 *   B4 纯性：输入数组不被修改；投影项字段缺失容错（payload/response 缺省照常映射）
 *
 * 运行：npm run test:gui-interaction-badge
 */

import assert from "node:assert/strict";
import { pendingDecisionBadge } from "./interactionBadge.ts";
import type { InteractionItem } from "./api/types.ts";

function ix(over: Partial<InteractionItem>): InteractionItem {
	return {
		id: over.id ?? "master-handoff:hp_1",
		kind: over.kind ?? "master-handoff",
		severity: over.severity ?? "warning",
		createdAt: over.createdAt ?? "2026-09-22T00:00:00.000Z",
		title: over.title ?? "Handoff pending",
		summary: over.summary ?? "s",
		...(over.payload !== undefined ? { payload: over.payload } : {}),
		...(over.response !== undefined ? { response: over.response } : {}),
	};
}

const items: InteractionItem[] = [
	ix({ id: "master-handoff:hp_1", kind: "master-handoff", severity: "warning", response: { command: "master.handoff.accept" } }),
	ix({ id: "escalation:msg_1", kind: "escalation", severity: "info" }),
	ix({ id: "blocked:ws_a", kind: "blocked", severity: "warning" }),
];

// B1 确定性
{
	const a = pendingDecisionBadge(items);
	const b = pendingDecisionBadge(items);
	assert.deepEqual(b, a);
	assert.equal(JSON.stringify(b), JSON.stringify(a), "同 state 同输出（字节级）");
}

// B2 空态
{
	assert.deepEqual(pendingDecisionBadge([]), { count: 0, tone: "gray" }, "空 → 灰 0");
}

// B3 可决计数 + tone 阶梯
{
	assert.equal(pendingDecisionBadge(items).count, 1, "计数 = 带 response 的可决条数");
	assert.equal(pendingDecisionBadge(items).tone, "yellow", "可决项无 critical → yellow");
	assert.deepEqual(
		pendingDecisionBadge(items.filter((item) => item.response === undefined)),
		{ count: 0, tone: "gray" },
		"仅待关注、无 response 的项不计作待决策",
	);
	assert.equal(
		pendingDecisionBadge([...items, ix({ id: "runtime-risk:attn_1", kind: "runtime-risk", severity: "critical", response: { command: "master.handoff.accept" } })]).tone,
		"red",
		"任一可决 critical → red",
	);
}

// B4 纯性 + 容错
{
	const snapshot = JSON.stringify(items);
	pendingDecisionBadge(items);
	assert.equal(JSON.stringify(items), snapshot, "输入数组不被修改");
	// 只读投影（readonly）与缺 payload/response 的项照常映射
	assert.equal(pendingDecisionBadge([ix({ kind: "question", severity: "info" })]).tone, "gray");
}

console.log("_test_interaction_badge: all assertions passed");
