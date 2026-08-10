import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTabResultFile, pollNewResults, _resetEventBus, registerEventBus } from "./event-bus.ts";
import { readTabResultFile } from "./tab-runs.ts";

delete process.env.PI_SUBAGENT;
delete process.env.PI_TAB_RUN_ID;

const dir = mkdtempSync(join(tmpdir(), "event-bus-test-"));

function writeResult(runId: string, status = "completed") {
	writeFileSync(join(dir, `${runId}.result.json`), JSON.stringify({
		id: runId, taskId: "1007", status, finishedAt: new Date().toISOString(), summary: "批次完成",
	}), "utf8");
}

// ── 幂等：同一 result 只触发一次 ─────────────────────────────────
{
	const fired: string[] = [];
	writeResult("tab_a");
	const opts = { runsDir: dir, toast: false, autoReclaim: false, onTabFinished: (r: string) => fired.push(r) };

	const first = onTabResultFile(dir, "tab_a.result.json", opts);
	assert.equal(first, true, "首次应触发");
	assert.deepEqual(fired, ["tab_a"]);

	const second = onTabResultFile(dir, "tab_a.result.json", opts);
	assert.equal(second, false, "重复文件不应再触发");
	assert.deepEqual(fired, ["tab_a"], "幂等");
}

// ── pollNewResults：处理所有未见过的文件（snapshot 语义属于 registerEventBus）──
{
	_resetEventBus();
	const fired: string[] = [];
	const opts = { runsDir: dir, toast: false, autoReclaim: false, onTabFinished: (r: string) => fired.push(r) };

	// 用独立子目录隔离本块
	const dirPoll = join(dir, "poll");
	const mkdirSync = (await import("node:fs")).mkdirSync;
	mkdirSync(dirPoll, { recursive: true });
	const writePoll = (rid: string) => writeFileSync(join(dirPoll, `${rid}.result.json`), JSON.stringify({ id: rid, taskId: "1", status: "completed", finishedAt: new Date().toISOString(), summary: "s" }), "utf8");
	writePoll("tab_old");
	writePoll("tab_new");

	const firedFirst = pollNewResults(dirPoll, opts);
	assert.deepEqual(firedFirst.sort(), ["tab_new.result.json", "tab_old.result.json"].sort(), "poll 处理全部未见文件");

	// 再 poll → 已 seen，不再触发（幂等）
	const firedSecond = pollNewResults(dirPoll, opts);
	assert.deepEqual(firedSecond, [], "重复 poll 幂等");
}

// ── autoReclaim：注入用户消息（带完整结果回报）────────────────────
{
	_resetEventBus();
	const sent: string[] = [];
	// 带 artifacts/reportPath 的结果
	writeFileSync(join(dir, "tab_reclaim.result.json"), JSON.stringify({
		id: "tab_reclaim", taskId: "1007", status: "completed", finishedAt: new Date().toISOString(),
		summary: "批次完成",
		artifacts: ["plans/20260806.md", "Wiki/Modules/xxx.md"],
		reportPath: "plans/20260806_research.md",
		usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.0123, turns: 1 },
	}), "utf8");
	const opts = {
		runsDir: dir,
		toast: false,
		autoReclaim: true,
		sendUserMessage: (content: string, _o?: unknown) => { sent.push(content); },
	};
	onTabResultFile(dir, "tab_reclaim.result.json", opts);
	assert.equal(sent.length, 1, "autoReclaim 应注入消息");
	assert.ok(sent[0].includes("tab_reclaim"), sent[0]);
	assert.ok(sent[0].includes("reclaim-tabs"), "应指引模型去回收");
	assert.ok(sent[0].includes("批次完成"), "回报应带 summary");
	assert.ok(sent[0].includes("plans/20260806.md"), "回报应带 artifacts");
	assert.ok(sent[0].includes("plans/20260806_research.md"), "回报应带 reportPath");
	assert.ok(sent[0].includes("$0.0123"), "回报应带 cost");

	const result = readTabResultFile(dir, "tab_reclaim");
	assert.equal(result?.status, "completed");
}

// ── registerEventBus：主会话才启动监听（惰性：session_start 时判定）──
{
	_resetEventBus();
	const makePi = () => ({
		on: (_evt: string, _h: unknown) => {},
		sendUserMessage: (_c: string, _o?: unknown) => {},
	});

	// 子 agent → cleanup 存在，session_start 处理器不启动 watcher（不报错即可）
	process.env.PI_SUBAGENT = "1";
	const cleanup1 = registerEventBus(makePi() as never, { runsDir: dir });
	assert.ok(typeof cleanup1 === "function");
	cleanup1();
	delete process.env.PI_SUBAGENT;

	// 主会话 → 注册成功且返回 cleanup
	const cleanup2 = registerEventBus(makePi() as never, { runsDir: dir });
	assert.ok(typeof cleanup2 === "function");
	cleanup2();
	_resetEventBus();
}

rmSync(dir, { recursive: true, force: true });

console.log("event-bus tests passed");
