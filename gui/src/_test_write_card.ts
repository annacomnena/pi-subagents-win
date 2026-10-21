/**
 * _test_write_card.ts — `write` 工具卡「落笔」纯函数层的回归门（2026-10-21）。
 *
 * 这些东西都是「错了不会崩、只会看起来不对」的类型，所以必须钉住：
 *   R1 行数不能把结尾 `\n` 算成一行（否则每个文件都报多 1 行）；
 *   R2 体积必须是 UTF-8 字节（中文 3 字节），不能用 string.length；
 *   R3 尾部滑窗必须是**绝对行号**（React 拿它当 key，回退就会重放入场动画）；
 *   R4 墨线 running 时渐近不满、done 才满、error **不画进度**（断点不可知）；
 *   R5 非 write 工具必须仍然走原 `JSON.stringify` 路径（本次改动零回归面）；
 *   R6 error 态口径：注脚不得声称“已回滚/原文件未改动”，墨线不得再内联硬写高度。
 *
 * 运行：cd gui && npm run test:write-card
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
	WRITE_ERROR_CAVEAT,
	WRITE_KEEP_ROWS,
	WRITE_VISIBLE_ROWS,
	classifyLine,
	countLines,
	deltaLabel,
	fmtBytes,
	inkHeightCss,
	inkPercent,
	isWriteTool,
	readWriteArgs,
	splitPath,
	utf8Bytes,
	visibleRows,
} from "./writeCard.ts";

let n = 0;
const ok = (name: string): void => {
	n += 1;
	console.log(`ok ${n} - ${name}`);
};

// ── 入参读取 ─────────────────────────────────────────────────────
{
	assert.deepEqual(readWriteArgs({ path: "a/b.cs", content: "x" }), { path: "a/b.cs", content: "x" });
	assert.deepEqual(readWriteArgs({ content: ["a", "b"] }), { path: "", content: "a\nb" });
	assert.deepEqual(readWriteArgs({ path: "a" }), { path: "a", content: "" }, "缺 content ⇒ 空串（渲染空白纸，不回退 JSON）");
	assert.deepEqual(readWriteArgs(null), { path: "", content: "" });
	assert.deepEqual(readWriteArgs("garbage"), { path: "", content: "" });
	ok("readWriteArgs：string / string[] / 缺失 / 非对象 五种形状");
}

// ── R1 行数（不把行终止符算成一行）────────────────────────────────
{
	assert.equal(countLines(""), 0);
	assert.equal(countLines("a"), 1);
	assert.equal(countLines("a\nb"), 2);
	assert.equal(countLines("a\nb\n"), 2, "结尾 \\n 是行终止符，不是第 3 行");
	assert.equal(countLines("a\n\nb\n"), 3, "中间空行算一行");
	ok("R1 行数：结尾换行不加 1，中间空行照算");
}

// ── R2 体积（UTF-8 字节）─────────────────────────────────────────
{
	assert.equal(utf8Bytes("abc"), 3);
	assert.equal(utf8Bytes("中文"), 6, "中文 3 字节 —— 用 length 会算成 2");
	assert.equal(fmtBytes(512), "512 B");
	assert.equal(fmtBytes(1229), "1.2 KB");
	assert.equal(fmtBytes(300 * 1024), "300 KB");
	const label = deltaLabel("中文\n中文\n", "done");
	assert.equal(label, "+2 行 · 14 B", `done 徽标形状（实得 ${label}）`);
	ok("R2 体积按 UTF-8 字节 + 行数按 R1 口径");
}

// ── R3 尾部滑窗（绝对行号）───────────────────────────────────────
{
	assert.equal(WRITE_KEEP_ROWS, WRITE_VISIBLE_ROWS + 2);
	const big = Array.from({ length: 40 }, (_, i) => `L${i + 1}`).join("\n");
	const w = visibleRows(big, WRITE_KEEP_ROWS);
	assert.equal(w.total, 40);
	assert.equal(w.rows.length, WRITE_KEEP_ROWS, `只渲染尾部 ${WRITE_KEEP_ROWS} 行（DOM 常数）`);
	assert.equal(w.rows[0]!.no, 40 - WRITE_KEEP_ROWS + 1, "首行是绝对行号，不是 1");
	assert.equal(w.rows[w.rows.length - 1]!.no, 40, "末行行号 = 总行数（与编辑器对齐）");
	assert.equal(w.rows[w.rows.length - 1]!.text, "L40");

	const small = visibleRows("a\nb", WRITE_KEEP_ROWS);
	assert.equal(small.rows.length, 2);
	assert.equal(small.rows[0]!.no, 1, "不足一窗时从第 1 行开始");

	const empty = visibleRows("", WRITE_KEEP_ROWS);
	assert.equal(empty.rows.length, 1, "空内容保留一行（光标/空白纸要落点）");
	assert.equal(empty.rows[0]!.no, 1);
	ok("R3 尾部滑窗：绝对行号 + 大文件 DOM 常数 + 空内容有落点");
}

// ── R4 墨线 ─────────────────────────────────────────────────────
{
	assert.equal(inkPercent(40, "done"), 100, "收笔给满");
	const a = inkPercent(5, "running");
	const b = inkPercent(20, "running");
	assert.ok(a > 0 && a < b, "随行数单调增长");
	assert.ok(b < 100, "running 永远不满（总行数不可知 ⇒ 不假装百分比）");
	assert.equal(inkPercent(20, "error"), inkPercent(20, "running"), "inkPercent 本身仍是 running 同式（error 的呈现由 inkHeightCss 接管）");
	assert.equal(inkHeightCss(20, "error"), undefined, "error 不给高度（断点不可知，不能伪造“写到哪”）");
	assert.equal(inkHeightCss(20, "done"), "100.0%");
	assert.match(inkHeightCss(20, "running")!, /%$/, "running 仍按渐近值画高度");
	ok("R4 墨线：渐近 / done 满 / error 不画进度");
}

// ── 状态徽标 ─────────────────────────────────────────────────────
{
	assert.equal(deltaLabel("a\nb", "running"), "2 行", "running 是过程量");
	assert.equal(deltaLabel("a\nb", "error"), "2 行 · 未确认", "error 不得断言“未写入”：覆写失败可能已截断原文件");
	ok("deltaLabel：running / done / error 三种口径");
}

// ── 路径与墨色分层 ───────────────────────────────────────────────
{
	assert.deepEqual(splitPath("G:/code/x/Agent/RoadAlignmentTool.cs"), { parent: "Agent", name: "RoadAlignmentTool.cs" });
	assert.deepEqual(splitPath("C:\\a\\b\\c.cs"), { parent: "b", name: "c.cs" });
	assert.deepEqual(splitPath("c.cs"), { parent: "", name: "c.cs" });
	assert.deepEqual(splitPath("a/b/"), { parent: "a", name: "b" }, "尾斜杠不产生空文件名");
	ok("splitPath：Win/Unix/单段/尾斜杠");

	assert.equal(classifyLine("/// <summary>"), "cmt");
	assert.equal(classifyLine("    // 注释"), "cmt");
	assert.equal(classifyLine('    [JsonProperty("x")]'), "attr");
	assert.equal(classifyLine("}"), "struct");
	assert.equal(classifyLine("    public string Name { get; set; }"), "");
	ok("classifyLine：注释 / 特性 / 结构 / 正文 四档");
}

// ── R5 接线约束（静态断言：非 write 工具零回归面）──────────────────
{
	const src = readFileSync(new URL("./pages/ChatPage.tsx", import.meta.url), "utf8");
	assert.ok(isWriteTool("write") && !isWriteTool("edit") && !isWriteTool("Write"), "只有精确 write 命中");

	assert.match(src, /<WriteCardBody\b/, "展开体里必须渲染落笔卡");
	assert.match(src, /JSON\.stringify\(row\.arguments, null, 2\)/, "非 write 工具必须保留原 pre 路径（零回归面）");
	assert.match(
		src,
		/isWrite \? readWriteArgs\(row\.arguments\) : null/,
		"只有 write 才解析落笔入参（否则所有工具都会胖一圈）",
	);
	assert.match(src, /content=\{write\.content\} status=\{row\.status\} output=\{row\.output\}/, "传入 status/output（错误注脚要用）");
	ok("R5 接线：write 走落笔卡，其余工具原路不动");
}

// ── R6 error 态口径（静态断言：注脚不得声称回滚 + 墨线不得内联硬写高度）──
{
	assert.ok(WRITE_ERROR_CAVEAT.includes("非原子"), "固定口径必须声明非原子");
	assert.ok(!/已回滚|原文件未改动/.test(WRITE_ERROR_CAVEAT), "注脚不得声称回滚");

	const src = readFileSync(new URL("./pages/WriteCard.tsx", import.meta.url), "utf8");
	assert.match(src, /WRITE_ERROR_CAVEAT/, "固定口径必须真被渲染（不是只导出）");
	assert.ok(!/style=\{\{ height: `\$\{inkPercent/.test(src), "墨线不得再内联硬写高度（error 要交给 CSS 残线）");
	ok("R6 error 口径：注脚不声称回滚 + 墨线不画进度");
}

console.log(`\n# ${n} groups passed`);
