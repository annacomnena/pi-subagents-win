/**
 * lane validation 复跑（2026-11-02，fusion 试验暴露的盲区）
 *
 * 起因：run `tfl-20261102-162039-c2f5` 的 lane B 写了 4 条 validation，**4/4 自称 `pass`，
 * 我逐条复跑实测 4/4 失败**（exit 1/2/1/2，`output_excerpt` 全空）。而 Fusion Packet 的
 * Hard Facts 只数「带 command 条数」（=4），**从不执行它们** —— packet 的 Instruction 明写
 * 「可执行证据压过自报置信度」，harness 并没有兑现这句话。
 *
 * 本模块做那件 harness 一直没做的事：**机械复跑 lane 自己声明的验证命令**，把真实
 * exit code 写进 Hard Facts。确定性、零模型调用。
 *
 * ## 安全面（必须读）
 *
 * 这些命令是**模型写的**。collect 是后台 worker，有仓库与用户权限 ⇒ 复跑 = 执行模型生成的
 * 命令。因此：
 *  1. **只跑只读命令**。命中禁用面（删除/写重定向/写 git/装包/网络落盘/进程与电源控制…）
 *     一律**拒绝执行**，并在产出里显式披露（R-2：降级不得静默）。
 *  2. 允许 `> /dev/null` / `> nul` 这类丢弃型重定向（实测 lane 会写 `cat x > /dev/null`）。
 *  3. 每条命令有超时（缺省 20s）+ 每 lane 有总预算（缺省 90s），预算用尽后剩余记
 *     `budget-exhausted`，不无限跑。
 *  4. 工作目录 = `meta.repoRoot`（lane 命令里 `lanes/B/...` 这类相对路径**会**失败——
 *     这正是要暴露的：lane 自报的 pass 站不住就应显示站不住）。
 *  5. 输出截断（缺省 400 字符），不进主会话上下文。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { LaneId } from "./types.ts";

export interface ReplayCmdResult {
	index: number;
	command: string;
	claimedResult: string;
	/** 实测退出码；拒绝执行/预算耗尽时为 null。 */
	exitCode: number | null;
	/** 摘要输出（stdout+stderr，截断）。 */
	excerpt: string;
	status: "ran" | "refused-non-readonly" | "refused-main-root" | "timeout" | "budget-exhausted" | "no-command";
	/** 声称 pass 而实测非 0 ⇒ true（packet 里最该看的一列）。 */
	claimedPassButFailed: boolean;
}

export interface LaneReplayFacts {
	lane: LaneId;
	total: number;
	ran: number;
	failed: number;
	/** 自报 pass 且实测失败的条数（自报可信度）。 */
	claimedPassButFailed: number;
	refused: number;
	timedOut: number;
	results: ReplayCmdResult[];
	/** 2026-11-02 安全边界：本 lane 命令的**实际执行目录**（必须是隔离工作目录）。 */
	cwdUsed?: string;
	/** 执行目录说明（隔离工作目录 / 主仓库被拒 / 无隔离目录）。 */
	cwdNote?: string;
}

export interface ReplayOptions {
	runDir: string;
	lane: LaneId;
	/** 命令工作目录（兼容旧参数名；缺省执行目录）。 */
	repoRoot: string;
	/**
	 * 执行目录（2026-11-02 #1）：优先用 lane 自己的隔离工作目录。
	 * 与 `mainRoot` 归一化相等 ⇒ **整 lane 拒执行**（主仓库绝不跑模型生成的命令）。
	 */
	cwd?: string;
	/** 主仓库根（命中即拒）；不传 = 不启用主仓库拒绝门（旧行为）。 */
	mainRoot?: string;
	/** 执行 seam（测试注入）。缺省 = spawnSync(shell)。 */
	exec?: (cmd: string, cwd: string, timeoutMs: number) => { exitCode: number | null; timedOut: boolean; stdout: string; stderr: string };
	timeoutMs?: number;
	totalBudgetMs?: number;
	/** 输出摘要截断长度。 */
	excerptChars?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_BUDGET_MS = 90_000;
const DEFAULT_EXCERPT_CHARS = 400;

/**
 * 只读判据（两道门，2026-11-02 安全边界修复 #1）。
 *
 * 门 1：**白名单**（新增）。命令的每一段（按 `|`/`&&`/`||`/`;`/换行切）的**首词**必须在
 * 只读命令集里；`git` 还要求子命令在只读子命令集里；解释器只允许「跑文件」不允许内联代码。
 * 不在名单 ⇒ 拒（理由写明哪个词不在名单）。
 *
 * 门 2：**黑名单**（原有已知破坏面）兼容保留：命中删除/git 写/装包/网络/进程电源/提权/
 * 写重定向/管道给解释器 ⇒ 拒。
 *
 * 为什么必须有门 1：门 2 只能拦住**我们想得到**的破坏面；模型写出的命令里出现我们没列到的
 * 工具（如 `git filter-branch`、`icacls`、`reg export`、自制脚本里自带 rm）时，旧版**默认放行**。
 * 主仓库里跑模型生成的命令 ⇒ 默认放行不可接受。
 */
const READONLY_HEADS = new Set([
	"ls", "dir", "pwd", "echo", "cat", "type", "head", "tail", "wc", "sort", "uniq", "cut", "tr", "nl",
	"grep", "rg", "egrep", "fgrep", "find", "fd", "tree", "stat", "file", "du", "df", "lslocks", "which", "where", "whereis",
	"basename", "dirname", "realpath", "readlink", "diff", "cmp", "comm", "strings", "od", "hexdump", "xxd", "md5sum", "sha1sum", "sha256sum",
	"sed", "awk", "gawk", "jq", "yq", "column", "fold", "tr",
	"git", "svn", "jq", "tar", "unzip", "gzip", "less", "more",
	"cd", "pushd", "popd", "env", "set", "export", "timeout", "time", "sleep", "true", "false", "test", "[", "printf",
	"node", "bun", "deno", "python", "python3", "py", "pwsh", "powershell", "cmd", "bash", "sh", "npx", "npm", "pnpm", "yarn", "go", "cargo", "make", "dotnet", "mvn", "gradle",
]);

/** git 只读子命令（不在表里的 git 子命令一律拒，包括 `git filter-branch`/`git worktree add` 等）。 */
const GIT_READONLY_SUBS = new Set([
	"show", "log", "diff", "status", "ls-files", "ls-tree", "blame", "grep", "cat-file", "rev-parse",
	"describe", "shortlog", "merge-base", "merge-tree", "config", "remote", "branch", "tag", "show-ref",
	"for-each-ref", "name-rev", "reflog", "count-objects", "hash-object", "verify-object", "verify-commit",
	"verify-tag", "annotate", "cherry", "whatchanged", "version", "help",
]);

/** 解释器：只允许「跑已存在的脚本文件」，不得内联代码；脚本后缀限白名单。 */
const SCRIPT_RUNNERS = new Set(["node", "bun", "deno", "python", "python3", "py", "npx", "npm", "pnpm", "yarn", "go", "cargo", "make", "dotnet", "mvn", "gradle"]);
const SCRIPT_SUFFIXES = /\.(ts|mts|cts|js|mjs|cjs|py|json|md|sql|ps1|sh|bat)\b/i;
const SEG_SPLIT = /\s*(?:\|(?![^\s|]*\|)|&&|\|\||;|\n)\s*/;
const FORBIDDEN: Array<{ re: RegExp; why: string }> = [
	{ re: /\b(rm|rmdir|del|erase|rd)\b/, why: "删除" },
	{ re: /\bRemove-Item\b|\bresrmdir\b/i, why: "删除" },
	{ re: /\bformat\b|\bmkfs\b|\bdd\b\s+if=/i, why: "磁盘级写入" },
	{ re: /\bgit\b[^\n]*\b(reset|checkout|clean|apply|push|commit|merge|rebase|stash|rm|mv|gc)\b/, why: "git 写操作" },
	{ re: /\b(npm|pnpm|yarn|bun|pip|uv|cargo|go|dotnet|nuget|choco|winget|scoop)\b[^\n]*\b(install|uninstall|publish|link|add|update|ci)\b/i, why: "装包/发布" },
	{ re: /\b(mv|cp|rsync|move|copy|ren)\b/i, why: "移动/覆盖文件" },
	{ re: /\b(chmod|chown|setfacl|icacls|attrib)\b/i, why: "权限改动" },
	{ re: /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod)\b/i, why: "网络访问" },
	{ re: /\b(taskkill|Stop-Process|kill|pkill|shutdown|restart-computer|Stop-Computer)\b/i, why: "进程/电源控制" },
	{ re: /\b(sudo|runas|Start-Process|Start-Service|Stop-Service|sc\s+config|reg\s+add|reg\s+delete|Set-ItemProperty)\b/i, why: "提权/系统改动" },
	{ re: /\b(New-Item|Set-Content|Add-Content|Out-File|Out-Null\b)\b/i, why: "写文件" },
	{ re: /\b(mkdir|touch|truncate)\b/i, why: "建文件" },
	{ re: /\b(npx|node|python|pwsh|powershell|bash|sh|cmd|perl|ruby)\b[^\n]*-[ce]\b/i, why: "解释器内联代码" },
	{ re: /(^|[^<>])>>?(?! *(\/dev\/null|nul\b|NUL\b))/, why: "写重定向" },
	{ re: /\|\s*(sh|bash|pwsh|powershell|cmd)\b/i, why: "管道给解释器" },
];

export function readonlyVerdict(cmd: string): { ok: boolean; why?: string } {
	// 门 2（黑名单，已知破坏面）：优先报「为什么危」，比「不认识」更可操作
	for (const f of FORBIDDEN) {
		if (f.re.test(cmd)) return { ok: false, why: f.why };
	}
	// 门 1（白名单）：逐段验首词。未知首词 = 拒（旧版默认放行）
	for (const rawSeg of cmd.split(SEG_SPLIT)) {
		const seg = rawSeg.trim();
		if (!seg) continue;
		const tokens = seg.split(/\s+/);
		let idx = 0;
		// 前缀：`cd <dir>` / `timeout N` / 环境变量赋值 `FOO=bar cmd` / `git -C <dir>`
		if (tokens[0] === "cd") continue;
		if (tokens[0] === "timeout") { idx = 2; }
		while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx])) idx++;
		const head = (tokens[idx] ?? "").replace(/^\/+/, "").toLowerCase();
		if (!head) continue;
		if (!READONLY_HEADS.has(head)) {
			return { ok: false, why: `白名单外命令「${head}」（主仓库不执行未列白的工具）` };
		}
		if (head === "git") {
			const rest = tokens.slice(idx + 1);
			// 跳全局旗标（-C <dir> / -c <kv> / --git-dir 等），找子命令
			let sub = "";
			for (let i = 0; i < rest.length; i++) {
				const t = rest[i];
				if (t === "-C" || t === "-c" || t === "--git-dir" || t === "--work-tree") { i++; continue; }
				if (t.startsWith("-")) continue;
				sub = t.toLowerCase();
				break;
			}
			if (!sub) return { ok: false, why: "git 无可识别子命令" };
			if (!GIT_READONLY_SUBS.has(sub)) return { ok: false, why: `git 非只读子命令「${sub}」` };
		}
		if (SCRIPT_RUNNERS.has(head)) {
			const body = tokens.slice(idx + 1).join(" ");
			if (/\s-[ace]\b|\s--eval\b|\s--command\b/.test(` ${body}`)) {
				return { ok: false, why: `${head} 内联代码（解释器 -e/-c/-eval）` };
			}
			if (head === "npm" || head === "pnpm" || head === "yarn" || head === "npx") {
				// 包工具在只读面里只允许 ls/run/test/dot；其他（install/publish）门 2 已拦
				if (!/\b(ls|run|test|dot|exec|version|why|outdated)\b/.test(body)) {
					return { ok: false, why: `${head} 非只读子命令` };
				}
			}
			if (/\b(node|bun|deno|python3?|py)\b/.test(head) && !SCRIPT_SUFFIXES.test(body) && !/\s--?(version|help|h|v)\b/.test(` ${body}`)) {
				return { ok: false, why: `${head} 未指向脚本文件（无法判断它要执行什么）` };
			}
		}
		if (head === "sed" && !/\s-[en]/.test(` ${tokens.slice(idx + 1).join(" ")}`)) {
			return { ok: false, why: "sed 未带 -n/-e（无法确认它不写文件）" };
		}
	}
	return { ok: true };
}

const defaultExec = (cmd: string, cwd: string, timeoutMs: number) => {
	const r = spawnSync(cmd, { shell: true, cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" });
	const timedOut = r.error ? (r.error as { code?: string }).code === "ETIMEDOUT" : false;
	return {
		exitCode: typeof r.status === "number" ? r.status : timedOut ? null : 1,
		timedOut,
		stdout: r.stdout ?? "",
		stderr: r.stderr ?? "",
	};
};

/** 复跑一路 lane 的 validation 命令清单（确定性，零模型调用）。never-throw。 */
export function replayLaneValidation(opts: ReplayOptions): LaneReplayFacts {
	const facts: LaneReplayFacts = {
		lane: opts.lane,
		total: 0,
		ran: 0,
		failed: 0,
		claimedPassButFailed: 0,
		refused: 0,
		timedOut: 0,
		results: [],
	};
	try {
		const p = join(opts.runDir, "lanes", opts.lane, "validation.json");
		if (!existsSync(p)) return facts;
		const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
		if (!Array.isArray(raw)) return facts;
		const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const budgetMs = opts.totalBudgetMs ?? DEFAULT_BUDGET_MS;
		const chars = opts.excerptChars ?? DEFAULT_EXCERPT_CHARS;
		const exec = opts.exec ?? defaultExec;
		const started = Date.now();

		// ── 安全边界（2026-11-02 #1）：主仓库绝不执行模型生成的命令 ──
		// 执行目录 = 调用方给的 cwd（应为 lane 隔离工作目录）；与 mainRoot 归一化相等 ⇒ 整 lane 拒执。
		const normDir = (p: string): string => p.replace(/[\\/]+$/, "").toLowerCase().replace(/\\/g, "/");
		const cwdUsed = opts.cwd ?? opts.repoRoot;
		const isMainRoot = opts.mainRoot !== undefined && normDir(cwdUsed) === normDir(opts.mainRoot);
		facts.cwdUsed = cwdUsed;
		facts.cwdNote = isMainRoot
			? "主仓库根 ⇒ 整 lane 拒执行（模型生成命令不得在用户仓库里跑）"
			: existsSync(cwdUsed)
				? "隔离工作目录"
				: "隔离工作目录不存在 ⇒ 命令将在该路径下失败（如实暴露）";
		if (isMainRoot) facts.cwdNote = "主仓库根 ⇒ 整 lane 拒执行（模型生成命令不得在用户仓库里跑）";

		raw.forEach((item, index) => {
			const rec = (item ?? {}) as Record<string, unknown>;
			const cmd = typeof rec.command === "string" ? rec.command.trim() : "";
			const claimed = typeof rec.result === "string" ? rec.result.trim().toLowerCase() : "";
			const base: ReplayCmdResult = {
				index,
				command: cmd,
				claimedResult: claimed,
				exitCode: null,
				excerpt: "",
				status: "no-command",
				claimedPassButFailed: false,
			};
			facts.total++;
			if (!cmd) {
				facts.results.push(base);
				return;
			}
			if (isMainRoot) {
				facts.refused++;
				facts.results.push({ ...base, status: "refused-main-root", excerpt: "拒绝执行：执行目录解析为主仓库根" });
				return;
			}
			if (Date.now() - started >= budgetMs) {
				facts.results.push({ ...base, status: "budget-exhausted" });
				return;
			}
			const verdict = readonlyVerdict(cmd);
			if (!verdict.ok) {
				facts.refused++;
				facts.results.push({ ...base, status: "refused-non-readonly", excerpt: `拒绝执行（${verdict.why}）` });
				return;
			}
			const r = exec(cmd, cwdUsed, timeoutMs);
			if (r.timedOut) {
				facts.timedOut++;
				facts.results.push({ ...base, status: "timeout", excerpt: "超时" });
				return;
			}
			const out = `${r.stdout ?? ""}${r.stderr ? `\n[stderr] ${r.stderr}` : ""}`.trim().slice(0, chars);
			const exit = r.exitCode;
			facts.ran++;
			if (exit !== 0) facts.failed++;
			const claimedPass = claimed === "pass" || claimed === "true" || claimed === "ok";
			const row: ReplayCmdResult = {
				...base,
				status: "ran",
				exitCode: exit,
				excerpt: out,
				claimedPassButFailed: claimedPass && exit !== 0,
			};
			if (row.claimedPassButFailed) facts.claimedPassButFailed++;
			facts.results.push(row);
		});
		return facts;
	} catch {
		return facts; // 复跑失败绝不能阻断收集
	}
}

/** markdown 段（写进 cross-test-report.md）。只写计数与逐条 exit，不做判定。 */
export function renderReplaySection(all: LaneReplayFacts[]): string[] {
	const lines: string[] = [];
	lines.push("### Validation 复跑（确定性执行 lane 自己声明的验证命令，零模型调用）");
	lines.push("");
	lines.push("| lane | 条数 | 实跑 | 实跑失败 | **声称 pass 实测失败** | 拒绝执行 | 超时 | 执行目录 |");
	lines.push("|---|---|---|---|---|---|---|---|");
	for (const f of all) {
		lines.push(
			`| ${f.lane} | ${f.total} | ${f.ran} | ${f.failed} | **${f.claimedPassButFailed}** | ${f.refused} | ${f.timedOut} | \`${f.cwdUsed ?? "?"}\`（${f.cwdNote ?? "?"}） |`,
		);
	}
	lines.push("");
	const detail: string[] = [];
	for (const f of all) {
		for (const r of f.results) {
			if (r.status === "ran") {
				detail.push(
					`- ${f.lane}${r.index + 1} exit=${r.exitCode} 自报=${r.claimedResult || "(空)"}${r.claimedPassButFailed ? " ⚠ 自报 pass 实为失败" : ""} — \`${r.command.slice(0, 70)}\``,
				);
			} else {
				detail.push(`- ${f.lane}${r.index + 1} **${r.status}** — \`${r.command.slice(0, 70)}\``);
			}
		}
	}
	if (detail.length) {
		lines.push("<details><summary>逐条读数</summary>");
		lines.push("");
		lines.push(...detail);
		lines.push("");
		lines.push("</details>");
		lines.push("");
	}
	lines.push(
		"> **安全边界（2026-11-02 #1）**：复跑只在 **lane 隔离工作目录** 里跑，**主仓库根一律拒执行**；" +
		"命令还需同时过两道只读门（白名单首词 + 已知破坏面黑名单）。「拒绝执行」= **未执行**，不是失败。" +
		"exit 码只说明命令成败，不说明结论对错。",
	);
	lines.push("");
	return lines;
}
