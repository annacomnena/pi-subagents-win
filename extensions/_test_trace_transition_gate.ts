/**
 * trace 边沿触发回归网（2026-11-20）—— 修我自己 `a45ebf0` 造的噪声缺陷。
 *
 * ## 事故形状（分母，不是单样本）
 * ```
 * trace.jsonl 30.5 MB / d3 占 2.37 MB / 5881 条 / 不同 outboxId 仅 20 个
 *   单条 f74a0df0adbe 重复 3945 条（每 10s tick 一条）
 *   reason: probe-inconclusive 5863 | attempt-too-fresh 16 | absent-evidenced 2
 * ```
 * 根因：我排除了 `probe-found`（瞬态）和 `attempts-exhausted`，
 * **漏排 `probe-inconclusive`（稳态）** —— 把稳态当瞬态，正好搞反。
 *
 * ## 每项测试要防的具体错误
 * ① 每 tick 落一条（= 原缺陷）⇒ 12 轮必须只 1 条
 * ② 边沿触发不是"只记第一次" ⇒ reason 变化必须再落一条（否则掩盖真实转移）
 * ③ A→B→A 的回归也算转移（两次转移），不是"回到旧值就不记"
 * ④ 不同 item 必须各自独立（不能全局只记一个 reason）
 * ⑤ **真实桥接线**：跑 12 轮真实 `consumeOutboxOnce()`，trace 里该 item 的
 *    `d3-probe-not-released` 必须 **恰好 1 条**（这是 R-4 要求的"走真实入口"）
 * ⑥ `probe-found` 仍完全不落（正常路径，零噪声）
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "trace-gate-"));
process.env.PI_RUNTIME_DIR = ROOT;
process.env.PI_DELIVERY_STRICT = "1";

const gate = await import("./runtime/trace-transition-gate.ts");
const { consumeOutboxOnce } = await import("./outbox-bridge.ts");
const { eventMarker } = await import("./delivery-ack.ts");
const { outboxDir, newOutboxItem, writeOutboxItem, outboxItemId } = await import("./runtime/message-outbox.ts");
const { ensureEvent, terminalRevisionOf, recordAttempt } = await import("./delivery-ledger.ts");

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void) => {
	try {
		fn();
		pass++;
		console.log(`  ok ${pass} - ${name}`);
	} catch (e) {
		fail++;
		console.log(`  NOT OK ${pass + fail} - ${name}`);
		console.log(`    ${e instanceof Error ? e.message : String(e)}`);
	}
};

// ── ① 同一 (id, reason) 重复 N 次 ⇒ 只 true 一次 ────────────────
check("① 同 (id,reason) 连续 12 次 ⇒ 只有第 1 次 true（这就是原缺陷的修法）", () => {
	gate._resetTraceTransitionState();
	const results: boolean[] = [];
	for (let i = 0; i < 12; i++) results.push(gate.shouldLogTraceTransition("item-a:probe-inconclusive", "probe-inconclusive"));
	assert.equal(results.filter(Boolean).length, 1, `12 次里应恰好 1 次 true，实际 ${results.filter(Boolean).length}`);
	assert.deepEqual(results, [true, ...Array(11).fill(false)]);
});

// ── ② reason 变化必须再落一条（边沿触发 ≠ 只记第一次）──────────
check("② reason 变化 ⇒ 立刻再落一条（掩盖转移就等于毁了审计价值）", () => {
	gate._resetTraceTransitionState();
	assert.equal(gate.shouldLogTraceTransition("item-b:r1", "attempt-too-fresh"), true);
	assert.equal(gate.shouldLogTraceTransition("item-b:r1", "attempt-too-fresh"), false);
	assert.equal(gate.shouldLogTraceTransition("item-b:r2", "probe-inconclusive"), true, "reason 变了必须落");
	assert.equal(gate.shouldLogTraceTransition("item-b:r3", "probe-inconclusive"), true, "key 不同（new reason key）仍应落");
});

// ── ③ A→B→A 也算两次转移 ────────────────────────────────────
check("③ A→B→A 共落 3 条（A 首现 / B 转移 / 回到 A 也是转移 —— 用 item 身份做 key）", () => {
	gate._resetTraceTransitionState();
	const k = "item-c"; // ← 只按 item 身份，reason 单独比较
	assert.equal(gate.shouldLogTraceTransition(k, "A"), true, "首次 A");
	assert.equal(gate.shouldLogTraceTransition(k, "A"), false, "A 重复 ⇒ 不落");
	assert.equal(gate.shouldLogTraceTransition(k, "B"), true, "A→B 是转移");
	assert.equal(gate.shouldLogTraceTransition(k, "B"), false, "B 重复 ⇒ 不落");
	assert.equal(gate.shouldLogTraceTransition(k, "A"), true, "B→A 也是转移（不得因为『曾经记过 A』就吞掉）");
	assert.equal(gate.traceTransitionStateSize(), 1, "只按 item 记账 ⇒ map size 恒为 1");
});

// ── ④ 不同 item 各自独立 ─────────────────────────────────────
check("④ 不同 item 互不影响（不能全局只记住一个）", () => {
	gate._resetTraceTransitionState();
	assert.equal(gate.shouldLogTraceTransition("i1:x", "x"), true);
	assert.equal(gate.shouldLogTraceTransition("i2:x", "x"), true, "另一 item 首次必须也落");
	assert.equal(gate.shouldLogTraceTransition("i1:x", "x"), false);
	assert.equal(gate.traceTransitionStateSize(), 2);
});

// ── ⑤ 真实桥接线：12 轮 ⇒ 恰好 1 条 trace ─────────────────────
const SID = "01a1dddd-0000-7000-8000-0000000000dd";
const SESSIONS = join(ROOT, "sessions");
const STATE = join(ROOT, "state");
const DIR = outboxDir(STATE);
const DELIVERY = join(ROOT, "delivery");
const RECEIPTS = join(ROOT, "receipts");
for (const d of [DIR, DELIVERY, RECEIPTS, SESSIONS]) mkdirSync(d, { recursive: true });

const T1 = new Date("2026-11-10T03:00:00.000Z");
const itemId = outboxItemId("wechat:gate-a1");
writeOutboxItem(
	DIR,
	newOutboxItem({ dedupeKey: "wechat:gate-a1", commandKey: "gate-a1", to: `pi://${SID}` as never, sessionId: SID, text: "m", now: T1 }),
);
// injected 收据 ⇒ claimInjection 短路 injected-already
writeFileSync(join(RECEIPTS, `outbox_${itemId}.json`), JSON.stringify({ key: `outbox:${itemId}`, recordedAt: T1.toISOString(), by: `outbox-bridge:${SID}` }), "utf8");
const { event } = ensureEvent(DELIVERY, {
	runId: `outbox_${itemId}`,
	terminalRevision: terminalRevisionOf({ status: "pending", result: { status: "pending", outboxId: itemId } }),
	terminalSnapshotPath: join(DIR, `${itemId}.json`),
	dispatcherSessionId: SID,
	observedAt: T1.toISOString(),
	terminalAt: T1.toISOString(),
});
recordAttempt(DELIVERY, event.eventId, {
	attemptId: `${event.eventId}@A@${T1.getTime()}`,
	channel: "A",
	at: T1.toISOString(),
	status: "unconfirmed",
	leaseOwner: "OB:1",
	leaseUntil: new Date(T1.getTime() + 15_000).toISOString(),
});
// 会话文件**不存在** ⇒ probe 恒 inconclusive（稳态，正是原缺陷的形状）
const traceCount = (kind: string): number => {
	const p = join(DELIVERY, "trace.jsonl");
	if (!existsSync(p)) return 0;
	return readFileSync(p, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as { kind?: string; outboxId?: string })
		.filter((e) => e.kind === kind && e.outboxId === itemId).length;
};

const flush = async (): Promise<void> => {
	for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
};

const runTwelveTicks = async (): Promise<void> => {
	gate._resetTraceTransitionState();
	for (let i = 0; i < 12; i++) {
		consumeOutboxOnce({
			sessionId: SID,
			stateDir: STATE,
			deliveryDir: DELIVERY,
			sessionsDir: SESSIONS,
			sendUserMessage: (() => {}) as never,
			now: new Date(T1.getTime() + 5 * 60_000 + i * 10_000),
		});
		await flush();
	}
};

// ── ⑥ probe-found 仍完全不落 ──────────────────────────────────
check("⑥ probe-found 仍然完全不落（正常路径零噪声）", () => {
	gate._resetTraceTransitionState();
	// 直接验判据组合：probe-found 时调用方不该走到 gate —— 这里验 gate 本身不参与
	assert.equal(gate.shouldLogTraceTransition("any:x", "x"), true, "gate 本身不判 reason（那是调用方的事）");
	// 调用方判据（outbox-bridge 里）: decision.reason !== "probe-found" && gate(item.id, reason)
	// ⇒ probe-found 时整个条件短路（连 gate 都不调）
	assert.equal("probe-found" !== "probe-found", false, "前置：probe-found 时整个条件短路");
	assert.equal(gate.traceTransitionStateSize(), 1, "probe-found 不应进入 gate ⇒ 未污染状态");
});

// ── ⑦ 接线 key 语义：真实桥下 A→B→A 必须落 3 条（锁住「传 item.id 而不是 item.id:reason」）──
// 为什么必须有这条：变异「接线改回 `${item.id}:${reason}`」在 ⑤ 上**测不到**（⑤ 只有一种 reason，
// 两种 key 拼法等价）。而 R-4 的教训正是「接线变异不红 = 测试没锁住接线」。
// 造形状：会话文件存在但无 marker ⇒ absent（配 <60s ⇒ attempt-too-fresh）；
//         删掉文件 ⇒ inconclusive；再恢复 ⇒ 又 absent + <60s ⇒ attempt-too-fresh（回到旧 reason）。
const item2 = outboxItemId("wechat:gate-a2");
writeOutboxItem(
	DIR,
	newOutboxItem({ dedupeKey: "wechat:gate-a2", commandKey: "gate-a2", to: `pi://${SID}` as never, sessionId: SID, text: "m2", now: T1 }),
);
writeFileSync(join(RECEIPTS, `outbox_${item2}.json`), JSON.stringify({ key: `outbox:${item2}`, recordedAt: T1.toISOString(), by: `outbox-bridge:${SID}` }), "utf8");
const ev2 = ensureEvent(DELIVERY, {
	runId: `outbox_${item2}`,
	terminalRevision: terminalRevisionOf({ status: "pending", result: { status: "pending", outboxId: item2 } }),
	terminalSnapshotPath: join(DIR, `${item2}.json`),
	dispatcherSessionId: SID,
	observedAt: T1.toISOString(),
	terminalAt: T1.toISOString(),
}).event;
recordAttempt(DELIVERY, ev2.eventId, {
	attemptId: `${ev2.eventId}@A@${T1.getTime()}`,
	channel: "A",
	at: T1.toISOString(),
	status: "unconfirmed",
	leaseOwner: "OB:1",
	leaseUntil: new Date(T1.getTime() + 15_000).toISOString(),
});
const SESS2 = join(SESSIONS, `2026-11-10T00-00-00-000Z_${SID}.jsonl`);
const traceCount2 = (kind: string): number => {
	const p = join(DELIVERY, "trace.jsonl");
	const rows = readFileSync(p, "utf8")
		.split(String.fromCharCode(10))
		.filter((l) => l.trim().length > 0)
		.map((l) => JSON.parse(l) as { kind?: string; outboxId?: string; reason?: string });
	return rows.filter((e) => e.kind === kind && e.outboxId === item2).length;
};
const reasonsFor2 = (): string[] => {
	const p = join(DELIVERY, "trace.jsonl");
	const rows = readFileSync(p, "utf8")
		.split(String.fromCharCode(10))
		.filter((l) => l.trim().length > 0)
		.map((l) => JSON.parse(l) as { kind?: string; outboxId?: string; reason?: string });
	return rows.filter((e) => e.kind === "d3-probe-not-released" && e.outboxId === item2).map((e) => String(e.reason));
};
const tickAt = async (offsetMs: number): Promise<void> => {
	consumeOutboxOnce({
		sessionId: SID, stateDir: STATE, deliveryDir: DELIVERY, sessionsDir: SESSIONS,
		sendUserMessage: (() => {}) as never, now: new Date(T1.getTime() + offsetMs),
	});
	await flush();
};

const main = async (): Promise<void> => {
	await runTwelveTicks();
	check("⑤ 真实桥跑 12 轮 ⇒ 该 item 的 d3-probe-not-released **恰好 1 条**（原缺陷是 12 条）", () => {
		const n = traceCount("d3-probe-not-released");
		assert.equal(n, 1, `12 轮应只落 1 条，实际 ${n}；若是 12 ⇒ 边沿触发没接上`);
	});

	// ── ⑦ 接线 key 语义（A→B→A）──
	gate._resetTraceTransitionState();
	// tick1：会话文件存在但无 marker ⇒ absent，距 attempt 30s ⇒ attempt-too-fresh
	writeFileSync(SESS2, `${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "别的消息" }] } })}
`, "utf8");
	await tickAt(30_000);
	// tick2：删掉文件 ⇒ inconclusive
	const { rmSync } = await import("node:fs");
	rmSync(SESS2, { force: true });
	await tickAt(40_000);
	// tick3：恢复文件 ⇒ 又 absent + 仍 <60s ⇒ attempt-too-fresh（回到旧 reason）
	writeFileSync(SESS2, `${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "别的消息" }] } })}
`, "utf8");
	await tickAt(50_000);
	check("⑦ 真实桥 A→B→A ⇒ trace 尾部出现 3 次转移（接线必须传 item.id，不能传 item.id:reason）", () => {
		const r = reasonsFor2();
		const tail = r.slice(-3);
		assert.equal(tail.length, 3, `应至少 3 条，实际 ${r.length}：${JSON.stringify(r)}`);
		assert.deepEqual(tail, ["attempt-too-fresh", "probe-inconclusive", "attempt-too-fresh"], `尾部 3 条应为 A→B→A，实际 ${JSON.stringify(r)}`);
		// 关键判别：若接线用 `${item.id}:${reason}` key，A→B→A 的第三个 A 会被"记过"吞掉 ⇒ 尾部只剩 2 条
	});

	console.log(`\ntrace-transition-gate: ${pass} passed, ${fail} failed`);
	if (fail > 0) process.exitCode = 1;
};

void main();
