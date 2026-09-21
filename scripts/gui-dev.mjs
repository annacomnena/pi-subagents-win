/**
 * scripts/gui-dev.mjs — G5 GUI v0 launcher（拍板 6）。
 *
 * 流程：探活 runtime-host（host.json hint + pid 探针 + /v1/health 探活）→ 不活则 **detached
 * 代启** server.ts（同 /runtime-host start 语义：detached + unref，本脚本退出不连带杀）→
 * spawn vite（前台子进程，Ctrl+C 连带清理）→ 打印 URL（不开浏览器）。
 *
 * 纪律：`/runtime-host start` 零变化（本脚本只读 extensions/，不写）；host 已 alive 直接复用
 * （含 already 场景）；host.json 不可读时也先按 pid/health 无法判定处理 → 代启。
 *
 * 用法（根 package.json）：`npm run gui:dev`。
 * env：PI_RUNTIME_DIR（host.json 定位，同 runtime/journal.ts）；GUI_VITE_PORT（vite 端口，
 * 缺省 5173）。
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_TS = join(REPO_ROOT, "extensions", "runtime-host", "server.ts");
const GUI_DIR = join(REPO_ROOT, "gui");
const VITE_BIN = join(GUI_DIR, "node_modules", "vite", "bin", "vite.js");
const HEALTH_PROBE_TIMEOUT_MS = 1500;
const HOST_START_WAIT_MS = 8000;

function runtimeDir() {
	const override = process.env.PI_RUNTIME_DIR;
	return override && override.trim() ? override.trim() : join(homedir(), ".pi", "agent", "runtime");
}

function readHostInfo() {
	const path = join(runtimeDir(), "host.json");
	try {
		if (!existsSync(path)) return null;
		const v = JSON.parse(readFileSync(path, "utf8"));
		if (typeof v?.instanceId === "string" && typeof v?.pid === "number" && typeof v?.port === "number") return v;
		return null;
	} catch {
		return null;
	}
}

function isProcessAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return e?.code === "EPERM"; // EPERM = 进程在、无信号权限
	}
}

/** GET /v1/health 探活（1.5s 超时；JSON 可解析 = 活）。 */
function fetchHealthOk(port) {
	return new Promise((resolvePromise) => {
		let settled = false;
		const finish = (v) => {
			if (!settled) {
				settled = true;
				resolvePromise(v);
			}
		};
		let req;
		try {
			req = httpRequest({ host: "127.0.0.1", port, path: "/v1/health", method: "GET", timeout: HEALTH_PROBE_TIMEOUT_MS }, (res) => {
				const chunks = [];
				res.on("data", (c) => chunks.push(c));
				res.on("end", () => {
					if (res.statusCode !== 200) return finish(false);
					try {
						JSON.parse(Buffer.concat(chunks).toString("utf8"));
						finish(true);
					} catch {
						finish(false);
					}
				});
				res.on("error", () => finish(false));
			});
		} catch {
			return finish(false);
		}
		req.on("timeout", () => {
			req.destroy();
			finish(false);
		});
		req.on("error", () => finish(false));
		req.end();
	});
}

async function classifyHost() {
	const info = readHostInfo();
	if (!info) return { state: "missing", info: null };
	if (!isProcessAlive(info.pid)) return { state: "dead", info };
	return (await fetchHealthOk(info.port)) ? { state: "alive", info } : { state: "stale", info };
}

/** detached 代启 server.ts（同 startRuntimeHost 的 spawn 形状），轮询 host.json 就绪。 */
function spawnHost() {
	return new Promise((resolvePromise) => {
		let child;
		try {
			child = spawn(process.execPath, ["--experimental-strip-types", SERVER_TS], {
				detached: true,
				stdio: "ignore",
				cwd: dirname(SERVER_TS),
				env: { ...process.env, PI_RUNTIME_DIR: runtimeDir() },
			});
		} catch (e) {
			resolvePromise({ started: false, error: `spawn failed: ${e?.message ?? e}` });
			return;
		}
		child.unref();
		const startedAt0 = new Date().toISOString();
		const t0 = Date.now();
		const poll = setInterval(() => {
			const info = readHostInfo();
			if (info && info.startedAt >= startedAt0 && isProcessAlive(info.pid)) {
				clearInterval(poll);
				resolvePromise({ started: true });
				return;
			}
			if (Date.now() - t0 > HOST_START_WAIT_MS) {
				clearInterval(poll);
				resolvePromise({ started: false, error: `timeout ${HOST_START_WAIT_MS}ms：host.json 未就绪（server 可能启动失败）` });
			}
		}, 100);
	});
}

async function main() {
	if (!existsSync(VITE_BIN)) {
		console.error("[gui:dev] gui/node_modules 缺失——先在 gui/ 下 `npm install`（或根目录 `npm install --prefix gui`）");
		process.exit(1);
	}

	// 1) 探活 → 按需代启 host
	const cls = await classifyHost();
	let hostInfo = cls.info;
	if (cls.state === "alive") {
		console.log(`[gui:dev] runtime-host 已在跑（alive，pid=${hostInfo.pid} port=${hostInfo.port}）——复用`);
	} else {
		console.log(`[gui:dev] runtime-host ${cls.state}（${cls.info ? `pid=${cls.info.pid}` : "无 host.json"}）——代启…`);
		const r = await spawnHost();
		if (!r.started) {
			console.error(`[gui:dev] 代启失败：${r.error}`);
			process.exit(1);
		}
		hostInfo = readHostInfo();
		console.log(`[gui:dev] runtime-host 已启动（pid=${hostInfo?.pid} port=${hostInfo?.port}；detached，本脚本退出不影响）`);
	}

	// 2) spawn vite（前台子进程；Ctrl+C 连带清理）
	const vitePort = Number(process.env.GUI_VITE_PORT) > 0 ? String(Number(process.env.GUI_VITE_PORT)) : undefined;
	// token 只通过 launcher → Vite proxy 的进程内环境传递；绝不拼进浏览器 URL 或日志。
	const wsToken = typeof hostInfo?.token === "string" && hostInfo.token.length > 0 ? hostInfo.token : null;
	const vite = spawn(process.execPath, [VITE_BIN, ...(vitePort ? ["--port", vitePort, "--strictPort"] : [])], {
		cwd: GUI_DIR,
		stdio: "inherit",
		env: { ...process.env, ...(wsToken !== null ? { GUI_HOST_TOKEN: wsToken } : {}) },
	});

	const url = `http://localhost:${vitePort ?? 5173}`;
	console.log(`[gui:dev] GUI: ${url}  （不自动开浏览器；/v1 → 127.0.0.1:${hostInfo?.port ?? "?"}${wsToken !== null ? "，WS 凭据由本机 proxy 注入" : "，警告：无 token，WS 将 401"}）`);

	const cleanup = () => {
		try {
			vite.kill();
		} catch {
			/* ignore */
		}
	};
	process.on("SIGINT", () => {
		cleanup();
		process.exit(130);
	});
	process.on("SIGTERM", () => {
		cleanup();
		process.exit(143);
	});
	vite.on("exit", (code) => {
		// vite 退出（含 Ctrl+C 直达子进程的场景）→ launcher 跟随退出；host（detached）存活
		process.exit(code ?? 0);
	});
}

main().catch((e) => {
	console.error(`[gui:dev] ${e?.message ?? e}`);
	process.exit(1);
});
