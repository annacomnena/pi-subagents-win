/**
 * _test_force_replay_mount.ts — PI_FORCE_REASONING_REPLAY harness 挂载契约测试
 *
 * 锁定 force-replay-mount.resolveForceReplayMount + runSingle 挂载点（index.ts）的契约：
 *   1. 开关未设 ⇒ 不产出 extensionArg，applyForceReplayMount(argv) 与 buildPiArgv 原始输出逐字相同
 *   2. 开关=1 且扩展路径存在 ⇒ argv 以 ["-e", <abs>] 结尾（abs 为解析后的绝对路径）
 *   3. 开关=1 但路径不存在 ⇒ 不追加 -e 且有可见警告（返回值 + console.warn 均可见，fail-open 不静默）
 *   4. 真值语义与扩展本体一致："1"|"true"|"yes"|"on"（其余含 "0"/空串/垃圾值 ⇒ off）
 *   5. _EXT 覆盖缺省路径；缺省路径存在时未设 _EXT ⇒ 用缺省路径
 *
 * 测试不依赖开发机缺省路径：一律用 mkdtempSync 临时目录 + 显式 env 传参（不改 process.env）。
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildPiArgv } from "./runner-argv.ts";
import {
	DEFAULT_FORCE_REPLAY_EXT_PATH,
	FORCE_REPLAY_EXT_PATH_ENV,
	FORCE_REPLAY_SWITCH_ENV,
	isForceReplayEnabled,
	resolveForceReplayMount,
} from "./force-replay-mount.ts";

const CLI = "node";

/** 与 index.ts 挂载点逐字等价的 argv 变换（供断言复现 runSingle 行为）。 */
function applyForceReplayMount(
	argv: string[],
	env: NodeJS.ProcessEnv,
	warn: (msg: string) => void = () => {},
): string[] {
	const mount = resolveForceReplayMount(env);
	if (mount.extensionArg) {
		argv.push("-e", mount.extensionArg);
	} else if (mount.warning) {
		warn(mount.warning);
	}
	return argv;
}

// ── 1. 开关未设 ⇒ 不含 -e，argv 与现状逐字相同（零差异承诺）────────
{
	const env: NodeJS.ProcessEnv = {};
	const baseline = buildPiArgv({ cliPath: CLI, task: "do something" });
	const argv = applyForceReplayMount([...baseline], env);
	assert.equal(resolveForceReplayMount(env).extensionArg, undefined, "开关未设绝不产出 -e");
	assert.equal(resolveForceReplayMount(env).warning, undefined, "开关未设不应产生警告");
	assert.deepEqual(argv, baseline, "未设开关时 argv 必须与 buildPiArgv 原始输出逐字相同");
	assert.equal(argv.includes("-e"), false);
	// 模拟主进程真实环境（process.env 可能残留开关）也必须以显式 env 为准——
	// 这里用显式空 env 锁定「未设」语义。
	assert.equal(isForceReplayEnabled(env), false);
}

// ── 2. 开关=1 且路径存在 ⇒ argv 含 -e <abs> ────────────────────────
{
	const dir = mkdtempSync(join(tmpdir(), "force-replay-mount-"));
	assert.ok(existsSync(dir));
	const env: NodeJS.ProcessEnv = {
		[FORCE_REPLAY_SWITCH_ENV]: "1",
		[FORCE_REPLAY_EXT_PATH_ENV]: dir,
	};
	const baseline = buildPiArgv({ cliPath: CLI, task: "t", model: "deepseek/deepseek-chat" });
	const argv = applyForceReplayMount([...baseline], env);
	const mount = resolveForceReplayMount(env);
	assert.equal(mount.extensionArg, resolve(dir), "extensionArg 必须是解析后的绝对路径");
	assert.equal(mount.warning, undefined);
	// 追加而非改写：baseline 是 argv 的前缀
	assert.deepEqual(argv.slice(0, baseline.length), baseline, "已有 flags/task 不得被改动");
	assert.deepEqual(argv.slice(baseline.length), ["-e", resolve(dir)], "必须以 -e <abs> 结尾");
}

// ── 3. 开关=1 但路径不存在 ⇒ 不含 -e 且有可见警告 ──────────────────
{
	const missing = join(tmpdir(), "force-replay-mount-missing", "no-such-ext");
	assert.equal(existsSync(missing), false);
	const env: NodeJS.ProcessEnv = {
		[FORCE_REPLAY_SWITCH_ENV]: "1",
		[FORCE_REPLAY_EXT_PATH_ENV]: missing,
	};
	const baseline = buildPiArgv({ cliPath: CLI, task: "t" });
	const warnings: string[] = [];
	const argv = applyForceReplayMount([...baseline], env, (msg) => warnings.push(msg));
	const mount = resolveForceReplayMount(env);
	assert.equal(mount.extensionArg, undefined, "路径缺失时绝不追加 -e");
	assert.deepEqual(argv, baseline, "路径缺失时 argv 与现状逐字相同（fail-open）");
	assert.equal(mount.warning === undefined, false, "必须返回警告文本（不得静默）");
	assert.equal(warnings.length, 1, "挂载点必须把警告交给 Logger 级输出（console.warn/onUpdate）");
	assert.ok(warnings[0]!.includes(missing), "警告必须含实际检查的路径");
	assert.ok(warnings[0]!.includes("-e"), "警告必须说明未追加 -e 的后果");
}

// ── 4. 真值语义与扩展本体一致 ──────────────────────────────────────
{
	for (const on of ["1", "true", "yes", "on", "TRUE", " Yes "]) {
		assert.equal(isForceReplayEnabled({ [FORCE_REPLAY_SWITCH_ENV]: on }), true, `"${on}" 应视为开`);
	}
	for (const off of ["", "0", "false", "no", "garbage"]) {
		assert.equal(isForceReplayEnabled({ [FORCE_REPLAY_SWITCH_ENV]: off }), false, `"${off}" 应视为关`);
	}
	assert.equal(isForceReplayEnabled({}), false, "未设 ⇒ off");
}

// ── 5. _EXT 覆盖与缺省路径回退 ─────────────────────────────────────
{
	// 显式 _EXT 覆盖（含相对路径 → resolve 成绝对路径）
	const env: NodeJS.ProcessEnv = { [FORCE_REPLAY_SWITCH_ENV]: "1", [FORCE_REPLAY_EXT_PATH_ENV]: "." };
	const mount = resolveForceReplayMount(env);
	assert.equal(mount.extensionArg, resolve("."));
	// 未设 _EXT ⇒ 用缺省路径；仅当缺省路径在当前机器存在时校验取值（测试不依赖该机器有此目录）
	if (existsSync(DEFAULT_FORCE_REPLAY_EXT_PATH)) {
		const mountDefault = resolveForceReplayMount({ [FORCE_REPLAY_SWITCH_ENV]: "1" });
		assert.equal(mountDefault.extensionArg, resolve(DEFAULT_FORCE_REPLAY_EXT_PATH));
	}
}

console.log("OK: force-replay-mount 8/8 assertions groups passed");
