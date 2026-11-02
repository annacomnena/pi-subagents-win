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
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { catchUpAutoCollect, isDispatcherSession, maybeAutoCollectTraceRun } from "./trace-fusion/supervisor.ts";

const root = mkdtempSync(join(tmpdir(), "tfl-sv-test-"));
const runsDir = join(root, "runs");
const tabRunsDir = join(root, "tab-runs");
mkdirSync(tabRunsDir, { recursive: true });

/** 手工搭一个 running run（免 git——决策逻辑不碰 git）。 */
function makeRun(runId: string, tabIds: Record<"A" | "B" | "C", string>, status = "running", dispatcher?: string): void {
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
		...(dispatcher !== undefined ? { dispatcherSessionId: dispatcher } : {}),
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

	// ---- claim 幂等：已有新鲜 claim → busy，不 spawn（防双 worker）
	makeRun("tfl-busy", { A: "tabP", B: "tabQ", C: "tabR" });
	laneResult("tabP");
	laneResult("tabQ");
	laneResult("tabR");
	writeFileSync(join(runsDir, "tfl-busy", "collect-worker.claim"),
		JSON.stringify({ pid: 999, at: new Date().toISOString() }));
	const busy = maybeAutoCollectTraceRun("tabP", { runsDir, tabRunsDir, spawnWorker: () => { spawned++; } });
	assert.ok(busy.isTrace && busy.phase === "busy");
	assert.equal(spawned, 1, "claim 持有期间不 spawn");

	// ---- catch-up：无 claim 的全终态 running run → started
	// （tfl-sv / tfl-busy 均已被前面步骤留下新鲜 claim → 幂等跳过）
	makeRun("tfl-catch", { A: "tabU", B: "tabV", C: "tabW" });
	laneResult("tabU");
	laneResult("tabV");
	laneResult("tabW");
	let caught: string[] = [];
	const ups = catchUpAutoCollect({
		runsDir, tabRunsDir,
		spawnWorker: (_s, runId) => { caught.push(runId); },
	});
	assert.deepEqual(ups.map((u) => u.runId), ["tfl-catch"], "只补无 claim 的 tfl-catch");
	assert.deepEqual(caught, ["tfl-catch"]);

	// 第二次 catch-up：tfl-catch 也已持 claim → 幂等零 spawn
	const ups2 = catchUpAutoCollect({
		runsDir, tabRunsDir,
		spawnWorker: (_s, runId) => { caught.push(runId); },
	});
	assert.deepEqual(ups2, [], "claim 已持有 → 幂等不重 spawn");
	assert.deepEqual(caught, ["tfl-catch"]);

	// ---- 2026-11-02 缺陷 A：串行续发必须返回 "resumed"，绝不能是 "started"
	// （旧版两者共用 "started"，调用方据此发「三路终态 + cross-test 已启动」——
	//  实测 a726 在 lane A 刚完、B 刚派、C 还在队列时就发了这条假通知）
	{
		makeRun("tfl-resume", { A: "tabRA", B: "", C: "" });
		writeFileSync(join(runsDir, "tfl-resume", "lane-queue.json"),
			JSON.stringify({ lanes: ["B", "C"], concurrency: 1 }));
		laneResult("tabRA"); // A 完成 → 应续发 B
		let resumeSpawned = 0;
		const res = maybeAutoCollectTraceRun("tabRA", {
			runsDir, tabRunsDir,
			wtExe: "wt.exe",
			piCli: "pi.js",
			// spawnTab 只在续发路径被调用
			spawnTab: () => { resumeSpawned++; return { ok: true, pid: 1 } as never; },
			spawnWorker: () => { throw new Error("续发成功时不得启 collect"); },
		});
		assert.ok(res.isTrace);
		assert.equal(res.phase, "resumed", `续发必须返回 resumed，实得 ${res.isTrace ? res.phase : "n/a"}`);
		if (res.isTrace && res.phase === "resumed") {
			assert.equal(res.lane, "B", "应续发 B");
			assert.ok(res.tabRunId.length > 0, "resumed 必须带 tabRunId（调用方要拼真实文案）");
			assert.deepEqual(res.remaining, ["C"], "remaining 应为 C");
		}
	}

	// ---- 2026-11-02 缺陷 C：续发锁 —— 已持新鲜 claim 时不得重复 spawn 同一 lane
	{
		makeRun("tfl-relock", { A: "tabLA", B: "", C: "" });
		writeFileSync(join(runsDir, "tfl-relock", "lane-queue.json"),
			JSON.stringify({ lanes: ["B", "C"], concurrency: 1 }));
		laneResult("tabLA");
		// 预置新鲜 resume.claim（模拟另一个会话正在续发）
		writeFileSync(join(runsDir, "tfl-relock", "resume.claim"),
			JSON.stringify({ pid: 4242, at: new Date().toISOString() }));
		let dupSpawn = 0;
		const locked = maybeAutoCollectTraceRun("tabLA", {
			runsDir, tabRunsDir, wtExe: "wt.exe", piCli: "pi.js",
			spawnTab: () => { dupSpawn++; return { ok: true, pid: 1 } as never; },
			spawnWorker: () => {},
		});
		assert.ok(locked.isTrace);
		assert.equal(locked.isTrace && locked.phase, "progress", "锁被持有 → 降级为 progress，不重复派发");
		assert.equal(dupSpawn, 0, "锁生效：不得双 spawn 同一 lane");
	}

	// ---- 2026-11-02 缺陷 B/D：归属过滤 —— dispatcherSessionId 不匹配的会话不得驱动该 run
	{
		const ownerFp = "tab_owner_session";
		const otherFp = "tab_other_session";
		// 直接测纯函数语义：无字段 → 放行（legacy）；有字段 → 比对
		const withOwner = (fp: string | undefined) =>
			({ runId: "x", dispatcherSessionId: fp }) as unknown as Parameters<typeof isDispatcherSession>[0];
		// 本进程指纹由 sessionScopeKey() 决定；测试进程通常无身份 → 返回 undefined → 放行
		// 因此这里只断言「无字段必须放行」这条零回归底线，以及函数可安全调用
		assert.equal(isDispatcherSession(withOwner(undefined)), true, "存量 meta 无归属字段 → 必须放行（零回归）");
		// 注入身份验证「拒绝」分支（否则测试进程无身份，永远走 legacy 放行 = 没测到核心）
		const savedTab = process.env.PI_TAB_RUN_ID;
		process.env.PI_TAB_RUN_ID = "tab_test_owner";
		try {
			assert.equal(isDispatcherSession(withOwner("tab_test_owner")), true, "指纹匹配 → 放行");
			assert.equal(isDispatcherSession(withOwner("tab_other_session")), false, "指纹不匹配 → 必须拒绝");
			// 无字段在有身份时仍放行（存量 run 零回归）
			assert.equal(isDispatcherSession(withOwner(undefined)), true, "有身份 + 无字段 → 仍放行");
		} finally {
			if (savedTab === undefined) delete process.env.PI_TAB_RUN_ID;
			else process.env.PI_TAB_RUN_ID = savedTab;
		}
		void otherFp;
	}

	// runsDir 不存在 → isTrace false（容错）
	const missing = maybeAutoCollectTraceRun("tabA", { runsDir: join(root, "nope"), tabRunsDir });
	assert.deepEqual(missing, { isTrace: false });

	// 归属过滤（2026-11-02 乱回事故）：非派发者会话必须报为「已消费的外来 lane」，
	// 不得返回 {isTrace:false}——那会让调用方把 lane tab 当普通 tab 走默认注入，
	// 完成消息就会投递给 global master。
	{
		makeRun("tfl-owned", { A: "tabOwnA", B: "tabOwnB", C: "tabOwnC" }, "running", "sess-dispatcher-x");
		const notMine = maybeAutoCollectTraceRun("tabOwnA", {
			runsDir,
			tabRunsDir,
			sessionScopeKey: () => "sess-somebody-else",
		});
		assert.equal(notMine.isTrace, true, "trace lane 不得交回默认流程（否则乱投 master）");
		assert.equal(
			notMine.isTrace ? notMine.phase : "n/a",
			"foreign",
			`非派发者必须得到 foreign，实得 ${notMine.isTrace ? notMine.phase : "isTrace:false"}`,
		);

		// 派发者本人：照旧进入正常决策（不得被 foreign 拦掉）
		const mine = maybeAutoCollectTraceRun("tabOwnA", { runsDir, tabRunsDir, sessionScopeKey: () => "sess-dispatcher-x" });
		assert.equal(mine.isTrace, true, "派发者仍须处理自己的 lane");
		assert.notEqual(
			mine.isTrace ? mine.phase : "n/a",
			"foreign",
			"派发者本人不得被判 foreign",
		);

		// 存量 run（无 dispatcherSessionId）：保持 legacy 放行，零回归
		const legacy = maybeAutoCollectTraceRun("tabA", { runsDir, tabRunsDir, sessionScopeKey: () => "sess-anyone" });
		assert.equal(legacy.isTrace, true, "存量 run 仍由会话处理");
		assert.notEqual(legacy.isTrace ? legacy.phase : "n/a", "foreign", "无归属信息的存量 run 不得被 foreign 拦掉");

		// seam 不传时走真实 sessionScopeKey()：不得抛（生产路径零注入）
		const noSeam = maybeAutoCollectTraceRun("tabOwnA", { runsDir, tabRunsDir });
		assert.equal(noSeam.isTrace, true, "无 seam 时必须仍给出确定结论");
	}

	// ---- 2026-11-02 追赶路径必须能续发：实测 `catchUpAutoCollect()` 无参调用
	// ⇒ opts.wtExe/piCli 均 undefined ⇒ tryResumeQueuedLane 直接 return null
	// ⇒ 待发 lane 永远饿死（c2f5 的 lane C：A/B 已终态、队列里挂着 C，就是在这饿死的）
	{
		makeRun("tfl-catch-resume", { A: "tabCR", B: "", C: "" });
		writeFileSync(join(runsDir, "tfl-catch-resume", "lane-queue.json"),
			JSON.stringify({ lanes: ["B", "C"], concurrency: 1 }));
		laneResult("tabCR"); // A 完成 → 追赶应续发 B
		let catchSpawned = 0;
		const c = catchUpAutoCollect({
			runsDir, tabRunsDir,
			wtExe: "wt.exe",
			piCli: "pi.js",
			spawnTab: () => { catchSpawned++; return { ok: true, pid: 1 } as never; },
			spawnWorker: () => { throw new Error("未全终态不得启 collect"); },
		});
		assert.equal(catchSpawned, 1, "追赶必须真的派一条 lane（无 wt/pi 注入的旧版这里是 0）");
		const r = c.find((x) => x.phase === "resumed");
		assert.ok(r, "追赶必须把续发上报（旧版只上报 started，续发对调用方不可见）");
		if (r && r.phase === "resumed") {
			assert.equal(r.lane, "B", "应续发 B");
			assert.equal(r.runId, "tfl-catch-resume", "上报必须带 runId");
		}
		// 续发的 tabRunId 必须回写 meta：否则 supervisor 认不出这条 lane，完成时也不会触发收集
		const meta2 = JSON.parse(readFileSync(join(runsDir, "tfl-catch-resume", "meta.json"), "utf8")) as
			{ lanes: Record<"A" | "B" | "C", { tabRunId: string }> };
		assert.ok(meta2.lanes.B.tabRunId.length > 0, "续发的 tabRunId 必须回写 meta.json");
	}

	console.log("trace-fusion supervisor tests passed");
} finally {
	try {
		rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
	} catch (err) {
		console.warn(`cleanup warning: ${(err as Error).message}`);
	}
}
