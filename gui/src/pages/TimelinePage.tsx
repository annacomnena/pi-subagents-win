/**
 * Timeline 页（G5.1 人话化 + G5.2 翻页）：journal 人话时间线——limit 200 尾窗首屏 + /v1/events 增量合并
 * （store.pollEvents）+ 「加载更早」before= 历史翻页（store.loadEarlierTimeline），
 * 只渲染 server/client 模板生成的 summary，**不显 raw JSON**。
 */

import { useEffect, useState } from "react";
import { ArrowLeft, History } from "lucide-react";
import { useGui } from "../store";
import { Badge, Button, Card, EmptyState, PageIntro, RelTime, ShortId, Term } from "../ui";
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
	const pollEvents = useGui((s) => s.pollEvents); // P1 空态出口
	const timelineEnd = useGui((s) => s.timelineEnd);
	const loadEarlier = useGui((s) => s.loadEarlierTimeline);
	const setActiveTab = useGui((s) => s.setActiveTab);

	// Esc 返回（同 RuntimeOverlay 模式；TimelinePage 仅在 activeTab==="timeline" 时挂载，无需判断当前页）
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === "Escape") setActiveTab("chat");
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [setActiveTab]);
	const [loadingEarlier, setLoadingEarlier] = useState(false);
	const [filterId, setFilterId] = useState("all");
	const filter = FILTERS.find((f) => f.id === filterId) ?? FILTERS[0];

	const items = timeline.filter(filter.match).reverse(); // 最新在上（G5.2：显示全部已载入条目，含 before= 翻页历史）

	const onLoadEarlier = (): void => {
		if (loadingEarlier || timelineEnd) return;
		setLoadingEarlier(true);
		void loadEarlier().finally(() => setLoadingEarlier(false));
	};

	return (
		// ⚠️ P1-② 约束：本页走 App.tsx 的 <main>（**无 padding**），故自带 p-4。
		// 若将来把本页挪进 RuntimeOverlay（其右栅已有 p-4），**必须删掉这里的 p-4**，否则双重 padding。
		// 页面级纵向节奏统一 space-y-3（与其余页面一致）。
		<div className="space-y-3 p-4">
			<div className="flex items-center justify-between">
				<PageIntro>按时间看系统里发生过什么</PageIntro>
				<Button
					variant="ghost"
					onClick={() => setActiveTab("chat")}
					title="返回会话（也可按 Esc）"
				>
					<ArrowLeft />
					返回会话
				</Button>
			</div>
			<div className="flex flex-wrap items-center gap-1.5">
				<span className="mr-1 text-ui-sm text-foreground-subtle">只看：</span>
				{FILTERS.map((f) => (
					<button
						key={f.id}
						type="button"
						onClick={() => setFilterId(f.id)}
						className={`rounded-lg border px-2 py-0.5 text-ui-xs transition-colors ${
							filterId === f.id
								? "border-border-hover bg-selected text-foreground"
								: "border-border text-foreground-subtle hover:bg-hover hover:text-foreground"
						}`}
					>
						{f.label}
					</button>
				))}
				<span className="ml-auto text-ui-xs text-foreground-subtle">共载入 {timeline.length} 条 · 2 秒增量刷新 · 6 秒全量刷新</span>
				{!timelineEnd ? (
					<Button variant="ghost" disabled={loadingEarlier} onClick={onLoadEarlier} title="按 before= 排他上界向历史翻页（每页 200 条）">
						{loadingEarlier ? "加载中…" : "加载更早"}
					</Button>
				) : (
					<span className="text-ui-xs text-foreground-subtle">已到最早</span>
				)}
			</div>

			<Card title={<Term zh={`时间线（${items.length}）`} en="Timeline" />}>
				{items.length === 0 ? (
					<EmptyState
						icon={<History className="size-5" />}
						action={<Button variant="secondary" onClick={() => void pollEvents()}>刷新</Button>}
					>
						还没有发生过事件（后端日志为空或数据未就绪）
					</EmptyState>
				) : (
					<ul className="divide-y divide-border">
						{items.map((t) => (
							<li key={t.id} className="flex items-start gap-2 rounded-lg px-1 py-1.5 text-ui-sm transition-colors hover:bg-hover">
								<RelTime at={t.at} className="w-20 shrink-0 text-ui-xs text-foreground-subtle" />
								<span className="mt-0.5 shrink-0">{kindBadge(t)}</span>
								<span className="min-w-0">
									<span className="text-foreground">{t.summary}</span>
									{t.actor && (
										<span className="ml-2 text-ui-xs text-foreground-subtle">
											执行者 <ShortId value={t.actor} />
										</span>
									)}
									{t.source && <span className="ml-2 font-mono text-ui-xs text-foreground-subtle">{t.source}</span>}
								</span>
							</li>
						))}
					</ul>
				)}
			</Card>
		</div>
	);
}
