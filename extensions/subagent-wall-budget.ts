/**
 * subagent-wall-budget.ts — 墙钟总预算的**纯判定层**（不含 IO 副作用，可独立测试）。
 *
 * ## 为什么独立于 subagent-zombie.ts（独立计划审查 M6）
 * 审查明确指出：**「超预算」不是僵尸判定**——
 *   - 僵尸 = 进程**已死**（`pid` 不存活 / 被 OS 重用）；
 *   - 超预算 = 进程**可能仍活着**，只是自 spawn 起超过了调用方给的墙钟上限。
 * 两者语义不同、证据不同、处置不同（僵尸落 `failed(zombie)`；超预算落 `failed(wall_budget)`）。
 * ⇒ 不复用 `detectZombie`，也不继承它的最小年龄 / idle 门 / pid 存活前提。
 *
 * ## 与 `timeoutMs`（stall）的分工（口径写死，不许混）
 * - `timeoutMs` = **停顿超时**：子进程持续有输出就**重置**计时 ⇒ **不限制总时长**。
 * - `maxWallMs` = **墙钟总预算**：自 spawn 起算，**与是否有输出无关**，到点即终止。
 * - 两者可同时设置，**谁先到谁生效**。**未启用 `maxWallMs` 时，持续输出的活进程等待仍是无界的。**
 *
 * ## 纪律
 * - 默认 **undefined = 不启用**（逐字节保持既有行为）。
 * - 本模块只做**判定**与**参数校验**；kill / 写终态由调用方（runner / 看门狗）执行。
 */

/** 预算上限的合法范围：`setTimeout` 超过 2^31-1 ms 会**溢出成近立即触发** ⇒ 必须拒绝或分段。 */
export const MAX_TIMEOUT_MS = 2_147_483_647;

export type WallBudgetReject =
	| "not-a-number"
	| "not-finite"
	| "not-integer"
	| "not-positive"
	| "over-platform-limit";

export interface WallBudgetParse {
	/** 是否启用（合法正数有限整数）。 */
	enabled: boolean;
	/** 规范化后的毫秒数（仅 enabled 时有意义）。 */
	ms?: number;
	/** 被拒绝的原因（仅 !enabled 且调用方显式传了非法值时）。 */
	reject?: WallBudgetReject;
	/** 容忍的长延时分段（当 ms > MAX_TIMEOUT_MS 时给出段数；否则 1）。 */
	segments: number;
}

/**
 * 校验并规范化 `maxWallMs`（工具参数 / run json 字段共用）。
 *
 * 规则（审查 M13）：
 * - `undefined` / `null` ⇒ **不启用**（既有行为，**不算错误**）；
 * - 非有限数（NaN / Infinity / 字符串数字**不**隐式转换）⇒ 拒绝 + 原因；
 * - ≤ 0 或非整数 ⇒ 拒绝 + 原因；
 * - > `MAX_TIMEOUT_MS` ⇒ **仍启用**，但标记 `segments > 1`（调用方需分段调度，避免 setTimeout 溢出）。
 */
export function parseWallBudget(raw: unknown): WallBudgetParse {
	if (raw === undefined || raw === null) return { enabled: false, segments: 1 };
	if (typeof raw !== "number") return { enabled: false, reject: "not-a-number", segments: 1 };
	if (!Number.isFinite(raw)) return { enabled: false, reject: "not-finite", segments: 1 };
	if (!Number.isInteger(raw)) return { enabled: false, reject: "not-integer", segments: 1 };
	if (raw <= 0) return { enabled: false, reject: "not-positive", segments: 1 };
	if (raw > MAX_TIMEOUT_MS) {
		return { enabled: true, ms: raw, reject: "over-platform-limit", segments: Math.ceil(raw / MAX_TIMEOUT_MS) };
	}
	return { enabled: true, ms: raw, segments: 1 };
}

/** 预算判定所需的最小记录形状（不强依赖 KillableRunRecord，便于跨模块复用）。 */
export interface WallBudgetRecord {
	status?: string;
	startedAt?: string;
	result?: { status?: string } | unknown;
	/** 调用方给的墙钟总预算（ms）。缺省/非法 ⇒ 不启用。 */
	maxWallMs?: number;
	/** 唯一允许的「起算点」覆盖（缺省用 startedAt）。 */
	wallClockBaseAt?: string;
	/** 已落终态标记（防重复到期处理）。 */
	wallBudgetExpiredAt?: string;
}

export type WallBudgetReason =
	| "disabled"          // 未设置或非法 ⇒ 不启用（既有行为）
	| "not-running"       // 非 running（终态/排队中）
	| "already-expired"   // 已处理过（幂等短路）
	| "already-terminal"  // result.status 已是终态
	| "no-time-basis"     // 无 startedAt / wallClockBaseAt ⇒ 无法算
	| "not-yet"           // 未到点
	| "expired";          // **已到期**（调用方应 kill + 落 failed(wall_budget)）

export interface WallBudgetVerdict {
	expired: boolean;
	reason: WallBudgetReason;
	/** 起算点（epoch ms）。 */
	baseMs?: number;
	/** 到点时刻（baseMs + ms）。 */
	deadlineMs?: number;
	/** 剩余毫秒（可为负）。 */
	remainingMs?: number;
	/** 规范化后的预算（仅启用时）。 */
	budgetMs?: number;
}

/**
 * 墙钟到期判定（**纯函数**，无 IO）。
 *
 * 顺序：未启用 → 非 running → 已处理/已终态 → 无时间基准 → 未到点 → 到期。
 * **注意**：与 `detectZombie` 不同，本判定**不看 pid 是否存活**——进程活着也照样会超预算。
 */
export function detectWallBudget(
	rec: WallBudgetRecord,
	opts: { now?: () => number } = {},
): WallBudgetVerdict {
	const parsed = parseWallBudget(rec.maxWallMs);
	if (!parsed.enabled || parsed.ms === undefined) return { expired: false, reason: "disabled" };

	if (rec.status !== "running") return { expired: false, reason: "not-running", budgetMs: parsed.ms };
	if (typeof rec.wallBudgetExpiredAt === "string" && rec.wallBudgetExpiredAt.length > 0) {
		return { expired: false, reason: "already-expired", budgetMs: parsed.ms };
	}
	const rs = (rec.result as { status?: string } | undefined)?.status;
	if (rs === "completed" || rs === "failed" || rs === "cancelled") {
		return { expired: false, reason: "already-terminal", budgetMs: parsed.ms };
	}

	const rawBase = rec.wallClockBaseAt ?? rec.startedAt;
	const baseMs = typeof rawBase === "string" ? Date.parse(rawBase) : Number.NaN;
	if (!Number.isFinite(baseMs)) return { expired: false, reason: "no-time-basis", budgetMs: parsed.ms };

	const now = opts.now?.() ?? Date.now();
	const deadlineMs = baseMs + parsed.ms;
	const remainingMs = deadlineMs - now;
	if (remainingMs > 0) {
		return { expired: false, reason: "not-yet", baseMs, deadlineMs, remainingMs, budgetMs: parsed.ms };
	}
	return { expired: true, reason: "expired", baseMs, deadlineMs, remainingMs, budgetMs: parsed.ms };
}

/**
 * 剩余预算（供面板显示）。未启用 ⇒ undefined（调用方据此**不加任何 UI 段**，保持逐字节不变）。
 */
export function remainingWallBudgetMs(
	rec: WallBudgetRecord,
	opts: { now?: () => number } = {},
): number | undefined {
	const v = detectWallBudget(rec, opts);
	if (v.budgetMs === undefined || v.remainingMs === undefined) return undefined;
	return v.remainingMs;
}

/** 人类可读的剩余预算（面板用；未启用返回 undefined）。 */
export function formatRemainingBudget(
	rec: WallBudgetRecord,
	opts: { now?: () => number } = {},
): string | undefined {
	const ms = remainingWallBudgetMs(rec, opts);
	if (ms === undefined) return undefined;
	if (ms <= 0) return "已超预算";
	const min = Math.floor(ms / 60_000);
	if (min <= 0) return "预算剩 <1m";
	if (min >= 60) {
		const h = Math.floor(min / 60);
		return `预算剩 ${h}h${min % 60}m`;
	}
	return `预算剩 ${min}m`;
}
