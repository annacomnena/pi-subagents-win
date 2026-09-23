/**
 * gc-cleaner.ts — 手动内存回收与磁盘碎片清理（/subagent-gc 与 /gc 命令）
 *
 * 核心功能：
 *   1. 释放模块级内存缓存（external-cli、report、event-bus、cli 路径缓存等）；
 *   2. 归档终态超龄 Tab 跑次文件，清理 .tmp 孤儿临时文件；
 *   3. 清理已超龄的定时器死信与会话失活心跳；
 *   4. 清理 subagent-runs 目录中的历史落盘大文件与异步记录；
 *   5. 触发 V8 垃圾回收（若暴露 global.gc）；
 *   6. 采样并输出精确的清理前后内存差值与碎片文件统计。
 */

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { clearExternalCliCache } from "./external-cli.ts";
import { clearReportCache } from "./report.ts";
import { clearEventBusCache } from "./event-bus.ts";
import { archiveStaleTabRuns, defaultTabRunsDir } from "./tab-runs.ts";
import { defaultTimersDir, sweepStaleHeartbeats, sweepTerminalTimers } from "./timers.ts";

export interface GcOptions {
	tabRunsDir?: string;
	timersDir?: string;
	subagentRunsDir?: string;
	reportsDir?: string;
	/** 归档判定阈值（小时），缺省 48 小时；传 0 则归档所有终态跑次 */
	maxAgeHours?: number;
	onClearCustomCaches?: () => void;
}

export interface GcResult {
	memBefore: NodeJS.MemoryUsage;
	memAfter: NodeJS.MemoryUsage;
	freedRssMb: number;
	freedHeapMb: number;
	archivedRuns: number;
	sweptTimers: number;
	sweptHeartbeats: number;
	cleanedTmpFiles: number;
	cleanedSubagentFiles: number;
	gcInvoked: boolean;
	summary: string;
}

function toMb(bytes: number): string {
	return (bytes / (1024 * 1024)).toFixed(1);
}

export async function runSystemGc(opts: GcOptions = {}): Promise<GcResult> {
	const tabRunsDir = opts.tabRunsDir ?? defaultTabRunsDir();
	const timersDir = opts.timersDir ?? defaultTimersDir();
	const subagentRunsDir = opts.subagentRunsDir ?? join(homedir(), ".pi", "agent", "subagent-runs");
	const reportsDir = opts.reportsDir ?? join(homedir(), ".pi", "agent", "reports");
	const maxAgeHours = opts.maxAgeHours ?? 48;
	const cutoffMs = Date.now() - maxAgeHours * 3600 * 1000;

	// 1. 采样初始内存
	const memBefore = process.memoryUsage();

	// 2. 清空内部模块缓存
	clearExternalCliCache();
	clearReportCache();
	clearEventBusCache();
	opts.onClearCustomCaches?.();

	// 3. 磁盘碎片整理与归档
	// A. 归档超龄终态 tab-runs
	const archivedRuns = archiveStaleTabRuns(tabRunsDir, maxAgeHours);

	// B. 清理 tab-runs 中的孤儿 .tmp 文件
	let cleanedTmpFiles = 0;
	if (existsSync(tabRunsDir)) {
		try {
			for (const f of readdirSync(tabRunsDir)) {
				if (f.endsWith(".tmp")) {
					rmSync(join(tabRunsDir, f), { force: true });
					cleanedTmpFiles++;
				}
			}
		} catch { /* ignore */ }
	}

	// C. 清理定时器死信与孤儿
	const sweptTimers = sweepTerminalTimers(timersDir);
	const sweptHeartbeats = sweepStaleHeartbeats(timersDir);

	// D. 清理 reports 目录下的 .tmp 文件
	if (existsSync(reportsDir)) {
		try {
			for (const f of readdirSync(reportsDir)) {
				if (f.endsWith(".tmp")) {
					rmSync(join(reportsDir, f), { force: true });
					cleanedTmpFiles++;
				}
			}
		} catch { /* ignore */ }
	}

	// E. 清理 subagent-runs 目录中超龄的已落盘文件（> maxAgeHours）
	let cleanedSubagentFiles = 0;
	if (existsSync(subagentRunsDir)) {
		try {
			for (const f of readdirSync(subagentRunsDir)) {
				if (f.endsWith(".tmp")) {
					rmSync(join(subagentRunsDir, f), { force: true });
					cleanedTmpFiles++;
					continue;
				}
				const fullPath = join(subagentRunsDir, f);
				try {
					const mtime = statSync(fullPath).mtimeMs;
					if (mtime < cutoffMs && (f.endsWith("_full.md") || f.endsWith(".json"))) {
						rmSync(fullPath, { force: true });
						cleanedSubagentFiles++;
					}
				} catch { /* ignore */ }
			}
		} catch { /* ignore */ }
	}

	// 4. 触发垃圾回收
	let gcInvoked = false;
	if (typeof global.gc === "function") {
		global.gc();
		gcInvoked = true;
	}

	// 5. 采样清理后内存
	const memAfter = process.memoryUsage();
	const freedRssBytes = memBefore.rss - memAfter.rss;
	const freedHeapBytes = memBefore.heapUsed - memAfter.heapUsed;
	const freedRssMb = Math.max(0, parseFloat((freedRssBytes / (1024 * 1024)).toFixed(1)));
	const freedHeapMb = Math.max(0, parseFloat((freedHeapBytes / (1024 * 1024)).toFixed(1)));

	// 6. 生成报告文本
	const lines = [
		"🧹 subagent-win 内存回收与碎片清理完成：",
		"• 内存指标变化：",
		`  - 物理常驻 (RSS): ${toMb(memBefore.rss)} MB → ${toMb(memAfter.rss)} MB${freedRssBytes > 0 ? ` (释放 -${toMb(freedRssBytes)} MB)` : ""}`,
		`  - V8 堆占用 (Heap): ${toMb(memBefore.heapUsed)} MB → ${toMb(memAfter.heapUsed)} MB${freedHeapBytes > 0 ? ` (释放 -${toMb(freedHeapBytes)} MB)` : ""}`,
		`  - V8 垃圾回收: ${gcInvoked ? "已显式触发 Full GC" : "已解除强引用交由引擎调度"}`,
		"• 磁盘碎片清理：",
		`  - 归档历史 Tab 跑次: ${archivedRuns} 个`,
		`  - 清理定时器死信/孤儿: ${sweptTimers} 个`,
		`  - 清理失活心跳记录: ${sweptHeartbeats} 个`,
		`  - 清理临时 .tmp 碎片: ${cleanedTmpFiles} 个`,
		`  - 清理超龄历史运行记录: ${cleanedSubagentFiles} 个`,
		"• 模块缓存：外部 CLI 路径缓存、已读事件集合已全部重置清空。",
	];

	return {
		memBefore,
		memAfter,
		freedRssMb,
		freedHeapMb,
		archivedRuns,
		sweptTimers,
		sweptHeartbeats,
		cleanedTmpFiles,
		cleanedSubagentFiles,
		gcInvoked,
		summary: lines.join("\n"),
	};
}
