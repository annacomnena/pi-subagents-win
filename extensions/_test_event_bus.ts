import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTabResultFile, pollNewResults, _resetEventBus, registerEventBus } from "./event-bus.ts";
import { readTabResultFile } from "./tab-runs.ts";

delete process.env.PI_SUBAGENT;
delete process.env.PI_TAB_RUN_ID;

// 隔离 shadow journal：emit 路径不得写真实 ~/.pi/agent/runtime/（Phase 1H 修复）
process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "event-bus-journal-"));

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

// ── 跨实例幂等：.notified 文件去重（根治双 watcher 双注入）───────
{
	_resetEventBus();
	const sent: string[] = [];
	const opts = {
		runsDir: dir,
		toast: false,
		sendUserMessage: (content: string, _o?: unknown) => { sent.push(content); },
	};

	// 第一个实例：claim 成功 → 注入
	writeFileSync(join(dir, "tab_dedup.result.json"), JSON.stringify({ id: "tab_dedup", taskId: "1", status: "completed", finishedAt: new Date().toISOString(), summary: "s" }), "utf8");
	const first = onTabResultFile(dir, "tab_dedup.result.json", opts);
	assert.equal(first, true, "首实例应 claim 并注入");
	assert.equal(sent.length, 1);
	assert.equal(existsSync(join(dir, "tab_dedup.notified")), true, "应创建 .notified 标记");

	// 第二个实例（模拟 reload 后新 watcher，seenResults 已重置）：.notified 存在 → 跳过不注入
	_resetEventBus();
	const second = onTabResultFile(dir, "tab_dedup.result.json", opts);
	assert.equal(second, false, "第二实例看到 .notified 应跳过");
	assert.equal(sent.length, 1, "不得重复注入");
}

// ── 会话定位：只注入给「派发该 tab 的会话」（2026-08-13，防 identityless 会话抢注入权）──
{
	_resetEventBus();
	const sent: string[] = [];
	const linksPath = join(dir, "links.jsonl");
	const opts = {
		runsDir: dir,
		linksPath,
		toast: false,
		sendUserMessage: (content: string, _o?: unknown) => { sent.push(content); },
	};

	// links 溯源：tab_route1 由 session-B 派发
	writeFileSync(linksPath, JSON.stringify({
		sessionId: "session-B", kind: "tab", targetId: "tab_route1",
		detail: "task=1", at: new Date().toISOString(), pid: 1,
	}) + "\n", "utf8");
	writeFileSync(join(dir, "tab_route1.result.json"), JSON.stringify({
		id: "tab_route1", taskId: "1", status: "completed", finishedAt: new Date().toISOString(), summary: "s",
	}), "utf8");

	// 我是 session-A：不是派发方 → 跳过（不 claim、不注入、不 toast）
	// ——但 journal 终态必须照写（terra 缺陷 1 修复：emit 与 recipient 路由解耦，
	// rollover 后新 master session 也能补写，journal 完备性不依赖唤醒路由）
	const { setCurrentSessionId } = await import("./identity.ts");
	setCurrentSessionId("session-A");
	const skipped = onTabResultFile(dir, "tab_route1.result.json", opts);
	assert.equal(skipped, false, "非派发会话必须跳过");
	assert.equal(sent.length, 0, "不得注入");
	assert.equal(existsSync(join(dir, "tab_route1.notified")), false, "不得 claim（唤醒权留给真正派发会话）");
	{
		const { listRuntimeEnvelopes } = await import("./runtime/journal.ts");
		const mine = () => listRuntimeEnvelopes({}).envelopes.filter((e) => e.subject === "run://tab/tab_route1");
		assert.equal(mine().length, 1, "非派发会话也要写 journal 终态");
		assert.equal(mine()[0].dedupeKey, "run.completed:run://tab/tab_route1");
		assert.ok(mine()[0].at, "at = 领域发生时间");
		// 幂等：另一个实例（同样非派发方）重放同一文件 → dedupeKey claim 拒绝，不双写
		_resetEventBus();
		setCurrentSessionId("session-C");
		onTabResultFile(dir, "tab_route1.result.json", opts);
		assert.equal(mine().length, 1, "重放不双写");
	}

	// 我是 session-B（派发方）：注入
	_resetEventBus();
	setCurrentSessionId("session-B");
	const injected = onTabResultFile(dir, "tab_route1.result.json", opts);
	assert.equal(injected, true, "派发会话应注入");
	assert.equal(sent.length, 1, "应注入完成消息");
	assert.ok(sent[0].includes("tab_route1"), sent[0]);

	// 无溯源（旧账本无 sessionId）→ 回退 claim 先到先得（不阻断既有行为）
	_resetEventBus();
	setCurrentSessionId("session-A");
	writeFileSync(join(dir, "tab_legacy.result.json"), JSON.stringify({
		id: "tab_legacy", taskId: "2", status: "completed", finishedAt: new Date().toISOString(), summary: "legacy",
	}), "utf8");
	const legacy = onTabResultFile(dir, "tab_legacy.result.json", { ...opts });
	assert.equal(legacy, true, "无溯源时回退注入");

	setCurrentSessionId(undefined); // 清理，不污染后续
}

// ── Phase 3c：mailbox 影子投递（§27-28）─────────────────────
{
	_resetEventBus();
	const { setCurrentSessionId } = await import("./identity.ts");
	const opts = { runsDir: dir, toast: false, autoReclaim: false, onTabFinished: () => {} };
	writeFileSync(join(dir, "tab_mbx.result.json"), JSON.stringify({
		id: "tab_mbx", taskId: "3", status: "completed", finishedAt: new Date().toISOString(), summary: "mailbox smoke",
	}), "utf8");
	setCurrentSessionId("session-B");
	onTabResultFile(dir, "tab_mbx.result.json", opts);

	// 信落入 logical recipient（agent://master_default）的 spool，不依赖 links.jsonl sessionId
	const { listLetters, defaultMailboxDir } = await import("./runtime/mailbox.ts");
	const { masterAddress } = await import("./runtime/address.ts");
	const mine = () => listLetters(masterAddress(), undefined, defaultMailboxDir())
		.filter((l) => l.frame.subject === "run://tab/tab_mbx");
	assert.equal(mine().length, 1, "tab 终态 → mailbox 恰好一封信");
	const letter = mine()[0]!;
	assert.equal(letter.status, "pending");
	assert.equal(letter.frame.frame === "message" ? letter.frame.kind : "", "REPORT");
	assert.equal(letter.frame.subject, "run://tab/tab_mbx");
	assert.equal(letter.frame.to, "agent://master_default");
	assert.equal(String((letter.frame.body.details as Record<string, unknown> | undefined)?.tabRunId), "tab_mbx");

	// 重复触发同一 result（模拟第二个 watcher 进程）：_resetEventBus 清 seenResults，
	// dedupeId 文件名屏障防重投（跨进程幂等）
	_resetEventBus();
	onTabResultFile(dir, "tab_mbx.result.json", opts);
	assert.equal(mine().length, 1, "双 watcher 不重投");
	setCurrentSessionId(undefined);
}

rmSync(dir, { recursive: true, force: true });

console.log("event-bus tests passed");
