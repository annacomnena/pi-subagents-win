/**
 * trace-fusion/supervisor.ts — 主会话侧自动收集编排（真实运行驱动，2026-09-15）
 *
 * §24.1：event bus 唤醒是加速器。两条触发路径汇入同一决策：
 *   1. lane tab tab-finish → event-bus onTabFinished → maybeAutoCollectTraceRun(tabRunId)
 *   2. 主会话 session_start → catchUpAutoCollect()——覆盖「三路全部在无主会话时完成」：
 *      重启后 snapshotExisting 把既有 result.json 标 seen，watcher 不再触发，靠这里补
 *
 * 决策结果：
 *   - 非 trace tab / 无 running run → 交回默认 toast/reclaim 流程
 *   - 未全终态 → 静默
 *   - 三路全终态 → 后台子进程跑 collect + deterministic cross-test（不阻塞 TUI），
 *     完成后 meta 终态化，/trace-fusion-status 可查
 *   - 已有报告或已被认领 → 幂等跳过（claim 文件防双 spawn）
 *
 * 为什么后台子进程：cross-test 含真实 build/test（10-30 分钟级），
 * spawnSync 在扩展主线程会冻住整个 TUI。
 */

import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { sessionScopeKey } from "../identity.ts";
import { readTabResultFile } from "../tab-runs.ts";
import { spawnPiTab } from "../tab-launch-core.ts";
import { readTraceFusionConfig } from "./config.ts";
import { readLaneQueue, resumeQueuedLane, type ResumeQueuedLaneOutcome } from "./lane-queue.ts";
import { readTraceRunMeta } from "./launch-workers.ts";
import { isProcessAlive } from "../runtime/liveness.ts";
import type { LaneFacts } from "./lane-facts.ts";
import { laneFacts, degradedFacts, seedDispatchState, TERMINAL_LANE_STATUSES, writeDegradedLanes } from "./lane-facts.ts";
import { defaultRunsDir, TRACE_LANES, type LaneId, type TraceRunMeta } from "./types.ts";

export type AutoCollectOutcome =
	| { isTrace: false }
	| { isTrace: true; phase: "progress"; runId: string; done: number; laneFacts?: LaneFacts[] }
	| { isTrace: true; phase: "already-done"; runId: string }
	| { isTrace: true; phase: "busy"; runId: string }
	/**
	 * laneConcurrency 续发了一条待发 lane（**不是**三路终态）。
	 * 2026-11-02 拆分：旧版续发与真 collect 共用 "started"，导致调用方
	 * 只要看到 "started" 就发「三路终态 + cross-test 已启动」——lane A 刚完、
	 * lane B 刚派、lane C 还在队列时这条文案就不再是真相（实测两路会话都收到误报）。
	 * 文案与消费者必须按 phase 区分，不得再用 "started" 代表「刚续发」。
	 */
	| { isTrace: true; phase: "resumed"; runId: string; lane: LaneId; tabRunId: string; remaining: LaneId[] }
	/** 三路已全部终态且 cross-test 真的已 spawn（唯一可声称「三路终态」的相位）。 */
	| { isTrace: true; phase: "started"; runId: string; runDir: string }
	/**
	 * 该 tab 属于 trace run，但**本会话不是派发者**。
	 *
	 * 必须报为「已消费」而不是 `{isTrace:false}`：后者会让调用方落回默认流程
	 * （toast + reclaim 注入），完成消息就会投递给 global master。
	 * 2026-11-02 实测：无 links 归属的 lane tab 就是靠这条路乱投的（a726 单会话内重复 3 次）。
	 */
	| { isTrace: true; phase: "foreign"; runId: string };

export interface SupervisorOptions {
	/** 时钟 seam（测试注入）。 */
	now?: () => number;
	/** 进程存活探针 seam（测试注入）；缺省 = 真实 `process.kill(pid,0)`。 */
	isAlive?: (pid: number) => boolean;
	runsDir?: string;
	tabRunsDir?: string;
	/** 子进程 spawn seam（测试注入）。默认 detached 后台进程。 */
	spawnWorker?: (entryScript: string, runId: string, piCli?: string) => void;
	/** laneConcurrency 续发所需：wt / pi CLI 路径（由调用方注入，避免反向依赖 index.ts）。 */
	wtExe?: string;
	piCli?: string;
	/** tab spawn seam（续发用；测试注入 fake）。 */
	spawnTab?: (opts: Parameters<typeof spawnPiTab>[0]) => ReturnType<typeof spawnPiTab>;
	/** 会话身份 seam（测试注入）：不传则用真实的 sessionScopeKey()。 */
	sessionScopeKey?: () => string | undefined;
}

/** claim 新鲜阈值：超过视为陈进程遗留，可重新认领（覆盖 lane 墙钟上限 45min + cross-test 余量）。 */
const CLAIM_FRESH_MS = 3 * 60 * 60 * 1000;

/**
 * laneConcurrency 续发（2026-10-30）：若该 run 有待发 lane 且并发名额空出，派下一条。
 *
 * 只读磁盘状态（lane-queue.json + 各 lane 的 result.json）⇒ 无内存态、可重入、重启后正确。
 * 任何异常（无队列/无名额/派发失败）一律静默回 false，**不影响收集主流程**。
 */
/**
 * laneConcurrency 续发（带跨进程锁）。
 *
 * 2026-11-02 修正两个缺陷：
 *  1. 返回 outcome 而非 boolean——调用方需要 lane/tabRunId/remaining 拼真实文案，
 *     旧版只能猜「发生了什么」，结果只能发「三路终态」（实测误报两次）。
 *  2. **加跨进程锁**。旧版 resumeQueuedLane 无锁：若两个主会话的 event-bus
 *     同时看到 lane A 完成，都会读到队列 ["B","C"]、都判定有名额、各自 spawn
 *     一条 B（撞 KV 池）+ 最后写入者覆盖 lane-queue.json ⇒ 幽灵 tabRunId。
 *     锁与 tryClaimCollect 同族（'wx' 独占 + 新鲜度接管），但用**独立文件**
 *     `resume.claim`：二者时机不同（续发发生在 collect 之前），不能共用一个锁。
 */
function tryResumeQueuedLane(
	hit: TraceRunMeta,
	opts: SupervisorOptions,
	tabRunsDir: string,
	queue?: ReturnType<typeof readLaneQueue>,
): { outcome: Extract<ResumeQueuedLaneOutcome, { resumed: true }> } | null {
	try {
		const q = queue ?? readLaneQueue(hit.runDir);
		if (!q || q.lanes.length === 0) return null;
		// 无注入的 wt/pi 路径 ⇒ 不猜、不续发（宁可不派，也不拿错路径 spawn）
		if (!opts.wtExe || !opts.piCli) return null;
		// 跨进程互斥：抢不到 ⇒ 另一个会话正在续发这一条，本轮不重复派。
		if (!tryClaimResume(hit.runDir, { now: opts.now })) return null;
		const cfg = readTraceFusionConfig();
		const resumed = resumeQueuedLane({
			meta: hit,
			tabRunsDir,
			concurrency: q.concurrency,
			wtExe: opts.wtExe,
			piCli: opts.piCli,
			// 续发时**不看** per-call 覆盖（那份只属首次 launch 调用），只用 config。
			workerModelFor: (lane) => cfg.workerModelByLane?.[lane] ?? cfg.workerModel,
			spawnTab: opts.spawnTab ?? ((o) => spawnPiTab(o)),
		});
		return resumed.resumed ? { outcome: resumed } : null;
	} catch {
		return null; // best-effort：续发失败不得阻断收集
	}
}

/** 续发锁的新鲜度窗口：远短于 collect 锁——续发是同步短动作（读队列 + spawn）。 */
const RESUME_CLAIM_FRESH_MS = 90_000;

/** 原子认领续发权：'wx' 独占；已存在但新鲜 → false；陈旧 → 接管。 */
function tryClaimResume(runDir: string, opts: { now?: () => number } = {}): boolean {
	const claimPath = join(runDir, "resume.claim");
	const payload = `${JSON.stringify({ pid: process.pid, at: new Date(opts.now?.() ?? Date.now()).toISOString() })}\n`;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			writeFileSync(claimPath, payload, { flag: "wx" });
			return true;
		} catch {
			try {
				const prev = JSON.parse(readFileSync(claimPath, "utf8")) as { at?: string };
				const nowMs = opts.now?.() ?? Date.now();
				if (prev.at && nowMs - Date.parse(prev.at) <= RESUME_CLAIM_FRESH_MS) return false;
			} catch {
				return false; // 解析不了 → 保守当作别人持有
			}
			try {
				rmSync(claimPath);
			} catch {
				return false;
			}
		}
	}
	return false;
}

/** collect-worker 入口脚本路径（与本模块同目录）。 */
export function collectCliPath(): string {
	const here = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
	return join(here, "collect-cli.ts");
}

/** 后台 worker 默认实现。第三参 = pi CLI 路径（fusion 消费链需要，2026-11-02）。 */
function defaultSpawnWorker(entryScript: string, runId: string, piCli?: string): void {
	const child = spawn(process.execPath, ["--experimental-strip-types", entryScript, runId, ...(piCli ? [piCli] : [])], {
		detached: true,
		stdio: "ignore",
		windowsHide: true,
	});
	child.unref();
}

/** 原子认领收集权：'wx' 独占创建；已存在但新鲜 → false；陈旧 → 接管。 */
function tryClaimCollect(runDir: string): boolean {
	const claimPath = join(runDir, "collect-worker.claim");
	const payload = `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			writeFileSync(claimPath, payload, { flag: "wx" });
			return true;
		} catch {
			// 已存在 → 检查新鲜度
			try {
				const prev = JSON.parse(readFileSync(claimPath, "utf8")) as { at?: string };
				if (prev.at && Date.now() - Date.parse(prev.at) <= CLAIM_FRESH_MS) return false;
			} catch {
				return false; // 解析不了 → 保守当作别人持有
			}
			try {
				rmSync(claimPath);
			} catch {
				return false;
			}
		}
	}
	return false;
}

/**
 * 本会话是否有权驱动这个 run（续发 / collect / 通知）。
 *
 * 2026-11-02 修缺陷：`isMainSession()` 让所有非 tab 会话都 watch 同一个全局 `tab-runs/`，
 * 于是 home 会话与本仓会话同时收到同一个 run 的通知（实测 a726 两路各一份、
 * 单会话内还重复 2–3 次）。旧 meta 没有归属字段，无法判定。
 *
 * 判定规则（保守，零回归）：
 *   - meta 无 dispatcherSessionId（存量 run / 未记录） → **放行**（legacy 行为不变）
 *   - 有字段且本进程指纹匹配 → 放行
 *   - 有字段但本进程无指纹（异常环境） → 放行（不因拿不到身份而静默丢掉编排）
 *   - 有字段且指纹不匹配 → **拒绝**（这条 run 不归本会话）
 */
export function isDispatcherSession(meta: TraceRunMeta, opts?: { sessionScopeKey?: () => string | undefined }): boolean {
	const owner = meta.dispatcherSessionId;
	if (!owner) return true; // 存量 run：无归属信息，保持 legacy
	let me: string | undefined;
	try {
		me = (opts?.sessionScopeKey ?? sessionScopeKey)();
	} catch {
		return true;
	}
	if (!me) return true;
	return me === owner;
}

/** 对单个已知 running run 的收集决策（maybe 与 catch-up 共用）。 */
function outcomeForMeta(hit: TraceRunMeta, opts: SupervisorOptions, runsDir: string): AutoCollectOutcome {
	const tabRunsDir = opts.tabRunsDir ?? join(runsDir, "..", "tab-runs");
	// 待发队列：**在队的 lane 尚未派发，不得进入收集分母**（否则「A 完、B 刚派、C 在队」
	// 会被当作全部终态）。续发段之后还要用同一份队列快照。
	const queue = readLaneQueue(hit.runDir);
	const queuePending = new Set(queue?.lanes ?? []);
	const factsOf = () => laneFacts(hit, tabRunsDir, { now: opts.now, isAlive: opts.isAlive, queuePending });
	let facts = factsOf();
	// 分母 = 预期参与的 lane：skipped / dispatch-failed / 在队待发 都不进分母。
	// 旧 meta（无 laneStatus 且无队列）⇒ 三路全参与，零回归。
	const participating = TRACE_LANES.filter((lane) => {
		const f = facts.find((x) => x.lane === lane);
		return f?.status === "done" || f?.status === "running";
	});
	const expectedIds = participating.map((lane) => hit.lanes[lane].tabRunId).filter((id) => id !== "");
	const done = expectedIds.filter((id) => existsSync(join(tabRunsDir, `${id}.result.json`))).length;

	// ── laneConcurrency 续发（2026-10-30）：未全终态时才可能要派下一条 ──
	// 队列文件不存在 ⇒ 历史全并发行为，本段零作用（不碰存量路径）。
	// 2026-11-02 修正：续发成功**不得**返回 "started"——那时 B 才刚跑、C 还在队列；
	// 调用方会据此声称「三路终态 + cross-test 已启动」（已两次误报）。分离为 "resumed"。
	if (done < TRACE_LANES.length) {
		const resumed = tryResumeQueuedLane(hit, opts, tabRunsDir, queue);
		if (resumed && resumed.outcome.resumed) {
			facts = factsOf(); // 续发后重取：新派的 lane 现在才进分母
			return {
				isTrace: true,
				phase: "resumed",
				runId: hit.runId,
				lane: resumed.outcome.lane,
				tabRunId: resumed.outcome.tabRunId,
				remaining: resumed.outcome.remaining,
			};
		}
	}

	const factsSummary = degradedFacts(facts);

	if (done < expectedIds.length) return { isTrace: true, phase: "progress", runId: hit.runId, done, laneFacts: factsSummary };

	// 参与 lane 已全部终态 ⇒ 可收集。有 lane 不可用（skipped/dispatch-failed/进程死）时
	// 降级收集，并把降级原因写进 meta（不得静默，AGENTS.md R-2）。
	if (factsSummary.length > 0) {
		writeDegradedLanes(hit, facts, opts.now);
	}
	if (existsSync(join(hit.runDir, "cross-test.json"))) {
		return { isTrace: true, phase: "already-done", runId: hit.runId };
	}
	if (!tryClaimCollect(hit.runDir)) {
		return { isTrace: true, phase: "busy", runId: hit.runId };
	}

	const spawnWorker = opts.spawnWorker ?? defaultSpawnWorker;
	spawnWorker(collectCliPath(), hit.runId, opts.piCli);
	return { isTrace: true, phase: "started", runId: hit.runId, runDir: hit.runDir };
}

/**
 * lane 终态回调的决策函数：该 tabRunId 是否属于 trace run、是否可自动收集。
 * 纯决策 + spawn seam，单测锁定；真实 spawn 只在默认分支发生。
 */
export function maybeAutoCollectTraceRun(finishedTabRunId: string, opts: SupervisorOptions = {}): AutoCollectOutcome {
	const runsDir = opts.runsDir ?? defaultRunsDir();
	if (!existsSync(runsDir)) return { isTrace: false };
	let hit: TraceRunMeta | null = null;
	try {
		for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const meta = readTraceRunMeta(join(runsDir, entry.name));
			if (!meta || meta.status !== "running") continue;
			if (TRACE_LANES.some((lane) => meta.lanes[lane]?.tabRunId === finishedTabRunId)) {
				// 归属过滤（2026-11-02）：非派发者会话不得续发/collect/通知。
				// 但**不得**返回 {isTrace:false}——那等于让调用方把 lane tab 当普通 tab
				// 走默认注入，完成消息会落到 global master（实测乱回）。
				if (!isDispatcherSession(meta, opts.sessionScopeKey ? { sessionScopeKey: opts.sessionScopeKey } : undefined)) {
					return { isTrace: true, phase: "foreign", runId: meta.runId };
				}
				hit = meta;
				break;
			}
		}
	} catch {
		return { isTrace: false };
	}
	if (!hit) return { isTrace: false };
	return outcomeForMeta(hit, opts, runsDir);
}

/**
 * session_start 追赶：扫描全部 running run，凡三路已终态且未出报告的 → 后台补收集。
 * 返回所有 started 的 outcome（供调用方通知用户）；其 余 phase 不上报。
 */
export function catchUpAutoCollect(
	opts: SupervisorOptions = {},
): Extract<AutoCollectOutcome, { phase: "started" | "resumed" }>[] {
	const runsDir = opts.runsDir ?? defaultRunsDir();
	const started: Extract<AutoCollectOutcome, { phase: "started" | "resumed" }>[] = [];
	if (!existsSync(runsDir)) return started;
	try {
		for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const meta = readTraceRunMeta(join(runsDir, entry.name));
			if (!meta || meta.status !== "running") continue;
			// 归属过滤：追赶只能由派发者会话做（否则任一新开的主会话都去扫全局 run）
			if (!isDispatcherSession(meta, opts.sessionScopeKey ? { sessionScopeKey: opts.sessionScopeKey } : undefined)) continue;
			const outcome = outcomeForMeta(meta, opts, runsDir);
			// 续发也要上报（2026-11-02）：旧版只返回 "started"，续发作为副作用发生但调用方看不见
			// ⇒ 追赶时派了一条 lane 不会告知任何人，而文案只会说「三路已终态」。
			if (outcome.phase === "started" || outcome.phase === "resumed") started.push(outcome);
		}
	} catch { /* runsDir 异常 → 视为无可追赶 */ }
	return started;
}
