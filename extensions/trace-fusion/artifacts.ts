/**
 * trace-fusion/artifacts.ts — lane artifact 权威收集（trace-fusion C7，设计稿 §21.0–§21.3、§24.2）
 *
 * §21.0 权威来源划分：
 *   supervisor 计算（权威）：patch.diff / changed files / untracked 清单
 *   worker 叙事（参考）：trajectory.md / validation.json 的口头描述
 *   validation.json 仅【命令本身】与 testFiles 被采信，命令结果一律以复跑为准
 *
 * patch 三段式（P4 修订，覆盖 worker 已 commit / 未 commit 两种情形）：
 *   part1: git -C <wt> diff --binary <base> HEAD
 *   part2: git -C <wt> diff --binary
 *   part3: git status --porcelain → untracked 单独归档 lanes/X/untracked/
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { execGit } from "./git.ts";
import { defaultTabRunsDir, readTabResultFile } from "../tab-runs.ts";
import type { LaneId, TraceRunMeta } from "./types.ts";

/** validation.json 允许的字段（宽松解析：弱模型会写错/缺字段）。 */
export interface TraceValidationJson {
	reproductions?: { command?: string; before?: string; after?: string; portable?: boolean }[];
	validationCommands?: string[];
	testFiles?: string[];
	buildStatus?: string;
	targetStatus?: string;
	regressionStatus?: string;
	[key: string]: unknown;
}

/**
 * changedFiles（review 修正 Luna major）：name-status 三段（base→HEAD、index/工作树、untracked），
 * 覆盖修改/新增/删除/重命名；返回统一后的目标路径集合。
 */
function collectChangedFiles(baseCommit: string, worktree: string): string[] {
	const out = new Set<string>();
	const addNameStatus = (r: { status: number; stdout: string }): void => {
		if (r.status !== 0) return;
		for (const line of r.stdout.split("\n")) {
			if (!line) continue;
			const parts = line.split("\t");
			const code = parts[0]?.slice(0, 1) ?? "";
			if (code === "R" || code === "C") {
				// 重命名/拷贝：取新旧两个路径（old 也要进集合，删除语义）
				if (parts[1]) out.add(parts[1]);
				if (parts[2]) out.add(parts[2]);
			} else {
				if (parts[1]) out.add(parts[1]);
			}
		}
	};
	addNameStatus(execGit(["diff", "--name-status", baseCommit, "HEAD"], { cwd: worktree }));
	addNameStatus(execGit(["diff", "--name-status", "HEAD"], { cwd: worktree }));
	return [...out].filter((p) => p.length > 0);
}

export interface LaneArtifactReport {
	lane: LaneId;
	laneDir: string;
	worktree: string;
	/** tab 终态（result.json 存在且可解析）。 */
	workerFinished: boolean;
	workerStatus?: string;
	/** §24.2 墙钟超时判定。 */
	timedOut: boolean;
	trajectoryPath: string | null;
	validationPath: string | null;
	validation: TraceValidationJson | null;
	/** supervisor 自算的权威 patch（§21.3）。 */
	patchPath: string;
	patchBytes: number;
	changedFiles: string[];
	untrackedFiles: string[];
	untrackedDir: string;
	/** 命令本身（可信子集，交 cross-test 复跑）。 */
	trustedCommands: string[];
	testFiles: string[];
	issues: string[];
	collectedAt: string;
}

/** 解析 validation.json（宽松：非法 JSON → null，不致命；首跑发现 worker 常写成数组而非对象——两种形状都接受）。 */
export function parseValidationFile(path: string): TraceValidationJson | null {
	if (!existsSync(path)) return null;
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (Array.isArray(raw)) {
			// 数组形状：[ { command, expectation, result, output_excerpt }, ... ]——元素本身就是验证条目
			const entries = raw.filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null && !Array.isArray(e));
			return { reproductions: entries as unknown as TraceValidationJson["reproductions"] };
		}
		return typeof raw === "object" && raw !== null ? (raw as TraceValidationJson) : null;
	} catch {
		return null;
	}
}

/**
 * §21.0：只采信【命令本身】——portable 的复现命令 + validationCommands。
 * 命令的 before/after/status 字段全部忽略（以 supervisor 复跑为准）。
 */
export function trustedCommands(v: TraceValidationJson | null): string[] {
	if (!v) return [];
	const out: string[] = [];
	for (const r of Array.isArray(v.reproductions) ? v.reproductions : []) {
		if (typeof r?.command === "string" && r.command.trim() && r.portable !== false) out.push(r.command.trim());
	}
	for (const c of Array.isArray(v.validationCommands) ? v.validationCommands : []) {
		if (typeof c === "string" && c.trim()) out.push(c.trim());
	}
	return [...new Set(out)];
}

/** 归档 untracked 文件（不含 ignored）到 destDir，保持相对路径；返回清单。 */
function archiveUntracked(worktree: string, destDir: string): { files: string[]; issues: string[] } {
	const issues: string[] = [];
	const files: string[] = [];
	mkdirSync(destDir, { recursive: true });
	const st = execGit(["status", "--porcelain=v1", "--untracked-files=all"], { cwd: worktree });
	if (st.status !== 0) {
		issues.push(`status 失败：${st.stderr}`);
		return { files, issues };
	}
	for (const line of st.stdout.split("\n")) {
		// untracked 形如 "?? path"；重命名对 untracked 不适用
		if (!line.startsWith("??")) continue;
		const rel = line.slice(2).trim().replace(/^"|"$/g, "");
		if (!rel) continue;
		const src = join(worktree, rel);
		const dest = join(destDir, rel);
		try {
			if (statSync(src).isDirectory()) continue; // 空目录/目录项由 --untracked-files=all 逐文件列出
			mkdirSync(dirname(dest), { recursive: true });
			copyFileSync(src, dest);
			files.push(rel);
		} catch (err) {
			issues.push(`untracked 归档失败 ${rel}：${(err as Error).message}`);
		}
	}
	return { files, issues };
}

export interface CollectOptions {
	now?: Date;
	/** tab-runs 目录（测试注入；缺省 defaultTabRunsDir）。 */
	tabRunsDir?: string;
}

/** 单 lane 权威收集（§21.0 三段式 + 叙事文件收编 + worker 终态探测）。 */
export function collectLaneArtifacts(meta: TraceRunMeta, lane: LaneId, opts: CollectOptions = {}): LaneArtifactReport {
	const issues: string[] = [];
	const laneMeta = meta.lanes[lane];
	const laneDir = join(meta.runDir, "lanes", lane);
	const worktree = laneMeta.worktree;
	mkdirSync(laneDir, { recursive: true });
	const now = opts.now ?? new Date();

	// worker 终态（tab-finish 是否已落 result.json）
	const runsDir = opts.tabRunsDir ?? defaultTabRunsDir();
	const workerResult = laneMeta.tabRunId ? readTabResultFile(runsDir, laneMeta.tabRunId) : null;

	// §24.2 墙钟超时（恰达 deadline 也算超时）
	const timedOut = now.getTime() >= new Date(meta.laneDeadlineAt).getTime();

	// 叙事文件（§21.0：参考不作硬证据；缺失记 issue 不致命）
	const trajectoryPath = join(laneDir, "trajectory.md");
	const validationPath = join(laneDir, "validation.json");
	if (!existsSync(trajectoryPath)) {
		issues.push("trajectory.md 缺失（worker 未按契约写入）");
	}
	const validation = parseValidationFile(validationPath);
	if (!validation) {
		issues.push("validation.json 缺失或非法");
	}

	// 三段式 patch（§21.0 P4 修订；worker 有无 commit 都覆盖）。
	// review 修正（Luna critical）：part2 用 `diff HEAD`——裸 `diff` 只看 unstaged，
	// 会漏掉 worker 已 git add 未 commit 的 staged 修改。
	const part1 = execGit(["diff", "--binary", meta.baseCommit, "HEAD"], { cwd: worktree });
	const part2 = execGit(["diff", "--binary", "HEAD"], { cwd: worktree });
	if (part1.status !== 0) issues.push(`patch part1 失败：${part1.stderr}`);
	if (part2.status !== 0) issues.push(`patch part2 失败：${part2.stderr}`);
	const patch = [part1.stdout, part2.stdout].filter((s) => s.length > 0).map((s) => (s.endsWith("\n") ? s : s + "\n")).join("");
	const patchPath = join(laneDir, "patch.diff");
	writeFileSync(patchPath, patch, "utf8");

	// changedFiles（review 修正 Luna major：name-status 覆盖重命名/删除，不再是 +++ b/ 单一来源）
	const changedFiles = collectChangedFiles(meta.baseCommit, worktree);
	const untrackedDir = join(laneDir, "untracked");
	const untracked = existsSync(worktree) ? archiveUntracked(worktree, untrackedDir) : { files: [] as string[], issues: ["worktree 不存在"] };
	issues.push(...untracked.issues);
	changedFiles.push(...untracked.files);

	// status.txt（§21.3：登记）
	const st = execGit(["status", "--porcelain=v1"], { cwd: worktree });
	writeFileSync(join(laneDir, "status.txt"), st.stdout, "utf8");

	if (!laneMeta.tabRunId) {
		issues.push("lane 无 tabRunId（派发即失败，artifact 为空证据）");
	} else if (workerResult === null) {
		issues.push("lane 未 tab-finish（仍在运行或静默挂起；终态前收集为部分证据）");
	}

	// worker result.json 归档（review 修正 Luna minor：受校验的副本进 lane artifact 目录）
	if (workerResult) {
		try {
			writeFileSync(join(laneDir, "result.json"), JSON.stringify(workerResult, null, 2) + "\n", "utf8");
		} catch { /* 归档尽力而为 */ }
	}

	return {
		lane,
		laneDir,
		worktree,
		workerFinished: workerResult !== null,
		workerStatus: workerResult?.status,
		timedOut,
		trajectoryPath: existsSync(trajectoryPath) ? trajectoryPath : null,
		validationPath: existsSync(validationPath) ? validationPath : null,
		validation,
		patchPath,
		patchBytes: statSync(patchPath).size,
		changedFiles,
		untrackedFiles: untracked.files,
		untrackedDir,
		trustedCommands: trustedCommands(validation),
		testFiles: validation && Array.isArray(validation.testFiles)
			? validation.testFiles.filter((f): f is string => typeof f === "string" && f.trim().length > 0)
			: [],
		issues,
		collectedAt: now.toISOString(),
	};
}

export interface RunCollectReport {
	runId: string;
	baseCommit: string;
	collectedAt: string;
	lanes: Record<LaneId, LaneArtifactReport>;
	/** 全部 lane 的可信命令池（cross-test 输入，C8 消费）。 */
	commandPool: { lane: LaneId; command: string }[];
}

/** 三 lane 全量收集 + 报告落盘（runDir/collect.json）。 */
export function collectRunArtifacts(meta: TraceRunMeta, opts: CollectOptions = {}): RunCollectReport {
	const lanes = {} as Record<LaneId, LaneArtifactReport>;
	const commandPool: RunCollectReport["commandPool"] = [];
	for (const lane of ["A", "B", "C"] as const) {
		const rep = collectLaneArtifacts(meta, lane, opts);
		lanes[lane] = rep;
		for (const cmd of rep.trustedCommands) commandPool.push({ lane, command: cmd });
	}
	const report: RunCollectReport = {
		runId: meta.runId,
		baseCommit: meta.baseCommit,
		collectedAt: (opts.now ?? new Date()).toISOString(),
		lanes,
		commandPool,
	};
	writeFileSync(join(meta.runDir, "collect.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
	return report;
}
