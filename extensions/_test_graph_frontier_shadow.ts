/**
 * _test_graph_frontier_shadow.ts — E2.2 影子对照 harness（O-B 行）· G-B 核心验收件
 *
 * 计划：plans/0924_graph_E2_2_impl_plan.md §3（harness 设计/确切签名/两路装配）/§4（用例 S1–S17）/
 *       §5（硬门）/§6（零行为）；L1：plans/0924_graph_E2_2_recon.md §1（装配对齐）/§2（O-B schema）/
 *       §3（白名单=空）/§5（R7）/§7（规模四档）。
 *
 * 命题：同一 fixture、同一 (backlog, prev, now) 下，v2 生产路径
 *   collectGlobalView → buildFrontier
 * 与 graph 路径
 *   readGraphSnapshot → toFrontierInput → buildFrontier
 * 的 next/diff **逐项等价**；O-B 影子行 `unexplained=0` 且 `explained=0`（WHITELIST = []，L1 §3：
 * G-A 后 v2 已消费全量 attention，任何差异都是真差异，不得记为 explained）。
 *
 * 唯一自变量 = snapshot 载体；backlog/prev/now 单次构造后两路共享（L1 §1.3 逐参数对齐表）。
 * 禁用 `collectGlobalView({history:true})`（v2 生产恒 `history≡[]`，MF1；填了会造出 v2 从不产的 ②③）。
 *
 * 零行为（§6）：测试态——临时 PI_RUNTIME_DIR/PI_TAB_RUNS_DIR + 显式 stateDir；
 *   影子行只写 `<tmp>/state/work-graph/shadow.jsonl`；不注册、不被生产 import；不碰 protocol/index/collect.ts。
 *
 * A10.1：本文件 import `./runtime/autonomy/{frontier,collect}.ts` 字面量 → `_test_runtime_autonomy.ts`
 *   排除列表 +1 行（ALLOW 不动）。
 *
 * 运行（EB-004 外部超时）：
 *   timeout 300 node --experimental-strip-types ./extensions/_test_graph_frontier_shadow.ts   → exit 0，打印 unexplained=0 explained=0
 *
 * 可选反向自检（判别力复验，缺省关闭）：
 *   E22_REVERSE_SELFTEST=1 timeout 300 node --experimental-strip-types ./extensions/_test_graph_frontier_shadow.ts
 *     → 额外跑 S-R：把 graph-only `attentionByRepo[首个正键]:=0`，断言 O-B 必报 `unexplained>0`；
 *       判别力有效时该自检通过（进程仍 exit 0），失效则 FAIL。
 *   L4 全 harness 级等价实验（照 0924_graph_E2_2_l4_review.md 原文，未改仓库）：在 frame() 的 graph 装配后注入
 *     `const corruptKey = Object.keys(gIn.attentionByRepo)[0]; if (corruptKey) gIn.attentionByRepo[corruptKey] = 0;`
 *     → 预期 exit=1、S2/S3/S4/S6/S11/S12/S13/S16/S17 失败、`unexplained=15 explained=0`。
 */

import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 测试隔离（照 `_test_graph_frontier_input.ts#L23-L25` 先例）：任何 defaultRuntimeDir() 落 temp；
// 每个 world 另有自己的 envDir（mailbox 隔离），frame() 内切换。
const ENV_TMP = mkdtempSync(join(tmpdir(), "e22-frontier-shadow-env-"));
process.env.PI_RUNTIME_DIR = ENV_TMP;
process.env.PI_TAB_RUNS_DIR = join(ENV_TMP, "tab-runs");

import { masterAddress, tabRunAddress } from "./runtime/address.ts";
import { sessionBucketForCwd } from "./tab-runs.ts";
import { newEventEnvelope, type RuntimeEnvelope } from "./runtime/envelope.ts";
import { collectGlobalView, type GlobalViewSnapshot } from "./runtime/global-view.ts";
import { mailboxBacklog } from "./runtime/mailbox.ts";
import { readGraphSnapshot } from "./runtime/graph/collect.ts";
import { toFrontierInput } from "./runtime/graph/frontier-input.ts";
import type { GraphSnapshot } from "./runtime/graph/types.ts";
import {
	buildFrontier,
	normalizeExactPath,
	RECORD_ONLY_NOCARRIER,
	type FrontierDiff,
	type FrontierSnapshot,
	type FrontierSourceSnapshot,
	type FrontierSourceTab,
} from "./runtime/autonomy/frontier.ts";
import { readFrontierSnapshot } from "./runtime/autonomy/collect.ts";

const NOW = Date.parse("2026-09-24T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 3600_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const writeJson = (p: string, o: unknown): void => writeFileSync(p, JSON.stringify(o), "utf8");
const rmSafe = (p: string): void => { try { unlinkSync(p); } catch { /* 缺失即满意 */ } };

const GATE_OK = "# r\n\n## Active Tasks\n\n### Task Index\n\n| Item | Priority | Summary |\n| R1 | P0 | d |\n";
const GATE_AWAIT = `${GATE_OK}\n**Status**：waiting\n`;

let passed = 0;
const failures: string[] = [];
function check(name: string, fn: () => void): void {
	try {
		fn();
		passed += 1;
		console.log(`  ok   ${name}`);
	} catch (e) {
		failures.push(name);
		console.error(`  FAIL ${name}\n       ${e instanceof Error ? e.message : String(e)}`);
	}
}

// ═══════════════════════ O-B schema + 判定（纯函数）═══════════════════════

interface ShadowRow {
	at: number;
	scope: string;
	itemKind: "snapshot" | "project" | "run" | "trigger" | "recordOnly";
	nodeId: string;
	v2Value: unknown;
	graphValue: unknown;
	verdict: "same" | "explained" | "unexplained";
	reason?: string;
}

/** §3.1 最小签名 `{next,diff}` + §3.2 源 3（run 行根因定位）所需的输入 details（可选，缺省不产 run 行）。 */
interface ShadowSide {
	next: FrontierSnapshot;
	diff: FrontierDiff;
	details?: readonly FrontierSourceTab[];
}

interface WhitelistEntry {
	id: string;
	match: (itemKind: string, nodeId: string, v2Value: unknown, graphValue: unknown) => boolean;
}

/**
 * `explained` 白名单 = **空集**（L1 §3 判定）：G-A 后 v2 ⑤ 已消费全量 attention，
 * `graph-attention-superset` 类差异归零 → 删除全部条目。任何差异都是 `unexplained`。
 * 硬门同时卡 `explained===0`：若有人塞入未批准条目会即时报警（§5.2）。
 */
const WHITELIST: WhitelistEntry[] = [];

const MAX_DIFF_PATHS = 8;

/** 语义数组键：triggers 按 `rule|project|evidence`、details 按 `runId|repoPath`；其它数组保序。 */
function semanticArrayKey(arr: unknown[]): ((e: unknown) => string) | null {
	if (arr.length === 0) return null;
	const isTrigger = arr.every((e) => !!e && typeof e === "object" && "rule" in e && "project" in e && "evidence" in e);
	if (isTrigger) return (e) => { const o = e as { rule: string; project: string; evidence: string }; return `${o.rule}|${o.project}|${o.evidence}`; };
	const isRun = arr.every((e) => !!e && typeof e === "object" && "runId" in e);
	if (isRun) return (e) => { const o = e as { runId: string; repoPath?: string }; return `${o.runId}|${o.repoPath ?? ""}`; };
	return null;
}

/** canonical：对象键递归排序（`runs` 键序消解）；数组按语义键排序（下标序不参与，L1 §2.3）。 */
function deepSort(v: unknown): unknown {
	if (Array.isArray(v)) {
		const arr = v.map(deepSort);
		const key = semanticArrayKey(arr);
		if (key) arr.sort((a, b) => { const ka = key(a); const kb = key(b); return ka < kb ? -1 : ka > kb ? 1 : 0; });
		return arr;
	}
	if (v && typeof v === "object") {
		const o = v as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const k of Object.keys(o).sort()) out[k] = deepSort(o[k]);
		return out;
	}
	return v;
}

function canonicalJson(v: unknown): string {
	const s = JSON.stringify(deepSort(v));
	return s === undefined ? "«undefined»" : s;
}

/** 递归收集差异 JSON 路径（≤8 条截断），保证 unexplained 可归因（§2.2）。 */
function fieldDiffPaths(a: unknown, b: unknown, path = "", out: string[] = []): string[] {
	if (out.length >= MAX_DIFF_PATHS) return out;
	if (canonicalJson(a) === canonicalJson(b)) return out;
	const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
	if (isObj(a) && isObj(b)) {
		for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
			fieldDiffPaths(a[k], b[k], path ? `${path}.${k}` : k, out);
			if (out.length >= MAX_DIFF_PATHS) break;
		}
		return out;
	}
	if (Array.isArray(a) && Array.isArray(b)) {
		for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
			fieldDiffPaths(a[i], b[i], `${path}[${i}]`, out);
			if (out.length >= MAX_DIFF_PATHS) break;
		}
		return out;
	}
	out.push(path || "(root)");
	return out;
}

const unionSorted = (a: Iterable<string>, b: Iterable<string>): string[] => [...new Set([...a, ...b])].sort();
const triggerKey = (t: { rule: string; project: string; evidence: string }): string => `${t.rule}|${t.project}|${t.evidence}`;
const runKey = (d: FrontierSourceTab): string => `${normalizeExactPath(d.repoPath)}::${d.runId}`;
const carrier7 = (d: FrontierSourceTab): Record<string, unknown> => ({
	repoPath: normalizeExactPath(d.repoPath),
	phase: d.phase,
	needsHuman: d.needsHuman,
	gate: d.gate,
	staleOver: d.staleOver,
	overdue: d.overdue,
	pidAlive: d.pidAlive,
});
const triggerValue = (t: { rule: string; project: string; evidence: string; approximate: boolean }): Record<string, unknown> => ({
	rule: t.rule, project: t.project, evidence: t.evidence, approximate: t.approximate,
});

/**
 * 按语义键分组为**数组**（不折叠重复项，L4 建议修 1）：同键多值以 canonical 序排列，
 * 使 O-B 单行保留 multiplicity——原 `Map` 会把同键重复 trigger 静默折叠、丢根因信息。
 */
function groupByKey<T>(items: readonly T[], key: (t: T) => string, project: (t: T) => unknown): Map<string, unknown[]> {
	const buckets = new Map<string, T[]>();
	for (const it of items) {
		const k = key(it);
		const arr = buckets.get(k);
		if (arr) arr.push(it);
		else buckets.set(k, [it]);
	}
	const out = new Map<string, unknown[]>();
	for (const [k, arr] of buckets) {
		out.set(k, arr.map(project).sort((a, b) => {
			const ja = canonicalJson(a);
			const jb = canonicalJson(b);
			return ja < jb ? -1 : ja > jb ? 1 : 0;
		}));
	}
	return out;
}

/**
 * §3.2 纯函数：对同一帧的两路 (next,diff) + 输入 details 逐 source 展开 O-B 行。
 * 五源：snapshot(baseline/asof) / project(含 msv) / run(carrier 七字段) / trigger / recordOnly。
 * 不 IO、不改输入；`verdict` 机器判定（same/explained/unexplained），`reason` 仅白名单 id 或字段路径。
 */
function shadowCompare(v2: ShadowSide, graph: ShadowSide, ctx: { at: number; scope: string }): ShadowRow[] {
	const rows: ShadowRow[] = [];
	const add = (itemKind: ShadowRow["itemKind"], nodeId: string, v2Value: unknown, graphValue: unknown): void => {
		let verdict: ShadowRow["verdict"] = "same";
		let reason: string | undefined;
		if (canonicalJson(v2Value) !== canonicalJson(graphValue)) {
			const hit = WHITELIST.find((wl) => wl.match(itemKind, nodeId, v2Value, graphValue));
			if (hit) { verdict = "explained"; reason = hit.id; }
			else { verdict = "unexplained"; reason = fieldDiffPaths(v2Value, graphValue).join(" | ") || "(root)"; }
		}
		rows.push({ at: ctx.at, scope: ctx.scope, itemKind, nodeId, v2Value, graphValue, verdict, ...(reason === undefined ? {} : { reason }) });
	};

	// 源 1：顶层标量（snapshot，O-B 加性 itemKind）
	add("snapshot", "baseline", v2.next.baseline, graph.next.baseline);
	add("snapshot", "asof", v2.next.asof, graph.next.asof);

	// 源 2：project 行（msv 折入本行）
	const v2Projects = new Map(v2.next.projects.map((p) => [p.project, p]));
	const gProjects = new Map(graph.next.projects.map((p) => [p.project, p]));
	for (const k of unionSorted(v2Projects.keys(), gProjects.keys())) add("project", k, v2Projects.get(k), gProjects.get(k));

	// 源 3：run 行（carrier 七字段；根因定位）
	const v2Runs = new Map((v2.details ?? []).map((d) => [runKey(d), carrier7(d)]));
	const gRuns = new Map((graph.details ?? []).map((d) => [runKey(d), carrier7(d)]));
	for (const k of unionSorted(v2Runs.keys(), gRuns.keys())) add("run", k, v2Runs.get(k), gRuns.get(k));

	// 源 4：trigger 行（语义键 `rule|project|evidence`；数组保重复，不折叠 multiplicity）
	const v2Triggers = groupByKey(v2.diff.triggers, triggerKey, triggerValue);
	const gTriggers = groupByKey(graph.diff.triggers, triggerKey, triggerValue);
	for (const k of unionSorted(v2Triggers.keys(), gTriggers.keys())) add("trigger", k, v2Triggers.get(k), gTriggers.get(k));

	// 源 5：recordOnly 行（存在性）
	const v2Record = new Set(v2.diff.recordOnly);
	const gRecord = new Set(graph.diff.recordOnly);
	for (const k of unionSorted(v2Record.values(), gRecord.values())) add("recordOnly", k, v2Record.has(k) ? true : undefined, gRecord.has(k) ? true : undefined);

	return rows;
}

/** 写 O-B 行到 `<stateDir>/work-graph/shadow.jsonl`（appendFileSync + never-throw；非生产 runtimeDir）。 */
function writeShadowJsonl(rows: ShadowRow[], stateDir: string): void {
	try {
		const dir = join(stateDir, "work-graph");
		mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, "shadow.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length > 0 ? "\n" : ""), "utf8");
	} catch { /* never-throw：影子落盘不阻塞验收 */ }
}

// ═══════════════════════ fixture 世界（IO 生成器）═══════════════════════

type GateKind = "ok" | "awaiting" | "none";
interface RepoInit { name: string; gate?: GateKind }
interface TabInit {
	id: string;
	repo: string;
	/** 覆盖 cwd（R4 大小写变体用）；缺省 = world 内 repo 根。 */
	cwd?: string;
	phase?: string;
	terminal?: boolean;
	lastActivityMs?: number;
	pid?: number;
	/** false = 不写 state 文件（探活链）。 */
	state?: boolean;
	result?: { status: string } | null;
	dispatchedAtMs?: number;
}
interface ResolvedTab extends TabInit { cwdAbs: string }

interface World {
	tag: string;
	root: string;
	agentDir: string;
	runsDir: string;
	sessionsRoot: string;
	timersDir: string;
	envDir: string;
	journalPath: string;
	stateDir: string;
	reposRoot: string;
	repoPaths: Map<string, string>;
	tabs: ResolvedTab[];
	journal: RuntimeEnvelope[];
}

function dispatchEnv(tab: string, cwd: string, seq: number): RuntimeEnvelope {
	const subject = tabRunAddress(tab);
	return newEventEnvelope({
		type: "run.dispatched",
		source: masterAddress(),
		subject,
		at: iso(Date.UTC(2026, 0, 1, 0, 0, seq)),
		dedupeKey: `run.dispatched:${subject}`,
		payload: { tabRunId: tab, executionKind: "tab", mode: "workflow", title: `t-${tab}`, cwd },
	});
}

function writeTabFiles(w: World, t: ResolvedTab): void {
	writeJson(join(w.runsDir, `${t.id}.json`), {
		id: t.id, version: 1, taskId: t.id.toUpperCase(), mode: "workflow",
		cwd: t.cwdAbs, dispatchedAt: iso(t.dispatchedAtMs ?? NOW - 3 * HOUR), dispatchStatus: "dispatched",
	});
	const statePath = join(w.runsDir, `${t.id}.state.json`);
	const resultPath = join(w.runsDir, `${t.id}.result.json`);
	if (t.state === false) {
		rmSafe(statePath);
	} else {
		const st: Record<string, unknown> = {
			id: t.id, phase: t.phase ?? "working", turn: "working",
			terminal: t.terminal ?? false, lastActivityAt: iso(t.lastActivityMs ?? NOW - 5 * MIN),
		};
		if (t.pid !== undefined) st.pid = t.pid;
		writeJson(statePath, st);
	}
	if (t.result) writeJson(resultPath, { id: t.id, taskId: t.id.toUpperCase(), status: t.result.status, finishedAt: iso(NOW - 10 * MIN) });
	else rmSafe(resultPath);
}

function makeWorld(tag: string, repos: RepoInit[], tabs: TabInit[]): World {
	const root = mkdtempSync(join(tmpdir(), `e22-${tag}-`));
	const agentDir = join(root, "agent");
	const w: World = {
		tag, root, agentDir,
		runsDir: join(agentDir, "tab-runs"),
		sessionsRoot: join(agentDir, "sessions"),
		timersDir: join(agentDir, "timers"),
		envDir: join(root, "env"),
		journalPath: join(agentDir, "events.jsonl"),
		stateDir: join(root, "state"),
		reposRoot: join(root, "repos"),
		repoPaths: new Map(),
		tabs: [],
		journal: [],
	};
	for (const d of [w.runsDir, w.sessionsRoot, w.timersDir, join(w.timersDir, "mail"), w.envDir, w.stateDir, w.reposRoot]) mkdirSync(d, { recursive: true });
	for (const r of repos) {
		const p = join(w.reposRoot, r.name);
		w.repoPaths.set(r.name, p);
		mkdirSync(join(p, ".git"), { recursive: true });
		if (r.gate === "ok") writeFileSync(join(p, "recentwork.md"), GATE_OK, "utf8");
		else if (r.gate === "awaiting") writeFileSync(join(p, "recentwork.md"), GATE_AWAIT, "utf8");
	}
	for (const t of tabs) {
		const rt: ResolvedTab = { ...t, cwdAbs: t.cwd ?? join(w.reposRoot, t.repo) };
		w.tabs.push(rt);
		writeTabFiles(w, rt);
		w.journal.push(dispatchEnv(rt.id, rt.cwdAbs, w.journal.length + 1));
	}
	writeFileSync(w.journalPath, w.journal.map((e) => JSON.stringify(e)).join("\n") + (w.journal.length > 0 ? "\n" : ""), "utf8");
	return w;
}

function updateTab(w: World, id: string, patch: Partial<TabInit>): void {
	const t = w.tabs.find((x) => x.id === id);
	if (!t) throw new Error(`fixture: 未知 tab ${id}`);
	for (const [k, v] of Object.entries(patch)) (t as unknown as Record<string, unknown>)[k] = v;
	if (patch.cwd !== undefined) t.cwdAbs = patch.cwd;
	writeTabFiles(w, t);
}
function removeTab(w: World, id: string): void {
	rmSafe(join(w.runsDir, `${id}.json`));
	rmSafe(join(w.runsDir, `${id}.state.json`));
	rmSafe(join(w.runsDir, `${id}.result.json`));
}
function writeGate(w: World, repo: string, gate: GateKind): void {
	const p = w.repoPaths.get(repo)!;
	if (gate === "ok") writeFileSync(join(p, "recentwork.md"), GATE_OK, "utf8");
	else if (gate === "awaiting") writeFileSync(join(p, "recentwork.md"), GATE_AWAIT, "utf8");
	else rmSafe(join(p, "recentwork.md"));
}
function writeTimer(w: World, id: string, dueAtMs: number, ownerCwd: string): void {
	writeJson(join(w.timersDir, `${id}.json`), { id, dueAt: iso(dueAtMs), status: "pending", ownerCwd });
}
function writeMailLetter(w: World, recipient: string, name: string, status: string): void {
	const dir = join(w.envDir, "mailbox", recipient);
	mkdirSync(dir, { recursive: true });
	writeJson(join(dir, `${name}.json`), { status });
}
/** 写一条可被 `probeSessionFile` 匹配的 session JSONL（S8a resultMissing 分支用）。 */
function writeSessionProbe(w: World, tabId: string, repoPath: string, dispatchedAtMs: number, stopReason: string): void {
	const bucket = join(w.sessionsRoot, sessionBucketForCwd(repoPath));
	mkdirSync(bucket, { recursive: true });
	const prefix = `根据workflow进行工作${tabId.toUpperCase()}`;
	writeFileSync(join(bucket, `sess_${tabId}.jsonl`), [
		JSON.stringify({ type: "session", id: `sess-${tabId}`, timestamp: iso(dispatchedAtMs) }),
		JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: `${prefix}\n做事` }] } }),
		JSON.stringify({ type: "message", message: { role: "assistant", stopReason, content: [{ type: "text", text: "probe" }] } }),
	].join("\n"), "utf8");
}
function appendJournal(w: World, env: RuntimeEnvelope): void {
	w.journal.push(env);
	appendFileSync(w.journalPath, `${JSON.stringify(env)}\n`, "utf8");
}

const WORLDS: World[] = [];
const track = (w: World): World => { WORLDS.push(w); return w; };

// ═══════════════════════ 两路装配（§3.3：共享 backlog/prev/now）═══════════════════════

const GIT_PROBE = (): { branch: string; dirty: string } => ({ branch: "main", dirty: "clean" });

interface FrameResult {
	v2Snap: GlobalViewSnapshot;
	gSnap: GraphSnapshot;
	gIn: FrontierSourceSnapshot;
	v2: { next: FrontierSnapshot; diff: FrontierDiff };
	g: { next: FrontierSnapshot; diff: FrontierDiff };
	rows: ShadowRow[];
}
const FRAMES: { scope: string; rows: ShadowRow[]; v2: FrameResult["v2"]; g: FrameResult["g"] }[] = [];

function frame(w: World, prev: FrontierSnapshot | null, scope: string, now = NOW): FrameResult {
	process.env.PI_RUNTIME_DIR = w.envDir;
	process.env.PI_TAB_RUNS_DIR = join(w.envDir, "tab-runs");
	// v2 路：生产实参（page=1/pageSize=20 缺省；**不传 history** → history≡[]）
	const v2Snap = collectGlobalView({ agentDir: w.agentDir, now, gitProbe: GIT_PROBE });
	// graph 路：显式五路径 + 同 now
	const gSnap = readGraphSnapshot({ journalPath: w.journalPath, stateDir: w.stateDir, tabRunsDir: w.runsDir, sessionsRoot: w.sessionsRoot, timersDir: w.timersDir, now });
	const gIn = toFrontierInput(gSnap, { now });
	// 共享参数：一次构造（backlog 一次调用；prev/now 同一对象/标量）
	const backlog = mailboxBacklog();
	const v2 = buildFrontier({ snapshot: v2Snap, backlog, prev, now });
	const g = buildFrontier({ snapshot: gIn, backlog, prev, now });
	assert.equal(v2.next.asof, now, `${scope}: v2.next.asof === NOW`);
	assert.equal(g.next.asof, now, `${scope}: graph.next.asof === NOW`);
	const rows = shadowCompare({ ...v2, details: v2Snap.details }, { ...g, details: gIn.details }, { at: now, scope });
	writeShadowJsonl(rows, w.stateDir);
	FRAMES.push({ scope, rows, v2, g });
	return { v2Snap, gSnap, gIn, v2, g, rows };
}

function assertCanonicalEqual(a: FrameResult["v2"], b: FrameResult["v2"], label: string): void {
	assert.equal(canonicalJson(a.next), canonicalJson(b.next), `${label}: next canonical 全等`);
	assert.equal(canonicalJson(a.diff), canonicalJson(b.diff), `${label}: diff canonical 全等`);
}
function assertRowsSame(rows: ShadowRow[], label: string): void {
	const bad = rows.filter((r) => r.verdict !== "same");
	assert.equal(bad.length, 0, `${label}: 非 same 行 ${bad.map((r) => `${r.itemKind}/${r.nodeId}=${r.verdict}${r.reason ? "(" + r.reason + ")" : ""}`).join(", ")}`);
}
const sameVerdict = (f: FrameResult, label: string): void => { assertCanonicalEqual(f.v2, f.g, label); assertRowsSame(f.rows, label); };

// ═══════════════════════ S1–S17 ═══════════════════════

// S1 空盘面 baseline（§4 S1）：两路 baseline=true、projects=[]、triggers=[]、recordOnly 逐字相等。
check("S1 空盘面 baseline：两路全空 + recordOnly 逐字 + O-B 全 same", () => {
	const w = track(makeWorld("s1", [], []));
	const prev = readFrontierSnapshot({ stateDir: w.stateDir }); // §3.3 实参镜像（temp 无 frontier.json）
	assert.equal(prev, null, "temp stateDir 无 frontier.json → prev=null");
	const f = frame(w, prev, "empty-baseline");
	assert.equal(f.v2.next.baseline, true);
	assert.equal(f.g.next.baseline, true);
	assert.deepEqual(f.v2.next.projects, []);
	assert.deepEqual(f.g.next.projects, []);
	assert.deepEqual(f.v2.diff.triggers, []);
	assert.deepEqual(f.g.diff.triggers, []);
	assert.deepEqual(f.v2.diff.recordOnly, RECORD_ONLY_NOCARRIER);
	assert.deepEqual(f.g.diff.recordOnly, RECORD_ONLY_NOCARRIER);
	assert.equal(f.rows.filter((r) => r.itemKind === "recordOnly").length, 3);
	assert.equal(f.rows.filter((r) => r.itemKind === "snapshot").length, 2);
	sameVerdict(f, "S1");
});

// S2 ② working→completed 本帧边沿（非 mailbox 帧1）
check("S2 ② working→completed：两路同 trigger（rule/project/evidence/approx 全等）", () => {
	const w = track(makeWorld("s2", [{ name: "alpha" }], [{ id: "t_a", repo: "alpha", phase: "working" }]));
	const f1 = frame(w, null, "s2@f1");
	updateTab(w, "t_a", { phase: "completed", terminal: true }); // 终态无 result → 可见
	const f2 = frame(w, f1.v2.next, "s2@f2");
	const pick = (f: FrameResult) => f.diff.triggers.filter((t) => t.rule === "working_to_completed");
	assert.equal(pick(f2.v2).length, 1, "v2 恰 1 条 ②");
	assert.equal(pick(f2.g).length, 1, "graph 恰 1 条 ②");
	assert.deepEqual(pick(f2.v2), pick(f2.g), "② 逐字段全等");
	assert.equal(pick(f2.v2)[0]!.approximate, false);
	assert.equal(pick(f2.v2)[0]!.rule, "working_to_completed", "帧1 边沿为 run 级 ②，非 mailbox");
	sameVerdict(f2, "S2");
});

// S3 ③ working→failed 本帧边沿
check("S3 ③ working→failed：两路同 trigger", () => {
	const w = track(makeWorld("s3", [{ name: "alpha" }], [{ id: "t_a", repo: "alpha", phase: "working" }]));
	const f1 = frame(w, null, "s3@f1");
	updateTab(w, "t_a", { phase: "failed", terminal: true });
	const f2 = frame(w, f1.v2.next, "s3@f2");
	const pick = (f: FrameResult) => f.diff.triggers.filter((t) => t.rule === "working_to_failed");
	assert.equal(pick(f2.v2).length, 1);
	assert.equal(pick(f2.g).length, 1);
	assert.deepEqual(pick(f2.v2), pick(f2.g));
	sameVerdict(f2, "S3");
});

// S4 ②③ hidden 回填不可达（MF1）+ 反例
check("S4 MF1：两路 history≡[] 均不产 hidden ②；反例（手工填 history）会产 ②", () => {
	const w = track(makeWorld("s4", [{ name: "alpha" }], [
		{ id: "t_h", repo: "alpha", phase: "working" },
		{ id: "t_keep", repo: "alpha", phase: "attached" }, // 保证 repo 存活、cur 存在
	]));
	const f1 = frame(w, null, "s4@f1");
	updateTab(w, "t_h", { phase: "completed", terminal: true, result: { status: "completed" } }); // 带 result → hidden
	const f2 = frame(w, f1.v2.next, "s4@f2");
	assert.equal(f2.v2Snap.history.length, 0, "v2 生产实参不传 history（禁 history:true）");
	assert.ok((f2.gSnap.history ?? []).length >= 1, "graph 快照确有 hidden history");
	assert.deepEqual(f2.gIn.history, [], "适配器恒 emit history=[]");
	assert.equal(f2.v2.diff.triggers.some((t) => t.rule === "working_to_completed" || t.rule === "working_to_failed"), false, "v2 不产 hidden ②③");
	assert.equal(f2.g.diff.triggers.some((t) => t.rule === "working_to_completed" || t.rule === "working_to_failed"), false, "graph 不产 hidden ②③");
	// 反例对照（证明恒空非假绿）：手工把 graph history 填进 v2 输入 → 凭空造出 ②
	const filled = buildFrontier({ snapshot: { ...f2.v2Snap, history: [{ id: "t_h", reason: "terminal:completed" }] }, backlog: [], prev: f1.v2.next, now: NOW });
	assert.equal(filled.diff.triggers.some((t) => t.rule === "working_to_completed"), true, "填 history 会新增 ②（故两路必须恒空）");
	sameVerdict(f2, "S4");
});

// S5 R7 surviving：prev 有 A/B，本帧 A 消失
check("S5 R7 surviving：A 消失 → 不在 next.projects、无 A 项目级触发；B 正常；两路全等", () => {
	const w = track(makeWorld("s5", [{ name: "alpha" }, { name: "beta" }], [
		{ id: "t_a", repo: "alpha", phase: "working" },
		{ id: "t_b", repo: "beta", phase: "working" },
	]));
	const keyA = normalizeExactPath(w.repoPaths.get("alpha")!);
	const keyB = normalizeExactPath(w.repoPaths.get("beta")!);
	const f1 = frame(w, null, "s5@f1");
	assert.ok(f1.v2.next.projects.some((p) => p.project === keyA), "帧1 A 存在");
	assert.ok(f1.v2.next.projects.some((p) => p.project === keyB), "帧1 B 存在");
	removeTab(w, "t_a"); // A 的 tab 账本消失 → 两路都失去 A
	const f2 = frame(w, f1.v2.next, "s5@f2");
	for (const [side, f] of [["v2", f2.v2], ["graph", f2.g]] as const) {
		assert.equal(f.next.projects.some((p) => p.project === keyA), false, `${side}: A 不在 next.projects`);
		assert.equal(f.diff.triggers.some((t) => t.project === keyA), false, `${side}: 无 A 项目级触发`);
		assert.equal(f.next.projects.some((p) => p.project === keyB), true, `${side}: B 正常`);
		assert.equal(f.next.projects.find((p) => p.project === keyB)!.runs.t_b, "working", `${side}: B runs 保持`);
	}
	assert.deepEqual(f2.v2.diff.triggers, [], "帧2 零触发（A 消失 + B 无变化）");
	sameVerdict(f2, "S5");
});

// S6 ⑤ needs_user attention 0→正（surviving 仓）
check("S6 ⑤ needs_user：attention 0→正，needsUser false→true，两路同 trigger", () => {
	const w = track(makeWorld("s6", [{ name: "alpha" }], [{ id: "t_x", repo: "alpha", phase: "working" }]));
	const f1 = frame(w, null, "s6@f1");
	updateTab(w, "t_x", { phase: "attached" }); // attached → attention=1
	const f2 = frame(w, f1.v2.next, "s6@f2");
	for (const [side, f] of [["v2", f2.v2], ["graph", f2.g]] as const) {
		assert.equal(f1.v2.next.projects.find((p) => p.project === normalizeExactPath(w.repoPaths.get("alpha")!))!.needsUser, false, `${side}: 帧1 needsUser=false`);
		assert.equal(f.next.projects.find((p) => p.project === normalizeExactPath(w.repoPaths.get("alpha")!))!.needsUser, true, `${side}: 帧2 needsUser=true`);
	}
	const pick = (f: FrameResult) => f.diff.triggers.filter((t) => t.rule === "needs_user");
	assert.equal(pick(f2.v2).length, 1);
	assert.equal(pick(f2.g).length, 1);
	assert.deepEqual(pick(f2.v2), pick(f2.g));
	sameVerdict(f2, "S6");
});

// S7 ⑦ deadline_urgency overdue 0→正（approx）
check("S7 ⑦ overdue 0→正：两路同 deadline_urgency（approximate=true）", () => {
	const w = track(makeWorld("s7", [{ name: "alpha" }], [{ id: "t_x", repo: "alpha", phase: "working" }]));
	const f1 = frame(w, null, "s7@f1");
	writeTimer(w, "tm_1", NOW - 30 * MIN, w.repoPaths.get("alpha")!);
	const f2 = frame(w, f1.v2.next, "s7@f2");
	const pick = (f: FrameResult) => f.diff.triggers.filter((t) => t.rule === "deadline_urgency");
	assert.equal(pick(f2.v2).length, 1);
	assert.equal(pick(f2.g).length, 1);
	assert.deepEqual(pick(f2.v2), pick(f2.g));
	assert.equal(pick(f2.v2)[0]!.approximate, true, "⑦ 必须带 approx 标注");
	sameVerdict(f2, "S7");
});

// S8 ⑨ stagnation：resultMissing 分支 + staleOver 分支
check("S8 ⑨ stagnation：resultMissing 分支（session probe error → unconfirmed）两路同 trigger", () => {
	// 关键：state 文件不得含 unconfirmed（TabState.phase 无此值）；unconfirmed 只来自 session probe。
	// dispatchedAt 相对固定 NOW 派生（不依赖墙钟）：探活时间窗下界 = dispatchedAt-60s，
	// 令 session header.timestamp === dispatchedAt 恒匹配，避开 classifyTabStatus 的 ledger-only grace 分支。
	const dispatchedAtMs = NOW - 60_000;
	const w = track(makeWorld("s8a", [{ name: "alpha" }], [{ id: "t_rm", repo: "alpha", phase: "working", dispatchedAtMs }]));
	writeSessionProbe(w, "t_rm", w.repoPaths.get("alpha")!, dispatchedAtMs, "error");
	const f1 = frame(w, null, "s8a@f1"); // state 存在 → phase=working（stagnation=false）
	updateTab(w, "t_rm", { state: false }); // 移除 state → probe 分支 → unconfirmed/resultMissing
	const f2 = frame(w, f1.v2.next, "s8a@f2");
	assert.equal(f2.gIn.details.find((d) => d.runId === "t_rm")?.phase, "unconfirmed", "graph details phase=unconfirmed");
	const pick = (f: FrameResult) => f.diff.triggers.filter((t) => t.rule === "stagnation");
	assert.equal(pick(f2.v2).length, 1, "v2 恰 1 条 ⑨");
	assert.equal(pick(f2.g).length, 1, "graph 恰 1 条 ⑨");
	assert.deepEqual(pick(f2.v2), pick(f2.g));
	sameVerdict(f2, "S8a");
});
check("S8 ⑨ stagnation：staleOver 分支（非终态 stale>45min）两路同 trigger", () => {
	const w = track(makeWorld("s8b", [{ name: "beta" }], [{ id: "t_so", repo: "beta", phase: "working", lastActivityMs: NOW - 5 * MIN }]));
	const f1 = frame(w, null, "s8b@f1");
	updateTab(w, "t_so", { lastActivityMs: NOW - 60 * MIN });
	const f2 = frame(w, f1.v2.next, "s8b@f2");
	const pick = (f: FrameResult) => f.diff.triggers.filter((t) => t.rule === "stagnation");
	assert.equal(pick(f2.v2).length, 1);
	assert.equal(pick(f2.g).length, 1);
	assert.deepEqual(pick(f2.v2), pick(f2.g));
	sameVerdict(f2, "S8b");
});

// S9 ① gate awaiting→ok（approx）
check("S9 ① gate awaiting→ok：两路同 blocked_to_ready（approximate=true）", () => {
	const w = track(makeWorld("s9", [{ name: "alpha", gate: "awaiting" }], [{ id: "t_x", repo: "alpha", phase: "working" }]));
	const f1 = frame(w, null, "s9@f1");
	writeGate(w, "alpha", "ok");
	const f2 = frame(w, f1.v2.next, "s9@f2");
	const pick = (f: FrameResult) => f.diff.triggers.filter((t) => t.rule === "blocked_to_ready");
	assert.equal(pick(f2.v2).length, 1);
	assert.equal(pick(f2.g).length, 1);
	assert.deepEqual(pick(f2.v2), pick(f2.g));
	assert.equal(pick(f2.v2)[0]!.approximate, true, "① 必须带 approx 标注");
	sameVerdict(f2, "S9");
});

// S10 ⑩ ws_mail_backlog（共享 backlog pending 0→正）
check("S10 ⑩ ws_mail_backlog：共享同一 backlog，pending 0→正 两路同 trigger", () => {
	const w = track(makeWorld("s10", [], []));
	const f1 = frame(w, null, "s10@f1");
	assert.equal(f1.v2.diff.triggers.length, 0, "无到信 → 0 触发");
	writeMailLetter(w, "agent__master_default", "m1", "pending");
	assert.equal(mailboxBacklog().find((b) => b.recipient === "agent__master_default")?.pending, 1, "mailboxBacklog 读到 pending=1");
	const f2 = frame(w, f1.v2.next, "s10@f2");
	const pick = (f: FrameResult) => f.diff.triggers.filter((t) => t.rule === "ws_mail_backlog");
	assert.equal(pick(f2.v2).length, 1);
	assert.equal(pick(f2.g).length, 1);
	assert.deepEqual(pick(f2.v2), pick(f2.g));
	assert.equal(pick(f2.v2)[0]!.evidence, "pending:1");
	sameVerdict(f2, "S10");
});

// S11 ④⑥⑧ record-only 逐字 + meaningfulChanges + msv（全帧）
check("S11 ④⑥⑧ record-only 逐字 + meaningfulChanges + msv 逐项目相等（全帧）", () => {
	assert.ok(FRAMES.length >= 8, "应已在多帧上下文中");
	for (const fr of FRAMES) {
		assert.deepEqual(fr.v2.diff.recordOnly, RECORD_ONLY_NOCARRIER, `${fr.scope}: v2 recordOnly 逐字`);
		assert.deepEqual(fr.g.diff.recordOnly, RECORD_ONLY_NOCARRIER, `${fr.scope}: graph recordOnly 逐字`);
		assert.equal(fr.v2.diff.meaningfulChanges, fr.g.diff.meaningfulChanges, `${fr.scope}: meaningfulChanges`);
		for (const p of fr.v2.next.projects) {
			const q = fr.g.next.projects.find((x) => x.project === p.project);
			assert.equal(q?.meaningfulStateVersion, p.meaningfulStateVersion, `${fr.scope}/${p.project}: msv`);
		}
	}
	const last = FRAMES[FRAMES.length - 1]!;
	assert.equal(last.rows.filter((r) => r.itemKind === "recordOnly" && r.verdict === "same").length, 3, "recordOnly 行恰 3 条 same");
});

// S12 规模 19/20/21/40 仓 + S13 attentionByRepo 键集
interface ScaleCase { n: number; f1: FrameResult; f2: FrameResult; pageOutKey: string; v2RowKeys: string[] }
const SCALE: ScaleCase[] = [];
for (const n of [19, 20, 21, 40]) {
	check(`S12 规模 ${n} 仓：两路 canonical 全等 + details 成员集相等 + 帧2 仍全等`, () => {
		const repos: RepoInit[] = Array.from({ length: n }, (_, i) => ({ name: `r${String(i).padStart(2, "0")}` }));
		const tabs: TabInit[] = repos.map((r, i) => ({ id: `run_${String(i).padStart(2, "0")}`, repo: r.name, phase: "attached", lastActivityMs: NOW - i * MIN }));
		const w = track(makeWorld(`s12n${n}`, repos, tabs));
		const f1 = frame(w, null, `scale${n}@f1`);
		assert.equal(f1.v2Snap.cursor.page, 1, "生产缺省 page=1");
		assert.equal(f1.v2Snap.cursor.pageSize, 20, "生产缺省 pageSize=20");
		assert.equal(f1.v2Snap.rows.length, Math.min(n, 20), "首页容纳 = min(n,20)");
		assert.equal(f1.v2Snap.totals.attention, n, "attention>0 总数");
		assert.deepEqual(f1.v2Snap.attentionByRepo, f1.gIn.attentionByRepo, "attentionByRepo 键/值逐字相等");
		assert.equal(Object.keys(f1.v2Snap.attentionByRepo).length, n, "全量投影含全部 n 仓（含页外）");
		assert.equal("__HOME__" in f1.v2Snap.attentionByRepo, false, "VMware HOME 伪仓不进 v2 键集");
		assert.equal("__HOME__" in f1.gIn.attentionByRepo, false, "graph 侧无 HOME 键");
		assert.deepEqual(
			[...new Set(f1.gIn.details.map((d) => `${normalizeExactPath(d.repoPath)}::${d.runId}`))].sort(),
			[...new Set(f1.v2Snap.details.map((d) => `${normalizeExactPath(d.repoPath)}::${d.runId}`))].sort(),
			"details 成员集相等",
		);
		sameVerdict(f1, `S12-${n}@f1`);
		const f2 = frame(w, f1.v2.next, `scale${n}@f2`);
		assert.deepEqual(f2.v2Snap.attentionByRepo, f2.gIn.attentionByRepo, "帧2 attentionByRepo 仍逐字相等");
		assert.deepEqual(f2.v2.diff.triggers, f2.g.diff.triggers, "帧2 triggers 逐字段相等");
		sameVerdict(f2, `S12-${n}@f2`);
		const pageOutKey = normalizeExactPath(w.repoPaths.get(`r${String(n - 1).padStart(2, "0")}`)!);
		SCALE.push({ n, f1, f2, pageOutKey, v2RowKeys: f1.v2Snap.rows.map((r) => normalizeExactPath(r.repoPath)) });
	});
}
check("S13 attentionByRepo 键集相等（显式；21/40 档含页外仓）", () => {
	assert.equal(SCALE.length, 4, "四档规模均已构造");
	for (const s of SCALE) {
		const v2Keys = Object.keys(s.f1.v2Snap.attentionByRepo).sort();
		const gKeys = Object.keys(s.f1.gIn.attentionByRepo).sort();
		assert.deepEqual(v2Keys, gKeys, `n=${s.n}: 键集逐字相等`);
		for (const k of v2Keys) assert.equal(s.f1.gIn.attentionByRepo[k], s.f1.v2Snap.attentionByRepo[k], `n=${s.n}: 键 ${k} 值相等`);
		assert.equal(v2Keys.length, s.n, `n=${s.n}: 全量键数`);
		if (s.n > 20) {
			assert.equal(s.f1.v2Snap.rows.length, 20, `n=${s.n}: 首页 20`);
			assert.equal(s.v2RowKeys.includes(s.pageOutKey), false, `n=${s.n}: 末仓在页外（rows 不含）`);
			assert.equal(s.pageOutKey in s.f1.v2Snap.attentionByRepo, true, `n=${s.n}: 末仓在全量投影内（v2）`);
			assert.equal(s.pageOutKey in s.f1.gIn.attentionByRepo, true, `n=${s.n}: 末仓在全量投影内（graph）`);
		}
	}
});

// S14 确定性（同输入两跑）
check("S14 确定性：同输入两跑 shadowCompare deepEqual + buildFrontier canonical 相等", () => {
	const w = track(makeWorld("s14", [{ name: "alpha" }], [{ id: "t_d", repo: "alpha", phase: "attached" }]));
	const f1 = frame(w, null, "s14@f1");
	const sideArgs = (): [ShadowSide, ShadowSide, { at: number; scope: string }] => [
		{ ...f1.v2, details: f1.v2Snap.details }, { ...f1.g, details: f1.gIn.details }, { at: NOW, scope: "s14@dup" },
	];
	const a = shadowCompare(...sideArgs());
	const b = shadowCompare(...sideArgs());
	assert.deepEqual(a, b, "shadowCompare 两次输出逐字节相同");
	const x = buildFrontier({ snapshot: f1.v2Snap, backlog: [], prev: null, now: NOW });
	const y = buildFrontier({ snapshot: f1.v2Snap, backlog: [], prev: null, now: NOW });
	assert.equal(canonicalJson(x.next), canonicalJson(y.next), "v2 next 两跑 canonical 相等");
	assert.equal(canonicalJson(x.diff), canonicalJson(y.diff), "v2 diff 两跑 canonical 相等");
	const gx = buildFrontier({ snapshot: f1.gIn, backlog: [], prev: null, now: NOW });
	assert.equal(canonicalJson(gx.next), canonicalJson(f1.g.next), "graph next 两跑 canonical 相等");
	const f1b = frame(w, null, "s14@rerun");
	const stripScope = (rows: ShadowRow[]) => rows.map((r) => ({ ...r, scope: "" }));
	assert.deepEqual(stripScope(f1b.rows), stripScope(f1.rows), "同 fixture 重新采集 → O-B 行（忽略 scope）deepEqual");
});

// S15 前向兼容（未知事件）
check("S15 前向兼容：journal 未知 type → skipped 非空但不抛、两路全等", () => {
	const w = track(makeWorld("s15", [{ name: "alpha" }], [{ id: "t_u", repo: "alpha", phase: "working" }]));
	appendJournal(w, newEventEnvelope({ type: "project.priority_changed", source: masterAddress(), at: iso(NOW) }));
	const f1 = frame(w, null, "s15@f1");
	assert.deepEqual(f1.gSnap.skipped.unknownEventTypes, ["project.priority_changed"], "graph 记录未知事件类型");
	assert.equal(f1.v2.next.projects.length, 1, "未知事件不影响 v2 已知项目");
	sameVerdict(f1, "S15");
});

// S16 R4 大小写变体（不得记 explained）
check("S16 R4 大小写变体：两路归一键唯一且相等；差异不得记 explained/unexplained", () => {
	const w = track(makeWorld("s16", [{ name: "foo" }], [
		{ id: "t_upper", repo: "foo", phase: "attached" },
		{ id: "t_lower", repo: "foo", phase: "attached" },
	]));
	// 变体 cwd：大写 + 正斜杠（normalizeExactPath/normalizeRepoKey 必须折回同一键）
	updateTab(w, "t_upper", { cwd: w.repoPaths.get("foo")!.replace(/\\/g, "/").toUpperCase() });
	const key = normalizeExactPath(w.repoPaths.get("foo")!);
	const f1 = frame(w, null, "s16@f1");
	// 输入分叉显式化（R4 判别性）：两路消费的**原始**载体确实不同，非两份相同输入——
	// graph 源 journal 的 dispatch cwd 保留 lower-case；v2 源账本 cwd 被改成大写/正斜杠变体。
	const gProjects = f1.gSnap.projects.map((p) => p.project);
	assert.deepEqual(gProjects, [key], "graph 原始 project 为 lower-case 单键（归一口径）");
	assert.equal(gProjects[0], gProjects[0]!.toLowerCase(), "graph 原始 project 全小写");
	const fold = (s: string): string => s.replace(/\\/g, "/").toLowerCase();
	const upperCount = (s: string): number => (s.match(/[A-Z]/g) ?? []).length;
	const v2Upper = w.tabs.find((t) => t.id === "t_upper")!.cwdAbs; // v2 原始 detail（账本 cwd）
	const journalLower = (w.journal.find((e) => e.subject === tabRunAddress("t_upper"))!.payload as { cwd: string }).cwd;
	assert.notEqual(v2Upper, journalLower, "v2 原始 detail 与 graph journal cwd 拼写不同（输入分叉）");
	assert.equal(fold(v2Upper), fold(journalLower), "二者指向同一仓（仅大小写/分隔符不同）");
	assert.ok(upperCount(v2Upper) > upperCount(journalLower), "v2 原始 detail 含 upper-case 变体，journal 为 lower-case");
	assert.equal(normalizeExactPath(v2Upper), key, "大写变体归一到 key");
	assert.equal(normalizeExactPath(journalLower), key, "journal lower-case 归一到同 key");
	assert.deepEqual(Object.keys(f1.v2Snap.attentionByRepo), [key], "v2 归一键唯一");
	assert.deepEqual(f1.gIn.attentionByRepo, f1.v2Snap.attentionByRepo, "graph 同键同值");
	assert.equal(Object.values(f1.v2Snap.attentionByRepo)[0], 2, "两 tab 归并计数 = 2");
	assert.equal(f1.v2.next.projects.length, 1, "next 单项目");
	assert.equal(f1.rows.some((r) => r.verdict === "explained"), false, "R4 差异不得记 explained");
	assert.equal(f1.rows.some((r) => r.verdict === "unexplained"), false, "R4 差异不得记 unexplained");
	sameVerdict(f1, "S16");
});

// S17 O-B 硬门汇总
check("S17 O-B 硬门：unexplained=0 且 explained=0；rows 非空跑；shadow.jsonl 行数==rows 数", () => {
	const all = FRAMES.flatMap((f) => f.rows);
	const unexplained = all.filter((r) => r.verdict === "unexplained");
	const explained = all.filter((r) => r.verdict === "explained");
	assert.equal(unexplained.length, 0, `unexplained=${unexplained.length} → ${unexplained.slice(0, 3).map((r) => `${r.scope}/${r.itemKind}/${r.nodeId}: ${r.reason}`).join(" ; ")}`);
	assert.equal(explained.length, 0, `explained=${explained.length}（WHITELIST=[]，任何 explained 都是未批准条目）`);
	assert.ok(all.some((r) => r.verdict === "same"), "非空跑：必须存在 same 行");
	assert.ok(all.some((r) => r.itemKind === "trigger"), "至少一帧产 trigger 行（非空跑）");
	assert.ok(all.some((r) => r.itemKind === "trigger" && !r.nodeId.startsWith("ws_mail_backlog|")), "含非 mailbox 帧1 边沿");
	for (const f of FRAMES) assertCanonicalEqual(f.v2, f.g, `S17/${f.scope}`);
	// 落盘：新 temp `<tmp>/state/work-graph/shadow.jsonl`
	const shadowStateDir = join(ENV_TMP, "shadow-state", "state");
	writeShadowJsonl(all, shadowStateDir);
	const shadowPath = join(shadowStateDir, "work-graph", "shadow.jsonl");
	assert.ok(existsSync(shadowPath), "shadow.jsonl 已落盘");
	const lines = readFileSync(shadowPath, "utf8").trim().split("\n").filter(Boolean);
	assert.equal(lines.length, all.length, "shadow.jsonl 行数 == rows 数");
	assert.equal(existsSync(join(shadowStateDir, "autonomy", "audit.jsonl")), false, "零行为：不写生产 state/autonomy/audit.jsonl");
	console.log(`  E2.2 dump: frames=${FRAMES.length} rows=${all.length} same=${all.length - unexplained.length - explained.length} triggerRows=${all.filter((r) => r.itemKind === "trigger").length} unexplained=${unexplained.length} explained=${explained.length}`);
});

// ═══════════════════════ 可选反向自检（E22_REVERSE_SELFTEST=1）═══════════════════════
// 受控 helper（L4 建议修 3）：把 L4 的 graph-only 0 化反向实验落成可复跑自检，缺省关闭、不影响正常跑。
// 目的：未来改 canonical/verdict 时复验判别力——篡改 graph-only 输入必须被 O-B 报为 unexplained>0。
if (process.env.E22_REVERSE_SELFTEST === "1") {
	check("S-R 反向自检：篡改 graph-only attention → 必报 unexplained>0", () => {
		const w = track(makeWorld("reverse-selftest", [{ name: "alpha" }], [{ id: "t_rev", repo: "alpha", phase: "attached" }]));
		const f = frame(w, null, "reverse@f1");
		const corruptKey = Object.keys(f.gIn.attentionByRepo).find((k) => (f.gIn.attentionByRepo[k] ?? 0) > 0);
		assert.ok(corruptKey, "反向自检前置：需存在 attention>0 的键");
		const tamperedIn: FrontierSourceSnapshot = { ...f.gIn, attentionByRepo: { ...f.gIn.attentionByRepo, [corruptKey!]: 0 } };
		const tampered = buildFrontier({ snapshot: tamperedIn, backlog: mailboxBacklog(), prev: null, now: NOW });
		const rows = shadowCompare(
			{ ...f.v2, details: f.v2Snap.details },
			{ ...tampered, details: tamperedIn.details },
			{ at: NOW, scope: "reverse@tampered" },
		);
		const unexp = rows.filter((r) => r.verdict === "unexplained").length;
		console.log(`  E22_REVERSE_SELFTEST: graph-only attention['${corruptKey}']:=0 → unexplained=${unexp}（期望 >0）`);
		assert.ok(unexp > 0, "反向自检失败：篡改 graph-only 输入未被判为 unexplained>0（harness 判别力失效）");
	});
}

// ═══════════════════════ 汇总 + 清理 ═══════════════════════
const ALL_ROWS = FRAMES.flatMap((f) => f.rows);
const UNEXPLAINED = ALL_ROWS.filter((r) => r.verdict === "unexplained").length;
const EXPLAINED = ALL_ROWS.filter((r) => r.verdict === "explained").length;
console.log(`E2.2 shadow: frames=${FRAMES.length} rows=${ALL_ROWS.length} same=${ALL_ROWS.length - UNEXPLAINED - EXPLAINED}`);
console.log(`unexplained=${UNEXPLAINED} explained=${EXPLAINED}`);

for (const w of WORLDS) rmSync(w.root, { recursive: true, force: true });
rmSync(ENV_TMP, { recursive: true, force: true });

if (failures.length > 0 || UNEXPLAINED !== 0 || EXPLAINED !== 0) {
	console.error(`_test_graph_frontier_shadow: FAILED (${failures.length} failed check(s); unexplained=${UNEXPLAINED} explained=${EXPLAINED})`);
	process.exit(1);
}
console.log(`_test_graph_frontier_shadow: all ${passed} checks passed`);