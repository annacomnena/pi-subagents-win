/**
 * _test_graph_frontier_input.ts — E2.1 `toFrontierInput` 适配器单测（T1–T14）
 *
 * 计划：plans/0924_graph_E2_1_impl_plan.md §7（T1–T14）/§4（R4）/§5（now）/§6（顺序）。
 * L1：plans/0924_graph_E2_1_recon.md §1/§2/§3/§6。
 *
 * 覆盖：空快照 / 单仓单 run / 多仓多 run / 大小写变体归一键 / 缺 carrier 不猜（pidAlive=null 合法）/
 *      history 恒空且不产 hidden 触发 / attention Σ 不变量 / 确定性与源码守卫（零 IO + 无第三份 normalizer）/
 *      结构等价 v2（同 fixture：buildFrontier(graph) ≡ buildFrontier(collectGlobalView)）/ 未知事件前向兼容 /
 *      now 透传（不采纳 snap.asof）/ details runId 升序 / record-only 前向 / details 成员过滤。
 *
 * 隔离：临时 PI_RUNTIME_DIR/PI_TAB_RUNS_DIR（不触真实 ~/.pi/agent）；固定 now（NOW）。
 * 运行（EB-004 外部超时）：timeout 300 node --experimental-strip-types ./extensions/_test_graph_frontier_input.ts
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 测试隔离：defaultRuntimeDir()/defaultTabRunsDir() 落 temp（A11 同款先例）
const ENV_TMP = mkdtempSync(join(tmpdir(), "e21-frontier-input-env-"));
process.env.PI_RUNTIME_DIR = ENV_TMP;
process.env.PI_TAB_RUNS_DIR = join(ENV_TMP, "tab-runs");

import { masterAddress, tabRunAddress } from "./runtime/address.ts";
import { newEventEnvelope, type RuntimeEnvelope } from "./runtime/envelope.ts";
import type { JournalSeqEntry } from "./runtime/journal-seq.ts";
import { normalizeExactPath } from "./runtime/recent-scopes.ts";
import { normalizeRepoKey } from "./runtime/graph/edges.ts";
import { projectGraph } from "./runtime/graph/project.ts";
import { readGraphSnapshot } from "./runtime/graph/collect.ts";
import { toFrontierInput } from "./runtime/graph/frontier-input.ts";
import { collectGlobalView } from "./runtime/global-view.ts";
import { buildFrontier, RECORD_ONLY_NOCARRIER } from "./runtime/autonomy/frontier.ts";
import type { GraphProjectView, GraphRunRef, GraphSnapshot } from "./runtime/graph/types.ts";
import type { FrontierSourceSnapshot } from "./runtime/autonomy/frontier.ts";

const NOW = Date.parse("2026-09-01T12:00:00.000Z");
const HOUR = 3600_000;
const iso = (ms: number): string => new Date(ms).toISOString();

let passed = 0;
function check(name: string, fn: () => void): void {
	fn();
	passed += 1;
	console.log(`  ok ${name}`);
}

// ── 手构快照工具（纯）──────────────────────────────────────────────

function mkRef(o: Partial<GraphRunRef> & { runId: string }): GraphRunRef {
	return {
		subject: `run://tab/${o.runId}`,
		status: "dispatched",
		phase: null,
		project: null,
		gate: null,
		needsHuman: null,
		staleOver: null,
		overdue: null,
		pidAlive: null,
		...o,
	};
}
function mkView(project: string, attention: number, runs: GraphRunRef[]): GraphProjectView {
	return { project, attention, runs };
}
function mkSnap(projects: GraphProjectView[], over: Partial<GraphSnapshot> = {}): GraphSnapshot {
	return {
		version: 1,
		headSeq: 0,
		logEpoch: "",
		nodes: [],
		edges: [],
		projects,
		skipped: { badLines: 0, unknownEventTypes: [] },
		...over,
	};
}
/** 合法 carrier（五键齐；pidAlive 可覆盖为 null）。 */
function carrier(runId: string, project: string, phase: string, over: Partial<GraphRunRef> = {}): GraphRunRef {
	return mkRef({ runId, project, phase, gate: "ok", needsHuman: false, staleOver: false, overdue: 0, pidAlive: null, ...over });
}
function dispatchEnv(tab: string, atN = 1): RuntimeEnvelope {
	const subject = tabRunAddress(tab);
	const at = iso(Date.UTC(2026, 0, 1, 0, 0, atN));
	return newEventEnvelope({
		type: "run.dispatched",
		source: masterAddress(),
		subject,
		at,
		dedupeKey: `run.dispatched:${subject}`,
		payload: { tabRunId: tab, executionKind: "tab", mode: "workflow", title: `t-${tab}` },
	});
}
const entries = (envs: RuntimeEnvelope[]): JournalSeqEntry[] => envs.map((envelope, i) => ({ seq: i + 1, envelope }));
const runIds = (out: FrontierSourceSnapshot): string[] => out.details.map((d) => d.runId);
/** canonical JSON：对象键递归排序（数组保序；确定性比较）。 */
function canon(v: unknown): unknown {
	if (Array.isArray(v)) return v.map(canon);
	if (v && typeof v === "object") {
		const o = v as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const k of Object.keys(o).sort()) out[k] = canon(o[k]);
		return out;
	}
	return v;
}
const canonicalJson = (v: unknown): string => JSON.stringify(canon(v));

// ── 真实 fixture（T6/T9/T11/T14 与 v2 同源对照）────────────────────

const ROOT = mkdtempSync(join(tmpdir(), "e21-frontier-input-fx-"));
const agentDir = join(ROOT, "agent");
const runsDir = join(agentDir, "tab-runs");
const sessionsRoot = join(agentDir, "sessions");
const timersDir = join(agentDir, "timers");
const journalPath = join(agentDir, "events.jsonl");
const stateDir = join(ROOT, "state");
const repoA = join(ROOT, "repos", "alpha");
const repoB = join(ROOT, "repos", "beta");
const repoC = join(ROOT, "repos", "gamma");
const GATE_OK = "# r\n\n## Active Tasks\n\n### Task Index\n\n| Item | Priority | Summary |\n| R1 | P0 | d |\n";
const GATE_AWAIT = `${GATE_OK}\n**Status**：waiting\n`;
const FAR_PAST = new Date(Date.now() - 100 * HOUR).toISOString();
const writeJson = (p: string, o: unknown): void => writeFileSync(p, JSON.stringify(o), "utf8");

for (const d of [runsDir, sessionsRoot, timersDir, join(timersDir, "mail"), stateDir, repoA, repoB, repoC]) mkdirSync(d, { recursive: true });
for (const r of [repoA, repoB, repoC]) mkdirSync(join(r, ".git"), { recursive: true });
writeFileSync(join(repoA, "recentwork.md"), GATE_AWAIT, "utf8");
writeFileSync(join(repoB, "recentwork.md"), GATE_OK, "utf8");
writeJson(join(timersDir, "t_over.json"), { id: "t_over", dueAt: iso(NOW - 30 * 60_000), status: "pending", ownerCwd: repoA });

interface FxRec { id: string; cwd: string; dispatchedAt: string; }
const fxRecs: FxRec[] = [
	{ id: "r_alpha", cwd: repoA, dispatchedAt: iso(NOW - 3 * HOUR) },
	{ id: "r_beta", cwd: repoB, dispatchedAt: iso(NOW - 3 * HOUR) },
	{ id: "r_gamma", cwd: repoC, dispatchedAt: iso(NOW - 3 * HOUR) },
	{ id: "r_hidden", cwd: repoA, dispatchedAt: FAR_PAST },
	{ id: "r_term", cwd: repoC, dispatchedAt: iso(NOW - 3 * HOUR) },
];
for (const r of fxRecs) {
	writeJson(join(runsDir, `${r.id}.json`), { id: r.id, version: 1, taskId: r.id.toUpperCase(), mode: "workflow", cwd: r.cwd, dispatchedAt: r.dispatchedAt, dispatchStatus: "dispatched" });
}
writeJson(join(runsDir, "r_alpha.state.json"), { id: "r_alpha", phase: "working", turn: "working", terminal: false, lastActivityAt: iso(NOW - 30 * 60_000), lastStopReason: "stop", lastAssistantText: "alpha", pid: 999_999_999 });
writeJson(join(runsDir, "r_beta.state.json"), { id: "r_beta", phase: "completed", turn: "idle", terminal: true, lastActivityAt: iso(NOW - 20 * 60_000) });
writeJson(join(runsDir, "r_gamma.state.json"), { id: "r_gamma", phase: "waiting", turn: "working", terminal: false, lastActivityAt: iso(NOW - 10 * 60_000), lastStopReason: "stop" });
writeJson(join(runsDir, "r_term.state.json"), { id: "r_term", phase: "completed", turn: "done", terminal: true, lastActivityAt: iso(NOW - 15 * 60_000) });
writeJson(join(runsDir, "r_term.result.json"), { id: "r_term", taskId: "R_TERM", status: "completed", finishedAt: iso(NOW - 2 * HOUR) });
writeFileSync(
	journalPath,
	`${fxRecs.map((r, i) => JSON.stringify(dispatchEnv(r.id, i + 1))).join("\n")}\n`,
	"utf8",
);

const gitProbeStub = (): { branch: string; dirty: string } => ({ branch: "main", dirty: "clean" });
const v2Snap = collectGlobalView({ agentDir, now: NOW, gitProbe: gitProbeStub });
const gSnap = readGraphSnapshot({ journalPath, stateDir, tabRunsDir: runsDir, sessionsRoot, timersDir, now: NOW });
const gOut = toFrontierInput(gSnap, { now: NOW });
// 与适配器同序（runId 升序）的 v2 details，用于严格 JSON 对照。
const v2Sorted = { ...v2Snap, details: [...v2Snap.details].sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0)) };

try {
	// ═════════════════════════ T1–T4 ═════════════════════════
	check("T1 空快照 → 三字段全空", () => {
		assert.deepEqual(toFrontierInput(mkSnap([]), { now: NOW }), { attentionByRepo: {}, details: [], history: [] });
	});

	check("T2 单仓单 run：逐字段 + attention>0 写键", () => {
		const out = toFrontierInput(mkSnap([mkView("c:/repo/a", 2, [carrier("r1", "c:/repo/a", "working", { gate: "awaiting", needsHuman: true, staleOver: true, overdue: 3, pidAlive: false })])]), { now: NOW });
		assert.deepEqual(out.attentionByRepo, { "c:/repo/a": 2 });
		assert.deepEqual(out.details, [{ runId: "r1", repoPath: "c:/repo/a", phase: "working", needsHuman: true, gate: "awaiting", staleOver: true, overdue: 3, pidAlive: false }]);
		assert.deepEqual(out.history, []);
	});

	check("T3 多仓多 run：键/计数 + Σ 不变量", () => {
		const out = toFrontierInput(
			mkSnap([
				mkView("c:/a", 1, [carrier("a1", "c:/a", "working"), carrier("a2", "c:/a", "waiting")]),
				mkView("c:/b", 3, [carrier("b1", "c:/b", "completed")]),
			]),
			{ now: NOW },
		);
		assert.deepEqual(out.attentionByRepo, { "c:/a": 1, "c:/b": 3 });
		assert.equal(Object.values(out.attentionByRepo).reduce((s, n) => s + n, 0), 4);
		assert.deepEqual(runIds(out), ["a1", "a2", "b1"]);
	});

	check("T4 大小写变体：归一键唯一且 === normalizeExactPath（R4 核心）", () => {
		// 走真实合并路径：projectGraph 的 normalizeRepoKey 把 C:/Foo 与 c:/foo 合并为同一 project 键。
		const s = projectGraph({
			journal: entries([dispatchEnv("r_upper"), dispatchEnv("r_lower")]),
			workstreams: [],
			tasks: [],
			runProjects: { [tabRunAddress("r_upper")]: "C:/Foo", [tabRunAddress("r_lower")]: "c:/foo" },
			runPhases: { [tabRunAddress("r_upper")]: "working", [tabRunAddress("r_lower")]: "waiting" },
			runCarriers: {
				[tabRunAddress("r_upper")]: { gate: "ok", needsHuman: false, staleOver: false, overdue: 0, pidAlive: null },
				[tabRunAddress("r_lower")]: { gate: "ok", needsHuman: false, staleOver: false, overdue: 0, pidAlive: null },
			},
			projectAttention: { "c:/foo": 2 },
		});
		assert.equal(s.projects.length, 1, "大小写变体在 graph 侧合并为单一 project");
		assert.equal(s.projects[0].project, "c:/foo");
		assert.equal(normalizeRepoKey("C:/Foo"), normalizeExactPath("C:/Foo"), "两 normalizer 逐字节同体（R4 前提）");
		const out = toFrontierInput(s, { now: NOW });
		assert.deepEqual(Object.keys(out.attentionByRepo), ["c:/foo"], "适配器只有一个归一键");
		assert.equal(Object.keys(out.attentionByRepo)[0], normalizeExactPath("C:/Foo"), "键逐字等于 v2 normalizeExactPath 口径");
		assert.equal(out.attentionByRepo["c:/foo"], 2);
		assert.deepEqual(out.details.map((d) => d.repoPath), ["c:/foo", "c:/foo"], "details 直接用已归一 project 键（零转换）");
	});

	// ═════════════════════════ T5–T7 ═════════════════════════
	check("T5 缺 carrier 不猜：gate=null 不进 details；pidAlive=null 合法保留", () => {
		const noCarrier = mkRef({ runId: "r_nc", project: "c:/a", phase: "working" }); // gate/needsHuman/... 全 null
		const nullPid = carrier("r_np", "c:/a", "waiting", { pidAlive: null });
		const out = toFrontierInput(mkSnap([mkView("c:/a", 0, [noCarrier, nullPid])]), { now: NOW });
		assert.deepEqual(runIds(out), ["r_np"], "journal-only run（缺 carrier）不进 details");
		assert.equal(out.details[0].pidAlive, null, "pidAlive=null 合法透传");
		assert.deepEqual(out.attentionByRepo, {}, "attention=0 不写键");
	});

	check("T6 history 恒空（MF1）+ 不产 hidden ②③ 触发", () => {
		const s = mkSnap([mkView("c:/a", 1, [carrier("r1", "c:/a", "working")])], { history: [{ id: "r_gone", reason: "terminal:completed" }] });
		const out = toFrontierInput(s, { now: NOW });
		assert.deepEqual(out.history, [], "输出恒 history===[]（不读 snap.history）");
		const prev = {
			asof: NOW - HOUR,
			projects: [{ project: "c:/a", state: "Working" as const, variant: null, gate: "ok" as const, runs: { r_gone: "working" }, needsUser: false, resultMissing: false, stagnation: false, overdue: 0, meaningfulStateVersion: 1 }],
			triggers: [],
			baseline: false,
		};
		const adapterRes = buildFrontier({ snapshot: out, backlog: [], prev, now: NOW });
		assert.equal(adapterRes.diff.triggers.some((t) => t.rule === "working_to_completed"), false, "适配器弃 history → 不产 ②");
		assert.equal(adapterRes.diff.triggers.some((t) => t.rule === "working_to_failed"), false, "适配器弃 history → 不产 ③");
		// 反例对照：若把 graph history 填进输入（适配器禁止）→ 会凭空造出 v2 生产从不产的 ②
		const filled = buildFrontier({ snapshot: { ...out, history: s.history }, backlog: [], prev, now: NOW });
		assert.equal(filled.diff.triggers.some((t) => t.rule === "working_to_completed"), true, "填 history 会新增行为（故恒空）");
		// 真实 fixture：graph 快照确有 hidden history，但适配器输出仍空
		assert.ok((gSnap.history ?? []).length >= 1, "fixture 有 hidden run → graph history 非空");
		assert.deepEqual(gOut.history, []);
	});

	check("T7 attention Σ 不变量：0 仓不写键，Σ === 各 project 正 attention 之和", () => {
		const s = mkSnap([
			mkView("c:/a", 0, [carrier("a1", "c:/a", "working")]),
			mkView("c:/b", 5, [carrier("b1", "c:/b", "waiting")]),
			mkView("c:/c", 2, [carrier("c1", "c:/c", "completed")]),
		]);
		const out = toFrontierInput(s, { now: NOW });
		assert.equal("c:/a" in out.attentionByRepo, false, "attention=0 不写键（缺项=0）");
		assert.equal(Object.values(out.attentionByRepo).reduce((x, n) => x + n, 0), 7);
	});

	// ═════════════════════════ T8–T9 ═════════════════════════
	check("T8 确定性与纯度：同输入 deepEqual + 源码守卫（零 IO / 无第三份 normalizer）", () => {
		const s = mkSnap([mkView("c:/a", 1, [carrier("a1", "c:/a", "working")]), mkView("c:/b", 0, [carrier("b1", "c:/b", "waiting")])]);
		assert.equal(JSON.stringify(toFrontierInput(s, { now: NOW })), JSON.stringify(toFrontierInput(s, { now: NOW })));
		const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "runtime/graph/frontier-input.ts"), "utf8");
		for (const bad of ["node:fs", "Date.now", "Math.random", "toLowerCase", "normalizeExactPath(", "normalizeRepoKey("]) {
			assert.equal(src.includes(bad), false, `frontier-input.ts 不得出现 ${bad}`);
		}
		const importLines = src.split("\n").filter((l) => l.trimStart().startsWith("import "));
		assert.ok(importLines.length > 0, "应有 type-only import");
		for (const l of importLines) assert.ok(l.includes("import type"), `frontier-input.ts 必须 type-only import（零运行时依赖）: ${l.trim()}`);
	});

	check("T9 结构等价 v2：buildFrontier(toFrontierInput) ≡ buildFrontier(collectGlobalView)（同 fixture）", () => {
		// 适配器注意力投影与 v2 逐字相等
		assert.deepEqual(gOut.attentionByRepo, v2Snap.attentionByRepo, "attentionByRepo 键/值逐字相等");
		// details 成员集 == v2 可见 tab 集
		assert.deepEqual([...new Set(runIds(gOut))].sort(), [...new Set(v2Snap.details.map((d) => d.runId))].sort(), "details 成员集 == v2 可见 tab 集");
		assert.equal(runIds(gOut).includes("r_hidden") || runIds(gOut).includes("r_term"), false, "hidden run 不进 details");
		// 帧0（baseline）：严格 JSON 全等（details 同序后连 runs 键序也一致）
		const g0 = buildFrontier({ snapshot: gOut, backlog: [], prev: null, now: NOW });
		const v0 = buildFrontier({ snapshot: v2Sorted, backlog: [], prev: null, now: NOW });
		assert.equal(JSON.stringify(g0), JSON.stringify(v0), "帧0 严格 JSON 全等");
		// 帧1（同 prev）：canonical 全等 + 带 backlog 触发
		const backlog = [{ recipient: "agent__master_default", pending: 1, claimed: 0 }];
		const g1 = buildFrontier({ snapshot: gOut, backlog, prev: g0.next, now: NOW + 60_000 });
		const v1 = buildFrontier({ snapshot: v2Sorted, backlog, prev: g0.next, now: NOW + 60_000 });
		assert.equal(canonicalJson(g1), canonicalJson(v1), "帧1 canonical JSON 全等");
		assert.equal(g1.diff.triggers.length, v1.diff.triggers.length);
		console.log(`  T9 dump: attentionKeys=${JSON.stringify(Object.keys(gOut.attentionByRepo))} details=${JSON.stringify(runIds(gOut))} v2details=${JSON.stringify([...new Set(v2Snap.details.map((d) => d.runId))].sort())} strictFrame0=${JSON.stringify(g0) === JSON.stringify(v0)}`);
	});

	// ═════════════════════════ T10–T14 ═════════════════════════
	check("T10 未知事件前向兼容：不抛、形状不变", () => {
		const unknown = newEventEnvelope({ type: "project.priority_changed", source: masterAddress(), at: iso(NOW) });
		const s = projectGraph({ journal: entries([dispatchEnv("tab_u"), unknown]), workstreams: [], tasks: [] });
		assert.deepEqual(s.skipped.unknownEventTypes, ["project.priority_changed"]);
		const out = toFrontierInput(s, { now: NOW });
		assert.deepEqual(Object.keys(out).sort(), ["attentionByRepo", "details", "history"]);
	});

	check("T11 now 透传：next.asof === opts.now；snap.asof 提供也不采纳", () => {
		const s = mkSnap([mkView("c:/a", 0, [carrier("a1", "c:/a", "working")])], { asof: 111 });
		const out = toFrontierInput(s, { now: NOW });
		assert.equal("asof" in out, false, "适配器输出不含 asof（不被 snap.asof 污染）");
		const { next } = buildFrontier({ snapshot: out, backlog: [], prev: null, now: NOW });
		assert.equal(next.asof, NOW);
		assert.notEqual(next.asof, 111);
	});

	check("T12 顺序：details 按 runId 升序；canonical 对比下 runs 键序不影响判定", () => {
		const runs = [carrier("zz", "c:/a", "working"), carrier("aa", "c:/a", "waiting"), carrier("mm", "c:/b", "completed")];
		const out = toFrontierInput(mkSnap([mkView("c:/b", 0, [runs[2]!]), mkView("c:/a", 1, [runs[0]!, runs[1]!])]), { now: NOW });
		assert.deepEqual(runIds(out), ["aa", "mm", "zz"], "按 runId 升序（确定性）");
		const rev = { ...out, details: [...out.details].reverse() };
		assert.equal(
			canonicalJson(buildFrontier({ snapshot: out, backlog: [], prev: null, now: NOW })),
			canonicalJson(buildFrontier({ snapshot: rev, backlog: [], prev: null, now: NOW })),
			"canonical 比较下 runs 键序无关",
		);
	});

	check("T13 record-only 前向：输出无 ④⑥⑧ 字段；diff.recordOnly 逐字等于 RECORD_ONLY_NOCARRIER", () => {
		const out = toFrontierInput(mkSnap([mkView("c:/a", 1, [carrier("a1", "c:/a", "working")])]), { now: NOW });
		assert.deepEqual(Object.keys(out).sort(), ["attentionByRepo", "details", "history"]);
		assert.equal(out.details.some((d) => "needs_global" in d || "risk" in d || "expected_event" in d), false);
		const { diff } = buildFrontier({ snapshot: out, backlog: [], prev: null, now: NOW });
		assert.deepEqual(diff.recordOnly, RECORD_ONLY_NOCARRIER);
	});

	check("T14 details 成员过滤：project/phase===null 跳过；混合 fixture 成员集 == v2 可见集", () => {
		const noProj = carrier("r_p0", "c:/a", "working", { project: null });
		const noPhase = { ...carrier("r_h0", "c:/a", "working"), phase: null };
		const ok = carrier("r_ok", "c:/a", "working");
		const out = toFrontierInput(mkSnap([mkView("c:/a", 0, [noProj, noPhase, ok])]), { now: NOW });
		assert.deepEqual(runIds(out), ["r_ok"], "project/phase null → 跳过");
		assert.deepEqual([...new Set(runIds(gOut))].sort(), [...new Set(v2Snap.details.map((d) => d.runId))].sort());
	});

	assert.equal(passed, 14, `应跑满 14 组，实际 ${passed}`);
	console.log(`_test_graph_frontier_input: ${passed}/14 组通过`);
} finally {
	rmSync(ROOT, { recursive: true, force: true });
	rmSync(ENV_TMP, { recursive: true, force: true });
}
