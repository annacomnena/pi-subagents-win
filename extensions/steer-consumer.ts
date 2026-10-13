/**
 * steer-consumer — 标签页侧「立即插入消息」常驻消费者（M1 steer 档 + M2 abort 档）
 *
 * 结构抄 async-result-watcher（fs.watch + tick 兜底 + 三层去重 + 注入门），但语义独立：
 *   - 只消费**自己**的目录 <steerDir>/<tabRunId>/（身份门：getTabRunId()，主会话/子 agent 不消费）；
 *   - 去重三层：内存 seenIds ① + `<id>.claimed` wx 原子认领 ② + injection-gate claimInjection ③；
 *   - 半截 JSON：readSteerRecord 返回 null → 不标 seen、不认领，下 tick 重试（A7）；
 *   - 回执状态机：send resolve 才写 delivered（NOT 已生效——N7 下一个 tool 边界才送达）；
 *     compaction/no-injector → 释放认领重试；其他 reject → failed + error。
 *
 * 两档投递（§3.4）：
 *   - steer 档（M1）：sendUserMessage(body, { deliverAs:"steer" })；
 *   - abort 档（M2）：ctx.abort() → 轮询 ctx.isIdle()（≤30s）→ 空闲后再 sendUserMessage(body)
 *     （**不带 deliverAs**）。ctx 来自 session_start 捕获（会话替换即刷新，§A8）。
 *
 * M2 硬约束（源码级根据，不可违反）：TUI 下 ctx.abort() 经宿主 abortHandler 走
 * restoreQueuedMessagesToEditor → clearAllQueues（把已排队消息清回用户编辑器），故
 * **绝不能「先 steer 再 abort」**（刚入队的 steer 会被清掉）。序列固定为 abort → 等 idle → 再发。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, watch, type FSWatcher } from "node:fs";
import { getCurrentSessionId, getTabRunId, isSubagent, sessionScopeKey, setCurrentSessionId } from "./identity.ts";
import { postInject, preInject, type InjectionContext } from "./injection-gate.ts";
import { releaseInjectionClaim } from "./runtime/receipts.ts";
import {
	ABORT_IDLE_POLL_MS,
	ABORT_IDLE_TIMEOUT_MS,
	claimSteerAtomicDetailed,
	classifySteerSendFailure,
	defaultSteerDir,
	isSteerTerminal,
	listSteerIds,
	readSteerRecord,
	releaseSteerClaim,
	sendSteerDetailed,
	STEER_TICK_MS,
	steerDirForTab,
	withClaim,
	withSteerStatus,
	writeSteerAtomic,
	type SteerRecord,
	type SteerSendResult,
	type SteerStatus,
} from "./steer.ts";

const MAX_SEEN = 500;

/** §5.3 消费结果（M2 扩 "aborted"）。 */
export type SteerConsumeOutcome = "delivered" | "aborted" | "failed" | "skipped";

/** abort 档所需的最小 ctx 形状（ExtensionContext 的子集；用结构判定而非 import 类型）。 */
interface AbortCapableCtx {
	abort(): void;
	isIdle(): boolean;
}

export interface SteerConsumerOptions {
	/** 账本根目录（缺省 ~/.pi/agent/steer/；测试注入隔离目录）。 */
	steerDir?: string;
	/** tick 间隔（缺省 STEER_TICK_MS=5000）。 */
	tickMs?: number;
	/** true = 不挂 fs.watch，只靠 tick（Windows 丢事件路径单测）。 */
	tickOnly?: boolean;
	/** 注入实现（registerSteerConsumer 绑定 pi.sendUserMessage；测试传 fake）。 */
	sendUserMessage?: (content: string, opts?: { deliverAs?: string }) => unknown;
	/** 时间源（测试注入）。 */
	nowFn?: () => Date;
	/** `.claimed` 租约（MF-1）；缺省 STEER_CLAIM_LEASE_MS。测试可注入小值。 */
	claimLeaseMs?: number;
	/** abort 档（M2）：捕获的 ExtensionContext；缺省用 session_start 捕获值。测试可注入假 ctx。 */
	ctx?: unknown;
	/** abort 档：abort → 等 idle 的超时（缺省 ABORT_IDLE_TIMEOUT_MS=30s）。 */
	abortIdleTimeoutMs?: number;
	/** abort 档：等 idle 的轮询间隔（缺省 ABORT_IDLE_POLL_MS=250ms）。 */
	abortPollIntervalMs?: number;
	/** abort 档：abort 发起前一瞬的回调（测试记调用序 / 读盘断言 abortedAt 已落盘）。 */
	onAbort?: () => void;
}

// ── 模块级状态 ─────────────────────────────────────────────────────────

let watcher: FSWatcher | null = null;
let watcherGen = 0;
let watchedRunId: string | null = null;
let seenIds = new Set<string>();
let tickInterval: ReturnType<typeof setInterval> | null = null;
let sessionGen = 0;
/** abort 档：session_start 捕获的 ctx（每次 session_start 刷新，A8）。 */
let capturedCtx: unknown = null;
/**
 * ctx 代次：每次 session_start / reset 递增。abort 档在轮询中用它检测「会话替换」——
 * 代次变化 = 候选 ctx 已失效（旧 runner 的 ctx 在 pi 内被 invalidate），
 * 不做半途误操作，直接回执 failed + stale-ctx。
 */
let ctxGen = 0;

function markSeen(id: string): void {
	seenIds.add(id);
	if (seenIds.size > MAX_SEEN) {
		const first = seenIds.values().next().value;
		if (first) seenIds.delete(first);
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

/** 当前是否有活跃消费者（测试钩子）。 */
export function isSteerConsumerActive(): boolean {
	return watcher !== null || tickInterval !== null;
}

export function resetSteerConsumer(): void {
	sessionGen++;
	seenIds = new Set<string>();
	clearTick();
	closeWatcher();
	watchedRunId = null;
	capturedCtx = null;
	ctxGen++;
}

// ── abort 档（M2）辅助 ────────────────────────────────────────────────

/** pi 在会话替换/reload 后会使旧 ctx 失效，错误文本含 "stale" 与 "ctx"。 */
function isStaleCtxError(e: unknown): boolean {
	const msg = e instanceof Error ? e.message : String(e);
	return /stale/i.test(msg) && /ctx|extension/i.test(msg);
}

/** idle 后发消息（**不带 deliverAs**；空闲态走 prompt() 正常路径起新 turn，N8）。
 *
 * SF-1：失败分类**复用** `classifySteerSendFailure`（与 steer 档同一套 retryable 口径）——
 * compaction / already processing 归 "retryable"，由调用方保持 pending + 释放认领后下 tick 重试。 */
function sendAbortMessage(
	send: ((body: string, opts?: { deliverAs?: string }) => unknown) | undefined,
	body: string,
): Promise<SteerSendResult> {
	if (typeof send !== "function") return Promise.resolve({ status: "no-injector" as const });
	return Promise.resolve()
		.then(() => send(body))
		.then((): SteerSendResult => ({ status: "sent" as const }))
		.catch((e: unknown): SteerSendResult => classifySteerSendFailure(e));
}

/**
 * abort 档（M2，§3.4 / A3 / A8）：打断当前 run（含杀挂死工具进程树）→ 等 idle → 再发消息。
 *
 * 固定序列（**不得调换**，源码根据见文件头）：
 *   1. 先落盘 `abortedAt`（保证「abort 已发生但无回执」窗口为 0）；
 *   2. `ctx.abort()`（TUI 下清队列 + `session.abort()`；工具进程经 killProcessTree 被杀）；
 *   3. 轮询 `ctx.isIdle()`（`abortPollIntervalMs`，≤ `abortIdleTimeoutMs`）；
 *   4. idle → 复核 ctx 代次（SF-2）→ 记 `idleAt`；body 非空 → `sendUserMessage(body)`（不带
 *      deliverAs）→ 记 `deliveredAt`；可重试失败（compaction / already processing / no-injector）
 *      → 释放认领 + 保持 pending，下 tick 重试（SF-1，不写终态）；
 *   5. 终态 `status:"aborted"`（body 为空 = 纯打断，无 `deliveredAt`）；
 *   6. 超时仍非 idle → `failed` + `still-streaming-after-abort`（**绝不伪造 delivered**）。
 *
 * 失败分类：终态写 `no-ctx`（无可用 ctx）、`stale-ctx`（会话替换/ctx 失效，含轮询期间与 send 前
 * 代次变化、send 抛 stale）、`still-streaming-after-abort`（超时）、`abort-failed: …` / `idle-check-failed: …`；
 * 可重试分类不写终态、释放认领保持 pending。
 */
async function runAbortTier(
	steerDir: string,
	claimed: SteerRecord,
	gateCtx: InjectionContext,
	gateHolder: string,
	opts: SteerConsumerOptions,
	now: () => Date,
): Promise<SteerConsumeOutcome> {
	const writeTerminal = (status: SteerStatus, patch: Partial<SteerRecord>): void => {
		try { writeSteerAtomic(steerDir, withSteerStatus(claimed, status, patch)); } catch { /* best-effort */ }
	};

	const ctx = (opts.ctx ?? capturedCtx) as AbortCapableCtx | null | undefined;
	if (!ctx || typeof ctx.abort !== "function" || typeof ctx.isIdle !== "function") {
		writeTerminal("failed", { failedAt: now().toISOString(), error: "no-ctx" });
		postInject(gateCtx, false);
		return "failed";
	}

	// 1) 先落盘 abortedAt：从「发起 abort」的一刻起，账本就带有 abort 证据。
	const abortedAt = now().toISOString();
	try { writeSteerAtomic(steerDir, withSteerStatus(claimed, "pending", { abortedAt })); } catch { /* best-effort */ }

	// 2) abort。gen 在 abort 前取：轮询期间若会话被替换（gen++）→ 立即停手报 stale-ctx。
	const genAtStart = ctxGen;
	opts.onAbort?.();
	try {
		ctx.abort();
	} catch (e) {
		writeTerminal("failed", {
			abortedAt,
			failedAt: now().toISOString(),
			error: isStaleCtxError(e) ? "stale-ctx" : `abort-failed: ${e instanceof Error ? e.message : String(e)}`,
		});
		postInject(gateCtx, false);
		return "failed";
	}

	// 3) 轮询 isIdle（wall-clock 上限，不依赖注入时钟，避免假时钟下死循环）。
	const timeoutMs = opts.abortIdleTimeoutMs ?? ABORT_IDLE_TIMEOUT_MS;
	const pollMs = opts.abortPollIntervalMs ?? ABORT_IDLE_POLL_MS;
	const deadline = Date.now() + timeoutMs;
	let idle = false;
	for (;;) {
		if (ctxGen !== genAtStart) {
			writeTerminal("failed", { abortedAt, failedAt: now().toISOString(), error: "stale-ctx" });
			postInject(gateCtx, false);
			return "failed";
		}
		try {
			idle = ctx.isIdle() === true;
		} catch (e) {
			writeTerminal("failed", {
				abortedAt,
				failedAt: now().toISOString(),
				error: isStaleCtxError(e) ? "stale-ctx" : `idle-check-failed: ${e instanceof Error ? e.message : String(e)}`,
			});
			postInject(gateCtx, false);
			return "failed";
		}
		if (idle) break;
		if (Date.now() >= deadline) break;
		await new Promise<void>((resolve) => { setTimeout(resolve, pollMs); });
	}
	if (!idle) {
		// 超时仍非 idle：绝不伪造 delivered（§3.4-6 / A3 反面）。
		writeTerminal("failed", { abortedAt, failedAt: now().toISOString(), error: "still-streaming-after-abort" });
		postInject(gateCtx, false);
		return "failed";
	}

	// 4) idle 后发消息（空 body = 纯打断，deliveredAt 可缺）。
	//    SF-2：idle 与 send 之间再复核一次 ctx 代次（防御性；两检查间无 await，生产不可达），
	//    绝不在 ctx 已失效时代次漂移后仍发送。
	if (ctxGen !== genAtStart) {
		writeTerminal("failed", { abortedAt, failedAt: now().toISOString(), error: "stale-ctx" });
		postInject(gateCtx, false);
		return "failed";
	}

	const idleAt = now().toISOString();
	if (claimed.body.length === 0) {
		// 纯打断：abort 已发生 + 已观察到 idle，但**未注入任何消息** → 不确认注入（SF-5）。
		writeTerminal("aborted", { abortedAt, idleAt });
		postInject(gateCtx, false);
		return "aborted";
	}

	const sent = await sendAbortMessage(opts.sendUserMessage, claimed.body);
	if (sent.status === "sent") {
		// 真正送达：回执 aborted + deliveredAt，并确认注入收据。
		writeTerminal("aborted", { abortedAt, idleAt, deliveredAt: now().toISOString() });
		postInject(gateCtx, true);
		return "aborted";
	}

	if (sent.status === "retryable" || sent.status === "no-injector") {
		// SF-1：未真正送达（compaction / already processing / 无 injector）→ 释放三层认领，
		// 保持 pending，下 tick 重试（与 steer 档一致，绝不把可重试的活消息写成终态）。
		releaseSteerClaim(steerDir, claimed.tabRunId, claimed.id);
		releaseInjectionClaim(gateCtx.key, gateHolder);
		return "skipped";
	}

	// SF-2：send 抛出的 stale 错归类为 stale-ctx（不能记成 aborted + 通用 error）。
	if (isStaleCtxError(sent.error)) {
		writeTerminal("failed", { abortedAt, failedAt: now().toISOString(), error: "stale-ctx" });
		postInject(gateCtx, false);
		return "failed";
	}

	// 真实失败：abort 已发生 + 已观察到 idle，但消息未送达 → 回执区分「已打断」与「已送达」：
	// 状态仍 aborted（abort 确实发生）但无 deliveredAt、带 error；不确认注入（SF-5）。
	writeTerminal("aborted", { abortedAt, idleAt, error: sent.error ?? "send rejected" });
	postInject(gateCtx, false);
	return "aborted";
}

// ── 单条消费（§3.3 全流程）────────────────────────────────────────────

/**
 * 消费单条记录。任一步失败都**不半途写终态**：
 *   - 半截/损坏/非法 → "skipped"（不标 seen、不认领 → 下 tick 重试）；
 *   - 已终态 / 已被认领 / 已 seen → "skipped"；
 *   - preInject 不注入（cutover 压制/已被他人注入）→ 释放认领 + 回退 seen（at-least-once）；
 *   - steer 档：send resolve → delivered；compaction / no-injector → 释放重试；其他 reject → failed + error；
 *   - abort 档：`runAbortTier`（abort → 等 idle → 再发），回执 aborted / failed+原因。
 */
export async function consumeSteerRecord(
	steerDir: string,
	tabRunId: string,
	id: string,
	opts: SteerConsumerOptions = {},
): Promise<SteerConsumeOutcome> {
	const now = opts.nowFn ?? ((): Date => new Date());
	if (seenIds.has(id)) return "skipped";
	const record = readSteerRecord(steerDir, tabRunId, id);
	if (!record) return "skipped"; // 半截 JSON：不标 seen → 下 tick 重试
	if (record.tabRunId !== tabRunId) {
		markSeen(id); // 记录自称的 tabRunId 与目录不符：永久性畸形，标 seen 防死循环
		return "skipped";
	}
	if (isSteerTerminal(record)) {
		markSeen(id);
		return "skipped";
	}

	// 去重层 ②：跨实例/跨 reload wx 原子认领 + stale 租约接管（MF-1）。
	// SF-1：失败区分「他人持有(held)」与「IO 错误(io-error)」——两者都**不标 seen**：
	//   held → 下 tick 重试，租约过期后可接管（不得被 seenIds 永久挡住）；
	//   io-error → 下 tick 重试。只有终态/畸形记录才进 seenIds（在上方处理）。
	const claim = claimSteerAtomicDetailed(
		steerDir,
		tabRunId,
		id,
		opts.claimLeaseMs !== undefined ? { staleMs: opts.claimLeaseMs } : undefined,
	);
	if (claim !== "claimed") return "skipped";

	// 去重层 ③：注入门互斥。目标是明确的某个 tab → dispatcherWake:true 跳过 owner 压制，
	// 但保留 claimInjection 互斥（与 event-bus 派发者唤醒同范式）。
	const sessionId = getCurrentSessionId() ?? sessionScopeKey();
	const key = `steer-${id}`;
	const gateCtx: InjectionContext = { key, sessionId, path: "steer-channel", dispatcherWake: true };
	const gate = preInject(gateCtx);
	if (!gate.inject) {
		releaseSteerClaim(steerDir, tabRunId, id);
		return "skipped";
	}

	// 认领章落盘（保持 status:"pending"，不引入中间态）；后续终态改写以此为基础，保留 claimedAt/claimedBy
	const claimed = withClaim(record, { claimedBy: sessionId, now: now() });
	try {
		writeSteerAtomic(steerDir, claimed);
	} catch { /* 盖章失败不阻塞投递（记录仍是 pending + 有 .claimed） */ }

	// 分档执行（§3.4）：abort 档序列独立，绝不复用 steer 的 send-first 路径。
	if (claimed.mode === "abort") {
		return runAbortTier(steerDir, claimed, gateCtx, gate.holder, opts, now);
	}

	const sent = await sendSteerDetailed(opts.sendUserMessage, record.body);
	if (sent.status === "sent") {
		try {
			writeSteerAtomic(steerDir, withSteerStatus(claimed, "delivered", { deliveredAt: now().toISOString() }));
		} catch { /* best-effort：投递已发生，回执失败不重投 */ }
		postInject(gateCtx, true);
		return "delivered";
	}

	if (sent.status === "retryable" || sent.status === "no-injector") {
		// 未真正注入：释放三层认领，下 tick 重试（绝不伪造终态）
		releaseSteerClaim(steerDir, tabRunId, id);
		releaseInjectionClaim(key, gate.holder);
		return "skipped";
	}

	// 真实失败：写终态回执
	try {
		writeSteerAtomic(steerDir, withSteerStatus(claimed, "failed", {
			failedAt: now().toISOString(),
			error: sent.error ?? "send rejected",
		}));
	} catch { /* best-effort */ }
	postInject(gateCtx, false);
	return "failed";
}

/**
 * tick/事件全量兜底：扫描自己目录下全部未 seen 记录并消费。
 * 返回本次真正 delivered 的 id 列表（测试钩子 + 观测）。
 *
 * SF-3：**并发**消费（与 fs.watch 路径一致）——一条 abort 档最长 `ABORT_IDLE_TIMEOUT_MS`(30s)
 * 的 idle 轮询不得阻塞同 tick 其余 steer 的投递（head-of-line）。不双发由去重层保证：
 * `.claimed` 的 `openSync("wx")` 原子认领 + 内存 `seenIds`。
 */
export async function pollSteer(
	steerDir: string,
	tabRunId: string,
	opts: SteerConsumerOptions = {},
): Promise<string[]> {
	if (!existsSync(steerDirForTab(steerDir, tabRunId))) return [];
	const ids = listSteerIds(steerDir, tabRunId).filter((id) => !seenIds.has(id));
	const results = await Promise.all(
		ids.map(async (id): Promise<{ id: string; outcome: SteerConsumeOutcome }> => {
			try {
				return { id, outcome: await consumeSteerRecord(steerDir, tabRunId, id, opts) };
			} catch {
				return { id, outcome: "skipped" as const }; // 单条失败不影响其余
			}
		}),
	);
	return results.filter((r) => r.outcome === "delivered").map((r) => r.id);
}

// ── 注册 ──────────────────────────────────────────────────────────────

/**
 * 注册标签页侧 steer 消费者。返回清理函数（被 index.ts collect() 收集）。
 *
 * 身份门：子 agent 恒不注册；其余在 tick 时**惰性**解析 getTabRunId()——
 * 主会话永远没有 runId（不消费）；标签页 flag 就绪后立即建目录 + 挂 watch（A5/A6 前提：
 * 目录必须早于 Master 首次写入而存在，否则 fs.watch 从未挂上）。
 */
export function registerSteerConsumer(pi: ExtensionAPI, opts: SteerConsumerOptions = {}): () => void {
	resetSteerConsumer();

	const steerDir = opts.steerDir ?? defaultSteerDir();
	const fullOpts: SteerConsumerOptions = {
		...opts,
		steerDir,
		sendUserMessage: opts.sendUserMessage ?? (pi.sendUserMessage?.bind(pi) as SteerConsumerOptions["sendUserMessage"]),
	};

	/** 目录 + watcher 就绪（按 runId 幂等；目录被 GC 删掉/换会话时重建重挂）。 */
	const ensureWatch = (tabRunId: string): void => {
		const dir = steerDirForTab(steerDir, tabRunId);
		if (watchedRunId !== tabRunId) {
			// 会话/身份切换：换目录 → 重置内存去重 + 快照已有 .claimed
			closeWatcher();
			seenIds = new Set<string>();
			watchedRunId = tabRunId;
		}
		try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
		if (opts.tickOnly) return;
		if (watcher && existsSync(dir)) return;
		closeWatcher();
		const gen = ++watcherGen;
		try {
			watcher = watch(dir, (_event, fileName) => {
				if (gen !== watcherGen) return;
				if (typeof fileName !== "string" || !fileName.endsWith(".json") || fileName.endsWith(".tmp")) return;
				const id = fileName.slice(0, -".json".length);
				void consumeSteerRecord(steerDir, tabRunId, id, fullOpts).catch(() => { /* 单文件失败不影响其余 */ });
			});
		} catch {
			watcher = null; // 挂不上 → tick 兜底
		}
		snapshotExisting(steerDir, tabRunId, opts.claimLeaseMs);
	};

	const tickOnce = (): void => {
		const tabRunId = getTabRunId();
		if (!tabRunId) return; // 主会话 / 身份未就绪：本 tick 跳过，下次重试
		try {
			ensureWatch(tabRunId);
		} catch { return; } // 不安全 runId → 不消费
		void pollSteer(steerDir, tabRunId, fullOpts).catch(() => { /* tick 失败不影响下轮 */ });
	};

	const begin = (): void => {
		if (isSubagent()) return;
		clearTick();
		const myGen = ++sessionGen;
		tickInterval = setInterval(() => {
			if (myGen !== sessionGen) return; // stale no-op
			tickOnce();
		}, opts.tickMs ?? STEER_TICK_MS);
		tickInterval.unref?.();
		tickOnce(); // 启动即补投（session_start 前已落盘的记录）
	};

	pi.on("session_start", (_event, ctx) => {
		capturedCtx = ctx; // abort 档需要 ctx；每次 session_start 刷新（会话替换 new/fork/switch/reload 均触发）
		ctxGen++;
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
		watchedRunId = null;
	};
}

/**
 * 启动快照（N-1）：**只对终态记录标 seen**；pending 一律不标 seen。
 *
 * 为什么 pending（含新鲜 `.claimed`）也必须不标 seen：生产 `fs.watch` 路径（tickOnly=false）下，
 * 前一实例「claim 成功 → 崩溃 → 立即 reload」会留下**新鲜** `.claimed` + pending；旧实现若把它
 * 标 seen，本实例 tick 的 `if (seenIds.has(id)) continue` 就会永久跳过 → 本会话永久 pending 孤儿（违反 A4）。
 *
 * 「不标 seen 不会造成重复注入」由去重层 ②/③ 保证：
 *   - `.claimed` 新鲜 → `claimSteerAtomicDetailed` 返回 held → skipped（不发送）；
 *   - `.claimed` 陈旧 → 令牌 CAS 唯一赢家接管并发送（at-least-once 收敛到终态）；
 *   - 记录终态 → 下一 tick 读成终态即 skipped + 标 seen。
 */
function snapshotExisting(steerDir: string, tabRunId: string, _claimLeaseMs?: number): void {
	for (const id of listSteerIds(steerDir, tabRunId)) {
		const record = readSteerRecord(steerDir, tabRunId, id);
		if (record && isSteerTerminal(record)) markSeen(id);
	}
}
