/**
 * Workstream 页（S6，§35）：mission/status/successCriteria/wakePolicy + taskSelector 关联
 * tasks/runs + pause/resume。⚠️ per-ws wake state / mailbox backlog host 未暴露（拍板 2②）
 * → 灰色 n/a 徽章诚实呈现，全局 pending 在 Master/Runtime 页。
 */

import { useState } from "react";
import { pauseResumeWorkstream, useGui } from "../store";
import { fmtDateTime } from "../format";
import { Badge, Button, Card, EmptyState, naBadge } from "../ui";
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
		<div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(220px,1fr)_3fr]">
			<Card title={`Workstreams（${workstreams.length}）`}>
				{workstreams.length === 0 ? (
					<EmptyState>无 workstream</EmptyState>
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
										<Badge tone={statusTone(w.status)}>{w.status}</Badge>
										<span className="font-mono text-[11px] text-zinc-400">{w.id}</span>
									</div>
									<p className="mt-0.5 line-clamp-2 text-[11px] text-zinc-500">{w.mission}</p>
								</button>
							</li>
						))}
					</ul>
				)}
			</Card>

			{!selected ? (
				<Card title="Detail">
					<EmptyState>选择左侧 workstream 查看详情</EmptyState>
				</Card>
			) : (
				<div className="flex flex-col gap-3">
					<Card
						title={`Workstream ${selected.id}`}
						right={
							<div className="flex items-center gap-1.5">
								<Button
									disabled={selected.status === "paused"}
									onClick={() => void pauseResumeWorkstream("workstream.pause", selected.id)}
								>
									Pause
								</Button>
								<Button
									disabled={selected.status !== "paused"}
									onClick={() => void pauseResumeWorkstream("workstream.resume", selected.id)}
								>
									Resume
								</Button>
							</div>
						}
					>
						<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
							<DetailRow label="mission">{selected.mission}</DetailRow>
							<DetailRow label="status">
								<Badge tone={statusTone(selected.status)}>{selected.status}</Badge>
							</DetailRow>
							<DetailRow label="successCriteria">
								{selected.successCriteria ?? naBadge("未设置")}
							</DetailRow>
							<DetailRow label="wakePolicy">
								{selected.wakePolicy ? (
									<span className="font-mono text-[11px]">
										{selected.wakePolicy.enabled ? "enabled" : "disabled"} · cooldown {selected.wakePolicy.cooldownMs}ms
										{selected.wakePolicy.debounceMs !== undefined ? ` · debounce ${selected.wakePolicy.debounceMs}ms` : ""}
										{selected.wakePolicy.maxSpawns !== undefined ? ` · maxSpawns ${selected.wakePolicy.maxSpawns}` : ""}
									</span>
								) : (
										naBadge("未设置")
								)}
							</DetailRow>
							<DetailRow label="wake state">
								{naBadge("host 未暴露（只展示 wakePolicy 配置态）")}
							</DetailRow>
							<DetailRow label="mailbox backlog">
								{naBadge("host 未暴露 per-ws 计数；全局 pending 见 Master/Runtime 页")}
							</DetailRow>
							<DetailRow label="workspaceRef">
								{selected.workspaceRef ? <span className="font-mono text-[11px] break-all">{selected.workspaceRef}</span> : naBadge("未设置")}
							</DetailRow>
							<DetailRow label="createdAt / updatedAt">
								<span className="font-mono text-[11px]">
									{fmtDateTime(selected.createdAt)} / {fmtDateTime(selected.updatedAt)}
								</span>
							</DetailRow>
						</dl>
					</Card>

					<div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
						<Card title={`Tasks（${wsTasks.length}）`}>
							{wsTasks.length === 0 ? (
								<EmptyState>无关联 task</EmptyState>
							) : (
								<ul className="space-y-1 text-[11px]">
									{wsTasks.map((t) => (
										<li key={t.id} className="flex items-start gap-2">
											<Badge tone={t.status === "completed" ? "green" : t.status === "failed" ? "red" : "gray"}>{t.status}</Badge>
											<span className="min-w-0">
												<span className="font-mono text-zinc-500">{t.externalTaskId ?? t.id}</span>
												<span className="ml-2 text-zinc-300">{t.objective}</span>
											</span>
										</li>
									))}
								</ul>
							)}
						</Card>
						<Card title={`Runs（${wsRuns.length}）`}>
							{wsRuns.length === 0 ? (
								<EmptyState>无关联 run（taskSelector.runSubjects / externalTaskId 匹配）</EmptyState>
							) : (
								<ul className="space-y-1 text-[11px]">
									{wsRuns.map((r) => (
										<li key={r.subject} className="flex items-start gap-2">
											<Badge tone={r.status === "completed" ? "green" : r.status === "failed" ? "red" : r.status === "running" ? "blue" : "gray"}>
												{r.status}
											</Badge>
											<span className="min-w-0">
												<span className="font-mono text-zinc-500 break-all">{r.subject}</span>
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
	);
}
