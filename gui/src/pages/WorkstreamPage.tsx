/**
 * Workstream 页（G5.1 人话化 + G5.2 接真数据）：使命/状态/完成标准/唤醒策略 + 唤醒状态/信箱积压
 * （snapshot.workstreams[].wakeState / mailboxBacklog 直出）+ 关联任务/运行 + 暂停/继续。
 */

import { useState } from "react";
import { pauseResumeWorkstream, useGui } from "../store";
import { RUN_STATUS_ZH, TASK_STATUS_ZH, WS_STATUS_ZH, zhStatus } from "../format";
import { Badge, Button, Card, EmptyState, PageIntro, RelTime, ShortId, Term } from "../ui";
import type { WorkstreamView } from "../api/types";

function statusTone(s: WorkstreamView["status"]): "green" | "yellow" | "red" | "gray" | "blue" {
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
			<dt className="text-foreground-subtle">{label}</dt>
			<dd className="text-foreground">{children}</dd>
		</>
	);
}

function Unset() {
	return <span className="text-foreground-subtlest">未设置</span>;
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
											selected?.id === w.id ? "bg-surface-hover" : "hover:bg-surface"
										}`}
									>
										<div className="flex items-center gap-2">
											<Badge tone={statusTone(w.status)}>{zhStatus(WS_STATUS_ZH, w.status)}</Badge>
											<ShortId value={w.id} className="text-[11px] text-foreground-subtle" />
											{/* G5.2：卡片直出唤醒/积压微摘要 */}
											{w.mailboxBacklog.pending > 0 && (
												<Badge tone="yellow" title="未领信件数（mailbox pending）">信 {w.mailboxBacklog.pending}</Badge>
											)}
											{w.wakeState.lastSpawnAt && <Badge tone="blue" title="最近一次被唤醒过">已唤醒</Badge>}
										</div>
										<p className="mt-0.5 line-clamp-2 text-[11px] text-foreground-subtle">{w.mission}</p>
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
									<ShortId value={selected.id} className="text-[10px] text-foreground-subtle" />
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
								<DetailRow label="唤醒状态（最近一次自动开工）">
									{selected.wakeState.lastSpawnAt ? (
										<span className="text-[11px]">
											<RelTime at={selected.wakeState.lastSpawnAt} /> 唤醒
											{selected.wakeState.lastTabRunId && (
												<>
													{" · "}
													运行 <ShortId value={selected.wakeState.lastTabRunId} />
												</>
											)}
											<span className="ml-2 text-[10px] text-foreground-subtlest">累计唤醒 {selected.wakeState.spawnAt.length} 次</span>
										</span>
									) : (
										<span className="text-[11px] text-foreground-subtlest">从未被唤醒过</span>
									)}
								</DetailRow>
								<DetailRow label="信箱积压（未领信件）">
									{selected.mailboxBacklog.pending > 0 || selected.mailboxBacklog.claimed > 0 ? (
										<span className="text-[11px]">
											<span className="text-foreground">{selected.mailboxBacklog.pending}</span> 封未领
											{selected.mailboxBacklog.claimed > 0 && ` · ${selected.mailboxBacklog.claimed} 封处理中`}
										</span>
									) : (
										<span className="text-[11px] text-foreground-subtlest">0 封（无积压）</span>
									)}
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
													{t.externalTaskId ? <ShortId value={t.externalTaskId} className="text-foreground-subtle" /> : null}
													<span className="ml-2 text-foreground-subtle">{t.objective}</span>
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
													<ShortId value={r.subject} className="text-foreground-subtle" />
													{r.summary && <span className="ml-2 text-foreground-subtle">{r.summary}</span>}
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
