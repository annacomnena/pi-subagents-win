/**
 * _test_injection_gate.ts — L3 忙时冲突静默重试：共享 helper injectFollowUpQuietly 单元测试
 *
 * 根因（plans/0922_async_result_delivery_research.md 后续 L3）：pi.sendUserMessage 运行时是
 * async（返回 Promise，类型却标 void），旧调用点用同步 try/catch 包着——busy 时的 rejection
 * 逃过 try/catch，落到 bindCore 包装器（agent-session.js sendUserMessage(...).catch(err =>
 * emitError({ extensionPath: "<runtime>", ... }))），被统一报成
 * `Extension "<runtime>" error: Agent is already processing a prompt…`（<runtime> 是硬编码
 * 标签，并非某个扩展名）。injectFollowUpQuietly await send 结果并把异常**分类吞掉**（永不
 * reject），调用方据此决定 receipt 时机（只在 "sent" 后）与 claim 释放（busy 时）。
 *
 * 覆盖：
 *   1. sent：send resolve（同步 void / 异步 Promise）→ "sent"
 *   2. busy：send reject 且含 "already processing"（大小写不敏感、长消息子串）→ "busy"
 *   3. failed：send reject 其他异常 / 同步 throw → "failed"
 *   4. no-injector：send 非函数（undefined）→ "no-injector"
 *   5. 永不 reject：所有分支都返回 resolved Promise（调用方可安全 .then 且不产生 unhandled rejection）
 *   6. busy 判定边界：含 "processing" 但非 "already processing" 的异常 → "failed"（不误判 busy）
 *
 * 运行：npm run test:injection-gate
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 隔离 runtime 目录（releaseInjectionClaim 测试用；先于 import）
process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "injection-gate-env-"));

import { injectFollowUpQuietly, type InjectionSendStatus } from "./injection-gate.ts";
import { claimInjection, releaseInjectionClaim, hasNotificationReceipt } from "./runtime/receipts.ts";

// flush 微任务队列（helper 内部走 Promise.resolve().then 链）。
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

/** 跑 helper 并断言永不 reject（返回的 Promise 必须 resolve 出合法 status）。 */
async function run(send: Parameters<typeof injectFollowUpQuietly>[0], body = "hi"): Promise<InjectionSendStatus> {
	let settled = false;
	const status = await new Promise<InjectionSendStatus>((resolve, reject) => {
		injectFollowUpQuietly(send, body).then(
			(s) => { settled = true; resolve(s); },
			(e) => reject(new Error(`helper 不应 reject，却 reject 了：${e instanceof Error ? e.message : String(e)}`)),
		);
	});
	assert.equal(settled, true, "helper 必须 resolve（永不 reject）");
	return status;
}

// ── 1. sent ────────────────────────────────────────────────────────────
{
	// 1a. 同步 void（测试桩常见形态）
	assert.equal(await run(() => undefined), "sent", "同步 void → sent");
	// 1b. 异步 resolve（真实 sendUserMessage idle 形态：返回 Promise）
	assert.equal(await run(() => Promise.resolve()), "sent", "异步 resolve → sent");
	// 1c. 异步 resolve（延迟一拍，模拟真实 turn 完成）
	const delayed = new Promise<void>((r) => setImmediate(() => r()));
	const p = injectFollowUpQuietly(() => delayed, "hi");
	await flush();
	assert.equal(await p, "sent", "延迟 resolve → sent");
}

// ── 2. busy ────────────────────────────────────────────────────────────
{
	// 2a. 标准 busy 拒绝（agent-core prompt 的原文形状）
	assert.equal(
		await run(() => Promise.reject(new Error("Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion."))),
		"busy",
		"标准 already processing 拒绝 → busy",
	);
	// 2b. 大小写不敏感
	assert.equal(await run(() => Promise.reject(new Error("Agent is ALREADY PROCESSING a prompt"))), "busy", "大写 ALREADY PROCESSING → busy");
	assert.equal(await run(() => Promise.reject(new Error("agent is already processing"))), "busy", "小写 already processing → busy");
	// 2c. 子串（bindCore 包装后的完整报错形状）
	assert.equal(
		await run(() => Promise.reject(new Error('Extension "<runtime>" error: Agent is already processing a prompt…'))),
		"busy",
		"bindCore 包装后的完整报错（含 already processing 子串）→ busy",
	);
}

// ── 3. failed ──────────────────────────────────────────────────────────
{
	// 3a. 异步 reject 其他异常
	assert.equal(await run(() => Promise.reject(new Error("Connection error."))), "failed", "其他异步 reject → failed");
	assert.equal(await run(() => Promise.reject(new Error("Authentication failed for provider."))), "failed", "auth 失败 → failed");
	// 3b. 同步 throw（测试桩 / 未初始化占位形态）
	assert.equal(await run(() => { throw new Error("not initialized"); }), "failed", "同步 throw → failed");
	// 3c. reject 非 Error 值
	assert.equal(await run(() => Promise.reject("plain-string-failure")), "failed", "非 Error 拒绝 → failed");
}

// ── 4. no-injector ─────────────────────────────────────────────────────
{
	assert.equal(await run(undefined), "no-injector", "send 为 undefined → no-injector");
}

// ── 5. 永不 reject（各分支都 resolve）──────────────────────────────────
{
	const cases: Array<[Parameters<typeof injectFollowUpQuietly>[0], InjectionSendStatus]> = [
		[() => undefined, "sent"],
		[() => Promise.reject(new Error("already processing")), "busy"],
		[() => Promise.reject(new Error("boom")), "failed"],
		[() => { throw new Error("sync boom"); }, "failed"],
		[undefined, "no-injector"],
	];
	for (const [send, expected] of cases) {
		const p = injectFollowUpQuietly(send, "x");
		// 未 catch 的 Promise 若 reject 会触发 unhandledRejection；这里显式 await 验证其 resolve。
		const got = await p;
		assert.equal(got, expected, `分支 ${JSON.stringify(expected)} 应 resolve（不 reject）`);
	}
}

// ── 6. busy 判定边界（不误判）──────────────────────────────────────────
{
	// 含 "processing" 但非 "already processing" → failed（不误判为 busy）
	assert.equal(await run(() => Promise.reject(new Error("Still processing the previous request, retry later"))), "failed", "含 processing 但非 already processing → failed");
	// 空消息 / 无 processing 字样 → failed
	assert.equal(await run(() => Promise.reject(new Error(""))), "failed", "空消息 reject → failed");
}

// ── 7. releaseInjectionClaim（busy 释放 claim 供下 tick 重试）──────────
{
	const key = "l3-release-test-key";
	const holder = "test-holder";
	// 预置 claim（模拟注入前互斥）
	assert.equal(claimInjection(key, holder).status, "claimed", "预置 claim 成功");
	// 未 confirm 前：收据不存在
	assert.equal(hasNotificationReceipt(key), false, "claim 后未 confirm → 无 injected 收据");
	// 异 holder 不得误放（busy 结果迟到时，不能删 stale 接管者的 claim）
	releaseInjectionClaim(key, "other-holder");
	assert.equal(claimInjection(key, "other-holder").status, "claimed-by-other", "异 holder release 是 no-op");
	// 释放（busy 路径）：同 holder 的 .claiming.json 删除 → 下 tick 可重新领取
	releaseInjectionClaim(key, holder);
	const re = claimInjection(key, holder);
	assert.equal(re.status, "claimed", "释放后同 holder 可重新领取（下 tick 重试）");
	// 幂等：重复释放不抛（best-effort）
	releaseInjectionClaim(key, holder);
	releaseInjectionClaim("", holder); // 空键 no-op
	releaseInjectionClaim("has space", holder); // 含空白 no-op（与 claim 同纪律）
}

console.log("_test_injection_gate: all assertions passed");
