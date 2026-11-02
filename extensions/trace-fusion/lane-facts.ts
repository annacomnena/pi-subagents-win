/**
 * trace-fusion/lane-facts.ts — lane 参与事实与降级记录（2026-11-02，状态机修复 ④）
 *
 * ## 起因（两条实测成立的缺陷）
 *
 * 1. supervisor 原来**固定等 A/B/C 三份 `result.json`**：
 *    `done = lanes.filter(tabRunId && exists(result.json))`，被 `skipLanes` 放弃的 lane 与
 *    spawn 失败的 lane 根本没有 `tabRunId` ⇒ `done` 永远 < 3 ⇒ **永不自动收集**；
 *    run 停在 `running` 占住 `active-run-mutex`（preflight）⇒ 一次 wt.exe 启动失败就锁死 trace-fusion。
 *    宣称的「2/3 降级」在代码里**不可达**。
 * 2. lane tab 被杀/进程死掉 ⇒ 没有 `result.json` ⇒ 同样永远差一个。
 *
 * ## 本模块的判据
 *
 * 收集分母 = **预期参与的 lane 集合**：
 *   - `skipped` / `dispatch-failed`（launch 时就写进 meta）⇒ 一等终态，不进分母；
 *   - 派发成功但 tab 侧已终态（`tab-runs/<id>.state.json` 的 `terminal=true`）⇒ 终态无结果；
 *   - 进程死（`pid` 探活 false，或 pid 缺失且心跳超阈）⇒ 死亡，终态无结果；
 *   - 其余 ⇒ 在跑，收集继续等（`progress`）。
 *
 * **心跳阈是 90s**，与 `tab-runs.ts` 的既定判据一致（该文件注释原话：
 * 「判断死亡的正确方式：pid 探活 ∨ heartbeatAt 距今 > 90s（3 个心跳周期）」）。
 * 单看 `lastActivityAt` 会误判：一次长工具调用期间不写 state（实测有正常工作的 tab
 * 因 lastActivityAt 冻结 61min 被误判僵尸并 abort，随后重复派发）。
 * 因此本模块**绝不用 lastActivityAt 判死**。
 *
 * 降级原因写进 `meta.degradedLanes`（**不得静默**，AGENTS.md R-2），
 * 并由 packet 的 Hard Facts 段呈现（`fusion-packet.ts` 消费该字段）。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isProcessAlive } from "../runtime/liveness.ts";
import { tabStatePath, writeTabState } from "../tab-runs.ts";
import type { LaneId, TraceRunMeta } from "./types.ts";
import { metaPath } from "./meta-path.ts";

/**
 * 派发时预置 `state.json`（2026-11-02 状态机修复的一部分）。
 *
 * 为什么必须：**dispatch 失败发生在 wt.exe 启动之后（异步）** ⇒ tab 侧的 `session_start`
 * 永远不会写 state ⇒ lane 的 `state.json` 全生缺失。本模块对「无 state 且无结果」
 * 只能保守判在跑 ⇒ 收集永远差一个。
 * 派发那一刻就登记 pid（= 派发者进程，tab 进程是 wt 的子进程），于是「派发者已死 + 从未心跳」
 * 可被确定性判成 launch-dead，不再靠猜。
 * 已存在则不动（不得覆盖 tab 侧写的活状态）。
 */
export function seedDispatchState(tabRunsDir: string, tabRunId: string, opts: { title?: string; cwd?: string; now?: () => number } = {}): void {
	try {
		const p = tabStatePath(tabRunsDir, tabRunId);
		if (existsSync(p)) return;
		const at = new Date(opts.now?.() ?? Date.now()).toISOString();
		writeTabState(tabRunsDir, tabRunId, {
			id: tabRunId,
			phase: "attached",
			turn: "unknown",
			terminal: false,
			pid: process.pid,
			lastActivityAt: at,
			heartbeatAt: at,
		} as never);
	} catch { /* 预置失败不阻断派发 */ }
}

export type LaneFactStatus = "done" | "running" | "queued" | "terminal-no-result" | "dead" | "skipped" | "dispatch-failed";

/** 不进收集分母的状态（一等终态）。 */
export const TERMINAL_LANE_STATUSES = new Set(["skipped", "dispatch-failed"]);

/** 心跳超阈 = 死亡候选；90s = tab-runs 既定 3 个心跳周期。 */
export const HEARTBEAT_DEAD_MS = 90_000;

export interface LaneFacts {
	lane: LaneId;
	tabRunId: string;
	status: LaneFactStatus;
	/** 结果文件是否存在（terminal-no-result/dead 恒 false）。 */
	hasResult: boolean;
	/** 可读原因（判据 + 依据），写进 meta.degradedLanes。 */
	reason: string;
}

interface TabStateLite {
	terminal?: boolean;
	phase?: string;
	turn?: string;
	pid?: number;
	heartbeatAt?: string;
	lastActivityAt?: string;
}

const laneStateExists = (tabRunsDir: string, tabRunId: string): boolean => existsSync(tabStatePath(tabRunsDir, tabRunId));

const readTabStateLite = (tabRunsDir: string, tabRunId: string): TabStateLite | null => {
	const p = tabStatePath(tabRunsDir, tabRunId);
	if (!existsSync(p)) return null;
	try {
		const v = JSON.parse(readFileSync(p, "utf8")) as TabStateLite;
		return v && typeof v === "object" ? v : null;
	} catch {
		return null; // 半截 JSON 不判死（不误杀活 tab）
	}
};

/**
 * 逐 lane 判参与事实。never-throw。
 * `isAlive` 是 seam（测试注入）；缺省 = 真实 `process.kill(pid,0)` 探针。
 */
export function laneFacts(
	meta: TraceRunMeta,
	tabRunsDir: string,
	opts: { now?: () => number; isAlive?: (pid: number) => boolean; queuePending?: Set<LaneId> } = {},
): LaneFacts[] {
	const now = opts.now?.() ?? Date.now();
	const isAlive = opts.isAlive ?? isProcessAlive;
	const out: LaneFacts[] = [];
	for (const lane of ["A", "B", "C"] as LaneId[]) {
		const meta2 = meta.lanes[lane];
		const status0 = meta2.laneStatus ?? "active";
		if (TERMINAL_LANE_STATUSES.has(status0)) {
			out.push({
				lane,
				tabRunId: meta2.tabRunId ?? "",
				status: status0 as "skipped" | "dispatch-failed",
				hasResult: false,
				reason: `${status0}：${meta2.laneStatusReason ?? "无原因"}`,
			});
			continue;
		}
		const id = meta2.tabRunId ?? "";
		if (!id) {
			// 无 tabRunId 只有两种台本：在队待发（排队中，不进分母）/ 派发失败空洞（一等终态）。
			// 两者都不得算「在跑」——算在跑就是本次修的缺陷：收集永远差一个。
			if (opts.queuePending?.has(lane) && !laneStateExists(tabRunsDir, id)) {
				out.push({ lane, tabRunId: "", status: "queued", hasResult: false, reason: "在 lane-queue 待发队列中（尚未派发）" });
			} else {
				out.push({ lane, tabRunId: "", status: "dispatch-failed", hasResult: false, reason: "dispatch-failed：meta 无 tabRunId 且不在待发队列" });
			}
			continue;
		}
		const hasResult = existsSync(join(tabRunsDir, `${id}.result.json`));
		if (hasResult) {
			out.push({ lane, tabRunId: id, status: "done", hasResult: true, reason: "result.json 已存在" });
			continue;
		}
		const st = readTabStateLite(tabRunsDir, id);
		if (st?.terminal === true) {
			out.push({ lane, tabRunId: id, status: "terminal-no-result", hasResult: false, reason: `tab 已终态（phase=${st.phase ?? "?"}）但无 result.json` });
			continue;
		}
		if (st?.pid !== undefined && !isAlive(st.pid)) {
			out.push({ lane, tabRunId: id, status: "dead", hasResult: false, reason: `tab 进程 pid=${st.pid} 已不在` });
			continue;
		}
		// pid 缺失（实测常态）⇒ 只能用心跳；心跳也缺 ⇒ 保守判在跑（绝不用 lastActivityAt 判死）
		if (st?.pid === undefined && st?.heartbeatAt) {
			const age = now - Date.parse(st.heartbeatAt);
			if (Number.isFinite(age) && age > HEARTBEAT_DEAD_MS) {
				out.push({ lane, tabRunId: id, status: "dead", hasResult: false, reason: `pid 缺失且心跳 ${Math.round(age / 1000)}s 前 > ${HEARTBEAT_DEAD_MS / 1000}s 阈` });
				continue;
			}
		}
		// 没有任何 state 文件（派发后 wt 未起到写 state 就挂了）⇒ 无从判活，保守算在跑；
		// 这类 lane 由墙钟时限 / 人工 /trace-fusion-clean 收拾，**不得被当作全部终态而提前收集**。
		out.push({ lane, tabRunId: id, status: "running", hasResult: false, reason: st ? `在跑（phase=${st.phase ?? "?"}）` : "在跑（无 state 文件，无从判活 ⇒ 保守等待）" });
	}
	return out;
}

/** 不可用 lane（降级项）。 */
export const degradedFacts = (facts: LaneFacts[]): LaneFacts[] =>
	facts.filter((f) => f.status !== "done" && f.status !== "running" && f.status !== "queued");

/**
 * 把降级原因写进 meta（`degradedLanes`）。原子重写 meta；写失败 ⇒ 返回 false（调用方记日志，不静默）。
 */
export function writeDegradedLanes(meta: TraceRunMeta, facts: LaneFacts[], now?: () => number): boolean {
	const degraded = degradedFacts(facts).map((f) => ({ lane: f.lane, tabRunId: f.tabRunId, status: f.status, reason: f.reason }));
	try {
		const path = metaPath(meta.runDir);
		const raw = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : {};
		writeFileSync(path, JSON.stringify({ ...raw, degradedLanes: degraded, degradedAt: new Date(now?.() ?? Date.now()).toISOString() }, null, 2) + "\n", "utf8");
		return true;
	} catch {
		return false;
	}
}
