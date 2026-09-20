/**
 * _test_runtime_wake.ts — Phase 5c 测试（A7 F20 + 仲裁裁决 7 步计划）
 *
 * 覆盖（隔离 stateDir + fake clock，不做真实 spawn）：
 *   0. cutover 缺失 → 零动作零审计
 *   1. 首访 fire + confirm（wake-state/ack/审计 wake.spawn/prompt 约束）
 *   2. cooldown 内 → skip；过 cooldown 无新信 → no-mail（ack 已收尾为证）
 *   3. maxSpawns 滚动 cap（超限恒审计，不改 status）
 *   4. paused 跳过 + 恢复；non-owner 空转
 *   5. in-flight（无终态年轻 dispatch 等；result 落盘解锁；orphaned 可重生）
 *   6. debounce（新信顺延，过窗 fire）
 *
 * 运行：npm run test:runtime-wake
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "runtime-wake-env-"));
const RUNTIME = process.env.PI_RUNTIME_DIR!;
const STATE = join(RUNTIME, "state");
const MAILBOX = join(RUNTIME, "mailbox");
const RUNS = join(RUNTIME, "tab-runs");

import { masterAddress, workstreamAddress } from "./runtime/address.ts";
import { newEnvelopeId } from "./runtime/ids.ts";
import { attachMaster, setCutover } from "./runtime/registry.ts";
import { deliverCommand, deliverLetter, listLetters } from "./runtime/mailbox.ts";
import { newCommandFrame, newMessageFrame } from "./runtime/protocol.ts";
import { createWorkstream, listAudit, readWorkstream, updateWorkstream } from "./runtime/workstreams.ts";
import {
	buildWakePrompt,
	confirmWakeSpawn,
	evaluateWakes,
	readWakeState,
} from "./runtime/wake.ts";
import { writeTabDispatch } from "./tab-runs.ts";

const master = masterAddress();
const S = { stateDir: STATE, session: "sess-W" };
const BASE = Date.now();
const iso = (ms: number): string => new Date(ms).toISOString();

function wsLetter(wsId: string, subject: string, atMs: number, summary = "do the thing") {
	return newMessageFrame({
		id: newEnvelopeId("msg"), kind: "REPORT", from: "agent://a", to: workstreamAddress(wsId),
		subject, sentAt: iso(atMs), summary, details: { tabRunId: "t", status: "completed" },
	});
}
function wsInbox(wsId: string): number {
	return listLetters(workstreamAddress(wsId), "pending", MAILBOX).length;
}

try {
	// ── 0. cutover 缺失 → 零动作零审计 ─────────────────────────────
	{
		const r = evaluateWakes({ ...S, mailboxDir: MAILBOX, runsDir: RUNS, sessionId: "sess-W", now: BASE });
		assert.deepEqual(r, [], "未切换零动作");
		assert.equal(listAudit(STATE).length, 0, "零审计");
	}
	setCutover(true, "test");
	attachMaster({ sessionId: "sess-W" });

	// ── 1. 首访 fire + confirm ─────────────────────────────────────
	const ws = createWorkstream({
		...S, mission: "wake 演练流",
		wakePolicy: { enabled: true, cooldownMs: 60_000, maxSpawns: 2 },
	});
	deliverLetter(wsLetter(ws.id, "run://tab/tab_w1", BASE - 5000), { mailboxDir: MAILBOX });
	let fireTab = "";
	{
		const [d] = evaluateWakes({ ...S, mailboxDir: MAILBOX, runsDir: RUNS, sessionId: "sess-W", now: BASE });
		assert.equal(d.fire, true);
		assert.equal(d.letters.length, 1);
		assert.ok(d.prompt!.includes(ws.id), "prompt 带 workstream 身份");
		assert.ok(d.prompt!.includes("tab-finish"), "prompt 强制有终态");
		assert.ok(d.prompt!.includes("timer"), "prompt 禁自续命");
		fireTab = "tab_wake_1";
		confirmWakeSpawn(ws.id, fireTab, { stateDir: STATE, mailboxDir: MAILBOX, sessionId: "sess-W", now: BASE });
		const st = readWakeState(ws.id, STATE);
		assert.equal(st.lastTabRunId, fireTab);
		assert.equal(st.spawnAt.length, 1);
		assert.equal(wsInbox(ws.id), 0, "确认后信已 ack");
		const ops = listAudit(STATE).map((e) => e.op);
		assert.ok(ops.includes("wake.spawn"), "spawn 落账");
	}

	// ── 2. cooldown 内 skip；过窗无新信 → no-mail ───────────────────
	{
		const [d] = evaluateWakes({ ...S, mailboxDir: MAILBOX, runsDir: RUNS, sessionId: "sess-W", now: BASE + 1000 });
		assert.equal(d.fire, false);
		assert.equal(d.reason, "cooldown");
		const [d2] = evaluateWakes({ ...S, mailboxDir: MAILBOX, runsDir: RUNS, sessionId: "sess-W", now: BASE + 61_000 });
		assert.equal(d2.fire, false);
		assert.equal(d2.reason, "no-mail", "acked 信不重触发");
	}

	// ── 3. maxSpawns 滚动 cap ──────────────────────────────────────
	{
		deliverLetter(wsLetter(ws.id, "run://tab/tab_w2", BASE + 61_000), { mailboxDir: MAILBOX });
		const [d] = evaluateWakes({ ...S, mailboxDir: MAILBOX, runsDir: RUNS, sessionId: "sess-W", now: BASE + 62_000 });
		assert.equal(d.fire, true, "第 2 次（1<2）");
		confirmWakeSpawn(ws.id, "tab_wake_2", { stateDir: STATE, mailboxDir: MAILBOX, sessionId: "sess-W", now: BASE + 62_000 });
		deliverLetter(wsLetter(ws.id, "run://tab/tab_w3", BASE + 63_000), { mailboxDir: MAILBOX });
		const [d3] = evaluateWakes({ ...S, mailboxDir: MAILBOX, runsDir: RUNS, sessionId: "sess-W", now: BASE + 124_000 });
		assert.equal(d3.fire, false);
		assert.equal(d3.reason, "capped", "第 3 次超限（2>=2）");
		assert.equal(readWorkstream(ws.id, STATE)!.status, "active", "超限不改 status（用户意图）");
		assert.ok(listAudit(STATE).some((e) => e.op === "wake.capped"), "cap 恒审计");
	}

	// ── 4. paused 跳过 + 恢复；non-owner 空转 ───────────────────────
	{
		updateWorkstream(ws.id, { ...S, status: "paused" });
		const [d] = evaluateWakes({ ...S, mailboxDir: MAILBOX, runsDir: RUNS, sessionId: "sess-W", now: BASE + 200_000 });
		assert.equal(d.fire, false);
		assert.equal(d.reason, "paused");
		updateWorkstream(ws.id, { ...S, status: "active" });
		const other = evaluateWakes({ ...S, mailboxDir: MAILBOX, runsDir: RUNS, sessionId: "sess-X", now: BASE + 200_000 });
		assert.deepEqual(other, [], "非 owner 空转");
	}

	// ── 5. in-flight：年轻 dispatch 等；result 解锁；orphaned 重生 ───
	{
		const ws2 = createWorkstream({ ...S, mission: "在飞流", wakePolicy: { enabled: true, cooldownMs: 1000 } });
		deliverLetter(wsLetter(ws2.id, "run://tab/tab_f1", BASE + 300_000), { mailboxDir: MAILBOX });
		const d = evaluateWakes({ ...S, mailboxDir: MAILBOX, runsDir: RUNS, sessionId: "sess-W", now: BASE + 301_000 }).find((x) => x.workstreamId === ws2.id)!;
		assert.equal(d.fire, true);
		confirmWakeSpawn(ws2.id, "tab_fly_1", { stateDir: STATE, mailboxDir: MAILBOX, sessionId: "sess-W", now: BASE + 301_000 });
		// 年轻 dispatch（无 result）→ 在飞
		const { mkdirSync } = await import("node:fs");
		mkdirSync(RUNS, { recursive: true });
		writeTabDispatch(RUNS, {
			id: "tab_fly_1", version: 1, taskId: "1", mode: "workflow", title: "fly",
			cwd: "C:/x", dispatchedAt: iso(BASE + 301_000), dispatchStatus: "dispatched",
		});
		deliverLetter(wsLetter(ws2.id, "run://tab/tab_f2", BASE + 302_000), { mailboxDir: MAILBOX });
		const d2 = evaluateWakes({ ...S, mailboxDir: MAILBOX, runsDir: RUNS, sessionId: "sess-W", now: BASE + 303_000 }).find((x) => x.workstreamId === ws2.id)!;
		assert.equal(d2.fire, false);
		assert.equal(d2.reason, "in-flight");
		// result 落盘 → 解锁
		writeFileSync(join(RUNS, "tab_fly_1.result.json"), JSON.stringify({ id: "tab_fly_1", status: "completed", finishedAt: iso(BASE + 304_000) }), "utf8");
		const d3 = evaluateWakes({ ...S, mailboxDir: MAILBOX, runsDir: RUNS, sessionId: "sess-W", now: BASE + 305_000 }).find((x) => x.workstreamId === ws2.id)!;
		assert.equal(d3.fire, true, "终态解锁");
		confirmWakeSpawn(ws2.id, "tab_fly_2", { stateDir: STATE, mailboxDir: MAILBOX, sessionId: "sess-W", now: BASE + 305_000 });
		// orphaned（tab_fly_2 无 dispatch/终态记录）→ 可重生（at-least-once）
		deliverLetter(wsLetter(ws2.id, "run://tab/tab_f3", BASE + 306_000), { mailboxDir: MAILBOX });
		const d4 = evaluateWakes({ ...S, mailboxDir: MAILBOX, runsDir: RUNS, sessionId: "sess-W", now: BASE + 400_000 }).find((x) => x.workstreamId === ws2.id)!;
		assert.equal(d4.fire, true, "orphaned tab 不锁 wake");
	}

	// ── 6. debounce ────────────────────────────────────────────────
	{
		const ws3 = createWorkstream({ ...S, mission: "防抖流", wakePolicy: { enabled: true, cooldownMs: 1000, debounceMs: 60_000 } });
		deliverLetter(wsLetter(ws3.id, "run://tab/tab_d1", BASE + 500_000), { mailboxDir: MAILBOX });
		const d = evaluateWakes({ ...S, mailboxDir: MAILBOX, runsDir: RUNS, sessionId: "sess-W", now: BASE + 510_000 }).find((x) => x.workstreamId === ws3.id)!;
		assert.equal(d.fire, false);
		assert.equal(d.reason, "debounced", "新信顺延一 tick");
		const d2 = evaluateWakes({ ...S, mailboxDir: MAILBOX, runsDir: RUNS, sessionId: "sess-W", now: BASE + 561_000 }).find((x) => x.workstreamId === ws3.id)!;
		assert.equal(d2.fire, true, "过窗 fire");
	}

	// ── 7. command 信同样触发（含 agent.wake）───────────────────────
	{
		const ws4 = createWorkstream({ ...S, mission: "命令触发流", wakePolicy: { enabled: true, cooldownMs: 1000 } });
		deliverCommand(
			newCommandFrame({ type: "agent.wake", to: workstreamAddress(ws4.id), issuedBy: "agent://a", commandKey: "wake:ws4", issuedAt: iso(BASE + 600_000) }),
			{ mailboxDir: MAILBOX },
		);
		const all = evaluateWakes({ ...S, mailboxDir: MAILBOX, runsDir: RUNS, sessionId: "sess-W", now: BASE + 601_000 });
		const mine = all.find((x) => x.workstreamId === ws4.id);
		assert.ok(mine && mine.fire, "command 信触发 wake");
		assert.ok(mine.letters[0]!.messageId.startsWith("cmd:"), "command 信标识");
		confirmWakeSpawn(ws4.id, "tab_wake_cmd", { stateDir: STATE, mailboxDir: MAILBOX, sessionId: "sess-W", now: BASE + 601_000 });
		assert.equal(wsInbox(ws4.id), 0, "command 信确认后 ack（ackClaimedBy，不依赖 frame.id）");
	}

	// ── 8. prompt 形状（buildWakePrompt 直测）───────────────────────
	{
		const p = buildWakePrompt(
			{ id: "ws_x", mission: "m", status: "active" } as never,
			[{ messageId: "a", subject: "run://tab/t", summary: "s", sentAt: iso(BASE) }],
		);
		assert.ok(p.includes("Sub-Master") && p.includes("no-op"), "边界写进 prompt");
	}
} finally {
	rmSync(RUNTIME, { recursive: true, force: true });
}

console.log("_test_runtime_wake: all assertions passed");
