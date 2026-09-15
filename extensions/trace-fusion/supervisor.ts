/**
 * trace-fusion/supervisor.ts — 主会话侧自动收集编排（真实运行驱动，2026-09-15）
 *
 * §24.1：event bus 唤醒是加速器。lane tab tab-finish 时主会话进程的
 * onTabFinished 钩子（event-bus）调用 maybeAutoCollectTraceRun：
 *   - 非 trace tab → 交回默认 toast/reclaim 流程
 *   - 未全终态 → 静默记录进度
 *   - 三路全终态 → 后台子进程跑 collect + deterministic cross-test（不阻塞 TUI），
 *     完成后 meta 终态化，/trace-fusion-status 可查
 *
 * 为什么后台子进程：cross-test 含真实 build/test（10-30 分钟级），
 * spawnSync 在扩展主线程会冻住整个 TUI。
 */

import { existsSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { readTabResultFile } from "../tab-runs.ts";
import { readTraceRunMeta } from "./launch-workers.ts";
import { defaultRunsDir, TRACE_LANES, type TraceRunMeta } from "./types.ts";

export type AutoCollectOutcome =
	| { isTrace: false }
	| { isTrace: true; phase: "progress"; runId: string; done: number }
	| { isTrace: true; phase: "already-done"; runId: string }
	| { isTrace: true; phase: "started"; runId: string; runDir: string };

export interface SupervisorOptions {
	runsDir?: string;
	tabRunsDir?: string;
	/** 子进程 spawn seam（测试注入）。默认 detached 后台进程。 */
	spawnWorker?: (entryScript: string, runId: string) => void;
}

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

	const tabRunsDir = opts.tabRunsDir ?? join(runsDir, "..", "tab-runs");
	const done = TRACE_LANES.filter((lane) => {
		const id = hit!.lanes[lane].tabRunId;
		return id ? existsSync(join(tabRunsDir, `${id}.result.json`)) : false;
	}).length;
	if (done < TRACE_LANES.length) return { isTrace: true, phase: "progress", runId: hit.runId, done };

	if (existsSync(join(hit.runDir, "cross-test.json"))) {
		return { isTrace: true, phase: "already-done", runId: hit.runId };
	}

	const spawnWorker = opts.spawnWorker ?? defaultSpawnWorker;
	spawnWorker(collectCliPath(), hit.runId);
	return { isTrace: true, phase: "started", runId: hit.runId, runDir: hit.runDir };
}
