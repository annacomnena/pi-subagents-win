/**
 * hotspot/log — 效果日志（v4 §15 指标；计划 §A）
 *
 * <agentDir>/hotspot/<wsid>/log.jsonl：只记 `kind=inject` 门控决策（含拒绝原因）
 * 与 `kind=lookup`（视图/limit）。不记会话正文；失败静默（日志不得阻断主流程）。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { nowIso } from "./types.ts";

export type HotspotLogKind = "inject" | "lookup";

export interface HotspotLogEvent {
	at: string;
	kind: HotspotLogKind;
	/** inject：是否注入 / lookup：恒 true */
	ok?: boolean;
	gate?: "task" | "path";
	files?: number;
	/** 拒绝原因 / lookup 回退标注 */
	reason?: string;
	view?: string;
	limit?: number;
}

/** 追加事件；失败静默。 */
export function logHotspotEvent(logPath: string, event: Omit<HotspotLogEvent, "at">): void {
	try {
		mkdirSync(dirname(logPath), { recursive: true });
		writeFileSync(logPath, `${JSON.stringify({ at: nowIso(), ...event })}\n`, { flag: "a" });
	} catch {
		/* 静默 */
	}
}

/** 读日志（坏行跳过）；测试/审计用。 */
export function readHotspotLog(logPath: string): HotspotLogEvent[] {
	let raw: string;
	try {
		raw = readFileSync(logPath, "utf8");
	} catch {
		return [];
	}
	const out: HotspotLogEvent[] = [];
	for (const line of raw.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try {
			const ev = JSON.parse(t) as HotspotLogEvent;
			if (ev && (ev.kind === "inject" || ev.kind === "lookup")) out.push(ev);
		} catch {
			continue;
		}
	}
	return out;
}
