/**
 * Timeline 页（G5.1 人话化）：journal 人话时间线——limit 200 尾窗首屏 + /v1/events 增量合并
 * （store.pollEvents），只渲染 server/client 模板生成的 summary，**不显 raw JSON**。
 */

import { useState } from "react";
import { useGui } from "../store";
import { Badge, Card, EmptyState, PageIntro, RelTime, ShortId, Term } from "../ui";
import type { TimelineItem } from "../api/types";

const FILTERS: { id: string; label: string; match: (t: TimelineItem) => boolean }[] = [
	{ id: "all", label: "全部", match: () => true },
	{ id: "run", label: "任务运行", match: (t) => t.type.startsWith("run.") },
	{ id: "handoff", label: "交接", match: (t) => t.type.startsWith("master.handoff") || t.type === "master-handoff" },
	{ id: "command", label: "命令", match: (t) => t.type.startsWith("command.") },
	{ id: "state", label: "状态变化", match: (t) => t.kind === "state" },
];

function kindBadge(t: TimelineItem) {
	if (t.kind === "state") return <Badge tone="purple" title={t.type}>状态</Badge>;
	if (t.type.startsWith("master.handoff")) return <Badge tone="blue" title={t.type}>交接</Badge>;
	if (t.type.startsWith("run.")) return <Badge tone="green" title={t.type}>任务</Badge>;
	if (t.type.startsWith("command.")) return <Badge tone="yellow" title={t.type}>命令</Badge>;
	return <Badge title={t.type}>事件</Badge>;
}

export function TimelinePage() {
	const timeline = useGui((s) => s.timeline);
	const [filterId, setFilterId] = useState("all");
	const filter = FILTERS.find((f) => f.id === filterId) ?? FILTERS[0];

	const items = timeline.filter(filter.match).slice(-200).reverse(); // 最新在上

	return (
		<div className="space-y-3">
			<PageIntro>按时间看系统里发生过什么</PageIntro>
			<div className="flex flex-wrap items-center gap-1.5">
				<span className="mr-1 text-xs text-zinc-500">只看：</span>
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
				<span className="ml-auto text-[10px] text-zinc-600">最近 200 条 · 2 秒增量刷新 · 6 秒全量刷新</span>
			</div>

			<Card title={<Term zh={`时间线（${items.length}）`} en="Timeline" />}>
				{items.length === 0 ? (
					<EmptyState>还没有发生过事件（后端日志为空或数据未就绪）</EmptyState>
				) : (
					<ul className="divide-y divide-zinc-800/60">
						{items.map((t) => (
							<li key={t.id} className="flex items-start gap-2 py-1.5 text-xs">
								<RelTime at={t.at} className="w-20 shrink-0 text-[10px] text-zinc-600" />
								<span className="mt-0.5 shrink-0">{kindBadge(t)}</span>
								<span className="min-w-0">
									<span className="text-zinc-200">{t.summary}</span>
									{t.actor && (
										<span className="ml-2 text-[10px] text-zinc-500">
											执行者 <ShortId value={t.actor} />
										</span>
									)}
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
