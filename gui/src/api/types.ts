/**
 * gui/src/api/types.ts — version:1 冻结契约（单文件手抄，拍板 7）。
 *
 * 手抄自 extensions/runtime-host/*（HealthView=server.ts、RuntimeSnapshot=snapshot.ts、
 * AttentionItem=attention.ts、TimelineItem=timeline.ts、CommandFrame=runtime/protocol.ts、
 * Workstream/Task=runtime/objects.ts、ProjectedRun=runtime/projector.ts、
 * RuntimeEnvelope=runtime/envelope.ts）。**不跨 package import server 类型**（bundler
 * resolution + 独立 package，research 风险 5）；version:1 已冻结，server 只做加法时此处
 * 手工同步（加法字段对新客户端可选）。
 */

// ── host 自信息（discovery.ts HostInfo）────────────────────────────

export interface HostInfo {
	instanceId: string;
	pid: number;
	port: number;
	startedAt: string;
	protocolVersion: number;
}

// ── GET /v1/health（server.ts HealthView）──────────────────────────

export interface MasterAttachmentView {
	agentAddress: string;
	sessionId: string;
	generation: number;
	attachedAt: string;
	lastHeartbeatAt: string;
	attemptId: string;
}

export interface HealthView {
	version: 1;
	host: HostInfo;
	master: {
		attachment: MasterAttachmentView | null;
		/** readCutover().enabled 归一 boolean（无 cutover 文件 = false）。 */
		cutover: boolean;
	};
	/** 三态：null=未 attach；true=owner 心跳 <15s；false=stale。 */
	masterOwnerAlive: boolean | null;
	sessionHeartbeats: { sessionId: string; lastActiveAt: string; alive: boolean }[];
	journalTail: { lastEnvelopeAt: string | null; lastRecordedAt: string | null; totalEvents: number };
	mailboxPending: number;
	generatedAt: string;
}

// ── GET /v1/snapshot（snapshot.ts RuntimeSnapshot 子集，字段全保真）──

export interface CutoverStateView {
	enabled: boolean;
	enabledBy: string;
	enabledAt: string;
}

/** snapshot.ts MasterView = MasterStatusView + stale + G5.2 additive（liveness/autoHandoff）。 */
export interface MasterView {
	attachment: MasterAttachmentView | null;
	cutover: CutoverStateView | null;
	snapshot: { sessionId: string; generation: number } | null;
	backlog: { recipient: string; pending: number; claimed: number }[];
	stale: boolean;
	/** G5.2：owner 心跳活压力（owner 会话 agent_end 写手落盘；无心跳 = null）。 */
	liveness: MasterLivenessView | null;
	/** G5.2：config.masterSuccession 归一化切片（auto 开关真实态 + 阈值）。 */
	autoHandoff: MasterAutoHandoffView;
}

/** runtime/liveness.ts MasterLiveness（pressure 0-100 刻度，null = 无有效读数）。 */
export interface MasterLivenessView {
	version: 1;
	sessionId: string;
	generation: number;
	pressure: number | null;
	windowTokens?: number;
	updatedAt: string;
}

/** runtime/master-auto.ts MasterSuccessionConfig 切片。 */
export interface MasterAutoHandoffView {
	enabled: boolean;
	auto: boolean;
	proposalPercent: number;
	autoPercent: number;
}

export type WorkstreamStatus = "active" | "waiting" | "blocked" | "paused" | "completed" | "failed";

export interface WorkstreamRecord {
	version: 1;
	kind: "workstream";
	id: string;
	masterId: string;
	mission: string;
	status: WorkstreamStatus;
	workspaceRef?: string;
	successCriteria?: string;
	taskSelector?: {
		runSubjects?: string[];
		externalTaskIds?: string[];
	};
	wakePolicy?: {
		enabled: boolean;
		cooldownMs: number;
		debounceMs?: number;
		maxSpawns?: number;
	};
	createdAt: string;
	updatedAt: string;
}

export type TaskStatus = "pending" | "running" | "waiting" | "blocked" | "completed" | "failed" | "cancelled";

export interface TaskRecord {
	version: 1;
	kind: "task";
	id: string;
	workstreamId?: string;
	externalTaskId?: string;
	objective: string;
	status: TaskStatus;
	createdAt: string;
	updatedAt: string;
}

export type RunStatus = "created" | "dispatched" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "orphaned";

/** runtime/wake.ts WakeState（snapshot workstreams[].wakeState 直出）。 */
export interface WakeStateView {
	workstreamId: string;
	lastSpawnAt?: string;
	lastTabRunId?: string;
	spawnAt: string[];
	updatedAt: string;
}

/** G5.2：WorkstreamRecord + wakeState + mailboxBacklog（per-ws 未领积压）。 */
export interface WorkstreamView extends WorkstreamRecord {
	wakeState: WakeStateView;
	mailboxBacklog: { pending: number; claimed: number };
}

/** projector.ts ProjectedRun（journal 投影；无 tab-runs phase/waiting 字段——G1 open issue 1）。 */
export interface ProjectedRun {
	subject: string;
	executionKind?: string;
	status: RunStatus;
	externalTaskId?: string;
	mode?: string;
	title?: string;
	cwd?: string;
	requestedModel?: string;
	dispatchedAt?: string;
	finishedAt?: string;
	actualModel?: "unknown";
	summary?: string;
	artifacts?: string[];
	reportPath?: string;
	openIssues?: string[];
	error?: string;
	usage?: Record<string, unknown>;
	/** 投影元数据（源 projector.ts ProjectedRun 尾段；消费只读） */
	lastEventAt?: string;
	lastDedupeKey?: string;
	updatedAt?: string;
}

export interface RuntimeView {
	host: { pid: number; startedAt: string } | null;
	counts: {
		workstreams: number;
		tasks: number;
		runs: number;
		pendingMailbox: number;
	};
	journal: {
		totalEvents: number;
		skippedBadLines: number;
		applied: number;
		skipped: number;
		recent: RuntimeEnvelope[];
	};
}

export interface RuntimeSnapshot {
	version: 1;
	generatedAt: string;
	master: MasterView;
	workstreams: WorkstreamView[];
	tasks: TaskRecord[];
	runs: ProjectedRun[];
	attention: AttentionItem[];
	timeline: TimelineItem[];
	runtime: RuntimeView;
	sectionErrors: string[];
}

// ── GET /v1/attention（attention.ts AttentionItem）─────────────────

export type AttentionSeverity = "critical" | "warning" | "info";
export type AttentionType = "runtime-risk" | "master-handoff" | "escalation" | "question" | "blocked";
export type AttentionStatus = "open" | "resolved";

export interface AttentionItem {
	id: string;
	type: AttentionType;
	severity: AttentionSeverity;
	title: string;
	summary: string;
	source?: string;
	status: AttentionStatus;
	/** v1 恒缺省——GUI 按 type 自造按钮。 */
	actions?: string[];
	createdAt: string;
	/** master-handoff：{proposalId,generation,sessionId,pressure,status,proposedAt,decidedAt?,transferId?}。 */
	payload?: Record<string, unknown>;
}

// ── GET /v1/timeline（timeline.ts TimelineItem）────────────────────

export interface TimelineItem {
	id: string;
	at: string;
	type: string;
	kind: "event" | "state";
	subject?: string;
	/** 人话（server 模板生成，无 raw JSON）——GUI 直接渲染。 */
	summary: string;
	source?: string;
	actor?: string;
}

// ── GET /v1/events（raw 透传 envelope.ts RuntimeEnvelope）──────────

export interface RuntimeEnvelope {
	version: 1;
	id: string;
	kind: "event" | "command" | "message";
	type: string;
	source: string;
	target?: string;
	subject?: string;
	correlationId?: string;
	causationId?: string;
	priority?: number;
	ttlMs?: number;
	payload?: unknown;
	payloadRef?: string;
	recordedAt?: string;
	dedupeKey?: string;
	at: string;
}

export interface EventsResponse {
	version: 1;
	after: string;
	count: number;
	nextCursor: string;
	envelopes: RuntimeEnvelope[];
}

export interface AttentionResponse {
	version: 1;
	count: number;
	attention: AttentionItem[];
}

export interface TimelineResponse {
	version: 1;
	count: number;
	timeline: TimelineItem[];
}

// ── POST /v1/commands（protocol.ts CommandFrame + commands.ts 回执）──

/** master-only 命令的 to（command-executor.ts masterAddress()，钉死全等）。 */
export const MASTER_ADDRESS = "agent://master_default";

/** 客户端可不传 issuedBy——服务端注入 agent://runtime-host（commands.ts 拍板 2）。 */
export interface CommandFrameInput {
	frame: "command";
	type: "workstream.pause" | "workstream.resume" | "master.handoff.accept" | "master.auto-handoff.set" | "master.handoff.prepare";
	to: string;
	issuedBy?: string;
	commandKey: string;
	issuedAt: string;
	payload?: Record<string, unknown>;
}

export type CommandOutcomeBody =
	| { status: "accepted"; summary: string; replayed: boolean }
	| { status: "rejected"; reason: string; detail?: string; replayed: boolean }
	| { status: "failed"; reason: string; error?: string; replayed: boolean };
