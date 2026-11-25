/**
 * gui/src/pages/AutonomyPage.tsx — 「主动性」设置与工作状态看板（RuntimeOverlay 第 7 个 section）。
 *
 * 2026-09-30：从微信连接页拆出独立设置页（开关 + frontier 可视化）。
 * 2026-11-17 增强：补齐主动性套件完整工作状态表：
 *   - 系统心跳与健康诊断卡片（Heartbeat & Diagnostics）：存活时间、PID、周期、STALE 与被关诊断
 *   - 决策前沿可视化（FrontierViz）：快照时效、项目状态矩阵、本帧触发记录
 *   - 监管账本工作状态表（SupervisionLedgerViz）：按仓库分组展示全部 active/paused 账本、推活阈值、搜索过滤、未回报（⚠未回报）警示
 *   - 终端状态原文折叠卡片（RawTerminalOutputViz）：完整纯文本诊断输出，支持一键复制
 *
 * 视觉语言对齐 gui-workbench-ui（shadcn 套件、暗色一套、token 口径）。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
	Activity,
	AlertTriangle,
	CheckCircle2,
	ChevronDown,
	ChevronRight,
	Copy,
	HeartPulse,
	Inbox,
	Search,
	Terminal,
} from "lucide-react";
import { api } from "../api/client";
import type {
	AutonomyDiagnosticsResponse,
	AutonomyGateStatus,
	AutonomySupervisionEntry,
	FrontierProjectState,
	FrontierSnapshot,
	FrontierTrigger,
	ProjectFrontier,
} from "../api/types";
import { Badge, Button, Card, EmptyState, PageIntro, RelTime, ShortId, Term, Toggle } from "../ui";

// ── 1. AutonomySettings（开关 + 摘要状态）───────────────────────────

function AutonomySettings() {
	const [state, setState] = useState<{ enabled: boolean; kill: string; frontier: string | null; wakeGate: string | null } | null>(null);
	const [error, setError] = useState("");
	const refresh = useCallback(async () => {
		try {
			const r = await fetch("/v1/autonomy/status");
			if (r.ok) setState(await r.json());
			else setError(`状态读取失败 HTTP ${r.status}`);
		} catch {
			setError("状态读取失败");
		}
	}, []);
	useEffect(() => { void refresh(); }, [refresh]);
	const toggle = async (enabled: boolean) => {
		try {
			const r = await fetch("/v1/autonomy/set", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ enabled }),
			});
			if (!r.ok) {
				setError(`写入失败 HTTP ${r.status}`);
				return;
			}
			setError("");
			await refresh();
		} catch {
			setError("写入失败");
		}
	};
	return (
		<Card title="主动性套件总开关">
			<div className="space-y-2 text-ui-sm">
				<div className="flex items-center gap-2">
					<Toggle on={state?.enabled ?? false} disabled={!state} onChange={(v) => void toggle(v)} labels={["关", "开"]} />
					<span className="font-medium text-foreground">启用主动性套件</span>
				</div>
				<p className="text-foreground-subtle">
					开启后启用总门（可压制唤醒）+ 写入审计与决策前沿快照；开启动作开关后仅执行可回滚动作（诊断报告 + 本地通知信），不自动派活、不自动重启 worker。
				</p>
				<div className="flex flex-wrap items-center gap-2 font-mono text-ui-xs text-foreground-subtle">
					<span>enabled={state?.enabled ? "on" : "off"}</span>
					<span>·</span>
					<span>kill={state?.kill ?? "—"}</span>
					<span>·</span>
					<span>wake-gate={state?.wakeGate ?? "(never)"}</span>
				</div>
				{error && <p className="text-destructive">{error}</p>}
			</div>
		</Card>
	);
}

// ── 2. DiagnosticsSummary（存活心跳与健康诊断）──────────────────────

function DiagnosticsSummary({ data }: { data: AutonomyDiagnosticsResponse | null }) {
	if (!data) return null;
	const { heartbeat, freshness } = data;
	const isHealthy = !freshness.stale && !freshness.heartbeatStale && !freshness.suspectedDisabled && !freshness.clockSkew;

	return (
		<Card title={<Term zh="系统心跳与存活诊断" en="diagnostics" hint="来自 wake tick 与独立存活信号的心跳归因，防止静默失效事故" />}>
			<div className="grid gap-3 sm:grid-cols-2">
				{/* 心跳指标 */}
				<div className="rounded-lg border border-border bg-card p-3">
					<div className="flex items-center gap-2 text-ui-sm font-medium text-foreground">
						<HeartPulse className="size-4 text-accent" />
						<span>Owner Tick 心跳</span>
					</div>
					{heartbeat && heartbeat.at ? (
						<div className="mt-2 space-y-1 text-ui-xs text-foreground-subtle">
							<div className="flex justify-between">
								<span>最近更新：</span>
								<span className="text-foreground font-mono"><RelTime at={new Date(heartbeat.at).toISOString()} /></span>
							</div>
							<div className="flex justify-between">
								<span>进程 PID：</span>
								<span className="text-foreground font-mono">{heartbeat.pid ?? "null"}</span>
							</div>
							<div className="flex justify-between">
								<span>归属会话：</span>
								<span className="text-foreground font-mono">{heartbeat.sessionId ? `${heartbeat.sessionId.slice(0, 13)}…` : "null"}</span>
							</div>
							<div className="flex justify-between">
								<span>Tick 周期：</span>
								<span className="text-foreground font-mono">{Math.round((heartbeat.tickIntervalMs ?? 30000) / 1000)}s</span>
							</div>
						</div>
					) : (
						<p className="mt-2 text-ui-xs text-warning">无有效心跳记录（Tick 未跑或尚未写入）</p>
					)}
				</div>

				{/* 诊断结论 */}
				<div className="rounded-lg border border-border bg-card p-3">
					<div className="flex items-center gap-2 text-ui-sm font-medium text-foreground">
						<Activity className="size-4 text-accent" />
						<span>实时诊断结论</span>
					</div>
					<div className="mt-2 space-y-1.5 text-ui-xs">
						<div className="flex flex-wrap items-center gap-1.5">
							{isHealthy && <Badge tone="green">诊断正常：tick 活跃且快照新鲜</Badge>}
							{freshness.stale && <Badge tone="yellow">⚠️ 快照陈旧（&gt;5min）</Badge>}
							{freshness.heartbeatStale && <Badge tone="red">⚠️ 心跳停滞未更新</Badge>}
							{freshness.suspectedDisabled && <Badge tone="red">⚠️ 怀疑主动性被关闭</Badge>}
							{freshness.clockSkew && <Badge tone="yellow">⚠️ 时钟偏斜异常</Badge>}
						</div>
						<p className="text-foreground-subtle leading-relaxed">
							{isHealthy
								? "当前 owner tick 运行正常，快照更新及时，未触发异常告警。"
								: "检测到状态陈旧或心跳异常，请确认 config 中 enabled 配置及后台守护进程状态。"}
						</p>
					</div>
				</div>
			</div>
		</Card>
	);
}

// ── 3. Frontier 可视化（时效 / 项目矩阵 / 触发记录）─────────────────

type Tone = "green" | "red" | "gray" | "yellow" | "blue" | "purple" | "na";

const STATE_LABEL: Record<FrontierProjectState, string> = {
	Working: "进行中",
	Blocked: "阻塞",
	Completed: "已完成",
	Failed: "失败",
	Cancelled: "已取消",
};
const STATE_TONE: Record<FrontierProjectState, Tone> = {
	Working: "blue",
	Blocked: "yellow",
	Completed: "green",
	Failed: "red",
	Cancelled: "gray",
};

function GateBadge({ gate }: { gate: AutonomyGateStatus }) {
	if (gate === "ok") return <Badge tone="green" title="仓库 gate 正常">gate ok</Badge>;
	if (gate === "awaiting") return <Badge tone="yellow" title="gate 等待（等人）">gate 等待</Badge>;
	return <Badge tone="na" title="gate 未知/未定：无载体，不猜">gate 未知</Badge>;
}

function ProjectRow({ p }: { p: ProjectFrontier }) {
	const runs = Object.entries(p.runs);
	return (
		<div className={`rounded-lg border p-2.5 ${p.needsUser ? "tone-chip [--chip-tone:var(--color-accent)]" : "border-border bg-card"}`}>
			<div className="flex flex-wrap items-center gap-1.5">
				<Badge tone={STATE_TONE[p.state]}>{STATE_LABEL[p.state]}</Badge>
				{p.variant !== null && <Badge tone="gray" title="C5 变体标注">{p.variant}</Badge>}
				<GateBadge gate={p.gate} />
				{p.needsUser && <Badge tone="yellow" title="需要人工介入（needsUser 边沿触发）">⚠ 需人工</Badge>}
				{p.resultMissing && <Badge tone="gray" title="结果缺失（走 stagnation）">结果缺失</Badge>}
				{p.stagnation && <Badge tone="red" title="六态机 STALLED：停滞">停滞</Badge>}
				{p.overdue > 0 && <Badge tone="red" title="timer overdue">overdue {p.overdue}</Badge>}
			</div>
			<p className="mt-1.5 break-all font-mono text-ui-xs text-foreground">{p.project}</p>
			{runs.length > 0 && (
				<div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-ui-xs">
					{runs.map(([runId, phase]) => (
						<span key={runId} className="text-foreground-subtle">
							<span className="font-mono">{runId}</span> → <span className="text-foreground">{phase}</span>
						</span>
					))}
				</div>
			)}
		</div>
	);
}

function TriggerRow({ t }: { t: FrontierTrigger }) {
	return (
		<div className={`flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-border py-1.5 text-ui-sm last:border-b-0 ${t.approximate ? "border-dashed" : ""}`}>
			<span className="font-mono text-foreground">{t.rule}</span>
			<span className="min-w-0 break-all font-mono text-ui-xs text-foreground-subtle">{t.project}</span>
			<span className="text-ui-xs text-foreground-subtle">{t.evidence}</span>
			{t.approximate && <Badge tone="na" title="近似触发">近似</Badge>}
		</div>
	);
}

function FrontierViz() {
	const [snap, setSnap] = useState<FrontierSnapshot | null | undefined>(undefined);
	const [error, setError] = useState("");
	const refresh = useCallback(async () => {
		const r = await api.autonomyFrontier();
		if (r.ok) {
			setSnap(r.data);
			setError("");
		} else {
			setError(`读取 frontier 失败 HTTP ${r.status}`);
		}
	}, []);
	useEffect(() => {
		void refresh();
		const t = window.setInterval(() => void refresh(), 5000);
		return () => window.clearInterval(t);
	}, [refresh]);

	const title = <Term zh="自主性前沿投影" en="frontier" hint="autonomy 套件的触发投影：系统据此判断要不要放行唤醒。只读读盘，不重计算。" />;

	if (snap === undefined) {
		return (
			<Card title={title}>
				<EmptyState
					icon={error ? <AlertTriangle className="size-5" /> : undefined}
					action={error ? <Button variant="secondary" onClick={() => void refresh()}>重试</Button> : undefined}
				>
					{error || "正在加载 frontier 快照…"}
				</EmptyState>
			</Card>
		);
	}
	if (snap === null) {
		return (
			<Card title={title}>
				<EmptyState
					icon={<Activity className="size-6" />}
					action={<Button variant="secondary" onClick={() => void refresh()}>刷新</Button>}
				>
					frontier 快照尚未生成（autonomy 未启用，或尚未完成首次 tick）。
				</EmptyState>
			</Card>
		);
	}

	return (
		<div className="space-y-3">
			{/* 快照时效 */}
			<Card title={title}>
				{error && <p role="status" className="mb-2 text-ui-xs text-destructive">{error}；显示最近一次快照。</p>}
				<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-ui-sm">
					<span className="text-foreground-subtle">快照时间</span>
					<RelTime at={new Date(snap.asof).toISOString()} className="text-foreground" />
					{snap.baseline && (
						<Badge tone="na" title="首帧（prev=null）：只建基线、不算触发——防冷启动风暴">首帧基线</Badge>
					)}
					<span className="text-foreground-subtle">· {snap.projects.length} 项目 · {snap.triggers.length} 触发</span>
				</div>
			</Card>

			{/* 项目状态矩阵 */}
			<Card title={<Term zh="项目派生状态" en="projects" hint="每项目一行：state+variant / needsUser 高亮 / gate / 结果缺失 / 停滞 / overdue / runs 明细" />}>
				{snap.projects.length === 0 ? (
					<EmptyState
						icon={<Inbox className="size-5" />}
						action={<Button variant="secondary" onClick={() => void refresh()}>刷新</Button>}
					>
						无进行中项目（盘面无可见 tab）。
					</EmptyState>
				) : (
					<div className="space-y-2">
						{snap.projects.map((p) => <ProjectRow key={p.project} p={p} />)}
					</div>
				)}
			</Card>

			{/* 触发记录表 */}
			<Card title={<Term zh="决策触发记录" en="triggers" hint="本帧触发：rule / project / evidence；approximate 降透明度 + 「近似」徽标区分" />}>
				{snap.triggers.length === 0 ? (
					<EmptyState
						icon={<CheckCircle2 className="size-5" />}
						action={<Button variant="secondary" onClick={() => void refresh()}>刷新</Button>}
					>
						{snap.baseline ? "首帧基线：无触发（防冷启动风暴）。" : "本帧无触发。"}
					</EmptyState>
				) : (
					<div className="max-h-60 overflow-y-auto">
						{snap.triggers.map((t, i) => <TriggerRow key={`${t.rule}-${t.project}-${i}`} t={t} />)}
					</div>
				)}
			</Card>
		</div>
	);
}

// ── 4. SupervisionLedgerViz（监管账本工作状态表）─────────────────────

function formatRepoName(repoPath: string | null): string {
	if (!repoPath) return "未指定仓库";
	const clean = repoPath.replace(/[/\\]+$/, "");
	const parts = clean.split(/[/\\]/);
	return parts[parts.length - 1] || clean;
}

function SupervisionLedgerViz({ entries }: { entries: AutonomySupervisionEntry[] }) {
	const [search, setSearch] = useState("");
	const [filter, setFilter] = useState<"all" | "unreported" | "active" | "paused">("all");
	const [collapsedRepos, setCollapsedRepos] = useState<Record<string, boolean>>({});

	const toggleRepo = (repo: string) => {
		setCollapsedRepos((prev) => ({ ...prev, [repo]: !prev[repo] }));
	};

	// 统计指标
	const totalCount = entries.length;
	const unreportedCount = useMemo(() => entries.filter((e) => e.unreported).length, [entries]);
	const pausedCount = useMemo(() => entries.filter((e) => e.status === "paused").length, [entries]);
	const activeCount = totalCount - pausedCount;

	// 过滤条目
	const filtered = useMemo(() => {
		const q = search.trim().toLowerCase();
		return entries.filter((e) => {
			if (filter === "unreported" && !e.unreported) return false;
			if (filter === "active" && e.status !== "active") return false;
			if (filter === "paused" && e.status !== "paused") return false;
			if (q) {
				const matchId = e.runId.toLowerCase().includes(q);
				const matchTask = e.taskId.toLowerCase().includes(q);
				const matchRepo = (e.repoPath ?? "").toLowerCase().includes(q);
				if (!matchId && !matchTask && !matchRepo) return false;
			}
			return true;
		});
	}, [entries, search, filter]);

	// 按仓库分组
	const groups = useMemo(() => {
		const map = new Map<string, AutonomySupervisionEntry[]>();
		for (const e of filtered) {
			const repo = formatRepoName(e.repoPath);
			const list = map.get(repo) ?? [];
			list.push(e);
			map.set(repo, list);
		}
		return Array.from(map.entries()).sort((a, b) => b[1].length - a[1].length);
	}, [filtered]);

	return (
		<Card
			title={
				<div className="flex flex-wrap items-center gap-2">
					<Term zh="监管账本工作状态表" en="supervision ledger" hint="当前处于 open 集合的全部监管账本条目。记录任务标识、推活超时阈值与未回报状态。" />
					<Badge tone="gray">{totalCount} 条账本</Badge>
					{unreportedCount > 0 && (
						<Badge tone="yellow" title="已完成但未写入预期结果文件的条目">
							⚠ {unreportedCount} 条未回报
						</Badge>
					)}
					{pausedCount > 0 && <Badge tone="gray">{pausedCount} 暂停</Badge>}
				</div>
			}
		>
			<div className="space-y-3">
				{/* 搜索与快捷筛选条 */}
				<div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2.5">
					<div className="flex items-center gap-1.5">
						<button
							type="button"
							onClick={() => setFilter("all")}
							className={`rounded-md px-2 py-0.5 text-ui-xs font-medium transition-colors ${
								filter === "all" ? "bg-accent text-accent-foreground" : "bg-card text-foreground-subtle hover:text-foreground"
							}`}
						>
							全部 ({totalCount})
						</button>
						<button
							type="button"
							onClick={() => setFilter("unreported")}
							className={`rounded-md px-2 py-0.5 text-ui-xs font-medium transition-colors ${
								filter === "unreported" ? "bg-warning text-warning-foreground" : "bg-card text-foreground-subtle hover:text-foreground"
							}`}
						>
							未回报 ({unreportedCount})
						</button>
						<button
							type="button"
							onClick={() => setFilter("active")}
							className={`rounded-md px-2 py-0.5 text-ui-xs font-medium transition-colors ${
								filter === "active" ? "bg-accent text-accent-foreground" : "bg-card text-foreground-subtle hover:text-foreground"
							}`}
						>
							进行中 ({activeCount})
						</button>
						<button
							type="button"
							onClick={() => setFilter("paused")}
							className={`rounded-md px-2 py-0.5 text-ui-xs font-medium transition-colors ${
								filter === "paused" ? "bg-accent text-accent-foreground" : "bg-card text-foreground-subtle hover:text-foreground"
							}`}
						>
							已暂停 ({pausedCount})
						</button>
					</div>

					<div className="flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-0.5 text-ui-xs">
						<Search className="size-3.5 text-foreground-subtle" />
						<input
							type="text"
							placeholder="搜索任务/runId/仓库…"
							value={search}
							onChange={(e) => setSearch(e.target.value)}
							className="bg-transparent text-foreground placeholder:text-foreground-subtlest focus:outline-none"
						/>
					</div>
				</div>

				{/* 账本列表 */}
				{groups.length === 0 ? (
					<EmptyState icon={<Inbox className="size-5" />}>
						{entries.length === 0 ? "当前无活跃的监管账本条目。" : "没有匹配当前筛选条件的账本。"}
					</EmptyState>
				) : (
					<div className="space-y-2.5">
						{groups.map(([repo, items]) => {
							const isCollapsed = Boolean(collapsedRepos[repo]);
							const repoUnreported = items.filter((i) => i.unreported).length;
							return (
								<div key={repo} className="rounded-lg border border-border bg-card">
									{/* 仓库头 */}
									<div
										onClick={() => toggleRepo(repo)}
										className="flex cursor-pointer items-center justify-between px-3 py-2 text-ui-sm font-medium hover:bg-surface-hover"
									>
										<div className="flex items-center gap-2">
											{isCollapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
											<span className="text-foreground">{repo}</span>
											<Badge tone="gray">{items.length}</Badge>
											{repoUnreported > 0 && <Badge tone="yellow">⚠ {repoUnreported} 未回报</Badge>}
										</div>
										<span className="text-ui-xs text-foreground-subtle">{isCollapsed ? "点击展开" : "点击折叠"}</span>
									</div>

									{/* 仓库内条目列表 */}
									{!isCollapsed && (
										<div className="divide-y divide-border border-t border-border px-3 py-1">
											{items.map((item) => (
												<div key={item.runId} className="flex flex-wrap items-center justify-between gap-2 py-2 text-ui-xs">
													<div className="flex flex-wrap items-center gap-2">
														<ShortId value={item.runId} />
														<span className="font-semibold text-foreground">{item.taskId}</span>
														{item.status === "active" ? (
															<Badge tone="green">活跃</Badge>
														) : (
															<Badge tone="gray">暂停{item.pauseReason ? ` (${item.pauseReason})` : ""}</Badge>
														)}
														{item.optOut && <Badge tone="na">静默留档</Badge>}
														{item.unreported && (
															<Badge tone="yellow" title="该 tab 已退出但未写入结果文件">
																⚠ 未回报
															</Badge>
														)}
														<span className="text-foreground-subtle">
															push={Math.round(item.pushMs / 60000)}m
														</span>
													</div>

													<div className="flex items-center gap-2 text-foreground-subtle">
														<span>登记于 <RelTime at={item.setAt} /></span>
													</div>
												</div>
											))}
										</div>
									)}
								</div>
							);
						})}
					</div>
				)}
			</div>
		</Card>
	);
}

// ── 5. RawTerminalOutputViz（终端状态原文折叠卡片）─────────────────

function RawTerminalOutputViz({ raw }: { raw: string | null }) {
	const [expanded, setExpanded] = useState(false);
	const [copied, setCopied] = useState(false);

	if (!raw) return null;

	const handleCopy = () => {
		void navigator.clipboard?.writeText(raw).then(() => {
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1500);
		});
	};

	return (
		<Card
			title={
				<div
					onClick={() => setExpanded(!expanded)}
					className="flex cursor-pointer items-center justify-between gap-2"
				>
					<div className="flex items-center gap-2">
						<Terminal className="size-4 text-foreground-subtle" />
						<span className="text-foreground-subtle font-medium text-ui-sm">CLI 终端输出原文 (/autonomy status)</span>
					</div>
					<div className="flex items-center gap-2 text-ui-xs text-foreground-subtle">
						<span>{expanded ? "收起" : "展开"}</span>
						{expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
					</div>
				</div>
			}
		>
			{expanded && (
				<div className="space-y-2 pt-1">
					<div className="flex justify-end">
						<Button variant="secondary" size="sm" onClick={handleCopy}>
							<Copy className="size-3.5 mr-1" />
							{copied ? "已复制" : "复制全文"}
						</Button>
					</div>
					<pre className="max-h-80 overflow-auto rounded-lg border border-border bg-panel p-3 font-mono text-ui-xs leading-relaxed text-foreground-subtle">
						{raw}
					</pre>
				</div>
			)}
		</Card>
	);
}

// ── 主页面容器 ──────────────────────────────────────────────────────

export function AutonomyPage() {
	const [diag, setDiag] = useState<AutonomyDiagnosticsResponse | null>(null);

	const refreshDiag = useCallback(async () => {
		const r = await api.autonomyDiagnostics();
		if (r.ok) {
			setDiag(r.data);
		}
	}, []);

	useEffect(() => {
		void refreshDiag();
		const timer = window.setInterval(() => void refreshDiag(), 5000);
		return () => window.clearInterval(timer);
	}, [refreshDiag]);

	return (
		<div className="space-y-3">
			<PageIntro>
				主动性套件看板：全局总门控制、自主性前沿（frontier）投影、监管账本工作状态及存活健康诊断。
			</PageIntro>

			{/* 1. 总开关与控制面 */}
			<AutonomySettings />

			{/* 2. 存活心跳与健康诊断卡片 */}
			<DiagnosticsSummary data={diag} />

			{/* 3. 监管账本工作状态表 */}
			<SupervisionLedgerViz entries={diag?.supervision.entries ?? []} />

			{/* 4. 决策前沿可视化（时效/矩阵/触发） */}
			<FrontierViz />

			{/* 5. 终端原文折叠卡片 */}
			<RawTerminalOutputViz raw={diag?.raw ?? null} />
		</div>
	);
}
