/**
 * Master 页（G5.1 人话化 + G5.2 接真数据）：主控身份/当前值守会话/接班代数/交接提案/接管总开关/信箱 +
 * 上下文压力（优先 liveness 实时心跳值 + as-of，无心跳回退提案时点值）+ 最近交接时间线 +
 * 接受提案/自动交接开关（读 snapshot 真实态）。Prepare 启用（两步确认，确定性提案路径）。
 */

import { useRef, useState } from "react";
import { latestHandoffAttention } from "./TopBar";
import { acceptHandoff, prepareHandoff, setAutoHandoff, useGui } from "../store";
import { PROPOSAL_STATUS_ZH, fmtPressurePct, pressurePct, zhStatus } from "../format";
import { Badge, Button, Card, EmptyState, PageIntro, RelTime, ShortId, Term, Toggle, Tooltip, naBadge } from "../ui";

const TRANSFER_DISABLED = "交接执行只能由值守会话发起（值守会话内的 master-transfer 工具链）";
const PREPARE_HINT = "点一次确认后由 host 按最新心跳压力立即生成交接提案（不伪造压力：无心跳时会被拒绝）";
const AUTO_HINT = "压力到线时自动执行交接；状态来自后端 config.masterSuccession.auto";

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

	// G5.2：Prepare 两步确认——点一次变「确认生成提案？」，3 秒内再点才 POST
	const [confirmPrepare, setConfirmPrepare] = useState(false);
	const confirmTimer = useRef<number | null>(null);
	const clickPrepare = (): void => {
		if (!confirmPrepare) {
			setConfirmPrepare(true);
			if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current);
			confirmTimer.current = window.setTimeout(() => setConfirmPrepare(false), 3000);
			return;
		}
		if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current);
		setConfirmPrepare(false);
		void prepareHandoff();
	};

	const master = snapshot?.master ?? null;
	const att = health?.master.attachment ?? master?.attachment ?? null;
	const proposal = latestHandoffAttention(attention);
	const pStatus = typeof proposal?.payload?.status === "string" ? (proposal.payload.status as string) : undefined;
	const pending = pStatus === "pending";
	const backlogPending = master?.backlog.reduce((n, b) => n + b.pending, 0) ?? 0;
	// G5.2：压力显示——优先 liveness 活值（含 as-of），无心跳/无有效读数回退提案时点值
	const live = master?.liveness ?? null;
	const livePct = pressurePct(live?.pressure);
	const proposalPct = pressurePct(proposal?.payload?.pressure);

	const masterTimeline = timeline
		.filter((t) => t.type.startsWith("master.handoff"))
		.slice(-8)
		.reverse();

	const genRaw = proposal?.payload?.generation;
	const genText = genRaw !== undefined && genRaw !== null && genRaw !== "?" ? `第 ${String(genRaw)} 代` : "未知";

	return (
		<div className="space-y-3">
			<PageIntro>谁在值守、压力多高、要不要交接</PageIntro>
			<div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
				{/* 主控状态 */}
				<Card title={<Term zh="主控状态" en="Master" />}>
					{!att ? (
						<EmptyState>还没有会话接管主控——接管后这里会显示值守信息</EmptyState>
					) : (
						<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
							<dt className="text-zinc-500"><Term zh="主控身份" en="logical id" /></dt>
							<dd><ShortId value="agent://master_default" /></dd>
							<dt className="text-zinc-500"><Term zh="当前值守会话" en="owner session" /></dt>
							<dd><ShortId value={att.sessionId} /></dd>
							<dt className="text-zinc-500"><Term zh="接班代数" en="generation" /></dt>
							<dd className="text-zinc-200">第 {att.generation} 代</dd>
							<dt className="text-zinc-500">接班时间</dt>
							<dd><RelTime at={att.attachedAt} className="text-zinc-200" /></dd>
							<dt className="text-zinc-500">值守状态</dt>
							<dd>
								{health?.masterOwnerAlive === true && <Badge tone="green" title="15 秒内有心跳">值守中（心跳正常）</Badge>}
								{health?.masterOwnerAlive === false && <Badge tone="red" title="心跳缺失或超过 15 秒">已失联（心跳超时）</Badge>}
								{health === null && naBadge("后端数据未就绪")}
								{master?.stale && <Badge tone="yellow" title="快照超过 10 分钟未更新">快照已过时（超 10 分钟）</Badge>}
							</dd>
							<dt className="text-zinc-500">
								<Term zh="接管总开关" en="cutover" hint="开启后新会话才能接管消费端" />
							</dt>
							<dd>
								{(health?.master.cutover ?? false) || master?.cutover?.enabled ? (
									<Badge tone="purple" title="新会话可以接管消费端">
										已开启{master?.cutover ? ` · 由 ${master.cutover.enabledBy} 开启` : ""}
									</Badge>
								) : (
									<Badge tone="gray">已关闭</Badge>
								)}
							</dd>
							<dt className="text-zinc-500"><Term zh="信箱（未领信件）" en="mailbox" /></dt>
							<dd>
								<span className="text-zinc-200">{health ? health.mailboxPending : "暂无"}</span>
								{backlogPending > 0 && <span className="ml-2 text-[10px] text-zinc-500">主控信箱积压 {backlogPending} 封</span>}
							</dd>
						</dl>
					)}
				</Card>

				<div className="flex flex-col gap-3">
					{/* 上下文压力：G5.2 优先 liveness 实时心跳值 + as-of；无心跳回退提案时点值 */}
					<Card title={<Term zh="上下文压力" en="context pressure" hint="会话记忆快满时会自动提议交接" />}>
						{livePct !== null && live ? (
							<div className="flex items-baseline gap-3">
								<span className="font-mono text-3xl text-zinc-100">{fmtPressurePct(live.pressure)}</span>
								<span className="text-[11px] text-zinc-500">
									<Badge tone="green" title="值守会话 agent turn 结束时写盘的心跳活值">实时</Badge>
									<RelTime at={live.updatedAt} /> 更新
								</span>
							</div>
						) : proposalPct !== null ? (
							<div className="flex items-baseline gap-3">
								<span className="font-mono text-3xl text-zinc-100">{fmtPressurePct(proposal?.payload?.pressure)}</span>
								<span className="text-[11px] text-zinc-500">
									<RelTime at={proposal?.payload?.proposedAt as string | undefined} /> 提案时点值（非实时；暂无实时心跳）
								</span>
							</div>
						) : (
							<div className="flex items-center gap-2">
								<span className="text-3xl text-zinc-600">暂无数据</span>
								<span className="text-[11px] text-zinc-500">无实时心跳，也没有交接提案</span>
							</div>
						)}
					</Card>

					{/* 交接提案 + Prepare/Transfer（disabled + tooltip） */}
					<Card title={<Term zh="交接提案" en="handoff proposal" />}>
						{!proposal ? (
							<EmptyState>还没有交接提案</EmptyState>
						) : (
							<div className="space-y-1.5 text-xs">
								<div className="flex items-center gap-2">
									<Badge tone={statusTone(pStatus)}>{zhStatus(PROPOSAL_STATUS_ZH, pStatus)}</Badge>
									<span className="text-zinc-400">接班代数：{genText}</span>
									{typeof proposal.payload?.transferId === "string" && (
										<ShortId value={proposal.payload.transferId} className="text-[10px] text-zinc-500" />
									)}
								</div>
								<p className="text-zinc-400">{proposal.summary}</p>
								<p className="text-[10px] text-zinc-600">
									<RelTime at={proposal.payload?.proposedAt as string | undefined} /> 提出提案
									{proposal.payload?.decidedAt ? (
										<>
											{" · "}
											<RelTime at={proposal.payload.decidedAt as string} /> 作出决定
										</>
									) : null}
								</p>
							</div>
						)}
						<div className="mt-3 flex flex-wrap items-center gap-2">
							<Tooltip text={PREPARE_HINT}>
								<Button
									variant={confirmPrepare ? "danger" : "secondary"}
									disabled={pending}
									title={pending ? "已有待处理的提案" : undefined}
									onClick={clickPrepare}
								>
									{confirmPrepare ? "确认生成提案？" : "准备交接"}
								</Button>
							</Tooltip>
							<Tooltip text={TRANSFER_DISABLED}>
								<Button disabled>移交主控</Button>
							</Tooltip>
							<Tooltip text={pending ? "把这份交接提案标记为已接受" : "当前没有待处理的提案，暂时不能接受"}>
								<Button variant="primary" disabled={!pending} onClick={() => void acceptHandoff()}>
									接受提案
								</Button>
							</Tooltip>
						</div>
					</Card>

					{/* 自动交接开关：G5.2 读 snapshot 真实态（config.masterSuccession.auto）*/}
					<Card title={<Term zh="自动交接开关" en="Auto-Handoff" hint={AUTO_HINT} />}>
						<div className="flex items-center gap-3">
							{autoHandoff === null ? (
								<Tooltip text="后端数据未就绪，无法读取真实状态">
									<span className="cursor-help border-b border-dashed border-zinc-600 text-sm text-zinc-500">状态未知</span>
								</Tooltip>
							) : (
								<Badge tone={autoHandoff ? "green" : "gray"} title="来自 snapshot.master.autoHandoff（config.masterSuccession 归一化切片）">
									{autoHandoff ? "已开启" : "已关闭"}
								</Badge>
							)}
							<Toggle
								on={autoHandoff === true}
								onChange={(next) => void setAutoHandoff(next)}
								labels={["关", "开"]}
							/>
							<span className="text-[10px] text-zinc-500">POST master.auto-handoff.set {"{auto}"} → config.masterSuccession.auto</span>
						</div>
					</Card>
				</div>

				{/* 最近交接时间线（滤 master.handoff.*，跨两列占满） */}
				<Card title={<Term zh="交接时间线" en="master.handoff.*" />}>
					{masterTimeline.length === 0 ? (
						<EmptyState>还没有发生过交接事件</EmptyState>
					) : (
						<ul className="space-y-1 text-xs">
							{masterTimeline.map((t) => (
								<li key={t.id} className="flex gap-2">
									<RelTime at={t.at} className="w-20 shrink-0 text-[10px] text-zinc-600" />
									<span className="shrink-0 font-mono text-[10px] text-zinc-500">{t.type}</span>
									<span className="text-zinc-300">{t.summary}</span>
								</li>
							))}
						</ul>
					)}
				</Card>
			</div>
		</div>
	);
}
