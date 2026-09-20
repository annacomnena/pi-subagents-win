/**
 * Runtime 页（S6，§37）：Host / counts / journal / session 心跳 / 约定路径。
 * Runtime paths host 未暴露 → v0 硬编码 ~/.pi/agent/runtime 约定路径展示（拍板 2②）。
 */

import { useGui } from "../store";
import { fmtDateTime, fmtTime } from "../format";
import { Badge, Card, EmptyState, naBadge } from "../ui";

export function RuntimePage() {
	const health = useGui((s) => s.health);
	const runtime = useGui((s) => s.snapshot?.runtime ?? null);

	if (!health && !runtime) {
		return (
			<Card title="Runtime">
				<EmptyState>等待 /v1/health 与 /v1/snapshot …（host 未就绪或连接中断）</EmptyState>
			</Card>
		);
	}

	const counts = runtime?.counts;
	const journal = runtime?.journal;
	const countsRows: [string, number | undefined][] = [
		["workstreams", counts?.workstreams],
		["tasks", counts?.tasks],
		["runs", counts?.runs],
		["pendingMailbox", counts?.pendingMailbox],
	];
	const journalRows: [string, number | undefined][] = [
		["totalEvents", journal?.totalEvents],
		["applied", journal?.applied],
		["skipped", journal?.skipped],
		["skippedBadLines", journal?.skippedBadLines],
	];

	return (
		<div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
			<Card title="Host">
				{health ? (
					<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
						<dt className="text-zinc-500">instanceId</dt>
						<dd className="font-mono break-all text-zinc-200">{health.host.instanceId}</dd>
						<dt className="text-zinc-500">listen</dt>
						<dd className="font-mono text-zinc-200">
							127.0.0.1:{health.host.port} · pid {health.host.pid}
						</dd>
						<dt className="text-zinc-500">startedAt</dt>
						<dd className="font-mono text-zinc-200">{fmtDateTime(health.host.startedAt)}</dd>
						<dt className="text-zinc-500">protocolVersion</dt>
						<dd className="font-mono text-zinc-200">{health.host.protocolVersion}</dd>
						<dt className="text-zinc-500">generatedAt</dt>
						<dd className="font-mono text-zinc-200">{fmtTime(health.generatedAt)}</dd>
					</dl>
				) : (
					naBadge("health 未就绪")
				)}
			</Card>

			<Card title="Counts">
				<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
					{countsRows.map(([k, v]) => (
						<div key={k} className="rounded border border-zinc-800 bg-zinc-900 px-2 py-1.5">
							<p className="font-mono text-lg text-zinc-100">{v ?? "—"}</p>
							<p className="text-[10px] text-zinc-500">{k}</p>
						</div>
					))}
				</div>
			</Card>

			<Card title="Journal（本次 rebuild）">
				<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
					{journalRows.map(([k, v]) => (
						<RuntimeRow key={k} label={k} value={v === undefined ? "—" : String(v)} />
					))}
					<dt className="text-zinc-500">lastEnvelopeAt</dt>
					<dd className="font-mono text-zinc-200">{health ? fmtDateTime(health.journalTail.lastEnvelopeAt) : "—"}</dd>
				</dl>
			</Card>

			<Card title={`Session Heartbeats（${health?.sessionHeartbeats.length ?? 0}）`}>
				{!health || health.sessionHeartbeats.length === 0 ? (
					<EmptyState>无会话心跳（timers sessions/ 目录为空或 health 未就绪）</EmptyState>
				) : (
					<ul className="space-y-1 text-[11px]">
						{health.sessionHeartbeats.map((h) => (
							<li key={h.sessionId} className="flex items-center gap-2">
								{h.alive ? <Badge tone="green">alive</Badge> : <Badge tone="gray">stale</Badge>}
								<span className="font-mono break-all text-zinc-400">{h.sessionId}</span>
								<span className="ml-auto shrink-0 text-zinc-600">{fmtTime(h.lastActiveAt)}</span>
							</li>
						))}
					</ul>
				)}
			</Card>

			{/* dl 渲染放组件外（上方 PathsCard 内联 map 的占位实现废弃） */}
			<PathsCardStatic />
		</div>
	);
}

function RuntimeRow({ label, value }: { label: string; value: string }) {
	return (
		<>
			<dt className="text-zinc-500">{label}</dt>
			<dd className="font-mono text-zinc-200">{value}</dd>
		</>
	);
}

function PathsCardStatic() {
	const base = "~/.pi/agent/runtime";
	const rows: [string, string][] = [
		["runtime dir", `${base}/（PI_RUNTIME_DIR 可覆盖）`],
		["host.json", `${base}/host.json（hint 非 truth）`],
		["journal", `${base}/events.jsonl`],
		["state", `${base}/state/`],
		["mailbox", `${base}/mailbox/`],
		["links", "~/.pi/agent/links.jsonl"],
	];
	return (
		<Card title="Runtime Paths（约定路径，host 未暴露）">
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
