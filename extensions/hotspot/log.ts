/**
 * hotspot/log — 效果记录（v2 §10 首版：仅必要指标，不记会话正文）
 *
 * 事件写入 ~/.pi/agent/hotspot-logs/<repo-key>.jsonl：kind=inject|tool|used，
 * 只含主题、版本、动作、结果、时间。试点对照分析用，供人工抽查。
 * used：独立外部工具调用命中热点条目路径/符号时记一条（held-out 门控见 usage.ts）；
 * used 只进热度不进存储（零存储零腐烂）。
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface HotspotLogEvent {
	at: string;
	kind: "inject" | "tool" | "used";
	topics?: string[];
	topic?: string | null;
	action?: string;
	revision?: number;
	ok?: boolean;
	reason?: string;
}

function logDir(): string {
	return join(homedir(), ".pi", "agent", "hotspot-logs");
}

function repoKey(root: string): string {
	return createHash("sha1").update(root.replace(/[\\/]+/g, "/")).digest("hex").slice(0, 12);
}

/** 追加事件；失败静默（日志不得阻断主流程）。 */
export function logEvent(root: string, event: Omit<HotspotLogEvent, "at">): void {
	try {
		const dir = logDir();
		mkdirSync(dir, { recursive: true });
		const line: HotspotLogEvent = { at: new Date().toISOString(), ...event };
		writeFileSync(join(dir, `${repoKey(root)}.jsonl`), `${JSON.stringify(line)}\n`, { flag: "a" });
	} catch {
		/* 静默 */
	}
}

export function logPath(root: string): string {
	return join(logDir(), `${repoKey(root)}.jsonl`);
}

const DAY_MS = 86_400_000;

/** 近 14 天 `kind=used` 计数：topicId → 次数（只含 >0 的主题）。
 *  读失败/无文件 → 空 Map（使用率缺信号，不阻断热度计算）。 */
export function usedCount14d(root: string, now = Date.now()): Map<string, number> {
	const out = new Map<string, number>();
	const p = logPath(root);
	let raw: string;
	try {
		raw = readFileSync(p, "utf8");
	} catch {
		return out;
	}
	const cutoff = now - 14 * DAY_MS;
	for (const line of raw.split(/\r?\n/)) {
		const t = line.trim();
		if (!t) continue;
		let ev: HotspotLogEvent;
		try {
			ev = JSON.parse(t) as HotspotLogEvent;
		} catch {
			continue; // 坏行跳过（日志只增不改，损坏行不影响其余计数）
		}
		if (ev.kind !== "used" || typeof ev.topic !== "string" || !ev.topic) continue;
		const at = Date.parse(ev.at);
		if (!Number.isFinite(at) || at < cutoff) continue;
		out.set(ev.topic, (out.get(ev.topic) ?? 0) + 1);
	}
	return out;
}
