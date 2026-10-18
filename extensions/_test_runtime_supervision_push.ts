/**
 * _test_runtime_supervision_push.ts — P1 主动推动（supervise-push + wake prompt 监管块）验收
 *
 * 任务书：`plans/20261018_P1_push_task_brief.md`
 * 实现规格：`plans/20261018_P1_supervision_push_spec.md` §1–§5（权威交接件）
 * 实现报告：`plans/20261018_P1_supervision_push_impl.md`
 *
 * 覆盖（spec §4 的 6 组）：
 *   1. 七条拒绝路径各一例（reason 字符串逐字断言）+ budget 的 1h 节流一例
 *   2. 成功路径：steer 文件真落盘（readSteerRecord 可读、status=pending、body 含模板片段）
 *      + pushes[] 长度 +1 + audit.jsonl 真有一行
 *   3. 模板片段（【监管推动 1/2】/ 已停 / 三条指示各含）
 *   4. buildWakePrompt 第三参：undefined / [] 与**手写冻结字面量**逐字节相等；非空含 runId + supervise-push
 *   5. mode 缺省 steer；显式 abort 落盘记录 mode==="abort"
 *   6. 第 4 项（steer 档对 idle tab，**只断言现状不改代码**）：sendSteerDetailed 固定 deliverAs:"steer"
 *      ⇒ 对已 settled 的 idle tab 不起新 turn；能起新 turn 的只有 abort 档（sendAbortMessage 不带 deliverAs）
 *   0. 另加：真实注册入口（registerSupervisionTools + fake pi）的身份门与工具回执（AGENTS R-4：
 *      断言必须经过真实接线，不能只直调纯函数）
 *
 * 运行：npx tsx extensions/_test_runtime_supervision_push.ts
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 测试隔离：defaultRuntimeDir() 全部走 temp（_test_runtime_supervision_default_on 同款模式）
const ENV_TMP = mkdtempSync(join(tmpdir(), "runtime-sup-push-"));
process.env.PI_RUNTIME_DIR = ENV_TMP;
delete process.env.PI_TAB_RUN_ID;
delete process.env.PI_SUBAGENT;

import {
	clampMaxPushes,
	countPushes,
	evaluatePushGuards,
	pushTemplate,
	registerSupervisionTools,
	SUPERVISION_MAX_PUSHES,
	supervisePush,
	type PushGuardInput,
	type SupervisePushResult,
} from "./supervision-runtime.ts";
import {
	readSupervisionLedger,
	setSupervisionOptOut,
	setSupervisionStatus,
	writeSupervisionEntry,
	type SupervisionEntry,
} from "./runtime/supervision.ts";
import { appendAuditLine, writeFrontierSnapshot } from "./runtime/autonomy/collect.ts";
import { buildWakePrompt, deriveSupervisionItems, evaluateWakes, type WakeLetter } from "./runtime/wake.ts";
import { attachMaster, setCutover } from "./runtime/registry.ts";
import { defaultMailboxDir, deliverLetter } from "./runtime/mailbox.ts";
import { newEnvelopeId } from "./runtime/ids.ts";
import { newMessageFrame } from "./runtime/protocol.ts";
import { createWorkstream } from "./runtime/workstreams.ts";
import { workstreamAddress } from "./runtime/address.ts";
import { readSteerRecord, sendSteerDetailed } from "./steer.ts";
import { composeTabStatus, readTabDispatch, readTabResultFile, readTabState, tabResultPath, writeJsonAtomic, writeTabDispatch, writeTabState, type TabDispatchRecord, type TabState } from "./tab-runs.ts";
import { classifyForReclaim } from "./tab-runs-runtime.ts";
import { buildScopeWakePrompt, evaluateScopeWake, localMasterAddress, localMasterScope } from "./runtime/scope.ts";
import { runAutonomyActions } from "./runtime/autonomy/action/run.ts";
import { buildFrontier } from "./runtime/autonomy/frontier.ts";
import type { FrontierSourceTab } from "./runtime/frontier-carriers.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** no-key autonomy config（9(h)/9(i) 注入：避开生产 config.json，同 autonomy_wiring R10 纪律）。 */
const CFG_TMP = mkdtempSync(join(tmpdir(), "runtime-sup-push-cfg-"));
const cfgNoKey = join(CFG_TMP, "no-key.json");
writeFileSync(cfgNoKey, JSON.stringify({ masterSuccession: { auto: true } }), "utf8");

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

/** 异步版 check（工具 execute 是 async：不 await 的错误会逃逸成 unhandled rejection）。 */
async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
	try {
		await fn();
		passed++;
		console.log(`  ✓ ${name}`);
	} catch (e) {
		failed++;
		console.error(`  ✗ ${name}`);
		console.error(`    ${String((e as Error)?.message ?? e)}`);
	}
}

/** 每项测试独立 stateDir/runsDir/steerDir（互不污染，失败可单独复跑）。 */
function mkIsolated(name: string): { stateDir: string; runsDir: string; steerDir: string; dispose: () => void } {
	const root = mkdtempSync(join(tmpdir(), `runtime-sup-push-${name}-`));
	return {
		stateDir: join(root, "state"),
		runsDir: join(root, "tab-runs"),
		steerDir: join(root, "steer"),
		dispose: () => rmSync(root, { recursive: true, force: true }),
	};
}

const NOW = new Date("2026-10-18T08:00:00.000Z");
const iso = (msAgo: number): string => new Date(NOW.getTime() - msAgo).toISOString();

function mkDispatch(id: string, taskId: string, cwd: string): TabDispatchRecord {
	return { id, version: 1, taskId, mode: "workflow", cwd, dispatchedAt: iso(30 * 60_000), dispatchStatus: "dispatched" };
}

/**
 * 真实形状的 TabState（字段口径对齐 tab-runs-runtime 的 writeState：
 * id/phase/turn/terminal/lastActivityAt/lastAssistantText/lastStopReason/pid）。
 */
function mkState(id: string, over: Partial<TabState> = {}): TabState {
	return {
		id,
		phase: "working",
		turn: "working",
		terminal: false,
		pid: process.pid, // 活的 pid（本进程）——pid-dead 用例显式覆盖
		lastActivityAt: iso(16 * 60_000),
		lastAssistantText: "正在改 supervision-runtime.ts",
		lastStopReason: "stop",
		...over,
	};
}

/** 造一条监管账本（默认 active、epoch 20min 前开始、无 pushes）。 */
function mkLedger(
	runId: string,
	opts: { stateDir: string; runsDir: string; status?: "active" | "paused"; epochStartedAt?: string; pushes?: number },
): SupervisionEntry {
	const r = setSupervisionStatus(
		{ runId, status: opts.status ?? "active", setBy: "master:test" },
		{ stateDir: opts.stateDir, tabRunsDir: opts.runsDir, now: NOW },
	);
	assert.equal(r.ok, true, `账本写入失败：${r.reason}`);
	const cur = readSupervisionLedger(runId, { stateDir: opts.stateDir });
	assert.ok(cur, "账本必须可读");
	const n = opts.pushes ?? 0;
	const entry: SupervisionEntry = {
		...cur!,
		epoch: {
			startedAt: opts.epochStartedAt ?? iso(20 * 60_000),
			pushes: Array.from({ length: n }, (_, i) => ({
				at: iso(10 * 60_000 - i * 1000),
				steerId: `steer_seed_${i}`,
				outcome: "pending",
			})),
		},
	};
	return entry;
}

/** 用给定的 entry 覆盖账本文件（走 writeSupervisionEntry 的同一写入口：先写回再断言）。 */
function seedLedger(entry: SupervisionEntry, stateDir: string): void {
	// 直接落盘到 open/ 的同一路径（等价于 writeSupervisionEntry 的结果，供夹具确定性）
	const dir = join(stateDir, "supervision", "open");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${entry.runId}.json`), `${JSON.stringify(entry, null, 2)}\n`, "utf8");
}

const baseGuard = (over: Partial<PushGuardInput> = {}): PushGuardInput => ({
	ledger: {
		version: 1,
		runId: "tab_g",
		taskId: "T-G",
		repoPath: "G:/code/x",
		status: "active",
		setBy: "master:test",
		setAt: iso(0),
		pausedAt: null,
		pauseReason: null,
		epoch: { startedAt: iso(20 * 60_000), pushes: [] },
	},
	phase: "working",
	stopReason: "stop",
	terminal: false,
	needsHuman: false,
	attention: 0,
	gate: "ok",
	pidAlive: true,
	pushesThisEpoch: 0,
	pushesLastHour: 0,
	maxPushes: SUPERVISION_MAX_PUSHES,
	...over,
});

// ════════════════════ 1. 七条拒绝路径（纯函数，逐条 reason）══════════
console.log("1. 七条拒绝路径（reason 字符串逐字，判定顺序先命中先返回）");
{
	check("1(a) 无账本 ⇒ no-mandate", () => {
		const r = evaluatePushGuards(baseGuard({ ledger: null }));
		assert.equal(r.ok, false);
		assert.equal((r as { reason: string }).reason, "no-mandate");
	});
	check("1(a2) 账本 optOut=true ⇒ no-mandate（与 deriveTabSupervisionState 同口径）", () => {
		const r = evaluatePushGuards(baseGuard({ ledger: { ...baseGuard().ledger!, optOut: true } }));
		assert.equal(r.ok, false);
		assert.equal((r as { reason: string }).reason, "no-mandate");
	});
	check("1(b) 账本 paused ⇒ paused", () => {
		const r = evaluatePushGuards(baseGuard({ ledger: { ...baseGuard().ledger!, status: "paused" } }));
		assert.equal(r.ok, false);
		assert.equal((r as { reason: string }).reason, "paused");
	});
	check("1(c) 已终态 ⇒ terminal", () => {
		const r = evaluatePushGuards(baseGuard({ terminal: true }));
		assert.equal(r.ok, false);
		assert.equal((r as { reason: string }).reason, "terminal");
	});
	check("1(d) needsHuman ⇒ needs-human（BLOCKED_USER 只告不推）", () => {
		const r = evaluatePushGuards(baseGuard({ needsHuman: true, attention: 2 }));
		assert.equal(r.ok, false);
		assert.equal((r as { reason: string }).reason, "needs-human");
	});
	check("1(e1) 本 epoch 已推满 maxPushes ⇒ budget-exhausted", () => {
		const r = evaluatePushGuards(baseGuard({ pushesThisEpoch: 2, maxPushes: 2 }));
		assert.equal(r.ok, false);
		assert.equal((r as { reason: string }).reason, "budget-exhausted");
	});
	check("1(e2) 近 1 小时 ≥4 次 ⇒ budget-exhausted（滚动节流，独立于 epoch）", () => {
		const r = evaluatePushGuards(baseGuard({ pushesThisEpoch: 0, pushesLastHour: 4 }));
		assert.equal(r.ok, false);
		assert.equal((r as { reason: string }).reason, "budget-exhausted");
	});
	check("1(e3) 未满预算 ⇒ 不放行（1 次 / maxPushes=2 不触发预算门）", () => {
		assert.equal(evaluatePushGuards(baseGuard({ pushesThisEpoch: 1, maxPushes: 2 })).ok, true);
	});
	check("1(f) pidAlive=false ⇒ pid-dead", () => {
		const r = evaluatePushGuards(baseGuard({ pidAlive: false }));
		assert.equal(r.ok, false);
		assert.equal((r as { reason: string }).reason, "pid-dead");
	});
	check("1(f2) pidAlive=null（无 pid）⇒ 不拒（不猜）", () => {
		assert.equal(evaluatePushGuards(baseGuard({ pidAlive: null })).ok, true);
	});
	check("1(g) phase=working ∧ stop=toolUse ⇒ tool-use", () => {
		const r = evaluatePushGuards(baseGuard({ phase: "working", stopReason: "toolUse" }));
		assert.equal(r.ok, false);
		assert.equal((r as { reason: string }).reason, "tool-use");
	});
	check("1(g2) phase=waiting ∧ stop=toolUse ⇒ 不触发 tool-use 门（判据含 phase=working）", () => {
		assert.equal(evaluatePushGuards(baseGuard({ phase: "waiting", stopReason: "toolUse" })).ok, true);
	});
	check("1(h) 判定顺序：paused 优先于 terminal/needs-human/budget（先命中先返回）", () => {
		const r = evaluatePushGuards(
			baseGuard({
				ledger: { ...baseGuard().ledger!, status: "paused" },
				terminal: true,
				needsHuman: true,
				pushesThisEpoch: 9,
				pidAlive: false,
				stopReason: "toolUse",
			}),
		);
		assert.equal((r as { reason: string }).reason, "paused");
	});
	check("1(i) 判定顺序：needs-human 优先于 budget/pid-dead/tool-use", () => {
		const r = evaluatePushGuards(
			baseGuard({ needsHuman: true, pushesThisEpoch: 9, pidAlive: false, stopReason: "toolUse" }),
		);
		assert.equal((r as { reason: string }).reason, "needs-human");
	});
	check("1(j) 判定顺序：budget 优先于 pid-dead/tool-use", () => {
		const r = evaluatePushGuards(baseGuard({ pushesThisEpoch: 9, pidAlive: false, stopReason: "toolUse" }));
		assert.equal((r as { reason: string }).reason, "budget-exhausted");
	});
	check("1(k) 判定顺序：pid-dead 优先于 tool-use", () => {
		const r = evaluatePushGuards(baseGuard({ pidAlive: false, stopReason: "toolUse" }));
		assert.equal((r as { reason: string }).reason, "pid-dead");
	});
	check("1(l) maxPushes clamp [1,3]：0→1 / 9→3 / 非数→常量 2", () => {
		assert.equal(clampMaxPushes(0), 1);
		assert.equal(clampMaxPushes(9), 3);
		assert.equal(clampMaxPushes(undefined), SUPERVISION_MAX_PUSHES);
	});
}

// ════════════════════ 2. 成功路径（真落盘 + pushes + audit）═════════
console.log("2. 成功路径：steer 真落盘 + pushes[] +1 + audit.jsonl 一行");
{
	const iso2 = mkIsolated("success");
	try {
		const RUN = "tab_push_ok";
		writeTabDispatch(iso2.runsDir, mkDispatch(RUN, "T-PUSH-1", "G:/code/GreenCAD"));
		writeTabState(iso2.runsDir, RUN, mkState(RUN));
		const entry = mkLedger(RUN, { stateDir: iso2.stateDir, runsDir: iso2.runsDir });
		seedLedger(entry, iso2.stateDir);

		const res = supervisePush(
			{ runId: RUN },
			{
				stateDir: iso2.stateDir,
				runsDir: iso2.runsDir,
				steerDir: iso2.steerDir,
				now: () => NOW,
				audit: (line) => appendAuditLine(line, { stateDir: iso2.stateDir }),
			},
		);

		check("2(a) 返回 ok=true，pushIndex=1，remainingBudget=1，mode=steer（缺省）", () => {
			assert.equal(res.ok, true, `实得 ${JSON.stringify(res)}`);
			const ok = res as Extract<SupervisePushResult, { ok: true }>;
			assert.equal(ok.pushIndex, 1);
			assert.equal(ok.remainingBudget, 1);
			assert.equal(ok.mode, "steer", "mode 缺省必须是 steer");
			assert.match(ok.steerId, /^steer_/);
		});
		check("2(b) steer 记录真落盘，readSteerRecord 可读且 status=pending / source=supervise-push", () => {
			const ok = res as Extract<SupervisePushResult, { ok: true }>;
			const rec = readSteerRecord(iso2.steerDir, RUN, ok.steerId);
			assert.ok(rec, "steer 记录必须存在（readSteerRecord 可读）");
			assert.equal(rec!.status, "pending");
			assert.equal(rec!.tabRunId, RUN);
			assert.equal(rec!.mode, "steer");
			assert.equal(rec!.source, "supervise-push");
			assert.ok(rec!.body.includes("【监管推动 #1/预算2】"), `body 缺模板头：${rec!.body.slice(0, 60)}`);
		});
		check("2(c) 账本 pushes[] 长度 +1，记录含 at/mode/steerId/reason/outcome", () => {
			const after = readSupervisionLedger(RUN, { stateDir: iso2.stateDir });
			assert.ok(after, "账本必须仍可读");
			assert.equal(after!.epoch.pushes.length, 1, "pushes[] 必须 +1");
			const p = after!.epoch.pushes[0] as unknown as Record<string, unknown>;
			assert.equal(p.steerId, (res as Extract<SupervisePushResult, { ok: true }>).steerId);
			assert.equal(p.mode, "steer");
			assert.equal(p.reason, "stalled");
			assert.equal(p.outcome, "pending");
			assert.equal(p.at, NOW.toISOString());
		});
		check("2(d) audit.jsonl 真有一行 supervision-push ok（注入真 appendAuditLine）", () => {
			const auditPath = join(iso2.stateDir, "autonomy", "audit.jsonl");
			assert.ok(existsSync(auditPath), "audit.jsonl 必须存在");
			const lines = readFileSync(auditPath, "utf8").trim().split("\n");
			const ok = lines.filter((l) => l.includes("supervision-push ok runId=tab_push_ok"));
			assert.equal(ok.length, 1, `期望 1 行，实得 ${ok.length}：${lines.join(" | ")}`);
			assert.match(ok[0]!, /push=1\/2/);
			assert.match(ok[0]!, /mode=steer/);
		});
		check("2(e) 第二次推 ⇒ pushIndex=2 / remaining=0（同一 epoch 累加）", () => {
			const res2 = supervisePush(
				{ runId: RUN },
				{ stateDir: iso2.stateDir, runsDir: iso2.runsDir, steerDir: iso2.steerDir, now: () => new Date(NOW.getTime() + 1000) },
			);
			assert.equal(res2.ok, true, `实得 ${JSON.stringify(res2)}`);
			const ok2 = res2 as Extract<SupervisePushResult, { ok: true }>;
			assert.equal(ok2.pushIndex, 2);
			assert.equal(ok2.remainingBudget, 0);
			const after = readSupervisionLedger(RUN, { stateDir: iso2.stateDir });
			assert.equal(after!.epoch.pushes.length, 2);
		});
		check("2(f) 第三次推 ⇒ budget-exhausted（机械强制，不靠自觉）", () => {
			const res3 = supervisePush(
				{ runId: RUN },
				{ stateDir: iso2.stateDir, runsDir: iso2.runsDir, steerDir: iso2.steerDir, now: () => new Date(NOW.getTime() + 2000) },
			);
			assert.equal(res3.ok, false);
			assert.equal((res3 as { reason: string }).reason, "budget-exhausted");
		});
		check("2(g) epoch 读侧重置：lastActivityAt 晚于 epoch.startedAt ⇒ 旧 pushes 不再计入", () => {
			const pushes = [
				{ at: iso(15 * 60_000), steerId: "s1", outcome: "pending" },
				{ at: iso(14 * 60_000), steerId: "s2", outcome: "pending" },
			];
			const c = countPushes(pushes, { nowMs: NOW.getTime(), epochStartMs: Date.parse(iso(10 * 60_000)) });
			assert.equal(c.thisEpoch, 0, "活动恢复（10min 前）之后没有 push ⇒ 本 epoch 计 0");
			assert.equal(c.lastHour, 2, "近 1 小时仍计 2（滚动节流独立于 epoch）");
		});
	} finally {
		iso2.dispose();
	}
}

// ════════════════════ 3. 模板片段（C.2 逐字）═══════════════════════
console.log("3. 模板片段（【监管推动 1/2】/ 已停 / 三条指示）");
{
	check("3(a) 模板头与 idle 分钟、stop、摘要（逐字，含全角括号）", () => {
		const body = pushTemplate({
			pushIndex: 1,
			maxPushes: 2,
			taskId: "T-1",
			repoPath: "G:/code/GreenCAD",
			idleMs: 16 * 60_000,
			stopReason: "stop",
			summary: "完成 A 部分",
		});
		assert.ok(body.includes("【监管推动 #1/预算2】任务 T-1（GreenCAD）已停 16min。"), `模板头不符：${body.split("\n")[0]}`);
		assert.ok(body.includes("最后状态：stop=stop，摘要：完成 A 部分。"), "状态行不符");
	});
	check("3(b) 三条指示各含", () => {
		const body = pushTemplate({
			pushIndex: 2, maxPushes: 3, taskId: "T", repoPath: null, idleMs: 0, stopReason: "unknown", summary: "",
		});
		assert.ok(body.includes("1) 若仍可推进：继续当前任务，不要重做已完成部分（先读你自己的交接/计划文件再续）。"));
		assert.ok(body.includes("2) 若在等外部条件（解封/窗口/他人）：回报【等什么|谁解锁|预计何时】，我转告用户。"));
		assert.ok(body.includes("3) 若已完成：立即调用 tab-finish 回报（不调 = 未完成）。"));
		assert.ok(body.includes("（unknown）已停 0min"), "无 repoPath ⇒ unknown");
	});
	check("3(c) 摘要截断 120 字符", () => {
		const long = "A".repeat(200);
		const body = pushTemplate({ pushIndex: 1, maxPushes: 2, taskId: "T", repoPath: "G:/r", idleMs: 60_000, stopReason: "stop", summary: long });
		assert.ok(body.includes(`摘要：${"A".repeat(120)}。`), "摘要必须截断到 120 字符");
		assert.ok(!body.includes("A".repeat(121)), "不得超 120");
	});
}

// ════════════════════ 4. buildWakePrompt 第三参（逐字节快照）═══════
console.log("4. buildWakePrompt 第三参：undefined/[] 逐字节不变；非空插入监管块");
{
	const WS = { id: "ws_p1", mission: "监管推动", status: "active" } as never;
	const LETTERS: WakeLetter[] = [
		{ messageId: "msg_p1_1", subject: "run://tab/tab_p1", summary: "停滞 16min", sentAt: iso(60_000), requiresAck: false },
	];
	// 手写冻结字面量（**不是**「调两次比两次」）：照 buildWakePrompt 现有行序/标点写死。
	const FROZEN = [
		"你是 workstream ws_p1 的 Sub-Master（runtime wake 层唤醒，有终态的一次执行）。",
		"mission=监管推动",
		"待处理输入（1）：",
		"- [run://tab/tab_p1] 停滞 16min",
		"规则：单次有界执行，做完即 tab-finish（天然 sleep）；禁止设 timer 自续命，再入只能经 wake 层；",
		"无 actionable 输入时立即 tab-finish 报 no-op，不许挂等；",
		"workstream 暂停时你不会被唤醒（由 wake 层保证）。",
	].join("\n");

	check("4(a) 不传第三参 ⇒ 与手写冻结字面量逐字节相同", () => {
		assert.equal(buildWakePrompt(WS, LETTERS), FROZEN);
	});
	check("4(b) 传 [] ⇒ 同样逐字节相同（空数组不得留下空行/空块）", () => {
		assert.equal(buildWakePrompt(WS, LETTERS, []), FROZEN);
	});
	check("4(c) 非空 ⇒ 含 runId + 已停分钟 + push 预算 + supervise-push 指令", () => {
		const p = buildWakePrompt(WS, LETTERS, [
			{
				runId: "tab_p1",
				taskId: "T-P1",
				repoPath: "G:/code/GreenCAD",
				idleMs: 16 * 60_000,
				stopReason: "stop",
				summary: "改到一半",
				pushesUsed: 0,
				maxPushes: 2,
			},
		]);
		assert.ok(p.includes("停滞监管"), "必须含监管块标题");
		assert.ok(p.includes("tab_p1 task=T-P1 repo=GreenCAD 已停 16min stop=stop push=0/2 摘要：改到一半"), `监管行不符：${p}`);
		assert.ok(p.includes('用 supervise-push({runId:"tab_p1"}) 推动（预算耗尽则升级用户，勿 abort）。'));
		assert.notEqual(p, FROZEN, "非空必须与冻结字面量不同");
	});
	check("4(d) 监管块位置：在「待处理输入」块之后、回执块之前", () => {
		const p = buildWakePrompt(WS, LETTERS, [
			{ runId: "tab_p1", taskId: "T", repoPath: "", idleMs: 0, stopReason: "unknown", summary: "", pushesUsed: 1, maxPushes: 2 },
		]);
		const atInput = p.indexOf("待处理输入（1）");
		const atSup = p.indexOf("停滞监管");
		const atRule = p.indexOf("规则：单次有界执行");
		assert.ok(atInput >= 0 && atSup > atInput && atRule > atSup, `顺序不符 input=${atInput} sup=${atSup} rule=${atRule}`);
	});
	check("4(e) 其余行不变：非空输出去掉监管块后与冻结字面量逐字节相同", () => {
		const p = buildWakePrompt(WS, LETTERS, [
			{ runId: "tab_p1", taskId: "T", repoPath: "", idleMs: 0, stopReason: "unknown", summary: "", pushesUsed: 0, maxPushes: 2 },
		]);
		const block = p.slice(p.indexOf("停滞监管"), p.indexOf("规则：单次有界执行"));
		const stripped = p.replace(block, "");
		assert.equal(stripped, FROZEN, "插入监管块不得改动任何既有行");
	});
}

// ════════════════════ 5. mode 缺省 / 显式 abort ════════════════════
console.log("5. mode：缺省 steer；显式 abort 才落 abort 记录（绝不自动升级）");
{
	const iso5 = mkIsolated("mode");
	try {
		const RUN = "tab_push_mode";
		writeTabDispatch(iso5.runsDir, mkDispatch(RUN, "T-MODE", "G:/code/x"));
		writeTabState(iso5.runsDir, RUN, mkState(RUN));
		seedLedger(mkLedger(RUN, { stateDir: iso5.stateDir, runsDir: iso5.runsDir }), iso5.stateDir);

		check("5(a) 不传 mode ⇒ 落盘记录 mode=steer", () => {
			const res = supervisePush({ runId: RUN }, { stateDir: iso5.stateDir, runsDir: iso5.runsDir, steerDir: iso5.steerDir, now: () => NOW });
			assert.equal(res.ok, true, `实得 ${JSON.stringify(res)}`);
			const rec = readSteerRecord(iso5.steerDir, RUN, (res as Extract<SupervisePushResult, { ok: true }>).steerId);
			assert.equal(rec!.mode, "steer");
		});
		check("5(b) 显式 mode=abort ⇒ 落盘记录 mode=abort（且 pushes 里也记 abort）", () => {
			const res = supervisePush(
				{ runId: RUN, mode: "abort" },
				{ stateDir: iso5.stateDir, runsDir: iso5.runsDir, steerDir: iso5.steerDir, now: () => new Date(NOW.getTime() + 1000) },
			);
			assert.equal(res.ok, true, `实得 ${JSON.stringify(res)}`);
			const rec = readSteerRecord(iso5.steerDir, RUN, (res as Extract<SupervisePushResult, { ok: true }>).steerId);
			assert.equal(rec!.mode, "abort");
			const ledger = readSupervisionLedger(RUN, { stateDir: iso5.stateDir });
			const last = ledger!.epoch.pushes[ledger!.epoch.pushes.length - 1] as unknown as Record<string, unknown>;
			assert.equal(last.mode, "abort");
		});
	} finally {
		iso5.dispose();
	}
}

// ════════════════════ 6. 第 4 项：steer 档对 idle tab（只断言现状）═══
console.log("6. steer 档对 idle tab：断言当前实现行为（不改代码），结论见报告");
await (async () => {
	await checkAsync("6(a) sendSteerDetailed 固定传 deliverAs=\"steer\"（排队到下一 tool 边界）", async () => {
		const seen: Array<{ body: string; opts?: { deliverAs?: string } }> = [];
		await sendSteerDetailed((body, opts) => { seen.push({ body, opts }); }, "hi");
		assert.equal(seen.length, 1);
		assert.equal(seen[0]!.opts?.deliverAs, "steer", "steer 档必须带 deliverAs:\"steer\"");
	});
	check("6(b) 源码锚点：steer-consumer 的 abort 档发送**不带** deliverAs（唯一能起新 turn 的路径）", () => {
		const src = readFileSync(join(REPO_ROOT, "extensions", "steer-consumer.ts"), "utf8");
		const fnAt = src.indexOf("function sendAbortMessage(");
		assert.ok(fnAt > 0, "未找到 sendAbortMessage（锚点失效需更新测试）");
		const body = src.slice(fnAt, fnAt + 900);
		assert.ok(body.includes("send(body)"), "abort 档必须 send(body)（不带 opts ⇒ 空闲态 prompt 起新 turn）");
		assert.ok(!/deliverAs\s*:/.test(body), "abort 档不得带 deliverAs（否则空闲态无法起新 turn）");
	});
	check("6(c) 源码锚点：steer 档=入 steering 队列（下一个 tool 边界才送达）；abort 档=不带 deliverAs 的 send", () => {
		// 现状（只断言，不改代码）：
		//   steer 档 sendUserMessage(body, {deliverAs:"steer"}) ⇒ 入队列，**要等下一个 tool 边界**；
		//   已 settled 的 idle tab 没有 tool 边界 ⇒ 该条留在队列里，不会因此起新 turn。
		//   abort 档的 send 不带 deliverAs ⇒ 空闲态走 prompt() 正常路径起新 turn（本仓注释明写）。
		const steerSrc = readFileSync(join(REPO_ROOT, "extensions", "steer.ts"), "utf8");
		assert.ok(
			steerSrc.includes('deliverAs:"steer"') && steerSrc.includes("下一个 tool 边界"),
			"steer 档语义锚点缺失（steer.ts：deliverAs:\"steer\" = 下一个 tool 边界）",
		);
		const consumerSrc = readFileSync(join(REPO_ROOT, "extensions", "steer-consumer.ts"), "utf8");
		assert.ok(
			consumerSrc.includes("空闲态走 prompt() 正常路径起新 turn"),
			"abort 档「空闲态起新 turn」的源码锚点缺失（steer-consumer.ts sendAbortMessage 注释）",
		);
		assert.ok(
			consumerSrc.includes("**不带 deliverAs**"),
			"abort 档「不带 deliverAs」的源码锚点缺失（steer-consumer.ts 文件头）",
		);
	});
})();

// ════════════════════ 0. 真实注册入口（身份门 + 工具回执）═══════════
console.log("0. registerSupervisionTools（真实接线：fake pi 捕获 registerTool）");
{
	function makeFakePi() {
		const tools: Array<{ name: string; execute: (id: string, params: unknown) => Promise<unknown> }> = [];
		return {
			tools,
			registerTool(t: { name: string; execute: (id: string, params: unknown) => Promise<unknown> }) { tools.push(t); },
			registerCommand() {},
			on() {},
			findTool(name: string) { return tools.find((t) => t.name === name); },
		};
	}
	const iso0 = mkIsolated("register");
	try {
		const RUN = "tab_push_tool";
		writeTabDispatch(iso0.runsDir, mkDispatch(RUN, "T-TOOL", "G:/code/x"));
		writeTabState(iso0.runsDir, RUN, mkState(RUN));
		seedLedger(mkLedger(RUN, { stateDir: iso0.stateDir, runsDir: iso0.runsDir }), iso0.stateDir);

		const pi = makeFakePi();
		const cleanup = registerSupervisionTools(pi as never, {
			stateDir: iso0.stateDir,
			runsDir: iso0.runsDir,
			steerDir: iso0.steerDir,
			now: () => NOW,
		});
		const tool = pi.findTool("supervise-push");

		check("0(a) 工具名 supervise-push 已注册，返回 cleanup 函数", () => {
			assert.ok(tool, "supervise-push 必须注册");
			assert.equal(typeof cleanup, "function");
		});
		await checkAsync("0(b) 主会话 + 有效 runId ⇒ 成功回执含 steerId / #1/2", async () => {
			const res = (await tool!.execute("", { runId: RUN })) as { isError?: boolean; content: Array<{ text: string }> };
			assert.ok(!res.isError, `不应失败：${res.content[0]?.text}`);
			assert.match(res.content[0]!.text, /✅ supervise-push #1\/2/);
			assert.match(res.content[0]!.text, /【监管推动 #1\/预算2】/);
		});
		await checkAsync("0(c) 子 agent 身份（PI_SUBAGENT=1）⇒ isError「子 agent 中不可推动」", async () => {
			process.env.PI_SUBAGENT = "1";
			try {
				const res = (await tool!.execute("", { runId: RUN })) as { isError?: boolean; content: Array<{ text: string }> };
				assert.equal(res.isError, true);
				assert.match(res.content[0]!.text, /子 agent 中不可推动/);
			} finally {
				delete process.env.PI_SUBAGENT;
			}
		});
		await checkAsync("0(d) 标签页身份（PI_TAB_RUN_ID 存在）⇒ isError「仅主会话可用」", async () => {
			process.env.PI_TAB_RUN_ID = "tab_self";
			try {
				const res = (await tool!.execute("", { runId: RUN })) as { isError?: boolean; content: Array<{ text: string }> };
				assert.equal(res.isError, true);
				assert.match(res.content[0]!.text, /监管推动仅主会话可用/);
			} finally {
				delete process.env.PI_TAB_RUN_ID;
			}
		});
		await checkAsync("0(e) 缺 runId ⇒ isError（不静默 no-op）", async () => {
			const res = (await tool!.execute("", { runId: "   " })) as { isError?: boolean; content: Array<{ text: string }> };
			assert.equal(res.isError, true);
			assert.match(res.content[0]!.text, /runId required/);
		});
		await checkAsync("0(f) 拒绝回执含 reason= 与中文「不推」提示（未知 runId ⇒ no-mandate）", async () => {
			const res = (await tool!.execute("", { runId: "tab_unknown_x" })) as { isError?: boolean; content: Array<{ text: string }> };
			assert.equal(res.isError, true);
			assert.match(res.content[0]!.text, /reason=no-mandate/);
			assert.match(res.content[0]!.text, /不推/, "拒绝必须给一句「不推」的中文原因");
		});
	} finally {
		iso0.dispose();
	}
}

// ════════════════════ 7. 编排层：策略门经真实读路径命中 ═════════════
console.log("7. supervisePush 端到端：策略门经真实读路径（账本/state/result）命中");
{
	check("7(a) 无账本 ⇒ no-mandate", () => {
		const iso7 = mkIsolated("no-mandate");
		try {
			writeTabDispatch(iso7.runsDir, mkDispatch("tab_nm", "T", "G:/x"));
			writeTabState(iso7.runsDir, "tab_nm", mkState("tab_nm"));
			const r = supervisePush({ runId: "tab_nm" }, { stateDir: iso7.stateDir, runsDir: iso7.runsDir, steerDir: iso7.steerDir, now: () => NOW });
			assert.equal((r as { reason: string }).reason, "no-mandate");
			assert.equal(existsSync(join(iso7.steerDir, "tab_nm")), false, "被拒时不得落盘 steer");
		} finally { iso7.dispose(); }
	});
	check("7(b) 账本 paused ⇒ paused", () => {
		const iso7 = mkIsolated("paused");
		try {
			writeTabDispatch(iso7.runsDir, mkDispatch("tab_ps", "T", "G:/x"));
			writeTabState(iso7.runsDir, "tab_ps", mkState("tab_ps"));
			seedLedger(mkLedger("tab_ps", { stateDir: iso7.stateDir, runsDir: iso7.runsDir, status: "paused" }), iso7.stateDir);
			const r = supervisePush({ runId: "tab_ps" }, { stateDir: iso7.stateDir, runsDir: iso7.runsDir, steerDir: iso7.steerDir, now: () => NOW });
			assert.equal((r as { reason: string }).reason, "paused");
		} finally { iso7.dispose(); }
	});
	check("7(c) result.json 存在 ⇒ terminal", () => {
		const iso7 = mkIsolated("terminal");
		try {
			const RUN = "tab_tm";
			writeTabDispatch(iso7.runsDir, mkDispatch(RUN, "T", "G:/x"));
			writeTabState(iso7.runsDir, RUN, mkState(RUN, { phase: "completed", turn: "idle", terminal: true }));
			seedLedger(mkLedger(RUN, { stateDir: iso7.stateDir, runsDir: iso7.runsDir }), iso7.stateDir);
			const r = supervisePush({ runId: RUN }, { stateDir: iso7.stateDir, runsDir: iso7.runsDir, steerDir: iso7.steerDir, now: () => NOW });
			assert.equal((r as { reason: string }).reason, "terminal");
		} finally { iso7.dispose(); }
	});
	check("7(d) attention>0（注入 attentionFor）⇒ needs-human", () => {
		const iso7 = mkIsolated("needs-human-attn");
		try {
			const RUN = "tab_nh";
			writeTabDispatch(iso7.runsDir, mkDispatch(RUN, "T", "G:/repo"));
			writeTabState(iso7.runsDir, RUN, mkState(RUN));
			seedLedger(mkLedger(RUN, { stateDir: iso7.stateDir, runsDir: iso7.runsDir }), iso7.stateDir);
			const r = supervisePush({ runId: RUN }, {
				stateDir: iso7.stateDir, runsDir: iso7.runsDir, steerDir: iso7.steerDir, now: () => NOW,
				attentionFor: () => 1,
			});
			assert.equal((r as { reason: string }).reason, "needs-human");
		} finally { iso7.dispose(); }
	});
	check("7(e) gate=awaiting（注入 gateFor）⇒ needs-human", () => {
		const iso7 = mkIsolated("needs-human-gate");
		try {
			const RUN = "tab_nh2";
			writeTabDispatch(iso7.runsDir, mkDispatch(RUN, "T", "G:/repo"));
			writeTabState(iso7.runsDir, RUN, mkState(RUN));
			seedLedger(mkLedger(RUN, { stateDir: iso7.stateDir, runsDir: iso7.runsDir }), iso7.stateDir);
			const r = supervisePush({ runId: RUN }, {
				stateDir: iso7.stateDir, runsDir: iso7.runsDir, steerDir: iso7.steerDir, now: () => NOW,
				gateFor: () => "awaiting",
			});
			assert.equal((r as { reason: string }).reason, "needs-human");
		} finally { iso7.dispose(); }
	});
	check("7(f) stop=error ∧ 本 epoch 已推过 1 次 ⇒ needs-human（行为变更：旧断言是「stop=error 即 needs-human」）", () => {
		const iso7 = mkIsolated("needs-human-stop");
		try {
			const RUN = "tab_nh3";
			writeTabDispatch(iso7.runsDir, mkDispatch(RUN, "T", "G:/x"));
			writeTabState(iso7.runsDir, RUN, mkState(RUN, { lastStopReason: "error" }));
			// 2026-10-18 修正 ①：stop=error 首次（0 次）是**放行**的；推过一次仍 error 才升级给人。
			// 因此本反例必须补 pushes: 1（数量不变，仍是 1 条 check）。
			seedLedger(mkLedger(RUN, { stateDir: iso7.stateDir, runsDir: iso7.runsDir, pushes: 1 }), iso7.stateDir);
			const r = supervisePush({ runId: RUN }, { stateDir: iso7.stateDir, runsDir: iso7.runsDir, steerDir: iso7.steerDir, now: () => NOW });
			assert.equal((r as { reason: string }).reason, "needs-human");
		} finally { iso7.dispose(); }
	});
	check("7(g) state.pid 已死（999999 ESRCH）⇒ pid-dead", () => {
		const iso7 = mkIsolated("pid-dead");
		try {
			const RUN = "tab_pd";
			writeTabDispatch(iso7.runsDir, mkDispatch(RUN, "T", "G:/x"));
			writeTabState(iso7.runsDir, RUN, mkState(RUN, { pid: 999_999 }));
			seedLedger(mkLedger(RUN, { stateDir: iso7.stateDir, runsDir: iso7.runsDir }), iso7.stateDir);
			const r = supervisePush({ runId: RUN }, { stateDir: iso7.stateDir, runsDir: iso7.runsDir, steerDir: iso7.steerDir, now: () => NOW });
			assert.equal((r as { reason: string }).reason, "pid-dead");
		} finally { iso7.dispose(); }
	});
	check("7(h) working + stop=toolUse ⇒ tool-use", () => {
		const iso7 = mkIsolated("tool-use");
		try {
			const RUN = "tab_tu";
			writeTabDispatch(iso7.runsDir, mkDispatch(RUN, "T", "G:/x"));
			writeTabState(iso7.runsDir, RUN, mkState(RUN, { phase: "working", lastStopReason: "toolUse" }));
			seedLedger(mkLedger(RUN, { stateDir: iso7.stateDir, runsDir: iso7.runsDir }), iso7.stateDir);
			const r = supervisePush({ runId: RUN }, { stateDir: iso7.stateDir, runsDir: iso7.runsDir, steerDir: iso7.steerDir, now: () => NOW });
			assert.equal((r as { reason: string }).reason, "tool-use");
		} finally { iso7.dispose(); }
	});
	check("7(i) 1h 内已推 4 次 ⇒ budget-exhausted（滚动节流经真实账本）", () => {
		const iso7 = mkIsolated("hourly");
		try {
			const RUN = "tab_hr";
			writeTabDispatch(iso7.runsDir, mkDispatch(RUN, "T", "G:/x"));
			// lastActivityAt 刚刚 → epoch 从新活动起算 ⇒ thisEpoch 会被压到 0，只有 1h 节流能命中
			writeTabState(iso7.runsDir, RUN, mkState(RUN, { lastActivityAt: iso(1000) }));
			const entry = mkLedger(RUN, { stateDir: iso7.stateDir, runsDir: iso7.runsDir });
			seedLedger({
				...entry,
				epoch: {
					startedAt: iso(50 * 60_000),
					pushes: [0, 1, 2, 3].map((i) => ({ at: iso(40 * 60_000 - i * 60_000), steerId: `steer_h${i}`, outcome: "pending" })),
				},
			}, iso7.stateDir);
			const r = supervisePush({ runId: RUN }, { stateDir: iso7.stateDir, runsDir: iso7.runsDir, steerDir: iso7.steerDir, now: () => NOW });
			assert.equal((r as { reason: string }).reason, "budget-exhausted", `实得 ${JSON.stringify(r)}`);
			assert.match((r as { detail: string }).detail, /4\/4/, "detail 必须说明 1h 节流计数");
		} finally { iso7.dispose(); }
	});
	check("7(j) optOut 账本 ⇒ no-mandate（经真实读路径）", () => {
		const iso7 = mkIsolated("optout");
		try {
			const RUN = "tab_oo";
			writeTabDispatch(iso7.runsDir, mkDispatch(RUN, "T", "G:/x"));
			setSupervisionOptOut(RUN, "user:test", { stateDir: iso7.stateDir, tabRunsDir: iso7.runsDir, now: NOW });
			const r = supervisePush({ runId: RUN }, { stateDir: iso7.stateDir, runsDir: iso7.runsDir, steerDir: iso7.steerDir, now: () => NOW });
			assert.equal((r as { reason: string }).reason, "no-mandate");
		} finally { iso7.dispose(); }
	});
	check("7(k) 空 runId ⇒ io-error（不是第 8 条策略门）", () => {
		const r = supervisePush({ runId: "  " }, { now: () => NOW });
		assert.equal((r as { reason: string }).reason, "io-error");
	});
	check("7(l) 基础设施失败（steerDir 不可写）⇒ io-error 且 detail 说明，且不算策略门", () => {
		const iso7 = mkIsolated("io-error");
		try {
			const RUN = "tab_io";
			writeTabDispatch(iso7.runsDir, mkDispatch(RUN, "T", "G:/x"));
			writeTabState(iso7.runsDir, RUN, mkState(RUN));
			seedLedger(mkLedger(RUN, { stateDir: iso7.stateDir, runsDir: iso7.runsDir }), iso7.stateDir);
			// 用一个「文件」当 steerDir 的父目录 ⇒ mkdir 失败（跨平台稳定的 IO 失败）
			const bogus = join(iso7.stateDir, "not-a-dir");
			writeFileSync(bogus, "x", "utf8");
			const lines: string[] = [];
			const r = supervisePush({ runId: RUN }, {
				stateDir: iso7.stateDir, runsDir: iso7.runsDir, steerDir: bogus, now: () => NOW,
				audit: (l) => lines.push(l),
			});
			assert.equal((r as { reason: string }).reason, "io-error", `实得 ${JSON.stringify(r)}`);
			assert.ok(lines.some((l) => l.includes("supervision-push io-error runId=tab_io")), `审计缺 io-error 行：${lines.join("|")}`);
		} finally { iso7.dispose(); }
	});
}

// ════════════════════ 8. waiting 真路径与 needs-human 反例 ═════════
console.log("8. waiting 真实端到端成功推动；stop=error / gate / attention 仍拒绝");
{
	/**
	 * 已裁决事实：classifyForReclaim 的 awaitingInput 对 phase=waiting 表示「回合已 settled、等人给下一句」，
	 * 这正是 STALLED 形状；frontier.ts 的 BLOCKED_USER 是 P0 展示口径（保留广义 reclaim），
	 * 本工具的动作门按 gate/attention/stop=error 聚合。两者口径差异见 supervision-runtime.ts:349-354。
	 */
	const RUN = "tab_e2e_waiting";
	const isoNow = new Date("2026-10-18T08:00:00.000Z");
	const iso8 = mkIsolated("e2e-waiting");
	try {
		writeTabDispatch(iso8.runsDir, mkDispatch(RUN, "T-WAIT", "G:/code/x"));
		writeTabState(iso8.runsDir, RUN, {
			id: RUN, phase: "waiting", turn: "idle", terminal: false, pid: process.pid,
			lastActivityAt: new Date(isoNow.getTime() - 20 * 60_000).toISOString(),
			lastStopReason: "stop", lastAssistantText: "真实 waiting 状态摘要",
		});
		seedLedger(mkLedger(RUN, { stateDir: iso8.stateDir, runsDir: iso8.runsDir }), iso8.stateDir);
		const auditLines: string[] = [];
		const result = supervisePush({ runId: RUN }, {
			stateDir: iso8.stateDir, runsDir: iso8.runsDir, steerDir: iso8.steerDir, now: () => isoNow,
			audit: (line) => auditLines.push(line),
		});
		check("8(a) 真 writeTabState(waiting)+真账本 ⇒ supervisePush ok，steer/账本/audit 均真实写入", () => {
			assert.equal(result.ok, true, `预期成功推动，实际 ${JSON.stringify(result)}`);
			const ok = result as Extract<SupervisePushResult, { ok: true }>;
			assert.equal(ok.pushIndex, 1);
			assert.ok(readSteerRecord(iso8.steerDir, RUN, ok.steerId), "steer 记录应真落盘");
			assert.equal(readSupervisionLedger(RUN, { stateDir: iso8.stateDir })!.epoch.pushes.length, 1);
			assert.ok(auditLines.some((line) => line.includes(`supervision-push ok runId=${RUN}`)));
		});
		check("8(b) waiting 仍被 classifyForReclaim 视为 settled/awaitingInput，但动作门可推动", () => {
			const view = composeTabStatus({ runId: RUN, dispatch: readTabDispatch(iso8.runsDir, RUN), state: readTabState(iso8.runsDir, RUN), result: null, probe: null });
			assert.equal(classifyForReclaim(view), "awaitingInput");
		});
	} finally { iso8.dispose(); }

	for (const [label, opts] of [
		// 2026-10-18 修正 ①：stop=error 的首推是放行的 ⇒ 反例必须补“已推过一次”才仍是 needs-human
		["stop=error", { state: { lastStopReason: "error" }, pushes: 1 }],
		["gate=awaiting", { gateFor: () => "awaiting" }],
		["attention>0", { attentionFor: () => 1 }],
	] as const) {
		check(`8反例 ${label} ⇒ needs-human`, () => {
			const iso8 = mkIsolated(`counter-${label.replace(/[^a-z]/gi, "")}`);
			try {
				const id = `tab_counter_${label.replace(/[^a-z]/gi, "")}`;
				writeTabDispatch(iso8.runsDir, mkDispatch(id, "T", "G:/x"));
				writeTabState(iso8.runsDir, id, mkState(id, { phase: "waiting", ...opts.state }));
				const pushes = "pushes" in opts ? opts.pushes : 0;
				seedLedger(mkLedger(id, { stateDir: iso8.stateDir, runsDir: iso8.runsDir, pushes }), iso8.stateDir);
				const res = supervisePush({ runId: id }, { stateDir: iso8.stateDir, runsDir: iso8.runsDir, steerDir: iso8.steerDir, now: () => NOW, ...opts });
				assert.equal((res as { reason: string }).reason, "needs-human", `预期 needs-human，实际 ${JSON.stringify(res)}`);
			} finally { iso8.dispose(); }
		});
	}
}

// ════════════════════ 9. P1 修正（2026-10-18）：needsHuman 拆分 / 自动选档 / wake 监管块派发 ══
// 任务书：`plans/20261018_P1_push_fix_task_brief.md`；实现报告：`plans/20261018_P1_push_fix_impl.md`
console.log("9. P1 修正：① stop=error 首推放行 ② mode 按相位自动选 ③ evaluateWakes 真派发监管块");
{
	// ── 9(a) stop=error 且本 epoch 未推过 ⇒ 放行（推成功 + steer 真落盘 + pushes+1）
	check("9(a) stop=error ∧ pushesThisEpoch=0（无 gate/attention、不传 mode）⇒ ok:true + steer 真落盘 + pushes+1", () => {
		const iso9 = mkIsolated("err-first-push");
		try {
			const RUN = "tab_err_first";
			writeTabDispatch(iso9.runsDir, mkDispatch(RUN, "T-ERR", "G:/code/GreenCAD"));
			writeTabState(iso9.runsDir, RUN, mkState(RUN, { phase: "waiting", lastStopReason: "error" }));
			seedLedger(mkLedger(RUN, { stateDir: iso9.stateDir, runsDir: iso9.runsDir }), iso9.stateDir);
			const auditLines: string[] = [];
			const res = supervisePush({ runId: RUN }, {
				stateDir: iso9.stateDir, runsDir: iso9.runsDir, steerDir: iso9.steerDir, now: () => NOW,
				audit: (l) => auditLines.push(l),
			});
			assert.equal(res.ok, true, `stop=error 首推必须放行，实得 ${JSON.stringify(res)}`);
			const ok = res as Extract<SupervisePushResult, { ok: true }>;
			assert.ok(readSteerRecord(iso9.steerDir, RUN, ok.steerId), "steer 必须真落盘");
			assert.equal(readSupervisionLedger(RUN, { stateDir: iso9.stateDir })!.epoch.pushes.length, 1, "账本 pushes 必须 +1");
			// errored-retry 标记只写进 audit 行（不新增账本字段）
			assert.ok(
				auditLines.some((l) => l.includes(`supervision-push ok runId=${RUN}`) && l.includes("erroredRetry=1")),
				`audit 行必须带 erroredRetry=1：${auditLines.join(" | ")}`,
			);
		} finally { iso9.dispose(); }
	});

	// ── 9(b) stop=error 且已推过 1 次 ⇒ needs-human
	check("9(b) stop=error ∧ pushesThisEpoch=1 ⇒ 拒绝 needs-human", () => {
		const iso9 = mkIsolated("err-already-pushed");
		try {
			const RUN = "tab_err_pushed";
			writeTabDispatch(iso9.runsDir, mkDispatch(RUN, "T-ERR2", "G:/code/GreenCAD"));
			writeTabState(iso9.runsDir, RUN, mkState(RUN, { phase: "waiting", lastStopReason: "error" }));
			seedLedger(mkLedger(RUN, { stateDir: iso9.stateDir, runsDir: iso9.runsDir, pushes: 1 }), iso9.stateDir);
			const res = supervisePush({ runId: RUN }, { stateDir: iso9.stateDir, runsDir: iso9.runsDir, steerDir: iso9.steerDir, now: () => NOW });
			assert.equal((res as { reason: string }).reason, "needs-human", `实得 ${JSON.stringify(res)}`);
			assert.match((res as { detail: string }).detail, /stop=error/, "detail 必须说明是 stop=error 升级");
			assert.equal(existsSync(join(iso9.steerDir, RUN)), false, "被拒时不得落盘 steer");
		} finally { iso9.dispose(); }
	});

	// ── 9(c) gate=awaiting 不受 ① 影响
	check("9(c) gate=awaiting（gateFor）+ stop=error + 0 次推送 ⇒ 仍 needs-human（不受 ① 放行影响）", () => {
		const iso9 = mkIsolated("gate-still-blocks");
		try {
			const RUN = "tab_gate_err";
			writeTabDispatch(iso9.runsDir, mkDispatch(RUN, "T", "G:/repo"));
			writeTabState(iso9.runsDir, RUN, mkState(RUN, { phase: "waiting", lastStopReason: "error" }));
			seedLedger(mkLedger(RUN, { stateDir: iso9.stateDir, runsDir: iso9.runsDir }), iso9.stateDir);
			const res = supervisePush({ runId: RUN }, {
				stateDir: iso9.stateDir, runsDir: iso9.runsDir, steerDir: iso9.steerDir, now: () => NOW,
				gateFor: () => "awaiting",
			});
			assert.equal((res as { reason: string }).reason, "needs-human", `实得 ${JSON.stringify(res)}`);
		} finally { iso9.dispose(); }
	});

	// ── 9(d) attention>0 不受 ① 影响
	check("9(d) attention=1（attentionFor）+ stop=error + 0 次推送 ⇒ 仍 needs-human（不受 ① 放行影响）", () => {
		const iso9 = mkIsolated("attn-still-blocks");
		try {
			const RUN = "tab_attn_err";
			writeTabDispatch(iso9.runsDir, mkDispatch(RUN, "T", "G:/repo"));
			writeTabState(iso9.runsDir, RUN, mkState(RUN, { phase: "waiting", lastStopReason: "error" }));
			seedLedger(mkLedger(RUN, { stateDir: iso9.stateDir, runsDir: iso9.runsDir }), iso9.stateDir);
			const res = supervisePush({ runId: RUN }, {
				stateDir: iso9.stateDir, runsDir: iso9.runsDir, steerDir: iso9.steerDir, now: () => NOW,
				attentionFor: () => 1,
			});
			assert.equal((res as { reason: string }).reason, "needs-human", `实得 ${JSON.stringify(res)}`);
		} finally { iso9.dispose(); }
	});

	// ── 9(e) phase=waiting ∧ 未传 mode ⇒ 自动 abort（真读 steer 记录）
	check("9(e) phase=waiting ∧ 未传 mode ⇒ 落盘 steer 记录 mode===\"abort\"（自动选档）", () => {
		const iso9 = mkIsolated("auto-abort");
		try {
			const RUN = "tab_auto_abort";
			writeTabDispatch(iso9.runsDir, mkDispatch(RUN, "T-AUTO", "G:/code/x"));
			writeTabState(iso9.runsDir, RUN, mkState(RUN, { phase: "waiting", lastStopReason: "stop" }));
			seedLedger(mkLedger(RUN, { stateDir: iso9.stateDir, runsDir: iso9.runsDir }), iso9.stateDir);
			const res = supervisePush({ runId: RUN }, { stateDir: iso9.stateDir, runsDir: iso9.runsDir, steerDir: iso9.steerDir, now: () => NOW });
			assert.equal(res.ok, true, `实得 ${JSON.stringify(res)}`);
			const ok = res as Extract<SupervisePushResult, { ok: true }>;
			assert.equal(ok.mode, "abort", "waiting 未传 mode ⇒ abort（唯一能起新 turn 的档）");
			const rec = readSteerRecord(iso9.steerDir, RUN, ok.steerId);
			assert.ok(rec, "steer 记录必须存在");
			assert.equal(rec!.mode, "abort", "落盘记录 mode 必须 abort");
			const ledger = readSupervisionLedger(RUN, { stateDir: iso9.stateDir });
			const last = ledger!.epoch.pushes[ledger!.epoch.pushes.length - 1] as unknown as Record<string, unknown>;
			assert.equal(last.mode, "abort", "pushes[] 里也记 abort");
		} finally { iso9.dispose(); }
	});

	// ── 9(f) phase=working ∧ stop=stop ∧ 未传 mode ⇒ steer
	check("9(f) phase=working ∧ stopReason=stop ∧ 未传 mode ⇒ 落盘 mode===\"steer\"（不打断工具）", () => {
		const iso9 = mkIsolated("auto-steer");
		try {
			const RUN = "tab_auto_steer";
			writeTabDispatch(iso9.runsDir, mkDispatch(RUN, "T-AUTO2", "G:/code/x"));
			writeTabState(iso9.runsDir, RUN, mkState(RUN, { phase: "working", lastStopReason: "stop" }));
			seedLedger(mkLedger(RUN, { stateDir: iso9.stateDir, runsDir: iso9.runsDir }), iso9.stateDir);
			const res = supervisePush({ runId: RUN }, { stateDir: iso9.stateDir, runsDir: iso9.runsDir, steerDir: iso9.steerDir, now: () => NOW });
			assert.equal(res.ok, true, `实得 ${JSON.stringify(res)}`);
			const ok = res as Extract<SupervisePushResult, { ok: true }>;
			assert.equal(ok.mode, "steer");
			assert.equal(readSteerRecord(iso9.steerDir, RUN, ok.steerId)!.mode, "steer");
		} finally { iso9.dispose(); }
	});

	// ── 9(g) 显式 mode=steer ∧ phase=waiting ⇒ steer（显式优先）
	check("9(g) 显式 mode=\"steer\" ∧ phase=waiting ⇒ 落盘 mode===\"steer\"（显式优先，不被自动选覆盖）", () => {
		const iso9 = mkIsolated("explicit-wins");
		try {
			const RUN = "tab_explicit_steer";
			writeTabDispatch(iso9.runsDir, mkDispatch(RUN, "T-EXP", "G:/code/x"));
			writeTabState(iso9.runsDir, RUN, mkState(RUN, { phase: "waiting", lastStopReason: "stop" }));
			seedLedger(mkLedger(RUN, { stateDir: iso9.stateDir, runsDir: iso9.runsDir }), iso9.stateDir);
			const res = supervisePush({ runId: RUN, mode: "steer" }, { stateDir: iso9.stateDir, runsDir: iso9.runsDir, steerDir: iso9.steerDir, now: () => NOW });
			assert.equal(res.ok, true, `实得 ${JSON.stringify(res)}`);
			const ok = res as Extract<SupervisePushResult, { ok: true }>;
			assert.equal(ok.mode, "steer", "显式 steer 不得被 waiting 的自动 abort 覆盖");
			assert.equal(readSteerRecord(iso9.steerDir, RUN, ok.steerId)!.mode, "steer");
		} finally { iso9.dispose(); }
	});

	// ── 9(h)/(i)：走 evaluateWakes 真实入口（setCutover + attachMaster + createWorkstream + deliverLetter）
	await (async () => {
		const T = NOW.getTime();
		const SESS = "sess-p1-fix";

		/** evaluateWakes 真实入口（同 `_test_autonomy_wiring.ts` W1 写法）。 */
		function fireViaEvaluateWakes(label: string): { root: string; stateDir: string; runsDir: string; prompt: string; wsId: string; ws: unknown; messageId: string; dispose: () => void } {
			const rt = mkIsolated(label);
			mkdirSync(rt.stateDir, { recursive: true });
			mkdirSync(rt.runsDir, { recursive: true });
			const root = dirname(rt.stateDir);
			process.env.PI_RUNTIME_DIR = root; // registry/cutover + mailbox 都走 temp
			const mailboxDir = join(root, "mailbox");
			setCutover(true, `${label}-test`);
			attachMaster({ sessionId: SESS });
			const ws = createWorkstream({
				stateDir: rt.stateDir, session: SESS, mission: `P1 修正 ${label}`,
				wakePolicy: { enabled: true, cooldownMs: 60_000 },
			});
			const messageId = `msg_p1fix_${label.replace(/[^a-z0-9]/gi, "")}`;
			const frame = newMessageFrame({
				// kind=ACK ⇒ requiresAck=false ⇒ prompt 无回执块 ⇒ 可逐字节手写冻结字面量（见 9(h)）
				id: messageId, kind: "ACK", from: "agent://a", to: workstreamAddress(ws.id),
				subject: `run://tab/${label}`, sentAt: new Date(T - 5_000).toISOString(),
				summary: "do the thing", details: { tabRunId: "t", status: "completed" },
			});
			deliverLetter(frame, { mailboxDir });
			const decisions = evaluateWakes({
				stateDir: rt.stateDir, mailboxDir, runsDir: rt.runsDir, sessionId: SESS, now: T,
				autonomyConfigPath: cfgNoKey, // temp no-key config：避开生产 config.json（R-1 / R10）
			});
			assert.equal(decisions.length, 1, `evaluateWakes 必须评估 1 个 ws，实得 ${decisions.length}`);
			assert.equal(decisions[0]!.fire, true, `必须 fire，实得 ${JSON.stringify(decisions[0])}`);
			return {
				root, stateDir: rt.stateDir, runsDir: rt.runsDir,
				prompt: decisions[0]!.prompt ?? "", wsId: ws.id, ws, messageId,
				// 注意：旧进程级去重集合（auditedSkip）按 ws:<reason> 键去重，每场景独立 ws ⇒ 无需重置
				dispose: () => { rt.dispose(); },
			};
		}

		await checkAsync("9(h) evaluateWakes 无监管账本 ⇒ fire prompt 与手写冻结字面量/baseline 逐字节相等且不含 supervise-push", async () => {
			const r = fireViaEvaluateWakes("evaluateWakes-none");
			try {
				// 手写冻结字面量（**不是**调两次比两次）：与第 4 组 FROZEN 同形，subject/summary 按本场景填。
				// 来信 kind=ACK ⇒ requiresAck=false ⇒ 无回执块 ⇒ 全文可人工写死（含 ws id 与 messageId）。
				const FROZEN = [
					`你是 workstream ${r.wsId} 的 Sub-Master（runtime wake 层唤醒，有终态的一次执行）。`,
					"mission=P1 修正 evaluateWakes-none",
					"待处理输入（1）：",
					"- [run://tab/evaluateWakes-none] do the thing",
					"规则：单次有界执行，做完即 tab-finish（天然 sleep）；禁止设 timer 自续命，再入只能经 wake 层；",
					"无 actionable 输入时立即 tab-finish 报 no-op，不许挂等；",
					"workstream 暂停时你不会被唤醒（由 wake 层保证）。",
				].join("\n");
				assert.equal(r.prompt, FROZEN, `无账本 ⇒ prompt 必须与冻结字面量逐字节相同：\n${r.prompt}`);

				// 第二道：与 buildWakePrompt(ws, letters) 基线逐字节相等（letters 按 describeLetter 同字段手写）
				const LETTERS: WakeLetter[] = [{
					messageId: r.messageId,
					subject: "run://tab/evaluateWakes-none",
					summary: "do the thing",
					sentAt: new Date(T - 5_000).toISOString(),
					from: "agent://a" as never,
					to: workstreamAddress(r.wsId) as never,
					requiresAck: false,
				}];
				assert.equal(r.prompt, buildWakePrompt(r.ws as never, LETTERS), "evaluateWakes 输出必须等于 buildWakePrompt 基线（无第三参）");
				assert.ok(!r.prompt.includes("supervise-push"), "无账本时 prompt 不得出现 supervise-push");
				assert.ok(!r.prompt.includes("停滞监管"), "无账本时 prompt 不得出现监管块");
			} finally { r.dispose(); }
		});

		await checkAsync("9(i) 有 STALLED 账本（真 writeSupervisionEntry + 真 writeTabState waiting/idle>pushMs）⇒ fire prompt 含 supervise-push 与 runId", async () => {
			// 先建 runtime 与 ws（fireViaEvaluateWakes 内部会跑 evaluateWakes，所以账本必须预先落盘）
			const rt = mkIsolated("evaluateWakes-stalled");
			mkdirSync(rt.stateDir, { recursive: true });
			mkdirSync(rt.runsDir, { recursive: true });
			const root = dirname(rt.stateDir);
			process.env.PI_RUNTIME_DIR = root;
			const mailboxDir = join(root, "mailbox");
			const RUN_ID = "tab_wake_stalled";
			try {
				// STALLED 形状：active ∧ waiting ∧ stop=stop ∧ idle 20min > pushMs 15min
				writeTabDispatch(rt.runsDir, mkDispatch(RUN_ID, "T-WAKE-STALL", "G:/code/GreenCAD"));
				writeTabState(rt.runsDir, RUN_ID, mkState(RUN_ID, {
					phase: "waiting", lastStopReason: "stop", lastActivityAt: iso(20 * 60_000),
					lastAssistantText: "卡在 RF-1 测试",
				}));
				const entry = mkLedger(RUN_ID, { stateDir: rt.stateDir, runsDir: rt.runsDir });
				const w = writeSupervisionEntry(entry, { stateDir: rt.stateDir });
				assert.equal(w.ok, true, `writeSupervisionEntry 必须成功：${JSON.stringify(w)}`);

				setCutover(true, "evaluateWakes-stalled-test");
				attachMaster({ sessionId: SESS });
				const ws = createWorkstream({
					stateDir: rt.stateDir, session: SESS, mission: "P1 修正 stalled",
					wakePolicy: { enabled: true, cooldownMs: 60_000 },
				});
				deliverLetter(newMessageFrame({
					id: newEnvelopeId("msg"), kind: "REPORT", from: "agent://a", to: workstreamAddress(ws.id),
					subject: "run://tab/tab_wake_stalled", sentAt: new Date(T - 5_000).toISOString(),
					summary: "do the thing", details: { tabRunId: "t", status: "completed" },
				}), { mailboxDir });
				const decisions = evaluateWakes({
					stateDir: rt.stateDir, mailboxDir, runsDir: rt.runsDir, sessionId: SESS, now: T,
					autonomyConfigPath: cfgNoKey,
				});
				assert.equal(decisions.length, 1);
				const prompt = decisions[0]!.prompt ?? "";
				assert.equal(decisions[0]!.fire, true, `必须 fire：${JSON.stringify(decisions[0])}`);
				assert.ok(prompt.includes("supervise-push"), `prompt 必须含 supervise-push：\n${prompt}`);
				assert.ok(prompt.includes(RUN_ID), `prompt 必须含 runId ${RUN_ID}：\n${prompt}`);
				assert.ok(prompt.includes("停滞监管"), "prompt 必须含监管块标题");
				assert.ok(prompt.includes("已停 20min"), `监管行必须带真实 idle 分钟：\n${prompt}`);
				assert.ok(prompt.includes("push=0/2"), `监管行必须带预算：\n${prompt}`);
			} finally { rt.dispose(); }
		});
	})();
}

// ════════════════════ 10. 跨提交交互（GLM D-1）：兜底 unconfirmed ≠ terminal 证据 ══
// 任务书：`plans/20261018_glm_fix2_task_brief.md`；实现报告：`plans/20261018_glm_fix2_impl.md`
// 背景：dd13dba 的 writeSettlementFallback 会在 stop=error 的 tab agent_settled 同秒写一条
// status:"unconfirmed" 的 result。若 supervisePush 仍用 `result !== null` 判 terminal，
// 41265f4 刚放行的「stop=error 首推」就被同秒兜底吞掉（SBS-B1 实测形状）。
// 本组必须**经真实读路径**（真 dispatch + 真 state + 真 result 文件 + 真账本），不直调守卫纯函数。
console.log("10. 跨提交交互：兜底 unconfirmed 不得作为 terminal 证据（stop=error 首推仍放行）");
{
	// ── 10(a) stop=error + 真 unconfirmed result（兜底形状）+ pushes=0 ⇒ 放行
	check("10(a) stop=error ∧ result={status:\"unconfirmed\",autoGenerated:true} ∧ pushesThisEpoch=0 ⇒ ok:true + steer 真落盘 + pushes=1", () => {
		const iso10 = mkIsolated("fallback-not-terminal");
		try {
			const RUN = "tab_err_unconfirmed";
			writeTabDispatch(iso10.runsDir, mkDispatch(RUN, "T-SBS-B1", "G:/code/GreenCAD"));
			writeTabState(iso10.runsDir, RUN, mkState(RUN, { phase: "waiting", lastStopReason: "error" }));
			// 真 result 文件：用兜底写入器的唯一构造规则落盘（与 writeSettlementFallback 同字段口径）
			writeJsonAtomic(tabResultPath(iso10.runsDir, RUN), {
				id: RUN,
				taskId: "T-SBS-B1",
				status: "unconfirmed",
				autoGenerated: true,
				finishedAt: iso(10_000),
				summary: "tab 回合结束但未调用 tab-finish (lastStopReason=error)（可能忘记回报）；主会话应主动 reclaim 并核实实际进度",
				artifacts: [],
				openIssues: ["未调用 tab-finish，成果未经结构化声明"],
			});
			// 先确认夹具形状真实：composeTabStatus 必须把兜底 result 派生成 phase=unconfirmed/terminal=false
			const view = composeTabStatus({
				runId: RUN, dispatch: readTabDispatch(iso10.runsDir, RUN), state: readTabState(iso10.runsDir, RUN),
				result: readTabResultFile(iso10.runsDir, RUN), probe: null,
			});
			assert.equal(view.phase, "unconfirmed", "夹具必须是兜底形状（phase=unconfirmed）");
			assert.equal(view.terminal, false, "兜底 result 在 view 层已判 terminal=false");
			seedLedger(mkLedger(RUN, { stateDir: iso10.stateDir, runsDir: iso10.runsDir }), iso10.stateDir);

			const res = supervisePush({ runId: RUN }, {
				stateDir: iso10.stateDir, runsDir: iso10.runsDir, steerDir: iso10.steerDir, now: () => NOW,
			});
			assert.equal(res.ok, true, `stop=error + 兜底 unconfirmed 首推必须放行，实得 ${JSON.stringify(res)}`);
			const ok = res as Extract<SupervisePushResult, { ok: true }>;
			assert.ok(readSteerRecord(iso10.steerDir, RUN, ok.steerId), "steer 必须真落盘");
			assert.equal(readSupervisionLedger(RUN, { stateDir: iso10.stateDir })!.epoch.pushes.length, 1, "账本 pushes 必须 +1");
		} finally { iso10.dispose(); }
	});

	// ── 10(b) 对照：真结果（status=completed）⇒ 仍被 terminal 门拒（证明 10(a) 没把门拆了）
	check("10(b) 对照：result={status:\"completed\"}（真 tab-finish）⇒ 仍拒绝 terminal，且不落 steer", () => {
		const iso10 = mkIsolated("real-result-terminal");
		try {
			const RUN = "tab_err_completed";
			writeTabDispatch(iso10.runsDir, mkDispatch(RUN, "T-REAL", "G:/code/GreenCAD"));
			writeTabState(iso10.runsDir, RUN, mkState(RUN, { phase: "waiting", lastStopReason: "error" }));
			writeJsonAtomic(tabResultPath(iso10.runsDir, RUN), {
				id: RUN, taskId: "T-REAL", status: "completed", finishedAt: iso(10_000),
				summary: "真完成", artifacts: [],
			});
			seedLedger(mkLedger(RUN, { stateDir: iso10.stateDir, runsDir: iso10.runsDir }), iso10.stateDir);
			const res = supervisePush({ runId: RUN }, {
				stateDir: iso10.stateDir, runsDir: iso10.runsDir, steerDir: iso10.steerDir, now: () => NOW,
			});
			assert.equal(res.ok, false, `真终态必须仍被拒，实得 ${JSON.stringify(res)}`);
			assert.equal((res as { reason: string }).reason, "terminal", `必须命中 terminal 门，实得 ${JSON.stringify(res)}`);
			assert.equal(existsSync(join(iso10.steerDir, RUN)), false, "被拒时不得落盘 steer");
		} finally { iso10.dispose(); }
	});
}

// ════════════════════ 11. scope wake prompt 监管块（2026-10-18 G1-1 断点 ②）════
// 任务书：`plans/20261018_group1_task_brief.md`；实现规格：`plans/20261018_group1_impl_spec.md` §2/§4.3。
// 核心：`buildScopeWakePrompt` 第四参走**与 workstream 路同一套** deriveSupervisionItems/buildSupervisionBlock；
// 无监管 ⇒ 输出与三参调用**逐字节相同**（冻结字面量断言，不是“调两次比两次”）。
console.log("11. scope wake prompt 监管块（第四参 + repo 过滤 + 逐字节冻结）");
{
	const SCOPE11 = "GreenCAD";
	const REPO11 = "G:/code/GreenCAD";
	const L11: WakeLetter[] = [
		{
			messageId: "msg_scope_p1",
			subject: "autonomy-notify/stagnation",
			summary: "[autonomy] stagnation @ G:/code/GreenCAD",
			sentAt: iso(60_000),
			requiresAck: false,
		},
	];
	// 手写冻结字面量（照 buildScopeWakePrompt 现有行序/标点写死）——不是“调两次比两次”。
	const SCOPE_FROZEN = [
		"你是仓库 GreenCAD 的本地 Sub-Master（local master v1 唤醒，有终态的一次执行）。",
		"工作目录：G:/code/GreenCAD（本仓）",
		"待处理输入（1）：",
		"- [autonomy-notify/stagnation] [autonomy] stagnation @ G:/code/GreenCAD",
		"规则：单次有界执行，做完即 tab-finish（天然 sleep）；禁止设 timer 自续命，再入只能经本地 wake 层；",
		"无 actionable 输入时立即 tab-finish 报 no-op，不许挂等；",
		"你不是全局 Master：不得调用 master-attach/master-transfer/master-cutover，不处理 run 完成回收（run 归派发者）。",
	].join("\n");

	check("11(a) 三参调用 ⇒ 与手写冻结字面量逐字节相同", () => {
		assert.equal(buildScopeWakePrompt(SCOPE11, L11, REPO11), SCOPE_FROZEN);
	});
	check("11(b) 传 undefined / [] ⇒ 同样逐字节相同（空监管不得留下空行/空块）", () => {
		assert.equal(buildScopeWakePrompt(SCOPE11, L11, REPO11, undefined), SCOPE_FROZEN);
		assert.equal(buildScopeWakePrompt(SCOPE11, L11, REPO11, []), SCOPE_FROZEN);
		// 无工作目录（repoCwd=null）分支也钉死（不传监管时不得多出空行）
		const FROZEN_NO_CWD = SCOPE_FROZEN.split("\n").filter((l) => !l.startsWith("工作目录：")).join("\n");
		assert.equal(buildScopeWakePrompt(SCOPE11, L11, null), FROZEN_NO_CWD);
	});
	check("11(c) 真账本（本仓 tab + stop=error）⇒ prompt 含 停滞监管 / runId / supervise-push", () => {
		const rt = mkIsolated("scope-block");
		try {
			process.env.PI_RUNTIME_DIR = dirname(rt.stateDir);
			const RUN_ID = "tab_scope_blocked";
			writeTabDispatch(rt.runsDir, mkDispatch(RUN_ID, "T-SCOPE", REPO11));
			writeTabState(rt.runsDir, RUN_ID, mkState(RUN_ID, { phase: "waiting", lastStopReason: "error", lastAssistantText: "连接错误卡住" }));
			seedLedger(mkLedger(RUN_ID, { stateDir: rt.stateDir, runsDir: rt.runsDir }), rt.stateDir);

			// 走 evaluateScopeWake 的**同一派生函数**（不是手写 item）⇒ 证明生产参数形状正确
			const items = deriveSupervisionItems({ stateDir: rt.stateDir, runsDir: rt.runsDir, now: NOW.getTime(), repoPath: REPO11 });
			assert.ok(items && items.length === 1, `本仓账本必须派生 1 条，实得 ${JSON.stringify(items)}`);
			assert.equal(items![0]!.runId, RUN_ID);
			const p = buildScopeWakePrompt(SCOPE11, L11, REPO11, items);
			assert.ok(p.includes("停滞监管"), `prompt 必须含监管块标题：\n${p}`);
			assert.ok(p.includes(RUN_ID), "prompt 必须含 runId");
			assert.ok(p.includes('supervise-push({runId:"' + RUN_ID + '"})'), `prompt 必须含 supervise-push 指令：\n${p}`);
			assert.notEqual(p, SCOPE_FROZEN, "非空监管必须与冻结字面量不同");
			// 位置：待处理输入 之后 / 规则 之前（与 buildWakePrompt 同位置）
			const atInput = p.indexOf("待处理输入（1）");
			const atSup = p.indexOf("停滞监管");
			const atRule = p.indexOf("规则：单次有界执行");
			assert.ok(atInput >= 0 && atSup > atInput && atRule > atSup, `顺序不符 input=${atInput} sup=${atSup} rule=${atRule}`);
			// 其余行零改动：去掉监管块返回冻结字面量
			assert.equal(p.replace(p.slice(atSup, atRule), ""), SCOPE_FROZEN, "插入监管块不得改动任何既有行");
		} finally {
			rt.dispose();
		}
	});
	check("11(d) 账本只有他仓条目 ⇒ 本仓 prompt 不含监管块（repo 过滤生效）", () => {
		const rt = mkIsolated("scope-filter");
		try {
			process.env.PI_RUNTIME_DIR = dirname(rt.stateDir);
			const OTHER_RUN = "tab_other_repo";
			writeTabDispatch(rt.runsDir, mkDispatch(OTHER_RUN, "T-OTHER", "H:/code/battlesandbox"));
			writeTabState(rt.runsDir, OTHER_RUN, mkState(OTHER_RUN, { phase: "waiting", lastStopReason: "error" }));
			seedLedger(mkLedger(OTHER_RUN, { stateDir: rt.stateDir, runsDir: rt.runsDir }), rt.stateDir);

			// 不过滤（workstream 路行为）⇒ 能看到；过滤到本仓 ⇒ undefined
			const all = deriveSupervisionItems({ stateDir: rt.stateDir, runsDir: rt.runsDir, now: NOW.getTime() });
			assert.ok(all && all.length === 1, "不过滤时必须看得见他仓条目（workstream 路零变化）");
			const mine = deriveSupervisionItems({ stateDir: rt.stateDir, runsDir: rt.runsDir, now: NOW.getTime(), repoPath: REPO11 });
			assert.equal(mine, undefined, "他仓条目必须被过滤掉（过滤后为空 ⇒ undefined）");
			assert.equal(
				buildScopeWakePrompt(SCOPE11, L11, REPO11, mine),
				SCOPE_FROZEN,
				"过滤后无条目 ⇒ prompt 必须逐字节回到冻结字面量",
			);
			// 子目录形状（dispatch.cwd 在本仓子目录）也必须命中
			const SUB = "G:/code/GreenCAD/src/nested";
			const SUB_RUN = "tab_sub_dir";
			writeTabDispatch(rt.runsDir, mkDispatch(SUB_RUN, "T-SUB", SUB));
			writeTabState(rt.runsDir, SUB_RUN, mkState(SUB_RUN, { phase: "waiting", lastStopReason: "error" }));
			seedLedger(mkLedger(SUB_RUN, { stateDir: rt.stateDir, runsDir: rt.runsDir }), rt.stateDir);
			const subItems = deriveSupervisionItems({ stateDir: rt.stateDir, runsDir: rt.runsDir, now: NOW.getTime(), repoPath: REPO11 });
			assert.ok(subItems && subItems.length === 1 && subItems[0]!.runId === SUB_RUN, "子目录中的 tab 必须算作本仓");
		} finally {
			rt.dispose();
		}
	});
}

// ════════════════════ 12. 端到端到执行者之前（真实入口，AGENTS R-4）════
// 链：buildFrontier 产 blocked_overdue → writeFrontierSnapshot → runAutonomyActions（双层合取 + 映射 + 投递）
//     → scope mailbox 真出现 msg_autonomy*.json → evaluateScopeWake 火起且 prompt 带监管块。
// **不断言** supervise-push 被调用成功 —— 断点 #4（标签页身份门）见 e2e proof 报告。
console.log("12. 端到端（到执行者之前）：frontier → actions → scope mailbox → scope wake prompt");
{
	const SCOPE12 = "autonomy-stage2-probe";
	const PROJECT12 = "c:/tmp/autonomy-stage2-probe"; // 无主仓路径；scope = 末段 basename
	const RUN12 = "tab_e2e_blocked";
	const SESS12 = "sess-g1-e2e";

	function mkSourceTab(over: Partial<FrontierSourceTab> = {}): FrontierSourceTab {
		return {
			runId: RUN12,
			repoPath: PROJECT12,
			phase: "waiting",
			stop: "error", // ⇒ 六态派生 BLOCKED_USER
			idleMs: 31 * 60_000, // > userMs 30min ⇒ blocked_overdue
			needsHuman: true,
			gate: "unknown",
			staleOver: false,
			overdue: 0,
			resultMissing: false,
			pidAlive: true,
			...over,
		};
	}

	check("12(a) 真链：blocked_overdue → actions 投信 autonomy-notify/blocked_overdue → scope wake fire 且 prompt 带监管块", () => {
		const rt = mkIsolated("e2e-scope");
		try {
			const root = dirname(rt.stateDir);
			process.env.PI_RUNTIME_DIR = root;
			const mailboxDir = defaultMailboxDir();

			// ① 执行者前置：真 dispatch/state/账本（执行者被推动时 supervisor 要读的那套）
			writeTabDispatch(rt.runsDir, mkDispatch(RUN12, "T-E2E", PROJECT12));
			writeTabState(rt.runsDir, RUN12, mkState(RUN12, { phase: "waiting", lastStopReason: "error", lastAssistantText: "连接错误卡住" }));
			seedLedger(mkLedger(RUN12, { stateDir: rt.stateDir, runsDir: rt.runsDir }), rt.stateDir);

			// ② tick 检测：buildFrontier 两帧（基线 + 真差分）⇒ blocked_overdue 触发
			const snap = () => ({
				attentionByRepo: {} as Record<string, number>,
				details: [mkSourceTab()],
				history: [] as { id: string; reason: string }[],
			});
			const ledgerInput = [{ runId: RUN12, status: "active" as const, epochPushes: 0 }];
			const f1 = buildFrontier({ snapshot: snap(), backlog: [], prev: null, now: NOW.getTime() - 60_000, supervision: ledgerInput });
			const f2 = buildFrontier({ snapshot: snap(), backlog: [], prev: f1.next, now: NOW.getTime(), supervision: ledgerInput });
			const od = f2.diff.triggers.filter((t) => t.rule === "blocked_overdue");
			assert.equal(od.length, 1, `帧2 必须产 blocked_overdue，实得 ${JSON.stringify(f2.diff.triggers)}`);
			assert.equal(od[0]!.runId, RUN12);
			assert.equal(writeFrontierSnapshot(f2.next, { stateDir: rt.stateDir }), true, "frontier 快照必须落盘");

			// ③ 动作面：真 config（autonomy.enabled ∧ actions.enabled）+ 全局 owner 在位 + scope owner 在位
			const cfgOn = join(root, "actions-on.json");
			writeFileSync(cfgOn, JSON.stringify({ autonomy: { enabled: true, actions: { enabled: true } } }), "utf8");
			setCutover(true, "g1-e2e");
			attachMaster({ sessionId: SESS12 }); // 全局 master owner（L0 isOwner）
			const scope = localMasterAddress(localMasterScope(PROJECT12));
			const att = attachMaster({ sessionId: SESS12, agent: scope, detail: PROJECT12 });
			assert.equal(att.ok, true, `scope owner attach 必须成功：${JSON.stringify(att)}`);
			assert.equal(localMasterScope(PROJECT12), SCOPE12, "夹具 scope 必须等于预期段");

			runAutonomyActions({ stateDir: rt.stateDir, configPath: cfgOn, sessionId: SESS12, now: NOW.getTime() });

			// ④ scope mailbox 真出现信件（existsSync + 读回 subject）
			const scopeMailbox = join(mailboxDir, scope.replace(/[^A-Za-z0-9._-]/g, "_"));
			const files = existsSync(scopeMailbox) ? readdirSync(scopeMailbox).filter((n) => n.startsWith("msg_autonomy")) : [];
			assert.equal(files.length, 1, `scope mailbox 必须恰一封 msg_autonomy*.json，实得 ${JSON.stringify(files)}`);
			// 落盘形状 = Letter 信封 { frame, status, expiresAt }（deliverLetter:108）⇒ 字段在 frame 里
			const letter = JSON.parse(readFileSync(join(scopeMailbox, files[0]!), "utf8"));
			assert.equal(letter.status, "pending", "信件必须是 pending（未被消费）");
			assert.equal(letter.frame.subject, "autonomy-notify/blocked_overdue", "信件 subject 必须是本规则");
			assert.equal(letter.frame.to, scope, "信件必须投到本仓 scope master");
			assert.equal(letter.frame.body.details.rule, "blocked_overdue", "信件 details.rule 必须是本规则");

			// ⑤ 执行者被拉起：evaluateScopeWake 真实入口 ⇒ fire + prompt 带监管块 + 目标 runId
			const d = evaluateScopeWake({
				sessionId: SESS12, scope: SCOPE12, stateDir: rt.stateDir, runsDir: rt.runsDir, mailboxDir, now: NOW.getTime(),
			});
			assert.equal(d.fire, true, `scope wake 必须 fire，实得 ${JSON.stringify({ ...d, prompt: undefined })}`);
			assert.equal(d.repoCwd, PROJECT12, "repoCwd 读回 attachment.detail");
			assert.ok(d.prompt!.includes("blocked_overdue"), `prompt 必须带回本规则名：\n${d.prompt}`);
			assert.ok(d.prompt!.includes("停滞监管"), `prompt 必须含监管块：\n${d.prompt}`);
			assert.ok(d.prompt!.includes(RUN12), "prompt 必须含目标 runId（执行者据此调 supervise-push）");
			assert.ok(d.prompt!.includes("supervise-push"), "prompt 必须含 supervise-push 指令");
		} finally {
			rt.dispose();
		}
	});
}

// ── 清理 + 汇总 ─────────────────────────────────────────────────────
rmSync(ENV_TMP, { recursive: true, force: true });
if (failed > 0) {
	console.error(`_test_runtime_supervision_push: FAILED (${failed} failed / ${passed} passed)`);
	process.exit(1);
}
console.log(`_test_runtime_supervision_push: all ${passed} checks passed`);
