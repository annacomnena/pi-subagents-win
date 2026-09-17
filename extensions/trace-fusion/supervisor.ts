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
import { readTabResultFile } from "../tab-runs.ts";
import { readTraceRunMeta } from "./launch-workers.ts";
import { defaultRunsDir, TRACE_LANES, type TraceRunMeta } from "./types.ts";

export type AutoCollectOutcome =
	| { isTrace: false }
	| { isTrace: true; phase: "progress"; runId: string; done: number }
	| { isTrace: true; phase: "already-done"; runId: string }
	| { isTrace: true; phase: "busy"; runId: string }
	| { isTrace: true; phase: "started"; runId: string; runDir: string };

export interface SupervisorOptions {
	runsDir?: string;
	tabRunsDir?: string;
	/** 子进程 spawn seam（测试注入）。默认 detached 后台进程。 */
	spawnWorker?: (entryScript: string, runId: string) => void;
}

/** claim 新鲜阈值：超过视为陈进程遗留，可重新认领（覆盖 lane 墙钟上限 45min + cross-test 余量）。 */
const CLAIM_FRESH_MS = 3 * 60 * 60 * 1000;

/** collect-worker 入口脚本路径（与本模块同目录）。 */
export function collectCliPath(): string {
	const here = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
	return join(here, "collect-cli.ts");
}

/** 后台 worker 默认实现。 */
function defaultSpawnWorker(entryScript: string, runId: string): void {
	const child = spawn(process.execPath, ["--experimental-strip-types", entryScript, runId], {
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

/** 对单个已知 running run 的收集决策（maybe 与 catch-up 共用）。 */
function outcomeForMeta(hit: TraceRunMeta, opts: SupervisorOptions, runsDir: string): AutoCollectOutcome {
	const tabRunsDir = opts.tabRunsDir ?? join(runsDir, "..", "tab-runs");
	const done = TRACE_LANES.filter((lane) => {
		const id = hit.lanes[lane].tabRunId;
		return id ? existsSync(join(tabRunsDir, `${id}.result.json`)) : false;
	}).length;
	if (done < TRACE_LANES.length) return { isTrace: true, phase: "progress", runId: hit.runId, done };

	if (existsSync(join(hit.runDir, "cross-test.json"))) {
		return { isTrace: true, phase: "already-done", runId: hit.runId };
	}
	if (!tryClaimCollect(hit.runDir)) {
		return { isTrace: true, phase: "busy", runId: hit.runId };
	}

	const spawnWorker = opts.spawnWorker ?? defaultSpawnWorker;
	spawnWorker(collectCliPath(), hit.runId);
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
export function catchUpAutoCollect(opts: SupervisorOptions = {}): Extract<AutoCollectOutcome, { phase: "started" }>[] {
	const runsDir = opts.runsDir ?? defaultRunsDir();
	const started: Extract<AutoCollectOutcome, { phase: "started" }>[] = [];
	if (!existsSync(runsDir)) return started;
	try {
		for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const meta = readTraceRunMeta(join(runsDir, entry.name));
			if (!meta || meta.status !== "running") continue;
			const outcome = outcomeForMeta(meta, opts, runsDir);
			if (outcome.phase === "started") started.push(outcome);
		}
	} catch { /* runsDir 异常 → 视为无可追赶 */ }
	return started;
}
