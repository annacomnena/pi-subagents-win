import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	onNewReport,
	listReportIds,
	pollNewReports,
	readReportFile,
	registerReportListener,
	sendReportToMain,
	_resetReportListener,
} from "./report.ts";

delete process.env.PI_SUBAGENT;
delete process.env.PI_TAB_RUN_ID;

const dir = mkdtempSync(join(tmpdir(), "report-test-"));
const reportsDir = join(dir, "reports");

// ── 发送 + 读取 ───────────────────────────────────────────────────
{
	const id = sendReportToMain({ from: "tab_1", message: "批次完成，请回收", taskId: "1007", summary: "3 artifacts" }, reportsDir);
	assert.ok(id.startsWith("report_"), id);
	const rec = readReportFile(reportsDir, id);
	assert.equal(rec?.from, "tab_1");
	assert.equal(rec?.message, "批次完成，请回收");
	assert.equal(rec?.taskId, "1007");
	assert.equal(rec?.summary, "3 artifacts");
	assert.ok(rec?.at && rec.pid > 0);

	// 损坏文件 → null
	const { writeFileSync } = await import("node:fs");
	writeFileSync(join(reportsDir, "report_broken.json"), "{bad", "utf8");
	assert.equal(readReportFile(reportsDir, "report_broken"), null);
}

// ── 监听：幂等注入（用独立子目录隔离第一块的报告）───────────────
{
	_resetReportListener();
	const injected: string[] = [];
	const reportsDir2 = join(dir, "reports2");
	const opts = {
		reportsDir: reportsDir2,
		toast: false,
		sendUserMessage: (content: string, _o?: unknown) => { injected.push(content); },
	};

	// 新回报 → 注入
	sendReportToMain({ from: "tab_2", message: "完成 X", taskId: "1008", summary: "done" }, reportsDir2);
	const fired = pollNewReports(reportsDir2, opts);
	assert.equal(fired.length, 1);
	assert.equal(injected.length, 1, "新回报应注入一条用户消息");
	assert.ok(injected[0].includes("tab_2"), injected[0]);
	assert.ok(injected[0].includes("完成 X"), "应含回报消息");
	assert.ok(injected[0].includes("1008"), "应含 taskId");

	// 重复 poll → 幂等（已 seen 不再注入）
	const again = pollNewReports(reportsDir2, opts);
	assert.equal(again.length, 0);
	assert.equal(injected.length, 1);
}

// ── registerReportListener：主会话才启动监听（惰性：session_start 时判定）──
{
	_resetReportListener();
	const makePi = () => ({
		on: (_evt: string, _h: unknown) => {},
		sendUserMessage: (_c: string, _o?: unknown) => {},
	});

	process.env.PI_SUBAGENT = "1";
	const cleanup1 = registerReportListener(makePi() as never, { reportsDir });
	assert.ok(typeof cleanup1 === "function");
	cleanup1();
	delete process.env.PI_SUBAGENT;

	const cleanup2 = registerReportListener(makePi() as never, { reportsDir });
	assert.ok(typeof cleanup2 === "function");
	cleanup2();
	_resetReportListener();
}

// ── 跨实例幂等：.notified 文件去重（根治双 watcher 双注入）───────
{
	_resetReportListener();
	const sent: string[] = [];
	const reportsDir3 = join(dir, "reports3");
	const opts = {
		reportsDir: reportsDir3,
		toast: false,
		sendUserMessage: (content: string, _o?: unknown) => { sent.push(content); },
	};

	sendReportToMain({ from: "tab_9", message: "完成 X", taskId: "9", summary: "s" }, reportsDir3);
	const ids = listReportIds(reportsDir3);
	assert.equal(ids.length, 1);
	const id = ids[0];

	const first = onNewReport(reportsDir3, id, opts);
	assert.equal(first, true, "首实例应 claim 并注入");
	assert.equal(sent.length, 1);
	assert.equal(existsSync(join(reportsDir3, `${id}.notified`)), true, "应创建 .notified 标记");

	// 第二实例（seenReports 已重置）：.notified 存在 → 跳过
	_resetReportListener();
	const second = onNewReport(reportsDir3, id, opts);
	assert.equal(second, false, "第二实例看到 .notified 应跳过");
	assert.equal(sent.length, 1, "不得重复注入");
}

rmSync(dir, { recursive: true, force: true });

console.log("report tests passed");
