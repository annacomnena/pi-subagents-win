/**
 * Runtime 页（G5.1 人话化）：后端服务 / 数量一览 / 事件日志 / 会话心跳 / 约定路径。
 * 约定路径 host 未暴露 → v0 硬编码 ~/.pi/agent/runtime 默认位置展示。
 */

import { useGui } from "../store";
import { Badge, Card, EmptyState, PageIntro, RelTime, ShortId, Term, naBadge } from "../ui";

export function RuntimePage() {
	const health = useGui((s) => s.health);
	const runtime = useGui((s) => s.snapshot?.runtime ?? null);

	if (!health && !runtime) {
		return (
			<div className="space-y-3">
				<PageIntro>后端全景：服务、信箱、任务、定时器</PageIntro>
				<Card title={<Term zh="运行时" en="Runtime" />}>
					<EmptyState>正在等待后端数据…（服务未就绪或连接中断）</EmptyState>
				</Card>
			</div>
		);
	}

	const counts = runtime?.counts;
	const journal = runtime?.journal;
	const countsRows: [string, string, number | undefined][] = [
		["工作流", "workstreams", counts?.workstreams],
		["任务", "tasks", counts?.tasks],
		["运行", "runs", counts?.runs],
		["待领信件", "pendingMailbox", counts?.pendingMailbox],
	];
	const journalRows: [string, string, number | undefined][] = [
		["总事件数", "totalEvents", journal?.totalEvents],
		["已应用", "applied", journal?.applied],
		["已跳过", "skipped", journal?.skipped],
		["坏行跳过", "skippedBadLines", journal?.skippedBadLines],
	];

	return (
		<div className="space-y-3">
			<PageIntro>后端全景：服务、信箱、任务、定时器</PageIntro>
			<div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
				<Card title={<Term zh="服务" en="Host" />}>
					{health ? (
						<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
							<dt className="text-zinc-500">实例 ID</dt>
							<dd><ShortId value={health.host.instanceId} /></dd>
							<dt className="text-zinc-500">监听地址</dt>
							<dd className="font-mono text-zinc-200">
								127.0.0.1:{health.host.port} · pid {health.host.pid}
							</dd>
							<dt className="text-zinc-500">启动时间</dt>
							<dd><RelTime at={health.host.startedAt} className="text-zinc-200" /></dd>
							<dt className="text-zinc-500">协议版本</dt>
							<dd className="font-mono text-zinc-200">{health.host.protocolVersion}</dd>
							<dt className="text-zinc-500">数据生成于</dt>
							<dd><RelTime at={health.generatedAt} className="text-zinc-200" /></dd>
						</dl>
					) : (
						naBadge("后端数据未就绪")
					)}
				</Card>

				<Card title={<Term zh="数量一览" en="counts" />}>
					<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
						{countsRows.map(([zh, en, v]) => (
							<div key={en} className="rounded border border-zinc-800 bg-zinc-900 px-2 py-1.5">
								<p className="text-lg text-zinc-100">{v === undefined ? <span className="text-sm text-zinc-600">暂无</span> : v}</p>
								<p className="text-[10px] text-zinc-500">
									{zh} <span className="font-mono text-zinc-600">{en}</span>
								</p>
							</div>
						))}
					</div>
				</Card>

				<Card title={<Term zh="事件日志（本次重建）" en="journal" />}>
					<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
						{journalRows.map(([zh, en, v]) => (
							<RuntimeRow key={en} label={<>{zh} <span className="font-mono text-zinc-600">{en}</span></>} value={v === undefined ? "暂无" : String(v)} />
						))}
						<dt className="text-zinc-500">最近事件</dt>
						<dd><RelTime at={health ? health.journalTail.lastEnvelopeAt : null} className="text-zinc-200" /></dd>
					</dl>
				</Card>

				<Card title={<Term zh={`会话心跳（${health?.sessionHeartbeats.length ?? 0}）`} en="session heartbeats" />}>
					{!health || health.sessionHeartbeats.length === 0 ? (
						<EmptyState>暂无会话心跳（还没有会话活动，或数据未就绪）</EmptyState>
					) : (
						<ul className="space-y-1 text-[11px]">
							{health.sessionHeartbeats.map((h) => (
								<li key={h.sessionId} className="flex items-center gap-2">
									{h.alive ? <Badge tone="green" title="15 秒内有心跳">在线</Badge> : <Badge tone="gray" title="心跳超时">失联</Badge>}
									<ShortId value={h.sessionId} className="text-zinc-400" />
									<RelTime at={h.lastActiveAt} className="ml-auto shrink-0 text-zinc-600" />
								</li>
							))}
						</ul>
					)}
				</Card>

				{/* 约定路径（host 未暴露，展示默认位置） */}
				<PathsCardStatic />
			</div>
		</div>
	);
}

function RuntimeRow({ label, value }: { label: React.ReactNode; value: string }) {
	return (
		<>
			<dt className="text-zinc-500">{label}</dt>
			<dd className="text-zinc-200">{value}</dd>
		</>
	);
}

function PathsCardStatic() {
	const base = "~/.pi/agent/runtime";
	const rows: [string, string][] = [
		["运行目录", `${base}/（可用 PI_RUNTIME_DIR 覆盖）`],
		["配置文件", `${base}/host.json（提示用，非权威）`],
		["事件日志", `${base}/events.jsonl`],
		["状态目录", `${base}/state/`],
		["信箱目录", `${base}/mailbox/`],
		["链接文件", "~/.pi/agent/links.jsonl"],
	];
	return (
		<Card title={<Term zh="约定路径（后端未提供，以下为默认位置）" en="paths" />}>
			<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[11px]">
				{rows.map(([k, v]) => (
					<span key={k} className="contents">
						<dt className="text-zinc-500">{k}</dt>
						<dd className="font-mono break-all text-zinc-300">{v}</dd>
					</span>
				))}
			</dl>
		</Card>
	);
}
