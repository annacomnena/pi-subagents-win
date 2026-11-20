/**
 * trace 落盘去重（2026-11-20 真机实测驱动，我自己上一 commit 的缺陷）：
 *
 * ## 事故（分母：`trace.jsonl` 30.5 MB 中 d3 占 2.37 MB / 5881 条）
 *
 * 我在 `a45ebf0` 里写了这样一条判据：
 * > `probe-found` 不落：那是**正常路径**……落了就把 trace.jsonl 变成又一个 5153 行空转日志
 *
 * 然后**只排除了 `probe-found` 和 `attempts-exhausted`，没排除 `probe-inconclusive`** ——
 * 而 `inconclusive` 恰恰是**稳态**（超大会话永远 inconclusive，`probe-found` 才是瞬态）。
 * **我把稳态和瞬态搞反了。**
 *
 * 实测后果（4 天）：
 * ```
 * d3 trace 5881 条 / 不同 outboxId 仅 20 个
 *   单条 f74a0df0adbe 重复 3945 条（每 10s tick 一条）
 *   reason 分布: probe-inconclusive 5863 | attempt-too-fresh 16 | absent-evidenced 2
 * ```
 *
 * ## 修法：只在「状态转移」时落盘，不按 tick 落盘
 *
 * trace 是**审计/独立 oracle 复算**用途（`appendTrace` 注释原话：「不参与判定」）。
 * 它不需要每 tick 粒度 —— 需要的是「这条 item 经历过哪些判定结果」。
 *
 * ⇒ per-process `Map<dedupeId, reason>`：
 *   - 首次看到某 item ⇒ 落一条
 *   - 同一 item 且 reason 与上次相同 ⇒ **不落**
 *   - reason 变了（含 A→B→A 回到旧值）⇒ 落（那是两次真实转移）
 *
 * 上界 = 每个 item × 每个不同 reason × 进程重启次数。实测 20 个 item × 6 种 reason
 * 每进程最多 ~120 条，而不是 3945 条。
 *
 * ## 为什么不"限频"（每 N 分钟落一条）
 *
 * 限频会制造**伪状态转移**：读者看不出「连续 3945 次 inconclusive」和「第 1 次 inconclusive」的
 * 区别，反而掩盖了「这条 item 卡了很久」这个本该可见的事实。**边沿触发，不是电平触发。**
 *
 * ## 为什么放进程内 Map 而不是写盘
 *
 * 写盘做去重 = 又一次「用 trace 自身记自己的状态」= 它自己坏了就失效。
 * 进程内 Map 最坏是重启后每个 item 多写一条 —— 有界、可接受，且不引入第二写者。
 * （同 `journal.ts::journalUnavailable` 的取舍：进程内计数器 + 限频落盘。）
 */

/** 进程内每个 item 上次落盘的 reason。上界 = item 数（与 reason 种类数无关）。 */
const logged = new Map<string, string>();

/**
 * 判断这次是否应该落 trace。
 *
 * @returns `true` = 本次是新的状态转移，调用方应落盘；`false` = 与上次相同，跳过。
 *
 * 语义是**边沿触发**：同 item 的 reason 未变 ⇒ false；变了 ⇒ true。
 * `dedupeId` 必须是**item 身份**（不是 `item:reason` —— 那样 A→B→A 会被读成「曾经记过 A」而丢转移）。
 *
 * never-throw；`includeItem=false` 时恒 true（给「本来就该每次都记」的条目留出口）。
 */
export function shouldLogTraceTransition(dedupeId: string, reason: string): boolean {
	try {
		if (logged.get(dedupeId) === reason) return false;
		logged.set(dedupeId, reason);
		return true;
	} catch {
		// Map 操作理论上不抛；保底 fail-open（落盘而不是静默丢掉）
		return true;
	}
}

/** 测试用：清空进程内状态（不影响盘上 trace）。 */
export function _resetTraceTransitionState(): void {
	logged.clear();
}

/** 诊断用：当前记住了多少 (item, reason) 对。 */
export function traceTransitionStateSize(): number {
	return logged.size;
}
