/**
 * gui/src/store.ts — zustand 全局态（拍板 4/5）。
 *
 * 各段数据 + nextCursor + connection + activeTab + autoHandoff 本地态。
 * never-throw 语义在 store 层落地：poll 结果失败时**保留旧数据**，只动 connection
 * （down 不推进 lastAsOf——as-of 只由成功 fetch 推进，拍板 4 诚实语义）；
 * 409 cursor-invalid 由 applyEvents 内联 resync（拉 snapshot 重建 + 有效 cursor）。
 */

import { create } from "zustand";
import { api, newCommandKey, type ConnState, type FetchErr } from "./api/client";
import { applyTranscriptOp } from "./api/transcript";
import type {
	AttentionItem,
	ChatOutboxEntry,
	CommandOutcomeBody,
	HealthView,
	InteractionItem,
	OutboxEventPayload,
	CommandsSnapshot,
	RuntimeEnvelope,
	SessionControlBody,
	RuntimeSnapshot,
	SessionSummary,
	SessionUsageBody,
	NotifyRecordBody,
	TimelineItem,
	StreamingSnapshot,
	TranscriptHead,
	TranscriptRow,
} from "./api/types";
import type { StreamServerFrame, StreamState } from "./useEventStream";
import { toast } from "./ui/toast";
import { PANEL_DISPATCHED, railOpenDefault } from "./rightRail/railState";

/** 主视图 Tab（会话为主重构 S4 收窄）：chat=永久默认主视图；timeline=次级全页（排障刚需）。
 *  原 master/workstream/attention/runtime 四状态页收进「运行时」全屏覆盖层（runtimeOverlay）。 */
export type TabId = "chat" | "timeline";

/** 「运行时」全屏覆盖层（仿 zcode WorkspaceSettingsLayer absolute inset-0；0923 2003 遮挡修复后
 *  根层叠 z-30，见 RuntimeOverlay.tsx 头注）：
 *  null=关；值=打开并定位对应 section（attention/master/workstream/runtime 四页组件原样复用；
 *  0923 wechat = 「微信连接」（L3 UX 修复：入口始终显示，未启用 403 由 ChannelsPage 页内给启用按钮）；
 *  2026-09-30 autonomy = 「主动性」（从微信页拆出的独立设置页：总门开关 + frontier 可视化））。 */
export type RuntimeOverlaySection = "attention" | "master" | "workstream" | "runtime" | "runs" | "wechat" | "autonomy" | "appearance";

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
	/**
	 * 右侧面板展开态（2026-10-26 P1B；设计稿 §3.1/§3.4）。
	 *
	 * **内存态**：不写 config.json、不持久化、无 WebStorage —— 与 `theme.ts` 同口径。
	 * 初值在**挂载时**求值 `matchMedia("(min-width: 1280px)")`（`≥1280px` 默认展开）。
	 */
	railOpen: boolean;
	setRailOpen: (v: boolean) => void;
	/** 右栏当前面板 id（`rightRail/panels.ts::RAIL_PANELS` 的 `id`；未知 id 由壳回落第一个）。 */
	railPanel: string;
	setRailPanel: (id: string) => void;
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
	/** 0923 2003 C4：journal 主题续传指针（WS journal ack/event 推进；纯指针，不改既有数据结构）。 */
	chatJournalHead: TranscriptHead | null;
	/** 会话 → 已见最大帧 seq（防重放倒退；重放去重由 appended 幂等兑底）。 */
	chatSeqBySession: Record<string, number>;
	/** 会话 → 是否还有更早的行未加载（L2 perf 2026-10-20：首屏只取最新 TAIL_FIRST 行）。 */
	chatHasOlderBySession: Record<string, boolean>;
	/** 会话 → 当前已请求的尾部行数（「加载更早」时翻倍）。 */
	chatTailBySession: Record<string, number>;
	/** 当前会话的流式快照（节流 ~6.7 次/秒；null = 没在流式）。L2/UX 2026-10-20。 */
	chatStreaming: StreamingSnapshot | null;
	/**
	 * 会话 → 当前轮次上下文用量（2026-10-21）。
	 *
	 * 按 sessionId 缓存（切会话不串值）。刷新时机：打开会话 / 会话忙结束 / 手动刷新。
	 * 不做高频轮询：usage 只在 assistant 消息落盘后才变，跟 transcript 同源同频。
	 */
	chatUsageBySession: Record<string, SessionUsageBody>;
	/**
	 * notify 桥读侧指针（2026-10-21）：sessionId → 已消费到的字节 offset。
	 *
	 * 只增不减（文件按天切，跨天时服务端把越界 offset 当首屏处理）。
	 */
	notifyOffsetBySession: Record<string, number>;
	/**
	 * 当前会话最近一条**控制指令**回执（2026-10-20 停止按钮）。
	 * null = 没点过停止（或已过展示期）；status=done + result=aborted ⇒ 已停下。
	 */
	chatControl: SessionControlBody | null;
	/**
	 * 会话是否正忙（2026-10-20，停止按钮可点性）。turn 级权威信号：
	 * 由扩展在 agent_start 写、agent_settled 删，补上流式快照的两段空白
	 * （点发送→首个 token、工具跑完→下一段输出）。
	 */
	chatBusyFlag: boolean;
	/** 停止按钮的本地瞬时态（点击后 → 回执未到前的禁用保护，防连点排队多条）。 */
	chatAborting: boolean;
	chatConn: StreamState;
	/** bump → useEventStream 立即重订阅（snapshot/resync 全量重拉完成后）。 */
	chatResyncKey: number;
	// ── G6-P2：session.message 发送 + outbox 两段回执 ──
	/** commandKey → 发送/回执状态（POST accepted 后由 WS outbox 主题推进终态）。 */
	chatOutbox: Record<string, ChatOutboxEntry>;
	/** outbox 主题续传指针（journal seq/epoch/gen 同机）。 */
	chatOutboxHead: TranscriptHead | null;
	/** 会话页输入框发送（POST /v1/commands session.message；never-throw，拒绝/失败落 failed/rejected）。 */
	sendChatMessage: (sessionId: string, text: string, attachments?: string[]) => Promise<void>;
	pollChatSessions: () => Promise<void>;
	openChatSession: (id: string) => Promise<void>;
	/** 首屏/全量重拉：缺省只取最新 TAIL_FIRST 行（`?tail=`）；传 tail 显式放大（「加载更早」）。 */
	reloadChatSession: (id: string, tail?: number) => Promise<void>;
	/** 刷新指定会话的上下文用量（2026-10-21；失败保留旧值，不置空）。 */
	refreshChatUsage: (id: string) => Promise<void>;
	/**
	 * 拉取当前会话的新 notify 并以 toast 呈现（2026-10-21）。
	 *
	 * 与 usage 同频（打开会话 / 轮询一起），不单独开定时器。
	 */
	pollNotify: (id: string | null) => Promise<void>;
	/** 拉一次流式快照（404 = 没在流式 → 置 null，不算错误）。 */
		pollChatStreaming: (id: string | null) => Promise<void>;
	/**
	 * 请求停止当前 turn（2026-10-20）。
	 *
	 * 诚实口径：POST 成功只代表「请求已排队」；真实结果靠 `pollChatControl` 读回执。
	 * 幂等：commandKey 在这里生成一次，失败重试同键（不会重复排队）。
	 */
	abortChatSession: (sessionId: string) => Promise<void>;
	/** 拉一次控制回执（404 = 没点过 → 置 null，不算错误）。 */
	pollChatControl: (id: string | null) => Promise<void>;
	/** 拉一次「会话正忙」标记（404 = 空闲 → false，不算错误）。 */
	pollChatBusy: (id: string | null) => Promise<void>;
	/**
	 * 当前会话可用斜杠命令（2026-10-20）。null = 快照不可用（扩展未加载/未 reload）
	 * ⇒ GUI 回退到「只给自由输入」，并在输入框提示原因。
	 */
	chatCommands: CommandsSnapshot | null;
	/** 拉一次命令快照（404 = 不可用 → null，不算错误）。 */
	pollChatCommands: (id: string | null) => Promise<void>;
	/**
	 * 派发一条斜杠命令（2026-10-20）。
	 * 诚实口径：POST accepted 只代表「已排队」；真实结果（dispatched / unknown-command /
	 * commands-unavailable）由 `pollChatControl` 读回执。
	 */
	sendChatSlash: (sessionId: string, name: string, args: string) => Promise<void>;
	/** 0923 2003 C3：WS 重连强制 resync（有 head 走 after= 增量补差，否则/失败回退全量）。 */
	resyncChatSession: (id: string) => Promise<void>;
	applyChatFrame: (frame: StreamServerFrame) => Promise<void>;
	setChatConn: (s: StreamState) => void;
	bumpChatResync: () => void;
}

/** 首屏尾部行数（L2 perf：一屏约 200 行；「加载更早」时翻倍）。 */
const TAIL_FIRST = 200;

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

/**
 * notify 记录 → toast（2026-10-21）。
 *
 * 映射纪律：
 * - `error` → variant "warning"（toast 只有 warning 档；error 用更长时长区分）
 * - `warning` → "warning"
 * - `info` → "info"
 * - `dedupeKey` 用 text 哈希：轮询重复拉到同一条时替换而非堆积
 * - warning/error 停留更久（8s vs 4s），因为它们是「需要看见」的
 */
function pushNotifyToast(rec: NotifyRecordBody): void {
	const variant = rec.level === "error" || rec.level === "warning" ? "warning" : "info";
	// 简易稳定键：level + 文本（同一条 notify 重投时替换）
	let h = 0;
	for (let i = 0; i < rec.text.length; i += 1) h = (h * 31 + rec.text.charCodeAt(i)) | 0;
	toast(rec.text, {
		variant,
		durationMs: variant === "warning" ? 8000 : 4000,
		dedupeKey: `notify:${rec.level}:${h}`,
		dismissible: true,
		position: "top-right",
	});
}

/**
 * 右栏默认展开态（2026-10-26 P1B；设计稿 §3.1：`≥1280px` 默认展开，`<1280px` 默认收起但入口可开抽屉）。
 *
 * 在**模块求值时**求值一次（= 「按挂载时求值」；本仓 gui 是浏览器 SPA，无 SSR）。
 * 判据本体在 `rightRail/railState.ts::railOpenDefault`（纯函数、带 fallback：
 * 无 `matchMedia`（node 测试 / 非浏览器）⇒ 收起，绝不拆）。
 */
function initialRailOpen(): boolean {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
	return railOpenDefault((q) => window.matchMedia(q).matches);
}

export const useGui = create<GuiState>((set, get) => ({
	activeTab: "chat",
	setActiveTab: (t) => set({ activeTab: t }),
	sidebarCollapsed: false,
	setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),
	// 右栏（P1B）：展开态按挂载时视口求值；面板 id 用常量而不是字符串字面量（避免两处漂移）。
	railOpen: initialRailOpen(),
	setRailOpen: (v) => set({ railOpen: v }),
	railPanel: PANEL_DISPATCHED,
	setRailPanel: (id) => set({ railPanel: id }),
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
	chatJournalHead: null,
	chatSeqBySession: {},
	chatHasOlderBySession: {},
	chatTailBySession: {},
	chatStreaming: null,
	chatUsageBySession: {},
	notifyOffsetBySession: {},
	chatControl: null,
	chatBusyFlag: false,
	chatCommands: null,
	chatAborting: false,
	chatConn: "idle",
	chatResyncKey: 0,
	chatOutbox: {},
	chatOutboxHead: null,

	sendChatMessage: async (sessionId, text, attachments) => {
		// 2026-10-19：commandKey **只生成一次**，既作本地 chatOutbox 的 key，也传给 api.sessionMessage
		// 作为真正发出去的 commandKey。两者必须同值，否则
		// `outboxId = sha256("session.message:" + commandKey)` 算不出真实 outbox id ⇒
		// 本地「已提交·等待注入」回显无法按 outboxId 配对退场（用户真机反馈的「永远赖在最下边」）。
		const commandKey = newCommandKey("msg");
		// GUI 图片输入 S2：附件只带 id（图已落盘；正文由服务端拼路径）；两段回执行仍展示正文
		const entry: ChatOutboxEntry = { commandKey, sessionId, text, status: "sending", at: new Date().toISOString() };
		set({ chatOutbox: { ...get().chatOutbox, [commandKey]: entry } });
		const r = await api.sessionMessage(sessionId, text, attachments, commandKey);
		const cur = get().chatOutbox[commandKey];
		if (cur === undefined) return; // 已被裁剪（理论不发生）
		if (!r.ok) {
			// 真实 403 回执驱动（G6-P2 L4 必修 4）：executor 护栏拒绝即权威终态，不靠 health 猜测
			const rej = (typeof r.body === "object" && r.body !== null ? (r.body as { status?: unknown; reason?: unknown }) : null);
			// L3 窄路径：master 离线 → 明确提示（请在电脑端打开 master 会话），不静默失败
			if (r.status === 409 && rej?.status === "rejected" && rej.reason === "master-offline") {
				set({
					chatOutbox: {
						...get().chatOutbox,
						[commandKey]: { ...cur, status: "rejected", detail: "Master 会话离线：请在电脑端打开 master 会话（其心跳落盘后重试；若仍 409 请重发（新 commandKey））", at: new Date().toISOString() },
					},
				});
				return;
			}
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

	/**
	 * 拉一次流式快照。
	 *
	 * 404 是**正常态**（会话没在流式）⇒ 置 null，不 markDown（否则健康度会被误判）。
	 * 其他错误同样置 null：流式预览失败不该影响主数据面。
	 *
	 * 2026-10-21 动效：除了透传服务端快照，这里再算两个**GUI 派生字段**
	 * （`appendFrom` / `rev`，见 `StreamingSnapshot` 注释）——
	 * 让渲染层能「只给刚追加的那一段」加入场动画，而不是整段重画。
	 * 放在 store 而不是组件里：组件若用 ref 记住「上一帧文本」，StrictMode 双渲染
	 * 会先消费掉 ref ⇒ 动画在 dev 下时有时无；状态里带下标才是幂等的。
	 */
	pollChatStreaming: async (id) => {
		if (id === null) {
			if (get().chatStreaming !== null) set({ chatStreaming: null });
			return;
		}
		const r = await api.streaming(id);
		if (!r.ok) {
			// 404（not-streaming）/ 网络失败：都当「没在流式」
			if (get().chatStreaming !== null) set({ chatStreaming: null });
			return;
		}
		// 防串台：响应必须属于当前会话
		if (r.data.sessionId !== id) return;
		// 派生「本次追加段」：只有同会话 + 同 kind + 文本是上一份的前缀扩展，才算「接在后面」。
		const prev = get().chatStreaming;
		const appendable =
			prev !== null &&
			prev.sessionId === r.data.sessionId &&
			prev.kind === r.data.kind &&
			r.data.text.startsWith(prev.text);
		const textChanged = prev === null || prev.kind !== r.data.kind || prev.text !== r.data.text;
		set({
			chatStreaming: {
				...r.data,
				appendFrom: appendable ? prev.text.length : 0,
				// 只在内容真变时 bump：轮询空转（服务端暂停思考）不能让同一段字反复淡入
				rev: (prev?.rev ?? 0) + (textChanged ? 1 : 0),
			},
		});
	},

	/**
	 * 请求停止当前 turn（2026-10-20 停止按钮）。
	 *
	 * 诚实口径：POST accepted **不等于已停止**。这里只负责「把请求递进去」，
	 * 真实结果由 `pollChatControl` 从 `state/session-control/` 读回执（aborted / not-streaming）。
	 *
	 * 幂等：`commandKey` 只生成一次并留在 `chatControlKeyBySession`，重试同键不会重复排队。
	 */
	abortChatSession: async (sessionId) => {
		if (get().chatAborting) return; // 防连点（回执未到前不再发第二条）
		set({ chatAborting: true });
		try {
			const key = newCommandKey("abort");
			const r = await api.sessionAbort(sessionId, key);
			if (!r.ok) {
				// 不静默：把失败原因写进 chatControl 的形状（status=failed），UI 直接展示
				set({
					chatAborting: false,
					chatControl: {
						version: 1,
						sessionId,
						request: {
							version: 1,
							id: key,
							sessionId,
							action: "abort",
							commandKey: key,
							status: "failed",
							requestedAt: new Date().toISOString(),
							error: r.status === 401 ? "未授权（401）" : `请求失败（${r.status}）`,
						},
						ageMs: 0,
					},
				});
				return;
			}
			// accepted：立刻拉一次回执（会话进程 watch 200ms 内就会领取）
			void get().pollChatControl(sessionId);
		} finally {
			// 给回执一点时间；pollChatControl 自己会在拿到终态后清掉 chatAborting
			setTimeout(() => {
				if (get().chatAborting) set({ chatAborting: false });
			}, 4000);
		}
	},

	/**
	 * 拉一次控制回执。404（从没点过停止）= 正常态 ⇒ 置 null，不 markDown。
	 * 拿到终态（done/failed）后清掉 chatAborting，让按钮回到可用态。
	 */
	pollChatControl: async (id) => {
		if (id === null) {
			if (get().chatControl !== null) set({ chatControl: null });
			return;
		}
		const r = await api.sessionControl(id);
		if (!r.ok) {
			if (get().chatControl !== null) set({ chatControl: null });
			return;
		}
		if (r.data.sessionId !== id) return; // 防串台
		const done = r.data.request.status === "done" || r.data.request.status === "failed";
		set({ chatControl: r.data, ...(done ? { chatAborting: false } : {}) });
	},

	/**
	 * 拉一次「会话正忙」标记（2026-10-20）。404（not-busy）= 空闲 ⇒ false，不 markDown。
	 * 这是 turn 级权威信号，补上流式快照在「点发送→首个 token」与
	 * 「工具跑完→下一段输出」两段的空白。
	 */
	pollChatBusy: async (id) => {
		if (id === null) {
			if (get().chatBusyFlag) set({ chatBusyFlag: false });
			return;
		}
		const r = await api.sessionBusy(id);
		if (!r.ok) {
			if (get().chatBusyFlag) set({ chatBusyFlag: false });
			return;
		}
		if (r.data.sessionId !== id) return; // 防串台
		if (!get().chatBusyFlag) set({ chatBusyFlag: true });
	},

	/**
	 * 拉一次命令快照（2026-10-20）。404（no-commands-snapshot）= 不可用 ⇒ null。
	 * 不可用不是错误（扩展可能未 reload），但 UI 必须能区分「没有命令」与「拿不到命令」。
	 */
	pollChatCommands: async (id) => {
		if (id === null) {
			if (get().chatCommands !== null) set({ chatCommands: null });
			return;
		}
		const r = await api.sessionCommands(id);
		if (!r.ok) {
			if (get().chatCommands !== null) set({ chatCommands: null });
			return;
		}
		if (r.data.sessionId !== id) return; // 防串台
		set({ chatCommands: r.data });
	},

	/**
	 * 派发斜杠命令（2026-10-20）。
	 *
	 * 诚实口径：POST accepted ≠ 命令已执行。真实结果由 `pollChatControl` 读回执：
	 *   dispatched（已交给 pi）/ unknown-command（命令名不在快照里）/ commands-unavailable。
	 */
	sendChatSlash: async (sessionId, name, args) => {
		const key = newCommandKey("slash");
		set({ chatAborting: true }); // 复用「等回执」锁：防连点重复派发
		try {
			const r = await api.sessionSlash(sessionId, name, args, key);
			if (!r.ok) {
				set({
					chatAborting: false,
					chatControl: {
						version: 1,
						sessionId,
						request: {
							version: 1,
							id: key,
							sessionId,
							action: "abort", // 仅借用形状（UI 只看 status/error）
							commandKey: key,
							status: "failed",
							requestedAt: new Date().toISOString(),
							error: r.status === 401 ? "未授权（401）" : `命令请求失败（${r.status}）`,
						},
						ageMs: 0,
					},
				});
				return;
			}
			void get().pollChatControl(sessionId);
		} finally {
			setTimeout(() => {
				if (get().chatAborting) set({ chatAborting: false });
			}, 4000);
		}
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
	reloadChatSession: async (id, tail) => {
		// L2 perf（2026-10-20，用户诉求「从最新消息开始读，不要一下拉全部」）：首屏只取最新
		// TAIL_FIRST 行（`?tail=`）；响应带 hasOlder ⇒ GUI 显示「加载更早」，点一次 tail 翻倍。
		// 实测（15.4MB / 6315 行会话）：服务端 104ms → 32-45ms，响应体 6.5MB → ~200KB。
		const want = tail ?? get().chatTailBySession[id] ?? TAIL_FIRST;
		const r = await api.transcript(id, undefined, want);
		if (!r.ok) return;
		const rows = r.data.rows;
		set({
			chatRowsBySession: { ...get().chatRowsBySession, [id]: rows },
			chatHeadBySession: { ...get().chatHeadBySession, [id]: r.data.head },
			chatSeqBySession: { ...get().chatSeqBySession, [id]: r.data.head?.seq ?? 0 },
			chatHasOlderBySession: { ...get().chatHasOlderBySession, [id]: r.data.hasOlder === true },
			chatTailBySession: { ...get().chatTailBySession, [id]: Math.max(want, rows.length) },
		});
		get().markUp(r.at);
	},

	/**
	 * 拉取新 notify → toast（2026-10-21）。
	 *
	 * 纪律：
	 * - 按 offset 增量，无新内容不发请求体外的副作用
	 * - **静默态不打扰**：absent（无文件）直接返回
	 * - 同 text 去重（`dedupeKey`）防同一句话在轮询里反复弹
	 * - 失败什么也不做（notify 是辅助通道）
	 */
	pollNotify: async (id) => {
		if (id === null) return;
		const after = get().notifyOffsetBySession[id] ?? 0;
		const r = await api.notify(id, after > 0 ? after : undefined);
		if (!r.ok) return;
		const { records, nextOffset } = r.data;
		if (nextOffset > after) {
			set({ notifyOffsetBySession: { ...get().notifyOffsetBySession, [id]: nextOffset } });
		}
		if (records.length === 0) return;
		for (const rec of records) pushNotifyToast(rec);
	},

	/**
	 * 刷新会话上下文用量（2026-10-21）。
	 *
	 * 失败**保留旧值**：usage 是辅助读数，一次拉不到不该让工具栏闪成「--」。
	 */
	refreshChatUsage: async (id) => {
		const r = await api.usage(id);
		if (!r.ok) return;
		set({ chatUsageBySession: { ...get().chatUsageBySession, [id]: r.data } });
	},

	/** 0923 2003 C3②：WS 重连强制 resync——启用 client.ts transcript 的 after= 增量：
	 *  有 head → GET ?after=head.seq 拿「触及行终态」按 rowId upsert 合并（回填保位、新行按响应
	 *  序追加）；无 head 或增量失败 → 回退全量 reloadChatSession。rowId 幂等 + seq 倒退防御
	 *  （applyChatFrame）保证双通道不重不漏。 */
	resyncChatSession: async (id) => {
		const head = get().chatHeadBySession[id];
		const canDelta = head !== null && head !== undefined && head.seq > 0;
		const r = canDelta ? await api.transcript(id, head.seq) : await api.transcript(id);
		if (!r.ok) {
			if (canDelta) await get().reloadChatSession(id);
			return;
		}
		// WS 帧可能在 HTTP 请求途中先到；不得让较旧响应倒退 head/覆盖较新行。
		const currentSeq = get().chatSeqBySession[id] ?? 0;
		const responseSeq = r.data.head?.seq ?? 0;
		if (currentSeq > responseSeq) return;
		if (r.data.mode === "delta") {
			const rows = get().chatRowsBySession[id] ?? [];
			const merged = rows.slice();
			for (const row of r.data.rows) {
				const idx = merged.findIndex((m) => m.rowId === row.rowId);
				if (idx >= 0) merged[idx] = row; // 回填：保原位、换终态
				else merged.push(row); // 新行：按响应（投影）序追加
			}
			set({
				chatRowsBySession: { ...get().chatRowsBySession, [id]: merged },
				chatHeadBySession: { ...get().chatHeadBySession, [id]: r.data.head },
				chatSeqBySession: { ...get().chatSeqBySession, [id]: r.data.head?.seq ?? head?.seq ?? 0 },
			});
		} else {
			set({
				chatRowsBySession: { ...get().chatRowsBySession, [id]: r.data.rows },
				chatHeadBySession: { ...get().chatHeadBySession, [id]: r.data.head },
				chatSeqBySession: { ...get().chatSeqBySession, [id]: r.data.head?.seq ?? 0 },
			});
		}
		get().markUp(r.at);
	},

	openChatSession: async (id) => {
		set({ chatActiveId: id });
		await get().reloadChatSession(id);
		// 用量与 transcript 同源，同频拉一次（不单独轮询）
		void get().refreshChatUsage(id);
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
		// 0923 2003 C4：journal 主题（全量事件流 → envelope 按 id 并入 timeline；推进续传指针）。
		// HTTP 2s 轮询保留作 WS 断开兜底，双通道按 id 去重天然不重复。
		if (frame.topic === "journal") {
			if (frame.type === "ack") {
				if (frame.head !== null) set({ chatJournalHead: frame.head });
				// 跨代 → 换新 head 重订阅（journal 自身即重放源，免 HTTP GET）；
				// head=null（journal 缺失）不 bump，防无限重连循环——HTTP 轮询兼覆盖
				if (frame.mode === "snapshot" && frame.head !== null) get().bumpChatResync();
				return;
			}
			if (frame.type === "resync") {
				set({ chatJournalHead: null });
				get().bumpChatResync();
				return;
			}
			if (frame.type === "event" && frame.envelope !== undefined) {
				const env = frame.envelope as RuntimeEnvelope;
				if (typeof env.id !== "string" || env.id.length === 0) return;
				const prev = get().chatJournalHead;
				set({
					timeline: capTimelineItems(mergeTimelineItems(get().timeline, [envelopeToTimelineItem(env)]), get().historyAnchorId),
					chatJournalHead: prev !== null ? { ...prev, seq: Math.max(prev.seq, frame.seq) } : { seq: frame.seq, logEpoch: "" },
				});
				return;
			}
			return;
		}
		// 0923 2003 C4：interactions 主题（状态投影：每帧全量替换，订阅即重放全量）
		if (frame.topic === "interactions") {
			if (frame.type === "event" && frame.op !== undefined && frame.op.kind === "state.updated") {
				const items = (frame.op.patch as { interactions?: unknown }).interactions;
				if (Array.isArray(items)) set({ interactions: items as InteractionItem[] });
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
