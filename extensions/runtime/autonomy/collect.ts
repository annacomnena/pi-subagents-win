/**
 * runtime/autonomy/collect.ts — 薄 IO 装配层（autonomy 模块中做批量 IO 的唯一文件；config/kill-switch 各有一个窄 IO 面）。
 *
 * Task 2002 · plans/0923_autonomy_suite_v1_plan.md（"薄 IO 装配层"）。
 *
 * - 只读调用：collectGlobalView（global-view.ts）/ mailboxBacklog（mailbox.ts，只读计数）/
 *   readLiveness（liveness.ts）/ readKillSwitch / readAutonomyConfig。
 * - 只写自有 namespace：`<runtimeDir>/state/autonomy/{frontier.json, kill-switch.json, audit.jsonl}`
 *   （frontier.json 原子写 tmp+rename，同 timers/mailbox/liveness；audit 追加 best-effort）。
 * - 红线条款 1/3：绝不写 journal / mailbox / tab-runs / timers / recentwork.md / config.json / Wiki；
 *   零 claimLetters/ackLetter/deliverLetter/emitRuntimeEvent 调用（mailbox 只经 mailboxBacklog 只读计数）。
 * - 红线条款 10：never-throw 顶层容忍——任何异常收敛为默认返回（frontier:null、watchdog 不唤醒、
 *   gating 视为 inactive），绝不抛给调用方。
 * - v1 无任何调用方注册它（无循环、无注册——计划工程约束 2）；仅测试（temp 目录）与后续 L2 接线使用。
 *   本层不产生任何 wake/注入：Wake Gate 判定由调用层用 evaluateWakeGate（纯）消费返回的 diff。
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultRuntimeDir } from "../journal.ts";
import { collectGlobalView } from "../global-view.ts";
import { mailboxBacklog } from "../mailbox.ts";
import { readLiveness } from "../liveness.ts";
import { masterAddress } from "../address.ts";
import { readAutonomyConfig } from "./config.ts";
import { buildFrontier, mapPhaseToProjectState, type FrontierDiff, type FrontierSnapshot } from "./frontier.ts";
import { clearKillSwitch, engageKillSwitch, evaluateAutonomyGating, readKillSwitch } from "./kill-switch.ts";
import { evaluateWatchdogChecks, type WatchdogReport } from "./watchdog.ts";
import type { WakeGateState } from "./wake-gate.ts";

/** 自有 namespace：`<stateDir>/autonomy`（stateDir 缺省 = `<runtimeDir>/state`，同 liveness 模式）。 */
export function autonomyDir(stateDir?: string): string {
	return join(stateDir ?? join(defaultRuntimeDir(), "state"), "autonomy");
}

/** best-effort 审计行（never-throw）：`state/autonomy/audit.jsonl`（纯函数只返回行，写盘在此——wake.ts 审计分离先例）。 */
export function appendAuditLine(line: string, opts?: { stateDir?: string }): void {
	try {
		const dir = autonomyDir(opts?.stateDir);
		mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, "audit.jsonl"), `${line}\n`, "utf8");
	} catch {
		/* never-throw：审计不阻塞主流程 */
	}
}

function writeJsonAtomic(path: string, value: unknown): void {
	const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}

/** 容忍读：缺失/坏 JSON/结构漂移 → null（C4：快照是派生缓存；损坏按无基线处理，重建自愈不风暴）。 */
export function readFrontierSnapshot(opts?: { stateDir?: string }): FrontierSnapshot | null {
	try {
		const raw = JSON.parse(readFileSync(join(autonomyDir(opts?.stateDir), "frontier.json"), "utf8")) as FrontierSnapshot;
		if (
			typeof raw?.asof !== "number" ||
			!Array.isArray(raw.projects) ||
			!Array.isArray(raw.triggers) ||
			typeof raw.baseline !== "boolean"
		) {
			return null;
		}
		return raw;
	} catch {
		return null;
	}
}

/** 原子写（never-throw）：`state/autonomy/frontier.json`。返回是否实际写盘（false = 失败，调用方无需处理——派生缓存）。 */
export function writeFrontierSnapshot(snap: FrontierSnapshot, opts?: { stateDir?: string }): boolean {
	try {
		const dir = autonomyDir(opts?.stateDir);
		mkdirSync(dir, { recursive: true });
		writeJsonAtomic(join(dir, "frontier.json"), snap);
		return true;
	} catch {
		return false;
	}
}

/** kill-switch engage + 审计行（红线条款 2：engage/clear 各产一行审计；审计由本层写，kill-switch.ts 不碰审计——避免循环依赖）。 */
export function engageKillSwitchAudited(input: { reason: string; by: string }, opts?: { stateDir?: string; now?: Date }): boolean {
	const ok = engageKillSwitch(input, opts);
	appendAuditLine(`kill-switch engage ok=${ok} reason=${input.reason} by=${input.by}`, { stateDir: opts?.stateDir });
	return ok;
}

/** kill-switch clear + 审计行（同上）。 */
export function clearKillSwitchAudited(opts?: { stateDir?: string }): boolean {
	const ok = clearKillSwitch(opts);
	appendAuditLine(`kill-switch clear ok=${ok}`, { stateDir: opts?.stateDir });
	return ok;
}

export interface AutonomyInputs {
	frontier: { next: FrontierSnapshot; diff: FrontierDiff } | null;
	watchdog: WatchdogReport;
	gating: { active: boolean; reason: string };
}

/**
 * 只读聚合 + 写自有 namespace（never-throw：任何异常收敛为默认返回）。
 *
 * - gating = normalize(autonomy 配置) × kill 文件（kill 优先）；gating 短路每次产审计行（红线条款 2）。
 * - frontier = buildFrontier(collectGlobalView 产物, mailboxBacklog 计数, 上一份快照, now)；
 *   快照写 frontier.json（best-effort），触发逐条产审计行（含 approx 标注）。
 * - watchdog 输入装配：unhandledFrontierDiff = 本帧 diff 含非 approx 触发（v1 无 L2 决策状态，
 *   "未决策"= 本帧存在真触发；L2 接线后用 wake-gate 状态细化）；mailboxBacklogPending = master 地址
 *   pending 合计（recipient 目录名映射同 mailboxDirFor）；runStateMismatch = details 里 pidAlive===false
 *   且非终态（visible zombie）；heartbeatAgeMs 来自 readLiveness（null = no-liveness → 检查 7 unknown）。
 */
export function collectAutonomyInputs(opts?: { agentDir?: string; stateDir?: string; now?: number; configPath?: string }): AutonomyInputs {
	const stateDir = opts?.stateDir;
	try {
		const now = opts?.now ?? Date.now();
		const cfg = readAutonomyConfig({ configPath: opts?.configPath }); // v2（Task 2006 工程约束 3）：optional configPath 透传；不传 = 原行为逐字节不变
		const kill = readKillSwitch({ stateDir });
		const gating = evaluateAutonomyGating(cfg, kill);
		if (!gating.active) appendAuditLine(`gating no-wake reason=${gating.reason}`, { stateDir }); // 红线条款 2：每次 gate 短路产审计行

		const snapshot = collectGlobalView({ agentDir: opts?.agentDir, now });
		const backlog = mailboxBacklog();
		const masterKey = masterAddress().replace(/[^A-Za-z0-9._-]/g, "_"); // mailboxDirFor 同款映射
		const masterPending = backlog.filter((b) => b.recipient === masterKey).reduce((s, b) => s + b.pending, 0);

		const prev = readFrontierSnapshot({ stateDir });
		const { next, diff } = buildFrontier({ snapshot, backlog, prev, now });
		writeFrontierSnapshot(next, { stateDir }); // best-effort；失败不影响返回（C4 派生缓存）
		appendAuditLine(
			`frontier baseline=${next.baseline} projects=${next.projects.length} triggers=${diff.triggers.length} meaningful=${diff.meaningfulChanges} recordonly=${diff.recordOnly.length}`,
			{ stateDir },
		);
		for (const t of diff.triggers) {
			appendAuditLine(`frontier trigger rule=${t.rule} project=${t.project.slice(0, 80)} approx=${t.approximate} evidence=${t.evidence}`, { stateDir });
		}

		const liveness = readLiveness(stateDir);
		let heartbeatAgeMs: number | null = null;
		if (liveness?.updatedAt) {
			const t = Date.parse(liveness.updatedAt);
			heartbeatAgeMs = Number.isFinite(t) ? now - t : null; // 解析失败 = no-liveness → unknown（不猜）
		}
		const watchdog = evaluateWatchdogChecks({
			gating,
			unhandledFrontierDiff: diff.triggers.some((t) => !t.approximate),
			mailboxBacklogPending: masterPending,
			stalledProjects: next.projects.filter((p) => p.stagnation).map((p) => p.project),
			readyWork: diff.triggers.some((t) => t.rule === "blocked_to_ready"),
			// v1 无 turn 状态载体 → idle 近似恒 false（检查 5 的 true 判定不可达，防 approx 误报）
			idleOwnerApprox: false,
			runStateMismatch: snapshot.details
				.filter((d) => d.pidAlive === false && !mapPhaseToProjectState(d.phase).terminal)
				.map((d) => ({ runId: d.runId, phase: d.phase, pidAlive: false as const })),
			heartbeatAgeMs,
		});
		appendAuditLine(watchdog.auditLine, { stateDir });

		return { frontier: { next, diff }, watchdog, gating };
	} catch (e) {
		// never-throw 顶层容忍（红线条款 10 / 工程约束 10）
		appendAuditLine(`collect failed reason=${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`, { stateDir });
		return {
			frontier: null,
			watchdog: { wakeRecommended: false, checks: {}, auditLine: "watchdog no-wake reason=collect-failed" },
			gating: { active: false, reason: "collect-failed" },
		};
	}
}

// ── v2（Task 2006 L2）IO/审计 helpers（D-G/D-H；只写自有 namespace，全部 never-throw）──────────

/** 容忍读：缺失/坏 JSON/字段漂移 → null（派生缓存，与 frontier 快照同一自愈口径）。 */
export function readWakeGateState(opts?: { stateDir?: string }): WakeGateState | null {
	try {
		const raw = JSON.parse(readFileSync(join(autonomyDir(opts?.stateDir), "wake-gate.json"), "utf8")) as WakeGateState;
		if (
			typeof raw !== "object" ||
			raw === null ||
			(raw.lastDecisionAt !== null && typeof raw.lastDecisionAt !== "number") ||
			(raw.lastWakeAt !== null && typeof raw.lastWakeAt !== "number") ||
			(raw.batchFirstSeenAt !== null && typeof raw.batchFirstSeenAt !== "number") ||
			(raw.lastReason !== undefined && raw.lastReason !== null && typeof raw.lastReason !== "string")
		) {
			return null;
		}
		return raw;
	} catch {
		return null;
	}
}

/** 原子写（tmp+rename，never-throw）：`state/autonomy/wake-gate.json`。返回是否实际写盘（false = 失败，调用方无需处理——派生状态）。 */
export function writeWakeGateState(state: WakeGateState, opts?: { stateDir?: string }): boolean {
	try {
		const dir = autonomyDir(opts?.stateDir);
		mkdirSync(dir, { recursive: true });
		const value: Record<string, unknown> = {
			lastDecisionAt: state.lastDecisionAt,
			lastWakeAt: state.lastWakeAt,
			batchFirstSeenAt: state.batchFirstSeenAt,
		};
		if (state.lastReason !== undefined) value.lastReason = state.lastReason;
		writeJsonAtomic(join(dir, "wake-gate.json"), value);
		return true;
	} catch {
		return false;
	}
}

/**
 * v2 结构化审计行（D-H）：`ts=<ISO> cat=<gating|wake|kill> concl=<...> reason=<...> acted=false`
 * 与 v1 的 appendAuditLine（无 ts 前缀的行）共写同一 audit.jsonl，两格式共存（计划文档化）。
 * acted 恒 false：v2 无任何自动动作（kill/clear 是用户手动运维命令，学术诚实定性）。
 * reason 消毒（换行/制表符 → 空格，截断 200，空 → "-"）保护行式格式；never-throw。
 */
export function appendAuditEvent(cat: "gating" | "wake" | "kill", concl: string, reason: string, stateDir?: string): void {
	try {
		const safe = reason.replace(/[\r\n\t]+/g, " ").trim().slice(0, 200) || "-";
		appendAuditLine(`ts=${new Date().toISOString()} cat=${cat} concl=${concl} reason=${safe} acted=false`, { stateDir });
	} catch {
		/* never-throw：审计不阻塞主流程 */
	}
}

/** 容忍读 audit.jsonl 尾部 ≤limit 行（默认 5，/autonomy status 用）；缺失/不可读 → []。 */
export function readAuditTail(opts?: { stateDir?: string; limit?: number }): string[] {
	const limit = Math.max(1, opts?.limit ?? 5);
	try {
		const lines = readFileSync(join(autonomyDir(opts?.stateDir), "audit.jsonl"), "utf8").split("\n");
		while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
		return lines.slice(-limit);
	} catch {
		return [];
	}
}
