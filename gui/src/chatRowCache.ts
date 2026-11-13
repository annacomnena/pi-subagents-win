/**
 * gui/src/chatRowCache.ts — 会话行缓存的有界收敛（纯函数，零依赖）
 *
 * 为什么需要（2026-11-13 内存审计）：
 *   `store.ts` 的 `chatRowsBySession` 是「会话 → 投影行」的永久缓存 —— 每访问一个会话就
 *   多留一份全量行，**全仓没有任何淘汰路径**。实测单会话 6344 行 ≈ 6.4MB JS 堆（叠加
 *   29 万 DOM 节点后整页 306MB）。翻十几个大会话即数百 MB，且只有刷新页面才释放。
 *
 * 设计取舍（显式登记）：
 *   1. **淘汰的判据是「最近使用」，不是「最近打开」**：`reloadChatSession` / `resyncChatSession` /
 *      WS 增量帧都会 touch，所以正在活跃收流的会话不会被淘汰。
 *   2. **`activeId` 永远保留**（即便它不在最近 N 个之内）—— 淘汰当前正在看的会话 =
 *      界面空一屏，比多占几 MB 更糟。
 *   3. **一次性丢弃整组 chat slice 的 per-session 字段**（rows/head/seq/hasOlder/tail），
 *      不能只丢 rows：留着旧 head 会让 `resyncChatSession` 走 delta 分支，把增量合并进
 *      空数组 ⇒ 界面只剩半屏（这是「为了省内存反而弄坏数据」的典型坑）。
 *   4. **代价（明确接受）**：被淘汰的会话再次打开时 tail 从 `TAIL_FIRST`(200) 重新开始，
 *      用户需重新点「加载更早」。这是有界内存的必然代价，且不影响正确性（服务端是真相源）。
 *
 * 不放进 React state：访问序每次写行都会变，放进 state 会多一轮无关重渲染。
 */

/** 最多缓存的会话数（含 activeId）。5 个大会话 ≈ 32MB 上界，对现代浏览器可控。 */
export const MAX_CACHED_CHAT_SESSIONS = 5;

/**
 * 把 `id` 标记为「最近使用」（移到末尾）。返回新数组（不原地改，便于断言与浅比较）。
 * 已在末尾时不产生新数组 —— 高频 WS 帧下省一次分配。
 */
export function touchChatRecency(order: readonly string[], id: string): readonly string[] {
	if (!id) return order;
	const last = order[order.length - 1];
	if (last === id) return order;
	const next = order.filter((x) => x !== id);
	next.push(id);
	return next;
}

/**
 * 计算需要淘汰的会话 id（最久未用在前）。
 *
 * @param order   访问序（末尾 = 最近使用）
 * @param activeId 当前活跃会话（永远保留；null/空串表示无）
 * @param max     保留上限
 * @returns 需要从缓存中删除的 id 列表；无淘汰时返回空数组
 */
export function sessionsToEvict(
	order: readonly string[],
	activeId: string | null | undefined,
	max: number = MAX_CACHED_CHAT_SESSIONS,
): string[] {
	if (max <= 0) return [...order];
	const keep = new Set<string>(order.slice(Math.max(0, order.length - max)));
	if (activeId) keep.add(activeId);
	if (keep.size >= order.length) return [];
	return order.filter((id) => !keep.has(id));
}
