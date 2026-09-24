/**
 * graph/frontier-input.ts — E2.1 适配器：GraphSnapshot → FrontierSourceSnapshot（纯函数，零 IO）。
 *
 * 计划：plans/0924_graph_E2_1_impl_plan.md §3/§4/§5；L1 校准：plans/0924_graph_E2_1_recon.md §1/§2/§3/§6。
 * 定位：为 E2.2 影子对照冻结输入契约；**零生产接线**（不被任何生产文件 import，只被测试消费）。
 *
 * 纯度：不 import 文件系统模块、不读墙钟、不用随机；同输入同输出（确定性）。
 * R4：`normalizeRepoKey` ≡ `normalizeExactPath`（逐字节同体）→ **不新增任何归一化**、严禁自写第三份
 *   normalizer；直接把 `GraphProjectView.project` 当规范键写入 `details[].repoPath` 与 `attentionByRepo` 键。
 * MF1：`history` 恒 `[]`（`GraphSnapshot.history` **不进输入**；填充会造出 v2 生产从不产的 ②③ hidden 触发）。
 * `now`：由 `opts.now` 提供（必填）；**不使用 `snap.asof`**（`graph/collect.ts#L96`：缺省不发出 → undefined）。
 */
import type { GraphProjectView, GraphRunRef, GraphSnapshot } from "./types.ts";
import type { FrontierSourceSnapshot, FrontierSourceTab } from "../autonomy/frontier.ts";

export interface FrontierInputOptions {
	/** 唯一时钟（与 v2 autonomy/collect.ts#L119 同源）；必填——GraphSnapshot.asof 缺省不发出，不可用（§5）。 */
	now: number;
}

/**
 * 单 run 适配（纯）：carrier 不存在 = 非可见 tab，**不猜、不 emit**（L1 K4）。
 * `graph/collect.ts#L165-L175` 的不变量 = carrier 存在 ⇒ gate/needsHuman/staleOver/overdue/pidAlive
 * 五键齐；此处对四值键做完整性兜底（缺任一 → 按缺 carrier 处理，绝不补默认值）。
 * `pidAlive === null`（无 state.pid）**合法**，原样保留（同 v2）。
 */
function toTab(view: GraphProjectView, ref: GraphRunRef): FrontierSourceTab | null {
	// 成员资格：无归属 / 无相位 / 无 carrier → 不 emit。
	if (ref.project === null || ref.phase === null || ref.gate === null) return null;
	const { needsHuman, staleOver, overdue } = ref;
	if (needsHuman === null || needsHuman === undefined) return null;
	if (staleOver === null || staleOver === undefined) return null;
	if (overdue === null || overdue === undefined) return null;
	return {
		runId: ref.runId,
		// R4：直接用已归一 project 键（视图键，与 ref.project 同值），零转换。
		repoPath: view.project,
		phase: ref.phase,
		needsHuman,
		gate: ref.gate,
		staleOver,
		overdue,
		pidAlive: ref.pidAlive ?? null,
	};
}

/**
 * GraphSnapshot → FrontierSourceSnapshot（纯、零 IO、确定性）。
 * - `attentionByRepo`：仅 `project.attention > 0` 写键（缺项语义 = 0；不为 0 仓造键）。
 * - `details`：仅 carrier 存在（可见 tab）且 project/phase 非 null 的 run；按 `runId` 升序（确定性）；
 *   重复 `runId` 时按 `repoPath` 升序 tie-break（公开纯函数对重复 runId 输入亦给出确定序，不依赖 Array.sort 稳定性）。
 * - `history`：恒 `[]`（MF1，不读 `snap.history`）；不产 hidden 回填。
 * - 不读 `snap.asof`；`opts.now` 仅作输入契约（`now` 由调用方透传给 `buildFrontier` 的 `now` 参数）。
 */
export function toFrontierInput(snap: GraphSnapshot, opts: FrontierInputOptions): FrontierSourceSnapshot {
	// opts.now 为输入契约（调用方须以同一 now 透传给 buildFrontier）；本函数自身不消费墙钟。
	void opts;
	const attentionByRepo: Record<string, number> = {};
	for (const view of snap.projects) {
		if (view.attention > 0) attentionByRepo[view.project] = view.attention;
	}
	const details: FrontierSourceTab[] = [];
	for (const view of snap.projects) {
		for (const ref of view.runs) {
			const tab = toTab(view, ref);
			if (tab) details.push(tab);
		}
	}
	// 契约（T12/T15）：runId 升序；重复 runId 时 repoPath 升序 tie-break（不依赖 Array.sort 稳定性）。
	details.sort((a, b) => {
		if (a.runId !== b.runId) return a.runId < b.runId ? -1 : 1;
		if (a.repoPath !== b.repoPath) return a.repoPath < b.repoPath ? -1 : 1;
		return 0;
	});
	return { attentionByRepo, details, history: [] };
}
