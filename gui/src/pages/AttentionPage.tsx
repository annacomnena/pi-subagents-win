/**
 * Attention 页（G5.1 人话化 + G6-P3 交互投影升级）：三源待关注列表（severity 色带 + 类型 + 摘要）。
 * actions 恒缺省 → 按钮由交互投影（/v1/interactions）的 response 语义驱动（pendingInteractions
 * 思想：UI 只渲染按钮，不解释语义）；无投影命中的条目不自造按钮（§29 决策走既有命令）。
 */

import { useEffect, useState } from "react";
import { acceptHandoff, useGui } from "../store";
import { pendingDecisionBadge } from "../interactionBadge";
import { Badge, Button, Card, EmptyState, PageIntro, RelTime, Term, Toggle } from "../ui";
import type { AttentionItem, AttentionSeverity, InteractionResponse } from "../api/types";

const SEV_BAND: Record<AttentionSeverity, string> = {
	critical: "border-l-red-600",
	warning: "border-l-amber-500",
	info: "border-l-sky-600",
};

const SEV_ZH: Record<AttentionSeverity, string> = {
	critical: "严重",
	warning: "警告",
	info: "提示",
};

function typeBadge(a: AttentionItem) {
	switch (a.type) {
		case "runtime-risk":
			return <Badge tone="red">运行风险</Badge>;
		case "master-handoff":
			return <Badge tone="blue">交接提案</Badge>;
		case "escalation":
			return <Badge tone="yellow">升级上报</Badge>;
		case "question":
			return <Badge>待回答</Badge>;
		case "blocked":
			return <Badge tone="yellow">被阻塞</Badge>;
		default:
			return <Badge>{a.type}</Badge>;
	}
}

function AttentionCard({ item, response }: { item: AttentionItem; response?: InteractionResponse }) {
	// G6-P3：按钮 = 投影 response 语义直渲染（仅 master.handoff.accept 一个既有确定性命令可决；
	// 无 response 的待决策项 v1 不自造按钮，防范围蔓延——plan §3 拍板）
	const canAccept = response?.command === "master.handoff.accept";
	return (
		<li className={`rounded border border-zinc-800 border-l-4 bg-zinc-900/60 px-3 py-2 ${SEV_BAND[item.severity]}`} title={`级别：${SEV_ZH[item.severity]}`}>
			<div className="flex flex-wrap items-center gap-2">
				{typeBadge(item)}
				<Badge tone={item.status === "open" ? "gray" : "green"}>{item.status === "open" ? "待处理" : "已处理"}</Badge>
				<span className="text-xs font-medium text-zinc-200">{item.title}</span>
				<RelTime at={item.createdAt} className="ml-auto text-[10px] text-zinc-600" />
			</div>
			<p className="mt-1 text-[11px] break-all text-zinc-400">{item.summary}</p>
			<p className="mt-0.5 font-mono text-[10px] text-zinc-600">
				类型 {item.type}
				{item.source ? ` · ${item.source}` : ""}
			</p>
			{canAccept && (
				<div className="mt-2">
					<Button variant="primary" onClick={() => void acceptHandoff()}>
						接受提案
					</Button>
				</div>
			)}
		</li>
	);
}

export function AttentionPage() {
	const attention = useGui((s) => s.attention);
	const interactions = useGui((s) => s.interactions);
	const includeResolved = useGui((s) => s.attentionIncludeResolved);
	const setIncludeResolved = useGui((s) => s.setAttentionIncludeResolved);
	const pollAttention = useGui((s) => s.pollAttention);
	const [busy, setBusy] = useState(false);
	const badge = pendingDecisionBadge(interactions);

	// 切 resolved 视图立即补一拍（不等下一轮 2s）
	useEffect(() => {
		setBusy(true);
		void pollAttention().finally(() => setBusy(false));
	}, [includeResolved, pollAttention]);

	return (
		<div className="space-y-3">
			<PageIntro>系统觉得需要你留意的事</PageIntro>
			<div className="flex items-center gap-3">
				<span className="text-xs text-zinc-500">已处理条目</span>
				<Toggle on={includeResolved} onChange={setIncludeResolved} labels={["隐藏", "显示"]} />
				<span className="ml-auto text-[10px] text-zinc-600">/v1/attention{includeResolved ? "?includeResolved=1" : ""} · 2s</span>
			</div>
			<Card
				title={<Term zh={`需要关注（${attention.length}${busy ? " · 刷新中" : ""}）`} en="Attention" />}
				right={
					<Badge tone={badge.tone} title={`待决策交互（/v1/interactions）${badge.count} 项——已处理条目不计入`}>
						待决策 {badge.count}
					</Badge>
				}
			>
				{attention.length === 0 ? (
					<EmptyState>{includeResolved ? "暂无条目（历史也是空的）" : "暂无待关注"}</EmptyState>
				) : (
					<ul className="space-y-2">
						{attention.map((a) => (
							<AttentionCard key={a.id} item={a} response={interactions.find((i) => i.id === a.id)?.response} />
						))}
					</ul>
				)}
			</Card>
		</div>
	);
}
