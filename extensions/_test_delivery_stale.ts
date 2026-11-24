/**
 * _test_delivery_stale.ts — 投递污染止血 P-1 / P-2 / P-3 验收单测（2026-11-03）
 *
 * 依据：`plans/20261103_infra_health_delivery_pollution.md` §5 的 P-1/P-2/P-3 行 +
 * 任务书「验收标准」逐条。
 *
 * ## 覆盖什么（每条都从**真实入口**进，不直接调内部函数当验收）
 *   S1  `staleLeaseVerdict` 纯判据矩阵：租约未过期 ⇒ 不判死；pid 活 ⇒ 不判死；
 *       pid 死 + 租约过期 ⇒ `expired-dead-owner`；无 pid / 无租约 / 已终态 ⇒ 不判。
 *   S2  **接线**：`reconcileOnce({staleLeaseFinalize:true})` ⇒ 落终态记录 + **不再补投**，
 *       且**审计行真的落盘**（经 `startDeliveryReconcilerLoop` 的真实生产接线，
 *       默认 `appendAuditLine` → `<stateDir>/autonomy/audit.jsonl`）。
 *   S3  **接线**：默认（未开 `staleLeaseFinalize`）⇒ 与原行为一致：不落终态、照旧补投。
 *       （AGENTS 硬约束 2：破坏性能力默认关；本组是它的红/绿对照）
 *   S4  P-3 上限：同一 eventId 第 1、2 次补投放行，**第 3 次被拒**；首次投递（无 attempt 的
 *       A 通道首投）不受影响；第 2 次正文带「第 2 次补投（第 1 次未确认）」。
 *   S5  P-2：`findDeadLetters` 判据矩阵（超龄 + 目标 dead ⇒ 入清单；alive/unknown/未超龄
 *       /已终态 ⇒ 不入）；`finalizeDeadLetters` **默认干跑零写入**，显式 `dryRun:false`
 *       才落 `target-gone` + 写 journal 审计行。
 *   S6  生产的 R-2 纪律：P-1 终态记录**带 reason 与 leaseOwner**（不得静默）。
 *
 * ## 隔离（硬约束 1：禁止写生产账本）
 * `PI_RUNTIME_DIR` / `PI_SUBAGENT_RUNS_DIR` / `PI_LINKS_PATH` / `PI_SESSIONS_DIR` 全部在
 * **import 之前**指向 mkdtemp ⇒ 模块级路径解析一律落到临时目录。
 * 末尾 `rmSync(ROOT)`。测试结束前断言临时目录之外**没有**被触碰（见 S0）。
 *
 * ## 反例自检（断言强度）
 * 每组都带「坏基线」对照断言（同文件自证）：把判据/接线拆掉，该组必红。
 * 另见 `plans/20261103_delivery_stale_impl.md` §4 的 4 条实际变异（含拆接线）。
 *
 * 运行：npm run -s test:delivery-stale
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── 隔离必须在 import 之前（2026-11-03 L4 第 2 轮实测驱动）────────────
// 本文件此前用**顶层静态 import** 装载 delivery-ledger / reconciler / loop / outbox / mailbox，
// 而 ESM 静态 import **先于任何顶层语句执行** ⇒ `PI_RUNTIME_DIR` 晚赋，`DEFAULT_RUNS_DIR`
// （subagent-kill.ts:43 模块级缓存）在生产环境下求值 ⇒ 隔离只靠“测试自己全部显式传目录”兼顾。
// 现改为**环境变量先设 → 动态 import**，隔离不再依赖调用点纪律。
const ROOT = mkdtempSync(join(tmpdir(), "delivery-stale-env-"));
process.env.PI_RUNTIME_DIR = join(ROOT, "runtime");
process.env.PI_SUBAGENT_RUNS_DIR = join(ROOT, "subagent-runs");
process.env.PI_LINKS_PATH = join(ROOT, "links.jsonl");
process.env.PI_SESSIONS_DIR = join(ROOT, "sessions");
delete process.env.PI_SUBAGENT;
delete process.env.PI_TAB_RUN_ID;
delete process.env.PI_DELIVERY_RECONCILER;
delete process.env.PI_DELIVERY_STALE_FINALIZE;

const {
	EXPIRED_DEAD_OWNER,
	DELIVERY_DEADLINE_MS,
	DELIVERY_FAIL_DEADLINE_MS,
	LEASE_MS,
	MAX_B_RETRIES_PER_EVENT,
	RECONCILE_FIRST_RETRY_MS,
	deliveryDir,
	ensureEvent,
	effectiveStageOf,
	finalizeExpiredLease,
	listAttempts,
	eventFileKey,
	listOpenIncidents,
	_resetDeliveryDir,
	listEvents,
	parsePidFromLeaseOwner,
	reconcileDecision,
	recordAttempt,
	staleLeaseReason,
	staleLeaseVerdict,
	terminalRevisionOf,
	reconcileEvent,
	listAcks,
} = await import("./delivery-ledger.ts");
type DeliveryAttempt = import("./delivery-ledger.ts").DeliveryAttempt;
const { reconcileOnce } = await import("./delivery-reconciler.ts");
const { startDeliveryReconcilerLoop, staleFinalizeEnabled, buildReconcileWakeBody } = await import("./runtime-host/delivery-reconciler-loop.ts");
const { listOutboxItems, outboxDir } = await import("./runtime/message-outbox.ts");
const {
	DEAD_LETTER_MIN_AGE_MS,
	DEAD_CLAIM_AGE_MS,
	deliverLetter,
	finalizeDeadLetters,
	findDeadLetters,
	listLetters,
} = await import("./runtime/mailbox.ts");
const { newMessageFrame } = await import("./runtime/protocol.ts");
const { newEnvelopeId } = await import("./runtime/ids.ts");
const { masterAddress, piSessionAddress } = await import("./runtime/address.ts");
import type { MasterId } from "./runtime/ids.ts";

/** 与本文件其余夹具同型的小封装：`agent://<master>`（测试里原写 agentAddressFor，本仓真实导出是 masterAddress）。 */
const agentAddressFor = (master: string): ReturnType<typeof masterAddress> => masterAddress(master as MasterId);

let n = 0;
const ok = (name: string): void => { n += 1; console.log(`ok ${n} - ${name}`); };

const NOW = Date.parse("2026-11-03T06:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

// ── 夹具 ──────────────────────────────────────────────────────────

interface Group { runsDir: string; deliverDir: string; stateDir: string }
const group = (g: string): Group => {
	const d: Group = {
		runsDir: join(ROOT, `runs-${g}`),
		deliverDir: join(ROOT, `delivery-${g}`),
		stateDir: join(ROOT, `state-${g}`),
	};
	mkdirSync(d.runsDir, { recursive: true });
	mkdirSync(d.deliverDir, { recursive: true });
	return d;
};

const writeRun = (dir: string, runId: string, terminalAt: number): void => {
	writeFileSync(join(dir, `${runId}.json`), JSON.stringify({
		id: runId, agent: "general", task: "t", status: "completed",
		startedAt: iso(terminalAt - 60_000), endedAt: iso(terminalAt),
		result: { status: "completed", text: "ok" },
	}), "utf8");
};

/** 造一个「租约已领」的 attempt（形状与生产 982 条 unconfirmed 一致）。 */
const seedLeaseAttempt = (
	dir: string,
	runId: string,
	over: { leaseOwner: string; leaseUntil: number; at: number; status?: DeliveryAttempt["status"]; channel?: "A" | "B" },
): { eventId: string; attemptId: string } => {
	const terminalAt = NOW;
	const rec = { id: runId, status: "completed", endedAt: iso(terminalAt), result: { status: "completed", text: "ok" } };
	const { event } = ensureEvent(dir, {
		runId,
		terminalRevision: terminalRevisionOf(rec),
		terminalSnapshotPath: join(ROOT, `${runId}.json`),
		dispatcherSessionId: "sess_stale",
		observedAt: iso(terminalAt),
		terminalAt: iso(terminalAt),
	});
	const attemptId = `${event.eventId}@${over.channel ?? "A"}@seed`;
	recordAttempt(dir, event.eventId, {
		attemptId,
		channel: over.channel ?? "A",
		at: iso(over.at),
		status: over.status ?? "unconfirmed",
		leaseOwner: over.leaseOwner,
		leaseUntil: iso(over.leaseUntil),
	});
	return { eventId: event.eventId, attemptId };
};

const auditLines = (stateDir: string): string[] => {
	const p = join(stateDir, "autonomy", "audit.jsonl");
	if (!existsSync(p)) return [];
	return readFileSync(p, "utf8").split("\n").filter((l) => l.length > 0);
};

const stageOf = (dir: string, eventId: string, now: number) => {
	const ev = listEvents(dir, 100_000).find((e) => e.eventId === eventId)!;
	return effectiveStageOf({ event: ev, attempts: listAttempts(dir, eventId), acks: [] }, { incidentId: ev.incidentId, incidentAt: ev.incidentAt }, now);
};

try {
	// ── S0：隔离自证（不写生产账本的**结构性**前提）──────────────────────
	{
		assert.equal(deliveryDir().startsWith(ROOT), true, `S0 deliveryDir 必须落在临时根（实得 ${deliveryDir()}）`);
		assert.equal(process.env.PI_RUNTIME_DIR, join(ROOT, "runtime"), "S0 PI_RUNTIME_DIR 已隔离");
		assert.equal(process.env.PI_SUBAGENT_RUNS_DIR, join(ROOT, "subagent-runs"), "S0 PI_SUBAGENT_RUNS_DIR 已隔离");
		// 生产守卫自证：`_resetDeliveryDir` 对**默认（生产口径）账本目录**必须招错，不得 no-op。
		// 依据（2026-11-03 体检）：`runtime/delivery/` 从 3470 条→689 条（无备份），全仓 grep 到的
		// **唯一**删除动作就是 `_resetDeliveryDir`（原本对目录零守卫）⇒ 本断言是防它被误用于生产的哨兵。
		assert.throws(
			() => _resetDeliveryDir(deliveryDir()),
			/PI_ALLOW_PROD_RESET/,
			"S0 生产守卫：_resetDeliveryDir 对默认账本目录招错（不静默清空）",
		);
		assert.equal(process.env.PI_ALLOW_PROD_RESET, undefined, "S0 前置：未设 PI_ALLOW_PROD_RESET（守卫应在默认状态下生效）");
		ok("S0 隔离：所有账本路径在 mkdtemp 内（零写生产 `~/.pi/agent`）+ _resetDeliveryDir 生产守卫在位");
	}

	// ── S1：staleLeaseVerdict 纯判据矩阵 ──────────────────────────────
	{
		const now = NOW;
		const alive = (): boolean => true;
		const dead = (): boolean => false;
		const expired = iso(now - 1_000);
		const live = iso(now + 60_000);

		// ① 租约**未**过期 + pid 死 ⇒ 不判死（活持有者的正常窗口；抢租约 = 丢信）
		assert.equal(staleLeaseVerdict({ leaseUntil: live, leaseOwner: "MB:10248", status: "unconfirmed" }, { now, isPidAlive: dead }), null,
			"S1① 租约未过期 ⇒ 不判死（即使 pid 确实死了：租约内是别人的窗口）");
		// ② 租约过期 + pid **活** ⇒ 不判死（慢 ≠ 死）
		assert.equal(staleLeaseVerdict({ leaseUntil: expired, leaseOwner: "MB:10248", status: "unconfirmed" }, { now, isPidAlive: alive }), null,
			"S1② pid 活 ⇒ 不判死（这是「绝不只看 lastActivityAt」的核心：慢不等于死）");
		// ③ 租约过期 + pid 死 ⇒ 判 expired-dead-owner（目标行为）
		assert.equal(staleLeaseVerdict({ leaseUntil: expired, leaseOwner: "MB:10248", status: "unconfirmed" }, { now, isPidAlive: dead }), EXPIRED_DEAD_OWNER,
			"S1③ 租约过期 + pid 死 ⇒ expired-dead-owner");
		// ④ 边界：leaseUntil === now ⇒ **不**判（判据是严格 <）
		assert.equal(staleLeaseVerdict({ leaseUntil: iso(now), leaseOwner: "MB:1", status: "unconfirmed" }, { now, isPidAlive: dead }), null,
			"S1④ leaseUntil==now 不算过期（严格小于）");
		// ⑤ 无 leaseOwner / 无 pid / 无 leaseUntil ⇒ fail-closed（不判）
		assert.equal(staleLeaseVerdict({ leaseUntil: expired, status: "unconfirmed" }, { now, isPidAlive: dead }), null, "S1⑤ 无 leaseOwner ⇒ 不判（无死亡证据）");
		assert.equal(staleLeaseVerdict({ leaseUntil: expired, leaseOwner: "MB:not-a-pid", status: "unconfirmed" }, { now, isPidAlive: dead }), null, "S1⑤ leaseOwner 取不出 pid ⇒ 不判");
		assert.equal(staleLeaseVerdict({ leaseOwner: "MB:10248", status: "unconfirmed" }, { now, isPidAlive: dead }), null, "S1⑤ 无 leaseUntil ⇒ 不判（从没领过租约）");
		// ⑥ 已终态 ⇒ 不重复判（幂等）
		assert.equal(staleLeaseVerdict({ leaseUntil: expired, leaseOwner: "MB:10248", status: EXPIRED_DEAD_OWNER }, { now, isPidAlive: dead }), null,
			"S1⑥ 已终态 ⇒ 不重复判（幂等）");
		// ⑦ 探针抛错 ⇒ 不判（不猜）
		assert.equal(staleLeaseVerdict({ leaseUntil: expired, leaseOwner: "MB:10248", status: "unconfirmed" }, { now, isPidAlive: () => { throw new Error("boom"); } }), null,
			"S1⑦ 探针异常 ⇒ 不判");
		// ⑧ 判据**不看** lastActivityAt：即使对象里塞了这个字段也不影响（结构性）
		assert.equal(staleLeaseVerdict({ leaseUntil: expired, leaseOwner: "MB:10248", status: "unconfirmed", lastActivityAt: iso(now) } as never, { now, isPidAlive: dead }), EXPIRED_DEAD_OWNER,
			"S1⑧ lastActivityAt 新鲜与否不参与判据（照 lane-facts 的理由：绝不用它判死）");

		// pid 解析：覆盖实测出现的全部前缀（MB / OB / A / B）
		assert.equal(parsePidFromLeaseOwner("MB:10248"), 10248);
		assert.equal(parsePidFromLeaseOwner("OB:76520"), 76520);
		assert.equal(parsePidFromLeaseOwner("B:47648"), 47648);
		assert.equal(parsePidFromLeaseOwner("A:64712"), 64712);
		assert.equal(parsePidFromLeaseOwner("reconcile:12345"), 12345);
		assert.equal(parsePidFromLeaseOwner(undefined), null);
		assert.equal(parsePidFromLeaseOwner("MB:"), null);
		// ⑨ 作用面：非 `unconfirmed` 一律不判（已送达/显式失败各有自己的路径）
		for (const st of ["sent", "busy", "failed", "no-injector"] as const) {
			assert.equal(staleLeaseVerdict({ leaseUntil: expired, leaseOwner: "MB:10248", status: st }, { now, isPidAlive: dead }), null,
				`S1⑨ status=${st} ⇒ 不判（P-1 作用面 = 持有租约且未确认；实测干跑 8 条候选里 7 条是 sent，必须排除）`);
		}
		ok("S1 staleLeaseVerdict 矩阵 9 项 + pid 解析 4 前缀（未过期/活/死/边界/缺字段/幂等/探针异常/lastActivityAt 不参与/非 unconfirmed 不判）");
	}

	// ── S2：**接线** —— reconciler 走真实入口判死 ⇒ 不补投 + 落终态 + 审计行真落盘 ──
	{
		const g = group("s2");
		writeRun(g.runsDir, "run_s2_stale", NOW);
		let deliverCalls = 0;
		const r = await reconcileOnce({
			runsDir: g.runsDir,
			deliverDir: g.deliverDir,
			now: NOW + 30_000, // > 首投阈值，但 < 期限（确保「本来会补投」）
			resolveDispatcher: () => "sess_stale",
			deliver: () => { deliverCalls += 1; return "sent"; },
			staleLeaseFinalize: true, // ← 显式开启（默认关）
			isPidAlive: () => false, // 持有者已死
		});
		// 先建事件 + 租约（这一轮会正常补投 1 次），然后再造「持有者死后留下的过期租约」
		assert.equal(r.results.length, 1, "S2 扫到 1 条终态 run");
		assert.equal(deliverCalls, 1, "S2 前置：首轮正常补投 1 次（证明这条事件本来是会被补投的）");
		const ev = listEvents(g.deliverDir, 100).find((e) => e.runId === "run_s2_stale")!;

		// 造「已死进程留下的过期租约」作为**最近** attempt（形状同生产 982 条）
		recordAttempt(g.deliverDir, ev.eventId, {
			attemptId: `${ev.eventId}@MB@dead`,
			channel: "A",
			at: iso(NOW + 31_000),
			status: "unconfirmed",
			leaseOwner: "MB:10248",
			leaseUntil: iso(NOW + 32_000),
		});
		const before = listAttempts(g.deliverDir, ev.eventId).length;
		assert.equal(before, 2, "S2 盘上 2 条 attempt（B 补投 + 已死 MB 租约）");

		let captured: { reason: string; leaseOwner?: string } | null = null;
		deliverCalls = 0;
		const r2 = await reconcileOnce({
			runsDir: g.runsDir,
			deliverDir: g.deliverDir,
			now: NOW + 60_000 - 1, // 仍在期限内 ⇒ 若判据没接上，这里会补投
			resolveDispatcher: () => "sess_stale",
			deliver: () => { deliverCalls += 1; return "sent"; },
			staleLeaseFinalize: true,
			isPidAlive: () => false,
			onExpiredLease: (x) => { captured = x; },
		});
		// ① **不再补投**（这是本项的核心断言）
		assert.equal(deliverCalls, 0, "S2① 判为 expired-dead-owner ⇒ **不再走 B 通道补投**");
		assert.equal(r2.results.filter((x) => x.runId === "run_s2_stale" && x.action === "finalize_expired_lease").length, 1,
			"S2① 结果动作 = finalize_expired_lease");
		assert.equal(r2.results.filter((x) => x.runId === "run_s2_stale" && x.action === "retry").length, 0, "S2① 无 retry");
		// ② 落终态记录（append-only，原 attempt 保留）
		const after = listAttempts(g.deliverDir, ev.eventId);
		assert.equal(after.length, before + 1, "S2② 追加 1 条终态记录（append-only）");
		const fin = after.at(-1)!;
		assert.equal(fin.status, EXPIRED_DEAD_OWNER, "S2② 终态记录 status = expired-dead-owner");
		assert.equal(fin.leaseOwner, "MB:10248", "S2② 终态记录**保留原 leaseOwner**（R-2 可审计）");
		assert.ok(typeof fin.reason === "string" && fin.reason.includes("lease-expired+owner-dead"),
			`S2② 终态记录带可读 reason（不得静默，实得 ${String(fin.reason)}）`);
		assert.ok(fin.reason!.includes("pid=10248"), "S2② reason 含判据要素 pid");
		assert.equal(after[0].attemptId, `${ev.eventId}@${NOW + 30_000}@`.slice(0, 0) + after[0].attemptId, "S2② 原 attempt 未被删改（append-only）");
		// ③ stage 推导跟着变（终态 ⇒ 不再 retry）
		const view = stageOf(g.deliverDir, ev.eventId, NOW + 60_000 - 1);
		assert.equal(view.stage, "expired_dead_lease", "S2③ effectiveStageOf ⇒ expired_dead_lease");
		const dec = reconcileDecision(ev, view, listAttempts(g.deliverDir, ev.eventId), NOW + 60_000 - 1, { staleLease: () => EXPIRED_DEAD_OWNER });
		assert.equal(dec.action, "none", "S2③ 终态后 reconcileDecision = none（幂等，不重复落终态）");
		// ④ 审计回调命中一次且带 reason/leaseOwner（生产默认实现见 S2b）
		assert.ok(captured !== null, "S2④ onExpiredLease 被调（审计入口真的走了）");
		assert.equal((captured as unknown as { eventId: string }).eventId, ev.eventId, "S2④ 审计行带 eventId");

		// ⑤ 重跑幂等：不再追加终态记录、不再补投
		const n3 = listAttempts(g.deliverDir, ev.eventId).length;
		await reconcileOnce({
			runsDir: g.runsDir, deliverDir: g.deliverDir, now: NOW + 60_000 - 2,
			resolveDispatcher: () => "sess_stale", deliver: () => { deliverCalls += 1; return "sent"; },
			staleLeaseFinalize: true, isPidAlive: () => false,
		});
		assert.equal(deliverCalls, 0, "S2⑤ 重跑仍不补投");
		assert.equal(listAttempts(g.deliverDir, ev.eventId).length, n3, "S2⑤ 重跑不追加第二条终态记录（幂等）");
		ok("S2 接线：reconcileOnce 判死 ⇒ 不再补投 + 落终态（带 reason/leaseOwner）+ stage=expired_dead_lease + 幂等");
	}

	// ── S2b：**审计行真的落盘**（经 startDeliveryReconcilerLoop 的真实生产接线）──
	{
		const g = group("s2b");
		writeRun(g.runsDir, "run_s2b_audit", NOW);
		// 先建事件 + 已死持有者的过期租约（模拟生产形状）
		const { eventId } = seedLeaseAttempt(g.deliverDir, "run_s2b_audit", {
			leaseOwner: "MB:10248", leaseUntil: NOW + 5_000, at: NOW + 1_000,
		});
		assert.equal(auditLines(g.stateDir).length, 0, "S2b 前置：audit.jsonl 不存在/为空");

		const loop = startDeliveryReconcilerLoop({
			runsDir: g.runsDir,
			deliverDir: g.deliverDir,
			stateDir: g.stateDir,
			intervalMs: 60_000,
			limit: 50,
			now: () => NOW + 30_000, // 租约已过期；仍在 60s 期限内 ⇒ 若判据不生效就会补投
			resolveDispatcher: () => "sess_stale",
			staleFinalize: true,
			isPidAlive: () => false,
			// 注意：**不注入 onExpiredLease** ⇒ 走生产缺省 = appendAuditLine → state/autonomy/audit.jsonl
		});
		try { await loop.ready; } finally { loop.stop(); }

		// ① 审计行真的落在生产入口指的那个文件里（不是回调桩）
		const lines = auditLines(g.stateDir);
		assert.equal(lines.length, 1, `S2b① 审计行恰好 1 条落在 <stateDir>/autonomy/audit.jsonl（实得 ${lines.length}: ${lines.join(" | ")}）`);
		assert.ok(lines[0].includes("delivery stale-lease finalized"), `S2b① 审计行可识别（实得 ${lines[0]}）`);
		assert.ok(lines[0].includes(eventId), "S2b① 审计行带 eventId");
		assert.ok(lines[0].includes("MB:10248"), "S2b① 审计行带 leaseOwner（R-2）");
		assert.ok(lines[0].includes("lease-expired+owner-dead"), "S2b① 审计行带判据 reason");
		// ② 终态记录也落盘了
		assert.equal(listAttempts(g.deliverDir, eventId).at(-1)!.status, EXPIRED_DEAD_OWNER, "S2b② 终态记录已落盘");
		// ③ outbox 未被增加（不补投）
		assert.equal(listOutboxItems(outboxDir(g.stateDir)).length, 0, "S2b③ 判死 ⇒ 零 outbox 唤醒（不补投）");
		// ④ 再跑一轮：不追加第二条审计（幂等）
		const loop2 = startDeliveryReconcilerLoop({
			runsDir: g.runsDir, deliverDir: g.deliverDir, stateDir: g.stateDir, intervalMs: 60_000, limit: 50,
			now: () => NOW + 40_000, resolveDispatcher: () => "sess_stale", staleFinalize: true, isPidAlive: () => false,
		});
		try { await loop2.ready; } finally { loop2.stop(); }
		assert.equal(auditLines(g.stateDir).length, 1, "S2b④ 重跑不追加审计行（幂等）");
		ok("S2b 审计**真落盘**：loop 真实接线 ⇒ state/autonomy/audit.jsonl 一条，含 eventId/leaseOwner/reason；重跑幂等");
	}

	// ── S3：默认关（破坏性能力默认 dry-run）—— 红/绿对照 ────────────────
	{
		const g = group("s3");
		writeRun(g.runsDir, "run_s3_default", NOW);
		const { eventId } = seedLeaseAttempt(g.deliverDir, "run_s3_default", {
			leaseOwner: "MB:10248", leaseUntil: NOW + 5_000, at: NOW + 1_000,
		});
		let deliverCalls = 0;
		// 不传 staleLeaseFinalize（且 env 未设）⇒ 关闭
		assert.equal(staleFinalizeEnabled({}), false, "S3 env 未设 ⇒ staleFinalize 默认关");
		assert.equal(staleFinalizeEnabled({ PI_DELIVERY_STALE_FINALIZE: "1" }), true, "S3 env=1 ⇒ 开");
		assert.equal(staleFinalizeEnabled({ PI_DELIVERY_STALE_FINALIZE: "0" }), false, "S3 env=0 ⇒ 关");
		assert.equal(staleFinalizeEnabled({ PI_DELIVERY_STALE_FINALIZE: "true" }), false, "S3 仅恰为 1 才开（其余值都不开）");

		await reconcileOnce({
			runsDir: g.runsDir, deliverDir: g.deliverDir, now: NOW + 30_000,
			resolveDispatcher: () => "sess_stale",
			deliver: () => { deliverCalls += 1; return "sent"; },
			// staleLeaseFinalize 缺省 = false
			isPidAlive: () => false,
		});
		// 坏基线对照：关闭时**P-1 零影响** ⇒ 照旧补投、不落终态、零审计。
		// **措辞诚实化（2026-11-03 L4）**：S3 只证明「P-1 默认关」。它**不**证明「与改动前逐字节等价」，
		// 因为 **P-3 补投上限是无条件生效的**（`delivery-ledger.ts` reconcileDecision 内，不受本开关控制）。
		const last = listAttempts(g.deliverDir, eventId).at(-1)!;
		assert.notEqual(last.status, EXPIRED_DEAD_OWNER, "S3 关闭 ⇒ 不落终态记录");
		assert.equal(auditLines(g.stateDir).length, 0, "S3 关闭 ⇒ 不写审计");
		// P-3 无条件性对照：P-1 关着，同一事件补投到上限后仍被封顶（证明 P-3 不靠开关）
		let capped = 0;
		for (let i = 0; i < 4; i += 1) {
			const rr = await reconcileOnce({
				runsDir: g.runsDir, deliverDir: g.deliverDir, now: NOW + 30_000 + (i + 1) * 20_000,
				resolveDispatcher: () => "sess_stale", deliver: () => { capped += 1; return "sent"; },
				isPidAlive: () => false, // P-1 关着（不传 staleLeaseFinalize）
			});
			void rr;
		}
		assert.ok(capped <= MAX_B_RETRIES_PER_EVENT, `S3 P-3 无条件生效：P-1 关着时补投次数也封顶（实得 ${capped}，上限 ${MAX_B_RETRIES_PER_EVENT}）`);
		ok("S3 默认关：未开 staleFinalize ⇒ P-1 零影响（照旧补投、零终态、零审计）；**P-3 无条件封顶**（不是逐字节等价）");
	}

	// ── S4：P-3 补投上限 = 2 + 第 2 次正文编号 ─────────────────────────
	{
		const g = group("s4");
		writeRun(g.runsDir, "run_s4_cap", NOW);
		let deliverCalls = 0;
		const ordinals: (number | undefined)[] = [];
		const common = {
			runsDir: g.runsDir, deliverDir: g.deliverDir, resolveDispatcher: () => "sess_stale",
			deliver: (_e: unknown, _a: string, o?: number) => { deliverCalls += 1; ordinals.push(o); return "sent" as const; },
			maxBRetries: MAX_B_RETRIES_PER_EVENT,
		};
		// 第 1 次补投（过 20s 首投阈值）
		await reconcileOnce({ ...common, now: NOW + RECONCILE_FIRST_RETRY_MS + 1_000 });
		assert.equal(deliverCalls, 1, "S4 第 1 次补投放行");
		// 第 2 次补投（过租约）
		await reconcileOnce({ ...common, now: NOW + RECONCILE_FIRST_RETRY_MS + LEASE_MS + 2_000 });
		assert.equal(deliverCalls, 2, "S4 第 2 次补投放行");
		// **第 3 次必须被拒**
		await reconcileOnce({ ...common, now: NOW + RECONCILE_FIRST_RETRY_MS + 2 * LEASE_MS + 3_000 });
		assert.equal(deliverCalls, 2, "S4 第 3 次补投**被拒**（上限 = 2）");
		// 再跑一轮也仍然拒
		await reconcileOnce({ ...common, now: NOW + RECONCILE_FIRST_RETRY_MS + 3 * LEASE_MS + 4_000 });
		assert.equal(deliverCalls, 2, "S4 上限是稳态（不是单轮跳过）");
		assert.deepEqual(ordinals, [1, 2], `S4 补投序号依次 1、2（实得 ${JSON.stringify(ordinals)}）`);

		// 上限**不削弱**首次投递：A 通道首投由 A 自己做（本测试证明的是
		// 「无 attempt 的事件在 20s 内不会被 B 抢先投」，即首投面不变）
		const g2 = group("s4-first");
		writeRun(g2.runsDir, "run_s4_first", NOW);
		let first = 0;
		await reconcileOnce({
			runsDir: g2.runsDir, deliverDir: g2.deliverDir, now: NOW + 5_000, // < 20s 首投阈值
			resolveDispatcher: () => "sess_stale", deliver: () => { first += 1; return "sent"; },
		});
		assert.equal(first, 0, "S4 首次投递不受上限影响：未到 20s ⇒ B 不抢投（A 快通道仍先做）");
		await reconcileOnce({
			runsDir: g2.runsDir, deliverDir: g2.deliverDir, now: NOW + RECONCILE_FIRST_RETRY_MS + 1_000,
			resolveDispatcher: () => "sess_stale", deliver: () => { first += 1; return "sent"; },
		});
		assert.equal(first, 1, "S4 首次补投正常发生（上限从 1 开始数，不吞掉第一次）");

		// 正文编号：第 1 次保留原措辞，第 2 次带「第 2 次补投（第 1 次未确认）」
		const evt = { eventId: "async:run_x:abc", runId: "run_x", terminalAt: iso(NOW) };
		const b1 = buildReconcileWakeBody(evt, 1);
		const b2 = buildReconcileWakeBody(evt, 2);
		const b0 = buildReconcileWakeBody(evt);
		assert.ok(b1.includes("终态交付未确认"), "S4 第 1 次正文保留原措辞（兼容既有识别）");
		assert.ok(b2.includes("第 2 次补投（第 1 次未确认）"), `S4 第 2 次正文带编号（实得：${b2.split("\\n")[0]}）`);
		assert.ok(b0.includes("终态交付未确认") && !b0.includes("第 "), "S4 未传序号时保持兼容措辞");
		assert.ok(b1.includes("[evt:async:run_x:abc]"), "S4 正文仍带 eventId 标记（consumed ACK 的唯一驱动）");

		// 生产投递路径：第 2 次补投会把 pending 项的正文升级成带编号版本（不新增 outbox 项）
		const st = join(ROOT, "state-s4-outbox");
		const dd = join(ROOT, "delivery-s4-outbox");
		const g3 = { runsDir: join(ROOT, "runs-s4-outbox"), deliverDir: dd, stateDir: st };
		mkdirSync(g3.runsDir, { recursive: true });
		writeRun(g3.runsDir, "run_s4_outbox", NOW);
		// 【夹具修正 2026-11-24】`sess_s4o` 不是 UUID ⇒ `makeOutboxDeliver` 自 **`0022e17`**
		// （2026-11-10 14:07:16「dispatcher 形状校验（只认 UUID）+ 不可达 fail-fast」）
		// 起 **fail closed 不写 outbox** ⇒ 本断言自那以后一直是红的（预存在失败，与 P0-a 无关）。
		// 修夹具而不是放宽实现：「写一条注定到不了的 outbox」正是那次要消灭的行为。
		// （commit 归属更正：L4 复核指出我最初写的 `0d73702` 早了一个 commit——那是 tab→ownerSessionId 解析。）
		const S4O_DISPATCHER = "01a1c4d0-0000-7000-8000-000000000ab1";
		const mkLoop = (nowMs: number) => startDeliveryReconcilerLoop({
			runsDir: g3.runsDir, deliverDir: g3.deliverDir, stateDir: g3.stateDir,
			intervalMs: 60_000, limit: 50, now: () => nowMs, resolveDispatcher: () => S4O_DISPATCHER,
		});
		const l1 = mkLoop(NOW + RECONCILE_FIRST_RETRY_MS + 1_000);
		try { await l1.ready; } finally { l1.stop(); }
		const items1 = listOutboxItems(outboxDir(st));
		assert.equal(items1.length, 1, "S4 生产路径：第 1 次补投产生 1 个 outbox 项");
		assert.ok(items1[0].text.includes("终态交付未确认"), "S4 第 1 次正文无编号");
		const l2 = mkLoop(NOW + RECONCILE_FIRST_RETRY_MS + LEASE_MS + 2_000);
		try { await l2.ready; } finally { l2.stop(); }
		const items2 = listOutboxItems(outboxDir(st));
		assert.equal(items2.length, 1, "S4 第 2 次补投**不新增** outbox 项（dedupeKey 绑 eventId）");
		assert.ok(items2[0].text.includes("第 2 次补投（第 1 次未确认）"), `S4 第 2 次把 pending 项正文升级为带编号版本（实得：${items2[0].text.split("\n")[0]}）`);
		ok("S4 P-3 上限=2：第 1/2 次放行、第 3 次拒；首次投递不受影响；第 2 次正文带「第 2 次补投（第 1 次未确认）」");
	}

	// ── S5：P-2 死信终态化（判据矩阵 + 默认干跑 + 显式落盘）──────────────
	{
		const mailDir = join(ROOT, "mailbox-s5");
		const to = agentAddressFor("master_default");
		const toAlive = piSessionAddress("01aa1ive-fixture-0001");
		const toUnknown = piSessionAddress("01aunknown-fixture-0001");
		const now = NOW;

		const mkLetter = (id: string, sentAt: number, recipient: string = to, status: "pending" | "claimed" = "pending", claimedAt?: number): void => {
			const frame = newMessageFrame({
				id: newEnvelopeId("msg") as never,
				kind: "QUESTION",
				from: agentAddressFor("master_local_subagent-win"),
				to: recipient as never,
				sentAt: iso(sentAt),
				summary: "dead-letter fixture",
			});
			// 用 messageId 命名可预测（deliverLetter 用 frame.id 当文件名）
			(frame as { id: string }).id = id;
			deliverLetter(frame, { mailboxDir: mailDir });
			if (status !== "pending") {
				// 直接改盘上状态（claimLetters 会改写 claimedAt，这里要精确控制）
				const p = join(mailDir, recipient.replace(/[^A-Za-z0-9._-]/g, "_"), `${id}.json`);
				const raw = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
				writeFileSync(p, JSON.stringify({ ...raw, status, claimedAt: claimedAt !== undefined ? iso(claimedAt) : undefined }), "utf8");
			}
		};

		const day = 24 * 3_600_000;
		mkLetter("msg_dead_old", now - 47 * day);              // 47 天 pending，目标 dead ⇒ 入清单（对应实测最老那条）
		mkLetter("msg_dead_claimed", now - 40 * day, to, "claimed", now - 22 * 3_600_000); // 40 天 claimed 卡 22h ⇒ 入清单
		mkLetter("msg_dead_recent", now - 1 * 3_600_000);       // 1h，太新 ⇒ 不入
		mkLetter("msg_deadclaimed_recent", now - 40 * day, to, "claimed", now - 10 * 60_000); // claimed 仅 10min ⇒ 不入（reclaim 窗口内；id 需匹配 ^msg_[A-Za-z0-9]+_[A-Za-z0-9]+$，单下划线段）
		mkLetter("msg_alive_old", now - 47 * day, toAlive);      // 47 天，但目标 alive ⇒ 不入
		mkLetter("msg_unknown_old", now - 47 * day, toUnknown);  // 47 天，探针 unknown ⇒ 不入（不猜）

		const probes: Record<string, { state: "alive" | "dead" | "unknown"; basis: string }> = {
			[to]: { state: "dead", basis: "pid-dead(10248,kill)" },
			[toAlive]: { state: "alive", basis: "pid-alive-heartbeat-fresh" },
			[toUnknown]: { state: "unknown", basis: "no-scope-liveness-record" },
		};
		const probeDead = (addr: string) => probes[addr] ?? { state: "dead" as const, basis: "default-dead" };
		const probeByLetter = (addr: string) => probeDead(addr);

		// 用 to 无法区分同一收件人的不同信 ⇒ 判据矩阵分三轮：目标 dead / alive / unknown
		const rowsDead = findDeadLetters({ mailboxDir: mailDir, probe: probeByLetter, now });
		const idsDead = rowsDead.map((r) => r.messageId).sort();
		assert.deepEqual(idsDead, ["msg_dead_claimed", "msg_dead_old"],
			`S5① 目标 dead + 超龄 ⇒ 恰好 2 条入清单（实得 ${idsDead.join(",")}）`);
		assert.equal(rowsDead[0].ageMs > rowsDead[1].ageMs, true, "S5① 清单按年龄降序（最老的在前）");
		assert.ok(rowsDead.every((r) => r.reason.includes("target-gone")), "S5① 每行带可读 reason（R-2）");

		const rowsAlive = findDeadLetters({ mailboxDir: mailDir, probe: () => ({ state: "alive", basis: "pid-alive-heartbeat-fresh" }), now });
		assert.equal(rowsAlive.length, 0, "S5② 目标 alive ⇒ 零条（即使 47 天也不能判死）");
		const rowsUnknown = findDeadLetters({ mailboxDir: mailDir, probe: () => ({ state: "unknown", basis: "no-scope-liveness-record" }), now });
		assert.equal(rowsUnknown.length, 0, "S5② 探针 unknown ⇒ 零条（缺证据 ≠ dead，硬不变量）");

		// 阈值常量可注入 + 默认值符合注释依据
		assert.equal(DEAD_LETTER_MIN_AGE_MS, 72 * 3_600_000, "S5 阈值 72h（注释依据：实测最老 47 天/中位 235h，留 3× 余量）");
		assert.equal(DEAD_CLAIM_AGE_MS, 3_600_000, "S5 claimed 额外窗口 1h（= 6× reclaim 10min 窗口）");
		const rowsFast = findDeadLetters({ mailboxDir: mailDir, probe: probeByLetter, now, minAgeMs: 3_600_000, claimAgeMs: 60_000 });
		assert.ok(rowsFast.length >= 3, "S5 阈值可注入（注入更短阈值 ⇒ 命中更多，证明阈值真的参与判定）");

		// ② 默认干跑：零写入
		const before = listLetters(to, undefined, mailDir).map((l) => l.status).sort();
		const dry = finalizeDeadLetters(rowsDead, { now });
		assert.equal(dry.length, 0, "S5③ 默认 dryRun ⇒ 不落盘");
		const afterDry = listLetters(to, undefined, mailDir).map((l) => l.status).sort();
		assert.deepEqual(afterDry, before, "S5③ 干跑后盘上状态不变");
		assert.equal(finalizeDeadLetters(rowsDead, { now, dryRun: true }).length, 0, "S5③ 显式 dryRun:true 亦零写入");

		// ③ 显式落盘：target-gone + terminalReason/terminalAt + journal 审计行
		const journal = join(ROOT, "s5-events.jsonl");
		const done = finalizeDeadLetters(rowsDead, { now, dryRun: false, journalPath: journal });
		assert.equal(done.length, 2, "S5④ dryRun:false ⇒ 落盘 2 封");
		const letters = listLetters(to, undefined, mailDir);
		const got = letters.filter((l) => l.status === "target-gone");
		assert.equal(got.length, 2, "S5④ 两封都是 target-gone 终态");
		assert.ok(got.every((l) => typeof l.terminalReason === "string" && l.terminalReason.includes("target-gone")), "S5④ 每封带 terminalReason（R-2）");
		assert.ok(got.every((l) => typeof l.terminalAt === "string"), "S5④ 每封带 terminalAt");
		assert.ok(existsSync(journal), "S5④ journal 审计行已写");
		const jlines = readFileSync(journal, "utf8").split("\n").filter((l) => l.length > 0);
		assert.equal(jlines.length, 2, "S5④ journal 恰好 2 条 message.target-gone");
		assert.ok(jlines.every((l) => l.includes("message.target-gone")), "S5④ journal 行类型正确");
		assert.ok(jlines.every((l) => l.includes("target-gone(")), "S5④ journal 行带判据 reason");

		// ④ 幂等：再落一次不重复（终态不可再迁移）
		const again = finalizeDeadLetters(rowsDead, { now: now + 1000, dryRun: false, journalPath: journal });
		assert.equal(again.length, 0, "S5⑤ 已终态 ⇒ 二次落盘零命中（幂等）");
		// ⑤ 终态后不再进 backlog / 不再被扫描为死信
		assert.equal(findDeadLetters({ mailboxDir: mailDir, probe: probeByLetter, now: now + 2000 }).length, 0,
			"S5⑥ 落终态后不再入死信清单（幂等稳态）");
		ok("S5 P-2：判据矩阵（dead/alive/unknown/未超龄/claimed 窗口）+ 默认干跑零写入 + 显式落盘 target-gone/journal/幂等");
	}

	// ── S6：R-2 纪律的结构性断言（终态记录必带 reason + leaseOwner）────
	{
		const dir = join(ROOT, "delivery-s6");
		mkdirSync(dir, { recursive: true });
		const rec = { id: "run_s6", status: "completed", endedAt: iso(NOW), result: { status: "completed", text: "ok" } };
		const { event } = ensureEvent(dir, {
			runId: "run_s6", terminalRevision: terminalRevisionOf(rec), terminalSnapshotPath: join(ROOT, "x.json"),
			dispatcherSessionId: "sess", observedAt: iso(NOW), terminalAt: iso(NOW),
		});
		const attempt: DeliveryAttempt = {
			attemptId: "a1", channel: "A", at: iso(NOW), status: "unconfirmed",
			leaseOwner: "MB:10248", leaseUntil: iso(NOW + 15_000),
		};
		recordAttempt(dir, event.eventId, attempt);
		const wrote = finalizeExpiredLease(dir, event.eventId, attempt, NOW + 60_000);
		assert.equal(wrote, true, "S6 首次落终态成功");
		const fin = listAttempts(dir, event.eventId).at(-1)!;
		assert.equal(fin.status, EXPIRED_DEAD_OWNER);
		assert.equal(fin.leaseOwner, "MB:10248", "S6 终态记录保留 leaseOwner（可审计「谁的租约被判死」）");
		assert.equal(fin.leaseUntil, iso(NOW + 15_000), "S6 终态记录保留原 leaseUntil（判据要素）");
		assert.ok(fin.reason!.includes("leaseOwner=MB:10248"), "S6 reason 含 leaseOwner");
		assert.ok(fin.reason!.includes("leaseUntil="), "S6 reason 含 leaseUntil");
		assert.equal(fin.finalizedAt, iso(NOW + 60_000), "S6 有 finalizedAt（区分原 attempt 时刻与落终态时刻）");
		// 幂等（wx）
		assert.equal(finalizeExpiredLease(dir, event.eventId, attempt, NOW + 61_000), false, "S6 二次落终态幂等（wx 不覆盖）");
		// reason 纯函数与判据同源（不会漂移）
		assert.ok(staleLeaseReason(attempt, NOW + 60_000).includes("pid=10248"), "S6 staleLeaseReason 与判据同源");
		ok("S6 R-2：终态记录带 reason + leaseOwner + leaseUntil + finalizedAt；落终态幂等");
	}

	// ── S9：租约终态**不得取消期限升级**（2026-11-03 L4 审查实测驱动）───────
	// 旧顺序：`expired_dead_lease` 在 deadline 检查之前短路 ⇒ 落终态后「不再补投 + 期限到也不发
	// incident」 ⇒ 漏发不可见（违反 AGENTS.md R-5「宁可重发不可漏发」+ R-2「静默失效不可接受」）。
	{
		const g = group("s9");
		writeRun(g.runsDir, "run_s9_dead", NOW);
		await reconcileOnce({
			runsDir: g.runsDir, deliverDir: g.deliverDir, now: NOW + 30_000,
			resolveDispatcher: () => "sess_s9", deliver: () => "sent",
			staleLeaseFinalize: true, isPidAlive: () => false,
		});
		const ev = listEvents(g.deliverDir, 100).find((e) => e.runId === "run_s9_dead")!;
		recordAttempt(g.deliverDir, ev.eventId, {
			attemptId: `${ev.eventId}@MB@dead9`, channel: "A", at: iso(NOW + 31_000),
			status: "unconfirmed", leaseOwner: "MB:10248", leaseUntil: iso(NOW + 32_000),
		});
		const att0 = listAttempts(g.deliverDir, ev.eventId);
		void att0;
		// 触发落终态（判据真的跑一遍 ⇒ 盘上出现 EXPIRED_DEAD_OWNER 记录）
		await reconcileOnce({
			runsDir: g.runsDir, deliverDir: g.deliverDir, now: NOW + 40_000,
			resolveDispatcher: () => "sess_s9", deliver: () => "sent",
			staleLeaseFinalize: true, isPidAlive: () => false,
		});
		const att = listAttempts(g.deliverDir, ev.eventId);
		assert.ok(att.some((a) => a.status === EXPIRED_DEAD_OWNER), "S9 前置：租约终态已落盘");
		const view = effectiveStageOf({ event: ev, attempts: att, acks: [] }, { incidentId: ev.incidentId, incidentAt: ev.incidentAt }, NOW + 40_000);
		assert.equal(view.stage, "expired_dead_lease", "S9 前置：已落租约终态");
		const dPre = reconcileDecision(ev, view, att, NOW + 40_000, { staleLease: () => EXPIRED_DEAD_OWNER });
		assert.equal(dPre.action, "none", "S9① 期限未到 + 已终态 ⇒ 不再补投（降噪目标不变）");
		// P0-a（2026-11-24）：60s 只是观测期限 ⇒ S9② 的断点必须用**判死期限**
		const dPost = reconcileDecision(ev, view, att, NOW + DELIVERY_FAIL_DEADLINE_MS + 1_000, { staleLease: () => EXPIRED_DEAD_OWNER });
		assert.equal(dPost.action, "fail_delivery", "S9② 判死期限已到 ⇒ 必须升级 fail_delivery（旧顺序在此返回 none = 静默漏发）");
		// 反例（P0-a 新增）：过观测期限但未到判死期限 ⇒ 仍不得升级（期限分级不得被这条路径绕过）
		assert.equal(
			reconcileDecision(ev, view, att, NOW + DELIVERY_DEADLINE_MS + 1_000, { staleLease: () => EXPIRED_DEAD_OWNER }).action,
			"none",
			"S9②-b 过 60s 观测期限不判死（仍然是 none：租约终态不再补投，但也不升级）",
		);
		// 接线：reconcileOnce 在判死期限后真的发 incident（不是只看纯函数）
		const r2 = await reconcileOnce({
			runsDir: g.runsDir, deliverDir: g.deliverDir, now: NOW + DELIVERY_FAIL_DEADLINE_MS + 1_000,
			resolveDispatcher: () => "sess_s9", deliver: () => "sent",
			staleLeaseFinalize: true, isPidAlive: () => false,
		});
		assert.ok(r2.results.some((x) => x.stage === "failed_delivery"), "S9③ reconcileOnce 接线：期限到 ⇒ stage=failed_delivery");
		const inc = listOpenIncidents(g.deliverDir).filter((i) => i.eventId === ev.eventId);
		assert.ok(inc.length >= 1, "S9④ incident 真的发布（漏发不得静默，R-2）");
		ok("S9 租约终态不取消期限升级（期限前停投 / 期限后升级 + 发 incident）");
	}

	// ── S10：写失败必须被如实上报（2026-11-03 L4 第 2 轮实测驱动）────────────
	// 注入面实测（不是猜）：
	//   plans/_probe_rodir.mjs ⇒ Windows 只读目录**不**阻止建文件（CREATE_OK）
	//   plans/_probe_notdir.mjs ⇒ 父级是文件时 openSync(`${file}/sub/x.json`) = **ENOENT**
	// ⇒ 真写失败用「父级是文件」；目录占位在 Windows 得到的是 EEXIST（幂等命中，不是失败）。
	{
		const dir = join(ROOT, "delivery-s10");
		mkdirSync(dir, { recursive: true });
		const rec = { id: "run_s10", status: "completed", endedAt: iso(NOW), result: { status: "completed", text: "ok" } };
		const { event } = ensureEvent(dir, {
			runId: "run_s10", terminalRevision: terminalRevisionOf(rec), terminalSnapshotPath: join(ROOT, "x.json"),
			dispatcherSessionId: "sess", observedAt: iso(NOW), terminalAt: iso(NOW),
		});
		const attempt: DeliveryAttempt = {
			attemptId: "a10", channel: "A", at: iso(NOW), status: "unconfirmed",
			leaseOwner: "MB:10248", leaseUntil: iso(NOW + 15_000),
		};
		assert.equal(recordAttempt(dir, event.eventId, attempt), "written", "S10① 正常写入 ⇒ written");
		assert.equal(recordAttempt(dir, event.eventId, attempt), "exists", "S10② 重复写 ⇒ exists（幂等命中，不是失败）");
		const asFile = join(ROOT, "s10-not-a-dir");
		writeFileSync(asFile, "x", "utf8");
		const nested = join(asFile, "delivery");
		assert.equal(recordAttempt(nested, event.eventId, { ...attempt, attemptId: "a10-fail" }), "failed", "S10③ 真写失败（ENOENT 形状）⇒ failed");
		assert.equal(finalizeExpiredLease(nested, event.eventId, attempt, NOW + 60_000), false, "S10④ 写失败 ⇒ finalizeExpiredLease 不得报成功");

		// **接线层反例（L4 第 2 轮给的真实入口形状）**：终态写入被占 ⇒ 必须零审计、不报终态。
		const g = group("s10w");
		writeRun(g.runsDir, "run_s10w", NOW);
		const { eventId: evId, attemptId: mbAttempt } = seedLeaseAttempt(g.deliverDir, "run_s10w", {
			leaseOwner: "MB:10248", leaseUntil: NOW + 5_000, at: NOW + 1_000,
		});
		// 先把终态目标路径造成目录 ⇒ openSync(wx) 命中 EEXIST ⇒ 写入不落盘
		const blocked = join(g.deliverDir, `${eventFileKey(evId)}.attempt.${encodeURIComponent(`${mbAttempt}@${EXPIRED_DEAD_OWNER}`)}.json`);
		mkdirSync(blocked, { recursive: true });
		let audits = 0;
		const res10 = await reconcileOnce({
			runsDir: g.runsDir, deliverDir: g.deliverDir, now: NOW + 40_000,
			resolveDispatcher: () => "sess_s10w", deliver: () => "sent",
			staleLeaseFinalize: true, isPidAlive: () => false,
			onExpiredLease: () => { audits += 1; },
		});
		assert.ok(audits === 0, `S10⑤ 写入未落盘 ⇒ 审计必须零调用（实得 ${audits}）`);
		assert.ok(!res10.results.some((x) => x.stage === "expired_dead_lease"), "S10⑥ 未落盘 ⇒ 不得报 stage=expired_dead_lease");
		assert.ok(!listAttempts(g.deliverDir, evId).some((a) => a.status === EXPIRED_DEAD_OWNER), "S10⑦ 盘上确实没有终态记录（与报告一致）");
		ok("S10 三态口径（written/exists/failed）+ 写失败零审计零虚假终态（函数层与接线层各自反例）");
	}

	// ── S11：P-3 不得被「明确未投递」耗尽（2026-11-03 L4 第 2 轮实测驱动）──
	{
		const g = group("s11");
		writeRun(g.runsDir, "run_s11", NOW);
		seedLeaseAttempt(g.deliverDir, "run_s11", { leaseOwner: "A:1111", leaseUntil: NOW + 5_000, at: NOW + 1_000, status: "unconfirmed", channel: "A" });
		// 两次 B 投递均**失败**（没投出去 ⇒ 不应占额度），然后期限内必须还能重试
		let delivered = 0;
		const call = async (now: number, fail: boolean): Promise<string> => {
			const rr = await reconcileOnce({
				runsDir: g.runsDir, deliverDir: g.deliverDir, now,
				resolveDispatcher: () => "sess_s11",
				deliver: () => { delivered += 1; if (fail) throw new Error("inject-fail"); return "sent"; },
				isPidAlive: () => true, // P-1 不介入（租约持有者活）
			});
			return rr.results[0]?.action ?? "none";
		};
		assert.equal(await call(NOW + 21_000, true), "retry", "S11① 首投（A 未确认）⇒ retry");
		assert.equal(await call(NOW + 37_000, true), "retry", "S11② 第 1 次 B 失败后，期限内**必须还能重试**（旧版在此已耗尽额度 ⇒ 静默等 deadline）");
		assert.equal(await call(NOW + 53_000, false), "retry", "S11③ 第 2 次 B 失败后，期限内仍还能重试");
		const act4 = await call(NOW + 59_000, false);
		assert.ok(act4 === "retry" || act4 === "none", `S11④ 已产生 2 次可见播发后不再无限重投（实得 ${act4}）`);
		const capAttempts = listAttempts(g.deliverDir, listEvents(g.deliverDir, 100).find((e) => e.runId === "run_s11")!.eventId);
		const visible = capAttempts.filter((a) => a.channel === "B" && a.status === "sent").length;
		assert.ok(visible <= MAX_B_RETRIES_PER_EVENT, `S11⑤ 可见播发（sent）不超上限（实得 ${visible}/${MAX_B_RETRIES_PER_EVENT}）`);
		void delivered;
		ok("S11 P-3 只计可见播发：failed/no-injector 不占额度，期限内可恢复重投");
	}

	// ── S12：`reconcileEvent`（ledger 自己的对账入口）写失败同样不得报终态 ───
	// 覆盖理由（AGENTS.md §4）：生产有两处消费 finalize（`delivery-reconciler.ts` 与
	// `delivery-ledger.ts::reconcileEvent`），S10 只拓到前者 ⇒ 变异后者会存活。
	{
		const g = group("s12");
		writeRun(g.runsDir, "run_s12", NOW);
		const { eventId: evId, attemptId: mbAttempt } = seedLeaseAttempt(g.deliverDir, "run_s12", {
			leaseOwner: "MB:20480", leaseUntil: NOW + 5_000, at: NOW + 1_000,
		});
		const blocked = join(g.deliverDir, `${eventFileKey(evId)}.attempt.${encodeURIComponent(`${mbAttempt}@${EXPIRED_DEAD_OWNER}`)}.json`);
		mkdirSync(blocked, { recursive: true }); // 终态写入必失败（Windows: openSync(wx) → EEXIST）
		const ev = listEvents(g.deliverDir, 100).find((e) => e.runId === "run_s12")!;
		let audits = 0;
		const out = await reconcileEvent(g.deliverDir, ev, NOW + 40_000, {
			deliver: () => "sent",
			staleLease: (a: DeliveryAttempt) => staleLeaseVerdict(a, { now: NOW + 40_000, isPidAlive: () => false }),
			onExpiredLease: () => { audits += 1; },
		});
		assert.ok(audits === 0, `S12① 写入未落盘 ⇒ 审计零调用（实得 ${audits}）`);
		assert.notEqual(out.stage, "expired_dead_lease", `S12② 未落盘 ⇒ 不得报终态 stage（实得 ${out.stage}）`);
		assert.ok(out.action.reason.includes("write-failed"), `S12③ reason 必须带 write-failed（实得 ${out.action.reason}）`);
		assert.ok(!listAttempts(g.deliverDir, evId).some((a) => a.status === EXPIRED_DEAD_OWNER), "S12④ 盘上无终态记录（与报告一致）");
		ok("S12 reconcileEvent 路径同样盘上事实驱动（零审计零虚假终态 + reason 带 write-failed）");
	}

	console.log(`\n_test_delivery_stale: all ${n} groups passed`);
} finally {
	rmSync(ROOT, { recursive: true, force: true });
}
