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
	/**
	 * 2026-11-01：上一个 batch 的 diff 指纹（`diffFingerprint()` 产物）。
	 *
	 * 用途：让 `maintainBatchAnchor` 能区分「同一批变化仍在持续」与「换了一批新的」。
	 * 旧实现用 `batchFirstSeenAt ?? now` ⇒ 只在 null 时置一次，导致锚点永久卡死
	 * （真机实测卡 36.2 天）。现在指纹变了就重置锚点。
	 *
	 * optional：v1 测试构造的 state 不含此字段 ⇒ 首次见到时按「新一批」处理（安全默认）。
	 */
	lastDiffFingerprint?: string | null;
	/**
	 * 2026-11-01 阶段 2：逐 trigger 的去重账本 `dedupeKey → 上次唤醒时刻(ISO)`。
	 *
	 * ## 为什么需要它：现有两个节流阀在 30s tick 下全部失效
	 *
	 * - `debounceMs = 2s`：锚点年龄 ≥ 30s（一个 tick）⇒ **永远已过**
	 * - `ordinaryCooldownMs = 15s`：`lastDecisionAt` 是 30s 前 ⇒ **永远已过**
	 *
	 * 两个参数是按「秒级 tick」设计的，而生产 tick 是 **30 秒**（`mailbox-consumer.ts`
	 * 的 `setInterval(30_000)`）。尺度错配 ⇒ `decision.wake` 恒为 true
	 * （真机实测 `lastWakeAt === lastDecisionAt`）。
	 *
	 * 本账本提供**真正有效的**小时级去重：同一个 dedupeKey 在 `dedupeWindowMs` 内
	 * 只放行一次。它不改变「门该不该开」的语义，只是给「同一件事」加了一个
	 * 时间闸。
	 *
	 * 键的构成（`triggerDedupeKey()`）：`rule:project[:evidence]`。
	 * 不含 approximate：同一 (rule, project) 的 approximate 变化不足以算「新事件」。
	 */
	dedupe?: Record<string, string>;
}

export interface WakeGateDecision {
	wake: boolean;
	/** no-wake: autonomy-disabled | kill-switch:<r> | no-meaningful-change | record-only | approx-only | debounce | cooldown | all-deduped；wake: ordinary | bypass:<class> */
	reason: string;
	bypass: BypassClass | null;
	auditLine: string;
	/**
	 * 2026-11-01 阶段 2：本帧放行且**应当记入去重账本**的键。
	 * 调用方在 writeWakeGateState 时把它们写成 ISO 时间戳。
	 * 空数组 = 本帧无新键（不写）。
	 */
	dedupeKeysToRecord?: string[];
}

/**
 * 构造单条 trigger 的去重键。
 *
 * 键 = `rule:project`（+ `:evidence` 如果 evidence 是稳定标识）。
 * 为什么**不含** approximate：同一 (rule, project) 的 approximate 翻来翻去不足以
 * 算「新事件」；把它算进去会导致同一件事被反复当成新的。
 *
 * 为什么含 evidence：对 `ws_mail_backlog` 这类规则，`pending:1` → `pending:5`
 * 是真实的新情况（积压变多了），应当重新唤醒。但对 `blocked_overdue`，evidence 里含
 * `idleMin=211` 这类每帧都变的量 —— 所以 evidence 只在**无 runId 时**才入键。
 */
export function triggerDedupeKey(t: FrontierTrigger): string {
	const base = `${t.rule}:${t.project}`;
	// runId 存在 ⇒ evidence 里很可能含逐帧变化的量（idleMin=…），不入键
	if (t.runId) return base;
	return t.evidence ? `${base}:${t.evidence}` : base;
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
	/** test-only：去重窗（缺省 1h）。生产不传。 */
	dedupeWindowMs?: number;
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
	//
	// ⚠ 2026-11-01 实测：生产 tick 是 30s（mailbox-consumer 的 setInterval(30_000)），
	// 而 debounceMs 缺省 2s ⇒ 锚点年龄 ≥ 30s ⇒ **本分支永远不命中**。
	// 同理 cooldown(15s) 也永远不命中。两个节流阀在 30s tick 下全部失效，
	// 这就是 `decision.wake` 恒为 true 的直接成因。保留它们不删（未来若改小 tick 会再生效），
	// 真正有效的去重靠下面的 6.
	if (state.batchFirstSeenAt !== null && now - state.batchFirstSeenAt < cfg.debounceMs) return decide(false, "debounce", null);
	// 5. cooldown（§24，默认 15s）：ordinary 触发窗内继续聚合；bypass 直达（跳过 cooldown）
	const bypass = resolveBypass(diff.triggers);
	if (bypass === null && state.lastDecisionAt !== null && now - state.lastDecisionAt < cfg.ordinaryCooldownMs) {
		return decide(false, "cooldown", null);
	}

	// 6. **逐 trigger 去重（2026-11-01 阶段 2，真正有效的节流）**
	//
	// 尺度：`dedupeWindowMs` 缺省 1h。同一个 dedupeKey 在这个窗内只放行一次。
	// 为什么需要：上文 4/5 在 30s tick 下失效 ⇒ 同一批未处理的触发会**每 30 秒**
	// 重复唤醒。在没接 spawn 之前这无害（只污染审计），一旦接线就是刷屏事故。
	//
	// bypass 类（needs_user）**不受去重约束**："有人要我处理"是持续事实，
	// 但如果 1h 内已提过就不必再提 —— 仍然受去重约束，但窗口更短（bypassWindowMs）。
	// 目前统一用 dedupeWindowMs，不单独给 bypass 开口（避免两套语义）。
	const dedupeWindowMs = input.dedupeWindowMs ?? 60 * 60_000;
	const ledger = state.dedupe ?? {};
	const freshKeys: string[] = [];
	const seenKeys: string[] = [];
	for (const t of real) {
		const key = triggerDedupeKey(t);
		const last = ledger[key];
		const lastMs = typeof last === "string" ? Date.parse(last) : Number.NaN;
		if (Number.isFinite(lastMs) && now - lastMs < dedupeWindowMs) {
			seenKeys.push(key);
		} else {
			freshKeys.push(key);
		}
	}
	if (freshKeys.length === 0 && real.length > 0) {
		// 所有真触发都在去重窗内 ⇒ 本帧不唤醒（这才是真正的"同一件事不重复吵"）
		const d = decide(false, "all-deduped", null);
		return d;
	}

	const decision = decide(true, bypass ? `bypass:${bypass}` : "ordinary", bypass);
	// 只记**新键**：已去重的不刷新时间戳（否则永远出不了窗）
	decision.dedupeKeysToRecord = freshKeys;
	return decision;
}
