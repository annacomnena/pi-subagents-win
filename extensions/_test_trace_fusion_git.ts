/**
 * _test_trace_fusion_git.ts — C5 git 层集成测试（真实临时仓库）
 *
 * 锁定契约：
 *   §13/§14  synthetic snapshot 折叠 staged+unstaged+untracked，ignored 不进入；
 *            不移动用户 ref、不碰用户 index；对象自证可解析
 *   §14.2    preflight：merge/rebase/cherry-pick 状态拒绝；unborn 拒绝；单 active run 互斥
 *   §16      三 lane 从同一 baseCommit detached 创建；X_A=X_B=X_C
 *   §16.1    provisioning junction/copy；供给失败 → degraded 不致命
 *   §40.3    worktree remove 重试成功路径；resume 侧 resolveBaseCommit
 *
 * 运行：node --experimental-strip-types extensions/_test_trace_fusion_git.ts
 * （无 git 环境时打印 skipped 并以 0 退出——CI 兼容）
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const gitVer = spawnSync("git", ["--version"], { encoding: "utf8", windowsHide: true });
if (gitVer.status !== 0) {
	console.log("git 不可用，trace-fusion git 集成测试 skipped");
	process.exit(0);
}

import { runPreflight } from "./trace-fusion/preflight.ts";
import { createSyntheticSnapshot, resolveBaseCommit } from "./trace-fusion/snapshot.ts";
import { createLaneWorktrees, provisionWorktree, removeWorktreeRetry, writeProvisionReport } from "./trace-fusion/worktrees.ts";
import { execGit } from "./trace-fusion/git.ts";
import { TRACE_LANES } from "./trace-fusion/types.ts";

const root = mkdtempSync(join(tmpdir(), "tfl-c5-test-"));
const repo = join(root, "repo");
const runsDir = join(root, "runs");

function g(args: string[], cwd = repo, input?: string) {
	return execGit(args, {
		cwd,
		input,
		env: {
			GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
		},
	});
}

try {
	// ── 准备：init + 首提交 ──────────────────────────────────────
	mkdirSync(repo, { recursive: true });
	assert.equal(g(["init", "-b", "main"]).status, 0, "git init");
	writeFileSync(join(repo, "file.txt"), "v1\n");
	g(["add", "."]);
	assert.equal(g(["commit", "-m", "init"]).status, 0, "first commit");

	// ── dirty：unstaged 修改 + staged 新文件 + untracked + ignored ──
	writeFileSync(join(repo, "file.txt"), "v2-modified\n");
	writeFileSync(join(repo, "staged.txt"), "staged-content\n");
	g(["add", "staged.txt"]);
	writeFileSync(join(repo, "untracked.txt"), "untracked-content\n");
	writeFileSync(join(repo, ".gitignore"), "ignored.txt\n");
	writeFileSync(join(repo, "ignored.txt"), "ignored-content\n");

	const headBefore = g(["rev-parse", "HEAD"]).stdout;

	// ── §14.2 preflight：dirty 不是拒绝项 ────────────────────────
	const pf = runPreflight(repo, { runsDir });
	assert.equal(pf.ok, true, `preflight 应通过：${pf.blockingReason}`);
	const norm = (p: string) => p.toLowerCase().replace(/\\/g, "/");
assert.equal(norm(pf.toplevel ?? ""), norm(repo));
	assert.equal(pf.head, headBefore);
	assert.ok(pf.porcelain && pf.porcelain.length > 0, "porcelain 应记录 dirty 状态");

	// ── §13/§14 snapshot ─────────────────────────────────────────
	const baseDir = join(runsDir, "tfl-test", "base");
	const snap = createSyntheticSnapshot(repo, baseDir);
	assert.ok(/^[0-9a-f]{40,64}$/.test(snap.baseCommit), "baseCommit 应是完整 sha");
	assert.equal(snap.headBefore, headBefore);

	// 折叠内容：三种状态全部进入 base tree
	assert.equal(g(["show", `${snap.baseCommit}:file.txt`]).stdout, "v2-modified", "unstaged 修改进入");
	assert.equal(g(["show", `${snap.baseCommit}:staged.txt`]).stdout, "staged-content", "staged 进入");
	assert.equal(g(["show", `${snap.baseCommit}:untracked.txt`]).stdout, "untracked-content", "untracked 进入");
	// §14.2：ignored 不进入
	assert.notEqual(g(["show", `${snap.baseCommit}:ignored.txt`]).status, 0, "ignored 文件不得进入 snapshot");
	// 磁盘契约三件套
	assert.equal(readFileSync(join(baseDir, "base-commit.txt"), "utf8").trim(), snap.baseCommit);
	assert.ok(existsSync(join(baseDir, "status.txt")));
	const snapJson = JSON.parse(readFileSync(join(baseDir, "snapshot.json"), "utf8")) as { baseCommit: string };
	assert.equal(snapJson.baseCommit, snap.baseCommit);

	// 用户状态零扰动
	assert.equal(g(["rev-parse", "HEAD"]).stdout, headBefore, "HEAD 不得移动");
	assert.equal(g(["status", "--porcelain", "--untracked-files=no"]).stdout.includes("staged.txt"), true, "用户 index 的 staged 条目不得被清");
	assert.ok(existsSync(join(repo, "untracked.txt")), "untracked 文件不得被动");

	// ── §16 三 lane worktree：同一 base，同内容起点 ───────────────
	const mainNm = join(repo, "nm");
	mkdirSync(mainNm);
	writeFileSync(join(mainNm, "pkg.txt"), "dep-marker\n");
	writeFileSync(join(repo, ".env"), "SECRET=1\n");
	const wtRoot = join(root, "wt");
	const created = createLaneWorktrees(snap.baseCommit, wtRoot, repo, TRACE_LANES, repo, {
		junction: ["nm"],
		copy: [".env"],
		command: "",
	});
	assert.deepEqual(created.errors, [], `worktree 创建零错误：${created.errors.join("; ")}`);
	assert.equal(created.lanes.length, 3);
	for (const l of created.lanes) {
		assert.ok(existsSync(join(l.worktree, "file.txt")), `lane ${l.lane} 有快照内容`);
		assert.equal(g(["show", `${snap.baseCommit}:file.txt`]).stdout, "v2-modified");
		const headInWt = g(["rev-parse", "HEAD"], l.worktree).stdout;
		assert.equal(headInWt, snap.baseCommit, `lane ${l.lane} detached 在 baseCommit`);
		assert.equal(l.provision.degraded, false, `lane ${l.lane} 供给成功`);
		// junction 生效：经 lane 树读到主树依赖内容
		assert.equal(readFileSync(join(l.worktree, "nm", "pkg.txt"), "utf8"), "dep-marker\n", `lane ${l.lane} junction`);		assert.equal(readFileSync(join(l.worktree, ".env"), "utf8"), "SECRET=1\n", `lane ${l.lane} copy .env`);
	}
	// 三树同源（X_A=X_B=X_C）：HEAD 一致 + file.txt 一致
	const heads = created.lanes.map((l) => g(["rev-parse", "HEAD"], l.worktree).stdout);
	assert.deepEqual(heads, [snap.baseCommit, snap.baseCommit, snap.baseCommit]);

	// 供给报告落盘契约
	const laneDirA = join(runsDir, "tfl-test", "lanes", "A");
	writeProvisionReport(laneDirA, created.lanes[0].provision);
	assert.ok(existsSync(join(laneDirA, "provision.json")));

	// ── §16.1 degraded：junction 源缺失 → 标记但不抛 ─────────────
	const wtDegraded = join(root, "wt-degraded");
	assert.equal(g(["worktree", "add", "--detach", wtDegraded, snap.baseCommit]).status, 0);
	const dp = provisionWorktree(wtDegraded, repo, { junction: ["no-such-dir"], copy: [], command: "" });
	assert.equal(dp.degraded, true, "供给缺失必须标 degraded");
	assert.ok(dp.issues.length > 0);

	// ── §40.3 removal 成功路径 ───────────────────────────────────
	const removed = removeWorktreeRetry(created.lanes[0].worktree, repo, { attempts: 2, baseDelayMs: 10 });
	assert.deepEqual(removed, { removed: true, stale: false });
	assert.equal(existsSync(created.lanes[0].worktree), false);

	// ── §24.1 resume 侧：resolveBaseCommit ───────────────────────
	assert.equal(resolveBaseCommit(repo, baseDir), snap.baseCommit, "base 仍可解析");
	writeFileSync(join(baseDir, "base-commit.txt"), "deadbeef".repeat(6) + "\n");
	assert.equal(resolveBaseCommit(repo, baseDir), null, "gc 走了的 base → null（降级 artifacts-only）");
	writeFileSync(join(baseDir, "base-commit.txt"), snap.baseCommit + "\n");

	// ── §14.2 拒绝项 ─────────────────────────────────────────────
	writeFileSync(join(repo, ".git", "MERGE_HEAD"), `${headBefore}\n`);
	const pfMerge = runPreflight(repo, { runsDir });
	assert.equal(pfMerge.ok, false, "merge 状态必须拒绝");
	assert.ok(pfMerge.blockingReason?.includes("MERGE_HEAD"));
	rmSync(join(repo, ".git", "MERGE_HEAD"));

	// active run 互斥
	mkdirSync(join(runsDir, "run-live"), { recursive: true });
	writeFileSync(join(runsDir, "run-live", "meta.json"), JSON.stringify({ status: "running" }));
	const pfBusy = runPreflight(repo, { runsDir });
	assert.equal(pfBusy.ok, false, "存在 running run 必须拒绝");
	assert.deepEqual(pfBusy.activeRunIds, ["run-live"]);
	writeFileSync(join(runsDir, "run-live", "meta.json"), JSON.stringify({ status: "completed" }));
	assert.equal(runPreflight(repo, { runsDir }).ok, true, "run 终态后放行");

	// 过期的 running run 在下次启动时自动回收（墙钟已过仍 running = 僵尸，不该永久占锁）
	mkdirSync(join(runsDir, "run-zombie"), { recursive: true });
	writeFileSync(join(runsDir, "run-zombie", "meta.json"), JSON.stringify({
		status: "running",
		laneDeadlineAt: new Date(Date.now() - 60_000).toISOString(),
	}));
	const pfReap = runPreflight(repo, { runsDir });
	assert.equal(pfReap.ok, true, "过期僵尸应被自动回收并放行");
	const reapedMeta = JSON.parse(readFileSync(join(runsDir, "run-zombie", "meta.json"), "utf8")) as { status?: string; cancelledReason?: string };
	assert.equal(reapedMeta.status, "cancelled", "僵尸 meta 应被改写为 cancelled");
	assert.ok(reapedMeta.cancelledReason?.includes("wall-clock"), "回收原因落盘");
	// 未过期的 running 仍阻塞
	mkdirSync(join(runsDir, "run-fresh"), { recursive: true });
	writeFileSync(join(runsDir, "run-fresh", "meta.json"), JSON.stringify({
		status: "running",
		laneDeadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
	}));
	assert.equal(runPreflight(repo, { runsDir }).ok, false, "未过期 running 仍然阻塞");

	// unborn repo 拒绝
	const unborn = join(root, "unborn");
	mkdirSync(unborn);
	g(["init", "-b", "main"], unborn);
	assert.equal(runPreflight(unborn, { runsDir }).ok, false, "unborn HEAD 必须拒绝");

	console.log("trace-fusion git tests passed");
} finally {
	// 清理 junction 后删树；Windows 上 rmSync 对 junction 只删链接本身
	try {
		rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
	} catch (err) {
		console.warn(`cleanup warning: ${(err as Error).message}`);
	}
}
