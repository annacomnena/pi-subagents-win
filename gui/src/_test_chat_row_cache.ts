/**
 * _test_chat_row_cache.ts — 会话行缓存 LRU 的纯函数契约（2026-11-13 内存审计）
 *
 * 锁定的四条语义（改任何一条都必须同步改 `chatRowCache.ts` 头注的取舍说明）：
 *   C1 访问序：已在末尾 ⇒ 返回同一引用（高频 WS 帧下不多分配）；否则移到末尾、不重复
 *   C2 未超上限 ⇒ 一个都不淘汰（含「刚好等于上限」这个边界）
 *   C3 `activeId` 永远保留 —— 即便它是最久未用的那个（淘汰当前会话 = 空一屏）
 *   C4 超上限 ⇒ 从最久未用开始淘汰，且淘汰列表不含 activeId、不含重复
 *
 * 运行：npm run test:gui-chat-row-cache（gui 目录内）
 */

import assert from "node:assert/strict";
import {
	MAX_CACHED_CHAT_SESSIONS,
	sessionsToEvict,
	touchChatRecency,
} from "./chatRowCache.ts";

let n = 0;
const ok = (name: string): void => {
	n += 1;
	console.log(`ok ${n} - ${name}`);
};

// ── C1 访问序 ─────────────────────────────────────────────────────
{
	const order = ["a", "b", "c"];
	assert.deepEqual(touchChatRecency(order, "a"), ["b", "c", "a"]);
	ok("C1a 已有会话被 touch ⇒ 移到末尾");
	assert.deepEqual(touchChatRecency(order, "c"), ["a", "b", "c"]);
	ok("C1b 已在末尾 ⇒ 顺序不变");
	assert.equal(touchChatRecency(order, "c"), order);
	ok("C1c 已在末尾 ⇒ 返回同一引用（省一次分配）");
	assert.deepEqual(touchChatRecency(order, "d"), ["a", "b", "c", "d"]);
	ok("C1d 新会话 ⇒ 追加到末尾");
	assert.equal(touchChatRecency(order, ""), order);
	ok("C1e 空 id ⇒ no-op");
	// 不重复：同一 id 反复 touch 只留一份
	const again = touchChatRecency(touchChatRecency(order, "a"), "a");
	assert.deepEqual(again, ["b", "c", "a"]);
	ok("C1f 同一 id 反复 touch ⇒ 只留一份（不膨胀）");
	assert.deepEqual(order, ["a", "b", "c"]);
	ok("C1g 不改入参（纯函数）");
}

// ── C2 未超上限 ───────────────────────────────────────────────────
{
	const m = MAX_CACHED_CHAT_SESSIONS;
	const full = Array.from({ length: m }, (_, i) => `s${i}`);
	assert.deepEqual(sessionsToEvict(full, full[0]), []);
	ok(`C2a 刚好 ${m} 个 ⇒ 零淘汰（边界）`);
	assert.deepEqual(sessionsToEvict(["s0"], null), []);
	ok("C2b 1 个 ⇒ 零淘汰");
	assert.deepEqual(sessionsToEvict([], "s0"), []);
	ok("C2c 空序 ⇒ 零淘汰");
}

// ── C3 activeId 保护 ──────────────────────────────────────────────
{
	const m = MAX_CACHED_CHAT_SESSIONS;
	const order = Array.from({ length: m + 2 }, (_, i) => `s${i}`); // s0 最久未用
	const drop = sessionsToEvict(order, "s0");
	assert.ok(!drop.includes("s0"), "activeId 不得被淘汰");
	ok("C3a activeId 是最久未用 ⇒ 仍保留");
	// 保留 = 最近 5 个(s2..s6) ∪ {active s0} ⇒ 只淘汰 s1；缓存实际容量 = 上限 + 1（active）
	assert.deepEqual(drop, ["s1"]);
	ok("C3b 保留 activeId + 最近 N ⇒ 只淘汰夹在中间的那个（容量 = N+1）");
	// activeId 为空/undefined 时不保护任何东西
	assert.deepEqual(sessionsToEvict(order, null), ["s0", "s1"]);
	ok("C3c activeId=null ⇒ 不额外保护（淘汰最久 2 个）");
}

// ── C4 超上限淘汰顺序与去重 ───────────────────────────────────────
{
	const order = ["old1", "old2", "old3", "new1", "new2", "new3", "new4"];
	const drop = sessionsToEvict(order, "new4");
	assert.deepEqual(drop, ["old1", "old2"]);
	ok("C4a 7 个 / 上限 5 ⇒ 淘汰最久 2 个，顺序最久在前");
	assert.equal(new Set(drop).size, drop.length);
	ok("C4b 淘汰列表无重复");
	// max 参数可覆盖（便于将来调参而不动逻辑）
	assert.deepEqual(sessionsToEvict(order, "new4", 2), ["old1", "old2", "old3", "new1", "new2"]);
	ok("C4c max=2 ⇒ 上限可注入");
	assert.deepEqual(sessionsToEvict(["a", "b"], null, 0), ["a", "b"]);
	ok("C4d max=0 ⇒ 全淘汰（合法但不用于生产）");
}

// ── C5 收敛性：反复 touch 不产生无限淘汰列表 ──────────────────────
{
	let order: readonly string[] = [];
	for (let i = 0; i < 50; i += 1) {
		order = touchChatRecency(order, `s${i % 12}`);
		const drop = sessionsToEvict(order, `s${i % 12}`);
		if (drop.length > 0) {
			const gone = new Set(drop);
			order = order.filter((id) => !gone.has(id));
		}
	}
	assert.ok(order.length <= MAX_CACHED_CHAT_SESSIONS + 1, `稳态应 ≤ 上限+1，实际 ${order.length}`);
	ok(`C5 12 个会话反复访问 50 次 ⇒ 稳态 ${order.length} 条（有界）`);
}

console.log("chat-row-cache tests passed");
