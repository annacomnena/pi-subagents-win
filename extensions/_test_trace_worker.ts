/**
 * _test_trace_worker.ts — trace worker 注入段测试（trace-fusion C4）
 *
 * 锁定 buildTraceWorkerSystemPrompt 的契约：
 *   - 身份声明（三路独立 rollout 之一）
 *   - 硬编排边界：禁 Full/Lite workflow、禁 launch-tabs、禁全部角色 agent、
 *     唯一允许 searcher，且声明运行时 guard 兜底（不只靠 prompt）
 *   - 执行自由（edit/test/instrument）与独立性（看不到其它 lane、不对齐）
 *   - FINISH 九项终态报告契约（对应设计稿 §20.1 / §21 trajectory.md 章节骨架）
 *
 * 运行：node --experimental-strip-types extensions/_test_trace_worker.ts
 */

import assert from "node:assert/strict";
import { buildTraceWorkerSystemPrompt } from "./trace-worker.ts";

const plain = buildTraceWorkerSystemPrompt();
const laneA = buildTraceWorkerSystemPrompt("A");

// ── 身份 ─────────────────────────────────────────────────────────
assert.ok(laneA.includes("Trace Fusion Worker"));
assert.ok(laneA.includes("(lane A)"), "lane 标签应注入");
assert.ok(laneA.includes("Trace A,"), "正文应声明 lane 身份");
assert.equal(plain.includes("(lane"), false, "无 lane 时不应出现空 lane 标签");

// ── 硬编排边界 ───────────────────────────────────────────────────
assert.ok(plain.includes("Do not use Full workflow"));
assert.ok(plain.includes("Do not use Lite workflow"));
assert.ok(plain.includes("Do not invoke launch-tabs"));
for (const role of ["planner", "implementer", "reviewer", "consultant", "general"]) {
	assert.ok(plain.includes(role), `应点名禁止角色 ${role}`);
}
assert.ok(plain.includes('agent: "searcher"'), "唯一允许的委派形态应可复制");
assert.ok(plain.includes("also enforced at runtime"), "必须声明运行时 guard 兜底，非纯 prompt 约束");

// ── 执行自由与独立性 ─────────────────────────────────────────────
assert.ok(plain.includes("edit code"));
assert.ok(plain.includes("run builds and tests"));
assert.ok(plain.includes("Failures are useful evidence"));
assert.ok(plain.includes("cannot see the other trace lanes"));
assert.ok(plain.includes("Do not optimize for agreement"));

// ── GIT 与终态契约 ───────────────────────────────────────────────
assert.ok(plain.includes("worktree is disposable"));
assert.ok(plain.includes("Do not modify anything outside this worktree"));
for (const item of ["root cause", "experiments performed", "files changed", "validation commands", "unresolved risks", "recommended final direction"]) {
	assert.ok(plain.includes(item), `FINISH 契约缺项：${item}`);
}

console.log("trace-worker tests passed");
