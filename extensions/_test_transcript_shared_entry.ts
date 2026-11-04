/**
 * _test_transcript_shared_entry.ts — P1 试点验收（plans/20261104_gui_daemon_optimization_proposal.md §P1）
 *
 * 这条测试要证明的是**「只有一份实现」**，不是「两份实现行为一样」——所以判据是函数身份相等
 * （`===`），而不是逐 case 跑两边对拍。复制粘贴出来的实现永远不可能通过身份断言。
 *
 * 覆盖：
 *   A 唯一来源：shared / runtime 重导出 / gui 门面 三处的 applyTranscriptOp(s) 与
 *     EMPTY_TRANSCRIPT_VIEW 必须是**同一个引用**。
 *   B 真实入口：把 WS 帧喂进 GUI 的真实分发入口 `store.applyChatFrame`
 *     （不是直接调 reducer），断言 chatRowsBySession 的最终形状。
 *     覆盖 appended 幂等 / upserted 替换 / delta 只追加文本行 / removed 屏障 /
 *     seq 倒退拒绝（这五条是 reducer 契约在**接线层**的体现）。
 *   C 服务端入口由 `test:runtime-host-ws` 覆盖（真实 WS subscribe → 帧 → applyTranscriptOps），
 *     本文件不重复造；这里只断言两端的函数是同一引用，等价性由身份推导。
 *
 * 运行：npm run test:transcript-shared
 */

import assert from "node:assert/strict";
import { register } from "node:module";

register("./_gui_store_ts_loader.mjs", import.meta.url);

const shared = await import("../shared/transcript/model.ts");
const runtime = await import("./runtime/transcript.ts");
const guiShim = await import("../gui/src/api/transcript.ts");
const { useGui } = await import("../gui/src/store.ts");

type TranscriptRow = import("../shared/transcript/model.ts").TranscriptRow;
type TranscriptOp = import("../shared/transcript/model.ts").TranscriptOp;

let n = 0;
const ok = (name: string) => {
	n++;
	console.log(`ok ${n} - ${name}`);
};

// ── A 唯一来源（身份相等）──────────────────────────────────────────
{
	assert.equal(runtime.applyTranscriptOp, shared.applyTranscriptOp, "runtime 与 shared 必须是同一函数");
	assert.equal(runtime.applyTranscriptOps, shared.applyTranscriptOps, "runtime 与 shared 必须是同一函数");
	assert.equal(guiShim.applyTranscriptOp, shared.applyTranscriptOp, "gui 门面与 shared 必须是同一函数");
	assert.equal(guiShim.applyTranscriptOps, shared.applyTranscriptOps, "gui 门面与 shared 必须是同一函数");
	assert.equal(runtime.EMPTY_TRANSCRIPT_VIEW, shared.EMPTY_TRANSCRIPT_VIEW, "空 view 必须是同一对象");
	assert.equal(guiShim.EMPTY_TRANSCRIPT_VIEW, shared.EMPTY_TRANSCRIPT_VIEW, "空 view 必须是同一对象");
	ok("A 三处调用点指向同一份实现（函数/常量引用相等，复制实现不可能通过）");
}

// ── B 真实入口：WS 帧 → store.applyChatFrame ───────────────────────
const row = (over: Partial<TranscriptRow> & { rowId: string }): TranscriptRow =>
	({ kind: "assistantText", turnIndex: 1, at: "2026-11-04T00:00:00.000Z", text: "x", ...over }) as TranscriptRow;

let sidSeq = 0;
const newSid = () => `sess-${++sidSeq}`;

/** 走 GUI 的真实帧分发入口（与 useEventStream.onFrame → store 的接线同一函数）。 */
async function feed(sid: string, seq: number, op: TranscriptOp): Promise<void> {
	await useGui.getState().applyChatFrame({ type: "event", topic: `transcript:${sid}`, seq, op });
}
const rowsOf = (sid: string): TranscriptRow[] => useGui.getState().chatRowsBySession[sid] ?? [];

{
	// B1 appended + 重放幂等（同 rowId 不同 seq 再来一次，行数不增）
	const sid = newSid();
	await feed(sid, 1, { kind: "row.appended", row: row({ rowId: "a1", text: "hello" }) });
	await feed(sid, 2, { kind: "row.appended", row: row({ rowId: "a1", text: "hello" }) });
	assert.deepEqual(rowsOf(sid).map((r) => r.rowId), ["a1"], "重复 appended 不增行");
	assert.equal(rowsOf(sid)[0]!.text, "hello");
	ok("B1 WS appended 经 applyChatFrame 落 store；重复 rowId 不增行");
}

{
	// B2 upserted：已存在 → 原位替换（行数不变、顺序不变）
	const sid = newSid();
	await feed(sid, 1, { kind: "row.appended", row: row({ rowId: "a1", text: "partial" }) });
	await feed(sid, 2, { kind: "row.appended", row: row({ rowId: "a2", text: "second" }) });
	await feed(sid, 3, { kind: "row.upserted", row: row({ rowId: "a1", text: "final" }) });
	assert.deepEqual(rowsOf(sid).map((r) => r.rowId), ["a1", "a2"], "原位替换不改顺序");
	assert.equal(rowsOf(sid)[0]!.text, "final", "upserted 覆盖内容");
	ok("B2 WS upserted 原位替换（顺序与行数不变）");
}

{
	// B3 delta：只追加到 assistantText / reasoning 的 text 路径
	const sid = newSid();
	await feed(sid, 1, { kind: "row.appended", row: row({ rowId: "a1", kind: "assistantText", text: "he" }) });
	await feed(sid, 2, { kind: "row.appended", row: row({ rowId: "u1", kind: "userInput", text: "q" }) });
	await feed(sid, 3, { kind: "row.delta", rowId: "a1", path: "text", append: "llo" });
	await feed(sid, 4, { kind: "row.delta", rowId: "u1", path: "text", append: "!!" });
	await feed(sid, 5, { kind: "row.delta", rowId: "a1", path: "other", append: "??" });
	const rows = rowsOf(sid);
	assert.equal(rows[0]!.text, "hello", "assistantText 的 text 路径追加生效");
	assert.equal(rows[1]!.text, "q", "userInput 行不接受 delta");
	assert.equal((rows[0] as { text: string }).text, "hello", "非 text 路径被忽略");
	ok("B3 WS delta 仅作用于流式文本行 text 路径（其余忽略）");
}

{
	// B4 removed：屏障语义（删该行及其后所有行）
	const sid = newSid();
	for (const id of ["a1", "a2", "a3"]) await feed(sid, Number(id.slice(1)), { kind: "row.appended", row: row({ rowId: id }) });
	await feed(sid, 4, { kind: "row.removed", rowId: "a2" });
	assert.deepEqual(rowsOf(sid).map((r) => r.rowId), ["a1"], "删除该行及其后全部");
	ok("B4 WS removed 屏障截断后续行");
}

{
	// B5 seq 倒退：旧 seq 的帧被接线层拒绝（不是 reducer 的职责）
	const sid = newSid();
	await feed(sid, 10, { kind: "row.appended", row: row({ rowId: "a1" }) });
	await feed(sid, 9, { kind: "row.appended", row: row({ rowId: "a0" }) });
	assert.deepEqual(rowsOf(sid).map((r) => r.rowId), ["a1"], "倒退 seq 的帧不得落地");
	ok("B5 接线层 seq 倒退防御（同帧重放不产生倒退写入）");
}

{
	// B6 state.updated：不改行（GUI 侧 view.info 不落 store，只保留行）
	const sid = newSid();
	await feed(sid, 1, { kind: "row.appended", row: row({ rowId: "a1" }) });
	await feed(sid, 2, { kind: "state.updated", patch: { title: "T" } });
	assert.deepEqual(rowsOf(sid).map((r) => r.rowId), ["a1"], "state.updated 不影响行集合");
	ok("B6 WS state.updated 不污染行集合");
}

console.log(`\n_test_transcript_shared_entry: all assertions passed (${n})`);
