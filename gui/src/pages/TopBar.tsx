/**
 * gui/src/pages/TopBar.tsx — 顶栏（ZCode 1:1 复刻 第 4 步；样板 WorkspaceHeader
 * #L152-176：h-12 border-b border-border/50 p-2，ghost 图标钮 size-8 rounded-lg）。
 *
 * 左 = 折叠钮（拍板 1：折叠钮进顶栏左端）+ cwd basename / 活动会话标题（title 链成果）；
 * 右 = Host● 服务点 + 上下文压力 + 待决策徽标 + 运行时入口（ghost size-8 rounded-lg）。
 * 数据字段全保留：port/pid/pv、journal 日志数、mailboxPending 信箱数（G5.2 接真数据不动）。
 * [无后端支撑]=不渲染：更新徽标、终端/side-pane 钮、Git 摘要、trace。
 */

import { Moon, PanelLeft, Settings, Sun } from "lucide-react";
import { useGui } from "../store";
import { pendingDecisionBadge } from "../interactionBadge";
import { fmtPct100, fmtPressurePct, fmtRel, fmtTime, fmtTokens, pressurePct } from "../format";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import type { AttentionItem } from "../api/types";
import { THEME_LABEL, nextTheme } from "../theme";
import { toggleTheme, useThemeValue } from "../useTheme";

function asString(v: unknown): string | undefined {
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** 最近一条 master-handoff attention（server 已按 severity→createdAt 排序；取 createdAt 最新）。 */
export function latestHandoffAttention(items: AttentionItem[]): AttentionItem | null {
	const hs = items.filter((a) => a.type === "master-handoff");
	if (hs.length === 0) return null;
	return hs.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
}

function basename(p: string | null): string {
	if (p === null) return "";
	const norm = p.replace(/\\/g, "/");
	const idx = norm.lastIndexOf("/");
	return idx >= 0 ? norm.slice(idx + 1) : norm;
}

export function TopBar() {
	const health = useGui((s) => s.health);
	const attention = useGui((s) => s.attention);
	const interactions = useGui((s) => s.interactions);
	const chatSessions = useGui((s) => s.chatSessions);
	const chatActiveId = useGui((s) => s.chatActiveId);
	const sidebarCollapsed = useGui((s) => s.sidebarCollapsed);
	const setSidebarCollapsed = useGui((s) => s.setSidebarCollapsed);
	// 会话为主重构 S4 沿用：待决策/运行时入口 → 「运行时」全屏覆盖层（定位 section）
	const setRuntimeOverlay = useGui((s) => s.setRuntimeOverlay);
	const badge = pendingDecisionBadge(interactions);

	const ownerAlive = health ? health.masterOwnerAlive : null;
	const dot =
		ownerAlive === null || !ownerAlive ? "bg-border" : "bg-success shadow-[0_0_6px_var(--color-success)]";
	const dotLabel =
		ownerAlive === null ? "服务（状态未知）" : ownerAlive ? "服务（在线）" : "服务（离线）";
	const dotHint =
		ownerAlive === null
			? "还没有后端数据，无法判断在线状态"
			: ownerAlive
				? "值守会话心跳正常（15 秒内有动静）"
				: "值守会话心跳超时——当前值守可能已断开";

	const activeSession = chatActiveId !== null ? chatSessions.find((s) => s.sessionId === chatActiveId) : undefined;
	const activeTitle =
		activeSession?.title !== undefined && activeSession.titleSource !== "id"
			? activeSession.title
			: chatActiveId;

	const proposal = latestHandoffAttention(attention);
	// 亮暗开关（主界面直开）：图标示「当前档」；tooltip 只给一个短词（2026-10-19 用户要求去掉长描述），
	// 「当前档 / 点击后切到哪档」仍由 aria-label 表达（无障碍不降级）。
	const theme = useThemeValue();
	// G5.2：压力显示优先 liveness 活值 + as-of；无心跳/无有效读数回退提案时点值并标注
	const live = useGui((s) => s.snapshot?.master?.liveness ?? null);
	const livePct = pressurePct(live?.pressure);
	const proposalPct = pressurePct(proposal?.payload?.pressure);
	const pressureShown = livePct !== null && live
		? { pct: livePct, label: `${fmtRel(live.updatedAt)}更新的实时心跳值`, title: fmtTime(live.updatedAt) }
		: proposalPct !== null
			? { pct: proposalPct, label: `${fmtRel(asString(proposal?.payload?.proposedAt))}的提案时点值，非实时`, title: asString(proposal?.payload?.proposedAt) ? fmtTime(asString(proposal?.payload?.proposedAt)) : undefined }
			: null;

	// 2026-10-21：**当前打开会话**的上下文用量（长度 / 占比 / 缓存比例）。
	// 与上面的「master 压力」是**两个不同口径**，不可混用：
	//   · master 压力 = readPressure() 的百分比（值守会话）
	//   · 本段 = 会话 JSONL 最后一条 assistant 的 usage（用户真正在看的那条会话）
	// 有本会话读数就优先显示它（更具体、用户更常关心）；没有则退回 master 压力。
	const chatUsage = chatActiveId !== null ? (useGui.getState().chatUsageBySession[chatActiveId] ?? null) : null;
	const usageKnown = chatUsage !== null && chatUsage.tokens !== null;
	const usageTitle = chatUsage === null
		? undefined
		: [
				`上下文长度：${chatUsage.tokens === null ? "未知" : `${chatUsage.tokens.toLocaleString()} tokens`}`,
				`上下文窗口：${chatUsage.contextWindow === null ? "未知" : chatUsage.contextWindow.toLocaleString()}`,
				`占比：${chatUsage.percent === null ? "未知" : `${chatUsage.percent}%`}`,
				`缓存命中：${chatUsage.cachePercent === null ? "未知（无输入）" : `${chatUsage.cachePercent}%`}`,
				`输入 ${chatUsage.detail.input} · 命中 ${chatUsage.detail.cacheRead} · 写入 ${chatUsage.detail.cacheWrite} · 输出 ${chatUsage.detail.output}`,
				chatUsage.at !== undefined ? `读数时刻：${fmtTime(chatUsage.at)}` : "读数时刻：未知",
			].join("\n");

	return (
		// header（WorkspaceHeader.tsx#L152-176）：h-12 + border-border/50（草稿态 border-transparent 不做）
		<header className="@container/workspace-header relative flex w-full shrink-0 h-12 border-b border-border/50 bg-header">
			<div className="flex h-12 flex-1 min-w-0 items-center justify-between gap-2 overflow-hidden p-2 transition-[padding] duration-300">
				{/* 左：折叠钮 + cwd basename / 活动会话标题 */}
				<div className="flex min-w-0 items-center gap-2">
					<Button
						type="button"
						variant="ghost"
						size="icon-lg"
						aria-label={sidebarCollapsed ? "展开侧栏" : "折叠侧栏"}
						title={sidebarCollapsed ? "展开侧栏" : "折叠侧栏"}
						onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
					>
						<PanelLeft className="size-4" />
					</Button>
					<div className="flex min-w-0 items-center gap-1.5 text-ui-base text-foreground">
						<span className="shrink-0 font-medium">{basename(activeSession?.cwd ?? null) || "subagent-win"}</span>
						{activeTitle && (
							<>
								<span className="shrink-0 text-foreground-subtlest">/</span>
								<span className="min-w-0 truncate text-foreground-subtle" title={chatActiveId ?? undefined}>
									{activeTitle}
								</span>
							</>
						)}
					</div>
				</div>
				{/* 右：host 数据字段 + 服务点 + 压力 + 待决策徽标 + 运行时入口 */}
				<div className="flex shrink-0 items-center gap-3 text-ui-xs text-foreground-subtlest">
					{health && (
						<span className="hidden font-mono md:inline" title="host 端点（127.0.0.1:port · pid · protocolVersion）">
							127.0.0.1:{health.host.port} · pid {health.host.pid} · pv{health.host.protocolVersion}
						</span>
					)}
					{health && (
						<span className="hidden font-mono lg:inline" title="journal.totalEvents（事件日志总条数）">
							日志 {health.journalTail.totalEvents}
						</span>
					)}
					{health && (
						<span className="hidden font-mono lg:inline" title="mailboxPending（未领信件数）">
							信箱 {health.mailboxPending}
						</span>
					)}
					<span className="flex items-center gap-1.5 text-ui-sm text-foreground-subtle" title={dotHint}>
						<span className={`h-2 w-2 rounded-full ${dot}`} />
						{dotLabel}
					</span>
					<span
						className="flex items-center gap-1 text-ui-sm text-foreground-subtle"
						title={usageKnown ? usageTitle : "会话记忆快满时会自动提议交接"}
					>
						上下文
						{usageKnown && chatUsage !== null ? (
							<>
								<span className="font-mono text-foreground">{fmtTokens(chatUsage.tokens)}</span>
								<span className="text-foreground-subtlest">/</span>
								<span className="font-mono text-foreground-subtlest">{fmtTokens(chatUsage.contextWindow)}</span>
								{chatUsage.percent !== null && (
									<span
										className={`font-mono ${chatUsage.percent >= 80 ? "text-destructive" : chatUsage.percent >= 60 ? "text-warning" : "text-foreground-subtle"}`}
									>
										（{fmtPct100(chatUsage.percent)}）
									</span>
								)}
								{chatUsage.cachePercent !== null && (
									<span className="font-mono text-foreground-subtlest" title="缓存命中率 = cacheRead / (cacheRead + input)，只看输入侧">
										命中 {fmtPct100(chatUsage.cachePercent)}
									</span>
								)}
							</>
						) : (
							<span className="font-mono text-foreground">
								{pressureShown ? fmtPressurePct(pressureShown.pct) : <span className="text-foreground-subtlest">暂无数据</span>}
							</span>
						)}
						{!usageKnown && pressureShown && (
							<span className="text-ui-xs text-foreground-subtlest" title={pressureShown.title}>
								（{pressureShown.label}）
							</span>
						)}
					</span>
					<button
						type="button"
						onClick={() => setRuntimeOverlay("attention")}
						className="flex items-center gap-1.5 text-ui-sm text-foreground-subtle transition-colors hover:text-foreground"
						title="待决策交互（/v1/interactions 中带 response 的可决项）——点击打开运行时覆盖层定位「需要关注」"
					>
						待决策
						<Badge variant={badge.tone === "red" ? "destructive" : "secondary"} title={`待决策 ${badge.count} 项${badge.tone === "red" ? "（含严重）" : ""}`}>
							{badge.count}
						</Badge>
					</button>
					<Button
						type="button"
						variant="ghost"
						size="icon-lg"
						aria-label={`切换到${THEME_LABEL[nextTheme(theme)]}主题`}
						aria-pressed={theme === "warm-light"}
						data-theme-toggle="1"
						title="主题亮/暗"
						onClick={toggleTheme}
					>
						{theme === "warm-dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
					</Button>
					<Button
						type="button"
						variant="ghost"
						size="icon-lg"
						aria-label="运行时"
						title="运行时全景：服务、信箱、任务、心跳与主控/工作流/需要关注——打开全屏覆盖层"
						onClick={() => setRuntimeOverlay("runtime")}
					>
						<Settings className="size-4" />
					</Button>
				</div>
			</div>
		</header>
	);
}
