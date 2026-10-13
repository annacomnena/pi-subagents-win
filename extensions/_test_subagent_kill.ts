/**
 * _test_subagent_kill.ts — 异步 subagent「直接 kill」集成测试（2026-10-13）
 *
 * 真实验证（不是 mock）：
 *   1. 用 stub pi CLI 派发一个**真会挂住**的 async run（stub 自身不退出，并再拉起一个挂住的孙进程）；
 *   2. subagent-win({action:"list"}) 能列出该 run 的 pid + running 状态；
 *   3. subagent-win({action:"kill", runId}) 终止**整棵进程树**（stub + 孙进程都消失）；
 *   4. run json 落成 status=cancelled + killedBy + killedAt，pid 字段清除；
 *   5. 二次 kill 幂等（不报错、不误杀）；不存在的 runId 安全返回 isError。
 *
 * 测试卫生（本仓踩过“测试不退出→整轮卡死”的坑）：
 *   - runs 目录隔离（修 2）：PI_SUBAGENT_RUNS_DIR → mkdtemp，零写入真实 ~/.pi/agent/subagent-runs；
 *   - 副作用全隔离（修 3，1013 must-fix ④-1）：本测试还会经 index.ts 真实写出派发溯源
 *     links.jsonl、用量账本 subagent-usage/<day>.jsonl、runtime/**（receipts/journal）并派生
 *     powershell.exe 弹 Windows toast。故再注入 PI_LINKS_PATH / PI_SUBAGENT_USAGE_DIR /
 *     PI_RUNTIME_DIR 全指向 mkdtemp，并以 PI_NOTIFY_DISABLE=1 硬关 toast →
 *     测试期间零写真实 ~/.pi/agent/**、零用户可见通知；
 *   - 硬超时 90s：超时即强杀所有相关 pid 并 process.exit(1);
 *   - finally 显式 kill stub/孙进程 + 删除临时文件；
 *   - 结束显式 process.exit(0)，不留后台进程。
 *
 * 运行：npm run test:subagent-kill
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setCurrentSessionId } from "./identity.ts";

// 模拟 session_start：让 recordLink 的 sessionId 与本进程 currentSessionId 对齐，
// 从而覆盖 kill 缺省目标（本会话唯一 running run）的会话归属判定。
setCurrentSessionId("test-subagent-kill");

delete process.env.PI_SUBAGENT;
delete process.env.PI_TAB_RUN_ID;
delete process.env.PI_TAB_RUNS_DIR;
delete process.env.PI_SESSION_PROFILE;

const STUB_PATH = join(tmpdir(), `pi-kill-test-stub-${process.pid}.cjs`);
const PIDFILE = join(tmpdir(), `pi-kill-test-pids-${process.pid}.json`);
// 测试卫生（修 2，1013）：runs 目录隔离到临时目录，零写入真实 ~/.pi/agent/subagent-runs。
// 必须在 `await import("./index.ts")` 之前设置——index.ts / subagent-kill.ts 在模块加载时
// 读一次 PI_SUBAGENT_RUNS_DIR（DEFAULT_RUNS_DIR），此后不再重读。跑完在 finally 递归删除。
const RUNS_DIR = mkdtempSync(join(tmpdir(), "subagent-kill-runs-"));
process.env.PI_SUBAGENT_RUNS_DIR = RUNS_DIR;
// 副作用隔离（修 3，1013 must-fix ④-1）：index.ts 在本测试中还会真实写出
//   ① 派发溯源 links.jsonl（links.ts#defaultLinksPath，硬编码真实路径）
//   ② 用量账本 subagent-usage/<day>.jsonl（index.ts#USAGE_DIR，硬编码）
//   ③ runtime/**（journal/receipts，走 PI_RUNTIME_DIR）+ spawn-trace tmp/spawn-trace.log
//   ④ 派生 powershell.exe 弹真实 Windows toast（notify-windows.ts）
// 三者 env + PI_NOTIFY_DISABLE 全部改道/关闭，确保零写真实 ~/.pi/agent/**、零用户可见通知。
// 仍必须在 `await import("./index.ts")` 之前设置（index.ts/links.ts/subagent-kill.ts
// 均在模块加载时读一次 env，此后不再重读）。
const LINKS_DIR = mkdtempSync(join(tmpdir(), "subagent-kill-links-"));
const LINKS_PATH = join(LINKS_DIR, "links.jsonl");
process.env.PI_LINKS_PATH = LINKS_PATH;
const USAGE_DIR = mkdtempSync(join(tmpdir(), "subagent-kill-usage-"));
process.env.PI_SUBAGENT_USAGE_DIR = USAGE_DIR;
// PI_RUNTIME_DIR：runtime/journal + runtime/receipts 的根；spawn-trace 另 join "tmp" 落盘。
// 保持 spawn-trace 启用（不设 PI_SPAWN_TRACE=0）——跑完可查临时 trace 里 toast 行数 = 0，
// 作为「本测试未派生任何 powershell/toast」的直接运行时证据。
const RUNTIME_DIR = mkdtempSync(join(tmpdir(), "subagent-kill-runtime-"));
process.env.PI_RUNTIME_DIR = RUNTIME_DIR;
process.env.PI_NOTIFY_DISABLE = "1";
const ISOLATED_DIRS = [RUNS_DIR, LINKS_DIR, USAGE_DIR, RUNTIME_DIR];
assert.ok(ISOLATED_DIRS.every((d) => d.startsWith(tmpdir())), `所有隔离目录必须在 tmpdir 内：${ISOLATED_DIRS.join(", ")}`);
assert.equal(process.env.PI_NOTIFY_DISABLE, "1", "toast 必须已被硬关");
function cleanupIsolated(): void {
	for (const d of ISOLATED_DIRS) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
}
/**
 * 运行时证据（must-fix ④-1）：重定向后的 spawn-trace 里 toast 派生行数。
 * sendWindowsToast 在 PI_NOTIFY_DISABLE=1 时于 traceSpawn **之前** 早退，故必须为 0 ——
 * 若 >0 则说明存在绕过 notify-windows 的弹窗路径（或开关失效）。-1 = trace 文件不存在
 * （本测试中 index.ts 的派发路径不调 traceSpawn，故常态就是 -1 = 零派生；两者都算通过）。
 */
function tempToastSpawnLines(): number {
	try {
		return readFileSync(join(RUNTIME_DIR, "tmp", "spawn-trace.log"), "utf8")
			.split("\n").filter((l) => l.includes("\ttoast\t")).length;
	} catch { return -1; }
}
const MODEL = "TestSuite/kill-stub";

// stub pi CLI：写自身+孙进程 pid 到 PIDFILE，然后永久挂住（绝不退出）。
writeFileSync(
	STUB_PATH,
	[
		'const { spawn } = require("node:child_process");',
		'const fs = require("node:fs");',
		'const grand = spawn(process.execPath, ["-e", "setTimeout(()=>{},600000)"], { stdio: "ignore" });',
		'fs.writeFileSync(process.env.PI_KILL_TEST_PIDFILE, JSON.stringify({ stub: process.pid, grand: grand.pid }));',
		"setInterval(() => {}, 1000);",
	].join("\n"),
	"utf8",
);
process.env.PI_CLI_PATH = STUB_PATH;
process.env.PI_KILL_TEST_PIDFILE = PIDFILE;

const runFile = (id: string): string => join(RUNS_DIR, `${id}.json`);
const readRun = (id: string): any => JSON.parse(readFileSync(runFile(id), "utf8"));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
function alive(pid: number | undefined): boolean {
	if (!pid) return false;
	try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException)?.code === "EPERM"; }
}
async function waitFor(cond: () => boolean, ms: number, label: string): Promise<void> {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		if (cond()) return;
		await sleep(150);
	}
	throw new Error(`timeout waiting for ${label}`);
}
function forceKill(pid: number | undefined): void {
	if (!alive(pid)) return;
	try { process.kill(pid as number, "SIGKILL"); } catch { /* ignore */ }
}

// ── fake pi（复用 register-graph / _test_parallel_async 范式）──
const tools = new Map<string, any>();
const fakePi = {
	registerTool(def: { name: string }): void { tools.set(def.name, def); },
	registerCommand(): void {},
	registerFlag(): void {},
	on(): void {},
	getFlag(): string { return ""; },
	sendUserMessage: () => {},
	sendMessage: () => {},
	exec: () => {},
} as unknown as ExtensionAPI;
const fakeCtx = { sessionManager: { sessionId: "test-subagent-kill" } } as never;
const textOf = (res: any): string => res?.content?.[0]?.text ?? "";

let runId: string | null = null;
let stubPid: number | undefined;
let grandPid: number | undefined;
let safetyPid: number | undefined;
let hardTimer: ReturnType<typeof setTimeout> | null = null;
const safetyRunId = "run_kill_safety_zz";
const noPidRunId = "run_kill_nopid_zz";
const terminalRunId = "run_kill_terminal_zz";

async function main(): Promise<void> {
	const mod = await import("./index.ts");
	await mod.default(fakePi);
	const tool = tools.get("subagent-win");
	assert.ok(tool?.execute, "subagent-win tool must be registered");

	// ── 1. 派发必挂住的 async run ──────────────────────────────
	const res = await tool.execute("k1", { task: "must hang forever", model: MODEL }, undefined, undefined, fakeCtx);
	const text = textOf(res);
	const m = text.match(/run_[a-z0-9]+_[a-z0-9]+/);
	assert.ok(m, `dispatch must return a runId, got: ${text.slice(0, 120)}`);
	runId = m[0];
	console.log(`[1] dispatched hanging async run: ${runId}`);

	await waitFor(() => existsSync(PIDFILE), 20_000, "stub pidfile (child spawn)");
	const pids = JSON.parse(readFileSync(PIDFILE, "utf8")) as { stub: number; grand: number };
	stubPid = pids.stub;
	grandPid = pids.grand;
	assert.ok(alive(stubPid), "stub process must be alive (hanging)");
	assert.ok(alive(grandPid), "grandchild process must be alive");

	const rec = readRun(runId);
	assert.equal(rec.status, "running", "run recorded as running");
	assert.equal(rec.pid, stubPid, "run json must record the spawned pid");
	assert.ok(String(rec.pidCmdMarker ?? "").includes("pi-kill-test-stub"), `marker recorded: ${rec.pidCmdMarker}`);
	assert.ok(rec.pidRecordedAt && rec.lastActivity, "pidRecordedAt + lastActivity recorded");
	console.log(`[2] registered pid=${stubPid} marker ok, grandchild pid=${grandPid}`);

	// ── 2. list 可见性 ─────────────────────────────────────────
	const listRes = await tool.execute("k2", { action: "list" }, undefined, undefined, fakeCtx);
	const listText = textOf(listRes);
	assert.ok(listText.includes(runId), `list must contain our run: ${listText.slice(0, 400)}`);
	assert.ok(listText.includes(`pid=${stubPid}`), `list must show pid: ${listText.slice(0, 400)}`);
	assert.ok(/running/.test(listText), "list must show running status");
	assert.ok(/idle=/.test(listText), "list must show idle/lastActivity");
	console.log("[3] action:list shows runId + pid + running + idle ✓");

	const selfKill = await tool.execute("k2b", { action: "kill" }, undefined, undefined, fakeCtx);
	assert.ok(!selfKill.isError, `kill with single session running run must succeed: ${textOf(selfKill)}`);
	assert.ok(textOf(selfKill).includes(runId!), `kill target should be our run: ${textOf(selfKill)}`);
	console.log(`[4] action:kill (runId omitted, single session run) resolved to ${runId} ✓`);

	// ── 3. 进程树已消失 + 状态 cancelled ──────────────────────
	await waitFor(() => !alive(stubPid) && !alive(grandPid), 8_000, "process tree gone");
	const after = readRun(runId);
	assert.equal(after.status, "cancelled", `run must end cancelled, got ${after.status}`);
	assert.equal(after.killedBy, "tool:subagent-win", "killedBy recorded");
	assert.ok(typeof after.killedAt === "string" && after.killedAt.length > 0, "killedAt recorded");
	assert.equal(after.pid, undefined, "pid fields must be cleared after kill");
	console.log(`[5] tree killed (stub=${stubPid}, grand=${grandPid}); status=cancelled killedBy=${after.killedBy} ✓`);

	// ── 4. 二次 kill 幂等 ──────────────────────────────────────
	const again = await tool.execute("k3", { action: "kill", runId }, undefined, undefined, fakeCtx);
	assert.ok(!again.isError, `second kill must be idempotent success: ${textOf(again)}`);
	assert.ok(/already cancelled/i.test(textOf(again)), `second kill should report already cancelled: ${textOf(again)}`);
	console.log("[6] second kill idempotent (isError=false, already cancelled) ✓");

	// ── 5. 不存在的 runId 安全返回 ────────────────────────────
	const bogus = await tool.execute("k4", { action: "kill", runId: "run_does_not_exist_zz" }, undefined, undefined, fakeCtx);
	assert.ok(bogus.isError, "unknown runId must be an error (safe return)");
	assert.ok(/not found/i.test(textOf(bogus)), `unknown runId message: ${textOf(bogus)}`);
	console.log("[7] unknown runId safe error (not found) ✓");

	// ── 6. 安全校验反向用例（防误杀）──────────────────────────
	const now = new Date().toISOString();

	// 6a. pid 身份不匹配（marker 对不上）→ 拒杀，且无关进程不被杀。
	const unrelated = spawn(process.execPath, ["-e", "setTimeout(()=>{},600000)"], { stdio: "ignore" });
	safetyPid = unrelated.pid;
	assert.ok(alive(safetyPid), "unrelated safety process alive");
	writeFileSync(runFile(safetyRunId), JSON.stringify({
		id: safetyRunId, agent: "x", task: "safety", status: "running", startedAt: now,
		pid: safetyPid, pidRecordedAt: now, pidCmdMarker: "marker-that-matches-nothing-zzz",
	}));
	const refused = await tool.execute("k5", { action: "kill", runId: safetyRunId }, undefined, undefined, fakeCtx);
	assert.ok(refused.isError, `identity mismatch must be refused: ${textOf(refused)}`);
	assert.ok(/refus/i.test(textOf(refused)), `refusal message: ${textOf(refused)}`);
	assert.ok(alive(safetyPid), "unrelated process MUST survive a refused kill");
	console.log("[8] safety: marker mismatch → refused, unrelated pid untouched ✓");

	// 6b. running 但无 pid → 安全报错（老记录）。
	writeFileSync(runFile(noPidRunId), JSON.stringify({ id: noPidRunId, task: "np", status: "running", startedAt: now }));
	const noPid = await tool.execute("k6", { action: "kill", runId: noPidRunId }, undefined, undefined, fakeCtx);
	assert.ok(noPid.isError && /no recorded pid/i.test(textOf(noPid)), `no_pid message: ${textOf(noPid)}`);
	console.log("[9] safety: running without pid → safe error (no_pid) ✓");

	// 6c. 已终态（completed）无进程 → 幂等成功。
	writeFileSync(runFile(terminalRunId), JSON.stringify({ id: terminalRunId, task: "t", status: "completed", startedAt: now }));
	const term = await tool.execute("k7", { action: "kill", runId: terminalRunId }, undefined, undefined, fakeCtx);
	assert.ok(!term.isError && /already completed/i.test(textOf(term)), `terminal idempotent message: ${textOf(term)}`);
	console.log("[10] safety: terminal run → idempotent success (already completed) ✓");
}

try {
	hardTimer = setTimeout(() => {
		console.error("HARD TIMEOUT: subagent-kill test hung; force cleaning up");
		forceKill(stubPid);
		forceKill(grandPid);
		forceKill(safetyPid);
		for (const id of [runId, safetyRunId, noPidRunId, terminalRunId].filter(Boolean) as string[]) {
			try { if (existsSync(runFile(id))) unlinkSync(runFile(id)); } catch { /* ignore */ }
		}
		try { cleanupIsolated(); } catch { /* ignore */ }
		process.exit(1);
	}, 90_000);

	await main();
	console.log("[subagent-kill] ALL PASS");
} catch (err) {
	console.error("[subagent-kill] FAIL:", err instanceof Error ? err.stack ?? err.message : String(err));
	process.exitCode = 1;
} finally {
	if (hardTimer) clearTimeout(hardTimer);
	forceKill(stubPid);
	forceKill(grandPid);
	forceKill(safetyPid);
	// 杀进程后 index.ts 的 .then 可能补写一次 run json，稍等后清理。
	await sleep(500);
	for (const p of [STUB_PATH, PIDFILE]) { try { if (existsSync(p)) unlinkSync(p); } catch { /* ignore */ } }
	for (const id of [runId, safetyRunId, noPidRunId, terminalRunId].filter(Boolean) as string[]) {
		try { if (existsSync(runFile(id))) unlinkSync(runFile(id)); } catch { /* ignore */ }
	}
	// 运行时证据（在删除隔离目录之前采集）：改道后的临时目录里确实收到了写入，且零 toast 派生。
	const toastSpawns = tempToastSpawnLines();
	const tempLinksLines = (() => { try { return readFileSync(LINKS_PATH, "utf8").split("\n").filter(Boolean).length; } catch { return -1; } })();
	const tempUsageEntries = (() => { try { return readdirSync(USAGE_DIR).length; } catch { return -1; } })();
	console.log(`isolation evidence: temp links lines = ${tempLinksLines} (expect >=1); temp usage files = ${tempUsageEntries}; temp spawn-trace toast spawns = ${toastSpawns} (expect 0 or -1=no trace file); PI_NOTIFY_DISABLE=${process.env.PI_NOTIFY_DISABLE}`);
	// 清掉全部隔离临时目录（runs 含 watcher 可能补写的 .notified；links/usage/runtime 同理），零残留。
	cleanupIsolated();
	const leftovers = [stubPid, grandPid, safetyPid].filter((p) => alive(p));
	if (leftovers.length > 0) {
		console.error(`LEFTOVER PROCESSES: ${leftovers.join(", ")}`);
		process.exitCode = 1;
	} else if (toastSpawns > 0) {
		console.error(`TOAST SPAWNED DURING TEST: temp spawn-trace toast lines = ${toastSpawns} (must be 0; -1 = no trace file = zero traced spawns)`);
		process.exitCode = 1;
	} else {
		console.log(`cleanup ok: no leftover processes (checked stub=${stubPid ?? "?"}, grand=${grandPid ?? "?"})`);
	}
	process.exit(process.exitCode ?? 0);
}
