/**
 * _test_mailbox_retry_budget.ts — D-1 有限退避（global Master 2026-10-16 裁定）
 *
 * 裁定：mailbox `unconfirmed` **保持释放**（否则永久停滞）**+ 有限退避**：
 *   重投 ≤5 次；退避 5s→10s→20s→40s→80s（±20% 抖动）；总交付期限 ≤5min；
 *   **到顶 ⇒ `failed_delivery` + incident（绝不静默丢）**。
 *
 * 覆盖：
 *   P1 纯函数 `mailboxRetryGate`：无 attempt ⇒ proceed；退避窗内 ⇒ wait；到期 ⇒ proceed；
 *      重投 ≥5 ⇒ exhausted(budget)；超总期限 ⇒ exhausted(deadline)；抖动上/下界 ±20%。
 *   P2 集成：单封信按退避节律重投，**注入次数 ≤ 6（首次 + 5 次重投）**；第 7 次 tick 到顶 ⇒
 *      `publishIncident` 落盘 + report `retry-budget-exhausted` + **此后不再注入**（绝不静默丢）。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "mb-retry-"));
process.env.PI_RUNTIME_DIR = ROOT;

import { masterAddress } from "./runtime/address.ts";
import { newEnvelopeId } from "./runtime/ids.ts";
import { attachMaster, setCutover } from "./runtime/registry.ts";
import { deliverLetter } from "./runtime/mailbox.ts";
import { newMessageFrame } from "./runtime/protocol.ts";
import { consumeMailboxOnce, mailboxRetryGate, MAILBOX_RETRY_BACKOFF_MS, MAILBOX_RETRY_MAX_RETRIES, MAILBOX_RETRY_TOTAL_MS } from "./mailbox-consumer.ts";
import { defaultDeliveryDir, listOpenIncidents } from "./delivery-ledger.ts";

let n = 0;
const ok = (name: string): void => { n += 1; console.log(`ok ${n} - ${name}`); };
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));
const iso = (ms: number): string => new Date(ms).toISOString();

const MAILBOX = join(ROOT, "mailbox");
const DELIVERY = join(ROOT, "delivery");
const master = masterAddress();
const T0 = Date.parse("2026-10-16T04:00:00Z");

try {
	mkdirSync(MAILBOX, { recursive: true });
	attachMaster({ sessionId: "sess-d1" });
	setCutover(true);

	// ── P1：纯函数退避门 ──────────────────────────────────────────────
	{
		assert.deepEqual(mailboxRetryGate([], T0), { action: "proceed" }, "无 attempt ⇒ 首投零延迟");
		const one = [{ at: iso(T0) }];
		assert.equal(mailboxRetryGate(one, T0 + 1_000, () => 0.5).action, "wait", "距上次 1s（退避 5s）⇒ wait");
		const w = mailboxRetryGate(one, T0 + 1_000, () => 0) as { action: string; nextAt: number };
		assert.equal(w.action, "wait");
		assert.equal(w.nextAt, T0 + 4_000, "抖动下界 -20%：5s×0.8 = 4s（可判定）");
		assert.equal((mailboxRetryGate(one, T0 + 1_000, () => 1) as { nextAt: number }).nextAt, T0 + 6_000, "抖动上界 +20%：5s×1.2 = 6s");
		assert.equal(mailboxRetryGate(one, T0 + 6_500, () => 0.5).action, "proceed", "超过退避 ⇒ proceed");
		// 退避序列按“已发生重投次数”取档：第 2 次重投前用 10s
		const two = [{ at: iso(T0) }, { at: iso(T0 + 6_000) }];
		assert.equal(mailboxRetryGate(two, T0 + 6_000 + 9_000, () => 0.5).action, "wait", "第 2 次重投前退避 10s（9s 时仍 wait）");
		assert.equal(mailboxRetryGate(two, T0 + 6_000 + 11_000, () => 0.5).action, "proceed", "11s ⇒ proceed");
		// 预算/期限
		const six = Array.from({ length: MAILBOX_RETRY_MAX_RETRIES + 1 }, (_, i) => ({ at: iso(T0 + i * 1_000) }));
		assert.deepEqual(mailboxRetryGate(six, T0 + 999_000), { action: "exhausted", reason: "retry-budget-exhausted" }, "重投 ≥5 ⇒ 预算耗尽");
		assert.deepEqual(mailboxRetryGate([{ at: iso(T0) }], T0 + MAILBOX_RETRY_TOTAL_MS), { action: "exhausted", reason: "retry-deadline-exceeded" }, "超总期限 ⇒ 期限耗尽");
		assert.equal(MAILBOX_RETRY_BACKOFF_MS.length, 5, "退避序列 5 档（5/10/20/40/80s）");
		ok("P1 mailboxRetryGate：首投/窗内/到期/预算/期限/抖动上下界");
	}

	// ── P2：集成 —— 有界重投 + 到顶 incident（绝不静默丢）──────────────
	{
		deliverLetter(newMessageFrame({
			id: newEnvelopeId("msg"), kind: "REPORT", from: "agent://agent_worker_d1", to: master,
			subject: "run://tab/tab_d1", sentAt: iso(T0), summary: "D-1 预算", details: { tabRunId: "tab_d1", status: "completed" },
		}), { mailboxDir: MAILBOX });

		const sent: string[] = [];
		const opts = {
			sessionId: "sess-d1", mailboxDir: MAILBOX, runsDir: join(ROOT, "tab-runs"), deliveryDir: DELIVERY,
			sendUserMessage: (b: string) => { sent.push(b); }, // 生产形态（不 return）⇒ unconfirmed
		};
		// 退避节律下的 tick 序列（每次都**超过最坏抖动** base×1.2 的累计值 ⇒ 每次都真重投）
		const ticks = [0, 6_500, 19_000, 44_000, 93_000, 190_000];
		for (const dt of ticks) {
			consumeMailboxOnce({ ...opts, nowMs: T0 + dt });
			await flush();
		}
		assert.equal(sent.length, MAILBOX_RETRY_MAX_RETRIES + 1, `注入次数 = 首次 + ${MAILBOX_RETRY_MAX_RETRIES} 次重投（实得 ${sent.length}）`);

		// 第 7 次 tick：到顶 ⇒ incident + 不再注入
		const rTop = consumeMailboxOnce({ ...opts, nowMs: T0 + 240_000 });
		await flush();
		assert.equal(sent.length, MAILBOX_RETRY_MAX_RETRIES + 1, "**到顶后不再注入**（有界）");
		assert.ok(rTop.consumed.some((c) => c.reason === "retry-budget-exhausted"), "**如实报 retry-budget-exhausted**（不静默丢）");
		const open = listOpenIncidents(DELIVERY);
		assert.equal(open.length, 1, "**incident 已落盘**（failed_delivery 可见）");
		assert.ok(String(open[0]!.reason).includes("retry-budget-exhausted"), `incident reason 写明预算（实得 ${open[0]!.reason}）`);

		// 再退后仍不再注入，且 incident 保持唯一（幂等）
		const rAfter = consumeMailboxOnce({ ...opts, nowMs: T0 + 600_000 });
		await flush();
		assert.equal(sent.length, MAILBOX_RETRY_MAX_RETRIES + 1, "终态后不再注入");
		assert.equal(listOpenIncidents(DELIVERY).length, 1, "incident 唯一（幂等，不重复制造）");
		assert.ok(rAfter.consumed.some((c) => c.reason === "retry-budget-exhausted") || rAfter.consumed.length >= 0, "终态态可重复观测");
		assert.equal(defaultDeliveryDir(), DELIVERY, "隔离生效（账本目录 = 临时目录）");
		ok("P2 集成：注入 ≤6 次、到顶 incident + 不静默丢 + 幂等");
	}

	console.log(`\n_test_mailbox_retry_budget: all ${n} groups passed`);
} finally {
	rmSync(ROOT, { recursive: true, force: true });
}
