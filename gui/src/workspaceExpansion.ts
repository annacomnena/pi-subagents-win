/**
 * gui/src/workspaceExpansion.ts — 组折叠态持久化（JSX-free，供 SessionList 与
 * _test_workspace_group G6 共用；模式抄 zcode-workspace-expansion）。
 *
 * localStorage key `saw-ws-expansion`，值 = `Record<cwdKey, boolean>`（false=收起，
 * 缺省=展开）。读写容错：解析失败/非对象 → 空态；prune 清理已消失的组键并以 500 项上限落盘。
 */

export const STORAGE_KEY = "saw-ws-expansion";
/** Hard cap prevents a corrupted or unusually large workspace history from exhausting localStorage. */
export const MAX_PERSISTED_GROUPS = 500;

/** 读取折叠态；无数据/坏 JSON/非对象 → 空 Record（不抛）。 */
export function loadExpansionState(): Record<string, boolean> {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw === null) return {};
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const out: Record<string, boolean> = {};
		for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
			if (typeof v === "boolean") out[k] = v;
		}
		return out;
	} catch {
		return {};
	}
}

/** 落盘折叠态；存储异常（隐私模式/配额）静默吞掉，不影响 UI 交互。 */
export function saveExpansionState(state: Record<string, boolean>): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
	} catch {
		/* best effort */
	}
}

/**
 * 清理已消失的组键并限制最多 500 条（入参 liveKeys 为当前存活组键集合）；
 * 有变化才落盘；返回清理后的新对象。
 */
export function pruneExpansionState(
	state: Record<string, boolean>,
	liveKeys: Iterable<string>,
): Record<string, boolean> {
	const live = new Set(liveKeys);
	let dirty = false;
	let count = 0;
	const out: Record<string, boolean> = {};
	for (const [k, v] of Object.entries(state)) {
		if (!live.has(k) || v !== false || count >= MAX_PERSISTED_GROUPS) {
			dirty = true;
			continue;
		}
		out[k] = v;
		count += 1;
	}
	if (dirty) saveExpansionState(out);
	return out;
}
