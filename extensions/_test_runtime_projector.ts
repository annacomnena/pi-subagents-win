/**
 * _test_runtime_projector.ts — Phase 2 测试（设计稿 §16.5 补充 / §20-23 / 附记 A2 §75.3-75.4）
 *
 * 覆盖：
 *   - 状态机：dispatched 创建 → terminal 终态；launch_failed=failed；终态优先不回退
 *   - dedupeKey 幂等（同键只应用一次）
 *   - 孤立终态 → pending 桶；dispatched 到达后补放（rollover 乱序场景）
 *   - trace-lane 显式排除（孤立 terminal 永远 pending，不进 runs）
 *   - §22 replay 等价：删 state 重放等价 + 乱序注入最终一致 + rebuild 幂等
 *   - state-store：落盘/读取/原子写/tolerant 读
 *
 * 运行：npm run test:runtime-projector
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 隔离：默认 journal/claims/state 路径绝不触碰真实 ~/.pi/agent/runtime/
process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "runtime-projector-env-"));

import { newEventEnvelope } from "./runtime/envelope.ts";
import {
	applyEvent,
	emptyProjectionState,
	rebuildFromEnvelopes,
	type ProjectedRun,
} from "./runtime/projector.ts";
import {
	diffProjectionStates,
	listProjectedRuns,
	projectJournalToState,
	readProjectedRun,
	replayEquivalenceDiff,
} from "./runtime/state-store.ts";
import { masterAddress, tabRunAddress } from "./runtime/address.ts";

const master = masterAddress();

/** 构造 dispatch 事件（dedupeKey/at 领域时间与真实 adapter 同形）。 */
function dispatch(tab: string, at: string, extra: Partial<Parameters<typeof newEventEnvelope>[0]> = {}) {
	return newEventEnvelope({
		type: "run.dispatched",
		source: master,
		subject: tabRunAddress(tab),
		at,
		dedupeKey: `run.dispatched:${tabRunAddress(tab)}`,
		payload: {
			tabRunId: tab,
			executionKind: "tab",
			externalTaskId: "9001",
			mode: "workflow",
			cwd: "C:/x",
			dispatchedAt: at,
		},
		...extra,
	});
}

function terminal(tab: string, status: "completed" | "failed" | "cancelled", at: string, extra: Partial<Parameters<typeof newEventEnvelope>[0]> = {}) {
	const type = `run.${status}`;
	return newEventEnvelope({
		type,
		source: master,
		subject: tabRunAddress(tab),
		at,
		dedupeKey: `${type}:${tabRunAddress(tab)}`,
		payload: { tabRunId: tab, executionKind: "tab", status, summary: `s-${tab}`, finishedAt: at },
		...extra,
	});
}

try {
	// ── 1. 基本状态机：dispatched → completed ──────────────────────
	{
		const st = emptyProjectionState();
		assert.equal(applyEvent(st, dispatch("tab_a", "2026-09-17T01:00:00Z")), true);
		assert.equal(applyEvent(st, terminal("tab_a", "completed", "2026-09-17T01:05:00Z")), true);

		const run = st.runs.get(tabRunAddress("tab_a"))!;
		assert.equal(run.status, "completed");
		assert.equal(run.dispatchedAt, "2026-09-17T01:00:00Z", "dispatchedAt = 领域时间");
		assert.equal(run.finishedAt, "2026-09-17T01:05:00Z");
		assert.equal(run.actualModel, "unknown", "actualModel 未采集恒 unknown（75.1.5）");
		assert.equal(run.executionKind, "tab");
		assert.equal(st.pending.size, 0);
	}

	// ── 2. launch_failed = failed 终态 ─────────────────────────────
	{
		const st = emptyProjectionState();
		applyEvent(st, dispatch("tab_b", "2026-09-17T02:00:00Z"));
		applyEvent(st, newEventEnvelope({
			type: "run.launch_failed",
			source: master,
			subject: tabRunAddress("tab_b"),
			at: "2026-09-17T02:00:10Z",
			dedupeKey: "run.launch_failed:run://tab/tab_b",
			payload: { tabRunId: "tab_b", executionKind: "tab", error: "spawn boom", dispatchedAt: "2026-09-17T02:00:00Z" },
		}));
		assert.equal(st.runs.get(tabRunAddress("tab_b"))!.status, "failed");
	}

	// ── 3. 终态优先：已终态 Run 不被重复/迟到 dispatched 回退 ─────
	{
		const st = emptyProjectionState();
		applyEvent(st, dispatch("tab_c", "2026-09-17T03:00:00Z"));
		applyEvent(st, terminal("tab_c", "completed", "2026-09-17T03:05:00Z"));
		// 迟到/重复的 dispatched（如 rollover 后重放）：不得回退终态，也不得篡改已有事实
		applyEvent(st, dispatch("tab_c", "2026-09-17T03:00:00Z"));
		assert.equal(st.runs.get(tabRunAddress("tab_c"))!.status, "completed", "终态优先");
		assert.equal(st.runs.get(tabRunAddress("tab_c"))!.dispatchedAt, "2026-09-17T03:00:00Z", "事实保持");
	}

	// ── 4. dedupeKey 幂等：同键只应用一次 ──────────────────────────
	{
		const st = emptyProjectionState();
		const env = terminal("tab_d", "failed", "2026-09-17T04:00:00Z");
		applyEvent(st, dispatch("tab_d", "2026-09-17T03:59:00Z"));
		assert.equal(applyEvent(st, env), true);
		assert.equal(applyEvent(st, { ...env, id: "evt_duplicate" }), false, "同 dedupeKey 拒绝");
		assert.equal(st.runs.get(tabRunAddress("tab_d"))!.status, "failed");
	}

	// ── 5. 孤立终态 → pending；dispatched 到达补放（rollover 场景）─
	{
		const st = emptyProjectionState();
		applyEvent(st, terminal("tab_e", "completed", "2026-09-17T05:10:00Z"));
		assert.equal(st.runs.size, 0);
		assert.equal(st.pending.size, 1);
		assert.equal([...st.pending.values()][0].reason, "unpaired");

		// dispatched 迟到 → 立即补放 pending 里的终态
		applyEvent(st, dispatch("tab_e", "2026-09-17T05:00:00Z"));
		const run = st.runs.get(tabRunAddress("tab_e"))!;
		assert.equal(run.status, "completed", "补放终态");
		assert.equal(run.dispatchedAt, "2026-09-17T05:00:00Z");
		assert.equal(st.pending.size, 0, "配对后清空");
	}

	// ── 6. trace-lane 显式排除：无 dispatched 的孤立终态不进 runs ──
	{
		const st = emptyProjectionState();
		// trace lane 终态（现状：payload.executionKind 误标 tab，75.3 存量账）
		applyEvent(st, newEventEnvelope({
			type: "run.completed",
			source: master,
			subject: tabRunAddress("tab_trace_lane_1"),
			at: "2026-09-17T06:00:00Z",
			dedupeKey: "run.completed:run://tab/tab_trace_lane_1",
			payload: { tabRunId: "tab_trace_lane_1", executionKind: "tab", status: "completed", summary: "trace lane 终态" },
		}));
		assert.equal(st.runs.size, 0, "孤立终态不投影（75.3 排除规则）");
		assert.equal(st.pending.size, 1);
	}

	// ── 7. replay 等价（§22 核心）：同输入两次 rebuild 深度一致 ────
	{
		const events = [
			terminal("tab_f", "completed", "2026-09-17T07:10:00Z"), // 乱序在前
			dispatch("tab_f", "2026-09-17T07:00:00Z"),
			dispatch("tab_g", "2026-09-17T07:01:00Z"),
			terminal("tab_g", "failed", "2026-09-17T07:09:00Z"),
			terminal("tab_g", "failed", "2026-09-17T07:09:00Z"), // 重复 dedupeKey
			{ ...terminal("tab_g", "completed", "2026-09-17T07:12:00Z"), id: "evt_alt", dedupeKey: "run.completed:run://tab/tab_g" },
		];
		const r1 = rebuildFromEnvelopes(events);
		const r2 = rebuildFromEnvelopes(events);
		assert.deepEqual(diffProjectionStates(r1.state, r2.state), [], "同输入 rebuild 必须等价");
		assert.equal(r1.state.runs.get(tabRunAddress("tab_g"))!.status, "failed", "terminal 优先：首个终态获胜，后续（含换 status 的重放）不覆盖");
		assert.equal(r1.skipped >= 2, true, "重复 dedupeKey 计入 skipped");
	}

	// ── 8. state-store：journal → 落盘 → 读回 → 删 state 重放等价 ──
	{
		const envDir = process.env.PI_RUNTIME_DIR!;
		const journalPath = join(envDir, "events.jsonl");
		const lines = [
			dispatch("tab_h", "2026-09-17T08:00:00Z"),
			terminal("tab_h", "completed", "2026-09-17T08:03:00Z"),
			dispatch("tab_i", "2026-09-17T08:01:00Z"), // 仍在跑（无终态）
		];
		writeFileSync(journalPath, lines.map((e) => `${JSON.stringify(e)}\n`).join(""), "utf8");

		const summary1 = projectJournalToState({ journalPath });
		assert.equal(summary1.runs, 2);
		assert.equal(summary1.pending, 0);

		const h1 = readProjectedRun(tabRunAddress("tab_h"))!;
		assert.equal(h1.status, "completed");
		assert.equal(readProjectedRun(tabRunAddress("tab_missing")), null);
		assert.equal(listProjectedRuns().length, 2);

		// §22 验收核心：删 state/，仅凭 events.jsonl 重放 → 等价
		rmSync(join(envDir, "state"), { recursive: true, force: true });
		assert.equal(existsSync(join(envDir, "state")), false);
		const summary2 = projectJournalToState({ journalPath });
		assert.equal(summary2.runs, 2);
		assert.deepEqual(replayEquivalenceDiff(journalPath), [], "replay 等价（§22）");

		// 再删再放，diff 仍空（rebuild 幂等）
		rmSync(join(envDir, "state"), { recursive: true, force: true });
		projectJournalToState({ journalPath });
		assert.deepEqual(replayEquivalenceDiff(journalPath), []);
	}

	// ── 9. 落盘 tolerant 读：坏 state 文件视同 miss ────────────────
	{
		const envDir = process.env.PI_RUNTIME_DIR!;
		const badDir = join(envDir, "state", "runs");
		writeFileSync(join(badDir, stateName("tab_bad")), "{ broken", "utf8");
		assert.equal(readProjectedRun(tabRunAddress("tab_bad")), null, "半截 state 文件不炸读者");
	}
} finally {
	rmSync(process.env.PI_RUNTIME_DIR!, { recursive: true, force: true });
}

/** 测试辅助：subject → state 文件名（与 state-store 同规则）。 */
function stateName(subject: string): string {
	return `${subject.replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
}

// ProjectedRun 类型 smoke（编译期形状 + 运行时字段）
{
	const probe: ProjectedRun = {
		subject: "run://tab/x",
		status: "dispatched",
		actualModel: "unknown",
		updatedAt: new Date().toISOString(),
	};
	assert.equal(probe.status, "dispatched");
}

console.log("_test_runtime_projector: all assertions passed");
