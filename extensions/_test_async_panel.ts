import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshAsyncPanel, bindAsyncPanelUi, notifyAsyncCompletion, type AsyncPanelRecord } from "./async-panel.ts";

// P0-1 同款：隔离进程环境（本模块不读 PI_*，但保持测试可移植）
delete process.env.PI_SUBAGENT;
delete process.env.PI_TAB_RUN_ID;

// ── fake UI：捕获 setWidget / setStatus ───────────────────────────
function makeFakeUi() {
	const widgets = new Map<string, string[] | undefined>();
	const statuses = new Map<string, string | undefined>();
	return {
		widgets,
		statuses,
		setWidget(key: string, content: string[] | undefined) { widgets.set(key, content); },
		setStatus(key: string, text: string | undefined) { statuses.set(key, text); },
	};
}

const dir = mkdtempSync(join(tmpdir(), "async-panel-test-"));
const write = (rec: AsyncPanelRecord) => writeFileSync(join(dir, `${rec.id}.json`), JSON.stringify(rec), "utf8");

// ── 无记录 → 空面板 ───────────────────────────────────────────────
{
	const ui = makeFakeUi();
	refreshAsyncPanel(dir, ui);
	assert.deepEqual(ui.widgets.get("subagent-async"), ["No async subagents"]);
	assert.equal(ui.statuses.get("subagent-async"), undefined);
}

// ── running 任务列表 ──────────────────────────────────────────────
{
	const ui = makeFakeUi();
	write({ id: "run_a", agent: "searcher", task: "调研 X 模块", status: "running", startedAt: new Date(Date.now() - 30_000).toISOString() });
	write({ id: "run_b", agent: "implementer", task: "实现 Y 功能", status: "running", startedAt: new Date(Date.now() - 5_000).toISOString() });

	refreshAsyncPanel(dir, ui);
	const lines = ui.widgets.get("subagent-async");
	assert.ok(lines, "应有 widget");
	assert.ok(lines.some((l) => l.includes("2 running")), `应显示 2 running: ${lines.join(" | ")}`);
	assert.ok(lines.some((l) => l.includes("searcher") && l.includes("调研 X")), "应含 searcher 任务");
	assert.ok(lines.some((l) => l.includes("run_a")), "应含 runId");
	assert.equal(ui.statuses.get("subagent-async"), "subagents: 2 running", "状态栏摘要");
}

// ── 完成后 → 摘要消失、recent done 展示 ──────────────────────────
{
	const ui = makeFakeUi();
	const dirDone = join(dir, "done");
	mkdirSync(dirDone, { recursive: true });
	const writeDone = (rec: AsyncPanelRecord) => writeFileSync(join(dirDone, `${rec.id}.json`), JSON.stringify(rec), "utf8");
	writeDone({ id: "run_a", agent: "searcher", task: "调研 X", status: "completed", startedAt: new Date(Date.now() - 60_000).toISOString(), result: { text: "ok", usage: { cost: 0.01, turns: 2 } } });

	refreshAsyncPanel(dirDone, ui);
	const lines = ui.widgets.get("subagent-async");
	assert.ok(lines, "应有 widget");
	assert.ok(lines.some((l) => l.includes("✓ searcher")), `应显示完成: ${lines.join(" | ")}`);
	assert.equal(ui.statuses.get("subagent-async"), undefined, "无 running 时状态栏摘要应清除");
}

// ── bindAsyncPanelUi + 默认 runsDir 路径（无 UI 时静默）──────────
{
	const ui = makeFakeUi();
	bindAsyncPanelUi(ui);
	// 默认 runsDir 是真实 ~/.pi/agent/subagent-runs —— 只验证不抛错
	refreshAsyncPanel();
	// 清除引用后不崩
	bindAsyncPanelUi(null);
	refreshAsyncPanel();
	// 假 runsDir（不存在）→ 静默空面板
	const ui2 = makeFakeUi();
	refreshAsyncPanel(join(dir, "does-not-exist"), ui2);
	assert.deepEqual(ui2.widgets.get("subagent-async"), ["No async subagents"]);
}

// ── notifyAsyncCompletion 不抛错（toast 是 fire-and-forget）───────
{
	notifyAsyncCompletion({ id: "run_c", agent: "searcher", task: "x", status: "completed", startedAt: new Date().toISOString() });
	notifyAsyncCompletion({ id: "run_d", agent: "implementer", task: "y", status: "failed", result: { error: "boom" }, startedAt: new Date().toISOString() });
}

rmSync(dir, { recursive: true, force: true });

console.log("async-panel tests passed");
