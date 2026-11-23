/**
 * gui/src/toolCallSummary.ts — 工具调用「人话摘要」纯函数层（2026-11-17）。
 *
 * 背景（用户报）：思考与工具细节自动折叠是对的产品行为，不能撤；但折叠后每一行只剩
 * `bash 完成 / write 完成 / bash 出错`，用户根本看不出 agent 刚刚做了什么、现在在干什么。
 * 本模块把 toolCall 的 `name + arguments` 解析成一句**短人话**（「搜索「fusion-dispatch」」、
 * 「读取 transcript.ts」），由 ChatPage 的工具卡摘要行就地展示 —— 自动折叠原样保留。
 *
 * 纪律：
 * - **纯函数 / never-throw**：arguments 是模型产出，形状随时可能变（缺字段、JSON 字符串、
 *   null、数组），一律降级返回 null 让调用方回落到「只有工具名+状态」，绝不让渲染炸掉。
 * - **不猜**：解析不出动词就返回 null，不编造「执行了某操作」；摘要只描述**入参里确实有的事实**。
 * - **去敏**：token/secret/password 一类键的值永不进摘要（真机见过 master-attach 带 token）。
 * - **无副作用 / 零依赖**：可同时进 Vite 构建与 `node --experimental-strip-types` 单测。
 */

/** 摘要默认最大字数（超出截断；CSS 仍会按可用宽度二次省略，title 保留全文）。 */
export const TOOL_SUMMARY_MAX_CHARS = 80;

/**
 * 敏感键：候选键列表里的**二级**防线（当前列表没有这类键，主要为将来加键时兜底）。
 * 真正的内容级防线是下方 {@link scrubFinal} —— 它盖住「键名正常、值里带凭据」的情形，
 * 例如 `{url:"https://user:pass@host"}` 或 `curl -H "Authorization: Bearer sk-…"`。
 */
const SECRET_KEY = /(?:token|secret|password|passwd|api[-_]?key|private[-_]?key|authorization|cookie|credential|auth)/i;

/**
 * 集中式兜底脱敏（L4 B1 修复）：**所有分支的返回值**都过这一道。
 *
 * 为什么必须有这道：最初只按「键名」过滤 + 在 sanitizeCommand 里洗 `KEY=value`，
 * 于是 `curl -H "Authorization: Bearer sk-…"`、`apiKey=sk-…`、URL userinfo
 * `https://user:pass@host` 这类**值里带凭据**的写法全部原样进了摘要（还进 `title` DOM 属性）。
 * 修法不是在每个分支各自洗（必漏），而是在唯一出口统一洗。
 *
 * 顺序：先洗结构化写法（header / 赋值 / URL userinfo），最后洗已知高熵 token 前缀。
 * `(?!\*{3})` 防止二次匹配把已经打码的 `***` 又拼成 `***=*** ***`。
 */
const SCRUB_PATTERNS: readonly (readonly [RegExp, string])[] = [
	[/\bAuthorization\s*[:=]\s*(?:Bearer\s+)?(?!\*{3})[^\s,;"']+/gi, "Authorization: ***"],
	[/\bBearer\s+(?!\*{3})[A-Za-z0-9._~+/=-]+/gi, "Bearer ***"],
	[/\b(?:api[-_]?key|access[-_]?key|secret[-_]?key|private[-_]?key|passwd|password|credential|auth(?:orization)?|cookie|session|token)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|(?!\*{3})[^\s,;]+)/gi, "***=***"],
	[/(:\/\/)[^/@\s:]+:[^/@\s]+@/g, "$1***@"],
	[/\b(?:sk|pk|gh[pousr]|github_pat|xox[baprs]|ho)[-_][A-Za-z0-9_-]{8,}/gi, "***"],
];

function scrubFinal(summary: string): string {
	let out = summary;
	for (const [pattern, replacement] of SCRUB_PATTERNS) out = out.replace(pattern, replacement);
	return out;
}

/** 摘要候选键：按优先级取第一个非空字符串（覆盖真机统计到的工具参数形状）。 */
const GENERIC_TEXT_KEYS = [
	"task", "objective", "summary", "message", "query", "q", "pattern",
	"runId", "tabRunId", "taskId", "transferId", "timerId", "id",
	"url", "action", "label", "node", "name", "status",
] as const;

/** 非空的修剪后字符串。 */
function nonemptyString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}

/** arguments 归一成记录：真机几乎都是 object，但模型偶尔给 JSON 字符串 —— 也接住。 */
function toRecord(args: unknown): Record<string, unknown> | null {
	if (args !== null && typeof args === "object" && !Array.isArray(args)) {
		return args as Record<string, unknown>;
	}
	if (typeof args === "string") {
		try {
			const parsed: unknown = JSON.parse(args);
			if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
		} catch {
			// 非 JSON 字符串：不当作参数，返回 null
		}
	}
	return null;
}

/**
 * 所有空白（含换行）压成单空格，去掉双向控制符（U+202E 等可造成 Trojan-Source 视觉欺骗），
 * 再按**码点**截断（`slice` 会切断 emoji 的代理对，产生孤立代理）。
 */
function clip(text: string, max: number): string {
	const flat = text
		.replace(/[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	const chars = Array.from(flat);
	return chars.length <= max ? flat : `${chars.slice(0, max - 1).join("")}…`;
}

/** 路径缩到末两段（与 writeCard.splitPath 的「上一级 + 文件名」展示口径一致）。 */
function shortPath(raw: string, max: number): string {
	const normalized = raw.replace(/\\/g, "/").replace(/\/+$/, "");
	const segs = normalized.split("/").filter((s) => s !== "");
	const shown = segs.length > 2 ? `…/${segs.slice(-2).join("/")}` : normalized;
	return clip(shown || raw, max);
}

/** 记录里取第一个可用的非空字符串键（跳过敏感键）。 */
function firstText(record: Record<string, unknown>, keys: readonly string[]): string | null {
	for (const key of keys) {
		if (SECRET_KEY.test(key)) continue;
		const value = nonemptyString(record[key]);
		if (value !== null) return value;
	}
	return null;
}

/** 粗粒度 shell 分词：引号内的空格不拆（rg "foo bar" 要把 foo bar 当一个 pattern）。 */
function shellTokens(command: string): string[] {
	const tokens: string[] = [];
	const re = /"([^"]*)"|'([^']*)'|`([^`]*)`|(\S+)/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(command)) !== null) {
		tokens.push(match[1] ?? match[2] ?? match[3] ?? match[4] ?? "");
	}
	return tokens;
}

/** 去掉命令里的凭据赋值（export TOKEN=xxx / apiKey=… / AUTHORIZATION=…）与常见重定向噪声。 */
function sanitizeCommand(command: string): string {
	return command
		.replace(/\b[A-Za-z_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[-_]?KEY|PRIVATE[-_]?KEY|ACCESS[-_]?KEY|AUTHORIZATION|COOKIE|CREDENTIAL|AUTH)[A-Za-z_]*\s*=\s*(?:"[^"]*"|'[^']*'|\S+)/gi, "***=***")
		.replace(/\b\d?>\s*\/?dev\/?null\b/gi, "")
		.replace(/\b2>&1\b/g, "");
}

/** bash 摘要：认得的高频命令给「动词 + 目标」，其余给「执行 + 命令片段」。 */
function summarizeBash(command: string, max: number): string | null {
	const firstLine = command.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "") ?? "";
	if (firstLine === "") return null;
	// 去敏后的整串是**所有分支的唯一文本源**：只洗 tokens 却在 fallback 回放原文 = 凭据泄漏
	const sanitized = sanitizeCommand(firstLine);
	const tokens = shellTokens(sanitized);
	const head = tokens[0] ?? "";
	// 多段管道/串联（ls ... | head -5）：只看第一段主命令，噪声段不进摘要
	const positional = tokens.slice(1).filter((t) => !t.startsWith("-") && t !== "");
	const target = positional[0] ?? "";
	const pathTarget = target === "" ? "" : shortPath(target, Math.max(16, max - 8));

	// grep/rg 搜索：把 pattern 摆在动词位（用户最想看到的就是搜了什么）
	if (head === "grep" || head === "rg" || head === "findstr") {
		const pattern = clip(target, Math.max(12, max - 6));
		return pattern === "" ? "搜索" : `搜索「${pattern}」`;
	}
	// find：有 -name 时更关心文件名模式，否则关心起点目录
	if (head === "find") {
		const nameIdx = tokens.findIndex((t) => t === "-name" || t === "-iname");
		const namePattern = nameIdx >= 0 ? tokens[nameIdx + 1] : undefined;
		if (namePattern) return `查找 ${clip(namePattern, Math.max(12, max - 4))}`;
		return pathTarget === "" ? "查找文件" : `查找 ${pathTarget}`;
	}
	if (head === "ls" || head === "dir") return pathTarget === "" ? "列出目录" : `列出 ${pathTarget}`;
	// sed/awk 的文件在**最后一个**位置参数（`sed -n '1680,2050p' path/file.ts`）
	if (head === "sed" || head === "awk") {
		const filePath = positional[positional.length - 1] ?? "";
		return filePath === "" ? "查看文件" : `查看 ${shortPath(filePath, Math.max(16, max - 8))}`;
	}
	if (["cat", "head", "tail", "less", "more", "type", "Get-Content"].includes(head)) {
		return pathTarget === "" ? "查看文件" : `查看 ${pathTarget}`;
	}
	if (head === "git") {
		const sub = positional[0] ?? "";
		if (sub === "grep") {
			const pattern = positional[1] ?? "";
			return pattern === "" ? "git 搜索" : `git 搜索「${clip(pattern, Math.max(12, max - 8))}」`;
		}
		return sub === "" ? "git 命令" : `git ${clip(sub, 20)}`;
	}
	if (head === "curl" || head === "wget") {
		return target === "" ? "网络请求" : `请求 ${clip(target, max - 3)}`;
	}
	if (["mkdir", "rmdir"].includes(head)) return pathTarget === "" ? "操作目录" : `目录 ${pathTarget}`;
	if (head === "rm") return pathTarget === "" ? "删除文件" : `删除 ${pathTarget}`;
	if (["cp", "mv"].includes(head)) {
		return positional.length < 2 ? `${head} 文件` : `${head} ${pathTarget} → ${shortPath(positional[1] ?? "", 24)}`;
	}
	if (["npm", "pnpm", "yarn", "node", "python", "python3", "npx"].includes(head)) {
		return `运行 ${clip(sanitized, max - 3)}`;
	}
	return `执行 ${clip(sanitized, max - 3)}`;
}

/**
 * 生成工具调用的人话摘要。
 *
 * @returns 短句（如「搜索「fusion-dispatch」」「读取 transcript.ts」）；解析不出来返回 null。
 */
export function describeToolCall(name: string, args: unknown, max: number = TOOL_SUMMARY_MAX_CHARS): string | null {
	try {
		/** 唯一出口：任何分支产出的摘要都过同一道脱敏（L4 B1：分支各自洗必漏）。 */
		const finish = (summary: string | null): string | null => (summary === null ? null : scrubFinal(summary));
		const limit = Number.isFinite(max) && max >= 12 ? Math.floor(max) : TOOL_SUMMARY_MAX_CHARS;
		const record = toRecord(args);
		if (name === "bash") {
			return finish(summarizeBash(nonemptyString(record?.command) ?? "", limit));
		}
		// write 卡自带「路径 + 行数/体积」专属摘要行，这里不重复输出（零回归面）
		if (name === "write") return null;
		if (record === null) return null;

		// 读/改：动词 + 路径（路径缺失时不编造）
		if (name === "read" || name === "edit") {
			const rawPath = firstText(record, ["path", "file_path", "file", "filePath"]);
			if (rawPath === null) return null;
			const verb = name === "read" ? "读取" : "编辑";
			const detail = name === "edit" && Array.isArray(record.edits) ? ` · ${record.edits.length} 处` : "";
			return finish(`${verb} ${shortPath(rawPath, Math.max(16, limit - verb.length - detail.length - 1))}${detail}`);
		}
		// codegraph 等检索工具：查询词优先
		if (name === "codegraph" || name === "grep" || name === "search" || name === "wiki-nav") {
			const query = firstText(record, ["query", "q", "pattern", "queries", "node"]);
			if (query === null) return null;
			return finish(`${name === "codegraph" ? "查询" : "搜索"}「${clip(query, Math.max(12, limit - 6))}」`);
		}
		// 其余工具：拿最有信息量的文本字段当后缀（subagent-win.task、tab-status.runId…）
		const text = firstText(record, GENERIC_TEXT_KEYS);
		return finish(text === null ? null : `${name} · ${clip(text, Math.max(12, limit - name.length - 3))}`);
	} catch {
		// 契约：never-throw —— 任何形状异常都退化为「无摘要」
		return null;
	}
}
