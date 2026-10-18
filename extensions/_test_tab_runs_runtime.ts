import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
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

	// 没有身份时工具仍注册（惰性判身份），但 execute 应拒绝
	const pi2 = makeFakePi();
	registerTabTelemetry(pi2, { runsDir });
	const finishNoId = pi2.findTool("tab-finish");
	const reportNoId = pi2.findTool("tab-report");
	assert.ok(finishNoId, "tab-finish 总是注册（执行时惰性判身份）");
	assert.ok(reportNoId, "tab-report 总是注册（执行时惰性判身份）");
	const noIdRes = await finishNoId.execute("", { status: "completed", summary: "x" });
	assert.ok((noIdRes as { isError?: boolean }).isError, "无 tab 身份时 tab-finish 必须拒绝");

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

	// ── tab-report 显式截断（2026-10-16：“**静默截断 = 静默丢失**”）───────────────
	// 旧行为 `message.slice(0,1000)`：正文被截断、无标记、仍报 ✓ ⇒ 主会话与发送方都不知。
	{
		const home = mkdtempSync(join(tmpdir(), "tab-report-home-"));
		const prevU = process.env.USERPROFILE;
		const prevH = process.env.HOME;
		process.env.USERPROFILE = home;
		process.env.HOME = home;
		try {
			const tool = pi.findTool("tab-report")!;
			const TAIL = "TAIL_MUST_BE_IN_FULL_TEXT";
			const long = "A".repeat(1500) + TAIL;
			const res = await tool.execute("", { message: long, taskId: "T-trunc" });
			const text = ((res as { content?: Array<{ text?: string }> }).content ?? []).map((c) => c.text ?? "").join("\n");
			// ① 工具返回值必须**警告**（不得再像旧行为那样只报 ✓）
			assert.ok(/正文被截断/.test(text), `返回值必须警告已截断（实得 ${text.slice(0, 160)}）`);
			assert.ok(!/^✓ 已向主会话回报/.test(text.trim()), "截断时不得只报成功");
			const m = /全文已落盘: (\S+)/.exec(text);
			assert.ok(m, "返回值必须给出全文路径");
			assert.ok(existsSync(m![1]!), `全文必须已落盘（${m![1]}）`);
			assert.ok(readFileSync(m![1]!, "utf8").includes(TAIL), "落盘必须是**全文**（含尾部），不是被切过的副本");
			// ② 隔离核验：报告落在临时 home 下（不污染真实 ~/.pi/agent/reports）
			const reportsDir = join(home, ".pi", "agent", "reports");
			const jsons = readdirSync(reportsDir).filter((f) => f.endsWith(".json"));
			assert.ok(jsons.length >= 1, "报告已写入临时 reports 目录（隔离生效）");
			const rec = JSON.parse(readFileSync(join(reportsDir, jsons[0]!), "utf8")) as { message: string };
			assert.ok(rec.message.length <= 1000, `投递正文必须 ≤1000（实得 ${rec.message.length}）`);
			// ③ **核心不变量**：投递正文自带显式截断标记 + 路径（“静默截断 = 静默丢失”）
			assert.ok(/\[TRUNCATED: \d+ chars omitted — 内容在 .+\]$/.test(rec.message.trimEnd()), `投递正文必须以截断标记结尾（实得尾部：${rec.message.slice(-120)}）`);
		} finally {
			if (prevU === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevU;
			if (prevH === undefined) delete process.env.HOME; else process.env.HOME = prevH;
			rmSync(home, { recursive: true, force: true });
		}
	}
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
	// 2026-10-18（GLM D-2）：unconfirmed 不再是 failed（否则诱导主会话「失败⇒另派」⇒ 与可能复活的原 tab 双写竞争）
	assert.equal(classifyForReclaim(baseView({ phase: "unconfirmed" })), "unconfirmed", "unconfirmed 必须单独一类（需人工核实，不得直接另派）");
	assert.equal(classifyForReclaim(baseView({ dispatch: { ...dispatch, dispatchStatus: "launch_failed" } })), "failed", "launch_failed 仍归 failed（拆桶未拆到它）");
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
	const rcRes = await reclaimTool.execute("", { runIds: [TAB] }) as {
		details?: { ready?: unknown[]; pending?: unknown[] };
	};
	// 2026-08-13：reclaim-tabs 永不阻塞（wait/timeoutMs 为废弃 no-op），单次快照立即返回
	assert.ok(rcRes.details && (rcRes.details.ready?.length ?? 0) >= 1, "已完成 tab 应进 ready");

	const rcWait = await reclaimTool.execute("", { runIds: [TAB], wait: true, timeoutMs: 2000, intervalMs: 100 }) as {
		details?: { ready?: unknown[]; pending?: unknown[] };
	};
	assert.ok(rcWait.details && (rcWait.details.ready?.length ?? 0) >= 1, "wait 为 no-op：仍立即返回快照");
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

// ── runsDir 空串回退（|| 链，2026-09-18 与 timers-runtime 同类空串坑一并修）────────
{
	const envDir = mkdtempSync(join(tmpdir(), "tab-runtime-emptystr-"));
	const TAB4 = "tab_runtime_empty";
	process.env.PI_TAB_RUNS_DIR = envDir; // 顶部已 delete，块尾恢复
	try {
		const pi = makeFakePi();
		registerTabTelemetry(pi, { tabRunId: TAB4, runsDir: "" }); // 空串不得短路链路（?? 链会写到 cwd 相对路径）
		await pi.emit("session_start", { reason: "startup" }, { sessionManager: { getSessionFile: () => "C:/pi/sess/y.jsonl" } });
		const s = readTabState(envDir, TAB4);
		assert.ok(s, "runsDir 空串应回退 env 目录写 state（而非 cwd/空串路径）");
		assert.equal(s?.phase, "attached");
	} finally {
		delete process.env.PI_TAB_RUNS_DIR;
		rmSync(envDir, { recursive: true, force: true });
	}
}

// ── reclaim-tabs 文案：unconfirmed 独立分组（2026-10-18 GLM D-2）────
// 经真实入口：registerTabStatusTools(fake pi) + 工具 execute（不直调分类函数）
{
	const runsDirU = mkdtempSync(join(tmpdir(), "tab-runtime-unconf-"));
	const TABU = "tab_runtime_unconf";
	const TABLF = "tab_runtime_launchfailed";
	writeTabDispatch(runsDirU, { ...dispatch, id: TABU, taskId: "SBS-B1", dispatchedAt: new Date().toISOString() });
	// 兜底形状的真 result 文件（与 writeSettlementFallback 同字段口径：unconfirmed + autoGenerated）
	writeJsonAtomic(tabResultPath(runsDirU, TABU), {
		id: TABU, taskId: "SBS-B1", status: "unconfirmed", autoGenerated: true,
		finishedAt: new Date().toISOString(),
		summary: "tab 回合结束但未调用 tab-finish（可能忘记回报）；主会话应主动 reclaim 并核实实际进度",
		artifacts: [], openIssues: ["未调用 tab-finish，成果未经结构化声明"],
	});
	writeTabDispatch(runsDirU, { ...dispatch, id: TABLF, taskId: "LF-1", dispatchedAt: new Date().toISOString(), dispatchStatus: "launch_failed" });

	const piU = makeFakePi();
	registerTabStatusTools(piU, { runsDir: runsDirU });
	const reclaimU = piU.findTool("reclaim-tabs");
	assert.ok(reclaimU, "应注册 reclaim-tabs");
	const resU = await reclaimU.execute("", { runIds: [TABU, TABLF] }) as {
		content?: Array<{ text?: string }>;
		details?: { unconfirmed?: Array<Record<string, unknown>>; failed?: Array<Record<string, unknown>>; ready?: unknown[] };
	};
	const textU = resU.content?.[0]?.text ?? "";

	assert.ok(resU.details?.unconfirmed && resU.details.unconfirmed.length === 1, `unconfirmed 分组必须恰好 1 条：${JSON.stringify(resU.details)}`);
	assert.equal(resU.details.unconfirmed[0]?.runId, TABU, "unconfirmed tab 必须落在 details.unconfirmed");
	assert.equal((resU.details.failed ?? []).some((r) => r.runId === TABU), false, "unconfirmed tab 不得同时出现在 details.failed");
	assert.equal(resU.details.failed?.length, 1, "launch_failed 仍归 failed");
	assert.ok(textU.includes(`unconfirmed=`), `summary 必须含 unconfirmed=N：${textU.split("\n")[0]}`);
	assert.ok(textU.includes("核实"), `unconfirmed 文案必须要求核实：${textU}`);
	// 硬约束：reclaim 文案不得含「重派/rerun/re-run/重启/retry」（那等于建议另起新 tab ⇒ 双写竞争）
	assert.equal(/重派|rerun|re-run|重启|retry/i.test(textU), false, `reclaim-tabs 文案不得含重派类字样：${textU}`);

	rmSync(runsDirU, { recursive: true, force: true });
}

rmSync(runsDir, { recursive: true, force: true });

console.log("tab-runs-runtime tests passed");
