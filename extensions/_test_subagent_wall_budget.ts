/**
 * _test_subagent_wall_budget.ts — 墙钟总预算**纯判定层**的测试（C1，不接线）。
 *
 * 设计原则（独立计划审查 M13/M15）：
 * - **成对运行**：每条「已设且超期」的用例，都配一条「未设」或「未到期」的对照，
 *   断言前者到期、后者**不**到期 —— 否则「没触发/没扫到」也会假绿。
 * - **边界全覆盖**：undefined/null/NaN/Infinity/0/负数/非整数/超平台上限。
 * - **与 stall 语义分离**：断言「有输出/在活动」**不影响**墙钟判定（不看 pid、不看 lastActivity）。
 *
 * 运行：npm run test:subagent-wall-budget
 */

import assert from "node:assert/strict";
import {
	DEFAULT_SYNC_WALL_MS,
	resolveSyncWallBudget,
	detectWallBudget,
	formatRemainingBudget,
	parseWallBudget,
	remainingWallBudgetMs,
	MAX_TIMEOUT_MS,
} from "./subagent-wall-budget.ts";

let n = 0;
const ok = (name: string): void => {
	n += 1;
	console.log(`ok ${n} - ${name}`);
};

const T0 = Date.parse("2026-10-16T10:00:00Z");
const now = (offsetMs: number) => () => T0 + offsetMs;
const rec = (o: Record<string, unknown>) => ({ status: "running", startedAt: new Date(T0).toISOString(), ...o });

// ── P1：参数校验边界（审查 M13）────────────────────────────────────────
{
	assert.deepEqual(parseWallBudget(undefined), { enabled: false, segments: 1 }, "undefined ⇒ 不启用（非错误）");
	assert.deepEqual(parseWallBudget(null), { enabled: false, segments: 1 }, "null ⇒ 不启用");
	assert.equal(parseWallBudget(Number.NaN).reject, "not-finite", "NaN ⇒ 拒绝");
	assert.equal(parseWallBudget(Number.POSITIVE_INFINITY).reject, "not-finite", "Infinity ⇒ 拒绝");
	assert.equal(parseWallBudget("60000").reject, "not-a-number", "字符串数字**不隐式转换** ⇒ 拒绝");
	assert.equal(parseWallBudget(0).reject, "not-positive", "0 ⇒ 拒绝");
	assert.equal(parseWallBudget(-1).reject, "not-positive", "负数 ⇒ 拒绝");
	assert.equal(parseWallBudget(1.5).reject, "not-integer", "非整数 ⇒ 拒绝");
	assert.equal(parseWallBudget(60_000).enabled, true, "合法正数 ⇒ 启用");
	assert.equal(parseWallBudget(60_000).ms, 60_000, "规范化保留原值");
	const over = parseWallBudget(MAX_TIMEOUT_MS * 2 + 1);
	assert.equal(over.enabled, true, "超平台上限仍启用");
	assert.equal(over.segments, 3, "超上限 ⇒ 标记需分段调度（防 setTimeout 溢出）");
	ok("P1 参数校验：undefined/null/NaN/Inf/字符串/0/负/非整数/合法/超平台上限");
}

// ── P2：未启用 ⇒ 永不到期（逐字节保持既有行为的判定面）────────────────
{
	assert.equal(detectWallBudget(rec({}), { now: now(0) }).reason, "disabled", "未设 ⇒ disabled");
	assert.equal(detectWallBudget(rec({ maxWallMs: undefined }), { now: now(10 ** 9) }).expired, false, "未设 + 很久后 ⇒ 仍不到期");
	assert.equal(detectWallBudget(rec({ maxWallMs: Number.NaN }), { now: now(10 ** 9) }).expired, false, "非法值 ⇒ 不到期");
	ok("P2 未启用：undefined/非法值 ⇒ 永不到期（既有行为不变）");
}

// ── P3：**成对**——同一记录，未到期 vs 已到期（审查 M15 防假绿）────────
{
	const r = rec({ maxWallMs: 60_000 });
	const before = detectWallBudget(r, { now: now(59_999) });
	const after = detectWallBudget(r, { now: now(60_001) });
	assert.equal(before.expired, false, "59.999s（未到点）⇒ 不到期");
	assert.equal(before.reason, "not-yet");
	assert.ok(before.remainingMs !== undefined && before.remainingMs > 0, "剩余为正");
	assert.equal(after.expired, true, "60.001s（已到点）⇒ 到期");
	assert.equal(after.reason, "expired");
	assert.ok(after.remainingMs !== undefined && after.remainingMs < 0, "剩余为负");
	// 边界：恰好到点 ⇒ 视为到期（<=0）
	assert.equal(detectWallBudget(r, { now: now(60_000) }).expired, true, "恰好到点 ⇒ 到期（边界保守取到期）");
	ok("P3 成对判定：未到点 vs 已到点 vs 恰好到点（防「没触发也绿」）");
}

// ── P4：**不看 pid / 不看 lastActivity**（与僵尸语义分离，审查 M6）────
{
	// 进程活着 + 刚刚有活动 —— 超预算仍应到期（僵尸判定会因「活着」判 alive）
	const r = rec({ maxWallMs: 60_000, pid: process.pid, lastActivity: new Date(T0 + 60_000).toISOString() });
	const v = detectWallBudget(r, { now: now(120_000) });
	assert.equal(v.expired, true, "活进程 + 刚活动 ⇒ 仍到期（墙钟与 stall/pid 无关）");
	ok("P4 墙钟与僵尸/stall 分离：活进程有输出仍会超预算");
}

// ── P5：终态/幂等短路 ────────────────────────────────────────────────
{
	assert.equal(detectWallBudget(rec({ maxWallMs: 1000, status: "completed" }), { now: now(10 ** 6) }).reason, "not-running", "非 running ⇒ 不判");
	assert.equal(
		detectWallBudget(rec({ maxWallMs: 1000, result: { status: "completed" } }), { now: now(10 ** 6) }).reason,
		"already-terminal",
		"result 已终态 ⇒ 不判（双层终态）",
	);
	assert.equal(
		detectWallBudget(rec({ maxWallMs: 1000, wallBudgetExpiredAt: new Date(T0).toISOString() }), { now: now(10 ** 6) }).reason,
		"already-expired",
		"已处理过 ⇒ 幂等短路",
	);
	ok("P5 短路：非 running / result 已终态 / 已处理（幂等）");
}

// ── P6：时间基准（缺省 startedAt；不可随活动重置）──────────────────────
{
	assert.equal(detectWallBudget(rec({ maxWallMs: 1000, startedAt: undefined }), { now: now(10 ** 6) }).reason, "no-time-basis", "无 startedAt ⇒ 不判");
	assert.equal(detectWallBudget(rec({ maxWallMs: 1000, startedAt: "garbage" }), { now: now(10 ** 6) }).reason, "no-time-basis", "坏时间字段 ⇒ 不判");
	// wallClockBaseAt 覆盖（供 fallback 链用首个 spawn 时刻）
	const r = rec({ maxWallMs: 60_000, startedAt: new Date(T0 - 10 ** 6).toISOString(), wallClockBaseAt: new Date(T0).toISOString() });
	assert.equal(detectWallBudget(r, { now: now(30_000) }).expired, false, "有 wallClockBaseAt ⇒ 以它起算（不被更早的 startedAt 污染）");
	assert.equal(detectWallBudget(r, { now: now(70_000) }).expired, true, "超过 base+预算 ⇒ 到期");
	ok("P6 时间基准：缺省 startedAt / 坏值 / wallClockBaseAt 覆盖（fallback 链用）");
}

// ── P7：剩余预算显示（未启用 ⇒ undefined ⇒ 面板不加段）────────────────
{
	assert.equal(remainingWallBudgetMs(rec({}), { now: now(0) }), undefined, "未启用 ⇒ undefined（面板不得加空段）");
	assert.equal(formatRemainingBudget(rec({}), { now: now(0) }), undefined, "未启用 ⇒ 无文案");
	assert.equal(formatRemainingBudget(rec({ maxWallMs: 10 * 60_000 }), { now: now(60_000) }), "预算剩 9m", "9m 文案");
	assert.equal(formatRemainingBudget(rec({ maxWallMs: 3 * 3_600_000 }), { now: now(30 * 60_000) }), "预算剩 2h30m", "小时+分文案");
	assert.equal(formatRemainingBudget(rec({ maxWallMs: 1000 }), { now: now(5000) }), "已超预算", "过期文案");
	assert.equal(formatRemainingBudget(rec({ maxWallMs: 60_000 }), { now: now(30_000) }), "预算剩 <1m", "不足 1m 文案");
	ok("P7 面板投影：未启用 undefined（零空段）/ 分类文案");
}

console.log(`\n_test_subagent_wall_budget: all ${n} groups passed`);

// ── P9：同步派发默认墙钟（2026-10-24 事故回归）─────────────────────────
// 事故：async:false + 未传 maxWallMs + 持续输出但永不收敛的模型 ⇒ 主会话锁死 7h42m。
// stall 只能抓「没输出」，抓不住「一直在输出」；同步必须有墙钟上限。
{
	assert.equal(DEFAULT_SYNC_WALL_MS, 30 * 60_000, "P9 同步默认墙钟 = 30min");

	// ① 显式同步 + 未传 maxWallMs ⇒ 套默认，来源标注 sync-default
	assert.deepEqual(
		resolveSyncWallBudget({ async: false }),
		{ ms: DEFAULT_SYNC_WALL_MS, source: "sync-default" },
		"P9 async:false 且无 maxWallMs ⇒ 加 30min 墙钟（sync-default）",
	);

	// ② 显式同步 + 调用方传了 maxWallMs ⇒ **以调用方为准**（不改写）
	assert.deepEqual(
		resolveSyncWallBudget({ async: false, maxWallMs: 5_000 }),
		{ ms: 5_000, source: "param" },
		"P9 显式 maxWallMs 优先，同步不得改写调用方取值",
	);

	// ③ 异步（缺省 / true）⇒ 不加预算（逐字节保持既有行为）
	assert.deepEqual(resolveSyncWallBudget({}), {}, "P9 缺省（异步）⇒ 不加墙钟");
	assert.deepEqual(resolveSyncWallBudget({ async: true }), {}, "P9 async:true ⇒ 不加墙钟");

	// ④ 成对对照：确保①不是「任何输入都加预算」的假绿
	assert.notDeepEqual(
		resolveSyncWallBudget({ async: true }),
		resolveSyncWallBudget({ async: false }),
		"P9 成对对照：async:true 与 async:false 结果必须不同（否则判据无判别力）",
	);

	// ⑤ 非法 maxWallMs（NaN）仍原样透传，由 parseWallBudget 拒绝（不在此吞错）
	assert.deepEqual(
		resolveSyncWallBudget({ async: false, maxWallMs: Number.NaN }),
		{ ms: Number.NaN, source: "param" },
		"P9 非法 maxWallMs 原样透传（拒绝责任在 parseWallBudget）",
	);

	console.log(`ok ${n + 5} - P9 同步默认墙钟矩阵（5 条）`);
	n += 5;
}
