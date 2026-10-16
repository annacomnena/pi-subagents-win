/**
 * theme.ts — 主题偏好（UI 态，纯函数 + 单 hook）。
 *
 * §2 C-2/C-3：暖暗 `.theme-warm-dark` 为默认（风格指南口径「暖暗优先」），
 * 暖亮 `.theme-warm-light` 为结构免费的次选。
 *
 * ## 为什么**不**持久化（2026-10-16 修正）
 * 本仓 `_test_runtime_token_hygiene.ts` 的 K3 断言（2026-09-21 引入，早于本文件）要求
 * **`gui/src` 全量禁止浏览器 WebStorage**（K3），理由是「浏览器侧绝不持久化 token」。
 * 我最初用 WebStorage 存主题偏好时**只跑了 GUI 6 个测试、没跑全量** ⇒ 漏检该断言（回归）。
 * 反查：本仓**无** UI 偏好服务端端点（gui 侧只有 `/v1/*` 只读投影 + 命令），
 * 而用户的主题选择**无需跨会话保留**（刷新后回默认暖暗是可接受的）。
 * ⇒ 改为**内存态**：保留切换功能，不持久化 ⇒ 既过断言又不减功能。
 */

export type GuiTheme = "warm-dark" | "warm-light";

export const THEME_CLASSES = ["theme-warm-dark", "theme-warm-light"] as const;

export const THEME_LABEL: Record<GuiTheme, string> = {
	"warm-dark": "暖暗",
	"warm-light": "暖亮",
};

/** 默认主题（风格指南口径：暖暗优先）。 */
export const DEFAULT_THEME: GuiTheme = "warm-dark";

/** 切到另一档（纯函数；主界面亮暗开关与「外观」设置页共用同一判定）。 */
export function nextTheme(theme: GuiTheme): GuiTheme {
	return theme === "warm-dark" ? "warm-light" : "warm-dark";
}

type ElLike = { classList: { add(c: string): void; remove(c: string): void } };

/** 应用主题：先清两档再挂当前档（避免并存时规则优先级歧义）。 */
export function applyTheme(el: ElLike, theme: GuiTheme): void {
	for (const c of THEME_CLASSES) el.classList.remove(c);
	el.classList.add(`theme-${theme}`);
}

/** 浏览器原生控件（滚动条等）跟随明暗。 */
export function applyColorScheme(el: { style: { colorScheme: string } }, theme: GuiTheme): void {
	el.style.colorScheme = theme === "warm-light" ? "light" : "dark";
}

