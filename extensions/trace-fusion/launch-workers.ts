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

import { mkdirSync, writeFileSync, existsSync, readFileSync, appendFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { randomBytes } from "node:crypto";
import {
	type TabSpawnResult,
	spawnPiTab,
} from "../tab-launch-core.ts";
import { defaultTabRunsDir, newTabRunId, writeTabDispatch, type TabDispatchRecord } from "../tab-runs.ts";
import { defaultTimersDir, mailboxDirForTab, newTimerId, dueAtFromDelay, validateTimerRecord, writeTimerAtomic, type TimerRecord } from "../timers.ts";
import { runPreflight } from "./preflight.ts";
import { execGit } from "./git.ts";
import { createSyntheticSnapshot } from "./snapshot.ts";
import { createLaneWorktrees, removeWorktreeRetry, writeProvisionReport, type ProvisionReport } from "./worktrees.ts";
import { defaultRunsDir, defaultWorktreeRoot, TRACE_LANES, type LaneId, type TraceFusionConfig } from "./types.ts";
import { buildTraceWorkerPrompt, buildDiagnoseWorkerPrompt } from "./worker-prompt.ts";
import { ensureDirTrusted } from "./trust.ts";

/** spawn seam：默认真 spawnPiTab；测试注入 fake。签名与 spawnPiTab 一致。 */
export type TabSpawner = (opts: Parameters<typeof spawnPiTab>[0]) => TabSpawnResult;

/** 异步 spawn 已失败的 lane runId（writeLaneTimers 的竞态守卫）。 */
const spawnFailedLanes = new Set<string>();

/** §17：trace worker tab 的工具排除名单（wiki/timer/launch 写能力不可见；subagent-win 保留）。 */
export const TRACE_WORKER_EXCLUDE_TOOLS = ["launch-tabs", "set-timer", "cancel-timer", "list-timers", "wiki-nav", "wiki-semantic"];

/**
 * §24.2：向 lane tab 邮箱写两个墙钟计时器——
 *   deadline-5min「即将超时，收敛证据」；deadline「立即 tab-finish」。
 * 仅提醒不强制；真正的超时判定在 collect（timedOut）。
 */
export function writeLaneTimers(tabRunId: string, lane: LaneId, deadline: Date, now: Date): void {
	// review 复核修正（Luna minor）：异步 spawn 已失败的 lane 不写邮箱计时器
	if (spawnFailedLanes.has(tabRunId)) return;
	try {
		const timersDir = defaultTimersDir();
		const reminderAt = new Date(deadline.getTime() - 5 * 60_000);
		const entries: { dueAt: Date; message: string; label: string }[] = [
			{
				dueAt: reminderAt,
				message: `⏳ TRACE ${lane} 将在 5 分钟后到达墙钟时限。停止开新战线，立即把已有证据写入 trajectory.md / validation.json，然后 tab-finish。`,
				label: `trace ${lane} deadline reminder`,
			},
			{
				dueAt: deadline,
				message: `🛑 TRACE ${lane} 已到墙钟时限。立即调用 tab-finish（status 按实际完成度，failed 也必须上报）。超时后 supervisor 将按部分修改收集证据。`,
				label: `trace ${lane} deadline`,
			},
		];
		for (const e of entries) {
			if (e.dueAt.getTime() <= now.getTime()) continue; // run 已晚于该时点则不再排
			const record: TimerRecord = {
				id: newTimerId(now),
				version: 1,
				dueAt: dueAtFromDelay(Math.max(0, e.dueAt.getTime() - now.getTime()), now),
				message: e.message,
				target: { tabRunId },
				source: "trace-fusion-loop",
				label: e.label,
				status: "pending",
				createdAt: now.toISOString(),
			};
			const check = validateTimerRecord(record);
			if (check.ok && check.value) writeTimerAtomic(timersDir, check.value, { tabRunId });
		}
	} catch {
		// 计时器属加速器而非正确性依赖（§24.1）；写失败不影响派发
	}
}

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
	/** run 模式（2026-09-17）：diagnose 只读诊断（默认）| implement worktree 读写实现。 */
	mode: "diagnose" | "implement";
	task: string;
	repoRoot: string;
	createdAt: string;
	baseCommit: string;
	headBefore: string;
	runDir: string;
	/** worktree 根目录；diagnose 模式为空串（不开 worktree）。 */
	wtDir: string;
	laneWallClockMin: number;
	laneDeadlineAt: string;
	lanes: Record<LaneId, TraceLaneMeta>;
	/** diagnose 模式：启动时主仓库 porcelain 基线文件路径（collect 时对比检违规写入）。 */
	dirtyBaselineFile?: string;
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

const noopProvision = (): ProvisionReport => ({ junction: [], copied: [], commandOk: true, degraded: false, issues: [] });

export function launchTraceRun(input: LaunchTraceRunInput): LaunchTraceRunResult {
	const lines: string[] = [];
	const runsDir = input.runsDir ?? defaultRunsDir();
	const wtRoot = input.wtRoot ?? defaultWorktreeRoot();
	const now = input.now ?? new Date();
	const spawnTab = input.spawnTab ?? ((opts) => spawnPiTab(opts));
	const mode = input.config.mode ?? "diagnose";

	// 1. preflight（§14.2：含单 active run 互斥）
	const pf = runPreflight(input.repoRoot, { runsDir, maxActiveRuns: input.config.maxActiveRuns });
	if (!pf.ok) return { ok: false, error: pf.blockingReason ?? "preflight 未通过", lines };
	if (!pf.toplevel || !pf.head) return { ok: false, error: "preflight 未返回 toplevel/HEAD", lines };
	const repoRoot = pf.toplevel;

	// 2. runId + 目录（artifact 长路径 / worktree 短路径，§15）
	const { runId, shortId } = newTraceRunId(now);
	const runDir = join(runsDir, runId);
	const wtDir = mode === "implement" ? join(wtRoot, shortId) : "";
	mkdirSync(runDir, { recursive: true });

	// ── diagnose 分支（2026-09-17）：零写入主仓库——不 snapshot、不开 worktree、不预信任；
	// lane 直接在主仓库只读诊断，产出诊断+方案，交主会话融合后单次实现。
	if (mode === "diagnose") {
		const base = execGit(["rev-parse", "HEAD"], { cwd: repoRoot });
		if (base.status !== 0) return { ok: false, error: `rev-parse HEAD 失败：${base.stderr}`, lines };
		const baseCommit = base.stdout.trim();
		const porcelain = execGit(["status", "--porcelain=v1"], { cwd: repoRoot });
		const baselineFile = join(runDir, "dirty-baseline.txt");
		writeFileSync(baselineFile, porcelain.stdout, "utf8");
		lines.push(`diagnose 模式：只读诊断主仓库 @ ${baseCommit.slice(0, 12)}（基线 ${porcelain.stdout.split("\n").filter((l) => l.trim()).length} 条脏项，不折叠不触碰）`);

		const wallMin = input.config.maxWallClockPerLaneMin;
		const deadline = new Date(now.getTime() + wallMin * 60_000);
		const lanes = {} as Record<LaneId, TraceLaneMeta>;
		for (const lane of TRACE_LANES) {
			lanes[lane] = { lane, worktree: repoRoot, tabRunId: "", provision: noopProvision() };
		}
		const meta: TraceRunMeta = {
			runId,
			shortId,
			status: "running",
			mode,
			task: input.task.trim(),
			repoRoot,
			createdAt: now.toISOString(),
			baseCommit,
			headBefore: baseCommit,
			runDir,
			wtDir: "",
			laneWallClockMin: wallMin,
			laneDeadlineAt: deadline.toISOString(),
			lanes,
			dirtyBaselineFile: baselineFile,
		};
		writeFileSync(metaPath(runDir), JSON.stringify(meta, null, 2) + "\n", "utf8");

		const repoName = basename(repoRoot);
		const diagnoseErrors: string[] = [];
		for (const lane of TRACE_LANES) {
			const laneMeta = lanes[lane];
			const prompt = buildDiagnoseWorkerPrompt({
				task: input.task,
				runId,
				lane,
				baseCommit,
				repoRoot,
				runDir,
				wallClockMin: wallMin,
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
				cwd: repoRoot,
				requestedModel: input.config.workerModel,
				dispatchedAt: new Date().toISOString(),
				dispatchStatus: "dispatched",
			};
			writeTabDispatch(defaultTabRunsDir(), dispatch);
			const launchErrorsLog = join(runDir, "launch-errors.log");
			const spawn = spawnTab({
				wtPath: input.wtExe,
				piCli: input.piCli,
				cwd: repoRoot,
				title,
				prompt,
				model: input.config.workerModel,
				tabRunId: laneRunId,
				sessionProfile: "trace-worker",
				traceRunId: runId,
				traceLane: lane,
				// diagnose：额外禁 edit/write（只读诊断）；bash 保留（git log/grep 等只读探查），
				// 违规写入由 collect 的 dirty-baseline 对比确定性检出
				excludeTools: [...TRACE_WORKER_EXCLUDE_TOOLS, "edit", "write"],
				onSpawnError: (err) => {
					writeTabDispatch(defaultTabRunsDir(), { ...dispatch, dispatchStatus: "launch_failed", error: err.message });
					try {
						appendFileSync(launchErrorsLog, `${new Date().toISOString()} lane ${lane} [${laneRunId}] async spawn error: ${err.message}\n`, "utf8");
					} catch { /* 留痕尽力而为 */ }
					try {
						rmSync(mailboxDirForTab(defaultTimersDir(), laneRunId), { recursive: true, force: true });
						spawnFailedLanes.add(laneRunId);
					} catch { /* 清理尽力而为 */ }
				},
			});
			if (spawn.error) {
				diagnoseErrors.push(`lane ${lane}：${spawn.error}`);
				writeTabDispatch(defaultTabRunsDir(), { ...dispatch, dispatchStatus: "launch_failed", error: spawn.error });
				continue;
			}
			laneMeta.tabRunId = laneRunId;
			writeLaneTimers(laneRunId, lane, deadline, now);
			lines.push(`TRACE ${lane}：${title} [${laneRunId}]`);
		}

		const dispatched = TRACE_LANES.filter((l) => lanes[l].tabRunId);
		if (dispatched.length === 0) {
			const failed = { ...meta, status: "failed" as const };
			writeFileSync(metaPath(runDir), JSON.stringify(failed, null, 2) + "\n", "utf8");
			return { ok: false, error: `三个 tab 全部派发失败：${diagnoseErrors.join("; ")}`, lines };
		}
		writeFileSync(metaPath(runDir), JSON.stringify({ ...meta, lanes }, null, 2) + "\n", "utf8");
		if (diagnoseErrors.length > 0) lines.push(`⚠ ${diagnoseErrors.length} 个 lane 派发失败（run 降级 ${dispatched.length}/3）：${diagnoseErrors.join("; ")}`);
		lines.push(`deadline：${meta.laneDeadlineAt}（${wallMin}min/lane）；产物为三份诊断+方案（无 patch），交主会话融合`);
		return { ok: true, meta: { ...meta, lanes }, lines };
	}

	// ── implement 分支（原有 C5–C8 管线，opt-in 昂贵档）──

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
		mode: "implement",
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

	// 5.5 首跑修复（2026-09-15）：worktree 含 .pi 资源时 pi 会卡在 Trust 确认上——
	// 派发前把 worktree 根写入 trust.json（pi 的 findNearestTrustEntry 向上逐级查找，
	// 一条 ~/.pi/tfl-wt=true 覆盖所有 run 的 lane 树与 eval 树，不随 run 累积）。
	const trust = ensureDirTrusted(wtRoot);
	if (!trust.ok && trust.error) lines.push(`⚠ 预信任失败（tab 可能卡在 Trust 确认）：${trust.error}`);
	else if (trust.wrote) lines.push(`已预信任 worktree 根：${trust.wrote}`);

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
		// review 修正（Luna major）：异步 spawn 失败（wt.exe 启动后才报错）也回写账本 + 留痕
		const launchErrorsLog = join(runDir, "launch-errors.log");
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
			// §17：trace worker 工具隔离（launch/timer/wiki 写工具不可见；subagent-win 保留由 runtime guard 窄化）
			excludeTools: TRACE_WORKER_EXCLUDE_TOOLS,
			onSpawnError: (err) => {
				writeTabDispatch(defaultTabRunsDir(), { ...dispatch, dispatchStatus: "launch_failed", error: err.message });
				try {
					appendFileSync(launchErrorsLog, `${new Date().toISOString()} lane ${lane} [${laneRunId}] async spawn error: ${err.message}\n`, "utf8");
				} catch { /* 留痕尽力而为 */ }
				// review 复核修正（Luna minor）：tab 未起来，已排/将排的 deadline timers 一并清理。
				// 异步事件与 writeLaneTimers 存在时序竞态，两侧都拦：这里删邮箱，writeLaneTimers 侧查 spawnFailed。
				try {
					rmSync(mailboxDirForTab(defaultTimersDir(), laneRunId), { recursive: true, force: true });
					spawnFailedLanes.add(laneRunId);
				} catch { /* 清理尽力而为 */ }
			},
		});
		if (spawn.error) {
			dispatchErrors.push(`lane ${lane}：${spawn.error}`);
			writeTabDispatch(defaultTabRunsDir(), { ...dispatch, dispatchStatus: "launch_failed", error: spawn.error });
			continue;
		}
		laneMeta.tabRunId = laneRunId;
		// review 修正（Luna major）：§24.2 墙钟邮箱计时器——临近超时提醒 + 超时收口
		// （仅提醒不强制；enforcement 在 collect 的 timedOut 判定）。
		writeLaneTimers(laneRunId, lane, deadline, now);
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
