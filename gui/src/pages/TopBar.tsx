/** 顶栏（G5.1 人话化 + G5.2 接真数据 + G6-P3 待决策徽标）：服务●绿点=在线/灰点=离线；
 *  上下文压力=优先 liveness 实时心跳值（as-of），无心跳回退最近提案时点值；
 *  待决策徽标=交互投影 /v1/interactions 数量（pendingDecisionBadge 纯函数映射；点击进 Attention 页）。 */

import { useGui } from "../store";
import { pendingDecisionBadge } from "../interactionBadge";
import { fmtPressurePct, fmtRel, fmtTime, pressurePct } from "../format";
import { Badge, Term } from "../ui";
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

export function TopBar() {
	const health = useGui((s) => s.health);
	const attention = useGui((s) => s.attention);
	const interactions = useGui((s) => s.interactions);
	const setActiveTab = useGui((s) => s.setActiveTab);
	const badge = pendingDecisionBadge(interactions);

	const ownerAlive = health ? health.masterOwnerAlive : null;
	const dot =
		ownerAlive === null || !ownerAlive
			? "bg-zinc-600"
			: "bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.8)]";
	const dotLabel =
		ownerAlive === null
			? "服务（状态未知）"
			: ownerAlive
				? "服务（在线）"
				: "服务（离线）";
	const dotHint =
		ownerAlive === null
			? "还没有后端数据，无法判断在线状态"
			: ownerAlive
				? "值守会话心跳正常（15 秒内有动静）"
				: "值守会话心跳超时——当前值守可能已断开";

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
		<header className="flex items-center gap-4 border-b border-zinc-800 bg-zinc-900 px-4 py-2">
			<span className="flex items-center gap-2 text-xs font-semibold">
				<span className={`h-2.5 w-2.5 rounded-full ${dot}`} title={dotHint} />
				{dotLabel}
			</span>
			<span className="flex items-center gap-1 text-xs text-zinc-400">
				<Term zh="上下文压力" en="context pressure" hint="会话记忆快满时会自动提议交接" />
				<span className="font-mono text-zinc-200">
					{pressureShown ? fmtPressurePct(pressureShown.pct) : <span className="text-zinc-600">暂无数据</span>}
				</span>
				{pressureShown && (
					<span className="text-[10px] text-zinc-500" title={pressureShown.title}>
						（{pressureShown.label}）
					</span>
				)}
			</span>
			<span className="ml-auto flex items-center gap-3 text-[11px] text-zinc-500">
				{health && (
					<>
						<span className="font-mono">
							127.0.0.1:{health.host.port} · pid {health.host.pid} · pv{health.host.protocolVersion}
						</span>
						<span className="font-mono" title="journal.totalEvents（事件日志总条数）">日志 {health.journalTail.totalEvents}</span>
						<span className="font-mono" title="mailboxPending（未领信件数）">信箱 {health.mailboxPending}</span>
					</>
				)}
				<button
					type="button"
					onClick={() => setActiveTab("attention")}
					className="flex items-center gap-1.5 text-[11px] text-zinc-400 transition-colors hover:text-zinc-200"
					title="待决策交互（/v1/interactions 中带 response 的可决项）——点击进入 Attention 页；其他待关注事项仍在 Attention 列表"
				>
					<Term zh="待决策" en="pending decisions" hint="需要你处理的事项（审批即状态：可回放，不靠推送）" />
					<Badge tone={badge.tone} title={`待决策 ${badge.count} 项${badge.tone === "red" ? "（含严重）" : ""}`}>
						{badge.count}
					</Badge>
				</button>
			</span>
		</header>
	);
}
