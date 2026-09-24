/**
 * _test_graph_carriers.ts — E2.0 共享 carrier 归约 tripwire（MF4）
 *
 * 目的：钉死 `runtime/frontier-carriers.ts` 的三个共享归约与抽取前的 `global-view.ts`
 * 实现逐字段等价。手法：测试内保留一份**冻结的 legacy 副本**（旧 `buildTabDetail` /
 * `classifyDispatch` / timers 闭包聚合）作为 oracle，与共享实现同 fixture 双跑比对。
 *
 * 另附全量快照 tripwire：`collectGlobalView` 在 fixture 上的 `details` 与原实现
 * 逐字段一致（经 `reduceTabCarrier` 走通装配层）。
 *
 * 运行：timeout 300 node --experimental-strip-types ./extensions/_test_graph_carriers.ts
 * 计划：plans/0924_graph_E2_impl_plan.md §2/§3/§4/§7-T1。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeExactPath } from "./runtime/recent-scopes.ts";
import {
	classifyTabStatus,
	composeTabStatus,
	probeSessionFile,
	readTabResultFile,
	readTabState,
	sessionBucketForCwd,
	type SessionProbe,
	type TabDispatchRecord,
	type TabResult,
	type TabState,
} from "./tab-runs.ts";
import { classifyForReclaim } from "./tab-runs-runtime.ts";
import { classifyDispatch, collectTimerByRepo, reduceTabCarrier, type TabDetail } from "./runtime/frontier-carriers.ts";
import { collectGlobalView, readGateStatus, STALE_NO_PROGRESS_MS, SUMMARY_TRUNCATE_CHARS, MAX_PROBE_TAIL_LINES } from "./runtime/global-view.ts";

const NOW = Date.parse("2026-09-01T12:00:00.000Z");
const HOUR = 3600_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const ROOT = mkdtempSync(join(tmpdir(), "e2-carriers-"));
const agentDir = join(ROOT, "agent");
const runsDir = join(agentDir, "tab-runs");
const sessionsRoot = join(agentDir, "sessions");
const timersDir = join(agentDir, "timers");
const repoA = join(ROOT, "repos", "alpha");
const repoB = join(ROOT, "repos", "beta");
const repoC = join(ROOT, "repos", "gamma");
for (const d of [runsDir, sessionsRoot, timersDir, join(timersDir, "mail", "run_mail"), repoA, repoB, repoC]) mkdirSync(d, { recursive: true });
for (const r of [repoA, repoB, repoC]) mkdirSync(join(r, ".git"), { recursive: true });
writeFileSync(join(repoA, "recentwork.md"), `# r\n\n## Active Tasks\n\n### Task Index\n\n| Item | Priority | Summary |\n| R1 | P0 | d |\n\n**Status**：waiting\n`, "utf8");
writeFileSync(join(repoB, "recentwork.md"), `# r\n\n## Active Tasks\n\n### Task Index\n\n| Item | Priority | Summary |\n| R1 | P0 | d |\n`, "utf8");
const write = (p: string, o: unknown): void => writeFileSync(p, JSON.stringify(o), "utf8");
const state = (id: string, phase: string, terminal: boolean, atMs: number, extra: Record<string, unknown> = {}): void =>
	write(join(runsDir, `${id}.state.json`), { id, phase, turn: "working", terminal, lastActivityAt: iso(atMs), ...extra });

// ── fixture ────────────────────────────────────────────────────────
const FAR_PAST = new Date(Date.now() - 100 * HOUR).toISOString();
const recs: TabDispatchRecord[] = [
	{ id: "w_stale", version: 1, taskId: "A1", mode: "workflow", cwd: repoA, dispatchedAt: iso(NOW - 3 * HOUR), dispatchStatus: "dispatched" },
	{ id: "p_probe", version: 1, taskId: "PT1", mode: "workflow", cwd: repoB, dispatchedAt: iso(NOW - 3 * HOUR), dispatchStatus: "dispatched" },
	{ id: "t_term", version: 1, taskId: "T1", mode: "workflow", cwd: repoA, dispatchedAt: iso(NOW - 3 * HOUR), dispatchStatus: "dispatched" },
	{ id: "w_wait", version: 1, taskId: "B1", mode: "workflow", cwd: repoB, dispatchedAt: iso(NOW - 3 * HOUR), dispatchStatus: "dispatched" },
	{ id: "t_attn", version: 1, taskId: "C1", mode: "workflow", cwd: repoC, dispatchedAt: iso(NOW - 3 * HOUR), dispatchStatus: "dispatched" },
	{ id: "t_none", version: 1, taskId: "N1", mode: "workflow", cwd: repoC, dispatchedAt: FAR_PAST, dispatchStatus: "dispatched" },
];
for (const r of recs) write(join(runsDir, `${r.id}.json`), r);
state("w_stale", "working", false, NOW - 60 * 60_000, { lastStopReason: "stop", lastAssistantText: "x".repeat(200), pid: 999_999_999 });
state("p_probe", "working", false, NOW - 5 * 60_000); // 缺 stop/摘要 → probe
state("w_wait", "waiting", false, NOW - 5 * 60_000, { lastStopReason: "stop" });
state("t_attn", "completed", true, NOW - 10 * 60_000);
write(join(runsDir, "t_term.result.json"), { id: "t_term", taskId: "T1", status: "completed", finishedAt: iso(NOW - 2 * HOUR) });
const bucket = join(sessionsRoot, sessionBucketForCwd(repoB));
mkdirSync(bucket, { recursive: true });
writeFileSync(join(bucket, "s1.jsonl"), [
	JSON.stringify({ type: "session", id: "sess-p", timestamp: iso(NOW - 2 * HOUR) }),
	JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "根据workflow进行工作PT1\n做事" }] } }),
	JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "error", content: [{ type: "text", text: "探".repeat(150) }] } }),
].join("\n"), "utf8");

// ── 冻结 legacy oracle（抽取前 global-view.ts 原实现，逐字复制）───────
function lToMs(v: unknown): number | null {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v === "string" && v) { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
	return null;
}
function lRelText(ms: number | null, now: number): string {
	if (ms === null || ms <= 0) return "?";
	const d = now - ms;
	if (d < 0) return "0m";
	const m = Math.floor(d / 60000);
	if (m < 1) return "0m";
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 48) return `${h}h`;
	return `${Math.floor(h / 24)}d`;
}
function lTruncateSummary(s: string): string {
	const t = s.replace(/[\x00-\x1f\x7f]/g, "").replace(/\n/g, " ").trim();
	return t ? t.slice(0, SUMMARY_TRUNCATE_CHARS) : "-";
}
function probeVisibleTab(rec: TabDispatchRecord, root: string): SessionProbe | null {
	try {
		const b = join(root, sessionBucketForCwd(rec.cwd));
		if (!existsSync(b)) return null;
		const dispatchedMs = Date.parse(rec.dispatchedAt);
		for (const f of readdirSync(b)) {
			if (!f.endsWith(".jsonl")) continue;
			const full = join(b, f);
			let probe: SessionProbe;
			try { probe = probeSessionFile(full, rec.taskId, rec.mode, { maxTailLines: MAX_PROBE_TAIL_LINES }); } catch { continue; }
			if (!probe.matched) continue;
			if (!Number.isNaN(dispatchedMs)) {
				let sessionMs = probe.sessionTimestamp ? Date.parse(probe.sessionTimestamp) : NaN;
				if (Number.isNaN(sessionMs)) { try { sessionMs = statSync(full).mtimeMs; } catch { /* keep */ } }
				if (!Number.isNaN(sessionMs) && sessionMs < dispatchedMs - 60_000) continue;
			}
			return probe;
		}
		return null;
	} catch { return null; }
}
/** 旧 `global-view.ts::buildTabDetail`（抽取前）——逐字冻结副本。 */
function legacyBuildTabDetail(rec: TabDispatchRecord, rDir: string, sRoot: string, repoPath: string, repoOverdue: number, now: number, warnings: string[], gateCache: Map<string, "awaiting" | "ok" | "unknown">): TabDetail | null {
	try {
		let st: TabState | null = null;
		let result: TabResult | null = null;
		try { result = readTabResultFile(rDir, rec.id); } catch { result = null; }
		try { st = readTabState(rDir, rec.id); } catch { st = null; }
		let probe: SessionProbe | null = null;
		if (!st?.lastStopReason || !st?.lastAssistantText) probe = probeVisibleTab(rec, sRoot);
		let phase: string = st?.phase ?? (result ? result.status : "unknown");
		let terminal = st?.terminal ?? !!result;
		let resultMissing = !result;
		let reclaim: string = "pending";
		try {
			const view = composeTabStatus({ runId: rec.id, dispatch: rec, state: st, result, probe, dispatchedAt: rec.dispatchedAt });
			phase = view.phase; terminal = view.terminal; resultMissing = view.resultMissing;
			reclaim = classifyForReclaim(view);
		} catch { /* keep */ }
		const dispMs = lToMs(rec.dispatchedAt);
		const ageMs = dispMs && dispMs > 0 ? now - dispMs : null;
		const actMs = lToMs(st?.lastActivityAt);
		const staleMs = actMs && actMs > 0 ? now - actMs : null;
		const staleOver = staleMs !== null && staleMs > STALE_NO_PROGRESS_MS && (phase === "working" || phase === "waiting");
		const stop = st?.lastStopReason ?? probe?.lastStopReason ?? "unknown";
		let pidAlive: boolean | null = null;
		if (typeof st?.pid === "number" && Number.isFinite(st.pid)) {
			try { process.kill(st.pid, 0); pidAlive = true; } catch { pidAlive = false; }
		}
		let artifact = "-"; let artifactMtime = "?";
		const cands = result?.reportPath ? [result.reportPath] : [...(result?.artifacts ?? [])];
		const last = cands[cands.length - 1];
		if (result && last) {
			artifact = last;
			try {
				const p = existsSync(last) ? last : join(repoPath, last);
				const m = statSync(p).mtimeMs;
				artifactMtime = lRelText(m, now);
			} catch { artifactMtime = "missing"; }
		}
		const gk = normalizeExactPath(repoPath);
		let gate = gateCache.get(gk);
		if (!gate) { gate = readGateStatus(repoPath, warnings); gateCache.set(gk, gate); }
		return {
			runId: rec.id, repoPath, phase, taskId: rec.taskId || "unknown",
			age: ageMs !== null ? lRelText(now - ageMs, now) : "?",
			stale: staleMs !== null ? lRelText(now - staleMs, now) : "unknown",
			staleOver, stop,
			artifact, artifactMtime, resultMissing, terminal,
			openIssues: Array.isArray(result?.openIssues) ? result.openIssues.length : null,
			summary: lTruncateSummary(probe?.lastAssistantText ?? st?.lastAssistantText ?? result?.finalText ?? result?.summary ?? ""),
			needsHuman: reclaim === "awaitingInput" || gate === "awaiting",
			gate, overdue: repoOverdue, pidAlive,
		};
	} catch { return null; }
}

/** 旧 per-repo timers 聚合（原闭包内联代码）——冻结副本。 */
function legacyCollectTimerByRepo(dir: string, now: number, runToRepo: ReadonlyMap<string, string>): { byRepo: Map<string, { n: number; overdue: number }>; pending: number; unmapped: number } {
	const byRepo = new Map<string, { n: number; overdue: number }>();
	let pending = 0; let unmapped = 0;
	const findRoot = (cwd: string): string => cwd; // fixture ownerCwd 即 repo 根（.git 命中即自身）
	const bump = (repoPath: string | null, dueAt: unknown): void => {
		const due = lToMs(dueAt) ?? 0;
		const od = due > 0 && due < now ? 1 : 0;
		if (!repoPath) { unmapped++; return; }
		const k = normalizeExactPath(repoPath);
		const e = byRepo.get(k) ?? { n: 0, overdue: 0 };
		e.n++; e.overdue += od; byRepo.set(k, e);
	};
	try {
		if (existsSync(dir)) {
			for (const f of readdirSync(dir)) {
				if (!f.endsWith(".json") || f.endsWith(".tmp")) continue;
				const full = join(dir, f);
				try { if (statSync(full).isDirectory()) continue; } catch { continue; }
				const r = JSON.parse(readFileSync(full, "utf8")) as Record<string, unknown>;
				if (!r || r.status !== "pending") continue;
				pending++;
				const ownerCwd = typeof r.ownerCwd === "string" && r.ownerCwd ? r.ownerCwd : null;
				bump(ownerCwd ? findRoot(ownerCwd) : null, r.dueAt);
			}
			const mailRoot = join(dir, "mail");
			if (existsSync(mailRoot)) {
				for (const run of readdirSync(mailRoot)) {
					const d = join(mailRoot, run);
					let files: string[] = [];
					try { files = readdirSync(d); } catch { continue; }
					for (const f of files) {
						if (!f.endsWith(".json") || f.endsWith(".tmp")) continue;
						const r = JSON.parse(readFileSync(join(d, f), "utf8")) as Record<string, unknown>;
						if (!r || r.status !== "pending") continue;
						pending++;
						bump(runToRepo.get(run) ?? null, r.dueAt);
					}
				}
			}
		}
	} catch { /* oracle never-throw */ }
	return { byRepo, pending, unmapped };
}

let passed = 0;
function check(name: string, fn: () => void): void { fn(); passed += 1; console.log(`  ok ${name}`); }

try {
	check("T1 reduceTabCarrier ≡ legacy buildTabDetail（逐字段，含 probe/pid/gate 三态）", () => {
		const warnings: string[] = [];
		const gateCache = new Map<string, "awaiting" | "ok" | "unknown">();
		for (const rec of recs) {
			const repoPath = rec.cwd;
			const st = readTabState(runsDir, rec.id);
			const result = readTabResultFile(runsDir, rec.id);
			const gk = repoPath.toLowerCase();
			let gate = gateCache.get(gk) ?? readGateStatus(repoPath, warnings);
			gateCache.set(gk, gate);
			const oldDetail = legacyBuildTabDetail(rec, runsDir, sessionsRoot, repoPath, 0, NOW, warnings, new Map(gateCache));
			const newDetail = reduceTabCarrier({ rec, sessionsRoot, repoPath, repoOverdue: 0, now: NOW, gate, state: st, result });
			assert.deepEqual(newDetail, oldDetail, `carrier 不一致: ${rec.id}`);
		}
		const probe = recs.find((r) => r.id === "p_probe")!;
		const probeNew = reduceTabCarrier({ rec: probe, sessionsRoot, repoPath: probe.cwd, repoOverdue: 0, now: NOW, gate: "ok", state: readTabState(runsDir, probe.id), result: null })!;
		assert.equal(probeNew.stop, "error", "probe 补 stop");
		assert.equal(probeNew.summary.length, SUMMARY_TRUNCATE_CHARS, "probe 摘要截断");
		assert.equal(probeNew.pidAlive, null, "无 state.pid → pidAlive null（不猜）");
		const stale = reduceTabCarrier({ rec: recs[0]!, sessionsRoot, repoPath: recs[0]!.cwd, repoOverdue: 3, now: NOW, gate: "awaiting", state: readTabState(runsDir, "w_stale"), result: null })!;
		assert.equal(stale.staleOver, true, "60min 无进展 > 45min");
		assert.equal(stale.pidAlive, false, "死 pid → pidAlive false");
		assert.equal(stale.needsHuman, true, "gate awaiting → needsHuman");
		assert.equal(stale.overdue, 3, "repoOverdue 原样透传");
	});

	check("T2 classifyDispatch：hidden 分流 + attention 保持不变", () => {
		const term = classifyDispatch(recs.find((r) => r.id === "t_term")!, runsDir);
		assert.equal(term.hiddenKind, "terminal");
		assert.equal(term.phase, "completed");
		const attn = classifyDispatch(recs.find((r) => r.id === "t_attn")!, runsDir);
		assert.equal(attn.hiddenKind, null);
		assert.equal(attn.attention, true, "终态无 result → 可见待审 attention");
		const wait = classifyDispatch(recs.find((r) => r.id === "w_wait")!, runsDir);
		assert.equal(wait.hiddenKind, null);
		assert.equal(wait.attention, false, "working/waiting → attention false");
		// 无 state/result 且超出 grace → orphaned hidden（real-now 与固定 dispatchedAt 差距大，确定）
		const none = classifyDispatch(recs.find((r) => r.id === "t_none")!, runsDir);
		assert.equal(none.hiddenKind, "orphaned");
	});

	check("T3 collectTimerByRepo ≡ legacy timers 聚合（pending-only/overdue/unmapped）", () => {
		write(join(timersDir, "t_future.json"), { id: "t_future", dueAt: iso(NOW + HOUR), status: "pending", ownerCwd: repoA });
		write(join(timersDir, "t_over.json"), { id: "t_over", dueAt: iso(NOW - 30 * 60_000), status: "pending", ownerCwd: repoA });
		write(join(timersDir, "t_unmapped.json"), { id: "t_unmapped", dueAt: iso(NOW - 10 * 60_000), status: "pending" });
		write(join(timersDir, "t_fired.json"), { id: "t_fired", dueAt: iso(NOW - HOUR), status: "fired", ownerCwd: repoA });
		write(join(timersDir, "mail", "run_mail", "t_mail.json"), { id: "t_mail", dueAt: iso(NOW - HOUR), status: "pending" });
		const runToRepo = new Map<string, string>([["run_mail", repoB]]);
		const neu = collectTimerByRepo(timersDir, NOW, runToRepo);
		const old = legacyCollectTimerByRepo(timersDir, NOW, runToRepo);
		assert.equal(neu.pending, old.pending, "pending 总数一致");
		assert.equal(neu.unmapped, old.unmapped, "unmapped 一致");
		assert.deepEqual([...neu.byRepo.entries()].sort(), [...old.byRepo.entries()].sort());
		assert.equal(neu.byRepo.get(normalizeExactPath(repoA))!.n, 2);
		assert.equal(neu.byRepo.get(normalizeExactPath(repoA))!.overdue, 1);
		assert.equal(neu.unmapped, 1, "无 ownerCwd 的 root timer 记 unmapped");
	});

	check("T4 collectGlobalView 装配层：details 与 legacy oracle 逐字段一致（overdue 回填单独钉）", () => {
		const snap = collectGlobalView({ agentDir, now: NOW, gitProbe: () => ({ branch: "main", dirty: "clean" }) });
		const warnings: string[] = [];
		const gateCache = new Map<string, "awaiting" | "ok" | "unknown">();
		// 装配层在 timers 聚合后回填 d.overdue（原 #L784 顺序依赖）；此处用共享聚合的期望值比对
		// runToRepo = 装配层内部的 dispatch runId→repo（mail timer 的 run 名若不在账本则不映射）
		const agg = collectTimerByRepo(timersDir, NOW, new Map(recs.map((r) => [r.id, r.cwd])));
		for (const rec of recs) {
			const note = classifyDispatch(rec, runsDir);
			if (note.hiddenKind !== null) continue;
			const gk = normalizeExactPath(rec.cwd);
			let gate = gateCache.get(gk) ?? readGateStatus(rec.cwd, warnings);
			gateCache.set(gk, gate);
			const expected = legacyBuildTabDetail(rec, runsDir, sessionsRoot, rec.cwd, 0, NOW, warnings, gateCache);
			const actual = snap.details.find((d) => d.runId === rec.id);
			assert.ok(actual, `details 缺失: ${rec.id}`);
			// legacy 以 repoOverdue=0 构建（镜像 v2 构建时刻的入参）
			assert.deepEqual({ ...actual, overdue: 0 }, expected, `装配层 details 不一致: ${rec.id}`);
			// 顺序依赖钉死：装配层回填 overdue = 共享 timers 聚合的 repo 级 overdue
			assert.equal(actual!.overdue, agg.byRepo.get(gk)?.overdue ?? 0, `overdue 回填不一致: ${rec.id}`);
		}
		// details 数量 = 可见 tab 数
		const visible = recs.filter((r) => classifyDispatch(r, runsDir).hiddenKind === null).length;
		assert.equal(snap.details.length, visible);
	});

	assert.equal(passed, 4, `应跑满 4 组，实际 ${passed}`);
	console.log(`_test_graph_carriers: ${passed}/4 组通过（legacy oracle 双跑比对）`);
} finally {
	rmSync(ROOT, { recursive: true, force: true });
}
