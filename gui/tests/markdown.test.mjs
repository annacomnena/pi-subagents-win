/**
 * gui/tests/markdown.test.mjs — 自研 markdown 渲染器入库回归测试（0923 任务 2005）。
 *
 * 跑法（仓库根）：`node gui/tests/markdown.test.mjs`
 * 零新增依赖：只用 node 内置 + gui 已有依赖（esbuild 打包、react/react-dom server 渲染断言）。
 *
 * 覆盖：
 *  ① XSS：恶意标签/协议/实体/属性注入必须字面显示且不产可执行节点；
 *  ② 元素清单：标题1-6/粗体/斜体/删除线/行内code/围栏code+data-lang/ul+ol嵌套/
 *     链接/引用/表格/水平线/换行/空行分段；
 *  ③ 流式容错：未闭合 ``` / ** / ` / [ 的行为确定性；
 *  ④ 围栏闭合（CommonMark 口径：同种字符、长度≥开启、独占一行）+ golden 快照。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const guiDir = path.resolve(here, "..");
const require = createRequire(import.meta.url);
const esbuild = require("esbuild");

// ── 打包渲染器（jsx automatic：Markdown.tsx 用经典 JSX 语法但无 React import）──
const entry = path.join(
	fs.mkdtempSync(path.join(os.tmpdir(), "md-test-")),
	"entry.tsx",
);
fs.writeFileSync(
	entry,
	`import React from "react";\n` +
		`import { renderToStaticMarkup } from "react-dom/server";\n` +
		`import { renderBlocks } from ${JSON.stringify(path.join(guiDir, "src", "ui", "Markdown.tsx"))};\n` +
		`export function render(src: string): string {\n` +
		`  return renderToStaticMarkup(React.createElement("div", null, renderBlocks(src)) as any);\n` +
		`}\n`,
);
const bundle = path.join(path.dirname(entry), "bundle.cjs");
esbuild.buildSync({
	entryPoints: [entry],
	bundle: true,
	platform: "node",
	format: "cjs",
	loader: { ".tsx": "tsx" },
	jsx: "automatic",
	nodePaths: [path.join(guiDir, "node_modules")],
	// react/react-dom 一并打进 bundle：bundle 落在 os.tmpdir 时 external 无法就地解析；
	// 仍零新增依赖（只用 gui 已有依赖）。
	outfile: bundle,
	logLevel: "silent",
});
const { render } = require(bundle);

// ── 迷你断言架 ──
let pass = 0;
let fail = 0;
const failures = [];
function t(name, fn) {
	try {
		fn();
		pass += 1;
		console.log(`ok - ${name}`);
	} catch (e) {
		fail += 1;
		failures.push(name);
		console.log(`not ok - ${name}: ${e instanceof Error ? e.message : String(e)}`);
	}
}
function assert(cond, msg) {
	if (!cond) throw new Error(msg);
}
const has = (html, s, msg) => assert(html.includes(s), msg ?? `缺 ${JSON.stringify(s)}`);
const hasNo = (html, s, msg) => assert(!html.includes(s), msg ?? `不应含 ${JSON.stringify(s)}`);

const CODE_OPEN = '<code class="md-inline-code">';

// ── ① XSS：必须字面显示且不产可执行节点 ──
t("xss: <img onerror> 字面显示，不产 <img>", () => {
	const html = render('<img src=x onerror=alert(1)>');
	hasNo(html, "<img");
	has(html, "&lt;img");
	has(html, "onerror=alert(1)"); // 作为文本保留（无执行语义）
});
t("xss: <script> 字面显示，不产 <script>", () => {
	const html = render("<script>alert(1)</script>");
	hasNo(html, "<script");
	has(html, "&lt;script&gt;");
});
t("xss: SVG onload 攻击向量按文本转义", () => {
	const html = render('<svg onload="alert(1)"><circle/></svg>');
	hasNo(html, "<svg");
	hasNo(html, "<circle");
	has(html, '&lt;svg onload=&quot;alert(1)&quot;&gt;', `SVG 应转义为文本：${html}`);
});
t("xss: javascript: 链接不产 <a>，整段字面", () => {
	const html = render("[点我](javascript:alert(1))");
	hasNo(html, "<a");
	has(html, "[点我](javascript:alert(1))");
});
t("xss: data: 链接不产 <a>", () => {
	const html = render("[x](data:text/html,<script>alert(1)</script>)");
	hasNo(html, "<a");
});
t("xss: vbscript: 链接不产 <a>", () => {
	const html = render("[x](vbscript:msgbox(1))");
	hasNo(html, "<a");
});
t("xss: HTML 实体输入被转义，不形成标签", () => {
	const html = render("&lt;img src=x onerror=y&gt;");
	has(html, "&amp;lt;img");
	hasNo(html, "<img");
});
t("xss: 链接属性注入（url 内空白）不成链", () => {
	const html = render('[x](https://a.com" onclick="alert(1))');
	hasNo(html, "<a");
	// onclick= 仅作为文本节点残留（前后是转义文本、无标签语义），不断言其缺席
	has(html, "[x](https://a.com");
});
t("xss: 合法 http(s) 链接仍产 <a> 且带 noopener", () => {
	const html = render("[ok](https://example.com/a)");
	has(html, '<a href="https://example.com/a" target="_blank" rel="noopener noreferrer">');
});
t("xss: 行内 code 内容不解析链接/标签", () => {
	const html = render("`<script>`");
	has(html, "&lt;script&gt;");
	hasNo(html, "<script");
});
t("xss: 围栏代码内容原样转义", () => {
	const html = render("```\n<script>alert(1)</script>\n```");
	hasNo(html, "<script");
	has(html, "&lt;script&gt;");
});

// ── ② 元素清单 ──
t("el: 标题 h1-h6", () => {
	for (let lv = 1; lv <= 6; lv += 1) {
		const html = render(`${"#".repeat(lv)} T${lv}`);
		has(html, `<h${lv} class="md-h${lv}">T${lv}</h${lv}>`);
	}
});
t("el: 粗体/斜体/删除线/行内 code", () => {
	const html = render("**b** *i* ~~d~~ `c`");
	has(html, "<strong>");
	has(html, "<em>");
	has(html, "<del>");
	has(html, CODE_OPEN);
});
t("el: 围栏代码块带 data-lang", () => {
	const html = render("```js\nconst a = 1;\n```");
	has(html, 'data-lang="js"');
	has(html, "const a = 1;");
});
t("el: 无语言围栏无 data-lang 属性", () => {
	const html = render("```\nplain\n```");
	hasNo(html, "data-lang");
	has(html, "plain");
});
t("el: 波浪围栏 ~~~", () => {
	const html = render("~~~\ntilde\n~~~");
	has(html, "tilde");
	has(html, "<pre");
});
t("el: ul 嵌套 + ol 嵌套（子列表保型）", () => {
	const html = render("- a\n  - a1\n- b\n\n1. x\n   1. x1\n2. y");
	has(html, '<ul class="md-ul">');
	has(html, '<ol class="md-ol">');
	has(html, "a1");
	has(html, "x1");
});
t("el: 引用（含嵌套）", () => {
	const html = render("> q1\n>> q2");
	has(html, "<blockquote");
	has(html, "q1");
	has(html, "q2");
});
t("el: 表格（表头+数据行）", () => {
	const html = render("| a | b |\n|---|---|\n| 1 | 2 |");
	has(html, "<table");
	has(html, "<th");
	has(html, "<td");
	has(html, ">1<");
});
t("el: 水平线 ---/ ***/___", () => {
	for (const hr of ["---", "***", "___"]) {
		has(render(hr), '<hr class="md-hr"');
	}
});
t("el: 单换行→<br>，空行→分段", () => {
	const html = render("l1\nl2\n\np2");
	has(html, "<br");
	const ps = html.match(/<p class="md-p">/g) ?? [];
	assert(ps.length === 2, `期望 2 个段落，实际 ${ps.length}`);
});

// ── ③ 流式容错：未闭合构造行为确定 ──
t("stream: 未闭合 ``` 收至文本尾为代码块", () => {
	const html = render("前言\n```js\nconst a = 1;\n未完待续");
	has(html, "前言");
	has(html, "<pre");
	has(html, "未完待续");
});
t("stream: 未闭合 ``` 后续闭合恢复（前后一致）", () => {
	const before = render("```\na");
	const after = render("```\na\n```\n后文");
	has(before, "<pre");
	has(after, "后文");
	hasNo(after, "后文</code>", "后文不应留在代码块内");
});
t("stream: 未闭合 ** 按字面，不产 <strong>", () => {
	const html = render("前文 **未闭合");
	hasNo(html, "<strong>");
	has(html, "前文");
	has(html, "**未闭合");
});
t("stream: 未闭合行内 ` 按字面，不产 code", () => {
	const html = render("前文 `未闭合");
	hasNo(html, CODE_OPEN);
	has(html, "前文");
});
t("stream: 未闭合 [ 按字面", () => {
	const html = render("前文 [未闭合");
	hasNo(html, "<a");
	has(html, "[未闭合");
});

// ── ④ 围栏闭合（CommonMark 口径） ──
t("fence: 闭合行带 info 尾巴不闭合（旧 startsWith 会误判）", () => {
	const html = render("```\ncode1\n```js tail\ncode2\n```");
	// 尾巴行不是合法闭合：应留在代码块内，后文 code2 仍在块内
	has(html, "```js tail");
	has(html, "code2");
	const preBody = html.slice(html.indexOf("<pre"), html.indexOf("</pre>"));
	assert(preBody.includes("code2"), "code2 应仍在代码块内");
});
t("fence: 更短 run 不闭合（```` 开启，``` 不闭合）", () => {
	const html = render("````\ninner ``` text\n````");
	const preBody = html.slice(html.indexOf("<pre"), html.indexOf("</pre>"));
	assert(preBody.includes("inner ``` text"), "短 run 行应留在代码块内");
});
t("fence: 更长同种 run 合法闭合（```` 闭合 ``` 开启）", () => {
	const html = render("```\nbody\n````\n后文");
	has(html, "body");
	has(html, "后文");
	const tail = html.slice(html.indexOf("</pre>"));
	has(tail, "后文", "后文应在代码块外");
});
t("fence: 异种字符不闭合（``` 开启，~~~ 不闭合）", () => {
	const html = render("```\n~~~\n```");
	const preBody = html.slice(html.indexOf("<pre"), html.indexOf("</pre>"));
	assert(preBody.includes("~~~"), "~~~ 应留在 ` 围栏块内");
});
t("fence: ≥4 空格缩进的 ``` 不闭合", () => {
	const html = render("```\nbody\n    ```\nmore\n```");
	const preBody = html.slice(html.indexOf("<pre"), html.indexOf("</pre>"));
	assert(preBody.includes("more"), "缩进闭合无效时 more 应仍在块内");
});
t("fence: ≤3 空格缩进的闭合有效", () => {
	const html = render("```\nbody\n   ```\n后文");
	const tail = html.slice(html.indexOf("</pre>"));
	has(tail, "后文", "3 空格缩进闭合应有效");
});
t("fence: golden——常规围栏输出快照（防渲染回归）", () => {
	const html = render("# T\n\nhello **b**\n\n```js\nconst a = 1;\n```\n");
	const expected =
		'<div><h1 class="md-h1">T</h1>' +
		'<p class="md-p">hello <strong>b</strong></p>' +
		'<pre class="md-pre" data-lang="js"><code>const a = 1;</code></pre></div>';
	assert(html === expected, `golden 失配：\n实际：${html}\n期望：${expected}`);
});

// ── 汇总 ──
console.log(`\n${pass + fail} tests, ${pass} passed, ${fail} failed`);
if (fail > 0) {
	console.log(`failures: ${failures.join("; ")}`);
	process.exit(1);
}
