/**
 * gui/src/runsView.ts — 「运行」section 的纯展示逻辑（无 React，供 node 直载测试）。
 *
 * ## 为什么必须抽出来（不是随手写进组件里）
 *
 * 这个页面的**唯一硬约束**是：`status === "running"` **不等于**「运行中」。
 * 实测 154 份 run 记录里带 `pid` 的只有 1 份（0.6%），即 `liveness === "unknown"` 占 98.7%
 * （见 Wiki/Architecture/async-runs-endpoint.md 的 P2 读数）。如果头部计数直接数
 * `status === "running"`，就会把「进程已死但记录没来得及落终态」和「根本没有 pid 可判」
 * 都算成「正在跑」——用户看到「1 个任务运行中」，实际可能一个都没在跑。
 *
 * 所以判活只有一个入口：`deriveRunDisplay`。计数、徽标、排序分组全走它，
 * 测试也只需钉住它的反向断言（`running + unknown` ⇒ `countsAsRunning === false`）。
 */

import type { AsyncRunStatus, RunCard, RunLiveness, RunUsage } from "./api/types";

/** 显示态：三态判活的 UI 化 + 三个终态。 */
export type RunDisplayState = "alive" | "interrupted" | "unknown" | "completed" | "failed" | "cancelled";

/** 徽标色调（映射到既有 `Badge tone`：ok→green / warn→yellow / danger→red / na→na）。 */
export type RunTone = "ok" | "warn" | "danger" | "na";

export interface RunDisplay {
	state: RunDisplayState;
	label: string;
	tone: RunTone;
	/** **唯一**「算不算正在运行」的判据；头部计数/分组都必须用它。 */
	countsAsRunning: boolean;
	/** 给 hover 的解释（为什么是这个态）。 */
	hint: string;
}

const TERMINAL_LABEL: Record<Exclude<AsyncRunStatus, "running">, { state: RunDisplayState; label: string; tone: RunTone }> = {
	completed: { state: "completed", label: "已完成", tone: "na" },
	failed: { state: "failed", label: "失败", tone: "danger" },
	cancelled: { state: "cancelled", label: "已取消", tone: "na" },
};

/**
 * 单条 run 的显示态。
 *
 * 判据顺序（**不猜**）：
 *   1. `status !== "running"` ⇒ 终态直映（终态的 liveness 不参与判活；
 *      `liveness==="dead"` 对终态是**正常**的，不是「中断」）。
 *   2. `status === "running"`：
 *      - `liveness==="alive"` ⇒ `alive` /「运行中」/ countsAsRunning **true**
 *      - `liveness==="dead"`  ⇒ `interrupted` /「进程已退出」/ false（记录还没落终态，但进程没了）
 *      - `liveness==="unknown"` ⇒ `unknown` /「状态未知」/ **false**（没有 pid 可判 = 不知道，不是运行中）
 */
export function deriveRunDisplay(run: Pick<RunCard, "status" | "liveness">): RunDisplay {
	if (run.status !== "running") {
		const t = TERMINAL_LABEL[run.status as Exclude<AsyncRunStatus, "running">] ?? {
			state: "unknown" as RunDisplayState,
			label: "未知状态",
			tone: "na" as RunTone,
		};
		return {
			state: t.state,
			label: t.label,
			tone: t.tone,
			countsAsRunning: false,
			hint:
				t.state === "completed"
					? "终态：记录已完成"
					: t.state === "failed"
						? "终态：记录为失败"
						: t.state === "cancelled"
							? "终态：被用户 kill / 取消"
							: `未知终态：${String(run.status)}`,
		};
	}
	if (run.liveness === "alive") {
		return {
			state: "alive",
			label: "运行中",
			tone: "ok",
			countsAsRunning: true,
			hint: "记录 status=running 且登记 pid 仍然存活",
		};
	}
	if (run.liveness === "dead") {
		return {
			state: "interrupted",
			label: "进程已退出",
			tone: "warn",
			countsAsRunning: false,
			hint: "记录仍是 running，但登记的 pid 已不存在（进程没了、终态还没落）；可 kill 收尾",
		};
	}
	return {
		state: "unknown",
		label: "状态未知",
		tone: "na",
		countsAsRunning: false,
		hint: "记录是 running，但没有登记 pid 可判活 —— 不知道在不在跑，**不当运行中展示**",
	};
}

/** 头部计数：只数 `countsAsRunning`（**绝不**直接数 `status === "running"`）。 */
export function runningCount(runs: Pick<RunCard, "status" | "liveness">[]): number {
	let n = 0;
	for (const r of runs) if (deriveRunDisplay(r).countsAsRunning) n += 1;
	return n;
}

/** 三态分布（页脚说明用；分母 = 传入条数）。 */
export function livenessTally(runs: Pick<RunCard, "liveness">[]): Record<RunLiveness, number> {
	const t: Record<RunLiveness, number> = { alive: 0, dead: 0, unknown: 0 };
	for (const r of runs) t[r.liveness] += 1;
	return t;
}

/**
 * 用量展示：`null` ⇒「—」（运行中常态：`result.usage` 尚未落盘）。
 *
 * 格式沿用 `format.ts::fmtTokens` 的紧凑口径（<1000 原数 / <1M 用 k / ≥1M 用 M），
 * cost 用 $ 三位小数（成本量级 0.000×-1.18，两位会全变 0.00）。
 */
export function formatUsage(usage: RunUsage | null): string {
	if (usage === null) return "—";
	const side = `${fmtCompact(usage.input)} in / ${fmtCompact(usage.output)} out`;
	const cost = typeof usage.cost === "number" && Number.isFinite(usage.cost) ? ` · $${usage.cost.toFixed(3)}` : "";
	return `${side}${cost}`;
}

function fmtCompact(v: number): string {
	if (!Number.isFinite(v) || v < 0) return "--";
	if (v < 1000) return String(Math.round(v));
	if (v < 1_000_000) {
		const k = v / 1000;
		return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}k`;
	}
	return `${Math.round((v / 1_000_000) * 100) / 100}M`;
}

/** 循环判据徽标：`ok` 不喧哗（返回 null），其余给色调。终态恒 `unknown` ⇒ 也不显示。 */
export function loopBadge(verdict: RunCard["loopVerdict"]): { label: string; tone: RunTone } | null {
	if (verdict === "repeating") return { label: "原地打转", tone: "warn" };
	if (verdict === "no_progress") return { label: "无进展", tone: "warn" };
	return null;
}
