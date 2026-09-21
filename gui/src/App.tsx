/**
 * App.tsx — 三栏布局（拍板 5：顶栏 + 左栏 + 中央；右侧 Inspector v0 砍）+
 * 全局轮询编排（2s 档 events/attention/health，6s 档 snapshot/timeline）。
 */

import { TopBar } from "./pages/TopBar";
import { Sidebar } from "./pages/Sidebar";
import { MasterPage } from "./pages/MasterPage";
import { WorkstreamPage } from "./pages/WorkstreamPage";
import { AttentionPage } from "./pages/AttentionPage";
import { TimelinePage } from "./pages/TimelinePage";
import { ChatPage } from "./pages/ChatPage";
import { RuntimePage } from "./pages/RuntimePage";
import type { ReactElement } from "react";
import { useGui, type TabId } from "./store";
import { usePoll } from "./usePoll";
import { fmtTime } from "./format";

const PAGES: Record<TabId, () => ReactElement> = {
	master: MasterPage,
	workstream: WorkstreamPage,
	attention: AttentionPage,
	timeline: TimelinePage,
	runtime: RuntimePage,
	chat: ChatPage,
};

export default function App() {
	const activeTab = useGui((s) => s.activeTab);
	const connection = useGui((s) => s.connection);
	const lastAsOf = useGui((s) => s.lastAsOf);
	const lastCommand = useGui((s) => s.lastCommand);

	// 全局轮询（数据不分页停——TopBar 任意页都要活）
	usePoll(() => useGui.getState().pollHealth(), 2000);
	usePoll(() => useGui.getState().pollEvents(), 2000);
	usePoll(() => useGui.getState().pollAttention(), 2000);
	usePoll(() => useGui.getState().pollSnapshot(), 6000);
	usePoll(() => useGui.getState().pollTimeline(), 6000);

	const Page = PAGES[activeTab];

	return (
		<div className="flex h-screen flex-col bg-zinc-950 text-zinc-200">
			<TopBar />
			{connection === "down" && (
				<div className="border-b border-amber-900/60 bg-amber-950/60 px-4 py-1 text-center text-[11px] text-amber-300">
					与后端服务断开，正在自动重试——以下数据截至 {fmtTime(lastAsOf)}
				</div>
			)}
			<div className="flex min-h-0 flex-1">
				<Sidebar />
				<main className="min-w-0 flex-1 overflow-y-auto p-4">
					<Page />
				</main>
			</div>
			{lastCommand && (
				<div className="border-t border-zinc-800 bg-zinc-900 px-4 py-1.5 text-[11px] text-zinc-400">
					<span className="mr-2 text-zinc-600">回执 {fmtTime(lastCommand.at)}</span>
					<span className="font-mono">{lastCommand.summary}</span>
				</div>
			)}
		</div>
	);
}
