/**
 * trace-fusion/worktree-reclaim.ts — 「跑完一个删一个」（用户 2026-11-04 批准）
 *
 * 动机：implement 模式一轮在 GreenCAD 上产出 12GB worktree（实测：单个 worktree 1.76GB，
 * 主仓构建产物 debug/ 6.3GB 就是逐份累积出来的）。旧行为是**只在 run 终态后由人手动
 * `/trace-fusion-clean`**，三条 lane 的树会同时占盘到最后一刻。
 *
 * 顺序硬约束（不可颠倒）：
 *   lane 终态 ⇒ **先收该 lane 产物**（patch.diff / status.txt 都来自 worktree，删早了就没证据）
 *   ⇒ 收集成功 ⇒ 才删树；收集不成 ⇒ **保留树**并记 deferred（不能拿删树换空间）。
 *
 * 删除本身走 junction-safe 原语（`removeWorktreeRetry` 内部先解 reparse 链接，R-16：
 * `git worktree remove` 的递归删除会穿过 junction 删掉主仓 node_modules / pi 安装）。
 *
 * 留痕（AGENTS.md R-2）：`runDir/reclaim.jsonl` 每条记 {lane, at, action, reason, linksRemoved}。
 */

import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collectLaneArtifacts } from "./artifacts.ts";
import { removeWorktreeRetry } from "./worktrees.ts";
import { readTraceFusionConfig } from "./config.ts";
import { readTraceRunMeta, type TraceRunMeta } from "./launch-workers.ts";
import { TRACE_LANES, type LaneId } from "./types.ts";

export interface ReclaimLaneOutcome {
	lane: LaneId;
	action: "reclaimed" | "deferred" | "noop";
	reason: string;
	linksRemoved?: string[];
}

export interface ReclaimLaneOptions {
	/** 显式覆盖开关（单测用）；缺省读 config.traceFusionLoop.reclaimLaneWorktree。 */
	enabled?: boolean;
	tabRunsDir?: string;
	now?: Date;
	log?: (msg: string) => void;
}

/**
 * 回收单条 lane 的 worktree（幂等：已回收且目录不在 ⇒ noop，不重复收集）。
 */
export function reclaimLaneWorktree(
	meta: TraceRunMeta,
	lane: LaneId,
	opts: ReclaimLaneOptions = {},
): ReclaimLaneOutcome {
	const enabled = opts.enabled ?? readTraceFusionConfig().reclaimLaneWorktree;
	const log = opts.log ?? (() => {});
	const now = opts.now ?? new Date();
	const laneMeta = meta.lanes[lane];
	const wt = laneMeta?.worktree ?? "";

	// 开关关掉 ⇒ 完全不动（回到旧的手动 clean 行为）
	if (enabled === false) return { lane, action: "noop", reason: "开关关闭（reclaimLaneWorktree=false）" };
	// 没有 worktree（diagnose run / 未派发 / 已回收）⇒ 零动作
	if (!wt) return { lane, action: "noop", reason: laneMeta?.worktreeReclaimedAt ? "已回收" : "无 worktree" };
	// 【2026-11-05 缺陷 #8 修】主工作树不是 lane worktree。
	//
	// 事故实测（三个 run 各 6 条，形状完全一致 A×3/B×2/C×1）：
	// diagnose 模式历史上把 `worktree` 填成 `repoRoot`（launch-workers.ts:374）
	// ⇒ 本函数对**主仓根**执行 `git worktree remove --force` ⇒ git 必拒
	// (`fatal: '<repo>' is a main working tree`) ⇒ worktrees.ts:285 在主仓**同级**
	// 写 `<repo>.stale.json` 野文件（实测 subagent-win.stale.json 196B、GreenCAD.stale.json 138B），
	// 并落 6 条假告警 `action:deferred`。
	//
	// 双保险：除修生产者的填值外，这里也必须拦 —— 主工作树永远不是 lane worktree，
	// 无论上游怎么填。守卫比对用归一化（\ ↔ /、大小写），与 fusion-packet 的
	// replayMainRoot 判据同口径。
	const normPath = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
	if (meta.repoRoot && normPath(wt) === normPath(meta.repoRoot)) {
		return { lane, action: "noop", reason: "主工作树不是 lane worktree（诊断模式无隔离树），零动作" };
	}
	if (!existsSync(wt)) {
		markReclaimed(meta, lane, now);
		return { lane, action: "noop", reason: "目录已不在（补记回收时间）" };
	}

	// ① 先收产物：patch.diff 与 status.txt 必须已落到 runDir/lanes/<lane>/
	const report = collectLaneArtifacts(meta, lane, { tabRunsDir: opts.tabRunsDir, now });
	const patchOk = existsSync(join(report.laneDir, "patch.diff"));
	const statusOk = existsSync(join(report.laneDir, "status.txt"));
	if (!patchOk || !statusOk) {
		const reason = `产物未收齐（patch=${patchOk} status=${statusOk}）：保留 worktree，issues=${report.issues.slice(0, 3).join("; ") || "无"}`;
		audit(meta.runDir, { lane, at: now.toISOString(), action: "deferred", reason, worktree: wt });
		log(`trace-fusion: lane ${lane} worktree 延迟回收（跑完不删）— ${reason}`);
		return { lane, action: "deferred", reason };
	}

	// ② 再删树（junction-safe：removeWorktreeRetry 内部先解 reparse 链接）
	const rm = removeWorktreeRetry(wt, meta.repoRoot, { attempts: 2, baseDelayMs: 100 });
	if (!rm.removed) {
		const reason = `worktree 移除失败（可能被进程占用），已写 stale 标记：${(rm.error ?? "").slice(0, 160)}`;
		audit(meta.runDir, { lane, at: now.toISOString(), action: "deferred", reason, worktree: wt, linksRemoved: rm.linksRemoved ?? [] });
		log(`trace-fusion: lane ${lane} worktree 延迟回收 — ${reason}`);
		return { lane, action: "deferred", reason, linksRemoved: rm.linksRemoved };
	}

	markReclaimed(meta, lane, now);
	const reason = `产物已收（patch.diff ${report.patchBytes}B），worktree 已移除；解除链接 ${rm.linksRemoved?.length ?? 0} 个`;
	audit(meta.runDir, { lane, at: now.toISOString(), action: "reclaimed", reason, worktree: wt, linksRemoved: rm.linksRemoved ?? [] });
	log(`trace-fusion: lane ${lane} worktree 已回收（跑完一个删一个）— ${reason}`);
	return { lane, action: "reclaimed", reason, linksRemoved: rm.linksRemoved };
}

/**
 * run 内已进终态的 lane 逐条回收（supervisor 每轮调用；只处理 facts 里 done 的 lane）。
 * 只认自报终态（lane-facts 的 done），running/queued/unconfirmed 一律不碰。
 */
export function reclaimTerminalLaneWorktrees(
	meta: TraceRunMeta,
	doneLanes: readonly LaneId[],
	opts: ReclaimLaneOptions = {},
): ReclaimLaneOutcome[] {
	const out: ReclaimLaneOutcome[] = [];
	for (const lane of doneLanes) {
		if (!TRACE_LANES.includes(lane)) continue;
		try {
			out.push(reclaimLaneWorktree(meta, lane, opts));
		} catch (err) {
			const reason = `回收异常：${(err as Error).message}`;
			audit(meta.runDir, { lane, at: (opts.now ?? new Date()).toISOString(), action: "deferred", reason });
			out.push({ lane, action: "deferred", reason });
		}
	}
	return out;
}

function markReclaimed(meta: TraceRunMeta, lane: LaneId, now: Date): void {
	try {
		const next = { ...meta, lanes: { ...meta.lanes, [lane]: { ...meta.lanes[lane], worktreeReclaimedAt: now.toISOString() } } };
		writeFileSync(join(meta.runDir, "meta.json"), JSON.stringify(next, null, 2) + "\n", "utf8");
		// 内存里的 meta 也要跟上：同一次 supervisor tick 里多条 lane 会连续回收，
		// 不跟的话第二条会拿旧快照覆盖第一条的 reclaimedAt（R-1 多写者教训）。
		meta.lanes[lane] = next.lanes[lane];
	} catch {
		/* meta 回写失败不影响删除本身；审计行已落 */
	}
}

function audit(runDir: string, rec: Record<string, unknown>): void {
	try {
		appendFileSync(join(runDir, "reclaim.jsonl"), JSON.stringify(rec) + "\n", "utf8");
	} catch {
		/* 留痕尽力而为 */
	}
}
