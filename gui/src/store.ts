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
import type {
	AttentionItem,
	CommandOutcomeBody,
	HealthView,
	RuntimeEnvelope,
	RuntimeSnapshot,
	TimelineItem,
} from "./api/types";

export type TabId = "master" | "workstream" | "attention" | "timeline" | "runtime";

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

/** timeline 合并上限（events 增量 + before= 历史页共用；硬顶防长会话内存漂移）。 */
const TIMELINE_CAP = 2000;

export interface CommandReceipt {
	at: string;
	summary: string;
}

interface GuiState {
	// UI
	activeTab: TabId;
	setActiveTab: (t: TabId) => void;

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
	/** G5.2：before= 翻页已到最早（服务端返回空集/不足一页时置位，「加载更早」停用）。 */
	timelineEnd: boolean;
	attention: AttentionItem[];
	attentionIncludeResolved: boolean;
	setAttentionIncludeResolved: (v: boolean) => void;
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
	pollTimeline: () => Promise<void>;
	/** G5.2：before= 历史翻页（加载更早；幂等可重按，end 后 no-op）。 */
	loadEarlierTimeline: () => Promise<void>;
}

function isResync(e: FetchErr): boolean {
	return e.resync === true;
}

export const useGui = create<GuiState>((set, get) => ({
	activeTab: "master",
	setActiveTab: (t) => set({ activeTab: t }),

	connection: "down",
	lastAsOf: null,
	markUp: (at) => set({ connection: "up", lastAsOf: at }),
	markDown: (_at) => set({ connection: "down" }),

	health: null,
	snapshot: null,
	timeline: [],
	timelineEnd: false,
	attention: [],
	attentionIncludeResolved: false,
	setAttentionIncludeResolved: (v) => set({ attentionIncludeResolved: v }),
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
				const byId = new Map(timeline.map((t) => [t.id, t]));
				for (const it of incoming) byId.set(it.id, it);
				const merged = [...byId.values()]
					.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
					.slice(-TIMELINE_CAP);
				set({ timeline: merged, nextCursor: r.data.nextCursor });
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

	/** timeline 尾窗全量（无 cursor）按 id 合并：server 精修版覆盖 events 客户端映射版。 */
	pollTimeline: async () => {
		const r = await api.timeline(200);
		if (r.ok) {
			const byId = new Map(get().timeline.map((t) => [t.id, t]));
			for (const it of r.data.timeline) byId.set(it.id, it);
			set({
				timeline: [...byId.values()]
					.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
					.slice(-TIMELINE_CAP),
			});
			get().markUp(r.at);
		} else {
			get().markDown(r.at);
		}
	},

	/** G5.2：加载更早（before= 最旧条目，排他上界）。返回空/不足一页 → timelineEnd 停用按钮。 */
	loadEarlierTimeline: async () => {
		const { timeline, timelineEnd } = get();
		if (timelineEnd || timeline.length === 0) return;
		const oldest = timeline[0]?.id;
		if (!oldest) return;
		const r = await api.timeline(200, oldest);
		if (!r.ok) {
			get().markDown(r.at);
			return;
		}
		if (r.data.timeline.length === 0) {
			set({ timelineEnd: true });
			get().markUp(r.at);
			return;
		}
		const byId = new Map(get().timeline.map((t) => [t.id, t]));
		for (const it of r.data.timeline) byId.set(it.id, it);
		set({
			timeline: [...byId.values()]
				.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
				.slice(-TIMELINE_CAP),
			// 满一页 → 可能还有更早；不足一页 → 已到最早
			timelineEnd: r.data.timeline.length < 200,
		});
		get().markUp(r.at);
	},
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
