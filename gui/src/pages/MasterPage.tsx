/**
 * Master 页（S3，vertical slice §32/§34）：logical id/owner/generation/proposal/cutover/
 * pending mailbox/recent master timeline + Accept + Auto-Handoff 开关。
 * Prepare/Transfer 保留 disabled 展示（拍板 3）；pressure 只显 proposal 时点值 + as-of（拍板 2①）。
 */

import { latestHandoffAttention } from "./TopBar";
import { acceptHandoff, setAutoHandoff, useGui } from "../store";
import { fmtDateTime, fmtPct, fmtTime } from "../format";
import { Badge, Button, Card, EmptyState, Toggle, Tooltip, naBadge } from "../ui";

const PREPARE_TRANSFER_TOOLTIP = "v0 无 deterministic 命令，属 master 会话 master-transfer 工具链，请走 Terminal Pi";

function statusTone(status: string | undefined): "yellow" | "blue" | "red" | "gray" {
	switch (status) {
		case "pending":
			return "yellow";
		case "accepted":
			return "blue";
		case "transferring":
			return "red";
		default:
			return "gray";
	}
}

export function MasterPage() {
	const health = useGui((s) => s.health);
	const snapshot = useGui((s) => s.snapshot);
	const attention = useGui((s) => s.attention);
	const timeline = useGui((s) => s.timeline);
	const autoHandoff = useGui((s) => s.autoHandoff);

	const master = snapshot?.master ?? null;
	const att = health?.master.attachment ?? master?.attachment ?? null;
	const proposal = latestHandoffAttention(attention);
	const pStatus = typeof proposal?.payload?.status === "string" ? (proposal.payload.status as string) : undefined;
	const pending = pStatus === "pending";
	const backlogPending = master?.backlog.reduce((n, b) => n + b.pending, 0) ?? 0;

	const masterTimeline = timeline
		.filter((t) => t.type.startsWith("master.handoff"))
		.slice(-8)
		.reverse();

	return (
		<div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
			{/* MasterSummary */}
			<Card title="Master Summary">
				{!att ? (
					<EmptyState>
						未 attach（legacy 行为）——master succession 面板在 attach 后可用
					</EmptyState>
				) : (
					<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
						<dt className="text-zinc-500">logical id</dt>
						<dd className="font-mono text-zinc-200">agent://master_default</dd>
						<dt className="text-zinc-500">owner session</dt>
						<dd className="font-mono break-all text-zinc-200">{att.sessionId}</dd>
						<dt className="text-zinc-500">generation</dt>
						<dd className="font-mono text-zinc-200">{att.generation}</dd>
						<dt className="text-zinc-500">attachedAt</dt>
						<dd className="font-mono text-zinc-200">{fmtDateTime(att.attachedAt)}</dd>
						<dt className="text-zinc-500">owner 活性</dt>
						<dd>
							{health?.masterOwnerAlive === true && <Badge tone="green">alive（心跳 &lt;15s）</Badge>}
							{health?.masterOwnerAlive === false && <Badge tone="red">stale（心跳缺失/超龄）</Badge>}
							{health === null && naBadge("health 未就绪")}
							{master?.stale && <Badge tone="yellow">snapshot: stale &gt;10min</Badge>}
						</dd>
						<dt className="text-zinc-500">cutover</dt>
						<dd>
							{(health?.master.cutover ?? false) || master?.cutover?.enabled ? (
								<Badge tone="purple">ON（消费端可接管）{master?.cutover ? ` · by ${master.cutover.enabledBy}` : ""}</Badge>
							) : (
								<Badge tone="gray">OFF</Badge>
							)}
						</dd>
						<dt className="text-zinc-500">pending mailbox</dt>
						<dd>
							<span className="font-mono text-zinc-200">{health ? health.mailboxPending : "—"}</span>
							{backlogPending > 0 && <span className="ml-2 text-[10px] text-zinc-500">master backlog {backlogPending}</span>}
						</dd>
					</dl>
				)}
			</Card>

			<div className="flex flex-col gap-3">
				{/* PressureCard：无 live 压力端点 → 只显最近 proposal 时点值 + as-of（拍板 2①） */}
				<Card title="Context Pressure">
					{typeof proposal?.payload?.pressure === "number" ? (
						<div className="flex items-baseline gap-3">
							<span className="font-mono text-3xl text-zinc-100">{fmtPct(proposal.payload.pressure as number)}</span>
							<span className="text-[11px] text-zinc-500">
								as-of {fmtTime(proposal.payload.proposedAt as string)}（proposal 时点，非 live）
							</span>
						</div>
					) : (
						<div className="flex items-center gap-2">
							<span className="font-mono text-3xl text-zinc-600">n/a</span>
							{naBadge("无 proposal；host 未暴露 live pressure")}
						</div>
					)}
				</Card>

				{/* ProposalCard + Prepare/Transfer（disabled+tooltip，拍板 3） */}
				<Card title="Handoff Proposal">
					{!proposal ? (
						<EmptyState>无 handoff proposal</EmptyState>
					) : (
						<div className="space-y-1.5 text-xs">
							<div className="flex items-center gap-2">
								<Badge tone={statusTone(pStatus)}>{pStatus ?? "unknown"}</Badge>
								<span className="text-zinc-400">gen {String(proposal.payload?.generation ?? "?")}</span>
								{typeof proposal.payload?.transferId === "string" && (
									<span className="font-mono text-[10px] text-zinc-500">transfer {proposal.payload.transferId}</span>
								)}
							</div>
							<p className="text-zinc-400">{proposal.summary}</p>
							<p className="text-[10px] text-zinc-600">
								proposedAt {fmtDateTime(proposal.payload?.proposedAt as string | undefined)}
								{proposal.payload?.decidedAt ? ` · decidedAt ${fmtDateTime(proposal.payload.decidedAt as string)}` : ""}
							</p>
						</div>
					)}
					<div className="mt-3 flex flex-wrap items-center gap-2">
						<Tooltip text={PREPARE_TRANSFER_TOOLTIP}>
							<Button disabled>
								Prepare Handoff
							</Button>
						</Tooltip>
						<Tooltip text={PREPARE_TRANSFER_TOOLTIP}>
							<Button disabled>
								Transfer Master
							</Button>
						</Tooltip>
						<Tooltip text={pending ? "POST master.handoff.accept → agent://master_default（issuedBy 服务端注入）" : "仅 proposal status=pending 时可接受"}>
							<Button variant="primary" disabled={!pending} onClick={() => void acceptHandoff()}>
								Accept Proposal
							</Button>
						</Tooltip>
					</div>
				</Card>

				{/* AutoHandoffToggle：无读取端点 → 初态「—（未知）」诚实呈现（拍板 3） */}
				<Card title="Auto Handoff">
					<div className="flex items-center gap-3">
						{autoHandoff === null ? (
							<>
								<span className="font-mono text-2xl text-zinc-600">—</span>
								{naBadge("未知：config 不经 API 暴露，无读取端点")}
							</>
						) : (
							<Badge tone={autoHandoff ? "green" : "gray"}>{autoHandoff ? "ON（本地乐观态）" : "OFF（本地乐观态）"}</Badge>
						)}
						<Toggle
							on={autoHandoff === true}
							onChange={(next) => void setAutoHandoff(next)}
							labels={["OFF", "ON"]}
						/>
						<span className="text-[10px] text-zinc-500">POST master.auto-handoff.set {"{auto}"} → config.masterSuccession.auto</span>
					</div>
				</Card>
			</div>

			{/* MasterTimelineList：滤 master.handoff.*（跨两列占满） */}
			<Card title="Recent Master Timeline" >
				{masterTimeline.length === 0 ? (
					<EmptyState>暂无 master.handoff.* 事件</EmptyState>
				) : (
					<ul className="space-y-1 text-xs">
						{masterTimeline.map((t) => (
							<li key={t.id} className="flex gap-2">
								<span className="w-16 shrink-0 font-mono text-[10px] text-zinc-600">{fmtTime(t.at)}</span>
								<span className="font-mono text-[10px] text-zinc-500">{t.type}</span>
								<span className="text-zinc-300">{t.summary}</span>
							</li>
						))}
					</ul>
				)}
			</Card>
		</div>
	);
}
