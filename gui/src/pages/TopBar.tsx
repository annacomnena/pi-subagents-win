/**
 * gui/src/pages/TopBar.tsx — 顶栏（ZCode 1:1 复刻 第 4 步；样板 WorkspaceHeader
 * #L152-176：h-12 border-b border-border/50 p-2，ghost 图标钮 size-8 rounded-lg）。
 *
 * 左 = 折叠钮（拍板 1：折叠钮进顶栏左端）+ cwd basename / 活动会话标题（title 链成果）；
 * 右 = Host● 服务点 + 上下文压力 + 待决策徽标 + 运行时入口（ghost size-8 rounded-lg）。
 * 数据字段全保留：port/pid/pv、journal 日志数、mailboxPending 信箱数（G5.2 接真数据不动）。
 * [无后端支撑]=不渲染：更新徽标、终端/side-pane 钮、Git 摘要、trace。
 */

import { PanelLeft, Settings } from "lucide-react";
import { useGui } from "../store";
import { pendingDecisionBadge } from "../interactionBadge";
import { fmtPressurePct, fmtRel, fmtTime, pressurePct } from "../format";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import type { AttentionItem } from "../api/types";

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
	// G5.2：压力显示优先 liveness 活值 + as-of；无心跳/无有效读数回退提案时点值并标注
	const live = useGui((s) => s.snapshot?.master?.liveness ?? null);
	const livePct = pressurePct(live?.pressure);
	const proposalPct = pressurePct(proposal?.payload?.pressure);
	const pressureShown = livePct !== null && live
		? { pct: livePct, label: `${fmtRel(live.updatedAt)}更新的实时心跳值`, title: fmtTime(live.updatedAt) }
		: proposalPct !== null
			? { pct: proposalPct, label: `${fmtRel(asString(proposal?.payload?.proposedAt))}的提案时点值，非实时`, title: asString(proposal?.payload?.proposedAt) ? fmtTime(asString(proposal?.payload?.proposedAt)) : undefined }
			: null;

	return (
		// header（WorkspaceHeader.tsx#L152-176）：h-12 + border-border/50（草稿态 border-transparent 不做）
		<header className="@container/workspace-header relative flex w-full shrink-0 h-12 border-b border-border/50">
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
						title="会话记忆快满时会自动提议交接"
					>
						上下文压力
						<span className="font-mono text-foreground">
							{pressureShown ? fmtPressurePct(pressureShown.pct) : <span className="text-foreground-subtlest">暂无数据</span>}
						</span>
						{pressureShown && (
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
