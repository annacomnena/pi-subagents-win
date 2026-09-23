/**
 * gui/src/ui/Markdown.tsx — 自研零依赖 markdown 渲染器（0923 2003，plans/0923_gui_ux_fix_plan.md B）。
 *
 * 安全边界（XSS 面最小化）：
 * - 只产 React 元素、永不 innerHTML / dangerouslySetInnerHTML ⇒ 文本 child 由 React 自动转义，
 *   无任何 HTML 解析路径（`<img onerror>` / `<script>` 一律按字面文本显示）；
 * - 链接协议白名单仅 http/https，其余（javascript:/data:/vbscript: 等）降级为字面文本不产 <a>；
 * - 外链 target=_blank rel="noopener noreferrer"；代码块仅 <pre><code> 文本节点，无 eval、无高亮库。
 *
 * 元素覆盖：标题 #~###### / 粗体 ** / 斜体 *、_ / 删除线 ~~ / 行内 code ` / 围栏代码块 ```（语言
 * 标注） / 无序列表 -、*、+（含嵌套） / 有序列表 1.（含嵌套） / 链接 [text](url) /
 * 引用 >（可嵌套，内部递归块解析） / 表格 |（表头 + 分隔行 + 数据行） / 水平线 ---、***、___ /
 * 单换行→<br> + 空行→段落。
 *
 * 流式容错（每帧全文重解析，KB 级可忽略；单调不闪烁）：
 * - 未闭合 ``` 围栏 → 渲染为代码块到文本尾（闭合后自动还原为普通文本）；
 * - 未闭合 ** / ` / ~~ / [ → 按字面文本显示（不产半截元素）。
 *
 * 参考 zcode packages/ui/src/components/ai-elements/message.tsx（streamdown 库方案：元素划分与
 * 流式容错思想借鉴）；本仓禁用新依赖（gui/package.json 零 markdown 依赖纪律），故自研。
 */

import { useMemo, type ReactElement, type ReactNode } from "react";

// ── 行内解析（手扫：取最早出现的构造；未闭合 → 字面文本）─────────────────

const isSpace = (c: string): boolean => c === " " || c === "\t";

/** 链接目标协议白名单：仅 http/https（其余一律不产 <a>，渲染为字面文本）。 */
function safeUrl(url: string): string | null {
	const t = url.trim();
	if (/^https?:\/\//i.test(t)) return t;
	return null;
}

/** [text](url)：text 内可含转义 \[ \]；url 内无空白/右括号。返回消费长度或 null。 */
function tryLink(text: string, i: number): { len: number; text: string; url: string } | null {
	if (text[i] !== "[") return null;
	let j = i + 1;
	let depth = 1;
	let buf = "";
	while (j < text.length && depth > 0) {
		const c = text[j];
		if (c === "\\" && j + 1 < text.length && (text[j + 1] === "]" || text[j + 1] === "[")) {
			buf += text[j + 1];
			j += 2;
			continue;
		}
		if (c === "[") depth += 1;
		if (c === "]") {
			depth -= 1;
			if (depth === 0) break;
		}
		buf += c;
		j += 1;
	}
	if (depth !== 0 || j + 1 >= text.length || text[j + 1] !== "(") return null;
	j += 2;
	let u = "";
	while (j < text.length && text[j] !== ")" && !isSpace(text[j])) {
		u += text[j];
		j += 1;
	}
	if (j >= text.length || text[j] !== ")") return null;
	return { len: j + 1 - i, text: buf, url: u };
}

/** 在 text[i..] 找结束标记 end 的精确 run（* 与 _ 防尾部粘连歧义）。 */
function findClose(text: string, i: number, end: string): number {
	for (let j = i; j + end.length <= text.length; j += 1) {
		if (text.slice(j, j + end.length) !== end) continue;
		const before = j - 1;
		const after = j + end.length;
		if (end.length === 1 && (before >= 0 && text[before] === end || after < text.length && text[after] === end)) continue;
		return j;
	}
	return -1;
}

function renderInline(text: string, keyBase: string): ReactNode[] {
	const out: ReactNode[] = [];
	let i = 0;
	let k = 0;
	const pushText = (s: string): void => {
		if (s.length > 0) out.push(s);
	};
	while (i < text.length) {
		const c = text[i];
		// 行内 code：`...`（未闭合 → 字面文本）
		if (c === "`") {
			const close = findClose(text, i + 1, "`");
			if (close > i) {
				out.push(<code key={`${keyBase}c${k++}`} className="md-inline-code">{text.slice(i + 1, close)}</code>);
				i = close + 1;
				continue;
			}
			pushText(c);
			i += 1;
			continue;
		}
		// 链接 [text](url)：协议非 http/https 或未闭合 → 字面文本
		if (c === "[") {
			const link = tryLink(text, i);
			if (link !== null) {
				if (safeUrl(link.url) !== null) {
					const key = `${keyBase}a${k++}`;
					out.push(
						<a key={key} href={link.url} target="_blank" rel="noopener noreferrer">
							{renderInline(link.text, key)}
						</a>,
					);
					i += link.len;
					continue;
				}
				pushText(text.slice(i, i + link.len));
				i += link.len;
				continue;
			}
			pushText(c);
			i += 1;
			continue;
		}
		// 粗体 ** / __（优先于斜体）
		if ((c === "*" || c === "_") && i + 1 < text.length && text[i + 1] === c) {
			const close = findClose(text, i + 2, c + c);
			if (close > i) {
				const key = `${keyBase}b${k++}`;
				out.push(<strong key={key}>{renderInline(text.slice(i + 2, close), key)}</strong>);
				i = close + 2;
				continue;
			}
		}
		// 删除线 ~~
		if (c === "~" && i + 1 < text.length && text[i + 1] === "~") {
			const close = findClose(text, i + 2, "~~");
			if (close > i) {
				const key = `${keyBase}d${k++}`;
				out.push(<del key={key}>{renderInline(text.slice(i + 2, close), key)}</del>);
				i = close + 2;
				continue;
			}
		}
		// 斜体 * / _
		if (c === "*" || c === "_") {
			const close = findClose(text, i + 1, c);
			if (close > i + 1) {
				const key = `${keyBase}e${k++}`;
				out.push(<em key={key}>{renderInline(text.slice(i + 1, close), key)}</em>);
				i = close + 1;
				continue;
			}
		}
		pushText(c);
		i += 1;
	}
	return out;
}

// ── 块级解析 ─────────────────────────────────────────────────────

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+-]*)\s*$/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*)$/;
const HR_RE = /^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;
const LIST_ITEM_RE = /^(\s*)([-*+]|\d{1,9}\.)\s+(.*)$/;

/**
 * 闭合围栏判定（CommonMark 口径）：同种字符（` 或 ~ 不混用）、run 长度≥开启长度、
 * 至多 3 空格缩进、行内除前后空白外无他物（闭合行不带 info string）。
 * 旧逻辑 `trimStart().startsWith(marker)` 偏宽：会把带尾随内容（如 ```js 尾巴）的行
 * 误判为闭合，且无视 ≥4 空格缩进。注意 run 更长（如 ```` 闭合 ```）按口径是合法闭合。
 */
function isClosingFence(line: string, openChar: string, openLen: number): boolean {
	const m = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
	if (m === null || m[1] === undefined) return false;
	const run: string = m[1];
	return run[0] === openChar && run.length >= openLen;
}
const TABLE_SEP_RE = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;

function splitTableRow(line: string): string[] {
	let t = line.trim();
	if (t.startsWith("|")) t = t.slice(1);
	if (t.endsWith("|")) t = t.slice(0, -1);
	return t.split("|").map((s) => s.trim());
}

function renderParagraph(lines: string[], keyBase: string): ReactElement {
	const parts: ReactNode[] = [];
	lines.forEach((ln, idx) => {
		if (idx > 0) parts.push(<br key={`${keyBase}br${idx}`} />);
		parts.push(...renderInline(ln, `${keyBase}p${idx}`));
	});
	return <p key={keyBase} className="md-p">{parts}</p>;
}

function renderTable(header: string, bodyLines: string[], keyBase: string): ReactElement {
	const headCells = splitTableRow(header);
	const rows: string[][] = bodyLines.map(splitTableRow);
	return (
		<div key={keyBase} className="md-table-wrap">
			<table className="md-table">
				<thead>
					<tr>
						{headCells.map((c, i) => (
							<th key={i} className="md-th">
								{renderInline(c, `${keyBase}th${i}`)}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{rows.map((r, ri) => (
						<tr key={ri}>
							{r.map((c, ci) => (
								<td key={ci} className="md-td">
									{renderInline(c, `${keyBase}td${ri}-${ci}`)}
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

interface ListItem {
	indent: number;
	ordered: boolean;
	text: string;
	children: ListItem[];
}

function parseListItems(lines: string[], start: number, baseIndent: number): { items: ListItem[]; next: number } {
	const items: ListItem[] = [];
	let i = start;
	while (i < lines.length) {
		const ln = lines[i];
		if (ln.trim() === "") {
			// 空行后若仍是同/更深缩进列表项则续，否则列表结束
			let j = i + 1;
			while (j < lines.length && lines[j].trim() === "") j += 1;
			if (j < lines.length) {
				const m = LIST_ITEM_RE.exec(lines[j]);
				if (m !== null && m[1].length >= baseIndent) {
					i = j;
					continue;
				}
			}
			break;
		}
		const m = LIST_ITEM_RE.exec(ln);
		if (m === null) break;
		const indent = m[1].length;
		if (indent < baseIndent) break;
		if (indent > baseIndent) {
			// 更深层嵌套：挂到最后一个 item
			const sub = parseListItems(lines, i, indent);
			const last = items[items.length - 1];
			if (last !== undefined) last.children = [...last.children, ...sub.items];
			i = sub.next;
			continue;
		}
		items.push({ indent, ordered: /^\d+\.$/.test(m[2]), text: m[3], children: [] });
		i += 1;
		// 续行（更深缩进的非列表文本）并入 item 文本
		while (i < lines.length) {
			const nl = lines[i];
			if (nl.trim() === "") break;
			const nm = LIST_ITEM_RE.exec(nl);
			if (nm === null) {
				if (nl.trimStart().length - nl.length < baseIndent) break;
				const lastItem = items[items.length - 1];
				if (lastItem !== undefined) lastItem.text += ` ${nl.trim()}`;
				i += 1;
				continue;
			}
			break;
		}
	}
	return { items, next: i };
}

function renderListItem(item: ListItem, keyBase: string): ReactNode {
	const content: ReactNode[] = [
		<span key={`${keyBase}t`} className="md-li-text">
			{renderInline(item.text, `${keyBase}t`)}
		</span>,
	];
	if (item.children.length > 0) content.push(renderList(item.children, `${keyBase}sub`));
	return (
		<li key={keyBase} className="md-li">
			{content}
		</li>
	);
}

/** 列表（类型由首 item 决定：嵌套子列表各自保型）。 */
function renderList(items: ListItem[], keyBase: string): ReactElement {
	const body = items.map((it, i) => renderListItem(it, `${keyBase}i${i}`));
	const ordered = items[0]?.ordered === true;
	if (ordered) return <ol key={keyBase} className="md-ol">{body}</ol>;
	return <ul key={keyBase} className="md-ul">{body}</ul>;
}

/** 标题（1-6 级显式分支；# 后无内容 = 标题，空内容 = 空标题）。 */
function renderHeading(level: number, text: string, key: string): ReactElement {
	const content = renderInline(text, key);
	switch (level) {
		case 1:
			return <h1 key={key} className="md-h1">{content}</h1>;
		case 2:
			return <h2 key={key} className="md-h2">{content}</h2>;
		case 3:
			return <h3 key={key} className="md-h3">{content}</h3>;
		case 4:
			return <h4 key={key} className="md-h4">{content}</h4>;
		case 5:
			return <h5 key={key} className="md-h5">{content}</h5>;
		default:
			return <h6 key={key} className="md-h6">{content}</h6>;
	}
}

/** 块级入口：按行扫描（代码块/表格/列表/引用为整体消费，段落按空行切分）。 */
export function renderBlocks(src: string): ReactNode[] {
	const lines: string[] = src.replace(/\r\n?/g, "\n").split("\n");
	const out: ReactNode[] = [];
	let i = 0;
	let kb = 0;
	let para: string[] = [];
	const flushPara = (): void => {
		if (para.length === 0) return;
		out.push(renderParagraph(para, `p${kb++}`));
		para = [];
	};
	while (i < lines.length) {
		const ln = lines[i];
		if (ln.trim() === "") {
			flushPara();
			i += 1;
			continue;
		}
		// 围栏代码块（未闭合 → 到文本尾；语言标注进 data-lang）
		const fence = FENCE_RE.exec(ln);
		if (fence !== null) {
			flushPara();
			const marker = fence[1];
			const lang = fence[2];
			const openChar = marker[0] as string;
			const openLen = marker.length;
			const buf: string[] = [];
			i += 1;
			while (i < lines.length && !isClosingFence(lines[i] as string, openChar, openLen)) {
				buf.push(lines[i]);
				i += 1;
			}
			if (i < lines.length) i += 1; // 跳过闭合行（未闭合则 i 已到文本尾）
			out.push(
				<pre key={`f${kb++}`} className="md-pre" data-lang={lang !== "" ? lang : undefined}>
					<code>{buf.join("\n")}</code>
				</pre>,
			);
			continue;
		}
		// 标题
		const h = HEADING_RE.exec(ln);
		if (h !== null) {
			flushPara();
			const key = `h${kb++}`;
			out.push(renderHeading(h[1].length, h[2], key));
			i += 1;
			continue;
		}
		// 水平线
		if (HR_RE.test(ln)) {
			flushPara();
			out.push(<hr key={`x${kb++}`} className="md-hr" />);
			i += 1;
			continue;
		}
		// 表格：当前行含 | 且下一行为分隔行
		if (ln.includes("|") && i + 1 < lines.length && lines[i + 1] !== undefined && lines[i + 1].includes("-") && TABLE_SEP_RE.test(lines[i + 1])) {
			flushPara();
			const header = ln;
			i += 2;
			const body: string[] = [];
			while (i < lines.length && lines[i].trim() !== "" && lines[i].includes("|")) {
				body.push(lines[i]);
				i += 1;
			}
			out.push(renderTable(header, body, `t${kb++}`));
			continue;
		}
		// 引用（连续 > 行，内部递归块解析；支持 >> 嵌套）
		if (QUOTE_RE.test(ln)) {
			flushPara();
			const buf: string[] = [];
			while (i < lines.length) {
				const q = QUOTE_RE.exec(lines[i]);
				if (q === null) break;
				buf.push(q[1]);
				i += 1;
			}
			out.push(
				<blockquote key={`q${kb++}`} className="md-quote">
					{renderBlocks(buf.join("\n"))}
				</blockquote>,
			);
			continue;
		}
		// 列表
		const lm = LIST_ITEM_RE.exec(ln);
		if (lm !== null) {
			flushPara();
			const { items, next } = parseListItems(lines, i, lm[1].length);
			out.push(renderList(items, `l${kb++}`));
			i = next;
			continue;
		}
		// 段落行
		para.push(ln);
		i += 1;
	}
	flushPara();
	return out;
}

// ── 组件 ─────────────────────────────────────────────────────────

/** assistant/reasoning 正文 markdown 渲染（0923 2003：替换 whitespace-pre-wrap 纯文本）。 */
export function Markdown({ text }: { text: string }): ReactElement {
	const blocks = useMemo(() => renderBlocks(text), [text]);
	return <div className="md-prose">{blocks}</div>;
}
