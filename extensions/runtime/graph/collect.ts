/**
 * graph/collect.ts — E1 薄 IO 装配层（graph 模块中**唯一**做 IO 的文件）。
 *
 * 计划 §3/§4.1：只读调用 scanJournalSeq（journal+seq）/ listWorkstreams+listTasks（显式库）/
 * tab-runs 账本（composeTabStatus 结论 + cwd→repoRoot 引用）。零写入、never-throw 顶层容忍。
 *
 * 红线：不写 journal / tab-runs / workstreams / registry / state（Graph 是只读投影，无 writer）；
 *      不 import autonomy 模块（A10.1 allowlist 不扩）；不触 RuntimeSnapshot/protocol/index。
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tabRunAddress } from "../address.ts";
import { DEFAULT_MASTER_ID } from "../ids.ts";
import { defaultRuntimeDir } from "../journal.ts";
import { scanJournalSeq } from "../journal-seq.ts";
import { listTasks, listWorkstreams } from "../workstreams.ts";
import {
	composeTabStatus,
	defaultTabRunsDir,
	listTabDispatches,
	readTabResultFile,
	readTabState,
} from "../../tab-runs.ts";
import { normalizeRepoKey } from "./edges.ts";
import { projectGraph } from "./project.ts";
import type { GraphInput, GraphSnapshot } from "./types.ts";

export interface CollectGraphOptions {
	journalPath?: string;
	stateDir?: string;
	/** tab-runs 账本目录；缺省 env `PI_TAB_RUNS_DIR`（测试隔离）否则 ~/.pi/agent/tab-runs。 */
	tabRunsDir?: string;
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
		const { runPhases, runProjects } = readTabRunRefs(runsDir);

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
		if (Object.keys(runPhases).length > 0) input.runPhases = runPhases;
		if (Object.keys(runProjects).length > 0) input.runProjects = runProjects;
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

// ── tab-runs 只读引用（phase 原样引用 composeTabStatus 结论，不重算）──────

function readTabRunRefs(runsDir: string): { runPhases: Record<string, string>; runProjects: Record<string, string> } {
	const runPhases: Record<string, string> = {};
	const runProjects: Record<string, string> = {};
	let dispatches;
	try {
		dispatches = listTabDispatches(runsDir, 0);
	} catch {
		return { runPhases, runProjects };
	}
	const cache = new Map<string, string>();
	for (const d of dispatches) {
		const subject = tabRunAddress(d.id);
		try {
			const state = readTabState(runsDir, d.id);
			const result = readTabResultFile(runsDir, d.id);
			// probe=null：不探测 session JSONL（只取账本/state/result 的判态结论，E1 薄装配）
			const view = composeTabStatus({ runId: d.id, dispatch: d, state, result, probe: null, dispatchedAt: d.dispatchedAt });
			runPhases[subject] = view.phase;
			if (d.cwd) runProjects[subject] = findRepoRoot(d.cwd, cache);
		} catch {
			continue; // 单条坏 → 跳过（不炸整体）
		}
	}
	return { runPhases, runProjects };
}

/**
 * cwd 沿父目录向上找 .git（≤8 层）→ repoRoot，无则回退 cwd 本身。
 * 与 global-view.ts#L303 同名同语义（project 键口径一致，E2 翻转可对齐）。
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
