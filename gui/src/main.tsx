// gui/ 内 import 一律不带 .ts/.tsx 扩展名（vite/esbuild bundler resolution 要求）。
// ⚠️ 这与仓库根「strip-types 强制带 .ts 扩展名」惯例相反——勿互相「修正」。
// 详见 gui/README.md。

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// 主题底座（ZCode 1:1 第 1 步）：Web 默认暗色口径——documentElement 常挂 zai-dark
//（zcode web/main.tsx resolveWebInitialTheme 默认 zai-dark；亮色切换器不做）。
document.documentElement.classList.add("theme-zai-dark");

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
