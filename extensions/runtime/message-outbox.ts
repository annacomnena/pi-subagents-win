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
import { appendRuntimeEnvelopeSafe, defaultJournalPath } from "./journal.ts";

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
	/** 消息正文（1..8000 UTF-8 字节；校验在 executor payload 白名单）。 */
	text: string;
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
			appendRuntimeEnvelopeSafe(
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
	reason?: string;
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
	if (input.reason !== undefined) item.reason = input.reason;
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
