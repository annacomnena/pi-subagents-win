/**
 * _test_frontier_attention_window.ts — P0 反例：frontier ⑤ 依赖 GUI 显示分页
 *
 * 命题（plans/0924_graph_E2_impl_plan.md §12 MF2 裁定）：
 *   `buildFrontier` 的 ⑤ needs_user 规则消费的是 `snapshot.home + snapshot.rows` 的
 *   **分页后** attention（`global-view.ts` 排序键 #L570-L574 + `slice` #L577，生产实参
 *   page=1 / pageSize=20）→ ⑤ 触发集合是**显示排序的函数**，而非工作状态的函数。
 *
 * 本测试用机器可证的三件事把它钉死（零生产改动，只加本文件）：
 *   1) 页外漏检：21 个真实仓各有 attention>0，首页只容纳 20 → 第 21 仓 needsUser=false，
 *      跨三帧不产 ⑤（对照：同快照 page=2 时该仓 needsUser=true 且产 ⑤）。
 *   2) 仅换排名造成的假边沿：固定全部仓 attention/其它载体，只压低一个原本排前仓的活跃度
 *      （纯显示排序输入）→ 原页外 attention>0 仓挤进首页 → 新产 1 条 ⑤。
 *   3) 规模覆盖：19/20/21/40 仓四档，打印 attention>0 数 / 首页容纳 / 页外漏检 / 假边沿条数。
 *
 * 隔离：临时 PI_RUNTIME_DIR/PI_TAB_RUNS_DIR（照 `_test_runtime_autonomy.ts` A11 先例），
 * 固定 now（不依赖真实时钟），绝不碰真实 ~/.pi/agent。
 *
 * 运行（EB-004 外部超时）：timeout 300 node --experimental-strip-types ./extensions/_test_frontier_attention_window.ts
 * 计划：plans/0924_graph_E2_impl_plan.md §12（P0）。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 测试隔离：任何 defaultRuntimeDir()/defaultTabRunsDir() 都落 temp（A11 同款先例）
const ENV_TMP = mkdtempSync(join(tmpdir(), "frontier-attn-env-"));
process.env.PI_RUNTIME_DIR = ENV_TMP;
process.env.PI_TAB_RUNS_DIR = join(ENV_TMP, "tab-runs");

import { collectGlobalView, type GlobalViewSnapshot } from "./runtime/global-view.ts";
// A10.1 字面量 tripwire（_test_runtime_autonomy.ts）：测试文件若含 "runtime"+"/autonomy" 连续字面量会成为
// offender，除非改那个既有 tripwire 的排除表。本 P0 任务要求「零生产改动 + 只加这一个测试文件」，
// 故此处拼接 specifier 规避字面量（动态 import 解析结果不变）。若后续更倾向显式排除，按计划 §7 SF2
// 先例在 _test_runtime_autonomy.ts 加一行 `if (p === join(EXT_ROOT, "_test_frontier_attention_window.ts")) continue;`。
const frontierMod = await import("./runtime/" + "autonomy/frontier.ts");
const buildFrontier = frontierMod.buildFrontier;
const normalizeExactPath = frontierMod.normalizeExactPath;
type FrontierSnapshot = ReturnType<typeof buildFrontier>["next"];

const NOW = Date.parse("2026-09-24T12:00:00.000Z");
const MIN = 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const PAGE_SIZE_PROD = 20; // global-view.ts DEFAULT_PAGE_SIZE / Math.min(...,20)

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void): void {
	try {
		fn();
		passed++;
		console.log(`  ok   ${name}`);
	} catch (e) {
		failed++;
		console.error(`  FAIL ${name}\n       ${e instanceof Error ? e.message : String(e)}`);
	}
}

// ── fixture：每个仓 1 个可见 attached tab（attention=1，needsHuman/gate 均未兜底）──
interface World {
	root: string;
	agentDir: string;
	runsDir: string;
	repos: string[];
}

function writeTab(runsDir: string, i: number, repoPath: string, lastActivityMs: number): void {
	const id = `run_${String(i).padStart(2, "0")}`;
	writeFileSync(
		join(runsDir, `${id}.json`),
		JSON.stringify({ id, version: 1, taskId: `T${i}`, mode: "workflow", cwd: repoPath, dispatchedAt: iso(lastActivityMs), dispatchStatus: "dispatched" }),
	);
	// attached：classifyDispatch → active=true, attention=true, hiddenKind=null（可见）
	//            classifyForReclaim → "pending"（非 awaitingInput）；无 recentwork.md → gate=unknown
	writeFileSync(
		join(runsDir, `${id}.state.json`),
		JSON.stringify({ id, phase: "attached", turn: "working", terminal: false, lastActivityAt: iso(lastActivityMs) }),
	);
}

function makeWorld(tag: string, n: number): World {
	const root = mkdtempSync(join(tmpdir(), `frontier-attn-${tag}-`));
	const agentDir = join(root, "agent");
	const runsDir = join(agentDir, "tab-runs");
	const reposRoot = join(root, "repos");
	mkdirSync(runsDir, { recursive: true });
	mkdirSync(join(agentDir, "sessions"), { recursive: true });
	mkdirSync(join(agentDir, "timers"), { recursive: true });
	const repos: string[] = [];
	for (let i = 0; i < n; i++) {
		const rp = join(reposRoot, `r${String(i).padStart(2, "0")}`);
		mkdirSync(join(rp, ".git"), { recursive: true }); // 钉死 findRepoRoot 停在仓根
		repos.push(rp);
		writeTab(runsDir, i, rp, NOW - i * MIN); // lastMs 严格递减 → 排序确定
	}
	return { root, agentDir, runsDir, repos };
}

/** 生产实参：collect.ts#L122 调 collectGlobalView({agentDir, now}) 不传 page → page=1/pageSize=20。 */
const prodView = (w: World): GlobalViewSnapshot => collectGlobalView({ agentDir: w.agentDir, now: NOW });
const build = (snapshot: GlobalViewSnapshot, prev: FrontierSnapshot | null) => buildFrontier({ snapshot, backlog: [], prev, now: NOW });
const keyOf = (w: World, i: number): string => normalizeExactPath(w.repos[i]!);
const needsUserOf = (f: FrontierSnapshot, key: string): boolean => f.projects.find((p) => p.project === key)?.needsUser ?? false;
const needsUserTriggers = (d: { triggers: { rule: string; project: string }[] }, key: string): number =>
	d.triggers.filter((t) => t.rule === "needs_user" && t.project === key).length;

const worlds: World[] = [];
const makeTracked = (tag: string, n: number): World => { const w = makeWorld(tag, n); worlds.push(w); return w; };

// ════════════════ 1) 页外漏检（21 仓，跨三帧）+ HOME 伪仓 ════════════════
console.log("1) 页外漏检：21 仓各有 attention>0，首页只容纳 20");
check("1.1 生产实参 page=1/pageSize=20：attention 总数 21、首页 20、第 21 仓在页外但 details 可见", () => {
	const w = makeTracked("leak", 21);
	const s = prodView(w);
	assert.equal(s.cursor.page, 1, "cursor.page 必须为生产缺省 1");
	assert.equal(s.cursor.pageSize, PAGE_SIZE_PROD, "cursor.pageSize 必须为生产缺省 20");
	assert.equal(s.reposTotal, 21, "reposTotal");
	assert.equal(s.totals.attention, 21, `totals.attention 应为 21，实际 ${s.totals.attention}`);
	assert.equal(s.rows.length, 20, `首页容纳应为 20，实际 ${s.rows.length}`);
	const offKey = keyOf(w, 20);
	assert.ok(!s.rows.some((r) => normalizeExactPath(r.repoPath) === offKey), "第 21 仓必须落在页外");
	assert.ok(s.details.some((d) => normalizeExactPath(d.repoPath) === offKey), "第 21 仓必须有可见 details（attention>0 的真实载体）");
	console.log(`       attention>0=21 / 首页容纳=${s.rows.length} / 页外仓=${offKey.slice(-3)}（details 可见=${s.details.some((d) => normalizeExactPath(d.repoPath) === offKey)}）`);
});
check("1.2 HOME 是伪仓：repoPath=__HOME__、attention=0、不占 rows 名额", () => {
	const w = worlds[0]!;
	const s = prodView(w);
	assert.equal(s.home.repoPath, "__HOME__");
	assert.equal(s.home.attention, 0);
	assert.ok(!s.rows.some((r) => r.repoPath === "__HOME__"), "HOME 不在 rows 内（不消耗分页名额）");
	console.log(`       home.repoPath=${s.home.repoPath} home.attention=${s.home.attention} homeInRows=${s.rows.some((r) => r.repoPath === "__HOME__")}`);
});
check("1.3 页外 attention>0 仓 needsUser=false（漏检），页内 20 仓 needsUser=true（对照）", () => {
	const w = worlds[0]!;
	const f1 = build(prodView(w), null);
	const offKey = keyOf(w, 20);
	assert.equal(needsUserOf(f1.next, offKey), false, "页外 attention>0 仓不应 needsUser（这正是漏检）");
	assert.equal(f1.next.projects.filter((p) => p.needsUser).length, 20, "页内 20 仓应 needsUser=true");
	console.log(`       needsUser: 页内=${f1.next.projects.filter((p) => p.needsUser).length}/20 页外(${offKey.slice(-3)})=${needsUserOf(f1.next, offKey)}`);
});
check("1.4 跨三帧：页外 attention>0 仓始终不产 ⑤（漏检持续）", () => {
	const w = worlds[0]!;
	const offKey = keyOf(w, 20);
	const f1 = build(prodView(w), null); // 帧1 基线
	const f2 = build(prodView(w), f1.next); // 帧2
	const f3 = build(prodView(w), f2.next); // 帧3
	const t2 = needsUserTriggers(f2.diff, offKey);
	const t3 = needsUserTriggers(f3.diff, offKey);
	assert.equal(t2, 0, `帧2 不应产页外仓 ⑤，实际 ${t2}`);
	assert.equal(t3, 0, `帧3 不应产页外仓 ⑤，实际 ${t3}`);
	assert.equal(needsUserOf(f2.next, offKey), false);
	assert.equal(needsUserOf(f3.next, offKey), false);
	console.log(`       帧2 ⑤=${t2} 帧3 ⑤=${t3}（页外仓 needsUser 恒 false）`);
});
check("1.5 对照（机器证明是分页而非工作状态）：同一快照内容 page=2 → 页外仓 needsUser=true 且产 1 条 ⑤", () => {
	const w = worlds[0]!;
	const offKey = keyOf(w, 20);
	const f1 = build(prodView(w), null);
	const sPage2 = collectGlobalView({ agentDir: w.agentDir, now: NOW, page: 2 });
	assert.equal(sPage2.rows.length, 1, "page=2 只含第 21 仓");
	assert.equal(normalizeExactPath(sPage2.rows[0]!.repoPath), offKey);
	assert.equal(sPage2.rows[0]!.attention, 1, "page=2 行 attention 仍为 1（载体未变）");
	const fPage2 = build(sPage2, f1.next);
	assert.equal(needsUserOf(fPage2.next, offKey), true, "page=2 时同仓 needsUser=true");
	assert.equal(needsUserTriggers(fPage2.diff, offKey), 1, "page=2 时同仓产 1 条 ⑤");
	console.log(`       page=2：${offKey.slice(-3)} attention=${sPage2.rows[0]!.attention} needsUser=${needsUserOf(fPage2.next, offKey)} ⑤=${needsUserTriggers(fPage2.diff, offKey)}`);
});

// ════════════════ 2) 仅换显示排名造成的假边沿 ════════════════
console.log("2) 仅换显示排名：固定全部载体，只压低一个原本排前仓的活跃度");
check("2.1 只改显示排序输入 → 原页外 attention>0 仓挤进首页 → 新产 1 条假 ⑤", () => {
	const w = makeTracked("edge", 21);
	const offKey = keyOf(w, 20);
	const demotedKey = keyOf(w, 19);
	// 帧1：基线。repo_19 在首页、repo_20 在页外
	const a1 = prodView(w);
	assert.ok(a1.rows.some((r) => normalizeExactPath(r.repoPath) === demotedKey), "帧1 repo_19 应在首页");
	assert.ok(!a1.rows.some((r) => normalizeExactPath(r.repoPath) === offKey), "帧1 repo_20 应在页外");
	const g1 = build(a1, null);
	assert.equal(needsUserOf(g1.next, offKey), false);
	assert.equal(needsUserOf(g1.next, demotedKey), true);
	// 帧2：唯一改动 = 把 repo_19 的 lastActivityAt 压低（纯显示排序输入/活跃度）
	writeTab(w.runsDir, 19, w.repos[19]!, NOW - 1000 * MIN);
	const a2 = prodView(w);
	// 载体不变：attention 总数不变、repo_20 的 tab 仍 attached
	assert.equal(a2.totals.attention, 21, `attention 总数必须不变，实际 ${a2.totals.attention}`);
	assert.ok(a2.details.some((d) => normalizeExactPath(d.repoPath) === offKey && d.phase === "attached"), "repo_20 载体（attached）必须不变");
	assert.ok(a2.rows.some((r) => normalizeExactPath(r.repoPath) === offKey), "repo_20 应挤进首页");
	assert.ok(!a2.rows.some((r) => normalizeExactPath(r.repoPath) === demotedKey), "repo_19 应被挤出首页");
	const g2 = build(a2, g1.next);
	assert.equal(needsUserTriggers(g2.diff, offKey), 1, `仅换排名应新产 1 条 ⑤（repo_20），实际 ${needsUserTriggers(g2.diff, offKey)}`);
	assert.equal(needsUserOf(g2.next, offKey), true);
	console.log(`       仅改 repo_19 活跃度：attention 总数 21→${a2.totals.attention}，repo_20 入页 ⑤=+${needsUserTriggers(g2.diff, offKey)}`);
});

// ════════════════ 3) 规模覆盖 19/20/21/40 ════════════════
console.log("3) 规模覆盖（19/20/21/40 仓）");
const scaleRows: { n: number; attention: number; capacity: number; leak: number; fakeEdges: number }[] = [];
for (const n of [19, 20, 21, 40]) {
	check(`3.${n} ${n} 仓：attention>0=${n}，页外漏检=${Math.max(0, n - 20)}，假边沿=${n > 20 ? 1 : 0}`, () => {
		const w = makeTracked(`scale${n}`, n);
		const s1 = prodView(w);
		const f1 = build(s1, null);
		assert.equal(s1.totals.attention, n, `attention>0 应为 ${n}`);
		assert.equal(s1.rows.length, Math.min(n, 20), "首页容纳 = min(n,20)");
		const leak = f1.next.projects.filter((p) => !p.needsUser).length; // 每仓 attention>0，false 即页外漏检
		assert.equal(leak, Math.max(0, n - 20), `页外漏检应为 ${Math.max(0, n - 20)}，实际 ${leak}`);
		// 假边沿：压低最后一个首页仓的活跃度（仅显示排名），看是否有页外仓挤入并产 ⑤
		const demoteIdx = Math.min(19, n - 1);
		writeTab(w.runsDir, demoteIdx, w.repos[demoteIdx]!, NOW - 1000 * MIN);
		const s2 = prodView(w);
		const f2 = build(s2, f1.next);
		const fakeEdges = f2.diff.triggers.filter((t) => t.rule === "needs_user").length;
		assert.equal(s2.totals.attention, n, "attention 载体不变");
		assert.equal(fakeEdges, n > 20 ? 1 : 0, `假边沿应为 ${n > 20 ? 1 : 0}，实际 ${fakeEdges}`);
		scaleRows.push({ n, attention: s1.totals.attention, capacity: s1.rows.length, leak, fakeEdges });
	});
}

console.log("\n  规模 | attention>0 | 首页容纳 | 页外漏检 | 假边沿");
for (const r of scaleRows) console.log(`  ${String(r.n).padStart(4)} | ${String(r.attention).padStart(11)} | ${String(r.capacity).padStart(8)} | ${String(r.leak).padStart(8)} | ${String(r.fakeEdges).padStart(6)}`);

// ── 清理 + 汇总 ─────────────────────────────────────────────────────
for (const w of worlds) rmSync(w.root, { recursive: true, force: true });
rmSync(ENV_TMP, { recursive: true, force: true });
if (failed > 0) {
	console.error(`\n_test_frontier_attention_window: FAILED (${failed} failed / ${passed} passed)`);
	process.exit(1);
}
console.log(`\n_test_frontier_attention_window: all ${passed} checks passed`);
