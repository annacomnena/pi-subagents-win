/** 左侧栏（会话为主重构 S4）：上=SessionList 常驻 + 下=次级导航组（时间线 Tab + 运行时覆盖层入口）。
 *  主视图路由 = zustand activeTab（chat|timeline）；master/workstream/attention/runtime 状态页
 *  已收进「运行时」全屏覆盖层（runtimeOverlay）。 */

import { useGui, type TabId } from "../store";
import { SessionList } from "./SessionList";
import { Badge, Term } from "../ui";

const NAV: { id: TabId; zh: string; en: string }[] = [
	{ id: "timeline", zh: "时间线", en: "Timeline" },
];

export function Sidebar() {
	const activeTab = useGui((s) => s.activeTab);
	const setActiveTab = useGui((s) => s.setActiveTab);
	const setRuntimeOverlay = useGui((s) => s.setRuntimeOverlay);
	const attention = useGui((s) => s.attention);
	const openCount = attention.filter((a) => a.status === "open").length;

	return (
		<nav className="flex w-[264px] shrink-0 flex-col border-r border-border bg-surface/40 p-2">
			{/* 上：会话列表常驻（左栏主体） */}
			<SessionList />
			{/* 下：次级导航组（时间线 Tab + 运行时覆盖层入口） */}
			<div className="mt-2 flex shrink-0 flex-col gap-1 border-t border-border pt-2">
				{NAV.map((n) => (
					<button
						key={n.id}
						type="button"
						onClick={() => setActiveTab(n.id)}
						className={`flex items-center justify-between rounded px-3 py-2 text-left text-sm transition-colors ${
							activeTab === n.id ? "bg-selected font-semibold text-zinc-100" : "text-zinc-400 hover:bg-surface hover:text-zinc-200"
						}`}
					>
						<Term zh={n.zh} en={n.en} />
					</button>
				))}
				<button
					type="button"
					onClick={() => setRuntimeOverlay("runtime")}
					title="主控 / 工作流 / 需要关注 / 运行时全景——全屏覆盖层；待决策徽标见顶栏"
					className="flex items-center justify-between rounded px-3 py-2 text-left text-sm text-zinc-400 transition-colors hover:bg-surface hover:text-zinc-200"
				>
					<Term zh="运行时" en="Runtime" />
					{openCount > 0 && <Badge tone="yellow" title="待处理条数（点顶栏待决策直达「需要关注」）">{openCount}</Badge>}
				</button>
			</div>
			<p className="mt-auto px-2 pt-2 text-[10px] leading-relaxed text-zinc-600">
				运行时工作台 v0
				<br />
				<span className="font-mono">poll 2s/6s · proxy /v1</span>
			</p>
		</nav>
	);
}
