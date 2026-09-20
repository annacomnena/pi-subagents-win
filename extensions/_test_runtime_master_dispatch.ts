/**
 * _test_runtime_master_dispatch.ts — 0918 计划 §6：master-dispatch 门控 + 账本 parity + 失败路径
 *
 * 覆盖（隔离 PI_RUNTIME_DIR / tab-runs / timers / links；fake spawn，不真 spawn）：
 *   A. 门控三测（纯函数 masterDispatchGate）：owner 放行（含 provenance 无关 / 主会话）、
 *      非 owner 拒绝（subagent/unknown/tab-session/not-owner/无 attachment）、stale generation fencing。
 *   B. 账本 parity（launch-tabs 形态 vs master-dispatch 形态，同一段 launchWorkflowTab 代码）：
 *      dispatch 深比（id/dispatchedAt 除外）+ journal source=agent://master_default +
 *      links 格式 + timers 字段（仅 source 文本差异）。
 *   C. 失败路径：同步 launch_failed + 异步 onSpawnError 回账；wt 缺席零账本；拒绝零 spawn；
 *      gate 后 attachment 变化的最终 fencing（TOCTOU）拒绝 + 四账本零写入 + 零 spawn。
 *
 * 运行：npm run test:master-dispatch
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "runtime-master-dispatch-env-"));

import { masterDispatchGate, masterDispatchRejectText, registerMasterTools } from "./master-tools.ts";
import { attachCurrentSession, issueMasterHandoffToken } from "./runtime/master-control.ts";
import { confirmTransferAttach, transferMaster } from "./runtime/master-transfer.ts";
import { readAttachment, type MasterAttachment } from "./runtime/registry.ts";
import { masterAddress } from "./runtime/address.ts";
import { listRuntimeEnvelopes } from "./runtime/journal.ts";
import { launchWorkflowTab, masterDispatchLaunch, type WorkflowSpawnFn } from "./launch-workflow.ts";
import { readTabDispatch, listTabDispatches, defaultTabRunsDir } from "./tab-runs.ts";
import { defaultTimersDir } from "./timers.ts";
import { listLinks } from "./links.ts";

let n = 0;
const ok = (name: string) => { n++; console.log(`ok ${n} - ${name}`); };

// 归一化：深比前删掉「随调用方/时间变化」的字段
function norm<T>(obj: T): Record<string, unknown> {
	const c: Record<string, unknown> = JSON.parse(JSON.stringify(obj));
	for (const k of ["id", "dispatchedAt", "createdAt", "dueAt", "recordedAt", "dedupeKey", "subject", "at"]) delete c[k];
	return c;
}
const strip = (o: Record<string, unknown>, keys: string[]) => {
	for (const k of keys) delete o[k];
	return o;
};

// fake spawn：成功 / 同步失败 / 异步 onSpawnError
const okSpawn: WorkflowSpawnFn = (_wt, _pi, _cwd, title, prompt, model, _skills, runId) => ({ title, prompt, model, runId });
const errSpawn: WorkflowSpawnFn = (_wt, _pi, _cwd, title, prompt, model, _skills, runId) => ({ title, prompt, model, runId, error: "boom" });
let captured: ((e: Error) => void) | undefined;
const asyncSpawn: WorkflowSpawnFn = (_wt, _pi, _cwd, title, prompt, model, _skills, runId, _runs, onSpawnError) => {
	captured = onSpawnError;
	return { title, prompt, model, runId };
};

// ════════════════════════════════════════════════════════════════════
// A. 门控三测（纯函数）
// ════════════════════════════════════════════════════════════════════

const OWNER = "sess_owner_md";

// A1 owner 放行
{
	const a = attachCurrentSession({ sessionId: OWNER });
	assert.equal(a.ok, true);
	const g = masterDispatchGate({
		sessionId: OWNER, isSub: false, isTab: false, isMain: false,
		readAttachment: () => readAttachment(masterAddress()),
	});
	assert.deepEqual(g, { ok: true, via: "owner", attachment: readAttachment(masterAddress()) });
	assert.ok(g.ok && g.via === "owner");
	ok("A1 owner 放行（via=owner）");
}

// A1b 主会话恒可派（ownership 优先后先读一次 attachment；非 owner 则 via=main，
// 结果不变——dogfood 修复 0918：原「main 不读 attachment」微优化与 ownership-priority 冲突，弃用）
{
	let readCalled = false;
	const g = masterDispatchGate({
		sessionId: "main_x", isSub: false, isTab: false, isMain: true,
		readAttachment: () => { readCalled = true; return readAttachment(masterAddress()); },
	});
	assert.deepEqual(g, { ok: true, via: "main", attachment: null });
	assert.equal(readCalled, true, "ownership 优先：main 也先读一次 attachment（若恰为 owner 则走 owner+fencing）");
	ok("A1b 主会话恒可派（via=main；ownership 优先后允许读一次）");
}

// A1c provenance 无关：被 transfer 派生的新 owner 也放行
{
	// OWNER(gen1) 已 attach → transfer → 后继凭 token 接管 gen2 → 新 sid 是 owner
	const t = transferMaster({ sessionId: OWNER, reason: "md-provenance", spawn: () => ({ successorRunId: "run_succ_md" }) });
	assert.equal(t.ok, true);
	const fresh = issueMasterHandoffToken({ sessionId: OWNER, reason: "succession" });
	assert.equal(fresh.ok, true);
	if (!fresh.ok || !("token" in fresh) || !fresh.token) throw new Error("unreachable");
	const NEW = "sess_new_owner_md";
	const a2 = attachCurrentSession({ sessionId: NEW, token: fresh.token });
	assert.equal(a2.ok, true);
	assert.equal(a2.attachment?.generation, 2);
	confirmTransferAttach({ transferId: t.ok ? t.transferId : "", sessionId: NEW });
	assert.equal(readAttachment(masterAddress())?.sessionId, NEW, "新 sid 成为 owner");
	// 新 owner 过门控（provenance 即「被谁 spawn」不参与判定）
	const g = masterDispatchGate({
		sessionId: NEW, isSub: false, isTab: false, isMain: false,
		readAttachment: () => readAttachment(masterAddress()),
	});
	assert.ok(g.ok && g.via === "owner");
	ok("A1c provenance 无关：transfer 派生的新 owner 放行");
}

// A2 非 owner 拒绝
{
	// not-owner（有 attachment）
	let g1 = masterDispatchGate({ sessionId: "nobody", isSub: false, isTab: false, isMain: false, readAttachment: () => readAttachment(masterAddress()) });
	assert.deepEqual(g1, { ok: false, reason: "not-owner" });
	// tab-session（ownership 优先：tab 且非 owner 才拒；dogfood 修复 0918——
	// 原「isTab 优先于 owner 比对」锁死了错误行为，曾把 tab 形态的 owner 误拒）
	const ownerSid = readAttachment(masterAddress())!.sessionId;
	g1 = masterDispatchGate({ sessionId: "tab_nobody", isSub: false, isTab: true, isMain: false, readAttachment: () => readAttachment(masterAddress()) });
	assert.deepEqual(g1, { ok: false, reason: "tab-session" });
	// owner-tab：isTab=true 但 sid 即 owner（succession tab 形态的 Master）→ 放行 via:owner
	g1 = masterDispatchGate({ sessionId: ownerSid, isSub: false, isTab: true, isMain: false, readAttachment: () => readAttachment(masterAddress()) });
	assert.equal(g1.ok, true);
	if (g1.ok) assert.equal(g1.via, "owner");
	// subagent（最高优先）
	g1 = masterDispatchGate({ sessionId: ownerSid, isSub: true, isTab: false, isMain: false, readAttachment: () => readAttachment(masterAddress()) });
	assert.deepEqual(g1, { ok: false, reason: "subagent" });
	// unknown-session
	g1 = masterDispatchGate({ sessionId: "unknown", isSub: false, isTab: false, isMain: false, readAttachment: () => readAttachment(masterAddress()) });
	assert.deepEqual(g1, { ok: false, reason: "unknown-session" });
	// 无 attachment 且非 main → not-owner（纯函数注入 null reader）
	g1 = masterDispatchGate({ sessionId: "x", isSub: false, isTab: false, isMain: false, readAttachment: () => null });
	assert.deepEqual(g1, { ok: false, reason: "not-owner" });
	// not-owner 文案：含 owner 前 12 位 / 「无 owner」
	assert.ok(masterDispatchRejectText({ ok: false, reason: "not-owner" }, readAttachment(masterAddress())).includes(readAttachment(masterAddress())!.sessionId.slice(0, 12)));
	assert.ok(masterDispatchRejectText({ ok: false, reason: "not-owner" }, null).includes("无 owner"));
	ok("A2 非 owner 拒绝（not-owner/tab-session/subagent/unknown/无 attachment + 文案）");
}

// A3 stale generation fencing（双读，注入两快照）
{
	const S = "sess_stale_md";
	const snaps: MasterAttachment[] = [
		{ agentAddress: masterAddress(), sessionId: S, generation: 1, attachedAt: "2026-01-01T00:00:00.000Z", lastHeartbeatAt: "2026-01-01T00:00:00.000Z", attemptId: "a1" },
		{ agentAddress: masterAddress(), sessionId: S, generation: 2, attachedAt: "2026-01-01T00:00:00.000Z", lastHeartbeatAt: "2026-01-01T00:00:00.000Z", attemptId: "a2" },
	];
	let i = 0;
	const g = masterDispatchGate({ sessionId: S, isSub: false, isTab: false, isMain: false, readAttachment: () => snaps[i++] });
	assert.deepEqual(g, { ok: false, reason: "generation-mismatch" });
	assert.ok(masterDispatchRejectText({ ok: false, reason: "generation-mismatch" }, null).includes("stale generation"));
	ok("A3 stale generation fencing（双读 gen 变化 → generation-mismatch）");
}

// ════════════════════════════════════════════════════════════════════
// B. 账本 parity（launch-tabs 形态 vs master-dispatch 形态）
// ════════════════════════════════════════════════════════════════════

{
	const tmpDir = mkdtempSync(join(tmpdir(), "md-parity-"));
	const agentDir = join(tmpDir, "agent");
	const runsDir = defaultTabRunsDir(agentDir);
	const timersDir = defaultTimersDir(agentDir);
	const linksPath = join(tmpDir, "links.jsonl");
	const env = { wtPath: "wt.exe", piCli: "pi-cli.js", runsDir, timersDir, linksPath };

	const base = {
		taskId: "S2",
		title: "S2 阈值重校准",
		prompt: "先 read 仓库根 AGENTS.md，再 read plans/0918_S2_threshold_tab_handoff.md",
		model: undefined,
		cwd: tmpDir,
		mode: "workflow" as const,
		timers: [{ delayMs: 60_000, message: "巡检：S2 进度", label: "S2 巡检" }],
	};

	// A：launch-tabs 形态；B：master-dispatch 形态（仅 timerSource + sessionId 不同）
	const A = launchWorkflowTab({ ...base, sessionId: "launch-tabs-main", timerSource: "launch-tabs" }, env, okSpawn);
	const B = launchWorkflowTab({ ...base, sessionId: "master-owner-x", timerSource: "master-dispatch" }, env, okSpawn);

	assert.match(A.runId!, /^tab_/);
	assert.match(B.runId!, /^tab_/);
	assert.notEqual(A.runId, B.runId);
	assert.ok(!A.error && !B.error);

	// B1 dispatch 深比（id / dispatchedAt 除外）
	const dA = readTabDispatch(runsDir, A.runId!)!;
	const dB = readTabDispatch(runsDir, B.runId!)!;
	assert.ok(dA && dB);
	assert.deepEqual(norm(dA), norm(dB), "dispatch 记录两路逐字段同构（id/dispatchedAt 除外）");
	assert.equal(dA.version, 1);
	assert.equal(dA.taskId, "S2");
	assert.equal(dA.mode, "workflow");
	assert.equal(dA.title, "S2 阈值重校准");
	assert.match(dA.dispatchedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
	assert.equal(dA.dispatchStatus, "dispatched");
	ok("B1 dispatch 深比：两路逐字段同构（id/dispatchedAt 除外）");

	// B2 journal：两条 run.dispatched，source=agent://master_default，payload 深比（tabRunId 除外）
	const envs = listRuntimeEnvelopes().envelopes;
	const eA = envs.find((e) => e.subject === `run://tab/${A.runId}` && e.type === "run.dispatched");
	const eB = envs.find((e) => e.subject === `run://tab/${B.runId}` && e.type === "run.dispatched");
	assert.ok(eA && eB, "两条 run.dispatched 均在 journal");
	assert.equal(eA!.source, "agent://master_default", "A source=agent://master_default（parity 核心）");
	assert.equal(eB!.source, "agent://master_default", "B source=agent://master_default（两路相同）");
	const normEnv = (e: Record<string, unknown>) => {
		const c = norm(e);
		if (c.payload && typeof c.payload === "object") {
			const p = c.payload as Record<string, unknown>;
			delete p.tabRunId; // runId 随调用不同
			delete p.dispatchedAt; // 时间戳
		}
		return c;
	};
	assert.deepEqual(normEnv(eA!), normEnv(eB!), "journal 信封两路同构（id/subject/dedupe/at + payload 内 tabRunId/dispatchedAt 除外）");
	assert.equal(eA!.payload?.tabRunId, A.runId);
	assert.equal(eA!.payload?.executionKind, "tab");
	assert.equal(eA!.payload?.externalTaskId, "S2");
	ok("B2 journal：source=agent://master_default（两路相同）+ payload 同构");

	// B3 links：各一条，kind=tab、targetId=runId、detail 格式；sessionId 随调用方身份
	const links = listLinks(linksPath);
	assert.equal(links.length, 2);
	const lA = links.find((l) => l.targetId === A.runId)!;
	const lB = links.find((l) => l.targetId === B.runId)!;
	assert.equal(lA.kind, "tab");
	assert.equal(lB.kind, "tab");
	assert.match(lA.detail, /^task=.* mode=.* .+$/);
	assert.match(lB.detail, /^task=.* mode=.* .+$/);
	assert.equal(lA.sessionId, "launch-tabs-main");
	assert.equal(lB.sessionId, "master-owner-x");
	assert.equal(lA.detail, lB.detail, "link detail 两路一致（结构同）");
	ok("B3 links：kind=tab + detail 格式一致（sessionId 随调用方身份）");

	// B4 timers：mail/<runId>/ 各 1 文件，字段深比（仅 source 文本差异）
	const readTimer = (runId: string) => {
		const dir = join(timersDir, "mail", runId);
		const files = readdirSync(dir);
		assert.equal(files.length, 1);
		return JSON.parse(readFileSync(join(dir, files[0]), "utf8")) as Record<string, unknown>;
	};
	const tA = strip(readTimer(A.runId!), ["id", "dueAt", "createdAt", "source"]);
	const tB = strip(readTimer(B.runId!), ["id", "dueAt", "createdAt", "source"]);
	// target.tabRunId 随 runId 变化 → 剥离后比
	const normTimer = (t: Record<string, unknown>) => { strip(t.target as Record<string, unknown>, ["tabRunId"]); return t; };
	assert.deepEqual(normTimer(tA), normTimer(tB), "timer 字段两路同构（仅 source 文本除外）");
	const rawA = readTimer(A.runId!);
	const rawB = readTimer(B.runId!);
	assert.equal(rawA.source, "launch-tabs");
	assert.equal(rawB.source, "master-dispatch");
	assert.equal(rawA.message, "巡检：S2 进度");
	assert.equal((rawA.target as { taskId: string }).taskId, "S2");
	ok("B4 timers：字段同构，仅 source 文本差异（launch-tabs / master-dispatch）");

	// ── C. 失败路径 ──

	// C1 同步 launch_failed（spawn 返回 {error}）
	{
		const C = launchWorkflowTab({ ...base, sessionId: "s1", timerSource: "launch-tabs" }, env, errSpawn);
		assert.equal(C.error, "boom");
		assert.ok(C.runId, "同步失败仍回 runId（供 tab-status 查 launch_failed）");
		const dC = readTabDispatch(runsDir, C.runId!)!;
		assert.equal(dC.dispatchStatus, "launch_failed");
		assert.equal(dC.error, "boom");
		const eC = listRuntimeEnvelopes().envelopes.find((e) => e.subject === `run://tab/${C.runId}` && e.type === "run.launch_failed");
		assert.ok(eC, "journal 有 run.launch_failed");
		assert.equal(eC!.source, "agent://master_default");
		ok("C1 同步 launch_failed：回账 + emit run.launch_failed（source=agent://master_default）");
	}

	// C2 异步 onSpawnError（wt 启动后子进程立刻退出）
	{
		captured = undefined;
		const D = launchWorkflowTab({ ...base, sessionId: "s2", timerSource: "master-dispatch" }, env, asyncSpawn);
		assert.ok(!D.error, "异步路径初始 dispatched（未同步失败）");
		assert.equal(readTabDispatch(runsDir, D.runId!)!.dispatchStatus, "dispatched");
		assert.ok(captured, "asyncSpawn 捕获 onSpawnError 回调");
		captured!(new Error("late-boom"));
		const dD = readTabDispatch(runsDir, D.runId!)!;
		assert.equal(dD.dispatchStatus, "launch_failed");
		assert.equal(dD.error, "late-boom");
		const eD = listRuntimeEnvelopes().envelopes.find((e) => e.subject === `run://tab/${D.runId}` && e.type === "run.launch_failed");
		assert.ok(eD, "异步路径 journal 有 run.launch_failed");
		assert.equal(eD!.source, "agent://master_default");
		ok("C2 异步 onSpawnError：回账 launch_failed + emit");
	}

	// C3 wt 缺席零账本（masterDispatchLaunch 前置检查先于 runId 生成）
	{
		const before = listTabDispatches(runsDir).length;
		const envBefore = listRuntimeEnvelopes().envelopes.length;
		const R = masterDispatchLaunch(
			{ taskId: "S9", prompt: "x", mode: "workflow", sessionId: "s3" },
			{ wtPath: null, piCli: "pi-cli.js", env: { wtPath: "wt.exe", piCli: "pi-cli.js", runsDir, timersDir, linksPath }, spawn: okSpawn },
		);
		assert.equal(R.error, "未找到 Windows Terminal (wt.exe)，无法启动标签页");
		assert.equal(R.runId, undefined, "wt 缺席不生成 runId");
		assert.equal(listTabDispatches(runsDir).length, before, "wt 缺席零账本");
		assert.equal(listRuntimeEnvelopes().envelopes.length, envBefore, "wt 缺席无新 journal");
		ok("C3 wt 缺席：返回 error + 零账本（先于 runId 生成）");
	}

	// C5 gate 通过后、落账/spawn 前 attachment 变化 → 最终 fencing 拒绝 + 四账本零写入 + 零 spawn
	//    （0918 审查 §1 TOCTOU：A3 只覆盖 gate 内相邻双读，本测覆盖 gate 返回→masterDispatchLaunch 重读窗口）
	//    反证：删掉 masterDispatchLaunch 的最终重读后，本测的 stale/runId/账本/spawn 断言全部必红
	{
		const OWNER2 = "sess_final_fence_md";
		const snap = (gen: number, sid: string): MasterAttachment => ({
			agentAddress: masterAddress(), sessionId: sid, generation: gen,
			attachedAt: "2026-01-01T00:00:00.000Z", lastHeartbeatAt: "2026-01-01T00:00:00.000Z", attemptId: `f${gen}`,
		});
		const before = listTabDispatches(runsDir).length;
		const envBefore = listRuntimeEnvelopes().envelopes.length;
		const linksBefore = listLinks(linksPath).length;
		const timerCount = () => {
			const runs = readdirSync(runsDir).filter((f) => f.startsWith("tab_"));
			return runs.reduce((acc, r) => {
				const dir = join(timersDir, "mail", r);
				return acc + (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).length : 0);
			}, 0);
		};
		const timersBefore = timerCount();
		let spawnCalls = 0;
		const countingSpawn: WorkflowSpawnFn = (...a) => { spawnCalls++; return okSpawn(...a); };

		const variants: Array<[string, MasterAttachment | null]> = [
			["gen bump g1→g2", snap(2, OWNER2)],
			["owner 换人", snap(1, "sess_other_md")],
			["attachment 消失（detach）", null],
		];
		for (const [label, fresh] of variants) {
			// gate 快照（第二读）= g1/OWNER2，派发前重读 = fresh（已变）
			const R = masterDispatchLaunch(
				{ taskId: "S10", prompt: "x", mode: "workflow", sessionId: OWNER2, owner: snap(1, OWNER2), timers: [{ delayMs: 60_000, message: "m" }] },
				{ wtPath: "wt.exe", piCli: "pi-cli.js", env, spawn: countingSpawn, readAttachment: () => fresh },
			);
			assert.equal(R.stale, true, `${label}: stale 标记`);
			assert.ok(R.error?.includes("stale generation"), `${label}: stale 文案`);
			assert.equal(R.runId, undefined, `${label}: 不生成 runId`);
		}
		assert.equal(spawnCalls, 0, "最终 fencing 拒绝：零 spawn");
		assert.equal(listTabDispatches(runsDir).length, before, "零 tab-runs 账本");
		assert.equal(listRuntimeEnvelopes().envelopes.length, envBefore, "零 journal");
		assert.equal(listLinks(linksPath).length, linksBefore, "零 links");
		assert.equal(timerCount(), timersBefore, "零 timers");
		ok("C5 gate 后 attachment 变化（gen bump/换人/detach）：stale 拒绝 + 四账本零写入 + 零 spawn");

		// C5b 对照：重读结果与 gate 快照一致 → 正常派发（证明 C5 的红绿只由最终重读决定）
		{
			const before2 = listTabDispatches(runsDir).length;
			const R = masterDispatchLaunch(
				{ taskId: "S11", prompt: "x", mode: "workflow", sessionId: OWNER2, owner: snap(1, OWNER2) },
				{ wtPath: "wt.exe", piCli: "pi-cli.js", env, spawn: countingSpawn, readAttachment: () => snap(1, OWNER2) },
			);
			assert.ok(!R.error && !R.stale && R.runId, "同快照 → 放行）");
			assert.equal(listTabDispatches(runsDir).length, before2 + 1, "正常派发写账本");
			assert.equal(spawnCalls, 1, "对照路径 spawn 一次");
		}

		// C6 main 路径（owner=null）不依赖 attachment：重读 reader 不应被调用，照常派发
		{
			let readCalls = 0;
			const R = masterDispatchLaunch(
				{ taskId: "S12", prompt: "x", mode: "workflow", sessionId: "main_x", owner: null },
				{ wtPath: "wt.exe", piCli: "pi-cli.js", env, spawn: countingSpawn, readAttachment: () => { readCalls++; return snap(1, OWNER2); } },
			);
			assert.ok(!R.error && !R.stale && R.runId, "main 路径放行");
			assert.equal(readCalls, 0, "main 路径不读 attachment");
		}
		ok("C5b/C6 对照：同快照放行 + main 路径不依赖 attachment");
	}
}

// C4 拒绝零 spawn（execute 级，tab-session 路径：gate 拒绝在 dispatchTab 之前）
await (async () => {
	let tool: { execute: (id: string, params: unknown, a: unknown, b: unknown, ctx: unknown) => Promise<unknown> } | undefined;
	const fakePi = { registerTool: (t: { name: string }) => { if (t.name === "master-dispatch") tool = t as never; } };
	let calls = 0;
	registerMasterTools(fakePi as never, { dispatchTab: () => { calls++; return { runId: "tab_fake", title: "t" }; } });
	const savedSub = process.env.PI_SUBAGENT;
	const savedTab = process.env.PI_TAB_RUN_ID;
	process.env.PI_SUBAGENT = "0"; // 非子 agent（覆盖宿主环境；确保走到 tab-session 而非 subagent）
	process.env.PI_TAB_RUN_ID = "tab_forbid_dispatch"; // isTab=true / isMain=false → tab-session
	try {
		const res = (await tool!.execute("c4", { taskId: "S7", prompt: "x" }, undefined, undefined, { sessionManager: { sessionId: "main_somewhere" } })) as { isError?: boolean; content: Array<{ text: string }> };
		assert.equal(res.isError, true);
		assert.ok(res.content[0].text.includes("任务 tab 不是 owner"));
	} finally {
		if (savedSub === undefined) delete process.env.PI_SUBAGENT; else process.env.PI_SUBAGENT = savedSub;
		if (savedTab === undefined) delete process.env.PI_TAB_RUN_ID; else process.env.PI_TAB_RUN_ID = savedTab;
	}
	assert.equal(calls, 0, "tab-session 拒绝时 dispatchTab 零调用");
	ok("C4 拒绝零 spawn：tab-session 时 dispatchTab 零调用");
})();

// ════════════════════════════════════════════════════════════════
// D. schema 回归：全部已注册 master 工具的 parameters 递归校验合法 TypeBox，
//    防止任何工具 schema 写坏（如裸字符串 Union）在 provider 序列化层炸加载。
//    断言：①每个节点非空对象且带 type 字段；②anyOf/oneOf/allOf/items 成员逐个合法；
//    ③provider 视角：JSON 序列化后 anyOf/oneOf 数组内不得残留裸字符串/标量。
// ════════════════════════════════════════════════════════════════
{
	const tools: Array<{ name: string; parameters: unknown }> = [];
	registerMasterTools({
		registerTool: (t: { name: string; parameters?: unknown }) => {
			tools.push({ name: t.name, parameters: (t as { parameters?: unknown }).parameters });
		},
	} as never);
	assert.ok(tools.length >= 9, `master 工具应全部注册（实际 ${tools.length}）`);
	const expected = new Set(["master-status", "master-handoff", "master-attach", "master-detach", "master-cutover", "master-transfer", "master-transfer-confirm", "master-pressure", "master-dispatch"]);
	for (const name of expected) assert.ok(tools.some((t) => t.name === name), `缺少注册工具 ${name}`);

	const isTypeBoxNode = (v: unknown): boolean => {
		if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
		const o = v as Record<string, unknown>;
		if (typeof o.type !== "string") return false; // TypeBox 节点必有 type 字段
		for (const key of ["anyOf", "oneOf", "allOf"]) {
			if (!(key in o)) continue;
			const members = o[key];
			if (!Array.isArray(members) || members.length === 0) return false;
			if (!members.every(isTypeBoxNode)) return false;
		}
		if ("items" in o && !isTypeBoxNode(o.items)) return false;
		return true;
	};
	for (const t of tools) {
		assert.ok(isTypeBoxNode(t.parameters), `工具 ${t.name} 的 parameters 不是合法 TypeBox 对象形态`);
		// provider 视角：JSON 序列化往返，anyOf/oneOf 数组内不得残留裸字符串/标量（裸字符串 Union 的特征）
		const json = JSON.parse(JSON.stringify(t.parameters)) as unknown;
		const assertNoBareMembers = (v: unknown, path: string) => {
			if (Array.isArray(v)) { v.forEach((x, i) => assertNoBareMembers(x, `${path}[${i}]`)); return; }
			if (typeof v !== "object" || v === null) return;
			const o = v as Record<string, unknown>;
			for (const key of ["anyOf", "oneOf"]) {
				if (!(key in o)) continue;
				const members = o[key];
				assert.ok(Array.isArray(members), `${t.name} ${path}.${key} 应为数组`);
				for (const m of members) {
					assert.ok(typeof m === "object" && m !== null, `${t.name} ${path}.${key} 存在裸标量成员（裸字符串 Union）：${JSON.stringify(m)}`);
				}
			}
			for (const [k, x] of Object.entries(o)) assertNoBareMembers(x, path ? `${path}.${k}` : k);
		};
		assertNoBareMembers(json, "");
	}
	// master-dispatch mode 具体化：4 个 Literal 成员
	const md = tools.find((t) => t.name === "master-dispatch")!;
	const mdJson = JSON.parse(JSON.stringify(md.parameters)) as { properties: { mode: { anyOf: Array<Record<string, unknown>> } } };
	assert.equal(mdJson.properties.mode.anyOf.length, 4);
	assert.deepEqual(mdJson.properties.mode.anyOf.map((m) => m.const).sort(), ["adaptive", "execute", "research", "workflow"]);
	ok("D1 全部 master 工具 parameters schema 合法（递归 TypeBox + provider 序列化无裸标量 Union 成员）");
}

console.log(`\n# pass ${n}`);
