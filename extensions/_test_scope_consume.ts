/**
 * _test_scope_consume.ts — 0926 P1：消费侧就绪证据 + 注册入口收拢（stub 级，进常规回归）
 *
 * 覆盖（隔离 PI_RUNTIME_DIR；spawn 全程注入桩，**不真开 WT tab、不真 spawn 任何进程**）：
 *
 *   1  scope-consume 纯库：读写/原子/never-throw/scopeKey 净化/坏盘面容忍读。
 *   2  judgeConsumeFresh 全 reason（missing/identity-mismatch/old-generation/stale/ok）+ freshMs 可注入。
 *   3  **注册不写证据**：activateScopeConsumption 成功 ≠ 能消费，首个 tick 才出现（astra 第 2 条）。
 *   4  tick 写证据：fire 与 no-fire 都写；tickCount 单调；lastFireAt/lastClaimedCount；
 *      lastTickReason 可解释（no-mail / fired / cutover-off …）——受阻不靠人巡视 PID。
 *   5  注册收拢幂等：同 scope+身份再激活 → alreadyRunning 零第二个 interval；
 *      同 scope 新 owner/新代 → stoppedOld，同一时刻恒至多一个有效消费者。
 *   6  tick 自检：所有权/代次变化 → 循环自停 + 出表，旧代不再写证据（旧代进展不证明新代就绪）。
 *   7  attach 路径（与 session_start 共用同一入口 + lastScopeWiring）→ 不重启会话也有消费循环。
 *   8  证据**不并入 scope-liveness**（liveness 文件不被 tick 覆写；session-hooks/liveness 零引用）。
 *   9  disposer 停掉本 wiring 启动的 handle。
 *
 * 运行：npm run test:local-master-consumption（= test:scope-consume）
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "runtime-scope-consume-env-"));
delete process.env.PI_SUBAGENT;
delete process.env.PI_TAB_RUN_ID;
const RUNTIME = process.env.PI_RUNTIME_DIR!;
const STATE = join(RUNTIME, "state");

import { masterAddress, type ObjectAddress } from "./runtime/address.ts";
import { readAttachment, setCutover } from "./runtime/registry.ts";
import { deliverLetter, listLetters, newMessageId } from "./runtime/mailbox.ts";
import { readScopeLiveness, writeScopeLiveness } from "./runtime/liveness.ts";
import { localMasterAddress, localMasterScope, silentScopeGenesis, takeoverStaleScopeOwner } from "./runtime/scope.ts";
import type { MessageFrame } from "./runtime/protocol.ts";
import {
	activateScopeConsumption,
	deactivateScopeConsumption,
	listActiveScopeConsumers,
	registerScopeWakeLoop,
	type ScopeWakeLoopWiring,
} from "./mailbox-consumer.ts";
import {
	CONSUME_FRESH_MS,
	consumeEvidencePath,
	judgeConsumeFresh,
	readConsumeEvidence,
	recordConsumeTick,
	type ScopeConsumeEvidence,
} from "./runtime/scope-consume.ts";

let n = 0;
const ok = (name: string): void => {
	n++;
	console.log(`ok ${n} - ${name}`);
};

const cleanups: string[] = [];
function cleanupAll(): void {
	for (const dir of cleanups.splice(0)) {
		try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
	}
	try { rmSync(RUNTIME, { recursive: true, force: true }); } catch { /* best-effort */ }
}
process.on("exit", cleanupAll);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** 必死 pid（Windows pid 恒为偶数/4 的倍数且 < 此值；kill 非 EPERM 一律判死）。 */
const DEAD_PID = 999_999_999;

/** 每用例独立 scope（basename 恒唯一）。 */
function mkCwd(): string {
	const dir = mkdtempSync(join(tmpdir(), "sc-cwd-"));
	cleanups.push(dir);
	return dir;
}

async function waitUntil(cond: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
	const t0 = Date.now();
	while (!cond()) {
		if (Date.now() - t0 > timeoutMs) throw new Error(`waitUntil 超时：${what}`);
		await sleep(10);
	}
}

function wakeLetter(to: ObjectAddress): MessageFrame {
	return {
		frame: "message",
		id: newMessageId(),
		kind: "ESCALATION",
		from: masterAddress(),
		to,
		subject: "task://scope-consume-probe",
		requiresAck: true,
		sentAt: new Date().toISOString(),
		body: { summary: "scope consume probe" },
	};
}

function wiringOf(spawn: ScopeWakeLoopWiring["spawn"], extra: Partial<ScopeWakeLoopWiring> = {}): ScopeWakeLoopWiring {
	return { intervalMs: 40, spawn, ...extra };
}

const evOf = (scope: string): ScopeConsumeEvidence | null => readConsumeEvidence(scope, { stateDir: STATE });

// ══════════════════════════════════════════════════════════════════
// 1 — 纯库读写：原子写、never-throw、scopeKey 净化、坏盘面容忍读
// ══════════════════════════════════════════════════════════════════
{
	const scope = "纯 scope/路径*净化";
	const rec = recordConsumeTick({ scope, sessionId: "s1", generation: 2, lastTickReason: "no-mail" }, { stateDir: STATE });
	assert.ok(rec, "写入成功");
	assert.equal(rec!.tickCount, 1);
	assert.equal(rec!.version, 1);
	assert.equal(rec!.scope, scope, "scope 原样存（路径层净化）");
	assert.ok(consumeEvidencePath(scope, STATE).includes("scope-consume"));
	assert.ok(!consumeEvidencePath(scope, STATE).split(/[\\/]/).pop()!.includes("*"), "路径非法字符净化");
	const back = readConsumeEvidence(scope, { stateDir: STATE });
	assert.deepEqual(back, rec, "读回一致");
	// 同身份续写：tickCount 单调
	const rec2 = recordConsumeTick({ scope, sessionId: "s1", generation: 2, lastTickReason: "fired", lastFireAt: "2026-09-26T00:00:00.000Z", lastClaimedCount: 3 }, { stateDir: STATE });
	assert.equal(rec2!.tickCount, 2, "同身份 tickCount 递增");
	assert.equal(rec2!.lastFireAt, "2026-09-26T00:00:00.000Z");
	assert.equal(rec2!.lastClaimedCount, 3);
	// 身份变化：重置为 1（旧代进展不累积进新代）
	const rec3 = recordConsumeTick({ scope, sessionId: "s1", generation: 3, lastTickReason: "no-mail" }, { stateDir: STATE });
	assert.equal(rec3!.tickCount, 1, "新代 tickCount 重置");
	assert.equal(rec3!.lastFireAt, undefined, "旧代 lastFireAt 不带入新代");
	// never-throw：stateDir 落在文件上（ENOTDIR）→ null，不抛
	const bad = mkdtempSync(join(tmpdir(), "sc-bad-"));
	cleanups.push(bad);
	const badFile = join(bad, "not-a-dir");
	writeFileSync(badFile, "x", "utf8");
	assert.equal(recordConsumeTick({ scope: "s", sessionId: "s", generation: 1, lastTickReason: "no-mail" }, { stateDir: badFile }), null, "写失败返回 null 不抛");
	// 容忍读：坏 JSON / 关键字段缺失 → null
	const p = consumeEvidencePath("broken", STATE);
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, "{not json", "utf8");
	assert.equal(readConsumeEvidence("broken", { stateDir: STATE }), null, "坏 JSON → null");
	assert.equal(readConsumeEvidence("no-such-scope", { stateDir: STATE }), null, "缺席 → null");
	ok("1 scope-consume 纯库（原子写 / never-throw / 净化 / 容忍读 / 身份重置）");
}

// ══════════════════════════════════════════════════════════════════
// 2 — judgeConsumeFresh 全 reason + freshMs 注入（阈值不硬编码）
// ══════════════════════════════════════════════════════════════════
{
	const nowMs = Date.parse("2026-09-26T12:00:00.000Z");
	const ev: ScopeConsumeEvidence = { version: 1, scope: "s", sessionId: "A", generation: 5, lastTickAt: "2026-09-26T11:59:50.000Z", pid: 1, lastTickReason: "no-mail", tickCount: 9 };
	const base = { sessionId: "A", generation: 5, nowMs };
	assert.deepEqual(judgeConsumeFresh(ev, base), { fresh: true, reason: "ok" });
	assert.deepEqual(judgeConsumeFresh(null, base), { fresh: false, reason: "missing" });
	assert.equal(judgeConsumeFresh({ ...ev, sessionId: "B" }, base).reason, "identity-mismatch");
	assert.equal(judgeConsumeFresh({ ...ev, generation: 4 }, base).reason, "old-generation");
	assert.equal(judgeConsumeFresh({ ...ev, lastTickAt: "2026-09-26T11:58:00.000Z" }, base).reason, "stale", "超过 90s → stale");
	assert.equal(judgeConsumeFresh({ ...ev, lastTickAt: "2026-09-26T11:58:00.000Z" }, { ...base, freshMs: 300_000 }).fresh, true, "freshMs 可注入");
	assert.equal(judgeConsumeFresh({ ...ev, lastTickAt: "not-a-date" }, base).reason, "stale", "坏时间戳按 stale（不猜）");
	assert.equal(CONSUME_FRESH_MS, 90_000);
	ok("2 judgeConsumeFresh 五种 reason + freshMs 可注入");
}

// ══════════════════════════════════════════════════════════════════
// 3+4 — 注册不写证据；首个 tick 才写；fire/no-fire 都写；reason 可解释
// ══════════════════════════════════════════════════════════════════
{
	setCutover(true, "scope-consume-test");
	const cwd = mkCwd();
	const scope = localMasterScope(cwd);
	const addr = localMasterAddress(scope);
	assert.equal(silentScopeGenesis("sess_sc1", cwd).outcome, "attached");
	const spawned: string[] = [];
	// 证据单独落一份隔离 liveness（用于第 8 组比对）
	writeScopeLiveness({ scopeKey: scope, sessionId: "sess_sc1", generation: 1, pid: process.pid });
	const lvPath = join(STATE, "scope-liveness", `${scope}.json`);
	const lvBefore = readFileSync(lvPath, "utf8");

	const r = activateScopeConsumption({
		sessionId: "sess_sc1",
		cwd,
		wiring: wiringOf((d) => {
			spawned.push(d.scope);
			return "tab_sc1";
		}),
	});
	assert.equal(r.activated, true);
	if (r.activated) {
		assert.equal(r.scope, scope);
		assert.equal(r.generation, 1);
		assert.equal(r.alreadyRunning, false, "首次激活");
		assert.equal(r.stoppedOld, false);
	}
	// **注册时绝不写证据**（变异 2 守卫：把证据写挪进 activate 就红）
	assert.equal(evOf(scope), null, "activateScopeConsumption 成功 ≠ 能消费：注册时证据必须为 null");
	assert.equal(listActiveScopeConsumers().filter((c) => c.scope === scope).length, 1);

	// 首个 tick（无信）→ no-fire 也写
	await waitUntil(() => evOf(scope) !== null, "首个 tick 证据出现");
	const t1 = evOf(scope)!;
	assert.equal(t1.tickCount, 1);
	assert.equal(t1.sessionId, "sess_sc1");
	assert.equal(t1.generation, 1);
	assert.equal(t1.pid, process.pid, "证据 pid = tick 所在进程");
	assert.equal(t1.lastTickReason, "no-mail", "无信 → no-mail（可解释）");
	assert.ok(Date.now() - Date.parse(t1.lastTickAt) < 10_000, "lastTickAt 新鲜");
	assert.equal(t1.lastFireAt, undefined);

	// fire：投 wake 信 → 下一 tick claim+spawn + lastFireAt/lastClaimedCount
	deliverLetter(wakeLetter(addr));
	await waitUntil(() => evOf(scope)?.lastFireAt !== undefined, "fire 证据出现");
	const t2 = evOf(scope)!;
	assert.equal(t2.lastTickReason, "fired", "fire tick 的 reason = fired");
	assert.equal(t2.lastClaimedCount, 1, "claim 信数");
	assert.ok(t2.lastFireAt);
	assert.ok(t2.tickCount > 1, "tickCount 单调推进");
	assert.equal(spawned.length, 1, "spawn 恰一次（claim 屏障）");
	assert.equal(listLetters(addr, "pending").length, 0, "信被 claim（不再 pending）");
	// 写手唯一：liveness 文件逐字节不变（证据**不并入** scope-liveness；变异 6 守卫）
	assert.equal(readFileSync(lvPath, "utf8"), lvBefore, "tick 不覆写 scope-liveness（无双写手）");
	const lv = readScopeLiveness(scope, STATE);
	assert.equal(lv?.sessionId, "sess_sc1", "liveness 仍是 agent 钩子的记录");
	ok("3 注册不写证据 + tick 证据（fire/no-fire 都写、字段齐全、liveness 不被覆写）");

	// 4 —— 受阻可解释（F1 半 stub）：cutover 关 → lastTickReason=cutover-off，证据仍 fresh
	setCutover(false, "scope-consume-off");
	await waitUntil(() => evOf(scope)?.lastTickReason === "cutover-off", "cutover-off reason");
	const blocked = evOf(scope)!;
	assert.equal(blocked.tickCount > t2.tickCount, true, "循环仍活着（在推进）");
	assert.equal(judgeConsumeFresh(blocked, { sessionId: "sess_sc1", generation: 1, nowMs: Date.now() }).fresh, true, "证据仍 fresh（消费者存活）");
	assert.equal(listActiveScopeConsumers().filter((c) => c.scope === scope).length, 1);
	setCutover(true, "scope-consume-test");
	deactivateScopeConsumption(scope, "test-done");
	assert.equal(listActiveScopeConsumers().filter((c) => c.scope === scope).length, 0, "deactivate 出表");
	ok("4 受阻解释：cutover-off 直接写进 lastTickReason（不靠人工巡视 PID）");
}

// ══════════════════════════════════════════════════════════════════
// 5 — 幂等与单消费者：同身份再激活 alreadyRunning；新代 stoppedOld
// ══════════════════════════════════════════════════════════════════
{
	setCutover(true, "scope-consume-test");
	const cwd = mkCwd();
	const scope = localMasterScope(cwd);
	assert.equal(silentScopeGenesis("sess_sc2", cwd).outcome, "attached");
	let spawns = 0;
	const wiring = wiringOf(() => `tab_sc2_${++spawns}`);
	const r1 = activateScopeConsumption({ sessionId: "sess_sc2", cwd, wiring });
	assert.equal(r1.activated && r1.alreadyRunning, false, "首次激活");
	const r2 = activateScopeConsumption({ sessionId: "sess_sc2", cwd, wiring });
	assert.deepEqual(r2, { activated: true, scope, sessionId: "sess_sc2", generation: 1, alreadyRunning: true, stoppedOld: false }, "同 scope+身份再激活 → 幂等（零第二个 interval）");
	assert.equal(listActiveScopeConsumers().filter((c) => c.scope === scope).length, 1, "恒至多一个有效消费者");

	// 单循环推进速率（interval 40ms × 400ms ≈ 10 次；若起了第二个循环会接近 20）
	await waitUntil(() => (evOf(scope)?.tickCount ?? 0) >= 3, "推进 3 tick");
	const before = evOf(scope)!.tickCount;
	await sleep(400);
	const after = evOf(scope)!.tickCount;
	assert.ok(after - before <= 15, `单一消费者（400ms 增量=${after - before}，双循环会翻倍）`);

	// ownership transfer：旧 owner pid 死 → 新会话按既有 stale 判据接管（gen+1），
	// 再激活 = 停旧起新（stoppedOld）——同一时刻该 scope 恒至多一个消费者。
	writeScopeLiveness({ scopeKey: scope, sessionId: "sess_sc2", generation: 1, pid: DEAD_PID });
	const takeover = takeoverStaleScopeOwner("sess_sc3", cwd);
	assert.equal(takeover.outcome, "took-over", `接管应成功，实际=${JSON.stringify(takeover)}`);
	const attAfter = readAttachment(localMasterAddress(scope))!;
	assert.equal(attAfter.sessionId, "sess_sc3");
	assert.ok(attAfter.generation >= 2, `generation 前进（gen=${attAfter.generation}）`);
	const frozen = evOf(scope)!.tickCount;
	const r3 = activateScopeConsumption({ sessionId: "sess_sc3", cwd, wiring });
	assert.equal(r3.activated && r3.stoppedOld, true, "新 owner 激活 → 先停旧循环");
	if (r3.activated) assert.equal(r3.alreadyRunning, false);
	const entries = listActiveScopeConsumers().filter((c) => c.scope === scope);
	assert.equal(entries.length, 1, "同一时刻该 scope 恒至多一个消费者");
	assert.equal(entries[0]!.sessionId, "sess_sc3", "表里只剩新 owner");
	// 旧 owner 的循环已停：证据改由新 owner 重新计数写入
	await waitUntil(() => evOf(scope)?.sessionId === "sess_sc3", "新代证据写入");
	const evAfter = evOf(scope)!;
	assert.equal(evAfter.generation, attAfter.generation, "证据代次对齐新 owner");
	assert.ok(evAfter.tickCount >= 1 && evAfter.tickCount < frozen + 5, "新代从 1 重新累计（旧代进展不累积）");
	// 旧代证据（即使 lastTickAt 是当下）也不能证明新代就绪：
	//  · 属于**别的会话** → identity-mismatch（接管后旧 owner 的证据）
	//  · 属于**同会话旧代** → old-generation（同会话代次前进，如重 attach）
	const staleOldOwner = judgeConsumeFresh(
		{ version: 1, scope, sessionId: "sess_sc2", generation: 1, lastTickAt: new Date().toISOString(), pid: 1, lastTickReason: "fired", tickCount: 9 },
		{ sessionId: attAfter.sessionId, generation: attAfter.generation, nowMs: Date.now() },
	);
	assert.deepEqual(staleOldOwner, { fresh: false, reason: "identity-mismatch" }, "旧 owner 的证据不能证明新代就绪");
	const staleOldGen = judgeConsumeFresh(
		{ version: 1, scope, sessionId: attAfter.sessionId, generation: attAfter.generation - 1, lastTickAt: new Date().toISOString(), pid: 1, lastTickReason: "fired", tickCount: 9 },
		{ sessionId: attAfter.sessionId, generation: attAfter.generation, nowMs: Date.now() },
	);
	assert.deepEqual(staleOldGen, { fresh: false, reason: "old-generation" }, "同会话旧代证据不能证明新代就绪");
	deactivateScopeConsumption(scope, "test-done");
	ok("5 注册收拢幂等：alreadyRunning / stoppedOld / 恒单消费者 / 旧代不算数");
}

// ══════════════════════════════════════════════════════════════════
// 6 — tick 自检：所有权失效/代次变化 → 停自己 + 出表 + 不再写证据
// ══════════════════════════════════════════════════════════════════
{
	setCutover(true, "scope-consume-test");
	const cwd = mkCwd();
	const scope = localMasterScope(cwd);
	assert.equal(silentScopeGenesis("sess_sc4", cwd).outcome, "attached");
	const spawned: string[] = [];
	activateScopeConsumption({ sessionId: "sess_sc4", cwd, wiring: wiringOf((d) => { spawned.push(d.scope); return "tab_sc4"; }) });
	await waitUntil(() => (evOf(scope)?.tickCount ?? 0) >= 2, "自检前推进");
	const gen4 = evOf(scope)!;

	// 所有权失效（另一会话按既有 stale 判据接管，gen+1）→ 下一 tick 自检停循环
	writeScopeLiveness({ scopeKey: scope, sessionId: "sess_sc4", generation: 1, pid: DEAD_PID });
	const took = takeoverStaleScopeOwner("sess_sc5", cwd);
	assert.equal(took.outcome, "took-over", `接管应成功，实际=${JSON.stringify(took)}`);
	const newGen = readAttachment(localMasterAddress(scope))!.generation;
	assert.ok(newGen > gen4.generation, "代次已变");
	await waitUntil(() => listActiveScopeConsumers().filter((c) => c.scope === scope).length === 0, "旧循环自检出表");
	const afterStop = evOf(scope)!;
	assert.equal(afterStop.generation, gen4.generation, "自检后**不再写证据**（旧代停笔）");
	assert.equal(afterStop.sessionId, "sess_sc4", "盘上证据仍属旧代");
	// 冻结：等待多个 tick 周期，tickCount 不再增长
	await sleep(200);
	assert.equal(evOf(scope)!.tickCount, afterStop.tickCount, "停表后零推进");
	// 旧代证据对新 owner 不算数
	const fresh = judgeConsumeFresh(evOf(scope), { sessionId: "sess_sc5", generation: newGen, nowMs: Date.now() });
	assert.equal(fresh.fresh, false, "旧代证据不能证明新代就绪");
	assert.ok(fresh.reason === "old-generation" || fresh.reason === "identity-mismatch", `reason=${fresh.reason}`);
	ok("6 tick 自检：所有权/代次变化自停 + 旧代证据不再更新");
}

// ══════════════════════════════════════════════════════════════════
// 7 — attach 路径（与 session_start 共用同一入口；不重启会话也拿到消费循环）
// ══════════════════════════════════════════════════════════════════
{
	setCutover(true, "scope-consume-test");
	const cwd = mkCwd();
	const scope = localMasterScope(cwd);
	const addr = localMasterAddress(scope);
	assert.equal(silentScopeGenesis("sess_sc6", cwd).outcome, "attached");
	const spawned: string[] = [];
	// 生产形态：registerScopeWakeLoop 登记 wiring（本用例不触发 session_start，模拟"会话早已启动"）
	const handlers: Array<() => void> = [];
	const pi = { on: (_e: string, cb: () => void) => { handlers.push(cb); } };
	const stop = registerScopeWakeLoop(pi as never, { cwd, intervalMs: 40, spawn: (d) => { spawned.push(`${d.scope}`); return "tab_sc6"; } });
	assert.equal(handlers.length, 1, "session_start 已接线");

	// attach 入口形态：**不带 wiring**（取本进程最近一次登记的 wiring）——即 master-tools/index.ts 那一行
	const r = activateScopeConsumption({ sessionId: "sess_sc6", cwd });
	assert.equal(r.activated, true, "attach 路径复用同一激活入口");
	assert.equal(evOf(scope), null, "激活仍不写证据");
	// 幂等：再调一次（模拟两入口/双击）→ alreadyRunning、零第二个循环
	const r2 = activateScopeConsumption({ sessionId: "sess_sc6", cwd });
	assert.equal(r2.activated && r2.alreadyRunning, true);
	assert.equal(listActiveScopeConsumers().filter((c) => c.scope === scope).length, 1);

	// 消费循环真的在跑：投信 → claim+spawn（不重启会话也收到信）
	deliverLetter(wakeLetter(addr));
	await waitUntil(() => spawned.length >= 1, "attach 后消费循环生效");
	assert.equal(listLetters(addr, "pending").length, 0, "信被 claim（不出现貌似健康却永久 pending）");
	await waitUntil(() => evOf(scope)?.lastFireAt !== undefined, "证据写入 fire");
	assert.equal(evOf(scope)!.sessionId, "sess_sc6");

	// 非 owner 不激活（脑裂防线语义不变）
	const other = activateScopeConsumption({ sessionId: "sess_not_owner", cwd });
	assert.deepEqual(other, { activated: false, scope, reason: "not-owner" });
	assert.equal(listActiveScopeConsumers().filter((c) => c.scope === scope).length, 1, "非 owner 零动作");
	// 身份/接线缺失的受控降级
	assert.deepEqual(activateScopeConsumption({ sessionId: "unknown", cwd }), { activated: false, reason: "bad-session" });
	assert.deepEqual(activateScopeConsumption({ sessionId: "sess_sc6", cwd: "" }), { activated: false, reason: "no-cwd" });
	stop();
	assert.equal(listActiveScopeConsumers().filter((c) => c.scope === scope).length, 0, "disposer 停掉本 wiring 的 handle");
	const frozen = evOf(scope)!.tickCount;
	await sleep(120);
	assert.equal(evOf(scope)!.tickCount, frozen, "disposer 后零推进");
	ok("7 attach 路径复用同一入口（不重启会话即有消费循环）+ 受控降级 + disposer");
}

// ══════════════════════════════════════════════════════════════════
// 8 — 静态边界：证据不扩 scope-liveness / session-hooks 零改动引用
// ══════════════════════════════════════════════════════════════════
{
	const here = import.meta.dirname;
	const livenessSrc = readFileSync(join(here, "runtime", "liveness.ts"), "utf8");
	const hooksSrc = readFileSync(join(here, "session-hooks.ts"), "utf8");
	const scopeSrc = readFileSync(join(here, "runtime", "scope.ts"), "utf8");
	assert.ok(!livenessSrc.includes("scope-consume"), "liveness.ts 不引用 scope-consume（不扩 scope-liveness）");
	assert.ok(!hooksSrc.includes("scope-consume"), "session-hooks.ts 不引用 scope-consume（主会话普通活动不能替代消费证据）");
	assert.ok(!scopeSrc.includes("scope-consume"), "scope.ts（takeover 判据）不引用 scope-consume（新证据不进接管判据）");
	assert.ok(!livenessSrc.includes("recordConsumeTick"), "liveness.ts 无第二写手");
	ok("8 静态边界：证据独立文件、不进 takeover/liveness/hooks");
}

cleanupAll();
console.log(`_test_scope_consume: all assertions passed (${n} groups)`);
