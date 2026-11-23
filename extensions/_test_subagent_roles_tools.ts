/**
 * _test_subagent_roles_tools.ts — Phase 1 & Phase 2 角色工具矩阵与派发契约集成验收测试
 *
 * 验收目标（计划 §5）：
 * 1. 从真实角色文件（agents/*.md）经 discoverAgents 解析角色工具上限；
 * 2. 验证 8 个受管角色的工具上限严格匹配计划矩阵；并断言外部 CLI 专用角色 codex-runner
 *    **不声明 tools**（否则 effectiveTools 非 undefined ⇒ 派发层对 cli:* 一律拒，实测 tried=[]）；
 * 3. 普通派发 argv 生成：
 *    - planner 生成的 argv 包含 --tools read,grep,find,ls,write,edit,codegraph 且无 bash；
 *    - consultant 生成的 argv 包含 --tools read,grep,find,ls,codegraph 且无 write/edit/bash；
 *    - fusion 生成的 argv 包含 --tools read,write,bash；
 * 4. 调用方工具收窄与越界拦截：
 *    - 调用方传入角色上限的子集成功收窄；
 *    - 调用方传入空列表 [] 编码为 --tools "" 激活零活动工具；
 *    - 调用方传入超出角色上限的工具（如 planner 要求 bash）抛错拒绝越界；
 * 5. 外部 CLI 兼容性守卫：
 *    - 受工具限制的角色若主模型显式指定为外部 CLI（cli:*），立即返回结构化错误；
 *    - fallback 链中的外部 CLI 候选被跳过，并记录 EXTERNAL_CLI_TOOLS_UNSUPPORTED；
 * 6. headless fusion runner 路径：
 *    - 构造的 argv 正确带上 --tools read,write,bash 与 FUSION_EXCLUDE_TOOLS。
 */

import assert from "node:assert/strict";
import { discoverAgents, runWithFallback } from "./index.ts";
import { buildPiArgv, resolveEffectiveTools, toolsSupportedForBackend } from "./runner-argv.ts";
import { FUSION_EXCLUDE_TOOLS } from "./trace-fusion/fusion-dispatch.ts";

const CLI = "node";

// ── 1. 真实角色加载器验证 ──────────────────────────────────────────
const agents = discoverAgents();
const agentMap = new Map(agents.map((a) => [a.name, a]));
// 断言「受管 8 角色齐备」而不是「总数恰好 8」——新增角色（如外部 CLI 专用 codex-runner）
// 不应让这条契约断言变红；受管角色的存在性与工具矩阵才是被测对象。
const MANAGED_ROLES = ["searcher", "planner", "plan-reviewer", "implementer", "code-reviewer", "consultant", "general", "fusion"];
for (const role of MANAGED_ROLES) {
	assert.ok(agentMap.has(role), `必须发现受管角色 ${role}`);
}
assert.ok(agents.length >= MANAGED_ROLES.length, `角色总数不得少于受管角色数，实际 ${agents.length}`);

// 反向断言（2026-11-16）：codex-runner 是「外部 CLI 专用角色」，**必须**不声明 tools ——
// 否则 resolveEffectiveTools 会让 effectiveTools !== undefined ⇒ 派发层对 cli:* 一律拒（实测 tried=[]，未 spawn）。
assert.ok(agentMap.has("codex-runner"), "必须有 codex-runner（cli:* 的唯一可用逃生口）");
assert.equal(agentMap.get("codex-runner")?.tools, undefined, "codex-runner 绝不能声明 tools（声明了 cli:* 就派不出去）");

// ── 2. 核对八个角色的工具上限矩阵 ──────────────────────────────────
assert.deepEqual(agentMap.get("searcher")?.tools, [
	"read", "grep", "find", "ls", "bash", "write", "edit", "wiki-nav", "codegraph",
]);
assert.deepEqual(agentMap.get("planner")?.tools, [
	"read", "grep", "find", "ls", "write", "edit", "codegraph",
]);
assert.deepEqual(agentMap.get("plan-reviewer")?.tools, [
	"read", "grep", "find", "ls", "write", "edit", "codegraph",
]);
assert.deepEqual(agentMap.get("implementer")?.tools, [
	"read", "grep", "find", "ls", "bash", "write", "edit", "codegraph", "wiki-nav",
]);
assert.deepEqual(agentMap.get("code-reviewer")?.tools, [
	"read", "grep", "find", "ls", "bash", "write", "edit", "codegraph", "wiki-nav",
]);
assert.deepEqual(agentMap.get("consultant")?.tools, [
	"read", "grep", "find", "ls", "codegraph",
]);
assert.deepEqual(agentMap.get("general")?.tools, [
	"read", "grep", "find", "ls", "bash", "write", "edit", "codegraph", "wiki-nav",
]);
assert.deepEqual(agentMap.get("fusion")?.tools, [
	"read", "write", "bash",
]);

// ── 3. 普通派发 argv 生成断言 ─────────────────────────────────────
{
	// 3.1 planner：无 bash
	const planner = agentMap.get("planner")!;
	const effectivePlanner = resolveEffectiveTools(planner.tools, undefined, planner.name);
	const argvPlanner = buildPiArgv({ cliPath: CLI, task: "plan", tools: effectivePlanner });
	const pi = argvPlanner.indexOf("--tools");
	assert.ok(pi > 0, "planner 必须生成 --tools 旗标");
	assert.equal(argvPlanner[pi + 1], "read,grep,find,ls,write,edit,codegraph");
	assert.ok(!argvPlanner[pi + 1].split(",").includes("bash"), "planner 绝不能包含 bash 工具");

	// 3.2 consultant：无 write, edit, bash
	const consultant = agentMap.get("consultant")!;
	const effectiveConsultant = resolveEffectiveTools(consultant.tools, undefined, consultant.name);
	const argvConsultant = buildPiArgv({ cliPath: CLI, task: "consult", tools: effectiveConsultant });
	const ci = argvConsultant.indexOf("--tools");
	assert.ok(ci > 0, "consultant 必须生成 --tools 旗标");
	assert.equal(argvConsultant[ci + 1], "read,grep,find,ls,codegraph");
	const cTools = argvConsultant[ci + 1].split(",");
	assert.ok(!cTools.includes("write"), "consultant 绝不能包含 write");
	assert.ok(!cTools.includes("edit"), "consultant 绝不能包含 edit");
	assert.ok(!cTools.includes("bash"), "consultant 绝不能包含 bash");

	// 3.3 fusion：只读 + write + bash
	const fusion = agentMap.get("fusion")!;
	const effectiveFusion = resolveEffectiveTools(fusion.tools, undefined, fusion.name);
	const argvFusion = buildPiArgv({ cliPath: CLI, task: "fuse", tools: effectiveFusion });
	const fi = argvFusion.indexOf("--tools");
	assert.ok(fi > 0, "fusion 必须生成 --tools 旗标");
	assert.equal(argvFusion[fi + 1], "read,write,bash");
}

// ── 4. 调用方收窄与越界拦截 ────────────────────────────────────────
{
	const planner = agentMap.get("planner")!;
	// 4.1 合法子集收窄
	const narrowed = resolveEffectiveTools(planner.tools, ["read", "write"], planner.name);
	assert.deepEqual(narrowed, ["read", "write"]);
	const argvNarrowed = buildPiArgv({ cliPath: CLI, task: "t", tools: narrowed });
	const ni = argvNarrowed.indexOf("--tools");
	assert.equal(argvNarrowed[ni + 1], "read,write");

	// 4.2 显式空列表 [] → 零工具
	const empty = resolveEffectiveTools(planner.tools, [], planner.name);
	assert.deepEqual(empty, []);
	const argvEmpty = buildPiArgv({ cliPath: CLI, task: "t", tools: empty });
	const ei = argvEmpty.indexOf("--tools");
	assert.equal(argvEmpty[ei + 1], "", "零活动工具必须传空字符串参数");

	// 4.3 越界扩权拒绝（planner 试图请求 bash）
	assert.throws(
		() => resolveEffectiveTools(planner.tools, ["read", "bash"], planner.name),
		/\[agent:planner\] 调用方请求的工具 \[bash\] 超出角色声明的工具上限/,
	);
}

// ── 5. 外部 CLI 与 Fallback 守卫 ──────────────────────────────────
// 2026-11-18 业主裁决「tool 声明豁免第三方 CLI」后的口径：
//   角色 frontmatter 的 tools: ⇒ 豁免（会真的 spawn 真实 CLI，不能在这里测）
//   调用方显式 tools ⇒ 仍拒（快速失败，不 spawn）⇒ 本节全部走这一支
{
	const consultant = agentMap.get("consultant")!;
	// 5.1 调用方显式 tools + 外部 CLI 主模型 → 快速失败（不 spawn）
	const r1 = await runWithFallback(
		consultant,
		"evaluate something",
		undefined,
		"cli:claude",
		undefined,
		undefined,
		undefined,
		{ tools: ["read"] },
	);
	assert.equal(r1.status, "failed");
	assert.ok(
		r1.error?.includes("--tools allowlist is not supported for external CLI backend"),
		`错误信息应说明调用方工具策略不被外部 CLI 支持，收到: ${r1.error}`,
	);

	// 5.1b 显式空列表 [] 也是调用方策略 → 同样快速失败
	const r1b = await runWithFallback(
		consultant,
		"evaluate something",
		undefined,
		"cli:claude",
		undefined,
		undefined,
		undefined,
		{ tools: [] },
	);
	assert.equal(r1b.status, "failed", "显式空列表 [] 也属调用方策略，外部 CLI 必须拒");

	// 5.2 角色默认模型为外部 CLI + 调用方显式策略 ⇒ fallback 候选全被跳过，返回结构化失败
	const dummyAgent = {
		name: "dummy-restricted",
		body: "You are dummy",
		tools: ["read", "write"],
		frontmatterModel: "cli:codex",
	};
	const r2 = await runWithFallback(
		dummyAgent,
		"do something",
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		{ tools: ["read"] },
	);
	assert.equal(r2.status, "failed");
	assert.ok(
		r2.error?.includes("无兼容的候选模型") || r2.error?.includes("not supported"),
		`错误应反映无兼容候选，收到: ${r2.error}`,
	);
	assert.ok(
		r2.priorFailures?.some((p) => p.kind === "EXTERNAL_CLI_TOOLS_UNSUPPORTED"),
		"priorFailures 必须记录跳过的 EXTERNAL_CLI_TOOLS_UNSUPPORTED 候选",
	);
}

// ── 6. headless fusion 路径 argv 断言 ──────────────────────────────
{
	const { readFileSync } = await import("node:fs");
	const fusionSrc = readFileSync("extensions/trace-fusion/fusion-dispatch.ts", "utf8");
	assert.ok(/tools:\s*fusionTools/.test(fusionSrc), "fusion-dispatch 源码接线必须将 fusionTools 传入 buildPiArgv");

	const fusionTools = ["read", "write", "bash"];
	assert.equal(toolsSupportedForBackend("Zhipu/glm-5.2", fusionTools), true);
	// 2026-11-18 豁免后：fusion 的 fusionTools 是**调用方显式策略** ⇒ 第三参传入才能继续拦 cli:*
	assert.equal(
		toolsSupportedForBackend("cli:claude", fusionTools, fusionTools),
		false,
		"fusion runner 的 fusionTools 属调用方策略 ⇒ cli:* 仍拒",
	);
	// 对照（正控）：只给角色声明时同一模型是放行的 —— 两条必须可区分
	assert.equal(toolsSupportedForBackend("cli:claude", fusionTools), true, "无 caller 策略时 cli:* 豁免");

	const argvHeadless = buildPiArgv({
		cliPath: CLI,
		model: "Zhipu/glm-5.2",
		task: "Task: run headless fusion",
		tools: fusionTools,
		excludeTools: FUSION_EXCLUDE_TOOLS,
	});
	const ti = argvHeadless.indexOf("--tools");
	assert.ok(ti > 0, "headless fusion 必须包含 --tools");
	assert.equal(argvHeadless[ti + 1], "read,write,bash");
	const xi = argvHeadless.indexOf("--exclude-tools");
	assert.ok(xi > ti, "--exclude-tools 必须在 --tools 之后");
	assert.ok(argvHeadless[xi + 1].includes("launch-tabs"));
}

console.log("All subagent roles and tools integration tests passed!");
