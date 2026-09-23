/**
 * runtime/autonomy/watchdog.ts — Watchdog 廉价检查 + cadence plan 校验（纯函数，零 IO，不 import node:fs）。
 *
 * Task 2002 · plans/0923_autonomy_suite_v1_plan.md（设计要点 e）。规格 §12.2 / §14 / §16。
 *
 * §12.2 检查清单 = 规格原文 8 问（任务书写"七项"系计数偏差，本计划按规格 8 项实现，测试 A8 固化清单）：
 *   1 unhandled frontier diff（实做，装配层直传）
 *   2 mailbox backlog（实做，master 地址 pending > 0）
 *   3 pending request timeout（**恒 unknown**：无 pending-request 账本，不猜——红线条款 9）
 *   4 stalled project（实做，frontier.stagnation=true 的项目）
 *   5 ready work + idle owner（**approx**：无 turn 状态载体；true 判定带 approx=no-turn-state 标注）
 *   6 run state != process state（实做，TabDetail.pidAlive===false 且非终态，装配层从 details 取）
 *   7 heartbeat too old（实做；heartbeatAgeMs=null = no-liveness → **unknown**，no-decision 对齐 local-master-claim 先例）
 *   8 state projection inconsistent（**恒 unknown**：未来载体 = replayEquivalenceDiff（state-store.ts），v1 不接）
 *
 * wakeRecommended = 任一 status==="true"；**unknown 不算 true 也不算 false**；
 * "全部为 false 才不唤醒"只对已评测项声明，审计行单独列 `unknown=<names>` 诚实报告未评测项。
 * gating.active===false → 整体短路（checks 全 unknown、wakeRecommended=false，审计行带 gating reason）。
 *
 * validateWatchdogPlan（§14/§16）：只做区间钳制（[min,max]）与有效期封顶（maxOverrideDuration），
 * 不执行调度（v1 无执行端，到期回 default 由调用层裁决）；垃圾/缺字段/缺 reason → ok:false 回默认。
 */
import type { AutonomyConfig } from "./config.ts";

export type CheckState = "true" | "false" | "unknown";

export interface CheckStatus {
	status: CheckState;
	reason: string;
}

/**
 * 独立常量（C8）：master 心跳陈旧判据。语义对齐 local-master stale 10min 判据，但本模块独立定义——
 * 与 watchdog 10m tick 周期（defaultIntervalMs）及 registry/scope 侧冻结判据互不引用。
 */
export const WATCHDOG_HEARTBEAT_STALE_MS = 10 * 60_000;

/** §12.2 的 8 项检查名（测试 A8 固化清单：长度 8，逐名断言）。 */
export const CHECK_NAMES: string[] = [
	"unhandled_frontier_diff",
	"mailbox_backlog",
	"pending_request_timeout",
	"stalled_project",
	"ready_work_idle_owner",
	"run_state_mismatch",
	"heartbeat_too_old",
	"state_projection_inconsistent",
];

export interface WatchdogInputs {
	gating: { active: boolean; reason: string };
	/** 装配层 = 存在未决策的真触发（v1 无 L2 决策状态，= 本帧 diff 含非 approx 触发）。 */
	unhandledFrontierDiff: boolean;
	/** master 地址 pending 合计（mailboxBacklog 只读计数）。 */
	mailboxBacklogPending: number;
	/** frontier.stagnation=true 的项目。 */
	stalledProjects: string[];
	/** ready = 触发①（approx 载体）；idle 为近似（无 turn 状态载体，v1 恒 false）。 */
	readyWork: boolean;
	idleOwnerApprox: boolean;
	/** TabDetail.pidAlive===false 且非终态（visible zombie）。 */
	runStateMismatch: { runId: string; phase: string; pidAlive: false }[];
	/** readLiveness updatedAt 年龄；null = no-liveness → unknown（不猜）。 */
	heartbeatAgeMs: number | null;
}

export interface WatchdogReport {
	wakeRecommended: boolean;
	checks: Record<string, CheckStatus>;
	auditLine: string;
}

/** 8 项三态检查（纯）。审计行格式：`watchdog <wake|no-wake> reason=<...> [unknown=<names>]`。 */
export function evaluateWatchdogChecks(inputs: WatchdogInputs): WatchdogReport {
	// 总门短路：kill / autonomy-disabled → 全部检查未评测（unknown），恒不唤醒（红线条款 2）
	if (!inputs.gating.active) {
		const checks: Record<string, CheckStatus> = {};
		for (const n of CHECK_NAMES) checks[n] = { status: "unknown", reason: `gating-inactive:${inputs.gating.reason}` };
		return {
			wakeRecommended: false,
			checks,
			auditLine: `watchdog no-wake reason=${inputs.gating.reason} unknown=${CHECK_NAMES.join(",")}`,
		};
	}

	const checks: Record<string, CheckStatus> = {
		unhandled_frontier_diff: inputs.unhandledFrontierDiff
			? { status: "true", reason: "unhandled real trigger" }
			: { status: "false", reason: "no unhandled trigger" },
		mailbox_backlog:
			inputs.mailboxBacklogPending > 0
				? { status: "true", reason: `master pending=${inputs.mailboxBacklogPending}` }
				: { status: "false", reason: "master pending=0" },
		// 3：无 pending-request 账本（v1 无载体）→ 恒 unknown（不猜）
		pending_request_timeout: { status: "unknown", reason: "no-carrier(v1)" },
		stalled_project:
			inputs.stalledProjects.length > 0
				? { status: "true", reason: `stalled=[${inputs.stalledProjects.join(",")}]` }
				: { status: "false", reason: "no stalled project" },
		// 5：approx（无 turn 状态载体）；true 判定带 approx 标注
		ready_work_idle_owner:
			inputs.readyWork && inputs.idleOwnerApprox
				? { status: "true", reason: "approx=no-turn-state" }
				: { status: "false", reason: "ready/idle not both true (idle approx, no carrier)" },
		run_state_mismatch:
			inputs.runStateMismatch.length > 0
				? { status: "true", reason: `mismatch=[${inputs.runStateMismatch.map((m) => m.runId).join(",")}]` }
				: { status: "false", reason: "no mismatch" },
		// 7：null = no-liveness → unknown（no-decision，对齐 local-master-claim "liveness 不猜"）
		heartbeat_too_old:
			inputs.heartbeatAgeMs === null
				? { status: "unknown", reason: "no-liveness" }
				: inputs.heartbeatAgeMs > WATCHDOG_HEARTBEAT_STALE_MS
					? { status: "true", reason: `age=${inputs.heartbeatAgeMs}ms>threshold=${WATCHDOG_HEARTBEAT_STALE_MS}ms` }
					: { status: "false", reason: `age=${inputs.heartbeatAgeMs}ms<=threshold=${WATCHDOG_HEARTBEAT_STALE_MS}ms` },
		// 8：未来载体 = replayEquivalenceDiff（state-store.ts）；v1 不接 → 恒 unknown
		state_projection_inconsistent: { status: "unknown", reason: "no-carrier(v1)" },
	};

	const trues = CHECK_NAMES.filter((n) => checks[n].status === "true");
	const unknowns = CHECK_NAMES.filter((n) => checks[n].status === "unknown");
	const wake = trues.length > 0;
	const unknownPart = unknowns.length > 0 ? ` unknown=${unknowns.join(",")}` : "";
	const auditLine = wake ? `watchdog wake reason=${trues.join(",")}${unknownPart}` : `watchdog no-wake reason=no-issue${unknownPart}`;
	return { wakeRecommended: wake, checks, auditLine };
}

export interface WatchdogPlan {
	intervalMs: number;
	validForMs: number;
	reason: string;
}

/**
 * duration 解析（纯）：number（ms）或 "10m"/"1h"/"30s"/"500ms"/"2d"（规格 §14 的 yaml 即 m/h 字符串）。
 * 非法/≤0/非有限 → null。
 */
export function parseDurationMs(v: unknown): number | null {
	if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
	if (typeof v === "string") {
		const m = v.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/);
		if (!m) return null;
		const units: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
		const out = parseFloat(m[1]) * units[m[2]];
		return Number.isFinite(out) && out > 0 ? out : null;
	}
	return null;
}

/**
 * cadence plan 校验（§14/§16，纯）：只做区间钳制 + 有效期封顶，不执行调度。
 *   - 垃圾/缺字段 → ok:false（plan:null，fallbackReason 供装配层回默认并审计）；
 *   - 缺/空 reason → 拒绝（missing-reason）；
 *   - interval 钳到 [minIntervalMs, maxIntervalMs]；validFor 封顶 maxOverrideDurationMs；
 *   - 输入键兼容 camelCase（intervalMs/validForMs）与规格原文 snake/短键（interval/valid_for）。
 * now 为未来"带 issuedAt 形状"的有效期裁决保留（v1 plan 无时间戳，未使用）。
 */
export function validateWatchdogPlan(
	plan: unknown,
	policy: AutonomyConfig["watchdog"],
	now: number,
): { ok: boolean; plan: WatchdogPlan | null; fallbackReason?: string } {
	void now; // v1：plan 无 issuedAt/expiresAt；有效期由 validForMs 声明，到期回 default 由调用层裁决
	if (typeof plan !== "object" || plan === null) return { ok: false, plan: null, fallbackReason: "invalid-plan" };
	const o = plan as Record<string, unknown>;
	const reason = typeof o.reason === "string" && o.reason.trim() ? o.reason : null;
	if (!reason) return { ok: false, plan: null, fallbackReason: "missing-reason" };
	const intervalMs = parseDurationMs(o.intervalMs ?? o.interval);
	if (intervalMs === null) return { ok: false, plan: null, fallbackReason: "invalid-interval" };
	const validForMs = parseDurationMs(o.validForMs ?? o.valid_for ?? o.validFor);
	if (validForMs === null) return { ok: false, plan: null, fallbackReason: "invalid-valid-for" };
	return {
		ok: true,
		plan: {
			intervalMs: Math.min(Math.max(intervalMs, policy.minIntervalMs), policy.maxIntervalMs),
			validForMs: Math.min(validForMs, policy.maxOverrideDurationMs),
			reason: reason.trim(),
		},
	};
}
