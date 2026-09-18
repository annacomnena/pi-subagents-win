/**
 * master-tools.ts — Agent-callable Master Tools（Phase 5.5 M2）。
 *
 * 与 /master-* 命令共用 runtime/master-control.ts（M1），零逻辑复制。
 * 纯逻辑函数（显式 sessionId，可单测）+ registerMasterTools(pi) 薄注册层。
 *
 * 调用纪律（见各 tool description）：仅在用户明确要求时调用；
 * 不要手工组合 attach/detach/cutover 做交接——succession 走 master-transfer（M3）。
 * F9：sessionId 取自 tool ctx，禁参数传入；"unknown" 身份拒绝（比命令层更严，
 * 命令层的 !sid guard 历史上不可达，冻结不动）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { sessionIdentity } from "./links.ts";
import { isSubagent } from "./identity.ts";
import {
	attachCurrentSession,
	getMasterStatus,
	issueMasterHandoffToken,
	prepareMasterHandoff,
	setMasterCutover,
} from "./runtime/master-control.ts";
import {
	confirmTransferAttach,
	transferMaster,
	type SpawnSuccessor,
} from "./runtime/master-transfer.ts";
import {
	DEFAULT_PROPOSAL_PERCENT,
	formatPressure,
	meetsProposalThreshold,
	readPressure,
} from "./runtime/master-pressure.ts";
import type { MasterSuccessionConfig } from "./runtime/master-auto.ts";

export interface ToolOutcome {
	text: string;
	isError?: boolean;
	details?: Record<string, unknown>;
}

/** 与 /master-status 同文案；带 cfg 时多一行 auto-handoff 观测（S3，缺省不显示）。 */
export function masterStatusLogic(cfg?: MasterSuccessionConfig): ToolOutcome {
	const { attachment: att, cutover: cut, snapshot: snap, backlog } = getMasterStatus();
	const lines = [
		`attachment: ${att ? `${att.sessionId.slice(0, 12)} gen=${att.generation} heartbeat=${att.lastHeartbeatAt.slice(11, 19)}` : "(none)"}`,
		`cutover: ${cut ? (cut.enabled ? `ON by=${cut.enabledBy.slice(0, 12)} at=${cut.enabledAt.slice(0, 19)}` : "OFF") : "(never set)"}`,
		`resolver: ${snap ? `${snap.sessionId.slice(0, 12)} gen=${snap.generation}` : "(null)"}`,
		`mailbox: ${backlog.map((b) => `${b.recipient}=p${b.pending}/c${b.claimed}`).join(" ") || "(empty)"}`,
		...(cfg ? [autoHandoffLine(cfg)] : []),
	];
	return { text: `Master status:\n${lines.join("\n")}` };
}

function autoHandoffLine(cfg: MasterSuccessionConfig): string {
	return `auto-handoff: ${cfg.auto ? "ON" : "OFF"} (autoPercent=${cfg.autoPercent})`;
}

export function masterAttachLogic(
	sessionId: string,
	input: { token?: string; forceStale?: boolean; confirm?: boolean } = {},
): ToolOutcome {
	if (input.forceStale && !input.confirm) {
		return { text: "master-attach: --force-stale 须与 confirm 同用（二次人工确认），拒绝", isError: true };
	}
	const r = attachCurrentSession({ sessionId, token: input.token, forceStale: input.forceStale || undefined });
	if (!r.ok) return { text: `master-attach 失败：${r.reason}`, isError: true };
	return {
		text: `master-attach 成功：gen=${r.attachment.generation}${r.genesis ? "（genesis）" : ""} session=${sessionId.slice(0, 12)}`,
		details: { generation: r.attachment.generation, genesis: r.genesis },
	};
}

export function masterCutoverLogic(
	sessionId: string,
	input: { enabled: boolean },
): ToolOutcome {
	const st = setMasterCutover({ enabled: input.enabled, by: sessionId });
	if (!st.ok) {
		return { text: "master-cutover: 尚未 attach（先 /master-attach），拒绝开启", isError: true };
	}
	return {
		text: `master-cutover 已${st.enabled ? "开启" : "关闭"}（by=${sessionId.slice(0, 12)}）`,
		details: { enabled: st.enabled },
	};
}

export function masterDetachLogic(
	sessionId: string,
	input: { reason?: string } = {},
): ToolOutcome {
	const d = issueMasterHandoffToken({ sessionId, reason: input.reason });
	if (!d.ok) {
		return {
			text: "precheck" in d ? "master-detach: 你不是当前 owner，拒绝" : "master-detach 失败：not-owner",
			isError: true,
		};
	}
	return {
		text: `master-detach 成功：handoff token=${d.token}（接班者在新会话执行 /master-attach ${d.token}）`,
		details: { token: d.token },
	};
}

export function masterHandoffLogic(input: { repoRoot?: string } = {}): ToolOutcome {
	try {
		const doc = prepareMasterHandoff({ repoRoot: input.repoRoot });
		const present = doc.manifest.filter((m) => m.present).length;
		return {
			text: `handoff 已生成：${doc.path}\nmanifest ${present}/${doc.manifest.length} 项 present`,
			details: { path: doc.path, present, total: doc.manifest.length },
		};
	} catch (e) {
		return { text: `master-handoff 失败：${e instanceof Error ? e.message : String(e)}`, isError: true };
	}
}

const USER_DIRECTIVE = "仅在用户明确要求时调用；禁止自行决定接管/交接/切换。";
const NO_COMPOSE = "不要手工组合 attach/detach/cutover 执行 succession；交接走 master-transfer（未发布前走 /master-detach 发 token + 新会话 attach 流程）。";

function toolSession(ctx: unknown): string {
	return sessionIdentity(ctx as never);
}

function textResult(outcome: ToolOutcome): { content: { type: string; text: string }[]; details?: Record<string, unknown>; isError?: boolean } {
	return {
		content: [{ type: "text", text: outcome.text }],
		...(outcome.details ? { details: outcome.details } : {}),
		...(outcome.isError ? { isError: true } : {}),
	};
}

export function masterTransferLogic(
	sessionId: string,
	input: { reason?: string; spawn: SpawnSuccessor },
): ToolOutcome {
	const r = transferMaster({ sessionId, reason: input.reason, spawn: input.spawn });
	if (!r.ok) {
		return {
			text: r.reason === "not-owner"
				? "master-transfer: 你不是当前 owner，拒绝"
				: `master-transfer 失败：spawn 未能启动（${r.error ?? "unknown"}），你仍是 owner（transfer=${r.transferId}）`,
			isError: true,
		};
	}
	return {
		text: `master-transfer 已发起：transfer=${r.transferId} 后继=${r.successorRunId}（gen ${r.generation}→${r.generation + 1}，交接包=${r.handoffPath}）`,
		details: { transferId: r.transferId, successorRunId: r.successorRunId, token: r.token, handoffPath: r.handoffPath },
	};
}

export function masterTransferConfirmLogic(
	sessionId: string,
	input: { transferId: string },
): ToolOutcome {
	const r = confirmTransferAttach({ transferId: input.transferId, sessionId });
	if (!r.ok) return { text: `master-transfer-confirm 失败：${r.reason}`, isError: true };
	return { text: `master-transfer 完成：transfer=${r.transferId} gen=${r.generation}`, details: { transferId: r.transferId, generation: r.generation } };
}

export function masterPressureLogic(usage: unknown): ToolOutcome {
	const reading = readPressure(usage as { tokens?: number | null; contextWindow?: number | null; percent?: number | null } | null | undefined);
	const text = formatPressure(reading);
	const over = meetsProposalThreshold(reading);
	return {
		text: over ? `${text}\n已达提议线 ${DEFAULT_PROPOSAL_PERCENT * 100}%（是否交接由 proposal 流程决定，见 master-transfer）` : text,
		details: { tokens: reading.tokens, contextWindow: reading.contextWindow, percent: reading.percent, overThreshold: over },
	};
}

export function registerMasterTools(
	pi: ExtensionAPI,
	opts: { spawnSuccessor?: SpawnSuccessor; masterSuccession?: () => MasterSuccessionConfig } = {},
): void {
	const subBlocked = () => isSubagent();

	pi.registerTool({
		name: "master-status",
		label: "Master Status",
		description: `查看逻辑 Master 归属：attachment / resolver / cutover / mailbox 积压。只读，随时可调。${USER_DIRECTIVE}`,
		parameters: Type.Object({}),
		renderCall(_args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("master-status"))}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			const text = (result.details as { text?: string } | undefined)?.text ?? "";
			return new Text(theme.fg("dim", text.slice(0, 200)), 0, 0);
		},
		async execute(_toolCallId, _rawParams) {
			const outcome = masterStatusLogic(opts.masterSuccession?.());
			return textResult({ ...outcome, details: { text: outcome.text } });
		},
	});

	pi.registerTool({
		name: "master-handoff",
		label: "Master Handoff",
		description: `生成交接包 markdown（只读装配，只落盘不注入）。${USER_DIRECTIVE}`,
		parameters: Type.Object({
			repoRoot: Type.Optional(Type.String({ description: "仓库根目录（缺省当前目录）" })),
		}),
		renderCall(_args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("master-handoff"))}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			const text = (result.details as { text?: string } | undefined)?.text ?? "";
			return new Text(theme.fg("dim", text.slice(0, 200)), 0, 0);
		},
		async execute(_toolCallId, rawParams) {
			const params = rawParams as { repoRoot?: string };
			const outcome = masterHandoffLogic({ repoRoot: params.repoRoot });
			return textResult({ ...outcome, details: { ...(outcome.details ?? {}), text: outcome.text } });
		},
	});

	pi.registerTool({
		name: "master-attach",
		label: "Master Attach",
		description: `显式接管逻辑 Master（genesis / token 交接 / forceStale 强接需 confirm 双确认）。子 agent 不可调。${USER_DIRECTIVE} ${NO_COMPOSE}`,
		parameters: Type.Object({
			token: Type.Optional(Type.String({ description: "handoff token（接班时用）" })),
			forceStale: Type.Optional(Type.Boolean({ description: "owner 失联时强接（必须与 confirm 同用）" })),
			confirm: Type.Optional(Type.Boolean({ description: "与 forceStale 同用的二次确认" })),
		}),
		renderCall(_args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("master-attach"))}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			const text = (result.details as { text?: string } | undefined)?.text ?? "";
			return new Text(theme.fg("dim", text.slice(0, 200)), 0, 0);
		},
		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			if (subBlocked()) return textResult({ text: "子 agent 不可接管 Master", isError: true });
			const sid = toolSession(ctx);
			if (!sid || sid === "unknown") return textResult({ text: "master-attach: 无法确定当前会话身份，拒绝", isError: true });
			const params = rawParams as { token?: string; forceStale?: boolean; confirm?: boolean };
			const outcome = masterAttachLogic(sid, params);
			return textResult({ ...outcome, details: { ...(outcome.details ?? {}), text: outcome.text } });
		},
	});

	pi.registerTool({
		name: "master-detach",
		label: "Master Detach",
		description: `交出逻辑 Master 并颁发 handoff token（仅 owner 可调）。子 agent 不可调。${USER_DIRECTIVE} ${NO_COMPOSE}`,
		parameters: Type.Object({
			reason: Type.Optional(Type.String({ description: "交接原因" })),
		}),
		renderCall(_args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("master-detach"))}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			const text = (result.details as { text?: string } | undefined)?.text ?? "";
			return new Text(theme.fg("dim", text.slice(0, 200)), 0, 0);
		},
		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			if (subBlocked()) return textResult({ text: "子 agent 不可交出 Master", isError: true });
			const sid = toolSession(ctx);
			if (!sid || sid === "unknown") return textResult({ text: "master-detach: 无法确定当前会话身份，拒绝", isError: true });
			const params = rawParams as { reason?: string };
			const outcome = masterDetachLogic(sid, params);
			return textResult({ ...outcome, details: { ...(outcome.details ?? {}), text: outcome.text } });
		},
	});

	pi.registerTool({
		name: "master-cutover",
		label: "Master Cutover",
		description: `切换消费端接管总开关（开启需已 attach）。子 agent 不可调。${USER_DIRECTIVE} ${NO_COMPOSE}`,
		parameters: Type.Object({
			enabled: Type.Boolean({ description: "true 开启 / false 关闭" }),
		}),
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("master-cutover"))} ${theme.fg("accent", String((args as { enabled?: boolean }).enabled ?? "?"))}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			const text = (result.details as { text?: string } | undefined)?.text ?? "";
			return new Text(theme.fg("dim", text.slice(0, 200)), 0, 0);
		},
		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			if (subBlocked()) return textResult({ text: "子 agent 不可切换 cutover", isError: true });
			const sid = toolSession(ctx);
			if (!sid || sid === "unknown") return textResult({ text: "master-cutover: 无法确定当前会话身份，拒绝", isError: true });
			const params = rawParams as { enabled?: boolean };
			if (typeof params.enabled !== "boolean") return textResult({ text: "用法：master-cutover {enabled: true|false}", isError: true });
			const outcome = masterCutoverLogic(sid, { enabled: params.enabled });
			return textResult({ ...outcome, details: { ...(outcome.details ?? {}), text: outcome.text } });
		},
	});

	pi.registerTool({
		name: "master-transfer",
		label: "Master Transfer",
		description: `一键交接事务：备 fresh 交接包→发 token→spawn 后继→后继凭 token 接管（gen+1）。仅 owner 可调；子 agent 不可调。仅在用户明确要求时调用；spawn 失败旧主仍是 owner，不重试。`,
		parameters: Type.Object({
			reason: Type.Optional(Type.String({ description: "交接原因" })),
		}),
		renderCall(_args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("master-transfer"))}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			const text = (result.details as { text?: string } | undefined)?.text ?? "";
			return new Text(theme.fg("dim", text.slice(0, 200)), 0, 0);
		},
		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			if (subBlocked()) return textResult({ text: "子 agent 不可发起交接", isError: true });
			const sid = toolSession(ctx);
			if (!sid || sid === "unknown") return textResult({ text: "master-transfer: 无法确定当前会话身份，拒绝", isError: true });
			if (!opts.spawnSuccessor) return textResult({ text: "master-transfer: spawn 通道不可用，拒绝", isError: true });
			const params = rawParams as { reason?: string };
			const outcome = masterTransferLogic(sid, { reason: params.reason, spawn: opts.spawnSuccessor });
			return textResult({ ...outcome, details: { ...(outcome.details ?? {}), text: outcome.text } });
		},
	});

	pi.registerTool({
		name: "master-transfer-confirm",
		label: "Master Transfer Confirm",
		description: `后继凭 token 接管成功后调用：校验 gen+1 与 owner，落 attached→completed。由后继会话在首轮调用；子 agent 不可调。`,
		parameters: Type.Object({
			transferId: Type.String({ description: "交接事务 id（后继 prompt 内给出）" }),
		}),
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("master-transfer-confirm"))} ${theme.fg("accent", String((args as { transferId?: string }).transferId ?? "?"))}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			const text = (result.details as { text?: string } | undefined)?.text ?? "";
			return new Text(theme.fg("dim", text.slice(0, 200)), 0, 0);
		},
		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			if (subBlocked()) return textResult({ text: "子 agent 不可确认交接", isError: true });
			const sid = toolSession(ctx);
			if (!sid || sid === "unknown") return textResult({ text: "master-transfer-confirm: 无法确定当前会话身份，拒绝", isError: true });
			const params = rawParams as { transferId?: string };
			if (!params.transferId) return textResult({ text: "用法：master-transfer-confirm {transferId}", isError: true });
			const outcome = masterTransferConfirmLogic(sid, { transferId: params.transferId });
			return textResult({ ...outcome, details: { ...(outcome.details ?? {}), text: outcome.text } });
		},
	});

	pi.registerTool({
		name: "master-pressure",
		label: "Master Pressure",
		description: `读取当前 Master 会话的上下文窗口压力（只读）。${USER_DIRECTIVE}`,
		parameters: Type.Object({}),
		renderCall(_args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("master-pressure"))}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			const text = (result.details as { text?: string } | undefined)?.text ?? "";
			return new Text(theme.fg("dim", text.slice(0, 200)), 0, 0);
		},
		async execute(_toolCallId, _rawParams, _signal, _onUpdate, ctx) {
			const getUsage = (ctx as unknown as { getContextUsage?: () => unknown }).getContextUsage;
			const outcome = masterPressureLogic(typeof getUsage === "function" ? getUsage.call(ctx) : null);
			return textResult({ ...outcome, details: { ...(outcome.details ?? {}), text: outcome.text } });
		},
	});
}
