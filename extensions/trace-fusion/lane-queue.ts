/**
 * trace-fusion/lane-queue.ts — 待发 lane 队列（laneConcurrency 的续发侧，2026-10-30）
 *
 * 契约：
 *   - 首发批次由 `launchTraceRun` 派发，未派的 lane 写入 `<runDir>/lane-queue.json`；
 *   - 每条 lane tab 终态时，supervisor 调 `resumeQueuedLane()`：
 *       若该 run 还有待发 lane 且并发名额空出 ⇒ 派发下一条并从队列移除；
 *       队列空了 ⇒ 删除队列文件（或写空数组）。
 *   - 纯函数 + 注入 seam；文件缺失 = 无队列（== 历史全并发行为，零改动路径）。
 *
 * 为什么放独立文件：`supervisor.ts` 已有 151 行且只做收集决策；
 * 续发是另一个职责，且需要 read-modify-write 队列文件的手写并发守卫。
 */

import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readTabResultFile } from "../tab-runs.ts";
import type { LaneId, TraceRunMeta } from "./types.ts";
import { dispatchDiagnoseLane, readTraceRunMeta, writeLaneTimers, type TabSpawner } from "./launch-workers.ts";

export interface LaneQueueFile {
	/** 尚未派发的 lane（顺序即派发顺序）。 */
	lanes: LaneId[];
	/** 本次 run 的并发度（记录用，续发时以 meta/in-flight 实况为准）。 */
	concurrency: number;
}

export function laneQueuePath(runDir: string): string {
	return join(runDir, "lane-queue.json");
}

export function readLaneQueue(runDir: string): LaneQueueFile | null {
	const p = laneQueuePath(runDir);
	if (!existsSync(p)) return null;
	try {
		const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<LaneQueueFile>;
		const lanes = Array.isArray(raw.lanes) ? raw.lanes.filter((l): l is LaneId => l === "A" || l === "B" || l === "C") : [];
		return { lanes, concurrency: typeof raw.concurrency === "number" ? raw.concurrency : 3 };
	} catch {
		return null; // 坏文件 ⇒ 视为无队列（不阻断收集，不猜）
	}
}

/** 覆盖写队列；`lanes` 为空时删除文件（保持磁盘干净，也让"无队列"语义唯一）。 */
export function writeLaneQueue(runDir: string, q: LaneQueueFile): void {
	const p = laneQueuePath(runDir);
	if (q.lanes.length === 0) {
		try { rmSync(p, { force: true }); } catch { /* 尽力而为 */ }
		return;
	}
	writeFileSync(p, JSON.stringify(q, null, 2) + "\n", "utf8");
}

/**
 * 「显式写入空队列」与「删除队列」（= 无队列）是**两个不同语义**，不得合并：
 *   - `writeLaneQueue(d, {lanes: []})` ⇒ 删文件 ⇒ 后续 readLaneQueue 返回 `null`（no-queue）；
 *   - `markLaneQueueDrained(d)` ⇒ 写 `{lanes: []}` 保留文件 ⇒ readLaneQueue 返回空队列（empty）。
 * 两者对 `resumeQueuedLane` 的结果都是不续发，但**可观测性不同**（后者留下事故现场）。
 * 本函数给测试与“想留现场”的调用方用。
 */
export function markLaneQueueDrained(runDir: string, concurrency: number): void {
	writeFileSync(laneQueuePath(runDir), JSON.stringify({ lanes: [], concurrency }, null, 2) + "\n", "utf8");
}

/** 某 lane 是否已有终态 result（与 supervisor 的 done 判据同源）。 */
function laneTerminal(tabRunsDir: string, tabRunId: string): boolean {
	if (!tabRunId) return false;
	return existsSync(join(tabRunsDir, `${tabRunId}.result.json`));
}

export interface ResumeQueuedLaneInput {
	meta: TraceRunMeta;
	tabRunsDir: string;
	concurrency: number;
	now?: Date;
	wtExe: string;
	piCli: string;
	/** worker 模型解析（调用方给，复用 launch-workers 的 per-lane 四级降级）。 */
	workerModelFor: (lane: LaneId) => string | undefined;
	spawnTab: TabSpawner;
	/** 重读 meta 的 seam（测试注入）。默认重新 readTraceRunMeta。 */
	rereadMeta?: (runDir: string) => TraceRunMeta | null;
}

export type ResumeQueuedLaneOutcome =
	| { resumed: false; reason: "no-queue" | "no-capacity" | "empty" | "dispatch-failed"; error?: string }
	| { resumed: true; lane: LaneId; tabRunId: string; title: string; remaining: LaneId[] };

/**
 * 尝试派发下一条待发 lane（每次最多一条，保证并发度不越界）。
 *
 * 并发名额判据：**在飞 lane 数 = 已派发且未终态的 lane 数** < concurrency。
 * 用实况而非计数器 ⇒ 无状态、可重入、主会话重启后仍正确。
 */
export function resumeQueuedLane(input: ResumeQueuedLaneInput): ResumeQueuedLaneOutcome {
	const q = readLaneQueue(input.meta.runDir);
	if (!q) return { resumed: false, reason: "no-queue" };
	if (q.lanes.length === 0) return { resumed: false, reason: "empty" };

	const inFlight = (Object.values(input.meta.lanes) as { tabRunId: string }[])
		.filter((l) => l.tabRunId && !laneTerminal(input.tabRunsDir, l.tabRunId)).length;
	if (inFlight >= input.concurrency) return { resumed: false, reason: "no-capacity" };

	const lane = q.lanes[0];
	const now = input.now ?? new Date();
	const wallMin = input.meta.laneWallClockMin;
	const deadline = new Date(Date.parse(input.meta.laneDeadlineAt));

	const r = dispatchDiagnoseLane({
		task: input.meta.task,
		runId: input.meta.runId,
		baseCommit: input.meta.baseCommit,
		repoRoot: input.meta.repoRoot,
		runDir: input.meta.runDir,
		wallClockMin: wallMin,
		lane,
		shortId: input.meta.shortId,
		repoName: input.meta.repoRoot.split(/[\\/]/).filter(Boolean).pop() ?? "repo",
		workerModel: input.workerModelFor(lane),
		now,
		wtExe: input.wtExe,
		piCli: input.piCli,
		spawnTab: input.spawnTab,
	});
	if (!r.ok) return { resumed: false, reason: "dispatch-failed", error: r.error };

	// 成功：移出队列 + 回写 meta 的 lane.tabRunId（供 collect 收集）+ 写计时器
	const remaining = q.lanes.slice(1);
	writeLaneQueue(input.meta.runDir, { lanes: remaining, concurrency: input.concurrency });
	writeLaneTimers(r.tabRunId, lane, deadline, now);

	const reread = input.rereadMeta ?? readTraceRunMeta;
	const fresh = reread(input.meta.runDir);
	if (fresh) {
		fresh.lanes[lane].tabRunId = r.tabRunId;
		writeFileSync(join(input.meta.runDir, "meta.json"), JSON.stringify(fresh, null, 2) + "\n", "utf8");
	}

	return { resumed: true, lane, tabRunId: r.tabRunId, title: r.title, remaining };
}
