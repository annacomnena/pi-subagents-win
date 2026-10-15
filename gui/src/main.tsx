// gui/ 内 import 一律不带 .ts/.tsx 扩展名（vite/esbuild bundler resolution 要求）。
// ⚠️ 这与仓库根「strip-types 强制带 .ts 扩展名」惯例相反——勿互相「修正」。
// 详见 gui/README.md。

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { applyColorScheme, applyTheme, readTheme } from "./theme";

// 主题底座（Anthropic 暖纸体系 §2 C-1/C-2/C-3）：默认暖暗（「暖暗优先」），
// 浅色 `.theme-warm-light` 由 localStorage 偏好切换（入口在 RuntimeOverlay 的运行时设置）。
// 偏好属 UI 态：不写 config.json、不加后端端点、不动 daemon。
const root = document.documentElement;
const initial = readTheme(window.localStorage);
applyTheme(root, initial);
applyColorScheme(root, initial);

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
