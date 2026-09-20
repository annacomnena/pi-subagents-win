/**
 * trace-fusion/cross-test.ts — deterministic cross-test 矩阵（trace-fusion C8，设计稿 §27–§29）
 *
 * v0.3 终态：零模型判断。每个 candidate（lane patch）在独立 eval worktree 中
 * 接受全部 pooled portable commands 的检验：
 *
 *   eval-{lane} = Base + candidate patch + 其它 lane 无冲突 testFiles 的测试 diff
 *
 * §27.1 修订：命令先归一化（剥 lane worktree 绝对路径）；判别性 fail 重跑一次
 * 防抖（两次不一致标 flaky，两次 fail 才记 fail）。
 * §28：eval 树验证完即删，不碰 A/B/C 原始 evidence worktree。
 */

import { existsSync, mkdirSync, writeFileSync, copyFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { execGit } from "./git.ts";
import { createSingleWorktree, provisionWorktree, removeWorktreeRetry, writeProvisionReport } from "./worktrees.ts";
import type { LaneId, TraceRunMeta, TraceFusionProvisioning } from "./types.ts";
import type { RunCollectReport } from "./artifacts.ts";
import { diagnoseDirtyViolations } from "./artifacts.ts";

export type CellResult = "pass" | "fail" | "flaky" | "error" | "blocked";

export interface CrossTestCell {
	lane: LaneId;
	command: string;
	sourceLanes: LaneId[];
	result: CellResult;
	attempts: number;
	durationMs: number;
	outputTail: string;
}

export interface PooledCommand {
	command: string;
	sourceLanes: LaneId[];
}

export interface EvalLaneInfo {
	lane: LaneId;
	evalWorktree: string | null;
	appliesCleanly: boolean;
	pooledTestFiles: string[];
	notes: string[];
}

export interface CrossTestMatrix {
	runId: string;
	baseCommit: string;
	evaluatedAt: string;
	pooledCommands: PooledCommand[];
	cells: CrossTestCell[];
	lanes: Record<LaneId, EvalLaneInfo>;
	reportPath: string;
}

export interface CrossTestOptions {
	timeoutMsPerCommand?: number;
	provisioning?: TraceFusionProvisioning;
	mainRoot?: string;
	/** 命令执行 seam（测试注入 fake）。 */
	exec?: (command: string, cwd: string, timeoutMs: number) => { status: number; output: string };
	now?: Date;
}

/** §27.1 修订 1：命令归一化——lane worktree / run 目录绝对路径改写为相对引用（改为相对 eval cwd）。 */
export function normalizeCommand(command: string, meta: TraceRunMeta): string {
	let out = command;
	const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	// review 修正（Luna major，复核轮）：路径【替换为 .】而非删除——
	//   `cd "<wt>" && x`      → `cd "." && x`        （合法）
	//   `npm --prefix "<wt>"` → `npm --prefix "."`   （合法）
	//   `node <wt>/f.js`      → `node ./f.js`        （合法）
	// 路径后必须跟分隔符/独立边界，防 `C:\wt\ax` 前缀误伤（lookahead 不消耗字符）。
	const strip = (raw: string): void => {
		for (const variant of [raw, raw.split("\\").join("/")]) {
			const e = esc(variant);
			// review 复核修正（Luna minor）：负向 lookbehind 拒绝前导字符为 词/冒号/斜杠 的命中，
			// 防 URL 内部段落（https://host/tmp/wt/c/x）被当成 worktree 路径改写。
			const lb = "(?<![\\w:/])";
			// 后随分隔符：路径→"."，保留原分隔符（随后统一折叠）
			out = out.replace(new RegExp(lb + '["\']?' + e + '["\']?(?=[\\\\/])', "gi"), ".");
			// 独立出现（后随空白/引号/URL 片段/结尾）：路径→"."
			out = out.replace(new RegExp(lb + '["\']?' + e + '["\']?(?=$|[\\s"&#])', "gi"), ".");
		}
	};
	for (const lane of ["A", "B", "C"] as const) {
		const wt = meta.lanes[lane].worktree;
		if (wt) strip(wt);
	}
	if (meta.runDir) strip(meta.runDir);
	// 折叠重复分隔符（URL scheme 后不折叠）、反斜杠统一为 /、去冗余 ./
	return out
		.replace(/(?<!:)[\\/]{2,}/g, "/")
		.split("\\").join("/")
		.replace(/([\s"']|^)\.\//g, "$1")
		.replace(/\s{2,}/g, " ")
		.replace(/^[\s"']+|[\s"']+$/g, "")
		.trim();
}

/** 汇总 pooled commands（跨 lane 去重、归一化后合并来源）。 */
export function poolCommands(collect: RunCollectReport, meta: TraceRunMeta): PooledCommand[] {
	const byCommand = new Map<string, PooledCommand>();
	for (const entry of collect.commandPool) {
		const cmd = normalizeCommand(entry.command, meta);
		if (!cmd) continue;
		// review 修正（Luna major）安全阀：归一化后仍引用 lane worktree 的命令无法在 eval 树执行，拒绝入池
		const low = cmd.toLowerCase();
		if (["A", "B", "C"].some((l) => {
			const w = meta.lanes[l].worktree;
			return w && low.includes(w.split("\\").join("/").toLowerCase());
		})) continue;
		const existing = byCommand.get(cmd.toLowerCase());
		if (existing) {
			if (!existing.sourceLanes.includes(entry.lane)) existing.sourceLanes.push(entry.lane);
		} else {
			byCommand.set(cmd.toLowerCase(), { command: cmd, sourceLanes: [entry.lane] });
		}
	}
	return [...byCommand.values()];
}

function defaultExec(command: string, cwd: string, timeoutMs: number): { status: number; output: string } {
	const res = process.platform === "win32"
		? spawnSync("cmd", ["/d", "/s", "/c", command], { cwd, encoding: "utf8", timeout: timeoutMs, windowsHide: true })
		: spawnSync(command, { cwd, encoding: "utf8", timeout: timeoutMs, shell: true, windowsHide: true });
	const output = `${res.stdout ?? ""}\n${res.stderr ?? ""}`.trim();
	return { status: res.status ?? -1, output: output.slice(-2000) };
}

/** §27.1 修订 2：判别性 fail 重跑一次防抖。 */
function runWithFlakyGuard(
	exec: (command: string, cwd: string, timeoutMs: number) => { status: number; output: string },
	command: string,
	cwd: string,
	timeoutMs: number,
): { result: CellResult; attempts: number; durationMs: number; outputTail: string } {
	const started = Date.now();
	const first = exec(command, cwd, timeoutMs);
	if (first.status === 0) {
		return { result: "pass", attempts: 1, durationMs: Date.now() - started, outputTail: first.output.slice(-400) };
	}
	if (first.status < 0) {
		// 超时/无法 spawn：不重跑（非判别性失败）
		return { result: "error", attempts: 1, durationMs: Date.now() - started, outputTail: first.output.slice(-400) };
	}
	const second = exec(command, cwd, timeoutMs);
	if (second.status === 0) {
		return { result: "flaky", attempts: 2, durationMs: Date.now() - started, outputTail: second.output.slice(-400) };
	}
	return { result: "fail", attempts: 2, durationMs: Date.now() - started, outputTail: second.output.slice(-400) };
}

/** 把 untracked 归档拷进 eval 树（lane patch 的未跟踪部分）。 */
function copyUntrackedInto(untrackedDir: string, evalTree: string): void {
	if (!existsSync(untrackedDir)) return;
	const walk = (src: string, rel: string): void => {
		for (const entry of readdirSync(src, { withFileTypes: true })) {
			const s = join(src, entry.name);
			const d = join(evalTree, rel, entry.name);
			if (entry.isDirectory()) {
				mkdirSync(d, { recursive: true });
				walk(s, join(rel, entry.name));
			} else {
				mkdirSync(dirname(d), { recursive: true });
				copyFileSync(s, d);
			}
		}
	};
	walk(untrackedDir, "");
}

/** 提取某 lane 对指定 testFile 的 diff（相对 base）；无改动返回空。 */
function testFileDiff(meta: TraceRunMeta, lane: LaneId, file: string): string {
	const wt = meta.lanes[lane].worktree;
	const d1 = execGit(["diff", "--binary", meta.baseCommit, "HEAD", "--", file], { cwd: wt });
	// review 复核修正（Luna major）：`diff HEAD` 才覆盖 staged + unstaged（裸 diff 漏 staged）
	const d2 = execGit(["diff", "--binary", "HEAD", "--", file], { cwd: wt });
	// execGit 会 trim 尾部换行；git apply 要求 patch 以换行结尾，否则 corrupt patch
	const parts = [d1.stdout, d2.stdout].filter((s) => s.length > 0).map((s) => (s.endsWith("\n") ? s : s + "\n"));
	return parts.join("");
}

function renderReport(matrix: CrossTestMatrix): string {
	const lines: string[] = [
		`# Trace Fusion Cross-Test Report — ${matrix.runId}`,
		"",
		`- base: \`${matrix.baseCommit.slice(0, 12)}\``,
		`- evaluatedAt: ${matrix.evaluatedAt}`,
		"",
		"## Candidate status",
		"",
	];
	for (const lane of ["A", "B", "C"] as const) {
		const l = matrix.lanes[lane];
		lines.push(`- **TRACE ${lane}**：apply ${l.appliesCleanly ? "✅" : "❌"}${l.evalWorktree ? "" : "（eval 树未创建）"}${l.pooledTestFiles.length ? `；pooled tests: ${l.pooledTestFiles.join(", ")}` : ""}${l.notes.length ? `；note: ${l.notes.join("; ")}` : ""}`);
	}
	lines.push("", "## Matrix（pooled commands × candidates）", "", "| command | sources | " + ["A", "B", "C"].join(" | ") + " |", "|---|---|---|---|---|");
	for (const cmd of matrix.pooledCommands) {
		const cells = ["A", "B", "C"].map((lane) => {
			const cell = matrix.cells.find((c) => c.lane === lane && c.command === cmd.command);
			return cell ? ({ pass: "✅ pass", fail: "❌ fail", flaky: "⚠️ flaky", error: "⚠️ error", blocked: "⛔ blocked" }[cell.result]) : "—";
		});
		lines.push(`| \`${cmd.command.slice(0, 80)}\` | ${cmd.sourceLanes.join("/")} | ${cells.join(" | ")} |`);
	}
	lines.push("", "> v0.3 deterministic 报告：本矩阵即终态，等待人工裁决；fusion/consult 为 v0.4。", "");
	return lines.join("\n");
}

/** 执行 cross-test：建 eval 树 → apply patch + pooled tests → 跑矩阵 → 出报告 → 清理。 */
/**
 * diagnose 模式收尾（2026-09-17）：不在用户主仓库执行任何 lane 声称的命令
 * （无 worktree 隔离，build/test 类命令会污染用户工作树）。
 * 落盘跳过型 cross-test.json（幂等：supervisor already-done 检查直接命中）
 * + 报告说明 + 违规写入检查结论。
 */
export function finishDiagnoseRun(meta: TraceRunMeta, collect: RunCollectReport): CrossTestMatrix {
	const violations = diagnoseDirtyViolations(meta);
	const matrix: CrossTestMatrix = {
		runId: meta.runId,
		baseCommit: meta.baseCommit,
		evaluatedAt: new Date().toISOString(),
		pooledCommands: [],
		cells: [],
		lanes: {
			A: { lane: "A", evalWorktree: null, appliesCleanly: false, pooledTestFiles: [], notes: ["diagnose 模式：不建 eval 树"] },
			B: { lane: "B", evalWorktree: null, appliesCleanly: false, pooledTestFiles: [], notes: ["diagnose 模式：不建 eval 树"] },
			C: { lane: "C", evalWorktree: null, appliesCleanly: false, pooledTestFiles: [], notes: ["diagnose 模式：不建 eval 树"] },
		},
		reportPath: join(meta.runDir, "cross-test-report.md"),
	};
	const poolSize = collect.commandPool.length;
	const lines = [
		`# Cross-test 报告 — ${meta.runId}（diagnose 模式）`,
		"",
		"- 模式：**diagnose（只读诊断）**——lane 未实现代码，无 patch 可验证；",
		"  本模式不在用户主仓库执行任何 pooled command（无 worktree 隔离），",
		`  ${poolSize} 条证据主张仅供 fusion/人工复核。`,
		`- 主仓库违规写入检查：${violations.length === 0 ? "✅ 无基线外改动" : `⚠ 发现 ${violations.length} 条基线外改动（疑似 lane 违规）：`}`,
		...(violations.length > 0 ? violations.slice(0, 10).map((v) => `  - ${v}`) : []),
		"",
		"## 交付物",
		"",
		"三份独立诊断+方案在 `lanes/{A,B,C}/trajectory.md`，证据主张在 `lanes/{A,B,C}/validation.json`；",
		"主会话应读取三者做融合（一致根因 → 高置信；分歧 → 仲裁），合成单一推进方案后单次实现。",
		"",
	];
	writeFileSync(join(meta.runDir, "cross-test.json"), JSON.stringify({ ...matrix, skipped: "diagnose 模式不在用户仓库执行命令", dirtyViolations: violations }, null, 2) + "\n", "utf8");
	writeFileSync(matrix.reportPath, lines.join("\n"), "utf8");
	return matrix;
}

/** 执行 cross-test：建 eval 树 → apply patch + pooled tests → 跑矩阵 → 出报告 → 清理。 */
export function runCrossTest(meta: TraceRunMeta, collect: RunCollectReport, opts: CrossTestOptions = {}): CrossTestMatrix {
	const now = opts.now ?? new Date();
	const exec = opts.exec ?? defaultExec;
	const timeoutMs = opts.timeoutMsPerCommand ?? 10 * 60_000;
	const provisioning = opts.provisioning ?? { junction: [], copy: [], command: "" };
	const mainRoot = opts.mainRoot ?? meta.repoRoot;
	const lanes: Record<LaneId, EvalLaneInfo> = {
		A: { lane: "A", evalWorktree: null, appliesCleanly: false, pooledTestFiles: [], notes: [] },
		B: { lane: "B", evalWorktree: null, appliesCleanly: false, pooledTestFiles: [] , notes: [] },
		C: { lane: "C", evalWorktree: null, appliesCleanly: false, pooledTestFiles: [], notes: [] },
	};

	const pooledCommands = poolCommands(collect, meta);

	// 1. eval 树（每 lane 一棵；Base + provisioning）
	execGit(["worktree", "prune"], { cwd: meta.repoRoot });
	for (const lane of ["A", "B", "C"] as const) {
		const path = join(meta.wtDir, `eval-${lane.toLowerCase()}`);
		const created = createSingleWorktree(meta.baseCommit, path, meta.repoRoot);
		if (!created.ok) {
			lanes[lane].notes.push(`eval 树创建失败：${created.error}`);
			continue;
		}
		lanes[lane].evalWorktree = path;
		const provision = provisionWorktree(path, mainRoot, provisioning);
		writeProvisionReport(join(meta.runDir, "lanes", lane, `provision-eval.json`), provision);
	}

	// 2. 候选 patch + untracked + 其它 lane 测试 diff（§27.2 无冲突合并）
	// 先收集全部 lane 的 testFiles 与 changedFiles 用于冲突检测
	const changedByLane: Record<LaneId, string[]> = {
		A: collect.lanes.A.changedFiles,
		B: collect.lanes.B.changedFiles,
		C: collect.lanes.C.changedFiles,
	};
	const testsByLane: Record<LaneId, string[]> = {
		A: collect.lanes.A.testFiles,
		B: collect.lanes.B.testFiles,
		C: collect.lanes.C.testFiles,
	};
	for (const lane of ["A", "B", "C"] as const) {
		const info = lanes[lane];
		const evalTree = info.evalWorktree;
		if (!evalTree) continue;
		const patchPath = collect.lanes[lane].patchPath;
		const untrackedDir = collect.lanes[lane].untrackedDir;

		// 2a. candidate patch
		if (existsSync(patchPath)) {
			const apply = execGit(["apply", "--whitespace=nowarn", patchPath], { cwd: evalTree });
			if (apply.status === 0) {
				info.appliesCleanly = true;
			} else {
				info.notes.push(`candidate patch apply 失败：${apply.stderr.slice(0, 200)}`);
			}
		} else {
			info.appliesCleanly = true; // 空 patch 视为干净（纯调研 lane）
			info.notes.push("无 candidate patch（空 patch）");
		}
		// 2b. untracked 归档
		copyUntrackedInto(untrackedDir, evalTree);

		// 2c. 其它 lane 的 testFiles（无 path collision 才合并）
		const own = new Set([...changedByLane[lane], ...testsByLane[lane]]);
		const mergedOwners: string[] = [];
		for (const other of ["A", "B", "C"] as const) {
			if (other === lane) continue;
			for (const tf of testsByLane[other]) {
				const collideWithOwn = own.has(tf);
				const collideWithSelf = info.pooledTestFiles.includes(tf);
				if (collideWithOwn || collideWithSelf) {
					info.notes.push(`pooled test 跳过（path collision）：${tf}（来自 ${other}）`);
					continue;
				}
				const diff = testFileDiff(meta, other, tf);
				if (!diff) {
					// review 修正（Luna major）：untracked 测试文件不在 git diff 里——从其它 lane 的归档复制
					if (!collect.lanes[other].untrackedFiles.includes(tf)) continue; // 该 lane 根本没改这个文件
					const dest = join(evalTree, tf);
					if (existsSync(dest)) {
						info.notes.push(`pooled test 跳过（eval 内已存在同名文件）：${tf}（来自 ${other}）`);
						continue;
					}
					try {
						mkdirSync(dirname(dest), { recursive: true });
						copyFileSync(join(collect.lanes[other].untrackedDir, tf), dest);
						info.pooledTestFiles.push(`${tf} (${other}, untracked)`);
						mergedOwners.push(tf);
					} catch (err) {
						info.notes.push(`pooled untracked test 复制失败：${tf}：${(err as Error).message}`);
					}
					continue;
				}
				const patchFile = join(meta.runDir, "lanes", other, `testdiff-${lane}.diff`);
				writeFileSync(patchFile, diff, "utf8");
				const apply = execGit(["apply", "--whitespace=nowarn", patchFile], { cwd: evalTree });
				if (apply.status === 0) {
					info.pooledTestFiles.push(`${tf} (${other})`);
					mergedOwners.push(tf);
				} else {
					info.notes.push(`pooled test apply 失败：${tf}（来自 ${other}）：${apply.stderr.slice(0, 120)}`);
				}
			}
		}
	}

	// 3. 矩阵：每个 pooled command × 每个 eval 树就绪的 lane
	const cells: CrossTestCell[] = [];
	for (const cmd of pooledCommands) {
		for (const lane of ["A", "B", "C"] as const) {
			const info = lanes[lane];
			if (!info.evalWorktree) {
				cells.push({ lane, command: cmd.command, sourceLanes: cmd.sourceLanes, result: "blocked", attempts: 0, durationMs: 0, outputTail: "eval 树不可用" });
				continue;
			}
			if (!info.appliesCleanly) {
				cells.push({ lane, command: cmd.command, sourceLanes: cmd.sourceLanes, result: "blocked", attempts: 0, durationMs: 0, outputTail: "candidate patch 未干净应用" });
				continue;
			}
			const r = runWithFlakyGuard(exec, cmd.command, info.evalWorktree, timeoutMs);
			cells.push({ lane, command: cmd.command, sourceLanes: cmd.sourceLanes, ...r });
		}
	}

	const matrix: CrossTestMatrix = {
		runId: meta.runId,
		baseCommit: meta.baseCommit,
		evaluatedAt: now.toISOString(),
		pooledCommands,
		cells,
		lanes,
		reportPath: join(meta.runDir, "cross-test-report.md"),
	};

	// 4. §28：eval 树即用即删（失败标 stale，不拖垮报告）——先 cleanup，报告才能包含 cleanup notes
	for (const lane of ["A", "B", "C"] as const) {
		const path = lanes[lane].evalWorktree;
		if (path && existsSync(path)) {
			const rm = removeWorktreeRetry(path, meta.repoRoot, { attempts: 2, baseDelayMs: 200 });
			// review 修正（Luna minor）：cleanup 失败不再静默——记 warning 但不改矩阵结果
			if (!rm.removed) lanes[lane].notes.push(`eval 树清理失败（stale 标记，下次启动回收）：${rm.error?.slice(0, 120)}`);
		}
	}
	lanes.A.evalWorktree = lanes.B.evalWorktree = lanes.C.evalWorktree = null;

	// 5. 报告落盘（json 给 v0.4 fusion 消费；md 给人）——cleanup 的 notes 已包含在内
	writeFileSync(join(meta.runDir, "cross-test.json"), JSON.stringify(matrix, null, 2) + "\n", "utf8");
	writeFileSync(matrix.reportPath, renderReport(matrix), "utf8");

	return matrix;
}
