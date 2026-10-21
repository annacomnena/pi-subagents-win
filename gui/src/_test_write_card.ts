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
 *   R7 减动效：reduced-motion 块必须**同文本**盖掉每个 write-* 动画选择器（specificity 不能只“差不多”）。
 *
 * 对比度**不在这里**：`npm run test:gui-contrast` 的 ⑤ 段专管 `.write-*`（要 var()/color-mix 主题解析，
 * 本文件只有裸 hex 解析，硬凑会把暗层 fg 误配亮层 card —— 2026-10-22 L4 实际踩过一次）。
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
	assert.deepEqual(readWriteArgs({ content: "" }), { path: "", content: "" }, "空串 content 是**合法**入参 ⇒ 仍走落笔卡（空白纸）");
	// 反例自检（2026-10-22 L4 实锤）：下面四条在修复前**全部返回空串对象** ⇒ 把「拿不到 content」
	// 悄悄渲染成空白纸，原始 arguments 被吞掉（设计稿 §6 / Wiki 契约要求回退 pre）。
	assert.equal(readWriteArgs({ path: "a" }), null, "缺 content ⇒ null（回退 JSON dump，不得渲空纸吞掉原始入参）");
	assert.equal(readWriteArgs({ file_path: "a", contents: "x" }), null, "键名不对（模型发错）⇒ null，原始入参必须可见");
	assert.equal(readWriteArgs({ path: "a", content: 123 }), null, "content 非 string/string[] ⇒ null");
	assert.equal(readWriteArgs(null), null);
	assert.equal(readWriteArgs(undefined), null);
	assert.equal(readWriteArgs("garbage"), null);
	ok("readWriteArgs：string / string[] / 缺 content 回退 / 非对象 五类形状");
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

// ── R7 动效禁用守卫（静态断言：prefers-reduced-motion 必须按同/更高 specificity 盖掉全部 write-* 动画）──
// 反例自检（2026-10-22 L4 实锤）：修复前 `.write-sweep`（0,1,0）盖不掉
// `.write-card[data-status="done"] .write-sweep`（0,3,0）的 write-dry-sweep —— 无头 Chrome
// force-prefers-reduced-motion 下 computed animation-name 仍为 write-dry-sweep。本守卫在该 CSS 上
// 必须变红（已验证），修复后变绿。
{
	const css = readFileSync(new URL("./index.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
	const rmStart = css.indexOf("@media (prefers-reduced-motion: reduce)");
	assert.ok(rmStart >= 0, "必须有 prefers-reduced-motion 块");
	const rmBlock = css.slice(rmStart);
	const norm = (sel: string): string => sel.replace(/\s+/g, " ").trim();
	// 1) reduced-motion 块之外，所有设了 write-* 动画的选择器都是「待禁用对象」
	const animRules = [...css.slice(0, rmStart).matchAll(/([^{}]+)\{[^{}]*animation:[^;}]*write-[a-z-]/g)].flatMap((m) =>
		m[1]!.split(",").map((s) => s.trim()),
	);
	assert.ok(animRules.length >= 6, `write-* 动画选择器应 ≥6（6 个 keyframes 的消费者），实际 ${animRules.length}`);
	// 2) 每个 write-* 动画选择器都必须在 reduced-motion 块里**同文本**出现（动画:none）。
	//   不做「specificity 够高即可」的宽松匹配 —— 那会把盖在**别的元素**上的同权选择器误判为已覆盖
	//   （例：.write-delta[data-status=running] .write-dot 的 (3,0) 盖不住 .write-card[data-status=done] .write-sweep）。
	//   同文本选择器 + 块在文件末尾 ⇒ 后者胜，这是唯一无歧义的级联保证。
	const rmSelectors = [...rmBlock.matchAll(/([^{}]+)\{[^{}]*animation:\s*none/g)].flatMap((m) =>
		m[1]!.split(",").map((s) => s.trim()),
	);
	for (const sel of animRules) {
		const covered = rmSelectors.some((r) => norm(r) === norm(sel));
		assert.ok(covered, `prefers-reduced-motion 里缺少与「${sel}」同文本的 animation:none 选择器——该动画会在减动效下照播（specificity 弱化即漏网）`);
	}
	ok("R7 减动效守卫：全部 write-* 动画选择器被同/更高 specificity 禁用");
}



// ── R9 收笔时序守卫（读真实常数，防"动画被自动合上截断"复发）──────────────
// 反例自检（2026-10-22 L4 实锤）：提交 d7964db 里 `settling` 只门控动画、**不管合上**，
// 而自动合上收到 300ms 卸载延迟后就把展开体卸了 ⇒ 实测（真 Radix Collapsible + 真 WriteCardBody，
// 无头 Chrome）`settling` 起 +350ms 时 `.write-sweep` 已 ABSENT，520ms 的"墨干"只剩前 300ms。
// 本段把三个常数钉在一起：WRITE_SETTLE_MS ≥ 卸载延迟 + 最长收笔动画，且 ChatPage 里
// `holdOpen` 必须真的参与 autoExpand 的判定（不是只算不用）。
{
	const src = readFileSync(new URL("./pages/ChatPage.tsx", import.meta.url), "utf8");
	const num = (name: string): number => {
		const m = new RegExp(`const ${name}\\s*=\\s*(\\d+)`).exec(src);
		assert.ok(m, `ChatPage.tsx 里找不到常数 ${name}`);
		return Number(m[1]);
	};
	const settle = num("WRITE_SETTLE_MS");
	const unmount = num("TOOL_CONTENT_COLLAPSE_UNMOUNT_DELAY_MS");

	// 最长收笔动画 = 扫光 520ms（index.css）。从 CSS 读，不硬编码——改动画时长必须重新审时序。
	const css = readFileSync(new URL("./index.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
	const sweep = /animation:\s*write-dry-sweep\s+(\d+)ms/.exec(css);
	const check = /animation:\s*write-check-draw\s+(\d+)ms[^;]*?(\d+)ms/.exec(css);
	assert.ok(sweep, "index.css 里找不到 write-dry-sweep 的时长");
	const sweepMs = Number(sweep[1]);
	const checkTotalMs = check ? Number(check[1]) + Number(check[2]) : 0;
	const longest = Math.max(sweepMs, checkTotalMs);

	// 收笔窗口是**动画可用时长**：settling 期间 holdOpen 保持展开（不进入 300ms 卸载倒计时），
	// settling 落下后才走「合上 → 300ms 后卸载」。所以门槛是「窗口 ≥ 最长收笔动画」，
	// 而**不是**「窗口 ≥ 卸载延迟 + 动画」（那会要求 ≥820ms，比实际需要更严）。
	assert.ok(
		settle >= longest,
		`WRITE_SETTLE_MS=${settle} 必须 ≥ 最长收笔动画 ${longest}ms（扫光 ${sweepMs} / 勾 ${checkTotalMs}），否则动画被 holdOpen 释放后的合上截断`,
	);
	// 必要性辅助（不是门槛，是“确实需要 holdOpen”的证据）：若没有 holdOpen，300ms 卸载早于 520ms 扫光。
	assert.ok(
		unmount < sweepMs,
		`本守卫的前提变了：卸载延迟 ${unmount} 已不小于扫光 ${sweepMs}，请重新审 holdOpen 是否还需要`,
	);

	// 活性：holdOpen 必须真进 autoExpand 的判定（否则"算了个寂寞"）
	// 2026-10-22 补：holdOpen 必须让位给 userLockedRef —— 否则用户在 running 时手动收起 write 卡，
	// 卡片完成瞬间会被收笔动画强行再展开 700ms 再合上（与 chatAutoExpand 的「手动优先」契约冲突）。
	assert.match(
		src,
		/const holdOpen = isWrite && settling && !userLockedRef\.current;/,
		"holdOpen 必须同时由 isWrite、settling 驱动，并对 userLockedRef 让位（用户手动收起后不得被收笔动画重新掰开）",
	);
	// 注：源码里的 want 是跨行写的（`holdOpen ⏎ ? true ⏎ : autoExpandTarget({`），token 间用 \s* 容忍换行。
	assert.match(
		src,
		/const want = holdOpen\s*\?\s*true\s*:\s*autoExpandTarget\(/,
		"压制自动合上这条接线必须仍在（holdOpen ? true : autoExpandTarget()）",
	);
	assert.match(src, /\}, \[row\.status, row\.rowId, holdOpen\]\)/, "holdOpen 必须在 autoExpand effect 的依赖里（否则 settling 落下后不会重新判定合上）");

	// 反例自检：证明本守卫的数值区间不是恒真 —— 去掉 holdOpen 时（提交 d7964db 原状）
	// 可用时长只有 300ms < 520ms，本断言必须能表达该失败。
	assert.ok(unmount + 0 <= 300, "自检：卸载延迟应仍为 300ms 档（若改大请重审本段的必要性论证）");
	assert.ok(
		unmount < sweepMs,
		`反例自检失败：若 ${unmount}ms 卸载已盖住 ${sweepMs}ms 扫光，"动画被截断"这个 finding 就不成立`,
	);
	ok("R9 收笔时序：WRITE_SETTLE ≥ 最长收笔动画；holdOpen 真压制自动合上且对用户手动操作让位");
}

// ── R5 接线约束（静态断言：非 write 工具零回归面）──────────────────
{
	const src = readFileSync(new URL("./pages/ChatPage.tsx", import.meta.url), "utf8");
	assert.ok(isWriteTool("write") && !isWriteTool("edit") && !isWriteTool("Write"), "只有精确 write 命中");

	assert.match(src, /<WriteCardBody\b/, "展开体里必须渲染落笔卡");
	// 活性断言（反例自检：2026-10-22 L4 变异实测 `{write ? (` → `{false ? (` 时旧 R5 全绿 ——
	// 只断 token 存在而不断「分支条件是 write」挡不住死分支）。
	assert.match(src, /\{write \? \(/, "write 分支必须是活的（条件就是 write 本身，不得改成恒假）");
	assert.match(src, /JSON\.stringify\(row\.arguments, null, 2\)/, "非 write 工具必须保留原 pre 路径（零回归面）");
	assert.match(
		src,
		/isWrite \? readWriteArgs\(row\.arguments\) : null/,
		"只有 write 才解析落笔入参（否则所有工具都会胖一圈）",
	);
	assert.match(
		src,
		/content=\{write\.content\}\s+status=\{row\.status\}\s+output=\{row\.output\}\s+settling=\{settling\}/,
		"传入 status/output/settling（错误注脚与收笔扫光要用）",
	);
	ok("R5 接线：write 走落笔卡，其余工具原路不动");
}

// ── R6 error 态口径（静态断言：注脚不得声称回滚 + 墨线不得内联硬写高度）──
{
	assert.ok(WRITE_ERROR_CAVEAT.includes("非原子"), "固定口径必须声明非原子");
	assert.ok(!/已回滚|原文件未改动/.test(WRITE_ERROR_CAVEAT), "注脚不得声称回滚");

	const src = readFileSync(new URL("./pages/WriteCard.tsx", import.meta.url), "utf8");
	// 活性断言（反例自检：2026-10-22 L4 变异实测 —— 把 JSX 里的 `{WRITE_ERROR_CAVEAT}` 整行删掉、
	// 只留 import，旧版 `/WRITE_ERROR_CAVEAT/` 仍是绿的 ⇒ “必须真被渲染”实际只证明了“被 import”。
	// 改为盯 JSX 文本节点：必须出现 `>{WRITE_ERROR_CAVEAT}<`（渲染表达式，不是标识符）。
	assert.match(
		src,
		/\{WRITE_ERROR_CAVEAT\}<\/span>/,
		"固定口径必须以文本节点渲染（`{WRITE_ERROR_CAVEAT}</span>`）—— 仅 import/引用不算",
	);
	assert.ok(!/style=\{\{ height: `\$\{inkPercent/.test(src), "墨线不得再内联硬写高度（error 要交给 CSS 残线）");
	ok("R6 error 口径：注脚不声称回滚 + 墨线不画进度");
}

console.log(`\n# ${n} groups passed`);
