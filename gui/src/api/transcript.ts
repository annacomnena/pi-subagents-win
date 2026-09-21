/**
 * gui/src/api/transcript.ts — G6-P1：transcript op 客户端应用器（手抄自
 * extensions/runtime/transcript.ts::applyTranscriptOp；不跨 package import，types.ts 纪律）。
 *
 * 幂等友好：appended 已存在 → 忽略（WS 重放不重不漏）；upserted 替换或插入；
 * removed 屏障截断；delta 仅流式文本行 + text 路径；state.updated 键级整体替换。
 */

import type { TranscriptOp, TranscriptRow } from "./types";

export interface TranscriptView {
	rows: TranscriptRow[];
	info: Record<string, unknown>;
}

export const EMPTY_TRANSCRIPT_VIEW: TranscriptView = { rows: [], info: {} };

export function applyTranscriptOp(view: TranscriptView, op: TranscriptOp): TranscriptView {
	switch (op.kind) {
		case "row.appended": {
			if (view.rows.some((r) => r.rowId === op.row.rowId)) return view;
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
			const idx = view.rows.findIndex((r) => r.rowId === op.rowId);
			if (idx < 0) return view;
			return { ...view, rows: view.rows.slice(0, idx) };
		}
		case "row.delta": {
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
