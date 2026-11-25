/**
 * gui/src/rightRail/RightRail.tsx — 右栏**壳**（设计稿 §3.1/§3.4；P1B）。
 *
 * ## 壳只做四件事
 *
 * 几何（默认 320px，可拖拽 260–720）· 展开/收起 · 面板切换 · **条件挂载**（未展开或未选中 ⇒
 * 不渲染面板组件 ⇒ 不轮询）。加载/空态/错误一律归面板自己（`DispatchedPanel`）——壳里
 * **没有任何面板 id / 面板名**，加面板只需往 `panels.ts::RAIL_PANELS` 追加一项
 * （本文件零改动，验收 11）。
 *
 * ## 宽度拖拽（2026-11-18）
 *
 * 左缘 6px 分隔条：pointer 拖拽 + ←/→ 键盘微调 + 双击复位。宽度上限按
 * `viewport - 左栏 264 - 中央列最小 320` 动态算（见 `railState.ts::railMaxWidth`），
 * 避免为了右栏把对话区压没；拖拽期间临时关掉 width 过渡，否则 200ms 动画会跟手迟滞。
 * 窄屏抽屉保持默认 320 且不启用拖拽（抽屉是覆盖层，拖宽只会遮住更多内容）。
 * 宽度持久化到 localStorage（同一次运行内刷新有效；端口变化后 origin 变，属既有边界）。
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
 * 不是「功能消失」。宽屏时是第三列（`flex-none` + 可拖拽宽度），挤压的是中央对话列，
 * 退让方式与左栏一致（中央 `min-w-0` + 截断）。
 */

import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { PanelRightClose } from "lucide-react";
import { useGui } from "../store";
import { Button } from "../ui/button";
import { RAIL_PANELS } from "./panels";
import {
	MAIN_MIN_WIDTH,
	RAIL_DEFAULT_WIDTH,
	RAIL_MIN_WIDTH,
	RAIL_WIDE_QUERY,
	SIDEBAR_WIDTH,
	clampRailWidth,
	loadRailWidth,
	railMaxWidth,
	railOpenDefault,
	railPanelById,
	saveRailWidth,
} from "./railState";

const KEY_STEP = 16;
const KEY_STEP_LARGE = 48;

/** 当前视口宽；SSR/测试（无 window）用「1280 宽屏」参考值，算出默认 320。
 *  用 documentElement.clientWidth 而不是 innerWidth：后者含竖向滚动条，会让上限多算 15–17px。 */
function currentViewportWidth(): number {
	if (typeof window === "undefined" || typeof document === "undefined") {
		return SIDEBAR_WIDTH + MAIN_MIN_WIDTH + RAIL_DEFAULT_WIDTH;
	}
	return document.documentElement.clientWidth || window.innerWidth;
}

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

	// 宽度是**组件本地态**：属于几何，不污染 store 的 railOpen/railPanel 语义。
	// 初值从 localStorage 读；坏值/无存储 → 默认 320（见 railState::loadRailWidth）。
	const [viewportWidth, setViewportWidth] = useState(currentViewportWidth);
	const [width, setWidth] = useState(() => loadRailWidth(currentViewportWidth()));
	const widthRef = useRef(width);
	widthRef.current = width;
	const [resizing, setResizing] = useState(false);
	const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);

	// 窄屏判定走 media query 订阅（而不是 `hidden xl:flex`）：因为**抽屉 vs 第三列**是行为差异，
	// 不只是可见性差异（抽屉需要背板与固定定位）。`hidden xl:*` 只能当视觉兜底。
	const [narrow, setNarrow] = useState(readNarrow);
	const drawer = narrow;
	useEffect(() => {
		if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
		const mql = window.matchMedia(RAIL_WIDE_QUERY);
		const onChange = (): void => setNarrow(!mql.matches);
		onChange();
		mql.addEventListener("change", onChange);
		return () => mql.removeEventListener("change", onChange);
	}, []);

	// 窗口缩放 ⇒ 同步视口 state（aria-valuemax/End 不滞后）并按新视口重新钳制，
	// 避免旧的 700px 把中央列压到 320 以下。即使宽度不变也要 set，保证 ARIA 上限跟着更新。
	useEffect(() => {
		if (typeof window === "undefined") return;
		const onResize = (): void => {
			const vw = currentViewportWidth();
			setViewportWidth(vw);
			const next = clampRailWidth(widthRef.current, vw);
			if (next === widthRef.current) return;
			widthRef.current = next;
			setWidth(next);
		};
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, []);

	// 拖拽中收起面板 / 跨过 1280 变抽屉 ⇒ resizer 会被卸载。必须在这里收尾，
	// 否则 body 的 col-resize + user-select:none 与 resizing=true 会永久卡住。
	useEffect(() => {
		if (open && !drawer) return;
		if (dragRef.current !== null) {
			dragRef.current = null;
			// 取消拖拽也保留已经拖到的宽度，避免“拖到 500 后窗口跨断点、刷新回旧值”。
			saveRailWidth(widthRef.current, currentViewportWidth());
		}
		setResizing(false);
	}, [open, drawer]);

	// 拖拽期全局 col-resize + 禁止选中；pointer capture 已保证事件不断，样式只是视觉收尾。
	useEffect(() => {
		if (!resizing || typeof document === "undefined") return;
		const prevCursor = document.body.style.cursor;
		const prevUserSelect = document.body.style.userSelect;
		document.body.style.cursor = "col-resize";
		document.body.style.userSelect = "none";
		return () => {
			document.body.style.cursor = prevCursor;
			document.body.style.userSelect = prevUserSelect;
		};
	}, [resizing]);

	const panel = railPanelById(RAIL_PANELS, panelId);
	const maxWidth = railMaxWidth(viewportWidth);
	// 抽屉固定默认宽：它覆盖中央列，拖宽只会遮住更多内容；桌面第三列才允许拖拽。
	const effectiveWidth = drawer ? RAIL_DEFAULT_WIDTH : clampRailWidth(width, viewportWidth);

	const applyWidth = (next: number, persist: boolean): void => {
		const vw = currentViewportWidth();
		setViewportWidth(vw);
		const clamped = clampRailWidth(next, vw);
		widthRef.current = clamped;
		setWidth(clamped);
		if (persist) saveRailWidth(clamped, vw);
	};

	/** 唯一收尾路径：pointerup / pointercancel / lostpointercapture / 卸载兜底都走这里。 */
	const finishResize = (e?: ReactPointerEvent<HTMLDivElement>): void => {
		const drag = dragRef.current;
		if (drag === null) return;
		dragRef.current = null;
		setResizing(false);
		if (e !== undefined) {
			try {
				if (e.currentTarget.hasPointerCapture(drag.pointerId)) e.currentTarget.releasePointerCapture(drag.pointerId);
			} catch {
				/* 捕获已被浏览器释放（卸载/取消） */
			}
		}
		saveRailWidth(widthRef.current, currentViewportWidth());
	};

	const onResizeStart = (e: ReactPointerEvent<HTMLDivElement>): void => {
		if (drawer || e.button !== 0) return;
		e.preventDefault();
		// preventDefault 会阻止浏览器给分隔条聚焦；显式补焦点，拖完能立刻用方向键。
		e.currentTarget.focus();
		dragRef.current = { pointerId: e.pointerId, startX: e.clientX, startWidth: widthRef.current };
		try {
			e.currentTarget.setPointerCapture(e.pointerId);
		} catch {
			// pointer 已失效/节点未连接：放弃这一次拖拽，别让 dragRef 悬空。
			dragRef.current = null;
			return;
		}
		setResizing(true);
	};

	const onResizeMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
		const drag = dragRef.current;
		if (drag === null || drag.pointerId !== e.pointerId) return;
		// 漏掉的 pointerup（例如鼠标在窗口外抬起）会让 buttons 归零：就地收尾，防“没按下也跟着动”。
		// 必须与捕获状态交叉验证：某些实现拖拽中也会报 buttons=0，单看它会变成“第一次移动就断”。
		if (e.buttons === 0 && !e.currentTarget.hasPointerCapture(e.pointerId)) {
			finishResize(e);
			return;
		}
		// 左移变宽、右移变窄：以按下时的宽度为基准算增量，避免按在 6px 热区内侧时跳变。
		applyWidth(drag.startWidth + (drag.startX - e.clientX), false);
	};

	const onResizeEnd = (e: ReactPointerEvent<HTMLDivElement>): void => {
		finishResize(e);
	};

	const onResizeKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
		const step = e.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
		let next: number | null = null;
		if (e.key === "ArrowLeft") next = widthRef.current + step;
		else if (e.key === "ArrowRight") next = widthRef.current - step;
		// 标准 splitter 语义：Home = 最小、End = 最大；默认 320 由双击复位负责。
		else if (e.key === "Home") next = RAIL_MIN_WIDTH;
		else if (e.key === "End") next = maxWidth;
		if (next === null) return;
		e.preventDefault();
		applyWidth(next, true);
	};

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
				data-rail-width={open ? effectiveWidth : 0}
				aria-label="右侧面板"
				aria-hidden={open ? undefined : "true"}
				style={open ? { width: `${effectiveWidth}px` } : undefined}
				className={[
					// 折叠 = 宽度归零（左右栏同范式）；border 放在内层（照 Sidebar 的做法：0 宽下不留 1px 边线）。
					// 拖拽中 transition-none：200ms width 过渡会让每一次 pointermove 都追不上手。
					"min-h-0 overflow-hidden bg-sidebar",
					resizing ? "transition-none" : "duration-200 ease-out transition-[width,opacity]",
					open ? "flex-none opacity-100" : "w-0 flex-none pointer-events-none opacity-0",
					// 抽屉：脱离文档流（不挤压中央列），定位到内容区右侧、顶栏之下。
					// ⚠️ absolute 与 relative 互斥（不能靠 CSS 产物顺序决胜）：非抽屉才给 relative
					// 作为分隔条的定位上下文；抽屉必须是 absolute。
					drawer ? "absolute bottom-0 right-0 top-12 z-20 shadow-overlay" : "relative",
				].join(" ")}
			>
				{/* 左缘拖拽热区：6px、仅桌面第三列可见；箭头键微调、双击复位、Home/End 到默认/上限。 */}
				{!drawer && open && (
					<div
						role="separator"
						aria-orientation="vertical"
						aria-label="调整右侧面板宽度"
						aria-valuemin={RAIL_MIN_WIDTH}
						aria-valuemax={maxWidth}
						aria-valuenow={effectiveWidth}
						tabIndex={0}
						title="拖动调整宽度，双击恢复默认"
						data-right-rail-resizer="true"
						onPointerDown={onResizeStart}
						onPointerMove={onResizeMove}
						onPointerUp={onResizeEnd}
						onPointerCancel={onResizeEnd}
						onLostPointerCapture={onResizeEnd}
						onDoubleClick={() => applyWidth(RAIL_DEFAULT_WIDTH, true)}
						onKeyDown={onResizeKeyDown}
						className={`absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize touch-none select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset ${
							resizing ? "bg-accent/40" : "bg-transparent hover:bg-accent/30"
						}`}
					/>
				)}
				{PanelBody !== null && panel !== null && (
					<div className="flex h-full min-h-0 flex-col overflow-hidden border-l border-border">
						{/* 面板切换条：注册表驱动。4 个面板 + 收起键在 260px 最小宽下会溢出，
						    故页签区独占一行可横向滚动，收起键固定右侧始终可达（L4 复审）。 */}
						<div className="flex shrink-0 items-center gap-1 border-b border-border px-1.5 py-1">
							<div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
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
							</div>
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								className="shrink-0"
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
