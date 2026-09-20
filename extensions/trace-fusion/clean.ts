/**
 * trace-fusion/clean.ts — run 清理（v0.5 的 /trace-fusion-clean 提前落地，真实运行驱动 2026-09-17）
 *
 * 背景：implement 模式一轮真实 run 在 GreenCAD 上产出 12GB worktree（bin/obj ×3 +
 * 源树 ×3），加上更早的僵尸 run 1.1GB——§15 的「用完即删」在 v0.3 没有执行机制，
 * 本模块补上：git worktree remove ×3 → 删短路径目录 → worktree prune → meta 终态化。
 *
 * 保留什么：runDir（artifact 长路径）永不删——patch.diff/trajectory/collect 是唯一证据，
 * patch 可随时重放到新树上复验。丢掉的只是 live worktree（可重建的构建缓存）。
 */

import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execGit } from "./git.ts";
import { removeWorktreeRetry } from "./worktrees.ts";
import { readTraceRunMeta, type TraceRunMeta } from "./launch-workers.ts";
import { defaultRunsDir, TRACE_LANES, type LaneId } from "./types.ts";

export interface CleanOptions {
	/** 对 running run 强制清理（默认拒绝——lane 还在跑）。 */
	force?: boolean;
	runsDir?: string;
	now?: Date;
}

export type CleanResult =
	| { ok: true; runId: string; removedWorktrees: LaneId[]; lines: string[] }
	| { ok: false; error: string; lines: string[] };

/**
 * 清理一个 run 的 worktree 占用并终结 meta。
 * - running 且未 --force → 拒绝（防止撕掉正在工作的 lane 的脚下的树）
 * - diagnose run（无 worktree）→ 仅标记 meta，幂等成功
 * - 幂等：目录不存在时逐 lane 跳过，meta 重复标记无害
 */
export function cleanTraceRun(runId: string, opts: CleanOptions = {}): CleanResult {
	const lines: string[] = [];
	const runDir = join(opts.runsDir ?? defaultRunsDir(), runId);
	const meta: TraceRunMeta | null = readTraceRunMeta(runDir);
	if (!meta) return { ok: false, error: `run meta 不可读：${runDir}`, lines };
	if (meta.status === "running" && !opts.force) {
		return {
			ok: false,
			error: `run 仍为 running；确认 lane 已死再清理可用 /trace-fusion-clean ${runId} --force`,
			lines,
		};
	}

	const removed: LaneId[] = [];
	if (meta.wtDir && existsSync(meta.wtDir)) {
		for (const lane of TRACE_LANES) {
			const wt = meta.lanes[lane]?.worktree;
			if (!wt || !existsSync(wt)) continue;
			removeWorktreeRetry(wt, meta.repoRoot, { attempts: 2, baseDelayMs: 100 });
			if (!existsSync(wt)) removed.push(lane);
			else lines.push(`⚠ lane ${lane} worktree 移除失败（可能被进程占用）：${wt}`);
		}
		execGit(["worktree", "prune"], { cwd: meta.repoRoot });
		try {
			rmSync(meta.wtDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 300 });
		} catch (err) {
			lines.push(`⚠ wt 目录删除失败：${(err as Error).message}`);
		}
		lines.push(`已移除 worktrees：${removed.join("/") || "（无）"}；短路径目录 ${meta.wtDir}`);
	} else {
		lines.push("无 worktree 占用（diagnose run 或已清理）");
	}

	// meta 终态化：running → cancelled(cleaned)；已终态 → 追加 cleanedAt（保留原状态语义）
	const now = opts.now ?? new Date();
	const next = meta.status === "running"
		? { ...meta, status: "cancelled" as const, cancelledReason: "cleaned", cleanedAt: now.toISOString() }
		: { ...meta, cleanedAt: now.toISOString() };
	try {
		writeFileSync(join(runDir, "meta.json"), JSON.stringify(next, null, 2) + "\n", "utf8");
	} catch (err) {
		return { ok: false, error: `meta 回写失败：${(err as Error).message}`, lines };
	}
	lines.push(`run ${runId} 已清理：artifact 保留在 ${runDir}（patch/trajectory 不受影响）`);
	return { ok: true, runId, removedWorktrees: removed, lines };
}
