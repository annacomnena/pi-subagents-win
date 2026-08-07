/**
 * links — 会话溯源记录（状态 BUS 的"谁唤起谁"日志）
 *
 * 每次派发（launch-tabs / async subagent / set-timer）追加一行到
 * ~/.pi/agent/links.jsonl：{ sessionId, kind, targetId, detail, at }。
 * 记录「哪个会话唤起了哪些任务/对话」，供 /links 查看与编排溯源。
 *
 * 文件即总线：跨进程共享，追加式 JSONL，崩溃安全（每行独立、append 原子）。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export type LinkKind = "tab" | "async" | "timer" | "subagent";

export interface LinkRecord {
	/** 发起会话身份：sessionId（主会话/普通）或 tab_<runId>（标签页）或 "subagent"。 */
	sessionId: string;
	kind: LinkKind;
	/** 被派发对象的 id：tab runId / async runId / timer id。 */
	targetId: string;
	/** 人类可读摘要。 */
	detail: string;
	/** ISO 时间。 */
	at: string;
	/** 发起进程 pid（调试用）。 */
	pid: number;
}

export function defaultLinksPath(agentDir: string = join(homedir(), ".pi", "agent")): string {
	return join(agentDir, "links.jsonl");
}

/**
 * 从扩展上下文推导当前会话身份。
 * 优先 PI_TAB_RUN_ID（标签页）；否则 ctx.sessionManager.sessionId；
 * 都没有 → "unknown"。
 */
export function sessionIdentity(ctx?: { sessionManager?: { sessionId?: string } } | null): string {
	if (process.env.PI_TAB_RUN_ID) return process.env.PI_TAB_RUN_ID;
	const sid = ctx?.sessionManager?.sessionId;
	return sid && sid.length > 0 ? sid : "unknown";
}

/** 追加一条溯源记录（原子 append，失败静默——记录不影响主流程）。 */
export function recordLink(
	link: Omit<LinkRecord, "at" | "pid">,
	opts?: { linksPath?: string; at?: string },
): void {
	try {
		const path = opts?.linksPath ?? defaultLinksPath();
		const dir = path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")));
		if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
		const line: LinkRecord = {
			...link,
			at: opts?.at ?? new Date().toISOString(),
			pid: process.pid,
		};
		appendFileSync(path, JSON.stringify(line) + "\n", "utf8");
	} catch {
		/* 溯源记录失败不阻塞派发 */
	}
}

/** 读取全部溯源记录（按 at 倒序；损坏行跳过）。 */
export function listLinks(linksPath: string = defaultLinksPath()): LinkRecord[] {
	if (!existsSync(linksPath)) return [];
	const out: LinkRecord[] = [];
	for (const line of readFileSync(linksPath, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const rec = JSON.parse(line) as LinkRecord;
			if (rec && typeof rec.sessionId === "string" && rec.targetId) out.push(rec);
		} catch {
			/* skip bad line */
		}
	}
	return out.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
}

/** 按会话分组：sessionId → 该会话派发的任务列表。 */
export function groupLinksBySession(linksPath: string = defaultLinksPath()): Record<string, LinkRecord[]> {
	const groups: Record<string, LinkRecord[]> = {};
	for (const rec of listLinks(linksPath)) {
		(groups[rec.sessionId] ??= []).push(rec);
	}
	return groups;
}
