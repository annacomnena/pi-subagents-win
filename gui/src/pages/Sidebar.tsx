/** 左侧栏（拍板 5）：路由 = zustand activeTab，不引 react-router。 */

import { useGui, type TabId } from "../store";
import { Badge } from "../ui";

const NAV: { id: TabId; label: string }[] = [
	{ id: "master", label: "Master" },
	{ id: "workstream", label: "Workstream" },
	{ id: "attention", label: "Attention" },
	{ id: "timeline", label: "Timeline" },
	{ id: "runtime", label: "Runtime" },
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
					className={`flex items-center justify-between rounded px-3 py-2 text-left text-sm transition-colors ${
						activeTab === n.id ? "bg-zinc-800 font-semibold text-zinc-100" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
					}`}
				>
					{n.label}
					{n.id === "attention" && openCount > 0 && <Badge tone="yellow">{openCount}</Badge>}
				</button>
			))}
			<p className="mt-auto px-2 text-[10px] leading-relaxed text-zinc-600">
				Runtime Workbench v0
				<br />
				poll 2s/6s · proxy /v1
			</p>
		</nav>
	);
}
