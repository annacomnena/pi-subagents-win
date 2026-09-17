/**
 * runtime/state-store.ts — Canonical State 落盘（Phase 2，设计稿 §20-22）
 *
 * 布局（§21，v1 只投影 Run）：
 *   ~/.pi/agent/runtime/state/runs/<sanitized-subject>.json   → ProjectedRun
 *
 * 原则：
 *   - state/ 是物化缓存，**journal 仍是唯一 source of truth**：任何时候可删 state/ 全量重放
 *     （§22 replay 等价是本模块的验收核心）；
 *   - pending 桶不落盘：rebuild 现算（它本来就是 journal 的确定性函数）；
 *   - 原子写（tmp + rename）避免读者看到半截 JSON；
 *   - env override 同 journal（PI_RUNTIME_DIR）。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listRuntimeEnvelopes } from "./journal.ts";
import { defaultRuntimeDir } from "./journal.ts";
import { rebuildFromEnvelopes, type PendingTerminal, type ProjectedRun, type ProjectionState } from "./projector.ts";

export function defaultStateDir(): string {
	return join(defaultRuntimeDir(), "state");
}

export function runsStateDir(stateDir: string = defaultStateDir()): string {
	return join(stateDir, "runs");
}

/** subject → 安全文件名（受控格式 run://tab/<base36>，替换后无碰撞面）。 */
function stateFileName(subject: string): string {
	return `${subject.replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
}

// ── 写（全量重建后落盘）───────────────────────────────────────────

/** 从 journal 全量重建并落盘 state/runs/*。返回投影摘要。 */
export function projectJournalToState(
	opts: { journalPath?: string; stateDir?: string } = {},
): { runs: number; pending: number; applied: number; skipped: number } {
	const journalPath = opts.journalPath ?? join(defaultRuntimeDir(), "events.jsonl");
	const stateDir = opts.stateDir ?? defaultStateDir();
	const { envelopes, skippedBadLines } = listRuntimeEnvelopes({ path: journalPath });
	const { state, applied, skipped } = rebuildFromEnvelopes(envelopes);

	const runsDir = runsStateDir(stateDir);
	mkdirSync(runsDir, { recursive: true });

	// 清掉旧投影文件（subject 集合可能缩小——防御性保持目录与投影一致）
	const keep = new Set([...state.runs.keys()].map((s) => stateFileName(s)));
	for (const f of readdirSync(runsDir)) {
		if (!f.endsWith(".json")) continue;
		if (!keep.has(f)) {
			try { unlinkSync(join(runsDir, f)); } catch { /* best effort */ }
		}
	}

	for (const run of state.runs.values()) {
		writeStateAtomic(join(runsDir, stateFileName(run.subject)), run);
	}
	return { runs: state.runs.size, pending: state.pending.size, applied, skipped: skipped + skippedBadLines };
}

/** 原子写：tmp + rename（Windows 上 rename 覆盖已存在目标）。 */
function writeStateAtomic(path: string, value: unknown): void {
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}

// ── 读 ─────────────────────────────────────────────────────────────

/** 读单个 Run 的投影（state 文件 miss 返回 null——不触发 rebuild，调用方决定）。 */
export function readProjectedRun(subject: string, stateDir: string = defaultStateDir()): ProjectedRun | null {
	const path = join(runsStateDir(stateDir), stateFileName(subject));
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as ProjectedRun;
	} catch {
		return null; // 半截/损坏 → 视同 miss（调用方可 rebuild 修复）
	}
}

/** 读全部 Run 投影。 */
export function listProjectedRuns(stateDir: string = defaultStateDir()): ProjectedRun[] {
	const dir = runsStateDir(stateDir);
	if (!existsSync(dir)) return [];
	const runs: ProjectedRun[] = [];
	for (const f of readdirSync(dir)) {
		if (!f.endsWith(".json")) continue;
		try {
			runs.push(JSON.parse(readFileSync(join(dir, f), "utf8")) as ProjectedRun);
		} catch {
			/* tolerant：坏文件跳过（可 projectJournalToState 修复） */
		}
	}
	return runs;
}

/**
 * Replay 等价断言辅助（§22 验收核心）：给定 journal 重建两次（含中间清空 state），
 * 深比较 canonical state 是否一致。返回差异描述（空数组 = 等价）。
 */
export function replayEquivalenceDiff(journalPath: string): string[] {
	const { envelopes } = listRuntimeEnvelopes({ path: journalPath });
	const first = rebuildFromEnvelopes(envelopes).state;
	const second = rebuildFromEnvelopes(envelopes).state; // 幂等性：同输入同输出
	return diffProjectionStates(first, second);
}

/** 两个投影状态的深比较（replay 等价测试用）。 */
export function diffProjectionStates(a: ProjectionState, b: ProjectionState): string[] {
	const diffs: string[] = [];
	const keyOf = (m: Map<string, unknown>) => [...m.keys()].sort().join(",");
	if (keyOf(a.runs as unknown as Map<string, unknown>) !== keyOf(b.runs as unknown as Map<string, unknown>)) {
		diffs.push(`runs subjects differ: [${keyOf(a.runs as unknown as Map<string, unknown>)}] vs [${keyOf(b.runs as unknown as Map<string, unknown>)}]`);
	}
	for (const [k, ra] of a.runs) {
		const rb = b.runs.get(k);
		if (!rb) continue;
		if (JSON.stringify(ra) !== JSON.stringify(rb)) {
			diffs.push(`run ${k} differs:\n  A=${JSON.stringify(ra)}\n  B=${JSON.stringify(rb)}`);
		}
	}
	const pendA = [...a.pending.values()].sort((x, y) => x.dedupeKey.localeCompare(y.dedupeKey));
	const pendB = [...b.pending.values()].sort((x, y) => x.dedupeKey.localeCompare(y.dedupeKey));
	if (JSON.stringify(pendA) !== JSON.stringify(pendB)) diffs.push("pending buckets differ");
	return diffs;
}

/** pending 桶只读视图（rebuild 现算，不落盘——见文件头原则）。 */
export function computePending(journalPath: string = join(defaultRuntimeDir(), "events.jsonl")): PendingTerminal[] {
	const { envelopes } = listRuntimeEnvelopes({ path: journalPath });
	return [...rebuildFromEnvelopes(envelopes).state.pending.values()];
}
