/**
 * interactionBadge.ts — G6-P3 待决策徽标映射（纯函数，供 TopBar / AttentionPage 与测试共用）。
 *
 * 交互投影（/v1/interactions）→ 徽标 {count, tone}：
 *   count = 带 response 的可决条数（投影仍含所有 open attention，未带 response 的只是待关注）；
 *   tone  = 0 → 灰（无待决策）；可决项含 critical → 红；其余 → 黄。
 * 零依赖（仅 type import），node --experimental-strip-types 可直接测试（_test_interaction_badge.ts）。
 */

import type { InteractionItem } from "./api/types";

export type PendingBadgeTone = "red" | "yellow" | "gray";

export interface PendingBadge {
	count: number;
	tone: PendingBadgeTone;
}

/** 同输入同输出；不区分 id（徽标只要数量与严重度）。 */
export function pendingDecisionBadge(items: readonly InteractionItem[]): PendingBadge {
	const actionable = items.filter((i) => i.response !== undefined);
	const count = actionable.length;
	if (count === 0) return { count: 0, tone: "gray" };
	const hasCritical = actionable.some((i) => i.severity === "critical");
	return { count, tone: hasCritical ? "red" : "yellow" };
}
