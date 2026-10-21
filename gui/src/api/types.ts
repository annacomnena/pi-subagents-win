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
	/**
	 * 进程内存（additive，2026-10-20；AGENTS.md R-2：状态必须可观测 + 给年龄）。
	 * 单位 MB（服务端已除好，前端不要再算）。
	 */
	memory?: {
		rssMb: number;
		heapUsedMb: number;
		heapTotalMb: number;
		externalMb: number;
		sampledAt: string;
		sampleAgeMs: number;
		rssWarn: boolean;
		/** 最大会话文件（stat-only 扫描；已知事故元凶是单个 152MB 的 .jsonl）。 */
		maxSessionFile: {
			bytes: number;
			mb: number;
			sessionId: string | null;
			relPath: string;
			warn: boolean;
		} | null;
	};
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
export type AttentionType = "runtime-risk" | "master-handoff" | "escalation" | "question" | "blocked" | "request-timeout";
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
	kind: "runtime-risk" | "master-handoff" | "escalation" | "question" | "blocked" | "request-timeout";
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
		| "session.message"
		/** 2026-10-20 停止按钮：让目标会话停止当前 turn（payload 空或 {reason?}）。 */
		| "session.abort"
		/** 2026-10-20 斜杠命令：payload {name, args?}。 */
		| "session.slash";
	to: string;
	issuedBy?: string;
	commandKey: string;
	issuedAt: string;
	payload?: Record<string, unknown>;
}

/** GUI 图片输入 S1：POST /v1/uploads 回执（图只落盘；会话里只出现路径）。 */
export interface UploadResult {
	uploadId: string;
	/** 服务端落盘绝对路径（仅本机 GUI 可见；不进会话日志）。 */
	path: string;
	bytes: number;
	mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
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

/**
 * GET /v1/sessions/:id/usage（2026-10-21）：会话**当前轮次**上下文用量。
 *
 * 口径（与 extensions/runtime/session-usage.ts 头注释一致，**不得自行重算**）：
 * - `tokens`：上下文长度（最后一条 assistant 的 `totalTokens`）；null = 还没有带 usage 的消息
 * - `percent`：`tokens / contextWindow` ×100；null = 窗口未知（不猜）
 * - `cachePercent`：`cacheRead / (cacheRead + input)` ×100（**只看输入侧**）；null = 无输入
 */
/** GET /v1/notify/:sessionId（2026-10-21）：notify 桥读侧（TUI notify 的 GUI 镜像）。 */
export interface NotifyRecordBody {
	id: string;
	at: string;
	sessionId: string;
	level: "info" | "warning" | "error";
	/** 原文（服务端不截断）。 */
	text: string;
	/** `command:<name>` / `event:<name>` / `unknown`。 */
	source: string;
	pid: number;
}

export interface NotifyResponseBody {
	version: number;
	sessionId: string;
	records: NotifyRecordBody[];
	/** 下次请求的字节 offset。 */
	nextOffset: number;
	/** 文件不存在（无害空态，不是错误）。 */
	absent: boolean;
}

export interface SessionUsageBody {
	version: number;
	sessionId: string;
	tokens: number | null;
	contextWindow: number | null;
	percent: number | null;
	cachePercent: number | null;
	detail: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		reasoning: number;
	};
	/** assistant 消息时间戳（缺失则不落该字段）。 */
	at?: string;
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
	/** L2 perf（2026-10-20）：tail 模式标记（`?tail=N`）；全量快照时字段缺席。 */
	tail?: true;
	/** tail 模式下窗口之外是否还有更早的行（GUI 据此显示「加载更早」）。 */
	hasOlder?: boolean;
}

/**
/**
 * 流式快照（2026-10-20，`GET /v1/streaming/:sessionId`）。
 *
 * pi 扩展在 `message_update` 时**节流覆盖写**（150ms ≈ 6.7 次/秒），GUI 轮询后渲染
 * 「正在思考 / 正在输出」临时块；`message_end` 后快照被删，正式行从 transcript 投影进来替换。
 * 不存在（404）或陈旧（>60s）时 GUI 视为「没在流式」。
 */
export interface StreamingSnapshot {
	version: 1;
	sessionId: string;
	kind: "reasoning" | "text";
	/** 当前段落的累积文本（快照，非最终值）。 */
	text: string;
	at: string;
	pid: number;
	/** 服务端算好的年龄（ms），GUI 不再自己算时钟差。 */
	ageMs: number;
	/**
	 * **GUI 派生字段**（服务端不返回，由 `store.pollChatStreaming` 补齐，动效 2026-10-21）。
	 *
	 * 本次快照相对「上一份同会话同 kind 且被本次文本前缀包含的快照」**追加段**的起点下标：
	 * `text.slice(0, appendFrom)` = 已显示前缀（渲染后完全不动），`text.slice(appendFrom)` = 增量。
	 * 上一份不存在 / kind 变了 / 文本不是前缀扩展（服务端重启、段切换）⇒ 0（整段都算新增）。
	 */
	appendFrom?: number;
	/**
	 * **GUI 派生字段**：`text` 内容**真变了**才 +1 的版本号（同会话内单调递增）。
	 *
	 * 用作增量节点的 React `key` —— 只有换 key 才会重新挂载、重放 CSS 入场动画。
	 * 文本没变（服务端暂停 / 轮询空转）**不 bump**，否则同一段字会每 200ms 反复淡入。
	 */
	rev?: number;
}

/**
 * 会话正忙标记（2026-10-20，停止按钮可点性）：`GET /v1/session-busy/:sid`。
 *
 * turn 级信号：`agent_start` 写、`agent_settled` 删，忙期间每 15s 心跳。
 * 它补的是流式快照的空白：从「点发送」到「第一个 token」、以及「工具跑完 → 下一段输出」
 * 这两段里流式快照都是 404，但会话确实在跑。
 */
export interface BusySnapshot {
	version: 1;
	sessionId: string;
	busy: true;
	/** 最近一次心跳时刻（ISO）。 */
	at: string;
	/** turn 开始时刻（ISO）—— 能看出这一轮跑了多久。 */
	since: string;
	pid: number;
	/** 服务端算好的心跳年龄（ms）。 */
	ageMs: number;
}

/**
 * 会话可用斜杠命令（2026-10-20）：`GET /v1/session-commands/:sid`。
 *
 * `source` 语义不同，UI 必须区分：
 *   - `extension`：真命令，**不落对话记录**；
 *   - `skill` / `prompt`：会被**展开成正文** ⇒ 在对话流里留下一条消息。
 * 混在一起显示会让用户以为 `/skill:xxx` 是命令（语义欺骗）。
 */
export interface CommandsSnapshot {
	version: 1;
	sessionId: string;
	at: string;
	pid: number;
	/** 服务端算好的快照年龄（ms）。 */
	ageMs: number;
	commands: {
		name: string;
		description?: string;
		source: "extension" | "prompt" | "skill" | "builtin" | "other";
	}[];
}

/**
 * 会话控制指令回执（2026-10-20 停止按钮）：`GET /v1/session-control/:sid`。
 *
 * 只反映**最近一条**请求。`status` 是盘面状态机：pending（已排队）→ running（会话进程已领取）
 * → done（有 result）/ failed（有 error）。
 * `result` 是诚实回执：aborted（确实在流式）/ not-streaming（已空闲）/ stale-ctx（ctx 失效）。
 */
export interface SessionControlBody {
	version: 1;
	sessionId: string;
	request: {
		version: 1;
		id: string;
		sessionId: string;
		action: "abort";
		commandKey: string;
		status: "pending" | "running" | "done" | "failed";
		requestedAt: string;
		claimedBy?: string;
		claimedAt?: string;
		completedAt?: string;
		result?: "aborted" | "not-streaming" | "stale-ctx" | "unknown-action" | "dispatched" | "unknown-command" | "commands-unavailable";
		error?: string;
		/** slash 请求的载荷（原样交给 pi）。 */
		payload?: { name: string; args: string };
	};
	/** 请求年龄（ms），服务端算。 */
	ageMs: number;
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

/** GET /v1/wechat/reply/status（只读投影；不含正文/token/完整 openid）。 */
export interface WechatReplyStatusBody {
	enabled: boolean;
	counts: { pending: number; sent: number; failed: number; unknown: number };
	lastAt: string | null;
	lastError: string | null;
}

/** POST /v1/wechat/enable | disable（写 config channels.wechat.enabled；回执 = 写后当前 enabled，幂等；
 *  写盘失败 → 500 {error:"config-write-failed", message, enabled=写前读值}——如实报错不谎称成功）。 */
export interface WechatToggleBody {
	enabled: boolean;
	error?: string;
	message?: string;
}

// ── 2026-09-30 主动性设置页：GET /v1/autonomy/frontier（frontier.ts FrontierSnapshot 手抄）──

/** frontier.ts GateStatus（global-view 同源）："unknown" 为常态 = 无载体不猜（非异常）。 */
export type AutonomyGateStatus = "awaiting" | "ok" | "unknown";

/** frontier.ts FrontierRule（§25 九规则 + ws_mail_backlog）。 */
export type FrontierRule =
	| "blocked_to_ready"
	| "working_to_completed"
	| "working_to_failed"
	| "needs_global"
	| "needs_user"
	| "risk_high"
	| "deadline_urgency"
	| "expected_event_timeout"
	| "stagnation"
	| "ws_mail_backlog";

/** frontier.ts ProjectState（C5 相位→项目派生态）。 */
export type FrontierProjectState = "Working" | "Blocked" | "Completed" | "Failed" | "Cancelled";

/** frontier.ts FrontierTrigger。 */
export interface FrontierTrigger {
	rule: FrontierRule;
	project: string;
	evidence: string;
	approximate: boolean;
	requestId?: string;
	requestRev?: number;
}

/** frontier.ts ProjectFrontier（单 repo 聚合）。 */
export interface ProjectFrontier {
	project: string;
	state: FrontierProjectState;
	variant: string | null;
	gate: AutonomyGateStatus;
	runs: Record<string, string>;
	needsUser: boolean;
	resultMissing: boolean;
	stagnation: boolean;
	overdue: number;
	overdueRequests: string[];
	meaningfulStateVersion: number;
}

/** GET /v1/autonomy/frontier 完整快照（读盘即返回；快照缺失 → null）。 */
export interface FrontierSnapshot {
	asof: number;
	projects: ProjectFrontier[];
	triggers: FrontierTrigger[];
	/** true = 首帧（prev=null）：只建基线，不算触发（防冷启动风暴）。 */
	baseline: boolean;
}

// ── 2026-10-22 档 A：async subagent run 卡片（GET /v1/runs；server 侧 = subagent-kill.ts RunCard）──

/** async run 记录里的 `status`（与 `RunLiveness` 正交：status 说记录怎么写的，liveness 说进程在不在）。
 *  注意与上方 `RunStatus`（tab run 的 journal 投影七态：created/dispatched/running/waiting/...）**不是同一个东西**
 *  ⇒ 命名必须区分，否则两份契约会被混读。 */
export type AsyncRunStatus = "running" | "completed" | "failed" | "cancelled";

/**
 * 三态判活（**不是** status 的派生）：`alive` = 登记 pid 存活、`dead` = 登记 pid 已不在、
 * `unknown` = 没有 pid 可判。实测 152/154 记录是 `unknown`（缺 pid 是常态）⇒ UI 必须能显示
 * 「状态未知」，且**不得**把它折算成运行中或失败。派生逻辑只在 `runsView.ts::deriveRunDisplay`。
 */
export type RunLiveness = "alive" | "dead" | "unknown";

/** `result.usage` 六聚合量（运行中记录没有这个字段 ⇒ 卡片 `usage: null`）。 */
export interface RunUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

/** 最近一次工具调用（`argsDigest` 服务端已截 ≤160 字节，键序归一）。 */
export interface RunCall {
	tool: string;
	argsDigest: string;
	ts: string;
	turn: number;
}

/** 循环判据（`classifyLoop` 三值 + 终态恒 `unknown`）。 */
export type RunLoopVerdict = "ok" | "repeating" | "no_progress" | "unknown";

/** 一行一 run 的卡片（GET /v1/runs 的 `runs[]` 元素）。 */
export interface RunCard {
	id: string;
	agent: string | null;
	/** 任务摘要：空白折叠 + 截 40 字符（服务端口径）。 */
	taskPreview: string;
	status: AsyncRunStatus;
	liveness: RunLiveness;
	pid: number | null;
	startedAt: string | null;
	/** 最近脉搏（`lastActivity` → `pidRecordedAt` → `startedAt` 回退链）。 */
	lastActivity: string | null;
	/** `result.usage`；缺失（运行中常态）⇒ null。**不要从别处推断**。 */
	usage: RunUsage | null;
	/** 仅 `includeRecentCalls=1` 出现；最近 3 条，newest-first。 */
	recentCalls?: RunCall[];
	/** 仅 `includeRecentCalls=1` 出现；只对 status=running 给 verdict，终态恒 "unknown"。 */
	loopVerdict?: RunLoopVerdict;
}

/** GET /v1/runs 响应（`version:1` 后只增不改；ETag 排除 asof）。 */
export interface RunsResponse {
	version: 1;
	/** 响应时刻（服务端时钟；**不参与 ETag**）。 */
	asof: string;
	/** 本次返回条数（= runs.length，已按 limit 截断）。 */
	count: number;
	/** 截断前总记录数（「显示 N / 共 M」用）。 */
	total: number;
	runs: RunCard[];
}
