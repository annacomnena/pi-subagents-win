/**
 * runtime/adapters/session-lifecycle.ts — Rollover lifecycle 审计（Phase 4b，A4 77.3/F4）
 *
 * registry 提交优先、journal 事件只做审计（best-effort）：
 *   attachMasterWithAudit → 先 registry.attachMaster，再按结果 emit
 *   detachMasterWithAudit → 先 registry.detachMaster，再按结果 emit
 *   takeoverMasterWithAudit → 先 registry.takeoverMaster，再按结果 emit（0920 backlog B）
 * journal 写失败绝不影响 registry 结果（调用方拿到的 Attach/DetachResult
 * 与无审计时完全一致；audit 明细只报告 emit 成功与否）。
 *
 * 事件词表（§14 Phase-4 修正案，A4 F3/Q4 修正）：
 *   agent.session.attaching / agent.session.attached / agent.session.attaching_failed
 *   agent.session.detaching / agent.session.detached / agent.session.detaching_failed
 *   agent.session.taking_over / agent.session.takeover / agent.session.takeover_failed
 * subject = source = agent 地址（self-accounting）；dedupeKey：
 *   attempt 类 → type:subject:attemptId；terminal 类 → type:subject:generation。
 * 失败用显式 *_failed 类型（与 attempt 不同的 claim 槽，不与 attaching 碰撞）。
 *
 * 本文件无接线（4d 才接 session_start）；调用方 = 测试 + 未来的显式 attach 命令。
 */

import { attachMaster, detachMaster, takeoverMaster, type AttachInput, type AttachResult, type DetachResult, type TakeoverMasterInput, type TakeoverMasterResult } from "../registry.ts";
import { masterAddress, type ObjectAddress } from "../address.ts";
import { emitRuntimeEventOnce } from "../journal.ts";
import { newEventEnvelope, type RuntimeEnvelope } from "../envelope.ts";

export const SESSION_LIFECYCLE_TYPES = [
	"agent.session.attaching",
	"agent.session.attached",
	"agent.session.attaching_failed",
	"agent.session.detaching",
	"agent.session.detached",
	"agent.session.detaching_failed",
	"agent.session.taking_over",
	"agent.session.takeover",
	"agent.session.takeover_failed",
] as const;

export type SessionLifecycleType = (typeof SESSION_LIFECYCLE_TYPES)[number];

export interface SessionLifecyclePayload {
	agentAddress: ObjectAddress;
	sessionId: string;
	generation?: number;
	attemptId: string;
	ok: boolean;
	reason?: string;
}

export interface AuditDetail {
	attemptId: string;
	attemptEmitted: boolean;
	terminalEmitted: boolean;
}

function lifecycleEvent(
	type: SessionLifecycleType,
	payload: SessionLifecyclePayload,
	at: string,
): RuntimeEnvelope {
	const subject = payload.agentAddress;
	const dedupeKey =
		type === "agent.session.attached" || type === "agent.session.detached" || type === "agent.session.takeover"
			? `${type}:${subject}:${payload.generation}`
			: `${type}:${subject}:${payload.attemptId}`;
	return newEventEnvelope({
		type,
		source: payload.agentAddress,
		subject,
		at,
		recordedAt: at,
		dedupeKey,
		payload,
	});
}

function newAttemptId(): string {
	return `att_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * attach + 审计。registry 结果原样返回；audit 只报告 emit 情况。
 * 顺序：attaching（attempt）→ registry.commit → attached / attaching_failed。
 */
export function attachMasterWithAudit(
	input: AttachInput,
	opts: { journalPath?: string } = {},
): AttachResult & { audit: AuditDetail } {
	const agent = input.agent ?? masterAddress();
	const attemptId = newAttemptId();
	const audit: AuditDetail = { attemptId, attemptEmitted: false, terminalEmitted: false };

	const attemptAt = new Date().toISOString();
	audit.attemptEmitted = emitRuntimeEventOnce(
		lifecycleEvent(
			"agent.session.attaching",
			{ agentAddress: agent, sessionId: input.sessionId, attemptId, ok: true } satisfies SessionLifecyclePayload,
			attemptAt,
		),
		opts.journalPath,
	);

	const result = attachMaster(input);

	const terminalAt = new Date().toISOString();
	if (result.ok) {
		audit.terminalEmitted = emitRuntimeEventOnce(
			lifecycleEvent(
				"agent.session.attached",
				{ agentAddress: agent, sessionId: input.sessionId, generation: result.attachment.generation, attemptId, ok: true } satisfies SessionLifecyclePayload,
				terminalAt,
			),
			opts.journalPath,
		);
	} else {
		audit.terminalEmitted = emitRuntimeEventOnce(
			lifecycleEvent(
				"agent.session.attaching_failed",
				{ agentAddress: agent, sessionId: input.sessionId, attemptId, ok: false, reason: result.reason } satisfies SessionLifecyclePayload,
				terminalAt,
			),
			opts.journalPath,
		);
	}
	return { ...result, audit };
}

/**
 * detach + 审计。顺序：detaching（attempt）→ registry.commit → detached / detaching_failed。
 */
export function detachMasterWithAudit(
	input: { sessionId: string; generation: number; agent?: ObjectAddress; reason?: string },
	opts: { journalPath?: string } = {},
): DetachResult & { audit: AuditDetail } {
	const agent = input.agent ?? masterAddress();
	const attemptId = newAttemptId();
	const audit: AuditDetail = { attemptId, attemptEmitted: false, terminalEmitted: false };

	const attemptAt = new Date().toISOString();
	audit.attemptEmitted = emitRuntimeEventOnce(
		lifecycleEvent(
			"agent.session.detaching",
			{ agentAddress: agent, sessionId: input.sessionId, generation: input.generation, attemptId, ok: true } satisfies SessionLifecyclePayload,
			attemptAt,
		),
		opts.journalPath,
	);

	const result = detachMaster(input);

	const terminalAt = new Date().toISOString();
	if (result.ok) {
		audit.terminalEmitted = emitRuntimeEventOnce(
			lifecycleEvent(
				"agent.session.detached",
				{ agentAddress: agent, sessionId: input.sessionId, generation: input.generation, attemptId, ok: true, reason: input.reason } satisfies SessionLifecyclePayload,
				terminalAt,
			),
			opts.journalPath,
		);
	} else {
		audit.terminalEmitted = emitRuntimeEventOnce(
			lifecycleEvent(
				"agent.session.detaching_failed",
				{ agentAddress: agent, sessionId: input.sessionId, generation: input.generation, attemptId, ok: false, reason: result.reason } satisfies SessionLifecyclePayload,
				terminalAt,
			),
			opts.journalPath,
		);
	}
	return { ...result, audit };
}

// ── takeover + 审计（0920 backlog B：scope owner stale 恢复）────────────────

interface TakeoverPayload {
	agentAddress: ObjectAddress;
	sessionId: string;
	generation?: number;
	attemptId: string;
	ok: boolean;
	reason?: string;
	prevSessionId?: string;
	prevGeneration?: number;
	evidence?: Record<string, unknown>;
}

/**
 * takeover + 审计。复用 attachMasterWithAudit 的 attempt/terminal 模式：
 * taking_over（attempt）→ registry.commit → takeover（终态成功，payload 含
 * prevSessionId/prevGeneration/evidence）/ takeover_failed。registry 结果原样返回；
 * journal 写失败绝不影响 registry 结果。事件词表/type/去重走 lifecycleEvent 同一
 * 受检路径（L4 M3：三事件已入 SESSION_LIFECYCLE_TYPES 导出表）。
 */
export function takeoverMasterWithAudit(
	input: TakeoverMasterInput,
	opts: { journalPath?: string } = {},
): TakeoverMasterResult & { audit: AuditDetail } {
	const agent = input.agent ?? masterAddress();
	const attemptId = newAttemptId();
	const audit: AuditDetail = { attemptId, attemptEmitted: false, terminalEmitted: false };

	const attemptAt = new Date().toISOString();
	audit.attemptEmitted = emitRuntimeEventOnce(
		lifecycleEvent(
			"agent.session.taking_over",
			{ agentAddress: agent, sessionId: input.sessionId, attemptId, ok: true } satisfies SessionLifecyclePayload,
			attemptAt,
		),
		opts.journalPath,
	);

	const result = takeoverMaster(input);

	const terminalAt = new Date().toISOString();
	if (result.ok) {
		const payload: TakeoverPayload = {
			agentAddress: agent,
			sessionId: input.sessionId,
			generation: result.attachment.generation,
			attemptId,
			ok: true,
			reason: input.reason,
			prevSessionId: result.prevSessionId,
			prevGeneration: result.prevGeneration,
			...(input.evidence ? { evidence: input.evidence } : {}),
		};
		audit.terminalEmitted = emitRuntimeEventOnce(
			lifecycleEvent("agent.session.takeover", payload, terminalAt),
			opts.journalPath,
		);
	} else {
		audit.terminalEmitted = emitRuntimeEventOnce(
			lifecycleEvent(
				"agent.session.takeover_failed",
				{ agentAddress: agent, sessionId: input.sessionId, attemptId, ok: false, reason: result.reason } satisfies SessionLifecyclePayload,
				terminalAt,
			),
			opts.journalPath,
		);
	}
	return { ...result, audit };
}
