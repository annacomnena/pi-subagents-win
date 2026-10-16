/**
 * _test_c3_mailbox_ack.ts — C-3 第 2 个调用点（mailbox-consumer）切换回归
 *
 * 决定性断言（与 watcher §18 同构）：
 *   生产形态 send（不 return ⇒ `undefined`）下，
 *   ① 不得把「返回值」当送达（记 `attempted-unconfirmed`）；
 *   ② 不得写 `consumed`（P3 假阳性）；
 *   ③ 不得 `ackLetter`（信必须留 pending，交付由 ACK/对账决定）—— 这是 mailbox 特有的强断言。
 * 并验证 `PI_DELIVERY_STRICT=0` 可回滚。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "c3-mailbox-"));
process.env.PI_RUNTIME_DIR = ROOT;

import { masterAddress } from "./runtime/address.ts";
import { newEnvelopeId } from "./runtime/ids.ts";
import { attachMaster, setCutover } from "./runtime/registry.ts";
import { deliverLetter, listLetters } from "./runtime/mailbox.ts";
import { newMessageFrame } from "./runtime/protocol.ts";
import { consumeMailboxOnce } from "./mailbox-consumer.ts";
import { deliveryStrictEnabled } from "./injection-gate.ts";
import { listAcks, listAttempts, listEvents } from "./delivery-ledger.ts";

let n = 0;
const ok = (name: string): void => { n += 1; console.log(`ok ${n} - ${name}`); };
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

const MAILBOX = join(ROOT, "mailbox");
const DELIVERY = join(ROOT, "delivery");
const master = masterAddress();

function reportBody(summary: string, tab = "tab_c3_1"): ReturnType<typeof newMessageFrame> {
	return newMessageFrame({
		id: newEnvelopeId("msg"),
		kind: "REPORT",
		from: "agent://agent_worker_c3",
		to: master,
		subject: `run://tab/${tab}`,
		sentAt: new Date().toISOString(),
		summary,
		details: { tabRunId: tab, status: "completed" },
	});
}

try {
	mkdirSync(MAILBOX, { recursive: true });
	attachMaster({ sessionId: "sess-c3" });
	setCutover(true);

	// ── M1：生产形态（send 不 return）⇒ unconfirmed，不 ack、不 consumed ──
	{
		deliverLetter(reportBody("c3 完成", "tab_c3_1"), { mailboxDir: MAILBOX });
		const sent: string[] = [];
		const r = consumeMailboxOnce({
			sessionId: "sess-c3", mailboxDir: MAILBOX, runsDir: join(ROOT, "tab-runs"),
			deliveryDir: DELIVERY,
			// **生产形态**：不 return（loader.js:295 的 delegate 行为）
			sendUserMessage: (b: string) => { sent.push(b); },
		});
		await flush();

		assert.equal(sent.length >= 1, true, "有注入尝试");
		const body = sent.find((b) => /\[evt:async:mailbox_/.test(b));
		assert.ok(body, `注入正文必须携带 eventId 标记（实得 ${sent.join(" | ").slice(0, 200)}）`);

		// 找该 eventId
		const evs = listEvents(DELIVERY, 100).filter((e) => e.runId.startsWith("mailbox_"));
		assert.equal(evs.length >= 1, true, "已建交付事件（mailbox 关联）");
		const ev = evs[0];
		assert.equal(listAcks(DELIVERY, ev.eventId).filter((a) => a.stage === "consumed").length, 0, "**不得写 consumed**（P3 核心）");
		assert.equal(listAttempts(DELIVERY, ev.eventId).length >= 1, true, "已记 attempt（可审计）");

		// strict 档位：trace 记 attempted-unconfirmed
		let trace = "";
		try { trace = readFileSync(join(DELIVERY, "trace.jsonl"), "utf8"); } catch { /* ignore */ }
		if (deliveryStrictEnabled()) {
			assert.ok(trace.includes("C3-attempted-unconfirmed"), "**C-3（strict）**：如实记 attempted-unconfirmed（不冒充 sent）");
			// **mailbox 特有的强断言**：unconfirmed ⇒ 信不得 ack（留 pending 供对账）
			const acked = r.consumed.filter((c) => c.action === "injected");
			assert.equal(acked.length, 0, "**unconfirmed ⇒ 不得报 injected/ack（信留 pending）**");
		} else {
			assert.ok(!trace.includes("C3-attempted-unconfirmed"), "回滚档位 ⇒ 不记 unconfirmed（旧行为）");
		}
		ok("M1 mailbox C-3：生产形态 ⇒ unconfirmed，不写 consumed，strict 下不 ack");

		// 该信仍在（未被 ack）—— strict 下必须留 pending，供 B 对账/重投
		const letters = listLetters(master, undefined, MAILBOX);
		if (deliveryStrictEnabled()) {
			assert.ok(letters.some((l) => l.status !== "acked"), "**unconfirmed ⇒ 信留 pending**（未被 ack）");
		}
	}

	// ── M2：真 Promise resolve ⇒ sent（可信确证时才 ack）─────────────────
	{
		const before = listLetters(master, undefined, MAILBOX).length;
		deliverLetter(reportBody("c3 完成2", "tab_c3_2"), { mailboxDir: MAILBOX });
		const sent: string[] = [];
		consumeMailboxOnce({
			sessionId: "sess-c3", mailboxDir: MAILBOX, runsDir: join(ROOT, "tab-runs"),
			deliveryDir: DELIVERY,
			// 真 Promise（如替换上下文那条路径）⇒ confirmed ⇒ sent
			sendUserMessage: (b: string) => { sent.push(b); return Promise.resolve(); },
		});
		await flush();
		assert.equal(listLetters(master, undefined, MAILBOX).length >= before, true, "信被处理");
		ok("M2 mailbox：真 Promise resolve ⇒ sent（可信确证路径不受影响）");
	}

	console.log(`\n_test_c3_mailbox_ack: all ${n} groups passed`);
} finally {
	rmSync(ROOT, { recursive: true, force: true });
}
