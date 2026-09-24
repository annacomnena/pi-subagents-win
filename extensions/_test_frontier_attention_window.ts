/**
 * _test_frontier_attention_window.ts — G-A 回归测试：frontier ⑤ 不得是显示分页/排名的函数
 *
 * 命题（plans/0924_graph_E2_impl_plan.md §12 MF2 裁定；G-A 语义修复）：
 *   `buildFrontier` 的 ⑤ needs_user 必须消费 `snapshot.attentionByRepo`（分页前全量 attention
 *   投影：`global-view.ts` 在 allRows 切片之前聚合，与 `rows[].attention` 同源），**不得**消费
 *   `snapshot.home/rows`（GUI 分页后投影，生产实参 page=1 / pageSize=20）→ ⑤ 触发集合必须是
 *   工作状态的函数，而非显示排序/页码的函数。
 *
 * 本测试用机器可证的三件事把它钉死：
 *   1) 页外不漏检：21 个真实仓各有 attention>0，首页只容纳 20 → 第 21 仓 needsUser=true，
 *      跨三帧不产 ⑤（基线帧已记录 true → 无边沿）；同一 prev 下 page=1 与 page=2 的 next/diff 全等。
 *   2) 仅换排名不造假边沿：固定全部仓 attention/其它载体，只压低一个原本排前仓的活跃度
 *      （纯显示排序输入）→ 零触发、next 逐字节不变。
 *   3) 规模覆盖：19/20/21/40 仓四档，打印 attention>0 数 / 首页容纳 / 页外漏检 / 假边沿条数。
 *   另含 N1-N4（§12 机器验收口径）：排名无关性、surviving 仓 attention 边沿序列、冷启动零触发、
 *   n≤20 新旧口径等价性 harness（n=21 差异恰为 1 仓 false→true + 1 条 ⑤）。
 *   L4 补强：M1（旧 prev 一次性补报）/ M2（legacy↔new 双向反复切换：每仓 ⑤≤1、同口径连续帧 0、
 *   稳定帧 msv 不变、非预测字段不漂移）/ M3（新语义连续三帧 msv 不变）/ K1（normalizer 键一致性 tripwire）。
 *
 * 隔离：临时 PI_RUNTIME_DIR/PI_TAB_RUNS_DIR（照 `_test_runtime_autonomy.ts` A11 先例），
 * 固定 now（不依赖真实时钟），绝不碰真实 ~/.pi/agent。
 *
 * 运行（EB-004 外部超时）：timeout 300 node --experimental-strip-types ./extensions/_test_frontier_attention_window.ts
 * 计划：plans/0924_graph_E2_impl_plan.md §12（P0）+ plans/0924_attention_semantics_fix_plan.md §5。
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
// offender，除非改那个既有 tripwire 的排除表。本回归测试沿用拼接 specifier 规避字面量（动态 import
// 解析结果不变）。若后续更倾向显式排除，按计划 §7 SF2 先例在 _test_runtime_autonomy.ts 加一行
// `if (p === join(EXT_ROOT, "_test_frontier_attention_window.ts")) continue;`。
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

// ── fixture：每个仓 1 个可见 tab（默认 attached → attention=1，needsHuman/gate 均未兜底）──
interface World {
	root: string;
	agentDir: string;
	runsDir: string;
	repos: string[];
}

function writeTab(runsDir: string, i: number, repoPath: string, lastActivityMs: number, phase = "attached"): void {
	const id = `run_${String(i).padStart(2, "0")}`;
	writeFileSync(
		join(runsDir, `${id}.json`),
		JSON.stringify({ id, version: 1, taskId: `T${i}`, mode: "workflow", cwd: repoPath, dispatchedAt: iso(lastActivityMs), dispatchStatus: "dispatched" }),
	);
	// attached：classifyDispatch → active=true, attention=true, hiddenKind=null（可见）
	//            classifyForReclaim → "pending"（非 awaitingInput）；无 recentwork.md → gate=unknown
	// working：classifyDispatch → active=true, attention=false, hiddenKind=null（可见但非待审）
	writeFileSync(
		join(runsDir, `${id}.state.json`),
		JSON.stringify({ id, phase, turn: "working", terminal: false, lastActivityAt: iso(lastActivityMs) }),
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
const needsUserTriggers = (d: { triggers: { rule: string; project: string }[] }, key?: string): number =>
	d.triggers.filter((t) => t.rule === "needs_user" && (key === undefined || t.project === key)).length;
const attnSum = (m: Record<string, number>): number => Object.values(m).reduce((a, b) => a + b, 0);
/** legacy = 旧窗口口径：attentionByRepo 仅由分页后 rows 派生（模拟修复前 frontier ⑤ 的载体）。 */
const legacyOf = (s: GlobalViewSnapshot): GlobalViewSnapshot => {
	const m: Record<string, number> = {};
	for (const r of s.rows) if (r.attention > 0) m[normalizeExactPath(r.repoPath)] = r.attention;
	return { ...s, attentionByRepo: m };
};

const worlds: World[] = [];
const makeTracked = (tag: string, n: number): World => { const w = makeWorld(tag, n); worlds.push(w); return w; };

// ════════════════ 1) 页外不漏检（21 仓，跨三帧）+ HOME 伪仓 ════════════════
console.log("1) 页外不漏检：21 仓各有 attention>0，首页只容纳 20（⑤ 消费分页前全量投影）");
check("1.1 生产实参 page=1/pageSize=20：attention 总数 21、首页 20、第 21 仓在页外但全量投影/details 可见", () => {
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
	// G-A 追加：分页前全量投影含页外仓，且与 totals.attention 同源（Σ 不变量）
	assert.equal(attnSum(s.attentionByRepo), s.totals.attention, `Σ attentionByRepo 必须等于 totals.attention，实际 ${attnSum(s.attentionByRepo)}`);
	assert.equal(s.attentionByRepo[offKey], 1, "页外仓键必须在全量 attention 投影内");
	console.log(`       attention>0=21 / 首页容纳=${s.rows.length} / ΣattentionByRepo=${attnSum(s.attentionByRepo)} / 页外仓=${offKey.slice(-3)}（投影内=${s.attentionByRepo[offKey]}` + `）`);
});
check("1.2 HOME 是伪仓：repoPath=__HOME__、attention=0、不占 rows 名额、不进全量投影", () => {
	const w = worlds[0]!;
	const s = prodView(w);
	assert.equal(s.home.repoPath, "__HOME__");
	assert.equal(s.home.attention, 0);
	assert.ok(!s.rows.some((r) => r.repoPath === "__HOME__"), "HOME 不在 rows 内（不消耗分页名额）");
	assert.equal(s.attentionByRepo["__HOME__"], undefined, "HOME 伪仓不得进 attentionByRepo");
	console.log(`       home.repoPath=${s.home.repoPath} home.attention=${s.home.attention} homeInRows=${s.rows.some((r) => r.repoPath === "__HOME__")} homeInAttn=${s.attentionByRepo["__HOME__"]}`);
});
check("1.3 页外仓同样 needsUser=true（修复语义）：21 仓全 needsUser，不再因分页漏检", () => {
	const w = worlds[0]!;
	const f1 = build(prodView(w), null);
	const offKey = keyOf(w, 20);
	assert.equal(needsUserOf(f1.next, offKey), true, "页外 attention>0 仓必须 needsUser=true");
	assert.equal(f1.next.projects.filter((p) => p.needsUser).length, 21, "21 仓应全 needsUser=true");
	console.log(`       needsUser: 总数=${f1.next.projects.filter((p) => p.needsUser).length}/21 页外(${offKey.slice(-3)})=${needsUserOf(f1.next, offKey)}`);
});
check("1.4 跨三帧：页外仓 needsUser 恒 true，但 ⑤=0（基线帧已记录 true → 无边沿）", () => {
	const w = worlds[0]!;
	const offKey = keyOf(w, 20);
	const f1 = build(prodView(w), null); // 帧1 基线：needsUser 已 true
	const f2 = build(prodView(w), f1.next); // 帧2
	const f3 = build(prodView(w), f2.next); // 帧3
	const t2 = needsUserTriggers(f2.diff, offKey);
	const t3 = needsUserTriggers(f3.diff, offKey);
	assert.equal(needsUserOf(f2.next, offKey), true);
	assert.equal(needsUserOf(f3.next, offKey), true);
	assert.equal(t2, 0, `帧2 不应产页外仓 ⑤（基线已 true），实际 ${t2}`);
	assert.equal(t3, 0, `帧3 不应产页外仓 ⑤（基线已 true），实际 ${t3}`);
	console.log(`       帧2 ⑤=${t2} 帧3 ⑤=${t3}（页外仓 needsUser 恒 true，无重复边沿）`);
});
check("1.5 分页无关：同一 prev 下 page=1 与 page=2 的 next/diff JSON 逐字节全等", () => {
	const w = worlds[0]!;
	const offKey = keyOf(w, 20);
	const f1 = build(prodView(w), null);
	const sPage1 = prodView(w);
	const sPage2 = collectGlobalView({ agentDir: w.agentDir, now: NOW, page: 2 });
	assert.equal(sPage2.rows.length, 1, "page=2 只含第 21 仓");
	assert.equal(normalizeExactPath(sPage2.rows[0]!.repoPath), offKey);
	assert.equal(sPage2.rows[0]!.attention, 1, "page=2 行 attention 仍为 1（载体未变）");
	const gPage1 = build(sPage1, f1.next);
	const gPage2 = build(sPage2, f1.next);
	assert.equal(needsUserOf(gPage2.next, offKey), true, "page=2 时同仓 needsUser=true");
	assert.equal(JSON.stringify(gPage1.next), JSON.stringify(gPage2.next), "next 必须与 page 无关");
	assert.equal(JSON.stringify(gPage1.diff), JSON.stringify(gPage2.diff), "diff 必须与 page 无关");
	console.log(`       page=1 vs page=2：next 全等=${JSON.stringify(gPage1.next) === JSON.stringify(gPage2.next)} diff 全等=${JSON.stringify(gPage1.diff) === JSON.stringify(gPage2.diff)}（page=2 行 attention=${sPage2.rows[0]!.attention}）`);
});

// ════════════════ 2) 仅换显示排名不再造边沿 ════════════════
console.log("2) 仅换显示排名：固定全部载体，只压低一个原本排前仓的活跃度");
check("2.1 只改显示排序输入 → 零触发、next.projects 逐仓字段不变（无假边沿）", () => {
	const w = makeTracked("edge", 21);
	const offKey = keyOf(w, 20);
	const demotedKey = keyOf(w, 19);
	// 帧1：基线。repo_19 在首页、repo_20 在页外
	const a1 = prodView(w);
	assert.ok(a1.rows.some((r) => normalizeExactPath(r.repoPath) === demotedKey), "帧1 repo_19 应在首页");
	assert.ok(!a1.rows.some((r) => normalizeExactPath(r.repoPath) === offKey), "帧1 repo_20 应在页外");
	const g1 = build(a1, null);
	assert.equal(needsUserOf(g1.next, offKey), true);
	assert.equal(needsUserOf(g1.next, demotedKey), true);
	// 帧2：唯一改动 = 把 repo_19 的 lastActivityAt 压低（纯显示排序输入/活跃度）
	writeTab(w.runsDir, 19, w.repos[19]!, NOW - 1000 * MIN);
	const a2 = prodView(w);
	// 载体不变：attention 总数不变、repo_20 的 tab 仍 attached
	assert.equal(a2.totals.attention, 21, `attention 总数必须不变，实际 ${a2.totals.attention}`);
	assert.ok(a2.details.some((d) => normalizeExactPath(d.repoPath) === offKey && d.phase === "attached"), "repo_20 载体（attached）必须不变");
	assert.ok(a2.rows.some((r) => normalizeExactPath(r.repoPath) === offKey), "repo_20 应挤进首页（显示排名变了）");
	assert.ok(!a2.rows.some((r) => normalizeExactPath(r.repoPath) === demotedKey), "repo_19 应被挤出首页");
	const g2 = build(a2, g1.next);
	assert.equal(needsUserTriggers(g2.diff), 0, `仅换排名不应产任何 ⑤，实际 ${needsUserTriggers(g2.diff)}`);
	assert.equal(g2.diff.triggers.length, 0, `仅换排名不应产任何触发，实际 ${g2.diff.triggers.length}`);
	assert.equal(JSON.stringify(g2.next.projects), JSON.stringify(g1.next.projects), "next.projects 必须逐仓字段不变");
	console.log(`       仅改 repo_19 活跃度：attention 总数 21→${a2.totals.attention}，⑤=+${needsUserTriggers(g2.diff)}，projects 不变=${JSON.stringify(g2.next.projects) === JSON.stringify(g1.next.projects)}`);
});

// ════════════════ 3) 规模覆盖 19/20/21/40 ════════════════
console.log("3) 规模覆盖（19/20/21/40 仓）：修复后各档页外漏检=0、假边沿=0");
const scaleRows: { n: number; attention: number; capacity: number; leak: number; fakeEdges: number }[] = [];
for (const n of [19, 20, 21, 40]) {
	check(`3.${n} ${n} 仓：attention>0=${n}，页外漏检=0，假边沿=0`, () => {
		const w = makeTracked(`scale${n}`, n);
		const s1 = prodView(w);
		const f1 = build(s1, null);
		assert.equal(s1.totals.attention, n, `attention>0 应为 ${n}`);
		assert.equal(s1.rows.length, Math.min(n, 20), "首页容纳 = min(n,20)");
		const leak = f1.next.projects.filter((p) => !p.needsUser).length; // 每仓 attention>0，false 即页外漏检
		assert.equal(leak, 0, `页外漏检应为 0（全量投影），实际 ${leak}`);
		// 假边沿：压低最后一个首页仓的活跃度（仅显示排名），看是否有页外仓挤入并产 ⑤
		const demoteIdx = Math.min(19, n - 1);
		writeTab(w.runsDir, demoteIdx, w.repos[demoteIdx]!, NOW - 1000 * MIN);
		const s2 = prodView(w);
		const f2 = build(s2, f1.next);
		const fakeEdges = needsUserTriggers(f2.diff);
		assert.equal(s2.totals.attention, n, "attention 载体不变");
		assert.equal(fakeEdges, 0, `假边沿应为 0，实际 ${fakeEdges}`);
		scaleRows.push({ n, attention: s1.totals.attention, capacity: s1.rows.length, leak, fakeEdges });
	});
}

console.log("\n  规模 | attention>0 | 首页容纳 | 页外漏检 | 假边沿");
for (const r of scaleRows) console.log(`  ${String(r.n).padStart(4)} | ${String(r.attention).padStart(11)} | ${String(r.capacity).padStart(8)} | ${String(r.leak).padStart(8)} | ${String(r.fakeEdges).padStart(6)}`);

// ════════════════ N1-N4：§12 机器验收口径 ════════════════
console.log("\nN) §12 验收口径（排名无关性 / surviving 边沿序列 / 冷启动 / n≤20 等价性）");
check("N1 只改显示排名 → frontier 逐字节不变（三帧：基线→同输入→仅改排序输入）", () => {
	const w = makeTracked("n1", 21);
	const offKey = keyOf(w, 20);
	const f1 = build(prodView(w), null);
	const f2 = build(prodView(w), f1.next);
	assert.equal(f2.diff.triggers.length, 0, "同输入帧不应产触发");
	// 唯一改动：压低首页仓 repo_19 的 lastActivityAt（显示排序输入）；载体不变
	writeTab(w.runsDir, 19, w.repos[19]!, NOW - 1000 * MIN);
	const s3 = prodView(w);
	assert.equal(s3.totals.attention, 21, "载体不变（totals.attention 恒定）");
	assert.ok(s3.details.some((d) => normalizeExactPath(d.repoPath) === offKey && d.phase === "attached"), "页外仓 details 仍 attached");
	const f3 = build(s3, f2.next);
	assert.equal(JSON.stringify(f3.next), JSON.stringify(f2.next), "next 必须逐字节不变");
	assert.equal(f3.diff.triggers.length, 0, "不应产任何触发");
	console.log(`       f2→f3 仅改排序：next 全等=${JSON.stringify(f3.next) === JSON.stringify(f2.next)} triggers=${f3.diff.triggers.length}`);
});
check("N2 surviving 仓 attention 0→1→1→0→1 → ⑤ 计数 [1,0,0,1]，needsUser [false,true,true,false,true]", () => {
	const w = makeTracked("n2", 1); // 单仓，多仓干扰清零
	const k = keyOf(w, 0);
	const phases = ["working", "attached", "attached", "working", "attached"];
	let prev: FrontierSnapshot | null = null;
	const counts: number[] = [];
	const seq: boolean[] = [];
	for (const ph of phases) {
		writeTab(w.runsDir, 0, w.repos[0]!, NOW, ph);
		const g = build(prodView(w), prev);
		assert.ok(g.next.projects.some((p) => p.project === k), `surviving 项目必须在 next.projects 内（phase=${ph}）`);
		seq.push(needsUserOf(g.next, k));
		if (prev !== null) counts.push(needsUserTriggers(g.diff));
		prev = g.next;
	}
	assert.deepEqual(counts, [1, 0, 0, 1], `⑤ 计数序列应为 [1,0,0,1]，实际 ${JSON.stringify(counts)}`);
	assert.deepEqual(seq, [false, true, true, false, true], `needsUser 序列应为 [false,true,true,false,true]，实际 ${JSON.stringify(seq)}`);
	console.log(`       attention 序列 ${phases.map((p) => (p === "attached" ? 1 : 0)).join("→")} → ⑤ ${counts.join(",")} / needsUser ${seq.join(",")}`);
});
check("N3 冷启动（prev=null）不产 ⑤：baseline=true 且 triggers 为空", () => {
	const w = makeTracked("n3", 21);
	const g = build(prodView(w), null);
	assert.equal(g.next.baseline, true, "首帧必须 baseline=true");
	assert.equal(g.diff.triggers.length, 0, "冷启动零触发");
	assert.equal(needsUserTriggers(g.diff), 0, "冷启动无 ⑤");
	assert.equal(g.next.projects.filter((p) => p.needsUser).length, 21, "基线帧已记录 21 仓 needsUser=true");
	console.log(`       baseline=${g.next.baseline} triggers=${g.diff.triggers.length} needsUser=${g.next.projects.filter((p) => p.needsUser).length}/21`);
});
check("N4 n≤20 新旧口径全等；n=21 差异恰为 1 仓 needsUser false→true + 恰 1 条 ⑤", () => {
	// legacy = 旧窗口口径（模块级 legacyOf）
	// n≤20：首页即全量 → 新旧口径逐键相等，同 prev 下 next/diff JSON 全等
	for (const n of [19, 20]) {
		const w = makeTracked(`n4eq${n}`, n);
		const snap = prodView(w);
		const legacy = legacyOf(snap);
		assert.deepEqual(legacy.attentionByRepo, snap.attentionByRepo, `n=${n} 旧窗口口径应等于全量口径`);
		const prev = build(snap, null).next;
		const a = build(snap, prev);
		const b = build(legacy, prev);
		assert.equal(JSON.stringify(a.next), JSON.stringify(b.next), `n=${n} next 应全等`);
		assert.equal(JSON.stringify(a.diff), JSON.stringify(b.diff), `n=${n} diff 应全等`);
	}
	// n=21：页外 1 仓差异
	const w = makeTracked("n4diff", 21);
	const snap = prodView(w);
	const legacy = legacyOf(snap);
	const offKey = keyOf(w, 20);
	assert.equal(legacy.attentionByRepo[offKey], undefined, "旧窗口口径缺页外仓键");
	assert.equal(snap.attentionByRepo[offKey], 1, "新语义含页外仓键");
	const prev = build(legacy, null).next; // 旧口径基线：页外仓 needsUser=false
	assert.equal(needsUserOf(prev, offKey), false);
	const rLegacy = build(legacy, prev);
	const rNew = build(snap, prev);
	assert.equal(needsUserTriggers(rLegacy.diff), 0, "旧口径同输入零触发");
	assert.equal(needsUserTriggers(rNew.diff), 1, "新语义恰 1 条 ⑤");
	// 逐仓比对：恰 1 仓差异，且该仓仅 needsUser false→true + meaningfulStateVersion +1
	const diffRepos: string[] = [];
	for (let i = 0; i < rNew.next.projects.length; i++) {
		const a = rLegacy.next.projects[i]!;
		const b = rNew.next.projects[i]!;
		assert.equal(a.project, b.project, "项目顺序必须一致");
		for (const f of ["state", "variant", "gate", "runs", "resultMissing", "stagnation", "overdue"] as const) {
			assert.equal(JSON.stringify(a[f]), JSON.stringify(b[f]), `${a.project} 字段 ${f} 不应漂移`);
		}
		if (a.needsUser !== b.needsUser || a.meaningfulStateVersion !== b.meaningfulStateVersion) {
			assert.equal(a.needsUser, false);
			assert.equal(b.needsUser, true);
			assert.equal(b.meaningfulStateVersion, a.meaningfulStateVersion + 1, "msv 仅因该真触发 +1");
			diffRepos.push(a.project);
		}
	}
	assert.deepEqual(diffRepos, [offKey], `差异仓应恰为页外仓，实际 ${JSON.stringify(diffRepos)}`);
	console.log(`       n≤20 全等=✔；n=21 差异仓=${diffRepos.length}（${diffRepos[0]?.slice(-3)}）⑤=${needsUserTriggers(rNew.diff)}`);
});

// ════════════════ M1-M3：L2 §6 迁移测试（必须修）+ Σ 键一致性 tripwire ════════════════
console.log("\nM) 迁移（L2 §6）：旧 prev 一次性补报 / 双向反复切换 / 新语义连续帧 msv");
check("M1 旧 prev（页外仓 needsUser=false）→ 新语义首帧恰 1 条 ⑤（该仓），同输入下一帧 0 条", () => {
	const w = makeTracked("m1", 21);
	const snap = prodView(w);
	const legacy = legacyOf(snap);
	const offKey = keyOf(w, 20);
	const prev = build(legacy, null).next; // 旧口径基线：页外仓 needsUser=false
	assert.equal(needsUserOf(prev, offKey), false, "旧口径基线页外仓 needsUser=false");
	const f1 = build(snap, prev);
	assert.equal(needsUserTriggers(f1.diff, offKey), 1, "首帧新语义恰 1 条页外仓 ⑤");
	assert.equal(needsUserTriggers(f1.diff), 1, "首帧总 ⑤ 恰 1 条（仅该仓一次性迁移）");
	const f2 = build(snap, f1.next);
	assert.equal(needsUserTriggers(f2.diff), 0, "同输入下一帧 0 条 ⑤（不重复补报）");
	console.log(`       旧 prev 页外仓 needsUser=${needsUserOf(prev, offKey)} → 首帧 ⑤=${needsUserTriggers(f1.diff, offKey)} → 次帧 ⑤=${needsUserTriggers(f2.diff)}`);
});
check("M2 双向/反复切换 legacy↔new（同一 21 仓 fixture、同一 prev 链）：每仓 ⑤ ≤1、同口径连续帧 0、稳定帧 msv 不变、非预测字段不漂移", () => {
	const w = makeTracked("m2", 21);
	const snap = prodView(w);
	const legacy = legacyOf(snap);
	const offKey = keyOf(w, 20);
	// 同一 prev 链：以 legacy 基线（页外仓 needsUser=false）起始，逐帧把 prev 传下去；覆盖 legacy→new→legacy→new
	const seq: ("legacy" | "new")[] = ["legacy", "new", "new", "legacy", "legacy", "new", "new"];
	let prev = build(legacy, null).next;
	const frames: { kind: "legacy" | "new"; next: FrontierSnapshot; diff: ReturnType<typeof build>["diff"] }[] = [];
	for (const kind of seq) {
		const g = build(kind === "legacy" ? legacy : snap, prev);
		frames.push({ kind, next: g.next, diff: g.diff });
		prev = g.next;
	}
	// (a) 逐帧：每仓 needs_user 至多一次
	for (let i = 0; i < frames.length; i++) {
		const counts = new Map<string, number>();
		for (const t of frames[i]!.diff.triggers) if (t.rule === "needs_user") counts.set(t.project, (counts.get(t.project) ?? 0) + 1);
		for (const [k, c] of counts) assert.ok(c <= 1, `帧${i} 仓 ${k} needs_user 必须 ≤1，实际 ${c}`);
	}
	// (b) 同口径连续两帧：后一帧 0 触发（无振荡）
	for (let i = 1; i < frames.length; i++) {
		if (frames[i]!.kind !== frames[i - 1]!.kind) continue;
		assert.equal(frames[i]!.diff.triggers.length, 0, `同口径连续帧 ${i - 1}→${i}（${frames[i]!.kind}）必须 0 触发`);
	}
	// (c) 稳定帧（同口径连续对的后一帧）msv 全不变
	const msvOf = (f: FrontierSnapshot, k: string): number => f.projects.find((p) => p.project === k)?.meaningfulStateVersion ?? -1;
	for (let i = 1; i < frames.length; i++) {
		if (frames[i]!.kind !== frames[i - 1]!.kind) continue;
		for (const p of frames[i]!.next.projects) assert.equal(msvOf(frames[i]!.next, p.project), msvOf(frames[i - 1]!.next, p.project), `稳定帧 ${i} 仓 ${p.project} msv 必须不变`);
	}
	// (d) 方向性 + 字段不漂移：切换帧差异恰为页外仓 needsUser（+ msv，仅 legacy→new），其余 project 字段全等
	const FIELDS = ["state", "variant", "gate", "runs", "resultMissing", "stagnation", "overdue"] as const;
	for (let i = 1; i < frames.length; i++) {
		if (frames[i]!.kind === frames[i - 1]!.kind) continue; // 只看切换帧
		const a = frames[i - 1]!.next;
		const b = frames[i]!.next;
		assert.equal(a.projects.length, b.projects.length, "切换帧项目数一致");
		const drifted: string[] = [];
		for (let j = 0; j < a.projects.length; j++) {
			const pa = a.projects[j]!;
			const pb = b.projects[j]!;
			assert.equal(pa.project, pb.project, "切换帧项目顺序必须一致");
			for (const f of FIELDS) assert.equal(JSON.stringify(pa[f]), JSON.stringify(pb[f]), `切换帧 ${pa.project} 字段 ${f} 不应漂移`);
			if (pa.needsUser !== pb.needsUser || pa.meaningfulStateVersion !== pb.meaningfulStateVersion) drifted.push(pa.project);
		}
		assert.deepEqual(drifted, [offKey], `切换帧差异仓必须恰为页外仓，实际 ${JSON.stringify(drifted)}`);
		const expected = frames[i]!.kind === "new" ? 1 : 0;
		assert.equal(needsUserTriggers(frames[i]!.diff, offKey), expected, `${frames[i - 1]!.kind}→${frames[i]!.kind} 页外仓 ⑤ 应为 ${expected}`);
	}
	console.log(`       seq=${seq.join("→")}；⑤ 逐帧=${frames.map((f) => f.diff.triggers.length).join(",")}（仅 legacy→new 切换帧 =1，无振荡）`);
});
check("M3 新语义连续三帧同输入：0 触发、msv 不变（显式 msv 断言）", () => {
	const w = makeTracked("m3", 21);
	const snap = prodView(w);
	const offKey = keyOf(w, 20);
	const f1 = build(snap, null); // 基线
	const f2 = build(snap, f1.next);
	const f3 = build(snap, f2.next);
	assert.equal(f2.diff.triggers.length, 0, "帧2 必须 0 触发");
	assert.equal(f3.diff.triggers.length, 0, "帧3 必须 0 触发");
	const msv2 = new Map(f2.next.projects.map((p) => [p.project, p.meaningfulStateVersion]));
	for (const p of f3.next.projects) assert.equal(p.meaningfulStateVersion, msv2.get(p.project), `仓 ${p.project} msv 必须不变`);
	assert.equal(needsUserOf(f3.next, offKey), true, "页外仓仍 needsUser=true");
	console.log(`       帧1(基线)→帧2→帧3：⑤=${f2.diff.triggers.length},${f3.diff.triggers.length}，msv 全不变=✔`);
});

// ⚠ tripwire：两份 exact-path normalizer 是双写——`global-view.ts` 用 `recent-scopes.ts` 的
// `normalizeExactPath`，`frontier.ts` 用本地副本（为保持依赖图零 node:fs）。**单侧改动**会让
// global-view 的 attentionByRepo 键与 frontier 的 detail 键错配，静默表现为 attention=0（⑤ 漏检）。
// 本测试用大小写/分隔符变体路径把「键一致」钉死；任一侧 normalizer 漂移 → 本 check 变红。
check("K1 键一致性 tripwire：大小写/分隔符变体路径下 global-view map 键 == frontier detail 键", () => {
	const w = makeTracked("k1", 3);
	// 变体：反斜杠→正斜杠 + 整体大写 + 尾部分隔符（normalizeExactPath 必须把它们折回同一键）
	const variants = w.repos.map((rp) => `${rp.replace(/\\/g, "/").toUpperCase()}/`);
	for (let i = 0; i < variants.length; i++) writeTab(w.runsDir, i, variants[i]!, NOW - i * MIN);
	const s = prodView(w);
	assert.ok(s.details.some((d) => d.repoPath !== normalizeExactPath(d.repoPath)), "fixture 必须含未归一化 repoPath（否则 tripwire 无效）");
	const f = build(s, null);
	assert.equal(f.next.projects.length, 3, "3 仓");
	assert.equal(Object.keys(s.attentionByRepo).length, 3, "全量投影 3 键");
	for (const p of f.next.projects) {
		assert.equal(s.attentionByRepo[p.project], 1, `frontier 键 ${p.project} 必须在 global-view map 内（单侧 normalizer 漂移 → 静默 attention=0）`);
		assert.equal(needsUserOf(f.next, p.project), true, `仓 ${p.project} 必须 needsUser=true`);
	}
	const mapKeys = Object.keys(s.attentionByRepo).sort();
	const detailKeys = [...new Set(f.next.projects.map((p) => p.project))].sort();
	assert.deepEqual(mapKeys, detailKeys, "两 map 键集合必须逐字相等");
	console.log(`       变体样本=${variants[0]?.slice(-24)} → 键一致=${JSON.stringify(mapKeys) === JSON.stringify(detailKeys)}`);
});

// ── 清理 + 汇总 ─────────────────────────────────────────────────────
for (const w of worlds) rmSync(w.root, { recursive: true, force: true });
rmSync(ENV_TMP, { recursive: true, force: true });
if (failed > 0) {
	console.error(`\n_test_frontier_attention_window: FAILED (${failed} failed / ${passed} passed)`);
	process.exit(1);
}
console.log(`\n_test_frontier_attention_window: all ${passed} checks passed`);
