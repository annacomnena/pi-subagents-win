/**
 * _test_runtime_token_hygiene.ts — G6-P1 L4 必修③测试：审查 token 修补防回退
 * （plans/0921_g6p1_review.md §必修结论 3）。
 *
 * 覆盖：
 *   K1 host.json owner-only：POSIX 上 stat mode === 0600（行为）；Windows 上 chmod 不可观测 →
 *      静态断言 discovery.ts 写入/落盘双路径显式 0600（平台无关防回退）
 *   K2 行为面零泄漏：token 不出现在任何 /v1/* HTTP 响应体（health/snapshot/events/attention/
 *      timeline/sessions/transcript）、401 响应体、WS 帧（ack/event/error/resync）；
 *      401 响应不种 Set-Cookie
 *   K3 静态防回退断言：
 *      - gui/src 全量：无 sessionStorage/localStorage；streamUrl 仅以 null 调用（浏览器不持 token）
 *      - gui/vite.config.ts：proxyReqWs 上游 Cookie 注入（sw_host_token）在位
 *      - scripts/gui-dev.mjs：token 只经 GUI_HOST_TOKEN 环境传给本机 Vite 子进程；
 *        无 token 值拼 URL / console 输出
 *      - extensions/runtime-host/*.ts：无 token 值进 console/HTTP body 的语句
 *
 * 运行：npm run test:runtime-token-hygiene
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "token-hygiene-env-"));
process.env.PI_SESSIONS_DIR = mkdtempSync(join(tmpdir(), "token-hygiene-sessions-"));

import { createRuntimeHostServer, type RuntimeHostHandle } from "./runtime-host/server.ts";
import { hostInfoPath } from "./runtime-host/discovery.ts";
import { newEventEnvelope } from "./runtime/envelope.ts";
import { masterAddress } from "./runtime/address.ts";

const ENV_DIR = process.env.PI_RUNTIME_DIR!;
const SESSIONS_DIR = process.env.PI_SESSIONS_DIR!;
const DIRS: string[] = [ENV_DIR, SESSIONS_DIR];
const REPO_ROOT = join(import.meta.dirname ?? ".", "..");

function readSrc(rel: string): string {
	return readFileSync(join(REPO_ROOT, rel), "utf8");
}

function listFilesRecursive(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		try {
			if (statSync(full).isDirectory()) listFilesRecursive(full, out);
			else out.push(full);
		} catch {
			/* ignore */
		}
	}
	return out;
}

// ── K3 静态防回退断言（平台无关，先跑——纯源码约束）──────────────
{
	// gui/src：浏览器侧绝不持久化 token；URL 构造仅 streamUrl(null)（Vite proxy 注入 cookie）
	const guiFiles = listFilesRecursive(join(REPO_ROOT, "gui", "src")).filter((f) => /\.(ts|tsx)$/.test(f));
	assert.ok(guiFiles.length > 0, "K3 前置：gui/src 可读");
	for (const f of guiFiles) {
		const src = readFileSync(f, "utf8");
		assert.ok(!/sessionStorage|localStorage/.test(src), `K3: ${f} 不持久化任何状态到 WebStorage`);
		assert.ok(!/\?token=\$\{/.test(src) || f.endsWith("useEventStream.ts"), `K3: ${f} 不拼 token 进 URL`);
	}
	// streamUrl 调用面：只允许 null（浏览器不持有 token）；排除函数声明（lookbehind）
	for (const f of guiFiles) {
		const src = readFileSync(f, "utf8");
		for (const m of src.matchAll(/(?<!function )streamUrl\(([^)]*)\)/g)) {
			assert.equal(m[1].trim(), "null", `K3: ${f} streamUrl 仅可传 null（实际 ${m[1]}）`);
		}
	}

	// vite proxy：上游 WS 握手注入 cookie 的修补在位
	const vite = readSrc("gui/vite.config.ts");
	assert.ok(/proxyReqWs/.test(vite), "K3: vite.config.ts 保留 proxyReqWs 上游注入");
	assert.ok(/sw_host_token/.test(vite), "K3: vite.config.ts 以 sw_host_token cookie 注入");

	// launcher：token 只经环境变量传给本机 Vite 子进程；不进 URL / 不进日志
	const launcher = readSrc("scripts/gui-dev.mjs");
	assert.ok(/GUI_HOST_TOKEN/.test(launcher), "K3: gui-dev 经 GUI_HOST_TOKEN 环境传 token");
	assert.ok(!/https?:\/\/[^"']*token/i.test(launcher), "K3: gui-dev 不把 token 拼进任何 URL");
	assert.ok(!/console\.(log|info|warn|error)\([^)]*\$\{\s*[A-Za-z_$][\w$.]*[Tt]oken[\w$.]*\s*\}/.test(launcher), "K3: gui-dev 不输出 token 值");

	// runtime-host：无 token 值进 console；HTTP body 的 token 由 T2/K2 行为断言兜底
	for (const name of ["server.ts", "ws.ts", "discovery.ts"]) {
		const src = readSrc(`extensions/runtime-host/${name}`);
		assert.ok(!/console\.(log|info|warn|error)\([^)]*token/i.test(src), `K3: runtime-host/${name} 不 console 输出 token`);
	}

	// discovery：host.json 写入与落盘双路径显式 0600（Windows chmod 失败也不回退语义）
	const discovery = readSrc("extensions/runtime-host/discovery.ts");
	assert.ok(/mode:\s*0o600/.test(discovery), "K3: discovery.ts writeFileSync 显式 0600");
	assert.ok(/chmodSync\([^)]*0o600\)/.test(discovery), "K3: discovery.ts 落盘 chmodSync 0600");
}

// ── K1/K2 行为面 ─────────────────────────────────────────────────

let handle: RuntimeHostHandle | null = null;

try {
	const journalPath = join(ENV_DIR, "events.jsonl");
	handle = await createRuntimeHostServer({ journalPath, sessionsDir: SESSIONS_DIR, tailMs: 30, pingMs: 5000 });
	const token = handle.info.token!;
	assert.ok(token.length > 0, "前置：host 启动生成 token");
	const base = `http://127.0.0.1:${handle.info.port}`;

	// K1 host.json owner-only（POSIX 可观测；Windows 由上方静态断言兜底）
	const hostPath = hostInfoPath();
	assert.ok(typeof token === "string" && readHostJsonToken(hostPath) === token, "K1: host.json 含启动 token");
	if (process.platform !== "win32") {
		const mode = statSync(hostPath).mode & 0o777;
		assert.equal(mode, 0o600, `K1: host.json mode 0600（实际 ${mode.toString(8)}）`);
	}

	// 夹具：journal + session（让各端点有内容可回）
	const e = newEventEnvelope({ type: "test.tick", source: masterAddress(), payload: { n: 1 }, at: "2026-09-22T00:00:00.000Z" });
	appendFileSync(journalPath, `${JSON.stringify(e)}\n`, "utf8");
	const sid = "dddd1111-2222-3333-4444-555566667777";
	writeFileSync(
		join(SESSIONS_DIR, `2026-09-22T12-00-00-000Z_${sid}.jsonl`),
		[
			JSON.stringify({ type: "session", version: 3, id: sid, timestamp: "2026-09-22T12:00:00.000Z", cwd: "C:\\th-test" }),
			JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: "2026-09-22T12:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hi" }] } }),
		].join("\n") + "\n",
		"utf8",
	);

	// K2 行为面零泄漏：全端点 sweep——响应体不含 token 值
	const paths = [
		"/v1/health",
		"/v1/snapshot",
		"/v1/events",
		"/v1/attention",
		"/v1/timeline",
		"/v1/sessions",
		`/v1/sessions/${sid}/transcript`,
		"/v1/nonexistent", // 404 body 也不得回显
	];
	for (const p of paths) {
		const res = await fetch(`${base}${p}`);
		const text = await res.text();
		assert.ok(!text.includes(token), `K2: GET ${p} 响应体不含 token`);
		const setCookie = res.headers.get("set-cookie");
		assert.equal(setCookie, null, `K2: GET ${p} 不种 cookie`);
	}

	// K2：401 路径（无 token 握手）响应体不含 token、不种 cookie（upgrade 头走 node:http）
	{
		const res401 = await new Promise<{ status: number; body: string; setCookie: string | null }>((resolve) => {
			const req = httpRequest(
				{ host: "127.0.0.1", port: handle!.info.port, path: "/v1/events/stream", method: "GET", headers: { connection: "Upgrade", upgrade: "websocket" } },
				(res) => {
					const chunks: Buffer[] = [];
					res.on("data", (c: Buffer) => chunks.push(c));
					res.on("end", () => resolve({
						status: res.statusCode ?? 0,
						body: Buffer.concat(chunks).toString("utf8"),
						setCookie: res.headers["set-cookie"]?.join(";") ?? null,
					}));
				},
			);
			req.on("error", () => resolve({ status: 0, body: "", setCookie: null }));
			req.end();
		});
		assert.equal(res401.status, 401, `K2: 无 token 握手 → 401（实际 ${res401.status}）`);
		assert.ok(!res401.body.includes(token), "K2: 401 body 不含 token");
		assert.equal(res401.setCookie, null, "K2: 401 不种 cookie");
	}

	// K2：WS 帧（ack/event/error/resync）不含 token
	{
		const ws = new WebSocket(`ws://127.0.0.1:${handle.info.port}/v1/events/stream?token=${encodeURIComponent(token)}`);
		const frames: string[] = [];
		ws.onmessage = (ev: MessageEvent) => {
			frames.push(typeof ev.data === "string" ? ev.data : "");
		};
		await new Promise<void>((resolve, reject) => {
			const t = setTimeout(() => reject(new Error("ws open timeout")), 3000);
			ws.onopen = () => {
				clearTimeout(t);
				ws.send(JSON.stringify({ type: "subscribe", topic: "journal", base: {} }));
				ws.send(JSON.stringify({ type: "subscribe", topic: `transcript:${sid}`, base: {} }));
				ws.send("not-json"); // error 帧
				resolve();
			};
			ws.onerror = () => {
				clearTimeout(t);
				reject(new Error("ws error"));
			};
		});
		await new Promise((r) => setTimeout(r, 1200)); // 时窗收帧（ack×2/error/event）
		try {
			ws.close();
		} catch {
			/* ignore */
		}
		assert.ok(frames.length >= 3, `K2: WS 响应帧已收（实际 ${frames.length}）`);
		for (const f of frames) {
			assert.ok(!f.includes(token), `K2: WS 帧不含 token：${f.slice(0, 80)}`);
		}
	}

	console.log("_test_runtime_token_hygiene: all assertions passed");
} finally {
	if (handle) {
		await handle.close().catch(() => undefined);
	}
	for (const d of DIRS) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}
}

function readHostJsonToken(path: string): string | null {
	try {
		const v = JSON.parse(readFileSync(path, "utf8")) as { token?: unknown };
		return typeof v.token === "string" ? v.token : null;
	} catch {
		return null;
	}
}
