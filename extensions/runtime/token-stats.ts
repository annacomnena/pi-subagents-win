/**
 * runtime/token-stats.ts — Token 消耗历史聚合统计与热力图数据源
 *
 * 聚合目标：
 * 1. 时间段内的全局汇总（总 Tokens、输入、输出、缓存读写、费用估算、轮次）
 * 2. 每日聚合序列（支持按日期、GitHub 风格日历热力图）
 * 3. 24 小时时段分布（0..23 时段峰谷分析）
 * 4. 按会话列表聚合（排序、检索、下钻）
 * 5. 按模型聚合（各模型用量分布、占比）
 * 6. 对齐 `/today-usage`（extensions/usage-ledger.ts）的严格自然日与双流聚合（主会话 + subagent 用量账本）
 *
 * 口径纪律（反粗暴统计、反跨日污染）：
 * - 本地自然日严格对齐：以 localDayBounds() 为准，绝不用过去 24h 滚动窗口混充自然日。
 * - 轮次级（Turn-level）时间戳断言：每一轮 assistant usage 必须严格根据自身时间戳判定，
 *   缺失有效时间戳则舍弃，坚决不回退到文件 mtimeMs，严防老旧长会话因为今天有活跃就把历史数亿 token 误算入今天。
 * - 24 小时分布严格隔离：未来小时（如当前下午 16:30，17:00..23:00）数值必须为 0，严禁渗入昨天傍晚数据。
 * - 性能缓存：基于 mtimeMs + size 的内存文件级缓存，冷读 1000 会话约 1-2s，温读 < 30ms。
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	DEFAULT_SESSIONS_ROOT,
	dailyUsagePath,
	getUsageDir,
	inDay,
	listJsonlFiles,
	localDayBounds,
	modelKey,
	overlappingUtcDates,
	parseTsMs,
	type DayBounds,
} from "../usage-ledger.ts";

export interface TurnUsage {
	timestamp: number;
	model: string;
	provider: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	totalTokens: number;
	costUsd: number;
}

interface CachedSession {
	stamp: string;
	sessionId: string;
	title?: string;
	cwd: string | null;
	startedAt: string | null;
	turns: TurnUsage[];
}

interface CachedSubagentFile {
	stamp: string;
	events: Array<{
		id: string;
		runId: string;
		agent: string | null;
		model: string;
		provider: string;
		timestamp: number;
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		turns: number;
		cost: number;
		totalTokens: number;
	}>;
}

export interface SessionUsageAggregate {
	sessionId: string;
	title?: string;
	cwd: string | null;
	startedAt: string | null;
	lastActiveAt: string | null;
	model: string;
	provider: string;
	turns: number;
	totalTokens: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	reasoningTokens: number;
	costUsd: number;
}

export interface DailyUsageAggregate {
	date: string; // YYYY-MM-DD
	totalTokens: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	reasoningTokens: number;
	costUsd: number;
	turns: number;
	sessionsCount: number;
}

export interface HourlyUsageAggregate {
	hour: number; // 0..23
	totalTokens: number;
	turns: number;
}

export interface ModelUsageAggregate {
	model: string;
	provider: string;
	turns: number;
	totalTokens: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd: number;
	percent: number;
}

export interface TokenStatsSummary {
	totalTokens: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	reasoningTokens: number;
	estimatedCostUsd: number;
	totalTurns: number;
	totalSessions: number;
	cacheHitRatePercent: number | null;
	today: {
		totalTokens: number;
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		turns: number;
		costUsd: number;
	};
}

export interface TokenStatsResult {
	version: 1;
	asOf: string;
	days: number;
	since: string;
	until: string;
	summary: TokenStatsSummary;
	daily: DailyUsageAggregate[];
	hourly: HourlyUsageAggregate[];
	bySession: SessionUsageAggregate[];
	byModel: ModelUsageAggregate[];
}

export interface CollectTokenStatsOptions {
	sessionsDir?: string;
	usageDir?: string;
	days?: number; // 默认 30，1 代表今天（自然日 00:00 至今），0 代表全量
	nowMs?: number;
}

const SESSION_CACHE = new Map<string, CachedSession>();
const SUBAGENT_CACHE = new Map<string, CachedSubagentFile>();
const CACHE_CAP = 3000;

function num(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

function parseSessionFile(filePath: string, stamp: string): CachedSession {
	const turns: TurnUsage[] = [];
	let sessionId = "";
	let cwd: string | null = null;
	let startedAt: string | null = null;
	let sessionTitle: string | undefined = undefined;

	try {
		const text = readFileSync(filePath, "utf8");
		for (const line of text.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;

			if (sessionId === "" && trimmed.includes('"session"')) {
				try {
					const head = JSON.parse(trimmed);
					if (head && head.type === "session") {
						sessionId = typeof head.id === "string" ? head.id : "";
						cwd = typeof head.cwd === "string" ? head.cwd : null;
						startedAt = typeof head.timestamp === "string" ? head.timestamp : null;
					}
				} catch {
					/* ignore */
				}
			}

			if (!sessionTitle && trimmed.includes('"user"')) {
				try {
					const uObj = JSON.parse(trimmed);
					if (uObj.type === "message" && uObj.message?.role === "user") {
						const content = uObj.message.content;
						if (typeof content === "string") {
							sessionTitle = content.slice(0, 60);
						} else if (Array.isArray(content) && content[0]?.text) {
							sessionTitle = String(content[0].text).slice(0, 60);
						}
					}
				} catch {
					/* ignore */
				}
			}

			if (!trimmed.includes('"usage"')) continue;

			try {
				const entry = JSON.parse(trimmed);
				const msg = entry.message ?? (entry.role === "assistant" ? entry : null);
				if (!msg || msg.role !== "assistant" || !msg.usage) continue;

				// 严谨提取轮次时间戳（坚决不回退到 mtimeMs）
				const entryTs = parseTsMs(entry.timestamp) ?? parseTsMs(msg.timestamp);
				const msgTs = parseTsMs(msg.timestamp) ?? entryTs;
				if (!msgTs) continue;

				const u = msg.usage;
				const input = num(u.input);
				const output = num(u.output);
				const cacheRead = num(u.cacheRead);
				const cacheWrite = num(u.cacheWrite);
				const reasoning = num(u.reasoning);
				const totalTokens = num(u.totalTokens) > 0 ? num(u.totalTokens) : input + output + cacheRead + cacheWrite;
				const costUsd = u.cost && typeof u.cost === "object" ? num(u.cost.total) : 0;

				const prov = typeof msg.provider === "string" && msg.provider ? msg.provider : "unknown";
				const mod = typeof msg.model === "string" && msg.model ? msg.model : "unknown";

				turns.push({
					timestamp: msgTs,
					model: mod,
					provider: prov,
					input,
					output,
					cacheRead,
					cacheWrite,
					reasoning,
					totalTokens,
					costUsd,
				});
			} catch {
				/* ignore */
			}
		}
	} catch {
		/* ignore */
	}

	if (!sessionId) {
		const base = filePath.replace(/\\/g, "/").split("/").pop() ?? "";
		const raw = base.replace(/\.jsonl$/, "");
		const idx = raw.lastIndexOf("_");
		sessionId = idx >= 0 ? raw.slice(idx + 1) : raw;
	}

	return {
		stamp,
		sessionId,
		title: sessionTitle,
		cwd,
		startedAt,
		turns,
	};
}

function getOrLoadSession(filePath: string, mtimeMs: number, size: number): CachedSession {
	const stamp = `${mtimeMs}|${size}`;
	const hit = SESSION_CACHE.get(filePath);
	if (hit && hit.stamp === stamp) {
		return hit;
	}
	const parsed = parseSessionFile(filePath, stamp);
	if (SESSION_CACHE.size >= CACHE_CAP) SESSION_CACHE.clear();
	SESSION_CACHE.set(filePath, parsed);
	return parsed;
}

function parseSubagentFile(filePath: string, stamp: string): CachedSubagentFile {
	const events: CachedSubagentFile["events"] = [];
	try {
		const text = readFileSync(filePath, "utf8");
		for (const line of text.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const r = JSON.parse(trimmed);
				const ts = parseTsMs(r.ts);
				if (!ts) continue;

				const eventId = typeof r.id === "string" ? r.id : `subagent:${r.ts}:${trimmed}`;
				const u = r.usage ?? {};
				const input = num(u.input);
				const output = num(u.output);
				const cacheRead = num(u.cacheRead);
				const cacheWrite = num(u.cacheWrite);
				const turns = num(u.turns) > 0 ? num(u.turns) : 1;
				const cost = num(u.cost);
				const totalTokens = input + output + cacheRead + cacheWrite;

				const rawModel = typeof r.model === "string" && r.model ? r.model : "unknown";
				const slashIdx = rawModel.indexOf("/");
				const provider = slashIdx > 0 ? rawModel.slice(0, slashIdx) : "subagent";
				const model = slashIdx > 0 ? rawModel.slice(slashIdx + 1) : rawModel;

				events.push({
					id: eventId,
					runId: typeof r.runId === "string" ? r.runId : eventId,
					agent: typeof r.agent === "string" ? r.agent : null,
					model,
					provider,
					timestamp: ts,
					input,
					output,
					cacheRead,
					cacheWrite,
					turns,
					cost,
					totalTokens,
				});
			} catch {
				/* skip */
			}
		}
	} catch {
		/* skip */
	}
	return { stamp, events };
}

function getOrLoadSubagentFile(filePath: string, mtimeMs: number, size: number): CachedSubagentFile {
	const stamp = `${mtimeMs}|${size}`;
	const hit = SUBAGENT_CACHE.get(filePath);
	if (hit && hit.stamp === stamp) {
		return hit;
	}
	const parsed = parseSubagentFile(filePath, stamp);
	if (SUBAGENT_CACHE.size >= CACHE_CAP) SUBAGENT_CACHE.clear();
	SUBAGENT_CACHE.set(filePath, parsed);
	return parsed;
}

/**
 * 汇总指定时间窗口内的 Token 使用统计（主会话 + Subagents 双流聚合）
 */
export function collectTokenStats(opts: CollectTokenStatsOptions = {}): TokenStatsResult {
	const sessionsRoot = opts.sessionsDir ?? DEFAULT_SESSIONS_ROOT;
	// 区分生产环境与隔离测试目录：若 sessionsDir 与 DEFAULT_SESSIONS_ROOT 一致，取默认 getUsageDir()；
	// 若为临时/自定义目录（如单元测试），则在 sessionsDir 同级或子目录寻找，避免污染测试断言
	const isDefaultSessions = !opts.sessionsDir || opts.sessionsDir === DEFAULT_SESSIONS_ROOT || opts.sessionsDir.replace(/\\/g, "/").toLowerCase() === DEFAULT_SESSIONS_ROOT.replace(/\\/g, "/").toLowerCase();
	const usageDir = opts.usageDir ?? (isDefaultSessions ? getUsageDir() : join(opts.sessionsDir!, "subagent-usage"));
	const days = typeof opts.days === "number" && opts.days >= 0 ? opts.days : 30;
	const nowMs = typeof opts.nowMs === "number" ? opts.nowMs : Date.now();

	const now = new Date(nowMs);
	const todayBounds = localDayBounds(now);

	// 计算包含的自然日序列
	const calendarDays: DayBounds[] = [];
	if (days === 1) {
		calendarDays.push(todayBounds);
	} else if (days > 1) {
		for (let i = days - 1; i >= 0; i--) {
			const d = new Date(todayBounds.startMs - i * 86400 * 1000);
			calendarDays.push(localDayBounds(d));
		}
	}

	const windowStartMs = calendarDays.length > 0 ? calendarDays[0].startMs : 0;
	const windowEndMs = todayBounds.endMs;

	// 全局指标
	let totalTokens = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;
	let reasoningTokens = 0;
	let estimatedCostUsd = 0;
	let totalTurns = 0;

	// 今日专属指标（严格归属 todayBounds）
	let todayTotalTokens = 0;
	let todayInputTokens = 0;
	let todayOutputTokens = 0;
	let todayCacheReadTokens = 0;
	let todayTurns = 0;
	let todayCostUsd = 0;

	// 每日聚合 Map（预初始化已选窗口内的日期，保证有 0 占位）
	const dailyMap = new Map<
		string,
		{
			totalTokens: number;
			inputTokens: number;
			outputTokens: number;
			cacheReadTokens: number;
			cacheWriteTokens: number;
			reasoningTokens: number;
			costUsd: number;
			turns: number;
			sessions: Set<string>;
		}
	>();

	for (const day of calendarDays) {
		dailyMap.set(day.label, {
			totalTokens: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
			costUsd: 0,
			turns: 0,
			sessions: new Set<string>(),
		});
	}

	// 24 小时聚合（0..23 时段）
	const hourlyArray: { totalTokens: number; turns: number }[] = Array.from({ length: 24 }, () => ({
		totalTokens: 0,
		turns: 0,
	}));

	// 模型聚合 Map
	const modelMap = new Map<
		string,
		{
			model: string;
			provider: string;
			turns: number;
			totalTokens: number;
			inputTokens: number;
			outputTokens: number;
			cacheReadTokens: number;
			cacheWriteTokens: number;
			costUsd: number;
		}
	>();

	// 会话聚合 Map
	const sessionAggMap = new Map<string, SessionUsageAggregate>();

	// -------------------------------------------------------------
	// 1. 采集 Subagent 用量账本（~/.pi/agent/subagent-usage/<day>.jsonl）
	// -------------------------------------------------------------
	const seenSubagentEvents = new Set<string>();
	const subagentCandidateFiles = new Set<string>();

	if (calendarDays.length > 0) {
		for (const day of calendarDays) {
			subagentCandidateFiles.add(dailyUsagePath(day.label, usageDir));
			for (const utc of overlappingUtcDates(day)) {
				subagentCandidateFiles.add(join(usageDir, `${utc}.jsonl`));
			}
		}
	} else if (existsSync(usageDir)) {
		for (const f of listJsonlFiles(usageDir)) {
			subagentCandidateFiles.add(f);
		}
	}

	for (const filePath of subagentCandidateFiles) {
		if (!existsSync(filePath)) continue;
		let st;
		try {
			st = statSync(filePath);
		} catch {
			continue;
		}

		const cached = getOrLoadSubagentFile(filePath, st.mtimeMs, st.size);
		for (const ev of cached.events) {
			if (ev.timestamp < windowStartMs || ev.timestamp >= windowEndMs) continue;
			if (seenSubagentEvents.has(ev.id)) continue;
			seenSubagentEvents.add(ev.id);

			totalTokens += ev.totalTokens;
			inputTokens += ev.input;
			outputTokens += ev.output;
			cacheReadTokens += ev.cacheRead;
			cacheWriteTokens += ev.cacheWrite;
			estimatedCostUsd += ev.cost;
			totalTurns += ev.turns;

			if (inDay(ev.timestamp, todayBounds)) {
				todayTotalTokens += ev.totalTokens;
				todayInputTokens += ev.input;
				todayOutputTokens += ev.output;
				todayCacheReadTokens += ev.cacheRead;
				todayTurns += ev.turns;
				todayCostUsd += ev.cost;
			}

			const dateLabel = localDayBounds(new Date(ev.timestamp)).label;
			let dayItem = dailyMap.get(dateLabel);
			if (!dayItem) {
				dayItem = {
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					reasoningTokens: 0,
					costUsd: 0,
					turns: 0,
					sessions: new Set<string>(),
				};
				dailyMap.set(dateLabel, dayItem);
			}
			dayItem.totalTokens += ev.totalTokens;
			dayItem.inputTokens += ev.input;
			dayItem.outputTokens += ev.output;
			dayItem.cacheReadTokens += ev.cacheRead;
			dayItem.cacheWriteTokens += ev.cacheWrite;
			dayItem.costUsd += ev.cost;
			dayItem.turns += ev.turns;
			const subagentSessionId = `subagent:${ev.agent ?? "agent"}:${ev.runId}`;
			dayItem.sessions.add(subagentSessionId);

			const hr = new Date(ev.timestamp).getHours();
			if (hr >= 0 && hr < 24) {
				hourlyArray[hr].totalTokens += ev.totalTokens;
				hourlyArray[hr].turns += ev.turns;
			}

			const rawModelKey = modelKey(ev.provider, ev.model);
			let mItem = modelMap.get(rawModelKey);
			if (!mItem) {
				mItem = {
					model: ev.model,
					provider: ev.provider,
					turns: 0,
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					costUsd: 0,
				};
				modelMap.set(rawModelKey, mItem);
			}
			mItem.totalTokens += ev.totalTokens;
			mItem.inputTokens += ev.input;
			mItem.outputTokens += ev.output;
			mItem.cacheReadTokens += ev.cacheRead;
			mItem.cacheWriteTokens += ev.cacheWrite;
			mItem.costUsd += ev.cost;
			mItem.turns += ev.turns;

			let sItem = sessionAggMap.get(subagentSessionId);
			if (!sItem) {
				sItem = {
					sessionId: subagentSessionId,
					title: `[Subagent] ${ev.agent ?? "task"}`,
					cwd: null,
					startedAt: new Date(ev.timestamp).toISOString(),
					lastActiveAt: new Date(ev.timestamp).toISOString(),
					model: ev.model,
					provider: ev.provider,
					turns: 0,
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					reasoningTokens: 0,
					costUsd: 0,
				};
				sessionAggMap.set(subagentSessionId, sItem);
			}
			sItem.totalTokens += ev.totalTokens;
			sItem.inputTokens += ev.input;
			sItem.outputTokens += ev.output;
			sItem.cacheReadTokens += ev.cacheRead;
			sItem.cacheWriteTokens += ev.cacheWrite;
			sItem.costUsd += ev.cost;
			sItem.turns += ev.turns;
			if (ev.timestamp > Date.parse(sItem.lastActiveAt ?? "1970-01-01")) {
				sItem.lastActiveAt = new Date(ev.timestamp).toISOString();
			}
		}
	}

	// -------------------------------------------------------------
	// 2. 采集 Main Sessions 用量（DEFAULT_SESSIONS_ROOT）
	// -------------------------------------------------------------
	const minMtimeMs = windowStartMs > 0 ? windowStartMs - 24 * 3600_000 : 0;

	for (const filePath of listJsonlFiles(sessionsRoot)) {
		let st;
		try {
			st = statSync(filePath);
			if (minMtimeMs > 0 && st.mtimeMs < minMtimeMs) {
				continue;
			}
		} catch {
			continue;
		}

		const sess = getOrLoadSession(filePath, st.mtimeMs, st.size);
		for (const t of sess.turns) {
			if (t.timestamp < windowStartMs || t.timestamp >= windowEndMs) continue;

			totalTokens += t.totalTokens;
			inputTokens += t.input;
			outputTokens += t.output;
			cacheReadTokens += t.cacheRead;
			cacheWriteTokens += t.cacheWrite;
			reasoningTokens += t.reasoning;
			estimatedCostUsd += t.costUsd;
			totalTurns++;

			if (inDay(t.timestamp, todayBounds)) {
				todayTotalTokens += t.totalTokens;
				todayInputTokens += t.input;
				todayOutputTokens += t.output;
				todayCacheReadTokens += t.cacheRead;
				todayTurns++;
				todayCostUsd += t.costUsd;
			}

			const dateLabel = localDayBounds(new Date(t.timestamp)).label;
			let dayItem = dailyMap.get(dateLabel);
			if (!dayItem) {
				dayItem = {
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					reasoningTokens: 0,
					costUsd: 0,
					turns: 0,
					sessions: new Set<string>(),
				};
				dailyMap.set(dateLabel, dayItem);
			}
			dayItem.totalTokens += t.totalTokens;
			dayItem.inputTokens += t.input;
			dayItem.outputTokens += t.output;
			dayItem.cacheReadTokens += t.cacheRead;
			dayItem.cacheWriteTokens += t.cacheWrite;
			dayItem.reasoningTokens += t.reasoning;
			dayItem.costUsd += t.costUsd;
			dayItem.turns++;
			dayItem.sessions.add(sess.sessionId);

			const hr = new Date(t.timestamp).getHours();
			if (hr >= 0 && hr < 24) {
				hourlyArray[hr].totalTokens += t.totalTokens;
				hourlyArray[hr].turns++;
			}

			const rawModelKey = modelKey(t.provider, t.model);
			let mItem = modelMap.get(rawModelKey);
			if (!mItem) {
				mItem = {
					model: t.model,
					provider: t.provider,
					turns: 0,
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					costUsd: 0,
				};
				modelMap.set(rawModelKey, mItem);
			}
			mItem.totalTokens += t.totalTokens;
			mItem.inputTokens += t.input;
			mItem.outputTokens += t.output;
			mItem.cacheReadTokens += t.cacheRead;
			mItem.cacheWriteTokens += t.cacheWrite;
			mItem.costUsd += t.costUsd;
			mItem.turns++;

			let sItem = sessionAggMap.get(sess.sessionId);
			if (!sItem) {
				sItem = {
					sessionId: sess.sessionId,
					title: sess.title,
					cwd: sess.cwd,
					startedAt: sess.startedAt,
					lastActiveAt: new Date(t.timestamp).toISOString(),
					model: t.model,
					provider: t.provider,
					turns: 0,
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					reasoningTokens: 0,
					costUsd: 0,
				};
				sessionAggMap.set(sess.sessionId, sItem);
			}
			sItem.totalTokens += t.totalTokens;
			sItem.inputTokens += t.input;
			sItem.outputTokens += t.output;
			sItem.cacheReadTokens += t.cacheRead;
			sItem.cacheWriteTokens += t.cacheWrite;
			sItem.reasoningTokens += t.reasoning;
			sItem.costUsd += t.costUsd;
			sItem.turns++;
			if (t.timestamp > Date.parse(sItem.lastActiveAt ?? "1970-01-01")) {
				sItem.lastActiveAt = new Date(t.timestamp).toISOString();
				sItem.model = t.model;
				sItem.provider = t.provider;
			}
		}
	}

	// 缓存命中节省率
	let cacheHitRatePercent: number | null = null;
	const totalInputBase = inputTokens + cacheReadTokens;
	if (totalInputBase > 0) {
		cacheHitRatePercent = Number(((cacheReadTokens / totalInputBase) * 100).toFixed(2));
	}

	// 每日数组排序
	const dailyList: DailyUsageAggregate[] = Array.from(dailyMap.entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([date, d]) => ({
			date,
			totalTokens: d.totalTokens,
			inputTokens: d.inputTokens,
			outputTokens: d.outputTokens,
			cacheReadTokens: d.cacheReadTokens,
			cacheWriteTokens: d.cacheWriteTokens,
			reasoningTokens: d.reasoningTokens,
			costUsd: Number(d.costUsd.toFixed(4)),
			turns: d.turns,
			sessionsCount: d.sessions.size,
		}));

	// 模型分布列表（按 tokens 降序）
	const modelList: ModelUsageAggregate[] = Array.from(modelMap.values())
		.sort((a, b) => b.totalTokens - a.totalTokens)
		.map((m) => ({
			...m,
			costUsd: Number(m.costUsd.toFixed(4)),
			percent: totalTokens > 0 ? Number(((m.totalTokens / totalTokens) * 100).toFixed(1)) : 0,
		}));

	// 会话列表（按 tokens 降序）
	const sessionList: SessionUsageAggregate[] = Array.from(sessionAggMap.values())
		.sort((a, b) => b.totalTokens - a.totalTokens)
		.map((s) => ({
			...s,
			costUsd: Number(s.costUsd.toFixed(4)),
		}));

	const summary: TokenStatsSummary = {
		totalTokens,
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		reasoningTokens,
		estimatedCostUsd: Number(estimatedCostUsd.toFixed(4)),
		totalTurns,
		totalSessions: sessionAggMap.size,
		cacheHitRatePercent,
		today: {
			totalTokens: todayTotalTokens,
			inputTokens: todayInputTokens,
			outputTokens: todayOutputTokens,
			cacheReadTokens: todayCacheReadTokens,
			turns: todayTurns,
			costUsd: Number(todayCostUsd.toFixed(4)),
		},
	};

	return {
		version: 1,
		asOf: new Date(nowMs).toISOString(),
		days,
		since: new Date(windowStartMs).toISOString(),
		until: new Date(nowMs).toISOString(),
		summary,
		daily: dailyList,
		hourly: hourlyArray,
		bySession: sessionList,
		byModel: modelList,
	};
}
