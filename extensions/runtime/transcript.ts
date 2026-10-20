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
import { StringDecoder } from "node:string_decoder";
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

/**
 * 投影器选项（尾窗投影用）。
 * - `turnCountBase`：窗口从文件中段开始时的「已关闭 turn 数」偏移 —— 保证 `turnIndex`
 *   仍是**全会话序号**（GUI 的「对话轮 N」直接显示它，不能从 1 重数）。
 */
export interface TranscriptProjectorOptions {
	turnCountBase?: number;
}

/** 构造投影器（每 session 文件一个实例；seq = 物理行号，只要求单调）。 */
export function createTranscriptProjector(opts: TranscriptProjectorOptions = {}): TranscriptProjector {
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
	let turnCount = opts.turnCountBase !== undefined && Number.isFinite(opts.turnCountBase) ? Math.max(0, Math.trunc(opts.turnCountBase)) : 0;
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

// ── 尾窗投影（GET ?tail=N：只读文件尾部，不整文件解析）──────────────

/**
 * 尾窗投影（L2 perf，2026-10-20）。用户诉求：「读取会话很慢——改成从最新消息开始读，不要一下拉全部」。
 *
 * 动因（实测）：`projectSession` 对整文件 `readAllSessionLines` + 逐行 `JSON.parse`。
 * 本机 940 个会话里 p99 = 9.3MB、最大 **152MB**：15.4MB 会话 = 152ms/6315 行/6.5MB body，
 * 152MB 会话 = **557ms**。而 GUI 首屏只画尾部 200 行 ⇒ 前面的解析与传输全是白费。
 *
 * 做法：从文件尾部读一个**按需放大的字节窗**，只解析窗内行；绝对 `seq`（物理行号）与
 * `turnIndex` 偏移靠对前缀做**纯字节扫描**（数 `
` 与 `"role":"user"` 出现次数）得到，
 * 不解析前缀 JSON。152MB 文件的前缀扫描实测 ~106ms（vs 全量 557ms）。
 *
 * 契约保证（与全量投影的关系）：
 * - `rows` == 全量投影 `rows` 的**尾部切片**（同一 rowId / 同一 turnIndex / 同一 seq）；
 *   唯一允许的差异是**窗口首行所在 turn 的 `durationMs`**（其关闭事件在窗外，故该 turnHeader 无时长），
 *   以及「toolCall 在窗外、toolResult 在窗内」的孤立结果（无锚可回填 → 计入 skippedUnknown，与既有语义一致）。
 * - `head` / `logEpoch` 仍是**绝对**值（WS 增量 `after=` 可直接接续）。
 * - `hasOlder` 表示窗口之外还有更早的行（客户端据此显示「加载更早」）。
 */
export interface ProjectSessionTailOptions {
	/** 需要的最新行数（缺省 200；夹紧到 [1, 5000]）。 */
	rows?: number;
}

export interface ProjectSessionTailResult extends ProjectSessionRowsResult {
	/** 窗口之外是否还有更早的行（= 本次未返回的行数 > 0）。 */
	hasOlder: boolean;
	/** 窗口起始字节偏移（诊断/测试用；0 = 读的是整文件）。 */
	windowStartOffset: number;
}

/** 试投影窗初值（1MB：本仓 p99 会话 9.3MB，1MB 尾部通常已含数百行）。 */
const TAIL_WINDOW_INITIAL_BYTES = 1024 * 1024;
/** 单次试投影窗上限（防「尾部巨行」把窗口撑到整文件白读）。 */
const TAIL_WINDOW_MAX_BYTES = 16 * 1024 * 1024;
/** 小于此体积的文件直接走全量（小文件全量本身只有几毫秒，尾窗无收益）。 */
const TAIL_WINDOW_MIN_FILE = 2 * 1024 * 1024;

const TAIL_ROWS_DEFAULT = 200;
const TAIL_ROWS_MAX = 5000;
const USER_ROLE_PATTERN = Buffer.from('"role":"user"');
const MESSAGE_TYPE_PATTERN = Buffer.from('"type":"message"');

/**
 * 数文件尾部 probeBytes 字节里的「换行数」与「`"type":"message"` 出现次数」（零解析，只用来估密度）。
 *
 * 用 **message 条数**而不是行数做密度分子：行数在「少量超长行」文件里会严重高估密度
 * （实测 42.6MB 会话只有 128 行 / 155 个投影行），据此定窗会白扫 + 白解析一个大窗后仍然不够。
 * 失败 → null（调用方走全量）。
 */
function scanTailBytes(path: string, probeBytes: number): { lines: number; messages: number } | null {
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch {
		return null;
	}
	try {
		const size = statSync(path).size;
		const start = Math.max(0, size - probeBytes);
		const len = Math.max(1, size - start);
		const buf = Buffer.allocUnsafe(len);
		let read = 0;
		while (read < len) {
			const got = readSync(fd, buf, read, len - read, start + read);
			if (got <= 0) break;
			read += got;
		}
		const view = buf.subarray(0, read);
		let lines = 0;
		for (let i = 0; i < view.length; i += 1) if (view[i] === 0x0a) lines += 1;
		let messages = 0;
		let from = 0;
		for (;;) {
			const idx = view.indexOf(MESSAGE_TYPE_PATTERN, from);
			if (idx < 0) break;
			messages += 1;
			from = idx + 1;
		}
		return { lines, messages };
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

/** 扫描 [0, end) 字节：数换行数（= 已完整行数）与 `"role":"user"` 出现次数。分块读，零解析。 */
function scanPrefix(path: string, end: number): { lines: number; userMessages: number } | null {
	if (end <= 0) return { lines: 0, userMessages: 0 };
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch {
		return null;
	}
	try {
		const CHUNK = 4 * 1024 * 1024;
		const buf = Buffer.allocUnsafe(CHUNK + USER_ROLE_PATTERN.length);
		let pos = 0;
		let lines = 0;
		let userMessages = 0;
		let carry = 0; // 上一块末尾未匹配完的 pattern 前缀长度（跨块匹配用）
		while (pos < end) {
			const want = Math.min(CHUNK, end - pos);
			const got = readSync(fd, buf, carry, want, pos);
			if (got <= 0) break;
			const view = buf.subarray(0, carry + got);
			for (let i = 0; i < got; i += 1) if (buf[carry + i] === 0x0a) lines += 1;
			let from = 0;
			for (;;) {
				const idx = view.indexOf(USER_ROLE_PATTERN, from);
				if (idx < 0) break;
				userMessages += 1;
				from = idx + 1;
			}
			// 跨块：把末尾 pattern.length-1 字节挪到块首，下一块接上继续匹配
			carry = Math.min(USER_ROLE_PATTERN.length - 1, view.length);
			if (carry > 0) view.copy(buf, 0, view.length - carry, view.length);
			pos += got;
		}
		return { lines, userMessages };
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

/** 读文件首行（session 头）——只为 sessionId/cwd/startedAt/logEpoch 三件套，不读全文。 */
function readSessionHeaderLine(path: string): Record<string, unknown> | null {
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch {
		return null;
	}
	try {
		const buf = Buffer.allocUnsafe(64 * 1024);
		const got = readSync(fd, buf, 0, buf.length, 0);
		if (got <= 0) return null;
		const nl = buf.subarray(0, got).indexOf(0x0a);
		const text = buf.subarray(0, nl >= 0 ? nl : got).toString("utf8").trim();
		if (text.length === 0) return null;
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
		return parsed as Record<string, unknown>;
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

/** GET /v1/sessions/:id/transcript?tail=N 的投影入口（只读尾部字节窗）。 */
export function projectSessionTail(path: string, opts: ProjectSessionTailOptions = {}): ProjectSessionTailResult {
	const want = Math.min(TAIL_ROWS_MAX, Math.max(1, Math.trunc(opts.rows ?? TAIL_ROWS_DEFAULT)));
	if (!existsSync(path)) {
		return {
			found: false, sessionId: null, cwd: null, startedAt: null, logEpoch: "", head: 0,
			rows: [], skippedUnknown: 0, skippedBadLines: 0, name: null, hasOlder: false, windowStartOffset: 0,
		};
	}
	let size = 0;
	try {
		size = statSync(path).size;
	} catch {
		size = 0;
	}

	// 定窗（v3，实测调优）：先用一个**小窗试投影**拿到「真实行密度」，最多试 2 轮；
	// 定下窗口后才做一次前缀字节扫描（只为绝对 seq / turnIndex 偏移），再正式投影一次。
	// 顺序很关键：前缀扫描是 O(文件大小)（152MB ≈ 90ms），绝不能在一个注定失败的窗口上先付。
	let windowStart = 0;
	if (size >= TAIL_WINDOW_MIN_FILE) {
		let window = TAIL_WINDOW_INITIAL_BYTES;
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const start = Math.max(0, size - window);
			if (start === 0) break;
			const probe = projectWindow(path, start, 0, 0); // seq/turnIndex 此处无所谓，只看行数
			const rowsInWindow = probe !== null ? probe.rows.length : 0;
			if (rowsInWindow >= want) {
				windowStart = start;
				break;
			}
			if (rowsInWindow === 0) break; // 尾部没有可投影行 ⇒ 走全量
			// 用**实测密度**重算窗口（1.3× 余量）；估到「需要大半个文件」就不折腾了
			const needed = Math.ceil((want / rowsInWindow) * window * 1.3);
			if (needed >= size * 0.6) break;
			// 单次尝试上限 16MB：文件尾部若有「单行上百 MB」的巨行，放太大只会白读白解析
			window = Math.min(needed, TAIL_WINDOW_MAX_BYTES);
		}
	}
	if (windowStart > 0) {
		const scanned = scanPrefix(path, windowStart);
		if (scanned !== null) {
			const proj = projectWindow(path, windowStart, scanned.lines, scanned.userMessages);
			// 定窗后仍不够（密度突变）⇒ 退回全量：**永不比全量更少**
			if (proj !== null && proj.rows.length >= want) {
				const sliced = proj.rows.length > want ? proj.rows.slice(-want) : proj.rows;
				return {
					...proj,
					rows: sliced,
					hasOlder: proj.rows.length > want || windowStart > 0,
					windowStartOffset: windowStart,
				};
			}
		}
	}

	// 整文件路径
	const full = projectSession(path, 0);
	const sliced = full.rows.length > want ? full.rows.slice(-want) : full.rows;
	return {
		...full,
		rows: sliced,
		hasOlder: full.rows.length > want,
		windowStartOffset: 0,
	};
}

/** 投影 [windowStart, EOF) 字节窗；header 单独补喂一次（只为 logEpoch/元数据）。失败 → null。 */
function projectWindow(
	path: string,
	windowStart: number,
	prefixLines: number,
	prefixUserMessages: number,
): Omit<ProjectSessionTailResult, "hasOlder" | "windowStartOffset"> | null {
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch {
		return null;
	}
	let buf: Buffer;
	try {
		const size = statSync(path).size;
		const len = Math.max(0, size - windowStart);
		buf = Buffer.allocUnsafe(len);
		let read = 0;
		while (read < len) {
			const got = readSync(fd, buf, read, len - read, windowStart + read);
			if (got <= 0) break;
			read += got;
		}
		buf = buf.subarray(0, read);
	} catch {
		return null;
	} finally {
		try {
			closeSync(fd);
		} catch {
			/* ignore */
		}
	}
	// 对齐到行首：跳过窗口首行的残片（它的换行在窗口内但开头不完整）
	let aligned = 0;
	if (windowStart > 0) {
		const nl = buf.indexOf(0x0a);
		if (nl < 0) return null;
		aligned = nl + 1;
	}
	const { lines } = splitCompleteLines(buf, aligned, prefixLines + (windowStart > 0 ? 2 : 1));
	const projector = createTranscriptProjector({ turnCountBase: prefixUserMessages });
	const header = windowStart > 0 ? readSessionHeaderLine(path) : null;
	if (header !== null) projector.ingestEntry(header, 1); // 只补元数据；seq=1 < 窗内 seq（单调）
	let bad = 0;
	for (const l of lines) {
		if (l.text.length === 0) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(l.text);
		} catch {
			bad += 1;
			continue;
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			bad += 1;
			continue;
		}
		projector.ingestEntry(parsed as Record<string, unknown>, l.lineNo);
	}
	const snap = projector.snapshot();
	return {
		found: true,
		sessionId: snap.sessionId,
		cwd: snap.cwd,
		startedAt: snap.startedAt,
		logEpoch: snap.logEpoch,
		head: snap.head,
		rows: snap.rows,
		skippedUnknown: snap.skippedUnknown,
		skippedBadLines: bad,
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
	/** 头部扫描窗口（上限 256KB）内首条 user 文本（截 8000 字符；会话列表标题解析链 P1 探测 / P2 派生的副产品）。 */
	firstUserText: string | null;
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

// ── 头部窗口（标题解析链副产品，plans/0922_session_title_research.md §5）──

const HEAD_READ_BYTES = 32768; // 首读：取首行头
const HEAD_CHUNK_BYTES = 65536; // 续扫分块（避免一次性 alloc 大 buffer）
const HEAD_SCAN_MAX_BYTES = 262144; // 首条 user 扫描窗口上限（256KB；实测首条 user 偏移 p75≈32KB、max≈63KB）
const FIRST_USER_TEXT_CAP = 8000; // 首条 user 文本上限：需覆盖 <file> 附件块闭合（实测 2.6~4.4KB），供 P1 前缀 / P2 剥块

interface SessionHead {
	header: Record<string, unknown> | null;
	firstUserText: string | null;
}

/**
 * 分块读头：首读 32KB 取首行头；header 解析成功且窗口内未见首条 user → 以 64KB 分块续扫，
 * 上限 256KB。找到 header + 首条 user 即提前停止（多数会话在首读/第二块内命中）。
 * 跨块半截行以 pending 携带（utf8 按块解码拼接，多字节字符跨块亦正确）；
 * EOF 时 pending 视为完整行，窗口打满时丢弃（与旧 32KB 单次读同语义）。never-throw。
 */
function readHead(path: string): SessionHead {
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch {
		return { header: null, firstUserText: null };
	}
	try {
		const buf = Buffer.alloc(HEAD_CHUNK_BYTES);
		let header: Record<string, unknown> | null = null;
		let firstUserText: string | null = null;
		const handleLine = (raw: string): void => {
			const line = raw.trim();
			if (line.length === 0) return;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				return;
			}
			const entry = asRecord(parsed);
			if (entry === null) return;
			if (header === null) header = entry; // 首个可解析行 = 头（与旧 readHeader 同语义，不校验 type）
			if (firstUserText === null && entry.type === "message") {
				const message = asRecord(entry.message);
				if (message !== null && message.role === "user") {
					const text = joinTextParts(contentParts(message));
					if (text.trim().length > 0) {
						firstUserText = text.length > FIRST_USER_TEXT_CAP ? text.slice(0, FIRST_USER_TEXT_CAP) : text;
					}
				}
			}
		};
		let pending = ""; // 跨块携带的未完成行尾段
		const decoder = new StringDecoder("utf8"); // 保留跨块 UTF-8 多字节字符
		let offset = 0;
		for (;;) {
			const want = Math.min(offset === 0 ? HEAD_READ_BYTES : HEAD_CHUNK_BYTES, buf.length);
			const n = readSync(fd, buf, 0, want, offset);
			if (n <= 0) break; // 空文件
			// 窗口上限：超过 HEAD_SCAN_MAX_BYTES 的字节不扫（跨块截断段视半截行丢弃，
			// 避免上限后首个完整行（如 user 消息）被误收）
			const allowed = Math.min(n, HEAD_SCAN_MAX_BYTES - offset);
			if (allowed <= 0) break;
			const chunk = pending + decoder.write(buf.subarray(0, allowed));
			const windowFull = allowed < n;
			offset += n;
			const lines = chunk.split("\n");
			// 末段完整 ⇔ 块以换行收尾且未触上限；否则为（可能的）半截行
			const lastComplete = !windowFull && chunk.endsWith("\n");
			pending = lastComplete ? "" : lines[lines.length - 1];
			for (const raw of lastComplete ? lines : lines.slice(0, -1)) handleLine(raw);
			if (header !== null && firstUserText !== null) break; // 提前停
			if (windowFull) break; // 窗口上限（pending 已弃）
			if (n < want) {
				// EOF：末段无换行也是完整行
				if (pending.trim().length > 0) handleLine(pending);
				break;
			}
			if (header === null) break; // 头都解析不出，续扫无意义
		}
		return { header, firstUserText };
	} catch {
		return { header: null, firstUserText: null };
	} finally {
		try {
			closeSync(fd);
		} catch {
			/* ignore */
		}
	}
}

/** 会话头读缓存（L2 perf，2026-10-20）：key=绝对路径，值=文件身份 + 解析结果。
 *
 * 命中条件严格按 `(mtimeMs,size)` —— 与 `listPiSessions` 已有的 `statSync` 读数同源，
 * **零额外 IO**。失效自然发生：会话追加写必变 size（同 size 同 mtimeMs 而内容不同在本仓不可达）。
 * 动因：实测 939 会话时 `listPiSessions` 冷跑 341ms / 进程内温跑仍要重读全部 head（open+read+close ×939，
 * Windows 单次 ~0.3ms）⇒ 每个 6s 轮询都在重复同样的 939 次打开。缓存后仅「本拍有变化的会话」才重读。
 * 上限粗粒度清空（不引 LRU 依赖）：本仓实测 939 会话，上限 4000 留 4× 余量。
 */
const HEAD_CACHE = new Map<string, { stamp: string; head: SessionHead }>();
const HEAD_CACHE_MAX = 4000;

function readHeadCached(full: string, mtimeMs: number, size: number): SessionHead {
	const stamp = `${mtimeMs}|${size}`;
	const hit = HEAD_CACHE.get(full);
	if (hit !== undefined && hit.stamp === stamp) return hit.head;
	const head = readHead(full);
	if (HEAD_CACHE.size >= HEAD_CACHE_MAX) HEAD_CACHE.clear();
	HEAD_CACHE.set(full, { stamp, head });
	return head;
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
		const { header, firstUserText } = readHeadCached(full, st.mtimeMs, st.size);
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
			firstUserText,
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
