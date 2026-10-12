import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import cp, { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import {
	buildWindowsTerminalArgs,
	buildWorkflowTabPrompt,
	cleanupWtPromptArg,
	_resetLauncherCache,
	healthyLauncher,
	probeWtHelp,
	resolveDirectTerminalExe,
	composeLaunchTitle,
	deriveLaunchTitle,
	isWorktreePath,
	launchTaskTitle,
	modePrefix,
	normalizeWorkflowPrompt,
	parseLaunchRequest,
	repoName,
	sanitizeWtTitle,
	spawnPiTab,
	taskTitleLabel,
	workflowDisciplineBlock,
	wtPromptArg,
} from "./launch.ts";
import { buildTabSpawnEnv } from "./tab-launch-core.ts";
import { getTabRunId, isMainSession } from "./identity.ts";

// ── 2026-10-12 测试卫生修复：child_process.spawn/spawnSync/execFileSync 模块级拦截 ──
// ESM 具名导入是快照：只改 cp.x 不会影响 launch.ts/tab-launch-core.ts 已捕获的绑定。
// syncBuiltinESMExports() 才会把补丁同步回已导入绑定（先例：_test_graph_frontier_shadow.ts
// 对 os.homedir 的同款手法）。拦截 spawn 是「绝不再真开 Windows Terminal 标签」的兜底。
const ORIG_CHILD_PROCESS = {
	spawn: cp.spawn,
	spawnSync: cp.spawnSync,
	execFileSync: cp.execFileSync,
};
function restoreChildProcess(): void {
	cp.spawn = ORIG_CHILD_PROCESS.spawn;
	cp.spawnSync = ORIG_CHILD_PROCESS.spawnSync;
	cp.execFileSync = ORIG_CHILD_PROCESS.execFileSync;
	syncBuiltinESMExports();
}
const IDENTITY_ENV_KEYS = [
	"PI_TAB_RUN_ID", "PI_TAB_RUNS_DIR", "PI_SESSION_PROFILE", "PI_TRACE_RUN_ID",
	"PI_TRACE_LANE", "PI_SESSION_ID", "PI_SESSION_FILE", "PI_SUBAGENT",
] as const;

const orchestration = parseLaunchRequest("你来并行启动这三个任务");
assert.deepEqual(orchestration, {
	task: "你来并行启动这三个任务",
	title: undefined,
	model: undefined,
	cwd: undefined,
	direct: false,
	research: false,
	execute: false,
	adaptive: false,
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
	adaptive: false,
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
assert.ok(bound.includes("严禁再调用 `launch-tabs`"), "tab 约束必须禁止嵌套 launch-tabs");
assert.ok(bound.endsWith("按计划实施"), "原始 handoff 应保留在末尾");
assert.ok(!bound.includes("busy-poll"), "worker prompt 不得含禁轮询文本（worker 面零加噪；STOP 合法终态与 tab-finish 纪律冲突）");

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
assert.ok(boundE.includes("严禁再调用 `launch-tabs`"), "execute tab 约束必须禁止嵌套 launch-tabs");
assert.ok(boundE.includes("不要凭空设计"), "execute 约束块应禁止无交接时自行设计");
assert.ok(boundE.includes("tab-finish"), "execute 约束块也必须强提醒 tab-finish 回报");
assert.ok(!boundE.includes("并行 searcher 最大化搜索"), "execute 模式不应出现研究流程");
assert.ok(boundE.endsWith("按 plans/0810_agent_safety.md 实现"));
// 已带 execute 前缀时不重复；无 taskId 时只前缀归一化
assert.equal(buildWorkflowTabPrompt({ taskId: "1008", prompt: "根据execute进行工作1008\n\n实现" }, skillPath, "execute").split("\n")[0], "根据execute进行工作1008");
assert.equal(buildWorkflowTabPrompt({ taskId: "", prompt: "随便看看" }, skillPath, "execute"), "根据execute进行工作\n\n随便看看");
assert.ok(workflowDisciplineBlock("1007", skillPath, "execute").split("\n").every((l) => l.startsWith("> ")));

// ── adaptive 模式：前缀、纪律块、parseLaunchRequest --adaptive ──
assert.equal(modePrefix("1040", "adaptive"), "根据adaptive进行工作1040");
const boundA = buildWorkflowTabPrompt({ taskId: "1040", prompt: "修复 1040 检测器生命周期" }, skillPath, "adaptive");
assert.equal(boundA.split("\n")[0], "根据adaptive进行工作1040");
assert.ok(boundA.includes("首轮自评"), "adaptive 纪律块必须含首轮自评");
assert.ok(boundA.includes("A 快链") && boundA.includes("B 中链") && boundA.includes("C 全链"), "adaptive 纪律块必须含三档链");
assert.ok(boundA.includes("升级规则") && boundA.includes("降级禁止"), "adaptive 纪律块必须含升降级规则");
assert.ok(boundA.includes("校验性核对"), "adaptive 纪律块必须含 A0 校验性核对");
assert.ok(!boundA.includes("【工作方式约束 · 强制 · 快速执行】") && !boundA.includes("【工作方式约束 · 强制 · 深度研究】"), "adaptive 纪律块不应复用 execute/research 标题");
assert.ok(boundA.endsWith("修复 1040 检测器生命周期"));
// 已带 adaptive 前缀时不重复；无 taskId 时只前缀归一化
assert.equal(buildWorkflowTabPrompt({ taskId: "1041", prompt: "根据adaptive进行工作1041\n\n实现" }, skillPath, "adaptive").split("\n")[0], "根据adaptive进行工作1041");
assert.equal(buildWorkflowTabPrompt({ taskId: "", prompt: "随便看看" }, skillPath, "adaptive"), "根据adaptive进行工作\n\n随便看看");
assert.ok(workflowDisciplineBlock("1040", skillPath, "adaptive").split("\n").every((l) => l.startsWith("> ")));
// /launch 文本 --adaptive 旗标：解析并剥离
assert.equal(parseLaunchRequest("--adaptive 修复 1040").adaptive, true);
assert.equal(parseLaunchRequest("--adaptive 修复 1040").task, "修复 1040");
assert.equal(parseLaunchRequest("--adaptive --direct 实现 1040").adaptive, true);
assert.equal(parseLaunchRequest("普通任务 1040").adaptive, false);
// workflow 前缀不受 adaptive 影响
assert.equal(modePrefix("1040", "workflow"), "根据workflow进行工作1040");

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

// ── 2026-10-12 C：常驻后继的 spawn env（clearTabIdentity 必须清掉继承的标签页身份）──
// 杀手断言：若去掉 clearTabIdentity 分支（或退回 `env: undefined`），父进程的
// PI_TAB_RUN_ID 会被子进程继承 → 后继 getTabRunId() 非空 → 仍被判为 tab（C 落空）。
{
	const baseEnv = {
		PATH: "C:/x",
		KEEP: "1",
		PI_TAB_RUN_ID: "tab_old_master",
		PI_TAB_RUNS_DIR: "C:/runs",
		PI_SESSION_PROFILE: "trace-worker",
		PI_TRACE_RUN_ID: "tfl_old",
		PI_TRACE_LANE: "A",
		PI_SESSION_ID: "sid-old",
		PI_SESSION_FILE: "C:/sessions/old.jsonl",
		PI_SUBAGENT: "1",
	};

	// 缺省（旧行为）：undefined = 继承父 env，零行为变化
	assert.equal(buildTabSpawnEnv(baseEnv, {}), undefined, "缺省必须继承父 env（历史行为）");

	// clearTabIdentity：身份类变量全清，其余保留
	const cleared = buildTabSpawnEnv(baseEnv, { clearTabIdentity: true });
	assert.ok(cleared, "clearTabIdentity 必须显式传 env（覆盖默认继承）");
	for (const k of [
		"PI_TAB_RUN_ID", "PI_TAB_RUNS_DIR", "PI_SESSION_PROFILE",
		"PI_TRACE_RUN_ID", "PI_TRACE_LANE", "PI_SESSION_ID", "PI_SESSION_FILE", "PI_SUBAGENT",
	]) {
		assert.equal(cleared[k], undefined, `${k} 必须被清空（否则后继身份泄漏）`);
	}
	assert.equal(cleared.PATH, "C:/x", "非身份 env 必须保留");
	assert.equal(cleared.KEEP, "1", "非身份 env 必须保留");
	assert.equal("PI_TAB_RUN_ID" in cleared, false, "删除而非置 undefined（防 Node env 序列化歧义）");

	// 有 tabRunId 时按原语义注入身份（历史行为逐字不变）
	const tabEnv = buildTabSpawnEnv(baseEnv, {
		tabRunId: "tab_new", runsDir: "rd", sessionProfile: "sp", traceRunId: "tfl2", traceLane: "B",
	});
	assert.equal(tabEnv?.PI_TAB_RUN_ID, "tab_new");
	assert.equal(tabEnv?.PI_TAB_RUNS_DIR, "rd");
	assert.equal(tabEnv?.PI_SESSION_PROFILE, "sp");
	assert.equal(tabEnv?.PI_TRACE_RUN_ID, "tfl2");
	assert.equal(tabEnv?.PI_TRACE_LANE, "B");
	assert.equal(tabEnv?.PATH, "C:/x");
	// 显式派发身份优先于 clearTabIdentity（同传时以 tabRunId 为准）
	assert.equal(buildTabSpawnEnv(baseEnv, { tabRunId: "tab_new", clearTabIdentity: true })?.PI_TAB_RUN_ID, "tab_new");

	// C 的另一半：后继 argv 不得带 --tab-run-id
	const succArgv = buildWindowsTerminalArgs("t", "p", { cwd: ".", piCli: "cli.js", execPath: "node.exe" });
	assert.equal(succArgv.includes("--tab-run-id"), false, "常驻后继 argv 不得含 --tab-run-id");

	// 身份联动（§5③）：把 clearTabIdentity 的 8 个身份键从当前 env 清除后起会话 →
	// getTabRunId() 空 / isMainSession() 真；反证：回溢 PI_TAB_RUN_ID → 又成 tab（C 的失败模式）。
	// （测试进程本身可能带 PI_SUBAGENT=1，必须按 clearTabIdentity 清单整体清理才可判 isMainSession）
	const identityKeys = [
		"PI_TAB_RUN_ID", "PI_TAB_RUNS_DIR", "PI_SESSION_PROFILE", "PI_TRACE_RUN_ID",
		"PI_TRACE_LANE", "PI_SESSION_ID", "PI_SESSION_FILE", "PI_SUBAGENT",
	] as const;
	const savedEnv: Record<string, string | undefined> = {};
	for (const k of identityKeys) savedEnv[k] = process.env[k];
	try {
		for (const k of identityKeys) delete process.env[k];
		assert.equal(getTabRunId(), undefined, "身份已清 → getTabRunId() 为空");
		assert.equal(isMainSession(), true, "身份已清 → isMainSession() 为真（C 的目标）");
		process.env.PI_TAB_RUN_ID = "tab_old_master";
		assert.equal(getTabRunId(), "tab_old_master", "反证：继承父 env → getTabRunId() 非空");
		assert.equal(isMainSession(), false, "反证：继承父 env → 仍是 tab（C 落空）");
	} finally {
		for (const k of identityKeys) {
			if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]!;
		}
	}
}

// ── 2026-10-12 测试卫生修复 C-real：拦截 child_process.spawn，断言「真实 spawn 入参」──
// 把上面纯函数断言升级为真实 spawn 入参断言：clearTabIdentity 传给子进程的 env 必须先清
// 8 个身份键（否则常驻后继继承父标签页身份 → C 落空）；有 tabRunId 时按原样注入。
{
	const cap: Array<{ exe: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
	// 探针恒成功 → 别名健康 → 必然走到真实 spawn（无需 AppX 回退）。
	cp.spawnSync = (() => ({ status: 0, stdout: "", stderr: "" })) as unknown as typeof cp.spawnSync;
	cp.spawn = ((exe: string, args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
		cap.push({ exe, args, env: opts?.env });
		return { on() {}, unref() {} };
	}) as unknown as typeof cp.spawn;
	syncBuiltinESMExports();

	const saved: Record<string, string | undefined> = {};
	for (const k of IDENTITY_ENV_KEYS) {
		saved[k] = process.env[k];
		process.env[k] = `seed-${k}`; // 父进程（标签页）身份：必须被子进程 env 丢弃
	}
	const prevKeep = process.env.PI_TEST_KEEP;
	process.env.PI_TEST_KEEP = "keep-me";
	_resetLauncherCache();
	try {
		// ① clearTabIdentity：真实 spawn env 不含 8 身份键，非身份 env 保留
		const res = spawnPiTab({
			wtPath: process.execPath, piCli: process.execPath, execPath: process.execPath,
			cwd: process.cwd(), title: "spawn-env-clear", prompt: "hi", clearTabIdentity: true,
		});
		assert.equal(res.error, undefined, `健康别名路径应成功派发：${res.error}`);
		assert.equal(cap.length, 1, "clearTabIdentity 应真实 spawn 一次");
		const env0 = cap[0]!.env;
		assert.ok(env0, "clearTabIdentity 必须显式传 env（覆盖 Node 默认继承）");
		for (const k of IDENTITY_ENV_KEYS) {
			assert.equal(k in env0!, false, `${k} 不得出现在真实 spawn env（身份泄漏）`);
		}
		assert.equal(env0.PI_TEST_KEEP, "keep-me", "非身份 env 必须原样保留");

		// ② 有 tabRunId：真实 spawn env 按原语义注入派发身份（历史行为不变）
		_resetLauncherCache();
		const res2 = spawnPiTab({
			wtPath: process.execPath, piCli: process.execPath, execPath: process.execPath,
			cwd: process.cwd(), title: "spawn-env-tab", prompt: "hi", tabRunId: "tab_real_1", runsDir: "C:/runs",
		});
		assert.equal(res2.error, undefined, `tabRunId 路径应成功派发：${res2.error}`);
		assert.equal(cap.length, 2, "tabRunId 应真实 spawn 第二次");
		assert.equal(cap[1]!.env?.PI_TAB_RUN_ID, "tab_real_1");
		assert.equal(cap[1]!.env?.PI_TAB_RUNS_DIR, "C:/runs");
	} finally {
		if (prevKeep === undefined) delete process.env.PI_TEST_KEEP; else process.env.PI_TEST_KEEP = prevKeep;
		for (const k of IDENTITY_ENV_KEYS) {
			if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!;
		}
		restoreChildProcess();
		_resetLauncherCache();
	}
}

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

// ── --title 消毒（标签从 prompt 首行提取，可能含 ; " % —— wt tokenizer 风险字符；标题不走 @file 物化，必须就地清洗）──
{
	assert.equal(sanitizeWtTitle("GreenCAD-307-修复 50% 回归"), "GreenCAD-307-修复 50 回归");
	assert.equal(sanitizeWtTitle('a"b;c d'), "a b c d");
	assert.equal(sanitizeWtTitle("  双  空格  "), "双 空格");
	assert.equal(sanitizeWtTitle(";;;"), "task");
	const riskyTitle = launchTaskTitle({ taskId: "307", title: undefined, prompt: '50% 回归; 修复 "x" 的测试\n\n正文' }, process.cwd());
	assert.ok(!/[\r\n;"%]/.test(riskyTitle), `launchTaskTitle 输出不得含 wt 风险字符: ${riskyTitle}`);
}

// ── adaptive 纪律块：A0 自执行快链档位声明（与 SKILL.md 口径一致）──
{
	const adaptiveBlock = workflowDisciplineBlock("1030", undefined, "adaptive");
	assert.ok(adaptiveBlock.includes("**A0 自执行快链**"), "adaptive 约束块应含 A0 档");
	assert.ok(adaptiveBlock.includes("code-reviewer 独立审查必做"), "A0 档独立审查不可省");
	assert.ok(adaptiveBlock.includes("禁止例行化"), "A0 咨询事件驱动、禁止例行化");
	const workflowBlock = workflowDisciplineBlock("1031");
	assert.ok(!workflowBlock.includes("A0 自执行快链"), "workflow 全链约束块不应含 A0 档");
}

// trace-fusion C3：session/trace 身份旗标仅在显式传入时发射（workflow 路径永不传入 → argv 与历史一致）
{
	const base = buildWindowsTerminalArgs("t", "p", { cwd: ".", piCli: "cli.js", execPath: "node.exe" });
	for (const flag of ["--session-profile", "--trace-run-id", "--trace-lane"]) {
		assert.equal(base.includes(flag), false, `workflow 路径不应发射 ${flag}`);
	}
	const traced = buildWindowsTerminalArgs("t", "p", {
		cwd: ".", piCli: "cli.js", execPath: "node.exe",
		sessionProfile: "trace-worker", traceRunId: "tfl_ab12", traceLane: "A", tabRunId: "run_1",
	});
	const idx = (f: string) => traced.indexOf(f);
	assert.ok(idx("--session-profile") > 0 && traced[idx("--session-profile") + 1] === "trace-worker");
	assert.ok(idx("--trace-run-id") > 0 && traced[idx("--trace-run-id") + 1] === "tfl_ab12");
	assert.ok(idx("--trace-lane") > 0 && traced[idx("--trace-lane") + 1] === "A");
	// 旗标都在 --tab-run-id 与最终 prompt 之前，且 prompt 恒为最后参数
	assert.ok(idx("--session-profile") < idx("--tab-run-id") && idx("--tab-run-id") < traced.length - 1);
	assert.equal(traced[traced.length - 1], "p");
}

// Pre-flight（空 WT 窗口根因修复）：非法参数在 spawn 前拦截，失败路径永不触达 spawn。
// 注意：wtPath 用 process.execPath 占位（存在即可），失败断言均在 spawn 之前返回。
{
	const badCwd = spawnPiTab({
		wtPath: process.execPath, piCli: process.execPath, execPath: process.execPath,
		cwd: "C:/definitely-not-a-real-dir-9f8e7d6c5b4a", title: "t", prompt: "p",
	});
	assert.ok(badCwd.error?.startsWith("preflight: cwd not found"), `缺失 cwd 应 preflight 拦截：${badCwd.error}`);
	const badCli = spawnPiTab({
		wtPath: process.execPath, piCli: "C:/definitely-not-a-real-cli-9f8e7d6c5b4a.js", execPath: process.execPath,
		cwd: ".", title: "t", prompt: "p",
	});
	assert.ok(badCli.error?.startsWith("preflight: pi CLI not found"), `缺失 piCli 应 preflight 拦截：${badCli.error}`);
	const badExec = spawnPiTab({
		wtPath: process.execPath, piCli: process.execPath, execPath: "C:/definitely-not-a-real-node-9f8e7d6c5b4a.exe",
		cwd: ".", title: "t", prompt: "p",
	});
	assert.ok(badExec.error?.startsWith("preflight: node exec not found"), `缺失 execPath 应 preflight 拦截：${badExec.error}`);
}

{
// 别名失效回退（2026-09-23）：探针只认 exit==0；直调路径动态解析；缓存命中不再探。
_resetLauncherCache();
assert.equal(typeof probeWtHelp, "function", "probeWtHelp 导出");
assert.equal(typeof resolveDirectTerminalExe, "function", "resolveDirectTerminalExe 导出");
// 不存在的 exe 探针必 false（never-throw，不卡超时太久）
assert.equal(probeWtHelp("C:/no/such/wt.exe", 1500), false, "不存在路径探针 false");
// 直调解析在本机应命中包内 exe（若 Store 包缺席则跳过，不断言失败）
const direct = resolveDirectTerminalExe();
if (direct !== null) {
  assert.ok(direct.endsWith("WindowsTerminal.exe"), `直调路径应为包内 exe：${direct}`);
}
// healthyLauncher 缓存：第二次调用不再跑探针（用坏路径验证 fail closed 不抛）
_resetLauncherCache();
const bad = healthyLauncher("C:/no/such/wt.exe");
assert.ok(bad === null || typeof bad.exe === "string", "全坏时返回 null 或可用项，不抛");
_resetLauncherCache();
// fail-closed 回归（2026-09-23 缺 import 事故；2026-10-12 测试卫生修复）：
// 合法 pre-flight 参数 + 双启动器真坏 → 必须 fail-closed 返回 error（不抛、不开窗）。
// 修复前缺陷：PI_WT_APPS_DIR 只短路目录扫描，resolveDirectTerminalExe 的 Get-AppxPackage
// 回退仍命中真实 WindowsTerminal.exe → healthyLauncher 返回 direct → 真的 spawn
// （piCli=node.exe → 弹出 “MZ” SyntaxError 崩溃窗口）。
// 现改为「真坏 + 双重拦截」：spawnSync 探针恒 false（别名坏）+ execFileSync 恒抛（AppX
// 回退坏）→ resolveDirectTerminalExe() 返回 null；同时把 child_process.spawn 换成记录桩，
// 即使解析意外成功也绝不真开窗。
_resetLauncherCache();
const cap: Array<{ exe: string; args: string[] }> = [];
cp.spawnSync = (() => ({ status: 1, error: new Error("stub-probe-fail"), stdout: "", stderr: "" })) as unknown as typeof cp.spawnSync;
cp.execFileSync = (() => { throw new Error("stub-appx-package-unavailable"); }) as unknown as typeof cp.execFileSync;
cp.spawn = ((exe: string, args: string[]) => {
	cap.push({ exe, args });
	return { on() {}, unref() {} };
}) as unknown as typeof cp.spawn;
syncBuiltinESMExports();
process.env.PI_WT_APPS_DIR = "C:/no/such/apps";
let doomed: ReturnType<typeof spawnPiTab>;
try {
	doomed = spawnPiTab({
		// 存在但不可执行的文件：过 pre-flight existsSync，但 --help 探针必失败
		wtPath: new URL("../package.json", import.meta.url).pathname.replace(/^\//, ""),
		piCli: process.execPath,
		cwd: process.cwd(),
		title: "doomed",
		prompt: "hi",
	});
} finally {
	delete process.env.PI_WT_APPS_DIR;
	restoreChildProcess();
	_resetLauncherCache();
}
assert.ok(doomed.error && doomed.error.length > 0, `双坏应 fail closed：${doomed.error}`);
assert.equal(cap.length, 0, "fail-closed 路径绝不得 spawn（拦截 child_process.spawn 为证）");
}

console.log("launch tests passed");
