/**
 * _test_runner_tools.ts — per-call tools allowlist 测试（trace-fusion C2 / P2 修订）
 *
 * 锁定 runner-argv.buildPiArgv 的契约：
 *   1. 未显式传 tools → argv 完全不含 --tools（与历史行为逐字节一致，零回归）
 *   2. 显式传 tools → 单个 `--tools <list>` 旗标，顺序固定
 *   3. excludeTools 叠加到默认防递归排他列表之后，合并为单个 --exclude-tools
 *   4. agent frontmatter tools 不是硬约束来源（解析展示但不进 argv）
 *   5. 外部 CLI 后端 + 显式 tools → toolsSupportedForBackend = false（快速失败路径）
 *   6. 空白项清洗 / 去重 / 空数组不生效
 */

import assert from "node:assert/strict";
import { buildPiArgv, DEFAULT_EXCLUDE_TOOLS, toolsSupportedForBackend } from "./runner-argv.ts";

const CLI = "node";
const BASE_TASK = "Task: do something";

// ── 1. 未传 tools → 无 --tools 旗标（P2 核心承诺：argv 逐字节一致）────
{
	const argv = buildPiArgv({ cliPath: CLI, task: "do something" });
	assert.equal(argv.includes("--tools"), false, "缺省时绝不能出现 --tools");
	assert.equal(argv[argv.length - 1], BASE_TASK, "task 恒为最后一个位置参数");
	// review 修正（Luna minor）：golden deepEqual 锁死完整 argv，防任何字段/顺序漂移
	assert.deepEqual(argv, [
		CLI,
		"--mode", "json", "--print", "--no-session",
		"--exclude-tools", "subagent-win,launch-tabs,set-timer,cancel-timer,list-timers",
		BASE_TASK,
	]);
	// 全字段变体也锁死（与抽取前 runSingle 的拼装顺序逐项一致）
	assert.deepEqual(
		buildPiArgv({
			cliPath: CLI, task: "do something",
			model: "Zhipu/glm-5.2", thinking: "high", systemPrompt: "You are a searcher.",
		}),
		[
			CLI,
			"--mode", "json", "--print", "--no-session",
			"--exclude-tools", "subagent-win,launch-tabs,set-timer,cancel-timer,list-timers",
			"--model", "Zhipu/glm-5.2",
			"--thinking", "high",
			"--append-system-prompt", "You are a searcher.",
			BASE_TASK,
		],
	);
	const exclIdx = argv.indexOf("--exclude-tools");
	assert.ok(exclIdx > 0);
	assert.equal(argv[exclIdx + 1], DEFAULT_EXCLUDE_TOOLS.join(","), "缺省排他列表与历史版本一致");
	// 旗标顺序：--mode/--print/--no-session → --exclude-tools → task
	assert.deepEqual(argv.slice(1, 5), ["--mode", "json", "--print", "--no-session"]);
}

// ── 2. 显式 tools → 单个 --tools 旗标 ─────────────────────────────
{
	const argv = buildPiArgv({ cliPath: CLI, task: "t", tools: ["read", "bash"] });
	const i = argv.indexOf("--tools");
	assert.ok(i > 0, "显式 tools 必须产生 --tools");
	assert.equal(argv[i + 1], "read,bash");
	// --tools 在 --exclude-tools 之前（固定顺序）
	const e = argv.indexOf("--exclude-tools");
	assert.ok(i < e, "--tools 必须在 --exclude-tools 之前");
	// 只出现一次
	assert.equal(argv.filter((x) => x === "--tools").length, 1);
}

// ── 3. excludeTools 叠加 ─────────────────────────────────────────
{
	const argv = buildPiArgv({ cliPath: CLI, task: "t", excludeTools: ["wiki-nav", "wiki-semantic"] });
	const e = argv.indexOf("--exclude-tools");
	assert.equal(
		argv[e + 1],
		[...DEFAULT_EXCLUDE_TOOLS, "wiki-nav", "wiki-semantic"].join(","),
		"额外排他必须叠加在默认防递归列表之后",
	);
	assert.equal(argv.filter((x) => x === "--exclude-tools").length, 1, "合并为单个 --exclude-tools");
}

// ── 4. agent frontmatter tools 不是硬约束来源 ─────────────────────
{
	// 模拟现有 agents/searcher.md 的 frontmatter（含不存在的工具名）：
	// P2 修订后 frontmatter 只做展示；只有 call-site tools 才进 argv。
	const agentFrontmatterTools = ["read", "grep", "find", "ls", "bash", "write", "edit", "wiki-nav"];
	const argv = buildPiArgv({
		cliPath: CLI,
		task: "t",
		tools: agentFrontmatterTools, // 模拟「如果误把 frontmatter 当 call-site 传入」
	});
	const i = argv.indexOf("--tools");
	// 即便传入也要被清洗：不存在的工具名不会被抓到 argv 里（清洗只去空白，不改名——
	// frontmatter 不激活的真正防线在 index.ts 不读取它；此处锁定清洗语义）
	assert.equal(argv[i + 1], agentFrontmatterTools.join(","));
	// 真正的契约：调用方不传 tools 时，frontmatter 无路径进入 argv（见用例 1）。
}

// ── 5. 外部 CLI 后端 + 显式 tools → 不支持 ─────────────────────────
{
	assert.equal(toolsSupportedForBackend("cli:claude", ["read"]), false, "cli:* 后端必须拒绝显式 tools");
	assert.equal(toolsSupportedForBackend("cli:codex", ["read", "bash"]), false);
	assert.equal(toolsSupportedForBackend("cli:agy", undefined), true, "未传 tools 时外部 CLI 照常工作");
	assert.equal(toolsSupportedForBackend("cli:zcode", []), true, "空数组 = 未传");
	// review 修正（Luna minor）：大小写/空白归一，与 isExternalCliModel 行为一致
	assert.equal(toolsSupportedForBackend("CLI:CLAUDE", ["read"]), false, "大写写法也必须拦截");
	assert.equal(toolsSupportedForBackend("  cli:codex  ", ["read"]), false, "前后空白也必须拦截");
	assert.equal(toolsSupportedForBackend("Zhipu/glm-5.2", ["read", "bash"]), true, "正常 provider/id 支持");
	assert.equal(toolsSupportedForBackend(undefined, ["read"]), true, "无模型（pi default）支持");
}

// ── 6. 清洗：空白项剔除 / 去重保序 / 空数组不生效 ──────────────────
{
	const argv = buildPiArgv({ cliPath: CLI, task: "t", tools: ["read", "  ", "bash", "read", " bash "], excludeTools: ["wiki-nav", "wiki-nav"] });
	const i = argv.indexOf("--tools");
	assert.equal(argv[i + 1], "read,bash", "空白剔除 + 去重保序");
	const e = argv.indexOf("--exclude-tools");
	assert.equal(argv[e + 1], [...DEFAULT_EXCLUDE_TOOLS, "wiki-nav"].join(","));
	const none = buildPiArgv({ cliPath: CLI, task: "t", tools: [] });
	assert.equal(none.includes("--tools"), false, "空数组视为未传");
}

// ── 7. model/thinking/systemPrompt 旗标仍在 ────────────────────────
{
	const argv = buildPiArgv({
		cliPath: CLI, task: "t", model: "Zhipu/glm-5.2", thinking: "high",
		systemPrompt: "You are a searcher.", tools: ["read", "bash"],
	});
	assert.deepEqual(
		argv.filter((x) => x === "--model" || x === "--thinking" || x === "--append-system-prompt"),
		["--model", "--thinking", "--append-system-prompt"],
	);
	const mi = argv.indexOf("--model");
	assert.equal(argv[mi + 1], "Zhipu/glm-5.2");
	const si = argv.indexOf("--append-system-prompt");
	assert.equal(argv[si + 1], "You are a searcher.");
}

console.log("runner-tools tests passed");
