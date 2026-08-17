import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

	let title: string | undefined;
	const titleMatch = text.match(/^-t\s+(\S+)(?:\s+(.*))?$/s);
	if (titleMatch) {
		title = titleMatch[1];
		text = (titleMatch[2] ?? "").trim();
		direct = true;
	}

	return { task: text, title, model, cwd, direct, research, execute };
}

/**
 * Short repo name for tab titles.
 *
 * Priority: git origin remote basename (stable across main tree and worktrees)
 * → git toplevel basename → cwd path basename. Never throws.
 */
export function repoName(cwd: string): string {
	const tryGit = (args: string[]): string => {
		try {
			const out = execFileSync("git", ["-C", cwd, ...args], {
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

	const top = tryGit(["rev-parse", "--show-toplevel"]);
	if (top) {
		const base = top.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
		if (base) return base;
	}

	return cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? cwd;
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
		prompt.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !/^(##|>|根据workflow进行工作|根据research进行工作|根据execute进行工作)/.test(l)) ?? "";
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
	return composeLaunchTitle({
		repo: repoName(cwd),
		worktree: isWorktreePath(cwd),
		taskId: task.taskId,
		label: taskTitleLabel(task.title, task.prompt),
	});
}

/** @deprecated use launchTaskTitle; kept for backward compatibility. */
export function deriveLaunchTitle(task: string): string {
	return task.replace(/\s+/g, " ").slice(0, 30).trim() || "pi-task";
}

/** 任务会话模式：workflow（完整链路）| research（深度研究：只搜索 + 研究报告 + Wiki 维护）| execute（快速执行：结论已明确，跳过搜索与计划，实现→审查→Wiki 收尾）。 */
export type LaunchMode = "workflow" | "research" | "execute";

export function modePrefix(taskId: string, mode: LaunchMode): string {
	if (mode === "research") return `根据research进行工作${taskId}`;
	if (mode === "execute") return `根据execute进行工作${taskId}`;
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
	if (mode === "research") {
		return [
			`> 【工作方式约束 · 强制 · 深度研究】本会话是深度研究任务会话（任务号 ${taskId}）：只做最大化搜索与研究，不做计划与实现。你必须按 workflow-orchestrator 技能的「深度研究模式（research-only）」执行：`,
			`> 1. 第一步 ${skillRef}，重点读「深度研究模式（research-only）」一节；流程：并行 searcher 最大化搜索（Wiki 第一站 → source_paths → codegraph → 主动维护主题页）→ 汇总 → 研究报告 → Wiki 收尾。`,
			`> 2. 你是研究项目经理：把主题按模块/目录/问题维度拆成多个并行 searcher 委派，最大化覆盖广度；禁止自己一路搜完；禁止进入 planner / plan-reviewer / implementer / code-reviewer 实现阶段（除非用户明确要求升级）。`,
			"> 3. 产出三样：① 研究报告 write 到 plans/YYYYMMDD_research_<topic>.md（事实表：代码位置 + Wiki 章节引用 + 校准状态 + 未决问题）；② Wiki 主题页维护（仅已验证的跨任务主题，改后调 wiki-nav rebuild）；③ 回复内给结论摘要。",
			`> 4. 任务临时发现只进回复或 plans/*_research.md；禁止 task${taskId}/Item/计划步骤进 Wiki；Wiki 只更新对应功能/主题正式页。`,
			"> 5. 模型选择遵守各 agent 的 config 默认 + fallback 链，不主动 override。",
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
		reportLine,
	].join("\n");
}

/**
 * Compose a workflow-, research- or execute-bound tab prompt:
 *
 *   根据workflow进行工作<taskId>   (mode: "workflow")
 *   根据research进行工作<taskId>   (mode: "research")
 *   根据execute进行工作<taskId>   (mode: "execute")
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

export interface PiLaunchArgsOptions {
	cwd: string;
	piCli: string;
	execPath: string;
	model?: string;
	/**
	 * Skill roots/files guaranteed via --skill (canonical-path deduped against
	 * package-registered skills, so passing the same skills/ root is a no-op
	 * guarantee rather than a duplicate).
	 */
	skills?: string[];
	/** 标签页回收身份（--tab-run-id <runId>，可靠传递，不依赖 env 继承）。 */
	tabRunId?: string;
}

/** Build argv as an array so prompts are never split or reinterpreted by a shell. */
export function buildWindowsTerminalArgs(
	terminalTitle: string,
	prompt: string,
	options: PiLaunchArgsOptions,
): string[] {
	const piArgs = [options.piCli];
	if (options.model) piArgs.push("--model", options.model);
	for (const skill of options.skills ?? []) piArgs.push("--skill", skill);
	if (options.tabRunId) piArgs.push("--tab-run-id", options.tabRunId);
	piArgs.push(prompt);
	return [
		"-w", "0",
		"new-tab",
		"--title", terminalTitle,
		"--suppressApplicationTitle",
		"-d", options.cwd,
		options.execPath,
		...piArgs,
	];
}

// ── wt 命令行 prompt 物化（2026-08-13：修复多开无用 tab）───────────────

/** 派发 prompt 的临时目录（~/.pi/agent/launch-prompts）。 */
export function wtPromptDir(): string {
	return join(homedir(), ".pi", "agent", "launch-prompts");
}

/**
 * wt.exe 会用自己的 tokenizer 重解析命令行：含换行的参数会被拆成多条命令，
 * 剩余行变成标题/内容都是 prompt 残留的无用 tab（实证：派发 workflow tab 几乎必现）。
 * 引号/分号/百分号同理有风险（wt 会做引号与 %env% 展开）。
 */
const WT_RISKY_CHARS = /[\r\n;"%]/;

/**
 * 生成传给 wt 命令行的 prompt 参数：凡含风险字符的 prompt 一律物化为临时 @file
 * （pi 原生支持 `pi @file.md` 把文件内容作为首轮消息），命令行上只留一个不含换行的
 * `@路径`；安全单行 prompt 保持内联（零行为变化）。
 */
export function wtPromptArg(prompt: string, key?: string): string {
	if (!WT_RISKY_CHARS.test(prompt)) return prompt;
	const dir = wtPromptDir();
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `pi-launch-${key ?? `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`}.md`);
	writeFileSync(file, prompt, "utf8");
	// 尽力清理：5 分钟后删除（pi 启动早期即读完文件，删除不阻塞）；顺带清理 24h 前陈旧文件
	setTimeout(() => { try { rmSync(file, { force: true }); } catch { /* 清理尽力而为 */ } }, 5 * 60_000).unref?.();
	sweepStaleWtPrompts();
	return `@${file}`;
}

/** 清理超 24h 的陈旧派发 prompt 文件（防 launch-prompts 目录膨胀）。 */
export function sweepStaleWtPrompts(maxAgeMs: number = 24 * 60 * 60 * 1000): number {
	const dir = wtPromptDir();
	let swept = 0;
	try {
		for (const f of readdirSync(dir)) {
			if (!f.startsWith("pi-launch-") || !f.endsWith(".md")) continue;
			try {
				if (Date.now() - statSync(join(dir, f)).mtimeMs > maxAgeMs) {
					rmSync(join(dir, f), { force: true });
					swept++;
				}
			} catch { /* 单个失败无碍 */ }
		}
	} catch { /* 目录不存在等 */ }
	return swept;
}

/** 删除指定 `@file` 参数对应的临时文件（测试/手动清理用）。 */
export function cleanupWtPromptArg(arg: string): void {
	if (!arg.startsWith("@")) return;
	try { rmSync(arg.slice(1), { force: true }); } catch { /* 尽力而为 */ }
}

