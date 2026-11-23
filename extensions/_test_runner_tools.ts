/**
 * _test_runner_tools.ts — per-call 与角色工具 allowlist 契约测试（2026-11-13 优化计划）
 *
 * 锁定 runner-argv 的契约：
 *   1. 未传 tools（undefined）→ argv 完全不含 --tools（逐字节一致）
 *   2. 显式空列表 tools: [] → 追加 `--tools ""`（Windows argv 穿透激活零工具模式）
 *   3. 显式非空 tools: ["read", "bash"] → 追加 `--tools "read,bash"`，固定顺序在 --exclude-tools 之前
 *   4. excludeTools 叠加到默认防递归排他列表之后，合并为单个 --exclude-tools
 *   5. parseAgentTools：
 *      - undefined/null 保留为 undefined
 *      - 空字符串/空数组解析为 []（零工具上限）
 *      - 清洗空白与去重保序
 *      - 拒绝未知工具名（报错含角色与未知项）
 *      - 拒绝通配符（*）与修饰符（+/-）
 *   6. resolveEffectiveTools：
 *      - 两处都缺省 → undefined
 *      - 仅角色声明 → 采用角色上限
 *      - 仅调用方列表 → 采用调用方选择（支持 []）
 *      - 角色 + 调用方子集 → 采用调用方收窄结果
 *      - 角色 + 调用方越界 → 抛错拒绝越权
 *   7. 外部 CLI 后端 + 任何工具策略（非 undefined，包括 []）→ toolsSupportedForBackend = false
 */

import assert from "node:assert/strict";
import {
	buildPiArgv,
	DEFAULT_EXCLUDE_TOOLS,
	KNOWN_MANAGED_TOOLS,
	parseAgentTools,
	resolveEffectiveTools,
	toolsSupportedForBackend,
} from "./runner-argv.ts";

const CLI = "node";
const BASE_TASK = "Task: do something";

// ── 1. 未传 tools (undefined) → 无 --tools 旗标 ───────────────────
{
	const argv = buildPiArgv({ cliPath: CLI, task: "do something" });
	assert.equal(argv.includes("--tools"), false, "缺省时绝不能出现 --tools");
	assert.equal(argv[argv.length - 1], BASE_TASK, "task 恒为最后一个位置参数");
	assert.deepEqual(argv, [
		CLI,
		"--mode", "json", "--print", "--no-session",
		"--exclude-tools", "subagent-win,launch-tabs,set-timer,cancel-timer,list-timers,local-master-ensure",
		BASE_TASK,
	]);
	const exclIdx = argv.indexOf("--exclude-tools");
	assert.ok(exclIdx > 0);
	assert.equal(argv[exclIdx + 1], DEFAULT_EXCLUDE_TOOLS.join(","), "缺省排他列表与历史版本一致");
	assert.deepEqual(argv.slice(1, 5), ["--mode", "json", "--print", "--no-session"]);
}

// ── 2. 显式空列表 tools: [] → 单个 --tools "" 旗标 ────────────────
{
	const argv = buildPiArgv({ cliPath: CLI, task: "t", tools: [] });
	const i = argv.indexOf("--tools");
	assert.ok(i > 0, "显式空列表必须产生 --tools 旗标");
	assert.equal(argv[i + 1], "", "显式空列表必须编码为空字符串以穿过 argv 激活零工具模式");
	const e = argv.indexOf("--exclude-tools");
	assert.ok(i < e, "--tools 必须在 --exclude-tools 之前");
	assert.equal(argv.filter((x) => x === "--tools").length, 1);
}

// ── 3. 显式非空 tools → 单个 --tools <list> 旗标 ──────────────────
{
	const argv = buildPiArgv({ cliPath: CLI, task: "t", tools: ["read", "bash"] });
	const i = argv.indexOf("--tools");
	assert.ok(i > 0, "显式 tools 必须产生 --tools");
	assert.equal(argv[i + 1], "read,bash");
	const e = argv.indexOf("--exclude-tools");
	assert.ok(i < e, "--tools 必须在 --exclude-tools 之前");
	assert.equal(argv.filter((x) => x === "--tools").length, 1);
}

// ── 4. excludeTools 叠加 ─────────────────────────────────────────
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

// ── 5. parseAgentTools 解析与校验 ────────────────────────────────
{
	// 5.1 未声明
	assert.equal(parseAgentTools(undefined), undefined);
	assert.equal(parseAgentTools(null), undefined);

	// 5.2 显式空声明
	assert.deepEqual(parseAgentTools(""), []);
	assert.deepEqual(parseAgentTools("   "), []);
	assert.deepEqual(parseAgentTools([]), []);

	// 5.3 正常逗号分隔与去重保序
	assert.deepEqual(
		parseAgentTools("read, bash, write, edit, read"),
		["read", "bash", "write", "edit"],
	);
	assert.deepEqual(
		parseAgentTools(["read", " codegraph ", "wiki-nav", "read"]),
		["read", "codegraph", "wiki-nav"],
	);

	// 5.4 合法内置只读工具
	assert.deepEqual(
		parseAgentTools("read, grep, find, ls, codegraph"),
		["read", "grep", "find", "ls", "codegraph"],
	);

	// 5.5 未知工具名报错
	assert.throws(
		() => parseAgentTools("read, unknown_tool_xyz", "test-agent"),
		/\[agent:test-agent\] 未知受管工具名称 "unknown_tool_xyz"/,
	);

	// 5.6 通配符与修饰符报错
	assert.throws(
		() => parseAgentTools("read, *", "test-agent"),
		/\[agent:test-agent\] tools 声明不支持通配符模式 "\*"/,
	);
	assert.throws(
		() => parseAgentTools("+read, -bash", "test-agent"),
		/\[agent:test-agent\] tools 声明不支持修饰符 "\+read"/,
	);
}

// ── 6. resolveEffectiveTools 合并规则 ────────────────────────────
{
	// 6.1 两处都缺省
	assert.equal(resolveEffectiveTools(undefined, undefined), undefined);

	// 6.2 仅角色声明
	assert.deepEqual(resolveEffectiveTools(["read", "write"], undefined), ["read", "write"]);
	assert.deepEqual(resolveEffectiveTools([], undefined), []);

	// 6.3 仅调用方声明
	assert.deepEqual(resolveEffectiveTools(undefined, ["read", "bash"]), ["read", "bash"]);
	assert.deepEqual(resolveEffectiveTools(undefined, []), []);

	// 6.4 角色上限 + 调用方合法子集
	assert.deepEqual(
		resolveEffectiveTools(["read", "write", "edit", "codegraph"], ["read", "codegraph"]),
		["read", "codegraph"],
	);
	// 允许调用方进一步收窄为零工具 []
	assert.deepEqual(
		resolveEffectiveTools(["read", "write"], []),
		[],
	);

	// 6.5 角色上限 + 调用方越界扩权 → 拒绝
	assert.throws(
		() => resolveEffectiveTools(["read", "write"], ["read", "bash"], "planner"),
		/\[agent:planner\] 调用方请求的工具 \[bash\] 超出角色声明的工具上限 \[read, write\]，禁止越界扩权/,
	);
}

// ── 7. 外部 CLI 后端 + 工具策略（2026-11-18 业主裁决「tool 声明豁免第三方 CLI」）───
{
	// 7.1 角色 frontmatter 声明（callerTools === undefined）⇒ 对 cli:* **豁免**
	assert.equal(
		toolsSupportedForBackend("cli:codex", ["read", "grep"]),
		true,
		"角色 frontmatter 的 tools: 必须豁免（否则任何声明 tools 的角色永远无法走 cli:*）",
	);
	assert.equal(toolsSupportedForBackend("cli:claude", ["read"]), true, "同上，单元素角色声明也豁免");
	assert.equal(toolsSupportedForBackend("CLI:CODEX", ["read"]), true, "大写亦适用豁免（与 isExternalCliModel 同归一）");
	assert.equal(toolsSupportedForBackend("  cli:codex  ", ["read"]), true, "前后空白亦适用豁免");

	// 7.2 调用方显式策略（callerTools !== undefined）⇒ cli:* **仍然拒**（含显式空列表）
	assert.equal(
		toolsSupportedForBackend("cli:codex", ["read"], ["read"]),
		false,
		"调用方显式 tools 是真实约束，CLI 保证不了 ⇒ 必须拒（不得静默放宽）",
	);
	assert.equal(toolsSupportedForBackend("cli:codex", [], []), false, "显式空列表 [] 也是调用方意图 ⇒ 拒");
	assert.equal(toolsSupportedForBackend("cli:zcode", ["read"], []), false, "空 caller 列表同样拒");
	assert.equal(toolsSupportedForBackend("CLI:CLAUDE", ["read"], ["read"]), false, "大写写法也必须拦截");
	assert.equal(toolsSupportedForBackend("  cli:codex  ", ["read", "bash"], ["read"]), false, "前后空白也必须拦截");

	// 7.3 effectiveTools 为 undefined（角色也未声明）⇒ 恒支持
	assert.equal(toolsSupportedForBackend("cli:agy", undefined), true, "未传 tools 时外部 CLI 照常工作");

	// 7.4 正常 provider/id 模型支持任何策略
	assert.equal(toolsSupportedForBackend("Zhipu/glm-5.2", ["read", "bash"]), true);
	assert.equal(toolsSupportedForBackend("Zhipu/glm-5.2", [], []), true);
	assert.equal(toolsSupportedForBackend(undefined, ["read"], ["read"]), true, "无模型（pi default）支持");

	// 7.5 变异控制：若把豁免反向改回「一律拒」，上面 7.1 的四条必须变红
	assert.notEqual(
		toolsSupportedForBackend("cli:codex", ["read"]) ,
		toolsSupportedForBackend("cli:codex", ["read"], ["read"]),
		"豁免分支与拒绝分支必须可区分（防恒真/恒假）",
	);
}

// ── 8. 清洗：空白项剔除 / 去重保序 ──────────────────────────────
{
	const argv = buildPiArgv({
		cliPath: CLI,
		task: "t",
		tools: ["read", "  ", "bash", "read", " bash "],
		excludeTools: ["wiki-nav", "wiki-nav"],
	});
	const i = argv.indexOf("--tools");
	assert.equal(argv[i + 1], "read,bash", "空白剔除 + 去重保序");
	const e = argv.indexOf("--exclude-tools");
	assert.equal(argv[e + 1], [...DEFAULT_EXCLUDE_TOOLS, "wiki-nav"].join(","));
}

console.log("runner-tools tests passed");
