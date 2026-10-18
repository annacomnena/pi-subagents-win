/**
 * runtime/autonomy/action/gitguard.ts — §A 新判据「git 版本管理做好」的可执行检查。
 *
 * D4 裁定（2026-10-01，用户原话）：「肯定不能容器。不用隔离，git 版本管理做好，文件夹分好，
 * 不删除原有文件就行」——派活/动作许可不再要求环境层隔离，改由本模块 + report.ts 的
 * 目录前缀/只增不删检查机械执行（设计 §6.3）。
 *
 * 本仓教训（§6.3）：agent 曾连续 3 次「报告完成但未 commit」⇒ autonomy 必须**比人更严格**：
 * commit 不是 best-effort，是动作的强制关口；未 commit 的改动不在 git 里 ⇒ 不可回退。
 *
 * 只读、spawnSync、never-throw；读失败（非 git 仓 / git 缺失 / 超时）= unknown = fail-closed。
 *
 * 三分支（§6.3 C1 / P2 / P4）：
 *  ① effect 路径是 **git 跟踪文件**（P3 file-write/git-commit 才出现）：
 *     - 前置必须 clean（否则 DENY workspace-dirty）；
 *     - 且 autonomy **不代人 commit**（无法保证后置新 commit）⇒ 直接 DENY（tracked-needs-commit）。
 *  ② effect 路径为 **untracked / ignored / 在 repo 外**（P1 报告常态：state/ 不在 git 仓内）：
 *     - 前置：porcelain 必须可读（null = unknown = DENY fail-closed）；记录 baseline。
 *     - 后置：porcelain 必须与前置**逐项一致**；出现任何新条目 = 违规（→ 回退 + 熔断）。
 *  ③ 无 repoRoot（P1 报告在 state/ 仓外、不涉 git 仓）：不查 git（由目录前缀 + 只增不删兜底）。
 */
import { spawnSync } from "node:child_process";

/** 只读 git porcelain 快照（spawnSync，never-throw）。null = unknown（非 git 仓 / git 失败 / 超时）。 */
export function gitPorcelain(repoRoot: string): string[] | null {
	try {
		const r = spawnSync("git", ["-C", repoRoot, "status", "--porcelain"], { encoding: "utf8", timeout: 5_000 });
		if (r.error || r.status !== 0) return null;
		return r.stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
	} catch {
		return null;
	}
}

/**
 * 默认路径自动发现仓根（§6.3 / 计划 P1 返修）：`git rev-parse --show-toplevel`（spawnSync，
 * cwd = 进程 cwd）。调用方（wake.ts）无需显式传 repoRoot。never-throw；
 * 发现失败（非 git 仓 / git 缺失 / 超时 / 空输出）= null = 读不到 = fail-closed 拒绝。
 *
 * 2026-10-19 R4：加**可选 cwd**（走 `git -C <cwd>`）。零参调用 = 用进程 cwd，行为**逐字节不变**。
 * ⚠ 缺省 cwd 只适用于 run.ts 的**兜底**路径：扩展宿主的进程 cwd 常不是 git 仓
 * （实测主会话 cwd=C:/Users/Annacomnena ⇒ 非仓），拿它当 §A ③ 的检查对象会读错仓。
 */
export function discoverRepoRoot(cwd?: string): string | null {
	try {
		const r = cwd
			? spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 5_000 })
			: spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 5_000 });
		if (r.error || r.status !== 0) return null;
		const top = (r.stdout ?? "").trim();
		return top.length > 0 ? top : null;
	} catch {
		return null;
	}
}

/**
 * project 是否为「本地仓路径」形状（Windows 盘符 / UNC / POSIX 绝对）。
 * 与 `classes/notify.ts::isRepoProjectPath` **同口径双写**（此处不 import 该文件：
 * gitguard 是 git 纪律层，不该依赖具体动作类；两处必须同步改）。
 *
 * 为什么需要这个谓词：`trigger.project` 既可能是仓路径，也可能是 `mailbox:agent___master_default`
 * 这类**非路径标识**。后者拿去 `git -C` 只会得到无意义的失败，绝不能当成「仓库读不到」。
 */
export function isLocalRepoPath(project: string): boolean {
	if (/^[A-Za-z]:[\\/]/.test(project)) return true; // Windows 绝对：C:/…  C:\…
	if (project.startsWith("\\\\")) return true; // UNC：\\server\share
	if (project.startsWith("/")) return true; // POSIX 绝对
	return false;
}

/**
 * 从 `trigger.project` 解析 git 仓根（§A ③ 的正确对象 = 本次动作影响的**那个项目仓**）。
 * never-throw。
 *  - 非字符串 / 空白 ⇒ null（不猜）。
 *  - 非路径形状（`mailbox:…` / `repo:X`）⇒ null（不猜；由 run.ts 回落进程 cwd）。
 *  - 路径形状但 git 不可达 / 非仓 / 目录不存在 ⇒ null（同样回落，回落链见 run.ts）。
 * 「三路都拿不到」才 DENY —— fail-closed 语义不变，只是不再读错对象。
 */
export function discoverRepoRootForProject(project: string): string | null {
	if (typeof project !== "string" || !project.trim()) return null;
	if (!isLocalRepoPath(project)) return null;
	return discoverRepoRoot(project);
}

export interface GitPreResult {
	ok: boolean;
	reason?: string;
	/** untracked/ignored 分支的 porcelain 基线（供后置逐项比对）。 */
	baseline?: string[];
}

export interface GitPostResult {
	ok: boolean;
	reason?: string;
	/** 后置相对前置新增的 porcelain 条目（违规证据，落账本）。 */
	newEntries?: string[];
}

/**
 * §A ③ git 纪律前置检查（never-throw，fail-closed）。
 * @param tracked effect 路径是否为 git 跟踪文件（P1 报告 = false；P3 受限写/commit 才 true）。
 */
export function gitPrecheck(repoRoot: string, opts: { tracked: boolean }): GitPreResult {
	const baseline = gitPorcelain(repoRoot);
	if (baseline === null) return { ok: false, reason: "git-unknown(fail-closed)" };
	if (opts.tracked) {
		// ① 跟踪文件：前置必须 clean；且 autonomy 不代人 commit ⇒ 无法保证后置新 commit ⇒ DENY
		if (baseline.length > 0) return { ok: false, reason: "workspace-dirty" };
		return { ok: false, reason: "tracked-needs-commit(autonomy不代人commit)" };
	}
	// ② untracked/ignored/仓外：porcelain 可读即记 baseline（后置逐项比对）
	return { ok: true, baseline };
}

/**
 * §A ③ git 纪律后置检查（never-throw，fail-closed）。
 * untracked/ignored：porcelain 后置必须与前置逐项一致；任何新条目 = 违规（→ 回退 + 熔断）。
 */
export function gitPostcheck(repoRoot: string, baseline: string[], opts: { tracked: boolean }): GitPostResult {
	const after = gitPorcelain(repoRoot);
	if (after === null) return { ok: false, reason: "git-unknown(fail-closed)" };
	if (opts.tracked) {
		// ① 跟踪文件：由调用方比对 HEAD 前后（新 commit）；此处 porcelain 新增同样视为越界
		const before = new Set(baseline);
		const newEntries = after.filter((l) => !before.has(l));
		if (newEntries.length > 0) return { ok: false, reason: "porcelain-new-entry", newEntries };
		return { ok: true };
	}
	// ② untracked/ignored：逐项一致（新增 = 违规）
	const before = new Set(baseline);
	const newEntries = after.filter((l) => !before.has(l));
	if (newEntries.length > 0) return { ok: false, reason: "porcelain-new-entry", newEntries };
	return { ok: true };
}
