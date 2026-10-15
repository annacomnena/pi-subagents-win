// gui/ 内 import 一律不带 .ts/.tsx 扩展名（vite/esbuild bundler resolution 要求）。
// ⚠️ 这与仓库根「strip-types 强制带 .ts 扩展名」惯例相反——勿互相「修正」。
// 详见 gui/README.md。

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { applyColorScheme, applyTheme, DEFAULT_THEME } from "./theme";

// 主题底座（Anthropic 暖纸体系 §2 C-1/C-2/C-3）：默认暖暗（「暖暗优先」）。
// 浅色 `.theme-warm-light` 由运行时覆盖层的「外观」页切换（内存态，不持久化 —— 见 theme.ts 头注）。
const root = document.documentElement;
applyTheme(root, DEFAULT_THEME);
applyColorScheme(root, DEFAULT_THEME);

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
