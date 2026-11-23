/**
 * gui/src/rightRail/panels.ts — 右栏**轻注册表**（设计稿 §3.4）。
 *
 * 契约只有一条：**加面板 = 往 `RAIL_PANELS` 追加一个 `{ id, zh, icon, render }`，不改壳**。
 * `RightRail.tsx` 不得出现任何面板 id / 面板名 —— 它只做几何/折叠/切换/挂载卸载；
 * 加载、空态、错误一律由面板自己管（`DispatchedPanel` 自管三态空态与门控）。
 *
 * 刻意**不做**：通用 `RailState`、徽标订阅体系、面板间共享 store slice（P2 再谈，
 * 且徽标计数口径必须走 `runsView.ts::deriveRunDisplay`，不能自己数 status）。
 */

import type { FC } from "react";
import type { LucideIcon } from "lucide-react";
import { FileText, PlayCircle, StickyNote, Zap } from "lucide-react";
import { DispatchedPanel } from "./DispatchedPanel";
import { DocPreviewPanel } from "./DocPreviewPanel";
import { NotePanel } from "./NotePanel";
import { ShortcutsPanel } from "./ShortcutsPanel";
import { PANEL_DISPATCHED, PANEL_DOC, PANEL_NOTE, PANEL_SHORTCUTS } from "./railState";

export interface RailPanel {
	/** 稳定 id（进 `store.railPanel`；**不持久化**，所以改 id 不会破坏老数据）。 */
	id: string;
	/** 中文短名（顶栏 tooltip / 面板切换条）。 */
	zh: string;
	/** 切换条与顶栏入口用的图标。 */
	icon: LucideIcon;
	/** 面板组件（**只有被选中且右栏展开时才挂载** ⇒ 不轮询）。 */
	render: FC;
}

/** 四块面板：本会话派发的 subagent + 本会话旁路便签 + 文档预览 + 仓库快捷按钮（2026-11-20）。 */
export const RAIL_PANELS: RailPanel[] = [
	{ id: PANEL_DISPATCHED, zh: "派发", icon: PlayCircle, render: DispatchedPanel },
	{ id: PANEL_NOTE, zh: "便签", icon: StickyNote, render: NotePanel },
	// 文档预览放在倒数第二：点击回复中的路径会自动切到这块；不改变前两块面板的默认顺序/门控。
	{ id: PANEL_DOC, zh: "预览", icon: FileText, render: DocPreviewPanel },
	// 仓库快捷按钮放最后：按当前仓库 cwd 隔离，独立 gate（workspace tab 下也可轮询）。
	{ id: PANEL_SHORTCUTS, zh: "按钮", icon: Zap, render: ShortcutsPanel },
];

/** 顶栏入口 tooltip 用的当前面板名（未知 id 回落第一个，与 `railPanelById` 同口径）。 */
export function railPanelName(id: string): string {
	for (const p of RAIL_PANELS) if (p.id === id) return p.zh;
	return RAIL_PANELS[0]?.zh ?? "";
}
