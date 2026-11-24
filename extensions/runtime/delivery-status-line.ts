/**
 * `runtime/delivery-status-line.ts` — `subagent-win({action:"status"})` 的**交付面**与**截断标记**
 * （P1，2026-11-24，QC 反馈驱动）。
 *
 * ## 为什么需要（H4/H5，QC 反馈 #4 #5）
 *
 * 旧 `status` 输出只有一行 `Output: <前 500 字符>`：
 *   - **截断无声**：`.slice(0,500)` 无任何标记 ⇒ 读的人以为拿到了全文，据此判断「任务没做完」；
 *   - **交付面缺失**：账本里明明有 `consumed` ACK / incident / attempt，status 一个字都不显示
 *     ⇒ 「业务完成」与「交付确认」两个面被混成一个（QC 第 7 条：「完成 vs 未确认矛盾」）。
 *
 * ## 判据纪律（沿用 R-25）
 *
 * 「是否送达」只能看**接收侧消费证据**（`consumed` ACK），不得看发送侧写没写文件。
 * 本模块因此只做一件事：**把账本里已有的接收侧事实读出来**，不推断、不调和。
 *
 * never-throw：账本读不到 ⇒ 返回 null（调用方不显示该行），绝不让 status 崩。
 */

import { effectiveStage, listAcks, listAttempts, loadEvent, deriveEventId, terminalRevisionOf, type DeliveryStage } from "../delivery-ledger.ts";

export interface DeliveryStatusFacts {
	/** 事件 id（`async:<runId>:<revision>`） */
	eventId: string;
	/** 推导出的阶段（`consumed` 才是送达） */
	stage: DeliveryStage;
	/** `consumed` ACK 的时刻（无 ⇒ null） */
	consumedAt: string | null;
	/** `consumed` ACK 的证据串（如 `context-observed`） */
	consumedEvidence: string | null;
	/** attempt 条数（A 通道 + B 补投） */
	attempts: number;
	/** 已发布 incident 的 id（无 ⇒ null） */
	incidentId: string | null;
}

/**
 * 读某个 run 的交付事实。**只读**，never-throw。
 *
 * @param deliveryDir 交付账本目录（生产 = `defaultDeliveryDir()`；测试注入临时目录）
 * @param runId       async run id（与 `ensureEvent` 用的同一个）
 * @param record      该 run 的终态记录（用于复算 `eventId`；缺字段时按空对象处理）
 */
export function deliveryStatusFacts(
	deliveryDir: string,
	runId: string,
	record: Record<string, unknown>,
): DeliveryStatusFacts | null {
	try {
		const eventId = deriveEventId(runId, terminalRevisionOf(record));
		const event = loadEvent(deliveryDir, eventId);
		if (!event) return null; // 账本里没有这个事件（A 通道没走到）⇒ 不显示，不推断
		const attempts = listAttempts(deliveryDir, eventId);
		const acks = listAcks(deliveryDir, eventId);
		const view = effectiveStage(event, attempts, acks, Date.now());
		const consumed = acks.filter((a) => a.stage === "consumed").at(-1) ?? null;
		return {
			eventId,
			stage: view.stage,
			consumedAt: consumed?.at ?? null,
			consumedEvidence: consumed?.evidence ?? null,
			attempts: attempts.length,
			incidentId: event.incidentId ?? null,
		};
	} catch {
		return null;
	}
}

/**
 * 渲染交付面一行（纯函数）。
 *
 * 文案必须让读的人分清三件事：
 *   ① 业务是否完成（由 run 的 `status` 决定，不在这里）；
 *   ② 交付是否**被接收侧确认**（`consumed`）；
 *   ③ 若没确认，是「还在等」还是「已判失败」（`failed_delivery` + incident）。
 */
export function deliveryStatusLine(f: DeliveryStatusFacts | null): string | null {
	if (f === null) return null;
	if (f.stage === "consumed") {
		return `Delivery: consumed ✅ @${f.consumedAt}（证据=${f.consumedEvidence ?? "?"}；attempt=${f.attempts}）—— 接收侧已确认收到`;
	}
	if (f.stage === "failed_delivery") {
		return `Delivery: failed_delivery ⚠️（incident=${f.incidentId ?? "?"}；attempt=${f.attempts}）—— 判死已达期限仍无 consumed ACK，**不是**业务失败`;
	}
	if (f.stage === "expired_dead_lease") {
		return `Delivery: expired_dead_lease（租约持有者进程已死，不再补投；attempt=${f.attempts}）—— 交付通道未坏，但无回执能证明送达`;
	}
	return `Delivery: ${f.stage}（attempt=${f.attempts}；无 consumed ACK）—— 仍在等接收侧确认，**不代表**业务未完成`;
}

/**
 * 给截断的预览加**显式标记**（H4：旧版 `.slice(0,500)` 无声截断）。
 *
 * @param text   全文
 * @param limit  预览长度上限（字符数，不是字节）
 * @param fullPath 全文所在路径（有则写进标记，省一次猜测）
 */
export function truncatePreview(text: string, limit: number, fullPath?: string): string {
	if (text.length <= limit) return text;
	const tail = fullPath ? `；全文 ${fullPath}` : "";
	return `${text.slice(0, limit)}…[已截断：共 ${text.length} 字符，仅显示前 ${limit}${tail}]`;
}
