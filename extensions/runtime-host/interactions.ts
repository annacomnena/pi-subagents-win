/**
 * runtime-host/interactions.ts — G6-P3：待决策交互投影（pendingInteractions 思想落地）
 *
 * plans/0920_g6_webconsole_plan.md §1/§3/§5-P3 + plans/0920_zcode_reference_research.md §4.2：
 * ZCode 把审批单放进 state（pendingInteractions in state patch），断线重连/新客户端加入时
 * **天然可回放**，不靠内存推送。我方 v1 对应物 = 既有 attention 投影（已可回放）之上的
 * 「待决策」视图 + 可选 response 语义；本文件是纯派生，**不新增任何真相**：
 *   - 原料 100% 复用 `buildAttentionItems`（attention.ts 纯函数；journal/状态文件仍是唯一真相）；
 *   - kind 沿用 attention 类型词表（master-handoff/runtime-risk/escalation/question/blocked），
 *     **不做新审批类型**（plan §3 拍板）；
 *   - response 语义（学 ZCode option.response：服务端定义审批语义，UI 只渲染按钮）v1 仅一条：
 *     pending 状态的 master handoff 提案 → `master.handoff.accept`（G4 executor 白名单既有
 *     确定性命令）。§29 红线：本投影只读，决策仍走既有 POST /v1/commands，本层绝不执行命令。
 *
 * 消费面（G6-P3）：
 *   - HTTP `GET /v1/interactions` → `{version:1, count, interactions}`（server.ts 薄绑定）；
 *   - WS topic `"interactions"` → `{type:"event", op:{kind:"state.updated", patch:{interactions}}}`
 *     全量状态帧（ws.ts；每次订阅即全量重放 = 重连天然可回放，无可续传 seq）。
 *
 * 纪律（G3 attention.ts 同款）：全路径注入（stateDir/mailboxDir）可单测；纯读零写盘；
 * 无 Pi API；never-throw（buildInteractions 顶层兜底 → []）。
 */

import { buildAttentionItems, type AttentionItem, type AttentionSeverity } from "./attention.ts";
import type { ImplementedCommandType } from "../runtime/command-executor.ts";

/** 交互 kind = attention 类型词表原样（不新增审批类型，plan §3 拍板）。 */
export type InteractionKind = AttentionItem["type"];

/** 可选 response 语义（ZCode option.response 思想 v1）：仅当既有确定性命令可决时给出。 */
export type InteractionResponse = {
	/** G4 executor 白名单命令（唯一命令入口 POST /v1/commands）。 */
	command: ImplementedCommandType;
	/** 命令 payload（缺省 = 无参；v1 全部无参）。 */
	args?: Record<string, unknown>;
};

/** 待决策交互项 = open attention 条目的直投（id 与 attention 一致，GUI 按 id 关联）。 */
export type InteractionItem = {
	id: string;
	kind: InteractionKind;
	severity: AttentionSeverity;
	createdAt: string;
	title: string;
	summary: string;
	/** 源 payload 原样透传（master-handoff：{proposalId,generation,sessionId,pressure,status,…}）。 */
	payload?: Record<string, unknown>;
	/** 仅 pending handoff 提案携带（{command:"master.handoff.accept"}）；其余待决策 v1 无确定性命令 → 缺省。 */
	response?: InteractionResponse;
};

export interface InteractionsOptions {
	/** 缺省 join(defaultRuntimeDir(), "state")。 */
	stateDir?: string;
	/** 缺省 defaultMailboxDir()。 */
	mailboxDir?: string;
}

/**
 * pending 提案 → 既有确定性命令（§29：决策走既有命令；只有这一条 v1 可决路径）。
 * 非 pending（accepted/transferring 已在途、resolved 已决）→ 无 response 语义。
 */
function responseFor(a: AttentionItem): InteractionResponse | undefined {
	if (a.type !== "master-handoff") return undefined;
	const status = (a.payload as { status?: unknown } | null)?.status;
	if (status !== "pending") return undefined;
	return { command: "master.handoff.accept" };
}

function toInteraction(a: AttentionItem): InteractionItem {
	const response = responseFor(a);
	return {
		id: a.id,
		kind: a.type,
		severity: a.severity,
		createdAt: a.createdAt,
		title: a.title,
		summary: a.summary,
		...(a.payload !== undefined ? { payload: a.payload } : {}),
		...(response !== undefined ? { response } : {}),
	};
}

/**
 * 待决策交互投影（纯函数，永不 throw）：open attention 条目 1:1 直投（同 id/序），resolved
 * 永不出现（includeResolved 恒 false——交互是「待决策」视图，历史走 GET /v1/attention）。
 * 同 state 同输出：原料只读、无时钟、无随机（buildAttentionItems 已是纯函数，G3 T7 锁零写盘）。
 */
export function buildInteractions(opts: InteractionsOptions = {}): InteractionItem[] {
	try {
		return buildAttentionItems({
			stateDir: opts.stateDir,
			mailboxDir: opts.mailboxDir,
			includeResolved: false,
		})
			// 双保险：即使上游过滤语义变化，交互视图也只出 open（待决策定义）
			.filter((a) => a.status === "open")
			.map(toInteraction);
	} catch {
		return [];
	}
}
