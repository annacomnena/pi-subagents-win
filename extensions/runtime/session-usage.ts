/**
 * runtime/session-usage.ts — 会话**当前轮次**的上下文用量投影（2026-10-21）
 *
 * ## 用户诉求
 * GUI 合适位置显示本会话当前轮次的：上下文长度（绝对 tokens）、占比（%）、缓存比例。
 *
 * ## 数据源（实测确认，非推测）
 * pi 每个 assistant 消息都带 `usage`（本机实测 422/422 条 assistant 有该字段）：
 * ```json
 * { "input": 210, "output": 315, "cacheRead": 309888, "cacheWrite": 0,
 *   "reasoning": 0, "totalTokens": 310413, "cost": {...} }
 * ```
 * 字段全集：`input / output / cacheRead / cacheWrite / reasoning / totalTokens / cost`。
 *
 * ## 三个指标的口径（**必须写清，否则读者会算错**）
 *
 * 1. **上下文长度 = `totalTokens`**（最后一条 assistant 的）。
 *    这是「这一轮真正喂给模型 + 它产出」的量，也就是当前上下文占用的最直接读数。
 *    注意：它不是 `input + output` 的字面相加 —— provider 报的 `totalTokens` 才是权威（含缓存命中的部分）。
 *
 * 2. **占比 = `totalTokens / contextWindow`**。
 *    `contextWindow` 来自 `master-liveness.json` 的 `windowTokens`（pi 的 `readPressure()` 同源），
 *    取不到 ⇒ `percent: null`（**不猜**，不用别的数凑）。
 *    与 TopBar 现有的「上下文压力」不同：那个是 **master 会话**的压力百分比（`pressure` 字段），
 *    本模块算的是**当前打开会话**的占比，两者不可混用。
 *
 * 3. **缓存比例 = `cacheRead / (cacheRead + input)`**。
 *    为什么不是 `cacheRead / totalTokens`？因为 `totalTokens` 含 `output`（模型生成的部分），
 *    output 永远不可能命中缓存，把它放进分母会**系统性压低**缓存率读数。
 *    真正能「命中/不命中」的是**输入侧**：`cacheRead`（命中）vs `input`（未命中）。
 *    `cacheWrite` 不计入分母：它是首次写入缓存的成本，不是「本次输入」的一部分；
 *    但单独回报（`cacheWriteTokens`），读者可自行判断。
 *    分母为 0 ⇒ `cachePercent: null`（无输入，比例无意义，不报 0% 误导）。
 *
 * ## 零 IO 纯函数
 * `computeUsage` 只做算术；读盘在 `readSessionUsage`（薄壳）。这样口径逻辑可直测。
 */

/** 一条 assistant usage 的原始形状（pi 落盘格式；字段可能缺失，全部按可选处理）。 */
export interface RawUsage {
	input?: unknown;
	output?: unknown;
	cacheRead?: unknown;
	cacheWrite?: unknown;
	reasoning?: unknown;
	totalTokens?: unknown;
}

/** 投影结果（给 GUI 的稳定契约）。 */
export interface SessionUsage {
	/** 上下文长度（tokens）；null = 该会话还没有带 usage 的 assistant 消息。 */
	tokens: number | null;
	/** 上下文窗口（tokens）；null = 未知。 */
	contextWindow: number | null;
	/** 占比（0-100，保留 2 位小数）；null = tokens 或 window 未知。 */
	percent: number | null;
	/** 缓存命中率（0-100）；null = 无输入（无法计算）或没有 usage。 */
	cachePercent: number | null;
	/** 明细（便于 GUI 做 tooltip；不参与主显示）。 */
	detail: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		reasoning: number;
	};
	/** 该读数的时刻（assistant 消息的 timestamp；缺失则不落该字段）。 */
	at?: string;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

/** 从一条原始 usage 算投影（纯函数）。 */
export function computeUsage(raw: RawUsage | null | undefined, contextWindow: number | null, at?: string): SessionUsage {
	const empty: SessionUsage = {
		tokens: null,
		contextWindow,
		percent: null,
		cachePercent: null,
		detail: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
		...(at !== undefined ? { at } : {}),
	};
	if (raw === null || raw === undefined || typeof raw !== "object") return empty;

	const input = num(raw.input);
	const output = num(raw.output);
	const cacheRead = num(raw.cacheRead);
	const cacheWrite = num(raw.cacheWrite);
	const reasoning = num(raw.reasoning);

	// 优先用 provider 报的 totalTokens（权威）；缺失才退回 input+cacheRead+output 的合成。
	// 合成口径在注释里写明，避免后人以为是权威值。
	const reported = raw.totalTokens;
	const tokens =
		typeof reported === "number" && Number.isFinite(reported) && reported > 0
			? reported
			: input + cacheRead + output > 0
				? input + cacheRead + output
				: null;

	const percent =
		tokens !== null && contextWindow !== null && contextWindow > 0
			? Math.round((tokens / contextWindow) * 10000) / 100
			: null;

	// 缓存率只看**输入侧**：cacheRead 命中 vs input 未命中。
	const inputSide = cacheRead + input;
	const cachePercent = inputSide > 0 ? Math.round((cacheRead / inputSide) * 10000) / 100 : null;

	return {
		tokens,
		contextWindow,
		percent,
		cachePercent,
		detail: { input, output, cacheRead, cacheWrite, reasoning },
		...(at !== undefined ? { at } : {}),
	};
}

/**
 * 从会话 JSONL 的**末尾往前**找到第一条带 usage 的 assistant 消息。
 *
 * 为什么从后往前：只要「当前轮次」的读数，读全文件是浪费（152MB 会话会卡死）。
 * 采样上限 `maxLines` 默认 400 行——正常会话末尾几条内必命中；
 * 400 行都找不到 ⇒ 如实返 null（不猜）。
 */
export function pickLastUsage(lines: unknown[], maxLines = 400): { usage: RawUsage; at?: string } | null {
	const start = Math.max(0, lines.length - maxLines);
	for (let i = lines.length - 1; i >= start; i--) {
		const rec = lines[i];
		if (typeof rec !== "object" || rec === null) continue;
		const msg = (rec as { message?: unknown }).message;
		if (typeof msg !== "object" || msg === null) continue;
		const m = msg as { role?: unknown; usage?: unknown; timestamp?: unknown };
		if (m.role !== "assistant") continue;
		if (typeof m.usage !== "object" || m.usage === null) continue;
		const at = typeof m.timestamp === "string" ? m.timestamp : undefined;
		return { usage: m.usage as RawUsage, ...(at !== undefined ? { at } : {}) };
	}
	return null;
}

// ── 读盘壳（尾部块读，绝不全量读 152MB 会话）─────────────────

import { closeSync, openSync, readSync, statSync } from "node:fs";

/** 从文件尾部读最后一个「块」，切出完整行 → 供 pickLastUsage。 */
export function readTailLines(path: string, maxLines = 400, maxBytes = 512 * 1024): string[] {
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch {
		return [];
	}
	try {
		const size = statSync(path).size;
		if (size === 0) return [];
		// 先取 maxBytes 尾块；行数不够再翻倍，最多 3 轮（≈4MB 上限）
		for (let bytes = maxBytes, round = 0; round < 3; round++, bytes *= 2) {
			const len = Math.min(bytes, size);
			const start = size - len;
			const buf = Buffer.allocUnsafe(len);
			readSync(fd, buf, 0, len, start);
			const text = buf.toString("utf8");
			let lines = text.split("\n").filter((l) => l.trim().length > 0);
			// 不是从文件头开始的块 ⇒ 首行可能是半截，丢掉
			if (start > 0 && lines.length > 0) lines = lines.slice(1);
			if (lines.length >= maxLines || start === 0) {
				return lines.slice(-maxLines);
			}
		}
		return [];
	} catch {
		return [];
	} finally {
		try {
			closeSync(fd);
		} catch {
			/* ignore */
		}
	}
}

/** 从会话文件读出「当前轮次」用量（薄壳；任何异常 ⇒ 全 null 读数，不猜）。 */
export function readSessionUsage(path: string, contextWindow: number | null): SessionUsage {
	const lines = readTailLines(path);
	const parsed: unknown[] = [];
	for (const l of lines) {
		try {
			const o: unknown = JSON.parse(l);
			if (typeof o === "object" && o !== null) parsed.push(o);
		} catch {
			/* 坏行跳过（与 transcript 同口径） */
		}
	}
	const hit = pickLastUsage(parsed);
	return computeUsage(hit?.usage ?? null, contextWindow, hit?.at);
}
