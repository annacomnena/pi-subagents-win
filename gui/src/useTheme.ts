"use client";

/**
 * useTheme — 主题偏好的 React 侧读写（**模块级共享内存态**，不持久化）。
 *
 * 与 theme.ts 的分工：纯逻辑在 theme.ts（可 Node 测），本文件只负责
 * 「共享状态 + 变更时同步 DOM class + colorScheme」。刷新页面即回默认暖暗（可接受）。
 *
 * 为什么不做持久化：见 theme.ts 头注（K3 断言禁止 WebStorage）。
 *
 * 为什么是**模块级 store**（2026-10-16）：主界面顶栏（TopBar）加了亮暗开关后，
 * 主题必须全局唯一——原实现用 `useState` 挂在各调用点，顶栏与「外观」设置页会
 * **各持一份状态**（顶栏切了设置页不跟着变，反之亦然）。改为模块级状态 +
 * `useSyncExternalStore` 订阅：任一调用点切换，所有调用点同时更新。
 */

import { useSyncExternalStore } from "react";
import {
	applyColorScheme,
	applyTheme,
	DEFAULT_THEME,
	nextTheme,
	type GuiTheme,
} from "./theme";

let current: GuiTheme = DEFAULT_THEME;
const listeners = new Set<() => void>();

function emit(): void {
	for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
	listeners.add(l);
	return () => {
		listeners.delete(l);
	};
}

/** 读当前主题（非 React 环境亦可调用，如日志/测试）。 */
export function getTheme(): GuiTheme {
	return current;
}

/** 设为指定档位（幂等：同档重复调用不通知、不重挂 class）。 */
export function setTheme(next: GuiTheme): void {
	if (next === current) return;
	current = next;
	applyTheme(document.documentElement, next);
	applyColorScheme(document.documentElement, next);
	emit();
}

/** 亮暗互切（主界面开关用）。 */
export function toggleTheme(): void {
	setTheme(nextTheme(current));
}

/** 只读订阅（只关心当前档位、不需要 setter 的组件用）。 */
export function useThemeValue(): GuiTheme {
	return useSyncExternalStore(subscribe, getTheme, getTheme);
}

export function useTheme(): [GuiTheme, (next: GuiTheme) => void] {
	return [useThemeValue(), setTheme];
}
