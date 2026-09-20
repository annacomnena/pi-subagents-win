/**
 * Attention 页（S5，§30/§31）：三源待关注列表（severity 色带 + type + summary）。
 * actions 恒缺省（v1）→ GUI 按 type 自造按钮（research §3.3）：master-handoff pending → Accept。
 */

import { useEffect, useState } from "react";
import { acceptHandoff, useGui } from "../store";
import { fmtDateTime } from "../format";
import { Badge, Button, Card, EmptyState, Toggle } from "../ui";
import type { AttentionItem, AttentionSeverity } from "../api/types";

const SEV_BAND: Record<AttentionSeverity, string> = {
	critical: "border-l-red-600",
	warning: "border-l-amber-500",
	info: "border-l-sky-600",
};

function typeBadge(a: AttentionItem) {
	switch (a.type) {
		case "runtime-risk":
			return <Badge tone="red">runtime-risk</Badge>;
		case "master-handoff":
			return <Badge tone="blue">master-handoff</Badge>;
		case "escalation":
			return <Badge tone="yellow">escalation</Badge>;
		case "question":
			return <Badge>question</Badge>;
		case "blocked":
			return <Badge tone="yellow">blocked</Badge>;
		default:
			return <Badge>{a.type}</Badge>;
	}
}

function AttentionCard({ item }: { item: AttentionItem }) {
	const proposalStatus = typeof item.payload?.status === "string" ? (item.payload.status as string) : undefined;
	const canAccept = item.type === "master-handoff" && proposalStatus === "pending";
	return (
		<li className={`rounded border border-zinc-800 border-l-4 bg-zinc-900/60 px-3 py-2 ${SEV_BAND[item.severity]}`}>
			<div className="flex flex-wrap items-center gap-2">
				{typeBadge(item)}
				<Badge tone={item.status === "open" ? "gray" : "green"}>{item.status}</Badge>
				<span className="text-xs font-medium text-zinc-200">{item.title}</span>
				<span className="ml-auto text-[10px] text-zinc-600">{fmtDateTime(item.createdAt)}</span>
			</div>
			<p className="mt-1 text-[11px] break-all text-zinc-400">{item.summary}</p>
			{item.source && <p className="mt-0.5 font-mono text-[10px] text-zinc-600">{item.source}</p>}
			{canAccept && (
				<div className="mt-2">
					<Button variant="primary" onClick={() => void acceptHandoff()}>
						Accept Handoff
					</Button>
				</div>
			)}
		</li>
	);
}

export function AttentionPage() {
	const attention = useGui((s) => s.attention);
	const includeResolved = useGui((s) => s.attentionIncludeResolved);
	const setIncludeResolved = useGui((s) => s.setAttentionIncludeResolved);
	const pollAttention = useGui((s) => s.pollAttention);
	const [busy, setBusy] = useState(false);

	// 切 resolved 视图立即补一拍（不等下一轮 2s）
	useEffect(() => {
		setBusy(true);
		void pollAttention().finally(() => setBusy(false));
	}, [includeResolved, pollAttention]);

	return (
		<div className="space-y-3">
			<div className="flex items-center gap-3">
				<span className="text-xs text-zinc-500">含 resolved</span>
				<Toggle on={includeResolved} onChange={setIncludeResolved} labels={["隐藏", "显示"]} />
				<span className="ml-auto text-[10px] text-zinc-600">/v1/attention{includeResolved ? "?includeResolved=1" : ""} · 2s</span>
			</div>
			<Card title={`Attention（${attention.length}${busy ? " · 刷新中" : ""}）`}>
				{attention.length === 0 ? (
					<EmptyState>{includeResolved ? "无条目" : "无待关注条目（可切 resolved 视图看历史）"}</EmptyState>
				) : (
					<ul className="space-y-2">
						{attention.map((a) => (
							<AttentionCard key={a.id} item={a} />
						))}
					</ul>
				)}
			</Card>
		</div>
	);
}
