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

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { autoExpandTarget } from "../chatAutoExpand";
import { planTurnCollapse, type TurnSummary } from "../turnCollapse";
import {
	applyCommandSelection,
	filterCommands,
	moveIndex,
	parseSlashDraft,
	slashKeyAction,
	sourceHint,
} from "../slashCommands";
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
import type { ChatOutboxEntry, StreamingSnapshot, TranscriptRow } from "../api/types";
import type { StreamSubscribeMsg } from "../api/types";
import { api } from "../api/client";
import { deltaLabel, isWriteTool, readWriteArgs, splitPath } from "../writeCard";
import { WriteCardBody, WriteCheck } from "./WriteCard";
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
	attrs,
	children,
}: {
	rowId: string;
	className?: string;
	/** 是否播放入场动画（只给「本次新增」的行；整批历史不打，见 ChatPage 的 animateFromIndex）。 */
	animate?: boolean;
	/** 额外 data-* 属性（诊断用；不参与样式）。 */
	attrs?: Record<string, string>;
	children: React.ReactNode;
}) {
	return (
		<div
			data-row-id={rowId}
			{...attrs}
			{...(animate === true ? { "data-zcode-stream-animate": "true" } : {})}
			className={className}
		>
			{children}
		</div>
	);
}

// ── 5 种行 → zcode 行型 ───────────────────────────────────────────

/** 调试 turn header 行（ConversationRowView.tsx#L1622-1628）。 */
/**
 * turn header 行（2026-10-21 起兼任「本轮工作过程」的折叠摘要线）。
 *
 * - `summary === null` ⇒ 本轮不可折叠（正在跑 / 纯文字轮 / 收尾不是文字）：原样显示，
 *   口径与 0923 复刻一致（`对话轮 N · 相对时间 · 时长|进行中`）。
 * - `summary !== null` ⇒ 本轮已结束且过程可折叠：渲染成可点的一行摘要
 *   `已完成 45.2s · 6 步 ⌄`，点一下展开/收起被折叠的思考与工具卡。
 *   「对话轮 N」在摘要态**不显示** —— 那是调试信息，摘要线的用途是快速跳过过程。
 *
 * chevron 用 `open` 直接给类名（不用 `group-data-[state=open]/collapsible:`）：
 * 这一行不在 Radix Collapsible 里，套那套选择器会永远不旋转（见 _test_chat_collapse_state ⑤）。
 */
function TurnHeaderRowView({
	row,
	animate,
	summary,
	onToggle,
}: {
	row: Extract<TranscriptRow, { kind: "turnHeader" }>;
	animate?: boolean;
	/** null/undefined = 不可折叠（原样显示）。 */
	summary?: TurnSummary | null;
	onToggle?: () => void;
}) {
	const dur = summary?.durationMs ?? row.durationMs ?? null;
	return (
		<RowShell
			animate={animate}
			rowId={row.rowId}
			/**
			 * 诊断属性（2026-10-21 用户报「感觉没生效」）：让「这一轮到底判成了什么」能在
			 * DevTools 里一行查出来，而不是靠肉眼猜 ——
			 * `document.querySelectorAll('[data-turn-summary="collapsed"]').length`
			 * none = 不可折叠（正在跑 / 纯文字轮 / 收尾不是文字），collapsed / expanded = 可折叠。
			 */
			attrs={{
				"data-turn-summary": summary === null || summary === undefined ? "none" : summary.expanded ? "expanded" : "collapsed",
				...(summary === null || summary === undefined
					? {}
					: { "data-turn-hidden-rows": String(summary.rows), "data-turn-steps": String(summary.steps) }),
			}}
			className="border-b border-[var(--color-border)] py-1 text-ui-sm text-[var(--color-foreground-subtle)]"
		>
			{summary === null || summary === undefined ? (
				<>
					对话轮 {row.turnIndex} · <RelTime at={row.startedAt} />
					{row.durationMs !== undefined ? ` · ${fmtDuration(row.durationMs)}` : " · 进行中"}
				</>
			) : (
				<button
					type="button"
					onClick={onToggle}
					aria-expanded={summary.expanded}
					title={summary.expanded ? "收起这一轮的工作过程" : "展开这一轮的工作过程（思考 / 工具调用）"}
					className="group/turn inline-flex max-w-full cursor-pointer items-center gap-1.5 text-left text-foreground-subtlest transition-colors hover:text-foreground-subtle"
				>
					<ChevronRight
						className={`size-3.5 shrink-0 transition-transform ${summary.expanded ? "rotate-90" : ""}`}
					/>
					<span>已完成{dur !== null ? ` ${fmtDuration(dur)}` : ""}</span>
					<span className="opacity-60">·</span>
					<span>{summary.steps} 步</span>
					{summary.expanded ? null : <span className="opacity-60">· 点击展开</span>}
				</button>
			)}
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

	/**
	 * reasoning 折叠块：默认收起（streaming/complete 都收起 = zcode Reasoning 口径）。
	 *
	 * 2026-10-20 修「思考展不开」：原实现用 Radix 的**非受控** state。`RowView` 加了 `memo` 之后，
	 * 行列表一旦重新切片（`hiddenHead` 分块渲染 / 回看滚动），行会**卸载再挂载** ⇒ 非受控 state
	 * 随之丢失 ⇒ 点开的思考又变回收起，观感就是「点不开」。
	 * 改为「本地 state + 模块级 Map 持久」（与 toolCall 卡同一范式）：
	 *   - 本地 state 保证点击立刻重渲染（不依赖父级 re-render）；
	 *   - Map 保证卸载重挂后展开态还在。
	 */
function ReasoningRowView({ row, animate, streaming }: { row: Extract<TranscriptRow, { kind: "reasoning" }>; animate?: boolean; streaming?: boolean }) {
	const [open, setOpen] = useState<boolean>(() => reasoningOpenState.get(row.rowId) ?? false);
	/** 用户手动点过 → 锁定，不再被自动逻辑抢回（自动只做「默认行为」）。 */
	const userLockedRef = useRef(false);
	/**
	 * 自动展开/合上（2026-10-20 用户要求「当前执行的思考自动展开，完毕自动合上」）。
	 * 判定由父级给：`streaming` = 本行是「当前流式目标 / 刚结束的收尾窗口」。
	 * 用户一旦手动操作过（userLockedRef），自动逻辑永久让位。
	 *
	 * ⚠️ 2026-10-20 修复（用户报「思考没能自动折叠」）：`wasRunning` 原来传的是
	 * `streaming === true`，与 `isRunning` 同值 ⇒ 流式一结束两者同时变 false ⇒
	 * 纯函数返回 null（不动）⇒ **展开后永远不合**。
	 * 正确做法与工具卡一致：用 ref 记住「本行曾经被自动展开过」，结束后才能合上。
	 */
	const wasStreamingRef = useRef(streaming === true);
	useEffect(() => {
		const nowStreaming = streaming === true;
		if (nowStreaming) wasStreamingRef.current = true;
		const want = autoExpandTarget({
			isRunning: nowStreaming,
			wasRunning: wasStreamingRef.current,
			userLocked: userLockedRef.current,
		});
		if (want === null) return;
		if (want !== open) {
			reasoningOpenState.set(row.rowId, want);
			setOpen(want);
		}
		// open 故意不进依赖：只在 streaming 变化时决策，避免与用户点击互相拉扯
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [streaming, row.rowId]);
	return (
		<RowShell rowId={row.rowId} animate={animate}>
			<Collapsible
				open={open}
				onOpenChange={(next) => {
					userLockedRef.current = true; // 用户手动操作 ⇒ 自动逻辑让位
					reasoningOpenState.set(row.rowId, next);
					setOpen(next);
				}}
				className="w-full"
			>
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
const reasoningOpenState = new Map<string, boolean>();

function ToolCallRowView({ row, animate }: { row: Extract<TranscriptRow, { kind: "toolCall" }>; animate?: boolean }) {
	/**
	 * 展开态：本地 state 为**渲染真相**，模块 Map 只做「卸载重挂后恢复」的持久层。
	 *
	 * 2026-10-20 修「工具调用合不上」：原来直接 `const isOpen = toolCardOpenState.get(...)`，
	 * 而 `onOpenChange` 只在 `open === true` 时 setState ⇒ **关闭时没有任何 re-render**。
	 * 加 `memo` 之前靠父级每 2-6s 的轮询重渲染「顺带」刷回来（观感是慢），加 `memo` 之后
	 * 父级不再重渲染 ⇒ 永久停在展开态。实测：点开后 h=102，再点 600ms/2.1s 后仍是 open。
	 */
	const [open, setOpen] = useState<boolean>(() => toolCardOpenState.get(row.rowId) ?? false);
	/** 用户手动点过 → 锁定，不再被自动逻辑抢回。 */
	const userLockedRef = useRef(false);
	/**
	 * 自动展开/合上（2026-10-20 用户要求「当前执行的工具调用自动展开，完毕自动合上」）。
	 *
	 * 只在「本行**经历过** running」时才自动合上 —— 否则会把用户之前手动展开的历史卡片也一起合掉。
	 * 用户一旦手动操作过，自动逻辑永久让位。
	 */
	const wasRunningRef = useRef(row.status === "running");
	useEffect(() => {
		const isRunningNow = row.status === "running";
		if (isRunningNow) wasRunningRef.current = true;
		const want = autoExpandTarget({
			isRunning: isRunningNow,
			wasRunning: wasRunningRef.current,
			userLocked: userLockedRef.current,
		});
		if (want === null) return;
		if (want !== open) {
			toolCardOpenState.set(row.rowId, want);
			setOpen(want);
			if (want) setShouldRenderContent(true);
		}
		// open 故意不进依赖：只在 status 变化时决策，避免与用户点击互相拉扯
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [row.status, row.rowId]);
	// shouldRenderContent：收起后延迟 300ms 再卸载展开体（Radix closed 动画要读高度变量）
	const [shouldRenderContent, setShouldRenderContent] = useState(open);
	const unmountDelayRef = useRef<number | null>(null);

	useEffect(() => {
		if (open) {
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
	}, [open, shouldRenderContent]);

	const isRunning = row.status === "running";
	const isError = row.status === "error";
	const statusLabel = isRunning ? "执行中" : isError ? "出错" : "完成";
	/**
	 * write 专属：正文换成「落笔」迷你编辑器（设计稿 plans/20261021_write_card/design.md）。
	 * 判据只有工具名 —— 其余工具**完全走原路径**（原 pre + JSON.stringify），零回归面。
	 */
	const isWrite = isWriteTool(row.name);
	const write = isWrite ? readWriteArgs(row.arguments) : null;
	const writePath = write && write.path !== "" ? splitPath(write.path) : null;
	/**
	 * 收笔动画（勾描边 + 徽标弹）只播**一次**：running → 终态那一拍开 700ms。
	 * 不能只靠 CSS `[data-status="done"]` —— 历史卡片一挂载也会播，一屏几十张卡同时弹一下是噪音。
	 */
	const [settling, setSettling] = useState(false);
	useEffect(() => {
		if (row.status === "running") {
			setSettling(false);
			return;
		}
		if (!wasRunningRef.current) return;
		setSettling(true);
		const t = window.setTimeout(() => setSettling(false), 700);
		return () => window.clearTimeout(t);
	}, [row.status]);

	return (
		<RowShell rowId={row.rowId} animate={animate} className="py-0">
			<Collapsible
				open={open}
				onOpenChange={(next) => {
					userLockedRef.current = true; // 用户手动操作 ⇒ 自动逻辑让位
					toolCardOpenState.set(row.rowId, next);
					setOpen(next); // 关键：关闭也必须触发重渲染（否则受控 open 永远停在上一次的值）
					if (next) setShouldRenderContent(true);
				}}
				className="w-full flex flex-col"
				data-zcode-tool-stream-animate="true"
			>
				{/* 摘要行（ToolSummaryRow.tsx canToggle 分支 + ToolLayout.tsx#L165-176）：图标刻意不转 */}
				<CollapsibleTrigger
					className={`group/tool-summary inline-flex max-w-full cursor-pointer items-center gap-2 self-start text-left text-ui-base transition-colors${
						isWrite ? " w-full" : ""
					}`}
				>
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
					{/* 写完的勾：只在「刚写完」那一拍描边画出 */}
					{isWrite && !isRunning && !isError && <WriteCheck drawing={settling} />}
					{isWrite && write && (
						<span className="write-meta">
							{writePath && (
								<span className="write-path" title={write.path}>
									{writePath.parent ? `…/${writePath.parent}/` : ""}
									<b>{writePath.name}</b>
								</span>
							)}
							<span
								className={`write-delta${settling ? " is-settling" : ""}`}
								data-status={row.status}
								title={write.path || undefined}
							>
								<span className="write-dot" />
								{deltaLabel(write.content, row.status)}
							</span>
						</span>
					)}
					<ChevronRight
						aria-hidden
						className={`shrink-0 text-foreground-subtlest transition-transform group-data-[state=open]/collapsible:rotate-90`}
					/>
				</CollapsibleTrigger>
				{shouldRenderContent && (
					// 展开体（ToolLayout.tsx#L24-25 + 锚 §2.b）：pt-2 内容壳 + pre font-mono text-ui-sm
					<CollapsibleContent className="text-popover-foreground outline-none">
						{write ? (
							// write：落笔迷你编辑器（行号 + 逐行 + 墨线 + 收笔扫光）
							<WriteCardBody content={write.content} status={row.status} output={row.output} />
						) : (
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
						)}
					</CollapsibleContent>
				)}
			</Collapsible>
		</RowShell>
	);
}

	/**
	 * 增量入场的强度（**按这一块的自身字数**自适应，2026-10-21 第二轮）。
	 *
	 * 为什么不能固定 3px / 55%：GUI 每 200ms 只取一拍（`usePoll` 固定档 + busy 门会让
	 * 上一拍未完成时掉拍，标签页切回来还会一次补一大块），所以**一拍里塞多少字完全由
	 * 模型 tps 决定**：150ms 写一次快照、200ms 读一次 ⇒
	 * tps 10 → 2 字/拍；50 → 10 字；100 → 20 字；**200 → 约 40 字（≈ 一整行）**；
	 * 掉拍到 400ms → 80 字（两行）。
	 * `filter: blur()` 是**按元素**生效的 ⇒ 一次渲染 40 字且不切片时，是「整行一起虚化」，
	 * 观感不是「新字浮现」而是「一行糊了一下」。所以：
	 *
	 * 1. 超过 {@link CHUNK_SLICE_AT} 字先**切片**（每片 {@link CHUNK_SLICE_SIZE} 字）——
	 *    切片之后每一片只有 12 字，模糊自然回到小块的档位，不会糊整行；
	 * 2. 强度按**渲染块自己的字数**给（切片时按片长算），只对 7–32 字的单块做轻微收敛，
	 *    避免「一口气 30 多字」那种中等跳变还是糊成一片。
	 *
	 * 时长没有跟着变短：必须 ≥ 200ms 轮询间隔，否则相邻两拍之间会出现「动画已结束、
	 * 下一拍还没到」的空档，反而有节拍感（这是当初取 220ms 的原因）。
	 */
	function chunkIntensity(n: number): CSSProperties {
		if (n <= 6) return {};
		const over = n - 6;
		return {
			"--stream-chunk-blur": `${Math.max(0.9, 3 * Math.exp(-over / 30)).toFixed(2)}px`,
			"--stream-chunk-tint": `${Math.round(Math.max(28, 55 - over * 0.8))}%`,
		} as unknown as CSSProperties;
	}

	/** 一拍超过这个字数就切片：单块 32 字以上淡入已经像「糊一片」，切片才有「往下写」的走向。 */
	const CHUNK_SLICE_AT = 32;
	/** 每片码点数。12 字 ≈ 一行 1/4，模糊只作用在这一小段上。 */
	const CHUNK_SLICE_SIZE = 12;
	/** 切片整条的错峰总时长上限：必须 < 200ms 轮询间隔，否则波还没走完下一拍就来了。 */
	const CHUNK_SLICE_SPREAD_MS = 120;
	/** 单片最大间隔：太快看不出走向，太慢整条拖长。 */
	const CHUNK_SLICE_STAGGER_MAX_MS = 12;
	/** 超大 delta（标签页切回来、网络卡了几拍）不切片：避免一次插几百个节点。 */
	const CHUNK_SLICE_MAX = 400;

	/**
	 * 按**码点**切片（不是 `slice()` 按 UTF-16 码元）：`slice()` 会把代理对/emoji 从中间
	 * 劈开，切成两半的半个字符会短暂渲染成豆腐块。
	 */
	function sliceChunk(text: string, size: number): string[] {
		const cps = Array.from(text);
		const out: string[] = [];
		for (let i = 0; i < cps.length; i += size) out.push(cps.slice(i, i + size).join(""));
		return out;
	}

	/**
	 * 流式临时块（2026-10-20；入场动效 2026-10-21）。
	 *
	 * 数据来自 pi 扩展节流覆盖写的快照（150ms ≈ 6.7 次/秒），GUI 200ms 拉一次。
	 * 它只是**预览**：`message_end` 后快照消失，正式行从 transcript 投影进来替换。
	 *
	 * 动效（用户要求「渐变出现」）：把「已显示前缀」与「刚到的增量」拆成两个节点，
	 * **只给增量**挂 220ms 入场（透明→实 + 模糊→清晰 + 暖陶土→正文墨色），前缀完全不动。
	 * 旧实现是整段跳变 + 一个呼吸方块光标 ⇒ 新增的 6–18 字是「啪」地贴上去的。
	 * 一拍超过 {@link CHUNK_SLICE_AT} 字时再切片错峰，让大块也「往下写」而不是整块糊。
	 *
	 * ⚠️ 为什么不用 mask 扫光做「渐变擦入」（看着更像渐变，实测不行）：
	 * `plans/20261021_stream_anim/masktest.html` 用无头 Chrome 冻结帧实测 —— Chromium 对
	 * **会折行的 inline span** 的 mask 几何不可控：冻结在动画 18%（期望只露出约三成）时，
	 * 增量已经基本全显，只有最右一两个字有淡出 ⇒ 擦入前沿根本看不见。改用
	 * `inline-block` 才能可控，但那会把「跟着前缀续写」变成**另起一行**（同页已复现）。
	 * 所以走 opacity+blur：合成层动画，折行不重排（同页实测两行位置不动）。
	 *
	 * 字号/墨色与**正式行对齐**（顺手修掉一个跳变）：正文预览 = text-ui-base/foreground
	 * （同 `AssistantTextRowView`）、思考预览 = text-ui-sm/foreground-subtle（同 `ReasoningRowView`）。
	 * 旧实现两者都按 12px/subtle 画 ⇒ `message_end` 正式行替换进来时，字号与墨色一起跳。
	 */
	function StreamingPreview({ snap }: { snap: StreamingSnapshot }) {
		const isReasoning = snap.kind === "reasoning";
		const appendFrom = snap.appendFrom ?? 0;
		const prefix = appendFrom > 0 ? snap.text.slice(0, appendFrom) : "";
		const delta = snap.text.slice(appendFrom);
		const rev = snap.rev ?? 0;
		const slices =
			delta.length > CHUNK_SLICE_AT && delta.length <= CHUNK_SLICE_MAX ? sliceChunk(delta, CHUNK_SLICE_SIZE) : null;
		// 强度按**渲染块自身**字数算：切片后每片 12 字 ⇒ 模糊只作用在 12 字上，不会糊整行
		const intensity = chunkIntensity(slices === null ? delta.length : CHUNK_SLICE_SIZE);
		// 错峰间隔随片数收敛：整条波必须在 200ms 内走完（否则下一拍到了它还在走）
		const stagger =
			slices === null
				? 0
				: Math.max(4, Math.min(CHUNK_SLICE_STAGGER_MAX_MS, Math.floor(CHUNK_SLICE_SPREAD_MS / slices.length)));
		return (
			<div
				data-row-id="__streaming_preview__"
				data-streaming-preview="1"
				data-streaming-kind={snap.kind}
				className="py-1"
			>
				<div className="mb-1 flex items-center gap-2 text-ui-xs text-foreground-subtlest">
					<span className="inline-block size-1.5 animate-pulse rounded-full bg-accent" />
					<span>{isReasoning ? "正在思考…" : "正在输出…"}</span>
				</div>
				<div className={`whitespace-pre-wrap ${isReasoning ? "text-ui-sm text-foreground-subtle" : "text-ui-base text-foreground"}`}>
					{prefix}
					{/* key 换 = 重放入场动画；文本没变时 store 不 bump rev ⇒ 不会反复淡入 */}
					{slices === null
						? delta.length > 0 && (
								<span key={rev} className="stream-chunk-in" style={intensity}>
									{delta}
								</span>
							)
						: slices.map((s, i) => (
								<span
									key={`${rev}-${i}`}
									className="stream-chunk-in"
									style={{ ...intensity, animationDelay: `${i * stagger}ms` }}
								>
									{s}
								</span>
							))}
					<span className="stream-caret" aria-hidden />
				</div>
			</div>
		);
	}

/**
 * 行渲染（**memo**）：`applyTranscriptOp` 只替换真正变化的 row 对象（未变行保持同一引用），
 * 故按 `row` 引用 memo 后，一帧只重渲染变化的那一行。
 * 不加 memo 时（2026-10-20 前）每来一帧 200 行全部重渲染、每行重跑 markdown 渲染。
 */
const RowView = memo(function RowView({ row, animate, streaming }: { row: TranscriptRow; animate?: boolean; streaming?: boolean }) {
	switch (row.kind) {
		case "turnHeader":
			return <TurnHeaderRowView row={row} animate={animate} />;
		case "userInput":
			return <UserInputRowView row={row} animate={animate} />;
		case "assistantText":
			return <AssistantTextRowView row={row} animate={animate} />;
		case "reasoning":
			return <ReasoningRowView row={row} animate={animate} streaming={streaming} />;
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
	// G1 防御（2026-10-20）：服务端在 want 达到上限时返回 hasOlder=false；这里再兜一层，
	// 避免「按钮点了没反应」——到顶后不再渲染入口。
	const hasOlder = useGui((s) => (activeId !== null ? s.chatHasOlderBySession[activeId] === true : false));
	const tailWant = useGui((s) => (activeId !== null ? (s.chatTailBySession[activeId] ?? 200) : 200));
	const streaming = useGui((s) => s.chatStreaming);
	/** 停止按钮（2026-10-20）：本地瞬时态 + 回执。 */
	const chatAborting = useGui((s) => s.chatAborting);
	const chatControl = useGui((s) => s.chatControl);
	const chatBusyFlag = useGui((s) => s.chatBusyFlag);
	/** 可用斜杠命令（2026-10-20）：null = 快照不可用（扩展未加载/未 reload）。 */
	const chatCommands = useGui((s) => s.chatCommands);
	const [slashIndex, setSlashIndex] = useState(-1);
	/**
	 * 「会话在跑」的判据（三条独立信号，任一成立即视为忙）：
	 *  1. **turn 级 busy 标记**（扩展在 `agent_start` 写、`agent_settled` 删）——
	 *     最权威，覆盖「点发送 → 第一个 token」与「工具跑完 → 下一段输出」两段空白；
	 *  2. 流式快照存在（当前这一段正在产出）；
	 *  3. 最后一行是 `status="running"` 的工具卡（不依赖扩展，从 transcript 投影来）。
	 *
	 * 2026-10-20 用户实测报障：前两条都只在助手**已产出**后才成立 ⇒ 点发送后到首个 token
	 * 之间、以及工具跑完到下一段输出之间，按钮是灰的 —— 而那正是最想按停的时刻。
	 * 加第 1 条后这两段空白被填上。
	 */
	const lastRowRunning = useMemo(() => {
		const last = rows[rows.length - 1];
		return last !== undefined && last.kind === "toolCall" && last.status === "running";
	}, [rows]);
	const chatBusy = chatBusyFlag || streaming !== null || lastRowRunning;
	/**
	 * 停止回执的人话（只对**需要告知**的结果出字）：
	 *   - aborted ⇒ 不显示（预期行为，流式预览消失就是反馈）；
	 *   - not-streaming ⇒ 「会话已空闲」（用户点了但没东西可停，得告知）
	 *   - stale-ctx ⇒ 「会话可能已重启」（真故障）
	 *   - failed ⇒ 带 error
	 */
	const controlHint = useMemo(() => {
		if (chatControl === null) return null;
		const req = chatControl.request;
		if (req.status === "failed") return `停止失败：${req.error ?? "未知错误"}`;
		if (req.status !== "done") return null;
		if (req.result === "not-streaming") return "停止请求已送达，但会话当时已空闲（无需停止）";
		if (req.result === "stale-ctx") return "停止请求已送达，但会话上下文已失效（可能已重启，请刷新）";
		if (req.result === "unknown-action") return "停止请求被拒：动作不被支持（版本不匹配？）";
		return null; // aborted：预期行为，不出字
	}, [chatControl]);
	/**
	 * 自动展开「刚落盘的那条思考」（2026-10-20 用户要求「当前执行的思考自动展开，完毕自动合上」）。
	 *
	 * 关键事实（CDP 实测）：流式中的思考在 JSONL 里**还不存在**（pi 只在 message_end 落盘），
	 * 它由 `StreamingPreview` 单独渲染（自带实时文本，本身就是展开态）。所以「自动展开」
	 * 要解决的是**流式刚结束、正式 reasoning 行刚落盘**的那一下：让刚看完的思考保持可见。
	 * 4s 后自动失效（回到默认收起），避免历史会话被强行展开。
	 */
	const prevStreamingRef = useRef(streaming);
	/**
	 * 流式开始那一刻已存在的 reasoning rowId 集合 —— 用于事后精确识别
	 * 「哪一条 reasoning 是本次流式刚生成的」。
	 *
	 * ⚠️ 2026-10-20 二次修复（后台 170s × 250ms 采样实测）：原判定是
	 * `streamJustEnded && rows[最后一行].kind === "reasoning"`，而该条件
	 * **实际永不成立** —— assistant 消息落盘时，thinking 与 tool_use 来自同一条
	 * message 记录，投影会同时产出 reasoning 行和 toolCall 行，**最后一行永远是
	 * toolCall**。采样日志里 `R:open` 命中 **0 次**（同期工具卡 `·:open` 正常），
	 * 证明「思考自动展开」从来没生效过。
	 * 现改为「差集判定」：流式开始时快照 reasoning id，结束后找新出现的那些。
	 */
	const reasoningIdsAtStreamStartRef = useRef<Set<string> | null>(null);
	/** 最新 rows 的 ref（effect 只依赖 streaming，不能因 rows 变化而重跑）。 */
	const rowsRef = useRef(rows);
	rowsRef.current = rows;
	const [streamJustEnded, setStreamJustEnded] = useState(false);
	useEffect(() => {
		const prev = prevStreamingRef.current;
		if (prev === null && streaming !== null) {
			// 流式开始：记下当时已有哪些 reasoning 行
			reasoningIdsAtStreamStartRef.current = new Set(
				rowsRef.current.filter((r) => r.kind === "reasoning").map((r) => r.rowId),
			);
		}
		if (prev !== null && streaming === null) setStreamJustEnded(true);
		prevStreamingRef.current = streaming;
	}, [streaming]);
	useEffect(() => {
		if (!streamJustEnded) return;
		const t = window.setTimeout(() => setStreamJustEnded(false), 1500);
		return () => window.clearTimeout(t);
	}, [streamJustEnded]);
	const streamingRowId = useMemo(() => {
		if (!streamJustEnded) return null;
		const before = reasoningIdsAtStreamStartRef.current;
		if (before === null) return null;
		// 取最后一条 reasoning；只有它是「流式开始后才出现的」才认定为本轮刚落盘的。
		// 若它早已存在（本次是纯文本流 / 纯工具流），返回 null ⇒ 不动任何历史行。
		for (let i = rows.length - 1; i >= 0; i--) {
			const r = rows[i]!;
			if (r.kind !== "reasoning") continue;
			return before.has(r.rowId) ? null : r.rowId;
		}
		return null;
	}, [streamJustEnded, rows]);
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
	 * 「任务执行完毕 → 自动折叠这一轮的工作过程」（2026-10-21 用户要求：
	 * 「以简略界面方便用户更好的找到信息」）。
	 *
	 * 判定全在 `turnCollapse.ts`（纯函数，配 `_test_turn_collapse.ts` 9 条边界）；
	 * 这里只负责：① 折叠态不渲染那些行；② 把摘要（时长/步数/是否展开）交给 turnHeader 行。
	 *
	 * `running` 用 `chatBusy`（busy 标志 400ms 轮询 ‖ 流式快照 ‖ 末行是 running 工具卡）——
	 * 跑着的轮一律不折叠，过程要能看见。用户手动展开过的轮存在 `openTurns` 里（按
	 * turnHeader.rowId，天然按会话隔离，不会串台）。
	 */
	const [openTurns, setOpenTurns] = useState<Record<string, boolean>>({});
	const turnPlan = useMemo(
		() => planTurnCollapse(visibleRows, { running: chatBusy, opened: openTurns }),
		[visibleRows, chatBusy, openTurns],
	);

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
	/** composer sticky dock（末位子元素）：它变高（输入框换行）时也要吸底。 */
	const composerDockRef = useRef<HTMLDivElement | null>(null);
	const [atBottom, setAtBottom] = useState(true);
	/**
	 * 跟随态（= 贴底）的 ref 镜像。`ResizeObserver` 回调只有在布局之后才跑，
	 * 那时 `atBottom` 闭包可能是旧的 ⇒ 用 ref 读当前值，避免「正在回看却被拽回底部」。
	 */
	const followRef = useRef(true);

	/**
	 * 贴底 = 滚到**最大滚动位**（`scrollTop = scrollHeight`）。
	 *
	 * ⚠️ 为什么不是「滚到视口底」：composer dock 是滚动容器里的 `sticky bottom-0` 末位子元素，
	 * 它在文档流里占着最后那一块位置。滚到最大滚动位时，消息末行正好停在**输入框上沿**；
	 * 只要差一点没到底，sticky 就会把输入框顶到视口底部、盖住它后面的正文 ——
	 * 观感就成了「以屏幕底为底」（2026-10-21 用户报的第 2 条）。
	 */
	const pinToBottom = (): void => {
		const el = scrollRef.current;
		if (el === null) return;
		el.scrollTop = el.scrollHeight;
	};
	/** 跟随态与 state 一起改（两处都得改，否则 ref 与 UI 会分叉）。 */
	const setFollow = (next: boolean): void => {
		followRef.current = next;
		setAtBottom(next);
	};

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
		const near = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
		followRef.current = near;
		setAtBottom(near);
		syncMask();
	};

	/**
	 * 贴底锚定：跟随态下跟着「新行 / 回执 / 流式增量 / 折叠展开」吸底；回看锁定阅读位。
	 *
	 * 2026-10-21 修（用户报「自动向下滚动不积极」+「以屏幕底为底」）：
	 * 旧实现依赖只有 `[visibleRows, outboxEntries, atBottom]` —— **同一段流式文本增长期间
	 * `visibleRows` 根本不变化**（快照 200ms 换一次内容，行列表没变），所以整个流式过程
	 * 一次都不滚，新字持续堆到输入框底下；等堆过 48px 阈值后，下一次 scroll 事件又会把
	 * `atBottom` 判成 false ⇒ 彻底停住跟随（越流越不跟）。
	 * 现三条一起上：
	 *   ① 把流式快照的 `text/kind` 也算进依赖 ⇒ 每拍（200ms）都吸一次；
	 *   ② 用 `useLayoutEffect` 而不是 `useEffect` ⇒ 在绘制前就把位置摆好，不闪一帧；
	 *   ③ 再用 `ResizeObserver` 兜住「父级没重渲染但高度变了」的情况（下面那个 effect）。
	 */
	useLayoutEffect(() => {
		if (!atBottom) return;
		pinToBottom();
	}, [visibleRows, outboxEntries, atBottom, streaming?.text, streaming?.kind]);

	/**
	 * 高度兜底（2026-10-21）：`RowView` 的折叠块是**子组件自己的 state**，
	 * 思考卡自动展开/合上时父级不会重渲染 ⇒ 上面那个依赖数组的 effect 跑不到。
	 * 这里盯消息层与 composer dock 的实际高度：只要跟随态，高度一变就吸底。
	 * 回看态直接返回（不抢用户阅读位）。
	 */
	useEffect(() => {
		const el = scrollRef.current;
		const layer = messageLayerRef.current;
		const dock = composerDockRef.current;
		if (el === null || layer === null || typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(() => {
			if (!followRef.current) return;
			el.scrollTop = el.scrollHeight;
		});
		ro.observe(layer);
		if (dock !== null) ro.observe(dock);
		return () => ro.disconnect();
	}, [activeId]);

	// 切会话 → 重置贴底（先看最新）
	useEffect(() => {
		setFollow(true);
		pinToBottom();
	}, [activeId]);

	const scrollToLatest = (): void => {
		setFollow(true);
		pinToBottom();
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

	/**
	 * 斜杠命令补全（2026-10-20）。
	 *
	 * 只在「draft 以 / 开头且未输入空格」时激活；候选来自命令快照（30s 轮询）。
	 * 快照不可用时不弹面板 —— 但输入框仍可自由输入（不做硬拦截：
	 * 用户可能想发一条以 / 开头的普通消息，那是他的自由）。
	 */
	const slashState = useMemo(() => parseSlashDraft(draft), [draft]);
	const slashCandidates = useMemo(
		() => (slashState.active && chatCommands !== null ? filterCommands(chatCommands.commands, slashState.prefix) : []),
		[slashState.active, slashState.prefix, chatCommands],
	);
	const slashOpen = slashState.active && slashCandidates.length > 0;
	// 候选变化时把选中位重置（否则会指向已不存在的下标）
	useEffect(() => {
		setSlashIndex(-1);
	}, [slashState.prefix, chatCommands]);

	const send = async (): Promise<void> => {
		const text = draft.trim();
		if (activeId === null || !canSendMessage(draft, attachments)) return;
		// 斜杠命令（2026-10-20）：`/name args` 走 session.slash 通道（正文原样交给 pi）。
		// 为什么不让它当普通消息发：pi 的 prompt() 对 `/` 开头文本会先试命令
		// （agent-session.js:1458），命令名打错就**退回当正文发给 LLM**，污染上下文。
		// 走命令通道 + 快照白名单，拼错会被明确拒（unknown-command）而不是白烧 token。
		if (text.startsWith("/") && text.length > 1) {
			const body = text.slice(1);
			const sp = body.indexOf(" ");
			const name = sp === -1 ? body : body.slice(0, sp);
			const args = sp === -1 ? "" : body.slice(sp + 1);
			if (!/^[a-z][a-z0-9-]*$/.test(name)) {
				setAttachHint("命令名只能是小写字母开头、由 a-z 0-9 - 组成");
				return;
			}
			setDraft("");
			await useGui.getState().sendChatSlash(activeId, name, args);
			return;
		}
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
								{visibleRows.map((row, i) => {
									const animate = hiddenHead + i >= animateFromIndex;
									// 已结束轮的工作过程：折叠态直接不渲染（判定在 turnCollapse.ts）
									if (turnPlan.hidden.has(row.rowId)) return null;
									const summary = turnPlan.summaryByHeaderId.get(row.rowId) ?? null;
									if (row.kind === "turnHeader") {
										return (
											<TurnHeaderRowView
												key={row.rowId}
												row={row}
												animate={animate}
												summary={summary}
												onToggle={() =>
													setOpenTurns((m) => ({ ...m, [row.rowId]: m[row.rowId] !== true }))
												}
											/>
										);
									}
									return (
										<RowView key={row.rowId} row={row} animate={animate} streaming={row.rowId === streamingRowId} />
									);
								})}
								{/* 2026-10-19 用户裁决：**不再画第二条气泡**。
								    只在「已发出但还没进 transcript」且非终态成功时给一行极简状态
								    （排队中/失败/被拒 才有价值；已进 transcript 的条目已被上面过滤掉）。 */}
								{outboxEntries.map((e) => (
									<OutboxStatusLine key={e.commandKey} e={e} />
								))}
								{/* 流式预览（2026-10-20）：仅当服务端有该会话的快照（= 正在生成）时显示 */}
								{streaming !== null && <StreamingPreview snap={streaming} />}
								{/* 停止回执（2026-10-20）：只在「有值得说的结果」时显示——
								    aborted 是预期行为（不扑喷），not-streaming / stale-ctx / failed 必须告知。 */}
								{controlHint !== null && (
									<div className="py-1 text-ui-xs text-foreground-subtlest">{controlHint}</div>
								)}
							</>
						)}
					</div>
					{/* composer sticky dock（ConversationTimeline.tsx#L1911-1929 + ChatPromptEditor.tsx#L346-361） */}
					<div ref={composerDockRef} className="pointer-events-none sticky bottom-0 z-20 mt-auto flex w-full justify-center">
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
							{/* 斜杠命令补全（2026-10-20）：贴在输入壳上方。
							    只在「draft 以 / 开头且未输空格」且有候选时出现。
							    source 为 skill/prompt 的条目标「插入正文」—— 它们会被展开成正文写进对话，
							    不是「不落记录的真正命令」，不标就是语义欺骗。 */}
							{slashOpen && (
								<div
									role="listbox"
									aria-label="斜杠命令"
									className="absolute bottom-full left-0 z-30 mb-2 max-h-64 w-full overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg"
								>
									{slashCandidates.slice(0, 40).map((c, i) => {
										const hint = sourceHint(c.source);
										return (
											<button
												key={`${c.source}:${c.name}`}
												type="button"
												role="option"
												aria-selected={i === slashIndex}
												onMouseEnter={() => setSlashIndex(i)}
												onMouseDown={(e) => {
													e.preventDefault(); // 不抢 textarea 焦点
													setDraft(applyCommandSelection(c.name));
												}}
												className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui-sm ${i === slashIndex ? "bg-accent/12 text-foreground" : "text-foreground-subtle"}`}
											>
												<span className="font-mono text-ui-sm text-foreground">/{c.name}</span>
												{hint !== null && (
													<span className="shrink-0 rounded border border-border px-1 text-ui-xs text-foreground-subtlest">
														{hint}
													</span>
												)}
												{c.description !== undefined && (
													<span className="truncate text-ui-xs text-foreground-subtlest">{c.description}</span>
												)}
											</button>
										);
									})}
								</div>
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
										// 斜杠命令补全优先（2026-10-20）：上/下选择、Tab/Enter 接受、Esc 关闭。
										// 为什么要在 Enter 发送之前拦：补全面板开着时 Enter 应该是「选中命令」
										// 而不是「把半截 `/mod` 当消息发出去」。
										const act = slashKeyAction(e.key, { open: slashOpen, candidateCount: slashCandidates.length });
										if (act === "dismiss") {
											e.preventDefault();
											setSlashIndex(-1);
											return;
										}
										if (act === "accept") {
											e.preventDefault();
											const pick = slashCandidates[slashIndex >= 0 ? slashIndex : 0];
											if (pick !== undefined) setDraft(applyCommandSelection(pick.name));
											return;
										}
										if (act === "up" || act === "down") {
											e.preventDefault();
											setSlashIndex((cur) => moveIndex(cur, act === "up" ? -1 : 1, slashCandidates.length));
											return;
										}
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
											{/*
												Stop 钮（2026-10-20 接入）：POST /v1/commands `session.abort`
												→ daemon 写 `state/session-control/` → 会话进程 fs.watch 领取 → `ctx.abort()`。
												诚实口径：点击只表示「请求已发出」，真实结果（aborted / not-streaming）
												由 500ms 回执轮询读回；abort 会丢弃本轮未完成产出，所以 tooltip 明说。
											*/}
											<Tooltip>
												<TooltipTrigger asChild>
													<span className="inline-flex">
														<Button
															type="button"
															variant="secondary"
															size="icon-md"
															disabled={activeId === null || !chatBusy || chatAborting}
															onClick={() => {
																if (activeId !== null) void useGui.getState().abortChatSession(activeId);
															}}
															aria-label={chatAborting ? "正在停止…" : "停止当前输出"}
														>
															<Square className={`size-4 fill-current ${chatAborting ? "animate-pulse" : ""}`} />
														</Button>
													</span>
												</TooltipTrigger>
												<TooltipContent>
													{chatAborting
														? "已发送停止请求，等待会话确认…"
														: chatBusy
															? "停止当前输出（会丢弃本轮未完成的产出）"
															: "会话空闲"}
												</TooltipContent>
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
