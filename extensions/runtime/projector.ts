/**
 * runtime/projector.ts — Canonical State Projector 纯函数核心（Phase 2，设计稿 §20-23）
 *
 * Journal = 发生过什么（append-only 事实）；Canonical State = 现在是什么（本模块产物）。
 *
 * v1 状态机规则（附记 A2 §75.1.9 / §75.3 冻结）：
 *   1. Run 的 canonical state 只从 run.dispatched 起构建；孤立 terminal 进 pending-inbox
 *      （等配对或标 unpaired）——trace-fusion Run 按此自然排除（§75.3），零特例；
 *   2. terminal 优先：已终态的 Run 不被更晚写入的 dispatched 回退（乱序容错）；
 *   3. dedupeKey 幂等：同键只应用一次（写端 emitRuntimeEventOnce 之外的防御纵深）；
 *   4. 不依赖 at 排序：按 journal 追加顺序依次 apply，排序仅用于展示；
 *   5. v1 只全量 rebuild（§23 允许）：不追增量、不追快照、不做 event sourcing 宗教化。
 *
 * 纯函数、无 IO——replay 等价测试（§22）的基础。
 */

import type { RuntimeEnvelope } from "./envelope.ts";
import type { RuntimeRunStatus } from "./objects.ts";

// ── 投影 record ────────────────────────────────────────────────────

/**
 * 从 tab 事件投影的 Run 当前态（RunRecord 的 tab 投影视图）。
 * 主键是 subject（run://tab/<tabRunId>）——Runtime 自有 run id 到 Phase 3/4 才引入，
 * 不为投影发明第二套身份（附记 A2 §75.1.2 同源原则）。
 */
export interface ProjectedRun {
	/** 主键：run://tab/<tabRunId> */
	subject: string;
	/** 从 dispatch/terminal 事件明示的 executionKind（payload.executionKind，不推导） */
	executionKind?: string;
	status: RuntimeRunStatus;

	externalTaskId?: string;
	mode?: string;
	title?: string;
	cwd?: string;
	requestedModel?: string;

	/** 领域发生时间（at），非写入时间 */
	dispatchedAt?: string;
	finishedAt?: string;
	/** actualModel：observed telemetry，v1 恒 unknown（未采集，附记 A2 §75.1.5） */
	actualModel?: "unknown";

	/** 终态字段（terminal 事件携带） */
	summary?: string;
	artifacts?: string[];
	reportPath?: string;
	openIssues?: string[];
	error?: string;
	usage?: Record<string, unknown>;

	/** 投影元数据 */
	lastEventAt?: string;
	lastDedupeKey?: string;
	updatedAt: string;
}

export type TerminalRunStatus = Extract<RuntimeRunStatus, "completed" | "failed" | "cancelled">;

/** 孤立终态：无 run.dispatched 配对的 terminal 事件（trace lane / 乱序），等待配对或标 unpaired。 */
export interface PendingTerminal {
	subject: string;
	dedupeKey: string;
	type: string;
	at: string;
	/** 当前 v1 恒为 unpaired：无 dispatched 且无法识别 executionKind（75.3.3 显式排除 trace lane）。 */
	reason: "unpaired";
	payloadStatus?: string;
}

export interface ProjectionState {
	runs: Map<string, ProjectedRun>;
	pending: Map<string, PendingTerminal>;
	/** 已应用的 dedupeKey（幂等防御纵深；rebuild 现算，不落盘） */
	seenDedupeKeys: Set<string>;
}

export function emptyProjectionState(): ProjectionState {
	return { runs: new Map(), pending: new Map(), seenDedupeKeys: new Set() };
}

const TERMINAL_STATUSES: readonly string[] = ["completed", "failed", "cancelled"];

function isTerminalStatus(s: RuntimeRunStatus): boolean {
	return TERMINAL_STATUSES.includes(s);
}

// ── payload 形状（adapters/tab-run.ts 的投影侧镜像，结构化但宽松）──

interface DispatchPayload {
	tabRunId?: string;
	executionKind?: string;
	externalTaskId?: string;
	mode?: string;
	title?: string;
	cwd?: string;
	requestedModel?: string;
	dispatchedAt?: string;
}

interface TerminalPayload {
	tabRunId?: string;
	executionKind?: string;
	externalTaskId?: string;
	status?: string;
	summary?: string;
	artifacts?: string[];
	reportPath?: string;
	openIssues?: string[];
	error?: string;
	usage?: Record<string, unknown>;
	finishedAt?: string;
}

// ── 单事件应用（纯函数）──────────────────────────────────────────

/** 应用一个 envelope 到投影状态；返回是否实际改变（dedupe 跳过/终态优先忽略 → false）。 */
export function applyEvent(state: ProjectionState, envelope: RuntimeEnvelope): boolean {
	// 3) dedupeKey 幂等（防御纵深：写端 emitRuntimeEventOnce 已拦一次）
	if (envelope.dedupeKey) {
		if (state.seenDedupeKeys.has(envelope.dedupeKey)) return false;
		state.seenDedupeKeys.add(envelope.dedupeKey);
	}

	const subject = envelope.subject;
	if (!subject) return false;

	switch (envelope.type) {
		case "run.dispatched":
			return applyDispatch(state, envelope);
		case "run.launch_failed":
			// launch_failed = 派发期失败，终态语义为 failed（类型名与状态词表不同构，显式映射）
			return applyTerminal(state, envelope, "failed");
		case "run.completed":
		case "run.failed":
		case "run.cancelled":
			return applyTerminal(state, envelope);
		default:
			// 未知事件类型：记录 dedupe 但不投影（前向兼容，§15 事件族可扩展）
			return false;
	}
}

function applyDispatch(state: ProjectionState, envelope: RuntimeEnvelope): boolean {
	const subject = envelope.subject!;
	const payload = (envelope.payload ?? {}) as DispatchPayload;

	// 2) terminal 优先：已终态的 Run 不回退（乱序：dispatched 写入晚于 terminal）
	const existing = state.runs.get(subject);
	if (existing && isTerminalStatus(existing.status)) return false;

	state.runs.set(subject, {
		subject,
		executionKind: payload.executionKind,
		status: "dispatched",
		externalTaskId: payload.externalTaskId,
		mode: payload.mode,
		title: payload.title,
		cwd: payload.cwd,
		requestedModel: payload.requestedModel,
		actualModel: "unknown",
		dispatchedAt: payload.dispatchedAt ?? envelope.at,
		updatedAt: envelope.at,
	});

	// 1) 孤立终态配对：pending 里有同 subject 的 terminal → 立即补放（rollover 场景）
	const pendingKey = findPendingForSubject(state, subject);
	if (pendingKey) {
		const pendingEvent = state.pending.get(pendingKey)!;
		state.pending.delete(pendingKey);
		return applyTerminal(
			state,
			{ ...envelope, type: pendingEvent.type, subject, at: pendingEvent.at },
			pendingEvent.payloadStatus,
		);
	}
	return true;
}

function applyTerminal(state: ProjectionState, envelope: RuntimeEnvelope, payloadStatus?: string): boolean {
	const subject = envelope.subject!;
	const status = (payloadStatus ?? subjectStatusFromType(envelope.type)) as TerminalRunStatus | undefined;
	if (!status || !TERMINAL_STATUSES.includes(status)) return false;

	const existing = state.runs.get(subject);

	// 1) 孤立终态：无 dispatched 配对 → pending（等 dispatched 到达补放；trace lane 永远留桶）
	if (!existing) {
		state.pending.set(envelope.dedupeKey ?? subject, {
			subject,
			dedupeKey: envelope.dedupeKey ?? subject,
			type: envelope.type,
			at: envelope.at,
			reason: "unpaired",
			payloadStatus,
		});
		return true;
	}

	// 2) terminal 优先：已终态不覆盖（重复终态/乱序）
	if (isTerminalStatus(existing.status)) return false;

	const payload = (envelope.payload ?? {}) as TerminalPayload;
	state.runs.set(subject, {
		...existing,
		executionKind: existing.executionKind ?? payload.executionKind,
		status,
		externalTaskId: existing.externalTaskId ?? payload.externalTaskId,
		summary: payload.summary,
		artifacts: payload.artifacts,
		reportPath: payload.reportPath,
		openIssues: payload.openIssues,
		error: payload.error,
		usage: payload.usage,
		finishedAt: payload.finishedAt ?? envelope.at,
		lastEventAt: envelope.at,
		lastDedupeKey: envelope.dedupeKey,
		updatedAt: envelope.at,
	});
	return true;
}

/** run.completed → completed（launch_failed 已在 dispatch 分支特判）。 */
function subjectStatusFromType(type: string): string | undefined {
	const suffix = type.slice("run.".length);
	return TERMINAL_STATUSES.includes(suffix) ? suffix : undefined;
}

function findPendingForSubject(state: ProjectionState, subject: string): string | undefined {
	for (const [key, p] of state.pending) {
		if (p.subject === subject) return key;
	}
	return undefined;
}

// ── 全量 rebuild（§20：Journal → Canonical State）─────────────────

export interface RebuildResult {
	state: ProjectionState;
	/** 应用的 envelope 数（dedupe 跳过的不计） */
	applied: number;
	/** 跳过数（dedupe 重复 / 未知类型 / subject 缺失） */
	skipped: number;
}

/** 从 envelope 序列（journal 顺序）全量重建 canonical state。 */
export function rebuildFromEnvelopes(envelopes: RuntimeEnvelope[]): RebuildResult {
	const state = emptyProjectionState();
	let applied = 0;
	let skipped = 0;
	for (const env of envelopes) {
		if (applyEvent(state, env)) applied += 1;
		else skipped += 1;
	}
	return { state, applied, skipped };
}
