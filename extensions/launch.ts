import { execFileSync } from "node:child_process";
import { sanitizeWtTitle } from "./tab-launch-core.ts";

// tab 启动原语已抽出至 tab-launch-core（trace-fusion C3）：本模块保留
// workflow 语义层（parse / mode / prompt builder / 标题规范），spawn 与
// wt 命令行安全原语经 re-export 供既有导入方（index.ts / _test_launch）
// 继续使用，行为不变。依赖方向（设计稿 §53）：
//   launch-tabs → workflow prompt builder（本模块）→ tab-launch-core
//   trace-fusion-loop → trace worker prompt builder → tab-launch-core
export {
	buildWindowsTerminalArgs,
	type PiLaunchArgsOptions,
	cleanupWtPromptArg,
	sanitizeWtTitle,
	spawnPiTab,
	sweepStaleWtPrompts,
	type TabLaunchOptions,
	type TabSpawnResult,
	wtPromptArg,
	wtPromptDir,
} from "./tab-launch-core.ts";

export interface LaunchRequest {
	task: string;
	title?: string;
	model?: string;
	cwd?: string;
	direct: boolean;
	/** 深度研究模式：标签页只做并行搜索 + 研究报告 + Wiki 维护，不进入计划/实现阶段。 */
	research: boolean;
	/** 快速执行模式：结论已明确，跳过搜索与计划，只做实现 → 审查 → Wiki 收尾。 */
	execute: boolean;
	/** 自适应模式：任务书四要素（根因+方案+文件域+验收标准）齐全但不确定假设是否仍成立，tab 启动时自评完备度选链深 A0自执行快链/A快链/B中链/C全链。 */
	adaptive: boolean;
}

export interface LaunchTask {
	taskId: string;
	title?: string;
	prompt: string;
	model?: string;
}

/**
 * Parse the /launch command without deciding how the request will be executed.
 *
 * A title (or --direct) is an explicit request for one terminal. Without it,
 * the command is an orchestration request and is handed back to the current
 * agent, which can inspect the conversation before choosing several tasks.
 */
export function parseLaunchRequest(input: string): LaunchRequest {
	let text = input.trim();
	let model: string | undefined;
	const modelMatch = text.match(/(?:^|\s)--model\s+(\S+)/);
	if (modelMatch) {
		model = modelMatch[1];
		text = `${text.slice(0, modelMatch.index)} ${text.slice((modelMatch.index ?? 0) + modelMatch[0].length)}`.trim();
	}

	let cwd: string | undefined;
	const cwdMatch = text.match(/(?:^|\s)--cwd\s+(\S+)/);
	if (cwdMatch) {
		cwd = cwdMatch[1];
		text = `${text.slice(0, cwdMatch.index)} ${text.slice((cwdMatch.index ?? 0) + cwdMatch[0].length)}`.trim();
	}

	let direct = false;
	const directMatch = text.match(/(?:^|\s)--direct(?=\s|$)/);
	if (directMatch) {
		direct = true;
		text = `${text.slice(0, directMatch.index)} ${text.slice((directMatch.index ?? 0) + directMatch[0].length)}`.trim();
	}

	let research = false;
	const researchMatch = text.match(/(?:^|\s)(--research|-r)(?=\s|$)/);
	if (researchMatch) {
		research = true;
		text = `${text.slice(0, researchMatch.index)} ${text.slice((researchMatch.index ?? 0) + researchMatch[0].length)}`.trim();
	}

	let execute = false;
	const executeMatch = text.match(/(?:^|\s)(--execute|-e)(?=\s|$)/);
	if (executeMatch) {
		execute = true;
		text = `${text.slice(0, executeMatch.index)} ${text.slice((executeMatch.index ?? 0) + executeMatch[0].length)}`.trim();
	}

	let adaptive = false;
	const adaptiveMatch = text.match(/(?:^|\s)--adaptive(?=\s|$)/);
	if (adaptiveMatch) {
		adaptive = true;
		text = `${text.slice(0, adaptiveMatch.index)} ${text.slice((adaptiveMatch.index ?? 0) + adaptiveMatch[0].length)}`.trim();
	}

	let title: string | undefined;
	const titleMatch = text.match(/^-t\s+(\S+)(?:\s+(.*))?$/s);
	if (titleMatch) {
		title = titleMatch[1];
		text = (titleMatch[2] ?? "").trim();
		direct = true;
	}

	return { task: text, title, model, cwd, direct, research, execute, adaptive };
}

/**
 * 驱动器相对冒号归一（纯函数）：`C:a` → `C:/a`（Windows 上 `C:a` 是 drive-relative，
 * 与 `C:\a` 的 git 解析可能不同）；`C:\a` / `C:/a` / 非盘符路径原样返回。
 * 所有 git 调用前必须先归一（L4 M3：旧实现无 capture group 却用 `$1`，实测产出 `$1:/a`）。
 */
export function normalizeDriveColon(p: string): string {
	return p.replace(/^([A-Za-z]):(?![\\/])/g, "$1:/");
}

/**
 * Short repo name for tab titles.
 *
 * Priority: git origin remote basename (stable across main tree and worktrees)
 * → git toplevel basename → cwd path basename. Never throws.
 */
export function repoName(cwd: string): string {
	const norm = normalizeDriveColon(cwd);
	const tryGit = (args: string[]): string => {
		try {
			const out = execFileSync("git", ["-C", norm, ...args], {
				encoding: "utf8",
				shell: false,
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
			return out || "";
		} catch {
			return "";
		}
	};

	const origin = tryGit(["remote", "get-url", "origin"]);
	if (origin) {
		const clean = origin.replace(/^[a-zA-Z]+:\/\//, "").replace(/^.*@/, "").replace(/\.git$/, "");
		const base = clean.split(/[\\/]/).pop();
		if (base) return base;
	}

	const top = gitToplevel(norm);
	if (top) {
		const base = normalizeDriveColon(top).split(/[\\/]/).pop();
		if (base) return base;
	}

	return norm.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? cwd;
}

/** Git toplevel 的绝对路径（已去尾部分隔符）。永不抛错：非 git 仓 / 无 git / cwd 异常 → null。 */
export function gitToplevel(cwd: string): string | null {
	const norm = normalizeDriveColon(cwd);
	try {
		const out = execFileSync("git", ["-C", norm, "rev-parse", "--show-toplevel"], {
			encoding: "utf8",
			shell: false,
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return out ? out.replace(/[\\/]+$/, "") : null;
	} catch {
		return null;
	}
}

/** True when cwd sits inside a `worktrees/` directory (git worktree checkout). */
export function isWorktreePath(cwd: string): boolean {
	return cwd.split(/[\\/]/).some((p) => /^worktrees?$/.test(p));
}

/**
 * Label part of a tab title.
 *
 * Explicit title is used verbatim after stripping meaningless `pi-`/`wlc-`
 * prefixes; without a title the label is derived from the prompt's first
 * meaningful line (workflow prefix and markdown noise removed).
 */
export function taskTitleLabel(title: string | undefined, prompt: string): string {
	const raw = (title ?? "").trim();
	if (raw) {
		const cleaned = raw.replace(/^(?:pi-|wlc-|pi-wlc-)+/i, "").trim();
		if (cleaned) return cleaned;
	}
	const firstLine =
		prompt.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !/^(##|>|根据workflow进行工作|根据research进行工作|根据execute进行工作|根据adaptive进行工作)/.test(l)) ?? "";
	const label = firstLine
		.replace(/^[*#\-\s]+/, "")
		.replace(/^(?:Item\s+\d+\s*[—\-:]*\s*)/i, "")
		.replace(/[（(]P[0-9][）)]/g, "")
		.replace(/[。.!！]+$/, "")
		.slice(0, 24)
		.trim();
	return label || "task";
}

export interface LaunchTitleParts {
	repo: string;
	worktree: boolean;
	taskId: string;
	label: string;
}

/**
 * Canonical tab title: `<repo>[-worktree]-[<taskId>-]<label>`.
 *
 * Examples: `GreenCAD-123-Agent安全收口`, `GreenCAD-worktree-123-嵌套散布`,
 * `GreenCAD-路线创建向导` (single /launch without task id). No `wlc` defaults.
 */
export function composeLaunchTitle(parts: LaunchTitleParts): string {
	const wt = parts.worktree ? "-worktree" : "";
	const id = parts.taskId.trim() ? `${parts.taskId.trim()}-` : "";
	return `${parts.repo}${wt}-${id}${parts.label}`;
}

export function launchTaskTitle(task: LaunchTask, cwd: string): string {
	return sanitizeWtTitle(composeLaunchTitle({
		repo: repoName(cwd),
		worktree: isWorktreePath(cwd),
		taskId: task.taskId,
		label: taskTitleLabel(task.title, task.prompt),
	}));
}

/** @deprecated use launchTaskTitle; kept for backward compatibility. */
export function deriveLaunchTitle(task: string): string {
	return task.replace(/\s+/g, " ").slice(0, 30).trim() || "pi-task";
}

/** 任务会话模式：workflow（完整链路）| research（深度研究：只搜索 + 研究报告 + Wiki 维护）| execute（快速执行：结论已明确，跳过搜索与计划，实现→审查→Wiki 收尾）| adaptive（自适应：tab 启动时按任务书信息完备度自选链深 A0自执行快链/A快链/B中链/C全链）。 */
export type LaunchMode = "workflow" | "research" | "execute" | "adaptive";

export function modePrefix(taskId: string, mode: LaunchMode): string {
	if (mode === "research") return `根据research进行工作${taskId}`;
	if (mode === "execute") return `根据execute进行工作${taskId}`;
	if (mode === "adaptive") return `根据adaptive进行工作${taskId}`;
	return `根据workflow进行工作${taskId}`;
}

/** Keep the workflow contract stable even if the orchestrating model omits the prefix. */
export function normalizeWorkflowPrompt(task: LaunchTask, mode: LaunchMode = "workflow"): string {
	const taskId = task.taskId.trim();
	const prompt = task.prompt.trim();
	const prefix = modePrefix(taskId, mode);
	return prompt === prefix || prompt.startsWith(`${prefix}\n`) || prompt.startsWith(`${prefix}\r\n`)
		? prompt
		: `${prefix}\n\n${prompt}`;
}

/**
 * Mandatory workflow-discipline block for workflow-bound tabs.
 *
 * pi loads skills on demand and models may skip them, so the launched tab is
 * told in no uncertain terms to (1) read the workflow-orchestrator skill, (2)
 * act as the project manager and delegate stages to subagent-win agents instead
 * of completing the task in one shot, and (3) follow the Wiki/plans/recentwork
 * knowledge rules. Blockquoted lines are skipped by `taskTitleLabel`, so the
 * tab title keeps deriving from the handoff prompt's first meaningful line.
 */
export function workflowDisciplineBlock(taskId: string, skillPath?: string, mode: LaunchMode = "workflow"): string {
	const skillRef = skillPath
		? `read 技能文件 \`${skillPath}\``
		: "read 可用技能中的 `workflow-orchestrator`";
	// 【完成回报 · 强制】所有模式统一：收尾后必须 tab-finish 向主会话回报（不回报 = 未完成）
	const reportLine =
		`> ⚠️【完成回报 · 强制】全部工作（含 Wiki 收尾 / 研究报告 / 实现审查）完成后，你**必须**调用 \`tab-finish\` 向主会话回报：status=completed + summary（摘要）+ 交付物路径（artifacts / reportPath）。只有 tab-finish 写入 result.json 才会触发 event-bus 唤醒主会话去 reclaim 并编排下一批；不调 tab-finish = 未完成，主会话会一直等你。**绝不在未调用 tab-finish 的情况下直接结束回合。**`;
	const noNestedTabsLine =
		`> ⛔【禁止嵌套标签页】本会话是已派发的任务标签页，**严禁再调用 \`launch-tabs\` / \`/launch\` 开新标签页**；本 tab 的所有委派只能走 \`subagent-win\`（searcher/planner/implementer/code-reviewer等），收尾用 \`tab-finish\` 回报主会话。编排只属于主会话。`;
	if (mode === "research") {
		return [
			`> 【工作方式约束 · 强制 · 深度研究】本会话是深度研究任务会话（任务号 ${taskId}）：只做最大化搜索与研究，不做计划与实现。你必须按 workflow-orchestrator 技能的「深度研究模式（research-only）」执行：`,
			`> 1. 第一步 ${skillRef}，重点读「深度研究模式（research-only）」一节；流程：并行 searcher 最大化搜索（Wiki 第一站 → source_paths → codegraph → 主动维护主题页）→ 汇总 → 研究报告 → Wiki 收尾。`,
			`> 2. 你是研究项目经理：把主题按模块/目录/问题维度拆成多个并行 searcher 委派，最大化覆盖广度；禁止自己一路搜完；禁止进入 planner / plan-reviewer / implementer / code-reviewer 实现阶段（除非用户明确要求升级）。`,
			"> 3. 产出三样：① 研究报告 write 到 plans/YYYYMMDD_research_<topic>.md（事实表：代码位置 + Wiki 章节引用 + 校准状态 + 未决问题）；② Wiki 主题页维护（仅已验证的跨任务主题，改后调 wiki-nav rebuild）；③ 回复内给结论摘要。",
			`> 4. 任务临时发现只进回复或 plans/*_research.md；禁止 task${taskId}/Item/计划步骤进 Wiki；Wiki 只更新对应功能/主题正式页。`,
			"> 5. 模型选择遵守各 agent 的 config 默认 + fallback 链，不主动 override。",
			noNestedTabsLine,
			reportLine,
		].join("\n");
	}
	if (mode === "execute") {
		return [
			`> 【工作方式约束 · 强制 · 快速执行】本会话是执行任务会话（任务号 ${taskId}）：结论/方案已明确，跳过搜索与计划，直接落地实现。你必须按 workflow-orchestrator 技能的「快速执行模式（execute-only）」执行：`,
			`> 1. 第一步 ${skillRef}，重点读「快速执行模式（execute-only）」一节；流程：implementer 按交接结论/计划实现 → code-reviewer 审查修复 → Wiki 收尾（阶段 E3，可结论「无」）。`,
			`> 2. 你是执行项目经理：实现与审查委派给 subagent-win 的 implementer / code-reviewer；禁止自己一路干完，禁止重新调研或扩大范围。若交接材料缺失/矛盾（无结论、无计划、范围不明、结论与现状冲突），先回主会话/向用户确认，不要凭空设计。`,
			"> 3. 先 read 仓库根 AGENTS.md，再 read 交接材料（结论原文 / plans/ 路径 / research 报告 / Wiki 章节清单）；缺背景时可 read 交接材料引用的 Wiki 章节或文件补上下文，不做全量搜索。",
			`> 4. 任务临时发现只进回复或 plans/*_research.md；禁止 task${taskId}/Item/计划步骤进 Wiki；Wiki 只在长期契约变化时更新对应功能/主题正式页，改动后调 wiki-nav rebuild。`,
			"> 5. 模型选择遵守各 agent 的 config 默认 + fallback 链，不主动 override。",
			noNestedTabsLine,
			reportLine,
		].join("\n");
	}
	if (mode === "adaptive") {
		return [
			`> 【工作方式约束 · 强制 · 自适应】本会话是自适应工作流任务会话（任务号 ${taskId}）：链深不在派发时固定，由你在启动时按任务书信息完备度自评决定。你必须按 workflow-orchestrator 技能的「自适应模式（adaptive）」执行：`,
			`> 1. 第一步 ${skillRef}，重点读「自适应模式（adaptive）」一节；先 read 仓库根 AGENTS.md，再通读任务书。`,
			"> 2. 【首轮自评 · 必须声明】在首轮回复开头声明完备度档位与选择依据：",
			">    - **A0 自执行快链**（A 档条件 + 小任务边界：文件域 ≤3 文件、单模块、验收可直接跑通）：校验性核对 → 你（tab）自己 read 代码/改代码/跑验收命令，不派 implementer；中途仅在①跨模块架构取舍 ②方案冲突需第二模型视角 ③截图/视觉参照 三类事件时可用 subagent-win 派 consultant 咨询（每次咨询记入回报：问题+结论+影响，禁止例行化；咨询不能替代升档）；code-reviewer 独立审查必做（交 git diff，不交描述）→ Wiki 收尾。tab-finish 的 summary 必须含自执行记录 + 咨询记录（无则写「无」）+ 审查结论。",
			">    - **A 快链**（任务书四要素齐全：根因/结论+代码位置、方案方向、文件域、可测验收标准）：校验性核对（用 codegraph explore / read 快速验证任务书假设仍成立，≤3 轮工具调用，禁止重新调研）→ implementer 实现 → code-reviewer 审查 → Wiki 收尾。",
			">    - **B 中链**（缺验收标准或缺方案，但问题与域明确）：planner 出微型实施序 → plan-reviewer 快审（可并行）→ implementer → code-reviewer → Wiki 收尾。",
			">    - **C 全链**（仅问题描述）：标准完整链 搜索 → 计划 → 审查 → 实现 → 审查 → Wiki 收尾。",
			"> 3. 【升级规则】执行中发现任务书假设失效（文件/符号不存在、结论与现状冲突、验收不可测）：升级到更高档位并在回复中声明升级原因；降级禁止（A 档发现冗余也至少保留码审）。A0 档执行中超出小任务边界（文件扩散 >3 / 跨模块 / 假设失效）→ 剩余工作移交 implementer 或升 A/B/C 并声明。",
			"> 4. 你是项目经理：各阶段仍委派给 subagent-win 的 searcher / planner / plan-reviewer / implementer / code-reviewer；禁止自己一路干完；A0 自执行快链例外：允许自己实现（松执行、死审查——独立审查与审计链不省）；A 快链的校验性核对可自己做但仅限验证类工具。",
			`> 5. 任务临时发现只进回复或 plans/*_research.md；禁止 task${taskId}/Item/计划步骤进 Wiki；Wiki 只更新对应功能/主题正式页，改动后调 wiki-nav rebuild。`,
			"> 6. 模型选择遵守各 agent 的 config 默认 + fallback 链，不主动 override。",
			noNestedTabsLine,
			reportLine,
		].join("\n");
	}
	return [
		`> 【工作方式约束 · 强制】本会话是 workflow 的任务会话（任务号 ${taskId}），不是一次性实现任务。你必须按 workflow-orchestrator 技能执行完整工作流：`,
		`> 1. 第一步 ${skillRef}，严格遵循其流程：搜索 → 计划 → 审查 → 实现 → 审查 → Wiki 收尾（阶段 5 强制，可结论「无」）。`,
		"> 2. 你是项目经理：搜索/计划/实现/审查委派给 subagent-win 的 searcher / planner / plan-reviewer / implementer / code-reviewer；禁止自己一路干完，禁止跳过阶段。",
		"> 3. 先 read 仓库根 AGENTS.md，再按任务号定位交接材料（recentwork.md、plans/、Wiki/ 章节清单）。",
		`> 4. 任务临时发现只进回复或 plans/*_research.md；禁止 task${taskId}/Item/计划步骤进 Wiki；Wiki 只更新对应功能/主题正式页，改动后调 wiki-nav rebuild。`,
		"> 5. 模型选择遵守各 agent 的 config 默认 + fallback 链，不主动 override。",
		noNestedTabsLine,
		reportLine,
	].join("\n");
}

/**
 * Compose a workflow-, research- or execute-bound tab prompt:
 *
 *   根据workflow进行工作<taskId>   (mode: "workflow")
 *   根据research进行工作<taskId>   (mode: "research")
 *   根据execute进行工作<taskId>   (mode: "execute")
 *   根据adaptive进行工作<taskId>   (mode: "adaptive")
 *
 *   > 【工作方式约束 · 强制】…
 *
 *   <original handoff prompt, minus its own prefix if present>
 *
 * Requires a non-empty taskId; without one the prompt is only prefix-normalized
 * (plain /launch escape hatches with no task number stay unbounded).
 */
export function buildWorkflowTabPrompt(task: LaunchTask, skillPath?: string, mode: LaunchMode = "workflow"): string {
	const taskId = task.taskId.trim();
	const prompt = task.prompt.trim();
	const prefix = modePrefix(taskId, mode);
	if (!taskId) return normalizeWorkflowPrompt(task, mode);

	let rest = prompt;
	const alreadyPrefixed =
		rest === prefix ||
		rest.startsWith(`${prefix}\n`) ||
		rest.startsWith(`${prefix}\r\n`) ||
		rest.startsWith(`${prefix} `);
	if (alreadyPrefixed) rest = rest.slice(prefix.length).replace(/^\s*\r?\n?/, "").trim();

	const block = workflowDisciplineBlock(taskId, skillPath, mode);
	return rest ? `${prefix}\n\n${block}\n\n${rest}` : `${prefix}\n\n${block}`;
}

