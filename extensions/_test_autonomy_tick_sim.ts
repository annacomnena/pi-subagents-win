/**
 * _test_autonomy_tick_sim.ts — 生产 tick 链路模拟（2026-11-01 阶段 1+2 联合验证）
 *
 * ## 与其它测试的区别
 *
 * 其它测试直接喂内存 state；本测试走**完整生产链路**：
 *   evaluateAutonomyWakeGate()
 *     → collectAutonomyInputs()（读真实 tab-runs/mailbox/kill/config）
 *     → buildFrontier()
 *     → maintainBatchAnchor()（阶段 1）
 *     → evaluateWakeGate()（阶段 2）
 *     → writeWakeGateState()（落盘）
 *   下一轮 readWakeGateState()（从磁盘重读，与生产一致）
 *
 * 只有 `now` 是注入的（否则要真等 30 秒 × N 轮）。这验证的是
 * 「改了代码 + 落盘 + 重读」这一整条链，而不只是纯函数。
 *
 * ## 两个阶段联合生效的判据（核心）
 *
 * ```
 * tick 1: debounce      锚点首置
 * tick 2: ordinary  ✅  第一批唤醒
 * tick 3: all-deduped   去重拦截（阶段 2）
 * tick 4: all-deduped   去重拦截
 *    ↓ 注入新信（pending 1→2，evidence 变）
 * tick 5: debounce      指纹变 ⇒ 锚点重置（阶段 1）
 * tick 6: ordinary  ✅  第二批唤醒
 * ```
 *
 * 这一串**同时证明**：
 * - 阶段 1：同一批持续时锚点保持不变，内容真变时锚点重置
 * - 阶段 2：同一批不重复唤醒，新内容能突破去重
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUNTIME = mkdtempSync(join(tmpdir(), "autonomy-tick-sim-"));
process.env.PI_RUNTIME_DIR = RUNTIME;
const STATE = join(RUNTIME, "state");
const MAILBOX = join(RUNTIME, "mailbox");

import { evaluateAutonomyWakeGate } from "./runtime/autonomy/gate.ts";
import { readWakeGateState, writeWakeGateState } from "./runtime/autonomy/collect.ts";
import { createWorkstream } from "./runtime/workstreams.ts";
import { deliverLetter } from "./runtime/mailbox.ts";
import { newMessageFrame } from "./runtime/protocol.ts";
import { newEnvelopeId } from "./runtime/ids.ts";
import { workstreamAddress } from "./runtime/address.ts";

const TICK = 30_000;

/** 跑 N 轮真实 tick，可注入「第 k 轮之后改变盘面」的钩子。 */
function simulate(opts: { ticks: number; after?: Record<number, () => void>; base?: number }): Array<{
	tick: number;
	wake: boolean;
	reason: string;
	anchor: number | null;
	dedupeEntries: number;
}> {
	const base = opts.base ?? Date.now();
	const rows = [];
	for (let i = 0; i < opts.ticks; i++) {
		// 本轮开始前先施加盘面变化（模拟「这 30 秒里发生了新事」）
		opts.after?.[i]?.();
		const now = base + i * TICK;
		const d = evaluateAutonomyWakeGate({
			stateDir: STATE,
			agentDir: RUNTIME,
			mailboxDir: MAILBOX,
			now,
		});
		const wg = readWakeGateState({ stateDir: STATE });
		rows.push({
			tick: i + 1,
			wake: d.proceed,
			reason: d.reason,
			anchor: wg?.batchFirstSeenAt ?? null,
			dedupeEntries: Object.keys(wg?.dedupe ?? {}).length,
		});
	}
	return rows;
}

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
	// ── 种子：一个 workstream + 一封 pending 信（ws_mail_backlog 触发源）──
	const ws = createWorkstream({ stateDir: STATE, session: "sim", mission: "tick 模拟" });
	const wsAddr = workstreamAddress(ws.id);
	const sendLetter = (n: number): void => {
		deliverLetter(
			newMessageFrame({
				id: newEnvelopeId("msg"),
				kind: "DELEGATION",
				from: "agent://sim",
				to: wsAddr,
				subject: `sim-task-${n}`,
				sentAt: new Date(0).toISOString(),
				summary: `第 ${n} 封`,
			}),
			{ mailboxDir: MAILBOX },
		);
	};
	sendLetter(1);

	console.log("\nA. 同一批持续 6 轮（阶段 2 去重生效）");
	const A = simulate({ ticks: 6 });

	check("A1 只唤醒 1 次（其余被去重拦截）", () => {
		const woke = A.filter((r) => r.wake);
		assert.equal(woke.length, 1, `6 轮应只唤醒 1 次，实际 ${woke.length} 次：${JSON.stringify(A.map((r) => r.reason))}`);
	});

	check("A2 唤醒之后全是 all-deduped（不是 no-meaningful-change）", () => {
		const afterFirstWake = A.slice(A.findIndex((r) => r.wake) + 1);
		assert.ok(afterFirstWake.length >= 3, "首唤醒之后应还有多轮");
		for (const r of afterFirstWake) {
			assert.equal(r.reason, "all-deduped", `tick ${r.tick} 应为 all-deduped，实际 ${r.reason}`);
		}
	});

	check("A3 阶段 1：同一批持续时锚点绝对值不变", () => {
		const anchors = new Set(A.map((r) => r.anchor));
		assert.equal(anchors.size, 1, `锚点应恒定，实际 ${[...anchors].join(" / ")}`);
		assert.ok([...anchors][0] !== null, "锚点不应为 null");
	});

	check("A4 去重账本只增不减且为 1 条（同一批只有一个 key）", () => {
		const last = A[A.length - 1]!;
		assert.equal(last.dedupeEntries, 1, `同一批应只有 1 个去重键，实际 ${last.dedupeEntries}`);
	});

	console.log("\nB. 中途改变盘面（阶段 1 指纹重置 + 阶段 2 允许新内容突破）");
	rmSync(STATE, { recursive: true, force: true });
	rmSync(MAILBOX, { recursive: true, force: true });
	const ws2 = createWorkstream({ stateDir: STATE, session: "sim2", mission: "tick 模拟2" });
	const wsAddr2 = workstreamAddress(ws2.id);
	const send2 = (n: number): void => {
		deliverLetter(
			newMessageFrame({
				id: newEnvelopeId("msg"),
				kind: "DELEGATION",
				from: "agent://sim",
				to: wsAddr2,
				subject: `sim2-task-${n}`,
				sentAt: new Date(0).toISOString(),
				summary: `第 ${n} 封`,
			}),
			{ mailboxDir: MAILBOX },
		);
	};
	send2(1);

	// 在第 4 轮（index 3）之前送第二封 ⇒ pending 1→2 ⇒ evidence 变 ⇒ 指纹变
	const B = simulate({ ticks: 6, after: { 3: () => send2(2) } });

	check("B1 总共唤醒 2 次（第一批 + 第二批）", () => {
		const woke = B.filter((r) => r.wake);
		assert.equal(woke.length, 2, `应唤醒 2 次，实际 ${woke.length}：${JSON.stringify(B.map((r) => r.reason))}`);
	});

	check("B2 阶段 1：盘面变化后锚点发生重置（出现第二个不同值）", () => {
		const anchors = [...new Set(B.map((r) => r.anchor))];
		assert.equal(anchors.length, 2, `锚点应有两个不同值（重置过一次），实际 ${anchors.join(" / ")}`);
		// 新锚点必须比旧的大（时间上更晚）
		assert.ok((anchors[1] as number) > (anchors[0] as number), "新锚点应晚于旧锚点");
	});

	check("B3 阶段 2：第二次唤醒发生在盘面变化之后（不是被旧去重挡住）", () => {
		const firstWakeIdx = B.findIndex((r) => r.wake);
		const secondWakeIdx = B.findIndex((r, i) => i > firstWakeIdx && r.wake);
		assert.ok(secondWakeIdx > 3, `第二次唤醒应在 tick 4 之后（盘面变化点），实际 tick ${secondWakeIdx + 1}`);
	});

	check("B4 去重账本增至 2 条（两个不同 key）", () => {
		const last = B[B.length - 1]!;
		assert.ok(last.dedupeEntries >= 2, `应有 ≥2 个去重键，实际 ${last.dedupeEntries}`);
	});

	console.log("\nC. 真相核查：旧实现会怎样（对照）");
	check("C1 若无去重，6 轮会唤醒 6 次（这正是阶段 2 修掉的问题）", () => {
		// 用空账本强行跑（模拟旧行为：每轮都不查去重）
		rmSync(STATE, { recursive: true, force: true });
		rmSync(MAILBOX, { recursive: true, force: true });
		const ws3 = createWorkstream({ stateDir: STATE, session: "sim3", mission: "对照" });
		deliverLetter(
			newMessageFrame({
				id: newEnvelopeId("msg"),
				kind: "DELEGATION",
				from: "agent://sim",
				to: workstreamAddress(ws3.id),
				subject: "c1",
				sentAt: new Date(0).toISOString(),
				summary: "x",
			}),
			{ mailboxDir: MAILBOX },
		);
		// 每轮都把 dedupe 清空 ⇒ 模拟「去重不存在」
		const base = Date.now();
		let wakeCount = 0;
		for (let i = 0; i < 6; i++) {
			// 手动清账本
			const wg = readWakeGateState({ stateDir: STATE });
			if (wg) writeWakeGateState({ ...wg, dedupe: {} }, { stateDir: STATE });
			const d = evaluateAutonomyWakeGate({ stateDir: STATE, agentDir: RUNTIME, mailboxDir: MAILBOX, now: base + i * TICK });
			if (d.proceed) wakeCount += 1;
		}
		// 无去重时几乎每轮都唤醒。为什么不是恰好 6：
		// 首轮锚点刚置 ⇒ 落在 debounce(2s) 窗内 ⇒ 那次是 debounce 而非 ordinary。
		// 这是**旧节流阀在小 tick 下唯一还会命中的一次**，与去重无关。
		// 关键是：≥5 说明「没有去重就会反复唤醒」，与 A1 的「只唤醒 1 次」形成对照。
		assert.ok(wakeCount >= 5, `无去重时应几乎每轮唤醒（实测 ${wakeCount}/6）—— 与 A1 的 1 次形成对照`);
		assert.equal(wakeCount > 1, true, "去重存在时 1 次 vs 不存在时多次 —— 这就是阶段 2 的效果");
	});

	console.log(`\n_test_autonomy_tick_sim: ${passed} checks passed`);
} finally {
	rmSync(RUNTIME, { recursive: true, force: true });
}
