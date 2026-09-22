/**
 * hotspot/inject — 首轮用户消息附加 <system-reminder> 热点块
 *
 * v2 §5：新会话首次用户提交时附加一次；恢复已有会话/重试不重复；压缩后保留指针
 * 提示、需要时经工具重读；不修改全局 system prompt；模板安全编码字段防提前闭合。
 * 这是本模块唯一的自动行为（2026-09-17 裁决：不加工具调用提醒）。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isSubagent } from "../identity.ts";
import { computeHeat, recentActivitySummary, type RecentActivity } from "./heat.ts";
import { logEvent } from "./log.ts";
import { findRepoRoot, hotspotPath, readHotspot } from "./store.ts";
import {
	DEFAULT_INJECT_CHAR_BUDGET,
	FIXED_PREAMBLE_CHARS,
	INJECT_CUSTOM_TYPE,
	type HotspotEntry,
} from "./types.ts";

/** 防 `</system-reminder>` 提前闭合：字段值中的 `<` 替换为全角。 */
function esc(s: string): string {
	return s.replace(/</g, "＜");
}

export interface InjectionPlan {
	selected: HotspotEntry[];
	omitted: HotspotEntry[];
	budgetChars: number;
	usedChars: number;
	degraded: string[];
}

/** 预算选择：固定说明预留后按完整条目选，超预算整条省略、不截断条目。 */
export function planInjection(root: string, entries: HotspotEntry[], budget = DEFAULT_INJECT_CHAR_BUDGET): InjectionPlan {
	const heat = computeHeat(root, entries);
	const selected: HotspotEntry[] = [];
	const omitted: HotspotEntry[] = [];
	const fixed = FIXED_PREAMBLE_CHARS;
	let used = fixed;
	for (const { entry } of heat.scored) {
		const size = renderEntry(entry).length;
		if (used + size > budget) {
			omitted.push(entry);
			continue;
		}
		used += size;
		selected.push(entry);
	}
	return { selected, omitted, budgetChars: budget, usedChars: used, degraded: heat.degraded };
}

function renderEntry(e: HotspotEntry): string {
	const lines: string[] = [`主题：${esc(e.title)}${e.scope ? `（${esc(e.scope)}）` : ""}`];
	for (const w of e.wiki) lines.push(`- Wiki：${esc(w.path)}${w.section ? ` → ${esc(w.section)}` : ""}`);
	for (const s of e.symbols) lines.push(`- 入口：${esc(s.path)}::${esc(s.name)}`);
	for (const ev of e.evidence) lines.push(`- 证据：${esc(ev.path)}${ev.section ? ` → ${esc(ev.section)}` : ""}`);
	return lines.join("\n");
}

export function renderReminder(root: string, revision: number, plan: InjectionPlan, activity?: RecentActivity): string {
	const body = plan.selected.map((e) => renderEntry(e)).join("\n\n");
	const actLines: string[] = [];
	if (activity?.tasks.length) actLines.push(`最近任务: ${activity.tasks.map(esc).join(" | ")}`);
	if (activity?.funcs.length) actLines.push(`最近改动: ${activity.funcs.map(esc).join(" | ")}`);
	return [
		"<system-reminder>",
		"以下是本仓库的热点路由缓存，仅用于定位；事实以源文件为准。",
		`仓库：${root}`,
		`热点文件：${hotspotPath(root)}`,
		`版本：${revision}`,
		...(actLines.length ? ["", ...actLines] : []),
		"",
		body,
		"",
		"优先使用精确入口；入口失效时扩大搜索，并遵守仓库的 CodeGraph 规则。",
		"</system-reminder>",
	].join("\n");
}

interface SessionEntryLike {
	type?: string;
	message?: { role?: string };
	customType?: string;
}

function hasUserMessage(entries: SessionEntryLike[]): boolean {
	return entries.some((e) => e.type === "message" && e.message?.role === "user");
}

function hasInjectMark(entries: SessionEntryLike[]): boolean {
	return entries.some((e) => e.type === "custom" && e.customType === INJECT_CUSTOM_TYPE);
}

/**
 * 注册注入钩子。仅主会话/标签页会话注册；子 agent 进程不注入
 * （v2 暂不包含“向子代理重复复制完整热点块”）。
 */
export function registerInject(pi: ExtensionAPI): void {
	if (isSubagent()) return;

	pi.on("session_start", async () => {
		// 热点内容缓存与热度信号缓存分离：每次会话启动失效，注入前现读现算。
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" } as const;
		const text = event.text ?? "";
		if (!text.trim() || text.trimStart().startsWith("/")) return { action: "continue" } as const;
		try {
			const entries = ctx.sessionManager.getEntries() as SessionEntryLike[];
			if (hasUserMessage(entries) || hasInjectMark(entries)) return { action: "continue" } as const;
		} catch {
			return { action: "continue" } as const; // 会话状态不可读时不注入（安全侧）
		}
		const root = findRepoRoot(ctx.cwd);
		const path = hotspotPath(root);
		const read = readHotspot(path);
		if (!read.exists || !read.file || read.file.entries.length === 0) return { action: "continue" } as const;
		const plan = planInjection(root, read.file.entries);
		if (plan.selected.length === 0) return { action: "continue" } as const;
		const activity = recentActivitySummary(root);
		const reminder = renderReminder(root, read.file.revision, plan, activity);
		try {
			ctx.sessionManager.appendCustomEntry(INJECT_CUSTOM_TYPE, {
				revision: read.file.revision,
				topicIds: plan.selected.map((e) => e.topicId),
				at: Date.now(),
			});
		} catch {
			/* 持久标识失败时 entries 检查仍兜底（用户消息即将入档） */
		}
		// 0922 ④：kind=inject 埋点（现类型有、调用无，research P0-3；给 P1 校准注入覆盖率/命中率）
		logEvent(root, { kind: "inject", topics: plan.selected.map((e) => e.topicId), revision: read.file.revision, ok: true });
		return { action: "transform", text: `${text}\n\n${reminder}` } as const;
	});

	// 压缩后：保留指针提示（不自动恢复全文；需要时 hotspot read 重读）。
	pi.on("session_before_compact", async (_event, ctx) => {
		try {
			const entries = ctx.sessionManager.getEntries() as SessionEntryLike[];
			if (!hasInjectMark(entries)) return;
		} catch {
			return;
		}
		const root = findRepoRoot(ctx.cwd);
		return {
			customInstructions:
				`压缩摘要请保留提示：本仓库存在热点路由缓存（${hotspotPath(root)}），需要定位活跃模块时用 hotspot 工具重新读取。`,
		};
	});
}
