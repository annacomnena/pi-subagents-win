/**
 * master-control.ts — Master Control Service（Phase 5.5 M1）。
 *
 * slash 命令 / agent tool /（未来）Runtime Host 与 GUI 的共用纯控制层。
 * 本层禁止触碰 pi ctx：sessionId 等一律由调用方显式传入（F9 同源）。
 * 只做控制组装，不改 registry / lifecycle / hydrate 的任何语义（terra F1-F24 有效）。
 */
import { homedir } from "node:os";
import { masterAddress, type ObjectAddress } from "./address.ts";
import { checkMasterHomeAttach } from "./master-home-guard.ts";
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

/**
 * 显式接管：genesis / token 交接 / forceStale，语义 == attachMasterWithAudit，
 * 但 global（agent://master_default，缺省即 global）先过 home 守卫。
 *
 * cwd + initialCwd 必填（null = 无启动证明，必须拒绝；不带默认，不从
 * 进程 cwd 猜测）：两者都必须是 home 根目录才调用 lifecycle。home 拒绝
 * 早于 audit/genesis/lease/token/forceStale/watcher——零写（不读不写交接
 * token、不生成 attach 审计）。token / forceStale / genesis / 同会话刷新
 * 一律不放行；local 地址不受 home 限制。env 仅测试注入，生产默认
 * os.homedir() 与 process.platform。
 *
 * 身份 unknown 优先走原 bad-session 路径（委托 lifecycle，保持审计语义）。
 */
export function attachCurrentSession(input: {
	sessionId: string;
	/** 本次会话实际 cwd（调用方从可信 Pi ctx 传入，不得取 tool 参数/handoff/旧 attachment）。 */
	cwd: string;
	/** 同 UUID 的 session_start 启动快照（null = 缺证据，拒绝）。 */
	initialCwd: string | null;
	agent?: ObjectAddress;
	token?: string;
	forceStale?: boolean;
	env?: { home: string; platform: NodeJS.Platform };
}): ReturnType<typeof attachMasterWithAudit> | { ok: false; reason: "not-home-dir" } {
	if (input.sessionId && input.sessionId !== "unknown") {
		const home = input.env?.home ?? homedir();
		const platform = input.env?.platform ?? process.platform;
		if (!checkMasterHomeAttach(input.agent, input.cwd, home, platform).ok) {
			return { ok: false, reason: "not-home-dir" };
		}
		if (!checkMasterHomeAttach(input.agent, input.initialCwd, home, platform).ok) {
			return { ok: false, reason: "not-home-dir" };
		}
	}
	return attachMasterWithAudit({
		sessionId: input.sessionId,
		...(input.agent ? { agent: input.agent } : {}),
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
