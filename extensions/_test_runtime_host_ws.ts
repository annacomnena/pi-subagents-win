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
 *   T8 outbox 主题（G6-P2）：journal 过滤投影 + 续传 + 过滤正确性 + gen 判代 + WS 只读红线
 *   T9 双 client 异 base（G6-P3 多端附着 v1）：各自独立 base 续传互不干扰 + live fan-out 隔离
 *
 * 运行：npm run test:runtime-host-ws
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "host-ws-env-"));
process.env.PI_SESSIONS_DIR = mkdtempSync(join(tmpdir(), "host-ws-sessions-"));

import { createRuntimeHostServer, type RuntimeHostHandle } from "./runtime-host/server.ts";
import { newEventEnvelope } from "./runtime/envelope.ts";
import { masterAddress } from "./runtime/address.ts";
import { appendRuntimeEnvelope } from "./runtime/journal.ts";
import { applyTranscriptOps, type TranscriptOp, type TranscriptRow } from "./runtime/transcript.ts";
import { wsHandshake, isAck } from "./_test_ws_client.ts";

const ENV_DIR = process.env.PI_RUNTIME_DIR!;
const DIRS: string[] = [ENV_DIR, process.env.PI_SESSIONS_DIR!];

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

	// ── T8 outbox 主题（G6-P2）：journal 过滤投影 + 续传 + 过滤正确性 ──
	{
		// 种入混合类型：非 outbox 类型必须被过滤（journal 主题能看见、outbox 主题看不见）
		const mkTyped = (type: string, n: number) =>
			newEventEnvelope({ type, source: masterAddress(), payload: { n }, at: new Date(Date.parse("2026-09-22T11:00:00Z") + n * 1000).toISOString() });
		const journalLines = readFileSync(journalPath, "utf8").split("\n").filter((l) => l.trim().length > 0);
		const seqBase = journalLines.length; // 追加前的物理行数
		const journalEpoch = (JSON.parse(journalLines[0]!) as { id: string }).id; // logEpoch = 首 envelope id
		const q1 = mkTyped("message.queued", 1);
		const noise1 = mkTyped("run.completed", 2);
		const d1 = mkTyped("message.delivered", 3);
		appendRuntimeEnvelope(q1, journalPath);
		appendRuntimeEnvelope(noise1, journalPath);
		appendRuntimeEnvelope(d1, journalPath);

		const c = await wsHandshake(handle.info.port, wsPath(token!));
		assert.ok(c.ok);
		c.ws!.sendText(JSON.stringify({ type: "subscribe", topic: "outbox", base: {} }));
		const ack = await c.ws!.recvJson();
		assert.ok(isAck(ack) && (ack as any).mode === "resume", "outbox 首 subscribe → resume（journal 即重放源）");
		const f1 = await c.ws!.recvJson();
		const f2 = await c.ws!.recvJson();
		assert.ok(isEvent(f1) && (f1 as any).envelope.id === q1.id && (f1 as any).seq === seqBase + 1, "queued 帧到达（seq=journal 物理行号）");
		assert.ok(isEvent(f2) && (f2 as any).envelope.id === d1.id && (f2 as any).seq === seqBase + 3, "delivered 帧到达；run.completed 被过滤");
		const extra = await c.ws!.recvJson(300);
		assert.equal(extra, null, "重放精确（无过滤漏网帧）");

		// live：追加 failed + 噪声 → 只推 failed
		const failEv = mkTyped("message.failed", 4);
		appendRuntimeEnvelope(failEv, journalPath);
		appendRuntimeEnvelope(mkTyped("test.tick", 5), journalPath);
		const live = await c.ws!.recvJson();
		assert.ok(isEvent(live) && (live as any).envelope.id === failEv.id, "live failed 事件推送（噪声被滤）");
		c.ws!.destroy();

		// 断线重连：base={seq:13, logEpoch} → 只补发命中类型
		const c2 = await wsHandshake(handle.info.port, wsPath(token!));
		assert.ok(c2.ok);
		const doneEv = mkTyped("message.delivered", 6);
		appendRuntimeEnvelope(doneEv, journalPath);
		c2.ws!.sendText(JSON.stringify({ type: "subscribe", topic: "outbox", base: { seq: seqBase + 3, logEpoch: journalEpoch } }));
		const ack2 = await c2.ws!.recvJson();
		assert.ok(isAck(ack2) && (ack2 as any).mode === "resume");
		const b1 = await c2.ws!.recvJson();
		assert.ok(isEvent(b1) && (b1 as any).envelope.id === failEv.id, "续传补发含 live 期 failed（base 之后全部命中类型）");
		const b2 = await c2.ws!.recvJson();
		assert.ok(isEvent(b2) && (b2 as any).envelope.id === doneEv.id, "续传补发 delivered");
		const extra2 = await c2.ws!.recvJson(300);
		assert.equal(extra2, null, "续传精确（test.tick 被滤、无多余帧）");
		c2.ws!.destroy();

		// journal 主题不过滤（对照：同文件全部类型可见）
		const c3 = await wsHandshake(handle.info.port, wsPath(token!));
		assert.ok(c3.ok);
		c3.ws!.sendText(JSON.stringify({ type: "subscribe", topic: "journal", base: { seq: 0, logEpoch: "" } }));
		assert.ok(isAck(await c3.ws!.recvJson()));
		let sawNoise = false;
		for (let i = 0; i < 40; i += 1) {
			const f = await c3.ws!.recvJson(500);
			if (f === null) break;
			if (isEvent(f) && (f as any).envelope.id === noise1.id) {
				sawNoise = true;
				break;
			}
		}
		assert.ok(sawNoise, "journal 主题仍全量（过滤仅 outbox 主题）");
		c3.ws!.destroy();

		// T8a gen 判代（L4 必修 ④）：同首行重写 → 旧 base.gen 不符 → snapshot（outbox 与 journal 同机同语义）
		{
			const c4 = await wsHandshake(handle.info.port, wsPath(token!));
			assert.ok(c4.ok);
			c4.ws!.sendText(JSON.stringify({ type: "subscribe", topic: "outbox", base: {} }));
			const ack0 = (await c4.ws!.recvJson()) as any;
			assert.ok(isAck(ack0) && ack0.mode === "resume");
			const gen0: number = ack0.head.gen;
			const seq0: number = ack0.head.seq;
			assert.ok(Number.isInteger(gen0) && gen0 >= 1, "ack head.gen 存在（G6-P1 L4 持久代际）");
			for (let i = 0; i < 200; i += 1) {
				const drain = await c4.ws!.recvJson(200);
				if (drain === null) break;
			}
			c4.ws!.destroy();

			// 同首行重写（变长重写：保留首行 + 新 envelope，丢弃其余）→ validateStreamGen bump
			const lines = readFileSync(journalPath, "utf8").split("\n").filter((l) => l.trim().length > 0);
			const rewriteEv = mkTyped("message.queued", 9);
			writeFileSync(journalPath, `${lines[0]}\n${JSON.stringify(rewriteEv)}\n`, "utf8");

			const c5 = await wsHandshake(handle.info.port, wsPath(token!));
			assert.ok(c5.ok);
			c5.ws!.sendText(JSON.stringify({ type: "subscribe", topic: "outbox", base: { seq: seq0, logEpoch: journalEpoch, gen: gen0 } }));
			const ack1 = (await c5.ws!.recvJson()) as any;
			assert.ok(isAck(ack1) && ack1.mode === "snapshot", "旧 base.gen → snapshot（不误判同代续传）");
			assert.equal(ack1.head.gen, gen0 + 1, "服务端 bump gen");
			c5.ws!.destroy();

			// 新 gen 重订阅 → resume + 重放新代内容
			const c5b = await wsHandshake(handle.info.port, wsPath(token!));
			assert.ok(c5b.ok);
			c5b.ws!.sendText(JSON.stringify({ type: "subscribe", topic: "outbox", base: { seq: 0, logEpoch: journalEpoch, gen: gen0 + 1 } }));
			const ack2 = (await c5b.ws!.recvJson()) as any;
			assert.ok(isAck(ack2) && ack2.mode === "resume");
			const rb = await c5b.ws!.recvJson();
			assert.ok(isEvent(rb) && (rb as any).envelope.id === rewriteEv.id, "新代重放：重写后的 queued 可见");
			c5b.ws!.destroy();
		}

		// T8b WS-command 反向覆盖（L4 必修 ④）：客户端帧只接受 subscribe ——
		// {type:"command"} 只得 error 帧，零 executor/outbox/journal 副作用（WS 只读红线）
		{
			const countLines = (): number => readFileSync(journalPath, "utf8").split("\n").filter((l) => l.trim().length > 0).length;
			const stateDir = join(ENV_DIR, "state");
			const dirCount = (p: string): number => {
				try {
					return readdirSync(p).length;
				} catch {
					return 0;
				}
			};
			const journalBefore = countLines();
			const commandsBefore = dirCount(join(stateDir, "commands"));
			const outboxBefore = dirCount(join(stateDir, "message-outbox"));

			const c6 = await wsHandshake(handle.info.port, wsPath(token!));
			assert.ok(c6.ok);
			c6.ws!.sendText(JSON.stringify({ type: "command", commandKey: "ws-hack-1", to: masterAddress(), payload: { text: "bypass" } }));
			const err1 = await c6.ws!.recvJson();
			assert.ok(typeof err1 === "object" && err1 !== null && (err1 as any).type === "error", "command 帧 → error 帧");
			assert.equal((err1 as any).topic, null);
			c6.ws!.sendText(JSON.stringify({ type: "subscribe", topic: "outbox", base: {} }));
			assert.ok(isAck(await c6.ws!.recvJson()), "error 后连接仍可用（订阅照常）");
			c6.ws!.destroy();

			await new Promise((r) => setTimeout(r, 300)); // 静默窗：等潜在（不应存在的）副作用
			assert.equal(countLines(), journalBefore, "journal 零增长（WS command 无 executor 副作用）");
			assert.equal(dirCount(join(stateDir, "commands")), commandsBefore, "commands 盘面零变化（未占幂等键）");
			assert.equal(dirCount(join(stateDir, "message-outbox")), outboxBefore, "outbox 盘面零变化");
		}
	}

	// ── T9 双 client 异 base 续传隔离（G6-P3 多端附着 v1）：同一端点多 client 订阅互不干扰 ──
	{
		// 种基准：记录当前 journal 头（前序块已写入若干条）
		const lines0 = readFileSync(journalPath, "utf8").split("\n").filter((l) => l.trim().length > 0);
		const epoch9 = (JSON.parse(lines0[0]!) as { id: string }).id;
		const head9 = lines0.length;
		const mk = (n: number) =>
			newEventEnvelope({ type: "test.tick", source: masterAddress(), payload: { n }, at: new Date(Date.parse("2026-09-22T12:00:00Z") + n * 1000).toISOString() });

		// 预置两条（seq head9+1 / head9+2）：client A 从头补发、client B 从 head9+2 起
		const a1 = mk(1);
		const a2 = mk(2);
		appendRuntimeEnvelope(a1, journalPath);
		appendRuntimeEnvelope(a2, journalPath);

		const cA = await wsHandshake(handle.info.port, wsPath(token!));
		const cB = await wsHandshake(handle.info.port, wsPath(token!));
		assert.ok(cA.ok && cB.ok);
		// A：base 空 = 全量重放（基线：同一连接内 base 独立）；B：base = head9 → 只补 head9 之后的增量
		cA.ws!.sendText(JSON.stringify({ type: "subscribe", topic: "journal", base: {} }));
		const ackA = await cA.ws!.recvJson();
		assert.ok(isAck(ackA) && (ackA as any).mode === "resume");
		// 排干 A 的全量重放（应恰为 head9+2 条）
		const replayA: number[] = [];
		for (;;) {
			const f = await cA.ws!.recvJson(500);
			if (f === null) break;
			if (isEvent(f)) replayA.push((f as any).seq);
		}
		assert.equal(replayA.length, head9 + 2, "A 全量重放条数 = 当前头");
		assert.deepEqual(replayA, Array.from({ length: head9 + 2 }, (_, i) => i + 1), "A 重放 seq 连续不重不漏");

		cB.ws!.sendText(JSON.stringify({ type: "subscribe", topic: "journal", base: { seq: head9, logEpoch: epoch9 } }));
		const ackB = await cB.ws!.recvJson();
		assert.ok(isAck(ackB) && (ackB as any).mode === "resume", "B 同代续传 resume");
		const b1 = await cB.ws!.recvJson();
		const b2 = await cB.ws!.recvJson();
		assert.ok(isEvent(b1) && (b1 as any).seq === head9 + 1, "B 只补 base 之后的（不重：无 1..head9）");
		assert.ok(isEvent(b2) && (b2 as any).seq === head9 + 2);
		await (async () => { const q = await cB.ws!.recvJson(300); assert.equal(q, null, "B 补发精确止于 head"); })();

		// C 的非法 base 只令 C snapshot/resync，不改 A/B 各自已激活 cursor。
		const cR = await wsHandshake(handle.info.port, wsPath(token!));
		assert.ok(cR.ok);
		cR.ws!.sendText(JSON.stringify({ type: "subscribe", topic: "journal", base: { seq: head9 + 99, logEpoch: epoch9 } }));
		const ackR = await cR.ws!.recvJson();
		assert.ok(isAck(ackR) && (ackR as any).mode === "snapshot", "C 越界 base 独立进入 snapshot");
		cR.ws!.destroy();

		// live 追加一条 → 两个 cursor 独立推进，fan-out 各得一份同 seq 帧；C 的 resync 不影响它们
		const a3 = mk(3);
		appendRuntimeEnvelope(a3, journalPath);
		const la = await cA.ws!.recvJson();
		const lb = await cB.ws!.recvJson();
		assert.ok(isEvent(la) && (la as any).seq === head9 + 3, "A live 帧到达");
		assert.ok(isEvent(lb) && (lb as any).seq === head9 + 3, "B live 帧到达（cursor 独立）");
		assert.equal((la as any).envelope.id, (lb as any).envelope.id, "fan-out 同一事件两连接各一份");

		// 一端断开不影响另一端（互不干扰）：B 断开 → 再追加 → A 仍收到
		cB.ws!.destroy();
		const a4 = mk(4);
		appendRuntimeEnvelope(a4, journalPath);
		const la2 = await cA.ws!.recvJson();
		assert.ok(isEvent(la2) && (la2 as any).seq === head9 + 4, "B 断开后 A 仍独立收到 live 帧");
		cA.ws!.destroy();

		// 重连续传游标也各自独立：新 client C 从 A 断开处续传 → 只补 a4
		const cC = await wsHandshake(handle.info.port, wsPath(token!));
		assert.ok(cC.ok);
		cC.ws!.sendText(JSON.stringify({ type: "subscribe", topic: "journal", base: { seq: head9 + 3, logEpoch: epoch9 } }));
		const ackC = await cC.ws!.recvJson();
		assert.ok(isAck(ackC) && (ackC as any).mode === "resume");
		const r1 = await cC.ws!.recvJson();
		assert.ok(isEvent(r1) && (r1 as any).seq === head9 + 4 && (r1 as any).envelope.id === a4.id, "C 从自己 base 精确补发");
		const qc = await cC.ws!.recvJson(300);
		assert.equal(qc, null, "C 补发精确止于 head");
		cC.ws!.destroy();
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
