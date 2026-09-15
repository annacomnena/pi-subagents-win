/**
 * _test_trace_fusion_collect.ts — C7 权威收集测试（真实 git 临时仓库 + 手工搭 run 状态）
 *
 * 锁定契约（§21.0–§21.3、§24.2）：
 *   - 三段式 patch：未 commit（staged+unstaged）与已 commit 两种情形都完整覆盖
 *   - untracked 单独归档（不含 ignored），status.txt 登记
 *   - changedFiles 与 patch 同源（+++/b/ 提取）
 *   - trustedCommands：portable reproductions + validationCommands；结果字段被忽略；
 *     非 portable 复现命令不进池
 *   - worker 叙事缺失 → issue 记录不致命
 *   - §24.2 超时 lane 标 timedOut
 *   - collectRunArtifacts 汇总 + collect.json 落盘
 *
 * 运行：node --experimental-strip-types extensions/_test_trace_fusion_collect.ts
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const gitVer = spawnSync("git", ["--version"], { encoding: "utf8", windowsHide: true });
if (gitVer.status !== 0) {
	console.log("git 不可用，trace-fusion collect 测试 skipped");
	process.exit(0);
}

import { collectLaneArtifacts, collectRunArtifacts, parseValidationFile, trustedCommands } from "./trace-fusion/artifacts.ts";
import type { TraceRunMeta } from "./trace-fusion/types.ts";

const root = mkdtempSync(join(tmpdir(), "tfl-c7-test-"));

function g(args: string[], cwd: string, input?: string): { status: number; stdout: string } {
	const r = spawnSync("git", args, {
		cwd, encoding: "utf8", windowsHide: true, input,
		env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
	});
	return { status: r.status ?? -1, stdout: (r.stdout ?? "").trim() };
}

/** 手工搭一个 run：repo + 三个 detached worktree + meta.json（绕过 launch，聚焦 collect 契约）。 */
function makeRun(): { repo: string; meta: TraceRunMeta } {
	const repo = join(root, `repo-${Math.random().toString(36).slice(2, 6)}`);
	mkdirSync(repo, { recursive: true });
	assert.equal(g(["init", "-b", "main"], repo).status, 0);
	writeFileSync(join(repo, "src.txt"), "v1\n");
	writeFileSync(join(repo, ".gitignore"), "ignored.log\n");
	g(["add", "."], repo);
	g(["commit", "-m", "init"], repo);
	const baseCommit = g(["rev-parse", "HEAD"], repo).stdout;

	const runDir = join(root, `run-${Math.random().toString(36).slice(2, 6)}`);
	const wtDir = join(root, `wt-${Math.random().toString(36).slice(2, 6)}`);
	mkdirSync(runDir, { recursive: true });
	const lanes = {} as TraceRunMeta["lanes"];
	for (const lane of ["A", "B", "C"] as const) {
		const wt = join(wtDir, lane.toLowerCase());
		assert.equal(g(["worktree", "add", "--detach", wt, baseCommit], repo).status, 0);
		lanes[lane] = { lane, worktree: wt, tabRunId: `fake-${lane}`, provision: { junction: [], copied: [], commandOk: true, degraded: false, issues: [] } };
	}
	const meta: TraceRunMeta = {
		runId: "tfl-test-run",
		shortId: "short",
		status: "running",
		task: "t",
		repoRoot: repo,
		createdAt: new Date(Date.now() - 10 * 60_000).toISOString(),
		baseCommit,
		headBefore: baseCommit,
		runDir,
		wtDir,
		laneWallClockMin: 45,
		laneDeadlineAt: new Date(Date.now() + 45 * 60_000).toISOString(),
		lanes,
	};
	writeFileSync(join(runDir, "meta.json"), JSON.stringify(meta, null, 2) + "\n", "utf8");
	return { repo, meta };
}

try {
	// ── 情形 1：未 commit（unstaged 修改 + untracked + ignored 应排除）────────
	const run1 = makeRun();
	const wtA = run1.meta.lanes.A.worktree;
	writeFileSync(join(wtA, "src.txt"), "v2-fixed\n");
	writeFileSync(join(wtA, "new-helper.ts"), "export const h = 1;\n");
	writeFileSync(join(wtA, "ignored.log"), "noise\n");
	// worker 叙事
	const laneDirA = join(run1.meta.runDir, "lanes", "A");
	mkdirSync(laneDirA, { recursive: true });
	writeFileSync(join(laneDirA, "trajectory.md"), "## Root cause / hypotheses\nracy test\n");
	writeFileSync(join(laneDirA, "validation.json"), JSON.stringify({
		reproductions: [
			{ command: "npm test -- flaky", before: "fail", after: "pass", portable: true },
			{ command: "custom-only-here.cmd", portable: false },
		],
		validationCommands: ["npm run build"],
		testFiles: ["tests/flaky.test.ts"],
	}));

	const repA = collectLaneArtifacts(run1.meta, "A");
	assert.equal(repA.timedOut, false);
	assert.equal(repA.trajectoryPath, join(laneDirA, "trajectory.md"));
	assert.deepEqual(repA.trustedCommands, ["npm test -- flaky", "npm run build"], "portable 复现 + 验证命令；非 portable 排除");
	assert.deepEqual(repA.testFiles, ["tests/flaky.test.ts"]);
	// patch 权威：含修改
	const patchA = readFileSync(repA.patchPath, "utf8");
	assert.ok(patchA.includes("v2-fixed"), "patch 含新内容");
	assert.ok(patchA.includes("--- a/src.txt"), "patch 是标准 diff");
	// changedFiles 与 patch 同源
	assert.ok(repA.changedFiles.includes("src.txt"), "changedFiles 含修改文件");
	// untracked 归档：新文件在，ignored 不在
	assert.deepEqual(repA.untrackedFiles, ["new-helper.ts"]);
	assert.ok(existsSync(join(repA.untrackedDir, "new-helper.ts")));
	assert.ok(!existsSync(join(repA.untrackedDir, "ignored.log")), "ignored 不得归档");
	assert.ok(existsSync(join(laneDirA, "status.txt")));
	// worker 未 tab-finish → 记录但收集照常
	assert.equal(repA.workerFinished, false);
	assert.ok(repA.issues.some((i) => i.includes("未 tab-finish")), "终态缺失进 issues");

	// ── 情形 1b：staged 未 commit（review critical 9：part2 必须 diff HEAD）──
	const wtA2 = run1.meta.lanes.A.worktree;
	writeFileSync(join(wtA2, "src.txt"), "v3-staged\n");
	g(["add", "src.txt"], wtA2);
	const repA2 = collectLaneArtifacts(run1.meta, "A");
	const patchA2 = readFileSync(repA2.patchPath, "utf8");
	assert.ok(patchA2.includes("v3-staged"), "staged 未 commit 的修改必须进 patch（diff HEAD）");
	assert.ok(repA2.changedFiles.includes("src.txt"), "staged 修改进 changedFiles");

	// ── 情形 2：worker 已 commit（part1 覆盖）────────────────────────────
	const run2 = makeRun();
	const wtB = run2.meta.lanes.B.worktree;
	writeFileSync(join(wtB, "src.txt"), "v2-committed\n");
	g(["add", "."], wtB);
	g(["commit", "-m", "worker commit"], wtB);
	const repB = collectLaneArtifacts(run2.meta, "B");
	const patchB = readFileSync(repB.patchPath, "utf8");
	assert.ok(patchB.includes("v2-committed"), "已 commit 的修改必须进 patch（part1）");
	assert.ok(repB.changedFiles.includes("src.txt"));

	// ── 情形 3：叙事全缺 → issues 记录不致命，patch 仍自算 ──────────────
	const repC = collectLaneArtifacts(run2.meta, "C");
	assert.equal(repC.trajectoryPath, null);
	assert.equal(repC.validation, null);
	assert.deepEqual(repC.trustedCommands, []);
	assert.ok(repC.issues.some((i) => i.includes("trajectory.md")));
	assert.ok(repC.issues.some((i) => i.includes("validation.json")));
	assert.ok(repC.patchBytes >= 0);

	// ── §24.2 超时 lane ─────────────────────────────────────────
	const repTimeout = collectLaneArtifacts(run2.meta, "A", { now: new Date(Date.now() + 46 * 60_000) });
	assert.equal(repTimeout.timedOut, true, "过 deadline 的 lane 标 timedOut");

	// ── validation.json 宽松解析 ────────────────────────────────
	assert.equal(parseValidationFile(join(root, "nope.json")), null);
	const badPath = join(root, "bad.json");
	writeFileSync(badPath, "{not json", "utf8");
	assert.equal(parseValidationFile(badPath), null);
	assert.deepEqual(trustedCommands(null), []);

	// ── collectRunArtifacts 汇总 + 落盘 ─────────────────────────
	const report = collectRunArtifacts(run2.meta);
	assert.equal(report.runId, run2.meta.runId);
	assert.ok(report.lanes.A && report.lanes.B && report.lanes.C);
	const collectJson = JSON.parse(readFileSync(join(run2.meta.runDir, "collect.json"), "utf8")) as { lanes: Record<string, unknown> };
	assert.ok(collectJson.lanes.A && collectJson.lanes.B && collectJson.lanes.C);

	console.log("trace-fusion collect tests passed");
} finally {
	try {
		rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
	} catch (err) {
		console.warn(`cleanup warning: ${(err as Error).message}`);
	}
}
