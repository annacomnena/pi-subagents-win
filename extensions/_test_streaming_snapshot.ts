/**
 * _test_streaming_snapshot.ts — 流式快照写入端（`runtime/streaming-snapshot.ts`）单测。
 *
 * 背景：pi core 只在 `message_end` 落盘，流式期间 GUI 看不到增量。
 * 本模块把 `pi.on("message_update")` 的 `thinking_delta` / `text_delta` 节流覆盖写成快照，
 * 让 GUI 能显示「正在思考」。它有几个**必须钉住**的性质，否则会污染 GUI 或磁盘：
 *
 *   T1 `extractDelta`：只认 thinking/text 增量，`toolcall_delta` 等返回 null（本轮不做）
 *   T2 节流：窗口内多次 push 只落一次盘，且文本是**累积**而非最后一段
 *   T3 段落切换（thinking→text）立刻落盘，不把两段拼在一起
 *   T4 `finish()` 删除快照（message_end 后正式行接管，不能留幽灵块）
 *   T5 `dispose()` 停定时器并删除快照（session_shutdown / 卸载）
 *   T6 never-throw：目录不可写也不抛（流式预览失败不影响对话）
 *
 * 运行：npm run test:streaming-snapshot
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerStreamingSnapshot } from "./runtime/streaming-snapshot-register.ts";
import {
	STREAMING_FLUSH_MS,
	disposeAllStreamingWriters,
	extractDelta,
	streamingWriterFor,
} from "./runtime/streaming-snapshot.ts";

let n = 0;
const ok = (name: string): void => {
	n += 1;
	console.log(`ok ${n} - ${name}`);
};

const dirs: string[] = [];
const tmpDir = (): string => {
	const d = mkdtempSync(join(tmpdir(), "streaming-snap-"));
	dirs.push(d);
	return d;
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 读快照（不存在 → null）。 */
function readSnap(dir: string, sid: string): { kind: string; text: string; pid: number } | null {
	const p = join(dir, `${sid}.json`);
	if (!existsSync(p)) return null;
	return JSON.parse(readFileSync(p, "utf8")) as { kind: string; text: string; pid: number };
}

try {
	// ── T1 extractDelta ────────────────────────────────────────────
	{
		assert.deepEqual(extractDelta({ type: "thinking_delta", delta: "abc" }), { kind: "reasoning", delta: "abc" }, "thinking_delta → reasoning");
		assert.deepEqual(extractDelta({ type: "reasoning_delta", delta: "x" }), { kind: "reasoning", delta: "x" }, "reasoning_delta 也归 reasoning（provider 差异）");
		assert.deepEqual(extractDelta({ type: "text_delta", delta: "hi" }), { kind: "text", delta: "hi" }, "text_delta → text");
		assert.equal(extractDelta({ type: "toolcall_delta", delta: "{}" }), null, "toolcall_delta 本轮不做 → null");
		assert.equal(extractDelta({ type: "thinking_delta", delta: "" }), null, "空增量 → null");
		assert.equal(extractDelta(null), null, "null → null");
		assert.equal(extractDelta({ type: "text_delta" }), null, "无 delta 字段 → null");
		ok("T1 extractDelta：只认 thinking/text 增量，其余 null");
	}

	// ── T2 节流 + 累积 ─────────────────────────────────────────────
	{
		const d = tmpDir();
		const w = streamingWriterFor("t2", { dir: d });
		w.push("reasoning", "第一段");
		w.push("reasoning", "第二段");
		w.push("reasoning", "第三段");
		assert.equal(readSnap(d, "t2"), null, `节流窗口内不应落盘（${STREAMING_FLUSH_MS}ms）`);
		await sleep(STREAMING_FLUSH_MS + 120);
		const snap = readSnap(d, "t2");
		assert.ok(snap !== null, "窗口过后已落盘");
		assert.equal(snap!.text, "第一段第二段第三段", "文本是累积而非最后一段");
		assert.equal(snap!.kind, "reasoning", "kind=reasoning");
		assert.equal(typeof snap!.pid, "number", "带 pid（诊断）");
		w.dispose();
		ok("T2 节流 + 累积：窗口内不写盘，过后写全文");
	}

	// ── T3 段落切换立刻落盘 ─────────────────────────────────────────
	{
		const d = tmpDir();
		const w = streamingWriterFor("t3", { dir: d });
		w.push("reasoning", "想完了");
		w.push("text", "开始说"); // 立刻落盘
		const snap = readSnap(d, "t3");
		assert.ok(snap !== null, "段落切换应立即落盘（不等节流窗口）");
		assert.equal(snap!.kind, "text", "kind 已切到 text");
		assert.equal(snap!.text, "开始说", "不把两段拼在一起");
		w.dispose();
		ok("T3 段落切换立刻落盘，且不拼接两段");
	}

	// ── T4 finish() 删除快照 ───────────────────────────────────────
	{
		const d = tmpDir();
		const w = streamingWriterFor("t4", { dir: d });
		w.push("reasoning", "x");
		w.flush();
		assert.ok(readSnap(d, "t4") !== null, "flush 后存在");
		w.finish();
		assert.equal(readSnap(d, "t4"), null, "finish 后快照被删除（message_end 接管）");
		// finish 后同一 sessionId 再取 → 新 writer（不会复用已摘除的）
		const w2 = streamingWriterFor("t4", { dir: d });
		assert.notEqual(w2, w, "finish 后 writer 已摘除，重新建");
		w2.dispose();
		ok("T4 finish() 删除快照并摘除 writer");
	}

	// ── T5 dispose() 停定时器 + 删除 ───────────────────────────────
	{
		const d = tmpDir();
		const w = streamingWriterFor("t5", { dir: d });
		w.push("text", "pending");
		w.dispose(); // 定时器还没触发就 dispose
		await sleep(STREAMING_FLUSH_MS + 120);
		assert.equal(readSnap(d, "t5"), null, "dispose 后定时器不再写盘（不会复活幽灵快照）");
		ok("T5 dispose() 停定时器且不留快照");
	}

	// ── T6 never-throw：不可写目录 ─────────────────────────────────
	{
		// 用一个「父路径是文件」的目录让 mkdir 必然失败
		const d = tmpDir();
		const blocker = join(d, "blocked");
		writeFileSync(blocker, "x", "utf8");
		const w = streamingWriterFor("t6", { dir: join(blocker, "sub") });
		assert.doesNotThrow(() => {
			w.push("text", "should not throw");
			w.flush();
		}, "写盘失败不得抛出");
		w.dispose();
		ok("T6 never-throw：目录不可写也不抛");
	}

	// ── T7 同会话复用同一 writer（避免多段落互相覆盖）───────────────
	{
		const d = tmpDir();
		const a = streamingWriterFor("t7", { dir: d });
		const b = streamingWriterFor("t7", { dir: d });
		assert.equal(a, b, "同一 sessionId 复用同一 writer");
		disposeAllStreamingWriters();
		const c = streamingWriterFor("t7", { dir: d });
		assert.notEqual(a, c, "disposeAll 后重新建");
		c.dispose();
		ok("T7 同会话复用 writer；disposeAll 后重建");
	}
	// ── T8 **真实接线**：经 registerStreamingSnapshot 注册 + 事件派发 ────────
	//
	// R-4 纪律：断言必须经过真实入口（注册 + 事件派发），否则只证明函数体对，
	// 不证明接线对。这里用一个最小 pi 桩：`on()` 收集处理器，然后按 pi 的真实事件形状派发。
	{
		const d = tmpDir();
		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		const fakePi = {
			on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => {
				handlers.set(name, fn);
				return () => handlers.delete(name);
			},
		};
		const dispose = registerStreamingSnapshot(fakePi as never, { dir: d });
		assert.ok(handlers.has("message_update"), "注册了 message_update");
		assert.ok(handlers.has("message_end"), "注册了 message_end");
		assert.ok(handlers.has("session_shutdown"), "注册了 session_shutdown");

		const ctx = { sessionManager: { sessionId: "t8" } };

		// 派发 thinking_delta（真实形状：assistantMessageEvent 内带 delta）
		await handlers.get("message_update")!({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "thinking_delta", delta: "接线验证" } }, ctx);
		await sleep(STREAMING_FLUSH_MS + 120);
		const snap = readSnap(d, "t8");
		assert.ok(snap !== null, "经真实事件派发后快照已落盘");
		assert.equal(snap!.text, "接线验证", "文本来自派发的 delta");

		// 派发 toolcall_delta → 不应改变快照（本轮不做的类型）
		await handlers.get("message_update")!({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "toolcall_delta", delta: "{}" } }, ctx);
		await sleep(STREAMING_FLUSH_MS + 120);
		assert.equal(readSnap(d, "t8")!.text, "接线验证", "toolcall_delta 被忽略");

		// 派发 message_end（assistant）→ 快照删除
		await handlers.get("message_end")!({ type: "message_end", message: { role: "assistant" } }, ctx);
		assert.equal(readSnap(d, "t8"), null, "message_end 后快照删除");

		// 非 assistant 的 message_end 不得误删（toolResult/user 结束不该清 assistant 快照）
		await handlers.get("message_update")!({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "正文" } }, ctx);
		await sleep(STREAMING_FLUSH_MS + 120);
		assert.ok(readSnap(d, "t8") !== null, "再次流式已落盘");
		await handlers.get("message_end")!({ type: "message_end", message: { role: "toolResult" } }, ctx);
		assert.ok(readSnap(d, "t8") !== null, "toolResult 的 message_end 不清 assistant 快照");
		await handlers.get("message_end")!({ type: "message_end", message: { role: "assistant" } }, ctx);
		assert.equal(readSnap(d, "t8"), null, "assistant 的 message_end 才清");

		// session_shutdown → 清理
		await handlers.get("message_update")!({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "x" } }, ctx);
		await sleep(STREAMING_FLUSH_MS + 120);
		await handlers.get("session_shutdown")!({ type: "session_shutdown" }, ctx);
		assert.equal(readSnap(d, "t8"), null, "session_shutdown 清空快照");
		dispose();
		ok("T8 真实接线：注册 → 事件派发 → 落盘/删除（含 toolcall 忽略、非 assistant 不误删）");
	}
} finally {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	disposeAllStreamingWriters();
}

console.log(`\n_test_streaming_snapshot: all assertions passed (${n})`);
