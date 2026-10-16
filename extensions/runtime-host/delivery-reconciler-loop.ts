/**
 * runtime-host/delivery-reconciler-loop.ts — B 对账通道的**生产承载**（切片 1）
 *
 * 依据：`plans/20261016_b_channel_wiring_plan.md`（切片 1）+ 咨询
 * `plans/20261016_consult_scheduling_and_wake_reliability.md` §6.2/§6.5。
 *
 * ## 为什么在 runtime-host 进程内
 * 咨询 §6.2 硬要求：B 的发现/期限/升级必须在**另一个进程**执行，不能与 A（扩展进程内的
 * `async-result-watcher.ts`）共享 selfDisabled / seen 集合 / `.notified`。runtime-host 是
 * **独立 daemon 进程**，因此本循环天然与 A 处于不同故障域：A 挂了（扩展进程退出/selfDisable）
 * 本循环仍能从**权威终态 JSON**（runs 目录）发现终态并补投/升级。
 *
 * 反向诚实声明（计划 §1）：host 是 **opt-in**（`gui.autoStart` 默认 OFF）⇒ 本循环的可用性
 * = host 可用性。接线后**不得**宣称「唤醒必达已成立」；host 不在时 B 也不在（`degraded`）。
 *
 * ## 职责边界（逐条照抄 delivery-reconciler.ts，**不改其语义**）
 *   - 复用 `reconcileOnce` 做单轮判定（扫描终态 → ensureEvent → retry / fail_delivery）；
 *   - 本文件只负责：**节拍**（start 即扫一轮 + `setInterval(intervalMs).unref()`）、
 *     **round-robin cursor 的持久化**（跨重启不丢）、**统计/错误持久化**、**never-throw**；
 *   - 只**补投/升级**：不写 run 终态、不 kill、不设执行 timer、不 force（runsDir 全程只读）。
 *
 * ## kill switch
 * `PI_DELIVERY_RECONCILER=0`（trim 后恰为 "0"）⇒ 循环**完全不启动**：无 interval、不扫一轮、
 * 不写状态文件、不建事件、不发 incident（零动作）。缺省**启用**（本批目的就是接线）。
 * 回退 = 设该 env（零迁移）或 revert 接线 commit（host 恢复原状）。
 *
 * ## 状态持久化（`<stateDir>/delivery-reconciler.json`）
 * `{cursor,lastTickAt,tickCount,lastError,hostPid}`，tmp+rename 原子写、never-throw。
 * cursor 跨重启保留 ⇒ 上一代 host 扫到一半的 round-robin 位置由新一代继续（不永远只看前 N 条）。
 *
 * ## 投递路径（切片 1 用 `deliver`）
 * 生产缺省投递 = 向**派发者会话**的既有 outbox spool（`<stateDir>/message-outbox/<sha256>`）
 * 写一条**定向持久唤醒**（`to = pi://<dispatcherSessionId>`，dedupeKey 绑 eventId ⇒ 幂等、
 * 不重复注入）。该 spool 由既有的 `outbox-bridge.ts` 在目标会话内消费（「谁的会话谁注入」），
 * 正文带 eventId 标记 ⇒ 接收端 `pi.on("context")` 检出后写 `consumed` ACK（P3 正解）。
 * `armWaker` 省 token 路径留切片 2。
 *
 * ## incident 出口
 * `reconcileOnce` 内 `publishIncident` 已把 incident **持久落盘**（跨重启保留、显式 ack 才清）
 * ——那才是 durable 可见出口。本文件**不新造通道**：`onIncident` 只是 best-effort 通知钩子
 * （host 侧接 stderr → `daemon-stderr.log`），出口失败不影响 incident 本身。
 *
 * 红线：只 import node 内建 + 兄弟纯库（delivery-reconciler / delivery-ledger / delivery-ack /
 * links / runtime/journal / runtime/message-outbox / runtime/address / subagent-kill 的
 * DEFAULT_RUNS_DIR 常量）。**禁** Pi API、**禁** `extensions/index.ts`、**禁** `async-result-watcher.ts`
 * （结构上保证不共享 A 的进程内状态）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { reconcileOnce, type ReconcileOnceOptions, type ReconcileRunResult } from "../delivery-reconciler.ts";
import { defaultDeliveryDir } from "../delivery-ledger.ts";
import { DEFAULT_RUNS_DIR } from "../subagent-kill.ts";
import { defaultLinksPath, listLinks } from "../links.ts";
import { defaultRuntimeDir } from "../runtime/journal.ts";
import { newOutboxItem, outboxDir, outboxItemId, readOutboxItem, writeOutboxItem } from "../runtime/message-outbox.ts";
import { piSessionAddress } from "../runtime/address.ts";
import { eventMarker } from "../delivery-ack.ts";

/** 缺省对账节拍（咨询 §6.2：10s 周期对账；与 A 的 10s tick 同频但**不同进程**）。 */
export const RECONCILE_INTERVAL_MS = 10_000;
/** 每轮扫描页大小（round-robin；cursor 持久化保证不饿死前缀）。 */
export const RECONCILE_PAGE_LIMIT = 50;

// ── 状态（持久化形状 = 计划 §2 逐字）─────────────────────────────

export interface DeliveryReconcilerState {
	/** 上一轮结束时的 round-robin 游标（文件名）；null = 已扫完一轮（下轮从头）。 */
	cursor: string | null;
	lastTickAt: string | null;
	tickCount: number;
	lastError: string | null;
	hostPid: number;
}

export interface DeliveryReconcilerStatus extends DeliveryReconcilerState {
	running: boolean;
	/** running=false 的原因（kill switch / 已 stop）；running=true 时为 undefined。 */
	reason?: "kill-switch" | "stopped";
	intervalMs: number;
	runsDir: string;
	deliverDir: string;
	statePath: string;
	/** 最近一轮的扫描统计（供 `master-status`/GUI 观测；未跑过则为 null）。 */
	lastScan: { scanned: number; results: number; undispatched?: number } | null;
	/**
	 * **B 通道健康（切片 2）**：host 为 opt-in ⇒ host 不在时 B 就缺席，必须能一等可见地
	 * 报 `degraded(reconciler-host-down)`，而不是静默单通道 A。
	 */
	health: DeliveryReconcilerHealth;
}

export function deliveryReconcilerStatePath(stateDir: string = join(defaultRuntimeDir(), "state")): string {
	return join(stateDir, "delivery-reconciler.json");
}

/** 健康判定结果（供 `status()`/`master-status`/GUI 复用）。 */
export interface DeliveryReconcilerHealth {
	status: "ok" | "degraded";
	reason?: "reconciler-host-down" | "reconciler-stale" | "reconciler-error";
	/** `lastTickAt` 到 `now` 的毫秒数（无法计算则 undefined）。 */
	ageMs?: number;
}

/** 默认 stale 阈值：B 的 tick 是 10s，30s = 3 个周期未动即判停摆。 */
export const RECONCILER_STALE_AFTER_MS = 30_000;

/**
 * **B 通道健康（纯函数，切片 2）**：host 为 **opt-in** ⇒ host 不在时 B 就缺席，
 * 必须能**一等可见**地报 `degraded(reconciler-host-down)`，而不是静默单通道 A。
 *
 * 判定顺序（先无、再死、再旧、再错）：
 *   1. 状态文件缺失 ⇒ `reconciler-host-down`（B 从未跑过 / state 被清）；
 *   2. `hostPid` 不存活 ⇒ `reconciler-host-down`（宿主已退出）；
 *   3. `lastTickAt` 缺失或年龄 > `staleAfterMs` ⇒ `reconciler-stale`（循环停摆）；
 *   4. `lastError` 非空 ⇒ `reconciler-error`（循环在跑但报错）；
 *   5. 否则 `ok`。
 * 全部输入可注入 ⇒ 可确定性测试。
 */
export function deliveryReconcilerHealth(
	opts: {
		stateDir?: string;
		now?: number;
		staleAfterMs?: number;
		/** 进程存活探针（缺省用 `process.kill(pid,0)` 语义；测试可注入）。 */
		isPidAlive?: (pid: number) => boolean;
		/** 直接注入状态（测试用；缺省从盘读）。 */
		state?: DeliveryReconcilerState;
	} = {},
): DeliveryReconcilerHealth {
	const now = opts.now ?? Date.now();
	const staleAfter = opts.staleAfterMs ?? RECONCILER_STALE_AFTER_MS;
	const alive = opts.isPidAlive ?? isPidAliveDefault;
	const state = opts.state ?? readDeliveryReconcilerState(opts.stateDir);
	// 1. 从未跑过 / state 被清
	if (opts.state === undefined && !existsSync(deliveryReconcilerStatePath(opts.stateDir))) {
		return { status: "degraded", reason: "reconciler-host-down" };
	}
	// 2. 宿主进程已退出
	if (state.hostPid > 0 && !alive(state.hostPid)) return { status: "degraded", reason: "reconciler-host-down" };
	// 3. 停摆
	if (!state.lastTickAt) return { status: "degraded", reason: "reconciler-stale" };
	const age = now - Date.parse(state.lastTickAt);
	if (!Number.isFinite(age) || age > staleAfter) {
		return { status: "degraded", reason: "reconciler-stale", ageMs: Number.isFinite(age) ? age : undefined };
	}
	// 4. 报错
	if (state.lastError) return { status: "degraded", reason: "reconciler-error", ageMs: age };
	return { status: "ok", ageMs: age };
}

/** 默认存活探针（同 zombie/liveness 口径：EPERM 视为活）。 */
function isPidAliveDefault(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** 读状态（缺失/坏 JSON/字段非法 → 缺省）。never-throw。 */
export function readDeliveryReconcilerState(stateDir?: string): DeliveryReconcilerState {
	const empty: DeliveryReconcilerState = { cursor: null, lastTickAt: null, tickCount: 0, lastError: null, hostPid: 0 };
	try {
		const raw = JSON.parse(readFileSync(deliveryReconcilerStatePath(stateDir), "utf8")) as Record<string, unknown>;
		if (typeof raw !== "object" || raw === null) return empty;
		return {
			cursor: typeof raw.cursor === "string" && raw.cursor.length > 0 ? raw.cursor : null,
			lastTickAt: typeof raw.lastTickAt === "string" ? raw.lastTickAt : null,
			tickCount: typeof raw.tickCount === "number" && Number.isFinite(raw.tickCount) && raw.tickCount > 0 ? Math.floor(raw.tickCount) : 0,
			lastError: typeof raw.lastError === "string" ? raw.lastError : null,
			hostPid: typeof raw.hostPid === "number" && Number.isFinite(raw.hostPid) ? Math.floor(raw.hostPid) : 0,
		};
	} catch {
		return empty;
	}
}

/** 原子写状态（tmp+rename；never-throw：状态持久化失败不得炸对账循环）。 */
function writeDeliveryReconcilerState(stateDir: string, state: DeliveryReconcilerState): boolean {
	try {
		const path = deliveryReconcilerStatePath(stateDir);
		const dir = stateDir;
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
		renameSync(tmp, path);
		return true;
	} catch {
		return false;
	}
}

// ── 生产解析/投递（可注入；测试用隔离目录）────────────────────────

/**
 * 派发者解析（生产缺省）= 复用 `links.ts::listLinks` 的 async 溯源记录。
 *
 * 与 A 侧 `async-result-watcher.ts::asyncDispatcherFor` **同口径但独立实现**（不 import 该模块
 * ⇒ 结构上不共享 A 的模块级状态；这是咨询 §6.2 的硬要求，不是重复代码的疏忽）。
 */
export function resolveDispatcherFromLinks(runId: string, linksPath?: string): string | undefined {
	try {
		for (const link of listLinks(linksPath ?? defaultLinksPath())) {
			if (link.kind !== "async" || link.targetId !== runId) continue;
			if (link.sessionId && link.sessionId !== "unknown") return link.sessionId;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/** 定向持久唤醒正文（**必带 eventId 标记** ⇒ 接收端 context 钩子才能写 `consumed`）。 */
export function buildReconcileWakeBody(event: { eventId: string; runId: string; terminalAt: string }): string {
	return [
		`⏱ [B 对账补投] async run ${event.runId} 终态交付未确认（terminalAt=${event.terminalAt}）。`,
		`下一步: 用 subagent-win({ action: "status", runId: "${event.runId}" }) 取全文。`,
		eventMarker(event.eventId),
	].join("\n");
}

/**
 * 生产缺省投递：向派发者会话的既有 outbox spool 写一条定向持久唤醒。
 *
 * 幂等：`dedupeKey = delivery-reconciler:<eventId>` ⇒ item id 稳定；已存在（pending/delivered/
 * failed/expired 任一终态）则**不重写**（防把已终态项回滚成 pending ⇒ 重复注入）。
 * 只表示「已写入持久投递通道」（attempt.status="sent"，**不是** delivered —— 交付成功仍由
 * 接收端 `consumed` ACK 决定）。
 */
export function makeOutboxDeliver(opts: { stateDir: string }): NonNullable<ReconcileOnceOptions["deliver"]> {
	return (event) => {
		const dedupeKey = `delivery-reconciler:${event.eventId}`;
		const id = outboxItemId(dedupeKey);
		const dir = outboxDir(opts.stateDir);
		if (readOutboxItem(dir, id) !== null) return "sent";
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeOutboxItem(dir, newOutboxItem({
			dedupeKey,
			commandKey: id,
			to: piSessionAddress(event.dispatcherSessionId),
			sessionId: event.dispatcherSessionId,
			text: buildReconcileWakeBody(event),
			now: new Date(),
		}));
		return "sent";
	};
}

// ── 循环 ─────────────────────────────────────────────────────────

export interface DeliveryReconcilerLoopOptions {
	/** 权威终态目录（缺省 `subagent-kill.ts::DEFAULT_RUNS_DIR`，即 env PI_SUBAGENT_RUNS_DIR 口径）。**只读**。 */
	runsDir?: string;
	/** 交付账本目录（缺省 `defaultDeliveryDir()`，即 env PI_RUNTIME_DIR 口径）。 */
	deliverDir?: string;
	/** 状态根（缺省 `<defaultRuntimeDir()>/state`）；状态文件 + outbox spool 都派生自它。 */
	stateDir?: string;
	/** links.jsonl 路径（派发者解析；缺省 env PI_LINKS_PATH → `~/.pi/agent/links.jsonl`）。 */
	linksPath?: string;
	/** 对账节拍 ms（缺省 10_000；`unref()` 不挂住 daemon 事件循环）。 */
	intervalMs?: number;
	/** 每轮页大小（缺省 50）。 */
	limit?: number;
	/** 显式 kill switch（缺省读 env）：false ⇒ 零动作不启动。 */
	killSwitch?: boolean;
	/** 注入点（缺省 = 生产实现，见文件头）。 */
	resolveDispatcher?: (runId: string) => string | undefined;
	deliver?: NonNullable<ReconcileOnceOptions["deliver"]>;
	onIncident?: NonNullable<ReconcileOnceOptions["onIncident"]>;
	/** 时钟注入（缺省 Date.now；测试确定性用）。 */
	now?: () => number;
	/** 诊断日志（缺省静默；host 侧可接 stderr）。 */
	log?: (msg: string) => void;
}

export interface DeliveryReconcilerLoopHandle {
	/** 停循环（幂等、never-throw）。 */
	stop(): void;
	status(): DeliveryReconcilerStatus;
	/** 测试/运维 seam：追加跑一整轮并等待其结束（已串行化，不会与 interval tick 交错）。 */
	runOnce(): Promise<void>;
	/** 启动即扫的那一轮结束（测试可 `await` 后得到确定性单轮结果）。 */
	ready: Promise<void>;
}

/** kill switch：仅 `PI_DELIVERY_RECONCILER` trim 后恰为 "0" 时关闭（缺省启用）。 */
export function deliveryReconcilerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = env.PI_DELIVERY_RECONCILER;
	return !(typeof v === "string" && v.trim() === "0");
}

/**
 * 启动 B 对账循环：
 *   1. kill switch 关 ⇒ 返回**零动作** handle（无 interval、不扫、不写状态）；
 *   2. 读持久状态（cursor 跨重启续接）→ 启动即扫一轮；
 *   3. `setInterval(intervalMs).unref()`；每轮 `reconcileOnce` + 持久化 cursor/统计；
 *   4. never-throw：单轮异常只记 `lastError`，循环不死。
 */
export function startDeliveryReconcilerLoop(opts: DeliveryReconcilerLoopOptions = {}): DeliveryReconcilerLoopHandle {
	const stateDir = opts.stateDir ?? join(defaultRuntimeDir(), "state");
	const runsDir = opts.runsDir ?? DEFAULT_RUNS_DIR;
	const deliverDir = opts.deliverDir ?? defaultDeliveryDir();
	const intervalMs = opts.intervalMs ?? RECONCILE_INTERVAL_MS;
	const limit = opts.limit ?? RECONCILE_PAGE_LIMIT;
	const nowFn = opts.now ?? ((): number => Date.now());
	const resolveDispatcher = opts.resolveDispatcher ?? ((runId: string): string | undefined => resolveDispatcherFromLinks(runId, opts.linksPath));
	const deliver = opts.deliver ?? makeOutboxDeliver({ stateDir });
	const onIncident = opts.onIncident ?? ((inc: { incidentId: string; runId: string; reason: string }): void => {
		try { opts.log?.(`[delivery-reconciler] incident ${inc.incidentId} run=${inc.runId} reason=${inc.reason}`); } catch { /* best-effort */ }
	});
	const statePath = deliveryReconcilerStatePath(stateDir);

	// ── kill switch：零动作（无 interval / 无事件 / 无 incident / 无状态文件写入）──
	if (!(opts.killSwitch ?? deliveryReconcilerEnabled())) {
		const disabled = (reason: "kill-switch" | "stopped"): DeliveryReconcilerStatus => ({
			cursor: null, lastTickAt: null, tickCount: 0, lastError: null, hostPid: process.pid,
			running: false, reason, intervalMs, runsDir, deliverDir, statePath, lastScan: null,
			// kill switch 关闭 ⇒ 零动作，但健康必须诚实：缺状态文件 = host-down 语义
			health: { status: "degraded", reason: "reconciler-host-down" },
		});
		return {
			stop: (): void => { /* 本来就没启动：no-op */ },
			status: (): DeliveryReconcilerStatus => disabled("kill-switch"),
			runOnce: async (): Promise<void> => { /* 零动作 */ },
			ready: Promise.resolve(),
		};
	}

	// cursor 跨重启续接：先用盘上状态，之后由每轮结果推进。
	let state: DeliveryReconcilerState = { ...readDeliveryReconcilerState(stateDir), hostPid: process.pid };
	let running = true;
	let stopped = false;
	let lastScan: DeliveryReconcilerStatus["lastScan"] = null;
	let timer: ReturnType<typeof setInterval> | null = null;
	// 串行化：interval tick 与 runOnce 共用一条链，绝不交错（cursor 推进是读-改-写语义）。
	let chain: Promise<void> = Promise.resolve();

	const runRound = async (): Promise<void> => {
		if (stopped) return;
		const startMs = nowFn();
		try {
			const r = await reconcileOnce({
				runsDir,
				deliverDir,
				limit,
				cursor: state.cursor,
				now: startMs,
				resolveDispatcher,
				deliver,
				onIncident,
			});
			state = {
				cursor: r.nextCursor,
				lastTickAt: new Date(startMs).toISOString(),
				tickCount: state.tickCount + 1,
				lastError: null,
				hostPid: process.pid,
			};
			lastScan = { scanned: r.scanned, results: r.results.length, undispatched: countUndispatched(r.results) };
		} catch (e) {
			// never-throw：单轮异常只记 lastError（cursor 不推进，下轮重试同一页），循环不死。
			state = {
				...state,
				lastTickAt: new Date(startMs).toISOString(),
				tickCount: state.tickCount + 1,
				lastError: String((e as Error)?.message ?? e).slice(0, 300),
				hostPid: process.pid,
			};
		}
		writeDeliveryReconcilerState(stateDir, state);
	};

	const enqueue = (): Promise<void> => {
		chain = chain.then(() => runRound()).catch(() => { /* runRound 自带 never-throw；双保险 */ });
		return chain;
	};

	const ready = enqueue(); // 启动即扫一轮（重启后不等首个 tick）
	timer = setInterval((): void => { void enqueue(); }, intervalMs);
	timer.unref?.();

	return {
		stop: (): void => {
			stopped = true;
			running = false;
			if (timer !== null) {
				try { clearInterval(timer); } catch { /* never-throw */ }
				timer = null;
			}
		},
		status: (): DeliveryReconcilerStatus => ({
			...state,
			running,
			...(running ? {} : { reason: "stopped" as const }),
			intervalMs, runsDir, deliverDir, statePath, lastScan,
			// 健康：以**同一进程内的活状态**判定（不重读盘，避免与实际 state 漂移）
			health: deliveryReconcilerHealth({ stateDir, state: { ...state, hostPid: process.pid } }),
		}),
		runOnce: enqueue,
		ready,
	};
}

/** 统计最近一轮里「判定为 retry 但未真正投出」的条数（观测用；不影响判定）。 */
function countUndispatched(results: ReconcileRunResult[]): number {
	return results.filter((r) => r.action === "retry" && !r.dispatched).length;
}
