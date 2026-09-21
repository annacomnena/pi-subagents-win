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

export default defineConfig({
	plugins: [react(), tailwindcss()],
	server: {
		proxy: {
			"/v1": {
				target: resolveProxyTarget(),
				changeOrigin: false,
				// G6-P1：WS /v1/events/stream 走同一代理面（http-proxy ws 升级转发）
				ws: true,
			},
		},
	},
});
