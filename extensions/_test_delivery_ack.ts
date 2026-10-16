/**
 * _test_delivery_ack.ts — 接收端 ACK 单测（C-2：确认来源从返回值迁到 ACK）
 *
 * 核心断言：**`consumed` 由「eventId 进入有效 context」驱动**，与 `pi.sendUserMessage`
 * 的返回值**无关**（P3：生产恒 `undefined`）。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ackConsumed,
	ackReceived,
	eventMarker,
	extractEventIds,
	extractEventIdsFromMessages,
	scanDirForEventIds,
	scanSessionFileForEventIds,
} from "./delivery-ack.ts";
import { effectiveStage, ensureEvent, listAcks, terminalRevisionOf, isDelivered } from "./delivery-ledger.ts";

let n = 0;
const ok = (name: string): void => { n += 1; console.log(`ok ${n} - ${name}`); };

const root = mkdtempSync(join(tmpdir(), "delivery-ack-test-"));
const dir = join(root, "delivery");
const NOW = Date.parse("2026-10-16T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

const mkEvent = (runId: string) =>
	ensureEvent(dir, {
		runId, terminalRevision: terminalRevisionOf({ id: runId, status: "completed", endedAt: iso(NOW), result: { status: "completed", text: "ok" } }),
		terminalSnapshotPath: join(root, `${runId}.json`), dispatcherSessionId: "sess_a", observedAt: iso(NOW),
	}).event;

try {
	// ── A1：eventId 标记往返（含转义/多标记/嵌套 content）────────────────
	{
		const eid = "async:run_1:abc123";
		assert.equal(eventMarker(eid), `[evt:${eid}]`);
		assert.deepEqual(extractEventIds(`hello ${eventMarker(eid)} world`), [eid]);
		assert.deepEqual(extractEventIds("no marker here"), []);
		// 多个标记（一轮 context 可能含多条通知）
		assert.deepEqual(extractEventIds(`${eventMarker("async:run_1:a")} ${eventMarker("async:run_2:b")}`), ["async:run_1:a", "async:run_2:b"]);
		// 嵌套 content 数组（pi 消息可为 content parts）
		const msgs = [
			{ role: "user", content: `x ${eventMarker(eid)}` },
			{ role: "assistant", content: [{ type: "text", text: `y ${eventMarker("async:run_9:zz")}` }] },
			{ role: "user", content: [{ type: "text", text: "no marker" }] },
			{ role: "system", content: 42 },
			null,
		];
		assert.deepEqual(extractEventIdsFromMessages(msgs).sort(), ["async:run_1:abc123", "async:run_9:zz"].sort());
		ok("A1 eventId 标记往返：单/多标记、嵌套 content、非字符串容错");
	}

	// ── A2：`consumed` ACK 只在事件存在时写（不为任意文本伪造）────────────
	{
		const ev = mkEvent("run_a2");
		// 不存在的事件 ⇒ 拒绝写（reason=event-not-found）
		const r1 = ackConsumed(dir, ["async:run_nope:deadbeef"], { at: NOW + 1000 });
		assert.equal(r1[0].created, false);
		assert.equal(r1[0].reason, "event-not-found", "不存在的事件不得伪造 ACK");
		// 存在的事件 ⇒ 写成功
		const r2 = ackConsumed(dir, [ev.eventId], { at: NOW + 2000 });
		assert.equal(r2[0].created, true);
		const acks = listAcks(dir, ev.eventId);
		assert.equal(acks.length, 1);
		assert.equal(acks[0].stage, "consumed");
		assert.equal(acks[0].evidence, "context-observed");
		// 幂等：同 eventId 再写不重复
		const r3 = ackConsumed(dir, [ev.eventId], { at: NOW + 3000 });
		assert.equal(r3[0].created, false);
		assert.equal(r3[0].reason, "ack-exists");
		assert.equal(listAcks(dir, ev.eventId).length, 1, "ACK 幂等（wx 不可变）");
		ok("A2 consumed ACK：只对已存在事件写；幂等");
	}

	// ── A3：**P3 核心** —— 送达由 ACK 决定，与返回值无关 ─────────────────
	{
		const ev = mkEvent("run_a3");
		// 模拟生产：sendUserMessage 恒返回 undefined（两级不 return），即**没有任何返回值证据**。
		// 唯一让交付变成 consumed 的路径 = 消息进入 context 后由本模块写 ACK。
		const beforeView = effectiveStage(ev, [], listAcks(dir, ev.eventId), NOW + 1000);
		assert.equal(isDelivered(beforeView.stage), false, "无 ACK ⇒ 即使 send 无异常也不算 delivered");
		// 模拟 context 钩子观察到该 eventId
		const observed = extractEventIdsFromMessages([{ role: "user", content: `...\n${eventMarker(ev.eventId)}` }]);
		assert.deepEqual(observed, [ev.eventId]);
		ackConsumed(dir, observed, { at: NOW + 2000 });
		const afterView = effectiveStage(ev, [], listAcks(dir, ev.eventId), NOW + 3000);
		assert.equal(afterView.stage, "consumed", "**eventId 进入 context ⇒ consumed**（不依赖返回值）");
		assert.equal(isDelivered(afterView.stage), true);
		ok("A3 P3 核心：consumed 由 context 观察驱动（返回值完全不参与）");
	}

	// ── A4：`received`（持久落盘）与 `consumed`（进入 context）分离 ────────
	{
		const ev = mkEvent("run_a4");
		ackReceived(dir, [ev.eventId], { at: NOW + 1000 });
		const v1 = effectiveStage(ev, [], listAcks(dir, ev.eventId), NOW + 2000);
		assert.equal(v1.stage, "received", "落盘 ⇒ received（但**还不是** delivered）");
		assert.equal(isDelivered(v1.stage), false, "received ≠ consumed ⇒ 不算送达");
		ackConsumed(dir, [ev.eventId], { at: NOW + 3000 });
		const v2 = effectiveStage(ev, [], listAcks(dir, ev.eventId), NOW + 4000);
		assert.equal(v2.stage, "consumed", "进入 context ⇒ consumed");
		ok("A4 received 与 consumed 分离（received 不算送达）");
	}

	// ── A5：盘上证据（会话 JSONL）命中 eventId ────────────────────────────
	{
		const sdir = join(root, "sessions");
		mkdirSync(sdir, { recursive: true });
		const ev = mkEvent("run_a5");
		const f = join(sdir, "sess.jsonl");
		writeFileSync(f, [
			JSON.stringify({ role: "user", content: "hi" }),
			JSON.stringify({ role: "user", content: `async 完成 ${eventMarker(ev.eventId)}` }),
		].join("\n"), "utf8");
		assert.deepEqual(scanSessionFileForEventIds(f), [ev.eventId], "从盘上会话文件检出 eventId");
		assert.deepEqual(scanDirForEventIds(sdir), [ev.eventId], "目录扫描命中");
		assert.deepEqual(scanSessionFileForEventIds(join(sdir, "missing.jsonl")), [], "缺文件 ⇒ 空（不抛）");
		ok("A5 盘上证据：会话 JSONL 命中 eventId（received 的持久证明）");
	}

	console.log(`\n_test_delivery_ack: all ${n} groups passed`);
} finally {
	rmSync(root, { recursive: true, force: true });
}
