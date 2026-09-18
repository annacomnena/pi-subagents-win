/**
 * master-control.ts — Master Control Service（Phase 5.5 M1）。
 *
 * slash 命令 / agent tool /（未来）Runtime Host 与 GUI 的共用纯控制层。
 * 本层禁止触碰 pi ctx：sessionId 等一律由调用方显式传入（F9 同源）。
 * 只做控制组装，不改 registry / lifecycle / hydrate 的任何语义（terra F1-F24 有效）。
 */
import { masterAddress } from "./address.ts";
import {
	readAttachment,
	readCutover,
	setCutover,
	type CutoverState,
	type MasterAttachment,
} from "./registry.ts";
import {
	attachMasterWithAudit,
	detachMasterWithAudit,
} from "./adapters/session-lifecycle.ts";
import { buildHandoff, type HandoffDocument } from "./hydrate.ts";
import { mailboxBacklog } from "./mailbox.ts";
import { resolveRecipient, type RecipientSnapshot } from "./resolver.ts";

export interface MasterStatusView {
	attachment: MasterAttachment | null;
	cutover: CutoverState | null;
	snapshot: RecipientSnapshot | null;
	backlog: { recipient: string; pending: number; claimed: number }[];
}

/** 只读装配：attachment / cutover / resolver 快照 / mailbox 积压。 */
export function getMasterStatus(): MasterStatusView {
	const master = masterAddress();
	return {
		attachment: readAttachment(master),
		cutover: readCutover(),
		snapshot: resolveRecipient(master),
		backlog: mailboxBacklog(),
	};
}

/** 显式接管：genesis / token 交接 / forceStale，语义 == attachMasterWithAudit。 */
export function attachCurrentSession(input: {
	sessionId: string;
	token?: string;
	forceStale?: boolean;
}): ReturnType<typeof attachMasterWithAudit> {
	return attachMasterWithAudit({
		sessionId: input.sessionId,
		token: input.token,
		forceStale: input.forceStale || undefined,
	});
}

export type CutoverChange =
	| { ok: true; enabled: boolean }
	| { ok: false; reason: "not-attached" };

/** 开启需已 attach（与旧 handler 同 guard）；关闭恒允许。 */
export function setMasterCutover(input: {
	enabled: boolean;
	by: string;
}): CutoverChange {
	if (input.enabled && !readAttachment(masterAddress())) {
		return { ok: false, reason: "not-attached" };
	}
	const st = setCutover(input.enabled, input.by);
	return { ok: true, enabled: st.enabled };
}

export type HandoffTokenIssue =
	| ReturnType<typeof detachMasterWithAudit>
	| { ok: false; reason: "not-owner"; precheck: true };

/** 颁发 handoff token：非 owner 拒绝；旧 attachment 保留（无空窗，§6）。 */
export function issueMasterHandoffToken(input: {
	sessionId: string;
	reason?: string;
}): HandoffTokenIssue {
	const att = readAttachment(masterAddress());
	if (!att || att.sessionId !== input.sessionId) {
		return { ok: false, reason: "not-owner", precheck: true };
	}
	return detachMasterWithAudit({
		sessionId: input.sessionId,
		generation: att.generation,
		reason: input.reason,
	});
}

/** 只读装配交接包（落盘由 hydrate 负责，不注入）。 */
export function prepareMasterHandoff(input: { repoRoot?: string } = {}): HandoffDocument {
	return buildHandoff({ repoRoot: input.repoRoot });
}
