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

/** 当前唯一面板 id（`RAIL_PANELS` 里的第一个也是它）。 */
export const PANEL_DISPATCHED = "dispatched";

/** 宽屏断点（设计稿 §6 待拍板 1 的建议默认：`≥1280px` 默认展开）。 */
export const RAIL_WIDE_QUERY = "(min-width: 1280px)";

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
 *   ① 右栏展开   ② 当前面板 = 派发   ③ 有活动会话
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
	if (input.railPanel !== PANEL_DISPATCHED) return false;
	if (typeof input.chatActiveId !== "string" || input.chatActiveId.length === 0) return false;
	if (input.activeTab !== "chat") return false;
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
