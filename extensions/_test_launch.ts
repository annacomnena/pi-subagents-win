import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
	buildWindowsTerminalArgs,
	buildWorkflowTabPrompt,
	cleanupWtPromptArg,
	composeLaunchTitle,
	deriveLaunchTitle,
	isWorktreePath,
	launchTaskTitle,
	normalizeWorkflowPrompt,
	parseLaunchRequest,
	repoName,
	taskTitleLabel,
	workflowDisciplineBlock,
	wtPromptArg,
} from "./launch.ts";

const orchestration = parseLaunchRequest("你来并行启动这三个任务");
assert.deepEqual(orchestration, {
	task: "你来并行启动这三个任务",
	title: undefined,
	model: undefined,
	cwd: undefined,
	direct: false,
	research: false,
	execute: false,
});

const direct = parseLaunchRequest("-t pi-wlc-1007 --model Zhipu/glm-5.2 修复 1007");
assert.deepEqual(direct, {
	task: "修复 1007",
	title: "pi-wlc-1007",
	model: "Zhipu/glm-5.2",
	cwd: undefined,
	direct: true,
	research: false,
	execute: false,
});

const withCwd = parseLaunchRequest("--direct --cwd /home/user/worktrees/MyProject-123 实施 123");
assert.equal(withCwd.cwd, "/home/user/worktrees/MyProject-123");
assert.equal(withCwd.task, "实施 123");
assert.equal(withCwd.direct, true);
assert.equal(withCwd.research, false);

const escaped = parseLaunchRequest("--direct --model Zhipu/glm-5.2 修复 1007");
assert.equal(escaped.direct, true);
assert.equal(escaped.task, "修复 1007");
assert.equal(deriveLaunchTitle(escaped.task), "修复 1007");

// ── 深度研究模式：--research / -r 标志 ──
const researchReq = parseLaunchRequest("--research 深度调研 X 模块");
assert.equal(researchReq.research, true);
assert.equal(researchReq.direct, false);
assert.equal(researchReq.task, "深度调研 X 模块");
assert.equal(parseLaunchRequest("--research --direct 深度调研 1007").research, true);
assert.equal(parseLaunchRequest("-r 摸底 Y 子系统").research, true);
assert.equal(parseLaunchRequest("-r -t pi-res-1007 深度调研 1007").research, true);
assert.equal(parseLaunchRequest("-r -t pi-res-1007 深度调研 1007").title, "pi-res-1007");
assert.equal(parseLaunchRequest("-r -t pi-res-1007 深度调研 1007").task, "深度调研 1007");

// ── 快速执行模式：--execute / -e 标志 ──
const execReq = parseLaunchRequest("--execute 按已确认方案实现 X 模块");
assert.equal(execReq.execute, true);
assert.equal(execReq.research, false);
assert.equal(execReq.direct, false);
assert.equal(execReq.task, "按已确认方案实现 X 模块");
assert.equal(parseLaunchRequest("-e --direct 实现 1007").execute, true);
assert.equal(parseLaunchRequest("-e -t pi-exec-1007 实现 1007").execute, true);
assert.equal(parseLaunchRequest("-e -t pi-exec-1007 实现 1007").title, "pi-exec-1007");
assert.equal(parseLaunchRequest("-e -t pi-exec-1007 实现 1007").task, "实现 1007");
assert.equal(parseLaunchRequest("普通任务 1007").execute, false);

const prompt = normalizeWorkflowPrompt({ taskId: "1007", prompt: "先读 workflow，再按计划实施" });
assert.equal(prompt, "根据workflow进行工作1007\n\n先读 workflow，再按计划实施");
assert.equal(normalizeWorkflowPrompt({ taskId: "1008", prompt: "根据workflow进行工作1008\n\n执行" }), "根据workflow进行工作1008\n\n执行");

// ── workflow 强制约束：带 taskId 时附加约束块，blockquote 不干扰标题提取 ──
const skillPath = "C:/pi-packages/subagent-win/skills/workflow-orchestrator/SKILL.md";
const bound = buildWorkflowTabPrompt({ taskId: "1007", prompt: "按计划实施" }, skillPath);
assert.ok(bound.startsWith("根据workflow进行工作1007\n\n> 【工作方式约束 · 强制】"), bound);
assert.ok(bound.includes(skillPath), "约束块应给出技能绝对路径");
assert.ok(bound.includes("你是项目经理") && bound.includes("禁止自己一路干完"), bound);
assert.ok(bound.includes("tab-finish"), "约束块必须强提醒完成后 tab-finish 回报主会话");
assert.ok(bound.endsWith("按计划实施"), "原始 handoff 应保留在末尾");

// 已带前缀时不重复，约束块插在中间
const bound2 = buildWorkflowTabPrompt({ taskId: "1008", prompt: "根据workflow进行工作1008\n\n执行" }, skillPath);
assert.equal(bound2.split("\n")[0], "根据workflow进行工作1008");
assert.ok(bound2.includes("\n\n> 【工作方式约束 · 强制】"));
assert.ok(bound2.endsWith("执行"));

// 无技能路径时用技能名兜底
const bound3 = buildWorkflowTabPrompt({ taskId: "1007", prompt: "x" });
assert.ok(bound3.includes("workflow-orchestrator") && !bound3.includes(skillPath));

// ── 深度研究模式：research 前缀 + 研究约束块 ──
const boundR = buildWorkflowTabPrompt({ taskId: "1007", prompt: "深度调研 Agent 运行时安全" }, skillPath, "research");
assert.ok(boundR.startsWith("根据research进行工作1007\n\n> 【工作方式约束 · 强制 · 深度研究】"), boundR);
assert.ok(boundR.includes("深度研究模式（research-only）"), "研究约束块应指向技能的深度研究模式一节");
assert.ok(boundR.includes("禁止进入 planner") && boundR.includes("研究报告"), boundR);
assert.ok(boundR.includes("tab-finish"), "research 约束块也必须强提醒 tab-finish 回报");
assert.ok(!boundR.includes("搜索 → 计划 → 审查 → 实现"), "研究模式不应出现完整链路流程");
assert.ok(boundR.endsWith("深度调研 Agent 运行时安全"));
// 已带 research 前缀时不重复
const boundR2 = buildWorkflowTabPrompt({ taskId: "1008", prompt: "根据research进行工作1008\n\n调研" }, skillPath, "research");
assert.equal(boundR2.split("\n")[0], "根据research进行工作1008");
assert.ok(boundR2.includes("深度研究"));
// 无 taskId 直开仍保持前缀归一化（不强制研究约束）
assert.equal(buildWorkflowTabPrompt({ taskId: "", prompt: "随便看看" }, skillPath, "research"), "根据research进行工作\n\n随便看看");
// 研究约束块本身是 blockquote 行
assert.ok(workflowDisciplineBlock("1007", skillPath, "research").split("\n").every((l) => l.startsWith("> ")));

// ── 快速执行模式：execute 前缀 + 执行约束块（跳过搜索/计划）──
const boundE = buildWorkflowTabPrompt({ taskId: "1007", prompt: "按 plans/0810_agent_safety.md 实现" }, skillPath, "execute");
assert.ok(boundE.startsWith("根据execute进行工作1007\n\n> 【工作方式约束 · 强制 · 快速执行】"), boundE);
assert.ok(boundE.includes("快速执行模式（execute-only）") && boundE.includes("跳过搜索与计划"), boundE);
assert.ok(boundE.includes("implementer") && boundE.includes("code-reviewer") && boundE.includes("Wiki 收尾"), boundE);
assert.ok(boundE.includes("不要凭空设计"), "execute 约束块应禁止无交接时自行设计");
assert.ok(boundE.includes("tab-finish"), "execute 约束块也必须强提醒 tab-finish 回报");
assert.ok(!boundE.includes("并行 searcher 最大化搜索"), "execute 模式不应出现研究流程");
assert.ok(boundE.endsWith("按 plans/0810_agent_safety.md 实现"));
// 已带 execute 前缀时不重复；无 taskId 时只前缀归一化
assert.equal(buildWorkflowTabPrompt({ taskId: "1008", prompt: "根据execute进行工作1008\n\n实现" }, skillPath, "execute").split("\n")[0], "根据execute进行工作1008");
assert.equal(buildWorkflowTabPrompt({ taskId: "", prompt: "随便看看" }, skillPath, "execute"), "根据execute进行工作\n\n随便看看");
assert.ok(workflowDisciplineBlock("1007", skillPath, "execute").split("\n").every((l) => l.startsWith("> ")));

// 无 taskId（直开标签）不绑定
assert.equal(buildWorkflowTabPrompt({ taskId: "", prompt: "随便看看" }), "根据workflow进行工作\n\n随便看看");

// label 提取跳过约束块，仍从 handoff 首行取标签
assert.equal(
	taskTitleLabel(undefined, buildWorkflowTabPrompt({ taskId: "1007", prompt: "Item 123 — Agent 运行时安全（P0）实施启动。" })),
	"Agent 运行时安全实施启动",
);

// 约束块本身是 blockquote 行
assert.ok(workflowDisciplineBlock("1007", skillPath).split("\n").every((l) => l.startsWith("> ")));

// ── 标签命名规范：<repo>[-worktree]-[<taskId>-]<label>，无 wlc ──
assert.equal(
	composeLaunchTitle({ repo: "MyProject", worktree: false, taskId: "123", label: "安全收口" }),
	"MyProject-123-安全收口",
);
assert.equal(
	composeLaunchTitle({ repo: "MyProject", worktree: true, taskId: "123", label: "嵌套散布" }),
	"MyProject-worktree-123-嵌套散布",
);
assert.equal(
	composeLaunchTitle({ repo: "MyProject", worktree: true, taskId: "", label: "路线创建向导" }),
	"MyProject-worktree-路线创建向导",
);

// label：显式 title 剥离 pi-/wlc- 前缀；缺省从 prompt 首行提取
assert.equal(taskTitleLabel("pi-123-Agent安全收口", "x"), "123-Agent安全收口");
assert.equal(taskTitleLabel("wlc-foo", "x"), "foo");
assert.equal(taskTitleLabel(undefined, "根据workflow进行工作123\n\nItem 123 — Agent 运行时安全（P0）实施启动。"), "Agent 运行时安全实施启动");
assert.equal(taskTitleLabel(undefined, "根据research进行工作123\n\n深度调研 Agent 运行时安全（P0）。"), "深度调研 Agent 运行时安全");
assert.equal(taskTitleLabel(undefined, "根据execute进行工作123\n\n按已确认方案实现 Agent 运行时安全。"), "按已确认方案实现 Agent 运行时安全");
assert.equal(taskTitleLabel(undefined, "## 背景\n正文"), "正文");

// worktree 路径判定
assert.equal(isWorktreePath("/home/user/worktrees/MyProject-123"), true);
assert.equal(isWorktreePath("/home/user/MyProject"), false);

// repoName：真实 git 仓库返回 origin 名（跨 worktree 稳定）；无 git 时回退目录名
const subagentRepo = repoName(process.cwd());
assert.ok(subagentRepo.length > 0 && !subagentRepo.includes(":"), `unexpected repoName: ${subagentRepo}`);
assert.equal(repoName("Z:/no-such-repo-xyz/foo"), "foo");

// 以下 worktree 语义依赖真实 git 仓库；仅在对应路径存在时验证 git 派生断言
let hasWorktree = false;
try {
	execFileSync("git", ["rev-parse", "--show-toplevel"], {
		encoding: "utf8", shell: false, stdio: ["ignore", "pipe", "ignore"],
	});
	hasWorktree = true;
} catch {
	hasWorktree = false;
}

const argv = buildWindowsTerminalArgs("MyProject-123-安全收口", prompt, {
	cwd: "C:/repo with spaces",
	piCli: "C:/pi/dist/cli.js",
	execPath: "C:/node/node.exe",
});
assert.deepEqual(argv, [
	"-w", "0", "new-tab", "--title", "MyProject-123-安全收口", "--suppressApplicationTitle",
	"-d", "C:/repo with spaces", "C:/node/node.exe", "C:/pi/dist/cli.js", prompt,
]);

// --skill 保证技能在标签会话中可见
const argvSkill = buildWindowsTerminalArgs("t", "p", {
	cwd: ".",
	piCli: "C:/pi/dist/cli.js",
	execPath: "C:/node/node.exe",
	skills: ["C:/pi-packages/subagent-win/skills"],
});
assert.ok(argvSkill.includes("--skill") && argvSkill.includes("C:/pi-packages/subagent-win/skills"));
assert.ok(argvSkill.indexOf("--skill") > argvSkill.indexOf("C:/pi/dist/cli.js") && argvSkill.indexOf("--skill") < argvSkill.indexOf("p"));

// --tab-run-id 可靠传递标签页回收身份（不依赖 env 继承）
const argvTab = buildWindowsTerminalArgs("t", "p", {
	cwd: ".",
	piCli: "C:/pi/dist/cli.js",
	execPath: "C:/node/node.exe",
	tabRunId: "tab_abc_1",
});
assert.ok(argvTab.includes("--tab-run-id") && argvTab.includes("tab_abc_1"), "应传 --tab-run-id");
assert.ok(argvTab.indexOf("--tab-run-id") < argvTab.indexOf("p"), "flag 应在 prompt 之前");

// ── wt 命令行 prompt 物化：换行/引号/分号 prompt 不直接上 wt 命令行（防多开无用 tab）──
{
	// 多行 prompt（workflow 派发的常态）→ 物化为 @file，命令行上无换行
	const multi = "根据workflow进行工作123\n\n> 【工作方式约束 · 强制】\n> 1. 按技能执行\n\n按计划实施";
	const arg = wtPromptArg(multi, "tab_test_1");
	assert.ok(arg.startsWith("@"), "多行 prompt 必须物化为 @file");
	assert.ok(!/\r|\n/.test(arg), "命令行参数不得含换行");
	const filePath = arg.slice(1);
	assert.ok(existsSync(filePath), "临时 prompt 文件应存在");
	assert.equal(readFileSync(filePath, "utf8"), multi, "文件内容应等于原始 prompt");
	cleanupWtPromptArg(arg);
	assert.equal(existsSync(filePath), false, "清理后文件应删除");

	// 分号 / 引号 / 百分号同样触发物化（wt 会做 ; 命令分隔 / 引号解析 / %env% 展开）
	assert.notEqual(wtPromptArg("先做 A;再做 B"), "先做 A;再做 B");
	assert.notEqual(wtPromptArg("带\"引号\"的 prompt"), "带\"引号\"的 prompt");
	assert.notEqual(wtPromptArg("进度 50% 完成"), "进度 50% 完成");

	// 安全单行 prompt 保持内联（零行为变化）
	assert.equal(wtPromptArg("单行安全 prompt"), "单行安全 prompt");
	assert.equal(wtPromptArg("根据workflow进行工作123"), "根据workflow进行工作123");
}

console.log("launch tests passed");
