/**
 * _test_runtime_transcript.ts — G6-P1 测试（runtime/transcript.ts 纯库：
 * pi session JSONL 只读投影 → 5 种自包含行 + 5 操作封闭集 + coalesce 黄金 10 例）
 *
 * 覆盖：
 *   T1 全量投影行清单：turnHeader/userInput/assistantText/reasoning/toolCall 五种齐全；
 *      自包含（model/provider/status/output 内联）；turn=标签（turnIndex 连续）；
 *      闭合 turn 的 turnHeader 带 durationMs，进行中 turn 不带
 *   T2 投影幂等：同 JSONL 重投影两次 → JSON.stringify 逐字节一致
 *   T3 增量 == 全量：分两段 ingest 的终态 rows == 一次性全投影 rows（确定性）
 *   T4 未知条目 skip+计数：model_change/thinking_level_change/compaction/custom/
 *      custom_message/label/image 分片/未知 toolResult 全部 skip，skippedUnknown 正确；
 *      session_info → state.updated {name}（P1 唯一 state 发射点）
 *   T5 发射面封闭：P1 投影只产 appended/upserted/state.updated；removed/delta 永不发射
 *   T6 applyOp 语义：appended 重放幂等 / upserted 插入或整行替换 / removed 屏障截断 /
 *      delta 仅流式文本行 + text 路径 / state.updated 键级浅合并（不深合并）
 *   T7 coalesce 黄金 10 例：每例断言 coalesce 形状 + `apply(coalesce) ≡ apply(全部)` 终态一致
 *   T8 projectSession afterSeq 增量：after=0 全量；after=head 空；截到中点 → 触及行终态
 *      （upserted 回填按 rowId 去重）
 *   T9 listPiSessions / findSessionFile：跨目录枚举、startedAt 降序、按 id 定位、缺失 → null
 *   T10 never-throw：坏 JSON 行 / 非对象行 / 半截尾行 / 空文件 / 缺失文件全部兜底
 *
 * 运行：npm run test:runtime-transcript
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.PI_SESSIONS_DIR = mkdtempSync(join(tmpdir(), "transcript-sessions-"));

import {
	applyTranscriptOp,
	applyTranscriptOps,
	coalesceOps,
	createTranscriptProjector,
	defaultSessionsDir,
	EMPTY_TRANSCRIPT_VIEW,
	findSessionFile,
	listPiSessions,
	projectSession,
	readSessionTail,
	SESSION_TAIL_CURSOR_START,
	type TranscriptOp,
	type TranscriptRow,
} from "./runtime/transcript.ts";

const DIRS: string[] = [process.env.PI_SESSIONS_DIR!];

function mkSessionDir(): string {
	const d = mkdtempSync(join(tmpdir(), "transcript-case-"));
	DIRS.push(d);
	return d;
}

/** 写一条 pi 形状的 session JSONL 行。 */
function line(o: unknown): string {
	return `${JSON.stringify(o)}\n`;
}

function header(id: string, ts: string, cwd = "C:\\tmp"): string {
	return line({ type: "session", version: 3, id, timestamp: ts, cwd });
}

function userMsg(id: string, ts: string, text: string, parentId: string | null = null): string {
	return line({
		type: "message", id, parentId, timestamp: ts,
		message: { role: "user", content: [{ type: "text", text }] },
	});
}

function assistantMsg(
	id: string, ts: string, parts: unknown[],
	opts: { model?: string; provider?: string } = {},
): string {
	return line({
		type: "message", id, parentId: null, timestamp: ts,
		message: {
			role: "assistant",
			content: parts,
			...(opts.model ? { model: opts.model } : {}),
			...(opts.provider ? { provider: opts.provider } : {}),
		},
	});
}

function toolResultMsg(id: string, ts: string, callId: string, output: string, isError = false): string {
	return line({
		type: "message", id, parentId: null, timestamp: ts,
		message: {
			role: "toolResult", toolCallId: callId, toolName: "bash",
			content: [{ type: "text", text: output }],
			...(isError ? { isError: true } : {}),
		},
	});
}

function writeSession(path: string, lines: string[]): void {
	writeFileSync(path, lines.join(""), "utf8");
}

try {
	// ── T1 全量投影行清单 ─────────────────────────────────────────────
	{
		const d = mkSessionDir();
		const file = join(d, "2026-09-22T00-00-00-000Z_aah01a-aaaa-bbbb-cccc-ddddeeeeffff.jsonl");
		writeSession(file, [
			header("aa00", "2026-09-22T00:00:00.000Z"),
			line({ type: "model_change", id: "mc1", parentId: null, timestamp: "2026-09-22T00:00:01.000Z", provider: "Zhipu", modelId: "glm" }),
			userMsg("u1", "2026-09-22T00:00:02.000Z", "帮我看看日志"),
			assistantMsg("a1", "2026-09-22T00:00:03.000Z", [
				{ type: "thinking", thinking: "先读文件" },
				{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.log" } },
				{ type: "text", text: "日志内容如下" },
			], { model: "glm-5.3", provider: "Zhipu" }),
			toolResultMsg("t1", "2026-09-22T00:00:04.000Z", "call_1", "file content here"),
			assistantMsg("a2", "2026-09-22T00:00:05.000Z", [{ type: "text", text: "结论：正常" }], { model: "glm-5.3", provider: "Zhipu" }),
			userMsg("u2", "2026-09-22T00:01:00.000Z", "谢谢"),
		]);

		const p = projectSession(file);
		assert.equal(p.found, true);
		assert.equal(p.sessionId, "aa00");
		assert.equal(p.logEpoch, "aa00", "logEpoch = 首 entry id（session 头 id）");
		assert.equal(p.head, 7, "head = 物理行号（7 行文件）");
		assert.equal(p.skippedUnknown, 1, "model_change → skip 计数");

		const kinds = p.rows.map((r) => r.kind);
		assert.deepEqual(kinds, [
			"turnHeader", "userInput",
			"reasoning", "toolCall", "assistantText",
			"assistantText",
			"turnHeader", "userInput",
		], "行清单 = 五种自包含行（assistant 按内容分片拆行；toolResult 不产新行）");

		const turn0 = p.rows[0] as Extract<TranscriptRow, { kind: "turnHeader" }>;
		assert.equal(turn0.rowId, "t_u1");
		assert.equal(turn0.turnIndex, 1);
		assert.equal(turn0.startedAt, "2026-09-22T00:00:02.000Z");
		assert.equal(turn0.durationMs, 58000, "闭合 turn：时长 = 下一 user message 时刻差");

		const userInput = p.rows[1] as Extract<TranscriptRow, { kind: "userInput" }>;
		assert.equal(userInput.rowId, "r_u1_0");
		assert.equal(userInput.turnIndex, 1);
		assert.equal(userInput.text, "帮我看看日志");

		const reasoning = p.rows[2] as Extract<TranscriptRow, { kind: "reasoning" }>;
		assert.equal(reasoning.rowId, "r_a1_0");
		assert.equal(reasoning.text, "先读文件");
		assert.equal(reasoning.model, "glm-5.3");
		assert.equal(reasoning.provider, "Zhipu");
		assert.equal(reasoning.turnIndex, 1, "turn = 行上标签");

		const toolCall = p.rows[3] as Extract<TranscriptRow, { kind: "toolCall" }>;
		assert.equal(toolCall.rowId, "r_a1_1");
		assert.equal(toolCall.callId, "call_1");
		assert.equal(toolCall.name, "read");
		assert.deepEqual(toolCall.arguments, { path: "a.log" });
		assert.equal(toolCall.status, "done", "toolResult 回填 → done");
		assert.equal(toolCall.output, "file content here", "自包含：结果内联");

		const lastTurn = p.rows[6] as Extract<TranscriptRow, { kind: "turnHeader" }>;
		assert.equal(lastTurn.durationMs, undefined, "进行中 turn 不带时长");
		assert.equal(lastTurn.turnIndex, 2);
	}

	// ── T2 投影幂等 ──────────────────────────────────────────────────
	{
		const d = mkSessionDir();
		const file = join(d, "x_aab1-2222-3333-4444-555566667777.jsonl");
		writeSession(file, [
			header("bb00", "2026-09-22T01:00:00.000Z"),
			userMsg("u1", "2026-09-22T01:00:01.000Z", "hi"),
			assistantMsg("a1", "2026-09-22T01:00:02.000Z", [{ type: "text", text: "hello" }]),
			toolResultMsg("t9", "2026-09-22T01:00:03.000Z", "call_unknown", "orphan"),
		]);
		const p1 = projectSession(file);
		const p2 = projectSession(file);
		assert.equal(JSON.stringify(p1), JSON.stringify(p2), "同 JSONL 重投影 → 逐字节一致");
	}

	// ── T3 增量 == 全量 ──────────────────────────────────────────────
	{
		const d = mkSessionDir();
		const file = join(d, "y_aac1-2222-3333-4444-555566667777.jsonl");
		const lines = [
			header("cc00", "2026-09-22T02:00:00.000Z"),
			userMsg("u1", "2026-09-22T02:00:01.000Z", "第一轮"),
			assistantMsg("a1", "2026-09-22T02:00:02.000Z", [{ type: "toolCall", id: "c1", name: "ls", arguments: {} }]),
			toolResultMsg("t1", "2026-09-22T02:00:03.000Z", "c1", "a.txt"),
			userMsg("u2", "2026-09-22T02:00:04.000Z", "第二轮"),
			assistantMsg("a2", "2026-09-22T02:00:05.000Z", [{ type: "text", text: "完成" }]),
		];
		writeSession(file, lines);
		const projector = createTranscriptProjector();
		let seq = 0;
		for (const l of lines.slice(0, 3)) projector.ingestEntry(JSON.parse(l), ++seq);
		const mid = projector.snapshot();
		assert.equal(mid.rows.length, 3, "中段：turnHeader+userInput+toolCall(running)");
		for (const l of lines.slice(3)) projector.ingestEntry(JSON.parse(l), ++seq);
		const inc = projector.snapshot();
		const full = projectSession(file);
		assert.equal(JSON.stringify(inc.rows), JSON.stringify(full.rows), "增量终态 == 全量投影（rows 逐字节一致）");
		assert.equal(inc.head, full.head);
	}

	// ── T4 未知条目 skip+计数 + session_info state.updated ───────────
	{
		const d = mkSessionDir();
		const file = join(d, "z_aad1-2222-3333-4444-555566667777.jsonl");
		writeSession(file, [
			header("dd00", "2026-09-22T03:00:00.000Z"),
			line({ type: "thinking_level_change", id: "t1", parentId: null, timestamp: "2026-09-22T03:00:00.500Z", thinkingLevel: "high" }),
			line({ type: "compaction", id: "cp1", parentId: null, timestamp: "2026-09-22T03:00:00.600Z", summary: "s", firstKeptEntryId: "x", tokensBefore: 1 }),
			line({ type: "custom", id: "cu1", parentId: null, timestamp: "2026-09-22T03:00:00.700Z", customType: "pi-codex-goal", data: {} }),
			line({ type: "custom_message", id: "cm1", parentId: null, timestamp: "2026-09-22T03:00:00.800Z", customType: "x", content: "y", display: true }),
			line({ type: "label", id: "lb1", parentId: null, timestamp: "2026-09-22T03:00:00.900Z", targetId: "x", label: "L" }),
			line({ type: "session_info", id: "si1", parentId: null, timestamp: "2026-09-22T03:00:01.000Z", name: "我的会话" }),
			line({ type: "message", id: "u1", parentId: null, timestamp: "2026-09-22T03:00:02.000Z", message: { role: "user", content: [{ type: "image", data: "xxx" }, { type: "text", text: "看图" }] } }),
			line({ type: "totally_unknown", id: "uk1", parentId: null, timestamp: "2026-09-22T03:00:03.000Z" }),
			line({ type: "message", id: "a1", parentId: null, timestamp: "2026-09-22T03:00:04.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "f", arguments: {} }] } }),
			line({ type: "message", id: "tr1", parentId: null, timestamp: "2026-09-22T03:00:05.000Z", message: { role: "toolResult", toolCallId: "c_missing", toolName: "f", content: [] } }),
		]);
		const p = projectSession(file);
		// skip 计数：thinking_level_change + compaction + custom + custom_message + label
		//          + image 分片 + totally_unknown + c_missing 的 toolResult = 8
		assert.equal(p.skippedUnknown, 8, `实际 ${p.skippedUnknown}`);
		assert.equal(p.name, "我的会话", "session_info.name 进状态面");
		// state.updated 发射（P1 唯一 state 发射点）在 ops 流里可见：
		const ops = (() => {
			const proj = createTranscriptProjector();
			const out: TranscriptOp[] = [];
			let seq = 0;
			for (const l of [
				header("dd00", "2026-09-22T03:00:00.000Z"),
				line({ type: "session_info", id: "si1", parentId: null, timestamp: "2026-09-22T03:00:01.000Z", name: "我的会话" }),
			]) out.push(...proj.ingestEntry(JSON.parse(l), ++seq));
			return out;
		})();
		assert.deepEqual(ops, [{ kind: "state.updated", patch: { name: "我的会话" } }]);
	}

	// ── T5 发射面封闭：removed/delta 永不发射 ────────────────────────
	{
		const d = mkSessionDir();
		const file = join(d, "w_aae1-2222-3333-4444-555566667777.jsonl");
		writeSession(file, [
			header("ee00", "2026-09-22T04:00:00.000Z"),
			userMsg("u1", "2026-09-22T04:00:01.000Z", "q"),
			assistantMsg("a1", "2026-09-22T04:00:02.000Z", [
				{ type: "thinking", thinking: "hmm" },
				{ type: "text", text: "answer" },
				{ type: "toolCall", id: "c1", name: "t", arguments: {} },
			]),
			toolResultMsg("t1", "2026-09-22T04:00:03.000Z", "c1", "out"),
			line({ type: "session_info", id: "si", parentId: null, timestamp: "2026-09-22T04:00:04.000Z", name: "n" }),
		]);
		const r = (() => {
			const proj = createTranscriptProjector();
			const out: TranscriptOp[] = [];
			let seq = 0;
			const raw = readFileSync(file, "utf8");
			for (const l of raw.split("\n")) {
				if (l.trim().length === 0) continue;
				out.push(...proj.ingestEntry(JSON.parse(l), ++seq));
			}
			return out;
		})();
		assert.ok(r.length > 0);
		assert.ok(r.every((o) => o.kind === "row.appended" || o.kind === "row.upserted" || o.kind === "state.updated"),
			`P1 发射面封闭：${[...new Set(r.map((o) => o.kind))].join(",")}`);
	}

	// ── T6 applyOp 语义 ──────────────────────────────────────────────
	{
		// appended 幂等
		const row: TranscriptRow = { kind: "userInput", rowId: "r1", turnIndex: 1, at: "t", text: "x" };
		let v = applyTranscriptOp(EMPTY_TRANSCRIPT_VIEW, { kind: "row.appended", row });
		v = applyTranscriptOp(v, { kind: "row.appended", row });
		assert.equal(v.rows.length, 1, "appended 重复应用幂等");
		// upserted 插入 / 整行替换
		v = applyTranscriptOp(v, { kind: "row.upserted", row: { kind: "turnHeader", rowId: "t1", turnIndex: 1, startedAt: "t" } });
		assert.equal(v.rows.length, 2, "upserted 未存在 → 插入");
		v = applyTranscriptOp(v, { kind: "row.upserted", row: { kind: "turnHeader", rowId: "t1", turnIndex: 1, startedAt: "t", durationMs: 5 } });
		assert.equal(v.rows.length, 2);
		assert.deepEqual(v.rows.find((r) => r.rowId === "t1"), { kind: "turnHeader", rowId: "t1", turnIndex: 1, startedAt: "t", durationMs: 5 });
		// delta 仅流式文本行 + text 路径
		const at: TranscriptRow = { kind: "assistantText", rowId: "a1", turnIndex: 1, at: "t", text: "a" };
		let v2 = applyTranscriptOp(EMPTY_TRANSCRIPT_VIEW, { kind: "row.appended", row: at });
		v2 = applyTranscriptOp(v2, { kind: "row.delta", rowId: "a1", path: "text", append: "b" });
		assert.equal((v2.rows[0] as { text: string }).text, "ab");
		v2 = applyTranscriptOp(v2, { kind: "row.delta", rowId: "a1", path: "other", append: "c" });
		assert.equal((v2.rows[0] as { text: string }).text, "ab", "非 text 路径忽略");
		v2 = applyTranscriptOp(v2, { kind: "row.delta", rowId: "zz", path: "text", append: "c" });
		assert.equal(v2.rows.length, 1, "未知行 delta 忽略");
		v2 = applyTranscriptOp(v2, { kind: "row.appended", row: { kind: "toolCall", rowId: "tc1", turnIndex: 1, at: "t", callId: "c", name: "n", arguments: null, status: "running" } });
		v2 = applyTranscriptOp(v2, { kind: "row.delta", rowId: "tc1", path: "text", append: "x" });
		assert.equal((v2.rows[1] as { text?: string }).text, undefined, "非流式文本行（toolCall）delta 忽略");
		// removed 屏障截断
		let v3 = applyTranscriptOp(EMPTY_TRANSCRIPT_VIEW, { kind: "row.appended", row: { kind: "userInput", rowId: "r1", turnIndex: 1, at: "t", text: "1" } });
		v3 = applyTranscriptOp(v3, { kind: "row.appended", row: { kind: "userInput", rowId: "r2", turnIndex: 1, at: "t", text: "2" } });
		v3 = applyTranscriptOp(v3, { kind: "row.appended", row: { kind: "userInput", rowId: "r3", turnIndex: 2, at: "t", text: "3" } });
		v3 = applyTranscriptOp(v3, { kind: "row.removed", rowId: "r2" });
		assert.deepEqual(v3.rows.map((r) => r.rowId), ["r1"], "removed 删该行及之后所有");
		// state.updated 键浅合并不深合并
		let v4 = applyTranscriptOp(EMPTY_TRANSCRIPT_VIEW, { kind: "state.updated", patch: { a: { x: 1 }, b: 1 } });
		v4 = applyTranscriptOp(v4, { kind: "state.updated", patch: { a: { y: 2 } } });
		assert.deepEqual(v4.info, { a: { y: 2 }, b: 1 }, "键级整体替换，键内绝不深合并");
	}

	// ── T7 coalesce 黄金 10 例 ───────────────────────────────────────
	{
		const rowA: TranscriptRow = { kind: "assistantText", rowId: "A", turnIndex: 1, at: "t", text: "" };
		const rowB: TranscriptRow = { kind: "userInput", rowId: "B", turnIndex: 1, at: "t", text: "b" };
		const upA: TranscriptRow = { kind: "assistantText", rowId: "A", turnIndex: 1, at: "t", text: "final" };
		const d = (rowId: string, append: string, path = "text"): TranscriptOp => ({ kind: "row.delta", rowId, path, append });
		const st = (patch: Record<string, unknown>): TranscriptOp => ({ kind: "state.updated", patch });

		const cases: { name: string; ops: TranscriptOp[]; expected: TranscriptOp[] }[] = [
			{ name: "G1 空", ops: [], expected: [] },
			{ name: "G2 单 appended 直通", ops: [{ kind: "row.appended", row: rowB }], expected: [{ kind: "row.appended", row: rowB }] },
			{
				name: "G3 相邻同 (rowId,path) delta 拼接",
				ops: [{ kind: "row.appended", row: rowA }, d("A", "he"), d("A", "llo")],
				expected: [{ kind: "row.appended", row: rowA }, d("A", "hello")],
			},
			{
				name: "G4 同行不同 path 不合并",
				ops: [d("A", "x", "text"), d("A", "y", "title")],
				expected: [d("A", "x", "text"), d("A", "y", "title")],
			},
			{
				name: "G5 不同行 delta 不合并",
				ops: [d("A", "x"), d("B", "y")],
				expected: [d("A", "x"), d("B", "y")],
			},
			{
				name: "G6 相邻 state.updated 键浅合并（后者胜出）",
				ops: [st({ a: 1, b: 1 }), st({ b: 2, c: 3 }), st({ c: 3 })],
				expected: [st({ a: 1, b: 2, c: 3 })],
			},
			{
				name: "G7 upserted 吞掉紧邻同行 delta",
				ops: [d("A", "x"), d("A", "y"), { kind: "row.upserted", row: upA }],
				expected: [{ kind: "row.upserted", row: upA }],
			},
			{
				name: "G8 upserted 吞掉紧邻同行 appended",
				ops: [{ kind: "row.appended", row: rowA }, { kind: "row.upserted", row: upA }],
				expected: [{ kind: "row.upserted", row: upA }],
			},
			{
				name: "G9 removed 是屏障：合并不跨越",
				ops: [d("A", "x"), { kind: "row.removed", rowId: "A" }, d("A", "y")],
				expected: [d("A", "x"), { kind: "row.removed", rowId: "A" }, d("A", "y")],
			},
			{
				name: "G10 state.updated 隔断 delta 合并（非相邻）",
				ops: [d("A", "x"), st({ n: 1 }), d("A", "y")],
				expected: [d("A", "x"), st({ n: 1 }), d("A", "y")],
			},
		];

		for (const c of cases) {
			const coalesced = coalesceOps(c.ops);
			assert.deepEqual(coalesced, c.expected, `${c.name}：coalesce 形状`);
			const applyAll = applyTranscriptOps(EMPTY_TRANSCRIPT_VIEW, c.ops);
			const applyCoalesced = applyTranscriptOps(EMPTY_TRANSCRIPT_VIEW, coalesced);
			assert.equal(
				JSON.stringify(applyCoalesced),
				JSON.stringify(applyAll),
				`${c.name}：不变式 apply(coalesce) ≡ apply(全部)`,
			);
		}

		// 加菜：appended+delta+delta+upserted（同行）≡ [upserted] 终态一致
		const extra = [{ kind: "row.appended" as const, row: rowA }, d("A", "x"), d("A", "y"), { kind: "row.upserted" as const, row: upA }];
		const co = coalesceOps(extra);
		assert.equal(co.length, 1, "加菜：连续段整体吞掉");
		assert.equal(
			JSON.stringify(applyTranscriptOps(EMPTY_TRANSCRIPT_VIEW, co)),
			JSON.stringify(applyTranscriptOps(EMPTY_TRANSCRIPT_VIEW, extra)),
			"加菜：终态一致",
		);
	}

	// ── T8 projectSession afterSeq 增量 ──────────────────────────────
	{
		const d = mkSessionDir();
		const file = join(d, "v_aaf1-2222-3333-4444-555566667777.jsonl");
		writeSession(file, [
			header("ff00", "2026-09-22T05:00:00.000Z"),   // seq 1
			userMsg("u1", "2026-09-22T05:00:01.000Z", "q"), // seq 2
			assistantMsg("a1", "2026-09-22T05:00:02.000Z", [{ type: "toolCall", id: "c1", name: "t", arguments: {} }]), // seq 3
			toolResultMsg("t1", "2026-09-22T05:00:03.000Z", "c1", "out"), // seq 4（upsert 回填 seq3 的行）
		]);
		const full = projectSession(file);
		assert.equal(full.rows.length, 3, "turnHeader+userInput+toolCall");

		const after0 = projectSession(file, 0);
		assert.deepEqual(after0.rows, full.rows, "after=0 == 全量快照");

		const afterHead = projectSession(file, full.head);
		assert.equal(afterHead.rows.length, 0, "after=head → 空（无新触及行）");

		const after2 = projectSession(file, 2);
		assert.deepEqual(after2.rows.map((r) => r.rowId), ["r_a1_0"], "after=2：只触及 seq3/4 的行");
		const tc = after2.rows[0] as Extract<TranscriptRow, { kind: "toolCall" }>;
		assert.equal(tc.status, "done", "触及行回终态（upserted 去重）");
		assert.equal(tc.output, "out");
	}

	// ── T9 listPiSessions / findSessionFile ──────────────────────────
	{
		const root = process.env.PI_SESSIONS_DIR!;
		const d1 = join(root, "--C--test--a--");
		const d2 = join(root, "--C--test--b--");
		mkdirSync(d1, { recursive: true });
		mkdirSync(d2, { recursive: true });
		const fOld = join(d1, "2026-01-01T00-00-00-000Z_1111aaaa-2222-bbbb-cccc-ddddeeee0001.jsonl");
		const fNew = join(d2, "2026-09-22T06-00-00-000Z_1111aaaa-2222-bbbb-cccc-ddddeeee0002.jsonl");
		writeFileSync(fOld, header("1111aaaa-2222-bbbb-cccc-ddddeeee0001", "2026-01-01T00:00:00.000Z"), "utf8");
		writeFileSync(fNew, header("1111aaaa-2222-bbbb-cccc-ddddeeee0002", "2026-09-22T06:00:00.000Z"), "utf8");

		const list = listPiSessions(process.env.PI_SESSIONS_DIR!);
		assert.ok(list.length >= 2);
		assert.equal(list[0].sessionId, "1111aaaa-2222-bbbb-cccc-ddddeeee0002", "startedAt 降序");
		assert.equal(list[0].cwd, "C:\\tmp");

		const found = findSessionFile(process.env.PI_SESSIONS_DIR!, "1111aaaa-2222-bbbb-cccc-ddddeeee0001");
		assert.equal(found, fOld, "按 sessionId 定位（跨 cwd 目录）");
		assert.equal(findSessionFile(process.env.PI_SESSIONS_DIR!, "nope-not-there"), null);
		assert.equal(findSessionFile(process.env.PI_SESSIONS_DIR!, "../escape"), null, "路径注入拒绝");

		// defaultSessionsDir：env 覆盖生效
		assert.equal(defaultSessionsDir(), process.env.PI_SESSIONS_DIR);
	}

	// ── T10 never-throw：坏行/半截尾行/空文件/缺失文件 ────────────────
	{
		const d = mkSessionDir();
		const bad = join(d, "b_1111aaaa-2222-bbbb-cccc-ddddeeee0003.jsonl");
		writeFileSync(bad, [
			header("aa0", "2026-09-22T07:00:00.000Z"),
			"{not json\n",
			"[1,2,3]\n",
			"\n",
			userMsg("u1", "2026-09-22T07:00:01.000Z", "ok"),
			'{"type":"message","id":"half"', // 半截尾行（无 \n）
		].join(""), "utf8");
		const p = projectSession(bad);
		assert.equal(p.found, true);
		assert.equal(p.rows.length, 2, "坏行跳过，好行照投影");
		assert.equal(p.skippedBadLines, 2, "坏 JSON + 非对象行计数");
		assert.equal(p.skippedUnknown, 0);

		// 尾读：半截尾行不消费，追加补全后消费且行号连续
		const r1 = readSessionTail(bad, SESSION_TAIL_CURSOR_START);
		assert.equal(r1.lines.length, 2, "header+好行（坏行跳过、空行静默、半截行留待）");
		assert.equal(r1.skippedBadLines, 2, "坏 JSON + 非对象行计数");
		assert.equal(r1.truncated, false);
		assert.equal(r1.cursor.nextLineNo, 6, "行号消耗到第 6 行（完整行止）");
		appendFileSync(bad, "}\n"); // 补全半截行 → 合法 JSON object（无 message 字段 → 投影 skip）
		appendFileSync(bad, line({ type: "message", id: "a9", parentId: null, timestamp: "2026-09-22T07:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }));
		const r2 = readSessionTail(bad, r1.cursor);
		assert.equal(r2.lines.length, 2, "补全的半截行 + 新行");
		assert.deepEqual(r2.lines.map((l) => l.seq), [6, 7], "seq = 物理行号，接续不重不漏");

		// 截断检测
		writeFileSync(bad, header("fresh", "2026-09-22T08:00:00.000Z"), "utf8");
		const r3 = readSessionTail(bad, r2.cursor);
		assert.equal(r3.truncated, true, "文件变短 → truncated");
		assert.deepEqual(r3.cursor, { offset: 0, nextLineNo: 1 }, "cursor 复位");

		// 空文件 / 缺失文件
		const empty = join(d, "e.jsonl");
		writeFileSync(empty, "", "utf8");
		const pe = projectSession(empty);
		assert.equal(pe.found, true);
		assert.equal(pe.rows.length, 0);
		assert.equal(pe.head, 0);
		const missing = join(d, "missing.jsonl");
		const pm = projectSession(missing);
		assert.equal(pm.found, false);
		assert.equal(pm.rows.length, 0);
		const po = ((): number => {
			try {
				readSessionTail(missing, SESSION_TAIL_CURSOR_START);
				return 0;
			} catch {
				return 1;
			}
		})();
		assert.equal(po, 0, "缺失文件尾读 never-throw");
	}

	console.log("_test_runtime_transcript: all assertions passed");
} finally {
	for (const d of DIRS) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}
}
