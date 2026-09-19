/**
 * _test_runtime_master_auto.ts — A1 S3：Opt-in Automatic Master Succession
 *
 * 覆盖（隔离运行时目录，stub spawn）：
 *   T1 normalizeMasterSuccession（缺失/垃圾/缺字段/严格 true/clamp [1,100]）
 *   T2 effectiveAutoThresholdTokens（精确数值 / 缺席 no decision / 小窗口余量 ≤0）
 *   T3 Safety Gate 矩阵（8 项各一击：auto-off/not-owner/cutover-off/no-usage/
 *      in-flight/already-attempted/no-spawn/全通过）
 *   T4 OFF 零动作（零写零事件零 spawn）
 *   T5 成功路径（transferred + stub 恰 1 次 + marker completed +
 *      同代 pending 被 adoptTransfer 认领 → transferring → confirm 后 completed）
 *   T6 失败回退（旧主保留 / attention 1 条 / auto_failed 事件 / S2 回退 proposal /
 *      同代再次 → already-attempted，stub 总次数不变——禁无限重试）
 *   T7 跨代放行（新代 token attach 后可再触发）
 *   T8 边界（proposalPercent > autoPercent 时 auto 失败 → attention+事件在，proposal 缺席）
 *   T9 回归（masterStatusLogic 带/不带 cfg；maybePropose 缺省 0.75 行为零差）
 *   T10 OFF 真实接线集成（agent_end hook + 默认 auto:false → 无 spawn/无 notify/零写零事件）
 *   T11 阈值精确边界（171807 → below-threshold 零尝试；171808 → transfer）
 *   T12 transferMaster 非 spawn I/O 异常归一化（→ 失败回退全序列 + 同代禁重试）
 *   T13 1M 钉死：effectiveAutoThresholdTokens({900000,1M},90)=900000（percent 绑定，buffer 不生效）
 *   T14 三档保序：proposalLine(W) < autoLine(W)（128K/200K/1M）
 *   T15 双写 tripwire：proposalPercent/100 === DEFAULT_PROPOSAL_PERCENT
 *   T16 enabled=false 时 maybePropose 零动作（高压读数不落 proposal、无通知）
 *   T17 enabled=false 时 maybeAutoSucceed 静默（零 spawn 零 marker 零事件，reason=disabled）
 *   T18 enabled=true 现状等价（既有 T4–T15 全绿即证；本测钉 default enabled=true）
 *   T19 真实命令层：/master-succession on/off config 持久化往返 + 无参回显 +
 *      auto-handoff 不串扰 + enabled=off 时 pending reminder 全静默（回归）
 *
 * 运行：npm run test:runtime-master-auto
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "runtime-master-auto-env-"));

import { attachCurrentSession, issueMasterHandoffToken } from "./runtime/master-control.ts";
import { readAttachment, setCutover } from "./runtime/registry.ts";
import { masterAddress } from "./runtime/address.ts";
import { listRuntimeEnvelopes } from "./runtime/journal.ts";
import { confirmTransferAttach, readTransferRecord } from "./runtime/master-transfer.ts";
import { getPendingReminder, maybePropose, readProposal } from "./runtime/master-succession.ts";
import {
	DEFAULT_MASTER_SUCCESSION,
	checkAutoGate,
	effectiveAutoThresholdTokens,
	hasInFlightTransfer,
	maybeAutoSucceed,
	normalizeMasterSuccession,
	readAttentionItems,
	readAutoMarker,
	type MasterSuccessionConfig,
} from "./runtime/master-auto.ts";
import { masterStatusLogic } from "./master-tools.ts";
import { DEFAULT_PROPOSAL_PERCENT, proposalThresholdTokens } from "./runtime/master-pressure.ts";
// R1 回归网：session-hooks（含 master-auto 新导入链）仅定义无顶层执行，
// 导入即验证全部 import 绑定可解析（strip-types --check 只查语法，此导入补命名解析层）；
// T10 另直接调用 registerSessionHooks 走真实 agent_end 接线。
import { registerSessionHooks } from "./session-hooks.ts";

let n = 0;
const ok = (name: string) => { n++; console.log(`ok ${n} - ${name}`); };

const STATE_DIR = join(process.env.PI_RUNTIME_DIR!, "state");
const masterAutoPath = join(STATE_DIR, "master-auto.json");
const attentionPath = join(STATE_DIR, "master-attention.json");
const transfersDir = join(STATE_DIR, "master-transfers");
const masterEventCount = () =>
	listRuntimeEnvelopes().envelopes.filter((e) => e.type.startsWith("master.")).length;

const ON: MasterSuccessionConfig = { enabled: true, auto: true, proposalPercent: 75, autoPercent: 90 };
const HI = { tokens: 176000, contextWindow: 200000, percent: 88 }; // 88% < 90% 线，但 176000 ≥ 171808（min 线 = 200000−28192）
const OK_SPAWN = () => ({ successorRunId: "run_stub" });

// T1 配置归一化
{
	const d = DEFAULT_MASTER_SUCCESSION;
	for (const raw of [undefined, null, "on", 5, [1], true]) {
		assert.deepEqual(normalizeMasterSuccession(raw), d);
	}
	assert.deepEqual(normalizeMasterSuccession({}), d);
	assert.equal(normalizeMasterSuccession({ auto: "on" }).auto, false); // 严格 === true
	assert.equal(normalizeMasterSuccession({ auto: 1 }).auto, false);
	assert.equal(normalizeMasterSuccession({ auto: true }).auto, true);
	assert.equal(normalizeMasterSuccession({ auto: true, proposalPercent: 0 }).proposalPercent, 1); // clamp
	assert.equal(normalizeMasterSuccession({ auto: true, autoPercent: 150 }).autoPercent, 100); // clamp
	assert.equal(normalizeMasterSuccession({ auto: true, proposalPercent: "x" }).proposalPercent, 75);
	assert.equal(d.enabled, true, "总开关默认 true（现状零行为变化）");
	assert.equal(normalizeMasterSuccession({ enabled: false }).enabled, false);
	assert.equal(normalizeMasterSuccession({ enabled: "false" }).enabled, true, "严格 === false 才关");
	assert.equal(normalizeMasterSuccession({ auto: 1 }).enabled, true); // 缺省补全
	ok("T1 normalizeMasterSuccession：默认/严格 true/clamp [1,100]/enabled 严格 false");
}

// T2 阈值
{
	assert.equal(effectiveAutoThresholdTokens({ tokens: 176000, contextWindow: 200000 }, 90), 171808);
	assert.equal(effectiveAutoThresholdTokens({ tokens: 176000, contextWindow: 200000 }, 50), 100000);
	assert.equal(effectiveAutoThresholdTokens({ tokens: 50000, contextWindow: 100000 }, 50), 50000);
	assert.equal(effectiveAutoThresholdTokens({ tokens: null, contextWindow: 200000 }, 90), null);
	assert.equal(effectiveAutoThresholdTokens({ tokens: 176000, contextWindow: null }, 90), null);
	assert.equal(effectiveAutoThresholdTokens({ tokens: 100, contextWindow: 10000 }, 90), null); // 余量 ≤0 → no decision
	ok("T2 effectiveAutoThresholdTokens：精确数值/缺席 null/小窗口 null");
}

// T3 Gate 矩阵
const OWNER = "sess_auto_owner";
{
	const a = attachCurrentSession({ sessionId: OWNER });
	assert.equal(a.ok, true);
	setCutover(false, OWNER); // 先关，供 cutover-off 一击
	const gate = (over: Partial<{ cfg: MasterSuccessionConfig; spawn: unknown; sessionId: string; reading: unknown }>) =>
		checkAutoGate({
			sessionId: over.sessionId ?? OWNER,
			generation: readAttachment(masterAddress())!.generation,
			reading: (over.reading ?? HI) as never,
			cfg: over.cfg ?? ON,
			spawn: over.spawn as never,
		});

	assert.deepEqual(gate({ cfg: { ...DEFAULT_MASTER_SUCCESSION } }), { pass: false, reason: "auto-off" });
	assert.deepEqual(gate({ sessionId: "nobody" }), { pass: false, reason: "not-owner" });
	assert.deepEqual(gate({}), { pass: false, reason: "cutover-off" });
	setCutover(true, OWNER);
	assert.deepEqual(gate({ reading: { tokens: null, contextWindow: null, percent: null } }), { pass: false, reason: "no-usage" });

	mkdirSync(transfersDir, { recursive: true });
	const inflight = join(transfersDir, "tr_gate.json");
	writeFileSync(inflight, JSON.stringify({ version: 1, transferId: "tr_gate", status: "spawned" }));
	assert.equal(hasInFlightTransfer(), true);
	assert.deepEqual(gate({}), { pass: false, reason: "in-flight-transfer" });
	rmSync(inflight);

	mkdirSync(STATE_DIR, { recursive: true });
	const marker = masterAutoPath;
	writeFileSync(marker, JSON.stringify({ version: 1, lastAttemptGeneration: 1, lastAttemptAt: "1970-01-01T00:00:00.000Z", lastOutcome: "failed" }));
	assert.deepEqual(gate({}), { pass: false, reason: "already-attempted" });
	rmSync(marker);

	assert.deepEqual(gate({ spawn: null }), { pass: false, reason: "no-spawn" });
	assert.deepEqual(gate({ spawn: OK_SPAWN }), { pass: true });
	ok("T3 Gate 矩阵：auto-off/not-owner/cutover-off/no-usage/in-flight/already-attempted/no-spawn/全通过");
}

// T4 OFF 零动作
{
	const before = masterEventCount();
	let spawnCalls = 0;
	const r = maybeAutoSucceed({
		sessionId: OWNER,
		generation: readAttachment(masterAddress())!.generation,
		reading: HI,
		cfg: { ...DEFAULT_MASTER_SUCCESSION }, // auto:false
		spawn: () => { spawnCalls++; return { successorRunId: "x" }; },
	});
	assert.deepEqual(r, { action: "none", reason: "auto-off" });
	assert.equal(spawnCalls, 0);
	assert.equal(existsSync(masterAutoPath), false);
	assert.equal(existsSync(attentionPath), false);
	assert.ok(!existsSync(transfersDir) || readdirSync(transfersDir).length === 0);
	assert.equal(masterEventCount(), before); // 零 journal 增量
	ok("T4 OFF 零动作：零写零事件零 spawn");
}

// T5 成功路径
let transferId5 = "";
{
	// 预置同代 pending（S2 同轮已提议的情形）
	const p = maybePropose({ sessionId: OWNER, generation: 1, reading: HI });
	assert.equal(p.proposed, true);
	let spawnCalls = 0;
	const r = maybeAutoSucceed({
		sessionId: OWNER,
		generation: 1,
		reading: HI,
		cfg: ON,
		spawn: () => { spawnCalls++; return { successorRunId: "run_auto_1" }; },
	});
	assert.equal(r.action, "transferred");
	if (r.action !== "transferred") throw new Error("unreachable");
	transferId5 = r.transferId;
	assert.equal(r.successorRunId, "run_auto_1");
	assert.equal(r.generation, 1);
	assert.equal(spawnCalls, 1);
	const m = readAutoMarker();
	assert.equal(m?.lastOutcome, "completed");
	assert.equal(m?.lastAttemptGeneration, 1);
	assert.equal(m?.lastTransferId, transferId5);
	assert.equal(readProposal()?.status, "transferring"); // 同代 pending 被 adoptTransfer 认领
	assert.equal(readProposal()?.transferId, transferId5);
	const rec = readTransferRecord(transferId5);
	assert.equal(rec?.status, "spawned");
	// 后继凭 token attach（gen+1）→ confirm 闭环 → proposal completed
	const a2 = attachCurrentSession({ sessionId: "sess_auto_gen2", token: rec?.token });
	assert.equal(a2.ok, true);
	if (a2.ok) assert.equal(a2.attachment.generation, 2);
	const c = confirmTransferAttach({ transferId: transferId5, sessionId: "sess_auto_gen2" });
	assert.equal(c.ok, true);
	assert.equal(readProposal()?.status, "completed");
	ok("T5 成功路径：transferred + stub 恰 1 次 + marker completed + pending 认领→completed 闭环");
}

// T6 失败回退
{
	const OWNER2 = "sess_auto_gen2";
	let spawnCalls = 0;
	const r = maybeAutoSucceed({
		sessionId: OWNER2,
		generation: 2,
		reading: HI,
		cfg: ON,
		spawn: () => { spawnCalls++; throw new Error("boom"); },
	});
	assert.equal(r.action, "failed");
	if (r.action !== "failed") throw new Error("unreachable");
	assert.equal(r.error, "boom");
	assert.equal(r.transferId.length > 0, true);
	// 旧主保留（同代同会话）
	const att = readAttachment(masterAddress())!;
	assert.equal(att.sessionId, OWNER2);
	assert.equal(att.generation, 2);
	// Attention item 1 条
	const items = readAttentionItems();
	assert.equal(items.length, 1);
	assert.equal(items[0].kind, "auto-handoff-failed");
	assert.equal(items[0].transferId, r.transferId);
	assert.equal(items[0].generation, 2);
	// auto_failed 事件
	assert.ok(listRuntimeEnvelopes().envelopes.some((e) => e.type === "master.handoff.auto_failed"));
	// S2 回退 proposal（88 ≥ 75 → pending 新落）
	assert.equal(readProposal()?.status, "pending");
	assert.equal(readProposal()?.generation, 2);
	// marker failed
	assert.equal(readAutoMarker()?.lastOutcome, "failed");
	// 同代再次调用 → 禁无限重试
	const again = maybeAutoSucceed({ sessionId: OWNER2, generation: 2, reading: HI, cfg: ON, spawn: () => { spawnCalls++; return { successorRunId: "x" }; } });
	assert.deepEqual(again, { action: "none", reason: "already-attempted" });
	assert.equal(spawnCalls, 1);
	ok("T6 失败回退：旧主保留/attention/auto_failed 事件/S2 回退/同代禁重试");
}

// T7 跨代放行（gen+1 后 marker 不再阻断）
{
	const tok = issueMasterHandoffToken({ sessionId: "sess_auto_gen2", reason: "t7" });
	assert.equal(tok.ok, true);
	if (!tok.ok || !("token" in tok) || !tok.token) throw new Error("unreachable");
	const a3 = attachCurrentSession({ sessionId: "sess_auto_gen3", token: tok.token });
	assert.equal(a3.ok, true);
	if (a3.ok) assert.equal(a3.attachment.generation, 3);
	let spawnCalls = 0;
	const r = maybeAutoSucceed({
		sessionId: "sess_auto_gen3",
		generation: 3,
		reading: HI,
		cfg: ON,
		spawn: () => { spawnCalls++; return { successorRunId: "run_auto_2" }; },
	});
	assert.equal(r.action, "transferred");
	if (r.action !== "transferred") throw new Error("unreachable");
	assert.equal(spawnCalls, 1);
	// 收尾：完成 T7 的 transfer（避免 in-flight 阻断 T8）
	const rec = readTransferRecord(r.transferId)!;
	const a4 = attachCurrentSession({ sessionId: "sess_auto_gen4", token: rec.token });
	assert.equal(a4.ok, true);
	if (a4.ok) assert.equal(a4.attachment.generation, 4);
	assert.equal(confirmTransferAttach({ transferId: r.transferId, sessionId: "sess_auto_gen4" }).ok, true);
	ok("T7 跨代放行：新代 marker 不阻断，可再触发");
}

// T8 边界：proposalPercent > autoPercent → auto 失败后 S2 回退 below-threshold，proposal 缺席但不抛错
// 档位表 0919：200K 档 proposal 被 cap=150K 硬顶，p=0.95 无法再抬线（176K 恒达）——
// 原构造失效。改用 128K 档（百分比主导区）：auto 线=min(90%×128K, 128K−28192)=99808，
// proposal(0.95) 线=min(121.6K,150K)=121600；取 110000 ∈ [99808,121600)：auto 达、proposal 未达。
{
	const HI128 = { tokens: 110000, contextWindow: 128000, percent: 85.9 };
	const cfg: MasterSuccessionConfig = { enabled: true, auto: true, proposalPercent: 95, autoPercent: 90 };
	const r = maybeAutoSucceed({
		sessionId: "sess_auto_gen4",
		generation: 4,
		reading: HI128, // 85.9% < 95% 提议线（121.6K），但 110000 ≥ auto 线 99808
		cfg,
		spawn: () => { throw new Error("boom8"); },
	});
	assert.equal(r.action, "failed");
	if (r.action !== "failed") throw new Error("unreachable");
	const items = readAttentionItems();
	assert.equal(items.length, 2); // T6 + T8 各一条
	assert.equal(items[1].transferId, r.transferId);
	const failedEvents = listRuntimeEnvelopes().envelopes.filter((e) => e.type === "master.handoff.auto_failed");
	assert.equal(failedEvents.length, 2);
	const p = readProposal();
	assert.ok(p === null || p.generation !== 4, "proposalPercent 95% 未达 → 不新落 proposal");
	ok("T8 边界：auto 失败 → attention+事件在，S2 proposal 缺席不抛错");
}

// T9 回归：masterStatusLogic 带/不带 cfg；maybePropose 缺省 0.75 零差
{
	const noCfg = masterStatusLogic();
	assert.match(noCfg.text, /attachment: /);
	assert.ok(!noCfg.text.includes("auto-handoff"));
	const off = masterStatusLogic(DEFAULT_MASTER_SUCCESSION);
	assert.match(off.text, /succession: on \u00b7 auto-handoff: OFF \(autoPercent=90\)/);
	const on = masterStatusLogic({ enabled: true, auto: true, proposalPercent: 75, autoPercent: 90 });
	assert.match(on.text, /succession: on \u00b7 auto-handoff: ON \(autoPercent=90\)/);
	const off2 = masterStatusLogic({ enabled: false, auto: false, proposalPercent: 75, autoPercent: 90 });
	assert.match(off2.text, /succession: off \u00b7 auto-handoff: OFF \(autoPercent=90\)/);
	// S2 缺省 75% 线：74% 不提议、76% 提议（现状行为不变）
	const low = maybePropose({ sessionId: "sess_auto_gen4", generation: 4, reading: { tokens: 148000, contextWindow: 200000, percent: 74 } });
	assert.equal(low.proposed, false);
	const hit = maybePropose({ sessionId: "sess_auto_gen4", generation: 4, reading: { tokens: 152000, contextWindow: 200000, percent: 76 } });
	assert.equal(hit.proposed, true);
	assert.equal(readProposal()?.generation, 4);
	ok("T9 回归：masterStatusLogic cfg 行 + maybePropose 缺省 0.75 零差");
}

// T10 OFF 真实接线集成：agent_end hook（默认 auto:false）→ 无 spawn / 无 UI notify /
// 无 auto marker / attention / transfer / journal 写入（review 必须项 1）。
// 选 gen4：T9 已落 gen4 pending → S2 maybePropose 走 already-proposed（零写零 notify），
// 整条 hook 路径均无副作用，隔离 S3 零动作语义。
{
	// sessionIdentity 优先读 PI_TAB_RUN_ID/PI_SUBAGENT（测试进程环境可能残留）→ 先清，
	// 保证 sid 取自 ctx.sessionManager.sessionId，hook 不提前短路。
	const savedTab = process.env.PI_TAB_RUN_ID;
	const savedSub = process.env.PI_SUBAGENT;
	delete process.env.PI_TAB_RUN_ID;
	delete process.env.PI_SUBAGENT;
	try {
		const before = masterEventCount();
		const markerRaw = existsSync(masterAutoPath) ? readFileSync(masterAutoPath, "utf8") : null;
		const attnBefore = readAttentionItems().length;
		const recsBefore = existsSync(transfersDir) ? readdirSync(transfersDir).length : 0;
		const proposalBefore = readProposal();
		let spawnCalls = 0;
		const notifyCalls: Array<[string, string]> = [];
		const handlers: Record<string, (...a: unknown[]) => void> = {};
		const pi = { on: (ev: string, h: (...a: unknown[]) => void) => { handlers[ev] = h; } };
		registerSessionHooks(pi as unknown as ExtensionAPI, {
			cleanups: [],
			isNotifyEnabled: () => false,
			pkgDir: "",
			spawnSuccessor: () => { spawnCalls++; return { successorRunId: "run_off" }; },
			masterSuccession: () => ({ ...DEFAULT_MASTER_SUCCESSION }), // 默认 auto:false
		});
		const ctx = {
			sessionManager: { sessionId: "sess_auto_gen4" }, // 当前 owner（gen4）
			getContextUsage: () => ({ tokens: 176000, contextWindow: 200000, percent: 88 }), // 高压读数
			ui: { notify: (msg: string, level: string) => { notifyCalls.push([msg, level]); } },
		};
		assert.ok(typeof handlers["agent_end"] === "function", "agent_end 已注册");
		handlers["agent_end"]({}, ctx as never);
		assert.equal(spawnCalls, 0, "OFF：无 spawn");
		assert.equal(notifyCalls.length, 0, "OFF：无 UI notify（S2 already-proposed + S3 auto-off）");
		const markerRawAfter = existsSync(masterAutoPath) ? readFileSync(masterAutoPath, "utf8") : null;
		assert.equal(markerRawAfter, markerRaw, "OFF：auto marker 未动");
		assert.equal(readAttentionItems().length, attnBefore, "OFF：无 attention 写入");
		assert.equal(existsSync(transfersDir) ? readdirSync(transfersDir).length : 0, recsBefore, "OFF：无 transfer 记录");
		assert.equal(masterEventCount(), before, "OFF：零 journal 增量");
		assert.deepEqual(readProposal(), proposalBefore, "OFF：proposal 未动");
		n++; console.log(`ok ${n} - T10 OFF 真实接线集成：agent_end 下无 spawn/无 notify/零写零事件`);
	} finally {
		if (savedTab !== undefined) process.env.PI_TAB_RUN_ID = savedTab; else delete process.env.PI_TAB_RUN_ID;
		if (savedSub !== undefined) process.env.PI_SUBAGENT = savedSub; else delete process.env.PI_SUBAGENT;
	}
}

// T11 阈值精确边界（review 必须项 2）：200000/90% 已知线 171808 = min(180000, 200000-20000-8192)。
// 171807 → below-threshold 且零尝试；171808 → transfer。T2 的函数级数值样例保持不动。
// 反证③：reserve 改回 16384 ⇒ 线回 175424 ⇒ 171808 例变 below-threshold ⇒ 红。
{
	const tok = issueMasterHandoffToken({ sessionId: "sess_auto_gen4", reason: "t11" });
	assert.equal(tok.ok, true);
	if (!tok.ok || !("token" in tok) || !tok.token) throw new Error("unreachable");
	const a5 = attachCurrentSession({ sessionId: "sess_auto_gen5", token: tok.token });
	assert.equal(a5.ok, true);
	if (a5.ok) assert.equal(a5.attachment.generation, 5);

	const markerRaw = existsSync(masterAutoPath) ? readFileSync(masterAutoPath, "utf8") : null;
	const eventsBefore = masterEventCount();
	const recsBefore = existsSync(transfersDir) ? readdirSync(transfersDir).length : 0;
	let spawnCalls = 0;
	const low = maybeAutoSucceed({
		sessionId: "sess_auto_gen5",
		generation: 5,
		reading: { tokens: 171807, contextWindow: 200000, percent: 85.9 },
		cfg: ON,
		spawn: () => { spawnCalls++; return { successorRunId: "x" }; },
	});
	assert.deepEqual(low, { action: "none", reason: "below-threshold" }); // 171807 差 1 不触发
	assert.equal(spawnCalls, 0);
	const markerRawAfter = existsSync(masterAutoPath) ? readFileSync(masterAutoPath, "utf8") : null;
	assert.equal(markerRawAfter, markerRaw, "below-threshold 零尝试：marker 未写");
	assert.equal(masterEventCount(), eventsBefore, "below-threshold 零事件");
	assert.equal(existsSync(transfersDir) ? readdirSync(transfersDir).length : 0, recsBefore, "below-threshold 零 transfer 记录");

	const high = maybeAutoSucceed({
		sessionId: "sess_auto_gen5",
		generation: 5,
		reading: { tokens: 171808, contextWindow: 200000, percent: 85.9 },
		cfg: ON,
		spawn: () => { spawnCalls++; return { successorRunId: "run_auto_3" }; },
	});
	assert.equal(high.action, "transferred", "171808 恰达线 → transfer");
	if (high.action !== "transferred") throw new Error("unreachable");
	assert.equal(high.successorRunId, "run_auto_3");
	assert.equal(spawnCalls, 1);
	assert.equal(readAutoMarker()?.lastOutcome, "completed");
	assert.equal(readAutoMarker()?.lastAttemptGeneration, 5);
	// 收尾：attach gen+1 + confirm（清 in-flight，避免干扰 T12 的 gate ⑤）
	const rec = readTransferRecord(high.transferId)!;
	const a6 = attachCurrentSession({ sessionId: "sess_auto_gen6", token: rec.token });
	assert.equal(a6.ok, true);
	if (a6.ok) assert.equal(a6.attachment.generation, 6);
	assert.equal(confirmTransferAttach({ transferId: high.transferId, sessionId: "sess_auto_gen6" }).ok, true);
	n++; console.log(`ok ${n} - T11 阈值精确边界：171807 below-threshold 零尝试 / 171808 transfer`);
}

// T12 transferMaster 非 spawn I/O 异常归一化（review 必须项 3）：记录目录 mkdirSync 招 ENOTDIR
//（transferMaster 在 spawn try/catch 之前的 I/O 路径）→ 归一化为失败回退：旧主保留 +
// marker failed + Attention(transferId 空) + auto_failed 事件 + S2 回退 proposal + 同代禁重试。
{
	// 构造：stateDir/master-transfers 是已存在文件 → writeRecordAtomic 的 mkdirSync(recursive) 招 ENOTDIR
	const ioDir = join(STATE_DIR, "io-block");
	mkdirSync(ioDir, { recursive: true });
	writeFileSync(join(ioDir, "master-transfers"), "x");

	let spawnCalls = 0;
	const r = maybeAutoSucceed(
		{
			sessionId: "sess_auto_gen6",
			generation: 6,
			reading: HI,
			cfg: ON,
			spawn: () => { spawnCalls++; return { successorRunId: "x" }; },
		},
		{ stateDir: ioDir },
	);
	assert.equal(r.action, "failed", "I/O 异常归一化为 failed，不向 agent_end 外招");
	if (r.action !== "failed") throw new Error("unreachable");
	assert.equal(r.transferId, ""); // 记录未落盘 → transferId 未知
	assert.ok(r.error.length > 0, "error 保留底层 I/O 异常信息");
	assert.equal(spawnCalls, 0);
	// 旧主保留（异常未改 attachment）
	const att = readAttachment(masterAddress())!;
	assert.equal(att.sessionId, "sess_auto_gen6");
	assert.equal(att.generation, 6);
	// marker failed（ioDir 内）
	const m = readAutoMarker(ioDir);
	assert.equal(m?.lastOutcome, "failed");
	assert.equal(m?.lastAttemptGeneration, 6);
	// Attention +1（ioDir 独立 state 目录 → 第一条），transferId 空
	const items = readAttentionItems(ioDir);
	assert.equal(items.length, 1);
	assert.equal(items[0].kind, "auto-handoff-failed");
	assert.equal(items[0].transferId, "");
	assert.equal(items[0].generation, 6);
	// auto_failed 事件 +1（T6+T8 共 2 → 3）
	const failedEvents = listRuntimeEnvelopes().envelopes.filter((e) => e.type === "master.handoff.auto_failed");
	assert.equal(failedEvents.length, 3);
	// S2 回退 proposal（88 ≥ 75；ioDir 独立 proposal 文件 → 新落 gen6 pending）
	const p = readProposal(ioDir);
	assert.equal(p?.status, "pending");
	assert.equal(p?.generation, 6);
	// 同代再次调用 → 禁无限重试（marker failed 也阻断）
	const again = maybeAutoSucceed(
		{ sessionId: "sess_auto_gen6", generation: 6, reading: HI, cfg: ON, spawn: () => { spawnCalls++; return { successorRunId: "x" }; } },
		{ stateDir: ioDir },
	);
	assert.deepEqual(again, { action: "none", reason: "already-attempted" });
	assert.equal(spawnCalls, 0);
	n++; console.log(`ok ${n} - T12 非 spawn I/O 异常归一化：failed 回退全序列 + 同代禁重试`);
}

// T13 1M 钉死：1M 档 auto 线 = min(round(1M×90%)=900000, 1M−28192=971808) = 900000（percent 绑定，
// buffer 不生效）——文档化现状（S3@1M 仍 90% 不可达；S3 OFF 下无实害，生产化需同款参考窗改造）。
{
	assert.equal(effectiveAutoThresholdTokens({ tokens: 900000, contextWindow: 1000000 }, 90), 900000);
	ok("T13 1M 钉死：auto 线=900000（percent 绑定，buffer 不生效）");
}

// T14 三档保序：同窗 S2 proposal 线 < S3 auto 线（96000<99808；150000<171808；150000<900000）。
{
	for (const W of [128000, 200000, 1000000]) {
		const p = proposalThresholdTokens(W, 0.75);
		const a = effectiveAutoThresholdTokens({ tokens: 0, contextWindow: W }, 90)!;
		assert.ok(p < a, `保序 W=${W}: proposal ${p} < auto ${a}`);
	}
	ok("T14 三档保序：128K/200K/1M 同窗 proposal 线 < auto 线");
}

// T15 双写 tripwire：config 旋钮 proposalPercent 与 master-pressure 的 DEFAULT_PROPOSAL_PERCENT 永久同步（R3）。
{
	assert.equal(DEFAULT_MASTER_SUCCESSION.proposalPercent / 100, DEFAULT_PROPOSAL_PERCENT);
	ok("T15 双写 tripwire：proposalPercent/100 === DEFAULT_PROPOSAL_PERCENT");
}

// T16 总开关 enabled=false：maybePropose 入口静默返回 null——高压读数（88 ≥ 75 线）
// 不落 proposal、无通知、不落任何 state（owner 是 gen6，无同代 pending，排除 already-proposed 干扰）。
{
	const disabled: MasterSuccessionConfig = { enabled: false, auto: true, proposalPercent: 75, autoPercent: 90 };
	const proposalBefore = readProposal();
	const r = maybePropose({ sessionId: "sess_auto_gen6", generation: 6, reading: HI, proposalPercent: 0.75, enabled: false });
	assert.equal(r, null, "enabled=false → 返回 null（不落盘不通知）");
	assert.deepEqual(readProposal(), proposalBefore, "proposal 文件未动");
	ok("T16 enabled=false：maybePropose 零动作（高压不落 proposal、无通知）");
}

// T17 总开关 enabled=false：maybeAutoSucceed 入口静默（reason=disabled），
// 零 spawn 零 marker 零事件零 transfer 记录；enabled 门在 auto 门之前（S3 独立开关保留但失效）。
{
	const eventsBefore = masterEventCount();
	const recsBefore = existsSync(transfersDir) ? readdirSync(transfersDir).length : 0;
	const markerRaw = existsSync(masterAutoPath) ? readFileSync(masterAutoPath, "utf8") : null;
	let spawnCalls = 0;
	const r = maybeAutoSucceed({
		sessionId: "sess_auto_gen6",
		generation: 6,
		reading: HI,
		cfg: { enabled: false, auto: true, proposalPercent: 75, autoPercent: 90 },
		spawn: () => { spawnCalls++; return { successorRunId: "x" }; },
	});
	assert.deepEqual(r, { action: "none", reason: "disabled" }, "入口静默，先于 auto 门");
	assert.equal(spawnCalls, 0);
	const markerRawAfter = existsSync(masterAutoPath) ? readFileSync(masterAutoPath, "utf8") : null;
	assert.equal(markerRawAfter, markerRaw, "零 marker 写入");
	assert.equal(masterEventCount(), eventsBefore, "零 journal 增量");
	assert.equal(existsSync(transfersDir) ? readdirSync(transfersDir).length : 0, recsBefore, "零 transfer 记录");
	ok("T17 enabled=false：maybeAutoSucceed 静默（零 spawn 零 marker 零事件）");
}

// T18 enabled=true 现状等价：默认配置 enabled=true 时既有行为零差（T4–T15 全绿即证；
// 本测只钉默认值，防有人把 default 翻 false 静默关闭 succession）。
{
	assert.equal(DEFAULT_MASTER_SUCCESSION.enabled, true);
	assert.equal(normalizeMasterSuccession(undefined).enabled, true);
	ok("T18 enabled=true 现状等价：default enabled=true（既有 T4–T15 零差）");
}

// T19 真实命令层（review 返修）：fake ExtensionAPI 捕获 index.ts 真实 default factory 注册的
// /master-succession 命令 handler 并真实调用（惯例同 _test_register_graph.ts 的 factory 直调 +
// _test_lite_mode.ts 的 handler 捕获断言模式）。index.ts 无循环 import 阻塞（register-graph
// 长期直接 import 验证）；命令 handler 的 config 读写走模块级 readConfig/writeConfig（无注入
// 缝），故先备份真实 config.json，finally 恢复原字节。before_agent_start 的 pending reminder
// 门禁回归（review 必须项 1）复用同一 factory 注册的真实 hook。
{
	const testDir = dirname(fileURLToPath(import.meta.url));
	const cfgPath = join(testDir, "..", "config.json");
	const backup = existsSync(cfgPath) ? readFileSync(cfgPath, "utf8") : null;
	// 身份环境隔离（同 T10 / _test_lite_mode）：清 tab/subagent/profile 身份，factory 以主会话执行
	const savedTab = process.env.PI_TAB_RUN_ID;
	const savedSub = process.env.PI_SUBAGENT;
	const savedProf = process.env.PI_SESSION_PROFILE;
	delete process.env.PI_TAB_RUN_ID;
	delete process.env.PI_SUBAGENT;
	delete process.env.PI_SESSION_PROFILE;
	try {
		const indexMod = await import("./index.ts");
		const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
		const hooks = new Map<string, Array<(ev: unknown, ctx: unknown) => unknown>>();
		const fakePi = {
			registerTool: () => {},
			registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
				commands.set(name, def.handler);
			},
			registerFlag: () => {},
			on: (ev: string, h: (ev: unknown, ctx: unknown) => unknown) => {
				hooks.set(ev, [...(hooks.get(ev) ?? []), h]);
			},
			getFlag: () => "",
			sendUserMessage: () => {},
			sendMessage: () => {},
			exec: () => {},
		} as unknown as ExtensionAPI;
		await indexMod.default(fakePi);
		assert.ok(commands.has("master-succession"), "/master-succession 已注册");
		assert.ok(commands.has("master-auto-handoff"), "/master-auto-handoff 已注册");
		const beforeStart = hooks.get("before_agent_start") ?? [];
		assert.equal(beforeStart.length, 1, "before_agent_start 已注册");

		const notices: string[] = [];
		const cmdCtx = { hasUI: true, ui: { notify: (m: string) => notices.push(m) } };
		const run = (name: string, args: string): Promise<void> => {
			const h = commands.get(name);
			if (!h) throw new Error(`command ${name} 未注册`);
			return h(args, cmdCtx as never);
		};
		const readRaw = (): Record<string, unknown> => JSON.parse(readFileSync(cfgPath, "utf8"));
		const backupObj: Record<string, unknown> = backup ? JSON.parse(backup) : {};
		const ms = (r: Record<string, unknown>) => r.masterSuccession as { enabled: boolean; auto: boolean; proposalPercent: number; autoPercent: number };

		// ① 无参调用：回显当前状态（真实 config 无 masterSuccession 切片 → 归一化 enabled=true）
		await run("master-succession", "");
		assert.ok(notices[notices.length - 1].includes("succession 当前：on"), "无参回显 on");
		assert.ok(notices[notices.length - 1].includes("/master-succession on|off"), "无参带用法");

		// ② off：持久化 enabled:false，其它切片不变，默认值补全
		notices.length = 0;
		await run("master-succession", "off");
		let raw = readRaw();
		assert.equal(ms(raw).enabled, false, "off 持久化");
		assert.equal(ms(raw).auto, false, "auto 缺省补全不被篡改");
		for (const k of Object.keys(backupObj)) {
			if (k === "masterSuccession") continue;
			assert.deepEqual(raw[k], backupObj[k], `键 ${k} 保留`);
		}
		assert.ok(notices[0].includes("succession 已关闭"), "off 通知");

		// ③ on：往返恢复 enabled:true，auto 保持缺省 false
		notices.length = 0;
		await run("master-succession", "on");
		raw = readRaw();
		assert.equal(ms(raw).enabled, true, "on 往返恢复");
		assert.ok(notices[0].includes("succession 已开启（auto=OFF）"), "on 通知 + auto 子开关回显");

		// ④ 非法参数：零落盘，落到用法回显
		const beforeBogus = readFileSync(cfgPath, "utf8");
		notices.length = 0;
		await run("master-succession", "bogus");
		assert.equal(readFileSync(cfgPath, "utf8"), beforeBogus, "非法参数不写盘");
		assert.ok(notices[0].includes("succession 当前：on"), "非法参数落到状态回显");

		// ⑤ 不串扰：/master-auto-handoff 只改 auto 不动 enabled；总开关只改 enabled 不重写 auto
		await run("master-auto-handoff", "on");
		raw = readRaw();
		assert.equal(ms(raw).auto, true, "auto 命令开启 auto");
		assert.equal(ms(raw).enabled, true, "auto 命令不动 enabled");
		await run("master-succession", "off");
		raw = readRaw();
		assert.equal(ms(raw).enabled, false, "总开关关闭");
		assert.equal(ms(raw).auto, true, "总开关不重写 auto 子开关（失效但未被改写）");
		notices.length = 0;
		await run("master-succession", "");
		assert.ok(notices[notices.length - 1].includes("succession 当前：off"), "无参回显跟随最新 off");

		// ⑥ pending reminder 门禁（review 必须项 1）：先有 pending（T9 已落 gen4 pending 于隔离
		//    临时 state 目录，PI_RUNTIME_DIR）→ enabled=off 时下一轮零注入且 pending 不清除；回 on 恢复。
		assert.ok(getPendingReminder() !== null, "前置：pending proposal 存在");
		const startCtx = { modelRegistry: { getAvailable: () => [] } };
		const contentOf = async (): Promise<string> => {
			const r = (await beforeStart[0]({}, startCtx)) as { message?: { content?: string } } | undefined;
			return r?.message?.content ?? "";
		};
		// 当前 enabled=false（⑤ 遗留 off）：下一轮不注入 reminder，pending 文件保留
		let content = await contentOf();
		assert.ok(!content.includes("A pending Master handoff proposal exists"), "enabled=off → 无 reminder（全静默）");
		assert.ok(!content.includes("call master-transfer"), "enabled=off → 无交接指引行");
		assert.ok(getPendingReminder() !== null, "pending state 未被清除");
		// 回 on：reminder 恢复（现有生命周期原样恢复）
		await run("master-succession", "on");
		content = await contentOf();
		assert.ok(content.includes("A pending Master handoff proposal exists"), "enabled=on → reminder 恢复");
		assert.ok(content.includes("call master-transfer"), "enabled=on → 交接指引行恢复");

		// ⑦ 恢复默认：auto off（回缺省 OFF）；enabled 保持 on
		notices.length = 0;
		await run("master-auto-handoff", "off");
		raw = readRaw();
		assert.equal(ms(raw).auto, false, "auto 恢复缺省 OFF");
		assert.equal(ms(raw).enabled, true, "enabled 保持 on");
	} finally {
		if (backup !== null) writeFileSync(cfgPath, backup);
		else if (existsSync(cfgPath)) rmSync(cfgPath);
		if (savedTab !== undefined) process.env.PI_TAB_RUN_ID = savedTab; else delete process.env.PI_TAB_RUN_ID;
		if (savedSub !== undefined) process.env.PI_SUBAGENT = savedSub; else delete process.env.PI_SUBAGENT;
		if (savedProf !== undefined) process.env.PI_SESSION_PROFILE = savedProf; else delete process.env.PI_SESSION_PROFILE;
	}
// status 行显示（纯函数半，不依赖命令）：succession: on/off 两态
{
	const off = { ...DEFAULT_MASTER_SUCCESSION, enabled: false };
	assert.match(masterStatusLogic(off).text, /succession: off \u00b7 auto-handoff: OFF \(autoPercent=90\)/);
	assert.match(masterStatusLogic(DEFAULT_MASTER_SUCCESSION).text, /succession: on \u00b7 auto-handoff: OFF \(autoPercent=90\)/);
}
	n++; console.log(`ok ${n} - T19 真实命令层：on→off→on config 持久化往返 + 无参回显 + auto-handoff 不串扰 + enabled=off 时 pending reminder 全静默`);
}

console.log(`\n# pass ${n}`);
