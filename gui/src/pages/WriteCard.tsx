/**
 * gui/src/pages/WriteCard.tsx — `write` 工具卡的「落笔」视图（2026-10-21）。
 *
 * 设计稿：`plans/20261021_write_card/design.md`（交互样张同目录 write-card.html）。
 * 判定/格式化/取窗口这类**会算错又不会崩**的逻辑在 `../writeCard.ts`（可 Node 直测，见 test:write-card）；
 * 这里只负责画：墨线 + 行号 + 逐行 + 光标 + 收笔扫光。样式全部在 index.css 的 `.write-*` 段。
 *
 * 为什么不用现成的 `<pre>{JSON.stringify(args)}</pre>`（原实现 ChatPage.tsx:447-449）：
 *   `content` 里的换行会变成字面 `\n`，代码被压成一段，无行号、无尺度、`break-all` 还切断标识符。
 *
 * 性能口径（长任务以 5Hz 重渲染，每次都带更大的 content）：
 *   1. DOM 常数 —— 只渲染尾部 WRITE_KEEP_ROWS 行，大文件不放大 DOM；
 *   2. 不做语法高亮 / 不整文件 tokenize，只用三档透明度区分注释/特性/结构；
 *   3. 行以**绝对行号**为 key ⇒ React 复用 DOM ⇒ 已写好的行不重放入场动画（只有新行带 is-new）。
 *
 * error 态为何不画进度：`write` 是单次整文件覆盖写（非原子、无回滚，取证见 design.md §10.4 ②），
 *   断在第几行/第几字节不可知 ⇒ 墨线塌成固定残线 + 整块降饱和 + 注脚（工具真实输出 + 固定口径）。
 */

import { useMemo, useRef } from "react";
import {
	WRITE_ERROR_CAVEAT,
	WRITE_KEEP_ROWS,
	classifyLine,
	inkHeightCss,
	visibleRows,
	type WriteStatus,
} from "../writeCard";

/**
 * 正文（迷你编辑器）。纯展示，状态全由 props 决定。
 *
 * 注意力：`prevTotalRef` 是「新行水位」，**只增不减** —— 滑窗把旧行移出 DOM 时若跟着回退，
 * 窗口一滑，老行就会重新变成 is-new 再入场一次（观感是"整块在抖"）。
 */
export function WriteCardBody({
	content,
	status,
	output,
}: {
	content: string;
	status: WriteStatus;
	output?: string;
}) {
	const { rows, total } = useMemo(() => visibleRows(content, WRITE_KEEP_ROWS), [content]);
	const prevTotalRef = useRef(0);
	const prevTotal = prevTotalRef.current;
	prevTotalRef.current = total;

	const lastNo = rows.length > 0 ? rows[rows.length - 1]!.no : 0;
	// error 态不给进度高度（断点不可知，见 design.md §10.4 ②）——undefined ⇒ 交给 CSS 的固定残线
	const inkH = inkHeightCss(total, status);

	return (
		<div className="write-card" data-status={status}>
			<div className="write-editor">
				<div className="write-rail" aria-hidden>
					<div className="write-ink" style={inkH ? { height: inkH } : undefined} />
				</div>
				<div className="write-viewport" data-write-rows={rows.length}>
					<div className="write-lines">
						{rows.map((r) => {
							const isCur = status === "running" && r.no === lastNo;
							// 新行 = 超过上次水位；只在 running 给入场动画（终态新挂载不重放）
							const isNew = status === "running" && r.no > prevTotal;
							return (
								<div key={r.no} className={`write-row${isCur ? " is-cur" : ""}${isNew ? " is-new" : ""}`}>
									<span className="write-no">{r.no}</span>
									<span className="write-tx" data-k={classifyLine(r.text) || undefined}>
										{r.text}
										{isCur && <span className="stream-caret" />}
									</span>
								</div>
							);
						})}
					</div>
					<div className="write-sweep" aria-hidden />
				</div>
			</div>
			{status === "error" && (
				<div className="write-note">
					<span aria-hidden>✕</span>
					<span className="write-note-body">
						<span className="write-note-err">{firstLine(output) ?? "写入失败（无输出）"}</span>
						<span className="write-note-caveat">{WRITE_ERROR_CAVEAT}</span>
					</span>
				</div>
			)}
		</div>
	);
}

function firstLine(s?: string): string | undefined {
	if (!s) return undefined;
	const line = s.split("\n").find((l) => l.trim() !== "");
	return line?.slice(0, 300);
}

/**
 * 写完的勾（描边动画）。`drawing` 由调用方在「running → 终态」的那一拍打开 ——
 * 不用 CSS `[data-status=done]` 直接触发，否则历史卡片挂载时也会画一遍。
 */
export function WriteCheck({ drawing }: { drawing: boolean }) {
	return (
		<svg
			className={`write-check${drawing ? " is-drawing" : ""}`}
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth={2}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden
		>
			<path d="M3 8.5l3.2 3.2L13 4.6" />
		</svg>
	);
}
