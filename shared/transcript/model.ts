/**
 * shared/transcript/model.ts — transcript 行模型 / 操作类型 / 纯 reducer（单一实现）
 *
 * 2026-11-04 P1：此前有两份**逐字符同构**的实现（`extensions/runtime/transcript.ts` 与
 * `gui/src/api/transcript.ts` 手抄），类型另有一份手抄在 `gui/src/api/types.ts`。
 * 本文件是三者合一后的唯一来源；两个原路径保留重导出，调用方无需改动。
 *
 * 消费方与约束（三方都吃同一个 .ts，改这里等于同时改三处）：
 *   ① Vite 生产构建（gui/dist）—— 不得出现任何 `node:` 导入、不得依赖 host 私有凭据；
 *   ② gui 的 `tsc --noEmit`（`gui/tsconfig.json` 的 include 已含本目录）——
 *      须满足 verbatimModuleSyntax / noUnusedLocals / 严格模式；
 *   ③ runtime 与测试的 `node --experimental-strip-types` —— **不做类型检查**，
 *      所以类型正确性只能靠 ② 保证；本文件的类型错误不会让服务端测试变红。
 *
 * 刻意**不**包含（留在 `extensions/runtime/transcript.ts`）：文件读取、JSONL 投影、
 * coalesce —— 它们依赖 node:fs，进入浏览器依赖图即构建失败。
 *
 * 纯函数纪律：apply* 返回新 view，绝不原地改；never-throw。
 */

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
