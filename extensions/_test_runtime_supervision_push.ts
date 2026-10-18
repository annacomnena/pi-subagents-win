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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
	type SupervisionEntry,
} from "./runtime/supervision.ts";
import { appendAuditLine } from "./runtime/autonomy/collect.ts";
import { buildWakePrompt, type WakeLetter } from "./runtime/wake.ts";
import { readSteerRecord, sendSteerDetailed } from "./steer.ts";
import { composeTabStatus, readTabDispatch, readTabState, writeTabDispatch, writeTabState, type TabDispatchRecord, type TabState } from "./tab-runs.ts";
import { classifyForReclaim } from "./tab-runs-runtime.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

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
	check("7(f) stop=error ⇒ needs-human（BLOCKED_USER 只告不推）", () => {
		const iso7 = mkIsolated("needs-human-stop");
		try {
			const RUN = "tab_nh3";
			writeTabDispatch(iso7.runsDir, mkDispatch(RUN, "T", "G:/x"));
			writeTabState(iso7.runsDir, RUN, mkState(RUN, { lastStopReason: "error" }));
			seedLedger(mkLedger(RUN, { stateDir: iso7.stateDir, runsDir: iso7.runsDir }), iso7.stateDir);
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
		["stop=error", { state: { lastStopReason: "error" } }],
		["gate=awaiting", { gateFor: () => "awaiting" }],
		["attention>0", { attentionFor: () => 1 }],
	] as const) {
		check(`8反例 ${label} ⇒ needs-human`, () => {
			const iso8 = mkIsolated(`counter-${label.replace(/[^a-z]/gi, "")}`);
			try {
				const id = `tab_counter_${label.replace(/[^a-z]/gi, "")}`;
				writeTabDispatch(iso8.runsDir, mkDispatch(id, "T", "G:/x"));
				writeTabState(iso8.runsDir, id, mkState(id, { phase: "waiting", ...opts.state }));
				seedLedger(mkLedger(id, { stateDir: iso8.stateDir, runsDir: iso8.runsDir }), iso8.stateDir);
				const res = supervisePush({ runId: id }, { stateDir: iso8.stateDir, runsDir: iso8.runsDir, steerDir: iso8.steerDir, now: () => NOW, ...opts });
				assert.equal((res as { reason: string }).reason, "needs-human", `预期 needs-human，实际 ${JSON.stringify(res)}`);
			} finally { iso8.dispose(); }
		});
	}
}

// ── 清理 + 汇总 ─────────────────────────────────────────────────────
rmSync(ENV_TMP, { recursive: true, force: true });
if (failed > 0) {
	console.error(`_test_runtime_supervision_push: FAILED (${failed} failed / ${passed} passed)`);
	process.exit(1);
}
console.log(`_test_runtime_supervision_push: all ${passed} checks passed`);
