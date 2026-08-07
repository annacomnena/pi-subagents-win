import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import {
	classifyTabStatus,
	emptyTabUsage,
	listTabResults,
	newTabRunId,
	probeSessionFile,
	readTabResultFile,
	sessionBucketForCwd,
	validateTabResult,
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

console.log("tab-runs tests passed");
