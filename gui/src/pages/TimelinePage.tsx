/**
 * Timeline 页（S4，§36）：journal 人话时间线——limit 200 尾窗首屏 + /v1/events 增量合并
 * （store.pollEvents），只渲染 server/client 模板生成的 summary，**不显 raw JSON**。
 */

import { useState } from "react";
import { useGui } from "../store";
import { fmtDateTime } from "../format";
import { Badge, Card, EmptyState } from "../ui";
import type { TimelineItem } from "../api/types";

const FILTERS: { id: string; label: string; match: (t: TimelineItem) => boolean }[] = [
	{ id: "all", label: "全部", match: () => true },
	{ id: "run", label: "run.*", match: (t) => t.type.startsWith("run.") },
	{ id: "handoff", label: "master.handoff.*", match: (t) => t.type.startsWith("master.handoff") || t.type === "master-handoff" },
	{ id: "command", label: "command.*", match: (t) => t.type.startsWith("command.") },
	{ id: "state", label: "状态条目", match: (t) => t.kind === "state" },
];

function kindBadge(t: TimelineItem) {
	if (t.kind === "state") return <Badge tone="purple">state</Badge>;
	if (t.type.startsWith("master.handoff")) return <Badge tone="blue">handoff</Badge>;
	if (t.type.startsWith("run.")) return <Badge tone="green">run</Badge>;
	if (t.type.startsWith("command.")) return <Badge tone="yellow">command</Badge>;
	return <Badge>event</Badge>;
}

export function TimelinePage() {
	const timeline = useGui((s) => s.timeline);
	const [filterId, setFilterId] = useState("all");
	const filter = FILTERS.find((f) => f.id === filterId) ?? FILTERS[0];

	const items = timeline.filter(filter.match).slice(-200).reverse(); // 最新在上

	return (
		<div className="space-y-3">
			<div className="flex flex-wrap items-center gap-1.5">
				<span className="mr-1 text-xs text-zinc-500">过滤：</span>
				{FILTERS.map((f) => (
					<button
						key={f.id}
						type="button"
						onClick={() => setFilterId(f.id)}
						className={`rounded border px-2 py-0.5 text-[11px] transition-colors ${
							filterId === f.id
								? "border-zinc-600 bg-zinc-800 text-zinc-100"
								: "border-zinc-800 text-zinc-500 hover:text-zinc-300"
						}`}
					>
						{f.label}
					</button>
				))}
				<span className="ml-auto text-[10px] text-zinc-600">尾窗 200 条 · events 2s 增量 · timeline 6s 全量</span>
			</div>

			<Card title={`Timeline（${items.length}）`}>
				{items.length === 0 ? (
					<EmptyState>暂无条目——journal 为空或 host 未就绪</EmptyState>
				) : (
					<ul className="divide-y divide-zinc-800/60">
						{items.map((t) => (
							<li key={t.id} className="flex items-start gap-2 py-1.5 text-xs">
								<span className="w-28 shrink-0 font-mono text-[10px] text-zinc-600">{fmtDateTime(t.at)}</span>
								<span className="mt-0.5 shrink-0">{kindBadge(t)}</span>
								<span className="min-w-0">
									<span className="text-zinc-200">{t.summary}</span>
									{t.actor && <span className="ml-2 text-[10px] text-zinc-500">actor {t.actor}</span>}
									{t.source && <span className="ml-2 font-mono text-[10px] text-zinc-600">{t.source}</span>}
								</span>
							</li>
						))}
					</ul>
				)}
			</Card>
		</div>
	);
}
