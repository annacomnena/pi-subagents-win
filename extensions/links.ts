/**
 * links — 会话溯源记录（状态 BUS 的"谁唤起谁"日志）
 *
 * 每次派发（launch-tabs / async subagent / set-timer）追加一行到
 * ~/.pi/agent/links.jsonl：{ sessionId, kind, targetId, detail, at }。
 * env PI_LINKS_PATH 可整条改道（测试隔离；未设 → 真实路径）。
 * 记录「哪个会话唤起了哪些任务/对话」，供 /links 查看与编排溯源。
 *
 * 文件即总线：跨进程共享，追加式 JSONL，崩溃安全（每行独立、append 原子）。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getTabRunId } from "./identity.ts";

export type LinkKind = "tab" | "async" | "timer" | "subagent";

export interface LinkRecord {
	/** 发起会话身份：sessionId（主会话/普通）或 tab_<runId>（标签页）或 "subagent"。 */
	sessionId: string;
	/**
	 * 直接派发者的 **pi 会话 id**（additive，2026-10-26 右侧栏 P1A）。
	 *
	 * 为什么需要：`sessionId` 在 tab 里只记 `tab_<runId>`（`sessionIdentity()` 优先 PI_TAB_RUN_ID，
	 * 历史口径不动），于是「tab 里派出的 run」无法按 pi 会话归属。本字段把同一个写点上的
	 * `ctx.sessionManager.sessionId` 一并记下，使「tab → pi 会话」成为**写时事实**而不是读时启发式。
	 *
	 * 边界：拿不到就**不写该键**（严禁写 `"unknown"`）；存量记录没有该字段 ⇒ 消费方必须按
	 * `tabUnmapped` 处理，不得事后回填（会话 JSONL 出现 `tab_xxx` 字符串不能当归属证据）。
	 */
	ownerSessionId?: string;
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

export function defaultLinksPath(agentDir?: string): string {
	// 测试隔离（1013）：PI_LINKS_PATH 显式覆盖整条账本路径（同 PI_SUBAGENT_RUNS_DIR 模式）。
	// 生产未设该 env → 原 ~/.pi/agent/links.jsonl 语义逐字节不变；显式传 agentDir 的调用方优先。
	if (agentDir) return join(agentDir, "links.jsonl");
	return process.env.PI_LINKS_PATH ?? join(homedir(), ".pi", "agent", "links.jsonl");
}

/**
 * 从扩展上下文推导当前会话身份。
 * 优先 PI_TAB_RUN_ID（标签页）；否则 ctx.sessionManager.sessionId；
 * 都没有 → "unknown"。
 */
export function sessionIdentity(ctx?: { sessionManager?: { sessionId?: string } } | null): string {
	const tab = getTabRunId();
	if (tab) return tab;
	const sid = ctx?.sessionManager?.sessionId;
	return sid && sid.length > 0 ? sid : "unknown";
}

/**
 * 直接派发者的 pi 会话 id（**只读** `ctx.sessionManager.sessionId`，不看 PI_TAB_RUN_ID）。
 *
 * 与 `sessionIdentity()` 的分工：后者是**记进 `sessionId` 的历史口径**（tab 优先），本函数是
 * 写 `ownerSessionId` 的新口径（pi 会话 UUID）。两者并存 ⇒ 不动 `resolveSessionRun`/`scopedRunIds`
 * 的比较口径（它们仍只比 `sessionId`）。
 *
 * 拿不到（无 ctx / 空串）⇒ `undefined`；调用方**必须**据此省略该键，不得写占位值。
 */
export function ownerSessionIdOf(ctx?: { sessionManager?: { sessionId?: string } } | null): string | undefined {
	const sid = ctx?.sessionManager?.sessionId;
	return typeof sid === "string" && sid.length > 0 ? sid : undefined;
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

/**
 * 带解析统计的读账本（`GET /v1/runs` 的归属元数据需要区分「没有记录」与「账本坏了」）。
 *
 * 契约：文件不存在 ⇒ `{links:[],lines:0,badLines:0}`；**不可读则抛出**（由调用方决定
 * 是否降级为 `attribution:"unavailable"`）。`badLines` = 非空且 JSON 解析失败/形状不合格的行数
 * ——消费方据此判「解析异常率」，而不是把坏行静默当「没有派发」。
 */
export interface LinksReadStats {
	links: LinkRecord[];
	/** 非空行数（分母）。 */
	lines: number;
	/** 非空但解析失败/形状不合格的行数。 */
	badLines: number;
}

export function readLinksWithStats(linksPath: string = defaultLinksPath()): LinksReadStats {
	if (!existsSync(linksPath)) return { links: [], lines: 0, badLines: 0 };
	const out: LinkRecord[] = [];
	let lines = 0;
	let badLines = 0;
	for (const line of readFileSync(linksPath, "utf8").split("\n")) {
		if (!line.trim()) continue;
		lines += 1;
		try {
			const rec = JSON.parse(line) as LinkRecord;
			if (rec && typeof rec.sessionId === "string" && rec.targetId) out.push(rec);
			else badLines += 1;
		} catch {
			badLines += 1;
		}
	}
	return { links: out.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? "")), lines, badLines };
}

/** 读取全部溯源记录（按 at 倒序；损坏行跳过）。 */
export function listLinks(linksPath: string = defaultLinksPath()): LinkRecord[] {
	return readLinksWithStats(linksPath).links;
}

/** 按会话分组：sessionId → 该会话派发的任务列表。 */
export function groupLinksBySession(linksPath: string = defaultLinksPath()): Record<string, LinkRecord[]> {
	const groups: Record<string, LinkRecord[]> = {};
	for (const rec of listLinks(linksPath)) {
		(groups[rec.sessionId] ??= []).push(rec);
	}
	return groups;
}
