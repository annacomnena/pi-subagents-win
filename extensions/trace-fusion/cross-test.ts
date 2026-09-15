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

/** §27.1 修订 1：命令归一化——剥除各 lane worktree / run 目录绝对路径（含后续分隔符），改为相对 eval cwd。 */
export function normalizeCommand(command: string, meta: TraceRunMeta): string {
	let out = command;
	const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const replacements: [RegExp, string][] = [];
	for (const lane of ["A", "B", "C"] as const) {
		const wt = meta.lanes[lane].worktree;
		if (wt) {
			replacements.push([new RegExp(esc(wt) + "[\\\\/]?$", "i"), ""]);
			replacements.push([new RegExp(esc(wt) + "[\\\\/]"), ""]);
			replacements.push([new RegExp(esc(wt.replace(/\\/g, "/")) + "[\\\\/]?$"), ""]);
			replacements.push([new RegExp(esc(wt.replace(/\\/g, "/")) + "[\\\\/]"), ""]);
		}
	}
	if (meta.runDir) {
		replacements.push([new RegExp(esc(meta.runDir) + "[\\\\/]?"), ""]);
		replacements.push([new RegExp(esc(meta.runDir.replace(/\\/g, "/")) + "[\\\\/]?"), ""]);
	}
	for (const [re, to] of replacements) out = out.replace(re, to);
	// 收敛空白与多余引号空格
	return out.replace(/\s{2,}/g, " ").replace(/^["'\s]+|["'\s]+$/g, "").trim();
}

/** 汇总 pooled commands（跨 lane 去重、归一化后合并来源）。 */
export function poolCommands(collect: RunCollectReport, meta: TraceRunMeta): PooledCommand[] {
	const byCommand = new Map<string, PooledCommand>();
	for (const entry of collect.commandPool) {
		const cmd = normalizeCommand(entry.command, meta);
		if (!cmd) continue;
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
	const d2 = execGit(["diff", "--binary", "--", file], { cwd: wt });
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
				if (!diff) continue;
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

	// 4. 报告落盘（json 给 v0.4 fusion 消费；md 给人）
	writeFileSync(join(meta.runDir, "cross-test.json"), JSON.stringify(matrix, null, 2) + "\n", "utf8");
	writeFileSync(matrix.reportPath, renderReport(matrix), "utf8");

	// 5. §28：eval 树即用即删（失败标 stale，不拖垮报告）
	for (const lane of ["A", "B", "C"] as const) {
		const path = lanes[lane].evalWorktree;
		if (path && existsSync(path)) removeWorktreeRetry(path, meta.repoRoot, { attempts: 2, baseDelayMs: 200 });
	}
	lanes.A.evalWorktree = lanes.B.evalWorktree = lanes.C.evalWorktree = null;

	return matrix;
}
