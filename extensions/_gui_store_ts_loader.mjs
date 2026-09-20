/**
 * _gui_store_ts_loader.mjs — R3 store 测试（_test_gui_store_pagination.ts）专用 resolve hook。
 *
 * gui/src 按 vite/bundler 惯例使用 extensionless 相对导入（store.ts → "./api/client"），
 * node ESM 要求显式扩展名——此 hook 对解析失败的相对说明符补 `.ts` 重试，使
 * `node --experimental-strip-types` 可直接加载 zustand store（纯 node，无 DOM 渲染）。
 * 仅测试基础设施，产品代码零改动。
 */
export async function resolve(specifier, context, next) {
	try {
		return await next(specifier, context);
	} catch (e) {
		if (specifier.startsWith(".") && !/\.(ts|js|mjs|cjs|json|css|node)$/.test(specifier)) {
			return next(`${specifier}.ts`, context);
		}
		throw e;
	}
}
