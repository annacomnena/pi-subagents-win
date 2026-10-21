/**
 * turnCollapse.ts — 「任务执行完毕 → 自动折叠这一轮的工作过程」的**判定规则**（纯函数，2026-10-21）。
 *
 * 用户诉求：「任务执行完毕之后自动折叠工作过程，以简略界面方便用户更好的找到信息」。
 *
 * ## 为什么这件事不需要给 agent 加工具
 * 数据面早就有权威信号，GUI 自己就能判：
 *   - 每行都带 `turnIndex`（`extensions/runtime/transcript.ts:6`「turn = 行上标签非容器」）；
 *   - `turnHeader` 带 `startedAt`，且**被下一条 user 消息关闭时**补上 `durationMs`；
 *   - 「哪条是最终回复」不需要模型声明：**最后一个非文本行之后的连续 assistantText**
 *     就是收尾段，它前面的 reasoning / toolCall / 助手旁白都是「过程」。
 * 所以这里只做展示层判定，agent 侧零改动（不新增「我完成了」类工具，避免模型漏调/多调）。
 *
 * ## 折叠口径（三条硬规则）
 *   1. **跑着的轮不折叠**（`running`）—— 过程要能看见、要能自动展开；
 *   2. **只折叠「收尾段之前」的部分**：`最后一条 reasoning/toolCall` 之后必须还有
 *      `assistantText`，否则无法判断哪段是答复 ⇒ 整轮不折叠（宁可多显示，不乱藏）；
 *   3. **用户气泡永不折叠**（那是用户自己说的话，藏了会让人以为消息丢了）。
 *
 * ## 时长
 * `turnHeader.durationMs` 的口径是「本条 user 消息 → 下一条 user 消息」，
 * 所以**最后一轮永远是 undefined**（没有下一条 user 消息来关闭它）。
 * 收尾轮的时长按「本轮最后一行 `at` − `startedAt`」估算 —— assistantText 的 `at` 是
 * message_end 时刻，所以「以文字收尾」的轮是准的；以工具调用收尾的轮会略短（那也只是估算，
 * 且这种情况本来就不会折叠，见规则 2）。
 */

import type { TranscriptRow } from "./api/types";

/** 折叠区里算「步骤」的行型（助手旁白 assistantText 与用户气泡不算步骤）。 */
const STEP_KINDS = new Set<TranscriptRow["kind"]>(["reasoning", "toolCall"]);

export interface TurnSummary {
	/** 轮时长（ms）；null = 两端的时刻都拿不到（不编造）。 */
	durationMs: number | null;
	/** 折叠区里的步骤数（reasoning + toolCall）。 */
	steps: number;
	/** 折叠区里的总行数（含助手旁白）。 */
	rows: number;
	/** 用户是否把它展开了（展开 ⇒ 不隐藏任何行）。 */
	expanded: boolean;
}

export interface TurnCollapsePlan {
	/** 折叠态下**不渲染**的 rowId。 */
	hidden: Set<string>;
	/** `turnHeader.rowId` → 该轮的摘要；不在表里的轮 = 不可折叠（原样显示）。 */
	summaryByHeaderId: Map<string, TurnSummary>;
}

export interface PlanTurnCollapseOptions {
	/** 会话是否在跑（busy 标志或存在流式快照）。跑着的轮一律不折叠。 */
	running: boolean;
	/** 用户手动展开过的轮（`turnHeader.rowId` → true）。缺省 = 折叠。 */
	opened: Record<string, boolean>;
}

/** 本轮最后一行的时间戳 − 轮开始时间；取不到返回 null。 */
function estimateDuration(headAt: string, body: readonly TranscriptRow[]): number | null {
	const start = Date.parse(headAt);
	if (!Number.isFinite(start)) return null;
	let last = Number.NaN;
	for (const r of body) {
		if (r.kind === "turnHeader") continue;
		const t = Date.parse(r.at);
		if (Number.isFinite(t) && !(t <= last)) last = t;
	}
	if (!Number.isFinite(last) || last <= start) return null;
	return last - start;
}

export function planTurnCollapse(rows: readonly TranscriptRow[], opts: PlanTurnCollapseOptions): TurnCollapsePlan {
	const hidden = new Set<string>();
	const summaryByHeaderId = new Map<string, TurnSummary>();

	let i = 0;
	while (i < rows.length) {
		const head = rows[i]!;
		// 窗口从轮中间开始（没有 header）⇒ 没有可点的入口，这一轮不折叠
		if (head.kind !== "turnHeader") {
			i += 1;
			continue;
		}
		let end = i + 1;
		while (end < rows.length && rows[end]!.kind !== "turnHeader") end += 1;
		const body = rows.slice(i + 1, end);
		i = end;

		// 「收尾段」= 最后一个 reasoning/toolCall 之后的连续行
		let lastStep = -1;
		for (let k = 0; k < body.length; k += 1) {
			if (STEP_KINDS.has(body[k]!.kind)) lastStep = k;
		}
		if (lastStep < 0) continue; // 整轮只有文字（或空）⇒ 没有过程可折叠
		const tail = body.slice(lastStep + 1);
		if (!tail.some((r) => r.kind === "assistantText")) continue; // 规则 2：收尾不是文字 ⇒ 不乱藏

		// 已结束？durationMs 有值 = 已被下一条 user 消息关闭；没有则看会话是否还在跑
		const settled = head.durationMs !== undefined || !opts.running;
		if (!settled) continue;

		// 规则 3：用户气泡永不折叠
		const foldable = body.slice(0, lastStep + 1).filter((r) => r.kind !== "userInput");
		if (foldable.length === 0) continue;

		const expanded = opts.opened[head.rowId] === true;
		const summary: TurnSummary = {
			durationMs: head.durationMs ?? estimateDuration(head.startedAt, body),
			steps: foldable.filter((r) => STEP_KINDS.has(r.kind)).length,
			rows: foldable.length,
			expanded,
		};
		summaryByHeaderId.set(head.rowId, summary);
		if (!expanded) for (const r of foldable) hidden.add(r.rowId);
	}

	return { hidden, summaryByHeaderId };
}
