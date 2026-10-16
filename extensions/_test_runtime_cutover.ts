/**
 * _test_runtime_cutover.ts — Phase 4d 接线测试（A5 F2/F10/F11/F15/F16/F17）
 *
 * 覆盖：
 *   门：flag 关 → 恒放行；flag 开无 registry → 放行；非 owner → 抑制+审计；
 *       owner 互斥（won/second-skip）；无 session 启用态 → 拒绝
 *   消费端：owner 全顺序（claim→复检→门→注入→确认→.notified→ack）；
 *       F17 旧信跳过（仍 pending）；非 owner 零动作；注入抛错不确认不 ack；
 *       已注入重扫 → ack 不重注；.notified 补认领进隔离目录
 *   legacy 门：flag 开 + 他人 owner → event-bus/report 均抑制且记审计
 *
 * 运行：npm run test:runtime-cutover
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "runtime-cutover-env-"));

import { masterAddress } from "./runtime/address.ts";
import { newEnvelopeId } from "./runtime/ids.ts";
import { attachMaster, readCutover, setCutover } from "./runtime/registry.ts";
import { deliverLetter } from "./runtime/mailbox.ts";
import { newMessageFrame } from "./runtime/protocol.ts";
import { hasNotificationReceipt } from "./runtime/receipts.ts";
import { isCutoverActive, postInject, preInject, deliveryStrictEnabled } from "./injection-gate.ts";
import { consumeMailboxOnce } from "./mailbox-consumer.ts";

const master = masterAddress();
const MAILBOX = join(process.env.PI_RUNTIME_DIR!, "mailbox");
const RUNSDIR = join(process.env.PI_RUNTIME_DIR!, "tab-runs");

function report(tab: string, at: string) {
	return newMessageFrame({
		id: newEnvelopeId("msg"),
		kind: "REPORT",
		from: "agent://agent_worker_1",
		to: master,
		subject: `run://tab/${tab}`,
		sentAt: at,
		summary: `cutover-${tab}`,
		details: { tabRunId: tab, status: "completed" },
	});
}

function suppressions(): string[] {
	const p = join(process.env.PI_RUNTIME_DIR!, "suppressions.jsonl");
	if (!existsSync(p)) return [];
	return readFileSync(p, "utf8").trim().split("\n").filter(Boolean);
}

// L3：message send + 收据（postInject/.notified/ack）走 .then 微任务 → 断言 sent/收据前先 flush 微任务队列。
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

try {
	// ── 1. 门：flag 关 → 恒放行 ────────────────────────────────────
	{
		const v = preInject({ key: "run-tab_x-completed", sessionId: undefined, path: "legacy-eventbus" });
		assert.equal(v.inject, true, "未切换时 legacy 原行为");
		assert.equal(isCutoverActive(), false);
	}

	// ── 2. 门：flag 开但无 registry → 放行 ──────────────────────────
	setCutover(true, "test");
	{
		const v = preInject({ key: "run-tab_x-completed", sessionId: "sess-A", path: "legacy-eventbus" });
		assert.equal(v.inject, true, "无 owner 时 legacy 行为");
	}

	// ── 3. 门：非 owner → 抑制 + 审计 ───────────────────────────────
	attachMaster({ sessionId: "sess-A" });
	{
		const v = preInject({ key: "run-tab_y-completed", sessionId: "sess-B", path: "legacy-eventbus" });
		assert.equal(v.inject, false);
		assert.equal(!v.inject && v.reason, "suppressed-not-owner");
		const audits = suppressions();
		assert.equal(audits.length, 1, "抑制记审计");
		const rec = JSON.parse(audits[0]!);
		assert.equal(rec.path, "legacy-eventbus");
		assert.equal(rec.ownerSession, "sess-A");
	}

	// ── 4. 门：owner 互斥 + 无 session 拒绝 ─────────────────────────
	{
		const ctx = { key: "run-tab_z-completed", sessionId: "sess-A", path: "legacy-reports" as const };
		const first = preInject(ctx);
		assert.equal(first.inject, true);
		const second = preInject(ctx);
		assert.equal(second.inject, false);
		assert.equal(!second.inject && second.reason, "claimed-by-other", "同 key 双链互斥");
		postInject(ctx, true);
		const third = preInject(ctx);
		assert.equal(!third.inject && third.reason, "already-injected");
		const nosess = preInject({ key: "run-tab_w-completed", sessionId: undefined, path: "legacy-eventbus" });
		assert.equal(!nosess.inject && nosess.reason, "no-session", "启用态默认拒绝");
	}

	// ── 5. 消费端：owner 全顺序 ────────────────────────────────────
	{
		mkdirSync(RUNSDIR, { recursive: true }); // 生产 tab-runs 恒存在；隔离环境自建
		const sent: string[] = [];
		const now = new Date().toISOString();
		deliverLetter(report("tab_c1", now), { mailboxDir: MAILBOX });
		const r = consumeMailboxOnce({
			sessionId: "sess-A",
			mailboxDir: MAILBOX,
			runsDir: RUNSDIR,
			sendUserMessage: (b) => { sent.push(b); },
		});
		await flush(); // L3：message send + 收据 在 .then 微任务
		assert.equal(r.owner, "sess-A");
		assert.equal(r.consumed.length, 1);
		assert.equal(sent.length, 1, "恰好注入一次（零回归）");
		assert.ok(sent[0]!.includes("tab_c1"));
		assert.ok(sent[0]!.includes("busy-poll"), "mailbox 完成信正文应含禁轮询纪律");
		// C-3：fake send 不 return（= 生产形态）⇒ strict 下为 attempted-unconfirmed：
		// **不收据、不补 .notified、不 ack**（交付由 ACK 决定）；回滚档位保持旧行为。
		if (deliveryStrictEnabled()) {
			assert.equal(r.consumed[0]!.action, "skipped", "strict：不计 injected（未确认）");
			assert.equal(r.consumed[0]!.reason, "attempted-unconfirmed", "如实报告尝试但未确认");
			assert.equal(hasNotificationReceipt("run-tab_c1-completed"), false, "**未确认不得写收据**（P3）");
			assert.equal(existsSync(join(RUNSDIR, "tab_c1.notified")), false, "未确认不得补 .notified（它不再是交付证明）");
		} else {
			assert.equal(r.consumed[0]!.action, "injected");
			assert.equal(hasNotificationReceipt("run-tab_c1-completed"), true, "收据确认");
			assert.ok(existsSync(join(RUNSDIR, "tab_c1.notified")), ".notified 补认领");
		}
		// 重扫（C-3 语义）：strict 下未确认 ⇒ 信已退回 pending ⇒ 下 tick 重投（at-least-once，
		// 目标端按稳定 messageId 去重）；回滚档位已写收据 ⇒ 不重注。
		const sent2: string[] = [];
		const r2 = consumeMailboxOnce({ sessionId: "sess-A", mailboxDir: MAILBOX, runsDir: RUNSDIR, sendUserMessage: (b) => { sent2.push(b); } });
		await flush(); // L3：reportPush 在 send 的 .then 微任务（不 flush 读 r2.consumed 会是空数组）
		assert.equal(r2.consumed.filter((c) => c.action === "injected").length, 0, "无重注");
		if (deliveryStrictEnabled()) {
			// D-1（global Master 2026-10-16 裁定）：unconfirmed 采用**有限退避**（5/10/20/40/80s ±20%）
			// ⇒ 退避窗内的下 tick **不重投**（retry-backoff），信仍 pending（非永久停滞）。
			assert.equal(sent2.length, 0, "strict + D-1：退避窗内不重投");
			assert.ok(r2.consumed.some((c) => c.reason === "retry-backoff"), "如实报 retry-backoff（非静默丢）");
			// 收尾：本块的信仍 pending ⇒ 用真 Promise 路径收敛为 ack，避免污染后续用例
			consumeMailboxOnce({ sessionId: "sess-A", mailboxDir: MAILBOX, runsDir: RUNSDIR, sendUserMessage: () => Promise.resolve() });
			await flush();
		} else {
			assert.equal(sent2.length, 0, "回滚档位：已写收据 ⇒ 不重注");
		}
	}

	// ── 6. 消费端：F17 旧信跳过 ────────────────────────────────────
	{
		deliverLetter(report("tab_old", "2026-01-01T00:00:00.000Z"), { mailboxDir: MAILBOX });
		const sent: string[] = [];
		const r = consumeMailboxOnce({ sessionId: "sess-A", mailboxDir: MAILBOX, runsDir: RUNSDIR, sendUserMessage: (b) => { sent.push(b); } });
		const entry = r.consumed.find((c) => c.reason === "pre-cutover-legacy");
		assert.ok(entry && entry.action === "skipped", "cutover 前旧信留 legacy");
		assert.equal(sent.length, 0);
		const { listLetters } = await import("./runtime/mailbox.ts");
		const letters = listLetters(master, undefined, MAILBOX);
		assert.ok(letters.some((l) => l.status === "pending"), "旧信仍 pending（不动）");
	}

	// ── 7. 消费端：非 owner 零动作 + 注入抛错不确认 ──────────────────
	{
		const now = new Date().toISOString();
		deliverLetter(report("tab_c2", now), { mailboxDir: MAILBOX });
		const r = consumeMailboxOnce({ sessionId: "sess-B", mailboxDir: MAILBOX, runsDir: RUNSDIR, sendUserMessage: () => undefined });
		assert.equal(r.consumed.length, 0, "非 owner 零动作");
		const r2 = consumeMailboxOnce({
			sessionId: "sess-A", mailboxDir: MAILBOX, runsDir: RUNSDIR,
			sendUserMessage: () => { throw new Error("inject boom"); },
		});
		await flush(); // L3：failed 路径 report 在 .then 微任务
		const failed = r2.consumed.find((c) => c.reason === "inject-failed");
		assert.ok(failed, "注入失败记录");
		assert.equal(hasNotificationReceipt("run-tab_c2-completed"), false, "失败不确认收据");
		const { listLetters } = await import("./runtime/mailbox.ts");
		const letters = listLetters(master, undefined, MAILBOX);
		const c2 = letters.find((l) => l.frame.frame === "message" && l.frame.subject === "run://tab/tab_c2")!;
		assert.equal(c2.status, "claimed", "失败信停 claimed（stale 回收重试，不丢）");
	}

	// ── 8. L3：缺注入通道不伪造 mailbox receipt，退回 pending 供恢复后重试 ──
	{
		const now = new Date().toISOString();
		deliverLetter(report("tab_c3", now), { mailboxDir: MAILBOX });
		const r = consumeMailboxOnce({ sessionId: "sess-A", mailboxDir: MAILBOX, runsDir: RUNSDIR });
		await flush();
		assert.ok(r.consumed.some((c) => c.reason === "no-injector"), "无 injector 明确记录，不 ack");
		assert.equal(hasNotificationReceipt("run-tab_c3-completed"), false, "未发送不得确认收据");
		assert.equal(existsSync(join(RUNSDIR, "tab_c3.notified")), false, "未发送不得认领 .notified");
		const { listLetters } = await import("./runtime/mailbox.ts");
		const c3 = listLetters(master, undefined, MAILBOX).find((l) => l.frame.frame === "message" && l.frame.subject === "run://tab/tab_c3")!;
		assert.equal(c3.status, "pending", "无 injector 的信退回 pending");
	}

	// ── 9. legacy 门：flag 开 + 他人 owner → 双链抑制 ────────────────
	{
		const { onTabResultFile, _resetEventBus } = await import("./event-bus.ts");
		const { onNewReport } = await import("./report.ts");
		const { writeFileSync, mkdtempSync: mk } = await import("node:fs");
		const dir = mk(join(tmpdir(), "cutover-legacy-"));
		try {
			_resetEventBus();
			writeFileSync(join(dir, "tab_sup.result.json"), JSON.stringify({
				id: "tab_sup", taskId: "9", status: "completed", finishedAt: new Date().toISOString(), summary: "sup",
			}), "utf8");
			const sent: string[] = [];
			const { setCurrentSessionId } = await import("./identity.ts");
			setCurrentSessionId("sess-B"); // 非 owner 会话
			const ok = onTabResultFile(dir, "tab_sup.result.json", {
				runsDir: dir, toast: false, autoReclaim: true,
				sendUserMessage: (b: string) => { sent.push(b); },
			});
			assert.equal(ok, false, "非 owner 不注入");
			assert.equal(sent.length, 0);
			setCurrentSessionId(undefined);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
		assert.ok(suppressions().length >= 2, "抑制审计累积");
		assert.equal(readCutover()!.enabled, true);
	}
} finally {
	rmSync(process.env.PI_RUNTIME_DIR!, { recursive: true, force: true });
}

console.log("_test_runtime_cutover: all assertions passed");
