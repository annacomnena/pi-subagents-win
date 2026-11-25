/**
 * runtime/message-outbox.ts — G6-P2：session.message 两段式投递的 outbox 纯状态盘面
 * （plans/0920_g6_webconsole_plan.md §3 拍板③ + §29 纪律：消息投递是确定性两段状态机）。
 *
 * 分工（Host 不拥有真相，§22）：
 *   - executor（command-executor.ts session.message handler）只做**第一段**：校验 + 幂等
 *     claim + 写 outbox 信封 status:"pending"（纯状态迁移）+ journal command.accepted /
 *     message.queued；
 *   - 扩展桥（extensions/outbox-bridge.ts）做**第二段**：轮询 pending 项 → 经既有用户消息
 *     注入路径投递到目标会话 → 回写 status:"delivered"|"failed" + journal
 *     message.delivered|failed。GUI 经 WS outbox 主题（journal 投影）看两段回执。
 *
 * 盘面形状：`<stateDir>/message-outbox/<sha256(dedupeKey)>.json`（文件名摘要编码，同
 * commands/ 的 L4 必修纪律——sanitizeKey 折叠互吞面不重演；item 内 dedupeKey 严格比对兜底）。
 * 状态机（封闭）：pending → delivered | failed | expired（终态，不可再迁移；重复回写被拒绝）。
 * expired（G6-P2 L4 必修 2）：pending 超 TTL（缺省 24h）→ sweepExpiredOutboxItems 转终态
 * + journal message.expired 回执——目标会话永不重启时 pending 不再是永久孤儿（桥每个消费
 * tick 与 host 启动时都会扫）。
 * 无 compaction（§23 纪律同 journal/commands）；文件只增改不删。
 *
 * 投递语义（诚实口径，plans/0922_g6p2_review.md 必修 1）：sendUserMessage 注入与 receipt
 * 回写非原子事务，第二段是 **at-least-once**（崩溃窗口重投），由注入互斥键（outbox:<id>）
 * + 注入正文内的 dedupe 标记让目标端幂等去重；不声称 exactly-once。
 *
 * 纯库：无 Pi API 依赖；所有读 tolerant never-throw（坏文件跳过），写失败向上抛
 * （调用方 executor 收敛为 io-error / 桥吞掉）。
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { piSessionAddress, type ObjectAddress } from "./address.ts";
import { newEventEnvelope } from "./envelope.ts";
import { appendRuntimeEnvelopeOnceSafe, defaultJournalPath } from "./journal.ts";

// ── 词表 ───────────────────────────────────────────────────────────

export const OUTBOX_STATUSES = ["pending", "delivered", "failed", "expired"] as const;

export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

/** pending 的可恢复终态 TTL（G6-P2 L4 必修 2）：超龄转 expired，不留永久孤儿。 */
export const OUTBOX_PENDING_TTL_MS = 24 * 60 * 60 * 1000;

/** 本 outbox 只服务一种命令（封闭，v1 不做泛化信箱）。 */
export const OUTBOX_COMMAND_TYPE = "session.message";

export interface OutboxItem {
	version: 1;
	/** = sha256(dedupeKey) hex（文件名同名去后缀）。 */
	id: string;
	/** `session.message:<commandKey>`（executor 幂等键同形）。 */
	dedupeKey: string;
	commandKey: string;
	type: typeof OUTBOX_COMMAND_TYPE;
	/** 目标 pi 会话地址（pi://<sessionId>）。 */
	to: ObjectAddress;
	/** 目标会话 id（冗余 to 的 value，桥匹配用）。 */
	sessionId: string;
	/** 消息正文（1..16384 UTF-8 字节；校验在 executor payload 白名单）。 */
	text: string;
	/**
	 * 【2026-11-04 新增】用户**显式要求**拉起目标会话（GUI「拉起」按钮 ⇒ payload.forceResume）。
	 *
	 * ## 为什么 outbox 项要带这个标记
	 *
	 * B 通道判「目标死了 ⇒ 标 failed」，S2 判「目标死了 ⇒ 拉起它」。
	 * 协调口径（L4 审查 B3 的修法）：**只有「确证死亡」的目标**才由 B 放弃判死；
	 * 而「用户明确要求拉起」的消息**无论目标证据如何**都不该被判死
	 * —— 用户已经表达了意图，消息必须有机会送达。
	 *
	 * ⇒ B 扫到带本标记的 pending 项 ⇒ 跳过（不标 failed）⇒ 等 S2 拉起后送达。
	 *
	 * 这是**显式意图**通道，不放宽自动路径：普通消息（无本标记）行为完全不变。
	 */
	forceResume?: boolean;
	/** GUI 图片输入 S2：附件**绝对路径**列表（图不内联；桥在正文里给路径，agent 用 `read` 自取）。 */
	attachments?: string[];
	reason?: string;
	status: OutboxStatus;
	createdAt: string;
	updatedAt: string;
	deliveredAt?: string;
	failedAt?: string;
	/** failed 时的错误摘要（桥注入异常 message，≤512 字节）。 */
	error?: string;
	/** 注入方（桥 holder，`outbox-bridge:<sessionId>`）。 */
	deliveredBy?: string;
	/** expired 转终态时刻（TTL 扫描写）。 */
	expiredAt?: string;
	/** expired 执行方（`outbox-bridge:<sid>` 或 `runtime-host`）。 */
	expiredBy?: string;
}

// ── expired 扫描（G6-P2 L4 必修 2：pending 可恢复终态，不留永久孤儿）──

export interface SweepExpiredOutboxOptions {
	now?: Date;
	/** TTL（缺省 24h；测试注入更短）。 */
	ttlMs?: number;
	journalPath?: string;
	/** 执行方标识（expiredBy / journal source；桥传 holder，host 传缺省 `runtime-host`）。 */
	by?: string;
}

/**
 * 扫描 pending 超 TTL 的项 → expired + journal message.expired（safe wrapper，回执写失败
 * 不影响终态迁移）。返回本轮新转 expired 的项。调用方：桥每个消费 tick（目标会话侧）+
 * host 启动（server.ts，覆盖「目标会话永不重启」的孤儿面）。幂等：终态不可再迁移，重复扫
 * 零副作用；正文不进 journal（§15 同 queued/delivered）。
 */
export function sweepExpiredOutboxItems(dir: string, opts: SweepExpiredOutboxOptions = {}): OutboxItem[] {
	const ttlMs = opts.ttlMs ?? OUTBOX_PENDING_TTL_MS;
	const now = opts.now ?? new Date();
	const by = opts.by ?? "runtime-host";
	const expired: OutboxItem[] = [];
	for (const it of listOutboxItems(dir)) {
		if (it.status !== "pending") continue;
		const age = now.getTime() - Date.parse(it.createdAt);
		if (!Number.isFinite(age) || age <= ttlMs) continue;
		const marked = markOutboxItem(dir, it.id, { status: "expired", at: now.toISOString(), by });
		if (marked === null) continue; // 竞态：恰被并发迁移 → 让位
		expired.push(marked);
		try {
			const at = now.toISOString();
			appendRuntimeEnvelopeOnceSafe(
				newEventEnvelope({
					type: "message.expired",
					source: piSessionAddress(it.sessionId),
					subject: it.to,
					at,
					recordedAt: at,
					payload: { commandKey: it.commandKey, outboxId: it.id, sessionId: it.sessionId },
					dedupeKey: `message.expired:${it.id}`,
				}),
				opts.journalPath ?? defaultJournalPath(),
			);
		} catch {
			/* safe wrapper 自吞，双保险 */
		}
	}
	return expired;
}

/** outbox 目录：`<stateDir>/message-outbox`。 */
export function outboxDir(stateDir: string): string {
	return join(stateDir, "message-outbox");
}

// ── 目标会话死亡检测（B：静默卡死根治）───────────────────────
//
// 真机事故（2026-11-03）：3 条 GUI 消息卡在 pending 10 小时，界面只显示
// 「已提交等待注入」。目标会话（01a18af1）00:22 后进程就没了，但 outbox 没有任何
// 机制知道这件事—— `OUTBOX_PENDING_TTL_MS` 是 **24 小时**，而消费者
// （`registerOutboxBridge` 挂在 session_start）只在目标会话**启动时**注册。
//
// 两层失效叠加：目标死了 ⇒ 没人取；TTL 24h ⇒ 很久才扫。中间的 10 小时里，
// 用户看到的是「等待注入」，看不出任何异常。
//
// 修法：增加一条**快速路径**——目标会话确定已死 + 消息已等待超过宽限期
// （缺省 10 分钟，避开正常重启窗口）⇒ 直接标 failed，并带上可读原因。
// 界面上就能看到「目标会话已结束」而不是无限「等待中」。

/**
 * 目标会话死亡后，消息要等多久才判死（缺省 10 分钟）。
 *
 * 不能是 0：正常情况下用户重启会话需要时间（加载上下文、开新窗口），
 * 消息应该在重启后由新进程取走。10 分钟足够盖住一次正常重启，又远短于 24h TTL。
 */
export const OUTBOX_TARGET_DEAD_GRACE_MS = 10 * 60 * 1000;

/** 目标会话存活探针的抽象（便于测试注入；生产用 scope-liveness + 进程表）。 */
export interface TargetLivenessProbe {
	/** 三态：alive（确定活着）/ dead（确定死了）/ unknown（查不到，不判）。 */
	state: "alive" | "dead" | "unknown";
	/** 判定依据（可观测，便于排查）。 */
	basis: string;
}

/**
 * 扫描「目标会话已死」的 pending 项 → failed。
 *
 * 与 `sweepExpiredOutboxItems` 的分工：
 * - expired = 时间维度（24h 到了，无论目标死活）
 * - failed   = 因果维度（目标确实没了，消息永远送不到）
 *
 * 三条红线：
 * 1. **只动 pending**（终态不可迁移，幂等）。
 * 2. **不确定就不判**（`unknown` 一律跳过，绝不因探针失败冤枉活会话）。
 * 3. **有宽限期**（`graceMs`，缺省 10min），避开正常重启窗口。
 *
 * never-throw：探针异常 / 写盘失败均静默跳过，不阻断消费循环。
 */
export function sweepTargetDeadOutboxItems(
	dir: string,
	opts: {
		probe: (sessionId: string) => TargetLivenessProbe;
		graceMs?: number;
		now?: Date;
		by?: string;
		journalPath?: string;
		/**
		 * 【2026-11-04 新增】该目标会话是否**还能被拉起**（S2 语义）。
		 *
		 * ## 为什么需要这个钩子（B/S2 语义冲突）
		 *
		 * B 通道的语义是「目标确实没了 ⇒ 消息永远送不到 ⇒ 标 failed」；
		 * S2 的语义是「目标死了 ⇒ **拉起它** ⇒ 消息送得到」。
		 *
		 * 两者对**同一个事实**（目标已死）给出**相反**的处置。若不协调：
		 * ```
		 * t=0    用户发消息 → S2 拉起会话（消息将在新实例起来后被消费）
		 * t=10m  B 扫到这条 pending（过宽限期）→ 判目标死 → 标 failed ❌
		 * ```
		 * ⇒ 消息在送达前被标死，用户永远收不到。
		 *
		 * ## 判据口径
		 *
		 * 返回 true ⇒ 「这个会话**有可能**被拉起」⇒ B **不得**标 failed
		 * （宁可让消息多等，不可把还能送的消息判死 —— R-5 取舍方向）。
		 *
		 * 缺省 undefined ⇒ 视为「不能拉起」⇒ B 保持既有行为（零行为变化）。
		 */
		canRescue?: (sessionId: string) => boolean;
	} = {} as never,
): OutboxItem[] {
	const graceMs = opts.graceMs ?? OUTBOX_TARGET_DEAD_GRACE_MS;
	const now = opts.now ?? new Date();
	const by = opts.by ?? "runtime-host";
	const failed: OutboxItem[] = [];
	if (typeof opts.probe !== "function") return failed;

	// 同一目标会话只探一次（多个 pending 项常指向同一会话；探针含进程表查询，不便宜）
	const probeCache = new Map<string, TargetLivenessProbe>();

	for (const it of listOutboxItems(dir)) {
		if (it.status !== "pending") continue;
		const age = now.getTime() - Date.parse(it.createdAt);
		if (!Number.isFinite(age) || age <= graceMs) continue; // 宽限期内不动（可能是正常重启）

		let p = probeCache.get(it.sessionId);
		if (p === undefined) {
			try {
				p = opts.probe(it.sessionId);
			} catch {
				p = { state: "unknown", basis: "probe-threw" };
			}
			probeCache.set(it.sessionId, p);
		}
		// 只认「确定死了」；alive / unknown 一律跳过（不冤枉活会话）
		if (p.state !== "dead") continue;

		// 【2026-11-04 新增】S2 协调：目标虽判 dead，但**仍可能被拉起** ⇒ 不得标 failed。
		//
		// 冲突场景（真实）：用户发消息给死会话 ⇒ S2 拉起它 ⇒ 消息等新实例消费；
		// 过宽限期后 B 扫到这条 pending ⇒ 若标 failed ⇒ 消息在送达前被判死。
		//
		// 判据：`canRescue` 说「还能拉起」⇒ 跳过（宁可多等，不可误杀）。
		// 缺省（undefined）⇒ 跳过本检查 ⇒ 既有行为零变化。
		if (typeof opts.canRescue === "function") {
			let rescuable = false;
			try {
				rescuable = opts.canRescue(it.sessionId);
			} catch {
				rescuable = false; // 探针抛异常 ⇒ 不救（保守：按「不能拉起」处理）
			}
			if (rescuable) continue;
		}

		// 【2026-11-04 新增】用户**显式要求**拉起的消息 ⇒ 绝不判死。
		//
		// 与上面的 canRescue 是**两条不同的通道**：
		//   canRescue  = 「自动路径能不能救」（要求确证 dead）
		//   forceResume= 「用户已经明确要求拉起」（不需要证据，只需要意图）
		//
		// 后者覆盖 2026-11-03 之前的历史会话与**正常退出**的会话
		// （这两类没有 owner 记录 ⇒ 自动路径判 unknown ⇒ 救不了），
		// 而用户点「拉起」时消息带了标记 ⇒ 必须有机会送达。
		if (it.forceResume === true) continue;

		const reason = `目标会话已结束（${p.basis}），消息无法送达`;
		const marked = markOutboxItem(dir, it.id, {
			status: "failed",
			at: now.toISOString(),
			by,
			error: reason.slice(0, 512),
		});
		if (marked === null) continue; // 竞态：恰被并发迁移 → 让位
		failed.push(marked);
		try {
			const at = now.toISOString();
			appendRuntimeEnvelopeOnceSafe(
				newEventEnvelope({
					type: "message.failed",
					source: piSessionAddress(it.sessionId),
					subject: it.to,
					at,
					recordedAt: at,
					payload: {
						commandKey: it.commandKey,
						outboxId: it.id,
						sessionId: it.sessionId,
						reason: "target-session-dead",
						basis: p.basis,
					},
					dedupeKey: `message.failed:${it.id}`,
				}),
				opts.journalPath ?? defaultJournalPath(),
			);
		} catch {
			/* safe wrapper 自吞，双保险 */
		}
	}
	return failed;
}

/** item id = dedupeKey 的 SHA-256 hex（64 定长，跨平台文件名安全；同 commands/ 纪律）。 */
export function outboxItemId(dedupeKey: string): string {
	return createHash("sha256").update(dedupeKey, "utf8").digest("hex");
}

/** 结构校验（tolerant 读的守门员；坏文件永不炸读者）。 */
export function validateOutboxItem(x: unknown): x is OutboxItem {
	if (typeof x !== "object" || x === null) return false;
	const it = x as Record<string, unknown>;
	if (it.version !== 1 || it.type !== OUTBOX_COMMAND_TYPE) return false;
	if (typeof it.id !== "string" || it.id.length !== 64) return false;
	if (typeof it.dedupeKey !== "string" || it.dedupeKey.length === 0) return false;
	if (typeof it.commandKey !== "string" || it.commandKey.length === 0) return false;
	if (typeof it.to !== "string" || it.to !== piSessionAddress(String(it.sessionId ?? ""))) return false;
	if (typeof it.sessionId !== "string" || it.sessionId.length === 0) return false;
	if (typeof it.text !== "string") return false;
	if (!(OUTBOX_STATUSES as readonly string[]).includes(it.status as OutboxStatus)) return false;
	if (typeof it.createdAt !== "string" || typeof it.updatedAt !== "string") return false;
	return true;
}

/** 构造 pending 项（executor 第一段落盘前调用；字段非法立即抛错，executor 收敛 failed）。 */
export function newOutboxItem(input: {
	dedupeKey: string;
	commandKey: string;
	to: ObjectAddress;
	sessionId: string;
	text: string;
	attachments?: string[];
	reason?: string;
	/** 【2026-11-04 新增】用户显式要求拉起（GUI「拉起」按钮）⇒ B 不判死这条消息。 */
	forceResume?: boolean;
	now: Date;
}): OutboxItem {
	const id = outboxItemId(input.dedupeKey);
	const at = input.now.toISOString();
	const item: OutboxItem = {
		version: 1,
		id,
		dedupeKey: input.dedupeKey,
		commandKey: input.commandKey,
		type: OUTBOX_COMMAND_TYPE,
		to: piSessionAddress(input.sessionId),
		sessionId: input.sessionId,
		text: input.text,
		status: "pending",
		createdAt: at,
		updatedAt: at,
	};
	if (input.attachments !== undefined && input.attachments.length > 0) item.attachments = input.attachments;
	if (input.reason !== undefined) item.reason = input.reason;
	if (input.forceResume === true) item.forceResume = true;
	return item;
}

// ── 读（tolerant never-throw）────────────────────────────────────

function itemPath(dir: string, id: string): string {
	return join(dir, `${id}.json`);
}

/** 读单项；缺失/坏 JSON/结构非法/id 与文件名不符 → null。 */
export function readOutboxItem(dir: string, id: string): OutboxItem | null {
	try {
		const raw: unknown = JSON.parse(readFileSync(itemPath(dir, id), "utf8"));
		if (!validateOutboxItem(raw)) return null;
		if (raw.id !== id) return null; // 摘要碰撞兜底：item 内 id 必须与文件名一致
		return raw;
	} catch {
		return null;
	}
}

/** 枚举全部 item（坏文件跳过；createdAt 升序、同刻按 id 稳定排序）。never-throw。 */
export function listOutboxItems(dir: string): OutboxItem[] {
	let files: string[];
	try {
		files = readdirSync(dir);
	} catch {
		return [];
	}
	const out: OutboxItem[] = [];
	for (const f of files) {
		if (!f.endsWith(".json") || f.endsWith(".tmp")) continue;
		const id = f.slice(0, -".json".length);
		const it = readOutboxItem(dir, id);
		if (it !== null) out.push(it);
	}
	out.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
	return out;
}

// ── 写（executor 建项 / 桥状态回写；tmp+rename 原子）──────────────

/**
 * 写入/覆盖整项（executor 建项用；桥回写请用 markOutboxItem 走终态守卫）。
 * 原子写 tmp+rename（EPERM 重试同 command-executor 纪律）。
 */
export function writeOutboxItem(dir: string, item: OutboxItem): void {
	writeJsonAtomic(itemPath(dir, item.id), item);
}

/**
 * 状态迁移（封闭：pending → delivered|failed；终态不可再迁移）。
 * 返回迁移后的项；项缺失 / 结构非法 / 非法迁移 / 终态重复回写 → null（桥跳过）。
 */
export function markOutboxItem(
	dir: string,
	id: string,
	patch: { status: "delivered" | "failed" | "expired"; at: string; by?: string; error?: string },
): OutboxItem | null {
	const cur = readOutboxItem(dir, id);
	if (cur === null) return null;
	if (cur.status !== "pending") return null; // 终态不可再迁移（重复回写/竞态双写防御）
	const next: OutboxItem = { ...cur, status: patch.status, updatedAt: patch.at };
	if (patch.status === "delivered") {
		next.deliveredAt = patch.at;
		next.deliveredBy = patch.by;
	} else if (patch.status === "failed") {
		next.failedAt = patch.at;
		next.error = patch.error;
	} else {
		next.expiredAt = patch.at;
		next.expiredBy = patch.by;
	}
	try {
		writeJsonAtomic(itemPath(dir, id), next);
	} catch {
		return null;
	}
	return next;
}

// ── 原子写（同 command-executor.writeJsonAtomic 模式；不反向 import 防环）──

function writeJsonAtomic(path: string, value: unknown): void {
	const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	renameWithEpermRetry(tmp, path);
}

/** tmp+rename + EPERM×3 重试（10ms backoff；Windows 并发 reader 短暂持句柄）。 */
function renameWithEpermRetry(tmp: string, target: string): void {
	const EPERM_RETRIES = 3;
	const EPERM_BACKOFF_MS = 10;
	for (let attempt = 0; ; attempt++) {
		try {
			renameSync(tmp, target);
			return;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "EPERM" && attempt < EPERM_RETRIES) {
				sleepSync(EPERM_BACKOFF_MS);
				continue;
			}
			try {
				unlinkSync(tmp);
			} catch {
				/* ignore */
			}
			throw e;
		}
	}
}

function sleepSync(ms: number): void {
	try {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
	} catch {
		/* 极端宿主不支持时退化为忙等一步 */
	}
}
