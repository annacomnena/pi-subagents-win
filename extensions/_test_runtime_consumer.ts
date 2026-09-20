/**
 * _test_runtime_consumer.ts — Phase 4c 测试（附记 A4 F8）
 *
 * 覆盖：
 *   - owner 扫描 → would-deliver（followUp-inject，收据键对齐）
 *   - 非 owner → not-owner；无 attachment → unattached
 *   - 已通知（收据存在）→ already-notified
 *   - rollover 后：旧 owner 扫描 → not-owner；新 owner → would-deliver（fencing）
 *   - decideOwnership 纯函数：generation-moved 分支
 *   - F8 核心：扫描零污染（全部 letter 仍 pending，无 claimed/acked 副作用）
 *   - command 信 → execute-command
 *
 * 运行：npm run test:runtime-consumer
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "runtime-consumer-env-"));

import { masterAddress } from "./runtime/address.ts";
import { newEnvelopeId } from "./runtime/ids.ts";
import { attachMaster, detachMaster } from "./runtime/registry.ts";
import { deliverCommand, deliverLetter, listLetters } from "./runtime/mailbox.ts";
import { newCommandFrame, newMessageFrame } from "./runtime/protocol.ts";
import { recordNotificationReceipt } from "./runtime/receipts.ts";
import { decideOwnership, scanMailboxForDelivery } from "./runtime/consumer-scan.ts";

const MAILBOX = join(process.env.PI_RUNTIME_DIR!, "mailbox");
const master = masterAddress();

function report(summary: string, tab = "tab_scan_1") {
	return newMessageFrame({
		id: newEnvelopeId("msg"),
		kind: "REPORT",
		from: "agent://agent_worker_1",
		to: master,
		subject: `run://tab/${tab}`,
		sentAt: "2026-09-17T17:00:00.000Z",
		summary,
		details: { tabRunId: tab, status: "completed" },
	});
}

try {
	// ── 0. 无 attachment → unattached（legacy 拥有）─────────────────
	deliverLetter(report("s0"), { mailboxDir: MAILBOX });
	{
		const r = scanMailboxForDelivery({ sessionId: "sess-A", mailboxDir: MAILBOX });
		assert.equal(r.owner, null);
		assert.equal(r.decisions.every((d) => !d.deliver && d.reason === "unattached"), true);
	}

	// ── 1. owner 扫描 → would-deliver ───────────────────────────────
	attachMaster({ sessionId: "sess-A" });
	deliverLetter(report("s1", "tab_scan_2"), { mailboxDir: MAILBOX });
	{
		const r = scanMailboxForDelivery({ sessionId: "sess-A", mailboxDir: MAILBOX });
		assert.equal(r.owner!.sessionId, "sess-A");
		const delivering = r.decisions.filter((d) => d.deliver);
		assert.equal(delivering.length, 2, "两封 pending 皆可投");
		assert.ok(delivering.every((d) => d.would!.action === "followUp-inject"));
		assert.equal(delivering[0]!.would!.receiptKey, "run-tab_scan_1-completed", "收据键与 F5 对齐");
	}

	// ── 2. 非 owner → not-owner ─────────────────────────────────────
	{
		const r = scanMailboxForDelivery({ sessionId: "sess-B", mailboxDir: MAILBOX });
		assert.equal(r.decisions.every((d) => !d.deliver && d.reason === "not-owner"), true);
	}

	// ── 3. 已通知 → already-notified ────────────────────────────────
	recordNotificationReceipt("run-tab_scan_1-completed", "test");
	{
		const r = scanMailboxForDelivery({ sessionId: "sess-A", mailboxDir: MAILBOX });
		const byId = new Map(r.decisions.map((d) => [d.messageId, d]));
		const first = [...byId.values()].find((d) => d.would?.receiptKey === "run-tab_scan_1-completed" || d.reason === "already-notified")!;
		assert.equal(first.deliver, false);
		assert.equal(first.reason, "already-notified");
		assert.equal(r.decisions.filter((d) => d.deliver).length, 1, "另一封仍可投");
	}

	// ── 4. rollover fencing：旧 owner 出局，新 owner 接管 ────────────
	{
		const d = detachMaster({ sessionId: "sess-A", generation: 1 });
		assert.equal(d.ok, true);
		attachMaster({ sessionId: "sess-B", token: d.token! });
		const oldOwner = scanMailboxForDelivery({ sessionId: "sess-A", mailboxDir: MAILBOX });
		assert.equal(oldOwner.decisions.every((x) => !x.deliver && x.reason === "not-owner"), true, "旧 owner 断代后不可消费");
		const newOwner = scanMailboxForDelivery({ sessionId: "sess-B", mailboxDir: MAILBOX });
		assert.equal(newOwner.owner!.generation, 2);
		assert.equal(newOwner.decisions.filter((x) => x.deliver).length, 1, "新 owner 接管未通知的那封");
	}

	// ── 5. decideOwnership 纯函数：generation-moved ─────────────────
	{
		const moved = decideOwnership(
			{ sessionId: "sess-B", generation: 2 },
			{ sessionId: "sess-C", generation: 3 },
			"sess-B",
		);
		assert.equal(moved.ok, false);
		assert.equal(!moved.ok && moved.reason, "generation-moved");
		const same = decideOwnership(
			{ sessionId: "sess-B", generation: 2 },
			{ sessionId: "sess-B", generation: 2 },
			"sess-B",
		);
		assert.equal(same.ok, true);
	}

	// ── 6. command 信 → execute-command ─────────────────────────────
	{
		deliverCommand(
			newCommandFrame({ type: "agent.wake", to: master, issuedBy: "agent://agent_worker_1", commandKey: "wake:tab_k", issuedAt: "2026-09-17T18:00:00.000Z" }),
			{ mailboxDir: MAILBOX },
		);
		const r = scanMailboxForDelivery({ sessionId: "sess-B", mailboxDir: MAILBOX });
		const cmd = r.decisions.find((x) => x.would?.action === "execute-command")!;
		assert.ok(cmd && cmd.deliver, "command 进入执行队列");
	}

	// ── 7. F8 核心：扫描零污染 ─────────────────────────────────────
	{
		const all = listLetters(master, undefined, MAILBOX);
		assert.ok(all.length >= 3);
		assert.equal(all.every((l) => l.status === "pending"), true, "扫描后全部仍 pending：无 claim/ack/收据写入副作用");
	}
} finally {
	rmSync(process.env.PI_RUNTIME_DIR!, { recursive: true, force: true });
}

console.log("_test_runtime_consumer: all assertions passed");
