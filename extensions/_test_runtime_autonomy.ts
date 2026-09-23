/**
 * _test_runtime_autonomy.ts — Task 2002 · Autonomy Suite v1（纯函数层）验收
 *
 * 覆盖（A1–A11，对应 plans/0923_autonomy_suite_v1_plan.md「测试与验收」）：
 *   A1 配置：normalizeAutonomy 默认/严格 === true/垃圾回落/§27 常数逐字段/awayMode 与 masterSuccession 互不可见；
 *      readAutonomyConfig（缺文件/无 autonomy 键/坏 JSON/根数组 = 默认；有效切片归一）
 *   A2 kill-switch：无文件 null；engage 原子写回读；坏 JSON/缺字段容忍读 null；kill 优先于 enabled:true；
 *      kill 在场时 evaluateWakeGate/evaluateWatchdogChecks 恒 no-wake（即使触发全开）；engage/clear 产审计行；
 *      appendAuditLine never-throw
 *   A3 C5 映射：九种 phase + unknown 逐项固化；waiting/orphaned/unconfirmed 永不 Completed/terminal；
 *      unconfirmed → resultMissing → stagnation 真；attention>0 喂 needs_user；多 tab 变体/终态优先级；
 *      normalizeExactPath tripwire（frontier 本地副本 == recent-scopes 同口径）
 *   A4 九规则：②③ 边沿（可见 + hidden 回填；cancelled/orphaned 不触发）；⑤⑨ 边沿；①⑦ approx 标注且
 *      meaningfulChanges 不计；④⑥⑧ record-only 永不进 triggers（3 条 no-carrier 标记固化）；新项目不触发
 *   A5 首帧基线：prev=null → baseline:true、零触发（防冷启动风暴）
 *   A6 meaningful version：噪声（age/stale 展示文本变化，结构不变）不 bump；②+⑤ 双触发同帧恰 +1（去重）
 *   A7 Wake Gate：空 diff → no-meaningful-change；record-only/approx-only → no-wake；debounce（bypass 同受约束）；
 *      cooldown ordinary；needs_user bypass 穿越 cooldown 但不穿越 kill/debounce；dormant 类（high_risk_failure/
 *      critical_resource_loss）穷举 9 规则显式断言永不匹配；审计行格式
 *   A8 Watchdog：8 项清单固化；1/2/4/6/7 各一真一假；3/8 恒 unknown 且 wakeRecommended 不受 unknown 影响、
 *      审计行列 unknown 名单；7 null=no-liveness→unknown；5 approx 标注；gating 短路全 unknown
 *   A9 cadence：interval 钳制 [2m,60m]；validFor 封顶 6h；垃圾/缺字段 ok:false；缺/空 reason 拒绝；
 *      parseDurationMs（ms/s/m/h/d）
 *   A10 零侵入：extensions/ 下除 autonomy/** 与本文件外无文件 import runtime/autonomy；config.json 无
 *      autonomy 键 → 全默认
 *   A11 污染检查 + collect 装配：temp 注入下 collectAutonomyInputs 只写自有 namespace、两帧基线切换；
 *      真实 ~/.pi/agent/runtime 下无 state/autonomy/ 新增；测试结束 temp 清理
 *
 * 运行：npx tsx extensions/_test_runtime_autonomy.ts
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// 测试隔离：defaultRuntimeDir() 全部走 temp（_test_runtime_master_auto 同款模式）
const ENV_TMP = mkdtempSync(join(tmpdir(), "runtime-autonomy-env-"));
process.env.PI_RUNTIME_DIR = ENV_TMP;

import { DEFAULT_AUTONOMY, defaultAutonomyConfig, normalizeAutonomy, readAutonomyConfig } from "./runtime/autonomy/config.ts";
import { evaluateAutonomyGating, engageKillSwitch, readKillSwitch } from "./runtime/autonomy/kill-switch.ts";
import {
	RECORD_ONLY_NOCARRIER,
	buildFrontier,
	mapPhaseToProjectState,
	normalizeExactPath,
	type FrontierRule,
	type FrontierSnapshot,
	type ProjectFrontier,
} from "./runtime/autonomy/frontier.ts";
import { evaluateWakeGate, type WakeGateState } from "./runtime/autonomy/wake-gate.ts";
import {
	CHECK_NAMES,
	WATCHDOG_HEARTBEAT_STALE_MS,
	evaluateWatchdogChecks,
	parseDurationMs,
	validateWatchdogPlan,
	type WatchdogInputs,
} from "./runtime/autonomy/watchdog.ts";
import {
	appendAuditLine,
	clearKillSwitchAudited,
	collectAutonomyInputs,
	engageKillSwitchAudited,
	readFrontierSnapshot,
} from "./runtime/autonomy/collect.ts";
import { normalizeMasterSuccession } from "./runtime/master-auto.ts";
import { normalizeExactPath as normalizeRecentScope } from "./runtime/recent-scopes.ts";
import type { GlobalViewSnapshot, HiddenTabEntry, RepoRow, TabDetail } from "./runtime/global-view.ts";

// ── 微型 harness ─────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
function check(name: string, fn: () => void): void {
	try {
		fn();
		passed++;
		console.log(`  ✓ ${name}`);
	} catch (e) {
		failed++;
		console.error(`  ✗ ${name}`);
		console.error(`    ${String((e as Error)?.message ?? e)}`);
	}
}

// ── 构造助手（纯手工快照，零 IO）──────────────────────────────────────
const NOW = 1_760_000_000_000; // 固定时钟（ms）
const R1 = "C:/repo/r1"; // 归一化后 = "c:/repo/r1"
const K = "c:/repo/r1";

function makeTab(over: Partial<TabDetail> & { runId: string; repoPath: string; phase: string }): TabDetail {
	return {
		runId: over.runId,
		repoPath: over.repoPath,
		phase: over.phase,
		taskId: over.taskId ?? "t1",
		age: over.age ?? "1m",
		stale: over.stale ?? "unknown",
		staleOver: over.staleOver ?? false,
		stop: over.stop ?? "end_turn",
		artifact: over.artifact ?? "-",
		artifactMtime: over.artifactMtime ?? "?",
		resultMissing: over.resultMissing ?? over.phase === "unconfirmed",
		terminal: over.terminal ?? ["completed", "failed", "cancelled"].includes(over.phase),
		openIssues: over.openIssues ?? null,
		summary: over.summary ?? "",
		needsHuman: over.needsHuman ?? false,
		gate: over.gate ?? "unknown",
		overdue: over.overdue ?? 0,
		pidAlive: over.pidAlive ?? null,
	};
}

function makeRepoRow(repoPath: string, over: Partial<RepoRow> = {}): RepoRow {
	return {
		repoPath,
		display: repoPath.split(/[\\/]/).pop() ?? repoPath,
		local: "unknown",
		branch: "main",
		dirty: "clean",
		tabText: "-",
		tabActive: 0,
		attention: 0,
		timer: 0,
		overdue: 0,
		mail: "p0/c0",
		mailPending: 0,
		plans: "0",
		plansCount: 0,
		lastMs: 0,
		lastText: "?",
		...over,
	};
}

function makeSnapshot(tabs: TabDetail[], over: Partial<GlobalViewSnapshot> = {}): GlobalViewSnapshot {
	return {
		owner: "none",
		generation: "-",
		cutover: "off",
		asof: new Date(NOW).toISOString(),
		reposTotal: 0,
		shown: 0,
		tabsActive: tabs.length,
		timersPending: 0,
		inboxPending: 0,
		inboxClaimed: 0,
		home: {
			repoPath: "__HOME__", display: "HOME", local: "none", branch: "-", dirty: "-", tabText: "-",
			tabActive: 0, attention: 0, timer: 0, overdue: 0, mail: "p0/c0", mailPending: 0,
			plans: "-", plansCount: null, lastMs: 0, lastText: "?",
		},
		rows: [],
		totals: { orphaned: 0, terminal: 0, noResult: 0, attention: 0, gitUnknown: 0, otherMail: 0 },
		warnings: [],
		cursor: { page: 1, pageSize: 20, totalPages: 1 },
		history: [],
		historyTotal: 0,
		partial: false,
		details: tabs,
		diff: { added: [], changed: [], removed: [], note: "none" },
		hygiene: "hygiene: unknown",
		command: "global-view",
		baselinePayload: { savedAt: new Date(NOW).toISOString(), tabs: {}, repos: {} },
		...over,
	};
}

function makeProject(p: Partial<ProjectFrontier> & { project: string }): ProjectFrontier {
	return {
		project: p.project,
		state: p.state ?? "Working",
		variant: p.variant ?? null,
		gate: p.gate ?? "unknown",
		runs: p.runs ?? {},
		needsUser: p.needsUser ?? false,
		resultMissing: p.resultMissing ?? false,
		stagnation: p.stagnation ?? false,
		overdue: p.overdue ?? 0,
		meaningfulStateVersion: p.meaningfulStateVersion ?? 1,
	};
}

function makePrevSnap(asof: number, projects: ProjectFrontier[]): FrontierSnapshot {
	return { asof, projects, triggers: [], baseline: false };
}

// ════════════════════════════ A1 配置 ════════════════════════════
console.log("A1 配置");
check("A1.1 normalizeAutonomy(undefined) = 全默认且 enabled:false", () => {
	assert.deepEqual(normalizeAutonomy(undefined), DEFAULT_AUTONOMY);
	assert.equal(normalizeAutonomy(undefined).enabled, false);
});
check("A1.2 垃圾输入回落全默认（string/null/array/{}）", () => {
	assert.deepEqual(normalizeAutonomy("garbage"), DEFAULT_AUTONOMY);
	assert.deepEqual(normalizeAutonomy(null), DEFAULT_AUTONOMY);
	assert.deepEqual(normalizeAutonomy([]), DEFAULT_AUTONOMY);
	assert.deepEqual(normalizeAutonomy({}), DEFAULT_AUTONOMY);
});
check("A1.3 严格 === true（enabled/awayMode）", () => {
	assert.equal(normalizeAutonomy({ enabled: "true" }).enabled, false);
	assert.equal(normalizeAutonomy({ enabled: 1 }).enabled, false);
	assert.equal(normalizeAutonomy({ enabled: true }).enabled, true);
	assert.equal(normalizeAutonomy({ awayMode: { enabled: "yes" } }).awayMode.enabled, false);
	assert.equal(normalizeAutonomy({ awayMode: { enabled: true } }).awayMode.enabled, true);
});
check("A1.4 垃圾字段逐字段回落；合法值保留", () => {
	const c = normalizeAutonomy({ watchdog: { defaultIntervalMs: 300_000, minIntervalMs: "2m" }, wakeGate: { debounceMs: 0 } });
	assert.equal(c.watchdog.defaultIntervalMs, 300_000); // 合法保留
	assert.equal(c.watchdog.minIntervalMs, 120_000); // "2m" 垃圾 → 默认
	assert.equal(c.watchdog.maxIntervalMs, 3_600_000);
	assert.equal(c.wakeGate.debounceMs, 2_000); // 0 非正 → 默认
	assert.deepEqual(c.strategicReview, DEFAULT_AUTONOMY.strategicReview);
});
check("A1.5 §27 常数逐字段（10m/2m/60m/6h；2h/30m/6h；2s/15s；enabled/awayMode 均 false）", () => {
	assert.deepEqual(DEFAULT_AUTONOMY.watchdog, {
		defaultIntervalMs: 600_000, minIntervalMs: 120_000, maxIntervalMs: 3_600_000, maxOverrideDurationMs: 21_600_000,
	});
	assert.deepEqual(DEFAULT_AUTONOMY.strategicReview, { defaultIntervalMs: 7_200_000, minIntervalMs: 1_800_000, maxIntervalMs: 21_600_000 });
	assert.deepEqual(DEFAULT_AUTONOMY.wakeGate, { debounceMs: 2_000, ordinaryCooldownMs: 15_000 });
	assert.equal(DEFAULT_AUTONOMY.enabled, false);
	assert.equal(DEFAULT_AUTONOMY.awayMode.enabled, false);
});
check("A1.6 awayMode 与 masterSuccession 互不可见（C6 / L1C 未决 #3）", () => {
	assert.deepEqual(normalizeAutonomy({ masterSuccession: { auto: true, enabled: true } }), DEFAULT_AUTONOMY);
	const ms = normalizeMasterSuccession({ autonomy: { enabled: true, awayMode: { enabled: true } } });
	assert.deepEqual(Object.keys(ms).sort(), ["auto", "autoPercent", "enabled", "proposalPercent"]);
	assert.equal(ms.auto, false); // 严格 === true：autonomy 切片不得泄漏影响
	assert.notEqual(defaultAutonomyConfig(), DEFAULT_AUTONOMY); // 每次新对象，防共享引用
});
const cfgRoot = mkdtempSync(join(tmpdir(), "runtime-autonomy-cfg-"));
check("A1.7 readAutonomyConfig：缺文件/无 autonomy 键/坏 JSON/根数组 = 全默认", () => {
	assert.deepEqual(readAutonomyConfig({ configPath: join(cfgRoot, "missing.json") }), DEFAULT_AUTONOMY);
	const noKey = join(cfgRoot, "nokey.json");
	writeFileSync(noKey, JSON.stringify({ masterSuccession: { auto: true } }), "utf8");
	assert.deepEqual(readAutonomyConfig({ configPath: noKey }), DEFAULT_AUTONOMY);
	const bad = join(cfgRoot, "bad.json");
	writeFileSync(bad, "not json", "utf8");
	assert.deepEqual(readAutonomyConfig({ configPath: bad }), DEFAULT_AUTONOMY);
	const arr = join(cfgRoot, "arr.json");
	writeFileSync(arr, "[1,2,3]", "utf8");
	assert.deepEqual(readAutonomyConfig({ configPath: arr }), DEFAULT_AUTONOMY);
});
check("A1.8 readAutonomyConfig：有效 autonomy 切片归一", () => {
	const p = join(cfgRoot, "ok.json");
	writeFileSync(p, JSON.stringify({ autonomy: { enabled: true, wakeGate: { debounceMs: 3_000 } } }), "utf8");
	const c = readAutonomyConfig({ configPath: p });
	assert.equal(c.enabled, true);
	assert.equal(c.wakeGate.debounceMs, 3_000);
	assert.equal(c.wakeGate.ordinaryCooldownMs, 15_000);
	assert.deepEqual(c.watchdog, DEFAULT_AUTONOMY.watchdog);
});

// ════════════════════════════ A2 kill-switch ════════════════════════════
console.log("A2 kill-switch");
const ksRoot = mkdtempSync(join(tmpdir(), "runtime-autonomy-ks-"));
const ksState = join(ksRoot, "state"); // 注入 stateDir（零真实 ~/.pi 污染）
check("A2.1 无文件 = null（容忍读）", () => {
	assert.equal(readKillSwitch({ stateDir: ksState }), null);
});
check("A2.2 engage 原子写 + 回读；坏 JSON/缺字段 = null（不猜）", () => {
	const at = new Date(NOW);
	assert.equal(engageKillSwitch({ reason: "manual-stop", by: "annacomnena" }, { stateDir: ksState, now: at }), true);
	assert.deepEqual(readKillSwitch({ stateDir: ksState }), { version: 1, reason: "manual-stop", at: at.toISOString(), by: "annacomnena" });
	const kp = join(ksState, "autonomy", "kill-switch.json");
	writeFileSync(kp, "{bad json", "utf8");
	assert.equal(readKillSwitch({ stateDir: ksState }), null);
	writeFileSync(kp, JSON.stringify({ version: 1, by: "x" }), "utf8"); // 缺 reason/at
	assert.equal(readKillSwitch({ stateDir: ksState }), null);
	assert.equal(engageKillSwitch({ reason: "manual-stop", by: "annacomnena" }, { stateDir: ksState, now: at }), true); // 恢复
});
check("A2.3 gating：kill 优先于 enabled:true；无 kill 时按配置", () => {
	const kill = readKillSwitch({ stateDir: ksState })!;
	const on = normalizeAutonomy({ enabled: true });
	const g = evaluateAutonomyGating(on, kill);
	assert.equal(g.active, false);
	assert.equal(g.reason, "kill-switch:manual-stop");
	assert.deepEqual(evaluateAutonomyGating(DEFAULT_AUTONOMY, null), { active: false, reason: "autonomy-disabled" });
	assert.deepEqual(evaluateAutonomyGating(on, null), { active: true, reason: "active" });
});
check("A2.4 kill 在场 → evaluateWakeGate/evaluateWatchdogChecks 恒 no-wake（即使触发全开）", () => {
	const gating = { active: false, reason: "kill-switch:manual-stop" };
	const d = evaluateWakeGate({
		gating,
		diff: { triggers: [{ rule: "needs_user", project: K, evidence: "x", approximate: false }], recordOnly: [], meaningfulChanges: 1 },
		state: { lastDecisionAt: null, lastWakeAt: null, batchFirstSeenAt: null },
		cfg: DEFAULT_AUTONOMY.wakeGate,
		now: NOW,
	});
	assert.equal(d.wake, false);
	assert.equal(d.reason, "kill-switch:manual-stop");
	assert.equal(d.auditLine, "wake-gate no-wake reason=kill-switch:manual-stop");
	const w = evaluateWatchdogChecks({
		gating,
		unhandledFrontierDiff: true,
		mailboxBacklogPending: 5,
		stalledProjects: ["a"],
		readyWork: true,
		idleOwnerApprox: true,
		runStateMismatch: [{ runId: "r", phase: "working", pidAlive: false }],
		heartbeatAgeMs: 999_999,
	});
	assert.equal(w.wakeRecommended, false);
});
check("A2.5 engage/clear 产审计行（经 collect 的 appendAuditLine，自有 namespace）", () => {
	const s2 = join(ksRoot, "state2");
	assert.equal(engageKillSwitchAudited({ reason: "drill", by: "test" }, { stateDir: s2, now: new Date(NOW) }), true);
	assert.equal(clearKillSwitchAudited({ stateDir: s2 }), true);
	assert.equal(readKillSwitch({ stateDir: s2 }), null);
	const audit = readFileSync(join(s2, "autonomy", "audit.jsonl"), "utf8").trim().split("\n");
	assert.equal(audit.length, 2);
	assert.equal(audit[0], "kill-switch engage ok=true reason=drill by=test");
	assert.equal(audit[1], "kill-switch clear ok=true");
});
check("A2.6 appendAuditLine never-throw 且只写注入目录", () => {
	assert.doesNotThrow(() => appendAuditLine("test line", { stateDir: join(ksRoot, "deep", "x") }));
	assert.ok(existsSync(join(ksRoot, "deep", "x", "autonomy", "audit.jsonl")));
});
check("A2.7 kill 文件住自有 namespace：stateDir/autonomy/kill-switch.json", () => {
	assert.ok(existsSync(join(ksState, "autonomy", "kill-switch.json")));
});

// ════════════════════════════ A3 C5 映射 ════════════════════════════
console.log("A3 C5 映射");
check("A3.1 九种 phase + unknown 逐项（C5 表固化）", () => {
	assert.deepEqual(mapPhaseToProjectState("completed"), { state: "Completed", variant: null, terminal: true });
	assert.deepEqual(mapPhaseToProjectState("failed"), { state: "Failed", variant: null, terminal: true });
	assert.deepEqual(mapPhaseToProjectState("cancelled"), { state: "Cancelled", variant: null, terminal: true });
	assert.deepEqual(mapPhaseToProjectState("working"), { state: "Working", variant: null, terminal: false });
	assert.deepEqual(mapPhaseToProjectState("attached"), { state: "Working", variant: null, terminal: false });
	assert.deepEqual(mapPhaseToProjectState("dispatched"), { state: "Working", variant: null, terminal: false });
	assert.deepEqual(mapPhaseToProjectState("waiting"), { state: "Working", variant: "waiting", terminal: false });
	assert.deepEqual(mapPhaseToProjectState("orphaned"), { state: "Working", variant: "orphaned", terminal: false });
	assert.deepEqual(mapPhaseToProjectState("unconfirmed"), { state: "Working", variant: "resultMissing", terminal: false });
	// 不在表内（unknown 等）：不猜，绝不 terminal
	assert.equal(mapPhaseToProjectState("unknown").terminal, false);
	assert.equal(mapPhaseToProjectState("weird").state, "Working");
});
check("A3.2 waiting/orphaned/unconfirmed 永不 Completed/terminal", () => {
	for (const ph of ["waiting", "orphaned", "unconfirmed"]) {
		const m = mapPhaseToProjectState(ph);
		assert.notEqual(m.state, "Completed", `${ph} 永不 Completed`);
		assert.equal(m.terminal, false, `${ph} 永不 terminal`);
	}
});
check("A3.3 unconfirmed → resultMissing → stagnation 真（C5 裁定）", () => {
	const { next } = buildFrontier({
		snapshot: makeSnapshot([makeTab({ runId: "r1", repoPath: R1, phase: "unconfirmed", needsHuman: false })]),
		backlog: [],
		prev: null,
		now: NOW,
	});
	const p = next.projects.find((x) => x.project === K)!;
	assert.equal(p.state, "Working");
	assert.equal(p.variant, "resultMissing");
	assert.equal(p.resultMissing, true);
	assert.equal(p.stagnation, true);
});
check("A3.4 仓 attention>0 喂 needs_user（terminal 无 result 可见待审）；无 row 时不猜", () => {
	const tabs = [makeTab({ runId: "r1", repoPath: R1, phase: "unconfirmed", needsHuman: false })];
	const { next } = buildFrontier({ snapshot: makeSnapshot(tabs, { rows: [makeRepoRow(R1, { attention: 1 })] }), backlog: [], prev: null, now: NOW });
	assert.equal(next.projects[0].needsUser, true);
	const { next: n2 } = buildFrontier({ snapshot: makeSnapshot(tabs, { rows: [] }), backlog: [], prev: null, now: NOW });
	assert.equal(n2.projects[0].needsUser, false);
});
check("A3.5 多 tab 变体严重度序（orphaned>resultMissing>waiting）+ 全 terminal 优先级 Failed>Cancelled>Completed", () => {
	const { next } = buildFrontier({
		snapshot: makeSnapshot([
			makeTab({ runId: "a", repoPath: R1, phase: "waiting" }),
			makeTab({ runId: "b", repoPath: R1, phase: "unconfirmed" }),
		]),
		backlog: [], prev: null, now: NOW,
	});
	assert.equal(next.projects[0].state, "Working");
	assert.equal(next.projects[0].variant, "resultMissing");
	const { next: n2 } = buildFrontier({
		snapshot: makeSnapshot([
			makeTab({ runId: "c", repoPath: R1, phase: "completed", resultMissing: true }),
			makeTab({ runId: "d", repoPath: R1, phase: "cancelled", resultMissing: true }),
		]),
		backlog: [], prev: null, now: NOW,
	});
	assert.equal(n2.projects[0].state, "Cancelled");
	const { next: n3 } = buildFrontier({
		snapshot: makeSnapshot([
			makeTab({ runId: "c", repoPath: R1, phase: "completed", resultMissing: true }),
			makeTab({ runId: "e", repoPath: R1, phase: "failed", resultMissing: true }),
		]),
		backlog: [], prev: null, now: NOW,
	});
	assert.equal(n3.projects[0].state, "Failed");
});
check("A3.6 normalizeExactPath tripwire：frontier 本地副本 == recent-scopes 同口径", () => {
	for (const p of ["C:/Repo/R1", "c:/repo/r1/", "C:\\repo\\r1", "/home/u/x", "C:/a/b/C", "c:/A/B/"]) {
		assert.equal(normalizeExactPath(p), normalizeRecentScope(p), p);
	}
});

// ════════════════════════════ A4 九规则 ════════════════════════════
console.log("A4 九规则");
check("A4.1 ② working→completed（同 runId 可见边沿）", () => {
	const prev = makePrevSnap(NOW - 1000, [makeProject({ project: K, state: "Working", runs: { r1: "working" } })]);
	const { next, diff } = buildFrontier({
		snapshot: makeSnapshot([makeTab({ runId: "r1", repoPath: R1, phase: "completed", resultMissing: true, terminal: true })]),
		backlog: [], prev, now: NOW,
	});
	assert.equal(diff.triggers.length, 1);
	assert.deepEqual(diff.triggers[0], { rule: "working_to_completed", project: K, evidence: "run:r1:working→completed", approximate: false });
	assert.equal(diff.meaningfulChanges, 1);
	assert.equal(next.projects[0].state, "Completed");
});
check("A4.2 ② hidden 回填（带 result 的终态被 hidden：history 同 id terminal:completed）", () => {
	const prev = makePrevSnap(NOW - 1000, [makeProject({ project: K, state: "Working", runs: { r1: "working" } })]);
	const hist: HiddenTabEntry[] = [{ id: "r1", repoPath: R1, reason: "terminal:completed", at: new Date(NOW - 500).toISOString() }];
	const { diff } = buildFrontier({ snapshot: makeSnapshot([], { history: hist }), backlog: [], prev, now: NOW });
	assert.equal(diff.triggers.length, 1);
	assert.equal(diff.triggers[0].rule, "working_to_completed");
	assert.match(diff.triggers[0].evidence, /hidden:terminal:completed/);
});
check("A4.3 ③ working→failed（可见 + hidden）；terminal:cancelled/orphaned 不触发", () => {
	const prev = makePrevSnap(NOW - 1000, [makeProject({ project: K, state: "Working", runs: { r1: "working" } })]);
	const vis = buildFrontier({
		snapshot: makeSnapshot([makeTab({ runId: "r1", repoPath: R1, phase: "failed", resultMissing: true, terminal: true })]),
		backlog: [], prev, now: NOW,
	});
	assert.deepEqual(vis.diff.triggers.map((t) => t.rule), ["working_to_failed"]);
	const hid = buildFrontier({
		snapshot: makeSnapshot([], { history: [{ id: "r1", repoPath: R1, reason: "terminal:failed", at: "x" }] }),
		backlog: [], prev, now: NOW,
	});
	assert.deepEqual(hid.diff.triggers.map((t) => t.rule), ["working_to_failed"]);
	const cx = buildFrontier({
		snapshot: makeSnapshot([], { history: [{ id: "r1", repoPath: R1, reason: "terminal:cancelled", at: "x" }] }),
		backlog: [], prev, now: NOW,
	});
	assert.equal(cx.diff.triggers.length, 0);
	const or = buildFrontier({
		snapshot: makeSnapshot([], { history: [{ id: "r1", repoPath: R1, reason: "orphaned", at: "x" }] }),
		backlog: [], prev, now: NOW,
	});
	assert.equal(or.diff.triggers.length, 0); // orphaned 喂 watchdog 检查 6，不喂 ②③
});
check("A4.4 ⑤ needs_user false→true 边沿（true→true / false→false 不触发）", () => {
	const prev = makePrevSnap(NOW - 1000, [makeProject({ project: K, runs: { r1: "working" }, needsUser: false })]);
	const { diff } = buildFrontier({
		snapshot: makeSnapshot([makeTab({ runId: "r1", repoPath: R1, phase: "working", needsHuman: true })]),
		backlog: [], prev, now: NOW,
	});
	assert.deepEqual(diff.triggers.map((t) => t.rule), ["needs_user"]);
	const prev2 = makePrevSnap(NOW - 1000, [makeProject({ project: K, runs: { r1: "working" }, needsUser: true })]);
	const d2 = buildFrontier({
		snapshot: makeSnapshot([makeTab({ runId: "r1", repoPath: R1, phase: "working", needsHuman: true })]),
		backlog: [], prev: prev2, now: NOW,
	});
	assert.equal(d2.diff.triggers.length, 0);
});
check("A4.5 ⑨ stagnation false→true（staleOver 45min 边沿，复用 STALE_NO_PROGRESS_MS 语义）", () => {
	const prev = makePrevSnap(NOW - 1000, [makeProject({ project: K, runs: { r1: "working" }, stagnation: false })]);
	const { diff } = buildFrontier({
		snapshot: makeSnapshot([makeTab({ runId: "r1", repoPath: R1, phase: "working", staleOver: true })]),
		backlog: [], prev, now: NOW,
	});
	assert.deepEqual(diff.triggers.map((t) => t.rule), ["stagnation"]);
});
check("A4.6 ① approx：gate awaiting→ok（approx 标注 + 不计 meaningful）", () => {
	const prev = makePrevSnap(NOW - 1000, [
		makeProject({ project: K, state: "Working", runs: { r1: "waiting" }, gate: "awaiting", needsUser: true }),
	]);
	const { diff } = buildFrontier({
		snapshot: makeSnapshot([makeTab({ runId: "r1", repoPath: R1, phase: "waiting", gate: "ok", needsHuman: false })]),
		backlog: [], prev, now: NOW,
	});
	assert.equal(diff.triggers.length, 1);
	assert.equal(diff.triggers[0].rule, "blocked_to_ready");
	assert.equal(diff.triggers[0].approximate, true);
	assert.match(diff.triggers[0].evidence, /approx=gate-transition/);
	assert.equal(diff.meaningfulChanges, 0);
});
check("A4.7 ⑦ approx：overdue 0→正（approx 标注 + 明示 timer ≠ 真 deadline）", () => {
	const prev = makePrevSnap(NOW - 1000, [makeProject({ project: K, state: "Working", runs: { r1: "working" }, overdue: 0 })]);
	const { diff } = buildFrontier({
		snapshot: makeSnapshot([makeTab({ runId: "r1", repoPath: R1, phase: "working", overdue: 3 })]),
		backlog: [], prev, now: NOW,
	});
	assert.equal(diff.triggers.length, 1);
	assert.equal(diff.triggers[0].rule, "deadline_urgency");
	assert.equal(diff.triggers[0].approximate, true);
	assert.match(diff.triggers[0].evidence, /overdue:0→3/);
	assert.match(diff.triggers[0].evidence, /approx=timer-overdue/);
});
check("A4.8 ④⑥⑧ record-only 永不进 triggers；recordOnly 固化 3 条 no-carrier 标记", () => {
	const prev = makePrevSnap(NOW - 1000, [makeProject({ project: K, runs: { r1: "working" } })]);
	const { diff } = buildFrontier({
		snapshot: makeSnapshot([makeTab({ runId: "r1", repoPath: R1, phase: "completed", resultMissing: true, terminal: true })]),
		backlog: [], prev, now: NOW,
	});
	for (const rule of ["needs_global", "risk_high", "expected_event_timeout"] as FrontierRule[]) {
		assert.equal(diff.triggers.some((t) => t.rule === rule), false, `${rule} 永不进 triggers`);
	}
	assert.deepEqual(diff.recordOnly, RECORD_ONLY_NOCARRIER);
	assert.equal(diff.recordOnly.length, 3);
});
check("A4.9 新出现项目（不在 prev）：不触发、version 起 1", () => {
	const prev = makePrevSnap(NOW - 1000, []);
	const { next, diff } = buildFrontier({
		snapshot: makeSnapshot([makeTab({ runId: "r9", repoPath: R1, phase: "working" })]),
		backlog: [], prev, now: NOW,
	});
	assert.equal(diff.triggers.length, 0);
	assert.equal(next.projects[0].meaningfulStateVersion, 1);
});

// ════════════════════════════ A5 首帧基线 ════════════════════════════
console.log("A5 首帧基线");
check("A5 prev=null → baseline:true、零触发（全开标志也只建基线，防冷启动风暴）", () => {
	const { next, diff } = buildFrontier({
		snapshot: makeSnapshot([
			makeTab({ runId: "r1", repoPath: R1, phase: "working", needsHuman: true, gate: "awaiting", overdue: 5, staleOver: true }),
		]),
		backlog: [{ recipient: "agent__master_default", pending: 3, claimed: 0 }],
		prev: null,
		now: NOW,
	});
	assert.equal(next.baseline, true);
	assert.deepEqual(next.triggers, []);
	assert.deepEqual(diff.triggers, []);
	const p = next.projects[0];
	assert.equal(p.needsUser, true);
	assert.equal(p.stagnation, true);
	assert.equal(p.overdue, 5);
	assert.equal(p.meaningfulStateVersion, 1);
});

// ════════════════════════════ A6 meaningful version ════════════════════════════
console.log("A6 meaningful_state_version");
check("A6.1 噪声（age/stale 展示文本变化，结构不变）：不 bump、零触发", () => {
	const f1 = buildFrontier({
		snapshot: makeSnapshot([makeTab({ runId: "r1", repoPath: R1, phase: "working", age: "1m", stale: "2m" })]),
		backlog: [], prev: null, now: NOW,
	});
	const f2 = buildFrontier({
		snapshot: makeSnapshot(
			[makeTab({ runId: "r1", repoPath: R1, phase: "working", age: "2m", stale: "3m" })],
			{ rows: [makeRepoRow(R1, { lastText: "5m" })] },
		),
		backlog: [], prev: f1.next, now: NOW + 60_000,
	});
	assert.deepEqual(f2.diff.triggers, []);
	assert.equal(f2.next.projects[0].meaningfulStateVersion, 1); // 不 bump
});
check("A6.2 ②+⑤ 双真实触发同帧：version 恰 +1（同帧去重，不重复 bump）", () => {
	const f1 = buildFrontier({
		snapshot: makeSnapshot([makeTab({ runId: "r1", repoPath: R1, phase: "working" })]),
		backlog: [], prev: null, now: NOW,
	});
	const f2 = buildFrontier({
		snapshot: makeSnapshot([makeTab({ runId: "r1", repoPath: R1, phase: "completed", resultMissing: true, terminal: true, needsHuman: true })]),
		backlog: [], prev: f1.next, now: NOW + 60_000,
	});
	assert.ok(f2.diff.triggers.some((t) => t.rule === "working_to_completed"));
	assert.ok(f2.diff.triggers.some((t) => t.rule === "needs_user"));
	assert.equal(f2.diff.meaningfulChanges, 2);
	assert.equal(f2.next.projects[0].meaningfulStateVersion, 2); // 1 + 1
});

// ════════════════════════════ A7 Wake Gate ════════════════════════════
console.log("A7 Wake Gate");
const cfg = DEFAULT_AUTONOMY.wakeGate;
const idleState: WakeGateState = { lastDecisionAt: null, lastWakeAt: null, batchFirstSeenAt: null };
const gOn = { active: true, reason: "active" };
const gKill = { active: false, reason: "kill-switch:manual-stop" };
const gOff = { active: false, reason: "autonomy-disabled" };
const trig = (rule: FrontierRule, approximate = false) => ({ rule, project: K, evidence: "e", approximate });

check("A7.1 空 diff → no-meaningful-change（审计行格式）", () => {
	const d = evaluateWakeGate({ gating: gOn, diff: { triggers: [], recordOnly: [], meaningfulChanges: 0 }, state: idleState, cfg, now: NOW });
	assert.equal(d.wake, false);
	assert.equal(d.reason, "no-meaningful-change");
	assert.equal(d.auditLine, "wake-gate no-wake reason=no-meaningful-change");
});
check("A7.2 只 record-only → no-wake record-only；只 approx → no-wake approx-only（近似不唤醒，只记录）", () => {
	const d1 = evaluateWakeGate({ gating: gOn, diff: { triggers: [], recordOnly: RECORD_ONLY_NOCARRIER, meaningfulChanges: 0 }, state: idleState, cfg, now: NOW });
	assert.equal(d1.wake, false);
	assert.equal(d1.reason, "record-only");
	const d2 = evaluateWakeGate({
		gating: gOn,
		diff: { triggers: [trig("deadline_urgency", true)], recordOnly: RECORD_ONLY_NOCARRIER, meaningfulChanges: 0 },
		state: idleState, cfg, now: NOW,
	});
	assert.equal(d2.wake, false);
	assert.equal(d2.reason, "approx-only");
	assert.equal(d2.auditLine, "wake-gate no-wake reason=approx-only");
});
check("A7.3 debounce 窗内（<2s）→ no-wake debounce（bypass 同样受其约束）", () => {
	const st: WakeGateState = { lastDecisionAt: NOW - 60_000, lastWakeAt: null, batchFirstSeenAt: NOW - 1_000 };
	const d = evaluateWakeGate({
		gating: gOn,
		diff: { triggers: [trig("needs_user")], recordOnly: [], meaningfulChanges: 1 },
		state: st, cfg, now: NOW,
	});
	assert.equal(d.wake, false);
	assert.equal(d.reason, "debounce");
});
check("A7.4 cooldown 窗内（<15s）ordinary → no-wake cooldown", () => {
	const st: WakeGateState = { lastDecisionAt: NOW - 5_000, lastWakeAt: null, batchFirstSeenAt: NOW - 10_000 };
	const d = evaluateWakeGate({
		gating: gOn,
		diff: { triggers: [trig("stagnation")], recordOnly: [], meaningfulChanges: 1 },
		state: st, cfg, now: NOW,
	});
	assert.equal(d.wake, false);
	assert.equal(d.reason, "cooldown");
});
check("A7.5 needs_user bypass 穿越 cooldown，但不穿越 kill/debounce", () => {
	const st: WakeGateState = { lastDecisionAt: NOW - 1_000, lastWakeAt: null, batchFirstSeenAt: NOW - 10_000 }; // cooldown 窗内 + debounce 已过
	const d = evaluateWakeGate({
		gating: gOn,
		diff: { triggers: [trig("needs_user"), trig("stagnation")], recordOnly: [], meaningfulChanges: 2 },
		state: st, cfg, now: NOW,
	});
	assert.equal(d.wake, true);
	assert.equal(d.bypass, "needs_user");
	assert.equal(d.auditLine, "wake-gate wake bypass=needs_user");
	const dk = evaluateWakeGate({
		gating: gKill,
		diff: { triggers: [trig("needs_user")], recordOnly: [], meaningfulChanges: 1 },
		state: idleState, cfg, now: NOW,
	});
	assert.equal(dk.wake, false);
	assert.equal(dk.reason, "kill-switch:manual-stop");
	const stDeb: WakeGateState = { lastDecisionAt: null, lastWakeAt: null, batchFirstSeenAt: NOW - 500 };
	const dd = evaluateWakeGate({
		gating: gOn,
		diff: { triggers: [trig("needs_user")], recordOnly: [], meaningfulChanges: 1 },
		state: stDeb, cfg, now: NOW,
	});
	assert.equal(dd.wake, false);
	assert.equal(dd.reason, "debounce");
});
check("A7.6 ordinary 触发出双窗 → wake ordinary（审计行）", () => {
	const st: WakeGateState = { lastDecisionAt: NOW - 60_000, lastWakeAt: null, batchFirstSeenAt: NOW - 60_000 };
	const d = evaluateWakeGate({
		gating: gOn,
		diff: { triggers: [trig("working_to_completed")], recordOnly: [], meaningfulChanges: 1 },
		state: st, cfg, now: NOW,
	});
	assert.equal(d.wake, true);
	assert.equal(d.bypass, null);
	assert.equal(d.auditLine, "wake-gate wake reason=ordinary");
});
check("A7.7 dormant bypass 类永不匹配（9 规则穷举，非 approx）", () => {
	const all: FrontierRule[] = [
		"blocked_to_ready", "working_to_completed", "working_to_failed", "needs_global", "needs_user",
		"risk_high", "deadline_urgency", "expected_event_timeout", "stagnation",
	];
	for (const r of all) {
		const d = evaluateWakeGate({
			gating: gOn,
			diff: { triggers: [trig(r)], recordOnly: [], meaningfulChanges: 1 },
			state: idleState, cfg, now: NOW,
		});
		assert.notEqual(d.bypass, "high_risk_failure", `${r} 永不匹配 high_risk_failure（无 risk 载体）`);
		assert.notEqual(d.bypass, "critical_resource_loss", `${r} 永不匹配 critical_resource_loss（无载体）`);
	}
	// v1 live 映射：needs_user → needs_user；非 approx ⑦ → urgent_escalation（结构 live；v1 数据侧 ⑦ 恒 approx 故 dormant）
	assert.equal(evaluateWakeGate({ gating: gOn, diff: { triggers: [trig("needs_user")], recordOnly: [], meaningfulChanges: 1 }, state: idleState, cfg, now: NOW }).bypass, "needs_user");
	assert.equal(evaluateWakeGate({ gating: gOn, diff: { triggers: [trig("deadline_urgency")], recordOnly: [], meaningfulChanges: 1 }, state: idleState, cfg, now: NOW }).bypass, "urgent_escalation");
	// failed 触发按 ordinary，不冒充 high-risk
	const d = evaluateWakeGate({
		gating: gOn,
		diff: { triggers: [trig("working_to_failed")], recordOnly: [], meaningfulChanges: 1 },
		state: idleState, cfg, now: NOW,
	});
	assert.equal(d.wake, true);
	assert.equal(d.bypass, null);
});
check("A7.8 autonomy-disabled（无 kill）同样恒 no-wake", () => {
	const d = evaluateWakeGate({
		gating: gOff,
		diff: { triggers: [trig("needs_user")], recordOnly: [], meaningfulChanges: 1 },
		state: idleState, cfg, now: NOW,
	});
	assert.equal(d.wake, false);
	assert.equal(d.reason, "autonomy-disabled");
});

// ════════════════════════════ A8 Watchdog ════════════════════════════
console.log("A8 Watchdog");
const baseInputs = (over: Partial<WatchdogInputs> = {}): WatchdogInputs => ({
	gating: { active: true, reason: "active" },
	unhandledFrontierDiff: false,
	mailboxBacklogPending: 0,
	stalledProjects: [],
	readyWork: false,
	idleOwnerApprox: false,
	runStateMismatch: [],
	heartbeatAgeMs: 60_000,
	...over,
});
check("A8.1 8 项清单固化（规格 §12.2 的 8 问；任务书'七项'系计数偏差）", () => {
	assert.equal(CHECK_NAMES.length, 8);
	assert.deepEqual(CHECK_NAMES, [
		"unhandled_frontier_diff", "mailbox_backlog", "pending_request_timeout", "stalled_project",
		"ready_work_idle_owner", "run_state_mismatch", "heartbeat_too_old", "state_projection_inconsistent",
	]);
});
check("A8.2 检查 1/2/4/6/7 各一真一假（7 阈值 = WATCHDOG_HEARTBEAT_STALE_MS 10m 独立常量）", () => {
	assert.equal(evaluateWatchdogChecks(baseInputs({ unhandledFrontierDiff: true })).checks.unhandled_frontier_diff.status, "true");
	assert.equal(evaluateWatchdogChecks(baseInputs()).checks.unhandled_frontier_diff.status, "false");
	assert.equal(evaluateWatchdogChecks(baseInputs({ mailboxBacklogPending: 3 })).checks.mailbox_backlog.status, "true");
	assert.equal(evaluateWatchdogChecks(baseInputs({ mailboxBacklogPending: 0 })).checks.mailbox_backlog.status, "false");
	assert.equal(evaluateWatchdogChecks(baseInputs({ stalledProjects: ["a", "b"] })).checks.stalled_project.status, "true");
	assert.equal(evaluateWatchdogChecks(baseInputs({ stalledProjects: [] })).checks.stalled_project.status, "false");
	assert.equal(evaluateWatchdogChecks(baseInputs({ runStateMismatch: [{ runId: "r1", phase: "working", pidAlive: false }] })).checks.run_state_mismatch.status, "true");
	assert.equal(evaluateWatchdogChecks(baseInputs({ runStateMismatch: [] })).checks.run_state_mismatch.status, "false");
	assert.equal(evaluateWatchdogChecks(baseInputs({ heartbeatAgeMs: WATCHDOG_HEARTBEAT_STALE_MS + 1 })).checks.heartbeat_too_old.status, "true");
	assert.equal(evaluateWatchdogChecks(baseInputs({ heartbeatAgeMs: WATCHDOG_HEARTBEAT_STALE_MS })).checks.heartbeat_too_old.status, "false"); // == 阈值不算 too old
});
check("A8.3 检查 3/8 恒 unknown；unknown 不影响 wakeRecommended；审计行列 unknown 名单", () => {
	const w1 = evaluateWatchdogChecks(baseInputs({ mailboxBacklogPending: 2 }));
	assert.equal(w1.checks.pending_request_timeout.status, "unknown");
	assert.equal(w1.checks.state_projection_inconsistent.status, "unknown");
	assert.equal(w1.wakeRecommended, true); // 由检查 2 的 true 决定，unknown 不改变
	assert.equal(w1.auditLine, "watchdog wake reason=mailbox_backlog unknown=pending_request_timeout,state_projection_inconsistent");
	const w2 = evaluateWatchdogChecks(baseInputs());
	assert.equal(w2.wakeRecommended, false); // 已评测项全 false（unknown 不算 true）
	assert.equal(w2.auditLine, "watchdog no-wake reason=no-issue unknown=pending_request_timeout,state_projection_inconsistent");
	const w3 = evaluateWatchdogChecks(baseInputs({ heartbeatAgeMs: null }));
	assert.equal(w3.checks.heartbeat_too_old.status, "unknown"); // no-liveness 不猜（对齐 local-master-claim）
	assert.match(w3.auditLine, /unknown=.*heartbeat_too_old/);
});
check("A8.4 检查 5 approx：true 判定带 approx 标注；idle 无载体（false）→ 不 true", () => {
	const w = evaluateWatchdogChecks(baseInputs({ readyWork: true, idleOwnerApprox: true }));
	assert.deepEqual(w.checks.ready_work_idle_owner, { status: "true", reason: "approx=no-turn-state" });
	assert.equal(w.wakeRecommended, true);
	assert.equal(evaluateWatchdogChecks(baseInputs({ readyWork: true, idleOwnerApprox: false })).checks.ready_work_idle_owner.status, "false");
	assert.equal(evaluateWatchdogChecks(baseInputs({ readyWork: false, idleOwnerApprox: true })).checks.ready_work_idle_owner.status, "false");
});
check("A8.5 gating 短路：8 项全 unknown + 恒不唤醒 + 审计行带 gating reason", () => {
	const w = evaluateWatchdogChecks({
		...baseInputs({ unhandledFrontierDiff: true, mailboxBacklogPending: 9 }),
		gating: { active: false, reason: "kill-switch:x" },
	});
	assert.equal(w.wakeRecommended, false);
	for (const n of CHECK_NAMES) assert.equal(w.checks[n].status, "unknown");
	assert.equal(w.auditLine, `watchdog no-wake reason=kill-switch:x unknown=${CHECK_NAMES.join(",")}`);
});

// ════════════════════════════ A9 cadence 校验 ════════════════════════════
console.log("A9 cadence 校验");
const pol = DEFAULT_AUTONOMY.watchdog;
check("A9.1 interval 钳制到 [2m,60m]", () => {
	assert.equal(validateWatchdogPlan({ intervalMs: 1_000, validForMs: 3_600_000, reason: "x" }, pol, NOW).plan!.intervalMs, 120_000); // 1s → 2m
	assert.equal(validateWatchdogPlan({ interval: "5m", valid_for: "1h", reason: "x" }, pol, NOW).plan!.intervalMs, 300_000); // 区间内保留
	assert.equal(validateWatchdogPlan({ intervalMs: 100 * 60_000, validForMs: 3_600_000, reason: "x" }, pol, NOW).plan!.intervalMs, 3_600_000); // 100m → 60m
});
check("A9.2 validFor 封顶 6h", () => {
	assert.equal(validateWatchdogPlan({ intervalMs: 600_000, validForMs: 10 * 3_600_000, reason: "x" }, pol, NOW).plan!.validForMs, 21_600_000); // 10h → 6h
	assert.equal(validateWatchdogPlan({ intervalMs: 600_000, valid_for: "1h", reason: "x" }, pol, NOW).plan!.validForMs, 3_600_000);
});
check("A9.3 垃圾/缺字段 plan → ok:false 回默认（带 fallbackReason）", () => {
	for (const bad of [null, "x", 42, { intervalMs: "banana", validForMs: 600_000, reason: "x" }, { intervalMs: 600_000, validForMs: -5, reason: "x" }]) {
		const r = validateWatchdogPlan(bad, pol, NOW);
		assert.equal(r.ok, false);
		assert.equal(r.plan, null);
		assert.ok(r.fallbackReason, `fallbackReason for ${JSON.stringify(bad)}`);
	}
});
check("A9.4 缺/空 reason 拒绝", () => {
	const r1 = validateWatchdogPlan({ intervalMs: 600_000, validForMs: 3_600_000 }, pol, NOW);
	assert.equal(r1.ok, false);
	assert.equal(r1.fallbackReason, "missing-reason");
	const r2 = validateWatchdogPlan({ intervalMs: 600_000, validForMs: 3_600_000, reason: "  " }, pol, NOW);
	assert.equal(r2.ok, false);
});
check("A9.5 parseDurationMs（ms/s/m/h/d；垃圾 null）", () => {
	assert.equal(parseDurationMs("10m"), 600_000);
	assert.equal(parseDurationMs("1h"), 3_600_000);
	assert.equal(parseDurationMs("30s"), 30_000);
	assert.equal(parseDurationMs("500ms"), 500);
	assert.equal(parseDurationMs("2d"), 172_800_000);
	assert.equal(parseDurationMs(90_000), 90_000);
	assert.equal(parseDurationMs("abc"), null);
	assert.equal(parseDurationMs(0), null);
	assert.equal(parseDurationMs(-5), null);
	assert.equal(parseDurationMs(Number.NaN), null);
});

// ════════════════════════════ A10 零侵入 ════════════════════════════
console.log("A10 零侵入");
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT_ROOT = join(REPO_ROOT, "extensions");
check("A10.1 extensions/ 生产文件引用 runtime/autonomy 限于 v2 接线 allowlist（Task 2006）", () => {
	// v2 接线后生产文件 import 合法化：零 import 不变量改为 allowlist 双向精确匹配
	//（多一个 = 红线违规；少一个 = 接线被静默拆除）。相对路径与相对名 ALLOW 对齐（L2 审查要点 ①）。
	const ALLOW = ["index.ts", "master-tools.ts"]; // 相对 EXT_ROOT（2026-09-23 v2 接线）
	const offenders: string[] = [];
	const walk = (dir: string): void => {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, e.name);
			if (e.isDirectory()) {
				if (p === join(EXT_ROOT, "runtime", "autonomy")) continue; // autonomy/** 自身
				walk(p);
			} else if (e.isFile() && e.name.endsWith(".ts")) {
				// 本测试文件（v1 既有排除）+ v2 接线测试文件自身 import runtime/autonomy 字面量（不排除即假红，L2 审查要点 ②）
				if (p === join(EXT_ROOT, "_test_runtime_autonomy.ts")) continue;
				if (p === join(EXT_ROOT, "_test_autonomy_wiring.ts")) continue;
				if (readFileSync(p, "utf8").includes("runtime/autonomy")) offenders.push(relative(EXT_ROOT, p));
			}
		}
	};
	walk(EXT_ROOT);
	assert.deepEqual(offenders.sort(), [...ALLOW].sort());
});
check("A10.1b wake.ts 接线存在性（字面量盲区堵漏）", () => {
	// wake.ts 位于 runtime/ 内，import 写作 "./autonomy/gate.ts"，不含字面量 "runtime/autonomy"
	// → 字面量 tripwire 天然看不见它；用正向断言钉死接线（被静默拆除时红）。
	assert.ok(
		readFileSync(join(EXT_ROOT, "runtime", "wake.ts"), "utf8").includes('"./autonomy/gate.ts"'),
		"wake.ts 必须 import \"./autonomy/gate.ts\"（v2 接线）",
	);
});
check("A10.2 config.json 无 autonomy 键 → readAutonomyConfig 全默认（零侵入：无注册无循环无读盘）", () => {
	const p = join(cfgRoot, "nokey2.json");
	writeFileSync(p, JSON.stringify({ masterSuccession: { auto: true, enabled: true } }), "utf8");
	assert.deepEqual(readAutonomyConfig({ configPath: p }), DEFAULT_AUTONOMY);
});

// ════════════════════════════ A11 collect 装配 + 污染检查 ════════════════════════════
console.log("A11 collect 装配 + 污染检查");
const realAutonomy = join(homedir(), ".pi", "agent", "runtime", "state", "autonomy");
const realBefore = existsSync(realAutonomy);
check("A11.1 collectAutonomyInputs：只读聚合 + 只写自有 namespace（temp 注入）+ 两帧基线切换", () => {
	const root = mkdtempSync(join(tmpdir(), "runtime-autonomy-collect-"));
	const agentDir = join(root, "agent");
	const stateDir = join(root, "state");
	mkdirSync(agentDir, { recursive: true });
	try {
		const r1 = collectAutonomyInputs({ agentDir, stateDir, now: NOW });
		// never-throw：形状完整
		assert.ok(r1.frontier !== null, "frontier 非 null（空 temp 盘面）");
		assert.equal(r1.frontier!.next.baseline, true); // 首帧（temp 无 frontier.json）
		assert.equal(r1.frontier!.next.projects.length, 0);
		assert.equal(typeof r1.gating.active, "boolean");
		assert.equal(r1.watchdog.wakeRecommended, false);
		// 只写自有 namespace
		assert.ok(existsSync(join(stateDir, "autonomy", "frontier.json")));
		assert.ok(existsSync(join(stateDir, "autonomy", "audit.jsonl")));
		const audit = readFileSync(join(stateDir, "autonomy", "audit.jsonl"), "utf8");
		assert.match(audit, /frontier baseline=true projects=0 triggers=0 meaningful=0 recordonly=3/);
		assert.match(audit, /watchdog (wake|no-wake) reason=/);
		// 第二帧：prev 可读 → baseline false（空盘面零触发，不风暴）
		const r2 = collectAutonomyInputs({ agentDir, stateDir, now: NOW + 60_000 });
		assert.equal(r2.frontier!.next.baseline, false);
		assert.deepEqual(r2.frontier!.diff.triggers, []);
		const snap = readFrontierSnapshot({ stateDir });
		assert.ok(snap !== null);
		assert.equal(snap!.baseline, false);
		// 快照损坏 → 容忍读 null（C4 自愈：下帧回 baseline 模式）
		writeFileSync(join(stateDir, "autonomy", "frontier.json"), "{corrupt", "utf8");
		assert.equal(readFrontierSnapshot({ stateDir }), null);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
check("A11.2 真实 ~/.pi/agent/runtime 下无 state/autonomy/ 新增（测试不触真实目录）", () => {
	const realAfter = existsSync(realAutonomy);
	assert.equal(realAfter, realBefore, realBefore ? "真实目录原本存在，测试未改变" : "测试不得在真实目录新建 state/autonomy/");
	if (!realBefore) assert.equal(realAfter, false);
});

// ── 清理 + 汇总 ─────────────────────────────────────────────────────
rmSync(ENV_TMP, { recursive: true, force: true });
rmSync(cfgRoot, { recursive: true, force: true });
rmSync(ksRoot, { recursive: true, force: true });
if (failed > 0) {
	console.error(`_test_runtime_autonomy: FAILED (${failed} failed / ${passed} passed)`);
	process.exit(1);
}
console.log(`_test_runtime_autonomy: all ${passed} checks passed`);
