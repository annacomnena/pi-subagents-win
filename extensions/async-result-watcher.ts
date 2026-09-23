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
 *   - 注册：session_start；shouldRegisterAsyncResultWatcher()（主会话/任意 tab/有身份会话 watch，子 agent 恒不 watch）
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
import { claimNotified } from "./event-bus.ts";
import { getCurrentSessionId, isMainSession, isSubagent, isTabSession, sessionScopeKey, setCurrentSessionId } from "./identity.ts";
import { defaultLinksPath, listLinks } from "./links.ts";
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
	/** 派发溯源账本路径（缺省 defaultLinksPath()；测试注入隔离文件）。 */
	linksPath?: string;
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

// ── 投递路由 ───────────────────────────────────────────────────────────

/**
 * 定位 async run 的派发者（0923 误投修复，只读路由）。
 *
 * 在 links.jsonl（at 倒序）中找首个 `kind === "async" && targetId === runId`
 * 且 sessionId 可信（非空、非 "unknown"）的记录；损坏行由 listLinks 跳过。
 * 找不到 → undefined（调用方 fail closed，绝不先到先得）。
 * never-throw：listLinks 异常也收敛为 undefined。
 */
function asyncDispatcherFor(runId: string, linksPath: string): string | undefined {
	let links;
	try {
		links = listLinks(linksPath);
	} catch {
		return undefined;
	}
	for (const link of links) {
		if (link.kind !== "async" || link.targetId !== runId) continue;
		if (link.sessionId && link.sessionId !== "unknown") return link.sessionId;
	}
	return undefined;
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

	// 投递路由（0923 误投修复）：async 完成只属于派发者。必须在 markSeen、claimNotified、
	// preInject、toast、panel、hook、注入之前挡住非接收者——零副作用（不标 seen、不认领、
	// 不 toast、不注入；不标 seen 保证派发者恢复后仍可补投）。双域校验复用 event-bus
	// onTabResultFile 范式：派发时身份（tab runId 优先）与恢复后 UUID 任一匹配即放行。
	let dispatcher: string | undefined;
	try {
		dispatcher = asyncDispatcherFor(runId, opts.linksPath ?? defaultLinksPath());
	} catch {
		dispatcher = undefined;
	}
	if (!dispatcher) {
		// fail closed：无派发记录 / 身份不可信 → 不消费，留待人工处理（绝不先到先得）。
		try { console.error(`[async-result-watcher] no async dispatch link for ${runId}, skip (fail closed, awaiting manual handling)`); } catch { /* ignore */ }
		return false;
	}
	if (dispatcher !== sessionScopeKey() && dispatcher !== getCurrentSessionId()) {
		return false; // 非接收者：静默早退（event-bus foreign-recipient 同范式）
	}

	markRunSeen(runId);

	// 去重层 ②：跨实例 wx 原子认领（.notified 文件）
	if (!claimNotified(runsDir, runId)) return false;

	// 去重层 ③：injection-gate 互斥。派发者已在上游确认 → 置 dispatcherWake（复用
	// event-bus Phase 4d 范式）：cutover 下跳过 master owner 压制但保留 claimInjection
	// 互斥；legacy（未切换/无 registry）行为逐字节不变。
	const sessionId = getCurrentSessionId() ?? sessionScopeKey();
	const key = `async-result-${runId}-${record.status}`;
	const gateCtx: InjectionContext = { key, sessionId, path: "legacy-eventbus", dispatcherWake: true };
	const gate = preInject(gateCtx);
	if (!gate.inject) {
		// 未实际发送，不得留下永久已投递标记：释放本次 .notified 认领（本调用刚创建）
		// + 内存 seen，供派发者下 tick 重试（沿用 busy 释放语义；不碰 injection claim——
		// 本路径未持有，holder 门禁防误放他人认领）。
		try { unlinkSync(join(runsDir, `${runId}.notified`)); } catch { /* best-effort */ }
		seenRunIds.delete(runId);
		return false;
	}

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
 * async 专用注册谓词（0923 返修：非 owner tab 派发者注册缺口）。
 *
 * 不复用 event-bus shouldRegisterWatcher()——后者在 legacy 下只放行主会话、
 * cutover 下只放行 attachment owner，会把合法的非 owner tab 派发者挡在门外
 * （该会话派发的 async 终态留置但无人补投）。
 *
 * 放宽注册面安全，理由：
 *   - 路由校验在消费前：onRunFile 先由 asyncDispatcherFor + 身份双域判定，
 *     非接收者零副作用早退（不标 seen、不认领、不注入），fail closed；
 *   - 多 watcher 共存安全：claimNotified（wx 原子）+ injection-gate 互斥保证
 *     exactly-once，多实例同时 watch 同一 run 至多投递一次。
 * 故注册面可放宽（凡可能是派发者的会话都 watch），消费面保持 fail closed。
 */
export function shouldRegisterAsyncResultWatcher(): boolean {
	if (isSubagent()) return false; // 子 agent 恒不 watch
	if (isMainSession()) return true;
	if (isTabSession()) return true; // 任意 tab（含非 owner 派发者）
	return getCurrentSessionId() !== undefined; // 兜底：有会话身份即 watch
}

/**
 * 注册 async run 终态 watcher。返回清理函数（测试用）。
 *
 * 注册条件（async 专用，不复用 event-bus shouldRegisterWatcher）：
 *   - 子 agent 恒不 watch
 *   - 主会话 / 任意 tab（含非 owner 派发者）/ 有会话身份 → watch
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
		if (!shouldRegisterAsyncResultWatcher()) return;
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
