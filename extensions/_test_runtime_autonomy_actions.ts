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
import { runAutonomyActions, summarizeActionsStatus, undoAction } from "./runtime/autonomy/action/run.ts";
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
	assert.equal(ACTION_CLASS_ALLOWLIST.size, 1);
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
