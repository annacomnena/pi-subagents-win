/**
 * runtime/transcript.ts — G6-P1：pi session JSONL 只读投影（plans/0920_g6_webconsole_plan.md §2 拍板②）
 *
 * 行模型（5 种自包含行；结构变化换整行，渲染任一行不需读别的行）：
 *   turnHeader / userInput / assistantText / reasoning / toolCall
 *   **turn = 行上标签非容器**：turnHeader 携带 turn 边界 + 时长（下一 user message 时刻差，
 *   不做 ZCode 权威工时细分）；每行带 turnIndex 标签。
 *
 * 5 操作封闭集（照 ZCode delta.ts，刻意压缩客户端错误面）：
 *   row.appended / row.delta / row.upserted / row.removed / state.updated
 *   - P1 投影源（pi JSONL 整条落盘）只产 appended / upserted / state.updated；
 *     delta（流式文本追加，仅允许作用于流式态行）与 removed（屏障：删该行及之后所有）
 *     协议层定义 + coalesce/apply 黄金测试覆盖，发射面留给后续（用户编辑/分支/真流式）。
 *   - 表达不了的结构变化 → 整段 snapshot resync（HTTP GET / WS ack mode:"snapshot"）。
 *
 * 投影源头 = pi session JSONL（~/.pi/agent/sessions/<cwd-enc>/<ts>_<id>.jsonl，只读）：
 *   - `message` 条目（role user/assistant/toolResult）→ 行；assistant 按内容分片拆行；
 *     toolResult 回填对应 toolCall 行（row.upserted，自包含）。
 *   - `session` 头 → 会话元数据（非行）；`session_info` → state.updated {name}；
 *     其余条目（model_change/thinking_level_change/compaction/branch_summary/custom/
 *     custom_message/label）→ skip + 计数（skippedUnknown，journal skippedBadLines 惯例）。
 *   - 幂等：同文件重复投影结果逐字节一致（rowId 由 entryId 派生，确定性）。
 *   - §22：会话文件仍是真相，host 只投影；增量读走 file-offset cursor。
 *
 * coalesce 纯函数：不变式 `coalesce(xs) ≡ 逐条 apply` 终态一致；黄金测试先 10 例。
 * 红线：只读纯库、never-throw（坏行/未知条目 skip+计数）、零 Pi API 依赖。
 */

import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── 行模型（5 种自包含行）─────────────────────────────────────────

export type TranscriptRowKind = "turnHeader" | "userInput" | "assistantText" | "reasoning" | "toolCall";

export interface TurnHeaderRow {
	kind: "turnHeader";
	/** `t_<userMessageEntryId>`（跨重投影稳定）。 */
	rowId: string;
	/** turn 序号（1-based，投影序）——标签非容器。 */
	turnIndex: number;
	/** turn 开始 = 触发它的 user message entry timestamp。 */
	startedAt: string;
	/** turn 关闭时长 ms（下一 user message 时刻差）；进行中 turn → 缺省。 */
	durationMs?: number;
}

export interface UserInputRow {
	kind: "userInput";
	/** `r_<entryId>_<partIdx>`。 */
	rowId: string;
	turnIndex: number;
	at: string;
	/** user message 的 text 内容分片 join（image 等不可投影分片计入 skippedUnknown）。 */
	text: string;
}

export interface AssistantTextRow {
	kind: "assistantText";
	rowId: string;
	turnIndex: number;
	at: string;
	text: string;
	model?: string;
	provider?: string;
}

export interface ReasoningRow {
	kind: "reasoning";
	rowId: string;
	turnIndex: number;
	at: string;
	text: string;
	model?: string;
	provider?: string;
}

export interface ToolCallRow {
	kind: "toolCall";
	rowId: string;
	turnIndex: number;
	at: string;
	/** toolCall 分片的 id（toolResult.toolCallId 回填锚）。 */
	callId: string;
	name: string;
	arguments: unknown;
	status: "running" | "done" | "error";
	/** toolResult 的 text 分片 join（无结果 → 缺省）。 */
	output?: string;
	model?: string;
	provider?: string;
}

export type TranscriptRow = TurnHeaderRow | UserInputRow | AssistantTextRow | ReasoningRow | ToolCallRow;

// ── 5 操作封闭集 ──────────────────────────────────────────────────

export type TranscriptOp =
	| { kind: "row.appended"; row: TranscriptRow }
	| { kind: "row.delta"; rowId: string; path: string; append: string }
	| { kind: "row.upserted"; row: TranscriptRow }
	| { kind: "row.removed"; rowId: string }
	| { kind: "state.updated"; patch: Record<string, unknown> };

// ── 客户端 apply（纯 reducer；coalesce 黄金测试的前提）────────────

export interface TranscriptView {
	rows: TranscriptRow[];
	/** 状态面（state.updated 键级整体替换；键内绝不深合并）。 */
	info: Record<string, unknown>;
}

export const EMPTY_TRANSCRIPT_VIEW: TranscriptView = { rows: [], info: {} };

/** 单 op 应用（纯返回新 view）。幂等友好：appended 已存在 → 忽略；upserted 未存在 → 插入。 */
export function applyTranscriptOp(view: TranscriptView, op: TranscriptOp): TranscriptView {
	switch (op.kind) {
		case "row.appended": {
			if (view.rows.some((r) => r.rowId === op.row.rowId)) return view; // 重放幂等
			return { ...view, rows: [...view.rows, op.row] };
		}
		case "row.upserted": {
			const idx = view.rows.findIndex((r) => r.rowId === op.row.rowId);
			if (idx < 0) return { ...view, rows: [...view.rows, op.row] };
			const rows = view.rows.slice();
			rows[idx] = op.row;
			return { ...view, rows };
		}
		case "row.removed": {
			// 屏障语义（照 ZCode）：删除该行及其后所有行；任何规则不得跨越
			const idx = view.rows.findIndex((r) => r.rowId === op.rowId);
			if (idx < 0) return view;
			return { ...view, rows: view.rows.slice(0, idx) };
		}
		case "row.delta": {
			// 仅允许作用于流式态文本行（assistantText/reasoning）的 text 路径；其余忽略
			if (op.path !== "text") return view;
			const idx = view.rows.findIndex((r) => r.rowId === op.rowId);
			if (idx < 0) return view;
			const row = view.rows[idx];
			if (row.kind !== "assistantText" && row.kind !== "reasoning") return view;
			const rows = view.rows.slice();
			rows[idx] = { ...row, text: row.text + op.append };
			return { ...view, rows };
		}
		case "state.updated": {
			return { ...view, info: { ...view.info, ...op.patch } };
		}
	}
}

export function applyTranscriptOps(view: TranscriptView, ops: readonly TranscriptOp[]): TranscriptView {
	let cur = view;
	for (const op of ops) cur = applyTranscriptOp(cur, op);
	return cur;
}

// ── coalesce（纯函数；不变式 coalesce(xs) ≡ 逐条 apply）──────────
//
// 规则（照 ZCode coalesce.ts 封闭 5 条，帧切分不在此层）：
//   R1 相邻同 (rowId,path) 的 row.delta 拼接 append；
//   R2 相邻 state.updated 键浅合并（后者键胜出）；
//   R3 row.upserted 吞掉紧邻其前的同行 delta / appended 连续段；
//   R4 row.removed 是屏障——任何合并不跨越它；
//   R5 其余 op 原样通过。

export function coalesceOps(ops: readonly TranscriptOp[]): TranscriptOp[] {
	const out: TranscriptOp[] = [];
	for (const op of ops) {
		const prev = out[out.length - 1];
		// R1
		if (
			op.kind === "row.delta" &&
			prev !== undefined &&
			prev.kind === "row.delta" &&
			prev.rowId === op.rowId &&
			prev.path === op.path
		) {
			out[out.length - 1] = { kind: "row.delta", rowId: prev.rowId, path: prev.path, append: prev.append + op.append };
			continue;
		}
		// R2
		if (op.kind === "state.updated" && prev !== undefined && prev.kind === "state.updated") {
			out[out.length - 1] = { kind: "state.updated", patch: { ...prev.patch, ...op.patch } };
			continue;
		}
		// R3（R4 由「吞掉集合不含 removed」天然满足：removed 挡住回扫）
		if (op.kind === "row.upserted") {
			let i = out.length - 1;
			while (i >= 0) {
				const p = out[i];
				const swallows =
					(p.kind === "row.delta" && p.rowId === op.row.rowId) ||
					(p.kind === "row.appended" && p.row.rowId === op.row.rowId);
				if (!swallows) break;
				i -= 1;
			}
			if (i < out.length - 1) out.splice(i + 1);
			out.push(op);
			continue;
		}
		out.push(op);
	}
	return out;
}

// ── 投影器（单 session 文件的增量状态机）─────────────────────────

interface OpenTurn {
	index: number;
	rowId: string;
	startedAt: string;
	startMs: number;
}

export interface TranscriptSnapshot {
	sessionId: string | null;
	cwd: string | null;
	startedAt: string | null;
	parentSession: string | null;
	/** 首 entry id（session 头 id）——文件代际指纹。 */
	logEpoch: string;
	/** 已摄入的最大物理行号。 */
	head: number;
	rows: TranscriptRow[];
	skippedUnknown: number;
	/** 状态面（session_info.name 等）。 */
	info: Record<string, unknown>;
}

export interface TranscriptProjector {
	ingestEntry(entry: Record<string, unknown>, seq: number): TranscriptOp[];
	snapshot(): TranscriptSnapshot;
}

function str(v: unknown): string | null {
	return typeof v === "string" && v.length > 0 ? v : null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
	return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function contentParts(message: Record<string, unknown>): unknown[] {
	const c = message.content;
	return Array.isArray(c) ? c : [];
}

function joinTextParts(parts: unknown[]): string {
	const texts: string[] = [];
	for (const p of parts) {
		const rec = asRecord(p);
		if (!rec) continue;
		if (rec.type === "text" && typeof rec.text === "string") texts.push(rec.text);
	}
	return texts.join("\n\n");
}

function parseTs(v: unknown): number | null {
	const s = str(v);
	if (s === null) return null;
	const ms = Date.parse(s);
	return Number.isFinite(ms) ? ms : null;
}

/** 构造投影器（每 session 文件一个实例；seq = 物理行号，只要求单调）。 */
export function createTranscriptProjector(): TranscriptProjector {
	let sessionId: string | null = null;
	let cwd: string | null = null;
	let startedAt: string | null = null;
	let parentSession: string | null = null;
	let logEpoch = "";
	let head = 0;
	const rows: TranscriptRow[] = [];
	const rowIndex = new Map<string, number>();
	const callIdToRowId = new Map<string, string>();
	const rowTurn = new Map<string, number>();
	let openTurn: OpenTurn | null = null;
	let turnCount = 0;
	let skippedUnknown = 0;
	const info: Record<string, unknown> = {};

	const pushRow = (row: TranscriptRow): TranscriptOp => {
		rowIndex.set(row.rowId, rows.length);
		rows.push(row);
		rowTurn.set(row.rowId, row.turnIndex);
		return { kind: "row.appended", row };
	};

	const upsertRow = (row: TranscriptRow): TranscriptOp => {
		const idx = rowIndex.get(row.rowId);
		if (idx === undefined) return pushRow(row);
		rows[idx] = row;
		return { kind: "row.upserted", row };
	};

	const ingestEntry = (entry: Record<string, unknown>, seq: number): TranscriptOp[] => {
		if (seq <= head) return []; // 乱序/重放防御：只前进
		head = seq;
		const type = str(entry.type);
		const entryId = str(entry.id) ?? `s${seq}`;
		const at = str(entry.timestamp) ?? "";

		if (type === "session") {
			// 文件头：会话元数据（非行）；logEpoch 只认首个头
			if (logEpoch === "") logEpoch = entryId;
			sessionId = str(entry.id) ?? sessionId;
			cwd = str(entry.cwd) ?? cwd;
			startedAt = str(entry.timestamp) ?? startedAt;
			parentSession = str(entry.parentSession) ?? parentSession;
			return [];
		}

		if (type === "session_info") {
			// 状态面：显示名（state.updated 的 P1 发射点）
			const name = str(entry.name);
			if (name !== null) {
				info.name = name;
				return [{ kind: "state.updated", patch: { name } }];
			}
			skippedUnknown += 1;
			return [];
		}

		if (type !== "message") {
			// model_change / thinking_level_change / compaction / branch_summary / custom /
			// custom_message / label / 未知类型 → skip + 计数（never-throw，格式演进容错）
			skippedUnknown += 1;
			return [];
		}

		const message = asRecord(entry.message);
		if (message === null) {
			skippedUnknown += 1;
			return [];
		}
		const role = str(message.role);

		if (role === "user") {
			// turn 边界：user message 开新 turn（turn = 标签非容器）
			const ops: TranscriptOp[] = [];
			const startMs = parseTs(entry.timestamp);
			if (openTurn !== null) {
				// 关闭上一 turn：turnHeader 换整行（upserted）补时长
				const idx = rowIndex.get(openTurn.rowId);
				const prevRow = idx !== undefined ? rows[idx] : null;
				if (prevRow !== null && prevRow.kind === "turnHeader") {
					const closed: TurnHeaderRow =
						startMs !== null && Number.isFinite(openTurn.startMs)
							? { ...prevRow, durationMs: Math.max(0, startMs - openTurn.startMs) }
							: prevRow;
					ops.push(upsertRow(closed));
				}
			}
			turnCount += 1;
			const header: TurnHeaderRow = { kind: "turnHeader", rowId: `t_${entryId}`, turnIndex: turnCount, startedAt: at };
			ops.push(pushRow(header));
			openTurn = { index: turnCount, rowId: header.rowId, startedAt: at, startMs: startMs ?? Number.NaN };

			const parts = contentParts(message);
			const text = joinTextParts(parts);
			ops.push(pushRow({ kind: "userInput", rowId: `r_${entryId}_0`, turnIndex: turnCount, at, text }));
			// 不可投影的 user 分片（image 等）计数
			for (const p of parts) {
				const rec = asRecord(p);
				if (!rec || (rec.type !== "text" && rec.type !== "image")) {
					skippedUnknown += 1;
					continue;
				}
				if (rec.type === "image") skippedUnknown += 1;
			}
			return ops;
		}

		if (role === "assistant") {
			const turnIndex = openTurn !== null ? openTurn.index : turnCount;
			const model = str(message.model) ?? undefined;
			const provider = str(message.provider) ?? undefined;
			const ops: TranscriptOp[] = [];
			const parts = contentParts(message);
			for (let i = 0; i < parts.length; i += 1) {
				const part = asRecord(parts[i]);
				if (part === null) {
					skippedUnknown += 1;
					continue;
				}
				if (part.type === "text" && typeof part.text === "string") {
					ops.push(
						pushRow({
							kind: "assistantText",
							rowId: `r_${entryId}_${i}`,
							turnIndex,
							at,
							text: part.text,
							...(model ? { model } : {}),
							...(provider ? { provider } : {}),
						}),
					);
				} else if (part.type === "thinking" && typeof part.thinking === "string") {
					ops.push(
						pushRow({
							kind: "reasoning",
							rowId: `r_${entryId}_${i}`,
							turnIndex,
							at,
							text: part.thinking,
							...(model ? { model } : {}),
							...(provider ? { provider } : {}),
						}),
					);
				} else if (part.type === "toolCall") {
					const callId = str(part.id);
					const name = str(part.name);
					if (callId === null || name === null) {
						skippedUnknown += 1;
						continue;
					}
					const rowId = `r_${entryId}_${i}`;
					callIdToRowId.set(callId, rowId);
					ops.push(
						pushRow({
							kind: "toolCall",
							rowId,
							turnIndex,
							at,
							callId,
							name,
							arguments: part.arguments ?? null,
							status: "running",
							...(model ? { model } : {}),
							...(provider ? { provider } : {}),
						}),
					);
				} else {
					skippedUnknown += 1;
				}
			}
			return ops;
		}

		if (role === "toolResult") {
			const callId = str(message.toolCallId);
			const rowId = callId !== null ? callIdToRowId.get(callId) : undefined;
			if (rowId === undefined) {
				// compaction 截断前的调用等：无锚可回填 → skip + 计数
				skippedUnknown += 1;
				return [];
			}
			const idx = rowIndex.get(rowId);
			if (idx === undefined) {
				skippedUnknown += 1;
				return [];
			}
			const prev = rows[idx];
			if (prev.kind !== "toolCall") {
				skippedUnknown += 1;
				return [];
			}
			const isError = message.isError === true;
			const output = joinTextParts(contentParts(message));
			const ops: TranscriptOp[] = [];
			ops.push(
				upsertRow({
					...prev,
					status: isError ? "error" : "done",
					...(output.length > 0 ? { output } : {}),
				}),
			);
			return ops;
		}

		skippedUnknown += 1;
		return [];
	};

	return {
		ingestEntry,
		snapshot: (): TranscriptSnapshot => ({
			sessionId,
			cwd,
			startedAt,
			parentSession,
			logEpoch,
			head,
			rows: rows.map((r) => ({ ...r })),
			skippedUnknown,
			info: { ...info },
		}),
	};
}

// ── 文件读（tolerant；与 WS 尾读同一 cursor 语义）────────────────

export interface SessionTailCursor {
	/** 已消费字节偏移（只推进到最后一个完整 \n）。 */
	offset: number;
	/** 下一条物理行号。 */
	nextLineNo: number;
}

export const SESSION_TAIL_CURSOR_START: SessionTailCursor = { offset: 0, nextLineNo: 1 };

export interface ParsedSessionLine {
	seq: number;
	entry: Record<string, unknown>;
}

export interface SessionTailResult {
	/** 解析成功（JSON 可解析且为 object）的行；未知 type 交给 projector 计数。 */
	lines: ParsedSessionLine[];
	skippedBadLines: number;
	cursor: SessionTailCursor;
	/** 文件比 cursor.offset 短（截断/重建）→ true，cursor 已复位；调用方必须 resync。 */
	truncated: boolean;
}

function splitCompleteLines(buf: Buffer, startOffset: number, startLineNo: number): {
	lines: { lineNo: number; text: string }[];
	cursor: SessionTailCursor;
} {
	const slice = buf.subarray(startOffset);
	let lastNL = -1;
	for (let i = slice.length - 1; i >= 0; i -= 1) {
		if (slice[i] === 0x0a) {
			lastNL = i;
			break;
		}
	}
	const end = lastNL >= 0 ? lastNL + 1 : 0;
	const chunk = slice.subarray(0, end);
	const lines: { lineNo: number; text: string }[] = [];
	let lineNo = startLineNo;
	let pos = 0;
	while (pos < chunk.length) {
		let nl = pos;
		while (nl < chunk.length && chunk[nl] !== 0x0a) nl += 1;
		const text = chunk.subarray(pos, nl).toString("utf8").trim();
		pos = nl + 1;
		lines.push({ lineNo, text });
		lineNo += 1;
	}
	return { lines, cursor: { offset: startOffset + end, nextLineNo: lineNo } };
}

/** 从 cursor 增量读 session JSONL 完整行（半截尾行留待下次；坏行计数并消耗行号）。 */
export function readSessionTail(path: string, cursor: SessionTailCursor): SessionTailResult {
	let size = 0;
	try {
		size = statSync(path).size;
	} catch {
		size = 0;
	}
	if (size < cursor.offset) {
		return { lines: [], skippedBadLines: 0, cursor: { offset: 0, nextLineNo: 1 }, truncated: true };
	}
	let buf: Buffer;
	try {
		buf = readFileSync(path);
	} catch {
		return { lines: [], skippedBadLines: 0, cursor: { ...cursor }, truncated: cursor.offset > 0 };
	}
	const { lines, cursor: next } = splitCompleteLines(buf, cursor.offset, cursor.nextLineNo);
	const out: ParsedSessionLine[] = [];
	let skippedBadLines = 0;
	for (const l of lines) {
		if (l.text.length === 0) continue;
		try {
			const parsed: unknown = JSON.parse(l.text);
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
				skippedBadLines += 1;
				continue;
			}
			out.push({ seq: l.lineNo, entry: parsed as Record<string, unknown> });
		} catch {
			skippedBadLines += 1;
		}
	}
	return { lines: out, skippedBadLines, cursor: next, truncated: false };
}

/** 从 START 一次读尽（尾读循环到 EOF 的封装；坏行计入 skippedBadLines）。 */
function readAllSessionLines(path: string): { lines: ParsedSessionLine[]; skippedBadLines: number; cursor: SessionTailCursor; truncated: boolean } {
	let cursor = SESSION_TAIL_CURSOR_START;
	const all: ParsedSessionLine[] = [];
	let bad = 0;
	for (;;) {
		const r = readSessionTail(path, cursor);
		if (r.truncated) return { lines: [], skippedBadLines: bad, cursor: SESSION_TAIL_CURSOR_START, truncated: true };
		all.push(...r.lines);
		bad += r.skippedBadLines;
		const progressed = r.cursor.offset !== cursor.offset || r.cursor.nextLineNo !== cursor.nextLineNo;
		cursor = r.cursor;
		if (!progressed) break; // EOF（无新完整行可消费）
	}
	return { lines: all, skippedBadLines: bad, cursor, truncated: false };
}

// ── 全量/增量投影入口（GET 与 WS 共用同一核心）───────────────────

export interface ProjectSessionOpsResult {
	found: boolean;
	logEpoch: string;
	/** 已摄入的最大物理行号（EOF cursor.nextLineNo - 1）。 */
	head: number;
	/** seq > afterSeq 的条目所产的 op（含 state.updated；顺序 = 投影序）。 */
	ops: { seq: number; op: TranscriptOp }[];
	skippedBadLines: number;
	/** 读尽后的 EOF cursor（WS 订阅方据此落 live tail 起点）。 */
	cursor: SessionTailCursor;
}

/** WS 续传补发：全量重投影（确定性），只回 seq > afterSeq 的 op。 */
export function projectSessionOps(path: string, afterSeq: number): ProjectSessionOpsResult {
	if (!existsSync(path)) {
		return { found: false, logEpoch: "", head: 0, ops: [], skippedBadLines: 0, cursor: SESSION_TAIL_CURSOR_START };
	}
	const r = readAllSessionLines(path);
	const projector = createTranscriptProjector();
	const ops: { seq: number; op: TranscriptOp }[] = [];
	for (const l of r.lines) {
		for (const op of projector.ingestEntry(l.entry, l.seq)) ops.push({ seq: l.seq, op });
	}
	const snap = projector.snapshot();
	return {
		found: true,
		logEpoch: snap.logEpoch,
		head: snap.head,
		ops: ops.filter((o) => o.seq > afterSeq),
		skippedBadLines: r.skippedBadLines,
		cursor: r.cursor,
	};
}

export interface ProjectSessionRowsResult {
	found: boolean;
	sessionId: string | null;
	cwd: string | null;
	startedAt: string | null;
	logEpoch: string;
	head: number;
	/**
	 * afterSeq=0 → 全量行快照（首屏）；afterSeq>0 → 该点之后条目所触及的行的**终态**
	 * （appended 新行 + upserted 回填，按 rowId 去重、首触序），客户端按 rowId upsert 合并。
	 */
	rows: TranscriptRow[];
	skippedUnknown: number;
	skippedBadLines: number;
	name: string | null;
}

/** GET /v1/sessions/:id/transcript 的投影入口（与 WS 同一 projector 核心）。 */
export function projectSession(path: string, afterSeq = 0): ProjectSessionRowsResult {
	const r = readAllSessionLines(path);
	if (!existsSync(path)) {
		return {
			found: false, sessionId: null, cwd: null, startedAt: null, logEpoch: "", head: 0,
			rows: [], skippedUnknown: 0, skippedBadLines: 0, name: null,
		};
	}
	const projector = createTranscriptProjector();
	const touched = new Map<string, TranscriptRow>();
	for (const l of r.lines) {
		const ops = projector.ingestEntry(l.entry, l.seq);
		if (l.seq > afterSeq) {
			for (const op of ops) {
				if (op.kind === "row.appended" || op.kind === "row.upserted") touched.set(op.row.rowId, op.row);
			}
		}
	}
	const snap = projector.snapshot();
	return {
		found: true,
		sessionId: snap.sessionId,
		cwd: snap.cwd,
		startedAt: snap.startedAt,
		logEpoch: snap.logEpoch,
		head: snap.head,
		rows: [...touched.values()],
		skippedUnknown: snap.skippedUnknown,
		skippedBadLines: r.skippedBadLines,
		name: typeof snap.info.name === "string" ? snap.info.name : null,
	};
}

// ── 会话列表 / 文件定位 ──────────────────────────────────────────

export interface SessionSummary {
	sessionId: string;
	cwd: string | null;
	startedAt: string | null;
	parentSession: string | null;
	file: string;
	sizeBytes: number;
	mtimeMs: number;
}

function defaultSessionsDirPath(): string {
	return join(homedir(), ".pi", "agent", "sessions");
}

/** 会话根目录（env `PI_SESSIONS_DIR` 覆盖，测试隔离用）。 */
export function defaultSessionsDir(): string {
	const override = process.env.PI_SESSIONS_DIR;
	if (override && override.trim()) return override.trim();
	return defaultSessionsDirPath();
}

function sessionFileId(sessionsDir: string, file: string): string | null {
	// 文件名形状 `<ts>_<uuid>.jsonl`；uuid 兜底取末段，权威 id 以首行头为准
	const base = file.replace(/\.jsonl$/, "");
	const idx = base.lastIndexOf("_");
	return idx >= 0 ? base.slice(idx + 1) : base;
}

/** 读首行头（只读前 8KB，避免大文件全读；tolerant）。 */
function readHeader(path: string): Record<string, unknown> | null {
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch {
		return null;
	}
	try {
		const tmp = Buffer.alloc(8192);
		const n = readSync(fd, tmp, 0, tmp.length, 0);
		if (n <= 0) return null;
		const head = tmp.subarray(0, n).toString("utf8");
		const nl = head.indexOf("\n");
		const first = (nl >= 0 ? head.slice(0, nl) : head).trim();
		if (first.length === 0) return null;
		const parsed: unknown = JSON.parse(first);
		return asRecord(parsed);
	} catch {
		return null;
	} finally {
		try {
			closeSync(fd);
		} catch {
			/* ignore */
		}
	}
}

/** 枚举 pi 会话（sessionsDir 的直接 .jsonl + 一层 cwd 子目录）；startedAt 降序。never-throw。 */
export function listPiSessions(sessionsDir: string = defaultSessionsDir()): SessionSummary[] {
	const out: SessionSummary[] = [];
	let top: string[] = [];
	try {
		top = readdirSync(sessionsDir);
	} catch {
		return out;
	}
	const scanFile = (dir: string, file: string): void => {
		if (!file.endsWith(".jsonl")) return;
		const full = join(dir, file);
		let st: { size: number; mtimeMs: number } | null = null;
		try {
			const s = statSync(full);
			st = { size: s.size, mtimeMs: s.mtimeMs };
		} catch {
			return;
		}
		const header = readHeader(full);
		const id = (header !== null ? str(header.id) : null) ?? sessionFileId(dir, file);
		if (id === null) return;
		out.push({
			sessionId: id,
			cwd: header !== null ? str(header.cwd) : null,
			startedAt: header !== null ? str(header.timestamp) : null,
			parentSession: header !== null ? str(header.parentSession) : null,
			file: full,
			sizeBytes: st.size,
			mtimeMs: st.mtimeMs,
		});
	};
	for (const name of top) {
		const full = join(sessionsDir, name);
		let isDir = false;
		try {
			isDir = statSync(full).isDirectory();
		} catch {
			continue;
		}
		if (isDir) {
			let inner: string[] = [];
			try {
				inner = readdirSync(full);
			} catch {
				continue;
			}
			for (const f of inner) scanFile(full, f);
		} else {
			scanFile(sessionsDir, name);
		}
	}
	out.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? "") || a.sessionId.localeCompare(b.sessionId));
	return out;
}

/** 按 sessionId 定位会话文件（先文件名后缀快筛，再首行头确认；tolerant 降级为文件名匹配）。 */
export function findSessionFile(sessionsDir: string, sessionId: string): string | null {
	if (!sessionId || /[/\\\s]/.test(sessionId)) return null;
	for (const s of listPiSessions(sessionsDir)) {
		if (s.sessionId === sessionId) return s.file;
		// 头不可读时 sessionFileId 兜底已进 sessionId；再兜一层后缀匹配
		if (s.file.endsWith(`_${sessionId}.jsonl`)) return s.file;
	}
	return null;
}
