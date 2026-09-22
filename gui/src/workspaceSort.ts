/**
 * gui/src/workspaceSort.ts — 组内排序维度持久化（JSX-free，供 SessionList 与
 * _test_workspace_group G8 共用；localStorage 机制同 saw-ws-expansion，sortBy 字段
 * 语义抄 zcode sidebarTaskPreferences 的 sortBy + 默认 updated）。
 *
 * localStorage key `saw-ws-sort`，值 = "updated" | "created"（单值，非对象）。默认 updated
 * （最近活动优先，与 workspaceGroup 的默认一致）。读写容错：无数据/坏 JSON/非合法值 →
 * 默认 updated；写入异常（隐私模式/配额）静默吞掉，不阻断侧栏交互。
 */

import type { SessionSortBy } from "./workspaceGroup";

/** 组内排序持久化 key（同 saw-ws-* 命名族；与 saw-ws-expansion 无存储冲突）。 */
export const STORAGE_KEY = "saw-ws-sort";

/** 默认排序维度 = updated（最近活动优先）。 */
export const DEFAULT_SORT_BY: SessionSortBy = "updated";

function isSessionSortBy(value: unknown): value is SessionSortBy {
	return value === "updated" || value === "created";
}

/** 读取组内排序维度；无数据/坏 JSON/非合法值 → 默认 updated（不抛）。 */
export function loadSortBy(): SessionSortBy {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw === null) return DEFAULT_SORT_BY;
		const parsed: unknown = JSON.parse(raw);
		return isSessionSortBy(parsed) ? parsed : DEFAULT_SORT_BY;
	} catch {
		return DEFAULT_SORT_BY;
	}
}

/** 落盘组内排序维度；存储异常（隐私模式/配额）静默吞掉，不影响 UI 交互。 */
export function saveSortBy(sortBy: SessionSortBy): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(sortBy));
	} catch {
		/* best effort */
	}
}
