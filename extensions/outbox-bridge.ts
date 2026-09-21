/**
 * outbox-bridge.ts — G6-P2：session.message 第二段投递桥（plans/0920_g6_webconsole_plan.md
 * §3 拍板③：注入 pi 会话 = 异步投递桥，扩展侧消费者复用 mailbox-consumer 轮询模式）。
 *
 * 分工红线（§29：消息投递是确定性两段状态机，非 LLM 链）：
 *   - executor（command-executor.ts runSessionMessage）= 第一段：校验 + wx 幂等 + 写
 *     state/message-outbox/<id>.json status:"pending"（纯状态迁移）；
 *   - 本桥 = 第二段：每个 pi 会话的扩展实例轮询 outbox 中 **to = pi://<本会话 id>** 的
 *     pending 项 → 经既有用户消息注入路径（pi.sendUserMessage，deliverAs followUp，同
 *     mailbox-consumer）注入 **本会话** → 回写 status:"delivered"|"failed" + journal
 *     message.delivered|failed。GUI 永不直写 pi 会话文件；host 进程无注入通道，桥必须在
 *     目标会话内运行（「谁的会话谁注入」，与 mailbox 消费端同不变量）。
 *
 * 投递语义（诚实口径，plans/0922_g6p2_review.md 必修 1）：sendUserMessage 外部副作用与
 * receipt/outbox 回写**非原子事务**——桥在注入后、回写前崩溃，重启后 stale 接管（10min，
 * 同 mailbox 纪律；claim→confirm 全程互斥，同 holder 不开自取回捷径）会再次注入。
 * 这是 **at-least-once**，不是 exactly-once。去重身份：claimInjection 互斥键 = `outbox:<id>`
 * （item id 稳定），且注入正文首行带 `dedupe:outbox:<id>` 标记（同项重投逐字相同）——
 * 目标端按标记幂等去重。
 *
 * 诚实回执（必修 1 核实项）：
 *   - confirmInjection 返回值必须检查：confirm 失败（收据未落地/claim 被他人接管）→
 *     **不**回写 delivered（防伪造终态），留 pending 交下轮（收据回放或重投，目标端去重兜底）；
 *   - sendUserMessage 缺失（host 侧/测试桩未接注入通道）→ skipped(no-injector)，绝不
 *     静默 ok=true 伪造 delivered；
 *   - 注入抛异常 → failed 回写（真实失败，非终局丢失：journal message.failed 可审计）。
 *
 * pending 可恢复终态（必修 2）：每个消费 tick 先 sweepExpiredOutboxItems（TTL 缺省 24h，
 * 状态机见 message-outbox.ts）→ 超龄 pending 转 expired + journal message.expired；host
 * 启动时另扫一次（覆盖「目标会话永不重启」的孤儿面）。不留永久 pending 孤儿。
 *
 * master 护栏在 executor 层（403 master-session-protected），桥永不见 master 目标的项。
 *
 * 注册形态同 mailbox-consumer：session_start（子 agent 恒跳过）+ 启动即扫一轮（重启后
 * reclaim 不等首个 tick）+ interval tick（缺省 10s）。所有必要异常内部吞掉，绝不破坏宿主
 * 会话。**接线**：extensions/index.ts 已有 registerOutboxBridge 一行（并行冻结，不重碰）。
 */

import { join } from "node:path";
import { appendRuntimeEnvelopeSafe, defaultJournalPath, defaultRuntimeDir } from "./runtime/journal.ts";
import { newEventEnvelope } from "./runtime/envelope.ts";
import {
	listOutboxItems,
	markOutboxItem,
	outboxDir,
	sweepExpiredOutboxItems,
	OUTBOX_PENDING_TTL_MS,
	type OutboxItem,
} from "./runtime/message-outbox.ts";
import { piSessionAddress } from "./runtime/address.ts";
import { claimInjection, confirmInjection } from "./runtime/receipts.ts";
import { isSubagent } from "./identity.ts";

export interface ConsumeOutboxOptions {
	sessionId: string;
	/** runtime state 根（缺省 <runtime>/state）；message-outbox 派生自它。 */
	stateDir?: string;
	journalPath?: string;
	/** 注入实现（生产接 pi.sendUserMessage，测试传 fake；抛异常 = 投递失败）。
	 *  缺失 = 本进程无注入通道 → 项全部 skipped(no-injector)，不伪造终态。 */
	sendUserMessage?: (body: string, opts?: { deliverAs?: string }) => void;
	/** 注入正文前缀标注（来源可追溯；测试断言用）。 */
	sourceLabel?: string;
	/** pending TTL（缺省 24h；测试注入更短触发 expired 扫描）。 */
	pendingTtlMs?: number;
	now?: Date;
}

export interface OutboxConsumeEntry {
	outboxId: string;
	action: "delivered" | "failed" | "skipped" | "expired";
	reason?: string;
}

export interface OutboxConsumeReport {
	sessionId: string;
	consumed: OutboxConsumeEntry[];
}

/** 注入互斥键（receipts 命名空间内 outbox: 前缀，与 run-/msg:/cmd: 键形不重叠）。 */
function claimKeyFor(item: OutboxItem): string {
	return `outbox:${item.id}`;
}

/**
 * 注入正文：dedupe 标记 + 来源标注 + 原文。dedupe 标记 = outbox item id（稳定身份，同项
 * 重投逐字相同）——目标端据此幂等去重（at-least-once 的对偶约束）。正文逐字保留
 * （控制字符已由 executor payload 白名单拒绝）。
 */
export function buildOutboxInjectBody(item: OutboxItem, sourceLabel = "Web Console 远程输入"): string {
	return `（${sourceLabel}｜dedupe:outbox:${item.id}）\n${item.text}`;
}

/**
 * 消费一轮（目标会话的扩展实例调用）：先扫 expired（pending 可恢复终态，必修 2）→ 枚举
 * 本会话 pending 项 → claimInjection 互斥 → 注入 → 核实 confirm → 回写 outbox 状态 +
 * journal。单封失败不影响其余；顶层 never-throw。
 */
export function consumeOutboxOnce(opts: ConsumeOutboxOptions): OutboxConsumeReport {
	const report: OutboxConsumeReport = { sessionId: opts.sessionId, consumed: [] };
	try {
		return consumeOutboxOnceInner(opts);
	} catch {
		return report;
	}
}

function consumeOutboxOnceInner(opts: ConsumeOutboxOptions): OutboxConsumeReport {
	const report: OutboxConsumeReport = { sessionId: opts.sessionId, consumed: [] };
	const dir = outboxDir(opts.stateDir ?? defaultStateDir());
	const myAddress = piSessionAddress(opts.sessionId);
	// 必修 2：每 tick 先扫 expired（TTL 内不迁移；幂等，重复扫零副作用）
	try {
		for (const ex of sweepExpiredOutboxItems(dir, {
			now: opts.now,
			...(opts.pendingTtlMs !== undefined ? { ttlMs: opts.pendingTtlMs } : {}),
			journalPath: opts.journalPath,
			by: holderOf(opts.sessionId),
		})) {
			report.consumed.push({ outboxId: ex.id, action: "expired", reason: `pending 超 TTL（${Math.round((opts.pendingTtlMs ?? OUTBOX_PENDING_TTL_MS) / 3600_000)}h）` });
		}
	} catch {
		/* 扫描失败不阻塞投递 */
	}
	const items = listOutboxItems(dir).filter((it) => it.to === myAddress && it.status === "pending");
	const now = (): string => (opts.now ?? new Date()).toISOString();
	for (const item of items) {
		try {
			// 无注入通道（host 进程 / 未接桩）：诚实 skipped，绝不静默伪造 delivered（必修 1）
			if (typeof opts.sendUserMessage !== "function") {
				report.consumed.push({ outboxId: item.id, action: "skipped", reason: "no-injector" });
				continue;
			}
			// 注入互斥（at-least-once 重试收敛；stale 10min / 同 holder 自取回接管）。刻意不走
			// preInject：outbox 项按会话寻址（非 master 域），owner 压制不适用；claim 是唯一写入口。
			const claim = claimInjection(claimKeyFor(item), holderOf(opts.sessionId));
			if (claim.status === "claimed-by-other") {
				report.consumed.push({ outboxId: item.id, action: "skipped", reason: "claimed-by-other" });
				continue;
			}
			if (claim.status === "injected-already") {
				// 前一轮已注入但崩溃未回写：收据回放 → 补写 delivered（终态守卫防竞态双写）
				const marked = markOutboxItem(dir, item.id, { status: "delivered", at: now(), by: holderOf(opts.sessionId) });
				if (marked !== null) appendBridgeJournalEvent("message.delivered", item, opts, { replayed: true });
				report.consumed.push({ outboxId: item.id, action: "delivered", reason: "receipt-replayed" });
				continue;
			}
			// 注入本会话（既有用户消息注入路径；抛异常 = failed）
			let ok = false;
			let error: string | undefined;
			try {
				opts.sendUserMessage(buildOutboxInjectBody(item), { deliverAs: "followUp" });
				ok = true;
			} catch (e) {
				error = (e instanceof Error ? e.message : String(e)).slice(0, 512);
				ok = false;
			}
			// 必修 1：confirm 返回值必须核实——失败（收据未落地/claim 被他人接管）不回写
			// delivered（防伪造终态）；留 pending 交下轮收据回放或重投（目标端 dedupe 幂等）。
			const confirmed = ok ? confirmInjection(claimKeyFor(item), holderOf(opts.sessionId)) : false;
			if (ok && !confirmed) {
				report.consumed.push({ outboxId: item.id, action: "skipped", reason: "confirm-failed" });
				continue;
			}
			const marked = markOutboxItem(dir, item.id, {
				status: ok ? "delivered" : "failed",
				at: now(),
				by: holderOf(opts.sessionId),
				...(ok ? {} : { error: error ?? "inject-failed" }),
			});
			if (marked !== null) {
				appendBridgeJournalEvent(ok ? "message.delivered" : "message.failed", item, opts, ok ? {} : { error });
			}
			report.consumed.push({ outboxId: item.id, action: ok ? "delivered" : "failed", ...(ok ? {} : { reason: error }) });
		} catch (e) {
			report.consumed.push({ outboxId: item.id, action: "skipped", reason: e instanceof Error ? e.message : String(e) });
		}
	}
	return report;
}

function holderOf(sessionId: string): string {
	return `outbox-bridge:${sessionId}`;
}

/** 桥缺省 state 根（同 command-executor：defaultRuntimeDir()/state；env PI_RUNTIME_DIR 隔离）。 */
function defaultStateDir(): string {
	return join(defaultRuntimeDir(), "state");
}

/**
 * 两段回执第二段 journal 事件（safe wrapper，写失败不影响桥；错误摘要 ≤512 字节）。
 * payload 只含受控关联字段（commandKey/outboxId/sessionId），正文 text 永不进 journal
 * （§15 大内容不进信封；正文唯一落点是 outbox 盘面与会话转写）。
 */
function appendBridgeJournalEvent(
	type: "message.delivered" | "message.failed",
	item: OutboxItem,
	opts: ConsumeOutboxOptions,
	extra: { error?: string; replayed?: boolean },
): void {
	try {
		const at = (opts.now ?? new Date()).toISOString();
		appendRuntimeEnvelopeSafe(
			newEventEnvelope({
				type,
				source: piSessionAddress(item.sessionId),
				subject: item.to,
				at,
				recordedAt: at,
				payload: {
					commandKey: item.commandKey,
					outboxId: item.id,
					sessionId: item.sessionId,
					...(extra.error !== undefined ? { error: extra.error } : {}),
					...(extra.replayed === true ? { replayed: true } : {}),
				},
				dedupeKey: `${type}:${item.id}`,
			}),
			opts.journalPath ?? defaultJournalPath(),
		);
	} catch {
		/* safe wrapper 自吞，双保险 */
	}
}

/**
 * 注册桥循环（形态同 registerMailboxConsumer：session_start + 启动即扫 + interval tick）。
 * 子 agent 恒不注册；sessionId 不可得时不注册（无地址可匹配，注入必错投）。
 * 启动即扫（必修 2 重启 reclaim：目标会话重启后不等首个 tick 即消费遗留 pending）。
 * cutover 状态无关：outbox 项按会话寻址，投递不依赖 master 域开关。
 */
export function registerOutboxBridge(
	pi: {
		on: (event: string, cb: (event: unknown, ctx?: { sessionManager?: { sessionId?: string } }) => void) => void;
		sendUserMessage?: (body: string, opts?: { deliverAs?: string }) => void;
	},
	opts: { stateDir?: string; journalPath?: string; intervalMs?: number; sourceLabel?: string; pendingTtlMs?: number } = {},
): () => void {
	let interval: ReturnType<typeof setInterval> | null = null;
	let sessionGen = 0;
	pi.on("session_start", (_event, ctx) => {
		try {
			if (isSubagent()) return;
		} catch {
			return;
		}
		const sid = (ctx as { sessionManager?: { sessionId?: string } } | undefined)?.sessionManager?.sessionId;
		if (!sid || sid === "unknown") return;
		const myGen = ++sessionGen;
		const closed = (): boolean => myGen !== sessionGen;
		if (interval) clearInterval(interval);
		const send = pi.sendUserMessage?.bind(pi);
		const tick = (): void => {
			if (closed()) return;
			try {
				consumeOutboxOnce({
					sessionId: sid,
					stateDir: opts.stateDir,
					journalPath: opts.journalPath,
					sendUserMessage: send,
					...(opts.pendingTtlMs !== undefined ? { pendingTtlMs: opts.pendingTtlMs } : {}),
					...(opts.sourceLabel !== undefined ? { sourceLabel: opts.sourceLabel } : {}),
				});
			} catch {
				/* 桥永不破坏宿主会话 */
			}
		};
		tick(); // 启动即扫：重启 reclaim 不等首个 tick
		interval = setInterval(tick, opts.intervalMs ?? 10_000);
		interval.unref?.();
	});
	return () => {
		sessionGen++;
		if (interval) clearInterval(interval);
		interval = null;
	};
}
