/**
 * master-pressure.ts — Master Context Pressure Gauge（Phase 5.5 M4）。
 *
 * 职责只有：读当前上下文压力 → 归一化 → 判定是否达提议线。
 * 不负责 spawn，不负责 proposal 状态（那是 M5），不猜测（§9）：
 * percent == null → 本轮 no decision。
 *
 * 数据源：pi ctx.getContextUsage()（累计 today-usage 不得用，它不是窗口占用）。
 * 形状（rpc.md）：{tokens, contextWindow, percent}，整体可缺席；
 * compaction 后三者可为 null，直到新一轮 assistant 响应产出有效读数。
 */
export interface PressureSource {
	tokens?: number | null;
	contextWindow?: number | null;
	percent?: number | null;
}

export interface PressureReading {
	tokens: number | null;
	contextWindow: number | null;
	percent: number | null;
}

/** 提议线缺省 75%（§10，可配，S3 auto 另设）。
 *  线位 = min(proposalPercent × W, tierCap(W))，档位封顶表（主会话 0919 拍板）：
 *  ≤200K → 150K 封顶（小窗口百分比主导：128K→96K、200K→150K，与今日标称线一致）；
 *  ≤500K（400K/500K 档）→ 250K；>500K（1M 档）→ 400K。 */
export const DEFAULT_PROPOSAL_PERCENT = 0.75;

/** 档位封顶表（主会话 0919 拍板：128K-96K / 200K-150K / 400K·500K-250K / 1M-400K）。
 *  每档 [windowCeil, capTokens]：线位绝对值封顶；≤200K 档的 cap=150K 意味着
 *  128K 窗口下百分比线 96K 先到（保留小窗口百分比语义），200K 恰在 150K。 */
export const PROPOSAL_TIER_CAPS: ReadonlyArray<readonly [number, number]> = [
	[200_000, 150_000], // ≤200K（128K/200K 档：75% 自然得出 96K/150K）
	[500_000, 250_000], // ≤500K（400K/500K 档）
	[Number.POSITIVE_INFINITY, 400_000], // >500K（1M 档）
] as const;

/** 档位封顶：取 window 所在档的绝对线（不在表内时取最大档，防御式）。 */
export function proposalTierCap(window: number): number {
	for (const [ceil, cap] of PROPOSAL_TIER_CAPS) if (window <= ceil) return cap;
	return PROPOSAL_TIER_CAPS[PROPOSAL_TIER_CAPS.length - 1][1];
}

/** 提议线（tokens 绝对值）：min(proposalPercent × W, tierCap(W))。 */
export function proposalThresholdTokens(window: number, percent: number = DEFAULT_PROPOSAL_PERCENT): number {
	return Math.round(Math.min(percent * window, proposalTierCap(window)));
}

/** 归一化：缺席/非法一律落 null，不抛错。 */
export function readPressure(usage: PressureSource | null | undefined): PressureReading {
	const num = (v: unknown): number | null =>
		typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
	if (!usage) return { tokens: null, contextWindow: null, percent: null };
	return {
		tokens: num(usage.tokens),
		contextWindow: num(usage.contextWindow),
		percent: num(usage.percent),
	};
}

/** 是否达到提议线；percent 缺席恒 false（no decision，不猜）。
 *  判定：
 *   1. percent === null → false（no decision 门不动，§9 不猜）；
 *   2. tokens/contextWindow 均在且 W>0 → tokens 精确判定（tokens ≥ min(p×W, tierCap(W))），
 *      消除 percent 取整误差；W≤0 视为未知走分支 3（防 min(0, W_ref)=0 退化成恒真 0 线）；
 *   3. 否则退回 percent >= p×100（今日行为兜底）。 */
export function meetsProposalThreshold(
	reading: PressureReading,
	threshold: number = DEFAULT_PROPOSAL_PERCENT,
): boolean {
	if (reading.percent === null) return false;
	if (reading.tokens !== null && reading.contextWindow !== null && reading.contextWindow > 0) {
		return reading.tokens >= proposalThresholdTokens(reading.contextWindow, threshold);
	}
	return reading.percent >= threshold * 100;
}

/** 展示行：供 tool/notify 共用（未知即明示未知）。 */
export function formatPressure(reading: PressureReading): string {
	if (reading.percent === null) return "context pressure: 未知（本轮无有效读数，no decision）";
	const detail =
		reading.tokens !== null && reading.contextWindow !== null
			? `（${reading.tokens}/${reading.contextWindow} tokens）`
			: "";
	return `context pressure: ${reading.percent}%${detail}`;
}
