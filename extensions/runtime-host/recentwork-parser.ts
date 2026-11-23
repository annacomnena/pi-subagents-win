/**
 * extensions/runtime-host/recentwork-parser.ts — 任务跟踪文件解析器（只读安全，never-throw）。
 *
 * 专门解析目标工作区下的 recentwork.md / TODO.md，提取当前活跃任务列表。
 */

import { existsSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ParsedTaskItem {
	id: string;
	title: string;
	priority: string;
	status: "active" | "completed" | "fixing" | "warning" | "pending" | "unknown";
	statusText: string;
	summary: string;
}

export interface WorkspaceOverviewData {
	cwd: string;
	found: boolean;
	filePath?: string;
	fileMtimeMs?: number;
	tasks: ParsedTaskItem[];
	rawSnippet?: string;
}

const MAX_READ_BYTES = 256 * 1024; // 256KB 保护上限

/** 寻找目标路径下的跟踪文件（按优先级：recentwork.md -> plans/recentwork.md -> TODO.md） */
export function findTrackerFile(cwd: string): string | null {
	const candidates = [
		join(cwd, "recentwork.md"),
		join(cwd, "plans", "recentwork.md"),
		join(cwd, "TODO.md"),
		join(cwd, "todo.md"),
	];
	for (const p of candidates) {
		try {
			if (existsSync(p)) return p;
		} catch {
			// ignore access error
		}
	}
	return null;
}

function parsePriority(text: string): string {
	const m = text.match(/\b(P[0-3])\b/i);
	return m ? m[1].toUpperCase() : "P2";
}

/**
 * 行首 emoji 是作者对状态的显式标注，优先级高于正文关键词。
 *
 * 2026-11-17 事故：GreenCAD Item 3567 写的是
 * 「📋 …（待 3566 S3 完成后拍口径并开工）」，旧 parseStatus 先命中
 * `includes("完成")`，把一个尚未开工的登记条目显示成「已完成」。
 * 同理 `🔧 …实现完成、判定在飞` 也被误判为已完成。
 */
function parseLeadingMark(text: string): ParsedTaskItem["status"] | null {
	if (text.startsWith("✅")) return "completed";
	if (/^(?:🔧|🛠|🔨)/.test(text)) return "fixing";
	if (/^(?:⚠️|🟡)/.test(text)) return "warning";
	if (/^(?:⏸|📘|📌)/.test(text)) return "pending";
	// 📋 在本仓既表示「推进中」也表示「登记待开工」：正文有明确待办语义时归 pending。
	if (text.startsWith("📋")) {
		return /待[^｜|]{0,40}(?:开工|实施|拍|裁定|决定|补证据|收缩)|登记态|当前不实施|暂不实施/.test(text)
			? "pending"
			: "active";
	}
	return null;
}

function parseStatus(text: string): { status: ParsedTaskItem["status"]; statusText: string } {
	const clean = text.trim();
	const marked = parseLeadingMark(clean);
	if (marked) return { status: marked, statusText: clean };

	// 无显式标记才退回正文关键词：「未完成」「…完成后开工」不能算完成。
	const done = /(?<!未)完成(?!后)/.test(clean) ||
		/\b(?:completed|complete|done)\b/i.test(clean) && !/\b(?:not\s+done|incomplete)\b/i.test(clean);
	if (done) return { status: "completed", statusText: clean };
	if (/🔧|🛠|🔨|\bfixing\b|修复/i.test(clean)) return { status: "fixing", statusText: clean };
	if (/⚠️|🟡|\bblocked\b|阻塞|问题/i.test(clean)) return { status: "warning", statusText: clean };
	if (/📋|\bactive\b|进行中/i.test(clean)) return { status: "active", statusText: clean };
	return { status: "pending", statusText: clean || "待办" };
}

/** 解析 `### Item NN — 标题` 格式的文本块 */
function parseHeaderDialect(content: string): ParsedTaskItem[] {
	const items: ParsedTaskItem[] = [];
	
	// 严格匹配行首的 ## Active Tasks 或 ## 待办事项，避免被代码块或维护规则正文误触
	const sectionRegex = /(?:^|\n)##\s+(?:Active\s+Tasks|待办事项)[^\n]*\n([\s\S]*?)(?=\n##\s+[^#]|$)/i;
	const match = content.match(sectionRegex);
	const targetText = match ? match[1] : content;

	// 切分每一个 ### Item
	const rawBlocks = targetText.split(/\n(?=###\s+)/);
	for (const block of rawBlocks) {
		const trimmed = block.trim();
		if (!trimmed.startsWith("###")) continue;

		const lines = trimmed.split("\n");
		const headerLine = lines[0];

		// 匹配 ### Item 3549 — 标题 或 ### Item NN: 标题
		const cleanHeader = headerLine.replace(/^###\s+/, "").trim();
		const headerMatch = cleanHeader.match(/^(Item\s+\d+|[^\s—:-]+)[\s—:-]+(.*)$/i);
		const id = headerMatch ? headerMatch[1].trim() : cleanHeader.slice(0, 15);
		const title = headerMatch ? headerMatch[2].trim() : cleanHeader;

		// 排除示例或非真实 Item（如 ### Item NN — 标题）
		if (/^Item\s+NN/i.test(id)) continue;

		let priority = "P2";
		let summary = "";
		let status: ParsedTaskItem["status"] = "pending";
		let statusText = "";

		for (let i = 1; i < lines.length; i++) {
			const l = lines[i].trim();
			if (l.match(/^-\s+\*\*(?:评级|优先级)\*\*[:：]/i)) {
				priority = parsePriority(l);
			} else if (l.match(/^-\s+\*\*(?:任务简报索引|简报|摘要)\*\*[:：]/i)) {
				summary = l.replace(/^-\s+\*\*(?:任务简报索引|简报|摘要)\*\*[:：]\s*/i, "").trim();
			} else if (l.match(/^-\s+\*\*(?:状态|进度|Status)\*\*[:：]/i)) {
				const raw = l.replace(/^-\s+\*\*(?:状态|进度|Status)\*\*[:：]\s*/i, "").trim();
				const parsed = parseStatus(raw);
				status = parsed.status;
				statusText = parsed.statusText;
			}
		}

		if (id && title) {
			items.push({
				id,
				title,
				priority,
				status,
				statusText: statusText || (status === "active" ? "📋 进行中" : "待处理"),
				summary: summary || title,
			});
		}
	}

	return items;
}

/** 主解析入口（never-throw） */
export function parseWorkspaceOverview(cwd: string): WorkspaceOverviewData {
	try {
		const filePath = findTrackerFile(cwd);
		if (!filePath) {
			return { cwd, found: false, tasks: [] };
		}

		const stat = statSync(filePath);
		const fd = readFileSync(filePath, "utf8");

		const tasks = parseHeaderDialect(fd);

		return {
			cwd,
			found: true,
			filePath,
			fileMtimeMs: stat.mtimeMs,
			tasks,
			rawSnippet: fd.slice(0, 2000),
		};
	} catch (err) {
		return { cwd, found: false, tasks: [] };
	}
}
