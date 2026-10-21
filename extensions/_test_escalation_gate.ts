/**
 * _test_escalation_gate.ts — D-5 升级门分型回归门（2026-10-21，Item 54 要求 c）
 *
 * ## 为什么需要这道门
 * 研究文档 §7(c) 要求「僵尸死角不得直接判需人工强接，须先需再次尝试 + 预计等待窗口」。
 * 但 local 上**没有时间窗口**（证据见 plans/20261021_d5_escalation_gate_plan.md §1）⇒
 * 改成按**失败类型**决定「有没有自主路径」。
 *
 * 这道门钉的就是那个**最危险的错**：把「恒 skip、重试永远不会成功」的死角
 *（`no-liveness` / `identity-mismatch`）也编成「再试一次」⇒ 指导用户无限重试。
 *
 * 同时钉住第二个危险：`owner-active` **同名不同义**——僵尸主（pid 死）可重试，
 * 真活主占位必须明确说「不是故障，无需重试」。
 */

import assert from "node:assert/strict";
import {
	classifyEscalation,
	escalationGuidance,
	ensureStatusForReason,
	type EscalationClass,
} from "./runtime/local-master-launch.ts";
import { attachFailureGuidance } from "./master-tools.ts";

let n = 0;
const ok = (m: string): void => {
	n++;
	console.log(`ok ${n} - ${m}`);
};

// 文案里「祈使式劝重试」的措辞（hopeless 禁止出现）。
// 注意：否定式（「任何重试都不会成功」）是**正确**语义，不属禁止项 ——
// 所以只能禁**祈使句**，不能只查「重试」二字（首版就是这么写错的，被本测试自己抓到）。
const IMPERATIVE_RETRY = ["需再次尝试", "建议重跑", "建议再试", "再试一次", "请重试一次"];
const advisesRetry = (s: string): boolean => IMPERATIVE_RETRY.some((w) => s.includes(w));
// 允许性判据：retryable 必须真的在劝（含祈使式）
const hasAnyRetryMention = (s: string): boolean => s.includes("重试") || s.includes("再试");

// ── E1 分型：attach 命名空间 ─────────────────────────────────────
{
	assert.equal(classifyEscalation("lease-contended", "attach"), "retryable", "假竞争可退避重试");
	assert.equal(classifyEscalation("owner-pid-dead", "attach"), "retryable", "僵尸 owner 可重试穿透");
	assert.equal(classifyEscalation("transfer-in-progress", "attach"), "wait-only", "在途交接：只等不刷");
	assert.equal(classifyEscalation("no-liveness", "attach"), "hopeless", "attach 侧 no-liveness 恒 skip ⇒ 无自主路径");
	assert.equal(classifyEscalation("identity-mismatch", "attach"), "hopeless", "身份不匹配恒 skip ⇒ 无自主路径");
	// L4 v2 NIT（2026-10-21）：token 类 / not-stale **有自主路径**（拿对 token / 等心跳过期），
	// 归 hopeless 就是在说「任何重试都不会成功」= 作用域宽于证明（AGENTS §0）
	assert.equal(classifyEscalation("not-stale", "attach"), "retryable", "心跳未过 10min ⇒ 等一等再试");
	assert.equal(classifyEscalation("bad-token", "attach"), "retryable", "token 错 ⇒ 去拿正确 token 就是路径");
	assert.equal(classifyEscalation("token-expired", "attach"), "retryable", "token 过期 ⇒ 让人重发");
	assert.equal(classifyEscalation("generation-mismatch", "attach"), "retryable", "代不符 ⇒ 拿最新 token 重来");
	assert.equal(classifyEscalation("bad-session", "attach"), "hopeless", "sessionId 非法 ⇒ 重跑一万次也一样");
	assert.equal(classifyEscalation(undefined, "attach"), "insufficient-evidence", "无 reason 不猜");
	assert.equal(classifyEscalation("some-new-reason", "attach"), "insufficient-evidence", "未列举一律不猜");
	ok("E1 attach 命名空间分型（token 类不归 hopeless；未列举 ⇒ 不猜）");
}

// ── E2 分型：ensure 命名空间（同名不同义，这是最容易踩的坑）────────
{
	// `no-liveness` 在 ensure 命名空间里只是「spawn 出的会话还没写 liveness」
	// ⇒ **不得**判 hopeless（那会让用户被劝去强接一个其实只需要等一等的场景）
	assert.equal(
		classifyEscalation("no-liveness", "ensure"),
		"insufficient-evidence",
		"ensure 侧 no-liveness = 会话还没起来 ⇒ 不猜，不得判 hopeless",
	);
	assert.equal(classifyEscalation("claim-not-observed", "ensure"), "insufficient-evidence");
	assert.equal(classifyEscalation("consume-evidence-stale", "ensure"), "insufficient-evidence");
	assert.equal(classifyEscalation("lease-contended", "ensure"), "retryable", "可重试类跨命名空间一致");
	ok("E2 ensure 命名空间：no-liveness 不得被判 hopeless（同名不同义）");
}

// ── E3 文案硬约束：hopeless 不得**祈使式**劝重试 ──────────────
{
	const hopeless = escalationGuidance("hopeless");
	assert.ok(!advisesRetry(hopeless), `hopeless 文案不得祈使式劝重试（实际：${hopeless}）`);
	assert.ok(
		hopeless.includes("任何重试都不会成功"),
		"hopeless 应用否定式明确告知重试无用（而不是只靠不说）",
	);
	assert.ok(hopeless.includes("force-stale --confirm"), "hopeless 必须给人工强接这一条路");

	const retryable = escalationGuidance("retryable");
	assert.ok(advisesRetry(retryable), "retryable 文案应含祈使式「需再次尝试」");
	assert.ok(retryable.includes("再次失败"), "retryable 要说清「再失败才升级」");

	const waitOnly = escalationGuidance("wait-only");
	assert.ok(!advisesRetry(waitOnly), "wait-only 不得劝重试（在途交接重试无意义）");

	const unknown = escalationGuidance("insufficient-evidence");
	assert.ok(unknown.includes("不猜"), "insufficient-evidence 必须明示不猜");
	ok("E3 文案硬约束：hopeless/wait-only 不劝重试，retryable 有条件重试");
}

// ── E4 回归：既有 ensureStatusForReason 口径零改动（G2/H 断言依赖它）──
{
	assert.equal(ensureStatusForReason("no-liveness"), "stalled");
	assert.equal(ensureStatusForReason("no-owner"), "stalled");
	assert.equal(ensureStatusForReason("claim-not-observed"), "stalled");
	assert.equal(ensureStatusForReason("consume-evidence-stale"), "stalled");
	assert.equal(ensureStatusForReason("owner-pid-dead"), "timeout", "判得了（pid 死）⇒ timeout 带快照");
	ok("E4 既有 stalled/timeout 分类零改动（不破坏 G2/H 断言）");
}

// ── E5 变异**可区分性**（诚正命名：这是模拟，不是 §4.2 的真实变异）─────
// L4 NIT-2（2026-10-21）：原名“变异验证”名不副实——本组只是把 hopeless 的输出换成
// retryable 文案后比一比，**没有改被测实现、没有经由真实接线**。真实变异由人工执行
// （改 `classifyEscalation` 的 hopeless 分支 ⇒ E1 精确红 ⇒ 字节还原），
// 本组只负责证明「假如文案真的被改错，E3 的断言能区分出来」。
{
	const mutated = (cls: EscalationClass): string =>
		cls === "hopeless" ? escalationGuidance("retryable") : escalationGuidance(cls);
	assert.ok(
		advisesRetry(mutated("hopeless")),
		"变异体（hopeless→retryable 文案）确实含祈使式劝重试 ⇒ 反向断言 E3 有鉴别力",
	);
	// 而真实实现不含 ⇒ 两者可区分 ⇒ E3 的断言不是同义反复
	assert.ok(!advisesRetry(escalationGuidance("hopeless")), "真实实现与变异体可区分");
	assert.ok(hasAnyRetryMention(escalationGuidance("hopeless")), "hopeless 仍提到「重试」（否定式），证明不是靠避而不谈");
	ok("E5 文案可区分性（模拟，非真实变异）：hopeless 被改成 retryable 时 E3 会红");
}

// ── E6 真实接线：formatLocalMasterEnsureResult 走 ensure 命名空间 ──
{
	// 动态 import 以拿到构造器所需类型（纯函数级接线断言，不 spawn）
	const { formatLocalMasterEnsureResult } = await import("./runtime/local-master-launch.ts");
	const base = { scope: "subagent-win", agentAddress: null, status: "stalled" as const };
	const textNoLiveness = formatLocalMasterEnsureResult({ ...base, reason: "no-liveness" });
	assert.ok(textNoLiveness.includes("不猜"), "stalled(no-liveness) 保持「不猜」口径（G2 依赖）");
	assert.ok(
		!textNoLiveness.includes("需再次尝试"),
		"stalled(no-liveness) 不得混入 attach 侧的「需再次尝试」措辞（同名不同义的护栏）",
	);
	assert.ok(textNoLiveness.includes("force-stale --confirm"), "stalled 仍给人权处置指引（G2/H 依赖）");
	ok("E6 接线：stalled(no-liveness) 走 ensure 命名空间，不串到 attach 的 hopeless/retryable 文案");
}

// ── E7 真实入口接线：走 masterAttachLogic 的真实失败路径 ──────
//
// L4 NIT（2026-10-21）：E1–E6 都只测纯函数 / formatter，**没有经过真实工具入口**。
// AGENTS §4.2 要求断言必须经过真实入口，否则该测试不证明接线正确。
// 本组直调真实工具逻辑函数导出的 `attachFailureGuidance`（masterAttachLogic 失败分支的
// 唯一文案出口），对四种 verdict + global 路径逐个钉住。
{
	// 直接断言真实工具函数存在（防被改名/搬走而测试静默漏测）
	assert.equal(typeof attachFailureGuidance, "function", "attachFailureGuidance 必须导出（真实入口用）");

	// (a) owner-active + verdict=alive ⇒ 明说「正确拒绝，不是故障」，且不得劝重试
	const aliveMsg = attachFailureGuidance({ reason: "owner-active", local: true, verdict: "alive", verdictProbed: true });
	assert.ok(aliveMsg.includes("正确拒绕") === false && aliveMsg.includes("正确拒绝"), "活主 ⇒ 明说正确拒绝（不是故障）");
	assert.ok(!advisesRetry(aliveMsg), "活主 ⇒ 不得劝重试");

	// (b) owner-active + verdict=stale ⇒ retryable（建议再试）
	const staleMsg = attachFailureGuidance({ reason: "owner-active", local: true, verdict: "stale", verdictProbed: true });
	assert.ok(advisesRetry(staleMsg), "僵尸主 ⇒ 应建议再试（有自主路径）");

	// (c) owner-active + verdict=skip（no-liveness）⇒ hopeless（明写重试无用）
	const skipMsg = attachFailureGuidance({ reason: "owner-active", local: true, verdict: "skip", verdictProbed: true });
	assert.ok(!advisesRetry(skipMsg), "skip ⇒ 不得劝重试");
	assert.ok(skipMsg.includes("任何重试都不会成功"), "skip ⇒ 明写重试无用");

	// (d) owner-active + 未探到（读盘失败/attachment 缺失）⇒ **不猜**，不是 hopeless
	//     这是 L4 NIT-1 钉住的点：探不到 ≠ 已证明走不通（AGENTS §0）
	const unprobedMsg = attachFailureGuidance({ reason: "owner-active", local: true, verdictProbed: false });
	assert.ok(unprobedMsg.includes("不猜"), "未探到 ⇒ 不猜");
	assert.ok(
		!unprobedMsg.includes("任何重试都不会成功"),
		"未探到 ⇒ 不得声称重试一定无用（证据不足不得下定论）",
	);

	// (e) global 路径（local=false）**不走二判**：即使传了 verdict 也不该被 owner-active 分支吃掉
	const globalMsg = attachFailureGuidance({ reason: "owner-active", local: false, verdict: "stale", verdictProbed: true });
	assert.ok(!advisesRetry(globalMsg), "global owner-active 不走 local 二判（未列举 reason ⇒ 不猜）");
	assert.ok(globalMsg.includes("不猜"), "global ⇒ 保守不猜");

	ok("E7 真实入口：attachFailureGuidance 四型 + global 不走二判（含 NIT-1「探不到不猜」）");
}

console.log(`\n_test_escalation_gate: all assertions passed (${n} groups)`);

