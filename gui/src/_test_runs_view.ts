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
 *   R7 partitionRuns：页面分组口径（只有 running+alive 进 running 组；M6 变异暴露的页面层零判别力缺口）
 *
 * 运行：npm run test:gui-runs-view
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";

// gui/src 按 vite/bundler 惯例 extensionless 相对导入 → 复用 store 测试 resolve hook 补 .ts
register("../../extensions/_gui_store_ts_loader.mjs", import.meta.url);

const { deriveRunDisplay, formatUsage, livenessTally, loopBadge, partitionRuns, runningCount } = await import("./runsView.ts");
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

// ── R7 partitionRuns：页面分组口径（M6 变异暴露的零判别力缺口）────────────
{
	const fixture: RunCard[] = [
		card({ id: "a", status: "running", liveness: "alive" }), // 唯一真跑
		card({ id: "b", status: "running", liveness: "unknown" }), // 记录 running 但不知道 ⇒ 不得进 running
		card({ id: "c", status: "running", liveness: "dead" }),
		card({ id: "d", status: "completed", liveness: "unknown" }),
		card({ id: "e", status: "failed", liveness: "dead" }),
	];
	const { running, others } = partitionRuns(fixture);
	assert.deepEqual(running.map((r) => r.id), ["a"], "running 组只含 running+alive");
	assert.deepEqual(others.map((r) => r.id), ["b", "c", "d", "e"], "unknown/dead/终态全部进 others（顺序保持）");
	assert.equal(running.length + others.length, fixture.length, "分组不丢记录（分母守恒）");
	assert.equal(running.length, runningCount(fixture), "partitionRuns 与 runningCount 同口径（两者不得漂移）");
	assert.deepEqual(partitionRuns([]), { running: [], others: [] }, "空输入 → 两组皆空");
	ok("R7 partitionRuns：只有 running+alive 进 running 组（unknown/dead/终态进 others，分母守恒）");
}

// ── R8 RunsPage 源码级接线断言（页面层零判别力缺口：M6 变异只改页面接线时测试必须红）──
//
// 为什么读源码而不渲染：仓库无 DOM 测试基建（全 14 个 gui 测试都是纯函数/源码断言），
// `_test_write_card.ts` 就是 readFileSync 读源码的范式。
// 判据必须打在**接线**上（AGENTS §4.2）：断言页面确实从 `runsView` 拿分组、且**没有**自己内联筛选。
//
// 先做注释剥离：页内第 118 行注释本身就含「filter」字样，对原文断言会误判。
// 剥离策略保守（不是完整 JS 词法分析，而是「只抹掉确定是注释的形态」），宁可漏剥不可错剥：
//   1) 块注释 `/* … */`（非贪婪，跨行）
//   2) 行首空白 + `//` 到行尾（页面里所有行注释都是这个形态；可避开 `"a // b"` 类字符串）
// 副作用：若将来字符串字面量里出现 `http://…` 这类，也不会被剥（因为不是行首）。
const stripComments = (src: string): string =>
	src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

{
	const raw = readFileSync(new URL("./pages/RunsPage.tsx", import.meta.url), "utf8");
	const src = stripComments(raw);

	// 夹具必须贴近剥离器真实语义（AGENTS §5）：块注释与**行首** `//` 被剔，**行内** `//` 故意保留
	//（保守：不剔行内 `//` 才不会吃掉字符串里的 `http://…`；页面所有行注释都是行首形态）。
	assert.equal(stripComments("/* 块 .filter( */ const a = 1;"), " const a = 1;", "块注释必须剥（含跨行）");
	assert.equal(stripComments("\t// 行首注释 .filter(\nconst b = 2;"), "\nconst b = 2;", "行首 // 行注释必须剥");
	assert.equal(
		stripComments('const u = "http://x"; // 行内保留'),
		'const u = "http://x"; // 行内保留',
		"行内 // 不剥（保守：宁可漏剥也不错剥字符串）",
	);
	// 前提（真读数）：页面确实含注释里的 filter 字样 —— 否则 3b 的注释剥离是空跑
	assert.ok(raw.includes("filter"), "前提：RunsPage（含注释）确实出现 filter 字样，否则 R8b 空跑");
	assert.ok(
		!src.includes("注释剥离生效"),
		"前提：源码中不应保留已被剥离的块注释/行首注释内容",
	);

	// 三条接线判据**全部先算出来再报**：交集缺陷不能只报第一条命中项（否则变异会命中错断言，
	// 违背 AGENTS §4.3「变异的判据是命中预期断言」），也无法从一次红看出到底改了什么接线）。
	const violations: string[] = [];
	// 3a 正向接线：页面必须调用 partitionRuns(runs) 得到分组
	if (!/partitionRuns\s*\(\s*runs\s*\)/.test(src)) {
		violations.push("R8a 页面未调用 partitionRuns(runs) 取分组（分组口径唯一实现应在 runsView.ts）");
	}
	// 3b 反向接线（抓变异主断言）：页面不得自己内联 .filter( 筛运行中
	if (src.includes(".filter(")) {
		violations.push(
			"R8b RunsPage 出现内联 .filter( —— 分组口径的唯一实现在 runsView.ts::partitionRuns；内联筛选会让 R7 全部失去判别力",
		);
	}
	// 3c 导入接线：import 列表（多符号，不写死顺序）必须同时含 partitionRuns 与 "../runsView"
	if (!/import[^;]*partitionRuns[^;]*from\s*"\.\.\/runsView"/s.test(src)) {
		violations.push('R8c 未从 "../runsView" 导入 partitionRuns（接线层：不得页面本地另写一份）');
	}
	// 3d 不得绕过分组直接渲染全量：只允许 running.map / others.map
	if (/\bruns\.map\s*\(/.test(src)) {
		violations.push("R8d 出现 runs.map( —— 直接渲染全量就绕过了 partitionRuns 的分组");
	}
	if (!src.includes("running.map(")) violations.push("R8d 前提：页面未渲染 running 组（正向基准不在）");
	if (!src.includes("others.map(")) violations.push("R8d 前提：页面未渲染 others 组（正向基准不在）");
	assert.deepEqual(violations, [], `R8 页面接线违规：\n- ${violations.join("\n- ")}`);

	ok("R8 页面接线：RunsPage 用 partitionRuns(runs) 分组、import 自 ../runsView、且无内联 .filter(/runs.map(");
}

console.log(`_test_runs_view: all assertions passed (${n} groups)`);
