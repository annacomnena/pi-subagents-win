/** 顶栏（plan §2）：Host● = masterOwnerAlive；Master % = 最近 proposal 时点压力 + as-of（无则 n/a）。 */

import { useGui } from "../store";
import { fmtPct, fmtTime } from "../format";
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

	const ownerAlive = health ? health.masterOwnerAlive : null;
	const dot =
		ownerAlive === null
			? "bg-zinc-600"
			: ownerAlive
				? "bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.8)]"
				: "bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.8)]";
	const dotLabel =
		ownerAlive === null ? "Host（未 attach）" : ownerAlive ? "Host · owner 存活" : "Host · owner stale";

	const proposal = latestHandoffAttention(attention);
	const pressure = proposal?.payload?.pressure;
	const asOf = proposal?.payload?.proposedAt;

	return (
		<header className="flex items-center gap-4 border-b border-zinc-800 bg-zinc-900 px-4 py-2">
			<span className="flex items-center gap-2 text-xs font-semibold">
				<span className={`h-2.5 w-2.5 rounded-full ${dot}`} title={dotLabel} />
				{dotLabel}
			</span>
			<span className="text-xs text-zinc-400">
				Master{" "}
				<span className="font-mono text-zinc-200">{fmtPct(typeof pressure === "number" ? pressure : null)}</span>
				{typeof pressure === "number" && <span className="ml-1 text-[10px] text-zinc-500">as-of {fmtTime(asString(asOf))}（proposal 时点，非 live）</span>}
			</span>
			<span className="ml-auto flex items-center gap-3 text-[11px] text-zinc-500">
				{health && (
					<>
						<span className="font-mono">
							127.0.0.1:{health.host.port} · pid {health.host.pid} · pv{health.host.protocolVersion}
						</span>
						<span className="font-mono">journal {health.journalTail.totalEvents}</span>
						<span className="font-mono">mailbox {health.mailboxPending}</span>
					</>
				)}
			</span>
		</header>
	);
}
