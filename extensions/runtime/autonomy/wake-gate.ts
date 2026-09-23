/**
 * runtime/autonomy/wake-gate.ts — Wake Gate（纯函数，零 IO，不 import node:fs）。
 *
 * Task 2002 · plans/0923_autonomy_suite_v1_plan.md（设计要点 c）。规格 §11/§24。
 *
 * 规则序（§24：debounce 2s / ordinary cooldown 15s / bypass 直达）：
 *   1. gating.active===false → 恒 no-wake，reason 取 gating.reason（autonomy-disabled | kill-switch:<r>）——最高门；
 *   2. 无触发且无 record-only → no-wake no-meaningful-change；
 *   3. 只有 record-only → no-wake record-only；只有 approximate 触发 → no-wake approx-only（近似触发 v1 不唤醒，只记录）；
 *   4. debounce：now - batchFirstSeenAt < debounceMs → no-wake debounce（bypass 同样受其约束）；
 *   5. cooldown：now - lastDecisionAt < ordinaryCooldownMs 且触发全为 ordinary → no-wake cooldown；
 *   6. bypass 类直达 → 跳过 cooldown（仍受 gating 与 debounce 约束）→ wake bypass=<class>。
 *
 * bypass 四类（BypassClass）：
 *   live（v1）：needs_user（规则⑤非 approx）；urgent_escalation（规则⑦非 approx 时——v1 的 ⑦ 恒 approx，
 *               故该分支结构 live、数据 dormant）；
 *   dormant：high_risk_failure（无 risk 载体；v1 一切 failed 触发按 ordinary 处理，不冒充 high-risk）、
 *            critical_resource_loss（无载体）。dormant 类保留在类型中，测试 A7 显式断言"永不匹配"。
 *
 * 审计行由纯函数**返回**（格式对齐 wake.ts 审计风格：`wake-gate <wake|no-wake> reason=<...>`），
 * 写盘由装配层执行（wake.ts 审计分离先例；等价红线条款 10 gate 链纪律复用）。
 * 入参含 gating：gating.active===false 时恒 {wake:false}——纯函数层与装配层双保险（红线条款 2）。
 */
import type { AutonomyConfig } from "./config.ts";
import type { FrontierDiff, FrontierTrigger } from "./frontier.ts";

export type BypassClass = "needs_user" | "urgent_escalation" | "high_risk_failure" | "critical_resource_loss";

export interface WakeGateState {
	lastDecisionAt: number | null;
	lastWakeAt: number | null;
	/** 调用层在首个触发出现时刻写入 state（debounce 窗锚点；v1 由 L2 装配层维护）。 */
	batchFirstSeenAt: number | null;
	/** v2（Task 2006 D-G）：最近一次 wake-gate 判定 reason（展示用；optional——v1 测试构造的 state 不含此字段，不受影响）。 */
	lastReason?: string | null;
}

export interface WakeGateDecision {
	wake: boolean;
	/** no-wake: autonomy-disabled | kill-switch:<r> | no-meaningful-change | record-only | approx-only | debounce | cooldown；wake: ordinary | bypass:<class> */
	reason: string;
	bypass: BypassClass | null;
	auditLine: string;
}

/** bypass 类解析（纯）：approx 触发永不升级 bypass（v1 近似只记录）。 */
function resolveBypass(triggers: FrontierTrigger[]): BypassClass | null {
	for (const t of triggers) {
		if (t.approximate) continue;
		if (t.rule === "needs_user") return "needs_user";
		// v1 的 ⑦ 恒 approx → 此分支数据 dormant（未来真载体出现即 live）
		if (t.rule === "deadline_urgency") return "urgent_escalation";
		// high_risk_failure：无 risk 载体，永不匹配（v1 红线：failed 触发按 ordinary）
		// critical_resource_loss：无载体，永不匹配
	}
	return null;
}

export function evaluateWakeGate(input: {
	gating: { active: boolean; reason: string };
	diff: FrontierDiff;
	state: WakeGateState;
	cfg: AutonomyConfig["wakeGate"];
	now: number;
}): WakeGateDecision {
	const { gating, diff, state, cfg, now } = input;
	const decide = (wake: boolean, reason: string, bypass: BypassClass | null): WakeGateDecision => ({
		wake,
		reason,
		bypass,
		auditLine: wake
			? bypass
				? `wake-gate wake bypass=${bypass}`
				: "wake-gate wake reason=ordinary"
			: `wake-gate no-wake reason=${reason}`,
	});

	// 1. 总门（最高优先级）：kill / autonomy-disabled 恒 no-wake
	if (!gating.active) return decide(false, gating.reason, null);

	const real = diff.triggers.filter((t) => !t.approximate);
	// 2. 无任何变化
	if (diff.triggers.length === 0 && diff.recordOnly.length === 0) return decide(false, "no-meaningful-change", null);
	// 3. 只有 record-only / 只有 approximate → 不唤醒，只记录
	if (diff.triggers.length === 0) return decide(false, "record-only", null);
	if (real.length === 0) return decide(false, "approx-only", null);
	// 4. debounce（§24，默认 2s）：短促连续变化聚合（bypass 同样受其约束）
	if (state.batchFirstSeenAt !== null && now - state.batchFirstSeenAt < cfg.debounceMs) return decide(false, "debounce", null);
	// 5. cooldown（§24，默认 15s）：ordinary 触发窗内继续聚合；bypass 直达（跳过 cooldown）
	const bypass = resolveBypass(diff.triggers);
	if (bypass === null && state.lastDecisionAt !== null && now - state.lastDecisionAt < cfg.ordinaryCooldownMs) {
		return decide(false, "cooldown", null);
	}
	return decide(true, bypass ? `bypass:${bypass}` : "ordinary", bypass);
}
