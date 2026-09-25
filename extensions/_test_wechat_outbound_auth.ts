/**
 * 0925 P0 · 出站广播收件授权验收单测（A=owner / B=曾发信但被拒 / C=曾授权后撤销）
 *
 * 依据：plans/0925_next_step_by_astra.md §二 第 1 项（规格书）+ 验收条目（机器可判定）：
 *   - B 不生成新广播 intent；
 *   - 预置 B/C 的旧 pending intent → 发送 watcher 对其 fetch=0（终态化，不等开关复活）；
 *   - A 的授权投递通过；
 *   - mode 缺失 / 配置损坏 / owner 不可读 / 解绑重绑 → 均不扩张接收范围；
 *   - reply-only 与命令回执无回归；
 *   - 多用户越权全部用 stub（fake fetch），**不向真实第三方发测试消息**。
 *
 * 关键不变量：
 *   授权集合 = 绑定 owner（credentials.ownerOpenId） ∪ reply.allowOut（显式订阅）
 *   入站白名单 input.allowFrom 与历史私聊（knownChats）**不参与**出站授权裁决。
 *
 * 跑法：`timeout 300 npx tsx extensions/_test_wechat_outbound_auth.ts`
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	extractWechatReply, flushWechatBroadcast, resetWechatBroadcastStash, type ReplyHookDeps,
} from "./wechat-reply-hook.ts";
import {
	listReplyIntents, newReplyIntent, readReplyIntent, replyIntentDir,
	deriveBroadcastIntentId, deriveReplyIntentId, deriveCommandIntentId,
} from "./runtime/wechat-reply.ts";
import { WechatStore } from "./channel-wechat/store.ts";
import { deriveBroadcastClientId, deriveReplyClientId } from "./channel-wechat/send.ts";
import { readWechatReplyConfig, type WechatFetch } from "./runtime-host/wechat-bind.ts";
import { authorizeBroadcastRecipient, readOutboundOwnerOpenId } from "./runtime-host/wechat-outbound-auth.ts";
import { startWechatReplyWatcher } from "./runtime-host/wechat-reply.ts";

const WATCHDOG_MS = 180_000;
const watchdog = setTimeout(() => {
	console.error(`\n[watchdog] 超过 ${WATCHDOG_MS}ms 未结束 —— 判定卡死并强制退出（exit 3）`);
	process.exit(3);
}, WATCHDOG_MS);
watchdog.unref?.();
const keepAlive = setInterval(() => {}, 60_000);

const TOKEN = "ob-auth-bot-token-sentinel-XYZ";
const BASE = "https://ilink-test.example";
const BODY = "桌面结果正文哨兵 OB-BODY-001 🛡️";
const MASTER_SID = "11111111-2222-4333-8444-555555555555";
const A = "openid-AAAAAAAAAAAAAAAAAA@im.wechat"; // owner（绑定身份）
const B = "openid-BBBBBBBBBBBBBBBBBB@im.wechat"; // 曾发信但入站被拒（rejected/not-allowlisted）
const C = "openid-CCCCCCCCCCCCCCCCCC@im.wechat"; // 曾出站订阅、后被撤销
const OLD_OWNER = "openid-OLDOWNEROID@im.wechat"; // 解绑前的旧 owner
const NEW_OWNER = "openid-NEWOWNEROID@im.wechat"; // 重绑后的新 owner
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
function jsonRes(body: unknown, status = 200): Response {
	return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

interface Env { root: string; stateDir: string; runtimeDir: string; configPath: string; }
function mkEnv(config: unknown): Env {
	const root = mkdtempSync(join(tmpdir(), "wechat-outbound-auth-"));
	const env: Env = { root, stateDir: join(root, "state"), runtimeDir: join(root, "runtime"), configPath: join(root, "config.json") };
	mkdirSync(env.stateDir, { recursive: true });
	writeFileSync(env.configPath, JSON.stringify(config));
	return env;
}
function envDeps(env: Env, over: Partial<ReplyHookDeps> = {}): ReplyHookDeps {
	return { stateDir: env.stateDir, runtimeDir: env.runtimeDir, configPath: env.configPath, subagent: () => false, sessionId: () => MASTER_SID, masterSessionId: () => MASTER_SID, ...over };
}
function putChat(env: Env, msgId: string, fromId: string, state = "pending", extra: Record<string, unknown> = {}): void {
	new WechatStore(join(env.runtimeDir, "wechat", "receive")).putInbox({ msgId, fromId, fromNickname: null, text: "in", receivedAt: new Date().toISOString(), state, ...extra } as any);
}
function setWorkerStatus(env: Env, status: string): void {
	const dir = join(env.runtimeDir, "wechat", "receive");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "state.json"), JSON.stringify({ status, updatedAt: new Date().toISOString() }));
}
/** 写凭据（ownerOpenId = 绑定 owner 身份；undefined = 未绑定 owner）。 */
function writeCreds(env: Env, ownerOpenId?: string): void {
	mkdirSync(join(env.runtimeDir, "wechat"), { recursive: true });
	writeFileSync(join(env.runtimeDir, "wechat", "credentials.json"),
		JSON.stringify({ botToken: TOKEN, baseUrl: BASE, boundAt: "test", ...(ownerOpenId ? { ownerOpenId } : {}) }));
}
function setConfig(env: Env, config: unknown): void { writeFileSync(env.configPath, JSON.stringify(config)); }
function auditText(stateDir: string): string {
	try { return readFileSync(join(stateDir, "wechat-reply-audit.jsonl"), "utf8"); } catch { return ""; }
}
function auditRows(stateDir: string): Record<string, unknown>[] {
	return auditText(stateDir).split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as Record<string, unknown>]; } catch { return []; } });
}
function intentFiles(stateDir: string): string[] {
	try { return readdirSync(replyIntentDir(stateDir)).filter((f) => f.endsWith(".json")); } catch { return []; }
}
function senderFetch(log: { to: string; clientId: string }[]): WechatFetch {
	return async (_url, init) => {
		const body = JSON.parse(String(init?.body)) as { msg: { to_user_id: string; client_id: string } };
		log.push({ to: body.msg.to_user_id, clientId: body.msg.client_id });
		return jsonRes({ ret: 0 });
	};
}
function round(firstUserText: string, ts: number, assistantText: string): unknown[] {
	return [
		{ role: "user", content: firstUserText, timestamp: ts },
		{ role: "assistant", content: [{ type: "text", text: assistantText }] },
	];
}
function seedBroadcast(env: Env, fromId: string, roundSeed: string, at?: Date): string {
	const dir = replyIntentDir(env.stateDir);
	const roundId = deriveBroadcastIntentId(roundSeed, fromId); // 64hex，仅当稳定 id 用
	const id = deriveBroadcastIntentId(roundId, fromId);
	newReplyIntent(dir, {
		id, msgId: roundId, outboxId: roundId, fromId,
		clientId: deriveBroadcastClientId(roundId, fromId), text: BODY, kind: "broadcast",
		...(at ? { now: at } : {}),
	});
	return id;
}
async function runWatcher(env: Env, log: { to: string; clientId: string }[], ms = 140): Promise<void> {
	const stop = startWechatReplyWatcher({ runtimeDir: env.runtimeDir, stateDir: env.stateDir, configPath: env.configPath, intervalMs: 15, fetchImpl: senderFetch(log) });
	await sleep(ms); stop();
}

const t0 = Date.now();
try {
	// ── T1 授权裁决纯函数：与入站解耦、owner/订阅/拒绝三态、fail-closed ─────
	await check("T1 authorize：owner∪allowOut 授权；入站白名单/bot 域/owner 不可读均不放行", () => {
		const ctx = { ownerOpenId: A as string | null, allowOut: [C] as readonly string[] };
		assert.deepEqual(authorizeBroadcastRecipient(A, ctx), { authorized: true, role: "owner", reason: "bound-owner" });
		assert.deepEqual(authorizeBroadcastRecipient(C, ctx), { authorized: true, role: "subscriber", reason: "outbound-subscriber" });
		assert.deepEqual(authorizeBroadcastRecipient(B, ctx), { authorized: false, role: null, reason: "not-outbound-subscriber" });
		// owner 不可读（未绑定）→ owner 位缺席：连 A 都不放行（fail-closed）
		assert.deepEqual(authorizeBroadcastRecipient(A, { ownerOpenId: null, allowOut: [] }), { authorized: false, role: null, reason: "owner-unbound" });
		// bot 防环纵深：即使误配进 allowOut 也不放行
		assert.deepEqual(authorizeBroadcastRecipient(BOT, { ownerOpenId: null, allowOut: [BOT] }), { authorized: false, role: null, reason: "bot-domain" });
		// 空/非字符串
		assert.equal(authorizeBroadcastRecipient("", ctx).authorized, false);
	});

	// ── T2 B（rejected + 恰在入站白名单内）不生成新广播 intent；A 授权投递通过 ──
	await check("T2 B rejected 且入站 allowlist 内仍零广播 intent（不复用入站授权）；A 授权投递 fetch=1", async () => {
		resetWechatBroadcastStash();
		// 关键：input.allowFrom=[B] —— 若出站复用入站白名单，B 会泄漏。
		const env = mkEnv({ channels: { wechat: { input: { enabled: true, allowFrom: [B] }, reply: { mode: "broadcast" } } } });
		try {
			putChat(env, "m-a", A, "injected");
			putChat(env, "m-b", B, "rejected", { rejectedReason: "not-allowlisted" });
			putChat(env, "m-c", C, "pending");
			writeCreds(env, A); // 绑定 owner = A；allowOut 缺省 → 授权集合只有 A
			const deps = envDeps(env);
			const known = new WechatStore(join(env.runtimeDir, "wechat", "receive")).knownChats();
			assert.deepEqual(known.map((c) => c.fromId).sort(), [A, B, C].sort(), "候选池应仍含 B/C（授权在下游，不改 knownChats）");
			assert.equal(extractWechatReply(round("帮我汇总桌面结果", 1758000000123, BODY), deps).written, false);
			const r = flushWechatBroadcast(deps);
			assert.equal(r.count, 1, `应只给 owner 写 1 个 intent，实际 ${r.count}`);
			const items = listReplyIntents(replyIntentDir(env.stateDir));
			assert.deepEqual(items.map((i) => i.fromId), [A], "收件人必须只有 A（owner）");
			assert.ok(!intentFiles(env.stateDir).some((f) => readFileSync(join(replyIntentDir(env.stateDir), f), "utf8").includes(B)), "B 不应生成广播 intent");
			const rows = auditRows(env.stateDir);
			assert.ok(rows.some((x) => x.event === "recipients-filtered" && x.authorized === 1 && x.denied === 2), "缺 recipients-filtered(1/2) 审计");
			setWorkerStatus(env, "connected");
			const log: { to: string; clientId: string }[] = [];
			await runWatcher(env, log);
			assert.deepEqual(log.map((l) => l.to), [A], "只有 A 出站");
			assert.equal(items.length, 1);
			assert.equal(readReplyIntent(replyIntentDir(env.stateDir), items[0]!.id)?.status, "sent", "A 的授权投递应通过");
		} finally { resetWechatBroadcastStash(); rmSync(env.root, { recursive: true, force: true }); }
	});

	// ── T3 C 曾授权后撤销：新轮不生成 intent + 已排队旧 pending 终态化 ──────
	await check("T3 C 订阅期内收到 → 撤销后新轮零 C intent、旧 pending failed(broadcast-unauthorized) 且 fetch 不含 C", async () => {
		resetWechatBroadcastStash();
		const env = mkEnv({ channels: { wechat: { reply: { mode: "broadcast", allowOut: [C] } } } });
		try {
			putChat(env, "m-a", A); putChat(env, "m-c", C);
			writeCreds(env, A);
			// 阶段 1：订阅仍在 → C 与 A 都拿到 intent（证明订阅机制有效，C 不是被永久排除）
			const deps = envDeps(env);
			assert.equal(extractWechatReply(round("第一轮结果", 1758000001000, BODY), deps).written, false);
			assert.equal(flushWechatBroadcast(deps).count, 2, "订阅期内应给 A+C 各写 intent");
			// 阶段 2：撤销订阅（allowOut 移除 C）→ 新一轮只有 A
			setConfig(env, { channels: { wechat: { reply: { mode: "broadcast", allowOut: [] } } } });
			assert.deepEqual(readWechatReplyConfig(env.configPath).allowOut, [], "撤销后 allowOut 应为空");
			assert.equal(extractWechatReply(round("第二轮结果", 1758000002000, BODY), deps).written, false);
			assert.equal(flushWechatBroadcast(deps).count, 1, "撤销后只应给 A 写 intent");
			const dir = replyIntentDir(env.stateDir);
			const cItems = listReplyIntents(dir).filter((i) => i.fromId === C);
			assert.equal(cItems.length, 1, "撤销不应产生新的 C intent");
			assert.equal(cItems[0]!.status, "pending");
			// 阶段 3：发送侧二次复核 → 旧 C pending 终态化，A 全部发出
			setWorkerStatus(env, "connected");
			const log: { to: string; clientId: string }[] = [];
			await runWatcher(env, log);
			assert.ok(!log.some((l) => l.to === C), "C 被撤销后不得出站");
			assert.equal(readReplyIntent(dir, cItems[0]!.id)?.status, "failed");
			assert.equal(readReplyIntent(dir, cItems[0]!.id)?.error, "broadcast-unauthorized");
			assert.equal(readReplyIntent(dir, cItems[0]!.id)?.attempts, 0, "撤权 intent 不应消耗 attempts/发起网络请求");
			assert.deepEqual(log.map((l) => l.to).sort(), [A, A].sort(), "A 两轮都应投递通过");
			const rows = auditRows(env.stateDir);
			assert.ok(rows.some((x) => x.event === "denied" && x.reason === "broadcast-unauthorized"), "缺 broadcast-unauthorized 拒绝审计");
			const audit = auditText(env.stateDir);
			assert.ok(!audit.includes(BODY), "审计泄漏正文");
			for (const id of [A, B, C]) assert.ok(!audit.includes(id), `审计泄漏完整 openid: ${id}`);
		} finally { resetWechatBroadcastStash(); rmSync(env.root, { recursive: true, force: true }); }
	});

	// ── T4 旧 pending（B/C）在 reply-only 下终态化；翻回 broadcast 不复活；A 通过 ──
	await check("T4 预置 B/C 旧 pending → watcher fetch=0 并终态化；翻回 mode=broadcast 也不复活；A 授权投递通过", async () => {
		resetWechatBroadcastStash();
		// 与运行态止险一致：mode=reply-only（开关关着也必须把撤权旧广播终态化，不等打开再发）
		const env = mkEnv({ channels: { wechat: { reply: { mode: "reply-only" } } } });
		try {
			writeCreds(env, A); setWorkerStatus(env, "connected");
			const dir = replyIntentDir(env.stateDir);
			const idA = seedBroadcast(env, A, "seed-a");
			const idB = seedBroadcast(env, B, "seed-b");
			const idC = seedBroadcast(env, C, "seed-c");
			const log: { to: string; clientId: string }[] = [];
			await runWatcher(env, log);
			assert.equal(log.length, 0, "reply-only 下不得有任何出站");
			assert.equal(readReplyIntent(dir, idB)?.status, "failed", "B 旧 pending 必须终态化");
			assert.equal(readReplyIntent(dir, idB)?.error, "broadcast-unauthorized");
			assert.equal(readReplyIntent(dir, idC)?.status, "failed", "C 旧 pending 必须终态化");
			assert.equal(readReplyIntent(dir, idC)?.error, "broadcast-unauthorized");
			assert.equal(readReplyIntent(dir, idA)?.status, "pending", "已授权的 A 遵循 mode 门保留 pending（既有 M1 语义）");
			// 翻回 broadcast：撤权 intent 不复活（终态不可迁移），A 续发通过
			setConfig(env, { channels: { wechat: { reply: { mode: "broadcast" } } } });
			await runWatcher(env, log);
			assert.deepEqual(log.map((l) => l.to), [A], "翻回 broadcast 只应发 A（B/C 不复活）");
			assert.equal(readReplyIntent(dir, idA)?.status, "sent");
			assert.equal(readReplyIntent(dir, idB)?.status, "failed");
			assert.equal(readReplyIntent(dir, idC)?.status, "failed");
			const rows = auditRows(env.stateDir);
			assert.equal(rows.filter((x) => x.event === "denied" && x.reason === "broadcast-unauthorized").length, 2, "B/C 各一行拒绝审计");
		} finally { resetWechatBroadcastStash(); rmSync(env.root, { recursive: true, force: true }); }
	});

	// ── T5 mode 缺失 / 配置损坏 / owner 不可读 → 均不扩张接收范围 ───────────
	await check("T5 mode 缺失→reply-only 零广播；配置损坏→只留 owner pending 其余终态；owner 不可读→零收件人 fail-closed", async () => {
		resetWechatBroadcastStash();
		// (a) mode 缺失：广播不隐式开启
		const noMode = mkEnv({});
		try {
			writeCreds(noMode, A);
			putChat(noMode, "m-a", A); putChat(noMode, "m-b", B); putChat(noMode, "m-c", C);
			assert.equal(readWechatReplyConfig(noMode.configPath).mode, "reply-only");
			const deps = envDeps(noMode);
			assert.equal(extractWechatReply(round("缺 mode 轮", 1758000005000, BODY), deps).reason, "marker-not-first");
			assert.equal(flushWechatBroadcast(deps).count, 0, "mode 缺失不应产生广播 intent");
			assert.equal(intentFiles(noMode.stateDir).length, 0);
		} finally { rmSync(noMode.root, { recursive: true, force: true }); }
		// (b) 配置文件整体损坏：allowOut 空 + mode reply-only → 只可能到绑定 owner，且当前不发
		const broken = mkEnv({});
		try {
			writeFileSync(broken.configPath, "{ this is not json");
			assert.deepEqual(readWechatReplyConfig(broken.configPath), { enabled: true, mode: "reply-only", sessionScope: "owner", allowOut: [] });
			writeCreds(broken, A); setWorkerStatus(broken, "connected");
			const dir = replyIntentDir(broken.stateDir);
			const idA = seedBroadcast(broken, A, "broken-a");
			const idB = seedBroadcast(broken, B, "broken-b");
			const log: { to: string; clientId: string }[] = [];
			await runWatcher(broken, log);
			assert.equal(log.length, 0, "坏配置下不得出站");
			assert.equal(readReplyIntent(dir, idB)?.status, "failed", "非 owner 收件人必须终态化（不扩张）");
			assert.equal(readReplyIntent(dir, idA)?.status, "pending", "owner 位保留（mode 门），但零出站");
		} finally { rmSync(broken.root, { recursive: true, force: true }); }
		// (c) owner 不可读（凭据缺失）：连 owner 都不放行 → 零收件人
		const noOwner = mkEnv({ channels: { wechat: { reply: { mode: "broadcast" } } } });
		try {
			putChat(noOwner, "m-a", A); putChat(noOwner, "m-b", B); putChat(noOwner, "m-c", C);
			assert.equal(readOutboundOwnerOpenId(noOwner.runtimeDir), null, "无凭据 → owner 不可读");
			const deps = envDeps(noOwner);
			assert.equal(extractWechatReply(round("无 owner 轮", 1758000006000, BODY), deps).written, false);
			const r = flushWechatBroadcast(deps);
			assert.equal(r.reason, "no-authorized-recipients");
			assert.equal(intentFiles(noOwner.stateDir).length, 0, "owner 不可读不得产生任何广播 intent");
			assert.ok(auditRows(noOwner.stateDir).some((x) => x.reason === "no-authorized-recipients" && x.candidates === 3), "缺 no-authorized_recipients 审计");
			// 预置 A 的旧 pending → 发送侧同样 fail-closed 终态化
			setWorkerStatus(noOwner, "connected");
			const dir = replyIntentDir(noOwner.stateDir);
			const idA = seedBroadcast(noOwner, A, "no-owner-a");
			const log: { to: string; clientId: string }[] = [];
			await runWatcher(noOwner, log);
			assert.equal(log.length, 0);
			assert.equal(readReplyIntent(dir, idA)?.status, "failed");
			assert.equal(readReplyIntent(dir, idA)?.error, "broadcast-unauthorized");
		} finally { resetWechatBroadcastStash(); rmSync(noOwner.root, { recursive: true, force: true }); }
	});

	// ── T6 解绑/更换绑定身份：旧 owner 立即失去接收资格 ─────────────────────
	await check("T6 换绑 owner：旧 owner 的 pending → failed(unauthorized)、fetch 不含旧；新 owner 授权投递通过", async () => {
		resetWechatBroadcastStash();
		const env = mkEnv({ channels: { wechat: { reply: { mode: "broadcast" } } } });
		try {
			putChat(env, "m-old", OLD_OWNER); putChat(env, "m-new", NEW_OWNER);
			writeCreds(env, OLD_OWNER); setWorkerStatus(env, "connected");
			const dir = replyIntentDir(env.stateDir);
			// 换绑前：旧 owner 在位 → 投递通过
			const beforeId = seedBroadcast(env, OLD_OWNER, "bind-before");
			const log: { to: string; clientId: string }[] = [];
			await runWatcher(env, log);
			assert.deepEqual(log.map((l) => l.to), [OLD_OWNER], "在位 owner 应投递通过");
			assert.equal(readReplyIntent(dir, beforeId)?.status, "sent");
			// 换绑：credentials.ownerOpenId → NEW_OWNER
			writeCreds(env, NEW_OWNER);
			assert.equal(readOutboundOwnerOpenId(env.runtimeDir), NEW_OWNER);
			const afterId = seedBroadcast(env, OLD_OWNER, "bind-after");
			await runWatcher(env, log);
			assert.equal(log.length, 1, "换绑后旧 owner 不得再出站");
			assert.equal(readReplyIntent(dir, afterId)?.status, "failed");
			assert.equal(readReplyIntent(dir, afterId)?.error, "broadcast-unauthorized");
			// 新一轮 flush：只给新 owner
			const deps = envDeps(env);
			assert.equal(extractWechatReply(round("换绑后一轮", 1758000007000, BODY), deps).written, false);
			assert.equal(flushWechatBroadcast(deps).count, 1);
			assert.equal(listReplyIntents(dir).find((i) => i.id === afterId) !== undefined, true);
			assert.deepEqual(listReplyIntents(dir).filter((i) => i.status === "pending").map((i) => i.fromId), [NEW_OWNER], "换绑后待发集合只含新 owner");
		} finally { resetWechatBroadcastStash(); rmSync(env.root, { recursive: true, force: true }); }
	});

	// ── T7 reply-only 与命令回执无回归（另一条路径，不受出站授权影响） ────────
	await check("T7 reply-only：marker reply 与 kind=command 回执照发（不受出站授权门）；enabled=false 时 command 仍绕门、reply 保留 pending", async () => {
		const env = mkEnv({ channels: { wechat: { reply: { mode: "reply-only" } } } });
		try {
			writeCreds(env, A); setWorkerStatus(env, "connected"); // owner=A 在位；reply/command 收件人是 B（非 owner）——另一条路径不受出站授权门
			const dir = replyIntentDir(env.stateDir);
			const replyId = deriveReplyIntentId("a".repeat(64));
			newReplyIntent(dir, { id: replyId, msgId: "m-reply", outboxId: "a".repeat(64), fromId: B, clientId: deriveReplyClientId("m-reply", "a".repeat(64)), text: "回执正文" });
			const cmdId = deriveCommandIntentId("m-cmd-1");
			newReplyIntent(dir, { id: cmdId, msgId: "m-cmd-1", outboxId: "o-cmd-1", fromId: B, clientId: "cid-cmd-1", text: "/wechat status 回执", kind: "command" });
			const log: { to: string; clientId: string }[] = [];
			await runWatcher(env, log);
			assert.equal(log.length, 2, "reply 与 command 均应出站（无授权门）");
			assert.equal(readReplyIntent(dir, replyId)?.status, "sent");
			assert.equal(readReplyIntent(dir, cmdId)?.status, "sent");
			// enabled=false：reply 保留 pending，command 仍绕门（L4-S2 既有语义）
			setConfig(env, { channels: { wechat: { reply: { enabled: false, mode: "reply-only" } } } });
			const replyId2 = deriveReplyIntentId("b".repeat(64));
			newReplyIntent(dir, { id: replyId2, msgId: "m-reply-2", outboxId: "b".repeat(64), fromId: B, clientId: deriveReplyClientId("m-reply-2", "b".repeat(64)), text: "关闸回执" });
			const cmdId2 = deriveCommandIntentId("m-cmd-2");
			newReplyIntent(dir, { id: cmdId2, msgId: "m-cmd-2", outboxId: "o-cmd-2", fromId: B, clientId: "cid-cmd-2", text: "关闸命令回执", kind: "command" });
			await runWatcher(env, log);
			assert.equal(log.length, 3, "enabled=false 下只有 command 出站");
			assert.equal(readReplyIntent(dir, replyId2)?.status, "pending", "reply 应保留 pending（既有红线）");
			assert.equal(readReplyIntent(dir, cmdId2)?.status, "sent", "command 回执应绕过 enabled 门（L4-S2）");
		} finally { rmSync(env.root, { recursive: true, force: true }); }
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
