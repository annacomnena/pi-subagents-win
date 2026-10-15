// gui/ 内 import 一律不带 .ts/.tsx 扩展名（vite/esbuild bundler resolution 要求）。
// ⚠️ 这与仓库根「strip-types 强制带 .ts 扩展名」惯例相反——勿互相「修正」。
// 详见 gui/README.md。

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// 主题底座（Anthropic 暖纸体系 §2 C-1）：Web 默认暗色口径——documentElement 常挂
// .theme-warm-dark（暖炭底 + 陶土重音）；浅色 .theme-warm-light 只留定义，切换器 C-3 本轮不做。
document.documentElement.classList.add("theme-warm-dark");

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
