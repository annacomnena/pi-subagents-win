/**
 * graph/collect.ts — E1/E2.0 薄 IO 装配层（graph 模块中**唯一**做 IO 的文件）。
 *
 * 计划 §3/§4.1：只读调用 scanJournalSeq（journal+seq）/ listWorkstreams+listTasks（显式库）/
 * tab-runs 账本（共享 carrier 归约结论 + cwd→repoRoot 引用）。never-throw 顶层容忍。
 *
 * E2.0：carriers 复用 `../frontier-carriers.ts` 共享归约（classifyDispatch / reduceTabCarrier /
 * collectTimerByRepo；**禁止自写一份**，否则双真相源）；probe 口径对齐（传 sessionsRoot）；
 * 填 projectAttention（F3）；O-C 只读缓存 `state/work-graph/<scope>.json`（**唯一写者 = 本文件**，
 * 纯函数层 types/project/edges/diff 仍零写）。
 *
 * 红线：不写 journal / tab-runs / workstreams / registry（Graph 是只读投影，业务态无 writer）；
 *      不 import autonomy 模块（A10.1 allowlist 不扩）；不触 RuntimeSnapshot/protocol/index。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tabRunAddress } from "../address.ts";
import { DEFAULT_MASTER_ID } from "../ids.ts";
import { defaultRuntimeDir } from "../journal.ts";
import { scanJournalSeq } from "../journal-seq.ts";
import { normalizeExactPath } from "../recent-scopes.ts";
import { listTasks, listWorkstreams } from "../workstreams.ts";
import { defaultTabRunsDir, listTabDispatches, readTabResultFile, readTabState } from "../../tab-runs.ts";
import { classifyDispatch, collectTimerByRepo, readGateStatus, reduceTabCarrier, type GateStatus, type TabNote } from "../frontier-carriers.ts";
import { normalizeRepoKey } from "./edges.ts";
import { projectGraph } from "./project.ts";
import { GRAPH_SNAPSHOT_VERSION, type GraphInput, type GraphRunCarrier, type GraphSnapshot } from "./types.ts";

export interface CollectGraphOptions {
	journalPath?: string;
	stateDir?: string;
	/** tab-runs 账本目录；缺省 env `PI_TAB_RUNS_DIR`（测试隔离）否则 ~/.pi/agent/tab-runs。 */
	tabRunsDir?: string;
	/** E2.0：carrier 归约时间基准（probe/stale/age 用）；缺省 Date.now()。 */
	now?: number;
	/** E2.0：session 根（probe 决策依赖，同 global-view）；缺省 tabRunsDir 同级的 sessions。 */
	sessionsRoot?: string;
	/** E2.0：timers 根；缺省 tabRunsDir 同级的 timers。 */
	timersDir?: string;
	/** E2.0：诊断时间戳（ms）；仅在提供时写入 GraphSnapshot.asof（缺省不发出）。 */
	asof?: number;
}

const EMPTY_INPUT: GraphInput = { journal: [], workstreams: [], tasks: [] };

/**
 * 装配 GraphInput：journal（Run）+ 显式库（Workstream/Task）+ tab-runs 只读引用（phase/repoPath）。
 * never-throw：任何 IO/解析异常收敛为空输入（Graph 是派生投影，失败按无数据）。
 */
export function collectGraphInput(opts?: CollectGraphOptions): GraphInput {
	try {
		const journalPath = opts?.journalPath ?? join(defaultRuntimeDir(), "events.jsonl");
		const stateDir = opts?.stateDir;
		const runsDir = opts?.tabRunsDir ?? (process.env.PI_TAB_RUNS_DIR?.trim() || defaultTabRunsDir());
		const now = opts?.now ?? Date.now();
		const sessionsRoot = opts?.sessionsRoot ?? join(dirname(runsDir), "sessions");
		const timersDir = opts?.timersDir ?? join(dirname(runsDir), "timers");

		const scan = scanJournalSeq(journalPath);
		const workstreams = listWorkstreams(stateDir).map((ws) => ({
			id: ws.id,
			mission: ws.mission,
			status: ws.status,
			workspaceRef: ws.workspaceRef,
			taskSelector: ws.taskSelector,
		}));
		const tasks = listTasks(undefined, stateDir).map((t) => ({
			id: t.id,
			workstreamId: t.workstreamId,
			externalTaskId: t.externalTaskId,
			objective: t.objective,
			status: t.status,
		}));
		const refs = readTabRunRefs(runsDir, sessionsRoot, timersDir, now);

		const input: GraphInput = {
			journal: scan.entries,
			logEpoch: scan.logEpoch,
			headSeq: scan.head,
			badLines: scan.skippedBadLines,
			// Phase 1 单例 master：registry 附件只描述同一逻辑身份，不产生新 id
			masters: [{ id: DEFAULT_MASTER_ID }],
			workstreams,
			tasks,
		};
		if (Object.keys(refs.runPhases).length > 0) input.runPhases = refs.runPhases;
		if (Object.keys(refs.runProjects).length > 0) input.runProjects = refs.runProjects;
		if (Object.keys(refs.runCarriers).length > 0) input.runCarriers = refs.runCarriers;
		if (Object.keys(refs.projectAttention).length > 0) input.projectAttention = refs.projectAttention;
		if (refs.history.length > 0) input.history = refs.history;
		if (opts?.asof !== undefined) input.asof = opts.asof;
		return input;
	} catch {
		return EMPTY_INPUT;
	}
}

/** 只读快照快捷方式（collect → projectGraph）；never-throw。 */
export function readGraphSnapshot(opts?: CollectGraphOptions): GraphSnapshot {
	try {
		return projectGraph(collectGraphInput(opts));
	} catch {
		return projectGraph(EMPTY_INPUT);
	}
}

// ── tab-runs 只读引用（phase/carrier 原样引用共享归约结论，不重算）──────

interface TabRunRefs {
	runPhases: Record<string, string>;
	runProjects: Record<string, string>;
	runCarriers: Record<string, GraphRunCarrier>;
	projectAttention: Record<string, number>;
	history: { id: string; reason: string }[];
}

function readTabRunRefs(runsDir: string, sessionsRoot: string, timersDir: string, now: number): TabRunRefs {
	const refs: TabRunRefs = { runPhases: {}, runProjects: {}, runCarriers: {}, projectAttention: {}, history: [] };
	let dispatches;
	try {
		dispatches = listTabDispatches(runsDir, 0);
	} catch {
		return refs;
	}
	const cache = new Map<string, string>();
	const gateCache = new Map<string, GateStatus>();
	const warnings: string[] = [];
	const runToRepo = new Map<string, string>();
	const notes = new Map<string, TabNote>();
	// pass 1：repo 归属 + 可见性分流（先建 runToRepo 供 timers mail 映射）
	for (const d of dispatches) {
		try {
			const repoPath = d.cwd ? findRepoRoot(d.cwd, cache) : d.cwd;
			runToRepo.set(d.id, repoPath);
			notes.set(d.id, classifyDispatch(d, runsDir));
		} catch {
			continue; // 单条坏 → 跳过（不炸整体）
		}
	}
	// timers 聚合：以 runToRepo 映射 mail timer；repo 级 overdue 传入 carrier
	const timerByRepo = collectTimerByRepo(timersDir, now, runToRepo).byRepo;
	// pass 2：hidden → phase/history；visible → carrier（probe 口径对齐，同一 sessionsRoot/now）
	for (const d of dispatches) {
		const subject = tabRunAddress(d.id);
		const note = notes.get(d.id);
		const repoPath = runToRepo.get(d.id);
		if (!note || !repoPath) continue;
		if (note.hiddenKind !== null) {
			refs.runPhases[subject] = note.phase;
			refs.runProjects[subject] = repoPath;
			refs.history.push({ id: d.id, reason: note.hiddenKind === "orphaned" ? "orphaned" : `terminal:${note.phase}` });
			continue;
		}
		try {
			const state = readTabState(runsDir, d.id);
			const result = readTabResultFile(runsDir, d.id);
			const gk = normalizeExactPath(repoPath);
			let gate = gateCache.get(gk);
			if (!gate) { gate = readGateStatus(repoPath, warnings); gateCache.set(gk, gate); }
			const carrier = reduceTabCarrier({
				rec: d, sessionsRoot, repoPath,
				repoOverdue: timerByRepo.get(gk)?.overdue ?? 0,
				now, gate, state, result,
			});
			if (!carrier) continue;
			refs.runPhases[subject] = carrier.phase;
			refs.runProjects[subject] = repoPath;
			refs.runCarriers[subject] = {
				gate: carrier.gate, needsHuman: carrier.needsHuman, staleOver: carrier.staleOver,
				overdue: carrier.overdue, pidAlive: carrier.pidAlive,
			};
			if (note.attention) {
				const k = normalizeRepoKey(repoPath);
				refs.projectAttention[k] = (refs.projectAttention[k] ?? 0) + 1;
			}
		} catch {
			continue; // 单条坏 → 跳过（不炸整体）
		}
	}
	refs.history.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	return refs;
}

/**
 * cwd 沿父目录向上找 .git（≤8 层）→ repoRoot，无则回退 cwd 本身。
 * 与 global-view.ts 同名同语义（project 键口径一致，E2 翻转可对齐）。
 */
function findRepoRoot(cwd: string, cache: Map<string, string>): string {
	const norm = normalizeRepoKey(cwd);
	const hit = cache.get(norm);
	if (hit) return hit;
	try {
		let cur = resolve(cwd);
		for (let i = 0; i < 8; i += 1) {
			if (existsSync(join(cur, ".git"))) {
				cache.set(norm, cur);
				return cur;
			}
			const parent = dirname(cur);
			if (parent === cur) break;
			cur = parent;
		}
	} catch {
		/* fall through */
	}
	cache.set(norm, cwd);
	return cwd;
}

// ── O-C 只读缓存（E2.0）：`state/work-graph/<scope>.json`，唯一写者 = 本文件 ──
// 纯函数层 types/project/edges/diff 零写；缓存是 C4 可删派生（缺省可不启用）。

function workGraphDir(stateDir?: string): string {
	return join(stateDir ?? join(defaultRuntimeDir(), "state"), "work-graph");
}

function scopeName(scope?: string): string {
	return (scope ?? "global").replace(/[^A-Za-z0-9._-]/g, "_");
}

/** 原子写快照缓存（tmp+rename；best-effort，失败返回 false，绝不抛）。 */
export function writeGraphSnapshotCache(snap: GraphSnapshot, opts?: { stateDir?: string; scope?: string }): boolean {
	try {
		const dir = workGraphDir(opts?.stateDir);
		mkdirSync(dir, { recursive: true });
		const file = join(dir, `${scopeName(opts?.scope)}.json`);
		const tmp = join(dir, `${scopeName(opts?.scope)}.${process.pid}.tmp`);
		writeFileSync(tmp, JSON.stringify(snap), "utf8");
		renameSync(tmp, file);
		return true;
	} catch {
		return false;
	}
}

/** 容忍读快照缓存：缺失/坏 JSON/版本不符 → null（行为同无缓存）。 */
export function readGraphSnapshotCache(opts?: { stateDir?: string; scope?: string }): GraphSnapshot | null {
	try {
		const raw = JSON.parse(readFileSync(join(workGraphDir(opts?.stateDir), `${scopeName(opts?.scope)}.json`), "utf8")) as GraphSnapshot;
		if (!raw || raw.version !== GRAPH_SNAPSHOT_VERSION || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges) || !Array.isArray(raw.projects)) return null;
		return raw;
	} catch {
		return null;
	}
}
