/**
 * _test_delivery_coalesce_hold_flush.ts — busy 期合批 **S2(hhttps hold) + S3(flush)** 接线验收
 *
 * 依据：`plans/20261112_delivery_coalesce_design.md` §6 单测 5/6/7/8 号。
 *
 * ## 覆盖
 *   H1 hold：busy 时 claim → **不注入**、**不 releaseClaimed**、信 `claimed`+`hold`；
 *      退避计数不变（它压根没尝试注入）。
 *   H2 urgent 穿透：busy 时 `CONTROL` / `session.abort` **照常注入**（不进 hold）。
 *   H3 flush 合并：3 条 hold 信 ⇒ `agent_settled`/flush ⇒ **1 条**用户消息、
 *      正文含 3 个 `[evt:...]`（生产提取器捞回 3）、hold 被清除、`claimed` 保留。
 *   H4 flush 竞态：注入前 busy 门翻回忙 ⇒ **不注入**、hold 保留（下轮再冲）。
 *   H5 超龄强冲：`hold.at` 早于 15min ⇒ 即便 busy 也冲。
 *   H6 崩溃恢复：盘上遗留 `claimed`+`hold` ⇒ flush 恰好消化一次（不重复吐）。
 *   H7 回滚档：`disableBusyHold:true` ⇒ busy 也照常注入（与合批之前逐字节一致）。
 *
 * ## 隔离
 * `PI_RUNTIME_DIR` 在 import 前指到 mkdtemp；busy 目录/pid 探活全注入。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "coalesce-hf-"));
process.env.PI_RUNTIME_DIR = ROOT;

import { masterAddress } from "./runtime/address.ts";
import { newEnvelopeId } from "./runtime/ids.ts";
import { attachMaster, setCutover } from "./runtime/registry.ts";
import { claimLetters, deliverLetter, listLetters } from "./runtime/mailbox.ts";
import { newMessageFrame } from "./runtime/protocol.ts";
import { flushHeldLetters, consumeMailboxOnce } from "./mailbox-consumer.ts";
import { extractEventIdsFromMessages } from "./delivery-ack.ts";
import { listEvents } from "./delivery-ledger.ts";
import { HOLD_MAX_AGE_MS, BUSY_STALE_MS } from "./coalesce.ts";

let n = 0;
const ok = (name: string): void => { n += 1; console.log(`ok ${n} - ${name}`); };
const flushMicro = (): Promise<void> => new Promise((r) => setImmediate(r));

const MAILBOX = join(ROOT, "mailbox");
const DELIVERY = join(ROOT, "delivery");
const BUSY = join(ROOT, "state", "session-busy");
const master = masterAddress();
const SID = "sess-cf";

/** 造一封 default 可合并的 RESULT 信并投进 spool。 */
function seed(kind: "REPORT" | "RESULT" | "CONTROL" | "DELEGATION", summary: string, at?: string): string {
	const frame = newMessageFrame({
		id: newEnvelopeId("msg"),
		kind,
		from: "agent://agent_cf",
		to: master,
		sentAt: at ?? new Date().toISOString(),
		summary,
		details: { tabRunId: "tab_cf", status: "completed" },
	});
	deliverLetter(frame, { mailboxDir: MAILBOX });
	return String(frame.id);
}

/** 写 busy 标记（新鲜心跳 + 活 pid）。 */
function setBusy(nowMs: number): void {
	mkdirSync(BUSY, { recursive: true });
	writeFileSync(
		join(BUSY, `${SID}.json`),
		JSON.stringify({ version: 1, sessionId: SID, busy: true, at: new Date(nowMs - 1_000).toISOString(), since: new Date(nowMs - 60_000).toISOString(), pid: 4242 }),
		"utf8",
	);
}

/** 删 busy 标记（= agent_settled）。 */
function clearBusy(): void {
	rmSync(join(BUSY, `${SID}.json`), { force: true });
}

const alive = (): boolean => true;
const busyGateOpts = { dir: BUSY, isPidAlive: alive };

/** 取某封信当前状态。 */
function statusOf(id: string): string | undefined {
	return listLetters(master, undefined, MAILBOX).find((l) => l.frame.frame === "message" && (l.frame as { id?: string }).id === id)?.status;
}
/** 取某封信的 hold 字段。 */
function holdOf(id: string) {
	return listLetters(master, undefined, MAILBOX).find((l) => l.frame.frame === "message" && (l.frame as { id?: string }).id === id)?.hold;
}

try {
	mkdirSync(MAILBOX, { recursive: true });
	attachMaster({ sessionId: SID });
	setCutover(true);

	// ── H1：busy ⇒ hold，不注入、不退回 pending ─────────────────────
	{
		const now = Date.now();
		setBusy(now);
		const id1 = seed("RESULT", "第一条交接回执");
		const id2 = seed("REPORT", "第二条完成通知", new Date(now + 1_000).toISOString());
		const sent: string[] = [];
		const r = consumeMailboxOnce({ sessionId: SID, mailboxDir: MAILBOX, deliveryDir: DELIVERY, runsDir: join(ROOT, "tab-runs"), busyGateOpts, sendUserMessage: (b) => { sent.push(b); } });
		await flushMicro();
		assert.equal(sent.length, 0, "**busy ⇒ 一条都不许注入**");
		assert.ok(r.consumed.some((c) => c.action === "held"), `报告 held（实得 ${JSON.stringify(r.consumed)}）`);
		assert.equal(statusOf(id1), "claimed", "**信停 claimed（不 releaseClaimed 退回 pending）**");
		assert.equal(statusOf(id2), "claimed", "第二封同样 claimed");
		assert.ok(holdOf(id1)?.at, "hold.at 已写（超龄判据依赖它）");
		assert.equal(holdOf(id1)?.reason, "session-busy");
		ok("H1 hold：busy ⇒ 不注入 + 不退回 pending + hold 字段落盘");
	}

	// ── H3：flush 合并 —— 3 条 hold ⇒ 1 条用户消息 → 标记全在 ──────────
	let flushedIds: string[] = [];
	{
		const now = Date.now();
		// 第三条也要先进 hold（H1 里只造了 2 条）：保持 busy 再 consume 一轮
		setBusy(now);
		const id3 = seed("QUESTION", "第三条疑问");
		consumeMailboxOnce({ sessionId: SID, mailboxDir: MAILBOX, deliveryDir: DELIVERY, runsDir: join(ROOT, "tab-runs"), busyGateOpts, nowMs: now, sendUserMessage: () => { throw new Error("busy 时不该注入"); } });
		await flushMicro();
		assert.ok(holdOf(id3), "第三条也进了 hold（腾入 3 条）");
		flushedIds = [id3];
		clearBusy(); // 模拟 agent_settled
		const sent: string[] = [];
		const res = flushHeldLetters({ sessionId: SID, mailboxDir: MAILBOX, deliveryDir: DELIVERY, busyGateOpts, nowMs: now, sendUserMessage: (b) => { sent.push(b); } });
		assert.equal(sent.length, 1, `**3 条 hold 合成 1 条注入**（实得 ${sent.length}）`);
		assert.equal(res.injectedBatches, 1);
		assert.equal(res.clearedLetters, 3, `hold 全部清除（实得 ${res.clearedLetters}）`);

		const evt = extractEventIdsFromMessages([{ role: "user", content: sent[0]! }]);
		// **精确集合**（不是 ≥3）：L4 F7 的 M2 变异「额外追加 [evt:async:forged:1]」正是靠
		// 「计数 ≥3」蒙过去的。这里要求恰好等于这 3 封的 eventId，多一个都算伪造。
		const expectedEvts = listEvents(DELIVERY, 500)
			.filter((e) => e.runId.startsWith("mailbox_"))
			.map((e) => e.eventId)
			.filter((id) => evt.includes(id));
		assert.equal(evt.length, 3, `**合成正文必须恰好带 3 个 eventId**（实得 ${JSON.stringify(evt)}）`);
		assert.deepEqual([...evt].sort(), [...expectedEvts].sort(), "且每个都能对上本批的 ledger 事件（无多无少）");
		assert.ok(sent[0]!.includes("批量投递（3 条"), "表头写明条数");
		assert.ok(sent[0]!.includes("第一条交接回执"), "含第 1 条正文");

		const all = listLetters(master, undefined, MAILBOX);
		assert.equal(all.filter((l) => l.hold !== undefined).length, 0, "**所有 hold 已清除**");
		assert.equal(all.filter((l) => l.frame.frame === "message").every((l) => l.status === "claimed"), true, "claimed 保留（销账仍归 consumed ACK）");

		// **真实 ACK 闭环**（L4 F7：只断言 hold 清除不等于销账链通了）：
		// 模拟 `pi.on("context")` 检出这 3 个标记 ⇒ ackConsumed ⇒ 消费端 sweepClaimedLetters 收尾。
		const { ackConsumed } = await import("./delivery-ack.ts");
		const { sweepClaimedLetters } = await import("./mailbox-consumer.ts");
		ackConsumed(DELIVERY, [...evt], { evidence: "context-observed" });
		const swept = sweepClaimedLetters({ mailboxDir: MAILBOX, deliveryDir: DELIVERY });
		assert.equal(swept, 3, `**3 封全部被 sweep 收尾成 acked**（实得 ${swept}）`);
		assert.equal(
			listLetters(master, undefined, MAILBOX).filter((l) => l.frame.frame === "message").every((l) => l.status === "acked"),
			true,
			"三封状态 = acked（端到端：合批 → 标记 → context ACK → 销账）",
		);
		ok("H3 flush：3 条 ⇒ 1 条消息、精确标记集合、hold 清除、**且 ACK→sweep 真销账**");
	}

	// ── H4：flush 竞态 —— 注入前 busy 翻回忙 ⇒ 不注入、hold 保留 ────────
	{
		const now = Date.now();
		const id4 = seed("REPORT", "竞态样本");
		// 手工造一条 hold（绕过 consume），再让 busy 门为忙
		claimLetters(master, { claimedBy: `mailbox-consumer:${SID}`, mailboxDir: MAILBOX, ids: [id4], limit: 1 });
		const { writeHold } = await import("./runtime/mailbox.ts");
		writeHold(master, id4, { cls: "mergeable", reason: "session-busy", nowMs: now - 1_000, claimedBy: `mailbox-consumer:${SID}`, mailboxDir: MAILBOX });
		setBusy(now); // settled 之后又起了一个 turn
		const sent: string[] = [];
		const res = flushHeldLetters({ sessionId: SID, mailboxDir: MAILBOX, deliveryDir: DELIVERY, busyGateOpts, nowMs: now, sendUserMessage: (b) => { sent.push(b); } });
		assert.equal(sent.length, 0, "busy-again ⇒ 不注入");
		assert.equal(res.reason, "busy-again");
		assert.ok(holdOf(id4), "hold 保留（下轮再冲，不丢）");
		ok("H4 竞态：注入前 busy 翻回忙 ⇒ 不注入、hold 保留");
	}

	// ── H5：超龄强冲 —— 压超 15min ⇒ 即便 busy 也冲 ────────────────────
	{
		const now = Date.now();
		const id5 = seed("REPORT", "超龄样本");
		claimLetters(master, { claimedBy: `mailbox-consumer:${SID}`, mailboxDir: MAILBOX, ids: [id5], limit: 1 });
		const { writeHold } = await import("./runtime/mailbox.ts");
		// hold.at 手工设成 16 分钟前
		writeHold(master, id5, { cls: "mergeable", reason: "session-busy", nowMs: now - HOLD_MAX_AGE_MS - 60_000, claimedBy: `mailbox-consumer:${SID}`, mailboxDir: MAILBOX });
		const sent: string[] = [];
		const res = flushHeldLetters({ sessionId: SID, mailboxDir: MAILBOX, deliveryDir: DELIVERY, busyGateOpts, nowMs: now, sendUserMessage: (b) => { sent.push(b); } });
		assert.equal(sent.length, 1, `**超龄 ⇒ 即便 busy 也冲**（实得 ${sent.length}，reason=${res.reason}）`);
		assert.ok(!holdOf(id5), "hold 已清除");
		clearBusy();
		ok("H5 超龄强冲：压超 15min ⇒ 无视 busy 照冲（防长任务无限压信）");
	}

	// ── H2：urgent 穿透 —— busy 时 CONTROL 照常注入 ────────────────────
	{
		const now = Date.now();
		setBusy(now);
		const idc = seed("CONTROL", "停机指令");
		const sent: string[] = [];
		const r = consumeMailboxOnce({ sessionId: SID, mailboxDir: MAILBOX, deliveryDir: DELIVERY, runsDir: join(ROOT, "tab-runs"), busyGateOpts, nowMs: now, sendUserMessage: (b) => { sent.push(b); } });
		await flushMicro();
		assert.equal(sent.length, 1, `**urgent 不进 hold，忙时照常注入**（实得 ${sent.length}）`);
		assert.equal(holdOf(idc), undefined, "CONTROL 没有 hold 字段");
		assert.ok(r.consumed.some((c) => c.reason === "attempted-unconfirmed" || c.action === "injected"), `走正常注入路径（实得 ${JSON.stringify(r.consumed)}）`);
		clearBusy();
		ok("H2 urgent 穿透：busy 时 CONTROL 照常注入，不进 hold");
	}

	// ── H7：回滚档 —— disableBusyHold ⇒ 与合批之前一致 ─────────────────
	{
		const now = Date.now();
		setBusy(now);
		const idd = seed("REPORT", "回滚档样本");
		const sent: string[] = [];
		consumeMailboxOnce({ sessionId: SID, mailboxDir: MAILBOX, deliveryDir: DELIVERY, runsDir: join(ROOT, "tab-runs"), busyGateOpts, disableBusyHold: true, nowMs: now, sendUserMessage: (b) => { sent.push(b); } });
		await flushMicro();
		assert.equal(sent.length, 1, `**disableBusyHold ⇒ 忙也照常注入**（实得 ${sent.length}）`);
		assert.equal(holdOf(idd), undefined, "无 hold 字段（完全跳过 S2）");
		clearBusy();
		ok("H7 回滚档：disableBusyHold=true ⇒ 与合批之前逐字节一致");
	}

	// ── H6：崩溃恢复 —— 盘上遗留 claimed+hold，flush 恰好消化一次 ──────
	{
		const now = Date.now();
		const ide = seed("REPORT", "崩溃恢复样本");
		claimLetters(master, { claimedBy: `mailbox-consumer:${SID}`, mailboxDir: MAILBOX, ids: [ide], limit: 1 });
		const { writeHold } = await import("./runtime/mailbox.ts");
		writeHold(master, ide, { cls: "mergeable", reason: "session-busy", nowMs: now - 5_000, claimedBy: `mailbox-consumer:${SID}`, mailboxDir: MAILBOX });
		clearBusy();

		const sent1: string[] = [];
		const r1 = flushHeldLetters({ sessionId: SID, mailboxDir: MAILBOX, deliveryDir: DELIVERY, busyGateOpts, nowMs: now, sendUserMessage: (b) => { sent1.push(b); } });
		assert.equal(sent1.length, 1, "重启后首个 idle flush 消化 1 条");
		assert.equal(r1.clearedLetters, 1);

		const sent2: string[] = [];
		const r2 = flushHeldLetters({ sessionId: SID, mailboxDir: MAILBOX, deliveryDir: DELIVERY, busyGateOpts, nowMs: now, sendUserMessage: (b) => { sent2.push(b); } });
		assert.equal(sent2.length, 0, "**第二次 flush 零动作（不重复吐）**");
		assert.equal(r2.reason, "no-held");
		ok("H6 崩溃恢复：遗留 claimed+hold 恰好消化一次，不重复吐");
	}

	// 兜底：整轮结束所有信都应无 hold
	assert.equal(listLetters(master, undefined, MAILBOX).filter((l) => l.hold !== undefined).length, 0, "收尾：hold 全清");
	console.log(`\n_test_delivery_coalesce_hold_flush: all ${n} groups passed`);
} finally {
	rmSync(ROOT, { recursive: true, force: true });
}
