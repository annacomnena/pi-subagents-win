/**
 * _gui_store_ts_loader.mjs — store 级测试（_test_gui_store_pagination / _test_gui_chat_guard /
 * _test_session_first / _test_workspace_group）专用 resolve + load hook。
 *
 * ## 它解决什么（两部分，别只看到第一半）
 *
 * **① extensionless 解析**：gui/src 按 vite/bundler 惯例使用 extensionless 相对导入
 * （store.ts → "./api/client"），node ESM 要求显式扩展名——解析失败时补 `.ts` / `.tsx` 重试。
 *
 * **② `.tsx` 加载**：2026-10-22 实测发现**基线已红**——`store.ts:33` 自 16a3e7b（notify 桥）
 * 起 `import { toast } from "./ui/toast"`，而 `gui/src/ui/toast.tsx` 是 **TSX**，
 * `node --experimental-strip-types` **不能**加载 `.tsx`（`ERR_UNKNOWN_FILE_EXTENSION`）。
 * 于是 `test:gui-store` / `test:gui-chat-guard` / `test:gui-session-first` /
 * `test:gui-workspace-group` 四个套件全部 `ERR_MODULE_NOT_FOUND`（实测：HEAD 的独立 worktree
 * 同样失败 ⇒ 与本轮改动无关）。修法只能是**让 node 能读 TSX**：用 `gui/node_modules/esbuild`
 * （vite 的既有依赖，非新增依赖）把 `.tsx` 就地转成 ESM JS（`jsx: "automatic"` ⇒ 走 react/jsx-runtime，
 * 不要求文件里有 React 在作用域内）。
 *
 * 仅测试基础设施，产品代码零改动；`tsc --noEmit` 与 `vite build` 完全不受影响
 * （它们走各自的原有管线，不加载本 hook）。
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** esbuild 解析：仓库根没有它（gui 的依赖），回退到 gui/node_modules。 */
function loadEsbuild() {
	try {
		return require("../gui/node_modules/esbuild");
	} catch {
		return require("esbuild");
	}
}

const TRANSFORMABLE = /\.(tsx|jsx)$/;

export async function resolve(specifier, context, next) {
	try {
		return await next(specifier, context);
	} catch (e) {
		if (specifier.startsWith(".") && !/\.(ts|tsx|js|jsx|mjs|cjs|json|css|node)$/.test(specifier)) {
			for (const ext of [".ts", ".tsx"]) {
				try {
					return await next(`${specifier}${ext}`, context);
				} catch {
					/* 试下一个后缀 */
				}
			}
		}
		throw e;
	}
}

export async function load(url, context, next) {
	if (!TRANSFORMABLE.test(new URL(url).pathname)) return next(url, context);
	const { readFile } = await import("node:fs/promises");
	const source = await readFile(new URL(url), "utf8");
	const esbuild = loadEsbuild();
	const { code } = esbuild.transformSync(source, {
		loader: url.endsWith(".jsx") ? "jsx" : "tsx",
		format: "esm",
		jsx: "automatic",
		target: "node22",
		// sourcemap 让失败行号指回 .tsx 原文（否则断言失败只剩转换后的行列，定位成本高）
		sourcemap: "inline",
		sourcefile: url,
	});
	return { format: "module", source: code, shortCircuit: true };
}
