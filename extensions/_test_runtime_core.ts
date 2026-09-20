/**
 * _test_runtime_core.ts — Phase 1A/1B/1C 测试（设计稿 §16.1 / §16.2 / §44 Step 1）
 *
 * 覆盖：
 *   - ids：生成非空、前缀正确、连续生成不冲突、非法 envelope 前缀拒绝
 *   - address：六种构造全部 valid、round-trip parse、非法地址拒绝
 *   - objects：状态词表冻结（防漂移）、最小 record 构造 smoke
 *
 * 运行：npm run test:runtime-core
 */

import assert from "node:assert/strict";
import {
	DEFAULT_MASTER_ID,
	asMasterId,
	asRunId,
	asTaskId,
	asWorkstreamId,
	newEnvelopeId,
	newRunId,
	newTaskId,
	newWorkstreamId,
} from "./runtime/ids.ts";
import {
	EXECUTION_KINDS,
	RUNTIME_RUN_STATUSES,
	RUNTIME_TASK_STATUSES,
	WORKSTREAM_STATUSES,
	type RunRecord,
} from "./runtime/objects.ts";
import {
	isObjectAddress,
	masterAddress,
	parseObjectAddress,
	subagentRunAddress,
	tabRunAddress,
	taskAddress,
	traceLaneAddress,
	workstreamAddress,
} from "./runtime/address.ts";

// ── 1. ids：生成非空 + 前缀正确（§16.1）───────────────────────────
{
	const ws = newWorkstreamId();
	const task = newTaskId();
	const run = newRunId();
	const evt = newEnvelopeId();

	assert.ok(ws.startsWith("ws_"), `workstream id prefix: ${ws}`);
	assert.ok(task.startsWith("task_"), `task id prefix: ${task}`);
	assert.ok(run.startsWith("run_"), `run id prefix: ${run}`);
	assert.ok(evt.startsWith("evt_"), `envelope id prefix: ${evt}`);

	for (const id of [ws, task, run, evt]) {
		assert.ok(id.length > 0);
		assert.ok(!/\s/.test(id), "id 不得含空白");
	}
	assert.equal(DEFAULT_MASTER_ID, "master_default");

	// 固定时间戳下格式完全可预测（时间戳 base36 + "_" + 6 位随机）
	const fixed = new Date("2026-09-17T00:00:00Z");
	assert.equal(newWorkstreamId(fixed).startsWith(`ws_${fixed.getTime().toString(36)}_`), true);
}

// ── 2. ids：连续生成不冲突（§16.1）────────────────────────────────
{
	const seen = new Set<string>();
	for (let i = 0; i < 500; i++) {
		for (const id of [newWorkstreamId(), newTaskId(), newRunId(), newEnvelopeId()]) {
			assert.ok(!seen.has(id), `ID 冲突: ${id}`);
			seen.add(id);
		}
	}
}

// ── 3. ids：envelope 前缀白名单 ───────────────────────────────────
{
	assert.ok(newEnvelopeId("msg").startsWith("msg_"));
	assert.ok(newEnvelopeId("cmd").startsWith("cmd_"));
	assert.throws(() => newEnvelopeId("xyz" as never), /prefix must be/);
}

// ── 4. address：六种构造全部 valid（§16.2）────────────────────────
{
	const a1 = masterAddress();
	assert.equal(a1, "agent://master_default");
	assert.equal(masterAddress(asMasterId("master_two")), "agent://master_two");

	assert.equal(workstreamAddress(asWorkstreamId("ws_1")), "workstream://ws_1");
	assert.equal(taskAddress(asTaskId("task_1")), "task://task_1");
	assert.equal(tabRunAddress("tab_abc_1234"), "run://tab/tab_abc_1234");
	assert.equal(subagentRunAddress("run_abc_1234"), "run://subagent/run_abc_1234");
	assert.equal(traceLaneAddress("tfl-20260917-101010-abcd", "b"), "run://trace/tfl-20260917-101010-abcd/b");

	for (const a of [a1, "workstream://ws_1", "task://task_1", "run://tab/tab_x", "run://subagent/run_x", "run://trace/tfl-1/a"].map(
		(s) => s,
	)) {
		assert.equal(isObjectAddress(a), true, `应为合法地址: ${a}`);
	}
}

// ── 5. address：round-trip parse（§16.2）──────────────────────────
{
	// agent
	const p1 = parseObjectAddress(masterAddress());
	assert.deepEqual(p1, { scheme: "agent", value: "master_default" });

	// workstream / task
	assert.deepEqual(parseObjectAddress(workstreamAddress(asWorkstreamId("ws_9"))), {
		scheme: "workstream",
		value: "ws_9",
	});
	assert.deepEqual(parseObjectAddress(taskAddress(asTaskId("task_9"))), { scheme: "task", value: "task_9" });

	// run://tab、run://subagent
	assert.deepEqual(parseObjectAddress(tabRunAddress("tab_x_1")), { scheme: "run", kind: "tab", value: "tab_x_1" });
	assert.deepEqual(parseObjectAddress(subagentRunAddress("run_y_2")), {
		scheme: "run",
		kind: "subagent",
		value: "run_y_2",
	});

	// run://trace/<runId>/<lane>
	const p6 = parseObjectAddress(traceLaneAddress("tfl-r-1", "c"));
	assert.deepEqual(p6, { scheme: "run", kind: "trace", fusionRunId: "tfl-r-1", lane: "c" });

	// parse → 重建 → 字符串相等
	const rebuilt = `run://trace/${(p6 as { fusionRunId: string }).fusionRunId}/${(p6 as { lane: string }).lane}`;
	assert.equal(rebuilt, traceLaneAddress("tfl-r-1", "c"));
}

// ── 6. address：非法地址拒绝（§16.2）──────────────────────────────
{
	const bad = [
		"", // 空
		"agent://", // 空 value
		"no-scheme", // 无 scheme
		"://x", // 空 scheme
		"http://example.com", // 未知 scheme
		"agent://a/b", // 单段 scheme 不允许第二段
		"run://tab", // 缺 value
		"run://tab/a/b", // tab 多段
		"run://trace/only-run-id", // trace 缺 lane
		"run://trace/r/a/b", // trace 多段
		"run://unknown/x", // 未知 run kind
		"run://tab/has space", // 空白
		"task://has\ttab", // 控制空白
	];
	for (const s of bad) {
		assert.equal(isObjectAddress(s), false, `应拒绝: ${JSON.stringify(s)}`);
		assert.equal(parseObjectAddress(s), null, `parse 应返回 null: ${JSON.stringify(s)}`);
	}
	assert.equal(parseObjectAddress(123 as never), null);
}

// ── 7. objects：状态词表冻结（防漂移快照）─────────────────────────
{
	assert.deepEqual(WORKSTREAM_STATUSES, ["active", "waiting", "blocked", "paused", "completed", "failed"]);
	assert.deepEqual(RUNTIME_TASK_STATUSES, [
		"pending",
		"running",
		"waiting",
		"blocked",
		"completed",
		"failed",
		"cancelled",
	]);
	assert.deepEqual(EXECUTION_KINDS, ["main", "tab", "subagent", "trace-lane", "fusion", "external-cli"]);
	assert.deepEqual(RUNTIME_RUN_STATUSES, [
		"created",
		"dispatched",
		"running",
		"waiting",
		"completed",
		"failed",
		"cancelled",
		"orphaned",
	]);
}

// ── 8. objects：最小 record 构造 smoke（类型形状）─────────────────
{
	const now = new Date().toISOString();
	const run: RunRecord = {
		version: 1,
		kind: "run",
		id: newRunId(),
		executionKind: "tab",
		physical: { tabRunId: "tab_xyz_1", pid: 4242 },
		profile: "workflow-tab",
		status: "dispatched",
		createdAt: now,
		updatedAt: now,
	};
	assert.equal(run.version, 1);
	assert.equal(run.kind, "run");
	// 物理字段全部可选：逻辑 Run 可以没有物理承载（rollover / 重建场景）
	const bare: RunRecord = {
		version: 1,
		kind: "run",
		id: asRunId("run_bare"),
		executionKind: "main",
		status: "created",
		createdAt: now,
		updatedAt: now,
	};
	assert.equal(bare.physical, undefined);
}

console.log("_test_runtime_core: all assertions passed");
