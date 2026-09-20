/**
 * hotspot/log — 效果记录（v2 §10 首版：仅必要指标，不记会话正文）
 *
 * 事件写入 ~/.pi/agent/hotspot-logs/<repo-key>.jsonl：kind=inject|tool，
 * 只含主题、版本、动作、结果、时间。试点对照分析用，供人工抽查。
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface HotspotLogEvent {
	at: string;
	kind: "inject" | "tool";
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
