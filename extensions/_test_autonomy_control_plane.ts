/**
 * _test_autonomy_control_plane.ts — S0.2 自主控制面状态测试
 *
 * 覆盖目标（每一条都对应一个「会被误判成正常」的真实形状）：
 *   ① 六态各自可达（R-20：写进规则的状态必须**真的能演示**）
 *   ② 「第一个失败的门」语义：owner 挂与 cutover 挂必须产出不同结论
 *      （否则诊断会指向错误的修法）
 *   ③ 三载体分离：snapshot 每 tick 覆盖 / metrics 累加 / audit **只边沿写**
 *      （防「每 tick 一条审计」在 cutover 连关几天时刷上万条）
 *   ④ NOT_SCHEDULED 是**观测侧推断**（快照超龄），不是 tick 自证
 *   ⑤ 展示文案必须带「随 state/ 清理丢失」限定语（R-26：不得冒充审计证据）
 *   ⑥ never-throw：坏 JSON / 只读目录不得抛
 *
 * 跑法：npm run test:autonomy-control-plane
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
	deriveOutcome,
	recordControlPlane,
	readControlPlane,
	controlPlaneLine,
	inferNotScheduled,
	controlPlanePaths,
	VOLATILE_NOTE,
	NOT_SCHEDULED_TICK_MULTIPLE,
} = await import("./runtime/autonomy/control-plane.ts");

let checks = 0;
function ok(cond: unknown, msg: string) {
	assert.ok(cond, msg);
	checks++;
}
function eq(actual: unknown, expected: unknown, msg: string) {
	assert.equal(actual, expected, msg);
	checks++;
}

const tmp = mkdtempSync(join(tmpdir(), "cp-test-"));
const stateDir = join(tmp, "state");

// ── ① 六态：deriveOutcome 纯函数穷举 ────────────────────────────────────
{
	// GATED（不是 DISABLED）：owner 门先挂
	const a = deriveOutcome([
		{ stage: "subagent", passed: true, reason: "not-subagent" },
		{ stage: "owner", passed: false, reason: "not-owner (owner=01a2070a-fbf2)" },
	]);
	eq(a.outcome, "GATED", "① owner 挂 ⇒ GATED");
	eq(a.firstFailedGate, "owner", "① 第一个失败门 = owner");

	// GATED（cutover）
	const b = deriveOutcome([
		{ stage: "owner", passed: true, reason: "owner" },
		{ stage: "cutover", passed: false, reason: "cutover-disabled" },
	]);
	eq(b.outcome, "GATED", "① cutover 挂 ⇒ GATED");
	eq(b.firstFailedGate, "cutover", "① 第一个失败门 = cutover");

	// DISABLED：autonomy 门显式关闭
	const c = deriveOutcome([
		{ stage: "owner", passed: true, reason: "owner" },
		{ stage: "cutover", passed: true, reason: "ok" },
		{ stage: "autonomy", passed: false, reason: "autonomy-disabled" },
	]);
	eq(c.outcome, "DISABLED", "① autonomy-disabled ⇒ DISABLED（不是 GATED）");

	// OBSERVATION_FAILED：全过但读不到 frontier
	const d = deriveOutcome(
		[
			{ stage: "owner", passed: true, reason: "owner" },
			{ stage: "cutover", passed: true, reason: "ok" },
			{ stage: "autonomy", passed: true, reason: "ok" },
			{ stage: "actions", passed: true, reason: "ok" },
		],
		{ note: "no-frontier-snapshot" },
	);
	eq(d.outcome, "OBSERVATION_FAILED", "① 无 frontier 快照 ⇒ OBSERVATION_FAILED");

	// INSUFFICIENT_EVIDENCE：有 trigger 但零启动
	const e = deriveOutcome(
		[
			{ stage: "owner", passed: true, reason: "owner" },
			{ stage: "cutover", passed: true, reason: "ok" },
		],
		{ triggers: 3, started: 0 },
	);
	eq(e.outcome, "INSUFFICIENT_EVIDENCE", "① 有 trigger 零启动 ⇒ INSUFFICIENT_EVIDENCE");

	// NO_ACTION_NEEDED：全过且无 trigger
	const f = deriveOutcome(
		[
			{ stage: "owner", passed: true, reason: "owner" },
			{ stage: "cutover", passed: true, reason: "ok" },
		],
		{ triggers: 0, started: 0 },
	);
	eq(f.outcome, "NO_ACTION_NEEDED", "① 无 trigger ⇒ NO_ACTION_NEEDED");

	// 六态齐了？（NOT_SCHEDULED **不能**由 deriveOutcome 产出：
	// tick 函数内部无法证明自己没被调用 ⇒ 它只能由观测侧 inferNotScheduled 推断，见 ④）
	const all = new Set([a.outcome, b.outcome, c.outcome, d.outcome, e.outcome, f.outcome]);
	eq(all.size, 5, `① deriveOutcome 可达 5 态：${[...all].join(",")}`);
	ok(!all.has("NOT_SCHEDULED" as never), "① NOT_SCHEDULED 不得由 tick 内产出（架构上属观测侧推断）");
}

// ── ② 门顺序：报「第一个」失败，不是最后一个 ──────────────────────────
{
	const r = deriveOutcome([
		{ stage: "subagent", passed: true, reason: "not-subagent" },
		{ stage: "owner", passed: false, reason: "no-session-id" },
		{ stage: "cutover", passed: false, reason: "cutover-disabled" },
		{ stage: "autonomy", passed: false, reason: "autonomy-disabled" },
	]);
	eq(r.firstFailedGate, "owner", "② 多门同时失败时报第一个（owner），不是 cutover/autonomy");
	eq(r.outcome, "GATED", "② 且 outcome=GATED（不被后面的 autonomy-disabled 抢成 DISABLED）");
}

// ── ③ 三载体分离 ───────────────────────────────────────────────────────
{
	const now = Date.UTC(2026, 10, 25, 12, 0, 0);
	const gated = (stage: "cutover" | "owner") => [
		{ stage: "subagent" as const, passed: true, reason: "not-subagent" },
		{ stage: "owner" as const, passed: stage !== "owner", reason: stage === "owner" ? "not-owner" : "owner" },
		{ stage: "cutover" as const, passed: stage !== "cutover", reason: stage === "cutover" ? "cutover-disabled" : "ok" },
	];

	recordControlPlane({ stateDir, sessionId: "s1", intervalMs: 30_000, gates: gated("cutover"), now });
	const snap1 = readControlPlane({ stateDir, now });
	eq(snap1.snapshot?.outcome, "GATED", "③ 首次记录 outcome=GATED");
	eq(snap1.metrics?.ticks, 1, "③ ticks=1");
	eq(snap1.metrics?.transitions, 1, "③ 首次也算一次 transition");

	// 同状态再记 5 次 ⇒ ticks 涨、transitions 不涨、audit 不新增
	for (let i = 1; i <= 5; i++) {
		recordControlPlane({ stateDir, sessionId: "s1", intervalMs: 30_000, gates: gated("cutover"), now: now + i * 30_000 });
	}
	const snap2 = readControlPlane({ stateDir, now: now + 5 * 30_000 });
	eq(snap2.metrics?.ticks, 6, "③ 累计 tick=6");
	eq(snap2.metrics?.transitions, 1, "③ 同状态 5 次不产生 transition（否则审计会被刷爆）");
	eq(snap2.metrics?.byFailedGate.cutover, 6, "③ byFailedGate.cutover=6（计数器，不是去重集合）");

	const auditPath = controlPlanePaths(stateDir).audit;
	const auditLines1 = existsSync(auditPath) ? readFileSync(auditPath, "utf8").trim().split("\n").filter(Boolean) : [];
	eq(auditLines1.length, 1, "③ 边沿审计只 1 行（6 次 tick 同状态）");

	// 状态变化（cutover → owner）⇒ transition+1、audit+1
	recordControlPlane({ stateDir, sessionId: "s1", intervalMs: 30_000, gates: gated("owner"), now: now + 6 * 30_000 });
	const snap3 = readControlPlane({ stateDir, now: now + 6 * 30_000 });
	eq(snap3.snapshot?.firstFailedGate, "owner", "③ 变化后 firstFailedGate=owner");
	eq(snap3.metrics?.transitions, 2, "③ transition=2");
	const auditLines2 = readFileSync(auditPath, "utf8").trim().split("\n").filter(Boolean);
	eq(auditLines2.length, 2, "③ 状态变化后审计 2 行");
	const lastAudit = JSON.parse(auditLines2[1]);
	eq(lastAudit.fromGate, "cutover", "③ 审计行记录 fromGate");
	eq(lastAudit.toGate, "owner", "③ 审计行记录 toGate");

	// snapshot 是覆盖式（不是追加）：文件只有一个对象
	const rawSnap = JSON.parse(readFileSync(controlPlanePaths(stateDir).snapshot, "utf8"));
	eq(rawSnap.outcome, "GATED", "③ snapshot 覆盖式写（最后一次状态）");
	eq(rawSnap.volatile, VOLATILE_NOTE, "③ snapshot 自带 volatile 限定语");
}

// ── ④ NOT_SCHEDULED 是观测侧推断 ───────────────────────────────────────
{
	const base = Date.UTC(2026, 10, 25, 13, 0, 0);
	const snap = { at: base, intervalMs: 30_000 };
	const fresh = inferNotScheduled(snap, base + 30_000);
	eq(fresh.notScheduled, false, "④ 一个 tick 内 ⇒ 未推断为没跑");
	eq(fresh.thresholdMs, 30_000 * NOT_SCHEDULED_TICK_MULTIPLE, "④ 阈值 = interval × 倍数");
	const stale = inferNotScheduled(snap, base + 30_000 * (NOT_SCHEDULED_TICK_MULTIPLE + 1));
	eq(stale.notScheduled, true, "④ 超过阈值 ⇒ 推断为周期没在跑");
	// 从未记录 ⇒ 不推断（「不知道」不等于「没跑」）
	const none = inferNotScheduled(null, base);
	eq(none.notScheduled, false, "④ 无快照时不推断为 NOT_SCHEDULED（不知道 ≠ 没跑）");
	// 非法 interval 回落 30s，不抛
	const bad = inferNotScheduled({ at: base, intervalMs: Number.NaN }, base + 120_000);
	ok(Number.isFinite(bad.thresholdMs), "④ 非法 interval 回落而非 NaN");
}

// ── ⑤ 展示文案：必须带限定语 + 年龄 ────────────────────────────────────
{
	const stateDir2 = join(tmp, "state2");
	const now = Date.UTC(2026, 10, 25, 14, 0, 0);
	// 先测「无记录」
	const empty = readControlPlane({ stateDir: stateDir2, now });
	const emptyLine = controlPlaneLine(empty);
	ok(emptyLine.includes("无记录"), `⑤ 无记录时文案说明原因：${emptyLine}`);

	recordControlPlane({
		stateDir: stateDir2,
		sessionId: "s2",
		intervalMs: 30_000,
		gates: [
			{ stage: "owner", passed: true, reason: "owner" },
			{ stage: "cutover", passed: false, reason: "cutover-disabled" },
		],
		now,
	});
	const reading = readControlPlane({ stateDir: stateDir2, now: now + 5_000 });
	const line = controlPlaneLine(reading);
	ok(line.includes("GATED"), `⑤ 文案含 outcome：${line}`);
	ok(line.includes("cutover"), `⑤ 文案含失败门：${line}`);
	ok(line.includes("cutover-disabled"), `⑤ 文案含门的具体原因（不二次概括）：${line}`);
	ok(line.includes("5s 前") || line.includes("s 前"), `⑤ 文案给年龄而非只有绝对时间：${line}`);
	ok(line.includes(VOLATILE_NOTE), `⑤ 文案带「随 state/ 清理丢失」限定语（R-26）：${line}`);
	ok(line.includes("不可作长期审计证据"), `⑤ 必须是否定语「不可作长期审计证据」，而不是回避「审计」二字：${line}`);

	// 超龄 ⇒ 显式提示周期可能没跑
	const staleReading = readControlPlane({ stateDir: stateDir2, now: now + 30_000 * 10 });
	const staleLine = controlPlaneLine(staleReading);
	ok(staleLine.includes("周期可能没在跑"), `⑤ 超龄时提示周期可能没跑：${staleLine}`);
}

// ── ⑥ never-throw ──────────────────────────────────────────────────────
{
	const stateDir3 = join(tmp, "state3");
	mkdirSync(join(stateDir3, "autonomy"), { recursive: true });
	writeFileSync(controlPlanePaths(stateDir3).snapshot, "{ this is not json", "utf8");
	// 坏 snapshot 不得让 record 抛；且应能重建
	let threw = false;
	try {
		recordControlPlane({
			stateDir: stateDir3,
			sessionId: "s3",
			intervalMs: 30_000,
			gates: [{ stage: "owner", passed: true, reason: "owner" }],
			now: Date.now(),
		});
	} catch {
		threw = true;
	}
	ok(!threw, "⑥ 坏 snapshot 不抛");
	const recovered = readControlPlane({ stateDir: stateDir3 });
	ok(recovered.snapshot !== null, "⑥ 坏文件被覆盖重建后仍可读");
	ok(recovered.metrics !== null, "⑥ metrics 可读");

	// 读不存在的目录不抛
	let threw2 = false;
	try {
		readControlPlane({ stateDir: join(tmp, "does-not-exist") });
	} catch {
		threw2 = true;
	}
	ok(!threw2, "⑥ 读不存在的 stateDir 不抛");
}

// ── ⑦ 接线：真实 evaluateWakes 必须真的把门观测报出来 ──────────────────
//
// 为什么单独一节：R-4 教训 —— 只变异函数体时，删掉「接线」（observe 传递）仍然全绿，
// 那是假绿。这一节走**真实** evaluateWakes 入口（不直接调 deriveOutcome）。
{
	const { evaluateWakes } = await import("./runtime/wake.ts");
	const rt = join(tmp, "rt-wiring");
	const prevEnv = process.env.PI_RUNTIME_DIR;
	process.env.PI_RUNTIME_DIR = rt;
	mkdirSync(join(rt, "registry", "attachments"), { recursive: true });

	try {
		// ⑦a 无 cutover ⇒ 必须报 cutover 门失败（不是静默 return []）
		const g1: Array<{ stage: string; passed: boolean; reason: string }> = [];
		evaluateWakes({
			sessionId: "sess-wiring",
			mailboxDir: join(rt, "mailbox"),
			stateDir: join(rt, "state"),
			observe: (o) => {
				if (o.gate) g1.push(o.gate);
			},
		});
		const cut = g1.find((g) => g.stage === "cutover");
		ok(cut !== undefined, `⑦a cutover 门必须被报告（实际收到：${JSON.stringify(g1)}）`);
		eq(cut?.passed, false, "⑦a 无 cutover ⇒ passed=false");
		eq(cut?.reason, "cutover-disabled", "⑦a reason 原文照拄");

		// ⑦b cutover 开但无 attachment ⇒ 必须报 owner 门失败
		writeFileSync(join(rt, "registry", "cutover.json"), JSON.stringify({ enabled: true }), "utf8");
		const g2: Array<{ stage: string; passed: boolean; reason: string }> = [];
		evaluateWakes({
			sessionId: "sess-wiring",
			mailboxDir: join(rt, "mailbox"),
			stateDir: join(rt, "state"),
			observe: (o) => {
				if (o.gate) g2.push(o.gate);
			},
		});
		eq(g2.find((g) => g.stage === "cutover")?.passed, true, "⑦b cutover 开后 cutover 门 passed=true");
		const own = g2.find((g) => g.stage === "owner");
		ok(own !== undefined, "⑦b owner 门必须被报告");
		eq(own?.passed, false, "⑦b 无 attachment ⇒ owner 门失败");
		eq(own?.reason, "wake-owner-mismatch", "⑦b reason 标明是 wake 侧的 owner 判定");

		// ⑦c attachment 与本会话一致 ⇒ owner 门通过，且能看到 autonomy 门
		writeFileSync(
			join(rt, "registry", "attachments", "agent___master_default.json"),
			JSON.stringify({
				agentAddress: "agent://master_default", // readAttachment 校验的是 agentAddress（不是 address）
				sessionId: "sess-wiring",
				generation: 1,
				attachedAt: new Date().toISOString(),
			}),
			"utf8",
		);
		const g3: Array<{ stage: string; passed: boolean; reason: string }> = [];
		evaluateWakes({
			sessionId: "sess-wiring",
			mailboxDir: join(rt, "mailbox"),
			stateDir: join(rt, "state"),
			observe: (o) => {
				if (o.gate) g3.push(o.gate);
			},
		});
		eq(g3.find((g) => g.stage === "owner")?.passed, true, "⑦c attachment 匹配 ⇒ owner 门通过");
		ok(g3.some((g) => g.stage === "autonomy"), "⑦c 过了 owner 门后必须能看到 autonomy 门（否则观测停在第二道）");

		// ⑦d 不传 observe = 零行为变化（不得因观测而抛）
		let threw = false;
		try {
			evaluateWakes({ sessionId: "sess-wiring", mailboxDir: join(rt, "mailbox"), stateDir: join(rt, "state") });
		} catch {
			threw = true;
		}
		ok(!threw, "⑦d 不传 observe 时不抛（向后兼容）");
	} finally {
		if (prevEnv === undefined) delete process.env.PI_RUNTIME_DIR;
		else process.env.PI_RUNTIME_DIR = prevEnv;
	}
}

// ── ⑧ 接线：registerWakeLoop 的 tick 必须真的记录控制面（杀「不传 observe」变异）──
//
// 为什么必须测这一层：⑦ 测的是 evaluateWakes 自己报不报门；而 tick 有没有把 observe
// 转进去、有没有在**所有提前 return 路径**上 flush，是另一个接线点。
// 不测它，删掉 observe 传递仍然全绿（R-4 假绿）。
{
	const { registerWakeLoop } = await import("./mailbox-consumer.ts");
	const rt2 = join(tmp, "mc-rt");
	const prevEnv = process.env.PI_RUNTIME_DIR;
	process.env.PI_RUNTIME_DIR = rt2;
	try {
		const handlers: Record<string, Array<(ev: unknown, ctx?: unknown) => void>> = {};
		const fakePi = {
			on: (ev: string, cb: (ev: unknown, ctx?: unknown) => void) => {
				(handlers[ev] ||= []).push(cb);
			},
		};
		const stateDir8 = join(rt2, "state");
		const stop = registerWakeLoop(fakePi as never, {
			spawn: () => "tab_fake",
			mailboxDir: join(rt2, "mailbox"),
			stateDir: stateDir8,
			runsDir: join(rt2, "tab-runs"),
			intervalMs: 20,
		});
		ok(typeof stop === "function", "⑧ registerWakeLoop 返回 stop（否则测试进程会被 fs.watch 拖住）");
		for (const cb of handlers["session_start"] ?? []) cb({}, { sessionManager: { sessionId: "sess-tick" } });
		await new Promise((r) => setTimeout(r, 150));
		stop();

		const rec = readControlPlane({ stateDir: stateDir8 });
		ok(rec.snapshot !== null, `⑧ tick 必须写出 control-plane.json（实际：${rec.snapshot === null ? "无" : "有"}）`);
		eq(rec.snapshot?.sessionId, "sess-tick", "⑧ snapshot 记录真实 sessionId");
		// 无 cutover ⇒ 必须是 GATED(cutover)。若 observe 没传进去，gates 只有
		// subagent+owner ⇒ 会被算成 NO_ACTION_NEEDED，断言就会红。
		eq(rec.snapshot?.outcome, "GATED", "⑧ 无 cutover ⇒ outcome=GATED（证明 observe 真的传进了 evaluateWakes）");
		eq(rec.snapshot?.firstFailedGate, "cutover", "⑧ firstFailedGate=cutover");
		ok(
			(rec.snapshot?.gates ?? []).some((g) => g.stage === "cutover"),
			`⑧ gates 里必须有 cutover 门（实际：${JSON.stringify((rec.snapshot?.gates ?? []).map((g) => g.stage))}）`,
		);
		ok((rec.metrics?.ticks ?? 0) >= 1, "⑧ metrics 至少记到 1 个 tick");
	} finally {
		if (prevEnv === undefined) delete process.env.PI_RUNTIME_DIR;
		else process.env.PI_RUNTIME_DIR = prevEnv;
	}
}

console.log(`_test_autonomy_control_plane: ${checks} checks passed`);
