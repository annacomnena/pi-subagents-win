import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeTargetParam, readTimerFile } from "./timers.ts";

// P0-1：隔离进程环境
delete process.env.PI_SUBAGENT;
delete process.env.PI_TAB_RUN_ID;
delete process.env.PI_TAB_RUNS_DIR;

// ── normalizeTargetParam 纯函数 ───────────────────────────────────
{
	assert.equal(normalizeTargetParam(undefined), "self");
	assert.equal(normalizeTargetParam(null), "self");
	assert.equal(normalizeTargetParam("self"), "self");
	assert.equal(normalizeTargetParam(""), "self");
	assert.deepEqual(normalizeTargetParam({ tabRunId: "tab_abc", taskId: "T1" }), { tabRunId: "tab_abc", taskId: "T1" });
	assert.deepEqual(normalizeTargetParam({ tabRunId: "tab_abc" }), { tabRunId: "tab_abc", taskId: undefined });
	// JSON 字符串（模型序列化容错）
	assert.deepEqual(
		normalizeTargetParam('{"tabRunId":"tab_xyz","taskId":"T9"}'),
		{ tabRunId: "tab_xyz", taskId: "T9" },
	);
	// 裸 runId 简写
	assert.deepEqual(normalizeTargetParam("tab_bare_1"), { tabRunId: "tab_bare_1" });
	// 非法
	assert.deepEqual(normalizeTargetParam({}), { error: "target.tabRunId required when target is an object" });
	assert.deepEqual(normalizeTargetParam(42), { error: 'target must be "self" or { tabRunId }' });
}

// ── 端到端：set-timer execute 接受对象 / JSON 字符串 / 裸 runId ──
{
	const { registerTimers } = await import("./timers-runtime.ts");
	const tools = new Map<string, {
		execute: (id: string, p: unknown, _s?: unknown, _u?: unknown, _c?: unknown) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>;
	}>();
	const tdir = mkdtempSync(join(tmpdir(), "timers-target-compat-"));
	const pi = {
		on: () => {},
		registerTool: (t: { name: string; execute: unknown }) => { tools.set(t.name, t as never); },
		registerCommand: () => {},
		sendUserMessage: () => {},
	} as never;
	const cleanup = registerTimers(pi, { timersDir: tdir } as never);
	const set = tools.get("set-timer")!;
	const idOf = (text: string): string => {
		const m = text.match(/timer_[A-Za-z0-9_]+/);
		assert.ok(m, `应返回 timer id: ${text}`);
		return m[0];
	};

	// 1) 对象形式（原有能力不退化）
	const r1 = await set.execute("", { message: "对象 target", delayMs: 60_000, target: { tabRunId: "tab_obj_1" } });
	assert.ok(!r1.isError, r1.content[0]?.text);
	assert.ok(r1.content[0]?.text.includes("tab:tab_obj_1"), r1.content[0]?.text);
	const rec1 = readTimerFile(tdir, idOf(r1.content[0]?.text ?? ""), "tab_obj_1");
	assert.deepEqual(rec1?.target, { tabRunId: "tab_obj_1", taskId: undefined });

	// 2) JSON 字符串（本次修复：此前在 pi 校验层恒败，anyOf 全分支拒绝）
	const r2 = await set.execute("", { message: "JSON 字符串 target", delayMs: 60_000, target: '{"tabRunId":"tab_json_1"}' });
	assert.ok(!r2.isError, r2.content[0]?.text);
	assert.ok(r2.content[0]?.text.includes("tab:tab_json_1"), r2.content[0]?.text);
	const rec2 = readTimerFile(tdir, idOf(r2.content[0]?.text ?? ""), "tab_json_1");
	assert.deepEqual(rec2?.target, { tabRunId: "tab_json_1", taskId: undefined });

	// 3) 裸 runId 简写
	const r3 = await set.execute("", { message: "裸 runId target", delayMs: 60_000, target: "tab_bare_1" });
	assert.ok(!r3.isError, r3.content[0]?.text);
	assert.ok(r3.content[0]?.text.includes("tab:tab_bare_1"), r3.content[0]?.text);

	// 4) 缺省 / "self" 照旧落根目录
	const r4 = await set.execute("", { message: "缺省 self", delayMs: 60_000 });
	assert.ok(!r4.isError, r4.content[0]?.text);
	assert.ok(r4.content[0]?.text.includes("target=self"), r4.content[0]?.text);

	// 5) 非法 target 给出可读错误而非校验崩溃
	const r5 = await set.execute("", { message: "非法", delayMs: 60_000, target: { nope: 1 } });
	assert.ok(r5.isError, "非法 target 应返回错误");
	assert.ok(r5.content[0]?.text.includes("tabRunId"), r5.content[0]?.text);

	cleanup();
	rmSync(tdir, { recursive: true, force: true });
}

console.log("timers-target-compat tests passed");
