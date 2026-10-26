/**
 * gui/src/rightRail/RightRail.tsx — 右栏**壳**（设计稿 §3.1/§3.4；P1B）。
 *
 * ## 壳只做四件事
 *
 * 几何（320px）· 展开/收起 · 面板切换 · **条件挂载**（未展开或未选中 ⇒ 不渲染面板组件 ⇒ 不轮询）。
 * 加载/空态/错误一律归面板自己（`DispatchedPanel`）——壳里**没有任何面板 id / 面板名**，
 * 加面板只需往 `panels.ts::RAIL_PANELS` 追加一项（本文件零改动，验收 11）。
 *
 * ## 折叠范式照 `Sidebar.tsx:27-33`
 *
 * 折叠 = **宽度归零 + pointer-events-none + opacity-0**（`transition-[width,opacity] duration-200 ease-out`），
 * **不做 40px 竖条**（那是另一种交互范式，会与左栏不一致）。
 *
 * ## 窄屏（`<1280px`）
 *
 * 默认收起（`store.railOpen` 的初值由 `matchMedia(RAIL_WIDE_QUERY)` 求值），但顶栏入口照常可开 ——
 * 打开时变**固定定位抽屉**（`absolute inset-y-0 right-0 top-12`，带可点击关闭的背板），
 * 不是「功能消失」。宽屏时是第三列（`flex-none w-[320px]`），挤压的是中央对话列，
 * 退让方式与左栏一致（中央 `min-w-0` + 截断）。
 */

import { useEffect, useState } from "react";
import { PanelRightClose } from "lucide-react";
import { useGui } from "../store";
import { Button } from "../ui/button";
import { RAIL_PANELS } from "./panels";
import { RAIL_WIDE_QUERY, railOpenDefault, railPanelById } from "./railState";

/** 宽 320px（设计稿 §6 待拍板 2 的建议默认值）。 */
const RAIL_WIDTH_CLASS = "w-[320px]";

/** 当前视口是否**窄**（无 matchMedia 环境 ⇒ 不按窄屏处理：SSR/测试下退化为宽屏列）。 */
function readNarrow(): boolean {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
	return !railOpenDefault((q) => window.matchMedia(q).matches);
}

export function RightRail() {
	const open = useGui((s) => s.railOpen);
	const setRailOpen = useGui((s) => s.setRailOpen);
	const panelId = useGui((s) => s.railPanel);
	const setRailPanel = useGui((s) => s.setRailPanel);

	// 窄屏判定走 media query 订阅（而不是 `hidden xl:flex`）：因为**抽屉 vs 第三列**是行为差异，
	// 不只是可见性差异（抽屉需要背板与固定定位）。`hidden xl:*` 只能当视觉兜底。
	const [narrow, setNarrow] = useState(readNarrow);
	useEffect(() => {
		if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
		const mql = window.matchMedia(RAIL_WIDE_QUERY);
		const onChange = (): void => setNarrow(!mql.matches);
		onChange();
		mql.addEventListener("change", onChange);
		return () => mql.removeEventListener("change", onChange);
	}, []);

	const panel = railPanelById(RAIL_PANELS, panelId);
	const drawer = narrow;

	// 条件挂载：只有「展开 ∧ 有面板」才取组件引用 ⇒ 收起时面板组件根本不挂载（不轮询、不持状态）。
	const PanelBody = open && panel !== null ? panel.render : null;

	return (
		<>
			{/* 抽屉背板（只在「窄屏 + 展开」时存在）：点击关闭；不盖住顶栏（入口钮可继续用）。 */}
			{drawer && open && (
				<div
					data-right-rail-backdrop="true"
					aria-hidden="true"
					onClick={() => setRailOpen(false)}
					className="absolute bottom-0 left-0 right-0 top-12 z-20 bg-black/30"
				/>
			)}
			<aside
				data-right-rail="true"
				aria-label="右侧面板"
				aria-hidden={open ? undefined : "true"}
				className={[
					// 折叠 = 宽度归零（左右栏同范式）；border 放在内层（照 Sidebar 的做法：0 宽下不留 1px 边线）。
					"min-h-0 overflow-hidden bg-sidebar duration-200 ease-out transition-[width,opacity]",
					open ? `${RAIL_WIDTH_CLASS} flex-none opacity-100` : "w-0 flex-none pointer-events-none opacity-0",
					// 抽屉：脱离文档流（不挤压中央列），定位到内容区右侧、顶栏之下。
					drawer ? "absolute bottom-0 right-0 top-12 z-20 shadow-overlay" : "",
				].join(" ")}
			>
				{PanelBody !== null && panel !== null && (
					<div className="flex h-full min-h-0 flex-col overflow-hidden border-l border-border">
						{/* 面板切换条：注册表驱动（现在只有一块；P2 加面板自动出现）。 */}
						<div className="flex shrink-0 items-center gap-1 border-b border-border px-1.5 py-1">
							{RAIL_PANELS.map((p) => {
								const Icon = p.icon;
								const active = p.id === panel.id;
								return (
									<Button
										key={p.id}
										type="button"
										variant="ghost"
										size="sm"
										aria-current={active ? "true" : undefined}
										aria-label={p.zh}
										title={`右侧面板：${p.zh}`}
										onClick={() => setRailPanel(p.id)}
										className={`justify-start gap-1 rounded-lg px-1.5 text-ui-base ${
											active ? "bg-selected text-foreground" : "text-foreground-subtle hover:bg-hover hover:text-foreground"
										}`}
									>
										<Icon className="size-3.5 shrink-0" aria-hidden="true" />
										<span className="truncate">{p.zh}</span>
									</Button>
								);
							})}
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								className="ml-auto"
								aria-label="收起右侧面板"
								title="收起右侧面板"
								onClick={() => setRailOpen(false)}
							>
								<PanelRightClose className="size-4" aria-hidden="true" />
							</Button>
						</div>
						<div className="min-h-0 flex-1 overflow-hidden">
							<PanelBody />
						</div>
					</div>
				)}
			</aside>
		</>
	);
}
