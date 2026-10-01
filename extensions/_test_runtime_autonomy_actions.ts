/**
 * _test_runtime_autonomy_actions.ts — P1 可回滚动作（diagnostic-report + 全套 harness）验收
 *
 * plans/20261001_autonomy_actionable_plan.md「P1 可测验收标准 1」（覆盖点全列必含）：
 *  - 策略矩阵（L0–L3 各自 DENY(reason) / SKIP + 账本 rejected/skipped 行）
 *  - 事务正路径（attempted → precheck → executed → postverified 四行齐全、§3.2 schema；
 *    precheck 记录实际逐项判定，任一项 unknown/读失败必须拒绝且不得调用 effect）
 *  - 失配路径（故意写坏 → rolled_back + 复验通过）
 *  - 回退失败路径（删快照强回退 → rollback_failed + breaker tripped + frozen）
 *  - never-throw（所有 IO 异常 ⇒ 拒绝且不抛）
 *  - audit.jsonl 零污染（动作 tick 前后 audit.jsonl 行数不变，W6 保护性断言）
 *  - 默认关闭（actions.enabled 缺失 ⇒ 除 config 读外零 IO、零新文件）
 *  - §A 新判据（git 纪律 / 目录前缀 / 只增不删）
 *  - 演练 A（动作级回退：seed → act → undo → 逐字节/权限/存在性复原）
 *
 * 隔离：全部用 temp stateDir / temp git repo；不触真实 ~/.pi/agent/runtime（A11 先例）。
 * 运行：npx tsx extensions/_test_runtime_autonomy_actions.ts
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

import {
	ACTION_CLASS_ALLOWLIST,
	BUDGET,
	decide,
	TRIGGER_ALLOWLIST,
	type PolicyContext,
} from "./runtime/autonomy/action/policy.ts";
import {
	checkBudget,
	clearBreaker,
	defaultBreakerState,
	dedupHit,
	readBreaker,
	recordFailure,
	recordSuccess,
	tripBreaker,
	writeBreaker,
	type BreakerState,
} from "./runtime/autonomy/action/breaker.ts";
import {
	ACTIONS_LEDGER_MAX_BYTES,
	POLICY_VERSION,
	appendActionEvent,
	readActionsTail,
	readActionEvents,
	readLatestAction,
	type ActionEvent,
	type ActionKind,
} from "./runtime/autonomy/action/ledger.ts";
import { gitPostcheck, gitPorcelain, gitPrecheck } from "./runtime/autonomy/action/gitguard.ts";
import { diagnosticReportClass, type FileSnapshot } from "./runtime/autonomy/action/classes/report.ts";
import { notifyLocalMasterClass, resolveNotifyTarget } from "./runtime/autonomy/action/classes/notify.ts";
import { getActionClassRegistry, getClass } from "./runtime/autonomy/action/registry.ts";
import { localMasterAddress, localMasterScope } from "./runtime/scope.ts";
import { defaultMailboxDir } from "./runtime/mailbox.ts";
import { engageKillSwitch } from "./runtime/autonomy/kill-switch.ts";
import { runAutonomyActions, summarizeActionsStatus, undoAction } from "./runtime/autonomy/action/run.ts";
import { queryActionsWhat, queryActionsWhy, queryActionsUndo } from "./runtime/autonomy/action/replay.ts";
import { writeFrontierSnapshot } from "./runtime/autonomy/collect.ts";
import { attachMaster } from "./runtime/registry.ts";
import { masterAddress } from "./runtime/address.ts";
import { readAutonomyConfig } from "./runtime/autonomy/config.ts";

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

// ── 夹具 ─────────────────────────────────────────────────────────────
const NOW = Date.now();

function freshState(label: string): { root: string; state: string; cfgOn: string; cfgOff: string } {
	const root = mkdtempSync(join(tmpdir(), `autonomy-actions-${label}-`));
	const state = join(root, "state");
	const cfgOn = join(root, "actions-on.json");
	const cfgOff = join(root, "actions-off.json");
	writeFileSync(cfgOn, JSON.stringify({ autonomy: { enabled: true, actions: { enabled: true } } }), "utf8");
	writeFileSync(cfgOff, JSON.stringify({ autonomy: { enabled: true } }), "utf8"); // actions 缺省 = 关
	process.env.PI_RUNTIME_DIR = root;
	return { root, state, cfgOn, cfgOff };
}

function ownerSession(): string {
	const sid = "sess-ACT";
	attachMaster({ sessionId: sid });
	return sid;
}

function writeFrontier(state: string, rule: string, project: string, asof: number): void {
	writeFrontierSnapshot(
		{
			asof,
			baseline: false,
			projects: [
				{
					project, state: "Failed", variant: null, gate: "ok", runs: { r1: "failed" },
					needsUser: false, resultMissing: false, stagnation: false, overdue: 0,
					overdueRequests: [], meaningfulStateVersion: 1,
				},
			],
			triggers: [{ rule: rule as never, project, evidence: `run:r1:${rule}`, approximate: false }],
		},
		{ stateDir: state },
	);
}

/** 读某 id 在 actions.jsonl 的 kind 序列（按账本顺序）。 */
function kindsOf(id: string, state: string): string[] {
	return readActionEvents(id, { stateDir: state }).map((e) => e.kind);
}
function anyReason(state: string, reason: string): boolean {
	return readActionsTail({ stateDir: state, limit: 200 }).some((e) => e.reason === reason);
}
function auditLineCount(state: string): number {
	try {
		return readFileSync(join(state, "autonomy", "audit.jsonl"), "utf8").split("\n").filter((l) => l.length > 0).length;
	} catch {
		return 0;
	}
}
function autoCtx(over: Partial<PolicyContext> = {}): PolicyContext {
	return {
		actionsEnabled: true, killPresent: false, breakerReadable: true, breakerTripped: false, isOwner: true,
		trigger: { rule: "working_to_failed", project: "repo:X", evidence: "run:r1:working→failed", approximate: false },
		actionClass: "diagnostic-report",
		closure: true, snapshot: true, rollback: true, postverify: true, lease: true,
		inFlight: 0, newThisTick: 0, startedInLast1h: 0, consecutiveFailures: 0, dedupHit: false,
		...over,
	};
}

// ════════════════════════════ 策略矩阵（纯，L0–L3）════════════════════════
console.log("策略矩阵（L0–L3 决策树）");
check("AUTO_EXEC：全项通过", () => {
	assert.deepEqual(decide(autoCtx()), { kind: "AUTO_EXEC" });
});
check("L0 actions.enabled!==true → SKIP(actions-disabled)", () => {
	assert.deepEqual(decide(autoCtx({ actionsEnabled: false })), { kind: "SKIP", reason: "actions-disabled" });
});
check("L0 kill 在场 → DENY(kill-engaged)", () => {
	assert.deepEqual(decide(autoCtx({ killPresent: true })), { kind: "DENY", reason: "kill-engaged" });
});
check("L0 breaker 读不到 → DENY(breaker-unreadable)", () => {
	assert.deepEqual(decide(autoCtx({ breakerReadable: false })), { kind: "DENY", reason: "breaker-unreadable" });
});
check("L0 breaker tripped → DENY(breaker-tripped)", () => {
	assert.deepEqual(decide(autoCtx({ breakerTripped: true })), { kind: "DENY", reason: "breaker-tripped" });
});
check("L0 非 owner → DENY(not-owner)", () => {
	assert.deepEqual(decide(autoCtx({ isOwner: false })), { kind: "DENY", reason: "not-owner" });
});
check("L1 trigger 不在册 → DENY(trigger-not-allowed)", () => {
	assert.deepEqual(
		decide(autoCtx({ trigger: { rule: "needs_user", project: "p", evidence: "e", approximate: false } })),
		{ kind: "DENY", reason: "trigger-not-allowed" },
	);
});
check("L1 class 不在册 → DENY(class-not-allowed)", () => {
	assert.deepEqual(decide(autoCtx({ actionClass: "dispatch-isolated" })), { kind: "DENY", reason: "class-not-allowed" });
});
check("L1 approximate trigger → DENY(approximate-trigger)", () => {
	// 用在册规则（stagnation）+ approximate:true 隔离测该判据（实际 frontier 中 stagnation 恒 non-approx，
	// 此为防御性判据：在册但被标近似 ⇒ 不动手）。
	assert.deepEqual(
		decide(autoCtx({ trigger: { rule: "stagnation", project: "p", evidence: "e", approximate: true } })),
		{ kind: "DENY", reason: "approximate-trigger" },
	);
});
check("L2 效应面封闭失败 → DENY(surface-open)", () => {
	assert.deepEqual(decide(autoCtx({ closure: false })), { kind: "DENY", reason: "surface-open" });
});
check("L2 无快照 → DENY(no-snapshot)", () => {
	assert.deepEqual(decide(autoCtx({ snapshot: false })), { kind: "DENY", reason: "no-snapshot" });
});
check("L2 无回退 → DENY(no-rollback)", () => {
	assert.deepEqual(decide(autoCtx({ rollback: false })), { kind: "DENY", reason: "no-rollback" });
});
check("L2 无验证 → DENY(no-postverify)", () => {
	assert.deepEqual(decide(autoCtx({ postverify: false })), { kind: "DENY", reason: "no-postverify" });
});
check("L3 在途≥1 → DENY(budget-in-flight)", () => {
	assert.deepEqual(decide(autoCtx({ inFlight: 1 })), { kind: "DENY", reason: "budget-in-flight" });
});
check("L3 每 tick≥1 → DENY(budget-new-per-tick)", () => {
	assert.deepEqual(decide(autoCtx({ newThisTick: 1 })), { kind: "DENY", reason: "budget-new-per-tick" });
});
check("L3 1h≥2 → DENY(budget-new-per-hour)", () => {
	assert.deepEqual(decide(autoCtx({ startedInLast1h: 2 })), { kind: "DENY", reason: "budget-new-per-hour" });
});
check("L3 连败≥2 → DENY(repeat-fail)", () => {
	assert.deepEqual(decide(autoCtx({ consecutiveFailures: 2 })), { kind: "DENY", reason: "repeat-fail" });
});
check("L3 去重窗命中 → SKIP(cooldown)", () => {
	assert.deepEqual(decide(autoCtx({ dedupHit: true })), { kind: "SKIP", reason: "cooldown" });
});

// ════════════════════════════ 熔断/预算（breaker）════════════════════════
console.log("熔断/预算（breaker.json fail-closed）");
check("readBreaker：文件不存在 = 默认零计数（合法起点，非拒绝）", () => {
	const { root, state } = freshState("bk-fresh");
	try {
		assert.equal(readBreaker(state)?.inFlight, 0);
		assert.equal(readBreaker(state)?.tripped, false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
check("readBreaker：文件存在但损坏 = null（fail-closed 拒绝）", () => {
	const { root, state } = freshState("bk-corrupt");
	try {
		mkdirSync(join(state, "autonomy", "actions"), { recursive: true });
		writeFileSync(join(state, "autonomy", "actions", "breaker.json"), "{corrupt", "utf8");
		assert.equal(readBreaker(state), null);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
check("checkBudget：in-flight/new-per-tick/1h 各超限 → 对应 reason", () => {
	const tick = "T1";
	const base = defaultBreakerState(NOW);
	// in-flight
	let s: BreakerState = { ...base, inFlight: 1 };
	assert.equal(checkBudget(s, tick, NOW).reason, "budget-in-flight");
	// new-per-tick（直接构造 inFlight=0 + 本 tick 已 1，隔离测 new-per-tick 判据）
	s = { ...defaultBreakerState(NOW), inFlight: 0, newPerTick: { tickId: tick, count: 1 } };
	assert.equal(checkBudget(s, tick, NOW).reason, "budget-new-per-tick");
	// 1h（直接构造 inFlight=0 + 2 条 1h 内启动，隔离测 1h 判据）
	s = { ...defaultBreakerState(NOW), newLast1h: [new Date(NOW - 60_000).toISOString(), new Date(NOW - 30_000).toISOString()] };
	assert.equal(checkBudget(s, "T2", NOW).reason, "budget-new-per-hour");
	// 正常
	assert.equal(checkBudget(defaultBreakerState(NOW), "T1", NOW).ok, true);
});
check("连败 recordFailure 达限 → frozen（连败 2 停）", () => {
	let s = defaultBreakerState(NOW);
	s = recordFailure(s, "k", NOW);
	assert.equal(s.frozen, false, "第 1 次失败不冻结");
	s = recordFailure(s, "k", NOW);
	assert.equal(s.frozen, true, "第 2 次失败达限冻结");
});
check("tripBreaker → tripped+frozen；clearBreaker → 复位", () => {
	let s = tripBreaker(defaultBreakerState(NOW), NOW);
	assert.equal(s.tripped, true);
	assert.equal(s.frozen, true);
	s = clearBreaker(s, NOW);
	assert.equal(s.tripped, false);
	assert.equal(s.frozen, false);
});
check("dedupHit：1h 窗内命中 / 窗外不命中", () => {
	const s: BreakerState = { ...defaultBreakerState(NOW), dedup: { "stagnation:repo:X": new Date(NOW - 1000).toISOString() } };
	assert.equal(dedupHit(s, "stagnation:repo:X", NOW), true);
	assert.equal(dedupHit(s, "stagnation:repo:X", NOW + BUDGET.hourMs + 1000), false);
});

// ════════════════════════════ 账本（actions.jsonl）════════════════════════
console.log("账本（actions.jsonl 轮转 + never-throw）");
check("appendActionEvent + readActionsTail 往返（schema 字段齐全）", () => {
	const { root, state } = freshState("led-round");
	try {
		const ev: ActionEvent = {
			v: 1, id: "act_x", kind: "attempted", ts: new Date(NOW).toISOString(), policyVersion: POLICY_VERSION,
			trigger: { rule: "stagnation", project: "repo:X", evidence: "e", approximate: false },
			actionClass: "diagnostic-report", intent: "collect stagnation evidence",
		};
		assert.equal(appendActionEvent(ev, state), true);
		const tail = readActionsTail({ stateDir: state, limit: 5 });
		assert.equal(tail.length, 1);
		assert.equal(tail[0]!.id, "act_x");
		assert.equal(tail[0]!.policyVersion, "actions-v1");
		assert.equal(readLatestAction("act_x", { stateDir: state })?.kind, "attempted");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
check("轮转：超 ~1MB → 两代 rename（.1 出现，现文件变小）", () => {
	const { root, state } = freshState("led-rotate");
	try {
		const dir = join(state, "autonomy", "actions");
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "actions.jsonl");
		// 预置超过上限的内容
		writeFileSync(file, "x".repeat(ACTIONS_LEDGER_MAX_BYTES + 10), "utf8");
		const ev: ActionEvent = {
			v: 1, id: "act_rot", kind: "executed", ts: new Date(NOW).toISOString(), policyVersion: POLICY_VERSION,
			trigger: { rule: "stagnation", project: "p", evidence: "e", approximate: false }, actionClass: "diagnostic-report",
		};
		appendActionEvent(ev, state);
		assert.ok(existsSync(`${file}.1`), "轮转产生 .1（两代）");
		assert.ok(statSync(file).size < ACTIONS_LEDGER_MAX_BYTES, "现文件轮转后小于上限");
		// 新行可读
		assert.equal(readActionsTail({ stateDir: state, limit: 5 })[0]?.id, "act_rot");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
check("账本 never-throw：stateDir 指向普通文件 → 不抛、返回 false", () => {
	const { root } = freshState("led-throw");
	try {
		const blockPath = join(root, "blockfile");
		writeFileSync(blockPath, "x", "utf8");
		let threw = false;
		let ret: boolean = true;
		try {
			ret = appendActionEvent(
				{ v: 1, id: "a", kind: "attempted", ts: "", policyVersion: POLICY_VERSION, trigger: { rule: "stagnation", project: "p", evidence: "e", approximate: false }, actionClass: "diagnostic-report" },
				blockPath,
			);
		} catch {
			threw = true;
		}
		assert.equal(threw, false, "不抛");
		assert.equal(ret, false, "写失败返回 false");
		assert.deepEqual(readActionsTail({ stateDir: blockPath }), [], "读不可读 → []");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ════════════════════════════ 报告类（report）+ §A 目录前缀/只增不删 ════════════════════════════
console.log("报告类（快照/原子写/回读/回退）+ §A 目录前缀");
check("withinSurface：效应面内 true / 越界 false / 前缀撞车 false", () => {
	assert.equal(diagnosticReportClass.withinSurface("/s", diagnosticReportClass.targetPath("/s", "repo:X", NOW)), true, "面内");
	assert.equal(diagnosticReportClass.withinSurface("/s", join("/s", "autonomy", "actions", "reports-evil", "x.md")), false, "前缀撞车");
	assert.equal(diagnosticReportClass.withinSurface("/s", join("/s", "autonomy", "actions", "other", "x.md")), false, "越界");
	assert.equal(diagnosticReportClass.withinSurface("/s", join("/s", "autonomy", "actions", "reports")), false, "目录本身非其内文件");
});
check("allowedPrefixes 声明仅 reports/ 子目录（文件夹分好）", () => {
	assert.deepEqual(diagnosticReportClass.allowedPrefixes("/s"), [join("/s", "autonomy", "actions", "reports")]);
});
check("snapshot：存在 → 原字节+mode；不存在 → existed:false", () => {
	const { root, state } = freshState("rep-snap");
	try {
		const p = join(state, "autonomy", "actions", "reports", "seed.md");
		mkdirSync(dirnameOf(p), { recursive: true });
		writeFileSync(p, "SEED", "utf8");
		const st = statSync(p);
		const s1 = diagnosticReportClass.snapshot(p);
		assert.equal(s1?.existed, true);
		assert.equal(s1?.bytes?.toString("utf8"), "SEED");
		assert.equal(s1?.mode, st.mode);
		const s2 = diagnosticReportClass.snapshot(join(state, "autonomy", "actions", "reports", "nope.md"));
		assert.equal(s2?.existed, false);
		assert.equal(s2?.bytes, null);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
check("effect：原子写（tmp+rename）+ deletedFiles 恒空（只增不删）", () => {
	const { root, state } = freshState("rep-eff");
	try {
		const p = join(state, "autonomy", "actions", "reports", "a.md");
		const r = diagnosticReportClass.effect(p, "content-123");
		assert.ok(r !== null);
		assert.equal(r!.bytes, Buffer.byteLength("content-123", "utf8"));
		assert.deepEqual(r!.deletedFiles, [], "只增不删：effect 不删既有文件");
		assert.equal(readFileSync(p, "utf8"), "content-123");
		// 无 .tmp 残留
		const tmps = readdirTmps(dirnameOf(p));
		assert.deepEqual(tmps, [], "原子写无 .tmp 残留");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
check("postverify：match / mismatch / unknown（读失败）", () => {
	const { root, state } = freshState("rep-pv");
	try {
		const p = join(state, "autonomy", "actions", "reports", "pv.md");
		diagnosticReportClass.effect(p, "AAA");
		assert.equal(diagnosticReportClass.postverify(p, "AAA"), "match");
		assert.equal(diagnosticReportClass.postverify(p, "BBB"), "mismatch");
		assert.equal(diagnosticReportClass.postverify(join(state, "nope.md"), "x"), "unknown");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
check("事务失配单元：snapshot→effect→写坏→postverify mismatch→rollback→reverify match", () => {
	const { root, state } = freshState("rep-mismatch");
	try {
		const p = join(state, "autonomy", "actions", "reports", "mm.md");
		mkdirSync(dirnameOf(p), { recursive: true });
		writeFileSync(p, "ORIGINAL", "utf8");
		const snap = diagnosticReportClass.snapshot(p)!;
		diagnosticReportClass.effect(p, "NEW-CONTENT");
		// 故意写坏（模拟并发写者/损坏）
		writeFileSync(p, "CORRUPTED", "utf8");
		assert.equal(diagnosticReportClass.postverify(p, "NEW-CONTENT"), "mismatch");
		const rb = diagnosticReportClass.rollback(snap);
		assert.equal(rb.ok, true);
		assert.deepEqual(rb.deletedFiles, []);
		assert.equal(diagnosticReportClass.postverify(p, "ORIGINAL"), "match", "回退后复验通过");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ════════════════════════════ gitguard（§A ③ git 纪律）════════════════════════
console.log("gitguard（§A git 纪律：干净/越界/fail-closed）");
function makeGitRepo(label: string): string {
	const root = mkdtempSync(join(tmpdir(), `autonomy-actions-git-${label}-`));
	spawnSync("git", ["init", "-q"], { cwd: root });
	spawnSync("git", ["config", "user.email", "t@t.t"], { cwd: root });
	spawnSync("git", ["config", "user.name", "t"], { cwd: root });
	writeFileSync(join(root, "tracked.txt"), "v1\n", "utf8");
	spawnSync("git", ["add", "tracked.txt"], { cwd: root });
	spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
	return root;
}
check("gitPorcelain：clean repo → []（只读 spawnSync）", () => {
	const root = makeGitRepo("clean");
	try {
		assert.deepEqual(gitPorcelain(root), []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
check("gitPrecheck untracked（P1 常态）：clean → ok + baseline", () => {
	const root = makeGitRepo("pre-untracked");
	try {
		const r = gitPrecheck(root, { tracked: false });
		assert.equal(r.ok, true);
		assert.deepEqual(r.baseline, []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
check("gitPrecheck tracked：clean → DENY(tracked-needs-commit，autonomy 不代人 commit)", () => {
	const root = makeGitRepo("pre-tracked");
	try {
		const r = gitPrecheck(root, { tracked: true });
		assert.equal(r.ok, false);
		assert.match(r.reason!, /tracked-needs-commit/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
check("gitPrecheck tracked + dirty → DENY(workspace-dirty)", () => {
	const root = makeGitRepo("pre-dirty");
	try {
		writeFileSync(join(root, "tracked.txt"), "MODIFIED\n", "utf8");
		const r = gitPrecheck(root, { tracked: true });
		assert.equal(r.ok, false);
		assert.equal(r.reason, "workspace-dirty");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
check("gitPostcheck untracked：出现新条目 → 违规（newEntries 落账）", () => {
	const root = makeGitRepo("post-new");
	try {
		const baseline = gitPorcelain(root)!;
		writeFileSync(join(root, "stray.txt"), "x\n", "utf8"); // 未跟踪新文件
		const r = gitPostcheck(root, baseline, { tracked: false });
		assert.equal(r.ok, false);
		assert.equal(r.reason, "porcelain-new-entry");
		assert.ok(r.newEntries!.some((e) => e.includes("stray.txt")));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
check("gitPrecheck fail-closed：非 git 仓 → git-unknown → DENY", () => {
	const root = mkdtempSync(join(tmpdir(), "autonomy-actions-git-norepo-"));
	try {
		const r = gitPrecheck(root, { tracked: false });
		assert.equal(r.ok, false);
		assert.match(r.reason!, /git-unknown/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

/**
 * 造一个真 git 仓，stateDir 在仓内，且 frontier 已 commit（state/ 成为 tracked 且 clean）。
 * 这样 action effect 写入的报告 = 仓内**新未跟踪**条目（porcelain 新增），可被后置逐项比对检出。
 * 自建自毁 tmp 仓；不碰本仓工作区（A11 隔离先例）。
 */
function makeGitRepoWithState(label: string, rule: string, project: string, asof: number): { repo: string; root: string; state: string; cfgOn: string } {
	const root = mkdtempSync(join(tmpdir(), `autonomy-actions-gitstate-${label}-`));
	const repo = root; // 仓根 = temp 根
	spawnSync("git", ["init", "-q"], { cwd: repo });
	spawnSync("git", ["config", "user.email", "t@t.t"], { cwd: repo });
	spawnSync("git", ["config", "user.name", "t"], { cwd: repo });
	writeFileSync(join(repo, "tracked.txt"), "v1\n", "utf8");
	const state = join(repo, "state");
	process.env.PI_RUNTIME_DIR = root;
	// 预置有效 frontier 并 commit（使 state/ tracked 且 clean；报告写入才会产生 NEW untracked 条目）
	writeFrontier(state, rule, project, asof);
	spawnSync("git", ["add", "-A"], { cwd: repo });
	spawnSync("git", ["commit", "-q", "-m", "init-with-state"], { cwd: repo });
	const cfgOn = join(root, "actions-on.json");
	writeFileSync(cfgOn, JSON.stringify({ autonomy: { enabled: true, actions: { enabled: true } } }), "utf8");
	return { repo, root, state, cfgOn };
}

// ════════════════════════════ 事务正路径（run 编排）════════════════════════
console.log("事务正路径（run 编排：attempted→precheck→executed→postverified）");
check("正路径：四行齐全 + §3.2 schema + 报告落盘 + precheck 逐项判定", () => {
	const { root, state, cfgOn } = freshState("run-happy");
	try {
		const sid = ownerSession();
		const t = NOW;
		writeFrontier(state, "working_to_failed", "repo:X", t);
		runAutonomyActions({ stateDir: state, configPath: cfgOn, sessionId: sid, now: t, repoRoot: undefined });
		const events = readActionsTail({ stateDir: state, limit: 50 });
		// 四行
		const kinds = events.map((e) => e.kind);
		assert.deepEqual(kinds, ["attempted", "precheck", "executed", "postverified"], "四行齐全且有序");
		// schema 字段
		const id = events[0]!.id;
		assert.ok(id.startsWith("act_"));
		for (const e of events) {
			assert.equal(e.v, 1);
			assert.equal(e.policyVersion, "actions-v1");
			assert.equal(e.actionClass, "diagnostic-report");
			assert.equal(e.trigger.rule, "working_to_failed");
			assert.equal(e.trigger.project, "repo:X");
			assert.equal(e.trigger.approximate, false);
		}
		// precheck 记录 L0–L3 逐项
		const pre = events.find((e) => e.kind === "precheck")!;
		assert.ok(pre.precheck!.L0 && pre.precheck!.L1 && pre.precheck!.L2 && pre.precheck!.L3, "precheck 含 L0–L3");
		// 报告落盘（效应面内）
		const reports = join(state, "autonomy", "actions", "reports");
		const files = readdirSyncSafe(reports).filter((f) => f.endsWith(".md"));
		assert.equal(files.length, 1, "恰好 1 份报告");
		const content = readFileSync(join(reports, files[0]!), "utf8");
		assert.ok(content.includes("working_to_failed") && content.includes("repo:X"), "报告含触发证据");
		// executed 记录效应路径 + 字节
		const exec = events.find((e) => e.kind === "executed")!;
		assert.equal(exec.effect!.paths.length, 1);
		assert.ok(exec.effect!.bytes > 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
check("audit.jsonl 零污染：动作 tick 前后 audit 行数不变（W6 保护）", () => {
	const { root, state, cfgOn } = freshState("run-audit-zero");
	try {
		const sid = ownerSession();
		const before = auditLineCount(state);
		writeFrontier(state, "stagnation", "repo:Y", NOW);
		runAutonomyActions({ stateDir: state, configPath: cfgOn, sessionId: sid, now: NOW });
		const after = auditLineCount(state);
		assert.equal(after, before, "audit.jsonl 行数不变（动作事件只进 actions.jsonl）");
		// 且 actions.jsonl 有内容
		assert.ok(readActionsTail({ stateDir: state, limit: 5 }).length > 0, "actions.jsonl 有事件");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
check("默认关闭：actions 缺省 ⇒ 除 config 读外零 IO、零新文件", () => {
	const { root, state, cfgOff } = freshState("run-off");
	try {
		const sid = ownerSession();
		writeFrontier(state, "working_to_failed", "repo:Z", NOW);
		runAutonomyActions({ stateDir: state, configPath: cfgOff, sessionId: sid, now: NOW });
		assert.equal(existsSync(join(state, "autonomy", "actions")), false, "actions/ 目录未创建（零新文件）");
		assert.equal(existsSync(join(state, "autonomy", "actions.jsonl")), false);
		assert.equal(readActionsTail({ stateDir: state, limit: 5 }).length, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
check("TOCTOU 复验：frontier 快照越过 2 tick ⇒ SKIP(stale)，不执行", () => {
	const { root, state, cfgOn } = freshState("run-stale");
	try {
		const sid = ownerSession();
		const t = NOW;
		writeFrontier(state, "working_to_failed", "repo:S", t);
		// now 比快照 asof 晚 > 2 tick（60s）→ stale
		runAutonomyActions({ stateDir: state, configPath: cfgOn, sessionId: sid, now: t + 5 * BUDGET.tickMs });
		const events = readActionsTail({ stateDir: state, limit: 50 });
		assert.ok(events.some((e) => e.kind === "skipped" && e.reason?.includes("stale")), "SKIP(stale) 落账");
		assert.ok(!events.some((e) => e.kind === "executed"), "未执行 effect");
		assert.equal(readdirSyncSafe(join(state, "autonomy", "actions", "reports")).length, 0, "无报告产出");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
check("预算 1/tick：同 tick 第二次 → DENY(budget-new-per-tick)", () => {
	const { root, state, cfgOn } = freshState("run-1tick");
	try {
		const sid = ownerSession();
		// tick 对齐：t = 本 tick 起点 ⇒ t 与 t+1000 同属一个 tick（避免跨 tick 边界抖动）
		const t = Math.floor(NOW / BUDGET.tickMs) * BUDGET.tickMs;
		writeFrontier(state, "working_to_failed", "repo:T1", t);
		runAutonomyActions({ stateDir: state, configPath: cfgOn, sessionId: sid, now: t });
		runAutonomyActions({ stateDir: state, configPath: cfgOn, sessionId: sid, now: t + 1000 }); // 同 tick
		assert.ok(anyReason(state, "budget-new-per-tick"), "第二次同 tick 被预算拒");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
check("预算 1h≤2：三项目跨 tick 第 3 个 → DENY(budget-new-per-hour)", () => {
	const { root, state, cfgOn } = freshState("run-1h");
	try {
		const sid = ownerSession();
		const t = NOW;
		writeFrontier(state, "working_to_failed", "repo:H1", t);
		runAutonomyActions({ stateDir: state, configPath: cfgOn, sessionId: sid, now: t });
		writeFrontier(state, "working_to_failed", "repo:H2", t + 60_000);
		runAutonomyActions({ stateDir: state, configPath: cfgOn, sessionId: sid, now: t + 60_000 });
		writeFrontier(state, "working_to_failed", "repo:H3", t + 120_000);
		runAutonomyActions({ stateDir: state, configPath: cfgOn, sessionId: sid, now: t + 120_000 });
		assert.ok(anyReason(state, "budget-new-per-hour"), "第 3 个（1h 内）被预算拒");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ════════════════════════════ 演练 A（动作级回退 undoAction）════════════════════════
console.log("演练 A（动作级回退：seed → act → undo → 逐字节/权限/存在性复原）");
check("A.1 原存在：act 改写 → undo → 字节+权限复原 + rolled_back", () => {
	const { root, state, cfgOn } = freshState("undo-exist");
	try {
		const sid = ownerSession();
		const t = NOW;
		// 预置 SEED 报告（同 target 路径：project=repo:U1, ts=t）
		const target = diagnosticReportClass.targetPath(state, "repo:U1", t);
		mkdirSync(dirnameOf(target), { recursive: true });
		writeFileSync(target, "SEED", "utf8");
		const origMode = statSync(target).mode;
		const origBytes = readFileSync(target);
		writeFrontier(state, "working_to_failed", "repo:U1", t);
		runAutonomyActions({ stateDir: state, configPath: cfgOn, sessionId: sid, now: t });
		// 动作已改写文件
		assert.notEqual(readFileSync(target, "utf8"), "SEED", "动作已改写");
		const id = readActionsTail({ stateDir: state, limit: 50 })[0]!.id;
		// 断言四行
		assert.deepEqual(kindsOf(id, state), ["attempted", "precheck", "executed", "postverified"]);
		// undo
		const r = undoAction(id, { stateDir: state, now: t + 1000 });
		assert.equal(r.ok, true);
		assert.deepEqual(readFileSync(target), origBytes, "字节复原");
		assert.equal(statSync(target).mode, origMode, "权限复原");
		assert.ok(kindsOf(id, state).includes("rolled_back"), "账本出现 rolled_back");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
check("A.2 原不存在：act 新建 → undo → 仍不存在（存在性语义恢复）+ rolled_back", () => {
	const { root, state, cfgOn } = freshState("undo-new");
	try {
		const sid = ownerSession();
		const t = NOW;
		const target = diagnosticReportClass.targetPath(state, "repo:U2", t);
		assert.equal(existsSync(target), false, "预置前不存在");
		writeFrontier(state, "working_to_failed", "repo:U2", t);
		runAutonomyActions({ stateDir: state, configPath: cfgOn, sessionId: sid, now: t });
		assert.equal(existsSync(target), true, "动作新建了报告");
		const id = readActionsTail({ stateDir: state, limit: 50 })[0]!.id;
		const r = undoAction(id, { stateDir: state, now: t + 1000 });
		assert.equal(r.ok, true);
		assert.equal(existsSync(target), false, "undo 后仍不存在（存在性恢复）");
		assert.ok(kindsOf(id, state).includes("rolled_back"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
check("A.3 删快照强回退 → rollback_failed + breaker tripped + frozen", () => {
	const { root, state, cfgOn } = freshState("undo-nosnap");
	try {
		const sid = ownerSession();
		const t = NOW;
		writeFrontier(state, "working_to_failed", "repo:U3", t);
		runAutonomyActions({ stateDir: state, configPath: cfgOn, sessionId: sid, now: t });
		const id = readActionsTail({ stateDir: state, limit: 50 })[0]!.id;
		// 删除快照目录（强回退无句柄数据源）
		rmSync(join(state, "autonomy", "actions", "snaps", id), { recursive: true, force: true });
		const r = undoAction(id, { stateDir: state, now: t + 1000 });
		assert.equal(r.ok, false);
		const k = kindsOf(id, state);
		assert.ok(k.includes("rollback_failed"), "rollback_failed 落账");
		assert.ok(k.includes("frozen"), "frozen 落账");
		const br = readBreaker(state)!;
		assert.equal(br.tripped, true, "breaker tripped");
		assert.equal(br.frozen, true, "breaker frozen");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
check("A.4 熔断后冻结：后续动作全拒（breaker-tripped）", () => {
	const { root, state, cfgOn } = freshState("undo-frozen");
	try {
		const sid = ownerSession();
		const t = NOW;
		writeFrontier(state, "working_to_failed", "repo:U4", t);
		runAutonomyActions({ stateDir: state, configPath: cfgOn, sessionId: sid, now: t });
		const id = readActionsTail({ stateDir: state, limit: 50 })[0]!.id;
		rmSync(join(state, "autonomy", "actions", "snaps", id), { recursive: true, force: true });
		undoAction(id, { stateDir: state, now: t + 1000 }); // → tripped + frozen
		// 新 tick 再触发 → 被熔断拒
		writeFrontier(state, "working_to_failed", "repo:U4b", t + 60_000);
		runAutonomyActions({ stateDir: state, configPath: cfgOn, sessionId: sid, now: t + 60_000 });
		assert.ok(anyReason(state, "breaker-tripped"), "冻结后新动作被拒");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ════════════════════════════ §A git 纪律集成 + 状态行 + 常量 ════════════════════════════
console.log("§A 集成 + 状态行 + 常量守卫");
check("git 纪律集成：P1 报告在仓外 ⇒ 前后 porcelain 一致 ⇒ postverified（不冻结）", () => {
	const repo = makeGitRepo("int-git");
	const { root, state, cfgOn } = freshState("run-git");
	try {
		const sid = ownerSession();
		const t = NOW;
		// state 在 repo 外（temp 独立目录）→ 报告不进入 repo porcelain
		writeFrontier(state, "working_to_failed", "repo:G1", t);
		runAutonomyActions({ stateDir: state, configPath: cfgOn, sessionId: sid, now: t, repoRoot: repo });
		const events = readActionsTail({ stateDir: state, limit: 50 });
		assert.ok(events.some((e) => e.kind === "postverified"), "porcelain 一致 → 正常 postverified");
		assert.ok(!events.some((e) => e.kind === "frozen"), "未冻结（报告在仓外，不污染 porcelain）");
	} finally {
		rmSync(repo, { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	}
});
check("git 违规冻结集成：effect 在仓内产生新未跟踪文件 ⇒ postcheck 失配 → 回退 + 熔断 + frozen + 账本如实", () => {
	// stateDir 在仓内 + frontier 已 commit（clean）⇒ 报告写入 = 仓内新未跟踪条目（porcelain 新增）
	const { repo, root, state, cfgOn } = makeGitRepoWithState("viol-untracked", "working_to_failed", "repo:V1", NOW);
	try {
		const sid = ownerSession();
		const t = NOW;
		runAutonomyActions({ stateDir: state, configPath: cfgOn, sessionId: sid, now: t, repoRoot: repo });
		const events = readActionsTail({ stateDir: state, limit: 50 });
		assert.ok(events.length > 0, "账本有事件");
		const id = events[0]!.id;
		const kinds = readActionEvents(id, { stateDir: state }).map((e) => e.kind);
		assert.ok(kinds.includes("executed"), "effect 已执行");
		assert.ok(kinds.includes("rollback_failed"), "postcheck 失配 → rollback_failed 落账");
		assert.ok(kinds.includes("frozen"), "frozen 落账");
		// 越界清单如实落账（git-post 原因含 porcelain 新增条目）
		const rf = events.find((e) => e.kind === "rollback_failed");
		assert.ok(rf!.reason!.includes("git-post"), `rollback_failed 原因含 git-post：${rf!.reason}`);
		assert.ok(rf!.reason!.includes("porcelain-new-entry"), `原因含 porcelain-new-entry：${rf!.reason}`);
		// breaker tripped + frozen（熔断 + 冻结）
		const br = readBreaker(state)!;
		assert.equal(br.tripped, true, "breaker tripped");
		assert.equal(br.frozen, true, "breaker frozen");
		// 回退后报告文件应被删除（恢复原状：原不存在）
		const reports = join(state, "autonomy", "actions", "reports");
		assert.equal(readdirSyncSafe(reports).filter((f) => f.endsWith(".md")).length, 0, "回退后报告已删（存在性恢复）");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
check("git tracked 分支集成：前置脏 → DENY(workspace-dirty)；前置净 → DENY(tracked-needs-commit，不代人 commit)", () => {
	// 前置脏：tracked 文件被改（未提交）→ gitPrecheck(tracked) 必 DENY(workspace-dirty)
	const dirty = makeGitRepo("int-tracked-dirty");
	try {
		writeFileSync(join(dirty, "tracked.txt"), "MODIFIED\n", "utf8");
		const rDirty = gitPrecheck(dirty, { tracked: true });
		assert.equal(rDirty.ok, false);
		assert.equal(rDirty.reason, "workspace-dirty", "前置脏 → DENY(workspace-dirty)");
	} finally {
		rmSync(dirty, { recursive: true, force: true });
	}
	// 前置净：tracked 文件 clean → autonomy 不代人 commit ⇒ DENY(tracked-needs-commit)
	const clean = makeGitRepo("int-tracked-clean");
	try {
		const rClean = gitPrecheck(clean, { tracked: true });
		assert.equal(rClean.ok, false);
		assert.match(rClean.reason!, /tracked-needs-commit/, "前置净 → DENY(tracked-needs-commit)");
	} finally {
		rmSync(clean, { recursive: true, force: true });
	}
});
check("summarizeActionsStatus：无动作 → 「disabled/无记录」；有动作 → 最近+breaker", () => {
	const { root, state, cfgOff } = freshState("status-none");
	try {
		assert.deepEqual(summarizeActionsStatus({ stateDir: state, configPath: cfgOff }), ["actions: disabled/无记录"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
	const { root: r2, state: s2, cfgOn } = freshState("status-yes");
	try {
		const sid = ownerSession();
		writeFrontier(s2, "stagnation", "repo:ST", NOW);
		runAutonomyActions({ stateDir: s2, configPath: cfgOn, sessionId: sid, now: NOW });
		const lines = summarizeActionsStatus({ stateDir: s2, configPath: cfgOn });
		assert.ok(lines[0]!.includes("enabled=on") && lines[0]!.includes("breaker=ok"), `首行含 enabled+breaker：${lines[0]}`);
		assert.ok(lines.some((l) => l.includes("recent:")), "含最近动作行");
		assert.ok(lines.length <= 5, "≤5 行");
	} finally {
		rmSync(r2, { recursive: true, force: true });
	}
});
check("预算常量硬编码（设计 §2；不可经 config 放大）", () => {
	assert.equal(BUDGET.maxNewPerTick, 1);
	assert.equal(BUDGET.maxInFlight, 1);
	assert.equal(BUDGET.maxNewPerHour, 2);
	assert.equal(BUDGET.consecFailLimit, 2);
	assert.equal(BUDGET.maxReadBytes, 256 * 1024);
	assert.equal(BUDGET.maxWallClockMs, 5000);
	assert.equal(TRIGGER_ALLOWLIST.size, 2);
	assert.equal(ACTION_CLASS_ALLOWLIST.size, 2); // 阶段二：diagnostic-report + notify-local-master
});
check("config 归一：actions 严格 === true；缺键/垃圾 = false", () => {
	const { root, state } = freshState("cfg-norm");
	try {
		const p = join(root, "norm.json");
		writeFileSync(p, JSON.stringify({ autonomy: { enabled: true, actions: { enabled: true } } }), "utf8");
		assert.equal(readAutonomyConfig({ configPath: p }).actions.enabled, true);
		writeFileSync(p, JSON.stringify({ autonomy: { enabled: true, actions: { enabled: "yes" } } }), "utf8");
		assert.equal(readAutonomyConfig({ configPath: p }).actions.enabled, false, "非严格 true 回落 false");
		writeFileSync(p, JSON.stringify({ autonomy: { enabled: true } }), "utf8");
		assert.equal(readAutonomyConfig({ configPath: p }).actions.enabled, false, "缺键 = false");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ════════════════════════════ never-throw IO 故障注入 ════════════════════════════
console.log("never-throw IO 故障注入（拒绝且不抛 + 账本/状态如实）");
check("IO：ledger 追加失败（actions.jsonl 为目录 ⇒ EISDIR）⇒ 不抛 + 拒绝 + 无 effect + 无 postverified", () => {
	const { root, state, cfgOn } = freshState("io-ledger");
	try {
		// 使 actions.jsonl 成为目录 ⇒ appendFileSync EISDIR ⇒ 追加失败（never-throw 收敛）
		mkdirSync(join(state, "autonomy", "actions", "actions.jsonl"), { recursive: true });
		const sid = ownerSession();
		writeFrontier(state, "working_to_failed", "repo:IL", NOW);
		let threw = false;
		try {
			runAutonomyActions({ stateDir: state, configPath: cfgOn, sessionId: sid, now: NOW });
		} catch {
			threw = true;
		}
		assert.equal(threw, false, "不抛（never-throw）");
		// 账本如实：actions.jsonl 是目录，读不到有效事件（不猜）
		assert.deepEqual(readActionsTail({ stateDir: state, limit: 5 }), [], "账本不可读 → []（如实）");
		// fail-closed：账本写不进 ⇒ 拒绝动作 ⇒ 无 effect（不留无审计的动作）
		const reports = join(state, "autonomy", "actions", "reports");
		assert.equal(readdirSyncSafe(reports).filter((f) => f.endsWith(".md")).length, 0, "无报告产出（fail-closed 拒绝）");
		// 无 postverified 终态（账本不可读 ⇒ 无事件 ⇒ 无 postverified）
		assert.equal(readActionsTail({ stateDir: state, limit: 5 }).some((e) => e.kind === "postverified"), false, "无 postverified 终态");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
check("IO：breaker 读失败（损坏）⇒ DENY(breaker-unreadable) 且不抛 + 无 effect", () => {
	const { root, state, cfgOn } = freshState("io-breaker");
	try {
		// 损坏 breaker.json ⇒ readBreaker null ⇒ fail-closed DENY
		mkdirSync(join(state, "autonomy", "actions"), { recursive: true });
		writeFileSync(join(state, "autonomy", "actions", "breaker.json"), "{corrupt", "utf8");
		const sid = ownerSession();
		writeFrontier(state, "working_to_failed", "repo:IB", NOW);
		let threw = false;
		try {
			runAutonomyActions({ stateDir: state, configPath: cfgOn, sessionId: sid, now: NOW });
		} catch {
			threw = true;
		}
		assert.equal(threw, false, "不抛");
		assert.ok(anyReason(state, "breaker-unreadable"), "DENY(breaker-unreadable) 落账");
		assert.equal(readdirSyncSafe(join(state, "autonomy", "actions", "reports")).length, 0, "无报告产出（未执行 effect）");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
check("IO：快照读失败（target 为目录 ⇒ readFileSync EISDIR）⇒ DENY(no-snapshot) 且不抛", () => {
	const { root, state, cfgOn } = freshState("io-snap");
	try {
		const sid = ownerSession();
		const t = NOW;
		// 使 target 路径成为目录 ⇒ snapshot readFileSync EISDIR ⇒ null ⇒ DENY(no-snapshot)
		const target = diagnosticReportClass.targetPath(state, "repo:IS", t);
		mkdirSync(target, { recursive: true });
		writeFrontier(state, "working_to_failed", "repo:IS", t);
		let threw = false;
		try {
			runAutonomyActions({ stateDir: state, configPath: cfgOn, sessionId: sid, now: t });
		} catch {
			threw = true;
		}
		assert.equal(threw, false, "不抛");
		assert.ok(anyReason(state, "no-snapshot"), "DENY(no-snapshot) 落账");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
check("IO：报告目录不可写（reports 为文件 ⇒ 原子写 mkdir 失败）⇒ DENY(effect-failed) 且不抛", () => {
	const { root, state, cfgOn } = freshState("io-repdir");
	try {
		const sid = ownerSession();
		const t = NOW;
		// 使 reports 成为一个文件 ⇒ effect 的 mkdirSync(dirname) 失败 ⇒ null ⇒ DENY(effect-failed)
		mkdirSync(join(state, "autonomy", "actions"), { recursive: true });
		writeFileSync(join(state, "autonomy", "actions", "reports"), "block", "utf8");
		writeFrontier(state, "working_to_failed", "repo:IR", t);
		let threw = false;
		try {
			runAutonomyActions({ stateDir: state, configPath: cfgOn, sessionId: sid, now: t });
		} catch {
			threw = true;
		}
		assert.equal(threw, false, "不抛");
		assert.ok(anyReason(state, "effect-failed"), "DENY(effect-failed) 落账");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
check("IO：gitspawn 失败（PATH 空 ⇒ git 不可达）⇒ 自动发现失败 ⇒ DENY(git-repo-not-found) 且不抛", () => {
	const { root, state, cfgOn } = freshState("io-git");
	const origPath = process.env.PATH;
	try {
		process.env.PATH = ""; // git 不可达 ⇒ spawnSync ENOENT ⇒ discoverRepoRoot null ⇒ fail-closed DENY
		const sid = ownerSession();
		writeFrontier(state, "working_to_failed", "repo:IG", NOW);
		let threw = false;
		try {
			runAutonomyActions({ stateDir: state, configPath: cfgOn, sessionId: sid, now: NOW });
		} catch {
			threw = true;
		}
		assert.equal(threw, false, "不抛");
		assert.ok(anyReason(state, "git-repo-not-found(fail-closed)"), "DENY(git-repo-not-found) 落账");
	} finally {
		process.env.PATH = origPath; // 恢复 PATH（防污染后续测试）
		rmSync(root, { recursive: true, force: true });
	}
});

// ════════════════════════════ notify-local-master（阶段二：只发信不写文件 + 可回滚论证）════════════════════════
console.log("notify-local-master（阶段二：只发信不写文件 + 可回滚论证）");

/** 递归列目录所有**文件**的绝对路径（目录本身不计）。never-throw。 */
function listFilesRecursive(dir: string): string[] {
	const out: string[] = [];
	let entries: import("node:fs").Dirent[] = [];
	try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
	for (const e of entries) {
		const full = join(dir, e.name);
		if (e.isDirectory()) out.push(...listFilesRecursive(full));
		else out.push(full);
	}
	return out;
}

/** 预置 report 的 dedupKey（含 class 段）命中冷却 ⇒ 编排时 report SKIP(cooldown) ⇒ notify 得以单独执行。 */
function seedReportCooldown(state: string, rule: string, project: string, at: number): void {
	const b = readBreaker(state) ?? defaultBreakerState(at);
	b.dedup[`${rule}:diagnostic-report:${project}`] = new Date(at).toISOString();
	writeBreaker(b, state);
}

/** 取某 state 下 notify 动作的 id（账本中首个 actionClass=notify-local-master 事件）。 */
function notifyActionId(state: string): string {
	const ev = readActionsTail({ stateDir: state, limit: 50 }).find((e) => e.actionClass === "notify-local-master");
	return ev?.id ?? "";
}

const NT_PROJECT = "c:/tmp/autonomy-stage2-probe"; // 无主仓路径 ⇒ notify 信投到无 owner 的 scope，零 wake 风险

check("allowlist：notify-local-master 在册（两 class 并存）+ 注册表可取 + 未注册 fail-closed", () => {
	assert.equal(ACTION_CLASS_ALLOWLIST.has("notify-local-master"), true, "notify 在白名单");
	assert.equal(ACTION_CLASS_ALLOWLIST.has("diagnostic-report"), true, "report 仍在白名单");
	assert.equal(getActionClassRegistry()["notify-local-master"]?.name, "notify-local-master", "注册表可取");
	assert.equal(getClass("notify-local-master")?.name, "notify-local-master");
	assert.equal(getClass("nonexistent-class"), null, "未注册 = null（fail-closed）");
});

check("scope 解析 fail-closed：project 非路径 → {ok:false}（不猜）；有效路径 → scope master 地址", () => {
	const bad = resolveNotifyTarget("mailbox:agent___master_default", NOW);
	assert.equal(bad.ok, false, "非路径 project → 拒绝");
	assert.match((bad as { reason: string }).reason, /not-a-path/);
	const good = resolveNotifyTarget(NT_PROJECT, NOW);
	assert.equal(good.ok, true, "有效路径 → ok");
	assert.equal(good.target.to, localMasterAddress(localMasterScope(NT_PROJECT)), "to = localMasterAddress(localMasterScope)");
	assert.ok(good.target.messageId.startsWith("msg_"), "messageId 为 msg_ 前缀");
});

check("信件效应面：effect = 恰一个信件文件（deliverLetter 落盘）+ 帧字段（requiresAck:false/subject 非 run://tab/）", () => {
	const { root, state } = freshState("nt-surface");
	try {
		const path = notifyLocalMasterClass.targetPath(state, NT_PROJECT, NOW);
		assert.ok(path.length > 0, "有效目标路径");
		const content = notifyLocalMasterClass.buildContent({
			project: NT_PROJECT,
			trigger: { rule: "working_to_failed", project: NT_PROJECT, evidence: "run:r1:wtf", approximate: false },
			now: NOW, frontier: { asof: NOW, baseline: false, projects: [], triggers: [] } as never,
		});
		const eff = notifyLocalMasterClass.effect(path, content);
		assert.ok(eff !== null, "effect 成功");
		assert.deepEqual(eff!.deletedFiles, [], "只发信：effect 不删任何既有文件");
		assert.ok(existsSync(path), "信件文件落盘");
		const letter = JSON.parse(readFileSync(path, "utf8"));
		assert.equal(letter.status, "pending", "status=pending");
		assert.equal(letter.frame.requiresAck, false, "requiresAck:false");
		assert.equal(letter.frame.from, "agent://autonomy-actions", "from 标明动作来源");
		assert.equal(letter.frame.to, localMasterAddress(localMasterScope(NT_PROJECT)), "to = scope master");
		assert.ok(!String(letter.frame.subject).startsWith("run://tab/"), "subject 不以 run://tab/ 开头");
		assert.ok(String(letter.frame.body.summary).length > 0, "body.summary 非空");
		// withinSurface：面内 / 同 mailbox 基目录内 / 越出 mailbox = 越界 / 空 = 越界
		assert.equal(notifyLocalMasterClass.withinSurface(state, path), true, "面内");
		assert.equal(notifyLocalMasterClass.withinSurface(state, join(defaultMailboxDir(), "other-recipient", "x.json")), true, "同 mailbox 基目录内");
		assert.equal(notifyLocalMasterClass.withinSurface(state, join(state, "autonomy", "actions", "reports", "x.md")), false, "越出 mailbox = 越界");
		assert.equal(notifyLocalMasterClass.withinSurface(state, ""), false, "空/哨兵 = 越界（fail-closed）");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

check("只发信不写文件：mailbox 下恰一信件 + expectation 目录未建 + 无 claims slot（机械保证）", () => {
	const { root, state } = freshState("nt-nowrite");
	try {
		const path = notifyLocalMasterClass.targetPath(state, NT_PROJECT, NOW);
		const content = notifyLocalMasterClass.buildContent({
			project: NT_PROJECT,
			trigger: { rule: "working_to_failed", project: NT_PROJECT, evidence: "e", approximate: false },
			now: NOW, frontier: { asof: NOW, baseline: false, projects: [], triggers: [] } as never,
		});
		notifyLocalMasterClass.effect(path, content);
		// ① mailbox 下恰一个文件（信件本身）
		const mailboxFiles = listFilesRecursive(defaultMailboxDir());
		assert.equal(mailboxFiles.length, 1, "mailbox 下恰一个文件");
		assert.equal(mailboxFiles[0], path, "该文件 = 信件本身");
		// ② expectation 账本零写入（expectReply:false ⇒ shouldDeclareExpectation 短路）
		assert.equal(existsSync(join(root, "state", "expectations")), false, "expectation 目录未创建");
		// ③ claims slot 零写入（不传 dedupeId）
		const claimsDir = join(root, "claims");
		const claimSlots = existsSync(claimsDir) ? listFilesRecursive(claimsDir).filter((f) => f.includes("mailbox-")) : [];
		assert.deepEqual(claimSlots, [], "无 claims slot");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

check("编排正路径：trigger×class 候选枚举（report 冷却跳过 → notify 投递四行）+ dedupKey 含 class", () => {
	const { root, state, cfgOn } = freshState("nt-run");
	try {
		const sid = ownerSession();
		const t = NOW;
		seedReportCooldown(state, "working_to_failed", NT_PROJECT, t); // report 冷却 ⇒ notify 单独执行
		writeFrontier(state, "working_to_failed", NT_PROJECT, t);
		runAutonomyActions({ stateDir: state, configPath: cfgOn, sessionId: sid, now: t });
		const events = readActionsTail({ stateDir: state, limit: 50 });
		assert.ok(events.some((e) => e.kind === "skipped" && e.reason === "cooldown" && e.actionClass === "diagnostic-report"), "report SKIP(cooldown)");
		const notifyEvents = events.filter((e) => e.actionClass === "notify-local-master");
		assert.deepEqual(notifyEvents.map((e) => e.kind), ["attempted", "precheck", "executed", "postverified"], "notify 四行齐全");
		// 恰一个信件落盘
		assert.equal(listFilesRecursive(defaultMailboxDir()).length, 1, "恰一个信件文件");
		// dedupKey 含 class 段（notify 的）
		const br = readBreaker(state)!;
		assert.ok(br.dedup[`working_to_failed:notify-local-master:${NT_PROJECT}`], "notify dedupKey 含 class 段已写入");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

check("dedupKey 含 class 段：同 trigger 的 report/notify 冷却键独立（不互饿）", () => {
	const { root, state, cfgOn } = freshState("nt-dedup");
	try {
		const sid = ownerSession();
		const t = NOW;
		seedReportCooldown(state, "working_to_failed", NT_PROJECT, t);
		writeFrontier(state, "working_to_failed", NT_PROJECT, t);
		runAutonomyActions({ stateDir: state, configPath: cfgOn, sessionId: sid, now: t });
		const br = readBreaker(state)!;
		const reportKey = `working_to_failed:diagnostic-report:${NT_PROJECT}`;
		const notifyKey = `working_to_failed:notify-local-master:${NT_PROJECT}`;
		assert.notEqual(reportKey, notifyKey, "两 class 冷却键不同");
		assert.ok(br.dedup[reportKey], "report 冷却键在");
		assert.ok(br.dedup[notifyKey], "notify 冷却键在");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

check("pending 窗回滚：notify 信件 pending ⇒ undoAction 删除自创信件 + rolled_back（可回滚窗口）", () => {
	const { root, state, cfgOn } = freshState("nt-undo-pending");
	try {
		const sid = ownerSession();
		const t = NOW;
		seedReportCooldown(state, "working_to_failed", NT_PROJECT, t);
		writeFrontier(state, "working_to_failed", NT_PROJECT, t);
		runAutonomyActions({ stateDir: state, configPath: cfgOn, sessionId: sid, now: t });
		const id = notifyActionId(state);
		assert.ok(id, "拿到 notify 动作 id");
		const letterPath = notifyLocalMasterClass.targetPath(state, NT_PROJECT, t);
		assert.equal(existsSync(letterPath), true, "信件存在");
		assert.equal(JSON.parse(readFileSync(letterPath, "utf8")).status, "pending", "pending 状态（可回滚窗口）");
		const r = undoAction(id, { stateDir: state, now: t + 1000 });
		assert.equal(r.ok, true, "undo 成功");
		assert.equal(existsSync(letterPath), false, "自创信件已删除（恢复非存在）");
		assert.ok(kindsOf(id, state).includes("rolled_back"), "账本出现 rolled_back");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

check("claim 后处置：信件被消费（status=claimed）⇒ 文件级可删但「已送达」= D1 显式不可回退例外（不熔断/不冻结）", () => {
	const { root, state, cfgOn } = freshState("nt-claim");
	try {
		const sid = ownerSession();
		const t = NOW;
		seedReportCooldown(state, "working_to_failed", NT_PROJECT, t);
		writeFrontier(state, "working_to_failed", NT_PROJECT, t);
		runAutonomyActions({ stateDir: state, configPath: cfgOn, sessionId: sid, now: t });
		const id = notifyActionId(state);
		const letterPath = notifyLocalMasterClass.targetPath(state, NT_PROJECT, t);
		// 模拟消费端 claim（状态改写：信息已可达）
		const letter = JSON.parse(readFileSync(letterPath, "utf8"));
		letter.status = "claimed";
		writeFileSync(letterPath, JSON.stringify(letter), "utf8");
		// 文件级回退（删除自创信件）成功；但「通知已送达」= D1 显式不可回退例外，非「可回滚承诺被证伪」
		const r = undoAction(id, { stateDir: state, now: t + 1000 });
		assert.equal(r.ok, true, "文件级回退成功");
		assert.equal(existsSync(letterPath), false, "信件文件已删");
		assert.ok(kindsOf(id, state).includes("rolled_back"), "rolled_back 如实记账");
		// 关键：claim 后回退 NOT 触发熔断/冻结（D1 例外，非违规）
		const br = readBreaker(state)!;
		assert.equal(br.tripped, false, "claim 后回退不熔断（D1 例外）");
		assert.equal(br.frozen, false, "claim 后回退不冻结（D1 例外）");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

check("拒绝路径照旧：非 owner / kill / breaker-tripped ⇒ notify 亦 DENY（无信件产出）", () => {
	// 非 owner
	{
		const { root, state, cfgOn } = freshState("nt-noowner");
		try {
			ownerSession();
			writeFrontier(state, "working_to_failed", NT_PROJECT, NOW);
			runAutonomyActions({ stateDir: state, configPath: cfgOn, sessionId: "intruder-session", now: NOW });
			assert.equal(listFilesRecursive(defaultMailboxDir()).length, 0, "非 owner：无信件");
			assert.ok(anyReason(state, "not-owner"), "DENY(not-owner) 落账");
		} finally { rmSync(root, { recursive: true, force: true }); }
	}
	// kill
	{
		const { root, state, cfgOn } = freshState("nt-kill");
		try {
			const sid = ownerSession();
			engageKillSwitch({ reason: "test", by: "t" }, { stateDir: state });
			writeFrontier(state, "working_to_failed", NT_PROJECT, NOW);
			runAutonomyActions({ stateDir: state, configPath: cfgOn, sessionId: sid, now: NOW });
			assert.equal(listFilesRecursive(defaultMailboxDir()).length, 0, "kill：无信件");
			assert.ok(anyReason(state, "kill-engaged"), "DENY(kill-engaged) 落账");
		} finally { rmSync(root, { recursive: true, force: true }); }
	}
	// breaker tripped
	{
		const { root, state, cfgOn } = freshState("nt-trip");
		try {
			const sid = ownerSession();
			writeBreaker(tripBreaker(readBreaker(state) ?? defaultBreakerState(NOW), NOW), state);
			writeFrontier(state, "working_to_failed", NT_PROJECT, NOW);
			runAutonomyActions({ stateDir: state, configPath: cfgOn, sessionId: sid, now: NOW });
			assert.equal(listFilesRecursive(defaultMailboxDir()).length, 0, "breaker-tripped：无信件");
			assert.ok(anyReason(state, "breaker-tripped"), "DENY(breaker-tripped) 落账");
		} finally { rmSync(root, { recursive: true, force: true }); }
	}
});

// ════════════════════════════ 回放三问（§3.2 验收口径）════════════════════════
console.log("回放三问（做了什么 / 为什么 / 能不能撤）— 调用生产 replay 函数");
const T_YESTERDAY = NOW - 24 * 3_600_000;
const T_TODAY = NOW;
check("回放①「做了什么」：queryActionsWhat 按 ts 过滤 kind ∈ {attempted, executed}", () => {
	const { root, state } = freshState("replay-what");
	try {
		const mk = (id: string, kind: string, ts: number): ActionEvent => ({
			v: 1, id, kind: kind as ActionKind, ts: new Date(ts).toISOString(), policyVersion: POLICY_VERSION,
			trigger: { rule: "working_to_failed", project: "p", evidence: "e", approximate: false },
			actionClass: "diagnostic-report",
		});
		// 动作 A（昨天）：attempted + executed；动作 B（今天）：attempted + executed + postverified
		appendActionEvent(mk("act_A", "attempted", T_YESTERDAY), state);
		appendActionEvent(mk("act_A", "executed", T_YESTERDAY + 1000), state);
		appendActionEvent(mk("act_B", "attempted", T_TODAY), state);
		appendActionEvent(mk("act_B", "executed", T_TODAY + 1000), state);
		appendActionEvent(mk("act_B", "postverified", T_TODAY + 2000), state);
		// 昨天窗口 = A 的 attempted+executed（不含 B）
		const didYest = queryActionsWhat(state, T_YESTERDAY - 1000).filter((w) => Date.parse(w.ts) < T_TODAY - 1000);
		assert.deepEqual(didYest.map((w) => w.id).sort(), ["act_A", "act_A"], "昨天窗口 = A 的 attempted+executed");
		// 今天窗口 = B 的 attempted+executed（不含 postverified）
		const didToday = queryActionsWhat(state, T_TODAY - 1000);
		assert.deepEqual(didToday.map((w) => w.id).sort(), ["act_B", "act_B"], "今天窗口 = B 的 attempted+executed（不含 postverified）");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
check("回放②「为什么」：queryActionsWhy 取 trigger(rule+project+evidence) + intent + policyVersion", () => {
	const { root, state } = freshState("replay-why");
	try {
		const ev: ActionEvent = {
			v: 1, id: "act_W", kind: "attempted", ts: new Date(NOW).toISOString(), policyVersion: POLICY_VERSION,
			trigger: { rule: "stagnation", project: "repo:W", evidence: "run:r2:stagnation", approximate: false },
			actionClass: "diagnostic-report", intent: "collect stagnation evidence for repo:W",
		};
		appendActionEvent(ev, state);
		const got = queryActionsWhy(state, "act_W");
		assert.notEqual(got, null, "有返回");
		// trigger 三维齐全
		assert.equal(got!.trigger.rule, "stagnation");
		assert.equal(got!.trigger.project, "repo:W");
		assert.equal(got!.trigger.evidence, "run:r2:stagnation");
		// intent + policyVersion 齐全
		assert.equal(got!.intent, "collect stagnation evidence for repo:W");
		assert.equal(got!.policyVersion, "actions-v1");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
check("回放③「能不能撤」：queryActionsUndo 三终态 + 快照缺失 → 无法保证可撤（不猜）", () => {
	const { root, state } = freshState("replay-undo");
	try {
		const mk = (id: string, kind: string, extra?: Partial<ActionEvent>): ActionEvent => ({
			v: 1, id, kind: kind as ActionKind, ts: new Date(NOW).toISOString(), policyVersion: POLICY_VERSION,
			trigger: { rule: "working_to_failed", project: "p", evidence: "e", approximate: false },
			actionClass: "diagnostic-report", ...extra,
		});
		// ① postverified + 真实可读快照 → 可撤
		const snap1 = join(state, "autonomy", "actions", "snaps", "act_U1");
		mkdirSync(snap1, { recursive: true });
		writeFileSync(join(snap1, "meta.json"), JSON.stringify({ path: "/x", existed: false, mode: null }), "utf8");
		appendActionEvent(mk("act_U1", "postverified", { rollbackHandle: { type: "restore-files", snapshots: [snap1], validUntil: null, deletedFiles: [] } }), state);
		// ② rolled_back → 已撤
		appendActionEvent(mk("act_U2", "rolled_back"), state);
		// ③ rollback_failed → 不可撤，已冻结
		appendActionEvent(mk("act_U3", "rollback_failed"), state);
		// ④ postverified + 快照缺失 → 无法保证可撤（不猜）
		appendActionEvent(mk("act_U4", "postverified", { rollbackHandle: { type: "restore-files", snapshots: [join(state, "no-snap")], validUntil: null, deletedFiles: [] } }), state);

		assert.equal(queryActionsUndo(state, "act_U1").status, "可撤", "postverified + 快照可读 → 可撤");
		assert.equal(queryActionsUndo(state, "act_U2").status, "已撤", "rolled_back → 已撤");
		assert.equal(queryActionsUndo(state, "act_U3").status, "不可撤，已冻结", "rollback_failed → 不可撤已冻结");
		assert.equal(queryActionsUndo(state, "act_U4").status, "无法保证可撤（快照缺失/不可读）", "postverified + 快照缺失 → 无法保证可撤（不猜）");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ── 小件 ─────────────────────────────────────────────────────────────
function dirnameOf(p: string): string {
	return dirname(p);
}
function readdirTmps(dir: string): string[] {
	try {
		return readdirSync(dir).filter((n) => n.endsWith(".tmp"));
	} catch {
		return [];
	}
}
function readdirSyncSafe(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

// ── 汇总 ─────────────────────────────────────────────────────────────
if (failed > 0) {
	console.error(`_test_runtime_autonomy_actions: FAILED (${failed} failed / ${passed} passed)`);
	process.exit(1);
}
console.log(`_test_runtime_autonomy_actions: all ${passed} checks passed`);
