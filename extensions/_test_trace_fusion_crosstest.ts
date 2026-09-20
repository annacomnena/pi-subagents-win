/**
 * _test_trace_fusion_crosstest.ts — C8 deterministic cross-test 测试（真实 git 临时仓库 + exec seam）
 *
 * 锁定契约（§27–§29、§68 v0.3）：
 *   - pooled commands：跨 lane 去重 + 来源合并；命令归一化剥 worktree 绝对路径
 *   - eval 树 = Base + candidate patch + 其它 lane 无冲突 testFiles；path collision 跳过并记录
 *   - 判别 fail 重跑一次：fail+fail=fail；fail+pass=flaky；pass 即 pass
 *   - blocked：eval 树不可用 / patch 未干净应用
 *   - 矩阵 + md 报告落盘（cross-test.json / cross-test-report.md）
 *   - eval 树用后即删（A/B/C 原始 evidence worktree 不受影响）
 *
 * 运行：node --experimental-strip-types extensions/_test_trace_fusion_crosstest.ts
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const gitVer = spawnSync("git", ["--version"], { encoding: "utf8", windowsHide: true });
if (gitVer.status !== 0) {
	console.log("git 不可用，trace-fusion crosstest 测试 skipped");
	process.exit(0);
}

import { runCrossTest, normalizeCommand, poolCommands } from "./trace-fusion/cross-test.ts";
import { collectRunArtifacts } from "./trace-fusion/artifacts.ts";
import type { TraceRunMeta, LaneId } from "./trace-fusion/types.ts";
import type { RunCollectReport } from "./trace-fusion/artifacts.ts";

const root = mkdtempSync(join(tmpdir(), "tfl-c8-test-"));

function g(args: string[], cwd: string, input?: string): { status: number; stdout: string } {
	const r = spawnSync("git", args, {
		cwd, encoding: "utf8", windowsHide: true, input,
		env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
	});
	return { status: r.status ?? -1, stdout: (r.stdout ?? "").trim() };
}

function makeRun(withShared = false): TraceRunMeta {
	const repo = join(root, `repo-${Math.random().toString(36).slice(2, 6)}`);
	mkdirSync(repo, { recursive: true });
	g(["init", "-b", "main"], repo);
	writeFileSync(join(repo, "app.txt"), "v1\n");
	writeFileSync(join(repo, "test.txt"), "t1\n");
	if (withShared) writeFileSync(join(repo, "shared.test.txt"), "shared v1\n");
	g(["add", "."], repo);
	g(["commit", "-m", "init"], repo);
	const baseCommit = g(["rev-parse", "HEAD"], repo).stdout;

	const runDir = join(root, `run-${Math.random().toString(36).slice(2, 6)}`);
	const wtDir = join(root, `wt-${Math.random().toString(36).slice(2, 6)}`);
	mkdirSync(runDir, { recursive: true });
	const lanes = {} as TraceRunMeta["lanes"];
	for (const lane of ["A", "B", "C"] as const) {
		const wt = join(wtDir, lane.toLowerCase());
		g(["worktree", "add", "--detach", wt, baseCommit], repo);
		lanes[lane] = { lane, worktree: wt, tabRunId: `fake-${lane}`, provision: { junction: [], copied: [], commandOk: true, degraded: false, issues: [] } };
	}
	const meta: TraceRunMeta = {
		runId: "tfl-c8",
		shortId: "c8",
		status: "running",
		task: "fix app",
		repoRoot: repo,
		createdAt: new Date().toISOString(),
		baseCommit,
		headBefore: baseCommit,
		runDir,
		wtDir,
		laneWallClockMin: 45,
		laneDeadlineAt: new Date(Date.now() + 45 * 60_000).toISOString(),
		lanes,
	};
	writeFileSync(join(runDir, "meta.json"), JSON.stringify(meta, null, 2) + "\n", "utf8");
	return meta;
}

/** 给 lane 造修改 + 叙事 + validation.json；返回该 lane 是否造了 untracked。 */
function simulateLane(meta: TraceRunMeta, lane: LaneId, opts: { fix: string; validation: object; untracked?: boolean; newTest?: string; sharedNew?: string }): void {
	const wt = meta.lanes[lane].worktree;
	writeFileSync(join(wt, "app.txt"), opts.fix);
	if (opts.newTest) writeFileSync(join(wt, "test.txt"), opts.newTest);
	if (opts.sharedNew) writeFileSync(join(wt, "shared.test.txt"), opts.sharedNew);
	if (opts.untracked) writeFileSync(join(wt, "helper.txt"), "h\n");
	const laneDir = join(meta.runDir, "lanes", lane);
	mkdirSync(laneDir, { recursive: true });
	writeFileSync(join(laneDir, "trajectory.md"), "# t\n");
	writeFileSync(join(laneDir, "validation.json"), JSON.stringify(opts.validation));
}

try {
	const meta = makeRun();

	// 三路不同修法 + 各自验证命令（A、B 命令相同 → pooled 合并；C 带绝对路径 → 归一化）
	simulateLane(meta, "A", {
		fix: "v2-by-A\n",
		validation: { reproductions: [{ command: "node check.js", portable: true }], testFiles: ["test.txt"] },
		untracked: true,
		newTest: "t2-by-A\n",
	});
	simulateLane(meta, "B", {
		fix: "v2-by-B\n",
		validation: { validationCommands: ["node check.js"], testFiles: [] },
	});
	simulateLane(meta, "C", {
		fix: "v2-by-C\n",
		validation: { validationCommands: [`node ${join(meta.lanes.C.worktree, "check.js")}`], testFiles: [] },
	});

	const collect = collectRunArtifacts(meta);

	// ── 归一化 ─────────────────────────────────────────────────
	const normalized = normalizeCommand(`node ${meta.lanes.C.worktree}\\check.js`, meta);
	assert.equal(normalized, "node check.js", "worktree 绝对路径剥除");
	// review major 10：引号包裹形式（cd "<wt>" && ...）也要剥除
	const normQuoted = normalizeCommand(`cd "${meta.lanes.A.worktree}" && node check.js`, meta);
	assert.ok(!normQuoted.toLowerCase().includes(meta.lanes.A.worktree.toLowerCase()), `引号路径应被剥除：${normQuoted}`);
	assert.ok(/node check\.js$/.test(normQuoted.trim()), `剥除后应剩下命令本体：${normQuoted}`);
	const pooled = poolCommands(collect, meta);
	assert.equal(pooled.length, 1, `C 归一化后与 A/B 合并为同一条（实际 ${JSON.stringify(pooled)}）`);
	const shared = pooled[0];
	assert.equal(shared.command, "node check.js");
	assert.deepEqual(shared.sourceLanes.sort(), ["A", "B", "C"].sort(), "三路来源合并");

	// ── 矩阵（fake exec：按 (lane,cmd) 脚本化 exit code 序列）──────────────
	const plans = new Map<string, number[]>();
	const seq = (lane: string, cmd: string, codes: number[]) => plans.set(`${lane}|${cmd}`, [...codes]);
	// "node check.js"：A 一次过；B 先 fail 后 pass（flaky）；C 两次 fail
	seq("A", "node check.js", [0]);
	seq("B", "node check.js", [1, 0]);
	seq("C", "node check.js", [1, 1]);
	const matrix = runCrossTest(meta, collect, {
		exec: (command, cwd) => {
			const lane = cwd.includes("eval-a") ? "A" : cwd.includes("eval-b") ? "B" : cwd.includes("eval-c") ? "C" : "?";
			const q = plans.get(`${lane}|${command}`) ?? [];
			return { status: q.length > 0 ? (q.shift() as number) : 0, output: `out-${lane}` };
		},
	});
	// A 的 testFiles=["test.txt"] 应作为 pooled test 进 B/C 的 eval 树（无冲突）
	assert.ok(matrix.lanes.B.pooledTestFiles.some((x) => x.includes("test.txt (A)")), `B 应收 A 的测试 diff：${JSON.stringify(matrix.lanes.B.pooledTestFiles)} notes=${JSON.stringify(matrix.lanes.B.notes)}`);
	assert.ok(matrix.lanes.C.pooledTestFiles.some((x) => x.includes("test.txt (A)")));
	assert.equal(matrix.lanes.A.pooledTestFiles.length, 0, "A 自己有 test.txt，无需 pooled");
	assert.ok(matrix.lanes.A.appliesCleanly && matrix.lanes.B.appliesCleanly && matrix.lanes.C.appliesCleanly);
	// 防抖语义
	const cell = (lane: LaneId) => matrix.cells.find((c) => c.lane === lane && c.command === "node check.js");
	assert.equal(cell("A")!.result, "pass");
	assert.equal(cell("A")!.attempts, 1);
	assert.equal(cell("B")!.result, "flaky", "fail→pass 必须标 flaky");
	assert.equal(cell("B")!.attempts, 2);
	assert.equal(cell("C")!.result, "fail", "两次 fail 才是 fail");
	assert.equal(cell("C")!.attempts, 2);
	// eval 树用后即删，原始 evidence worktree 不受影响
	assert.ok(!existsSync(join(meta.wtDir, "eval-a")));
	assert.ok(existsSync(join(meta.lanes.A.worktree, "app.txt")));
	// 报告落盘
	assert.ok(existsSync(join(meta.runDir, "cross-test.json")));
	const md = readFileSync(join(meta.runDir, "cross-test-report.md"), "utf8");
	assert.ok(md.includes("Cross-Test Report"));
	assert.ok(md.includes("node check.js"));
	assert.ok(md.includes("flaky"));
	const json = JSON.parse(readFileSync(join(meta.runDir, "cross-test.json"), "utf8")) as { cells: unknown[] };
	assert.equal(json.cells.length, 3);

	// ── path collision：A 与 B 报同一个 testFiles ──────────────────────
	const meta2 = makeRun(true);
	simulateLane(meta2, "A", { fix: "fixA\n", validation: { validationCommands: ["node t.js"], testFiles: ["shared.test.txt"] } });
	writeFileSync(join(meta2.lanes.A.worktree, "shared.test.txt"), "test A\n");
	simulateLane(meta2, "B", { fix: "fixB\n", validation: { validationCommands: ["node t.js"], testFiles: ["shared.test.txt"] } });
	writeFileSync(join(meta2.lanes.B.worktree, "shared.test.txt"), "test B\n");
	simulateLane(meta2, "C", { fix: "fixC\n", validation: { validationCommands: ["node t.js"] } });
	const collect2 = collectRunArtifacts(meta2);
	const matrix2 = runCrossTest(meta2, collect2, { exec: () => ({ status: 0, output: "" }) });
	assert.ok(
		matrix2.lanes.B.notes.some((n) => n.includes("collision") && n.includes("shared.test.txt")),
		`B 应记录与 A 的测试路径冲突：${JSON.stringify(matrix2.lanes.B.notes)}`,
	);
	assert.ok(matrix2.lanes.A.notes.some((n) => n.includes("collision")));
	assert.ok(matrix2.cells.every((c) => c.result === "pass"), "干净场景全 pass");

	console.log("trace-fusion crosstest tests passed");
} finally {
	try {
		rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
	} catch (err) {
		console.warn(`cleanup warning: ${(err as Error).message}`);
	}
}
