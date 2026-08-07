/**
 * _smoke_reclaim_loop.ts — 超长程编排闭环 smoke（派发→定时推进→回收→编排下一批）
 *
 * 用纯函数 + 真实临时目录模拟完整闭环（不依赖 Windows Terminal / 真实 pi 会话）：
 *   1. 派发：launch-tabs 等价物写派发账本 + 向标签页邮箱写 timer
 *   2. 定时推进：pumpDueTimers（标签页调度器等价物）消费邮箱 timer → 注入消息
 *   3. 终态：tab-finish 等价物原子写 result.json
 *   4. 回收：buildTabStatusView + classifyForReclaim → ready（confirmed）
 *
 * 运行：node --experimental-strip-types ./extensions/_smoke_reclaim_loop.ts
 * 期望输出以 "SMOKE PASS" 结尾，退出码 0。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pumpDueTimers } from "./timers-runtime.ts";
import { classifyForReclaim } from "./tab-runs-runtime.ts";

// P0-1：隔离进程环境（PI_SUBAGENT=1 时 registerTabTelemetry 不注册、smoke 会误判）
delete process.env.PI_SUBAGENT;
delete process.env.PI_TAB_RUN_ID;
delete process.env.PI_TAB_RUNS_DIR;
import {
	defaultSessionsRoot,
	tabResultPath,
	writeJsonAtomic,
	writeTabDispatch,
	buildTabStatusView,
	readTabResultFile,
	type TabDispatchRecord,
} from "./tab-runs.ts";
import {
	readTimerFile,
	validateTimerRecord,
	writeTimerAtomic,
} from "./timers.ts";

const log = (msg: string): void => console.log(`  ${msg}`);

async function main(): Promise<void> {
	console.log("SMOKE: 超长程编排闭环（派发 → 定时推进 → 回收）");
	const root = mkdtempSync(join(tmpdir(), "reclaim-loop-smoke-"));
	const runsDir = join(root, "tab-runs");
	const timersDir = join(root, "timers");
	const sessionsRoot = defaultSessionsRoot(); // 探活降级路径（本 smoke 不依赖真实会话）

	const runId = "tab_smoke_1";
	const taskId = "1007";

	// ── 1. 派发：账本 + 邮箱 timer ──
	console.log("\n[1/4] 派发");
	const dispatch: TabDispatchRecord = {
		id: runId, version: 1, taskId, mode: "workflow",
		title: "Smoke-1007-演示", cwd: process.cwd(),
		dispatchedAt: new Date().toISOString(), dispatchStatus: "dispatched",
	};
	writeTabDispatch(runsDir, dispatch);
	log(`账本已写: ${runId}`);

	const timerRaw: Record<string, unknown> = {
		id: "timer_smoke_1",
		version: 1,
		dueAt: new Date(Date.now() - 1000).toISOString(), // 已到期 → 立即推进
		message: "检查批次结果并汇报；完成后进入下一批",
		target: { tabRunId: runId, taskId },
		source: "launch-tabs",
		label: "smoke-advance",
		status: "pending",
		createdAt: new Date().toISOString(),
	};
	const tCheck = validateTimerRecord(timerRaw);
	assert.ok(tCheck.ok && tCheck.value, tCheck.errors.join("; "));
	writeTimerAtomic(timersDir, tCheck.value, { tabRunId: runId });
	log(`邮箱 timer 已写（target=tab:${runId}）`);

	// ── 2. 定时推进：标签页调度器消费自己邮箱 ──
	console.log("\n[2/4] 定时推进");
	const sent: string[] = [];
	const fakePi = {
		sendUserMessage: (content: string, _opts: unknown) => { sent.push(content); },
	};
	const outcomes = pumpDueTimers(fakePi, timersDir, runId);
	assert.equal(outcomes.length, 1, "应触发一条 timer");
	assert.equal(sent.length, 1, "应注入一条用户消息");
	assert.ok(sent[0].includes("检查批次结果并汇报"), `消息内容: ${sent[0]}`);
	assert.equal(readTimerFile(timersDir, "timer_smoke_1", runId)?.status, "fired", "timer 已 claim");
	log(`timer 触发 → 注入消息: ${sent[0].slice(0, 60)}…`);

	// ── 3. 终态：tab-finish 等价物 ──
	console.log("\n[3/4] 终态");
	writeJsonAtomic(tabResultPath(runsDir, runId), {
		id: runId,
		taskId,
		status: "completed",
		finishedAt: new Date().toISOString(),
		summary: "批次完成：3 个交付物就绪",
		artifacts: ["plans/20260806.md", "Wiki/Modules/xxx.md"],
	});
	const result = readTabResultFile(runsDir, runId);
	assert.equal(result?.status, "completed");
	log(`result.json 已写: ${result?.artifacts?.length} 个 artifacts`);

	// ── 4. 回收：视图 + 判组 → ready（confirmed）──
	console.log("\n[4/4] 回收");
	const view = buildTabStatusView(runsDir, runId, sessionsRoot);
	assert.equal(view.phase, "completed");
	assert.equal(view.terminal, true);
	assert.equal(view.resultMissing, false);
	assert.equal(view.source, "result-file");
	const kind = classifyForReclaim(view);
	assert.equal(kind, "ready", `判组应为 ready，得到 ${kind}`);
	assert.equal(view.result?.summary, "批次完成：3 个交付物就绪");
	log(`tab-status: ${view.phase}（terminal）`);
	log(`reclaim-tabs 判组: ${kind}，可据此编排下一批`);

	// 清理
	rmSync(root, { recursive: true, force: true });
	console.log("\nSMOKE PASS: 派发 → 定时推进 → 回收闭环可用 ✅");
}

main().catch((err) => {
	console.error("SMOKE FAIL:", err);
	process.exit(1);
});
