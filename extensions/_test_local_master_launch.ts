/**
 * _test_local_master_launch.ts — local-master-ensure（0924 计划 §3 MVP 验收 + 用户裁定 + #A）
 *
 * 覆盖（隔离 PI_RUNTIME_DIR；spawn 全程注入桩，**不真开 WT tab、不真 attach 任何真实会话**）：
 *
 *   A   层③ 参数面：invalid-cwd → 零 spawn、零状态写；工具 parameters 只有
 *       {cwd, waitForReady, timeoutMs}（无 scope/address/forceStale/token）。
 *   B   层① 身份硬挡：isSubagent → 拒 + 审计 rejected:subagent + 零 spawn；
 *       DEFAULT_EXCLUDE_TOOLS 已入列 local-master-ensure（headless 纵深）。
 *   C   层② 调用者资格（localMasterEnsureGate 复用 masterDispatchGate 口径）：
 *       subagent / unknown-session / tab-session 拒；main 放行（via main）；
 *       global owner（tab 形态）放行（via owner）；通道缺席拒。
 *   D   层④ 描述授权语义：USER_DIRECTIVE + 零新增权力边界句。
 *   E   already-running 幂等：活 owner → 零动作零 spawn、不写 in-flight。
 *   F   in-flight 防重（first-wins，窗口 = timeout+30s **且落盘 windowEndsAt**，L4-S2）：
 *       窗口内同 scope 重调 → launched(in-flight) 零第二个 spawn；过期窗口可重新认领；
 *       F3 非 EEXIST 写失败 → fail-closed 不认领（L4-S1，宁可少开一个 tab）。
 *   G   就绪判据（裁定 #7）逐条件：ready / stalled(no-liveness 不猜) /
 *       timeout(identity-mismatch, generation-mismatch, owner-pid-dead,
 *       liveness-not-updated)；ready 关闭窗口；超时钳制。
 *   H   #A 消费侧就绪机器判据：liveness 全绿但 generation 未前进（既有 owner 复活、
 *       未观测到 claim）→ 不判 ready，stalled(claim-not-observed)；spawn-failed 零重试。
 *   I   审计行：每次调用（含被拒）落 {at, by, cwd, scope, action, result}，无正文。
 *   J   #A 消费循环注册点实测：registerScopeWakeLoop 只在 session_start 注册且
 *       **注册与认领同一处理块**——无 owner → genesis 成功 → 消费循环生效（信被 claim+spawn）；
 *       no-liveness 僵尸 → 新会话 skip → 不注册（信仍 pending）→ 同夹具 ensure 如实 stalled。
 *   K   双入口（同名 slash 命令 + 工具）与 #A 注册点的静态耦合校验。
 *   L   slash 参数解析纯函数 parseLocalMasterEnsureArgs（L4-M1）：flag-first / cwd-first /
 *       --no-wait 在前 / 非法 timeout 四例——--timeout 的值不得被当成 cwd。
 *   M   0926 P1：「活 owner」与「消费侧就绪」拆分——无新鲜消费证据 → consume-unverified
 *       （isError、零 spawn、零接管）；stale/identity-mismatch/old-generation 降级；
 *       launched→ready 需消费证据；并发两次 ensure 恰 1 dispatch。
 *
 * 运行：npm run test:local-master-ensure
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "runtime-local-master-ensure-env-"));
delete process.env.PI_SUBAGENT; // 测试进程非子 agent
delete process.env.PI_TAB_RUN_ID; // 测试进程非标签页
const RUNTIME = process.env.PI_RUNTIME_DIR!;
const STATE = join(RUNTIME, "state");

import type { ObjectAddress } from "./runtime/address.ts";
import { masterAddress } from "./runtime/address.ts";
import { attachMaster, readAttachment, setCutover, type MasterAttachment } from "./runtime/registry.ts";
import { deliverLetter, listLetters, newMessageId } from "./runtime/mailbox.ts";
import { readScopeLiveness, writeScopeLiveness, type ScopeLiveness } from "./runtime/liveness.ts";
import { localMasterAddress, localMasterScope, silentScopeGenesis } from "./runtime/scope.ts";
import { DEFAULT_EXCLUDE_TOOLS } from "./runner-argv.ts";
import { registerScopeWakeLoop } from "./mailbox-consumer.ts";
import { CONSUME_FRESH_MS, judgeConsumeFresh, readConsumeEvidence, recordConsumeTick, type ScopeConsumeEvidence } from "./runtime/scope-consume.ts";
import { localMasterEnsureGate, masterDispatchGate, registerMasterTools } from "./master-tools.ts";
import {
	claimLocalMasterLaunchMarker,
	clampEnsureTimeout,
	clearLocalMasterLaunchMarker,
	ENSURE_IN_FLIGHT_EXTRA_MS,
	ensureLocalMaster,
	ensureResultIsError,
	ensureStatusForReason,
	formatLocalMasterEnsureResult,
	judgeLocalMasterEnsureReady,
	parseLocalMasterEnsureArgs,
	readLocalMasterEnsureAudit,
	readLocalMasterLaunchMarker,
	type LocalMasterEnsureDeps,
	type LocalMasterEnsureResult,
	type LocalMasterSpawn,
	type LocalMasterSpawnArgs,
} from "./runtime/local-master-launch.ts";
import type { MessageFrame } from "./runtime/protocol.ts";

let n = 0;
const ok = (name: string): void => {
	n++;
	console.log(`ok ${n} - ${name}`);
};

// ── 工具 ───────────────────────────────────────────────────────────

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const cleanups: string[] = [];
/** 临时目录/文件统一清理（L4-S3：断言失败也要清——挂到 process.on("exit") 兜底；rmSync 同步可跑）。 */
function cleanupAll(): void {
	for (const dir of cleanups.splice(0)) {
		try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
	}
	try { rmSync(RUNTIME, { recursive: true, force: true }); } catch { /* best-effort */ }
}
process.on("exit", cleanupAll);
/** 每个用例一个独立目标目录（scope = basename，恒唯一）；结束统一清理。 */
function mkCwd(): string {
	const dir = mkdtempSync(join(tmpdir(), "lms-cwd-"));
	cleanups.push(dir);
	return dir;
}

/** fake clock：sleep 推进时钟（注入方必须推进 now()，否则永不超时——见库头注）。 */
function fakeClock(startMs = Date.parse("2026-09-24T12:00:00.000Z")) {
	let t = startMs;
	return {
		now: () => t,
		sleep: async (ms: number) => {
			t += ms;
		},
		advance: (ms: number) => {
			t += ms;
		},
	};
}

const DEAD_PID = 424_242;
const isAliveFake = (pid: number): boolean => pid !== DEAD_PID;

/** 可变夹具：attachment / liveness / 消费证据 走注入 reader（确定性，不依赖真实 pid）。 */
function fixture(opts: { att?: MasterAttachment | null; lv?: ScopeLiveness | null; ev?: ScopeConsumeEvidence | null } = {}) {
	const state: { att: MasterAttachment | null; lv: ScopeLiveness | null; ev: ScopeConsumeEvidence | null } = {
		att: opts.att ?? null,
		lv: opts.lv ?? null,
		ev: opts.ev ?? null,
	};
	return {
		state,
		readAttachment: () => state.att,
		readLiveness: () => state.lv,
		readConsumeEvidence: () => state.ev,
	};
}

function makeEv(scope: string, sessionId: string, generation: number, lastTickAt: string, extra: Partial<ScopeConsumeEvidence> = {}): ScopeConsumeEvidence {
	return { version: 1, scope, sessionId, generation, lastTickAt, pid: 777_777, lastTickReason: "no-mail", tickCount: 1, ...extra };
}

function makeAtt(addr: ObjectAddress, sessionId: string, generation: number): MasterAttachment {
	const iso = new Date().toISOString();
	return { agentAddress: addr, sessionId, generation, attachedAt: iso, lastHeartbeatAt: iso, attemptId: "att1" };
}

function makeLv(scope: string, sessionId: string, generation: number, pid: number, updatedAt: string): ScopeLiveness {
	return { version: 1, scopeKey: scope, sessionId, generation, pid, startedAt: updatedAt, updatedAt };
}

function spawnCounter() {
	const calls: LocalMasterSpawnArgs[] = [];
	return {
		calls,
		spawn: (args: LocalMasterSpawnArgs): { runId: string } => {
			calls.push(args);
			return { runId: `tab_lms_${calls.length}` };
		},
	};
}

function failSpawn(error: string) {
	const h = {
		calls: 0,
		spawn: (_args: LocalMasterSpawnArgs): { error: string } => {
			h.calls++;
			return { error };
		},
	};
	return h;
}

function markerExists(scope: string): boolean {
	return existsSync(join(STATE, "local-master-launch", `${scope}.json`));
}

type Tool = {
	execute: (
		id: string,
		params: unknown,
		a: unknown,
		b: unknown,
		ctx: unknown,
	) => Promise<{ isError?: boolean; content: Array<{ text: string }>; details?: Record<string, unknown> }>;
};

/** 注册一个只暴露 local-master-ensure 的 fake ExtensionAPI。 */
function loadTool(opts: { ensureLocalMasterTab?: LocalMasterSpawn } = {}): Tool | undefined {
	let tool: Tool | undefined;
	registerMasterTools(
		{
			registerTool: (t: { name: string }) => {
				if (t.name === "local-master-ensure") tool = t as unknown as Tool;
			},
		} as never,
		opts,
	);
	return tool;
}

// ════════════════════════════════════════════════════════════════════
// A — 层③ 参数面：invalid-cwd 零动作 + 工具 schema 只有三个参数
// ════════════════════════════════════════════════════════════════════
{
	const counter = spawnCounter();
	const clock = fakeClock();
	const bad = join(tmpdir(), `lms-missing-${Date.now().toString(36)}`);
	const deps: LocalMasterEnsureDeps = {
		spawn: counter.spawn, now: clock.now, sleep: clock.sleep, isAlive: isAliveFake, stateDir: STATE, pollIntervalMs: 10,
	};
	const r = await ensureLocalMaster({ cwd: bad, sessionId: "sess_main" }, deps);
	assert.equal(r.status, "invalid-cwd");
	assert.equal(r.reason, "cwd-not-directory");
	assert.equal(counter.calls.length, 0, "invalid-cwd 零 spawn");
	assert.equal(readLocalMasterLaunchMarker(r.scope!, STATE), null, "invalid-cwd 零状态写");

	// 存在但不是目录 → 同样 invalid-cwd
	const fileDir = mkdtempSync(join(tmpdir(), "lms-file-"));
	cleanups.push(fileDir);
	const file = join(fileDir, "f.txt");
	writeFileSync(file, "x", "utf8");
	const r2 = await ensureLocalMaster({ cwd: file, sessionId: "sess_main" }, deps);
	assert.equal(r2.status, "invalid-cwd");
	assert.equal(counter.calls.length, 0, "文件路径零 spawn");
	ok("A 层③ invalid-cwd：零 spawn、零状态写");

	// schema：只收 cwd / waitForReady / timeoutMs（不收 scope/address/forceStale/token）
	const tools: Array<{ name: string; parameters?: unknown; description?: string }> = [];
	registerMasterTools(
		{ registerTool: (t: { name: string; parameters?: unknown; description?: string }) => tools.push(t) } as never,
		{ ensureLocalMasterTab: counter.spawn },
	);
	const lms = tools.find((t) => t.name === "local-master-ensure");
	assert.ok(lms, "local-master-ensure 已注册");
	const keys = Object.keys((lms!.parameters as { properties: Record<string, unknown> }).properties).sort();
	assert.deepEqual(keys, ["cwd", "timeoutMs", "waitForReady"], "参数面只有 cwd/waitForReady/timeoutMs");
	const desc = String(lms!.description);
	assert.ok(desc.includes("仅在用户明确要求时调用"), "层④ 描述带 USER_DIRECTIVE");
	assert.ok(desc.includes("不写 attachment、不代替 attach"), "零新增权力边界句");
	assert.ok(desc.includes("forceStale/token/cutover/detach"), "明示不带这些权力（NO_COMPOSE 同款）");
	ok("A2 工具 schema 参数面 + 层④ 授权描述");
}

// ════════════════════════════════════════════════════════════════════
// B — 层① 身份硬挡（execute 级）+ DEFAULT_EXCLUDE_TOOLS 纵深
// ════════════════════════════════════════════════════════════════════
{
	assert.ok(
		(DEFAULT_EXCLUDE_TOOLS as readonly string[]).includes("local-master-ensure"),
		"DEFAULT_EXCLUDE_TOOLS 含 local-master-ensure（headless 纵深）",
	);
	const counter = spawnCounter();
	const tool = loadTool({ ensureLocalMasterTab: counter.spawn })!;

	const savedSub = process.env.PI_SUBAGENT;
	process.env.PI_SUBAGENT = "1";
	try {
		const res = await tool.execute("c1", { cwd: mkCwd() }, undefined, undefined, { sessionManager: { sessionId: "sess_sub" } });
		assert.equal(res.isError, true);
		assert.ok(res.content[0].text.includes("子 agent"), "层① 文案");
	} finally {
		if (savedSub === undefined) delete process.env.PI_SUBAGENT;
		else process.env.PI_SUBAGENT = savedSub;
	}
	assert.equal(counter.calls.length, 0, "层① 拒绝零 spawn");

	// 身份 unknown（ctx 无 sessionManager）
	const res2 = await tool.execute("c2", { cwd: mkCwd() }, undefined, undefined, {});
	assert.equal(res2.isError, true);
	assert.ok(res2.content[0].text.includes("无法确定当前会话身份"));
	assert.equal(counter.calls.length, 0, "unknown 拒绝零 spawn");

	// 层② tab-session（非 owner）
	const savedTab = process.env.PI_TAB_RUN_ID;
	process.env.PI_TAB_RUN_ID = "tab_lms_x";
	try {
		const res3 = await tool.execute("c3", { cwd: mkCwd() }, undefined, undefined, { sessionManager: { sessionId: "sess_not_owner" } });
		assert.equal(res3.isError, true);
		assert.ok(res3.content[0].text.includes("任务 tab 不可启动其他仓"), `层② tab 拒：${res3.content[0].text}`);
		assert.equal(res3.details?.reason, "tab-session");
	} finally {
		if (savedTab === undefined) delete process.env.PI_TAB_RUN_ID;
		else process.env.PI_TAB_RUN_ID = savedTab;
	}
	assert.equal(counter.calls.length, 0, "层② 拒绝零 spawn");
	ok("B 层①② 逐层拒绝（subagent / unknown / tab-session）零 spawn");
}

// ════════════════════════════════════════════════════════════════════
// C — 层② 放行面：main（via main）/ global owner tab（via owner）+ 通道缺席
// ════════════════════════════════════════════════════════════════════
{
	const att = makeAtt(masterAddress(), "sess_owner_lms", 3);
	const g1 = localMasterEnsureGate({ sessionId: "sess_owner_lms", isSub: false, isTab: true, isMain: false, readAttachment: () => att });
	assert.deepEqual(g1, { ok: true, via: "owner" });
	const g2 = localMasterEnsureGate({ sessionId: "sess_main", isSub: false, isTab: false, isMain: true, readAttachment: () => null });
	assert.deepEqual(g2, { ok: true, via: "main" });
	const g3 = localMasterEnsureGate({ sessionId: "sess_tab", isSub: false, isTab: true, isMain: false, readAttachment: () => att });
	assert.equal(g3.ok, false);
	assert.equal(g3.ok ? "" : g3.reason, "tab-session");
	const g4 = localMasterEnsureGate({ sessionId: "unknown", isSub: false, isTab: false, isMain: true, readAttachment: () => att });
	assert.equal(g4.ok, false, "unknown 身份在 owner/main 之前拒");
	assert.equal(g4.ok ? "" : g4.reason, "unknown-session");
	const g5 = localMasterEnsureGate({ sessionId: "sess_x", isSub: true, isTab: false, isMain: true, readAttachment: () => att });
	assert.equal(g5.ok, false, "subagent 最高优先（即便 main）");
	assert.equal(g5.ok ? "" : g5.reason, "subagent");
	// 口径复用断言：同一输入下与 masterDispatchGate 结果一致
	assert.deepEqual(
		masterDispatchGate({ sessionId: "sess_owner_lms", isSub: false, isTab: true, isMain: false, readAttachment: () => att }),
		{ ok: true, via: "owner", attachment: att },
	);
	ok("C 层② 门控纯函数（复用 masterDispatchGate 同款口径）");

	// 工具层：通道缺席 → 拒 + 审计
	const tool = loadTool()!;
	const res = await tool.execute("c4", { cwd: mkCwd() }, undefined, undefined, { sessionManager: { sessionId: "sess_main_ok" } });
	assert.equal(res.isError, true);
	assert.ok(res.content[0].text.includes("spawn 通道不可用"));
	assert.equal(readLocalMasterEnsureAudit(STATE).slice(-1)[0].result, "rejected:no-channel");
	ok("C2 通道缺席拒绝并落审计行");
}

// ════════════════════════════════════════════════════════════════════
// E — already-running 幂等：活 owner 零动作、零 spawn、不写 in-flight
// ════════════════════════════════════════════════════════════════════
{
	const cwd = mkCwd();
	const scope = localMasterScope(cwd);
	const addr = localMasterAddress(scope);
	const fx = fixture({
		att: makeAtt(addr, "sess_alive", 4),
		lv: makeLv(scope, "sess_alive", 4, 777_777, "2026-09-24T12:00:05.000Z"),
		ev: makeEv(scope, "sess_alive", 4, "2026-09-24T12:00:00.000Z"), // 0926：活 owner 还需消费证据才回 already-running
	});
	const counter = spawnCounter();
	const clock = fakeClock();
	const r = await ensureLocalMaster(
		{ cwd, sessionId: "sess_main" },
		{
			spawn: counter.spawn, now: clock.now, sleep: clock.sleep, stateDir: STATE, pollIntervalMs: 10,
			readAttachment: fx.readAttachment, readLiveness: fx.readLiveness, readConsumeEvidence: fx.readConsumeEvidence, isAlive: isAliveFake,
		},
	);
	assert.equal(r.status, "already-running");
	assert.equal(r.generation, 4);
	assert.equal(r.liveness?.sessionId, "sess_alive");
	assert.equal(r.liveness?.alive, true);
	assert.equal(r.consumption?.state, "fresh", "already-running 必须带新鲜消费证据");
	assert.equal(r.consumption?.lastTickAt, "2026-09-24T12:00:00.000Z");
	assert.equal(ensureResultIsError(r), false, "活 owner + 消费证据新鲜 → 非错误");
	assert.equal(counter.calls.length, 0, "活 master 零动作零 spawn");
	assert.equal(markerExists(scope), false, "already-running 不写 in-flight");
	ok("E already-running 幂等（零动作零状态写）");
}

// ════════════════════════════════════════════════════════════════════
// F — spawn + in-flight 防重（first-wins，窗口 = timeout+30s）
// ════════════════════════════════════════════════════════════════════
{
	const cwd = mkCwd();
	const scope = localMasterScope(cwd);
	const addr = localMasterAddress(scope);
	const fx = fixture(); // 无 owner
	const counter = spawnCounter();
	const clock = fakeClock();
	const deps: LocalMasterEnsureDeps = {
		spawn: counter.spawn, now: clock.now, sleep: clock.sleep, stateDir: STATE, pollIntervalMs: 10,
		readAttachment: fx.readAttachment, readLiveness: fx.readLiveness, isAlive: isAliveFake,
	};

	const r1 = await ensureLocalMaster({ cwd, sessionId: "sess_main", waitForReady: false, timeoutMs: 5_000 }, deps);
	assert.equal(r1.status, "launched");
	assert.equal(r1.runId, "tab_lms_1");
	assert.equal(r1.inFlight, undefined);
	assert.equal(counter.calls.length, 1);

	// spawn 参数面：taskId / cwd / prompt 纪律（裁定 #9）
	const args1 = counter.calls[0]!;
	assert.equal(args1.taskId, `lms-${scope}`, "taskId = lms-<scope>");
	assert.equal(args1.cwd, cwd);
	assert.equal(args1.agentAddress, addr);
	assert.equal(args1.sessionId, "sess_main");
	assert.ok(args1.prompt.includes(`你是 ${addr} 的 local master`), "bootstrap 点名地址");
	assert.ok(args1.prompt.includes("不要 tab-finish") && args1.prompt.includes("不要设 timer 自续命"), "常驻纪律");
	assert.ok(args1.prompt.includes("/master-status"), "核验指引");
	assert.ok(args1.prompt.includes("不要触碰全局 Master"), "不指示碰 global（负向禁令）");
	assert.ok(!args1.prompt.includes("token"), "bootstrap 不含 token");
	assert.ok(!args1.prompt.includes("forceStale"), "bootstrap 不指示 forceStale");
	assert.ok(!args1.prompt.includes("handoff"), "bootstrap 无交接语义");

	// marker 落盘 + runId 回写
	const m1 = readLocalMasterLaunchMarker(scope, STATE);
	assert.ok(m1, "in-flight marker 落盘");
	assert.equal(m1!.runId, "tab_lms_1");

	// 窗口内二次调用 → launched(in-flight) 零第二个 spawn
	clock.advance(1_000);
	const r2 = await ensureLocalMaster({ cwd, sessionId: "sess_main", waitForReady: false, timeoutMs: 5_000 }, deps);
	assert.equal(r2.status, "launched");
	assert.equal(r2.inFlight, true);
	assert.equal(r2.reason, "in-flight");
	assert.equal(r2.runId, "tab_lms_1", "回传在途 runId");
	assert.equal(counter.calls.length, 1, "in-flight 窗口内零第二个 spawn");
	assert.equal(readLocalMasterLaunchMarker(scope, STATE)!.runId, "tab_lms_1", "marker 未被覆盖");
	ok("F in-flight 防重：窗口内重调零第二个 spawn");

	// 窗口 = timeout + 30s（过期后可重新认领；marker at = spawn 时刻 T0）
	const win = 5_000 + ENSURE_IN_FLIGHT_EXTRA_MS;
	assert.equal(ENSURE_IN_FLIGHT_EXTRA_MS, 30_000);
	assert.equal(claimLocalMasterLaunchMarker(scope, { stateDir: STATE, nowMs: clock.now(), windowMs: win }).claimed, false, "窗口内 wx 抢占失败");
	clock.advance(win - 1_000 - 1); // 此刻 = T0 + win - 1（仍在窗口内）
	assert.equal(claimLocalMasterLaunchMarker(scope, { stateDir: STATE, nowMs: clock.now(), windowMs: win }).claimed, false, "窗口边界内仍不认领");
	clock.advance(2); // 此刻 = T0 + win + 1（过期）
	assert.equal(claimLocalMasterLaunchMarker(scope, { stateDir: STATE, nowMs: clock.now(), windowMs: win }).claimed, true, "过期窗口可重新认领");
	clearLocalMasterLaunchMarker(scope, STATE);
	ok("F2 in-flight 窗口 = timeout + 30s");
}

// F3：非 EEXIST 写失败（目录路径落在一个文件上 → ENOTDIR）→ **fail-closed 不认领**（L4-S1）：
//     与 JSDoc「宁可少开一个 tab」同口径；旧实现 fail-open（return claimed:true）与注释矛盾。
{
	const badState = join(tmpdir(), `lms-badstate-${process.pid}-${Date.now()}`);
	writeFileSync(badState, "not a directory\n", "utf8");
	cleanups.push(badState);
	const claim = claimLocalMasterLaunchMarker("lms_fail_closed", { stateDir: badState, nowMs: Date.now(), windowMs: 5_000 });
	assert.equal(claim.claimed, false, "非 EEXIST 写失败（ENOTDIR/EACCES…）→ 不认领（fail-closed）");
	ok("F3 marker 写失败 fail-closed（S1：宁可少开一个 tab）");
}

// F4：in-flight 窗口落盘 first-wins（L4-S2）：窗口属于「那次 spawn」，不由后续调用方的 timeout 现算。
//     首次 timeoutMs=180000（窗口 210s）→ 40s 后用 timeoutMs=1000 重调（旧算法窗口仅 31s、会误判过期开第二个 tab）。
{
	const cwd = mkCwd();
	const scope = localMasterScope(cwd);
	const fx = fixture(); // 无 owner
	const counter = spawnCounter();
	const clock = fakeClock();
	const deps: LocalMasterEnsureDeps = {
		spawn: counter.spawn, now: clock.now, sleep: clock.sleep, stateDir: STATE, pollIntervalMs: 10,
		readAttachment: fx.readAttachment, readLiveness: fx.readLiveness, isAlive: isAliveFake,
	};
	const r1 = await ensureLocalMaster({ cwd, sessionId: "sess_main", waitForReady: false, timeoutMs: 180_000 }, deps);
	assert.equal(r1.status, "launched");
	const m = readLocalMasterLaunchMarker(scope, STATE);
	assert.ok(m?.windowEndsAt, "marker 落盘 windowEndsAt");
	assert.equal(Date.parse(m!.windowEndsAt!) - clock.now(), 180_000 + ENSURE_IN_FLIGHT_EXTRA_MS, "首次窗口 = 首次调用的 timeout+30s");
	clock.advance(40_000);
	const r2 = await ensureLocalMaster({ cwd, sessionId: "sess_main", waitForReady: false, timeoutMs: 1_000 }, deps);
	assert.equal(r2.status, "launched");
	assert.equal(r2.inFlight, true, "小 timeout 的重调仍在盘上首次窗口内（S2）");
	assert.equal(counter.calls.length, 1, "零第二个 spawn");
	clearLocalMasterLaunchMarker(scope, STATE);
	ok("F4 in-flight 窗口落盘 first-wins（S2）");
}

// ════════════════════════════════════════════════════════════════════
// G — 就绪判据（裁定 #7）逐条件
// ════════════════════════════════════════════════════════════════════

/** 跑一次 launched→轮询：spawn 桩在 spawn 时按 mutate(fx, launchAt, scope, addr) 改夹具。 */
async function runPollCase(
	mutate: (fx: ReturnType<typeof fixture>, launchAt: string, scope: string, addr: ObjectAddress) => void,
	opts: { preAtt?: MasterAttachment | null; preLv?: ScopeLiveness | null; timeoutMs?: number } = {},
): Promise<{ r: LocalMasterEnsureResult; spawnCalls: number; scope: string; cwd: string }> {
	const cwd = mkCwd();
	const scope = localMasterScope(cwd);
	const addr = localMasterAddress(scope);
	const fx = fixture({ att: opts.preAtt ?? null, lv: opts.preLv ?? null });
	const clock = fakeClock();
	let spawnCalls = 0;
	const spawn: LocalMasterSpawn = (args) => {
		spawnCalls++;
		mutate(fx, args.launchAt, scope, addr);
		return { runId: `tab_poll_${spawnCalls}` };
	};
	const r = await ensureLocalMaster(
		{ cwd, sessionId: "sess_main", timeoutMs: opts.timeoutMs ?? 1_000 },
		{
			spawn, now: clock.now, sleep: clock.sleep, stateDir: STATE, pollIntervalMs: 10,
			readAttachment: fx.readAttachment, readLiveness: fx.readLiveness, readConsumeEvidence: fx.readConsumeEvidence, isAlive: isAliveFake,
		},
	);
	return { r, spawnCalls, scope, cwd };
}

// G1 ready：无 owner → 新会话 genesis（gen 0→1）+ liveness 全绿 + updatedAt > launchAt + 消费证据 fresh
{
	const { r, spawnCalls } = await runPollCase((fx, launchAt, scope, addr) => {
		fx.state.att = makeAtt(addr, "sess_new", 1);
		fx.state.lv = makeLv(scope, "sess_new", 1, 111, new Date(Date.parse(launchAt) + 1_000).toISOString());
		fx.state.ev = makeEv(scope, "sess_new", 1, launchAt);
	});
	assert.equal(r.status, "ready", `G1 ready 实际=${r.status}/${r.reason}`);
	assert.equal(r.generation, 1);
	assert.equal(r.liveness?.sessionId, "sess_new");
	assert.equal(spawnCalls, 1);
	assert.equal(markerExists(r.scope!), false, "ready 关闭 in-flight 窗口");
	assert.ok(formatLocalMasterEnsureResult(r).includes("gen=1"));
	ok("G1 ready（全判据满足 + 窗口关闭）");
}

// G1b ready：僵尸（pid 死）→ 新会话 takeover（gen 2→3）同样判 ready
{
	const cwd = mkCwd();
	const scope = localMasterScope(cwd);
	const addr = localMasterAddress(scope);
	const preAtt = makeAtt(addr, "sess_dead", 2);
	const preLv = makeLv(scope, "sess_dead", 2, DEAD_PID, "2026-09-23T00:00:00.000Z");
	const { r, spawnCalls } = await runPollCase(
		(fx, launchAt, s, a) => {
			fx.state.att = makeAtt(a, "sess_takeover", 3);
			fx.state.lv = makeLv(s, "sess_takeover", 3, 222, new Date(Date.parse(launchAt) + 1_000).toISOString());
			fx.state.ev = makeEv(s, "sess_takeover", 3, launchAt);
		},
		{ preAtt, preLv },
	);
	assert.equal(r.status, "ready", `G1b 实际=${r.status}/${r.reason}`);
	assert.equal(r.generation, 3, "takeover 后 generation 前进（= claim 观测）");
	assert.equal(spawnCalls, 1);
	void cwd;
	ok("G1b ready（pid 死僵尸 takeover gen+1）");
}

// G2 stalled：拿不到 liveness → 如实 stalled（不猜）
{
	const { r, spawnCalls } = await runPollCase(() => {
		/* 会话没起来 / 没写 liveness */
	}, { timeoutMs: 600 });
	assert.equal(r.status, "stalled");
	assert.equal(r.reason, "no-liveness");
	assert.equal(spawnCalls, 1);
	const text = formatLocalMasterEnsureResult(r);
	assert.ok(text.includes("不猜"), "stalled 文案明示不猜");
	assert.ok(text.includes("/master-attach --local --force-stale --confirm"), "stalled 给人工处置指引（工具不代持该权力）");
	ok("G2 stalled(no-liveness)：不猜、给人权指引");
}

// G3-G6 timeout：liveness 在场但逐条不满足
{
	// G3 identity-mismatch（liveness 指向别的会话）
	{
		const cwd = mkCwd();
		const scope = localMasterScope(cwd);
		const fx = fixture({
			att: makeAtt(localMasterAddress(scope), "sess_a", 2),
			lv: makeLv(scope, "sess_b", 2, 111, "2026-09-24T12:00:10.000Z"),
		});
		const clock = fakeClock();
		const r = await ensureLocalMaster({ cwd, sessionId: "s", timeoutMs: 500 }, { spawn: () => ({ runId: "t" }), now: clock.now, sleep: clock.sleep, stateDir: STATE, pollIntervalMs: 10, readAttachment: fx.readAttachment, readLiveness: fx.readLiveness, isAlive: isAliveFake });
		assert.equal(r.status, "timeout");
		assert.equal(r.reason, "identity-mismatch");
	}
	// G4 generation-mismatch（认领已发生但 liveness 还是旧代）
	{
		const cwd = mkCwd();
		const scope = localMasterScope(cwd);
		const fx = fixture({
			att: makeAtt(localMasterAddress(scope), "sess_a", 3),
			lv: makeLv(scope, "sess_a", 2, 111, "2026-09-24T12:00:10.000Z"),
		});
		const clock = fakeClock();
		const r = await ensureLocalMaster({ cwd, sessionId: "s", timeoutMs: 500 }, { spawn: () => ({ runId: "t" }), now: clock.now, sleep: clock.sleep, stateDir: STATE, pollIntervalMs: 10, readAttachment: fx.readAttachment, readLiveness: fx.readLiveness, isAlive: isAliveFake });
		assert.equal(r.status, "timeout");
		assert.equal(r.reason, "generation-mismatch");
	}
	// G5 owner-pid-dead（身份对但 pid 死）
	{
		const cwd = mkCwd();
		const scope = localMasterScope(cwd);
		const fx = fixture({
			att: makeAtt(localMasterAddress(scope), "sess_a", 3),
			lv: makeLv(scope, "sess_a", 3, DEAD_PID, "2026-09-24T12:00:10.000Z"),
		});
		const clock = fakeClock();
		const r = await ensureLocalMaster({ cwd, sessionId: "s", timeoutMs: 500 }, { spawn: () => ({ runId: "t" }), now: clock.now, sleep: clock.sleep, stateDir: STATE, pollIntervalMs: 10, readAttachment: fx.readAttachment, readLiveness: fx.readLiveness, isAlive: isAliveFake });
		assert.equal(r.status, "timeout");
		assert.equal(r.reason, "owner-pid-dead");
	}
	// G6 liveness-not-updated：precheck 先因身份不匹配不过；spawn 后身份对齐但
	// updatedAt 仍早于 launchAt（旧心跳）→ 判据不满足 → timeout（不是 ready）
	{
		const cwd = mkCwd();
		const scope = localMasterScope(cwd);
		const addr = localMasterAddress(scope);
		const preAtt = makeAtt(addr, "sess_a", 2);
		const preLv = makeLv(scope, "sess_b", 2, 111, "2026-09-24T12:00:10.000Z");
		const { r } = await runPollCase(
			(fx, launchAt, s, a) => {
				fx.state.lv = makeLv(s, "sess_a", 2, 111, new Date(Date.parse(launchAt) - 1_000).toISOString());
				void a;
			},
			{ preAtt, preLv, timeoutMs: 500 },
		);
		assert.equal(r.status, "timeout");
		assert.equal(r.reason, "liveness-not-updated");
	}
	ok("G3-G6 timeout 逐条件（identity/generation/pid/updatedAt）");
}

// G7 纯函数直测：#7 六条件 + 第 8 条消费证据 + reason 枚举 + stalled/timeout 分类 + 超时钳制
{
	const scope = "g7-scope";
	const addr = localMasterAddress(scope);
	const att = makeAtt(addr, "s", 5);
	const lv = makeLv(scope, "s", 5, 42, "2026-09-24T12:00:10.000Z");
	const nowMs = Date.parse("2026-09-24T12:00:10.000Z");
	const ev = makeEv(scope, "s", 5, "2026-09-24T12:00:09.000Z");
	const base = { attachment: att, liveness: lv, launchAt: "2026-09-24T12:00:05.000Z", isAlive: () => true, consumeEvidence: ev, nowMs };
	assert.deepEqual(judgeLocalMasterEnsureReady(base), { ready: true, reason: "ready" });
	assert.equal(judgeLocalMasterEnsureReady({ ...base, liveness: null }).reason, "no-liveness");
	assert.equal(judgeLocalMasterEnsureReady({ ...base, attachment: null }).reason, "no-owner");
	assert.equal(judgeLocalMasterEnsureReady({ ...base, liveness: { ...lv, sessionId: "other" } }).reason, "identity-mismatch");
	assert.equal(judgeLocalMasterEnsureReady({ ...base, liveness: { ...lv, generation: 4 } }).reason, "generation-mismatch");
	assert.equal(judgeLocalMasterEnsureReady({ ...base, isAlive: () => false }).reason, "owner-pid-dead");
	assert.equal(judgeLocalMasterEnsureReady({ ...base, launchAt: "2026-09-24T12:00:10.000Z" }).reason, "liveness-not-updated");
	// claim 观测：六条全绿但 generation 未前进 → 不 ready
	assert.equal(judgeLocalMasterEnsureReady({ ...base, claimedFromGeneration: 5 }).reason, "claim-not-observed");
	assert.equal(judgeLocalMasterEnsureReady({ ...base, claimedFromGeneration: 4 }).ready, true);
	// 第 8 条（append-last）：前 7 条全绿但消费证据不成立 → consume-evidence-*
	assert.equal(judgeLocalMasterEnsureReady({ ...base, consumeEvidence: null }).reason, "consume-evidence-missing");
	assert.equal(judgeLocalMasterEnsureReady({ ...base, consumeEvidence: { ...ev, sessionId: "other" } }).reason, "consume-evidence-identity-mismatch");
	assert.equal(judgeLocalMasterEnsureReady({ ...base, consumeEvidence: { ...ev, generation: 4 } }).reason, "consume-evidence-old-generation");
	assert.equal(
		judgeLocalMasterEnsureReady({ ...base, consumeEvidence: { ...ev, lastTickAt: "2026-09-24T11:58:00.000Z" } }).reason,
		"consume-evidence-stale",
	);
	// 阈值可注入（不硬编码 90s）：同证据在放宽的 freshMs 下算新鲜
	assert.equal(
		judgeLocalMasterEnsureReady({ ...base, consumeEvidence: { ...ev, lastTickAt: "2026-09-24T11:58:00.000Z" }, consumeFreshMs: 300_000 }).ready,
		true,
	);
	assert.equal(ensureStatusForReason("no-liveness"), "stalled");
	assert.equal(ensureStatusForReason("no-owner"), "stalled");
	assert.equal(ensureStatusForReason("claim-not-observed"), "stalled");
	for (const rr of ["consume-evidence-missing", "consume-evidence-stale", "consume-evidence-identity-mismatch", "consume-evidence-old-generation"]) {
		assert.equal(ensureStatusForReason(rr), "stalled", `${rr} → stalled（证据不足，不猜）`);
	}
	assert.equal(ensureStatusForReason("identity-mismatch"), "timeout");
	assert.equal(ensureStatusForReason("owner-pid-dead"), "timeout");
	assert.equal(clampEnsureTimeout(undefined), 60_000);
	assert.equal(clampEnsureTimeout(999_999), 180_000);
	assert.equal(clampEnsureTimeout(-5), 60_000);
	assert.equal(CONSUME_FRESH_MS, 90_000, "新鲜度阈值 = 3×30s tick = astra 90s 预算上界");
	ok("G7 就绪判据纯函数（六条件 + claim 观测 + 第 8 条消费证据 + 分类 + 钳制）");
}

// ════════════════════════════════════════════════════════════════════
// H — #A 消费侧就绪机器判据：liveness 全绿但未观测到 claim → stalled，不猜
// ════════════════════════════════════════════════════════════════════
{
	// 夹具：既有 owner（gen 2）liveness 缺失 → precheck 不过 → spawn；
	// spawn 后旧 owner 复活并补写 liveness（同 sid 同 gen、pid 活、updatedAt > launchAt）
	// → #7 六条全绿，但 generation 未前进（未观测到新会话认领）→ 不得判 ready。
	const cwd = mkCwd();
	const scope = localMasterScope(cwd);
	const addr = localMasterAddress(scope);
	const fx = fixture({ att: makeAtt(addr, "sess_old_owner", 2), lv: null });
	const clock = fakeClock();
	let spawnCalls = 0;
	const spawn: LocalMasterSpawn = (args) => {
		spawnCalls++;
		fx.state.lv = makeLv(scope, "sess_old_owner", 2, 111, new Date(Date.parse(args.launchAt) + 500).toISOString());
		return { runId: "tab_claimless" };
	};
	const r = await ensureLocalMaster(
		{ cwd, sessionId: "sess_main", timeoutMs: 800 },
		{
			spawn, now: clock.now, sleep: clock.sleep, stateDir: STATE, pollIntervalMs: 10,
			readAttachment: fx.readAttachment, readLiveness: fx.readLiveness, isAlive: isAliveFake,
		},
	);
	assert.equal(spawnCalls, 1);
	assert.equal(r.status, "stalled", "liveness 全绿但未观测 claim → 不判 ready");
	assert.equal(r.reason, "claim-not-observed");
	assert.equal(r.generation, 2, "如实回 generation 快照");
	assert.equal(r.liveness?.alive, true, "如实回 liveness 快照（判据未满足但盘面在场）");
	assert.ok(formatLocalMasterEnsureResult(r).includes("force-stale --confirm"), "stalled 回执给人权处置指引");
	ok("H #A：claim 未观测 → stalled(claim-not-observed)，不猜");
}

// ════════════════════════════════════════════════════════════════════
// H2 — spawn-failed：零重试 + marker 删除 + 重调用等价手动重试
// ════════════════════════════════════════════════════════════════════
{
	const cwd = mkCwd();
	const scope = localMasterScope(cwd);
	const clock = fakeClock();
	const f = failSpawn("no wt.exe");
	const deps: LocalMasterEnsureDeps = {
		spawn: f.spawn, now: clock.now, sleep: clock.sleep, stateDir: STATE, pollIntervalMs: 10, isAlive: isAliveFake,
	};
	const r = await ensureLocalMaster({ cwd, sessionId: "s", timeoutMs: 500 }, deps);
	assert.equal(r.status, "spawn-failed");
	assert.equal(r.detail, "no wt.exe");
	assert.equal(f.calls, 1, "spawn 失败零自动重试（at-most-once）");
	assert.equal(markerExists(scope), false, "spawn 失败即删 in-flight");
	const r2 = await ensureLocalMaster({ cwd, sessionId: "s", timeoutMs: 500 }, deps);
	assert.equal(f.calls, 2, "重调用 = 手动重试（窗口已清）");
	assert.equal(r2.status, "spawn-failed");
	ok("H2 spawn-failed：零重试 + marker 删除 + 重调用重试");
}

// ════════════════════════════════════════════════════════════════════
// I — 审计行（每次调用含被拒；无正文）+ 工具面两条状态行
// ════════════════════════════════════════════════════════════════════
{
	const counter = spawnCounter();
	const tool = loadTool({ ensureLocalMasterTab: counter.spawn })!;

	// ① 工具面 invalid-cwd（main 放行 → 层③ 拒）
	const target = join(tmpdir(), "lms-definitely-missing-dir");
	const res = await tool.execute("i1", { cwd: target }, undefined, undefined, { sessionManager: { sessionId: "sess_main_audit" } });
	assert.equal(res.isError, true);
	assert.ok(res.content[0].text.includes("invalid-cwd"));
	assert.equal(counter.calls.length, 0);

	// ② 工具面 already-running（真实盘面：活 pid = 测试进程）→ 零 spawn
	const cwd2 = mkCwd();
	const scope2 = localMasterScope(cwd2);
	attachMaster({ sessionId: "sess_tool_alive", agent: localMasterAddress(scope2), detail: cwd2 });
	writeScopeLiveness({ scopeKey: scope2, sessionId: "sess_tool_alive", generation: 1, pid: process.pid });
	// 0926：活 owner 还需消费证据才回 already-running（真实盘面写一条同身份新鲜 tick 证据）
	assert.ok(recordConsumeTick({ scope: scope2, sessionId: "sess_tool_alive", generation: 1, lastTickReason: "no-mail" }, { stateDir: STATE }), "证据写入");
	assert.equal(readConsumeEvidence(scope2, { stateDir: STATE })!.sessionId, "sess_tool_alive");
	const res2 = await tool.execute("i2", { cwd: cwd2 }, undefined, undefined, { sessionManager: { sessionId: "sess_main_audit2" } });
	assert.notEqual(res2.isError, true, "already-running 非错误");
	assert.ok(res2.content[0].text.includes("already-running"), res2.content[0].text);
	assert.equal(counter.calls.length, 0, "工具面活 master 零 spawn");

	// ③ 行形状与覆盖
	const rows = readLocalMasterEnsureAudit(STATE);
	assert.ok(rows.length > 0, "前序用例已落审计行");
	for (const row of rows) {
		assert.deepEqual(Object.keys(row).sort(), ["action", "at", "cwd", "result", "scope", "by"].sort(), "审计行字段恰为 {at,by,cwd,scope,action,result}");
		assert.ok(!("body" in row) && !("prompt" in row) && !("text" in row), "无正文");
	}
	const results = rows.map((r) => r.result);
	assert.ok(results.includes("rejected:subagent"), "被拒也审计：subagent");
	assert.ok(results.includes("rejected:tab-session"), "被拒也审计：tab-session");
	assert.ok(results.includes("rejected:no-channel"), "被拒也审计：no-channel");
	assert.ok(results.some((r) => r.startsWith("invalid-cwd")), "invalid-cwd 审计");
	assert.ok(results.some((r) => r.startsWith("already-running")), "already-running 审计");

	const last = rows.slice(-1)[0]!;
	assert.equal(last.action, "ensure:tool");
	assert.equal(last.by, "sess_main_audit2");
	assert.equal(last.result, "already-running");
	assert.equal(last.scope, scope2);
	assert.equal(last.cwd, cwd2);
	const invalidRow = rows.find((r) => r.result.startsWith("invalid-cwd"))!;
	assert.equal(invalidRow.scope, localMasterScope(target), "invalid-cwd 仍回可辨 scope（best-effort 派生）");
	ok("I 审计行：六字段、无正文、含被拒 + 工具面状态行逐字段");
}

// ════════════════════════════════════════════════════════════════════
// J — #A：消费循环注册点实测（注册与认领同一处理块）
// ════════════════════════════════════════════════════════════════════

interface FakePi {
	on: (event: string, cb: (event: unknown, ctx?: { sessionManager?: { sessionId?: string } }) => void) => void;
	start: (sessionId: string) => void;
}
function fakePi(): FakePi {
	const handlers: Record<string, Array<(event: unknown, ctx?: { sessionManager?: { sessionId?: string } }) => void>> = {};
	return {
		on: (event, cb) => {
			(handlers[event] ??= []).push(cb);
		},
		start: (sessionId) => {
			for (const cb of handlers["session_start"] ?? []) cb({}, { sessionManager: { sessionId } });
		},
	};
}

function wakeLetter(to: ObjectAddress): MessageFrame {
	return {
		frame: "message",
		id: newMessageId(),
		kind: "ESCALATION",
		from: masterAddress(),
		to,
		subject: "task://lms-consumer-probe",
		requiresAck: false,
		sentAt: new Date().toISOString(),
		body: { summary: "consumer probe" },
	};
}

// J1：无 owner 仓 → 新会话 session_start 静默 genesis + **注册消费循环**（信被 claim/spawn）
{
	setCutover(true, "lms-consumer-test");
	const cwd = mkCwd();
	const scope = localMasterScope(cwd);
	const addr = localMasterAddress(scope);
	assert.equal(readAttachment(addr), null, "夹具：无 owner");
	deliverLetter(wakeLetter(addr));
	const spawned: string[] = [];
	const pi = fakePi();
	const stop1 = registerScopeWakeLoop(pi, {
		cwd,
		intervalMs: 5,
		spawn: (d, sid) => {
			spawned.push(`${d.scope}:${sid}`);
			return "tab_lms_probe";
		},
	});
	pi.start("sess_lms_new"); // 新会话 session_start：genesis 认领 + 注册（同一处理块）
	assert.equal(readAttachment(addr)!.sessionId, "sess_lms_new", "genesis 认领成功");
	await realSleep(150);
	assert.equal(spawned.length, 1, "消费循环已注册并消费（wake 信 → spawn）");
	assert.equal(spawned[0], `${scope}:sess_lms_new`);
	assert.equal(listLetters(addr, "pending").length, 0, "信被 claim（不再 pending）");
	stop1(); // L4-S7：显式释放 disposer（不靠 interval.unref 退出）
	ok("J1 #A：认领成功 ⟹ 消费循环随 session_start 注册并生效");
}

// J2：no-liveness 僵尸仓 → 新会话 skip（不认领）→ **不注册**（信仍 pending）；
//     同夹具 ensure 如实 stalled（不谎报可收信）
{
	const cwd = mkCwd();
	const scope = localMasterScope(cwd);
	const addr = localMasterAddress(scope);
	attachMaster({ sessionId: "sess_zombie", agent: addr, detail: cwd }); // 有 owner、无 liveness
	assert.equal(readScopeLiveness(scope), null, "夹具：no-liveness");
	assert.equal(readAttachment(addr)!.sessionId, "sess_zombie");
	deliverLetter(wakeLetter(addr));
	const spawned: string[] = [];
	const pi = fakePi();
	const stop2 = registerScopeWakeLoop(pi, {
		cwd,
		intervalMs: 5,
		spawn: (d) => {
			spawned.push(d.scope);
			return "tab_lms_zombie";
		},
	});
	pi.start("sess_lms_fresh"); // 新会话：takeover 因 no-liveness skip → 不注册
	await realSleep(150);
	assert.equal(readAttachment(addr)!.sessionId, "sess_zombie", "僵尸 owner 未被动（skip，保守）");
	assert.equal(spawned.length, 0, "未认领 → 消费循环未注册（信不会被消费）");
	assert.equal(listLetters(addr, "pending").length, 1, "信仍 pending（残余：需人工处置）");

	// 同夹具下 ensure 的机器判据：spawn 照常开 tab，但拿不到 liveness → stalled（不猜）
	const clock = fakeClock();
	let spawnCalls = 0;
	const r = await ensureLocalMaster(
		{ cwd, sessionId: "sess_main", timeoutMs: 700 },
		{ spawn: () => { spawnCalls++; return { runId: "tab_lms_z" }; }, now: clock.now, sleep: clock.sleep, stateDir: STATE, pollIntervalMs: 10, isAlive: isAliveFake },
	);
	assert.equal(spawnCalls, 1, "僵尸仓照常开 tab（这正是恢复路径）");
	assert.equal(r.status, "stalled");
	assert.equal(r.reason, "no-liveness", "拿不到 liveness → stalled，不谎报 ready");
	stop2(); // L4-S7：显式释放 disposer
	ok("J2 #A：no-liveness 僵尸不注册消费循环 → ensure 如实 stalled（残余可报）");
}

// J3：#7 判据在真实盘面（隔离 PI_RUNTIME_DIR）上的口径
{
	const cwd = mkCwd();
	const scope = localMasterScope(cwd);
	const addr = localMasterAddress(scope);
	assert.equal(silentScopeGenesis("sess_real_owner", cwd).outcome, "attached");
	writeScopeLiveness({ scopeKey: scope, sessionId: "sess_real_owner", generation: 1, pid: process.pid });
	const att = readAttachment(addr)!;
	const lv = readScopeLiveness(scope)!;
	const launchAt = new Date(Date.parse(lv.updatedAt) - 1_000).toISOString();
	// 0926：真实盘面上，判据前 7 条全绿但**无消费证据** → 不 ready（第 8 条）
	assert.equal(readConsumeEvidence(scope, { stateDir: STATE }), null, "夹具：尚无消费证据");
	const v0 = judgeLocalMasterEnsureReady({ attachment: att, liveness: lv, launchAt });
	assert.equal(v0.ready, false, "无消费证据 → 不 ready");
	assert.equal(v0.reason, "consume-evidence-missing");
	// 真实 tick 证据写入后（唯一写手 = recordConsumeTick）→ ready
	assert.ok(recordConsumeTick({ scope, sessionId: "sess_real_owner", generation: 1, lastTickReason: "no-mail" }, { stateDir: STATE }));
	assert.equal(
		judgeLocalMasterEnsureReady({ attachment: att, liveness: lv, launchAt, consumeEvidence: readConsumeEvidence(scope, { stateDir: STATE }) }).ready,
		true,
		"真实盘面 + 活 pid（测试进程自身）+ 消费证据 → ready",
	);
	const v2 = judgeLocalMasterEnsureReady({ attachment: att, liveness: lv, launchAt: new Date(Date.parse(lv.updatedAt) + 1_000).toISOString(), consumeEvidence: readConsumeEvidence(scope, { stateDir: STATE }) });
	assert.equal(v2.ready, false, "launchAt 晚于 liveness → 不算数");
	assert.equal(v2.reason, "liveness-not-updated");
	ok("J3 判据在真实盘面上的口径（含 launchAt 边界 + 消费证据第 8 条）");
}

// ════════════════════════════════════════════════════════════════════
// K — 双入口（同名 slash 命令 + 工具）与 #A 注册点的静态耦合校验
// ════════════════════════════════════════════════════════════════════
{
	const here = import.meta.dirname;
	const src = readFileSync(join(here, "index.ts"), "utf8");
	assert.ok(src.includes('pi.registerCommand("local-master-ensure"'), "同名 slash 命令已注册");
	const cmdIdx = src.indexOf('pi.registerCommand("local-master-ensure"');
	const cmdEnd = src.indexOf("pi.registerCommand(", cmdIdx + 1);
	const cmdBlock = src.slice(cmdIdx, cmdEnd > 0 ? cmdEnd : undefined);
	assert.ok(cmdBlock.includes("parseLocalMasterEnsureArgs"), "slash 解析走导出的纯函数 parseLocalMasterEnsureArgs（M1/S4）");
	assert.ok(cmdBlock.includes("仅在用户明确要求时使用"), "slash 描述带用户明确要求句（S5）");
	assert.ok(src.includes("ensure:slash"), "slash 面审计 action");
	assert.ok(src.includes("localMasterEnsureGate"), "slash 面同一层②门");
	assert.ok(/registerMasterTools\(pi, \{[^}]*ensureLocalMasterTab/.test(src), "registerMasterTools 已注入 ensureLocalMasterTab");
	const toolsSrc = readFileSync(join(here, "master-tools.ts"), "utf8");
	assert.ok(toolsSrc.includes('name: "local-master-ensure"'), "工具面已注册（master-tools.ts）");
	assert.ok(toolsSrc.includes("auditLocalMasterEnsure"), "工具面落审计行");
	assert.ok(toolsSrc.includes("USER_DIRECTIVE"), "工具描述携带 USER_DIRECTIVE 常量");
	const consumerSrc = readFileSync(join(here, "mailbox-consumer.ts"), "utf8");
	const regIdx = consumerSrc.indexOf("export function registerScopeWakeLoop");
	const sessionStartIdx = consumerSrc.indexOf('pi.on("session_start"', regIdx);
	const claimIdx = consumerSrc.indexOf("silentScopeGenesis", sessionStartIdx);
	const activateIdx = consumerSrc.indexOf("activateScopeConsumption({ sessionId: sid, cwd, wiring })", sessionStartIdx);
	assert.ok(regIdx > 0 && sessionStartIdx > regIdx, "消费循环注册点 = registerScopeWakeLoop 的 session_start");
	assert.ok(claimIdx > sessionStartIdx && activateIdx > claimIdx, "认领（silentScopeGenesis）在激活（activateScopeConsumption）之前、同一处理块");

	// 0926 P1：单一幂等激活入口——全仓生产调用恰 3 处（session_start + 工具 attach + slash attach）
	const callsIn = (text: string): number => text.split("activateScopeConsumption({").length - 1;
	const prodFiles = [...readdirSync(here).filter((f) => f.endsWith(".ts") && !f.startsWith("_")), "runtime/local-master-launch.ts", "runtime/scope-consume.ts"];
	let total = 0;
	for (const f of prodFiles) {
		try {
			total += callsIn(readFileSync(join(here, f), "utf8"));
		} catch {
			/* 文件不存在跳过 */
		}
	}
	assert.equal(total, 3, `activateScopeConsumption 生产调用恰 3 处，实际=${total}`);
	assert.equal(callsIn(consumerSrc), 1, "mailbox-consumer 内只有 session_start 一处调用（实现单点）");
	// 两个 attach 入口：与 triggerOwnershipRecheck 同一成功分支、同一共享函数（不各写一套）
	const slashStart = src.indexOf('pi.registerCommand("master-attach"');
	const slashEnd = src.indexOf("pi.registerCommand(", slashStart + 1);
	const slashBlock = src.slice(slashStart, slashEnd > 0 ? slashEnd : undefined);
	assert.ok(slashBlock.includes("triggerOwnershipRecheck") && slashBlock.includes("activateScopeConsumption({"), "slash attach 同分支补激活");
	assert.ok(slashBlock.indexOf("triggerOwnershipRecheck") < slashBlock.indexOf("activateScopeConsumption({"), "slash：激活在 ownership recheck 之后");
	const toolStart = toolsSrc.indexOf('name: "master-attach"');
	const toolEnd = toolsSrc.indexOf("pi.registerTool(", toolStart + 1);
	const toolBlock = toolsSrc.slice(toolStart, toolEnd > 0 ? toolEnd : undefined);
	assert.ok(toolBlock.includes("triggerOwnershipRecheck") && toolBlock.includes("activateScopeConsumption({"), "工具 attach 同分支补激活");
	assert.ok(toolBlock.indexOf("triggerOwnershipRecheck") < toolBlock.indexOf("activateScopeConsumption({"), "工具：激活在 ownership recheck 之后");
	// registerScopeWakeLoop 导出与签名不变（index.ts 接线不变）
	assert.ok(consumerSrc.includes("export function registerScopeWakeLoop"), "registerScopeWakeLoop 仍导出");
	assert.ok(/registerScopeWakeLoop\(pi, \{/.test(src), "index.ts 生产接线保持不变");

	// 零新增权力（静态 grep，先剥注释避免口径被注释文本干扰）：证据/判据层不得出现 attach/forceStale/liveness 写手
	const stripComments = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
	const consumeSrc = stripComments(readFileSync(join(here, "runtime", "scope-consume.ts"), "utf8"));
	for (const forbidden of ["attachMaster(", "attachCurrentSession(", "forceStale", "takeoverStaleScopeOwner", "writeScopeLiveness", "setCutover"]) {
		assert.ok(!consumeSrc.includes(forbidden), `scope-consume.ts 不得出现 ${forbidden}（零新增权力/不扩 scope-liveness）`);
	}
	const launchSrc = stripComments(readFileSync(join(here, "runtime", "local-master-launch.ts"), "utf8"));
	for (const forbidden of ["attachMaster(", "attachCurrentSession(", "takeoverStaleScopeOwner(", "writeScopeLiveness(", "judgeScopeOwnerStale("]) {
		assert.ok(!launchSrc.includes(forbidden), `local-master-launch.ts 不得出现 ${forbidden}（新证据不进既有接管判据）`);
	}
	// 证据唯一写手 = 消费 tick（全仓生产只有 mailbox-consumer 调 recordConsumeTick）
	let writers = 0;
	for (const f of prodFiles) {
		try {
			const t = readFileSync(join(here, f), "utf8");
			if (f !== "runtime/scope-consume.ts") writers += t.split("recordConsumeTick(").length - 1 - (t.split("function recordConsumeTick(").length - 1);
		} catch {
			/* 跳过 */
		}
	}
	assert.equal(writers, 1, `recordConsumeTick 生产调用恰 1 处（唯一写手 = tick），实际=${writers}`);
	ok("K 单一激活入口/接线/零新增权力/唯一写手 静态耦合校验");
}

// ════════════════════════════════════════════════════════════════════
// L — slash 参数解析纯函数（M1：--timeout 的值不得被当成 cwd）
// ════════════════════════════════════════════════════════════════════
{
	// 1) flag 在前（L4 实跑复现：旧解析取 cwd="5000"）
	const a1 = parseLocalMasterEnsureArgs("--timeout 5000 C:\\repo");
	assert.equal(a1.cwd, "C:\\repo", "flag-first：cwd 取真正 positional，不吃 --timeout 的值");
	assert.equal(a1.timeoutMs, 5000, "--timeout 的值仍被正常解析");
	assert.equal(a1.noWait, false);
	// 2) cwd 在前（命令描述里的书写顺序）
	const a2 = parseLocalMasterEnsureArgs("C:\\repo --timeout 5000");
	assert.equal(a2.cwd, "C:\\repo", "cwd-first 不回归");
	assert.equal(a2.timeoutMs, 5000);
	// 3) --no-wait 在前
	const a3 = parseLocalMasterEnsureArgs("--no-wait C:\\repo");
	assert.equal(a3.cwd, "C:\\repo", "--no-wait 是 flag，不吃 positional");
	assert.equal(a3.noWait, true);
	assert.equal(a3.timeoutMs, undefined, "未给 --timeout → 不给 timeoutMs（走缺省 60s）");
	// 4) 非法 timeout（L4 实跑复现：旧解析取 cwd="abc"）
	const a4 = parseLocalMasterEnsureArgs("--timeout abc C:\\repo");
	assert.equal(a4.cwd, "C:\\repo", "非法 timeout 值也不得被当成 cwd");
	assert.equal(a4.timeoutMs, undefined, "非法 → 不给，由 clampEnsureTimeout 缺省");
	assert.equal(clampEnsureTimeout(a4.timeoutMs), 60_000, "非法 timeout 回落缺省 60s");
	ok("L slash 参数解析 4 例（flag-first / cwd-first / --no-wait 在前 / 非法 timeout）");
}

// ══════════════════════════════════════════════════════════════════
// M — 0926 P1：「活 owner」与「消费侧就绪」拆分 + 降级语义（不自动接管）
// ══════════════════════════════════════════════════════════════════

// M1：活 owner 但**无消费证据** → consume-unverified（isError、零 spawn、零 marker、人权指引）
{
	const cwd = mkCwd();
	const scope = localMasterScope(cwd);
	const addr = localMasterAddress(scope);
	const fx = fixture({
		att: makeAtt(addr, "sess_alive", 4),
		lv: makeLv(scope, "sess_alive", 4, 777_777, "2026-09-24T12:00:05.000Z"),
	});
	const counter = spawnCounter();
	const clock = fakeClock();
	const deps: LocalMasterEnsureDeps = {
		spawn: counter.spawn, now: clock.now, sleep: clock.sleep, stateDir: STATE, pollIntervalMs: 10,
		readAttachment: fx.readAttachment, readLiveness: fx.readLiveness, readConsumeEvidence: fx.readConsumeEvidence, isAlive: isAliveFake,
	};
	const r = await ensureLocalMaster({ cwd, sessionId: "sess_main" }, deps);
	assert.equal(r.status, "consume-unverified", "降级不回 already-running（变异 5 守卫）");
	assert.equal(r.reason, "consume-evidence-missing");
	assert.equal(r.consumption?.state, "missing");
	assert.equal(r.generation, 4, "仍如实回快照");
	assert.equal(ensureResultIsError(r), true, "消费侧未证明 = 错误回执");
	assert.equal(counter.calls.length, 0, "降级不 spawn");
	assert.equal(markerExists(scope), false, "降级不写 in-flight");
	const text = formatLocalMasterEnsureResult(r);
	assert.ok(text.includes("进程活着，消费侧未证明"), `文案：${text}`);
	assert.ok(text.includes("不自动接管、不强接、零 spawn"), "明示不自动 force takeover");
	assert.ok(text.includes("/master-attach --local --force-stale --confirm"), "给人权指引（工具不代持权力）");
	ok("M1 consume-unverified：活 owner 无消费证据 → 明确降级（零 spawn 零接管）");
}

// M2：证据不成立的其余三种 reason（stale / identity-mismatch / old-generation）
{
	const cwd = mkCwd();
	const scope = localMasterScope(cwd);
	const addr = localMasterAddress(scope);
	const att = makeAtt(addr, "sess_alive", 4);
	const lv = makeLv(scope, "sess_alive", 4, 777_777, "2026-09-24T12:00:05.000Z");
	const run = async (ev: ScopeConsumeEvidence | null): Promise<LocalMasterEnsureResult> => {
		const fx = fixture({ att, lv, ev });
		const counter = spawnCounter();
		const clock = fakeClock();
		return ensureLocalMaster(
			{ cwd, sessionId: "sess_main" },
			{
				spawn: counter.spawn, now: clock.now, sleep: clock.sleep, stateDir: STATE, pollIntervalMs: 10,
				readAttachment: fx.readAttachment, readLiveness: fx.readLiveness, readConsumeEvidence: fx.readConsumeEvidence, isAlive: isAliveFake,
			},
		);
	};
	const stale = await run(makeEv(scope, "sess_alive", 4, "2026-09-24T11:58:00.000Z")); // > 90s 未 tick
	assert.equal(stale.status, "consume-unverified");
	assert.equal(stale.reason, "consume-evidence-stale");
	assert.equal(stale.consumption?.state, "stale");
	const mismatch = await run(makeEv(scope, "sess_other", 4, "2026-09-24T12:00:00.000Z"));
	assert.equal(mismatch.reason, "consume-evidence-identity-mismatch");
	// ownership transfer：旧代证据不能证明新代就绪（D3）
	const oldGen = await run(makeEv(scope, "sess_alive", 3, "2026-09-24T12:00:00.000Z"));
	assert.equal(oldGen.status, "consume-unverified");
	assert.equal(oldGen.reason, "consume-evidence-old-generation");
	assert.equal(oldGen.generation, 4, "attachment 已是新代、证据仍是旧代 → 降级");
	ok("M2 consume-evidence-stale / identity-mismatch / old-generation（transfer 旧代不算数）");
}

// M3：工具面真实盘面（隔离 PI_RUNTIME_DIR）：无证据 → isError + 审计受控枚举
{
	const counter = spawnCounter();
	const tool = loadTool({ ensureLocalMasterTab: counter.spawn })!;
	const cwd = mkCwd();
	const scope = localMasterScope(cwd);
	attachMaster({ sessionId: "sess_no_ev", agent: localMasterAddress(scope), detail: cwd });
	writeScopeLiveness({ scopeKey: scope, sessionId: "sess_no_ev", generation: 1, pid: process.pid });
	assert.equal(readConsumeEvidence(scope, { stateDir: STATE }), null, "夹具：无消费证据");
	const res = await tool.execute("m3", { cwd }, undefined, undefined, { sessionManager: { sessionId: "sess_main_m3" } });
	assert.equal(res.isError, true, "工具面消费侧未证明 = isError");
	assert.ok(res.content[0].text.includes("consume-unverified"), res.content[0].text);
	assert.equal(res.details?.reason, "consume-evidence-missing");
	assert.equal(res.details?.status, "consume-unverified");
	assert.equal(counter.calls.length, 0, "工具面零 spawn");
	assert.notEqual(res.content[0].text.includes("already-running"), true, "不得回 already-running");
	const rows = readLocalMasterEnsureAudit(STATE);
	assert.equal(rows.slice(-1)[0]!.action, "ensure:tool");
	assert.equal(rows.slice(-1)[0]!.result, "consume-unverified:consume-evidence-missing", "审计 result 仍是受控枚举");
	// 补一条同身份新鲜证据 → 同一夹具回升 already-running（证据是唯一开关）
	assert.ok(recordConsumeTick({ scope, sessionId: "sess_no_ev", generation: 1, lastTickReason: "no-mail" }, { stateDir: STATE }));
	const res2 = await tool.execute("m3b", { cwd }, undefined, undefined, { sessionManager: { sessionId: "sess_main_m3" } });
	assert.notEqual(res2.isError, true, "证据新鲜 → 非错误");
	assert.ok(res2.content[0].text.includes("already-running"), res2.content[0].text);
	assert.equal(counter.calls.length, 0, "两次都零 spawn");
	ok("M3 工具面：无证据 consume-unverified（审计枚举）/ 有证据 already-running");
}

// M4：launched → ready 也必须由消费事实证明（第 8 条；变异 4 守卫）
{
	const { r, spawnCalls } = await runPollCase((fx, launchAt, scope, addr) => {
		fx.state.att = makeAtt(addr, "sess_new", 1);
		fx.state.lv = makeLv(scope, "sess_new", 1, 111, new Date(Date.parse(launchAt) + 1_000).toISOString());
		// 故意不写证据
		void scope;
	});
	assert.equal(spawnCalls, 1);
	assert.equal(r.status, "stalled", "liveness 全绿 + gen 前进但无消费证据 → 不判 ready");
	assert.equal(r.reason, "consume-evidence-missing");
	assert.equal(r.consumption?.state, "missing");
	ok("M4 launched→ready 需消费证据（活进程 ≠ 收信就绪）");
}

// M5：同 scope 并发两次 ensure → 恰一次 dispatch（D1；另一调用 in-flight）
{
	const cwd = mkCwd();
	const scope = localMasterScope(cwd);
	const fx = fixture();
	const counter = spawnCounter();
	const clock = fakeClock();
	const deps: LocalMasterEnsureDeps = {
		spawn: counter.spawn, now: clock.now, sleep: clock.sleep, stateDir: STATE, pollIntervalMs: 10,
		readAttachment: fx.readAttachment, readLiveness: fx.readLiveness, readConsumeEvidence: fx.readConsumeEvidence, isAlive: isAliveFake,
	};
	const [r1, r2] = await Promise.all([
		ensureLocalMaster({ cwd, sessionId: "sess_main", waitForReady: false, timeoutMs: 5_000 }, deps),
		ensureLocalMaster({ cwd, sessionId: "sess_main", waitForReady: false, timeoutMs: 5_000 }, deps),
	]);
	assert.equal(counter.calls.length, 1, "并发两次 ensure 恰一次 dispatch（不出现两个有效消费者）");
	const infl = [r1, r2].filter((r) => r.inFlight === true).length;
	assert.equal(infl, 1, "第二个调用回 in-flight（零第二个 spawn）");
	assert.equal([r1, r2].filter((r) => r.status === "launched" && !r.inFlight).length, 1);
	clearLocalMasterLaunchMarker(scope, STATE);
	ok("M5 同 scope 并发 ensure：恰 1 dispatch + 1 in-flight");
}


// ── 清理（临时 runtimeDir + 目标目录；exit 钩子兑底，S3）──────
cleanupAll();
console.log(`_test_local_master_launch: all assertions passed (${n} groups)`);
