/**
 * _test_usage_ledger.ts — token 用量账本与 today-usage 聚合性能优化验证
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	localDayBounds,
	recordUsage,
	readUsageRecords,
	collectSubagentUsage,
	collectMainSessionUsage,
	emptyUsageSummary,
} from "./usage-ledger.ts";
import { dispatchFusion } from "./trace-fusion/fusion-dispatch.ts";

const tmp = mkdtempSync(join(tmpdir(), "usage-ledger-test-"));

try {
	console.log("── 1. recordUsage 与 readUsageRecords 基础功能单测 ──");
	const usageDir = join(tmp, "usage");
	mkdirSync(usageDir, { recursive: true });
	const today = localDayBounds();

	// 记录一次 subagent 成功执行
	recordUsage("searcher", {
		runId: "run_test_1",
		requestedModel: "gpt-4o",
		model: "gpt-4o",
		usage: {
			input: 1000,
			output: 200,
			cacheRead: 500,
			cacheWrite: 0,
			cost: 0.015,
			turns: 2,
		},
		usageEvents: [
			{
				id: "run_test_1:1",
				runId: "run_test_1",
				ts: new Date().toISOString(),
				model: "gpt-4o",
				usage: { input: 600, output: 100, cacheRead: 300, cacheWrite: 0, cost: 0.009, turns: 1 },
			},
			{
				id: "run_test_1:2",
				runId: "run_test_1",
				ts: new Date().toISOString(),
				model: "gpt-4o",
				usage: { input: 400, output: 100, cacheRead: 200, cacheWrite: 0, cost: 0.006, turns: 1 },
			},
		],
	}, usageDir);

	const records = readUsageRecords(today, usageDir);
	assert.equal(records.length, 2, "两条 event 应该被成功读取");
	assert.equal(records[0].agent, "searcher");
	assert.equal(records[0].model, "gpt-4o");

	const subTotal = collectSubagentUsage(today, usageDir);
	assert.equal(subTotal.input, 1000);
	assert.equal(subTotal.output, 200);
	assert.equal(subTotal.cacheRead, 500);
	assert.equal(subTotal.turns, 2);
	assert.equal(subTotal.count, 1, "同一 runId 应该被去重计为 1 个 run");
	console.log("PASS: recordUsage & readUsageRecords 正常");

	console.log("── 2. collectMainSessionUsage mtime 预过滤与正确性验证 ──");
	const sessionsDir = join(tmp, "sessions");
	mkdirSync(sessionsDir, { recursive: true });

	// 创建一个陈旧历史文件（模拟 5 天前的文件，包含当天的历史消息）
	const oldFile = join(sessionsDir, "old-session.jsonl");
	const oldTs = new Date(Date.now() - 5 * 24 * 3600_000).toISOString();
	const oldLine = JSON.stringify({
		type: "message",
		timestamp: oldTs,
		message: {
			role: "assistant",
			timestamp: oldTs,
			usage: { input: 99999, output: 99999, cacheRead: 0, cacheWrite: 0, cost: { total: 10 } },
		},
	});
	writeFileSync(oldFile, oldLine + "\n", "utf8");
	// 调整 mtime 为 5 天前
	const fiveDaysAgo = (Date.now() - 5 * 24 * 3600_000) / 1000;
	utimesSync(oldFile, fiveDaysAgo, fiveDaysAgo);

	// 创建一个今日新会话文件
	const todayFile = join(sessionsDir, "today-session.jsonl");
	const nowTs = new Date().toISOString();
	const todayLine = JSON.stringify({
		type: "message",
		timestamp: nowTs,
		message: {
			role: "assistant",
			provider: "google",
			model: "gemini-flash",
			timestamp: nowTs,
			usage: { input: 1500, output: 350, cacheRead: 800, cacheWrite: 100, cost: { total: 0.002 } },
		},
	});
	writeFileSync(todayFile, todayLine + "\n", "utf8");

	// 此时带 mtime 预过滤跑 collectMainSessionUsage
	const mainUsage = collectMainSessionUsage(today, sessionsDir);
	assert.equal(mainUsage.total.input, 1500, "必须只统计今日消息，不含陈旧历史消息");
	assert.equal(mainUsage.total.output, 350);
	assert.equal(mainUsage.total.cacheRead, 800);
	assert.equal(mainUsage.total.cacheWrite, 100);
	assert.equal(mainUsage.total.turns, 1);
	assert.equal(mainUsage.sessionCount, 1, "只扫描到 1 个今日活跃会话");
	assert.equal(mainUsage.sessionsWithUsage, 1);
	console.log("PASS: collectMainSessionUsage 成功过滤历史文件并精准统计今日用量");

	console.log("── 3. TraceFusion 融合器用量闭环验证 ──");
	const tfRunsDir = join(tmp, "tf-runs");
	const reportFile = join(tmp, "cross-test-report.md");
	const fakePiCli = join(tmp, "fake-pi-cli.js");
	writeFileSync(fakePiCli, "console.log('fake pi');", "utf8");
	mkdirSync(tfRunsDir, { recursive: true });
	writeFileSync(reportFile, "# Report\n", "utf8");

	let recordedAgent: string | undefined;
	let recordedResult: any;

	// 模拟一次 dispatchFusion 调用（使用 fake runner）
	const fusionResult = await dispatchFusion({
		runId: "tfl-test-001",
		runDir: tmp,
		repoRoot: tmp,
		reportPath: reportFile,
		fusionModel: "deepseek/v3",
		piCli: fakePiCli,
		runsDir: tfRunsDir,
		runFusionAgent: async () => ({
			ok: true,
			exitCode: 0,
			exitSignal: null,
			timedOut: false,
			spawnError: null,
			usage: { input: 8000, output: 1200, cacheRead: 4000, cacheWrite: 0, cost: 0.025, turns: 3 },
			via: "subagent-runWithFallback",
		}),
		recordUsage: (agent, res) => {
			recordedAgent = agent;
			recordedResult = res;
		},
	});

	assert.equal(recordedAgent, "fusion", "必须记录融合器 agent 名为 fusion");
	assert.ok(recordedResult, "必须有记录结果");
	assert.equal(recordedResult.usage.input, 8000);
	assert.equal(recordedResult.usage.output, 1200);
	assert.equal(recordedResult.usage.cost, 0.025);
	assert.equal(recordedResult.usage.turns, 3);
	assert.equal(recordedResult.requestedModel, "deepseek/v3");
	console.log("PASS: TraceFusion fusion 成功通过 seam 触发 recordUsage");

	console.log("\nAll usage ledger tests passed successfully!");
} finally {
	rmSync(tmp, { recursive: true, force: true });
}
