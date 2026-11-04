/**
 * trace-fusion/worktrees.ts — lane worktree 创建 / 供给 / 清理（trace-fusion C5，设计稿 §15–§16.1、§40.3）
 *
 * - 全部 lane 从同一 syntheticBaseCommit `worktree add --detach` 创建（X_A=X_B=X_C 是
 *   trajectory independence 的物理基础）；
 * - worktree 放短路径 ~/.pi/tfl-wt/<shortRunId>/{a,b,c}，artifact 放长路径；
 * - provisioning：junction（node_modules 等只读依赖）/ copy（.env）/ command 兜底；
 *   供给失败的 lane 标记 degraded（no-build-env），不致命（§16.1 规则 4）；
 * - removal 走指数退避重试，仍失败 → stale 标记，不把成功的 run 拖成失败（§40.3）。
 */

import {
	existsSync,
	mkdirSync,
	symlinkSync,
	copyFileSync,
	writeFileSync,
	rmSync,
	readdirSync,
	lstatSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { execGit } from "./git.ts";
import type { LaneId, TraceFusionProvisioning } from "./types.ts";

export interface ProvisionReport {
	junction: string[];
	copied: string[];
	commandOk: boolean;
	commandError?: string;
	/** true = 至少一项供给失败；Fusion 将降权该 lane 的可执行证据。 */
	degraded: boolean;
	issues: string[];
}

const EMPTY_PROVISION: ProvisionReport = { junction: [], copied: [], commandOk: true, degraded: false, issues: [] };

/**
 * 枚举目录树内的 reparse 链接（junction / symlink），**绝不进入链接内部**。
 * R-16：junction 指向的是别处（主仓 node_modules、pi 安装）的活数据。
 */
export function listReparseLinks(root: string, depthLimit = 8): string[] {
	const out: string[] = [];
	try {
		if (lstatSync(root).isSymbolicLink()) return [root];
	} catch {
		return out;
	}
	const walk = (dir: string, depth: number) => {
		if (depth > depthLimit) return;
		let entries: Array<{ name: string; isSymbolicLink(): boolean; isDirectory(): boolean }>;
		try {
			entries = readdirSync(dir, { withFileTypes: true }) as never;
		} catch {
			return;
		}
		for (const e of entries) {
			const p = join(dir, e.name);
			try {
				if (e.isSymbolicLink()) {
					out.push(p); // 链接只记录，不进入
					continue;
				}
				if (e.isDirectory()) walk(p, depth + 1);
			} catch {
				/* 条目消失（并发写）：跳过 */
			}
		}
	};
	walk(root, 0);
	return out;
}

/**
 * 只解除链接本身（rmSync 不带 recursive ⇒ 删的是链接，不是目标内容）。
 * 沙盒实测：先解链接再 git worktree remove ⇒ 目标完好；不解链接直接 remove ⇒ 目标内容被清空。
 */
export function removeLinksOnly(root: string): { removed: string[]; failed: string[] } {
	const removed: string[] = [];
	const failed: string[] = [];
	for (const p of listReparseLinks(root)) {
		try {
			rmSync(p);
			if (existsSync(p)) failed.push(basename(p));
			else removed.push(basename(p));
		} catch {
			failed.push(basename(p));
		}
	}
	return { removed, failed };
}

/** 在 run 目录内记录单 lane 供给结果（磁盘契约，C7 artifacts 复用）。 */
export function writeProvisionReport(runLaneDir: string, report: ProvisionReport): void {
	mkdirSync(runLaneDir, { recursive: true });
	writeFileSync(join(runLaneDir, "provision.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
}

/**
 * 单 worktree 供给（§16.1）。junction 用 Node 原生 symlink 'junction'
 * （Windows 下等价 mklink /J，无需管理员；POSIX 回退 dir symlink）。
 */
export function provisionWorktree(wtPath: string, mainRoot: string, provisioning: TraceFusionProvisioning): ProvisionReport {
	const report: ProvisionReport = { ...EMPTY_PROVISION, issues: [] };

	for (const name of provisioning.junction ?? []) {
		const target = join(mainRoot, name);
		const link = join(wtPath, name);
		if (!existsSync(target)) {
			report.issues.push(`junction 源不存在（跳过）：${name}`);
			continue;
		}
		if (existsSync(link)) continue; // 已供给（幂等）
		try {
			symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
			report.junction.push(name);
		} catch (err) {
			report.issues.push(`junction 失败：${name}：${(err as Error).message}`);
		}
	}

	for (const name of provisioning.copy ?? []) {
		const src = join(mainRoot, name);
		const dest = join(wtPath, name);
		if (!existsSync(src)) continue; // 主树没有就不复制（不算降级）
		try {
			mkdirSync(join(dest, ".."), { recursive: true });
			copyFileSync(src, dest);
			report.copied.push(name);
		} catch (err) {
			report.issues.push(`copy 失败：${name}：${(err as Error).message}`);
		}
	}

	const cmd = (provisioning.command ?? "").trim();
	if (cmd) {
		const res = process.platform === "win32"
			? spawnSync("cmd", ["/c", cmd], { cwd: wtPath, encoding: "utf8", windowsHide: true })
			: spawnSync(cmd, { cwd: wtPath, encoding: "utf8", shell: true, windowsHide: true });
		report.commandOk = (res.status ?? -1) === 0;
		if (!report.commandOk) report.issues.push(`command 失败（exit ${res.status}）：${(res.stderr ?? "").slice(0, 400)}`);
	}

	report.degraded = report.issues.length > 0;
	return report;
}

export interface LaneWorktree {
	lane: LaneId;
	worktree: string;
	provision: ProvisionReport;
}

export interface WorktreeCreationResult {
	lanes: LaneWorktree[];
	errors: string[];
}

/**
 * 单个 detached worktree 创建原语（lane 树 / eval 树共用）。
 */
export function createSingleWorktree(
	baseCommit: string,
	wtPath: string,
	repoRoot: string,
	opts: { allowExisting?: boolean } = {},
): { ok: true; path: string } | { ok: false; error: string } {
	mkdirSync(dirname(wtPath), { recursive: true });
	if (existsSync(wtPath) && !opts.allowExisting) {
		// review 修正（Luna major）：上次清理失败留下的 stale 树应自动回收，
		// 而不是永久占用目录名导致后续 run 全部被拒。
		const staleMarker = `${wtPath}.stale.json`;
		if (existsSync(staleMarker)) {
			// R-16：stale 目录里可能还挂着供给出来的 junction ⇒ 先解链接；解不干净就拒绝递归删除
			const staleLinks = removeLinksOnly(wtPath);
			if (staleLinks.failed.length > 0) {
				return {
					ok: false,
					error: `stale 目录内的链接无法解除，拒绝递归删除（R-16）：${staleLinks.failed.join(",")} ⇒ ${wtPath}`,
				};
			}
			try {
				rmSync(wtPath, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 });
				execGit(["worktree", "prune"], { cwd: repoRoot });
				rmSync(staleMarker, { force: true });
			} catch {
				return { ok: false, error: `stale 目录回收失败，请手动删除：${wtPath}` };
			}
		}
		if (existsSync(wtPath)) {
			return { ok: false, error: `目标已存在（先清理再创建）：${wtPath}` };
		}
	}
	const add = execGit(["worktree", "add", "--detach", wtPath, baseCommit], { cwd: repoRoot });
	if (add.status !== 0) return { ok: false, error: add.stderr };
	return { ok: true, path: wtPath };
}

/**
 * 从同一 baseCommit 为各 lane 创建 detached worktree 并逐个供给。
 * 先 `worktree prune` 清掉上次 stale 残留的 admin 条目（§40.3：next startup 清理）。
 */
export function createLaneWorktrees(
	baseCommit: string,
	wtDir: string,
	repoRoot: string,
	lanes: readonly LaneId[],
	mainRoot: string,
	provisioning: TraceFusionProvisioning,
): WorktreeCreationResult {
	mkdirSync(wtDir, { recursive: true });
	execGit(["worktree", "prune"], { cwd: repoRoot });

	const out: LaneWorktree[] = [];
	const errors: string[] = [];
	for (const lane of lanes) {
		const laneDir = join(wtDir, lane.toLowerCase());
		const created = createSingleWorktree(baseCommit, laneDir, repoRoot);
		if (!created.ok) {
			errors.push(`lane ${lane}：${created.error}`);
			continue;
		}
		const provision = provisionWorktree(laneDir, mainRoot, provisioning);
		out.push({ lane, worktree: laneDir, provision });
	}
	return { lanes: out, errors };
}

export interface RemovalResult {
	removed: boolean;
	/** true = 重试后仍失败，已写 stale 标记；下次启动由 prune 兜底，不算 run 失败。 */
	stale: boolean;
	/** 本次解除的 reparse 链接名（R-16：git worktree remove 前必须先把链接解掉）。 */
	linksRemoved?: string[];
	/** 解不掉的链接名（非空 ⇒ 绝不递归删除该目录）。 */
	linksFailed?: string[];
	error?: string;
}

/** 同步 sleep（跨平台；cleanup 是一次性命令路径，阻塞无碍）。 */
function sleepSync(ms: number): void {
	if (ms <= 0) return;
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 删除单个 worktree（§40.3：指数退避重试；失败 → stale 标记）。
 *
 * ★ R-16 地雷修复（2026-11-04 沙盒实测）：git worktree remove --force 的递归删除**会穿过 junction
 * 删掉目标内容**（实测目标目录文件 [keep,extra] ⇒ 空，而目标就是主仓 node_modules / pi 安装）。
 * ⇒ 每次尝试前先把目录树里的 reparse 链接逐个解除（只删链接本身），再交给 git；
 *   解不掉的链接 ⇒ 只写 stale 标记，**绝不**递归删除该目录。
 */
export function removeWorktreeRetry(
	wtPath: string,
	repoRoot: string,
	opts: { attempts?: number; baseDelayMs?: number } = {},
): RemovalResult {
	const attempts = opts.attempts ?? 3;
	const baseDelayMs = opts.baseDelayMs ?? 300;
	let lastError = "";
	const linksRemoved: string[] = [];
	let linksFailed: string[] = [];
	for (let i = 0; i < attempts; i++) {
		if (i > 0) sleepSync(baseDelayMs * 2 ** (i - 1));
		if (existsSync(wtPath)) {
			const links = removeLinksOnly(wtPath);
			for (const n of links.removed) if (!linksRemoved.includes(n)) linksRemoved.push(n);
			linksFailed = links.failed;
		}
		const rm = execGit(["worktree", "remove", "--force", wtPath], { cwd: repoRoot });
		if (rm.status === 0) {
			return {
				removed: true,
				stale: false,
				linksRemoved,
				linksFailed,
				...(linksFailed.length > 0 ? { error: `链接未能解除：${linksFailed.join(",")}` } : {}),
			};
		}
		lastError = rm.stderr;
	}
	// stale 标记：与 wt 目录同级的旁文件，自描述；下次启动 prune + 手动清理
	try {
		writeFileSync(
			`${wtPath}.stale.json`,
			JSON.stringify({ path: wtPath, failedAt: new Date().toISOString(), error: lastError }, null, 2) + "\n",
			"utf8",
		);
	} catch {
		// 连标记都写不进去时只能靠返回值
	}
	execGit(["worktree", "prune"], { cwd: repoRoot });
	return { removed: false, stale: true, error: lastError };
}
