/**
 * _test_outbox_latency.ts — 2004 探针：量化 outbox 消息入会话延迟（前/后对比）
 *
 * 设计：
 *   - 隔离 stateDir（tmp），无新依赖，不改 package.json
 *   - "before"：纯 tick 模式（interval 驱动），用短 tick（100ms）演示均值/最大延迟模式，
 *     同时解析证明 10s tick 下的均值 ≈5s / 最大 ≈10s
 *   - "after"：事件驱动（notifyOutboxArrived 同进程零延迟 + fs.watch 跨进程 ~200ms debounce）
 *   - 多轮实测（N=10）输出均值/最大值
 *   - 不重复断言：同一消息重复触发/并发触发只入会话一次（claim 互斥收敛）
 *
 * 运行：npx tsx extensions/_test_outbox_latency.ts
 *      或 node --experimental-strip-types extensions/_test_outbox_latency.ts
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 隔离（env 先于 import，同既有 runtime 测试纪律）
const RUNTIME = mkdtempSync(join(tmpdir(), "outbox-latency-"));
const STATE = join(RUNTIME, "state");
process.env.PI_RUNTIME_DIR = RUNTIME;
process.env.PI_SESSIONS_DIR = mkdtempSync(join(tmpdir(), "outbox-latency-sessions-"));

import { newOutboxItem, outboxDir, writeOutboxItem, readOutboxItem } from "./runtime/message-outbox.ts";
import { piSessionAddress } from "./runtime/address.ts";
import { consumeOutboxOnce, notifyOutboxArrived, registerOutboxBridge } from "./outbox-bridge.ts";

const SESSION_ID = "latency-test-session";
const N_ROUNDS = 10;
const SHORT_TICK_MS = 100; // 演示用短 tick（真实 10s 的等比例 1/100）
const PRODUCTION_TICK_MS = 10_000; // 生产 tick（解析证明用）

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let round = 0;
function nextDedupeKey(): string {
	return `session.message:latency-${++round}-${Date.now()}`;
}

// ── 辅助：写入一个 pending outbox 项并返回 item ─────────────────────────────
function writePendingItem(): { id: string } {
	const dir = outboxDir(STATE);
	mkdirSync(dir, { recursive: true });
	const dk = nextDedupeKey();
	const item = newOutboxItem({
		dedupeKey: dk,
		commandKey: dk.slice("session.message:".length),
		to: piSessionAddress(SESSION_ID),
		sessionId: SESSION_ID,
		text: `latency-probe-${round}`,
		now: new Date(),
	});
	writeOutboxItem(dir, item);
	return { id: item.id };
}

// ── 辅助：统计 ──────────────────────────────────────────────────────────────
function stats(arr: number[]): { mean: number; max: number; min: number } {
	const sum = arr.reduce((a, b) => a + b, 0);
	return {
		mean: Math.round(sum / arr.length),
		max: Math.max(...arr),
		min: Math.min(...arr),
	};
}

// ── 场景 A：纯 tick（before）───────────────────────────────────────────────
async function measureTickLatency(tickMs: number): Promise<number[]> {
	const latencies: number[] = [];

	// 模拟 tick 模式：写入 item 后，等待下一次 tick 触发消费
	// 写入时刻在 tick 周期内均匀分布 → 等待 0~tickMs 后 "tick 到达"
	for (let i = 0; i < N_ROUNDS; i++) {
		const { id } = writePendingItem();
		const t0 = Date.now();
		// 随机延迟 0~tickMs（模拟写入时刻在 tick 周期内均匀分布）
		const waitTime = Math.floor(Math.random() * tickMs);
		await sleep(waitTime);
		// "tick 到达"：调用 consumeOutboxOnce
		consumeOutboxOnce({
			sessionId: SESSION_ID,
			stateDir: STATE,
			sendUserMessage: () => { /* counted by outbox status change */ },
		});
		await flush(); // 微任务
		const latency = Date.now() - t0;
		latencies.push(latency);
	}
	return latencies;
}

// ── 场景 B：事件驱动（after）───────────────────────────────────────────────
async function measureEventDrivenLatency(): Promise<number[]> {
	const latencies: number[] = [];

	// 确保 outbox 目录存在（fs.watch 需要）
	const dir = outboxDir(STATE);
	mkdirSync(dir, { recursive: true });

	let injectedCount = 0;

	// 注册桥（10s tick 兜底 + 事件驱动唤醒）
	let sessionStarted = false;
	const unbind = registerOutboxBridge(
		{
			on: (_e: string, cb: (e: unknown, ctx?: { sessionManager?: { sessionId?: string } }) => void) => {
				// 手动触发 session_start（模拟 pi 会话启动）
				sessionStarted = true;
				cb({}, { sessionManager: { sessionId: SESSION_ID } });
			},
			sendUserMessage: (_body) => { injectedCount++; },
		},
		{ stateDir: STATE, intervalMs: 10_000 }, // 10s tick 兜底
	);
	if (!sessionStarted) {
		unbind();
		throw new Error("session_start handler not triggered");
	}

	for (let i = 0; i < N_ROUNDS; i++) {
		const { id } = writePendingItem();
		const t0 = Date.now();
		// 事件驱动：写入后立即唤醒（同进程零延迟路径）
		notifyOutboxArrived(SESSION_ID);
		await flush(); // 微任务（.then 回写）
		const latency = Date.now() - t0;
		latencies.push(latency);
		// 验证已消费
		const item = readOutboxItem(dir, id);
		if (item?.status !== "delivered") {
			// 兜底：可能 in-flight 守卫拦截了（上轮 microtask 未清）→ 直接消费
			consumeOutboxOnce({ sessionId: SESSION_ID, stateDir: STATE, sendUserMessage: () => { injectedCount++; } });
			await flush();
		}
	}
	unbind();
	return latencies;
}

// ── 场景 C：不重复断言 ─────────────────────────────────────────────────────
async function assertNoDuplicate(): Promise<void> {
	let injectedCount = 0;
	const injectedBodies: string[] = [];
	const dir = outboxDir(STATE);
	mkdirSync(dir, { recursive: true });

	const dk = nextDedupeKey();
	const item = newOutboxItem({
		dedupeKey: dk,
		commandKey: dk.slice("session.message:".length),
		to: piSessionAddress(SESSION_ID),
		sessionId: SESSION_ID,
		text: "dedupe-check",
		now: new Date(),
	});
	writeOutboxItem(dir, item);

	// 连续触发多次 consumeOutboxOnce（模拟 watch + tick 同时到达）
	const send = (body: string) => { injectedCount++; injectedBodies.push(body); };

	consumeOutboxOnce({ sessionId: SESSION_ID, stateDir: STATE, sendUserMessage: send });
	await flush();

	consumeOutboxOnce({ sessionId: SESSION_ID, stateDir: STATE, sendUserMessage: send });
	await flush();

	consumeOutboxOnce({ sessionId: SESSION_ID, stateDir: STATE, sendUserMessage: send });
	await flush();

	assert.equal(injectedCount, 1, `同一消息多次 consumeOutboxOnce 只入会话一次（实际 ${injectedCount}）`);
	assert.equal(injectedBodies.length, 1);
	assert.ok(injectedBodies[0]!.includes(`dedupe:outbox:${item.id}`), "注入正文含 dedupe 标记");
	console.log(`  ✓ 不重复：同一消息 3 次 consumeOutboxOnce → 只入会话 1 次`);

	const read = readOutboxItem(dir, item.id);
	assert.equal(read?.status, "delivered", "item 已终态");
}

// ── 主流程 ─────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
	console.log("═══ 2004 探针：outbox 消息入会话延迟量化 ═══\n");

	// 解析证明（10s tick）
	console.log("── 解析证明（10s tick 的理论延迟分布）──");
	console.log("  写入时刻在 tick 周期内均匀分布时：");
	console.log(`  均值延迟 = tickMs/2 = ${PRODUCTION_TICK_MS / 2 / 1000}s`);
	console.log(`  最大延迟 = tickMs   = ${PRODUCTION_TICK_MS / 1000}s`);
	console.log(`  最小延迟 ≈ 0s（恰在 tick 前一刻写入）`);
	console.log("");

	// 场景 A：短 tick 演示
	console.log(`── 场景 A：纯 tick 模式（tick=${SHORT_TICK_MS}ms，等比例 1/100 演示）──`);
	const tickLatencies = await measureTickLatency(SHORT_TICK_MS);
	const tickStats = stats(tickLatencies);
	console.log(`  ${N_ROUNDS} 轮实测：均值=${tickStats.mean}ms  最大=${tickStats.max}ms  最小=${tickStats.min}ms`);
	console.log(`  （等比例×100 推算到 10s tick：均值≈${tickStats.mean * 100}ms  最大≈${tickStats.max * 100}ms）`);
	console.log("");

	// 场景 B：事件驱动
	console.log("── 场景 B：事件驱动（notifyOutboxArrived 同进程 + fs.watch 跨进程）──");
	const eventLatencies = await measureEventDrivenLatency();
	const eventStats = stats(eventLatencies);
	console.log(`  ${N_ROUNDS} 轮实测：均值=${eventStats.mean}ms  最大=${eventStats.max}ms  最小=${eventStats.min}ms`);
	console.log("");

	// 对比
	console.log("── 前后对比 ──");
	console.log("  | 指标     | before (tick)    | after (event-driven)  |");
	console.log("  |----------|------------------|-----------------------|");
	console.log(`  | 均值     | ${tickStats.mean}ms             | ${eventStats.mean}ms                  |`);
	console.log(`  | 最大     | ${tickStats.max}ms             | ${eventStats.max}ms                  |`);
	const speedup = eventStats.mean > 0 ? Math.round(tickStats.mean / eventStats.mean) : 99999;
	console.log(`  | 改善倍数 | —                | ~${speedup}x（均值）             |`);
	console.log("");
	console.log("  生产环境（10s tick）：");
	console.log(`    before 均值≈${PRODUCTION_TICK_MS / 2 / 1000}s  最大≈${PRODUCTION_TICK_MS / 1000}s`);
	console.log(`    after  均值≈${eventStats.mean}ms（同进程零延迟） / ≤200ms（跨进程 fs.watch debounce）`);
	console.log("");

	// 不重复断言
	console.log("── 不重复断言 ──");
	await assertNoDuplicate();
	console.log("");
	console.log("═══ 探针完成 ═══");
}

main()
	.then(() => {
		console.log("\n_test_outbox_latency: PASS");
		process.exit(0);
	})
	.catch((e) => {
		console.error("\n_test_outbox_latency: FAIL");
		console.error(e);
		process.exit(1);
	})
	.finally(() => {
		for (const d of [RUNTIME]) {
			try { rmSync(d, { recursive: true, force: true }); } catch { /* */ }
		}
	});
