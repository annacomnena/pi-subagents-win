/**
 * gui/src/rightRail/DocPreviewPanel.tsx — 右栏「文档预览」（2026-11-20）。
 *
 * 入口只有一个：点击 assistant 回复里形如 `plans/xxx/report.md` 的内联 code
 * ⇒ store.openDocPreview(path) 填入路径 + 点选时的 cwd，切到本面板并展开右栏。
 *
 * 三条纪律：
 * 1. **请求带序号**：切路径/切会话时旧响应必须丢弃（与 NotePanel 的 sid 快照同口径），
 *    否则慢响应会把新文件内容覆盖成旧文件；
 * 2. **读失败 ≠ 文件不存在**：错误体里的 hint 必须原样显示（not-found / binary / too-large
 *    各有不同出口，「用默认应用打开」在二进制/超大文件时仍然可用）；
 * 3. **不抢鼠标**：本面板只提供按钮，所有系统打开都走 daemon 的受鉴权端点，浏览器不弹窗。
 */

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Copy, ExternalLink, FileText, FolderOpen, LoaderCircle, X } from "lucide-react";
import { api } from "../api/client";
import type { FileEndpointError, FilePreviewResult } from "../api/types";
import { useGui } from "../store";
import { EmptyState } from "../ui";
import { Button } from "../ui/button";
import { Markdown } from "../ui/Markdown";
import { toast } from "../ui/toast";

interface PreviewError {
	error: string;
	hint: string;
}

/** 浏览器侧取父目录（不能 import node:path）。同时兼容 / 与 \。 */
function dirOf(p: string): string {
	const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
	if (i <= 0) return "";
	// 盘符根文件 C:\a.md：截到 i=2 会得到 "C:"（盘符相对路径，解析到 daemon cwd 而非 C:\）。
	// 保留分隔符 ⇒ "C:\"，与服务端 path.resolve 的语义一致。
	const head = p.slice(0, i);
	return /^[A-Za-z]:$/.test(head) ? p.slice(0, i + 1) : head;
}

/** Markdown 家族才走富渲染；其余按纯文本（不把代码/CSV 误当 md）。 */
function isMarkdownish(p: string): boolean {
	return /\.(md|markdown|mdx)$/i.test(p);
}

function errOf(body: unknown): PreviewError {
	const b = (body ?? {}) as Partial<FileEndpointError>;
	return {
		error: typeof b.error === "string" && b.error !== "" ? b.error : "request-failed",
		hint: typeof b.hint === "string" && b.hint !== "" ? b.hint : "请求失败；请检查 daemon 是否运行、路径是否正确",
	};
}

export function DocPreviewPanel() {
	const path = useGui((s) => s.docPreviewPath);
	const cwd = useGui((s) => s.docPreviewCwd);
	const openDocPreview = useGui((s) => s.openDocPreview);
	const closeDocPreview = useGui((s) => s.closeDocPreview);

	const [data, setData] = useState<FilePreviewResult | null>(null);
	const [error, setError] = useState<PreviewError | null>(null);
	const [loading, setLoading] = useState(false);
	const [acting, setActing] = useState<"open" | "reveal" | null>(null);
	/** 请求序号：只接受最后一次请求的结果（防慢响应倒灌）。 */
	const reqIdRef = useRef(0);

	useEffect(() => {
		const id = ++reqIdRef.current;
		if (path === null || path.trim() === "") {
			setData(null);
			setError(null);
			setLoading(false);
			return;
		}
		setLoading(true);
		setError(null);
		setData(null);
		setActing(null); // 切文件立即解锁工具栏，不等旧动作响应
		void api.fileRead(path, cwd).then((res) => {
			if (reqIdRef.current !== id) return; // 迟到响应直接丢弃
			setLoading(false);
			if (!res.ok) {
				setError(errOf(res.body));
				return;
			}
			setData(res.data);
		});
	}, [path, cwd]);

	const runAction = (action: "open" | "reveal"): void => {
		if (path === null) return;
		const reqId = reqIdRef.current; // 与读取同序号：切文件后旧动作的 toast 不得倒灌
		const target = path;
		setActing(action);
		const call = action === "open" ? api.fileOpen(target, cwd) : api.fileReveal(target, cwd);
		void call.then((res) => {
			// 先解锁按钮再判陈旧：否则切文件后旧响应提前 return 会让 acting 永远停在 open/reveal ⇒ 两个按钮永久禁用
			setActing(null);
			if (reqIdRef.current !== reqId) return;
			if (!res.ok) {
				const e = errOf(res.body);
				toast(`${action === "open" ? "打开失败" : "定位失败"}：${e.hint}`, { variant: "warning" });
				return;
			}
			toast(action === "open" ? "已交由默认应用打开" : "已在资源管理器中定位");
		});
	};

	const copyPath = (): void => {
		// N-4：只有读取成功才知道解析后的绝对路径；失败态 data 为 null，
		// 此时 path 可能只是相对路径，复制出去在资源管理器里找不到 ⇒ 禁用（见按钮 disabled）。
		const full = data?.path;
		if (full === undefined || full === "") return;
		void navigator.clipboard.writeText(full).then(
			() => toast("文件绝对路径已复制"),
			() => toast("复制失败：浏览器拒绝剪贴板访问", { variant: "warning" }),
		);
	};

	if (path === null) {
		return (
			<div className="flex h-full items-center justify-center p-5">
				<EmptyState icon={<FileText className="size-5" />}>
					<div className="space-y-1 text-center">
						<div className="text-ui-base text-foreground">点击回复里的文件路径</div>
						<div className="text-ui-xs text-foreground-subtle">
							例如 <code className="md-inline-code">plans/xxx/report.md</code>，正文会显示在这里
						</div>
					</div>
				</EmptyState>
			</div>
		);
	}

	const shownPath = data?.path ?? path;
	return (
		<div className="flex h-full min-h-0 flex-col">
			{/* 顶部工具栏：路径 + 三个动作（用户要的两个 + 复制路径）。 */}
			<div className="shrink-0 border-b border-border px-2 py-2">
				<div className="flex items-start gap-1.5">
					<div className="min-w-0 flex-1" title={shownPath}>
						<div className="truncate font-mono text-ui-xs text-foreground-subtle">{shownPath}</div>
						{cwd !== null && cwd !== "" && (
							<div className="truncate text-ui-xs text-foreground-subtlest" title={`相对路径基准：${cwd}`}>
								基准：{cwd}
							</div>
						)}
					</div>
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						aria-label="关闭文档预览"
						title="关闭文档预览"
						onClick={closeDocPreview}
					>
						<X className="size-3.5" aria-hidden="true" />
					</Button>
				</div>
				<div className="mt-2 flex flex-wrap gap-1.5">
					<Button
						type="button"
						variant="secondary"
						size="sm"
						disabled={acting !== null}
						aria-label="使用外部默认应用打开"
						title="使用外部默认应用打开完整文件"
						onClick={() => runAction("open")}
						className="gap-1"
					>
						<ExternalLink className="size-3.5" aria-hidden="true" />
						<span>{acting === "open" ? "打开中…" : "默认应用打开"}</span>
					</Button>
					<Button
						type="button"
						variant="secondary"
						size="sm"
						disabled={acting !== null}
						aria-label="打开所在文件夹"
						title="在资源管理器中定位到该文件"
						onClick={() => runAction("reveal")}
						className="gap-1"
					>
						<FolderOpen className="size-3.5" aria-hidden="true" />
						<span>{acting === "reveal" ? "定位中…" : "打开文件夹"}</span>
					</Button>
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						aria-label="复制绝对路径"
						title={data !== null ? "复制绝对路径" : "读取成功后才能复制绝对路径"}
						disabled={data === null}
						onClick={copyPath}
					>
						<Copy className="size-3.5" aria-hidden="true" />
					</Button>
				</div>
			</div>

			{/* 正文区：加载 / 错误 / 内容三态，错误也保留工具栏（二进制/大文件仍可外部打开）。 */}
			<div className="min-h-0 flex-1 overflow-auto px-3 py-2">
				{loading && (
					<div className="flex items-center gap-2 text-ui-xs text-foreground-subtle">
						<LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
						正在读取文件…
					</div>
				)}
				{!loading && error !== null && (
					<div className="rounded-md border border-border bg-background-alt p-2.5 text-ui-xs" data-doc-preview-error={error.error}>
						<div className="flex items-center gap-1.5 font-medium text-foreground">
							<AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
							无法预览（{error.error}）
						</div>
						<div className="mt-1 break-words leading-relaxed text-foreground-subtle">{error.hint}</div>
					</div>
				)}
				{!loading && data !== null && (
					<>
						{isMarkdownish(data.path) ? (
							<Markdown text={data.content} onOpenPath={(p) => openDocPreview(p, dirOf(data.path))} />
						) : (
							<pre className="whitespace-pre-wrap break-words font-mono text-ui-xs">{data.content}</pre>
						)}
						<div className="mt-4 border-t border-border pt-2 text-ui-xs text-foreground-subtlest">
							{data.encoding} · {Math.round(data.size / 1024)} KiB
							{data.truncated ? " · 已截断（请用默认应用打开查看完整内容）" : ""}
						</div>
					</>
				)}
			</div>
		</div>
	);
}
