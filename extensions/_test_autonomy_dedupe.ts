/**
 * _test_autonomy_dedupe.ts — 阶段 2：逐 trigger 去重（2026-11-01）
 *
 * ## 背景：为什么需要它
 *
 * 现有两个节流阀在 30s tick 下**全部失效**：
 *   debounceMs = 2s   → 锚点年龄 ≥ 30s ⇒ 永远已过
 *   cooldown   = 15s  → lastDecisionAt 是 30s 前 ⇒ 永远已过
 *
 * 这是「秒级参数 + 30 秒 tick」的尺度错配，直接导致 `decision.wake` 恒为 true
 * （真机实测 `lastWakeAt === lastDecisionAt`）。
 *
 * 本模块加一个**小时级**的逐 trigger 去重账本，让「同一件事」不被每 30 秒吵一次。
 *
 * ## 本测试要守住的
 *
 * A. 去重生效：同一 key 在窗内第二次 ⇒ all-deduped 不唤醒
 * B. 去重不误杀：新 key / 窗过期 ⇒ 必须放行
 * C. 只记新键：已去重的键不得刷新时间戳（否则永远出不了窗）
 * D. 不被逐帧变化的量污染：blocked_overdue 的 idleMin / runId 变化不算「新事件」
 * E. 账本有界：过期条目会被清理
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "autonomy-dedupe-env-"));
const RUNTIME = process.env.PI_RUNTIME_DIR!;

import { evaluateWakeGate, triggerDedupeKey } from "./runtime/autonomy/wake-gate.ts";
import type { FrontierDiff, FrontierTrigger } from "./runtime/autonomy/frontier.ts";

const CFG = { debounceMs: 2_000, ordinaryCooldownMs: 15_000 };
const GATING = { active: true, reason: "ok" };
const HOUR = 60 * 60_000;

function trg(rule: string, project: string, evidence: string, extra: Partial<FrontierTrigger> = {}): FrontierTrigger {
	return { rule: rule as FrontierTrigger["rule"], project, evidence, approximate: false, ...extra };
}

function diff(triggers: FrontierTrigger[], recordOnly: string[] = []): FrontierDiff {
	return { triggers, recordOnly, meaningfulChanges: triggers.filter((t) => !t.approximate).length };
}

const BASE_STATE = { lastDecisionAt: null, lastWakeAt: null, batchFirstSeenAt: null, lastReason: null };

let passed = 0;
const check = (name: string, fn: () => void): void => {
	try {
		fn();
		passed += 1;
		console.log(`  ✓ ${name}`);
	} catch (e) {
		console.error(`  ✗ ${name}`);
		console.error(`    ${e instanceof Error ? e.message : String(e)}`);
		throw e;
	}
};

try {
	// ══ A. 去重生效 ═══════════════════════════════════════════════
	console.log("\nA. 去重生效");

	check("A1 首次见到触发 ⇒ 唤醒 + 产出待记账键", () => {
		const d = evaluateWakeGate({
			gating: GATING,
			diff: diff([trg("working_to_completed", "g:/a", "run:1:working→completed")]),
			state: { ...BASE_STATE },
			cfg: CFG,
			now: 100_000,
		});
		assert.equal(d.wake, true, "首帧必须唤醒");
		assert.equal(d.reason, "ordinary");
		assert.deepEqual(d.dedupeKeysToRecord, ["working_to_completed:g:/a:run:1:working→completed"]);
	});

	check("A2 同一 key 在窗内 ⇒ all-deduped 不唤醒（**这是阶段 2 的核心**）", () => {
		const t = trg("working_to_completed", "g:/a", "run:1:working→completed");
		const key = triggerDedupeKey(t);
		const state = {
			...BASE_STATE,
			lastDecisionAt: 100_000, // 远超 cooldown(15s) ⇒ 旧节流阀抓不住它
			batchFirstSeenAt: 100_000, // 远超 debounce(2s) ⇒ 旧节流阀抓不住它
			dedupe: { [key]: new Date(100_000).toISOString() },
		};
		const d = evaluateWakeGate({ gating: GATING, diff: diff([t]), state, cfg: CFG, now: 130_000 }); // 30s 后 = 一个 tick
		assert.equal(d.wake, false, "**同一触发在 30s 后的下一 tick 不得再唤醒**（旧节流阀在这里全部失效）");
		assert.equal(d.reason, "all-deduped");
	});

	check("A3 连续 3 个 tick（间隔 30s）只有第一个唤醒", () => {
		const t = trg("needs_user", "g:/b", "needsUser:false→true");
		const key = triggerDedupeKey(t);
		let state: typeof BASE_STATE & { dedupe?: Record<string, string> } = { ...BASE_STATE };
		const wakes: boolean[] = [];
		for (let i = 0; i < 3; i++) {
			const now = 100_000 + i * 30_000;
			const d = evaluateWakeGate({ gating: GATING, diff: diff([t]), state: { ...state, lastDecisionAt: state.lastDecisionAt, batchFirstSeenAt: state.batchFirstSeenAt }, cfg: CFG, now });
			wakes.push(d.wake);
			if (d.wake && d.dedupeKeysToRecord) {
				const dd = { ...(state.dedupe ?? {}) };
				for (const k of d.dedupeKeysToRecord) dd[k] = new Date(now).toISOString();
				state = { ...state, dedupe: dd, lastDecisionAt: now, batchFirstSeenAt: now };
			} else {
				state = { ...state, lastDecisionAt: now };
			}
		}
		assert.deepEqual(wakes, [true, false, false], `3 tick 应当只唤醒首帧，实际 ${JSON.stringify(wakes)}`);
	});

	// ══ B. 去重不误杀 ═════════════════════════════════════════════
	console.log("\nB. 去重不误杀");

	check("B1 不同 key ⇒ 必须放行", () => {
		const t1 = trg("working_to_completed", "g:/a", "run:1");
		const t2 = trg("working_to_failed", "g:/b", "run:2");
		const state = { ...BASE_STATE, dedupe: { [triggerDedupeKey(t1)]: new Date(100_000).toISOString() } };
		const d = evaluateWakeGate({ gating: GATING, diff: diff([t2]), state, cfg: CFG, now: 130_000 });
		assert.equal(d.wake, true, "不同 trigger 不得被别的 key 挡住");
		assert.deepEqual(d.dedupeKeysToRecord, [triggerDedupeKey(t2)]);
	});

	check("B2 同一 key 但窗已过（> 1h）⇒ 必须重新放行", () => {
		const t = trg("stagnation", "g:/c", "stagnation:false→true");
		const key = triggerDedupeKey(t);
		const state = { ...BASE_STATE, dedupe: { [key]: new Date(100_000).toISOString() } };
		const d = evaluateWakeGate({ gating: GATING, diff: diff([t]), state, cfg: CFG, now: 100_000 + HOUR + 1 });
		assert.equal(d.wake, true, "窗外必须重新唤醒");
	});

	check("B3 一批里部分新、部分旧 ⇒ 放行且只记新键", () => {
		const oldT = trg("working_to_completed", "g:/a", "run:1");
		const newT = trg("needs_user", "g:/b", "x");
		const state = { ...BASE_STATE, dedupe: { [triggerDedupeKey(oldT)]: new Date(100_000).toISOString() } };
		const d = evaluateWakeGate({ gating: GATING, diff: diff([oldT, newT]), state, cfg: CFG, now: 130_000 });
		assert.equal(d.wake, true, "有新的就应唤醒");
		assert.deepEqual(d.dedupeKeysToRecord, [triggerDedupeKey(newT)], "**只记新键**，已去重的不刷新时间戳");
	});

	// ══ C. 不被逐帧变化的量污染 ═══════════════════════════════════
	console.log("\nC. 键的稳定性（关键：防 tick 级抖动）");

	check("C1 blocked_overdue：idleMin 逐帧变化时键必须不变", () => {
		const a = trg("blocked_overdue", "g:/x", "blocked_overdue:run=tab_1:idleMin=211", { runId: "tab_1" });
		const b = trg("blocked_overdue", "g:/x", "blocked_overdue:run=tab_1:idleMin=215", { runId: "tab_1" });
		assert.equal(triggerDedupeKey(a), triggerDedupeKey(b), "runId 存在时 evidence 不入键，idleMin 变化不得改变 key");
	});

	check("C2 ws_mail_backlog：pending 数变化**应当**改变 key（积压变多是新情况）", () => {
		const a = trg("ws_mail_backlog", "mailbox:m", "pending:1");
		const b = trg("ws_mail_backlog", "mailbox:m", "pending:5");
		assert.notEqual(triggerDedupeKey(a), triggerDedupeKey(b), "无 runId 时 evidence 入键，积压变化应算新事件");
	});

	check("C3 approximate 翻转不得改变 key", () => {
		const a = { ...trg("needs_user", "g:/y", "x"), approximate: false };
		const b = { ...trg("needs_user", "g:/y", "x"), approximate: true };
		assert.equal(triggerDedupeKey(a), triggerDedupeKey(b), "approximate 不入键");
	});

	check("C4 同一 key 的 approximate 变化不会绕过去重", () => {
		const real = { ...trg("needs_user", "g:/z", "x"), approximate: false };
		const key = triggerDedupeKey(real);
		const state = { ...BASE_STATE, dedupe: { [key]: new Date(100_000).toISOString() } };
		// 只有 approximate 变化（同 rule/project/evidence）⇒ 不应唤醒
		const approxOnly = { ...trg("needs_user", "g:/z", "x"), approximate: true };
		const d = evaluateWakeGate({ gating: GATING, diff: diff([approxOnly]), state, cfg: CFG, now: 130_000 });
		// approximate 的触发在 real 过滤时已被剔除 ⇒ 走到 approx-only 分支
		assert.equal(d.wake, false);
		assert.equal(d.reason, "approx-only");
	});

	// ══ D. 旧节流阀在 30s tick 下确实失效（记录现状，防回归误判）═══
	console.log("\nD. 旧节流阀的失效是事实（本模块存在的理由）");

	check("D1 debounce(2s) 在 30s tick 下不命中", () => {
		const t = trg("working_to_completed", "g:/d", "e");
		const d = evaluateWakeGate({
			gating: GATING,
			diff: diff([t]),
			state: { ...BASE_STATE, batchFirstSeenAt: 100_000 }, // 锚点 30s 前
			cfg: CFG,
			now: 130_000,
		});
		assert.equal(d.wake, true, "debounce 2s 对 30s 前的锚点无效（这是失效证据，不是 bug）");
		assert.notEqual(d.reason, "debounce");
	});

	check("D2 cooldown(15s) 在 30s tick 下不命中", () => {
		const t = trg("working_to_completed", "g:/e", "e");
		const d = evaluateWakeGate({
			gating: GATING,
			diff: diff([t]),
			state: { ...BASE_STATE, lastDecisionAt: 100_000 },
			cfg: CFG,
			now: 130_000,
		});
		assert.equal(d.wake, true, "cooldown 15s 对 30s 前的决策无效");
		assert.notEqual(d.reason, "cooldown");
	});

	check("D3 但它们在小 tick 下仍然有效（没被改坏）", () => {
		const t = trg("working_to_completed", "g:/f", "e");
		const dbc = evaluateWakeGate({ gating: GATING, diff: diff([t]), state: { ...BASE_STATE, batchFirstSeenAt: 100_000 }, cfg: CFG, now: 101_000 });
		assert.equal(dbc.reason, "debounce", "1s 内应在 debounce 窗");
		const cd = evaluateWakeGate({ gating: GATING, diff: diff([t]), state: { ...BASE_STATE, lastDecisionAt: 100_000 }, cfg: CFG, now: 105_000 });
		assert.equal(cd.reason, "cooldown", "5s 内应在 cooldown 窗");
	});

	// ══ E. 无触发时不受影响 ═══════════════════════════════════════
	console.log("\nE. 边界不回归");

	check("E1 无触发 ⇒ 仍是 no-meaningful-change（不是 all-deduped）", () => {
		const d = evaluateWakeGate({ gating: GATING, diff: diff([]), state: { ...BASE_STATE }, cfg: CFG, now: 1000 });
		assert.equal(d.reason, "no-meaningful-change");
	});

	check("E2 只有 recordOnly ⇒ record-only", () => {
		const d = evaluateWakeGate({ gating: GATING, diff: diff([], ["needs_global:record-only(no-carrier)"]), state: { ...BASE_STATE }, cfg: CFG, now: 1000 });
		assert.equal(d.reason, "record-only");
	});

	check("E3 gating 不 active ⇒ 不被去重逻辑绕过", () => {
		const t = trg("working_to_completed", "g:/g", "e");
		const d = evaluateWakeGate({
			gating: { active: false, reason: "kill-switch:test" },
			diff: diff([t]),
			state: { ...BASE_STATE },
			cfg: CFG,
			now: 1000,
		});
		assert.equal(d.wake, false);
		assert.equal(d.reason, "kill-switch:test", "总门优先级最高，去重不得绕过它");
	});

	console.log(`\n_test_autonomy_dedupe: ${passed} checks passed`);
} finally {
	rmSync(RUNTIME, { recursive: true, force: true });
}
