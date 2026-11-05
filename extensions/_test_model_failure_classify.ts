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
	// 2026-10-18 新增（异步派发 3 连挂的真因）：pi 内核 fetch 层把连接故障包装成
	// `Connection error.`，它原本**两个正则都不匹配** ⇒ 落 other(retryable:false) ⇒
	// onFatalFailure ⇒ 子进程被立即 SIGTERM（turns=1 / input=0，请求未发出）。
	expectClass("Connection error.", "provider_network", true);
	expectClass("Connection reset by peer", "provider_network", true);
	expectClass("connection closed before message completed", "provider_network", true);
	ok("C1 连接类 ⇒ provider_network/retryable（terminated / 5xx-no-body / socket 族 / Connection error）");
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

// ── C4（R-22，2026-11-05 真机事故）：opendesign-go 的 503 不得被 billing 字样抢成 USAGE_CAP ──
//
// 原报告：
//   Error: 503: {"code":"database_unavailable","message":"[code=database_unavailable]
//   resolve Billing Scope: status 503: database_unavailable","type":"database_unavailable"}
//
// 旧行为：`billing` 在 usageWording 正则里 ⇒ 归类 usage_cap ⇒
//   ① 主 agent 被要求**换模型**（换模型救不了后端 DB 不可用，只是换个 endpoint 继续撞）
//   ② 重试退避被乘 usageCapMultiplier ⇒ 60s/120s，把一个「几秒自愈」的瞬时故障当成额度耗尽
{
	const real = 'Error: 503: {"code":"database_unavailable","message":"[code=database_unavailable] resolve Billing Scope: status 503: database_unavailable","type":"database_unavailable"}';
	expectClass(real, "provider_network", true);
	// 同形状变体（不同 code 拼写）
	expectClass("503 database_unavailable: resolve Billing Scope", "provider_network", true);
	// 护栏：明确额度词 + 5xx（供应商用 5xx 包额度纸条）**仍按额度**，不被 5xx 护栏抢走
	expectClass("503 service unavailable: quota exceeded", "usage_cap", true);
	expectClass("500 internal server error: insufficient credit", "usage_cap", true);
	// 护栏：未带 billing/scope 字样的 5xx **既有归类零变化**
	expectClass("504 gateway timeout", "timeout", true);
	expectClass("502 bad gateway", "provider_network", true);
	expectClass("503 status code (no body)", "provider_network", true);
	ok("C4 503 database_unavailable ⇒ provider_network（不是 USAGE_CAP）；其余 5xx 零回归");
}

// ── C5（R-22 判别力补强）：`billing` 单独出现**不得**算额度凭证 ──
//
// 为什么要单独一组：C4 的 503 有**两条**路径能救它（①`billing` 不在额度词表 ② 5xx+billing 护栏），
// 所以单独回退任何一条，C4 仍会绿 —— 那就测不出“每条护栏各自都在起作用”。
// 本组用**不带 5xx**的 billing 文本把①单独钉死（护栏管不到它，因为 http5xx=false）。
{
	// 不带 5xx 的 billing 文本：只能靠“billing 不算额度词”这条
	expectClass("failed to resolve Billing Scope for tenant", "other", false);
	expectClass("billing service unreachable", "other", false);
	// 反例：真额度词 + billing 同现 ⇒ 仍按额度
	expectClass("billing: quota exceeded", "usage_cap", true);
	expectClass("billing: insufficient credit", "usage_cap", true);
	ok("C5 `billing` 不单独作为额度凭证（真额度词同现时仍按额度）");
}

console.log(`\n_test_model_failure_classify: all ${n} groups passed`);
