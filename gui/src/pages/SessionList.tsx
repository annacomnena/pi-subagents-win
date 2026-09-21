/**
 * gui/src/pages/SessionList.tsx — 左栏会话列表（ZCode 1:1 复刻 第 3 步；样板 TaskList +
 * TaskListItem workspace 变体，class 串照抄锚 §2.a）。
 *
 * 列表项三段式 = [16px 前置状态槽] + [标题行：title 链成果（titleSource=id 灰显 shortId）+
 * masterProtected 盾标] / [元信息行：basename(cwd) · mtime 相对时间]。
 * 行 class 逐字对齐 TaskListItem.tsx#L534-546：`group/task-item flex cursor-pointer gap-2
 * rounded-lg pl-2.5 pr-1 py-1 transition-[background-color,border-color,box-shadow]`；
 * 选中 `bg-selected` / hover `bg-surface-hover`（行高基准 32px、无分隔线无竖条）。
 * 状态槽四态前置（error>未读>运行中>idle）中只有 error 有数据源（该会话 outbox 终态失败集）；
 * unread/loading 无数据源 → 不渲染（拍板 1）。
 * [无后端支撑]=不渲染：分组 Tabs、置顶/归档区、拖拽排序、工作流行、分页。
 */

import { useMemo, useState } from "react";
import { Clock, Shield } from "lucide-react";
import { useGui } from "../store";
import { RelTime, ShortId } from "../ui";
import { Input } from "../ui/input";
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
		<div className="flex min-h-0 flex-1 flex-col gap-2 px-2">
			{/* 过滤 Input（ui/input token 套件；zcode 搜索为按钮开面板——本处保留内联过滤成果） */}
			<Input
				value={filter}
				onChange={(e) => setFilter(e.target.value)}
				placeholder="过滤会话（标题 / ID / 路径）"
				className="h-7 shrink-0"
			/>
			{/* 列表容器（TaskList.tsx#L383 flex flex-col gap-2 + #L450 ul space-y-0.5） */}
			<ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
				{sessions.length === 0 ? (
					<li className="px-2.5 py-2 text-ui-sm text-foreground-subtlest">
						{chatSessions.length === 0 ? "暂无会话（等待列表数据）" : "无匹配会话"}
					</li>
				) : (
					sessions.map((s) => {
						const hasError = failedSessions.has(s.sessionId);
						const isActive = activeId === s.sessionId;
						return (
							// 行体（TaskListItem.tsx#L534-546 逐字；workspace 变体单行居中）
							<li
								key={s.sessionId}
								title={s.file}
								onClick={() => void useGui.getState().openChatSession(s.sessionId)}
								onKeyDown={(e) => {
									if (e.key === "Enter" || e.key === " ") {
										e.preventDefault();
										void useGui.getState().openChatSession(s.sessionId);
									}
								}}
								tabIndex={0}
								className={`group/task-item flex cursor-pointer items-center gap-2 rounded-lg pl-2.5 pr-1 py-1 transition-[background-color,border-color,box-shadow] ${
									isActive ? "bg-selected" : "hover:bg-surface-hover"
								}`}
							>
								{/* 前置状态槽 16×16（#L559-600）：error 红点；unread/loading 无数据源不渲染 */}
								<div className="relative flex size-4 shrink-0 items-center justify-center">
									{hasError && (
										<span
											data-error-indicator="true"
											className="h-1.5 w-1.5 rounded-full bg-destructive"
											title="该会话有发送失败/过期/被拒的消息"
										/>
									)}
								</div>
								<div className="flex min-w-0 flex-1 flex-col gap-0.5">
									{/* 标题行：可读 title（解析链 ledger|first-user）；titleSource=id → 灰显 shortId */}
									<div className="flex min-w-0 items-center gap-2">
										{s.title !== undefined && s.titleSource !== "id" ? (
											<span className="min-w-0 flex-1 truncate text-ui-base text-foreground" title={s.title}>
												{s.title}
											</span>
										) : (
											<ShortId
												value={s.sessionId}
												className={`min-w-0 flex-1 ${s.titleSource === "id" ? "text-foreground-subtlest" : ""}`}
											/>
										)}
										{s.masterProtected === true && (
											// masterProtected 盾标（我方数据面；zcode 无直接对应物）
											<span
												className="shrink-0 text-warning"
												title="Master 会话拒绝远程输入（executor 层 403 护栏）"
											>
												<Shield className="size-3.5" />
											</span>
										)}
									</div>
									{/* 元信息行（#L745-770 同款刻度）：basename(cwd) · mtime 相对时间 */}
									<div className="flex min-w-0 items-center gap-1 text-ui-sm text-foreground-subtle">
										<span className="min-w-0 truncate">{basename(s.cwd)}</span>
										<span className="shrink-0 text-foreground-subtlest">·</span>
										<Clock className="size-3.5 shrink-0" />
										<RelTime at={mtimeIso(s)} className="shrink-0" />
									</div>
								</div>
							</li>
						);
					})
				)}
			</ul>
		</div>
	);
}
