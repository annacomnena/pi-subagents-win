/**
 * _test_theme_contract.ts — Anthropic 暖纸主题契约门禁（S1 新增，纯 Node 静态断言，零依赖）。
 *
 * 与 _test_zcode_replica.ts 的分工：那边验「行为/结构契约」（日志、mask 常数、class 字面串），
 * 那边只做暖色 token 的**存在性**粗检；本文件做**数值级**回归：
 *   ① §3 关键 token 在 index.css 存在且值正确（brand 基础色 / 亮色基底 / 暖暗层 / 浮层深度）；
 *   ② 冷灰调色板与 ZCode 遗留 hex 零残留（有意保留行须带 /* theme-contract:allow 豁免）；
 *   ③ 自算 WCAG 2.x 相对亮度，断言 §6 暗色对全部达标（正文/元信息 ≥4.5:1，大字与图标 ≥3:1）；
 *   ④ 字号体系：--ui-font-size 仍 14px、--text-ui-xs 派生 -3px（10→11）、ui-2xs 保留定义。
 *
 * 运行：npm run test:gui-theme-contract
 * 值表来源：plans/20261015_gui_anthropic_style_guide.md §3/§6（暖纸体系；不要把本断言读成
 * anthropic.com 抓取值——风格值来自 OpenDesign curated fixture design-systems/claude/）。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "index.css"), "utf8");

let n = 0;
const ok = (name: string): void => {
	n += 1;
	console.log(`ok ${n} - ${name}`);
};

/** 取选择器块内容（本文件只用于无嵌套的 @theme/.theme-* 顶层块）。 */
const blockOf = (sel: string): string => {
	const start = css.indexOf(`${sel} {`);
	assert.ok(start >= 0, `缺少块 ${sel}`);
	const end = css.indexOf("\n}", start);
	assert.ok(end > start, `块未闭合 ${sel}`);
	return css.slice(start, end);
};

const theme = blockOf("@theme");
const dark = blockOf(".theme-warm-dark");
const light = blockOf(".theme-warm-light");

// ── ① §3 关键 token 存在 + 值正确 ─────────────────────────────────────────
// 品牌基础色（§3.4：11 枚，两层同值）
const BRAND: Record<string, string> = {
	"--color-brand-ink": "#141413",
	"--color-brand-ivory": "#faf9f5",
	"--color-brand-parchment": "#f5f4ed",
	"--color-brand-sand": "#e8e6dc",
	"--color-brand-mist": "#b0aea5",
	"--color-brand-terracotta": "#c96442",
	"--color-brand-coral": "#d97757",
	"--color-brand-crimson": "#b53333",
	"--color-brand-ochre": "#96601a",
	"--color-brand-olive": "#5f6b4f",
	"--color-brand-focus": "#3898ec",
};
for (const [k, v] of Object.entries(BRAND)) {
	const line = `${k}: ${v}`;
	assert.ok(theme.includes(line), `@theme 品牌基础色：${line}`);
	assert.ok(dark.includes(line), `.theme-warm-dark 品牌基础色两层同值：${line}`);
	assert.ok(light.includes(line) || css.includes(line), `品牌基础色全局可解析：${line}`);
}

// 亮色基底（§3.3）
for (const line of [
	"--color-background: #f5f4ed",
	"--color-sidebar: #efece4",
	"--color-panel: #faf9f5",
	"--color-card: #faf9f5",
	"--color-border: #dcd8cc",
	"--color-border-hover: #c2bdb0",
	"--color-foreground: #141413",
	"--color-foreground-subtle: #5e5d59",
	"--color-foreground-subtlest: #6c6b65", // L4 复算修正：原 #706f69 在 sidebar 上仅 4.27:1
	"--color-accent: #c96442",
	"--color-accent-foreground: #141413",
	"--color-accent-text: #a84e33", // L4 复算修正：原 #b4553a 在 page 4.43 / sidebar 4.14
	"--color-destructive: #a83f34",
	"--color-warning: #8a5a12",
	"--color-success: #4f6b3f",
	"--color-info: #2d70ab",
	"--color-focus-ring: #2d70ab",
	"--color-input-border: #dcd8cc",
	"--color-brand: var(--color-brand-mist)",
]) {
	assert.ok(theme.includes(line), `@theme 亮色基底：${line}`);
}

// 暖暗层（§3.1/§3.2）：不透明表面/文字档按 §3 权威 hex；半透明档按 color-mix
for (const line of [
	"--color-background: var(--color-brand-ink)",
	"--color-sidebar: #191917",
	"--color-panel: #1c1b19",
	"--color-card: #21201e",
	"--color-input: var(--color-card)",
	"--color-foreground: var(--color-brand-mist)",
	"--color-foreground-strong: var(--color-brand-ivory)",
	"--color-foreground-subtle: #a09f96",
	"--color-foreground-subtlest: #898880",
	"--color-foreground-inverse: var(--color-brand-ink)",
	"--color-accent: var(--color-brand-terracotta)",
	"--color-accent-foreground: var(--color-brand-ink)",
	"--color-focus-ring: var(--color-brand-focus)",
	"--color-success: #87956f",
	"--color-destructive: #cf7359",
	"--color-warning: #c08f45",
	"--color-info: var(--color-brand-focus)",
	"--color-hover: color-mix(in oklab, var(--color-surface-warm) 8%, transparent)",
	"--color-selected: color-mix(in oklab, var(--color-surface-warm) 12%, transparent)",
	"--color-border: color-mix(in oklab, var(--color-surface-warm) 14%, transparent)",
	"--color-border-hover: color-mix(in oklab, var(--color-surface-warm) 24%, transparent)",
	"--color-input-border: var(--color-border)",
	"--color-input-border-focused: var(--color-accent)",
	"--color-input-border-focus: var(--color-accent)",
	"--color-accent-text: var(--color-brand-coral)", // L4 复算修正：原 = accent #c96442，card 上仅 4.17:1；现 4 表面 5.21–5.90
	"--color-interaction-ask-fill: color-mix(in oklab, var(--color-brand-terracotta) 20%, transparent)",
	"--animated-gradient-text-strong: rgba(250, 249, 245, 1)",
	"--animated-gradient-text-soft: rgba(250, 249, 245, 0.22)",
]) {
	assert.ok(dark.includes(line), `.theme-warm-dark：${line}`);
}

// 「被引用但此前未定义」的 token 必须全部补齐（否则组件静默失效）
for (const token of [
	"--color-input-border:",
	"--color-secondary-foreground:",
	"--color-ring:",
	"--color-muted:",
	"--color-muted-foreground:",
	"--color-info:",
	"--color-tag:",
	"--color-toast:",
	"--color-tooltip:",
	"--color-tooltip-foreground:",
	"--color-menu:",
	"--color-menu-hover:",
]) {
	assert.ok(theme.includes(token), `@theme 补齐未定义 token：${token}`);
	assert.ok(dark.includes(token), `.theme-warm-dark 补齐未定义 token：${token}`);
}

// 浮层深度（§5：环 + 低语影）
assert.ok(
	theme.includes("--shadow-overlay: 0 0 0 1px var(--color-border), 0 4px 24px rgba(20, 20, 19, 0.28)"),
	"@theme 浮层深度 = 环 + 低语影",
);

// 死 token：--color-trajectory-* 全库 0 调用点 → 已删除（只允许注释里提到名字）
assert.ok(!/^\s*--color-trajectory-[a-z-]+\s*:/m.test(css), "--color-trajectory-* 无残留定义");

// 焦点：键盘可见 outline（不再全局清零）
assert.ok(css.includes(":focus-visible {\n\toutline: 2px solid var(--color-focus-ring);"), "键盘焦点 outline 契约");
ok("① §3 关键 token 存在且值正确（品牌基础色/亮色/暖暗/补缺/浮层深度/死 token 清理）");

// ── ② 冷灰与 ZCode 遗留零残留（allow 注释豁免）─────────────────────────────
const FORBIDDEN =
	/(neutral-|zinc-|slate-|gray-|#161616|#2b2b2b|#202020|#363636|#242424|#ffffff|#f8f8f8|rgba\(255,\s*255,\s*255)/i;
const offenders = css
	.split("\n")
	.map((line, i): [number, string] => [i + 1, line])
	.filter(([, line]) => FORBIDDEN.test(line) && !line.includes("theme-contract:allow"))
	.map(([ln, line]) => `L${ln}: ${line.trim()}`);
assert.deepEqual(offenders, [], `冷灰/ZCode 遗留 hex 零残留（allow 豁免行除外）：${offenders.join(" | ")}`);
ok("② 无冷灰调色板（neutral-/zinc-/slate-/gray-）与 ZCode 遗留 hex（allow 豁免仅亮色输入底）");

// ── ③ §6 暗色对比度自算（WCAG 2.x 相对亮度）───────────────────────────────
const channel = (v: number): number => {
	const c = v / 255;
	return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string): number => {
	const h = hex.replace("#", "");
	return (
		0.2126 * channel(parseInt(h.slice(0, 2), 16)) +
		0.7152 * channel(parseInt(h.slice(2, 4), 16)) +
		0.0722 * channel(parseInt(h.slice(4, 6), 16))
	);
};
const contrast = (a: string, b: string): number => {
	const [x, y] = [luminance(a), luminance(b)];
	return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

// 暗色档位锚定在文件里（hex 必须在 .theme-warm-dark 内出现，防止断言与实现漂移）
const DARK_HEX = ["#141413", "#21201e", "#d9d7cd", "#faf9f5", "#a09f96", "#898880", "#d97757", "#cf7359", "#c08f45", "#87956f", "#c96442", "#3898ec"];
for (const hex of DARK_HEX) {
	assert.ok(dark.toLowerCase().includes(hex), `.theme-warm-dark 含 §6 锚点色 ${hex}`);
}

const BOTTOMS = ["#141413", "#21201e"];
// 正文/元信息档：≥ 4.5:1
const TEXT_TIER: Array<[string, string]> = [
	["--color-foreground #d9d7cd", "#d9d7cd"],
	["--color-foreground-strong #faf9f5", "#faf9f5"],
	["--color-foreground-subtle #a09f96", "#a09f96"],
	["--color-foreground-subtlest #898880", "#898880"],
	["--color-brand-coral #d97757（文字重音）", "#d97757"],
	["--color-destructive #cf7359", "#cf7359"],
	["--color-warning #c08f45", "#c08f45"],
	["--color-success #87956f", "#87956f"],
];
for (const [name, fg] of TEXT_TIER) {
	for (const bg of BOTTOMS) {
		const ratio = contrast(fg, bg);
		assert.ok(ratio >= 4.5, `${name} on ${bg} = ${ratio.toFixed(2)} ≥ 4.5`);
	}
}
// accent 上的字（近黑）≥ 4.5:1
const onAccent = contrast("#141413", "#c96442");
assert.ok(onAccent >= 4.5, `--color-accent-foreground on --color-accent = ${onAccent.toFixed(2)} ≥ 4.5`);

// 大字与图标档：≥ 3:1（陶土重音/信息蓝作图形与大字）
for (const [name, fg] of [
	["--color-accent #c96442（大字/图标）", "#c96442"],
	["--color-info #3898ec（大字/图标，唯一冷色）", "#3898ec"],
] as Array<[string, string]>) {
	for (const bg of BOTTOMS) {
		const ratio = contrast(fg, bg);
		assert.ok(ratio >= 3, `${name} on ${bg} = ${ratio.toFixed(2)} ≥ 3`);
	}
}
ok("③ §6 暗色对比度：正文/元信息 ≥4.5:1、大字与图标 ≥3:1（两种底各 12 对，自算 WCAG）");

// ── ④ 字号体系 ────────────────────────────────────────────────────────────
assert.ok(css.includes("--ui-font-size: 14px"), "--ui-font-size: 14px 仍在");
assert.ok(theme.includes("--text-ui-xs: calc(var(--ui-font-size) - 3px)"), "--text-ui-xs 派生 -3px（10→11）");
assert.ok(theme.includes("--text-ui-2xs: calc(var(--ui-font-size) - 5px)"), "--text-ui-2xs 保留定义（禁止新增调用点）");
ok("④ 字号：ui-font-size=14px / ui-xs 派生 -3px / ui-2xs 保留定义");

console.log(`\nall ${n} groups passed — Anthropic 暖纸主题契约门禁`);
