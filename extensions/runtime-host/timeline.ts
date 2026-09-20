/**
 * runtime-host/timeline.ts — G3：Timeline 投影（总计划 §36；plans/0920_G3_attention_plan.md §3）
 *
 * 纯函数 `buildTimelineItems`：统一数组（`kind` 区分）三类条目：
 *   1. **事件条目**：journal 全事件（19 型），`at`（领域发生时间，envelope.ts terra 裁决 #10）
 *      为排序基准；`id` = envelope id。
 *   2. **状态条目**：状态机快照派生——pending/accepted/transferring proposal →
 *      `state:handoff:<proposalId>`；status ∈ {blocked, waiting} workstream →
 *      `state:ws:<wsId>`。`state:` 前缀保证与事件 id 不撞、跨请求稳定。
 *   3. **溯源 enrichment（best-effort，缺席静默降级）**：`run.dispatched` 用
 *      readWakeState 反查 lastTabRunId==subject → summary 附 "（ws <id> woke）"（§36 示例形态）；
 *      listLinks 反查 targetId==subject → `actor` 附派发方 sessionId。
 *
 * 人话模板（§36 纪律：直接消费 Runtime Journal + view normalization，**不显示 raw JSON**）：
 *   handoff 8 + run 5 精修；其余类型（session-lifecycle 等）通用兜底（type + subject + at）。
 *   master 生命周期精修归 §34（G5）。payload 只取展示字段。
 *
 * 分页（G3 拍板② + G5.2 additive）：`limit`（默认 200，**at 升序尾部 N 条**）+
 *   `before=<id>`（G5.2 历史翻页：排他上界——只返回全序中严格早于该条目的更旧条目；
 *   id 找不到 → 返回 [] 作为翻页终止信号）。G2 `after=` 服务增量 diff 消费，timeline
 *   是 GUI 首屏全量 + 轮询 + 「加载更早」按需翻页。
 *
 * 纪律（G1/G2 同款）：全路径注入（stateDir/journalPath/linksPath），可单测；每源独立
 *   try/catch 段级降级，**never-throw**；纯读、零写盘、无 Pi API。`listLinks`（../links.ts）
 *   是唯一 runtime 目录外依赖——纯读 JSONL，§28「GUI 不直读、Host 投影读」合规。
 *
 * 形状用 type 别名（非 interface）：保持可赋值 snapshot.ts 的 `Record<string, unknown>`
 *   占位类型（主会话拍板③：snapshot.ts 只做加法、不收紧已有类型）。
 */

import { join } from "node:path";
import { defaultLinksPath, listLinks, type LinkRecord } from "../links.ts";
import { masterAddress, workstreamAddress } from "../runtime/address.ts";
import { defaultJournalPath, defaultRuntimeDir, listRuntimeEnvelopes, type RuntimeEnvelope } from "../runtime/journal.ts";
import { readProposal } from "../runtime/master-succession.ts";
import { readWakeState } from "../runtime/wake.ts";
import { listWorkstreams, type WorkstreamRecord } from "../runtime/workstreams.ts";

// ── 契约 ───────────────────────────────────────────────────────────

export type TimelineItem = {
	id: string;
	/** 排序基准：envelope.at（领域发生时间）/ 状态条目的源时间。 */
	at: string;
	/** 事件 = envelope type；状态条目 = "master-handoff" / "workstream"。 */
	type: string;
	kind: "event" | "state";
	subject?: string;
	/** 人话（模板生成，无 raw JSON）。 */
	summary: string;
	/** 事件 = envelope.source（agent 地址原样）。 */
	source?: string;
	/** best-effort 派发溯源：links.jsonl 按 targetId 反查的派发方 sessionId。 */
	actor?: string;
};

export interface TimelineOptions {
	stateDir?: string;
	journalPath?: string;
	/** 缺省 defaultLinksPath()（~/.pi/agent/links.jsonl，runtime 目录外纯读）。 */
	linksPath?: string;
	/** 尾部 N 条（at 升序）；默认 200；非法值回退默认；上限 10000（防大 journal 一次回爆）。 */
	limit?: number;
	/**
	 * G5.2 历史翻页：排他上界（排序全序中该 id 位置的严格前缀）。空串/undefined = 不启用；
	 * id 不在集内（缺失/越界）→ 返回 []（客户端据此停用「加载更早」）。
	 */
	before?: string;
}

export const TIMELINE_DEFAULT_LIMIT = 200;
export const TIMELINE_LIMIT_MAX = 10000;

// ── 人话模板（payload 只取展示字段；非法 payload 一律兜底，不炸）────

function str(v: unknown): string | undefined {
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** `run://tab/<tabRunId>` / `run://subagent/<runId>` → 物理 id（enrichment 反查键）。 */
function runIdFromSubject(subject: string | undefined): string | undefined {
	if (!subject) return undefined;
	const m = subject.match(/^run:\/\/(?:tab|subagent)\/(.+)$/);
	return m ? m[1] : undefined;
}

/** run.* 5 型精修（plan §3：run 5 精修；payload 字段缺席时逐段兜底）。 */
function describeRun(type: string, e: RuntimeEnvelope): string {
	const p = (e.payload ?? {}) as Record<string, unknown>;
	const id = runIdFromSubject(e.subject) ?? str(e.subject) ?? "?";
	switch (type) {
		case "run.dispatched": {
			const task = str(p.externalTaskId);
			return `Run ${id} dispatched${task ? ` (task ${task})` : ""}`;
		}
		case "run.completed": {
			const s = str(p.summary);
			return s ? `Run ${id} completed：${s}` : `Run ${id} completed`;
		}
		case "run.failed":
			return `Run ${id} failed：${str(p.error) ?? str(p.summary) ?? "unknown"}`;
		case "run.cancelled":
			return `Run ${id} cancelled`;
		case "run.launch_failed":
			return `Run ${id} launch failed：${str(p.error) ?? "unknown"}`;
		default:
			return `${type}${e.subject ? ` ${e.subject}` : ""}`;
	}
}

/** master.handoff.* 8 型精修（transfer 事件 payload = {transferId, fromSession, fromGeneration, status}；
 *  proposed/accepted = {proposalId, generation, pressure, status}；auto_failed = {transferId, fromGeneration, status}）。 */
function describeHandoff(type: string, e: RuntimeEnvelope): string {
	const p = (e.payload ?? {}) as Record<string, unknown>;
	const t = str(p.transferId);
	const prop = str(p.proposalId);
	const gen = p.fromGeneration ?? p.generation;
	const genS = typeof gen === "number" ? ` (gen ${gen})` : "";
	switch (type) {
		case "master.handoff.proposed": {
			const pct = typeof p.pressure === "number" ? Math.round(p.pressure * 100) : "?";
			return `Handoff proposed at ${pct}%${genS}${prop ? `, proposal ${prop}` : ""}`;
		}
		case "master.handoff.accepted":
			return `Handoff accepted${prop ? ` (proposal ${prop})` : ""}${genS}`;
		case "master.handoff.started":
			return `Handoff started${t ? ` (transfer ${t})` : ""}${genS}`;
		case "master.handoff.spawned":
			return `Handoff successor spawned${t ? ` (transfer ${t})` : ""}`;
		case "master.handoff.attached":
			return `Handoff attached${t ? ` (transfer ${t})` : ""}${genS}`;
		case "master.handoff.completed":
			return `Handoff completed${t ? ` (transfer ${t})` : ""}`;
		case "master.handoff.failed":
			return `Handoff failed${t ? ` (transfer ${t})` : ""}`;
		case "master.handoff.auto_failed":
			return `Auto handoff failed${t ? ` (transfer ${t})` : ""}${genS}`;
		default:
			return `${type}${e.subject ? ` ${e.subject}` : ""}`;
	}
}

/** 事件条目：id=evt id、at=领域时间、source 原样；非精修类型走通用兜底（type + subject + at）。 */
function describeEvent(e: RuntimeEnvelope): TimelineItem {
	let summary: string;
	if (e.type.startsWith("run.")) summary = describeRun(e.type, e);
	else if (e.type.startsWith("master.handoff.")) summary = describeHandoff(e.type, e);
	else summary = `${e.type}${e.subject ? ` ${e.subject}` : ""} @ ${e.at}`;
	return {
		id: e.id,
		at: e.at,
		type: e.type,
		kind: "event",
		subject: e.subject,
		summary,
		source: e.source,
	};
}

// ── 内部 ──────────────────────────────────────────────────────────

type TItem = TimelineItem & { seq: number };

function normalizeLimit(limit: number | undefined): number {
	if (limit !== undefined && Number.isInteger(limit) && limit >= 1) {
		return Math.min(limit, TIMELINE_LIMIT_MAX);
	}
	return TIMELINE_DEFAULT_LIMIT;
}

/** run.dispatched 溯源 enrichment（best-effort：links/wake-state 缺席或读失败 → 原样不附，静默降级）。 */
function enrichRunDispatched(items: TItem[], stateDir: string, linksPath: string): void {
	let links: LinkRecord[] = [];
	try {
		links = listLinks(linksPath);
	} catch {
		links = [];
	}
	const linkByTarget = new Map<string, LinkRecord>();
	for (const l of links) {
		if (!linkByTarget.has(l.targetId)) linkByTarget.set(l.targetId, l);
	}
	let workstreams: WorkstreamRecord[] = [];
	try {
		workstreams = listWorkstreams(stateDir);
	} catch {
		workstreams = [];
	}
	for (const it of items) {
		if (it.kind !== "event" || it.type !== "run.dispatched") continue;
		const rid = runIdFromSubject(it.subject);
		if (!rid) continue;
		try {
			const link = linkByTarget.get(rid);
			if (link && link.sessionId !== "unknown") it.actor = link.sessionId;
			if (it.subject?.startsWith("run://tab/")) {
				for (const ws of workstreams) {
					const wake = readWakeState(ws.id, stateDir); // tolerant：缺失 → 默认态（lastTabRunId 无）
					if (wake.lastTabRunId === rid) {
						it.summary = `${it.summary}（ws ${ws.id} woke）`;
						break;
					}
				}
			}
		} catch {
			/* 单条 enrichment 失败：静默降级（summary/actor 保持原样） */
		}
	}
}

// ── 入口（纯函数，永不 throw）─────────────────────────────────────

export function buildTimelineItems(opts: TimelineOptions = {}): TimelineItem[] {
	const stateDir = opts.stateDir ?? join(defaultRuntimeDir(), "state");
	const journalPath = opts.journalPath ?? defaultJournalPath();
	const linksPath = opts.linksPath ?? defaultLinksPath();
	const limit = normalizeLimit(opts.limit);

	const items: TItem[] = [];

	// 1) 事件条目：journal 全事件（tolerant：坏行跳过、文件保持原样；缺失 → 0 条）
	try {
		const { envelopes } = listRuntimeEnvelopes({ path: journalPath });
		envelopes.forEach((e, seq) => {
			items.push({ ...describeEvent(e), seq });
		});
	} catch {
		/* 段降级：事件条目缺席（never-throw） */
	}

	// 2) 状态条目：状态机快照（state: 前缀 id 与事件不撞、跨请求稳定）
	try {
		const p = readProposal(stateDir);
		if (p && (p.status === "pending" || p.status === "accepted" || p.status === "transferring")) {
			items.push({
				id: `state:handoff:${p.proposalId}`,
				at: p.proposedAt,
				type: "master-handoff",
				kind: "state",
				subject: masterAddress(),
				summary: `handoff ${p.status}`,
				seq: 0,
			});
		}
	} catch {
		/* 段降级 */
	}
	try {
		for (const ws of listWorkstreams(stateDir)) {
			if (ws.status !== "blocked" && ws.status !== "waiting") continue;
			items.push({
				id: `state:ws:${ws.id}`,
				at: ws.updatedAt,
				type: "workstream",
				kind: "state",
				subject: workstreamAddress(ws.id),
				summary: `ws ${ws.id} ${ws.status}`,
				seq: 0,
			});
		}
	} catch {
		/* 段降级 */
	}

	// 3) 溯源 enrichment（best-effort；内部全部 try/catch，缺席静默降级）
	enrichRunDispatched(items, stateDir, linksPath);

	// at 升序（同刻：journal 原序 seq，再 id 确定性）+ before 排他上界前缀 + 尾部 N 条
	items.sort((a, b) => a.at.localeCompare(b.at) || a.seq - b.seq || a.id.localeCompare(b.id));
	let windowed = items;
	if (opts.before !== undefined && opts.before !== "") {
		const idx = windowed.findIndex((it) => it.id === opts.before);
		if (idx < 0) return []; // 翻页终止信号：id 不在集内
		windowed = windowed.slice(0, idx);
	}
	return windowed.slice(-limit).map(({ seq: _drop, ...it }) => it);
}
