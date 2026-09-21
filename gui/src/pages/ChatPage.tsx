/**
 * gui/src/pages/ChatPage.tsx — 永久默认主视图「会话」（G6-P1 第 6 页 → 会话为主重构 S3/S5）。
 *
 * - 布局：会话列表已上移左栏（SessionList 常驻）；本页只剩 transcript+composer 同滚动视口，
 *   composer 为滚动容器内 sticky dock（S5，替 h-[calc(100vh-…)] 魔法数）；贴底锚定 +
 *   回看锁定阅读位 + 「回到底部」浮钮（单 scroll handler，不加依赖）；
 * - 数据面：GET transcript 首屏全量 + WS transcript 增量（useEventStream；断线重连带
 *   seq/logEpoch，snapshot/resync → 全量重拉重订阅）；sessions 6s 轮询已上移 App（S2）；
 * - 渲染：5 种自包含行（turnHeader/userInput/assistantText/reasoning/toolCall）；
 * - 红线：WS 只读（发消息走 HTTP outbox）；既有五页 usePoll 零改动。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useGui } from "../store";
import { streamUrl, useEventStream } from "../useEventStream";
import { Badge, Button, EmptyState, PageIntro, RelTime, ShortId, Term } from "../ui";
import type { ChatOutboxEntry, TranscriptRow } from "../api/types";
import type { StreamSubscribeMsg } from "../api/types";

function fmtDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const m = Math.floor(ms / 60_000);
	const s = Math.round((ms % 60_000) / 1000);
	return `${m}m${s.toString().padStart(2, "0")}s`;
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
	const outboxMap = useGui((s) => s.chatOutbox);
	const [draft, setDraft] = useState("");

	// gui:dev 的本机 Vite proxy 在上游注入 cookie；浏览器不持有 token。
	const url = useMemo(() => streamUrl(null), []);

	const wsState = useEventStream({
		enabled: activeId !== null,
		url,
		resyncKey,
		buildSubscriptions: (): StreamSubscribeMsg[] => {
			const st = useGui.getState();
			const subs: StreamSubscribeMsg[] = [];
			const id = st.chatActiveId;
			if (id !== null) {
				const head = st.chatHeadBySession[id];
				subs.push(
					head !== null && head !== undefined
						? {
							type: "subscribe",
							topic: `transcript:${id}`,
							// gen：持久流代际（L4）——同首行重写/轮转后旧 gen 被判不符 → snapshot 重拉
							base: { seq: head.seq, logEpoch: head.logEpoch, ...(typeof head.gen === "number" ? { gen: head.gen } : {}) },
						}
						: { type: "subscribe", topic: `transcript:${id}`, base: { seq: 0, logEpoch: "" } },
				);
			}
			// G6-P2：outbox 主题（session.message 两段回执投影；journal 过滤流）
			const oh = st.chatOutboxHead;
			subs.push(
				oh !== null
					? { type: "subscribe", topic: "outbox", base: { seq: oh.seq, logEpoch: oh.logEpoch, ...(typeof oh.gen === "number" ? { gen: oh.gen } : {}) } }
					: { type: "subscribe", topic: "outbox", base: { seq: 0, logEpoch: "" } },
			);
			return subs;
		},
		onFrame: (f) => {
			void useGui.getState().applyChatFrame(f);
		},
	});
	useEffect(() => {
		useGui.getState().setChatConn(wsState);
	}, [wsState]);

	const rows = activeId !== null ? (rowsMap[activeId] ?? []) : [];
	// G6-P2 L4 必修 4：Master 禁输入标识改服务端权威——/v1/sessions 条目的 masterProtected
	// flag（与 executor 护栏同源 getMasterStatus().attachment.sessionId）；不再拿 health 心跳
	// 自猜（stale 心跳会错标）。POST 真 403 回执仍是最后防线（store 层映射 rejected 徽标）。
	const activeSession = activeId !== null ? chatSessions.find((s) => s.sessionId === activeId) : undefined;
	const isMasterSession = activeSession?.masterProtected === true;
	const outboxEntries = useMemo(
		() =>
			Object.values(outboxMap)
				.filter((e) => e.sessionId === activeId)
				.sort((a, b) => a.at.localeCompare(b.at))
				.slice(-20),
		[outboxMap, activeId],
	);
	// S5：composer sticky dock + 贴底/回看锁定（替原 scrollIntoView）。
	// 单 scroll handler 判 nearBottom（≤48px）：贴底→新内容自动锚定吸底；离开底部→锁定阅读位
	//（不强制拉底），浮出「回到底部」钮。回看时消息从 dock 底下穿过（zcode composer dock 样板）。
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const [atBottom, setAtBottom] = useState(true);

	const handleScroll = (): void => {
		const el = scrollRef.current;
		if (el === null) return;
		setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 48);
	};

	// 贴底锚定：仅在 atBottom 时跟随新行/回执滚动；回看（!atBottom）锁定阅读位
	useEffect(() => {
		const el = scrollRef.current;
		if (el !== null && atBottom) el.scrollTop = el.scrollHeight;
	}, [rows, outboxEntries, atBottom]);

	// 切会话 → 重置贴底（先看最新）
	useEffect(() => {
		setAtBottom(true);
		const el = scrollRef.current;
		if (el !== null) el.scrollTop = el.scrollHeight;
	}, [activeId]);

	const scrollToLatest = (): void => {
		setAtBottom(true);
		const el = scrollRef.current;
		if (el !== null) el.scrollTop = el.scrollHeight;
	};

	const send = async (): Promise<void> => {
		const text = draft.trim();
		if (text.length === 0 || activeId === null || isMasterSession) return;
		setDraft("");
		await useGui.getState().sendChatMessage(activeId, text);
	};

	return (
		// S5：h-full flex-col 替代 h-[calc(100vh-…)] 魔法数（main 弹性列内自适应）
		<div className="flex h-full min-h-0 flex-col gap-3">
			<PageIntro>会话视图：pi 会话转写（自包含行投影）；输入经 POST /v1/commands 两段式投递（WS 保持只读）</PageIntro>
			{/* 会话列表已上移左栏（SessionList 常驻）；中央只剩 transcript+composer 同滚动视口 */}
			<div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-surface/60">
				<header className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
					<h2 className="text-xs font-semibold tracking-wide text-zinc-400">
						<Term zh="对话" en="Transcript" />
					</h2>
					<div className="flex items-center gap-2 text-[11px]">
						{activeId !== null && <ShortId value={activeId} />}
						<ConnBadge conn={conn} />
					</div>
				</header>
				<div className="relative min-h-0 flex-1">
					<div ref={scrollRef} onScroll={handleScroll} className="h-full overflow-y-auto px-4 py-3">
						<div className="flex min-h-full flex-col">
							{activeId === null ? (
								<EmptyState>从左栏选择一个会话</EmptyState>
							) : rows.length === 0 && outboxEntries.length === 0 ? (
								<EmptyState>该会话暂无可投影内容（或正在加载）</EmptyState>
							) : (
								<>
									{rows.map((row) => (
										<RowView key={row.rowId} row={row} />
									))}
									{outboxEntries.map((e) => (
										<OutboxRowView key={e.commandKey} e={e} />
									))}
								</>
							)}
							{/* S5：composer sticky dock——与 transcript 同滚动视口，sticky 到滚动容器底部；
							    mt-auto 兼短内容（空态时 dock 也贴视口底） */}
							<div className="sticky bottom-0 z-10 mt-auto -mx-4 border-t border-border bg-surface/95 px-4 py-2 backdrop-blur-sm">
							{isMasterSession ? (
								<p className="text-[11px] text-red-300/90">Master 会话拒绝远程输入（executor 层 403 护栏）</p>
							) : (
								<form
									onSubmit={(ev) => {
										ev.preventDefault();
										void send();
									}}
									className="flex items-end gap-2"
								>
									<textarea
										value={draft}
										onChange={(e) => setDraft(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === 'Enter' && !e.shiftKey) {
												e.preventDefault();
												void send();
											}
										}}
										maxLength={8000}
										rows={Math.min(4, Math.max(1, draft.split("\n").length))}
										placeholder={activeId !== null ? '输入消息发往该会话（Enter 发送，Shift+Enter 换行）' : '先选择会话'}
										disabled={activeId === null}
										className="max-h-32 min-h-[2.25rem] flex-1 resize-none rounded border border-zinc-700 bg-background/60 px-2.5 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none disabled:opacity-50"
									/>
									<Button onClick={() => void send()} disabled={activeId === null || draft.trim().length === 0}>
										发送
									</Button>
								</form>
							)}
							</div>
						</div>
					</div>
					{/* 回看锁定阅读位时浮出「回到底部」钮（替原 scrollIntoView） */}
					{!atBottom && activeId !== null && (
						<button
							type="button"
							onClick={scrollToLatest}
							className="absolute bottom-16 right-4 z-20 rounded-full border border-zinc-700 bg-background/90 px-3 py-1.5 text-[11px] text-zinc-200 shadow-lg backdrop-blur-sm transition-colors hover:bg-surface-hover"
						>
							↓ 回到底部
						</button>
					)}
				</div>
			</div>
		</div>
	);
}

// ── G6-P2：发送两段回执状态徽标 ──────────────────────────────

const OUTBOX_STATUS: Record<ChatOutboxEntry["status"], { tone: "gray" | "yellow" | "green" | "red"; label: string }> = {
	sending: { tone: "yellow", label: "发送中" },
	pending: { tone: "yellow", label: "已提交·等待注入" },
	delivered: { tone: "green", label: "已送达" },
	failed: { tone: "red", label: "失败" },
	expired: { tone: "gray", label: "已过期（24h 未投递）" },
	rejected: { tone: "red", label: "被拒绝" },
};

function OutboxRowView({ e }: { e: ChatOutboxEntry }) {
	const s = OUTBOX_STATUS[e.status];
	return (
		<div className="my-1.5 flex justify-end">
			<div className="flex max-w-[85%] items-start gap-2">
				<div className="whitespace-pre-wrap rounded-lg rounded-br-sm border border-blue-900/30 bg-blue-950/20 px-3 py-1.5 text-sm text-blue-200/80">{e.text}</div>
				<Badge tone={s.tone} title={e.detail ?? s.label}>{s.label}</Badge>
			</div>
		</div>
	);
}

function ConnBadge({ conn }: { conn: string }) {
	if (conn === "open") return <Badge tone="green" title="WS 已连接（增量推送）">实时</Badge>;
	if (conn === "connecting") return <Badge tone="yellow">连接中</Badge>;
	if (conn === "down") return <Badge tone="red" title="WS 断开，自动重连中（重连带 seq 续传）">重连中</Badge>;
	return <Badge tone="gray">未接入</Badge>;
}
