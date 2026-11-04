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

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, statSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { execGit } from "./git.ts";
import { defaultTabRunsDir, readTabResultFile } from "../tab-runs.ts";
import type { LaneId, TraceRunMeta } from "./types.ts";
import { LANE_ARTIFACT_DIRS, LANE_ARTIFACT_NAMES } from "./types.ts";

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
	/**
	 * lane 目录里的**契约外文件**（白名单见 types.ts `LANE_ARTIFACT_NAMES`）。
	 * 2026-11-04 tfl-20261104-111728-8618 融合结论驱动：光有 `issues` 里的文案不够——
	 * 下游（cross-test → Fusion Packet → 融合者）需要**结构化清单**才能逐条判定，
	 * 字符串只能靠文本拼接，管道里没人解析它。
	 */
	strayFiles: string[];
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

/** 一条基线外改动的归因（2026-11-05 缺陷 #9）。 */
export interface DirtyViolation {
	/** porcelain 行（如 `M src/a.ts`）。 */
	line: string;
	/**
	 * 归因：
	 *  - `lane`      = 有 lane 专属目录线索（`lanes/<lane>/`）⇒ 疑似 lane 写入
	 *  - `dispatcher` = 有派发者仍在写的证据（保留位，当前不产生）
	 *  - `unknown`   = **默认**：不知道是谁写的（不得默认有罪）
	 */
	attribution: "lane" | "dispatcher" | "unknown";
	/** 归因依据（人可读）。 */
	evidence: string;
}

/**
 * diagnose 模式确定性违规检查：主仓库当前 porcelain 对比启动基线，返回新增条目**带归因**。
 *
 * 【2026-11-05 缺陷 #9 修】旧版返回 `string[]` 且只有两个时刻（基线 / 现在），
 * 没有任何「谁写的」维度 ⇒ diagnose 模式下主会话并发改代码时，任何改动都会被判成
 * 「疑似 lane 违规」。实测：run tfl-20261105-020514-f7ed 的 cross-test 报 7 条
 * 「⚠ 疑似 lane 违规」，而那 7 个文件是**主会话**在修项 1 时改的
 * （基线 02:05:15 → 评估 02:09:16 → 7 文件 mtime 02:09:43）。
 *
 * diagnose 模式的定位恰恰是「正式开工前的探查」，此时主会话通常正在读/改代码
 * ⇒ **误报是常态而非例外**。故改为结构化归因，默认 `unknown`（不得默认有罪）。
 */
export function diagnoseDirtyViolationsDetailed(meta: TraceRunMeta): DirtyViolation[] {
	if (!meta.dirtyBaselineFile || !existsSync(meta.dirtyBaselineFile)) return [];
	// `-uall`：展开未跟踪目录。默认 porcelain 把整个 `lanes/` 折叠成一行 `?? lanes/`
	// ⇒ 归因粒度不足（实测：lane 内新增文件被报成「主仓路径，无 lane 线索」）。
	const nowSt = execGit(["status", "--porcelain=v1", "--untracked-files=all"], { cwd: meta.repoRoot });
	if (nowSt.status !== 0) return [];
	const base = new Set(readFileSync(meta.dirtyBaselineFile, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0));
	const fresh = nowSt.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0 && !base.has(l));
	const out: DirtyViolation[] = [];
	for (const line of fresh) {
		const path = line.slice(3).trim().replace(/\\/g, "/");
		const laneHit = /(^|\/)lanes\/([ABC])\//.exec(path);
		if (laneHit) {
			out.push({ line, attribution: "lane", evidence: `路径在 lanes/${laneHit[2]}/ 内` });
			continue;
		}
		out.push({ line, attribution: "unknown", evidence: "主仓路径，无 lane 目录线索；派发者可能并发编辑" });
	}
	return out;
}

/**
 * 旧的字符串入口（向后兼容：cross-test 报告、fusion packet、既有测试都用它）。
 * 仅保留路径部分，**不带归因**；新代码请用 `diagnoseDirtyViolationsDetailed`。
 */
export function diagnoseDirtyViolations(meta: TraceRunMeta): string[] {
	return diagnoseDirtyViolationsDetailed(meta).map((v) => v.line);
}

/**
 * lane 目录 stray 文件枚举（白名单见 types.ts `LANE_ARTIFACT_NAMES`）。
 * 目录只允许 `LANE_ARTIFACT_DIRS`。导出供测试直接调用（真实接线在 collectLaneArtifacts 内部）。
 */
export function findLaneStrayFiles(laneDir: string): string[] {
	if (!existsSync(laneDir)) return [];
	const out: string[] = [];
	for (const ent of readdirSync(laneDir, { withFileTypes: true })) {
		if (ent.isDirectory()) {
			if (!LANE_ARTIFACT_DIRS.has(ent.name)) out.push(`${ent.name}/`);
			continue;
		}
		if (!LANE_ARTIFACT_NAMES.has(ent.name)) out.push(ent.name);
	}
	return out;
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

	// 跑完一个删一个（2026-11-04）：worktree 已被回收 ⇒ **不得重算**。
	// 在已删掉的树上 git 全数失败，会把首次收集好的 patch/status **覆盖成空文件**（证据被清空）。
	// ⇒ 沿用首次落盘的产物 + collect-manifest.json（changedFiles/testFiles 是 cross-test 冲突检测的输入）。
	if (!existsSync(worktree) && existsSync(join(laneDir, "patch.diff")) && existsSync(join(laneDir, "status.txt"))) {
		return reuseHarvestedReport(meta, lane, laneDir, worktree, workerResult, now);
	}

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

	// lane 产物白名单校验（2026-11-03 首跑驱动：stray 文件此前逐字沉默）。
	// 必须在 supervisor 自产文件（patch.diff/status.txt）写入**之后**枚举，
	// 否则会把收集器自己写的文件判成 lane 违规。
	const strays = findLaneStrayFiles(laneDir);
	for (const s of strays) {
		issues.push(`${s}：非白名单 lane 产物（契约外文件，来源需人工核实；白名单见 types.ts LANE_ARTIFACT_NAMES）`);
	}

	// 三段式 patch（§21.0 P4 修订；worker 有无 commit 都覆盖）。
	// review 修正（Luna critical）：part2 用 `diff HEAD`——裸 `diff` 只看 unstaged，
	// 会漏掉 worker 已 git add 未 commit 的 staged 修改。
	// diagnose 模式（2026-09-17）：不收集 patch（lane 只读，应无任何修改）；
	// 改为确定性违规检查——对比启动时 porcelain 基线，新增条目即 lane 违规写主仓库。
	const patchPath = join(laneDir, "patch.diff");
	let changedFiles: string[] = [];
	let untrackedFiles: string[] = [];
	const untrackedDir = join(laneDir, "untracked");
	if (meta.mode === "diagnose") {
		writeFileSync(patchPath, "", "utf8");
		issues.push("diagnose 模式：不收集 patch（lane 只读）；证据以 trajectory/validation 为准");
		const violations = diagnoseDirtyViolations(meta);
		if (violations.length > 0) {
			issues.push(`⚠ 主仓库出现基线外改动（疑似 lane 违规写入）：${violations.slice(0, 5).join("; ")}`);
		}
	} else {
	const part1 = execGit(["diff", "--binary", meta.baseCommit, "HEAD"], { cwd: worktree });
	const part2 = execGit(["diff", "--binary", "HEAD"], { cwd: worktree });
	if (part1.status !== 0) issues.push(`patch part1 失败：${part1.stderr}`);
	if (part2.status !== 0) issues.push(`patch part2 失败：${part2.stderr}`);
	const patch = [part1.stdout, part2.stdout].filter((s) => s.length > 0).map((s) => (s.endsWith("\n") ? s : s + "\n")).join("");
	writeFileSync(patchPath, patch, "utf8");

	// changedFiles（review 修正 Luna major：name-status 覆盖重命名/删除，不再是 +++ b/ 单一来源）
	changedFiles = collectChangedFiles(meta.baseCommit, worktree);
	const untracked = existsSync(worktree) ? archiveUntracked(worktree, untrackedDir) : { files: [] as string[], issues: ["worktree 不存在"] };
	issues.push(...untracked.issues);
	changedFiles.push(...untracked.files);
	untrackedFiles = untracked.files;

	// status.txt（§21.3：登记）
	const st = execGit(["status", "--porcelain=v1"], { cwd: worktree });
	writeFileSync(join(laneDir, "status.txt"), st.stdout, "utf8");
	}

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

	// 落一份 manifest：worktree 被回收后，后续 collect 只能靠它还原 changedFiles/testFiles
	try {
		writeFileSync(join(laneDir, "collect-manifest.json"), JSON.stringify({
			changedFiles,
			untrackedFiles,
			testFiles: validation && Array.isArray(validation.testFiles)
				? validation.testFiles.filter((f): f is string => typeof f === "string" && f.trim().length > 0)
				: [],
			patchBytes: statSync(patchPath).size,
			strayFiles: strays,
			trustedCommands: trustedCommands(validation),
			collectedAt: now.toISOString(),
		}, null, 2) + "\n", "utf8");
	} catch { /* manifest 尽力而为（缺失时 reuse 会明说降级） */ }

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
		untrackedFiles,
		untrackedDir,
		trustedCommands: trustedCommands(validation),
		testFiles: validation && Array.isArray(validation.testFiles)
			? validation.testFiles.filter((f): f is string => typeof f === "string" && f.trim().length > 0)
			: [],
		strayFiles: strays,
		issues,
		collectedAt: now.toISOString(),
	};
}

/**
 * worktree 已被回收时的沿用报告（跑完一个删一个的下游保护）。
 * 绝不在已删除的树上重跑 git——那会把首次收集好的证据写成空文件。
 */
function reuseHarvestedReport(
	meta: TraceRunMeta,
	lane: LaneId,
	laneDir: string,
	worktree: string,
	workerResult: { status?: string } | null,
	now: Date,
): LaneArtifactReport {
	const patchPath = join(laneDir, "patch.diff");
	const untrackedDir = join(laneDir, "untracked");
	const validationPath = join(laneDir, "validation.json");
	const trajectoryPath = join(laneDir, "trajectory.md");
	const validation = parseValidationFile(validationPath);
	let manifest: { changedFiles?: string[]; untrackedFiles?: string[]; testFiles?: string[] } = {};
	try {
		manifest = JSON.parse(readFileSync(join(laneDir, "collect-manifest.json"), "utf8"));
	} catch { /* 旧 run 没有 manifest */ }
	let patchBytes = 0;
	try {
		patchBytes = statSync(patchPath).size;
	} catch { /* 缺失即 0 */ }
	const deadlineMs = new Date(meta.laneDeadlineAt as string).getTime();
	return {
		lane,
		laneDir,
		worktree,
		workerFinished: workerResult !== null,
		workerStatus: workerResult?.status,
		timedOut: Number.isFinite(deadlineMs) ? now.getTime() >= deadlineMs : false,
		trajectoryPath: existsSync(trajectoryPath) ? trajectoryPath : null,
		validationPath: existsSync(validationPath) ? validationPath : null,
		validation,
		patchPath,
		patchBytes,
		changedFiles: Array.isArray(manifest.changedFiles) ? manifest.changedFiles : [],
		untrackedFiles: Array.isArray(manifest.untrackedFiles)
			? manifest.untrackedFiles
			: (existsSync(untrackedDir) ? readdirSync(untrackedDir) : []),
		untrackedDir,
		trustedCommands: trustedCommands(validation),
		testFiles: Array.isArray(manifest.testFiles) ? manifest.testFiles : [],
		strayFiles: findLaneStrayFiles(laneDir),
		issues: [
			"worktree 已回收（跑完一个删一个）：沿用首次收集产物，未在已删除的树上重算",
			...(Array.isArray(manifest.changedFiles) ? [] : ["首次 manifest 缺失：changedFiles 以空集降级（cross-test 冲突检测会变宽）"]),
		],
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
