/**
 * delivery-reconciler.ts — B 对账通道（唤醒必达 D3，咨询 §6.2）
 *
 * ## 为什么必须独立于 A
 * 咨询 §6.2 明确：B 的发现/期限/升级必须在**另一个进程**执行，
 * **不能与 A 共享 selfDisabled / seen 集合 / `.notified` 最终状态**；B 即使 A 挂了也能发现 run 终态。
 *
 * 本模块**不 import `async-result-watcher.ts`**（结构上保证不共享其模块级状态），
 * 只读**权威终态 JSON**（runs 目录）+ **交付账本**（delivery 目录），
 * 因此 A 的进程内状态（seenRunIds/selfDisabled/.notified）对 B 完全不可见。
 *
 * ## 职责边界（咨询 §7，逐条遵守）
 * - 只**补投/升级**：不改 run 终态、不 kill、不设执行 timer、不 force；
 * - 到期只产 incident + 定向持久唤醒（**不调用模型**的失败出口）；
 * - `failed_delivery` **不改变 run**；business 面与交付面分开记账。
 *
 * ## 与 A 的分工
 *   A：fs.watch 快通道（≤15s 发现）→ 注入并记 attempt；
 *   B：10s 周期对账（独立进程），扫终态 JSON 补 ensureEvent + 判定 retry/fail_delivery。
 *   **两者共享 eventId，但 attemptId 不同**（A 用 `@A@`，B 用 `@B@`）。
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	appendTrace,
	effectiveStage,
	ensureEvent,
	listAcks,
	listAttempts,
	listEvents,
	publishIncident,
	reconcileDecision,
	recordAttempt,
	terminalRevisionOf,
	type AttemptStatus,
	type DeliveryEvent,
	type DeliveryStage,
} from "./delivery-ledger.ts";

// ── 权威终态扫描（只读 runs 目录，不依赖 A 的任何状态）──────────────

export interface TerminalRun {
	runId: string;
	status: string;
	record: Record<string, unknown>;
	path: string;
}

/** 是否为终态（`status !== "running"`，与 watcher 同口径）。 */
export function isTerminalStatus(status: string): boolean {
	return status !== "running";
}

/** 终态发生时刻（endedAt → zombieReapedAt → killedAt）；都无 ⇒ undefined（回退发现时刻）。 */
export function terminalAtOf(rec: Record<string, unknown>): string | undefined {
	for (const k of ["endedAt", "zombieReapedAt", "killedAt"] as const) {
		const v = rec[k];
		if (typeof v === "string" && Number.isFinite(Date.parse(v))) return v;
	}
	return undefined;
}

/**
 * 公平分页扫描终态 run（咨询 §6.1：必须公平分页，不能每轮永远只看前 50 条）。
 *
 * @param cursor 上一轮结束的文件名（实现 round-robin；缺省从头）
 * @returns 本页终态 + 下一页游标（null = 已扫完，下轮从头）
 */
export function scanTerminalRuns(
	runsDir: string,
	opts: { limit?: number; cursor?: string | null } = {},
): { runs: TerminalRun[]; nextCursor: string | null; scanned: number } {
	if (!existsSync(runsDir)) return { runs: [], nextCursor: null, scanned: 0 };
	let files: string[];
	try {
		files = readdirSync(runsDir).filter((f) => f.startsWith("run_") && f.endsWith(".json")).sort();
	} catch {
		return { runs: [], nextCursor: null, scanned: 0 };
	}
	const limit = opts.limit ?? 50;
	// round-robin：从游标之后开始，到末尾后回绕 —— 保证不饿死任何前缀
	let start = 0;
	if (opts.cursor) {
		const idx = files.indexOf(opts.cursor);
		if (idx >= 0) start = idx + 1;
	}
	const page: string[] = [];
	for (let i = 0; i < files.length && page.length < limit; i += 1) {
		page.push(files[(start + i) % files.length]);
	}

	const runs: TerminalRun[] = [];
	for (const f of page) {
		try {
			const raw = JSON.parse(readFileSync(join(runsDir, f), "utf8")) as Record<string, unknown>;
			if (typeof raw.id !== "string" || typeof raw.status !== "string") continue;
			if (!isTerminalStatus(raw.status)) continue;
			runs.push({ runId: raw.id, status: raw.status, record: raw, path: join(runsDir, f) });
		} catch { /* 半截/损坏 JSON：跳过，下轮重试（不右删失） */ }
	}
	const lastFile = page.at(-1) ?? null;
	const nextCursor = page.length < files.length && lastFile ? lastFile : null;
	return { runs, nextCursor, scanned: page.length };
}

// ── 单轮对账（核心；纯判定 + 注入式投递，可测）──────────────────────

export interface ReconcileRunResult {
	eventId: string;
	runId: string;
	stage: DeliveryStage;
	action: "none" | "retry" | "fail_delivery";
	incidentId?: string;
	dispatched: boolean;
}

export interface ReconcileOnceOptions {
	runsDir: string;
	deliverDir: string;
	now?: number;
	limit?: number;
	cursor?: string | null;
	/** 派发者解析（生产接 links；测试注入）。返回 undefined = fail closed（不建事件）。 */
	resolveDispatcher?: (runId: string) => string | undefined;
	/**
	 * 补投实现（**B 通道的定向持久唤醒**）。生产接 mailbox/timer 写同 eventId 的持久唤醒。
	 * 返回 attempt 状态；未提供 ⇒ 只判定不投（用于纯判定测试）。
	 */
	deliver?: (event: DeliveryEvent, attemptId: string) => Promise<AttemptStatus> | AttemptStatus;
	/** incident 出口（不调用模型；失败不阻断 incident 本身）。 */
	onIncident?: (inc: { incidentId: string; eventId: string; runId: string; reason: string }) => void;
	/** 建立定向持久唤醒（B 通道用 mailbox/timer；与 deliver 二选一，deliver 优先）。 */
	armWaker?: (event: DeliveryEvent) => void;
}

/**
 * 跑一轮对账：扫描终态 → ensureEvent（缺则建）→ 判定 → 补投 或 发布 incident。
 *
 * **幂等**：event 已存在的（含已 consumed / 已 failed_delivery）由 `reconcileDecision` 判 none，
 * 不重复投、不重复发 incident。
 */
export async function reconcileOnce(opts: ReconcileOnceOptions): Promise<{
	results: ReconcileRunResult[];
	nextCursor: string | null;
	scanned: number;
	undiscoveredBefore: number;
}> {
	const now = opts.now ?? Date.now();
	const { runs, nextCursor, scanned } = scanTerminalRuns(opts.runsDir, { limit: opts.limit, cursor: opts.cursor });
	// 独立 oracle 指标：终态总数 − 已有 event 数 = 未发现终态（咨询 §8.4 `undiscovered_terminal`）
	const knownEvents = new Set(listEvents(opts.deliverDir, 100_000).map((e) => e.runId));
	const undiscoveredBefore = runs.filter((r) => !knownEvents.has(r.runId)).length;

	const results: ReconcileRunResult[] = [];
	for (const run of runs) {
		const revision = terminalRevisionOf(run.record);
		let event: DeliveryEvent | null = null;
		try {
			// 事件创建者 = 本对账者（单写者语义；ensureEvent 幂等不覆盖既有）
			const dispatcher = opts.resolveDispatcher?.(run.runId);
			if (!dispatcher) {
				// fail closed：无派发者 ⇒ 不建事件（不猜归属；A 通道同范式）
				continue;
			}
			const ensured = ensureEvent(opts.deliverDir, {
				runId: run.runId,
				terminalRevision: revision,
				terminalSnapshotPath: run.path,
				dispatcherSessionId: dispatcher,
				observedAt: new Date(now).toISOString(),
				// 期限基准 = **终态时刻**（非发现时刻）：B 可能很晚才扫到旧 run，
				// 用 observedAt 会隐式展期（违反咨询 §6.5）。
				terminalAt: terminalAtOf(run.record) ?? new Date(now).toISOString(),
			});
			event = ensured.event;
			if (ensured.created) appendTrace(opts.deliverDir, { kind: "B-ensure-event", eventId: event.eventId, runId: run.runId });
		} catch {
			continue;
		}

		const attempts = listAttempts(opts.deliverDir, event.eventId);
		const acks = listAcks(opts.deliverDir, event.eventId);
		const view = effectiveStage(event, attempts, acks, now);
		const decision = reconcileDecision(event, view, attempts, now);

		if (decision.action === "none") {
			// 期限/阈值未到：顺手 arm 定向持久唤醒（若提供），保证 idle 时也能被触发
			if (opts.armWaker && view.stage !== "consumed" && view.stage !== "failed_delivery") {
				try { opts.armWaker(event); } catch { /* best-effort */ }
			}
			results.push({ eventId: event.eventId, runId: run.runId, stage: view.stage, action: "none", dispatched: false });
			continue;
		}

		if (decision.action === "fail_delivery") {
			const inc = publishIncident(opts.deliverDir, event, decision.reason, now);
			try { opts.onIncident?.(inc); } catch { /* 出口失败不抹 incident */ }
			appendTrace(opts.deliverDir, { kind: "B-fail-delivery", eventId: event.eventId, runId: run.runId, reason: decision.reason });
			results.push({ eventId: event.eventId, runId: run.runId, stage: "failed_delivery", action: "fail_delivery", incidentId: inc.incidentId, dispatched: false });
			continue;
		}

		// retry：B 补投（同 eventId、新 attemptId）
		let status: AttemptStatus = "unconfirmed";
		let dispatched = false;
		if (opts.deliver) {
			try {
				status = await opts.deliver(event, decision.attemptId);
				dispatched = true;
			} catch (e) {
				status = "failed";
				dispatched = true;
				appendTrace(opts.deliverDir, { kind: "B-deliver-threw", eventId: event.eventId, error: String((e as Error)?.message ?? e).slice(0, 200) });
			}
			recordAttempt(opts.deliverDir, event.eventId, {
				attemptId: decision.attemptId, channel: "B", at: new Date(now).toISOString(), status,
				leaseOwner: `B:${process.pid}`, leaseUntil: new Date(now + 15_000).toISOString(),
			});
		} else if (opts.armWaker) {
			try { opts.armWaker(event); dispatched = true; } catch { /* best-effort */ }
		}
		results.push({ eventId: event.eventId, runId: run.runId, stage: view.stage, action: "retry", dispatched });
	}

	return { results, nextCursor, scanned, undiscoveredBefore };
}
