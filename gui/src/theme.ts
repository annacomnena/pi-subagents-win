/**
 * theme.ts — 主题偏好（UI 态，纯函数 + 单 hook）。
 *
 * §2 C-2/C-3：暖暗 `.theme-warm-dark` 为默认（风格指南口径「暖暗优先」），
 * 暖亮 `.theme-warm-light` 为结构免费的次选。偏好只存 localStorage：
 * **不写 config.json、不加后端端点、不动 daemon**（C-3 红线）。
 *
 * 独立成模块（而非放 main.tsx）的理由：main.tsx → App → pages 是一条依赖链，
 * 页面若从 main.tsx import 会形成循环依赖。本模块零依赖，两侧共用。
 */

export const THEME_STORAGE_KEY = "od-gui-theme";

export type GuiTheme = "warm-dark" | "warm-light";

export const THEME_CLASSES = ["theme-warm-dark", "theme-warm-light"] as const;

export const THEME_LABEL: Record<GuiTheme, string> = {
	"warm-dark": "暖暗",
	"warm-light": "暖亮",
};

type StorageLike = Pick<Storage, "getItem" | "setItem">;

/** 读偏好：缺失/非法/存储不可用 → 暖暗（默认）。绝不因读失败而抛。 */
export function readTheme(storage: StorageLike | undefined): GuiTheme {
	try {
		return storage?.getItem(THEME_STORAGE_KEY) === "warm-light" ? "warm-light" : "warm-dark";
	} catch {
		return "warm-dark";
	}
}

/** 写偏好：失败静默（配额满/隐私模式禁用时主题仍在本次会话生效）。 */
export function writeTheme(storage: StorageLike | undefined, theme: GuiTheme): void {
	try {
		storage?.setItem(THEME_STORAGE_KEY, theme);
	} catch {
		/* 静默 */
	}
}

type ElLike = { classList: { add(c: string): void; remove(c: string): void } };

/** 应用主题：先清两档再挂当前档（避免并存时规则优先级歧义）。 */
export function applyTheme(el: ElLike, theme: GuiTheme): void {
	for (const c of THEME_CLASSES) el.classList.remove(c);
	el.classList.add(`theme-${theme}`);
}

/** 浏览器原生控件（滚动条等）跟随明暗；暗档可清除。 */
export function applyColorScheme(el: { style: { colorScheme: string } }, theme: GuiTheme): void {
	el.style.colorScheme = theme === "warm-light" ? "light" : "dark";
}
