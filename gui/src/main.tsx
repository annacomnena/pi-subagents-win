// gui/ 内 import 一律不带 .ts/.tsx 扩展名（vite/esbuild bundler resolution 要求）。
// ⚠️ 这与仓库根「strip-types 强制带 .ts 扩展名」惯例相反——勿互相「修正」。
// 详见 gui/README.md。

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
