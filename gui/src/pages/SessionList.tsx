/**
 * gui/src/pages/SessionList.tsx — 左栏会话列表（ZCode 1:1 复刻 第 3 步 + 按仓库分组会话 L2
 * + 会话 rail 三件套 L3：置顶 / 每组最多 6 个 / 全 tab 组默认折叠）。
 *
 * 分组渲染（plans/0922_workspace_group_plan.md）：会话列表由扁平 `<ul>` 改为「按 cwd 分组 +
 * radix Collapsible 折叠」；组头 h-8 整行 CollapsibleTrigger（Folder/FolderOpen 16px 随展开态
 * 切换 + basename + 计数 badge + 无 chevron + title=全路径 tooltip 兜 basename 冲突）；
 * 组内会话行 JSX 原样保留（TaskListItem.tsx#L534-546 同款刻度）。
 * 组序 = 组内最大 mtimeMs 降序、未分组垫底（[future] 组拖拽排序持久化未做——无 tab/拖拽
 * 持久化后端；届时补 SortableContext + settingService 级持久，组序策略再向 ZCode 全对齐，P1-4）；
 * 组内默认 updated（mtimeMs 降序）、过滤框旁 segmented 切 created（startedAt 降序），排序维度
 * 持久化 localStorage `saw-ws-sort`（workspaceSort，机制同 saw-ws-expansion）；折叠态
 * localStorage `saw-ws-expansion` 双写（toggle 时 save+prune，workspaceExpansion 容错）。
 * 组头状态点：失败红点有数据源（failedSessions 聚合）；蓝点（未读）无数据源不渲染——
 * 与 SessionList 现拍板 1（行级 unread 不渲染）同先例。
 *
 * 会话 rail 三件套 L3（数据源 = /v1/sessions 服务端权威 additive 字段 isMaster/isScopeMaster，
 * 纯显示函数在 workspaceGroup：buildGroupDisplay/resolveGroupOpen）：
 *   1) 置顶：全局 master 会话（isMaster）在列表最上方独立「置顶」区（过滤仍适用，与
 *      「过滤后空组整组隐藏」一致）；组内 scope master 行（isScopeMaster）置顶于组内列表
 *      顶部、盾标（masterProtected）旁加「置顶」徽标；置顶行不受 6 个截断影响（永远可见）。
 *   2) 每组最多 6 个：组内非置顶行默认显示前 6（组内现有序），超出收进「还有 N 个 ·
 *      展开查看全部」行；展开态 localStorage `saw-ws-overflow`（workspaceRailExpand，
 *      机制同 saw-ws-expansion：true=展开、缺省=收起、prune+500 上限+坏 JSON 容错）。
 *   3) 全 tab 组默认折叠：组内会话全部为派发 tab（titleSource==='ledger'）的组，首次加载
 *      默认收起；用户手动展开后以持久化为准（`saw-ws-tabgroups` 显式 true，混合组不写此
 *      key、仍走 saw-ws-expansion 的缺省展开）；混合组不动。
 *
 * [无后端支撑]=不渲染：「+ 新建」组头钮（Sidebar 新建钮现状维持灰显占位）、组拖拽、组内分页。
 */

import { useEffect, useMemo, useState } from "react";
import { Clock, Folder, FolderOpen, Inbox, Pin, Shield } from "lucide-react";
import { useGui } from "../store";
import { RelTime, ShortId } from "../ui";
import { Input } from "../ui/input";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import type { SessionSummary } from "../api/types";
import { matchesSessionFilter } from "../sessionFilter";
import { basename, buildGroupDisplay, groupSessions, resolveGroupOpen, sortGroups } from "../workspaceGroup";
import type { SessionSortBy, WorkspaceGroup } from "../workspaceGroup";
import { loadExpansionState, pruneExpansionState, saveExpansionState } from "../workspaceExpansion";
import { loadRailExpand, OVERFLOW_KEY, pruneRailExpand, saveRailExpand, TABGROUP_KEY } from "../workspaceRailExpand";
import { loadSortBy, saveSortBy } from "../workspaceSort";

function mtimeIso(s: SessionSummary): string | null {
	return Number.isFinite(s.mtimeMs) && s.mtimeMs > 0 ? new Date(s.mtimeMs).toISOString() : null;
}

function sameExpansionState(a: Record<string, boolean>, b: Record<string, boolean>): boolean {
	const aEntries = Object.entries(a);
	return aEntries.length === Object.keys(b).length && aEntries.every(([key, value]) => b[key] === value);
}

/** 组内是否全部为派发 tab（titleSource==='ledger'）→ 首次加载默认折叠数据源（resolveGroupOpen 同源）。 */
function isAllTabGroup(g: WorkspaceGroup): boolean {
	return g.sessions.length > 0 && g.sessions.every((s) => s.titleSource === "ledger");
}

export function SessionList() {
	const chatSessions = useGui((s) => s.chatSessions);
	const activeId = useGui((s) => s.chatActiveId);
	const outboxMap = useGui((s) => s.chatOutbox);
	const [filter, setFilter] = useState("");
	// 组内排序维度（默认 updated；持久化到 localStorage `saw-ws-sort`，机制同 saw-ws-expansion）
	const [sortBy, setSortBy] = useState<SessionSortBy>(() => loadSortBy());
	// 组折叠态（cwdKey → boolean，false=收起，缺省=展开）；localStorage 双写
	const [expansion, setExpansion] = useState<Record<string, boolean>>(() => loadExpansionState());
	// 组内「还有 N 个」展开态（saw-ws-overflow：true=展开，缺省=收起；机制同 saw-ws-expansion）
	const [overflow, setOverflow] = useState<Record<string, boolean>>(() => loadRailExpand(OVERFLOW_KEY));
	// 全 tab 组用户显式展开态（saw-ws-tabgroups：true=展开，缺省=默认收起；混合组不写此 key）
	const [tabExpansion, setTabExpansion] = useState<Record<string, boolean>>(() => loadRailExpand(TABGROUP_KEY));

	// 行/组红点数据源：该会话任一 outbox 条目落入终态失败（failed/expired/rejected）
	const failedSessions = useMemo(() => {
		const set = new Set<string>();
		for (const e of Object.values(outboxMap)) {
			if (e.status === "failed" || e.status === "expired" || e.status === "rejected") set.add(e.sessionId);
		}
		return set;
	}, [outboxMap]);

	const filtered = useMemo(() => chatSessions.filter((s) => matchesSessionFilter(s, filter)), [chatSessions, filter]);
	// 置顶区（列表最上方独立「置顶」行）：全局 master 会话（服务端权威 isMaster，与 masterProtected 同源）。
	// 过滤仍适用（与「过滤后空组整组隐藏」一致）；pinnedTop 非空 ⇒ 其所在组必然非空 ⇒ 不会与空态冲突。
	const pinnedTop = useMemo(() => filtered.filter((s) => s.isMaster === true), [filtered]);
	// filter → group → sort（过滤后组内空 → 整组隐藏，含「未分组」）
	// [future] 组拖拽排序持久化未做（P1-4）：组序当前 = maxMtimeMs 降序（未分组垫底）。
	// ZCode 用 SortableContext 拖拽 + settingService 级持久；届时再向 ZCode 组序策略全对齐。
	const groups = useMemo(() => sortGroups(groupSessions(filtered, sortBy, failedSessions)), [filtered, sortBy, failedSessions]);

	// 组头整行点击 = 纯展开/折叠；toggle 时 save + prune（清理已消失组键）
	const groupKeys = useMemo(() => groups.map((g) => g.key), [groups]);

	// 首次载入与会话列表变更也 prune，避免没有点击组头/展开行时陈旧键永久占用 localStorage。
	useEffect(() => {
		setExpansion((current) => {
			const pruned = pruneExpansionState(current, groupKeys);
			return sameExpansionState(current, pruned) ? current : pruned;
		});
	}, [groupKeys]);
	useEffect(() => {
		setOverflow((current) => {
			const pruned = pruneRailExpand(OVERFLOW_KEY, current, groupKeys);
			return sameExpansionState(current, pruned) ? current : pruned;
		});
	}, [groupKeys]);
	useEffect(() => {
		setTabExpansion((current) => {
			const pruned = pruneRailExpand(TABGROUP_KEY, current, groupKeys);
			return sameExpansionState(current, pruned) ? current : pruned;
		});
	}, [groupKeys]);

	// 组展开/折叠：混合组走 saw-ws-expansion（缺省展开、false=收起）；全 tab 组默认收起，
	// 用户显式操作写 saw-ws-tabgroups（open→显式 true 持久化；close→删键回落默认收起）。
	const toggleGroup = (g: WorkspaceGroup, open: boolean) => {
		if (isAllTabGroup(g)) {
			const next = { ...tabExpansion };
			if (open) next[g.key] = true;
			else delete next[g.key];
			const pruned = pruneRailExpand(TABGROUP_KEY, next, groupKeys);
			saveRailExpand(TABGROUP_KEY, pruned);
			setTabExpansion(pruned);
			return;
		}
		const next = { ...expansion };
		if (open) delete next[g.key]; // 缺省即展开，不写冗余 true 值。
		else next[g.key] = false;
		const pruned = pruneExpansionState(next, groupKeys);
		saveExpansionState(pruned);
		setExpansion(pruned);
	};

	// 「还有 N 个 · 展开查看全部」展开/收起（saw-ws-overflow：open→显式 true；close→删键回落默认收起）
	const toggleOverflow = (g: WorkspaceGroup, open: boolean) => {
		const next = { ...overflow };
		if (open) next[g.key] = true;
		else delete next[g.key];
		const pruned = pruneRailExpand(OVERFLOW_KEY, next, groupKeys);
		saveRailExpand(OVERFLOW_KEY, pruned);
		setOverflow(pruned);
	};

	// 会话行（TaskListItem.tsx#L534-546 逐字；workspace 变体单行居中）。pinnedBadge=true 时
	// 盾标（masterProtected）旁加「置顶」徽标（scope master 组内置顶行；L3 三件套 1/3）。
	const renderSessionRow = (s: SessionSummary, pinnedBadge: boolean) => {
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
						{pinnedBadge && (
							// 组内置顶徽标（scope master 行；L3 三件套 1/3）：盾标旁，subtlest 档不抢标题
							<span
								className="flex shrink-0 items-center gap-0.5 text-ui-sm text-foreground-subtlest"
								title="本仓库的本地 master（scope master）——组内置顶，不受 6 个截断影响"
							>
								<Pin className="size-3" />
								置顶
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
							onClick={() => {
								setSortBy(value);
								saveSortBy(value); // 维度切换落盘 `saw-ws-sort`（机制同 saw-ws-expansion）
							}}
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
				{/* 置顶区（L3 三件套 1/3）：全局 master 会话独立「置顶」行，列表最上方；过滤仍适用 */}
				{pinnedTop.length > 0 && (
					<div className="mb-1">
						<div className="px-2.5 pb-0.5 text-ui-sm text-foreground-subtlest">置顶</div>
						<ul className="space-y-0.5">{pinnedTop.map((s) => renderSessionRow(s, false))}</ul>
					</div>
				)}
				{groups.length === 0 ? (
					<div className="px-2.5 py-2 text-ui-sm text-foreground-subtlest">
						{chatSessions.length === 0 ? "暂无会话（等待列表数据）" : "无匹配会话"}
					</div>
				) : (
					groups.map((g) => {
						// 组展开态：混合组 = saw-ws-expansion（缺省展开）；全 tab 组 = 首次加载默认收起，
						// 用户显式展开后以 saw-ws-tabgroups 持久化值为准（resolveGroupOpen 纯函数，可测）
						const open = resolveGroupOpen(g, expansion, tabExpansion);
						// 组内显示模型（L3 三件套 1/2/3）：置顶行永远可见；非置顶默认前 6；全 tab 组默认收起
						const overflowOpen = overflow[g.key] === true;
						const display = buildGroupDisplay(g, overflowOpen);
						return (
							<Collapsible key={g.key} open={open} onOpenChange={(o) => toggleGroup(g, o)}>
								{/* 组头（WorkspaceSidebarItem.tsx#L780 同款刻度）：h-8 整行 CollapsibleTrigger；
									Folder/FolderOpen 16px + basename + 计数 badge（本地 token bg-neutral-200/70，
									zcode bg-tag 未搬）+ 无 chevron + title=全路径 tooltip；未分组灰显 Inbox */}
								<CollapsibleTrigger asChild>
									<div
										role="button"
										tabIndex={0}
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
										{/* 组头 label 统一 subtle 档（对齐 ZCode 组头 label text-foreground-subtle）；未分组灰显行由图标（Inbox + text-foreground-subtlest）承载差异 */}
										<span className="min-w-0 flex-1 truncate text-ui-base text-foreground-subtle">{g.label}</span>
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
										{/* 组内置顶行（scope master；L3 三件套 1/3）：永远可见，不受 6 个截断影响 */}
										{display.pinned.map((s) => renderSessionRow(s, true))}
										{/* 非置顶行：收起态前 6（组内现有序），展开态全量 */}
										{display.visible.map((s) => renderSessionRow(s, false))}
									</ul>
									{/* 「还有 N 个 · 展开查看全部」（L3 三件套 2/3）：仅非置顶行超出 6 个时渲染；
										展开态持久化 saw-ws-overflow（机制同 saw-ws-expansion） */}
									{display.hiddenCount > 0 && (
										<button
											type="button"
											onClick={() => toggleOverflow(g, !overflowOpen)}
											aria-expanded={overflowOpen}
											className="mt-0.5 flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-lg pl-2.5 pr-1 text-ui-sm text-foreground-subtle transition-colors hover:bg-surface-hover"
										>
											{overflowOpen ? (
												"收起"
											) : (
												`还有 ${display.hiddenCount} 个 · 展开查看全部`
											)}
										</button>
									)}
								</CollapsibleContent>
							</Collapsible>
						);
					})
				)}
			</div>
		</div>
	);
}
