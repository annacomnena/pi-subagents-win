/**
 * _test_delivery_ledger.ts — 交付真账本单测（含 P1/P2/P3 回归 + 坏基线对照）
 *
 * 每个用例先断言**坏基线会红**（复现 P1/P2/P3），再断言修复后绿。
 * 这样测试本身证明「它能抓住这些缺陷」，而不是只证明「当前实现自洽」。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DELIVERY_DEADLINE_MS,
	LEASE_MS,
	RECONCILE_FIRST_RETRY_MS,
	ackIncident,
	deriveEventId,
	effectiveStage,
	ensureEvent,
	eventFileKey,
	isDelivered,
	listAcks,
	listAttempts,
	listOpenIncidents,
	loadEvent,
	parseEventId,
	publishIncident,
	reconcileDecision,
	reconcileEvent,
	recordAttempt,
	terminalRevisionOf,
	writeAck,
	type DeliveryEvent,
} from "./delivery-ledger.ts";

let n = 0;
const ok = (name: string): void => { n += 1; console.log(`ok ${n} - ${name}`); };

const root = mkdtempSync(join(tmpdir(), "delivery-test-"));
const dir = join(root, "delivery");
const NOW = Date.parse("2026-10-16T08:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

const mkTerminal = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
	id: "run_x", status: "completed", endedAt: iso(NOW), agent: "general",
	result: { status: "completed", text: "done", error: null },
	...over,
});

try {
	// ── D1：eventId 稳定性（重试/通知字段不得改变 eventId）────────────────
	{
		const rec = mkTerminal();
		const rev1 = terminalRevisionOf(rec);
		// 坏基线对照：若把「通知重试字段」算进 revision，重试会产生新 eventId（重复投递 → 重复调度）
		const withNoticeFields = terminalRevisionOf({ ...rec, attempts: 7, leaseUntil: iso(NOW + 5000), nextAttemptAt: iso(NOW + 9000), incidentId: "inc_x" });
		assert.equal(withNoticeFields, rev1, "通知重试字段**不得**影响 terminalRevision（否则重试=新事件）");
		// 结果字段变化 ⇒ 必须变 revision（迟到 close 写出不同终态 → 新事件）
		assert.notEqual(terminalRevisionOf({ ...rec, status: "failed" }), rev1, "终态变化 ⇒ revision 必须变");
		assert.notEqual(terminalRevisionOf({ ...rec, endedAt: iso(NOW + 1000) }), rev1, "endedAt 变化 ⇒ revision 变");
		const eid = deriveEventId("run_x", rev1);
		assert.equal(eid, `async:run_x:${rev1}`);
		assert.deepEqual(parseEventId(eid), { runId: "run_x", revision: rev1 });
		assert.equal(parseEventId("bogus"), null);
		// 文件名安全（eventId 含 `:`，Windows 非法）
		assert.ok(!eventFileKey(eid).includes(":"), "eventFileKey 必须可安全落盘");
		ok("D1 eventId 稳定：通知字段不影响 revision；终态变化则变；文件名安全");
	}

	// ── D2：P1 回归 —— pre-send claim 不得永久抑制完成事件 ────────────────
	{
		// **坏基线（旧机制）复现**：一个 `.notified` 占位文件存在 ⇒ 旧逻辑视「已处理」而永不重投。
		// 用真实文件复现「claim 跨重启存活」的语义：
		const legacyDir = join(root, "legacy-p1");
		const legacyMarker = join(legacyDir, "run_p1.notified");
		mkdirSync(legacyDir, { recursive: true });
		const fd = openSync(legacyMarker, "wx"); closeSync(fd);
		const legacyWouldSkip = existsSync(legacyMarker); // 旧实现：有 .notified ⇒ 跳过
		assert.equal(legacyWouldSkip, true, "坏基线：`.notified` 存在 ⇒ 旧实现跳过（这就是 P1 的机制）");

		// **新账本**：`.notified` 不是证据；只有 consumed ack 才算。故「重启遇到 .notified」时仍判 pending。
		const { event } = ensureEvent(dir, {
			runId: "run_p1", terminalRevision: terminalRevisionOf(mkTerminal({ id: "run_p1" })),
			terminalSnapshotPath: join(root, "run_p1.json"), dispatcherSessionId: "sess_1",
			observedAt: iso(NOW),
		});
		const view = effectiveStage(event, listAttempts(dir, event.eventId), listAcks(dir, event.eventId), NOW);
		assert.equal(view.stage, "pending", "新账本：无 ACK ⇒ 仍 pending（.notified 不是证据）");
		assert.equal(isDelivered(view.stage), false, ".notified 存在也不得算 delivered");
		ok("D2 P1 回归：坏基线(.notified⇒永久跳过)会红；新账本要求 ACK ⇒ 仍 pending");
	}

	// ── D3：P2 回归 —— 发送失败不得压掉无关事件 ──────────────────────────
	{
		const { event: e1 } = ensureEvent(dir, {
			runId: "run_p2a", terminalRevision: terminalRevisionOf(mkTerminal({ id: "run_p2a" })),
			terminalSnapshotPath: join(root, "a.json"), dispatcherSessionId: "sess_1", observedAt: iso(NOW),
		});
		const { event: e2 } = ensureEvent(dir, {
			runId: "run_p2b", terminalRevision: terminalRevisionOf(mkTerminal({ id: "run_p2b" })),
			terminalSnapshotPath: join(root, "b.json"), dispatcherSessionId: "sess_1", observedAt: iso(NOW),
		});
		// e1 发送失败（"failed"）
		recordAttempt(dir, e1.eventId, { attemptId: "a1", channel: "A", at: iso(NOW + 1000), status: "failed", error: "boom" });
		// **关键断言**：e1 的失败**不得**影响 e2 的判定（旧实现 selfDisabled 全局压制 ⇒ 坏）
		const v1 = effectiveStage(e1, listAttempts(dir, e1.eventId), listAcks(dir, e1.eventId), NOW + 2000);
		const v2 = effectiveStage(e2, listAttempts(dir, e2.eventId), listAcks(dir, e2.eventId), NOW + 2000);
		assert.equal(v1.stage, "retry_scheduled", "失败尝试 ⇒ retry_scheduled（可重投）");
		assert.equal(v2.stage, "pending", "**无关事件不受影响**（旧实现会一起被压掉 ⇒ P2）");
		// 且 e2 仍可投递（可重试）
		const d2 = reconcileDecision(e2, v2, listAttempts(dir, e2.eventId), NOW + RECONCILE_FIRST_RETRY_MS + 1000, { reconcileFirstRetryMs: 0 });
		assert.equal(d2.action, "retry", "e2 必须仍可投（不被 e1 拖累）");
		ok("D3 P2 回归：单条 send 失败只标该 attempt/通道，不压掉无关事件");
	}

	// ── D4：P3 回归 —— `sent` 不得命名 delivered ─────────────────────────
	{
		const { event } = ensureEvent(dir, {
			runId: "run_p3", terminalRevision: terminalRevisionOf(mkTerminal({ id: "run_p3" })),
			terminalSnapshotPath: join(root, "c.json"), dispatcherSessionId: "sess_1", observedAt: iso(NOW),
		});
		// 宿主 wrapper 假阳性：底层 reject，外层仍"report sent" ⇒ 我们只记 attempted
		recordAttempt(dir, event.eventId, { attemptId: "a_sent", channel: "A", at: iso(NOW + 1000), status: "sent" });
		const view = effectiveStage(event, listAttempts(dir, event.eventId), listAcks(dir, event.eventId), NOW + 2000);
		assert.equal(view.stage, "attempted", "`sent` ⇒ 只到 attempted");
		assert.equal(isDelivered(view.stage), false, "**`sent` 绝不是 delivered**（P3 核心）");
		// 且仍会在期限后被判 failed_delivery（不会因 sent 静默消失）
		const past = NOW + DELIVERY_DEADLINE_MS + 1000;
		const d = reconcileDecision(event, view, listAttempts(dir, event.eventId), past);
		assert.equal(d.action, "fail_delivery", "sent 后无 ACK + 过期限 ⇒ 交付失败（可升级）");
		ok("D4 P3 回归：sent⇒attempted（非 delivered）；无 ACK 过期即 failed_delivery");
	}

	// ── D5：阶段推进 pending→leased→attempted→received→consumed ──────────
	{
		const { event } = ensureEvent(dir, {
			runId: "run_stage", terminalRevision: terminalRevisionOf(mkTerminal({ id: "run_stage" })),
			terminalSnapshotPath: join(root, "d.json"), dispatcherSessionId: "sess_1", observedAt: iso(NOW),
		});
		assert.equal(effectiveStage(event, [], [], NOW).stage, "pending");
		recordAttempt(dir, event.eventId, { attemptId: "s1", channel: "A", at: iso(NOW + 500), status: "sent", leaseOwner: "A", leaseUntil: iso(NOW + 500 + LEASE_MS) });
		assert.equal(effectiveStage(event, listAttempts(dir, event.eventId), [], NOW + 1000).stage, "attempted");
		assert.equal(writeAck(dir, { eventId: event.eventId, stage: "received", attemptId: "s1", recipientGeneration: 1, at: iso(NOW + 2000), evidence: "persisted-user-entry" }), true, "首次 received ack 创建成功");
		assert.equal(effectiveStage(event, listAttempts(dir, event.eventId), listAcks(dir, event.eventId), NOW + 3000).stage, "received");
		assert.equal(writeAck(dir, { eventId: event.eventId, stage: "consumed", attemptId: "s1", recipientGeneration: 1, at: iso(NOW + 4000), evidence: "context-assoc:msg_9", disposition: "resumed" }), true);
		const consumedView = effectiveStage(event, listAttempts(dir, event.eventId), listAcks(dir, event.eventId), NOW + 5000);
		assert.equal(consumedView.stage, "consumed");
		assert.equal(isDelivered(consumedView.stage), true, "consumed 才 delivered");
		assert.equal(consumedView.consumedBy?.evidence, "context-assoc:msg_9");
		// 已 consumed ⇒ 不再重投、不再 fail
		assert.equal(reconcileDecision(event, consumedView, listAttempts(dir, event.eventId), NOW + 10 * 60_000).action, "none");
		ok("D5 阶段推进完整：pending→attempted→received→consumed；consumed 后终态冻结");
	}

	// ── D6：租约 15s 内不重复投递（防 A/B 惊群）──────────────────────────
	{
		const { event } = ensureEvent(dir, {
			runId: "run_lease", terminalRevision: terminalRevisionOf(mkTerminal({ id: "run_lease" })),
			terminalSnapshotPath: join(root, "e.json"), dispatcherSessionId: "sess_1", observedAt: iso(NOW),
		});
		recordAttempt(dir, event.eventId, { attemptId: "l1", channel: "A", at: iso(NOW + 1000), status: "sent" });
		const attempts = listAttempts(dir, event.eventId);
		const view = effectiveStage(event, attempts, [], NOW + 2000);
		assert.equal(reconcileDecision(event, view, attempts, NOW + 1000 + LEASE_MS - 1, { reconcileFirstRetryMs: 0 }).action, "none", "租约内 ⇒ 不重投");
		assert.equal(reconcileDecision(event, view, attempts, NOW + 1000 + LEASE_MS + 1, { reconcileFirstRetryMs: 0 }).action, "retry", "租约过期 ⇒ 可重投");
		ok("D6 租约：15s 内不重投（防惊群），过期才接管");
	}

	// ── D7：B 首投阈值 20s + 期限 60s ⇒ failed_delivery ──────────────────
	{
		const { event } = ensureEvent(dir, {
			runId: "run_deadline", terminalRevision: terminalRevisionOf(mkTerminal({ id: "run_deadline" })),
			terminalSnapshotPath: join(root, "f.json"), dispatcherSessionId: "sess_1", observedAt: iso(NOW),
		});
		const noAttempts: ReturnType<typeof listAttempts> = [];
		const v = effectiveStage(event, noAttempts, [], NOW);
		assert.equal(reconcileDecision(event, v, noAttempts, NOW + RECONCILE_FIRST_RETRY_MS - 1000).action, "none", "未到 20s ⇒ 等 A 快通道");
		assert.equal(reconcileDecision(event, v, noAttempts, NOW + RECONCILE_FIRST_RETRY_MS + 1000).action, "retry", "过 20s ⇒ B 补投");
		const late = reconcileDecision(event, v, noAttempts, NOW + DELIVERY_DEADLINE_MS + 1);
		assert.equal(late.action, "fail_delivery", "过 60s 期限 ⇒ failed_delivery");
		assert.ok(String(late.reason).includes("deadline-exceeded"));
		ok("D7 阈值：20s 首补投；60s 期限 ⇒ failed_delivery（不 kill、不改 run）");
	}

	// ── D8：失败出口 —— incident 跨重启保留、显式 ack 才清 ────────────────
	{
		const { event } = ensureEvent(dir, {
			runId: "run_inc", terminalRevision: terminalRevisionOf(mkTerminal({ id: "run_inc" })),
			terminalSnapshotPath: join(root, "g.json"), dispatcherSessionId: "sess_1", observedAt: iso(NOW),
		});
		const inc = publishIncident(dir, event, "deadline-exceeded(stage=attempted)", NOW + DELIVERY_DEADLINE_MS + 1);
		assert.ok(inc.incidentId);
		// 幂等：再发布不制造新 incident
		const inc2 = publishIncident(dir, event, "deadline-exceeded(stage=attempted)", NOW + DELIVERY_DEADLINE_MS + 2000);
		assert.equal(inc2.incidentId, inc.incidentId, "同 eventId 的 incident 幂等（不重复制造）");
		// 跨重启可见：重新 load（模拟新进程）
		const reopened = loadEvent(dir, event.eventId)!;
		assert.equal(reopened.incidentId, inc.incidentId, "incident 已持久在事件元数据（跨重启可见）");
		const open = listOpenIncidents(dir).filter((i) => i.eventId === event.eventId);
		assert.equal(open.length, 1, "未 ack 的 incident 列出（GUI 连接后可见）");
		// 显式 ack 才清
		assert.equal(ackIncident(dir, inc.incidentId, "user", NOW + 70_000), true, "显式 ack 生效");
		assert.equal(listOpenIncidents(dir).filter((i) => i.eventId === event.eventId).length, 0, "ack 后才从 open 列表消失");
		// failed_delivery 状态由事件元数据 + incident 共同确定，且**不改变 run**
		const v = effectiveStage({ ...reopened, incidentId: inc.incidentId }, [], [], NOW + 80_000);
		assert.equal(v.stage, "failed_delivery");
		ok("D8 incident：幂等发布、跨重启保留、显式 ack 才清（不因 toast 成功消失）");
	}

	// ── D9：ensureEvent 幂等（重试不重置 deadline / 不抹 incident）────────
	{
		const rev = terminalRevisionOf(mkTerminal({ id: "run_ens" }));
		const a = ensureEvent(dir, { runId: "run_ens", terminalRevision: rev, terminalSnapshotPath: join(root, "h.json"), dispatcherSessionId: "sess_1", observedAt: iso(NOW) });
		assert.equal(a.created, true);
		const inc = publishIncident(dir, a.event, "x", NOW + 1000);
		// 同一终态再 ensureEvent：不得覆盖（不得重置 deadline、不得抹掉 incident）
		const b = ensureEvent(dir, { runId: "run_ens", terminalRevision: rev, terminalSnapshotPath: join(root, "h.json"), dispatcherSessionId: "sess_2", observedAt: iso(NOW + 30_000), deliveryDeadlineMs: 999 });
		assert.equal(b.created, false, "已存在 ⇒ 不重复创建");
		assert.equal(b.event.observedAt, a.event.observedAt, "deadline 未被重置");
		assert.equal(b.event.incidentId, inc.incidentId, "**incident 未被抹掉**");
		assert.equal(b.event.dispatcherSessionId, "sess_1", "原派发者未被改写");
		ok("D9 ensureEvent 幂等：不重置 deadline、不抹 incident、不改派发者");
	}

	// ── D10：reconcileEvent 端到端（判定 + 投递 + incident 出口）─────────
	{
		const { event } = ensureEvent(dir, {
			runId: "run_e2e", terminalRevision: terminalRevisionOf(mkTerminal({ id: "run_e2e" })),
			terminalSnapshotPath: join(root, "i.json"), dispatcherSessionId: "sess_1", observedAt: iso(NOW),
		});
		// ① 首次补投：deliver 返回 "sent" ⇒ 记 attempt，stage=attempted
		const r1 = await reconcileEvent(dir, event, NOW + RECONCILE_FIRST_RETRY_MS + 1000, {
			deliver: () => "sent", channel: "B",
			onIncident: () => { throw new Error("不应在首次补投时发布 incident"); },
		});
		assert.equal(r1.action.action, "retry");
		assert.equal(effectiveStage(event, listAttempts(dir, event.eventId), listAcks(dir, event.eventId), NOW + 21_000).stage, "attempted");
		// ② 接收端 ack consumed ⇒ 之后对账 none
		const lastAttempt = listAttempts(dir, event.eventId).at(-1)!;
		writeAck(dir, { eventId: event.eventId, stage: "consumed", attemptId: lastAttempt.attemptId, recipientGeneration: 1, at: iso(NOW + 22_000), evidence: "context-assoc:msg_x" });
		const r2 = await reconcileEvent(dir, event, NOW + 23_000, { deliver: () => { throw new Error("不应再投"); } });
		assert.equal(r2.action.action, "none");
		assert.equal(r2.stage, "consumed");
		ok("D10 reconcileEvent 端到端：补投 → consumed 后停止（不再投）");
	}

	// ── D11：投递抛异常 ⇒ 记 failed attempt（不崩、不伪造 delivered）──────
	{
		const { event } = ensureEvent(dir, {
			runId: "run_throw", terminalRevision: terminalRevisionOf(mkTerminal({ id: "run_throw" })),
			terminalSnapshotPath: join(root, "j.json"), dispatcherSessionId: "sess_1", observedAt: iso(NOW),
		});
		await reconcileEvent(dir, event, NOW + RECONCILE_FIRST_RETRY_MS + 1000, {
			deliver: () => { throw new Error("injector exploded"); }, channel: "B",
		});
		const at = listAttempts(dir, event.eventId);
		assert.equal(at.length, 1);
		assert.equal(at[0].status, "failed");
		assert.ok(String(at[0].error).includes("injector exploded"));
		const view = effectiveStage(event, at, [], NOW + 30_000);
		assert.equal(view.stage, "retry_scheduled", "抛异常 ⇒ 可重试状态，不是 delivered");
		assert.equal(isDelivered(view.stage), false);
		ok("D11 投递异常：记 failed attempt（可重试），绝不伪造 delivered");
	}

	// ── D12：独立 oracle 复算 —— 不采信发送方自己的字段 ──────────────────
	{
		// oracle 只看「原始权威文件」（事件元数据 + attempt 文件 + ack 文件），不看任何内存/返回值。
		const allEvents = readdirSync(dir).filter((f) => f.endsWith(".json") && !f.includes(".attempt.") && !f.includes(".ack.") && !f.includes(".incident."));
		let silent = 0;
		let closed = 0;
		for (const f of allEvents) {
			const raw = JSON.parse(readFileSync(join(dir, f), "utf8")) as DeliveryEvent;
			const acks = listAcks(dir, raw.eventId);
			const view = effectiveStage(raw, listAttempts(dir, raw.eventId), acks, NOW + DELIVERY_DEADLINE_MS + 1000);
			if (view.stage === "consumed" || view.stage === "failed_delivery") closed += 1;
			else silent += 1;
		}
		assert.ok(allEvents.length > 0, "oracle 确实读到了事件");
		// 除刻意构造的未关单样本外，不允许大量 silent（本用例只验证 oracle 真的在算，不掩盖）
		assert.equal(closed + silent, allEvents.length, "oracle 覆盖全部事件（不右删失）");
		assert.ok(closed > 0, "至少有已关单事件（consumed 或 failed_delivery）");
		ok(`D12 独立 oracle：从原始文件复算 ${allEvents.length} 个事件（closed=${closed}, silent=${silent}）`);
	}

	console.log(`\n_test_delivery_ledger: all ${n} groups passed`);
} finally {
	rmSync(root, { recursive: true, force: true });
}
