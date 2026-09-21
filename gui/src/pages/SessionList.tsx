/**
 * gui/src/pages/SessionList.tsx — 左栏常驻会话列表（会话为主重构 S3；ZCode TaskListItem 三段式样板）。
 *
 * 列表项 = [16px 状态槽] + [标题行：title（可读标题；titleSource=id 时灰显 shortId）+ 盾标] / [元信息行：basename(cwd) · mtime 相对时间]。
 * 状态槽数据源（诚实映射，不伪造）：error = 该会话 outbox failed/expired/rejected（红点）；
 * masterProtected = 标题行盾标（非槽位）；「运行中/未读」无数据源 v1 留空。
 * 排序 mtimeMs desc + 顶部文本过滤（标题 / shortId / 文件 / cwd 子串，matchesSessionFilter）；选中态 = bg-selected 纯背景圆角行。
 */

import { useMemo, useState } from "react";
import { useGui } from "../store";
import { EmptyState, RelTime, ShortId, Term } from "../ui";
import type { SessionSummary } from "../api/types";
import { matchesSessionFilter } from "../sessionFilter";

function basename(p: string | null): string {
	if (p === null) return "";
	const norm = p.replace(/\\/g, "/");
	const idx = norm.lastIndexOf("/");
	return idx >= 0 ? norm.slice(idx + 1) : norm;
}

function mtimeIso(s: SessionSummary): string | null {
	return Number.isFinite(s.mtimeMs) && s.mtimeMs > 0 ? new Date(s.mtimeMs).toISOString() : null;
}

export function SessionList() {
	const chatSessions = useGui((s) => s.chatSessions);
	const activeId = useGui((s) => s.chatActiveId);
	const outboxMap = useGui((s) => s.chatOutbox);
	const [filter, setFilter] = useState("");

	// error 状态槽数据源：该会话任一 outbox 条目落入终态失败（failed/expired/rejected）
	const failedSessions = useMemo(() => {
		const set = new Set<string>();
		for (const e of Object.values(outboxMap)) {
			if (e.status === "failed" || e.status === "expired" || e.status === "rejected") set.add(e.sessionId);
		}
		return set;
	}, [outboxMap]);

	const sessions = useMemo(() => {
		const sorted = [...chatSessions].sort((a, b) => b.mtimeMs - a.mtimeMs);
		return sorted.filter((s) => matchesSessionFilter(s, filter));
	}, [chatSessions, filter]);

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-1.5">
			<div className="flex shrink-0 items-center justify-between px-1">
				<span className="text-xs font-semibold tracking-wide text-zinc-400">
					<Term zh="会话" en="Sessions" />
				</span>
				<span className="font-mono text-[10px] text-zinc-600">{chatSessions.length}</span>
			</div>
			<input
				value={filter}
				onChange={(e) => setFilter(e.target.value)}
				placeholder="过滤会话（标题 / ID / 路径）"
				className="shrink-0 rounded border border-zinc-700 bg-background px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
			/>
			<ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
				{sessions.length === 0 ? (
					<EmptyState>{chatSessions.length === 0 ? "暂无会话（等待列表数据）" : "无匹配会话"}</EmptyState>
				) : (
					sessions.map((s) => {
						const hasError = failedSessions.has(s.sessionId);
						return (
							<li key={s.sessionId}>
								<button
									type="button"
									onClick={() => void useGui.getState().openChatSession(s.sessionId)}
									title={s.file}
									className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
										activeId === s.sessionId ? "bg-selected text-zinc-100" : "text-zinc-400 hover:bg-surface hover:text-zinc-200"
									}`}
								>
									{/* 16px 状态槽：error 红点；「运行中/未读」无数据源 v1 留空 */}
									<span className="flex h-4 w-4 shrink-0 items-center justify-center">
										{hasError && <span className="h-2 w-2 rounded-full bg-destructive" title="该会话有发送失败/过期/被拒的消息" />}
									</span>
									<span className="min-w-0 flex-1">
										{/* 标题行：可读 title（解析链 ledger|first-user）；titleSource=id 或旧 server 无 title → 灰显 shortId */}
										<span className="flex min-w-0 items-center justify-between gap-1">
											{s.title !== undefined && s.titleSource !== "id" ? (
												<span className="min-w-0 flex-1 truncate text-zinc-200" title={s.title}>
													{s.title}
												</span>
											) : (
												<ShortId
													value={s.sessionId}
													className={s.titleSource === "id" ? "text-zinc-600" : undefined}
												/>
											)}
											{s.masterProtected === true && (
												<span className="shrink-0 text-[10px]" title="Master 会话拒绝远程输入（executor 层 403 护栏）">
													🛡
												</span>
											)}
										</span>
										{/* 元信息行：basename(cwd) · mtime 相对时间 */}
										<span className="mt-0.5 flex items-center justify-between gap-2 text-[10px] text-zinc-500">
											<span className="truncate font-mono">{basename(s.cwd)}</span>
											<RelTime at={mtimeIso(s)} className="shrink-0" />
										</span>
									</span>
								</button>
							</li>
						);
					})
				)}
			</ul>
		</div>
	);
}
