/**
 * _test_runs_view.ts — 「运行」section 的纯函数测试（`deriveRunDisplay` / `runningCount` / `formatUsage`）。
 *
 * 这里钉的核心是一条**反向断言**：`status === "running"` **不**等于「运行中」。
 * 真实分母（154 份 run json 实测，2026-10-22）：带 pid 仅 2 份 ⇒ `liveness === "unknown"`
 * 占 152/154（98.7%）。若把 unknown 当 running 展示，UI 会常态谎报「运行中」。
 *
 * 覆盖：
 *   R1 三态各命中：running+alive → alive；running+dead → interrupted；running+unknown → unknown
 *      （每个断言 label / tone / countsAsRunning 三字段，不只 state）
 *   R2 **反向断言**：running+unknown ⇒ countsAsRunning === false 且 label !== "运行中"
 *   R3 终态三值 → completed / failed / cancelled，均 countsAsRunning=false（终态 liveness 不参与判活）
 *   R4 runningCount：只数 countsAsRunning；两条 status=running 但只有一条真活 ⇒ 1
 *   R5 formatUsage：null → "—"；有值 → in/out + cost；缺失 cost 不出 $
 *   R6 livenessTally 分母 = 传入条数；loopBadge 只对 repeating/no_progress 出徽标
 *
 * 运行：npm run test:gui-runs-view
 */

import assert from "node:assert/strict";
import { register } from "node:module";

// gui/src 按 vite/bundler 惯例 extensionless 相对导入 → 复用 store 测试 resolve hook 补 .ts
register("../../extensions/_gui_store_ts_loader.mjs", import.meta.url);

const { deriveRunDisplay, formatUsage, livenessTally, loopBadge, runningCount } = await import("./runsView.ts");
import type { RunCard, RunUsage } from "./api/types.ts";

let n = 0;
const ok = (name: string): void => {
	n += 1;
	console.log(`ok ${n} - ${name}`);
};

const card = (over: Partial<RunCard>): RunCard => ({
	id: over.id ?? "run_x",
	agent: over.agent ?? "general",
	taskPreview: over.taskPreview ?? "只做一件事：调用 bash 工具执行 `sleep 150`",
	status: over.status ?? "running",
	liveness: over.liveness ?? "unknown",
	pid: over.pid ?? null,
	startedAt: over.startedAt ?? "2026-10-22T06:00:00.000Z",
	lastActivity: over.lastActivity ?? "2026-10-22T06:01:00.000Z",
	usage: over.usage ?? null,
	...(over.recentCalls !== undefined ? { recentCalls: over.recentCalls } : {}),
	...(over.loopVerdict !== undefined ? { loopVerdict: over.loopVerdict } : {}),
});

// ── R1 三态各命中 ──────────────────────────────────────────────────
{
	const alive = deriveRunDisplay(card({ status: "running", liveness: "alive" }));
	assert.equal(alive.state, "alive");
	assert.equal(alive.label, "运行中");
	assert.equal(alive.tone, "ok");
	assert.equal(alive.countsAsRunning, true);
	ok("R1a running + alive → alive /「运行中」/ tone=ok / countsAsRunning=true");

	const dead = deriveRunDisplay(card({ status: "running", liveness: "dead" }));
	assert.equal(dead.state, "interrupted");
	assert.equal(dead.label, "进程已退出");
	assert.equal(dead.tone, "warn");
	assert.equal(dead.countsAsRunning, false);
	ok("R1b running + dead → interrupted /「进程已退出」/ 不计运行中");

	const unknown = deriveRunDisplay(card({ status: "running", liveness: "unknown" }));
	assert.equal(unknown.state, "unknown");
	assert.equal(unknown.label, "状态未知");
	assert.equal(unknown.tone, "na");
	assert.equal(unknown.countsAsRunning, false);
	ok("R1c running + unknown → unknown /「状态未知」/ 不计运行中");
}

// ── R2 反向断言（本题的判定核心）────────────────────────────────────
{
	const u = deriveRunDisplay(card({ status: "running", liveness: "unknown" }));
	assert.equal(u.countsAsRunning, false, "running+unknown 不得算运行中（分母 152/154 是 unknown）");
	assert.notEqual(u.label, "运行中", "running+unknown 的文案不得是「运行中」");
	assert.notEqual(u.state, "alive", "running+unknown 不得落到 alive 态");
	ok("R2 反向断言：status=running + liveness=unknown ⇒ 不算运行中、文案不是「运行中」");
}

// ── R3 终态（liveness 不参与判活）──────────────────────────────────
{
	const c = deriveRunDisplay(card({ status: "completed", liveness: "unknown" }));
	assert.equal(c.state, "completed");
	assert.equal(c.label, "已完成");
	assert.equal(c.countsAsRunning, false);

	const f = deriveRunDisplay(card({ status: "failed", liveness: "dead" }));
	assert.equal(f.state, "failed");
	assert.equal(f.label, "失败");
	assert.equal(f.tone, "danger");
	assert.equal(f.countsAsRunning, false);

	const k = deriveRunDisplay(card({ status: "cancelled", liveness: "unknown" }));
	assert.equal(k.state, "cancelled");
	assert.equal(k.label, "已取消");
	assert.equal(k.countsAsRunning, false);
	ok("R3 终态三值 → completed/failed/cancelled，均不计运行中（终态 dead 不是「中断」）");

	// 终态里出现不认识的 status 时给中性兜底，不抛、不误判运行中
	const weird = deriveRunDisplay(card({ status: "orphaned" as RunCard["status"], liveness: "unknown" }));
	assert.equal(weird.countsAsRunning, false);
	assert.equal(weird.tone, "na");
	ok("R3b 未知 status 兜底为中性且不计运行中（不抛）");
}

// ── R4 runningCount ────────────────────────────────────────────────
{
	const fixture: RunCard[] = [
		card({ id: "a", status: "running", liveness: "alive" }), // 唯一真跑
		card({ id: "b", status: "running", liveness: "unknown" }), // 记录说 running 但不知道
		card({ id: "c", status: "running", liveness: "dead" }), // 记录说 running 但进程没了
		card({ id: "d", status: "completed", liveness: "unknown" }),
		card({ id: "e", status: "failed", liveness: "dead" }),
	];
	assert.equal(fixture.filter((r) => r.status === "running").length, 3, "夹具里有 3 条 status=running");
	assert.equal(runningCount(fixture), 1, "runningCount 只数 countsAsRunning（=1，不是 3）");
	assert.equal(runningCount([]), 0);
	ok("R4 runningCount：3 条 status=running 但只有 1 条真活 ⇒ 1（不是 3）");
}

// ── R5 formatUsage ─────────────────────────────────────────────────
{
	assert.equal(formatUsage(null), "—", "运行中无 usage ⇒「—」");
	const u: RunUsage = { input: 105600, output: 22053, cacheRead: 774656, cacheWrite: 0, cost: 0.3425, turns: 26 };
	const s = formatUsage(u);
	assert.ok(s.includes("106k in"), `含紧凑输入量（实际 ${s}）`);
	assert.ok(s.includes("22.1k out"), `含紧凑输出量（实际 ${s}）`);
	assert.ok(s.includes("$0.343"), `cost 三位小数（实际 ${s}）`);
	assert.ok(!s.includes("undefined") && !s.includes("null"));
	assert.equal(formatUsage({ input: 205, output: 99, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 2 }), "205 in / 99 out · $0.000");
	ok("R5 formatUsage：null→「—」；有值→紧凑 in/out + 三位小数 cost");
}

// ── R6 统计小件 ────────────────────────────────────────────────────
{
	const t = livenessTally([card({ liveness: "alive" }), card({ liveness: "unknown" }), card({ liveness: "unknown" })]);
	assert.deepEqual(t, { alive: 1, dead: 0, unknown: 2 });
	assert.deepEqual(livenessTally([]), { alive: 0, dead: 0, unknown: 0 });
	ok("R6a livenessTally 分母 = 传入条数（alive/dead/unknown 三键恒在）");

	assert.equal(loopBadge("ok"), null, "ok 不喧哗");
	assert.equal(loopBadge("unknown"), null, "终态 unknown 不出徽标");
	assert.equal(loopBadge("repeating")?.tone, "warn");
	assert.equal(loopBadge("no_progress")?.label, "无进展");
	ok("R6b loopBadge：仅 repeating/no_progress 出徽标（ok/unknown 静默）");
}

console.log(`_test_runs_view: all assertions passed (${n} groups)`);
