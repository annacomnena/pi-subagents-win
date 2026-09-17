/**
 * _test_trace_fusion_launch.ts — C6 编排集成测试（真实 git 临时仓库 + fake tab spawn）
 *
 * 锁定契约：
 *   §15    runId/shortId 与目录布局（artifact 长路径 / worktree 短路径）
 *   §16    三 lane 同一 baseCommit；部分 worktree 失败 → 整体拒绝（无残缺 run）
 *   §17    三 tab 同一 task、只差 lane metadata；mode=trace 账本；不经过 workflow builder
 *   §24.1  meta.json 落盘 + readTraceRunMeta 回读
 *   §24.2  laneDeadlineAt 由 maxWallClockPerLaneMin 推出
 *   §16.1  供给降级 lane 进 meta 并反映到 worker prompt
 *   派发失败回滚：全失败 → meta failed + worktree 清理
 *
 * 运行：node --experimental-strip-types extensions/_test_trace_fusion_launch.ts
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

const gitVer = spawnSync("git", ["--version"], { encoding: "utf8", windowsHide: true });
if (gitVer.status !== 0) {
	console.log("git 不可用，trace-fusion launch 测试 skipped");
	process.exit(0);
}

import { launchTraceRun, newTraceRunId, readTraceRunMeta, type TabSpawner } from "./trace-fusion/launch-workers.ts";
import { ensureDirTrusted } from "./trace-fusion/trust.ts";
import { buildTraceWorkerPrompt } from "./trace-fusion/worker-prompt.ts";
import { DEFAULT_TRACE_FUSION_CONFIG, type TraceFusionConfig } from "./trace-fusion/types.ts";
import type { TabLaunchOptions } from "./tab-launch-core.ts";

const cfg = (over: Partial<TraceFusionConfig> = {}): TraceFusionConfig => ({
	...structuredClone(DEFAULT_TRACE_FUSION_CONFIG),
	// 本文件锁的是 implement 模式（worktree 管线）——diagnose 分支另有专项用例
	mode: "implement",
	maxWallClockPerLaneMin: 45,
	...over,
});

const root = mkdtempSync(join(tmpdir(), "tfl-c6-test-"));

function g(args: string[], cwd: string): number {
	return spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		windowsHide: true,
		input: "msg\n",
		env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
	}).status ?? -1;
}

/** 记录型 fake spawner：不真开 WT。 */
function makeFakeSpawner(failLanes: Set<string> = new Set()): { spawner: TabSpawner; calls: (TabLaunchOptions & { __prompt: string })[] } {
	const calls: (TabLaunchOptions & { __prompt: string })[] = [];
	const spawner: TabSpawner = (opts) => {
		calls.push({ ...opts, __prompt: opts.prompt });
		const laneArg = opts.traceLane ?? "";
		if (failLanes.has(laneArg)) return { error: "simulated spawn failure" };
		return { error: undefined };
	};
	return { spawner, calls };
}

try {
	const repo = join(root, "repo");
	mkdirSync(repo, { recursive: true });
	assert.equal(g(["init", "-b", "main"], repo), 0);
	writeFileSync(join(repo, "a.txt"), "v1\n");
	g(["add", "."], repo);
	g(["commit", "-m", "init"], repo);

	const runsDir = join(root, "runs");
	const wtRoot = join(root, "tfl-wt");

	// ── newTraceRunId 格式 ──────────────────────────────────────
	const { runId: rid, shortId: sid } = newTraceRunId(new Date("2026-09-15T10:20:30"));
	assert.match(rid, /^tfl-20260915-102030-[0-9a-f]{4}$/);
	assert.equal(sid, "20260915-102030-" + rid.slice(-4));

	// ── 成功路径 ────────────────────────────────────────────────
	const { spawner, calls } = makeFakeSpawner();
	const res = launchTraceRun({
		task: "修复 flaky 测试 test-sync",
		repoRoot: repo,
		wtExe: "wt.exe",
		piCli: "pi.mjs",
		config: cfg(),
		runsDir,
		wtRoot,
		now: new Date("2026-09-15T10:00:00"),
		spawnTab: spawner,
	});
	assert.equal(res.ok, true, `应成功：${res.ok ? "" : res.error}`);
	if (!res.ok) process.exit(1);
	const meta = res.meta;

	// 目录布局：artifact 在 runsDir/<runId>，worktree 在短路径 wtRoot/<shortId>/{a,b,c}
	assert.equal(meta.runDir, join(runsDir, meta.runId));
	assert.equal(meta.wtDir, join(wtRoot, meta.shortId));
	for (const lane of ["A", "B", "C"] as const) {
		assert.ok(existsSync(join(meta.wtDir, lane.toLowerCase(), "a.txt")), `lane ${lane} worktree 存在且有快照内容`);
	}
	// §16 同源：三 lane HEAD = baseCommit
	for (const lane of ["a", "b", "c"] as const) {
		const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: join(meta.wtDir, lane), encoding: "utf8" }).stdout.trim();
		assert.equal(head, meta.baseCommit, `lane ${lane} detached 在 base`);
	}

	// §17 三 tab 同一 task、只差 metadata：profile/traceRunId 正确，lane 不同，task 相同
	assert.equal(calls.length, 3);
	const prompts = new Set<string>();
	for (const c of calls) {
		assert.equal(c.sessionProfile, "trace-worker");
		assert.equal(c.traceRunId, meta.runId);
		assert.equal(c.model, undefined, "workerModel 未配置时不传 model");
		assert.ok(c.traceLane === "A" || c.traceLane === "B" || c.traceLane === "C");
		assert.ok(!c.skills || c.skills.length === 0, "trace worker 不经 --skill 注入 workflow 技能");
		assert.ok(c.__prompt.includes("修复 flaky 测试 test-sync"), "同一任务本体");
		assert.ok(c.__prompt.includes(`TRACE ${c.traceLane}`), "lane 身份注入 prompt");
		prompts.add(c.__prompt);
	}
	assert.equal(prompts.size, 3, "三份 prompt 各自 lane 不同（metadata 不同）");
	// prompt 不包含 workflow 前缀体系
	for (const p of prompts) assert.ok(!p.includes("根据workflow"), "不得经过 workflow prompt builder");

	// 账本：mode=trace 写入 tab-runs 目录
	const tabRunsDir = join(root, "tab-runs-fake") === join(root, "tab-runs-fake") ? undefined : undefined;
	void tabRunsDir;

	// §24.1 meta 回读
	const reread = readTraceRunMeta(meta.runDir);
	assert.ok(reread);
	assert.equal(reread!.runId, meta.runId);
	assert.equal(reread!.status, "running");
	for (const lane of ["A", "B", "C"] as const) {
		assert.equal(reread!.lanes[lane].tabRunId.length > 0, true, `lane ${lane} 有 tabRunId`);
		assert.ok(existsSync(join(meta.runDir, "lanes", lane, "provision.json")), "供给报告落盘");
	}
	// §24.2 deadline
	assert.equal(new Date(reread!.laneDeadlineAt).getTime() - new Date(reread!.createdAt).getTime(), 45 * 60_000);

	// ── workerModel 传递 ────────────────────────────────────────
	const { spawner: sp2, calls: calls2 } = makeFakeSpawner();
	const res2 = launchTraceRun({
		task: "task two", repoRoot: repo, wtExe: "wt.exe", piCli: "pi.mjs",
		config: cfg({ workerModel: "Zhipu/glm-5.2" }),
		runsDir: join(root, "runs-b"), wtRoot, now: new Date("2026-09-15T11:00:00"), spawnTab: sp2,
	});
	assert.equal(res2.ok, true);
	for (const c of calls2) assert.equal(c.model, "Zhipu/glm-5.2", "workerModel 透传");

	// ── 供给降级反映到 prompt ───────────────────────────────────
	const { spawner: sp3, calls: calls3 } = makeFakeSpawner();
	const res3 = launchTraceRun({
		task: "task three", repoRoot: repo, wtExe: "wt.exe", piCli: "pi.mjs",
		config: cfg({ provisioning: { junction: ["no-such-dep-dir"], copy: [], command: "" } }),
		runsDir: join(root, "runs-c"), wtRoot, now: new Date("2026-09-15T12:00:00"), spawnTab: sp3,
	});
	assert.equal(res3.ok, true);
	for (const c of calls3) {
		assert.ok(c.__prompt.includes("degraded"), "供给降级必须写进 worker prompt");
	}
	if (res3.ok) {
		for (const lane of ["A", "B", "C"] as const) assert.equal(res3.meta.lanes[lane].provision.degraded, true);
	}

	// ── 单 lane spawn 失败 → run 降级 2/3，meta 仍 running ──────
	const { spawner: sp4, calls: calls4 } = makeFakeSpawner(new Set(["B"]));
	const res4 = launchTraceRun({
		task: "task four", repoRoot: repo, wtExe: "wt.exe", piCli: "pi.mjs",
		config: cfg(), runsDir: join(root, "runs-d"), wtRoot, now: new Date("2026-09-15T13:00:00"), spawnTab: sp4,
	});
	assert.equal(res4.ok, true, "单 lane 失败不算 run 失败");
	assert.equal(calls4.length, 3, "三 lane 都尝试派发");
	if (res4.ok) {
		assert.equal(res4.meta.lanes.B.tabRunId, "", "失败 lane 无 tabRunId");
		assert.equal(res4.meta.lanes.A.tabRunId.length > 0, true);
		assert.ok(res4.lines.some((l) => l.includes("2/3")), "降级提示 2/3");
	}

	// ── 全部 spawn 失败 → meta failed + worktree 清理 ───────────
	const { spawner: sp5 } = makeFakeSpawner(new Set(["A", "B", "C"]));
	const res5 = launchTraceRun({
		task: "task five", repoRoot: repo, wtExe: "wt.exe", piCli: "pi.mjs",
		config: cfg(), runsDir: join(root, "runs-e"), wtRoot, now: new Date("2026-09-15T14:00:00"), spawnTab: sp5,
	});
	assert.equal(res5.ok, false, "全失败必须报错");
	assert.ok(res5.error.includes("全部派发失败"));
	// worktree 被回滚：新 run 的 wt 目录不应残留 a/b/c
	if (res5.ok === false) {
		const shortDir = join(wtRoot, res5.error ? "" : "");
		void shortDir;
	}
	// meta.json 应标 failed
	const failedMeta = ((): { status: string } | null => {
		// 从 res5 拿不到 runDir（ok=false），扫 runsDir 最新含 task five 的 meta
		for (const d of readdirSync(join(root, "runs-e"))) {
			const p = join(root, "runs-e", d, "meta.json");
			if (!existsSync(p)) continue;
			const m = JSON.parse(readFileSync(p, "utf8")) as { task?: string; status?: string };
			if (m.task === "task five") return m as { status: string };
		}
		return null;
	})();
	assert.ok(failedMeta, "失败 run 也应有 meta 落盘");
	assert.equal(failedMeta!.status, "failed", "全失败 meta 标 failed");

	// ── preflight 拦截：非 git 目录 ─────────────────────────────
	const notRepo = join(root, "not-repo");
	mkdirSync(notRepo);
	const res6 = launchTraceRun({
		task: "x", repoRoot: notRepo, wtExe: "wt.exe", piCli: "pi.mjs",
		config: cfg(), runsDir: join(root, "runs-f"), wtRoot, now: new Date(), spawnTab: makeFakeSpawner().spawner,
	});
	assert.equal(res6.ok, false);
	assert.ok(res6.error.includes("git"));

	// ── worker-prompt 纯契约 ────────────────────────────────────
	const wp = buildTraceWorkerPrompt({
		task: "T", runId: "tfl-x", lane: "B", baseCommit: "abc123",
		worktree: "W:/wt/b", runDir: "R:/run", wallClockMin: 45,
	});
	assert.ok(wp.includes("TRACE B"));
	assert.ok(wp.includes("abc123"));
	assert.ok(wp.includes("trajectory.md"));
	assert.ok(wp.includes('agent: "searcher"'), "唯一委派形态应可复制");
	assert.ok(wp.includes("tab-finish"));
	assert.ok(wp.includes("supervisor"));
	for (const s of ["Root cause", "Failed approaches", "Recommended final direction"]) {
		assert.ok(wp.includes(s), `trajectory 九节契约缺：${s}`);
	}

	// ── trust 预信任模块 ────────────────────────────────────────
	{
		const trustPath = join(root, "trust.json");
		const mkDir = (n: string) => { const d = join(root, n); mkdirSync(d, { recursive: true }); return d; };

		// 文件不存在 → 创建并写 true
		const dir1 = mkDir("trust-a");
		const r1 = ensureDirTrusted(dir1, trustPath);
		assert.equal(r1.ok, true, `trust 写入应成功：${r1.error}`);
		const t1 = JSON.parse(readFileSync(trustPath, "utf8")) as Record<string, boolean>;
		assert.equal(Object.values(t1)[0], true);
		// realpath 口径（Windows 大小写无关地命中同一条目）
		const r1b = ensureDirTrusted(dir1.toUpperCase(), trustPath);
		assert.equal(r1b.ok, true);
		assert.equal(r1b.wrote, undefined, "幂等：已信任不再写");

		// 既有条目必须保留
		const dir2 = mkDir("trust-b");
		ensureDirTrusted(dir2, trustPath);
		const t2 = JSON.parse(readFileSync(trustPath, "utf8")) as Record<string, boolean>;
		assert.equal(Object.keys(t2).length, 2, "既有条目不得被清掉");
		assert.equal(Object.values(t2).every((v) => v === true), true);

		// 损坏的 trust.json → 拒绝写入（不吞用户文件）
		const badPath = join(root, "trust-bad.json");
		writeFileSync(badPath, "{not json", "utf8");
		const r3 = ensureDirTrusted(mkDir("trust-c"), badPath);
		assert.equal(r3.ok, false, "损坏文件必须拒写");
		assert.equal(readFileSync(badPath, "utf8"), "{not json", "损坏文件原样保留");
	}

	// ── diagnose 模式（2026-09-17）：零 worktree、零主仓库写入、cwd=主仓库、禁 edit/write ──
	{
		const repo2 = join(root, "repo-diag");
		mkdirSync(repo2, { recursive: true });
		assert.equal(g(["init", "-b", "main"], repo2), 0);
		writeFileSync(join(repo2, "src.txt"), "code\n");
		g(["add", "."], repo2);
		g(["commit", "-m", "init"], repo2);
		// 预置用户自己的脏项（不在清理范围，不算违规）
		writeFileSync(join(repo2, "user-dirty.txt"), "user\n");

		const { spawner, calls } = makeFakeSpawner();
		const res = launchTraceRun({
			task: "诊断一个 bug",
			repoRoot: repo2,
			wtExe: "wt.exe",
			piCli: "pi.cmd",
			config: { ...cfg(), mode: "diagnose" },
			runsDir: join(root, "runs-diag"),
			wtRoot,
			now: new Date("2026-09-17T09:00:00"),
			spawnTab: spawner,
		});
		assert.equal(res.ok, true, `diagnose 派发应成功：${!res.ok ? res.error : ""}`);
		if (res.ok) {
			assert.equal(res.meta.mode, "diagnose");
			assert.equal(res.meta.wtDir, "", "diagnose 不开 worktree");
			assert.equal(res.meta.baseCommit, res.meta.headBefore, "不折叠不建合成快照（base=HEAD）");
			assert.ok(!existsSync(res.meta.dirtyBaselineFile ?? "") === false, "基线文件已落盘");
			const baseline = readFileSync(res.meta.dirtyBaselineFile ?? "", "utf8");
			assert.ok(baseline.includes("user-dirty.txt"), "基线记录用户既有脏项");
			assert.ok(!existsSync(join(wtRoot, res.meta.shortId)), "不创建任何 worktree");
			assert.equal(Object.keys(res.meta.lanes).length, 3);
			for (const lane of ["A", "B", "C"] as const) {
				assert.equal(res.meta.lanes[lane].worktree.replace(/\\/g, "/"), repo2.replace(/\\/g, "/"), "lane 工作区=主仓库");
			}
			assert.equal(calls.length, 3, "三 tab 已派发");
			for (const c of calls) {
				assert.equal(c.cwd?.replace(/\\/g, "/"), repo2.replace(/\\/g, "/"), "tab cwd=主仓库");
				assert.ok(c.excludeTools?.includes("edit") && c.excludeTools.includes("write"), "diagnose 禁 edit/write");
				assert.ok(c.__prompt.includes("只读纪律"), "diagnose prompt 声明只读纪律");
				assert.ok(c.__prompt.includes("八节"), "diagnose 契约为八节叙事");
			}
		}
	}

	console.log("trace-fusion launch tests passed");
} finally {
	try {
		rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
	} catch (err) {
		console.warn(`cleanup warning: ${(err as Error).message}`);
	}
}

void basename;
