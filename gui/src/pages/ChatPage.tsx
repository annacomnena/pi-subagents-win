/**
 * gui/src/pages/ChatPage.tsx — 中央 transcript + composer（ZCode 1:1 复刻 第 5/6 步）。
 *
 * - 行型映射（拍板 5）：我方 5 种 TranscriptRow → zcode 行型（class 串照抄锚 §2.b）：
 *   turnHeader→调试 turn header 行；userInput→右对齐气泡（rounded-tr-xs 缺角必抄）；
 *   assistantText→行式 <Markdown>（0923 2003 自研零依赖渲染器，替换 whitespace-pre-wrap 纯文本）；
 *   reasoning→Collapsible 默认收起（正文同 Markdown）；
 *   toolCall→Collapsible 单行卡（运行中=animated-gradient-text 扫光≈流式；无光标字符）。
 * - composer（拍板 6 + S6b 圆角收敛）：rounded-xl border-input-border bg-input p-3 三态边框 + 发送钮
 *   icon-md bg-brand ArrowUp；加号钮与 Stop 钮灰显占位（无后端，Tooltip「未接入」）。
 * - 数据面零改动：GET transcript 首屏 + WS 增量（useEventStream）+ sendChatMessage
 *   （P2 session.message POST + outbox 两段回执，OUTBOX_STATUS 文案沿用）。
 * - 滚动：视口 [scrollbar-gutter:stable]；贴底锚定/回看锁定保留现逻辑；回看 mask 渐隐
 *   （ConversationTimeline.tsx#L882-909 公式，FADE=24 / TRANSPARENT=96）+ 回到底部浮钮。
 */

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, ChevronRight, Plus, ShieldCheck, Square, Wrench, X } from "lucide-react";
import { useGui } from "../store";
import { streamUrl, useEventStream } from "../useEventStream";
import { usePoll } from "../usePoll";
import { Markdown } from "../ui/Markdown";
import { RelTime } from "../ui";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import type { ChatOutboxEntry, TranscriptRow } from "../api/types";
import type { StreamSubscribeMsg } from "../api/types";
import { api } from "../api/client";
import {
	attachmentIds,
	canSendMessage,
	candidatesFrom,
	applyOversizePaste,
	formatBytes,
	pickAttachments,
	pickPastePlan,
	rejectHint,
	type AttachmentItem,
	type ClipboardLike,
	type FileListLike,
} from "../composerAttachments";
import { echoedOutboxIds, outboxIdForCommandKey, parseOutboxEnvelope } from "../outboxEnvelope";

// 回看 mask 渐隐常数（ConversationTimeline.tsx#L99-100）
const COMPOSER_MESSAGE_MASK_FADE_PX = 24;
const COMPOSER_MESSAGE_MASK_TRANSPARENT_HEIGHT_PX = 96;
// 工具卡收起延迟卸载（ToolLayout.tsx#L26）
const TOOL_CONTENT_COLLAPSE_UNMOUNT_DELAY_MS = 300;

function fmtDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const m = Math.floor(ms / 60_000);
	const s = Math.round((ms % 60_000) / 1000);
	return `${m}m${s.toString().padStart(2, "0")}s`;
}

/** 行壳（ConversationRowView.tsx#L128-147 RowShell）：入场动画 = zcode-stream-text-in。 */
function RowShell({
	rowId,
	className,
	animate,
	children,
}: {
	rowId: string;
	className?: string;
	/** 是否播放入场动画（只给「本次新增」的行；整批历史不打，见 ChatPage 的 animateFromIndex）。 */
	animate?: boolean;
	children: React.ReactNode;
}) {
	return (
		<div data-row-id={rowId} {...(animate === true ? { "data-zcode-stream-animate": "true" } : {})} className={className}>
			{children}
		</div>
	);
}

// ── 5 种行 → zcode 行型 ───────────────────────────────────────────

/** 调试 turn header 行（ConversationRowView.tsx#L1622-1628）。 */
function TurnHeaderRowView({ row, animate }: { row: Extract<TranscriptRow, { kind: "turnHeader" }>; animate?: boolean }) {
	return (
		<RowShell
			animate={animate}
			rowId={row.rowId}
			className="border-b border-[var(--color-border)] py-1 text-ui-sm text-[var(--color-foreground-subtle)]"
		>
			对话轮 {row.turnIndex} · <RelTime at={row.startedAt} />
			{row.durationMs !== undefined ? ` · ${fmtDuration(row.durationMs)}` : " · 进行中"}
		</RowShell>
	);
}

/**
 * user 右对齐气泡全套（#L1190,1252-1270）：rounded-tr-xs 缺角必抄。
 *
 * 2026-10-19：远程注入（Web Console）的正文带**投递信封**
 * （`（来源｜dedupe:outbox:<hex>）` + 附件块 + `[evt:async:…]`）。
 * 之前直接把原文渲出来 ⇒ 用户看到一大坨内部元数据，且与下方本地回显重复成两条。
 *
 * 用户裁决：**TUI 里保留信封可以接受**（不改注入正文 —— 那会断
 * `async-result-watcher` 的 consumed ACK 与 `wechat-reply-hook` 的微信回路）。
 * 所以这里只做**渲染层**处理：
 *   - 信封细节收进默认折叠的「投递详情」
 *   - 正文与附件 chip 常显
 *   - 普通手输消息（无信封）**渲染逐字节不变**
 */
function UserInputRowView({ row, animate }: { row: Extract<TranscriptRow, { kind: "userInput" }>; animate?: boolean }) {
	const parsed = useMemo(() => parseOutboxEnvelope(row.text), [row.text]);
	if (parsed === null) {
		// 无信封 ⇒ 旧渲染路径（零行为变化）
		return (
			<RowShell rowId={row.rowId} animate={animate} className="group/user-row flex flex-col items-end">
				<div className="flex max-w-full flex-col gap-2 rounded-xl rounded-tr-xs border border-border bg-bubble-user px-4 py-3 text-ui-base text-bubble-user-foreground @min-[624px]/conversation:max-w-xl">
					<div className="whitespace-pre-wrap">
						{row.text.length > 0 ? row.text : <span className="opacity-60">（非文本输入）</span>}
					</div>
				</div>
			</RowShell>
		);
	}
	return (
		<RowShell rowId={row.rowId} animate={animate} className="group/user-row flex flex-col items-end">
			<div className="flex max-w-full flex-col gap-2 rounded-xl rounded-tr-xs border border-border bg-bubble-user px-4 py-3 text-ui-base text-bubble-user-foreground @min-[624px]/conversation:max-w-xl">
				<div className="whitespace-pre-wrap">
					{parsed.text.length > 0 ? parsed.text : <span className="opacity-60">（空白消息）</span>}
				</div>
				{parsed.attachmentPaths.length > 0 && (
					<div className="flex flex-wrap gap-1.5" data-user-attachment-chips="1">
						{parsed.attachmentPaths.map((p, i) => (
							<span
								key={`${p}-${i}`}
								title={p}
								className="inline-flex items-center gap-1 rounded-md border border-border bg-background/40 px-1.5 py-0.5 text-ui-xs text-foreground-subtlest"
							>
								🖼 图片 {i + 1}
							</span>
						))}
					</div>
				)}
				{/* 投递详情：默认折叠（用户不想看内部 id，但排障时要有） */}
				<Collapsible className="w-full">
					<CollapsibleTrigger className="group/outbox inline-flex cursor-pointer items-center gap-1 text-ui-xs text-foreground-subtlest transition-colors hover:text-foreground-subtle">
						<ChevronRight className="size-3 shrink-0 transition-transform group-data-[state=open]/collapsible:rotate-90" />
						<span>投递详情</span>
						<span className="font-mono opacity-70">{parsed.outboxId.slice(0, 8)}</span>
					</CollapsibleTrigger>
					<CollapsibleContent className="outline-none">
						<div className="mt-1 space-y-1 rounded-md border border-border/60 bg-background/30 p-2 font-mono text-ui-xs text-foreground-subtlest">
							{parsed.source !== undefined && <div>来源：{parsed.source}</div>}
							<div className="break-all">outboxId：{parsed.outboxId}</div>
							{parsed.eventIds.length > 0 && (
								<div className="break-all">eventId：{parsed.eventIds.join(", ")}</div>
							)}
							{parsed.attachmentPaths.map((p, i) => (
								<div key={`${p}-detail-${i}`} className="break-all">
									附件 {i + 1}：{p}
								</div>
							))}
						</div>
					</CollapsibleContent>
				</Collapsible>
			</div>
		</RowShell>
	);
}

/** assistant 行式正文（#L1512,1518）：0923 2003 正文换 <Markdown>（自研零依赖渲染器，
 *  替换 whitespace-pre-wrap 纯文本；外层 className 布局类保留）+ 注脚。 */
function AssistantTextRowView({ row, animate }: { row: Extract<TranscriptRow, { kind: "assistantText" }>; animate?: boolean }) {
	return (
		<RowShell rowId={row.rowId} animate={animate} className="group/assistant-row">
			<div className="w-full text-ui-base">
				<div className="whitespace-pre-wrap">
					<Markdown text={row.text} />
				</div>
				{(row.model !== undefined || row.provider !== undefined) && (
					<div className="mt-1 font-mono text-ui-xs text-foreground-subtlest">
						{row.model}
						{row.provider !== undefined ? ` · ${row.provider}` : ""}
					</div>
				)}
			</div>
		</RowShell>
	);
}

/** reasoning 折叠块：默认收起（streaming/complete 都收起 = zcode Reasoning 口径）。 */
function ReasoningRowView({ row, animate }: { row: Extract<TranscriptRow, { kind: "reasoning" }>; animate?: boolean }) {
	return (
		<RowShell rowId={row.rowId} animate={animate}>
			<Collapsible className="w-full">
				<CollapsibleTrigger className="group/reasoning inline-flex max-w-full cursor-pointer items-center gap-2 self-start text-left text-ui-base text-foreground-subtlest transition-colors hover:text-foreground-subtle">
					<ChevronRight className="size-3.5 shrink-0 transition-transform group-data-[state=open]/collapsible:rotate-90" />
					<span className="font-medium">思考过程</span>
					{row.model !== undefined && (
						<span className="font-mono text-ui-xs text-foreground-subtlest">{row.model}</span>
					)}
				</CollapsibleTrigger>
				<CollapsibleContent className="text-popover-foreground outline-none">
					<div className="pt-2 text-ui-sm text-foreground-subtle">
						<div className="whitespace-pre-wrap">
							<Markdown text={row.text} />
						</div>
					</div>
				</CollapsibleContent>
			</Collapsible>
		</RowShell>
	);
}

// ── toolCall：Collapsible 单行卡（ToolLayout 交互样板的最小移植）──────────────
// 展开态按 rowId 存内存 Map 持久（ToolLayout.tsx#L44-46）；收起延迟卸载 300ms（#L26）。

const toolCardOpenState = new Map<string, boolean>();

function ToolCallRowView({ row, animate }: { row: Extract<TranscriptRow, { kind: "toolCall" }>; animate?: boolean }) {
	const isOpen = toolCardOpenState.get(row.rowId) ?? false;
	// shouldRenderContent：收起后延迟 300ms 再卸载展开体（Radix closed 动画要读高度变量）
	const [shouldRenderContent, setShouldRenderContent] = useState(isOpen);
	const unmountDelayRef = useRef<number | null>(null);

	useEffect(() => {
		if (isOpen) {
			if (unmountDelayRef.current !== null) {
				window.clearTimeout(unmountDelayRef.current);
				unmountDelayRef.current = null;
			}
			setShouldRenderContent(true);
			return;
		}
		if (!shouldRenderContent) return;
		unmountDelayRef.current = window.setTimeout(() => {
			setShouldRenderContent(false);
			unmountDelayRef.current = null;
		}, TOOL_CONTENT_COLLAPSE_UNMOUNT_DELAY_MS);
		return () => {
			if (unmountDelayRef.current !== null) {
				window.clearTimeout(unmountDelayRef.current);
				unmountDelayRef.current = null;
			}
		};
	}, [isOpen, shouldRenderContent]);

	const isRunning = row.status === "running";
	const isError = row.status === "error";
	const statusLabel = isRunning ? "执行中" : isError ? "出错" : "完成";

	return (
		<RowShell rowId={row.rowId} animate={animate} className="py-0">
			<Collapsible
				open={isOpen}
				onOpenChange={(open) => {
					toolCardOpenState.set(row.rowId, open);
					if (open) setShouldRenderContent(true);
				}}
				className="w-full flex flex-col"
				data-zcode-tool-stream-animate="true"
			>
				{/* 摘要行（ToolSummaryRow.tsx canToggle 分支 + ToolLayout.tsx#L165-176）：图标刻意不转 */}
				<CollapsibleTrigger className="group/tool-summary inline-flex max-w-full cursor-pointer items-center gap-2 self-start text-left text-ui-base transition-colors">
					<span className="shrink-0 text-foreground-subtlest [&_svg]:text-foreground-subtlest">
						<Wrench className="size-3.5" />
					</span>
					<span
						className={`font-medium whitespace-nowrap shrink-0 ${isRunning ? "animated-gradient-text" : "text-foreground-subtlest"}`}
					>
						{row.name}
					</span>
					<span className={`min-w-0 flex max-w-full items-center gap-2 text-foreground-subtlest`}>
						<span
							className={`whitespace-nowrap ${isError ? "text-destructive" : isRunning ? "animated-gradient-text" : ""}`}
							title={isError ? "该工具执行出错（展开查看输出）" : undefined}
						>
							{statusLabel}
						</span>
					</span>
					<ChevronRight
						aria-hidden
						className={`shrink-0 text-foreground-subtlest transition-transform group-data-[state=open]/collapsible:rotate-90`}
					/>
				</CollapsibleTrigger>
				{shouldRenderContent && (
					// 展开体（ToolLayout.tsx#L24-25 + 锚 §2.b）：pt-2 内容壳 + pre font-mono text-ui-sm
					<CollapsibleContent className="text-popover-foreground outline-none">
						<div className="pt-2">
							<pre className="max-h-56 overflow-y-auto whitespace-pre-wrap break-all font-mono text-ui-sm text-foreground-subtle">
								{JSON.stringify(row.arguments, null, 2)}
							</pre>
							{row.output !== undefined && (
								<pre
									className={`mt-1 max-h-56 overflow-y-auto whitespace-pre-wrap break-all font-mono text-ui-sm ${
										isError ? "text-destructive" : "text-foreground-subtle"
									}`}
								>
									{row.output}
								</pre>
							)}
						</div>
					</CollapsibleContent>
				)}
			</Collapsible>
		</RowShell>
	);
}

/**
 * 行渲染（**memo**）：`applyTranscriptOp` 只替换真正变化的 row 对象（未变行保持同一引用），
 * 故按 `row` 引用 memo 后，一帧只重渲染变化的那一行。
 * 不加 memo 时（2026-10-20 前）每来一帧 200 行全部重渲染、每行重跑 markdown 渲染。
 */
const RowView = memo(function RowView({ row, animate }: { row: TranscriptRow; animate?: boolean }) {
	switch (row.kind) {
		case "turnHeader":
			return <TurnHeaderRowView row={row} animate={animate} />;
		case "userInput":
			return <UserInputRowView row={row} animate={animate} />;
		case "assistantText":
			return <AssistantTextRowView row={row} animate={animate} />;
		case "reasoning":
			return <ReasoningRowView row={row} animate={animate} />;
		case "toolCall":
			return <ToolCallRowView row={row} animate={animate} />;
	}
});

// ── 页面 ─────────────────────────────────────────────────────────

export function ChatPage() {
	const chatSessions = useGui((s) => s.chatSessions);
	const activeId = useGui((s) => s.chatActiveId);
	const rowsMap = useGui((s) => s.chatRowsBySession);
	const conn = useGui((s) => s.chatConn);
	const resyncKey = useGui((s) => s.chatResyncKey);
	const outboxMap = useGui((s) => s.chatOutbox);
	const [draft, setDraft] = useState("");
	const [dragging, setDragging] = useState(false);
	// GUI 图片输入 S4：输入框内的图片附件（Ctrl+V 粘贴 / 拖放 / 选择文件）
	const [attachments, setAttachments] = useState<AttachmentItem[]>([]);
	const [attachHint, setAttachHint] = useState<string | null>(null);
	const fileRef = useRef<HTMLInputElement | null>(null);
	// 本地预览 URL 释放（移除/卸载时）——防 memory leak；不在渲染期 revoke（会黑图）
	useEffect(() => {
		return () => {
			for (const a of attachments) URL.revokeObjectURL(a.previewUrl);
		};
		// 仅在卸载时清全部（逐张移除在 removeAttachment 里即时 revoke）
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

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
			// 0923 2003 C4：journal 全量事件流 + interactions 状态投影（服务端 ws.ts 已支持；
			// 首连 logEpoch 空 = bootstrap 全量重放，重连带 chatJournalHead 续传）
			const jh = st.chatJournalHead;
			subs.push(
				jh !== null
					? { type: "subscribe", topic: "journal", base: { seq: jh.seq, logEpoch: jh.logEpoch, ...(typeof jh.gen === "number" ? { gen: jh.gen } : {}) } }
					: { type: "subscribe", topic: "journal", base: { seq: 0, logEpoch: "" } },
			);
			subs.push({ type: "subscribe", topic: "interactions" });
			return subs;
		},
		onFrame: (f) => {
			void useGui.getState().applyChatFrame(f);
		},
		// 0923 2003 C3①：WS 断线重连后强制 resync——每次连接建立（含重连）触发 transcript
		// 重载：有 head 走 after= 增量补差，无 head 走全量（复用 store，不改其数据结构）
		onOpen: () => {
			const st = useGui.getState();
			if (st.chatActiveId !== null) void st.resyncChatSession(st.chatActiveId);
		},
	});
	useEffect(() => {
		useGui.getState().setChatConn(wsState);
	}, [wsState]);

	// 0923 2003 C3 回退策略：WS 断线期间 HTTP 兜底——chatConn!="open" 且有活跃会话时
	// 每 3s 全量 reloadChatSession（rowId 幂等 + seq 倒退防御保证双通道不重不漏）；
	// WS 恢复即停（onopen resync 接管增量）。
	usePoll(() => {
		const st = useGui.getState();
		if (st.chatConn !== "open" && st.chatActiveId !== null) {
			// D4：WS 非真断线（connecting/idle 均为切回瞬态）且行已在 store 缓存 → 跳过全量 GET
			//（每次切回白拉 1-6MB；WS open 后的 resync 增量接管补差）。真断线（"down"）保留 3s 兜底。
			const cached = st.chatRowsBySession[st.chatActiveId];
			if (st.chatConn !== "down" && cached !== undefined && cached.length > 0) return;
			void st.reloadChatSession(st.chatActiveId);
		}
	}, 3000);

	const rows = activeId !== null ? (rowsMap[activeId] ?? []) : [];
	// L2 perf（2026-10-20）：首屏只取最新 TAIL_FIRST 行 ⇒ 若还有更早的行，给一个「加载更早」入口
	const hasOlder = useGui((s) => (activeId !== null ? s.chatHasOlderBySession[activeId] === true : false));
	const tailWant = useGui((s) => (activeId !== null ? (s.chatTailBySession[activeId] ?? 200) : 200));
	// D4（plans/20260930_timeline_switch_latency_d4.md）：大 transcript 分块渲染——
	// 首屏只画尾部 200 行，贴底时分块补齐更早行。2-4k 行全量同步重挂载实测阻塞主线程
	// 2s+（真机 CDP 复现），分块后切回首帧 ~100ms。hiddenHead = 头部未渲染行数。
	const HISTORY_CHUNK = 200;
	const [hiddenHead, setHiddenHead] = useState(() => {
		const st = useGui.getState();
		const n = st.chatActiveId !== null ? (st.chatRowsBySession[st.chatActiveId]?.length ?? 0) : 0;
		return Math.max(0, n - HISTORY_CHUNK);
	});
	const visibleRows = hiddenHead > 0 ? rows.slice(hiddenHead) : rows;

	/**
	 * 入场动画只给「本次新增」的行（L2 perf，2026-10-20）。
	 *
	 * 事故形态：`data-zcode-stream-animate` 挂每一行 + CSS `will-change: opacity` ⇒ 首屏 200 行
	 * 一次性建 200 个合成层、并发 900ms 动画，实测点击会话后主线程长任务 93ms 且掉帧。
	 * 判定：首行 rowId 未变（同一会话）且行数变多 ⇒ 从上次行数起的新行才播动画；
	 * 换会话 / 加载更早（首行变了）⇒ 整批不打动画。
	 */
	const animRef = useRef<{ firstRowId: string | null; len: number }>({ firstRowId: null, len: 0 });
	let animateFromIndex = rows.length;
	{
		const prev = animRef.current;
		const first = rows[0]?.rowId ?? null;
		if (prev.firstRowId !== null && first === prev.firstRowId && rows.length > prev.len) animateFromIndex = prev.len;
	}
	useEffect(() => {
		animRef.current = { firstRowId: rows[0]?.rowId ?? null, len: rows.length };
	}, [rows]);
	// Master 禁输入标识 = /v1/sessions masterProtected flag（服务端权威；POST 403 是最后防线）。
	const activeSession = activeId !== null ? chatSessions.find((s) => s.sessionId === activeId) : undefined;
	const isMasterSession = activeSession?.masterProtected === true;
	// 2026-10-19：本地回显**退场**。
	// 用户的原始抱怨是「一条消息画了两遍，下面那条永远赖着」——上一条是 transcript 的
	// userInput（注入信封全文），下一条是本地的「已提交·等待注入」。
	// 现在 transcript 那条已折叠成正常气泡，本地那条只在**尚未注入**时才有价值
	// （它告知「已提交，正在排队」）。配对用 outboxId 确定性判等
	// （`outboxId = sha256("session.message:" + commandKey)`，与 message-outbox.ts 同口径）。
	// L4 S3：一次解析 transcript 建 Set（O(m)），再对每条 outbox 做 O(1) 查找。
	// 旧写法对每条 outbox 都全量解析 transcript ⇒ O(n×m×文本长)，长会话下不必要。
	const echoedIds = useMemo(
		() =>
			echoedOutboxIds(
				rows.filter((r) => r.kind === "userInput").map((r) => (r as Extract<TranscriptRow, { kind: "userInput" }>).text),
			),
		[rows],
	);
	const outboxEntries = useMemo(
		() =>
			Object.values(outboxMap)
				.filter((e) => e.sessionId === activeId)
				// 已出现在 transcript ⇒ 不必再画一条本地回显（按 outboxId 确定性配对）
				.filter((e) => !echoedIds.has(outboxIdForCommandKey(e.commandKey)))
				.sort((a, b) => a.at.localeCompare(b.at))
				.slice(-20),
		[outboxMap, activeId, echoedIds],
	);
	// 贴底锚定 + 回看锁定（原 S5 逻辑保留）：单 scroll handler 判 nearBottom（≤48px）；
	// 贴底→新内容自动锚定吸底；离开底部→锁定阅读位 + 浮出「回到底部」钮 + 消息层 mask 渐隐。
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const messageLayerRef = useRef<HTMLDivElement | null>(null);
	const [atBottom, setAtBottom] = useState(true);

	// D4：切会话 → 重新定初始裁剪（先于首帧生效）
	useEffect(() => {
		const st = useGui.getState();
		const n = st.chatActiveId !== null ? (st.chatRowsBySession[st.chatActiveId]?.length ?? 0) : 0;
		setHiddenHead(Math.max(0, n - HISTORY_CHUNK));
	}, [activeId]);
	// 全量 resync 可能缩短 transcript；夹紧裁剪游标，避免 slice 越界后旧的回看状态永久卡住。
	useEffect(() => {
		const maxHiddenHead = Math.max(0, rows.length - HISTORY_CHUNK);
		if (hiddenHead > maxHiddenHead) setHiddenHead(maxHiddenHead);
	}, [hiddenHead, rows.length]);
	// D4：贴底时分块补齐更早行（离开底部暂停，防阅读位跳动）
	useEffect(() => {
		if (hiddenHead === 0 || !atBottom) return;
		const id = window.setTimeout(() => setHiddenHead((h) => Math.max(0, h - HISTORY_CHUNK)), 0);
		return () => window.clearTimeout(id);
	}, [hiddenHead, atBottom]);

	const syncMask = (): void => {
		const el = scrollRef.current;
		const layer = messageLayerRef.current;
		if (el === null || layer === null) return;
		if (el.scrollHeight - el.scrollTop - el.clientHeight < 48) {
			// 贴底：消息在文档流末尾不经 sticky composer，保留 mask 会无意义淡出最后一条
			layer.style.maskImage = "none";
			layer.style.webkitMaskImage = "none";
			return;
		}
		const viewportHeight = el.clientHeight;
		const transparentStart = Math.max(0, viewportHeight - COMPOSER_MESSAGE_MASK_TRANSPARENT_HEIGHT_PX);
		const opaqueEnd = Math.max(0, transparentStart - COMPOSER_MESSAGE_MASK_FADE_PX);
		const viewportTopInLayer = Math.max(0, el.scrollTop - layer.offsetTop);
		const maskImage = `linear-gradient(to bottom, black 0, black ${opaqueEnd}px, transparent ${transparentStart}px, transparent 100%)`;
		layer.style.maskImage = maskImage;
		layer.style.webkitMaskImage = maskImage;
		layer.style.maskPosition = `0 ${viewportTopInLayer}px`;
		layer.style.webkitMaskPosition = `0 ${viewportTopInLayer}px`;
		layer.style.maskSize = `100% ${viewportHeight}px`;
		layer.style.webkitMaskSize = `100% ${viewportHeight}px`;
	};

	const handleScroll = (): void => {
		const el = scrollRef.current;
		if (el === null) return;
		setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 48);
		syncMask();
	};

	// 贴底锚定：仅在 atBottom 时跟随新行/回执滚动；回看（!atBottom）锁定阅读位
	// （dep 用 visibleRows：分块补齐也在贴底时重新吸底）
	useEffect(() => {
		const el = scrollRef.current;
		if (el !== null && atBottom) el.scrollTop = el.scrollHeight;
	}, [visibleRows, outboxEntries, atBottom]);

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

	// L3 窄路径：master 会话经本机受信通道可注入（服务端三证据门；离线回 409 master-offline）。
	const canSend = activeId !== null && canSendMessage(draft, attachments);

	/** 接收一批图片（粘贴/拖放/选择共用）：本地上预览 + 并行上传，逐条拒绝给理由。 */
	const acceptFiles = (files: FileListLike): void => {
		const candidates = candidatesFrom(files);
		if (candidates.length === 0) return;
		const { accept, rejected } = pickAttachments(attachments, candidates);
		setAttachHint(rejected.length > 0 ? rejected.map(rejectHint).join("；") : null);
		if (accept.length === 0) return;
		const items: AttachmentItem[] = accept.map(({ file, name }) => ({
			previewUrl: URL.createObjectURL(file as unknown as Blob),
			name,
			bytes: file.size,
			uploadId: null,
		}));
		setAttachments((prev) => [...prev, ...items]);
		// 上传（每张独立失败）：成功才填 uploadId；失败在缩略图上标错并允许删除重试
		items.forEach((item, i) => {
			void api.uploadImage(accept[i].file as unknown as Blob).then((r) => {
				setAttachments((prev) =>
					prev.map((a) =>
						a.previewUrl === item.previewUrl
							? r.ok
								? { ...a, uploadId: r.data.uploadId }
								: { ...a, uploadId: null, previewUrl: a.previewUrl, name: `${a.name}（上传失败）` }
							: a,
					),
				);
				if (!r.ok) setAttachHint(`上传失败（${r.status}）：${r.status === 413 ? "单张超过 5MiB，请压缩" : "请重试"}`);
			});
		});
	};

	const removeAttachment = (previewUrl: string): void => {
		URL.revokeObjectURL(previewUrl);
		setAttachments((prev) => prev.filter((a) => a.previewUrl !== previewUrl));
		setAttachHint(null);
	};

	const send = async (): Promise<void> => {
		const text = draft.trim();
		if (activeId === null || !canSendMessage(draft, attachments)) return;
		const ids = attachmentIds(attachments);
		setDraft("");
		for (const a of attachments) URL.revokeObjectURL(a.previewUrl);
		setAttachments([]);
		setAttachHint(null);
		await useGui.getState().sendChatMessage(activeId, text, ids.length > 0 ? ids : undefined);
	};

	return (
		<div className="flex h-full min-h-0 flex-col">
			{/* 会话容器（ConversationTimeline 样板）：@container/conversation 供行宽断点 */}
			<div className="@container/conversation relative flex min-h-0 flex-1 flex-col">
				{/* 滚动视口（ConversationTimeline.tsx#L1747-1757 class 照抄） */}
				<div
					ref={scrollRef}
					onScroll={handleScroll}
					className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]"
				>
					{/* 消息层（mask 渐隐作用面）+ 内容列宽（conversationLayout.ts#L7-12 照抄） */}
					<div
						ref={messageLayerRef}
						className="mx-auto flex w-full flex-col gap-4 px-4 py-4 @min-[864px]/conversation:w-[calc(100%_-_6rem)] @min-[864px]/conversation:max-w-4xl @min-[1280px]/conversation:w-[calc(100%_-_24rem)] @min-[1280px]/conversation:max-w-6xl"
					>
						{activeId === null ? (
							<div className="py-6 text-center text-ui-sm text-foreground-subtlest">从左栏选择一个会话</div>
						) : rows.length === 0 && outboxEntries.length === 0 ? (
							<div className="py-6 text-center text-ui-sm text-foreground-subtlest">
								该会话暂无可投影内容（或正在加载）
							</div>
						) : (
							<>
									{hasOlder && hiddenHead === 0 && (
										<div className="py-1 text-center">
											<button
											type="button"
											onClick={() => void useGui.getState().reloadChatSession(activeId!, tailWant * 2)}
											className="text-ui-xs text-foreground-subtle underline decoration-foreground-subtle decoration-dashed underline-offset-4 transition-colors hover:text-foreground"
											title="只读取更早的历史（首屏不一次拉全部）"
											>
											加载更早消息
											</button>
										</div>
									)}
								{hiddenHead > 0 && (
									<div className="py-1 text-center text-ui-xs text-foreground-subtlest">
										正在补齐较早消息（{hiddenHead} 条）…
									</div>
								)}
								{visibleRows.map((row, i) => (
									<RowView
										key={row.rowId}
										row={row}
										animate={hiddenHead + i >= animateFromIndex}
									/>
								))}
								{/* 2026-10-19 用户裁决：**不再画第二条气泡**。
								    只在「已发出但还没进 transcript」且非终态成功时给一行极简状态
								    （排队中/失败/被拒 才有价值；已进 transcript 的条目已被上面过滤掉）。 */}
								{outboxEntries.map((e) => (
									<OutboxStatusLine key={e.commandKey} e={e} />
								))}
							</>
						)}
					</div>
					{/* composer sticky dock（ConversationTimeline.tsx#L1911-1929 + ChatPromptEditor.tsx#L346-361） */}
					<div className="pointer-events-none sticky bottom-0 z-20 mt-auto flex w-full justify-center">
						<div className="pointer-events-auto relative z-10 w-full shrink-0 px-4 pb-4">
							{/* 回看锁定阅读位时浮出「回到底部」钮（#L1937-1944 位置口径） */}
							{!atBottom && activeId !== null && (
								<Button
									type="button"
									variant="secondary"
									size="sm"
									onClick={scrollToLatest}
									className="absolute bottom-full left-1/2 z-30 mb-2 -translate-x-1/2 rounded-full shadow-sm"
								>
									↓ 回到底部
								</Button>
							)}
							{/* 输入壳三态边框（hover / focus-within / 拖拽占位） */}
							<div
								onDragOver={(e) => {
									e.preventDefault();
									setDragging(true);
								}}
								onDragLeave={() => setDragging(false)}
								onDrop={(e) => {
									e.preventDefault();
									setDragging(false);
									// GUI 图片输入 S4：拖进来的图片走与粘贴同一条链（本地预览 + 上传）
									acceptFiles(e.dataTransfer?.files ?? null);
								}}
								className={`relative flex flex-col gap-3 overflow-hidden rounded-xl border border-input-border bg-input p-3 transition-colors hover:border-input-border-hover focus-within:!border-input-border-focused ${
									dragging ? "border-accent bg-input" : ""
								}`}
							>
								{dragging && (
									<div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-accent/15 backdrop-blur-sm">
										<div className="flex items-center gap-2 rounded-full border border-accent/40 bg-card px-4 py-2 text-ui-base text-foreground shadow-overlay">
											<span>松手即添加图片（png / jpeg / webp / gif，≤4 张）</span>
										</div>
									</div>
								)}
								{/* S4 缩略图行：粘贴/拖放/选择后的图片（可逐张删除；未传完不可发） */}
								{attachments.length > 0 && (
									<div className="flex flex-wrap items-start gap-2" data-composer-attachments="1">
										{attachments.map((a) => (
											<div key={a.previewUrl} className="group/thumb relative">
												<img
													src={a.previewUrl}
													alt={a.name}
													title={`${a.name}（${formatBytes(a.bytes)}）`}
													className="size-16 rounded-lg border border-border object-cover"
												/>
												{a.uploadId === null && (
													<span className="absolute inset-x-0 bottom-0 rounded-b-lg bg-card/85 text-center text-ui-xs text-foreground-subtle">上传中…</span>
												)}
												<button
													type="button"
													onClick={() => removeAttachment(a.previewUrl)}
													aria-label={`删除附件 ${a.name}`}
													title="删除这张图片"
													className="absolute -right-1.5 -top-1.5 rounded-full border border-border bg-card p-0.5 text-foreground-subtle opacity-0 transition-opacity hover:text-foreground group-hover/thumb:opacity-100 focus:opacity-100"
												>
													<X className="size-3" />
												</button>
											</div>
										))}
									</div>
								)}
								{attachHint !== null && (
									<p className="text-ui-sm text-foreground-subtle" role="status">{attachHint}</p>
								)}
								<textarea
									value={draft}
									onChange={(e) => setDraft(e.target.value)}
										onPaste={(e) => {
										// 粘贴决策（对齐 ZCode v4 composer：files+items 并集、Excel 文本优先）：
										// 旧实现只读 `clipboardData.files`，而微信/截图工具/跨应用复制图的场景下
										// files 为空、图只在 items 里 ⇒ 不拦截也不提示 = 静默失效（AGENTS R-2）。
										const plan = pickPastePlan(e.clipboardData as unknown as ClipboardLike);
										if (plan.preferText) {
											// 表格文本获胜（Excel 会同时给 text/html/合成 PNG）⇒ 放行给浏览器默认粘贴
											setAttachHint("检测到表格内容，已按文本粘贴（未作为图片附件）");
											return;
									}
										if (plan.files.length > 0) {
											e.preventDefault();
											acceptFiles(plan.files);
											return;
										}
										// 无图：默认走浏览器文本粘贴；但**超长必须接管**（L4 M2）。
										// 只靠 `maxLength` 让浏览器默默截断 = 静默丢失用户内容（AGENTS R-2）。
										// 这里自己 preventDefault 并按剩余容量插入，把丢弃量明确告知。
										const pastedText = e.clipboardData?.getData("text/plain") ?? "";
										const el = e.currentTarget;
										const res = applyOversizePaste(
											draft,
											el.selectionStart ?? draft.length,
											el.selectionEnd ?? draft.length,
											pastedText,
										);
										if (res.notice === null) return; // 未超限：放行默认粘贴
										e.preventDefault();
										setDraft(res.next);
										setAttachHint(res.notice);
									}}
									onKeyDown={(e) => {
										if (e.key === "Enter" && !e.shiftKey) {
											e.preventDefault();
											void send();
										}
									}}
									maxLength={8000}
									rows={Math.min(4, Math.max(1, draft.split("\n").length))}
									placeholder={
										activeId !== null
											? "输入消息发往该会话（Enter 发送，Shift+Enter 换行）"
											: "先选择会话"
									}
									disabled={activeId === null}
									className="max-h-32 w-full resize-none bg-transparent text-ui-base text-foreground outline-none placeholder:text-foreground-subtlest disabled:cursor-not-allowed disabled:opacity-50"
								/>
								{/* 工具栏行（ChatPromptEditor.tsx#L388-393）：左动作组 + 右主按钮组 */}
								<div className="group/toolbar flex items-end gap-3">
									<div className="flex min-w-0 flex-1 items-center">
										<div className="flex shrink-0 items-center gap-1">
											{/* S4：加号钮 = 选图入口（隐藏 file input；Ctrl+V 粘贴 / 拖放同样可用） */}
											<input
												ref={fileRef}
												type="file"
												accept="image/png,image/jpeg,image/webp,image/gif"
												multiple
												hidden
												onChange={(e) => {
													acceptFiles(e.target.files);
													e.target.value = ""; // 同一文件可重复选
												}}
											/>
											<Tooltip>
												<TooltipTrigger asChild>
													<Button
														type="button"
														variant="ghost"
														size="icon-md"
														aria-label="添加图片"
														disabled={activeId === null}
														onClick={() => fileRef.current?.click()}
													>
														<Plus className="size-4" />
													</Button>
												</TooltipTrigger>
												<TooltipContent>添加图片（也可直接 Ctrl+V 粘贴或拖进来；png / jpeg / webp / gif）</TooltipContent>
											</Tooltip>
											<ConnBadge conn={conn} />
										</div>
									</div>
										<div className="flex shrink-0 items-center gap-2">
											{isMasterSession && (
												// L3 窄路径：master 不再灰显；Master 会话拒绝远程输入（旧 403）已放宽为本机受信注入。
												// P2-9（2026-09-30）：非错误说明不用危险红常驻 → subtle 灰字 + 盾图标
												<p className="flex items-center gap-1 text-ui-sm text-foreground-subtle">
													<ShieldCheck className="size-3.5 shrink-0" />
													Master 会话拒绝远程输入已放宽：经本机受信通道注入（浏览器上下文被注入内容时等于驱动 master）
												</p>
											)}
											{/* Stop 钮灰显占位（无 interrupt 命令；zcode 口径 variant=secondary + Square fill-current） */}
											<Tooltip>
												<TooltipTrigger asChild>
													{/* 同上：仅让 Tooltip 可达，Stop 仍为 disabled 且无 interrupt 副作用。 */}
													<span className="inline-flex">
														<Button type="button" variant="secondary" size="icon-md" disabled aria-label="停止（未接入）">
															<Square className="size-4 fill-current" />
														</Button>
													</span>
												</TooltipTrigger>
												<TooltipContent>未接入（无 interrupt 命令）</TooltipContent>
											</Tooltip>
											{/* 发送钮（ConversationComposer.tsx#L2082-2095 整条 class） */}
											<Button
												type="submit"
												size="icon-md"
												disabled={!canSend}
												onClick={() => void send()}
												aria-label="发送"
												className="cursor-pointer gap-1 rounded-lg bg-accent text-ui-base text-accent-foreground hover:bg-accent-hover"
											>
												<ArrowUp className="size-4" />
											</Button>
										</div>
								</div>
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

// ── G6-P2：发送两段回执状态（OUTBOX_STATUS 文案沿用；换 user 气泡 + 状态行壳）─────

const OUTBOX_STATUS: Record<ChatOutboxEntry["status"], { label: string; destructive?: boolean }> = {
	sending: { label: "发送中" },
	pending: { label: "已提交·等待注入" },
	delivered: { label: "已送达" },
	failed: { label: "失败", destructive: true },
	expired: { label: "已过期（24h 未投递）" },
	rejected: { label: "被拒绝", destructive: true },
};

/**
 * 极简发送状态行（2026-10-19 用户裁决：**不要再来一条「已提交·等待注入」气泡**）。
 *
 * 旧实现画的是完整 user 气泡 + 状态标签 ⇒ 与 transcript 那条视觉重复，
 * 用户原话：「会一直排在 GUI 的最下边一条，这是一个重大的用户体验缺陷」。
 *
 * 现在：不画气泡、不复述正文，只在真有必要时给一行小字：
 *   - `sending`   → 发送中
 *   - `pending`   → 排队中（还没进 transcript）
 *   - 失败/过期/被拒 → 红字 + 原因（这些**必须**可见，否则是静默失败，AGENTS R-2）
 *   - `delivered` → **什么都不显示**（transcript 已有那条，多了就是噪音）
 */
function OutboxStatusLine({ e }: { e: ChatOutboxEntry }) {
	if (e.status === "delivered") return null; // 已送达且进 transcript ⇒ 静默
	const s = OUTBOX_STATUS[e.status];
	return (
		<div
			className={`text-right text-ui-xs ${s.destructive ? "text-destructive" : "text-foreground-subtlest"}`}
			title={e.detail ?? s.label}
			aria-live="polite"
		>
			{s.label}
		</div>
	);
}

function ConnBadge({ conn }: { conn: string }) {
	if (conn === "open") return <Badge variant="secondary" title="WS 已连接（增量推送）">实时</Badge>;
	if (conn === "connecting") return <Badge variant="secondary">连接中</Badge>;
	if (conn === "down") return <Badge variant="destructive" title="WS 断开，自动重连中（重连带 seq 续传）">重连中</Badge>;
	return <Badge variant="secondary">未接入</Badge>;
}
