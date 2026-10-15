/**
 * _test_gui_theme.ts — S6 主题切换器纯逻辑测试（零依赖，Node 直跑）。
 *
 * 覆盖 theme.ts 的四个纯函数：读默认/读非法/写/应用（含清另一档）。
 * hook（useTheme）与 DOM 交互不在本测试范围（无 DOM 测试框架）。
 *
 * 运行：npm run test:gui-theme
 */

import assert from "node:assert/strict";
import { applyColorScheme, applyTheme, readTheme, writeTheme, THEME_CLASSES, THEME_STORAGE_KEY } from "./theme.ts"; // Node strip-types 需带扩展名（gui/ 内 vite import 不带，见 README）

let n = 0;
const ok = (name: string): void => {
	n += 1;
	console.log(`ok ${n} - ${name}`);
};

// ① 键名与档位常量
assert.equal(THEME_STORAGE_KEY, "od-gui-theme", "存储键 = od-gui-theme（与文档 C-3 一致）");
assert.deepEqual([...THEME_CLASSES], ["theme-warm-dark", "theme-warm-light"], "两档 class 名");
ok("① 键名 od-gui-theme + 两档 class 常量");

// ② 读：缺失/非法 → 暖暗；显式 warm-light → 暖亮
const fake = (init: Record<string, string> = {}) => ({
	store: { ...init },
	getItem(k: string) { return this.store[k] ?? null; },
	setItem(k: string, v: string) { this.store[k] = v; },
});
assert.equal(readTheme(fake()), "warm-dark", "空存储 → 暖暗（默认，风格指南口径）");
assert.equal(readTheme(fake({ [THEME_STORAGE_KEY]: "warm-light" })), "warm-light", "显式 warm-light → 暖亮");
assert.equal(readTheme(fake({ [THEME_STORAGE_KEY]: "junk" })), "warm-dark", "非法值 → 暖暗");
assert.equal(readTheme(fake({ [THEME_STORAGE_KEY]: "warm-dark" })), "warm-dark", "显式 warm-dark → 暖暗");
assert.equal(readTheme(undefined), "warm-dark", "存储不可用 → 暖暗（不抛）");
ok("② readTheme：默认/显式/非法/不可用四态");

// ③ 读：storage 抛异常 → 暖暗（隐私模式）
const throwing = { getItem() { throw new Error("denied"); } };
assert.equal(readTheme(throwing as never), "warm-dark", "storage 抛错 → 暖暗（不冒泡）");
ok("③ readTheme：存储抛错静默回默认");

// ④ 写：正常写入；抛错静默
const s1 = fake();
writeTheme(s1, "warm-light");
assert.equal(s1.store[THEME_STORAGE_KEY], "warm-light", "writeTheme 落盘");
const boom = { setItem() { throw new Error("quota"); } };
writeTheme(boom as never, "warm-light"); // 不得抛
ok("④ writeTheme：落盘 + 配额满静默");

// ⑤ applyTheme：清另一档再挂当前档（不并存）
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
applyTheme(el as never, "warm-light");
applyTheme(el as never, "warm-light");
assert.deepEqual([...el.classes], ["theme-warm-light"], "重复应用幂等");
ok("⑤ applyTheme：切档清旧 / 不并存 / 幂等");

// ⑥ applyColorScheme：亮→light，暗→dark（原生控件跟随）
const styled = { style: { colorScheme: "" } };
applyColorScheme(styled, "warm-light");
assert.equal(styled.style.colorScheme, "light", "亮档 → color-scheme: light");
applyColorScheme(styled, "warm-dark");
assert.equal(styled.style.colorScheme, "dark", "暗档 → color-scheme: dark");
ok("⑥ applyColorScheme：亮 light / 暗 dark");

// ⑦ 红线：theme.ts 不触存储以外的外部面
import { readFileSync } from "node:fs";
const raw = readFileSync(new URL("./theme.ts", import.meta.url), "utf8");
// 去注释后再查（注释里会解释"不写 config.json"，属说明文字而非行为）
const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
assert.ok(!/fetch\(|\/v1\/|config\.json|document\.|window\./.test(code), "theme.ts 代码零网络/零 config/零 DOM 全局（纯逻辑）");
ok("⑦ theme.ts 纯逻辑（零网络、零 config.json、零 DOM 全局）");

console.log(`\n_test_gui_theme: all assertions passed (${n})`);
