/** 左侧栏：路由 = zustand activeTab，不引 react-router；导航用固定术语表中文主词 + 小字英文。 */

import { useGui, type TabId } from "../store";
import { Badge, Term } from "../ui";

const NAV: { id: TabId; zh: string; en: string }[] = [
	{ id: "master", zh: "主控", en: "Master" },
	{ id: "workstream", zh: "工作流", en: "Workstream" },
	{ id: "attention", zh: "需要关注", en: "Attention" },
	{ id: "timeline", zh: "时间线", en: "Timeline" },
	{ id: "runtime", zh: "运行时", en: "Runtime" },
];

export function Sidebar() {
	const activeTab = useGui((s) => s.activeTab);
	const setActiveTab = useGui((s) => s.setActiveTab);
	const attention = useGui((s) => s.attention);
	const openCount = attention.filter((a) => a.status === "open").length;

	return (
		<nav className="flex w-40 shrink-0 flex-col gap-1 border-r border-zinc-800 bg-zinc-900/40 p-2">
			{NAV.map((n) => (
				<button
					key={n.id}
					type="button"
					onClick={() => setActiveTab(n.id)}
					title={n.id === "attention" ? "系统觉得需要你留意的事" : undefined}
					className={`flex items-center justify-between rounded px-3 py-2 text-left text-sm transition-colors ${
						activeTab === n.id ? "bg-zinc-800 font-semibold text-zinc-100" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
					}`}
				>
					<Term zh={n.zh} en={n.en} />
					{n.id === "attention" && openCount > 0 && <Badge tone="yellow" title="待处理条数">{openCount}</Badge>}
				</button>
			))}
			<p className="mt-auto px-2 text-[10px] leading-relaxed text-zinc-600">
				运行时工作台 v0
				<br />
				<span className="font-mono">poll 2s/6s · proxy /v1</span>
			</p>
		</nav>
	);
}
