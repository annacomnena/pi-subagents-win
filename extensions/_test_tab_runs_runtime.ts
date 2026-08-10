import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyForReclaim, registerTabStatusTools, registerTabTelemetry, viewToBrief } from "./tab-runs-runtime.ts";

// P0-1：隔离进程环境，让被测代码的 guard（PI_SUBAGENT/PI_TAB_RUN_ID）行为可预期、可在任何运行器（含子 agent）通过
delete process.env.PI_SUBAGENT;
delete process.env.PI_TAB_RUN_ID;
delete process.env.PI_TAB_RUNS_DIR;
import {
	buildTabStatusView,
	readTabResultFile,
	readTabState,
	tabResultPath,
	writeJsonAtomic,
	writeTabDispatch,
	type TabDispatchRecord,
} from "./tab-runs.ts";

// ── fake pi：捕获 registerTool 与 pi.on ───────────────────────────
function makeFakePi() {
	const tools: Array<{ name: string; execute: (callId: string, params: unknown) => Promise<unknown> }> = [];
	const handlers: Record<string, Array<(event: unknown, ctx: unknown) => unknown>> = {};
	return {
		tools,
		handlers,
		registerTool(tool: { name: string; execute: (callId: string, params: unknown) => Promise<unknown> }) {
			tools.push(tool);
		},
		registerCommand() {},
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			handlers[event] = handlers[event] ?? [];
			handlers[event].push(handler);
		},
		async emit(event: string, ev: unknown, ctx: unknown = {}) {
			for (const h of handlers[event] ?? []) await h(ev, ctx);
		},
		findTool(name: string) {
			return tools.find((t) => t.name === name);
		},
	};
}

const runsDir = mkdtempSync(join(tmpdir(), "tab-runtime-test-"));
const TAB = "tab_runtime_1";
const dispatch: TabDispatchRecord = {
	id: TAB, version: 1, taskId: "1007", mode: "workflow", cwd: "G:\\code\\worktrees\\GreenCAD-219",
	dispatchedAt: "2026-08-06T03:45:15.433Z", dispatchStatus: "dispatched",
};
writeTabDispatch(runsDir, dispatch);

// ── 遥测：事件驱动状态机 ─────────────────────────────────────────
{
	const pi = makeFakePi();
	registerTabTelemetry(pi, { tabRunId: TAB, runsDir });

	// 没有身份时不注册任何东西
	const pi2 = makeFakePi();
	registerTabTelemetry(pi2, { runsDir });
	assert.equal(pi2.findTool("tab-finish"), undefined, "无 PI_TAB_RUN_ID 时不注册 tab-finish");
	assert.equal(pi2.findTool("tab-report"), undefined, "无 PI_TAB_RUN_ID 时不注册 tab-report");

	// session_start → attached
	await pi.emit("session_start", { reason: "startup" }, { sessionManager: { getSessionFile: () => "C:/pi/sess/x.jsonl" } });
	const s1 = readTabState(runsDir, TAB);
	assert.equal(s1?.phase, "attached");
	assert.equal(s1?.sessionPath, "C:/pi/sess/x.jsonl");

	// agent_start → working
	await pi.emit("agent_start", {}, {});
	assert.equal(readTabState(runsDir, TAB)?.phase, "working");

	// agent_settled → waiting（权威等待信号）
	await pi.emit("agent_settled", {}, { isIdle: () => true });
	const s2 = readTabState(runsDir, TAB);
	assert.equal(s2?.phase, "waiting");
	assert.equal(s2?.terminal, false, "waiting 不是终态");

	// message_end 捕获 assistant 文本/usage/stopReason
	await pi.emit("message_end", {
		message: {
			id: "m1", role: "assistant", stopReason: "toolUse",
			content: [{ type: "text", text: "开始处理" }],
			usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: { total: 0.01 } },
		},
	}, {});
	await pi.emit("agent_settled", {}, { isIdle: () => true });
	const s3 = readTabState(runsDir, TAB);
	assert.equal(s3?.lastAssistantText, "开始处理");
	assert.equal(s3?.lastStopReason, "toolUse");
	assert.ok(s3?.usage && s3.usage.input === 100);

	// tab-finish：写入 result + 终态
	const finishTool = pi.findTool("tab-finish");
	assert.ok(finishTool, "应注册 tab-finish");
	assert.ok(pi.findTool("tab-report"), "应注册 tab-report（tab → 主会话回报通道）");
	const res = await finishTool.execute("", { status: "completed", summary: "全部完成", artifacts: ["plans/20260806.md"] });
	assert.ok(!(res as { isError?: boolean }).isError, JSON.stringify(res));

	const result = readTabResultFile(runsDir, TAB);
	assert.equal(result?.status, "completed");
	assert.equal(result?.taskId, "1007");
	assert.equal(result?.artifacts?.[0], "plans/20260806.md");
	assert.ok(result?.usage && result.usage.input === 100, "tab-finish 应携带累计 usage");

	const s4 = readTabState(runsDir, TAB);
	assert.equal(s4?.terminal, true, "tab-finish 后 state 应为终态");

	// 重复 tab-finish → 拒绝
	const res2 = await finishTool.execute("", { status: "completed", summary: "again" });
	assert.ok((res2 as { isError?: boolean }).isError, "重复 tab-finish 必须拒绝");

	// session_shutdown 不再覆盖为 orphaned
	await pi.emit("session_shutdown", { reason: "quit" }, {});
	assert.equal(readTabState(runsDir, TAB)?.phase, "completed", "已终态不被 shutdown 覆盖");

	// 伪造 runId 无效：tab-finish 不接受外部 runId 参数（参数被忽略）
	const bad = await finishTool.execute("", { status: "completed", summary: "x", runId: "tab_other" });
	assert.ok((bad as { isError?: boolean }).isError, "重复调用（伪造 runId 参数同样被拒绝）");
}

// ── 回收判组：classifyForReclaim ─────────────────────────────────
{
	const baseView = (over: Partial<ReturnType<typeof buildTabStatusView>>) => {
		const v = buildTabStatusView(runsDir, TAB);
		return { ...v, ...over } as ReturnType<typeof buildTabStatusView>;
	};

	assert.equal(classifyForReclaim(baseView({ phase: "waiting" })), "awaitingInput");
	assert.equal(classifyForReclaim(baseView({ phase: "working" })), "pending");
	const completed = baseView({ phase: "completed", resultMissing: false, terminal: true });
	assert.equal(classifyForReclaim(completed), "ready");
	const unconfirmed = baseView({ phase: "completed", resultMissing: true, terminal: true });
	assert.equal(classifyForReclaim(unconfirmed), "pending", "result 缺失的终态不当 ready");
	assert.equal(classifyForReclaim(baseView({ phase: "orphaned" })), "orphaned");
	assert.equal(classifyForReclaim(baseView({ phase: "unconfirmed" })), "failed");
	assert.equal(classifyForReclaim(baseView({ dispatch: { ...dispatch, dispatchStatus: "launch_failed" } })), "failed");
}

// ── tab-status / reclaim-tabs 工具注册与执行 ─────────────────────
{
	const pi = makeFakePi();
	registerTabStatusTools(pi, { runsDir });

	const statusTool = pi.findTool("tab-status");
	assert.ok(statusTool, "应注册 tab-status");
	const stRes = await statusTool.execute("", {}) as { details?: { records?: Array<Record<string, unknown>> } };
	assert.ok(stRes.details?.records && stRes.details.records.length >= 1);
	const rec = stRes.details.records[0];
	assert.equal(rec?.runId, TAB);
	assert.equal(rec?.phase, "completed");
	assert.equal(rec?.resultMissing, false);
	assert.equal(rec?.terminal, true);

	const brief = viewToBrief(buildTabStatusView(runsDir, TAB));
	assert.equal(brief.runId, TAB);
	assert.ok(brief.result && typeof brief.result === "object");

	const reclaimTool = pi.findTool("reclaim-tabs");
	assert.ok(reclaimTool, "应注册 reclaim-tabs");
	const rcRes = await reclaimTool.execute("", { runIds: [TAB], wait: false }) as {
		details?: { ready?: unknown[]; timedOut?: boolean };
		isError?: boolean;
	};
	assert.ok(rcRes.details && (rcRes.details.ready?.length ?? 0) >= 1, "已完成 tab 应进 ready");
	assert.equal(rcRes.isError, false);

	const rcWait = await reclaimTool.execute("", { runIds: [TAB], wait: true, timeoutMs: 2000, intervalMs: 100 }) as {
		details?: { ready?: unknown[]; timedOut?: boolean };
	};
	assert.ok(rcWait.details && (rcWait.details.ready?.length ?? 0) >= 1);
	assert.equal(rcWait.details.timedOut, false);
}

// ── reclaim wait 超时路径（未终态 tab 不应伪造完成）──────────────
{
	const pi = makeFakePi();
	const runsDir2 = mkdtempSync(join(tmpdir(), "tab-runtime-test2-"));
	const TAB2 = "tab_runtime_2";
	writeTabDispatch(runsDir2, { ...dispatch, id: TAB2, dispatchedAt: "2026-08-06T03:00:00.000Z" });
	registerTabStatusTools(pi, { runsDir: runsDir2 });

	const reclaimTool = pi.findTool("reclaim-tabs");
	assert.ok(reclaimTool);
	const rc = await reclaimTool.execute("", { runIds: [TAB2], wait: false }) as {
		details?: { pending?: unknown[]; ready?: unknown[]; orphaned?: unknown[] };
	};
	// P1-1：派发已超过 grace 且无 state/result/session → orphaned（不再永久卡 dispatched）
	assert.ok(rc.details, "应有 details");
	assert.ok(rc.details.orphaned && rc.details.orphaned.length >= 1, "过期未附着 tab 应进 orphaned");
	assert.equal(rc.details.ready?.length, 0, "不得伪造 ready");

	// 新派发（当前时刻）无 state → dispatched（pending 组，grace 内）
	const runsDir3 = mkdtempSync(join(tmpdir(), "tab-runtime-test3-"));
	const TAB3 = "tab_runtime_3";
	writeTabDispatch(runsDir3, { ...dispatch, id: TAB3, dispatchedAt: new Date().toISOString() });
	const pi3 = makeFakePi();
	registerTabStatusTools(pi3, { runsDir: runsDir3 });
	const reclaim3 = pi3.findTool("reclaim-tabs");
	const rc3 = await reclaim3?.execute("", { runIds: [TAB3], wait: false }) as { details?: { pending?: unknown[] } };
	assert.ok(rc3?.details?.pending && rc3.details.pending.length >= 1, "grace 内未附着 tab 应进 pending(dispatched)");
	rmSync(runsDir3, { recursive: true, force: true });
	rmSync(runsDir2, { recursive: true, force: true });
}

rmSync(runsDir, { recursive: true, force: true });

console.log("tab-runs-runtime tests passed");
