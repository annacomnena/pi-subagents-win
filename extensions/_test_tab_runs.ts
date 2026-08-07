import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
	buildTabStatusView,
	classifyTabStatus,
	composeTabStatus,
	emptyTabUsage,
	listTabDispatches,
	listTabResults,
	newTabRunId,
	probeSessionFile,
	probeSessionsForDispatch,
	readTabDispatch,
	readTabResultFile,
	readTabState,
	sessionBucketForCwd,
	validateTabDispatchRecord,
	validateTabResult,
	validateTabState,
	writeTabDispatch,
	writeTabState,
	type TabDispatchRecord,
	type TabState,
} from "./tab-runs.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "fixtures");

const WORKFLOW = "workflow" as const;

// ── runId 生成 ─────────────────────────────────────────────────────
{
	const a = newTabRunId(new Date(1785997500000));
	const b = newTabRunId(new Date(1785997500000));
	assert.ok(a.startsWith("tab_"), `runId should start with tab_: ${a}`);
	assert.notEqual(a, b, "runId must be unique");
}

// ── session 桶命名（与 pi session-manager.js:245 一致）────────────
{
	assert.equal(sessionBucketForCwd("G:\\code\\worktrees\\GreenCAD-219"), "--G--code-worktrees-GreenCAD-219--");
	assert.equal(sessionBucketForCwd("C:\\Users\\Annacomnena"), "--C--Users-Annacomnena--");
	assert.equal(sessionBucketForCwd("/home/user/project"), "--home-user-project--");
}

// ── probe：命中与基本信息 ─────────────────────────────────────────
{
	const p = probeSessionFile(join(FIXTURES, "session-tooluse.jsonl"), "1007", WORKFLOW);
	assert.equal(p.matched, true, "tooluse fixture should match taskId 1007");
	assert.equal(p.matchReason, "first-user-prefix");
	assert.equal(p.lastRole, "assistant");
	assert.equal(p.lastStopReason, "toolUse");
	assert.equal(p.sessionCwd, "G:\\code\\worktrees\\GreenCAD-219");
	assert.ok(p.usage && p.usage.input === 1234, "usage should accumulate input tokens");
	assert.ok(p.usage && p.usage.cost === 0.0042);
}

// ── probe：research 前缀模式匹配 ──────────────────────────────────
{
	// workflow 模式探测 research 前缀 → 不匹配
	const w = probeSessionFile(join(FIXTURES, "session-research.jsonl"), "1008", WORKFLOW);
	assert.equal(w.matched, false, "research prefix must not match workflow mode");
	// research 模式 → 匹配
	const r = probeSessionFile(join(FIXTURES, "session-research.jsonl"), "1008", "research");
	assert.equal(r.matched, true, "research prefix must match research mode");
}

// ── probe：taskId 不匹配 ──────────────────────────────────────────
{
	const p = probeSessionFile(join(FIXTURES, "session-nomatch.jsonl"), "1007", WORKFLOW);
	assert.equal(p.matched, false, "session for task 9999 must not match task 1007");
}

// ── probe：无 assistant（useronly）────────────────────────────────
{
	const p = probeSessionFile(join(FIXTURES, "session-useronly.jsonl"), "1007", WORKFLOW);
	assert.equal(p.matched, true);
	assert.equal(p.lastRole, "user");
	assert.equal(p.lastStopReason, undefined);
}

// ── 判态（保守规则）───────────────────────────────────────────────
{
	// toolUse → working
	const st = classifyTabStatus(probeSessionFile(join(FIXTURES, "session-tooluse.jsonl"), "1007", WORKFLOW));
	assert.equal(st.phase, "working");
	assert.equal(st.turn, "working");
	assert.equal(st.terminal, false);
	assert.equal(st.resultMissing, true);

	// stop → waiting（不是完成！）
	const sw = classifyTabStatus(probeSessionFile(join(FIXTURES, "session-stop.jsonl"), "1007", WORKFLOW));
	assert.equal(sw.phase, "waiting", "stop means waiting for input, not completed");
	assert.equal(sw.turn, "idle");
	assert.equal(sw.terminal, false);
	assert.ok(sw.lastAssistantText && sw.lastAssistantText.includes("已完成修复"), "should keep last assistant text");

	// error → unconfirmed + turn=error
	const se = classifyTabStatus(probeSessionFile(join(FIXTURES, "session-error.jsonl"), "1007", WORKFLOW));
	assert.equal(se.phase, "unconfirmed");
	assert.equal(se.turn, "error");
	assert.equal(se.terminal, false);

	// aborted → unconfirmed + turn=error
	const sa = classifyTabStatus(probeSessionFile(join(FIXTURES, "session-aborted.jsonl"), "219", "execute"));
	assert.equal(sa.phase, "unconfirmed");
	assert.equal(sa.turn, "error");

	// useronly → working（在途）
	const su = classifyTabStatus(probeSessionFile(join(FIXTURES, "session-useronly.jsonl"), "1007", WORKFLOW));
	assert.equal(su.phase, "working");

	// 无匹配 → dispatched
	const sn = classifyTabStatus(probeSessionFile(join(FIXTURES, "session-nomatch.jsonl"), "1007", WORKFLOW));
	assert.equal(sn.phase, "dispatched");
	assert.equal(sn.resultMissing, true);

	// null probe → dispatched
	const s0 = classifyTabStatus(null);
	assert.equal(s0.phase, "dispatched");
	assert.equal(s0.terminal, false);

	// P1-1：无匹配但超过 grace → orphaned（标签页早夭收敛）
	const sOrphan = classifyTabStatus(null, {
		dispatchedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
		graceMs: 5 * 60_000,
	});
	assert.equal(sOrphan.phase, "orphaned");
	assert.equal(sOrphan.terminal, false);
	// grace 内仍 dispatched
	const sFresh = classifyTabStatus(null, {
		dispatchedAt: new Date(Date.now() - 60_000).toISOString(),
		graceMs: 5 * 60_000,
	});
	assert.equal(sFresh.phase, "dispatched");
	// composeTabStatus 透传 dispatchedAt 同样收敛
	const vOrphan = composeTabStatus({
		runId: "tab_o1",
		dispatch: { id: "tab_o1", version: 1, taskId: "1007", mode: "workflow", cwd: "G:\\x", dispatchedAt: new Date(Date.now() - 10 * 60_000).toISOString(), dispatchStatus: "dispatched" },
		state: null, result: null, probe: null,
		dispatchedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
	});
	assert.equal(vOrphan.phase, "orphaned");
}

// ── 结果文件校验与读取 ────────────────────────────────────────────
{
	// 合法结果
	const ok = validateTabResult({
		id: "tab_x",
		taskId: "1007",
		status: "completed",
		finishedAt: "2026-08-06T05:00:00.000Z",
		summary: "done",
		artifacts: ["plans/20260806.md"],
		usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.1, turns: 5 },
	});
	assert.equal(ok.ok, true, JSON.stringify(ok.errors));
	assert.equal(ok.value?.status, "completed");
	assert.equal(ok.value?.artifacts?.[0], "plans/20260806.md");

	// 非法状态
	const bad = validateTabResult({ id: "tab_x", taskId: "1007", status: "pending", finishedAt: "x" });
	assert.equal(bad.ok, false);
	assert.ok(bad.errors.some((e) => e.includes("status")));

	// 缺失 id / taskId
	const bad2 = validateTabResult({ status: "completed", finishedAt: "x" });
	assert.equal(bad2.ok, false);

	// 非对象
	assert.equal(validateTabResult("nope").ok, false);
	assert.equal(validateTabResult(null).ok, false);

	// 读取缺失文件 → null
	assert.equal(readTabResultFile(FIXTURES, "tab_doesnotexist"), null);
	assert.deepEqual(listTabResults(FIXTURES), []);
}

// ── 空 usage ──────────────────────────────────────────────────────
{
	const u = emptyTabUsage();
	assert.deepEqual(u, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 });
}

// ── 派发账本：写/读/校验/列表 ─────────────────────────────────────
{
	const runsDir = mkdtempSync(join(tmpdir(), "tab-runs-dispatch-test-"));
	const record: TabDispatchRecord = {
		id: "tab_d1",
		version: 1,
		taskId: "1007",
		mode: "workflow",
		title: "MyRepo-1007-修复",
		cwd: "G:\\code\\worktrees\\GreenCAD-219",
		requestedModel: "anthropic/claude-sonnet-4",
		dispatchedAt: "2026-08-06T03:45:15.433Z",
		dispatchStatus: "dispatched",
	};

	writeTabDispatch(runsDir, record);
	assert.deepEqual(readTabDispatch(runsDir, "tab_d1"), record);
	assert.equal(readTabDispatch(runsDir, "tab_missing"), null);

	const listed = listTabDispatches(runsDir);
	assert.equal(listed.length, 1);
	assert.equal(listed[0]?.id, "tab_d1");

	// 校验
	assert.equal(validateTabDispatchRecord(record).ok, true);
	assert.equal(validateTabDispatchRecord({ ...record, id: undefined }).ok, false);
	assert.equal(validateTabDispatchRecord({ ...record, dispatchStatus: "weird" }).ok, false);

	// 损坏文件 → null
	writeFileSync(join(runsDir, "tab_broken.json"), "{oops", "utf8");
	assert.equal(readTabDispatch(runsDir, "tab_broken"), null);

	rmSync(runsDir, { recursive: true, force: true });
}

// ── state 写/读/校验 ──────────────────────────────────────────────
{
	const runsDir = mkdtempSync(join(tmpdir(), "tab-runs-state-test-"));
	const state: TabState = {
		id: "tab_s1",
		phase: "waiting",
		turn: "idle",
		terminal: false,
		sessionPath: "C:\\pi\\sessions\\x.jsonl",
		pid: 1234,
		lastActivityAt: "2026-08-06T04:00:00.000Z",
		lastAssistantText: "done",
		lastStopReason: "stop",
		usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.1, turns: 5 },
	};
	writeTabState(runsDir, "tab_s1", state);
	assert.deepEqual(readTabState(runsDir, "tab_s1"), state);
	assert.equal(readTabState(runsDir, "tab_nope"), null);
	assert.equal(validateTabState({ ...state, phase: "nonsense" }).ok, false);
	assert.equal(validateTabState({ ...state, terminal: "yes" }).ok, false);
	rmSync(runsDir, { recursive: true, force: true });
}

// ── 组合判态 composeTabStatus：result > state > probe ─────────────
{
	const dispatch: TabDispatchRecord = {
		id: "tab_c1", version: 1, taskId: "1007", mode: "workflow", cwd: "G:\\code\\worktrees\\GreenCAD-219",
		dispatchedAt: "2026-08-06T03:45:15.433Z", dispatchStatus: "dispatched",
	};

	// 1) result 优先 → 终态
	const v1 = composeTabStatus({
		runId: "tab_c1", dispatch, state: null, result: {
			id: "tab_c1", taskId: "1007", status: "completed", finishedAt: "2026-08-06T05:00:00.000Z", summary: "done",
		}, probe: null,
	});
	assert.equal(v1.phase, "completed");
	assert.equal(v1.terminal, true);
	assert.equal(v1.resultMissing, false);
	assert.equal(v1.source, "result-file");

	// 2) 无 result、有 state → 用 state（waiting 不是终态）
	const v2 = composeTabStatus({
		runId: "tab_c1", dispatch, state: { id: "tab_c1", phase: "waiting", turn: "idle", terminal: false }, result: null, probe: null,
	});
	assert.equal(v2.phase, "waiting");
	assert.equal(v2.terminal, false);
	assert.equal(v2.resultMissing, true);

	// 3) 无 result/state、probe toolUse → working
	const v3 = composeTabStatus({
		runId: "tab_c1", dispatch, state: null, result: null,
		probe: probeSessionFile(join(FIXTURES, "session-tooluse.jsonl"), "1007", "workflow"),
	});
	assert.equal(v3.phase, "working");

	// 4) 无 result/state、probe stop → waiting（不是完成）
	const v4 = composeTabStatus({
		runId: "tab_c1", dispatch, state: null, result: null,
		probe: probeSessionFile(join(FIXTURES, "session-stop.jsonl"), "1007", "workflow"),
	});
	assert.equal(v4.phase, "waiting");
	assert.equal(v4.terminal, false, "stop 绝不等于工作流完成");
}

// ── probeSessionsForDispatch：按 cwd 桶 + taskId 前缀找匹配 ──────
{
	const sessionsRoot = mkdtempSync(join(tmpdir(), "tab-runs-sessions-test-"));
	const bucket = join(sessionsRoot, "--G--code-worktrees-GreenCAD-219--");
	mkdirSync(bucket, { recursive: true });
	// 拷贝 fixtures 作为真实会话文件
	for (const f of ["session-tooluse.jsonl", "session-stop.jsonl", "session-nomatch.jsonl"]) {
		copyFileSync(join(FIXTURES, f), join(bucket, f));
	}

	const dispatch: TabDispatchRecord = {
		id: "tab_p1", version: 1, taskId: "1007", mode: "workflow", cwd: "G:\\code\\worktrees\\GreenCAD-219",
		dispatchedAt: "2026-08-06T03:00:00.000Z", dispatchStatus: "dispatched",
	};
	const probes = probeSessionsForDispatch(dispatch, sessionsRoot);
	// 命中 tooluse + stop 两条（taskId 1007）；nomatch（9999）不命中
	assert.equal(probes.length, 2, `expected 2 matches, got ${probes.length}`);
	assert.ok(probes.every((p) => p.matched));

	// buildTabStatusView：完整链路（state 缺失 → 用 probe，最新匹配 stop → waiting）
	const runsDir = mkdtempSync(join(tmpdir(), "tab-runs-view-test-"));
	writeTabDispatch(runsDir, dispatch);
	const view = buildTabStatusView(runsDir, "tab_p1", sessionsRoot);
	assert.equal(view.runId, "tab_p1");
	assert.equal(view.dispatch?.taskId, "1007");
	assert.equal(view.phase, "waiting", "最新匹配会话是 stop → waiting");
	assert.equal(view.resultMissing, true);

	rmSync(sessionsRoot, { recursive: true, force: true });
	rmSync(runsDir, { recursive: true, force: true });
}

console.log("tab-runs tests passed");
