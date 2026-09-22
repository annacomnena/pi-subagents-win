/**
 * _test_message_outbox.ts — G6-P2 测试：session.message 两段式投递（outbox 纯库 + 扩展桥
 * + HTTP 端到端，plans/0920_g6_webconsole_plan.md §3 拍板③）
 *
 * 覆盖：
 *   M1 outbox 纯库：建项/读/枚举（坏文件跳过）/终态守卫（pending → delivered|failed|expired；
 *      终态不可再迁移）/结构校验（id 与文件名严格比对）
 *   M2 桥 happy path：本会话 pending → 注入（fake sendUserMessage，正文含来源标注+原文+dedupe
 *      稳定标记）→ delivered 回写 + journal message.delivered（dedupeKey=outboxId）；非本会话/非
 *      pending 项零接触
 *   M3 桥 failed 路径：注入抛异常 → failed 回写（error 摘要）+ journal message.failed
 *   M4 收据回放：预置 injected 收据 → receipt-replayed（补写 delivered，不二次注入）；
 *      claimed-by-other → skip；confirm 后重跑零重复注入
 *   M5 注册形态：registerOutboxBridge 返回解绑函数；子 agent / 无 sessionId 不建 interval；
 *      session_start 启动即扫（不等首个 tick）
 *   M6 端到端（HTTP）：POST session.message（token 认证）→ accepted → outbox pending →
 *      桥消费 → delivered；WS outbox 主题能看到 queued+delivered 事件（对 host 实测）
 *   M7 crash-window（必修 1）：注入后回写前崩溃 → stale 接管重投（at-least-once；残留新鲜
 *      claim 含同 holder 一律让位），重投正文逐字相同（dedupe 标记稳定）→ 目标端按标记幂等
 *      去重后有效消息恰 1；异 holder 崩溃残留同路径 stale 接管收敛 delivered
 *   M8 缺失 sender（必修 1）：无注入通道 → skipped(no-injector)，不 claim 不伪造终态
 *   M9 confirm 核实（必修 1）：confirmInjection 失败（claim 恰被删）→ 不回写 delivered、
 *      留 pending；下轮自愈重投 delivered（目标端 dedupe 兑底）
 *   M10 pending TTL（必修 2）：超龄 pending → expired + journal message.expired；幂等重扫零副作用
 *   M11 跨进程（必修 1）：子进程 crash 遗留 claim → 主进程 stale 接管；两子进程并发 stale
 *      接管竞速 → unlink 门控 CAS 恰一个 claimed(tookOver)
 *
 * 运行：npm run test:message-outbox
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

// 隔离（env 先于 import，同既有 runtime 测试纪律）
process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "msg-outbox-env-"));
process.env.PI_SESSIONS_DIR = mkdtempSync(join(tmpdir(), "msg-outbox-sessions-"));
const ROOT = process.env.PI_RUNTIME_DIR!;
const SESSIONS = process.env.PI_SESSIONS_DIR!;

import { newEventEnvelope } from "./runtime/envelope.ts";
import { masterAddress, piSessionAddress } from "./runtime/address.ts";
import { listRuntimeEnvelopes } from "./runtime/journal.ts";
import {
	listOutboxItems,
	markOutboxItem,
	newOutboxItem,
	outboxDir,
	readOutboxItem,
	writeOutboxItem,
	outboxItemId,
} from "./runtime/message-outbox.ts";
import {
	buildOutboxInjectBody,
	consumeOutboxOnce,
	registerOutboxBridge,
} from "./outbox-bridge.ts";
import { executeCommand } from "./runtime/command-executor.ts";
import { newCommandFrame } from "./runtime/protocol.ts";
import { claimInjection, confirmInjection } from "./runtime/receipts.ts";
import { defaultRuntimeDir } from "./runtime/journal.ts";
import { createRuntimeHostServer, type RuntimeHostHandle } from "./runtime-host/server.ts";
import { attachMaster } from "./runtime/registry.ts";

const STATE = join(ROOT, "state");
const JOURNAL = join(ROOT, "events.jsonl");
const DIRS = [ROOT, SESSIONS];

function mkSessionFile(sessionId: string): string {
	const file = join(SESSIONS, `2026-09-22T12-00-00-000Z_${sessionId}.jsonl`);
	writeFileSync(
		file,
		`${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-09-22T12:00:00.000Z", cwd: "C:\\ws-ob" })}\n`,
		"utf8",
	);
	return file;
}

function smFrame(commandKey: string, sessionId: string, text: string) {
	return newCommandFrame({
		type: "session.message",
		to: piSessionAddress(sessionId),
		issuedBy: "agent://runtime-host",
		commandKey,
		issuedAt: new Date().toISOString(),
		payload: { text },
	});
}

function exec(f: Parameters<typeof executeCommand>[0]): ReturnType<typeof executeCommand> {
	return executeCommand(f, { stateDir: STATE, journalPath: JOURNAL, sessionsDir: SESSIONS });
}

function journalEvents(type: string): Array<{ dedupeKey?: string; payload?: any }> {
	return listRuntimeEnvelopes({ path: JOURNAL }).envelopes.filter((e) => e.type === type) as Array<{ dedupeKey?: string; payload?: any }>;
}

let nowTick = 0;
function obNow(): Date {
	return new Date(Date.parse("2026-09-22T12:00:00Z") + (nowTick += 1000));
}

/** claiming 文件路径（receipts.ts claimingPath 同构；测试直操作盘面用）。 */
function claimPathFor(outboxId: string): string {
	return join(defaultRuntimeDir(), "receipts", `outbox_${outboxId}.claiming.json`);
}

/** 把 claiming 文件 backdate 成 stale（保持原 by）。 */
function backdateClaim(outboxId: string, minutesAgo = 11): void {
	const p = claimPathFor(outboxId);
	const raw = JSON.parse(readFileSync(p, "utf8")) as { key: string; by: string };
	writeFileSync(p, JSON.stringify({ ...raw, claimedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString() }), "utf8");
}

// L3：注入 send + receipt（markOutboxItem/confirm/journal）走 .then 微任务 → 断言前先 flush 微任务队列。
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

try {
	// ── M1 outbox 纯库 ───────────────────────────────────────────────
	{
		const dir = outboxDir(STATE);
		mkdirSync(dir, { recursive: true });
		const item = newOutboxItem({
			dedupeKey: "session.message:k1",
			commandKey: "k1",
			to: piSessionAddress("sid-A"),
			sessionId: "sid-A",
			text: "hello",
			now: obNow(),
		});
		assert.equal(item.id, outboxItemId("session.message:k1"));
		assert.equal(item.status, "pending");
		writeOutboxItem(dir, item);
		assert.deepEqual(readOutboxItem(dir, item.id), item, "round-trip");

		// 终态机：pending → delivered；再迁移拒绝
		const d = markOutboxItem(dir, item.id, { status: "delivered", at: obNow().toISOString(), by: "outbox-bridge:sid-A" });
		assert.ok(d?.status === "delivered" && typeof d.deliveredAt === "string");
		assert.equal(markOutboxItem(dir, item.id, { status: "failed", at: obNow().toISOString() }), null, "终态不可再迁移");
		assert.equal(markOutboxItem(dir, "f".repeat(64), { status: "delivered", at: obNow().toISOString() }), null, "缺失项 → null");

		// expired 终态（必修 2）：pending → expired；终态不可再迁移
		const ex = newOutboxItem({ dedupeKey: "session.message:k-ex", commandKey: "k-ex", to: piSessionAddress("sid-A"), sessionId: "sid-A", text: "ttl", now: obNow() });
		writeOutboxItem(dir, ex);
		const exMarked = markOutboxItem(dir, ex.id, { status: "expired", at: obNow().toISOString(), by: "runtime-host" });
		assert.ok(exMarked?.status === "expired" && typeof exMarked.expiredAt === "string");
		assert.equal(markOutboxItem(dir, ex.id, { status: "delivered", at: obNow().toISOString() }), null, "expired 终态不可再迁移");

		// 坏文件跳过 + id/文件名不符拒认
		writeFileSync(join(dir, "garbage.json"), "{not json", "utf8");
		const bad = newOutboxItem({ dedupeKey: "session.message:k2", commandKey: "k2", to: piSessionAddress("sid-A"), sessionId: "sid-A", text: "x", now: obNow() });
		writeOutboxItem(dir, bad);
		rmSync(join(dir, `${bad.id}.json`));
		writeOutboxItem(dir, bad);
		assert.equal(readOutboxItem(dir, "a".repeat(64)), null, "缺文件 → null");
		assert.ok(listOutboxItems(dir).every((it) => it.commandKey !== "k2" || it.id === bad.id), "枚举一致性");
		assert.ok(markOutboxItem(dir, bad.id, { status: "failed", at: obNow().toISOString(), error: "cleanup" }), "M1 收尾：k2 置终态（不干扰 M2 消费集）");
		assert.equal(listOutboxItems(dir).some((it) => it.id === "garbage".padEnd(64, "0")), false, "坏文件不进枚举");
	}

	// ── M2/M3/M4 桥三路径 ────────────────────────────────────────────
	{
		const dir = outboxDir(STATE);
		// 两项 pending：sid-A（本会话）+ sid-B（别会话）+ 一条已 delivered（终态跳过）
		const a = newOutboxItem({ dedupeKey: "session.message:ka", commandKey: "ka", to: piSessionAddress("sid-A"), sessionId: "sid-A", text: "for A", now: obNow() });
		const b = newOutboxItem({ dedupeKey: "session.message:kb", commandKey: "kb", to: piSessionAddress("sid-B"), sessionId: "sid-B", text: "for B", now: obNow() });
		const done = newOutboxItem({ dedupeKey: "session.message:kd", commandKey: "kd", to: piSessionAddress("sid-A"), sessionId: "sid-A", text: "already", now: obNow() });
		writeOutboxItem(dir, a);
		writeOutboxItem(dir, b);
		writeOutboxItem(dir, done);
		assert.ok(markOutboxItem(dir, done.id, { status: "delivered", at: obNow().toISOString() }));

		const injected: Array<{ body: string; deliverAs?: string }> = [];
		const report = consumeOutboxOnce({
			sessionId: "sid-A",
			stateDir: STATE,
			journalPath: JOURNAL,
			sendUserMessage: (body, opts) => {
				injected.push({ body, deliverAs: opts?.deliverAs });
			},
			now: obNow(),
		});
		await flush(); // L3：注入 send + receipt 在 .then 微任务
		assert.deepEqual(
			report.consumed.map((c) => c.action),
			["delivered"],
			"只消费本会话 pending 项（sid-B/终态零接触）",
		);
		assert.equal(injected.length, 1, "恰一次注入");
		assert.equal(injected[0]!.deliverAs, "followUp", "deliverAs followUp（mailbox-consumer 同款用户消息路径）");
		assert.ok(injected[0]!.body.includes("Web Console 远程输入") && injected[0]!.body.includes("for A"), "正文 = 来源标注 + 原文");
		assert.ok(injected[0]!.body.includes(`dedupe:outbox:${a.id}`), "正文含稳定 dedupe 标记（at-least-once 目标端去重身份）");
		assert.equal(readOutboxItem(dir, a.id)!.status, "delivered", "回写 delivered");
		assert.equal(readOutboxItem(dir, a.id)!.deliveredBy, "outbox-bridge:sid-A");
		assert.equal(readOutboxItem(dir, b.id)!.status, "pending", "非本会话项不被回写");
		const delEvents = journalEvents("message.delivered").filter((e) => e.payload?.commandKey === "ka");
		assert.equal(delEvents.length, 1, "journal message.delivered 一条");
		assert.equal(delEvents[0]!.dedupeKey, `message.delivered:${a.id}`, "dedupeKey = outboxId");

		// M4 confirm 后重跑：无 pending → 零注入零事件
		const r2 = consumeOutboxOnce({ sessionId: "sid-A", stateDir: STATE, journalPath: JOURNAL, sendUserMessage: () => { throw new Error("must not be called"); }, now: obNow() });
		assert.equal(r2.consumed.length, 0, "无 pending → 零动作");

		// M3 failed：注入抛异常 → failed 回写 + journal（error 摘要）
		const c = newOutboxItem({ dedupeKey: "session.message:kc", commandKey: "kc", to: piSessionAddress("sid-A"), sessionId: "sid-A", text: "boom", now: obNow() });
		writeOutboxItem(dir, c);
		const r3 = consumeOutboxOnce({ sessionId: "sid-A", stateDir: STATE, journalPath: JOURNAL, sendUserMessage: () => { throw new Error("send failed: tui closed"); }, now: obNow() });
		await flush(); // L3：注入 send + failed 回写 在 .then 微任务
		assert.deepEqual(r3.consumed.map((x) => x.action), ["failed"]);
		const failed = readOutboxItem(dir, c.id)!;
		assert.equal(failed.status, "failed", "回写 failed");
		// L3：真实失败走原失败路径，error 用统一摘要 "inject-failed"（原 fallback 值；具体异常已被
		// injectFollowUpQuietly 分类吞掉，不再逃逸到 bindCore 报成 Extension "<runtime>" error）。
		assert.equal(failed.error, "inject-failed");
		const failEvents = journalEvents("message.failed").filter((e) => e.payload?.commandKey === "kc");
		assert.equal(failEvents.length, 1, "journal message.failed 一条");

		// M4a 预置 injected 收据（注入后崩溃窗口）：receipt-replayed → delivered 补写、零注入
		const e = newOutboxItem({ dedupeKey: "session.message:ke", commandKey: "ke", to: piSessionAddress("sid-A"), sessionId: "sid-A", text: "crash-replay", now: obNow() });
		writeOutboxItem(dir, e);
		assert.equal(claimInjection(`outbox:${e.id}`, "outbox-bridge:sid-A:prev").status, "claimed", "预置 claim（模拟上轮桥）");
		assert.equal(confirmInjection(`outbox:${e.id}`, "outbox-bridge:sid-A:prev"), true, "预置 confirm（=已注入，收据落地）");
		let injected2 = 0;
		const r4 = consumeOutboxOnce({ sessionId: "sid-A", stateDir: STATE, journalPath: JOURNAL, sendUserMessage: () => { injected2 += 1; }, now: obNow() });
		assert.deepEqual(r4.consumed, [{ outboxId: e.id, action: "delivered", reason: "receipt-replayed" }], "收据回放 → delivered");
		assert.equal(injected2, 0, "不二次注入");
		assert.equal(readOutboxItem(dir, e.id)!.status, "delivered");

		// M4b claimed-by-other → skip（别的 holder 正在注入）
		const f = newOutboxItem({ dedupeKey: "session.message:kf", commandKey: "kf", to: piSessionAddress("sid-A"), sessionId: "sid-A", text: "racing", now: obNow() });
		writeOutboxItem(dir, f);
		claimInjection(`outbox:${f.id}`, "outbox-bridge:other-session");
		let injected3 = 0;
		const r5 = consumeOutboxOnce({ sessionId: "sid-A", stateDir: STATE, journalPath: JOURNAL, sendUserMessage: () => { injected3 += 1; }, now: obNow() });
		assert.deepEqual(r5.consumed.map((x) => ({ a: x.action, r: x.reason })), [{ a: "skipped", r: "claimed-by-other" }]);
		assert.equal(injected3, 0, "被他者 claim → 不注入");
		assert.equal(readOutboxItem(dir, f.id)!.status, "pending", "保持 pending（stale 接管后可重试）");

		// M1 补：正文/错误不进 journal（journal 只有关联字段）
		assert.equal(JSON.stringify(readFileSync(JOURNAL, "utf8")).includes("for A"), false, "正文绝不进 journal");
	}

	// ── M7 crash-window（必修 1）：注入后回写前崩溃 → 重启 reclaim 重投（at-least-once）──
	{
		const dir = outboxDir(STATE);
		const g = newOutboxItem({ dedupeKey: "session.message:kg", commandKey: "kg", to: piSessionAddress("sid-A"), sessionId: "sid-A", text: "crash-inject", now: obNow() });
		writeOutboxItem(dir, g);
		// 崩溃窗口模拟：桥已注入（外部副作用已发生）但 receipt/outbox 回写前进程死亡
		assert.equal(claimInjection(`outbox:${g.id}`, "outbox-bridge:sid-A").status, "claimed", "崩溃前已 claim");
		const firstBody = buildOutboxInjectBody(g); // 崩溃前那轮的注入正文（外部副作用）
		// 重启：claim→confirm 全程互斥，同 holder 新鲜 claim 不自取回（同 key 双链互斥契约）→ 让位；
		// backdate 后 stale 接管 → 重投
		const injected7: string[] = [];
		const repWait = consumeOutboxOnce({ sessionId: "sid-A", stateDir: STATE, journalPath: JOURNAL, sendUserMessage: () => undefined, now: obNow() });
		assert.deepEqual(repWait.consumed.filter((c) => c.outboxId === g.id).map((c) => ({ a: c.action, r: c.reason })), [{ a: "skipped", r: "claimed-by-other" }], "残留新鲜 claim（含同 holder）→ 让位");
		backdateClaim(g.id);
		const rep = consumeOutboxOnce({ sessionId: "sid-A", stateDir: STATE, journalPath: JOURNAL, sendUserMessage: (b) => injected7.push(b), now: obNow() });
		await flush(); // L3：stale 接管重投 在 .then 微任务
		assert.deepEqual(rep.consumed.filter((c) => c.outboxId === g.id).map((c) => c.action), ["delivered"], "stale 接管 → delivered");
		assert.equal(injected7.length, 1, "崩溃窗口后重投（at-least-once：重注入，非 exactly-once）");
		assert.equal(injected7[0], firstBody, "重投正文逐字相同（dedupe 标记稳定，可目标端去重）");
		// 目标端按 dedupe 标记幂等去重：两轮外部副作用 → 有效消息恰 1
		const marker = (b: string): string => /dedupe:outbox:([0-9a-f]{64})/.exec(b)![1]!;
		assert.equal(new Set([marker(firstBody), marker(injected7[0]!)]).size, 1, "目标端 dedupe 幂等：重投不重复生效");
		assert.equal(readOutboxItem(dir, g.id)!.status, "delivered");

		// 异 holder 崩溃遗留：fresh claim → claimed-by-other；stale 后接管重投收敛 delivered
		const h = newOutboxItem({ dedupeKey: "session.message:kh", commandKey: "kh", to: piSessionAddress("sid-A"), sessionId: "sid-A", text: "other-pod-crash", now: obNow() });
		writeOutboxItem(dir, h);
		assert.equal(claimInjection(`outbox:${h.id}`, "outbox-bridge:other-pod").status, "claimed");
		const rSkip = consumeOutboxOnce({ sessionId: "sid-A", stateDir: STATE, journalPath: JOURNAL, sendUserMessage: () => undefined, now: obNow() });
		assert.deepEqual(rSkip.consumed.filter((c) => c.outboxId === h.id).map((c) => ({ a: c.action, r: c.reason })), [{ a: "skipped", r: "claimed-by-other" }], "他 pod 新鲜 claim → 让位");
		backdateClaim(h.id);
		const injected7b: string[] = [];
		const rep2 = consumeOutboxOnce({ sessionId: "sid-A", stateDir: STATE, journalPath: JOURNAL, sendUserMessage: (b) => injected7b.push(b), now: obNow() });
		await flush(); // L3：stale 接管重投 在 .then 微任务
		assert.deepEqual(rep2.consumed.filter((c) => c.outboxId === h.id).map((c) => c.action), ["delivered"], "stale 接管 → 重投 delivered");
		assert.equal(injected7b.length, 1);
		assert.equal(readOutboxItem(dir, h.id)!.status, "delivered");
	}

	// ── M8 缺失 sender（必修 1）：无注入通道 → 诚实 skipped，绝不伪造 delivered ──
	{
		const dir = outboxDir(STATE);
		const i = newOutboxItem({ dedupeKey: "session.message:ki", commandKey: "ki", to: piSessionAddress("sid-A"), sessionId: "sid-A", text: "no-channel", now: obNow() });
		writeOutboxItem(dir, i);
		const rep = consumeOutboxOnce({ sessionId: "sid-A", stateDir: STATE, journalPath: JOURNAL, now: obNow() });
		assert.deepEqual(rep.consumed.filter((c) => c.outboxId === i.id), [{ outboxId: i.id, action: "skipped", reason: "no-injector" }]);
		assert.equal(readOutboxItem(dir, i.id)!.status, "pending", "无注入通道 → 保持 pending（不伪造终态）");
		assert.equal(existsSync(claimPathFor(i.id)), false, "未走到 claim（先于互斥短路）");
		assert.equal(journalEvents("message.delivered").filter((e) => (e.payload as any)?.commandKey === "ki").length, 0, "零 journal 伪造");
		// 收尾：置终态不干扰后续块
		assert.ok(markOutboxItem(dir, i.id, { status: "failed", at: obNow().toISOString(), error: "cleanup" }));
	}

	// ── M9 confirm 核实（必修 1）：confirmInjection 失败 → 不回写 delivered，下轮自愈 ──
	{
		const dir = outboxDir(STATE);
		const j = newOutboxItem({ dedupeKey: "session.message:kj", commandKey: "kj", to: piSessionAddress("sid-A"), sessionId: "sid-A", text: "confirm-lost", now: obNow() });
		writeOutboxItem(dir, j);
		// 注入成功后、confirm 前收据/claim 丢失（IO 故障形状）：sendUserMessage 回调内删 claim
		const rep = consumeOutboxOnce({
			sessionId: "sid-A", stateDir: STATE, journalPath: JOURNAL, now: obNow(),
			sendUserMessage: () => {
				rmSync(claimPathFor(j.id), { force: true });
			},
		});
		await flush(); // L3：confirm 核实 在 .then 微任务
		assert.deepEqual(rep.consumed.filter((c) => c.outboxId === j.id).map((c) => ({ a: c.action, r: c.reason })), [{ a: "skipped", r: "confirm-failed" }], "confirm 失败 → 不回写 delivered");
		assert.equal(readOutboxItem(dir, j.id)!.status, "pending", "防伪造终态：留 pending");
		assert.equal(journalEvents("message.delivered").filter((e) => (e.payload as any)?.commandKey === "kj").length, 0, "零 delivered journal");
		// 下轮自愈：fresh claim → 重投（at-least-once，目标端 dedupe 兑底）→ confirm 成功 → delivered
		const injected9: string[] = [];
		const rep2 = consumeOutboxOnce({ sessionId: "sid-A", stateDir: STATE, journalPath: JOURNAL, sendUserMessage: (b) => injected9.push(b), now: obNow() });
		await flush(); // L3：下轮自愈重投 在 .then 微任务
		assert.deepEqual(rep2.consumed.filter((c) => c.outboxId === j.id).map((c) => c.action), ["delivered"]);
		assert.equal(injected9.length, 1, "重投恰一次");
		assert.equal(readOutboxItem(dir, j.id)!.status, "delivered");
	}

	// ── M10 pending TTL（必修 2）：桥 tick 扫描 → expired + journal 回执，幂等重扫零副作用 ──
	{
		const dir = outboxDir(STATE);
		const old = newOutboxItem({ dedupeKey: "session.message:kk", commandKey: "kk", to: piSessionAddress("sid-A"), sessionId: "sid-A", text: "orphan-old", now: new Date(Date.parse("2026-09-22T12:00:00Z") - 25 * 3600_000) });
		const fresh = newOutboxItem({ dedupeKey: "session.message:kl", commandKey: "kl", to: piSessionAddress("sid-A"), sessionId: "sid-A", text: "still-fresh", now: obNow() });
		writeOutboxItem(dir, old);
		writeOutboxItem(dir, fresh);
		const injected10: string[] = [];
		const rep = consumeOutboxOnce({ sessionId: "sid-A", stateDir: STATE, journalPath: JOURNAL, sendUserMessage: (b) => injected10.push(b), now: obNow() });
		await flush(); // L3：新鲜项注入 + 回写 在 .then 微任务（expired 为同步 sweep）
		assert.deepEqual(rep.consumed.filter((c) => c.outboxId === old.id).map((c) => c.action), ["expired"], "超龄 pending → expired");
		assert.deepEqual(rep.consumed.filter((c) => c.outboxId === fresh.id).map((c) => c.action), ["delivered"], "新鲜项照常投递");
		const oldItem = readOutboxItem(dir, old.id)!;
		assert.equal(oldItem.status, "expired");
		assert.equal(oldItem.expiredBy, "outbox-bridge:sid-A");
		const expEvents = journalEvents("message.expired").filter((e) => (e.payload as any)?.commandKey === "kk");
		assert.equal(expEvents.length, 1, "journal message.expired 回执一条");
		assert.equal(JSON.stringify(expEvents[0]).includes("orphan-old"), false, "正文不进 journal");
		// 幂等重扫：已终态项零副作用
		const rep2 = consumeOutboxOnce({ sessionId: "sid-A", stateDir: STATE, journalPath: JOURNAL, sendUserMessage: () => undefined, now: obNow() });
		assert.equal(rep2.consumed.filter((c) => c.action === "expired").length, 0, "重扫零重复 expired");
		assert.equal(journalEvents("message.expired").filter((e) => (e.payload as any)?.commandKey === "kk").length, 1);
	}

	// ── M11 跨进程（必修 1）：子进程 crash 遗留 claim + 两子进程 stale 接管 CAS 竞速 ──
	{
		const dir = outboxDir(STATE);
		const receiptsUrl = new URL("./runtime/receipts.ts", import.meta.url).href;
		const workerTs = join(STATE, "receipt-race-worker.ts");
		writeFileSync(workerTs, [
			`const { claimInjection } = await import(${JSON.stringify(receiptsUrl)});`,
			`const [key, holder] = process.argv.slice(2);`,
			`process.stdout.write(JSON.stringify(claimInjection(key, holder)));`,
		].join("\n"));
		const runChild = (key: string, holder: string): Promise<{ status: string; tookOver?: boolean }> =>
			new Promise((resolve, rj) => {
				const child = spawn(process.execPath, ["--experimental-strip-types", workerTs, key, holder], { stdio: ["ignore", "pipe", "pipe"] });
				let out = "";
				let err = "";
				child.stdout.on("data", (c: Buffer) => { out += c; });
				child.stderr.on("data", (c: Buffer) => { err += c; });
				child.on("error", rj);
				child.on("close", (code) => {
					if (code !== 0) { rj(new Error(`receipt race worker exit ${code}: ${err.slice(0, 300)}`)); return; }
					resolve(JSON.parse(out));
				});
			});

		// (a) 子进程 crash：claim 后退出不 confirm（收据缺失）→ 主进程视角 claimed-by-other；
		//     backdate 后 stale 接管成功（跨进程接管路径）
		const m = newOutboxItem({ dedupeKey: "session.message:km", commandKey: "km", to: piSessionAddress("sid-A"), sessionId: "sid-A", text: "xproc-crash", now: obNow() });
		writeOutboxItem(dir, m);
		const crashed = await runChild(`outbox:${m.id}`, "proc:child-A");
		assert.equal(crashed.status, "claimed", "子进程 claim 成功后即退出（crash 形状）");
		assert.equal(existsSync(claimPathFor(m.id)), true, "claim 残留（无 confirm）");
		const repM = consumeOutboxOnce({ sessionId: "sid-A", stateDir: STATE, journalPath: JOURNAL, sendUserMessage: () => undefined, now: obNow() });
		assert.ok(repM.consumed.find((c) => c.outboxId === m.id && c.action === "skipped" && c.reason === "claimed-by-other"), "跨进程残留 claim → 让位");
		backdateClaim(m.id);
		const repM2 = consumeOutboxOnce({ sessionId: "sid-A", stateDir: STATE, journalPath: JOURNAL, sendUserMessage: () => undefined, now: obNow() });
		await flush(); // L3：跨进程 stale 接管重投 在 .then 微任务
		assert.ok(repM2.consumed.find((c) => c.outboxId === m.id && c.action === "delivered"), "跨进程 stale 接管 → 收敛 delivered");

		// (b) CAS 竞速：预置 stale claim → 两子进程同时接管 → unlink 门控 CAS 恰一个赢家
		for (const round of [1, 2, 3]) {
			const raceId = `b${round}`.padEnd(64, "0");
			const raceKey = `outbox:${raceId}`;
			writeFileSync(
				claimPathFor(raceId),
				JSON.stringify({ key: raceKey, by: "proc:stale-origin", claimedAt: new Date(Date.now() - 11 * 60_000).toISOString() }),
				"utf8",
			);
			const results = await Promise.all([runChild(raceKey, "proc:race-A"), runChild(raceKey, "proc:race-B")]);
			const winners = results.filter((r) => r.status === "claimed");
			assert.equal(winners.length, 1, `round${round}：恰一个 CAS 赢家（${JSON.stringify(results)}）`);
			assert.equal(winners[0]!.tookOver, true, "赢家经 stale 接管（tookOver）");
			assert.equal(results.filter((r) => r.status === "claimed-by-other").length, 1, "输家让位（旧实现双 claimed 双注入）");
		}
	}

	// ── M5 注册形态 ──────────────────────────────────────────────────
	{
		let registered = 0;
		const handlers = new Map<string, (event: unknown, ctx?: { sessionManager?: { sessionId?: string } }) => void>();
		const unbind = registerOutboxBridge(
			{
				on: (event, cb) => {
					handlers.set(event, cb as never);
					registered += 1;
				},
				sendUserMessage: () => undefined,
			},
			{ intervalMs: 50 },
		);
		assert.equal(registered, 1, "session_start 已注册");
		assert.ok(handlers.has("session_start"));
		unbind();
		// 解绑后再触发 session_start 不产生 interval（内部 sessionGen 失配）——只验证不抛
		handlers.get("session_start")!({}, { sessionManager: { sessionId: "sid-A" } });
		// 上面这次 session_start 会（按设计）重新拉起 interval——立即二次解绑清掉它。
		// 否则泄漏一个 50ms 循环持续消费共享 STATE 目录（真实时钟），与后续用例（M12 busy 重试）
		// 竞争同一批 pending 项 → M12 假红（时序相关 flaky）。
		unbind();
		// 无 sessionId / unknown → 静默不注册
		registered = 0;
		const unbind2 = registerOutboxBridge(
			{ on: (_e, _cb) => { registered += 1; } },
			{},
		);
		assert.equal(registered, 1);
		unbind2();
	}

	// ── M6 端到端：HTTP POST（token 认证）→ outbox pending → 桥消费 → delivered + WS 投影源 ──
	{
		attachMaster({ sessionId: "obs-master-session", generation: 1 });
		const targetSid = "obs-1111-2222-3333-444444444444";
		mkSessionFile(targetSid);
		mkSessionFile("obs-master-session");
		const D = mkdtempSync(join(tmpdir(), "msg-outbox-http-"));
		const h: RuntimeHostHandle = await createRuntimeHostServer({
			hostPath: join(D, "host.json"),
			timersDir: join(D, "timers"),
			stateDir: STATE,
			mailboxDir: join(D, "mailbox"),
			journalPath: JOURNAL,
			sessionsDir: SESSIONS,
		});
		try {
			const base = `http://127.0.0.1:${h.info.port}`;
			const token = h.info.token;
			// 未授权 → 401（fail-closed）
			const unauth = await fetch(`${base}/v1/commands`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ frame: "command", type: "session.message", to: piSessionAddress(targetSid), commandKey: "e2e-noauth", issuedAt: new Date().toISOString(), payload: { text: "hi" } }),
			});
			assert.equal(unauth.status, 401, "无凭据 POST → 401");
			// authorized：X-Command-Token 等价通道
			const post = await fetch(`${base}/v1/commands`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-command-token": token },
				body: JSON.stringify({ frame: "command", type: "session.message", to: piSessionAddress(targetSid), commandKey: "e2e-1", issuedAt: new Date().toISOString(), payload: { text: "端到端消息" } }),
			});
			assert.equal(post.status, 200);
			const body = (await post.json()) as { status: string; summary: string };
			assert.equal(body.status, "accepted");
			// executor → outbox pending（第一段完成）
			const dir = outboxDir(STATE);
			const item = listOutboxItems(dir).find((it) => it.commandKey === "e2e-1")!;
			assert.ok(item && item.status === "pending");
			// 桥（目标会话侧）消费 → delivered（第二段完成）
			const injected: string[] = [];
			const rep = consumeOutboxOnce({ sessionId: targetSid, stateDir: STATE, journalPath: JOURNAL, sendUserMessage: (b) => injected.push(b) });
			await flush(); // L3：桥消费注入 + delivered 回写 在 .then 微任务
			assert.deepEqual(rep.consumed.map((c) => c.action), ["delivered"]);
			assert.equal(readOutboxItem(dir, item.id)!.status, "delivered");
			assert.equal(injected.length, 1, "恰一次注入");
				assert.ok(injected[0]!.includes("端到端消息"), "正文注入");
			// WS 投影源：journal 里 queued + delivered 都可查（outbox 主题的过滤对象）
			const queued = journalEvents("message.queued").filter((e) => e.payload?.commandKey === "e2e-1");
			const delivered = journalEvents("message.delivered").filter((e) => e.payload?.commandKey === "e2e-1");
			assert.equal(queued.length, 1, "message.queued 一条");
			assert.equal(delivered.length, 1, "message.delivered 一条");
			// master 护栏（端到端）：agent://master_default → 403；master attachment 会话 → 403
			const m403 = await fetch(`${base}/v1/commands`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-command-token": token },
				body: JSON.stringify({ frame: "command", type: "session.message", to: masterAddress(), commandKey: "e2e-m403", issuedAt: new Date().toISOString(), payload: { text: "hi" } }),
			});
			assert.equal(m403.status, 403, "master_default → HTTP 403");
			assert.equal(((await m403.json()) as { reason: string }).reason, "master-session-protected");
			const m403b = await fetch(`${base}/v1/commands`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-command-token": token },
				body: JSON.stringify({ frame: "command", type: "session.message", to: piSessionAddress("obs-master-session"), commandKey: "e2e-m403b", issuedAt: new Date().toISOString(), payload: { text: "hi" } }),
			});
			assert.equal(m403b.status, 403, "master attachment 会话（换皮地址）→ HTTP 403");
		} finally {
			await h.close().catch(() => undefined);
			rmSync(D, { recursive: true, force: true });
		}
	}
	// ── M12 L3 busy（忙时冲突静默重试）：send 被 busy 拒绝 → 不标记 delivered、不 disable、
	//     释放 claim 供下 tick 重试；空闲后重投 delivered（at-least-once，目标端 dedupe 兑底）──
	{
		const dir = outboxDir(STATE);
		const k = newOutboxItem({ dedupeKey: "session.message:kk-busy", commandKey: "kk-busy", to: piSessionAddress("sid-A"), sessionId: "sid-A", text: "busy-retry", now: obNow() });
		writeOutboxItem(dir, k);
		let busy = true;
		const injected12: string[] = [];
		const send = (b: string) => {
			if (busy) return Promise.reject(new Error("Agent is already processing a prompt."));
			injected12.push(b);
		};
		// 第一次：busy → 不标记 delivered、保持 pending、释放 claim（.claiming.json 删除）
		const rep12 = consumeOutboxOnce({ sessionId: "sid-A", stateDir: STATE, journalPath: JOURNAL, sendUserMessage: send, now: obNow() });
		await flush();
		assert.deepEqual(rep12.consumed.filter((c) => c.outboxId === k.id).map((c) => ({ a: c.action, r: c.reason })), [{ a: "skipped", r: "busy-retry" }], "busy → skipped(busy-retry)");
		assert.equal(injected12.length, 0, "busy 不注入");
		assert.equal(readOutboxItem(dir, k.id)!.status, "pending", "busy 保持 pending（不标记 delivered）");
		assert.equal(existsSync(claimPathFor(k.id)), false, "busy 释放 claim（.claiming.json 删除）");
		// 下 tick（仍 busy）→ 重试（仍不注入、仍释放）——验证「不 disable」：下一轮仍能领取
		const rep12b = consumeOutboxOnce({ sessionId: "sid-A", stateDir: STATE, journalPath: JOURNAL, sendUserMessage: send, now: obNow() });
		await flush();
		assert.equal(injected12.length, 0, "仍 busy 不注入");
		assert.equal(readOutboxItem(dir, k.id)!.status, "pending", "仍 busy 保持 pending");
		// 空闲 → 下 tick 重投 delivered
		busy = false;
		const rep12c = consumeOutboxOnce({ sessionId: "sid-A", stateDir: STATE, journalPath: JOURNAL, sendUserMessage: send, now: obNow() });
		await flush();
		assert.deepEqual(rep12c.consumed.filter((c) => c.outboxId === k.id).map((c) => c.action), ["delivered"], "空闲后重投 delivered");
		assert.equal(injected12.length, 1, "空闲后恰一次注入");
		assert.equal(readOutboxItem(dir, k.id)!.status, "delivered", "回写 delivered");
	}
} finally {
	for (const d of DIRS) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}
}

console.log("_test_message_outbox: all assertions passed");
