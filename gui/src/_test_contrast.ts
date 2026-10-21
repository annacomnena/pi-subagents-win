/**
 * _test_contrast.ts — 对比度门禁（**独立复算**，不是自证）。
 *
 * ## 为什么单独一个文件（而不是塞进 _test_theme_contract.ts）
 *
 * `_test_theme_contract.ts`（231 行）的职责是「token **值存在性** + 冷灰残留 + 暗色 12 对粗检」；
 * 本文件要装：oklab 色彩数学 + premultiplied alpha + color-mix 解析 + var 链解析 +
 * 107 对逐对断言（含复合对），体量约 400 行。合进去会让那个文件超 600 行且**两种职责混淆**
 * （一个改 token 值就会红，一个改配色语义才会红）。故拆开，各自可独立定位失败原因。
 *
 * ## 硬条款（指导文档 §6.1）
 *
 * **对比度门不得自证**：算式必须独立于被验证的实现。本文件的色彩数学是**自己实现**的
 * （不复用任何生产代码——生产侧只有 CSS，本文件从 CSS 解析 token 再独立计算），
 * 且口径固定为 **oklab + premultiplied alpha**（与 CSS `color-mix(in oklab, …)` 的真实语义一致）。
 *
 * 这条的来源是两次真实教训：
 *  1. 先前自测（sRGB 线性近似 + 把 `transparent` 当黑加权 + 丢 8 位 hex 的 alpha + 未合成半透明底）
 *     漏掉了 3 处不达标（详见 plans/20261015_gui_contrast_l4_review.md §1/§3）；
 *  2. 旧写法 `bg-tone/20 + text-tone` 实测只有 3.64–4.43:1（不达 AA），也是复算才定性。
 *
 * ## 输入与输出
 *
 * - **输入**：从 `index.css` 解析 **token 名 → 解析值**（**不硬编码 hex**——否则改 token 会假绿）。
 *   取源码而非 `dist`：源码是唯一事实源，且本门禁不应依赖构建顺序。
 * - **输出**：每对打印 `比值 + 阈值 + 判定`；**任一低于阈值即 FAIL**（`assert`，不是 warn）。
 * - **覆盖**：两主题 × 4 个实际表面（background/sidebar/panel/card）+ **复合对**
 *   （hover/selected 合成底、chip wash、半透明覆盖层、拖拽提示、气泡、实底按钮字）。
 *
 * 阈值两档：正文/元信息/徽章 **≥4.5:1**；大字与图标 **≥3:1**。
 *
 * 运行：npm run test:gui-contrast
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "index.css"), "utf8");

let groups = 0;
let pairs = 0;
const pairLines: string[] = [];
const okGroup = (name: string): void => {
	groups += 1;
	console.log(`ok ${groups} - ${name}`);
};

// ═══════════════════════════════════════════════════════════════════════════
// 1. token 解析（var 链 + color-mix），按主题层叠
// ═══════════════════════════════════════════════════════════════════════════

/** 取顶层块内容（本文件只用于无嵌套的 @theme / .theme-* / :root）。 */
function blockOf(sel: string): string {
	const start = css.indexOf(`${sel} {`);
	assert.ok(start >= 0, `缺少块 ${sel}`);
	const end = css.indexOf("\n}", start);
	assert.ok(end > start, `块未闭合 ${sel}`);
	return css.slice(start, end);
}
function decls(body: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) out.set(m[1], m[2].trim());
	return out;
}

type Rgb = { r: number; g: number; b: number; a: number };

const srgbToLin = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linToSrgb = (c: number): number => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

function hexToRgb(hex: string): Rgb {
	let h = hex.replace("#", "");
	if (h.length === 3) h = [...h].map((c) => c + c).join("");
	if (h.length === 4) h = [...h].map((c) => c + c).join("");
	// 支持 8 位 hex（#rrggbbaa）—— 先前自测正是在这里丢了 alpha，把 8% 的暖白当不透明
	const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
	return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a };
}
function parseColor(s: string): Rgb {
	const t = s.trim().toLowerCase();
	if (t === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
	if (t.startsWith("#")) return hexToRgb(t);
	const m = t.match(/rgba?\(([^)]+)\)/);
	if (m) {
		const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
		return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] };
	}
	throw new Error(`unparsable color: ${s}`);
}

/** sRGB(0-255) → Oklab（Björn Ottosson 的标准矩阵）。 */
function toOklab(c: Rgb): { L: number; a: number; b: number } {
	const R = srgbToLin(c.r / 255), G = srgbToLin(c.g / 255), B = srgbToLin(c.b / 255);
	const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
	const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
	const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
	return {
		L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
		a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
		b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
	};
}
function fromOklab({ L, a, b }: { L: number; a: number; b: number }): Rgb {
	const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
	const R = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
	const G = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
	const B = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
	const cl = (v: number): number => Math.max(0, Math.min(255, Math.round(linToSrgb(Math.max(0, Math.min(1, v))) * 255)));
	return { r: cl(R), g: cl(G), b: cl(B), a: 1 };
}

/**
 * CSS `color-mix(in oklab, …)`：**premultiplied alpha** 语义。
 *
 * CSS 规范：带百分比的项用其值；**不带百分比的项均分「剩余量」**（100 − 已显式之和）；
 * 全部带 p 且和 >100 时归一化。插值前先把颜色分量乘各自 alpha，插值后再除以 Σalpha。
 */
function colorMix(items: { color: Rgb; p?: number }[]): Rgb {
	const explicitSum = items.reduce((s, it) => s + (it.p ?? 0), 0);
	const implicitCount = items.filter((it) => it.p === undefined).length;
	const scale = explicitSum > 100 && implicitCount === 0 ? 100 / explicitSum : 1;
	const implicitShare = implicitCount > 0 ? Math.max(0, 100 - explicitSum) / implicitCount : 0;
	let L = 0, A = 0, B = 0, alpha = 0;
	for (const it of items) {
		const w = ((it.p ?? implicitShare) * scale) / 100;
		const lab = toOklab(it.color);
		L += lab.L * it.color.a * w;
		A += lab.a * it.color.a * w;
		B += lab.b * it.color.a * w;
		alpha += it.color.a * w;
	}
	if (alpha === 0) return { r: 0, g: 0, b: 0, a: 0 };
	const rgb = fromOklab({ L: L / alpha, a: A / alpha, b: B / alpha });
	rgb.a = Math.min(1, alpha);
	return rgb;
}

/** sRGB 通道 alpha 合成（浏览器默认合成空间）。 */
function over(fg: Rgb, bg: Rgb): Rgb {
	if (fg.a >= 1) return { r: fg.r, g: fg.g, b: fg.b, a: 1 };
	const a = fg.a;
	return {
		r: Math.round(fg.r * a + bg.r * (1 - a)),
		g: Math.round(fg.g * a + bg.g * (1 - a)),
		b: Math.round(fg.b * a + bg.b * (1 - a)),
		a: 1,
	};
}

const lum = (c: Rgb): number =>
	0.2126 * srgbToLin(c.r / 255) + 0.7152 * srgbToLin(c.g / 255) + 0.0722 * srgbToLin(c.b / 255);
/** WCAG 2.x 对比度。 */
const contrast = (fg: Rgb, bg: Rgb): number => {
	const [x, y] = [lum(fg), lum(bg)];
	return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const hexOf = (c: Rgb): string =>
	"#" + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("") +
	(c.a < 1 ? Math.round(c.a * 255).toString(16).padStart(2, "0") : "");

/** token 层叠解析器：var() 链 + color-mix，按层覆盖。 */
function makeResolver(layers: Map<string, string>[]) {
	const table = new Map<string, string>();
	for (const layer of layers) for (const [k, v] of layer) table.set(k, v);
	const resolve = (raw: string, depth = 0): string => {
		assert.ok(depth <= 12, "var() 递归过深（疑似循环引用）");
		let s = raw.trim();
		// ① 先展开 var()（color-mix 内的嵌套括号因此被消除，后续解析才可靠）
		s = s.replace(/var\(\s*(--[a-z0-9-]+)\s*(?:,\s*([^)]*))?\)/gi, (_, name: string, fb?: string) => {
			const v = table.get(name);
			if (v === undefined) {
				if (fb !== undefined) return resolve(fb, depth + 1);
				throw new Error(`未定义 token：${name}`);
			}
			return resolve(v, depth + 1);
		});
		// ② 再解析 color-mix（此时内部只剩字面色值）
		for (let i = 0; i < 6 && s.includes("color-mix"); i++) {
			s = s.replace(/color-mix\(\s*in\s+oklab\s*,\s*([^)]*)\)/i, (_m, args: string) => {
				const items = args
					.split(",")
					.map((p) => p.trim())
					.filter(Boolean)
					.map((p) => {
						const pm = p.match(/^(.*?)\s+([\d.]+)%$/);
						return pm
							? { color: parseColor(resolve(pm[1], depth + 1)), p: Number(pm[2]) }
							: { color: parseColor(resolve(p, depth + 1)) };
					});
				return hexOf(colorMix(items));
			});
		}
		if (/var\(/i.test(s)) return resolve(s, depth + 1);
		return s;
	};
	const color = (name: string): Rgb => parseColor(resolve(`var(${name})`));
	return { color, has: (name: string): boolean => table.has(name) };
}

const rootLayer = decls(blockOf(":root"));
const themeLayer = decls(blockOf("@theme"));
const darkLayer = decls(blockOf(".theme-warm-dark"));
const lightLayer = decls(blockOf(".theme-warm-light"));

assert.ok(themeLayer.size > 50, `@theme 层 token 数异常（${themeLayer.size}）`);
assert.ok(darkLayer.size > 50, `.theme-warm-dark 层 token 数异常（${darkLayer.size}）`);
assert.ok(lightLayer.size > 40, `.theme-warm-light 层 token 数异常（${lightLayer.size}）`);

const dark = makeResolver([rootLayer, themeLayer, darkLayer]);
const light = makeResolver([rootLayer, themeLayer, lightLayer]);

// ═══════════════════════════════════════════════════════════════════════════
// 2. 断言原语
// ═══════════════════════════════════════════════════════════════════════════

const TEXT_MIN = 4.5; // 正文 / 元信息 / 徽章
const GRAPHIC_MIN = 3; // 大字 / 图标

const failures: string[] = [];

/** 单对断言：低于阈值即 FAIL（收集后统一抛，便于一次看到全部问题）。 */
function pair(label: string, fg: Rgb, bg: Rgb, min: number): number {
	const r = contrast(fg, bg);
	pairs += 1;
	const pass = r >= min;
	if (!pass) failures.push(`${label}: ${r.toFixed(2)}:1 < ${min}（fg=${hexOf(fg)} bg=${hexOf(bg)}）`);
	pairLines.push(
		`  ${pass ? "PASS" : "!!FAIL"}  ${r.toFixed(2).padStart(6)}:1  (≥${min})  ${label.padEnd(46)} fg=${hexOf(fg)} bg=${hexOf(bg)}`,
	);
	return r;
}

/** 每个主题的 4 个实际表面（文字可能落这些底）。 */
function surfaces(T: ReturnType<typeof makeResolver>) {
	return [
		["bg-page", T.color("--color-background")],
		["bg-sidebar", T.color("--color-sidebar")],
		["bg-panel", T.color("--color-panel")],
		["bg-card", T.color("--color-card")],
	] as const;
}

/** 正文/元信息/徽章档：token × 4 表面。 */
function textTier(T: ReturnType<typeof makeResolver>, tokens: [string, string][]): void {
	for (const [label, tok] of tokens) {
		const fg = T.color(tok);
		for (const [sn, bg] of surfaces(T)) pair(`${label} on ${sn}`, fg, bg, TEXT_MIN);
	}
}
/** 大字/图标档：token × 4 表面。 */
function graphicTier(T: ReturnType<typeof makeResolver>, tokens: [string, string][]): void {
	for (const [label, tok] of tokens) {
		const fg = T.color(tok);
		for (const [sn, bg] of surfaces(T)) pair(`${label} on ${sn}`, fg, bg, GRAPHIC_MIN);
	}
}

/**
 * 复合对 —— **自测漏掉的那一类**。
 * 半透明底必须先与实际底色合成；chip 用 §3.2 公式；实底按钮字对实底。
 */
function compositeTier(T: ReturnType<typeof makeResolver>, theme: "dark" | "light"): void {
	const page = T.color("--color-background");
	const card = T.color("--color-card");
	const chipBase = T.color("--color-chip-fg-base");

	// ① accent 上的字（全库唯一彩色主 CTA）
	pair("accent-foreground on accent（主 CTA）", T.color("--color-accent-foreground"), T.color("--color-accent"), TEXT_MIN);

	// ② 语义实底按钮上的字（3 档：实底 = 不透明）
	for (const t of ["destructive", "warning", "success"] as const) {
		pair(`${t}-foreground on ${t}（实底按钮）`, T.color(`--color-${t}-foreground`), T.color(`--color-${t}`), TEXT_MIN);
	}

	// ③ chip 规范（§3.2）：底 mix(tone 12%, card)、字 mix(tone 70%, chip-fg-base)
	for (const tone of ["success", "destructive", "warning", "info", "accent", "foreground-subtle"] as const) {
		const tc = T.color(`--color-${tone}`);
		const cbg = over(colorMix([{ color: tc, p: 12 }, { color: card }]), card);
		const cfg = colorMix([{ color: tc, p: 70 }, { color: chipBase }]);
		pair(`tone-chip ${tone}（12% 底 + 70% 字）on card`, cfg, cbg, TEXT_MIN);
	}

	// ④ 暗层文字重音 accent-text 落 4 表面（亮层已在正文档）
	if (theme === "dark") {
		const at = T.color("--color-accent-text");
		for (const [sn, bg] of surfaces(T)) pair(`accent-text（暗层文字重音）on ${sn}`, at, bg, TEXT_MIN);
	}

	// ⑤ 用户气泡（角色 token 对）
	pair("气泡：bubble-user-foreground on bubble-user", T.color("--color-bubble-user-foreground"), T.color("--color-bubble-user"), TEXT_MIN);

	// ⑥ 外观页选中勾（落 selected 半透明合成底）
	const selBg = over(T.color("--color-selected"), page);
	pair("外观页选中勾 foreground on selected 合成底", T.color("--color-foreground"), selBg, TEXT_MIN);

	// ⑦ 半透明 hover / selected 上的正文（P0：hover 后对比不下降）
	pair("hover 合成底上的 foreground", T.color("--color-foreground"), over(T.color("--color-hover"), page), TEXT_MIN);
	pair("selected 合成底上的 foreground", T.color("--color-foreground"), selBg, TEXT_MIN);

	// ⑧ 拖拽提示：文字落内层提示气泡（bg-card），保守地再核一层直放 accent/15 之上
	pair("拖拽提示字 foreground on 内层气泡(bg-card)", T.color("--color-foreground"), card, TEXT_MIN);
	pair(
		"（保守）拖拽提示字 foreground 直放 accent/15 over input",
		T.color("--color-foreground"),
		over({ ...T.color("--color-accent"), a: 0.15 }, T.color("--color-input")),
		TEXT_MIN,
	);

	// ⑨ 半透明浮层 bg-toast/60（S2 保留的 backdrop-blur 表现）合成到页面底
	const toast60 = over({ ...T.color("--color-toast"), a: 0.6 }, page);
	pair("半透明 toast(60%) 合成底上的 foreground", T.color("--color-foreground"), toast60, TEXT_MIN);
	// 浮层实底（menu / tooltip）上的字
	pair("menu 底上的 foreground", T.color("--color-foreground"), T.color("--color-menu"), TEXT_MIN);
	pair("tooltip 底上的 tooltip-foreground", T.color("--color-tooltip-foreground"), T.color("--color-tooltip"), TEXT_MIN);
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. 暗色（生产默认主题）
// ═══════════════════════════════════════════════════════════════════════════
textTier(dark, [
	["--foreground", "--color-foreground"],
	["--foreground-strong", "--color-foreground-strong"],
	["--foreground-subtle", "--color-foreground-subtle"],
	["--foreground-subtlest", "--color-foreground-subtlest"],
	["--destructive", "--color-destructive"],
	["--warning", "--color-warning"],
	["--success", "--color-success"],
]);
graphicTier(dark, [
	["--accent（图标/大字）", "--color-accent"],
	["--info（唯一冷色）", "--color-info"],
]);
compositeTier(dark, "dark");
okGroup("① 暗色 .theme-warm-dark：正文档 28 + 图标档 8 + 复合档（次选主题）");

// ═══════════════════════════════════════════════════════════════════════════
// 4. 亮色（S6 起为可选主题）
// ═══════════════════════════════════════════════════════════════════════════
textTier(light, [
	["--foreground", "--color-foreground"],
	["--foreground-subtle", "--color-foreground-subtle"],
	["--foreground-subtlest", "--color-foreground-subtlest"],
	["--accent-text", "--color-accent-text"],
	["--destructive", "--color-destructive"],
	["--warning", "--color-warning"],
	["--success", "--color-success"],
]);
graphicTier(light, [
	["--accent（图标/大字）", "--color-accent"],
	["--info", "--color-info"],
	["--focus-ring", "--color-focus-ring"],
]);
compositeTier(light, "light");
okGroup("② 亮色 .theme-warm-light：正文档 28 + 图标档 12 + 复合档（S6 可选主题；2026-10-19 起为默认）");

// ═══════════════════════════════════════════════════════════════════════════
// 4b. write 工具卡「落笔」的墨色层次（2026-10-22 L4 补）
// ═══════════════════════════════════════════════════════════════════════════
// 为什么单列一段：这套卡的"层次感"是**同色降透明度**（`.write-tx[data-k=cmt]{opacity:.72}`），
// 而本门禁原来只查 token 裸值 × 表面，**不查"降完透明度之后"的合成色** ⇒ 一段 3.34:1 的
// 注释文字可以全绿通过（2026-10-22 L4 实测：修复前亮层 3.34/2.95、暗层 3.85/3.46，
// error 态再叠 .62 降到 1.86/2.14，而当时 write-card 与 gui-contrast 两道门都是绿的）。
// 这里直接解析 index.css 里 `.write-*` 的真实 opacity 值，做 alpha 合成再比，缺规则即红。
function writeCardTiers(T: ReturnType<typeof makeResolver>, themeName: string): void {
	const css2 = css.replace(/\/\*[\s\S]*?\*\//g, "");
	/** 取某选择器某属性的**最后一个**声明（级联后者胜）。 */
	const decl = (wantSel: string, prop: string): string => {
		const wanted = wantSel.replace(/\s+/g, " ").trim();
		let last = "";
		for (const m of css2.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
			const sels = m[1]!.split(",").map((x) => x.replace(/\s+/g, " ").trim());
			if (!sels.includes(wanted)) continue;
			const pm = new RegExp("(?:^|;)\\s*" + prop + "\\s*:\\s*([^;]+)", "m").exec(m[2]!);
			if (pm) last = pm[1]!.replace(/\s+/g, " ").trim();
		}
		assert.ok(last !== "", `${themeName}：index.css 找不到「${wanted}」的 ${prop}（write 卡契约规则被删/改名）`);
		return last;
	};
	const varOf = (sel: string, prop: string): string => {
		const v = decl(sel, prop);
		const m = /^var\((--[a-z0-9-]+)\)$/.exec(v);
		assert.ok(m, `${themeName}：「${sel}」的 ${prop} 必须是单个 var(--token)，实际 "${v}"（否则本段无法复算）`);
		return m[1]!;
	};
	const alphaOf = (sel: string): number => {
		const raw = decl(sel, "opacity");
		const n = Number(raw);
		assert.ok(Number.isFinite(n) && n > 0 && n <= 1, `${themeName}：「${sel}」opacity 必须是 (0,1]，实际 "${raw}"`);
		return n;
	};

	const bg = T.color("--color-card");
	const bodyTok = varOf(".write-lines", "color");
	const noTok = varOf(".write-no", "color");
	const curTok = varOf(".write-row.is-cur .write-no", "color");
	const cmtA = alphaOf('.write-tx[data-k="cmt"]');
	const attrA = alphaOf('.write-tx[data-k="attr"]');
	const noA = alphaOf(".write-no");

	// 注意：`contrast()` 的 lum() 只读 rgb、**不合成 alpha**。凡 a<1 必须先 over() 压到面上，
	// 否则 0.72 的注释档会按不透明算成 6.12 而假绿（2026-10-22 本段第一版就这么错过一次）。
	const onCard = (tok: string, a: number): Rgb => over({ ...T.color(tok), a }, bg);

	// ① 正文三档：body / 注释 / 特性·结构（都是文字，≥4.5）
	pair(`${themeName} write 卡：正文（${bodyTok}）`, T.color(bodyTok), bg, TEXT_MIN);
	pair(`${themeName} write 卡：注释档（${bodyTok} @${cmtA}）`, onCard(bodyTok, cmtA), bg, TEXT_MIN);
	pair(`${themeName} write 卡：特性·结构档（${bodyTok} @${attrA}）`, onCard(bodyTok, attrA), bg, TEXT_MIN);
	// ② 行号（subtlest @1）与当前行号（必须是 accent-text：accent 当文字 4.17 不达）
	pair(`${themeName} write 卡：行号（${noTok} @${noA}）`, onCard(noTok, noA), bg, TEXT_MIN);
	pair(`${themeName} write 卡：当前行号（${curTok}）`, T.color(curTok), bg, TEXT_MIN);
	assert.equal(curTok, "--color-accent-text", `${themeName}：当前行号是文字，必须 --color-accent-text（--color-accent 不达 4.5）`);

	// ②b-2 头部 meta / 注脚 / 徽标 —— 全是文字，同样逐对复算（2026-10-22 L4 实测：
	// `--color-accent` 直接当文字只有 3.70/4.17，不足以给「N 行」徽标，必须走 accent-text）。
	const metaRows: Array<[string, string, number]> = [
		["文件名（上一级目录）", varOf(".write-path", "color"), 1],
		["文件名（本体 b）", varOf(".write-path b", "color"), 1],
		["徽标（done / 静态）", varOf(".write-delta", "color"), 1],
		["徽标（running）", varOf('.write-delta[data-status="running"]', "color"), 1],
		["徽标（error）", varOf('.write-delta[data-status="error"]', "color"), 1],
		["注脚正文（工具真实输出）", varOf(".write-note", "color"), 1],
		// 注脚固定口径**不得**再叠 opacity（subtlest 本身只 5.07/4.57，乘 .9 就掉到 4.13/3.97）
		["注脚固定口径", varOf(".write-note-caveat", "color"), 1],
	];
	for (const [label, token, a] of metaRows) {
		pair(`${themeName} write 卡：${label}（${token}${a === 1 ? "" : ` @${a}`}）`, onCard(token, a), bg, TEXT_MIN);
	}

	// ③ error 态**不得**再拿 opacity 压内容/行号：行号底色 subtlest 本身就只 5.07/4.57，
	//    乘 .9 剩 4.13/3.97、乘 .62 剩 2.63/3.10 ⇒ 一律跌破 4.5。这条是设计约束的机器可读形式。
	assert.ok(
		!/\.write-card\[data-status="error"\]\s+\.(write-no|write-lines)\b/.test(css2),
		`${themeName}：error 态不得对 .write-no/.write-lines 叠加 opacity（会把行号/正文压到 4.5 以下）`,
	);

	// ④ 反例自检：同一套算式用在**修复前的取值**上必须跌破门（证明本段会拦，不是恒真）
	const staleCmt = contrast(over({ ...T.color("--color-foreground-subtle"), a: 0.72 }, bg), bg);
	const staleAttr = contrast(over({ ...T.color("--color-foreground-subtle"), a: 0.66 }, bg), bg);
	const staleErr = contrast(over({ ...T.color("--color-foreground-subtle"), a: 0.66 * 0.62 }, bg), bg);
	assert.ok(staleCmt < TEXT_MIN, `${themeName}：反例自检失败 —— 修复前 subtle@.72 应 <4.5，实得 ${staleCmt.toFixed(2)}`);
	assert.ok(staleAttr < TEXT_MIN, `${themeName}：反例自检失败 —— 修复前 subtle@.66 应 <4.5，实得 ${staleAttr.toFixed(2)}`);
	assert.ok(staleErr < GRAPHIC_MIN, `${themeName}：反例自检失败 —— 修复前 error 双透明应 <3，实得 ${staleErr.toFixed(2)}`);
}
writeCardTiers(dark, "暗色");
writeCardTiers(light, "亮色");
okGroup("②b write 卡墨色层次（含透明度合成；反例自检：修复前取值必红）");


// ═══════════════════════════════════════════════════════════════════════════
// 5. 结果
// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n[逐对明细] 共 ${pairs} 对`);
for (const l of pairLines) console.log(l);

assert.ok(pairs >= 107, `对数不得少于 L4 基线 107（当前 ${pairs}）—— 防止有人误删断言`);
assert.deepEqual(failures, [], `对比度门失败 ${failures.length} 对：\n  - ${failures.join("\n  - ")}`);
okGroup(`③ 全部 ${pairs} 对 ≥ 阈值（正文/元信息/徽章 ≥4.5、大字与图标 ≥3）`);

// 负向自检：确认阈值真的会拦（防止断言写反导致假绿）
assert.ok(contrast({ r: 137, g: 136, b: 128, a: 1 }, { r: 20, g: 20, b: 19, a: 1 }) >= 4.5, "自检：subtlest on page 应过");
assert.ok(contrast({ r: 201, g: 100, b: 66, a: 1 }, { r: 33, g: 32, b: 30, a: 1 }) < 4.5, "自检：accent(4.17) 应被 4.5 拦截");
okGroup("④ 负向自检：阈值确实会拦（非假绿）");

console.log(`\n_test_contrast: all ${groups} groups passed — ${pairs} 对比对全部达标`);
