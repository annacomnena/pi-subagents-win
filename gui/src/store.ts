/**
 * gui/src/store.ts — zustand 全局态（拍板 4/5）。
 *
 * 各段数据 + nextCursor + connection + activeTab + autoHandoff 本地态。
 * never-throw 语义在 store 层落地：poll 结果失败时**保留旧数据**，只动 connection
 * （down 不推进 lastAsOf——as-of 只由成功 fetch 推进，拍板 4 诚实语义）；
 * 409 cursor-invalid 由 applyEvents 内联 resync（拉 snapshot 重建 + 有效 cursor）。
 */

import { create } from "zustand";
import { api, type ConnState, type FetchErr } from "./api/client";
import { applyTranscriptOp } from "./api/transcript";
import type {
	AttentionItem,
	ChatOutboxEntry,
	CommandOutcomeBody,
	HealthView,
	InteractionItem,
	OutboxEventPayload,
	RuntimeEnvelope,
	RuntimeSnapshot,
	SessionSummary,
	TimelineItem,
	TranscriptHead,
	TranscriptRow,
} from "./api/types";
import type { StreamServerFrame, StreamState } from "./useEventStream";

/** 主视图 Tab（会话为主重构 S4 收窄）：chat=永久默认主视图；timeline=次级全页（排障刚需）。
 *  原 master/workstream/attention/runtime 四状态页收进「运行时」全屏覆盖层（runtimeOverlay）。 */
export type TabId = "chat" | "timeline";

/** 「运行时」全屏覆盖层（仿 zcode WorkspaceSettingsLayer absolute inset-0 z-10）：
 *  null=关；值=打开并定位对应 section（attention/master/workstream/runtime 四页组件原样复用）。 */
export type RuntimeOverlaySection = "attention" | "master" | "workstream" | "runtime";

/** envelope → 人话 TimelineItem（客户端小映射，参照 extensions/runtime-host/timeline.ts 模板；
 *  下一轮 timeline 全量轮询会用 server 侧精修+溯源版本按 id 覆盖）。 */
export function envelopeToTimelineItem(e: RuntimeEnvelope): TimelineItem {
	return {
		id: e.id,
		at: e.at,
		type: e.type,
		kind: "event",
		subject: e.subject,
		summary: describeEvent(e),
		source: e.source,
	};
}

function str(v: unknown): string | undefined {
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

function payloadOf(e: RuntimeEnvelope): Record<string, unknown> {
	return (e.payload ?? {}) as Record<string, unknown>;
}

function describeEvent(e: RuntimeEnvelope): string {
	const p = payloadOf(e);
	const id = e.subject ?? "?";
	const gen = p.fromGeneration ?? p.generation;
	const genS = typeof gen === "number" ? ` (gen ${gen})` : "";
	if (e.type.startsWith("run.")) {
		switch (e.type) {
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
				return `${e.type} ${id} @ ${e.at}`;
		}
	}
	if (e.type.startsWith("master.handoff.")) {
		const t = str(p.transferId);
		const prop = str(p.proposalId);
		const tt = t ? ` (transfer ${t})` : "";
		switch (e.type) {
			case "master.handoff.proposed": {
				const pct = typeof p.pressure === "number" ? Math.round((p.pressure as number) * 100) : "?";
				return `Handoff proposed at ${pct}%${genS}${prop ? `, proposal ${prop}` : ""}`;
			}
			case "master.handoff.accepted":
				return `Handoff accepted${prop ? ` (proposal ${prop})` : ""}${genS}`;
			case "master.handoff.started":
				return `Handoff started${tt}${genS}`;
			case "master.handoff.spawned":
				return `Handoff successor spawned${tt}`;
			case "master.handoff.attached":
				return `Handoff attached${tt}${genS}`;
			case "master.handoff.completed":
				return `Handoff completed${tt}`;
			case "master.handoff.failed":
				return `Handoff failed${tt}`;
			case "master.handoff.auto_failed":
				return `Auto handoff failed${tt}${genS}`;
			default:
				return `${e.type} ${id} @ ${e.at}`;
		}
	}
	return `${e.type}${e.subject ? ` ${e.subject}` : ""} @ ${e.at}`;
}

/** timeline live 段合并上限（events 增量 + 全量轮询尾窗共用；硬顶防长会话内存漂移）。
 *  R3（plans/0921_G52_patch_review.md 必修 3）起 cap 只约束 live 段：用户显式「加载更早」
 *  翻到的历史页（historyAnchorId 及更早）全量保留，不被尾切逐出。 */
const TIMELINE_CAP = 2000;

export interface CommandReceipt {
	at: string;
	summary: string;
}

interface GuiState {
	// UI
	activeTab: TabId;
	setActiveTab: (t: TabId) => void;
	/** 左栏折叠（ZCode 1:1 第 3 步）：折叠 = 宽度动画到 0 + opacity-0 + pointer-events-none。 */
	sidebarCollapsed: boolean;
	setSidebarCollapsed: (v: boolean) => void;
	runtimeOverlay: RuntimeOverlaySection | null;
	setRuntimeOverlay: (s: RuntimeOverlaySection | null) => void;

	// 连接面（never-throw：down 时保留旧数据）
	connection: ConnState;
	/** 最近一次任一端点成功响应时刻（「数据 as-of」横幅）。 */
	lastAsOf: string | null;
	markUp: (at: string) => void;
	/** 置 down；at 仅存档不写入 lastAsOf（失败时刻 ≠ 数据新鲜度）。 */
	markDown: (_at: string) => void;

	// 数据段
	health: HealthView | null;
	snapshot: RuntimeSnapshot | null;
	timeline: TimelineItem[];
	/** G5.2：before= 翻页已到最早（服务端返回空集/不足一页时置位，「加载更早」停用）。
	 *  R3 起该置位仅由真实旧端空页/不足一页触发，与容量上限无关（上限不误报已到最早）。 */
	timelineEnd: boolean;
	/** R3：历史翻页独立游标（排他上界 id；null = 未翻页）。翻页后不再从 timeline[0] 推导
	 *  ——timeline 被 cap 裁剪后 timeline[0] 会回弹，从它推导会原地重复请求（必修 3 根因）。 */
	beforeCursor: string | null;
	/** R3：历史段边界 = 首次翻页时的当前最旧 id；live 段容量裁剪永不动它及更早的历史页
	 *  （翻过的旧页保留）。resync 重建时复位。 */
	historyAnchorId: string | null;
	attention: AttentionItem[];
	attentionIncludeResolved: boolean;
	setAttentionIncludeResolved: (v: boolean) => void;
	/** G6-P3：待决策交互投影（/v1/interactions；TopBar 徽标 + Master 卡 + Attention 页 response 驱动）。 */
	interactions: InteractionItem[];
	nextCursor: string;

	// 命令面
	autoHandoff: boolean | null; // null = 未知（snapshot 未就绪；就绪后同步真实态）
	setAutoHandoff: (v: boolean) => void;
	lastCommand: CommandReceipt | null;
	setLastCommand: (r: CommandReceipt) => void;

	// poll 应用器
	pollHealth: () => Promise<void>;
	pollSnapshot: () => Promise<void>;
	pollEvents: () => Promise<void>;
	pollAttention: () => Promise<void>;
	pollInteractions: () => Promise<void>;
	pollTimeline: () => Promise<void>;
	/** G5.2：before= 历史翻页（加载更早；幂等可重按，end 后 no-op）。 */
	loadEarlierTimeline: () => Promise<void>;

	// ── G6-P1 会话页（chat slice，第 6 页；既有五页轮询零改动）──
	chatSessions: SessionSummary[];
	chatActiveId: string | null;
	/** 会话 → 投影行终态（应用 op 后；进入页面由 GET 全量播种，WS 增量维护）。 */
	chatRowsBySession: Record<string, TranscriptRow[]>;
	/** 会话 → 投影头（seq/logEpoch/gen；断线重连的 base 来源）。 */
	chatHeadBySession: Record<string, TranscriptHead | null>;
	/** 会话 → 已见最大帧 seq（防重放倒退；重放去重由 appended 幂等兑底）。 */
	chatSeqBySession: Record<string, number>;
	chatConn: StreamState;
	/** bump → useEventStream 立即重订阅（snapshot/resync 全量重拉完成后）。 */
	chatResyncKey: number;
	// ── G6-P2：session.message 发送 + outbox 两段回执 ──
	/** commandKey → 发送/回执状态（POST accepted 后由 WS outbox 主题推进终态）。 */
	chatOutbox: Record<string, ChatOutboxEntry>;
	/** outbox 主题续传指针（journal seq/epoch/gen 同机）。 */
	chatOutboxHead: TranscriptHead | null;
	/** 会话页输入框发送（POST /v1/commands session.message；never-throw，拒绝/失败落 failed/rejected）。 */
	sendChatMessage: (sessionId: string, text: string) => Promise<void>;
	pollChatSessions: () => Promise<void>;
	openChatSession: (id: string) => Promise<void>;
	reloadChatSession: (id: string) => Promise<void>;
	applyChatFrame: (frame: StreamServerFrame) => Promise<void>;
	setChatConn: (s: StreamState) => void;
	bumpChatResync: () => void;
}

function isResync(e: FetchErr): boolean {
	return e.resync === true;
}

/** 按 server 全序（at, id）合并去重；incoming 同 id 覆盖（server 精修版压过客户端映射版）。 */
export function mergeTimelineItems(current: TimelineItem[], incoming: readonly TimelineItem[]): TimelineItem[] {
	const byId = new Map(current.map((t) => [t.id, t] as const));
	for (const it of incoming) byId.set(it.id, it);
	return [...byId.values()].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

/**
 * R3 容量策略：cap 只裁剪 live 段（historyAnchorId 之后的尾窗）；history 段（anchor 本体
 * 及更早 = 用户显式翻到的旧页）全量保留。anchor 缺席（resync 重建后不应发生）→ 保守
 * 不裁剪（宁多留不错删）。返回值可能复用传入数组（未裁剪时）。 */
export function capTimelineItems(merged: TimelineItem[], historyAnchorId: string | null): TimelineItem[] {
	if (merged.length <= TIMELINE_CAP) return merged;
	if (!historyAnchorId) return merged.slice(-TIMELINE_CAP);
	const idx = merged.findIndex((t) => t.id === historyAnchorId);
	if (idx < 0) return merged;
	const tail = merged.slice(idx + 1);
	if (tail.length <= TIMELINE_CAP) return merged;
	return [...merged.slice(0, idx + 1), ...tail.slice(-TIMELINE_CAP)];
}

export const useGui = create<GuiState>((set, get) => ({
	activeTab: "chat",
	setActiveTab: (t) => set({ activeTab: t }),
	sidebarCollapsed: false,
	setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),
	runtimeOverlay: null,
	setRuntimeOverlay: (s) => set({ runtimeOverlay: s }),

	connection: "down",
	lastAsOf: null,
	markUp: (at) => set({ connection: "up", lastAsOf: at }),
	markDown: (_at) => set({ connection: "down" }),

	health: null,
	snapshot: null,
	timeline: [],
	timelineEnd: false,
	beforeCursor: null,
	historyAnchorId: null,
	attention: [],
	attentionIncludeResolved: false,
	setAttentionIncludeResolved: (v) => set({ attentionIncludeResolved: v }),
	interactions: [],
	nextCursor: "0",

	autoHandoff: null,
	setAutoHandoff: (v) => set({ autoHandoff: v }),
	lastCommand: null,
	setLastCommand: (r) => set({ lastCommand: r }),

	pollHealth: async () => {
		const r = await api.health();
		if (r.ok) {
			set({ health: r.data });
			get().markUp(r.at);
		} else {
			get().markDown(r.at);
		}
	},

	pollSnapshot: async () => {
		const r = await api.snapshot();
		if (r.ok) {
			const patch: Partial<GuiState> = { snapshot: r.data };
			// G5.2：auto 开关同步真实态（config.masterSuccession.auto；toggle 本地乐观更新会被下次 poll 校准）
			const auto = r.data.master?.autoHandoff;
			if (auto && typeof auto.auto === "boolean") patch.autoHandoff = auto.auto;
			set(patch);
			get().markUp(r.at);
		} else {
			get().markDown(r.at);
		}
	},

	/** events 增量：成功 → 追加 timeline + 推进 cursor；409 cursor-invalid → resync
	 *  （拉 snapshot 重建 + cursor 取 snapshot timeline 里的事件尾 id，等价 server hint
	 *  「snapshot 重建 + after=0」且免全量重放；无事件 id → 兜底 "0"）。 */
	pollEvents: async () => {
		const { nextCursor, timeline } = get();
		const r = await api.events(nextCursor);
		if (r.ok) {
			const incoming = r.data.envelopes.map(envelopeToTimelineItem);
			if (incoming.length > 0) {
				set({
					timeline: capTimelineItems(mergeTimelineItems(timeline, incoming), get().historyAnchorId),
					nextCursor: r.data.nextCursor,
				});
			} else {
				set({ nextCursor: r.data.nextCursor });
			}
			get().markUp(r.at);
			return;
		}
		get().markDown(r.at);
		if (isResync(r)) {
			const snap = await api.snapshot();
			if (snap.ok) {
				const eventIds = snap.data.timeline.filter((t) => t.kind === "event").map((t) => t.id);
				set({
					snapshot: snap.data,
					timeline: snap.data.timeline,
					nextCursor: eventIds.length > 0 ? eventIds[eventIds.length - 1] : "0",
					// R3：resync = 从 snapshot 重建 live 段；历史游标/边界/终态一并复位
					//（下次翻页从新最旧重新推导；重叠旧页由 id 去重兑底）
					beforeCursor: null,
					historyAnchorId: null,
					timelineEnd: false,
				});
				get().markUp(snap.at);
			}
		}
	},

	pollAttention: async () => {
		const r = await api.attention(get().attentionIncludeResolved);
		if (r.ok) {
			set({ attention: r.data.attention });
			get().markUp(r.at);
		} else {
			get().markDown(r.at);
		}
	},

	/** G6-P3：待决策交互投影（2s 轮询；失败保留旧数据，同 never-throw 纪律）。 */
	pollInteractions: async () => {
		const r = await api.interactions();
		if (r.ok) {
			set({ interactions: r.data.interactions });
			get().markUp(r.at);
		} else {
			get().markDown(r.at);
		}
	},

	/** timeline 尾窗全量（无 cursor）按 id 合并：server 精修版覆盖 events 客户端映射版。
		 *  R3：容量裁剪走 capTimelineItems（live 段尾窗，历史页保护）。 */
	pollTimeline: async () => {
		const r = await api.timeline(200);
		if (r.ok) {
			set({
				timeline: capTimelineItems(mergeTimelineItems(get().timeline, r.data.timeline), get().historyAnchorId),
			});
			get().markUp(r.at);
		} else {
			get().markDown(r.at);
		}
	},

	/** G5.2/R3：加载更早（before= 排他上界）。游标独立于 cap：首按从当前最旧推导并锚定
		 *  history 段边界（先于 await 设置，防在飞期间被裁剪），此后一律用 beforeCursor
		 *  （= 上一页最旧）严格向旧端推进——timeline 被 cap 也不再原地打转/重复请求。
		 *  历史页并入不过 cap（capTimelineItems 的 anchor 保护在后续自动轮询时同样生效）；
		 *  空页/不足一页 → timelineEnd（真·已到最早；上限永不误报最早）。 */
	loadEarlierTimeline: async () => {
		const { timeline, timelineEnd, beforeCursor } = get();
		if (timelineEnd || timeline.length === 0) return;
		const before = beforeCursor ?? timeline[0]?.id;
		if (!before) return;
		if (get().historyAnchorId === null) set({ historyAnchorId: before });
		const r = await api.timeline(200, before);
		if (!r.ok) {
			get().markDown(r.at);
			return;
		}
		if (r.data.timeline.length === 0) {
			set({ timelineEnd: true });
			get().markUp(r.at);
			return;
		}
		const merged = mergeTimelineItems(get().timeline, r.data.timeline);
		set({
			timeline: merged,
			beforeCursor: merged[0]?.id ?? before,
			// 满一页 → 可能还有更早；不足一页 → 已到最早
			timelineEnd: r.data.timeline.length < 200,
		});
		get().markUp(r.at);
	},
	// ── G6-P1 会话页实现 ────────────────────────────────────────

	chatSessions: [],
	chatActiveId: null,
	chatRowsBySession: {},
	chatHeadBySession: {},
	chatSeqBySession: {},
	chatConn: "idle",
	chatResyncKey: 0,
	chatOutbox: {},
	chatOutboxHead: null,

	sendChatMessage: async (sessionId, text) => {
		const commandKey = `gui_msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
		const entry: ChatOutboxEntry = { commandKey, sessionId, text, status: "sending", at: new Date().toISOString() };
		set({ chatOutbox: { ...get().chatOutbox, [commandKey]: entry } });
		const r = await api.sessionMessage(sessionId, text);
		const cur = get().chatOutbox[commandKey];
		if (cur === undefined) return; // 已被裁剪（理论不发生）
		if (!r.ok) {
			// 真实 403 回执驱动（G6-P2 L4 必修 4）：executor 护栏拒绝即权威终态，不靠 health 猜测
			const rej = (typeof r.body === "object" && r.body !== null ? (r.body as { status?: unknown; reason?: unknown }) : null);
			if (r.status === 403 && rej?.status === "rejected" && rej.reason === "master-session-protected") {
				set({
					chatOutbox: {
						...get().chatOutbox,
						[commandKey]: { ...cur, status: "rejected", detail: "Master 会话拒绝远程输入（403 master-session-protected）", at: new Date().toISOString() },
					},
				});
				return;
			}
			set({
				chatOutbox: {
					...get().chatOutbox,
					[commandKey]: { ...cur, status: "failed", detail: r.status === 401 ? "未授权（401）" : `网络/服务错误（${r.status}）`, at: new Date().toISOString() },
				},
			});
			return;
		}
		const body = r.data as CommandOutcomeBody;
		set({
			chatOutbox: {
				...get().chatOutbox,
				[commandKey]: {
					...cur,
					status: body.status === "accepted" ? "pending" : "rejected",
					detail: body.status === "accepted" ? undefined : body.reason,
					at: new Date().toISOString(),
				},
			},
		});
	},

	pollChatSessions: async () => {
		const r = await api.sessions();
		if (r.ok) {
			set({ chatSessions: r.data.sessions });
			get().markUp(r.at);
		} else {
			get().markDown(r.at);
		}
	},

	/** 进入会话/全量重拉（首屏 GET 播种；head 为后续 WS 续传 base）。 */
	reloadChatSession: async (id) => {
		const r = await api.transcript(id);
		if (!r.ok) return;
		set({
			chatRowsBySession: { ...get().chatRowsBySession, [id]: r.data.rows },
			chatHeadBySession: { ...get().chatHeadBySession, [id]: r.data.head },
			chatSeqBySession: { ...get().chatSeqBySession, [id]: r.data.head?.seq ?? 0 },
		});
		get().markUp(r.at);
	},

	openChatSession: async (id) => {
		set({ chatActiveId: id });
		await get().reloadChatSession(id);
		// 新 topic / 新 head → 立即重订阅（不走断线退避）
		get().bumpChatResync();
	},

	/** WS 帧路由：op 增量应用；ack snapshot / resync → 全量重拉 + 重订阅。 */
	applyChatFrame: async (frame) => {
		if (frame.type === "error") return;
		// G6-P2：outbox 主题（journal 过滤投影）→ 发送状态推进 + 续传指针
		if (frame.topic === "outbox") {
			if (frame.type === "ack") {
				if (frame.mode === "resume" && frame.head !== null) set({ chatOutboxHead: frame.head });
				// snapshot：journal 即重放源，回退 base 从头重放（不重 GET）
				if (frame.mode === "snapshot") {
					set({ chatOutboxHead: null });
					get().bumpChatResync();
				}
				return;
			}
			if (frame.type === "resync") {
				set({ chatOutboxHead: null });
				get().bumpChatResync();
				return;
			}
			if (frame.type === "event" && frame.envelope !== undefined) {
				const head = get().chatOutboxHead;
				set({ chatOutboxHead: { seq: frame.seq, logEpoch: head?.logEpoch ?? "", ...(head?.gen !== undefined ? { gen: head.gen } : {}) } });
				const p = (frame.envelope as { payload?: unknown }).payload as OutboxEventPayload | undefined;
				const ck = p?.commandKey;
				if (typeof ck !== "string" || ck.length === 0) return;
				const cur = get().chatOutbox[ck];
				if (cur === undefined || cur.status === "delivered" || cur.status === "failed" || cur.status === "expired") return; // 终态不可逆
				const evType = (frame.envelope as { type?: string }).type;
				if (evType === "message.delivered") {
					set({ chatOutbox: { ...get().chatOutbox, [ck]: { ...cur, status: "delivered", detail: undefined, at: new Date().toISOString() } } });
				} else if (evType === "message.failed") {
					set({ chatOutbox: { ...get().chatOutbox, [ck]: { ...cur, status: "failed", detail: p?.error, at: new Date().toISOString() } } });
				} else if (evType === "message.expired") {
					// G6-P2 L4 必修 2：pending 超 TTL 转 expired（journal 回执投影到发送徽标）
					set({ chatOutbox: { ...get().chatOutbox, [ck]: { ...cur, status: "expired", detail: "超过 24h 未投递，已过期", at: new Date().toISOString() } } });
				}
			}
			return;
		}
		const sid = frame.topic.startsWith("transcript:") ? frame.topic.slice("transcript:".length) : null;
		if (frame.type === "event" && sid !== null) {
			if (frame.op === undefined) return;
			const prevSeq = get().chatSeqBySession[sid] ?? 0;
			if (frame.seq < prevSeq) return; // 已见段重放倒退防御（appended 幂等兑底不重不漏）
			const view = applyTranscriptOp({ rows: get().chatRowsBySession[sid] ?? [], info: {} }, frame.op);
			set({
				chatRowsBySession: { ...get().chatRowsBySession, [sid]: view.rows },
				chatSeqBySession: { ...get().chatSeqBySession, [sid]: Math.max(prevSeq, frame.seq) },
			});
			return;
		}
		if (frame.type === "ack" && frame.mode === "snapshot" && sid !== null) {
			// 服务端不背快照：首屏/跨代 → 全量 GET 后重订阅（WS 只做增量）
			await get().reloadChatSession(sid);
			get().bumpChatResync();
			return;
		}
		if (frame.type === "resync" && sid !== null) {
			await get().reloadChatSession(sid);
			get().bumpChatResync();
		}
	},

	setChatConn: (s) => set({ chatConn: s }),
	bumpChatResync: () => set({ chatResyncKey: get().chatResyncKey + 1 }),
}));

// ── 命令动作（POST commands；accepted 才落本地态，回执全文进 lastCommand）──

export async function acceptHandoff(reason?: string): Promise<void> {
	const r = await api.handoffAccept(reason);
	const s = useGui.getState();
	if (r.ok) {
		s.setLastCommand({ at: r.at, summary: receiptSummary(r.data) });
	} else {
		s.setLastCommand({
			at: r.at,
			summary: `handoff.accept 失败（HTTP ${r.status}）`,
		});
	}
}

/** G5.2：立即生成交接提案（确定性路径，pressure 用 host 侧 liveness 最新心跳）。 */
export async function prepareHandoff(reason?: string): Promise<void> {
	const r = await api.handoffPrepare(reason);
	const s = useGui.getState();
	if (r.ok) {
		s.setLastCommand({ at: r.at, summary: receiptSummary(r.data) });
	} else {
		const detail =
			typeof r.body === "object" && r.body !== null && typeof (r.body as { detail?: unknown }).detail === "string"
				? ((r.body as { detail: string }).detail)
				: undefined;
		s.setLastCommand({
			at: r.at,
			summary: detail ?? `prepare 被拒绝（HTTP ${r.status}${r.body && typeof r.body === "object" && "reason" in r.body ? `：${(r.body as { reason: unknown }).reason}` : ""}）`,
		});
	}
}

export async function setAutoHandoff(auto: boolean, reason?: string): Promise<void> {
	const r = await api.autoHandoffSet(auto, reason);
	const s = useGui.getState();
	if (r.ok) {
		s.setAutoHandoff(auto); // accepted 后本地乐观更新（拍板 3）
		s.setLastCommand({ at: r.at, summary: receiptSummary(r.data) });
	} else {
		s.setLastCommand({ at: r.at, summary: `auto-handoff.set 失败（HTTP ${r.status}）` });
	}
}

export async function pauseResumeWorkstream(
	type: "workstream.pause" | "workstream.resume",
	wsId: string,
	reason?: string,
): Promise<void> {
	const r = await api.workstreamPauseResume(type, wsId, reason);
	const s = useGui.getState();
	const verb = type === "workstream.pause" ? "pause" : "resume";
	if (r.ok) {
		s.setLastCommand({ at: r.at, summary: receiptSummary(r.data) });
	} else if (r.status === 409 || r.status === 404 || r.status === 400) {
		// 业务拒绝（bad-state / no-workstream / invalid-payload）——回执即摘要
		s.setLastCommand({ at: r.at, summary: `${verb} 被拒绝（HTTP ${r.status}；bad-state/no-workstream/invalid-payload）` });
	} else {
		s.setLastCommand({ at: r.at, summary: `${verb} 失败（HTTP ${r.status || "网络"}）` });
	}
}

function receiptSummary(o: CommandOutcomeBody): string {
	if (o.status === "accepted") return o.summary;
	if (o.status === "rejected") return `rejected: ${o.reason}`;
	return `failed: ${o.reason}${"error" in o && o.error ? `（${o.error}）` : ""}`;
}
