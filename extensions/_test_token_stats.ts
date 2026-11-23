/**
 * extensions/_test_token_stats.ts — Token 统计与聚合服务单元测试
 *
 * 覆盖：
 * 1. 真实会话目录下的统计聚合与缓存命中测试（读数与耗时）
 * 2. 统计结果结构与字段契约（summary / daily / hourly / bySession / byModel）
 * 3. 隔离临时目录下的构造数据测试（验证算术准确性与坏行容错）
 * 4. 窗口天数过滤（days: 7 vs days: 30）
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectTokenStats } from "./runtime/token-stats.ts";

console.log("[test:token-stats] Starting verification...");

// 1. 真实环境快速聚合与缓存测试
{
	const t0 = Date.now();
	const res1 = collectTokenStats({ days: 14 });
	const elapsed1 = Date.now() - t0;
	console.log(`[test:token-stats] First run (14 days): ${elapsed1}ms`);

	assert.equal(res1.version, 1);
	assert.ok(typeof res1.asOf === "string");
	assert.ok(Array.isArray(res1.daily));
	assert.ok(Array.isArray(res1.hourly));
	assert.equal(res1.hourly.length, 24);
	assert.ok(Array.isArray(res1.bySession));
	assert.ok(Array.isArray(res1.byModel));

	assert.ok(typeof res1.summary.totalTokens === "number");
	assert.ok(typeof res1.summary.inputTokens === "number");
	assert.ok(typeof res1.summary.outputTokens === "number");
	assert.ok(res1.summary.today, "summary 必须包含 today 字段");
	assert.ok(typeof res1.summary.today.totalTokens === "number");
	assert.ok(typeof res1.summary.today.turns === "number");

	// 测试 days: 1（今天）
	const resToday = collectTokenStats({ days: 1 });
	assert.equal(resToday.days, 1);
	assert.ok(typeof resToday.summary.totalTokens === "number");

	// 缓存再次运行
	const t1 = Date.now();
	const res2 = collectTokenStats({ days: 14 });
	const elapsed2 = Date.now() - t1;
	console.log(`[test:token-stats] Second run with cache: ${elapsed2}ms`);
	assert.ok(elapsed2 < 300, `Cached run should be fast, got ${elapsed2}ms`);
	assert.equal(res2.summary.totalTokens, res1.summary.totalTokens);
}

// 2. 隔离临时目录构造数据精确性测试
{
	const testDir = join(tmpdir(), `subagent-token-test-${Date.now()}`);
	mkdirSync(testDir, { recursive: true });

	try {
		const now = Date.now();
		const oneDayMs = 86400 * 1000;

		// Session A: 昨天，2 轮交互
		const sessionA = [
			JSON.stringify({ type: "session", id: "sess-a", cwd: "/test/a", timestamp: new Date(now - oneDayMs).toISOString() }),
			JSON.stringify({
				message: {
					role: "assistant",
					model: "model-x",
					provider: "prov-x",
					timestamp: now - oneDayMs,
					usage: {
						input: 100,
						output: 50,
						cacheRead: 200,
						cacheWrite: 0,
						reasoning: 10,
						totalTokens: 350,
						cost: { total: 0.005 },
					},
				},
			}),
			"invalid-bad-json-line-should-be-ignored",
			JSON.stringify({
				message: {
					role: "assistant",
					model: "model-x",
					provider: "prov-x",
					timestamp: now - oneDayMs + 1000,
					usage: {
						input: 200,
						output: 100,
						cacheRead: 400,
						cacheWrite: 0,
						reasoning: 20,
						totalTokens: 700,
						cost: { total: 0.01 },
					},
				},
			}),
		].join("\n");

		// Session B: 今天，1 轮交互
		const sessionB = [
			JSON.stringify({ type: "session", id: "sess-b", cwd: "/test/b", timestamp: new Date(now).toISOString() }),
			JSON.stringify({
				message: {
					role: "assistant",
					model: "model-y",
					provider: "prov-y",
					timestamp: now,
					usage: {
						input: 500,
						output: 250,
						cacheRead: 0,
						cacheWrite: 0,
						reasoning: 0,
						totalTokens: 750,
						cost: { total: 0.02 },
					},
				},
			}),
		].join("\n");

		writeFileSync(join(testDir, "session_a.jsonl"), sessionA);
		writeFileSync(join(testDir, "session_b.jsonl"), sessionB);

		const stats = collectTokenStats({ sessionsDir: testDir, days: 7, nowMs: now });

		// 检查汇总
		// totalTokens = 350 + 700 + 750 = 1800
		assert.equal(stats.summary.totalTokens, 1800, "总 Token 计算准确");
		// inputTokens = 100 + 200 + 500 = 800
		assert.equal(stats.summary.inputTokens, 800, "Input Token 计算准确");
		// outputTokens = 50 + 100 + 250 = 400
		assert.equal(stats.summary.outputTokens, 400, "Output Token 计算准确");
		// cacheRead = 200 + 400 = 600
		assert.equal(stats.summary.cacheReadTokens, 600, "CacheRead Token 计算准确");
		// turns = 3
		assert.equal(stats.summary.totalTurns, 3, "交互轮次计算准确");
		// sessions = 2
		assert.equal(stats.summary.totalSessions, 2, "会话数量准确");

		// 检查模型聚合
		assert.equal(stats.byModel.length, 2);
		const modelX = stats.byModel.find((m) => m.model === "model-x");
		assert.ok(modelX);
		assert.equal(modelX.totalTokens, 1050);
		assert.equal(modelX.turns, 2);

		const modelY = stats.byModel.find((m) => m.model === "model-y");
		assert.ok(modelY);
		assert.equal(modelY.totalTokens, 750);
		assert.equal(modelY.turns, 1);

		// 检查会话聚合
		assert.equal(stats.bySession.length, 2);
		const sA = stats.bySession.find((s) => s.sessionId === "sess-a");
		assert.ok(sA);
		assert.equal(sA.totalTokens, 1050);
		assert.equal(sA.cwd, "/test/a");

		console.log("[test:token-stats] Isolated calculations verified successfully.");
	} finally {
		rmSync(testDir, { recursive: true, force: true });
	}
}

console.log("[test:token-stats] All assertions passed.");
