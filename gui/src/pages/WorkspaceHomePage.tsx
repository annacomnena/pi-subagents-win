/**
 * gui/src/pages/WorkspaceHomePage.tsx — 仓库主页工作台（Workspace Cockpit / Repo Home）。
 *
 * 规格：plans/20261113_gui_workspace_home_cockpit_plan.md
 * 核心：以仓库为一等实体的聚合驾驶舱。展示任务跟踪、状态机透视与当前运行态账本，
 * 换来除了线性对话之外的高效直观交互。
 */

import { useCallback, useMemo, useState } from "react";
import {
	Activity,
	Copy,
	FileText,
	Folder,
	MessageSquare,
	PlayCircle,
	ShieldAlert,
	Zap,
} from "lucide-react";
import { useGui } from "../store";
import { basename } from "../workspaceGroup";
import { Badge, Button, Card, EmptyState, RelTime, ShortId } from "../ui";
import { api } from "../api/client";
import type { FrontierSnapshot, ProjectFrontier, RunCard, WorkspaceOverviewResponse, WorkspaceTaskItem } from "../api/types";
import { deriveRunDisplay, formatUsage, loopBadge, TONE_TO_BADGE } from "../runsView";
import { usePoll } from "../usePoll";
import { toast } from "../ui/toast";

export function WorkspaceHomePage() {
	const activeCwd = useGui((s) => s.activeWorkspaceCwd);
	const sessions = useGui((s) => s.chatSessions);
	const openChatSession = useGui((s) => s.openChatSession);

	const repoName = useMemo(() => (activeCwd ? basename(activeCwd) : "未选定仓库"), [activeCwd]);

	// 属于当前仓库的所有会话
	const repoSessions = useMemo(() => {
		if (!activeCwd) return [];
		return sessions.filter((s) => s.cwd === activeCwd);
	}, [sessions, activeCwd]);

	// 最新更新的会话
	const latestSession = useMemo(() => {
		if (repoSessions.length === 0) return null;
		return [...repoSessions].sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0))[0];
	}, [repoSessions]);

	// 真实任务概览（来自后端 GET /v1/workspace/overview）
	const [overview, setOverview] = useState<WorkspaceOverviewResponse | null>(null);
	const refreshOverview = useCallback(async () => {
		if (!activeCwd) return;
		const res = await api.workspaceOverview(activeCwd);
		if (res.ok) setOverview(res.data);
	}, [activeCwd]);
	usePoll(refreshOverview, 4000);

	// Frontier 状态（每 5s 轮询一次）
	const [frontier, setFrontier] = useState<FrontierSnapshot | null>(null);
	const refreshFrontier = useCallback(async () => {
		const res = await api.autonomyFrontier();
		if (res.ok && res.data) setFrontier(res.data);
	}, []);
	usePoll(refreshFrontier, 5000);

	// 当前仓库在 Frontier 里的状态
	const projectFrontier: ProjectFrontier | undefined = useMemo(() => {
		if (!frontier || !activeCwd) return undefined;
		return frontier.projects.find((p) => p.project.toLowerCase() === repoName.toLowerCase());
	}, [frontier, activeCwd, repoName]);

	// 运行态账本（每 5s 轮询一次）
	const [runs, setRuns] = useState<RunCard[]>([]);
	const refreshRuns = useCallback(async () => {
		const res = await api.runs();
		if (res.ok) {
			setRuns(res.data.runs);
		}
	}, []);
	usePoll(refreshRuns, 5000);

	// 复制路径
	const handleCopyPath = () => {
		if (!activeCwd) return;
		void navigator.clipboard.writeText(activeCwd);
		toast("仓库绝对路径已复制到剪贴板");
	};

	if (!activeCwd) {
		return (
			<div className="flex h-full items-center justify-center p-6 text-foreground-subtle">
				<EmptyState icon={<Folder className="size-8" />}>
					<div className="space-y-1">
						<div className="font-medium text-foreground">未选择仓库</div>
						<div className="text-ui-sm text-foreground-subtle">
							请在左侧边栏点击任意仓库名称（如 GreenCAD），打开其专属主页工作台。
						</div>
					</div>
				</EmptyState>
			</div>
		);
	}

	return (
		<div className="flex h-full flex-col overflow-y-auto bg-background p-6">
			{/* 顶栏 Header */}
			<header className="mb-6 rounded-xl border border-border bg-card p-5 shadow-sm">
				<div className="flex flex-wrap items-center justify-between gap-4">
					<div className="flex items-center gap-3">
						<div className="flex size-11 items-center justify-center rounded-xl bg-tag text-foreground shadow-sm">
							<Folder className="size-6 text-accent" />
						</div>
						<div>
							<div className="flex items-center gap-2">
								<h1 className="text-xl font-bold tracking-tight text-foreground">{repoName}</h1>
								{projectFrontier && (
									<Badge
										tone={
											projectFrontier.state === "Working"
												? "blue"
												: projectFrontier.state === "Blocked"
													? "yellow"
													: projectFrontier.state === "Completed"
														? "green"
														: "gray"
										}
									>
										{projectFrontier.state}
									</Badge>
								)}
								{projectFrontier?.needsUser && (
									<Badge tone="red" title="当前需要人工介入裁决">
										等待决策
									</Badge>
								)}
							</div>
							<div className="mt-1 flex items-center gap-2 font-mono text-ui-xs text-foreground-subtle">
								<span className="truncate max-w-md" title={activeCwd}>
									{activeCwd}
								</span>
								<button
									type="button"
									onClick={handleCopyPath}
									className="inline-flex items-center rounded p-0.5 hover:bg-hover hover:text-foreground"
									title="复制路径"
								>
									<Copy className="size-3" />
								</button>
							</div>
						</div>
					</div>

					<div className="flex items-center gap-2">
						{latestSession && (
							<Button
								variant="primary"
								size="sm"
								className="gap-1.5"
								onClick={() => void openChatSession(latestSession.sessionId)}
							>
								<MessageSquare className="size-4" />
								<span>进入最新会话</span>
							</Button>
						)}
					</div>
				</div>

				{/* 元数据指标栏 */}
				<div className="mt-4 grid grid-cols-2 gap-4 border-t border-border pt-4 sm:grid-cols-4">
					<div>
						<span className="text-ui-xs text-foreground-subtle">会话总数</span>
						<p className="mt-0.5 text-lg font-semibold text-foreground">{repoSessions.length}</p>
					</div>
					<div>
						<span className="text-ui-xs text-foreground-subtle">最新活动</span>
						<p className="mt-0.5 text-ui-sm font-medium text-foreground">
							{latestSession?.mtimeMs ? <RelTime at={new Date(latestSession.mtimeMs).toISOString()} /> : "—"}
						</p>
					</div>
					<div>
						<span className="text-ui-xs text-foreground-subtle">自治门状态 (Gate)</span>
						<p className="mt-0.5 text-ui-sm font-medium text-foreground">
							{projectFrontier?.gate === "ok" ? (
								<span className="text-success">🟢 正常 (ok)</span>
							) : projectFrontier?.gate === "awaiting" ? (
								<span className="text-warning">🟡 等待输入 (awaiting)</span>
							) : (
								<span className="text-foreground-subtlest">⚪ 巡检中 (unknown)</span>
							)}
						</p>
					</div>
					<div>
						<span className="text-ui-xs text-foreground-subtle">活跃跟踪任务</span>
						<p className="mt-0.5 text-lg font-semibold text-foreground">
							{overview?.tasks ? overview.tasks.length : "—"}
						</p>
					</div>
				</div>
			</header>

			{/* 阻断与人工确认横幅（Needs-Attention） */}
			{projectFrontier?.needsUser && (
				<div className="mb-6 flex items-center justify-between rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-destructive">
					<div className="flex items-center gap-3">
						<ShieldAlert className="size-5 shrink-0" />
						<div>
							<h4 className="font-semibold text-ui-base">该项目当前需要人工确认或裁决</h4>
							<p className="text-ui-sm opacity-90">
								状态机检测到任务流已进入等待人工输入（Waiting Human）阶段，子代理暂停等待裁决。
							</p>
						</div>
					</div>
					{latestSession && (
						<Button
							variant="secondary"
							size="sm"
							className="border-destructive/30 text-destructive hover:bg-destructive/20"
							onClick={() => void openChatSession(latestSession.sessionId)}
						>
							前往会话处理
						</Button>
					)}
				</div>
			)}

			{/* 中央双栏排版：左区 60% 任务看板，右区 40% 运行态账本 */}
			<div className="grid grid-cols-1 gap-6 lg:grid-cols-12 min-h-0 flex-1">
				{/* 左区 60% (lg:col-span-7) */}
				<section className="flex flex-col gap-4 lg:col-span-7">
					<div className="flex items-center justify-between">
						<div className="flex items-center gap-2">
							<Zap className="size-4 text-accent" />
							<h2 className="font-semibold text-ui-base text-foreground">任务与上下文跟踪</h2>
						</div>
						<span className="text-ui-xs text-foreground-subtlest">
							{overview?.found ? `${overview.tasks.length} 项活跃任务` : "未找到 recentwork.md"}
						</span>
					</div>

					<Card className="flex-1 p-4 overflow-hidden flex flex-col">
						{/* 任务卡片列表（可滚动） */}
						<div className="flex-1 space-y-3 overflow-y-auto pr-1 max-h-[520px]">
							{!overview || overview.tasks.length === 0 ? (
								<EmptyState icon={<FileText className="size-8" />}>
									<div className="space-y-1">
										<div className="font-medium text-foreground">暂无活跃任务条目</div>
										<div className="text-ui-sm text-foreground-subtle">
											{overview?.found
												? "已找到跟踪文件，但未解析出 Active Tasks 条目。"
												: "当前仓库下未检测到 recentwork.md 或 TODO.md。"}
										</div>
									</div>
								</EmptyState>
							) : (
								overview.tasks.map((task: WorkspaceTaskItem) => {
									const isCompleted = task.status === "completed";
									const isFixing = task.status === "fixing";
									const isWarning = task.status === "warning";
									const isActive = task.status === "active";

									return (
										<div
											key={task.id + task.title}
											className="rounded-lg border border-border bg-card p-3 shadow-2xs transition-colors hover:border-border-hover"
										>
											<div className="flex items-start justify-between gap-2">
												<div className="min-w-0 flex-1">
													<div className="flex flex-wrap items-center gap-1.5">
														<Badge
															tone={
																task.priority === "P0"
																	? "red"
																	: task.priority === "P1"
																		? "blue"
																		: "gray"
															}
														>
															{task.priority}
														</Badge>
														<span className="font-mono text-ui-xs font-semibold text-foreground-subtle">
															{task.id}
														</span>
														<Badge
															tone={
																isCompleted
																	? "green"
																	: isFixing
																		? "purple"
																		: isWarning
																			? "yellow"
																			: isActive
																				? "blue"
																				: "gray"
															}
														>
															{isCompleted
																? "已完成"
																: isFixing
																	? "修复中"
																	: isWarning
																		? "有阻塞"
																		: isActive
																			? "推进中"
																			: "待办"}
														</Badge>
														<span className="truncate text-ui-base font-medium text-foreground">
															{task.title}
														</span>
													</div>

													<p className="mt-1.5 text-ui-sm text-foreground-subtle leading-relaxed line-clamp-3">
														{task.summary || task.title}
													</p>
												</div>
											</div>

											{task.statusText && (
												<div className="mt-2.5 flex items-center justify-between border-t border-border pt-2 text-ui-xs text-foreground-subtlest">
													<span className="truncate max-w-[85%]" title={task.statusText}>
														{task.statusText}
													</span>
													<span className="shrink-0 text-accent font-medium">
														{task.priority}
													</span>
												</div>
											)}
										</div>
									);
								})
							)}
						</div>

						{/* 底部文件元信息 */}
						<div className="mt-4 border-t border-border pt-3 flex items-center justify-between text-ui-xs text-foreground-subtle">
							<span className="font-medium truncate max-w-[70%]" title={overview?.filePath}>
								{overview?.filePath ? basename(overview.filePath) : "recentwork.md"}
							</span>
							<span>
								{overview?.fileMtimeMs ? (
									<>更新于 <RelTime at={new Date(overview.fileMtimeMs).toISOString()} /></>
								) : (
									"无更新记录"
								)}
							</span>
						</div>
					</Card>
				</section>

				{/* 右区 40% (lg:col-span-5) */}
				<section className="flex flex-col gap-4 lg:col-span-5">
					<div className="flex items-center justify-between">
						<div className="flex items-center gap-2">
							<Activity className="size-4 text-accent" />
							<h2 className="font-semibold text-ui-base text-foreground">当前运行态账本</h2>
						</div>
						<span className="text-ui-xs text-foreground-subtlest">{runs.length} 个实例</span>
					</div>

					<div className="flex flex-1 flex-col gap-2.5 overflow-y-auto">
						{runs.length === 0 ? (
							<Card className="flex flex-1 items-center justify-center p-6 text-foreground-subtlest">
								<EmptyState icon={<PlayCircle className="size-8" />}>
									<div className="space-y-1">
										<div className="font-medium text-foreground">暂无正在运行的任务</div>
										<div className="text-ui-sm text-foreground-subtle">
											当前系统没有活跃的子代理任务实例。
										</div>
									</div>
								</EmptyState>
							</Card>
						) : (
							runs.slice(0, 10).map((r) => {
								const d = deriveRunDisplay(r);
								const loop = loopBadge(r.loopVerdict);
								return (
									<div key={r.id} className="rounded-xl border border-border bg-card p-3 shadow-xs">
										<div className="flex items-center gap-2">
											<Badge tone={TONE_TO_BADGE[d.tone]} title={d.hint}>
												{d.label}
											</Badge>
											{r.agent !== null && (
												<Badge tone="gray" title="派发 Agent 角色">
													{r.agent}
												</Badge>
											)}
											{loop !== null && (
												<Badge tone={TONE_TO_BADGE[loop.tone]}>
													{loop.label}
												</Badge>
											)}
											<span className="ml-auto font-mono text-ui-xs text-foreground-subtlest">
												<ShortId value={r.id} />
											</span>
										</div>

										<div className="mt-2 text-ui-sm text-foreground-subtle line-clamp-2">
											{r.taskPreview || "无任务描述"}
										</div>

										<div className="mt-3 flex items-center justify-between border-t border-border pt-2 text-ui-xs text-foreground-subtlest">
											<span>启动 <RelTime at={r.startedAt} /></span>
											<span>{formatUsage(r.usage)}</span>
										</div>
									</div>
								);
							})
						)}
					</div>
				</section>
			</div>
		</div>
	);
}
