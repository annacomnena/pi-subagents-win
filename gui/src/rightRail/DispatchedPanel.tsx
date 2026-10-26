/**
 * gui/src/rightRail/DispatchedPanel.tsx — 右栏「派发」面板（设计稿 §3.5；P1B）。
 *
 * ## 它回答一个问题
 *
 * 「**我这个会话**刚才派出去的 subagent 现在怎么样了」——不再需要打开全屏覆盖层的「运行」页。
 * 覆盖层「运行」= 本机全量视角（`RunsPage`），右栏 = 本会话视角（`?sessionId=`）：
 * **共享判据（`deriveRunDisplay`/`formatUsage`/`runDurationDisplay`），不共享查询 scope**。
 *
 * ## 三条不能违反的纪律
 *
 * 1. **「运行中」只由 `deriveRunDisplay` 定**（unknown ≠ 运行中：实测 152/154 记录没有 pid 可判活）。
 * 2. **时长双口径**：终态 `durationMs` 标「末次尝试耗时」；运行中 `now - startedAt` 标「至今」；
 *    无值就「—」。**绝不**拿 `lastActivity` 当「已跑多久」（终态它是 `startedAt` 兜底伪值）。
 * 3. **读失败 ≠ 没有派发**：三种空态文案分开（`railState.ts::pickDispatchedEmpty`）。
 *
 * ## 轮询门控（§3.6）
 *
 * `usePoll(refresh, 5000, railPollingEnabled(...))` —— 展开 ∧ 面板=派发 ∧ 有会话 ∧ chat 视图 ∧
 * 覆盖层未开。**切会话立即补拍一次**（`usePoll` 的依赖只有 interval/enabled，不含会话），
 * 且**丢弃旧会话的迟到响应**（请求带 sid，回来比对当前 `chatActiveId`）。
 * 新鲜度用**最后成功请求时刻（本地时钟）**——304 会复用旧对象，响应里的 `asof` 不是新鲜度。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Clock, Copy, PlayCircle } from "lucide-react";
import { api } from "../api/client";
import type { RunCard, RunsResponse } from "../api/types";
import { Badge, EmptyState, RelTime, ShortId } from "../ui";
import { Button } from "../ui/button";
import { TONE_TO_BADGE, deriveRunDisplay, formatUsage, runDurationDisplay } from "../runsView";
import { usePoll } from "../usePoll";
import { useGui } from "../store";
import {
	PANEL_DISPATCHED,
	attributionNotice,
	pickDispatchedEmpty,
	railPollingEnabled,
} from "./railState";

/** 一次取多少条（服务端 limit 上限 200；右栏只要「本会话最近一屏」）。 */
const RAIL_RUNS_LIMIT = 50;
/** 轮询档位（§3.6）。 */
const RAIL_POLL_MS = 5000;
/** 「已跑 …（至今）」的本地时钟节拍（只驱动重渲染，不打网络）。 */
const NOW_TICK_MS = 1000;
/**
 * 同一会话的请求合并窗：`enabled` 翻转与切会话在同一帧发生时，
 * `usePoll` 的立即拍与本面板的「切会话补拍」会各打一次 —— 300ms 内同 sid 只发一次。
 */
const SAME_SID_COALESCE_MS = 300;

/** argsDigest 截断（服务端已截 ≤160 字节；侧栏宽度 320px ⇒ 再收一道）。 */
const DIGEST_MAX = 64;

interface PanelBox {
	/** 这批数据属于哪个会话（切会话后旧数据不得冒充新会话的数据）。 */
	sid: string | null;
	resp: RunsResponse | null;
	/** 最近一次请求失败原因（空串 = 没失败）。 */
	error: string;
	/** 最后一次**成功**请求的本地时刻（ms）；304 也算成功（数据仍是可用近似）。 */
	lastOkAt: number | null;
}

const EMPTY_BOX: PanelBox = { sid: null, resp: null, error: "", lastOkAt: null };

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max)}…`;
}

/** 单行：状态徽标 · agent · 时长 / 任务 40 字 / 费用·回合 · 最近 1 条工具；点击展开。 */
function DispatchedRow({ run, now }: { run: RunCard; now: number }) {
	const [open, setOpen] = useState(false);
	const display = deriveRunDisplay(run);
	const dur = runDurationDisplay(run, now);
	const lastCall = run.recentCalls?.[0];
	const calls = run.recentCalls ?? [];

	return (
		<div className="rounded-lg border border-border bg-card px-2 py-1.5">
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				aria-expanded={open}
				aria-label={`${display.label} ${run.agent ?? "subagent"}${run.taskPreview ? `：${run.taskPreview}` : ""}`}
				className="flex w-full flex-col items-stretch gap-1 text-left"
			>
				<span className="flex min-w-0 items-center gap-1.5">
					<Badge tone={TONE_TO_BADGE[display.tone]} title={display.hint}>
						{display.label}
					</Badge>
					{run.agent !== null && (
						<span className="min-w-0 truncate text-ui-xs text-foreground-subtle" title="派发的 agent 名">
							{run.agent}
						</span>
					)}
					<span className="ml-auto shrink-0 font-mono text-ui-xs text-foreground-subtle" title={dur.label}>
						{dur.text}
					</span>
				</span>
				{run.taskPreview !== "" && (
					<span className="line-clamp-2 break-words text-ui-sm text-foreground">{run.taskPreview}</span>
				)}
				<span className="flex min-w-0 items-center gap-1.5 text-ui-xs text-foreground-subtle">
					<span className="shrink-0" title="token 用量 / 费用 / 回合（运行中记录尚未落 result.usage ⇒ —）">
						{formatUsage(run.usage)}
					</span>
					{run.usage === null && <span className="shrink-0 text-foreground-subtlest">（运行中无用量快照）</span>}
					{lastCall !== undefined && (
						<>
							<span aria-hidden="true">·</span>
							<span className="min-w-0 truncate font-mono" title={`${lastCall.tool} ${lastCall.argsDigest}`}>
								最近 {lastCall.tool} {truncate(lastCall.argsDigest, DIGEST_MAX)}
							</span>
						</>
					)}
				</span>
			</button>

			{open && (
				<div className="mt-1.5 space-y-1 border-t border-border pt-1.5 text-ui-xs text-foreground-subtle">
					<div className="flex items-center gap-1.5">
						<span className="shrink-0 text-foreground-subtlest">runId</span>
						<ShortId value={run.id} chars={18} />
						<Button
							type="button"
							variant="ghost"
							size="icon-xs"
							aria-label="复制 runId"
							title={`复制 runId：${run.id}`}
							onClick={() => void navigator.clipboard?.writeText(run.id)}
						>
							<Copy className="size-3" />
						</Button>
						{run.pid !== null && (
							<span className="ml-auto shrink-0 font-mono" title="登记的进程 pid">
								pid {run.pid}
							</span>
						)}
					</div>
					{calls.length === 0 ? (
						<p className="text-foreground-subtlest">（无工具调用记录）</p>
					) : (
						<ol className="space-y-0.5">
							{calls.map((c, i) => (
								<li key={`${c.ts}-${i}`} className="flex items-baseline gap-1.5">
									<span className="shrink-0 font-medium">{c.tool}</span>
									<span className="break-all font-mono text-foreground-subtlest" title={c.argsDigest}>
										{truncate(c.argsDigest, DIGEST_MAX)}
									</span>
								</li>
							))}
						</ol>
					)}
					<p className="text-foreground-subtlest" title="async run 没有 transcript 端点 ⇒ 面板只展开元数据，不下钻对话流">
						async run 无 transcript 端点，点击行只展开元数据
					</p>
				</div>
			)}
		</div>
	);
}

export function DispatchedPanel() {
	const railOpen = useGui((s) => s.railOpen);
	const railPanel = useGui((s) => s.railPanel);
	const chatActiveId = useGui((s) => s.chatActiveId);
	const activeTab = useGui((s) => s.activeTab);
	const runtimeOverlay = useGui((s) => s.runtimeOverlay);

	const [box, setBox] = useState<PanelBox>(EMPTY_BOX);
	const [now, setNow] = useState(() => Date.now());
	const lastReqRef = useRef<{ sid: string | null; at: number } | null>(null);

	const enabled = railPollingEnabled({
		railOpen,
		railPanel,
		chatActiveId,
		activeTab,
		runtimeOverlay,
	});

	const refresh = useCallback(async () => {
		// ① 请求时刻的 sid **快照**：回来时用它判断响应是否已经过期（切会话后丢弃）。
		const sid = useGui.getState().chatActiveId;
		if (typeof sid !== "string" || sid.length === 0) return;
		const at = Date.now();
		const last = lastReqRef.current;
		if (last !== null && last.sid === sid && at - last.at < SAME_SID_COALESCE_MS) return;
		lastReqRef.current = { sid, at };

		const r = await api.runs({ sessionId: sid, limit: RAIL_RUNS_LIMIT, includeRecentCalls: true });
		// ② 迟到响应：A→B 之后回来的 A 响应不得写入（否则列表显示的是上一个会话的活）。
		if (useGui.getState().chatActiveId !== sid) return;
		if (r.ok) {
			setBox({ sid, resp: r.data, error: "", lastOkAt: Date.now() });
			return;
		}
		// ③ 失败：旧数据只在**同一会话**内保留（换了会话就不许拿旧会话的数据充数）。
		setBox((prev) =>
			prev.sid === sid
				? { ...prev, error: `读取失败 HTTP ${r.status}` }
				: { sid, resp: null, error: `读取失败 HTTP ${r.status}`, lastOkAt: null },
		);
	}, []);

	usePoll(refresh, RAIL_POLL_MS, enabled);
	// 「已跑 …（至今）」需要跟着本地时钟长；用 usePoll 而不是裸 setInterval（可暂停/可卸载）。
	usePoll(() => setNow(Date.now()), NOW_TICK_MS, enabled);

	// 切会话**立即补拍一次**：usePoll 的依赖只有 interval/enabled，会话变化不会触发重新计时。
	useEffect(() => {
		if (!enabled) return;
		void refresh();
	}, [chatActiveId, enabled, refresh]);

	// 切会话时**不渲染**上一个会话的数据：用 sid 比对做**派生过滤**（而不是只在 effect 里清，
	// useEffect 在绘制之后跑 ⇒ 只靠它清屏会先闪一帧旧会话的列表）。
	const sameSession = box.sid !== null && box.sid === chatActiveId;
	const resp = sameSession ? box.resp : null;

	const rows = resp?.runs ?? [];
	const empty = pickDispatchedEmpty({ hasSession: chatActiveId !== null, resp, failed: sameSession && box.error !== "" });
	const notice = attributionNotice(resp);

	return (
		<div className="flex min-h-0 flex-col gap-1.5 p-2" data-rail-panel={PANEL_DISPATCHED}>
			<div className="flex items-center gap-1.5 text-ui-xs text-foreground-subtle">
				<span title="右栏 = 本会话视角；覆盖层「运行」= 本机全量视角。两者共享判据，不共享查询范围。">
					本会话派发
				</span>
				{box.resp !== null && sameSession && (
					<span className="ml-auto shrink-0" title="显示条数 / 本会话匹配总数（服务端在截断前过滤）">
						{box.resp.count} / {box.resp.total}
					</span>
				)}
			</div>

			{box.error !== "" && sameSession && (
				<p role="status" className="flex items-start gap-1 text-ui-xs text-destructive">
					<AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
					<span>
						{box.error}
						{rows.length > 0 ? "；显示最后成功读到的数据" : ""}
					</span>
				</p>
			)}

			{notice !== null && rows.length > 0 && (
				<p className="text-ui-xs text-warning" title="归属账本只能确定一部分 run 的派发者">
					{notice}
				</p>
			)}

			<div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto">
				{rows.length > 0 ? (
					rows.map((run) => <DispatchedRow key={run.id} run={run} now={now} />)
				) : empty !== null ? (
					<EmptyState icon={empty.kind === "no-dispatch" ? <PlayCircle className="size-5" /> : <AlertTriangle className="size-5" />}>
						<span className="block">{empty.text}</span>
						<span className="mt-1 block text-ui-xs text-foreground-subtlest">{empty.hint}</span>
					</EmptyState>
				) : (
					<p className="px-1 py-2 text-ui-xs text-foreground-subtlest">正在加载本会话派发…</p>
				)}
			</div>

			<div className="flex shrink-0 items-center gap-1 text-ui-xs text-foreground-subtlest">
				<Clock className="size-3 shrink-0" aria-hidden="true" />
				{!sameSession || box.lastOkAt === null ? (
					<span>{sameSession ? "尚无成功读数" : "本会话还没有读数"}</span>
				) : (
					<>
						<span title={`最后一次成功请求时刻（本地时钟）：${new Date(box.lastOkAt).toLocaleString()}`}>
							最后成功 <RelTime at={new Date(box.lastOkAt).toISOString()} />
						</span>
						<span className="ml-auto">
							{enabled ? `每 ${RAIL_POLL_MS / 1000} 秒刷新` : "已暂停（未展开 / 非对话视图 / 覆盖层已开）"}
						</span>
					</>
				)}
			</div>
		</div>
	);
}
