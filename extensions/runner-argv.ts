/**
 * runner-argv — pi 子进程 argv 构造（纯函数，可单测）
 *
 * subagent-core 的第一块种子：把「调用选项 → pi CLI argv」的拼装从
 * index.ts 的 runSingle 中抽出，使 tool allowlist 语义可以被单元测试
 * 锁定，而不必真的 spawn 子进程。
 *
 * P2 修订原则（设计稿 §12）：
 *   - `tools` 只有调用方显式传入才生效（per-call opt-in）；未传时 argv
 *     完全不含 --tools，与历史行为逐字节一致——agent frontmatter 里的
 *     tools 声明继续只做展示，不作为硬约束来源（现有 agents/*.md 的
 *     frontmatter 含不存在的工具名，直接激活会造成 workflow 回归）。
 *   - `excludeTools` 在默认排他列表（防递归/防编排逃逸）基础上叠加。
 *   - pi 内置工具只有 read/bash/edit/write；没有独立的 grep/find/ls，
 *     搜索走 bash。窄 allowlist 示例：["read", "bash"]。
 */

/** 默认排他列表：子 agent 禁止再派发（防递归）、禁止 tab 编排、禁止计时器。 */
export const DEFAULT_EXCLUDE_TOOLS = [
	"subagent-win",
	"launch-tabs",
	"set-timer",
	"cancel-timer",
	"list-timers",
] as const;

/** per-call 工具策略（仅显式传入才生效）。 */
export interface RunnerToolsOptions {
	/** 正向 allowlist：传入则追加 `--tools <list>`；未传/空 → 不加该旗标。 */
	tools?: string[];
	/** 额外排他：叠加到 DEFAULT_EXCLUDE_TOOLS 之后，合并为单个 --exclude-tools。 */
	excludeTools?: string[];
}

export interface BuildPiArgvOptions extends RunnerToolsOptions {
	/** pi CLI 入口（findPiCli() 的产物）。 */
	cliPath: string;
	model?: string;
	thinking?: string;
	/** 追加系统提示（agent body 或调用方 systemPrompt，已 compose）。 */
	systemPrompt?: string;
	/** 首轮任务文本（恒为最后一个位置参数）。 */
	task: string;
}

/** 过滤空白项并去重（保序）。 */
function cleanList(list: string[] | undefined): string[] {
	if (!list || list.length === 0) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of list) {
		const v = typeof raw === "string" ? raw.trim() : "";
		if (v && !seen.has(v)) {
			seen.add(v);
			out.push(v);
		}
	}
	return out;
}

/**
 * 构造 `pi --mode json --print --no-session [flags] "Task: <task>"` 的 argv。
 * 旗标顺序固定，供测试断言；不含 cwd/env/spawn 等副作用。
 */
export function buildPiArgv(opts: BuildPiArgvOptions): string[] {
	const argv = [
		opts.cliPath,
		"--mode", "json", "--print", "--no-session",
	];
	const tools = cleanList(opts.tools);
	if (tools.length > 0) argv.push("--tools", tools.join(","));
	const exclude = [...DEFAULT_EXCLUDE_TOOLS, ...cleanList(opts.excludeTools)];
	argv.push("--exclude-tools", exclude.join(","));
	if (opts.model) argv.push("--model", opts.model);
	if (opts.thinking) argv.push("--thinking", opts.thinking);
	if (opts.systemPrompt) argv.push("--append-system-prompt", opts.systemPrompt);
	argv.push(`Task: ${opts.task}`);
	return argv;
}

/** 外部 CLI 后端是否支持 per-call tools allowlist（不支持——显式传入时应快速失败而非静默忽略）。 */
export function toolsSupportedForBackend(model: string | undefined, explicitTools: string[] | undefined): boolean {
	if (!explicitTools || explicitTools.length === 0) return true;
	if (!model) return true;
	// review 修正（Luna minor）：与 isExternalCliModel 同样做 trim+小写归一，
	// 避免 "CLI:CLAUDE" / 带空白写法绕过守卫导致 allowlist 被静默忽略。
	return !model.trim().toLowerCase().startsWith("cli:");
}
