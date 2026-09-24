/**
 * hotspot/decay — 衰减纯函数（v4 §7 等价实现；无 IO，可单测）
 *
 * score(t) = score(t0) * 2^(-(t - t0) / HALF_LIFE_MS) + event_weight
 * 写时不衰减、读时一次算清：事件按 at 升序遍历，事件间先衰减后累加权重，
 * 末次事件到 now 的衰减最后一次性应用。
 * TTL：age ≥ HARD → pruned（不进投影）；≥ SOFT → soft（lookup 可见、注入排除）。
 * 目录不批量升温：分片只存文件路径（采集白名单已排除 grep/find/ls），无需目录惩罚项。
 */

import { HALF_LIFE_MS, HARD_TTL_MS, SOFT_TTL_MS, WEIGHTS, type HotEvent, type HotKind } from "./types.ts";

/** 事件序列（任意顺序输入，内部按 at 升序）在时刻 now 的衰减得分；空序列/全坏时间戳 → 0。 */
export function scoreEvents(events: HotEvent[], now: number): number {
	const sorted = events
		.map((e) => ({ e, t: Date.parse(e.at) }))
		.filter((x) => Number.isFinite(x.t))
		.sort((a, b) => a.t - b.t);
	let s = 0;
	let tPrev: number | null = null;
	for (const { e, t } of sorted) {
		const w = WEIGHTS[e.kind as HotKind] ?? 0;
		s = tPrev === null ? w : s * Math.pow(2, -(t - tPrev) / HALF_LIFE_MS) + w;
		tPrev = t;
	}
	if (tPrev === null) return 0;
	return s * Math.pow(2, -(now - tPrev) / HALF_LIFE_MS);
}

export type TtlState = "fresh" | "soft" | "pruned";

/** TTL 状态判定（边界：48:00 整 → soft、72:00 整 → pruned）。 */
export function ttlState(lastSeenMs: number, now: number): TtlState {
	const age = now - lastSeenMs;
	if (age >= HARD_TTL_MS) return "pruned";
	if (age >= SOFT_TTL_MS) return "soft";
	return "fresh";
}
