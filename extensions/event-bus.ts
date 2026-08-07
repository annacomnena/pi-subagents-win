/**
 * event-bus — 文件即总线的 fs.watch 事件层（主会话）
 *
 * 让「tab 完成」从轮询（10s tick）变为事件驱动（亚秒级感知）：
 * watch ~/.pi/agent/tab-runs/ 目录，检测到新的 *.result.json →
 *   - toast 通知（人可见）
 *   - 注入一条用户消息唤醒模型去 reclaim（无人值守接力）
 *   - 刷新 async 面板/状态栏（如适用）
 *
 * 设计约束：
 *   - 只有主会话（无 PI_TAB_RUN_ID、非 PI_SUBAGENT）注册 watch；
 *     子 agent/标签页不注册，避免重复唤醒。
 *   - 去重：启动时把已存在的 result 视为"已处理"；只对启动后新出现的触发。
 *   - Windows fs.watch 偶发丢事件 → 保留 10s tick 兜底（见 async-panel / registerTabStatusTools）。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { watch, type FSWatcher } from "node:fs";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sendWindowsToast } from "./notify-windows.ts";
import { readTabResultFile } from "./tab-runs.ts";
import { refreshAsyncPanel } from "./async-panel.ts";

export const EVENT_BUS_WATCH_KEY = "subagent-event-bus";

const DEFAULT_TAB_RUNS_DIR = join(homedir(), ".pi", "agent", "tab-runs");

export interface EventBusOptions {
	runsDir?: string;
	/** 完成时注入用户消息唤醒模型（默认 true）。 */
	autoReclaim?: boolean;
	/** 完成时 toast（默认 true）。 */
	toast?: boolean;
	/** 供测试注入的钩子：新 result 出现时回调（替代 sendUserMessage/toast）。 */
	onTabFinished?: (runId: string) => void;
	/** 注入用户消息的实现（由 registerEventBus 绑定 pi.sendUserMessage）。 */
	sendUserMessage?: (content: string, opts?: { deliverAs?: string }) => void;
}

let watcher: FSWatcher | null = null;
let seenResults = new Set<string>();

/** 启动时快照：已存在的 result 视为已处理，避免重启后重复触发。 */
function snapshotExisting(runsDir: string): void {
	seenResults = new Set<string>();
	if (!existsSync(runsDir)) return;
	for (const f of readdirSync(runsDir)) {
		if (f.endsWith(".result.json")) seenResults.add(f);
	}
}

/** 检查并处理一个新完成的 runId（幂等）。 */
export function onTabResultFile(runsDir: string, fileName: string, opts: EventBusOptions): boolean {
	if (!fileName.endsWith(".result.json")) return false;
	if (seenResults.has(fileName)) return false;
	seenResults.add(fileName);
	const runId = fileName.slice(0, -".result.json".length);

	if (opts.onTabFinished) {
		opts.onTabFinished(runId);
		return true;
	}

	const result = readTabResultFile(runsDir, runId);
	const status = result?.status ?? "unknown";
	const summary = result?.summary?.slice(0, 200) ?? "(no summary)";
	const artifacts = result?.artifacts?.length ? result.artifacts.slice(0, 5).map((a) => `  • ${a}`).join("\n") : "";
	const reportPath = result?.reportPath ? `
  报告: ${result.reportPath}` : "";
	const openIssues = result?.openIssues?.length ? `
  未决: ${result.openIssues.slice(0, 3).join("; ")}` : "";
	const cost = result?.usage?.cost ? ` ($${result.usage.cost.toFixed(4)})` : "";
	const taskId = result?.taskId ? ` task=${result.taskId}` : "";

	if (opts.toast !== false) {
		const icon = status === "completed" ? "✅" : "❌";
		sendWindowsToast({ title: `${icon} tab ${runId} ${status}${taskId}${cost}`, body: summary.slice(0, 100), duration: "long" });
	}

	refreshAsyncPanel();

	if (opts.autoReclaim !== false) {
		try {
			// 注入用户消息唤醒模型去回收（followUp：主会话忙碌时排队，不打断工具循环）
			const body = [
				`⏱ Tab ${runId} 已完成（${status}${taskId}${cost}）`,
				`摘要: ${summary}`,
				artifacts ? `交付物:\n${artifacts}` : null,
				reportPath || null,
				openIssues || null,
				`下一步: 用 reclaim-tabs({ runIds: ["${runId}"] }) 确认并编排后续。`,
			].filter((l): l is string => Boolean(l)).join("\n");
			opts.sendUserMessage?.(body, { deliverAs: "followUp" });
		} catch {
			/* 注入失败不阻塞 */
		}
	}
	return true;
}

/**
 * 注册事件总线（主会话）。返回清理函数（测试用）。
 */
export function registerEventBus(pi: ExtensionAPI, opts: EventBusOptions = {}): () => void {
	const runsDir = opts.runsDir ?? DEFAULT_TAB_RUNS_DIR;

	// 只主会话注册：标签页/子 agent 不 watch，避免重复唤醒
	if (process.env.PI_TAB_RUN_ID || process.env.PI_SUBAGENT === "1") {
		return () => {};
	}

	snapshotExisting(runsDir);

	// sendUserMessage 从 pi 注入（EventBusOptions 里没有，闭包拿 pi）
	const fullOpts: EventBusOptions = {
		...opts,
		runsDir,
		sendUserMessage: pi.sendUserMessage?.bind(pi),
	};

	if (existsSync(runsDir)) {
		try {
			watcher = watch(runsDir, (_event, fileName) => {
				if (typeof fileName === "string") {
					onTabResultFile(runsDir, fileName, fullOpts);
				}
			});
		} catch {
			watcher = null;
		}
	}

	const cleanup = () => {
		try {
			watcher?.close();
		} catch {
			/* ignore */
		}
		watcher = null;
	};
	return cleanup;
}

/** 测试/调试：手动检查目录里是否有新 result（tick 兜底可调用）。 */
export function pollNewResults(runsDir: string, opts: EventBusOptions): string[] {
	if (!existsSync(runsDir)) return [];
	const fired: string[] = [];
	for (const f of readdirSync(runsDir)) {
		if (f.endsWith(".result.json") && !seenResults.has(f)) {
			if (onTabResultFile(runsDir, f, opts)) fired.push(f);
		}
	}
	return fired;
}

/** 供测试重置内部状态。 */
export function _resetEventBus(): void {
	seenResults = new Set<string>();
	try {
		watcher?.close();
	} catch {
		/* ignore */
	}
	watcher = null;
}
