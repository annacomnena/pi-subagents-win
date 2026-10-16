/**
 * _test_c3_outbox_ack.ts — C-3 第 3 个调用点（outbox-bridge）切换回归
 *
 * 决定性断言（与 watcher §18 / mailbox 同构）：
 *   生产形态 send（不 return ⇒ `undefined`）下，
 *   ① 不得把「返回值」当送达 ⇒ 记 `attempted-unconfirmed`、item 保持 pending、零 journal delivered；
 *   ② 注入正文必带 eventId 标记（接收端 `pi.on("context")` 才能写 `consumed` ACK）；
 *   ③ **delivered 由 ACK 驱动**：预置 `consumed` ACK 后，下一轮不用任何 send 即补写 delivered + journal；
 *   ④ `PI_DELIVERY_STRICT=0` 回滚档位恢复旧行为（undefined ⇒ sent ⇒ delivered）。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "c3-outbox-"));
process.env.PI_RUNTIME_DIR = ROOT;

import { piSessionAddress } from "./runtime/address.ts";
import { listRuntimeEnvelopes } from "./runtime/journal.ts";
import { newOutboxItem, outboxDir, readOutboxItem, writeOutboxItem } from "./runtime/message-outbox.ts";
import { consumeOutboxOnce } from "./outbox-bridge.ts";
import { deliveryStrictEnabled } from "./injection-gate.ts";
import { defaultDeliveryDir, listAttempts, listEvents, writeAck } from "./delivery-ledger.ts";

let n = 0;
const ok = (name: string): void => { n += 1; console.log(`ok ${n} - ${name}`); };
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

const STATE = join(ROOT, "state");
const JOURNAL = join(ROOT, "events.jsonl");
const DELIVERY = join(ROOT, "delivery");
const SID = "sid-c3-ob";

function mkItem(key: string, text: string) {
	return newOutboxItem({
		dedupeKey: `session.message:${key}`,
		commandKey: key,
		to: piSessionAddress(SID),
		sessionId: SID,
		text,
		now: new Date(),
	});
}

function journalEvents(type: string): Array<{ dedupeKey?: string; payload?: Record<string, unknown> }> {
	try {
		return (listRuntimeEnvelopes({ path: JOURNAL }).envelopes as Array<{ type: string; dedupeKey?: string; payload?: Record<string, unknown> }>)
			.filter((e) => e.type === type);
	} catch {
		return [];
	}
}

try {
	mkdirSync(outboxDir(STATE), { recursive: true });

	// ── O1：生产形态（send 不 return）⇒ unconfirmed，不写 delivered、不写 consumed ──
	{
		const dir = outboxDir(STATE);
		const a = mkItem("ob-a", "C3 outbox 生产形态");
		writeOutboxItem(dir, a);
		const sent: string[] = [];
		const rep = consumeOutboxOnce({
			sessionId: SID, stateDir: STATE, journalPath: JOURNAL, deliveryDir: DELIVERY,
			// **生产形态**：不 return（`pi.sendUserMessage` 两级 delegate 都不 return）
			sendUserMessage: (b: string) => { sent.push(b); },
		});
		await flush();

		assert.equal(sent.length, 1, "有注入尝试（零回归）");
		assert.deepEqual(
			rep.consumed.filter((c) => c.outboxId === a.id).map((c) => ({ a: c.action, r: c.reason })),
			[{ a: "skipped", r: "attempted-unconfirmed" }],
			"**生产形态 ⇒ attempted-unconfirmed**（不冒充 delivered）",
		);
		assert.ok(/\[evt:async:outbox_/.test(sent[0]!), `注入正文必须携带 eventId 标记（实得 ${sent[0]!.slice(-80)}）`);

		const item = readOutboxItem(dir, a.id)!;
		assert.equal(item.status, "pending", "**item 保持 pending**（交付由 ACK 决定）");
		assert.equal(item.deliveredAt, undefined, "不得写 deliveredAt");
		assert.equal(journalEvents("message.delivered").filter((e) => e.payload?.commandKey === "ob-a").length, 0, "**零 journal message.delivered**（不伪造终态）");

		const evs = listEvents(DELIVERY, 100).filter((e) => e.runId === `outbox_${a.id}`);
		assert.equal(evs.length, 1, "已建交付事件（outbox_<id> 关联）");
		const attempts = listAttempts(DELIVERY, evs[0]!.eventId);
		assert.equal(attempts.length, 1, "已记 attempt（可审计）");
		assert.equal(attempts[0]!.status, "unconfirmed", "attempt 状态 = unconfirmed（不是 sent）");

		if (deliveryStrictEnabled()) {
			const trace = readFileSync(join(DELIVERY, "trace.jsonl"), "utf8");
			assert.ok(trace.includes("C3-attempted-unconfirmed"), "**C-3（strict）**：如实记 attempted-unconfirmed");
		}
		ok("O1 outbox C-3：生产形态 ⇒ unconfirmed，item 留 pending，零 journal delivered");

		// ── O2：ACK 驱动闭环 —— 预置 consumed ACK ⇒ 下一轮不用 send 即补写 delivered ──
		const eventId = evs[0]!.eventId;
		assert.equal(writeAck(DELIVERY, {
			eventId, stage: "consumed", attemptId: attempts[0]!.attemptId,
			recipientGeneration: 1, at: new Date().toISOString(), evidence: "context-observed",
		}), true, "预置 consumed ACK（模拟 `pi.on(\"context\")` 检出 eventId）");

		let sendCalled = 0;
		const rep2 = consumeOutboxOnce({
			sessionId: SID, stateDir: STATE, journalPath: JOURNAL, deliveryDir: DELIVERY,
			sendUserMessage: () => { sendCalled += 1; }, // 必须**不被调用**：ACK 已证明送达
		});
		await flush();
		assert.deepEqual(
			rep2.consumed.filter((c) => c.outboxId === a.id).map((c) => ({ a: c.action, r: c.reason })),
			[{ a: "delivered", r: "ack-consumed" }],
			"**ACK 驱动**：consumed ACK ⇒ delivered（不依赖 send 返回值）",
		);
		assert.equal(sendCalled, 0, "ACK 已成立 ⇒ 不再注入");
		assert.equal(readOutboxItem(dir, a.id)!.status, "delivered", "回写 delivered");
		assert.equal(journalEvents("message.delivered").filter((e) => e.payload?.commandKey === "ob-a").length, 1, "补写 journal message.delivered 一条");
		ok("O2 outbox：consumed ACK ⇒ delivered 闭环（零 send）");
	}

	// ── O3：回滚档位 PI_DELIVERY_STRICT=0 ⇒ 旧行为（undefined ⇒ sent ⇒ delivered）──
	{
		const dir = outboxDir(STATE);
		const b = mkItem("ob-b", "C3 outbox 回滚档位");
		writeOutboxItem(dir, b);
		const prev = process.env.PI_DELIVERY_STRICT;
		process.env.PI_DELIVERY_STRICT = "0";
		try {
			const rep = consumeOutboxOnce({
				sessionId: SID, stateDir: STATE, journalPath: JOURNAL, deliveryDir: DELIVERY,
				sendUserMessage: () => { /* 不 return = 旧行为 */ },
			});
			await flush();
			assert.equal(deliveryStrictEnabled(), false, "回滚档位已生效");
			assert.deepEqual(rep.consumed.filter((c) => c.outboxId === b.id).map((c) => c.action), ["delivered"], "回滚档位：undefined 当 sent ⇒ delivered（旧行为）");
			assert.equal(readOutboxItem(dir, b.id)!.status, "delivered");
		} finally {
			if (prev === undefined) delete process.env.PI_DELIVERY_STRICT; else process.env.PI_DELIVERY_STRICT = prev;
		}
		ok("O3 outbox：PI_DELIVERY_STRICT=0 回滚档位恢复旧行为");
	}

	console.log(`\n_test_c3_outbox_ack: all ${n} groups passed`);
} finally {
	rmSync(ROOT, { recursive: true, force: true });
}
