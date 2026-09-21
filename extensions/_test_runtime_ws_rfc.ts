/**
 * _test_runtime_ws_rfc.ts — G6-P1 L4 必修②测试：审查 RFC/背压修补的回归防回退
 * （plans/0921_g6p1_review.md §必修结论 2；修补本体 ws.ts 已在审查中直接落盘）。
 *
 * 覆盖（逐分支）：
 *   R1 未掩码客户端帧 → close 1002（RFC6455 §5.1）
 *   R2 fragmented control frame（FIN=0 ping）→ close 1002
 *   R3 未知 opcode（0x3）→ close 1002
 *   R4 二进制帧 → close 1003
 *   R5 RSV 位 → close 1002
 *   R6 control frame 载荷 >125B → close 1002
 *   R7 握手校验：坏 Sec-WebSocket-Key（非 16B）/ version 非 13 / Upgrade 非 websocket /
 *      Connection 无 upgrade token → 全部 400（101 前拒）
 *   R8 upgrade head 与首个 subscribe 同 TCP 段（head 投喂顺序）→ ack 不丢
 *   R9 慢消费者：socket.write()===false → 立即 close 1013 停止入队（不再无界缓冲）；
 *      连接终止、host 存活
 *   R10 sanity：正常掩码文本帧工作（防矫枉过正）
 *
 * 运行：npm run test:runtime-ws-rfc
 */

import assert from "node:assert/strict";
import { connect as netConnect, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "ws-rfc-env-"));
process.env.PI_SESSIONS_DIR = mkdtempSync(join(tmpdir(), "ws-rfc-sessions-"));

import { createRuntimeHostServer, type RuntimeHostHandle } from "./runtime-host/server.ts";
import { newEventEnvelope } from "./runtime/envelope.ts";
import { masterAddress } from "./runtime/address.ts";

const ENV_DIR = process.env.PI_RUNTIME_DIR!;
const SESSIONS_DIR = process.env.PI_SESSIONS_DIR!;
const DIRS: string[] = [ENV_DIR, SESSIONS_DIR];

// ── 帧构造（客户端侧；可关掩码/可关 FIN）────────────────────────

function frame(opcode: number, payload: Buffer, opts?: { masked?: boolean; fin?: boolean; rsv1?: boolean }): Buffer {
	const masked = opts?.masked ?? true; // 正常客户端帧必须掩码
	const fin = opts?.fin ?? true;
	const b0 = (fin ? 0x80 : 0) | (opts?.rsv1 ? 0x40 : 0) | opcode;
	let header: Buffer;
	if (payload.length < 126) {
		header = Buffer.from([b0, (masked ? 0x80 : 0) | payload.length]);
	} else if (payload.length < 65536) {
		header = Buffer.alloc(4);
		header[0] = b0;
		header[1] = (masked ? 0x80 : 0) | 126;
		header.writeUInt16BE(payload.length, 2);
	} else {
		header = Buffer.alloc(10);
		header[0] = b0;
		header[1] = (masked ? 0x80 : 0) | 127;
		header.writeBigUInt64BE(BigInt(payload.length), 2);
	}
	if (!masked) return Buffer.concat([header, payload]);
	const mask = randomBytes(4);
	const maskedPayload = Buffer.from(payload);
	for (let i = 0; i < maskedPayload.length; i += 1) maskedPayload[i] ^= mask[i % 4];
	return Buffer.concat([header, mask, maskedPayload]);
}

// ── 原始 socket 测试客户端（可发任意字节；解析服务端帧）──────────

interface SFrame { opcode: number; payload: Buffer }

class RawWs {
	socket: Socket;
	private buf: Buffer = Buffer.alloc(0);
	private queue: SFrame[] = [];
	private waiters: (() => void)[] = [];
	responseHead: string | null = null;
	closed = false;
	socketClosed = false;

	constructor(socket: Socket) {
		this.socket = socket;
		socket.on("data", (c: Buffer) => this.onData(c));
		socket.on("close", () => {
			this.socketClosed = true;
			this.closed = true;
			this.notify();
		});
		socket.on("error", () => {
			/* 客户端忽略（close 跟进） */
		});
	}

	private onData(chunk: Buffer): void {
		if (this.responseHead === null) {
			const idx = chunk.indexOf("\r\n\r\n");
			if (idx < 0) return;
			this.responseHead = chunk.subarray(0, idx).toString("utf8");
			this.onData(chunk.subarray(idx + 4));
			return;
		}
		this.buf = Buffer.concat([this.buf, chunk]);
		for (;;) {
			if (this.buf.length < 2) break;
			const opcode = this.buf[0] & 0x0f;
			let len = this.buf[1] & 0x7f;
			let offset = 2;
			if (len === 126) {
				if (this.buf.length < 4) break;
				len = this.buf.readUInt16BE(2);
				offset = 4;
			} else if (len === 127) {
				if (this.buf.length < 10) break;
				len = Number(this.buf.readBigUInt64BE(2));
				offset = 10;
			}
			if (this.buf[1] & 0x80) offset += 4; // 服务端帧不带掩码
			if (this.buf.length < offset + len) break;
			this.queue.push({ opcode, payload: Buffer.from(this.buf.subarray(offset, offset + len)) });
			this.buf = this.buf.subarray(offset + len);
		}
		this.notify();
	}

	private notify(): void {
		const w = this.waiters;
		this.waiters = [];
		for (const f of w) f();
	}

	async recv(timeoutMs = 3000, opcode?: number): Promise<SFrame | null> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const idx = this.queue.length > 0 ? (opcode === undefined ? 0 : this.queue.findIndex((f) => f.opcode === opcode)) : -1;
			if (idx >= 0) {
				const [f] = this.queue.splice(idx, 1);
				return f;
			}
			if (this.closed) return null;
			const remaining = deadline - Date.now();
			if (remaining <= 0) return null;
			await new Promise<void>((r) => {
				this.waiters.push(r);
				setTimeout(() => {
					const i = this.waiters.indexOf(r);
					if (i >= 0) this.waiters.splice(i, 1);
					r();
				}, remaining);
			});
		}
	}

	async recvJson(timeoutMs = 3000): Promise<unknown | null> {
		for (;;) {
			const f = await this.recv(timeoutMs, 0x1);
			if (f === null) return null;
			try {
				return JSON.parse(f.payload.toString("utf8"));
			} catch {
				continue;
			}
		}
	}

	sendRaw(buf: Buffer): void {
		this.socket.write(buf);
	}

	sendText(text: string): void {
		this.sendRaw(frame(0x1, Buffer.from(text, "utf8")));
	}

	/** 等 socket 层关闭（close 帧或 FIN/RST 均算）。 */
	async waitSocketClosed(timeoutMs = 3000): Promise<boolean> {
		const t0 = Date.now();
		while (!this.socketClosed && Date.now() - t0 < timeoutMs) {
			await new Promise((r) => setTimeout(r, 20));
		}
		return this.socketClosed;
	}

	/** 收到的 close code（未收到 close 帧 → null）。 */
	async closeCode(timeoutMs = 3000): Promise<number | null> {
		const f = await this.recv(timeoutMs, 0x8);
		if (f === null) return null;
		return f.payload.length >= 2 ? f.payload.readUInt16BE(0) : null;
	}

	destroy(): void {
		try {
			this.socket.destroy();
		} catch {
			/* ignore */
		}
	}
}

interface ConnectResult { ws: RawWs | null; statusLine: string }

/** 握手（可注入任意请求头数组）；101 → RawWs，否则 statusLine 可断言。 */
function handshake(port: number, path: string, reqHeaders?: string[], timeoutMs = 3000): Promise<ConnectResult> {
	const headers = reqHeaders ?? [
		`GET ${path} HTTP/1.1`,
		"Host: 127.0.0.1",
		"Upgrade: websocket",
		"Connection: Upgrade",
		`Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
		"Sec-WebSocket-Version: 13",
	];
	return new Promise((resolve) => {
		const socket = netConnect(port, "127.0.0.1");
		const ws = new RawWs(socket);
		let settled = false;
		const finish = (v: ConnectResult): void => {
			if (!settled) {
				settled = true;
				resolve(v);
			}
		};
		const poll = setInterval(() => {
			if (ws.responseHead !== null) {
				clearInterval(poll);
				const statusLine = ws.responseHead.split("\r\n")[0] ?? "";
				finish({ ws: statusLine.includes(" 101") ? ws : null, statusLine });
			}
		}, 5);
		socket.on("close", () => {
			clearInterval(poll);
			finish({ ws: null, statusLine: ws.responseHead ?? "" });
		});
		socket.on("connect", () => {
			socket.write(headers.join("\r\n") + "\r\n\r\n");
		});
		setTimeout(() => {
			clearInterval(poll);
			socket.destroy();
			finish({ ws: null, statusLine: ws.responseHead ?? "" });
		}, timeoutMs);
	});
}

let handle: RuntimeHostHandle | null = null;

try {
	const journalPath = join(ENV_DIR, "events.jsonl");
	handle = await createRuntimeHostServer({ journalPath, sessionsDir: SESSIONS_DIR, tailMs: 30, pingMs: 30_000 });
	const token = handle.info.token!;
	const wsPath = `/v1/events/stream?token=${encodeURIComponent(token)}`;

	// ── R7 握手校验（101 前拒；对 token 已带在 path）────────────────
	{
		const badKey = await handshake(handle.info.port, wsPath, [
			`GET ${wsPath} HTTP/1.1`,
			"Host: 127.0.0.1",
			"Upgrade: websocket",
			"Connection: Upgrade",
			"Sec-WebSocket-Key: c2hvcnQ=", // base64 解码 ≠16B
			"Sec-WebSocket-Version: 13",
		]);
		assert.equal(badKey.ws, null);
		assert.ok(badKey.statusLine.includes(" 400"), `R7: 坏 key → 400（${badKey.statusLine}）`);

		const badVersion = await handshake(handle.info.port, wsPath, [
			`GET ${wsPath} HTTP/1.1`,
			"Host: 127.0.0.1",
			"Upgrade: websocket",
			"Connection: Upgrade",
			`Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
			"Sec-WebSocket-Version: 12",
		]);
		assert.ok(badVersion.statusLine.includes(" 400"), "R7: version≠13 → 400");

		const noUpgrade = await handshake(handle.info.port, wsPath, [
			`GET ${wsPath} HTTP/1.1`,
			"Host: 127.0.0.1",
			"Upgrade: h2c",
			"Connection: Upgrade",
			`Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
			"Sec-WebSocket-Version: 13",
		]);
		assert.ok(noUpgrade.statusLine.includes(" 400"), "R7: Upgrade 非 websocket → 400");

		const noConnUpgrade = await handshake(handle.info.port, wsPath, [
			`GET ${wsPath} HTTP/1.1`,
			"Host: 127.0.0.1",
			"Upgrade: websocket",
			"Connection: keep-alive",
			`Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
			"Sec-WebSocket-Version: 13",
		]);
		// Connection 无 upgrade → Node 不发 upgrade 事件，走 HTTP 路由 404；无论 400/404 均 101 前拒绝
		assert.ok(!noConnUpgrade.statusLine.includes(" 101"), "R7: Connection 无 upgrade → 绝不 101");
		assert.ok(/HTTP\/1\.1 4\d\d/.test(noConnUpgrade.statusLine), `R7: Connection 无 upgrade → 4xx（${noConnUpgrade.statusLine}）`);
	}

	// ── R8 upgrade head 与首个 subscribe 同段 → ack 不丢 ────────────
	{
		const result = await new Promise<RawWs | null>((resolve) => {
			const socket = netConnect(handle!.info.port, "127.0.0.1");
			const ws = new RawWs(socket);
			let settled = false;
			const finish = (v: RawWs | null): void => {
				if (!settled) {
					settled = true;
					resolve(v);
				}
			};
			const poll = setInterval(() => {
				if (ws.responseHead !== null) {
					clearInterval(poll);
					finish((ws.responseHead.split("\r\n")[0] ?? "").includes(" 101") ? ws : null);
				}
			}, 5);
			socket.on("close", () => {
				clearInterval(poll);
				finish(null);
			});
			socket.on("connect", () => {
				// 一次 write：请求 + 首个 subscribe 帧（upgrade head 同包；分帧必须精确 —— 多余
				// CRLF 会残留在 head 里并被严格解析器按协议拒掉）
				const req = [
					`GET ${wsPath} HTTP/1.1`,
					"Host: 127.0.0.1",
					"Upgrade: websocket",
					"Connection: Upgrade",
					`Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
					"Sec-WebSocket-Version: 13",
				].join("\r\n") + "\r\n\r\n";
				const sub = frame(0x1, Buffer.from(JSON.stringify({ type: "subscribe", topic: "journal", base: {} }), "utf8"));
				socket.write(Buffer.concat([Buffer.from(req), sub]));
			});
			setTimeout(() => {
				clearInterval(poll);
				socket.destroy();
				finish(null);
			}, 3000);
		});
		assert.ok(result, "R8: 同段握手 + subscribe → 101");
		const ack = await result.recvJson();
		assert.ok(typeof ack === "object" && ack !== null && (ack as any).type === "ack", "R8: upgrade head 携带的首 subscribe 被处理（ack 不丢）");
		result.destroy();
	}

	// ── R1-R6 帧卫生分支（逐分支 close code）────────────────────────
	async function expectClose(name: string, payload: Buffer, code: number): Promise<void> {
		const h = await handshake(handle!.info.port, wsPath);
		assert.ok(h.ws, `${name}: 握手 101`);
		h.ws!.sendRaw(payload);
		const got = await h.ws!.closeCode(3000);
		assert.equal(got, code, `${name}: close ${code}（实际 ${got}）`);
		assert.ok(await h.ws!.waitSocketClosed(3000), `${name}: 连接终止`);
		h.ws!.destroy();
	}

	await expectClose("R1 未掩码文本帧", frame(0x1, Buffer.from(`{"type":"subscribe","topic":"journal"}`), { masked: false }), 1002);
	await expectClose("R2 fragmented control（FIN=0 ping）", frame(0x9, Buffer.alloc(0), { fin: false }), 1002);
	await expectClose("R3 未知 opcode 0x3", frame(0x3, Buffer.from("x")), 1002);
	await expectClose("R4 二进制帧", frame(0x2, Buffer.from([1, 2, 3])), 1003);
	await expectClose("R5 RSV 位", frame(0x1, Buffer.from("hi"), { rsv1: true }), 1002);
	await expectClose("R6 control >125B", frame(0x9, Buffer.alloc(126)), 1002);

	// ── R10 sanity：正常掩码文本仍工作 ───────────────────────────────
	{
		const h = await handshake(handle.info.port, wsPath);
		assert.ok(h.ws);
		h.ws!.sendText(JSON.stringify({ type: "subscribe", topic: "journal", base: {} }));
		const ack = await h.ws!.recvJson();
		assert.ok(typeof ack === "object" && ack !== null && (ack as any).type === "ack", "R10: 正常掩码文本 → ack");
		h.ws!.destroy();
	}

	// ── R9 慢消费者：write()===false → 1013 停止入队（不再无界缓冲）──
	{
		// 独立 journal：2000 × ~8KB envelope ≈ 16MB，订阅全量重放必然击穿写缓冲
		const bigJournal = join(ENV_DIR, "events-big.jsonl");
		const big = "x".repeat(8000);
		const lines: string[] = [];
		for (let i = 1; i <= 2000; i += 1) {
			const e = newEventEnvelope({ type: "test.bulk", source: masterAddress(), payload: { i, big }, at: "2026-09-22T00:00:00.000Z" });
			lines.push(`${JSON.stringify(e)}\n`);
		}
		writeFileSync(bigJournal, lines.join(""), "utf8");

		// 第二台 host（独立 journal，不污染其它用例）
		const h2 = await createRuntimeHostServer({ journalPath: bigJournal, sessionsDir: SESSIONS_DIR, tailMs: 30, pingMs: 30_000 });
		try {
			const wsPath2 = `/v1/events/stream?token=${encodeURIComponent(h2.info.token!)}`;
			const conn = await new Promise<RawWs>((resolve) => {
				const socket = netConnect(h2.info.port, "127.0.0.1");
				const ws = new RawWs(socket);
				let settled = false;
				const finish = (v: RawWs): void => {
					if (!settled) {
						settled = true;
						resolve(v);
					}
				};
				const poll = setInterval(() => {
					if (ws.responseHead !== null) {
						clearInterval(poll);
						finish(ws);
					}
				}, 5);
				socket.on("connect", () => {
					const req = [
						`GET ${wsPath2} HTTP/1.1`,
						"Host: 127.0.0.1",
						"Upgrade: websocket",
						"Connection: Upgrade",
						`Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
						"Sec-WebSocket-Version: 13",
					].join("\r\n") + "\r\n\r\n";
					const sub = frame(0x1, Buffer.from(JSON.stringify({ type: "subscribe", topic: "journal", base: {} }), "utf8"));
					// 先关读（慢消费者），再同包发握手 + subscribe：服务端 replay 必然撞写缓冲
					socket.pause();
					socket.write(Buffer.concat([Buffer.from(req), sub]));
					setTimeout(() => {
						clearInterval(poll);
						resolve(ws);
					}, 800);
				});
			});

			// 服务端应已 close(1013)+dispose+destroy：恢复读取后收到的 event 数必远小于 2000
			// （旧实现：无限入队 → 恢复后 2000 帧全部送达且连接保持）
			conn.socket.resume();
			let events = 0;
			for (;;) {
				const f = await conn.recv(500);
				if (f === null) break;
				if (f.opcode === 0x1) events += 1;
				if (f.opcode === 0x8) {
					const code = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : null;
					if (code !== null) assert.equal(code, 1013, "R9: close code = 1013（若 close 帧在销毁前排空）");
				}
			}
			assert.ok(events < 1000, `R9: 停止入队（送达 ${events} << 2000）`);
			assert.ok(await conn.waitSocketClosed(1000), "R9: 连接已终止");
			conn.destroy();

			// host 存活（单连接故障不炸 host）
			const health = await fetch(`http://127.0.0.1:${h2.info.port}/v1/health`);
			assert.equal(health.status, 200, "R9: backpressure 关闭后 host 仍存活");
		} finally {
			await h2.close().catch(() => undefined);
		}
	}

	console.log("_test_runtime_ws_rfc: all assertions passed");
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
