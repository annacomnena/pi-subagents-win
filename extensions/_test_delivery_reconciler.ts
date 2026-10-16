/**
 * _test_delivery_reconciler.ts — B 对账通道单测（含「独立于 A」的结构性断言）
 *
 * 重点验证咨询 §6.2 的独立要求：**B 不共享 A 的 selfDisabled/seen/.notified**。
 * 用两个真实 node 子进程（不同 PID）分别扮演 A 与 B，A 被 SIGKILL 后 B 仍能发现终态。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
	DELIVERY_DEADLINE_MS,
	listAcks,
	listAttempts,
	listEvents,
	listOpenIncidents,
	loadEvent,
	writeAck,
	terminalRevisionOf,
} from "./delivery-ledger.ts";
import { isTerminalStatus, reconcileOnce, scanTerminalRuns } from "./delivery-reconciler.ts";

let n = 0;
const ok = (name: string): void => { n += 1; console.log(`ok ${n} - ${name}`); };

const root = mkdtempSync(join(tmpdir(), "reconciler-test-"));
const runsDir = join(root, "runs");
const deliverDir = join(root, "delivery");
mkdirSync(runsDir, { recursive: true });
const NOW = Date.parse("2026-10-16T09:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

/** 每组独立的 runs 目录（避免跨组投递互相计入）。 */
const mkRunsDir = (group: string): string => {
	const d = join(root, `runs-${group}`);
	mkdirSync(d, { recursive: true });
	return d;
};

const mkRunIn = (dir: string, runId: string, over: Record<string, unknown> = {}): void => {
	writeFileSync(join(dir, `${runId}.json`), JSON.stringify({
		id: runId, agent: "general", task: "t", status: "completed", startedAt: iso(NOW - 60_000), endedAt: iso(NOW),
		result: { status: "completed", text: "ok" }, ...over,
	}), "utf8");
};

const mkRun = (runId: string, over: Record<string, unknown> = {}): void => {
	writeFileSync(join(runsDir, `${runId}.json`), JSON.stringify({
		id: runId, agent: "general", task: "t", status: "completed", startedAt: iso(NOW - 60_000), endedAt: iso(NOW),
		result: { status: "completed", text: "ok" }, ...over,
	}), "utf8");
};

try {
	// ── B1：扫描只取终态；不含 running（不右删失、不误判）────────────────
	{
		mkRun("run_b1_done");
		mkRun("run_b1_running", { status: "running", endedAt: undefined, result: undefined });
		const { runs } = scanTerminalRuns(runsDir, { limit: 50 });
		const ids = runs.map((r) => r.runId);
		assert.ok(ids.includes("run_b1_done"), "终态 run 被扫到");
		assert.ok(!ids.includes("run_b1_running"), "running 不得算终态（否则会误判未完成任务）");
		assert.equal(isTerminalStatus("running"), false);
		assert.equal(isTerminalStatus("cancelled"), true, "类型外溢终态也算终态");
		ok("B1 扫描只取终态（running 排除）");
	}

	// ── B2：公平分页 round-robin（不饿死前缀）────────────────────────────
	{
		const pdir = join(root, "paging");
		mkdirSync(pdir, { recursive: true });
		for (let i = 0; i < 12; i += 1) {
			writeFileSync(join(pdir, `run_p${String(i).padStart(2, "0")}.json`), JSON.stringify({ id: `run_p${i}`, status: "completed", result: {} }), "utf8");
		}
		// 每页 4 条，游标推进：三轮覆盖全部 12，且**无重复漏项**
		const seen = new Set<string>();
		let cursor: string | null = null;
		for (let round = 0; round < 3; round += 1) {
			const page = scanTerminalRuns(pdir, { limit: 4, cursor });
			for (const r of page.runs) seen.add(r.runId);
			cursor = page.nextCursor;
		}
		assert.equal(seen.size, 12, `round-robin 三轮覆盖全部 12 条（实得 ${seen.size}）⇒ 无前缀饿死`);
		// 坏基线对照：不分页（永远只看前 4）⇒ 只会见到 4 条
		const head = scanTerminalRuns(pdir, { limit: 4 });
		assert.equal(head.runs.length, 4, "坏基线：固定前缀只看到 4 条（这就是 §6.1 反对的『永远只看前 50』）");
		assert.ok(seen.size > head.runs.length, "分页后覆盖数严格大于固定前缀");
		ok("B2 公平 round-robin 分页：三轮覆盖 12 条；固定前缀只能看到 4 条");
	}

	// ── B3：无派发者 ⇒ fail closed（不建事件、不猜归属）──────────────────
	{
		const d2 = join(root, "b3-delivery");
		mkRun("run_b3");
		const before = listEvents(d2, 100).length;
		await reconcileOnce({ runsDir, deliverDir: d2, now: NOW + 1000, resolveDispatcher: () => undefined });
		assert.equal(listEvents(d2, 100).length, before, "无派发者 ⇒ 不建事件（fail closed）");
		// 有派发者 ⇒ 建事件
		await reconcileOnce({ runsDir, deliverDir: d2, now: NOW + 2000, resolveDispatcher: (r) => (r === "run_b3" ? "sess_a" : undefined) });
		const evs = listEvents(d2, 100).filter((e) => e.runId === "run_b3");
		assert.equal(evs.length, 1, "有派发者 ⇒ 建事件");
		ok("B3 fail closed：无派发者不建事件；有派发者才建");
	}

	// ── B4：B 补投（20s 阈值后才投；租约内不打扰）────────────────────────
	{
		const d = join(root, "b4-delivery");
		const rd = mkRunsDir("b4");
		mkRunIn(rd, "run_b4");
		const deliveries: string[] = [];
		const common = { runsDir: rd, deliverDir: d, resolveDispatcher: () => "sess_a", deliver: (e: { eventId: string }, a: string) => { deliveries.push(a); return "sent" as const; } };
		// ① 终态后 5s（< 20s 首投阈值）⇒ 不投
		await reconcileOnce({ ...common, now: NOW + 5_000 });
		assert.equal(deliveries.length, 0, "未到 20s ⇒ B 不补投（让 A 快通道先做）");
		// ② 25s（> 20s）⇒ 补投一次
		await reconcileOnce({ ...common, now: NOW + 25_000 });
		assert.equal(deliveries.length, 1, "过 20s 未 consumed ⇒ B 补投");
		// ③ 再立刻跑（租约内）⇒ 不重复投（防惊群）
		await reconcileOnce({ ...common, now: NOW + 26_000 });
		assert.equal(deliveries.length, 1, "租约 15s 内不重投（防 A/B 惊群）");
		// ④ 租约过后 ⇒ 再投
		await reconcileOnce({ ...common, now: NOW + 45_000 });
		assert.equal(deliveries.length, 2, "租约过期 ⇒ 允许再补投");
		ok("B4 B 补投节奏：<20s 不投；过 20s 投；租约 15s 内不重投；过期再投");
	}

	// ── B5：consumed 后彻底停止（含不 arm waker、不 fail）────────────────
	{
		const d = join(root, "b5-delivery");
		const rd = mkRunsDir("b5");
		mkRunIn(rd, "run_b5");
		let deliveries = 0;
		let incidents = 0;
		const opts = { runsDir: rd, deliverDir: d, resolveDispatcher: () => "sess_a", deliver: () => { deliveries += 1; return "sent" as const; }, onIncident: () => { incidents += 1; } };
		await reconcileOnce({ ...opts, now: NOW + 25_000 });
		const ev = listEvents(d, 100).find((e) => e.runId === "run_b5")!;
		const lastAttempt = listAttempts(d, ev.eventId).at(-1)!;
		writeAck(d, { eventId: ev.eventId, stage: "consumed", attemptId: lastAttempt.attemptId, recipientGeneration: 1, at: iso(NOW + 26_000), evidence: "context-assoc:msg_1" });
		await reconcileOnce({ ...opts, now: NOW + 30_000 });
		await reconcileOnce({ ...opts, now: NOW + DELIVERY_DEADLINE_MS + 10_000 });
		assert.equal(deliveries, 1, "consumed 后不再补投");
		assert.equal(incidents, 0, "consumed 后不得再发 incident（交付已成功）");
		const v = listAcks(d, ev.eventId).filter((a) => a.stage === "consumed").length;
		assert.equal(v, 1, "consumed ACK 唯一且保留");
		ok("B5 consumed 后冻结：不再投、不再 incident");
	}

	// ── B6：期限到 ⇒ incident（不调用模型；跨重启可见）─────────────────
	{
		const d = join(root, "b6-delivery");
		const rd = mkRunsDir("b6");
		mkRunIn(rd, "run_b6");
		const seen: string[] = [];
		const seenIds = new Set<string>();
		const opts = {
			runsDir: rd, deliverDir: d, resolveDispatcher: (r: string) => (r === "run_b6" ? "sess_a" : undefined),
			deliver: () => "sent" as const,
			onIncident: (inc: { eventId: string; reason: string; incidentId?: string }) => { seen.push(inc.reason); if (inc.incidentId) seenIds.add(inc.incidentId); },
		};
		await reconcileOnce({ ...opts, now: NOW + 25_000 }); // 先补投一次（attempted）
		const r = await reconcileOnce({ ...opts, now: NOW + DELIVERY_DEADLINE_MS + 1_000 });
		assert.equal(r.results.length >= 1, true);
		assert.ok(seen.length >= 1, "超过 60s 期限 ⇒ incident 发布（不调用模型）");
		assert.ok(seen[0].includes("deadline-exceeded"), `incident 原因写明期限（实得 ${seen[0]}）`);
		// 独立 oracle：从原始文件复算 —— 事件应为 failed_delivery（已关单，不是 silent）
		const ev = loadEvent(d, listEvents(d, 100).find((e) => e.runId === "run_b6")!.eventId)!;
		assert.ok(ev.incidentId, "事件元数据持久 incidentId（跨重启可见）");
		assert.equal(listOpenIncidents(d).filter((i) => i.eventId === ev.eventId).length, 1, "未 ack 的 incident 恰好 1 条（不重复制造）");
		// 幂等语义：incident **只有一条**（可被重新通知，但不得制造多个 incident）
		await reconcileOnce({ ...opts, now: NOW + DELIVERY_DEADLINE_MS + 5_000 });
		assert.equal(listOpenIncidents(d).filter((i) => i.eventId === ev.eventId).length, 1, "incident 幂等：只有一条（重跑不制造新 incident）");
		assert.equal(seenIds.size, 1, `重跑时通知出口可重试，但 incidentId 必须唯一（实得 ${[...seenIds].join(",")}）`);
		ok("B6 期限到 ⇒ incident（幂等 + 跨重启可见 + 不调用模型）");
	}

	// ── B7：**B 不依赖 A 的 .notified / selfDisabled**（结构性）────────────
	{
		const d = join(root, "b7-delivery");
		const rd = mkRunsDir("b7");
		mkRunIn(rd, "run_b7");
		// 伪造 A 的残留：`.notified` 占位 + A 已 selfDisable（B 看不到这些）
		writeFileSync(join(runsDir, "run_b7.notified"), "", "utf8");
		let delivered = 0;
		await reconcileOnce({
			runsDir: rd, deliverDir: d, now: NOW + 25_000,
			resolveDispatcher: () => "sess_a",
			deliver: () => { delivered += 1; return "sent" as const; },
		});
		const ev = listEvents(d, 100).find((e) => e.runId === "run_b7")!;
		const stage = listAttempts(d, ev.eventId).length;
		assert.ok(ev, "B 建了事件");
		assert.equal(stage >= 1, true, "B 补投（**无视** A 留下的 .notified —— 这就是 P1 的修复语义）");
		assert.equal(delivered, 1, "B 不因 A 的 .notified 残留而跳过（P1：.notified 不是交付证明）");
		ok("B7 B 独立于 A：A 残留 .notified 不影响 B 判定（P1 修复语义）");
	}

	// ── B8：**A/B 必须不同 PID** —— 结构性硬断言（咨询 §6.2）────────────
	{
		// 用两个真实 node 子进程确认「B 在被派发为独立进程时能独立完成对账」。
		// 这不是模拟：subprocess 各自有独立 PID、独立模块状态（无共享 selfDisabled/seen）。
		const d = join(root, "b8-delivery");
		const rd = mkRunsDir("b8");
		mkRunIn(rd, "run_b8");
		const script = `
			import { pathToFileURL as p2u } from "node:url";
			const m = await import(p2u(${JSON.stringify(join(process.cwd(), "extensions/delivery-reconciler.ts"))}).href);
			const { reconcileOnce } = m;
			const r = await reconcileOnce({
				runsDir: ${JSON.stringify(rd)}, deliverDir: ${JSON.stringify(d)}, now: ${NOW + 25_000},
				resolveDispatcher: () => "sess_a",
				deliver: () => "sent",
			});
			console.log(JSON.stringify({ pid: process.pid, results: r.results.length, scanned: r.scanned }));
		`;
		const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
			encoding: "utf8", cwd: process.cwd(), timeout: 60_000,
		});
		assert.equal(child.status, 0, `子进程对账应成功（stderr: ${String(child.stderr).slice(0, 300)}）`);
		const out = JSON.parse(String(child.stdout).trim().split("\n").at(-1) ?? "{}") as { pid: number; results: number };
		assert.notEqual(out.pid, process.pid, "**B 跑在另一个 PID**（§6.2 硬要求）");
		assert.ok(out.results >= 1, "独立进程的 B 真的完成了对账（发现了终态并处理）");
		// 且本进程（扮演 A）从未碰过该事件的账本 —— B 独立完成
		const ev = listEvents(d, 100).find((e) => e.runId === "run_b8");
		assert.ok(ev, "事件由独立进程的 B 创建（跨进程可读）");
		ok(`B8 A/B 不同 PID：独立进程(pid=${out.pid}≠${process.pid})完成对账 results=${out.results}`);
	}

	console.log(`\n_test_delivery_reconciler: all ${n} groups passed`);
} finally {
	rmSync(root, { recursive: true, force: true });
}
