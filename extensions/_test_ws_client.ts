/**
 * _test_ws_client.ts — 手写最小 WS 测试客户端（零依赖；G6-P1 起供 host WS 类测试共用）：
 * _test_runtime_host_ws.ts / _test_runtime_interactions.ts。
 *
 * 仅测试用：RFC6455 客户端帧（必带 mask）+ 握手 + 服务端帧解析（文本/控制帧分拣）。
 */

import assert from "node:assert/strict";
import { connect as netConnect, type Socket } from "node:net";
import { randomBytes } from "node:crypto";

export interface ServerFrame {
	opcode: number;
	payload: Buffer;
}

const OP_PING = 0x9;
const OP_PONG = 0xa;

export class TestWs {
	socket: Socket;
	private buf: Buffer = Buffer.alloc(0);
	private queue: ServerFrame[] = [];
	private waiters: ((f: ServerFrame | null) => void)[] = [];
	responseHead: string | null = null;
	headers: Map<string, string> = new Map();
	closed = false;

	private constructor(socket: Socket) {
		this.socket = socket;
		socket.on("data", (chunk: Buffer) => this.onData(chunk));
		socket.on("close", () => {
			this.closed = true;
			this.notify();
		});
		socket.on("error", () => {
			/* 测试客户端忽略（close 跟进） */
		});
	}

	private onData(chunk: Buffer): void {
		if (this.responseHead === null) {
			const idx = chunk.indexOf("\r\n\r\n");
			if (idx < 0) {
				this.headPartial = (this.headPartial ?? Buffer.alloc(0)).length > 0 ? Buffer.concat([this.headPartial!, chunk]) : chunk;
				return;
			}
			const headPart = this.headPartial && this.headPartial.length > 0 ? Buffer.concat([this.headPartial, chunk.subarray(0, idx)]) : chunk.subarray(0, idx);
			this.headPartial = Buffer.alloc(0);
			this.responseHead = headPart.toString("utf8");
			for (const line of this.responseHead.split("\r\n").slice(1)) {
				const c = line.indexOf(":");
				if (c > 0) this.headers.set(line.slice(0, c).trim().toLowerCase(), line.slice(c + 1).trim());
			}
			this.onData(chunk.subarray(idx + 4));
			return;
		}
		this.buf = Buffer.concat([this.buf, chunk]);
		for (;;) {
			if (this.buf.length < 2) break;
			const opcode = this.buf[0] & 0x0f;
			const masked = (this.buf[1] & 0x80) !== 0;
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
			if (masked) offset += 4; // 服务端帧不应带掩码；测试客户端不实现
			if (this.buf.length < offset + len) break;
			const frame: ServerFrame = { opcode, payload: Buffer.from(this.buf.subarray(offset, offset + len)) };
			// RFC6455 自动回 pong：长跨度的 recv 间隔（重放排干/HTTP GET 等）不再被服务端
			// 两拍无 pong 判死；ping 帧仍入队，测试可观察/显式 sendPong 仍无害。
			if (opcode === OP_PING && !this.closed) {
				try {
					this.socket.write(clientFrame(OP_PONG, frame.payload));
				} catch {
					/* ignore */
				}
			}
			this.queue.push(frame);
			this.buf = this.buf.subarray(offset + len);
		}
		this.notify();
	}

	private headPartial: Buffer | null = null;

	/** 仅唤醒所有 recv（帧不直接递给 waiter——由 recv 自行重查 queue，防丢帧/乱序）。 */
	private notify(): void {
		const waiters = this.waiters;
		this.waiters = [];
		for (const w of waiters) w();
	}

	/** 等下一帧（opcode 过滤可选；非匹配帧保留在队首，序不乱）；超时/连接关闭 → null。 */
	async recv(timeoutMs = 3000, opcode?: number): Promise<ServerFrame | null> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const idx = opcode === undefined ? 0 : this.queue.findIndex((f) => f.opcode === opcode);
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
					if (i >= 0) {
						this.waiters.splice(i, 1);
						r();
					}
				}, remaining);
			});
		}
	}

	/** 等下一条 JSON 文本帧；跳过 ping。 */
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

	sendText(text: string): void {
		this.socket.write(clientFrame(0x1, Buffer.from(text, "utf8")));
	}

	sendPong(payload: Buffer): void {
		this.socket.write(clientFrame(0xa, payload));
	}

	destroy(): void {
		try {
			this.socket.destroy();
		} catch {
			/* ignore */
		}
	}
}

function clientFrame(opcode: number, payload: Buffer): Buffer {
	const mask = randomBytes(4);
	const masked = Buffer.from(payload);
	for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
	let header: Buffer;
	if (payload.length < 126) {
		header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
	} else if (payload.length < 65536) {
		header = Buffer.alloc(4);
		header[0] = 0x80 | opcode;
		header[1] = 0x80 | 126;
		header.writeUInt16BE(payload.length, 2);
	} else {
		header = Buffer.alloc(10);
		header[0] = 0x80 | opcode;
		header[1] = 0x80 | 127;
		header.writeBigUInt64BE(BigInt(payload.length), 2);
	}
	return Buffer.concat([header, mask, masked]);
}

export interface HandshakeResult {
	ok: boolean;
	statusLine: string;
	ws: TestWs | null;
}

/** 发起 WS 握手：101 → ok+TestWs；其它状态码 → ok:false（响应头可断言）。 */
export function wsHandshake(port: number, path: string, extraHeaders: string[] = [], timeoutMs = 3000): Promise<HandshakeResult> {
	return new Promise((resolve) => {
		const socket = netConnect(port, "127.0.0.1");
		let settled = false;
		const finish = (r: HandshakeResult): void => {
			if (settled) return;
			settled = true;
			resolve(r);
		};
		const ws = new TestWs(socket);
		const onResponse = (): void => {
			const statusLine = (ws.responseHead ?? "").split("\r\n")[0] ?? "";
			if (statusLine.includes(" 101")) {
				finish({ ok: true, statusLine, ws });
			} else {
				socket.destroy();
				finish({ ok: false, statusLine, ws: null });
			}
		};
		// 复用 TestWs 的头部收集：轮询 responseHead
		const poll = setInterval(() => {
			if (ws.responseHead !== null) {
				clearInterval(poll);
				onResponse();
			}
		}, 5);
		socket.on("close", () => {
			clearInterval(poll);
			if (!settled) finish({ ok: false, statusLine: ws.responseHead ?? "", ws: null });
		});
		socket.on("connect", () => {
			const key = randomBytes(16).toString("base64");
			const req = [
				`GET ${path} HTTP/1.1`,
				"Host: 127.0.0.1",
				"Upgrade: websocket",
				"Connection: Upgrade",
				`Sec-WebSocket-Key: ${key}`,
				"Sec-WebSocket-Version: 13",
				...extraHeaders,
				"",
				"",
			].join("\r\n");
			socket.write(req);
		});
		setTimeout(() => {
			clearInterval(poll);
			if (!settled) {
				socket.destroy();
				finish({ ok: false, statusLine: ws.responseHead ?? "", ws: null });
			}
		}, timeoutMs);
	});
}

/** 断言帧是 ack（订阅确认）。 */
export function isAck(f: unknown): f is { type: "ack"; topic: string; mode: string; head: { logEpoch: string; seq: number; gen?: number } | null } {
	return typeof f === "object" && f !== null && (f as { type?: unknown }).type === "ack";
}

/** 帧静默（排干重放后再等 quietMs，应无新帧）。 */
export async function expectQuiet(ws: TestWs, quietMs = 300): Promise<void> {
	const extra = await ws.recvJson(quietMs);
	assert.equal(extra, null, "应无多余帧（静默窗）");
}

/** 排干队列中现成帧（非阻塞快照；用于订阅后丢弃重放段的场景少用——优先精确 recv）。 */
export async function drainAvailable(ws: TestWs, max = 100, gapMs = 150): Promise<unknown[]> {
	const out: unknown[] = [];
	for (let i = 0; i < max; i += 1) {
		const f = await ws.recvJson(gapMs);
		if (f === null) break;
		out.push(f);
	}
	return out;
}
