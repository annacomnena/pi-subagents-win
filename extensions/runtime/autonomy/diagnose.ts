/**
 * runtime/autonomy/diagnose.ts — 主动性**只读诊断**（阶段 0，2026-11-01）
 *
 * ## 为什么需要它
 *
 * 主动性套件当前的痛点是**不透明**：判断「它到底在干什么」必须手工 grep 五六个状态文件。
 * 实测过的三个例子（都是手工挖出来的）：
 *   · `lastWakeAt === lastDecisionAt` 恒等 ⇒ `decision.wake` 恒为 true（门在无条件放行）
 *   · `batchFirstSeenAt` 卡了 36.2 天（累积锚点从没被消费）
 *   · `actions.jsonl` 里 49 次 `git-repo-not-found` / `git-pre:git-unknown`
 *     （占全部 rejected 的 61%，同一非 git 项目反复重试）
 *
 * 本模块把这三类观察**固化成一次调用**。
 *
 * ## 硬约束（这是"阶段 0：零风险"的全部意义）
 *
 * 1. **绝不调用 `collectAutonomyInputs()`** —— 它内部会
 *    `writeFrontierSnapshot()` + `appendAuditLine()`，是有副作用的。
 *    诊断必须能反复跑而不改变任何状态。
 * 2. **只读文件**：`readFrontierSnapshot` / `readWakeGateState` / `readKillSwitch` /
 *    `readAutonomyConfig` / `readFileSync`（actions.jsonl 尾部）。不写任何东西。
 * 3. **never-throw**：任何读取失败都收敛成字段上的 `error` 说明，不抛。
 *    诊断工具自己崩掉是最糟的失败模式（你会以为"系统坏了"）。
 * 4. 不 import 任何 Pi tool 层模块（`wake.ts:15` 层向禁令）。
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { defaultRuntimeDir } from "../journal.ts";
import { readFrontierSnapshot, readWakeGateState } from "./collect.ts";
import { readKillSwitch } from "./kill-switch.ts";
import { readAutonomyConfig } from "./config.ts";
import type { FrontierTrigger } from "./frontier.ts";

export interface DiagnoseOptions {
	stateDir?: string;
	now?: number;
}

/** 单条触发的诊断行。 */
export interface TriggerDiagnosis {
	rule: string;
	project: string;
	evidence: string;
	/** `approximate: true` 的触发**不计入** `meaningfulChanges`，只记录不叫醒。 */
	approximate: boolean;
}

/** actions.jsonl 的拒绝原因聚合。 */
export interface ActionRejectStat {
	reason: string;
	count: number;
	/** 该原因是否属于「重试一百次也一样」的确定性失败（值得修），而非正常限流。 */
	deterministic: boolean;
}

export interface AutonomyDiagnosis {
	/** 读取过程中的非致命问题（每条一句话）。 */
	warnings: string[];

	// ── 闸门层 ──
	config: {
		enabled: boolean | null;
		actionsEnabled: boolean | null;
		error?: string;
	};
	kill: {
		engaged: boolean;
		reason?: string;
		by?: string;
		at?: string;
		error?: string;
	};
	heartbeat: {
		/** heartbeat 文件的 mtime 龄（ms）；null = 文件不存在。 */
		ageMs: number | null;
		/** null = 无法读取；true/false = tick 是否新鲜（阈值 3× tick 间隔）。 */
		fresh: boolean | null;
		error?: string;
	};

	// ── 快照层 ──
	frontier: {
		asof: string | null;
		ageMs: number | null;
		baseline: boolean | null;
		projectCount: number;
		/** 按 state 聚合（Working/Completed/Failed/... 的真实分布）。 */
		stateHistogram: Record<string, number>;
		/** 按 supervision 六态聚合。 */
		supervisionHistogram: Record<string, number>;
		triggers: TriggerDiagnosis[];
		/** 非 approximate 的触发数（真正推进 wake 决策的）。 */
		meaningfulCount: number;
		approximateCount: number;
		error?: string;
	};

	// ── 闸门决策层 ──
	wakeGate: {
		lastDecisionAt: string | null;
		lastWakeAt: string | null;
		lastReason: string | null;
		batchFirstSeenAt: string | null;
		/**
		 * 🔴 关键异常信号：`lastWakeAt === lastDecisionAt` 意味着**每次决策都是 wake**，
		 * 门形同虚设。真机上见过恒为 true。
		 */
		suspiciousAlwaysWake: boolean;
		/**
		 * 🔴 关键异常信号：`batchFirstSeenAt` 龄 > 1 天 ⇒ 累积锚点从未被消费
		 * （真机见过卡 36.2 天）。
		 */
		suspiciousStaleAnchor: boolean;
		batchAnchorAgeMs: number | null;
		error?: string;
	};

	// ── 动作层 ──
	actions: {
		available: boolean;
		total: number;
		/** kind 分布（attempted / executed / rejected / skipped / ...）。 */
		kindHistogram: Record<string, number>;
		rejects: ActionRejectStat[];
		/** 确定性失败（值得修）占 rejected 的比例。 */
		deterministicRejectRatio: number | null;
		error?: string;
	};

	/** 汇总：给人看的一句话结论。 */
	verdict: string;
}

/** 判定「确定性失败」的原因前缀：重试一百次结果也一样。 */
const DETERMINISTIC_REJECT_PATTERNS = [
	"git-repo-not-found",
	"git-pre:",
];

/** heartbeat 新鲜阈值：tick 基线 30s，3 倍容差。 */
const HEARTBEAT_STALE_MS = 90_000;

/** batchFirstSeenAt 疑似卡死阈值：1 天。 */
const BATCH_ANCHOR_STALE_MS = 24 * 60 * 60 * 1000;

function ageOfIso(iso: string | null, now: number): number | null {
	if (!iso) return null;
	const t = Date.parse(iso);
	return Number.isFinite(t) ? Math.max(0, now - t) : null;
}

function bump(map: Record<string, number>, key: string): void {
	map[key] = (map[key] ?? 0) + 1;
}

/**
 * 只读诊断：装配当前主动性套件各层状态。
 *
 * **绝不写盘**（不调用 collect / 不 appendAudit / 不写 frontier）。
 */
export function diagnoseAutonomy(opts: DiagnoseOptions = {}): AutonomyDiagnosis {
	const now = opts.now ?? Date.now();
	const stateDir = opts.stateDir ?? join(defaultRuntimeDir(), "state");
	const autonomyDir = join(stateDir, "autonomy");
	const warnings: string[] = [];

	const out: AutonomyDiagnosis = {
		warnings,
		config: { enabled: null, actionsEnabled: null },
		kill: { engaged: false },
		heartbeat: { ageMs: null, fresh: null },
		frontier: {
			asof: null,
			ageMs: null,
			baseline: null,
			projectCount: 0,
			stateHistogram: {},
			supervisionHistogram: {},
			triggers: [],
			meaningfulCount: 0,
			approximateCount: 0,
		},
		wakeGate: {
			lastDecisionAt: null,
			lastWakeAt: null,
			lastReason: null,
			batchFirstSeenAt: null,
			suspiciousAlwaysWake: false,
			suspiciousStaleAnchor: false,
			batchAnchorAgeMs: null,
			dedupeEntries: 0,
			dedupeOldestAgeMs: null,
			dedupeNewestAgeMs: null,
			dedupeWorking: false,
		},
		actions: { available: false, total: 0, kindHistogram: {}, rejects: [], deterministicRejectRatio: null },
		verdict: "",
	};

	// ── 1. 配置 ──
	try {
		const cfg = readAutonomyConfig();
		out.config.enabled = cfg.enabled === true;
		out.config.actionsEnabled = (cfg.actions as { enabled?: boolean } | undefined)?.enabled === true;
	} catch (e) {
		out.config.error = e instanceof Error ? e.message : String(e);
	}

	// ── 2. kill switch ──
	try {
		const kill = readKillSwitch({ stateDir });
		if (kill) {
			out.kill.engaged = true;
			out.kill.reason = typeof kill.reason === "string" ? kill.reason : undefined;
			out.kill.by = typeof kill.by === "string" ? kill.by : undefined;
			out.kill.at = typeof kill.at === "string" ? kill.at : undefined;
		}
	} catch (e) {
		out.kill.error = e instanceof Error ? e.message : String(e);
	}

	// ── 3. heartbeat（区分「tick 死了」与「autonomy 被关」）──
	try {
		const hbPath = join(autonomyDir, "heartbeat.json");
		if (existsSync(hbPath)) {
			out.heartbeat.ageMs = Math.max(0, now - statSync(hbPath).mtimeMs);
			out.heartbeat.fresh = out.heartbeat.ageMs <= HEARTBEAT_STALE_MS;
		} else {
			warnings.push("heartbeat.json 不存在：tick 可能从未运行，或该 stateDir 无 autonomy 活动");
		}
	} catch (e) {
		out.heartbeat.error = e instanceof Error ? e.message : String(e);
	}

	// ── 4. frontier 快照（只读，用 readFrontierSnapshot 而非 collect）──
	try {
		const snap = readFrontierSnapshot({ stateDir });
		if (snap) {
			const s = snap;
			out.frontier.asof = typeof s.asof === "number" ? new Date(s.asof).toISOString() : null;
			out.frontier.ageMs = typeof s.asof === "number" ? Math.max(0, now - s.asof) : null;
			out.frontier.baseline = typeof s.baseline === "boolean" ? s.baseline : null;

			const projects = Array.isArray(s.projects) ? s.projects : [];
			out.frontier.projectCount = projects.length;
			for (const p of projects) {
				bump(out.frontier.stateHistogram, String(p?.state ?? "unknown"));
				const sup = (p as { supervision?: { state?: string } })?.supervision;
				bump(out.frontier.supervisionHistogram, String(sup?.state ?? "unknown"));
			}

			const triggers = Array.isArray(s.triggers) ? (s.triggers as FrontierTrigger[]) : [];
			for (const t of triggers) {
				const approx = t.approximate === true;
				out.frontier.triggers.push({
					rule: String(t.rule ?? "?"),
					project: String(t.project ?? "?"),
					evidence: String(t.evidence ?? ""),
					approximate: approx,
				});
				if (approx) out.frontier.approximateCount += 1;
				else out.frontier.meaningfulCount += 1;
			}
			if (out.frontier.ageMs !== null && out.frontier.ageMs > HEARTBEAT_STALE_MS) {
				warnings.push(
					`frontier.json 龄 ${Math.round(out.frontier.ageMs / 1000)}s（> 90s）—— 与 heartbeat 对照可判别「tick 死」还是「autonomy 被关」`,
				);
			}
		} else {
			warnings.push("frontier.json 不存在或不可读：autonomy 可能从未成功跑过一帧");
		}
	} catch (e) {
		out.frontier.error = e instanceof Error ? e.message : String(e);
	}

	// ── 5. wake gate（🔴 两个关键异常信号在这里）──
	try {
		const wg = readWakeGateState({ stateDir });
		if (wg) {
			const toIso = (ms: unknown): string | null =>
				typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
			out.wakeGate.lastDecisionAt = toIso(wg.lastDecisionAt);
			out.wakeGate.lastWakeAt = toIso(wg.lastWakeAt);
			out.wakeGate.lastReason = typeof wg.lastReason === "string" ? wg.lastReason : null;
			out.wakeGate.batchFirstSeenAt = toIso(wg.batchFirstSeenAt);

			// 2026-11-01 阶段 2：去重账本状态
			{
				const ledger = wg.dedupe ?? {};
				const entries = Object.entries(ledger);
				out.wakeGate.dedupeEntries = entries.length;
				let oldest: number | null = null;
				let newest: number | null = null;
				for (const [, v] of entries) {
					const t = Date.parse(v);
					if (!Number.isFinite(t)) continue;
					const age = Math.max(0, now - t);
					if (oldest === null || age > oldest) oldest = age;
					if (newest === null || age < newest) newest = age;
				}
				out.wakeGate.dedupeOldestAgeMs = oldest;
				out.wakeGate.dedupeNewestAgeMs = newest;
				// 去重是否在生效：账本非空 **且** 最近一次判定是 all-deduped
				out.wakeGate.dedupeWorking = entries.length > 0 && out.wakeGate.lastReason === "all-deduped";
			}

			// 信号 1：每次决策都 wake ⇒ 门形同虚设
			if (
				typeof wg.lastDecisionAt === "number" &&
				typeof wg.lastWakeAt === "number" &&
				wg.lastDecisionAt === wg.lastWakeAt
			) {
				out.wakeGate.suspiciousAlwaysWake = true;
			}

			// 信号 2：累积锚点从没被消费
			const anchorAge = ageOfIso(out.wakeGate.batchFirstSeenAt, now);
			out.wakeGate.batchAnchorAgeMs = anchorAge;
			if (anchorAge !== null && anchorAge > BATCH_ANCHOR_STALE_MS) {
				out.wakeGate.suspiciousStaleAnchor = true;
			}
		} else {
			warnings.push("wake-gate.json 不存在：无闸门决策记录（或 autonomy 从未启用过）");
		}
	} catch (e) {
		out.wakeGate.error = e instanceof Error ? e.message : String(e);
	}

	// ── 6. actions.jsonl（拒绝原因分布）──
	try {
		const actPath = join(autonomyDir, "actions", "actions.jsonl");
		if (existsSync(actPath)) {
			out.actions.available = true;
			const raw = readFileSync(actPath, "utf8");
			const lines = raw.split("\n").filter((l) => l.trim() !== "");
			out.actions.total = lines.length;

			const rejectCounts = new Map<string, number>();
			for (const line of lines) {
				let rec: Record<string, unknown>;
				try {
					rec = JSON.parse(line) as Record<string, unknown>;
				} catch {
					continue;
				}
				bump(out.actions.kindHistogram, String(rec.kind ?? "unknown"));
				if (rec.kind === "rejected") {
					const reason = String(rec.reason ?? "unknown");
					rejectCounts.set(reason, (rejectCounts.get(reason) ?? 0) + 1);
				}
			}
			let deterministicTotal = 0;
			const rejects: ActionRejectStat[] = [];
			for (const [reason, count] of rejectCounts) {
				const deterministic = DETERMINISTIC_REJECT_PATTERNS.some((p) => reason.startsWith(p));
				if (deterministic) deterministicTotal += count;
				rejects.push({ reason, count, deterministic });
			}
			rejects.sort((a, b) => b.count - a.count);
			out.actions.rejects = rejects;
			const totalRejected = rejects.reduce((s, r) => s + r.count, 0);
			out.actions.deterministicRejectRatio = totalRejected > 0 ? deterministicTotal / totalRejected : null;

			if (deterministicTotal > 0) {
				warnings.push(
					`${deterministicTotal} 次确定性失败（git-* 前缀）占全部 rejected 的 ${Math.round(((out.actions.deterministicRejectRatio ?? 0) * 100))}% —— 重试不会变，属浪费而非风险`,
				);
			}
		}
	} catch (e) {
		out.actions.error = e instanceof Error ? e.message : String(e);
	}

	// ── 7. 一句话结论 ──
	out.verdict = buildVerdict(out);
	return out;
}

/**
 * 把各层信号压成一句话。
 *
 * 优先级：门失效 > 锚点卡死 > 未启用 > 正常。
 * 这是给人看的，所以宁可直白。
 */
function buildVerdict(d: AutonomyDiagnosis): string {
	if (d.config.error) return `配置不可读：${d.config.error}`;
	if (d.kill.engaged) return `kill switch 已 engaged（reason=${d.kill.reason ?? "?"}）⇒ 主动性被压制，legacy 唤醒不受影响`;

	if (d.heartbeat.fresh === false) {
		return `heartbeat 龄 ${Math.round((d.heartbeat.ageMs ?? 0) / 1000)}s ⇒ **tick 已死**（不是 autonomy 被关，是循环本身停了）`;
	}
	if (d.config.enabled !== true) {
		return "autonomy.enabled=false ⇒ 完全旁路（零 IO / 零审计）。若 heartbeat 仍在刷新，说明 tick 活着但整套被关";
	}

	const bits: string[] = [];
	if (d.wakeGate.suspiciousAlwaysWake) {
		bits.push(`🔴 门失效：lastWakeAt==lastDecisionAt ⇒ decision.wake 恒为 true（reason=${d.wakeGate.lastReason ?? "?"}）`);
	}
	if (d.wakeGate.suspiciousStaleAnchor) {
		bits.push(
			`🔴 累积锚点卡死：batchFirstSeenAt 龄 ${(d.wakeGate.batchAnchorAgeMs! / 86400000).toFixed(1)} 天 ⇒ diff 从未被消费`,
		);
	}

	const f = d.frontier;
	const working = f.stateHistogram.Working ?? 0;
	bits.push(
		`frontier ${f.projectCount} 个项目（Working ${working}）、${f.triggers.length} 条触发（meaningful ${f.meaningfulCount} / approx ${f.approximateCount}）`,
	);

	if (d.actions.available) {
		const exec = d.actions.kindHistogram.executed ?? 0;
		const rej = d.actions.kindHistogram.rejected ?? 0;
		bits.push(`actions：executed ${exec} / rejected ${rej}（共 ${d.actions.total} 条）`);
	}

	// 2026-11-01 阶段 2：去重账本状态（区分「未跑」与「在生效」）
	if (d.wakeGate.dedupeEntries > 0) {
		const newest = d.wakeGate.dedupeNewestAgeMs === null ? "?" : `${Math.round(d.wakeGate.dedupeNewestAgeMs / 60000)}m`;
		bits.push(`去重账本 ${d.wakeGate.dedupeEntries} 条（最近 ${newest} 前）${d.wakeGate.dedupeWorking ? "，正在拦截重复唤醒" : ""}`);
	} else if (d.wakeGate.lastReason === "ordinary") {
		// 本帧放行了但账本空 ⇒ 记账路径可能未生效
		bits.push("⚠ 去重账本为空但 lastReason=ordinary —— 记账路径可能未生效（或进程尚未重启加载新代码）");
	} else {
		bits.push("去重账本为空（尚未有真触发放行过）");
	}

	if (bits.length === 1 && !d.wakeGate.suspiciousAlwaysWake && !d.wakeGate.suspiciousStaleAnchor) {
		return `运行正常。${bits[0]}`;
	}
	return bits.join("；");
}
