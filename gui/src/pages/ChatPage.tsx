/**
 * gui/src/pages/ChatPage.tsx — G6-P1 第 6 页「会话」：pi 会话列表 + chat 只读渲染。
 *
 * - 数据面：GET /v1/sessions（6s 轮询）+ GET transcript 首屏全量 + WS transcript 增量
 *   （useEventStream；断线重连带 seq/logEpoch，snapshot/resync → 全量重拉重订阅）；
 * - 渲染：5 种自包含行（turnHeader/userInput/assistantText/reasoning/toolCall）；
 * - 红线：只读（无任何控制流；发消息属 Phase 2）；既有五页 usePoll 零改动。
 */

import { useEffect, useMemo, useRef } from "react";
import { usePoll } from "../usePoll";
import { useGui } from "../store";
import { hostToken, streamUrl, useEventStream } from "../useEventStream";
import { Badge, Card, EmptyState, PageIntro, RelTime, ShortId, Term } from "../ui";
import type { TranscriptRow } from "../api/types";

function fmtDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const m = Math.floor(ms / 60_000);
	const s = Math.round((ms % 60_000) / 1000);
	return `${m}m${s.toString().padStart(2, "0")}s`;
}

function basename(p: string | null): string {
	if (p === null) return "";
	const norm = p.replace(/\\/g, "/");
	const idx = norm.lastIndexOf("/");
	return idx >= 0 ? norm.slice(idx + 1) : norm;
}

// ── 5 种行渲染组件 ────────────────────────────────────────────────

function TurnHeaderRowView({ row }: { row: Extract<TranscriptRow, { kind: "turnHeader" }> }) {
	return (
		<div className="my-3 flex items-center gap-2 text-[11px] text-zinc-500">
			<span className="h-px flex-1 bg-zinc-800" />
			<span className="font-mono">
				对话轮 {row.turnIndex} · <RelTime at={row.startedAt} />
				{row.durationMs !== undefined ? ` · ${fmtDuration(row.durationMs)}` : " · 进行中"}
			</span>
			<span className="h-px flex-1 bg-zinc-800" />
		</div>
	);
}

function UserInputRowView({ row }: { row: Extract<TranscriptRow, { kind: "userInput" }> }) {
	return (
		<div className="my-1.5 flex justify-end">
			<div className="max-w-[85%] whitespace-pre-wrap rounded-lg rounded-br-sm border border-blue-900/50 bg-blue-950/40 px-3 py-1.5 text-sm text-blue-100">
				{row.text.length > 0 ? row.text : <span className="text-blue-300/60">（非文本输入）</span>}
			</div>
		</div>
	);
}

function AssistantTextRowView({ row }: { row: Extract<TranscriptRow, { kind: "assistantText" }> }) {
	return (
		<div className="my-1.5 max-w-[90%] whitespace-pre-wrap text-sm leading-relaxed text-zinc-200">
			{row.text}
			{row.model !== undefined && <span className="ml-2 align-middle font-mono text-[10px] text-zinc-600">{row.model}</span>}
		</div>
	);
}

function ReasoningRowView({ row }: { row: Extract<TranscriptRow, { kind: "reasoning" }> }) {
	return (
		<details className="my-1 max-w-[90%] rounded border border-zinc-800/70 bg-zinc-900/50 px-2.5 py-1.5">
			<summary className="cursor-pointer select-none text-xs text-zinc-500">
				思考过程{row.model !== undefined && <span className="ml-2 font-mono text-[10px] text-zinc-600">{row.model}</span>}
			</summary>
			<div className="mt-1.5 whitespace-pre-wrap border-t border-zinc-800/60 pt-1.5 text-xs italic leading-relaxed text-zinc-500">{row.text}</div>
		</details>
	);
}

const TOOL_STATUS_TONE = { running: "yellow", done: "green", error: "red" } as const;

function ToolCallRowView({ row }: { row: Extract<TranscriptRow, { kind: "toolCall" }> }) {
	return (
		<div className="my-1.5 max-w-[90%] rounded border border-zinc-800 bg-zinc-900/60">
			<div className="flex items-center gap-2 border-b border-zinc-800/70 px-2.5 py-1.5">
				<span className="text-xs text-zinc-400">🔧</span>
				<span className="font-mono text-xs text-zinc-200">{row.name}</span>
				<Badge tone={TOOL_STATUS_TONE[row.status]}>{row.status === "running" ? "执行中" : row.status === "done" ? "完成" : "出错"}</Badge>
				{row.provider !== undefined && <span className="ml-auto font-mono text-[10px] text-zinc-600">{row.provider}</span>}
			</div>
			<details className="px-2.5 py-1.5">
				<summary className="cursor-pointer select-none text-[11px] text-zinc-500">参数与输出</summary>
				<pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-all rounded bg-zinc-950/70 p-2 font-mono text-[11px] leading-relaxed text-zinc-400">
					{JSON.stringify(row.arguments, null, 2)}
				</pre>
				{row.output !== undefined && (
					<pre className={`mt-1.5 max-h-56 overflow-y-auto whitespace-pre-wrap break-all rounded p-2 font-mono text-[11px] leading-relaxed ${row.status === "error" ? "bg-red-950/30 text-red-300" : "bg-zinc-950/70 text-zinc-400"}`}>
						{row.output}
					</pre>
				)}
			</details>
		</div>
	);
}

function RowView({ row }: { row: TranscriptRow }) {
	switch (row.kind) {
		case "turnHeader":
			return <TurnHeaderRowView row={row} />;
		case "userInput":
			return <UserInputRowView row={row} />;
		case "assistantText":
			return <AssistantTextRowView row={row} />;
		case "reasoning":
			return <ReasoningRowView row={row} />;
		case "toolCall":
			return <ToolCallRowView row={row} />;
	}
}

// ── 页面 ─────────────────────────────────────────────────────────

export function ChatPage() {
	const chatSessions = useGui((s) => s.chatSessions);
	const activeId = useGui((s) => s.chatActiveId);
	const rowsMap = useGui((s) => s.chatRowsBySession);
	const conn = useGui((s) => s.chatConn);
	const resyncKey = useGui((s) => s.chatResyncKey);

	const token = useMemo(() => hostToken(), []);
	const url = useMemo(() => (token !== null ? streamUrl(token) : null), [token]);

	// 会话列表低频轮询（chat 页内；既有五页 usePoll 零改动）
	usePoll(() => useGui.getState().pollChatSessions(), 6000);

	const wsState = useEventStream({
		enabled: activeId !== null,
		url,
		resyncKey,
		buildSubscriptions: () => {
			const id = useGui.getState().chatActiveId;
			if (id === null) return [];
			const head = useGui.getState().chatHeadBySession[id];
			return [
				head !== null && head !== undefined
					? { type: "subscribe" as const, topic: `transcript:${id}`, base: { seq: head.seq, logEpoch: head.logEpoch } }
					: { type: "subscribe" as const, topic: `transcript:${id}`, base: { seq: 0, logEpoch: "" } },
			];
		},
		onFrame: (f) => {
			void useGui.getState().applyChatFrame(f);
		},
	});
	useEffect(() => {
		useGui.getState().setChatConn(wsState);
	}, [wsState]);

	const rows = activeId !== null ? (rowsMap[activeId] ?? []) : [];
	const bottomRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		bottomRef.current?.scrollIntoView({ block: "end" });
	}, [rows.length, activeId]);

	return (
		<div className="space-y-3">
			<PageIntro>会话只读视图：pi 会话转写（自包含行投影；发消息属后续阶段）</PageIntro>
			<div className="flex h-[calc(100vh-11rem)] min-h-0 gap-3">
				{/* 左：会话列表 */}
				<Card title={<Term zh="会话" en="Sessions" />} >
					<div className="max-h-[calc(100vh-14rem)] w-64 shrink-0 overflow-y-auto">
						{chatSessions.length === 0 ? (
							<EmptyState>暂无会话（等待列表数据）</EmptyState>
						) : (
							<ul className="space-y-1">
								{chatSessions.map((s) => (
									<li key={s.sessionId}>
										<button
											type="button"
											onClick={() => void useGui.getState().openChatSession(s.sessionId)}
											title={s.file}
											className={`w-full rounded px-2 py-1.5 text-left text-xs transition-colors ${
												activeId === s.sessionId ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
											}`}
										>
											<div className="flex items-center justify-between gap-1">
												<ShortId value={s.sessionId} />
												<RelTime at={s.startedAt} className="shrink-0 text-[10px] text-zinc-500" />
											</div>
											<p className="mt-0.5 truncate font-mono text-[10px] text-zinc-600">{basename(s.cwd)}</p>
										</button>
									</li>
								))}
							</ul>
						)}
					</div>
				</Card>

				{/* 右：chat 只读渲染 */}
				<div className="flex min-w-0 flex-1 flex-col rounded-lg border border-zinc-800 bg-zinc-900/60">
					<header className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
						<h2 className="text-xs font-semibold tracking-wide text-zinc-400">
							<Term zh="对话" en="Transcript" />
						</h2>
						<div className="flex items-center gap-2 text-[11px]">
							{activeId !== null && <ShortId value={activeId} />}
							<ConnBadge conn={conn} hasToken={token !== null} />
						</div>
					</header>
					<div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
						{activeId === null ? (
							<EmptyState>从左侧选择一个会话</EmptyState>
						) : token === null ? (
							<EmptyState>
								缺少本机 token：请从 <span className="font-mono">npm run gui:dev</span> 打印的带 token URL 进入（WS 认证 fail-closed）
							</EmptyState>
						) : rows.length === 0 ? (
							<EmptyState>该会话暂无可投影内容（或正在加载）</EmptyState>
						) : (
							<>
								{rows.map((row) => (
									<RowView key={row.rowId} row={row} />
								))}
								<div ref={bottomRef} />
							</>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}

function ConnBadge({ conn, hasToken }: { conn: string; hasToken: boolean }) {
	if (!hasToken) return <Badge tone="yellow" title="缺 token：WS 未连接，仅 GET 兜底">无凭据</Badge>;
	if (conn === "open") return <Badge tone="green" title="WS 已连接（增量推送）">实时</Badge>;
	if (conn === "connecting") return <Badge tone="yellow">连接中</Badge>;
	if (conn === "down") return <Badge tone="red" title="WS 断开，自动重连中（重连带 seq 续传）">重连中</Badge>;
	return <Badge tone="gray">未接入</Badge>;
}
