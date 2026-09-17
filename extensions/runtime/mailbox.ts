/**
 * runtime/mailbox.ts — Mailbox spool（Phase 3，设计稿 §27-28）
 *
 * 布局：
 *   ~/.pi/agent/runtime/mailbox/<recipient-sanitized>/<messageId>.json   → Letter
 *
 * 投递语义（§27 冻结）：
 *   - at-least-once + consumer idempotency，**不追求 exactly-once**；
 *   - 生产端防重：同 messageId 重复 deliver 幂等 no-op；
 *   - 状态机：pending → claimed → (delivered) → acked；非终态且过 TTL → expired；
 *   - stale reclaim：claimed 超过 reclaimAfterMs 未 ack 可被重新领取（崩溃恢复，
 *     at-least-once 的必要部分——消费端必须按 messageId 幂等处理）；
 *   - 跨进程竞态声明：claim 改写存在竞态窗口，由 consumer idempotency 兜底
 *     （§27 明确接受；v1 不做分布式锁）。
 *
 * 本模块只服务 Message/Command 帧（protocol.ts）；Event 走 journal.ts，不混用。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultRuntimeDir } from "./journal.ts";
import { isObjectAddress, type ObjectAddress } from "./address.ts";
import {
	newEnvelopeId,
	type EnvelopeId,
} from "./ids.ts";
import type {
	CommandFrame,
	DeliveryStatus,
	FabricFrame,
	MessageFrame,
} from "./protocol.ts";
import { validateCommandFrame, validateMessageFrame, type Letter } from "./protocol.ts";

// ── 路径 ───────────────────────────────────────────────────────────

export function defaultMailboxDir(): string {
	return join(defaultRuntimeDir(), "mailbox");
}

/** recipient 地址 → spool 子目录名（agent://master_default → agent__master_default）。 */
export function mailboxDirFor(recipient: ObjectAddress, mailboxDir: string = defaultMailboxDir()): string {
	return join(mailboxDir, recipient.replace(/[^A-Za-z0-9._-]/g, "_"));
}

// ── deliver（生产端）───────────────────────────────────────────────

export type Deliverable = MessageFrame | CommandFrame;

export function newMessageId(now: Date = new Date()): EnvelopeId {
	return newEnvelopeId("msg", now);
}

/**
 * 投递一帧到目标 logical recipient 的 spool（status=pending）。
 * 幂等屏障 = spool 文件名：默认用 messageId（生产端防重），跨进程确定性场景
 * （如双 watcher 观察同一 run）传 opts.dedupeId（如 `run-<runId>-completed`）——
 * 同 dedupeId 已存在即 no-op（返回既存 letter），不同进程不约而同投递也只落一封。
 */
export function deliverLetter(
	frame: Deliverable,
	opts: { mailboxDir?: string; expiresAt?: string; dedupeId?: string } = {},
): { letter: Letter; created: boolean } {
	const mailboxDir = opts.mailboxDir ?? defaultMailboxDir();
	if (frame.frame === "message" && !validateMessageFrame(frame)) {
		throw new Error("deliverLetter: invalid message frame");
	}
	if (frame.frame === "command" && !validateCommandFrame(frame)) {
		throw new Error("deliverLetter: invalid command frame");
	}
	const recipient = frame.to;
	if (!isObjectAddress(recipient)) throw new Error("deliverLetter: frame.to is not an ObjectAddress");

	const dir = mailboxDirFor(recipient, mailboxDir);
	mkdirSync(dir, { recursive: true });

	const messageId = frame.frame === "message" ? frame.id : newMessageId();
	const fileName = (opts.dedupeId ?? messageId).replace(/[^A-Za-z0-9._-]/g, "_");
	const path = join(dir, `${fileName}.json`);
	if (existsSync(path)) {
		return { letter: JSON.parse(readFileSync(path, "utf8")) as Letter, created: false };
	}

	const letter: Letter = { frame, status: "pending", expiresAt: opts.expiresAt };
	writeJsonAtomic(path, letter);
	return { letter, created: true };
}

/**
 * 安全投递（event-bus 接线专用，同 emitRuntimeEventOnce 的 safe 纪律）：
 * 任何失败不影响 caller——mailbox 是影子通道，投递失败只返回 false。
 */
export function deliverLetterSafe(frame: Deliverable, opts: { mailboxDir?: string; expiresAt?: string; dedupeId?: string } = {}): boolean {
	try {
		deliverLetter(frame, opts);
		return true;
	} catch {
		return false;
	}
}

/** Command 投递便捷入口（messageId 由 spool 分配）。 */
export function deliverCommand(frame: CommandFrame, opts: { mailboxDir?: string; expiresAt?: string } = {}): { letter: Letter; created: boolean } {
	return deliverLetter(frame, opts);
}

// ── claim / deliver / ack（消费端）────────────────────────────────

export interface ClaimOptions {
	mailboxDir?: string;
	/** claim 者身份（通常 agent://… 或 session 标签） */
	claimedBy: string;
	/** claimed 超过该时长未 ack 视为 stale，可重新领取（缺省 10min） */
	reclaimAfterMs?: number;
	/** 单次最多领取数（缺省全部 pending+stale） */
	limit?: number;
}

/** 领取一个 logical recipient 的可处理信件（pending + stale claimed），置为 claimed。 */
export function claimLetters(recipient: ObjectAddress, opts: ClaimOptions): Letter[] {
	const dir = mailboxDirFor(recipient, opts.mailboxDir);
	if (!existsSync(dir)) return [];
	const reclaimAfterMs = opts.reclaimAfterMs ?? 10 * 60 * 1000;
	const now = Date.now();

	const claimable: { path: string; letter: Letter }[] = [];
	for (const f of readdirSync(dir)) {
		if (!f.endsWith(".json")) continue;
		const path = join(dir, f);
		let letter: Letter;
		try {
			letter = JSON.parse(readFileSync(path, "utf8")) as Letter;
		} catch {
			continue; // tolerant：半截文件跳过
		}
		if (letter.status === "pending") {
			claimable.push({ path, letter });
		} else if (letter.status === "claimed" && letter.claimedAt) {
			const age = now - Date.parse(letter.claimedAt);
			if (Number.isFinite(age) && age > reclaimAfterMs) {
				claimable.push({ path, letter }); // stale reclaim（at-least-once）
			}
		}
	}

	claimable.sort((a, b) => frameTime(a.letter).localeCompare(frameTime(b.letter)));
	const taken = opts.limit ? claimable.slice(0, opts.limit) : claimable;
	const out: Letter[] = [];
	for (const { path, letter } of taken) {
		const updated: Letter = { ...letter, status: "claimed", claimedBy: opts.claimedBy, claimedAt: new Date().toISOString() };
		writeJsonAtomic(path, updated);
		out.push(updated);
	}
	return out;
}

/** 消费端标记已投递进处理管线（可选步骤：claimed → delivered）。 */
export function markDelivered(recipient: ObjectAddress, messageId: string, opts: { mailboxDir?: string } = {}): Letter | null {
	return mutateLetter(recipient, messageId, opts, (l) =>
		l.status === "claimed" ? { ...l, status: "delivered" } : null);
}

/** 确认处理完成（终态：acked）。 */
export function ackLetter(recipient: ObjectAddress, messageId: string, opts: { mailboxDir?: string } = {}): Letter | null {
	return mutateLetter(recipient, messageId, opts, (l) =>
		l.status === "claimed" || l.status === "delivered" ? { ...l, status: "acked", ackedAt: new Date().toISOString() } : null);
}

// ── 过期（惰性扫描）───────────────────────────────────────────────

/** 把超过 expiresAt 的非终态信件置为 expired。返回过期数量。 */
export function expireSweep(recipient?: ObjectAddress, opts: { mailboxDir?: string } = {}): number {
	const mailboxDir = opts.mailboxDir ?? defaultMailboxDir();
	const dirs = recipient ? [mailboxDirFor(recipient, mailboxDir)] : listRecipientDirs(mailboxDir);
	const now = Date.now();
	let n = 0;
	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		for (const f of readdirSync(dir)) {
			if (!f.endsWith(".json")) continue;
			const path = join(dir, f);
			try {
				const letter = JSON.parse(readFileSync(path, "utf8")) as Letter;
				if (letter.status === "acked" || letter.status === "expired") continue;
				if (!letter.expiresAt) continue;
				const exp = Date.parse(letter.expiresAt);
				if (Number.isFinite(exp) && exp <= now) {
					writeJsonAtomic(path, { ...letter, status: "expired" });
					n += 1;
				}
			} catch {
				continue;
			}
		}
	}
	return n;
}

// ── 查询 ───────────────────────────────────────────────────────────

export function listLetters(
	recipient: ObjectAddress,
	status?: DeliveryStatus,
	mailboxDir: string = defaultMailboxDir(),
): Letter[] {
	const dir = mailboxDirFor(recipient, mailboxDir);
	if (!existsSync(dir)) return [];
	const out: Letter[] = [];
	for (const f of readdirSync(dir)) {
		if (!f.endsWith(".json")) continue;
		try {
			const letter = JSON.parse(readFileSync(join(dir, f), "utf8")) as Letter;
			if (!status || letter.status === status) out.push(letter);
		} catch {
			continue;
		}
	}
	return out.sort((a, b) => frameTime(a).localeCompare(frameTime(b)));
}

/** 全部 recipient 的未 ack 计数（GUI Attention/§35.4 Runtime 投影的消费入口之一）。 */
export function mailboxBacklog(mailboxDir: string = defaultMailboxDir()): { recipient: string; pending: number; claimed: number }[] {
	const out: { recipient: string; pending: number; claimed: number }[] = [];
	for (const dir of listRecipientDirs(mailboxDir)) {
		const letters = listLettersSynthetic(dir);
		const pending = letters.filter((l) => l.status === "pending").length;
		const claimed = letters.filter((l) => l.status === "claimed").length;
		out.push({ recipient: dir.split(/[\\/]/).pop()!, pending, claimed });
	}
	return out;
}

// ── 内部 ───────────────────────────────────────────────────────────

function frameTime(l: Letter): string {
	if (l.frame.frame === "message") return l.frame.sentAt;
	return l.frame.issuedAt;
}

function listRecipientDirs(mailboxDir: string): string[] {
	if (!existsSync(mailboxDir)) return [];
	return readdirSync(mailboxDir, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => join(mailboxDir, d.name));
}

function listLettersSynthetic(dir: string): Letter[] {
	const out: Letter[] = [];
	for (const f of readdirSync(dir)) {
		if (!f.endsWith(".json")) continue;
		try {
			out.push(JSON.parse(readFileSync(join(dir, f), "utf8")) as Letter);
		} catch {
			continue;
		}
	}
	return out;
}

function mutateLetter(
	recipient: ObjectAddress,
	messageId: string,
	opts: { mailboxDir?: string },
	mutate: (l: Letter) => Letter | null,
): Letter | null {
	const dir = mailboxDirFor(recipient, opts.mailboxDir);
	const path = join(dir, `${messageId}.json`);
	if (!existsSync(path)) return null;
	let letter: Letter;
	try {
		letter = JSON.parse(readFileSync(path, "utf8")) as Letter;
	} catch {
		return null;
	}
	const updated = mutate(letter);
	if (!updated) return null;
	writeJsonAtomic(path, updated);
	return updated;
}

/** 原子写：tmp + rename（同 state-store 纪律）。 */
function writeJsonAtomic(path: string, value: unknown): void {
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}

/** FabricFrame 类型仅用于文档化导出约束（防止未来误传非协议帧）。 */
export type { FabricFrame };
