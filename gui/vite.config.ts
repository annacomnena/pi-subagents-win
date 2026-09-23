/**
 * gui/vite.config.ts — dev proxy 把 /v1/* 同源化到 runtime-host（server 零改动：无 CORS、
 * 不托管 dist，见 plans/0921_G5_gui_plan.md 拍板 1）。
 *
 * 端口发现优先级：
 *   1. GUI_HOST_TARGET env（完整 target URL，最高优先）
 *   2. GUI_HOST_PORT env（端口号）
 *   3. host.json（<runtimeDir>/host.json；PI_RUNTIME_DIR 覆盖，同 runtime/journal.ts::defaultRuntimeDir）
 *   4. 兜底 http://127.0.0.1:4317（host bind 动态端口，兜底值仅防 config 抛错——vite 启动期
 *      读一次，host 重启换端口需刷新 vite；gui:dev 会自动代启/复用 host，实际影响窗口极小）
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const FALLBACK_TARGET = "http://127.0.0.1:4317";

function readHostPortFromHostJson(): number | null {
	const runtimeDir =
		process.env.PI_RUNTIME_DIR && process.env.PI_RUNTIME_DIR.trim()
			? process.env.PI_RUNTIME_DIR.trim()
			: join(homedir(), ".pi", "agent", "runtime");
	const path = join(runtimeDir, "host.json");
	try {
		if (!existsSync(path)) return null;
		const raw = JSON.parse(readFileSync(path, "utf8")) as { port?: unknown };
		return typeof raw.port === "number" && Number.isInteger(raw.port) && raw.port > 0 ? raw.port : null;
	} catch {
		return null;
	}
}

function hostToken(): string | null {
	const token = process.env.GUI_HOST_TOKEN;
	return typeof token === "string" && token.length > 0 ? token : null;
}

function resolveProxyTarget(): string {
	const envTarget = process.env.GUI_HOST_TARGET?.trim();
	if (envTarget) return envTarget;
	const envPort = Number(process.env.GUI_HOST_PORT);
	if (Number.isInteger(envPort) && envPort > 0) return `http://127.0.0.1:${envPort}`;
	const port = readHostPortFromHostJson();
	if (port !== null) return `http://127.0.0.1:${port}`;
	console.warn(`[gui] host.json 不可读且未设 GUI_HOST_PORT/GUI_HOST_TARGET —— proxy 兜底 ${FALLBACK_TARGET}`);
	return FALLBACK_TARGET;
}

// 第一切片生产禁 vite（plans/0923_runtime_daemon_final_plan.md §9）：
// PI_RUNTIME_PROFILE=prod 时 dev server 拒绝启动（configureServer 抛错）；
// `vite build`（dist 构建）不受影响——生产 GUI = daemon 自托管 gui/dist。
// 开发一律 `npm run gui:dev`（dev profile + 独立 runtimeDir，见 scripts/gui-dev.mjs）。
const prodGuardPlugin =
	(process.env.PI_RUNTIME_PROFILE ?? "").trim().toLowerCase() === "prod"
		? [
				{
					name: "prod-no-vite-dev-server",
					configureServer(): void {
						throw new Error(
							"[gui] vite dev server 在生产 profile 下被禁止：生产 GUI 由 Runtime Daemon 自托管 gui/dist；开发用 npm run gui:dev",
						);
					},
				},
			]
		: [];

export default defineConfig({
	plugins: [...prodGuardPlugin, react(), tailwindcss()],
	server: {
		proxy: {
			"/v1": {
				target: resolveProxyTarget(),
				changeOrigin: false,
				// G6-P1：WS /v1/events/stream 走同一代理面（http-proxy ws 升级转发）。
				// gui:dev 从 host.json 读取 token，仅在本机 proxy 的上游握手注入；浏览器 URL/日志不含 bearer。
				ws: true,
				configure: (proxy) => {
					// G6-P1：WS 上游握手注入 cookie；G6-P2：HTTP 面（POST /v1/commands 等）同注入 ——
					// 同源浏览器不持有 token（旧 UI 无感），curl/测试等价通道为 X-Command-Token header。
					const inject = (proxyReq: { setHeader: (k: string, v: string) => void }) => {
						const token = hostToken();
						if (token !== null) proxyReq.setHeader("Cookie", `sw_host_token=${token}`);
					};
					proxy.on("proxyReq", inject);
					proxy.on("proxyReqWs", inject);
				},
			},
		},
	},
});
