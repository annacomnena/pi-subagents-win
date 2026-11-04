/**
 * runtime/fusion-progress.ts — 融合者实时进度读数（2026-11-05 第 3 项显示层）。
 *
 * ## 为什么需要它
 *
 * trace-fusion 的融合者在自动链里是 headless 子进程。三路诊断 + glm-5.3-flash 评审一致结论：
 * **保持无头**（tab 会把终态从「退出码机器真相」降级成 `tab-finish` 模型自报；
 * 且违反 collect-cli §24.1「不依赖主会话存活」）。
 *
 * 但「想知道它此刻在干什么」这个需求是真的。正确满足层是**显示层**，不是换进程形态：
 * 融合者已经把自己的完整 `--mode json` 事件流写进 `fusion.stdout.log`，
 * 这里只把它**只读**解析成一个人能看的进度行。
 *
 * ## 判据
 *
 * - 只读 `fusion.stdout.log`（append-only 的 json 流），不写、不改、不加锁。
 * - 用「文件大小 + mtime」做增量缓存：文件没长就不重读（面板 10s tick × 大日志会烧 CPU）。
 * - never-throw：任何解析失败都返回 null（面板不能因为进度读不到就崩）。
 *
 * ## 为什么带「年龄」而不是绝对时间（AGENTS R-2）
 *
 * 与 `/autonomy status` 的 29 小时静默事故同一个教训：只给 `asof=<绝对时间>` 时，
 * 读的人**看不出陈旧多久**。所以进度行必须同时给 `(Xs 前)`。
 */

import { existsSync, statSync } from "node:fs";
import { readFileSync } from "node:fs";

export interface FusionProgress {
	/** 已完成的 assistant turn 数（`message_end` 里 role=assistant 的条数）。 */
	turns: number;
	/** 最后一次写入 stdout.log 的时刻（ms）。 */
	lastWriteMs: number;
	/** 距现在多少毫秒（面板给 `(Xs 前)` 用）。 */
	ageMs: number;
	/** 最后一条 assistant 的 stopReason（running 时通常是 toolUse）。 */
	lastStopReason: string | null;
	/** 日志字节数（粗略判断"还在长"）。 */
	logBytes: number;
}

interface CacheEntry {
	size: number;
	mtimeMs: number;
	turns: number;
	lastStopReason: string | null;
}

const CACHE = new Map<string, CacheEntry>();
const CACHE_MAX = 64;

/** 测试用：清空缓存。 */
export function _resetFusionProgressCache(): void {
	CACHE.clear();
}

/**
 * 读一个融合 stdout 日志的进度。文件不存在 / 解析失败 ⇒ null（不猜）。
 *
 * @param logPath `fusion.stdout.log` 的绝对路径
 * @param nowMs 当前时刻（测试注入）
 */
export function readFusionProgress(logPath: string, nowMs: number = Date.now()): FusionProgress | null {
	if (!logPath || !existsSync(logPath)) return null;
	let st: { size: number; mtimeMs: number };
	try {
		const s = statSync(logPath);
		st = { size: s.size, mtimeMs: s.mtimeMs };
	} catch {
		return null;
	}
	let hit = CACHE.get(logPath);
	// 增量缓存：文件没长、也没被改写 ⇒ 直接复用上次的 turn 计数
	if (!hit || hit.size !== st.size || hit.mtimeMs !== st.mtimeMs) {
		let turns = 0;
		let lastStopReason: string | null = null;
		try {
			const text = readFileSync(logPath, "utf8");
			for (const line of text.split("\n")) {
				const t = line.trim();
				if (!t.startsWith("{")) continue;
				let ev: unknown;
				try {
					ev = JSON.parse(t);
				} catch {
					continue; // 尾部可能半截
				}
				const e = ev as { type?: string; message?: { role?: string; stopReason?: string; rawStopReason?: string } };
				if (e?.type !== "message_end" || e?.message?.role !== "assistant") continue;
				turns += 1;
				lastStopReason = e.message.stopReason ?? e.message.rawStopReason ?? null;
			}
		} catch {
			return null;
		}
		hit = { size: st.size, mtimeMs: st.mtimeMs, turns, lastStopReason };
		if (CACHE.size >= CACHE_MAX) CACHE.clear();
		CACHE.set(logPath, hit);
	}
	return {
		turns: hit.turns,
		lastWriteMs: st.mtimeMs,
		ageMs: Math.max(0, nowMs - st.mtimeMs),
		lastStopReason: hit.lastStopReason,
		logBytes: st.size,
	};
}

/** 人可读的年龄（与 `/autonomy status` 的 ageTxt 同口径）。 */
export function formatProgressAge(ageMs: number): string {
	if (!Number.isFinite(ageMs) || ageMs < 0) return "?";
	if (ageMs < 60_000) return `${Math.round(ageMs / 1000)}s 前`;
	if (ageMs < 3_600_000) return `${Math.round(ageMs / 60_000)}min 前`;
	return `${(ageMs / 3_600_000).toFixed(1)}h 前`;
}

/**
 * 一行进度文案（面板/诊断面用）。`null` ⇒ 无进度可读。
 *
 * 形状：`第 7 turn · 8s 前 · toolUse`（R-2：带年龄，不只给绝对时间）
 */
export function fusionProgressLine(p: FusionProgress | null): string | null {
	if (!p) return null;
	const stop = p.lastStopReason ? ` · ${p.lastStopReason}` : "";
	return `第 ${p.turns} turn · ${formatProgressAge(p.ageMs)}${stop}`;
}
