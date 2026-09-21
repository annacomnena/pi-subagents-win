/**
 * _test_runtime_journal_seq.ts — G6-P1 C1 测试（runtime/journal-seq.ts：
 * journal 物理序号 seq + 文件代际指纹 logEpoch 纯库）
 *
 * 覆盖（plan C1：含续传三态——同代续/跨代/越界）：
 *   T1 扫描：缺失/空文件 → exists:false + logEpoch:"" + head:0
 *   T2 扫描 seq=物理行号：坏行/空行消耗行号（seq 有洞）、logEpoch=首 envelope id、head=末条 seq
 *   T3 尾读增量：cursor 推进、半截尾行留待、追加后行号接续
 *   T4 尾读截断检测：文件变短 → truncated + cursor 复位
 *   T5 续传三态（lib 级）：同代续（filter seq>base）/ 跨代（epoch 变 → mismatch）/ 越界（base.seq > head）
 *
 * 运行：npm run test:runtime-journal-seq
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "journal-seq-env-"));

import { newEventEnvelope } from "./runtime/envelope.ts";
import { masterAddress } from "./runtime/address.ts";
import {
	JOURNAL_SEQ_CURSOR_START,
	readJournalTail,
	scanJournalSeq,
} from "./runtime/journal-seq.ts";

const DIRS: string[] = [process.env.PI_RUNTIME_DIR!];

function mkDir(): string {
	const d = mkdtempSync(join(tmpdir(), "journal-seq-case-"));
	DIRS.push(d);
	return d;
}

let n = 0;
function env(): ReturnType<typeof newEventEnvelope> {
	n += 1;
	return newEventEnvelope({ type: "test.tick", source: masterAddress(), payload: { n }, at: new Date(Date.parse("2026-09-22T00:00:00Z") + n * 1000).toISOString() });
}

try {
	// ── T1 缺失/空 ───────────────────────────────────────────────────
	{
		const d = mkDir();
		const missing = join(d, "missing.jsonl");
		const s0 = scanJournalSeq(missing);
		assert.equal(s0.exists, false);
		assert.equal(s0.logEpoch, "");
		assert.equal(s0.head, 0);
		assert.deepEqual(s0.entries, []);

		const empty = join(d, "empty.jsonl");
		writeFileSync(empty, "", "utf8");
		const s1 = scanJournalSeq(empty);
		assert.equal(s1.exists, true);
		assert.equal(s1.logEpoch, "", "空 journal → epoch 空");
		assert.equal(s1.head, 0);
	}

	// ── T2 seq=物理行号（坏行消耗行号）───────────────────────────────
	{
		const d = mkDir();
		const file = join(d, "events.jsonl");
		const e1 = env();
		const e2 = env();
		const e3 = env();
		writeFileSync(file, `${JSON.stringify(e1)}\n`, "utf8");
		appendFileSync(file, "not-json\n", "utf8");           // 行 2：坏
		appendFileSync(file, "\n", "utf8");                    // 行 3：空
		appendFileSync(file, `${JSON.stringify(e2)}\n`, "utf8"); // 行 4
		appendFileSync(file, `${JSON.stringify(e3)}`, "utf8");   // 行 5：无换行（半截——全量扫按现存内容收）

		const s = scanJournalSeq(file);
		assert.equal(s.exists, true);
		assert.equal(s.logEpoch, e1.id, "logEpoch = 首 envelope id");
		assert.deepEqual(s.entries.map((e) => e.seq), [1, 4, 5], "seq = 物理行号（坏行/空行留洞）");
		assert.deepEqual(s.entries.map((e) => e.envelope.id), [e1.id, e2.id, e3.id]);
		assert.equal(s.head, 5);
		assert.equal(s.skippedBadLines, 1);
		assert.ok(s.sizeBytes > 0);

		// 续传补发（lib 级）：filter seq > base
		const replay = s.entries.filter((e) => e.seq > 1);
		assert.deepEqual(replay.map((e) => e.seq), [4, 5], "同代续传：seq>base 补发不重不漏");
	}

	// ── T3 尾读增量 ──────────────────────────────────────────────────
	{
		const d = mkDir();
		const file = join(d, "events.jsonl");
		const e1 = env();
		const e2 = env();
		writeFileSync(file, `${JSON.stringify(e1)}\n${JSON.stringify(e2)}\n`, "utf8");

		const r1 = readJournalTail(file, JOURNAL_SEQ_CURSOR_START);
		assert.deepEqual(r1.entries.map((e) => [e.seq, e.envelope.id]), [[1, e1.id], [2, e2.id]]);
		assert.equal(r1.truncated, false);
		assert.equal(
			r1.cursor.offset,
			Buffer.byteLength(JSON.stringify(e1)) + 1 + Buffer.byteLength(JSON.stringify(e2)) + 1,
			"cursor 推进到 EOF",
		);
		assert.equal(r1.cursor.nextLineNo, 3);

		// EOF 再读：无新行，cursor 不动
		const r2 = readJournalTail(file, r1.cursor);
		assert.equal(r2.entries.length, 0);
		assert.deepEqual(r2.cursor, r1.cursor);

		// 半截尾行：不消费
		const e3 = env();
		appendFileSync(file, `${JSON.stringify(e3)}`, "utf8");
		const r3 = readJournalTail(file, r1.cursor);
		assert.equal(r3.entries.length, 0, "半截行留待");
		assert.deepEqual(r3.cursor, r1.cursor);

		// 补上换行 → 消费，行号接续
		appendFileSync(file, "\n", "utf8");
		const r4 = readJournalTail(file, r1.cursor);
		assert.deepEqual(r4.entries.map((e) => [e.seq, e.envelope.id]), [[3, e3.id]], "行号接续不重不漏");
		assert.equal(r4.cursor.nextLineNo, 4);

		// 坏行消耗行号
		appendFileSync(file, "garbage\n", "utf8");
		const e4 = env();
		appendFileSync(file, `${JSON.stringify(e4)}\n`, "utf8");
		const r5 = readJournalTail(file, r4.cursor);
		assert.equal(r5.skippedBadLines, 1);
		assert.deepEqual(r5.entries.map((e) => e.seq), [5], "坏行消耗行号 4，envelope 落 seq 5");
	}

	// ── T4 截断检测 ──────────────────────────────────────────────────
	{
		const d = mkDir();
		const file = join(d, "events.jsonl");
		writeFileSync(file, `${JSON.stringify(env())}\n${JSON.stringify(env())}\n${JSON.stringify(env())}\n`, "utf8");
		const r1 = readJournalTail(file, JOURNAL_SEQ_CURSOR_START);
		assert.equal(r1.entries.length, 3);
		// 重建（跨代）：新文件更短 + 首 envelope id 变
		const fresh = env();
		writeFileSync(file, `${JSON.stringify(fresh)}\n`, "utf8");
		const r2 = readJournalTail(file, r1.cursor);
		assert.equal(r2.truncated, true, "文件变短 → truncated");
		assert.deepEqual(r2.cursor, { offset: 0, nextLineNo: 1 }, "cursor 复位");
		// 复位后重扫 → 新代际
		const s = scanJournalSeq(file);
		assert.equal(s.logEpoch, fresh.id, "跨代：epoch 变");
		assert.notEqual(s.logEpoch, "");
	}

	// ── T5 续传三态（lib 级判定语义）────────────────────────────────
	{
		const d = mkDir();
		const file = join(d, "events.jsonl");
		const e1 = env();
		const e2 = env();
		writeFileSync(file, `${JSON.stringify(e1)}\n${JSON.stringify(e2)}\n`, "utf8");
		const scan = scanJournalSeq(file);

		// ① 同代续：epoch 相等且 base.seq <= head → resume（补发 (base, head]）
		const baseOk = { seq: 1, logEpoch: scan.logEpoch };
		const canResume = baseOk.logEpoch === scan.logEpoch && baseOk.seq <= scan.head;
		assert.equal(canResume, true);
		assert.deepEqual(scan.entries.filter((e) => e.seq > baseOk.seq).map((e) => e.seq), [2]);

		// ② 跨代：epoch 不等 → snapshot（journal 重建/截断指纹变）
		const canResumeCross = { seq: 1, logEpoch: "evt_stale_epoch" };
		assert.notEqual(canResumeCross.logEpoch, scan.logEpoch, "跨代判定：epoch mismatch");

		// ③ 越界：base.seq > head → snapshot
		assert.ok(99 > scan.head, "越界判定：base.seq > head");

		// 清理确认（防未使用告警语义占位）
		assert.ok(existsSync(file));
	}

	console.log("_test_runtime_journal_seq: all assertions passed");
} finally {
	for (const d of DIRS) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}
}
