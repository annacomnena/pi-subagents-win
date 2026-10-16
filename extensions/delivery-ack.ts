/**
 * delivery-ack.ts — 接收端 ACK 写入器（唤醒必达 C-2，咨询 §6.3）
 *
 * ## 为什么需要它
 * P3 已实证：**返回值不可信**（生产 `pi.sendUserMessage()` 恒返回 `undefined`，
 * `agent-session.js:2644-2652` 与 `extensions/loader.js:295-297` 两级都不 return）。
 * 因此「已送达」**不能**由发送方返回值决定；必须由**接收端的可观测事实**决定：
 *   - `received`  = 带 eventId 的消息**持久落盘**（user entry 出现）；
 *   - `consumed`  = 该 eventId 进入**当次模型请求的有效 context**。
 *
 * ## 权威 seam（本机 pi 已确认）
 * `pi.on("context", handler)` 在**每次模型请求前**收到 `event.messages`
 * （`runner.js:1000-1015 emitContext`）—— 这就是「进入本次有效 context」的权威证据来源。
 * 我们**只读**该消息数组、检出 eventId 标记，写 ACK；**不修改** context（纯观察）。
 *
 * ## 纪律（咨询 §6.3）
 * - `consumed` **不靠 LLM 自述**（不解析模型输出说"我收到了"）；靠本地扩展关联 message↔attempt；
 * - 无该 seam 的宿主 ⇒ 最小诚实降级 `attempted-unconfirmed`，**不得**伪造 delivered；
 * - ACK 必须匹配当前授权身份（recipientGeneration）——旧 generation 不能关新任务的单。
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	defaultDeliveryDir,
	listAttempts,
	listEvents,
	writeAck,
	type AckStage,
	type DeliveryEvent,
} from "./delivery-ledger.ts";

/**
 * eventId 在注入正文中的**可见标记**（人可读，机器可提取）。
 *
 * 为何放进正文而不只放元数据：`consumed` 的证据是「该 eventId 进入有效 context」，
 * 而进入 context 的是**消息文本**。因此正文必须自带该标记，接收端才能从
 * `context` 钩子的 messages 里检出它 —— 这也是「不靠 LLM 自述」的实现方式。
 */
export function eventMarker(eventId: string): string {
	return `[evt:${eventId}]`;
}

/** 从任意文本中提取全部 eventId 标记（纯函数）。 */
export function extractEventIds(text: string): string[] {
	const out: string[] = [];
	const re = /\[evt:(async:[^\]\s]+)\]/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) out.push(m[1]);
	return out;
}

/** 从 context messages 中提取全部 eventId（只读；兼容 string 与 content 数组）。 */
export function extractEventIdsFromMessages(messages: unknown[]): string[] {
	const found = new Set<string>();
	for (const msg of messages) {
		if (typeof msg !== "object" || msg === null) continue;
		const content = (msg as { content?: unknown }).content;
		if (typeof content === "string") {
			for (const id of extractEventIds(content)) found.add(id);
		} else if (Array.isArray(content)) {
			for (const part of content) {
				if (typeof part === "string") { for (const id of extractEventIds(part)) found.add(id); continue; }
				const text = (part as { text?: unknown })?.text;
				if (typeof text === "string") for (const id of extractEventIds(text)) found.add(id);
			}
		}
	}
	return [...found];
}

export interface AckWriteResult {
	eventId: string;
	stage: AckStage;
	created: boolean;
	reason?: string;
}

/**
 * 为一批 eventId 写 `consumed` ACK（幂等；`wx` 不可变）。
 *
 * **只在事件确实存在于账本时写**（防止为任意文本伪造 ACK）；
 * attemptId 取该事件**最近一次** attempt（无 attempt 时用 `context-observed` 占位，
 * 表示「消息确实进了 context，但本机无法关联到具体 attempt」—— 如实记录，不冒充关联）。
 */
export function ackConsumed(
	dir: string,
	eventIds: string[],
	opts: { at?: number; recipientGeneration?: number; evidence?: string; disposition?: string } = {},
): AckWriteResult[] {
	const at = opts.at ?? Date.now();
	const isoAt = new Date(at).toISOString();
	const results: AckWriteResult[] = [];
	for (const eventId of eventIds) {
		const event = findEvent(dir, eventId);
		if (!event) {
			results.push({ eventId, stage: "consumed", created: false, reason: "event-not-found" });
			continue;
		}
		const attempts = listAttempts(dir, eventId);
		const attemptId = attempts.at(-1)?.attemptId ?? "context-observed";
		const created = writeAck(dir, {
			eventId,
			stage: "consumed",
			attemptId,
			recipientGeneration: opts.recipientGeneration ?? event.recipientGeneration ?? 1,
			at: isoAt,
			evidence: opts.evidence ?? "context-observed",
			disposition: opts.disposition,
		});
		results.push({ eventId, stage: "consumed", created, reason: created ? undefined : "ack-exists" });
	}
	return results;
}

/** 写 `received` ACK（持久 user entry 落盘的证据）。 */
export function ackReceived(
	dir: string,
	eventIds: string[],
	opts: { at?: number; recipientGeneration?: number; evidence?: string } = {},
): AckWriteResult[] {
	const at = opts.at ?? Date.now();
	const isoAt = new Date(at).toISOString();
	const results: AckWriteResult[] = [];
	for (const eventId of eventIds) {
		const event = findEvent(dir, eventId);
		if (!event) {
			results.push({ eventId, stage: "received", created: false, reason: "event-not-found" });
			continue;
		}
		const created = writeAck(dir, {
			eventId,
			stage: "received",
			attemptId: listAttempts(dir, eventId).at(-1)?.attemptId ?? "persisted-entry",
			recipientGeneration: opts.recipientGeneration ?? event.recipientGeneration ?? 1,
			at: isoAt,
			evidence: opts.evidence ?? "persisted-user-entry",
		});
		results.push({ eventId, stage: "received", created, reason: created ? undefined : "ack-exists" });
	}
	return results;
}

/** 按 eventId 找事件（账本全量扫描，带缓存失效容忍）。 */
function findEvent(dir: string, eventId: string): DeliveryEvent | null {
	for (const e of listEvents(dir, 100_000)) {
		if (e.eventId === eventId) return e;
	}
	return null;
}

/**
 * 从会话 JSONL 里检出 eventId（`received` 的**盘上**证据）。
 *
 * 用途（咨询 §6.3.2）：消息「持久化后」才 ack received —— 故盘上出现即证据；
 * 不在入队调用处 ack。此函数只读，供 A/B 通道与测试使用。
 */
export function scanSessionFileForEventIds(sessionFilePath: string): string[] {
	if (!existsSync(sessionFilePath)) return [];
	try {
		const raw = readFileSync(sessionFilePath, "utf8");
		return extractEventIds(raw);
	} catch {
		return [];
	}
}

/** 扫描目录下所有会话 JSONL（best-effort；供 B 通道跨进程对账用）。 */
export function scanDirForEventIds(dir: string, limit = 200): string[] {
	if (!existsSync(dir)) return [];
	const found = new Set<string>();
	let n = 0;
	try {
		for (const f of readdirSync(dir)) {
			if (!f.endsWith(".jsonl")) continue;
			if (++n > limit) break;
			for (const id of scanSessionFileForEventIds(join(dir, f))) found.add(id);
		}
	} catch { /* best-effort */ }
	return [...found];
}

/** 缺省账本目录（重导出，便于调用方单点 import）。 */
export { defaultDeliveryDir };
