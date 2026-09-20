/**
 * _test_no_poll.ts — 「禁止无限轮询纪律 / No busy-polling」单一事实源常量 + worker 面负断言
 *
 * 覆盖（plans/0918_no_poll_plan.md 回归测试 #1）：
 *   - NO_POLL_DISCIPLINE：恰好 6 行（守 ≤6 行预算）+ 三锚点 busy-poll / 幂等 / STOP 是合法终态
 *   - NO_POLL_HINT：恰好 2 行 + busy-poll / 幂等
 *   - worker 面负断言：workflowDisciplineBlock 四模式（workflow/research/execute/adaptive）
 *     及 buildWorkflowTabPrompt（带/不带 skill 路径）均不含 busy-poll（防 worker 加噪回潮）
 *
 * 运行：npm run test:no-poll
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "no-poll-env-"));

import { NO_POLL_DISCIPLINE, NO_POLL_HINT } from "./no-poll.ts";
import { buildWorkflowTabPrompt, workflowDisciplineBlock, type LaunchMode } from "./launch.ts";

// ── NO_POLL_DISCIPLINE：恰好 6 行 + 三个稳定锚点 ─────────────────────
assert.ok(NO_POLL_DISCIPLINE.includes("busy-poll"), "系统级纪律应含 busy-poll 锚点");
assert.ok(NO_POLL_DISCIPLINE.includes("幂等"), "系统级纪律应含 幂等 锚点");
assert.ok(NO_POLL_DISCIPLINE.includes("STOP 是合法终态"), "系统级纪律应含「STOP 是合法终态」锚点");
assert.equal(NO_POLL_DISCIPLINE.split("\n").length, 6, "系统级纪律恰好 6 行（长度预算）");

// ── NO_POLL_HINT：恰好 2 行 + 锚点 ──────────────────────────────────
assert.ok(NO_POLL_HINT.includes("busy-poll"), "消息级 hint 应含 busy-poll 锚点");
assert.ok(NO_POLL_HINT.includes("幂等"), "消息级 hint 应含 幂等 锚点");
assert.equal(NO_POLL_HINT.split("\n").length, 2, "消息级 hint 恰好 2 行（长度预算）");

// ── worker 面负断言：四模式纪律块不含禁轮询文本 ─────────────────────
const modes: LaunchMode[] = ["workflow", "research", "execute", "adaptive"];
for (const mode of modes) {
	const block = workflowDisciplineBlock("1007", undefined, mode);
	assert.ok(!block.includes("busy-poll"), `workflowDisciplineBlock(${mode}) 不得含禁轮询文本（worker 面零加噪）`);
}
for (const mode of modes) {
	const prompt = buildWorkflowTabPrompt({ taskId: "1007", prompt: "按计划实施" }, undefined, mode);
	assert.ok(!prompt.includes("busy-poll"), `buildWorkflowTabPrompt(${mode}) 不得含禁轮询文本（worker 面零加噪）`);
}
// 带 skill 路径的完整 prompt（含原始 handoff）同样不得出现
const skillPath = "C:/pi-packages/subagent-win/skills/workflow-orchestrator/SKILL.md";
assert.ok(!buildWorkflowTabPrompt({ taskId: "1007", prompt: "按计划实施" }, skillPath).includes("busy-poll"), "带 skill 路径的 workflow prompt 不得含禁轮询文本");

console.log("_test_no_poll: all assertions passed");
