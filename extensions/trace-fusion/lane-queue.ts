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
import { recordLink } from "../links.ts";
import { isProcessAlive } from "../runtime/liveness.ts";
import { laneFacts, SLOT_FREE_STATUSES } from "./lane-facts.ts";
import type { LaneId, TraceRunMeta } from "./types.ts";
import { dispatchDiagnoseLane, readTraceRunMeta, writeLaneTimers, type TabSpawner } from "./launch-workers.ts";
import { metaPath } from "./meta-path.ts";

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

/**
 * 某 lane 是否已**释放并发名额**（2026-11-03 修复）。
 *
 * 旧版此处目分 = `existsSync(<tabRunId>.result.json)`，与 `supervisor.ts` 的 `done`
 * 是**两份重复定义的判据**（正是任务书 ③ 要统一的那类重复）。
 * 现统一取自 `lane-facts.ts` 的 `SLOT_FREE_STATUSES`（单一来源）：
 * 自报终态才释放；**兜底生成的 unconfirmed 结果 + tab 还活着 ⇒ 不释放**（用户中止
 * 一条不得连锁起下一条）；进程已死（pid 探活 ∨ 心跳超阈）才兜底释放。
 */
function laneTerminal(
	meta: TraceRunMeta,
	tabRunsDir: string,
	lane: LaneId,
	isAlive: (pid: number) => boolean,
	now: () => number,
): boolean {
	const facts = laneFacts(meta, tabRunsDir, { now, isAlive });
	const f = facts.find((x) => x.lane === lane);
	return !!f && SLOT_FREE_STATUSES.has(f.status);
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
	/** 溯源链接落盘路径（测试注入；缺省走 links.ts 默认）。 */
	linksPath?: string;
	/** 判活 seam（测试注入）；缺省 = 真实 pid 探活。用于「unconfirmed 不得连锁续发」的判据。 */
	isAlive?: (pid: number) => boolean;
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

	const nowMs = input.now ? () => input.now!.getTime() : () => Date.now();
	const isAlive = input.isAlive ?? isProcessAlive;
	// 在飞数必须用**持锁后从盘上重读的 meta**（2026-11-03 L4 M1）：调用方传进来的 meta 是
	// 取锁之前的快照。两个驱动者先后取锁时，第二个若用旧快照，会把「刚被第一个派出去的
	// lane」当成未派发 ⇒ 在飞数算少 ⇒ 突破 laneConcurrency（串行实况变并行）。
	const meta = (input.rereadMeta ?? readTraceRunMeta)(input.meta.runDir) ?? input.meta;
	const inFlight = (Object.keys(meta.lanes) as LaneId[]).filter(
		(lane) => !!meta.lanes[lane].tabRunId && !laneTerminal(meta, input.tabRunsDir, lane, isAlive, nowMs),
	).length;
	if (inFlight >= input.concurrency) return { resumed: false, reason: "no-capacity" };

	const lane = q.lanes[0];
	const now = input.now ?? new Date();
	const wallMin = input.meta.laneWallClockMin;
	// **续发 lane 用自己的起跑期限**（2026-11-03 L4 M3 验实）：旧版直接复用 meta.laneDeadlineAt
	// = 首发时刻 + wallMin。串行下 B 在 A 之后才起跑，继承的是 A 的期限 ⇒ B 的两个墙钟提醒
	// 因已过期被跳过，B 第一次产生兜底结果就立刻被 deadline 判据释放名额（等于没给预算）。
	const deadline = new Date(nowMs() + wallMin * 60_000);

	const r = dispatchDiagnoseLane({
		task: meta.task,
		runId: meta.runId,
		baseCommit: meta.baseCommit,
		repoRoot: meta.repoRoot,
		runDir: meta.runDir,
		wallClockMin: wallMin,
		lane,
		shortId: meta.shortId,
		repoName: input.meta.repoRoot.split(/[\\/]/).filter(Boolean).pop() ?? "repo",
		workerModel: input.workerModelFor(lane),
		now,
		wtExe: input.wtExe,
		piCli: input.piCli,
		spawnTab: input.spawnTab,
	});
	if (!r.ok) {
		// 派发失败必须有出口（2026-11-03 L4 M4）：旧版直接返回 ⇒ 队首 lane 永久占位、
		// meta 无终态、原因不可见，run 卡在 running（队列门又禁止收集）。
		// 处置：把该 lane 记为 dispatch-failed 终态（进降级、不进分母）并移出队列，
		// 让后面的 lane 有机会；失败原因由 degradedFacts 带到用户面前。
		try {
			const fresh = (input.rereadMeta ?? readTraceRunMeta)(input.meta.runDir);
			if (fresh) {
				const slot = fresh.lanes[lane] as Record<string, unknown>;
				slot.laneStatus = "dispatch-failed";
				slot.laneStatusReason = `续发派发失败：${r.error ?? "未知原因"}`;
				writeFileSync(metaPath(input.meta.runDir), JSON.stringify(fresh, null, 2) + "\n", "utf8");
				writeLaneQueue(input.meta.runDir, { lanes: q.lanes.slice(1), concurrency: q.concurrency });
			}
		} catch { /* 尽力：写不动就保持原状，下一次事件再试 */ }
		return { resumed: false, reason: "dispatch-failed", error: r.error };
	}

	// 成功：移出队列 + 回写 meta 的 lane.tabRunId（供 collect 收集）+ 写计时器
	const remaining = q.lanes.slice(1);
	writeLaneQueue(input.meta.runDir, { lanes: remaining, concurrency: input.concurrency });
	// 本 lane 的期限落盘到 lane 自己的槽位（F3/M3）：判定与提醒都读它，不再继承 run 级期限
	try {
		const freshForDeadline = (input.rereadMeta ?? readTraceRunMeta)(input.meta.runDir);
		if (freshForDeadline) {
			const lane2 = freshForDeadline.lanes[lane] as Record<string, unknown> & { deadlineAt?: string };
			lane2.deadlineAt = deadline.toISOString();
			writeFileSync(metaPath(input.meta.runDir), JSON.stringify(freshForDeadline, null, 2) + "\n", "utf8");
		}
	} catch { /* 尽力：缺 deadlineAt 时判定回退 run 级期限 */ }
	writeLaneTimers(r.tabRunId, lane, deadline, now);

	// 溯源必须写在**拿到真实 tabRunId 的这一刻**。2026-11-02 实测：旧做法在派发时给三路
	// 一次性写链接，而串行模式下 B/C 当时还没 tabRunId ⇒ 落盘的是空 targetId 的死账
	// （links.jsonl 里 targetId 为空），lane 完成时 recipientSessionIdFor 查不到归属
	// ⇒ 落回「先到先得」+ master 影子信件 ⇒ 完成消息乱投递给 global master。
	if (input.meta.dispatcherSessionId) {
		recordLink(
			{
				sessionId: input.meta.dispatcherSessionId,
				kind: "tab",
				targetId: r.tabRunId,
				detail: `trace-fusion ${input.meta.runId} lane=${lane} resumed`,
			},
			input.linksPath ? { linksPath: input.linksPath } : undefined,
		);
	}

	const reread = input.rereadMeta ?? readTraceRunMeta;
	const fresh = reread(input.meta.runDir);
	if (fresh) {
		fresh.lanes[lane].tabRunId = r.tabRunId;
		writeFileSync(join(input.meta.runDir, "meta.json"), JSON.stringify(fresh, null, 2) + "\n", "utf8");
	}

	return { resumed: true, lane, tabRunId: r.tabRunId, title: r.title, remaining };
}
