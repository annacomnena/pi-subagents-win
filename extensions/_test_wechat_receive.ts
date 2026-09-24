/**
 * _test_wechat_receive.ts — 0924 微信 iLink 接收 W1（只收不投）离线单测
 *
 * 运行：npx tsx extensions/_test_wechat_receive.ts（零新增依赖；**临时 runtimeDir**，绝不碰真实
 * ~/.pi/agent/runtime——规格 §5/§8 硬约束）。
 *
 * 六组断言（规格 §5.1–§5.6）：
 *   R1  stub getupdates 各分支：空批推进游标 / 混合批（2 文本+1 非文本 quarantine）/ ret≠0 /
 *       坏 JSON / 429+Retry-After / 超时 → 游标、quarantine 计数、退避序列（纯函数）、状态迁移；
 *       附 client 分类面与 parser 纯函数边界（控制符剥离/截断/缺 id 不伪造）。
 *   R2  崩溃点重放：commitBatch 前注入异常 → 重启（新 worker 实例）重拉同一 buf →
 *       claimMessage 幂等 → 重复 msgId 只落一条 inbox（store 级 + worker 级）。
 *   R2b MF1 复检：putInbox 注入失败 → 同 buf 重放 → claim 墓碑不吞消息（materialized=false
 *       → 幂等补写恰好一条；补写失败期间游标绝不推进；真重复不重复落盘/计数）。
 *   R3  游标顺序：commitBatch 之前 inbox 文件已在盘（包装 store 的顺序记录验证 §4.2）。
 *   R4  秘密卫生：哨兵 bot_token/context_token 扫描测试产生的全部文件 + 捕获 stdout/stderr +
 *       错误对象序列化 + 两个只读端点响应体 → **0 命中**（credentials.json 合法持有除外）。
 *   R5  opt-in OFF 零行为变化：receive.enabled=false → 不 spawn、无 inbox/cursor 文件、
 *       stub 服务端 getupdates 请求数 = 0；端点鉴权 401（无/错 token）；MF2：两个只读
 *       端点 403（鉴权后 receive 闸；零副作用）。
 *   R6  daemon 停机回收：supervisor 真子进程 spawn → stub 收到 getupdates → dispose() 后
 *       pid 消失（有界等待）+ worker.json pid 文件清理；残留 pid 文件识别；MF3：kill 超时
 *       仍活 → 保留 pid 文件、不误判退出。
 */

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// 测试隔离：PI_RUNTIME_DIR 先指到临时目录再 import（懒加载默认路径全部生效；bind 测试同模式）
process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "wechat-recv-test-env-")).replace(/[\\/]+$/, "");

import { createRuntimeHostServer, type RuntimeHostHandle } from "./runtime-host/server.ts";
import { ChannelSupervisor } from "./runtime-host/channel-supervisor.ts";
import { isProcessAlive } from "./runtime-host/discovery.ts";
import {
	readWechatCreds,
	readWechatEnabled,
	readWechatReceiveEnabled,
	wechatCredsPath,
	writeWechatCreds0600,
	type WechatFetch,
} from "./runtime-host/wechat-bind.ts";
import { getUpdates, newUin, WechatIlinkError } from "./channel-wechat/client.ts";
import { INBOUND_TEXT_MAX_CHARS, parseBatch, sanitizeInboundText } from "./channel-wechat/parser.ts";
import { WechatStore, type InboundRecord, type MessageClaim } from "./channel-wechat/store.ts";
import { backoffDelayMs, startWechatWorker, type WechatWorkerHandle } from "./channel-wechat/worker.ts";

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

function jsonRes(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** fake fetch（signal 感知；挂起型 handler 供超时/abort 路径）。 */
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
		await new Promise((r) => setTimeout(r, 25));
	}
}

/** 递归收集目录下全部文件内容（秘密卫生扫描用）。 */
function walkFiles(dir: string): { path: string; body: string }[] {
	const out: { path: string; body: string }[] = [];
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return out;
	}
	for (const name of entries) {
		const p = join(dir, name);
		let st;
		try {
			st = statSync(p);
		} catch {
			continue;
		}
		if (st.isDirectory()) out.push(...walkFiles(p));
		else {
			try {
				out.push({ path: p, body: readFileSync(p, "utf8") });
			} catch {
				/* 二进制/占用跳过 */
			}
		}
	}
	return out;
}

// ── stub iLink getupdates HTTP 服务（真子进程集成用；计数）──────────

interface StubIlink {
	port: number;
	getupdatesCount: () => number;
	close: () => Promise<void>;
}

async function startStubIlink(): Promise<StubIlink> {
	let count = 0;
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const u = new URL(req.url ?? "/", "http://127.0.0.1");
		if (u.pathname === "/ilink/bot/getupdates") {
			count += 1;
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ ret: 0, buf: `stub-buf-${count}`, item_list: [] }));
			return;
		}
		res.statusCode = 404;
		res.end("nf");
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
	const addr = server.address();
	const port = typeof addr === "object" && addr !== null ? addr.port : 0;
	return { port, getupdatesCount: () => count, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function writeFixtureConfig(path: string, wechat: Record<string, unknown>): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ channels: { wechat } }, null, 2)}\n`, "utf8");
}

function writeFixtureCreds(rt: string, baseUrl: string, token: string): void {
	writeWechatCreds0600(wechatCredsPath(rt), { botToken: token, boundAt: new Date().toISOString(), baseUrl });
}

/** item 构造（含哨兵 context_token——parser 必须丢弃）。 */
function mkItem(msgId: string, text: string | null, opts: { type?: string; size?: number } = {}): Record<string, unknown> {
	const contentItem = text !== null ? { type: "text", text } : { type: opts.type ?? "image", ...(opts.size !== undefined ? { size: opts.size } : {}) };
	return { id: msgId, msg: { from: { id: `wx_from_${msgId}`, nickname: `昵称_${msgId}` }, context_token: "SENTINEL_CTX_42", item_list: [contentItem] } };
}

// ── R1 stub getupdates 各分支 + 纯函数边界 ─────────────────────────

async function r1(): Promise<void> {
	const dir = mkdtemp("wechat-r1-");
	try {
		// a) client 分类面（直调真 getUpdates + fake fetch）
		{
			const cases: { body: unknown; status: number; headers?: Record<string, string>; kind: string; text?: string }[] = [
				{ body: { ret: 0, buf: "b", item_list: [] }, status: 200, kind: "ok" },
				{ body: { ret: 7, errmsg: "boom" }, status: 200, kind: "protocol" },
				{ body: "{not json", status: 200, kind: "protocol" },
				{ body: { ret: 0, item_list: [] }, status: 200, kind: "protocol" },
				{ body: { msg: "no" }, status: 401, kind: "auth" },
				{ body: { msg: "no" }, status: 403, kind: "auth" },
				{ body: { msg: "slow" }, status: 429, headers: { "retry-after": "1" }, kind: "rate_limited" },
				{ body: { msg: "down" }, status: 503, kind: "transient" },
			];
			for (const c of cases) {
				const impl = fakeFetch(() => jsonRes(c.body, c.status, c.headers));
				if (c.kind === "ok") {
					const r = await getUpdates({ baseUrl: "https://stub.example", botToken: "T", buf: "x" }, impl);
					assert.equal(r.buf, "b");
					assert.deepEqual(r.items, []);
				} else {
					await assert.rejects(
						() => getUpdates({ baseUrl: "https://stub.example", botToken: "T", buf: "x" }, impl),
						(e: unknown) => e instanceof WechatIlinkError && e.kind === c.kind,
						`HTTP ${c.status} → ${c.kind}`,
					);
				}
			}
			// 429 Retry-After 折算
			await assert.rejects(
				() => getUpdates({ baseUrl: "https://s", botToken: "T", buf: "" }, fakeFetch(() => jsonRes({}, 429, { "retry-after": "2" }))),
				(e: unknown) => e instanceof WechatIlinkError && e.kind === "rate_limited" && e.retryAfterMs === 2000,
			);
			// 超时（挂起 fetch + 100ms 超时）→ transient（消息不含 token）。挂起面用 ref'd timer
			// 保活（真实 socket 语义；bind 测试 t1f 同款）——空事件循环下 client 的 unref 超时才可靠触发。
			const hangingFetch: WechatFetch = (_u, init) =>
				new Promise<Response>((resolve, reject) => {
					const t = setTimeout(() => resolve(jsonRes({})), 5000); // ref'd 保活（真实 socket 语义）
					const sig = init?.signal ?? null;
					const onAbort = (): void => {
						clearTimeout(t);
						reject(new DOMException("aborted", "AbortError"));
					};
					if (sig !== null) {
						if (sig.aborted) onAbort();
						else sig.addEventListener("abort", onAbort, { once: true });
					}
				});
			await assert.rejects(
				() => getUpdates({ baseUrl: "https://s", botToken: "SENTINEL_TOKEN_9f", buf: "", timeoutMs: 100 }, hangingFetch),
				(e: unknown) => e instanceof WechatIlinkError && e.kind === "transient" && !e.message.includes("SENTINEL"),
			);
		}
		// b) UIN：非零、base64 解出为纯数字
		for (let i = 0; i < 8; i++) {
			const n = Number(Buffer.from(newUin(), "base64").toString("utf8"));
			assert.ok(Number.isInteger(n) && n >= 1 && n <= 4294967295, `uin ∈ [1, 4294967295]（got ${n}）`);
		}
		// c) parser 纯函数：控制符剥离 / 截断 / 缺 id 不伪造 / 附件 artifact_pending
		{
			assert.equal(sanitizeInboundText("a\u0000b\u0008c\td\ne"), "a\u0000b\u0008c\td\ne".replace(/[\u0000\u0008]/g, ""), "Cc 剥离（保留 \\t\\n）");
			const long = "x".repeat(INBOUND_TEXT_MAX_CHARS + 100);
			assert.ok(parseBatch([mkItem("m1", long)], "t0").items[0]!.text.length <= INBOUND_TEXT_MAX_CHARS + 32, "超长截断+标注");
			const noId = parseBatch([{ msg: { from: { id: "f" }, item_list: [{ type: "text", text: "hi" }] } }], "t0");
			assert.equal(noId.items.length, 0);
			assert.equal(noId.quarantined[0]!.msgId, null, "缺 id → quarantine msgId=null（不伪造）");
			const att = parseBatch([mkItem("m2", null, { type: "image", size: 12345 })], "t0");
			assert.equal(att.items.length, 0);
			assert.equal(att.quarantined[0]!.artifactPending, true, "附件 → artifact_pending");
			assert.ok(!att.quarantined[0]!.reason.includes("SENTINEL"), "quarantine reason 脱敏");
		}
		// d) worker 各分支（真 store + stub fetchUpdates；小间隔/小退避加速）
		const store = new WechatStore(WechatStore.resolveDir(dir));
		const errSeen: unknown[] = [];
		const fetchLog: string[] = [];
		const mkWorker = (script: () => unknown, extra: Record<string, unknown> = {}) =>
			startWechatWorker({
				baseUrl: "https://stub.example",
				botToken: "T0",
				store,
				fetchUpdates: async (req) => {
					fetchLog.push(req.buf);
					const v = script();
					if (v instanceof WechatIlinkError) {
						errSeen.push(v);
						throw v;
					}
					return v as { buf: string; items: unknown[] };
				},
				pollGapMs: 5,
				backoffStartMs: 20,
				backoffMaxMs: 80,
				rateLimitDefaultMs: 60,
				...extra,
			});
		// d1) 空批也推进游标（b1 → b2）
		{
			let i = 0;
			const w = mkWorker(() => [{ buf: "b1", items: [] }, { buf: "b2", items: [] }][Math.min(i++, 1)]);
			await waitFor(() => store.getCursor().lastBuf === "b2", 3000, "空批游标 b2");
			await w.stop();
			assert.ok(store.getCursor().epoch >= 2, `空批也推进游标（epoch≥2，实际 ${store.getCursor().epoch}）`);
			assert.equal(store.readState().counts.polls >= 2, true, "polls 计数");
		}
		// d2) 混合批：2 文本 + 1 非文本
		{
			const before = store.readState().counts.quarantined;
			let done = false;
			const w = mkWorker(() => (done ? { buf: "b3", items: [] } : ((done = true), { buf: "b3", items: [mkItem("m1", "你好"), mkItem("m2", "第二条"), mkItem("m3", null, { type: "image" })] })));
			await waitFor(() => store.readInbox(0).length === 2, 3000, "2 条 inbox");
			await w.stop();
			assert.equal(store.readState().counts.quarantined - before, 1, "非文本 quarantine 计数 +1");
			const texts = store.readInbox(0).map((r) => r.text).sort();
			assert.deepEqual(texts, ["你好", "第二条"]);
			assert.equal(store.readState().counts.received >= 2, true);
		}
		// d3) ret≠0 / 坏 JSON → protocol，游标不推进 + 退避序列（纯函数）+ 状态迁移
		{
			assert.deepEqual([1, 2, 3, 7, 8].map((n) => backoffDelayMs(n, 5000, 300000)), [10000, 20000, 40000, 300000, 300000], "退避序列 5s 起指数封顶 5min");
			let i = 0;
			const w = mkWorker(() => {
				i += 1;
				if (i <= 2) return new WechatIlinkError("protocol", "stub ret≠0");
				return { buf: "b4", items: [] };
			});
			await waitFor(() => store.readState().counts.protocolErrors >= 2, 3000, "protocol 错误计数");
			assert.equal(store.getCursor().lastBuf, "b3", "protocol 期间游标不动");
			await waitFor(() => store.getCursor().lastBuf === "b4", 4000, "退避后恢复推进");
			await w.stop();
		}
		// d4) 429 honor Retry-After（retryAfterMs=80 后恢复）
		{
			let i = 0;
			const w = mkWorker(() => {
				i += 1;
				if (i === 1) return new WechatIlinkError("rate_limited", "stub 429", { retryAfterMs: 80 });
				return { buf: "b5", items: [] };
			});
			await waitFor(() => store.getCursor().lastBuf === "b5", 3000, "429 后按 Retry-After 恢复");
			assert.equal(store.readState().counts.rateLimited, 1);
			await w.stop();
		}
		// d5) auth → auth_required + 停 poll（fetch 冻结）+ 退避后仍停
		{
			let calls = 0;
			const w = mkWorker(() => {
				calls += 1;
				if (calls <= 1) return { buf: "b6", items: [] };
				return new WechatIlinkError("auth", "stub 401");
			});
			await waitFor(() => store.readState().status === "auth_required", 3000, "auth_required");
			assert.equal(w.ended(), true, "循环终结");
			const frozen = calls;
			await new Promise((r) => setTimeout(r, 250));
			assert.equal(calls, frozen, "auth 后不再发起 poll（绝不风暴）");
			assert.ok(store.readState().authRequiredAt !== null, "持久告警时间戳");
			await w.stop();
			assert.equal(store.readState().status, "auth_required", "stop 不改写 auth_required 终态");
		}
		// d6) 状态迁移链：polling → connected（成功）→ disconnected（stop）
		{
			const s2 = new WechatStore(WechatStore.resolveDir(mkdtemp("wechat-r1f-")));
			let n = 0;
			const w = startWechatWorker({ baseUrl: "https://s", botToken: "T", store: s2, fetchUpdates: async () => ({ buf: `x${++n}`, items: [] }), pollGapMs: 5 });
			await waitFor(() => s2.readState().status === "connected", 3000, "connected");
			await w.stop();
			assert.equal(s2.readState().status, "disconnected", "stop → disconnected");
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ── R2 崩溃点重放（commit 前异常 → 重启重拉同 buf → 只落一条）────────

async function r2(): Promise<void> {
	const dir = mkdtemp("wechat-r2-");
	try {
		const batch = [mkItem("c1", "第一条"), mkItem("c2", "第二条")];
		// a) store 级：claim 跨实例幂等 + MF1 语义（fresh / materialized 分离）
		{
			const sub = join(dir, "a");
			const s1 = new WechatStore(sub);
			assert.equal(s1.claimMessage("c1").fresh, true, "首次 claim fresh=true");
			const s2 = new WechatStore(sub); // 新实例（=重启）
			const dup = s2.claimMessage("c1");
			assert.equal(dup.fresh, false, "重启后重放同 msgId → fresh=false");
			assert.equal(dup.materialized, false, "claim 已持久化但 inbox 未落 → materialized=false（MF1 补写信号）");
			s2.putInbox({ msgId: "c1", fromId: "f1", fromNickname: null, text: "t", receivedAt: new Date().toISOString(), state: "pending" });
			const dup2 = new WechatStore(sub).claimMessage("c1");
			assert.equal(dup2.fresh, false, "落盘后再重放 → 仍非 fresh");
			assert.equal(dup2.materialized, true, "落盘后重放 → materialized=true（真重复，跳过）");
		}
		// b) worker 级：worker A 在 commitBatch 前崩溃（异常注入）→ worker B 重拉同批 → 不重复落 inbox
		const realStore = new WechatStore(WechatStore.resolveDir(dir));
		const boom = { armed: true };
		const order: string[] = [];
		const storeA = new Proxy(realStore, {
			get(target, prop, receiver) {
				if (prop === "commitBatch") {
					return (prevBuf: string, nextBuf: string, recs: InboundRecord[]): void => {
						if (boom.armed) {
							order.push("commit:THROW");
							throw new Error("注入崩溃：commit 前断电");
						}
						order.push("commit:OK");
						return target.commitBatch(prevBuf, nextBuf, recs);
					};
				}
				const v = Reflect.get(target, prop, target);
				if (prop === "claimMessage" || prop === "putInbox") {
					return (msgIdOrRec: string | InboundRecord, ...rest: unknown[]): unknown => {
						if (prop === "claimMessage") {
							order.push(`claim:${msgIdOrRec}`);
							return target.claimMessage(msgIdOrRec as string);
						}
						order.push(`put:${(msgIdOrRec as InboundRecord).msgId}`);
						return (target.putInbox as (r: InboundRecord) => void)(msgIdOrRec as InboundRecord);
					};
				}
				return typeof v === "function" ? v.bind(target) : v;
			},
		});
		// worker A：同批落盘后 commit 抛 → 退避；停掉 A（= 崩溃重启）
		const wA = startWechatWorker({ baseUrl: "https://s", botToken: "T", store: storeA, fetchUpdates: async () => ({ buf: "rb1", items: batch }), pollGapMs: 5, backoffStartMs: 400, backoffMaxMs: 400 });
		await waitFor(() => order.includes("commit:THROW"), 3000, "A 触发 commit 崩溃");
		assert.equal(realStore.readInbox(0).length, 2, "崩溃前 inbox 已落 2 条（顺序不变量）");
		assert.equal(realStore.getCursor().lastBuf, "", "崩溃点游标未推进");
		await wA.stop();
		// worker B（新实例、同目录、同 buf 重拉同批）：claim=false ×2 → 不重复落 inbox → commit OK
		const wB = startWechatWorker({ baseUrl: "https://s", botToken: "T", store: realStore, fetchUpdates: async () => ({ buf: "rb1x", items: batch }), pollGapMs: 5 });
		await waitFor(() => realStore.getCursor().lastBuf === "rb1x", 3000, "B 提交新游标");
		await wB.stop();
		assert.equal(realStore.readInbox(0).length, 2, "重放去重：仍只有 2 条 inbox（只落一条/消息）");
		assert.equal(realStore.readState().counts.received, 2, "received 只计 2");
		assert.equal(realStore.readState().counts.dedupeSkipped >= 2, true, "重放 2 条被去重跳过");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ── R2b MF1 复检：putInbox 失败 → claim 墓碑不吞消息（同 buf 重放恰好一条）──

async function r2b(): Promise<void> {
	const dir = mkdtemp("wechat-r2b-");
	try {
		const batch = [mkItem("mf1a", "A 消息"), mkItem("mf1b", "B 消息")];
		const realStore = new WechatStore(WechatStore.resolveDir(dir));
		let putFail = true;
		let putAttempts = 0;
		const proxied = new Proxy(realStore, {
			get(target, prop) {
				if (prop === "putInbox") {
					return (rec: InboundRecord): void => {
						putAttempts += 1;
						if (putFail) throw new Error("注入故障：putInbox 写入失败（模拟磁盘满/权限）");
						return target.putInbox(rec);
					};
				}
				const v = Reflect.get(target, prop, target);
				return typeof v === "function" ? v.bind(target) : v;
			},
		});
		// worker A：claim 持久化成功 → putInbox 失败 → 退避重试同 buf；补写失败期间游标绝不推进
		const wA = startWechatWorker({ baseUrl: "https://s", botToken: "T", store: proxied, fetchUpdates: async () => ({ buf: "fb1", items: batch }), pollGapMs: 5, backoffStartMs: 20, backoffMaxMs: 40 });
		await waitFor(() => putAttempts >= 3, 5000, "putInbox 注入失败 ≥3 次（退避重试同 buf）");
		assert.equal(realStore.getCursor().lastBuf, "", "MF1：补写失败期间游标不得推进");
		assert.equal(realStore.readInbox(0).length, 0, "消息未在盘（claim 墓碑 + inbox 缺失共存）");
		// MF1 断言修正（0924，主会话）：worker 是**逐条** claim→putInbox，首条写入失败即中止本批
		// （fail-closed：不提交游标、退避重试同 buf）。因此墓碑数取决于“处理到第几条”，
		// 不应硬编码 = batch.length —— 那是在假设“先 claim 全批再写”的实现契约。
		// 真正的不变量是：①不得出现未 claim 却存在墓碑的幽灵 id；②重放后每条恰好 materialize 一次
		// （由本函数后半段的 final 断言保证）。
		assert.ok(
			realStore.dedupeSize() >= 1 && realStore.dedupeSize() <= batch.length,
			`MF1：墓碑数应在 [1, ${batch.length}]（已处理到的消息才留墓碑；实测 ${realStore.dedupeSize()}）`,
		);
		assert.equal(realStore.readState().counts.received, 0, "received 未计数");
		// 崩溃重启（新 worker 实例），故障消失：同 buf 重放 → 幂等补写 → 恰好一条
		await wA.stop();
		const wB = startWechatWorker({ baseUrl: "https://s", botToken: "T", store: realStore, fetchUpdates: async () => ({ buf: "fb1", items: batch }), pollGapMs: 5 });
		await waitFor(() => realStore.getCursor().lastBuf === "fb1", 5000, "补写成功后游标才推进");
		await wB.stop();
		const all = realStore.readInbox(0);
		assert.equal(all.length, 2, "最终恰好 2 条 inbox（不丢）");
		for (const m of ["mf1a", "mf1b"]) {
			assert.equal(all.filter((r) => r.msgId === m).length, 1, `${m} 恰好一条（不丢、不重复）`);
		}
		assert.equal(realStore.readState().counts.received, 2, "received 恰好计 2（补写不重复计数）");
		// 再重放同批（materialized=true 真重复）：不重复落盘/计数
		const wC = startWechatWorker({ baseUrl: "https://s", botToken: "T", store: realStore, fetchUpdates: async () => ({ buf: "fb2", items: batch }), pollGapMs: 5 });
		await waitFor(() => realStore.getCursor().lastBuf === "fb2", 5000, "真重复批提交");
		await wC.stop();
		assert.equal(realStore.readInbox(0).length, 2, "真重复仍 2 条（materialized=true 跳过）");
		assert.equal(realStore.readState().counts.received, 2, "received 仍 2");
		// MF1 收敛（0924，主会话）：去重容量裁剪后老 id 会被当成 fresh，但 inbox 文件仍在盘
		// ⇒ 计数必须来自“是否真的新写入”（putInbox 返回新建与否），不得由 claim 推断，
		// 否则 received 会被重复计数（L4 收敛轮指出的反向缺陷）。
		const trimmed = new WechatStore(WechatStore.resolveDir(dir), { maxDedupeEntries: 2 });
		assert.equal(trimmed.claimMessage("mf1c").fresh, true, "触发容量裁剪的新 id");
		const wD = startWechatWorker({ baseUrl: "https://s", botToken: "T", store: trimmed, fetchUpdates: async () => ({ buf: "fb3", items: [mkItem("mf1a", "A 消息")] }), pollGapMs: 5 });
		await waitFor(() => trimmed.getCursor().lastBuf === "fb3", 5000, "裁剪后老 id 重放批提交");
		await wD.stop();
		assert.equal(trimmed.readInbox(0).length, 2, "裁剪后重放：仍 2 条 inbox（不重复落盘）");
		assert.equal(trimmed.readState().counts.received, 2, "裁剪后重放：received 不重复计数（仍 2）");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ── R3 游标顺序（commit 之前 inbox 已在盘）──────────────────────────

async function r3(): Promise<void> {
	const dir = mkdtemp("wechat-r3-");
	try {
		const real = new WechatStore(WechatStore.resolveDir(dir));
		const seq: string[] = [];
		let inboxCountAtCommit = -1;
		const proxied = new Proxy(real, {
			get(target, prop) {
				if (prop === "commitBatch") {
					return (prevBuf: string, nextBuf: string, recs: InboundRecord[]): void => {
						inboxCountAtCommit = target.readInbox(0).length; // commit 时刻盘上 inbox 条数
						seq.push(`commit(${recs.length})`);
						return target.commitBatch(prevBuf, nextBuf, recs);
					};
				}
				if (prop === "putInbox") {
					return (rec: InboundRecord): void => {
						seq.push(`put:${rec.msgId}`);
						return target.putInbox(rec);
					};
				}
				if (prop === "claimMessage") {
					return (m: string): MessageClaim => {
						seq.push(`claim:${m}`);
						return target.claimMessage(m);
					};
				}
				const v = Reflect.get(target, prop, target);
				return typeof v === "function" ? v.bind(target) : v;
			},
		});
		let sent = false;
		const w = startWechatWorker({
			baseUrl: "https://s",
			botToken: "T",
			store: proxied,
			fetchUpdates: async () => {
				if (sent) return { buf: "done", items: [] };
				sent = true;
				return { buf: "o1", items: [mkItem("s1", "one"), mkItem("s2", "two")] };
			},
			pollGapMs: 5,
		});
		await waitFor(() => real.getCursor().lastBuf === "done", 3000, "R3 流程完成");
		await w.stop();
		assert.equal(inboxCountAtCommit, 2, "commitBatch 执行时 inbox 文件已在盘（§4.2 先落盘后提交）");
		assert.ok(seq.indexOf("put:s2") < seq.findIndex((s) => s.startsWith("commit")), "顺序：put 全部先于 commit");
		assert.ok(seq.indexOf("claim:s1") < seq.indexOf("put:s1"), "顺序：claim 先于 put（去重前置 §4.3）");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ── R4 秘密卫生（哨兵 0 命中）───────────────────────────────────────

async function r4(): Promise<void> {
	const stub = await startStubIlink(); // MF2 后端点 200 需 receive 闸开 → 真子进程轮询 stub（无害）
	const dir = mkdtemp("wechat-r4-");
	let h: RuntimeHostHandle | null = null;
	const captured: string[] = [];
	const origLog = console.log;
	const origErr = console.error;
	console.log = ((...a: unknown[]) => void captured.push(a.map(String).join(" "))) as typeof console.log;
	console.error = ((...a: unknown[]) => void captured.push(a.map(String).join(" "))) as typeof console.error;
	try {
		const TOK = "SENTINEL_TOKEN_9f";
		writeFixtureConfig(join(dir, "config.json"), { enabled: true, receive: { enabled: true } });
		writeFixtureCreds(dir, "https://stub.example", TOK);
		const rt = join(dir, "wechat-rt");
		mkdirSync(rt, { recursive: true });
		writeFixtureCreds(rt, `http://127.0.0.1:${stub.port}`, TOK);
		h = await createRuntimeHostServer({
			hostPath: join(dir, "host.json"),
			timersDir: join(dir, "timers"),
			stateDir: join(dir, "state"),
			mailboxDir: join(dir, "m"),
			journalPath: join(dir, "events.jsonl"),
			sessionsDir: join(dir, "sessions"),
			lockWaitMs: 500,
			configPath: join(dir, "config.json"),
			wechatRuntimeDir: rt,
		} as Parameters<typeof createRuntimeHostServer>[0]);
		// 直接往私有 store 灌一批带哨兵 context_token 的记录（worker 侧已测；这里测端点/文件面）
		const store = new WechatStore(WechatStore.resolveDir(rt));
		const parsed = parseBatch([mkItem("sec1", "内容 A"), mkItem("sec2", null, { type: "file", size: 9 }), mkItem("sec3", "长".repeat(400))], new Date().toISOString());
		for (const it of parsed.items) {
			assert.equal(store.claimMessage(it.msgId).fresh, true);
			store.putInbox({ ...it, state: "pending" });
		}
		for (const q of parsed.quarantined) store.recordQuarantine(q);
		store.commitBatch("", "sb1", []);
		// 错误对象序列化面：真 client 抛错（带哨兵 token 调用）
		const errTexts: string[] = [];
		const hangingFetch2: WechatFetch = (_u, init) =>
			new Promise<Response>((resolve, reject) => {
				const t = setTimeout(() => resolve(jsonRes({})), 5000); // ref'd 保活（真实 socket 语义）
				const sig = init?.signal ?? null;
				const onAbort = (): void => {
					clearTimeout(t);
					reject(new DOMException("aborted", "AbortError"));
				};
				if (sig !== null) {
					if (sig.aborted) onAbort();
					else sig.addEventListener("abort", onAbort, { once: true });
				}
			});
		try {
			await getUpdates({ baseUrl: "https://stub.example", botToken: TOK, buf: "", timeoutMs: 80 }, hangingFetch2);
		} catch (e) {
			errTexts.push(JSON.stringify(e), e instanceof Error ? e.message : "", String(e));
		}
		// 端点响应体
		const base = `http://127.0.0.1:${h.info.port}`;
		const H = { "x-command-token": h.info.token };
		const bodies: string[] = [];
		for (const p of ["/v1/wechat/worker/status", "/v1/wechat/inbox?limit=10", "/v1/wechat/bind/status"]) {
			const res = await fetch(`${base}${p}`, { headers: H });
			bodies.push(await res.text());
		}
		// 扫描（L4 §③ 扩面）：本测试产生的**全部文件**（整个临时 runtimeDir 树；credentials.json
		// 为合法持有例外）+ 捕获输出 + 错误序列化 + 端点响应 → 哨兵 0 命中
		const scanned = [
			...walkFiles(dir).filter((f) => !f.path.endsWith(join("wechat", "credentials.json"))),
			...captured.map((c, i) => ({ path: `console:${i}`, body: c })),
			...errTexts.map((t, i) => ({ path: `err:${i}`, body: t })),
			...bodies.map((t, i) => ({ path: `http:${i}`, body: t })),
		];
		const hits = scanned.filter((f) => f.body.includes("SENTINEL_TOKEN_9f") || f.body.includes("SENTINEL_CTX_42"));
		assert.deepEqual(hits.map((x) => x.path), [], "秘密卫生：哨兵 0 命中（§4.1；扫描面 = 全部产生文件+输出+响应）");
		// credentials.json 合法持有 token（唯一允许位置）
		const credsRaw = readFileSync(wechatCredsPath(rt), "utf8");
		assert.ok(credsRaw.includes(TOK), "凭据文件合法持有 bot_token（例外面）");
		// inbox 端点脱敏：from 前缀 + text 存在
		const inboxBody = JSON.parse(bodies[1]) as { messages: { from: string; text: string; state: string }[] };
		assert.equal(inboxBody.messages.length, 2);
		const m1 = inboxBody.messages.find((m) => m.text === "内容 A")!;
		assert.ok(!m1.from.includes("wx_from_sec1"), "from.id 前缀脱敏");
		assert.equal(m1.state, "pending");
		assert.ok(m1.text.length > 0);
		const longMsg = inboxBody.messages.find((m) => m.text !== "内容 A")!;
		assert.ok(longMsg.text.length <= 81 && longMsg.text.endsWith("…"), "超长正文端点截断 ≤80+省略号");
		assert.ok(!bodies[1].includes("wx_from_"), "from.id 原值不泄漏于响应任何字段");
	} finally {
		console.log = origLog;
		console.error = origErr;
		if (h !== null) await h.close();
		await stub.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

// ── R5 opt-in OFF 零行为变化（不 spawn / 0 长轮询 / 401 门）──────────

async function r5(): Promise<void> {
	const stub = await startStubIlink();
	const dir = mkdtemp("wechat-r5-");
	let h: RuntimeHostHandle | null = null;
	try {
		writeFixtureConfig(join(dir, "config.json"), { enabled: true }); // receive 缺省 → false
		const rt = join(dir, "wechat-rt");
		mkdirSync(rt, { recursive: true });
		writeFixtureCreds(rt, `http://127.0.0.1:${stub.port}`, "T-r5");
		h = await createRuntimeHostServer({
			hostPath: join(dir, "host.json"),
			timersDir: join(dir, "timers"),
			stateDir: join(dir, "state"),
			mailboxDir: join(dir, "m"),
			journalPath: join(dir, "events.jsonl"),
			sessionsDir: join(dir, "sessions"),
			lockWaitMs: 500,
			configPath: join(dir, "config.json"),
			wechatRuntimeDir: rt,
		} as Parameters<typeof createRuntimeHostServer>[0]);
		const base = `http://127.0.0.1:${h.info.port}`;
		// a) 401 门（新端点沿用 authorizeCommand：无/错 token → 401）
		for (const p of ["/v1/wechat/worker/status", "/v1/wechat/inbox"]) {
			let r = await fetch(`${base}${p}`);
			assert.equal(r.status, 401, `无 token GET ${p} → 401`);
			r = await fetch(`${base}${p}`, { headers: { "x-command-token": "wrong" } });
			assert.equal(r.status, 401, `错 token GET ${p} → 401`);
		}
		// b) MF2：wechat.enabled=true + receive.enabled=false（缺省）→ 两个 W1 只读端点 403
		//    （鉴权之后的 receive 闸，语义同既有 opt-in 403），且零副作用（不 spawn、无 receive
		//    文件、0 长轮询——含游标/inbox 均无写入）。
		const H = { "x-command-token": h.info.token };
		for (const p of ["/v1/wechat/worker/status", "/v1/wechat/inbox?limit=10"]) {
			const r = await fetch(`${base}${p}`, { headers: H });
			assert.equal(r.status, 403, `receive=false GET ${p} → 403（MF2）`);
			const body = (await r.json()) as { error?: string };
			assert.equal(body.error, "wechat-receive-disabled", "403 体 = receive 闸语义");
		}
		await new Promise((r) => setTimeout(r, 1200));
		assert.equal(stub.getupdatesCount(), 0, "零长轮询调用（无 worker spawn 副作用）");
		assert.equal(existsSync(WechatStore.resolveDir(rt)), false, "未写任何 receive 文件（无游标/inbox 副作用）");
		// c) 显式开 receive.enabled（直接改 config 文件）→ POST enable（幂等重写）触发 sync → spawn
		writeFixtureConfig(join(dir, "config.json"), { enabled: true, receive: { enabled: true } });
		assert.equal(readWechatReceiveEnabled(join(dir, "config.json")), true);
		assert.equal(readWechatEnabled(join(dir, "config.json")), true);
		const en = await fetch(`${base}/v1/wechat/enable`, { method: "POST", headers: { ...H, "content-type": "application/json" }, body: "{}" });
		assert.equal(en.status, 200, "POST enable（幂等）触发 supervisor.sync()");
		await waitFor(() => stub.getupdatesCount() >= 1, 15000, "真子进程 worker 首次 getupdates");
		const st2 = await (await fetch(`${base}/v1/wechat/worker/status`, { headers: H })).json();
		assert.equal(st2.enabled, true);
		assert.equal(st2.running, true, "worker 子进程在跑");
		// close() 收掉 worker（daemon 停机不留孤儿）
		const pidRaw = JSON.parse(readFileSync(join(WechatStore.resolveDir(rt), "worker.json"), "utf8")) as { pid: number };
		assert.ok(Number.isInteger(pidRaw.pid) && pidRaw.pid > 0, "worker.json pid 文件在位");
		await h.close();
		h = null;
		await waitFor(() => !isProcessAlive(pidRaw.pid), 8000, "close() 后 worker pid 消失");
		assert.equal(existsSync(join(WechatStore.resolveDir(rt), "worker.json")), false, "pid 文件已清理");
	} finally {
		if (h !== null) await h.close();
		await stub.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

// ── R6 daemon 停机回收（直接 supervisor：spawn → dispose → pid 消失）──

async function r6(): Promise<void> {
	const stub = await startStubIlink();
	const dir = mkdtemp("wechat-r6-");
	try {
		const rt = join(dir, "rt");
		mkdirSync(rt, { recursive: true });
		const cfg = join(dir, "config.json");
		writeFixtureConfig(cfg, { enabled: true, receive: { enabled: true } });
		writeFixtureCreds(rt, `http://127.0.0.1:${stub.port}`, "T-r6");
		// a) 残留 pid 文件（死 pid）→ 下次启动识别并清理
		const staleDir = WechatStore.resolveDir(rt);
		mkdirSync(staleDir, { recursive: true });
		writeFileSync(join(staleDir, "worker.json"), `${JSON.stringify({ kind: "wechat-worker", pid: 999999999, daemonEpoch: "de_old", workerAttempt: 1, startedAt: new Date().toISOString() })}\n`, "utf8");
		const sup = new ChannelSupervisor({ runtimeDir: rt, configPath: cfg, restartBackoffStartMs: 500, restartBackoffMaxMs: 1000, staleWaitMs: 1000, reconcileMs: 3600_000 });
		sup.start();
		await waitFor(() => sup.status().running, 15000, "supervisor spawn worker（残留死 pid 已清理）");
		await waitFor(() => stub.getupdatesCount() >= 1, 15000, "worker 真在轮询 stub");
		const pid = sup.status().pid;
		assert.ok(pid !== null && isProcessAlive(pid), "子进程存活");
		const pidFile = join(staleDir, "worker.json");
		assert.ok(existsSync(pidFile), "新 pid 文件在位");
		// b) dispose → pid 消失 + pid 文件移除（有界）
		await sup.dispose();
		await waitFor(() => !isProcessAlive(pid as number), 8000, "dispose 后子进程消失（无孤儿）");
		assert.equal(existsSync(pidFile), false, "pid 文件已移除");
		// c) 残留活 pid（上代孤儿未自退）→ fail-closed 跳过 spawn 不误杀
		{
			mkdirSync(staleDir, { recursive: true });
			writeFileSync(pidFile, `${JSON.stringify({ kind: "wechat-worker", pid: process.pid, daemonEpoch: "de_other", workerAttempt: 1 })}\n`, "utf8"); // 本测试进程 = 活 pid（绝不能被杀）
			const sup2 = new ChannelSupervisor({ runtimeDir: rt, configPath: cfg, staleWaitMs: 300, reconcileMs: 3600_000 });
			const r = await sup2.sync();
			assert.equal(r.action, "skipped-stale", "活 pid 残留 → fail-closed 不 spawn");
			assert.equal(sup2.status().running, false);
			assert.ok(isProcessAlive(process.pid), "未误杀活 pid（进程仍在）");
			await sup2.dispose();
			rmSync(staleDir, { recursive: true, force: true });
		}
		// d) MF3：kill 超时仍存活 → 不清 pid 文件、不当作退出（fail-closed 保留识别凭据）
		{
			const rt2 = join(dir, "rt2");
			mkdirSync(rt2, { recursive: true });
			const cfg2 = join(dir, "config2.json");
			writeFixtureConfig(cfg2, { enabled: true, receive: { enabled: true } });
			writeFixtureCreds(rt2, "https://stub.example", "T-r6d");
			const sup3 = new ChannelSupervisor({
				runtimeDir: rt2,
				configPath: cfg2,
				killWaitMs: 150,
				reconcileMs: 3600_000,
				// 注入 spawn：pid=本测试进程（恒活）且 kill 无效 → 模拟强杀失败/慢退出
				spawnWorker: () => ({ pid: process.pid, kill: () => {} }),
			});
			const r3 = await sup3.sync();
			assert.equal(r3.action, "spawned", "注入 spawn 成功");
			const pidFile2 = join(WechatStore.resolveDir(rt2), "worker.json");
			assert.ok(existsSync(pidFile2), "pid 文件在位");
			await sup3.killChild("测试：强杀失败/慢退出");
			assert.equal(existsSync(pidFile2), true, "MF3：kill 超时仍存活 → 保留 pid 文件（不清识别凭据）");
			assert.equal(sup3.status().running, true, "不误判为已退出（仍活 = 仍占用）");
			assert.ok(isProcessAlive(process.pid), "未误杀活 pid");
			await sup3.dispose();
		}
	} finally {
		await stub.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

// ── main ────────────────────────────────────────────────────────────

// 硬看门狗（0924 加）：本测试会 spawn worker 子进程与 supervisor，任何一步卡死都可能让进程永不退出
// （实测：一次修复轮的中间态曾挂 6 小时，白占机器）。超时 → 打印诊断 + 非零退出，绝不让 CI/人手无限等。
const WATCHDOG_MS = 180_000;
const watchdog = setTimeout(() => {
	console.error(
		`\n[watchdog] 超过 ${WATCHDOG_MS}ms 未结束 —— 判定卡死并强制退出（exit 3）。\n` +
			"请检查是否有 worker/supervisor 子进程未回收（tasklist 里搜 _test_wechat_receive）。",
	);
	process.exit(3);
}, WATCHDOG_MS);
if (typeof watchdog.unref === "function") watchdog.unref();

const t0 = Date.now();
try {
	console.log("wechat-receive W1 离线单测（临时 runtimeDir；规格 §5.1–§5.6 + MF1/MF2/MF3 复检）：");
	await test("R1 stub getupdates：空批推进/混合批 quarantine/ret≠0/坏 JSON/429 Retry-After/超时/退避序列/auth 停 poll/状态迁移", r1);
	await test("R2 崩溃点重放：commit 前异常 → 重启重拉同 buf → claim 幂等只落一条 inbox", r2);
	await test("R2b MF1 putInbox 失败重放：claim 墓碑不吞消息（补写恰好一条；补写失败游标不推进）", r2b);
	await test("R3 游标顺序：commitBatch 之前 inbox 文件已在盘（claim→put→commit）", r3);
	await test("R4 秘密卫生：哨兵 token/context_token 于文件/输出/错误对象/端点响应 0 命中", r4);
	await test("R5 opt-in OFF 零行为：不 spawn/无文件/0 长轮询/401 门；显式开启后 spawn + close 回收", r5);
	await test("R6 daemon 停机回收：spawn→dispose pid 消失 + pid 文件清理 + 残留 pid 识别", r6);
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
