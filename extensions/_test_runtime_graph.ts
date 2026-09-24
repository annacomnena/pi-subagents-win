/**
 * _test_runtime_graph.ts — E1 只读关系面 MVP 测试（13 组）
 *
 * 计划：plans/0924_graph_E1_impl_plan.md §6；L1 校准：plans/0924_graph_E1_recon.md。
 * 覆盖：空输入 / 单对象 / 引用式边三来源 / 孤儿引用 / dedupe 幂等 / 乱序 terminal 不回退 /
 *       diff 边界 / 确定性与路径口径 tripwire / 10k 性能 / 未知事件前向兼容 /
 *       workspaceRef 弱载体 / 坏行与 seq 空洞 / replay 等价 + collect 装配。
 *
 * 运行：timeout 300 node --experimental-strip-types ./extensions/_test_runtime_graph.ts
 * 隔离：import 前设 PI_RUNTIME_DIR / PI_TAB_RUNS_DIR 到临时目录（同 _test_runtime_snapshot 先例）。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const ENV_DIR = mkdtempSync(join(tmpdir(), "runtime-graph-env-"));
const TAB_DIR = mkdtempSync(join(tmpdir(), "runtime-graph-tabs-"));
process.env.PI_RUNTIME_DIR = ENV_DIR;
process.env.PI_TAB_RUNS_DIR = TAB_DIR;

import { masterAddress, tabRunAddress } from "./runtime/address.ts";
import type { RuntimeEnvelope } from "./runtime/envelope.ts";
import { newEventEnvelope } from "./runtime/envelope.ts";
import { scanJournalSeq, type JournalSeqEntry } from "./runtime/journal-seq.ts";
import { rebuildFromEnvelopes } from "./runtime/projector.ts";
import { normalizeExactPath } from "./runtime/recent-scopes.ts";
import { replayEquivalenceDiff } from "./runtime/state-store.ts";
import { writeTabDispatch } from "./tab-runs.ts";
import { collectGraphInput, readGraphSnapshot } from "./runtime/graph/collect.ts";
import { diffGraph } from "./runtime/graph/diff.ts";
import { isPathShapedRef, normalizeRepoKey, projectGraph } from "./runtime/graph/project.ts";
import type { GraphInput, GraphNode } from "./runtime/graph/types.ts";

// ── 辅助 ───────────────────────────────────────────────────────────

const iso = (n: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();

function dispatchEnv(tab: string, atN: number, extra: { externalTaskId?: string } = {}): RuntimeEnvelope {
	const subject = tabRunAddress(tab);
	const at = iso(atN);
	return newEventEnvelope({
		type: "run.dispatched",
		source: masterAddress(),
		subject,
		at,
		dedupeKey: `run.dispatched:${subject}`,
		payload: { tabRunId: tab, executionKind: "tab", externalTaskId: extra.externalTaskId ?? "9001", mode: "workflow", title: `t-${tab}`, cwd: "C:/repo", dispatchedAt: at },
	});
}

function terminalEnv(tab: string, status: "completed" | "failed" | "cancelled", atN: number, externalTaskId = "9001"): RuntimeEnvelope {
	const subject = tabRunAddress(tab);
	const at = iso(atN);
	return newEventEnvelope({
		type: `run.${status}`,
		source: masterAddress(),
		subject,
		at,
		dedupeKey: `run.${status}:${subject}`,
		payload: { tabRunId: tab, status, externalTaskId, finishedAt: at },
	});
}

function entriesOf(envs: RuntimeEnvelope[]): JournalSeqEntry[] {
	return envs.map((envelope, i) => ({ seq: i + 1, envelope }));
}

function gi(partial: Partial<GraphInput> = {}): GraphInput {
	return { journal: [], workstreams: [], tasks: [], ...partial };
}

const runNodes = (nodes: GraphNode[]): GraphNode[] => nodes.filter((n) => n.kind === "run");

let passed = 0;
function check(name: string, fn: () => void): void {
	fn();
	passed += 1;
	console.log(`  ok ${name}`);
}

// ── 13 组 ──────────────────────────────────────────────────────────

try {
	check("T1 空输入", () => {
		const s = projectGraph(gi({ masters: [] }));
		assert.deepEqual(s.nodes, []);
		assert.deepEqual(s.edges, []);
		assert.deepEqual(s.projects, []);
		assert.equal(s.headSeq, 0);
		assert.equal(s.version, 1);
		assert.deepEqual(s.skipped, { badLines: 0, unknownEventTypes: [] });
		// 缺省 masters = [master_default]（plan §3）：恰一个 master 节点、无边
		const sDefault = projectGraph(gi());
		assert.equal(sDefault.nodes.filter((n) => n.kind === "master").length, 1);
		assert.equal(sDefault.edges.length, 0);
	});

	check("T2 单对象（run.dispatched）", () => {
		const s = projectGraph(gi({ journal: entriesOf([dispatchEnv("tab_a", 1)]) }));
		const runs = runNodes(s.nodes);
		assert.equal(runs.length, 1);
		assert.equal(runs[0].id, tabRunAddress("tab_a"));
		assert.equal(runs[0].status, "dispatched");
		assert.equal(runs[0].firstSeq, 1);
		assert.equal(runs[0].lastSeq, 1);
	});

	check("T3 边派生三来源 + run_subject", () => {
		const ws = { id: "ws_1", mission: "m1", status: "active" as const, taskSelector: { runSubjects: [tabRunAddress("tab_a")] } };
		const task = { id: "task_1", workstreamId: "ws_1", externalTaskId: "9001", objective: "o1", status: "pending" as const };
		const s = projectGraph(gi({ journal: entriesOf([dispatchEnv("tab_a", 1)]), workstreams: [ws], tasks: [task] }));
		const find = (kind: string, from: string, to: string) => s.edges.find((e) => e.kind === kind && e.from === from && e.to === to);
		const e1 = find("task_workstream", "task_1", "ws_1");
		assert.ok(e1, "task→workstream 应有边");
		assert.match(e1.evidence, /workstreamId/);
		const e2 = find("run_task", tabRunAddress("tab_a"), "task_1");
		assert.ok(e2, "run→externalTaskId 应有边");
		assert.match(e2.evidence, /externalTaskId/);
		const e3 = find("run_workstream", tabRunAddress("tab_a"), "ws_1");
		assert.ok(e3, "run→workstream 应有边");
		assert.equal(e3.match, "runSubject");
		const e4 = find("run_subject", tabRunAddress("tab_a"), tabRunAddress("tab_a"));
		assert.ok(e4, "run→subject 应有身份边");
		// externalTaskIds label 匹配（best-effort 标注）
		const ws2 = { id: "ws_2", mission: "m2", status: "active" as const, taskSelector: { externalTaskIds: ["7777"] } };
		const s2 = projectGraph(gi({ journal: entriesOf([dispatchEnv("tab_b", 1, { externalTaskId: "7777" })]), workstreams: [ws2] }));
		const e5 = s2.edges.find((e) => e.kind === "run_workstream");
		assert.ok(e5);
		assert.equal(e5.match, "externalTaskId");
	});

	check("T4 孤儿引用不产边不抛", () => {
		const task = { id: "task_x", workstreamId: "ws_missing", objective: "o", status: "pending" as const };
		const s = projectGraph(gi({ tasks: [task] }));
		assert.equal(s.edges.filter((e) => e.kind === "task_workstream").length, 0);
		assert.doesNotThrow(() => JSON.stringify(s));
		const round = JSON.parse(JSON.stringify(s)) as { nodes: GraphNode[] };
		assert.ok(round.nodes.some((n) => n.id === "task_x"));
	});

	check("T5 重复事件幂等（dedupeKey）", () => {
		const env = dispatchEnv("tab_d", 1);
		const once = projectGraph(gi({ journal: entriesOf([env]) }));
		const twice = projectGraph(gi({ journal: entriesOf([env, env]) }));
		assert.equal(JSON.stringify(twice), JSON.stringify(once));
	});

	check("T6 乱序 seq：terminal 优先不回退", () => {
		const outOfOrder = projectGraph(gi({ journal: entriesOf([terminalEnv("tab_o", "completed", 1), dispatchEnv("tab_o", 2)]) }));
		assert.equal(runNodes(outOfOrder.nodes)[0].status, "completed");
		const inOrder = projectGraph(gi({ journal: entriesOf([dispatchEnv("tab_o2", 1), terminalEnv("tab_o2", "completed", 2)]) }));
		assert.equal(runNodes(inOrder.nodes)[0].status, "completed");
		const subject = tabRunAddress("tab_o3");
		const redispatch = newEventEnvelope({
			type: "run.dispatched",
			source: masterAddress(),
			subject,
			at: iso(3),
			dedupeKey: `run.dispatched:${subject}:retry`,
			payload: { tabRunId: "tab_o3", executionKind: "tab", externalTaskId: "9001", dispatchedAt: iso(3) },
		});
		const noRegress = projectGraph(gi({ journal: entriesOf([dispatchEnv("tab_o3", 1), terminalEnv("tab_o3", "failed", 2), redispatch]) }));
		assert.equal(runNodes(noRegress.nodes)[0].status, "failed");
	});

	check("T7 diff 边界", () => {
		const base = projectGraph(gi({ journal: entriesOf([dispatchEnv("tab_d", 1)]) }));
		const baseline = diffGraph(null, base, 0);
		assert.equal(baseline.addedNodes.length, base.nodes.length);
		assert.equal(baseline.addedEdges.length, base.edges.length);
		assert.deepEqual(baseline.removedNodes, []);
		const empty = diffGraph(base, base, base.headSeq);
		assert.deepEqual(empty.addedNodes, []);
		assert.deepEqual(empty.removedNodes, []);
		assert.deepEqual(empty.changedNodes, []);
		assert.deepEqual(empty.addedEdges, []);
		assert.deepEqual(empty.removedEdges, []);
		const next = projectGraph(gi({ journal: entriesOf([dispatchEnv("tab_d", 1), terminalEnv("tab_d", "completed", 2)]) }));
		const d = diffGraph(base, next, base.headSeq);
		assert.equal(d.addedNodes.length, 0);
		assert.equal(d.changedNodes.length, 1);
		assert.equal(d.changedNodes[0].id, tabRunAddress("tab_d"));
		assert.equal(diffGraph(base, next, 0).changedNodes.length, 1);
	});

	check("T8 确定性 + 路径口径 tripwire", () => {
		const input = gi({
			journal: entriesOf([dispatchEnv("tab_d", 1)]),
			workstreams: [{ id: "ws_1", mission: "m", status: "active", workspaceRef: "C:\\Repo\\Proj\\" }],
			tasks: [{ id: "task_1", workstreamId: "ws_1", externalTaskId: "9001", objective: "o", status: "pending" }],
		});
		assert.equal(JSON.stringify(projectGraph(input)), JSON.stringify(projectGraph(input)));
		const s = projectGraph(input);
		const ids = s.nodes.map((n) => n.id);
		assert.deepEqual(ids, [...ids].sort());
		const edgeKeys = s.edges.map((e) => `${e.kind}|${e.from}|${e.to}`);
		assert.deepEqual(edgeKeys, [...edgeKeys].sort());
		const projects = s.projects.map((p) => p.project);
		assert.deepEqual(projects, [...projects].sort());
		// normalizeRepoKey 与 recent-scopes 权威口径逐例一致（双写 tripwire；不断言 autonomy 副本）
		for (const p of ["C:\\Repo\\Sub\\", "c:/repo", "D:\\a\\b\\\\", "/home/x/", "C:/A-B/C", "C:\\Repo"]) {
			assert.equal(normalizeRepoKey(p), normalizeExactPath(p), p);
		}
		assert.equal(normalizeRepoKey("C:\\Repo\\Sub\\"), "c:/repo/sub");
		assert.ok(isPathShapedRef("C:\\repo"));
		assert.ok(isPathShapedRef("/home/x"));
		assert.ok(!isPathShapedRef("agent://x"));
		assert.ok(!isPathShapedRef(""));
		assert.ok(!isPathShapedRef(undefined));
	});

	check("T9 大 journal 性能上限", () => {
		const envs: RuntimeEnvelope[] = [];
		for (let i = 0; i < 5000; i += 1) {
			envs.push(dispatchEnv(`perf_${i}`, 0, { externalTaskId: `e${i}` }));
			envs.push(terminalEnv(`perf_${i}`, "completed", 1, `e${i}`));
		}
		const journal = entriesOf(envs);
		const t0 = performance.now();
		const s = projectGraph(gi({ journal }));
		const elapsed = performance.now() - t0;
		assert.ok(elapsed < 2000, `T9 projectGraph 10_000 事件耗时 ${elapsed.toFixed(1)}ms 超 2000ms 预算`);
		assert.equal(runNodes(s.nodes).length, 5000);
		assert.ok(runNodes(s.nodes).every((n) => n.status === "completed"));
		console.log(`  T9 实测：10_000 事件 projectGraph ${elapsed.toFixed(1)}ms`);
	});

	check("T10 前向兼容未知事件", () => {
		const unknown1 = newEventEnvelope({ type: "project.priority_changed", source: masterAddress(), subject: tabRunAddress("tab_u"), at: iso(1), payload: {} });
		const unknown2 = newEventEnvelope({ type: "totally_unknown", source: masterAddress(), subject: tabRunAddress("tab_u"), at: iso(2), payload: {} });
		const s = projectGraph(gi({ journal: entriesOf([unknown1, unknown2, dispatchEnv("tab_u", 3)]) }));
		assert.deepEqual(s.skipped.unknownEventTypes, ["project.priority_changed", "totally_unknown"]);
		assert.equal(runNodes(s.nodes).length, 1);
	});

	check("T11 workspaceRef 弱载体", () => {
		const missing = projectGraph(gi({ workstreams: [{ id: "ws_n", mission: "m", status: "active" }] }));
		assert.equal(missing.edges.filter((e) => e.kind === "workstream_project").length, 0);
		const logical = projectGraph(gi({ workstreams: [{ id: "ws_l", mission: "m", status: "active", workspaceRef: "agent://x" }] }));
		assert.equal(logical.edges.filter((e) => e.kind === "workstream_project").length, 0);
		const path = projectGraph(gi({ workstreams: [{ id: "ws_p", mission: "m", status: "active", workspaceRef: "C:\\Repo\\Proj\\" }] }));
		const e = path.edges.find((x) => x.kind === "workstream_project");
		assert.ok(e);
		assert.equal(e.to, "project:c:/repo/proj");
		assert.ok(path.nodes.some((n) => n.id === "project:c:/repo/proj" && n.kind === "project"));
	});

	check("T12 seq 空洞 / 坏行（只读不改写）", () => {
		const dir = mkdtempSync(join(tmpdir(), "runtime-graph-journal-"));
		try {
			const p = join(dir, "events.jsonl");
			writeFileSync(p, `${JSON.stringify(dispatchEnv("tab_j", 1))}\n{ broken json\n\n${JSON.stringify(terminalEnv("tab_j", "completed", 2))}\n`, "utf8");
			const before = readFileSync(p, "utf8");
			const scan = scanJournalSeq(p);
			assert.equal(scan.skippedBadLines, 1);
			assert.equal(scan.head, 4); // 行号：good=1 / bad=2 / 空行=3 / good=4
			const s = projectGraph({ journal: scan.entries, headSeq: scan.head, badLines: scan.skippedBadLines, workstreams: [], tasks: [] });
			assert.equal(s.headSeq, 4);
			assert.equal(s.skipped.badLines, 1);
			assert.equal(runNodes(s.nodes)[0].status, "completed");
			assert.equal(readFileSync(p, "utf8"), before, "Graph 只读：不改写 journal");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	check("T13 replay 等价交叉 + collect 装配", () => {
		const dir = mkdtempSync(join(tmpdir(), "runtime-graph-replay-"));
		try {
			const p = join(dir, "events.jsonl");
			writeFileSync(p, `${[dispatchEnv("tab_r", 1), terminalEnv("tab_r", "completed", 2)].map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
			const scan = scanJournalSeq(p);
			const first = projectGraph({ journal: scan.entries, headSeq: scan.head, logEpoch: scan.logEpoch, workstreams: [], tasks: [] });
			const second = projectGraph({ journal: scan.entries, headSeq: scan.head, logEpoch: scan.logEpoch, workstreams: [], tasks: [] });
			assert.equal(JSON.stringify(first), JSON.stringify(second));
			// 与 projector 权威投影逐 run 状态一致
			const projected = [...rebuildFromEnvelopes(scan.entries.map((e) => e.envelope)).state.runs.values()];
			assert.equal(projected.length, 1);
			for (const pr of projected) {
				const node = first.nodes.find((n) => n.id === pr.subject);
				assert.ok(node);
				assert.equal(node.status, pr.status);
			}
			assert.deepEqual(replayEquivalenceDiff(p), []);

			// collect IO 装配：journal + 显式库
			const stateDir = join(dir, "state");
			mkdirSync(stateDir, { recursive: true });
			const emptyTabs = join(dir, "tab-runs-empty");
			const ci = collectGraphInput({ journalPath: p, stateDir, tabRunsDir: emptyTabs });
			assert.equal(ci.headSeq, scan.head);
			assert.equal(projectGraph(ci).nodes.find((n) => n.kind === "run")!.status, "completed");
			assert.deepEqual(readGraphSnapshot({ journalPath: p, tabRunsDir: emptyTabs }), projectGraph(collectGraphInput({ journalPath: p, tabRunsDir: emptyTabs })));

			// collect 的 tab-runs 只读引用：phase 原样引用 + repoRoot 归一化
			const repoDir = join(dir, "repo");
			mkdirSync(join(repoDir, ".git"), { recursive: true });
			const p2 = join(dir, "events2.jsonl");
			writeFileSync(p2, `${JSON.stringify(dispatchEnv("tab_c", 1))}\n`, "utf8");
			const tabDir = join(dir, "tab-runs");
			mkdirSync(tabDir, { recursive: true });
			writeTabDispatch(tabDir, { id: "tab_c", version: 1, taskId: "9001", mode: "workflow", title: "t", cwd: join(repoDir, "sub"), dispatchedAt: iso(1), dispatchStatus: "dispatched" });
			const ci2 = collectGraphInput({ journalPath: p2, stateDir, tabRunsDir: tabDir });
			const phase = ci2.runPhases![tabRunAddress("tab_c")];
			assert.ok(typeof phase === "string" && phase.length > 0);
			const node2 = projectGraph(ci2).nodes.find((n) => n.kind === "run")!;
			assert.equal(node2.attrs.phase, phase);
			assert.equal(node2.attrs.project, normalizeRepoKey(repoDir));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	assert.equal(passed, 13, `应跑满 13 组，实际 ${passed}`);
	console.log("_test_runtime_graph: 13/13 组通过");
} finally {
	rmSync(ENV_DIR, { recursive: true, force: true });
	rmSync(TAB_DIR, { recursive: true, force: true });
}
