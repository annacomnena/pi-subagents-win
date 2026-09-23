/**
 * _test_wechat_bind.ts — 0923 微信 iLink 绑定切片（v1：绑定/解绑/状态）离线单测
 *
 * 运行：npx tsx extensions/_test_wechat_bind.ts
 *
 * 覆盖（任务指定项 + plans/0923_wechat_gui_bind_plan.md 阶段 2 测试面）：
 *   T1  取码字段别名（qrcode/qr_code、qrcode_img_content/qrcode_url、data 直包、expires_in 缺省 120、
 *       ret≠0、HTTP 500、字段缺失、10s 超时（注入 150ms）→ bind-failed 而非 cancelled）
 *   T2  状态映射（0/1/2/3/4/其他数字；status/qrcode_status 别名；confirmed/expired 别名集；
 *       未知串→pending 继续轮询；bot_token/token；ilink_bot_id/bot_id）
 *   T3  payload unwrap（data 直包 / 顶层 / 非对象）
 *   T4  管理器全流程（waiting→scanned→bound；凭据落盘 0600+内容；状态投影无 token；
 *       幂等 start 同 qr+expiresAt；unbind→idle+删文件不留空壳）
 *   T5  有界上限（pending 恒 + maxBindMs=300 → expired，及时释放）
 *   T6  confirmed 但无 bot_token → error（可重新生成）
 *   T7  磁盘已有凭据 → start 409 already-bound 同源错误；cancel→idle（cancel 不删凭据）
 *   T8  在途 unbind → idle + 流程 abort（迟到 confirmed 不落盘）
 *   T9  readWechatEnabled（缺段/坏 JSON/非严格布尔 → false；true → true；默认 OFF fail-closed）
 *   T10 opt-in OFF：5 端点 无/错 token → 401；对 token → 403 wechat-disabled（不分端点）
 *   T11 opt-in ON：idle→start（幂等）→qr-image data URL→bound（原始响应文本无 token）→
 *       409 already-bound→unbind（removed+idle+文件删）→qr-image 409 no-active-session→
 *       start+cancel→idle
 *
 * 红线自证：token 永不进任何 HTTP 响应（T11 对 start/status/qr-image 原始文本扫描）；
 * 凭据 0600（win32 仅尽力——非 Windows 才断言 mode，Windows 断言内容正确）。
 */

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// 测试隔离（lazy 读取 env 的默认路径在此生效；与 _test_runtime_host_server.ts 同模式）
process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "wechat-bind-test-env-")).replace(/[\\/]+$/, "");

import { createRuntimeHostServer, type RuntimeHostHandle } from "./runtime-host/server.ts";
import {
	WechatAlreadyBoundError,
	WechatBindError,
	WechatBindManager,
	fetchQrCode,
	parseQrStatus,
	readWechatCreds,
	readWechatEnabled,
	unwrapPayload,
	writeWechatCreds0600,
	wechatCredsPath,
	type WechatFetch,
} from "./runtime-host/wechat-bind.ts";

// ── 小工具 ──────────────────────────────────────────────────────────

let passed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
	try {
		await fn();
		passed += 1;
		console.log(`  ok  ${name}`);
	} catch (e) {
		failures.push(name);
		console.error(`  FAIL ${name}\n${e instanceof Error ? e.stack : String(e)}`);
	}
}

function mkdtemp(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

function jsonRes(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** fake fetch（signal 感知：已 abort / 超时 abort → reject；供超时与取消路径测试）。 */
function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): WechatFetch {
	return (url, init) =>
		new Promise<Response>((resolve, reject) => {
			const signal = init?.signal ?? null;
			const onAbort = (): void => reject(new DOMException("aborted", "AbortError"));
			if (signal !== null) {
				if (signal.aborted) {
					onAbort();
					return;
				}
				signal.addEventListener("abort", onAbort, { once: true });
			}
			Promise.resolve()
				.then(() => handler(url, init))
				.then(
					(v) => {
						if (signal !== null) signal.removeEventListener("abort", onAbort);
						resolve(v);
					},
					(e: unknown) => {
						if (signal !== null) signal.removeEventListener("abort", onAbort);
						reject(e);
					},
				);
		});
}

async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
	const t0 = Date.now();
	while (!cond()) {
		if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor 超时: ${what}`);
		await new Promise((r) => setTimeout(r, 20));
	}
}

// ── T1 取码：字段别名 / 错误面 / 超时 ─────────────────────────────────

async function t1(): Promise<void> {
	const dir = mkdtemp("wechat-t1-");
	try {
		const mk = (fetchImpl: WechatFetch, extra: Partial<ConstructorParameters<typeof WechatBindManager>[0]> = {}) =>
			new WechatBindManager({ runtimeDir: dir, baseUrl: "https://stub.example", fetchImpl, pollIntervalMs: 50, maxBindMs: 60_000, ...extra });
		// a) 顶层 + 原字段名 + expires_in
		{
			const m = mk(fakeFetch(() => jsonRes({ qrcode: "qr-a", qrcode_img_content: "https://stub.example/qr/a.png", expires_in: 90 })));
			const r = await m.start();
			assert.equal(r.qrImageUrl, "https://stub.example/qr/a.png");
			assert.equal(r.expiresIn, 90);
			m.dispose();
		}
		// b) data 直包 + 别名（qr_code / qrcode_url）+ 无 expires_in → 缺省 120
		{
			const m = mk(fakeFetch(() => jsonRes({ data: { qr_code: "qr-b", qrcode_url: "https://stub.example/qr/b.png" } })));
			const r = await m.start();
			assert.equal(r.qrImageUrl, "https://stub.example/qr/b.png");
			assert.equal(r.expiresIn, 120);
			m.dispose();
		}
		// c) ret≠0 → 失败
		{
			const m = mk(fakeFetch(() => jsonRes({ ret: 1, errmsg: "denied" })));
			await assert.rejects(() => m.start(), (e: unknown) => e instanceof WechatBindError && e.message.includes("ret=1"));
			m.dispose();
		}
		// d) HTTP 500 → 失败
		{
			const m = mk(fakeFetch(() => jsonRes({ qrcode: "x" }, 500)));
			await assert.rejects(() => m.start(), (e: unknown) => e instanceof WechatBindError && e.message.includes("HTTP 500"));
			m.dispose();
		}
		// e) 字段缺失（无图片 URL）
		{
			const m = mk(fakeFetch(() => jsonRes({ qrcode: "qr-only" })));
			await assert.rejects(() => m.start(), (e: unknown) => e instanceof WechatBindError && e.message.includes("缺失"));
			m.dispose();
		}
		// f) 超时（注入 150ms；模拟“慢服务器” 5s 才回——ref'd timer 保活，与真实 socket 同语义）
		//    → 150ms 客户端超时 abort 在先，快速 bind-failed（且**不**是 cancelled）
		{
			const m = mk(
				(_url, init) =>
					new Promise<Response>((resolve, reject) => {
						const t = setTimeout(() => resolve(jsonRes({ qrcode: "late", qrcode_img_content: "https://s/l.png" })), 5000);
						const s = init?.signal ?? null;
						if (s !== null) {
							const onAbort = (): void => {
								clearTimeout(t);
								reject(new DOMException("aborted", "AbortError"));
							};
							if (s.aborted) {
								onAbort();
								return;
							}
							s.addEventListener("abort", onAbort, { once: true });
						}
					}),
				{ qrFetchTimeoutMs: 150 },
			);
			const t0 = Date.now();
			await assert.rejects(
				() => m.start(),
				(e: unknown) => e instanceof WechatBindError && !(e.message.includes("已取消") || e.message === "cancelled"),
			);
			const took = Date.now() - t0;
			assert.ok(took < 2000, `超时路径应快速（took ${took}ms）`);
			m.dispose();
		}
		// g) fetchQrCode 直调（纯函数面）
		{
			const ac = new AbortController();
			const r = await fetchQrCode({ baseUrl: "https://stub.example/", fetchImpl: fakeFetch(() => jsonRes({ data: { qr_code: "q1", qrcode_url: "https://s/q.png", expires_in: 30 } })), signal: ac.signal });
			assert.equal(r.qr, "q1");
			assert.equal(r.qrImageUrl, "https://s/q.png");
			assert.equal(r.expiresIn, 30);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ── T2 状态映射 ─────────────────────────────────────────────────────

function t2(): void {
	assert.equal(parseQrStatus({ status: 0 }).kind, "pending");
	assert.equal(parseQrStatus({ status: 1 }).kind, "scanned");
	assert.equal(parseQrStatus({ status: 3 }).kind, "expired");
	assert.equal(parseQrStatus({ status: 4 }).kind, "expired");
	assert.equal(parseQrStatus({ status: 9 }).kind, "expired", "其他数字 → expired（probe 同口径）");
	assert.equal(parseQrStatus({ qrcode_status: "scanned" }).kind, "scanned", "qrcode_status 别名");
	assert.equal(parseQrStatus({ status: "CONFIRMED" }).kind, "confirmed", "大小写不敏感");
	assert.equal(parseQrStatus({ status: "success" }).kind, "confirmed");
	assert.equal(parseQrStatus({ status: "authorized" }).kind, "confirmed");
	assert.equal(parseQrStatus({ status: "ok" }).kind, "confirmed");
	assert.equal(parseQrStatus({ status: "expired" }).kind, "expired");
	assert.equal(parseQrStatus({ status: "timeout" }).kind, "expired");
	assert.equal(parseQrStatus({ status: "cancel" }).kind, "expired");
	assert.equal(parseQrStatus({ status: "cancelled" }).kind, "expired");
	assert.equal(parseQrStatus({ status: "pending" }).kind, "pending");
	assert.equal(parseQrStatus({ status: "waiting" }).kind, "pending");
	assert.equal(parseQrStatus({ status: "weird-unknown" }).kind, "pending", "未知串 → 继续轮询（probe 行为）");
	assert.equal(parseQrStatus({}).kind, "pending", "字段缺失 → pending");
	assert.equal(parseQrStatus(null).kind, "pending");
	const c = parseQrStatus({ status: 2, token: "t3", bot_id: "b3" });
	assert.equal(c.kind, "confirmed");
	assert.equal(c.botToken, "t3", "token 别名");
	assert.equal(c.botId, "b3", "bot_id 别名");
	const c2 = parseQrStatus({ status: 2, bot_token: "t4", ilink_bot_id: "b4" });
	assert.equal(c2.botToken, "t4");
	assert.equal(c2.botId, "b4");
	assert.equal(parseQrStatus({ status: 2 }).botToken, "", "confirmed 无 token → 空串（管理器转 error）");
}

// ── T3 payload unwrap ───────────────────────────────────────────────

function t3(): void {
	assert.equal((unwrapPayload({ data: { qrcode: "x" } }) as Record<string, unknown>).qrcode, "x", "data 直包");
	assert.equal((unwrapPayload({ qrcode: "y" }) as Record<string, unknown>).qrcode, "y", "顶层包");
	assert.deepEqual(unwrapPayload(null), {});
	assert.deepEqual(unwrapPayload("str"), {});
	assert.deepEqual(unwrapPayload([{ qrcode: "z" }]), {});
	assert.deepEqual(unwrapPayload({ data: "not-obj", qrcode: "top" }), { data: "not-obj", qrcode: "top" }, "data 非对象 → 顶层");
}

// ── T4 管理器全流程 ─────────────────────────────────────────────────

async function t4(): Promise<void> {
	const dir = mkdtemp("wechat-t4-");
	try {
		let poll = 0;
		const m = new WechatBindManager({
			runtimeDir: dir,
			baseUrl: "https://stub.example",
			fetchImpl: fakeFetch((url) => {
				if (url.includes("get_bot_qrcode")) return jsonRes({ qrcode: "qr-c", qrcode_img_content: "https://stub.example/qr/c.png", expires_in: 120 });
				if (url.includes("get_qrcode_status")) {
					poll += 1;
					if (poll === 1) return jsonRes({ status: 0 });
					if (poll === 2) return jsonRes({ qrcode_status: "scanned" });
					return jsonRes({ data: { status: 2, bot_token: "tok-123", ilink_bot_id: "bot-1" } });
				}
				return new Response("nf", { status: 404 });
			}),
			pollIntervalMs: 30,
			maxBindMs: 10_000,
		});
		const r1 = await m.start();
		assert.equal(m.getState().state, "waiting");
		// 幂等：同未过期会话重调 → 同一 qr+expiresAt
		const r2 = await m.start();
		assert.deepEqual(r2, r1);
		await waitFor(() => m.getState().state === "bound", 5000, "bound");
		const st = m.getState();
		assert.equal(st.state, "bound");
		assert.equal(st.botIdPresent, true);
		assert.ok(st.boundAt !== null && st.boundAt.length > 0, "boundAt 存在");
		assert.equal(JSON.stringify(st).includes("tok-123"), false, "token 永不进状态投影");
		// 凭据落盘：内容 + 0600（win32 仅尽力 → 非 Windows 才断言 mode）
		const credsPath = wechatCredsPath(dir);
		assert.ok(existsSync(credsPath), "凭据文件存在");
		const creds = readWechatCreds(credsPath);
		assert.equal(creds?.botToken, "tok-123");
		assert.equal(creds?.botId, "bot-1");
		assert.equal(creds?.baseUrl, "https://stub.example");
		assert.ok(creds !== null && creds.boundAt.length > 0);
		if (process.platform !== "win32") {
			assert.equal(statSync(credsPath).mode & 0o777, 0o600, "凭据 0600");
		}
		// unbind → idle + 删文件（不留空壳）
		const removed = m.unbind();
		assert.equal(removed, true);
		assert.equal(m.getState().state, "idle");
		assert.equal(existsSync(credsPath), false, "凭据文件已删");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ── T5 有界上限（expired）───────────────────────────────────────────

async function t5(): Promise<void> {
	const dir = mkdtemp("wechat-t5-");
	try {
		const m = new WechatBindManager({
			runtimeDir: dir,
			baseUrl: "https://stub.example",
			fetchImpl: fakeFetch((url) => (url.includes("get_bot_qrcode") ? jsonRes({ qrcode: "qr", qrcode_img_content: "https://s/q.png" }) : jsonRes({ status: 0 }))),
			pollIntervalMs: 30,
			maxBindMs: 300, // 有界上限 300ms（deadline = min(expires_in 120s, 300ms)）
		});
		const t0 = Date.now();
		await m.start();
		await waitFor(() => m.getState().state === "expired", 3000, "expired");
		const took = Date.now() - t0;
		assert.ok(took < 2500, `上限内释放（took ${took}ms）`);
		assert.equal(existsSync(wechatCredsPath(dir)), false, "expired 不落凭据");
		m.dispose();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ── T6 confirmed 无 bot_token → error ──────────────────────────────

async function t6(): Promise<void> {
	const dir = mkdtemp("wechat-t6-");
	try {
		const m = new WechatBindManager({
			runtimeDir: dir,
			baseUrl: "https://stub.example",
			fetchImpl: fakeFetch((url) => (url.includes("get_bot_qrcode") ? jsonRes({ qrcode: "qr", qrcode_img_content: "https://s/q.png" }) : jsonRes({ status: 2 }))),
			pollIntervalMs: 30,
			maxBindMs: 5000,
		});
		await m.start();
		await waitFor(() => m.getState().state === "error", 5000, "error");
		assert.ok((m.getState().message ?? "").includes("bot_token"), "error 消息含原因（不含 token）");
		assert.equal(existsSync(wechatCredsPath(dir)), false, "error 不落凭据");
		// error 终态可重新生成
		await m.start();
		assert.equal(m.getState().state, "waiting");
		m.dispose();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ── T7 磁盘凭据 → already-bound；cancel → idle（不删凭据）───────────

async function t7(): Promise<void> {
	const dir = mkdtemp("wechat-t7-");
	try {
		// a) 磁盘已有凭据：start → WechatAlreadyBoundError；getState 兜出 bound
		{
			writeWechatCreds0600(wechatCredsPath(dir), { botToken: "pre-token", boundAt: new Date().toISOString(), baseUrl: "https://stub.example" });
			const m = new WechatBindManager({
				runtimeDir: dir,
				baseUrl: "https://stub.example",
				fetchImpl: fakeFetch(() => jsonRes({ qrcode: "qr", qrcode_img_content: "https://s/q.png" })),
				pollIntervalMs: 50,
				maxBindMs: 30_000,
			});
			await assert.rejects(() => m.start(), WechatAlreadyBoundError);
			assert.equal(m.getState().state, "bound", "磁盘凭据 → bound（跨重启保留）");
			// cancel 不删凭据（解绑是 unbind 的事）
			m.cancel();
			assert.equal(m.getState().state, "bound");
			assert.ok(existsSync(wechatCredsPath(dir)));
			m.dispose();
		}
		// b) 无凭据：start（pending）→ cancel → idle
		{
			const dir2 = mkdtemp("wechat-t7b-");
			try {
				const m = new WechatBindManager({
					runtimeDir: dir2,
					baseUrl: "https://stub.example",
					fetchImpl: fakeFetch((url) => (url.includes("get_bot_qrcode") ? jsonRes({ qrcode: "qr", qrcode_img_content: "https://s/q.png" }) : jsonRes({ status: 0 }))),
					pollIntervalMs: 30,
					maxBindMs: 30_000,
				});
				await m.start();
				assert.equal(m.getState().state, "waiting");
				m.cancel();
				assert.equal(m.getState().state, "idle");
				// cancel 幂等
				m.cancel();
				assert.equal(m.getState().state, "idle");
				m.dispose();
			} finally {
				rmSync(dir2, { recursive: true, force: true });
			}
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ── T8 在途 unbind → idle + 流程 abort（迟到 confirmed 不落盘）──────

async function t8(): Promise<void> {
	const dir = mkdtemp("wechat-t8-");
	try {
		let confirm = false;
		const m = new WechatBindManager({
			runtimeDir: dir,
			baseUrl: "https://stub.example",
			fetchImpl: fakeFetch((url) => {
				if (url.includes("get_bot_qrcode")) return jsonRes({ qrcode: "qr", qrcode_img_content: "https://s/q.png" });
				return jsonRes(confirm ? { status: 2, bot_token: "tok-late" } : { status: 0 });
			}),
			pollIntervalMs: 30,
			maxBindMs: 30_000,
		});
		await m.start();
		await new Promise((r) => setTimeout(r, 120)); // 让流程跑几拍
		const removed = m.unbind();
		assert.equal(removed, false, "在途无凭据文件 → removed=false");
		assert.equal(m.getState().state, "idle");
		// 服务端其后确认 → 已 abort，不得落盘
		confirm = true;
		await new Promise((r) => setTimeout(r, 200));
		assert.equal(existsSync(wechatCredsPath(dir)), false, "abort 后迟到的 confirmed 不落凭据");
		assert.equal(m.getState().state, "idle");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ── T9 readWechatEnabled（opt-in 闸，默认 OFF fail-closed）──────────

function t9(): void {
	const dir = mkdtemp("wechat-t9-");
	try {
		assert.equal(readWechatEnabled(join(dir, "missing.json")), false, "缺文件 → false");
		const p = join(dir, "c.json");
		writeFileSync(p, "{}", "utf8");
		assert.equal(readWechatEnabled(p), false, "缺段 → false（默认 OFF）");
		writeFileSync(p, "{bad json", "utf8");
		assert.equal(readWechatEnabled(p), false, "坏 JSON → false");
		writeFileSync(p, JSON.stringify({ channels: { wechat: { enabled: "yes" } } }), "utf8");
		assert.equal(readWechatEnabled(p), false, "非严格布尔 → false");
		writeFileSync(p, JSON.stringify({ channels: { wechat: { enabled: false } } }), "utf8");
		assert.equal(readWechatEnabled(p), false, "显式 false → false");
		writeFileSync(p, JSON.stringify({ channels: { wechat: { enabled: true } } }), "utf8");
		assert.equal(readWechatEnabled(p), true, "显式 true → true");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ── stub iLink（T10/T11 用：真 HTTP，127.0.0.1）─────────────────────

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="; // 1x1 PNG

async function startStubIlink(): Promise<{ port: number; setMode: (m: "auto" | "pending") => void; close: () => Promise<void> }> {
	let port = 0;
	let mode: "auto" | "pending" = "auto";
	let polls = 0;
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const u = new URL(req.url ?? "/", "http://127.0.0.1");
		res.setHeader("content-type", "application/json");
		if (u.pathname === "/ilink/bot/get_bot_qrcode") {
			res.end(JSON.stringify({ qrcode: "sqr", qrcode_img_content: `http://127.0.0.1:${port}/img.png`, expires_in: 120 }));
			return;
		}
		if (u.pathname === "/img.png") {
			res.setHeader("content-type", "image/png");
			res.end(Buffer.from(PNG_B64, "base64"));
			return;
		}
		if (u.pathname === "/ilink/bot/get_qrcode_status") {
			if (mode === "pending") {
				res.end(JSON.stringify({ status: 0 }));
				return;
			}
			polls += 1;
			if (polls === 1) res.end(JSON.stringify({ status: 0 }));
			else if (polls === 2) res.end(JSON.stringify({ status: 1 }));
			else res.end(JSON.stringify({ status: 2, bot_token: "stub-tok-abc", ilink_bot_id: "stub-bot" }));
			return;
		}
		res.statusCode = 404;
		res.end("nf");
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
	const addr = server.address();
	port = typeof addr === "object" && addr !== null ? addr.port : 0;
	return { port, setMode: (m) => { mode = m; }, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function mkServerOpts(D: string, over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		hostPath: join(D, "host.json"),
		timersDir: join(D, "timers"),
		stateDir: join(D, "state"),
		mailboxDir: join(D, "m"),
		journalPath: join(D, "events.jsonl"),
		sessionsDir: join(D, "sessions"),
		lockWaitMs: 500,
		wechatRuntimeDir: join(D, "wechat-rt"),
		...over,
	};
}

// ── T10 opt-in OFF：全 403（+ 401 门）──────────────────────────────

async function t10(): Promise<void> {
	const D = mkdtemp("wechat-t10-");
	let h: RuntimeHostHandle | null = null;
	try {
		writeFileSync(join(D, "config.json"), "{}", "utf8"); // 无 channels 段 → 默认 OFF
		h = await createRuntimeHostServer(mkServerOpts(D, { configPath: join(D, "config.json") }) as Parameters<typeof createRuntimeHostServer>[0]);
		const base = `http://127.0.0.1:${h.info.port}`;
		const tok = h.info.token;
		const endpoints: [string, string][] = [
			["/v1/wechat/bind/status", "GET"],
			["/v1/wechat/bind/qr-image", "GET"],
			["/v1/wechat/bind/start", "POST"],
			["/v1/wechat/bind/cancel", "POST"],
			["/v1/wechat/unbind", "POST"],
		];
		for (const [path, method] of endpoints) {
			const doReq = (headers: Record<string, string>): Promise<{ status: number; body: { error?: unknown } | null }> =>
				fetch(`${base}${path}`, { method, headers, ...(method === "POST" ? { body: "{}", "content-type": "application/json" } as Record<string, string> : {}) }).then(async (res) => ({
					status: res.status,
					body: (await res.json().catch(() => null)) as { error?: unknown } | null,
				}));
			// 无 token → 401
			let r = await doReq({});
			assert.equal(r.status, 401, `无 token ${method} ${path} → 401`);
			// 错 token → 401
			r = await doReq({ "x-command-token": "wrong-token" });
			assert.equal(r.status, 401, `错 token ${method} ${path} → 401`);
			// 对 token 但未启用 → 403 wechat-disabled
			r = await doReq({ "x-command-token": tok });
			assert.equal(r.status, 403, `对 token ${method} ${path} → 403`);
			assert.equal(r.body?.error, "wechat-disabled");
		}
	} finally {
		if (h !== null) await h.close();
		rmSync(D, { recursive: true, force: true });
	}
}

// ── T11 opt-in ON：HTTP 全流程 ─────────────────────────────────────

async function t11(): Promise<void> {
	const stub = await startStubIlink();
	const D = mkdtemp("wechat-t11-");
	let h: RuntimeHostHandle | null = null;
	try {
		writeFileSync(join(D, "config.json"), JSON.stringify({ channels: { wechat: { enabled: true } } }), "utf8");
		h = await createRuntimeHostServer(
			mkServerOpts(D, {
				configPath: join(D, "config.json"),
				wechatBaseUrl: `http://127.0.0.1:${stub.port}`,
				wechatPollIntervalMs: 100,
			}) as Parameters<typeof createRuntimeHostServer>[0],
		);
		const base = `http://127.0.0.1:${h.info.port}`;
		const H = { "x-command-token": h.info.token };
		const get = async (path: string): Promise<{ status: number; text: string; body: any }> => {
			const res = await fetch(`${base}${path}`, { headers: H });
			const text = await res.text();
			return { status: res.status, text, body: JSON.parse(text) };
		};
		const post = async (path: string): Promise<{ status: number; text: string; body: any }> => {
			const res = await fetch(`${base}${path}`, { method: "POST", headers: { ...H, "content-type": "application/json" }, body: "{}" });
			const text = await res.text();
			return { status: res.status, text, body: JSON.parse(text) };
		};
		const pollUntil = async (want: string, timeoutMs: number): Promise<void> => {
			const t0 = Date.now();
			for (;;) {
				const s = await get("/v1/wechat/bind/status");
				if (s.body.state === want) return;
				if (Date.now() - t0 > timeoutMs) throw new Error(`state=${want} 超时（现在 ${s.body.state}）`);
				await new Promise((r) => setTimeout(r, 100));
			}
		};

		// 1) idle
		let r = await get("/v1/wechat/bind/status");
		assert.equal(r.status, 200);
		assert.equal(r.body.state, "idle");
		// 2) start → waiting（qrImageUrl/expiresAt/expiresIn）
		r = await post("/v1/wechat/bind/start");
		assert.equal(r.status, 200, `start 200（${r.text}）`);
		assert.equal(r.body.state, "waiting");
		const qr1 = r.body.qr as { qrImageUrl: string; expiresAt: number; expiresIn: number };
		assert.ok(qr1.qrImageUrl.includes("/img.png"), "qrImageUrl 指向 stub 图片");
		assert.equal(qr1.expiresIn, 120);
		assert.ok(Number.isFinite(qr1.expiresAt) && qr1.expiresAt > Date.now(), "expiresAt 在未来");
		// 3) 幂等：同会话重调 → 同一 qr+expiresAt
		const r2 = await post("/v1/wechat/bind/start");
		assert.equal(r2.status, 200);
		assert.deepEqual(r2.body.qr, qr1, "幂等：同 qr+expiresAt");
		// 4) qr-image → data URL（1x1 png）
		const ri = await get("/v1/wechat/bind/qr-image");
		assert.equal(ri.status, 200);
		assert.equal(ri.body.dataUrl, `data:image/png;base64,${PNG_B64}`, "data URL（代理转码）");
		assert.equal(ri.body.url, qr1.qrImageUrl);
		assert.equal(ri.body.error, null);
		// 5) 等 bound（stub 序列 0→1→2，100ms 节拍 → ~300ms）
		await pollUntil("bound", 8000);
		// 6) bound：无 token + botIdPresent + boundAt
		const st = await get("/v1/wechat/bind/status");
		assert.equal(st.body.state, "bound");
		assert.equal(st.body.botIdPresent, true);
		assert.ok(typeof st.body.boundAt === "string" && st.body.boundAt.length > 0);
		assert.equal(st.text.includes("stub-tok-abc"), false, "status 响应无 token");
		assert.equal(r.text.includes("stub-tok-abc"), false, "start 响应无 token");
		assert.equal(ri.text.includes("stub-tok-abc"), false, "qr-image 响应无 token");
		// 7) 凭据落盘 + 0600（win32 仅尽力）
		const credsPath = join(D, "wechat-rt", "wechat", "credentials.json");
		assert.ok(existsSync(credsPath), "凭据文件存在");
		const credsRaw = JSON.parse(readFileSync(credsPath, "utf8")) as { botToken?: string };
		assert.equal(credsRaw.botToken, "stub-tok-abc", "token 落盘（文件仅本机可读）");
		if (process.platform !== "win32") assert.equal(statSync(credsPath).mode & 0o777, 0o600, "凭据 0600");
		// 8) 再 start → 409 already-bound
		const r3 = await post("/v1/wechat/bind/start");
		assert.equal(r3.status, 409);
		assert.equal(r3.body.error, "already-bound");
		// 9) unbind → idle + removed + 文件删
		const ub = await post("/v1/wechat/unbind");
		assert.equal(ub.status, 200);
		assert.equal(ub.body.state, "idle");
		assert.equal(ub.body.removed, true);
		assert.equal(existsSync(credsPath), false, "凭据文件已删（不留空壳）");
		// 10) qr-image → 409 no-active-session
		const ri2 = await get("/v1/wechat/bind/qr-image");
		assert.equal(ri2.status, 409);
		assert.equal(ri2.body.error, "no-active-session");
		// 11) start（恒 pending）+ cancel → idle
		stub.setMode("pending");
		const r4 = await post("/v1/wechat/bind/start");
		assert.equal(r4.status, 200, `再 start 200（${r4.text}）`);
		assert.equal(r4.body.state, "waiting");
		const ca = await post("/v1/wechat/bind/cancel");
		assert.equal(ca.status, 200);
		assert.equal(ca.body.state, "idle", "cancel 回 idle");
	} finally {
		if (h !== null) await h.close();
		await stub.close();
		rmSync(D, { recursive: true, force: true });
	}
}

// ── main ────────────────────────────────────────────────────────────

const t0 = Date.now();
try {
	console.log("wechat-bind 离线单测（fake fetch + 真 HTTP stub）：");
	await test("T1 取码：字段别名 / data 直包 / expires_in 缺省 / ret≠0 / HTTP 500 / 字段缺失 / 10s 超时", t1);
	await test("T2 状态映射：数字 0/1/2/3/4/其他 + 字符串别名 + 未知→pending + token/botId 别名", t2);
	await test("T3 payload unwrap：data 直包 / 顶层 / 非对象", t3);
	await test("T4 全流程：waiting→scanned→bound（凭据 0600 + 无 token + 幂等 start + unbind 回 idle）", t4);
	await test("T5 有界上限：pending 恒 + maxBindMs=300 → expired（及时释放）", t5);
	await test("T6 confirmed 无 bot_token → error（可重新生成）", t6);
	await test("T7 磁盘凭据 → already-bound；cancel → idle（cancel 不删凭据）", t7);
	await test("T8 在途 unbind → idle + 流程 abort（迟到 confirmed 不落盘）", t8);
	await test("T9 readWechatEnabled：缺段/坏 JSON/非布尔 → false；true → true（默认 OFF）", t9);
	await test("T10 opt-in OFF：5 端点 无/错 token → 401；对 token → 403 wechat-disabled", t10);
	await test("T11 opt-in ON：idle→start（幂等）→qr-image→bound（无 token）→409→unbind→409→start+cancel", t11);
} catch (e) {
	console.error(`主流程异常: ${e instanceof Error ? e.stack : String(e)}`);
	process.exitCode = 1;
}

if (failures.length > 0) {
	console.error(`\n${failures.length} 项失败: ${failures.join(" | ")}`);
	process.exitCode = 1;
} else {
	console.log(`\n全部通过（${passed} 组断言块，${Date.now() - t0}ms）`);
}
