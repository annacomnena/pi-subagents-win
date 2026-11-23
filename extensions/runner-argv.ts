/**
 * runner-argv — pi 子进程 argv 构造（纯函数，可单测）
 *
 * subagent-core 的第一块种子：把「调用选项 → pi CLI argv」的拼装从
 * index.ts 的 runSingle 中抽出，使 tool allowlist 语义可以被单元测试
 * 锁定，而不必真的 spawn 子进程。
 *
 * 工具隔离契约（2026-11-13 角色工具优化计划）：
 *   - 区分缺省（undefined）、显式空列表（[]，表示零活动工具）与非空列表。
 *   - 缺省时 argv 完全不含 --tools，保持既有默认工具行为；
 *   - 显式空列表追加 `--tools ""`，在 Windows 命令行下激活 Pi 零工具模式；
 *   - 非空列表追加 `--tools <list>`，顺序固定在 --exclude-tools 之前。
 *   - 角色工具上限与调用方工具策略通过 resolveEffectiveTools 合并，
 *     调用方只能选择角色上限的子集，严禁越界扩权。
 *   - 外部 CLI 后端（cli:*）只接受「角色 frontmatter 声明」而不接受「调用方显式工具策略」：
 *     前者是角色在 pi 里的能力上限，对第三方 CLI 无意义 ⇒ **豁免**（否则任何声明了 tools 的
 *     角色都永远无法走 cli:*）；后者是本次派发的真实工具约束，CLI 无法遵守 ⇒ **仍然拒绝**
 *     （不得静默放宽，否则调用方会以为收窄了实际没窄）。
 */

/** 默认排他列表：子 agent 禁止再派发（防递归）、禁止 tab 编排、禁止计时器；
 *  local-master-ensure（0924）入列 = 「启动他会话」的纵深防线（工具内 isSubagent 硬挡是第一道）。 */
export const DEFAULT_EXCLUDE_TOOLS = [
	"subagent-win",
	"launch-tabs",
	"set-timer",
	"cancel-timer",
	"list-timers",
	"local-master-ensure",
] as const;

/**
 * 已知受管工具清单（Pi 内置工具与本仓/宿主已知扩展工具）：
 * 受管角色只接受精确名称，拒绝通配符模式（*）和修饰符（+/-）。
 */
export const KNOWN_MANAGED_TOOLS = new Set([
	// Pi 内置核心与只读工具
	"read", "bash", "edit", "write", "grep", "find", "ls", "powershell",
	// subagent-win 扩展注册工具及常见内置/宿主扩展工具
	"codegraph", "wiki-nav", "hotspot", "trace-fusion", "subagent-win", "launch-tabs",
	"tab-finish", "tab-report", "tab-status", "reclaim-tabs",
	"tab-steer", "steer-status", "supervise-push",
	"master-status", "master-handoff", "master-attach", "master-detach", "master-cutover",
	"master-transfer", "master-transfer-confirm", "master-pressure", "master-dispatch",
	"local-master-ensure", "global-view",
	"set-timer", "cancel-timer", "list-timers",
	"get_goal", "create_goal", "update_goal", "ds_websearch",
]);

/**
 * 校验并解析 Agent frontmatter 的 tools 声明。
 *
 * 契约：
 * 1. 若 raw 为 undefined/null，返回 undefined（表示未声明）。
 * 2. 显式空字符串/空数组表示显式空列表 []（零工具上限）。
 * 3. 受管角色只接受精确名称；拒绝通配符（*）、修饰符（+/-）或未注册的未知工具名称。
 *    若发现非法项，抛出包含角色名与问题条目的 Error。
 */
export function parseAgentTools(raw: unknown, roleName?: string): string[] | undefined {
	if (raw === undefined || raw === null) return undefined;
	let items: string[] = [];
	if (typeof raw === "string") {
		const trimmed = raw.trim();
		if (!trimmed) return [];
		items = trimmed.split(",").map((s) => s.trim());
	} else if (Array.isArray(raw)) {
		items = raw.map((s) => (typeof s === "string" ? s.trim() : ""));
	} else {
		throw new Error(`[agent:${roleName ?? "unknown"}] tools 声明格式错误：期望字符串或数组，收到 ${typeof raw}`);
	}

	const seen = new Set<string>();
	const cleaned: string[] = [];
	for (const item of items) {
		if (!item) continue;
		if (item.startsWith("+") || item.startsWith("-")) {
			throw new Error(`[agent:${roleName ?? "unknown"}] tools 声明不支持修饰符 "${item}"，受管角色仅接受精确工具名称`);
		}
		if (item.includes("*")) {
			throw new Error(`[agent:${roleName ?? "unknown"}] tools 声明不支持通配符模式 "${item}"，受管角色仅接受精确工具名称`);
		}
		if (!KNOWN_MANAGED_TOOLS.has(item)) {
			throw new Error(`[agent:${roleName ?? "unknown"}] 未知受管工具名称 "${item}"，请核对 Pi 内置工具与扩展注册工具`);
		}
		if (!seen.has(item)) {
			seen.add(item);
			cleaned.push(item);
		}
	}
	return cleaned;
}

/**
 * 合并角色工具上限与调用方工具策略。
 *
 * 规则：
 * 1. 两处都缺省（roleTools === undefined && callerTools === undefined）→ 返回 undefined（保持现有全量行为）。
 * 2. 仅有角色上限（roleTools !== undefined && callerTools === undefined）→ 返回 roleTools。
 * 3. 仅有调用方列表（roleTools === undefined && callerTools !== undefined）→ 返回 cleanList(callerTools)（支持显式空列表 [] 表示零工具）。
 * 4. 两处都存在：调用方传入必须是角色上限的子集！若调用方出现角色上限之外的工具，报错拒绝越权。
 */
export function resolveEffectiveTools(
	roleTools: string[] | undefined,
	callerTools: string[] | undefined,
	roleName?: string,
): string[] | undefined {
	if (roleTools === undefined && callerTools === undefined) {
		return undefined;
	}
	if (roleTools !== undefined && callerTools === undefined) {
		return [...roleTools];
	}
	if (roleTools === undefined && callerTools !== undefined) {
		return cleanList(callerTools);
	}
	// 两处都存在：校验子集
	const cleanedCaller = cleanList(callerTools);
	const roleSet = new Set(roleTools!);
	const invalid = cleanedCaller.filter((tool) => !roleSet.has(tool));
	if (invalid.length > 0) {
		throw new Error(
			`[agent:${roleName ?? "unknown"}] 调用方请求的工具 [${invalid.join(", ")}] 超出角色声明的工具上限 [${roleTools!.join(", ")}]，禁止越界扩权`,
		);
	}
	return cleanedCaller;
}

/** 工具策略选项。 */
export interface RunnerToolsOptions {
	/** 正向 allowlist：传入非 undefined 则追加 `--tools <list>`；undefined 则不加该旗标；[] 表示零活动工具。 */
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
export function cleanList(list: string[] | undefined): string[] {
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
	if (opts.tools !== undefined) {
		const tools = cleanList(opts.tools);
		// 显式空列表（零活动工具）使用 "" 编码穿过 Windows argv
		argv.push("--tools", tools.join(","));
	}
	const exclude = [...DEFAULT_EXCLUDE_TOOLS, ...cleanList(opts.excludeTools)];
	argv.push("--exclude-tools", exclude.join(","));
	if (opts.model) argv.push("--model", opts.model);
	if (opts.thinking) argv.push("--thinking", opts.thinking);
	if (opts.systemPrompt) argv.push("--append-system-prompt", opts.systemPrompt);
	argv.push(`Task: ${opts.task}`);
	return argv;
}

/**
 * 外部 CLI 后端是否能接受本次派发的工具策略。
 *
 * 三种「有工具策略」的来源必须分开看（2026-11-18 业主裁决「tool 声明豁免第三方 CLI」）：
 *
 * 1. **角色 frontmatter 的 `tools:`** —— 描述「该角色在 pi 里能碰哪些工具」，是角色身份属性。
 *    第三方 CLI 自带工具系统，这个列表对它**没有约束力也没有意义**。把它算成工具策略的结果是
 *    任何声明了 tools 的角色（searcher/planner/implementer/code-reviewer/general/fusion/consultant）
 *    **永远**无法路由到 cli:* —— 只剩 codex-runner 一个逃生口，等于把「角色选择」与「后端选择」
 *    硬绑死。⇒ **豁免**。
 *
 * 2. **调用方显式传的 `tools`** —— 这是「本次派发请你限制工具」的真实意图。CLI 无法执行 Pi 的
 *    allowlist，若静默忽略，调用方会以为收窄了而实际没窄（安全误导）⇒ **仍然拒绝**。
 *
 * 3. **显式空列表 `[]`** —— 「零活动工具」，同样属于调用方显式意图，同样是 CLI 无法保证的 ⇒ 拒绝。
 *
 * @param model 目标模型 ref（`cli:*` 走豁免判定）
 * @param effectiveTools `resolveEffectiveTools` 的合并结果（可为 undefined）
 * @param callerTools 调用方**显式**传入的 tools（undefined = 未传 = 只有角色声明）
 */
export function toolsSupportedForBackend(
	model: string | undefined,
	effectiveTools: string[] | undefined,
	callerTools?: string[] | undefined,
): boolean {
	if (effectiveTools === undefined) return true;
	if (!model) return true;
	// review 修正（Luna minor）：与 isExternalCliModel 同样做 trim+小写归一，
	// 避免 "CLI:CLAUDE" / 带空白写法绕过守卫导致 allowlist 被静默忽略。
	if (!model.trim().toLowerCase().startsWith("cli:")) return true;
	// 外部 CLI：只有「角色声明」时豁免；调用方显式策略（含 []）一律拒。
	return callerTools === undefined;
}