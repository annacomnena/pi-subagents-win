/**
 * runtime/scope-consume.ts — local master「消费侧就绪」进展证据（0926 P1，astra 第 2 条）。
 *
 * 为什么是新文件而不是扩 scope-liveness（计划 §1.1 三条理由，L1 §4.3 已核实）：
 *   1. scope-liveness 是 stale 接管判据的输入（scope.ts judgeScopeOwnerStale）——并入消费
 *      语义会污染/可能被误引入 takeover 判据，违反「零新增权力」；
 *   2. 它的唯一写手是 agent 钩子（session-hooks，按 turn 写 + 30s 节流）——tick 再写就成了
 *      双写手争抢，节流会吞写；
 *   3. readScopeLiveness 的严格字段校验是既有契约（3 个读手），动它波及面大。
 *
 * 形态（同 liveness.ts 纪律）：纯库、路径可注入、never-throw、原子写 tmp+rename、无 Pi API。
 * 路径：<stateDir>/scope-consume/<scopeKey>.json（scopeKey 净化 `[^A-Za-z0-9._-]→_`）。
 *
 * **唯一写手 = scope 消费循环的 tick**（mailbox-consumer.activateScopeConsumption 启动的
 * interval）：fire 与 no-fire 都写（no-fire 也证明循环活着）；注册时绝不写——注册标记 ≠ 能消费。
 * 心跳 / 新 PID / 主会话普通活动都不能替代它。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultRuntimeDir } from "./journal.ts";

/** 消费进展证据（astra 最低四项：scope / sessionId / generation / lastTickAt + 可解释性字段）。 */
export interface ScopeConsumeEvidence {
	version: 1;
	scope: string;
	sessionId: string;
	generation: number;
	/** 本次 tick 结束时刻（ISO）。 */
	lastTickAt: string;
	/** 写证据的 tick 所在进程 pid（交叉核对用，不参与新鲜度判定）。 */
	pid: number;
	/** evaluateScopeWake 的 reason ∪ {"fired","tick-error"} —— 受阻时直接给出原因，不靠人巡视 PID。 */
	lastTickReason: string;
	/** 单调累计（观测推进用；身份变化重置为 1，不参与新鲜度判定）。 */
	tickCount: number;
	/** 最近一次 claim+spawn（fire）。 */
	lastFireAt?: string;
	/** 最近一次 claim 的信数。 */
	lastClaimedCount?: number;
}

/**
 * 新鲜度阈值 = 3 × 30s tick：连续 3 次 tick 缺席才算陈旧（单次调度抖动不误判），
 * 同时正好是 astra 建议的「健康态接单 ≤ 90 秒」验收预算上界 ⇒ 与 30s tick 自洽。
 */
export const CONSUME_FRESH_MS = 90_000;

export function consumeEvidencePath(scopeKey: string, stateDir?: string): string {
	const safe = scopeKey.replace(/[^A-Za-z0-9._-]/g, "_");
	return join(stateDir ?? join(defaultRuntimeDir(), "state"), "scope-consume", `${safe}.json`);
}

/** 容忍读：缺失/坏 JSON/坏版本/关键字段缺失 → null（同 readScopeLiveness 惯例）。 */
export function readConsumeEvidence(scopeKey: string, opts: { stateDir?: string } = {}): ScopeConsumeEvidence | null {
	try {
		const raw = JSON.parse(readFileSync(consumeEvidencePath(scopeKey, opts.stateDir), "utf8")) as ScopeConsumeEvidence;
		if (
			raw?.version !== 1 ||
			typeof raw.scope !== "string" ||
			typeof raw.sessionId !== "string" ||
			typeof raw.generation !== "number" ||
			typeof raw.lastTickAt !== "string" ||
			typeof raw.pid !== "number" ||
			typeof raw.lastTickReason !== "string" ||
			typeof raw.tickCount !== "number"
		) {
			return null;
		}
		return raw;
	} catch {
		return null;
	}
}

export interface RecordConsumeTickInput {
	scope: string;
	sessionId: string;
	generation: number;
	lastTickReason: string;
	/** 本次 fire 的时刻（缺省 now）；未 fire 的 tick 沿用同身份的上一次值。 */
	lastFireAt?: string;
	lastClaimedCount?: number;
	pid?: number;
	now?: Date;
}

/**
 * 记一次消费 tick（唯一写入口；never-throw，写失败返回 null ⇒ 证据缺失 ⇒ 判定降级不谎报）。
 *
 * tickCount / lastFireAt 只在**同身份**（sessionId+generation）时延续；身份变化重置为 1，
 * 旧代的进展不能累计进新代。
 */
export function recordConsumeTick(input: RecordConsumeTickInput, opts: { stateDir?: string } = {}): ScopeConsumeEvidence | null {
	try {
		const path = consumeEvidencePath(input.scope, opts.stateDir);
		const now = opts.now ?? new Date();
		const prev = readConsumeEvidence(input.scope, opts);
		const same = Boolean(prev && prev.sessionId === input.sessionId && prev.generation === input.generation);
		const record: ScopeConsumeEvidence = {
			version: 1,
			scope: input.scope,
			sessionId: input.sessionId,
			generation: input.generation,
			lastTickAt: now.toISOString(),
			pid: input.pid ?? process.pid,
			lastTickReason: input.lastTickReason,
			tickCount: same ? prev!.tickCount + 1 : 1,
		};
		const fireAt = input.lastFireAt ?? (same ? prev!.lastFireAt : undefined);
		if (fireAt !== undefined) record.lastFireAt = fireAt;
		const claimed = input.lastClaimedCount ?? (same ? prev!.lastClaimedCount : undefined);
		if (claimed !== undefined) record.lastClaimedCount = claimed;
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
		renameSync(tmp, path);
		return record;
	} catch {
		return null; // never-throw：写失败静默 ⇒ 证据缺失 ⇒ ensure 降级（fail-safe：不谎报就绪）
	}
}

// ── 新鲜度判定（纯函数，可单测）────────────────────────────────────

export type ConsumeFreshReason = "ok" | "missing" | "identity-mismatch" | "old-generation" | "stale";

/**
 * 消费证据是否能证明「这个 owner 的这个代正在消费」：
 *   missing            证据缺席（从未 tick / 写失败）
 *   identity-mismatch  证据属于别的会话（旧 owner）
 *   old-generation     证据属于旧代（ownership transfer 后旧代进展不证明新代就绪）
 *   stale              同身份但 lastTickAt 超过 freshMs（连续 3 次 tick 缺席）
 *   ok                 fresh
 *
 * 只用于 ensure 判定与验收观测；**不进 judgeScopeOwnerStale / forceStale / reclaim / gate 任何
 * 既有判据**（零新增权力）。
 */
export function judgeConsumeFresh(
	evidence: ScopeConsumeEvidence | null,
	input: { sessionId: string; generation: number; nowMs: number; freshMs?: number },
): { fresh: boolean; reason: ConsumeFreshReason } {
	if (!evidence) return { fresh: false, reason: "missing" };
	if (evidence.sessionId !== input.sessionId) return { fresh: false, reason: "identity-mismatch" };
	if (evidence.generation !== input.generation) return { fresh: false, reason: "old-generation" };
	const age = input.nowMs - Date.parse(evidence.lastTickAt);
	const freshMs = input.freshMs ?? CONSUME_FRESH_MS;
	if (!Number.isFinite(age) || age > freshMs) return { fresh: false, reason: "stale" };
	return { fresh: true, reason: "ok" };
}
