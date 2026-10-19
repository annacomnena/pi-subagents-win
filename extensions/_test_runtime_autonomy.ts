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
	BLOCKED_OVERDUE_THROTTLE_MS,
	RECORD_ONLY_NOCARRIER,
	buildFrontier,
	deriveTabSupervisionState,
	mapPhaseToProjectState,
	normalizeExactPath,
	type FrontierRule,
	type FrontierSnapshot,
	type FrontierSupervision,
	type FrontierTrigger,
	type ProjectFrontier,
} from "./runtime/autonomy/frontier.ts";
import type { FrontierSourceTab } from "./runtime/frontier-carriers.ts";
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
	readNoticeAckKeys,
} from "./runtime/autonomy/collect.ts";
import { evaluateAutonomyWakeGate } from "./runtime/autonomy/gate.ts";
import { masterAddress } from "./runtime/address.ts";
import { deliverLetter, newMessageId } from "./runtime/mailbox.ts";
import { newMessageFrame } from "./runtime/protocol.ts";
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
		// 2026-10-17 监管 P0：idleMs 是 SOFT/PUSH/USER 分档的结构化时间基。漏透传会导致
		// 所有测试 tab 的 idleMs 恒为 undefined（→ 新判据永远判不出 STALLED）。
		idleMs: over.idleMs ?? null,
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
		attentionByRepo: {},
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
		blockedOverdue: p.blockedOverdue ?? false,
		...(p.blockedOverdueRunId ? { blockedOverdueRunId: p.blockedOverdueRunId } : {}),
		...(p.blockedOverdueRunIds ? { blockedOverdueRunIds: p.blockedOverdueRunIds } : {}),
		...(p.blockedOverdueLastAt && typeof p.blockedOverdueLastAt === "object" ? { blockedOverdueLastAt: p.blockedOverdueLastAt } : {}),
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
	// 2026-10-17 监管 P0 语义变更：resultMissing **不再直达** stagnation（旧判据零区分度，
	// 实测 3/3 全 true）。stagnation 现由六态机派生 = STALLED；无监管账本 ⇒ NOT_MONITORED ⇒ false。
	assert.equal(p.stagnation, false, "resultMissing 不得再直达 stagnation（监管 P0 语义）");
});
check("A3.4 仓 attention>0 喂 needs_user（terminal 无 result 可见待审）；无 attention 时不猜", () => {
	const tabs = [makeTab({ runId: "r1", repoPath: R1, phase: "unconfirmed", needsHuman: false })];
	const { next } = buildFrontier({ snapshot: makeSnapshot(tabs, { attentionByRepo: { [normalizeExactPath(R1)]: 1 } }), backlog: [], prev: null, now: NOW });
	assert.equal(next.projects[0].needsUser, true);
	const { next: n2 } = buildFrontier({ snapshot: makeSnapshot(tabs), backlog: [], prev: null, now: NOW });
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
check("A4.5 ⑨ stagnation false→true（监管 P0 新语义：账本 active + waiting + stop=stop + idle>15min）", () => {
	const prev = makePrevSnap(NOW - 1000, [makeProject({ project: K, runs: { r1: "waiting" }, stagnation: false })]);
	const { diff } = buildFrontier({
		snapshot: makeSnapshot([
			makeTab({ runId: "r1", repoPath: R1, phase: "waiting", stop: "stop", idleMs: 16 * 60_000, needsHuman: false }),
		]),
		backlog: [], prev, now: NOW,
		supervision: [{ runId: "r1", status: "active", epochPushes: 0 }],
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
check("A4.10 R4 ws-mail 到信触发并放行；无到信输出逐字节不变", () => {
	const snapshot = makeSnapshot([makeTab({ runId: "mail-test", repoPath: R1, phase: "working" })]);
	const prev = makePrevSnap(NOW - 60_000, []);
	const empty = buildFrontier({ snapshot, backlog: [], prev, now: NOW });
	const withMail = buildFrontier({ snapshot, backlog: [{ recipient: "agent__master_default", pending: 1, claimed: 0 }], prev, now: NOW });
	assert.deepEqual(empty, buildFrontier({ snapshot, backlog: [], prev, now: NOW }));
	assert.deepEqual(withMail.diff.triggers.map(t => t.rule), ["ws_mail_backlog"]);
	const decision = evaluateWakeGate({ gating: { active: true, reason: "active" }, diff: withMail.diff,
		state: { lastDecisionAt: null, lastWakeAt: null, batchFirstSeenAt: NOW - 5_000 }, cfg: DEFAULT_AUTONOMY.wakeGate, now: NOW });
	assert.equal(decision.wake, true);
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
	assert.equal(next.triggers.length, 1); // R4：未消费 ws-mail 到信不被冷启动基线吞掉
	assert.equal(next.triggers[0].rule, "ws_mail_backlog");
	assert.deepEqual(diff.triggers, next.triggers);
	const p = next.projects[0];
	assert.equal(p.needsUser, true);
	// 2026-10-17 监管 P0 语义变更：stagnation 不再由 staleOver 派发（旧判据零区分度），
	// 而由六态机派生；本用例无监管账本 ⇒ NOT_MONITORED ⇒ false。
	assert.equal(p.stagnation, false, "staleOver 不得再直达 stagnation（监管 P0 语义）");
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
	// 相对 EXT_ROOT。2026-10-17 新增 mailbox-consumer.ts：autonomy 心跳（writeAutonomyHeartbeat）必须
	// 接在 wake tick 开头（tick 是唯一无条件每 30s 跑的位置），这是修「autonomy 静默死亡 29h」的实现点，
	// 属正当接线（不是绕过 allowlist）。
	const ALLOW = ["index.ts", "mailbox-consumer.ts", "master-tools.ts", "runtime-host/server.ts"]; // 相对 EXT_ROOT（2026-09-24 autonomy endpoint）
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
				// E2.1：新适配器测试 import runtime/autonomy（frontier.ts）字面量 → 排除（ALLOW 不动）
				if (p === join(EXT_ROOT, "_test_graph_frontier_input.ts")) continue;
				// E2.2：影子对照 harness import runtime/autonomy（frontier.ts/collect.ts）字面量 → 排除（ALLOW 不动）
				if (p === join(EXT_ROOT, "_test_graph_frontier_shadow.ts")) continue;
				// 0929 切片 B-4：_test_expectations.ts 去运行期字符串拼接、改静态 import runtime/autonomy
				// → 排除清单显式登记（ALLOW 不动：测试文件非生产接线点）
				if (p === join(EXT_ROOT, "_test_expectations.ts")) continue;
				// P1（20261001）：动作面测试 import runtime/autonomy/action/** 字面量 → 排除（ALLOW 不动）
				if (p === join(EXT_ROOT, "_test_runtime_autonomy_actions.ts")) continue;
				// 2026-10-18 监管默认值翻转：该测试走真实读路径（readSupervisionInputs / buildFrontier）
				// → 需要 import runtime/autonomy 字面量 → 排除（ALLOW 不动：仍是测试文件非生产接线点）
				if (p === join(EXT_ROOT, "_test_runtime_supervision_default_on.ts")) continue;
				// P1 主动推动（20261018）：该测试注入**真** `appendAuditLine`（runtime/autonomy/collect.ts）
				// 验证 audit.jsonl 真落一行 → 需要 import runtime/autonomy 字面量 → 排除
				//（ALLOW 不动：仍是测试文件、非生产接线点）
				if (p === join(EXT_ROOT, "_test_runtime_supervision_push.ts")) continue;
				// RF-1（20261018）：该测试直接断言 `deriveTabSupervisionState`（BLOCKED_USER 判据）
				// → 需要 import runtime/autonomy/frontier.ts 字面量 → 排除
				//（ALLOW 不动：仍是测试文件、非生产接线点；生产侧未新增 autonomy 引用）
				if (p === join(EXT_ROOT, "_test_tab_report_fallback.ts")) continue;
				// 2026-10-19 常驻 local master 越界修复：该测试走真实全链
				// `collectAutonomyInputs`（runtime/autonomy/collect.ts）验证 lms 空闲
				// 不再触发 needs_user → 需要 import runtime/autonomy 字面量 → 排除
				//（ALLOW 不动：仍是测试文件、非生产接线点；生产侧未新增 autonomy 引用）
				if (p === join(EXT_ROOT, "_test_resident_lms_needsuser.ts")) continue;
				if (readFileSync(p, "utf8").includes("runtime/autonomy")) offenders.push(relative(EXT_ROOT, p).replace(/\\/g, "/"));
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
check("A10.1c wake.ts P1 动作面接线存在性（action/run.ts，字面量盲区堵漏）", () => {
	// P1（20261001）：wake.ts 在 autonomy gate 块后 +1 个 never-throw 动作调用。
	// 相对 import 写作 "./autonomy/action/run.ts"，不含字面量 "runtime/autonomy" → 字面量
	// tripwire 天然盲区；用正向断言钉死（被静默拆除时红）。
	assert.ok(
		readFileSync(join(EXT_ROOT, "runtime", "wake.ts"), "utf8").includes('"./autonomy/action/run.ts"'),
		"wake.ts 必须 import \"./autonomy/action/run.ts\"（P1 动作面接线）",
	);
});
check("A10.1d config 归一含 actions 切片（严格 === true；缺省/垃圾 = false 零行为）", () => {
	// P1：autonomy.actions 切片独立于 autonomy.enabled（双层合取）；严格 === true 才开。
	assert.equal(defaultAutonomyConfig().actions.enabled, false, "默认 actions.enabled=false");
	assert.equal(normalizeAutonomy({ enabled: true, actions: { enabled: true } }).actions.enabled, true, "严格 true");
	assert.equal(normalizeAutonomy({ enabled: true }).actions.enabled, false, "缺键 = false");
	assert.equal(normalizeAutonomy({ enabled: true, actions: { enabled: "yes" } }).actions.enabled, false, "非严格 true 回落 false");
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

// ════════════════════════════ A12 ⑧ 期望账本语义（0929 切片 B-3 行为门重开）════════════════════════════
// 命题：⑧ 账本副作用可见（真链 deliverLetter → open 落盘 → frontier 触发/watchdog 可判定/gate 放行）
// 且 gate 仍 acted=false（放行只影响既有 legacy 唤醒链，不产生任何新动作——不投递、不 spawn）。
console.log("A12 ⑧ 期望账本语义（副作用可见 + gate acted=false）");
check("A12.1 真链 deliverLetter → ⑧ 副作用可见 且 gate 仍 acted=false（不实现动作槽）", () => {
	const root = mkdtempSync(join(tmpdir(), "runtime-autonomy-exp-"));
	const agentDir = join(root, "agent");
	const stateDir = join(root, "state");
	const mailboxDir = join(root, "mailbox"); // 生产布局：dirname(mailboxDir)/state/expectations === stateDir/expectations
	mkdirSync(agentDir, { recursive: true });
	const cfgPath = join(root, "autonomy-on.json");
	writeFileSync(cfgPath, JSON.stringify({ autonomy: { enabled: true } }), "utf8");
	try {
		// 生产者 1 真链：deliverLetter 成功点声明（显式已过期 deadline → 下一非 baseline 帧即可派生超期）
		const req = newMessageFrame({
			id: newMessageId(new Date(NOW)),
			kind: "DELEGATION",
			from: masterAddress(),
			to: "agent://a12_worker",
			sentAt: new Date(NOW).toISOString(),
			summary: "a12 request",
		});
		const r = deliverLetter(req, { mailboxDir, expectReply: { deadlineAt: new Date(NOW - 60_000).toISOString() } });
		assert.equal(r.created, true);
		assert.ok(existsSync(join(stateDir, "expectations", "open", `${req.id}.json`)), "⑧ open/<requestId>.json 落盘（副作用可见）");

		// 帧1（baseline）：gate 判 record-only no-wake；⑧ 触发被 baseline 压制（防冷启动风暴）
		const g1 = evaluateAutonomyWakeGate({ stateDir, configPath: cfgPath, agentDir, now: NOW });
		assert.equal(g1.engaged, true);
		assert.equal(g1.proceed, false);
		assert.equal(g1.reason, "record-only");

		// 帧2（非 baseline）：⑧ 副作用可见——frontier level 触发 + recordOnly 降 2 + watchdog 检查 3 可判定
		const inputs = collectAutonomyInputs({ stateDir, configPath: cfgPath, agentDir, now: NOW + 60_000 });
		const t = inputs.frontier!.diff.triggers.find((x) => x.rule === "expected_event_timeout");
		assert.ok(t, "帧2 diff 含 ⑧ expected_event_timeout 触发");
		assert.equal(t!.requestId, req.id);
		assert.equal(t!.approximate, false, "⑧ 触发 approximate=false（真载体非猜测）");
		assert.equal(inputs.frontier!.diff.recordOnly.length, 2, "有账本 → recordOnly 2 条（⑧ 行被 filter）");
		assert.equal(inputs.watchdog.checks.pending_request_timeout.status, "true", "watchdog 检查 3 可判定（不再 unknown）");
		assert.ok(inputs.watchdog.checks.pending_request_timeout.reason!.includes(req.id), "检查 3 reason 带 overdue id");

		// 帧3（debounce/cooldown 双窗已过）：gate 放行一次既有 legacy 唤醒链 + wake 级 ack（自有 namespace）
		const g2 = evaluateAutonomyWakeGate({ stateDir, configPath: cfgPath, agentDir, now: NOW + 120_000 });
		assert.equal(g2.engaged, true);
		assert.equal(g2.proceed, true, "⑧ 触发只放行既有 legacy 唤醒链（astra 红线：不宣称唤醒处理者）");
		assert.equal(g2.reason, "ordinary");
		assert.ok(readNoticeAckKeys({ stateDir }).has(`${req.id}:r0`), "wake 级 ack 落 expectation-notices.json（自有 namespace）");

		// 语义断言：⑧ 全链路（含 wake=true 放行）不产生任何动作——审计 acted=false 恒真；master 邮箱零新信件
		const audit = readFileSync(join(stateDir, "autonomy", "audit.jsonl"), "utf8").trim().split("\n");
		const v2Lines = audit.filter((l) => l.startsWith("ts="));
		assert.ok(v2Lines.length >= 2, "v2 格式审计行存在（no-wake + wake）");
		for (const l of v2Lines) assert.match(l, / acted=false$/, "每条 v2 审计行 acted=false 恒真");
		assert.ok(v2Lines.some((l) => l.includes("cat=wake concl=wake reason=ordinary")), "存在 wake=ordinary 放行行");
		const masterDir = join(mailboxDir, "agent__master_default");
		const letters = existsSync(masterDir) ? readdirSync(masterDir).filter((f) => f.endsWith(".json")) : [];
		assert.equal(letters.length, 0, "gate 放行不产生任何新信件（无动作槽，acted=false 恒真语义）");
		// 请求信本体在收件人 spool；期望仍 open（超期不关闭，等迟到回信收敛）
		// （mailboxDirFor 同款消毒：agent://a12_worker → agent___a12_worker）
		assert.ok(existsSync(join(mailboxDir, "agent___a12_worker", `${req.id}.json`)), "请求信落在收件人 spool");
		assert.ok(existsSync(join(stateDir, "expectations", "open", `${req.id}.json`)), "超期不关闭（仍 open）");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});


// ── 2026-10-17 监管 P0 验收（方案 §E-P0）：六态判据 ────────────────────
// 判据：stagnation = (deriveTabSupervisionState === "STALLED")；旧判据（resultMissing 直达）已拆除。
{
	const mkTab = (over: Partial<FrontierSourceTab> = {}): FrontierSourceTab => ({
		runId: "tab_test_1",
		repoPath: "g:/code/x",
		phase: "waiting",
		stop: "stop",
		idleMs: 16 * 60_000,
		needsHuman: false,
		gate: "ok",
		staleOver: false,
		overdue: 0,
		resultMissing: true, // 故意 true：旧判据会直接 stagnation，新判据必须忽略
		pidAlive: true,
		...over,
	});
	const ledger: FrontierSupervision = { runId: "tab_test_1", status: "active", epochPushes: 0 };

	check("SUP-P0(a) waiting+stop+账本active+idle16min ⇒ STALLED", () => {
		assert.equal(deriveTabSupervisionState({ tab: mkTab(), ledger, attention: 0 }), "STALLED");
	});

	check("SUP-P0(b) 无账本 + idle16min ⇒ NOT_MONITORED（治旧判据 3/3 全 true 误报）", () => {
		const st = deriveTabSupervisionState({ tab: mkTab(), ledger: undefined, attention: 0 });
		assert.equal(st, "NOT_MONITORED");
		assert.notEqual(st, "STALLED", "无账本不得判停滞");
	});

	check("SUP-P0(c) working+toolUse+idle50min+账本active ⇒ ACTIVE（toolUse 豁免）", () => {
		assert.equal(
			deriveTabSupervisionState({ tab: mkTab({ phase: "working", stop: "toolUse", idleMs: 50 * 60_000 }), ledger, attention: 0 }),
			"ACTIVE",
		);
	});

	check("SUP-P0(d) 账本 paused ⇒ PAUSED_USER（即便 idle 超阈值）", () => {
		assert.equal(
			deriveTabSupervisionState({ tab: mkTab({ idleMs: 120 * 60_000 }), ledger: { ...ledger, status: "paused" }, attention: 0 }),
			"PAUSED_USER",
		);
	});

	check("SUP-P0(e) 账本 active + needsHuman ⇒ BLOCKED_USER（在等人，不判停滞）", () => {
		assert.equal(
			deriveTabSupervisionState({ tab: mkTab({ needsHuman: true }), ledger, attention: 0 }),
			"BLOCKED_USER",
		);
	});

	check("SUP-P0(f) idleMs=null ⇒ 不判停滞（不拿 mtime 冒充）", () => {
		assert.equal(
			deriveTabSupervisionState({ tab: mkTab({ idleMs: null }), ledger, attention: 0 }),
			"ACTIVE",
		);
	});
}

// ── 2026-10-18 G1-1 验收（SUP-B）：独立触发 blocked_overdue ─────────────────
// 判据：BLOCKED_USER ∧ idleMs > userMs(30min)；level 触发 + 1h/runId 节流；`stagnation` 一行不改。
// 纯函数层：零 IO（不读真实账本，全部手工构造 FrontierSourceTab / FrontierSupervision）。
console.log("SUP-B blocked_overdue（BLOCKED_USER 超龄周期提醒）");
{
	const BTAB = "tab_od_1";
	const mkOdTab = (over: Partial<FrontierSourceTab> = {}): FrontierSourceTab => ({
		runId: BTAB,
		repoPath: R1,
		phase: "waiting",
		stop: "error", // stop=error ⇒ 六态派生恒 BLOCKED_USER（与 phase 无关）
		idleMs: 31 * 60_000,
		needsHuman: false,
		gate: "ok",
		staleOver: false,
		overdue: 0,
		resultMissing: false,
		pidAlive: true,
		...over,
	});
	const mkOdLedger = (over: Partial<FrontierSupervision> = {}): FrontierSupervision => ({
		runId: BTAB,
		status: "active",
		epochPushes: 0,
		...over,
	});
	/** 两帧：帧1 = baseline（prev=null）建基线，帧2 = 真差分（这才是产触发的那帧）。 */
	function twoFrames(
		tabs: FrontierSourceTab[],
		ledger: FrontierSupervision[] | undefined,
		now: number = NOW,
	): { next: FrontierSnapshot; diff: { triggers: FrontierTrigger[] } } {
		const f1 = buildFrontier({ snapshot: makeSnapshot(tabs), backlog: [], prev: null, now: now - 60_000, supervision: ledger });
		return buildFrontier({ snapshot: makeSnapshot(tabs), backlog: [], prev: f1.next, now, supervision: ledger });
	}

	check("SUP-B1 BLOCKED_USER(stop=error) + idle 31min>30min ⇒ 帧2 出 blocked_overdue（带 runId）+ blockedOverdue=true", () => {
		const { next, diff } = twoFrames([mkOdTab()], [mkOdLedger()]);
		const od = diff.triggers.filter((t) => t.rule === "blocked_overdue");
		assert.equal(od.length, 1, `必须恰 1 条 blocked_overdue，实得 ${JSON.stringify(diff.triggers)}`);
		assert.equal(od[0]!.project, K);
		assert.equal(od[0]!.runId, BTAB, "触发必须带 runId（节流键）");
		assert.equal(od[0]!.approximate, false, "非近似触发（可进动作面）");
		assert.match(od[0]!.evidence, /blocked_overdue:run=tab_od_1:idleMin=31/);
		assert.equal(next.projects[0]!.blockedOverdue, true);
		assert.equal(next.projects[0]!.blockedOverdueRunId, BTAB);
		assert.equal(next.projects[0]!.supervision.state, "BLOCKED_USER", "夹具必须落在 BLOCKED_USER");
	});

	check("SUP-B2 对照：idle 29min < 30min ⇒ 无 blocked_overdue 且 blockedOverdue=false", () => {
		const { next, diff } = twoFrames([mkOdTab({ idleMs: 29 * 60_000 })], [mkOdLedger()]);
		assert.equal(diff.triggers.some((t) => t.rule === "blocked_overdue"), false);
		assert.equal(next.projects[0]!.blockedOverdue, false);
		assert.equal(next.projects[0]!.blockedOverdueRunId, undefined);
	});

	check("SUP-B3 节流：t0 发 / t0+5min 不发 / t0+61min 再发（≤1 次/小时/runId）", () => {
		const tabs = [mkOdTab()];
		const ledger = [mkOdLedger()];
		const f1 = buildFrontier({ snapshot: makeSnapshot(tabs), backlog: [], prev: null, now: NOW - 60_000, supervision: ledger });
		// 帧2（t0）：首次提醒
		const f2 = buildFrontier({ snapshot: makeSnapshot(tabs), backlog: [], prev: f1.next, now: NOW, supervision: ledger });
		assert.deepEqual(f2.diff.triggers.filter((t) => t.rule === "blocked_overdue").map((t) => t.runId), [BTAB], "帧2 必须提醒");
		// 返工 R1：节流账改为 runId → 时刻 的映射（不再单值）
		assert.deepEqual(f2.next.projects[0]!.blockedOverdueLastAt, { [BTAB]: NOW }, "节流账必须落盘为 { runId: now }");
		assert.deepEqual(f2.next.projects[0]!.blockedOverdueRunIds, [BTAB], "超龄集合也要落盘（供诊断 + 账本收缩）");
		// 帧3（t0+5min）：窗内不提醒，但 blockedOverdue 仍为 true（载体不消失）
		const f3 = buildFrontier({ snapshot: makeSnapshot(tabs), backlog: [], prev: f2.next, now: NOW + 5 * 60_000, supervision: ledger });
		assert.equal(f3.diff.triggers.some((t) => t.rule === "blocked_overdue"), false, "窗内不得重复提醒");
		assert.equal(f3.next.projects[0]!.blockedOverdue, true, "载体仍为 true（只是被节流）");
		assert.deepEqual(f3.next.projects[0]!.blockedOverdueLastAt, { [BTAB]: NOW }, "节流账沿用，不被未发射帧刷成新值");
		// 帧4（t0+61min）：窗过期 ⇒ 再提醒
		const f4 = buildFrontier({ snapshot: makeSnapshot(tabs), backlog: [], prev: f3.next, now: NOW + 61 * 60_000, supervision: ledger });
		assert.deepEqual(f4.diff.triggers.filter((t) => t.rule === "blocked_overdue").map((t) => t.runId), [BTAB], "窗过期必须再提醒");
		assert.deepEqual(f4.next.projects[0]!.blockedOverdueLastAt, { [BTAB]: NOW + 61 * 60_000 }, "再提醒后账本刷新为 now");
		// 不变式：节流值恒为 ≥1h（常量校验，防被悄悄调小）
		assert.equal(BLOCKED_OVERDUE_THROTTLE_MS, 3_600_000, "节流窗必须 1h");
	});

	check("SUP-B4 不越界：BLOCKED_USER 项目 stagnation===false；STALLED 项目仍发 stagnation 且 blockedOverdue===false", () => {
		// (a) BLOCKED_USER：stagnation 绝不为 true（stagnation 只认 STALLED，一行未改）
		const a = twoFrames([mkOdTab()], [mkOdLedger()]);
		assert.equal(a.next.projects[0]!.stagnation, false, "BLOCKED_USER 不得变成 stagnation");
		assert.equal(a.diff.triggers.some((t) => t.rule === "stagnation"), false);
		// (b) STALLED：waiting+stop=stop+idle 16min ⇒ STALLED ⇒ stagnation 依然边沿触发，但 blockedOverdue=false
		// 边沿需要 prev.stagnation=false 作起点（用 makePrevSnap 手写，避免基线帧自己已带 stagnation=true）
		const stalledTab = mkOdTab({ stop: "stop", idleMs: 16 * 60_000 });
		const b = buildFrontier({
			snapshot: makeSnapshot([stalledTab]),
			backlog: [],
			prev: makePrevSnap(NOW - 60_000, [makeProject({ project: K, runs: { [BTAB]: "waiting" }, stagnation: false })]),
			now: NOW,
			supervision: [mkOdLedger()],
		});
		assert.equal(b.next.projects[0]!.supervision.state, "STALLED", "夹具必须落在 STALLED");
		assert.deepEqual(b.diff.triggers.map((t) => t.rule), ["stagnation"], "STALLED 仍只发 stagnation");
		assert.equal(b.next.projects[0]!.stagnation, true);
		assert.equal(b.next.projects[0]!.blockedOverdue, false, "STALLED 不得同时被算成 blocked_overdue");
	});

	check("SUP-B5 静默优先：账本 paused / optOut=true + idle 2h ⇒ 无 blocked_overdue（不问不动）", () => {
		const tabs = [mkOdTab({ idleMs: 120 * 60_000 })];
		for (const [label, ledger] of [
			["paused", [mkOdLedger({ status: "paused" })]] as const,
			["optOut", [mkOdLedger({ optOut: true })]] as const,
		]) {
			const { next, diff } = twoFrames(tabs, ledger as FrontierSupervision[]);
			assert.equal(diff.triggers.some((t) => t.rule === "blocked_overdue"), false, `${label}：不得提醒`);
			assert.equal(next.projects[0]!.blockedOverdue, false, `${label}：载体不得为 true`);
		}
	});

	check("SUP-B6 无账本：NOT_MONITORED 项目 ⇒ 无 blocked_overdue（不猜）+ supervision 不可读时零崩溃", () => {
		// (a) supervision 字段缺省（undefined ⟺ 账本目录不存在）
		const noLedger = buildFrontier({ snapshot: makeSnapshot([mkOdTab({ idleMs: 120 * 60_000 })]), backlog: [], prev: null, now: NOW });
		const f2 = buildFrontier({
			snapshot: makeSnapshot([mkOdTab({ idleMs: 120 * 60_000 })]),
			backlog: [], prev: noLedger.next, now: NOW + 60_000,
		});
		assert.equal(f2.diff.triggers.some((t) => t.rule === "blocked_overdue"), false, "无账本不得猜");
		assert.equal(f2.next.projects[0]!.supervision.state, "NOT_MONITORED");
		assert.equal(f2.next.projects[0]!.blockedOverdue, false);
		// (b) 空账本数组（账本目录存在但无条目）⇒ 同上
		const { next, diff } = twoFrames([mkOdTab({ idleMs: 120 * 60_000 })], []);
		assert.equal(diff.triggers.some((t) => t.rule === "blocked_overdue"), false);
		assert.equal(next.projects[0]!.blockedOverdue, false);
	});

	check("SUP-B7 逾期键取最重：多 tab 时 runId = idle 最大的那个（确定性）", () => {
		const tabs = [
			mkOdTab({ runId: "tab_od_a", idleMs: 31 * 60_000 }),
			mkOdTab({ runId: "tab_od_b", idleMs: 90 * 60_000 }),
		];
		const ledger = [
			mkOdLedger({ runId: "tab_od_a" }),
			mkOdLedger({ runId: "tab_od_b" }),
		];
		const { next, diff } = twoFrames(tabs, ledger);
		const od = diff.triggers.filter((t) => t.rule === "blocked_overdue");
		assert.equal(od.length, 1, "项目级只出一条（节流键单值）");
		assert.equal(od[0]!.runId, "tab_od_b", "必须取 idle 最大的 tab");
		assert.match(od[0]!.evidence, /idleMin=90/, "证据里的 idle 必须是该 runId 自身，不是项目 max 的串味");
		assert.equal(next.projects[0]!.blockedOverdueRunId, "tab_od_b");
		assert.deepEqual(next.projects[0]!.blockedOverdueRunIds, ["tab_od_b", "tab_od_a"], "全部超龄 runId 按 idle 降序收集");
	});

	// ── SUP-B8：交替最重时 per-runId 节流（返工 R1 核心；帧5 = 修复前的窗内重发红点） ──
	// 帧序与夹具**逐字段照抄**返工规格 `plans/20261018_group1_rework_spec.md` §2.1（同 idle、同帧时），
	// 因此下面的「实际 vs §2.1 期望」是严格同夹具对照。
	const ATAB = "tab_od_a";
	const BOD = "tab_od_b";
	const odLedgers: FrontierSupervision[] = [mkOdLedger({ runId: ATAB }), mkOdLedger({ runId: BOD })];
	/** a/b = 该 tab 的 idle(分钟)；null = 本帧看不见该 tab（§2.1 帧3「只有 B」）。 */
	const mkAB = (aMin: number | null, bMin: number | null): FrontierSourceTab[] => [
		...(aMin === null ? [] : [mkOdTab({ runId: ATAB, idleMs: aMin * 60_000 })]),
		...(bMin === null ? [] : [mkOdTab({ runId: BOD, idleMs: bMin * 60_000 })]),
	];
	const odRunIds = (d: { triggers: FrontierTrigger[] }): string[] =>
		d.triggers.filter((t) => t.rule === "blocked_overdue").map((t) => t.runId as string);
	/**
	 * 逐帧跑 blocked_overdue 帧序（每帧一次 buildFrontier），打印「超龄集 / 发射 / 项内投影 / 顶层账本」并返回逐帧读数。
	 * `baseNow` + `baseTabs` = 基线帧（prev=null ⇒ 零触发），之后才轮到 steps。
	 * 返工 R3：额外返回 `top` = 快照**顶层** `blockedOverdueThrottle`（权威账本）、`projectCount`（本帧可见项目数）。
	 * 项目整帧不可见时 `projects` 为空 ⇒ 投影/超龄集取缺省（不抛）。
	 */
	const runOdFrames = (
		tag: string,
		baseNow: number,
		baseTabs: FrontierSourceTab[],
		steps: Array<{ label: string; now: number; tabs: FrontierSourceTab[] }>,
	): Array<{
		label: string;
		emit: string[];
		ledger: Record<string, number> | undefined;
		runIds: string[];
		top: Record<string, Record<string, number>> | undefined;
		projectCount: number;
	}> => {
		let snap: FrontierSnapshot = buildFrontier({
			snapshot: makeSnapshot(baseTabs),
			backlog: [],
			prev: null,
			now: baseNow,
			supervision: odLedgers,
		}).next;
		const out: Array<{
			label: string;
			emit: string[];
			ledger: Record<string, number> | undefined;
			runIds: string[];
			top: Record<string, Record<string, number>> | undefined;
			projectCount: number;
		}> = [];
		for (const s of steps) {
			const r = buildFrontier({ snapshot: makeSnapshot(s.tabs), backlog: [], prev: snap, now: s.now, supervision: odLedgers });
			const p = r.next.projects[0];
			const emit = odRunIds(r.diff);
			out.push({
				label: s.label,
				emit,
				ledger: p?.blockedOverdueLastAt,
				runIds: p?.blockedOverdueRunIds ?? [],
				top: r.next.blockedOverdueThrottle,
				projectCount: r.next.projects.length,
			});
			console.log(
				`    ${tag} ${s.label.padEnd(7)} 项目数=${r.next.projects.length} 超龄集=[${(p?.blockedOverdueRunIds ?? []).join(",")}] 发射=[${emit.join(",")}] 项内投影=${JSON.stringify(p?.blockedOverdueLastAt ?? {})} 顶层账本=${JSON.stringify(r.next.blockedOverdueThrottle ?? {})}`,
			);
			snap = r.next;
		}
		return out;
	};

	check("SUP-B8 交替最重：per-runId 节流生效（帧5 不得窗内重发 B）", () => {
		const T0 = NOW;
		const steps: Array<{ label: string; now: number; tabs: FrontierSourceTab[]; spec: string[] }> = [
			{ label: "t0", now: T0, tabs: mkAB(null, 35), spec: [BOD] },
			{ label: "t0+10m", now: T0 + 10 * 60_000, tabs: mkAB(40, 45), spec: [] },
			{ label: "t0+20m", now: T0 + 20 * 60_000, tabs: mkAB(null, 55), spec: [] },
			{ label: "t0+30m", now: T0 + 30 * 60_000, tabs: mkAB(95, 65), spec: [ATAB] },
			{ label: "t0+40m", now: T0 + 40 * 60_000, tabs: mkAB(45, 75), spec: [] },
			{ label: "t0+65m", now: T0 + 65 * 60_000, tabs: mkAB(70, 100), spec: [BOD] },
		];
		// 基线帧（prev=null ⇒ 零触发，只建基线/账本）
		let snap = buildFrontier({ snapshot: makeSnapshot(mkAB(null, 35)), backlog: [], prev: null, now: T0 - 60_000, supervision: odLedgers }).next;
		const actual: string[][] = [];
		for (const s of steps) {
			const r = buildFrontier({ snapshot: makeSnapshot(s.tabs), backlog: [], prev: snap, now: s.now, supervision: odLedgers });
			const got = odRunIds(r.diff);
			actual.push(got);
			const p = r.next.projects[0]!;
			console.log(
				`    SUP-B8 ${s.label.padEnd(7)} 超龄集=[${(p.blockedOverdueRunIds ?? []).join(",")}] 发射=[${got.join(",")}] 账本=${JSON.stringify(p.blockedOverdueLastAt ?? {})}`,
			);
			snap = r.next;
		}
		// 逐帧断言（帧5 = 红点：B 在 t0 已发，t0+40m 距上次仅 40min ⇒ 必须不发）
		assert.deepEqual(actual[0], [BOD], "帧1（t0，只有 B 超龄）⇒ 发 B");
		assert.deepEqual(actual[2], [], "帧3（t0+20m，只有 B，B 窗内）⇒ 不发");
		assert.deepEqual(actual[4], [], "帧5（t0+40m，最重 B，B 距 t0 仅 40min）⇒ 不得窗内重发（本条在修复前会误发 B）");
		assert.deepEqual(actual[5], [BOD], "帧6（t0+65m，最重 B，距 t0 已 65min）⇒ 发 B");
		// 帧2：与 §2.1 期望序列不同（§2.1 写「不发」）—— 详见报告「偏离 D2」：
		// 实现按 §1.1 §3 + 任务要求②「遍历超龄 runId、跳过窗内的、每帧最多 1 条」⇒ 帧2 A(40min，无账本) 首发。
		assert.deepEqual(actual[1], [ATAB], "帧2（B 窗内 ⇒ 顺延到本小时未提醒的 A）⇒ 发 A（§2.1 期望为空；偏离 D2）");
		// 帧4：返工 R2 后节流账改为**按时间窗裁剪** ⇒ A 在帧3（当时只有 B 超龄）不再被剔除；
		// 帧4 时 A 距 t0+10m 仅 20min、B 距 t0 仅 30min ⇒ 两者均在窗内 ⇒ **不发**（与 R2 规格 §2.1 B9a 帧4 同语义）。
		assert.deepEqual(actual[3], [], "帧4（A 距 t0+10m 20min、B 距 t0 30min 均在窗内）⇒ 不得发（R2 按时间窗裁剪后）");
		console.log(
			`    SUP-B8 逐帧对照 §2.1：${steps.map((s, i) => `${s.label} 实际=[${actual[i]!.join(",")}] §2.1=[${s.spec.join(",")}]${JSON.stringify(actual[i]) === JSON.stringify(s.spec) ? "✅" : "⚠️"}`).join(" | ")}`,
		);
	});

	// ── SUP-B9a / SUP-B9b：节流账按**时间窗**裁剪（返工 R2 核心）──
	// 旧 SUP-B9 断言「B 恢复 ⇒ B 的键必须被移除」**本身就是错的**（正是 R2 缺陷的成因）：
	// tab 短暂活动（idle 掉回阈值下）会使键被剔除，之后再度超龄 ⇒ 在 1h 窗内重发。
	// 现拆为两条：B9a 钉「窗内不因暂离超龄集合而丢节流」，B9b 钉「窗过期才出账（上界仍成立）」。
	// 帧序逐字照抄 R2 规格 §2.1。
	check("SUP-B9a 窗内不因暂离超龄集合而丢节流（4 帧；帧4 = R2 修复前的窗内重发红点）", () => {
		const T0 = NOW;
		const rows = runOdFrames("SUP-B9a", T0 - 60_000, mkAB(90, 35), [
			{ label: "t0", now: T0, tabs: mkAB(90, 35) },
			{ label: "t0+10m", now: T0 + 10 * 60_000, tabs: mkAB(100, 105) },
			{ label: "t0+20m", now: T0 + 20 * 60_000, tabs: mkAB(110, null) }, // B 已恢复（不再超龄）
			{ label: "t0+25m", now: T0 + 25 * 60_000, tabs: mkAB(115, 32) }, // B 又超龄
		]);
		// ── 先断「发射」（红点本质），再断账本 ──
		// 断言顺序是刻意的：旧 keep 规则下帧3 的账本断言会先红，会掩盖「帧4 真的误发了」这个缺陷本质；
		// 变异验证要求红点落在**帧4 的 emit 断言**（actual ["tab_od_b"] vs expected []）。
		// 帧1：A(90)+B(35) 都超龄 ⇒ 发 A
		assert.deepEqual(rows[0]!.emit, [ATAB], "帧1（t0，最重 A）⇒ 发 A");
		// 帧2：B(105) 反超 A(100) ⇒ B 首次 ⇒ 发 B
		assert.deepEqual(rows[1]!.emit, [BOD], "帧2（t0+10m，最重 B 且首次）⇒ 发 B");
		// 帧3：只剩 A（B 已恢复）⇒ A 窗内 ⇒ 不发
		assert.deepEqual(rows[2]!.runIds, [ATAB], "帧3 超龄集只剩 A");
		assert.deepEqual(rows[2]!.emit, [], "帧3 A 窗内 ⇒ 不发");
		// 帧4：B 又超龄(32min) + A(115min) ⇒ 最重 A 但 A 窗内；顺延到 B ⇒ B 窗内 ⇒ **不发** ← 红点
		assert.deepEqual(
			rows[3]!.emit,
			[],
			`帧4（t0+25m：A 距 t0 25min、B 距 t0+10m 15min 均在窗内）⇒ 不得发（R2 修复前会误发 ${BOD}）`,
		);
		// ── 再断账本（窗内不因暂离超龄集合而丢节流）──
		assert.deepEqual(rows[0]!.ledger, { [ATAB]: T0 }, "帧1 账本只有 A");
		assert.deepEqual(rows[1]!.ledger, { [ATAB]: T0, [BOD]: T0 + 10 * 60_000 }, "帧2 账本含 A 与 B");
		assert.deepEqual(
			rows[2]!.ledger,
			{ [ATAB]: T0, [BOD]: T0 + 10 * 60_000 },
			"帧3 账本必须**仍含 B**（B 距 t0+10m 仅 10min，未满 1h）—— 这正是 R2 缺陷的根",
		);
		assert.equal(Object.hasOwn(rows[2]!.ledger ?? {}, BOD), true, "B 不得因「暂离超龄集合」而被剔除");
		assert.deepEqual(
			rows[3]!.ledger,
			{ [ATAB]: T0, [BOD]: T0 + 10 * 60_000 },
			"帧4 未发射 ⇒ 账本原封沿用（不被刷成新值，也不被裁掉）",
		);
	});

	check("SUP-B9b 窗过期才出账（上界仍成立）：t0+75m 时 B 的条目已过期 ⇒ 被剔除", () => {
		const T0 = NOW;
		const rows = runOdFrames("SUP-B9b", T0 - 60_000, mkAB(90, 35), [
			{ label: "t0", now: T0, tabs: mkAB(90, 35) },
			{ label: "t0+10m", now: T0 + 10 * 60_000, tabs: mkAB(100, 105) },
			{ label: "t0+20m", now: T0 + 20 * 60_000, tabs: mkAB(110, null) },
			{ label: "t0+25m", now: T0 + 25 * 60_000, tabs: mkAB(115, 32) },
			{ label: "t0+75m", now: T0 + 75 * 60_000, tabs: mkAB(165, null) }, // B 早恢复；B 的账本条目(t0+10m)已 65min
		]);
		assert.deepEqual(rows[4]!.runIds, [ATAB], "帧5 超龄集只剩 A");
		assert.deepEqual(rows[4]!.emit, [ATAB], "帧5（t0+75m：A 距 t0 已 75min）⇒ 发 A");
		assert.deepEqual(
			rows[4]!.ledger,
			{ [ATAB]: T0 + 75 * 60_000 },
			"帧5 账本：A 刷新为 now，B（t0+10m ⇒ 已 65min）过期出账",
		);
		assert.equal(Object.hasOwn(rows[4]!.ledger ?? {}, BOD), false, "B 的条目已过 1h 窗 ⇒ 必须出账（账本不无界增长）");
	});

	// ── SUP-B10：单 tab 短暂活动后不得窗内重发（主会话实测的那条，
	//    即 R2 规格 §0 的 4 帧序列，加第五帧验证窗过期）──
	// 帧序逐字照抄 R2 规格 §2.2。夹具 = 单 tab A（mkOdTab 默认 stop=error ⇒ BLOCKED_USER）。
	check("SUP-B10 单 tab 短暂活动（idle 掉回 20min）后不得在 1h 窗内重发（帧4 = 修复前必红）", () => {
		const T0 = NOW;
		const aOnly = (aMin: number): FrontierSourceTab[] => [mkOdTab({ runId: ATAB, idleMs: aMin * 60_000 })];
		const rows = runOdFrames("SUP-B10", T0 - 60_000, aOnly(20), [
			{ label: "t0", now: T0, tabs: aOnly(20) }, // 基线帧：A idle 20min 不超龄 ⇒ 压制（零发射）
			{ label: "t0+10m", now: T0 + 10 * 60_000, tabs: aOnly(45) }, // A idle 45min ⇒ **发 A**
			{ label: "t0+15m", now: T0 + 15 * 60_000, tabs: aOnly(20) }, // 掉回阈值下（tab 又活动）⇒ 不发；账本仍含 A
			{ label: "t0+20m", now: T0 + 20 * 60_000, tabs: aOnly(31) }, // 再超龄；距上次仅 10min ⇒ **不发**（修复前会误发）
			{ label: "t0+71m", now: T0 + 71 * 60_000, tabs: aOnly(82) }, // 距上次 61min > 1h ⇒ 发 A
		]);
		// ── 先断「发射」（红点本质），再断账本（同 B9a：保证变异红点落在帧4 emit）──
		// 帧1：t0 基线（A idle 20min 不超龄）⇒ 零发射
		assert.deepEqual(rows[0]!.emit, [], "帧1（t0，A idle20min 不超龄）⇒ 不发");
		assert.deepEqual(rows[0]!.runIds, [], "帧1 超龄集为空");
		// 帧2：t0+10m A idle 45min 首次超龄 ⇒ 发 A
		assert.deepEqual(rows[1]!.emit, [ATAB], "帧2（t0+10m，A idle45min 首次超龄）⇒ 发 A");
		// 帧3：A 短暂活动（idle 掉回 20min<30min）⇒ 不超龄 ⇒ 不发
		assert.deepEqual(rows[2]!.runIds, [], "帧3 A idle 20min ⇒ 不在超龄集合");
		assert.deepEqual(rows[2]!.emit, [], "帧3 不超龄 ⇒ 不发");
		// 帧4：又超龄 ⇒ 距上次发射仅 10min ⇒ **必须不发** ← 红点
		assert.deepEqual(
			rows[3]!.emit,
			[],
			`帧4（t0+20m：A 距上次发射仅 10min）⇒ 不得重发（R2 修复前会误发 ${ATAB}）`,
		);
		// 帧5：距上次 61min>1h ⇒ 发 A
		assert.deepEqual(rows[4]!.emit, [ATAB], "帧5（t0+71m，距上次 61min）⇒ 发 A");
		// ── 再断账本（「短暂活动」不得剔除键）──
		assert.equal(rows[0]!.ledger, undefined, "帧1 无账本（未发射且 prev 无记录）");
		assert.deepEqual(rows[1]!.ledger, { [ATAB]: T0 + 10 * 60_000 }, "帧2 账本 {A: t0+10m}");
		assert.deepEqual(
			rows[2]!.ledger,
			{ [ATAB]: T0 + 10 * 60_000 },
			"帧3 账本必须**仍含 A**（距上次发射 5min，未满 1h）—— R2 缺陷就在这里把 A 剔除",
		);
		assert.equal(Object.hasOwn(rows[2]!.ledger ?? {}, ATAB), true, "A 不得因「短暂活动」而被剔除");
		assert.deepEqual(rows[3]!.ledger, { [ATAB]: T0 + 10 * 60_000 }, "帧4 未发射 ⇒ 账本原封沿用");
		assert.deepEqual(rows[4]!.ledger, { [ATAB]: T0 + 71 * 60_000 }, "帧5 账本刷新为 now");
	});

	// ── SUP-B11：项目整帧消失后重现，不得窗内重发（返工 R3 核心；第3帧顶层账本断言 + 第4帧 emit = 修复前必红）──
	// 帧序逐字照抄 R3 规格 §2.2。夹具：同一 project K，tab A / tab B（mkOdTab 默认 stop=error ⇒ BLOCKED_USER）。
	check("SUP-B11 项目整帧消失（details=[]）⇒ 顶层账本保留 ⇒ 重现后不得窗内重发", () => {
		const T0 = NOW;
		// 帧序逐字照抄 R3 规格 §2.2（第 1–6 帧）；第 7 帧是**补充帧**（见下方 comment，证明 B 是「延后」而非「漏发」）。
		const rows = runOdFrames("SUP-B11", T0, mkAB(90, 35), [
			{ label: "t0+3m", now: T0 + 3 * 60_000, tabs: mkAB(93, 38) }, // 发 A（最重且首次）
			{ label: "t0+6m", now: T0 + 6 * 60_000, tabs: [] }, // 项目整帧消失（tab 全 hidden / 进程重启 / 无 tab）
			{ label: "t0+9m", now: T0 + 9 * 60_000, tabs: mkAB(99, 44) }, // 重现：A 窗内 ⇒ 不得发 A
			{ label: "t0+12m", now: T0 + 12 * 60_000, tabs: mkAB(102, null) }, // 只剩 A（最重）但窗内 ⇒ 不发
			{ label: "t0+66m", now: T0 + 66 * 60_000, tabs: mkAB(156, null) }, // A 距 t0+3m 已 63min > 1h ⇒ 发 A
			{ label: "补+3m", now: T0 + 69 * 60_000, tabs: mkAB(159, 47) }, // 补充帧：项目已连续可见 ⇒ B 首次超龄可发
		]);
		// ── 先断「发射」（红点本质）——表格式逐帧对照：一次报出**全部**不匹配帧，不在第一帧就中断 ──
		// 期望表：
		//   帧1 t0+3m  [A]   最重 A 且首次
		//   帧2 t0+6m  []    details=[]（项目整帧消失）
		//   帧3 t0+9m  []    重现帧：项目上帧不在 prev ⇒ 项目级边沿不触发（偏离 D3）；硬要求「不得发 A」
		//   帧4 t0+12m []    A 最重但距 t0+3m 仅 9min（窗内）⇒ 不得重发
		//   帧5 t0+66m [A]   A 距上次已 63min > 1h ⇒ 发
		//   帧6 t0+69m [B]   surviving 帧：B 首次超龄 ⇒ 发（证明「延后而非漏发」）
		const expectEmits: string[][] = [[ATAB], [], [], [], [ATAB], [BOD]];
		const mismatches = rows
			.map((r, i) => ({ i, label: r.label, actual: r.emit, expected: expectEmits[i]! }))
			.filter((m) => JSON.stringify(m.actual) !== JSON.stringify(m.expected))
			.map((m) => `  帧${m.i + 1}(${m.label}) actual=${JSON.stringify(m.actual)} expected=${JSON.stringify(m.expected)}`);
		assert.deepEqual(
			mismatches,
			[],
			`SUP-B11 逐帧发射不匹配（共 ${mismatches.length} 帧）：\n${mismatches.join("\n")}`,
		);
		assert.equal(rows[1]!.projectCount, 0, "帧2（t0+6m，details=[]）⇒ 本帧零项目（项目整帧消失）");
		// ── 再断顶层账本（权威账本必须跨「项目不可见」存活）──
		assert.equal(rows[1]!.ledger, undefined, "帧2 项内投影不存在（项目本帧不可见）—— 这正是旧实现丢账的地方");
		assert.deepEqual(
			rows[1]!.top,
			{ [K]: { [ATAB]: T0 + 3 * 60_000 } },
			"帧2（项目整帧消失）**顶层账本必须保留 { K: { A: t0+3m } }**（修复前顶层字段不存在/为空 ⇒ 必红）",
		);
		assert.deepEqual(
			rows[2]!.top,
			{ [K]: { [ATAB]: T0 + 3 * 60_000 } },
			"帧3 重现帧未发射 ⇒ 顶层账本原封沿用（A 仍在窗内）",
		);
		assert.deepEqual(rows[2]!.ledger, rows[2]!.top?.[K], "帧3 项内投影 === 顶层账本[K]（投影语义）");
		assert.deepEqual(rows[3]!.top, { [K]: { [ATAB]: T0 + 3 * 60_000 } }, "帧4 未发射 ⇒ 顶层账本原封沿用");
		assert.deepEqual(rows[4]!.top, { [K]: { [ATAB]: T0 + 66 * 60_000 } }, "帧5 A 刷新为 now（旧值 t0+3m 已 63min > 1h ⇒ 自然出账）");
		assert.deepEqual(rows[4]!.ledger, rows[4]!.top?.[K], "帧5 项内投影 === 顶层账本[K]");
		assert.deepEqual(
			rows[5]!.top,
			{ [K]: { [ATAB]: T0 + 66 * 60_000, [BOD]: T0 + 69 * 60_000 } },
			"帧6 顶层账本 = A 沿用 + B 记 now",
		);
	});

	// ── SUP-B12：对抗性走查回归（属性断言，非逐帧快照）──
	// 60 帧伪随机（固定种子；3 tab 同仓，随机可见性/idle 漂移与偶发活动），断言**全局不变式**：
	//   对每个 runId，任意两次 blocked_overdue 发射的时间差 ≥ BLOCKED_OVERDUE_THROTTLE_MS。
	// 这类属性断言正是能抓住 R1/R2 都漏掉的「项目整帧消失 ⇒ 账本丢失」那一类洞。
	check("SUP-B12 伪随机 60 帧不变式：同一 runId 任意两次发射间隔 ≥ 1h（0 violations）", () => {
		const mulberry32 = (seed: number): (() => number) => {
			let a = seed >>> 0;
			return () => {
				a = (a + 0x6d2b79f5) >>> 0;
				let t = a;
				t = Math.imul(t ^ (t >>> 15), t | 1);
				t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
				return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
			};
		};
		const rnd = mulberry32(0x5eed2026);
		const RIDS = ["tab_p_a", "tab_p_b", "tab_p_c"];
		const ledgers: FrontierSupervision[] = RIDS.map((runId) => mkOdLedger({ runId }));
		const idleMin: Record<string, number> = {};
		for (const r of RIDS) idleMin[r] = Math.round(rnd() * 25); // 起始 idle 全在阈值下
		const T0 = NOW;
		const tabsFor = (visible: boolean[]): FrontierSourceTab[] => {
			const out: FrontierSourceTab[] = [];
			for (let i = 0; i < RIDS.length; i++) {
				if (!visible[i]) continue;
				out.push(mkOdTab({ runId: RIDS[i]!, idleMs: Math.round(idleMin[RIDS[i]!]!) * 60_000 }));
			}
			return out;
		};
		const visibleNow = (): boolean[] => RIDS.map(() => rnd() < 0.62);
		// 基线帧（prev=null）：全可见 + 全不超龄 ⇒ 零账本
		let snap: FrontierSnapshot = buildFrontier({
			snapshot: makeSnapshot(tabsFor([true, true, true])),
			backlog: [],
			prev: null,
			now: T0 - 60_000,
			supervision: ledgers,
		}).next;
		const lastEmit = new Map<string, number>();
		let frames = 0;
		let emits = 0;
		let violations = 0;
		const violationLines: string[] = [];
		const allInvisibleFrames: number[] = [];
		for (let i = 1; i <= 60; i++) {
			const now = T0 + i * 3 * 60_000;
			// idle 漂移：可见时偶发活动（掉回阈值下）；不可见时保持「卡住」，idle 继续涨
			const vis = visibleNow();
			for (let j = 0; j < RIDS.length; j++) {
				const r = RIDS[j]!;
				if (vis[j] && rnd() < 0.16) idleMin[r] = Math.round(rnd() * 20); // 活动：idle 重置到阈值下
				else idleMin[r] = idleMin[r]! + 3;
			}
			if (vis.every((v) => !v)) allInvisibleFrames.push(i);
			const r = buildFrontier({ snapshot: makeSnapshot(tabsFor(vis)), backlog: [], prev: snap, now, supervision: ledgers });
			const emitted = odRunIds(r.diff);
			frames++;
			for (const rid of emitted) {
				emits++;
				const prevTs = lastEmit.get(rid);
				if (prevTs !== undefined && now - prevTs < BLOCKED_OVERDUE_THROTTLE_MS) {
					violations++;
					violationLines.push(
						`      帧${i} runId=${rid} 距上次发射仅 ${Math.round((now - prevTs) / 60_000)}min（<60min）`,
					);
				}
				lastEmit.set(rid, now);
			}
			snap = r.next;
		}
		console.log(
			`    SUP-B12 frames=${frames} emits=${emits} violations=${violations} 项目整帧消失帧数=${allInvisibleFrames.length}（帧号 ${allInvisibleFrames.join(",") || "无"}）`,
		);
		for (const line of violationLines.slice(0, 10)) console.log(line);
		assert.equal(violations, 0, `不变式违背：同一 runId 两次发射间隔 < 1h 共 ${violations} 次\n${violationLines.join("\n")}`);
		assert.ok(emits > 0, "夹具必须真的产生发射（否则断言空洞）");
		assert.ok(allInvisibleFrames.length > 0, "60 帧随机序列必须含「项目整帧消失」帧（否则抓不到 R3 缺陷）");
	});
}

// ── 清理 + 汇总 ─────────────────────────────────────────────────────
rmSync(ENV_TMP, { recursive: true, force: true });
rmSync(cfgRoot, { recursive: true, force: true });
rmSync(ksRoot, { recursive: true, force: true });
if (failed > 0) {
	console.error(`_test_runtime_autonomy: FAILED (${failed} failed / ${passed} passed)`);
	process.exit(1);
}
console.log(`_test_runtime_autonomy: all ${passed} checks passed`);
