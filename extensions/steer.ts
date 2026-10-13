/**
 * steer — 「立即插入消息」核心纯函数模块（Master → 任务 tab）
 *
 * 目标：Master 把一条消息**立即**插进某个标签页会话（下一个 tool 边界生效），
 * 与延迟投递的 timers 通道**语义分离、目录分离**（见 plans/20261012_immediate_injection_plan.md §5/§12）：
 *   - 记录账本 ~/.pi/agent/steer/<tabRunId>/<id>.json（生产者 Master 原子写；消费者 tab 原子改写）
 *   - 认领    ~/.pi/agent/steer/<tabRunId>/<id>.claimed（openSync wx 原子 sidecar，抄 event-bus::claimNotified）
 *   - 接管锁  ~/.pi/agent/steer/<tabRunId>/<id>.claimed.takeover（N-2：租约接管 CAS 的 wx 独占令牌）
 *
 * 本模块只含纯函数与最小文件 IO（无 pi API 依赖，可单独单测）：
 *   - 路径/id/校验/原子写读/认领/状态机/TTL GC/目标不活过期/发送分类
 *   - 消费者（fs.watch + tick + 注入门）在 steer-consumer.ts；Master 工具在 steer-runtime.ts
 *
 * 两档投递（见 §3.4 / §10）：
 *   - steer 档（M1）：deliverAs:"steer"，下一个 tool 边界送达；
 *   - abort 档（M2）：打断当前 run（含杀挂死工具进程树）→ 等 idle → 再发消息。
 * validator 缺省白名单为 M2_STEER_MODES = ["steer","abort"]；M1_STEER_MODES（仅 steer）
 * 保留为显式常量，供「反向」用例（证明收窄白名单仍能拒绝 abort）使用。
 */

import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { SAFE_ID_PART } from "./timers.ts";

// ── 常量 ──────────────────────────────────────────────────────────

/** 单条 steer 正文长度上限（与 timers 同量级）。 */
export const MAX_STEER_MESSAGE = 2048;
/** pending 且**目标不活**超过该时长 → undelivered（§3.5；目标活着时 pending 是正常态，不得误判）。 */
export const STEER_PENDING_TTL_MS = 30 * 60 * 1000;
/** 终态记录（delivered/aborted/failed/undelivered）超过该时长即删除（防账本无限膨胀）。 */
export const STEER_TERMINAL_TTL_MS = 24 * 60 * 60 * 1000;
/** 消费者 tick 兜底间隔（Windows fs.watch 丢事件）。 */
export const STEER_TICK_MS = 5000;
/** Master 侧 sweep 间隔。 */
export const STEER_SWEEP_MS = 60 * 1000;
/** 目标「近期活动」门槛：lastActivityAt 超过该时长且无其他活证据 → 视为不活（§3.5）。 */
export const STEER_TARGET_STALE_MS = 30 * 60 * 1000;
/**
 * `<id>.claimed` 认领租约（MF-1）：claim 成功后崩溃 / 回执写失败会留下「pending 孤儿」。
 * 认领失败且 sidecar mtime 超该租约 → 删除后重 claim（at-least-once 接管，最终收敛到终态）。
 * 取 10min，与 `runtime/receipts.ts::claimInjection(staleAfterMs=10min)` 同纪律。
 */
export const STEER_CLAIM_LEASE_MS = 10 * 60 * 1000;
/** abort 档（M2）：abort → 轮询 ctx.isIdle() 的上限。 */
export const ABORT_IDLE_TIMEOUT_MS = 30_000;
/** abort 档（M2）：轮询 ctx.isIdle() 的间隔。 */
export const ABORT_IDLE_POLL_MS = 250;
/**
 * `<id>.claimed.takeover` 抢占令牌租约（N-2）：租约接管必须先抢到该令牌才能删除陈旧
 * sidecar。令牌持有者若崩溃（进程被杀在临界区内）会留下孤儿令牌，超该租约后由后来者
 * 回收（回收者本轮**只让位、不接管**，避免回收竞态再引入双认领）。临界区只含同步 fs
 * 调用（微秒级），30s 是极宽裕上界；与 claim 租约（10min）同向，不改变孤儿收敛量级。
 */
export const STEER_TAKEOVER_LEASE_MS = 30_000;

// ── 类型 ──────────────────────────────────────────────────────────

/** M2 扩为 "steer"|"abort"；M1 validator 只放行前者。 */
export type SteerMode = "steer" | "abort";
export type SteerStatus = "pending" | "delivered" | "aborted" | "failed" | "undelivered";
/** 认领释放后的重试分类（§3.3-5）。 */
export type SteerSendStatus = "sent" | "retryable" | "failed" | "no-injector";

export interface SteerRecord {
	/** steer_<base36 时间戳>_<rand>，唯一键。 */
	id: string;
	version: 1;
	/** 目标标签页 runId（必须过 SAFE_ID_PART）。 */
	tabRunId: string;
	mode: SteerMode;
	/** 投递正文（M1 steer 档必填非空；M2 abort 档允许空串=纯打断）。 */
	body: string;
	status: SteerStatus;
	createdAt: string;
	/** 生产者说明（本期恒 "tab-steer"；将来 GUI/微信可复用通道）。 */
	source: string;
	claimedAt?: string;
	claimedBy?: string;
	/** sendUserMessage resolve 时刻（steer 档 = 已入 steering 队列，NOT 已生效；abort 档 = 空闲后起新 turn 的消息已送入）。 */
	deliveredAt?: string;
	/** abort 档：abort 已发起（先落盘，保证「abort 已发生但无回执」窗口为 0）。 */
	abortedAt?: string;
	/** abort 档：观察到 ctx.isIdle()===true。 */
	idleAt?: string;
	failedAt?: string;
	error?: string;
	undeliveredAt?: string;
	undeliveredReason?: string;
}

const VALID_STATUS: readonly SteerStatus[] = ["pending", "delivered", "aborted", "failed", "undelivered"];
/** M1 白名单：只允许 steer（"abort" 必须被拒）。保留供反向用例/收窄场景。 */
export const M1_STEER_MODES: readonly SteerMode[] = ["steer"];
/** M2 白名单（validator/request 的缺省）：steer 与 abort 两档。 */
export const M2_STEER_MODES: readonly SteerMode[] = ["steer", "abort"];

// ── 纯函数：id / 路径 ─────────────────────────────────────────────

/** 生成 steer id：steer_<base36 时间戳>_<rand>。 */
export function newSteerId(now: Date = new Date()): string {
	const ts = now.getTime().toString(36);
	const rand = Math.random().toString(36).slice(2, 6);
	return `steer_${ts}_${rand}`;
}

/** 默认 steer 根目录：~/.pi/agent/steer。 */
export function defaultSteerDir(agentDir: string = join(homedir(), ".pi", "agent")): string {
	return join(agentDir, "steer");
}

/**
 * steer 侧安全 id 组件（SF-2）：`SAFE_ID_PART` 且**显式拒绝纯点号** `.` / `..`
 * （`SAFE_ID_PART` 自身放行 `..` → `join(dir,"..")` 会逃到父目录）。
 * 只收窄 steer 通道；**不改** `timers.ts` 的常量（§5 不改清单）。
 */
export function isSafeSteerComponent(value: string): boolean {
	return value !== "." && value !== ".." && SAFE_ID_PART.test(value);
}

/** 某标签页的 steer 目录：<steerDir>/<tabRunId>。tabRunId 必须为安全字符（防路径注入）。 */
export function steerDirForTab(steerDir: string, tabRunId: string): string {
	if (!isSafeSteerComponent(tabRunId)) throw new Error(`unsafe tabRunId component: ${tabRunId}`);
	return join(steerDir, tabRunId);
}

/** 单条 steer 账本文件路径。<steerDir>/<tabRunId>/<id>.json（id 亦过安全守卫）。 */
export function steerFilePath(steerDir: string, tabRunId: string, id: string): string {
	if (!isSafeSteerComponent(id)) throw new Error(`unsafe steer id component: ${id}`);
	return join(steerDirForTab(steerDir, tabRunId), `${id}.json`);
}

/** 认领 sidecar 路径：<steerDir>/<tabRunId>/<id>.claimed。 */
export function steerClaimPath(steerDir: string, tabRunId: string, id: string): string {
	if (!isSafeSteerComponent(id)) throw new Error(`unsafe steer id component: ${id}`);
	return join(steerDirForTab(steerDir, tabRunId), `${id}.claimed`);
}

/** 接管令牌路径：<steerDir>/<tabRunId>/<id>.claimed.takeover（N-2 CAS 的独占锁）。 */
export function steerTakeoverPath(steerDir: string, tabRunId: string, id: string): string {
	if (!isSafeSteerComponent(id)) throw new Error(`unsafe steer id component: ${id}`);
	return join(steerDirForTab(steerDir, tabRunId), `${id}.claimed.takeover`);
}

// ── 纯函数：校验 ──────────────────────────────────────────────────

function optionalIso(record: Record<string, unknown>, key: string): string | undefined {
	const v = record[key];
	return typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : undefined;
}

/**
 * 校验 SteerRecord（宽松：可选字段缺省即通过，错误类型拒绝）。
 * `opts.modes` 缺省 `M2_STEER_MODES`（[ "steer","abort" ]）；传 `M1_STEER_MODES` 可收窄为仅 steer。
 * 规则：mode==="steer" 时 body 必填非空——空 steer 是无副作用的假投递，
 * 必须在校验层挡住（不产生会误报 delivered 的僵尸记录）；mode==="abort" 允许空 body（纯打断）。
 */
export function validateSteerRecord(
	raw: unknown,
	opts?: { modes?: readonly SteerMode[] },
): { ok: boolean; errors: string[]; value?: SteerRecord } {
	const record = raw !== null && typeof raw === "object" && !Array.isArray(raw)
		? (raw as Record<string, unknown>)
		: null;
	if (!record) return { ok: false, errors: ["not an object"] };
	const errors: string[] = [];
	const modes = opts?.modes ?? M2_STEER_MODES;

	const id = typeof record.id === "string" && record.id ? record.id : "";
	if (!id) errors.push("id required");
	else if (!isSafeSteerComponent(id)) errors.push("id must match SAFE_ID_PART");

	if (record.version !== 1) errors.push("version must be 1");

	const tabRunId = typeof record.tabRunId === "string" && record.tabRunId ? record.tabRunId : "";
	if (!tabRunId) errors.push("tabRunId required");
	else if (!isSafeSteerComponent(tabRunId)) errors.push("tabRunId must match SAFE_ID_PART");

	const mode = record.mode as SteerMode;
	if (!modes.includes(mode)) errors.push(`mode must be ${modes.join("|")}, got ${String(record.mode)}`);

	const body = typeof record.body === "string" ? record.body : "";
	if (typeof record.body !== "string") errors.push("body must be a string");
	else if (body.length > MAX_STEER_MESSAGE) errors.push(`body exceeds ${MAX_STEER_MESSAGE} chars`);
	else if (mode === "steer" && body.length === 0) errors.push("body required for mode steer");

	const status = record.status as SteerStatus;
	if (!VALID_STATUS.includes(status)) {
		errors.push(`status must be ${VALID_STATUS.join("|")}, got ${String(record.status)}`);
	}

	const source = typeof record.source === "string" && record.source ? record.source : "";
	if (!source) errors.push("source required");

	const createdAt = optionalIso(record, "createdAt") ?? "";
	if (!createdAt) errors.push("createdAt must be a valid ISO timestamp");

	if (errors.length > 0) return { ok: false, errors };

	const value: SteerRecord = {
		id,
		version: 1,
		tabRunId,
		mode,
		body,
		status,
		createdAt,
		source,
		claimedAt: optionalIso(record, "claimedAt"),
		claimedBy: typeof record.claimedBy === "string" && record.claimedBy ? record.claimedBy : undefined,
		deliveredAt: optionalIso(record, "deliveredAt"),
		abortedAt: optionalIso(record, "abortedAt"),
		idleAt: optionalIso(record, "idleAt"),
		// 注：abortedAt/idleAt 由 validate 保留，终态改写时由消费者显式带上
		failedAt: optionalIso(record, "failedAt"),
		error: typeof record.error === "string" && record.error ? record.error : undefined,
		undeliveredAt: optionalIso(record, "undeliveredAt"),
		undeliveredReason: typeof record.undeliveredReason === "string" && record.undeliveredReason
			? record.undeliveredReason
			: undefined,
	};
	return { ok: true, errors, value };
}

/**
 * 校验 `tab-steer` 请求参数（**纯**，无 IO；A9 入参安全的唯一判定点）。
 *
 * - tabRunId 必填 + SAFE_ID_PART（`../../evil` 一律拒）；
 * - mode 缺省 "steer"，必须命中 `opts.modes`（缺省 M2 白名单 → "abort" 放行；传 M1 白名单则拒）；
 * - body/message：mode==="steer" 必填非空；mode==="abort" 允许空串（纯打断，A9）；均 ≤ MAX_STEER_MESSAGE；
 * - scope：`opts.myRunId` 存在（调用者本身是标签页）时只允许写自己（镜像
 *   timers-runtime::resolveWriteScope 的「标签页只能给自己设」语义）。
 */
export function validateSteerRequest(
	raw: unknown,
	opts?: { modes?: readonly SteerMode[]; myRunId?: string },
): { ok: boolean; errors: string[]; value?: { tabRunId: string; mode: SteerMode; body: string } } {
	const p = raw !== null && typeof raw === "object" && !Array.isArray(raw)
		? (raw as Record<string, unknown>)
		: {};
	const errors: string[] = [];
	const modes = opts?.modes ?? M2_STEER_MODES;

	const tabRunId = typeof p.tabRunId === "string" ? p.tabRunId.trim() : "";
	if (!tabRunId) errors.push("tabRunId required");
	else if (!isSafeSteerComponent(tabRunId)) errors.push(`unsafe tabRunId: ${tabRunId}`);

	const modeRaw = p.mode === undefined ? "steer" : p.mode;
	const mode = modeRaw as SteerMode;
	if (!modes.includes(mode)) errors.push(`mode must be ${modes.join("|")}, got ${String(modeRaw)}`);

	const bodyRaw = typeof p.message === "string" ? p.message : (typeof p.body === "string" ? p.body : "");
	if (typeof p.message !== "string" && typeof p.body !== "string") errors.push("message must be a string");
	// abort 档允许空 body = 纯打断；steer 档空 body 是无副作用的假投递，必须拒。
	else if (bodyRaw.length === 0 && mode === "steer") errors.push("message required");
	else if (bodyRaw.length > MAX_STEER_MESSAGE) errors.push(`message exceeds ${MAX_STEER_MESSAGE} chars`);

	if (opts?.myRunId && tabRunId && opts.myRunId !== tabRunId) {
		errors.push("标签页只能给自己投递 steer；给其他 tab 投递请用主会话");
	}

	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, errors, value: { tabRunId, mode, body: bodyRaw } };
}

// ── 纯函数：状态机 ────────────────────────────────────────────────

/** 终态判定：非 pending 即终态（delivered/aborted/failed/undelivered）。 */
export function isSteerTerminal(record: Pick<SteerRecord, "status">): boolean {
	return record.status !== "pending";
}

/** 纯函数：置 status + 附加字段（**不修改原对象**）。 */
export function withSteerStatus(
	record: SteerRecord,
	status: SteerStatus,
	patch?: Partial<SteerRecord>,
): SteerRecord {
	return { ...record, ...patch, status };
}

/** 纯函数：盖认领章（保持 status 不变——不引入中间态，§3.3-f）。 */
export function withClaim(
	record: SteerRecord,
	opts?: { claimedBy?: string; now?: Date },
): SteerRecord {
	return {
		...record,
		claimedAt: (opts?.now ?? new Date()).toISOString(),
		claimedBy: opts?.claimedBy,
	};
}

// ── 文件 IO（原子写 + wx 认领）────────────────────────────────────

/** 原子写：写 <id>.json.tmp 后 rename；目录自动创建。 */
export function writeSteerAtomic(steerDir: string, record: SteerRecord): void {
	const file = steerFilePath(steerDir, record.tabRunId, record.id);
	const dir = dirname(file);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n", "utf8");
	renameSync(tmp, file);
}

/** 读取单条记录；缺失/损坏/半截 JSON/非法字段 → null（调用方不得据此写终态）。 */
export function readSteerRecord(steerDir: string, tabRunId: string, id: string): SteerRecord | null {
	if (!isSafeSteerComponent(id) || !isSafeSteerComponent(tabRunId)) return null;
	try {
		const file = steerFilePath(steerDir, tabRunId, id);
		if (!existsSync(file)) return null;
		const raw = JSON.parse(readFileSync(file, "utf8"));
		const check = validateSteerRecord(raw);
		return check.ok && check.value ? check.value : null;
	} catch {
		return null;
	}
}

/** 列出目录下全部 steer id（只收合法 `*.json`；排除 `.tmp`/`.claimed`）。 */
export function listSteerIds(steerDir: string, tabRunId: string): string[] {
	if (!isSafeSteerComponent(tabRunId)) return [];
	const dir = steerDirForTab(steerDir, tabRunId);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith(".json") && !f.endsWith(".tmp") && isSafeSteerComponent(f.slice(0, -".json".length)))
		.map((f) => f.slice(0, -".json".length));
}

/** 读取目录下全部 steer 记录（按 createdAt 排序；损坏记录跳过）。 */
export function readAllSteerRecords(steerDir: string, tabRunId: string): SteerRecord[] {
	const out: SteerRecord[] = [];
	for (const id of listSteerIds(steerDir, tabRunId)) {
		const r = readSteerRecord(steerDir, tabRunId, id);
		if (r) out.push(r);
	}
	return out.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

/** 认领结果（SF-1：区分「他人持有」与「IO 错误」；调用方据此决定是否标 seen）。 */
export type SteerClaimOutcome = "claimed" | "held" | "io-error";

/**
 * 认领记录（跨实例/跨 reload 去重）：`<id>.claimed` 以 `wx` 原子创建；
 * 失败且 sidecar mtime 超**租约**（MF-1）且记录仍未终态 → 删除后重认领（at-least-once 接管）。
 *
 * - `"claimed"` = 本实例获得消费权；
 * - `"held"`    = 他人（或自己的新鲜认领）持有，或记录已终态（sidecar 残留，交 sweep GC）；
 * - `"io-error"` = 创建失败但非 EEXIST（SF-1：不得据此标 seen，下 tick 重试）。
 *
 * 镜像 `event-bus::claimNotified` + `runtime/receipts.ts::claimInjection` 的 stale 接管纪律。
 *
 * N-2 强化：接管段以 `<id>.claimed.takeover` 的 `wx` 令牌串行化（CAS），见函数体内注释。
 */

/** 纯判定：sidecar 是否已超租约（stat 失败 → false = 不陈旧，保守让位）。 */
function isClaimStale(claimPath: string, nowMs: number, staleMs: number): boolean {
	try {
		return nowMs - statSync(claimPath).mtimeMs > staleMs;
	} catch {
		return false; // sidecar 刚被删/重建：保守让位，下 tick 再试
	}
}

export function claimSteerAtomicDetailed(
	steerDir: string,
	tabRunId: string,
	id: string,
	opts?: {
		staleMs?: number;
		now?: number;
		/** 接管令牌租约（N-2；缺省 STEER_TAKEOVER_LEASE_MS）。 */
		tokenLeaseMs?: number;
		/** 测试注入点：租约接管 CAS 的临界区（已持令牌、已复核陈旧），用于制造
		 *  确定性交错窗口；生产恒不传。 */
		onTakeoverCritical?: () => void;
	},
): SteerClaimOutcome {
	const claimPath = steerClaimPath(steerDir, tabRunId, id);
	const acquire = (): SteerClaimOutcome => {
		try {
			const fd = openSync(claimPath, "wx");
			try { closeSync(fd); } catch { /* ignore */ }
			return "claimed";
		} catch (e) {
			return (e as NodeJS.ErrnoException).code === "EEXIST" ? "held" : "io-error";
		}
	};
	const first = acquire();
	if (first !== "held") return first;
	const staleMs = opts?.staleMs ?? STEER_CLAIM_LEASE_MS;
	const nowMs = opts?.now ?? Date.now();
	if (!isClaimStale(claimPath, nowMs, staleMs)) return "held";
	// 租约过期：仅当记录仍未终态才接管（终态 sidecar 是残留，交 sweep GC）
	{
		const record = readSteerRecord(steerDir, tabRunId, id);
		if (!record || isSteerTerminal(record)) return "held";
	}

	// ── N-2：租约接管必须是 CAS（互斥），不能是裸 unlink ─────────────────
	// 裸 `unlinkSync(claimPath)` 非 CAS：两个接管者可先后 unlink+acquire，
	// 后者删掉前者刚建的新鲜 sidecar 再重建 → 双双 claimed → 真实消费链双投递（违反 A5）。
	// 这里用 `<id>.claimed.takeover` 的 `openSync("wx")` 抢占令牌把「复核陈旧性 → 删除陈旧
	// sidecar → 重认领」整段串行化；令牌是独占锁，线性化点仍是 acquire() 的 wx 原子创建。
	// Windows：`wx` == CREATE_NEW，已存在即原子失败 EEXIST（与 `<id>.claimed` 同一原语，
	// 无需依赖 rename 的替换语义，故无 EXDEV/杀软占用下的“改错代”风险）。
	const tokenPath = steerTakeoverPath(steerDir, tabRunId, id);
	let tokenFd = -1;
	try {
		tokenFd = openSync(tokenPath, "wx");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "EEXIST") {
			// 他人正在接管：仅当令牌本身已陈旧（持有人崩溃）才回收；本轮只让位、不接管。
			try {
				const lease = opts?.tokenLeaseMs ?? STEER_TAKEOVER_LEASE_MS;
				if (Date.now() - statSync(tokenPath).mtimeMs > lease) rmSync(tokenPath, { force: true });
			} catch { /* ignore */ }
		}
		return "held"; // 他人接管中 / 目录缺失(ENOENT) / EPERM/EACCES：保守让位，下 tick 重试
	}
	try { closeSync(tokenFd); } catch { /* ignore */ }
	try {
		// 临界区（持令牌 = 独占）：复核陈旧性与记录状态；此处的删除与 acquire 之间
		// 不再可能有第二个接管者插入（fresh 认领者若抢到空档会先 acquire 成功，本路退让）。
		if (!isClaimStale(claimPath, nowMs, staleMs)) return "held"; // 他人已接管并刷新
		const record = readSteerRecord(steerDir, tabRunId, id);
		if (!record || isSteerTerminal(record)) return "held";
		opts?.onTakeoverCritical?.();
		try {
			unlinkSync(claimPath);
		} catch {
			return "held"; // 已消失 / IO 错误：让位重试，绝不据此发送
		}
		return acquire();
	} finally {
		try { unlinkSync(tokenPath); } catch { /* best-effort 释放令牌 */ }
	}
}

/** 兼容薄封装：true = 本实例获得消费权（旧调用点/单测）。 */
export function claimSteerAtomic(
	steerDir: string,
	tabRunId: string,
	id: string,
	opts?: { staleMs?: number; now?: number },
): boolean {
	return claimSteerAtomicDetailed(steerDir, tabRunId, id, opts) === "claimed";
}

/**
 * 某 tab 目录下是否存在「新鲜 `.claimed`」（= 目标有消费者在工作的证据；SF-3）。
 * stale-claimed-pending（claim 后崩溃）**不算**——那种情况租约接管会重投，不构成活性证据。
 */
export function steerHasFreshClaim(
	steerDir: string,
	tabRunId: string,
	opts?: { now?: number; staleMs?: number },
): boolean {
	if (!isSafeSteerComponent(tabRunId)) return false;
	const dir = steerDirForTab(steerDir, tabRunId);
	if (!existsSync(dir)) return false;
	const nowMs = opts?.now ?? Date.now();
	const staleMs = opts?.staleMs ?? STEER_CLAIM_LEASE_MS;
	let entries: string[] = [];
	try { entries = readdirSync(dir); } catch { return false; }
	for (const f of entries) {
		if (!f.endsWith(".claimed")) continue;
		if (!isSafeSteerComponent(f.slice(0, -".claimed".length))) continue;
		try {
			if (nowMs - statSync(join(dir, f)).mtimeMs <= staleMs) return true;
		} catch { /* ignore */ }
	}
	return false;
}

/** 释放认领（best-effort，永不抛）。 */
export function releaseSteerClaim(steerDir: string, tabRunId: string, id: string): void {
	try { unlinkSync(steerClaimPath(steerDir, tabRunId, id)); } catch { /* best-effort */ }
}

// ── 发送分类（steer 档）────────────────────────────────────────────

/** 发送结果 + 失败原因（消费者写 failed 回执需要 error 文本）。 */
export interface SteerSendResult {
	status: SteerSendStatus;
	error?: string;
}

/**
 * 发送失败分类（steer 档与 abort 档**共用**，避免两档 retryable 口径漂移）：
 *   - reject 含 compaction → "retryable"（compaction 进行中是唯一热点，下 tick 重试）
 *   - reject 含 already processing → "retryable"（busy 口径：宁可重试也不把活消息写成 failed）
 *   - 其他 reject / 同步 throw → "failed"（附 error 文本）
 */
export function classifySteerSendFailure(e: unknown): SteerSendResult {
	const msg = e instanceof Error ? e.message : String(e);
	if (/compaction/i.test(msg)) return { status: "retryable", error: msg };
	if (/already processing/i.test(msg)) return { status: "retryable", error: msg };
	return { status: "failed", error: msg };
}

/**
 * 静默发送一条 steer 注入并 await 结果分类（§3.3-5），附失败原因。
 *
 * 与 injection-gate::injectFollowUpQuietly 同构，但 `deliverAs` 固定为 `"steer"`：
 *   - resolve            → "sent"（已入 **steering 队列**，NOT 已生效——N7：下一个 tool 边界才送达）
 *   - reject 含 compaction → "retryable"（compaction 进行中是唯一热点，下 tick 重试）
 *   - reject 含 already processing → "retryable"（**防御性**：plan §3.3-5 判定 deliverAs 路径
 *     不可达；此处沿用 injectFollowUpQuietly 的 busy 口径，宁可重试也不把活消息写成 failed）
 *   - 其他 reject / 同步 throw → "failed"（附 error 文本）
 *   - send 非函数        → "no-injector"（不伪造终态，调用方释放后重试）
 */
export function sendSteerDetailed(
	send: ((body: string, opts?: { deliverAs?: string }) => unknown) | undefined,
	body: string,
): Promise<SteerSendResult> {
	if (typeof send !== "function") return Promise.resolve({ status: "no-injector" });
	return Promise.resolve()
		.then(() => send(body, { deliverAs: "steer" }))
		.then((): SteerSendResult => ({ status: "sent" }))
		.catch(classifySteerSendFailure);
}

/** 四分类薄封装（供单测/调用方只需要分类时使用）。 */
export function sendSteerQuietly(
	send: ((body: string, opts?: { deliverAs?: string }) => unknown) | undefined,
	body: string,
): Promise<SteerSendStatus> {
	return sendSteerDetailed(send, body).then((r) => r.status);
}

// ── 清理 / 过期（GC）──────────────────────────────────────────────

/**
 * 清理超 TTL 的终态记录（返回删除数）；pending **永不**在此清理。
 * - 同时清理孤儿 `<id>.claimed`（记录已被删的 sidecar）；
 * - `tabRunId` 省略时遍历全部 tab 子目录（Master-only），并删除空目录。
 */
export function sweepTerminalSteerRecords(
	steerDir: string,
	tabRunId?: string,
	opts?: { now?: Date; maxAgeMs?: number },
): number {
	const now = (opts?.now ?? new Date()).getTime();
	const maxAge = opts?.maxAgeMs ?? STEER_TERMINAL_TTL_MS;
	if (tabRunId) {
		const dir = steerDirForTab(steerDir, tabRunId);
		if (!existsSync(dir)) return 0;
		let swept = 0;
		for (const id of listSteerIds(steerDir, tabRunId)) {
			const r = readSteerRecord(steerDir, tabRunId, id);
			if (!r || !isSteerTerminal(r)) continue;
			const terminalAt = Date.parse(r.undeliveredAt ?? r.failedAt ?? r.deliveredAt ?? r.abortedAt ?? r.createdAt);
			if (!Number.isFinite(terminalAt) || now - terminalAt <= maxAge) continue;
			try {
				rmSync(steerFilePath(steerDir, tabRunId, id), { force: true });
				swept++;
			} catch { /* best-effort */ }
		}
		// 孤儿 sidecar（json 已不存在）清理
		try {
			for (const f of readdirSync(dir)) {
				if (!f.endsWith(".claimed")) continue;
				const id = f.slice(0, -".claimed".length);
				if (!isSafeSteerComponent(id)) continue;
				if (!existsSync(steerFilePath(steerDir, tabRunId, id))) {
					rmSync(join(dir, f), { force: true });
				}
			}
		} catch { /* ignore */ }
		// N-2：孤儿接管令牌回收（持有人崩溃且此后无人再接管；正常路径由 finally 释放）
		try {
			const realNow = Date.now();
			for (const f of readdirSync(dir)) {
				if (!f.endsWith(".claimed.takeover")) continue;
				try {
					if (realNow - statSync(join(dir, f)).mtimeMs > STEER_TAKEOVER_LEASE_MS) {
						rmSync(join(dir, f), { force: true });
					}
				} catch { /* ignore */ }
			}
		} catch { /* ignore */ }
		// 空目录清理（消费者 tick 会重新 mkdir/挂 watch，见 steer-consumer）
		try {
			if (existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
		} catch { /* ignore */ }
		return swept;
	}

	if (!existsSync(steerDir)) return 0;
	let swept = 0;
	let subs: string[] = [];
	try { subs = readdirSync(steerDir); } catch { return 0; }
	for (const sub of subs) {
		if (!isSafeSteerComponent(sub)) continue;
		try {
			swept += sweepTerminalSteerRecords(steerDir, sub, opts);
		} catch { /* ignore */ }
	}
	return swept;
}

/**
 * 把「pending 超 TTL 且**目标不活**」的记录置 undelivered（§3.5 僵尸防治）。
 *
 * 关键：**单纯 pending 超时不足以判 undelivered**——长 tool 批（pi bash 无默认超时）
 * 期间 pending 是正常态。仅当 `targetAlive()` 明确为 false 才置终态；判不出活性时
 * 缺省视为活（宁可留 pending，不误报投递失败）。
 */
export function expirePendingSteerRecords(
	steerDir: string,
	tabRunId: string,
	opts?: { now?: Date; maxAgeMs?: number; targetAlive?: () => boolean },
): number {
	const now = (opts?.now ?? new Date()).getTime();
	const maxAge = opts?.maxAgeMs ?? STEER_PENDING_TTL_MS;
	const targetAlive = opts?.targetAlive ?? ((): boolean => true);
	let expired = 0;
	for (const id of listSteerIds(steerDir, tabRunId)) {
		const r = readSteerRecord(steerDir, tabRunId, id);
		if (!r || r.status !== "pending") continue;
		const createdAt = Date.parse(r.createdAt);
		if (!Number.isFinite(createdAt) || now - createdAt <= maxAge) continue;
		let alive = true;
		try { alive = targetAlive() === true; } catch { alive = true; } // 判不出 → 保守视为活
		if (alive) continue;
		try {
			writeSteerAtomic(steerDir, withSteerStatus(r, "undelivered", {
				undeliveredAt: new Date(now).toISOString(),
				undeliveredReason: "ttl-expired",
			}));
			expired++;
		} catch { /* best-effort */ }
	}
	return expired;
}
