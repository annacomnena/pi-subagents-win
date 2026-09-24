/**
 * 0924 微信远程斜杠命令旁路 · 离线单测（临时目录，绝不碰真实 ~/.pi/agent/runtime）
 *
 * 规格：plans/0924_wechat_remote_slash_command_research.md（Q3 分级 / Q6 实现面 / Q7 风险 +
 * Hermes 对照 1–4）+ 用户最终裁定（覆盖研究待裁点）：
 *   ① 分级白名单 safe | sensitive | danger（danger 恒拒）
 *   ② **不做二次确认**：不实现 nonce，sensitive 直接执行，但保留审计行
 *   ③ 未知 `/xxx` **显式拒绝、绝不回落成普通文本注入** ← 本文件核心验收（T4）
 *   ④ 通道旁路：命令在进 LLM 之前本地执行（零 LLM、零转写污染、不走 outbox 注入）
 *   ⑤ 缺省 fail-closed：`channels.wechat.remoteCommands.enabled` 缺省关闭
 *   ⑥ 授权双轴：openid 白名单（channels.wechat.input.allowFrom）× 命令许可白名单
 *
 * 覆盖：
 *   T0  分类表（纯函数）：非命令 / 白名单 / danger / 未知四象限
 *   T1  safe：/wechat status → kind=command 回执（含 mode/scope）+ consumed + 零注入
 *   T2  sensitive：/reload → 可注入 fake 的调用点恰 1 次 + 回执「已请求执行」+ 零注入
 *   T3  danger 恒拒：`!rm` / master-attach / export / skill:x → 「该命令不支持远程执行」
 *   T4  **核心**：未知 /xxx → 显式拒绝 + 机器可判定证据「从未进入会话转写/注入通道」
 *   T5  轴一：非白名单 openid → 不 claim、无回执；注入路照旧 not-allowlisted rejected
 *   T6  裁定⑤：能力缺省关闭 → 零副作用、记录留 pending、行为回退到今天
 *   T7  幂等（at-least-once）：记录被重放 → claim 挡住，副作用=1、回执=1
 *   T8  真实改配置：/wechat reply mode broadcast、/wechat reply off、/wechat off（sensitive 免确认）
 *   T9  防环：回执不入会话 → 零 sendUserMessage、零 broadcast intent、flush no-stash、二跑幂等
 *   T10 会话门：subagent / 非 owner → 零副作用
 *   T11 派发面：defaultRemoteCommandDeps 只用内部命令名（从不用用户原文）+ 内部 handler 等价动作
 *   T12 端到端：registerWechatRemoteCommands + fs.watch → 新记录被即时消费成回执
 *   T13 秘密卫生：审计无完整 openid / token / 带参数正文
 *
 * 跑法：`timeout 300 npx tsx extensions/_test_wechat_remote_command.ts`
 * 硬看门狗（EB-004）：超时即非零退出，绝不让进程挂住。
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WechatStore, type InboundRecord } from "./channel-wechat/store.ts";
import { tryInjectPending } from "./runtime-host/wechat-input.ts";
import { listOutboxItems } from "./runtime/message-outbox.ts";
import { extractWechatReply, flushWechatBroadcast } from "./wechat-reply-hook.ts";
import { listReplyIntents, replyIntentDir, type ReplyIntent } from "./runtime/wechat-reply.ts";
import { classifyRemoteCommand, REMOTE_COMMAND_DANGER_TEXT, type RemoteCommandDeps } from "./runtime/wechat-remote-command.ts";
import {
	buildWechatStatusText,
	defaultRemoteCommandDeps,
	registerWechatRemoteCommands,
	scanWechatRemoteCommands,
	WECHAT_REMOTE_RUN_COMMAND,
	type WechatCommandScanOptions,
	type WechatCommandScanReport,
} from "./wechat-command-consumer.ts";
import { setWechatEnabled, setWechatReplyConfig, setWechatReplyMode, writeWechatCreds0600 } from "./runtime-host/wechat-bind.ts";

const WATCHDOG_MS = 180_000;
const watchdog = setTimeout(() => {
	console.error(`\n[watchdog] 超过 ${WATCHDOG_MS}ms 未结束 —— 判定卡死并强制退出（exit 3）`);
	process.exit(3);
}, WATCHDOG_MS);
watchdog.unref?.();

const ALLOWED = "openid-allowed-sentinel-0123456789";
const OTHER = "openid-other-sentinel-0123456789";
const OWNER = "openid-owner-sentinel-0123456789";
const TOKEN = "bot-token-sentinel-XYZ";
const MODEL_ID = "secret-model-id-sentinel";

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

interface Ctx {
	root: string;
	rt: string;
	timers: string;
	cfg: string;
	store: WechatStore;
	owner: { agentAddress: `pi://${string}`; sessionId: string; generation: number; attachedAt: string; lastHeartbeatAt: string; attemptId: string };
	add: (msgId: string, text: string, fromId?: string, receivedAt?: string) => void;
	inj: Parameters<typeof tryInjectPending>[0];
	deps: RemoteCommandDeps;
	counts: { status: number; wechatEnabled: number; replyMode: number; replyEnabled: number; reload: number; compact: number; model: number; thinking: number };
	scan: (over?: Partial<WechatCommandScanOptions>) => WechatCommandScanReport;
	intents: () => ReplyIntent[];
	auditLines: () => string[];
	inputAuditLines: () => string[];
	outbox: () => { text: string }[];
	readCfg: () => { channels?: { wechat?: Record<string, unknown> } };
	rec: (msgId: string) => InboundRecord | undefined;
}

function writeCfg(path: string, remoteEnabled: boolean | null): void {
	const wechat: Record<string, unknown> = {
		enabled: true,
		receive: { enabled: true },
		input: { enabled: true, allowFrom: [ALLOWED] },
	};
	if (remoteEnabled !== null) wechat.remoteCommands = { enabled: remoteEnabled };
	writeFileSync(path, JSON.stringify({ channels: { wechat } }, null, 2) + "\n");
}

const contexts: Ctx[] = [];
function ctx(tag: string, remoteEnabled: boolean | null = true): Ctx {
	const root = mkdtempSync(join(tmpdir(), `wechat-wcmd-${tag}-`));
	// receipts（wcmd: claim）读 defaultRuntimeDir() → 指到本上下文临时根，隔离真实 runtime
	process.env.PI_RUNTIME_DIR = join(root, "runtime");
	const rt = join(root, "runtime");
	const timers = join(root, "timers");
	const cfg = join(root, "config.json");
	const store = new WechatStore(WechatStore.resolveDir(rt));
	writeCfg(cfg, remoteEnabled);
	const owner = {
		agentAddress: "pi://master" as `pi://${string}`,
		sessionId: "owner-session-123",
		generation: 1,
		attachedAt: "",
		lastHeartbeatAt: "",
		attemptId: "",
	};
	const counts = { status: 0, wechatEnabled: 0, replyMode: 0, replyEnabled: 0, reload: 0, compact: 0, model: 0, thinking: 0 };
	const deps: RemoteCommandDeps = {
		wechatStatus: () => {
			counts.status++;
			return buildWechatStatusText({ configPath: cfg, runtimeDir: rt });
		},
		setWechatEnabled: (on) => {
			counts.wechatEnabled++;
			return setWechatEnabled(on, cfg);
		},
		setReplyMode: (mode) => {
			counts.replyMode++;
			return setWechatReplyMode(mode, cfg);
		},
		setReplyEnabled: (on) => {
			counts.replyEnabled++;
			return setWechatReplyConfig(on, cfg);
		},
		reload: () => {
			counts.reload++;
		},
		compact: () => {
			counts.compact++;
		},
		setModel: () => {
			counts.model++;
		},
		setThinking: () => {
			counts.thinking++;
		},
	};
	const stateDir = join(rt, "state");
	const lines = (name: string): string[] => {
		try {
			return readFileSync(join(stateDir, name), "utf8").split("\n").filter((l) => l.trim() !== "");
		} catch {
			return [];
		}
	};
	const c: Ctx = {
		root,
		rt,
		timers,
		cfg,
		store,
		owner,
		add: (msgId, text, fromId = ALLOWED, receivedAt = msgId) => {
			store.putInbox({ msgId, fromId, fromNickname: null, text, receivedAt, state: "pending" });
		},
		inj: { runtimeDir: rt, configPath: cfg, timersDir: timers, stateDir, readOwner: () => owner, alive: () => true },
		deps,
		counts,
		scan: (over = {}) =>
			scanWechatRemoteCommands({
				runtimeDir: rt,
				configPath: cfg,
				stateDir,
				subagent: () => false,
				isOwnerSession: () => true,
				deps,
				...over,
			}),
		intents: () => listReplyIntents(replyIntentDir(stateDir)),
		auditLines: () => lines("wechat-command-audit.jsonl"),
		inputAuditLines: () => lines("wechat-input-audit.jsonl"),
		outbox: () => listOutboxItems(join(stateDir, "message-outbox")) as unknown as { text: string }[],
		readCfg: () => JSON.parse(readFileSync(cfg, "utf8")) as { channels?: { wechat?: Record<string, unknown> } },
		rec: (msgId) => store.readInbox(0).find((x) => x.msgId === msgId),
	};
	contexts.push(c);
	return c;
}

/** 核心不变量：这条记录的文本从未进入任何会话注入/消息通道。 */
function assertNeverEnteredSession(c: Ctx, label: string): void {
	assert.equal(c.outbox().length, 0, `${label}: message-outbox 必须零条目（不存在 dedupe:outbox 待注入项）`);
	const recs = c.store.readInbox(0);
	for (const r of recs) assert.notEqual(r.state, "injected", `${label}: 任何记录都不得为 injected（${r.msgId}）`);
}

interface FakePi {
	ons: Record<string, (event: unknown, ctx?: unknown) => void>;
	commands: Record<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }>;
	sendCalls: { text: string; opts?: { deliverAs?: string; expandPromptTemplates?: boolean } }[];
	modelCalls: string[];
	thinkingCalls: string[];
	on(event: string, cb: (event: unknown, ctx?: unknown) => void): void;
	registerCommand(name: string, def: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }): void;
	sendUserMessage(text: string, opts?: { deliverAs?: string; expandPromptTemplates?: boolean }): void;
	setModel(model: { id: string }): Promise<boolean>;
	setThinkingLevel(level: string): void;
}

function makeFakePi(): FakePi {
	const pi: FakePi = {
		ons: {},
		commands: {},
		sendCalls: [],
		modelCalls: [],
		thinkingCalls: [],
		on(event, cb) {
			pi.ons[event] = cb;
		},
		registerCommand(name, def) {
			pi.commands[name] = def;
		},
		sendUserMessage(text, opts) {
			pi.sendCalls.push({ text, ...(opts ? { opts } : {}) });
		},
		async setModel(model) {
			pi.modelCalls.push(model.id);
			return true;
		},
		setThinkingLevel(level) {
			pi.thinkingCalls.push(level);
		},
	};
	return pi;
}
const asPi = (pi: FakePi): ExtensionAPI => pi as unknown as ExtensionAPI;

const t0 = Date.now();
console.log("微信远程斜杠命令旁路 离线单测（临时 runtimeDir；规格 Q3/Q6/Q7 + 用户裁定①–⑥）：");
try {
	// ── T0 分类表（纯函数）────────────────────────────────────────────
	await check("T0 四象限：非命令 / 白名单 / danger 恒拒 / 未知", () => {
		assert.equal(classifyRemoteCommand("hello 世界").kind, "not-command", "散文不是命令");
		assert.equal(classifyRemoteCommand("/etc/passwd").kind, "not-command", "路径不是命令（首 token 不匹配）");
		assert.equal(classifyRemoteCommand("/").kind, "not-command");
		assert.equal(classifyRemoteCommand("https://example.com/x").kind, "not-command");
		const status = classifyRemoteCommand("/wechat status");
		assert.equal(status.kind, "exec");
		assert.equal(status.kind === "exec" ? status.tier : "", "safe");
		const reload = classifyRemoteCommand("/reload");
		assert.equal(reload.kind, "exec");
		assert.equal(reload.kind === "exec" ? reload.tier : "", "sensitive", "sensitive 档（裁定②：执行但免确认）");
		const off = classifyRemoteCommand("/wechat off");
		assert.equal(off.kind, "exec");
		assert.equal(off.kind === "exec" ? off.tier : "", "sensitive", "/wechat off = sensitive");
		for (const danger of ["!rm -rf /", "/master-attach tok", "/export", "/skill:foo", "$(whoami)", "; rm -rf /", "/new", "/yolo"]) {
			const p = classifyRemoteCommand(danger);
			assert.equal(p.kind, "deny", `${danger} 必须拒绝`);
			assert.equal(p.kind === "deny" ? p.text : "", REMOTE_COMMAND_DANGER_TEXT, `${danger} 必须是 danger 恒拒文案`);
			assert.equal(p.kind === "deny" ? p.reason : "", "danger");
		}
		const unknown = classifyRemoteCommand("/nonexistent-cmd arg");
		assert.equal(unknown.kind, "deny");
		assert.equal(unknown.kind === "deny" ? unknown.reason : "", "unknown");
		assert.ok(unknown.kind === "deny" && unknown.text.startsWith("Unknown command"), "未知命令文案必须以 Unknown command 开头");
		const usageReload = classifyRemoteCommand("/reload now");
		assert.equal(usageReload.kind, "deny");
		assert.equal(usageReload.kind === "deny" ? usageReload.reason : "", "usage", "白名单命令参数非法 → usage 拒（仍不回落正文）");
		const usageModel = classifyRemoteCommand("/model ");
		assert.equal(usageModel.kind, "deny");
		assert.equal(usageModel.kind === "deny" ? usageModel.reason : "", "usage", "/model 空参 → usage 拒");
	});

	// ── T1 safe：/wechat status ──────────────────────────────────────
	await check("T1 /wechat status → kind=command 回执（含 mode/scope）+ consumed + 零注入", () => {
		const c = ctx("t1");
		c.add("m1", "/wechat status");
		const r = c.scan();
		assert.equal(r.accepted, 1, JSON.stringify(r));
		const intents = c.intents();
		assert.equal(intents.length, 1, "恰一条回执 intent");
		assert.equal(intents[0]!.kind, "command", "kind=command（与 reply/broadcast 分型）");
		assert.ok(intents[0]!.text.includes("reply.enabled="), `回执须含 reply.enabled：${intents[0]!.text}`);
		assert.ok(/mode=(broadcast|reply-only)/.test(intents[0]!.text), "回执须含 mode");
		assert.ok(/scope=(owner|main|any)/.test(intents[0]!.text), "回执须含 scope");
		assert.ok(intents[0]!.text.includes("remoteCommands.enabled=true"), "回执须含能力门状态");
		assert.equal(c.rec("m1")?.state, "consumed", "终态 consumed（非 injected）");
		assert.equal(c.rec("m1")?.outboxId, undefined, "consumed 记录不绑 outboxId");
		assertNeverEnteredSession(c, "T1");
		assert.deepEqual(tryInjectPending(c.inj), { injected: false, reason: "empty" }, "注入器拿不到任何 pending（命令已旁路）");
		const audit = c.auditLines().join("\n");
		assert.ok(audit.includes('"command-accepted"'), `审计须含 command-accepted：${audit}`);
		assert.ok(audit.includes('"tier":"safe"'), "审计须含 tier");
	});

	// ── T2 sensitive：/reload（裁定②免确认，fake 验证调用点）───────────
	await check("T2 /reload → deps.reload 恰 1 次 + 回执「已请求执行」+ 零注入", () => {
		const c = ctx("t2");
		c.add("m1", "/reload");
		const r = c.scan();
		assert.equal(r.accepted, 1);
		assert.equal(c.counts.reload, 1, "sensitive 直接执行（无 nonce/确认），调用点恰 1 次");
		assert.equal(c.counts.compact, 0);
		const intents = c.intents();
		assert.equal(intents.length, 1);
		assert.ok(intents[0]!.text.includes("已请求执行 /reload"), `回执措辞保守：${intents[0]!.text}`);
		assertNeverEnteredSession(c, "T2");
		assert.deepEqual(tryInjectPending(c.inj), { injected: false, reason: "empty" });
		const audit = c.auditLines().join("\n");
		assert.ok(audit.includes('"command-accepted"') && audit.includes('"tier":"sensitive"'), "sensitive 执行必须留审计行（裁定②）");
	});

	// ── T3 danger 恒拒 ───────────────────────────────────────────────
	await check("T3 danger（!rm / master-attach / export / skill:x）→ 恒拒回执「该命令不支持远程执行」", () => {
		const c = ctx("t3");
		c.add("d1", "!rm -rf /", ALLOWED, "2020-01-01T00:00:01.000Z");
		c.add("d2", "/master-attach token-arg", ALLOWED, "2020-01-01T00:00:02.000Z");
		c.add("d3", "/export", ALLOWED, "2020-01-01T00:00:03.000Z");
		c.add("d4", "/skill:foo", ALLOWED, "2020-01-01T00:00:04.000Z");
		const r = c.scan();
		assert.equal(r.denied, 4, JSON.stringify(r));
		assert.equal(r.accepted, 0);
		const intents = c.intents();
		assert.equal(intents.length, 4);
		for (const it of intents) assert.ok(it.text.includes(REMOTE_COMMAND_DANGER_TEXT), `恒拒文案：${it.text}`);
		assert.equal(c.counts.reload + c.counts.compact + c.counts.model + c.counts.thinking + c.counts.wechatEnabled + c.counts.replyMode + c.counts.replyEnabled, 0, "danger 不触发任何执行面");
		assertNeverEnteredSession(c, "T3");
		const audit = c.auditLines();
		assert.equal(audit.length, 4);
		for (const line of audit) {
			assert.ok(line.includes('"decision":"command-denied"') && line.includes('"tier":"danger"'), `danger 拒绝审计：${line}`);
		}
	});

	// ── T4 核心验收：未知 /xxx 显式拒绝、绝不进会话 ─────────────────────
	await check("T4 核心：未知 /xxx 显式拒绝 + 三重机器可判定证据（不入转写/不注入/拿不回）", () => {
		const c = ctx("t4");
		const pi = makeFakePi();
		const deps = defaultRemoteCommandDeps(asPi(pi), { configPath: c.cfg, runtimeDir: c.rt });
		c.add("m1", "/nonexistent-cmd please-do-not-inject");
		const r = scanWechatRemoteCommands({
			runtimeDir: c.rt,
			configPath: c.cfg,
			stateDir: join(c.rt, "state"),
			subagent: () => false,
			isOwnerSession: () => true,
			deps,
		});
		assert.equal(r.denied, 1, JSON.stringify(r));
		assert.equal(r.accepted, 0);
		const intents = c.intents();
		assert.equal(intents.length, 1, "必须产出显式拒绝回执");
		assert.ok(intents[0]!.text.startsWith("Unknown command"), `拒绝文案分流（未知→Unknown command）：${intents[0]!.text}`);
		// —— 核心断言（裁定③）：这条文本从未进入任何会话消息路径 ——
		// (a) 零 sendUserMessage 派发：没有任何文本进入 pi 会话（零 LLM、转写零污染）
		assert.equal(pi.sendCalls.length, 0, "核心：未知命令零派发（sendUserMessage 零调用）");
		// (b) 注入通道零条目：不存在任何待注入 outbox 项（也就没有 dedupe:outbox 标记）
		assert.equal(c.outbox().length, 0, "核心：message-outbox 必须零条目");
		// (c) 注入器复跑拿不到记录（consumed 非 pending）→ host 侧随后再跑也注入不了
		assert.deepEqual(tryInjectPending(c.inj), { injected: false, reason: "empty" }, "核心：注入器必须取不到记录");
		assert.equal(c.rec("m1")?.state, "consumed", "核心：记录终态 consumed（非 injected、非 pending）");
		assert.equal(c.rec("m1")?.outboxId, undefined, "核心：无 outboxId → wechat-reply-hook 的 state!==injected 门不可能命中");
		// 补证：即便该回执文本被当作首条 user 消息（结构上不可能），也不会写出 reply intent
		const hook = extractWechatReply([{ role: "user", content: intents[0]!.text }], {
			runtimeDir: c.rt,
			stateDir: join(c.rt, "state"),
			configPath: c.cfg,
		});
		assert.equal(hook.written, false, "回执文本无 marker → 不产生 reply intent");
	});

	// ── T5 轴一：非白名单 openid ─────────────────────────────────────
	await check("T5 非白名单 openid → 不 claim/无回执；注入路照旧 not-allowlisted rejected", () => {
		const c = ctx("t5");
		writeWechatCreds0600(join(c.rt, "wechat", "credentials.json"), { botToken: TOKEN, baseUrl: "https://ilink-test.example", boundAt: "test", ownerOpenId: OWNER });
		c.add("m1", "/wechat status", OTHER, "2020-01-01T00:00:01.000Z");
		c.add("m2", "/reload", OWNER, "2020-01-01T00:00:02.000Z"); // owner openid 属白名单（轴一另一侧）
		const r = c.scan();
		assert.equal(r.notAllowlisted, 1, JSON.stringify(r));
		assert.equal(r.accepted, 1, "owner openid 的命令照常执行（allowFrom / owner 双口径）");
		assert.equal(r.considered, 2);
		assert.equal(c.intents().length, 1, "未授权记录零回执");
		assert.equal(c.rec("m1")?.state, "pending", "未授权记录不 claim 不改终态");
		// 交回注入路 → 今天行为（not-allowlisted rejected）
		const inj1 = tryInjectPending(c.inj);
		assert.equal(inj1.reason, "not-allowlisted");
		assert.equal(c.rec("m1")?.state, "rejected");
		assert.equal(c.rec("m1")?.rejectedReason, "not-allowlisted");
		assert.ok(c.inputAuditLines().join("\n").includes('"not-allowlisted"'), "注入路审计保留");
		assert.equal(c.auditLines().length, 1, "命令审计只记已授权那条");
		assert.equal(c.counts.reload, 1, "未授权那条不执行");
	});

	// ── T6 裁定⑤：能力缺省关闭 → 回退到今天 ───────────────────────────
	await check("T6 能力缺省关闭 → 命令不执行、零副作用、行为回退到今天（照常注入）", () => {
		const c = ctx("t6", null); // config 无 remoteCommands 键 = 缺省
		c.add("m1", "/reload");
		const r = c.scan();
		assert.equal(r.reason, "disabled", JSON.stringify(r));
		assert.equal(c.counts.reload, 0, "缺省关闭绝不能静默执行");
		assert.equal(c.intents().length, 0);
		assert.equal(c.auditLines().length, 0, "零副作用（连审计都不写）");
		assert.equal(c.rec("m1")?.state, "pending", "记录留 pending = 今天行为");
		// 回退到今天：注入路照旧把文本送进会话
		const inj = tryInjectPending(c.inj);
		assert.equal(inj.injected, true, "关闭时行为必须回退到今天");
		assert.equal(c.outbox().length, 1);
		assert.ok(c.outbox()[0]!.text.includes("/reload"), "今天行为 = 原文进入注入正文");
		assert.equal(c.rec("m1")?.state, "injected");
		// 显式开启 false 同样 fail-closed
		writeCfg(c.cfg, false);
		c.add("m2", "/wechat status", ALLOWED, "2020-01-01T00:00:09.000Z");
		assert.equal(c.scan().reason, "disabled");
		assert.equal(c.intents().length, 0);
	});

	// ── T7 幂等（at-least-once 兜底）──────────────────────────────────
	await check("T7 记录被重放（stale 接管场景）→ claim 挡住，副作用=1、回执=1", () => {
		const c = ctx("t7");
		c.add("m1", "/reload");
		assert.equal(c.scan().accepted, 1);
		assert.equal(c.counts.reload, 1);
		assert.equal(c.intents().length, 1);
		// 模拟 at-least-once 重放：记录回到 pending（崩溃恢复/游标重投等价面）
		const rec = c.rec("m1");
		assert.ok(rec);
		c.store.putInbox({ ...rec!, state: "pending" });
		const r2 = c.scan();
		assert.equal(r2.accepted, 0, "重放不再执行");
		assert.equal(r2.alreadyClaimed, 1, JSON.stringify(r2));
		assert.equal(c.counts.reload, 1, "副作用仍 =1（wcmd: 收据 first-wins）");
		assert.equal(c.intents().length, 1, "回执不重复写");
		assert.equal(c.rec("m1")?.state, "consumed", "重放记录被收敛回终态");
	});

	// ── T8 真实改配置 ────────────────────────────────────────────────
	await check("T8 /wechat reply mode broadcast + reply off + off（sensitive 免确认）真实落盘", () => {
		const c = ctx("t8");
		c.add("m1", "/wechat reply mode broadcast", ALLOWED, "2020-01-01T00:00:01.000Z");
		c.add("m2", "/wechat reply off", ALLOWED, "2020-01-01T00:00:02.000Z");
		c.add("m3", "/wechat off", ALLOWED, "2020-01-01T00:00:03.000Z");
		const r = c.scan();
		assert.equal(r.accepted, 3, JSON.stringify(r));
		const intents = c.intents();
		assert.equal(intents.length, 3);
		const texts = intents.map((i) => i.text);
		assert.ok(texts.some((t) => t === "wechat reply.mode=broadcast"), `回执1：${texts.join(" | ")}`);
		assert.ok(texts.some((t) => t === "wechat reply.enabled=off"), `回执2：${texts.join(" | ")}`);
		assert.ok(texts.some((t) => t === "wechat enabled=off"), `回执3：${texts.join(" | ")}`);
		const w = c.readCfg().channels?.wechat as { reply?: { mode?: string; enabled?: boolean }; enabled?: boolean };
		assert.equal(w.reply?.mode, "broadcast", "mode 真实落盘");
		assert.equal(w.reply?.enabled, false, "reply.enabled 真实落盘");
		assert.equal(w.enabled, false, "wechat.enabled 真实落盘（sensitive 免确认直接执行）");
		assert.equal(c.counts.replyMode + c.counts.replyEnabled + c.counts.wechatEnabled, 3);
		assertNeverEnteredSession(c, "T8");
		// 审计行覆盖 sensitive 档（裁定②：免确认但保留审计）
		assert.ok(c.auditLines().join("\n").includes('"tier":"sensitive"'), "sensitive 审计行存在");
	});

	// ── T9 防环：回执不入会话、不进广播环路 ─────────────────────────────
	await check("T9 防环：回执零注入/零 broadcast intent/flush no-stash/二次扫描幂等", async () => {
		const c = ctx("t9");
		c.add("m1", "/reload");
		assert.equal(c.scan().accepted, 1);
		assert.equal(c.intents().length, 1);
		// ① 回执没有进入会话（不产生 turn → 没有 agent_end/agent_settled → 不可能触发广播）
		assertNeverEnteredSession(c, "T9");
		assert.deepEqual(tryInjectPending(c.inj), { injected: false, reason: "empty" }, "回执/命令都不落注入通道");
		// ② intent 面零 broadcast（只有 command）
		assert.equal(c.intents().filter((i) => i.kind === "broadcast").length, 0, "命令轮零广播意图");
		assert.equal(c.intents().filter((i) => i.kind === "command").length, 1);
		// ③ 广播 flush 无暂存 → no-stash（证明命令轮没有可广播内容）
		const flush = flushWechatBroadcast({
			runtimeDir: c.rt,
			stateDir: join(c.rt, "state"),
			configPath: c.cfg,
			subagent: () => false,
			mainSession: () => true,
			sessionId: () => "sid-A",
			masterSessionId: () => "sid-A",
		});
		assert.equal(flush.written, false, "命令轮不产出广播意图");
		assert.equal(c.intents().filter((i) => i.kind === "broadcast").length, 0);
		// ④ 二次扫描幂等（防环：回执不再次触发任何动作）
		const r2 = c.scan();
		assert.equal(r2.reason, "empty", JSON.stringify(r2));
		assert.equal(c.intents().length, 1);
		assert.equal(c.counts.reload, 1);
		await sleep(10);
	});

	// ── T10 会话门 ───────────────────────────────────────────────────
	await check("T10 subagent / 非 owner 会话 → 零副作用（记录留 pending）", () => {
		const c = ctx("t10");
		c.add("m1", "/reload");
		const r1 = c.scan({ subagent: () => true });
		assert.equal(r1.reason, "subagent");
		const r2 = c.scan({ isOwnerSession: () => false });
		assert.equal(r2.reason, "not-owner");
		assert.equal(c.counts.reload, 0);
		assert.equal(c.intents().length, 0);
		assert.equal(c.auditLines().length, 0);
		assert.equal(c.rec("m1")?.state, "pending", "门未过 → 记录不动（回退由注入路决定）");
	});

	// ── T11 派发面：内部命令（从不用用户原文）───────────────────────────
	await check("T11 defaultRemoteCommandDeps 只派发内部命令名 + 内部 handler 执行等价动作", async () => {
		const c = ctx("t11");
		const pi = makeFakePi();
		const deps = defaultRemoteCommandDeps(asPi(pi), { configPath: c.cfg, runtimeDir: c.rt });
		// 只为拿内部命令注册面（不触发 session_start → 不起 watch/tick，避免与手工扫描互扰）
		const dispose = registerWechatRemoteCommands(asPi(pi), {
			runtimeDir: c.rt,
			configPath: c.cfg,
			stateDir: join(c.rt, "state"),
			subagent: () => false,
			isOwnerSession: () => true,
			deps,
		});
		try {
		c.add("m1", "/reload", ALLOWED, "2020-01-01T00:00:01.000Z");
		c.add("m2", "/compact", ALLOWED, "2020-01-01T00:00:02.000Z");
		c.add("m3", `/model ${MODEL_ID}`, ALLOWED, "2020-01-01T00:00:03.000Z");
		c.add("m4", "/thinking high", ALLOWED, "2020-01-01T00:00:04.000Z");
		const r = scanWechatRemoteCommands({
			runtimeDir: c.rt,
			configPath: c.cfg,
			stateDir: join(c.rt, "state"),
			subagent: () => false,
			isOwnerSession: () => true,
			deps,
		});
		assert.equal(r.accepted, 4, JSON.stringify(r));
		assert.equal(pi.sendCalls.length, 4, "每条敏感命令一次派发");
		for (const call of pi.sendCalls) {
			assert.ok(call.text.startsWith(`/${WECHAT_REMOTE_RUN_COMMAND} `), `只允许内部命令名：${call.text}`);
			assert.equal(call.opts?.expandPromptTemplates, true, "必须 expandPromptTemplates 才能走扩展命令派发");
			assert.equal(call.opts?.deliverAs, undefined, "不得传 deliverAs（followUp 队列会拒扩展命令）");
		}
		// 核心：任何一次调用都不是用户原文（用户原文 = 转写污染）
		assert.ok(!pi.sendCalls.some((x) => x.text === "/reload" || x.text === "/compact" || x.text === `/model ${MODEL_ID}` || x.text === "/thinking high"), "绝不用用户原文调 sendUserMessage");
		assert.equal(c.outbox().length, 0, "零注入");
		assert.equal(c.intents().length, 4, "回执照常落盘（与派发结果无关，措辞保守）");
		// 内部 handler（pi 正规派发面）
		const handler = pi.commands[WECHAT_REMOTE_RUN_COMMAND]?.handler;
		assert.ok(handler, "内部命令已注册");
		let reloads = 0;
		let compacts = 0;
		const notified: string[] = [];
		const fakeCtx = {
			reload: async () => {
				reloads++;
			},
			compact: () => {
				compacts++;
			},
			modelRegistry: {
				getAvailable: () => [{ id: MODEL_ID }],
				getAll: () => [],
			},
			ui: { notify: (m: string) => notified.push(m) },
		};
		await handler("reload", fakeCtx);
		await handler("compact", fakeCtx);
		await handler(`model ${MODEL_ID}`, fakeCtx);
		await handler("model no-such-model", fakeCtx);
		await handler("thinking high", fakeCtx);
		await handler("thinking bogus", fakeCtx);
		assert.equal(reloads, 1, "等价 /reload 调用点");
		assert.equal(compacts, 1, "等价 /compact 调用点");
		assert.deepEqual(pi.modelCalls, [MODEL_ID], "只按 id 白名单解析命中的模型");
		assert.deepEqual(pi.thinkingCalls, ["high"], "thinking 枚举校验后才执行");
		assert.ok(notified.some((n) => n.includes("未找到模型")), "未知模型本地提示");
		assert.ok(notified.some((n) => n.includes("用法：/thinking")), "非法 thinking 用法提示");
		} finally {
			dispose();
		}
	});

	// ── T12 端到端：注册 + fs.watch 即时消费 ───────────────────────────
	await check("T12 registerWechatRemoteCommands + fs.watch → 新记录被即时消费成回执（零注入）", async () => {
		const c = ctx("t12");
		// 先建 inbox 目录：注册时 watch 即可建立（缺目录时只能退化到 tick 兜底）
		mkdirSync(join(c.rt, "wechat", "receive", "inbox"), { recursive: true });
		const pi = makeFakePi();
		const dispose = registerWechatRemoteCommands(asPi(pi), {
			runtimeDir: c.rt,
			configPath: c.cfg,
			stateDir: join(c.rt, "state"),
			subagent: () => false,
			isOwnerSession: () => true,
			intervalMs: 2_000,
		});
		try {
			assert.ok(pi.commands[WECHAT_REMOTE_RUN_COMMAND], "注册时即注册内部命令");
			assert.equal(typeof pi.ons["session_start"], "function", "session_start 起 watch/tick");
			pi.ons["session_start"]!({}, {});
			c.add("e2e-1", "/wechat status", ALLOWED, "2020-01-01T00:00:01.000Z");
			const deadline = Date.now() + 12_000;
			while (Date.now() < deadline && c.intents().length === 0) await sleep(50);
			assert.equal(c.intents().length, 1, "fs.watch（或 tick 兜底）必须把记录消费成回执");
			assert.equal(c.intents()[0]!.kind, "command");
			assert.equal(c.rec("e2e-1")?.state, "consumed");
			assertNeverEnteredSession(c, "T12");
			assert.deepEqual(tryInjectPending(c.inj), { injected: false, reason: "empty" });
		} finally {
			dispose();
		}
	});

	// ── T13 秘密卫生 ─────────────────────────────────────────────────
	await check("T13 秘密卫生：审计无完整 openid / token / 带参数正文", () => {
		const c = ctx("t13");
		writeWechatCreds0600(join(c.rt, "wechat", "credentials.json"), { botToken: TOKEN, baseUrl: "https://ilink-test.example", boundAt: "test", ownerOpenId: ALLOWED });
		c.add("m1", "/wechat status", ALLOWED, "2020-01-01T00:00:01.000Z");
		c.add("m2", `/model ${MODEL_ID}`, ALLOWED, "2020-01-01T00:00:02.000Z");
		c.add("m3", "/reload extra-arg-sentinel", ALLOWED, "2020-01-01T00:00:03.000Z");
		c.scan();
		const audit = c.auditLines().join("\n");
		assert.ok(audit.length > 0);
		assert.ok(!audit.includes(ALLOWED), "审计不得含完整 openid");
		assert.ok(!audit.includes(OWNER), "审计不得含 owner openid");
		assert.ok(!audit.includes(TOKEN), "审计不得含 token");
		assert.ok(!audit.includes(MODEL_ID), "审计只记首 token，参数不落盘");
		assert.ok(!audit.includes("extra-arg-sentinel"), "审计不记参数");
		assert.ok(audit.includes('"/model"'), "首 token 可见（可诊断）");
		const files = readdirSync(join(c.root)).length;
		assert.ok(files >= 1);
	});

	// 目录整体卫生：临时根下不得出现 token 哨兵
	await check("T13b 文件面：临时产物零 token 哨兵", () => {
		const walk = (dir: string, out: string[] = []): string[] => {
			for (const e of readdirSync(dir, { withFileTypes: true })) {
				const p = join(dir, e.name);
				if (e.isDirectory()) walk(p, out);
				else out.push(p);
			}
			return out;
		};
		for (const c of contexts) {
			for (const f of walk(c.root)) {
				// credentials.json 是 token 的唯一合法落点（0600），其余文件零哨兵
				if (f.endsWith("credentials.json")) continue;
				let raw = "";
				try {
					raw = readFileSync(f, "utf8");
				} catch {
					continue;
				}
				assert.ok(!raw.includes(TOKEN), `${f} 含 token 哨兵`);
			}
		}
	});
} catch (e) {
	console.error(`主流程异常: ${e instanceof Error ? e.stack : String(e)}`);
	process.exitCode = 1;
} finally {
	try {
		delete process.env.PI_RUNTIME_DIR;
	} catch {
		/* ignore */
	}
	for (const c of contexts) {
		try {
			rmSync(c.root, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}
}

if (failures.length > 0) {
	console.error(`\n${failures.length} 项失败: ${failures.join(" | ")}`);
	process.exitCode = 1;
} else {
	console.log(`\n全部通过（${passed} 组断言块，${Date.now() - t0}ms）`);
}
