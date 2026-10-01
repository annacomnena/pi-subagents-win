/**
 * runtime/autonomy/action/policy.ts — 可回滚动作许可判定决策树（纯，设计 §1.2）。
 *
 * 分期计划 P1（plans/20261001_autonomy_actionable_plan.md）+ 设计文档
 * （plans/20261001_autonomy_actionable_design.md）§1.2 决策树的可执行形态。
 *
 * 语义纪律（与 wake 面相反）：动作面 **fail-closed**——任何 precheck 项 unknown / 读失败
 * 一律 DENY（区别于 kill-switch 的容忍读 kill-switch.ts:30）。未知即拒绝。
 *
 * 本模块**纯零 IO**：所有输入由编排层 run.ts 从 fail-closed 读装配后注入；本文件只做判定。
 * 预算/熔断数值（§2）为代码常量，**不可经 config 放大**（config 只允许收紧）。
 *
 * D4 裁定（2026-10-01，用户否决隔离路线）：本决策树对「派活」类第 2 层的 sandbox 判据
 * 已由 §6.3 许可检查表取代（见 gitguard.ts）；P1 只开 diagnostic-report 一类，本决策树
 * 对其余动作类（写文件 / git commit）原文继续有效。
 */

/** 动作类白名单（§4）：P1 = diagnostic-report；阶段二 + notify-local-master（两 class 并存）。 */
export const ACTION_CLASS_ALLOWLIST: ReadonlySet<string> = new Set(["diagnostic-report", "notify-local-master"]);

/** v1 trigger 白名单（§4：working_to_failed + stagnation；两个 approximate trigger 不动手）。 */
export const TRIGGER_ALLOWLIST: ReadonlySet<string> = new Set(["working_to_failed", "stagnation"]);

/**
 * 预算/熔断常量（设计 §2，试运行保守值；D6 固化；**硬编码不可经 config 放大**）。
 * P1 动作是本地文件事务（无 LLM 调用、无 tab）→ 单动作 token/时长预算按构造有界，
 * 以「诊断数据读取字节上限 + 墙钟上限」替代（§2 表末行）。
 */
export const BUDGET = {
	/** 每 tick 新动作上限（tick 基线 30s；1/tick 把单次误判爆炸半径钉死在单周期）。 */
	maxNewPerTick: 1,
	/** 全局在途动作（串行化 ⇒ 回退验证归因无歧义，独占租约才可判）。 */
	maxInFlight: 1,
	/** 滚动 1h 新动作（足够观察两个独立 incident，累积风险有界）。 */
	maxNewPerHour: 2,
	/** 同类连续失败停（按 trigger×class×project 三元组；1 次瞬时、2 次系统性）。 */
	consecFailLimit: 2,
	/** 滚动 1h 窗（毫秒）。 */
	hourMs: 3_600_000,
	/** 单动作诊断数据读取字节上限（P1 无 LLM；替代 token 预算）。 */
	maxReadBytes: 256 * 1024,
	/** 单动作墙钟上限（毫秒）。 */
	maxWallClockMs: 5_000,
	/** tick 基线（30s，scope 消费循环 mailbox-consumer.ts 30s interval）。 */
	tickMs: 30_000,
	/** frontier 快照越过 N 个 tick 视为陈旧（TOCTOU 复验 → SKIP(stale)）。 */
	staleTicks: 2,
} as const;

/** 触发引用（frontier 触发条目的许可相关投影）。 */
export interface TriggerRef {
	rule: string;
	project: string;
	evidence: string;
	approximate: boolean;
}

/**
 * 决策树 L0–L3 输入上下文（全部由 run.ts 从 fail-closed 读装配；unknown = false / 读失败标志）。
 * 逐字段对应 §1.2 各层判据：
 *  - L0 总门：actionsEnabled / killPresent / breakerReadable / breakerTripped / isOwner
 *  - L1 白名单：trigger × actionClass（双维度在册）+ 非 approximate
 *  - L2 可回滚四件套：closure / snapshot / rollback / postverify / lease（unknown 一律 false）
 *  - L3 预算熔断：inFlight / newThisTick / startedInLast1h / consecutiveFailures / dedupHit
 */
export interface PolicyContext {
	// ── L0 总门（全部 fail-closed 读；读不到 = 拒绝）──
	actionsEnabled: boolean;
	killPresent: boolean;
	breakerReadable: boolean;
	breakerTripped: boolean;
	isOwner: boolean;
	// ── L1 白名单（trigger × 动作类，双维度都要在册）──
	trigger: TriggerRef;
	actionClass: string;
	// ── L2 可回滚四要件（快照/句柄/验证 + 封闭 + 独占；unknown 一律 false → DENY）──
	closure: boolean;
	snapshot: boolean;
	rollback: boolean;
	postverify: boolean;
	lease: boolean;
	// ── L3 预算与熔断（数值见 BUDGET）──
	inFlight: number;
	newThisTick: number;
	startedInLast1h: number;
	consecutiveFailures: number;
	dedupHit: boolean;
}

export type PolicyVerdict =
	| { kind: "AUTO_EXEC" }
	| { kind: "SKIP"; reason: string }
	| { kind: "DENY"; reason: string }
	| { kind: "HUMAN"; reason: string };

/**
 * 许可判定决策树（纯；§1.2）。按 L0→L1→L2→L3 顺序短路；未知即拒绝（fail-closed）。
 * 返回 AUTO_EXEC | SKIP(reason) | DENY(reason) | HUMAN(reason)。
 *
 * 注意：HUMAN 仅作上层呈现，不是许可结果（§1.2 第 1 层注释）——P1 无 HUMAN 出口
 * （needs_user 等永久交人的 trigger 已在 TRIGGER_ALLOWLIST 外被 DENY 拦截）。
 */
export function decide(ctx: PolicyContext): PolicyVerdict {
	// ── L0 总门（fail-closed；读不到 = 拒绝）──
	if (!ctx.actionsEnabled) return { kind: "SKIP", reason: "actions-disabled" };
	if (ctx.killPresent) return { kind: "DENY", reason: "kill-engaged" };
	if (!ctx.breakerReadable) return { kind: "DENY", reason: "breaker-unreadable" };
	if (ctx.breakerTripped) return { kind: "DENY", reason: "breaker-tripped" };
	if (!ctx.isOwner) return { kind: "DENY", reason: "not-owner" };

	// ── L1 白名单（trigger × class 双维度在册；approximate 一律不动手）──
	if (!TRIGGER_ALLOWLIST.has(ctx.trigger.rule)) return { kind: "DENY", reason: "trigger-not-allowed" };
	if (!ACTION_CLASS_ALLOWLIST.has(ctx.actionClass)) return { kind: "DENY", reason: "class-not-allowed" };
	if (ctx.trigger.approximate) return { kind: "DENY", reason: "approximate-trigger" };

	// ── L2 可回滚四要件（任一 unknown/false → DENY；不「存疑放行」）──
	if (!ctx.closure) return { kind: "DENY", reason: "surface-open" };
	if (!ctx.snapshot) return { kind: "DENY", reason: "no-snapshot" };
	if (!ctx.rollback) return { kind: "DENY", reason: "no-rollback" };
	if (!ctx.postverify) return { kind: "DENY", reason: "no-postverify" };
	if (!ctx.lease) return { kind: "DENY", reason: "no-lease" };

	// ── L3 预算与熔断（in-flight / 每 tick / 1h / 连败 / 去重）──
	if (ctx.inFlight >= BUDGET.maxInFlight) return { kind: "DENY", reason: "budget-in-flight" };
	if (ctx.newThisTick >= BUDGET.maxNewPerTick) return { kind: "DENY", reason: "budget-new-per-tick" };
	if (ctx.startedInLast1h >= BUDGET.maxNewPerHour) return { kind: "DENY", reason: "budget-new-per-hour" };
	if (ctx.consecutiveFailures >= BUDGET.consecFailLimit) return { kind: "DENY", reason: "repeat-fail" };
	if (ctx.dedupHit) return { kind: "SKIP", reason: "cooldown" };

	return { kind: "AUTO_EXEC" };
}
