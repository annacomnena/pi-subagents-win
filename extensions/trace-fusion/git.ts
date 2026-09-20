/**
 * trace-fusion/git.ts — 最小 git 执行器（trace-fusion C5）
 *
 * spawnSync 包装：sync 足够（命令都跑在主会话命令 handler / 一次性 setup 里）。
 * 绝不 echo 敏感信息；stderr 原样返回由调用方决定呈现。
 */

import { spawnSync } from "node:child_process";

export interface GitResult {
	/** 进程退出码（0 = 成功）。 */
	status: number;
	stdout: string;
	stderr: string;
}

export interface GitOptions {
	cwd?: string;
	/** 额外 env（如 GIT_INDEX_FILE / 身份变量）；在 process.env 之上合并。 */
	env?: Record<string, string>;
	/** 传给 stdin 的内容（commit-tree 读 message 用）。 */
	input?: string;
}

export function execGit(args: string[], opts: GitOptions = {}): GitResult {
	// review 修正（Luna major）：GIT_INDEX_FILE 默认从继承环境剔除，防止宿主进程
	// 残留值污染后续 worktree/diff/status 操作；snapshot 需要时经 opts.env 显式注入。
	const { GIT_INDEX_FILE: _stripped, ...safeEnv } = process.env as Record<string, string | undefined>;
	void _stripped;
	const res = spawnSync("git", args, {
		cwd: opts.cwd,
		input: opts.input,
		encoding: "utf8",
		env: opts.env ? { ...safeEnv, ...opts.env } : safeEnv,
		windowsHide: true,
	});
	return {
		status: res.status ?? -1,
		stdout: (res.stdout ?? "").trim(),
		stderr: (res.stderr ?? "").trim(),
	};
}

/** 合成 snapshot 提交的固定身份：不依赖用户 git config（未配置 identity 的机器也能跑）。 */
export const SNAPSHOT_IDENTITY_ENV: Record<string, string> = {
	GIT_AUTHOR_NAME: "pi trace-fusion",
	GIT_AUTHOR_EMAIL: "pi-trace-fusion@localhost",
	GIT_COMMITTER_NAME: "pi trace-fusion",
	GIT_COMMITTER_EMAIL: "pi-trace-fusion@localhost",
};
