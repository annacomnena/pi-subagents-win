/**
 * runtime-host/ws.ts — G6-P1 C2/C4：`WS /v1/events/stream`（plans/0920_g6_webconsole_plan.md §1 拍板①）
 *
 * 单条 WS 连接 JSON 文本帧多路复用两路只读流：
 *   - topic "journal"：journal 增量帧 `{type:"event", topic, seq, envelope}`（seq=物理行号）。
 *   - topic "transcript:<sessionId>"：会话转写投影增量帧 `{type:"event", topic, seq, op}`
 *     （seq=session JSONL 物理行号；op = 5 操作封闭集，与 GET 端点同一投影函数）。
 *
 * 续传语义（照 ZCode subscribe(base:{logEpoch,seq})，G6-P1 L4 增 gen 判代）：
 *   client `{type:"subscribe", topic, base:{seq, logEpoch, gen?}}` →
 *   server `{type:"ack", topic, mode:"resume"|"snapshot", head:{logEpoch, seq, gen}|null}`：
 *   - resume：logEpoch 相符且 base.seq ≤ head 且 base.gen 相符（undefined=旧客户端跳过 gen 检查）
 *     → 补发 (base, head]（journal 本身就是重放源，无有界缓冲；transcript 全量重投影确定性
 *     回放——不重不漏）。
 *   - snapshot：logEpoch 不符 / gen 不符 / seq 越界 / 首 subscribers（transcript 首屏走 GET）
 *     → 只回指针，客户端重 HTTP GET 全量再以 head 重订阅（WS ack 不背大二进制快照）。
 *   - live 期截断/重建（文件变短）→ `{type:"resync", topic, head:null}` 并弃订阅，客户端重订阅。
 *
 * 判代（G6-P1 L4 必修①，runtime/stream-gen.ts）：logEpoch=首条 id 识别不了「保留首行的重写/
 * 轮转」——sidecar runtime/state/stream-gen.json 按流持久 {firstId,size,fullHash,gen}，每次
 * resume/subscribe 前校验：非追加变更（等长替换/变长重写/截断）→ gen+1 → 旧 base.gen 不符 →
 * snapshot。跨 host 重启持久；残余局限见 stream-gen.ts 头注（sidecar 丢失退化为 epoch-only、
 * live 连接期不校验 gen、逐字节全同重写不设防）。
 *
 * 保活：30s ping/pong（两拍无 pong 判死断开，防僵尸连接堆积）。
 *
 * 认证（G6-P1 fail-closed）：token 由 host 启动生成落 host.json（同机进程可读）；WS 握手凭
 *   `?token=` 或 `Cookie: sw_host_token=`；无/错 token → 401（101 前拒绝）；`?token=` 握手成功
 *   回 Set-Cookie（HttpOnly + SameSite=Strict + Path=/）。HTTP 端点零变化（P1 仅 WS 面校验）。
 *
 * 手写最小 RFC6455（零新依赖，~百行）：文本帧 + ping/pong + 关闭握手；二进制/分片/RSV →
 *   close 1002/1003（出现需求即越界信号，回 plan §6）。上限 1MiB/帧 → 1009。
 *
 * 红线：P1 纯只读（无任何控制流帧）；升级路径仅此一条；HTTP 端点零变化；never-throw（单连接
 * 故障不炸 host）。
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import {
	readJournalTail,
	scanJournalSeq,
	type JournalSeqCursor,
} from "../runtime/journal-seq.ts";
import { validateStreamGen } from "../runtime/stream-gen.ts";
import {
	createTranscriptProjector,
	defaultSessionsDir,
	findSessionFile,
	projectSessionOps,
	readSessionTail,
	type SessionTailCursor,
	type TranscriptOp,
} from "../runtime/transcript.ts";
import { defaultJournalPath } from "../runtime/journal.ts";

export const WS_PATH = "/v1/events/stream";
export const WS_COOKIE_NAME = "sw_host_token";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_PAYLOAD_BYTES = 1_048_576;
const MAX_SUBS_PER_CONN = 16;

// ── 帧编解码（server→client 无掩码；client→server 必须带掩码）──────

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

interface WsFrame {
	opcode: number;
	payload: Buffer;
}

class WsProtocolError extends Error {
	code: number;
	constructor(message: string, code = 1002) {
		super(message);
		this.code = code;
	}
}

class FrameParser {
	private buf: Buffer = Buffer.alloc(0);

	/** 喂入新字节，吐出完整帧；协议违规抛 WsProtocolError（调用方 close 对应码）。 */
	push(chunk: Buffer): WsFrame[] {
		this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
		const frames: WsFrame[] = [];
		for (;;) {
			if (this.buf.length < 2) break;
			const b0 = this.buf[0];
			const b1 = this.buf[1];
			const fin = (b0 & 0x80) !== 0;
			const rsv = b0 & 0x70;
			const opcode = b0 & 0x0f;
			const masked = (b1 & 0x80) !== 0;
			const len7 = b1 & 0x7f;
			if (rsv !== 0) throw new WsProtocolError("rsv-bits-set（无扩展协商）", 1002);
			// RFC 6455 §5.1：客户端到服务端的每一帧必须掩码。
			if (!masked) throw new WsProtocolError("client-frame-not-masked", 1002);
			if (!fin && (opcode === OP_CLOSE || opcode === OP_PING || opcode === OP_PONG)) {
				throw new WsProtocolError("fragmented-control-frame", 1002);
			}
			if (![OP_CONT, OP_TEXT, OP_BINARY, OP_CLOSE, OP_PING, OP_PONG].includes(opcode)) {
				throw new WsProtocolError("unknown-opcode", 1002);
			}
			let offset = 2;
			let len = len7;
			if (len7 === 126) {
				if (this.buf.length < offset + 2) break;
				len = this.buf.readUInt16BE(offset);
				offset += 2;
			} else if (len7 === 127) {
				if (this.buf.length < offset + 8) break;
				const big = this.buf.readBigUInt64BE(offset);
				if (big > BigInt(MAX_PAYLOAD_BYTES)) throw new WsProtocolError("payload-too-large", 1009);
				len = Number(big);
				offset += 8;
			}
			if (len > MAX_PAYLOAD_BYTES) throw new WsProtocolError("payload-too-large", 1009);
			let maskKey: Buffer | null = null;
			if (masked) {
				if (this.buf.length < offset + 4) break; // 掩码不完整，等更多字节
				maskKey = this.buf.subarray(offset, offset + 4);
				offset += 4;
			}
			if (this.buf.length < offset + len) break;
			let payload = Buffer.from(this.buf.subarray(offset, offset + len));
			if (maskKey !== null) {
				for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i % 4];
			}
			this.buf = this.buf.subarray(offset + len);
			// P1 越界信号：分片/二进制直接拒（plan §8 风险 1）
			if (!fin && (opcode === OP_TEXT || opcode === OP_BINARY)) throw new WsProtocolError("fragmentation-not-supported", 1002);
			if (opcode === OP_CONT) throw new WsProtocolError("continuation-not-supported", 1002);
			if (opcode === OP_BINARY) throw new WsProtocolError("binary-not-supported", 1003);
			if ((opcode === OP_CLOSE || opcode === OP_PING || opcode === OP_PONG) && len > 125) {
				throw new WsProtocolError("control-frame-too-long", 1002);
			}
			frames.push({ opcode, payload });
		}
		return frames;
	}
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
	const len = payload.length;
	let header: Buffer;
	if (len < 126) {
		header = Buffer.from([0x80 | opcode, len]);
	} else if (len < 65536) {
		header = Buffer.alloc(4);
		header[0] = 0x80 | opcode;
		header[1] = 126;
		header.writeUInt16BE(len, 2);
	} else {
		header = Buffer.alloc(10);
		header[0] = 0x80 | opcode;
		header[1] = 127;
		header.writeBigUInt64BE(BigInt(len), 2);
	}
	return Buffer.concat([header, payload]);
}

// ── 连接（单 WS；send/ping/close + 回调）─────────────────────────

export interface WsConnHandlers {
	onText?: (text: string) => void;
	onPong?: () => void;
	onClose?: () => void;
}

export class WsConn {
	readonly socket: Duplex;
	private parser = new FrameParser();
	private closed = false;
	private closeSent = false;
	private handlers: WsConnHandlers;

	constructor(socket: Duplex, handlers: WsConnHandlers) {
		this.socket = socket;
		this.handlers = handlers;
		socket.on("data", (chunk: Buffer) => this.onData(chunk));
		socket.on("error", () => this.finish());
		socket.on("close", () => this.finish());
	}

	/** Upgrade head 必须在 hub bind 后投喂，否则同包首个 subscribe 会丢失。 */
	acceptHead(head: Buffer): void {
		if (head.length > 0) this.onData(head);
	}

	private onData(chunk: Buffer): void {
		if (this.closed) return;
		let frames: WsFrame[];
		try {
			frames = this.parser.push(chunk);
		} catch (e) {
			const code = e instanceof WsProtocolError ? e.code : 1002;
			this.close(code, e instanceof Error ? e.message : "protocol-error");
			return;
		}
		for (const f of frames) {
			switch (f.opcode) {
				case OP_TEXT:
					try {
						this.handlers.onText?.(f.payload.toString("utf8"));
					} catch {
						/* handler 自兜；连接不断 */
					}
					break;
				case OP_PING:
					this.write(encodeFrame(OP_PONG, f.payload));
					break;
				case OP_PONG:
					try {
						this.handlers.onPong?.();
					} catch {
						/* ignore */
					}
					break;
				case OP_CLOSE:
					// 回 close 完成关闭握手，随后销毁
					if (!this.closeSent) this.write(encodeFrame(OP_CLOSE, f.payload.subarray(0, 125)));
					this.finish();
					return;
				default:
					break;
			}
		}
	}

	private write(buf: Buffer): boolean {
		if (this.closed) return false;
		try {
			return this.socket.write(buf);
		} catch {
			this.finish();
			return false;
		}
	}

	send(text: string): boolean {
		if (this.closed) return false;
		const payload = Buffer.from(text, "utf8");
		if (payload.length > MAX_PAYLOAD_BYTES) return false;
		return this.write(encodeFrame(OP_TEXT, payload));
	}

	ping(): boolean {
		if (this.closed) return false;
		this.write(encodeFrame(OP_PING, randomBytes(4)));
		return true;
	}

	close(code = 1000, reason = ""): void {
		if (this.closeSent || this.closed) {
			this.finish();
			return;
		}
		this.closeSent = true;
		const reasonBuf = Buffer.from(reason, "utf8").subarray(0, 123);
		const payload = Buffer.alloc(2 + reasonBuf.length);
		payload.writeUInt16BE(code, 0);
		reasonBuf.copy(payload, 2);
		this.write(encodeFrame(OP_CLOSE, payload));
		// 排空窗口后销毁（有界停机，学 ZCode close→drain→terminate）
		const s = this.socket;
		setTimeout(() => {
			try {
				s.destroy();
			} catch {
				/* ignore */
			}
		}, 250);
	}

	private finish(): void {
		if (this.closed) return;
		this.closed = true;
		try {
			this.socket.destroy();
		} catch {
			/* ignore */
		}
		try {
			this.handlers.onClose?.();
		} catch {
			/* ignore */
		}
	}
}

// ── 握手 + 认证（fail-closed）────────────────────────────────────

function sha256Hex(s: string): Buffer {
	return createHash("sha256").update(s, "utf8").digest();
}

/** 常数时间 token 比较（长度安全：先 sha256 归一）。 */
export function tokenMatches(presented: string | null, expected: string | null): boolean {
	if (expected === null || expected.length === 0) return false; // host 无 token → 全拒
	if (presented === null || presented.length === 0) return false;
	return timingSafeEqual(sha256Hex(presented), sha256Hex(expected));
}

export function parseCookieToken(cookieHeader: string | undefined): string | null {
	if (cookieHeader === undefined) return null;
	for (const part of cookieHeader.split(";")) {
		const eq = part.indexOf("=");
		if (eq < 0) continue;
		const name = part.slice(0, eq).trim();
		if (name === WS_COOKIE_NAME) {
			const value = part.slice(eq + 1).trim();
			return value.length > 0 ? value : null;
		}
	}
	return null;
}

function rawHttpResponse(socket: Duplex, status: number, statusText: string, body: Record<string, unknown>, extraHeaders: string[] = []): void {
	const payload = Buffer.from(JSON.stringify(body), "utf8");
	const lines = [
		`HTTP/1.1 ${status} ${statusText}`,
		"Content-Type: application/json",
		`Content-Length: ${payload.length}`,
		"Connection: close",
		...extraHeaders,
		"",
		"",
	];
	try {
		socket.end(lines.join("\r\n") + payload.toString("utf8"));
	} catch {
		/* ignore */
	}
	try {
		setTimeout(() => {
			try {
				socket.destroy();
			} catch {
				/* ignore */
			}
		}, 100);
	} catch {
		/* ignore */
	}
}

// ── 订阅 hub（两路 topic；per-sub cursor/projector）───────────────

type StreamTopicFrame =
	| { type: "ack"; topic: string; mode: "resume" | "snapshot"; head: { logEpoch: string; seq: number; gen: number } | null }
	| { type: "event"; topic: string; seq: number; envelope?: unknown; op?: TranscriptOp }
	| { type: "resync"; topic: string; head: null }
	| { type: "error"; topic: string | null; message: string };

interface JournalSub {
	kind: "journal";
	cursor: JournalSeqCursor;
}

interface TranscriptSub {
	kind: "transcript";
	sessionId: string;
	file: string;
	cursor: SessionTailCursor;
	projector: ReturnType<typeof createTranscriptProjector>;
}

type SubState = JournalSub | TranscriptSub;

function parseBase(x: unknown): { seq: number; logEpoch: string; gen?: number } {
	const b = typeof x === "object" && x !== null ? (x as Record<string, unknown>) : {};
	const seq = typeof b.seq === "number" && Number.isInteger(b.seq) && b.seq >= 0 ? b.seq : 0;
	const logEpoch = typeof b.logEpoch === "string" ? b.logEpoch : "";
	const gen = typeof b.gen === "number" && Number.isInteger(b.gen) && b.gen >= 0 ? b.gen : undefined;
	return { seq, logEpoch, gen };
}

export interface EventStreamOptions {
	/** host 启动生成的本机 token；null → 全部握手 401（fail-closed）。 */
	token: string | null;
	/** journal 路径（缺省 defaultJournalPath()）。 */
	journalPath?: string;
	/** pi sessions 根目录（缺省 defaultSessionsDir()）。 */
	sessionsDir?: string;
	/** live tail 轮询间隔 ms（缺省 250）。 */
	tailMs?: number;
	/** 服务端 ping 间隔 ms（缺省 30000；两拍无 pong 断开）。 */
	pingMs?: number;
}

/**
 * 挂载 `WS /v1/events/stream`：注册 server "upgrade" 监听（唯一升级路径；其余路径 404 destroy）。
 * 幂等防重（同一 server 只挂一次）。HTTP 路由零变化。
 */
export function attachEventStream(server: Server, opts: EventStreamOptions): void {
	const already = (server as unknown as { __swEventStreamAttached?: boolean }).__swEventStreamAttached;
	if (already) return;
	(server as unknown as { __swEventStreamAttached?: boolean }).__swEventStreamAttached = true;
	server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
		handleUpgrade(req, socket, head, opts);
	});
}

function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, opts: EventStreamOptions): void {
	try {
		let u: URL;
		try {
			u = new URL(req.url ?? "/", "http://127.0.0.1");
		} catch {
			rawHttpResponse(socket, 400, "Bad Request", { error: "bad-request" });
			return;
		}
		if (u.pathname !== WS_PATH) {
			// 升级路径仅此一条：其余 upgrade 一律 404
			rawHttpResponse(socket, 404, "Not Found", { error: "not-found", hint: `唯一升级路径 ${WS_PATH}` });
			return;
		}

		// ── 认证（101 之前，fail-closed）──
		const queryToken = u.searchParams.get("token");
		const cookieToken = parseCookieToken(req.headers.cookie);
		const presented = queryToken ?? cookieToken;
		if (!tokenMatches(presented, opts.token)) {
			rawHttpResponse(socket, 401, "Unauthorized", {
				error: "unauthorized",
				hint: "WS 需本机 token：?token= 或 Cookie sw_host_token（token 见 runtime 目录 host.json）",
			});
			return;
		}

		const key = req.headers["sec-websocket-key"];
		const version = req.headers["sec-websocket-version"];
		const upgrade = req.headers.upgrade;
		const connection = req.headers.connection;
		let validKey = false;
		try {
			validKey = typeof key === "string" && Buffer.from(key, "base64").length === 16;
		} catch {
			validKey = false;
		}
		if (
			typeof key !== "string" || !validKey || version !== "13" ||
			typeof upgrade !== "string" || upgrade.toLowerCase() !== "websocket" ||
			typeof connection !== "string" || !connection.toLowerCase().split(",").map((x) => x.trim()).includes("upgrade")
		) {
			rawHttpResponse(socket, 400, "Bad Request", { error: "bad-websocket-handshake" });
			return;
		}
		const accept = createHash("sha1").update(key + WS_GUID, "utf8").digest("base64");
		const headers = [
			"HTTP/1.1 101 Switching Protocols",
			"Upgrade: websocket",
			"Connection: Upgrade",
			`Sec-WebSocket-Accept: ${accept}`,
		];
		// token→HttpOnly cookie：?token= 首握后种 cookie，后续连接凭 cookie 免暴露 URL token
		if (queryToken !== null) {
			headers.push(`Set-Cookie: ${WS_COOKIE_NAME}=${queryToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`);
		}
		try {
			socket.write(headers.join("\r\n") + "\r\n\r\n");
		} catch {
			try {
				socket.destroy();
			} catch {
				/* ignore */
			}
			return;
		}

		const hub = new StreamHub(opts);
		const conn = new WsConn(socket, {
			onText: (text) => hub.onClientText(text),
			onPong: () => hub.onPong(),
			onClose: () => hub.dispose(),
		});
		hub.bind(conn);
		conn.acceptHead(head);
		hub.startKeepalive(opts.pingMs ?? 30_000);
	} catch {
		// 兜底：握手层任何意外不炸 host
		try {
			socket.destroy();
		} catch {
			/* ignore */
		}
	}
}

class StreamHub {
	private subs = new Map<string, SubState>();
	private conn: WsConn | null = null;
	private tailTimer: NodeJS.Timeout | null = null;
	private pingTimer: NodeJS.Timeout | null = null;
	private pongSeen = true;
	private disposed = false;
	private readonly opts: EventStreamOptions;

	constructor(opts: EventStreamOptions) {
		this.opts = opts;
		// conn 在 handleUpgrade 中构造后回填（构造顺序：WsConn 构造即注册 data 监听）
	}

	/** 由 handleUpgrade 在 new WsConn 后回填连接。 */
	bind(conn: WsConn): void {
		this.conn = conn;
	}

	startKeepalive(pingMs: number): void {
		this.pingTimer = setInterval(() => {
			if (this.disposed) return;
			if (!this.pongSeen) {
				// 两拍无 pong → 判死断开（防僵尸连接堆积）
				this.conn?.close(1001, "ping-timeout");
				this.dispose();
				return;
			}
			this.pongSeen = false;
			this.conn?.ping();
		}, pingMs);
		if (typeof this.pingTimer.unref === "function") this.pingTimer.unref();
	}

	onPong(): void {
		this.pongSeen = true;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.tailTimer !== null) clearInterval(this.tailTimer);
		if (this.pingTimer !== null) clearInterval(this.pingTimer);
		this.subs.clear();
	}

	// ── 客户端帧 ─────────────────────────────────────────────────

	onClientText(text: string): void {
		let msg: unknown;
		try {
			msg = JSON.parse(text);
		} catch {
			this.send({ type: "error", topic: null, message: "bad-json" });
			return;
		}
		const rec = typeof msg === "object" && msg !== null ? (msg as Record<string, unknown>) : null;
		if (rec === null || rec.type !== "subscribe") {
			this.send({ type: "error", topic: null, message: "expected {type:\"subscribe\", topic, base?}" });
			return;
		}
		const topic = typeof rec.topic === "string" ? rec.topic : "";
		if (topic.length === 0) {
			this.send({ type: "error", topic: null, message: "topic-required" });
			return;
		}
		if (!this.subs.has(topic) && this.subs.size >= MAX_SUBS_PER_CONN) {
			this.send({ type: "error", topic, message: `too-many-subscriptions（上限 ${MAX_SUBS_PER_CONN}）` });
			return;
		}
		const base = parseBase(rec.base);
		if (topic === "journal") {
			this.subscribeJournal(topic, base);
			return;
		}
		if (topic.startsWith("transcript:")) {
			const sid = topic.slice("transcript:".length);
			if (sid.length === 0 || /[/\\\s]/.test(sid)) {
				this.send({ type: "error", topic, message: "bad-session-id" });
				return;
			}
			this.subscribeTranscript(topic, sid, base);
			return;
		}
		this.send({ type: "error", topic, message: "unknown-topic（journal | transcript:<sessionId>）" });
	}

	private send(frame: StreamTopicFrame): boolean {
		try {
			const sent = this.conn?.send(JSON.stringify(frame)) ?? false;
			// socket.write(false) 表示 Node 写缓冲已满；继续 fan-out 会形成无界堆积。
			// P1 无可靠缓冲，断开后由 seq/epoch resume 安全补发。
			if (!sent) {
				this.conn?.close(1013, "backpressure");
				this.dispose();
			}
			return sent;
		} catch {
			return false;
		}
	}

	// ── journal 订阅 ─────────────────────────────────────────────

	private subscribeJournal(topic: string, base: { seq: number; logEpoch: string }): void {
		const journalPath = this.opts.journalPath ?? defaultJournalPath();
		const scan = scanJournalSeq(journalPath);
		// L4 判代：resume/subscribe 前校验 sidecar（同首行重写/轮转 → gen+1）
		const gen = validateStreamGen("journal", journalPath, scan.logEpoch);
		const head = { logEpoch: scan.logEpoch, seq: scan.head, gen };
		// bootstrap（logEpoch 空 = 客户端无先验状态）→ 全量重放 resume（journal 本身就是重放源）；
		// 非空且不符 = 跨代 → snapshot；gen 不符（同首行重写）→ snapshot；seq 越界 → snapshot
		const epochOk = base.logEpoch === "" || base.logEpoch === scan.logEpoch;
		const genOk = base.gen === undefined || base.gen === gen;
		if (epochOk && genOk && base.seq <= scan.head) {
			// 同代续传：补发 (base, head] 后转 live
			if (!this.send({ type: "ack", topic, mode: "resume", head })) return;
			for (const e of scan.entries) {
				if (e.seq > base.seq && !this.send({ type: "event", topic, seq: e.seq, envelope: e.envelope })) return;
			}
			this.subs.set(topic, { kind: "journal", cursor: { offset: scan.sizeBytes, nextLineNo: scan.head + 1 } });
		} else {
			// 跨代/越界/空 → snapshot：只回指针，且**不**激活 live tail。客户端必须先 GET
			// 新代全量，再带该 head 重订阅；否则 GET 期间的 live op 能与旧代 UI 行暂时拼接。
			// 重订阅的 (base, head] 回放补齐 GET 与订阅之间的竞态，故不会漏事件。
			this.send({ type: "ack", topic, mode: "snapshot", head: scan.exists ? head : null });
			return;
		}
		this.startTail();
	}

	// ── transcript 订阅（与 GET 端点同一投影函数）────────────────

	private subscribeTranscript(topic: string, sessionId: string, base: { seq: number; logEpoch: string }): void {
		const sessionsDir = this.opts.sessionsDir ?? defaultSessionsDir();
		const file = findSessionFile(sessionsDir, sessionId);
		if (file === null) {
			this.send({ type: "ack", topic, mode: "snapshot", head: null });
			return;
		}
		const proj = projectSessionOps(file, base.seq);
		// L4 判代：session 路同 journal（sidecar 按流键 session:<id>）
		const gen = validateStreamGen(`session:${sessionId}`, file, proj.logEpoch);
		const head = { logEpoch: proj.logEpoch, seq: proj.head, gen };
		const epochOk = base.logEpoch === proj.logEpoch && base.logEpoch !== "";
		const genOk = base.gen === undefined || base.gen === gen;
		if (epochOk && genOk && base.seq >= 1 && base.seq <= proj.head) {
			// 断线续传：重投影确定性回放 seq>base 的 op（不重不漏）
			if (!this.send({ type: "ack", topic, mode: "resume", head })) return;
			for (const o of proj.ops) if (!this.send({ type: "event", topic, seq: o.seq, op: o.op })) return;
		} else {
			// 首屏 / 跨代 / 越界 → snapshot：先 GET 新代全量、再带 head 重订阅。
			// 此处不能开始 live tail，否则 GET 期间的新 op 会暂时拼到旧代行上；重订阅回放
			// (base, head] 覆盖 GET→订阅窗口，既不混代也不漏。
			this.send({ type: "ack", topic, mode: "snapshot", head });
			return;
		}
		this.subs.set(topic, {
			kind: "transcript",
			sessionId,
			file,
			cursor: proj.cursor,
			projector: createTranscriptProjector(),
		});
		this.startTail();
	}

	// ── live tail（统一 tick；单连接一个定时器）──────────────────

	private startTail(): void {
		if (this.tailTimer !== null || this.disposed) return;
		const tailMs = this.opts.tailMs ?? 250;
		this.tailTimer = setInterval(() => this.tick(), tailMs);
		if (typeof this.tailTimer.unref === "function") this.tailTimer.unref();
	}

	private tick(): void {
		if (this.disposed) return;
		for (const [topic, sub] of this.subs) {
			try {
				if (sub.kind === "journal") this.tickJournal(topic, sub);
				else this.tickTranscript(topic, sub);
			} catch {
				// 单订阅故障不炸连接；下一 tick 重试
			}
		}
	}

	private tickJournal(topic: string, sub: JournalSub): void {
		const journalPath = this.opts.journalPath ?? defaultJournalPath();
		const r = readJournalTail(journalPath, sub.cursor);
		if (r.truncated) {
			this.subs.delete(topic);
			this.send({ type: "resync", topic, head: null });
			this.maybeStopTail();
			return;
		}
		sub.cursor = r.cursor;
		for (const e of r.entries) if (!this.send({ type: "event", topic, seq: e.seq, envelope: e.envelope })) return;
	}

	private tickTranscript(topic: string, sub: TranscriptSub): void {
		const r = readSessionTail(sub.file, sub.cursor);
		if (r.truncated) {
			this.subs.delete(topic);
			this.send({ type: "resync", topic, head: null });
			this.maybeStopTail();
			return;
		}
		sub.cursor = r.cursor;
		for (const l of r.lines) {
			for (const op of sub.projector.ingestEntry(l.entry, l.seq)) {
				if (!this.send({ type: "event", topic, seq: l.seq, op })) return;
			}
		}
	}

	private maybeStopTail(): void {
		if (this.subs.size === 0 && this.tailTimer !== null) {
			clearInterval(this.tailTimer);
			this.tailTimer = null;
		}
	}
}
// 延迟 import 已上提至头部（避免 server.ts ↔ ws.ts 环）
