/**
 * async-panel — 后台异步子 agent 的可视化面板（opencode 风格）
 *
 * 目标：async 派发不是「fire-and-forget」——TUI 上要能看到
 * 正在运行的后台任务列表、状态，完成时有反馈。
 *
 * UI 载体（pi 扩展 API）：
 *   - ctx.ui.setWidget("subagent-async", lines) —— 编辑器上方常驻组件（任务面板）
 *   - ctx.ui.setStatus("subagent-async", text)  —— 页脚状态栏摘要
 *   - sendWindowsToast —— 完成/失败通知
 *
 * 触发：async 派发时、任务完成回调里、以及 10s 兜底定时器（自愈刷新）。
 */

import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { sendWindowsToast } from "./notify-windows.ts";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const ASYNC_WIDGET_KEY = "subagent-async";
export const ASYNC_STATUS_KEY = "subagent-async";

/** 与 index.ts 的 AsyncRunRecord 同构（避免循环依赖，这里独立声明）。 */
export interface AsyncPanelRecord {
	id: string;
	agent?: string;
	task: string;
	status: "running" | "completed" | "failed" | "cancelled";
	result?: {
		text?: string;
		error?: string;
		usage?: { cost?: number; turns?: number };
	};
	startedAt: string;
}

const DEFAULT_RUNS_DIR = join(homedir(), ".pi", "agent", "subagent-runs");

let lastUi: ExtensionUIContext | null = null;

/** 派发/完成时把当前会话的 UI 引用注入（execute 的 _ctx.ui）。 */
export function bindAsyncPanelUi(ui: ExtensionUIContext | undefined | null): void {
	if (ui) lastUi = ui;
}

function readAsyncRecords(runsDir: string): AsyncPanelRecord[] {
	if (!existsSync(runsDir)) return [];
	return readdirSync(runsDir)
		.filter((f) => f.endsWith(".json"))
		.map((f) => {
			try {
				return JSON.parse(readFileSync(join(runsDir, f), "utf8")) as AsyncPanelRecord;
			} catch {
				return null;
			}
		})
		.filter((r): r is AsyncPanelRecord => r !== null)
		.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
}

/** 刷新面板：running 任务列表（widget）+ 摘要（status）。无 UI 时静默。 */
export function refreshAsyncPanel(runsDir: string = DEFAULT_RUNS_DIR, ui: ExtensionUIContext | null = lastUi): void {
	if (!ui) return;
	let records: AsyncPanelRecord[];
	try {
		records = readAsyncRecords(runsDir);
	} catch {
		return;
	}
	const running = records.filter((r) => r.status === "running");
	const recentlyDone = records.filter((r) => r.status !== "running").slice(0, 3);

	// Widget：opencode 风格任务面板（编辑器上方）
	const lines: string[] = [];
	if (running.length === 0 && recentlyDone.length === 0) {
		lines.push("No async subagents");
	} else {
		if (running.length > 0) {
			lines.push(`⏳ ${running.length} running`);
			for (const r of running) {
				const agent = r.agent ?? "subagent";
				const task = r.task.replace(/\s+/g, " ").slice(0, 40);
				const age = formatAge(r.startedAt);
				lines.push(`  ${agent}: ${task} (${r.id} · ${age})`);
			}
		}
		for (const r of recentlyDone) {
			const icon = r.status === "completed" ? "✓" : "✗";
			const agent = r.agent ?? "subagent";
			const task = r.task.replace(/\s+/g, " ").slice(0, 40);
			const err = r.result?.error ? ` — ${r.result.error.slice(0, 30)}` : "";
			lines.push(`  ${icon} ${agent}: ${task} (${r.id})${err}`);
		}
	}
	try {
		ui.setWidget(ASYNC_WIDGET_KEY, lines);
		ui.setStatus(ASYNC_STATUS_KEY, running.length > 0 ? `subagents: ${running.length} running` : undefined);
	} catch {
		/* 非 TUI 模式（print/json）下 setWidget 可能 no-op，忽略 */
	}
}

/** 任务完成通知（toast）。 */
export function notifyAsyncCompletion(record: AsyncPanelRecord): void {
	const agent = record.agent ?? "subagent";
	if (record.status === "completed") {
		sendWindowsToast({ title: `✅ ${agent} 异步完成`, body: record.id, duration: "short" });
	} else {
		sendWindowsToast({
			title: `❌ ${agent} 异步失败`,
			body: `${record.id}: ${record.result?.error?.slice(0, 80) ?? "failed"}`,
			duration: "long",
		});
	}
}

function formatAge(startedAt: string): string {
	const ms = Date.parse(startedAt);
	if (Number.isNaN(ms)) return "?";
	const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
	if (sec < 60) return `${sec}s`;
	return `${Math.floor(sec / 60)}m${sec % 60}s`;
}

/**
 * 注册 async 面板：10s 兜底定时器（会话空闲时面板也自愈刷新）。
 * 注意：只刷新 UI，不向 LLM 注入任何内容。
 */
export function registerAsyncPanel(pi: ExtensionAPI): void {
	const interval = setInterval(() => {
		refreshAsyncPanel();
	}, 10_000);
	interval.unref?.();
}
