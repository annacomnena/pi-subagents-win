/**
 * _test_trace_fusion_param.ts — trace-fusion 参数化（① model / ② cwd / ③ lanes / ④ 门控）
 *
 * 需求：`plans/20261021_trace_fusion_parametrization.md`
 * 计划：`plans/20261021_trace_fusion_parametrization_plan.md`（v3 + V8）
 *
 * 纪律（AGENTS §4 / 计划 V4）：
 *   - 断言经**真实入口**：真 `index.ts` factory 注册 → 真 `tool.execute(rawParams)`；
 *     底层 `launchTraceRun` 的单元行为另有既有套件，不重复证明接线。
 *   - **永不真开 Windows Terminal**：`child_process.spawn` 模块级拦截 + `syncBuiltinESMExports()`；
 *     `spawnSync` **只** stub `where`/`wt` 探测，`git` 一律透传（trace preflight 需要真 git）。
 *   - 隔离：`USERPROFILE`/`HOME` + `PI_*` 目录全指临时树（`index.ts` 的 `defaultTabRunsDir()`
 *     /`defaultTimersDir()` 只读 homedir，必须靠 HOME 级隔离）；`PI_TRACE_FUSION_CONFIG` 指向替身配置。
 *   - 每个会真起跑的用例用独立 `PI_TRACE_FUSION_RUNS_DIR`（`maxActiveRuns=1` 互斥会拦住下一例）。
 *
 * 运行：
 *   node --experimental-strip-types --import ./extensions/runtime-host/pi-deps-loader.mjs \
 *        ./extensions/_test_trace_fusion_param.ts
 */

import assert from "node:assert/strict";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── 隔离必须在 import 本仓模块之前（homedir 派生）──────────────────────
const TMP = mkdtempSync(join(tmpdir(), "tf-param-"));
const AGENT_DIR = join(TMP, ".pi", "agent");
process.env.USERPROFILE = TMP;
process.env.HOME = TMP;
process.env.PI_RUNTIME_DIR = join(AGENT_DIR, "runtime");
process.env.PI_LINKS_PATH = join(AGENT_DIR, "links.jsonl");
const FAKE_CLI = join(TMP, "fake-pi-cli.js");
writeFileSync(FAKE_CLI, "// test stub\n", "utf8");
process.env.PI_CLI_PATH = FAKE_CLI;
// 假 wt.exe：真实文件 + .exe 后缀 ⇒ healthyLauncher 的静默元数据探针通过，绝不执行它
const FAKE_WT_DIR = join(TMP, "fakewt");
mkdirSync(FAKE_WT_DIR, { recursive: true });
const FAKE_WT = join(FAKE_WT_DIR, "wt.exe");
writeFileSync(FAKE_WT, "", "utf8");
const TFCONFIG = join(TMP, "tf-config.json");
process.env.PI_TRACE_FUSION_CONFIG = TFCONFIG;
delete process.env.PI_TAB_RUN_ID;
delete process.env.PI_SUBAGENT;
delete process.env.PI_SESSION_PROFILE;

// ── child_process 拦截 ────────────────────────────────────────────────
const ORIG_CP = { spawn: cp.spawn, spawnSync: cp.spawnSync, execFileSync: cp.execFileSync };
interface SpawnCapture { exe: string; args: string[]; env?: NodeJS.ProcessEnv; cwd?: string }
let spawnCapture: SpawnCapture[] = [];
function installCpStubs(): void {
	spawnCapture = [];
	(cp as unknown as { spawn: unknown }).spawn = ((exe: string, args: string[], o: { env?: NodeJS.ProcessEnv; cwd?: string }) => {
		spawnCapture.push({ exe, args, env: o?.env, cwd: o?.cwd });
		return { on() {}, unref() {}, pid: 4242 };
	}) as unknown;
	// 只 stub wt/where 探测；git 等一律透传（trace preflight 真跑 git）
	(cp as unknown as { spawnSync: unknown }).spawnSync = ((file: string, args: string[], o: unknown) => {
		const f = String(file ?? "").toLowerCase();
		if (f === "where" || f === "wt" || String((args ?? [])[0] ?? "").toLowerCase() === "wt.exe") {
			return { status: 0, stdout: "", stderr: "" };
		}
		return (ORIG_CP.spawnSync as unknown as (...a: unknown[]) => unknown)(file, args, o);
	}) as unknown;
	(cp as unknown as { execFileSync: unknown }).execFileSync = ((file: string, args: string[], o: { encoding?: string }) => {
		if (String(file ?? "").toLowerCase() === "where") {
			return o?.encoding ? `${FAKE_WT}\r\n` : Buffer.from(`${FAKE_WT}\r\n`);
		}
		return (ORIG_CP.execFileSync as unknown as (...a: unknown[]) => unknown)(file, args, o);
	}) as unknown;
	syncBuiltinESMExports();
}
function restoreCpStubs(): void {
	(cp as unknown as { spawn: unknown }).spawn = ORIG_CP.spawn;
	(cp as unknown as { spawnSync: unknown }).spawnSync = ORIG_CP.spawnSync;
	(cp as unknown as { execFileSync: unknown }).execFileSync = ORIG_CP.execFileSync;
	syncBuiltinESMExports();
}

// ── 计数与断言工具 ────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures: string[] = [];
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
	try {
		await fn();
		passed++;
		console.log(`  ✓ ${name}`);
	} catch (e) {
		failed++;
		failures.push(name);
		console.error(`  ✗ ${name}`);
		console.error(`    ${String((e as Error)?.message ?? e).split("\n").slice(0, 6).join("\n    ")}`);
	}
}

// ── 临时 git 仓（tool 用 process.cwd() 作 repoRoot）─────────────────────
function g(args: string[], cwd: string): void {
	const r = (ORIG_CP as unknown as { spawnSync: typeof cp.spawnSync }).spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		input: "msg\n",
		windowsHide: true,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
		},
	});
	if ((r.status ?? -1) !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}
const REPO = join(TMP, "repo");
mkdirSync(REPO, { recursive: true });
g(["init", "-b", "main"], REPO);
writeFileSync(join(REPO, "a.txt"), "v1\n", "utf8");
g(["add", "-A"], REPO);
g(["commit", "-m", "init"], REPO);

// ── 模型 catalog（等价 ctx.modelRegistry.getAvailable()）──────────────
const CATALOG = [
	{ provider: "opencodego", id: "deepseek-v4.1-flash" },
	{ provider: "local-qwen38", id: "medium" },
	{ provider: "Zhipu", id: "glm-5.3" },
	{ provider: "xingchen", id: "gpt-5.6-luna" },
	{ provider: "shuai", id: "gpt-6.1-sol" },
];

interface FakePi {
	tools: Map<string, { name: string; execute: (...a: unknown[]) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> }>;
	commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
}
function makeFakePi(): { pi: FakePi; fake: unknown } {
	const pi: FakePi = { tools: new Map(), commands: new Map() };
	const fake = {
		registerTool(t: { name: string }) { pi.tools.set(t.name, t as never); },
		registerCommand(n: string, o: { handler: (a: string, c: unknown) => Promise<void> }) { pi.commands.set(n, o as never); },
		registerFlag() {},
		on() {},
		getFlag() { return ""; },
		sendUserMessage() {}, sendMessage() {}, exec() {},
	};
	return { pi, fake };
}

let CASES_DIR = join(TMP, "case-0");
function useCase(tag: string, tfConfig: Record<string, unknown> = {}): { runsDir: string } {
	CASES_DIR = join(TMP, `case-${tag}`);
	const runsDir = join(CASES_DIR, "trace-runs");
	mkdirSync(runsDir, { recursive: true });
	process.env.PI_TRACE_FUSION_RUNS_DIR = runsDir;
	// 每个用例只看自己产的账本：tab-runs 目录跨用例共享，先清空（只有本测试进程写它）
	rmSync(join(AGENT_DIR, "tab-runs"), { recursive: true, force: true });
	writeFileSync(TFCONFIG, JSON.stringify(tfConfig) + "\n", "utf8");
	return { runsDir };
}

function ctxFor(opts: { available?: typeof CATALOG; sessionId?: string; cwd?: string } = {}): unknown {
	return {
		cwd: opts.cwd ?? REPO,
		sessionManager: { sessionId: opts.sessionId ?? "sid-main" },
		modelRegistry: { getAvailable: () => opts.available ?? CATALOG },
		ui: { notify() {}, select: async () => undefined },
	};
}

function spawnArgv(): string[][] {
	return spawnCapture.map((c) => c.args);
}
/** 抽 `--model <v>`（wt → pi 的 argv 里 piArgs 段）。 */
function modelsInSpawns(): Array<string | undefined> {
	return spawnArgv().map((args) => {
		const i = args.indexOf("--model");
		return i >= 0 ? args[i + 1] : undefined;
	});
}
function dispatchRecords(runsDir: string): Array<{ requestedModel?: string; cwd?: string; taskId?: string }> {
	const tabRunsDir = join(AGENT_DIR, "tab-runs");
	if (!existsSync(tabRunsDir)) return [];
	const out: Array<{ requestedModel?: string; cwd?: string; taskId?: string }> = [];
	for (const f of readdirSync(tabRunsDir)) {
		if (!f.endsWith(".json")) continue;
		try {
			const rec = JSON.parse(readFileSync(join(tabRunsDir, f), "utf8")) as { requestedModel?: string; cwd?: string; taskId?: string; mode?: string };
			if (rec) out.push(rec);
		} catch { /* 坏文件跳过 */ }
	}
	void runsDir;
	return out;
}

// ── 主流程 ────────────────────────────────────────────────────────────
(async () => {
	const { pi, fake } = makeFakePi();
	installCpStubs();
	const savedCwd = process.cwd();
	const mod = await import("./index.ts");
	await (mod.default as (p: unknown) => Promise<void>)(fake);
	process.chdir(REPO);

	const tool = pi.tools.get("trace-fusion");
	assert.ok(tool, "trace-fusion 工具必须已注册（真实 factory）");

	console.log("① per-call model");

	await check("M1 省略 model ⇒ 无 --model（3 lane 默认，config 无 workerModel）", async () => {
		installCpStubs();
		useCase("m1", {});
		const r = await tool!.execute("", { task: "诊断 flaky 测试" }, undefined, undefined, ctxFor());
		assert.equal(r.isError, undefined, `不应报错：${r.content?.[0]?.text}`);
		assert.equal(spawnCapture.length, 3, "默认三 lane");
		assert.deepEqual(modelsInSpawns(), [undefined, undefined, undefined], "省略 model ⇒ 不得传 --model");
		const recs = dispatchRecords("");
		assert.equal(recs.length, 3, "三份 dispatch 账本");
		for (const d of recs) assert.equal(d.requestedModel, undefined, "config 无 workerModel ⇒ requestedModel 为空");
	});

	await check("M2 canonical model 生效（账本 + spawn 同源）", async () => {
		installCpStubs();
		useCase("m2", {});
		const r = await tool!.execute("", { task: "x", model: "Zhipu/glm-5.3" }, undefined, undefined, ctxFor());
		assert.equal(r.isError, undefined, `不应报错：${r.content?.[0]?.text}`);
		assert.equal(spawnCapture.length, 3);
		assert.deepEqual(modelsInSpawns(), ["Zhipu/glm-5.3", "Zhipu/glm-5.3", "Zhipu/glm-5.3"]);
		for (const d of dispatchRecords("")) assert.equal(d.requestedModel, "Zhipu/glm-5.3", "账本 requestedModel 同源");
	});

	await check("M3 大小写变体 ⇒ 归一为 registry canonical 拼写", async () => {
		installCpStubs();
		useCase("m3", {});
		const r = await tool!.execute("", { task: "x", model: "opencodego/DeepSeek-V4.1-Flash" }, undefined, undefined, ctxFor());
		assert.equal(r.isError, undefined, `不应报错：${r.content?.[0]?.text}`);
		assert.deepEqual(modelsInSpawns(), ["opencodego/deepseek-v4.1-flash", "opencodego/deepseek-v4.1-flash", "opencodego/deepseek-v4.1-flash"]);
	});

	await check("M4 短名唯一命中 ⇒ provider/id", async () => {
		installCpStubs();
		useCase("m4", {});
		const r = await tool!.execute("", { task: "x", model: "medium" }, undefined, undefined, ctxFor());
		assert.equal(r.isError, undefined, `不应报错：${r.content?.[0]?.text}`);
		assert.deepEqual(modelsInSpawns(), ["local-qwen38/medium", "local-qwen38/medium", "local-qwen38/medium"]);
	});

	await check("M5 短名歧义 ⇒ isError 且零 spawn", async () => {
		installCpStubs();
		useCase("m5", {});
		const dup = [...CATALOG, { provider: "other", id: "medium" }];
		const r = await tool!.execute("", { task: "x", model: "medium" }, undefined, undefined, ctxFor({ available: dup }));
		assert.equal(r.isError, true);
		assert.match(r.content[0].text, /歧义/);
		assert.equal(spawnCapture.length, 0, "零 spawn");
	});

	await check("M6 registry 为空 ⇒ 「无法校验」fail-closed，零 spawn", async () => {
		installCpStubs();
		useCase("m6", {});
		const r = await tool!.execute("", { task: "x", model: "Zhipu/glm-5.3" }, undefined, undefined, ctxFor({ available: [] }));
		assert.equal(r.isError, true);
		assert.match(r.content[0].text, /无法校验/);
		assert.equal(spawnCapture.length, 0);
	});

	await check("M7 非法短名 ⇒ isError「本会话不可用」，零 spawn", async () => {
		installCpStubs();
		useCase("m7", {});
		const r = await tool!.execute("", { task: "x", model: "no-such-model" }, undefined, undefined, ctxFor());
		assert.equal(r.isError, true);
		assert.match(r.content[0].text, /本会话不可用/);
		assert.equal(spawnCapture.length, 0);
	});

	await check("M8 cli: 外部后端 ⇒ isError，零 spawn", async () => {
		installCpStubs();
		useCase("m8", {});
		const r = await tool!.execute("", { task: "x", model: "cli:codex" }, undefined, undefined, ctxFor());
		assert.equal(r.isError, true);
		assert.match(r.content[0].text, /外部 CLI 后端/);
		assert.equal(spawnCapture.length, 0);
	});

	await check("M9 显式空串 ≠ 省略 ⇒ isError，零 spawn", async () => {
		installCpStubs();
		useCase("m9", {});
		const r = await tool!.execute("", { task: "x", model: "" }, undefined, undefined, ctxFor());
		assert.equal(r.isError, true);
		assert.match(r.content[0].text, /空串/);
		assert.equal(spawnCapture.length, 0);
	});

	await check("M10 config.workerModel（省略参数）仍生效且不被校验（向后兼容）", async () => {
		installCpStubs();
		useCase("m10", { traceFusionLoop: { workerModel: "not/a-real-model" } });
		const r = await tool!.execute("", { task: "x" }, undefined, undefined, ctxFor());
		assert.equal(r.isError, undefined, `旧 config 路径不得校验：${r.content?.[0]?.text}`);
		assert.deepEqual(modelsInSpawns(), ["not/a-real-model", "not/a-real-model", "not/a-real-model"]);
	});

	process.chdir(savedCwd);
	restoreCpStubs();

	console.log(`\n${passed} passed, ${failed} failed`);
	if (failed > 0) {
		console.error(`失败用例：${failures.join(" / ")}`);
		rmSync(TMP, { recursive: true, force: true });
		process.exit(1);
	}
	rmSync(TMP, { recursive: true, force: true });
})();
