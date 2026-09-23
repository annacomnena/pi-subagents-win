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

// ── G6-P3：GET /v1/interactions（runtime-host/interactions.ts 手抄）──

/** 可选 response 语义（ZCode option.response 思想）：仅当既有确定性命令可决时给出；UI 只渲染按钮。 */
export interface InteractionResponse {
	/** G4 executor 白名单命令（唯一命令入口 POST /v1/commands）。 */
	command: string;
	args?: Record<string, unknown>;
}

/** 待决策交互项 = open attention 条目的直投（kind 沿用 attention 词表；不新增审批类型）。 */
export interface InteractionItem {
	id: string;
	kind: "runtime-risk" | "master-handoff" | "escalation" | "question" | "blocked";
	severity: AttentionSeverity;
	createdAt: string;
	title: string;
	summary: string;
	payload?: Record<string, unknown>;
	/** 仅 pending handoff 提案携带（{command:"master.handoff.accept"}）；§29 决策走既有命令。 */
	response?: InteractionResponse;
}

export interface InteractionsResponse {
	version: 1;
	count: number;
	interactions: InteractionItem[];
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
	type:
		| "workstream.pause"
		| "workstream.resume"
		| "master.handoff.accept"
		| "master.auto-handoff.set"
		| "master.handoff.prepare"
		| "session.message";
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

// ── G6-P1：GET /v1/sessions + /v1/sessions/:id/transcript（runtime/transcript.ts 手抄）──

/** runtime/transcript.ts SessionSummary + G6-P2 L4 服务端权威 Master 标识（与 executor 护栏同源；
 *  GUI 不再拿 health 心跳自猜）。 */
export interface SessionSummary {
	sessionId: string;
	cwd: string | null;
	startedAt: string | null;
	parentSession: string | null;
	file: string;
	sizeBytes: number;
	mtimeMs: number;
	/** 服务端权威：该会话是当前 master attachment 会话（POST 会 403 master-session-protected）。 */
	masterProtected?: true;
	/** 服务端权威：该会话是全局 master attachment 会话（列表顶部「置顶」区数据源；与 masterProtected 同源）。 */
	isMaster?: true;
	/** 服务端权威：该会话是某仓库的本地 master（scope master）——组内置顶行数据源（盾标旁「置顶」徽标）。 */
	isScopeMaster?: true;
	/** 列表标题（服务端解析链产物；缺省 = 旧 server，GUI 回退 shortId）。 */
	title?: string;
	/** 标题来源：ledger 台账 | first-user 首条用户消息剥前缀 | id 会话 id 兜底（GUI 灰显 shortId）。 */
	titleSource?: "ledger" | "first-user" | "id";
}

export interface SessionsBody {
	version: 1;
	count: number;
	sessions: SessionSummary[];
	/** 服务端权威受保护会话 id（null = 无 attachment；GUI 禁输入标识以条目 flag 为准）。 */
	masterProtectedSessionId: string | null;
}

/** 5 种自包含行（turn = 行上标签非容器；渲染任一行不需读别的行）。 */
export type TranscriptRow =
	| { kind: "turnHeader"; rowId: string; turnIndex: number; startedAt: string; durationMs?: number }
	| { kind: "userInput"; rowId: string; turnIndex: number; at: string; text: string }
	| { kind: "assistantText"; rowId: string; turnIndex: number; at: string; text: string; model?: string; provider?: string }
	| { kind: "reasoning"; rowId: string; turnIndex: number; at: string; text: string; model?: string; provider?: string }
	| {
			kind: "toolCall";
			rowId: string;
			turnIndex: number;
			at: string;
			callId: string;
			name: string;
			arguments: unknown;
			status: "running" | "done" | "error";
			output?: string;
			model?: string;
			provider?: string;
	  };

/** 5 操作封闭集（P1 发射面 = appended/upserted/state.updated；delta/removed 定义留后续）。 */
export type TranscriptOp =
	| { kind: "row.appended"; row: TranscriptRow }
	| { kind: "row.delta"; rowId: string; path: string; append: string }
	| { kind: "row.upserted"; row: TranscriptRow }
	| { kind: "row.removed"; rowId: string }
	| { kind: "state.updated"; patch: Record<string, unknown> };

export interface TranscriptHead {
	seq: number;
	logEpoch: string;
	/** 持久流代际（G6-P1 L4）：同首行重写/轮转 → 服务端 bump；重订阅带旧 gen → snapshot。 */
	gen?: number;
}

export interface TranscriptBody {
	version: 1;
	sessionId: string;
	mode: "snapshot" | "delta";
	head: TranscriptHead | null;
	count: number;
	rows: TranscriptRow[];
	skippedUnknown: number;
	name: string | null;
}

// ── G6-P1：WS /v1/events/stream 帧契约（runtime-host/ws.ts 手抄）──

export interface StreamSubscribeMsg {
	type: "subscribe";
	topic: string;
	base?: { seq?: number; logEpoch?: string; gen?: number };
}

export type StreamServerFrame =
	| { type: "ack"; topic: string; mode: "resume" | "snapshot"; head: TranscriptHead | null }
	| { type: "event"; topic: string; seq: number; envelope?: unknown; op?: TranscriptOp }
	| { type: "resync"; topic: string; head: null }
	| { type: "error"; topic: string | null; message: string };

// ── G6-P2：session.message 两段回执（runtime/message-outbox.ts + journal 事件 payload 手抄）──

/** 会话页发送状态（POST accepted → pending；WS outbox 事件推进终态；expired = TTL 过期）。 */
export interface ChatOutboxEntry {
	commandKey: string;
	sessionId: string;
	text: string;
	/** sending=POST 在途；pending=已入 outbox 等桥注入；delivered/failed/expired=终态；rejected=HTTP 拒绝。 */
	status: "sending" | "pending" | "delivered" | "failed" | "expired" | "rejected";
	/** rejected/failed/expired 的补充（HTTP reason / 桥 error / TTL 说明）。 */
	detail?: string;
	at: string;
}

/** outbox 主题 journal 事件 payload（message.queued/delivered/failed 手抄）。 */
export interface OutboxEventPayload {
	commandKey?: string;
	outboxId?: string;
	sessionId?: string;
	error?: string;
	replayed?: boolean;
}

// ── 0923 微信 iLink 绑定（v1：绑定/解绑/状态；token 永不进任何响应）──

/** 绑定状态机（server /v1/wechat/bind/status 唯一真相源）。 */
export type WechatStateName = "idle" | "waiting" | "scanned" | "bound" | "expired" | "error";

/** GET /v1/wechat/bind/status（token 永不出现；bot id 只报存在性）。 */
export interface WechatBindStatusBody {
	state: WechatStateName;
	/** waiting/scanned：QR 图片 URL（「手机微信里打开」直链；不是轮询凭证串）。 */
	qrImageUrl: string | null;
	/** waiting/scanned：过期时刻（ms epoch）。 */
	expiresAt: number | null;
	/** waiting/scanned：有效期秒数（服务端 expires_in）。 */
	expiresIn: number | null;
	/** bound：绑定时刻（ISO）。 */
	boundAt: string | null;
	/** bound：是否取到 bot id（值不出现，只存在性）。 */
	botIdPresent: boolean;
	/** error：用户可读消息（不含 token）。 */
	message: string | null;
}

/** POST /v1/wechat/bind/start（幂等：同未过期会话重调返回同一 qr+expiresAt）。 */
export interface WechatBindStartBody {
	state: "waiting";
	qr: { qrImageUrl: string; expiresAt: number; expiresIn: number };
}

/** GET /v1/wechat/bind/qr-image（daemon 代理转 data URL；dataUrl=null → GUI 回退 URL 文本 + 复制）。 */
export interface WechatQrImageBody {
	dataUrl: string | null;
	url: string;
	error: string | null;
}

/** POST /v1/wechat/unbind（删凭据回 idle；removed = 是否删到了文件）。 */
export interface WechatUnbindBody extends WechatBindStatusBody {
	removed: boolean;
}

/** POST /v1/wechat/enable | disable（写 config channels.wechat.enabled；回执 = 写后当前 enabled，幂等；
 *  写盘失败 → 500 {error:"config-write-failed", message, enabled=写前读值}——如实报错不谎称成功）。 */
export interface WechatToggleBody {
	enabled: boolean;
	error?: string;
	message?: string;
}
