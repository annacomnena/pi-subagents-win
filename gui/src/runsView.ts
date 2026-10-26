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

/**
 * `RunTone` → 既有 `Badge tone`。
 *
 * 2026-10-26 P1B：从 `RunsPage.tsx` 上提到这里 —— 右栏也要渲染同一徽标，
 * 两处各写一份映射必然漂移（一处改 tone 档位，另一处静默跟不同步）。
 */
export const TONE_TO_BADGE: Record<RunTone, "green" | "yellow" | "red" | "na"> = {
	ok: "green",
	warn: "yellow",
	danger: "red",
	na: "na",
};

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

/**
 * 按「算不算运行中」把记录分成两组。**这是分组的唯一入口**（与 `runningCount` 同走 `deriveRunDisplay`）。
 *
 * 为什么必须是可直载的纯函数、不能由页面内联 filter：页面内联的
 * `filter((r) => r.status === "running")` 是**零判别力**的——2026-10-22 变异实测，把它改回裸 status 判定后
 * `test:gui-runs-view` / `test:gui-session-first` / `test:gui-contrast` / `tsc --noEmit` **全绿**，
 * 即「unknown 不得显示为运行中」在页面层没有任何断言保护（AGENTS §4.2）。抽到这里后，
 * 变异本函数必红（R7 组）。
 *
 * 保持传入顺序：服务端已做 running-first + `startedAt` 降序，本函数**不二次排序**。
 */
export function partitionRuns<T extends Pick<RunCard, "status" | "liveness">>(runs: T[]): { running: T[]; others: T[] } {
	const running: T[] = [];
	const others: T[] = [];
	for (const r of runs) (deriveRunDisplay(r).countsAsRunning ? running : others).push(r);
	return { running, others };
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
 *
 * 2026-10-26 P1B：补 `turns`（`· 98 回合`）——右栏要「费用/回合」一行，
 * 而**不另写第二套格式**（两套格式化器必然漂移，R-11 同类）。
 */
export function formatUsage(usage: RunUsage | null): string {
	if (usage === null) return "—";
	const side = `${fmtCompact(usage.input)} in / ${fmtCompact(usage.output)} out`;
	const cost = typeof usage.cost === "number" && Number.isFinite(usage.cost) ? ` · $${usage.cost.toFixed(3)}` : "";
	const turns =
		typeof usage.turns === "number" && Number.isFinite(usage.turns) && usage.turns >= 0 ? ` · ${usage.turns} 回合` : "";
	return `${side}${cost}${turns}`;
}

/** 毫秒 → 人读时长（`12 分 08 秒` / `1 时 05 分`）；负值/NaN 归 0，不抛。 */
export function fmtDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "0 秒";
	if (ms < 1000) return `${Math.round(ms)} 毫秒`;
	const totalSec = Math.floor(ms / 1000);
	if (totalSec < 60) return `${totalSec} 秒`;
	const totalMin = Math.floor(totalSec / 60);
	const sec = totalSec % 60;
	if (totalMin < 60) return `${totalMin} 分 ${String(sec).padStart(2, "0")} 秒`;
	return `${Math.floor(totalMin / 60)} 时 ${String(totalMin % 60).padStart(2, "0")} 分`;
}

/** 时长展示的两种口径（**不能混用**，混用就把「末次尝试」说成「整趟墙钟」）。 */
export type RunDurationKind = "elapsed" | "lastAttempt" | "none";

export interface RunDurationView {
	kind: RunDurationKind;
	/** 展示串：运行中 `已跑 12 分 08 秒（至今）`；进程已退出 `已跑 12 分 08 秒（进程已退出）`；
	 *  终态 `末次 12 分 08 秒`；不可得 `—`。 */
	text: string;
	/** 口径标签（**必须**出现在悬停提示里）。 */
	label: string;
	/** 数值（ms）；`null` = 不可得。 */
	ms: number | null;
}

/**
 * 时长双口径（右栏 `派发` 面板的唯一实现，2026-10-26 P1B）。
 *
 * 纪律（两条都是实测踩过的坑，见设计稿 §3.5）：
 * 1. **终态用 `durationMs`**，标签写「末次尝试耗时」。`durationMs` 由 `run.result.durationMs` 来，
 *    是**最后一次尝试**的耗时（`runWithFallback` 有 fallback/重试时会多次调用 `runSingle()`，
 *    用量有 `withAllAttemptUsage()` 聚合、**时长没有**）——UI 不得把它说成「总耗时」，
 *    也不得把多次相加。**不得反推** `startedAt ↔ endedAt`，无值就是「—」。
 * 2. **运行中用 `now - startedAt`**（标「至今」），**绝不能用 `lastActivity`** ——
 *    终态的 `lastActivity` 是 `startedAt` 兜底伪值（completed 171/171 缺真值），
 *    拿它当「已跑多久」会把「三次前启动的任务」说成「刚跑」或「跑了很久」。
 *
 * `now` 由调用方传入（纯函数：单测能钉死「终态不随 now 增长」）。
 */
export function runDurationDisplay(
	run: Pick<RunCard, "status" | "startedAt" | "durationMs"> & { liveness?: RunCard["liveness"] },
	now: number,
): RunDurationView {
	if (run.status === "running") {
		const start = typeof run.startedAt === "string" ? Date.parse(run.startedAt) : Number.NaN;
		if (!Number.isFinite(start)) {
			return { kind: "none", text: "—", label: "运行中但无 startedAt，不反推", ms: null };
		}
		const ms = Math.max(0, now - start);
		// 徽标与时长不得互相矛盾（L4 复核 §1 第 6 条建议②）：`running` 但 pid 已死 ⇒
		// 不再写「至今」（那等于宣称还在跑），改用「进程已退出」；数值口径不变（仍是 now − startedAt）。
		const dead = run.liveness === "dead";
		return {
			kind: "elapsed",
			text: dead ? `已跑 ${fmtDuration(ms)}（进程已退出）` : `已跑 ${fmtDuration(ms)}（至今）`,
			label: dead
				? "记录仍是 running 但登记的 pid 已不存在：数值仍是 now − startedAt，**不代表它还在跑**"
				: "已跑时长 = 当前时刻 − startedAt（本地时钟；不是 lastActivity）",
			ms,
		};
	}
	const dur = run.durationMs;
	if (typeof dur !== "number" || !Number.isFinite(dur) || dur < 0) {
		return { kind: "none", text: "—", label: "无 durationMs（旧记录），不从 startedAt/endedAt 反推", ms: null };
	}
	return {
		kind: "lastAttempt",
		// 「末次」必须出现在**可见文本**里（L4 复核 §1 第 6 条建议①）：只在 title 里写等于没写，
		// 有 fallback/重试时这个数比「整趟墙钟」小，不标出来会被当成任务总耗时。
		text: `末次 ${fmtDuration(dur)}`,
		label: "末次尝试耗时：有 fallback/重试时只是最后一次尝试，不是整趟墙钟、也不是各次之和",
		ms: dur,
	};
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
