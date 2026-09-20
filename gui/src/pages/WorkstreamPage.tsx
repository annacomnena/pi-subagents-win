/**
 * Workstream 页（G5.1 人话化）：使命/状态/完成标准/唤醒策略 + 关联任务/运行 + 暂停/继续。
 * ⚠️ per-ws 唤醒状态 / 信箱积压 host 未暴露 → 灰色「暂无数据」徽章诚实呈现；全局信箱在主控/运行时页。
 */

import { useState } from "react";
import { pauseResumeWorkstream, useGui } from "../store";
import { RUN_STATUS_ZH, TASK_STATUS_ZH, WS_STATUS_ZH, zhStatus } from "../format";
import { Badge, Button, Card, EmptyState, PageIntro, RelTime, ShortId, Term, naBadge } from "../ui";
import type { WorkstreamRecord } from "../api/types";

function statusTone(s: WorkstreamRecord["status"]): "green" | "yellow" | "red" | "gray" | "blue" {
	switch (s) {
		case "active":
			return "green";
		case "waiting":
			return "blue";
		case "blocked":
			return "red";
		case "paused":
			return "yellow";
		default:
			return "gray";
	}
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<>
			<dt className="text-zinc-500">{label}</dt>
			<dd className="text-zinc-200">{children}</dd>
		</>
	);
}

function Unset() {
	return <span className="text-zinc-600">未设置</span>;
}

export function WorkstreamPage() {
	const workstreams = useGui((s) => s.snapshot?.workstreams ?? []);
	const tasks = useGui((s) => s.snapshot?.tasks ?? []);
	const runs = useGui((s) => s.snapshot?.runs ?? []);
	const [selectedId, setSelectedId] = useState<string | null>(null);

	const selected = workstreams.find((w) => w.id === selectedId) ?? workstreams[0] ?? null;
	const wsTasks = selected ? tasks.filter((t) => t.workstreamId === selected.id) : [];
	const selectorSubjects = new Set(selected?.taskSelector?.runSubjects ?? []);
	const selectorExternal = new Set(wsTasks.map((t) => t.externalTaskId).filter((v): v is string => !!v));
	const wsRuns = selected
		? runs.filter(
				(r) =>
					(r.subject && selectorSubjects.has(r.subject)) ||
					(r.externalTaskId !== undefined && selectorExternal.has(r.externalTaskId)),
			)
		: [];

	return (
		<div className="space-y-3">
			<PageIntro>每个进行中任务的使命与状态</PageIntro>
			<div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(220px,1fr)_3fr]">
				<Card title={<Term zh={`工作流（${workstreams.length}）`} en="Workstream" />}>
					{workstreams.length === 0 ? (
						<EmptyState>暂无工作流</EmptyState>
					) : (
						<ul className="space-y-1">
							{workstreams.map((w) => (
								<li key={w.id}>
									<button
										type="button"
										onClick={() => setSelectedId(w.id)}
										className={`w-full rounded px-2 py-1.5 text-left transition-colors ${
											selected?.id === w.id ? "bg-zinc-800" : "hover:bg-zinc-900"
										}`}
									>
										<div className="flex items-center gap-2">
											<Badge tone={statusTone(w.status)}>{zhStatus(WS_STATUS_ZH, w.status)}</Badge>
											<ShortId value={w.id} className="text-[11px] text-zinc-400" />
										</div>
										<p className="mt-0.5 line-clamp-2 text-[11px] text-zinc-500">{w.mission}</p>
									</button>
								</li>
							))}
						</ul>
					)}
				</Card>

				{!selected ? (
					<Card title="详情">
						<EmptyState>从左侧选一个工作流查看详情</EmptyState>
					</Card>
				) : (
					<div className="flex flex-col gap-3">
						<Card
							title="工作流详情"
							right={
								<div className="flex items-center gap-1.5">
									<ShortId value={selected.id} className="text-[10px] text-zinc-500" />
									<Button
										disabled={selected.status === "paused"}
										title={selected.status === "paused" ? "已经暂停了，无需重复暂停" : "暂停这个工作流"}
										onClick={() => void pauseResumeWorkstream("workstream.pause", selected.id)}
									>
										暂停
									</Button>
									<Button
										disabled={selected.status !== "paused"}
										title={selected.status !== "paused" ? "没有暂停，无需恢复" : "恢复运行这个工作流"}
										onClick={() => void pauseResumeWorkstream("workstream.resume", selected.id)}
									>
										继续
									</Button>
								</div>
							}
						>
							<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
								<DetailRow label="使命（要做的事）">{selected.mission}</DetailRow>
								<DetailRow label="状态">
									<Badge tone={statusTone(selected.status)}>{zhStatus(WS_STATUS_ZH, selected.status)}</Badge>
								</DetailRow>
								<DetailRow label="完成标准">
									{selected.successCriteria ?? <Unset />}
								</DetailRow>
								<DetailRow label="唤醒策略（事件来了要不要自动开工）">
									{selected.wakePolicy ? (
										<span className="text-[11px]">
											{selected.wakePolicy.enabled ? "已启用" : "已停用"} · 冷却 {selected.wakePolicy.cooldownMs}ms
											{selected.wakePolicy.debounceMs !== undefined ? ` · 防抖 ${selected.wakePolicy.debounceMs}ms` : ""}
											{selected.wakePolicy.maxSpawns !== undefined ? ` · 最多 ${selected.wakePolicy.maxSpawns} 次` : ""}
										</span>
									) : (
										<Unset />
									)}
								</DetailRow>
								<DetailRow label="唤醒状态">
									{naBadge("后端未提供该数据（这里只显示唤醒策略的配置）")}
								</DetailRow>
								<DetailRow label="信箱积压">
									{naBadge("后端未提供按工作流的计数（全局信箱见主控/运行时页）")}
								</DetailRow>
								<DetailRow label="工作区">
									{selected.workspaceRef ? <span className="font-mono text-[11px] break-all">{selected.workspaceRef}</span> : <Unset />}
								</DetailRow>
								<DetailRow label="创建 / 更新时间">
									<RelTime at={selected.createdAt} /> / <RelTime at={selected.updatedAt} />
								</DetailRow>
							</dl>
						</Card>

						<div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
							<Card title={<Term zh={`任务（${wsTasks.length}）`} en="Tasks" />}>
								{wsTasks.length === 0 ? (
									<EmptyState>暂无关联任务</EmptyState>
								) : (
									<ul className="space-y-1 text-[11px]">
										{wsTasks.map((t) => (
											<li key={t.id} className="flex items-start gap-2">
												<Badge tone={t.status === "completed" ? "green" : t.status === "failed" ? "red" : "gray"}>
													{zhStatus(TASK_STATUS_ZH, t.status)}
												</Badge>
												<span className="min-w-0">
													{t.externalTaskId ? <ShortId value={t.externalTaskId} className="text-zinc-500" /> : null}
													<span className="ml-2 text-zinc-300">{t.objective}</span>
												</span>
											</li>
										))}
									</ul>
								)}
							</Card>
							<Card title={<Term zh={`运行（${wsRuns.length}）`} en="Runs" />}>
								{wsRuns.length === 0 ? (
									<EmptyState>暂无关联运行（按任务选择器匹配出的记录为空）</EmptyState>
								) : (
									<ul className="space-y-1 text-[11px]">
										{wsRuns.map((r) => (
											<li key={r.subject} className="flex items-start gap-2">
												<Badge tone={r.status === "completed" ? "green" : r.status === "failed" ? "red" : r.status === "running" ? "blue" : "gray"}>
													{zhStatus(RUN_STATUS_ZH, r.status)}
												</Badge>
												<span className="min-w-0">
													<ShortId value={r.subject} className="text-zinc-500" />
													{r.summary && <span className="ml-2 text-zinc-400">{r.summary}</span>}
												</span>
											</li>
										))}
									</ul>
								)}
							</Card>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
