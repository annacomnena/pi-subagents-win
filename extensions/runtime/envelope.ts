/**
 * runtime/envelope.ts — Runtime Envelope（Phase 1D，设计稿 §8）
 *
 * 统一信封：Event / Command / Message 共用一个 schema。
 *
 * 原则（设计稿 §8）：
 *   - Phase 1 只产生 Event（newEventEnvelope）；Command/Message transport 属 Phase 3，
 *     但 schema 三种 kind 一次定义冻结（避免 Phase 3 换格式）。
 *   - 大内容不进信封：payload 只放轻量摘要，重物走 payloadRef（§15）。
 *   - validateEnvelope 是 tolerant read 的守门员：磁盘上任何不合 schema 的行
 *     都会被 journal 跳过而不是炸掉读者。
 */

import { newEnvelopeId } from "./ids.ts";
import { isObjectAddress, type ObjectAddress } from "./address.ts";

// ── 类型 ───────────────────────────────────────────────────────────

export type EnvelopeKind = "event" | "command" | "message";

export interface RuntimeEnvelope<T = unknown> {
	version: 1;

	id: string;

	kind: EnvelopeKind;

	/** 事件类型名（如 run.dispatched / run.completed），点分层命名空间。 */
	type: string;

	source: ObjectAddress;

	target?: ObjectAddress;

	/** 信封所描述的对象（subject 与 source/target 不同：事件 about 它）。 */
	subject?: ObjectAddress;

	correlationId?: string;
	causationId?: string;

	priority?: number;
	ttlMs?: number;

	payload?: T;
	payloadRef?: string;

	/** 领域发生时间（业务事实）；与 at 的分工见下。 */
	recordedAt?: string;

	/** 幂等去重键：`<type>:<subject>`；同键重放 = 同一事件，projector 按此幂等（terra 裁决缺陷 4）。 */
	dedupeKey?: string;

	at: string;
}

// ── 工厂（Phase 1 只产 Event）─────────────────────────────────────

export interface NewEventEnvelopeInput<T = unknown> {
	type: string;
	source: ObjectAddress;
	target?: ObjectAddress;
	subject?: ObjectAddress;
	correlationId?: string;
	causationId?: string;
	priority?: number;
	ttlMs?: number;
	payload?: T;
	payloadRef?: string;
	/** ISO 时间；缺省 = 生成时刻。
	 *
	 * at 语义（terra 裁决 #10，v1 冻结）：at = 领域发生时间（业务事实，如 dispatchedAt/finishedAt），
	 * recordedAt = 本信封构造/落盘时间（诊断用）。Timeline 排序与状态机以 at 为准，
	 * recordedAt 仅用于观测写入延迟。
	 */
	at?: string;
	recordedAt?: string;
	dedupeKey?: string;
}

/** 构造 event 信封；id 自动生成（evt_ 前缀）。字段非法立即抛错（构造期_fail-fast_，运行期由 Safe wrapper 兜底）。 */
export function newEventEnvelope<T>(input: NewEventEnvelopeInput<T>, now: Date = new Date()): RuntimeEnvelope<T> {
	const envelope: RuntimeEnvelope<T> = {
		version: 1,
		id: newEnvelopeId("evt", now),
		kind: "event",
		type: input.type,
		source: input.source,
		at: input.at ?? now.toISOString(),
	};
	if (input.target !== undefined) envelope.target = input.target;
	if (input.subject !== undefined) envelope.subject = input.subject;
	if (input.correlationId !== undefined) envelope.correlationId = input.correlationId;
	if (input.causationId !== undefined) envelope.causationId = input.causationId;
	if (input.priority !== undefined) envelope.priority = input.priority;
	if (input.ttlMs !== undefined) envelope.ttlMs = input.ttlMs;
	if (input.payload !== undefined) envelope.payload = input.payload;
	if (input.payloadRef !== undefined) envelope.payloadRef = input.payloadRef;
	if (input.recordedAt !== undefined) envelope.recordedAt = input.recordedAt;
	if (input.dedupeKey !== undefined) envelope.dedupeKey = input.dedupeKey;

	const errs = validateEnvelope(envelope);
	if (errs.length > 0) throw new Error(`newEventEnvelope: invalid envelope — ${errs.join("; ")}`);
	return envelope;
}

// ── 校验（§16.3：version/id/kind/type/source/at 缺失时拒绝）────────

const ENVELOPE_KINDS: readonly EnvelopeKind[] = ["event", "command", "message"];

export function validateEnvelope(x: unknown): string[] {
	const errs: string[] = [];
	if (typeof x !== "object" || x === null) return ["envelope must be a non-null object"];
	const e = x as Record<string, unknown>;

	if (e.version !== 1) errs.push("version must be 1");
	if (typeof e.id !== "string" || e.id.length === 0) errs.push("id must be a non-empty string");
	if (typeof e.kind !== "string" || !ENVELOPE_KINDS.includes(e.kind as EnvelopeKind)) {
		errs.push(`kind must be one of ${ENVELOPE_KINDS.join("|")}`);
	}
	if (typeof e.type !== "string" || e.type.length === 0) errs.push("type must be a non-empty string");
	if (typeof e.source !== "string" || !isObjectAddress(e.source)) errs.push(`source must be a valid ObjectAddress: ${String(e.source)}`);
	if (e.target !== undefined && (typeof e.target !== "string" || !isObjectAddress(e.target))) errs.push("target must be a valid ObjectAddress");
	if (e.subject !== undefined && (typeof e.subject !== "string" || !isObjectAddress(e.subject))) errs.push("subject must be a valid ObjectAddress");
	if (typeof e.at !== "string" || e.at.length === 0 || !Number.isFinite(Date.parse(e.at))) {
		errs.push("at must be a parseable ISO time string");
	}
	if (e.priority !== undefined && typeof e.priority !== "number") errs.push("priority must be a number");
	if (e.ttlMs !== undefined && (typeof e.ttlMs !== "number" || !Number.isFinite(e.ttlMs) || e.ttlMs <= 0)) errs.push("ttlMs must be a positive finite number");
	if (e.payloadRef !== undefined && typeof e.payloadRef !== "string") errs.push("payloadRef must be a string");
	if (e.recordedAt !== undefined && (typeof e.recordedAt !== "string" || e.recordedAt.length === 0 || !Number.isFinite(Date.parse(e.recordedAt)))) errs.push("recordedAt must be a parseable ISO time string");
	if (e.dedupeKey !== undefined && (typeof e.dedupeKey !== "string" || e.dedupeKey.length === 0 || /\s/.test(e.dedupeKey))) errs.push("dedupeKey must be a non-empty whitespace-free string");
	if (e.correlationId !== undefined && typeof e.correlationId !== "string") errs.push("correlationId must be a string");
	if (e.causationId !== undefined && typeof e.causationId !== "string") errs.push("causationId must be a string");

	return errs;
}
