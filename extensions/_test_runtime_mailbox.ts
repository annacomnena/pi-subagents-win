/**
 * _test_runtime_mailbox.ts — Phase 3 Commit B 测试（§27-28）
 *
 * 覆盖：
 *   - deliver：pending 落盘 + 同 messageId 幂等 no-op + 非法帧拒绝
 *   - claim：按 frame 时间序领取、stale reclaim（at-least-once）、limit
 *   - ack / markDelivered 状态机门（非法迁移拒绝）
 *   - expireSweep：TTL 到期 → expired；acked 不动
 *   - logical recipient 隔离：不同 recipient 各自 spool（§28 sessionId 不得作 recipient）
 *   - mailboxBacklog 聚合
 *
 * 运行：npm run test:runtime-mailbox
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "runtime-mailbox-env-"));

import { masterAddress } from "./runtime/address.ts";
import { newEnvelopeId } from "./runtime/ids.ts";
import {
	ackLetter,
	claimLetters,
	defaultMailboxDir,
	deliverCommand,
	deliverLetter,
	expireSweep,
	listLetters,
	mailboxBacklog,
	markDelivered,
	releaseClaimed,
} from "./runtime/mailbox.ts";
import { newCommandFrame, newMessageFrame } from "./runtime/protocol.ts";

const MAILBOX = join(process.env.PI_RUNTIME_DIR!, "mailbox");
const master = masterAddress();

function msg(kind: Parameters<typeof newMessageFrame>[0]["kind"], at: string, to = master) {
	return newMessageFrame({
		id: newEnvelopeId("msg"),
		kind,
		from: "agent://agent_worker_1",
		to,
		sentAt: at,
		summary: `summary-${kind}-${at}`,
	});
}

try {
	// ── 1. deliver：pending 落盘 ───────────────────────────────────
	{
		const m = msg("REPORT", "2026-09-17T10:00:00.000Z");
		const { letter, created } = deliverLetter(m, { mailboxDir: MAILBOX });
		assert.equal(created, true);
		assert.equal(letter.status, "pending");
		assert.equal(listLetters(master, "pending", MAILBOX).length, 1);
	}

	// ── 2. 幂等：同 messageId 重复投递 no-op ───────────────────────
	{
		const m = msg("QUESTION", "2026-09-17T10:01:00.000Z");
		const first = deliverLetter(m, { mailboxDir: MAILBOX });
		const second = deliverLetter(m, { mailboxDir: MAILBOX });
		assert.equal(first.created, true);
		assert.equal(second.created, false, "同 messageId 不重投");
		assert.equal(listLetters(master, undefined, MAILBOX).length, 2);
	}

	// ── 3. claim：时间序 + claimed 状态 + claimedBy ────────────────
	{
		deliverLetter(msg("RESULT", "2026-09-17T10:02:00.000Z"), { mailboxDir: MAILBOX });
		deliverLetter(msg("ESCALATION", "2026-09-17T10:00:30.000Z"), { mailboxDir: MAILBOX });

		const taken = claimLetters(master, { claimedBy: "agent://master_default", mailboxDir: MAILBOX });
		assert.equal(taken.length, 4);
		// 时间序：10:00:00(REPORT) → 10:00:30(ESCALATION) → 10:01(QUESTION) → 10:02(RESULT)
		const firstKind = taken[0].frame.frame === "message" ? taken[0].frame.kind : "";
		assert.equal(firstKind, "REPORT");
		assert.equal(taken.every((l) => l.status === "claimed"), true);
		assert.equal(listLetters(master, "pending", MAILBOX).length, 0);

		// 立刻再 claim：空（无 pending，claimed 未过 stale 窗口）
		assert.equal(claimLetters(master, { claimedBy: "x", mailboxDir: MAILBOX }).length, 0);
	}

	// ── 4. stale reclaim（at-least-once 崩溃恢复）──────────────────
	{
		const taken = claimLetters(master, {
			claimedBy: "crashed-session",
			mailboxDir: MAILBOX,
			reclaimAfterMs: -1, // 全部视为 stale（测试压缩时间）
		});
		assert.equal(taken.length, 4, "claimed 超时可重领");
	}

	// ── 5. ack 状态机门 ────────────────────────────────────────────
	{
		const m = msg("DELEGATION", "2026-09-17T11:00:00.000Z");
		const { letter } = deliverLetter(m, { mailboxDir: MAILBOX });
		const id = letter.frame.frame === "message" ? letter.frame.id : "";

		assert.equal(ackLetter(master, id, { mailboxDir: MAILBOX }), null, "pending 直接 ack 拒绝");
		claimLetters(master, { claimedBy: "w", mailboxDir: MAILBOX });
		assert.equal(markDelivered(master, id, { mailboxDir: MAILBOX })!.status, "delivered");
		assert.equal(ackLetter(master, id, { mailboxDir: MAILBOX })!.status, "acked");
		assert.equal(ackLetter(master, id, { mailboxDir: MAILBOX }), null, "acked 不可再 ack");
	}

	// ── 6. expireSweep：TTL 到期 → expired，acked 不动 ─────────────
	{
		deliverLetter(msg("CONTROL", "2026-09-17T12:00:00.000Z"), {
			mailboxDir: MAILBOX,
			expiresAt: new Date(Date.now() - 1000).toISOString(), // 1 秒前 → 必然已过期（不依赖墙钟假设）
		});
		assert.equal(expireSweep(undefined, { mailboxDir: MAILBOX }), 1);
		const expired = listLetters(master, "expired", MAILBOX);
		assert.equal(expired.length, 1);
		assert.equal(listLetters(master, "acked", MAILBOX).length, 1, "acked 不被 sweep");
	}

	// ── 7. logical recipient 隔离（§28）：不同 to 各自 spool ───────
	{
		const other = "agent://agent_worker_2";
		deliverLetter(msg("REPORT", "2026-09-17T13:00:00.000Z", other), { mailboxDir: MAILBOX });
		assert.equal(listLetters(master, "pending", MAILBOX).length, 0, "master 不见别人的信");
		assert.equal(listLetters(other, "pending", MAILBOX).length, 1);
	}

	// ── 8. Command 投递 + backlog 聚合 ─────────────────────────────
	{
		const c = newCommandFrame({
			type: "agent.wake",
			to: master,
			issuedBy: "agent://agent_worker_1",
			commandKey: "wake:tab_y",
			issuedAt: "2026-09-17T14:00:00.000Z",
		});
		const { letter, created } = deliverCommand(c, { mailboxDir: MAILBOX });
		assert.equal(created, true);
		assert.equal(letter.status, "pending");

		const backlog = mailboxBacklog(MAILBOX);
		const masterRow = backlog.find((r) => r.recipient.includes("master"))!;
		assert.equal(masterRow.pending, 1, "master 仅剩 command 一封 pending（其余已终态）");
	}

	// ── 9. F7：dedupeId 原子 slot（terra 缺陷 #1/#2，附记 A4）────────
	{
		const a = msg("REPORT", "2026-09-17T15:00:00.000Z");
		const b = msg("REPORT", "2026-09-17T15:00:00.000Z"); // 不同帧实例（模拟第二个 watcher）
		const first = deliverLetter(a, { mailboxDir: MAILBOX, dedupeId: "run-tab_f7-completed" });
		const second = deliverLetter(b, { mailboxDir: MAILBOX, dedupeId: "run-tab_f7-completed" });
		assert.equal(first.created, true);
		assert.equal(second.created, false, "同 dedupeId 第二次不重投");
		assert.equal(second.letter.frame.frame === "message" ? second.letter.frame.id : "", first.letter.frame.frame === "message" ? first.letter.frame.id : "", "输家返回赢家的信（同 messageId）");

		// 缺陷 #1 回归：dedupe 信可按 frame.id ack（文件名恒等于 messageId）
		const mid = first.letter.frame.frame === "message" ? first.letter.frame.id : "";
		claimLetters(master, { claimedBy: "w", mailboxDir: MAILBOX });
		const acked = ackLetter(master, mid, { mailboxDir: MAILBOX });
		assert.ok(acked && acked.status === "acked", "dedupe 信 ack 可达");
	}

	// ── 10. 旧 dedupe 命名信件兼容（F7 前落盘，scan 兜底）────────────
	{
		const { writeFileSync } = await import("node:fs");
		const { mailboxDirFor } = await import("./runtime/mailbox.ts");
		const legacy = newMessageFrame({
			id: newEnvelopeId("msg"),
			kind: "REPORT",
			from: "agent://agent_worker_1",
			to: master,
			sentAt: "2026-09-17T16:00:00.000Z",
			summary: "legacy file",
		});
		const dir = mailboxDirFor(master, MAILBOX);
		writeFileSync(join(dir, "run-tab_legacy-completed.json"), JSON.stringify({ frame: legacy, status: "claimed" }), "utf8");
		const mid = legacy.id;
		const acked = ackLetter(master, mid, { mailboxDir: MAILBOX });
		assert.ok(acked && acked.status === "acked", "旧命名信件 ack 可达（scan 兜底）");
	}

	// ── 11. L3 releaseClaimed：claimed→pending（忙时冲突释放认领，供下 tick 重试）────────
	{
		const letter = deliverLetter(msg("REPORT", new Date().toISOString()), { mailboxDir: MAILBOX });
		const mid = letter.letter.frame.frame === "message" ? letter.letter.frame.id : "";
		const holder = "mailbox-consumer:holder-A";
		const taken = claimLetters(master, { claimedBy: holder, mailboxDir: MAILBOX, ids: [mid], limit: 1 });
		assert.equal(taken.length, 1, "定向 claim 成功");
		assert.equal(taken[0]!.status, "claimed");
		// 持有者不匹配 → no-op（避免误放已被他人 stale 接管、claimedBy 已变的信）
		assert.equal(releaseClaimed(master, mid, "mailbox-consumer:other", { mailboxDir: MAILBOX }), null, "异 holder → no-op");
		assert.equal(listLetters(master, "claimed", MAILBOX).find((l) => l.frame.frame === "message" && l.frame.id === mid)?.status, "claimed", "no-op 后仍 claimed");
		// 同 holder → 释放（claimed→pending，清 claimedAt/claimedBy），下 tick 可重新领取
		const released = releaseClaimed(master, mid, holder, { mailboxDir: MAILBOX });
		assert.ok(released && released.status === "pending", "同 holder → 释放回 pending");
		assert.equal(released!.claimedBy, undefined, "claimedBy 已清");
		assert.equal(released!.claimedAt, undefined, "claimedAt 已清");
		const retaken = claimLetters(master, { claimedBy: holder, mailboxDir: MAILBOX, ids: [mid], limit: 1 });
		assert.equal(retaken.length, 1, "释放后可重新领取（下 tick 重试收敛）");
		assert.ok(ackLetter(master, mid, { mailboxDir: MAILBOX }), "收尾：置终态不干扰后续枚举");
	}
} finally {
	rmSync(process.env.PI_RUNTIME_DIR!, { recursive: true, force: true });
}

console.log("_test_runtime_mailbox: all assertions passed");
