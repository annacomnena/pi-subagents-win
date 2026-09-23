/**
 * _test_async_result_watcher.ts — async run 终态 watcher 单元测试
 *
 * 覆盖：
 *   1. running→completed 触发一次
 *   2. 重复写不重注（幂等 + .notified 去重）
 *   3. 半截 JSON 容错（不标 seen，下次 tick 重试）
 *   4. cancelled（类型外溢）兼容
 *   5. 子 agent 不注册 watcher
 *   6. pollUnnotified tick 兜底
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	onRunFile,
	pollUnnotified,
	_resetAsyncResultWatcher,
	registerAsyncResultWatcher,
	isAsyncResultWatcherActive,
} from "./async-result-watcher.ts";
import { claimNotified } from "./event-bus.ts";
import { setCurrentSessionId } from "./identity.ts";
import { claimInjection, releaseInjectionClaim } from "./runtime/receipts.ts";
import { attachMaster, setCutover } from "./runtime/registry.ts";

// 隔离环境：不是子 agent、不是 tab
delete process.env.PI_SUBAGENT;
delete process.env.PI_TAB_RUN_ID;

// 隔离 shadow journal：emit 路径不得写真实 ~/.pi/agent/runtime/
process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "async-watcher-journal-"));

const dir = mkdtempSync(join(tmpdir(), "async-result-watcher-test-"));

// 投递路由（0923 误投修复）：测试统一身份与隔离账本。
// onRunFile fail closed——无 async link 即不消费，故每个用例先 linkAsync 再断言；
// linksPath 全部指向隔离文件，绝不读真实 ~/.pi/agent/links.jsonl。
const ME = "aaaaaaaa-1111-4444-8888-aaaaaaaaaaaa"; // 本进程扮演的派发者 UUID
const FOREIGN = "bbbbbbbb-2222-4444-8888-bbbbbbbbbbbb"; // 无关外会话
const OWNER = "cccccccc-3333-4444-8888-cccccccccccc"; // cutover master owner（非派发者）
const LINKS = join(dir, "links.jsonl");

/** 切换当前会话身份（identity 模块全局状态，逐用例显式设置）。 */
function be(id: string | undefined): void { setCurrentSessionId(id); }

/** 追加一条 async 派发记录（at 缺省当前时间；重名取最近用例传显式 at）。 */
function linkAsync(runId: string, sessionId: string = ME, at?: string): void {
	appendFileSync(LINKS, JSON.stringify({
		sessionId, kind: "async", targetId: runId,
		detail: "test", at: at ?? new Date().toISOString(), pid: process.pid,
	}) + "\n", "utf8");
}

be(ME);

const baseOpts = {
	runsDir: dir,
	linksPath: LINKS,
	toast: false,
	autoInject: false,
};

// L3：注入 send 走 .then 微任务（receipt 只在 sent 后）→ 断言 sent/.notified 前先 flush 微任务队列。
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

// ── 1. running→completed 触发一次 ──────────────────────────────────────
{
	_resetAsyncResultWatcher();
	const sent: string[] = [];
	const opts = { ...baseOpts, autoInject: true, sendUserMessage: (c: string, _o?: unknown) => { sent.push(c); } };

	// 写 running 状态
	const runId = "run_test_running_to_done";
	linkAsync(runId);
	writeFileSync(join(dir, `${runId}.json`), JSON.stringify({
		id: runId, agent: "glm-5.2", task: "实现功能 X", status: "running",
		startedAt: new Date().toISOString(),
	}), "utf8");

	// running 状态不应触发
	const r1 = onRunFile(dir, `${runId}.json`, opts);
	assert.equal(r1, false, "running 状态不应触发");
	assert.equal(sent.length, 0, "running 不应注入");

	// 覆盖为 completed
	writeFileSync(join(dir, `${runId}.json`), JSON.stringify({
		id: runId, agent: "glm-5.2", task: "实现功能 X", status: "completed",
		startedAt: new Date().toISOString(),
		result: { status: "completed", text: "已完成", usage: { cost: 0.005, turns: 3 } },
	}), "utf8");

	const r2 = onRunFile(dir, `${runId}.json`, opts);
	assert.equal(r2, true, "completed 应触发");
	await flush(); // L3：注入 send 在 .then 微任务（receipt 只在 sent 后）
	assert.equal(sent.length, 1, "应注入一次");
	assert.ok(sent[0].includes(runId), `注入应含 runId: ${sent[0]}`);
	assert.ok(sent[0].includes("glm-5.2"), "注入应含 agent");
	assert.ok(sent[0].includes("completed"), "注入应含终态");
	assert.ok(sent[0].includes("async-result"), "注入应含状态标签");

	// .notified 应已创建
	assert.equal(existsSync(join(dir, `${runId}.notified`)), true, "应创建 .notified");
}

// ── 2. 重复写不重注（幂等 + .notified 去重）────────────────────────────
{
	_resetAsyncResultWatcher();
	const sent: string[] = [];
	const opts = { ...baseOpts, autoInject: true, sendUserMessage: (c: string, _o?: unknown) => { sent.push(c); } };

	const runId = "run_dedup_test";
	linkAsync(runId);
	writeFileSync(join(dir, `${runId}.json`), JSON.stringify({
		id: runId, agent: "test", task: "任务 A", status: "completed",
		startedAt: new Date().toISOString(),
		result: { status: "completed", text: "ok" },
	}), "utf8");

	// 第一次：触发
	assert.equal(onRunFile(dir, `${runId}.json`, opts), true, "首次应触发");
	await flush(); // L3：注入 send 在 .then 微任务
	assert.equal(sent.length, 1);

	// 第二次（同一实例，seen 去重）：不触发
	assert.equal(onRunFile(dir, `${runId}.json`, opts), false, "同实例重复应跳过");
	assert.equal(sent.length, 1, "不得重复注入");

	// 模拟跨实例（_reset 后 seen 清空，但 .notified 存在）
	_resetAsyncResultWatcher();
	assert.equal(onRunFile(dir, `${runId}.json`, opts), false, "跨实例 .notified 应跳过");
	assert.equal(sent.length, 1, "不得重复注入（跨实例）");
}

// ── 3. 半截 JSON 容错 ──────────────────────────────────────────────────
{
	_resetAsyncResultWatcher();
	const sent: string[] = [];
	const opts = { ...baseOpts, autoInject: true, sendUserMessage: (c: string, _o?: unknown) => { sent.push(c); } };

	const runId = "run_half_json";
	linkAsync(runId);

	// 写半截 JSON（模拟非原子覆盖写中间态）
	writeFileSync(join(dir, `${runId}.json`), `{"id":"run_half_json","stat`, "utf8");

	// 半截 JSON 不应触发，也不应标 seen
	assert.equal(onRunFile(dir, `${runId}.json`, opts), false, "半截 JSON 不应触发");
	assert.equal(sent.length, 0);
	// seen 不应包含此 runId（下次 tick 可重试）
	// 验证：pollUnnotified 应该能找到它（如果补全 JSON 后）
	// 先验证：当前半截状态下 pollUnnotified 也不应触发
	assert.deepEqual(pollUnnotified(dir, opts), [], "半截 JSON 时 pollUnnotified 不触发");

	// 补全 JSON（模拟写入完成）
	writeFileSync(join(dir, `${runId}.json`), JSON.stringify({
		id: runId, agent: "test", task: "半截测试", status: "completed",
		startedAt: new Date().toISOString(),
		result: { status: "completed", text: "ok" },
	}), "utf8");

	// 补全后应触发
	assert.equal(onRunFile(dir, `${runId}.json`, opts), true, "补全后应触发");
	await flush(); // L3：注入 send 在 .then 微任务
	assert.equal(sent.length, 1);
}

// ── 4. cancelled（类型外溢）兼容 ───────────────────────────────────────
{
	_resetAsyncResultWatcher();
	const sent: string[] = [];
	const opts = { ...baseOpts, autoInject: true, sendUserMessage: (c: string, _o?: unknown) => { sent.push(c); } };

	const runId = "run_cancelled_test";
	linkAsync(runId);
	writeFileSync(join(dir, `${runId}.json`), JSON.stringify({
		id: runId, agent: "test", task: "取消测试", status: "cancelled",
		startedAt: new Date().toISOString(),
		result: { status: "cancelled", text: "", error: "用户取消" },
	}), "utf8");

	// cancelled 是终态（status !== "running"），应触发
	assert.equal(onRunFile(dir, `${runId}.json`, opts), true, "cancelled 应触发");
	await flush(); // L3：注入 send 在 .then 微任务
	assert.equal(sent.length, 1);
	assert.ok(sent[0].includes("cancelled"), `注入应含 cancelled: ${sent[0]}`);
	assert.ok(sent[0].includes("用户取消"), "注入应含 error 摘要");
}

// ── 4b. failed 兼容 ────────────────────────────────────────────────────
{
	_resetAsyncResultWatcher();
	const sent: string[] = [];
	const opts = { ...baseOpts, autoInject: true, sendUserMessage: (c: string, _o?: unknown) => { sent.push(c); } };

	const runId = "run_failed_test";
	linkAsync(runId);
	writeFileSync(join(dir, `${runId}.json`), JSON.stringify({
		id: runId, agent: "test", task: "失败测试", status: "failed",
		startedAt: new Date().toISOString(),
		result: { status: "failed", text: "", error: "API error: Connection error." },
	}), "utf8");

	assert.equal(onRunFile(dir, `${runId}.json`, opts), true, "failed 应触发");
	await flush(); // L3：注入 send 在 .then 微任务
	assert.equal(sent.length, 1);
	assert.ok(sent[0].includes("failed"), "注入应含 failed");
	assert.ok(sent[0].includes("Connection error"), "注入应含 error 摘要");
}

// ── 5. 非 run_*.json 文件不触发 ─────────────────────────────────────────
{
	_resetAsyncResultWatcher();
	const sent: string[] = [];
	const opts = { ...baseOpts, autoInject: true, sendUserMessage: (c: string, _o?: unknown) => { sent.push(c); } };

	// *_full.md 不应触发
	writeFileSync(join(dir, "abc_full.md"), "some full text", "utf8");
	assert.equal(onRunFile(dir, "abc_full.md", opts), false, "full.md 不应触发");

	// 不以 run_ 开头的 .json 不应触发
	writeFileSync(join(dir, "other.json"), JSON.stringify({ id: "x", status: "completed" }), "utf8");
	assert.equal(onRunFile(dir, "other.json", opts), false, "非 run_ 前缀不应触发");

	// .notified 文件不应触发
	writeFileSync(join(dir, "run_abc.notified"), "", "utf8");
	assert.equal(onRunFile(dir, "run_abc.notified", opts), false, ".notified 不应触发");

	assert.equal(sent.length, 0);
}

// ── 6. pollUnnotified tick 兜底 ────────────────────────────────────────
{
	_resetAsyncResultWatcher();
	const sent: string[] = [];
	const subDir = join(dir, "poll-test");
	mkdirSync(subDir, { recursive: true });
	const opts = { runsDir: subDir, linksPath: LINKS, toast: false, autoInject: true, sendUserMessage: (c: string, _o?: unknown) => { sent.push(c); } };

	// 启动前已有 completed run（无 .notified）→ tick 应补投
	const runId = "run_tick_fallback";
	linkAsync(runId);
	writeFileSync(join(subDir, `${runId}.json`), JSON.stringify({
		id: runId, agent: "test", task: "tick 测试", status: "completed",
		startedAt: new Date().toISOString(),
		result: { status: "completed", text: "ok" },
	}), "utf8");

	// pollUnnotified 应找到并处理
	const fired = pollUnnotified(subDir, opts);
	assert.equal(fired.length, 1, "tick 应找到未投递的 completed run");
	assert.equal(fired[0], `${runId}.json`);
	await flush(); // L3：注入 send 在 .then 微任务
	assert.equal(sent.length, 1);

	// 再 poll → 已 seen，不再触发
	assert.deepEqual(pollUnnotified(subDir, opts), [], "重复 tick 幂等");
	assert.equal(sent.length, 1, "不得重复注入");
}

// ── 7. pollUnnotified 跳过已有 .notified 的文件 ─────────────────────────
{
	_resetAsyncResultWatcher();
	const sent: string[] = [];
	const subDir = join(dir, "poll-notified");
	mkdirSync(subDir, { recursive: true });
	const opts = { runsDir: subDir, linksPath: LINKS, toast: false, autoInject: true, sendUserMessage: (c: string, _o?: unknown) => { sent.push(c); } };

	const runId = "run_already_notified";
	linkAsync(runId);
	writeFileSync(join(subDir, `${runId}.json`), JSON.stringify({
		id: runId, agent: "test", task: "已投递", status: "completed",
		startedAt: new Date().toISOString(),
		result: { status: "completed", text: "ok" },
	}), "utf8");
	// 已有 .notified（其他实例已投递）
	writeFileSync(join(subDir, `${runId}.notified`), "", "utf8");

	// pollUnnotified 应跳过（claimNotified 会失败）
	assert.deepEqual(pollUnnotified(subDir, opts), [], "已 .notified 的 run 不应重复投递");
	assert.equal(sent.length, 0);
}

// ── 8. registerAsyncResultWatcher：子 agent 不注册 ─────────────────────
{
	_resetAsyncResultWatcher();

	const makePi = () => {
		const handlers: Record<string, unknown> = {};
		return {
			on: (evt: string, h: unknown) => { handlers[evt] = h; },
			sendUserMessage: (_c: string, _o?: unknown) => {},
		};
	};

	// 子 agent：不注册 watcher
	process.env.PI_SUBAGENT = "1";
	const pi1 = makePi() as never;
	const cleanup1 = registerAsyncResultWatcher(pi1, { runsDir: dir });
	assert.ok(typeof cleanup1 === "function");
	// 触发 session_start
	const sessionStart = (pi1 as unknown as { on: (e: string, h: (e: unknown, c?: unknown) => void) => void }).on;
	// 通过直接调用 session_start handler 来测试（不依赖 pi 的事件机制）
	// 这里验证：子 agent 时 isAsyncResultWatcherActive 应为 false
	assert.equal(isAsyncResultWatcherActive(), false, "子 agent 时 watcher 不应激活");
	cleanup1();
	delete process.env.PI_SUBAGENT;
}

// ── 9. registerAsyncResultWatcher：主会话注册成功 ──────────────────────
{
	_resetAsyncResultWatcher();

	const makePi = () => {
		const handlers: Record<string, (e: unknown, c?: unknown) => void> = {};
		return {
			on: (evt: string, h: (e: unknown, c?: unknown) => void) => { handlers[evt] = h; },
			sendUserMessage: (_c: string, _o?: unknown) => {},
			__handlers: handlers,
		};
	};

	const pi2 = makePi();
	const cleanup2 = registerAsyncResultWatcher(pi2 as never, { runsDir: dir });
	assert.ok(typeof cleanup2 === "function");

	// 手动触发 session_start（模拟 pi 事件）
	const handlers = (pi2 as { __handlers: Record<string, (e: unknown, c?: unknown) => void> }).__handlers;
	handlers["session_start"]?.(undefined, {
		sessionManager: { sessionId: "test-session-uuid" },
	} as never);

	assert.equal(isAsyncResultWatcherActive(), true, "主会话 session_start 后 watcher 应激活");
	cleanup2();
	assert.equal(isAsyncResultWatcherActive(), false, "cleanup 后 watcher 应关闭");
	_resetAsyncResultWatcher();
}

// ── 10. onRunFinished hook（返回 true 跳过默认注入）─────────────────────
{
	_resetAsyncResultWatcher();
	const sent: string[] = [];
	be(ME); // 用例 9 改写了全局会话身份，此处恢复派发者身份
	let hookCalled = false;
	const opts = {
		...baseOpts,
		autoInject: true,
		sendUserMessage: (c: string, _o?: unknown) => { sent.push(c); },
		onRunFinished: (runId: string) => { hookCalled = true; assert.equal(runId, "run_hook_test"); return true; },
	};

	const runId = "run_hook_test";
	linkAsync(runId);
	writeFileSync(join(dir, `${runId}.json`), JSON.stringify({
		id: runId, agent: "test", task: "hook 测试", status: "completed",
		startedAt: new Date().toISOString(),
		result: { status: "completed", text: "ok" },
	}), "utf8");

	assert.equal(onRunFile(dir, `${runId}.json`, opts), true, "hook 路径应返回 true");
	assert.equal(hookCalled, true, "hook 应被调用");
	assert.equal(sent.length, 0, "hook 返回 true 时不应默认注入");
}

// ── 11. 注入内容不含全文（只含 runId/agent/终态/产物路径）────────────────
{
	_resetAsyncResultWatcher();
	const sent: string[] = [];
	const opts = { ...baseOpts, autoInject: true, sendUserMessage: (c: string, _o?: unknown) => { sent.push(c); } };

	const runId = "run_no_fulltext";
	be(ME);
	linkAsync(runId);
	const fullText = "x".repeat(5000); // 大段文本
	writeFileSync(join(dir, `${runId}.json`), JSON.stringify({
		id: runId, agent: "big-model", task: "长任务", status: "completed",
		startedAt: new Date().toISOString(),
		result: { status: "completed", text: fullText, usage: { cost: 0.1, turns: 10 } },
	}), "utf8");

	assert.equal(onRunFile(dir, `${runId}.json`, opts), true);
	await flush(); // L3：注入 send 在 .then 微任务
	assert.equal(sent.length, 1);
	assert.ok(!sent[0].includes(fullText), "注入不得含全文");
	assert.ok(sent[0].includes(runId), "注入应含 runId");
	assert.ok(sent[0].includes("big-model"), "注入应含 agent");
	assert.ok(sent[0].includes("completed"), "注入应含终态");
	assert.ok(sent[0].includes(".json"), "注入应含产物路径");
	assert.ok(sent[0].includes("status"), "注入应指引用 status 取全文");
	assert.ok(sent[0].includes("busy-poll"), "注入应含禁轮询纪律");
}

// ── 12. 空文件容错 ─────────────────────────────────────────────────────
{
	_resetAsyncResultWatcher();
	const sent: string[] = [];
	const opts = { ...baseOpts, autoInject: true, sendUserMessage: (c: string, _o?: unknown) => { sent.push(c); } };

	const runId = "run_empty_file";
	writeFileSync(join(dir, `${runId}.json`), "", "utf8"); // 空文件

	assert.equal(onRunFile(dir, `${runId}.json`, opts), false, "空文件不应触发");
	assert.equal(sent.length, 0);
}

// ── 13. claimNotified 跨实例去重验证 ───────────────────────────────────
{
	_resetAsyncResultWatcher();
	const subDir = join(dir, "claim-test");
	mkdirSync(subDir, { recursive: true });

	const runId = "run_claim_verify";
	writeFileSync(join(subDir, `${runId}.json`), JSON.stringify({
		id: runId, agent: "test", task: "claim 测试", status: "completed",
		startedAt: new Date().toISOString(),
		result: { status: "completed", text: "ok" },
	}), "utf8");

	// 第一个实例：claim 成功
	assert.equal(claimNotified(subDir, runId), true, "首次 claim 应成功");
	// 第二个实例：claim 失败
	assert.equal(claimNotified(subDir, runId), false, "二次 claim 应失败");
}

// ── 14. L3: busy 不标记 delivered 且不 disable，下 tick 重试成功 ──────────
{
	_resetAsyncResultWatcher();
	const sent: string[] = [];
	const subDir = join(dir, "l3-busy-retry");
	mkdirSync(subDir, { recursive: true });
	const runId = "run_l3_busy_retry";
	be(ME);
	linkAsync(runId);
	writeFileSync(join(subDir, `${runId}.json`), JSON.stringify({
		id: runId, agent: "test", task: "busy 重试", status: "completed",
		startedAt: new Date().toISOString(),
		result: { status: "completed", text: "ok" },
	}), "utf8");

	let busy = true;
	const opts = {
		runsDir: subDir, linksPath: LINKS, toast: false, autoInject: true,
		sendUserMessage: (c: string, _o?: unknown) => {
			if (busy) return Promise.reject(new Error("Agent is already processing a prompt."));
			sent.push(c);
		},
	};
	// 第一次：agent 忙 → 未真正注入
	const r1 = onRunFile(subDir, `${runId}.json`, opts);
	assert.equal(r1, true, "busy 时 onRunFile 仍返回 true（已尝试，下 tick 重试）");
	await flush();
	assert.equal(sent.length, 0, "busy 不得标记 delivered（不注入）");
	assert.equal(existsSync(join(subDir, `${runId}.notified`)), false, "busy 应释放 .notified 供下 tick 重试");

	// 下 tick：未 disable、未 seen → 重试（仍 busy → 仍不注入）
	const fired1 = pollUnnotified(subDir, opts);
	assert.equal(fired1.length, 1, "busy 后下 tick 应重试（未 disable）");
	await flush();
	assert.equal(sent.length, 0, "仍 busy 不注入");
	assert.equal(existsSync(join(subDir, `${runId}.notified`)), false, "仍 busy 仍释放 .notified");

	// agent 空闲 → 下 tick 重试成功
	busy = false;
	const fired2 = pollUnnotified(subDir, opts);
	assert.equal(fired2.length, 1, "空闲后下 tick 应重投");
	await flush();
	assert.equal(sent.length, 1, "空闲后重试应注入一次");
	assert.ok(sent[0].includes(runId), "重试注入应含 runId");
	assert.equal(existsSync(join(subDir, `${runId}.notified`)), true, "成功后 .notified 应重建");
}

// ── 15. L3: failed 照旧（真实失败 → 不标记 delivered、selfDisable 停止注入）──
{
	_resetAsyncResultWatcher();
	const sent: string[] = [];
	const subDir = join(dir, "l3-failed");
	mkdirSync(subDir, { recursive: true });
	const runId = "run_l3_failed";
	be(ME);
	linkAsync(runId);
	writeFileSync(join(subDir, `${runId}.json`), JSON.stringify({
		id: runId, agent: "test", task: "failed 测试", status: "completed",
		startedAt: new Date().toISOString(),
		result: { status: "completed", text: "ok" },
	}), "utf8");

	const opts = {
		runsDir: subDir, linksPath: LINKS, toast: false, autoInject: true,
		sendUserMessage: (_c: string, _o?: unknown) => Promise.reject(new Error("Connection error.")),
	};
	onRunFile(subDir, `${runId}.json`, opts);
	await flush();
	assert.equal(sent.length, 0, "failed 不得标记 delivered（不注入）");
	// selfDisable 隔离验证：新 run（未 seen）也应被 selfDisabled 挡下（原失败路径）
	const runId2 = "run_l3_failed_2";
	writeFileSync(join(subDir, `${runId2}.json`), JSON.stringify({
		id: runId2, agent: "test", task: "第二个", status: "completed",
		startedAt: new Date().toISOString(),
		result: { status: "completed", text: "ok" },
	}), "utf8");
	const r2 = onRunFile(subDir, `${runId2}.json`, opts);
	assert.equal(r2, false, "failed 后 selfDisable → 新 run 也不注入（原失败路径）");
}

// ── 16. L3: no-injector 不伪造 receipt，释放后等待通道恢复重试 ─────────
{
	_resetAsyncResultWatcher();
	const sent: string[] = [];
	const subDir = join(dir, "l3-no-injector");
	mkdirSync(subDir, { recursive: true });
	const runId = "run_l3_no_injector";
	be(ME);
	linkAsync(runId);
	writeFileSync(join(subDir, `${runId}.json`), JSON.stringify({
		id: runId, agent: "test", task: "no-injector", status: "completed",
		startedAt: new Date().toISOString(),
		result: { status: "completed", text: "ok" },
	}), "utf8");

	const opts = { runsDir: subDir, linksPath: LINKS, toast: false, autoInject: true }; // 无 sendUserMessage
	onRunFile(subDir, `${runId}.json`, opts);
	await flush();
	assert.equal(sent.length, 0, "无 injector 不注入");
	assert.equal(existsSync(join(subDir, `${runId}.notified`)), false, "未实际发送不得创建 .notified receipt");
	assert.deepEqual(pollUnnotified(subDir, opts), [`${runId}.json`], "no-injector 后应重投，等待通道恢复");
}

// ── 17. 外会话先 tick：零副作用，派发者仍收到一次 ───────────────────────
{
	_resetAsyncResultWatcher();
	be(FOREIGN);
	const subDir = join(dir, "route-foreign-first");
	mkdirSync(subDir, { recursive: true });
	const runId = "run_route_foreign_first";
	writeFileSync(join(subDir, `${runId}.json`), JSON.stringify({
		id: runId, agent: "test", task: "路由测试", status: "completed",
		startedAt: new Date().toISOString(),
		result: { status: "completed", text: "ok" },
	}), "utf8");
	linkAsync(runId, ME);

	const foreignSent: string[] = [];
	const foreignOpts = { runsDir: subDir, linksPath: LINKS, toast: false, autoInject: true, sendUserMessage: (c: string, _o?: unknown) => { foreignSent.push(c); } };
	assert.equal(onRunFile(subDir, `${runId}.json`, foreignOpts), false, "外会话不得消费");
	assert.deepEqual(pollUnnotified(subDir, foreignOpts), [], "外会话 tick 无副作用");
	assert.equal(foreignSent.length, 0, "外会话不得注入");
	assert.equal(existsSync(join(subDir, `${runId}.notified`)), false, "外会话不得创建 .notified");

	// 派发者随后 tick：收到一次（外会话未标 seen、未认领，不影响派发者）
	be(ME);
	const meSent: string[] = [];
	const meOpts = { runsDir: subDir, linksPath: LINKS, toast: false, autoInject: true, sendUserMessage: (c: string, _o?: unknown) => { meSent.push(c); } };
	assert.equal(onRunFile(subDir, `${runId}.json`, meOpts), true, "派发者应收到");
	await flush();
	assert.equal(meSent.length, 1, "派发者收到一次");
	assert.equal(existsSync(join(subDir, `${runId}.notified`)), true, "派发者创建 .notified");
}

// ── 18. 派发者离线：外会话不领，原会话恢复后收到一次 ─────────────────────
{
	_resetAsyncResultWatcher();
	be(FOREIGN);
	const subDir = join(dir, "route-offline");
	mkdirSync(subDir, { recursive: true });
	const runId = "run_route_offline";
	writeFileSync(join(subDir, `${runId}.json`), JSON.stringify({
		id: runId, agent: "test", task: "离线留置", status: "completed",
		startedAt: new Date().toISOString(),
		result: { status: "completed", text: "ok" },
	}), "utf8");
	linkAsync(runId, ME);

	const foreignSent: string[] = [];
	const foreignOpts = { runsDir: subDir, linksPath: LINKS, toast: false, autoInject: true, sendUserMessage: (c: string, _o?: unknown) => { foreignSent.push(c); } };
	assert.deepEqual(pollUnnotified(subDir, foreignOpts), [], "离线期间外会话不领");
	assert.equal(foreignSent.length, 0);
	assert.equal(existsSync(join(subDir, `${runId}.notified`)), false, "离线期间不留认领，run 留待原会话");

	// 原会话恢复后补投一次
	be(ME);
	const meSent: string[] = [];
	const meOpts = { runsDir: subDir, linksPath: LINKS, toast: false, autoInject: true, sendUserMessage: (c: string, _o?: unknown) => { meSent.push(c); } };
	assert.deepEqual(pollUnnotified(subDir, meOpts), [`${runId}.json`], "恢复后补投一次");
	await flush();
	assert.equal(meSent.length, 1, "恢复后收到一次");
}

// ── 19. 缺失/损坏/unknown/错 kind link：不误投 + 可观测日志 ───────────────
{
	_resetAsyncResultWatcher();
	be(ME);
	const subDir = join(dir, "route-no-link");
	mkdirSync(subDir, { recursive: true });
	const errors: string[] = [];
	const origError = console.error;
	console.error = (...a: unknown[]) => { errors.push(a.map(String).join(" ")); };
	try {
		const mk = (rid: string): void => writeFileSync(join(subDir, `${rid}.json`), JSON.stringify({
			id: rid, agent: "test", task: "无归属", status: "completed",
			startedAt: new Date().toISOString(),
			result: { status: "completed", text: "ok" },
		}), "utf8");
		const sent: string[] = [];
		const opts = { runsDir: subDir, linksPath: LINKS, toast: false, autoInject: true, sendUserMessage: (c: string, _o?: unknown) => { sent.push(c); } };

		mk("run_route_missing");
		assert.equal(onRunFile(subDir, "run_route_missing.json", opts), false, "缺失 link 不消费");
		assert.equal(existsSync(join(subDir, "run_route_missing.notified")), false, "缺失 link 不认领");

		appendFileSync(LINKS, "not-json{{{\n{\"kind\":\"async\" broken\n", "utf8");
		mk("run_route_corrupt");
		assert.equal(onRunFile(subDir, "run_route_corrupt.json", opts), false, "损坏账本不误投");
		assert.equal(existsSync(join(subDir, "run_route_corrupt.notified")), false);

		linkAsync("run_route_unknown", "unknown");
		mk("run_route_unknown");
		assert.equal(onRunFile(subDir, "run_route_unknown.json", opts), false, "unknown 身份不消费");
		assert.equal(existsSync(join(subDir, "run_route_unknown.notified")), false);

		appendFileSync(LINKS, JSON.stringify({
			sessionId: ME, kind: "tab", targetId: "run_route_wrongkind",
			detail: "test", at: new Date().toISOString(), pid: process.pid,
		}) + "\n", "utf8");
		mk("run_route_wrongkind");
		assert.equal(onRunFile(subDir, "run_route_wrongkind.json", opts), false, "非 async 记录不算归属");
		assert.equal(existsSync(join(subDir, "run_route_wrongkind.notified")), false);

		assert.equal(sent.length, 0, "全程零注入");
		assert.ok(errors.some((e) => e.includes("run_route_missing")), "缺失 link 应写可观测日志");
	} finally {
		console.error = origError;
	}
}

// ── 20. 重名 link 取最近一条 ─────────────────────────────────────────────
{
	_resetAsyncResultWatcher();
	const subDir = join(dir, "route-newest-wins");
	mkdirSync(subDir, { recursive: true });
	const runId = "run_route_newest";
	writeFileSync(join(subDir, `${runId}.json`), JSON.stringify({
		id: runId, agent: "test", task: "重名取最近", status: "completed",
		startedAt: new Date().toISOString(),
		result: { status: "completed", text: "ok" },
	}), "utf8");
	linkAsync(runId, FOREIGN, "2026-01-01T00:00:00.000Z");
	linkAsync(runId, ME, "2026-02-01T00:00:00.000Z");

	const sent: string[] = [];
	const opts = { runsDir: subDir, linksPath: LINKS, toast: false, autoInject: true, sendUserMessage: (c: string, _o?: unknown) => { sent.push(c); } };
	be(FOREIGN);
	assert.equal(onRunFile(subDir, `${runId}.json`, opts), false, "旧归属会话不得消费");
	assert.equal(existsSync(join(subDir, `${runId}.notified`)), false);
	be(ME);
	assert.equal(onRunFile(subDir, `${runId}.json`, opts), true, "最新归属会话消费");
	await flush();
	assert.equal(sent.length, 1);
}

// ── 21. tab 身份兼容（派发时 tab runId，恢复后 UUID 变化仍放行）────────────
{
	_resetAsyncResultWatcher();
	const subDir = join(dir, "route-tab-scope");
	mkdirSync(subDir, { recursive: true });
	const runId = "run_route_tab_scope";
	writeFileSync(join(subDir, `${runId}.json`), JSON.stringify({
		id: runId, agent: "test", task: "tab 兼容", status: "completed",
		startedAt: new Date().toISOString(),
		result: { status: "completed", text: "ok" },
	}), "utf8");
	const TAB = "tab_run_compat_1";
	linkAsync(runId, TAB);
	process.env.PI_TAB_RUN_ID = TAB;
	be("dddddddd-4444-4444-8888-dddddddddddd"); // UUID 与派发身份不同，靠 tab scope 匹配
	try {
		const sent: string[] = [];
		const opts = { runsDir: subDir, linksPath: LINKS, toast: false, autoInject: true, sendUserMessage: (c: string, _o?: unknown) => { sent.push(c); } };
		assert.equal(onRunFile(subDir, `${runId}.json`, opts), true, "tab scope 匹配应放行");
		await flush();
		assert.equal(sent.length, 1);
	} finally {
		delete process.env.PI_TAB_RUN_ID;
		be(ME);
	}
}

// ── 22. cutover owner≠派发者：仍送派发者（dispatcherWake）─────────────────
{
	_resetAsyncResultWatcher();
	setCutover(true, "route-test");
	const att = attachMaster({ sessionId: OWNER });
	assert.equal(att.ok, true, "cutover owner 预置成功");
	try {
		be(ME);
		const subDir = join(dir, "route-cutover");
		mkdirSync(subDir, { recursive: true });
		const runId = "run_route_cutover";
		writeFileSync(join(subDir, `${runId}.json`), JSON.stringify({
			id: runId, agent: "test", task: "cutover", status: "completed",
			startedAt: new Date().toISOString(),
			result: { status: "completed", text: "ok" },
		}), "utf8");
		linkAsync(runId, ME);
		const sent: string[] = [];
		const opts = { runsDir: subDir, linksPath: LINKS, toast: false, autoInject: true, sendUserMessage: (c: string, _o?: unknown) => { sent.push(c); } };
		assert.equal(onRunFile(subDir, `${runId}.json`, opts), true, "cutover 下派发者仍被唤醒");
		await flush();
		assert.equal(sent.length, 1, "派发者收到一次");

		// 反向：owner 不是派发者时不得截获别人的 run
		const runId2 = "run_route_cutover_owner";
		writeFileSync(join(subDir, `${runId2}.json`), JSON.stringify({
			id: runId2, agent: "test", task: "owner 截获", status: "completed",
			startedAt: new Date().toISOString(),
			result: { status: "completed", text: "ok" },
		}), "utf8");
		linkAsync(runId2, ME);
		be(OWNER);
		assert.equal(onRunFile(subDir, `${runId2}.json`, opts), false, "owner 非派发者不得截获");
		assert.equal(existsSync(join(subDir, `${runId2}.notified`)), false, "截获不得认领");
		assert.equal(sent.length, 1, "owner 侧零注入");
	} finally {
		setCutover(false, "route-test");
		be(ME);
	}
}

// ── 23. preInject 拒绝不留永久标记，释放后重试不丢 ───────────────────────
{
	_resetAsyncResultWatcher();
	setCutover(true, "route-test");
	try {
		be(ME);
		const subDir = join(dir, "route-gate-reject");
		mkdirSync(subDir, { recursive: true });
		const runId = "run_route_gate_reject";
		writeFileSync(join(subDir, `${runId}.json`), JSON.stringify({
			id: runId, agent: "test", task: "gate 拒绝", status: "completed",
			startedAt: new Date().toISOString(),
			result: { status: "completed", text: "ok" },
		}), "utf8");
		linkAsync(runId, ME);
		// 他人先占注入互斥 → 本派发者 gate 拒绝
		const key = `async-result-${runId}-completed`;
		assert.equal(claimInjection(key, "legacy-eventbus:other-holder").status, "claimed");
		const sent: string[] = [];
		const opts = { runsDir: subDir, linksPath: LINKS, toast: false, autoInject: true, sendUserMessage: (c: string, _o?: unknown) => { sent.push(c); } };
		assert.equal(onRunFile(subDir, `${runId}.json`, opts), false, "gate 拒绝不注入");
		assert.equal(existsSync(join(subDir, `${runId}.notified`)), false, "gate 拒绝不留 .notified");
		assert.equal(sent.length, 0);
		// 互斥释放后下 tick 重试不丢
		releaseInjectionClaim(key, "legacy-eventbus:other-holder");
		assert.deepEqual(pollUnnotified(subDir, opts), [`${runId}.json`], "释放后重试");
		await flush();
		assert.equal(sent.length, 1, "重试后收到一次");
	} finally {
		setCutover(false, "route-test");
		be(ME);
	}
}

// ── 24. 注册回归：cutover 非 owner tab 派发者 session_start 后激活并补投一次 ──
{
	_resetAsyncResultWatcher();
	const subDir = join(dir, "reg-nonowner-tab");
	mkdirSync(subDir, { recursive: true });
	const regLinks = join(subDir, "links.jsonl");
	writeFileSync(regLinks, "", "utf8");
	const TAB_X = "tab_run_nonowner_X";
	const DISPATCHER = "dddddddd-5555-4444-8888-dddddddddddd"; // 非 owner 派发者 UUID
	const runId = "run_reg_nonowner_tab";
	appendFileSync(regLinks, JSON.stringify({
		sessionId: TAB_X, kind: "async", targetId: runId,
		detail: "test", at: new Date().toISOString(), pid: process.pid,
	}) + "\n", "utf8");
	writeFileSync(join(subDir, `${runId}.json`), JSON.stringify({
		id: runId, agent: "test", task: "非 owner tab 补投", status: "completed",
		startedAt: new Date().toISOString(),
		result: { status: "completed", text: "ok" },
	}), "utf8");

	setCutover(true, "reg-test");
	assert.equal(attachMaster({ sessionId: OWNER }).ok, true, "cutover owner 预置成功（另一人）");
	process.env.PI_TAB_RUN_ID = TAB_X;
	try {
		const sent: string[] = [];
		const handlers: Record<string, (e: unknown, c?: unknown) => void> = {};
		const pi = {
			on: (evt: string, h: (e: unknown, c?: unknown) => void) => { handlers[evt] = h; },
			sendUserMessage: (c: string, _o?: unknown) => { sent.push(c); },
		};
		const cleanup = registerAsyncResultWatcher(pi as never, {
			runsDir: subDir, linksPath: regLinks, toast: false, autoInject: true,
		});
		try {
			handlers["session_start"]?.(undefined, { sessionManager: { sessionId: DISPATCHER } } as never);
			assert.equal(isAsyncResultWatcherActive(), true, "非 owner tab 派发者 session_start 后 watcher 应激活");
			const fired = pollUnnotified(subDir, {
				runsDir: subDir, linksPath: regLinks, toast: false, autoInject: true,
				sendUserMessage: (c: string, _o?: unknown) => { sent.push(c); },
			});
			assert.deepEqual(fired, [`${runId}.json`], "非 owner tab 派发者应补投一次");
			await flush();
			assert.equal(sent.length, 1, "fake sendUserMessage 应收到一次");
			assert.ok(sent[0].includes(runId), "补投应含 runId");
		} finally {
			cleanup();
		}
	} finally {
		delete process.env.PI_TAB_RUN_ID;
		be(ME);
		setCutover(false, "reg-test");
		_resetAsyncResultWatcher();
	}
}

// ── 25. 注册回归：legacy tab 派发者（无 cutover）session_start 后激活并补投一次 ──
{
	_resetAsyncResultWatcher();
	const subDir = join(dir, "reg-legacy-tab");
	mkdirSync(subDir, { recursive: true });
	const regLinks = join(subDir, "links.jsonl");
	writeFileSync(regLinks, "", "utf8");
	const TAB_Y = "tab_run_legacy_Y";
	const DISPATCHER = "eeeeeeee-6666-4444-8888-eeeeeeeeeeee";
	const runId = "run_reg_legacy_tab";
	appendFileSync(regLinks, JSON.stringify({
		sessionId: TAB_Y, kind: "async", targetId: runId,
		detail: "test", at: new Date().toISOString(), pid: process.pid,
	}) + "\n", "utf8");
	writeFileSync(join(subDir, `${runId}.json`), JSON.stringify({
		id: runId, agent: "test", task: "legacy tab 补投", status: "completed",
		startedAt: new Date().toISOString(),
		result: { status: "completed", text: "ok" },
	}), "utf8");

	// 无 cutover：legacy 下旧 shouldRegisterWatcher 会拒掉 tab，此处必须激活
	process.env.PI_TAB_RUN_ID = TAB_Y;
	try {
		const sent: string[] = [];
		const handlers: Record<string, (e: unknown, c?: unknown) => void> = {};
		const pi = {
			on: (evt: string, h: (e: unknown, c?: unknown) => void) => { handlers[evt] = h; },
			sendUserMessage: (c: string, _o?: unknown) => { sent.push(c); },
		};
		const cleanup = registerAsyncResultWatcher(pi as never, {
			runsDir: subDir, linksPath: regLinks, toast: false, autoInject: true,
		});
		try {
			handlers["session_start"]?.(undefined, { sessionManager: { sessionId: DISPATCHER } } as never);
			assert.equal(isAsyncResultWatcherActive(), true, "legacy tab 派发者 session_start 后 watcher 应激活");
			const fired = pollUnnotified(subDir, {
				runsDir: subDir, linksPath: regLinks, toast: false, autoInject: true,
				sendUserMessage: (c: string, _o?: unknown) => { sent.push(c); },
			});
			assert.deepEqual(fired, [`${runId}.json`], "legacy tab 派发者应补投一次");
			await flush();
			assert.equal(sent.length, 1, "fake sendUserMessage 应收到一次");
			assert.ok(sent[0].includes(runId), "补投应含 runId");
		} finally {
			cleanup();
		}
	} finally {
		delete process.env.PI_TAB_RUN_ID;
		be(ME);
		setCutover(false, "reg-test");
		_resetAsyncResultWatcher();
	}
}

console.log("✓ _test_async_result_watcher: all assertions passed");
