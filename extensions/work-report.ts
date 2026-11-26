/**
 * work-report — 在**会话进程内**发一份主动回报（Item 66 / S1 的最小工具入口）
 *
 * 为什么脚本入口不够（2026-11-26 实测）：
 *   `scripts/report_to_master.mjs` 是**子进程**，`process.pid` 永远不等于会话 pid，且跑完即退。
 *   实测：GreenCAD 自己发的那份报 `pid=31244`，而 GreenCAD 会话是 `30212`；查的时候 31244
 *   已 `NOT RUNNING` ⇒ 收方**无法**用「pid 是不是那个会话」来核身份。
 *   而 global master 的判据正是这一条。⇒ 只有**在会话进程内执行**的入口能满足它。
 *
 * 与相邻通道的分工（不要混淆）：
 *   - `tab-report`：tab → 派发方。硬要求 `PI_TAB_RUN_ID`（防伪造，**不放宽**）。
 *   - `work-report`（本工具）：**任何持 master attachment 的会话**（主会话 / local master /
 *     global master）→ 显式收件地址。`from` **不可传参**，由当前会话反查自己的地址。
 *   - `scripts/report_to_master.mjs`：非 pi 进程 / 应急用；身份弱（见上），仅作旁路。
 *
 * 身份强度（不得超额声称 —— 2026-11-26 由独立 L4 P1-1 纠正过一次）：
 *
 *   ① `pid` = **本进程（= 会话进程）** —— 这是本工具**唯一真正强**的证据，
 *      ！注意它不是永远可核：进程退出后就查不到了；但会话进程**长期存活**，所以可事后核。
 *   ② `cwd` = 本进程工作目录（需主动 `chdir` 才能伪，弱）。
 *   ③ `envSessionId` = 由 `getCurrentSessionId()` **显式传参**写入 ——
 *      **它与 `from` 同源，因此不增加任何信息**（两者构造上必然一致）。
 *
 *   ⚠ 为什么 ③ 仍是 tautology（实测依据，勿再当成“三项一致”吹）：
 *   pi **不会**给会话进程本身设 `PI_SESSION_ID` ——
 *   `dist/core/tools/bash.js:159-168` 先 `delete env.PI_SESSION_ID`，
 *   只在 spawn **shell 子进程**时才注入。
 *   ⇒ 会话进程内只能拿 `getCurrentSessionId()`（pi 上下文）。
 *   ⇒ 而 `from` 也是用同一个 sessionId 反查的 ⇒ 两者必然一致。
 *
 *   ⇒ 因此：**本工具做的是“内容相关性核验 + pid 可事后核”，不是身份认证。**
 *     要真正把“谁发的”做成可验，需要 `attachment` 里带 `pid` + `attachedAt`
 *     并与进程启动时间对账（已登记为后续，本轮未做）。
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { getCurrentSessionId } from "./identity.ts";
import { recipientSessionIdFor, sendReportToMain } from "./report.ts";
import { findAttachmentBySession } from "./runtime/registry.ts";

export interface WorkReportInput {
	to?: string;
	message: string;
	summary?: string;
	taskId?: string;
	/** 注入点：测试可覆盖；生产取 `getCurrentSessionId()`。 */
	sessionId?: string;
	/** 注入点：测试可覆盖；生产取 `process.cwd()`。 */
	cwd?: string;
	reportsDir?: string;
}

export interface WorkReportOutcome {
	ok: boolean;
	text: string;
	details: Record<string, unknown>;
}

/**
 * 纯逻辑（可测）。`from` 绝不接受外部传入 —— 这是本工具存在的理由。
 */
export function workReportLogic(input: WorkReportInput): WorkReportOutcome {
	const sid = input.sessionId ?? getCurrentSessionId();
	if (!sid) {
		return {
			ok: false,
			text: "work-report: 拿不到当前会话 id（不在 pi 会话进程内）⇒ 无法确定发送者身份，拒绝发送。",
			details: { ok: false, reason: "no-session-id" },
		};
	}
	const own = findAttachmentBySession(sid);
	if (!own) {
		return {
			ok: false,
			text:
				`work-report: 当前会话 ${sid.slice(0, 8)}… 没有 master attachment ⇒ 无法确定「我是谁」，拒绝发送。\n` +
				"如果你是本仓的 local master，先 attach（/master-attach --local）；\n" +
				"如果你在 tab 里，用 tab-report（它按 tab 身份发送）。",
			details: { ok: false, reason: "no-attachment", sessionId: sid },
		};
	}
	if (!input.message || !input.message.trim()) {
		return {
			ok: false,
			text: "work-report: message 为空。",
			details: { ok: false, reason: "empty-message" },
		};
	}

	const from = own.agentAddress;
	const recipient = recipientSessionIdFor({ from, to: input.to });
	const reportId = sendReportToMain(
		{
			from,
			...(input.to ? { to: input.to } : {}),
			message: input.message,
			...(input.summary ? { summary: input.summary } : {}),
			...(input.taskId ? { taskId: input.taskId } : {}),
			// **显式传会话 id**（L4 §5.2）：宿主进程可能没有 `PI_SESSION_ID`
			//（`scripts/boot-resume-master.ps1:93` 启动 master 时会主动清掉它），
			// 而 `getCurrentSessionId()` 是 pi 上下文注入的，在进程内一定可用。
			sessionId: sid,
		},
		input.reportsDir,
	);

	const lines = [
		`work-report 已写盘：${reportId}`,
		`from = ${from}（本会话自己的地址，不可自填）`,
		`to = ${input.to ?? "（未指定 ⇒ 旧语义：按 from 推导）"}`,
		`pid = ${process.pid}（**本进程 = 会话进程**，收方可在存活时用 OS 核对）`,
		`cwd = ${input.cwd ?? process.cwd()}`,
		`接收方解析 = ${recipient ?? "❌ undefined（会落 .unroutable 并可重试）"}`,
		"",
		"注意（R-25）：写盘成功 ≠ 送达。要看接收侧证据（reports/<id>.notified 或对方会话正文）。",
	];
	return {
		ok: Boolean(recipient),
		text: lines.join("\n"),
		details: {
			ok: Boolean(recipient),
			reportId,
			from,
			to: input.to ?? null,
			recipient: recipient ?? null,
			willRoute: Boolean(recipient),
			pid: process.pid,
			cwd: input.cwd ?? process.cwd(),
			sessionId: sid,
		},
	};
}

/**
 * 注册 work-report 工具。
 *
 * `opts.reportsDir` 仅用于**测试注入**（生产不传 ⇒ 用 `defaultReportsDir()`）。
 * 为什么要开这个口子：`execute` 里写盘，若不能重定向，任何“调 execute”的测试都会
 * 真的往 `~/.pi/agent/reports` 写一份报 —— 而那正是我 2026-11-26 因为“测试产物被投递后删”吃过教训的地方。
 */
export function registerWorkReportTool(pi: ExtensionAPI, opts: { reportsDir?: string } = {}): void {
	pi.registerTool({
		name: "work-report",
		label: "Work Report",
		description: [
			"在**本会话进程内**发一份主动回报（可显式指定接收方，支持横向汇报 master → master）。",
			"`from` 不可传参：由当前会话的 master attachment 反查，因此收方可以核「这条确实是这个会话发的」",
			"（pid = 会话进程 + cwd + envSessionId 三者一致）。",
			"用途：local master 向 global master 汇报；主会话之间的横向通知。",
			"tab 内请用 tab-report（按 tab 身份）；非 pi 进程请用 scripts/report_to_master.mjs（身份弱）。",
		].join(" "),
		parameters: Type.Object({
			message: Type.String({ description: "回报正文" }),
			to: Type.Optional(
				Type.String({ description: "显式接收方：agent://master_* / 会话 UUID / tab_*；缺省=按 from 推导（旧语义）" }),
			),
			summary: Type.Optional(Type.String({ description: "简短摘要" })),
			taskId: Type.Optional(Type.String({ description: "关联任务号" })),
		}),
		renderCall(_args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("work-report"))}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			const text = (result.details as { text?: string } | undefined)?.text ?? "";
			return new Text(theme.fg("dim", text.slice(0, 300)), 0, 0);
		},
		async execute(_toolCallId, rawParams) {
			const p = rawParams as { message?: string; to?: string; summary?: string; taskId?: string };
			const outcome = workReportLogic({
				message: String(p.message ?? ""),
				...(p.to ? { to: p.to } : {}),
				...(p.summary ? { summary: p.summary } : {}),
				...(p.taskId ? { taskId: p.taskId } : {}),
				...(opts.reportsDir ? { reportsDir: opts.reportsDir } : {}),
			});
			// ⚠ 必须返回 `content`（L4 P0-2，2026-11-26）：pi 的工具协议靠 `content` 把结果交给模型，
			// `details` 只给渲染层（`renderResult`）看。只返回 `details` ⇒ **工具能跑、有 ok，
			// 但模型看不到任何返回** ⇒ 新功能对模型静默失效。
			// 这是“实现了但没接线”的典型形态 —— 比“没实现”更难发现，因为测试可以直接调函数而绕过协议。
			return {
				content: [{ type: "text", text: outcome.text }],
				details: { ...outcome.details, text: outcome.text },
				...(outcome.ok ? {} : { isError: true }),
			};
		},
	});
}
