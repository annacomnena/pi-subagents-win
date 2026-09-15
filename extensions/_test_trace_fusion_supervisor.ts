/**
 * _test_trace_fusion_supervisor.ts — 主会话自动收集决策测试（trace-fusion 自动收集）
 *
 * 锁定 maybeAutoCollectTraceRun 的决策矩阵：
 *   - 非 trace tab（tabRunId 不在任何 running run 里）→ isTrace:false（走默认 reclaim 流程）
 *   - 部分 lane 终态 → progress（不 spawn）
 *   - 三路全终态 → started + spawn seam 收到 collect-cli.ts 与 runId
 *   - 已有 cross-test.json → already-done（不重复 spawn）
 *   - run 非 running 状态 → isTrace:false
 *
 * 运行：node --experimental-strip-types extensions/_test_trace_fusion_supervisor.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { maybeAutoCollectTraceRun } from "./trace-fusion/supervisor.ts";

const root = mkdtempSync(join(tmpdir(), "tfl-sv-test-"));
const runsDir = join(root, "runs");
const tabRunsDir = join(root, "tab-runs");
mkdirSync(tabRunsDir, { recursive: true });

/** 手工搭一个 running run（免 git——决策逻辑不碰 git）。 */
function makeRun(runId: string, tabIds: Record<"A" | "B" | "C", string>, status = "running"): void {
	const runDir = join(runsDir, runId);
	mkdirSync(runDir, { recursive: true });
	writeFileSync(join(runDir, "meta.json"), JSON.stringify({
		runId,
		shortId: runId,
		status,
		task: "t",
		repoRoot: root,
		createdAt: new Date().toISOString(),
		baseCommit: "0".repeat(40),
		headBefore: "0".repeat(40),
		runDir,
		wtDir: join(root, `wt-${runId}`),
		laneWallClockMin: 45,
		laneDeadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
		lanes: {
			A: { lane: "A", worktree: join(root, "wa"), tabRunId: tabIds.A, provision: { junction: [], copied: [], commandOk: true, degraded: false, issues: [] } },
			B: { lane: "B", worktree: join(root, "wb"), tabRunId: tabIds.B, provision: { junction: [], copied: [], commandOk: true, degraded: false, issues: [] } },
			C: { lane: "C", worktree: join(root, "wc"), tabRunId: tabIds.C, provision: { junction: [], copied: [], commandOk: true, degraded: false, issues: [] } },
		},
	}, null, 2) + "\n", "utf8");
}

const laneResult = (tabId: string): void => writeFileSync(join(tabRunsDir, `${tabId}.result.json`), JSON.stringify({ status: "completed", summary: "s" }));

try {
	makeRun("tfl-sv", { A: "tabA", B: "tabB", C: "tabC" });

	// 非 trace tab
	const foreign = maybeAutoCollectTraceRun("tab_somewhere_else", { runsDir, tabRunsDir });
	assert.deepEqual(foreign, { isTrace: false }, "陌生 tab 交回默认流程");

	// 1/3 → progress，不 spawn
	laneResult("tabA");
	let spawned = 0;
	const p1 = maybeAutoCollectTraceRun("tabA", {
		runsDir, tabRunsDir,
		spawnWorker: () => { spawned++; },
	});
	assert.equal(p1.isTrace, true);
	assert.ok(!p1.isTrace || p1.phase === "progress");
	assert.ok(!p1.isTrace || p1.done === 1);
	assert.equal(spawned, 0, "未全终态不 spawn");

	// 3/3 → started + spawn 收到 runId 与 collect-cli 路径
	laneResult("tabB");
	laneResult("tabC");
	let gotScript = "";
	let gotRunId = "";
	const started = maybeAutoCollectTraceRun("tabC", {
		runsDir, tabRunsDir,
		spawnWorker: (script, runId) => { spawned++; gotScript = script; gotRunId = runId; },
	});
	assert.ok(started.isTrace && started.phase === "started");
	assert.equal(gotRunId, "tfl-sv");
	assert.ok(gotScript.endsWith("collect-cli.ts"), `spawn 应指向 collect-cli 入口：${gotScript}`);
	assert.equal(spawned, 1);

	// 已有 cross-test.json → already-done，不再 spawn
	writeFileSync(join(runsDir, "tfl-sv", "cross-test.json"), "{}");
	const again = maybeAutoCollectTraceRun("tabA", { runsDir, tabRunsDir, spawnWorker: () => { spawned++; } });
	assert.ok(again.isTrace && again.phase === "already-done");
	assert.equal(spawned, 1, "已收集不重复 spawn");

	// 非 running 状态 → isTrace false
	makeRun("tfl-done", { A: "tabX", B: "tabY", C: "tabZ" }, "completed");
	laneResult("tabX");
	const done = maybeAutoCollectTraceRun("tabX", { runsDir, tabRunsDir, spawnWorker: () => { spawned++; } });
	assert.deepEqual(done, { isTrace: false }, "终态 run 不再触发自动收集");

	// runsDir 不存在 → isTrace false（容错）
	const missing = maybeAutoCollectTraceRun("tabA", { runsDir: join(root, "nope"), tabRunsDir });
	assert.deepEqual(missing, { isTrace: false });

	console.log("trace-fusion supervisor tests passed");
} finally {
	try {
		rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
	} catch (err) {
		console.warn(`cleanup warning: ${(err as Error).message}`);
	}
}
