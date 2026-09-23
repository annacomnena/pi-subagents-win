/**
 * gui/src/pages/ChatPage.tsx — 中央 transcript + composer（ZCode 1:1 复刻 第 5/6 步）。
 *
 * - 行型映射（拍板 5）：我方 5 种 TranscriptRow → zcode 行型（class 串照抄锚 §2.b）：
 *   turnHeader→调试 turn header 行；userInput→右对齐气泡（rounded-tr-xs 缺角必抄）；
 *   assistantText→行式纯文本 whitespace-pre-wrap；reasoning→Collapsible 默认收起；
 *   toolCall→Collapsible 单行卡（运行中=animated-gradient-text 扫光≈流式；无光标字符）。
 * - composer（拍板 6）：rounded-2xl border-input-border bg-input p-3 三态边框 + 发送钮
 *   icon-md bg-brand ArrowUp；加号钮与 Stop 钮灰显占位（无后端，Tooltip「未接入」）。
 * - 数据面零改动：GET transcript 首屏 + WS 增量（useEventStream）+ sendChatMessage
 *   （P2 session.message POST + outbox 两段回执，OUTBOX_STATUS 文案沿用）。
 * - 滚动：视口 [scrollbar-gutter:stable]；贴底锚定/回看锁定保留现逻辑；回看 mask 渐隐
 *   （ConversationTimeline.tsx#L882-909 公式，FADE=24 / TRANSPARENT=96）+ 回到底部浮钮。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, ChevronRight, Plus, Square, Wrench } from "lucide-react";
import { useGui } from "../store";
import { streamUrl, useEventStream } from "../useEventStream";
import { RelTime } from "../ui";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import type { ChatOutboxEntry, TranscriptRow } from "../api/types";
import type { StreamSubscribeMsg } from "../api/types";

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
	children,
}: {
	rowId: string;
	className?: string;
	children: React.ReactNode;
}) {
	return (
		<div data-row-id={rowId} data-zcode-stream-animate="true" className={className}>
			{children}
		</div>
	);
}

// ── 5 种行 → zcode 行型 ───────────────────────────────────────────

/** 调试 turn header 行（ConversationRowView.tsx#L1622-1628）。 */
function TurnHeaderRowView({ row }: { row: Extract<TranscriptRow, { kind: "turnHeader" }> }) {
	return (
		<RowShell
			rowId={row.rowId}
			className="border-b border-[var(--color-border)] py-1 text-ui-sm text-[var(--color-foreground-subtle)]"
		>
			对话轮 {row.turnIndex} · <RelTime at={row.startedAt} />
			{row.durationMs !== undefined ? ` · ${fmtDuration(row.durationMs)}` : " · 进行中"}
		</RowShell>
	);
}

/** user 右对齐气泡全套（#L1190,1252-1270）：rounded-tr-xs 缺角必抄。 */
function UserInputRowView({ row }: { row: Extract<TranscriptRow, { kind: "userInput" }> }) {
	return (
		<RowShell rowId={row.rowId} className="group/user-row flex flex-col items-end">
			<div className="flex max-w-full flex-col gap-2 rounded-xl rounded-tr-xs border border-border bg-surface px-4 py-3 text-ui-base text-foreground @min-[624px]/conversation:max-w-xl">
				<div className="whitespace-pre-wrap">
					{row.text.length > 0 ? row.text : <span className="text-foreground-subtlest">（非文本输入）</span>}
				</div>
			</div>
		</RowShell>
	);
}

/** assistant 行式正文（#L1512,1518）：纯文本 whitespace-pre-wrap（拍板 1 白名单）+ 注脚。 */
function AssistantTextRowView({ row }: { row: Extract<TranscriptRow, { kind: "assistantText" }> }) {
	return (
		<RowShell rowId={row.rowId} className="group/assistant-row">
			<div className="w-full text-ui-base">
				<div className="whitespace-pre-wrap">{row.text}</div>
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
function ReasoningRowView({ row }: { row: Extract<TranscriptRow, { kind: "reasoning" }> }) {
	return (
		<RowShell rowId={row.rowId}>
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
						<div className="whitespace-pre-wrap">{row.text}</div>
					</div>
				</CollapsibleContent>
			</Collapsible>
		</RowShell>
	);
}

// ── toolCall：Collapsible 单行卡（ToolLayout 交互样板的最小移植）──────────────
// 展开态按 rowId 存内存 Map 持久（ToolLayout.tsx#L44-46）；收起延迟卸载 300ms（#L26）。

const toolCardOpenState = new Map<string, boolean>();

function ToolCallRowView({ row }: { row: Extract<TranscriptRow, { kind: "toolCall" }> }) {
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
		<RowShell rowId={row.rowId} className="py-0">
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
				<CollapsibleTrigger className="group/tool-summary inline-flex max-w-full cursor-pointer items-center gap-2 self-start text-left text-ui-base transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused">
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
	const [dragging, setDragging] = useState(false);

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
	// Master 禁输入标识 = /v1/sessions masterProtected flag（服务端权威；POST 403 是最后防线）。
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
	// 贴底锚定 + 回看锁定（原 S5 逻辑保留）：单 scroll handler 判 nearBottom（≤48px）；
	// 贴底→新内容自动锚定吸底；离开底部→锁定阅读位 + 浮出「回到底部」钮 + 消息层 mask 渐隐。
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const messageLayerRef = useRef<HTMLDivElement | null>(null);
	const [atBottom, setAtBottom] = useState(true);

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

	// L3 窄路径：master 会话经本机受信通道可注入（服务端三证据门；离线回 409 master-offline）。
	const canSend = activeId !== null && draft.trim().length > 0;

	const send = async (): Promise<void> => {
		const text = draft.trim();
		if (text.length === 0 || activeId === null) return;
		setDraft("");
		await useGui.getState().sendChatMessage(activeId, text);
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
								{rows.map((row) => (
									<RowView key={row.rowId} row={row} />
								))}
								{/* 发送两段回执：挂 user 气泡下的状态行（mt-1 text-right text-ui-sm） */}
								{outboxEntries.map((e) => (
									<OutboxRowView key={e.commandKey} e={e} />
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
									setDragging(false); // 附件拖放无后端：占位高亮，落点不接收
								}}
								className={`relative flex flex-col gap-3 overflow-hidden rounded-2xl border border-input-border bg-input p-3 transition-colors hover:border-input-border-hover focus-within:!border-input-border-focused focus-within:bg-input-focused ${
									dragging ? "border-brand bg-input-focused ring-1 ring-brand/30" : ""
								}`}
							>
								{dragging && (
									<div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-accent/55 backdrop-blur-sm">
										<div className="flex items-center gap-2 rounded-full border border-border bg-accent px-4 py-2 text-ui-base text-foreground shadow-sm">
											<span>附件拖放未接入</span>
										</div>
									</div>
								)}
								<textarea
									value={draft}
									onChange={(e) => setDraft(e.target.value)}
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
											{/* 加号钮灰显占位（拍板 1：保工具栏骨架 1:1） */}
											<Tooltip>
												<TooltipTrigger asChild>
													{/* disabled 原生 button 不派发 hover；包裹层只承接 Tooltip，不接任何动作。 */}
													<span className="inline-flex">
														<Button type="button" variant="ghost" size="icon-md" disabled aria-label="附件与命令（未接入）">
															<Plus className="size-4" />
														</Button>
													</span>
												</TooltipTrigger>
												<TooltipContent>未接入（附件 / mention / slash 面板无后端）</TooltipContent>
											</Tooltip>
											<ConnBadge conn={conn} />
										</div>
									</div>
										<div className="flex shrink-0 items-center gap-2">
											{isMasterSession && (
												// L3 窄路径：master 不再灰显；Master 会话拒绝远程输入（旧 403）已放宽为本机受信注入。
												<p className="text-ui-sm text-destructive">Master 会话拒绝远程输入已放宽：经本机受信通道注入（浏览器上下文被注入内容时等于驱动 master）</p>
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
												className="cursor-pointer gap-1 rounded-lg bg-brand text-ui-base text-foreground-inverse hover:bg-brand/80"
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

function OutboxRowView({ e }: { e: ChatOutboxEntry }) {
	const s = OUTBOX_STATUS[e.status];
	return (
		<div className="group/user-row flex flex-col items-end">
			<div className="flex max-w-full flex-col gap-2 rounded-xl rounded-tr-xs border border-border bg-surface px-4 py-3 text-ui-base text-foreground @min-[624px]/conversation:max-w-xl">
				<div className="whitespace-pre-wrap">{e.text}</div>
			</div>
			<div
				className={`mt-1 text-right text-ui-sm ${s.destructive ? "text-destructive" : "text-foreground-subtlest"}`}
				title={e.detail ?? s.label}
				aria-live="polite"
			>
				{s.label}
			</div>
		</div>
	);
}

function ConnBadge({ conn }: { conn: string }) {
	if (conn === "open") return <Badge variant="secondary" title="WS 已连接（增量推送）">实时</Badge>;
	if (conn === "connecting") return <Badge variant="secondary">连接中</Badge>;
	if (conn === "down") return <Badge variant="destructive" title="WS 断开，自动重连中（重连带 seq 续传）">重连中</Badge>;
	return <Badge variant="secondary">未接入</Badge>;
}
