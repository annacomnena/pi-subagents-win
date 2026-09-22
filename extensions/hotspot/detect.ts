/**
 * hotspot/detect — P0 自动探测（0922 组合计划 §0.4/§1；research §4-§5 两段式）
 *
 * agent_end 规则预筛 → `state/hotspot-pending.jsonl`。**agent_end 只写候选、
 * 永不 commitHotspot**（无 revision 上下文、冲突处理不了、验证失败无人修）。
 * **pending 不进热度、投影不读 pending**（拍板接线点）：pending 是"未验证的
 * 该不该写"信号，与"已有条目排序(热度)""已有条目关联(投影)"正交；pending 唯一
 * 消费点 = before_agent_start"建议 upsert"轻提醒（同主题 7 天重复或累计≥10 升级），
 * 由 agent 手动走现有工具落盘。
 *
 * gauge 永不打断主流程：任何异常静默吞掉；子 agent 进程不注册行为。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isSubagent } from "../identity.ts";
import { dirPrefixes } from "./heat.ts";
import { findRepoRoot, hotspotPath, readHotspot } from "./store.ts";
import { toRepoRelative } from "./usage.ts";
import type { HotspotEntry } from "./types.ts";

const DAY_MS = 86_400_000;

/** 改动路径白名单：只认这类工具（read/bash/hotspot 等一律不记）。 */
export const DETECT_TOOL_WHITELIST = new Set(["edit", "write", "apply"]);

/** 拍板门槛（research §5，试点初值，2 周后按 precision 校准）。 */
export const PENDING_SCORE_THRESHOLD = 6; // ≥6 落 pending
export const PENDING_RECUR_DAYS = 7; // 同主题 7 天内…
export const PENDING_RECUR_COUNT = 2; // …出现 ≥2 次 → 升级"建议 upsert"
export const PENDING_CUMULATIVE_SCORE = 10; // 或累计 ≥10 分 → 升级

export interface PendingRecord {
	at: string;
	topics: string[];
	score: number;
	signals: string[];
	paths: string[];
}

export function pendingPath(root: string): string {
	return join(root, "state", "hotspot-pending.jsonl");
}

/** 读 pending 队列；坏行跳过、文件缺失 → 空数组。 */
export function readPending(root: string): PendingRecord[] {
	let raw: string;
	try {
		raw = readFileSync(pendingPath(root), "utf8");
	} catch {
		return [];
	}
	const out: PendingRecord[] = [];
	for (const line of raw.split(/\r?\n/)) {
		const t = line.trim();
		if (!t) continue;
		try {
			const r = JSON.parse(t) as PendingRecord;
			if (Array.isArray(r.topics) && typeof r.score === "number" && typeof r.at === "string") out.push(r);
		} catch {
			continue;
		}
	}
	return out;
}

/** 追加一条 pending 候选；失败静默（返回 null，不阻塞 turn）。 */
export function appendPending(root: string, rec: PendingRecord): string | null {
	try {
		const p = pendingPath(root);
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, `${JSON.stringify(rec)}\n`, { flag: "a" });
		return p;
	} catch {
		return null;
	}
}

export interface ScoredEntry {
	topicId: string;
	score: number;
	signals: string[];
}

/** 单主题打分（纯函数，research §5 拍板分值）：
 *  S1 改动文件精确命中主题路由路径 +5/文件；
 *  S2 改动文件命中主题目录前缀 +2/文件（每文件每主题至多一次）；
 *  S4 跨会话重复主题（近 7 天 pending 同主题 ≥2 次，或同目录被 ≥2 个 turn 触及）+4。 */
export function scoreEntry(
	entry: HotspotEntry,
	changedPaths: string[],
	prior: PendingRecord[],
	now: number,
): ScoredEntry {
	const paths = [...entry.wiki.map((w) => w.path), ...entry.evidence.map((e) => e.path), ...entry.symbols.map((s) => s.path)];
	const prefixes = new Set<string>();
	for (const p of paths) for (const pre of dirPrefixes(p)) prefixes.add(pre);

	let s1 = 0;
	let s2 = 0;
	for (const cp of changedPaths) {
		if (paths.includes(cp)) s1++;
		else if ([...prefixes].some((pre) => cp.startsWith(pre))) s2++;
	}

	let score = 0;
	const signals: string[] = [];
	if (s1 > 0) {
		score += s1 * 5;
		signals.push(`S1 精确命中×${s1}`);
	}
	if (s2 > 0) {
		score += s2 * 2;
		signals.push(`S2 目录命中×${s2}`);
	}
	// S4：近 7 天 pending 中与本主题相关（同主题 或 同目录）的记录
	const cutoff = now - PENDING_RECUR_DAYS * DAY_MS;
	const related = prior.filter((r) => {
		const at = Date.parse(r.at);
		if (!Number.isFinite(at) || at < cutoff) return false;
		if (r.topics.includes(entry.topicId)) return true;
		return (r.paths ?? []).some((rp) => prefixes.has(rp) || [...prefixes].some((pre) => rp.startsWith(pre)));
	});
	const turns = new Set(related.map((r) => r.at));
	if (related.filter((r) => r.topics.includes(entry.topicId)).length >= PENDING_RECUR_COUNT) {
		score += 4;
		signals.push(`S4 重复主题（7 天 ${related.length} 次）`);
	} else if (turns.size >= 2) {
		score += 4;
		signals.push(`S4 同目录多 turn（${turns.size} turns）`);
	}
	return { topicId: entry.topicId, score, signals };
}

/** 全主题打分（纯函数）。 */
export function scoreEntries(entries: HotspotEntry[], changedPaths: string[], prior: PendingRecord[], now: number): ScoredEntry[] {
	return entries.map((e) => scoreEntry(e, changedPaths, prior, now));
}

/** agent_end 核心：评分 → 过门槛 → 追加 pending。返回本次写入的记录（测试用）。
 *  热点文件缺失/无法解析/无条目 → 空数组（放弃，绝不写热点文件）。 */
export function detectAndAppend(root: string, changedPaths: string[], now = Date.now()): PendingRecord[] {
	if (changedPaths.length === 0) return [];
	const read = readHotspot(hotspotPath(root));
	if (!read.exists || !read.file || read.file.entries.length === 0) return [];
	const prior = readPending(root);
	const out: PendingRecord[] = [];
	const at = new Date(now).toISOString();
	for (const s of scoreEntries(read.file.entries, changedPaths, prior, now)) {
		if (s.score < PENDING_SCORE_THRESHOLD) continue;
		const rec: PendingRecord = { at, topics: [s.topicId], score: s.score, signals: s.signals, paths: changedPaths };
		if (appendPending(root, rec)) out.push(rec);
	}
	return out;
}

export interface Escalation {
	topicId: string;
	count7d: number;
	totalScore7d: number;
}

/** "建议 upsert"升级条件：同主题近 7 天出现 ≥2 次 或 累计 ≥10 分（按累计分降序）。 */
export function escalatedTopics(prior: PendingRecord[], now: number): Escalation[] {
	const cutoff = now - PENDING_RECUR_DAYS * DAY_MS;
	const byTopic = new Map<string, { count: number; score: number }>();
	for (const r of prior) {
		const at = Date.parse(r.at);
		if (!Number.isFinite(at) || at < cutoff) continue;
		for (const t of r.topics) {
			const acc = byTopic.get(t) ?? { count: 0, score: 0 };
			acc.count++;
			acc.score += r.score;
			byTopic.set(t, acc);
		}
	}
	const out: Escalation[] = [];
	for (const [topicId, { count, score }] of byTopic) {
		if (count >= PENDING_RECUR_COUNT || score >= PENDING_CUMULATIVE_SCORE) out.push({ topicId, count7d: count, totalScore7d: score });
	}
	return out.sort((a, b) => b.totalScore7d - a.totalScore7d);
}

/** 注册 P0 自动探测（主会话/标签页会话；子 agent 进程跳过）。 */
export function registerHotspotDetection(pi: ExtensionAPI): void {
	// session 级改动路径累加器（内存 Map；agent_end 消费后清空；跨重启丢失可接受——热信号本就时效性）。
	// end 事件没有 args，故 start 暂存候选 path，只有 end 成功才计为实际改动；避免失败 edit/write 制造 pending。
	const changed = new Map<string, number>();
	const pendingPaths = new Map<string, string>();
	const PENDING_PATH_LIMIT = 1024;

	pi.on("tool_execution_start", (event) => {
		try {
			if (isSubagent() || !DETECT_TOOL_WHITELIST.has(event.toolName)) return;
			const args = (event.args ?? {}) as Record<string, unknown>;
			const p = typeof args.path === "string" ? args.path : null;
			if (!p) return;
			const root = findRepoRoot(process.cwd());
			const rel = toRepoRelative(p, root);
			if (!rel) return;
			pendingPaths.set(event.toolCallId, rel);
			if (pendingPaths.size > PENDING_PATH_LIMIT) {
				const first = pendingPaths.keys().next().value;
				if (first !== undefined) pendingPaths.delete(first);
			}
		} catch {
			/* 静默 */
		}
	});

	pi.on("tool_execution_end", (event) => {
		try {
			const rel = pendingPaths.get(event.toolCallId);
			pendingPaths.delete(event.toolCallId);
			if (isSubagent() || event.isError || !rel || !DETECT_TOOL_WHITELIST.has(event.toolName)) return;
			changed.set(rel, (changed.get(rel) ?? 0) + 1);
		} catch {
			/* 静默 */
		}
	});

	// agent_end：规则预筛 → pending（永不 commitHotspot；失败即弃，不阻塞 turn）
	pi.on("agent_end", (_event, ctx) => {
		try {
			if (isSubagent()) return;
			if (changed.size === 0) return;
			const paths = [...changed.keys()];
			changed.clear();
			const root = findRepoRoot(ctx.cwd);
			detectAndAppend(root, paths);
		} catch {
			/* gauge 永不打断主流程 */
		}
	});

	// before_agent_start：pending 达升级条件 → 一句轻提醒（仿 scope wake-pending），否则零注入
	pi.on("before_agent_start", async (_event, ctx) => {
		try {
			if (isSubagent()) return;
			const root = findRepoRoot(ctx.cwd);
			const esc = escalatedTopics(readPending(root), Date.now());
			if (esc.length === 0) return;
			const lines = esc.slice(0, 3).map((e) => `- ${e.topicId}: 7 天累计 ${e.totalScore7d} 分 / ${e.count7d} 次`);
			return {
				message: {
					customType: "hotspot-pending-reminder",
					content: `热点探测建议（P0 pending 升级）：以下主题可能值得更新路由，若仍活跃请 hotspot read 后 upsert：\n${lines.join("\n")}`,
					display: false,
				},
			};
		} catch {
			return;
		}
	});
}
