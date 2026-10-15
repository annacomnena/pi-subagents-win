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
import { applyColorScheme, applyTheme, DEFAULT_THEME, THEME_CLASSES, THEME_LABEL } from "./theme.ts";

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

console.log(`\n_test_gui_theme: all assertions passed (${n})`);
