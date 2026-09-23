import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runSystemGc } from "./gc-cleaner.ts";

const testRoot = join(tmpdir(), `subagent-gc-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
const tabRunsDir = join(testRoot, "tab-runs");
const timersDir = join(testRoot, "timers");
const subagentRunsDir = join(testRoot, "subagent-runs");
const reportsDir = join(testRoot, "reports");

mkdirSync(tabRunsDir, { recursive: true });
mkdirSync(timersDir, { recursive: true });
mkdirSync(subagentRunsDir, { recursive: true });
mkdirSync(reportsDir, { recursive: true });

try {
	// 1. 准备碎片文件与超龄 run
	// A. .tmp 临时碎片
	writeFileSync(join(tabRunsDir, "orphan1.tmp"), "dangling tmp 1");
	writeFileSync(join(reportsDir, "orphan2.tmp"), "dangling tmp 2");
	writeFileSync(join(subagentRunsDir, "orphan3.tmp"), "dangling tmp 3");

	// B. 终态 tab-run（72小时前派发，已完成，应当被归档）
	const doneRunId = "tab_done_1234567890";
	writeFileSync(
		join(tabRunsDir, `${doneRunId}.json`),
		JSON.stringify({
			id: doneRunId,
			version: 1,
			taskId: "task-old",
			cwd: process.cwd(),
			mode: "workflow",
			dispatchedAt: new Date(Date.now() - 72 * 3600 * 1000).toISOString(),
			dispatchStatus: "dispatched",
			title: "Old success task",
		}),
	);
	writeFileSync(
		join(tabRunsDir, `${doneRunId}.result.json`),
		JSON.stringify({ id: doneRunId, status: "completed" }),
	);

	// C. 活跃 tab-run（正在 working 活跃中，绝不能被归档）
	const activeRunId = "tab_working_1234567890";
	writeFileSync(
		join(tabRunsDir, `${activeRunId}.json`),
		JSON.stringify({
			id: activeRunId,
			version: 1,
			taskId: "task-active",
			cwd: process.cwd(),
			mode: "workflow",
			dispatchedAt: new Date(Date.now() - 72 * 3600 * 1000).toISOString(),
			dispatchStatus: "dispatched",
			title: "Active task",
		}),
	);
	writeFileSync(
		join(tabRunsDir, `${activeRunId}.state.json`),
		JSON.stringify({ id: activeRunId, phase: "working", turn: "working" }),
	);

	// D. 定时器死信（48 小时前已触发 fired，超龄终态）
	const deadTimerId = "timer_dead_12345";
	writeFileSync(
		join(timersDir, `${deadTimerId}.json`),
		JSON.stringify({
			id: deadTimerId,
			version: 1,
			dueAt: new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
			message: "ping",
			target: "self",
			source: "test",
			status: "fired",
			firedAt: new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
			createdAt: new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
		}),
	);

	let customCacheCleared = false;

	// 2. 执行 runSystemGc
	const result = await runSystemGc({
		tabRunsDir,
		timersDir,
		subagentRunsDir,
		reportsDir,
		maxAgeHours: 48,
		onClearCustomCaches: () => {
			customCacheCleared = true;
		},
	});

	// 3. 断言验证
	// A. 回调触发
	assert.equal(customCacheCleared, true, "onClearCustomCaches 应当被调用");

	// B. 临时 .tmp 碎片应当全部被清理
	assert.equal(existsSync(join(tabRunsDir, "orphan1.tmp")), false, "tab-runs 中的 orphan1.tmp 应被清理");
	assert.equal(existsSync(join(reportsDir, "orphan2.tmp")), false, "reports 中的 orphan2.tmp 应被清理");
	assert.equal(existsSync(join(subagentRunsDir, "orphan3.tmp")), false, "subagent-runs 中的 orphan3.tmp 应被清理");
	assert.equal(result.cleanedTmpFiles >= 3, true, `cleanedTmpFiles 应至少为 3 (实际 ${result.cleanedTmpFiles})`);

	// C. 历史终态 run 应被移入 _archived，而活跃 run 应保留在原处
	assert.equal(existsSync(join(tabRunsDir, `${doneRunId}.json`)), false, "终态 run 应从活跃目录移除");
	assert.equal(existsSync(join(tabRunsDir, "_archived", `${doneRunId}.json`)), true, "终态 run 应被移入 _archived 目录");
	assert.equal(existsSync(join(tabRunsDir, `${activeRunId}.json`)), true, "活跃中的 run 必须被安全保留");
	assert.equal(result.archivedRuns >= 1, true, "应当成功归档至少 1 个跑次");

	// D. 定时器死信应当被 sweep
	assert.equal(existsSync(join(timersDir, `${deadTimerId}.json`)), false, "定时器死信应被清理");
	assert.equal(result.sweptTimers >= 1, true, "应当清理至少 1 个死信定时器");

	// E. 报告摘要格式
	assert.ok(result.summary.includes("subagent-win 内存回收与碎片清理完成"), "报告摘要应包含完成标题");
	assert.ok(result.summary.includes("物理常驻 (RSS)"), "报告摘要应包含 RSS 指标");
	assert.ok(result.summary.includes("V8 堆占用 (Heap)"), "报告摘要应包含 Heap 指标");
	assert.ok(result.summary.includes("归档历史 Tab 跑次"), "报告摘要应包含归档计数");

	console.log("=== runSystemGc 报告输出演示 ===");
	console.log(result.summary);
	console.log("================================");

	// 4. 验证 index.ts 中的 command 注册与 handler 响应
	const commands = new Map<string, any>();
	const fakePi = {
		registerTool: () => {},
		registerCommand: (name: string, def: any) => {
			commands.set(name, def);
		},
		registerFlag: () => {},
		on: () => {},
		getFlag: () => "",
		sendUserMessage: () => {},
		sendMessage: () => {},
		exec: () => {},
	};

	const mod = await import("./index.ts");
	await mod.default(fakePi as any);

	assert.ok(commands.has("subagent-gc"), "必须注册 /subagent-gc 命令");
	assert.ok(commands.has("gc"), "必须注册 /gc 命令");

	let notifyMessage = "";
	let notifyType = "";
	const fakeCtx = {
		ui: {
			notify: (msg: string, type: string) => {
				notifyMessage = msg;
				notifyType = type;
			},
		},
	};

	// 模拟执行 /gc
	await commands.get("gc").handler("24", fakeCtx);
	assert.ok(notifyMessage.includes("subagent-win 内存回收与碎片清理完成"), "执行 /gc 应通知清理完成");
	assert.equal(notifyType, "info", "通知类型应为 info");

	console.log("✅ All GC cleaner unit tests passed!");
} finally {
	try {
		rmSync(testRoot, { recursive: true, force: true });
	} catch { /* ignore */ }
}
