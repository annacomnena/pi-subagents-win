/**
 * runtime/registry.ts — Logical Agent Attachment 注册表（Phase 4a，附记 A4 F3/F6）
 *
 * 文件：
 *   runtime/registry/attachments/<agent-sanitized>.json  → MasterAttachment（活锁）
 *   runtime/registry/handoff/<agent-sanitized>.json      → HandoffToken（单次交接）
 *
 * 规则（terra 仲裁冻结）：
 *   - 所有权转移必须原子 CAS：genesis 用 wx 排他创建；bump 需有效 handoff token
 *     或人工确认的 stale-force（单机 v1 人类是 tiebreaker）；心跳过期无锁自增被否决；
 *   - detach 条件匹配 {sessionId, generation}，不对就拒绝（防旧会话迟到摘掉新 owner）；
 *   - heartbeat 必须同时匹配 sessionId+generation，被 bump 掉的旧 owner 无法复活心跳；
 *   - session_start 不自动 attach（F6）：attach 一律显式调用；未 attach 时 legacy
 *     行为保持，启动顺序问题自然消解；
 *   - token 复用防线是 generation 检查（token 文件本身可残留，重放因 generation
 *     已前进而失败——删除竞态无关紧要）。
 *
 * 纯库、无接线、无 Pi API 依赖。
 *
 * 注意（0923 home 守卫）：本库无 Pi/cwd 语义，不知道调用会话的工作目录；
 * 全局 Master 的 home 位置守卫在控制层（runtime/master-control.ts::
 * attachCurrentSession）与插件入口（slash/tool）执行。直接调用本库
 * attachMaster()/attachMasterWithAudit() 会绕过该策略——生产 global 调用
 * 必须走受守卫的控制入口，不可对外直接使用底层原语。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultRuntimeDir } from "./journal.ts";
import { isObjectAddress, masterAddress, type ObjectAddress } from "./address.ts";

// ── 形状 ───────────────────────────────────────────────────────────

export interface MasterAttachment {
	agentAddress: ObjectAddress;
	sessionId: string;
	generation: number;
	attachedAt: string;
	lastHeartbeatAt: string;
	attemptId: string;
	/** 自由字段，注册表不解释。local master v1：认领时解析出的仓库 toplevel 完整路径
	 *（spawn 唤醒 tab 的 cwd 来源；无 git 时回退 cwd 本身）。 */
	detail?: string;
}

export interface HandoffToken {
	token: string;
	agentAddress: ObjectAddress;
	fromSession: string;
	fromGeneration: number;
	createdAt: string;
	expiresAt: string;
	reason?: string;
}

// ── 路径 ───────────────────────────────────────────────────────────

function registryDir(): string {
	return join(defaultRuntimeDir(), "registry");
}

function attachmentsDir(): string {
	return join(registryDir(), "attachments");
}

function handoffDir(): string {
	return join(registryDir(), "handoff");
}

export function attachmentPathFor(agent: ObjectAddress): string {
	return join(attachmentsDir(), `${agent.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

function handoffPathFor(agent: ObjectAddress): string {
	return join(handoffDir(), `${agent.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

// ── 读 ─────────────────────────────────────────────────────────────

/** 读 attachment 快照（tolerant：缺失/损坏 → null）。 */
export function readAttachment(agent: ObjectAddress = masterAddress()): MasterAttachment | null {
	try {
		const raw = JSON.parse(readFileSync(attachmentPathFor(agent), "utf8")) as MasterAttachment;
		if (!isObjectAddress(raw.agentAddress) || typeof raw.sessionId !== "string" || typeof raw.generation !== "number") {
			return null;
		}
		return raw;
	} catch {
		return null;
	}
}

// ── attach（显式）───────────────────────────────────────────────────

export interface AttachInput {
	sessionId: string;
	agent?: ObjectAddress;
	/** 交接 token（detach 颁发，单次有效——有效性由 generation 检查保证） */
	token?: string;
	/** 人工确认的 stale 接管（单机 tiebreaker 必须是人类显式动作） */
	forceStale?: boolean;
	staleAfterMs?: number;
	now?: Date;
	/** 明确人工取消（0924 L3-fix）：交接窗口内的 forceStale/takeover 被抑制，
	 *  仅显式 human cancel 可越过（人类是 tiebreaker，与 forceStale 同一语义）。 */
	humanCancel?: boolean;
	/** 自由字段：genesis 时写入（local master v1：toplevel 路径）；后续 bump/刷新保留既有值 */
	detail?: string;
}

export type AttachResult =
	| { ok: true; attachment: MasterAttachment; genesis: boolean }
	| { ok: false; reason: "bad-session" | "owner-active" | "bad-token" | "token-expired" | "generation-mismatch" | "not-stale" | "lease-contended" | "transfer-in-progress" };

/**
 * 显式 attach。genesis（无 owner）→ wx 原子创建 gen 1；已有 owner → 需 token
 * 或 forceStale（心跳过期）。并发 genesis 竞争：wx 败者回落到已有 owner 逻辑。
 */
export function attachMaster(input: AttachInput): AttachResult {
	const agent = input.agent ?? masterAddress();
	const now = (input.now ?? new Date()).toISOString();
	// 无身份哨兵拒写（M1，eventbus identity review）：sessionIdentity() 无身份时返回 "unknown"——
	// 若写入 attachment，读侧（sessionScopeKey→undefined/真实身份）永远无法匹配，形成不可恢复的
	// 永不匹配 owner。注册表层硬不变量，双门（slash/tool）只需各自给出友好报错。
	if (!input.sessionId || input.sessionId === "unknown") return { ok: false, reason: "bad-session" };

	mkdirSync(attachmentsDir(), { recursive: true });
	mkdirSync(handoffDir(), { recursive: true });

	const existing = readAttachment(agent);
	if (!existing) {
		// 0924 L3-fix（跨 scope token 绕过，L4 安全级 must-fix）：token attach 一律不得走
		// genesis——否则其它 scope 的 handoff token（如 local token）可在空目标 attachment
		// 上零验证被当作 genesis 认领 owner（L4 实测：local token 在空 global 上成功写入
		// global owner）。此处直接拒绝、零写；已有 owner 路径继续按目标自己的 handoff 文件
		// 校验（异 scope token 在目标文件不存在 → bad-token，同样零写）。
		if (input.token) return { ok: false, reason: "bad-token" };
		const genesis: MasterAttachment = {
			agentAddress: agent,
			sessionId: input.sessionId,
			generation: 1,
			attachedAt: now,
			lastHeartbeatAt: now,
			attemptId: newAttemptId(),
			...(input.detail && input.detail.trim() ? { detail: input.detail.trim() } : {}),
		};
		try {
			writeFileSync(attachmentPathFor(agent), JSON.stringify(genesis, null, 2), { flag: "wx", encoding: "utf8" });
			return { ok: true, attachment: genesis, genesis: true };
		} catch {
			// genesis 竞争失败 → 有人先建了，回落到已有 owner 逻辑
			const raced = readAttachment(agent);
			if (!raced) return { ok: false, reason: "owner-active" };
			return attachWithOwner(agent, raced, input, now);
		}
	}
	return attachWithOwner(agent, existing, input, now);
}

function attachWithOwner(
	agent: ObjectAddress,
	current: MasterAttachment,
	input: AttachInput,
	now: string,
): AttachResult {
	// F13：排他 lease 包住 read-modify-write；lease 内重读比对 generation（CAS compare）
	const lease = acquireRegistryLease(`attach:${input.sessionId}`);
	if (!lease.won) return { ok: false, reason: "lease-contended" };
	try {
		const fresh = readAttachment(agent);
		if (!fresh || fresh.generation !== current.generation || fresh.sessionId !== current.sessionId) {
			return { ok: false, reason: "generation-mismatch" }; // lease 等待期间有人先动了
		}
		return attachWithOwnerLocked(agent, fresh, input, now);
	} finally {
		lease.release();
	}
}

function attachWithOwnerLocked(
	agent: ObjectAddress,
	current: MasterAttachment,
	input: AttachInput,
	now: string,
): AttachResult {
	// 同一会话重复 attach（重启后同一 sessionId）：刷新心跳，不 bump
	if (current.sessionId === input.sessionId && !input.token && !input.forceStale) {
		const refreshed: MasterAttachment = { ...current, lastHeartbeatAt: now };
		writeJsonAtomic(attachmentPathFor(agent), refreshed);
		return { ok: true, attachment: refreshed, genesis: false };
	}

	if (input.token) {
		const handoff = readHandoffToken(agent);
		if (!handoff || handoff.token !== input.token) return { ok: false, reason: "bad-token" };
		if (Date.parse(handoff.expiresAt) <= Date.parse(now)) return { ok: false, reason: "token-expired" };
		if (handoff.fromSession !== current.sessionId || handoff.fromGeneration !== current.generation) {
			return { ok: false, reason: "generation-mismatch" };
		}
		const next: MasterAttachment = {
			agentAddress: agent,
			sessionId: input.sessionId,
			generation: current.generation + 1,
			attachedAt: now,
			lastHeartbeatAt: now,
			attemptId: newAttemptId(),
			...(current.detail ? { detail: current.detail } : {}),
		};
		writeJsonAtomic(attachmentPathFor(agent), next);
		return { ok: true, attachment: next, genesis: false };
	}

	if (input.forceStale) {
		// 0924 L3-fix（交接窗口）：transfer 在途（token 已发、后继未 confirm）期间 forceStale
		// 不得 bump——zombie reclaim / stale succession 抑制；仅显式 human cancel 越过。
		// token attach（后继本人）不受此门影响，它是窗口内唯一预期的换主路径。
		if (isTransferInFlight(agent) && !input.humanCancel) return { ok: false, reason: "transfer-in-progress" };
		const staleAfterMs = input.staleAfterMs ?? 10 * 60 * 1000;
		const age = Date.parse(now) - Date.parse(current.lastHeartbeatAt);
		if (!Number.isFinite(age) || age <= staleAfterMs) return { ok: false, reason: "not-stale" };
		const next: MasterAttachment = {
			agentAddress: agent,
			sessionId: input.sessionId,
			generation: current.generation + 1,
			attachedAt: now,
			lastHeartbeatAt: now,
			attemptId: newAttemptId(),
			...(current.detail ? { detail: current.detail } : {}),
		};
		writeJsonAtomic(attachmentPathFor(agent), next);
		return { ok: true, attachment: next, genesis: false };
	}

	return { ok: false, reason: "owner-active" };
}

// ── detach（条件）───────────────────────────────────────────────────

export interface DetachResult {
	ok: boolean;
	/** 交接 token（ok 时颁发， successor 凭此 attach） */
	token?: string;
	reason?: "not-owner";
}

/**
 * 条件 detach：{sessionId, generation} 必须同时匹配当前 attachment，
 * 否则拒绝（旧会话迟到 detach 不能摘掉新 owner，Q4 修正）。
 * 成功颁发 handoff token（TTL 缺省 24h）。
 */
export function detachMaster(input: {
	sessionId: string;
	generation: number;
	agent?: ObjectAddress;
	reason?: string;
	tokenTtlMs?: number;
	now?: Date;
}): DetachResult {
	const agent = input.agent ?? masterAddress();
	const now = input.now ?? new Date();
	const current = readAttachment(agent);
	if (!current || current.sessionId !== input.sessionId || current.generation !== input.generation) {
		return { ok: false, reason: "not-owner" };
	}
	const token: HandoffToken = {
		token: `ho_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
		agentAddress: agent,
		fromSession: input.sessionId,
		fromGeneration: input.generation,
		createdAt: now.toISOString(),
		expiresAt: new Date(now.getTime() + (input.tokenTtlMs ?? 24 * 60 * 60 * 1000)).toISOString(),
		reason: input.reason,
	};
	writeJsonAtomic(handoffPathFor(agent), token);
	return { ok: true, token: token.token };
}

export function readHandoffToken(agent: ObjectAddress = masterAddress()): HandoffToken | null {
	try {
		return JSON.parse(readFileSync(handoffPathFor(agent), "utf8")) as HandoffToken;
	} catch {
		return null;
	}
}

// ── cutover flag（F11，附记 A5：attach 与接管可分离）─────────────────

export interface CutoverState {
	enabled: boolean;
	enabledBy: string;
	enabledAt: string;
}

function cutoverPath(): string {
	return join(registryDir(), "cutover.json");
}

/** 读 cutover（缺失/损坏 → null = 未切换，legacy 行为）。 */
export function readCutover(): CutoverState | null {
	try {
		const raw = JSON.parse(readFileSync(cutoverPath(), "utf8")) as CutoverState;
		if (typeof raw.enabled !== "boolean") return null;
		return raw;
	} catch {
		return null;
	}
}

/** 写 cutover（单人操作，last-writer-wins；开关由 /master-cutover 执行）。 */
export function setCutover(enabled: boolean, by: string): CutoverState {
	mkdirSync(registryDir(), { recursive: true });
	const state: CutoverState = { enabled, enabledBy: by, enabledAt: new Date().toISOString() };
	writeJsonAtomic(cutoverPath(), state);
	return state;
}

// ── 排他 lease（F13 CAS 互斥，附记 A5）─────────────────────────────

export interface RegistryLease {
	won: boolean;
	release: () => void;
}

/**
 * 排他 lease：registry/.lease（wx 排他创建，first-wins）。
 * staleAfterMs 缺省 30s：持有者崩溃未释放，他人过期接管（lease 文件内 timestamp 判定）。
 * 用途：包住 attach 的 read-modify-write；lease 内重读比对 generation 即 CAS。
 * genesis（wx-create）与 detach（只写 token 文件，无 RMW）不需要 lease。
 */
export function acquireRegistryLease(purpose: string, staleAfterMs = 30_000): RegistryLease {
	const path = join(registryDir(), ".lease");
	mkdirSync(registryDir(), { recursive: true });
	const noop = (): void => undefined;
	const content = JSON.stringify({
		holder: `${purpose}@${process.pid}`,
		purpose,
		acquiredAt: new Date().toISOString(),
	});
	try {
		writeFileSync(path, content, { flag: "wx", encoding: "utf8" });
		return { won: true, release: () => releaseLease(path, content) };
	} catch {
		// 已被占：stale 则接管（覆盖写），否则认输
		try {
			const existing = JSON.parse(readFileSync(path, "utf8")) as { acquiredAt?: string };
			const age = Date.now() - Date.parse(existing.acquiredAt ?? "");
			if (Number.isFinite(age) && age > staleAfterMs) {
				writeRawAtomic(path, content);
				return { won: true, release: () => releaseLease(path, content) };
			}
		} catch {
			/* 读坏按被占处理（认输，safe 方向） */
		}
		return { won: false, release: noop };
	}
}

/** 释放：仅当文件内容仍是自己写入的才删（防误删他人接管后的 lease）。 */
function releaseLease(path: string, ownContent: string): void {
	try {
		const current = readFileSync(path, "utf8");
		if (current === ownContent) unlinkSync(path);
	} catch {
		/* best-effort */
	}
}

// ── stale 接管（0920 backlog B：scope owner 恢复专用）──────────────────

export interface TakeoverMasterInput {
	sessionId: string;
	/** 目标 attachment（缺省全局 master；scope stale 恢复传 scope 地址） */
	agent?: ObjectAddress;
	/** CAS 期望值：lease 内重读必须仍匹配 {sessionId, generation} 才写（F13 同款 fencing） */
	expected: { sessionId: string; generation: number };
	/** 断言的下一代（缺省 expected.generation+1；显式给出且不符 → generation-mismatch） */
	generation?: number;
	/** 明确人工取消（0924 L3-fix）：越过交接窗口抑制，并清理该 agent 的窗口 marker。 */
	humanCancel?: boolean;
	reason?: string;
	/** 诊断证据（透传 journal payload；注册表不解释） */
	evidence?: Record<string, unknown>;
	now?: Date;
}

export type TakeoverMasterResult =
	| { ok: true; attachment: MasterAttachment; prevSessionId: string; prevGeneration: number }
	| { ok: false; reason: "bad-session" | "generation-mismatch" | "lease-contended" | "transfer-in-progress" };

/**
 * Stale 接管：acquireRegistryLease → lease 内重读比对 expected（CAS）→ 覆盖写 gen+1
 *（attachedAt/lastHeartbeatAt=now、新 attemptId、detail 保留）。与全局 forceStale 对齐
 * gen/attempt 语义，但**不走**其 heartbeat-age 判据——scope 侧 lastHeartbeatAt 冻结在
 * attach 时刻、age 判据恒真；stale 判定由调用方完成（scope.ts judgeScopeOwnerStale：
 * attachment pid 死判据），这里只做原子换主。forceStale 工具链与 master-attach 全局
 * 路径零触碰。竞争败者经 generation-mismatch 自然回落（调用方当 skip）。
 */
export function takeoverMaster(input: TakeoverMasterInput): TakeoverMasterResult {
	const agent = input.agent ?? masterAddress();
	const now = (input.now ?? new Date()).toISOString();
	if (!input.sessionId || input.sessionId === "unknown") return { ok: false, reason: "bad-session" };
	// 0924 L3-fix（交接窗口）：transfer 在途期间 stale 接管被抑制（防 zombie reclaim 抢代）；
	// 明确 human cancel 越过并清理 marker（人工取消 = 该 transfer 视为作废）。
	if (!input.humanCancel && isTransferInFlight(agent)) return { ok: false, reason: "transfer-in-progress" };
	if (input.humanCancel) clearTransferWindow(agent);
	const lease = acquireRegistryLease(`takeover:${input.sessionId}`);
	if (!lease.won) return { ok: false, reason: "lease-contended" };
	try {
		const fresh = readAttachment(agent);
		if (!fresh || fresh.sessionId !== input.expected.sessionId || fresh.generation !== input.expected.generation) {
			return { ok: false, reason: "generation-mismatch" }; // lease 等待期间有人先动了（CAS 败者）
		}
		const nextGeneration = fresh.generation + 1;
		if (input.generation !== undefined && input.generation !== nextGeneration) {
			return { ok: false, reason: "generation-mismatch" };
		}
		const detail = fresh.detail; // detail 恒保留（scope toplevel 路径不随接管丢失）
		const next: MasterAttachment = {
			agentAddress: agent,
			sessionId: input.sessionId,
			generation: nextGeneration,
			attachedAt: now,
			lastHeartbeatAt: now,
			attemptId: newAttemptId(),
			...(detail ? { detail } : {}),
		};
		writeJsonAtomic(attachmentPathFor(agent), next);
		return { ok: true, attachment: next, prevSessionId: fresh.sessionId, prevGeneration: fresh.generation };
	} finally {
		lease.release();
	}
}

// ── transfer 窗口 marker（0924 L3-fix：交接在途 {agent, fromGeneration, transferId}）──────
//
// master-transfer spawn 成功后落 marker（token 已发出、后继 confirm 前的窗口）；confirm
// （completed）/ transfer failed / human cancel 清理。TTL = 24h（与 handoff token 同寿命）：
// 后继若永久死亡，窗口随 token 过期自然失效，不永久封死该 agent。窗口内 forceStale attach
// 与 stale takeover 被抑制（仅显式 human cancel 越过）；token attach（后继本人）不受影响。
// 文件放 registry/（本库自足、无模块环）；查询入口 readTransferWindow / isTransferInFlight。

export interface TransferWindowMarker {
	version: 1;
	transferId: string;
	agentAddress: ObjectAddress;
	fromGeneration: number;
	createdAt: string;
}

const TRANSFER_WINDOW_TTL_MS = 24 * 60 * 60 * 1000; // 与 handoff token 缺省 TTL 一致

function transferWindowPathFor(agent: ObjectAddress): string {
	return join(registryDir(), "transfer-window", `${agent.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

/** 读 transfer 窗口 marker（缺失/损坏 → null）。 */
export function readTransferWindow(agent: ObjectAddress = masterAddress()): TransferWindowMarker | null {
	try {
		const raw = JSON.parse(readFileSync(transferWindowPathFor(agent), "utf8")) as TransferWindowMarker;
		if (raw?.version !== 1 || typeof raw.transferId !== "string" || typeof raw.fromGeneration !== "number") return null;
		return raw;
	} catch {
		return null;
	}
}

/** 落/覆盖 transfer 窗口 marker（同 agent 后一次 transfer 覆盖前一次，v1 单 transfer 假设）。 */
export function setTransferWindow(marker: TransferWindowMarker): void {
	const path = transferWindowPathFor(marker.agentAddress);
	const dir = path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")));
	if (dir) mkdirSync(dir, { recursive: true });
	writeJsonAtomic(path, marker);
}

/** 清理 transfer 窗口 marker（不存在 = 已清理，幂等）。 */
export function clearTransferWindow(agent: ObjectAddress = masterAddress()): void {
	try {
		unlinkSync(transferWindowPathFor(agent));
	} catch {
		/* 不存在/无权限：按已清理处理（读侧 tolerant） */
	}
}

/** 交接窗口是否活跃：marker 在场且 TTL 未超龄；超龄视同不存在（token 已过期，窗口无意义）。 */
export function isTransferInFlight(agent: ObjectAddress = masterAddress(), now?: Date): boolean {
	const m = readTransferWindow(agent);
	if (!m) return false;
	const age = (now ?? new Date()).getTime() - Date.parse(m.createdAt);
	if (!Number.isFinite(age) || age < 0) return true; // 时钟回拨按在途处理（fail closed）
	return age < TRANSFER_WINDOW_TTL_MS;
}

// ── heartbeat（条件刷新）────────────────────────────────────────────
/**
 * 条件心跳：sessionId+generation 必须同时匹配，否则 false。
 * 被 bump 掉的旧 owner 无法复活心跳（防 resuscitation）。
 */
export function heartbeatMaster(sessionId: string, generation: number, agent: ObjectAddress = masterAddress()): boolean {
	const current = readAttachment(agent);
	if (!current || current.sessionId !== sessionId || current.generation !== generation) return false;
	writeJsonAtomic(attachmentPathFor(agent), { ...current, lastHeartbeatAt: new Date().toISOString() });
	return true;
}

// ── 内部 ───────────────────────────────────────────────────────────

function newAttemptId(): string {
	return `att_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function writeJsonAtomic(path: string, value: unknown): void {
	writeRawAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** 原子写原始字符串（lease takeover 需字节精确，否则 release 比对失败）。 */
function writeRawAtomic(path: string, content: string): void {
	const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
	writeFileSync(tmp, content, "utf8");
	renameSync(tmp, path);
}
