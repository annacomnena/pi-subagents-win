/**
 * _test_steer_idle_wake.ts — 「空闲 tab 投递死角」修复的单元测试
 *
 * 背景（2026-10-26 实测事故）：
 *   `tab-steer` 只把记录写进 steering 队列，消费发生在**活跃 turn 的 tool 边界**。
 *   目标 tab 若空闲（`turn=idle`，例如 `pi -r` 重开或已回完上一轮）⇒ 没有 turn ⇒
 *   永远没有 tool 边界 ⇒ 记录**永久 pending**；而账本 `lastActivityAt`/`heartbeatAt`
 *   仍在刷新 ⇒ `targetTabAlive` 判「活」⇒ sweep 也不置 undelivered。
 *   实测：一条消息 pending 超 1 小时，pid 早已死亡，主会话得到「已投递」的假象。
 *
 * 修复：目标 alive 但无活跃 turn 时，往它的 timer 邮箱丢**立即到期**的 nudge，
 * 由目标自己的 pump 起 turn 后消费队列。本测试锁定：
 *   1. `tabNeedsIdleWake` 的判据边界（idle/unknown 需唤醒；working/terminal/无账本不唤醒）
 *   2. `dropIdleWakeNudge` 落盘的是**合法 TimerRecord**（过 validateTimerRecord）
 *   3. **幂等**：已有未消费 nudge 时不重复丢（防 nudge 风暴）
 *   4. 不安全 tabRunId 一律拒绝
 *
 * 全部 IO 落 mkdtempSync 隔离目录；绝不触碰真实 ~/.pi/agent/**。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { STEER_IDLE_NUDGE_MARK, dropIdleWakeNudge, tabNeedsIdleWake } from "./steer-runtime.ts";
import { mailboxDirForTab, validateTimerRecord, type TimerRecord } from "./timers.ts";
import { tabStatePath, type TabState } from "./tab-runs.ts";

const groups: string[] = [];
let passed = 0;
function group(name: string): void {
	groups.push(name);
}
function ok(cond: unknown, msg: string): void {
	assert.ok(cond, msg);
	passed++;
}
function eq<T>(actual: T, expected: T, msg: string): void {
	assert.equal(actual, expected, msg);
	passed++;
}

function withDirs<T>(fn: (dirs: { runsDir: string; timersDir: string }) => T): T {
	const root = mkdtempSync(join(tmpdir(), "steer-idle-wake-"));
	try {
		const runsDir = join(root, "tab-runs");
		const timersDir = join(root, "timers");
		mkdirSync(runsDir, { recursive: true });
		mkdirSync(timersDir, { recursive: true });
		return fn({ runsDir, timersDir });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function seedState(runsDir: string, tabRunId: string, patch: Partial<TabState>): void {
	const now = new Date().toISOString();
	const state = {
		id: tabRunId,
		phase: "waiting",
		turn: "idle",
		terminal: false,
		lastActivityAt: now,
		heartbeatAt: now,
		pid: 4242,
		...patch,
	};
	writeFileSync(tabStatePath(runsDir, tabRunId), JSON.stringify(state), "utf8");
}

// ── 1. tabNeedsIdleWake 判据边界 ────────────────────────────────────────────
group("1 tabNeedsIdleWake 判据");
withDirs(({ runsDir }) => {
	const id = "tab_idle_aaaa";

	seedState(runsDir, id, { turn: "idle", phase: "waiting" });
	const idle = tabNeedsIdleWake(runsDir, id);
	ok(idle.needsWake, "turn=idle ⇒ 需要唤醒（没有 turn 就没有 tool 边界）");
	eq(idle.reason, "turn-idle", "reason 必须是 turn-idle（可归因，不笼统）");

	seedState(runsDir, "tab_work_bbbb", { turn: "working", phase: "working" });
	ok(!tabNeedsIdleWake(runsDir, "tab_work_bbbb").needsWake, "turn=working ⇒ 不需要唤醒（有 tool 边界）");

	seedState(runsDir, "tab_unkn_cccc", { turn: "unknown", phase: "attached" });
	ok(tabNeedsIdleWake(runsDir, "tab_unkn_cccc").needsWake, "turn=unknown ⇒ 需唤醒（不保证会走到边界）");

	seedState(runsDir, "tab_errr_dddd", { turn: "error", phase: "waiting" });
	ok(tabNeedsIdleWake(runsDir, "tab_errr_dddd").needsWake, "turn=error ⇒ 需唤醒");

	seedState(runsDir, "tab_term_eeee", { terminal: true, phase: "completed", turn: "idle" });
	ok(!tabNeedsIdleWake(runsDir, "tab_term_eeee").needsWake, "terminal ⇒ 不唤醒（不向死 tab 丢 nudge）");

	ok(!tabNeedsIdleWake(runsDir, "tab_ghost_ffff").needsWake, "无账本 ⇒ 不唤醒（写前守卫已拒）");

	ok(!tabNeedsIdleWake(runsDir, "../../evil").needsWake, "不安全 id ⇒ 不唤醒");
});

// ── 2. dropIdleWakeNudge 落盘合法 TimerRecord ───────────────────────────────
group("2 dropIdleWakeNudge 落盘");
withDirs(({ timersDir }) => {
	const id = "tab_idle_aaaa";
	const fixed = new Date("2026-10-26T12:00:00.000Z");
	const r = dropIdleWakeNudge(timersDir, id, 2, { now: fixed });
	ok(r.dropped, `应丢出 nudge（reason=${r.reason}）`);
	ok(typeof r.timerId === "string" && r.timerId.startsWith("timer_"), "返回 timerId");

	const box = mailboxDirForTab(timersDir, id);
	const files = readdirSync(box).filter((f) => f.endsWith(".json"));
	eq(files.length, 1, "邮箱里应有且仅有 1 条 timer");

	const raw = JSON.parse(readFileSync(join(box, files[0]), "utf8")) as TimerRecord;
	const check = validateTimerRecord(raw);
	ok(check.ok, `落盘记录必须过 validateTimerRecord（错误：${check.ok ? "" : check.errors.join(";")}）`);
	ok(raw.message.includes(STEER_IDLE_NUDGE_MARK), "消息必须带幂等标记");
	ok(raw.message.includes("2 条"), "消息应反映队列条数（让目标知道有几条）");
	eq(raw.status, "pending", "新 nudge 状态 pending");
	eq(raw.source, "tab-steer:idle-wake", "source 可归因");
	eq(raw.dueAt, fixed.toISOString(), "dueAt 必须≈现在（立即到期，delay=0）");
	eq((raw.target as { tabRunId?: string }).tabRunId, id, "target 指向该 tab 邮箱");
});

// ── 3. 幂等：已有未消费 nudge 不重复丢 ──────────────────────────────────────
group("3 nudge 幂等");
withDirs(({ timersDir }) => {
	const id = "tab_idle_aaaa";
	ok(dropIdleWakeNudge(timersDir, id, 1).dropped, "首次丢成功");
	const second = dropIdleWakeNudge(timersDir, id, 1);
	ok(!second.dropped, "第二次必须不丢");
	eq(second.reason, "nudge-already-pending", "理由必须是 nudge-already-pending（防风暴）");
	const files = readdirSync(mailboxDirForTab(timersDir, id)).filter((f) => f.endsWith(".json"));
	eq(files.length, 1, "邮箱里仍只有 1 条（没有风暴）");
});

// ── 4. 不安全 id ────────────────────────────────────────────────────────────
group("4 不安全 id 拒绝");
withDirs(({ timersDir }) => {
	const r = dropIdleWakeNudge(timersDir, "../../evil", 1);
	ok(!r.dropped, "路径穿越 id 必须拒绝");
	eq(r.reason, "unsafe-id", "理由 unsafe-id");
});

// ── 汇总 ────────────────────────────────────────────────────────────────────
console.log(`[steer-idle-wake] ${groups.length} groups / ${passed} assertions passed`);
console.log(`  ${groups.join(" | ")}`);
