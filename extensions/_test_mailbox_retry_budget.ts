/**
 * _test_mailbox_retry_budget.ts — D-1 有限退避（global Master 2026-10-16 裁定）
 *
 * 裁定：mailbox 未送达的信走「保持释放 + 有限退避」：
 *   重投 ≤5 次；退避 5s→10s→20s→40s→80s（±20% 抖动）；总交付期限 ≤5min；
 *   **到顶 ⇒ `failed_delivery` + incident（绝不静默丢）**。
 *
 * ## 2026-11-12 重大修正（本文件重写 P2 组）
 *
 * 【事故】同一封信被注入目标会话 **5-6 次**（attempt 6 条 + `retry-budget-exhausted` incident，
 * 用户端看到 5 条相同「📬 Tab 已完成」）。根因不是退避阈值，而是**分类错误**：
 * `injectFollowUpQuietly` 恒传 `deliverAs:"followUp"`（`injection-gate.ts:196`），而 pi 的
 * followUp 语义是「排队等 agent 空闲」（pi `docs/extensions.md:1672`：*Delivered only when agent
 * has no more tool calls*）——**忙碌时不 reject**；生产 `sendUserMessage` 又恒返回 `undefined`
 * ⇒ 每次都落 `unconfirmed` ⇒ 旧代码把它当「投递失败」，`releaseClaimed` 退回 pending ⇒ 重投。
 *
 * 【新口径】`unconfirmed` **不释放**（注入已实际发生，与 `outbox-bridge.ts:485-500` 的
 * 2026-11-02 既成修法同口径）⇒ 这种形态恒 **1 次注入**（见 `_test_c3_mailbox_ack` M3）。
 *
 * 【退避门还存在吗】存在，且仍然必要——它服务**真正没送出去**的那些形态：
 *   - `busy`（send 抛 `already processing`，pi 拒绝而非排队）；
 *   - `no-injector`（宿主无注入通道）。
 * 这两种旧代码也是 `releaseClaimed` 退回 pending，需靠退避节流 + 到顶 incident 兜底。
 * P2 组改用 `busy` 形态覆盖，不再用已不成立的 unconfirmed 形态。
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
import { deliverLetter, listLetters } from "./runtime/mailbox.ts";
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
// 2026-10-20 修：原为硬编码 2026-10-16T04:00:00Z。本测试用 setCutover(true)（enabledAt = **真实 now**）
// 而信件 sentAt = T0 ⇒ 一旦真实时间越过 T0，信被判 `pre-cutover-legacy` 而跳过，注入次数恒 0
// （实测 2026-10-20：`consumed=[{action:"skipped",reason:"pre-cutover-legacy"}]`、sent=0）。
// 改为以测试启动时刻为基准 ⇒ 与 cutover 时间同源，退避节律断言（纯相对量）不受影响。
const T0 = Date.now();

/** 生产形态的 busy 拒绝：pi 在**非 followUp 路径**上的原始错误文本（`classifyThrown` 据此判 busy）。 */
const busyThrow = (): never => {
	throw new Error("Agent is already processing a prompt");
};

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

	// ── P2：集成 —— `busy` 形态有界重投 + 到顶 incident（绝不静默丢）──────
	{
		const body = newMessageFrame({
			id: newEnvelopeId("msg"), kind: "REPORT", from: "agent://agent_worker_d1", to: master,
			// sentAt 必须 ≥ cutover.enabledAt（后者是 setCutover 时的真实 now）⇒ 用真实当前时刻，
			// 否则被判 pre-cutover-legacy 而跳过（原写 iso(T0)，T0 是硬编码过去时刻 ⇒ 时间炸弹）。
			subject: "run://tab/tab_d1", sentAt: new Date().toISOString(), summary: "D-1 预算", details: { tabRunId: "tab_d1", status: "completed" },
		});
		deliverLetter(body, { mailboxDir: MAILBOX });

		let attempts = 0;
		const opts = {
			sessionId: "sess-d1", mailboxDir: MAILBOX, runsDir: join(ROOT, "tab-runs"), deliveryDir: DELIVERY,
			// **busy 形态**（老形态 unconfirmed 已改为不释放，见文件头）：pi 拒绝 ⇒ 消息确实没送进去
			// ⇒ 释放 + 退避重投才是正确语义。
			sendUserMessage: (): never => { attempts += 1; return busyThrow(); },
		};
		// 退避节律下的 tick 序列（每次都**超过最坏抖动** base×1.2 的累计值 ⇒ 每次都真重投）
		const ticks = [0, 6_500, 19_000, 44_000, 93_000, 190_000];
		for (const dt of ticks) {
			consumeMailboxOnce({ ...opts, nowMs: T0 + dt });
			await flush();
		}
		assert.equal(attempts, MAILBOX_RETRY_MAX_RETRIES + 1, `注入尝试 = 首次 + ${MAILBOX_RETRY_MAX_RETRIES} 次重投（实得 ${attempts}）`);

		// 第 7 次 tick：到顶 ⇒ incident + 不再注入
		const rTop = consumeMailboxOnce({ ...opts, nowMs: T0 + 240_000 });
		await flush();
		assert.equal(attempts, MAILBOX_RETRY_MAX_RETRIES + 1, "**到顶后不再注入**（有界）");
		assert.ok(rTop.consumed.some((c) => c.reason === "retry-budget-exhausted"), "**如实报 retry-budget-exhausted**（不静默丢）");
		const open = listOpenIncidents(DELIVERY);
		assert.equal(open.length, 1, "**incident 已落盘**（failed_delivery 可见）");
		assert.ok(String(open[0]!.reason).includes("retry-budget-exhausted"), `incident reason 写明预算（实得 ${open[0]!.reason}）`);

		// 再退后仍不再注入，且 incident 保持唯一（幂等）
		const rAfter = consumeMailboxOnce({ ...opts, nowMs: T0 + 600_000 });
		await flush();
		assert.equal(attempts, MAILBOX_RETRY_MAX_RETRIES + 1, "终态后不再注入");
		assert.equal(listOpenIncidents(DELIVERY).length, 1, "incident 唯一（幂等，不重复制造）");
		assert.ok(rAfter.consumed.length >= 0, "终态态可重复观测");
		assert.equal(defaultDeliveryDir(), DELIVERY, "隔离生效（账本目录 = 临时目录）");
		const letter = listLetters(master, undefined, MAILBOX).find((l) => l.frame.frame === "message" && l.frame.id === body.id)!;
		assert.equal(letter.status, "claimed", `**到顶后保持 claimed**（不退回 pending、也不伪造成 acked；实得 ${letter.status}）`);
		ok("P2 集成（busy 形态）：尝试 ≤6 次、到顶 incident + 不静默丢 + 幂等");
	}

	console.log(`\n_test_mailbox_retry_budget: all ${n} groups passed`);
} finally {
	rmSync(ROOT, { recursive: true, force: true });
}
