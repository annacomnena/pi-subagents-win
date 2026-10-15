"use client";

/**
 * useTheme — 主题偏好的 React 侧读写（**内存态**，不持久化）。
 *
 * 与 theme.ts 的分工：纯逻辑在 theme.ts（可 Node 测），本 hook 只负责
 * 「变更时同步 DOM class + colorScheme」。刷新页面即回默认暖暗（可接受）。
 *
 * 为什么不做持久化：见 theme.ts 头注（K3 断言禁止 WebStorage）。
 */

import { useCallback, useState } from "react";
import {
	applyColorScheme,
	applyTheme,
	DEFAULT_THEME,
	type GuiTheme,
} from "./theme";

export function useTheme(): [GuiTheme, (next: GuiTheme) => void] {
	const [theme, setThemeState] = useState<GuiTheme>(DEFAULT_THEME);

	const setTheme = useCallback((next: GuiTheme) => {
		setThemeState(next);
		applyTheme(document.documentElement, next);
		applyColorScheme(document.documentElement, next);
	}, []);

	return [theme, setTheme];
}
