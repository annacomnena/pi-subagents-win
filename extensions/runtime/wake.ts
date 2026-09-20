/**
 * runtime/wake.ts — Sub-Master 唤醒评估（Phase 5c，A7 F20 + 仲裁裁决）
 *
 * 独立模块（失败模式 D：不内联进 consumeMailboxOnce，由 tick 末尾调用）。
 * 触发集 v1：workstream 地址 mailbox 任一 pending letter（含 agent.wake command）。
 *
 * 评估链（per workstream）：
 *   cutover/owner 双门 → status active + policy.enabled（pause 全跳过）
 *   → cooldown（先查，后扫信，省 IO）→ mailbox 有信 → debounce（最新信龄）
 *   → maxSpawns 滚动 24h → in-flight（wake-state tab 无终态且 dispatch 年轻）
 *   → claim 全 inbox → fire（含 prompt）
 *
 * 确认（调用方 spawn 成功后）：confirmWakeSpawn 写 wake-state + ack 同 holder 信
 *   + 审计 wake.spawn。spawn 抛错 → 审计 wake.spawn-failed，信留 claimed（stale 恢复）。
 * 审计纪律：spawn/spawn-failed/capped 恒记；其余 skip 每进程每 ws 只记一次（防 tick 刷屏）。
 * 遥测（lastSpawnAt/tabRunId/spawnAt）落 state/wake-state/<ws>.json，永不进
 * WorkstreamRecord（F18 双真相源纪律）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultRuntimeDir } from "./journal.ts";
import { masterAddress, workstreamAddress } from "./address.ts";
import { readAttachment, readCutover } from "./registry.ts";
import {
	ackClaimedBy,
	claimLetters,
	defaultMailboxDir,
	listLetters,
	type Letter,
} from "./mailbox.ts";
import { defaultTabRunsDir, readTabDispatch } from "../tab-runs.ts";
import {
	auditWorkstreamOp,
	listWorkstreams,
	type WorkstreamRecord,
} from "./workstreams.ts";

export type WakeSkipReason =
	| "paused"
	| "disabled"
	| "cooldown"
	| "no-mail"
	| "debounced"
	| "capped"
	| "in-flight";

export interface WakeLetter {
	messageId: string;
	subject?: string;
	summary: string;
	sentAt: string;
}

export interface WakeDecision {
	workstreamId: string;
	fire: boolean;
	reason?: WakeSkipReason;
	letters: WakeLetter[];
	/** fire 时的 bounded prompt（调用方经 launch 纪律块包装后 spawn） */
	prompt?: string;
}

export interface WakeOptions {
	stateDir?: string;
	mailboxDir?: string;
	runsDir?: string;
	sessionId: string | undefined;
	/** fake clock（毫秒，测试用；缺省 Date.now()） */
	now?: number;
	inFlightWindowMs?: number;
}

export interface WakeState {
	workstreamId: string;
	lastSpawnAt?: string;
	lastTabRunId?: string;
	/** 滚动发射 log（ISO，confirm 时追加；读时剪 >24h） */
	spawnAt: string[];
	updatedAt: string;
}

/** 每进程每 ws 只审计一次的 skip 原因（防 tick 刷屏；spawn 类恒记） */
const auditedSkip = new Set<string>();

// ── 评估（读 + claim，不 spawn 不 ack）──────────────────────────────

export function evaluateWakes(opts: WakeOptions): WakeDecision[] {
	const now = opts.now ?? Date.now();
	const cutover = readCutover();
	if (!cutover?.enabled) return []; // 与消费端同门：未切换零动作零审计
	const attachment = readAttachment(masterAddress());
	if (!attachment || !opts.sessionId || opts.sessionId !== attachment.sessionId) return [];

	const stateDir = opts.stateDir ?? join(defaultRuntimeDir(), "state");
	const mailboxDir = opts.mailboxDir ?? defaultMailboxDir();
	const decisions: WakeDecision[] = [];

	for (const ws of listWorkstreams(stateDir)) {
		const d = evaluateOne(ws, { ...opts, now, stateDir, mailboxDir });
		decisions.push(d);
	}
	return decisions;
}

function evaluateOne(
	ws: WorkstreamRecord,
	opts: WakeOptions & { now: number; stateDir: string; mailboxDir: string },
): WakeDecision {
	const skip = (reason: WakeSkipReason): WakeDecision => {
		if (!auditedSkip.has(`${ws.id}:${reason}`)) {
			auditedSkip.add(`${ws.id}:${reason}`);
			auditWorkstreamOp(opts.stateDir, opts.sessionId, `wake.skip-${reason}`, ws.id, ws.mission.slice(0, 80));
		}
		return { workstreamId: ws.id, fire: false, reason, letters: [] };
	};

	// (a) 灭火开关 + 使能（F20 day-one）
	if (ws.status !== "active") return skip("paused");
	const policy = ws.wakePolicy;
	if (!policy?.enabled) return skip("disabled");

	// cooldown 先查（省 IO）
	const state = readWakeState(ws.id, opts.stateDir);
	if (state.lastSpawnAt && opts.now - Date.parse(state.lastSpawnAt) < policy.cooldownMs) {
		return skip("cooldown");
	}

	// ws mailbox 有信
	const wsAddr = workstreamAddress(ws.id);
	let pending: Letter[];
	try {
		pending = listLetters(wsAddr, "pending", opts.mailboxDir);
	} catch {
		return skip("no-mail");
	}
	if (!pending.length) return skip("no-mail");

	// debounce：最新信龄
	if (policy.debounceMs && policy.debounceMs > 0) {
		const newest = Math.max(...pending.map((l) => Date.parse(letterTime(l))));
		if (Number.isFinite(newest) && opts.now - newest < policy.debounceMs) return skip("debounced");
	}

	// maxSpawns 滚动 24h（超限恒审计，不改 status——status 是用户意图）
	const windowStart = opts.now - 24 * 60 * 60 * 1000;
	const recentSpawns = state.spawnAt.filter((t) => Date.parse(t) >= windowStart);
	if (policy.maxSpawns !== undefined && recentSpawns.length >= policy.maxSpawns) {
		auditWorkstreamOp(opts.stateDir, opts.sessionId, "wake.capped", ws.id, `spawns=${recentSpawns.length}/${policy.maxSpawns}`);
		return { workstreamId: ws.id, fire: false, reason: "capped", letters: [] };
	}

	// in-flight：上次 spawn 的 tab 无终态且 dispatch 年轻 → 等
	if (state.lastTabRunId && isInFlight(state.lastTabRunId, opts)) {
		return skip("in-flight");
	}

	// claim 全 inbox（ws 信无其他消费者，无竞争；holder 供确认时 ackClaimedBy）
	const holder = wakeHolder(opts.sessionId!, ws.id);
	const claimed = claimLetters(wsAddr, { claimedBy: holder, mailboxDir: opts.mailboxDir });
	if (!claimed.length) return skip("no-mail"); // list→claim 窗口被他人取走（防御性）

	const letters: WakeLetter[] = claimed.map(describeLetter);
	return { workstreamId: ws.id, fire: true, letters, prompt: buildWakePrompt(ws, letters) };
}

// ── 确认（调用方 spawn 成功后）──────────────────────────────────────

export function confirmWakeSpawn(
	workstreamId: string,
	tabRunId: string,
	opts: { stateDir?: string; mailboxDir?: string; sessionId: string; now?: number },
): void {
	const now = opts.now ?? Date.now();
	const stateDir = opts.stateDir ?? join(defaultRuntimeDir(), "state");
	const state = readWakeState(workstreamId, stateDir);
	const windowStart = now - 24 * 60 * 60 * 1000;
	const spawnAt = [...state.spawnAt.filter((t) => Date.parse(t) >= windowStart), new Date(now).toISOString()];
	writeWakeState(stateDir, {
		workstreamId,
		lastSpawnAt: new Date(now).toISOString(),
		lastTabRunId: tabRunId,
		spawnAt,
		updatedAt: new Date(now).toISOString(),
	});
	const wsAddr = workstreamAddress(workstreamId);
	const n = ackClaimedBy(wsAddr, wakeHolder(opts.sessionId, workstreamId), opts.mailboxDir ?? defaultMailboxDir());
	auditWorkstreamOp(stateDir, opts.sessionId, "wake.spawn", workstreamId, `tab=${tabRunId} letters=${n}`);
}

/** spawn 抛错记账（信留 claimed，stale 恢复；不碰 wake-state——失败不占 cooldown）。 */
export function auditWakeSpawnFailed(
	workstreamId: string,
	error: string,
	opts: { stateDir?: string; sessionId?: string } = {},
): void {
	auditWorkstreamOp(opts.stateDir, opts.sessionId, "wake.spawn-failed", workstreamId, error.slice(0, 200));
}

// ── Bounded prompt（调用方经 launch 纪律块包装）─────────────────────

export function buildWakePrompt(ws: WorkstreamRecord, letters: WakeLetter[]): string {
	const lines = [
		`你是 workstream ${ws.id} 的 Sub-Master（runtime wake 层唤醒，有终态的一次执行）。`,
		`mission=${ws.mission}`,
		ws.successCriteria ? `criteria=${ws.successCriteria}` : null,
		`待处理输入（${letters.length}）：`,
		...letters.slice(0, 10).map((l) => `- [${l.subject ?? "no-subject"}] ${l.summary.slice(0, 200)}`),
		`规则：单次有界执行，做完即 tab-finish（天然 sleep）；禁止设 timer 自续命，再入只能经 wake 层；`,
		`无 actionable 输入时立即 tab-finish 报 no-op，不许挂等；`,
		`workstream 暂停时你不会被唤醒（由 wake 层保证）。`,
	].filter((l): l is string => l !== null);
	return lines.join("\n");
}

// ── wake-state IO ──────────────────────────────────────────────────

function wakeStateDir(stateDir: string): string {
	return join(stateDir, "wake-state");
}

export function readWakeState(workstreamId: string, stateDir?: string): WakeState {
	const dir = stateDir ?? join(defaultRuntimeDir(), "state");
	try {
		return JSON.parse(
			readFileSync(join(wakeStateDir(dir), `${workstreamId}.json`), "utf8"),
		) as WakeState;
	} catch {
		return { workstreamId, spawnAt: [], updatedAt: new Date().toISOString() };
	}
}

/** 导出供 local master v1 复用：wake-state 以 <scope> 命名落盘（per-workstream 结构不变）。 */
export function writeWakeState(stateDir: string, state: WakeState): void {
	const dir = wakeStateDir(stateDir);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${state.workstreamId}.json`);
	const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}

/** 导出供 local master v1 复用（id 传 scope，同构 holder 规则）。 */
export function wakeHolder(sessionId: string, workstreamId: string): string {
	return `wake:${sessionId}:${workstreamId.slice(0, 14)}`;
}

// ── 小件 ───────────────────────────────────────────────────────────

function letterTime(letter: Letter): string {
	return letter.frame.frame === "message" ? letter.frame.sentAt : letter.frame.issuedAt;
}

function describeLetter(letter: Letter): WakeLetter {
	if (letter.frame.frame === "message") {
		return { messageId: letter.frame.id, subject: letter.frame.subject, summary: letter.frame.body.summary, sentAt: letter.frame.sentAt };
	}
	return { messageId: `cmd:${letter.frame.commandKey}`, summary: `command ${letter.frame.type}`, sentAt: letter.frame.issuedAt };
}

/**
 * 在飞判定：无 result.json 且 dispatch 年轻（窗口内）→ 等；
 * dispatch 缺失/不可读/年老 → 视为 orphaned，可重生（at-least-once）。
 */
/** 导出供 local master v1 复用（同规则：无终态且 dispatch 年轻 → 在飞）。 */
export function isInFlight(
	tabRunId: string,
	opts: { runsDir?: string; now: number; inFlightWindowMs?: number },
): boolean {
	const runsDir = opts.runsDir ?? defaultTabRunsDir();
	if (existsSync(join(runsDir, `${tabRunId}.result.json`))) return false; // 有终态 → 不在飞
	const windowMs = opts.inFlightWindowMs ?? 2 * 60 * 60 * 1000;
	try {
		const dispatch = readTabDispatch(runsDir, tabRunId);
		if (!dispatch) return false;
		const age = opts.now - Date.parse(dispatch.dispatchedAt);
		return Number.isFinite(age) && age < windowMs;
	} catch {
		return false;
	}
}

/** 供测试重置进程内审计去重集合。 */
export function _resetWakeAuditForTest(): void {
	auditedSkip.clear();
}
