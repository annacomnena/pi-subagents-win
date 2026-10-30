import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
	TAB_RUNS_ARCHIVE_DIR,
	archiveStaleTabRuns,
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
	resolveTabLedger,
	sessionBucketForCwd,
	validateTabDispatchRecord,
	validateTabResult,
	validateTabState,
	writeTabDispatch,
	writeTabState,
	type TabDispatchRecord,
	type TabState,
} from "./tab-runs.ts";
import { LAUNCH_MODES } from "./launch.ts";

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

// ── 归档回退（2026-10-16 实测事故：归档 ⇒ 活着的 tab 不可 steer）─────────
{
	// 构造：一个 waiting（**活着**）的 tab + 一个 completed（终态）的 tab
	const runsDir2 = mkdtempSync(join(tmpdir(), "tab-runs-archive-"));
	const dispatch = (id: string): void => {
		writeFileSync(join(runsDir2, `${id}.json`), JSON.stringify({
			id, version: 1, taskId: "taskX", cwd: process.cwd(), mode: "workflow",
			dispatchStatus: "dispatched", dispatchedAt: new Date().toISOString(),
		}), "utf8");
	};
	const state = (id: string, phase: string, terminal: boolean): void => {
		writeFileSync(join(runsDir2, `${id}.state.json`), JSON.stringify({
			id, phase, turn: "idle", terminal, lastActivityAt: new Date().toISOString(),
		}), "utf8");
	};

	// ① 修根因：**waiting（活着）不得被归档**
	const alive = "tab_alive_waiting";
	dispatch(alive);
	state(alive, "waiting", false);
	const archived1 = archiveStaleTabRuns(runsDir2, 0); // maxAge=0：最激进的归档档位
	assert.equal(existsSync(join(runsDir2, `${alive}.json`)), true, "**waiting 活着 ⇒ 不得归档**（修前会红：旧实现只挡 working/attached）");
	assert.equal(existsSync(join(runsDir2, TAB_RUNS_ARCHIVE_DIR, `${alive}.json`)), false, "不得被移入 _archived");

	// ② 全未终态但无 state 文件 ⇒ 保守不归档（旧实现会归档）
	const noState = "tab_no_state";
	dispatch(noState);
	archiveStaleTabRuns(runsDir2, 0);
	assert.equal(existsSync(join(runsDir2, `${noState}.json`)), true, "无 state ⇒ 无法证明终态 ⇒ 不归档");

	// ③ 已终态 + 超龄 ⇒ 允许归档（真终态必须能清理）
	const dead = "tab_dead_completed";
	dispatch(dead);
	state(dead, "completed", true);
	// 把 dispatchedAt 改早，使超过 72h
	writeFileSync(join(runsDir2, `${dead}.json`), JSON.stringify({
		id: dead, version: 1, taskId: "taskX", cwd: process.cwd(), mode: "workflow",
		dispatchStatus: "dispatched",
		dispatchedAt: new Date(Date.now() - 100 * 3600 * 1000).toISOString(),
	}), "utf8");
	const archivedCount = archiveStaleTabRuns(runsDir2, 72);
	assert.ok(archivedCount >= 1, `已终态 + 超龄 ⇒ 归档（实得 ${archivedCount}）`);
	assert.equal(existsSync(join(runsDir2, TAB_RUNS_ARCHIVE_DIR, `${dead}.json`)), true, "终态账本已入 _archived");

	// ④ 判定区分：归档但**仍活** vs 归档且**已终态**
	//    alive：手动模拟「已被旧版本归档」的既成事实
	state(alive, "waiting", false);
	mkdirSync(join(runsDir2, TAB_RUNS_ARCHIVE_DIR), { recursive: true });
	writeFileSync(join(runsDir2, TAB_RUNS_ARCHIVE_DIR, `${alive}.json`), JSON.stringify({
		id: alive, version: 1, taskId: "taskX", cwd: process.cwd(), mode: "workflow",
		dispatchStatus: "dispatched", dispatchedAt: new Date().toISOString(),
	}), "utf8");
	// 移除活跃账本以模拟归档后的状态
	rmSync(join(runsDir2, `${alive}.json`), { force: true });
	const rAlive = resolveTabLedger(runsDir2, alive);
	assert.equal(rAlive.resolution, "archived-alive", `归档但仍活 ⇒ archived-alive（实得 ${rAlive.resolution}）`);
	assert.equal(rAlive.deliverable, true, "**归档但仍活 ⇒ 可投递**（不得静默丢消息）");
	assert.ok(rAlive.reason.includes("alive"), "理由可诊断");

	const rDead = resolveTabLedger(runsDir2, dead);
	assert.equal(rDead.resolution, "archived-dead", `归档且已终态 ⇒ archived-dead（实得 ${rDead.resolution}）`);
	assert.equal(rDead.deliverable, false, "已终态 ⇒ 不得复活/重复投递");

	// ⑤ 无账本但活着 vs 彻底未知（错误必须可诊断）
	const ghost = "tab_ghost_alive";
	state(ghost, "attached", false);
	const rGhost = resolveTabLedger(runsDir2, ghost);
	assert.equal(rGhost.resolution, "no-ledger-alive", "无账本但活 ⇒ 明确诊断（非笼统 unknown）");
	assert.equal(rGhost.deliverable, true);
	const rNone = resolveTabLedger(runsDir2, "tab_totally_unknown");
	assert.equal(rNone.resolution, "no-ledger-dead", "彻底未知 ⇒ no-ledger-dead（理由明确）");
	assert.equal(rNone.deliverable, false);
	assert.ok(!/^unknown tab/.test(rNone.reason), "理由不得是笼统 'unknown tab'");

	// ⑥ active 行为不变（零回归）
	const act = "tab_active_ok";
	dispatch(act);
	state(act, "working", false);
	const rAct = resolveTabLedger(runsDir2, act);
	assert.equal(rAct.resolution, "active", "活跃账本 ⇒ active（原路径）");
	assert.equal(rAct.deliverable, true);

	rmSync(runsDir2, { recursive: true, force: true });
	console.log("ok - 归档回退：waiting 不归档 / 终态可归档 / archived-alive 可投递 / archived-dead 不复活 / 错误可诊断");
}


// ── mode 枚举与 LaunchMode 单一事实源一致性（2026-10-30 事故回归）──────────────
// 事故：新增 solo 模式时只改了 launch.ts，validateTabDispatchRecord 里的硬编码
// 数组 ["workflow","research","execute","adaptive","trace"] 不认 solo ⇒
// readTabDispatch 返回 null ⇒ tab-finish 拿不到 taskId 报「taskId required」，
// 监管/steer/tab-status 全部失去账本。这是双写漂移，不是单点笔误。
{
	const base = {
		id: "tab_test_mode",
		version: 1,
		taskId: "M4",
		mode: "solo",
		title: "t",
		cwd: "C:/x",
		dispatchedAt: new Date().toISOString(),
		dispatchStatus: "dispatched",
	};
	// 1. 每种 LaunchMode 都必须通过（含 solo）——直接遍历单一事实源，未来新增模式自动覆盖
	for (const m of LAUNCH_MODES) {
		const r = validateTabDispatchRecord({ ...base, mode: m });
		assert.equal(r.ok, true, `mode="${m}"（LaunchMode 成员）必须被账本校验接受；errors=${r.errors.join(",")}`);
	}
	// 2. trace（TabMode 独有，不进 launch.ts 前缀体系）必须继续接受
	assert.equal(validateTabDispatchRecord({ ...base, mode: "trace" }).ok, true, "trace 模式必须继续被接受");
	// 3. 负控：非法 mode 必须被拒（防止把校验写成永真）
	const bad = validateTabDispatchRecord({ ...base, mode: "not-a-mode" });
	assert.equal(bad.ok, false, "非法 mode 必须被拒");
	assert.ok(
		bad.errors.some((e) => e.startsWith("mode must be")),
		`拒绝理由必须具名 mode must be…，实际：${bad.errors.join(",")}`,
	);
	// 4. 单一事实源断言：错误信息里列出的枚举必须与 LAUNCH_MODES 完全一致
	//    （防止再有人改成硬编码数组却不加新成员）
	const listed = bad.errors.find((e) => e.startsWith("mode must be"))!.replace("mode must be ", "").replace("|trace", "").split("|");
	assert.deepEqual(listed.sort(), [...LAUNCH_MODES].sort(), "拒绝理由列出的枚举必须等于 LAUNCH_MODES");
	console.log("ok - mode 枚举与 LaunchMode 单一事实源一致（5 模式 + trace 全通过 / 非法被拒 / 错误信息同步）");
}

console.log("tab-runs tests passed");
