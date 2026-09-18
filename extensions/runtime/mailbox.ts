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
 *
 * 命名不变量（F7，附记 A4）：spool 文件名恒等于 messageId（frame.id）——ack 按
 * messageId 可达（terra 缺陷 #1）。dedupeId 只走原子 claim slot
 * （claims/mailbox-<dedupeId>.json → {messageId}，open wx 排他创建），不进文件名：
 * 跨进程确定性场景（如双 watcher 观察同一 run）传 opts.dedupeId，输家读赢家映射
 * 直接返回既存信；赢家若在 claim→落盘窗口崩溃，输家替补写（at-least-once）。
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

	// F7：dedupeId 经原子 claim slot 映射到唯一的 messageId（跨进程原子，缺陷 #2）
	if (opts.dedupeId) {
		const slot = claimDedupeSlot(opts.dedupeId, messageId);
		if (!slot.won) return readOrAdoptWinnerLetter(dir, slot.messageId, frame, opts.expiresAt);
	}

	const path = join(dir, `${messageId}.json`);
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

// ── F7 原子 dedupe slot（附记 A4，terra 缺陷 #1/#2）────────────────

/**
 * 原子领取 dedupeId → messageId 映射槽（claims/mailbox-<id>.json，wx 排他创建）。
 * 赢家拿走写权；输家拿到赢家的 messageId 去读既存信。slot 与 journal claims 同目录族。
 */
function claimDedupeSlot(dedupeId: string, messageId: string): { won: boolean; messageId: string } {
	const dir = join(defaultRuntimeDir(), "claims");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `mailbox-${dedupeId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
	try {
		writeFileSync(path, JSON.stringify({ messageId }), { flag: "wx", encoding: "utf8" });
		return { won: true, messageId };
	} catch {
		// slot 已被占：读赢家映射（读坏属极罕见 IO 损坏，抛给 safe wrapper 吞掉）
		const winner = (JSON.parse(readFileSync(path, "utf8")) as { messageId: string }).messageId;
		if (typeof winner !== "string" || winner.length === 0) throw new Error("claimDedupeSlot: slot unreadable");
		return { won: false, messageId: winner };
	}
}

/**
 * 输家路径：读赢家的信；赢家若在 claim→落盘窗口崩溃（信文件尚不存在），
 * 用赢家的 messageId 替补写（frame.id 领养赢家 id，命名不变量保持）。
 */
function readOrAdoptWinnerLetter(
	dir: string,
	winnerMessageId: string,
	frame: Deliverable,
	expiresAt: string | undefined,
): { letter: Letter; created: boolean } {
	const path = join(dir, `${winnerMessageId}.json`);
	try {
		return { letter: JSON.parse(readFileSync(path, "utf8")) as Letter, created: false };
	} catch {
		const adopted: Deliverable = frame.frame === "message"
			? { ...frame, id: winnerMessageId as EnvelopeId }
			: frame;
		const letter: Letter = { frame: adopted, status: "pending", expiresAt };
		writeJsonAtomic(path, letter);
		return { letter, created: false };
	}
}

/** 按 frame.id 扫描定位信件文件（F7 前旧信件兼容，缺陷 #1 可达性）。 */
function findLetterFileByFrameId(dir: string, frameId: string): string | null {
	if (!existsSync(dir)) return null;
	for (const f of readdirSync(dir)) {
		if (!f.endsWith(".json")) continue;
		try {
			const letter = JSON.parse(readFileSync(join(dir, f), "utf8")) as Letter;
			if (letter.frame?.frame === "message" && letter.frame.id === frameId) return join(dir, f);
		} catch {
		continue;
		}
	}
	return null;
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
	/** 只领取这些 messageId（4d 消费端定向领取；与 limit 叠加） */
	ids?: string[];
}

/** 领取一个 logical recipient 的可处理信件（pending + stale claimed），置为 claimed。 */
export function claimLetters(recipient: ObjectAddress, opts: ClaimOptions): Letter[] {
	const dir = mailboxDirFor(recipient, opts.mailboxDir);
	if (!existsSync(dir)) return [];
	const reclaimAfterMs = opts.reclaimAfterMs ?? 10 * 60 * 1000;
	const now = Date.now();

	const names = opts.ids
		? opts.ids.map((id) => `${id}.json`)
		: readdirSync(dir).filter((f) => f.endsWith(".json"));

	// ids 定向领取兼容旧命名信件（F7 前 dedupe 命名）：直接文件缺失则按 frame.id 扫描
	const resolvedNames: string[] = [];
	for (const f of names) {
		if (existsSync(join(dir, f))) {
			resolvedNames.push(f);
			continue;
		}
		if (opts.ids) {
			const found = findLetterFileByFrameId(dir, f.slice(0, -".json".length));
			if (found) resolvedNames.push(found.split(/[\\/]/).pop()!);
		}
	}

	const claimable: { path: string; letter: Letter }[] = [];
	for (const f of resolvedNames) {
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

/**
 * 按 holder 批量 ack（wake 确认专用：claim 时 holder=`wake:<sid>:<ws>`，
 * 确认时同 holder 全收，无需逐文件名——command 信无 frame.id 也可收尾）。
 * 返回 ack 数量。
 */
export function ackClaimedBy(recipient: ObjectAddress, claimedBy: string, mailboxDir: string = defaultMailboxDir()): number {
	const dir = mailboxDirFor(recipient, mailboxDir);
	if (!existsSync(dir)) return 0;
	let n = 0;
	for (const f of readdirSync(dir)) {
		if (!f.endsWith(".json")) continue;
		const path = join(dir, f);
		try {
			const letter = JSON.parse(readFileSync(path, "utf8")) as Letter;
			if (letter.status === "claimed" && letter.claimedBy === claimedBy) {
				writeJsonAtomic(path, { ...letter, status: "acked", ackedAt: new Date().toISOString() });
				n += 1;
			}
		} catch {
			continue;
		}
	}
	return n;
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
	let path = join(dir, `${messageId}.json`);
	if (!existsSync(path)) {
		// 兼容 F7 前的 dedupe 命名旧信件：按 frame.id 扫描定位（缺陷 #1 可达性）
		const found = findLetterFileByFrameId(dir, messageId);
		if (!found) return null;
		path = found;
	}
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

/** 原子写：唯一 tmp + rename（固定 .tmp 名跨进程互覆盖，缺陷 #2 下半）。 */
function writeJsonAtomic(path: string, value: unknown): void {
	const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}

/** FabricFrame 类型仅用于文档化导出约束（防止未来误传非协议帧）。 */
export type { FabricFrame };
