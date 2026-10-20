/**
 * _test_session_control.ts — 会话控制通道（停止按钮）回归门（2026-10-20）。
 *
 * 覆盖三层：
 *   T1 盘面状态机：pending → running → done/failed；终态不可覆盖；同 commandKey 幂等
 *   T2 动作执行：abort 的三种诚实回执（aborted / not-streaming / stale-ctx）
 *   T3 真实接线：用最小 pi 桩收集 `on()` 注册 + 真实事件派发 + 真实盘面消费
 *      —— 不做「直接调 executeControlAction」就算过（AGENTS.md §4.2：变异必须打真实接线）
 *
 * 反例守卫：
 *   - 禁止把 abort 塞进 message-outbox（那是封闭单命令通道，且已有多个消费者）
 *   - 禁止「空闲时静默 no-op」而不回写结果（用户点了要有回话）
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CONTROL_RUNNING_STALE_MS,
	claimControlRequest,
	completeControlRequest,
	controlDir,
	controlIdFor,
	listControlRequests,
	newControlRequest,
	readControlRequest,
	writeControlRequest,
} from "./runtime/session-control.ts";
import { executeControlAction, registerSessionControl } from "./runtime/session-control-register.ts";

let n = 0;
const ok = (m: string): void => {
	n++;
	console.log(`ok ${n} - ${m}`);
};

const tmp = mkdtempSync(join(tmpdir(), "sw-ctl-"));
const dir = controlDir(tmp);

try {
	// ── T1 盘面状态机 ────────────────────────────────────────────────
	{
		const req = newControlRequest({ sessionId: "s1", action: "abort", commandKey: "k1" });
		assert.equal(req.status, "pending");
		assert.equal(req.id, controlIdFor("k1"), "id 由 commandKey 派生（同键同文件）");

		const w1 = writeControlRequest(req, dir);
		assert.equal(w1.written, true, "首次写入落盘");
		const w2 = writeControlRequest(req, dir);
		assert.equal(w2.written, false, "同 commandKey 再写不重复落盘（幂等）");

		const claimed = claimControlRequest(req.id, "tester", { dir });
		assert.ok(claimed !== null, "pending 可领取");
		assert.equal(claimed!.status, "running");
		assert.equal(readControlRequest(req.id, dir)?.status, "running");

		const again = claimControlRequest(req.id, "other", { dir });
		assert.equal(again, null, "running 未超龄 ⇒ 别人领不到（防双执行）");

		const done = completeControlRequest(req.id, { ok: true, result: "aborted" }, { dir });
		assert.equal(done, true, "首次落终态成功");
		assert.equal(readControlRequest(req.id, dir)?.result, "aborted");

		const overwrite = completeControlRequest(req.id, { ok: true, result: "not-streaming" }, { dir });
		assert.equal(overwrite, false, "终态不可覆盖（第二次拒绝）");
		assert.equal(readControlRequest(req.id, dir)?.result, "aborted", "结果仍是第一次的");

		// running 超龄 ⇒ 可重新领取（原领取方已死）
		const req2 = newControlRequest({ sessionId: "s1", action: "abort", commandKey: "k2" });
		writeControlRequest(req2, dir);
		claimControlRequest(req2.id, "dead", { dir, now: new Date(Date.now() - CONTROL_RUNNING_STALE_MS - 1000) });
		const reclaimed = claimControlRequest(req2.id, "alive", { dir });
		assert.ok(reclaimed !== null, "running 超龄 ⇒ 可重新领取（不留僵尸）");
		assert.equal(reclaimed!.claimedBy, "alive");
		ok("T1 盘面：幂等写入 / 防双执行 / 终态不可覆盖 / running 超龄可重领");
	}

	// ── T2 动作执行（三态回执）────────────────────────────────────────
	{
		const abortReq = newControlRequest({ sessionId: "s2", action: "abort", commandKey: "a1" });

		// 正常：在流式 ⇒ 调 abort，回 aborted
		let called = 0;
		const busy = { isIdle: () => false, abort: () => { called++; } };
		const r1 = executeControlAction(abortReq, busy);
		assert.deepEqual(r1, { ok: true, result: "aborted" });
		assert.equal(called, 1, "确实调了 ctx.abort()");

		// 空闲 ⇒ not-streaming（明确告知，不静默 no-op），且**不**调 abort
		let called2 = 0;
		const idle = { isIdle: () => true, abort: () => { called2++; } };
		const r2 = executeControlAction(abortReq, idle);
		assert.deepEqual(r2, { ok: true, result: "not-streaming" });
		assert.equal(called2, 0, "空闲时不调 abort");

		// ctx 缺失/失效 ⇒ stale-ctx
		assert.deepEqual(executeControlAction(abortReq, null), { ok: true, result: "stale-ctx" });
		assert.deepEqual(executeControlAction(abortReq, { sessionManager: {} }), { ok: true, result: "stale-ctx" });

		// isIdle 缺失 ⇒ 按「可能在跑」处理（abort 本身有空闲守卫，是安全 no-op）
		let called3 = 0;
		const noIdle = { abort: () => { called3++; } };
		assert.deepEqual(executeControlAction(abortReq, noIdle), { ok: true, result: "aborted" });
		assert.equal(called3, 1, "isIdle 不可用时宁可调一次 abort（不静默）");

		// abort 抛错 ⇒ failed（不吞成成功）
		const throws = { isIdle: () => false, abort: () => { throw new Error("boom"); } };
		const r3 = executeControlAction(abortReq, throws);
		assert.equal(r3.ok, false);
		ok("T2 动作：aborted / not-streaming / stale-ctx / 抛错转 failed（四态齐）");
	}

	// ── T3 真实接线：注册 + 事件派发 + 真实消费 ──────────────────────
	{
		const dir3 = controlDir(join(tmp, "s3"));
		mkdirSync(dir3, { recursive: true });
		const handlers = new Map<string, (event: unknown, ctx?: unknown) => void>();
		const pi = {
			on: (event: string, cb: (e: unknown, c?: unknown) => void) => {
				handlers.set(event, cb);
				return () => handlers.delete(event);
			},
		} as never;

		const dispose = registerSessionControl(pi, { dir: dir3, tickMs: 60_000 });

		// 注册形状：session_start 必须被订阅（否则永远拿不到 ctx）
		assert.ok(handlers.has("session_start"), "注册了 session_start（拿 ctx 的唯一入口）");
		assert.ok(handlers.has("session_shutdown"), "注册了 session_shutdown（清盘）");

		let aborted = 0;
		const ctx = { sessionManager: { sessionId: "s3" }, isIdle: () => false, abort: () => { aborted++; } };
		// 真实事件派发（不是直接调 consume）
		handlers.get("session_start")!({ type: "session_start" }, ctx);

		// 写一条 pending 请求（模拟 daemon 落盘）
		const req = newControlRequest({ sessionId: "s3", action: "abort", commandKey: "wire1" });
		writeControlRequest(req, dir3);

		// watch 有 200ms debounce；这里用真实等待（验证 watch 真的接上了，而不是只测函数）
		const deadline = Date.now() + 3000;
		while (aborted === 0 && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 50));
		}
		assert.equal(aborted, 1, "fs.watch 真实触发 ⇒ ctx.abort() 被调用（接线通）");

		// 结果已回写终态
		const after = readControlRequest(req.id, dir3);
		assert.equal(after?.status, "done", "回写 done");
		assert.equal(after?.result, "aborted", "回写 aborted");

		// 别的会话的请求不该被本会话消费
		const foreign = newControlRequest({ sessionId: "other", action: "abort", commandKey: "wire2" });
		writeControlRequest(foreign, dir3);
		await new Promise((r) => setTimeout(r, 500));
		assert.equal(readControlRequest(foreign.id, dir3)?.status, "pending", "别的会话的请求保持 pending（不误伤）");

		dispose();
		ok("T3 真实接线：session_start 注册 → 真实 fs.watch 触发 → ctx.abort() → 回写终态");
	}

	// ── T4 静态守卫：通道隔离 + 接线位置 ──────────────────────────────
	{
		const executor = readFileSync(new URL("./runtime/command-executor.ts", import.meta.url), "utf8");
		assert.ok(
			/IMPLEMENTED_COMMAND_TYPES[\s\S]{0,400}"session\.abort"/.test(executor),
			"session.abort 在 IMPLEMENTED_COMMAND_TYPES 白名单里",
		);
		assert.ok(/case "session\.abort":[\s\S]{0,120}runSessionAbort/.test(executor), "dispatch 分派到 runSessionAbort");

		// 反例守卫：abort 不得走 message-outbox（封闭单命令通道，多消费者共用）
		const outbox = readFileSync(new URL("./runtime/message-outbox.ts", import.meta.url), "utf8");
		assert.ok(
			/OUTBOX_COMMAND_TYPE = "session\.message"/.test(outbox),
			"message-outbox 仍只服务 session.message（abort 走独立通道）",
		);

		// 接线：index.ts 必须真的注册（否则整个功能静默不生效 —— R-2 事故形态）
		const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
		assert.ok(/collect\(registerSessionControl\(pi\)\)/.test(index), "index.ts 已注册 registerSessionControl");

		// 服务端读投影
		const server = readFileSync(new URL("./runtime-host/server.ts", import.meta.url), "utf8");
		assert.ok(/\/v1\\\/session-control/.test(server), "server.ts 暴露 GET /v1/session-control/:sid");
		ok("T4 静态：白名单 + 分派 + 通道隔离 + index 接线 + 服务端端点");
	}
} finally {
	rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n_test_session_control: all assertions passed (${n})`);
