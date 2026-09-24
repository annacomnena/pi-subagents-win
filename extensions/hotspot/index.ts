/**
 * hotspot — 短期热点工作集模块入口（v4）
 *
 * 设计：plans/0924_hotspot_v4_ephemeral_working_set.md；
 * 实现计划：plans/0924_hotspot_v4_impl_plan.md §A.1（注册矩阵）。
 * Hotspot = 可丢失、可重建、非权威的短期工作集 projection（task/workstream →
 * 最近读写文件）。旧 v2 路由缓存（Wiki/_hotspot.md 托管）已整体退役。
 *
 * 注册矩阵：
 * | 能力              | 主会话 | Tab | 子 agent |
 * | collect（采集分片）| ✓     | ✓  | ✓（只追加，workspace 级，不伪造 task_id）|
 * | hotspot lookup 工具| ✓     | ✓  | ✓（只读，无害）|
 * | /hotspot 命令      | ✓     | ✓  | ✗ |
 * | inject             | ✓(路径门)| ✓(task/路径门) | ✗ |
 * | snapshot 写+TTL 清理| ✓(唯一写者) | ✗ | ✗ |
 * | 总开关关           | 全部不注册 | 同 | 同 |
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isMainSession, isSubagent } from "../identity.ts";
import { registerHotspotCollect } from "./collect.ts";
import { registerHotspotCommand } from "./command.ts";
import { registerInject } from "./inject.ts";
import { registerHotspotTool } from "./tool.ts";
import {
	appendedSinceLoad,
	cleanupStaleShards,
	defaultAgentDir,
	findRepoRoot,
	lastSnapshotAtMs,
	workspaceIdOf,
	writeSnapshotAtomic,
	wsPaths,
} from "./store.ts";
import { buildWorkset } from "./workset.ts";
import { HALF_LIFE_MS, SCHEMA_VERSION, SNAPSHOT_MIN_INTERVAL_MS, hotspotEnabled, nowIso } from "./types.ts";

/**
 * snapshot 写入（§C.5，主会话 agent_end 时）：距上次写 ≥ 节流间隔且本会话追过分片 →
 * TTL 清理旧分片 → tmp+rename 写 snapshot（派生缓存；缺失/过期一律容忍）。
 * 导出供测试。
 */
export function writeSnapshotIfDue(agentDir: string, root: string, now: number): { written: boolean; reason?: string } {
	try {
		if (appendedSinceLoad() === 0) return { written: false, reason: "no_events" };
		const wsid = workspaceIdOf(root);
		const p = wsPaths(agentDir, wsid);
		if (now - lastSnapshotAtMs(p.snapshotPath) < SNAPSHOT_MIN_INTERVAL_MS) return { written: false, reason: "throttled" };
		cleanupStaleShards(p.eventsDir, now);
		const ws = buildWorkset(agentDir, wsid, { now });
		const ok = writeSnapshotAtomic(p.snapshotPath, {
			schema: SCHEMA_VERSION,
			wsid,
			generatedAt: nowIso(now),
			halfLifeMs: HALF_LIFE_MS,
			entries: ws.entries,
		});
		return ok ? { written: true } : { written: false, reason: "io_error" };
	} catch (e) {
		return { written: false, reason: `error:${String(e)}` };
	}
}

export function registerHotspot(pi: ExtensionAPI): void {
	if (!hotspotEnabled()) return; // §J.2 总开关：采集/注入/工具/命令全部不注册
	registerHotspotCollect(pi); // 主/Tab/子 agent：分片采集
	registerHotspotTool(pi); // 主/Tab/子 agent：只读 lookup
	if (isSubagent()) return;
	registerHotspotCommand(pi); // 主/Tab
	registerInject(pi); // 主(路径门)/Tab(task/路径门)；内部自 gate
	if (!isMainSession()) return;
	pi.on("agent_end", (_event, ctx) => {
		// gauge 永不打断主流程：任何异常静默
		try {
			const root = findRepoRoot((ctx as { cwd?: string })?.cwd ?? process.cwd());
			writeSnapshotIfDue(defaultAgentDir(), root, Date.now());
		} catch {
			/* 静默 */
		}
	});
}
