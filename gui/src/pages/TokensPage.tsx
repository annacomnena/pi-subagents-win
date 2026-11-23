/**
 * gui/src/pages/TokensPage.tsx — Token 使用热力图与统计分析页面
 *
 * 功能结构：
 * 1. 顶部控制器：统计窗口选择（7天/14天/30天/90天/全量）+ 刷新按钮
 * 2. 核心指标卡片：总用量、Prompt 输入、Completion 输出、缓存命中率、预估费用、轮次/会话
 * 3. 热力图视图（Tab 切换）：
 *    - 日历贡献热力图（Calendar Heatmap）：按日展示 Token 消耗色阶，支持 hover 悬浮明细
 *    - 24小时时段分布（Hourly Heatmap）：展示 00:00-23:00 的时段用量峰谷分布
 * 4. 统计明细列表（Tab 切换）：
 *    - 按会话（By Session）：支持搜索、排序（Tokens/轮次/时间/费用），点击直达会话
 *    - 按模型（By Model）：模型份额进度条、各模型 Prompt/Output/Cache 与费用占比
 *    - 按日期（By Date）：每日消耗对账列表
 */

import { useEffect, useMemo, useState } from "react";
import {
	Activity,
	ArrowUpDown,
	BarChart3,
	Calendar,
	Clock,
	Coins,
	Cpu,
	ExternalLink,
	Flame,
	Layers,
	RefreshCw,
	Search,
	Sparkles,
	TrendingUp,
	Zap,
} from "lucide-react";
import { useGui } from "../store";
import { fmtDateTime, fmtRel, fmtTime, fmtTokens } from "../format";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import type { DailyUsageAggregate } from "../api/types";

type HeatmapMode = "calendar" | "hourly";
type TableTab = "sessions" | "models" | "daily";
type SessionSortField = "totalTokens" | "turns" | "lastActiveAt" | "costUsd";

const DAY_OPTIONS = [
	{ label: "今天", value: 1 },
	{ label: "最近 7 天", value: 7 },
	{ label: "最近 14 天", value: 14 },
	{ label: "最近 30 天", value: 30 },
	{ label: "最近 90 天", value: 90 },
	{ label: "全部记录", value: 0 },
];

export function TokensPage() {
	const tokenStats = useGui((s) => s.tokenStats);
	const loading = useGui((s) => s.tokenStatsLoading);
	const tokenStatsDays = useGui((s) => s.tokenStatsDays);
	const setTokenStatsDays = useGui((s) => s.setTokenStatsDays);
	const fetchTokenStats = useGui((s) => s.fetchTokenStats);
	const openChatSession = useGui((s) => s.openChatSession);

	const [heatmapMode, setHeatmapMode] = useState<HeatmapMode>("calendar");
	const [tableTab, setTableTab] = useState<TableTab>("sessions");
	const [searchQuery, setSearchQuery] = useState("");
	const [sortField, setSortField] = useState<SessionSortField>("totalTokens");
	const [sortAsc, setSortAsc] = useState(false);

	// 初次挂载或切换到该页时拉取
	useEffect(() => {
		if (tokenStats === null && !loading) {
			void fetchTokenStats();
		}
	}, [tokenStats, loading, fetchTokenStats]);

	// 计算日历热力图网格（以天为单位）
	const calendarDays = useMemo(() => {
		if (!tokenStats || tokenStats.daily.length === 0) return [];
		const dailyMap = new Map<string, DailyUsageAggregate>();
		let maxTokens = 1;
		for (const d of tokenStats.daily) {
			dailyMap.set(d.date, d);
			if (d.totalTokens > maxTokens) maxTokens = d.totalTokens;
		}

		// 确定起止日期
		const sorted = tokenStats.daily.map((d) => d.date).sort();
		const earliestStr = sorted[0];
		const latestStr = sorted[sorted.length - 1];
		const start = new Date(earliestStr);
		const end = new Date(latestStr);

		// 如果跨度不足 14 天，往前补足至少 14 天
		const diffDays = Math.max(1, Math.round((end.getTime() - start.getTime()) / (86400 * 1000)));
		if (diffDays < 14) {
			start.setDate(start.getDate() - (14 - diffDays));
		}

		const days: Array<{
			dateStr: string;
			date: Date;
			data: DailyUsageAggregate | null;
			intensity: number; // 0..4
			isToday: boolean;
		}> = [];

		const cur = new Date(start);
		while (cur <= end) {
			const y = cur.getFullYear();
			const m = String(cur.getMonth() + 1).padStart(2, "0");
			const d = String(cur.getDate()).padStart(2, "0");
			const dateStr = `${y}-${m}-${d}`;

			const data = dailyMap.get(dateStr) ?? null;
			let intensity = 0;
			if (data && data.totalTokens > 0) {
				const ratio = data.totalTokens / maxTokens;
				if (ratio <= 0.15) intensity = 1;
				else if (ratio <= 0.4) intensity = 2;
				else if (ratio <= 0.75) intensity = 3;
				else intensity = 4;
			}

			days.push({
				dateStr,
				date: new Date(cur),
				data,
				intensity,
				isToday: cur.toDateString() === new Date().toDateString(),
			});

			cur.setDate(cur.getDate() + 1);
		}

		return days;
	}, [tokenStats]);

	// 24小时时段分布最大值
	const maxHourlyTokens = useMemo(() => {
		if (!tokenStats || tokenStats.hourly.length === 0) return 1;
		return Math.max(1, ...tokenStats.hourly.map((h) => h.totalTokens));
	}, [tokenStats]);

	// 过滤与排序后的会话列表
	const filteredSessions = useMemo(() => {
		if (!tokenStats) return [];
		let list = tokenStats.bySession.slice();
		const q = searchQuery.trim().toLowerCase();
		if (q) {
			list = list.filter(
				(s) =>
					s.sessionId.toLowerCase().includes(q) ||
					(s.title && s.title.toLowerCase().includes(q)) ||
					s.model.toLowerCase().includes(q) ||
					(s.cwd && s.cwd.toLowerCase().includes(q)),
			);
		}
		list.sort((a, b) => {
			let res = 0;
			if (sortField === "totalTokens") res = a.totalTokens - b.totalTokens;
			else if (sortField === "turns") res = a.turns - b.turns;
			else if (sortField === "costUsd") res = a.costUsd - b.costUsd;
			else if (sortField === "lastActiveAt") {
				const tA = a.lastActiveAt ? Date.parse(a.lastActiveAt) : 0;
				const tB = b.lastActiveAt ? Date.parse(b.lastActiveAt) : 0;
				res = tA - tB;
			}
			return sortAsc ? res : -res;
		});
		return list;
	}, [tokenStats, searchQuery, sortField, sortAsc]);

	const toggleSort = (field: SessionSortField) => {
		if (sortField === field) {
			setSortAsc(!sortAsc);
		} else {
			setSortField(field);
			setSortAsc(false);
		}
	};

	const summary = tokenStats?.summary;

	return (
		<div className="flex h-full flex-col overflow-y-auto bg-background text-foreground">
			{/* 顶栏与控制区 */}
			<header className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-4 border-b border-border bg-panel/95 px-6 py-4 backdrop-blur-sm">
				<div className="flex items-center gap-3">
					<div className="flex size-9 items-center justify-center rounded-xl bg-accent/15 text-accent shadow-sm">
						<BarChart3 className="size-5" />
					</div>
					<div>
						<h1 className="text-ui-lg font-semibold tracking-tight text-foreground">Token 统计与热力图</h1>
						<p className="text-ui-xs text-foreground-subtle">
							{tokenStats
								? `统计周期: ${tokenStats.days === 1 ? "今天 (00:00 至今)" : tokenStats.days === 0 ? "全部时间" : `最近 ${tokenStats.days} 天`} · 数据更新截至 ${fmtTime(tokenStats.asOf)}`
								: "正在加载 Token 历史消耗聚合数据..."}
						</p>
					</div>
				</div>

				<div className="flex items-center gap-2">
					{/* 时间范围快捷选择 */}
					<div className="inline-flex rounded-lg border border-border bg-surface p-0.5 text-ui-xs">
						{DAY_OPTIONS.map((opt) => (
							<button
								key={opt.value}
								type="button"
								onClick={() => setTokenStatsDays(opt.value)}
								className={`rounded-md px-2.5 py-1 font-medium transition-colors ${
									tokenStatsDays === opt.value
										? "bg-selected text-foreground shadow-xs"
										: "text-foreground-subtle hover:text-foreground"
								}`}
							>
								{opt.label}
							</button>
						))}
					</div>

					<Button
						variant="outline"
						size="sm"
						onClick={() => fetchTokenStats()}
						disabled={loading}
						className="gap-1.5"
						title="刷新统计数据"
					>
						<RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
						<span>刷新</span>
					</Button>
				</div>
			</header>

			{/* 主内容区 */}
			<main className="flex-1 space-y-6 p-6">
				{/* 核心指标 KPI 卡片 */}
				<div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-7">
					{/* 今日消耗 */}
					<div className="rounded-xl border border-accent/40 bg-accent/5 p-4 shadow-xs">
						<div className="flex items-center justify-between text-ui-xs text-accent font-medium">
							<span>今日消耗 (今天)</span>
							<Clock className="size-4 text-accent" />
						</div>
						<div className="mt-2 text-ui-xl font-bold tracking-tight text-accent">
							{fmtTokens(summary?.today?.totalTokens ?? (tokenStatsDays === 1 ? summary?.totalTokens : 0))}
						</div>
						<div className="mt-1 flex items-center justify-between text-ui-xs text-foreground-subtle">
							<span>{summary?.today?.turns ?? (tokenStatsDays === 1 ? summary?.totalTurns : 0)} 轮交互</span>
							<span>${(summary?.today?.costUsd ?? (tokenStatsDays === 1 ? summary?.estimatedCostUsd : 0) ?? 0).toFixed(2)}</span>
						</div>
					</div>

					{/* 总 Token */}
					<div className="rounded-xl border border-border bg-panel p-4 shadow-xs">
						<div className="flex items-center justify-between text-ui-xs text-foreground-subtle">
							<span>总 Tokens 消耗</span>
							<Flame className="size-4 text-warning" />
						</div>
						<div className="mt-2 text-ui-xl font-bold tracking-tight text-foreground">
							{fmtTokens(summary?.totalTokens)}
						</div>
						<div className="mt-1 text-ui-xs text-foreground-subtlest" title={summary?.totalTokens?.toLocaleString()}>
							精确: {summary ? summary.totalTokens.toLocaleString() : "--"}
						</div>
					</div>

					{/* Prompt / Input */}
					<div className="rounded-xl border border-border bg-panel p-4 shadow-xs">
						<div className="flex items-center justify-between text-ui-xs text-foreground-subtle">
							<span>Prompt 输入</span>
							<TrendingUp className="size-4 text-info" />
						</div>
						<div className="mt-2 text-ui-xl font-bold tracking-tight text-foreground">
							{fmtTokens(summary?.inputTokens)}
						</div>
						<div className="mt-1 text-ui-xs text-foreground-subtlest">
							{summary && summary.totalTokens > 0
								? `${((summary.inputTokens / summary.totalTokens) * 100).toFixed(1)}% 占比`
								: "--"}
						</div>
					</div>

					{/* Completion / Output */}
					<div className="rounded-xl border border-border bg-panel p-4 shadow-xs">
						<div className="flex items-center justify-between text-ui-xs text-foreground-subtle">
							<span>Completion 输出</span>
							<Zap className="size-4 text-accent" />
						</div>
						<div className="mt-2 text-ui-xl font-bold tracking-tight text-foreground">
							{fmtTokens(summary?.outputTokens)}
						</div>
						<div className="mt-1 text-ui-xs text-foreground-subtlest">
							{summary && summary.totalTokens > 0
								? `${((summary.outputTokens / summary.totalTokens) * 100).toFixed(1)}% 占比`
								: "--"}
						</div>
					</div>

					{/* 缓存命中率 */}
					<div className="rounded-xl border border-border bg-panel p-4 shadow-xs">
						<div className="flex items-center justify-between text-ui-xs text-foreground-subtle">
							<span>缓存读取节省率</span>
							<Sparkles className="size-4 text-success" />
						</div>
						<div className="mt-2 text-ui-xl font-bold tracking-tight text-success">
							{summary?.cacheHitRatePercent !== null && summary?.cacheHitRatePercent !== undefined
								? `${summary.cacheHitRatePercent}%`
								: "--"}
						</div>
						<div className="mt-1 text-ui-xs text-foreground-subtlest">
							省读 {fmtTokens(summary?.cacheReadTokens)} tokens
						</div>
					</div>

					{/* 预估费用 */}
					<div className="rounded-xl border border-border bg-panel p-4 shadow-xs">
						<div className="flex items-center justify-between text-ui-xs text-foreground-subtle">
							<span>预估调用费用</span>
							<Coins className="size-4 text-warning" />
						</div>
						<div className="mt-2 text-ui-xl font-bold tracking-tight text-foreground">
							${summary?.estimatedCostUsd !== undefined ? summary.estimatedCostUsd.toFixed(2) : "--"}
						</div>
						<div className="mt-1 text-ui-xs text-foreground-subtlest">
							基于模型原始账单
						</div>
					</div>

					{/* 轮次与会话 */}
					<div className="rounded-xl border border-border bg-panel p-4 shadow-xs">
						<div className="flex items-center justify-between text-ui-xs text-foreground-subtle">
							<span>交互轮次 / 会话</span>
							<Layers className="size-4 text-foreground-subtle" />
						</div>
						<div className="mt-2 text-ui-xl font-bold tracking-tight text-foreground">
							{summary?.totalTurns?.toLocaleString() ?? "--"}
						</div>
						<div className="mt-1 text-ui-xs text-foreground-subtlest">
							涵盖 {summary?.totalSessions ?? 0} 个会话
						</div>
					</div>
				</div>

				{/* 热力图看板模块 */}
				<section className="rounded-xl border border-border bg-panel p-5 shadow-xs">
					<div className="mb-4 flex flex-wrap items-center justify-between gap-3">
						<div className="flex items-center gap-2">
							<Activity className="size-4 text-accent" />
							<h2 className="text-ui-base font-semibold text-foreground">Token 使用热力分布</h2>
							<span className="text-ui-xs text-foreground-subtle">
								{heatmapMode === "calendar" ? "每日消耗强度日历" : "全天 24 小时高频时段分布"}
							</span>
						</div>

						{/* 模式切换 */}
						<div className="inline-flex rounded-lg border border-border bg-surface p-0.5 text-ui-xs">
							<button
								type="button"
								onClick={() => setHeatmapMode("calendar")}
								className={`flex items-center gap-1.5 rounded-md px-3 py-1 font-medium transition-colors ${
									heatmapMode === "calendar"
										? "bg-selected text-foreground shadow-xs"
										: "text-foreground-subtle hover:text-foreground"
								}`}
							>
								<Calendar className="size-3.5" />
								<span>日历热力图</span>
							</button>
							<button
								type="button"
								onClick={() => setHeatmapMode("hourly")}
								className={`flex items-center gap-1.5 rounded-md px-3 py-1 font-medium transition-colors ${
									heatmapMode === "hourly"
										? "bg-selected text-foreground shadow-xs"
										: "text-foreground-subtle hover:text-foreground"
								}`}
							>
								<Clock className="size-3.5" />
								<span>24小时峰谷</span>
							</button>
						</div>
					</div>

					{/* 视图 1：日历热力图 (GitHub 风格) */}
					{heatmapMode === "calendar" && (
						<div>
							{calendarDays.length === 0 ? (
								<div className="flex h-32 items-center justify-center text-ui-sm text-foreground-subtle">
									暂无该时段的每日消耗记录
								</div>
							) : (
								<div className="space-y-3">
									<div className="overflow-x-auto pb-2">
										<div className="flex flex-wrap gap-1.5 sm:grid sm:grid-flow-col sm:grid-rows-7 sm:gap-2">
											{calendarDays.map((item) => {
												const hasData = item.data !== null && item.data.totalTokens > 0;
												const colorClass =
													item.intensity === 4
														? "bg-emerald-500 text-white"
														: item.intensity === 3
															? "bg-emerald-500/70 text-white"
															: item.intensity === 2
																? "bg-emerald-500/40 text-foreground"
																: item.intensity === 1
																	? "bg-emerald-500/20 text-foreground"
																	: "bg-surface hover:bg-surface-hover text-foreground-subtle";

												return (
													<Tooltip key={item.dateStr}>
														<TooltipTrigger asChild>
															<div
																className={`relative flex size-6 sm:size-7 items-center justify-center rounded-md border border-border/40 text-[10px] font-mono transition-transform hover:scale-110 cursor-pointer ${
																	item.isToday ? "ring-2 ring-accent ring-offset-1 font-bold shadow-xs" : ""
																} ${colorClass}`}
															>
																{item.isToday ? "今" : item.date.getDate()}
															</div>
														</TooltipTrigger>
														<TooltipContent side="top" className="max-w-xs space-y-1.5 p-2.5">
															<div className="font-semibold text-ui-xs flex items-center justify-between gap-2">
																<span>{item.dateStr} (周{["日", "一", "二", "三", "四", "五", "六"][item.date.getDay()]})</span>
																{item.isToday && <Badge variant="secondary" className="text-[10px] px-1 py-0 h-4">今天</Badge>}
															</div>
															{hasData && item.data ? (
																<div className="space-y-1 text-ui-xs">
																	<div className="flex justify-between gap-4">
																		<span className="text-foreground-subtle">总 Tokens:</span>
																		<span className="font-semibold text-accent">{item.data.totalTokens.toLocaleString()}</span>
																	</div>
																	<div className="flex justify-between gap-4">
																		<span className="text-foreground-subtle">Prompt / Output:</span>
																		<span>{fmtTokens(item.data.inputTokens)} / {fmtTokens(item.data.outputTokens)}</span>
																	</div>
																	<div className="flex justify-between gap-4">
																		<span className="text-foreground-subtle">缓存命中读取:</span>
																		<span>{fmtTokens(item.data.cacheReadTokens)}</span>
																	</div>
																	<div className="flex justify-between gap-4">
																		<span className="text-foreground-subtle">交互轮次 / 会话:</span>
																		<span>{item.data.turns} 轮 / {item.data.sessionsCount} 个</span>
																	</div>
																	{item.data.costUsd > 0 && (
																		<div className="flex justify-between gap-4">
																			<span className="text-foreground-subtle">预估费用:</span>
																			<span>${item.data.costUsd.toFixed(3)}</span>
																		</div>
																	)}
																</div>
															) : (
																<div className="text-ui-xs text-foreground-subtle">当日无交互与消耗</div>
															)}
														</TooltipContent>
													</Tooltip>
												);
											})}
										</div>
									</div>

									{/* 图例 */}
									<div className="flex items-center justify-between text-ui-xs text-foreground-subtle pt-2 border-t border-border/50">
										<div className="flex items-center gap-1.5">
											<span>少</span>
											<div className="size-3.5 rounded-xs bg-surface border border-border/50" />
											<div className="size-3.5 rounded-xs bg-emerald-500/20" />
											<div className="size-3.5 rounded-xs bg-emerald-500/40" />
											<div className="size-3.5 rounded-xs bg-emerald-500/70" />
											<div className="size-3.5 rounded-xs bg-emerald-500" />
											<span>多</span>
										</div>
										<span>共记录 {tokenStats?.daily.length ?? 0} 个活跃日期</span>
									</div>
								</div>
							)}
						</div>
					)}

					{/* 视图 2：24小时时段分布 */}
					{heatmapMode === "hourly" && (
						<div className="space-y-4">
							<div className="grid grid-cols-12 sm:grid-cols-24 gap-1.5 items-end h-40 pt-4">
								{(tokenStats?.hourly ?? []).map((h) => {
									const heightPercent = maxHourlyTokens > 0 ? Math.max(6, Math.round((h.totalTokens / maxHourlyTokens) * 100)) : 6;
									return (
										<Tooltip key={h.hour}>
											<TooltipTrigger asChild>
												<div className="flex flex-col items-center gap-1.5 h-full justify-end group cursor-pointer">
													<div
														style={{ height: `${heightPercent}%` }}
														className={`w-full rounded-t-sm transition-all group-hover:brightness-125 ${
															h.totalTokens > 0
																? "bg-accent shadow-xs"
																: "bg-surface"
														}`}
													/>
													<span className="text-[10px] font-mono text-foreground-subtlest group-hover:text-foreground">
														{String(h.hour).padStart(2, "0")}
													</span>
												</div>
											</TooltipTrigger>
											<TooltipContent side="top" className="text-ui-xs space-y-1">
												<div className="font-semibold">{String(h.hour).padStart(2, "0")}:00 - {String(h.hour).padStart(2, "0")}:59</div>
												<div>消耗: <span className="font-semibold text-accent">{fmtTokens(h.totalTokens)}</span> ({h.totalTokens.toLocaleString()} tokens)</div>
												<div>轮次: {h.turns} 轮交互</div>
											</TooltipContent>
										</Tooltip>
									);
								})}
							</div>
							<div className="flex justify-between items-center text-ui-xs text-foreground-subtle border-t border-border/50 pt-2">
								<span>横轴: 00:00 至 23:00 时段</span>
								<span>柱高代表时段 Token 消耗总量</span>
							</div>
						</div>
					)}
				</section>

				{/* 统计明细列表与表格 */}
				<section className="rounded-xl border border-border bg-panel p-5 shadow-xs">
					{/* 切换 Tab 与搜索过滤 */}
					<div className="mb-4 flex flex-wrap items-center justify-between gap-3">
						<div className="inline-flex rounded-lg border border-border bg-surface p-0.5 text-ui-xs">
							<button
								type="button"
								onClick={() => setTableTab("sessions")}
								className={`flex items-center gap-1.5 rounded-md px-3 py-1 font-medium transition-colors ${
									tableTab === "sessions"
										? "bg-selected text-foreground shadow-xs"
										: "text-foreground-subtle hover:text-foreground"
								}`}
							>
								<Layers className="size-3.5" />
								<span>按会话明细 ({tokenStats?.bySession.length ?? 0})</span>
							</button>
							<button
								type="button"
								onClick={() => setTableTab("models")}
								className={`flex items-center gap-1.5 rounded-md px-3 py-1 font-medium transition-colors ${
									tableTab === "models"
										? "bg-selected text-foreground shadow-xs"
										: "text-foreground-subtle hover:text-foreground"
								}`}
							>
								<Cpu className="size-3.5" />
								<span>按模型分布 ({tokenStats?.byModel.length ?? 0})</span>
							</button>
							<button
								type="button"
								onClick={() => setTableTab("daily")}
								className={`flex items-center gap-1.5 rounded-md px-3 py-1 font-medium transition-colors ${
									tableTab === "daily"
										? "bg-selected text-foreground shadow-xs"
										: "text-foreground-subtle hover:text-foreground"
								}`}
							>
								<Calendar className="size-3.5" />
								<span>每日日志 ({tokenStats?.daily.length ?? 0})</span>
							</button>
						</div>

						{tableTab === "sessions" && (
							<div className="relative w-64">
								<Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-foreground-subtlest" />
								<Input
									value={searchQuery}
									onChange={(e) => setSearchQuery(e.target.value)}
									placeholder="搜索会话名 / ID / 模型..."
									className="h-8 pl-8 text-ui-xs"
								/>
							</div>
						)}
					</div>

					{/* 表格内容 */}
					{tableTab === "sessions" && (
						<div className="overflow-x-auto">
							<table className="w-full text-left text-ui-xs">
								<thead>
									<tr className="border-b border-border text-foreground-subtle">
										<th className="pb-2 font-medium">会话名称 / ID</th>
										<th className="pb-2 font-medium">主用模型</th>
										<th className="pb-2 font-medium cursor-pointer hover:text-foreground" onClick={() => toggleSort("totalTokens")}>
											<div className="inline-flex items-center gap-1">
												<span>总 Tokens</span>
												<ArrowUpDown className="size-3" />
											</div>
										</th>
										<th className="pb-2 font-medium">Prompt / Output</th>
										<th className="pb-2 font-medium">缓存命中</th>
										<th className="pb-2 font-medium cursor-pointer hover:text-foreground" onClick={() => toggleSort("turns")}>
											<div className="inline-flex items-center gap-1">
												<span>轮次</span>
												<ArrowUpDown className="size-3" />
											</div>
										</th>
										<th className="pb-2 font-medium cursor-pointer hover:text-foreground" onClick={() => toggleSort("costUsd")}>
											<div className="inline-flex items-center gap-1">
												<span>预估费用</span>
												<ArrowUpDown className="size-3" />
											</div>
										</th>
										<th className="pb-2 font-medium cursor-pointer hover:text-foreground" onClick={() => toggleSort("lastActiveAt")}>
											<div className="inline-flex items-center gap-1">
												<span>最后活跃</span>
												<ArrowUpDown className="size-3" />
											</div>
										</th>
										<th className="pb-2 text-right font-medium">操作</th>
									</tr>
								</thead>
								<tbody className="divide-y divide-border/50">
									{filteredSessions.length === 0 ? (
										<tr>
											<td colSpan={9} className="py-8 text-center text-foreground-subtle">
												未找到匹配的会话记录
											</td>
										</tr>
									) : (
										filteredSessions.slice(0, 100).map((s) => (
											<tr key={s.sessionId} className="group hover:bg-surface/60 transition-colors">
												<td className="py-2.5 pr-3 max-w-[240px]">
													<div className="font-medium text-foreground truncate" title={s.title ?? s.sessionId}>
														{s.title && s.title.trim() ? s.title : s.sessionId}
													</div>
													<div className="text-[11px] font-mono text-foreground-subtlest truncate" title={s.sessionId}>
														{s.sessionId}
													</div>
												</td>
												<td className="py-2.5 pr-3">
													<div className="flex flex-col gap-0.5">
														<span className="font-mono text-foreground">{s.model}</span>
														<span className="text-[10px] text-foreground-subtlest">{s.provider}</span>
													</div>
												</td>
												<td className="py-2.5 pr-3 font-semibold text-accent">
													{fmtTokens(s.totalTokens)}
												</td>
												<td className="py-2.5 pr-3 text-foreground-subtle">
													{fmtTokens(s.inputTokens)} / {fmtTokens(s.outputTokens)}
												</td>
												<td className="py-2.5 pr-3 text-foreground-subtle">
													{fmtTokens(s.cacheReadTokens)}
												</td>
												<td className="py-2.5 pr-3 text-foreground-subtle">
													{s.turns} 轮
												</td>
												<td className="py-2.5 pr-3 text-foreground-subtle">
													${s.costUsd.toFixed(3)}
												</td>
												<td className="py-2.5 pr-3 text-foreground-subtlest" title={s.lastActiveAt ? fmtDateTime(s.lastActiveAt) : undefined}>
													{fmtRel(s.lastActiveAt)}
												</td>
												<td className="py-2.5 text-right">
													<Button
														variant="ghost"
														size="sm"
														className="h-7 gap-1 px-2 text-ui-xs"
														onClick={() => openChatSession(s.sessionId)}
														title="打开该会话并查看对话内容"
													>
														<span>打开</span>
														<ExternalLink className="size-3" />
													</Button>
												</td>
											</tr>
										))
									)}
								</tbody>
							</table>
							{filteredSessions.length > 100 && (
								<div className="py-3 text-center text-ui-xs text-foreground-subtle border-t border-border/50">
									仅展示前 100 条会话，更多可通过搜索精准过滤
								</div>
							)}
						</div>
					)}

					{/* 维度 2：按模型分布 */}
					{tableTab === "models" && (
						<div className="space-y-4">
							<div className="grid gap-3">
								{(tokenStats?.byModel ?? []).map((m) => (
									<div key={`${m.provider}:${m.model}`} className="rounded-lg border border-border/60 bg-surface/40 p-3.5 space-y-2">
										<div className="flex flex-wrap items-center justify-between gap-2">
											<div className="flex items-center gap-2">
												<Badge variant="outline" className="font-mono text-ui-xs">
													{m.provider}
												</Badge>
												<span className="font-semibold text-foreground">{m.model}</span>
											</div>
											<div className="flex items-center gap-4 text-ui-xs">
												<span className="text-foreground-subtle">
													轮次: <strong className="text-foreground">{m.turns.toLocaleString()}</strong>
												</span>
												<span className="text-foreground-subtle">
													总 Tokens: <strong className="text-accent">{fmtTokens(m.totalTokens)}</strong> ({m.percent}%)
												</span>
												{m.costUsd > 0 && (
													<span className="text-foreground-subtle">
														费用: <strong className="text-foreground">${m.costUsd.toFixed(2)}</strong>
													</span>
												)}
											</div>
										</div>

										{/* 进度条 */}
										<div className="h-2 w-full overflow-hidden rounded-full bg-surface">
											<div
												className="h-full rounded-full bg-accent transition-all duration-500"
												style={{ width: `${Math.max(1, m.percent)}%` }}
											/>
										</div>

										<div className="flex justify-between text-[11px] text-foreground-subtle">
											<span>Prompt 输入: {fmtTokens(m.inputTokens)} · Completion 输出: {fmtTokens(m.outputTokens)}</span>
											<span>缓存命中读取: {fmtTokens(m.cacheReadTokens)}</span>
										</div>
									</div>
								))}
							</div>
						</div>
					)}

					{/* 维度 3：按每日日志 */}
					{tableTab === "daily" && (
						<div className="overflow-x-auto">
							<table className="w-full text-left text-ui-xs">
								<thead>
									<tr className="border-b border-border text-foreground-subtle">
										<th className="pb-2 font-medium">日期</th>
										<th className="pb-2 font-medium">总 Tokens</th>
										<th className="pb-2 font-medium">Prompt 输入</th>
										<th className="pb-2 font-medium">Completion 输出</th>
										<th className="pb-2 font-medium">缓存读取</th>
										<th className="pb-2 font-medium">交互轮次</th>
										<th className="pb-2 font-medium">会话数</th>
										<th className="pb-2 text-right font-medium">预估费用</th>
									</tr>
								</thead>
								<tbody className="divide-y divide-border/50">
									{(tokenStats?.daily ?? []).slice().reverse().map((d) => {
										const now = new Date();
										const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
										const isToday = d.date === todayStr;
										return (
										<tr key={d.date} className={`hover:bg-surface/60 transition-colors ${isToday ? "bg-accent/5" : ""}`}>
											<td className="py-2.5 font-mono font-medium text-foreground">
												<div className="flex items-center gap-1.5">
													<span>{d.date}</span>
													{isToday && <Badge variant="secondary" className="text-[10px] px-1 py-0 h-4 text-accent border-accent/30">今天</Badge>}
												</div>
											</td>
											<td className="py-2.5 font-semibold text-accent">{fmtTokens(d.totalTokens)}</td>
											<td className="py-2.5 text-foreground-subtle">{fmtTokens(d.inputTokens)}</td>
											<td className="py-2.5 text-foreground-subtle">{fmtTokens(d.outputTokens)}</td>
											<td className="py-2.5 text-foreground-subtle">{fmtTokens(d.cacheReadTokens)}</td>
											<td className="py-2.5 text-foreground-subtle">{d.turns} 轮</td>
											<td className="py-2.5 text-foreground-subtle">{d.sessionsCount} 个</td>
											<td className="py-2.5 text-right font-mono text-foreground">${d.costUsd.toFixed(3)}</td>
										</tr>
									);})}
								</tbody>
							</table>
						</div>
					)}
				</section>
			</main>
		</div>
	);
}
