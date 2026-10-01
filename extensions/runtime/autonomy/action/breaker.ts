/**
 * runtime/autonomy/action/breaker.ts — 熔断/预算计数（P1 harness；设计 §2）。
 *
 * 持久化 `actions/breaker.json`（自有 namespace；原子 tmp+rename 写，kill-switch.ts:48 先例）。
 *
 * 计数口径（§2）：**以实际启动尝试计，失败尝试也占额度**；**读不到计数 = 拒绝动作**
 * （防崩溃清零刷额度）。与 kill-switch 容忍读（kill-switch.ts:30）**刻意相反**——
 * 观察面容忍、动作面 fail-closed。
 *
 * 立即熔断五类（§2）：隔离逃逸 / 意外宿主改动 / 回退验证失败 / 回退后复验失败 / 在途无法停止
 * = 「可回滚承诺被证伪」→ tripBreaker（tripped + frozen，拒绝一切后续动作直到人工 clear）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultRuntimeDir } from "../../journal.ts";
import { BUDGET } from "./policy.ts";

export interface BreakerState {
	version: 1;
	/** 熔断态（五类立即事件置位）：拒绝一切后续动作。 */
	tripped: boolean;
	/** 冻结态（连败达限 / 熔断联动）：拒绝一切后续动作直到人工 clear。 */
	frozen: boolean;
	/** 在途动作数（全局；串行化，上限 1）。 */
	inFlight: number;
	/** 每 tick 新动作计数（跨 tick 重置）。 */
	newPerTick: { tickId: string; count: number };
	/** 滚动 1h 内启动的 ISO 时间戳（用于 1h≤2 计数）。 */
	newLast1h: string[];
	/** 连败计数：trigger×class×project 三元组 → 次数。 */
	consecFail: Record<string, number>;
	/** 去重表：rule:project → 上次动作 ISO（1h 窗内命中 → SKIP(cooldown)）。 */
	dedup: Record<string, string>;
	updatedAt: string;
}

/** 首次运行默认态（零计数、未熔断）——新 stateDir 的合法起点，非拒绝。 */
export function defaultBreakerState(now: number = Date.now()): BreakerState {
	return {
		version: 1,
		tripped: false,
		frozen: false,
		inFlight: 0,
		newPerTick: { tickId: "", count: 0 },
		newLast1h: [],
		consecFail: {},
		dedup: {},
		updatedAt: new Date(now).toISOString(),
	};
}

function breakerPath(stateDir?: string): string {
	return join(stateDir ?? join(defaultRuntimeDir(), "state"), "autonomy", "actions", "breaker.json");
}

function validState(s: unknown): s is BreakerState {
	if (typeof s !== "object" || s === null) return false;
	const o = s as BreakerState;
	return (
		o.version === 1 &&
		typeof o.tripped === "boolean" &&
		typeof o.frozen === "boolean" &&
		typeof o.inFlight === "number" &&
		typeof o.newPerTick?.tickId === "string" &&
		typeof o.newPerTick?.count === "number" &&
		Array.isArray(o.newLast1h) &&
		typeof o.consecFail === "object" && o.consecFail !== null &&
		typeof o.dedup === "object" && o.dedup !== null
	);
}

/**
 * 读熔断/预算计数（fail-closed）：
 * - 文件**不存在** = 首次运行 → 返回默认零计数（合法起点，非拒绝）；
 * - 文件**存在但损坏/形状漂移** = 读不到 → 返回 null（拒绝动作，防崩溃清零刷额度）。
 */
export function readBreaker(stateDir?: string): BreakerState | null {
	const path = breakerPath(stateDir);
	if (!existsSync(path)) return defaultBreakerState();
	try {
		const raw = JSON.parse(readFileSync(path, "utf8"));
		return validState(raw) ? raw : null;
	} catch {
		return null;
	}
}

/** 原子写（tmp+rename，never-throw）；返回是否实际写盘。 */
export function writeBreaker(state: BreakerState, stateDir?: string): boolean {
	try {
		const path = breakerPath(stateDir);
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
		renameSync(tmp, path);
		return true;
	} catch {
		return false;
	}
}

/** 滚动 1h 内启动数（纯）。 */
export function countLast1h(state: BreakerState, now: number): number {
	return state.newLast1h.filter((t) => {
		const x = Date.parse(t);
		return Number.isFinite(x) && now - x < BUDGET.hourMs;
	}).length;
}

/**
 * 预算判定（纯，§2/§1.2 L3）：返回 { ok, reason, newThisTick, startedInLast1h }。
 * tripped/frozen = 熔断态（拒绝一切）。newPerTick 跨 tick 自动归零。
 */
export function checkBudget(
	state: BreakerState,
	tickId: string,
	now: number,
): { ok: boolean; reason?: string; newThisTick: number; startedInLast1h: number } {
	if (state.tripped || state.frozen) return { ok: false, reason: "breaker-tripped", newThisTick: 0, startedInLast1h: 0 };
	const newThisTick = state.newPerTick.tickId === tickId ? state.newPerTick.count : 0;
	const startedInLast1h = countLast1h(state, now);
	if (state.inFlight >= BUDGET.maxInFlight) return { ok: false, reason: "budget-in-flight", newThisTick, startedInLast1h };
	if (newThisTick >= BUDGET.maxNewPerTick) return { ok: false, reason: "budget-new-per-tick", newThisTick, startedInLast1h };
	if (startedInLast1h >= BUDGET.maxNewPerHour) return { ok: false, reason: "budget-new-per-hour", newThisTick, startedInLast1h };
	return { ok: true, newThisTick, startedInLast1h };
}

/** 去重窗判定（纯）：rule:project 1h 内已动作 → true（→ SKIP(cooldown)）。 */
export function dedupHit(state: BreakerState, key: string, now: number): boolean {
	const last = state.dedup[key];
	if (!last) return false;
	const t = Date.parse(last);
	return Number.isFinite(t) && now - t < BUDGET.hourMs;
}

/** 记录一次启动尝试（占额度；**失败尝试也占**）。 */
export function recordStart(state: BreakerState, tickId: string, now: number, dedupKey: string): BreakerState {
	const newPerTick = state.newPerTick.tickId === tickId
		? { tickId, count: state.newPerTick.count + 1 }
		: { tickId, count: 1 };
	return {
		...state,
		inFlight: state.inFlight + 1,
		newPerTick,
		newLast1h: [...state.newLast1h, new Date(now).toISOString()],
		dedup: { ...state.dedup, [dedupKey]: new Date(now).toISOString() },
		updatedAt: new Date(now).toISOString(),
	};
}

/** 记录成功（释放 in-flight，重置该键连败）。 */
export function recordSuccess(state: BreakerState, key: string, now: number): BreakerState {
	return {
		...state,
		inFlight: Math.max(0, state.inFlight - 1),
		consecFail: { ...state.consecFail, [key]: 0 },
		updatedAt: new Date(now).toISOString(),
	};
}

/** 记录失败（释放 in-flight，累加该键连败；达限 → 冻结）。 */
export function recordFailure(state: BreakerState, key: string, now: number): BreakerState {
	const n = (state.consecFail[key] ?? 0) + 1;
	const frozen = state.frozen || n >= BUDGET.consecFailLimit;
	return {
		...state,
		inFlight: Math.max(0, state.inFlight - 1),
		consecFail: { ...state.consecFail, [key]: n },
		frozen,
		updatedAt: new Date(now).toISOString(),
	};
}

/** 立即熔断（五类「可回滚承诺被证伪」事件；tripped + frozen）。 */
export function tripBreaker(state: BreakerState, now: number): BreakerState {
	return { ...state, tripped: true, frozen: true, updatedAt: new Date(now).toISOString() };
}

/** 人工 clear（解冻 + 清熔断；由人执行，非 autonomy 自主）。 */
export function clearBreaker(state: BreakerState, now: number): BreakerState {
	return { ...state, tripped: false, frozen: false, updatedAt: new Date(now).toISOString() };
}
