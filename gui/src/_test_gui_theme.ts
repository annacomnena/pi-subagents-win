/**
 * _test_gui_theme.ts — S6 主题切换器纯逻辑测试（零依赖，Node 直跑）。
 *
 * 覆盖 theme.ts 的纯函数：默认主题、applyTheme（切档清旧/幂等）、applyColorScheme、
 * **不持久化**（K3 断言禁止 WebStorage，故本模块必须无任何 storage 调用）。
 *
 * ⚠️ 2026-10-16 修订：原版测试断言 `od-gui-theme` 键的读/写，那依赖 WebStorage 持久化；
 * 而本仓 K3 断言（gui/src 全量禁止浏览器 WebStorage，2026-09-21 引入）不允许 ⇒
 * 主题改为**内存态**，测试随之改为断言「无 storage 依赖」。
 *
 * 运行：npm run test:gui-theme
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyColorScheme, applyTheme, DEFAULT_THEME, nextTheme, THEME_CLASSES, THEME_LABEL } from "./theme.ts";

let n = 0;
const ok = (name: string): void => {
	n += 1;
	console.log(`ok ${n} - ${name}`);
};

// ① 默认主题 + 档位常量
assert.equal(DEFAULT_THEME, "warm-dark", "默认 = 暖暗（风格指南口径「暖暗优先」）");
assert.deepEqual([...THEME_CLASSES], ["theme-warm-dark", "theme-warm-light"], "两档 class 名");
assert.equal(THEME_LABEL["warm-dark"], "暖暗");
assert.equal(THEME_LABEL["warm-light"], "暖亮");
ok("① 默认暖暗 + 两档 class/标签常量");

// ② applyTheme：清另一档再挂当前档（不并存）+ 幂等
{
	const el = {
		classes: new Set<string>(),
		classList: {
			add(c: string) { el.classes.add(c); },
			remove(c: string) { el.classes.delete(c); },
		},
	};
	applyTheme(el as never, "warm-light");
	assert.deepEqual([...el.classes], ["theme-warm-light"], "首次应用只有亮档");
	applyTheme(el as never, "warm-dark");
	assert.deepEqual([...el.classes], ["theme-warm-dark"], "切档后旧档被清除（不并存）");
	applyTheme(el as never, "warm-dark");
	applyTheme(el as never, "warm-dark");
	assert.deepEqual([...el.classes], ["theme-warm-dark"], "重复应用幂等");
}
ok("② applyTheme：切档清旧 / 不并存 / 幂等");

// ③ applyColorScheme：亮→light，暗→dark（原生控件跟随）
{
	const styled = { style: { colorScheme: "" } };
	applyColorScheme(styled, "warm-light");
	assert.equal(styled.style.colorScheme, "light", "亮档 → color-scheme: light");
	applyColorScheme(styled, "warm-dark");
	assert.equal(styled.style.colorScheme, "dark", "暗档 → color-scheme: dark");
}
ok("③ applyColorScheme：亮 light / 暗 dark");

// ④ **红线**：theme.ts + 主题相关文件零 WebStorage（K3 断言口径）
{
	const files = ["theme.ts", "useTheme.ts", "main.tsx", "pages/AppearancePage.tsx", "pages/RuntimeOverlay.tsx"];
	for (const f of files) {
		const src = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
		assert.ok(
			!/sessionStorage|localStorage/.test(src),
			`${f} 不得含 WebStorage 调用/字样（K3 断言）`,
		);
	}
}
ok("④ 红线：主题相关 5 文件零 WebStorage（与 K3 断言一致）");

// ⑤ theme.ts 纯逻辑（零网络、零 config.json、零 DOM 全局）
{
	const raw = readFileSync(new URL("./theme.ts", import.meta.url), "utf8");
	const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
	assert.ok(!/fetch\(|\/v1\/|config\.json|document\.|window\./.test(code), "theme.ts 代码零网络/零 config/零 DOM 全局");
}
ok("⑤ theme.ts 纯逻辑（零网络 / 零 config.json / 零 DOM 全局）");

// ⑥ nextTheme：两档对合（互切回来 == 原档）+ 覆盖两档
{
	assert.equal(nextTheme("warm-dark"), "warm-light", "暗→亮");
	assert.equal(nextTheme("warm-light"), "warm-dark", "亮→暗");
	assert.equal(nextTheme(nextTheme("warm-dark")), "warm-dark", "对合：切两次回原档");
}
ok("⑥ nextTheme：两档互切 + 对合（主界面开关纯逻辑）");

// ⑦ 主界面亮暗开关存在性 + 状态共享（静态断言；防“只改设置页不改顶栏”这类回归）
{
	const top = readFileSync(new URL("./pages/TopBar.tsx", import.meta.url), "utf8");
	assert.ok(top.includes('data-theme-toggle="1"'), "TopBar 有亮暗开关节点（data-theme-toggle）");
	assert.ok(top.includes("onClick={toggleTheme}"), "开关绑 toggleTheme");
	assert.ok(/aria-label=\{`切换到\$\{THEME_LABEL\[nextTheme\(theme\)\]\}主题`\}/.test(top), "开关 aria-label 说明切到哪档");
	assert.ok(top.includes("aria-pressed"), "开关带 aria-pressed 状态");
	assert.ok(top.includes("useThemeValue"), "TopBar 读共享主题态（非自持 useState）");

	const hookRaw = readFileSync(new URL("./useTheme.ts", import.meta.url), "utf8");
	// 去注释后再断言：头注里提到旧实现用 useState（是说明文字，不是代码）
	const hook = hookRaw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
	assert.ok(hook.includes("useSyncExternalStore"), "useTheme 用 useSyncExternalStore 共享单份状态");
	assert.ok(!/useState/.test(hook), "useTheme 代码不得再用 useState（否则顶栏与设置页各持一份）");
	assert.ok(hook.includes("export function toggleTheme"), "导出 toggleTheme");
}
ok("⑦ 主界面开关存在 + 主题态全局共享（单份状态）");

console.log(`\n_test_gui_theme: all assertions passed (${n})`);
