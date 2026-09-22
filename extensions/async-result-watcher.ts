/**
 * async-result-watcher — subagent-runs 终态 watcher：补 async 完成无 LLM 注入缺口
 *
 * 背景（plans/0922_async_result_delivery_research.md）：
 *   async 派发完成后只做 refreshAsyncPanel + sendWindowsToast（TUI/SSH 下不可见），
 *   主会话永远不被唤醒（无 pi.sendUserMessage 注入）。本 watcher 补这一缺口，
 *   与 tab 路径（event-bus deliverAs: followUp 唤醒）对称。
 *
 * 设计：
 *   - 监听 RUNS_DIR（~/.pi/agent/subagent-runs/），只处理 run_*.json
 *     （排除 *_full.md、.notified）
 *   - 触发条件：status !== "running"（覆盖 completed/failed/cancelled/aborted/timeout 全部终态，
 *     含类型外溢值——AsyncRunRecord 声明只有 running/completed/failed，但 runWithFallback
 *     可产出 cancelled/aborted/timeout）
 *   - 半截 JSON：readRunRecord 返回 null → 静默跳过（不标 seen，下次 tick/事件可重试）
 *   - 去重三重（复用 event-bus 模式）：
 *     ① seenRunIds（内存，同实例幂等）
 *     ② claimNotified（.notified 文件 wx 原子，跨实例/跨 reload）
 *     ③ preInject/postInject（injection-gate 互斥）
 *   - 10s tick 兜底：全量扫描（Windows 丢事件 + 进程重启窗口）
 *   - 注册：session_start；shouldRegisterWatcher()（主会话/owner watch，子 agent 恒不 watch）
 *   - 注入内容：只含 runId/agent/终态/产物路径，不含全文
 *     （用 subagent-win({action:"status",runId}) 取全文）
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { watch, type FSWatcher } from "node:fs";
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sendWindowsToast } from "./notify-windows.ts";
import { refreshAsyncPanel } from "./async-panel.ts";
import { claimNotified, shouldRegisterWatcher } from "./event-bus.ts";
import { getCurrentSessionId, setCurrentSessionId } from "./identity.ts";
import { preInject, postInject, injectFollowUpQuietly, type InjectionContext } from "./injection-gate.ts";
import { releaseInjectionClaim } from "./runtime/receipts.ts";
import { NO_POLL_HINT } from "./no-poll.ts";

const DEFAULT_RUNS_DIR = join(homedir(), ".pi", "agent", "subagent-runs");
const TICK_MS = 10_000;
const MAX_SEEN = 500;

/** 与 index.ts AsyncRunRecord 同构（避免循环依赖，独立声明）。 */
interface RunRecord {
	id: string;
	agent?: string;
	task: string;
	status: string;
	result?: {
		status?: string;
		text?: string;
		error?: string;
		usage?: { cost?: number; turns?: number };
	};
	startedAt: string;
	cwd?: string;
}

export interface AsyncResultWatcherOptions {
	/** 监听目录（缺省 ~/.pi/agent/subagent-runs/；测试注入隔离目录）。 */
	runsDir?: string;
	/** 完成时 toast（默认 true）。 */
	toast?: boolean;
	/** 完成时注入用户消息唤醒模型（默认 true）。 */
	autoInject?: boolean;
	/** 注入实现（由 registerAsyncResultWatcher 绑定 pi.sendUserMessage；测试传 fake）。 */
	sendUserMessage?: (content: string, opts?: { deliverAs?: string }) => void;
	/** 供测试注入的钩子：run 终态时回调（返回 true 表示已消费，跳过默认注入）。 */
	onRunFinished?: (runId: string) => void;
}

// ── 模块级状态 ─────────────────────────────────────────────────────────

let watcher: FSWatcher | null = null;
let watcherGen = 0;
let seenRunIds = new Set<string>();
let selfDisabled = false;
let tickInterval: ReturnType<typeof setInterval> | null = null;
let sessionGen = 0;

function markRunSeen(runId: string): void {
	seenRunIds.add(runId);
	if (seenRunIds.size > MAX_SEEN) {
		const first = seenRunIds.values().next().value;
		if (first) seenRunIds.delete(first);
	}
}

function closeWatcher(): void {
	watcherGen++;
	try { watcher?.close(); } catch { /* ignore */ }
	watcher = null;
}

function clearTick(): void {
	if (tickInterval) clearInterval(tickInterval);
	tickInterval = null;
}

// ── 文件工具 ───────────────────────────────────────────────────────────

function isRunFile(fileName: string): boolean {
	return fileName.startsWith("run_") && fileName.endsWith(".json");
}

function runIdFromFile(fileName: string): string {
	return fileName.slice(0, -".json".length);
}

/**
 * 读取并解析 run 记录。
 * 半截 JSON / 文件不存在 / 字段缺失 → 返回 null（调用方静默跳过，不标 seen，
 * 下次 tick/事件可重试——这是「半截 JSON 重试」的核心：未读成即不标 seen）。
 */
function readRunRecord(runsDir: string, runId: string): RunRecord | null {
	try {
		const raw = JSON.parse(readFileSync(join(runsDir, `${runId}.json`), "utf8")) as unknown;
		if (typeof raw !== "object" || raw === null) return null;
		const r = raw as Record<string, unknown>;
		if (typeof r.id !== "string" || typeof r.status !== "string") return null;
		return raw as RunRecord;
	} catch {
		return null;
	}
}

// ── 核心处理 ───────────────────────────────────────────────────────────

/**
 * 释放 async run 的注入认领（L3 忙时冲突静默重试，best-effort）。
 *
 * send 被 busy 拒绝（agent 忙，消息**未真正注入**）时：不 confirm（postInject）、不 selfDisable，
 * 而是释放本 run 的三层去重/认领，让下 tick / 下次 fs 事件重新领取并重试：
 *   1. unlink `<runId>.notified`   （跨实例去重，event-bus claimNotified 的 .notified）
 *   2. releaseInjectionClaim(key, holder)  （注入互斥，.claiming.json；holder 门禁 + best-effort）
 *   3. seenRunIds.delete(runId)    （进程内去重；不删则 onRunFile/pollUnnotified 会跳过，无法重试）
 *
 * at-least-once 收敛：最坏是「释放与投递竞态」→ 重复注入一条，目标（主会话 LLM）可容忍
 * （通知体幂等、status 重取内容相同）。各步 best-effort，失败不抛（残留认领会经 10min stale
 * 接管收敛，不丢消息）。
 */
function releaseAsyncResultClaim(runsDir: string, runId: string, key: string, holder: string): void {
	try { unlinkSync(join(runsDir, `${runId}.notified`)); } catch { /* best-effort */ }
	releaseInjectionClaim(key, holder); // 内部已 best-effort；holder 门禁不误放 stale 接管者
	seenRunIds.delete(runId);
}

/**
 * 处理单个 run 文件（幂等 + 三重去重）。
 * 返回 true 表示已注入/已消费；false 表示跳过。
 */
export function onRunFile(
	runsDir: string,
	fileName: string,
	opts: AsyncResultWatcherOptions,
): boolean {
	if (selfDisabled) return false;
	if (!isRunFile(fileName)) return false;

	const runId = runIdFromFile(fileName);
	if (seenRunIds.has(runId)) return false;

	const record = readRunRecord(runsDir, runId);
	// 半截 JSON / 文件缺失 → 静默跳过（不标 seen，下次 tick/事件可重试）
	if (!record) return false;

	// 只处理终态（status !== "running" 覆盖全部终态值，含类型外溢 cancelled/aborted/timeout）
	if (record.status === "running") return false;

	markRunSeen(runId);

	// 去重层 ②：跨实例 wx 原子认领（.notified 文件）
	if (!claimNotified(runsDir, runId)) return false;

	// 去重层 ③：injection-gate 互斥
	const sessionId = getCurrentSessionId();
	const key = `async-result-${runId}-${record.status}`;
	const gateCtx: InjectionContext = { key, sessionId, path: "legacy-eventbus" };
	const gate = preInject(gateCtx);
	if (!gate.inject) return false;

	// 自定义 hook（返回 true 表示已消费，跳过默认注入）
	if (opts.onRunFinished) {
		if (opts.onRunFinished(runId) === true) {
			postInject(gateCtx, true);
			return true;
		}
	}

	const agent = record.agent ?? "subagent";
	const error = record.result?.error
		? ` — ${record.result.error.replace(/\s+/g, " ").slice(0, 120)}`
		: "";
	const task = (record.task ?? "").slice(0, 80);
	const cost = record.result?.usage?.cost ? ` ($${record.result.usage.cost.toFixed(4)})` : "";

	// Toast（人可见，best-effort）
	if (opts.toast !== false) {
		const icon = record.status === "completed" ? "✅" : "❌";
		try {
			sendWindowsToast({
				title: `${icon} async ${agent} ${runId} ${record.status}${cost}`,
				body: task.slice(0, 100),
				duration: "long",
			});
		} catch { /* best-effort */ }
	}

	// 刷新面板（best-effort）
	try { refreshAsyncPanel(runsDir); } catch { /* best-effort */ }

	// 注入（核心：向归属会话发 followUp 唤醒）
	// L3：await send 结果再分支；**receipt 只在 "sent" 之后**（.then 衔接，不改整条链 async，防竞态面扩大）。
	if (opts.autoInject !== false) {
		const body = [
			`⏱ async ${agent} ${runId} ${record.status}${cost}：${task}${error}`,
			`产物: ${join(runsDir, `${runId}.json`)}`,
			`下一步: 用 subagent-win({ action: "status", runId: "${runId}" }) 取全文。`,
			NO_POLL_HINT,
		].join("\n");
		injectFollowUpQuietly(opts.sendUserMessage, body).then((status) => {
			if (status === "sent") {
				postInject(gateCtx, true); // 注入成功 → 确认收据（receipt 只在 sent 后）
			} else if (status === "busy") {
				// agent 忙，消息未真正注入：不 confirm、不 selfDisable；释放本次认领供下 tick 重试
				//（at-least-once：最坏重投一条，目标可容忍；详见 releaseAsyncResultClaim）。
				releaseAsyncResultClaim(runsDir, runId, key, gate.holder);
			} else if (status === "failed") {
				selfDisabled = true; // 真实失败 → 停止注入（原失败路径）
			} else {
				// no-injector：没有实际发送，不能伪造 receipt；释放后等待注入通道恢复再重试。
				releaseAsyncResultClaim(runsDir, runId, key, gate.holder);
			}
		});
	} else {
		postInject(gateCtx, true);
	}

	return true;
}

// ── tick 兜底 ─────────────────────────────────────────────────────────

/**
 * 全量扫描 run_*.json，处理未见且未 .notified 的终态 run。
 * 覆盖 Windows fs.watch 丢事件 + 进程重启窗口（启动前已完成的 run）。
 */
export function pollUnnotified(
	runsDir: string,
	opts: AsyncResultWatcherOptions,
): string[] {
	if (!existsSync(runsDir)) return [];
	const fired: string[] = [];
	for (const f of readdirSync(runsDir)) {
		if (!isRunFile(f)) continue;
		if (seenRunIds.has(f)) continue; // 已 seen（内存）
		if (onRunFile(runsDir, f, opts)) fired.push(f);
	}
	return fired;
}

// ── 注册 ──────────────────────────────────────────────────────────────

/**
 * 注册 async run 终态 watcher。返回清理函数（测试用）。
 *
 * 注册条件（同 event-bus）：shouldRegisterWatcher()
 *   - 子 agent 恒不 watch
 *   - 主会话（无 tab-run-id、非 subagent）→ watch
 *   - cutover + attachment → 仅 owner watch
 *
 * 延迟到 session_start 再判定身份（CLI flag 在扩展加载完成后才就绪）。
 */
export function registerAsyncResultWatcher(
	pi: ExtensionAPI,
	opts: AsyncResultWatcherOptions = {},
): () => void {
	// P1：reload 重跑工厂时不继承旧实例状态（避免 selfDisabled/seen 残留）
	_resetAsyncResultWatcher();

	const runsDir = opts.runsDir ?? DEFAULT_RUNS_DIR;
	const fullOpts: AsyncResultWatcherOptions = {
		...opts,
		runsDir,
		sendUserMessage: pi.sendUserMessage?.bind(pi),
	};

	const begin = (): void => {
		if (!shouldRegisterWatcher()) return;
		closeWatcher();
		clearTick();
		const gen = ++watcherGen;

		// 启动快照：已有 .notified 的视为已处理（不重复触发）；
		// 无 .notified 的终态 run 不标 seen，由 tick 补投（进程重启窗口补偿）
		snapshotExisting(runsDir);

		if (existsSync(runsDir)) {
			try {
				watcher = watch(runsDir, (_event, fileName) => {
					if (gen !== watcherGen) return; // stale no-op
					if (typeof fileName === "string") {
						try {
							onRunFile(runsDir, fileName, fullOpts);
						} catch { /* 单文件失败不影响其余 */ }
					}
				});
			} catch {
				watcher = null;
			}
		}

		// 10s tick 兜底（Windows 丢事件 + 进程重启前已完成的 run）
		const myGen = ++sessionGen;
		tickInterval = setInterval(() => {
			if (myGen !== sessionGen) return; // stale no-op
			try {
				pollUnnotified(runsDir, fullOpts);
			} catch { /* tick 失败不影响下轮 */ }
		}, TICK_MS);
		tickInterval.unref?.();
	};

	pi.on("session_start", (_event, ctx) => {
		try {
			setCurrentSessionId(
				(ctx as { sessionManager?: { sessionId?: string } } | undefined)?.sessionManager?.sessionId,
			);
		} catch { /* ctx 不可用则保持 undefined */ }
		begin();
	});

	return () => {
		sessionGen++; // 使 tick stale
		clearTick();
		closeWatcher();
	};
}

/**
 * 启动快照：已有 .notified 的 run 视为已处理，标 seen（防重启后重复触发）；
 * 无 .notified 的终态 run 不标 seen，由 tick 补投（进程重启窗口补偿）。
 */
function snapshotExisting(runsDir: string): void {
	seenRunIds = new Set<string>();
	if (!existsSync(runsDir)) return;
	for (const f of readdirSync(runsDir)) {
		if (!isRunFile(f)) continue;
		const runId = runIdFromFile(f);
		if (existsSync(join(runsDir, `${runId}.notified`))) {
			markRunSeen(runId); // 已投递 → 重启/重放去重，不动
		}
	}
}

// ── 测试钩子 ──────────────────────────────────────────────────────────

/** 当前是否有活跃 watcher。 */
export function isAsyncResultWatcherActive(): boolean {
	return watcher !== null;
}

/** 重置内部状态（测试用）。 */
export function _resetAsyncResultWatcher(): void {
	seenRunIds = new Set<string>();
	selfDisabled = false;
	sessionGen++;
	clearTick();
	closeWatcher();
}
