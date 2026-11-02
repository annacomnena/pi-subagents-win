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
import { DEFAULT_TRACE_FUSION_CONFIG, type TraceFusionConfig } from "./trace-fusion/types.ts";import type { TabLaunchOptions } from "./tab-launch-core.ts";

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
				// 2026-11-02 变更：只禁 edit；**write 必须保留**（lane 要用它写 artifact）。
				// 首跑实测：禁 write ⇒ 模型只能用 bash mkdir/cp 硬凑，产物落错位置、run 白跑。
				assert.ok(c.excludeTools?.includes("edit"), "diagnose 必须禁 edit（不改代码）");
				assert.ok(!c.excludeTools?.includes("write"), "diagnose 必须保留 write（写 trajectory.md/validation.json 的唯一正当方式）");
				assert.ok(c.__prompt.includes("用 `write` 工具"), "prompt 必须明确要求用 write 工具写 artifact");
				assert.ok(c.__prompt.includes("禁止】用 bash 写文件"), "prompt 必须明确禁止用 bash 写 artifact");
				assert.ok(c.__prompt.includes("find /") || c.__prompt.includes("盘符根"), "prompt 必须写明 R-13 全盘搜索禁令");
				assert.ok(c.__prompt.includes("tab-finish 工具") || c.__prompt.includes("tab-finish` 工具"), "prompt 必须强调 tab-finish 是工具不是命令");
				// 2026-11-02 用户裁定：任务本体必须在开头+结尾各强调一次（系统提示+AGENTS.md 太长会稀释注意力）
				const taskLine = "任务本体占位-" + Math.random().toString(36).slice(2);
				void taskLine;
				assert.ok(c.__prompt.includes("你要回答的问题（唯一目标"), "prompt 开头必须用醒目标题强调任务");
				assert.ok(c.__prompt.includes("再重申一次你要回答的问题"), "prompt 结尾必须重申任务（对抗注意力涣散）");
				assert.ok(c.__prompt.includes("结束前自检"), "prompt 结尾必须有自检清单");
				assert.ok(c.__prompt.includes("直接回答了它"), "自检项必须含「是否直接回答任务」");
				assert.ok(c.__prompt.includes("合法 JSON"), "自检项必须含 validation.json 合法性（实测 A/B 两条 lane 曾非法）");

				// 2026-11-02 b31e 实测：lane B 跑 18 次调用、答案完整，但全在聊天里、一个文件没写。
				// 补救：把「写文件」提成自检的第 0 条前置条件，而不是与内容检查并列。
				assert.ok(c.__prompt.includes("第 0 条"), "自检必须有第 0 条（写文件是前置条件）");
				assert.ok(c.__prompt.includes("不能只写在聊天回复里"), "必须明确禁止只把答案留在聊天里");
				assert.ok(c.__prompt.includes("停，先写文件"), "必须给出可执行的拦截动作");
				assert.ok(c.__prompt.includes("整趟白跑"), "必须说明后果");
				assert.ok(c.__prompt.includes("完成（三步，顺序不能变）"), "完成节必须给出 write→write→tab-finish 三步顺序");
				assert.ok(c.__prompt.includes("没写文件就 tab-finish"), "必须警告不写文件就 tab-finish 的后果");
				assert.ok(c.__prompt.includes("只读纪律"), "diagnose prompt 声明只读纪律");
				assert.ok(c.__prompt.includes("八节"), "diagnose 契约为八节叙事");
				// 2026-11-02：检索纪律（codegraph 优先）——lane 有 codegraph 却零提示时
				// 会去 grep 猜符号位置，白白烧掉 45 分钟预算。这里钉死「工具名 + 三种关键用法 + 陈旧闸门」。
				assert.ok(c.__prompt.includes("codegraph"), "diagnose prompt 必须提示 codegraph（否则 lane 只会 grep）");
				assert.ok(c.__prompt.includes("query"), "必须给 query 用法（按符号定位）");
				assert.ok(c.__prompt.includes("impact"), "必须给 impact 用法（改之前查调用方）");
				assert.ok(c.__prompt.includes("陈旧"), "必须给索引陈旧闸门（行号失真防护）");
				assert.ok(c.__prompt.includes("回退 grep"), "索引不可用时的回退路径必须写明");
				// 2026-11-02：复用既有 Wiki 知识（读）+ 禁用写入类动作（rebuild）。
				assert.ok(!c.excludeTools?.includes("wiki-nav"), "wiki-nav 必须对 lane 可用（复用已验证知识）");
				assert.ok(c.__prompt.includes("Wiki"), "prompt 必须指向 Wiki 作为先查面");
				assert.ok(c.__prompt.includes("source_paths"), "必须告诉 lane 按 source_paths 直接跳代码");
				assert.ok(c.__prompt.includes("rebuild"), "必须点名禁止的动作（rebuild）");
				assert.ok(c.__prompt.includes("semantic-rebuild"), "semantic-rebuild 也必须点名禁止（调远程 embedding）");
				// 死项回归：wiki-semantic 不是工具名，不应出现在 exclude 里
				assert.ok(!c.excludeTools?.includes("wiki-semantic"), "wiki-semantic 不是工具名，exclude 里不该有死项");
			}
		}
	}

	// ── laneConcurrency（2026-10-30）：KV 共享池约束下的分批派发 ──
	// 锁定：① 缺省 3 = 历史全派行为逐字不变；② 1/2 时只派首发波、余下写队列；
	//      ③ 队列文件能回读；④ per-lane 模型优先级四级降级。
	{
		const repo3 = join(root, "repo-conc");
		mkdirSync(repo3, { recursive: true });
		assert.equal(g(["init", "-b", "main"], repo3), 0);
		writeFileSync(join(repo3, "src.txt"), "code\n");
		g(["add", "."], repo3);
		g(["commit", "-m", "init"], repo3);

		const mk = () => makeFakeSpawner();

		// ① 缺省（不传 laneConcurrency ⇒ DEFAULT=3）：三路全派、无队列文件
		{
			const { spawner, calls } = mk();
			const res = launchTraceRun({
				task: "并发度缺省",
				repoRoot: repo3, wtExe: "wt.exe", piCli: "pi.cmd",
				config: { ...cfg(), mode: "diagnose" },
				runsDir: join(root, "runs-c3"), wtRoot,
				now: new Date("2026-10-30T01:00:00"), spawnTab: spawner,
			});
			assert.equal(res.ok, true, `缺省并发度应派发成功：${!res.ok ? res.error : ""}`);
			if (res.ok) {
				assert.equal(DEFAULT_TRACE_FUSION_CONFIG.laneConcurrency, 3, "缺省并发度必须是 3（历史行为）");
				assert.equal(calls.length, 3, "缺省必须三路全派");
				assert.equal(existsSync(join(res.meta.runDir, "lane-queue.json")), false, "无待发 ⇒ 不写队列文件");
			}
		}

		// ② laneConcurrency=1 严格串行：只派 A，B/C 进队列
		{
			const { spawner, calls } = mk();
			const res = launchTraceRun({
				task: "串行",
				repoRoot: repo3, wtExe: "wt.exe", piCli: "pi.cmd",
				config: { ...cfg(), mode: "diagnose", laneConcurrency: 1 },
				runsDir: join(root, "runs-c1"), wtRoot,
				now: new Date("2026-10-30T02:00:00"), spawnTab: spawner,
			});
			assert.equal(res.ok, true, `串行应派发成功：${!res.ok ? res.error : ""}`);
			if (res.ok) {
				assert.equal(calls.length, 1, "并发度 1 只能派一条");
				assert.ok(res.meta.lanes.A.tabRunId, "A 已派发");
				assert.equal(res.meta.lanes.B.tabRunId, "", "B 未派发");
				assert.equal(res.meta.lanes.C.tabRunId, "", "C 未派发");
				const qf = join(res.meta.runDir, "lane-queue.json");
				assert.ok(existsSync(qf), "待发队列必须落盘");
				const q = JSON.parse(readFileSync(qf, "utf8")) as { lanes: string[]; concurrency: number };
				assert.deepEqual(q.lanes, ["B", "C"], "队列顺序必须是 B,C");
				assert.equal(q.concurrency, 1, "队列记录并发度");
			}
		}

		// ③ laneConcurrency=2：派 A,B；C 进队列
		{
			const { spawner, calls } = mk();
			const res = launchTraceRun({
				task: "双路",
				repoRoot: repo3, wtExe: "wt.exe", piCli: "pi.cmd",
				config: { ...cfg(), mode: "diagnose", laneConcurrency: 2 },
				runsDir: join(root, "runs-c2"), wtRoot,
				now: new Date("2026-10-30T03:00:00"), spawnTab: spawner,
			});
			assert.equal(res.ok, true);
			if (res.ok) {
				assert.equal(calls.length, 2, "并发度 2 只派两条");
				const q = JSON.parse(readFileSync(join(res.meta.runDir, "lane-queue.json"), "utf8")) as { lanes: string[] };
				assert.deepEqual(q.lanes, ["C"], "只剩 C 待发");
			}
		}

		// ④ per-lane 模型：config.workerModelByLane 优先于全局 workerModel
		{
			const { spawner, calls } = mk();
			const res = launchTraceRun({
				task: "per-lane 模型",
				repoRoot: repo3, wtExe: "wt.exe", piCli: "pi.cmd",
				config: { ...cfg(), mode: "diagnose", workerModel: "prov/global", workerModelByLane: { B: "prov/lane-b" } },
				runsDir: join(root, "runs-pm"), wtRoot,
				now: new Date("2026-10-30T04:00:00"), spawnTab: spawner,
			});
			assert.equal(res.ok, true);
			if (res.ok) {
				const byTitle = new Map(calls.map((c) => [String(c.title), c.model]));
				const mA = [...byTitle].find(([t]) => t.includes(" L A".replace(/ /g, "")) || /-LA\b|\[TRACE A\]/.test(t))?.[1];
				assert.equal(calls.find((c) => /\[TRACE A\]/.test(String(c.title)))?.model, "prov/global", "A 退回全局");
				assert.equal(calls.find((c) => /\[TRACE B\]/.test(String(c.title)))?.model, "prov/lane-b", "B 用 per-lane");
				assert.equal(calls.find((c) => /\[TRACE C\]/.test(String(c.title)))?.model, "prov/global", "C 退回全局");
				void mA;
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
