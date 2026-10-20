/**
 * chatAutoExpand.ts — 折叠块「自动展开 / 自动合上」的**判定规则**（纯函数，2026-10-20）。
 *
 * 用户诉求：「当前执行的思考或者工具调用，自动展开，然后完毕后自动合上」。
 *
 * 抽成纯函数的原因：这条规则有三个容易搞错的边界（历史卡片、用户手动操作、终态类型），
 * 放在组件里只能靠浏览器手测；抽出来就能 Node 直测每一条。
 *
 * 返回语义：
 *   - `true`  ⇒ 自动展开
 *   - `false` ⇒ 自动合上
 *   - `null`  ⇒ **不做任何改变**（保持现状）
 *
 * 为什么需要 `null` 而不是二值：一打开会话时，所有历史工具卡都是「终态且从未 running」，
 * 若用二值 `false` 会把用户之前手动展开的历史卡片全部合上。
 */

export interface AutoExpandInput {
	/** 当前状态是否「执行中」（toolCall.status === "running"）。 */
	isRunning: boolean;
	/** 本行是否**曾经**处于执行中（用于区分「刚跑完」与「历史终态」）。 */
	wasRunning: boolean;
	/** 用户是否手动点过（手动优先，自动逻辑永久让位）。 */
	userLocked: boolean;
}

export function autoExpandTarget(input: AutoExpandInput): boolean | null {
	// 用户手动操作过 ⇒ 自动逻辑不参与（不能和用户抢）
	if (input.userLocked) return null;
	// 正在执行 ⇒ 展开
	if (input.isRunning) return true;
	// 刚从执行中转为终态 ⇒ 合上（"完毕后自动合上"）
	if (input.wasRunning) return false;
	// 从未执行过（历史卡片）⇒ 不动
	return null;
}
