/**
 * _test_chat_row_cache_wiring.ts — 行缓存淘汰的**接线**级回归（2026-11-13 内存审计）
 *
 * 为什么需要单独一条（AGENTS.md §4.2）：纯函数测试只证明 `chatRowCache.ts` 算得对，
 * **不证明 store 真的调用了它、以及真的把六个 per-session map 一起删掉**。
 * 变异「store 里删掉 pruneChatCaches 调用」时，纯函数测试仍会全绿 —— 那种测试是无判别力的。
 *
 * 本文件直接驱动真实 store action，锁定：
 *   W1 超上限 ⇒ 最久未用的会话在**全部** per-session 字段里同时消失（不留半截 head）
 *   W2 最近使用的会话不受影响（数据不丢）
 *   W3 activeId 永远不被淘汰
 *   W4 notifyOffsetBySession 不被清（它是去重指针，清了会重弹 toast）
 *
 * 运行：npm run test:gui-chat-row-cache-wiring
 */

import assert from "node:assert/strict";
import { register } from "node:module";

// gui/src 按 vite/bundler 惯例 extensionless 相对导入 → 复用 store 测试 resolve hook 补 .ts
register("../../extensions/_gui_store_ts_loader.mjs", import.meta.url);

const { useGui } = await import("./store.ts");
const { MAX_CACHED_CHAT_SESSIONS } = await import("./chatRowCache.ts");
const { api } = await import("./api/client.ts");

let n = 0;
const ok = (name: string): void => {
	n += 1;
	console.log(`ok ${n} - ${name}`);
};

const row = (id: string): { rowId: string; kind: string } =>
	({ rowId: id, kind: "assistant" }) as unknown as { rowId: string; kind: string };

// 造 7 个会话（超过上限 5），全部写满六个 per-session 字段 —— 形状与真实写入路径一致
const ids = Array.from({ length: MAX_CACHED_CHAT_SESSIONS + 2 }, (_, i) => `sid-${i}`);
const seed = () => {
	const s = useGui.getState();
	s.chatRowsBySession = {};
	s.chatHeadBySession = {};
	s.chatSeqBySession = {};
	s.chatHasOlderBySession = {};
	s.chatTailBySession = {};
	s.chatUsageBySession = {};
	s.notifyOffsetBySession = {};
	for (const id of ids) {
		s.chatRowsBySession[id] = [row(`${id}-r1`), row(`${id}-r2`)] as never;
		s.chatHeadBySession[id] = { seq: 2, logEpoch: "e", gen: 1 } as never;
		s.chatSeqBySession[id] = 2;
		s.chatHasOlderBySession[id] = true;
		s.chatTailBySession[id] = 400;
		s.chatUsageBySession[id] = { input: 1 } as never;
		s.notifyOffsetBySession[id] = 1024;
	}
};
seed();
useGui.setState({ chatActiveId: ids[0] }); // 最久未用同时又是 active ⇒ W3 的强条件

// 按访问序 0..6 依次 touch（末尾 = 最近使用），最后落在最后一个
for (const id of ids) useGui.getState().pruneChatCaches(id);

const st = useGui.getState();
// 上限 5 + active 1 ⇒ 7 个里最多保留 6 个，最久未用的 s0 是 active（保留）⇒ 被淘汰的是 s1
const evicted = ids.filter((id) => st.chatRowsBySession[id] === undefined);
assert.ok(evicted.length > 0, "W1 超过上限必须发生淘汰（否则调用没接上）");
for (const id of evicted) {
	assert.equal(st.chatHeadBySession[id], undefined, `W1 ${id} 的 head 必须同时删除（留半截 head ⇒ delta 合并进空数组）`);
	assert.equal(st.chatSeqBySession[id], undefined, `W1 ${id} 的 seq 必须同时删除`);
	assert.equal(st.chatHasOlderBySession[id], undefined, `W1 ${id} 的 hasOlder 必须同时删除`);
	assert.equal(st.chatTailBySession[id], undefined, `W1 ${id} 的 tail 必须同时删除`);
	assert.equal(st.chatUsageBySession[id], undefined, `W1 ${id} 的 usage 必须同时删除`);
}
ok(`W1 淘汰 ${evicted.length} 个会话，六个 per-session 字段同步删除（无半截状态）`);

// W2：最近使用的必须完好
const newest = ids[ids.length - 1];
assert.equal(st.chatRowsBySession[newest]?.length, 2, "W2 最近使用的会话行不得被淘汰");
assert.equal(st.chatHeadBySession[newest]?.seq, 2, "W2 最近使用的会话 head 必须保留");
ok("W2 最近使用的会话数据完好（淘汰不误伤）");

// W3：activeId 永不被淘汰（即便它是最久未用的那个）
assert.ok(st.chatRowsBySession[ids[0]] !== undefined, "W3 activeId 不得被淘汰（否则界面空一屏）");
ok("W3 activeId（最久未用）仍被保留");

// W4：notify 去重指针不被清（清了会重弹已读 toast）
assert.equal(st.notifyOffsetBySession[ids[0]], 1024, "W4 notifyOffsetBySession 不得被淘汰");
for (const id of evicted) assert.equal(st.notifyOffsetBySession[id], 1024, `W4 ${id} 的 notify offset 不得被清`);
ok("W4 notifyOffsetBySession 不受淘汰影响");

// W5：稳态有界 —— 反复访问 20 个不同会话，缓存数不超过 上限 + active
const many = Array.from({ length: 20 }, (_, i) => `bulk-${i}`);
for (const id of many) {
	useGui.setState({ chatRowsBySession: { ...useGui.getState().chatRowsBySession, [id]: [row(`${id}-r`)] as never } });
	useGui.getState().pruneChatCaches(id);
}
const count = Object.keys(useGui.getState().chatRowsBySession).length;
assert.ok(
	count <= MAX_CACHED_CHAT_SESSIONS + 1,
	`W5 缓存必须收敛到 ≤ ${MAX_CACHED_CHAT_SESSIONS + 1}，实际 ${count}`,
);
ok(`W5 反复访问 20 个会话后缓存 ${count} 条（有界）`);

// ── W6/W7 调用点接线（真实 action，不直接调 pruneChatCaches）────────────
//
// 这一段才真正锁「store 里那四处 write 之后有没有调用」：W1-W5 直接调 action，
// 若有人删掉 `reloadChatSession` / `applyChatFrame` 里的调用，W1-W5 仍全绿。
{
	seed();
	useGui.setState({ chatActiveId: ids[ids.length - 1] });
	for (const id of ids) useGui.getState().pruneChatCaches(id); // 先建立满序

	// 打桩 HTTP：返回值形状与真实 TranscriptBody 一致
	const stub = async (sessionId: string) => ({
		ok: true as const,
		status: 200,
		at: new Date().toISOString(),
		data: {
			rows: [row(`${sessionId}-fresh`)],
			head: { seq: 1, logEpoch: "e", gen: 1 },
			hasOlder: false,
		},
	});
	(api as unknown as { transcript: unknown }).transcript = stub;

	// W6：reloadChatSession 必须触发淘汰（打开新会话 ⇒ 最久未用的被清）
	const newest = ids[ids.length - 1];
	const before = Object.keys(useGui.getState().chatRowsBySession).length;
	useGui.setState({ chatActiveId: newest });
	await useGui.getState().reloadChatSession("sid-new-via-reload");
	const after = useGui.getState().chatRowsBySession;
	assert.ok(
		after["sid-new-via-reload"] !== undefined,
		"W6 新会话必须被写入（否则本组无效）",
	);
	assert.equal(
		Object.keys(after).length,
		before,
		`W6 reloadChatSession 必须淘汰一个旧会话（前后都是 ${before}）`,
	);
	ok("W6 reloadChatSession 写入后触发淘汰（调用点已接线）");

	// W7：applyChatFrame 的 transcript 增量帧也必须触发淘汰
	const fresh = "sid-via-frame";
	const evictCountBefore = Object.keys(useGui.getState().chatRowsBySession).length;
	await useGui.getState().applyChatFrame({
		type: "event",
		topic: `transcript:${fresh}`,
		seq: 1,
		op: { kind: "row.appended", row: { rowId: `${fresh}-r`, kind: "assistant" } as never },
	} as never);
	const afterFrame = useGui.getState().chatRowsBySession;
	assert.ok(afterFrame[fresh] !== undefined, "W7 帧必须被应用（否则本组无效）");
	assert.equal(
		Object.keys(afterFrame).length,
		evictCountBefore,
		`W7 applyChatFrame 必须淘汰一个旧会话（前后都是 ${evictCountBefore}）`,
	);
	ok("W7 applyChatFrame 应用增量后触发淘汰（调用点已接线）");
}

// ── W8/W9 resync 的两个分支也必须接线（delta / 全量各一条）──────────────
{
	seed();
	useGui.setState({ chatActiveId: ids[ids.length - 1] });
	for (const id of ids) useGui.getState().pruneChatCaches(id);

	const stubDelta = async (sessionId: string) => ({
		ok: true as const,
		status: 200,
		at: new Date().toISOString(),
		data: {
			mode: "delta" as const,
			rows: [row(`${sessionId}-delta`)],
			head: { seq: 99, logEpoch: "e", gen: 1 },
		},
	});
	const stubFull = async (sessionId: string) => ({
		ok: true as const,
		status: 200,
		at: new Date().toISOString(),
		data: {
			mode: "full" as const,
			rows: [row(`${sessionId}-full`)],
			head: { seq: 99, logEpoch: "e", gen: 1 },
		},
	});
	const apiAny = api as unknown as { transcript: unknown };

	// W8：有 head（canDelta）⇒ delta 分支
	const deltaSid = "sid-resync-delta";
	apiAny.transcript = stubDelta;
	useGui.setState({
		chatHeadBySession: { ...useGui.getState().chatHeadBySession, [deltaSid]: { seq: 1, logEpoch: "e", gen: 1 } as never },
		chatSeqBySession: { ...useGui.getState().chatSeqBySession, [deltaSid]: 1 },
	});
	const beforeDelta = Object.keys(useGui.getState().chatRowsBySession).length;
	await useGui.getState().resyncChatSession(deltaSid);
	assert.ok(useGui.getState().chatRowsBySession[deltaSid] !== undefined, "W8 delta 分支必须写入（否则本组无效）");
	assert.equal(
		Object.keys(useGui.getState().chatRowsBySession).length,
		beforeDelta,
		`W8 resyncChatSession(delta) 必须淘汰一个旧会话（前后都是 ${beforeDelta}）`,
	);
	ok("W8 resyncChatSession 的 delta 分支触发淘汰");

	// W9：无 head ⇒ 全量分支
	const fullSid = "sid-resync-full";
	apiAny.transcript = stubFull;
	const beforeFull = Object.keys(useGui.getState().chatRowsBySession).length;
	await useGui.getState().resyncChatSession(fullSid);
	assert.ok(useGui.getState().chatRowsBySession[fullSid] !== undefined, "W9 全量分支必须写入（否则本组无效）");
	assert.equal(
		Object.keys(useGui.getState().chatRowsBySession).length,
		beforeFull,
		`W9 resyncChatSession(全量) 必须淘汰一个旧会话（前后都是 ${beforeFull}）`,
	);
	ok("W9 resyncChatSession 的全量分支触发淘汰");
}

console.log("chat-row-cache wiring tests passed");
