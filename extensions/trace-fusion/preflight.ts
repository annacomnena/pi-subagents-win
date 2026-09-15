/**
 * trace-fusion/preflight.ts — 启动前检查（trace-fusion C5，设计稿 §14.2）
 *
 * 拒绝项：非 git 仓库 / unborn HEAD / 进行中的 merge|rebase|cherry-pick /
 * 超过 maxActiveRuns 的存量 running run（v1 单 run 互斥）。
 * dirty 工作树【不是】拒绝项——synthetic snapshot 的存在意义就是折叠它。
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execGit } from "./git.ts";

export interface PreflightCheck {
	name: string;
	ok: boolean;
	detail?: string;
}

export interface PreflightResult {
	ok: boolean;
	toplevel?: string;
	head?: string;
	/** git status --porcelain=v1 原文（信息记录，不作 gate）。 */
	porcelain?: string;
	checks: PreflightCheck[];
	blockingReason?: string;
	/** 命中互斥时的 running run 列表。 */
	activeRunIds?: string[];
}

export interface PreflightOptions {
	runsDir?: string;
	maxActiveRuns?: number;
}

/** 扫描 runsDir 下 meta.json status=running 的 run（§14.2 单 active run 互斥）。 */
export function findActiveRuns(runsDir: string): string[] {
	if (!existsSync(runsDir)) return [];
	const active: string[] = [];
	for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const metaPath = join(runsDir, entry.name, "meta.json");
		if (!existsSync(metaPath)) continue;
		try {
			const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { status?: string };
			if (meta.status === "running") active.push(entry.name);
		} catch {
			// meta 损坏不算 active，但也不吞掉目录
		}
	}
	return active;
}

export function runPreflight(cwd: string, opts: PreflightOptions = {}): PreflightResult {
	const checks: PreflightCheck[] = [];
	const fail = (reason: string, extra?: Partial<PreflightResult>): PreflightResult => ({
		ok: false,
		checks,
		blockingReason: reason,
		...extra,
	});

	// 1. 在 git 仓库内
	const top = execGit(["rev-parse", "--show-toplevel"], { cwd });
	checks.push({ name: "inside-repo", ok: top.status === 0, detail: top.stderr });
	if (top.status !== 0) return fail(`不在 git 仓库内：${top.stderr || cwd}`);
	const toplevel = top.stdout;

	// 2. HEAD 可解析（unborn repo v1 不支持）
	const head = execGit(["rev-parse", "HEAD"], { cwd: toplevel });
	checks.push({ name: "head-resolves", ok: head.status === 0, detail: head.stderr });
	if (head.status !== 0) return fail(`HEAD 不可解析（unborn repository v1 不支持）：${head.stderr}`);
	const headCommit = head.stdout;

	// 3. 无进行中的 merge / rebase / cherry-pick（§14.2）
	for (const [name, ref] of [
		["merge-head", "MERGE_HEAD"],
		["rebase-head", "REBASE_HEAD"],
		["cherry-pick-head", "CHERRY_PICK_HEAD"],
	] as const) {
		const r = execGit(["rev-parse", "-q", "--verify", ref], { cwd: toplevel });
		const ok = r.status !== 0;
		checks.push({ name, ok, detail: ok ? undefined : `${ref} 存在——仓库处于进行中的操作状态` });
		if (!ok) return fail(`仓库处于进行中的 ${ref} 状态，拒绝启动 trace-fusion`);
	}

	// 4. active run 互斥
	const maxActiveRuns = opts.maxActiveRuns ?? 1;
	const active = opts.runsDir ? findActiveRuns(opts.runsDir) : [];
	const mutexOk = active.length < maxActiveRuns;
	checks.push({
		name: "active-run-mutex",
		ok: mutexOk,
		detail: mutexOk ? undefined : `已有 ${active.length} 个 running run（maxActiveRuns=${maxActiveRuns}）：${active.join(", ")}`,
	});
	if (!mutexOk) return fail(`已存在 running 的 trace-fusion run，v1 只允许 ${maxActiveRuns} 个并发：${active.join(", ")}`, { activeRunIds: active });

	// 5. 记录 dirty 状态（不 gate）
	const st = execGit(["status", "--porcelain=v1"], { cwd: toplevel });
	const porcelain = st.status === 0 ? st.stdout : undefined;

	return { ok: true, toplevel, head: headCommit, porcelain, checks };
}
