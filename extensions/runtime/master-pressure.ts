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
 *  线位 = proposalPercent × min(W, REFERENCE_WINDOW_TOKENS)：
 *  ≤200K 窗口与今日标称线一致（=0.75W），>200K 封顶在 150K（1M 可达）。 */
export const DEFAULT_PROPOSAL_PERCENT = 0.75;

/** 参考窗（§16 组合阈值的封顶项）：75% 线成文时代的主流旗舰窗口档。
 *  线位 = p × min(W, 200K)——让 1M 档旋钮照常缩放（p=0.5→100K、p=0.95→190K），
 *  ≤200K 窗口线位与今日一致；crossover 恰在 W=200K，无新魔法数。 */
export const REFERENCE_WINDOW_TOKENS = 200_000;

/** 提议线（tokens 绝对值）：proposalPercent × min(W, REFERENCE_WINDOW_TOKENS)。 */
export function proposalThresholdTokens(window: number, percent: number = DEFAULT_PROPOSAL_PERCENT): number {
	return Math.round(percent * Math.min(window, REFERENCE_WINDOW_TOKENS));
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
 *   2. tokens/contextWindow 均在且 W>0 → tokens 精确判定（tokens ≥ p×min(W,200K)），
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
