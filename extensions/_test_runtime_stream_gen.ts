/**
 * _test_runtime_stream_gen.ts — G6-P1 L4 必修①测试：持久流代际（stream-gen sidecar）
 *
 * 覆盖（plans/0921_g6p1_review.md §必修结论 1）：
 *   A 组（lib 级 runtime/stream-gen.ts::validateStreamGen）：
 *     A1 首次校验 gen=1 落盘；A2 未变不 bump；A3 纯追加不 bump；
 *     A4 等长替换（同首行、同字节数、末行不同内容）→ bump；A5 变长重写（同首行）→ bump；
 *     A6 首行变化 → bump；A7 截断变短 → bump；A8 sidecar 损坏 → 容错（退化 epoch-only，已文档化）；
 *     A9 文件消失 → bump；无完整记录期增长 → 不 bump；A10 gen 跨多次校验持久
 *   B 组（WS 集成，journal + session transcript 两路）：
 *     B1 journal 同首行等长重写：resume 前检出 → snapshot + gen bump → 重拉重订阅不重不漏
 *     B2 旧客户端（base 无 gen）→ 仅 epoch 判代 resume（向后兼容语义明确）
 *     B3 transcript 同 session 头重写 → snapshot + gen bump（重拉后终态 = 新代内容）
 *     B4 跨 host 重启持久：关 server → 重写 → 新 server → 旧 gen 判 snapshot（sidecar 持久）
 *     B5 正常追加重连（带 gen）→ resume 不误杀
 *     B6 GET transcript head 带 gen；重写后 GET head.gen 递增
 *
 * 运行：npm run test:runtime-stream-gen
 */

import assert from "node:assert/strict";
import { connect as netConnect, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "stream-gen-env-"));
process.env.PI_SESSIONS_DIR = mkdtempSync(join(tmpdir(), "stream-gen-sessions-"));

import { createRuntimeHostServer, type RuntimeHostHandle } from "./runtime-host/server.ts";
import { newEventEnvelope } from "./runtime/envelope.ts";
import { masterAddress } from "./runtime/address.ts";
import { readStreamGenState, streamGenPath, validateStreamGen } from "./runtime/stream-gen.ts";
import type { TranscriptRow } from "./runtime/transcript.ts";

const ENV_DIR = process.env.PI_RUNTIME_DIR!;
const SESSIONS_DIR = process.env.PI_SESSIONS_DIR!;
const DIRS: string[] = [ENV_DIR, SESSIONS_DIR];

function mkDir(): string {
	const d = mkdtempSync(join(tmpdir(), "stream-gen-case-"));
	DIRS.push(d);
	return d;
}

// ── 夹具：可控 id 的 envelope 行（等长替换需同字节长度）────────────

const FIXED_AT = "2026-09-22T00:00:00.000Z";

function envLine(id: string, n: number): string {
	const e = { ...newEventEnvelope({ type: "test.tick", source: masterAddress(), payload: { n }, at: FIXED_AT }), id };
	return `${JSON.stringify(e)}\n`;
}

function writeJournal(path: string, ids: [string, number][]): void {
	writeFileSync(path, ids.map(([id, n]) => envLine(id, n)).join(""), "utf8");
}

function appendJournalLine(path: string, envelope: unknown): void {
	appendFileSync(path, `${JSON.stringify(envelope)}\n`, "utf8");
}

// 等长 id：固定 24 字符；n 用同位数 → 整行字节长度可控相等
const ID_A = "A".repeat(24);
const ID_B = "B".repeat(24);
const ID_C = "C".repeat(24);

// ── A 组：lib 级 ──────────────────────────────────────────────────

{
	const d = mkDir();
	const file = join(d, "events.jsonl");
	const statePath = join(d, "state", "stream-gen.json");

	// A1 首次校验 → gen=1 + sidecar 落盘
	writeJournal(file, [[ID_A, 1], [ID_B, 2]]);
	assert.equal(validateStreamGen("journal", file, ID_A, { statePath }), 1, "A1: 首次校验 gen=1");
	assert.ok(existsSync(statePath), "A1: sidecar 落盘");
	assert.equal(readStreamGenState(statePath).streams.journal?.gen, 1);

	// A2 未变 → gen 不变
	assert.equal(validateStreamGen("journal", file, ID_A, { statePath }), 1, "A2: 未变不 bump");

	// A3 纯追加 → gen 不变（n 用两位数，为 A4 等长替换做前置）
	appendJournalLine(file, { ...newEventEnvelope({ type: "test.tick", source: masterAddress(), payload: { n: 43 }, at: FIXED_AT }), id: ID_C });
	assert.equal(validateStreamGen("journal", file, ID_A, { statePath }), 1, "A3: 纯追加不 bump");

	// A4 等长替换：行数/字节数不变、首行原样、末行内容不同（ID_C/43 → ID_B/42，等长）
	writeJournal(file, [[ID_A, 1], [ID_B, 2], [ID_B, 42]]);
	assert.equal(Buffer.byteLength(envLine(ID_C, 43)), Buffer.byteLength(envLine(ID_B, 42)), "A4 前置：替换行等长");
	const before = readStreamGenState(statePath).streams.journal?.fullHash;
	assert.equal(validateStreamGen("journal", file, ID_A, { statePath }), 2, "A4: 等长替换（同首行）→ bump");
	assert.notEqual(readStreamGenState(statePath).streams.journal?.fullHash, before, "A4: sidecar 记录已更新");

	// A5 变长重写：同首行、行数变多且中段不同
	writeJournal(file, [[ID_A, 1], [ID_B, 2], [ID_C, 3], [ID_C, 4]]);
	assert.equal(validateStreamGen("journal", file, ID_A, { statePath }), 3, "A5: 变长重写（同首行）→ bump");

	// A6 首行变化（epoch 变）→ bump
	writeJournal(file, [[ID_B, 1], [ID_C, 2]]);
	assert.equal(validateStreamGen("journal", file, ID_B, { statePath }), 4, "A6: 首行变化 → bump");

	// A7 截断变短 → bump
	writeJournal(file, [[ID_B, 1]]);
	assert.equal(validateStreamGen("journal", file, ID_B, { statePath }), 5, "A7: 截断 → bump");

	// A9 文件消失 → bump；无完整记录期增长 → 不 bump
	rmSync(file);
	assert.equal(validateStreamGen("journal", file, "", { statePath }), 6, "A9: 文件消失 → bump");
	writeJournal(file, [[ID_A, 1]]);
	assert.equal(validateStreamGen("journal", file, ID_A, { statePath }), 6, "A9: 无完整记录期增长 → 不 bump");

	// A10 gen 持久：纯追加后校验，gen 延续（6）
	appendJournalLine(file, { ...newEventEnvelope({ type: "test.tick", source: masterAddress(), payload: { n: 2 }, at: FIXED_AT }), id: ID_B });
	assert.equal(validateStreamGen("journal", file, ID_A, { statePath }), 6, "A10: gen 跨多次校验持久");
}

// A8 sidecar 损坏 → 容错（gen 重置 1，不 throw）
{
	const d = mkDir();
	const file = join(d, "events.jsonl");
	const statePath = join(d, "state", "stream-gen.json");
	writeJournal(file, [[ID_A, 1]]);
	assert.equal(validateStreamGen("journal", file, ID_A, { statePath }), 1);
	writeFileSync(statePath, "{not json", "utf8");
	assert.equal(validateStreamGen("journal", file, ID_A, { statePath }), 1, "A8: 坏 sidecar → 容错重来（退化 epoch-only，已文档化）");
}

// ── WS 测试客户端（最小；含 close code 解析）────────────────────

interface SFrame { opcode: number; payload: Buffer }

class TestWs {
	socket: Socket;
	private buf: Buffer = Buffer.alloc(0);
	private queue: SFrame[] = [];
	private waiters: (() => void)[] = [];
	closed = false;
	responseHead: string | null = null;

	constructor(socket: Socket) {
		this.socket = socket;
		socket.on("data", (c: Buffer) => this.onData(c));
		socket.on("close", () => {
			this.closed = true;
			this.notify();
		});
		socket.on("error", () => {
			/* ignore */
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
			if (this.buf[1] & 0x80) offset += 4; // 服务端帧不带掩码；测试客户端跳过字段
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

	sendText(text: string): void {
		this.socket.write(clientFrame(0x1, Buffer.from(text, "utf8")));
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

function clientFrame(opcode: number, payload: Buffer): Buffer {
	const mask = randomBytes(4);
	const masked = Buffer.from(payload);
	for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
	const header = payload.length < 126
		? Buffer.from([0x80 | opcode, 0x80 | payload.length])
		: Buffer.from([0x80 | opcode, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
	return Buffer.concat([header, mask, masked]);
}

function wsHandshake(port: number, path: string, timeoutMs = 3000): Promise<TestWs | null> {
	return new Promise((resolve) => {
		const socket = netConnect(port, "127.0.0.1");
		const ws = new TestWs(socket);
		let settled = false;
		const finish = (v: TestWs | null): void => {
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
			socket.write([
				`GET ${path} HTTP/1.1`,
				"Host: 127.0.0.1",
				"Upgrade: websocket",
				"Connection: Upgrade",
				`Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
				"Sec-WebSocket-Version: 13",
				"",
				"",
			].join("\r\n"));
		});
		setTimeout(() => {
			clearInterval(poll);
			socket.destroy();
			finish(null);
		}, timeoutMs);
	});
}

function isAck(f: unknown): f is { type: "ack"; mode: string; head: { logEpoch: string; seq: number; gen: number } | null } {
	return typeof f === "object" && f !== null && (f as any).type === "ack";
}

// ── B 组：WS 集成 ────────────────────────────────────────────────

let handle: RuntimeHostHandle | null = null;

try {
	const journalPath = join(ENV_DIR, "events.jsonl");
	handle = await createRuntimeHostServer({ journalPath, sessionsDir: SESSIONS_DIR, tailMs: 30, pingMs: 5000 });
	let wsUrl = `/v1/events/stream?token=${encodeURIComponent(handle.info.token!)}`;

	// ── B1 journal 同首行等长重写 → 检出 gen 变化 → resync 不重不漏 ──
	{
		// 3 行（seq 1-3）；末行 payload n=41 —— 重写后 n=42（等长）
		writeJournal(journalPath, [[ID_A, 1], [ID_B, 2], [ID_C, 41]]);

		const c1 = await wsHandshake(handle.info.port, wsUrl);
		assert.ok(c1);
		c1.sendText(JSON.stringify({ type: "subscribe", topic: "journal", base: {} }));
		const ack1 = await c1.recvJson();
		assert.ok(isAck(ack1) && ack1.head !== null, "B1: 订阅 ack");
		assert.equal(ack1.head!.gen, 1, "B1: 首代 gen=1");
		assert.equal(ack1.head!.logEpoch, ID_A);
		for (let i = 0; i < 3; i += 1) await c1.recvJson(); // 消化全量重放
		c1.destroy();

		// 离线期等长替换：行数不变、首行（ID_A）原样、末行 n 41→42（同字节数）
		writeJournal(journalPath, [[ID_A, 1], [ID_B, 2], [ID_C, 42]]);
		assert.equal(
			Buffer.byteLength(envLine(ID_C, 41) + envLine(ID_A, 1) + envLine(ID_B, 2)),
			Buffer.byteLength(envLine(ID_C, 42) + envLine(ID_A, 1) + envLine(ID_B, 2)),
			"B1 前置：重写前后等长（旧 byte-cursor 截断检出不适用）",
		);

		// 带旧 gen=1 重连 → 判 snapshot（修复前：epoch 同 + head≥base → 错误 resume）
		const c2 = await wsHandshake(handle.info.port, wsUrl);
		assert.ok(c2);
		c2.sendText(JSON.stringify({ type: "subscribe", topic: "journal", base: { seq: 3, logEpoch: ID_A, gen: 1 } }));
		const ack2 = await c2.recvJson();
		assert.ok(isAck(ack2), "B1: 重连 ack");
		assert.equal(ack2.mode, "snapshot", "B1: 同首行等长重写 → snapshot（gen 判代）");
		assert.ok(ack2.head !== null && ack2.head.gen === 2, "B1: gen bump → 2");

		// snapshot 后直到客户端 GET+重订阅前绝不可 live fan-out：否则新代 op 会拼到旧代 UI 行。
		appendJournalLine(journalPath, { ...newEventEnvelope({ type: "test.tick", source: masterAddress(), payload: { n: 4 }, at: FIXED_AT }), id: "D".repeat(24) });
		assert.equal(await c2.recvJson(150), null, "B1: snapshot 阶段不推 live，避免混代拼接");

		// 客户端 GET 新代快照后以旧 head（seq=3）重订阅；(3,4] 回放补齐 GET→订阅竞态。
		c2.sendText(JSON.stringify({ type: "subscribe", topic: "journal", base: { seq: 3, logEpoch: ID_A, gen: 2 } }));
		const ack3 = await c2.recvJson();
		assert.ok(isAck(ack3) && ack3.mode === "resume", "B1: 新 gen resume");
		const ids: string[] = [];
		for (;;) {
			const f = (await c2.recvJson(400)) as any;
			if (f === null || f.type !== "event") break;
			ids.push(f.envelope.id as string);
			if (f.seq === 3) assert.equal(f.envelope.payload?.n, 42, "B1: seq3 = 新代内容（n=42）");
		}
		assert.deepEqual(ids, ["D".repeat(24)], "B1: 重订阅仅补 GET 后 seq4（不重不漏）");
		const quiet = await c2.recvJson(300);
		assert.equal(quiet, null, "B1: 不重（重放止于 head）");
		c2.destroy();
	}

	// ── B2 旧客户端（base 无 gen）→ 仅 epoch 判代（向后兼容路径）──────
	{
		const c = await wsHandshake(handle.info.port, wsUrl);
		assert.ok(c);
		c.sendText(JSON.stringify({ type: "subscribe", topic: "journal", base: { seq: 1, logEpoch: ID_A } }));
		const ack = await c.recvJson();
		assert.ok(isAck(ack) && ack.mode === "resume", "B2: 无 gen 的旧 base 仍按 epoch resume（兼容）");
		c.destroy();
	}

	// ── B5 正常追加重连（带 gen）→ resume 不误杀 ─────────────────────
	{
		const c1 = await wsHandshake(handle.info.port, wsUrl);
		assert.ok(c1);
		c1.sendText(JSON.stringify({ type: "subscribe", topic: "journal", base: { seq: 4, logEpoch: ID_A, gen: 2 } }));
		const ack = await c1.recvJson();
		assert.ok(isAck(ack) && ack.mode === "resume", "B5: 同代带 gen → resume");
		assert.ok(ack.head !== null && ack.head.gen === 2);
		c1.destroy();

		// 追加（seq 5）→ 重连带同 gen → resume + 只补增量
		appendJournalLine(journalPath, { ...newEventEnvelope({ type: "test.tick", source: masterAddress(), payload: { n: 4 }, at: FIXED_AT }), id: "D".repeat(24) });
		const c2 = await wsHandshake(handle.info.port, wsUrl);
		assert.ok(c2);
		c2.sendText(JSON.stringify({ type: "subscribe", topic: "journal", base: { seq: 4, logEpoch: ID_A, gen: 2 } }));
		const ack2 = await c2.recvJson();
		assert.ok(isAck(ack2) && ack2.mode === "resume", "B5: 追加后重连仍 resume（不误杀）");
		const f = (await c2.recvJson()) as any;
		assert.ok(f.type === "event" && f.seq === 5, "B5: 只补 seq5");
		const quiet = await c2.recvJson(300);
		assert.equal(quiet, null, "B5: 不重");
		c2.destroy();
	}

	// ── B6 GET transcript head 带 gen；B3 同 session 头重写 → bump ────
	{
		const sid = "cccc1111-2222-3333-4444-555566667777";
		const file = join(SESSIONS_DIR, `2026-09-22T11-00-00-000Z_${sid}.jsonl`);
		const headerLine = JSON.stringify({ type: "session", version: 3, id: sid, timestamp: "2026-09-22T11:00:00.000Z", cwd: "C:\\sg-test" });
		const userOld = JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: "2026-09-22T11:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "old-question" }] } });
		const userNew = JSON.stringify({ type: "message", id: "u2", parentId: null, timestamp: "2026-09-22T11:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "new-question" }] } });
		writeFileSync(file, `${headerLine}\n${userOld}\n`, "utf8");

		const r1 = await fetch(`http://127.0.0.1:${handle.info.port}/v1/sessions/${sid}/transcript`);
		assert.equal(r1.status, 200);
		const b1 = (await r1.json()) as { head: { seq: number; logEpoch: string; gen: number }; rows: TranscriptRow[] };
		assert.equal(b1.head.gen, 1, "B6: GET head 带初代 gen=1");
		assert.equal(b1.head.logEpoch, sid);

		// WS：首代 resume 正常
		const c = await wsHandshake(handle.info.port, wsUrl);
		assert.ok(c);
		c.sendText(JSON.stringify({ type: "subscribe", topic: `transcript:${sid}`, base: { seq: 2, logEpoch: sid, gen: 1 } }));
		const ack = await c.recvJson();
		assert.ok(isAck(ack) && ack.mode === "resume", "B3: transcript 同代 resume");
		c.destroy();

		// 同 session 头（首行 id 不变）重写：user 行替换为不同内容
		writeFileSync(file, `${headerLine}\n${userNew}\n`, "utf8");

		// 旧 gen 重连 → snapshot + bump（修复前：epoch 同 + seq≤head → resume 旧投影）
		const c2 = await wsHandshake(handle.info.port, wsUrl);
		assert.ok(c2);
		c2.sendText(JSON.stringify({ type: "subscribe", topic: `transcript:${sid}`, base: { seq: 2, logEpoch: sid, gen: 1 } }));
		const ack2 = await c2.recvJson();
		assert.ok(isAck(ack2) && ack2.mode === "snapshot", "B3: 同 session 头重写 → snapshot（gen 判代）");
		assert.ok(ack2.head !== null && ack2.head.gen === 2, "B3: gen bump → 2");
		c2.destroy();

		// 重拉 GET：新代内容 + head.gen=2（不重不漏：旧 u1 行不残留）
		const r2 = await fetch(`http://127.0.0.1:${handle.info.port}/v1/sessions/${sid}/transcript`);
		const b2 = (await r2.json()) as { head: { gen: number }; rows: TranscriptRow[] };
		assert.equal(b2.head.gen, 2, "B6: 重写后 GET head.gen 递增");
		const texts = b2.rows.filter((r) => r.kind === "userInput").map((r) => (r as any).text as string);
		assert.deepEqual(texts, ["new-question"], "B3/B6: 重拉 = 新代内容（旧行不残留）");
	}

	// ── B4 跨 host 重启持久：close → 离线重写 → 新 server → 旧 gen 判 snapshot ──
	{
		await handle.close().catch(() => undefined);
		handle = null;

		// host 已停：离线期重写 journal（首 envelope id 不变；行数/大小变）
		writeJournal(journalPath, [[ID_A, 1], [ID_B, 2], [ID_C, 43], [ID_C, 44]]);

		// 新 host 实例（新 token/port；sidecar 同盘持久）
		handle = await createRuntimeHostServer({ journalPath, sessionsDir: SESSIONS_DIR, tailMs: 30, pingMs: 5000 });
		wsUrl = `/v1/events/stream?token=${encodeURIComponent(handle.info.token!)}`;
		const c = await wsHandshake(handle.info.port, wsUrl);
		assert.ok(c, "B4: 新实例新 token 可连");
		c.sendText(JSON.stringify({ type: "subscribe", topic: "journal", base: { seq: 3, logEpoch: ID_A, gen: 2 } }));
		const ack = await c.recvJson();
		assert.ok(isAck(ack) && ack.mode === "snapshot", "B4: 跨 host 重启后 sidecar 仍判出重写 → snapshot");
		assert.ok(ack.head !== null && ack.head.gen === 3, "B4: gen 延续 → 3");
		c.destroy();
	}

	console.log("_test_runtime_stream_gen: all assertions passed");
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
