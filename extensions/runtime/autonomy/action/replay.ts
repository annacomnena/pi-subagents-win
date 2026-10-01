/**
 * runtime/autonomy/action/replay.ts — 只读回放函数（§3.2 验收口径；never-throw）。
 *
 * 设计 §3.2：「回放必须能回答的三问」：
 *   ① 「做了什么」→ 按 ts 过滤 kind ∈ {attempted, executed}
 *   ② 「为什么」→ trigger(rule+project+evidence) + intent + policyVersion
 *   ③ 「能不能撤」→ 该 id 最新 kind ∈ {rolled_back(已撤), rollback_failed(不可撤已冻结),
 *     postverified(可撤：rollbackHandle 存在且快照可读), 否则→无法保证可撤}
 *
 * 纯读 actions.jsonl（尾/轮转代）；不写任何文件；不修改 breaker。
 * 全部函数 never-throw（读失败 = 空/null/未知终态，不猜）。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readActionsTail, readActionEvents, readLatestAction } from "./ledger.ts";

// ── 类型 ──────────────────────────────────────────────────────────────

export interface ReplayWhat {
	id: string;
	ts: string;
	kind: string;
	actionClass: string;
}

export interface ReplayWhy {
	id: string;
	trigger: { rule: string; project: string; evidence: string; approximate: boolean };
	intent: string | null;
	policyVersion: string;
}

export type UndoStatus =
	| "已撤"
	| "不可撤，已冻结"
	| "可撤"
	| "无法保证可撤（快照缺失/不可读）"
	| "未知终态";

export interface ReplayUndo {
	id: string;
	status: UndoStatus;
}

// ── 三问 ──────────────────────────────────────────────────────────────

/**
 * ① 「做了什么」：按 ts ≥ sinceTs 过滤 kind ∈ {attempted, executed}。
 * 纯读；never-throw（读失败 = []）。
 */
export function queryActionsWhat(stateDir: string | undefined, sinceTs: number): ReplayWhat[] {
	try {
		const all = readActionsTail({ stateDir, limit: 100000 });
		return all
			.filter((e) => {
				const t = Date.parse(e.ts);
				return t >= sinceTs && (e.kind === "attempted" || e.kind === "executed");
			})
			.map((e) => ({ id: e.id, ts: e.ts, kind: e.kind, actionClass: e.actionClass }));
	} catch {
		return [];
	}
}

/**
 * ② 「为什么」：取该 id 首条事件的 trigger + intent + policyVersion。
 * 纯读；never-throw（无事件 = null）。
 */
export function queryActionsWhy(stateDir: string | undefined, id: string): ReplayWhy | null {
	try {
		const evs = readActionEvents(id, { stateDir });
		if (evs.length === 0) return null;
		const first = evs[0]!;
		return {
			id,
			trigger: first.trigger,
			intent: first.intent ?? null,
			policyVersion: first.policyVersion,
		};
	} catch {
		return null;
	}
}

/**
 * ③ 「能不能撤」：该 id 最新 kind 决定终态。
 *   rolled_back → 已撤
 *   rollback_failed → 不可撤，已冻结
 *   postverified → rollbackHandle 存在且全部快照 meta.json 可读 → 可撤；否则 → 无法保证可撤
 *   其他 → 未知终态
 * 纯读；never-throw（读失败 = 未知终态，不猜）。
 */
export function queryActionsUndo(stateDir: string | undefined, id: string): ReplayUndo {
	try {
		const latest = readLatestAction(id, { stateDir });
		if (!latest) return { id, status: "未知终态" };
		if (latest.kind === "rolled_back") return { id, status: "已撤" };
		if (latest.kind === "rollback_failed") return { id, status: "不可撤，已冻结" };
		if (latest.kind === "postverified") {
			const snaps = latest.rollbackHandle?.snapshots ?? [];
			const readable =
				snaps.length > 0 &&
				snaps.every((s) => {
					try {
						return existsSync(join(s, "meta.json"));
					} catch {
						return false;
					}
				});
			return { id, status: readable ? "可撤" : "无法保证可撤（快照缺失/不可读）" };
		}
		return { id, status: "未知终态" };
	} catch {
		return { id, status: "未知终态" };
	}
}
