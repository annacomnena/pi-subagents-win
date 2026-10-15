"use client";

/**
 * useTheme — 主题偏好的 React 侧读写（UI 态）。
 *
 * 与 theme.ts 的分工：纯逻辑在 theme.ts（可 Node 测），本 hook 只负责
 * 「读一次 → 变更时同步 DOM class + colorScheme + localStorage」。
 */

import { useCallback, useState } from "react";
import {
	applyColorScheme,
	applyTheme,
	readTheme,
	writeTheme,
	type GuiTheme,
} from "./theme";

export function useTheme(): [GuiTheme, (next: GuiTheme) => void] {
	const [theme, setThemeState] = useState<GuiTheme>(() => readTheme(window.localStorage));

	const setTheme = useCallback((next: GuiTheme) => {
		setThemeState(next);
		applyTheme(document.documentElement, next);
		applyColorScheme(document.documentElement, next);
		writeTheme(window.localStorage, next);
	}, []);

	return [theme, setTheme];
}
