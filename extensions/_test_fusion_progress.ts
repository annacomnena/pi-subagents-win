/**
 * _test_fusion_progress.ts — 融合者实时进度读数（2026-11-05 第 3 项显示层）。
 *
 * 背景：三路诊断 + glm-5.3-flash 一致结论「保持 headless，补显示层」。
 * 本模块是那块显示层的数据面：只读 `fusion.stdout.log` 的 json 事件流，
 * 产出「第 N turn · Xs 前 · stopReason」。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "fusion-progress-"));

const { readFusionProgress, fusionProgressLine, formatProgressAge, _resetFusionProgressCache } = await import(
	"./runtime/fusion-progress.ts"
);

const DIR = mkdtempSync(join(tmpdir(), "fp-"));
const NL = String.fromCharCode(10);
let n = 0;
const ok = (m: string): void => {
	n += 1;
	console.log(`ok ${n} - ${m}`);
};

const mkLog = (name: string, rows: Array<{ role: string; stop?: string; text?: string }>): string => {
	const p = join(DIR, name);
	writeFileSync(
		p,
		rows
			.map((r) =>
				JSON.stringify({
					type: "message_end",
					message: { role: r.role, stopReason: r.stop, content: r.text ? [{ type: "text", text: r.text }] : [] },
				}),
			)
			.join(NL) + NL,
		"utf8",
	);
	return p;
};

try {
	// ① 只数 assistant 的 message_end（user/toolResult 不算 turn）
	{
		const p = mkLog("a.jsonl", [
			{ role: "user" },
			{ role: "assistant", stop: "toolUse" },
			{ role: "toolResult" },
			{ role: "assistant", stop: "stop" },
		]);
		const r = readFusionProgress(p);
		assert.ok(r, "必须读到进度");
		assert.equal(r!.turns, 2, `只数 assistant（实得 ${r!.turns}）`);
		assert.equal(r!.lastStopReason, "stop", "最后一条 assistant 的 stopReason");
		ok("只数 assistant 的 message_end");
	}

	// ② 增量缓存：文件没变 ⇒ 复用（不会重复解析）；变了 ⇒ 重新解析
	{
		_resetFusionProgressCache();
		const p = mkLog("b.jsonl", [{ role: "assistant", stop: "toolUse" }]);
		const r1 = readFusionProgress(p);
		assert.equal(r1!.turns, 1);
		const r2 = readFusionProgress(p);
		assert.equal(r2!.turns, 1, "未变化复用缓存");
		writeFileSync(p, "{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"stopReason\":\"stop\"}}" + NL, { encoding: "utf8", flag: "a" });
		const r3 = readFusionProgress(p);
		assert.equal(r3!.turns, 2, "文件增长后必须重解析（缓存放行）");
		ok("增量缓存：未变复用 / 增长重解析");
	}

	// ③ 年龄必须给出（R-2：不能只给绝对时间）
	{
		const p = mkLog("c.jsonl", [{ role: "assistant", stop: "stop" }]);
		const past = Date.now() - 90_000;
		utimesSync(p, new Date(past), new Date(past));
		const r = readFusionProgress(p);
		assert.ok(r!.ageMs >= 80_000, `年龄应≈90s（实得 ${r!.ageMs}ms）`);
		const line = fusionProgressLine(r);
		assert.ok(line!.includes("前"), `进度行必须带「前」（R-2），实得 ${line}`);
		assert.ok(line!.includes("第 1 turn"), `进度行必须带 turn 数，实得 ${line}`);
		ok("年龄标注（R-2）+ 进度行形状");
	}

	// ④ 文件不存在 / 空流 ⇒ null（不猜，面板不能崩）
	{
		assert.equal(readFusionProgress(join(DIR, "nope.jsonl")), null, "不存在 ⇒ null");
		const empty = join(DIR, "empty.jsonl");
		writeFileSync(empty, "", "utf8");
		const r = readFusionProgress(empty);
		assert.ok(r, "空文件仍返回对象（turns=0）");
		assert.equal(r!.turns, 0);
		assert.equal(r!.lastStopReason, null);
		ok("不存在 ⇒ null / 空流 ⇒ turns=0");
	}

	// ⑤ 坏行不影响（json 流尾部可能被截断）
	{
		const p = join(DIR, "bad.jsonl");
		writeFileSync(
			p,
			"{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"stopReason\":\"toolUse\"}}" + NL + "{\"type\":\"mess",
			"utf8",
		);
		const r = readFusionProgress(p);
		assert.equal(r!.turns, 1, "坏行跳过，前面的照数");
		ok("坏行/$截断尾部容错");
	}

	// ⑥ formatProgressAge 分档
	{
		assert.equal(formatProgressAge(5_000), "5s 前");
		assert.equal(formatProgressAge(120_000), "2min 前");
		assert.equal(formatProgressAge(7_200_000), "2.0h 前");
		assert.equal(formatProgressAge(Number.NaN), "?");
		ok("formatProgressAge 分档");
	}
} finally {
	rmSync(DIR, { recursive: true, force: true, maxRetries: 2 });
}

console.log(`_test_fusion_progress: ${n} checks passed`);
