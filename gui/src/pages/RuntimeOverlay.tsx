/**
 * gui/src/pages/RuntimeOverlay.tsx — 「运行时」全屏覆盖层（ZCode 1:1 复刻 第 6 步）。
 *
 * 壳 = zcode WorkspaceSettingsLayer（absolute inset-0，无遮罩动画，挂载即整层替换）；
 * 0923 2003 遮挡修复：根层叠上下文内 z-10 < composer dock z-20 被压（plans/0923_gui_ux_fix_plan.md A），
 * 抬到 z-30 → 根序 toast 9999 > dropdown 60 > dialog/tooltip 50 > RuntimeOverlay 30 > composer 20。
 * 内部骨架 = SettingsPage.tsx#L1375 同款 grid：窄栅 68px 图标栏 / ≥lg 268px 全栏；
 * 返回钮 = #L1408 圆角-xl 套件（m-1 w-[calc(100%-0.5rem)] justify-start rounded-xl…）。
 * 四 section（attention/master/workstream/runtime）组件**原样复用**为右栏内容；
 * 0923 加第 5 项「微信连接」（ChannelsPage；仅 /v1/wechat/bind/status 200 时渲染——
 * 未启用 403 wechat-disabled / 401 / 网络错均隐藏，不渲染空壳入口）；
 * runtimeOverlay 值 = 打开并定位指定 section（左栏高亮）；Esc 关闭保留。
 * [无后端支撑]=不渲染：⌘K CommandCenter、文件树、diff 审查、git 摘要、账号页（拍板 1）。
 */

import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { api } from "../api/client";
import { useGui, type RuntimeOverlaySection } from "../store";
import { AttentionPage } from "./AttentionPage";
import { ChannelsPage } from "./ChannelsPage";
import { MasterPage } from "./MasterPage";
import { WorkstreamPage } from "./WorkstreamPage";
import { RuntimePage } from "./RuntimePage";
import { Button } from "../ui/button";

const SECTIONS: { id: RuntimeOverlaySection; zh: string }[] = [
	{ id: "attention", zh: "需要关注" },
	{ id: "master", zh: "主控" },
	{ id: "workstream", zh: "工作流" },
	{ id: "runtime", zh: "运行时" },
	{ id: "wechat", zh: "微信连接" },
];

export const overlaySectionId = (id: RuntimeOverlaySection): string => `overlay-section-${id}`;

export function RuntimeOverlay() {
	const section = useGui((s) => s.runtimeOverlay);
	const setRuntimeOverlay = useGui((s) => s.setRuntimeOverlay);
	// 0923 微信 opt-in 可见性：仅当 /v1/wechat/bind/status 200 时渲染入口；
	// 403（wechat-disabled，config channels.wechat.enabled 缺省 OFF）/ 401 / 网络错 → 隐藏。
	const [wechatVisible, setWechatVisible] = useState(false);
	const open = section !== null;
	useEffect(() => {
		if (!open) {
			setWechatVisible(false);
			return;
		}
		let cancelled = false;
		void api.wechatBindStatus().then((r) => {
			if (cancelled) return;
			setWechatVisible(r.ok);
		});
		return () => {
			cancelled = true;
		};
	}, [open]);

	// Esc 关闭（zcode Dialog 口径）；grid 铺满 inset-0，遮罩点击关闭保留在根节点空白命中
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === "Escape") setRuntimeOverlay(null);
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [setRuntimeOverlay]);

	if (section === null) return null;

	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label="运行时"
			className="absolute inset-0 z-30"
		>
			{/* SettingsPage 骨架（SettingsPage.tsx#L1375 照抄）：68px 图标栏 / ≥lg 268px 全栏 */}
			<div className="relative grid h-screen min-h-full w-full grid-cols-[68px_minmax(0,1fr)] grid-rows-[minmax(0,1fr)] bg-background lg:grid-cols-[268px_minmax(0,1fr)]">
				{/* 左导航栏 */}
				<nav className="flex min-h-0 flex-col overflow-y-auto p-1" aria-label="运行时 section 导航">
					{/* 返回钮（SettingsPage.tsx#L1408 圆角-xl 套件照抄） */}
					<Button
						type="button"
						variant="ghost"
						onClick={() => setRuntimeOverlay(null)}
						title="返回主工作台（也可按 Esc）"
						className="m-1 w-[calc(100%-0.5rem)] justify-start gap-2 rounded-xl px-1.5 text-foreground-subtle hover:bg-surface-hover hover:text-foreground max-lg:size-10 max-lg:justify-center max-lg:px-0"
					>
						<ArrowLeft className="size-4 shrink-0" />
						<span className="truncate text-ui-base">返回</span>
					</Button>
					<div className="mt-1 flex flex-col gap-0.5">
						{/* 0923：wechat 入口仅 200 可见（403 wechat-disabled/401/网络错 → 不渲染） */}
						{SECTIONS.filter((sec) => sec.id !== "wechat" || wechatVisible).map((sec) => (
							<Button
								key={sec.id}
								type="button"
								variant="ghost"
								aria-current={section === sec.id ? "true" : undefined}
								onClick={() => setRuntimeOverlay(sec.id)}
								className={`m-1 w-[calc(100%-0.5rem)] justify-start gap-2 rounded-xl px-1.5 max-lg:size-10 max-lg:justify-center max-lg:px-0 ${
									section === sec.id
										? "bg-selected text-foreground hover:bg-selected"
										: "text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
								}`}
							>
								<span className="truncate text-ui-base">{sec.zh}</span>
							</Button>
						))}
					</div>
				</nav>
				{/* 右内容栏：四页组件原样复用为 section（锚定当前 section） */}
				<div
					className="min-h-0 overflow-y-auto p-4"
					onMouseDown={(event) => {
						if (event.target === event.currentTarget) setRuntimeOverlay(null);
					}}
				>
					{SECTIONS.map((sec) => (
						<section
							key={sec.id}
							id={overlaySectionId(sec.id)}
							className={section === sec.id ? "" : "hidden"}
							aria-hidden={section === sec.id ? undefined : "true"}
						>
							{sec.id === "attention" && <AttentionPage />}
							{sec.id === "master" && <MasterPage />}
							{sec.id === "workstream" && <WorkstreamPage />}
							{sec.id === "runtime" && <RuntimePage />}
							{/* 0923：未启用（403）时 section 不渲染（与左栏入口同一可见性） */}
							{sec.id === "wechat" && wechatVisible && <ChannelsPage />}
						</section>
					))}
				</div>
			</div>
		</div>
	);
}
