/**
 * gui/src/workspaceRailExpand.ts — 会话 rail 两组 localStorage 展开态（JSX-free，供
 * SessionList 与 _test_workspace_group P 段共用；机制同 saw-ws-expansion：tolerant 读、
 * 坏 JSON 容错、prune 清理失效组键、500 项上限、写异常静默吞）。
 *
 * 两个 key（值均为 Record<cwdKey, boolean>，true=展开——与 saw-ws-expansion 的
 * false=收起 相反，因为这两个场景的缺省是「收起」，只有非缺省 true 值得持久化）：
 *   - `saw-ws-overflow`  ：组内「还有 N 个 · 展开查看全部」展开态（每组最多 6 个的截断开关）；
 *   - `saw-ws-tabgroups` ：全派发 tab 组（titleSource==='ledger'）的用户显式展开态
 *                          （此类组首次加载默认折叠；混合组不写此 key，仍走 saw-ws-expansion）。
 * prune 只保留 true 条目（false/缺省即默认收起，冗余值清理，同 saw-ws-expansion 清冗余 true 的对偶）。
 */

/** 组内 6 个截断的展开开关 key（saw-ws-* 命名族；与 saw-ws-expansion 无存储冲突）。 */
export const OVERFLOW_KEY = "saw-ws-overflow";
/** 全 tab 组用户显式展开态 key。 */
export const TABGROUP_KEY = "saw-ws-tabgroups";
/** 与 saw-ws-expansion 同上限：防损坏/异常大的历史记录耗尽 localStorage 配额。 */
export const MAX_PERSISTED_GROUPS = 500;

/** 读取展开态（key 指定）；无数据/坏 JSON/非对象 → 空 Record（不抛）；仅保留布尔 true 值。 */
export function loadRailExpand(key: string): Record<string, boolean> {
	try {
		const raw = localStorage.getItem(key);
		if (raw === null) return {};
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const out: Record<string, boolean> = {};
		for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
			if (v === true) out[k] = true;
		}
		return out;
	} catch {
		return {};
	}
}

/** 落盘展开态；存储异常（隐私模式/配额）静默吞掉，不影响 UI 交互。 */
export function saveRailExpand(key: string, state: Record<string, boolean>): void {
	try {
		localStorage.setItem(key, JSON.stringify(state));
	} catch {
		/* best effort */
	}
}

/**
 * 清理已消失的组键并限制最多 500 条（liveKeys = 当前存活组键集合）；
 * 仅保留 true 条目（false 即默认收起，冗余值清理）；有变化才落盘；返回清理后的新对象。
 */
export function pruneRailExpand(
	key: string,
	state: Record<string, boolean>,
	liveKeys: Iterable<string>,
): Record<string, boolean> {
	const live = new Set(liveKeys);
	let dirty = false;
	let count = 0;
	const out: Record<string, boolean> = {};
	for (const [k, v] of Object.entries(state)) {
		if (!live.has(k) || v !== true || count >= MAX_PERSISTED_GROUPS) {
			dirty = true;
			continue;
		}
		out[k] = v;
		count += 1;
	}
	if (dirty) saveRailExpand(key, out);
	return out;
}
