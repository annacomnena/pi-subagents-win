/**
 * gui/src/pages/RunsPage.tsx — 「运行」section（RuntimeOverlay 新增，2026-10-22 档 A）。
 *
 * ## 为什么要这一页
 *
 * 此前 async subagent 的运行态**只**能从 TUI / `subagent-win{status,list}` 工具看到，
 * GUI 里连「现在有几个在跑」都没有（实测 gui/src 对 `subagent-runs`/`recentCalls` 引用数 = 0）。
 * 本页把 `GET /v1/runs` 的卡片投影渲染出来：谁在跑、跑了多久、用了多少、最近调了什么工具。
 *
 * ## 一条不能违反的展示纪律
 *
 * 「运行中」= `status === "running"` **且** `liveness === "alive"`（登记 pid 仍存活）。
 * 判据只由 `runsView.ts::deriveRunDisplay` 提供，本文件**不自己判 status**——因为实测
 * 152/154 记录的 `liveness` 是 `unknown`（没有 pid 可判），直接数 status 会常态谎报「运行中」。
 *
 * ## 数据面
 *
 * 5s 轮询 + ETag/304（客户端命中时拿同一引用 ⇒ 稳态零重渲染）；失败保留旧数据，
 * 首次失败给「重试」出口（照 `AutonomyPage.tsx#FrontierViz` 范式）。
 */

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Activity, PlayCircle } from "lucide-react";
import { api } from "../api/client";
import type { RunCard, RunsResponse } from "../api/types";
import { Badge, Button, Card, EmptyState, PageIntro, RelTime, ShortId, Term } from "../ui";
import { deriveRunDisplay, formatUsage, livenessTally, loopBadge, partitionRuns, runningCount, type RunTone } from "../runsView";

/** 每页最多显示多少条（服务端 limit 上限 200；这里只要「最近的一屏」）。 */
const PAGE_LIMIT = 50;

/** `RunTone` → 既有 `Badge tone`（ok→green / warn→yellow / danger→red / na→na）。 */
const TONE_TO_BADGE: Record<RunTone, "green" | "yellow" | "red" | "na"> = {
	ok: "green",
	warn: "yellow",
	danger: "red",
	na: "na",
};

/** 单条 run 卡片（一行一 run；agent / 任务 / 启动+年龄 / 三态徽标 / 用量 / 最近调用 / 循环判据）。 */
function RunRow({ run }: { run: RunCard }) {
	const d = deriveRunDisplay(run);
	const loop = loopBadge(run.loopVerdict);
	return (
		<div className="rounded-lg border border-border bg-card p-2.5">
			<div className="flex flex-wrap items-center gap-1.5">
				<Badge tone={TONE_TO_BADGE[d.tone]} title={d.hint}>{d.label}</Badge>
				{run.agent !== null && <Badge tone="gray" title="派发的 agent 名">{run.agent}</Badge>}
				{loop !== null && <Badge tone={TONE_TO_BADGE[loop.tone]} title="环路判据（仅运行中计算；终态恒 unknown，不是卡住证据）">{loop.label}</Badge>}
				{run.pid !== null && <span className="font-mono text-ui-xs text-foreground-subtle" title="登记的进程 pid">pid {run.pid}</span>}
				<ShortId value={run.id} />
				<span className="ml-auto flex items-center gap-1 text-ui-xs text-foreground-subtle">
					<span title={run.startedAt ?? "无启动时间"}>启动 <RelTime at={run.startedAt} /></span>
					<span aria-hidden="true">·</span>
					<span title={`最近脉搏 ${run.lastActivity ?? "—"}（lastActivity → pidRecordedAt → startedAt 回退）`}>
						最近活动 <RelTime at={run.lastActivity} />
					</span>
				</span>
			</div>
			<p className="mt-1 break-words text-ui-sm text-foreground">{run.taskPreview || "（无任务摘要）"}</p>
			<div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-ui-xs text-foreground-subtle">
				<span title="token 用量（input/out/cost）；运行中记录尚未落 result.usage ⇒ —">用量 {formatUsage(run.usage)}</span>
				{run.usage === null && <span className="text-foreground-subtlest">（运行中无用量快照）</span>}
			</div>
			{run.recentCalls !== undefined && run.recentCalls.length > 0 && (
				<ol className="mt-1.5 space-y-0.5">
					{run.recentCalls.map((c, i) => (
						<li key={`${c.ts}-${i}`} className="flex items-baseline gap-1.5 text-ui-xs">
							<span className="shrink-0 font-medium text-foreground-subtle">{c.tool}</span>
							<span className="break-all font-mono text-foreground-subtlest" title={c.argsDigest}>{c.argsDigest}</span>
						</li>
					))}
				</ol>
			)}
		</div>
	);
}

export function RunsPage() {
	// undefined = 首次加载中 / RunsResponse = 有数据（失败时保留旧数据）
	const [data, setData] = useState<RunsResponse | undefined>(undefined);
	const [error, setError] = useState("");
	const refresh = useCallback(async () => {
		const r = await api.runs({ limit: PAGE_LIMIT, includeRecentCalls: true });
		if (r.ok) {
			setData(r.data);
			setError("");
		} else {
			setError(`读取运行记录失败 HTTP ${r.status}`);
		} // 失败保留旧数据；首次失败时给「重试」，避免永久停在加载态。
	}, []);
	useEffect(() => {
		void refresh();
		const t = window.setInterval(() => void refresh(), 5000);
		return () => window.clearInterval(t);
	}, [refresh]);

	const title = <Term zh="异步任务" en="async runs" hint="subagent-win 派发的异步 run 记录（~/.pi/agent/subagent-runs/*.json）的只读投影。5 秒轮询，ETag 命中时服务端回 304。" />;

	if (data === undefined) {
		return (
			<Card title={title}>
				<EmptyState
					icon={error ? <AlertTriangle className="size-5" /> : undefined}
					action={error ? <Button variant="secondary" onClick={() => void refresh()}>重试</Button> : undefined}
				>
					{error || "正在加载运行记录…"}
				</EmptyState>
			</Card>
		);
	}

	const runs = data.runs;
	const live = runningCount(runs);
	const tally = livenessTally(runs);
	// 「运行中」组 = 真活；其余（含 status=running 但 unknown/dead）一律算「未确认为运行中」，
	// 与终态混排（按服务端给的 running-first + startedAt 降序顺序原样呈现，不再二次排序）。
	// 分组口径的**唯一实现**在 `runsView.ts::partitionRuns`（页面内联 filter 会被变异而不被发现）。
	const { running, others } = partitionRuns(runs);

	return (
		<div className="space-y-3">
			<PageIntro>subagent 异步任务的运行态：只读投影 run 记录，5 秒刷新。</PageIntro>

			<Card
				title={title}
				right={
					<Button variant="secondary" onClick={() => void refresh()} title="立即重读 run 记录">刷新</Button>
				}
			>
				{error && <p role="status" className="mb-2 text-ui-xs text-destructive">{error}；显示最近一次读到的数据。</p>}
				<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-ui-sm">
					<Badge tone={live > 0 ? "green" : "gray"} title="只有「记录 running 且登记 pid 仍存活」才算运行中；liveness=unknown 不算">
						<PlayCircle className="size-3" aria-hidden="true" /> {live} 个运行中
					</Badge>
					<span className="text-foreground-subtle">· 显示 {data.count} / 共 {data.total} 条</span>
					<span className="text-foreground-subtle" title="liveness 三态分布（分母 = 本次返回条数）。unknown = 记录里没有 pid 可判活，属常态，不是异常。">
						· 判活：活 {tally.alive} / 死 {tally.dead} / 未知 {tally.unknown}
					</span>
					<span className="ml-auto text-ui-xs text-foreground-subtle" title="响应时间（服务端时钟）；不参与 ETag">
						asof <RelTime at={data.asof} />
					</span>
				</div>
			</Card>

			{runs.length === 0 ? (
				<Card title={<Term zh="运行记录" en="runs" hint="subagent-runs 目录里的异步 run 记录" />}>
					<EmptyState
						icon={<Activity className="size-6" />}
						action={<Button variant="secondary" onClick={() => void refresh()}>刷新</Button>}
					>
						暂无运行记录（subagent-runs 目录为空或尚未派发过 run）。
					</EmptyState>
				</Card>
			) : (
				<>
					<Card title={<Term zh="运行中" en="running" hint="记录 status=running 且登记 pid 仍存活（liveness=alive）。不知道在不在跑的记录不列在这里。" />}>
						{live === 0 ? (
							<EmptyState icon={<Activity className="size-5" />}>当前无运行中的任务。</EmptyState>
						) : (
							<div className="space-y-2">
								{running.map((r) => <RunRow key={r.id} run={r} />)}
							</div>
						)}
					</Card>

					<Card
						title={
							<Term
								zh="最近记录"
								en="recent runs"
								hint="终态记录 + 状态未能确认的记录（记录 running 但 pid 缺失或已退出）。unknown 不会被说成运行中。"
							/>
						}
						right={<span className="text-ui-xs text-foreground-subtle">{others.length} 条</span>}
					>
						{others.length === 0 ? (
							<EmptyState icon={<Activity className="size-5" />}>无其他记录。</EmptyState>
						) : (
							<div className="space-y-2">
								{others.map((r) => <RunRow key={r.id} run={r} />)}
							</div>
						)}
					</Card>
				</>
			)}
		</div>
	);
}
