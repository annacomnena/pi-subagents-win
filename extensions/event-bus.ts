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
import { existsSync, openSync, closeSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sendWindowsToast } from "./notify-windows.ts";
import { readTabResultFile } from "./tab-runs.ts";
import { refreshAsyncPanel } from "./async-panel.ts";
import { getCurrentSessionId, isMainSession, setCurrentSessionId } from "./identity.ts";
import { defaultLinksPath } from "./links.ts";
import { recipientSessionIdFor } from "./report.ts";

export const EVENT_BUS_WATCH_KEY = "subagent-event-bus";

const DEFAULT_TAB_RUNS_DIR = join(homedir(), ".pi", "agent", "tab-runs");

export interface EventBusOptions {
	runsDir?: string;
	/** 派发溯源用的 links 路径（测试注入；缺省 ~/.pi/agent/links.jsonl）。 */
	linksPath?: string;
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
let selfDisabled = false; // 旧实例 stale 后停止注入，避免反复报错

/** 启动时快照：已存在的 result 视为已处理，避免重启后重复触发。 */
function snapshotExisting(runsDir: string): void {
	seenResults = new Set<string>();
	if (!existsSync(runsDir)) return;
	for (const f of readdirSync(runsDir)) {
		if (f.endsWith(".result.json")) seenResults.add(f);
	}
}

/**
 * 原子领取「已通知」标记：跨进程/跨实例幂等——无论多少个 watcher/实例
 * （reload 后旧 watcher 未 close 导致的双 watcher），第一个 open('wx') 成功者
 * 获得注入权，其余看到标记直接跳过。根治「双 Follow-up 注入」。
 */
export function claimNotified(runsDir: string, runId: string): boolean {
	try {
		const fd = openSync(join(runsDir, `${runId}.notified`), "wx");
		// 原子创建成功 → 本实例获得注入权
		try { closeSync(fd); } catch { /* ignore */ }
		return true;
	} catch {
		// EEXIST（已被别的实例通知过）或其他错误 → 放弃
		return false;
	}
}

/** 检查并处理一个新完成的 runId（幂等 + 跨实例去重）。 */
export function onTabResultFile(runsDir: string, fileName: string, opts: EventBusOptions): boolean {
	if (selfDisabled) return false; // 旧实例已失效，不再注入
	if (!fileName.endsWith(".result.json")) return false;
	if (seenResults.has(fileName)) return false;
	seenResults.add(fileName);
	const runId = fileName.slice(0, -".result.json".length);

	if (opts.onTabFinished) {
		opts.onTabFinished(runId);
		return true;
	}

	// 会话定位（2026-08-13：与 report.ts 溯源对齐，防止 identityless 会话抢注入权）：
	// 由 links.jsonl 找到派发该 tab 的会话，只有它才注入完成消息；
	// 其他会话静默跳过（不 claim、不 toast、不注入），把唤醒权留给真正的编排会话。
	// 溯源解析不到（旧账本无 sessionId / 非本插件派发）→ 回退 claim 先到先得。
	const recipient = recipientSessionIdFor({ from: runId }, opts.linksPath ?? defaultLinksPath());
	const mySession = getCurrentSessionId();
	if (recipient && mySession && recipient !== mySession) {
		return false;
	}

	// 跨实例幂等：原子领取通知权（双 watcher/双实例只有第一个注入）
	if (!claimNotified(runsDir, runId)) {
		return false; // 已被其他实例通知过 → 静默跳过，不注入
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
			selfDisabled = true; // 旧实例 stale → 停止注入
		}
	}
	return true;
}

/**
 * 注册事件总线（主会话）。返回清理函数（测试用）。
 */
export function registerEventBus(pi: ExtensionAPI, opts: EventBusOptions = {}): () => void {
	// 工厂入口重置模块状态（P1：reload 重跑工厂时不继承旧实例的 selfDisabled/seen*，避免新会话静默失效）
	_resetEventBus();
	const runsDir = opts.runsDir ?? DEFAULT_TAB_RUNS_DIR;

	// 延迟到 session_start 再判定身份并启动 watcher：
	// CLI flag（--tab-run-id）在扩展加载完成后才就绪，工厂里 isMainSession() 不可靠；
	// 非主会话（标签页/子 agent）进程不 watch，避免重复唤醒。
	let sessionGen = 0; // gen token：过期周期的排队回调 no-op，绝不用旧 pi
	pi.on("session_start", (_event, ctx) => {
		if (!isMainSession()) return;
		// 捕获当前会话 UUID（完成消息会话定位的依据；与 report/timers 同模式）
		try {
			setCurrentSessionId((ctx as { sessionManager?: { sessionId?: string } } | undefined)?.sessionManager?.sessionId);
		} catch { /* ctx 不可用则保持 undefined（不注入任何完成消息，宁可静默） */ }

		const myGen = ++sessionGen;
		const closed = (): boolean => myGen !== sessionGen;

		snapshotExisting(runsDir);

		// sendUserMessage 从 pi 注入（EventBusOptions 里没有，闭包拿 pi）
		const fullOpts: EventBusOptions = {
			...opts,
			runsDir,
			linksPath: opts.linksPath ?? defaultLinksPath(),
			sendUserMessage: pi.sendUserMessage?.bind(pi),
		};

		if (existsSync(runsDir)) {
			try {
				watcher = watch(runsDir, (_event, fileName) => {
					if (closed()) return;
					if (typeof fileName === "string") {
						onTabResultFile(runsDir, fileName, fullOpts);
					}
				});
			} catch {
				watcher = null;
			}
		}
	});

	const cleanup = () => {
		sessionGen++; // 使当前周期 closed → 排队回调 no-op
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
	selfDisabled = false;
	try {
		watcher?.close();
	} catch {
		/* ignore */
	}
	watcher = null;
}
