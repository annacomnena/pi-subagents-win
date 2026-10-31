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

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
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
import { declareExpectationSafe, type ExpectReplyOptions } from "./expectations.ts";

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

/** deliverLetter 投递选项（0928 P2 加法：⑧ 请求—回执期望声明）。 */
export interface DeliverOptions {
	mailboxDir?: string;
	expiresAt?: string;
	/** 跨进程确定性防重键（F7 claim slot）。 */
	dedupeId?: string;
	/**
	 * ⑧ 期望声明（0928 P2）：`undefined` = 按谓词自动声明（message ∧ requiresAck ∧ !inReplyTo ∧
	 * from!==to ∧ 落盘成功）；`false` = 显式关；对象 = 覆盖 deadlineAt/expectedType/project。
	 * 声明 never-throw，绝不影响投递。
	 */
	expectReply?: false | ExpectReplyOptions;
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
	opts: DeliverOptions = {},
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
	// ⑧ 声明生产者（0928 P2）：**投递成功点**声明「我在等什么回信」。
	// 为什么是这里：全仓生产投递只经本函数 → 单一咽喉点使所有真实请求自动入账；
	// 「派发失败」在本函数里就是抛错/未落盘 → 天然不生成虚假等待；dedupe 输家/已存在
	//（created=false 路径）根本到不了这里 → first-wins 无第二行。
	// never-throw：declareExpectationSafe 内部吞掉一切异常，账本 IO 拖不垮投递。
	if (frame.frame === "message") {
		declareExpectationSafe({ frame, expectReply: opts.expectReply, mailboxDir });
	}
	return { letter, created: true };
}

/**
 * 安全投递（event-bus 接线专用，同 emitRuntimeEventOnce 的 safe 纪律）：
 * 任何失败不影响 caller——mailbox 是影子通道，投递失败只返回 false。
 */
export function deliverLetterSafe(frame: Deliverable, opts: DeliverOptions = {}): boolean {
	try {
		deliverLetter(frame, opts);
		return true;
	} catch {
		return false;
	}
}

/** Command 投递便捷入口（messageId 由 spool 分配）。 */
export function deliverCommand(frame: CommandFrame, opts: DeliverOptions = {}): { letter: Letter; created: boolean } {
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
 * 释放一封已 claimed 的信（L3 忙时冲突静默重试）：claimed → pending，供下 tick 重新领取并重试。
 *
 * sendUserMessage 被 busy 拒绝（agent 忙，消息**未真正注入**）时，调用方**不得** ack/confirm
 * （未投递，不得伪造终态）；应把信退回 pending 供下 tick 重试（at-least-once：最坏重投一条，
 * 目标端按稳定 messageId 幂等去重）。
 *
 * 安全：仅当当前持有者匹配（claimedBy）才释放，避免误放已被他人 stale 接管（claimedBy 已变）
 * 的信；状态/持有者不匹配时静默 no-op（返回 null）。
 */
export function releaseClaimed(
	recipient: ObjectAddress,
	messageId: string,
	claimedBy: string,
	opts: { mailboxDir?: string } = {},
): Letter | null {
	return mutateLetter(recipient, messageId, opts, (l) =>
		l.status === "claimed" && l.claimedBy === claimedBy
			? { ...l, status: "pending", claimedAt: undefined, claimedBy: undefined }
			: null);
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

/**
 * 信件解析缓存（L2 perf，2026-10-20）。
 *
 * 动因（实测）：`/v1/health` 每 2s、`/v1/snapshot` 每 6s 都会全量扫信箱（本机 189 封未清理信件），
 * 每封 = readdir + readFileSync + JSON.parse；`/v1/health` 单拍 20ms 里大头就是它。
 * 命中条件 = `(mtimeMs, ctimeMs, size)`：`writeJsonAtomic` 走 tmp+rename ⇒ **rename 必改 ctime**，
 * 状态迁移（pending→claimed→acked）一定失效；无 TTL ⇒ 无陈旧窗口。
 * 上限 2000 封（本机 189，10× 余量），超限整体清空（不引 LRU 依赖）。
 */
const LETTER_CACHE = new Map<string, { stamp: string; letter: Letter }>();
const LETTER_CACHE_MAX = 2000;

/** 读一封并解析（带身份缓存）；不存在/读失败/坏 JSON → null（与各调用方 skip 语义一致）。 */
function readLetterCached(path: string): Letter | null {
	let stamp: string;
	try {
		const st = statSync(path);
		stamp = `${st.mtimeMs}|${st.ctimeMs}|${st.size}`;
	} catch {
		return null;
	}
	const hit = LETTER_CACHE.get(path);
	if (hit !== undefined && hit.stamp === stamp) return hit.letter;
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	const letter = parsed as Letter;
	if (LETTER_CACHE.size >= LETTER_CACHE_MAX) LETTER_CACHE.clear();
	LETTER_CACHE.set(path, { stamp, letter });
	return letter;
}

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
		const letter = readLetterCached(join(dir, f));
		if (letter === null) continue;
		if (!status || letter.status === status) out.push(letter);
	}
	return out.sort((a, b) => frameTime(a).localeCompare(frameTime(b)));
}

/**
 * L2 perf（2026-10-20）：**一次**扫描全部 spool，返回 目录名 → 信件数组（坏信跳过，never-throw）。
 *
 * 动因（实测）：`/v1/snapshot` 一拍内三个消费方各扫一遍全信箱（master 段 `getMasterStatus()`、
 * workstreams/runtime 的 `mailboxBacklog`、attention 的 `pushMailbox`）——本机 189 封未清理信件
 * ⇒ 单拍 ~567 次小文件读（readFileSync 计数探针实测）。共享一次扫描即可，语义不变。
 */
export function scanMailboxLetters(mailboxDir: string = defaultMailboxDir()): Map<string, Letter[]> {
	const out = new Map<string, Letter[]>();
	for (const dir of listRecipientDirs(mailboxDir)) {
		out.set(basename(dir), listLettersSynthetic(dir));
	}
	return out;
}

/** 由共享扫描派生 backlog 行（与 `mailboxBacklog` 逐字段等价：spool 目录名 + pending/claimed 计数）。 */
export function backlogFromScan(scan: Map<string, Letter[]>): { recipient: string; pending: number; claimed: number }[] {
	const out: { recipient: string; pending: number; claimed: number }[] = [];
	for (const [recipient, letters] of scan) {
		out.push({
			recipient,
			pending: letters.filter((l) => l.status === "pending").length,
			claimed: letters.filter((l) => l.status === "claimed").length,
		});
	}
	return out;
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
		// 排除内部目录（2026-10-31）：`_archive-YYYY-MM/`（终态信件归档）与
		// `_stale-*`（历史遗留标记目）。不收的话归档目录会被当成「另一个收件人」
		// 参与 backlog 统计与扫描 —— 归档就失去了降成本的意义。
		.filter((d) => !d.name.startsWith("_"))
		.map((d) => join(mailboxDir, d.name));
}

function listLettersSynthetic(dir: string): Letter[] {
	const out: Letter[] = [];
	for (const f of readdirSync(dir)) {
		if (!f.endsWith(".json")) continue;
		const letter = readLetterCached(join(dir, f));
		if (letter !== null) out.push(letter);
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

// ── 终态信件归档（2026-10-31）─────────────────────────────────────
//
// 问题（真机实测）：`<recipient>/` 目录**永不清理**。`ackLetter` 只把 status 改成
// `acked`，文件留在原地。实测 `agent___master_default` 目录 164 项，其中 **162 封
// 已 ack**（最早 2026-09-17，垮了 1.5 个月）、只有 1 封 pending。
//
// 代价不是磁盘（单封信 <1KB），而是**每拍的扫描成本**：`mailboxBacklog` /
// `scanMailboxLetters` 要 readdir + 逐封 stat（缓存失效时还 + readFile）。
// 这与 `audit.jsonl` 涨到 30MB 是同一类缺陷，修法也照 `rotateAuditIfNeeded` 的范式：
// **归档而不删除**，保留全部审计能力。
//
// 与 `expireSweep` 的分工：
//   - `expireSweep` 管**非终态且过了 TTL** → 置 `expired`（仍是活文件，仍需参与扫描）
//   - 本函数管**已终态**（`acked` / `expired`）的超龄文件 → 移出扫描路径
//
// 红线：
//   ① 只动 `acked` / `expired`。`pending` / `claimed` / `delivered` **一律不动**
//      （`claimed` 可能是另一个消费者正在处理，移走 = 丢信）。
//   ② 未到保留期的终态信也不动（保留短期可回查窗口）。
//   ③ never-throw：任何异常都当“本次未归档”，绝不影响正常的信件读写。

/** 终态信件保留天数（缺省 7 天）。超过则归档到 `<recipient>/_archive-<YYYYMM>/`。 */
export const MAILBOX_ARCHIVE_AFTER_DAYS = 7;

/** 终态判定：只有这两个状态可以归档。 */
function isArchivableStatus(s: string): boolean {
	return s === "acked" || s === "expired";
}

/**
 * 把超龄的**终态**信件归档到 `<recipient>/_archive-<YYYY-MM>/`。
 *
 * 为什么按月分目录而不是单个大文件：一封信一个 JSON 文件，合并成 jsonl 需要重写码
 * （且丢失与现有工具链的兼容）；按月归档 **不改变单个文件的形状**，
 * `readLetterCached` / 任何直接 read 某个 messageId 的调用仍可工作。
 *
 * @returns 归档的文件数（0 = 无需动作或失败）
 */
export function archiveTerminalLetters(opts: {
	mailboxDir?: string;
	/** 只处理这一个收件人（缺省 = 全部收件人）。 */
	recipient?: ObjectAddress;
	/** 保留天数（缺省 `MAILBOX_ARCHIVE_AFTER_DAYS`）。 */
	afterDays?: number;
	now?: number;
} = {}): number {
	try {
		const mailboxDir = opts.mailboxDir ?? defaultMailboxDir();
		const days = opts.afterDays ?? MAILBOX_ARCHIVE_AFTER_DAYS;
		if (!Number.isFinite(days) || days <= 0) return 0;
		const now = opts.now ?? Date.now();
		const cutoff = now - days * 24 * 60 * 60 * 1000;
		const dirs = opts.recipient
			? [mailboxDirFor(opts.recipient, mailboxDir)]
			: listRecipientDirs(mailboxDir);
		let moved = 0;
		for (const dir of dirs) {
			if (!existsSync(dir)) continue;
			for (const f of readdirSync(dir)) {
				if (!f.endsWith(".json")) continue;
				const path = join(dir, f);
				let letter: Letter;
				try {
					letter = JSON.parse(readFileSync(path, "utf8")) as Letter;
				} catch {
					continue; // 坏 JSON / 并发删除 ⇒ 跳过（不猜）
				}
				if (!isArchivableStatus(letter.status)) continue; // 红线①
				// 时间基准：优先 ackedAt（终态发生时刻），否则文件 mtime。
				// 为什么不用 frame.sentAt：一封很早发的信可能刚被 ack，拿 sentAt 会立即归档，
				// 把“刚处理完还能回查”的窗口砍成 0。
				const tsRaw = letter.ackedAt ?? null;
				const ts = tsRaw !== null && Number.isFinite(Date.parse(tsRaw)) ? Date.parse(tsRaw) : null;
				let basis = ts;
				if (basis === null) {
					try {
						basis = statSync(path).mtimeMs;
					} catch {
						continue;
					}
				}
				if (basis > cutoff) continue; // 红线②
				const yyyymm = new Date(basis).toISOString().slice(0, 7); // YYYY-MM
				const archiveDir = join(dir, `_archive-${yyyymm}`);
				try {
					mkdirSync(archiveDir, { recursive: true });
					renameSync(path, join(archiveDir, f));
					LETTER_CACHE.delete(path); // 缓存同步（否则归档后在缓存里仍可见）
					moved += 1;
				} catch {
					continue; // 跨盘/权限/同名冲突 ⇒ 这一封不动
				}
			}
		}
		return moved;
	} catch {
		return 0; // never-throw（红线③）
	}
}

/** FabricFrame 类型仅用于文档化导出约束（防止未来误传非协议帧）。 */
export type { FabricFrame };
