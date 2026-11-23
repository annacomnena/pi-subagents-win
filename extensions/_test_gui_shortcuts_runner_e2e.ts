/**
 * _test_gui_shortcuts_runner_e2e.ts — script/process 执行器的 HTTP 接线 E2E（P3）。
 *
 * 真实入口：进程内起 createRuntimeHostServer（注入假 spawn/枚举/kill，不碰真实进程）→
 * 真实 HTTP POST /v1/gui/shortcuts/run|cancel → 服务端从配置取命令 → 执行器。
 * 变异打注册点（删 run 分支 / 改成信客户端 command）才红（AGENTS.md §4.2）。
 *
 * 运行：npm run test:gui-shortcuts-runner-e2e
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "gs-runner-e2e-runtime-"));

import { createRuntimeHostServer } from "./runtime-host/server.ts";

let n = 0;
const ok = (msg: string): void => { n += 1; console.log(`ok ${n} - ${msg}`); };
interface Resp { status: number; body: any }
async function req(port: number, path: string, opts: { method?: string; token?: string; body?: unknown } = {}): Promise<Resp> {
	const headers: Record<string, string> = {};
	if (opts.token !== undefined) headers["x-command-token"] = opts.token;
	if (opts.body !== undefined) headers["content-type"] = "application/json";
	const res = await fetch(`http://127.0.0.1:${port}${path}`, {
		method: opts.method ?? "GET", headers,
		...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
	});
	const text = await res.text();
	let body: unknown = null;
	try { body = text.length > 0 ? JSON.parse(text) : null; } catch { /* ignore */ }
	return { status: res.status, body };
}

const D = mkdtempSync(join(tmpdir(), "gs-runner-e2e-"));
const shortcutsDir = join(D, "gui-shortcuts");
const cfgPath = join(D, "config.json");
mkdirSync(join(D, "sessions"), { recursive: true });
mkdirSync(join(D, "agent"), { recursive: true });
writeFileSync(cfgPath, JSON.stringify({ gui: { autoStart: false } }), "utf8");
const CWD = "G:/code/GreenCAD";

// 假 spawn：记录收到的 args，模拟成功退出（stdout 吐一行）。
const spawnCalls: Array<{ cmd: string; args: string[] }> = [];
function fakeSpawn(cmd: string, args: string[]): any {
	spawnCalls.push({ cmd, args });
	const child: any = new EventEmitter();
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.pid = 424242;
	process.nextTick(() => {
		child.stdout.emit("data", Buffer.from("build ok\n"));
		child.emit("close", 0, null);
	});
	return child;
}
// 假进程枚举：3 个 dotnet，一个匹配；假 kill 记录 pid。
const killed: number[] = [];
const runnerDeps = {
	spawnFn: fakeSpawn as any,
	enumProcessesFn: () => [
		{ pid: 100, creationDateMs: 1700000000000, commandLine: "dotnet other.dll" },
		{ pid: 200, creationDateMs: 1700000000000, commandLine: "dotnet GreenCAD.AI.Server.dll --port 5000" },
		{ pid: 300, creationDateMs: 1700000000000, commandLine: "dotnet another.dll" },
	],
	// fail-closed 身份复核：假 inspect 对 pid 200 返回同样的 CreationDate，其余返回 null。
	inspectPidFn: (pid: number) => pid === 200
		? { startedAtMs: 1700000000000, cmd: "dotnet GreenCAD.AI.Server.dll --port 5000" }
		: { startedAtMs: null, cmd: null },
	killFn: (pid: number) => { killed.push(pid); return { ok: true, out: `killed ${pid}` }; },
};

const handle = await createRuntimeHostServer({
	hostPath: join(D, "host.json"),
	stateDir: join(D, "state"),
	sessionsDir: join(D, "sessions"),
	agentDir: join(D, "agent"),
	shortcutsDir,
	shortcutsRunnerDeps: runnerDeps,
	configPath: cfgPath,
	journalPath: join(D, "events.jsonl"),
	tabRunsDir: join(D, "tab-runs"),
	runsDir: join(D, "runs"),
	distDir: join(D, "dist"),
	lockWaitMs: 0,
});
try {
	const port = handle.info.port;
	const token = handle.info.token;
	// 直接写主配置（等价于用户面板保存之后的落盘状态）。
	const cfg = {
		version: 1, cwd: CWD, updatedAt: new Date().toISOString(),
		actions: [
			{ id: "build", label: "编译", kind: "script", command: "build.ps1", args: ["-c", "Release"], timeoutMs: 30000, confirm: true },
			{ id: "kill-dotnet", label: "关服务", kind: "process", matchCommandLine: "GreenCAD.AI.Server.dll", timeoutMs: 30000, confirm: true },
			{ id: "ci", label: "CI", kind: "url", url: "http://ci.local" },
		],
	};
	const { repoKey } = await import("./gui-shortcuts.ts");
	mkdirSync(shortcutsDir, { recursive: true });
	writeFileSync(join(shortcutsDir, `${repoKey(CWD)}.json`), JSON.stringify(cfg), "utf8");

	// ── script 运行：命令只从配置取，spawn 收 -File build.ps1 -c Release ──
	const run = await req(port, "/v1/gui/shortcuts/run", {
		method: "POST", token, body: { cwd: CWD, id: "build" },
	});
	assert.equal(run.status, 200, JSON.stringify(run.body));
	assert.equal(run.body.status, "success");
	assert.equal(run.body.exitCode, 0);
	assert.match(run.body.outputTail, /build ok/);
	assert.equal(spawnCalls.length, 1);
	assert.equal(spawnCalls[0]!.cmd, "powershell.exe");
	assert.ok(spawnCalls[0]!.args.includes("-File"));
	assert.ok(spawnCalls[0]!.args.some((a) => a.endsWith("build.ps1")));
	assert.ok(spawnCalls[0]!.args.includes("Release"));
	assert.ok(!spawnCalls[0]!.args.includes("-ExecutionPolicy"), "不得加 ExecutionPolicy Bypass");
	ok("run script → 真调 powershell -File <abs>.ps1 <args>（shell:false，无 Bypass）");

	// ── 安全：客户端伪造 command 不生效（只认 cwd+id）──
	const forged = await req(port, "/v1/gui/shortcuts/run", {
		method: "POST", token, body: { cwd: CWD, id: "build", command: "evil.ps1", args: ["--pwn"] },
	});
	assert.equal(forged.status, 200);
	assert.ok(spawnCalls[1]!.args.some((a) => a.endsWith("build.ps1")), "仍执行配置的 build.ps1");
	assert.ok(!spawnCalls[1]!.args.includes("--pwn"), "客户端伪造参数被忽略");
	ok("伪造 command/args → 服务端只从配置取（忽略客户端注入）");

	// ── url 按钮不可运行 ──
	const urlRun = await req(port, "/v1/gui/shortcuts/run", {
		method: "POST", token, body: { cwd: CWD, id: "ci" },
	});
	assert.equal(urlRun.status, 400);
	assert.equal(urlRun.body.error, "not-runnable");
	ok("run url 按钮 → 400 not-runnable");

	// ── process：精确匹配唯一进程 → kill pid 200 ──
	const kill = await req(port, "/v1/gui/shortcuts/run", {
		method: "POST", token, body: { cwd: CWD, id: "kill-dotnet" },
	});
	assert.equal(kill.status, 200, JSON.stringify(kill.body));
	assert.equal(kill.body.status, "success");
	assert.deepEqual(killed, [200]);
	ok("run process → 精确匹配 pid 200 并终止（不误杀 100/300）");

	// ── 取消：对已结束的 run 拒绝（归属/状态校验）──
	const cancel = await req(port, "/v1/gui/shortcuts/cancel", {
		method: "POST", token, body: { runId: run.body.runId },
	});
	assert.equal(cancel.status, 400);
	assert.equal(cancel.body.error, "not-running");
	ok("cancel 已结束的 run → 400 not-running");

	// ── 鉴权：无 token 的 run 401 ──
	const noAuth = await req(port, "/v1/gui/shortcuts/run", {
		method: "POST", token: "wrong", body: { cwd: CWD, id: "build" },
	});
	assert.equal(noAuth.status, 401);
	ok("run 无/错 token → 401");

	// ── L4 回归：路径穿越 runId 被形状校验拒绝 ──
	const traversal = await req(port, "/v1/gui/shortcuts/cancel", {
		method: "POST", token, body: { runId: "../../etc/passwd" },
	});
	assert.equal(traversal.status, 400);
	assert.equal(traversal.body.error, "invalid-run-id");
	ok("cancel 路径穿越 runId → 400 invalid-run-id（不读越界文件）");

	// ── L4 回归：进程身份不符 fail-closed 拒杀 ──
	// 换一套 deps 的 server 太重，这里直接测纯函数：候选 CreationDate 与 inspect 不一致 ⇒ 拒。
	const { terminateProcess } = await import("./gui-shortcuts-runner.ts");
	const D2 = mkdtempSync(join(tmpdir(), "gs-runner-identity-"));
	const mismatch = terminateProcess("kill-dotnet", CWD, "GreenCAD.AI.Server.dll", D2, {
		enumProcessesFn: () => [{ pid: 777, creationDateMs: 111, commandLine: "dotnet GreenCAD.AI.Server.dll" }],
		inspectPidFn: () => ({ startedAtMs: 222, cmd: "dotnet GreenCAD.AI.Server.dll" }), // 身份变了
		killFn: (pid: number) => { killed.push(pid); return { ok: true, out: "" }; },
	});
	assert.equal(mismatch.result.ok, false);
	assert.equal(mismatch.result.error, "identity-unverified");
	assert.ok(!killed.includes(777), "身份不符绝不 kill");
	// 缺 CreationDate 也拒（fail-open 变异应红）
	const missing = terminateProcess("kill-dotnet", CWD, "GreenCAD.AI.Server.dll", D2, {
		enumProcessesFn: () => [{ pid: 888, creationDateMs: null, commandLine: "dotnet GreenCAD.AI.Server.dll" }],
		inspectPidFn: () => ({ startedAtMs: null, cmd: null }),
		killFn: (pid: number) => { killed.push(pid); return { ok: true, out: "" }; },
	});
	assert.equal(missing.result.error, "identity-unverified");
	assert.ok(!killed.includes(888), "缺身份证据绝不 kill");
	ok("进程身份不符/缺失 → fail-closed 拒杀（防 pid 复用误杀）");
	try { rmSync(D2, { recursive: true, force: true }); } catch { /* ignore */ }

	console.log(`\nALL ${n} ASSERTIONS PASSED`);
} finally {
	await handle.close();
	try { rmSync(D, { recursive: true, force: true }); } catch { /* ignore */ }
}
