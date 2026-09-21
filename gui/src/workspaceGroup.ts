/**
 * gui/src/workspaceGroup.ts — 左栏「按仓库分组会话」纯函数层（JSX-free，供 SessionList
 * 与 node 侧冒烟测试 _test_workspace_group 共用；组件 .tsx 无法被 --experimental-strip-types 直载）。
 *
 * 规则（plans/0922_workspace_group_plan.md 拍板 1/3/5/6）：
 *   - 分组键 = 归一化 cwd 全路径（`\`→`/`、Windows/UNC 路径全小写、去尾 `/`）；null/空 cwd → 「未分组」垫底组。
 *   - 显示名 = basename(cwd)（basename 自 SessionList 迁入此处分享）；组头 tooltip = 全路径兜冲突。
 *   - 组序 = 组内最大最近活动值降序（mtimeMs 缺失回退 startedAt），未分组恒垫底；组内默认 updated、
 *     可切 created（startedAt 降序）。
 *   - 过滤后组内空 → 整组隐藏（由调用方在 group 前 filter 实现，见 SessionList）。
 */

import type { SessionSummary } from "./api/types";

/** null cwd 的组键（未分组，恒垫底）。 */
export const UNGROUPED_KEY = "__ungrouped__";

/** 组内排序维度：updated = mtimeMs 降序（默认）；created = startedAt 降序。 */
export type SessionSortBy = "updated" | "created";

/** cwd → 分组键：反斜杠→正斜杠、Windows（含 UNC）全路径小写、去尾斜杠；null/空 → UNGROUPED_KEY。 */
export function normalizeCwdKey(cwd: string | null): string {
	if (cwd === null || cwd.trim() === "") return UNGROUPED_KEY;
	let norm = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
	if (norm === "") return UNGROUPED_KEY;
	// Windows 文件系统通常大小写不敏感；盘符和 UNC 均按 Windows 规则归一，POSIX 路径保留大小写。
	return /^[A-Za-z]:(?:\/|$)/.test(norm) || norm.startsWith("//") ? norm.toLowerCase() : norm;
}

/** 路径 basename（过滤框/组头显示名共用；null/空 → 空串）。 */
export function basename(p: string | null): string {
	if (p === null) return "";
	const norm = p.replace(/\\/g, "/").replace(/\/+$/, "");
	const idx = norm.lastIndexOf("/");
	return idx >= 0 ? norm.slice(idx + 1) : norm;
}

/** cwd → 组头显示名：basename；null/空 → 「未分组」。 */
export function cwdLabel(cwd: string | null): string {
	return normalizeCwdKey(cwd) === UNGROUPED_KEY ? "未分组" : basename(cwd);
}

export interface WorkspaceGroup {
	/** 归一化 cwd 全路径；null cwd → UNGROUPED_KEY。 */
	key: string;
	/** 显示名：basename(cwd)；未分组 → 「未分组」。 */
	label: string;
	/** 组头 tooltip：归一化 cwd 全路径；未分组 → undefined。 */
	tooltip: string | undefined;
	cwd: string | null;
	/** true = 未分组组（组头灰显 + Inbox 图标）。 */
	ungrouped: boolean;
	count: number;
	/** 组内最大最近活动毫秒值（mtimeMs，缺失/损坏时为 startedAt；空组为 0）。 */
	maxMtimeMs: number;
	sessions: SessionSummary[];
	/** 组内任一会话在 failedSessionIds 中（组头红点数据源；蓝点无数据源不渲染）。 */
	hasError: boolean;
}

/**
 * 按 cwd 分组 + 组内排序（组内空组不产出——调用方先 filter 或传入后此处过滤空组）。
 * failedSessionIds 为组头红点数据源（该会话 outbox 终态失败集，见 SessionList）。
 */
export function groupSessions(
	sessions: SessionSummary[],
	sortBy: SessionSortBy,
	failedSessionIds: ReadonlySet<string>,
): WorkspaceGroup[] {
	const byKey = new Map<string, { cwd: string | null; items: SessionSummary[] }>();
	for (const s of sessions) {
		const key = normalizeCwdKey(s.cwd);
		const bucket = byKey.get(key);
		if (bucket) bucket.items.push(s);
		else byKey.set(key, { cwd: s.cwd, items: [s] });
	}
	const groups: WorkspaceGroup[] = [];
	for (const [key, { cwd, items }] of byKey) {
		const sorted = [...items].sort((a, b) =>
			sortBy === "created"
				? startedMs(b) - startedMs(a)
				: updatedMs(b) - updatedMs(a),
		);
		let maxMtimeMs = 0;
		let hasError = false;
		for (const s of sorted) {
			if (updatedMs(s) > maxMtimeMs) maxMtimeMs = updatedMs(s);
			if (failedSessionIds.has(s.sessionId)) hasError = true;
		}
		groups.push({
			key,
			label: cwdLabel(cwd),
			tooltip: key === UNGROUPED_KEY ? undefined : normalizeCwdKey(cwd),
			cwd,
			ungrouped: key === UNGROUPED_KEY,
			count: sorted.length,
			maxMtimeMs,
			sessions: sorted,
			hasError,
		});
	}
	return groups;
}

/** 组序 = maxMtimeMs 降序；未分组组恒垫底。 */
export function sortGroups(groups: WorkspaceGroup[]): WorkspaceGroup[] {
	const normal = groups
		.filter((g) => !g.ungrouped)
		.sort((a, b) => b.maxMtimeMs - a.maxMtimeMs);
	const ungrouped = groups.filter((g) => g.ungrouped);
	return [...normal, ...ungrouped];
}

/** 最近活动优先文件 mtime；缺失/损坏时回退会话创建时间。 */
function updatedMs(s: SessionSummary): number {
	return Number.isFinite(s.mtimeMs) && s.mtimeMs > 0 ? s.mtimeMs : startedMs(s);
}

function startedMs(s: SessionSummary): number {
	const t = s.startedAt ? Date.parse(s.startedAt) : 0;
	return Number.isFinite(t) ? t : 0;
}
