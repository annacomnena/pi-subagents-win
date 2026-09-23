/**
 * L3 parallel 缺省异步 + 模型披露测试（2026-09-23）
 *
 * 覆盖：
 *  1. parallel 缺省（不传 async）立返 runId 列表 + run 文件落盘 + link 可查 + 后台完成
 *  2. parallel async:false 仍阻塞回结果，且分项标题带 /model
 *  3. 单发同步（async:false）返回正文带 Agent:/Model: 行
 *  4. status 输出带 Model: 行（含 running/failed 记录的 dispatch 期 model）
 *  5. 未知 agent 的并行异步项直接落 failed 记录（不 spawn）
 *
 * 原理：PI_CLI_PATH 指向一个 stub 脚本（忽略参数，秒回一条 message_end/stop），
 * 真实走 runWithFallback → runSingle → spawn 解析管线，但不调任何外部模型。
 *
 * 运行：node --experimental-strip-types ./extensions/_test_parallel_async.ts
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { listLinks } from "./links.ts";

// ── 环境隔离：主会话身份 ─────────────────────────
delete process.env.PI_SUBAGENT;
delete process.env.PI_TAB_RUN_ID;
delete process.env.PI_TAB_RUNS_DIR;
delete process.env.PI_SESSION_PROFILE;

// ── stub pi CLI：秒回 completed ──────────────────
const STUB_PATH = join(tmpdir(), `pi-stub-cli-parallel-async-${process.pid}.mjs`);
writeFileSync(
	STUB_PATH,
	`console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "stub-output-ok" }], usage: { input: 11, output: 22 }, model: "stub-1" } }));\n`,
	"utf8",
);
process.env.PI_CLI_PATH = STUB_PATH;

const RUNS_DIR = join(homedir(), ".pi", "agent", "subagent-runs");
const MODEL = "TestSuite/stub-1";
const createdRunIds: string[] = [];
const track = (ids: string[]): string[] => { createdRunIds.push(...ids); return ids; };
const runFile = (id: string): string => join(RUNS_DIR, `${id}.json`);
const readRun = (id: string): any => JSON.parse(readFileSync(runFile(id), "utf8"));
const extractRunIds = (text: string): string[] =>
	[...new Set(text.match(/run_[a-z0-9]+_[a-z0-9]+/g) ?? [])];
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitFor(id: string, want: string, timeoutMs = 30000): Promise<any> {
	const start = Date.now();
	for (;;) {
		const rec = readRun(id);
		if (rec.status === want) return rec;
		if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting ${id} -> ${want} (last=${rec.status})`);
		await sleep(200);
	}
}

// ── fake pi（复用 register-graph 范式） ──────────
const tools = new Map<string, any>();
const fakePi = {
	registerTool(def: { name: string }): void { tools.set(def.name, def); },
	registerCommand(_name: string, _opts: unknown): void {},
	registerFlag(_name: string, _opts: unknown): void {},
	on(_event: string, _handler: unknown): void {},
	getFlag(_name: string): string { return ""; },
	sendUserMessage: () => {},
	sendMessage: () => {},
	exec: () => {},
} as unknown as ExtensionAPI;

const fakeCtx = { sessionManager: { sessionId: "test-parallel-async" } } as never;

const mod = await import("./index.ts");
await mod.default(fakePi);
const tool = tools.get("subagent-win");
assert.ok(tool?.execute, "subagent-win tool must be registered");
const textOf = (res: any): string => res?.content?.[0]?.text ?? "";

// 1. parallel 缺省 → 立返 runId ──────────────────
{
	const t0 = Date.now();
	const res = await tool.execute("t1", { tasks: [{ task: "pa", model: MODEL }, { task: "pb", model: MODEL }] }, undefined, undefined, fakeCtx);
	const elapsed = Date.now() - t0;
	const text = textOf(res);
	assert.ok(elapsed < 15000, `parallel default must return immediately (took ${elapsed}ms)`);
	assert.ok(text.startsWith("Async parallel started: 2 task(s)"), `unexpected head: ${text.slice(0, 120)}`);
	const ids = track(extractRunIds(text));
	assert.equal(ids.length, 2, `expect 2 runIds, got: ${text}`);
	for (const id of ids) {
		assert.ok(existsSync(runFile(id)), `run file missing: ${id}`);
		const rec = readRun(id);
		assert.ok(rec.status === "running" || rec.status === "completed", `unexpected status ${rec.status}`);
		assert.equal(rec.task.length > 0, true);
		assert.ok(rec.startedAt, "startedAt required");
		const link = listLinks().find((l) => l.kind === "async" && l.targetId === id);
		assert.ok(link, `async link missing for ${id}`);
	}
	// 后台完成 + status 的 Model 行
	for (const id of ids) {
		const rec = await waitFor(id, "completed");
		assert.ok(String(rec.result?.text ?? "").includes("stub-output-ok"), "async result text mismatch");
	}
	const st = await tool.execute("t1s", { action: "status", runId: ids[0] }, undefined, undefined, fakeCtx);
	const stText = textOf(st);
	assert.ok(stText.includes("Agent: (none)"), `status Agent line missing: ${stText}`);
	assert.ok(stText.includes(`Model: ${MODEL}`), `status Model line missing: ${stText}`);
	console.log("[1] parallel default async: 立返 + 落盘 + link + 后台完成 + status Model 行 ✓");
}

// 2. parallel async:false → 阻塞 + 标题带 model ──
{
	const res = await tool.execute("t2", { tasks: [{ task: "s1", model: MODEL }], async: false }, undefined, undefined, fakeCtx);
	const text = textOf(res);
	assert.ok(text.includes(`### ✓ task-1/${MODEL} (completed)`), `sync parallel title must carry model: ${text.slice(0, 200)}`);
	console.log("[2] parallel async:false: 阻塞回结果 + ### agent/model (status) ✓");
}

// 3. 单发同步 → Agent:/Model: 行 ────────────────
{
	const res = await tool.execute("t3", { task: "solo", model: MODEL, async: false }, undefined, undefined, fakeCtx);
	const text = textOf(res);
	assert.ok(text.includes("Agent: (none)"), `single sync Agent line missing: ${text.slice(0, 160)}`);
	assert.ok(text.includes(`Model: ${MODEL}`), `single sync Model line missing: ${text.slice(0, 160)}`);
	assert.ok(text.includes("stub-output-ok"), "single sync body missing");
	console.log("[3] single async:false: Agent:/Model: 头 + 正文 ✓");
}

// 4. 未知 agent 并行异步 → 直接 failed 记录 ──────
{
	const res = await tool.execute("t4", { tasks: [{ agent: "__nope__", task: "x", model: MODEL }] }, undefined, undefined, fakeCtx);
	const text = textOf(res);
	const ids = track(extractRunIds(text));
	assert.equal(ids.length, 1);
	assert.ok(text.includes("failed: unknown agent"), `unknown agent line missing: ${text}`);
	const rec = readRun(ids[0]);
	assert.equal(rec.status, "failed");
	assert.ok(listLinks().some((l) => l.kind === "async" && l.targetId === ids[0]), "unknown-agent link missing");
	const st = await tool.execute("t4s", { action: "status", runId: ids[0] }, undefined, undefined, fakeCtx);
	assert.ok(textOf(st).includes(`Model: ${MODEL}`), "failed record status must still show dispatch model");
	console.log("[4] parallel unknown agent: failed 落盘 + Model 行 ✓");
}

// ── 清理：run 文件 + stub ──────────────────────
for (const id of createdRunIds) {
	try { if (existsSync(runFile(id))) unlinkSync(runFile(id)); } catch { /* ignore */ }
}
try { if (existsSync(STUB_PATH)) unlinkSync(STUB_PATH); } catch { /* ignore */ }
console.log("[parallel-async] ALL PASS");
