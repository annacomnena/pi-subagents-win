/**
 * _test_autonomy_wiring.ts — Task 2006 L2 · Autonomy Suite v2 接线验收（W1–W6）
 *
 * plans/0923_autonomy_suite_v2_plan.md「测试与验证」：
 *   W1 默认关闭端到端（零行为变化，硬约束）：显式注入 temp no-key config（R10：不依赖真实包根
 *      config.json 现状）+ cutover on + owner + ws + pending letter → evaluateWakes 输出与 legacy
 *      期望一致（fire/letters/prompt 同构）；state/autonomy/ 零新文件；二次 tick 行为不变；
 *      masterStatusLogic 输出无 autonomy 行
 *   W2 kill 演练五步（两层断言）：(a) evaluateWakes 层只断确定性不变量（本层无法注入 agentDir——
 *      复核事实 7：frontier 读真实 ~/.pi/agent；reason 字符串在 (b) gate 直调层断）；
 *      (b) gate 直调层（temp agentDir 注入，确定性）断 reason
 *   W3 状态行谓词矩阵：无足迹→无行；frontier 快照/kill/wake-gate state 三类足迹→行出现且字段正确；
 *      全 never-throw（坏文件容忍读 → 行缺席不抛）
 *   W4 evaluateAutonomyWakeGate 单元矩阵（configPath/stateDir/agentDir/now 全注入）+ 锚点维护
 *   W5 appendAuditEvent 行格式五字段 + never-throw
 *   W6 engaged 模式 audit 体积快照（一次完整评估 = frontier 摘要 1 + watchdog 1 + cat=wake 恰 1；
 *      无 v1 格式 autonomy-disabled 杂行——configPath 透传后 collect 与 gate 同源，工程约束 3）
 *
 * 前提（R10）：包根 config.json 无 autonomy 键——W1/W3 的 masterStatusLogic 断言读包根 config 无注入
 * 面（计划裁定保持最小不加参数）；若开发机将启用 autonomy，跑本测试前先读本条。
 *
 * 与计划原文的偏差（源码优先，见 plans/0923_autonomy_suite_v2_impl.md）：
 * 空盘面第二帧的 wake-gate reason 实际为 "record-only" 而非 "no-meaningful-change"——
 * frontier.ts:281 的 ④⑥⑧ no-carrier 常量（RECORD_ONLY_NOCARRIER）每帧输出，recordOnly 恒非空，
 * 规则 2（triggers 与 recordOnly 全空）在 collect 路径不可达（A11.1 实测 recordonly=3）。
 * 本测试按实际源码行为断言。
 *
 * 运行：npx tsx extensions/_test_autonomy_wiring.ts
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 测试隔离：defaultRuntimeDir() 全部走 temp（_test_runtime_autonomy 同款模式）。
// PI_RUNTIME_DIR 在各场景块内重设——各 runtime 函数按调用时读 env，逐块重设安全。
import { masterAddress, workstreamAddress } from "./runtime/address.ts";
import { newEnvelopeId } from "./runtime/ids.ts";
import { attachMaster, setCutover } from "./runtime/registry.ts";
import { deliverLetter, listLetters } from "./runtime/mailbox.ts";
import { newMessageFrame } from "./runtime/protocol.ts";
import { createWorkstream } from "./runtime/workstreams.ts";
import { evaluateWakes } from "./runtime/wake.ts";
import { masterStatusLogic } from "./master-tools.ts";
import { readAutonomyConfig } from "./runtime/autonomy/config.ts";
import {
	clearKillSwitch,
	engageKillSwitch,
	evaluateAutonomyGating,
	readKillSwitch,
} from "./runtime/autonomy/kill-switch.ts";
import {
	appendAuditEvent,
	readAuditTail,
	readFrontierSnapshot,
	readWakeGateState,
	writeFrontierSnapshot,
	writeWakeGateState,
} from "./runtime/autonomy/collect.ts";
import { evaluateAutonomyWakeGate, maintainBatchAnchor } from "./runtime/autonomy/gate.ts";
import type { WakeGateState } from "./runtime/autonomy/wake-gate.ts";

// ── 微型 harness ─────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
function check(name: string, fn: () => void): void {
	try {
		fn();
		passed++;
		console.log(`  ✓ ${name}`);
	} catch (e) {
		failed++;
		console.error(`  ✗ ${name}`);
		console.error(`    ${String((e as Error)?.message ?? e)}`);
	}
}

// ── 共享夹具 ─────────────────────────────────────────────────────────
const CFG_ROOT = mkdtempSync(join(tmpdir(), "autonomy-wiring-cfg-"));
// no-key config（R10：W1 显式注入，不依赖包根 config.json 现状）
const cfgOff = join(CFG_ROOT, "off.json");
writeFileSync(cfgOff, JSON.stringify({ masterSuccession: { auto: true } }), "utf8");
// enabled config
const cfgOn = join(CFG_ROOT, "on.json");
writeFileSync(cfgOn, JSON.stringify({ autonomy: { enabled: true } }), "utf8");

interface Rt {
	root: string;
	state: string;
	mailbox: string;
	runs: string;
	agent: string;
}
function freshRuntime(label: string): Rt {
	const root = mkdtempSync(join(tmpdir(), `autonomy-wiring-${label}-`));
	const agent = join(root, "agent");
	mkdirSync(agent, { recursive: true }); // 空 agentDir：frontier 空盘面（A11.1 先例 recordonly=3）
	process.env.PI_RUNTIME_DIR = root;
	return { root, state: join(root, "state"), mailbox: join(root, "mailbox"), runs: join(root, "tab-runs"), agent };
}
function wsLetter(wsId: string, subject: string, atMs: number, summary = "do the thing") {
	return newMessageFrame({
		id: newEnvelopeId("msg"), kind: "REPORT", from: "agent://a", to: workstreamAddress(wsId),
		subject, sentAt: new Date(atMs).toISOString(), summary, details: { tabRunId: "t", status: "completed" },
	});
}
function countAudit(rt: Rt, pred: (l: string) => boolean): number {
	return readAuditTail({ stateDir: rt.state, limit: 1000 }).filter(pred).length;
}
const T0 = 1_760_000_000_000; // 固定时钟（A11.1 同款）

// ════════════════════════════ W1 默认关闭端到端（硬约束）════════════════════
console.log("W1 默认关闭端到端（零行为变化）");
check("W1 evaluateWakes 无 enabled = 逐字节 no-op：fire 同构 + state/autonomy/ 零新文件 + 二次 tick 不变", () => {
	const rt = freshRuntime("w1");
	const T = T0;
	try {
		setCutover(true, "w1-test");
		attachMaster({ sessionId: "sess-W1" });
		const ws = createWorkstream({
			stateDir: rt.state, session: "sess-W1", mission: "W1 默认关流",
			wakePolicy: { enabled: true, cooldownMs: 60_000 },
		});
		deliverLetter(wsLetter(ws.id, "run://tab/tab_w1a", T - 5_000), { mailboxDir: rt.mailbox });
		// 首 tick：显式注入 no-key config（R10）
		const d1 = evaluateWakes({ stateDir: rt.state, mailboxDir: rt.mailbox, runsDir: rt.runs, sessionId: "sess-W1", now: T, autonomyConfigPath: cfgOff });
		assert.equal(d1.length, 1);
		assert.equal(d1[0].fire, true, "legacy fire 不被压制（无 enabled 即 no-op）");
		assert.equal(d1[0].letters.length, 1, "letters 同构");
		assert.ok(d1[0].prompt!.includes(ws.id) && d1[0].prompt!.includes("tab-finish") && d1[0].prompt!.includes("timer"), "prompt 与 legacy 同构");
		assert.equal(existsSync(join(rt.state, "autonomy")), false, "state/autonomy/ 无新文件（无 audit/frontier/wake-gate）");
		// 二次 tick：行为不变（新信 + 无 confirm 故无 cooldown）
		deliverLetter(wsLetter(ws.id, "run://tab/tab_w1b", T + 61_000), { mailboxDir: rt.mailbox });
		const d2 = evaluateWakes({ stateDir: rt.state, mailboxDir: rt.mailbox, runsDir: rt.runs, sessionId: "sess-W1", now: T + 62_000, autonomyConfigPath: cfgOff });
		assert.equal(d2.length, 1);
		assert.equal(d2[0].fire, true, "二次 tick 同样 fire（连续 tick 行为不变）");
		assert.equal(existsSync(join(rt.state, "autonomy")), false, "仍无 state/autonomy/");
	} finally {
		rmSync(rt.root, { recursive: true, force: true });
	}
});
check("W1b masterStatusLogic 纯净默认态无 autonomy 行（逐字节不变的前提）", () => {
	// 前提（R10）：包根 config.json 无 autonomy 键（本读无注入面，计划裁定不加参数）
	const rt = freshRuntime("w1b");
	try {
		setCutover(true, "w1b-test");
		attachMaster({ sessionId: "sess-W1b" });
		const out = masterStatusLogic(undefined, { cwd: rt.root });
		assert.ok(!out.text.includes("autonomy:"), `默认态 master-status 无 autonomy 行：\n${out.text}`);
	} finally {
		rmSync(rt.root, { recursive: true, force: true });
	}
});

// ════════════════════════════ W2 kill 演练五步（两层断言）════════════════════
console.log("W2 kill 演练（两层断言）");
{
	const rt = freshRuntime("w2");
	const T = T0;
	setCutover(true, "w2-test");
	attachMaster({ sessionId: "sess-W2" });
	const ws = createWorkstream({
		stateDir: rt.state, session: "sess-W2", mission: "W2 kill 演练流",
		wakePolicy: { enabled: true, cooldownMs: 60_000 },
	});
	deliverLetter(wsLetter(ws.id, "run://tab/tab_w2a", T - 5_000), { mailboxDir: rt.mailbox });

	check("W2.1 enabled 首帧：legacy fire 被门压制（接线生效；本层只断确定性不变量）", () => {
		// 复核事实 7：本层无法注入 agentDir → frontier 读真实 ~/.pi/agent（只读不写）；
		// 首帧（本 temp stateDir 无 frontier 基线）= baseline 帧 → 零触发（frontier.ts 首帧纪律）
		// → wake-gate 必 no-wake → 门压制。reason 字符串在 W2.3 gate 直调层断。
		const r = evaluateWakes({ stateDir: rt.state, mailboxDir: rt.mailbox, runsDir: rt.runs, sessionId: "sess-W2", now: T, autonomyConfigPath: cfgOn });
		assert.deepEqual(r, [], "enabled 首帧 legacy fire 被门压制（= 接线生效的直接证据）");
		assert.equal(listLetters(workstreamAddress(ws.id), "pending", rt.mailbox).length, 1, "信件保持 pending（门在 claim 之前短路，零动作）");
	});

	check("W2.2 kill：engage 形状/gating/gate 直调/evaluateWakes 仍 [] + 审计 per-reason 去重（30 次调用 1 行）", () => {
		assert.equal(engageKillSwitch({ reason: "drill", by: "test" }, { stateDir: rt.state }), true);
		const kill = readKillSwitch({ stateDir: rt.state });
		assert.ok(kill !== null && kill.version === 1 && kill.reason === "drill" && kill.by === "test" && kill.at.length > 0, "kill 文件形状合法");
		const cfg = readAutonomyConfig({ configPath: cfgOn });
		assert.deepEqual(evaluateAutonomyGating(cfg, kill), { active: false, reason: "kill-switch:drill" });
		// gate 直调：kill 先于 collect 短路（不触 agentDir，确定性）
		const g = evaluateAutonomyWakeGate({ stateDir: rt.state, configPath: cfgOn, agentDir: rt.agent, now: T + 1_000 });
		assert.deepEqual(g, { engaged: true, proceed: false, reason: "kill-switch:drill" });
		const r = evaluateWakes({ stateDir: rt.state, mailboxDir: rt.mailbox, runsDir: rt.runs, sessionId: "sess-W2", now: T + 2_000, autonomyConfigPath: cfgOn });
		assert.deepEqual(r, [], "kill 后 evaluateWakes 仍 []");
		const pred = (l: string): boolean => l.startsWith("ts=") && l.includes("cat=gating") && l.includes("kill-switch:drill");
		assert.equal(countAudit(rt, pred), 1, "首行 cat=gating kill-switch:drill 已落");
		for (let i = 0; i < 30; i++) {
			evaluateAutonomyWakeGate({ stateDir: rt.state, configPath: cfgOn, agentDir: rt.agent, now: T + 3_000 + i });
		}
		assert.equal(countAudit(rt, pred), 1, "30 次重复调用仍仅 1 行（per-reason 去重，防 30s tick 刷屏）");
	});

	check("W2.3 clear：gate 直调（temp agentDir 确定性）首帧/二帧 + wake-gate state 持久化往返", () => {
		assert.equal(clearKillSwitch({ stateDir: rt.state }), true);
		assert.equal(readKillSwitch({ stateDir: rt.state }), null, "kill 文件消失");
		const T2 = T + 10_000;
		const g1 = evaluateAutonomyWakeGate({ stateDir: rt.state, configPath: cfgOn, agentDir: rt.agent, now: T2 });
		assert.deepEqual(g1, { engaged: true, proceed: false, reason: "record-only" }, "空盘面帧 = record-only（复核事实 8）");
		const g2 = evaluateAutonomyWakeGate({ stateDir: rt.state, configPath: cfgOn, agentDir: rt.agent, now: T2 + 30_000 });
		// 与计划原文偏差（原预期 no-meaningful-change）：frontier.ts:281 no-carrier 常量每帧输出，
		// recordOnly 恒非空 → 规则 2 不可达，规则 3（record-only）先命中。见 impl 报告。
		assert.deepEqual(g2, { engaged: true, proceed: false, reason: "record-only" }, "二帧空盘面仍 record-only（源码行为）");
		const st = readWakeGateState({ stateDir: rt.state });
		assert.ok(st !== null, "wake-gate.json 持久化往返");
		assert.equal(st!.lastReason, "record-only");
		assert.equal(st!.lastDecisionAt, T2 + 30_000, "lastDecisionAt 每次评估更新");
		assert.equal(st!.batchFirstSeenAt, T, "锚点 = W2.1 首帧 now（本 stateDir 首个有 diff 帧）；非空不重覆不重置");
	});

	check("W2.4 原子性：autonomy 目录无 .tmp 残留（tmp+rename 语义）", () => {
		const tmps = readdirSync(join(rt.state, "autonomy")).filter((f) => f.endsWith(".tmp"));
		assert.deepEqual(tmps, [], "无 .tmp 残留");
	});

	check("W2.5 恢复：移除 autonomy 键 → evaluateWakes 立即恢复 legacy fire（关掉就回到原生）", () => {
		const r = evaluateWakes({ stateDir: rt.state, mailboxDir: rt.mailbox, runsDir: rt.runs, sessionId: "sess-W2", now: T + 120_000, autonomyConfigPath: cfgOff });
		assert.equal(r.length, 1);
		assert.equal(r[0].fire, true, "未 claim 的 pending 信随 legacy 链正常 fire（门完全旁路）");
	});

	rmSync(rt.root, { recursive: true, force: true });
}

// ════════════════════════════ W3 状态行谓词矩阵 ════════════════════════════
console.log("W3 状态行谓词矩阵 + never-throw");
check("W3 无足迹→无行；frontier/kill/wake-gate 足迹→行出现且字段正确；坏文件→行缺席不抛", () => {
	const rt = freshRuntime("w3");
	const T = T0;
	const isoT = new Date(T).toISOString().slice(0, 19);
	try {
		const run = (): string => masterStatusLogic(undefined, { cwd: rt.root }).text;
		// (a) 无足迹 → 无行（前提 R10：包根 config 无 autonomy 键）
		assert.ok(!run().includes("autonomy:"), "纯净默认态无 autonomy 行");
		// (b) frontier 快照 → 行出现且含 asof/projects
		writeFrontierSnapshot({ asof: T, projects: [], triggers: [], baseline: true }, { stateDir: rt.state });
		assert.ok(run().includes(`autonomy: enabled=off kill=off frontier=${isoT} (0 projects)`), `frontier 足迹行含 asof/projects：\n${run()}`);
		// (c) engage kill → 行含 kill=on(reason)
		engageKillSwitch({ reason: "w3-drill", by: "test" }, { stateDir: rt.state });
		assert.ok(run().includes("kill=on(w3-drill"), `kill 足迹行含 reason：\n${run()}`);
		// (d) wake-gate state → 行含 reason@ts
		writeWakeGateState({ lastDecisionAt: T, lastWakeAt: null, batchFirstSeenAt: null, lastReason: "record-only" }, { stateDir: rt.state });
		assert.ok(run().includes(`wake-gate=record-only @${isoT}`), `wake-gate 足迹行含判定：\n${run()}`);
		// (e) 全坏文件（容忍读 → null）→ 不抛；前提 R10 下行缺席
		writeFileSync(join(rt.state, "autonomy", "frontier.json"), "{corrupt", "utf8");
		writeFileSync(join(rt.state, "autonomy", "wake-gate.json"), "{corrupt", "utf8");
		unlinkSync(join(rt.state, "autonomy", "kill-switch.json"));
		let threw = false;
		let txt = "";
		try {
			txt = run();
		} catch {
			threw = true;
		}
		assert.equal(threw, false, "never-throw：坏文件不抛（master-status 不被打断）");
		assert.ok(!txt.includes("autonomy:"), `坏文件容忍读 → 无足迹 → 行缺席（前提 R10）：\n${txt}`);
	} finally {
		rmSync(rt.root, { recursive: true, force: true });
	}
});

// ════════════════════════════ W4 gate 单元矩阵 ════════════════════════════
console.log("W4 evaluateAutonomyWakeGate 单元矩阵（全注入）");
check("W4.1 disabled → 完全旁路 {engaged:false, proceed:true} + 零写盘", () => {
	const rt = freshRuntime("w4a");
	try {
		const g = evaluateAutonomyWakeGate({ stateDir: rt.state, configPath: cfgOff, agentDir: rt.agent, now: T0 });
		assert.deepEqual(g, { engaged: false, proceed: true, reason: "autonomy-disabled" });
		assert.equal(existsSync(join(rt.state, "autonomy")), false, "旁路零写盘（无 audit/frontier/wake-gate——D-H 张力裁决：无判定事件=零留痕）");
	} finally {
		rmSync(rt.root, { recursive: true, force: true });
	}
});
check("W4.2 enabled+kill → {engaged:true, proceed:false, kill-switch:<r>}（collect 前短路，确定性）", () => {
	const rt = freshRuntime("w4b");
	try {
		engageKillSwitch({ reason: "w4-kill", by: "test" }, { stateDir: rt.state });
		const g = evaluateAutonomyWakeGate({ stateDir: rt.state, configPath: cfgOn, agentDir: rt.agent, now: T0 });
		assert.deepEqual(g, { engaged: true, proceed: false, reason: "kill-switch:w4-kill" });
		assert.equal(existsSync(join(rt.state, "autonomy", "frontier.json")), false, "kill 短路不触 collect（无 frontier 写）");
		assert.equal(existsSync(join(rt.state, "autonomy", "wake-gate.json")), false, "kill 短路不评估 wake-gate（无 state 写）");
	} finally {
		rmSync(rt.root, { recursive: true, force: true });
	}
});
check("W4.3 enabled 无 kill 空盘面：首帧 record-only / 二帧 record-only（源码行为）+ 锚点维护 + state 往返", () => {
	const rt = freshRuntime("w4c");
	try {
		const g1 = evaluateAutonomyWakeGate({ stateDir: rt.state, configPath: cfgOn, agentDir: rt.agent, now: T0 });
		assert.deepEqual(g1, { engaged: true, proceed: false, reason: "record-only" }, "空盘面帧 record-only（A11.1 实测 recordonly=3，复核事实 8）");
		const s1 = readWakeGateState({ stateDir: rt.state });
		assert.ok(s1 !== null);
		assert.equal(s1!.batchFirstSeenAt, T0, "首个有 diff 帧锚点置 now");
		assert.equal(s1!.lastReason, "record-only");
		assert.equal(s1!.lastDecisionAt, T0);
		const g2 = evaluateAutonomyWakeGate({ stateDir: rt.state, configPath: cfgOn, agentDir: rt.agent, now: T0 + 30_000 });
		// 与计划原文偏差（原预期 no-meaningful-change）：recordOnly 恒非空（frontier.ts:281）
		assert.deepEqual(g2, { engaged: true, proceed: false, reason: "record-only" }, "二帧空盘面仍 record-only（源码行为）");
		const s2 = readWakeGateState({ stateDir: rt.state });
		assert.ok(s2 !== null);
		assert.equal(s2!.batchFirstSeenAt, T0, "二帧：recordOnly 非空 → 锚点保持不重置");
		assert.equal(s2!.lastDecisionAt, T0 + 30_000);
		assert.equal(s2!.lastReason, "record-only");
	} finally {
		rmSync(rt.root, { recursive: true, force: true });
	}
});
check("W4.4 maintainBatchAnchor 直测：diff 全空→重置 null；有 diff→置 now；既有锚点不覆写（生产路径 recordOnly 恒非空，重置分支休眠）", () => {
	const base: WakeGateState = { lastDecisionAt: null, lastWakeAt: null, batchFirstSeenAt: 111 };
	const reset = maintainBatchAnchor(base, { triggers: [], recordOnly: [], meaningfulChanges: 0 }, 999);
	assert.equal(reset.batchFirstSeenAt, null, "diff 全空 → 重置 null");
	const set = maintainBatchAnchor({ lastDecisionAt: null, lastWakeAt: null, batchFirstSeenAt: null }, { triggers: [], recordOnly: ["x"], meaningfulChanges: 0 }, 999);
	assert.equal(set.batchFirstSeenAt, 999, "有 diff（recordOnly）→ 置 now");
	const keep = maintainBatchAnchor(base, { triggers: [{ rule: "stagnation", project: "p", evidence: "e", approximate: false }], recordOnly: [], meaningfulChanges: 1 }, 999);
	assert.equal(keep.batchFirstSeenAt, 111, "既有锚点不覆写（批窗起点）");
});
// gate-error 分支：计划裁定不可动态触达（全部输入面 never-throw/容忍读）→ 静态审查项，不设运行时断言。

// ════════════════════════════ W5 审计行格式 ════════════════════════════
console.log("W5 appendAuditEvent 行格式 + never-throw");
check("W5 五字段行格式（ts/cat/concl/reason/acted=false）+ 换行消毒 + never-throw", () => {
	const rt = freshRuntime("w5");
	try {
		appendAuditEvent("wake", "no-wake", "record-only", rt.state);
		appendAuditEvent("gating", "pass", "gate-error:boom", rt.state);
		appendAuditEvent("kill", "engage", "drill reason x", rt.state);
		const lines = readAuditTail({ stateDir: rt.state, limit: 5 });
		assert.equal(lines.length, 3);
		for (const l of lines) {
			assert.match(l, /^ts=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z cat=(gating|wake|kill) concl=(engage|clear|wake|no-wake|pass) reason=.+ acted=false$/, `行格式：${l}`);
		}
		assert.ok(lines[0]!.includes("cat=wake concl=no-wake reason=record-only acted=false"));
		assert.ok(lines[2]!.includes("cat=kill concl=engage"));
		// 换行/制表消毒（保护行式格式）
		appendAuditEvent("gating", "pass", "multi\nline\treason", rt.state);
		const all = readAuditTail({ stateDir: rt.state, limit: 10 });
		assert.ok(!all.some((l) => l.includes("\n") || l.includes("\t")), "reason 换行/制表已消毒");
		assert.ok(all.some((l) => l.includes("reason=multi line reason")), "消毒后内容保留");
		// never-throw：stateDir 指向一个普通文件 → mkdir ENOTDIR → 收敛
		const blockPath = join(rt.state, "blockfile");
		writeFileSync(blockPath, "x", "utf8");
		let threw = false;
		try {
			appendAuditEvent("wake", "no-wake", "y", blockPath);
		} catch {
			threw = true;
		}
		assert.equal(threw, false, "never-throw：写失败不抛");
		assert.deepEqual(readAuditTail({ stateDir: blockPath }), [], "readAuditTail 不可读 → []");
	} finally {
		rmSync(rt.root, { recursive: true, force: true });
	}
});

// ════════════════════════════ W6 engaged 审计体积快照 ════════════════════════════
console.log("W6 engaged 模式 audit 体积快照（R5 文档化基线）");
check("W6 一次完整评估 = frontier 摘要 1 + watchdog 1 + cat=wake 恰 1；无 gating/kill 行；无 autonomy-disabled 杂行", () => {
	const rt = freshRuntime("w6");
	try {
		assert.equal(countAudit(rt, () => true), 0, "起点零审计（temp 新 stateDir）");
		evaluateAutonomyWakeGate({ stateDir: rt.state, configPath: cfgOn, agentDir: rt.agent, now: Date.now() });
		const lines = readAuditTail({ stateDir: rt.state, limit: 1000 });
		const cat = (re: RegExp): number => lines.filter((l) => re.test(l)).length;
		assert.equal(cat(/^frontier baseline=/), 1, "frontier 摘要恰 1 行");
		assert.equal(cat(/^frontier trigger rule=/), 0, "基线帧零 trigger 行");
		assert.equal(cat(/^watchdog (wake|no-wake) reason=/), 1, "watchdog 恰 1 行");
		assert.equal(cat(/^ts=.* cat=wake .* acted=false$/), 1, "cat=wake 判定行恰 1 行（每次判定留痕）");
		assert.equal(cat(/^ts=.* cat=(gating|kill) /), 0, "无 gating/kill 行（无 kill、无失败、无 gate-error）");
		assert.equal(cat(/gating no-wake reason=autonomy-disabled/), 0, "无 v1 格式 autonomy-disabled 杂行（configPath 透传后 collect 与 gate 同源——工程约束 3）");
		// 体积基线记录（R5：每 tick ≈ 3 行；无轮转，后续任务补）
		console.log(`    [W6] 单次评估审计行数 = ${lines.length}（frontier 1 + watchdog 1 + cat=wake 1）`);
		assert.equal(lines.length, 3, "单次评估恰 3 行（空盘面基线体积）");
	} finally {
		rmSync(rt.root, { recursive: true, force: true });
	}
});

// ── 清理 + 汇总 ─────────────────────────────────────────────────────
rmSync(CFG_ROOT, { recursive: true, force: true });
if (failed > 0) {
	console.error(`_test_autonomy_wiring: FAILED (${failed} failed / ${passed} passed)`);
	process.exit(1);
}
console.log(`_test_autonomy_wiring: all ${passed} checks passed`);
