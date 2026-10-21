/**
 * gui/src/writeCard.ts — `write` 工具卡「落笔」的**纯函数层**（2026-10-21）。
 *
 * 设计稿：`plans/20261021_write_card/design.md`（交互样张同目录 write-card.html）。
 * 拆出来的理由：视图（pages/WriteCard.tsx）里带 JSX，不能进 Node 单测；判定/格式化/取窗口
 * 这些**会算错又不会崩**的逻辑放这里，`npm run test:write-card` 直测。
 *
 * 口径：陶土 = 墨、卡片 = 纸；**零新增颜色**，只用 accent 的浓淡与粗细表达「正在写 → 已写完」。
 */

/** 视口里同时可见的行数（几何常数，与 index.css 的 --write-row-h 一起决定卡片高度）。 */
export const WRITE_VISIBLE_ROWS = 10;
/** DOM 里保留的行数 = 可见 + 2（多出的两行被顶部 mask 吃掉，形成「上文还有」的渐隐）。 */
export const WRITE_KEEP_ROWS = WRITE_VISIBLE_ROWS + 2;

export type WriteStatus = "running" | "done" | "error";

export function isWriteTool(name: string): boolean {
	return name === "write";
}

/**
 * 读 write 的入参。`content` 允许 string 或 string[]（两种形状都见过）。
 *
 * **拿不到 content 就返回 `null`**（设计稿 §6 + Wiki「write 卡渲染契约」：触发面唯一 =
 * `name==="write"` **且** 能解析出 content，否则**保持原 pre 路径**）。
 * 曾经这里对缺失 content 返回空串，等于把一个「write 卡永远渲染」的死分支焊死：
 * 模型发错键名（例：`file_path`、`contents`）或参数只流式到一半时，用户看到的是一张
 * **空白纸**，而**原始 arguments 被整个吞掉** —— 恰好在最需要看原始入参的时刻丢信息。
 * 返回 null ⇒ 调用方回落到 `JSON.stringify(row.arguments, null, 2)`，零信息损失。
 */
export function readWriteArgs(args: unknown): { path: string; content: string } | null {
	if (!args || typeof args !== "object") return null;
	const a = args as Record<string, unknown>;
	const raw = a.content;
	let content: string;
	if (typeof raw === "string") content = raw;
	else if (Array.isArray(raw)) content = raw.filter((x): x is string => typeof x === "string").join("\n");
	else return null;
	return { path: typeof a.path === "string" ? a.path : "", content };
}

/** 路径拆成「上一级目录 + 文件名」（头部长路径只保留这两段）。 */
export function splitPath(p: string): { parent: string; name: string } {
	const segs = p.split(/[\\/]+/).filter(Boolean);
	if (segs.length === 0) return { parent: "", name: p };
	const name = segs[segs.length - 1] ?? p;
	const parent = segs.length > 1 ? (segs[segs.length - 2] ?? "") : "";
	return { parent, name };
}

/**
 * 行数（徽标用）：**不算结尾空行**。
 * 文件以 `\n` 结尾时 `split("\n")` 会多出一个空串，那是「行终止符」不是「一行」，
 * 否则每个正常文件的行数都会比编辑器里显示的多 1（写 41 行报 42 行）。
 */
export function countLines(content: string): number {
	if (content === "") return 0;
	const ls = content.split("\n");
	return ls[ls.length - 1] === "" ? ls.length - 1 : ls.length;
}

/** UTF-8 字节数（中文 3 字节，不能用 string.length）。 */
export function utf8Bytes(content: string): number {
	if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(content).length;
	let n = 0;
	for (const ch of content) {
		const cp = ch.codePointAt(0) ?? 0;
		n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
	}
	return n;
}

export function fmtBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	const kb = n / 1024;
	return kb < 100 ? `${kb.toFixed(1)} KB` : `${Math.round(kb)} KB`;
}

/** 三档墨色层次（只用透明度，不引第二种颜色）。 */
export function classifyLine(line: string): "" | "cmt" | "attr" | "struct" {
	const t = line.trimStart();
	if (t.startsWith("//")) return "cmt";
	if (t.startsWith("[")) return "attr";
	if (t === "{" || t === "}" || t === "};" || t === "},") return "struct";
	return "";
}

/** 尾部滑窗：返回要渲染的行（含**绝对**行号，React 拿它当 key ⇒ 老行不重放入场动画）。 */
export function visibleRows(
	content: string,
	keep: number = WRITE_KEEP_ROWS,
): { rows: { no: number; text: string }[]; total: number } {
	const ls = content.split("\n");
	const total = ls.length;
	const base = Math.max(1, total - keep + 1);
	return { rows: ls.slice(base - 1).map((text, i) => ({ no: base + i, text })), total };
}

/**
 * 墨线高度：总行数不可知 ⇒ **渐近**逼近 100%（不假装有百分比）。
 * 收笔（done）才给满；error 与 running 同式（本函数不管 error 的最终呈现，见 `inkHeightCss`）。
 */
export function inkPercent(totalLines: number, status: WriteStatus): number {
	if (status === "done") return 100;
	return 100 * (1 - Math.exp(-totalLines / 11));
}

/** 墨线高度的内联样式值。error 态**不给进度高度** —— 断点不可知（见 design.md §10.4 ②），
 *  继续按内容行数画高度等于伪造"写到哪"；由 CSS 给一条固定残线。 */
export function inkHeightCss(totalLines: number, status: WriteStatus): string | undefined {
	return status === "error" ? undefined : `${inkPercent(totalLines, status).toFixed(1)}%`;
}

/** error 注脚的固定口径：write 是整文件覆盖写、不保证原子 —— 不得写成「已回滚，原文件未改动」。 */
export const WRITE_ERROR_CAVEAT =
	"write 为整文件覆盖写（非原子、无回滚）：失败时目标文件可能是截断/空文件，也可能完全未改动 —— 无法从结果判定，请自行核对";

/**
 * 徽标文案。
 * - running：报「已写的行数」，是过程量；
 * - done：`+N 行 · 体积`（`+` 是**产品口径**：读起来像「这次落笔的产出」，不是 diff 增量统计）；
 * - error：写「未确认」而不是「未写入」—— 覆盖写失败时磁盘**可能**已被截断/清空，
 *   「未写入」是不可验证的断言（见 design.md §10.4 ② 的取证）。
 */
export function deltaLabel(content: string, status: WriteStatus): string {
	const n = countLines(content);
	if (status === "running") return `${n} 行`;
	const size = fmtBytes(utf8Bytes(content));
	return status === "error" ? `${n} 行 · 未确认` : `+${n} 行 · ${size}`;
}
