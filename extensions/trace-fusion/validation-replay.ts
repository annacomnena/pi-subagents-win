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
	status: "ran" | "refused-non-readonly" | "timeout" | "budget-exhausted" | "no-command";
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
}

export interface ReplayOptions {
	runDir: string;
	lane: LaneId;
	/** 命令工作目录（= `meta.repoRoot`）。 */
	repoRoot: string;
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
 * 只读判据。命中任一禁用面 ⇒ 拒绝执行。
 *
 * 判据是「已知破坏面」的黑名单，不是「只读命令」的白名单——后者写不全，且会拒掉
 * lane 里合法的多路管道组合。已知破坏面列在这里，宁可**多拒**不可漏拒。
 */
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
	for (const f of FORBIDDEN) {
		if (f.re.test(cmd)) return { ok: false, why: f.why };
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
			const r = exec(cmd, opts.repoRoot, timeoutMs);
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
	lines.push("| lane | 条数 | 实跑 | 实跑失败 | **声称 pass 实测失败** | 拒绝执行(非只读) | 超时 |");
	lines.push("|---|---|---|---|---|---|---|");
	for (const f of all) {
		lines.push(
			`| ${f.lane} | ${f.total} | ${f.ran} | ${f.failed} | **${f.claimedPassButFailed}** | ${f.refused} | ${f.timedOut} |`,
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
		"> 复跑工作目录 = 主仓库根；「拒绝执行」= 命令命中禁用面（删除/写 git/装包/网络/进程控制/写重定向），" +
			"**未执行**，不是失败。exit 码只说明命令成败，不说明结论对错。",
	);
	lines.push("");
	return lines;
}
