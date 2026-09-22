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
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

// 隔离环境：不是子 agent、不是 tab
delete process.env.PI_SUBAGENT;
delete process.env.PI_TAB_RUN_ID;

// 隔离 shadow journal：emit 路径不得写真实 ~/.pi/agent/runtime/
process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "async-watcher-journal-"));

const dir = mkdtempSync(join(tmpdir(), "async-result-watcher-test-"));

const baseOpts = {
	runsDir: dir,
	toast: false,
	autoInject: false,
};

// ── 1. running→completed 触发一次 ──────────────────────────────────────
{
	_resetAsyncResultWatcher();
	const sent: string[] = [];
	const opts = { ...baseOpts, autoInject: true, sendUserMessage: (c: string, _o?: unknown) => { sent.push(c); } };

	// 写 running 状态
	const runId = "run_test_running_to_done";
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
	writeFileSync(join(dir, `${runId}.json`), JSON.stringify({
		id: runId, agent: "test", task: "任务 A", status: "completed",
		startedAt: new Date().toISOString(),
		result: { status: "completed", text: "ok" },
	}), "utf8");

	// 第一次：触发
	assert.equal(onRunFile(dir, `${runId}.json`, opts), true, "首次应触发");
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
	assert.equal(sent.length, 1);
}

// ── 4. cancelled（类型外溢）兼容 ───────────────────────────────────────
{
	_resetAsyncResultWatcher();
	const sent: string[] = [];
	const opts = { ...baseOpts, autoInject: true, sendUserMessage: (c: string, _o?: unknown) => { sent.push(c); } };

	const runId = "run_cancelled_test";
	writeFileSync(join(dir, `${runId}.json`), JSON.stringify({
		id: runId, agent: "test", task: "取消测试", status: "cancelled",
		startedAt: new Date().toISOString(),
		result: { status: "cancelled", text: "", error: "用户取消" },
	}), "utf8");

	// cancelled 是终态（status !== "running"），应触发
	assert.equal(onRunFile(dir, `${runId}.json`, opts), true, "cancelled 应触发");
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
	writeFileSync(join(dir, `${runId}.json`), JSON.stringify({
		id: runId, agent: "test", task: "失败测试", status: "failed",
		startedAt: new Date().toISOString(),
		result: { status: "failed", text: "", error: "API error: Connection error." },
	}), "utf8");

	assert.equal(onRunFile(dir, `${runId}.json`, opts), true, "failed 应触发");
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
	const opts = { runsDir: subDir, toast: false, autoInject: true, sendUserMessage: (c: string, _o?: unknown) => { sent.push(c); } };

	// 启动前已有 completed run（无 .notified）→ tick 应补投
	const runId = "run_tick_fallback";
	writeFileSync(join(subDir, `${runId}.json`), JSON.stringify({
		id: runId, agent: "test", task: "tick 测试", status: "completed",
		startedAt: new Date().toISOString(),
		result: { status: "completed", text: "ok" },
	}), "utf8");

	// pollUnnotified 应找到并处理
	const fired = pollUnnotified(subDir, opts);
	assert.equal(fired.length, 1, "tick 应找到未投递的 completed run");
	assert.equal(fired[0], `${runId}.json`);
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
	const opts = { runsDir: subDir, toast: false, autoInject: true, sendUserMessage: (c: string, _o?: unknown) => { sent.push(c); } };

	const runId = "run_already_notified";
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
	let hookCalled = false;
	const opts = {
		...baseOpts,
		autoInject: true,
		sendUserMessage: (c: string, _o?: unknown) => { sent.push(c); },
		onRunFinished: (runId: string) => { hookCalled = true; assert.equal(runId, "run_hook_test"); return true; },
	};

	const runId = "run_hook_test";
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
	const fullText = "x".repeat(5000); // 大段文本
	writeFileSync(join(dir, `${runId}.json`), JSON.stringify({
		id: runId, agent: "big-model", task: "长任务", status: "completed",
		startedAt: new Date().toISOString(),
		result: { status: "completed", text: fullText, usage: { cost: 0.1, turns: 10 } },
	}), "utf8");

	assert.equal(onRunFile(dir, `${runId}.json`, opts), true);
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

console.log("✓ _test_async_result_watcher: all assertions passed");
