/**
 * timers — 计时器（自动消息推进）核心纯函数模块
 *
 * 目标：计时结束 → 系统自动向目标会话发送一条用户消息，推进工作。
 * 与 tab-runs 回收配合，成为超长程任务编排的基础设施（派发→定时推进→回收→下一批）。
 *
 * 机制（见 plans/20260807_plan_timer-infra.md）：
 *   - 文件账本 ~/.pi/agent/timers/<timerId>.json（target=self）
 *   - 邮箱   ~/.pi/agent/timers/mail/<tabRunId>/<timerId>.json（target=某标签页）
 *   - 每个 pi 进程的调度器只消费属于自己的 timer；到期原子 claim 后注入消息
 *
 * 本模块只含纯函数与最小文件 IO（阶段 0：先证明校验/到期/原子 claim/邮箱映射成立），
 * 不注册调度器、不接入 pi API、不修改 launch 流程。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ── 常量 ──────────────────────────────────────────────────────────

/** 消息长度上限。 */
export const MAX_TIMER_MESSAGE = 2048;
/** 单进程最多 pending timer 数。 */
export const MAX_PENDING_TIMERS = 50;
/** repeatMs 下限（防止自触发风暴）。 */
export const MIN_REPEAT_MS = 10_000;

// ── 类型 ──────────────────────────────────────────────────────────

export type TimerTarget = "self" | { tabRunId: string; taskId?: string };
export type TimerStatus = "pending" | "fired" | "cancelled" | "missed";

export interface TimerRecord {
	/** timer_<base36 时间戳>_<rand>，唯一键。 */
	id: string;
	version: 1;
	/** ISO 到期时刻。 */
	dueAt: string;
	/** 自动发送的用户消息（≤ MAX_TIMER_MESSAGE 字符）。 */
	message: string;
	/** "self" = 当前进程；{tabRunId} = 目标标签页邮箱。 */
	target: TimerTarget;
	/** 创建者说明（agent/命令/launch-tabs）。 */
	source: string;
	label?: string;
	/** 可选周期重发（≥ MIN_REPEAT_MS，每次到期重置 dueAt）。 */
	repeatMs?: number;
	status: TimerStatus;
	firedAt?: string;
	/** pi 未运行期间已到期，启动后补发。 */
	firedLate?: boolean;
	createdAt: string;
}

// ── 纯函数：id / 路径 ─────────────────────────────────────────────

/** 生成 timer id：timer_<base36 时间戳>_<rand>。 */
export function newTimerId(now: Date = new Date()): string {
	const ts = now.getTime().toString(36);
	const rand = Math.random().toString(36).slice(2, 6);
	return `timer_${ts}_${rand}`;
}

/** 默认计时器根目录：~/.pi/agent/timers。 */
export function defaultTimersDir(agentDir: string = join(homedir(), ".pi", "agent")): string {
	return join(agentDir, "timers");
}

/** 某标签页的邮箱目录：<timersDir>/mail/<tabRunId>。 */
export function mailboxDirForTab(timersDir: string, tabRunId: string): string {
	return join(timersDir, "mail", tabRunId);
}

/** 单个 timer 的账本文件路径：target=self → <timersDir>/<id>.json；tab → mail/<tabRunId>/<id>.json。 */
export function timerFilePath(timersDir: string, timerId: string, tabRunId?: string): string {
	return tabRunId ? join(mailboxDirForTab(timersDir, tabRunId), `${timerId}.json`) : join(timersDir, `${timerId}.json`);
}

/** dueAt = now + delayMs（ISO）。 */
export function dueAtFromDelay(delayMs: number, now: Date = new Date()): string {
	return new Date(now.getTime() + Math.max(0, Math.floor(delayMs))).toISOString();
}

// ── 纯函数：校验 ──────────────────────────────────────────────────

/** 校验 TimerRecord 字段（宽松：可选字段缺省即通过，错误类型拒绝）。 */
export function validateTimerRecord(raw: unknown): { ok: boolean; errors: string[]; value?: TimerRecord } {
	const record = raw !== null && typeof raw === "object" && !Array.isArray(raw)
		? (raw as Record<string, unknown>)
		: null;
	if (!record) return { ok: false, errors: ["not an object"] };
	const errors: string[] = [];

	const id = typeof record.id === "string" && record.id ? record.id : "";
	if (!id) errors.push("id required");
	if (record.version !== 1) errors.push("version must be 1");

	const dueAt = typeof record.dueAt === "string" && Number.isFinite(Date.parse(record.dueAt)) ? record.dueAt : "";
	if (!dueAt) errors.push("dueAt must be a valid ISO timestamp");

	const message = typeof record.message === "string" ? record.message : "";
	if (!message) errors.push("message required");
	else if (message.length > MAX_TIMER_MESSAGE) errors.push(`message exceeds ${MAX_TIMER_MESSAGE} chars`);

	// target: "self" | { tabRunId: string, taskId?: string }
	let target: TimerTarget | undefined;
	if (record.target === "self") {
		target = "self";
	} else if (record.target && typeof record.target === "object") {
		const t = record.target as Record<string, unknown>;
		if (typeof t.tabRunId === "string" && t.tabRunId) {
			target = { tabRunId: t.tabRunId, taskId: typeof t.taskId === "string" ? t.taskId : undefined };
		} else {
			errors.push("target.tabRunId required when target is an object");
		}
	} else {
		errors.push("target must be \"self\" or { tabRunId }");
	}

	const source = typeof record.source === "string" && record.source ? record.source : "";
	if (!source) errors.push("source required");

	const status = record.status as TimerStatus;
	if (!["pending", "fired", "cancelled", "missed"].includes(status)) {
		errors.push(`status must be pending|fired|cancelled|missed, got ${String(record.status)}`);
	}

	let repeatMs: number | undefined;
	if (record.repeatMs !== undefined) {
		if (typeof record.repeatMs !== "number" || !Number.isFinite(record.repeatMs) || record.repeatMs < MIN_REPEAT_MS) {
			errors.push(`repeatMs must be >= ${MIN_REPEAT_MS}`);
		} else {
			repeatMs = Math.floor(record.repeatMs);
		}
	}

	const createdAt = typeof record.createdAt === "string" ? record.createdAt : new Date().toISOString();

	if (errors.length > 0) return { ok: false, errors };

	const value: TimerRecord = {
		id,
		version: 1,
		dueAt,
		message,
		target: target ?? "self",
		source,
		label: typeof record.label === "string" && record.label ? record.label : undefined,
		repeatMs,
		status,
		firedAt: typeof record.firedAt === "string" ? record.firedAt : undefined,
		firedLate: record.firedLate === true ? true : undefined,
		createdAt,
	};
	return { ok: true, errors, value };
}

// ── 纯函数：到期 / 晚发判定 ──────────────────────────────────────

/** 剩余毫秒：到期前为正，到期后为负。 */
export function remainingMs(record: Pick<TimerRecord, "dueAt">, now: Date = new Date()): number {
	return Date.parse(record.dueAt) - now.getTime();
}

/** 是否到期（status=pending 且 dueAt ≤ now）。 */
export function isDue(record: TimerRecord, now: Date = new Date()): boolean {
	return record.status === "pending" && remainingMs(record, now) <= 0;
}

/**
 * 晚发判定：pending 且已超时 graceMs（调度器没在跑，如 pi 未运行）。
 * 默认 grace 30s：正常 tick 抖动不算晚发。
 */
export function isLate(record: TimerRecord, now: Date = new Date(), graceMs: number = 30_000): boolean {
	if (record.status !== "pending") return false;
	return Date.parse(record.dueAt) + graceMs < now.getTime();
}

/** 纯函数：构造 fired 版本（不改原对象）。 */
export function withFired(record: TimerRecord, now: Date = new Date(), opts?: { firedLate?: boolean }): TimerRecord {
	return {
		...record,
		status: "fired",
		firedAt: now.toISOString(),
		firedLate: opts?.firedLate === true || isLate(record, now) ? true : undefined,
	};
}

// ── 文件 IO（原子写 + CAS claim）─────────────────────────────────

/** 原子写：写 <id>.json.tmp 后 rename。目录自动创建。 */
export function writeTimerAtomic(
	timersDir: string,
	timer: TimerRecord,
	opts?: { tabRunId?: string },
): void {
	const file = timerFilePath(timersDir, timer.id, opts?.tabRunId);
	const dir = dirname(file);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, JSON.stringify(timer, null, 2) + "\n", "utf8");
	renameSync(tmp, file);
}

/** 读取单个 timer 文件；缺失/损坏返回 null。 */
export function readTimerFile(timersDir: string, timerId: string, tabRunId?: string): TimerRecord | null {
	const file = timerFilePath(timersDir, timerId, tabRunId);
	if (!existsSync(file)) return null;
	try {
		const raw = JSON.parse(readFileSync(file, "utf8"));
		const check = validateTimerRecord(raw);
		return check.ok && check.value ? check.value : null;
	} catch {
		return null;
	}
}

/**
 * CAS 到期 claim：读当前记录 → 若 status 仍为 pending 则写 fired 版本并返回；
 * 已 fired/cancelled/missed 返回 null（防双发）。
 *
 * 注：单进程调度器场景下无并发写冲突；跨进程同写同一 timer 属误用（每 timer 只有
 * 一个消费方），此处仍做「读-校验-写」的最小防护。
 */
export function casFireTimer(
	timersDir: string,
	timerId: string,
	opts?: { tabRunId?: string; now?: Date; firedLate?: boolean },
): TimerRecord | null {
	const current = readTimerFile(timersDir, timerId, opts?.tabRunId);
	if (!current || current.status !== "pending") return null;
	const fired = withFired(current, opts?.now ?? new Date(), { firedLate: opts?.firedLate });
	writeTimerAtomic(timersDir, fired, { tabRunId: opts?.tabRunId });
	return fired;
}

/** 取消：读 → 置 cancelled → 原子写；不存在或已终态返回 null。 */
export function cancelTimerFile(timersDir: string, timerId: string, tabRunId?: string): TimerRecord | null {
	const current = readTimerFile(timersDir, timerId, tabRunId);
	if (!current || current.status !== "pending") return null;
	const cancelled: TimerRecord = { ...current, status: "cancelled" };
	writeTimerAtomic(timersDir, cancelled, { tabRunId });
	return cancelled;
}

/** 列出目录下全部 <id>.json（不含 .tmp / 非 .json）。 */
export function listTimerFiles(timersDir: string, tabRunId?: string): string[] {
	const dir = tabRunId ? mailboxDirForTab(timersDir, tabRunId) : timersDir;
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"))
		.map((f) => f.slice(0, -".json".length));
}

/** 读取目录下全部 timer 记录（按 id 排序，含目标邮箱）。 */
export function readAllTimers(timersDir: string, tabRunId?: string): TimerRecord[] {
	const out: TimerRecord[] = [];
	for (const id of listTimerFiles(timersDir, tabRunId)) {
		const r = readTimerFile(timersDir, id, tabRunId);
		if (r) out.push(r);
	}
	return out.sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
}

/** 当前 pending 且已到期的 timer 列表（调度器每 tick 调用）。 */
export function collectDueTimers(timersDir: string, opts?: { tabRunId?: string; now?: Date }): TimerRecord[] {
	const now = opts?.now ?? new Date();
	return readAllTimers(timersDir, opts?.tabRunId).filter((r) => isDue(r, now));
}

/** 统计 pending 数（用于 MAX_PENDING_TIMERS 限制）。 */
export function countPending(timersDir: string, tabRunId?: string): number {
	return readAllTimers(timersDir, tabRunId).filter((r) => r.status === "pending").length;
}
