/**
 * runtime/autonomy/control-plane.ts — 自主控制面状态（S0.2）
 *
 * ## 为什么需要这个模块
 *
 * 本机实测（2026-11-25）：`config.json` 的 `autonomy.enabled=true` + `actions.enabled=true`，
 * `state/autonomy/heartbeat.json` 新鲜在跳，但 `registry/cutover.json` 不存在
 * ⇒ **零实际动作**。而任何单一读数都像「一切正常」。
 *
 * 结果是一个无法验收的状态：**系统「正常运行但决定不行动」与「自主链路实际没工作」
 * 无法区分**。后续任何自主决策轮都无法验收（因为验收判据本身是「证据不足时 no_action」，
 * 而你无法验证一个看不见的东西）。
 *
 * ## 三载体分离（不混用）
 *
 * | 载体 | 文件 | 写入时机 | 回答的问题 |
 * |---|---|---|---|
 * | Status Snapshot | `control-plane.json` | 每 tick（覆盖） | 现在处于什么状态？ |
 * | Metrics         | `control-plane-metrics.json` | 每 tick（累加） | 历史上评估了几次、被哪道门挡了几次？ |
 * | Audit Events    | `control-plane.jsonl` | **仅状态变化时** | 什么时候变的、从什么变成什么？ |
 *
 * 为什么不「每 tick 写一条审计」：tick 30s，cutover 连关几天 = 上万条完全相同的信息。
 * 为什么不复用 `auditedSkip`（wake.ts:99）：它是 **per-process Set**，同 `(ws.id,reason)`
 * 只写一次 ⇒ 回答「出现过吗」，**不是「出现了多少次」**，不能当计数器。
 *
 * ## 六道门（顺序固定，报「第一个失败的门」）
 *
 * ```
 * subagent      子 agent 不跑 wake loop（身份类型）
 * owner         mailboxOwnerEligible（owner 匹配）
 * cutover       wake.ts 的 readCutover().enabled（消费端接管总开关）
 * autonomy      evaluateAutonomyWakeGate（配置 + kill + collect）
 * actions       runAutonomyActions 的 actions.enabled（动作面）
 * ```
 *
 * **必须报第一个失败的门**：否则诊断会指向错误的修法（例如报 `cutover` 而实际是 `owner` 挂）。
 *
 * ## ⚠️ 本模块产物的作用域（不得超范围声明）
 *
 * 三个文件全部落在 `state/autonomy/`，而 `state/` 是**可丢弃的运行时目录**。
 * 实证：`Wiki/Architecture/autonomy-consumer-gap.md` 记录 2026-11-01 本机 `actions.jsonl`
 * 有 209 条、执行 22 次；2026-11-25 实测该目录已无 `actions/`（重装系统清理）。
 *
 * ⇒ **这些数字不是审计证据，只是"当前近似"。** 任何展示它的地方必须带限定语，
 * 不允许读者以为拿到了权威历史（R-26 家族）。
 *
 * never-throw：观测逻辑任何异常都不得影响唤醒循环或状态输出。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { autonomyDir } from "./collect.ts";

// ── 类型 ───────────────────────────────────────────────────────────────

/** 六道门（顺序即判定顺序）。 */
export type AutonomyGateStage = "subagent" | "owner" | "cutover" | "autonomy" | "actions";

/** S0.2 首版只落 6 态；每态必须有能演示它的输入（R-20：写进规则的状态必须可达）。 */
export type AutonomyOutcome =
	/** 自主评估周期没有运行（**由观测侧推断**：snapshot 超龄） */
	| "NOT_SCHEDULED"
	/** 配置明确关闭 */
	| "DISABLED"
	/** 前置门未满足（带 firstFailedGate） */
	| "GATED"
	/** 无法获得可靠工作状态（读不到 frontier 快照等） */
	| "OBSERVATION_FAILED"
	/** 已评估，但证据不足（trigger 全是 approximate / 缺 carrier） */
	| "INSUFFICIENT_EVIDENCE"
	/** 已评估，当前无需行动 */
	| "NO_ACTION_NEEDED";

export interface GateObservation {
	stage: AutonomyGateStage;
	passed: boolean;
	/** 通过时 "ok"；失败时具体原因（原文照抄判定方的 reason，不二次概括） */
	reason: string;
}

export interface ControlPlaneSnapshot {
	version: 1;
	/** 写入时刻（ms） */
	at: number;
	iso: string;
	pid: number;
	sessionId: string | null;
	intervalMs: number;
	outcome: AutonomyOutcome;
	/** 第一个失败的门；全过 = null */
	firstFailedGate: AutonomyGateStage | null;
	gates: GateObservation[];
	detail: ControlPlaneDetail;
	/** 固定限定语：提醒读者这些数字随 state/ 清理丢失 */
	volatile: string;
}

export interface ControlPlaneDetail {
	/** 本 tick 评估的 workstream 数 */
	workstreams?: number;
	/** frontier 触发数 */
	triggers?: number;
	/** 动作候选数（trigger × class） */
	candidates?: number;
	/** 动作面实际启动了几个 */
	started?: number;
	/** 附注（例如 "no-frontier-snapshot"） */
	note?: string;
}

export interface ControlPlaneMetrics {
	version: 1;
	/** 首次记录的 ms */
	since: number;
	updatedAt: number;
	/** 累计 tick 数 */
	ticks: number;
	byOutcome: Partial<Record<AutonomyOutcome, number>>;
	byFailedGate: Partial<Record<AutonomyGateStage, number>>;
	/** 状态变化（outcome 或 firstFailedGate 改变）次数 */
	transitions: number;
	volatile: string;
}

export const VOLATILE_NOTE =
	"state/ 目录，随清理/重装丢失；不可作长期审计证据（见 Wiki/Development/Current-Roadmap S0.2）";

/** NOT_SCHEDULED 推断阈值：超过 N 个 tick 无更新即视为「周期没跑」。 */
export const NOT_SCHEDULED_TICK_MULTIPLE = 3;

// ── 路径 ───────────────────────────────────────────────────────────────

function autonomyDirFor(stateDir?: string): string {
	// 复用 collect.ts 的 autonomyDir（R-17：不得自行拼路径；它已处理 defaultRuntimeDir + PI_RUNTIME_DIR 覆盖）
	return autonomyDir(stateDir);
}

export function controlPlanePaths(stateDir?: string): {
	snapshot: string;
	metrics: string;
	audit: string;
} {
	// 与 collect.ts 的 autonomyDir 同布局：<stateDir>/autonomy/*
	const dir = autonomyDirFor(stateDir);
	return {
		snapshot: join(dir, "control-plane.json"),
		metrics: join(dir, "control-plane-metrics.json"),
		audit: join(dir, "control-plane.jsonl"),
	};
}

// ── 落盘原语（never-throw）──────────────────────────────────────────────

function writeJsonAtomic(path: string, value: unknown): boolean {
	try {
		mkdirSync(join(path, ".."), { recursive: true });
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(value)}\n`, "utf8");
		renameSync(tmp, path);
		return true;
	} catch {
		return false;
	}
}

function readJson<T>(path: string): T | null {
	try {
		if (!existsSync(path)) return null;
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return null;
	}
}

// ── 判定 ───────────────────────────────────────────────────────────────

/**
 * 从门观测序列推导 outcome。
 *
 * 纯函数，无 IO（可用测试穷举六态）。
 *
 * 判定顺序很重要：**第一个失败的门决定 outcome**，且 `DISABLED` 只看 `autonomy` 门的
 * `autonomy-disabled` 原因 —— 因为「配置明确关闭」与「被其它门挡住」是两类不同的状态。
 */
export function deriveOutcome(gates: GateObservation[], detail: ControlPlaneDetail = {}): {
	outcome: AutonomyOutcome;
	firstFailedGate: AutonomyGateStage | null;
} {
	const failed = gates.find((g) => !g.passed);
	if (!failed) {
		// 全门通过 ⇒ 看是否真的评估到了东西
		if (detail.note === "no-frontier-snapshot") {
			return { outcome: "OBSERVATION_FAILED", firstFailedGate: null };
		}
		// trigger 存在但一个候选都没被允许（policy DENY/SKIP）⇒ 证据不足而非「无需行动」
		if ((detail.triggers ?? 0) > 0 && (detail.started ?? 0) === 0) {
			return { outcome: "INSUFFICIENT_EVIDENCE", firstFailedGate: null };
		}
		return { outcome: "NO_ACTION_NEEDED", firstFailedGate: null };
	}
	// autonomy 门显式 disabled ⇒ DISABLED（区别于「被 owner/cutover 挡住」）
	if (failed.stage === "autonomy" && /disabled/i.test(failed.reason)) {
		return { outcome: "DISABLED", firstFailedGate: failed.stage };
	}
	return { outcome: "GATED", firstFailedGate: failed.stage };
}

/**
 * 观测侧推断「周期是否在跑」。
 *
 * 这是**推断不是事实**：tick 函数内部无法证明自己没被调用，
 * 只能靠「最后一次快照有多旧」反推。调用方必须把推断与实测分开呈现。
 */
export function inferNotScheduled(
	snap: Pick<ControlPlaneSnapshot, "at" | "intervalMs"> | null,
	now: number,
): { notScheduled: boolean; ageMs: number | null; thresholdMs: number | null } {
	if (!snap) return { notScheduled: false, ageMs: null, thresholdMs: null }; // 从未记录 ≠ 推断为没跑
	const interval = Number.isFinite(snap.intervalMs) && snap.intervalMs > 0 ? snap.intervalMs : 30_000;
	const thresholdMs = interval * NOT_SCHEDULED_TICK_MULTIPLE;
	const ageMs = Math.max(0, now - snap.at);
	return { notScheduled: ageMs > thresholdMs, ageMs, thresholdMs };
}

// ── 记录 ───────────────────────────────────────────────────────────────

export interface RecordControlPlaneInput {
	stateDir?: string;
	sessionId: string | null;
	intervalMs: number;
	gates: GateObservation[];
	detail?: ControlPlaneDetail;
	now?: number;
	pid?: number;
}

/**
 * 每个 tick 调一次：写 snapshot（覆盖）+ metrics（累加）+ 边沿审计。
 *
 * **never-throw**：任何 IO 失败都只返回 false，绝不影响唤醒循环。
 * 返回 true = snapshot 写盘成功（metrics/audit 失败不算失败，它们是可再生的近似）。
 */
export function recordControlPlane(input: RecordControlPlaneInput): boolean {
	try {
		const now = input.now ?? Date.now();
		const paths = controlPlanePaths(input.stateDir);
		const detail = input.detail ?? {};
		const { outcome, firstFailedGate } = deriveOutcome(input.gates, detail);

		const snap: ControlPlaneSnapshot = {
			version: 1,
			at: now,
			iso: new Date(now).toISOString(),
			pid: input.pid ?? process.pid,
			sessionId: input.sessionId ?? null,
			intervalMs: input.intervalMs,
			outcome,
			firstFailedGate,
			gates: input.gates,
			detail,
			volatile: VOLATILE_NOTE,
		};

		// ── 先读旧状态：用于 metrics 累加与边沿判定（读失败 = 视为首次）
		const prevSnap = readJson<ControlPlaneSnapshot>(paths.snapshot);
		const prevMetrics = readJson<ControlPlaneMetrics>(paths.metrics);

		const ok = writeJsonAtomic(paths.snapshot, snap);

		// ── metrics 累加
		const metrics: ControlPlaneMetrics = prevMetrics ?? {
			version: 1,
			since: now,
			updatedAt: now,
			ticks: 0,
			byOutcome: {},
			byFailedGate: {},
			transitions: 0,
			volatile: VOLATILE_NOTE,
		};
		metrics.ticks += 1;
		metrics.updatedAt = now;
		metrics.byOutcome[outcome] = (metrics.byOutcome[outcome] ?? 0) + 1;
		if (firstFailedGate) {
			metrics.byFailedGate[firstFailedGate] = (metrics.byFailedGate[firstFailedGate] ?? 0) + 1;
		}

		// ── 边沿判定：outcome 或 firstFailedGate 改变才算一次 transition
		const prevOutcome = prevSnap?.outcome ?? null;
		const prevGate = prevSnap?.firstFailedGate ?? null;
		const changed = prevOutcome !== outcome || prevGate !== firstFailedGate;
		if (changed) metrics.transitions += 1;

		writeJsonAtomic(paths.metrics, metrics);

		// ── 边沿审计：只在变化时写一行（不是每 tick）
		if (changed) {
			try {
				mkdirSync(join(paths.audit, ".."), { recursive: true });
				appendFileSync(
					paths.audit,
					`${JSON.stringify({
						at: now,
						iso: snap.iso,
						from: prevOutcome,
						to: outcome,
						fromGate: prevGate,
						toGate: firstFailedGate,
						ticks: metrics.ticks,
					})}\n`,
					"utf8",
				);
			} catch {
				/* 审计失败不影响主流程 */
			}
		}

		return ok;
	} catch {
		return false;
	}
}

// ── 读取与展示 ─────────────────────────────────────────────────────────

export interface ControlPlaneReading {
	snapshot: ControlPlaneSnapshot | null;
	metrics: ControlPlaneMetrics | null;
	/** 观测侧推断（tick 是否还在跑） */
	notScheduled: boolean;
	ageMs: number | null;
	thresholdMs: number | null;
}

export function readControlPlane(opts: { stateDir?: string; now?: number } = {}): ControlPlaneReading {
	const paths = controlPlanePaths(opts.stateDir);
	const snapshot = readJson<ControlPlaneSnapshot>(paths.snapshot);
	const metrics = readJson<ControlPlaneMetrics>(paths.metrics);
	const inferred = inferNotScheduled(snapshot, opts.now ?? Date.now());
	return { snapshot, metrics, ...inferred };
}

/** 年龄文案（本仓惯例：状态展示必须给"多久之前"，不能只给绝对时间 —— R-2 规则 2）。 */
function ageText(ms: number | null): string {
	if (ms === null) return "(无记录)";
	if (ms < 60_000) return `${Math.round(ms / 1000)}s 前`;
	if (ms < 3_600_000) return `${Math.round(ms / 60_000)}min 前`;
	return `${(ms / 3_600_000).toFixed(1)}h 前`;
}

/**
 * 一行状态文案（供 `/autonomy status`）。
 *
 * 措辞纪律（R-20 规则 4）：不得超出证据作用域 —— 本行只说明「wake 链最后发生了什么」，
 * 不说明「mailbox 消费链是否活着」（那是独立的 10s interval）。
 */
export function controlPlaneLine(reading: ControlPlaneReading): string {
	const { snapshot, metrics, notScheduled, ageMs, thresholdMs } = reading;
	if (!snapshot) {
		return "自主控制面: (无记录) —— wake 链可能从未在本 state 目录跑过（新装/已清理/从未开启）";
	}
	const parts: string[] = [];
	// 先给最关键的一条：现在是什么状态
	parts.push(`${snapshot.outcome}`);
	if (snapshot.firstFailedGate) parts.push(`门=${snapshot.firstFailedGate}(${gateReasonOf(snapshot, snapshot.firstFailedGate)})`);
	if (notScheduled) {
		parts.push(`⚠️周期可能没在跑（快照 ${ageText(ageMs)}，阈值 ${Math.round((thresholdMs ?? 0) / 1000)}s）`);
	} else {
		parts.push(`快照 ${ageText(ageMs)}`);
	}
	if (metrics) {
		const topGates = Object.entries(metrics.byFailedGate)
			.sort((a, b) => b[1] - a[1])
			.map(([g, n]) => `${g}=${n}`)
			.join(" ");
		parts.push(`累计 tick=${metrics.ticks}${topGates ? ` 阻塞 ${topGates}` : ""} 变化=${metrics.transitions}`);
	}
	return `自主控制面: ${parts.join(" | ")} 〔${VOLATILE_NOTE}〕`;
}

function gateReasonOf(snap: ControlPlaneSnapshot, stage: AutonomyGateStage): string {
	return snap.gates.find((g) => g.stage === stage)?.reason ?? "?";
}
