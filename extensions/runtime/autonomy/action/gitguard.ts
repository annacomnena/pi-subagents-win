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
