/**
 * _test_runtime_workstream.ts — Phase 5a 测试（附记 A7 F18/F21/F22）
 *
 * 覆盖：
 *   - Workstream CRUD（mission 必填、wakePolicy 无 cooldown 拒绝、状态机白名单）
 *   - Task CRUD（objective 必填、初态 pending）
 *   - setTaskStatus：四手设态通过 + telemetry 三位拒绝（running/waiting/blocked）
 *   - Enrichment：runSubject 精确优先、externalTaskId label 次之 + match 标注、无命中空
 *   - 审计尾迹：每次变更落账（F21，不进 journal）
 *   - ID 命名空间：ws_/task_ 前缀（F22）
 *
 * 运行：npm run test:runtime-workstream
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "runtime-workstream-env-"));
const STATE = join(process.env.PI_RUNTIME_DIR!, "state");

import {
	createTask,
	createWorkstream,
	enrichRunRefs,
	listAudit,
	listTasks,
	listWorkstreams,
	readTask,
	readWorkstream,
	setTaskStatus,
	updateWorkstream,
} from "./runtime/workstreams.ts";

const S = { stateDir: STATE, session: "test" };

try {
	// ── 1. Workstream CRUD ─────────────────────────────────────────
	const ws = createWorkstream({ ...S, mission: "修复虚线线型", successCriteria: "UI 落点正确" });
	assert.ok(ws.id.startsWith("ws_"), "F22 ws_ 前缀");
	assert.equal(ws.status, "active");
	assert.equal(readWorkstream(ws.id, STATE)!.mission, "修复虚线线型");
	const paused = updateWorkstream(ws.id, { ...S, status: "paused" })!;
	assert.equal(paused.status, "paused");
	assert.throws(() => updateWorkstream(ws.id, { ...S, status: "nonsense" as never }), "非法状态拒绝");
	assert.throws(() => createWorkstream({ ...S, mission: "  " }), "空 mission 拒绝");
	assert.throws(
		() => createWorkstream({ ...S, mission: "x", wakePolicy: { enabled: true, cooldownMs: 0 } }),
		"无 cooldown 的 wakePolicy 拒绝（F20）",
	);
	assert.equal(updateWorkstream("ws_missing", { ...S, status: "paused" }), null);

	// ── 2. Task CRUD + 状态纪律 ────────────────────────────────────
	const t = createTask({ ...S, objective: "实现虚线绘制", externalTaskId: "9907", workstreamId: ws.id });
	assert.ok(t.id.startsWith("task_"), "F22 task_ 前缀");
	assert.equal(t.status, "pending");
	for (const s of ["cancelled", "completed", "failed"] as const) {
		assert.equal(setTaskStatus(t.id, s, S)!.status, s, `手设 ${s} 通过`);
	}
	for (const s of ["running", "waiting", "blocked"] as const) {
		assert.throws(() => setTaskStatus(t.id, s, S), `telemetry 位 ${s} 拒绝`);
	}
	assert.equal(setTaskStatus("task_missing", "cancelled", S), null);
	assert.equal(listTasks(ws.id, STATE).length, 1);
	assert.equal(listWorkstreams(STATE).length, 1);

	// ── 3. Enrichment：精确优先 + match 标注 ───────────────────────
	{
		const ws2 = createWorkstream({
			...S,
			mission: "第二流",
			taskSelector: { runSubjects: ["run://tab/tab_exact"], externalTaskIds: ["9907"] },
		});
		const tasks = [{ id: t.id, externalTaskId: t.externalTaskId, workstreamId: t.workstreamId }];
		// 精确命中（即使 label 也命中 ws2，精确优先）
		const exact = enrichRunRefs(
			{ subject: "run://tab/tab_exact", externalTaskId: "9907" },
			tasks,
			[{ id: ws2.id, taskSelector: ws2.taskSelector }],
		);
		assert.equal(exact.workstreamRef, ws2.id);
		assert.equal(exact.match, "runSubject");
		// label 命中 task 记录
		const labeled = enrichRunRefs(
			{ subject: "run://tab/tab_other", externalTaskId: "9907" },
			tasks,
			[{ id: ws2.id, taskSelector: ws2.taskSelector }],
		);
		assert.equal(labeled.taskRef, t.id, "label 匹配到 task");
		assert.equal(labeled.match, "externalTaskId", "label 匹配必须标注 best-effort");
		// 无命中
		assert.deepEqual(enrichRunRefs({ subject: "run://tab/x" }, [], []), {});
		// 无 externalTaskId 的直开 run：无 label 可配
		const direct = enrichRunRefs(
			{ subject: "run://tab/tab_direct", externalTaskId: undefined },
			tasks,
			[{ id: ws2.id, taskSelector: ws2.taskSelector }],
		);
		assert.equal(direct.taskRef, undefined, "无 taskId 的 run 不强配 task");
	}

	// ── 4. 审计尾迹（F21）──────────────────────────────────────────
	{
		const entries = listAudit(STATE);
		const ops = entries.map((e) => e.op);
		assert.ok(ops.includes("workstream.create"), "创建落账");
		assert.ok(ops.includes("workstream.update"), "更新落账");
		assert.ok(ops.includes("task.create"), "task 创建落账");
		assert.ok(ops.includes("task.status"), "状态变更落账");
		assert.ok(entries.every((e) => e.session === "test"), "session 归属");
		assert.ok(entries.every((e) => !isNaN(Date.parse(e.at))), "时间戳合法");
	}
} finally {
	rmSync(process.env.PI_RUNTIME_DIR!, { recursive: true, force: true });
}

console.log("_test_runtime_workstream: all assertions passed");
