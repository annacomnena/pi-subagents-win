/**
 * hotspot/usage — 使用度量（0922 组合计划 ④：hotspot_graph_plan §0.3/§1）
 *
 * `tool_execution_end` 命中热点条目路径或精确符号 → 记 `kind=used` 效果日志（新 kind）。
 * held-out 门控（拍板硬约束）：仅"独立外部工具调用"计 used；**排除 `hotspot`
 * 工具自身调用**——防"注入→自己 read→刷使用率"正反馈自嗨（论文 held-out：
 * 只算真实外部使用）。used 只进热度（heat.ts 14 天使用率项），不进存储。
 *
 * 事件形状说明：ToolExecutionEndEvent 只有 toolName/result/isError，无 args——
 * 因此 tool_execution_start 暂存 args（按 toolCallId 关联，有界 Map），end 时
 * 取回。失败调用（isError=true）不算"使用"。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findRepoRoot, hotspotPath, readHotspot } from "./store.ts";
import { logEvent } from "./log.ts";

/** held-out 门控：这些工具的调用不计 used（自身读写不算真实外部使用）。 */
export const USED_TOOL_EXCLUDE = new Set(["hotspot"]);

const ARG_MAP_LIMIT = 1024;

/** 路径归一为仓库相对（正斜杠）；root 外绝对路径 / 空 → null。 */
export function toRepoRelative(p: string, root: string): string | null {
	const norm = p.replace(/\\/g, "/").trim();
	if (!norm) return null;
	const rootNorm = root.replace(/\\/g, "/").replace(/\/+$/, "");
	if (norm.startsWith(`${rootNorm}/`)) return norm.slice(rootNorm.length + 1);
	// 非绝对路径（无盘符、无前导 /）→ 已是仓库相对（或至少同形），直接用
	if (!norm.startsWith("/") && !/^[A-Za-z]:/.test(norm)) return norm;
	return null;
}

/** 纯函数核心：给定工具名与 args，返回命中的主题 ID 列表（held-out 门控在此）。
 *  命中 = args.path（归一后）∈ 条目 wiki[].path / symbols[].path / evidence[].path，
 *  或 args.symbol 精确等于 `path::Symbol`（不接受裸 symbol，避免同名符号误计）。 */
export function matchUsedTopics(root: string, toolName: string, args: unknown): string[] {
	if (USED_TOOL_EXCLUDE.has(toolName)) return [];
	const a = (args ?? {}) as Record<string, unknown>;
	const p = typeof a.path === "string" ? a.path : null;
	const rel = p ? toRepoRelative(p, root) : null;
	const symbol = typeof a.symbol === "string" ? a.symbol.replace(/\\/g, "/").trim() : null;
	if (!rel && !symbol) return [];
	const read = readHotspot(hotspotPath(root));
	if (!read.exists || !read.file) return [];
	const out: string[] = [];
	for (const e of read.file.entries) {
		const set = new Set<string>();
		for (const r of e.wiki) set.add(r.path);
		for (const s of e.symbols) set.add(s.path);
		for (const ev of e.evidence) set.add(ev.path);
		if ((rel && set.has(rel)) || (symbol && e.symbols.some((s) => `${s.path}::${s.name}` === symbol))) out.push(e.topicId);
	}
	return out;
}

/** 注册使用度量。任何异常静默（度量不得阻断工具执行）。 */
export function registerUsage(pi: ExtensionAPI): void {
	const pendingArgs = new Map<string, { path: string | null; symbol: string | null }>();

	pi.on("tool_execution_start", (event) => {
		try {
			const args = (event.args ?? {}) as Record<string, unknown>;
			const p = typeof args.path === "string" ? args.path : null;
			const symbol = typeof args.symbol === "string" ? args.symbol : null;
			pendingArgs.set(event.toolCallId, { path: p, symbol });
			if (pendingArgs.size > ARG_MAP_LIMIT) {
				const first = pendingArgs.keys().next().value;
				if (first !== undefined) pendingArgs.delete(first); // 有界，防泄漏
			}
		} catch {
			/* 静默 */
		}
	});

	pi.on("tool_execution_end", (event) => {
		try {
			const info = pendingArgs.get(event.toolCallId);
			pendingArgs.delete(event.toolCallId);
			if (!info) return;
			if (event.isError) return; // 失败调用不算"使用"
			if (USED_TOOL_EXCLUDE.has(event.toolName)) return; // held-out 门控
			if (!info.path && !info.symbol) return;
			const root = findRepoRoot(process.cwd());
			for (const topic of matchUsedTopics(root, event.toolName, { path: info.path, symbol: info.symbol })) {
				logEvent(root, { kind: "used", topic, action: event.toolName });
			}
		} catch {
			/* 静默 */
		}
	});
}
