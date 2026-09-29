/**
 * W3a 微信出站回复 · send.ts 离线单测（fake fetch，零网络、零真实凭据）
 *
 * 覆盖（plans/0924_wechat_w3_impl_plan.md §G，本文件只做 W3a 切片 S1–S3）：
 *   S1  body/headers 形状锁：URL、方法、鉴权头全套、X-WECHAT-UIN（显式与随机缺省）、
 *       body 逐字段（base_info/msg 各键、item_list type:1、**无 context_token 键**）、
 *       键序 = 线上序列化序、中文原样
 *   S2  分类全路径（fake fetch）：200+ret0→sent；401/403→failed(auth)；429+Retry-After→
 *       failed(rate_limited, retryAfterMs)；400→failed(protocol)；500→failed(transient)；
 *       200+ret≠0→failed(protocol)（含 errcode 别名与 data 包装）；超时 abort→unknown；
 *       网络断→unknown；200+坏 JSON→unknown；秘密卫生（错误对象/reason 无 token/URL/正文）
 *   S3  派生确定性：deriveReplyClientId（sha256("wechat-reply:"+msgId+":"+outboxId) 64hex，
 *       两次相等、输入敏感、已知向量）与 deriveReplyIntentId（同口径）
 *
 * 硬看门狗（EB-004）：超时即非零退出，绝不让进程挂住。
 * 跑法：`node --experimental-strip-types ./extensions/_test_wechat_reply.ts` 或 `npx tsx` 同文件。
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractWechatReply } from "./wechat-reply-hook.ts";
import { markReplyIntent, newReplyIntent, readReplyIntent, replyIntentDir } from "./runtime/wechat-reply.ts";
import { WechatStore } from "./channel-wechat/store.ts";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { sendMessage, deriveReplyClientId, deriveReplyIntentId, type SendMessageReq } from "./channel-wechat/send.ts";
import { WechatIlinkError } from "./channel-wechat/client.ts";
import type { WechatFetch } from "./runtime-host/wechat-bind.ts";
import { startWechatReplyWatcher } from "./runtime-host/wechat-reply.ts";
import { incrementReplyAttempts } from "./runtime/wechat-reply.ts";

const WATCHDOG_MS = 180_000;
const watchdog = setTimeout(() => {
	console.error(`\n[watchdog] 超过 ${WATCHDOG_MS}ms 未结束 —— 判定卡死并强制退出（exit 3）`);
	process.exit(3);
}, WATCHDOG_MS);
watchdog.unref?.();
// 事件循环保活：超时/取消用例的 timer 是 unref 的（同 client.ts 形态），fake fetch 又无真实
// socket——不保活会在挂起用例中途因“无待处理事件”以 exit 13 终止。测试结束即清。
const keepAlive = setInterval(() => {}, 60_000);

const TOKEN = "bot-token-sentinel-XYZ";
const BASE = "https://ilink-test.example";
const TO = "openid-target-sentinel";
const CID = "client-id-fixed-1";
const BODY = "回复正文哨兵BODY（含中文与 emoji 🌊）";

let passed = 0;
const failures: string[] = [];
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
	try {
		await fn();
		passed += 1;
		console.log(`  ok  ${name}`);
	} catch (e) {
		failures.push(name);
		console.error(`  FAIL ${name}\n       ${e instanceof Error ? e.message : String(e)}`);
	}
}

function jsonRes(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(typeof body === "string" ? body : JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

function writeWechatTestCreds(runtimeDir: string): void { writeFileSync(join(runtimeDir,"wechat","credentials.json"),JSON.stringify({botToken:TOKEN,baseUrl:BASE,boundAt:"test"})); }

function baseReq(over: Partial<SendMessageReq> = {}): SendMessageReq {
	return { baseUrl: BASE, botToken: TOKEN, toUserId: TO, clientId: CID, text: BODY, ...over };
}

function fakeFetch(
	handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): WechatFetch {
	return (url, init) => Promise.resolve(handler(url, init));
}

/** 挂起直到 abort 的 fetch（模拟超时路径：只听 init.signal）。 */
const hangingFetch: WechatFetch = (_url, init) =>
	new Promise((_resolve, reject) => {
		init?.signal?.addEventListener("abort", () => {
			const e = new Error("This operation was aborted");
			e.name = "AbortError";
			reject(e);
		});
	});

/** 秘密卫生断言：错误对象（含 message/kind/status/ret/retryAfterMs）与 reason 无 token/URL/正文/openid。 */
function assertNoSecrets(v: unknown, label: string): void {
	const flat = typeof v === "string" ? v : JSON.stringify(StringifyErr(v));
	assert.ok(!flat.includes(TOKEN), `${label} 泄漏 bot_token 哨兵`);
	assert.ok(!flat.includes(BASE), `${label} 泄漏 URL`);
	assert.ok(!flat.includes(BODY), `${label} 泄漏请求正文`);
	assert.ok(!flat.includes(TO), `${label} 泄漏 to_user_id`);
}
function StringifyErr(v: unknown): unknown {
	if (v instanceof WechatIlinkError) {
		return { name: v.name, kind: v.kind, message: v.message, status: v.status, ret: v.ret, retryAfterMs: v.retryAfterMs };
	}
	return v;
}

const t0 = Date.now();
try {
	// ── S1 body/headers 形状锁 ────────────────────────────────────────
	let cap: { url: string; init: RequestInit | undefined } | undefined;
	const captureImpl = fakeFetch((url, init) => {
		cap = { url, init };
		return jsonRes({ ret: 0 });
	});

	await check("S1a sent 基线 + URL/方法（baseUrl 尾斜杠归一）", async () => {
		const r = await sendMessage(baseReq({ baseUrl: `${BASE}/` }), captureImpl);
		assert.equal(r.kind, "sent");
		assert.ok(cap, "fetch 未被调用");
		assert.equal(cap!.url, `${BASE}/ilink/bot/sendmessage`);
		assert.equal(cap!.init?.method, "POST");
	});

	await check("S1b headers 全套：content-type/AuthorizationType/Bearer/X-WECHAT-UIN(显式)", async () => {
		await sendMessage(baseReq({ uin: "dWluLTQy" }), captureImpl);
		const h = cap!.init!.headers as Record<string, string>;
		assert.equal(h["content-type"], "application/json");
		assert.equal(h.AuthorizationType, "ilink_bot_token");
		assert.equal(h.Authorization, `Bearer ${TOKEN}`);
		assert.equal(h["X-WECHAT-UIN"], "dWluLTQy");
	});

	await check("S1c 缺省 uin：base64(1..4294967295 的十进制串)，每次随机", async () => {
		const seen: number[] = [];
		for (let i = 0; i < 3; i++) {
			await sendMessage(baseReq(), captureImpl);
			const h = cap!.init!.headers as Record<string, string>;
			const n = Number(Buffer.from(h["X-WECHAT-UIN"], "base64").toString("utf8"));
			assert.ok(Number.isInteger(n) && n >= 1 && n <= 4294967295, `uin 解码越界：${n}`);
			seen.push(n);
		}
		assert.ok(new Set(seen).size >= 2, "三次随机 uin 全同（应每次随机）");
	});

	await check("S1d body 逐字段锁 + **无 context_token 键** + 键序=序列化序 + 中文原样", async () => {
		await sendMessage(baseReq(), captureImpl);
		const bodyStr = String(cap!.init!.body);
		const expected = JSON.stringify({
			base_info: { channel_version: "2.0.0" },
			msg: {
				from_user_id: "",
				to_user_id: TO,
				client_id: CID,
				message_type: 2,
				message_state: 2,
				item_list: [{ type: 1, text_item: { text: BODY } }],
			},
		});
		assert.equal(bodyStr, expected, "body 序列化与规格逐字节不符（字段/键序）");
		const body = JSON.parse(bodyStr) as { msg: Record<string, unknown> };
		assert.deepEqual(body.msg.item_list, [{ type: 1, text_item: { text: BODY } }]);
		assert.ok(!("context_token" in body.msg), "msg 含 context_token 键（recon③：不得带）");
		assert.ok(!bodyStr.includes("context_token"), "body 文本含 context_token");
		assert.ok(bodyStr.includes("🌊"), "中文/emoji 未原样保留");
	});

	// ── S2 分类全路径 ─────────────────────────────────────────────────
	await check("S2a 200 + ret=0 → sent", async () => {
		const r = await sendMessage(baseReq(), fakeFetch(() => jsonRes({ ret: 0 })));
		assert.deepEqual(r, { kind: "sent" });
	});

	await check("S2a2 200 + 空 body / data 包装 ret=0 → sent（unwrapPayload 口径）", async () => {
		assert.deepEqual(await sendMessage(baseReq(), fakeFetch(() => jsonRes(""))), { kind: "sent" });
		assert.deepEqual(await sendMessage(baseReq(), fakeFetch(() => jsonRes({ data: { ret: 0 } }))), { kind: "sent" });
	});

	await check("S2b 401 / 403 → failed(auth)", async () => {
		for (const st of [401, 403]) {
			const r = await sendMessage(baseReq(), fakeFetch(() => jsonRes({}, st)));
			assert.equal(r.kind, "failed", `HTTP ${st}`);
			if (r.kind === "failed") {
				assert.ok(r.error instanceof WechatIlinkError);
				assert.equal(r.error.kind, "auth");
				assert.equal(r.error.status, st);
				assertNoSecrets(r.error, `HTTP ${st} 错误对象`);
			}
		}
	});

	await check("S2c 429 + Retry-After → failed(rate_limited, retryAfterMs)", async () => {
		const r = await sendMessage(baseReq(), fakeFetch(() => jsonRes({}, 429, { "retry-after": "2" })));
		assert.equal(r.kind, "failed");
		if (r.kind === "failed") {
			assert.equal(r.error.kind, "rate_limited");
			assert.equal(r.error.status, 429);
			assert.equal(r.error.retryAfterMs, 2000);
			assertNoSecrets(r.error, "429 错误对象");
		}
	});

	await check("S2c2 429 无 Retry-After → rate_limited 缺省 60s；恶意值钳 ≤10min", async () => {
		const r1 = await sendMessage(baseReq(), fakeFetch(() => jsonRes({}, 429)));
		assert.equal(r1.kind === "failed" ? r1.error.retryAfterMs : 0, 60_000);
		const r2 = await sendMessage(baseReq(), fakeFetch(() => jsonRes({}, 429, { "retry-after": "99999" })));
		assert.equal(r2.kind === "failed" ? r2.error.retryAfterMs : 0, 600_000);
	});

	await check("S2d 400 → failed(protocol)；500 → failed(transient)", async () => {
		const r4 = await sendMessage(baseReq(), fakeFetch(() => jsonRes({}, 400)));
		assert.equal(r4.kind, "failed");
		if (r4.kind === "failed") {
			assert.equal(r4.error.kind, "protocol");
			assert.equal(r4.error.status, 400);
			assertNoSecrets(r4.error, "400 错误对象");
		}
		const r5 = await sendMessage(baseReq(), fakeFetch(() => jsonRes({}, 500)));
		assert.equal(r5.kind, "failed");
		if (r5.kind === "failed") {
			assert.equal(r5.error.kind, "transient");
			assert.equal(r5.error.status, 500);
		}
	});

	await check("S2e 200 + ret≠0 → failed(protocol)（ret 与 errcode 别名均认）", async () => {
		const r = await sendMessage(baseReq(), fakeFetch(() => jsonRes({ ret: 1001, errmsg: `${TOKEN} ${BASE} ${BODY} ${TO}` })));
		assert.equal(r.kind, "failed");
		if (r.kind === "failed") {
			assert.equal(r.error.kind, "protocol");
			assert.equal(r.error.ret, 1001);
			assertNoSecrets(r.error, "ret≠0 错误对象（包含恶意回显 errmsg）");
		}
		const r2 = await sendMessage(baseReq(), fakeFetch(() => jsonRes({ errcode: -2 })));
		assert.equal(r2.kind, "failed");
		assert.equal(r2.kind === "failed" ? r2.error.ret : 0, -2);
	});

	await check("S2f 超时 abort → unknown（不抛错）", async () => {
		const r = await sendMessage(baseReq({ timeoutMs: 50 }), hangingFetch);
		assert.equal(r.kind, "unknown");
		if (r.kind === "unknown") assertNoSecrets(r.reason, "超时 reason");
	});

	await check("S2g 外部 signal 取消 → unknown", async () => {
		const ac = new AbortController();
		const r = sendMessage(baseReq({ signal: ac.signal }), hangingFetch);
		setTimeout(() => ac.abort(), 20);
		assert.equal((await r).kind, "unknown");
	});

	await check("S2h 网络断（fetch throw）→ unknown", async () => {
		const broken: WechatFetch = () => Promise.reject(new TypeError("fetch failed"));
		const r = await sendMessage(baseReq(), broken);
		assert.equal(r.kind, "unknown");
		if (r.kind === "unknown") {
			assert.ok(!r.reason.includes("TypeError"), "reason 嵌了底层异常消息（应只记分类语义）");
			assertNoSecrets(r.reason, "网络断 reason");
		}
	});

	await check("S2i 200 + 坏 JSON → unknown（可能已成功）", async () => {
		const r = await sendMessage(baseReq(), fakeFetch(() => jsonRes("<html>not json", 200)));
		assert.equal(r.kind, "unknown");
		if (r.kind === "unknown") assertNoSecrets(r.reason, "坏 JSON reason");
	});
} catch (e) {
	console.error(`主流程异常: ${e instanceof Error ? e.stack : String(e)}`);
	process.exitCode = 1;
}

try {
	// ── S4 触发提取（所有文件均隔离在临时目录）──────────────────────
	await check("S4 trigger: valid marker writes inbox-derived pending intent; forged body address ignored", () => {
		const root = mkdtempSync(join(tmpdir(), "wechat-reply-s4-"));
		try {
			const stateDir = join(root, "state"), runtimeDir = join(root, "runtime"), configPath = join(root, "config.json");
			mkdirSync(stateDir, { recursive: true }); writeFileSync(configPath, JSON.stringify({ channels: { wechat: { reply: { mode: "reply-only" } } } })); // B5：钉 mode 锁旧行为（0925 P0 起缺省已为 reply-only——此处显式钉值，不受缺省影响）
			const outboxId = "a".repeat(64), store = new WechatStore(join(runtimeDir, "wechat", "receive"));
			store.putInbox({ msgId: "m-private-userid", fromId: "openid-authoritative@im.wechat", fromNickname: null, text: "in", receivedAt: new Date().toISOString(), state: "injected", outboxId });
			const msgs = [{ role: "user", content: [{ type: "text", text: `dedupe:outbox:${outboxId}` }] }, { role: "assistant", content: [{ type: "text", text: "older" }] }, { role: "assistant", stopReason: "length", content: [{ type: "text", text: `last ${TO}` }] }];
			assert.equal(extractWechatReply(msgs, { stateDir, runtimeDir, configPath }).written, true);
			const id = deriveReplyIntentId(outboxId), intent = readReplyIntent(replyIntentDir(stateDir), id)!;
			assert.equal(intent.fromId, "openid-authoritative@im.wechat"); assert.equal(intent.text, `last ${TO}`); assert.equal(intent.status, "pending"); assert.equal(intent.clientId, deriveReplyClientId("m-private-userid", outboxId));
			assert.equal(extractWechatReply(msgs, { stateDir, runtimeDir, configPath }).written, false);
			assert.ok(!readFileSync(join(stateDir, "wechat-reply-audit.jsonl"), "utf8").includes("last "));
		} finally { rmSync(root, { recursive: true, force: true }); }
	});
	await check("S4 zero action for absent/non-first marker; pure tool skips; truncate and disabled gate", () => {
		const root = mkdtempSync(join(tmpdir(), "wechat-reply-s4-"));
		try {
			const stateDir = join(root, "state"), runtimeDir = join(root, "runtime"), configPath = join(root, "config.json");
			mkdirSync(stateDir, { recursive: true }); writeFileSync(configPath, JSON.stringify({ channels: { wechat: { reply: { mode: "reply-only" } } } })); // B5：钉 mode
			const outboxId = "b".repeat(64), store = new WechatStore(join(runtimeDir, "wechat", "receive"));
			store.putInbox({ msgId: "m2", fromId: "human@im.wechat", fromNickname: null, text: "in", receivedAt: new Date().toISOString(), state: "injected", outboxId });
			assert.equal(extractWechatReply([{ role: "user", content: "no" }], { stateDir, runtimeDir, configPath }).written, false);
			// 0929 修（长会话 marker-not-first 缺陷）：marker 改为从**最近**的 user 消息找。
			// 旧断言（non-first marker ⇒ false）把 bug 固化为期望行为——长会话下 "第一条 user" 恒为历史首条
			//（无 marker）⇒ reply-only 路径对已运行多日的会话永久失效且静默（不写审计）。
			// 新语义：最近一条 user 带 marker 即生效（与 lastNonEmptyAssistantText 的从后往前对齐）。
			// 注：用独立 outboxId，避开前面断言残留/幂等干扰。
			const outboxLast = "1".repeat(64);
			store.putInbox({ msgId: "m2L", fromId: "human@im.wechat", fromNickname: null, text: "in", receivedAt: new Date().toISOString(), state: "injected", outboxId: outboxLast });
			assert.equal(extractWechatReply([{ role: "user", content: "no" }, { role: "user", content: `dedupe:outbox:${outboxLast}` }, { role: "assistant", content: [{ type: "text", text: "answer" }] }], { stateDir, runtimeDir, configPath }).written, true, "marker 在最近一条 user ⇒ 应生效（否则长会话永久失效）");
			// 纯 tool-call 轮在 marker 之后（最近 user 仍带 marker，但无 assistant 文本）⇒ no-text
			// 注：用独立 outboxId（上一断言已对 outboxId 写过 intent，幂等会把同 id 第二次调用变成 undefined）。
			const outboxTool = "e".repeat(64);
			store.putInbox({ msgId: "m2t", fromId: "human@im.wechat", fromNickname: null, text: "in", receivedAt: new Date().toISOString(), state: "injected", outboxId: outboxTool });
			assert.equal(extractWechatReply([{ role: "user", content: `dedupe:outbox:${outboxTool}` }, { role: "assistant", content: [{ type: "toolCall" }] }], { stateDir, runtimeDir, configPath }).reason, "no-text");
			assert.match(readFileSync(join(stateDir, "wechat-reply-audit.jsonl"), "utf8"), /no-text/);
			const outboxTrunc = "d".repeat(64);
			store.putInbox({ msgId: "m2x", fromId: "human@im.wechat", fromNickname: null, text: "in", receivedAt: new Date().toISOString(), state: "injected", outboxId: outboxTrunc });
			assert.equal(extractWechatReply([{ role: "user", content: `dedupe:outbox:${outboxTrunc}` }, { role: "assistant", stopReason: "length", content: [{ type: "text", text: "x".repeat(4001) }] }], { stateDir, runtimeDir, configPath }).written, true);
			assert.equal(readReplyIntent(replyIntentDir(stateDir), deriveReplyIntentId(outboxTrunc))!.text, "x".repeat(4000) + "…[截断]");
			writeFileSync(configPath, JSON.stringify({ channels: { wechat: { reply: { enabled: false } } } }));
			const other = "c".repeat(64); store.putInbox({ msgId: "m3", fromId: "human@im.wechat", fromNickname: null, text: "in", receivedAt: new Date().toISOString(), state: "injected", outboxId: other });
			assert.equal(extractWechatReply([{ role: "user", content: `dedupe:outbox:${other}` }, { role: "assistant", content: "reply" }], { stateDir, runtimeDir, configPath }).reason, "reply-disabled");
		} finally { rmSync(root, { recursive: true, force: true }); }
	});
	await check("S4 subagent skip and bot-domain anti-loop", () => {
		const root = mkdtempSync(join(tmpdir(), "wechat-reply-s4-"));
		try {
			const stateDir = join(root, "state"), runtimeDir = join(root, "runtime"), configPath = join(root, "config.json"); writeFileSync(configPath, JSON.stringify({ channels: { wechat: { reply: { mode: "reply-only" } } } })); // B5：钉 mode
			const outboxId = "d".repeat(64); new WechatStore(join(runtimeDir, "wechat", "receive")).putInbox({ msgId: "m4", fromId: "bot@im.bot", fromNickname: null, text: "in", receivedAt: new Date().toISOString(), state: "injected", outboxId });
			const messages = [{ role: "user", content: `dedupe:outbox:${outboxId}` }, { role: "assistant", content: "reply" }];
			assert.equal(extractWechatReply(messages, { stateDir, runtimeDir, configPath, subagent: () => true }).written, false);
			assert.equal(extractWechatReply(messages, { stateDir, runtimeDir, configPath }).reason, "bot-domain");
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	await check("跨进程并发创建/终态 CAS + 陈旧锁恢复", async () => {
		const root = mkdtempSync(join(tmpdir(), "wechat-reply-race-")), dir = replyIntentDir(root), id = "e".repeat(64);
		const worker = (op: string, arg: string, targetId = id) => new Promise<string>((resolve, reject) => {
			const code = `import {newReplyIntent,markReplyIntent} from './extensions/runtime/wechat-reply.ts'; const [op,dir,id,arg]=process.argv.slice(1); const common={id,msgId:'m',outboxId:'o',fromId:'f',clientId:'c',text:arg}; console.log(JSON.stringify(op==='create'?newReplyIntent(dir,common):markReplyIntent(dir,id,{status:arg})));`;
			const p = spawn(process.execPath, ["--experimental-strip-types", "-e", code, op, dir, targetId, arg], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
			let out = "", err = ""; p.stdout.setEncoding("utf8").on("data", x => out += x); p.stderr.setEncoding("utf8").on("data", x => err += x); p.on("error", reject); p.on("close", n => n === 0 ? resolve(out.trim()) : reject(new Error(err)));
		});
		try {
			const created = await Promise.all([worker("create", "winner-A"), worker("create", "winner-B")]);
			const stored = readReplyIntent(dir, id)!; assert.equal(stored.status, "pending"); assert.ok(["winner-A", "winner-B"].includes(stored.text));
			assert.equal(created.map(x => JSON.parse(x).created).filter(Boolean).length, 1);
			console.log(`    workers create: ${created.map(x => JSON.parse(x).item?.text).join(" | ")}; disk=${stored.text}`);
			const moved = await Promise.all([worker("mark", "sent"), worker("mark", "failed")]);
			const results = moved.map(x => JSON.parse(x)); assert.equal(results.filter(Boolean).length, 1); assert.equal(markReplyIntent(dir, id, { status: "unknown" }), null);
			console.log(`    workers transition: ${results.map(x => x?.status ?? "null").join(" | ")}; disk=${readReplyIntent(dir, id)!.status}`);
			const recoverId = "f".repeat(64); newReplyIntent(dir, { id: recoverId, msgId: "m2", outboxId: "o2", fromId: "f", clientId: "c", text: "recover" });
			const lock = `${join(dir, recoverId + ".json")}.lock`; writeFileSync(lock, "stale"); utimesSync(lock, new Date(0), new Date(0));
			assert.equal(markReplyIntent(dir, recoverId, { status: "unknown" })?.status, "unknown");
			const contestedId = "9".repeat(64); newReplyIntent(dir, { id: contestedId, msgId: "m4", outboxId: "o4", fromId: "f", clientId: "c", text: "stale-race" });
			const contestedLock = `${join(dir, contestedId + ".json")}.lock`; writeFileSync(contestedLock, "stale"); utimesSync(contestedLock, new Date(0), new Date(0));
			const claims = await Promise.all([worker("mark", "sent", contestedId), worker("mark", "failed", contestedId)]);
			assert.equal(claims.map(x => JSON.parse(x)).filter(Boolean).length, 1);
			assert.equal(readReplyIntent(dir, contestedId)!.status === "sent" || readReplyIntent(dir, contestedId)!.status === "failed", true);
			console.log(`    stale-lock contenders: successes=${claims.map(x => JSON.parse(x) ? 1 : 0).join(",")}; final=${readReplyIntent(dir, contestedId)!.status}`);
			const orphan = join(dir, `${"a".repeat(64)}.json.999.deadbeef.tmp`); writeFileSync(orphan, "orphan"); utimesSync(orphan, new Date(0), new Date(0));
			const createdItem = newReplyIntent(dir, { id: "1".repeat(64), msgId: "m3", outboxId: "o3", fromId: "f", clientId: "c", text: "cleanup" });
			assert.equal(createdItem?.created, true); assert.ok(!readdirSync(dir).includes(orphan.split(/[\\/]/).pop()!));
			console.log(`    orphan tmp cleanup: removed=${!readdirSync(dir).includes(orphan.split(/[\\/]/).pop()!)}`);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	// ── S5 daemon watcher 状态机 ─────────────────────────────────────
	await check("S5 pending→sent；attempts 先落盘；disabled/no-creds 保留；重放转 unknown；秘密不进审计", async () => {
	 const root = mkdtempSync(join(tmpdir(), "wechat-reply-s5-"));
	 try {
	  const runtimeDir=join(root,"runtime"), stateDir=join(root,"state"), cfg=join(root,"config.json"), dir=replyIntentDir(stateDir); mkdirSync(join(runtimeDir,"wechat"),{recursive:true});
	  writeFileSync(cfg,JSON.stringify({channels:{wechat:{reply:{enabled:false}}}}));
	  const mk=(id:string)=>newReplyIntent(dir,{id,msgId:"private-user-12345",outboxId:id,fromId:TO,clientId:"cid",text:"private body"})!.item;
	  const disabled=mk("2".repeat(64)); let calls=0;
	  let stop=startWechatReplyWatcher({runtimeDir,stateDir,configPath:cfg,intervalMs:15,fetchImpl:fakeFetch(()=>{calls++;return jsonRes({message_id:"ok"})})});
	  await new Promise(r=>setTimeout(r,50)); stop(); assert.equal(readReplyIntent(dir,disabled.id)?.status,"pending"); assert.equal(calls,0); markReplyIntent(dir,disabled.id,{status:"failed"});
	  writeFileSync(cfg,JSON.stringify({channels:{wechat:{reply:{enabled:true}}}}));
	  writeWechatTestCreds(runtimeDir);
	  const sent=mk("3".repeat(64));
	  stop=startWechatReplyWatcher({runtimeDir,stateDir,configPath:cfg,intervalMs:15,fetchImpl:fakeFetch(()=>{calls++;return jsonRes({message_id:"ok"})})});
	  await new Promise(r=>setTimeout(r,100)); stop(); assert.equal(readReplyIntent(dir,sent.id)?.status,"sent"); assert.equal(readReplyIntent(dir,sent.id)?.attempts,1);
	  const exhausted=mk("4".repeat(64)); incrementReplyAttempts(dir,exhausted.id); // simulated crash after persisted pre-send attempt
	  stop=startWechatReplyWatcher({runtimeDir,stateDir,configPath:cfg,intervalMs:15,fetchImpl:fakeFetch(()=>{calls++;return jsonRes({message_id:"unexpected"})})});
	  await new Promise(r=>setTimeout(r,60)); stop(); assert.equal(readReplyIntent(dir,exhausted.id)?.status,"unknown");
	  const absent=mk("5".repeat(64)); rmSync(join(runtimeDir,"wechat","credentials.json"),{force:true});
	  stop=startWechatReplyWatcher({runtimeDir,stateDir,configPath:cfg,intervalMs:15}); await new Promise(r=>setTimeout(r,50)); stop(); assert.equal(readReplyIntent(dir,absent.id)?.status,"pending"); markReplyIntent(dir,absent.id,{status:"failed"});
	  const failed=mk("6".repeat(64)), unknown=mk("7".repeat(64)); writeWechatTestCreds(runtimeDir);
	  let n=0; stop=startWechatReplyWatcher({runtimeDir,stateDir,configPath:cfg,intervalMs:15,fetchImpl:fakeFetch(()=>++n===1?jsonRes({ret:9}):Promise.reject(new Error("offline")))});
	  await new Promise(r=>setTimeout(r,100)); stop(); assert.equal(readReplyIntent(dir,failed.id)?.status,"failed"); assert.match(readReplyIntent(dir,failed.id)?.error??"",/^protocol::9$/); assert.equal(readReplyIntent(dir,unknown.id)?.status,"unknown");
	  const gate=mk("8".repeat(64)); let release!: (r:Response)=>void, entered=0;
	  stop=startWechatReplyWatcher({runtimeDir,stateDir,configPath:cfg,intervalMs:10,fetchImpl:((()=>{entered++; return new Promise<Response>(r=>{release=r;});}) as unknown) as WechatFetch});
	  await new Promise(r=>setTimeout(r,60)); assert.equal(entered,1,"interval watcher re-entered during unresolved send"); release(jsonRes({message_id:"ok"})); await new Promise(r=>setTimeout(r,40)); stop(); assert.equal(readReplyIntent(dir,gate.id)?.status,"sent");
	  const audit=readFileSync(join(stateDir,"wechat-reply-audit.jsonl"),"utf8"); assert.match(audit,/no-credentials/); assert.doesNotMatch(audit,/private body|bot-token-sentinel|openid-target-sentinel/); assert.doesNotMatch(readFileSync(join(dir,sent.id+".json"),"utf8"),/bot-token-sentinel/);
	 } finally { rmSync(root,{recursive:true,force:true}); }
	});

	// ── S3 派生确定性 ────────────────────────────────────────────────
	await check("S3a deriveReplyClientId：确定性 + 64hex + 输入敏感 + 已知向量", () => {
		const a = deriveReplyClientId("msg-1", "outbox-1");
		const b = deriveReplyClientId("msg-1", "outbox-1");
		assert.equal(a, b, "两次派生不等（非确定性）");
		assert.match(a, /^[0-9a-f]{64}$/, "非 64 位小写 hex");
		assert.notEqual(a, deriveReplyClientId("msg-2", "outbox-1"), "msgId 变化未影响派生");
		assert.notEqual(a, deriveReplyClientId("msg-1", "outbox-2"), "outboxId 变化未影响派生");
		assert.equal(
			a,
			createHash("sha256").update("wechat-reply:msg-1:outbox-1", "utf8").digest("hex"),
			"与规格向量不符（sha256('wechat-reply:'+msgId+':'+outboxId)）",
		);
		// 边界：空串输入仍是合法确定性派生（不抛错）
		assert.match(deriveReplyClientId("", ""), /^[0-9a-f]{64}$/);
	});

	await check("S3b deriveReplyIntentId：确定性 + 64hex + 与 clientId 不同源", () => {
		const a = deriveReplyIntentId("outbox-1");
		assert.equal(a, deriveReplyIntentId("outbox-1"));
		assert.match(a, /^[0-9a-f]{64}$/);
		assert.equal(a, createHash("sha256").update("wechat-reply:outbox-1", "utf8").digest("hex"));
		assert.notEqual(a, deriveReplyClientId("outbox-1", "outbox-1"), "意图 id 与 clientId 派生源重叠");
	});
} catch (e) {
	console.error(`主流程异常: ${e instanceof Error ? e.stack : String(e)}`);
	process.exitCode = 1;
}

clearInterval(keepAlive);
if (failures.length > 0) {
	console.error(`\n${failures.length} 项失败: ${failures.join(" | ")}`);
	process.exitCode = 1;
} else {
	console.log(`\n全部通过（${passed} 组断言块，${Date.now() - t0}ms）`);
}
