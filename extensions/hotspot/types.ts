/**
 * hotspot/types — Hotspot v4 数据模型与常量（短期工作集 projection）
 *
 * 设计：plans/0924_hotspot_v4_ephemeral_working_set.md（v4）；
 * 实现：plans/0924_hotspot_v4_impl_plan.md §B。
 * - Hotspot = 可丢失、可重建、非权威的短期工作集缓存（task/workstream → 最近读写文件）
 * - 旧 v2 路由缓存（upsert/remove/rel/graph/pending，托管 Wiki/_hotspot.md）已整体退役，
 *   本文件不再定义其数据模型；不读写 Wiki/_hotspot.md（拍板 #9）
 * - 存储目录：<agentDir>/hotspot/<wsid>/（见 store.ts）
 */

export const SCHEMA_VERSION = 4;

/** 半衰期 12h：score 每 12h 减半。 */
export const HALF_LIFE_MS = 12 * 3600_000;
/** soft TTL 48h：soft 后条目不再参与注入，lookup/诊断仍可见。 */
export const SOFT_TTL_MS = 48 * 3600_000;
/** hard TTL 72h：hard 后条目从投影剪除（读侧窗口 = now - HARD_TTL_MS）。 */
export const HARD_TTL_MS = 72 * 3600_000;

/** 事件权重（v4 §7 初值）：write=3 / read=1 / test=2。 */
export const WEIGHTS = { write: 3, read: 1, test: 2 } as const;

/** 每 run（agent_start→agent_end）每文件每 kind 最多落盘的事件条数（拍板 #5）。 */
export const RUN_CAP = { read: 4, write: 3, test: 2 } as const;

/** 投影/snapshot 条目上限。 */
export const WORKSET_TOP_N = 50;

/** 注入预算：≤5 条、≥2 条才注入；字符预算 ≈160 token ×3.5 chars/token（沿用 v2 估算口径），超预算整条省略不截断。 */
export const INJECT_MAX_FILES = 5;
export const INJECT_MIN_FILES = 2;
export const INJECT_CHAR_BUDGET = 560;

/** 沿用 v2 旧值：语义仍是"已注入"，老会话里的旧标记也能挡重复注入。 */
export const INJECT_CUSTOM_TYPE = "hotspot-injected";

/** snapshot 节流间隔（主会话 agent_end 时）。 */
export const SNAPSHOT_MIN_INTERVAL_MS = 5 * 60_000;

export type HotKind = "write" | "read" | "test";
export type HotScope = "tab" | "main" | "subagent";

/** 事件（分片行，JSONL；taskId/wsId 可空 = workspace 级）。 */
export interface HotEvent {
	v: 4;
	/** ISO-8601 */
	at: string;
	kind: HotKind;
	/** 仓库相对路径（正斜杠；从不存目录路径） */
	path: string;
	scope: HotScope;
	taskId?: string;
	wsId?: string;
}

/** 投影/snapshot 条目（hard TTL 外已剪除，故 ttl 只有 fresh/soft）。 */
export interface HotEntry {
	path: string;
	score: number;
	lastSeen: string;
	lastSeenMs: number;
	kinds: HotKind[];
	/** 窗口内计数 */
	counts: { write: number; read: number; test: number };
	lastTestAt?: string;
	taskId?: string;
	wsId?: string;
	ttl: "fresh" | "soft";
}

/** 派生缓存：可删可重建；读取方（tool/inject/command）直接读分片，snapshot 仅供诊断/未来 GUI。 */
export interface HotspotSnapshot {
	schema: 4;
	wsid: string;
	generatedAt: string;
	halfLifeMs: number;
	entries: HotEntry[];
}

export function nowIso(ms?: number): string {
	return new Date(ms ?? Date.now()).toISOString();
}

/** 总开关（§J.2 回退）：PI_HOTSPOT_ENABLED=0 → 采集/注入/工具/命令全部不注册。缺省开。 */
export function hotspotEnabled(): boolean {
	const v = process.env.PI_HOTSPOT_ENABLED;
	return !(v !== undefined && (v === "0" || v === "false"));
}

/**
 * 渲染侧字段转义（L4 must-fix 1b；MF-2 共享化）：控制字符（含换行/回车/制表/C0/DEL，
 * 防伪造行）→ 空格，`<`/`>` → 全角（防伪造标签）。inject/command/tool 渲染存储或
 * 外部身份来源的字符串字段时统一走此单一实现，禁止各自复制漂移。
 */
export function esc(s: string): string {
	return s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/</g, "＜").replace(/>/g, "＞");
}
