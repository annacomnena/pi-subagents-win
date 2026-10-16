/**
 * _test_delivery_crash_window.ts — R7「发送/确认崩溃窗」验收单测（唤醒必达 §8.3 R7）
 *
 * ## 覆盖什么
 * 在**隔离临时目录**（`PI_RUNTIME_DIR`，import 之前设置）里逐个复现投递链的崩溃点，
 * 每个窗都断言「重启后收敛」，并逐窗断言**原 run 终态逐字节不变**：
 *
 *   R7-a  event 已建、**未记 attempt** 即崩   → 重启 ensureEvent 幂等 + 对账补投一次
 *   R7-b  **租约已领**（attempt 带 leaseOwner/leaseUntil）后进程崩（**子进程 SIGKILL**）
 *                                            → 无永久 claimed；租约过期可被新 holder 接管；
 *                                              escalate 不停滞；不重建第二个 event
 *   R7-c  已发送（attempt 已记）但未 received → 重启 stage 仍 attempted（**不得** delivered）
 *                                            → 到 deliveryDeadline 判 fail_delivery + incident
 *   R7-d  received 后、consumed 前崩          → 重启不视为 consumed；期限到 → failed_delivery + incident
 *   R7-e  consumed 后、清理前崩               → 重启 consumed 胜出：不再投、不再 incident、判 none
 *
 * ## 权威性纪律（本文件刻意不做的「自证」）
 * 本文件的 deliver stub **不调用** `ackReceived`/`ackConsumed`（那正是被测语义）。因此：
 *   - `received` 窗用**接收端写入器** `writeAck(..., stage:"received")` 造盘上事实
 *     （等价 `delivery-ack.ts::ackReceived` 的落点，见该文件 :131），并额外用 `ackReceived()`
 *     写第二个事件、读回核对 stage，证明「ACK 就是这一步的事实来源」；
 *   - `consumed` 窗用 `ackConsumed()`（唯一的生产 consumed 写入器）。
 * 即：测试不替生产判定「已送达」，只把接收端回执摆到盘上，再让被测的纯判定函数看图。
 *
 * ## R7-d 的判定依据（为何不因「已 received」而放过）
 * §6.1 阶段机把 `consumed` 规定为**唯一**交付成功；§6.4/§6.2 规定「任一未 consumed 且过
 * deliveryDeadline ⇒ failed_delivery + incident」。`received` 表示「消息已持久落盘」，
 * 不等于「进入模型请求的有效 context」，因此期限到仍判 `fail_delivery`；`received` 回执
 * **保留不删**（append-only 事实），incident 与回执并存 = 如实记录，不静默擦除。
 *
 * ## 依据
 * plans/20261016_consult_scheduling_and_wake_reliability.md §8.3 R7、§6.1、§6.4。
 *
 * 运行：npm run test:delivery-crash-window
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 隔离在 import 之前（同 _test_message_outbox.ts:42 纪律）：模块级路径解析全部落到临时目录。
process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "delivery-crash-env-"));

import { ackConsumed, ackReceived } from "./delivery-ack.ts";
import {
	DELIVERY_DEADLINE_MS,
	LEASE_MS,
	defaultDeliveryDir,
	effectiveStage,
	ensureEvent,
	isDelivered,
	listAcks,
	listAttempts,
	listEvents,
	listOpenIncidents,
	loadEvent,
	reconcileDecision,
	terminalRevisionOf,
	writeAck,
	type DeliveryEvent,
} from "./delivery-ledger.ts";
import { reconcileOnce } from "./delivery-reconciler.ts";

let n = 0;
const ok = (name: string): void => { n += 1; console.log(`ok ${n} - ${name}`); };

const ROOT = process.env.PI_RUNTIME_DIR!;
const NOW = Date.parse("2026-10-16T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

/** 每组独立账本 + runs 目录（避免跨组计数互相污染）。 */
const groupDirs = (g: string): { d: string; rd: string } => {
	const d = join(ROOT, `delivery-${g}`);
	const rd = join(ROOT, `runs-${g}`);
	mkdirSync(rd, { recursive: true });
	return { d, rd };
};

/** 写一份权威终态 run JSON（幂等：重复调用字节一致）。 */
const writeRun = (rd: string, runId: string, at: number): Buffer => {
	const rec = {
		id: runId, agent: "general", task: "crash-window", status: "completed",
		startedAt: iso(at - 60_000), endedAt: iso(at), pid: 4242,
		result: { status: "completed", text: "ok", error: null },
	};
	const buf = Buffer.from(JSON.stringify(rec), "utf8");
	writeFileSync(join(rd, `${runId}.json`), buf);
	return buf;
};

const runBytes = (rd: string, runId: string): Buffer => readFileSync(join(rd, `${runId}.json`));

/** 模拟进程重启：丢弃一切内存视图，只从**盘上**重建（生产 B 通道的 `loadEvent`）。 */
const reload = (d: string, eventId: string): DeliveryEvent => {
	const e = loadEvent(d, eventId);
	assert.ok(e, `重启后必须能从盘上读回事件 ${eventId}`);
	return e!;
};

/** 盘上事件元数据文件（不含 attempt/ack/incident 附属文件）。 */
const eventFiles = (d: string): string[] =>
	existsSync(d)
		? readdirSync(d).filter((f) => f.endsWith(".json") && !f.includes(".attempt.") && !f.includes(".ack.") && !f.includes(".incident."))
		: [];

const stageOf = (ev: DeliveryEvent, d: string, now: number) =>
	effectiveStage(ev, listAttempts(d, ev.eventId), listAcks(d, ev.eventId), now);

const incidentFiles = (d: string): string[] =>
	existsSync(d) ? readdirSync(d).filter((f) => f.includes(".incident.") && f.endsWith(".json")) : [];

/**
 * 崩溃窗形状：子进程写 attempt（含租约）后进入常驻，**父进程 SIGKILL 之**。
 *
 * 为何用「父杀子」而不是 worker 自杀：本机实测（Node 22 / Windows）
 * `process.kill(process.pid,"SIGKILL")` 归为 exit code 1，`spawnSync().signal` 为 `null`；
 * 而**外部 SIGKILL** 的 `signal === "SIGKILL"` 可观测。父杀子同时更忠实于崩溃窗语义：
 * 受害者没有机会跑任何 exit 清理（租约不被释放、无 ack 写入）。
 * worker 在 `recordAttempt` **之后**向 stdout 打 `READY`，父进程据此在「租约已落盘」的瞬间下手。
 */
const spawnAndSigkill = (workerPath: string, args: string[]): Promise<{ signal: string | null; stderr: string }> =>
	new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--experimental-strip-types", workerPath, ...args], { stdio: ["ignore", "pipe", "pipe"] });
		let stderr = "";
		let stdout = "";
		let killed = false;
		child.stderr.on("data", (c: Buffer) => { stderr += c; });
		child.stdout.on("data", (c: Buffer) => {
			stdout += c;
			if (!killed && stdout.includes("READY")) { killed = true; child.kill("SIGKILL"); }
		});
		child.on("error", reject);
		child.on("exit", (_code, signal) => resolve({ signal, stderr }));
	});

try {
	assert.equal(defaultDeliveryDir(), join(ROOT, "delivery"), "PI_RUNTIME_DIR 隔离生效（默认账本目录在临时目录内）");

	// ══ R7-a：event 已建、未记 attempt 即崩 ═══════════════════════════════
	{
		const { d, rd } = groupDirs("a");
		const runId = "run_r7a";
		const bytesBefore = writeRun(rd, runId, NOW);
		const revision = terminalRevisionOf(JSON.parse(bytesBefore.toString("utf8")));

		// 进程 P1：ensureEvent 后立刻崩（无 attempt、无 ack）。
		const first = ensureEvent(d, {
			runId, terminalRevision: revision, terminalSnapshotPath: join(rd, `${runId}.json`),
			dispatcherSessionId: "sess_dispatch", observedAt: iso(NOW), terminalAt: iso(NOW),
		});
		assert.equal(first.created, true, "首次 ensureEvent 创建成功");
		const created = first.event;

		// ── 重启：ensureEvent 幂等（不重置 deadline / 不改派发者 / eventId 不变）──
		const again = ensureEvent(d, {
			runId, terminalRevision: revision, terminalSnapshotPath: join(rd, `${runId}.json`),
			dispatcherSessionId: "sess_DIFFERENT", observedAt: iso(NOW + 30_000), terminalAt: iso(NOW + 30_000),
			deliveryDeadlineMs: 999,
		});
		assert.equal(again.created, false, "已存在 ⇒ 不重复创建");
		assert.equal(again.event.eventId, created.eventId, "eventId 不变（重试不产新事件）");
		assert.equal(again.event.deliveryDeadline, created.deliveryDeadline, "deadline 未被重置（不隐式展期）");
		assert.equal(again.event.observedAt, created.observedAt, "observedAt 未被覆盖");
		assert.equal(again.event.dispatcherSessionId, "sess_dispatch", "原派发者未被改写");
		assert.equal(eventFiles(d).length, 1, "盘上只有 1 个事件（ensureEvent 幂等）");

		// ── 重启后对账能正常补投：过 20s 首投阈值 ⇒ retry once ──
		const ev = reload(d, created.eventId);
		assert.equal(stageOf(ev, d, NOW + 1_000).stage, "pending", "无 attempt ⇒ pending（占位不是证据）");
		assert.equal(reconcileDecision(ev, stageOf(ev, d, NOW + 1_000), [], NOW + 25_000).action, "retry", "崩溃窗后必须能补投（no silent stuck）");

		let deliveries = 0;
		const r = await reconcileOnce({
			runsDir: rd, deliverDir: d, now: NOW + 25_000,
			resolveDispatcher: () => "sess_dispatch",
			deliver: () => { deliveries += 1; return "sent"; },
		});
		assert.equal(deliveries, 1, "对账补投命中本事件（恰好一次）");
		assert.equal(r.results.filter((x) => x.runId === runId && x.action === "retry").length, 1, "对账结果记 retry");
		assert.equal(listAttempts(d, ev.eventId).length, 1, "记 1 条 attempt");
		const after = stageOf(reload(d, ev.eventId), d, NOW + 26_000);
		assert.equal(after.stage, "attempted", "补投后 = attempted");
		assert.equal(isDelivered(after.stage), false, "attempted 不是 delivered（P3：sent 只是调过发送）");

		// ── 全窗共同断言 ──
		assert.ok(runBytes(rd, runId).equals(bytesBefore), "① 原 run 终态逐字节不变");
		assert.equal(listEvents(d).filter((e) => e.runId === runId).length, 1, "② 只有一个事件（无重复）");
		assert.equal(ensureEvent(d, {
			runId, terminalRevision: revision, terminalSnapshotPath: join(rd, `${runId}.json`),
			dispatcherSessionId: "sess_x", observedAt: iso(NOW + 40_000),
		}).created, false, "② 再 ensureEvent 仍不新增事件");
		assert.equal(listEvents(d).length, eventFiles(d).length, "② listEvents 计数 == 盘上事件文件数");
		assert.equal(incidentFiles(d).length, 0, "③ 未过期 ⇒ 无 incident");
		assert.equal(readdirSync(rd).filter((f) => f.endsWith(".json")).length, 1, "投递层未在 runs 目录造第二份终态");
		ok("R7-a build-event-then-crash（无 attempt）：幂等 + 补投 exactly once → attempted");
	}

	// ══ R7-b：租约已领后**子进程 SIGKILL** ═══════════════════════════════
	{
		const { d, rd } = groupDirs("b");
		const runId = "run_r7b";
		const bytesBefore = writeRun(rd, runId, NOW);
		const revision = terminalRevisionOf(JSON.parse(bytesBefore.toString("utf8")));

		// 子进程 worker：ensureEvent + recordAttempt(带租约) 后常驻；父进程见到 READY 立刻 SIGKILL。
		const ledgerUrl = new URL("./delivery-ledger.ts", import.meta.url).href;
		const worker = join(ROOT, "r7b-lease-worker.mjs");
		writeFileSync(worker, [
			`const { ensureEvent, recordAttempt } = await import(${JSON.stringify(ledgerUrl)});`,
			`const dir = process.argv[2];`,
			`const { event } = ensureEvent(dir, {`,
			`  runId: ${JSON.stringify(runId)}, terminalRevision: ${JSON.stringify(revision)},`,
			`  terminalSnapshotPath: ${JSON.stringify(join(rd, `${runId}.json`))}, dispatcherSessionId: "sess_dispatch",`,
			`  observedAt: ${JSON.stringify(iso(NOW))}, terminalAt: ${JSON.stringify(iso(NOW))},`,
			`});`,
			`recordAttempt(dir, event.eventId, {`,
			`  attemptId: event.eventId + "@A@crashed", channel: "A", at: ${JSON.stringify(iso(NOW + 1_000))},`,
			`  status: "sent", leaseOwner: "A:crashed-pid", leaseUntil: ${JSON.stringify(iso(NOW + 1_000 + LEASE_MS))},`,
			`});`,
			`process.stdout.write("READY");`,
			`setInterval(() => {}, 1_000); // 常驻，等父进程 SIGKILL（不跑任何 exit 清理）`,
		].join("\n"), "utf8");

		const killed = await spawnAndSigkill(worker, [d]);
		assert.equal(killed.signal, "SIGKILL", `worker 必须被 SIGKILL 终止（实得 signal=${String(killed.signal)}，stderr=${killed.stderr.slice(0, 400)}）`);

		// ── 重启视角：租约事实在盘上（leased attempt），事件只有一个 ──
		const evs = listEvents(d).filter((e) => e.runId === runId);
		assert.equal(evs.length, 1, "SIGKILL 后事件恰好 1 个（worker 建的），未被重启重建第二份");
		const ev = reload(d, evs[0].eventId);
		const attempts1 = listAttempts(d, ev.eventId);
		assert.equal(attempts1.length, 1, "盘上有 1 条租约 attempt（崩溃遗留 claim 形状）");
		assert.equal(attempts1[0].leaseOwner, "A:crashed-pid", "租约持有人是已死进程");
		assert.equal(attempts1[0].status, "sent", "崩溃前记的是 sent（= attempted，不是 delivered）");

		// 无永久 claimed：租约内不抢（防惊群）…
		const viewInLease = stageOf(ev, d, NOW + 2_000);
		assert.equal(viewInLease.stage, "attempted", "崩溃遗留 attempt ⇒ attempted（非卡死在 pending/claimed）");
		assert.equal(reconcileDecision(ev, viewInLease, attempts1, NOW + 2_000, { reconcileFirstRetryMs: 0 }).action, "none", "租约内不打扰（防 A/B 惊群）");
		// …租约过期后**可被新 holder 接管**（无永久 claimed）
		assert.equal(reconcileDecision(ev, viewInLease, attempts1, NOW + 1_000 + LEASE_MS + 1, { reconcileFirstRetryMs: 0 }).action, "retry", "租约过期 ⇒ 新 holder 可接管（无永久 claimed）");

		let deliveries = 0;
		await reconcileOnce({
			runsDir: rd, deliverDir: d, now: NOW + 1_000 + LEASE_MS + 1_000,
			resolveDispatcher: () => "sess_dispatch",
			deliver: () => { deliveries += 1; return "sent"; },
		});
		assert.equal(deliveries, 1, "新 holder（B 通道）接管并补投");
		const attempts2 = listAttempts(d, ev.eventId);
		assert.equal(attempts2.length, 2, "接管即追加第 2 条 attempt（append-only，不覆盖崩溃者的）");
		assert.notEqual(attempts2[1].leaseOwner, "A:crashed-pid", "新 holder 换了租约 owner");
		assert.equal(attempts2[0].leaseOwner, "A:crashed-pid", "崩溃者 attempt 原样保留（可审计）");

		// escalate 不停滞：到期限照样 failed_delivery + incident
		const r2 = await reconcileOnce({
			runsDir: rd, deliverDir: d, now: NOW + DELIVERY_DEADLINE_MS + 1_000,
			resolveDispatcher: () => "sess_dispatch", deliver: () => { throw new Error("不应重投（已过期）"); },
		});
		assert.equal(r2.results.filter((x) => x.action === "fail_delivery").length, 1, "崩溃窗不耽误 escalate（期限到 ⇒ fail_delivery）");
		assert.equal(incidentFiles(d).length, 1, "恰好 1 个 incident");

		// ── 全窗共同断言 ──
		assert.ok(runBytes(rd, runId).equals(bytesBefore), "① 原 run 终态逐字节不变（SIGKILL 后亦然）");
		assert.equal(listEvents(d).filter((e) => e.runId === runId).length, 1, "② 全程只有 1 个事件");
		// D-2（2026-10-16 裁定）：incident 已发布 ⇒ 阶段**恒**为 failed_delivery（不再被 attempt 掩盖）
		// ⇒ 过期后重判是 `none/already-failed-delivery`（比“再报一次 fail_delivery”更强的幂等）。
		const closed = reload(d, ev.eventId);
		assert.equal(closed.incidentId, listOpenIncidents(d)[0].incidentId, "incidentId 已持久在事件元数据（跨重启可见）");
		const closedView = stageOf(closed, d, NOW + DELIVERY_DEADLINE_MS + 2_000);
		assert.equal(closedView.stage, "failed_delivery", "**D-2 硬约束**：incident 开启 ⇒ 阶段 = failed_delivery（不得报 consumed/成功态）");
		const rejudge = reconcileDecision(closed, closedView, attempts2, NOW + DELIVERY_DEADLINE_MS + 2_000);
		assert.equal(rejudge.action, "none", "过期后重判 = none（终态失败不可反复发布）");
		await reconcileOnce({ runsDir: rd, deliverDir: d, now: NOW + DELIVERY_DEADLINE_MS + 6_000, resolveDispatcher: () => "sess_dispatch" });
		assert.equal(incidentFiles(d).length, 1, "③ 幂等重跑不产生第二个 incident");
		ok("R7-b 租约已领 + 子进程 SIGKILL：无永久 claimed、租约过期接管、单一 incident、run 不变");
	}

	// ══ R7-c：已发送（attempt 已记）但未 received ═════════════════════════
	{
		const { d, rd } = groupDirs("c");
		const runId = "run_r7c";
		const bytesBefore = writeRun(rd, runId, NOW);
		const revision = terminalRevisionOf(JSON.parse(bytesBefore.toString("utf8")));

		// P1：对账补投成功（attempt.status = "sent"），随后崩 —— received 回执尚不存在。
		await reconcileOnce({
			runsDir: rd, deliverDir: d, now: NOW + 25_000, resolveDispatcher: () => "sess_dispatch",
			deliver: () => "sent",
		});
		const ev = reload(d, listEvents(d).find((e) => e.runId === runId)!.eventId);
		assert.equal(listAcks(d, ev.eventId).length, 0, "崩溃点：确实没有 received/consumed 回执");

		// ── 重启：stage 仍 attempted，**不得** delivered/consumed ──
		const view = stageOf(ev, d, NOW + 30_000);
		assert.equal(view.stage, "attempted", "重启后仍是 attempted");
		assert.equal(isDelivered(view.stage), false, "**不得**当 delivered（sent ≠ 送达）");

		// ── 到 deliveryDeadline ⇒ fail_delivery + incident（不调用模型）──
		const past = NOW + DELIVERY_DEADLINE_MS + 1_000;
		const decision = reconcileDecision(ev, view, listAttempts(d, ev.eventId), past);
		assert.equal(decision.action, "fail_delivery", "期限到 ⇒ fail_delivery");
		assert.ok(String(decision.reason).includes("deadline-exceeded"), `原因写明期限（实得 ${String(decision.reason)}）`);

		let modelDeliveries = 0;
		let incidentExits = 0;
		const r = await reconcileOnce({
			runsDir: rd, deliverDir: d, now: past, resolveDispatcher: () => "sess_dispatch",
			deliver: () => { modelDeliveries += 1; return "sent"; },
			onIncident: () => { incidentExits += 1; },
		});
		assert.equal(r.results.filter((x) => x.action === "fail_delivery").length, 1, "对账判 fail_delivery");
		assert.equal(modelDeliveries, 0, "失败出口**不投递/不调用模型**（deliver 未被调）");
		assert.equal(incidentExits, 1, "incident 出口被调用一次（不调用模型的失败出口）");
		assert.equal(incidentFiles(d).length, 1, "incident 已落盘");
		// 跨重启可见性：**以事件元数据里持久化的 incidentId 为准**，不以 effectiveStage 的字面值为准。
		// 原因（如实记录，见 plans/20261016_r7_r8_impl.md「发现 1」）：`effectiveStage` 的阶段优先级
		// 是 consumed > received > attempt > incident，已有 attempt 时不会把 stage 报成 failed_delivery；
		// 但交付失败事实仍持久（incidentId + incident 文件 + reconcileDecision 判 fail_delivery）。
		const closed = reload(d, ev.eventId);
		assert.ok(closed.incidentId, "失败事实跨重启可见（事件元数据持久 incidentId）");
		assert.notEqual(stageOf(closed, d, past + 1_000).stage, "consumed", "交付失败不得被读成 consumed");
		assert.equal(listOpenIncidents(d).filter((i) => i.eventId === ev.eventId).length, 1, "未 ack 的 incident 恰好 1 条");

		// ── 全窗共同断言 ──
		assert.ok(runBytes(rd, runId).equals(bytesBefore), "① 原 run 终态逐字节不变（failed_delivery 不改 run）");
		assert.equal(listEvents(d).filter((e) => e.runId === runId).length, 1, "② 只有一个事件");
		await reconcileOnce({ runsDir: rd, deliverDir: d, now: past + 5_000, resolveDispatcher: () => "sess_dispatch" });
		await reconcileOnce({ runsDir: rd, deliverDir: d, now: past + 9_000, resolveDispatcher: () => "sess_dispatch" });
		assert.equal(incidentFiles(d).length, 1, "③ 幂等重跑不产生第二个 incident");
		ok("R7-c sent-but-not-received：attempted → 期限 fail_delivery + 1 incident（不调模型）");
	}

	// ══ R7-d：received 后、consumed 前崩 ══════════════════════════════════
	{
		const { d, rd } = groupDirs("d");
		const runId = "run_r7d";
		const bytesBefore = writeRun(rd, runId, NOW);
		const revision = terminalRevisionOf(JSON.parse(bytesBefore.toString("utf8")));

		// P1：attempt（sent）+ **接收端落盘回执**。用生产接收端路径写盘，随后崩。
		await reconcileOnce({
			runsDir: rd, deliverDir: d, now: NOW + 25_000, resolveDispatcher: () => "sess_dispatch",
			deliver: () => "sent",
		});
		const ev = reload(d, listEvents(d).find((e) => e.runId === runId)!.eventId);
		assert.equal(writeAck(d, {
			eventId: ev.eventId, stage: "received", attemptId: listAttempts(d, ev.eventId).at(-1)!.attemptId,
			recipientGeneration: 1, at: iso(NOW + 26_000), evidence: "persisted-user-entry",
		}), true, "接收端写 received 回执（= ackReceived 的落点）");
		assert.equal(listAcks(d, ev.eventId).filter((a) => a.stage === "received").length, 1, "received 回执在盘上");
		// 交叉核对：ackReceived()（生产包装器）写出的回执读回后 stage 一致（同一落点，命名不同）
		assert.equal(ackReceived(d, [ev.eventId], { at: NOW + 26_500 })[0].reason, "ack-exists", "ackReceived 与 writeAck 落到同一文件（幂等）");
		assert.equal(stageOf(reload(d, ev.eventId), d, NOW + 27_000).stage, "received", "回执可读回；stage=received");

		// ── 重启：received **不是** consumed，交付未成立 ──
		const post = reload(d, ev.eventId);
		const view = stageOf(post, d, NOW + 30_000);
		assert.equal(view.stage, "received", "重启后 = received（跨重启保留）");
		assert.equal(isDelivered(view.stage), false, "**received 不得当 delivered/consumed**");
		assert.equal(listAcks(d, ev.eventId).filter((a) => a.stage === "consumed").length, 0, "崩溃点确实没有 consumed");

		// ── 期限到 ⇒ failed_delivery + incident；received 回执**保留**（不静默擦除）──
		const past = NOW + DELIVERY_DEADLINE_MS + 1_000;
		const decision = reconcileDecision(post, view, listAttempts(d, ev.eventId), past);
		assert.equal(decision.action, "fail_delivery", "received 后期限到 ⇒ fail_delivery（依据 §6.1：只有 consumed 才算成功）");
		await reconcileOnce({ runsDir: rd, deliverDir: d, now: past, resolveDispatcher: () => "sess_dispatch" });
		assert.equal(incidentFiles(d).length, 1, "incident 已落盘（与 received 回执并存）");
		assert.equal(listAcks(d, ev.eventId).filter((a) => a.stage === "received").length, 1, "received 回执仍在（append-only，不被擦除）");
		const closed = reload(d, ev.eventId);
		assert.ok(closed.incidentId, "失败事实跨重启可见（事件元数据持久 incidentId）");
		// D-2：incident 已发布 ⇒ 阶段**恒**为 failed_delivery（不得再报 received/consumed）
		assert.equal(stageOf(closed, d, past + 1_000).stage, "failed_delivery", "**D-2 硬约束**：incident 开启 ⇒ failed_delivery（received 不再掩盖终态）");
		assert.equal(isDelivered(stageOf(closed, d, past + 1_000).stage), false, "received 永远不算 delivered");

		// ── 全窗共同断言 ──
		assert.ok(runBytes(rd, runId).equals(bytesBefore), "① 原 run 终态逐字节不变");
		assert.equal(listEvents(d).filter((e) => e.runId === runId).length, 1, "② 只有一个事件");
		await reconcileOnce({ runsDir: rd, deliverDir: d, now: past + 5_000, resolveDispatcher: () => "sess_dispatch" });
		assert.equal(incidentFiles(d).length, 1, "③ 幂等重跑不产生第二个 incident");
		ok("R7-d received-but-not-consumed 崩：received 保留但仍判 fail_delivery + 1 incident");
	}

	// ══ R7-e：consumed 后、清理前崩 ═══════════════════════════════════════
	{
		const { d, rd } = groupDirs("e");
		const runId = "run_r7e";
		const bytesBefore = writeRun(rd, runId, NOW);
		const revision = terminalRevisionOf(JSON.parse(bytesBefore.toString("utf8")));

		await reconcileOnce({
			runsDir: rd, deliverDir: d, now: NOW + 25_000, resolveDispatcher: () => "sess_dispatch",
			deliver: () => "sent",
		});
		const ev = reload(d, listEvents(d).find((e) => e.runId === runId)!.eventId);
		// 生产唯一的 consumed 写入器：ackConsumed（由 context 钩子观察 eventId 触发）。
		const acks = ackConsumed(d, [ev.eventId], { at: NOW + 30_000, evidence: "context-observed", disposition: "resumed" });
		assert.equal(acks[0].created, true, "consumed 回执写入成功");
		const consumedAckPath = join(d, `${encodeURIComponent(ev.eventId)}.ack.consumed.${encodeURIComponent(listAttempts(d, ev.eventId).at(-1)!.attemptId)}.json`);
		const consumedAckBytes = readFileSync(consumedAckPath);

		// ── 重启：consumed 胜出 ──
		const post = reload(d, ev.eventId);
		const view = stageOf(post, d, NOW + 31_000);
		assert.equal(view.stage, "consumed", "重启后 = consumed（最高优先级）");
		assert.equal(isDelivered(view.stage), true, "consumed 才 delivered");
		assert.equal(view.consumedBy?.evidence, "context-observed");

		// 不再投递、不再 incident、reconcileDecision 返回 none（**含期限之后**）
		let deliveries = 0;
		for (const t of [NOW + 32_000, NOW + DELIVERY_DEADLINE_MS + 1_000, NOW + 10 * 60_000]) {
			const d1 = reconcileDecision(post, view, listAttempts(d, ev.eventId), t);
			assert.equal(d1.action, "none", `consumed ⇒ 判 none（now=${t}）`);
			const r = await reconcileOnce({
				runsDir: rd, deliverDir: d, now: t, resolveDispatcher: () => "sess_dispatch",
				deliver: () => { deliveries += 1; return "sent"; },
			});
			assert.equal(r.results.filter((x) => x.action !== "none").length, 0, `consumed ⇒ 对账无动作（now=${t}）`);
		}
		assert.equal(deliveries, 0, "consumed 后**不再补投**");
		assert.equal(incidentFiles(d).length, 0, "consumed 后**不发 incident**");
		assert.ok(readFileSync(consumedAckPath).equals(consumedAckBytes), "consumed 回执字节不变（不可变回执）");

		// ── 全窗共同断言 ──
		assert.ok(runBytes(rd, runId).equals(bytesBefore), "① 原 run 终态逐字节不变");
		assert.equal(listEvents(d).filter((e) => e.runId === runId).length, 1, "② 只有一个事件");
		assert.equal(listAcks(d, ev.eventId).filter((a) => a.stage === "consumed").length, 1, "② consumed 回执恰一条");
		assert.equal(incidentFiles(d).length, 0, "③ 无 incident（重跑亦无）");
		ok("R7-e consumed-then-crash：重启 consumed 胜出（不投、不 incident、判 none）");
	}

	console.log(`\n_test_delivery_crash_window: all ${n} groups passed`);
} finally {
	rmSync(ROOT, { recursive: true, force: true });
}
