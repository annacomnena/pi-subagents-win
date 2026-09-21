/**
 * runtime/protocol.ts — Agent Communication Fabric v1 协议（Phase 3，设计稿 §24-28）
 *
 * 三分协议（§26）：
 *   Event   = 发生了什么（过去时，run.completed）——Phase 1 envelope type 已承载
 *   Command = 请求某个逻辑对象执行动作（agent.wake / task.cancel / workstream.pause）
 *   Message = Agent 之间的语义通信（REPORT/ESCALATION/QUESTION/DELEGATION/RESULT/ACK/CONTROL）
 *
 * 冻结点（附记 A2 §75.1 同源原则）：
 *   - 三类帧的寻址一律用 ObjectAddress（logical recipient），物理 session 不进协议层（§28）；
 *   - Message 走 Mailbox（mailbox.ts），Event 走 Journal（journal.ts），Command 走 Mailbox
 *     投递 + 目标端执行确认——本文件只定义帧 schema 与校验，不做 IO；
 *   - v1 delivery = at-least-once + consumer idempotency（§27），协议层用 messageId/inReplyTo
 *     支撑幂等与关联。
 *
 * 纯 schema、无 IO、无 Pi API 依赖。
 */

import type { ObjectAddress } from "./address.ts";
import { isObjectAddress } from "./address.ts";
import type { EnvelopeId } from "./ids.ts";

// MessageId 复用 EnvelopeId namespace（msg_ 前缀当初为 Phase 3 预留，§8）：
// 不为 mailbox 发明第二套 id namespace（附记 A2 §75.1 同源原则）。
export type MessageId = EnvelopeId;

const MESSAGE_ID_RE = /^msg_[A-Za-z0-9]+_[A-Za-z0-9]+$/;

export function isMessageId(v: unknown): v is MessageId {
	return typeof v === "string" && MESSAGE_ID_RE.test(v);
}

// ── Message kinds（§26 第一版词表，冻结）──────────────────────────

export const MESSAGE_KINDS = [
	"REPORT",
	"ESCALATION",
	"QUESTION",
	"DELEGATION",
	"RESULT",
	"ACK",
	"CONTROL",
] as const;

export type MessageKind = (typeof MESSAGE_KINDS)[number];

export function isMessageKind(v: unknown): v is MessageKind {
	return typeof v === "string" && (MESSAGE_KINDS as readonly string[]).includes(v);
}

// ── Command 词表（§26 示例 + v1 可扩展白名单；G4 additive 批次一：
// workstream.resume / master.handoff.accept / master.auto-handoff.set，只加不改；
// G5.2 additive：master.handoff.prepare——GUI Prepare 按钮 + 确定性提案路径；
// G6-P2 additive：session.message——Web Console 远程会话输入（outbox 两段式投递，
// to=pi://<sessionId>；agent://master_default executor 层 403 拒收）──

export const COMMAND_TYPES = [
	"agent.wake",
	"task.cancel",
	"workstream.pause",
	"workstream.resume",
	"master.handoff.accept",
	"master.auto-handoff.set",
	"master.handoff.prepare",
	"session.message",
] as const;

export type CommandType = (typeof COMMAND_TYPES)[number];

export function isCommandType(v: unknown): v is CommandType {
	return typeof v === "string" && (COMMAND_TYPES as readonly string[]).includes(v);
}

// ── 帧 schema ─────────────────────────────────────────────────────

/** Command：请求某个逻辑对象执行动作。经 mailbox 投递到目标。 */
export interface CommandFrame {
	frame: "command";
	type: CommandType;
	/** 目标逻辑对象（agent://master 等；session.message 用 pi://<sessionId>）——resolver 决定物理承载 */
	to: ObjectAddress;
	/** 发起方 */
	issuedBy: ObjectAddress;
	/** 命令幂等键（同键重复投递，目标端只执行一次） */
	commandKey: string;
	issuedAt: string;
	payload?: Record<string, unknown>;
}

/** Message：Agent 之间的语义通信。经 mailbox 投递。 */
export interface MessageFrame {
	frame: "message";
	id: MessageId;
	kind: MessageKind;
	from: ObjectAddress;
	/** logical recipient（§28 迁移目标：不再是 sessionId） */
	to: ObjectAddress;
	/** 关联的逻辑对象（run://… / task://… / workstream://…），可空 */
	subject?: string;
	inReplyTo?: MessageId;
	/** ACK 类消息不需要再 ack（防自指循环） */
	requiresAck: boolean;
	sentAt: string;
	body: {
		/** ≤512 UTF-8 字节摘要（journal 同款预算纪律） */
		summary: string;
		/** 结构化补充（引用指针、参数），细节不进协议层 */
		details?: Record<string, unknown>;
	};
}

/** Event 不在此重复定义：Phase 1 的 RuntimeEnvelope（type 过去时）就是 Event 帧。 */
export type FabricFrame = CommandFrame | MessageFrame;

// ── 校验（宽松结构校验，同 envelope.validateEnvelope 风格）────────

export function validateCommandFrame(v: unknown): v is CommandFrame {
	if (typeof v !== "object" || v === null) return false;
	const c = v as Record<string, unknown>;
	return (
		c.frame === "command" &&
		isCommandType(c.type) &&
		isObjectAddress(c.to) &&
		isObjectAddress(c.issuedBy) &&
		typeof c.commandKey === "string" &&
		c.commandKey.length > 0 &&
		typeof c.issuedAt === "string" &&
		(c.payload === undefined || (typeof c.payload === "object" && c.payload !== null))
	);
}

export function validateMessageFrame(v: unknown): v is MessageFrame {
	if (typeof v === "object" || v === null) {
		const m = v as Record<string, unknown>;
		if (
			m.frame === "message" &&
			isMessageId(m.id) &&
			isMessageKind(m.kind) &&
			isObjectAddress(m.from) &&
			isObjectAddress(m.to) &&
			typeof m.sentAt === "string" &&
			typeof m.body === "object" &&
			m.body !== null
		) {
			const body = m.body as Record<string, unknown>;
			return typeof body.summary === "string" && byteLength(body.summary) <= 512;
		}
	}
	return false;
}

function byteLength(s: string): number {
	return new TextEncoder().encode(s).length;
}

/** 工厂：MessageFrame（requiresAck 缺省 true，ACK 类强制 false）。 */
export function newMessageFrame(input: {
	id: MessageId;
	kind: MessageKind;
	from: ObjectAddress;
	to: ObjectAddress;
	subject?: string;
	inReplyTo?: MessageId;
	sentAt: string;
	summary: string;
	details?: Record<string, unknown>;
}): MessageFrame {
	return {
		frame: "message",
		id: input.id,
		kind: input.kind,
		from: input.from,
		to: input.to,
		subject: input.subject,
		inReplyTo: input.inReplyTo,
		requiresAck: input.kind !== "ACK",
		sentAt: input.sentAt,
		body: { summary: input.summary, details: input.details },
	};
}

/** 工厂：CommandFrame。 */
export function newCommandFrame(input: {
	type: CommandType;
	to: ObjectAddress;
	issuedBy: ObjectAddress;
	commandKey: string;
	issuedAt: string;
	payload?: Record<string, unknown>;
}): CommandFrame {
	return {
		frame: "command",
		type: input.type,
		to: input.to,
		issuedBy: input.issuedBy,
		commandKey: input.commandKey,
		issuedAt: input.issuedAt,
		payload: input.payload,
	};
}

/** mailbox spool 的信封：帧 + 投递状态（§27 状态词表，mailbox.ts 落盘用）。 */
export const DELIVERY_STATUSES = ["pending", "claimed", "delivered", "acked", "expired"] as const;

export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export interface Letter<T extends FabricFrame = FabricFrame> {
	frame: T;
	status: DeliveryStatus;
	/** 投递元数据 */
	claimedBy?: string;
	claimedAt?: string;
	ackedAt?: string;
	/** TTL（ISO）；扫描时惰性置 expired */
	expiresAt?: string;
}
