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
 * C-3（则上交付，strict 缺省）：delivered **只能** 由接收端 `consumed` ACK 驱动（见
 * `delivery-ack.ts` + 下文「ACK 驱动闭环」）。宿主 `send` 返回值不作为送达证据
 * （生产 `pi.sendUserMessage` 恒 `undefined`）。strict 下：
 *   - `sent`（真 Promise，仅替换上下文路径可达）⇒ confirm 收据 + journal `message.received`
 *     （**received 级**证据）⇒ 仍留 pending 等 consumed ACK；**不写 delivered**；
 *   - `injected-already`（收据回放）⇒ 同上，不写 delivered；
 *   - `busy` / `no-injector` / `unconfirmed` ⇒ 不写终态，释放 claim 供重投；
 *   - `consumed` ACK 出现 ⇒ 补写 delivered + journal `message.delivered`（唯一终态路径）。
 * `PI_DELIVERY_STRICT=0`（回滚档位）恢复旧的「sent/收据 ⇒ delivered」行为。
 *
 * 注册形态同 mailbox-consumer：session_start（子 agent 恒跳过）+ 启动即扫一轮（重启后
 * reclaim 不等首个 tick）+ interval tick（缺省 10s）。所有必要异常内部吞掉，绝不破坏宿主
 * 会话。**接线**：extensions/index.ts 已有 registerOutboxBridge 一行（并行冻结，不重碰）。
 */

import { join } from "node:path";
import { existsSync, mkdirSync, watch as fsWatch, type FSWatcher } from "node:fs";
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
import { claimInjection, confirmInjection, releaseInjectionClaim } from "./runtime/receipts.ts";
import { injectFollowUpQuietly, deliveryStrictEnabled } from "./injection-gate.ts";
import { isSubagent } from "./identity.ts";
// C-3：outbox 项也锚到交付真账本（`outbox_<id>`），delivered 终态改由 `consumed` ACK 驱动。
import { eventMarker } from "./delivery-ack.ts";
import { appendTrace, defaultDeliveryDir, ensureEvent, listAcks, recordAttempt, terminalRevisionOf } from "./delivery-ledger.ts";

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
	/** 交付账本目录（C-3；缺省 defaultDeliveryDir()，测试注入隔离目录）。 */
	deliveryDir?: string;
	now?: Date;
}

// ── 事件驱动唤醒（2004：降低 GUI→会话消息入会话延迟）──────────────────────
// 原 10s tick 保留为兜底（安全网），正常路径由以下两路即时唤醒：
//   (a) 同进程：notifyOutboxArrived(sessionId) — executor/写入侧在 writeOutboxItem 后
//       同进程调用；若目标会话在本进程则零延迟消费。
//   (b) 跨进程：fs.watch(outboxDir) debounce ~200ms — 新 .json 出现即触发一次
//       consumeOutboxOnce（watch 不可用时静默退化到 tick）。
// 进程内 in-flight 守卫：防唤醒与 tick 并发双扫（纯优化，claimInjection 才是去重权威）。

const inFlight = new Set<string>();
const sessionConsumers = new Map<string, (sessionId: string) => void>();

/**
 * 同进程唤醒钩子（事件驱动路径 a）：executor / 写入侧在 writeOutboxItem 成功后调用，
 * 若目标会话桥在本进程则立即 consumeOutboxOnce（零 tick 等待）；跨进程时 no-op
 * （由 fs.watch 路径 b 兜底，最迟 ~200ms）。
 *
 * 约束：
 *   - 不替代 claimInjection 去重（in-flight 守卫只是减少冗余枚举，claim 是权威互斥）；
 *   - 异常内部吞掉（fail-closed），只走 tick 兜底；
 *   - 不引入第二写者（注入仍走 sendUserMessage 路径）。
 */
export function notifyOutboxArrived(sessionId: string): void {
	const wake = sessionConsumers.get(sessionId);
	if (!wake) return; // 跨进程或本会话无桥：no-op（tick/fs.watch 兜底）
	try {
		wake(sessionId);
	} catch {
		/* fail-closed：吞掉只走 tick 兜底 */
	}
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
/**
 * 附件路径块（注入正文的一部分）。
 *
 * 2026-10-19（B 档）：**必须校验存在性**。
 * 旧实现无条件写「N 张…用 read 工具按下列路径读取」——但图片可能已被
 * `pruneUploads`（TTL 7 天）或任何原因删除 ⇒ 正文做出**假承诺**，模型 read 才 ENOENT。
 * 实测复现：outbox 2a95841e 注入「1 张」后文件已不在，read → ENOENT。
 *
 * 对齐 ZCode 的口径（`core/src/runtime/helpers/attachment-placeholder.ts`）：
 * 失效不能伪造内容，必须降级成**可见的形状**并标记失效。
 *
 * 三条硬约束（既有锚，**不得破**）：
 *   1. `undefined` / `[]` ⇒ `""`（无附件时注入正文逐字节不变）
 *   2. 全部有效 ⇒ 旧文案**逐字节不变**（`_test_message_outbox` 的 S3 组锚）
 *   3. 缺省 `exists` = 真实 `existsSync`（生产路径；测试可注入以免依赖真实盘面）
 */
export function attachmentBlock(paths: string[] | undefined, opts?: { exists?: (p: string) => boolean }): string {
	if (paths === undefined || paths.length === 0) return "";
	const exists = opts?.exists ?? existsSync;
	const valid: string[] = [];
	const missing: string[] = [];
	const unprobed: string[] = [];
	for (const p of paths) {
		try {
			(exists(p) ? valid : missing).push(p);
		} catch {
			// 探测本身抛错（EBUSY/权限/IO）⇒ **无法断定**文件不在。
			// S1（L4，2026-10-19）：不得把「暂时探测失败」报成「已过期被清理」——
			// 那会误导用户重传一张其实还在的图。单独一档，只说“读不了”。
			unprobed.push(p);
		}
	}
	if (missing.length === 0 && unprobed.length === 0) {
		// 全有效：文案与旧实现逐字一致（回归锚）
		const lines = valid.map((p, i) => `${i + 1}. ${p}`).join("\n");
		return `\n\n[用户上传图片 ${valid.length} 张；图片未内联在会话里，需要时用 read 工具按下列路径读取]\n${lines}`;
	}
	// 有失效/无法探测：不写「可 read」的假承诺，改成显式形状（仍保留路径供诊断）
	const parts: string[] = [];
	if (valid.length > 0) {
		parts.push(
			`[用户上传图片 ${valid.length} 张可用；图片未内联在会话里，需要时用 read 工具按下列路径读取]`,
			valid.map((p, i) => `${i + 1}. ${p}`).join("\n"),
		);
	}
	let nextIndex = valid.length + 1;
	if (missing.length > 0) {
		parts.push(
			`[另有 ${missing.length} 张图片附件已失效（文件不存在，可能已过期被清理）；不要尝试 read，向用户说明需重新发送]`,
			missing.map((p, i) => `${nextIndex + i}. ${p}`).join("\n"),
		);
		nextIndex += missing.length;
	}
	if (unprobed.length > 0) {
		parts.push(
			`[另有 ${unprobed.length} 张图片附件暂时无法确认（读取探测失败，不等同于已过期）；不要尝试 read，向用户说明可能需重新发送]`,
			unprobed.map((p, i) => `${nextIndex + i}. ${p}`).join("\n"),
		);
	}
	return `\n\n${parts.join("\n")}`;
}

export function buildOutboxInjectBody(
	item: OutboxItem,
	sourceLabel = "Web Console 远程输入",
	eventId?: string,
	attachmentOpts?: { exists?: (p: string) => boolean },
): string {
	const base = `（${sourceLabel}｜dedupe:outbox:${item.id}）\n${item.text}${attachmentBlock(item.attachments, attachmentOpts)}`;
	// C-3：正文携带 eventId 标记 —— 接收端 `pi.on("context")` 才能检出它并写 `consumed` ACK。
	return eventId ? `${base}\n${eventMarker(eventId)}` : base;
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
			// ── C-3：交付真账本关联（`outbox_<id>`），使命中可由接收端 ACK 驱动 ──
			// 纪律：send 返回值**不是**送达证明（生产 `pi.sendUserMessage` 两级 delegate 都不 return
			// ⇒ 恒 `undefined`）；delivered 终态由下方「ACK 驱动闭环」的 `consumed` ACK 决定。
			const dDir = opts.deliveryDir ?? defaultDeliveryDir();
			// C-3：strict（缺省）下 `undefined ⇒ unconfirmed`，且 `sent`/收据只算 received 级证据；
			// delivered 仅由 consumed ACK 写（禁静默回退成 sent）。
			const strict = deliveryStrictEnabled();
			const terminalAt = item.createdAt;
			let eventId: string | undefined;
			try {
				const { event } = ensureEvent(dDir, {
					runId: `outbox_${item.id}`,
					terminalRevision: terminalRevisionOf({
						status: "pending", endedAt: terminalAt,
						result: { status: "pending", text: item.text, outboxId: item.id },
					}),
					terminalSnapshotPath: join(dir, `${item.id}.json`),
					dispatcherSessionId: opts.sessionId,
					observedAt: now(),
					terminalAt,
				});
				eventId = event.eventId;
			} catch { /* 账本失败不阻断投递（best-effort；B 通道可从终态重建） */ }

			// **ACK 驱动闭环（C-3 核心）**：既有 `consumed` ACK ⇒ 交付成立，补写 delivered。
			// 这是唯一**不**依赖 send 返回值的成功路径，也是「unconfirmed 之后崩溃」的收敛点。
			if (eventId) {
				try {
					if (listAcks(dDir, eventId).some((a) => a.stage === "consumed")) {
						const marked = markOutboxItem(dir, item.id, { status: "delivered", at: now(), by: holderOf(opts.sessionId) });
						if (marked !== null) appendBridgeJournalEvent("message.delivered", item, opts, { replayed: true });
						report.consumed.push({ outboxId: item.id, action: "delivered", reason: "ack-consumed" });
						continue;
					}
				} catch { /* 账本读失败：按未确认处理，继续正常投递路径 */ }
			}

			// 注入互斥（at-least-once 重试收敛；stale 10min / 同 holder 自取回接管）。刻意不走
			// preInject：outbox 项按会话寻址（非 master 域），owner 压制不适用；claim 是唯一写入口。
			const claim = claimInjection(claimKeyFor(item), holderOf(opts.sessionId));
			if (claim.status === "claimed-by-other") {
				report.consumed.push({ outboxId: item.id, action: "skipped", reason: "claimed-by-other" });
				continue;
			}
			if (claim.status === "injected-already") {
				// 前一轮已注入但崩溃未回写（收据已存在）。**C-3：收据 ≠ 接收端 consumed 证据**
				// ⇒ strict 下**不写 delivered**，只记 received 级 journal，留 pending 等上方 ACK 闭环收敛；
				// 回滚档位保持旧行为（收据回放 ⇒ 补写 delivered，终态守卫防竞态双写）。
				if (strict) {
					appendBridgeJournalEvent("message.received", item, opts, { replayed: true });
					report.consumed.push({ outboxId: item.id, action: "skipped", reason: "receipt-replayed-await-ack" });
				} else {
					const marked = markOutboxItem(dir, item.id, { status: "delivered", at: now(), by: holderOf(opts.sessionId) });
					if (marked !== null) appendBridgeJournalEvent("message.delivered", item, opts, { replayed: true });
					report.consumed.push({ outboxId: item.id, action: "delivered", reason: "receipt-replayed" });
				}
				continue;
			}
			// 注入本会话（既有用户消息注入路径）。L3：await send 结果再分支；**receipt 只在 "sent"
			// 之后**（.then 衔接，不改整条消费链 async，防竞态面扩大）。
			const holder = holderOf(opts.sessionId);
			const claimKey = claimKeyFor(item);
			const attemptId = eventId ? `${eventId}@OB@${Date.now()}` : undefined;
			injectFollowUpQuietly(opts.sendUserMessage, buildOutboxInjectBody(item, undefined, eventId), { strict }).then((status) => {
				// 尝试入账（**只表示调过发送**；`sent` 也只是 attempted，不等于 delivered）
				if (eventId && attemptId) {
					try {
						recordAttempt(dDir, eventId, {
							attemptId, channel: "A", at: now(),
							status: status === "sent" ? "sent" : status === "busy" ? "busy" : status === "failed" ? "failed" : status === "unconfirmed" ? "unconfirmed" : "no-injector",
							leaseOwner: `OB:${process.pid}`, leaseUntil: new Date(Date.now() + 15_000).toISOString(),
						});
						if (status === "unconfirmed") appendTrace(dDir, { kind: "C3-attempted-unconfirmed", source: "outbox-bridge", outboxId: item.id, eventId });
					} catch { /* best-effort */ }
				}
				if (status === "sent") {
					// 必修 1：confirm 返回值必须核实——失败（收据未落地/claim 被他人接管）不回写
					// delivered（防伪造终态）；留 pending 交下轮收据回放或重投（目标端 dedupe 幂等）。
					const confirmed = confirmInjection(claimKey, holder);
					if (!confirmed) {
						report.consumed.push({ outboxId: item.id, action: "skipped", reason: "confirm-failed" });
						return;
					}
					if (strict) {
						// C-3：`sent`（真 Promise / 宿主已接受）只是 **received 级**证据，不等于接收端 consumed。
						// 不得在此写 delivered（否则 installed 版本靠宿主返回值就“已交付”）；留 pending
						// 等 consumed ACK（上方闭环），否则 60s 后由 B 判 failed_delivery + incident。
						appendBridgeJournalEvent("message.received", item, opts, {});
						report.consumed.push({ outboxId: item.id, action: "skipped", reason: "sent-await-ack" });
						return;
					}
					const marked = markOutboxItem(dir, item.id, { status: "delivered", at: now(), by: holder });
					if (marked !== null) appendBridgeJournalEvent("message.delivered", item, opts, {});
					report.consumed.push({ outboxId: item.id, action: "delivered" });
				} else if (status === "busy") {
					// agent 忙，消息未真正注入：不 confirm、不回写 delivered（留 pending）、不 selfDisable；
					// 释放本次注入互斥（.claiming.json）供下 tick 重新领取重试。
					// at-least-once 收敛：最坏重投一条，目标端按 dedupe:outbox:<id> 标记幂等去重。
					releaseInjectionClaim(claimKey, holder);
					report.consumed.push({ outboxId: item.id, action: "skipped", reason: "busy-retry" });
				} else if (status === "failed") {
					// 真实失败：原失败路径——回写 failed（终态，不再重试）+ journal message.failed 可审计。
					// 不释放/不 confirm（与旧行为一致；.claiming.json 残留经 stale 收敛，item 已终态无害）。
					const error = "inject-failed";
					const marked = markOutboxItem(dir, item.id, { status: "failed", at: now(), by: holder, error });
					if (marked !== null) appendBridgeJournalEvent("message.failed", item, opts, { error });
					report.consumed.push({ outboxId: item.id, action: "failed", reason: error });
				} else if (status === "unconfirmed") {
					// ── C-3：**不把返回值当送达**（P3）──────────────────────────────
					// 生产形态（send 不 return）恒落此分支。不 confirm、不回写 delivered、**不释放**
					// claim（消息可能已入 context；重投交给 10min 租约语义，防重复注入）。交付是否成立
					// 完全由 `consumed` ACK 决定（见上方闭环）；60s 未 consumed ⇒ B 判 failed_delivery
					// + incident；item 仍 pending，TTL 后转 expired（不产生永久孤儿）。
					report.consumed.push({ outboxId: item.id, action: "skipped", reason: "attempted-unconfirmed" });
				} else {
					// no-injector：原 skipped 路径（同步预检 typeof!==function 已 continue，理论不可达；双保险）。
					report.consumed.push({ outboxId: item.id, action: "skipped", reason: "no-injector" });
				}
			});
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
	type: "message.delivered" | "message.received" | "message.failed",
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
 *
 * 2004 事件驱动唤醒：
 *   - (a) 同进程：sessionConsumers 注册唤醒处理器；notifyOutboxArrived 即时消费；
 *   - (b) 跨进程：fs.watch(outboxDir) debounce ~200ms 触发消费；watch 失败静默退化 tick；
 *   - tick 10s 保留为兜底（安全网），不缩短（防竞态面扩大）。
 *   - in-flight 守卫防并发双扫（纯优化；claimInjection 是去重权威，不可替代）。
 */
export function registerOutboxBridge(
	pi: {
		on: (event: string, cb: (event: unknown, ctx?: { sessionManager?: { sessionId?: string } }) => void) => void;
		sendUserMessage?: (body: string, opts?: { deliverAs?: string }) => void;
	},
	opts: { stateDir?: string; journalPath?: string; intervalMs?: number; sourceLabel?: string; pendingTtlMs?: number } = {},
): () => void {
	let interval: ReturnType<typeof setInterval> | null = null;
	let watcher: FSWatcher | null = null;
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;
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
		if (watcher) { try { watcher.close(); } catch { /* */ } watcher = null; }
		if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
		const send = pi.sendUserMessage?.bind(pi);
		const stateDir = opts.stateDir ?? join(defaultRuntimeDir(), "state");
		const outDir = outboxDir(stateDir);

		// 核心消费（带 in-flight 守卫：防唤醒/tick 并发双扫；不替代 claimInjection）
		const doConsume = (): void => {
			if (closed()) return;
			if (inFlight.has(sid)) return; // 已有消费在飞：本次跳过（tick/watch 会再试）
			inFlight.add(sid);
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
			} finally {
				// 延迟清除 in-flight：.then 微任务（注入+回写）跑完后再清
				setImmediate(() => { inFlight.delete(sid); });
			}
		};

		// tick（10s 兜底安全网，保留不缩短）
		const tick = (): void => { doConsume(); };
		tick(); // 启动即扫：重启 reclaim 不等首个 tick
		interval = setInterval(tick, opts.intervalMs ?? 10_000);
		interval.unref?.();

		// (a) 同进程唤醒：注册到 sessionConsumers（notifyOutboxArrived 按 sessionId 查找）
		sessionConsumers.set(sid, doConsume);

		// (b) 跨进程：fs.watch outbox 目录，debounce 200ms 后触发一次消费
		//     watch 失败/不可用 → 静默退化到 tick（fail-closed，不影响宿主会话）
		try {
			// The directory may not exist until the first outbox write; create it so watch
			// is active before that write instead of silently falling back to the 10s tick.
			mkdirSync(outDir, { recursive: true });
			const currentWatcher = fsWatch(outDir, { persistent: false }, (_event, filename) => {
				// 只对 .json 文件事件触发（排除 .tmp 原子写中间态）
				if (!filename || !filename.endsWith(".json")) return;
				if (debounceTimer) clearTimeout(debounceTimer);
				debounceTimer = setTimeout(() => {
					debounceTimer = null;
					doConsume();
				}, 200);
				debounceTimer.unref?.();
			});
			watcher = currentWatcher;
			currentWatcher.on("error", () => {
				/* watch 错误静默：退化 tick 兜底 */
				try { currentWatcher.close(); } catch { /* */ }
				if (watcher === currentWatcher) watcher = null;
			});
		} catch {
			/* fs.watch 不可用（某些 FS/平台）→ 静默退化 tick */
			watcher = null;
		}
	});
	return () => {
		sessionGen++;
		if (interval) clearInterval(interval);
		interval = null;
		if (watcher) { try { watcher.close(); } catch { /* */ } watcher = null; }
		if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
		// 清理同进程唤醒注册（按当前 session；sessionGen 已失配 → closed()=true → doConsume no-op）
		// 不清 sessionConsumers（doConsume 内有 closed() 守卫，安全）；
		// 下一次 session_start 会覆盖同 key。
	};
}
