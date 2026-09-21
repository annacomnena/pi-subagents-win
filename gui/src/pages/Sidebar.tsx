/**
 * gui/src/pages/Sidebar.tsx — 左栏（ZCode 1:1 复刻 第 3 步；样板 WorkspaceSidebar +
 * NewTaskButtonGroup + WorkspaceSidebarFooter，class 串照抄锚 §2.a）。
 *
 * 结构 1:1：顶部动作区（新建钮[灰显占位：无 create-session 后端]）+ 会话列表（SessionList，
 * 含过滤 Input）+ footer（只留设置钮，头像行/次级导航不渲染——拍板 1）。
 * 容器：264px 宽 / 折叠 = width→0 + opacity-0 + pointer-events-none（duration-200 ease-out）。
 * [无后端支撑]=不渲染项：分组 Tabs、置顶/归档区、拖拽排序、搜索按钮、工作流行、手机活跃标。
 */

import { MessageCirclePlus, Settings } from "lucide-react";
import { useGui } from "../store";
import { SessionList } from "./SessionList";
import { Button } from "../ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

export function Sidebar() {
	const collapsed = useGui((s) => s.sidebarCollapsed);
	const setRuntimeOverlay = useGui((s) => s.setRuntimeOverlay);

	return (
		// 容器（WorkspaceShellLayout.tsx#L1539-1541）：宽度变量固定 264px；折叠 → w-0 + opacity-0
		<aside
			data-workspace-sidebar="true"
			className={`w-[264px] max-w-[50%] flex-none overflow-hidden duration-200 ease-out transition-[width,opacity] ${
				collapsed ? "w-0 pointer-events-none opacity-0" : "opacity-100"
			}`}
		>
			{/* aside 本体（WorkspaceSidebar.tsx#L1253-1259） */}
			<div className="flex h-full flex-col overflow-hidden bg-sidebar">
				{/* 顶部动作区（#L1268）：Web 无窗控让位条（拍板：可砍）→ py-3 */}
				<div className="flex flex-col gap-1 px-2 py-3">
					{/* 新建会话钮（NewTaskButtonGroup.tsx#L31-45 整条 class；无后端 → 灰显占位） */}
					<Tooltip>
						<TooltipTrigger asChild>
							<div
								aria-disabled="true"
								className="group w-full h-8 rounded-lg inline-flex shrink-0 items-center justify-stretch gap-2 overflow-hidden pl-2.5 pr-2.5 hover:bg-transparent hover:text-foreground-subtlest active:translate-y-0 cursor-not-allowed text-foreground-subtlest"
							>
								<div className="flex min-w-0 flex-1 items-center gap-2 text-ui-base">
									<MessageCirclePlus className="h-4 w-4 shrink-0" />
									<span className="truncate">新建会话</span>
								</div>
							</div>
						</TooltipTrigger>
						<TooltipContent>未接入（本地无 create-session 命令）</TooltipContent>
					</Tooltip>
				</div>
				{/* 会话列表（过滤 Input + ul space-y-0.5 + 三段式会话项） */}
				<SessionList />
				{/* footer（WorkspaceSidebarFooter.tsx#L217）：头像行不渲染，只留设置钮 → RuntimeOverlay */}
				<footer className="flex shrink-0 flex-col gap-2.5 px-4 pt-2 pb-4">
					<div className="flex shrink-0 items-center justify-end gap-1.5">
						<Button
							type="button"
							variant="ghost"
							size="icon-lg"
							aria-label="设置"
							title="运行时全景：主控 / 工作流 / 需要关注 / 运行时——打开全屏覆盖层"
							onClick={() => setRuntimeOverlay("runtime")}
						>
							<Settings className="size-4" />
						</Button>
					</div>
				</footer>
			</div>
		</aside>
	);
}
