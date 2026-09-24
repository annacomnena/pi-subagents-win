/**
 * 0924 出站广播（mode=broadcast）验收单测 · B1–B9（fake fetch，零网络、零真实凭据）
 *
 * 依据：plans/0924_wechat_broadcast_plan.md §7（L2 计划 = 规格书）
 *   + plans/0924_wechat_broadcast_recon.md（位置与校准）
 *   + 用户最终裁定（覆盖计划 §9 待裁点）：
 *     ① sessionScope 缺省 "owner" = 只有 global master 会话广播（readAttachment 不可读/未
 *        attach → fail-closed 不广播）；② 缺省 mode="broadcast"；③ 触发 = agent_settled
 *        （agent_end 只暂存，settled 无暂存 → 审计 no-stash）；④ TTL=10min 常量、failed 不重试。
 *
 * 跑法：`timeout 300 npx tsx extensions/_test_wechat_broadcast.ts`
 * 硬看门狗：超时即非零退出，绝不挂住。
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
	extractWechatReply, flushWechatBroadcast, resetWechatBroadcastStash,
	deriveBroadcastRoundId, type ReplyHookDeps,
} from "./wechat-reply-hook.ts";
import {
	listReplyIntents, markReplyIntent, newReplyIntent, readReplyIntent, replyIntentDir,
	deriveBroadcastIntentId, deriveReplyIntentId,
} from "./runtime/wechat-reply.ts";
import { WechatStore } from "./channel-wechat/store.ts";
import { deriveBroadcastClientId, deriveReplyClientId } from "./channel-wechat/send.ts";
import { readWechatReplyConfig, type WechatFetch } from "./runtime-host/wechat-bind.ts";
import { startWechatReplyWatcher, BROADCAST_INTENT_TTL_MS } from "./runtime-host/wechat-reply.ts";

const WATCHDOG_MS = 180_000;
const watchdog = setTimeout(() => {
	console.error(`\n[watchdog] 超过 ${WATCHDOG_MS}ms 未结束 —— 判定卡死并强制退出（exit 3）`);
	process.exit(3);
}, WATCHDOG_MS);
watchdog.unref?.();
const keepAlive = setInterval(() => {}, 60_000); // fake fetch 无真实 socket，需保活；结束即清

const TOKEN = "bc-bot-token-sentinel-XYZ";
const BASE = "https://ilink-test.example";
const BODY = "广播正文哨兵 BCAST-BODY-001 🌊";
const MASTER_SID = "11111111-2222-4333-8444-555555555555";
const OTHER_SID = "99999999-8888-7777-6666-555555555555";
const A = "openid-AAAAAAAAAAAAAAAAAA@im.wechat";
const B = "openid-BBBBBBBBBBBBBBBBBB@im.wechat";
const C = "openid-CCCCCCCCCCCCCCCCCC@im.wechat";
const BOT = "robot-DDDDDDDDDD@im.bot";

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
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function jsonRes(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(typeof body === "string" ? body : JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

interface Env { root: string; stateDir: string; runtimeDir: string; configPath: string; }
function mkEnv(config: unknown): Env {
	const root = mkdtempSync(join(tmpdir(), "wechat-broadcast-"));
	const env: Env = { root, stateDir: join(root, "state"), runtimeDir: join(root, "runtime"), configPath: join(root, "config.json") };
	mkdirSync(env.stateDir, { recursive: true });
	writeFileSync(env.configPath, JSON.stringify(config));
	return env;
}
const BROADCAST_CFG = { channels: { wechat: { reply: { mode: "broadcast" as const } } } };
function envDeps(env: Env, over: Partial<ReplyHookDeps> = {}): ReplyHookDeps {
	// 注意：本测试可能在 PI_SUBAGENT=1 的 agent 进程内跑（缺省 isSubagent()=true 会静默吞掉 flush），
	// 故显式钉 subagent:()=>false；B6 的 subagent 用例再覆写为 true。
	return { stateDir: env.stateDir, runtimeDir: env.runtimeDir, configPath: env.configPath, subagent: () => false, sessionId: () => MASTER_SID, masterSessionId: () => MASTER_SID, ...over };
}
function putChat(env: Env, msgId: string, fromId: string, receivedAt = new Date().toISOString(), extra: Record<string, unknown> = {}): void {
	new WechatStore(join(env.runtimeDir, "wechat", "receive")).putInbox({ msgId, fromId, fromNickname: null, text: "in", receivedAt, state: "pending", ...extra } as any);
}
function setWorkerStatus(env: Env, status: string): void {
	const dir = join(env.runtimeDir, "wechat", "receive");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "state.json"), JSON.stringify({ status, updatedAt: new Date().toISOString() }));
}
function writeCreds(env: Env): void {
	mkdirSync(join(env.runtimeDir, "wechat"), { recursive: true });
	writeFileSync(join(env.runtimeDir, "wechat", "credentials.json"), JSON.stringify({ botToken: TOKEN, baseUrl: BASE, boundAt: "test" }));
}
function auditText(stateDir: string): string {
	try { return readFileSync(join(stateDir, "wechat-reply-audit.jsonl"), "utf8"); } catch { return ""; }
}
function auditRows(stateDir: string): Record<string, unknown>[] {
	return auditText(stateDir).split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as Record<string, unknown>]; } catch { return []; } });
}
function intentFiles(stateDir: string): string[] {
	try { return readdirSync(replyIntentDir(stateDir)).filter((f) => f.endsWith(".json")); } catch { return []; }
}
/** 按 body.msg.to_user_id 记账的 fake fetch（缺省 200+ret0）。 */
function senderFetch(log: { to: string; clientId: string }[], responder?: (to: string) => Response | undefined): WechatFetch {
	return async (_url, init) => {
		const body = JSON.parse(String(init?.body)) as { msg: { to_user_id: string; client_id: string } };
		log.push({ to: body.msg.to_user_id, clientId: body.msg.client_id });
		return responder?.(body.msg.to_user_id) ?? jsonRes({ ret: 0 });
	};
}
function round(firstUserText: string, ts: number | null, assistantText: string): unknown[] {
	return [
		{ role: "user", content: firstUserText, ...(ts === null ? {} : { timestamp: ts }) },
		{ role: "assistant", content: [{ type: "text", text: "旧答案（不选）" }] },
		{ role: "assistant", content: [{ type: "text", text: assistantText }] },
	];
}

const t0 = Date.now();
try {
	// ── 派生确定性与已知向量（S3 广播版） ─────────────────────────────
	await check("S3c 广播派生：roundId/intentId/clientId 确定性、64hex、三者互不同源", () => {
		const roundId = deriveBroadcastRoundId(MASTER_SID, 1758000000123, "summarize");
		assert.match(roundId, /^[0-9a-f]{64}$/);
		const inner = createHash("sha256").update("summarize", "utf8").digest("hex");
		assert.equal(roundId, createHash("sha256").update(`${MASTER_SID}:1758000000123:${inner}`, "utf8").digest("hex"), "roundId 向量不符");
		assert.equal(deriveBroadcastRoundId(MASTER_SID, 1758000000123, "summarize"), roundId, "两次派生不等");
		assert.notEqual(deriveBroadcastRoundId(MASTER_SID, 1758000000124, "summarize"), roundId, "timestamp 未影响 roundId");
		assert.notEqual(deriveBroadcastRoundId(MASTER_SID, null, "summarize"), roundId, "no-ts 退化未生效");
		const intentId = deriveBroadcastIntentId(roundId, A);
		assert.equal(intentId, createHash("sha256").update(`wechat-broadcast:${roundId}:${A}`, "utf8").digest("hex"), "intent id 向量不符（裁定：sha256(wechat-broadcast:roundId:fromId)）");
		assert.notEqual(intentId, deriveBroadcastIntentId(roundId, B), "不同收件人同 id（应 per-recipient）");
		const cid = deriveBroadcastClientId(roundId, A);
		assert.equal(cid, createHash("sha256").update(`wechat-broadcast-client:${roundId}:${A}`, "utf8").digest("hex"), "clientId 向量不符");
		assert.notEqual(cid, deriveBroadcastIntentId(roundId, A), "intent id 与 clientId 同源");
		assert.notEqual(intentId, deriveReplyIntentId(roundId), "与 reply 派生同源");
		assert.notEqual(cid, deriveReplyClientId(roundId, roundId), "与 reply clientId 同源");
	});

	// ── B1 非微信触发轮也出站 ────────────────────────────────────────
	await check("B1 无 marker 轮：2 收件人 pending(kind=broadcast) → watcher 全 sent、toUserId 逐一对应", async () => {
		resetWechatBroadcastStash();
		const env = mkEnv(BROADCAST_CFG);
		try {
			putChat(env, "m-a", A); putChat(env, "m-b", B);
			const deps = envDeps(env);
			const msgs = round("帮我总结一下", 1758000000123, BODY); // 首条 user 无 dedupe:outbox marker
			assert.ok(!JSON.stringify(msgs).includes("dedupe:outbox"), "用例消息不应含 marker");
			assert.equal(extractWechatReply(msgs, deps).written, false); // broadcast 分支：只暂存不直写
			assert.equal(flushWechatBroadcast(deps).count, 2);
			const dir = replyIntentDir(env.stateDir);
			const items = listReplyIntents(dir);
			assert.equal(items.length, 2);
			const roundId = deriveBroadcastRoundId(MASTER_SID, 1758000000123, "帮我总结一下");
			assert.deepEqual(items.map((i) => i.fromId).sort(), [A, B].sort());
			for (const it of items) {
				assert.equal(it.kind, "broadcast");
				assert.equal(it.status, "pending");
				assert.equal(it.msgId, roundId);
				assert.equal(it.outboxId, roundId);
				assert.equal(it.text, BODY);
				assert.equal(it.id, deriveBroadcastIntentId(roundId, it.fromId));
				assert.equal(it.clientId, deriveBroadcastClientId(roundId, it.fromId));
				assert.notEqual(it.clientId, deriveBroadcastIntentId(roundId, it.fromId));
			}
			writeCreds(env); setWorkerStatus(env, "connected");
			const log: { to: string; clientId: string }[] = [];
			const stop = startWechatReplyWatcher({ runtimeDir: env.runtimeDir, stateDir: env.stateDir, configPath: env.configPath, intervalMs: 15, fetchImpl: senderFetch(log) });
			await sleep(140); stop();
			assert.equal(log.length, 2, `fetch 次数 ${log.length} ≠ 2`);
			assert.deepEqual(log.map((l) => l.to).sort(), [A, B].sort());
			assert.equal(new Set(log.map((l) => l.clientId)).size, 2, "clientId 应 per-recipient 独立");
			for (const it of listReplyIntents(dir)) assert.equal(it.status, "sent");
			const rows = auditRows(env.stateDir);
			assert.equal(rows.filter((r) => r.event === "intent-written").length, 2);
			assert.equal(rows.filter((r) => r.event === "sent").length, 2);
			const audit = auditText(env.stateDir);
			assert.ok(!audit.includes(BODY), "审计泄漏正文");
			for (const id of [A, B]) assert.ok(!audit.includes(id), `审计泄漏完整 openid: ${id}`);
		} finally { resetWechatBroadcastStash(); rmSync(env.root, { recursive: true, force: true }); }
	});

	// ── B2 多收件人全发 + bot 防环 + 去重 ────────────────────────────
	await check("B2 3 去重 fromId + 1 重复 + 1 @im.bot → 恰 3 intent / 3 fetch / 3 行 sent，bot 0 次", async () => {
		resetWechatBroadcastStash();
		const env = mkEnv(BROADCAST_CFG);
		try {
			const t1 = new Date(Date.now() - 1000).toISOString(), t2 = new Date().toISOString();
			putChat(env, "m-a1", A, t1);
			putChat(env, "m-a1-dup", A, t2);   // 同 fromId 重复记录
			putChat(env, "m-b", B, t1);
			putChat(env, "m-c", C, t2);
			putChat(env, "m-bot", BOT, t2);    // @im.bot 防环
			const deps = envDeps(env);
			const chats = new WechatStore(join(env.runtimeDir, "wechat", "receive")).knownChats();
			assert.deepEqual(chats.map((c) => c.fromId).sort(), [A, B, C].sort(), "knownChats 去重/过滤口径");
			assert.equal(extractWechatReply(round("第二问", 1758000001456, BODY), deps).written, false);
			assert.equal(flushWechatBroadcast(deps).count, 3);
			const dir = replyIntentDir(env.stateDir);
			assert.equal(intentFiles(env.stateDir).length, 3);
			assert.deepEqual(listReplyIntents(dir).map((i) => i.fromId).sort(), [A, B, C].sort());
			writeCreds(env); setWorkerStatus(env, "connected");
			const log: { to: string; clientId: string }[] = [];
			const stop = startWechatReplyWatcher({ runtimeDir: env.runtimeDir, stateDir: env.stateDir, configPath: env.configPath, intervalMs: 15, fetchImpl: senderFetch(log) });
			await sleep(140); stop();
			assert.equal(log.length, 3, `fetch 次数 ${log.length} ≠ 3`);
			assert.deepEqual(log.map((l) => l.to).sort(), [A, B, C].sort());
			assert.ok(!log.some((l) => l.to === BOT), "bot 域被发信（防环失效）");
			const rows = auditRows(env.stateDir);
			assert.equal(rows.filter((r) => r.event === "sent").length, 3);
			assert.ok(!rows.some((r) => String(r.from ?? "").endsWith("@im.bot")));
		} finally { resetWechatBroadcastStash(); rmSync(env.root, { recursive: true, force: true }); }
	});

	// ── B3 同轮幂等 / 跨轮不覆盖 ─────────────────────────────────────
	await check("B3 同轮二次 flush → created:false 文件数不变、watcher 只发一次；跨轮文件累加、两轮 text 各留", async () => {
		resetWechatBroadcastStash();
		const env = mkEnv(BROADCAST_CFG);
		try {
			putChat(env, "m-a", A); putChat(env, "m-b", B);
			const deps = envDeps(env);
			const msgs1 = round("第一问", 1758000002000, BODY);
			assert.equal(flushAfter(extractWechatReply(msgs1, deps), deps).count, 2);
			// 同轮重放：同 messages → 同 roundKey → 同 id 集 → 0 新建
			const again = flushAfter(extractWechatReply(msgs1, deps), deps);
			assert.equal(again.written, false);
			assert.equal(again.count, 0, "同轮重复 flush 不应新建");
			assert.equal(intentFiles(env.stateDir).length, 2, "同轮重复 flush 文件数变化");
			writeCreds(env); setWorkerStatus(env, "connected");
			const log: { to: string; clientId: string }[] = [];
			let stop = startWechatReplyWatcher({ runtimeDir: env.runtimeDir, stateDir: env.stateDir, configPath: env.configPath, intervalMs: 15, fetchImpl: senderFetch(log) });
			await sleep(140); stop();
			assert.equal(log.length, 2, "watcher 应只发 2 次（同轮不重发）");
			// 跨轮：不同 firstUserText + timestamp → roundKey 变 → 文件累加、互不覆盖
			const body2 = BODY + "-ROUND2";
			assert.equal(flushAfter(extractWechatReply(round("第二问", 1758000003000, body2), deps), deps).count, 2);
			assert.equal(intentFiles(env.stateDir).length, 4, "跨轮文件未累加");
			const texts = listReplyIntents(replyIntentDir(env.stateDir)).map((i) => i.text);
			assert.equal(texts.filter((t) => t === BODY).length, 2, "第一轮 text 被覆盖");
			assert.equal(texts.filter((t) => t === body2).length, 2, "第二轮 text 缺失");
		} finally { resetWechatBroadcastStash(); rmSync(env.root, { recursive: true, force: true }); }
	});

	// ── B4 connected 门 + TTL ────────────────────────────────────────
	await check("B4 非 connected 不出站(保留 pending+审计) → connected 续发；TTL 11min → failed broadcast-expired 不发", async () => {
		resetWechatBroadcastStash();
		const env = mkEnv(BROADCAST_CFG);
		try {
			putChat(env, "m-a", A);
			const deps = envDeps(env);
			writeCreds(env);
			flushAfter(extractWechatReply(round("第四问", 1758000004000, BODY), deps), deps);
			const dir = replyIntentDir(env.stateDir);
			const first = listReplyIntents(dir)[0];
			setWorkerStatus(env, "polling");
			const log: { to: string; clientId: string }[] = [];
			let stop = startWechatReplyWatcher({ runtimeDir: env.runtimeDir, stateDir: env.stateDir, configPath: env.configPath, intervalMs: 15, fetchImpl: senderFetch(log) });
			await sleep(120); stop();
			assert.equal(log.length, 0, "polling 时出站了");
			assert.equal(readReplyIntent(dir, first.id)?.status, "pending", "非 connected 应保留 pending");
			assert.ok(auditRows(env.stateDir).some((r) => r.event === "skipped" && r.reason === "channel-not-connected"), "缺 channel-not-connected 审计");
			setWorkerStatus(env, "connected");
			stop = startWechatReplyWatcher({ runtimeDir: env.runtimeDir, stateDir: env.stateDir, configPath: env.configPath, intervalMs: 15, fetchImpl: senderFetch(log) });
			await sleep(140); stop();
			assert.equal(log.length, 1, "connected 后未续发");
			assert.equal(readReplyIntent(dir, first.id)?.status, "sent");
			// TTL：createdAt 拨旧 11min（>10min 常量）→ 终态 failed，不发
			assert.equal(BROADCAST_INTENT_TTL_MS, 10 * 60_000, "TTL 常量 = 10min");
			const staleRound = deriveBroadcastRoundId(MASTER_SID, 1758000004999, "stale");
			const staleId = deriveBroadcastIntentId(staleRound, A);
			newReplyIntent(dir, {
				id: staleId, msgId: staleRound, outboxId: staleRound, fromId: A,
				clientId: deriveBroadcastClientId(staleRound, A), text: "过期正文", kind: "broadcast",
				now: new Date(Date.now() - 11 * 60_000),
			});
			stop = startWechatReplyWatcher({ runtimeDir: env.runtimeDir, stateDir: env.stateDir, configPath: env.configPath, intervalMs: 15, fetchImpl: senderFetch(log) });
			await sleep(140); stop();
			assert.equal(log.length, 1, "过期意图仍被发出");
			assert.equal(readReplyIntent(dir, staleId)?.status, "failed");
			assert.equal(readReplyIntent(dir, staleId)?.error, "broadcast-expired");
			assert.ok(auditRows(env.stateDir).some((r) => r.reason === "broadcast-expired"), "缺 broadcast-expired 审计");
			// failed 终态：不自动重试（裁定④）——再来一轮 watcher 也不动它
			assert.equal(markReplyIntent(dir, staleId, { status: "sent" }), null, "failed 应为不可再迁移终态");
		} finally { resetWechatBroadcastStash(); rmSync(env.root, { recursive: true, force: true }); }
	});

	// ── B5（补充证明）reply intent 无 kind：不加 connected 门直发 ─────
	await check("B5+ reply intent（无 kind）在 status=disconnected 下仍直发（旧路径红线，门只对 broadcast）", async () => {
		const env = mkEnv(BROADCAST_CFG); // watcher 不读 mode，只认 kind
		try {
			writeCreds(env); // 无 state.json → readState 缺省 disconnected
			const dir = replyIntentDir(env.stateDir);
			const id = deriveReplyIntentId("e".repeat(64));
			newReplyIntent(dir, { id, msgId: "m-old", outboxId: "e".repeat(64), fromId: A, clientId: "cid-old", text: "旧回复" });
			const log: { to: string; clientId: string }[] = [];
			const stop = startWechatReplyWatcher({ runtimeDir: env.runtimeDir, stateDir: env.stateDir, configPath: env.configPath, intervalMs: 15, fetchImpl: senderFetch(log) });
			await sleep(140); stop();
			assert.equal(log.length, 1, "reply intent 不应受 connected 门约束");
			assert.equal(readReplyIntent(dir, id)?.status, "sent");
			assert.ok(!auditText(env.stateDir).includes("channel-not-connected"));
		} finally { rmSync(env.root, { recursive: true, force: true }); }
	});

	// ── B6 会话资格门（subagent / main / any / owner 两分支） ─────────
	await check("B6 subagent 零 intent；scope=main tab → not-main-session；scope=any 正常写；owner 不匹配/无 attachment fail-closed", async () => {
		resetWechatBroadcastStash();
		const env = mkEnv(BROADCAST_CFG);
		try {
			putChat(env, "m-a", A); putChat(env, "m-b", B);
			const msgs = round("第六问", 1758000006000, BODY);
			// subagent：extract/flush 均零动作
			const sub = envDeps(env, { subagent: () => true });
			assert.equal(extractWechatReply(msgs, sub).written, false);
			assert.equal(flushWechatBroadcast(sub).count, 0);
			assert.equal(intentFiles(env.stateDir).length, 0, "subagent 不应写 intent");
			// scope=owner 不匹配 → not-master-owner
			const mismatch = envDeps(env, { sessionId: () => OTHER_SID });
			flushAfter(extractWechatReply(msgs, mismatch), mismatch);
			assert.equal(intentFiles(env.stateDir).length, 0, "非 owner 不应写 intent");
			assert.ok(auditRows(env.stateDir).some((r) => r.reason === "not-master-owner"), "缺 not-master-owner 审计");
			// scope=owner 但 master 未 attach / attachment 不可读 → fail-closed 不广播（用户裁定必测）
			resetWechatBroadcastStash();
			const noOwner = envDeps(env, { masterSessionId: () => null });
			flushAfter(extractWechatReply(msgs, noOwner), noOwner);
			assert.equal(intentFiles(env.stateDir).length, 0, "无 attachment 不应写 intent（fail-closed）");
			assert.ok(auditRows(env.stateDir).some((r) => r.reason === "master-attachment-unavailable"), "缺 master-attachment-unavailable 审计");
			// scope=main + tab（mainSession false）→ not-main-session
			const mainCfg = mkEnv({ channels: { wechat: { reply: { mode: "broadcast", sessionScope: "main" } } } });
			try {
				putChat(mainCfg, "m-a", A);
				const tab = envDeps(mainCfg, { mainSession: () => false });
				flushAfter(extractWechatReply(msgs, tab), tab);
				assert.equal(intentFiles(mainCfg.stateDir).length, 0, "tab 会话不应写 intent");
				assert.ok(auditRows(mainCfg.stateDir).some((r) => r.reason === "not-main-session"), "缺 not-main-session 审计");
			} finally { rmSync(mainCfg.root, { recursive: true, force: true }); }
			// scope=any + 非 subagent → 正常写（逃生口）
			const anyCfg = mkEnv({ channels: { wechat: { reply: { mode: "broadcast", sessionScope: "any" } } } });
			try {
				putChat(anyCfg, "m-a", A);
				const anyDeps = envDeps(anyCfg, { mainSession: () => false, sessionId: () => OTHER_SID, masterSessionId: () => null });
				assert.equal(flushAfter(extractWechatReply(msgs, anyDeps), anyDeps).count, 1, "scope=any 应正常写");
			} finally { rmSync(anyCfg.root, { recursive: true, force: true }); }
		} finally { resetWechatBroadcastStash(); rmSync(env.root, { recursive: true, force: true }); }
	});

	// ── B7 部分失败 per-recipient ────────────────────────────────────
	await check("B7 A(200/ret0)+B(500)：A sent、B failed(500)，A 不回滚；B attempts=1 且终态不可迁移", async () => {
		resetWechatBroadcastStash();
		const env = mkEnv(BROADCAST_CFG);
		try {
			putChat(env, "m-a", A); putChat(env, "m-b", B);
			const deps = envDeps(env);
			flushAfter(extractWechatReply(round("第七问", 1758000007000, BODY), deps), deps);
			const dir = replyIntentDir(env.stateDir);
			writeCreds(env); setWorkerStatus(env, "connected");
			const log: { to: string; clientId: string }[] = [];
			const stop = startWechatReplyWatcher({ runtimeDir: env.runtimeDir, stateDir: env.stateDir, configPath: env.configPath, intervalMs: 15, fetchImpl: senderFetch(log, (to) => (to === B ? jsonRes({}, 500) : undefined)) });
			await sleep(160); stop();
			const items = listReplyIntents(dir);
			const aItem = items.find((i) => i.fromId === A)!, bItem = items.find((i) => i.fromId === B)!;
			assert.equal(aItem.status, "sent");
			assert.equal(aItem.attempts, 1);
			assert.equal(bItem.status, "failed");
			assert.equal(bItem.attempts, 1);
			assert.equal(bItem.error, "transient:500:", `B error=${bItem.error}`);
			assert.equal(readReplyIntent(dir, aItem.id)?.status, "sent", "A 的成功被 B 失败连坐");
			assert.equal(markReplyIntent(dir, bItem.id, { status: "sent" }), null, "failed 终态应拒绝再迁移");
			assert.equal(readReplyIntent(dir, bItem.id)?.status, "failed");
			// failed 不自动重试（裁定④）：再来一轮 watcher，B 不再被 fetch
			const before = log.length;
			const stop2 = startWechatReplyWatcher({ runtimeDir: env.runtimeDir, stateDir: env.stateDir, configPath: env.configPath, intervalMs: 15, fetchImpl: senderFetch(log, () => jsonRes({}, 500)) });
			await sleep(120); stop2();
			assert.equal(log.length, before, "failed 不应被自动重试");
		} finally { resetWechatBroadcastStash(); rmSync(env.root, { recursive: true, force: true }); }
	});

	// ── B8 内容选取与截断 ───────────────────────────────────────────
	await check("B8 末条非空 assistant 原文；4001 → 4000+…[截断]；纯工具轮 → no-text 零 intent", async () => {
		resetWechatBroadcastStash();
		const env = mkEnv(BROADCAST_CFG);
		try {
			putChat(env, "m-a", A);
			const deps = envDeps(env);
			// 内容 = 末条非空 assistant（非最后一条消息也可——倒序取首个非空）
			assert.equal(flushAfter(extractWechatReply(round("内容问", 1758000008100, "末条原文 KEEP-ME"), deps), deps).count, 1);
			// 截断：4001 → 4000 + "…[截断]"
			assert.equal(flushAfter(extractWechatReply(round("截断问", 1758000008200, "x".repeat(4001)), deps), deps).count, 1);
			const texts = listReplyIntents(replyIntentDir(env.stateDir)).map((i) => i.text);
			assert.ok(texts.includes("末条原文 KEEP-ME"), `intent.text ≠ 末条原文: ${JSON.stringify(texts)}`);
			assert.ok(texts.includes("x".repeat(4000) + "…[截断]"), "4001 字符未按 4000 截断");
			// 纯工具轮：无非空 assistant 文本 → no-text、零新增
			const toolMsgs = [{ role: "user", content: "工具轮", timestamp: 1758000008300 }, { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }] }];
			const before = intentFiles(env.stateDir).length;
			const r = flushAfter(extractWechatReply(toolMsgs, deps), deps);
			assert.equal(r.reason, "no-text");
			assert.equal(r.count, 0);
			assert.equal(intentFiles(env.stateDir).length, before, "纯工具轮写了 intent");
			assert.ok(auditRows(env.stateDir).some((x) => x.reason === "no-text"), "缺 no-text 审计");
		} finally { resetWechatBroadcastStash(); rmSync(env.root, { recursive: true, force: true }); }
	});

	// ── B9 配置兼容（enabled 缺省 / 全关 / mode 非法 / scope 非法） ────
	await check("B9 {} → enabled:true+mode:broadcast+scope:owner；enabled:false 两模式全关；mode 非法 → reply-only fail-closed；scope 非法 → owner", async () => {
		resetWechatBroadcastStash();
		// ① {}（无 reply 键）
		const emptyCfg = mkEnv({});
		try {
			assert.deepEqual(readWechatReplyConfig(emptyCfg.configPath), { enabled: true, mode: "broadcast", sessionScope: "owner" });
			putChat(emptyCfg, "m-a", A);
			const deps = envDeps(emptyCfg);
			assert.equal(flushAfter(extractWechatReply(round("缺省问", 1758000009000, BODY), deps), deps).count, 1, "缺省配置应走广播");
		} finally { rmSync(emptyCfg.root, { recursive: true, force: true }); }
		// ② enabled:false → 两模式全关（hook 零动作 + watcher 保留 pending）
		const offCfg = mkEnv({ channels: { wechat: { reply: { enabled: false } } } });
		try {
			putChat(offCfg, "m-a", A);
			const deps = envDeps(offCfg);
			assert.equal(extractWechatReply(round("关问", 1758000009100, BODY), deps).reason, "reply-disabled");
			assert.equal(flushWechatBroadcast(deps).count, 0, "disabled 下 flush 不应写");
			assert.equal(intentFiles(offCfg.stateDir).length, 0);
			const dir = replyIntentDir(offCfg.stateDir);
			const pendingId = deriveBroadcastIntentId(deriveBroadcastRoundId(MASTER_SID, 9, "p"), A);
			newReplyIntent(dir, { id: pendingId, msgId: "p", outboxId: "p", fromId: A, clientId: "c", text: BODY, kind: "broadcast" });
			writeCreds(offCfg); setWorkerStatus(offCfg, "connected");
			const log: { to: string; clientId: string }[] = [];
			const stop = startWechatReplyWatcher({ runtimeDir: offCfg.runtimeDir, stateDir: offCfg.stateDir, configPath: offCfg.configPath, intervalMs: 15, fetchImpl: senderFetch(log) });
			await sleep(120); stop();
			assert.equal(log.length, 0, "disabled 时 watcher 不应消费");
			assert.equal(readReplyIntent(dir, pendingId)?.status, "pending", "disabled 应保留 pending");
		} finally { rmSync(offCfg.root, { recursive: true, force: true }); }
		// ③ mode 非法 → fail-closed 到 reply-only（走旧 marker 路径，不写广播 intent）
		const badMode = mkEnv({ channels: { wechat: { reply: { mode: "bogus" } } } });
		try {
			assert.equal(readWechatReplyConfig(badMode.configPath).mode, "reply-only");
			const outboxId = "f".repeat(64);
			putChat(badMode, "m-marker", A, new Date().toISOString(), { state: "injected", outboxId });
			const deps = envDeps(badMode);
			const markerMsgs = [{ role: "user", content: `dedupe:outbox:${outboxId}` }, { role: "assistant", content: [{ type: "text", text: "reply-only 回复" }] }];
			assert.equal(extractWechatReply(markerMsgs, deps).written, true, "非法 mode 应按 reply-only 写 marker intent");
			assert.ok(readReplyIntent(replyIntentDir(badMode.stateDir), deriveReplyIntentId(outboxId)), "缺 deriveReplyIntentId 意图");
			assert.equal(intentFiles(badMode.stateDir).length, 1, "非法 mode 不应写广播 intent（fail-closed）");
			assert.equal(extractWechatReply([{ role: "user", content: "plain" }, { role: "assistant", content: "r" }], deps).reason, "marker-not-first", "非法 mode 不应走广播分支");
			assert.equal(flushWechatBroadcast(deps).count, 0, "reply-only 下 flush 不应写");
		} finally { rmSync(badMode.root, { recursive: true, force: true }); }
		// ④ sessionScope 非法 → fail-closed 到 owner
		const badScope = mkEnv({ channels: { wechat: { reply: { mode: "broadcast", sessionScope: "bogus" } } } });
		try {
			assert.equal(readWechatReplyConfig(badScope.configPath).sessionScope, "owner");
			putChat(badScope, "m-a", A);
			const deps = envDeps(badScope, { sessionId: () => OTHER_SID }); // 非 owner
			assert.equal(flushAfter(extractWechatReply(round("非法scope", 1758000009200, BODY), deps), deps).reason, "not-master-owner");
			assert.equal(intentFiles(badScope.stateDir).length, 0, "非法 scope 未 fail-closed 到 owner");
		} finally { rmSync(badScope.root, { recursive: true, force: true }); }
	});

	// ── 补充：no-stash（settled 无暂存）与 no-known-chats ───────────────
	await check("补充审计面：settled 无暂存 → no-stash；inbox 空 → no-known-chats（零动作）", () => {
		resetWechatBroadcastStash();
		const env = mkEnv(BROADCAST_CFG);
		try {
			const deps = envDeps(env);
			const r = flushWechatBroadcast(deps); // 未先 extract（Esc/中断路径 agent_end 未到）
			assert.equal(r.reason, "no-stash");
			assert.equal(r.count, 0);
			assert.ok(auditRows(env.stateDir).some((x) => x.reason === "no-stash"), "缺 no-stash 审计");
			// 有暂存但 inbox 为空（receive 未开/无已知 chat）→ no-known-chats
			assert.equal(extractWechatReply(round("空集问", 1758000009300, BODY), deps).written, false);
			const r2 = flushWechatBroadcast(deps);
			assert.equal(r2.reason, "no-known-chats");
			assert.equal(intentFiles(env.stateDir).length, 0);
		} finally { resetWechatBroadcastStash(); rmSync(env.root, { recursive: true, force: true }); }
	});
} catch (e) {
	console.error(`主流程异常: ${e instanceof Error ? e.stack : String(e)}`);
	process.exitCode = 1;
}

/** extract（broadcast 分支已暂存）→ flush 的常用串联。 */
function flushAfter(ex: { written: boolean }, deps: ReplyHookDeps): ReturnType<typeof flushWechatBroadcast> {
	void ex;
	return flushWechatBroadcast(deps);
}

clearInterval(keepAlive);
if (failures.length > 0) {
	console.error(`\n${failures.length} 项失败: ${failures.join(" | ")}`);
	process.exitCode = 1;
} else {
	console.log(`\n全部通过（${passed} 组断言块，${Date.now() - t0}ms）`);
}
