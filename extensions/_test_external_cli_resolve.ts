/**
 * _test_external_cli_resolve.ts — 外部 CLI「真实入口解析」契约测试（2026-11-16）
 *
 * 背景（本机实测事故，见 plans/20261116_cli_codex_param_passing.md）：
 *   Windows 上 npm 全局包只有 `.cmd` shim，Node ≥18.20.2 拒绝 `.cmd + shell:false`（EINVAL）
 *   ⇒ 旧实现只能 `shell:true` ⇒ cmd.exe 重解析参数：
 *        真换行 → 字面 `\n`；`C:\Users\x` → `C:\\Users\\x`；**`%PATH%` → 整条 PATH 注入**；引号被吞。
 *   且 nvm 切到未装该 CLI 的版本后，旧实现回落裸名 spawn ⇒ 静默 ENOENT（无法归因）。
 *
 * 锁定四件事：
 *   1. `parseShimEntryCandidates` 解析三类真实 shim 形状（npm cmd-shim / pnpm / 无扩展名 bin），
 *      且**永不**把解释器自身（node.exe / %_prog% / 未展开变量）当入口。
 *   2. `resolveSpawnShell` 缺省语义保持历史（.cmd ⇒ true），但解析到真入口后生产路径恒传 false。
 *   3. `resolveExternalSpawnTarget` 的失败形态**明确**（不回落裸名），区分三种 error。
 *   4. nvm 兜底：PATH 查不到时仍能从 `NVM_HOME\v<ver>` / `%APPDATA%\npm` 找到（不被 nvm 切版本打死）。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	expandShimPaths,
	parseShimEntryCandidates,
	resolveExternalSpawnTarget,
	resolveSpawnShell,
	windowsFallbackDirs,
} from "./external-cli-resolve.ts";

const NODE = "C:\\nvm4w\\nodejs\\node.exe"; // 任意绝对路径（测试只断言形状，不真的 spawn 它）

// 本机实测的 npm cmd-shim 原文（codex.cmd）
const NPM_SHIM_TEXT = [
	"@ECHO off",
	"GOTO start",
	":find_dp0",
	"SET dp0=%~dp0",
	"EXIT /b",
	":start",
	"SETLOCAL",
	"CALL :find_dp0",
	'IF EXIST "%dp0%\\node.exe" (',
	'  SET "_prog=%dp0%\\node.exe"',
	") ELSE (",
	"  SET _prog=node",
	"  SET PATHEXT=%PATHEXT:;.JS;=;%",
	")",
	'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
].join("\r\n");

// ── 1. shim 路径变量展开 + 候选解析 ──────────────────────────────────────
{
	const shim = "C:\\nvm4w\\nodejs\\codex.cmd";
	const expanded = expandShimPaths(NPM_SHIM_TEXT, "C:\\nvm4w\\nodejs");
	assert.equal(expanded.includes("%~dp0"), false, "%~dp0 必须被展开");
	assert.equal(expanded.includes("%dp0%"), false, "%dp0% 必须被展开");
	assert.ok(
		expanded.includes("C:\\nvm4w\\nodejs\\node_modules\\@openai\\codex\\bin\\codex.js"),
		"入口路径必须被展开成绝对路径",
	);
	assert.equal(expandShimPaths("\uFEFFabc", "C:\\x"), "abc", "UTF-8 BOM 必须被剥掉");

	const candidates = parseShimEntryCandidates(shim, NPM_SHIM_TEXT);
	assert.equal(
		candidates[0],
		"C:\\nvm4w\\nodejs\\node_modules\\@openai\\codex\\bin\\codex.js",
		`第一条候选必须是真入口，实际: ${candidates[0]}`,
	);
	// 反例自检：解释器自身 / 未展开变量绝不能成为候选
	assert.equal(
		candidates.some((c) => /node\.exe$/i.test(c)),
		false,
		"解释器 node.exe 不得被当作入口（否则 spawn node 自己）",
	);
	assert.equal(candidates.some((c) => c.includes("%")), false, "未展开的变量 token 不得被当作入口");
	console.log(`ok - npm cmd-shim 解析（候选 ${candidates.length} 条，首条=${candidates[0].split("\\").pop()}）`);
}

// ── 2. pnpm `$basedir` 形状 + 无扩展名 bin 入口 ───────────────────────────
{
	const pnpmShim = [
		'basedir=$(dirname "$(echo "$0" | sed \'s,\\\\,/,g\')")',
		'exec "$basedir/node"  "$basedir/../codex/bin/codex.js" "$@"',
	].join("\n");
	const pnpmPaths = parseShimEntryCandidates("C:\\pnpm\\codex.cmd", pnpmShim);
	assert.ok(
		pnpmPaths.some((c) => c.endsWith("codex.js") && c.includes("codex\\bin")),
		`pnpm $basedir 形状必须解析出 codex.js，实际: ${JSON.stringify(pnpmPaths)}`,
	);

	// cline 形状：入口是**无扩展名**脚本（node_modules/cline/bin/cline）
	const clineShim =
		'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\cline\\bin\\cline" %*';
	const clinePaths = parseShimEntryCandidates("C:\\nvm4w\\nodejs\\cline.cmd", clineShim);
	assert.ok(
		clinePaths.some((c) => c.endsWith("\\node_modules\\cline\\bin\\cline")),
		`无扩展名入口（node_modules 内）必须被保留，实际: ${JSON.stringify(clinePaths)}`,
	);

	// `.exe` 入口优先（能直接 spawn，无需 node）
	const exeShim = '"%dp0%\\bin\\tool.exe" %*';
	const exePaths = parseShimEntryCandidates("C:\\x\\tool.cmd", exeShim);
	assert.equal(exePaths[0], "C:\\x\\bin\\tool.exe", `.exe 入口必须排第一，实际: ${JSON.stringify(exePaths)}`);
	console.log("ok - pnpm $basedir / 无扩展名 bin / .exe 优先级");
}

// ── 3. shell 开关语义（缺省保留历史 + 显式优先）──────────────────────────
{
	assert.equal(resolveSpawnShell("C:\\x\\codex.cmd", undefined, "win32"), true, "缺省 .cmd ⇒ shell:true（历史行为，勿改）");
	assert.equal(resolveSpawnShell("C:\\x\\codex.bat", undefined, "win32"), true, "缺省 .bat ⇒ shell:true");
	assert.equal(resolveSpawnShell("C:\\x\\codex.exe", undefined, "win32"), false, "原生 exe ⇒ shell:false");
	assert.equal(resolveSpawnShell("/usr/local/bin/codex", undefined, "linux"), false, "非 Windows ⇒ 恒 false");
	assert.equal(resolveSpawnShell("C:\\x\\codex.cmd", false, "win32"), false, "★ 显式 false 必须覆盖（修复的生产形态）");
	assert.equal(resolveSpawnShell("C:\\x\\codex.exe", true, "win32"), true, "显式 true 也必须生效");
	console.log("ok - resolveSpawnShell 缺省/显式语义");
}

// ── 4. nvm 兜底目录清单（排序 / 去重 / 非法名剔除）──────────────────────
{
	const env = {
		NVM_SYMLINK: "C:\\nvm4w\\nodejs",
		NVM_HOME: "C:\\Users\\u\\AppData\\Local\\nvm",
		APPDATA: "C:\\Users\\u\\AppData\\Roaming",
		USERPROFILE: "C:\\Users\\u",
	} as NodeJS.ProcessEnv;
	const dirs = windowsFallbackDirs(env, () => ["v13.14.0", "v22.19.0", "v24.14.0", "v9.1.0", "not-a-version"]);
	const paths = dirs.map((d) => d.dir);
	assert.ok(paths.includes("C:\\nvm4w\\nodejs"), "nvm symlink 必须在兜底清单里");
	assert.ok(paths.includes("C:\\Users\\u\\AppData\\Roaming\\npm"), "%APPDATA%\\npm 必须在兜底清单里");
	assert.ok(paths.includes("C:\\Users\\u\\.local\\bin"), "~/.local/bin 必须在兜底清单里");
	assert.ok(paths.includes("C:\\Users\\u\\.bun\\bin"), "~/.bun/bin 必须在兜底清单里");
	const versionPaths = paths.filter((p) => /nvm\\v\d/.test(p));
	assert.deepEqual(
		versionPaths.map((p) => p.split("\\").pop()),
		["v24.14.0", "v22.19.0", "v13.14.0", "v9.1.0"],
		`版本目录必须降序且剔除非法名，实际: ${JSON.stringify(versionPaths)}`,
	);
	// 去重：symlink 恰好等于某个版本目录时不重复
	const dupEnv = { NVM_SYMLINK: "C:\\Users\\u\\AppData\\Local\\nvm\\v22.19.0", NVM_HOME: "C:\\Users\\u\\AppData\\Local\\nvm" } as NodeJS.ProcessEnv;
	const dup = windowsFallbackDirs(dupEnv, () => ["v22.19.0"]).map((d) => d.dir.toLowerCase());
	assert.equal(
		dup.filter((d) => d === "c:\\users\\u\\appdata\\local\\nvm\\v22.19.0").length,
		1,
		"同名目录必须去重",
	);
	console.log("ok - windowsFallbackDirs（symlink / npm / local-bin / bun / 版本降序 / 去重）");
}

// ── 5. 三种失败形态必须**明确**（绝不回落裸名）──────────────────────────
{
	// 5.1 完全没装
	const notInstalled = resolveExternalSpawnTarget("codex", {
		platform: "win32",
		env: { NVM_HOME: "C:\\nonexistent-nvm", APPDATA: "C:\\nonexistent-appdata" } as NodeJS.ProcessEnv,
		execPath: NODE,
		whereLookup: () => undefined,
		exists: () => false,
		readdir: () => [],
	});
	assert.equal(notInstalled.ok, false, "查不到 ⇒ 必须 ok:false（旧实现会回落裸名 codex ⇒ ENOENT 静默失败）");
	assert.ok(
		"error" in notInstalled && /CLI not found on PATH/.test(notInstalled.error),
		`error 必须明写「PATH 上找不到」，实际: ${"error" in notInstalled ? notInstalled.error : "(ok:true)"}`,
	);
	assert.ok(
		"error" in notInstalled && /PI_EXTERNAL_CLI_BIN_CODEX/.test(notInstalled.error),
		"error 必须给出可操作的 override 环境变量名",
	);

	// 5.2 装了但 shim 指向的入口不存在
	const brokenShim = resolveExternalSpawnTarget("codex", {
		platform: "win32",
		env: {} as NodeJS.ProcessEnv,
		execPath: NODE,
		whereLookup: (name) => (name === "codex.cmd" ? "C:\\nvm4w\\nodejs\\codex.cmd" : undefined),
		exists: (p) => p.toLowerCase().endsWith("codex.cmd"), // 只有 shim 自身存在
		readFile: () => 'xxx "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
		readdir: () => [],
	});
	assert.equal(brokenShim.ok, false, "shim 不可解析 ⇒ 必须 ok:false");
	assert.ok(
		"error" in brokenShim && /shim is unresolvable/.test(brokenShim.error),
		`error 必须明写 shim 不可解析，实际: ${"error" in brokenShim ? brokenShim.error : "(ok:true)"}`,
	);

	// 5.3 显式 override 指向不存在的路径
	const badOverride = resolveExternalSpawnTarget("codex", {
		platform: "win32",
		env: { PI_EXTERNAL_CLI_BIN_CODEX: "C:\\wrong\\path\\codex.exe" } as NodeJS.ProcessEnv,
		execPath: NODE,
		whereLookup: () => undefined,
		exists: () => false,
		readdir: () => [],
	});
	assert.equal(badOverride.ok, false);
	assert.ok(
		"error" in badOverride && /PI_EXTERNAL_CLI_BIN_CODEX points to a non-existent path/.test(badOverride.error),
		`override 失败文案必须点名环境变量，实际: ${"error" in badOverride ? badOverride.error : "(ok:true)"}`,
	);
	console.log("ok - 三种失败形态均明确报错（未安装 / shim 不可解析 / override 不存在），绝不回落裸名");
}

// ── 6. 成功形态：shim → `node <js>` + shell:false ────────────────────────
{
	const shimPath = "C:\\nvm4w\\nodejs\\codex.cmd";
	const entry = "C:\\nvm4w\\nodejs\\node_modules\\@openai\\codex\\bin\\codex.js";
	const ok = resolveExternalSpawnTarget("codex", {
		platform: "win32",
		env: {} as NodeJS.ProcessEnv,
		execPath: NODE,
		whereLookup: (name) => (name === "codex.cmd" ? shimPath : undefined),
		exists: (p) => p === shimPath || p.toLowerCase() === entry.toLowerCase(),
		readFile: () => NPM_SHIM_TEXT,
		readdir: () => [],
	});
	assert.equal(ok.ok, true, "shim 可解析 ⇒ 必须 ok:true");
	if (!ok.ok) throw new Error("unreachable");
	assert.equal(ok.target.kind, "shim-js", "shim 指向 js ⇒ kind=shim-js");
	assert.equal(ok.target.command, NODE, "command 必须是 node（不是 .cmd、不是裸名）");
	assert.deepEqual(ok.target.prefixArgs, [entry], "prefixArgs 必须恰好是解析出的 js 入口");
	// ★ 修复的核心断言
	assert.equal(ok.target.shell, false, "★ 解析到真入口后 shell 必须为 false（cmd 重解析是参数损坏根因）");
	assert.equal(ok.target.marker, entry, "marker 必须是真入口（kill 归属校验要能在命令行里找到它）");
	assert.equal(ok.target.marker.includes(".cmd"), false, "marker 不能是 .cmd（node 子进程命令行里不会出现它）");
	// 反例自检：若 shell 变回 true，上面的核心断言必须变红（已实测确认——见 plans 报告 §3.2）
	console.log("ok - shim→js 成功形态（command=node, prefixArgs=[js], shell=false, marker=js）");
}

// ── 7. 原生 exe 形态 ────────────────────────────────────────────────────
{
	const exe = "C:\\Users\\u\\.local\\bin\\claude.exe";
	const native = resolveExternalSpawnTarget("claude", {
		platform: "win32",
		env: {} as NodeJS.ProcessEnv,
		execPath: NODE,
		whereLookup: (name) => (name === "claude.exe" ? exe : undefined),
		exists: (p) => p.toLowerCase() === exe.toLowerCase(),
		readdir: () => [],
	});
	assert.equal(native.ok, true);
	if (!native.ok) throw new Error("unreachable");
	assert.equal(native.target.kind, "native");
	assert.equal(native.target.command, exe);
	assert.deepEqual(native.target.prefixArgs, []);
	assert.equal(native.target.shell, false);
	console.log("ok - 原生 exe 形态（shell:false, 空 prefixArgs）");
}

// ── 8. zcode Node 脚本形态 + 缺失报错 ──────────────────────────────────
{
	const script = "D:\\Software\\zcode\\resources\\glm\\zcode.cjs";
	const ok = resolveExternalSpawnTarget("zcode", {
		platform: "win32",
		env: { ZCODE_CJS: script } as NodeJS.ProcessEnv,
		execPath: NODE,
		exists: (p) => p === script,
		readdir: () => [],
		whereLookup: () => undefined,
	});
	assert.equal(ok.ok, true);
	if (!ok.ok) throw new Error("unreachable");
	assert.equal(ok.target.kind, "node-script");
	assert.equal(ok.target.command, NODE);
	assert.deepEqual(ok.target.prefixArgs, [script]);
	assert.equal(ok.target.shell, false);

	const missing = resolveExternalSpawnTarget("zcode", {
		platform: "win32",
		env: { ZCODE_CJS: "C:\\nope\\zcode.cjs" } as NodeJS.ProcessEnv,
		execPath: NODE,
		exists: () => false,
		readdir: () => [],
		whereLookup: () => undefined,
	});
	assert.equal(missing.ok, false);
	assert.ok("error" in missing && /script not found/.test(missing.error), "zcode 脚本缺失必须明写 script not found");
	console.log("ok - zcode Node 脚本形态与缺失报错");
}

// ── 9. nvm 兜底救回 + 反例对照（决定性）───────────────────────────────
{
	const shimPath = "C:\\Users\\u\\AppData\\Local\\nvm\\v22.19.0\\codex.cmd";
	const entry = "C:\\Users\\u\\AppData\\Local\\nvm\\v22.19.0\\node_modules\\@openai\\codex\\bin\\codex.js";
	const common = {
		platform: "win32" as const,
		execPath: NODE,
		whereLookup: () => undefined, // ← PATH 完全查不到（nvm 切到没装 codex 的版本的现场）
		exists: (p: string) => p === shimPath || p === entry,
		readFile: () => NPM_SHIM_TEXT,
		readdir: () => ["v22.19.0", "v24.14.0"], // v24 没装 codex，v22 有
	};
	const rescued = resolveExternalSpawnTarget("codex", {
		...common,
		env: {
			NVM_HOME: "C:\\Users\\u\\AppData\\Local\\nvm",
			NVM_SYMLINK: "C:\\nvm4w\\nodejs",
			APPDATA: "C:\\Users\\u\\AppData\\Roaming",
			USERPROFILE: "C:\\Users\\u",
		} as NodeJS.ProcessEnv,
	});
	assert.equal(rescued.ok, true, "PATH 全 miss 但 NVM_HOME 里有 ⇒ 必须救回（旧实现会裸名 ENOENT）");
	if (!rescued.ok) throw new Error("unreachable");
	assert.equal(rescued.target.command, NODE);
	assert.deepEqual(rescued.target.prefixArgs, [entry]);
	assert.equal(rescued.target.shell, false);
	assert.ok(
		rescued.target.via.includes("nvm-version"),
		`via 必须记下是从 nvm 版本目录救回的，实际: ${rescued.target.via}`,
	);

	// 反例对照：去掉 NVM_HOME ⇒ 必须失败（证明救回来自兜底目录而非碰巧）
	const noNvmHome = resolveExternalSpawnTarget("codex", {
		...common,
		env: { APPDATA: "C:\\nonexistent" } as NodeJS.ProcessEnv,
		readdir: () => [],
	});
	assert.equal(noNvmHome.ok, false, "去掉 NVM_HOME 后必须失败（反例对照）");
	console.log("ok - nvm 兜底救回 + 反例对照（去掉 NVM_HOME 即失败）");
}

// ── 10. model ref 形态 ──────────────────────────────────────────────────
{
	const { isExternalCliModel, parseExternalCliModel } = await import("./external-cli.ts");
	assert.deepEqual(parseExternalCliModel("cli:codex"), { backend: "codex", canonical: "cli:codex" });
	assert.deepEqual(parseExternalCliModel("CLI:Codex"), { backend: "codex", canonical: "cli:codex" });
	assert.equal(parseExternalCliModel("cli:codex/gpt-5.5"), null, "cli:codex/<model> 必须被拒绝（不替 CLI 选模型）");
	assert.equal(isExternalCliModel("codex"), false, "裸名 codex 不是外部 CLI ref（会被当 pi provider/id）");
	assert.equal(isExternalCliModel("codex.cmd"), false, "codex.cmd 也不是");
	console.log("ok - model ref 形态（cli:codex 有效；cli:codex/<model> 与裸名均不是）");
}

// ── 11. 生产缓存解析：本机 codex 必须被解析成 `node <js>` + shell:false ──
{
	const { resolveSpawnTargetCached, isBackendResolved } = await import("./external-cli.ts");
	const cached = resolveSpawnTargetCached("codex");
	assert.ok(
		"command" in cached,
		`生产缓存解析必须给出可用目标，实际: ${JSON.stringify(cached).slice(0, 240)}`,
	);
	if (!("command" in cached)) throw new Error("unreachable");
	// ★ 生产形态断言（本机 PATH 上只有 .cmd shim ⇒ 必须被转换成 node + js）
	assert.equal(cached.shell, false, "★ 生产解析结果必须 shell:false");
	assert.equal(
		cached.command.toLowerCase(),
		process.execPath.toLowerCase(),
		"★ 生产解析必须用 node 启动（而非 .cmd）",
	);
	assert.ok(
		cached.prefixArgs.length >= 1 && /codex\.js$/i.test(cached.prefixArgs[0]),
		`prefixArgs[0] 必须指向 codex.js，实际: ${JSON.stringify(cached.prefixArgs)}`,
	);
	assert.equal(isBackendResolved("codex"), true);
	console.log(`ok - 生产缓存解析（kind=${cached.kind}, via=${cached.via}）`);
}

// ── 12. spawnStreaming 显式 marker 生效（kill 归属校验依赖它）─────────────
{
	const { spawnStreaming } = await import("./external-cli.ts");
	const dir = mkdtempSync(join(tmpdir(), "cli-resolve-"));
	const script = join(dir, "echo.cjs");
	writeFileSync(script, 'process.stdout.write("MARKER_OK" + String.fromCharCode(10));');
	try {
		let seen: { pid: number; marker: string } | undefined;
		const out = await spawnStreaming({
			backend: "atomcode",
			command: process.execPath,
			args: [script],
			shell: false,
			marker: "PARAM-MARKER-STRING",
			cwd: dir,
			captureStdout: true,
			timeoutMs: 20_000,
			onChildSpawn: (info) => { seen = info; },
		});
		assert.ok(out.stdout.includes("MARKER_OK"), "子进程必须真的跑起来（shell:false 可用）");
		assert.ok(seen && seen.pid > 0, "onChildSpawn 必须被调用并带 pid");
		assert.equal(seen?.marker, "PARAM-MARKER-STRING", "显式 marker 必须生效（不再是 command）");
		console.log("ok - spawnStreaming 显式 marker 生效 + shell:false 真能跑");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

console.log("external-cli-resolve tests passed");
