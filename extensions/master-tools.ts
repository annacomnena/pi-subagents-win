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
import { isMainSession, isSubagent, isTabSession } from "./identity.ts";
import {
	attachCurrentSession,
	getMasterStatus,
	issueMasterHandoffToken,
	prepareMasterHandoff,
	setMasterCutover,
} from "./runtime/master-control.ts";
import { readAttachment, type MasterAttachment } from "./runtime/registry.ts";
import { masterAddress } from "./runtime/address.ts";
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

// ── master-dispatch：ownership 门控 + 派发（0918 计划 §3）──────────
//
// 派单资格看 ownership，不看 provenance（计划 §0，不复议）：
//   ① isSubagent 硬挡 → ② 身份（unknown 拒绝）→ ③ ownership 比对（owner 放行——
//   无论是否 tab；被上代 transfer 派生的 Master 其 attachment.sessionId 即自身，
//   天然过比对，dogfood 修复 0918：原「任务 tab 永不是 owner」静态断言与此矛盾，
//   曾把 tab 形态的 owner 误挡）→ ④ 主会话恒可派（编排者）→ ⑤ 非 owner 的任务
//   tab（tab-session）/其余（not-owner）拒绝 → ⑥ owner 路径 generation fencing（双读）。
// gate 之后 generation 被 bump 才挡——gate 双读 + 派发通道最终 fencing
// （masterDispatchLaunch 在 runId/账本/spawn 前重读比对）把 gate→落账窗口压到最小（0918 审查 §1）。

/** master-dispatch 门控结果。ok 时携带 via（main/owner）与 owner 附件（owner 路径用）。 */
export type MasterDispatchGate =
	| { ok: true; via: "main" | "owner"; attachment: MasterAttachment | null }
	| { ok: false; reason: "subagent" | "unknown-session" | "tab-session" | "not-owner" | "generation-mismatch" };

/**
 * 门控三件套（纯函数，可单测）。readAttachment 注入：gate 读一次判 owner，spawn 前再读一次
 * 比对 {sessionId, generation}——两读之间窗口最小化，与 attachMaster「lease 内重读 CAS」同构。
 */
export function masterDispatchGate(input: {
	sessionId: string;
	isSub: boolean;
	isTab: boolean;
	isMain: boolean;
	readAttachment: () => MasterAttachment | null;
}): MasterDispatchGate {
	if (input.isSub) return { ok: false, reason: "subagent" };                    // ① 身份硬挡（最高优先）
	const sid = input.sessionId;
	if (!sid || sid === "unknown") return { ok: false, reason: "unknown-session" };  // ② 身份不可定
	const att = input.readAttachment();
	if (att && att.sessionId === sid) {                                              // ③ ownership 优先（tab 形态的 owner 也放行）
		const fresh = input.readAttachment();                                         //    generation fencing（双读）
		if (fresh === null || fresh.sessionId !== sid || fresh.generation !== att.generation) {
			return { ok: false, reason: "generation-mismatch" };
		}
		return { ok: true, via: "owner", attachment: fresh };
	}
	if (input.isMain) return { ok: true, via: "main", attachment: null };             // ④ 主会话恒可派
	if (input.isTab) return { ok: false, reason: "tab-session" };                    // ⑤ 非 owner 的任务 tab
	return { ok: false, reason: "not-owner" };                                      // ⑥ 其余（not-owner）
}

/** 拒绝文案（isError:true）。not-owner 需 owner 附件以渲染「owner=…/无 owner」。 */
export function masterDispatchRejectText(
	gate: Extract<MasterDispatchGate, { ok: false }>,
	att: MasterAttachment | null,
): string {
	switch (gate.reason) {
		case "subagent": return "master-dispatch: 子 agent 不可派发任务 tab";
		case "unknown-session": return "master-dispatch: 无法确定当前会话身份，拒绝";
		case "tab-session": return "master-dispatch: 任务 tab 不是 owner，不可派发；用 tab-finish 回报主会话由主会话编排";
		case "not-owner": return `master-dispatch: 你不是当前 Master owner 也不是主会话，拒绝（owner=${att ? att.sessionId.slice(0, 12) : "无 owner"}）`;
		case "generation-mismatch": return "master-dispatch: Master 归属已变化（stale generation），拒绝；请重新确认 owner";
	}
}

/** 派发入参（dispatchTab 闭包契约；index.ts 提供实现：wt 前置检查 + launchWorkflowTab 账本/spawn）。 */
export interface MasterDispatchTabArgs {
	taskId: string;
	title?: string;
	cwd?: string;
	mode: "workflow" | "research" | "execute" | "adaptive";
	prompt: string;
	model?: string;
	timers?: Array<{ delayMs?: number; message?: string; label?: string; repeatMs?: number }>;
	sessionId: string;
	/** gate 第二读的 owner 快照（owner 路径）；main 路径 null（派发通道最终 fencing 用，不依赖 attachment）。 */
	owner: MasterAttachment | null;
}

/** 派发通道（注入式）：wt 缺席在生成 runId 之前返回 error，不写任何账本；stale=true 表示
 *  最终 fencing 失败（gate 后 attachment 已变），同样零账本零 spawn。 */
export type DispatchTab = (args: MasterDispatchTabArgs) => { runId?: string; title: string; error?: string; stale?: true };

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
	opts: { spawnSuccessor?: SpawnSuccessor; masterSuccession?: () => MasterSuccessionConfig; dispatchTab?: DispatchTab } = {},
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

	// master-dispatch：Master owner（含主会话）派一个可见任务 tab。账本/回收链与 launch-tabs
	// 同构（共享 index.ts 的 launchWorkflowTab），journal source 记 agent://master_default。
	// 门控内聚在本工具 execute（与 master-attach/detach/transfer 同款写法），与 capability 矩阵正交。
	pi.registerTool({
		name: "master-dispatch",
		label: "Master Dispatch",
		description: [
			"Master 派单工具：仅主会话或 Master owner（agent://master_default 当前 attachment 的会话）可调用。",
			"派一个可见 pi 任务 tab，账本与回收链（tab-status / reclaim-tabs / tab-finish）与 launch-tabs 完全同构；journal source 记为 agent://master_default。",
			"任务 tab 与 subagent 永不可调（门控硬挡）。不碰 succession（交接走 master-transfer）。",
		].join(" "),
		parameters: Type.Object({
			taskId: Type.String({ description: "任务号（如 S2）" }),
			prompt: Type.String({ description: "首轮 prompt（含交接材料；自动加模式前缀+纪律块）" }),
			title: Type.Optional(Type.String({ description: "标签名（同 launch-tabs 语义，剥 pi-/wlc- 前缀）" })),
			cwd: Type.Optional(Type.String({ description: "工作目录（缺省 process.cwd()）" })),
			mode: Type.Optional(Type.Union([
				Type.Literal("workflow"),
				Type.Literal("research"),
				Type.Literal("execute"),
				Type.Literal("adaptive"),
			], { description: "缺省 workflow" })),
			model: Type.Optional(Type.String({ description: "覆盖模型（provider/id 或短名）" })),
			timers: Type.Optional(Type.Array(Type.Object({
				delayMs: Type.Number({}),
				message: Type.String({}),
				label: Type.Optional(Type.String({}),),
				repeatMs: Type.Optional(Type.Number({}),),
			}))),
		}),
		renderCall(args, theme) {
			const a = args as { taskId?: string; title?: string; mode?: string };
			return new Text(`${theme.fg("toolTitle", theme.bold("master-dispatch"))} ${theme.fg("accent", String(a.taskId ?? "?"))}${a.mode ? ` ${theme.fg("dim", a.mode)}` : ""}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			const text = (result.details as { text?: string } | undefined)?.text ?? "";
			return new Text(theme.fg("dim", text.slice(0, 200)), 0, 0);
		},
		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			if (subBlocked()) return textResult({ text: masterDispatchRejectText({ ok: false, reason: "subagent" }, null), isError: true });
			const sid = toolSession(ctx);
			if (!sid || sid === "unknown") return textResult({ text: masterDispatchRejectText({ ok: false, reason: "unknown-session" }, null), isError: true });
			if (!opts.dispatchTab) return textResult({ text: "master-dispatch: 派发通道不可用，拒绝", isError: true });
			const params = rawParams as {
				taskId?: string; prompt?: string; title?: string; cwd?: string; mode?: string;
				model?: string; timers?: Array<{ delayMs?: number; message?: string; label?: string; repeatMs?: number }>;
			};
			const gate = masterDispatchGate({
				sessionId: sid,
				isSub: isSubagent(),
				isTab: isTabSession(),
				isMain: isMainSession(),
				readAttachment: () => readAttachment(masterAddress()),
			});
			if (!gate.ok) {
				const att = gate.reason === "not-owner" ? readAttachment(masterAddress()) : null;
				const text = masterDispatchRejectText(gate, att);
				return textResult({ text, isError: true, details: { text, reason: gate.reason } });
			}
			const mode: "workflow" | "research" | "execute" | "adaptive" =
				params.mode === "research" ? "research" : params.mode === "execute" ? "execute" : params.mode === "adaptive" ? "adaptive" : "workflow";
			const res = opts.dispatchTab({
				taskId: (params.taskId ?? "").trim(),
				prompt: (params.prompt ?? "").trim(),
				title: params.title,
				cwd: params.cwd,
				mode,
				model: params.model,
				timers: params.timers,
				sessionId: sid,
				owner: gate.attachment,
			});
			if (res.stale) {
				const text = masterDispatchRejectText({ ok: false, reason: "generation-mismatch" }, null);
				return textResult({ text, isError: true, details: { text, reason: "generation-mismatch" } });
			}
			if (res.error) {
				return textResult({ text: `✗ ${res.title}: ${res.error}`, isError: true, details: { text: `✗ ${res.title}: ${res.error}`, runId: res.runId, title: res.title } });
			}
			const text = `master-dispatch 已启动：${res.title} runId=${res.runId}（用 tab-status / reclaim-tabs 回收）`;
			return { content: [{ type: "text", text }], details: { runId: res.runId, title: res.title, taskId: (params.taskId ?? "").trim(), mode, text } };
		},
	});
}
