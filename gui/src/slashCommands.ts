/**
 * gui/src/slashCommands.ts — 斜杠命令补全的纯逻辑（2026-10-20）。
 *
 * 抽成纯函数的原因：这些判定（何时该弹补全、怎么排序、怎么插入）是**行为契约**，
 * 必须能脱离 React 直接单测（与 chatAutoExpand.ts 同一范式）。
 *
 * ## 三种 source 语义不同（读 pi 源码 agent-session.js::_bindExtensionCore）
 *   - `extension`：真命令，`_tryExecuteExtensionCommand` 拦截 ⇒ **不落对话记录**
 *   - `skill` / `prompt`：会被**展开成正文** ⇒ 在对话流里留下一条消息
 * 混在一起显示是语义欺骗，故排序把 extension 放前面，且 UI 标注后两者。
 */

import type { CommandsSnapshot } from "./api/types";

export type CommandEntry = CommandsSnapshot["commands"][number];

/** source 的展示权重（小的在前）。extension 是真命令，优先。 */
const SOURCE_RANK: Record<string, number> = {
	extension: 0,
	builtin: 1,
	skill: 2,
	prompt: 3,
	other: 4,
};

/**
 * 当前 draft 是否处于「命令补全态」。
 *
 * 判定：以 `/` 开头，且**尚未输入空格**（一旦有空格就是参数段，不再补全命令名）。
 * 另外 `//` 开头不算（那是路径/注释习惯，不是命令）。
 */
export function parseSlashDraft(text: string): { active: boolean; prefix: string } {
	if (!text.startsWith("/")) return { active: false, prefix: "" };
	if (text.startsWith("//")) return { active: false, prefix: "" };
	const body = text.slice(1);
	if (body.includes(" ") || body.includes("\n")) return { active: false, prefix: "" };
	return { active: true, prefix: body };
}

/**
 * 过滤 + 排序候选命令。
 *
 * 排序：先按 source 权重，再按名字字典序。前缀完全匹配的排最前（用户打得越多越精确）。
 * 大小写：命令名按 pi 的口径**精确匹配**（`getCommand` 是 `invocationName === name`），
 * 但补全输入按小写比较更友好（用户打 `/MOD` 也该看到 `/model`）。
 */
export function filterCommands(commands: readonly CommandEntry[], prefix: string): CommandEntry[] {
	const p = prefix.toLowerCase();
	const hit = commands.filter((c) => c.name.toLowerCase().startsWith(p));
	// 完全相等优先（打全了就直接顶到第一，回车即选）
	hit.sort((a, b) => {
		const aExact = a.name.toLowerCase() === p ? 0 : 1;
		const bExact = b.name.toLowerCase() === p ? 0 : 1;
		if (aExact !== bExact) return aExact - bExact;
		const ar = SOURCE_RANK[a.source] ?? 9;
		const br = SOURCE_RANK[b.source] ?? 9;
		if (ar !== br) return ar - br;
		return a.name.localeCompare(b.name);
	});
	return hit;
}

/**
 * 选中某条命令后的新 draft 文本。
 *
 * 末尾补一个空格：命令名后一般要跟参数，且**补上空格才能退出补全态**
 * （否则面板会一直挂着）。
 */
export function applyCommandSelection(name: string): string {
	return `/${name} `;
}

/**
 * source 的 UI 标注（`null` = 不需要标注，即真命令）。
 *
 * 为什么必须标注：`skill`/`prompt` 会被展开成正文写进对话记录，
 * 用户以为在「执行命令」，实际在「插入一大段文字」。
 */
export function sourceHint(source: CommandEntry["source"]): string | null {
	if (source === "extension" || source === "builtin") return null;
	if (source === "skill") return "插入正文";
	if (source === "prompt") return "插入正文";
	return "未知来源";
}

/** 键盘动作判定（纯函数，便于测）。 */
export type SlashKeyAction = "up" | "down" | "accept" | "dismiss" | "none";

export function slashKeyAction(
	key: string,
	opts: { open: boolean; candidateCount: number },
): SlashKeyAction {
	if (!opts.open) return "none";
	if (key === "Escape") return "dismiss";
	if (key === "ArrowUp") return "up";
	if (key === "ArrowDown") return "down";
	// Enter / Tab 只在有候选时接受（没候选就让 Enter 正常发消息）
	if ((key === "Enter" || key === "Tab") && opts.candidateCount > 0) return "accept";
	return "none";
}

/** 移动选中下标（循环）。-1 表示未选。 */
export function moveIndex(current: number, delta: 1 | -1, count: number): number {
	if (count <= 0) return -1;
	if (current < 0) return delta === 1 ? 0 : count - 1;
	return (current + delta + count) % count;
}
