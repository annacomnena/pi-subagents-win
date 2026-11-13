import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshAsyncPanel, bindAsyncPanelUi, clearAsyncPanelUi, notifyAsyncCompletion, shortTaskLabel, shortModelLabel, type AsyncPanelRecord } from "./async-panel.ts";

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

// ── 无记录 → 清除卡片（传 undefined 让 pi 移除 widget，而非常驻一行） ─────
{
	const ui = makeFakeUi();
	refreshAsyncPanel(dir, ui);
	assert.equal(ui.widgets.get("subagent-async"), undefined, "空面板应清除 widget");
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
	assert.ok(lines.some((l) => l.includes("✓ 1 completed")), `成功应压缩为计数行: ${lines.join(" | ")}`);
	assert.ok(!lines.some((l) => l.includes("调研 X")), "成功任务明细不应逐条上墙");
	assert.equal(ui.statuses.get("subagent-async"), undefined, "无 running 时状态栏摘要应清除");
}

// ── 短标签：句读截断 + 超长硬截 ───────────────────────────────────
{
	assert.equal(shortTaskLabel("L3 实现：会话 rail 三件套。完成后不提交，回复…"), "L3 实现：会话 rail 三件套。");
	assert.equal(shortTaskLabel("short"), "short");
	assert.ok(shortTaskLabel("无句读但超长超长超长超长超长超长超长超长超长超长超长超长超长超长超长超长超长超长超长超长").endsWith("…"), "超长应硬截");
}

// ── 反例：缺 task 的磁盘记录不得炸面板（真实事故 2026-11-13）──────
// run_fusemweer6ma_jryr.json（agent=fusion，579 字节）**无 task 字段** ⇒
// 面板 timer 调 shortTaskLabel(undefined).replace() ⇒ uncaughtException **杀掉整个主会话**。
{
	assert.equal(shortTaskLabel(undefined as unknown as string), "(无任务文本)", "undefined task 应走兜底");
	assert.equal(shortTaskLabel(null as unknown as string), "(无任务文本)");
	assert.equal(shortTaskLabel(""), "(空任务文本)");
	assert.equal(shortTaskLabel("   \n  "), "(空任务文本)");

	const ui = makeFakeUi();
	const dirNoTask = join(dir, "notask");
	mkdirSync(dirNoTask, { recursive: true });
	// 逐字模拟事故记录：无 task、有 agent/model/status=failed
	writeFileSync(
		join(dirNoTask, "run_fusemweer6ma_jryr.json"),
		JSON.stringify({
			id: "run_fusemweer6ma_jryr",
			agent: "fusion",
			model: "local-ornith/ornith",
			status: "failed",
			startedAt: new Date(Date.now() - 60_000).toISOString(),
			finishedAt: new Date(Date.now() - 10_000).toISOString(),
		}),
		"utf8",
	);
	assert.doesNotThrow(() => refreshAsyncPanel(dirNoTask, ui), "缺 task 的记录不得让面板抛（timer 里抛 = 杀会话）");
	const l = ui.widgets.get("subagent-async");
	assert.ok(l, "应仍有 widget");
	assert.ok(
		l.some((x) => x.includes("run_fusemweer6ma_jryr") && x.includes("(无任务文本)")),
		`失败卡片应以兜底标签上墙: ${l.join(" | ")}`,
	);
}

// ── 失败逐条保留（含 error 尾） ────────────────────────────────────
{
	const ui = makeFakeUi();
	const dirFail = join(dir, "fail");
	mkdirSync(dirFail, { recursive: true });
	writeFileSync(join(dirFail, "run_f.json"), JSON.stringify({ id: "run_f", agent: "general", task: "做 X。细节", status: "failed", startedAt: new Date().toISOString(), result: { error: "boom happened" } }), "utf8");
	refreshAsyncPanel(dirFail, ui);
	const lines = ui.widgets.get("subagent-async");
	assert.ok(lines.some((l) => l.includes("✗ general") && l.includes("boom")) , `失败应逐条+error 尾: ${lines?.join(" | ")}`);
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
	// 假 runsDir（不存在）→ 静默清除卡片
	const ui2 = makeFakeUi();
	refreshAsyncPanel(join(dir, "does-not-exist"), ui2);
	assert.equal(ui2.widgets.get("subagent-async"), undefined, "不存在的 runsDir 应清除 widget");
}

// ── notifyAsyncCompletion 不抛错（toast 是 fire-and-forget）───────
{
	notifyAsyncCompletion({ id: "run_c", agent: "searcher", task: "x", status: "completed", startedAt: new Date().toISOString() });
	notifyAsyncCompletion({ id: "run_d", agent: "implementer", task: "y", status: "failed", result: { error: "boom" }, startedAt: new Date().toISOString() });
}

// ── clearAsyncPanelUi：丢弃缓存 UI 引用（reload 后旧 ctx stale）─────
{
	const ui = makeFakeUi();
	bindAsyncPanelUi(ui);
	clearAsyncPanelUi();
	// 清空后刷新静默（无 UI 引用），不抛错
	refreshAsyncPanel();
	assert.equal(typeof clearAsyncPanelUi, "function");
}

// ── 模型显示（2026-11-06）：绑在 agent 上 `searcher[bonsai]: …` ──────
{
	const ui = makeFakeUi();
	const d2 = mkdtempSync(join(tmpdir(), "async-panel-model-"));
	const w2 = (rec: AsyncPanelRecord) => writeFileSync(join(d2, `${rec.id}.json`), JSON.stringify(rec), "utf8");
	w2({ id: "run_m1", agent: "searcher", model: "local-bonsai/bonsai", task: "调研 X", status: "running", startedAt: new Date(Date.now() - 10_000).toISOString() });
	w2({ id: "run_m2", agent: "general", model: "opendesigngo/deepseek-v4.1-flash", task: "长任务", status: "running", startedAt: new Date(Date.now() - 5_000).toISOString() });
	w2({ id: "run_m3", agent: "general", task: "无模型的失败", status: "failed", result: { error: "503" }, startedAt: new Date().toISOString() });
	refreshAsyncPanel(d2, ui);
	const lines = ui.widgets.get("subagent-async") ?? [];
	const joined = lines.join(" | ");
	assert.ok(joined.includes("searcher[bonsai]"), `模型须绑在 agent 上：searcher[bonsai]（实际：${joined}）`);
	assert.ok(!joined.includes("local-bonsai/"), "面板只显示短名，不显示 provider 前缀");
	// 32 字符全名须被截断成 ≤14 字符（含省略号）
	assert.ok(joined.includes("general[deepseek-v4.1…]"), `超长模型名须截断（实际：${joined}）`);
	// 无 model 不得出现空方括号
	assert.ok(!joined.includes("general[]"), "无 model 时不得出现空方括号");
	assert.ok(joined.includes("✗ general:"), "失败行在无 model 时保持原样（无 bracket）");
	rmSync(d2, { recursive: true, force: true });
}

// ── shortModelLabel 纯函数：边界 ──────────────────────────────────
{
	assert.equal(shortModelLabel("local-bonsai/bonsai"), "bonsai");
	assert.equal(shortModelLabel("Zhipu/glm-5.3"), "glm-5.3");
	assert.equal(shortModelLabel("no-slash-model"), "no-slash-model");
	assert.equal(shortModelLabel("a/" ), "a/", "尾斜杠不丢成空串");
	assert.equal(shortModelLabel(""), undefined);
	assert.equal(shortModelLabel(undefined), undefined);
	assert.equal(shortModelLabel(null), undefined);
	assert.equal(shortModelLabel("   "), undefined, "纯空白视为无模型");
	// 截断：32 字符 → 14 字符（13 + 省略号）
	const long = shortModelLabel("opendesigngo/deepseek-v4.1-flash");
	assert.equal(long!.length, 14, `截断后长度须为 14（实际 ${long}）`);
	assert.ok(long!.endsWith("…"), "截断须带省略号（可见地告知被截）");
	// provider 前缀同名不同源：这是已知代价，显式断言当前行为（不是「测意外」）
	assert.equal(shortModelLabel("lan-199/bonsai"), shortModelLabel("local-bonsai/bonsai"), "已知代价：末段相同会失去源信息（面板概览面，非审计面）");
}

rmSync(dir, { recursive: true, force: true });

console.log("async-panel tests passed");
