/**
 * _test_status_isolation.ts — L3 status 默认会话隔离（2026-09-23）
 *
 * 覆盖：
 *   A. 派发者无参可见自己最新的 run（同会话多 run 取时间最新）
 *   B. 外会话无参看不见 A 的 run（只见自己派发的；无归属时 fail closed）
 *   C. 外会话显式 runId 可见（跨会话显式允许：全局查找不做会话过滤）
 *   D. 无可信派发记录（unknown/缺失）→ 不归属任何会话
 *   E. 源码门禁：index.ts status 分支含隔离标记（防回退）
 *
 * 说明：status handler 内嵌 extension 工厂，单测不直接调用 handler；
 * 归属判定用真实 links.ts / identity.ts 函数，判定谓词与分支逐行一致，
 * 另以源码标记断言绑定真实分支实现。
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listLinks, recordLink } from "./links.ts";
import { getCurrentSessionId, sessionScopeKey, setCurrentSessionId } from "./identity.ts";

// 隔离：非 tab、非子 agent
delete process.env.PI_SUBAGENT;
delete process.env.PI_TAB_RUN_ID;

const dir = mkdtempSync(join(tmpdir(), "status-isolation-test-"));
const linksPath = join(dir, "links.jsonl");

// ── 与 extensions/index.ts status 分支逐行一致的判定 ──
function dispatcherOf(runId: string): string | undefined {
	const links = listLinks(linksPath);
	for (const link of links) {
		if (link.kind !== "async" || link.targetId !== runId) continue;
		if (link.sessionId && link.sessionId !== "unknown") return link.sessionId;
	}
	return undefined;
}
function isMine(runId: string): boolean {
	const d = dispatcherOf(runId);
	const myIds = new Set(
		[sessionScopeKey(), getCurrentSessionId()].filter((v): v is string => !!v),
	);
	return d !== undefined && myIds.has(d);
}
// runs 按 startedAt 倒序（与 listAsyncRuns 一致）；无参取首个归属本会话的
function statusNoArg(runs: { id: string; startedAt: string }[]): string | undefined {
	return runs.filter((r) => isMine(r.id))[0]?.id;
}
// 显式 runId：全局查找，不做会话过滤（与分支 p.runId 路径一致）
function statusById(runs: { id: string }[], runId: string): string | undefined {
	return runs.find((r) => r.id === runId)?.id;
}

// ── 布景：A 派发 run_a1、run_a2（a2 更新）；B 派发 run_b1 ──
recordLink({ sessionId: "sess_A", kind: "async", targetId: "run_a1", detail: "agent=x" }, { linksPath, at: "2026-09-23T01:00:00.000Z" });
recordLink({ sessionId: "sess_A", kind: "async", targetId: "run_a2", detail: "agent=x" }, { linksPath, at: "2026-09-23T02:00:00.000Z" });
recordLink({ sessionId: "sess_B", kind: "async", targetId: "run_b1", detail: "agent=y" }, { linksPath, at: "2026-09-23T03:00:00.000Z" });
// 不可信记录：unknown 派发 + 无记录 run
recordLink({ sessionId: "unknown", kind: "async", targetId: "run_orphan", detail: "agent=z" }, { linksPath, at: "2026-09-23T04:00:00.000Z" });

const runs = [
	{ id: "run_orphan", startedAt: "2026-09-23T04:00:00.000Z" },
	{ id: "run_b1", startedAt: "2026-09-23T03:00:00.000Z" },
	{ id: "run_a2", startedAt: "2026-09-23T02:00:00.000Z" },
	{ id: "run_a1", startedAt: "2026-09-23T01:00:00.000Z" },
	{ id: "run_ghost", startedAt: "2026-09-23T05:00:00.000Z" }, // 无 link 记录
];

// A：无参可见自己最新（run_a2），看不见 B 的 run_b1
setCurrentSessionId("sess_A");
assert.equal(statusNoArg(runs), "run_a2", "A 无参应返回自己最新的 run_a2");
assert.equal(isMine("run_b1"), false, "A 不应归属 B 的 run");

// B：无参只见 run_b1，看不见 A 的 run_a1/run_a2
setCurrentSessionId("sess_B");
assert.equal(statusNoArg(runs), "run_b1", "B 无参应只返回自己的 run_b1");
assert.equal(isMine("run_a1"), false, "B 无参看不见 A 的 run_a1");
assert.equal(isMine("run_a2"), false, "B 无参看不见 A 的 run_a2");

// C：外会话显式 runId 可见（B 查 A 的 run_a1）
assert.equal(statusById(runs, "run_a1"), "run_a1", "显式 runId 应跨会话可见");
assert.equal(statusById(runs, "run_nope"), undefined, "显式未知 runId 应为 undefined（分支报 not found）");

// D：fail closed——unknown 派发 / 无记录 run 不归属任何会话
setCurrentSessionId("sess_A");
assert.equal(isMine("run_orphan"), false, "unknown 派发不应归属 A");
assert.equal(isMine("run_ghost"), false, "无 link 记录不应归属任何会话");
setCurrentSessionId(undefined);
assert.equal(statusNoArg(runs), undefined, "无会话身份时无参应返回空（分支报文无 run）");

// E：源码门禁——真实分支含隔离实现
const src = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
const statusIdx = src.indexOf('p.action === "status"');
assert.ok(statusIdx > 0, "应找到 status 分支");
const branch = src.slice(statusIdx, statusIdx + 3000);
assert.ok(branch.includes("No async runs for this session yet"), "无归属文案不得谎称全局没有");
assert.ok(branch.includes("sessionScopeKey()"), "分支须用 sessionScopeKey 双域比对");
assert.ok(branch.includes("getCurrentSessionId()"), "分支须用 getCurrentSessionId 双域比对");
assert.ok(branch.includes('link.kind !== "async"'), "分支须按 kind===async 找派发记录");
assert.ok(branch.includes("runs.find((r) => r.id === p.runId)"), "显式 runId 保持全局查找");

setCurrentSessionId(undefined);
rmSync(dir, { recursive: true, force: true });

console.log("status isolation tests passed (A/B/C/D/E)");
