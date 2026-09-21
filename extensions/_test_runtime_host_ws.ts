/**
 * _test_runtime_host_ws.ts — G6-P1 测试（runtime-host WS /v1/events/stream + 认证 + sessions/transcript 端点）
 *
 * 覆盖：
 *   T1 认证 fail-closed：无 token → 401（101 前）；错 token → 401；对 token（?token=）→ 101 +
 *      Set-Cookie（HttpOnly/SameSite=Strict）；仅 cookie → 101；host.json 无 token 字段（旧文件）
 *      → 401
 *   T2 HTTP 端点零变化：无 token /v1/health 照常 200；未知 upgrade 路径 → 404
 *   T3 journal 流：subscribe(seq=0) → ack resume + 全量重放（seq=物理行号）；live 追加即时推；
 *      断线重连带 base → 补发不重不漏；base.seq 越界 → snapshot；跨代（journal 重建）→ snapshot；
 *      坏行消耗行号（seq 有洞不影响续传）
 *   T4 transcript 流：subscribe(seq=0) → ack snapshot（首屏走 GET）；head 重订阅 → resume 空补发；
 *      追加 JSONL → appended + upserted（toolResult 回填）帧；断线重连 base=旧头 → 精确补发；
 *      应用补帧终态 == GET 全量行；P1 发射面（无 removed/delta）；缺失会话 → head:null
 *   T5 GET /v1/sessions + /v1/sessions/:id/transcript?after=：列表含夹具；after 分页三态
 *      （全量 / 空 / 增量触及行终态）；缺失会话 404
 *   T6 双 WS 并发 fan-out：两连接同 topic 均收到 live 帧
 *   T7 帧卫生：坏 JSON / 未知 topic / 非 subscribe → error 帧且连接不断；服务端 ping 到达
 *
 * 运行：npm run test:runtime-host-ws
 */

import assert from "node:assert/strict";
import { connect as netConnect, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "host-ws-env-"));
process.env.PI_SESSIONS_DIR = mkdtempSync(join(tmpdir(), "host-ws-sessions-"));

import { createRuntimeHostServer, type RuntimeHostHandle } from "./runtime-host/server.ts";
import { newEventEnvelope } from "./runtime/envelope.ts";
import { masterAddress } from "./runtime/address.ts";
import { appendRuntimeEnvelope } from "./runtime/journal.ts";
import { applyTranscriptOps, type TranscriptOp, type TranscriptRow } from "./runtime/transcript.ts";

const ENV_DIR = process.env.PI_RUNTIME_DIR!;
const DIRS: string[] = [ENV_DIR, process.env.PI_SESSIONS_DIR!];

// ── 手写最小 WS 测试客户端（零依赖；仅本测试用）────────────────────

interface ServerFrame {
	opcode: number;
	payload: Buffer;
}

class TestWs {
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
			this.queue.push({ opcode, payload: Buffer.from(this.buf.subarray(offset, offset + len)) });
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

interface HandshakeResult {
	ok: boolean;
	statusLine: string;
	ws: TestWs | null;
}

/** 发起 WS 握手：101 → ok+TestWs；其它状态码 → ok:false（响应头可断言）。 */
function wsHandshake(port: number, path: string, extraHeaders: string[] = [], timeoutMs = 3000): Promise<HandshakeResult> {
	return new Promise((resolve) => {
		const socket = netConnect(port, "127.0.0.1");
		let settled = false;
		let head = Buffer.alloc(0);
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

// ── 夹具 ─────────────────────────────────────────────────────────

let envN = 0;
function makeEnvelope(): ReturnType<typeof newEventEnvelope> {
	envN += 1;
	return newEventEnvelope({ type: "test.tick", source: masterAddress(), payload: { n: envN }, at: new Date(Date.parse("2026-09-22T00:00:00Z") + envN * 1000).toISOString() });
}

function sessionLine(o: unknown): string {
	return `${JSON.stringify(o)}\n`;
}

function mkSessionHeader(id: string, ts: string): string {
	return sessionLine({ type: "session", version: 3, id, timestamp: ts, cwd: "C:\\ws-test" });
}

function mkUser(id: string, ts: string, text: string): string {
	return sessionLine({ type: "message", id, parentId: null, timestamp: ts, message: { role: "user", content: [{ type: "text", text }] } });
}

function mkAssistantToolCall(id: string, ts: string, callId: string): string {
	return sessionLine({
		type: "message", id, parentId: null, timestamp: ts,
		message: { role: "assistant", content: [{ type: "toolCall", id: callId, name: "read", arguments: { path: "a" } }] },
	});
}

function mkToolResult(id: string, ts: string, callId: string, out: string): string {
	return sessionLine({
		type: "message", id, parentId: null, timestamp: ts,
		message: { role: "toolResult", toolCallId: callId, toolName: "read", content: [{ type: "text", text: out }] },
	});
}

async function getJson(base: string, path: string): Promise<{ status: number; body: any }> {
	const res = await fetch(`${base}${path}`);
	const text = await res.text();
	let body: unknown = null;
	try {
		body = text.length > 0 ? JSON.parse(text) : null;
	} catch {
		body = { __raw: text };
	}
	return { status: res.status, body };
}

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<boolean> {
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		if (pred()) return true;
		await new Promise((r) => setTimeout(r, 20));
	}
	return pred();
}

function isAck(f: unknown): f is { type: "ack"; topic: string; mode: string; head: { logEpoch: string; seq: number } | null } {
	return typeof f === "object" && f !== null && (f as any).type === "ack";
}

function isEvent(f: unknown): f is { type: "event"; topic: string; seq: number; envelope?: any; op?: TranscriptOp } {
	return typeof f === "object" && f !== null && (f as any).type === "event";
}

// ── 主流程 ───────────────────────────────────────────────────────

let handle: RuntimeHostHandle | null = null;

try {
	const journalPath = join(ENV_DIR, "events.jsonl");
	const sessionsDir = process.env.PI_SESSIONS_DIR!;

	handle = await createRuntimeHostServer({ journalPath, sessionsDir, tailMs: 30, pingMs: 200 });
	const token = handle.info.token;
	assert.ok(typeof token === "string" && token.length > 0, "host 启动即生成 token 落 info");
	const base = `http://127.0.0.1:${handle.info.port}`;
	const wsPath = (t?: string) => `/v1/events/stream${t ? `?token=${encodeURIComponent(t)}` : ""}`;

	// ── T1 认证 fail-closed ──────────────────────────────────────────
	{
		const noToken = await wsHandshake(handle.info.port, "/v1/events/stream");
		assert.equal(noToken.ok, false, "无 token → 拒绝");
		assert.ok(noToken.statusLine.includes(" 401"), `状态行含 401：${noToken.statusLine}`);

		const badToken = await wsHandshake(handle.info.port, wsPath("wrong-token"));
		assert.equal(badToken.ok, false);
		assert.ok(badToken.statusLine.includes(" 401"), "错 token → 401");

		const good = await wsHandshake(handle.info.port, wsPath(token!));
		assert.equal(good.ok, true, `对 token → 101（${good.statusLine}）`);
		const setCookie = good.ws!.headers.get("set-cookie") ?? "";
		assert.ok(setCookie.includes("sw_host_token="), `Set-Cookie 种 token：${setCookie}`);
		assert.ok(setCookie.includes("HttpOnly"), "HttpOnly");
		assert.ok(setCookie.includes("SameSite=Strict"), "SameSite=Strict");
		good.ws!.destroy();

		const cookieOnly = await wsHandshake(handle.info.port, "/v1/events/stream", [`Cookie: sw_host_token=${token}`]);
		assert.equal(cookieOnly.ok, true, "仅 cookie → 101");
		cookieOnly.ws!.destroy();
	}

	// ── T2 HTTP 端点零变化 ───────────────────────────────────────────
	{
		const h = await getJson(base, "/v1/health");
		assert.equal(h.status, 200, "无 token /v1/health 照常 200（P1 仅 WS 面认证）");
		assert.equal((h.body.host as any).token, undefined, "token 绝不进 HTTP 响应");
		const badUpgrade = await wsHandshake(handle.info.port, "/v1/other-upgrade", [], 1500);
		assert.equal(badUpgrade.ok, false);
		assert.ok(badUpgrade.statusLine.includes(" 404"), "未知 upgrade 路径 → 404");
	}

	// ── T3 journal 流 + 续传 ─────────────────────────────────────────
	{
		// 种 3 条（物理行 1-3）
		const e1 = makeEnvelope();
		const e2 = makeEnvelope();
		const e3 = makeEnvelope();
		appendRuntimeEnvelope(e1, journalPath);
		appendRuntimeEnvelope(e2, journalPath);
		appendRuntimeEnvelope(e3, journalPath);

		const c1 = await wsHandshake(handle.info.port, wsPath(token!));
		assert.ok(c1.ok);
		c1.ws!.sendText(JSON.stringify({ type: "subscribe", topic: "journal", base: {} }));
		const ack1 = await c1.ws!.recvJson();
		assert.equal((ack1 as any).head.seq, 3);
		assert.equal((ack1 as any).head.logEpoch, e1.id, "logEpoch = 首 envelope id");
		const frames1: { seq: number; id: string }[] = [];
		for (let i = 0; i < 3; i += 1) {
			const f = await c1.ws!.recvJson();
			assert.ok(isEvent(f) && f.envelope !== undefined);
			frames1.push({ seq: f.seq, id: f.envelope.id });
		}
		assert.deepEqual(frames1.map((x) => x.seq), [1, 2, 3], "全量重放 seq=物理行号");
		assert.deepEqual(frames1.map((x) => x.id), [e1.id, e2.id, e3.id]);

		// live：追加（含坏行消耗行号 4）→ seq 5 推送
		appendRuntimeEnvelope(makeEnvelope(), journalPath);
		appendFileSync(journalPath, "not-json\n", "utf8");
		const e5 = makeEnvelope();
		appendRuntimeEnvelope(e5, journalPath);
		const live1 = await c1.ws!.recvJson();
		assert.ok(isEvent(live1));
		assert.equal((live1 as any).seq, 4, "live 推送（物理行 4）");
		const live2 = await c1.ws!.recvJson();
		assert.ok(isEvent(live2) && (live2 as any).seq === 6, "坏行（行5）消耗行号，envelope 落 seq 6");
		assert.equal((live2 as any).envelope.id, e5.id);
		c1.ws!.destroy();

		// 断线重连：base={seq:3, logEpoch} → 精确补发 4,5（不重不漏）
		const c2 = await wsHandshake(handle.info.port, wsPath(token!));
		assert.ok(c2.ok);
		c2.ws!.sendText(JSON.stringify({ type: "subscribe", topic: "journal", base: { seq: 3, logEpoch: e1.id } }));
		const ack2 = await c2.ws!.recvJson();
		assert.ok(isAck(ack2) && ack2.mode === "resume");
		const r4 = await c2.ws!.recvJson();
		const r5 = await c2.ws!.recvJson();
		assert.ok(isEvent(r4) && (r4 as any).seq === 4);
		assert.ok(isEvent(r5) && (r5 as any).seq === 6 && (r5 as any).envelope.id === e5.id, "续传补发含 seq 留洞（4、6，无 5）");
		// 不再有多余帧（200ms 静默窗）
		const extra = await c2.ws!.recvJson(300);
		assert.equal(extra, null, "补发精确止于 head（不重不漏）");

		// 越界 → snapshot
		c2.ws!.sendText(JSON.stringify({ type: "subscribe", topic: "journal", base: { seq: 999, logEpoch: e1.id } }));
		const ack3 = await c2.ws!.recvJson();
		assert.ok(isAck(ack3) && ack3.mode === "snapshot", "base.seq > head → snapshot");

		// 跨代：journal 重建（新首 envelope）→ 旧 base 判 snapshot
		const fresh = makeEnvelope();
		writeFileSync(journalPath, `${JSON.stringify(fresh)}\n`, "utf8");
		c2.ws!.sendText(JSON.stringify({ type: "subscribe", topic: "journal", base: { seq: 2, logEpoch: e1.id } }));
		const ack4 = await c2.ws!.recvJson();
		assert.ok(isAck(ack4) && ack4.mode === "snapshot", "logEpoch 不符（跨代）→ snapshot");
		assert.equal((ack4 as any).head.logEpoch, fresh.id);
		c2.ws!.destroy();
	}

	// ── T4 transcript 流 + 续传 + GET 同投影 ─────────────────────────
	{
		const sid = "aaaa1111-2222-3333-4444-555566667777";
		const file = join(sessionsDir, `2026-09-22T09-00-00-000Z_${sid}.jsonl`);
		writeFileSync(file, [
			mkSessionHeader(sid, "2026-09-22T09:00:00.000Z"), // seq 1
			mkUser("u1", "2026-09-22T09:00:01.000Z", "看看"), // seq 2
			mkAssistantToolCall("a1", "2026-09-22T09:00:02.000Z", "call_1"), // seq 3
		].join(""), "utf8");

		const c = await wsHandshake(handle.info.port, wsPath(token!));
		assert.ok(c.ok);
		const topic = `transcript:${sid}`;

		// 首屏：seq=0 → snapshot（WS 只做增量，首屏走 GET）
		c.ws!.sendText(JSON.stringify({ type: "subscribe", topic, base: {} }));
		const ack1 = await c.ws!.recvJson();
		assert.ok(isAck(ack1) && ack1.mode === "snapshot", "首屏 subscribe → snapshot 指针");
		assert.equal((ack1 as any).head.seq, 3);
		assert.equal((ack1 as any).head.logEpoch, sid);

		// 首屏快照（head=3 时刻，3 行）
		const rows0 = (await (async () => {
			const r = await getJson(base, `/v1/sessions/${sid}/transcript`);
			assert.equal(r.status, 200);
			return r.body.rows as TranscriptRow[];
		})());
		assert.equal(rows0.length, 3);

		// head 重订阅 → resume 空补发
		c.ws!.sendText(JSON.stringify({ type: "subscribe", topic, base: { seq: 3, logEpoch: sid } }));
		const ack2 = await c.ws!.recvJson();
		assert.ok(isAck(ack2) && ack2.mode === "resume");
		const quiet = await c.ws!.recvJson(300);
		assert.equal(quiet, null, "head 重订阅无补发");

		// 追加：assistant 新 toolCall（seq 4）+ toolResult 回填（seq 5 → upserted）
		appendFileSync(file, mkAssistantToolCall("a2", "2026-09-22T09:00:03.000Z", "call_2"), "utf8");
		const d1 = await c.ws!.recvJson();
		assert.ok(isEvent(d1) && (d1 as any).op?.kind === "row.appended", "seq4 → appended");
		assert.equal((d1 as any).seq, 4);
		const appendedRow = (d1 as any).op.row as TranscriptRow;
		assert.equal(appendedRow.rowId, "r_a2_0");
		assert.equal((appendedRow as any).status, "running");
		appendFileSync(file, mkToolResult("t2", "2026-09-22T09:00:04.000Z", "call_2", "content-of-a"), "utf8");
		const d2 = await c.ws!.recvJson();
		assert.ok(isEvent(d2) && (d2 as any).op?.kind === "row.upserted", "seq5 toolResult → upserted 回填");
		assert.equal((d2 as any).seq, 5);
		const upsertedRow = (d2 as any).op.row as TranscriptRow;
		assert.equal((upsertedRow as any).status, "done");
		assert.equal((upsertedRow as any).output, "content-of-a");

		// 断线重连 base={seq:3} → 精确补发 seq4/5 两帧；应用终态 == GET 全量
		c.ws!.destroy();
		const c2 = await wsHandshake(handle.info.port, wsPath(token!));
		assert.ok(c2.ok);
		c2.ws!.sendText(JSON.stringify({ type: "subscribe", topic, base: { seq: 3, logEpoch: sid } }));
		const ack3 = await c2.ws!.recvJson();
		assert.ok(isAck(ack3) && ack3.mode === "resume");
		const f1 = await c2.ws!.recvJson();
		const f2 = await c2.ws!.recvJson();
		assert.ok(isEvent(f1) && (f1 as any).seq === 4);
		assert.ok(isEvent(f2) && (f2 as any).seq === 5);
		const replayQuiet = await c2.ws!.recvJson(300);
		assert.equal(replayQuiet, null, "补发不重不漏");

		// 首屏快照 + 补帧 终态 == 事后 GET 全量（同一投影函数、确定性）
		const applied = applyTranscriptOps({ rows: rows0, info: {} }, [(f1 as any).op, (f2 as any).op]);
		const full = await getJson(base, `/v1/sessions/${sid}/transcript`);
		assert.equal(full.status, 200);
		assert.equal(full.body.mode, "snapshot");
		const fullRows = full.body.rows as TranscriptRow[];
		assert.equal(applied.rows.length, 4);
		assert.equal(JSON.stringify(applied.rows), JSON.stringify(fullRows), "首屏+补帧 终态逐字节 == GET 全量");
		for (const opFrame of [f1, f2]) {
			const k = (opFrame as any).op.kind;
			assert.ok(k === "row.appended" || k === "row.upserted", `P1 发射面：${k}`);
		}
		c2.ws!.destroy();

		// 缺失会话 → ack head:null
		const c3 = await wsHandshake(handle.info.port, wsPath(token!));
		assert.ok(c3.ok);
		c3.ws!.sendText(JSON.stringify({ type: "subscribe", topic: "transcript:missing-0000-0000", base: {} }));
		const ackMissing = await c3.ws!.recvJson();
		assert.ok(isAck(ackMissing) && (ackMissing as any).head === null);
		c3.ws!.destroy();
	}

	// ── T5 GET sessions + transcript 分页三态 ────────────────────────
	{
		const lst = await getJson(base, "/v1/sessions");
		assert.equal(lst.status, 200);
		assert.ok(lst.body.count >= 1, "列表含夹具会话");
		const entry = (lst.body.sessions as any[]).find((s) => s.sessionId === "aaaa1111-2222-3333-4444-555566667777");
		assert.ok(entry, "会话条目在列表");
		assert.equal(entry.cwd, "C:\\ws-test");

		const sid = "aaaa1111-2222-3333-4444-555566667777";
		const full = await getJson(base, `/v1/sessions/${sid}/transcript`);
		assert.equal(full.body.count, full.body.rows.length);
		assert.equal(full.body.name, null);
		// 分页：after=0 全量；after=head 空；after=2 只触及 seq3+ 的行（终态）
		const after0 = await getJson(base, `/v1/sessions/${sid}/transcript?after=0`);
		assert.deepEqual(after0.body.rows, full.body.rows, "after=0 == 全量");
		const headSeq = full.body.head.seq;
		const afterHead = await getJson(base, `/v1/sessions/${sid}/transcript?after=${headSeq}`);
		assert.equal(afterHead.body.rows.length, 0, "after=head → 空");
		const after2 = await getJson(base, `/v1/sessions/${sid}/transcript?after=2`);
		assert.deepEqual(after2.body.rows.map((r: any) => r.rowId), ["r_a1_0", "r_a2_0"],
			"after=2 → seq3+ 触及行（call_1 running + call_2 回填终态）");
		assert.equal((after2.body.rows[0] as any).status, "running", "call_1 无结果 → 保持 running");
		assert.equal((after2.body.rows[1] as any).status, "done", "call_2 触及行回终态");

		const missing = await getJson(base, "/v1/sessions/ffffffff-0000-0000-0000-000000000000/transcript");
		assert.equal(missing.status, 404);
		assert.equal((missing.body as any).error, "session-not-found");
	}

	// ── T6 双 WS 并发 fan-out ────────────────────────────────────────
	{
		const sid = "bbbb2222-3333-4444-5555-666677778888";
		const file = join(sessionsDir, `2026-09-22T10-00-00-000Z_${sid}.jsonl`);
		writeFileSync(file, [mkSessionHeader(sid, "2026-09-22T10:00:00.000Z"), mkUser("u1", "2026-09-22T10:00:01.000Z", "hi")].join(""), "utf8");
		const topic = `transcript:${sid}`;

		const w1 = await wsHandshake(handle.info.port, wsPath(token!));
		const w2 = await wsHandshake(handle.info.port, wsPath(token!));
		assert.ok(w1.ok && w2.ok);
		for (const w of [w1, w2]) {
			w.ws!.sendText(JSON.stringify({ type: "subscribe", topic, base: { seq: 2, logEpoch: sid } }));
			assert.ok(isAck(await w.ws!.recvJson()));
		}
		appendFileSync(file, mkAssistantToolCall("a1", "2026-09-22T10:00:02.000Z", "call_9"), "utf8");
		const g1 = await w1.ws!.recvJson();
		const g2 = await w2.ws!.recvJson();
		assert.ok(isEvent(g1) && isEvent(g2), "两连接均收到 live 帧（多只读 WS 并发允许）");
		assert.equal((g1 as any).seq, 3);
		assert.equal((g2 as any).seq, 3);
		w1.ws!.destroy();
		w2.ws!.destroy();
	}

	// ── T7 帧卫生 + ping ─────────────────────────────────────────────
	{
		const c = await wsHandshake(handle.info.port, wsPath(token!));
		assert.ok(c.ok);
		c.ws!.sendText("not json at all");
		const e1 = await c.ws!.recvJson();
		assert.ok(typeof e1 === "object" && e1 !== null && (e1 as any).type === "error", "坏 JSON → error 帧");
		c.ws!.sendText(JSON.stringify({ type: "subscribe", topic: "bogus:topic" }));
		const e2 = await c.ws!.recvJson();
		assert.ok(typeof e2 === "object" && e2 !== null && (e2 as any).type === "error", "未知 topic → error 帧");
		// 连接仍可用（订阅一个正常 topic 验证）
		appendRuntimeEnvelope(makeEnvelope(), journalPath);
		c.ws!.sendText(JSON.stringify({ type: "subscribe", topic: "journal", base: {} }));
		assert.ok(isAck(await c.ws!.recvJson()), "error 后连接仍可用");
		c.ws!.destroy();

		// 服务端 ping：无订阅裸连接只收 ping；回 pong 后下一拍仍存活
		const p = await wsHandshake(handle.info.port, wsPath(token!));
		assert.ok(p.ok);
		const ping1 = await p.ws!.recv(2000, 0x9);
		assert.ok(ping1 !== null && ping1.opcode === 0x9, "服务端 ping 到达");
		if (ping1 !== null) p.ws!.sendPong(ping1.payload);
		const ping2 = await p.ws!.recv(2000, 0x9);
		assert.ok(ping2 !== null, "pong 后下一拍 ping 仍到（keepalive 未误杀）");
		if (ping2 !== null) p.ws!.sendPong(ping2.payload);
		p.ws!.destroy();
	}

	console.log("_test_runtime_host_ws: all assertions passed");
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
