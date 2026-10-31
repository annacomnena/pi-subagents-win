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
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "runtime-mailbox-env-"));

import { masterAddress } from "./runtime/address.ts";
import { newEnvelopeId } from "./runtime/ids.ts";
import {
	ackLetter,
	archiveTerminalLetters,
	claimLetters,
	defaultMailboxDir,
	deliverCommand,
	deliverLetter,
	expireSweep,
	backlogFromScan,
	listLetters,
	mailboxBacklog,
	mailboxDirFor,
	markDelivered,
	releaseClaimed,
	scanMailboxLetters,
} from "./runtime/mailbox.ts";
import { newCommandFrame, newMessageFrame } from "./runtime/protocol.ts";
import { buildAttentionItems } from "./runtime-host/attention.ts";

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
	// ── 共享扫描等价性（L2 perf 2026-10-20）──────────────────────────
	// 动因：/v1/snapshot 一拍内 master/workstreams/attention 三处原本各扫一遍全信箱；
	// 现改为共享 scanMailboxLetters 一份。这里钉住「共享产物与各消费方自扫逐字段等价」，
	// 否则降本会静默改变 backlog / attention 结果。
	{
		const scan = scanMailboxLetters(MAILBOX);
		const dirs = new Set(scan.keys());
		assert.ok(dirs.size > 0, "扫描到 spool 目录");
		// ① backlogFromScan == mailboxBacklog（按 recipient 排序后逐字段比）
		const norm = (rows: { recipient: string; pending: number; claimed: number }[]) =>
			[...rows].sort((a, b) => a.recipient.localeCompare(b.recipient));
		assert.deepEqual(norm(backlogFromScan(scan)), norm(mailboxBacklog(MAILBOX)), "backlogFromScan 与 mailboxBacklog 等价");
		// ② 共享信件集 == 各目录自扫（listLetters 全状态）逐条比 id
		for (const recipient of dirs) {
			const sharedIds = (scan.get(recipient) ?? []).map((l) => l.id).sort();
			const direct = listLetters(recipient as never, undefined, MAILBOX).map((l) => l.id).sort();
			assert.deepEqual(sharedIds, direct, `目录 ${recipient}：共享扫描与 listLetters 信件集一致`);
		}
		// ③ attention 用共享扫描与自扫输出一致（同一批 fixture 下）
		const viaShared = buildAttentionItems({ stateDir: join(process.env.PI_RUNTIME_DIR!, "state"), mailboxDir: MAILBOX, letters: scan });
		const viaDirect = buildAttentionItems({ stateDir: join(process.env.PI_RUNTIME_DIR!, "state"), mailboxDir: MAILBOX });
		assert.deepEqual(
			viaShared.map((a) => a.id).sort(),
			viaDirect.map((a) => a.id).sort(),
			"buildAttentionItems：共享信件扫描与自扫输出一致",
		);
	}

	// ── archiveTerminalLetters：只归档终态且超龄的信 ───────────────────
	//
	// 实证背景（2026-10-31 真机）：`ackLetter` 只改 status，**从不删除文件**，
	// `agent___master_default` 目录涨到 164 项，其中 162 封已 ack（最早垮 1.5 个月）。
	// 代价不在磁盘而在每拍扫描成本（同 `audit.jsonl` 涨到 30MB 的缺陷同构）。
	//
	// 下面用 4 组断言锁住归档的**安全边界**（不只是「能归档」）：
	//   ① 终态+超龄 → 归入 _archive-YYYY-MM/
	//   ② **非终态一律不动**（pending/claimed/delivered）—— 移走 claimed = 丢信
	//   ③ 终态但**未超龄**不动（保留短期回查窗口）
	//   ④ 归档后 `listRecipientDirs` 不得把归档目录当收件人（否则降成本为零）
	{
		const MB = join(process.env.PI_RUNTIME_DIR!, "mbox-archive");
		const DAY = 24 * 60 * 60 * 1000;
		const now = Date.parse("2026-11-01T00:00:00.000Z");

		// 注意：`ackLetter` 的 `ackedAt` 用**真实系统时钟**（`new Date()`），无法注入。
		// 所以不能靠“先 ack 再把 now 设到未来”来造超龄信（那样 ackedAt 仍是刚才，
		// 相对 now 只差几秒 ⇒ 不超龄）。改为**直接写带历史 ackedAt 的信件文件**，
		// 这也正是真机形状：文件里的 ackedAt 是一个月前的值。
		const dir = mailboxDirFor(master, MB);
		const mkdirp = (p: string): void => { mkdirSync(p, { recursive: true }); };
		mkdirp(dir);
		const writeLetter = (id: string, status: string, ackedAt?: string, sentAt = "2026-09-01T00:00:00.000Z"): void => {
			const letter = {
				frame: {
					frame: "message", id, kind: "REPORT", from: "agent://a", to: master,
					subject: "archive-test", requiresAck: true, sentAt, body: { summary: "x" },
				},
				status,
				...(ackedAt ? { ackedAt } : {}),
			};
			writeFileSync(join(dir, `${id}.json`), `${JSON.stringify(letter, null, 2)}\n`, "utf8");
		};

		writeLetter("msg_old_acked", "acked", "2026-10-01T00:00:00.000Z"); // 31 天前 ack ⇒ 应归档
		writeLetter("msg_fresh_acked", "acked", "2026-10-30T00:00:00.000Z"); // 2 天前 ack ⇒ 保留
		writeLetter("msg_old_pending", "pending"); // 旧但 pending ⇒ 绝不动
		writeLetter("msg_old_claimed", "claimed"); // 旧但 claimed ⇒ 绝不动（移走 = 丢信）
		writeLetter("msg_old_expired", "expired", "2026-09-15T00:00:00.000Z"); // 终态且超龄 ⇒ 应归档

		const archived = archiveTerminalLetters({ mailboxDir: MB, afterDays: 7, now });
		assert.equal(archived, 2, "应归档 2 封（old_acked + old_expired）");

		// ① 超龄终态已离开扫描路径，且归入 _archive-YYYY-MM/
		assert.equal(existsSync(join(dir, "msg_old_acked.json")), false, "超龄 acked 应已离开扫描路径");
		const archDir = join(dir, "_archive-2026-10");
		assert.ok(existsSync(join(archDir, "msg_old_acked.json")), "应归入 _archive-2026-10/");
		assert.ok(existsSync(join(dir, "_archive-2026-09", "msg_old_expired.json")), "expired 应按自身月份归入 _archive-2026-09/");
		// 归档文件内容必须完整（能回查）
		const back = JSON.parse(readFileSync(join(archDir, "msg_old_acked.json"), "utf8")) as { status: string };
		assert.equal(back.status, "acked", "归档后内容不得变形");

		// ② 非终态一律不动（红线①）
		assert.ok(existsSync(join(dir, "msg_old_pending.json")), "**pending 绝不得归档**");
		assert.ok(existsSync(join(dir, "msg_old_claimed.json")), "**claimed 绝不得归档**（移走 = 丢信）");
		// ③ 终态但未超龄也不动（红线②）
		assert.ok(existsSync(join(dir, "msg_fresh_acked.json")), "未超龄的 acked 应保留");

		// ④ 归档目录不得泄漏到「收件人」列表
		//
		// ⚠ 这里曾写过一条断言 `scanMailboxLetters(keys).some(k => k.includes("_archive")) === false`
		//   —— **它是空判据**：`_archive-*` 在 `<recipient>/` 内部，而 `listLettersSynthetic`
		//   只扫 `*.json` 不递归，所以无论有没有 filter 这条永远为真（变异验证实测：
		//   去掉 filter 后该断言仍绿）。已改成测 `mailboxBacklog` 的 **pending+claimed 总数**：
		//   若归档目录被当成收件人且里面有 pending 信，总数会多出来。
		const backlog = mailboxBacklog(MB);
		const nonTerminalTotal = backlog.reduce((s, r) => s + r.pending + r.claimed, 0);
		assert.equal(
			nonTerminalTotal,
			2,
			`非终态应是 pending(1) + claimed(1) = 2；实际 ${nonTerminalTotal}（归档的终态信不得计入 backlog）`,
		);
		const recipientNames = backlog.map((r) => r.recipient);
		assert.equal(
			recipientNames.some((r) => r.startsWith("_")),
			false,
			`内部目录不得被当成收件人（实际 ${JSON.stringify(recipientNames)}）`,
		);

		// ⑤ 幂等：再跑一次不应重复迁移
		assert.equal(archiveTerminalLetters({ mailboxDir: MB, afterDays: 7, now }), 0, "重复调用应为 0（幂等）");
		// ⑥ 红线③ never-throw：目录不存在也不抛
		assert.equal(archiveTerminalLetters({ mailboxDir: join(MB, "nonexistent"), now }), 0, "目录不存在应返回 0 不抛");

		// ⑦ **状态过滤**的强判别力测试（上面的 ②只有弱判别力，必须补这一段）
		//
		// 为什么上面那几条不够：非终态信没有 `ackedAt`，走 mtime 分支；而 mtime 是刚刚
		// 写入的，`afterDays: 7` 下天然不超龄 ⇒ “不该归档”永远不成立，**即使把
		// `isArchivableStatus` 改成 `return true` 也全绿**（变异实测确认）。
		// 修法：把 `afterDays` 压到接近 0（一切文件都超龄），此时**唯一**能阻止
		// pending/claimed 被归档的就只剩状态过滤本身。
		const MB2 = join(process.env.PI_RUNTIME_DIR!, "mbox-state-filter");
		const dir2 = mailboxDirFor(master, MB2);
		mkdirSync(dir2, { recursive: true });
		const writeRaw = (id: string, status: string): void => {
			const letter = {
				frame: { frame: "message", id, kind: "REPORT", from: "agent://a", to: master, subject: "s", requiresAck: true, sentAt: "2026-09-01T00:00:00.000Z", body: { summary: "x" } },
				status,
			};
			writeFileSync(join(dir2, `${id}.json`), `${JSON.stringify(letter, null, 2)}\n`, "utf8");
		};
		writeRaw("sf_pending", "pending");
		writeRaw("sf_claimed", "claimed");
		writeRaw("sf_delivered", "delivered");
		writeRaw("sf_acked", "acked");
		// afterDays 极小 ⇒ 所有文件（含刚写的）都超龄 ⇒ 只剩状态过滤在起作用。
		// 注意：不能用 `afterDays: 0.000001` + 当前时钟（cutoff 几乎等于 now，文件 mtime
		// 与 now 的毫秒级差异决定结果 ⇒ 不稳定）。正确做法：`afterDays` 正常（1 天），
		// 但把 `now` 推到 **1 天后** ⇒ 一切刚写的文件都已超龄，而状态过滤仍生效。
		const future = Date.now() + 2 * 24 * 60 * 60 * 1000;
		const movedByStatus = archiveTerminalLetters({ mailboxDir: MB2, afterDays: 1, now: future });
		assert.equal(movedByStatus, 1, `超龄时只应归档 acked 一封（实际 ${movedByStatus}）—— 状态过滤失效就会多移`);
		assert.ok(existsSync(join(dir2, "sf_pending.json")), "超龄也不得归档 pending");
		assert.ok(existsSync(join(dir2, "sf_claimed.json")), "超龄也不得归档 claimed（移走 = 丢信）");
		assert.ok(existsSync(join(dir2, "sf_delivered.json")), "超龄也不得归档 delivered（尚未 ack）");
		assert.equal(existsSync(join(dir2, "sf_acked.json")), false, "超龄 acked 应被归档");
	}
} finally {
	rmSync(process.env.PI_RUNTIME_DIR!, { recursive: true, force: true });
}

console.log("_test_runtime_mailbox: all assertions passed");
