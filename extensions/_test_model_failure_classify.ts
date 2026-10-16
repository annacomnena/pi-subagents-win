/**
 * _test_model_failure_classify.ts — 失败分类回归（连接类缺口修复）
 *
 * 背景（2026-10-16 高优先排查）：今日 3 条长跑以 `error==="terminated"`（undici socket 提前关闭）
 * 与 `503 status code (no body)` 收场，`status=failed`、**零重试、零产出**。
 * 根因：这两类文本在 `classifyModelFailure` 里**没命中任何规则** ⇒ 落到 `other`（`retryable:false`）
 * ⇒ 触发 `index.ts:959` 的 fatal 门（`!retryable ⇒ opts.onFatalFailure(kind)`）⇒ **立即杀子进程**。
 *
 * 本测试锁死分类契约（含**反例自检**：若有人把「明确终态」也改成 retryable，后半段必红）。
 */

import assert from "node:assert/strict";
import { classifyModelFailure } from "./index.ts";

let n = 0;
const ok = (name: string): void => { n += 1; console.log(`ok ${n} - ${name}`); };

/** 断言辅助：一条 error 文本 ⇒ 期望 kind/label/retryable。 */
function expectClass(error: string, kind: string, retryable: boolean, modelHint?: string): void {
	const cls = classifyModelFailure(error, modelHint);
	assert.equal(cls.kind, kind, `kind 不符：err=${JSON.stringify(error)} ⇒ ${JSON.stringify(cls)}`);
	assert.equal(cls.retryable, retryable, `retryable 不符：err=${JSON.stringify(error)} ⇒ ${JSON.stringify(cls)}`);
}

// ── C1：连接类（本次修复的核心）⇒ provider_network + retryable ──
{
	expectClass("terminated", "provider_network", true);
	expectClass("Error: terminated", "provider_network", true);
	expectClass("agent execution terminated", "provider_network", true);
	expectClass("503 status code (no body)", "provider_network", true);
	expectClass("502 bad gateway", "provider_network", true);
	expectClass("504 gateway timeout", "timeout", true); // 排在 timeout 规则之后 ⇒ 归 timeout（同属 retryable，行为等价）
	expectClass("socket hang up", "provider_network", true);
	expectClass("other side closed", "provider_network", true);
	expectClass("premature close", "provider_network", true);
	expectClass("ECONNRESET", "provider_network", true);
	expectClass("EAI_AGAIN", "provider_network", true);
	expectClass("fetch failed", "provider", true);
	ok("C1 连接类 ⇒ provider_network/retryable（terminated / 5xx-no-body / socket 族）");
}

// ── C2：既有语义不被这次修复改动（回退保护）──
{
	expectClass("wall-budget-exceeded", "wall_budget", false);
	expectClass("stall-timeout", "stall", false);
	expectClass("no output for 600s", "stall", false);
	expectClass("request timed out", "timeout", true);
	expectClass("429 too many requests", "usage_cap", true);
	expectClass("402 insufficient credit", "usage_cap", true);
	expectClass("401 unauthorized", "auth", true);
	ok("C2 既有分类零回归（wall_budget/stall/timeout/429/auth）");
}

// ── C3：反例自检 —— 「明确不可重试」必须仍为不可重试 ──
// 若有人把 connectionish 放宽到 catch-all（例如把 `other` 也改成 retryable），本段必红。
{
	expectClass("something totally unexpected xyz", "other", false);
	expectClass("invalid response shape from tool", "other", false);
	ok("C3 反例自检：未知文本仍为 other/非 retryable（防止「全都可重试」式回归）");
}

console.log(`\n_test_model_failure_classify: all ${n} groups passed`);
