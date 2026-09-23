/**
 * spawn-trace.ts — 「谁开了窗口」取证探针（2026-09-22 空壳 WT 窗口排查）。
 *
 * 背景：用户报告「每次新开/恢复 pi 会话都弹一个空壳 WT 窗口（无标签页）」。空壳窗口只可能由
 * 三类动作产生：① 调 wt.exe（new-tab 参数/窗口解析失败）；② 从**无控制台**进程派生控制台子
 * 进程（Windows 会分配新控制台 → 默认终端应用弹窗）；③ 浏览器/命令启动器（cmd start）。
 * 三类都集中在少数 spawn 点，本模块把它们统一落盘，附调用栈，便于事后归因。
 *
 * 纪律：never-throw（取证永不打断主流程）；env `PI_SPAWN_TRACE=0` 可整机关闭；
 * 文件落在 ~/.pi/agent/tmp/spawn-trace.log（tmp 目录可随时清空）。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 探针是否启用（默认启用：仅一行文本，代价可忽略）。 */
export function spawnTraceEnabled(): boolean {
	return process.env.PI_SPAWN_TRACE !== "0";
}

/** 探针日志路径（测试/排查用）。 */
export function spawnTracePath(): string {
	return join(process.env.PI_RUNTIME_DIR ?? join(homedir(), ".pi", "agent"), "tmp", "spawn-trace.log");
}

/**
 * 记录一次「可能开窗」的派生动作。
 *
 * @param kind 动作类别：wt | console-child | browser | toast
 * @param detail 人类可读摘要（命令、标题、URL…）
 */
export function traceSpawn(kind: string, detail: string): void {
	if (!spawnTraceEnabled()) return;
	try {
		const file = spawnTracePath();
		mkdirSync(join(file, ".."), { recursive: true });
		// 调用栈裁到 6 帧：足够定位到调用方函数，不淹没日志
		const stack = (new Error().stack ?? "")
			.split("\n")
			.slice(2, 8)
			.map((s) => s.trim().replace(/^at\s+/, ""))
			.join(" <- ");
		const line = [
			new Date().toISOString(),
			`pid=${process.pid}`,
			`ppid=${process.ppid}`,
			// WT_SESSION：Windows Terminal 会给它托管的进程注入该变量；缺失 = 无 WT 窗口可挂
			`wtSession=${process.env.WT_SESSION ? "y" : "n"}`,
			`tab=${process.env.PI_TAB_RUN_ID || "-"}`,
			kind,
			detail.replace(/[\r\n\t]+/g, " ").slice(0, 400),
			stack,
		].join("\t");
		appendFileSync(file, line + "\n");
	} catch {
		/* 取证失败绝不打断主流程 */
	}
}
