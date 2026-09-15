/**
 * trace-fusion/launch-workers.ts — run 编排与三 tab 派发（trace-fusion C6，设计稿 §15–§17）
 *
 * 编排序：preflight → runId/目录 → synthetic snapshot → 三 worktree + provisioning
 * → meta.json → 三次 tab 派发（tab-launch-core 原语 + trace-worker profile）→ lane 计时器。
 *
 * 依赖方向（§53）：只消费 tab-launch-core / capabilities / 本目录模块；
 * 绝不经 launch-tabs workflow prompt builder。spawn 走注入 seam（默认真 spawnPiTab），
 * 集成测试可注入 fake（无 Windows Terminal 也能测编排逻辑）。
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { randomBytes } from "node:crypto";
import {
	type TabSpawnResult,
	spawnPiTab,
} from "../tab-launch-core.ts";
import { defaultTabRunsDir, newTabRunId, writeTabDispatch, type TabDispatchRecord } from "../tab-runs.ts";
import { runPreflight } from "./preflight.ts";
import { createSyntheticSnapshot } from "./snapshot.ts";
import { createLaneWorktrees, removeWorktreeRetry, writeProvisionReport, type ProvisionReport } from "./worktrees.ts";
import { defaultRunsDir, defaultWorktreeRoot, TRACE_LANES, type LaneId, type TraceFusionConfig } from "./types.ts";
import { buildTraceWorkerPrompt } from "./worker-prompt.ts";

/** spawn seam：默认真 spawnPiTab；测试注入 fake。签名与 spawnPiTab 一致。 */
export type TabSpawner = (opts: Parameters<typeof spawnPiTab>[0]) => TabSpawnResult;

export interface LaunchTraceRunInput {
	task: string;
	repoRoot: string;
	/** 已解析的环境（命令 handler 负责 findWindowsTerminal/findPiCli）。 */
	wtExe: string;
	piCli: string;
	config: TraceFusionConfig;
	runsDir?: string;
	wtRoot?: string;
	now?: Date;
	spawnTab?: TabSpawner;
}

export interface TraceLaneMeta {
	lane: LaneId;
	worktree: string;
	tabRunId: string;
	provision: ProvisionReport;
}

export interface TraceRunMeta {
	runId: string;
	shortId: string;
	status: "running";
	task: string;
	repoRoot: string;
	createdAt: string;
	baseCommit: string;
	headBefore: string;
	runDir: string;
	wtDir: string;
	laneWallClockMin: number;
	laneDeadlineAt: string;
	lanes: Record<LaneId, TraceLaneMeta>;
}

export type LaunchTraceRunResult =
	| { ok: true; meta: TraceRunMeta; lines: string[] }
	| { ok: false; error: string; lines?: string[] };

/** runId：tfl-<yyyymmdd>-<hhmmss>-<4hex>；shortId 去前缀，用作 wt 短路径目录名。 */
export function newTraceRunId(now: Date = new Date()): { runId: string; shortId: string } {
	const p = (n: number) => String(n).padStart(2, "0");
	const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
	const hex = randomBytes(2).toString("hex");
	return { runId: `tfl-${stamp}-${hex}`, shortId: `${stamp}-${hex}` };
}

function metaPath(runDir: string): string {
	return join(runDir, "meta.json");
}

export function readTraceRunMeta(runDir: string): TraceRunMeta | null {
	if (!existsSync(metaPath(runDir))) return null;
	try {
		return JSON.parse(readFileSync(metaPath(runDir), "utf8")) as TraceRunMeta;
	} catch {
		return null;
	}
}

export function launchTraceRun(input: LaunchTraceRunInput): LaunchTraceRunResult {
	const lines: string[] = [];
	const runsDir = input.runsDir ?? defaultRunsDir();
	const wtRoot = input.wtRoot ?? defaultWorktreeRoot();
	const now = input.now ?? new Date();
	const spawnTab = input.spawnTab ?? ((opts) => spawnPiTab(opts));

	// 1. preflight（§14.2：含单 active run 互斥）
	const pf = runPreflight(input.repoRoot, { runsDir, maxActiveRuns: input.config.maxActiveRuns });
	if (!pf.ok) return { ok: false, error: pf.blockingReason ?? "preflight 未通过", lines };
	if (!pf.toplevel || !pf.head) return { ok: false, error: "preflight 未返回 toplevel/HEAD", lines };
	const repoRoot = pf.toplevel;

	// 2. runId + 目录（artifact 长路径 / worktree 短路径，§15）
	const { runId, shortId } = newTraceRunId(now);
	const runDir = join(runsDir, runId);
	const wtDir = join(wtRoot, shortId);
	mkdirSync(runDir, { recursive: true });

	// 3. synthetic snapshot（§13–§14）
	let snap;
	try {
		snap = createSyntheticSnapshot(repoRoot, join(runDir, "base"));
	} catch (err) {
		return { ok: false, error: `snapshot 失败：${(err as Error).message}`, lines };
	}
	lines.push(`base snapshot：${snap.baseCommit.slice(0, 12)}（HEAD ${snap.headBefore.slice(0, 12)}，dirty ${snap.porcelain ? "已折叠" : "无"}）`);

	// 4. 三 worktree + provisioning（§16/§16.1）——部分失败即整体回滚（v0.3 不允许残缺 run）
	const created = createLaneWorktrees(snap.baseCommit, wtDir, repoRoot, TRACE_LANES, repoRoot, input.config.provisioning);
	if (created.errors.length > 0 || created.lanes.length !== TRACE_LANES.length) {
		for (const l of created.lanes) removeWorktreeRetry(l.worktree, repoRoot, { attempts: 2, baseDelayMs: 100 });
		return { ok: false, error: `worktree 创建失败：${created.errors.join("; ")}`, lines };
	}
	lines.push(`worktrees：${wtDir}/{${TRACE_LANES.map((l) => l.toLowerCase()).join(",")}}`);
	const degradedLanes = created.lanes.filter((l) => l.provision.degraded);
	if (degradedLanes.length > 0) {
		lines.push(`⚠ 供给降级：${degradedLanes.map((l) => l.lane).join("/")}（${degradedLanes.flatMap((l) => l.provision.issues).join("; ").slice(0, 200)}）`);
	}

	// 5. meta.json（§24.1：磁盘是唯一真相源）
	const wallMin = input.config.maxWallClockPerLaneMin;
	const deadline = new Date(now.getTime() + wallMin * 60_000);
	const lanes = {} as Record<LaneId, TraceLaneMeta>;
	for (const l of created.lanes) {
		lanes[l.lane] = { lane: l.lane, worktree: l.worktree, tabRunId: "", provision: l.provision };
		writeProvisionReport(join(runDir, "lanes", l.lane), l.provision);
	}
	const meta: TraceRunMeta = {
		runId,
		shortId,
		status: "running",
		task: input.task.trim(),
		repoRoot,
		createdAt: now.toISOString(),
		baseCommit: snap.baseCommit,
		headBefore: snap.headBefore,
		runDir,
		wtDir,
		laneWallClockMin: wallMin,
		laneDeadlineAt: deadline.toISOString(),
		lanes,
	};
	writeFileSync(metaPath(runDir), JSON.stringify(meta, null, 2) + "\n", "utf8");

	// 6. 三 tab 派发（§17：同一个 task、只差 lane metadata；不经 workflow builder）
	const repoName = basename(repoRoot);
	const dispatchErrors: string[] = [];
	for (const lane of TRACE_LANES) {
		const laneMeta = lanes[lane];
		const prompt = buildTraceWorkerPrompt({
			task: input.task,
			runId,
			lane,
			baseCommit: snap.baseCommit,
			worktree: laneMeta.worktree,
			runDir,
			wallClockMin: wallMin,
			degraded: laneMeta.provision.degraded,
		});
		const laneRunId = newTabRunId(now);
		const taskId = `${shortId}-L${lane}`;
		const title = `[TRACE ${lane}] ${repoName}-${taskId}`;
		const dispatch: TabDispatchRecord = {
			id: laneRunId,
			version: 1,
			taskId,
			mode: "trace",
			title,
			cwd: laneMeta.worktree,
			requestedModel: input.config.workerModel,
			dispatchedAt: new Date().toISOString(),
			dispatchStatus: "dispatched",
		};
		// 账本写入 tab-runs 目录（tab-status/reclaim-tabs 从那里读），而非 trace runs dir
		writeTabDispatch(defaultTabRunsDir(), dispatch);
		const spawn = spawnTab({
			wtPath: input.wtExe,
			piCli: input.piCli,
			cwd: laneMeta.worktree,
			title,
			prompt,
			model: input.config.workerModel,
			tabRunId: laneRunId,
			sessionProfile: "trace-worker",
			traceRunId: runId,
			traceLane: lane,
		});
		if (spawn.error) {
			dispatchErrors.push(`lane ${lane}：${spawn.error}`);
			writeTabDispatch(defaultTabRunsDir(), { ...dispatch, dispatchStatus: "launch_failed", error: spawn.error });
			continue;
		}
		laneMeta.tabRunId = laneRunId;
		lines.push(`TRACE ${lane}：${title} [${laneRunId}]`);
	}

	// 7. 派发结果回写 meta（tabRunId 是 C7 collect 的探针句柄）
	// 全部派发失败视为 run 失败：回滚 worktrees，meta 标 failed
	const dispatched = TRACE_LANES.filter((l) => lanes[l].tabRunId);
	if (dispatched.length === 0) {
		for (const l of TRACE_LANES) removeWorktreeRetry(lanes[l].worktree, repoRoot, { attempts: 2, baseDelayMs: 100 });
		const failed = { ...meta, status: "failed" as const };
		writeFileSync(metaPath(runDir), JSON.stringify(failed, null, 2) + "\n", "utf8");
		return { ok: false, error: `三个 tab 全部派发失败：${dispatchErrors.join("; ")}`, lines };
	}
	writeFileSync(metaPath(runDir), JSON.stringify({ ...meta, lanes }, null, 2) + "\n", "utf8");
	if (dispatchErrors.length > 0) lines.push(`⚠ ${dispatchErrors.length} 个 lane 派发失败（run 降级 ${dispatched.length}/3）：${dispatchErrors.join("; ")}`);
	lines.push(`deadline：${meta.laneDeadlineAt}（${wallMin}min/lane，超时 lane 判 failed 走降级语义）`);

	return { ok: true, meta: { ...meta, lanes }, lines };
}
