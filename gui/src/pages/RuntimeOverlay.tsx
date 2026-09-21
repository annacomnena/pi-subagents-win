/**
 * gui/src/pages/RuntimeOverlay.tsx — 「运行时」全屏覆盖层（会话为主重构 S4）。
 *
 * 仿 zcode WorkspaceSettingsLayer（absolute inset-0 z-10）：状态是「辅」不常驻分栏——
 * master/workstream/attention/runtime 四页组件**原样复用**为 section（四页无 h-screen 假设），
 * 打开时可定位指定 section（runtimeOverlay 值 = 打开并定位；null = 关闭）。
 * 顶栏待决策徽标 / Sidebar 运行时入口均指向本层，不占主路由。
 */

import { useEffect } from "react";
import { useGui, type RuntimeOverlaySection } from "../store";
import { AttentionPage } from "./AttentionPage";
import { MasterPage } from "./MasterPage";
import { WorkstreamPage } from "./WorkstreamPage";
import { RuntimePage } from "./RuntimePage";
import { Term } from "../ui";

const SECTIONS: { id: RuntimeOverlaySection; zh: string; en: string }[] = [
	{ id: "attention", zh: "需要关注", en: "Attention" },
	{ id: "master", zh: "主控", en: "Master" },
	{ id: "workstream", zh: "工作流", en: "Workstream" },
	{ id: "runtime", zh: "运行时", en: "Runtime" },
];

export const overlaySectionId = (id: RuntimeOverlaySection): string => `overlay-section-${id}`;

export function RuntimeOverlay() {
	const section = useGui((s) => s.runtimeOverlay);
	const setRuntimeOverlay = useGui((s) => s.setRuntimeOverlay);

	// 打开/切换定位：值 = 打开并定位对应 section
	useEffect(() => {
		if (section === null) return;
		document.getElementById(overlaySectionId(section))?.scrollIntoView({ block: "start" });
	}, [section]);

	// 覆盖层按 ZCode 的 dialog 口径：Esc 和点遮罩都关闭；内部内容不会冒泡为遮罩点击。
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
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) setRuntimeOverlay(null);
			}}
			className="absolute inset-0 z-10 overflow-y-auto bg-background/95 backdrop-blur-sm"
		>
			<div className="mx-auto max-w-6xl px-4 py-3">
				{/* 层头：标题 + section 快捷导航 + 关闭 */}
				<header className="sticky top-0 z-10 -mx-4 mb-3 flex items-center gap-3 border-b border-border bg-background/95 px-4 py-2 backdrop-blur-sm">
					<h1 className="text-sm font-semibold text-zinc-200">
						<Term zh="运行时" en="Runtime" />
					</h1>
					<nav className="flex items-center gap-1">
						{SECTIONS.map((sec) => (
							<button
								key={sec.id}
								type="button"
								onClick={() => setRuntimeOverlay(sec.id)}
								className={`rounded px-2 py-1 text-xs transition-colors ${
									section === sec.id ? "bg-selected font-medium text-zinc-100" : "text-zinc-400 hover:bg-surface hover:text-zinc-200"
								}`}
							>
								{sec.zh}
							</button>
						))}
					</nav>
					<button
						type="button"
						onClick={() => setRuntimeOverlay(null)}
						title="关闭覆盖层（也可按 Esc 或点击遮罩）"
						className="ml-auto rounded px-2 py-1 text-xs text-zinc-400 transition-colors hover:bg-surface hover:text-zinc-200"
					>
						关闭 ✕
					</button>
				</header>
				{/* 四页组件原样复用为 section（状态页降级为覆盖层内容，不占主路由） */}
				<div className="space-y-6">
					{SECTIONS.map((sec) => (
						<section key={sec.id} id={overlaySectionId(sec.id)} className="scroll-mt-14">
							{sec.id === "attention" && <AttentionPage />}
							{sec.id === "master" && <MasterPage />}
							{sec.id === "workstream" && <WorkstreamPage />}
							{sec.id === "runtime" && <RuntimePage />}
						</section>
					))}
				</div>
			</div>
		</div>
	);
}
