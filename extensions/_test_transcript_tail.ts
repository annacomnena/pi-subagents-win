/**
 * _test_transcript_tail.ts — 尾窗投影（`GET /v1/sessions/:id/transcript?tail=N`）等价性与增量连续性。
 *
 * 背景（2026-10-20 用户诉求）：「读取会话很慢——改成从最新消息开始读，不要一下拉全部」。
 * 实现是 `transcript.ts::projectSessionTail`：只读文件尾部字节窗，前缀用**纯字节扫描**
 * 得到绝对行号（seq）与已关闭 turn 数（turnIndex 偏移），不解析前缀 JSON。
 *
 * 本测试钉住三件**不能靠肉眼**保证的事：
 *   T1 等价性：tail 行 == 全量投影的尾部切片（逐字段 JSON 相等；行数、rowId、turnIndex、正文全等）。
 *   T2 增量连续性：tail 返回的 `head.seq` 可直接当 `?after=` 用 ⇒ 增量返回空（不会漏/不会重）。
 *   T3 大文件走**字节窗**路径（> 2MB）时同样等价，且 `hasOlder` 语义正确。
 *
 * 运行：npm run test:transcript-tail
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { projectSession, projectSessionTail } from "./runtime/transcript.ts";

let n = 0;
const ok = (name: string): void => {
	n += 1;
	console.log(`ok ${n} - ${name}`);
};

const dirs: string[] = [];
const tmpDir = (prefix: string): string => {
	const d = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(d);
	return d;
};

/** 造一个真实形状的 pi 会话文件（header + N 轮 user/assistant(+toolCall)/toolResult）。 */
function writeSession(dir: string, name: string, turns: number, opts: { padBytes?: number; padAt?: "end" | "middle" } = {}): string {
	const sid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
	const lines: string[] = [
		JSON.stringify({ type: "session", version: 3, id: sid, timestamp: "2026-10-20T00:00:00.000Z", cwd: "C:\\work\\demo" }),
	];
	for (let i = 1; i <= turns; i += 1) {
		const at = `2026-10-20T00:${String(i % 60).padStart(2, "0")}:00.000Z`;
		lines.push(
			JSON.stringify({
				type: "message",
				id: `u${i}`,
				timestamp: at,
				message: { role: "user", content: [{ type: "text", text: `第 ${i} 轮提问` }] },
			}),
		);
		lines.push(
			JSON.stringify({
				type: "message",
				id: `a${i}`,
				timestamp: at,
				message: {
					role: "assistant",
					model: "m",
					provider: "p",
					content: [
						{ type: "text", text: `第 ${i} 轮回答` },
						{ type: "toolCall", id: `c${i}`, name: "read", arguments: { path: `f${i}.txt` } },
					],
				},
			}),
		);
		lines.push(
			JSON.stringify({
				type: "message",
				id: `r${i}`,
				timestamp: at,
				message: { role: "toolResult", toolCallId: `c${i}`, isError: false, content: [{ type: "text", text: `out ${i}` }] },
			}),
		);
		if (opts.padAt === "middle" && i === Math.max(1, Math.floor(turns / 3)) && opts.padBytes !== undefined) {
			// 超长行放在**中段**：尾部窗口仍由正常短行组成 ⇒ 能真正走到字节窗路径
			lines.push(
				JSON.stringify({
					type: "message",
					id: "padmid",
					timestamp: at,
					message: { role: "assistant", content: [{ type: "text", text: "x".repeat(opts.padBytes) }] },
				}),
			);
		}
	}
	if (opts.padBytes !== undefined && opts.padBytes > 0 && opts.padAt !== "middle") {
		// 超长行（真实形态：大附件/长输出）——用来把文件撑过 2MB 以走「字节窗」路径
		lines.push(
			JSON.stringify({
				type: "message",
				id: "pad",
				timestamp: "2026-10-20T01:00:00.000Z",
				message: { role: "assistant", content: [{ type: "text", text: "x".repeat(opts.padBytes) }] },
			}),
		);
	}
	const file = join(dir, name);
	writeFileSync(file, lines.join("\n") + "\n", "utf8");
	return file;
}

try {
	// ── T1 等价性（小文件：走全量路径后切尾）────────────────────────
	{
		const d = tmpDir("tail-t1-");
		const file = writeSession(d, "s.jsonl", 40);
		const full = projectSession(file, 0);
		assert.ok(full.rows.length > 60, `夹具应有足够行（实得 ${full.rows.length}）`);
		for (const want of [1, 10, 60]) {
			const tail = projectSessionTail(file, { rows: want });
			const expect = full.rows.slice(-want);
			assert.deepEqual(tail.rows, expect, `rows=${want}：tail 行必须与全量尾部切片逐字段相等`);
			assert.equal(tail.head, full.head, `rows=${want}：head 必须是绝对行号（WS 增量接续用）`);
			assert.equal(tail.logEpoch, full.logEpoch, `rows=${want}：logEpoch 必须一致`);
			assert.equal(tail.hasOlder, full.rows.length > want, `rows=${want}：hasOlder 语义`);
		}
		const all = projectSessionTail(file, { rows: 100000 });
		assert.equal(all.rows.length, full.rows.length, "rows 超出总数 ⇒ 返回全部");
		assert.equal(all.hasOlder, false, "rows 超出总数 ⇒ hasOlder=false");
		ok("T1 等价性：tail == 全量尾部切片（含 head/logEpoch/hasOlder）");
	}

	// ── T2 增量连续性：tail 的 head.seq 直接当 after= 用 ──────────────
	{
		const d = tmpDir("tail-t2-");
		const file = writeSession(d, "s.jsonl", 12);
		const tail = projectSessionTail(file, { rows: 5 });
		const delta = projectSession(file, tail.head);
		assert.deepEqual(delta.rows, [], "以 tail.head 为 after ⇒ 增量必须为空（不漏不重）");
		// 追加一轮后再取增量：必须只出新增行，且能被 rowId 幂等合并
		const full0 = projectSession(file, 0);
		const appendLines = [
			JSON.stringify({
				type: "message",
				id: "u99",
				timestamp: "2026-10-20T02:00:00.000Z",
				message: { role: "user", content: [{ type: "text", text: "追加的一轮" }] },
			}),
		];
		writeFileSync(file, appendLines.join("\n") + "\n", { flag: "a" });
		const delta2 = projectSession(file, tail.head);
		assert.ok(delta2.rows.length > 0, "追加后增量非空");
		assert.ok(delta2.head > full0.head, "head 前进");
		// 增量里允许出现**已持有的 rowId**，但只能是 turnHeader 的 upsert（新 user 消息会回头给上一轮
		// turnHeader 补 durationMs——这是既有语义，不是重复投递）。新行必须全是没见过的 rowId。
		const held = new Map(tail.rows.map((r) => [r.rowId, r.kind] as const));
		const fresh = delta2.rows.filter((r) => !held.has(r.rowId));
		const upserted = delta2.rows.filter((r) => held.has(r.rowId));
		assert.ok(fresh.length > 0, "追加后增量必须含新行");
		assert.ok(
			upserted.every((r) => r.kind === "turnHeader"),
			`已持有行只允许 turnHeader 回填（实得 ${upserted.map((r) => r.kind).join(",") || "none"}）`,
		);
		ok("T2 增量连续性：tail.head 可作 after= 基准（空增量 + 追加后只出新增行）");
	}

	// ── T3 大文件（> 2MB，走字节窗路径）等价性 ────────────────────────
	{
		const d = tmpDir("tail-t3-");
		// 4MB 填充 ⇒ 文件 > TAIL_WINDOW_MIN_FILE(2MB)，且行密度可估 ⇒ 走 scanPrefix + 窗口投影
		const file = writeSession(d, "big.jsonl", 30, { padBytes: 4 * 1024 * 1024, padAt: "middle" });
		const full = projectSession(file, 0);
		const tail = projectSessionTail(file, { rows: 20 });
		assert.deepEqual(tail.rows, full.rows.slice(-20), "大文件字节窗路径：tail 行 == 全量尾部切片");
		assert.equal(tail.head, full.head, "大文件：head 仍是绝对行号");
		assert.equal(tail.hasOlder, true, "大文件：hasOlder=true");
		assert.ok(tail.windowStartOffset > 0, `大文件应走字节窗（windowStartOffset=${tail.windowStartOffset}）`);
		ok("T3 大文件（字节窗路径）：等价性 + 绝对 head + hasOlder");
	}

	// ── T5 空增量快路：after ≥ 总行数 ⇒ rows=[] 且 head 仍绝对 ────────
	{
		const d = tmpDir("tail-t5-");
		const file = writeSession(d, "s.jsonl", 20);
		const full = projectSession(file, 0);
		const delta = projectSession(file, full.head);
		assert.deepEqual(delta.rows, [], "after = head ⇒ 增量为空");
		assert.equal(delta.head, full.head, "空增量仍返回绝对 head（客户端可继续接续）");
		assert.equal(delta.logEpoch, full.logEpoch, "空增量仍返回 logEpoch（代际校验用）");
		assert.equal(delta.found, true, "空增量 found=true（不是 404）");
		// 追加后同一 after 必须不再命中快路
		writeFileSync(
			file,
			JSON.stringify({ type: "message", id: "u900", timestamp: "2026-10-20T03:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "新的一轮" }] } }) + String.fromCharCode(10),
			{ flag: "a" },
		);
		const delta2 = projectSession(file, full.head);
		assert.ok(delta2.rows.length > 0, "文件追加后同一 after 返回真实增量");
		assert.ok(delta2.head > full.head, "head 前进");
		ok("T5 空增量快路：无新行时 rows=[] 且 head/logEpoch 仍是绝对值；追加后自动失效");
	}

	// ── T6 行索引增量：文件追加后 tail 仍等价（含 turnIndex 偏移）──────
	{
		const d = tmpDir("tail-t6-");
		const file = writeSession(d, "s.jsonl", 15);
		const first = projectSessionTail(file, { rows: 10 });
		const fullA = projectSession(file, 0);
		assert.deepEqual(first.rows, fullA.rows.slice(-first.rows.length), "首次 tail 等价");
		// 追加两轮（含 toolCall/toolResult 回填）
		for (const i of [90, 91]) {
			const at = `2026-10-20T04:0${i % 10}:00.000Z`;
			writeFileSync(file, JSON.stringify({ type: "message", id: `u${i}`, timestamp: at, message: { role: "user", content: [{ type: "text", text: `追加轮 ${i}` }] } }) + String.fromCharCode(10), { flag: "a" });
			writeFileSync(file, JSON.stringify({ type: "message", id: `a${i}`, timestamp: at, message: { role: "assistant", content: [{ type: "text", text: `追加答 ${i}` }, { type: "toolCall", id: `c${i}`, name: "read", arguments: {} }] } }) + String.fromCharCode(10), { flag: "a" });
			writeFileSync(file, JSON.stringify({ type: "message", id: `r${i}`, timestamp: at, message: { role: "toolResult", toolCallId: `c${i}`, isError: false, content: [{ type: "text", text: `ok ${i}` }] } }) + String.fromCharCode(10), { flag: "a" });
		}
		const fullB = projectSession(file, 0);
		const tailB = projectSessionTail(file, { rows: 10 });
		assert.deepEqual(tailB.rows, fullB.rows.slice(-tailB.rows.length), "追加后 tail 仍等价（索引增量正确）");
		assert.equal(tailB.head, fullB.head, "追加后 head 一致");
		ok("T6 行索引增量：文件追加后 tail 仍与全量等价（head/turnIndex 正确）");
	}

	// ── T7 hasOlder 到上限必须为 false（G1：按钮永不消失的 bug）──────────
	{
		const d = tmpDir("tail-t7-");
		// 造一个超过 TAIL_ROWS_MAX(5000) 行的会话：每轮 3 行 ⇒ 1800 轮 = 5400+ 行
		const file = writeSession(d, "big.jsonl", 1800);
		const full = projectSession(file, 0);
		assert.ok(full.rows.length > 5000, `夹具需 > 5000 行（实得 ${full.rows.length}）`);
		// 未到上限：还有更早的行 ⇒ true
		const small = projectSessionTail(file, { rows: 200 });
		assert.equal(small.hasOlder, true, "未到上限且有更早行 ⇒ hasOlder=true");
		// 到上限：服务端不可能再给更多 ⇒ 必须 false（否则 GUI 按钮永久显示 + 每次全量重建）
		const capped = projectSessionTail(file, { rows: 5000 });
		assert.equal(capped.rows.length, 5000, "want=5000 ⇒ 返回 5000 行");
		assert.equal(capped.hasOlder, false, "want 已达上限 ⇒ hasOlder=false（G1）");
		const over = projectSessionTail(file, { rows: 999999 });
		assert.equal(over.rows.length, 5000, "want 超上限 ⇒ 夹到 5000");
		assert.equal(over.hasOlder, false, "want 超上限 ⇒ hasOlder=false（G1）");
		ok("T7 hasOlder 到上限为 false（G1：修复「加载更早」按钮永不消失）");
	}

	// ── T4 尾部巨行（窗内 0 行）⇒ 回退全量，结果仍正确 ────────────────
	{
		const d = tmpDir("tail-t4-");
		const file = writeSession(d, "huge.jsonl", 6, { padBytes: 3 * 1024 * 1024, padAt: "end" });
		const full = projectSession(file, 0);
		const tail = projectSessionTail(file, { rows: 200 });
		assert.deepEqual(tail.rows, full.rows.slice(-200), "巨行文件：仍与全量一致（回退路径正确）");
		ok("T4 尾部巨行：回退全量后结果正确（永不比全量更少）");
	}
} finally {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

console.log(`_test_transcript_tail: all assertions passed (${n})`);
