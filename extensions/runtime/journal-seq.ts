/**
 * runtime/journal-seq.ts — G6-P1 C1：journal 物理序号（seq）+ 文件代际指纹（logEpoch）纯库
 * （plans/0920_g6_webconsole_plan.md §1 拍板①：零迁移方案）。
 *
 * 语义（照 plan 冻结）：
 *   - `seq` = journal 物理行号（1-based，追加序天然单调；旧文件免改写）。坏行/空行**消耗**
 *     行号但不产出 envelope —— seq 单调、可留空洞，只保证「后写的 seq 更大」。
 *   - `logEpoch` = journal 首 envelope id（文件代际指纹）：journal 重建/截断 → 首条变化 →
 *     指纹变 → 订阅端判「跨代」走 snapshot resync，杜绝错位重放。
 *
 * 两个读法：
 *   - `scanJournalSeq`：全量扫（subscribe/续传补发用——journal 本身就是重放源，无有界缓冲）。
 *   - `readJournalTail`：cursor（字节偏移 + 下一行号）增量尾读（WS live 推送 tick 用）。
 *
 * 红线：只读、tolerant（坏行跳过计数，绝不改写文件）、never-throw（IO 失败落兜底返回值）。
 * §22：journal 仍是磁盘真相，本层只投影不持有。
 */

import { readFileSync, statSync } from "node:fs";
import { validateEnvelope, type RuntimeEnvelope } from "./envelope.ts";

// ── 全量扫（subscribe / 续传补发）──────────────────────────────────

export interface JournalSeqEntry {
	/** 物理行号（1-based，含坏行/空行的消耗；只保证单调不保证连续）。 */
	seq: number;
	envelope: RuntimeEnvelope;
}

export interface JournalScanResult {
	/** 文件不可读（缺失/权限）→ false，其余字段兜底。 */
	exists: boolean;
	/** 首 envelope id；无文件/空 journal/全坏行 → ""。 */
	logEpoch: string;
	/** 最后一条有效 envelope 的 seq（空 → 0）。 */
	head: number;
	entries: JournalSeqEntry[];
	skippedBadLines: number;
	/** 扫描时文件字节数（订阅方据此落 tail cursor 到 EOF）。 */
	sizeBytes: number;
}

export function scanJournalSeq(path: string): JournalScanResult {
	let buf: Buffer;
	try {
		buf = readFileSync(path);
	} catch {
		return { exists: false, logEpoch: "", head: 0, entries: [], skippedBadLines: 0, sizeBytes: 0 };
	}
	const entries: JournalSeqEntry[] = [];
	let skippedBadLines = 0;
	let logEpoch = "";
	let lineNo = 1;
	let pos = 0;
	while (pos < buf.length) {
		let nl = pos;
		while (nl < buf.length && buf[nl] !== 0x0a) nl += 1;
		const line = buf.subarray(pos, nl).toString("utf8").trim();
		pos = nl + 1;
		if (line.length > 0) {
			try {
				const parsed: unknown = JSON.parse(line);
				if (validateEnvelope(parsed).length === 0) {
					const env = parsed as RuntimeEnvelope;
					if (logEpoch === "") logEpoch = env.id;
					entries.push({ seq: lineNo, envelope: env });
				} else {
					skippedBadLines += 1;
				}
			} catch {
				skippedBadLines += 1;
			}
		}
		lineNo += 1;
	}
	const head = entries.length > 0 ? entries[entries.length - 1].seq : 0;
	return { exists: true, logEpoch, head, entries, skippedBadLines, sizeBytes: buf.length };
}

// ── 增量尾读（WS live tick）───────────────────────────────────────

export interface JournalSeqCursor {
	/** 已消费到的字节偏移（只推进到最后一个完整 \n）。 */
	offset: number;
	/** 下一条物理行号（1-based）。 */
	nextLineNo: number;
}

export const JOURNAL_SEQ_CURSOR_START: JournalSeqCursor = { offset: 0, nextLineNo: 1 };

export function isJournalSeqCursor(x: unknown): x is JournalSeqCursor {
	if (typeof x !== "object" || x === null) return false;
	const c = x as Record<string, unknown>;
	return typeof c.offset === "number" && c.offset >= 0 && Number.isInteger(c.offset);
}

export interface JournalTailResult {
	entries: JournalSeqEntry[];
	/** 推进后的 cursor（消费完所有完整行；不完整的尾行留待下次）。 */
	cursor: JournalSeqCursor;
	/** 文件比 cursor.offset 短（删除/截断/重建）→ true，cursor 已复位到 START；调用方必须 resync。 */
	truncated: boolean;
	skippedBadLines: number;
}

/**
 * 从 cursor 增量读 journal：只消费完整行（以 \n 结尾），半截尾行留待追加后下次读。
 * 空行消耗行号不产出；坏行消耗行号并计数。永不 throw。
 */
export function readJournalTail(path: string, cursor: JournalSeqCursor): JournalTailResult {
	let size = 0;
	try {
		size = statSync(path).size;
	} catch {
		size = 0;
	}
	if (size < cursor.offset) {
		return { entries: [], cursor: { offset: 0, nextLineNo: 1 }, truncated: true, skippedBadLines: 0 };
	}
	let buf: Buffer;
	try {
		buf = readFileSync(path);
	} catch {
		// 读失败（竞态删除等）：不推进 cursor；offset>0 而文件已不可读按截断处理
		return { entries: [], cursor: { ...cursor }, truncated: cursor.offset > 0, skippedBadLines: 0 };
	}
	const slice = buf.subarray(cursor.offset);
	// 找最后一个 \n —— 其后（不含）为半截尾行，留待下次
	let lastNL = -1;
	for (let i = slice.length - 1; i >= 0; i -= 1) {
		if (slice[i] === 0x0a) {
			lastNL = i;
			break;
		}
	}
	const end = lastNL >= 0 ? lastNL + 1 : 0;
	const chunk = slice.subarray(0, end);

	const entries: JournalSeqEntry[] = [];
	let skippedBadLines = 0;
	let lineNo = cursor.nextLineNo;
	let pos = 0;
	while (pos < chunk.length) {
		let nl = pos;
		while (nl < chunk.length && chunk[nl] !== 0x0a) nl += 1;
		const line = chunk.subarray(pos, nl).toString("utf8").trim();
		pos = nl + 1;
		if (line.length > 0) {
			try {
				const parsed: unknown = JSON.parse(line);
				if (validateEnvelope(parsed).length === 0) {
					entries.push({ seq: lineNo, envelope: parsed as RuntimeEnvelope });
				} else {
					skippedBadLines += 1;
				}
			} catch {
				skippedBadLines += 1;
			}
		}
		lineNo += 1;
	}
	return {
		entries,
		cursor: { offset: cursor.offset + end, nextLineNo: lineNo },
		truncated: false,
		skippedBadLines,
	};
}
