/**
 * gui/src/pages/SessionList.tsx — 左栏会话列表（ZCode 1:1 复刻 第 3 步 + 按仓库分组会话 L3）。
 *
 * 分组渲染（plans/0922_workspace_group_plan.md）：会话列表由扁平 `<ul>` 改为「按 cwd 分组 +
 * radix Collapsible 折叠」；组头 h-8 整行 CollapsibleTrigger（Folder/FolderOpen 16px 随展开态
 * 切换 + basename + 计数 badge + 无 chevron + title=全路径 tooltip 兜 basename 冲突）；
 * 组内会话行 JSX 原样保留（TaskListItem.tsx#L534-546 同款刻度）。
 * 组序 = 组内最大 mtimeMs 降序、未分组垫底；组内默认 updated（mtimeMs 降序）、过滤框旁
 * segmented 切 created（startedAt 降序），不持久化；折叠态 localStorage `saw-ws-expansion`
 * 双写（toggle 时 save+prune，workspaceExpansion 容错）。
 * 组头状态点：失败红点有数据源（failedSessions 聚合）；蓝点（未读）无数据源不渲染——
 * 与 SessionList 现拍板 1（行级 unread 不渲染）同先例。
 * [无后端支撑]=不渲染：「+ 新建」组头钮（Sidebar 新建钮现状维持灰显占位）、组拖拽、组内分页。
 */

import { useEffect, useMemo, useState } from "react";
import { Clock, Folder, FolderOpen, Inbox, Shield } from "lucide-react";
import { useGui } from "../store";
import { RelTime, ShortId } from "../ui";
import { Input } from "../ui/input";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import type { SessionSummary } from "../api/types";
import { matchesSessionFilter } from "../sessionFilter";
import { basename, groupSessions, sortGroups } from "../workspaceGroup";
import type { SessionSortBy } from "../workspaceGroup";
import { loadExpansionState, pruneExpansionState, saveExpansionState } from "../workspaceExpansion";

function mtimeIso(s: SessionSummary): string | null {
	return Number.isFinite(s.mtimeMs) && s.mtimeMs > 0 ? new Date(s.mtimeMs).toISOString() : null;
}

function sameExpansionState(a: Record<string, boolean>, b: Record<string, boolean>): boolean {
	const aEntries = Object.entries(a);
	return aEntries.length === Object.keys(b).length && aEntries.every(([key, value]) => b[key] === value);
}

export function SessionList() {
	const chatSessions = useGui((s) => s.chatSessions);
	const activeId = useGui((s) => s.chatActiveId);
	const outboxMap = useGui((s) => s.chatOutbox);
	const [filter, setFilter] = useState("");
	// 组内排序维度（默认 updated；不持久化——第一版）
	const [sortBy, setSortBy] = useState<SessionSortBy>("updated");
	// 组折叠态（cwdKey → boolean，false=收起，缺省=展开）；localStorage 双写
	const [expansion, setExpansion] = useState<Record<string, boolean>>(() => loadExpansionState());

	// 行/组红点数据源：该会话任一 outbox 条目落入终态失败（failed/expired/rejected）
	const failedSessions = useMemo(() => {
		const set = new Set<string>();
		for (const e of Object.values(outboxMap)) {
			if (e.status === "failed" || e.status === "expired" || e.status === "rejected") set.add(e.sessionId);
		}
		return set;
	}, [outboxMap]);

	// filter → group → sort（过滤后组内空 → 整组隐藏，含「未分组」）
	const groups = useMemo(() => {
		const filtered = chatSessions.filter((s) => matchesSessionFilter(s, filter));
		return sortGroups(groupSessions(filtered, sortBy, failedSessions));
	}, [chatSessions, filter, sortBy, failedSessions]);

	// 组头整行点击 = 纯展开/折叠；toggle 时 save + prune（清理已消失组键）
	const groupKeys = useMemo(() => groups.map((g) => g.key), [groups]);

	// 首次载入与会话列表变更也 prune，避免没有点击组头时陈旧键永久占用 localStorage。
	useEffect(() => {
		setExpansion((current) => {
			const pruned = pruneExpansionState(current, groupKeys);
			return sameExpansionState(current, pruned) ? current : pruned;
		});
	}, [groupKeys]);

	const toggleGroup = (key: string, open: boolean) => {
		const next = { ...expansion };
		if (open) delete next[key]; // 缺省即展开，不写冗余 true 值。
		else next[key] = false;
		const pruned = pruneExpansionState(next, groupKeys);
		saveExpansionState(pruned);
		setExpansion(pruned);
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-2 px-2">
			{/* 过滤 Input + 组内排序 segmented（ui/input token 套件；zcode 搜索为按钮开面板——本处保留内联过滤成果） */}
			<div className="flex shrink-0 items-center gap-2">
				<Input
					value={filter}
					onChange={(e) => setFilter(e.target.value)}
					placeholder="过滤会话（标题 / ID / 仓库名）"
					className="h-7 min-w-0 flex-1"
				/>
				<div className="flex h-7 shrink-0 overflow-hidden rounded-md border border-border" role="group" aria-label="组内排序">
					{(
						[
							["updated", "最近更新"],
							["created", "按创建"],
						] as const
					).map(([value, label]) => (
						<button
							key={value}
							type="button"
							onClick={() => setSortBy(value)}
							aria-pressed={sortBy === value}
							className={`px-1.5 text-ui-sm transition-colors ${
								sortBy === value
									? "bg-neutral-200/70 text-foreground"
									: "text-foreground-subtle hover:bg-surface-hover"
							}`}
						>
							{label}
						</button>
					))}
				</div>
			</div>
			{/* 分组列表容器（TaskList.tsx#L383 flex flex-col + #L450 ul space-y-0.5 同款节奏；外层 ul 改 div，组内 ul 保留） */}
			<div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
				{groups.length === 0 ? (
					<div className="px-2.5 py-2 text-ui-sm text-foreground-subtlest">
						{chatSessions.length === 0 ? "暂无会话（等待列表数据）" : "无匹配会话"}
					</div>
				) : (
					groups.map((g) => {
						const open = expansion[g.key] !== false;
						return (
							<Collapsible key={g.key} open={open} onOpenChange={(o) => toggleGroup(g.key, o)}>
								{/* 组头（WorkspaceSidebarItem.tsx#L780 同款刻度）：h-8 整行 CollapsibleTrigger；
									Folder/FolderOpen 16px + basename + 计数 badge（本地 token bg-neutral-200/70，
									zcode bg-tag 未搬）+ 无 chevron + title=全路径 tooltip；未分组灰显 Inbox */}
								<CollapsibleTrigger asChild>
									<div
										title={g.tooltip}
										className="flex h-8 cursor-pointer items-center gap-1.5 rounded-lg pl-2.5 pr-1 hover:bg-surface-hover"
									>
										{g.ungrouped ? (
						<Inbox className="size-4 shrink-0 text-foreground-subtlest" />
					) : open ? (
						<FolderOpen className="size-4 shrink-0 text-foreground-subtle" />
					) : (
						<Folder className="size-4 shrink-0 text-foreground-subtle" />
					)}
										<span
											className={`min-w-0 flex-1 truncate text-ui-base ${
												g.ungrouped ? "text-foreground-subtle" : "text-foreground"
											}`}
										>
											{g.label}
										</span>
										{/* 组内失败红点（数据源=failedSessions 聚合）；蓝点（未读）无数据源不渲染 */}
										{g.hasError && (
											<span
												data-group-error-indicator="true"
												className="h-1.5 w-1.5 shrink-0 rounded-full bg-destructive"
												title="该组内有发送失败/过期/被拒消息的会话"
											/>
										)}
										<span className="shrink-0 rounded-full bg-neutral-200/70 px-1.5 text-ui-sm text-foreground-subtle">
											{g.count}
										</span>
									</div>
								</CollapsibleTrigger>
								<CollapsibleContent className="pl-0.5">
									<ul className="space-y-0.5">
										{g.sessions.map((s) => {
											const hasError = failedSessions.has(s.sessionId);
											const isActive = activeId === s.sessionId;
											return (
												// 行体（TaskListItem.tsx#L534-546 逐字；workspace 变体单行居中）
												<li
													key={s.sessionId}
													title={s.file}
													onClick={() => void useGui.getState().openChatSession(s.sessionId)}
													onKeyDown={(e) => {
														if (e.key === "Enter" || e.key === " ") {
															e.preventDefault();
															void useGui.getState().openChatSession(s.sessionId);
														}
													}}
													tabIndex={0}
													className={`group/task-item flex cursor-pointer items-center gap-2 rounded-lg pl-2.5 pr-1 py-1 transition-[background-color,border-color,box-shadow] ${
														isActive ? "bg-selected" : "hover:bg-surface-hover"
													}`}
												>
													{/* 前置状态槽 16×16（#L559-600）：error 红点；unread/loading 无数据源不渲染 */}
													<div className="relative flex size-4 shrink-0 items-center justify-center">
														{hasError && (
															<span
																data-error-indicator="true"
																className="h-1.5 w-1.5 rounded-full bg-destructive"
																title="该会话有发送失败/过期/被拒的消息"
															/>
														)}
													</div>
													<div className="flex min-w-0 flex-1 flex-col gap-0.5">
														{/* 标题行：可读 title（解析链 ledger|first-user）；titleSource=id → 灰显 shortId */}
														<div className="flex min-w-0 items-center gap-2">
															{s.title !== undefined && s.titleSource !== "id" ? (
																<span className="min-w-0 flex-1 truncate text-ui-base text-foreground" title={s.title}>
																	{s.title}
																</span>
															) : (
																<ShortId
																	value={s.sessionId}
																	className={`min-w-0 flex-1 ${s.titleSource === "id" ? "text-foreground-subtlest" : ""}`}
																/>
															)}
															{s.masterProtected === true && (
																// masterProtected 盾标（我方数据面；zcode 无直接对应物）
																<span
																	className="shrink-0 text-warning"
																	title="Master 会话拒绝远程输入（executor 层 403 护栏）"
																>
																	<Shield className="size-3.5" />
																</span>
															)}
														</div>
														{/* 元信息行（#L745-770 同款刻度）：basename(cwd) · mtime 相对时间 */}
														<div className="flex min-w-0 items-center gap-1 text-ui-sm text-foreground-subtle">
															<span className="min-w-0 truncate">{basename(s.cwd)}</span>
															<span className="shrink-0 text-foreground-subtlest">·</span>
															<Clock className="size-3.5 shrink-0" />
															<RelTime at={mtimeIso(s)} className="shrink-0" />
														</div>
													</div>
												</li>
											);
										})}
									</ul>
								</CollapsibleContent>
							</Collapsible>
						);
					})
				)}
			</div>
		</div>
	);
}
