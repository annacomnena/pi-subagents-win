/**
 * gui/src/rightRail/railState.ts — 右栏的**纯逻辑**（无 React / 无 JSX，供 node 直载测试）。
 *
 * 为什么单独一个 `.ts`：`RightRail.tsx` / `DispatchedPanel.tsx` 是 `.tsx`，
 * 本仓的 gui 测试跑在 `node --experimental-strip-types`（**不转 JSX**）⇒ `.tsx` 只能做源码串断言。
 * 所以凡是「必须被断言判死」的判据（门控真值表、空态选择、注册表解析、默认展开）
 * 一律落在本文件，`.tsx` 只负责把它们接到 React 上。
 *
 * 本文件刻意**不**造通用 `RailState` / 徽标订阅体系（设计稿 §3.4：壳保持轻，
 * 徽标/计数留 P2，且口径必须走 `runsView.ts::deriveRunDisplay`）。
 */

import type { RunsResponse } from "../api/types";

/** 派发面板 id（`RAIL_PANELS` 里的第一个也是它）。 */
export const PANEL_DISPATCHED = "dispatched";
/** 会话便签面板 id（2026-11-17：per-session 旁路便签，与派发共享轮询门控）。 */
export const PANEL_NOTE = "note";
/** 文档预览面板 id（2026-11-20：点击 assistant 回复中的文件路径后切换过去）。 */
export const PANEL_DOC = "doc";
/** 仓库快捷按钮面板 id（2026-11-20：按当前仓库 cwd 隔离的可点击动作）。 */
export const PANEL_SHORTCUTS = "shortcuts";

/** 宽屏断点（设计稿 §6 待拍板 1 的建议默认：`≥1280px` 默认展开）。 */
export const RAIL_WIDE_QUERY = "(min-width: 1280px)";

/** 右栏默认宽度（设计稿 §6 建议值；也是双击复位值）。 */
export const RAIL_DEFAULT_WIDTH = 320;
/** 右栏最小宽度：再窄「派发/便签」行会明显挤压。 */
export const RAIL_MIN_WIDTH = 260;
/** 右栏绝对最大宽度：再宽中央对话列会难以阅读。 */
export const RAIL_MAX_WIDTH = 720;
/** 左栏固定宽度（`pages/Sidebar.tsx` 的 `w-[264px]`）。 */
export const SIDEBAR_WIDTH = 264;
/** 中央内容列最小宽度（`App.tsx` 壳的 `min-w-[320px]`）。 */
export const MAIN_MIN_WIDTH = 320;
/** localStorage key（与 `saw-ws-*` 同族；值 = 十进制像素数）。 */
export const RAIL_WIDTH_STORAGE_KEY = "saw-right-rail-width";

/** 只依赖 get/setItem 的存储最小面：node 测试可直接注入 Map 桩，不必造完整 Storage。 */
export interface RailWidthStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

function defaultRailWidthStorage(): RailWidthStorage | null {
	try {
		return typeof localStorage === "undefined" ? null : localStorage;
	} catch {
		return null;
	}
}

/**
 * 当前视口下右栏允许的最大宽度。
 *
 * 上限不是纯常量：`viewport - 左栏 264 - 中央列最小 320`，再夹到 720。
 * 这样 1280px 宽屏最多 696px，不会把中央对话列压到 320 以下。
 * 非有限/非正 viewport（SSR/测试异常）⇒ 退回绝对上限（调用方本就会 clamp 到默认值）。
 */
export function railMaxWidth(viewportWidth: number): number {
	if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return RAIL_MAX_WIDTH;
	const available = Math.floor(viewportWidth - SIDEBAR_WIDTH - MAIN_MIN_WIDTH);
	return Math.max(RAIL_MIN_WIDTH, Math.min(RAIL_MAX_WIDTH, available));
}

/** 宽度钳制：非有限值 ⇒ 默认 320；其余夹到 `[260, 当前视口上限]`。 */
export function clampRailWidth(width: number, viewportWidth: number): number {
	if (!Number.isFinite(width)) return RAIL_DEFAULT_WIDTH;
	return Math.min(Math.max(Math.round(width), RAIL_MIN_WIDTH), railMaxWidth(viewportWidth));
}

/**
 * 读取持久化宽度并**按当前视口重新钳制**（旧视口下存的 700 在新视口可能超限）。
 * 无存储/无值/坏值/存储异常一律回默认 320（与 workspaceSort 同一容错口径）。
 *
 * 注意：localStorage 按 origin（含端口）隔离，daemon 换端口后会读不到——这是既有
 * GUI 偏好的共同边界，不影响本次运行内刷新记忆。
 */
export function loadRailWidth(
	viewportWidth: number,
	storage: RailWidthStorage | null = defaultRailWidthStorage(),
): number {
	try {
		const raw = storage?.getItem(RAIL_WIDTH_STORAGE_KEY) ?? null;
		if (raw === null || raw.trim() === "") return clampRailWidth(RAIL_DEFAULT_WIDTH, viewportWidth);
		const parsed = Number(raw);
		return Number.isFinite(parsed) ? clampRailWidth(parsed, viewportWidth) : clampRailWidth(RAIL_DEFAULT_WIDTH, viewportWidth);
	} catch {
		return clampRailWidth(RAIL_DEFAULT_WIDTH, viewportWidth);
	}
}

/** 写入前再次钳制；存储异常（隐私模式/配额）静默吞掉，不阻断拖拽。返回实际生效宽度。 */
export function saveRailWidth(
	width: number,
	viewportWidth: number,
	storage: RailWidthStorage | null = defaultRailWidthStorage(),
): number {
	const clamped = clampRailWidth(width, viewportWidth);
	try {
		storage?.setItem(RAIL_WIDTH_STORAGE_KEY, String(clamped));
	} catch {
		/* best effort */
	}
	return clamped;
}

/**
 * 注册表条目的**结构最小面**（`panels.ts::RailPanel` 是它的超集）。
 * 用泛型而不是 at 上 `RailPanel`：本文件要能被 node 直载，不能 import `.tsx`（内含面板组件）。
 */
export interface RailPanelMeta {
	id: string;
	zh: string;
}

/**
 * 按 id 找面板；**未知 id 回落第一个**（而不是渲染空白）。
 *
 * 回落而不是抛：`railPanel` 是内存态（不持久化），但后面若做持久化/多窗口，
 * 旧 id 落进新注册表是常态 —— 那时右栏应显示「默认面板」，而不是一片空白且无提示。
 */
export function railPanelById<T extends RailPanelMeta>(panels: readonly T[], id: string): T | null {
	if (panels.length === 0) return null;
	for (const p of panels) if (p.id === id) return p;
	return panels[0] ?? null;
}

/**
 * 右栏轮询门控（设计稿 §3.6；验收 9）。
 *
 * 五个条件必须**同时**成立：
 *   ① 右栏展开   ② 当前面板 = 派发 或 会话便签   ③ 有活动会话
 *   ④ 主视图是 chat（时间线视图不轮询）  ⑤ 覆盖层未开（否则与 RunsPage 双路打同一端点）
 *
 * 单独抽出来是为了能钉死真值表：任一条缺失都必须 `false`。
 * ⚠️ 反例形态（变异应红）：`return true`、或只判 `railOpen`。
 */
export interface RailGateInput {
	railOpen: boolean;
	railPanel: string;
	chatActiveId: string | null;
	activeTab: string;
	runtimeOverlay: string | null;
}

export function railPollingEnabled(input: RailGateInput): boolean {
	if (!input.railOpen) return false;
	// 两块面板都需要按会话轮询；未知面板 id 一律不轮询（R-2：不把「门控放太宽」当成省事）。
	if (input.railPanel !== PANEL_DISPATCHED && input.railPanel !== PANEL_NOTE) return false;
	if (typeof input.chatActiveId !== "string" || input.chatActiveId.length === 0) return false;
	if (input.activeTab !== "chat") return false;
	if (input.runtimeOverlay !== null) return false;
	return true;
}

/** 快捷按钮面板的独立 gate（设计稿 §4.4）。
 *
 * 不复用 railPollingEnabled：① 它硬编码只认两个面板；② 它要求 activeTab==="chat"，
 * 而进仓库主页时 activeTab 会被置为 "workspace"（store.ts::setActiveWorkspace）——
 * 复用会让面板在仓库页永久不轮询。快捷按钮按 cwd 而非会话隔离，所以只需 cwd 非空。
 */
export interface ShortcutsGateInput {
	railOpen: boolean;
	railPanel: string;
	cwd: string | null;
	runtimeOverlay: string | null;
}
export function shortcutsPollingEnabled(input: ShortcutsGateInput): boolean {
	if (!input.railOpen) return false;
	if (input.railPanel !== PANEL_SHORTCUTS) return false;
	if (typeof input.cwd !== "string" || input.cwd.length === 0) return false;
	if (input.runtimeOverlay !== null) return false;
	return true;
}

/** 空态三态（设计稿 §3.5：文案必须分开，不许合并成一句“暂无数据”）。 */
export type DispatchedEmptyKind = "no-dispatch" | "attribution-partial" | "attribution-unavailable";

export interface DispatchedEmpty {
	kind: DispatchedEmptyKind;
	/** 主文案（按设计稿原文）。 */
	text: string;
	/** 副文案：解释「为什么」，避免用户把「读不到」当成「没派发」。 */
	hint: string;
}

/**
 * 选中空态（**三种**，见设计稿 §3.5）。
 *
 * 判定顺序（顺序本身是语义，不可调换）：
 *   1. 没有活动会话 ⇒ `no-dispatch`（未选择会话，本就没查）
 *   2. 有数据且非空 ⇒ `null`（**不是空态**，列表自己渲染）
 *   3. 无数据且未失败 ⇒ `null`（加载中，由调用方渲染「正在加载」，不算空）
 *   4. 请求失败 / 无响应 / `attribution === "unavailable"` ⇒ `attribution-unavailable`
 *      （**读失败 ≠ 没有派发**：这条混同会让用户以为“本会话没派过活”）
 *   5. `tabUnmapped > 0` ⇒ `attribution-partial`（存量 tab 记录无法归属）
 *   6. 其余 ⇒ `no-dispatch`
 */
export function pickDispatchedEmpty(input: {
	hasSession: boolean;
	resp: RunsResponse | null;
	failed: boolean;
}): DispatchedEmpty | null {
	const { hasSession, resp, failed } = input;
	if (!hasSession) {
		return {
			kind: "no-dispatch",
			text: "本会话暂无派发",
			hint: "未选择会话——右栏只显示当前会话派发的 subagent",
		};
	}
	if (resp !== null && resp.runs.length > 0) return null;
	if (resp === null && !failed) return null; // 加载中
	if (failed || resp === null || resp.attribution === "unavailable") {
		return {
			kind: "attribution-unavailable",
			text: "归属信息不可用（读取失败）",
			hint: "归属账本（links.jsonl）读不到或异常率过高 ⇒ 无法判断哪些 run 由本会话派发；这不是「没有派发」",
		};
	}
	const tabUnmapped = typeof resp.attributionDetail?.tabUnmapped === "number" ? resp.attributionDetail.tabUnmapped : 0;
	if (tabUnmapped > 0) {
		return {
			kind: "attribution-partial",
			text: `归属不完整（另有 ${tabUnmapped} 条 tab 来源未关联）`,
			hint: "这些 run 的派发者是 tab id 且无 ownerSessionId（写时双身份上线前的存量记录），无法映射到本会话",
		};
	}
	return { kind: "no-dispatch", text: "本会话暂无派发", hint: "本会话还没有派出过 subagent（记录目录里没有可归属的 run）" };
}

/**
 * 列表**非空**时的归属提示（`partial`/`unavailable` 仍要说出来，否则用户以为看到的是全部）。
 * 空列表由 `pickDispatchedEmpty` 负责，两者不重叠。
 */
export function attributionNotice(resp: RunsResponse | null): string | null {
	if (resp === null || resp.runs.length === 0) return null;
	if (resp.attribution === "unavailable") return "归属信息不可用（读取失败）：本列表可能漏掉本会话的派发";
	const tabUnmapped = typeof resp.attributionDetail?.tabUnmapped === "number" ? resp.attributionDetail.tabUnmapped : 0;
	if (tabUnmapped > 0) return `归属不完整（另有 ${tabUnmapped} 条 tab 来源未关联）`;
	return null;
}

/**
 * 默认展开态（设计稿 §6 待拍板 1：`≥1280px` 默认展开）。
 *
 * `matches` 由调用方注入（`(q) => window.matchMedia(q).matches`）：
 * 本文件不碰 `window`（node 直载 + SSR 安全）；取不到 media query 一律**收起**（宁可少占屏）。
 */
export function railOpenDefault(matches: (query: string) => boolean): boolean {
	try {
		return matches(RAIL_WIDE_QUERY) === true;
	} catch {
		return false;
	}
}
