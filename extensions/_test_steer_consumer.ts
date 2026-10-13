/**
 * _test_steer_consumer.ts — steer-consumer（标签页侧消费者）+ steer-runtime 工具守卫
 *
 * 覆盖（plan §7 / F5 前 8 组 + A6/A9 等价断言）：
 *   1. pending → send 收到且 deliverAs:"steer"；回执 delivered + deliveredAt
 *   2. 重复事件/tick 不双注入（seenIds + .claimed 跨实例）
 *   3. 半截 JSON → 不标 seen、下 tick 重试、不崩（A7）
 *   4. 非自己的 tabRunId 目录不被消费（身份门）
 *   5. PI_SUBAGENT=1 不激活消费者
 *   6. tickOnly:true（纯 tick 兜底，Windows 丢事件路径）仍能消费
 *   7. compaction reject → 保持 pending + 释放 .claimed（可重试）；其他 reject → failed
 *   8. 已 delivered 的记录再入事件不重复 send
 *   9. steer-runtime 写前守卫（A6/A9）：未知 tab / 已终态 tab / unsafe tabRunId / 超长 / 非法 mode
 *      一律 isError 且零落盘；happy path 落 pending；mode=abort 被接受；steer-status 惰性 sweep 收敛 undelivered
 *  10-17. fs.watch 事件路径 / 活性判据 / MF-1 / MF-2 / SF-1 / SF-2 / N-1 / N-2 回归
 *  18-23. M2 abort 档：序列 abort → 等 idle → 再发（断言 abort 严格早于 send）、isIdle 恒 false →
 *      failed+still-streaming-after-abort、无 ctx → failed+no-ctx、空 body 纯打断、会话替换后 ctx 刷新、
 *      轮询中会话替换 → failed+stale-ctx
 *  24-26. M2 复审修复：SF-1 abort 档 idle 后发送命中 retryable → 释放认领保持 pending；
 *      SF-2 idle→send 间代次漂移与 send 抛 stale 均归类 stale-ctx；SF-3 一条 abort 轮询不阻塞同 tick steer
 *
 * 全部 IO 落 mkdtempSync 隔离目录；绝不触碰真实 ~/.pi/agent/**。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import {
	MAX_STEER_MESSAGE,
	claimSteerAtomic,
	readAllSteerRecords,
	readSteerRecord,
	releaseSteerClaim,
	steerClaimPath,
	steerFilePath,
	steerTakeoverPath,
	writeSteerAtomic,
	type SteerRecord,
} from "./steer.ts";
import {
	consumeSteerRecord,
	isSteerConsumerActive,
	pollSteer,
	registerSteerConsumer,
	resetSteerConsumer,
} from "./steer-consumer.ts";
import { registerSteerTools, targetTabAlive } from "./steer-runtime.ts";
import { setCurrentSessionId } from "./identity.ts";
import { writeTabDispatch, writeTabState } from "./tab-runs.ts";

// 隔离环境：不是子 agent；扮演标签页 TAB
delete process.env.PI_SUBAGENT;
delete process.env.PI_SESSION_PROFILE;
const TAB = "tab_steer_test_1";
const OTHER_TAB = "tab_steer_other_1";
process.env.PI_TAB_RUN_ID = TAB;
// 隔离 runtime（preInject 在 cutover 下可能写 receipts；本测试不启用 cutover，双保险）
process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "steer-consumer-journal-"));

const steerDir = mkdtempSync(join(tmpdir(), "steer-consumer-"));
const runsDir = mkdtempSync(join(tmpdir(), "steer-consumer-runs-"));
setCurrentSessionId("sess-steer-test-1");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// 全局硬上限（防挂死）：本文件任何路径卡住 → 60s 后强制退出（EXIT=1）。
// unref()：不阻塞正常退出；仅在进程仍存活到 60s 时才触发。
const __hardCap = setTimeout(() => {
	console.error("_test_steer_consumer: HARD TIMEOUT (60s) → 强制退出");
	process.exit(1);
}, 60_000);
__hardCap.unref();

function sample(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "steer_cons_1",
		version: 1,
		tabRunId: TAB,
		mode: "steer",
		body: "立即插入：写一行小结",
		status: "pending",
		createdAt: new Date().toISOString(),
		source: "tab-steer",
		...overrides,
	};
}

function put(id: string, overrides: Record<string, unknown> = {}, tabRunId: string = TAB, dir: string = steerDir): SteerRecord {
	const raw = sample({ id, tabRunId, ...overrides });
	const rec = raw as unknown as SteerRecord;
	writeSteerAtomic(dir, rec);
	return rec;
}

/** 每个用例独立隔离目录（防跨用例遗留 pending 干扰断言）。 */
const freshDir = (): string => mkdtempSync(join(tmpdir(), "steer-consumer-case-"));

/** fake pi：记录 session_start handler + 捕获 send 调用。 */
function makeFakePi(): {
	pi: {
		on: (e: string, h: (ev: unknown, ctx?: unknown) => void) => void;
		sendUserMessage: (c: string, o?: { deliverAs?: string }) => void;
	};
	handlers: Record<string, (ev: unknown, ctx?: unknown) => void>;
	sent: Array<{ body: string; opts?: { deliverAs?: string } }>;
} {
	const handlers: Record<string, (ev: unknown, ctx?: unknown) => void> = {};
	const sent: Array<{ body: string; opts?: { deliverAs?: string } }> = [];
	const pi = {
		on: (e: string, h: (ev: unknown, ctx?: unknown) => void): void => { handlers[e] = h; },
		sendUserMessage: (c: string, o?: { deliverAs?: string }): void => { sent.push({ body: c, opts: o }); },
	};
	return { pi, handlers, sent };
}

type ToolResult = { isError?: boolean; content: Array<{ text: string }> };
type FakeTool = { name: string; execute: (...a: unknown[]) => Promise<ToolResult> };

/** 注册 steer-runtime 工具（隔离 steerDir/runsDir）。 */
function makeTools(steerDir: string, runsDir: string): {
	steerTool: FakeTool;
	statusTool: FakeTool;
	cleanup: () => void;
} {
	const tools = new Map<string, FakeTool>();
	const fakePi = {
		registerTool: (def: { name: string }): void => { tools.set(def.name, def as unknown as FakeTool); },
		on: (_e: string, _h: (ev: unknown, ctx?: unknown) => void): void => { /* no-op */ },
	};
	const cleanup = registerSteerTools(fakePi as never, { steerDir, runsDir });
	return { steerTool: tools.get("tab-steer")!, statusTool: tools.get("steer-status")!, cleanup };
}

// ── 1. pending → delivered（deliverAs:"steer"）───────────────────────
{
	resetSteerConsumer();
	const rec = put("steer_cons_1");
	const sent: Array<{ body: string; opts?: { deliverAs?: string } }> = [];
	const outcome = await consumeSteerRecord(steerDir, TAB, rec.id, {
		sendUserMessage: (body, opts) => { sent.push({ body, opts }); },
	});
	assert.equal(outcome, "delivered", "pending 记录应 delivered");
	assert.equal(sent.length, 1, "send 恰好一次");
	assert.equal(sent[0].body, rec.body, "发送正文 = 记录 body");
	assert.equal(sent[0].opts?.deliverAs, "steer", "deliverAs 必须为 steer");
	const after = readSteerRecord(steerDir, TAB, rec.id)!;
	assert.equal(after.status, "delivered");
	assert.ok(after.deliveredAt, "deliveredAt 必写");
	assert.ok(after.claimedAt, "claimedAt 落盘");
	assert.equal(after.claimedBy, "sess-steer-test-1", "claimedBy = 会话身份");
	assert.ok(existsSync(steerClaimPath(steerDir, TAB, rec.id)), ".claimed sidecar 存在");
}

// ── 2. 重复消费不双注入（内存 + 跨实例 .claimed）───────────────────────
{
	const rec = put("steer_cons_dup");
	const sent: string[] = [];
	const send = (body: string): void => { sent.push(body); };
	assert.equal(await consumeSteerRecord(steerDir, TAB, rec.id, { sendUserMessage: send }), "delivered");
	assert.equal(await consumeSteerRecord(steerDir, TAB, rec.id, { sendUserMessage: send }), "skipped", "同实例第二次 skip");
	// 跨实例/跨 reload：清空内存 seen 后，.claimed 仍然挡住
	resetSteerConsumer();
	assert.equal(await consumeSteerRecord(steerDir, TAB, rec.id, { sendUserMessage: send }), "skipped", "跨实例 .claimed 挡住");
	assert.equal(sent.length, 1, "始终只注入一次");
}

// ── 3. 半截 JSON：不标 seen，补全后重试成功（A7）──────────────────────
{
	resetSteerConsumer();
	const id = "steer_cons_half";
	writeFileSync(steerFilePath(steerDir, TAB, id), '{"id":"steer_cons_half","version":1,', "utf8");
	const sent: string[] = [];
	assert.equal(
		await consumeSteerRecord(steerDir, TAB, id, { sendUserMessage: (b) => { sent.push(b); } }),
		"skipped",
		"半截 JSON → skipped（不崩、不投递）",
	);
	assert.equal(sent.length, 0, "半截 JSON 不注入");
	assert.equal(existsSync(steerClaimPath(steerDir, TAB, id)), false, "半截 JSON 不认领");
	// 补全后下一 tick 正常投递
	writeFileSync(steerFilePath(steerDir, TAB, id), JSON.stringify(sample({ id })), "utf8");
	assert.equal(
		await consumeSteerRecord(steerDir, TAB, id, { sendUserMessage: (b) => { sent.push(b); } }),
		"delivered",
		"补全后重试成功（证明未标 seen）",
	);
	assert.equal(sent.length, 1);
}

// ── 4. 非自己的 tabRunId 目录不被消费（身份门）────────────────────────
{
	resetSteerConsumer();
	put("steer_cons_other", {}, OTHER_TAB);
	const sent: string[] = [];
	const delivered = await pollSteer(steerDir, TAB, { sendUserMessage: (b) => { sent.push(b); } });
	assert.equal(delivered.length, 0, "poll 自己目录：不消费别人的记录");
	assert.equal(sent.length, 0, "别人的记录不注入");
	assert.equal(readSteerRecord(steerDir, OTHER_TAB, "steer_cons_other")!.status, "pending", "别人的记录保持 pending");
	assert.equal(existsSync(steerClaimPath(steerDir, OTHER_TAB, "steer_cons_other")), false, "别人的记录无认领");

	// 目录/记录不一致（畸形记录）：跳过且不注入（防御篡改）
	writeFileSync(
		steerFilePath(steerDir, TAB, "steer_cons_mismatch"),
		JSON.stringify(sample({ id: "steer_cons_mismatch", tabRunId: OTHER_TAB })),
		"utf8",
	);
	assert.equal(
		await consumeSteerRecord(steerDir, TAB, "steer_cons_mismatch", { sendUserMessage: (b) => { sent.push(b); } }),
		"skipped",
		"记录自称 tabRunId 与目录不符 → skipped",
	);
	assert.equal(sent.length, 0, "畸形记录不注入");
}

// ── 5. PI_SUBAGENT=1 不激活消费者 ────────────────────────────────────
{
	resetSteerConsumer();
	process.env.PI_TAB_RUN_ID = TAB;
	process.env.PI_SUBAGENT = "1";
	try {
		const put5 = put("steer_cons_subagent");
		const { pi, handlers, sent } = makeFakePi();
		const cleanup = registerSteerConsumer(pi as never, { steerDir, tickMs: 20 });
		try {
			handlers["session_start"]?.(undefined, { sessionManager: { sessionId: "sess-sub" } });
			await sleep(80);
			assert.equal(isSteerConsumerActive(), false, "子 agent 不注册消费者");
			assert.equal(sent.length, 0, "子 agent 不消费");
			assert.equal(readSteerRecord(steerDir, TAB, put5.id)!.status, "pending", "记录未被消费");
		} finally {
			cleanup();
		}
	} finally {
		delete process.env.PI_SUBAGENT;
	}
}

// ── 6. tickOnly:true（纯 tick 兜底）仍能消费 ─────────────────────────
{
	resetSteerConsumer();
	const d6 = freshDir();
	const { pi, handlers, sent } = makeFakePi();
	const cleanup = registerSteerConsumer(pi as never, { steerDir: d6, tickOnly: true, tickMs: 20 });
	try {
		handlers["session_start"]?.(undefined, { sessionManager: { sessionId: "sess-tick" } });
		assert.equal(isSteerConsumerActive(), true, "tickOnly 下消费者激活（interval）");
		const rec = put("steer_cons_tick", {}, TAB, d6);
		await sleep(150);
		assert.equal(sent.length, 1, "tick 兜底消费一次（无 fs 事件）");
		assert.equal(sent[0].opts?.deliverAs, "steer");
		assert.equal(readSteerRecord(d6, TAB, rec.id)!.status, "delivered");
	} finally {
		cleanup();
	}
}

// ── 7. compaction reject 可重试；其他 reject → failed ────────────────
{
	resetSteerConsumer();
	const d7 = freshDir();
	const retry = put("steer_cons_compaction", {}, TAB, d7);
	assert.equal(
		await consumeSteerRecord(d7, TAB, retry.id, {
			sendUserMessage: () => Promise.reject(new Error("Cannot queue steer during compaction")),
		}),
		"skipped",
		"compaction reject → skipped（可重试）",
	);
	const afterRetry = readSteerRecord(d7, TAB, retry.id)!;
	assert.equal(afterRetry.status, "pending", "compaction 后保持 pending（不写终态）");
	assert.equal(existsSync(steerClaimPath(d7, TAB, retry.id)), false, "compaction 后释放 .claimed 供重试");
	// 释放后确实可重试成功
	const deliveredRetry = await pollSteer(d7, TAB, { sendUserMessage: () => {} });
	assert.deepEqual(deliveredRetry, [retry.id], "释放后重试成功");

	const hardFail = put("steer_cons_fail", {}, TAB, d7);
	assert.equal(
		await consumeSteerRecord(d7, TAB, hardFail.id, {
			sendUserMessage: () => Promise.reject(new Error("Connection error.")),
		}),
		"failed",
		"非 compaction reject → failed",
	);
	const afterFail = readSteerRecord(d7, TAB, hardFail.id)!;
	assert.equal(afterFail.status, "failed");
	assert.equal(afterFail.error, "Connection error.", "error 文本落盘");
	assert.ok(afterFail.failedAt, "failedAt 落盘");
}

// ── 8. 已终态记录再入事件不重复 send ─────────────────────────────────
{
	resetSteerConsumer();
	put("steer_cons_done", { status: "delivered", deliveredAt: new Date().toISOString() });
	const sent: string[] = [];
	assert.equal(
		await consumeSteerRecord(steerDir, TAB, "steer_cons_done", { sendUserMessage: (b) => { sent.push(b); } }),
		"skipped",
		"已 delivered 记录 skip",
	);
	assert.equal(sent.length, 0, "不重复 send");
}

// ── 9. steer-runtime 写前守卫（A6/A9 等价断言）────────────────────
//（F5 第 9 组：任务书 F5 定义为「前 8 组」，此组为 A6/A9 等价自证的补充；不碰 abort 档）
{
	resetSteerConsumer();
	const tools = new Map<string, { name: string; parameters?: { properties?: Record<string, unknown> }; execute: (...a: unknown[]) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> }>();
	const handlers: Record<string, (ev: unknown, ctx?: unknown) => void> = {};
	const fakePi = {
		registerTool: (def: { name: string }): void => { tools.set(def.name, def as never); },
		on: (e: string, h: (ev: unknown, ctx?: unknown) => void): void => { handlers[e] = h; },
	};
	const cleanupTools = registerSteerTools(fakePi as never, { steerDir, runsDir });
	const steerTool = tools.get("tab-steer")!;
	const statusTool = tools.get("steer-status")!;
	assert.ok(steerTool && statusTool, "应注册 tab-steer / steer-status");
	const paramText = (r: { content: Array<{ text: string }> }): string => r.content[0].text;

	try {
		// 主会话身份（可给任意 tab 投递）：清 TAB env
		delete process.env.PI_TAB_RUN_ID;

		// schema 层：mode 为 Union("steer","abort")（M2 两档）
		const modeSchema = JSON.stringify(steerTool.parameters?.properties?.mode ?? null);
		assert.ok(
			modeSchema.includes("steer") && modeSchema.includes("abort"),
			`mode schema 必须同时包含 steer|abort（M2）: ${modeSchema}`,
		);

		// 未知 tab：isError 且零落盘
		const unknownTab = "tab_unknown_guard_x";
		const rUnknown = await steerTool.execute("t1", { tabRunId: unknownTab, message: "hi" });
		assert.equal(rUnknown.isError, true, "未知 tab → isError");
		assert.ok(paramText(rUnknown).includes("unknown tab"), `文案: ${paramText(rUnknown)}`);
		assert.equal(existsSync(join(steerDir, unknownTab)), false, "拒绝时不创建 steer 目录");

		// 已终态 tab：isError
		const termTab = "tab_terminal_guard_x";
		writeTabDispatch(runsDir, {
			id: termTab, version: 1, taskId: "t-term", mode: "workflow", cwd: "C:\\x",
			dispatchedAt: new Date().toISOString(), dispatchStatus: "dispatched",
		});
		writeTabState(runsDir, termTab, { id: termTab, phase: "completed", turn: "idle", terminal: true });
		const rTerm = await steerTool.execute("t2", { tabRunId: termTab, message: "hi" });
		assert.equal(rTerm.isError, true, "已终态 tab → isError");
		assert.ok(paramText(rTerm).includes("terminal"), `文案: ${paramText(rTerm)}`);
		assert.equal(readSteerRecord(steerDir, termTab, "steer_any"), null, "终态 tab 无记录");

		// unsafe tabRunId / 超长 / mode=abort → isError
		const rUnsafe = await steerTool.execute("t3", { tabRunId: "../../evil", message: "hi" });
		assert.equal(rUnsafe.isError, true, "路径注入 tabRunId → isError");
		assert.ok(paramText(rUnsafe).includes("unsafe"), `文案: ${paramText(rUnsafe)}`);
		const rLong = await steerTool.execute("t4", { tabRunId: TAB, message: "x".repeat(MAX_STEER_MESSAGE + 1) });
		assert.equal(rLong.isError, true, "超长 message → isError");

		// happy path：合法派发账本 → 落 pending 记录
		const okTab = "tab_ok_guard_x";
		writeTabDispatch(runsDir, {
			id: okTab, version: 1, taskId: "t-ok", mode: "workflow", cwd: "C:\\x",
			dispatchedAt: new Date().toISOString(), dispatchStatus: "dispatched",
		});
		const rOk = await steerTool.execute("t6", { tabRunId: okTab, message: "立即插入一行小结" });
		assert.equal(rOk.isError, undefined, `happy path 不应报错: ${paramText(rOk)}`);
		assert.ok(paramText(rOk).includes("pending"), "未消费时回执为 pending");
		const written = readAllSteerRecords(steerDir, okTab);
		assert.equal(written.length, 1, "恰好一条记录");
		assert.equal(written[0].status, "pending");
		assert.equal(written[0].source, "tab-steer");

		// M2：mode=abort 被接受（写入 mode=abort 的 pending 记录，不再 isError）
		const rAbortOk = await steerTool.execute("t5b", { tabRunId: okTab, message: "打断：改做 X", mode: "abort" });
		assert.equal(rAbortOk.isError, undefined, `mode=abort 应被接受: ${paramText(rAbortOk)}`);
		const afterAbort = readAllSteerRecords(steerDir, okTab);
		assert.equal(afterAbort.length, 2, "steer + abort 两条记录");
		assert.equal(afterAbort.filter((r) => r.mode === "abort").length, 1, "mode=abort 记录已落盘");
		// abort 档空 message = 纯打断，也被接受
		const rAbortEmpty = await steerTool.execute("t5c", { tabRunId: okTab, message: "", mode: "abort" });
		assert.equal(rAbortEmpty.isError, undefined, "abort + 空 message（纯打断）应被接受");

		// steer-status：读回执 + 惰性 sweep 把「超龄 pending + 目标不活」置 undelivered（A4/A6）
		const deadTab = "tab_dead_guard_x";
		writeTabDispatch(runsDir, {
			id: deadTab, version: 1, taskId: "t-dead", mode: "workflow", cwd: "C:\\x",
			dispatchedAt: new Date().toISOString(), dispatchStatus: "dispatched",
		});
		put("steer_dead_sweep", { createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() }, deadTab);
		const rStatus = await statusTool.execute("t7", { tabRunId: deadTab });
		assert.ok(paramText(rStatus).includes("undelivered"), `惰性 sweep 应收敛: ${paramText(rStatus)}`);
		const dead = readSteerRecord(steerDir, deadTab, "steer_dead_sweep")!;
		assert.equal(dead.status, "undelivered");
		assert.equal(dead.undeliveredReason, "ttl-expired");

		// 标签页身份：只能给自己投递
		process.env.PI_TAB_RUN_ID = TAB;
		writeTabDispatch(runsDir, {
			id: TAB, version: 1, taskId: "t-self", mode: "workflow", cwd: "C:\\x",
			dispatchedAt: new Date().toISOString(), dispatchStatus: "dispatched",
		});
		const rScope = await steerTool.execute("t8", { tabRunId: okTab, message: "hi" });
		assert.equal(rScope.isError, true, "标签页给别的 tab 投递 → isError");
		assert.ok(paramText(rScope).includes("只能给自己"), `文案: ${paramText(rScope)}`);
		const rSelf = await steerTool.execute("t9", { tabRunId: TAB, message: "hi" });
		assert.equal(rSelf.isError, undefined, "标签页给自己投递放行");
	} finally {
		process.env.PI_TAB_RUN_ID = TAB;
		cleanupTools();
	}
}

// ── 10. fs.watch 事件路径（大 tickMs，证明 watch 而非 tick 送达）──
{
	resetSteerConsumer();
	const d10 = freshDir();
	const { pi, handlers, sent } = makeFakePi();
	const cleanup = registerSteerConsumer(pi as never, { steerDir: d10, tickMs: 60_000 });
	try {
		handlers["session_start"]?.(undefined, { sessionManager: { sessionId: "sess-watch" } });
		const rec = put("steer_cons_watch", {}, TAB, d10);
		for (let i = 0; i < 40 && sent.length === 0; i++) await sleep(50); // 最多等 2s
		assert.equal(sent.length, 1, "fs.watch 事件路径送达（tickMs=60s，不可能靠 tick）");
		assert.equal(readSteerRecord(d10, TAB, rec.id)!.status, "delivered");
	} finally {
		cleanup();
	}
}

// ── 11. targetTabAlive 活性判据（sweep 的前提）────────────────────
{
	const now = new Date("2026-10-12T12:00:00.000Z");
	const st = (over: Record<string, unknown> = {}): never => ({
		id: "tab_x", phase: "working", turn: "working", terminal: false, ...over,
	}) as never;
	assert.equal(targetTabAlive(runsDir, "tab_x", now, { readState: () => null }), false, "无 state 账本 → 不活");
	assert.equal(
		targetTabAlive(runsDir, "tab_x", now, { readState: () => st() }),
		false,
		"无 lastActivityAt → 不活（§3.5）",
	);
	assert.equal(
		targetTabAlive(runsDir, "tab_x", now, {
			readState: () => st({ lastActivityAt: new Date(now.getTime() - 60_000).toISOString() }),
		}),
		true,
		"近期活动 → 活（长 tool 批期间 pending 不被误判）",
	);
	assert.equal(
		targetTabAlive(runsDir, "tab_x", now, {
			readState: () => st({ lastActivityAt: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString() }),
		}),
		false,
		"超 stale 窗 → 不活",
	);
	assert.equal(
		targetTabAlive(runsDir, "tab_x", now, { readState: () => st({ terminal: true }) }),
		false,
		"terminal → 不活",
	);
	assert.equal(targetTabAlive(runsDir, "../../evil", now), false, "unsafe tabRunId → 不活（不探）");
}

// 目录隔离自检：全程只写 mkdtemp 目录
assert.ok(steerDir.startsWith(tmpdir()), "steerDir 必须是隔离 tmp 目录");
assert.ok(runsDir.startsWith(tmpdir()), "runsDir 必须是隔离 tmp 目录");

// ── 12. MF-1 回归：claim 成功后崩溃/回执写失败 → 租约接管，不得永久 pending ──
// 等价审查者探针 B：claim 成功 → 进程重启/reload → 该条必须仍能被投递或最终进入终态。
{
	resetSteerConsumer();
	const d12 = freshDir();
	const id = "steer_cons_orphan_claim";
	const rec = put(id, {}, TAB, d12);
	// 模拟「claim 成功但进程随即崩溃」：只留 .claimed sidecar，记录仍 pending
	assert.equal(claimSteerAtomic(d12, TAB, id), true, "先占住 .claimed（模拟崩溃前）");
	assert.equal(readSteerRecord(d12, TAB, id)!.status, "pending", "崩溃后记录仍是 pending");
	// 把 .claimed mtime 拨到租约之前（模拟陈旧认领）
	const old = new Date(Date.now() - 10 * 60 * 1000);
	utimesSync(steerClaimPath(d12, TAB, id), old, old);

	// 模拟 reload：新实例（内存 seen 清空）+ 纯 tick 兜底
	const { pi, handlers, sent } = makeFakePi();
	const cleanup = registerSteerConsumer(pi as never, {
		steerDir: d12, tickOnly: true, tickMs: 20, claimLeaseMs: 60_000,
	});
	try {
		handlers["session_start"]?.(undefined, { sessionManager: { sessionId: "sess-reload" } });
		for (let i = 0; i < 60 && sent.length === 0; i++) await sleep(25);
		assert.equal(sent.length, 1, "stale-claimed-pending 必须被租约接管并投递（不得永久 pending）");
		assert.equal(sent[0].opts?.deliverAs, "steer");
		const after = readSteerRecord(d12, TAB, id)!;
		assert.equal(after.status, "delivered", "最终进入终态（A4：不存在永远是 pending 的孤儿）");
		assert.equal(after.claimedBy, "sess-reload", "接管者落盘 claimedBy");
		assert.equal(rec.body, after.body, "正文未被篡改");
	} finally {
		cleanup();
	}
}

// ── 13. MF-2：标签页 steer-status 不得跨 tab 全量 sweep（越权写）──
{
	resetSteerConsumer();
	const d13 = freshDir();
	const runs13 = freshDir();
	const otherTab = "tab_other_mf2";
	// 别的 tab：超龄 pending（无 state → 不活）+ 超龄终态（全量 sweep 会置终态/删除）
	put("steer_other_old_pending", { createdAt: new Date(Date.now() - 2 * 3600_000).toISOString() }, otherTab, d13);
	put("steer_other_old_terminal", {
		status: "delivered",
		deliveredAt: new Date(Date.now() - 3 * 24 * 3600_000).toISOString(),
		createdAt: new Date(Date.now() - 3 * 24 * 3600_000).toISOString(),
	}, otherTab, d13);

	process.env.PI_TAB_RUN_ID = TAB;
	const { statusTool, cleanup } = makeTools(d13, runs13);
	try {
		const r = await statusTool.execute("mf2-1", {});
		assert.equal(r.isError, undefined, `标签页查自己不应报错: ${r.content[0].text}`);
		assert.equal(
			readSteerRecord(d13, otherTab, "steer_other_old_pending")!.status,
			"pending",
			"标签页不得跨 tab 把别人的 pending 置终态（MF-2）",
		);
		assert.ok(
			existsSync(steerFilePath(d13, otherTab, "steer_other_old_terminal")),
			"标签页不得跨 tab 删除别人的终态记录（MF-2）",
		);
	} finally {
		process.env.PI_TAB_RUN_ID = TAB;
		cleanup();
	}
}

// ── 14. SF-2：steer-status({tabRunId:".."}) 必须显式拒绝，不得读父目录 ──
{
	resetSteerConsumer();
	const root14 = freshDir();
	const d14 = join(root14, "steer");
	mkdirSync(d14, { recursive: true });
	const runs14 = freshDir();
	// 父目录（= root14）放一个合法 steer 记录，模拟越权可读到的文件
	writeFileSync(join(root14, "steer_leak.json"), JSON.stringify(sample({ id: "steer_leak" })), "utf8");
	delete process.env.PI_TAB_RUN_ID; // 主会话身份
	const { statusTool, cleanup } = makeTools(d14, runs14);
	try {
		const r = await statusTool.execute("sf2-1", { tabRunId: ".." });
		assert.equal(r.isError, true, "tabRunId='..' 必须 isError（SF-2）");
		assert.ok(r.content[0].text.includes("unsafe tabRunId"), `文案: ${r.content[0].text}`);
		assert.equal(r.content[0].text.includes("steer_leak"), false, "不得读到父目录 *.json");
	} finally {
		process.env.PI_TAB_RUN_ID = TAB;
		cleanup();
	}
}

// ── 15. SF-1：他人新鲜认领不得被标 seen（否则 stale 接管永远轮不到本实例）──
{
	resetSteerConsumer();
	const d15 = freshDir();
	const id = "steer_cons_peer_claim";
	put(id, {}, TAB, d15);
	// 模拟「他人先认领」
	assert.equal(claimSteerAtomic(d15, TAB, id), true, "他人先占 .claimed");
	// A) 本实例首次消费：新鲜租约 → skipped，且**不得标 seen**
	assert.equal(
		await consumeSteerRecord(d15, TAB, id, { sendUserMessage: () => {}, claimLeaseMs: 60_000 }),
		"skipped",
		"新鲜他人认领 → skipped",
	);
	// B) 把 .claimed 拨旧再消费：同一实例（seen 未被污染）必须能接管投递
	const old = new Date(Date.now() - 10 * 60 * 1000);
	utimesSync(steerClaimPath(d15, TAB, id), old, old);
	const sent: string[] = [];
	assert.equal(
		await consumeSteerRecord(d15, TAB, id, { sendUserMessage: (b) => { sent.push(b); }, claimLeaseMs: 60_000 }),
		"delivered",
		"同一实例 stale 后可接管（SF-1：held 不标 seen）",
	);
	assert.equal(sent.length, 1, "接管后恰好投递一次");
}

// ── 16. N-1 回归（生产 fs.watch 路径）：新鲜 .claimed 崩溃 → 立即 reload → 必须投递 ──
// 复审实测：旧实现 tickOnly=false 时 snapshotExisting 把「新鲜 .claimed」标 seen → 永久 pending。
// 本用例走**生产路径**（tickOnly 缺省 false，即 fs.watch + snapshot），用比生产短得多的租约（50ms）
// 复现「claim 成功 → 崩溃 → 立即 reload」，断言最终 delivered（A4：不存在永远 pending 的孤儿）。
{
	resetSteerConsumer();
	const d16 = freshDir();
	const id = "steer_cons_fresh_crash_reload";
	const rec = put(id, {}, TAB, d16);
	// 模拟崩溃前任一实例已成功认领：新鲜 .claimed + 记录仍 pending
	assert.equal(claimSteerAtomic(d16, TAB, id), true, "崩溃前认领成功（新鲜 .claimed）");
	assert.equal(readSteerRecord(d16, TAB, id)!.status, "pending", "崩溃后记录仍是 pending");

	const { pi, handlers, sent } = makeFakePi();
	// 生产路径：不传 tickOnly（=false）→ ensureWatch 会走 snapshotExisting + fs.watch
	const cleanup = registerSteerConsumer(pi as never, {
		steerDir: d16, tickMs: 20, claimLeaseMs: 50,
	});
	try {
		handlers["session_start"]?.(undefined, { sessionManager: { sessionId: "sess-fresh-reload" } });
		for (let i = 0; i < 100 && sent.length === 0; i++) await sleep(25); // 最多等 2.5s
		assert.equal(
			sent.length,
			1,
			"N-1：生产 fs.watch 路径下新鲜 claim 崩溃→reload 后必须被租约接管投递（不得永久 pending）",
		);
		assert.equal(sent[0].opts?.deliverAs, "steer");
		assert.equal(readSteerRecord(d16, TAB, id)!.status, "delivered", "最终进入终态（A4）");
		assert.equal(rec.body, readSteerRecord(d16, TAB, id)!.body, "正文未被篡改");
	} finally {
		cleanup();
	}
}

// ── 17. N-2 回归：并发接管同一 stale claim 时 CAS 唯一赢家（send 恰好 1 次）──
// 旧实现裸 unlink 非 CAS：两实例先后 unlink+acquire 会双双 claimed → 双投递（违反 A5）。
// 本用例用 4 个 worker 线程在同一 stale claim 上**真正并行**接管；用 `onTakeoverCritical`
// 测试注入点把所有线程在临界点对齐、再按 rank 错峰，使「修复前」必然出现双认领、「修复后」必然恰好 1 个：
//   - 修复后（`<id>.claimed.takeover` 令牌 CAS）：仅 1 线程进入临界区（`arrived===1`），恰好 1 claimed/1 send；
//   - 修复前（裸 unlink）：4 线程都进入临界区（`arrived===4`），错峰后后者删除前者新建 sidecar → 多 claimed。
// 防挂死：全程硬超时 + `finally` 显式 `terminate()`；worker 无 `setInterval`。
{
	resetSteerConsumer();
	const d17 = freshDir();
	const id = "steer_cons_takeover_race";
	const leaseMs = 40;
	const N = 4;
	const TRIALS = 120;
	const staggerMs = 5;

	const go = new SharedArrayBuffer(4);
	const done = new SharedArrayBuffer(4);
	const arrived = new SharedArrayBuffer(4 * TRIALS);
	const finished = new SharedArrayBuffer(4 * TRIALS);
	const claimed = new SharedArrayBuffer(4 * TRIALS);
	const sends = new SharedArrayBuffer(4 * TRIALS);
	const goArr = new Int32Array(go);
	const doneArr = new Int32Array(done);
	const arrivedArr = new Int32Array(arrived);
	const claimedArr = new Int32Array(claimed);
	const sendArr = new Int32Array(sends);

	// 全局硬上限：任何卡住都不得让整轮挂死（超时即 process.exit(1)，不留线程）。
	const hardCap = setTimeout(() => {
		console.error("N-2 race: HARD TIMEOUT (45s) → 强制退出");
		process.exit(1);
	}, 45_000);
	hardCap.unref();

	const workers: Worker[] = [];
	const ready: Array<PromiseWithResolvers<void>> = [];
	for (let i = 0; i < N; i++) {
		const r = Promise.withResolvers<void>();
		ready.push(r);
		const w = new Worker(new URL("./_test_steer_takeover_worker.ts", import.meta.url), {
			workerData: {
				dir: d17, tabRunId: TAB, id, leaseMs, trials: TRIALS,
				go, done, arrived, finished, claimed, sends,
				rank: i, workerCount: N, staggerMs,
			},
		});
		w.once("message", (m) => { if (m === "ready") r.resolve(); });
		w.once("error", (e) => r.reject(e));
		workers.push(w);
	}

	const staleTime = new Date(Date.now() - 10 * 60 * 1000);
	try {
		// 等全部 worker 完成模块加载（不用固定 sleep，避免竞态与空等）
		let readyTimer: ReturnType<typeof setTimeout> | null = null;
		await Promise.race([
			Promise.all(ready.map((r) => r.promise)),
			new Promise<never>((_, rej) => { readyTimer = setTimeout(() => rej(new Error("worker 加载超时")), 10_000); }),
		]).finally(() => { if (readyTimer) clearTimeout(readyTimer); });

		for (let t = 0; t < TRIALS; t++) {
			// 每个 trial 重建「pending 记录 + 陈旧 .claimed」；清掉上一轮可能残留的接管令牌
			releaseSteerClaim(d17, TAB, id);
			rmSync(steerTakeoverPath(d17, TAB, id), { force: true });
			writeSteerAtomic(d17, sample({ id }) as unknown as SteerRecord);
			assert.equal(claimSteerAtomic(d17, TAB, id), true, `trial ${t}: 建立对照认领`);
			utimesSync(steerClaimPath(d17, TAB, id), staleTime, staleTime); // 拨到租约之前
			Atomics.store(goArr, 0, t + 1);
			Atomics.notify(goArr, 0);
			const want = (t + 1) * N;
			const deadline = Date.now() + 15_000;
			while (Atomics.load(doneArr, 0) < want) {
				assert.ok(Date.now() < deadline, `trial ${t}: worker 未在 15s 内返回（防挂死）`);
				await sleep(1);
			}
		}
	} finally {
		clearTimeout(hardCap);
		for (const w of workers) await w.terminate(); // 显式终止：绝不留 worker 线程
	}

	let doubles = 0;
	let zeroWinner = 0;
	for (let t = 0; t < TRIALS; t++) {
		const c = claimedArr[t];
		if (c > 1) doubles++;
		if (c < 1) zeroWinner++;
		// 直接证据：修复后仅令牌持有者进入临界区；修复前所有线程都进入。
		assert.equal(c, 1, `N-2 CAS 失效：trial ${t} 有 ${c} 个并发接管者 claimed（应恰好 1）`);
		assert.equal(sendArr[t], 1, `N-2：trial ${t} send 次数必须恰好 1（实测 ${sendArr[t]}）`);
		assert.equal(arrivedArr[t], 1, `N-2 CAS 失效：trial ${t} 有 ${arrivedArr[t]} 个线程进入接管临界区（应恰好 1）`);
	}
	assert.equal(doubles, 0, `并发接管必须零双认领，实测 doubles=${doubles}/${TRIALS}`);
	assert.equal(zeroWinner, 0, `每个 trial 都应恰好 1 个赢家，实测 zeroWinner=${zeroWinner}/${TRIALS}`);
}

// ── 18. M2 abort 档：序列 abort → 等 idle → 再发（断言 abort 严格早于 send）──
// 硬约束：TUI 下 abort 会 clearAllQueues（清掉已排队 steer），故绝不能「先 steer 再 abort」。
// 本用例用注入的假 ctx（abort/isIdle）与假 send 记录调用序，并在 onAbort 回调里现场读盘。
{
	resetSteerConsumer();
	const d18 = freshDir();
	const id = "steer_abort_order";
	const rec = put(id, { mode: "abort", body: "打断：改做 X" }, TAB, d18);
	const order: string[] = [];
	let observedAtAbort: SteerRecord | null = null;
	// 假时钟：固定推进的单调时间源（时间戳可预测；isIdle 立即 true，不进入轮询）
	let clockMs = Date.parse("2026-10-13T00:00:00.000Z");
	const nowFn = (): Date => new Date(clockMs += 1000);
	const outcome = await consumeSteerRecord(d18, TAB, id, {
		ctx: { abort: (): void => { order.push("abort"); }, isIdle: (): boolean => true },
		sendUserMessage: () => { order.push("send"); },
		onAbort: () => { order.push("onAbort"); observedAtAbort = readSteerRecord(d18, TAB, id); },
		nowFn,
		abortPollIntervalMs: 5,
		abortIdleTimeoutMs: 200,
	});
	assert.equal(outcome, "aborted", "abort 档成功 → aborted");
	assert.deepEqual(order, ["onAbort", "abort", "send"], "顺序固定：onAbort → abort → send");
	assert.ok(order.indexOf("abort") < order.indexOf("send"), "abort 必须严格早于 send（不得先 steer 再 abort）");
	assert.ok(observedAtAbort, "onAbort 时能读到账本");
	assert.equal(observedAtAbort!.status, "pending", "abort 发起时刻仍 pending（不引入中间态）");
	assert.ok(observedAtAbort!.abortedAt, "abort 发起前已落盘 abortedAt（无回执窗口 = 0）");
	assert.equal(observedAtAbort!.deliveredAt, undefined, "abort 前不得有 deliveredAt");
	const final = readSteerRecord(d18, TAB, id)!;
	assert.equal(final.status, "aborted");
	assert.ok(final.abortedAt && final.idleAt && final.deliveredAt, "aborted 必带 abortedAt/idleAt/deliveredAt");
	assert.equal(final.abortedAt, "2026-10-13T00:00:02.000Z", "abortedAt 来自注入的假时钟");
	assert.ok(Date.parse(final.abortedAt!) < Date.parse(final.idleAt!), "abortedAt 早于 idleAt");
	assert.ok(Date.parse(final.idleAt!) < Date.parse(final.deliveredAt!), "idleAt 早于 deliveredAt（先等 idle 再发）");
	assert.equal(final.body, rec.body, "正文未被篡改");
	assert.equal(final.error, undefined, "成功无 error");
}

// ── 19. M2 abort 档：isIdle 恒 false → failed + still-streaming-after-abort（绝不伪造 delivered）──
{
	resetSteerConsumer();
	const d19 = freshDir();
	const id = "steer_abort_stuck";
	put(id, { mode: "abort", body: "x" }, TAB, d19);
	let sendCalls = 0;
	const outcome = await consumeSteerRecord(d19, TAB, id, {
		ctx: { abort: (): void => {}, isIdle: (): boolean => false },
		sendUserMessage: () => { sendCalls++; },
		abortPollIntervalMs: 5,
		abortIdleTimeoutMs: 40,
	});
	assert.equal(outcome, "failed", "abort 后仍非 idle → failed");
	assert.equal(sendCalls, 0, "超时后不得发送消息");
	const final = readSteerRecord(d19, TAB, id)!;
	assert.equal(final.status, "failed");
	assert.equal(final.error, "still-streaming-after-abort", "error 必须为 still-streaming-after-abort");
	assert.ok(final.abortedAt, "abortedAt 保留（abort 确实发起过）");
	assert.equal(final.deliveredAt, undefined, "绝不伪造 delivered");
	assert.ok(final.failedAt);
}

// ── 20. M2 abort 档：无 ctx → failed + no-ctx ──
{
	resetSteerConsumer();
	const d20 = freshDir();
	const id = "steer_abort_noctx";
	put(id, { mode: "abort", body: "x" }, TAB, d20);
	let sendCalls = 0;
	const outcome = await consumeSteerRecord(d20, TAB, id, {
		sendUserMessage: () => { sendCalls++; },
		abortPollIntervalMs: 5,
		abortIdleTimeoutMs: 20,
	});
	assert.equal(outcome, "failed", "无 ctx → failed");
	assert.equal(sendCalls, 0, "无 ctx 不发消息");
	const final = readSteerRecord(d20, TAB, id)!;
	assert.equal(final.status, "failed");
	assert.equal(final.error, "no-ctx");
	assert.equal(final.abortedAt, undefined, "无 ctx 时 abort 未发起，不得写 abortedAt");
}

// ── 21. M2 abort 档：空 body 纯打断（deliveredAt 可缺）──
{
	resetSteerConsumer();
	const d21 = freshDir();
	const id = "steer_abort_empty";
	put(id, { mode: "abort", body: "" }, TAB, d21);
	let sendCalls = 0;
	const outcome = await consumeSteerRecord(d21, TAB, id, {
		ctx: { abort: (): void => {}, isIdle: (): boolean => true },
		sendUserMessage: () => { sendCalls++; },
	});
	assert.equal(outcome, "aborted", "空 body 纯打断 → aborted");
	assert.equal(sendCalls, 0, "空 body 不发消息");
	const final = readSteerRecord(d21, TAB, id)!;
	assert.equal(final.status, "aborted");
	assert.ok(final.abortedAt && final.idleAt, "纯打断仍有 abortedAt/idleAt");
	assert.equal(final.deliveredAt, undefined, "纯打断无 deliveredAt");
}

// ── 22. M2 A8：会话替换（new/fork/switch）后 ctx 刷新，abort 用新 ctx ──
// 记录放 OTHER_TAB 目录：后台 tick 只轮询自己的 TAB 目录，避免与显式 consumeSteerRecord 竞态。
{
	resetSteerConsumer();
	const d22 = freshDir();
	const { pi, handlers } = makeFakePi();
	const cleanup = registerSteerConsumer(pi as never, { steerDir: d22, tickOnly: true, tickMs: 60_000 });
	const abortLog: string[] = [];
	try {
		handlers["session_start"]?.(undefined, {
			sessionManager: { sessionId: "s1" }, abort: (): void => { abortLog.push("old"); }, isIdle: (): boolean => true,
		});
		// 会话替换：session_start 再次触发（新 runner 的 ctx）
		handlers["session_start"]?.(undefined, {
			sessionManager: { sessionId: "s2" }, abort: (): void => { abortLog.push("new"); }, isIdle: (): boolean => true,
		});
		const id = "steer_abort_ctx_refresh";
		put(id, { mode: "abort", body: "x" }, OTHER_TAB, d22);
		const outcome = await consumeSteerRecord(d22, OTHER_TAB, id, {
			sendUserMessage: () => {},
			abortPollIntervalMs: 5,
			abortIdleTimeoutMs: 50,
		});
		assert.equal(outcome, "aborted", "刷新后的 ctx 可用");
		assert.deepEqual(abortLog, ["new"], "会话替换后使用新 ctx（旧 ctx 不再被调用）");
		assert.equal(readSteerRecord(d22, OTHER_TAB, id)!.status, "aborted");
	} finally {
		cleanup();
	}
}

// ── 23. M2 A8 反面：轮询期间会话替换（ctx 代次变化）→ failed + stale-ctx（不半途误发）──
{
	resetSteerConsumer();
	const d23 = freshDir();
	const { pi, handlers } = makeFakePi();
	const cleanup = registerSteerConsumer(pi as never, { steerDir: d23, tickOnly: true, tickMs: 60_000 });
	const sent: string[] = [];
	try {
		// 第一次 session_start：ctx 恒非 idle，abort 后进入轮询
		handlers["session_start"]?.(undefined, { abort: (): void => {}, isIdle: (): boolean => false });
		const id = "steer_abort_stale_midflight";
		put(id, { mode: "abort", body: "x" }, OTHER_TAB, d23);
		const pending = consumeSteerRecord(d23, OTHER_TAB, id, {
			sendUserMessage: (b) => { sent.push(b); },
			abortPollIntervalMs: 15,
			abortIdleTimeoutMs: 5000,
		});
		await sleep(50); // 让轮询真正跑起来
		// 会话替换：ctx 代次前进，旧 ctx 已失效
		handlers["session_start"]?.(undefined, { abort: (): void => {}, isIdle: (): boolean => true });
		const outcome = await pending;
		assert.equal(outcome, "failed", "轮询中会话替换 → failed");
		assert.equal(sent.length, 0, "不得在半途向已失效 ctx 发消息");
		const final = readSteerRecord(d23, OTHER_TAB, id)!;
		assert.equal(final.status, "failed");
		assert.equal(final.error, "stale-ctx");
		assert.equal(final.deliveredAt, undefined, "stale-ctx 绝不伪造 delivered");
	} finally {
		cleanup();
	}
}

// ── 24. SF-1：abort 档 idle 后发送命中 compaction（可重试）→ 释放认领保 pending，下 tick 重试成功 ──
// 修复前：sendAbortMessage 不分类，一律 failed → 终态 aborted+error 且不再重试（与 steer 档口径不一致）。
{
	resetSteerConsumer();
	const d24 = freshDir();
	const id = "steer_abort_retryable";
	put(id, { mode: "abort", body: "打断后改做 X" }, TAB, d24);
	let sendCalls = 0;
	const outcome = await consumeSteerRecord(d24, TAB, id, {
		ctx: { abort: (): void => {}, isIdle: (): boolean => true },
		sendUserMessage: () => {
			sendCalls++;
			return Promise.reject(new Error("Cannot queue steer during compaction"));
		},
		abortPollIntervalMs: 5,
		abortIdleTimeoutMs: 100,
	});
	assert.equal(outcome, "skipped", "SF-1：abort 档 compaction → skipped（可重试，不写终态）");
	assert.equal(sendCalls, 1, "确实尝试发送过一次");
	const afterRetry = readSteerRecord(d24, TAB, id)!;
	assert.equal(afterRetry.status, "pending", "SF-1：可重试失败后保持 pending（不得写 failed/aborted 终态）");
	assert.equal(afterRetry.error, undefined, "SF-1：pending 不得带终态 error");
	assert.ok(afterRetry.abortedAt, "abort 已发生的证据保留在 pending 记录上");
	assert.equal(existsSync(steerClaimPath(d24, TAB, id)), false, "SF-1：释放 .claimed 供下 tick 重试");

	// 释放后下 tick 重试成功（abort → 等 idle → 再发）
	let abortCalls = 0;
	const deliveredIds = await pollSteer(d24, TAB, {
		ctx: { abort: (): void => { abortCalls++; }, isIdle: (): boolean => true },
		sendUserMessage: () => {},
		abortPollIntervalMs: 5,
		abortIdleTimeoutMs: 100,
	});
	assert.deepEqual(deliveredIds, [], "SF-1：abort 档回执为 aborted，不计入 delivered 列表");
	const final = readSteerRecord(d24, TAB, id)!;
	assert.equal(final.status, "aborted", "SF-1：重试后收敛到终态 aborted");
	assert.ok(final.abortedAt && final.idleAt && final.deliveredAt, "重试成功带齐 abortedAt/idleAt/deliveredAt");
	assert.equal(abortCalls, 1, "重试确实再次执行 abort 序列");
}

// ── 25. SF-2：idle 与 send 之间代次漂移 → failed+stale-ctx；send 抛 stale 亦归类 stale-ctx ──
// 修复前：break→send 之间无 ctxGen 复核 → 向已失效 ctx 发送并写 aborted+deliveredAt（假成功）；
//        send 抛 stale 被记成 aborted + 通用 error。
{
	resetSteerConsumer();
	const d25 = freshDir();
	const { pi, handlers } = makeFakePi();
	const cleanup = registerSteerConsumer(pi as never, { steerDir: d25, tickOnly: true, tickMs: 60_000 });
	const sent: string[] = [];
	try {
		let advanced = false;
		handlers["session_start"]?.(undefined, { abort: (): void => {}, isIdle: (): boolean => true });
		const id = "steer_abort_gen_shift";
		put(id, { mode: "abort", body: "x" }, OTHER_TAB, d25);
		const outcome = await consumeSteerRecord(d25, OTHER_TAB, id, {
			// isIdle 返回 true 的同一同步帧内推进 ctx 代次（模拟会话替换恰好插在 break→send 之间）
			ctx: {
				abort: (): void => {},
				isIdle: (): boolean => {
					if (!advanced) {
						advanced = true;
						handlers["session_start"]?.(undefined, { abort: (): void => {}, isIdle: (): boolean => true });
					}
					return true;
				},
			},
			sendUserMessage: (b) => { sent.push(b); },
			abortPollIntervalMs: 5,
			abortIdleTimeoutMs: 500,
		});
		assert.equal(outcome, "failed", "SF-2：idle 与 send 之间代次漂移 → failed");
		assert.equal(sent.length, 0, "SF-2：代次漂移后绝不发送");
		const final = readSteerRecord(d25, OTHER_TAB, id)!;
		assert.equal(final.status, "failed", "SF-2：不得写 aborted（无假成功）");
		assert.equal(final.error, "stale-ctx", "SF-2：error 必须为 stale-ctx");
		assert.equal(final.deliveredAt, undefined, "SF-2：绝不伪造 delivered");
	} finally {
		cleanup();
	}
}
{
	// SF-2 后半：send 抛 stale → failed+stale-ctx（不是 aborted+通用 error）
	resetSteerConsumer();
	const d25b = freshDir();
	const id = "steer_abort_send_stale";
	put(id, { mode: "abort", body: "x" }, TAB, d25b);
	const outcome = await consumeSteerRecord(d25b, TAB, id, {
		ctx: { abort: (): void => {}, isIdle: (): boolean => true },
		sendUserMessage: () => Promise.reject(new Error("This extension ctx is stale after session replacement or reload.")),
		abortPollIntervalMs: 5,
		abortIdleTimeoutMs: 100,
	});
	assert.equal(outcome, "failed", "SF-2：send 抛 stale → failed");
	const final = readSteerRecord(d25b, TAB, id)!;
	assert.equal(final.status, "failed", "SF-2：不得记成 aborted");
	assert.equal(final.error, "stale-ctx", "SF-2：send 的 stale 错归类为 stale-ctx");
	assert.equal(final.deliveredAt, undefined, "SF-2：无 deliveredAt");
}

// ── 26. SF-3：一条 abort 档的长 idle 轮询不得阻塞同 tick 另一条 steer 的投递（head-of-line）──
// 修复前：pollSteer 对每条记录逐条 await → abort 轮询满 30s（此处 400ms）后 steer 才发。
// 并发判据（与 readdir 顺序无关）：普通 steer 的发送时刻**严格落在 abort 轮询窗口 (abortStart, abortEnd) 内**；
// 串行时两段互不重叠（steer 要么整段在 abort 前、要么整段在 abort 后）→ 必落在窗口外。
{
	resetSteerConsumer();
	const d26 = freshDir();
	const abortId = "steer_abort_blocker";
	const plainId = "steer_plain_peer";
	put(abortId, { mode: "abort", body: "打断" }, TAB, d26);
	put(plainId, { mode: "steer", body: "普通 steer" }, TAB, d26);

	const hrt = (): bigint => process.hrtime.bigint();
	let abortStart: bigint | null = null;
	let steerSendAt: bigint | null = null;
	const deliveredIds = await pollSteer(d26, TAB, {
		ctx: { abort: (): void => {}, isIdle: (): boolean => false }, // abort 档：超时前恒非 idle
		onAbort: (): void => { abortStart = hrt(); },
		sendUserMessage: (b) => { if (b === "普通 steer") steerSendAt = hrt(); },
		abortPollIntervalMs: 10,
		abortIdleTimeoutMs: 400,
	});
	const abortEnd = hrt();
	assert.deepEqual(deliveredIds, [plainId], "SF-3：普通 steer 已投递（abort 档回执为 failed，不计入）");
	assert.ok(abortStart, "SF-3：abort 档确实发起（onAbort 被调用）");
	assert.ok(steerSendAt, "SF-3：普通 steer 确实被发送");
	assert.ok(
		steerSendAt! > abortStart!,
		`SF-3：steer 不得早于 abort 档开始（steer-first 串行）：steer-abortStart=${steerSendAt! - abortStart!}ns`,
	);
	assert.ok(
		steerSendAt! < abortEnd - 50_000_000n,
		`SF-3：steer 必须在 abort 轮询窗口内送达（abort-first 串行会拖到 abortEnd 之后）：steer-abortEnd=${Number(steerSendAt! - abortEnd) / 1e6}ms`,
	);
	const abortFinal = readSteerRecord(d26, TAB, abortId)!;
	assert.equal(abortFinal.status, "failed", "SF-3：abort 档仍按自身语义收敛（超时非 idle）");
	assert.equal(abortFinal.error, "still-streaming-after-abort");
	assert.equal(readSteerRecord(d26, TAB, plainId)!.status, "delivered", "SF-3：steer 档终态 delivered");
}

clearTimeout(__hardCap);
console.log("✓ _test_steer_consumer: all assertions passed");
