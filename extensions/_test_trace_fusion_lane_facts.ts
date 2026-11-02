/**
 * lane 参与事实测试（2026-11-02，状态机修复 ④）
 *
 * 锁的是**收集分母**这条线（缺陷本体：supervisor 固定等三份 result.json ⇒
 * 被 skip / spawn 失败 / tab 进程死的 lane 永远让 `done` 差一个 ⇒ 永不自动收集，
 * run 停在 running 占住 active-run-mutex ⇒ 一次 wt.exe 启动失败锁死 trace-fusion）。
 *
 * 断言面：
 *  ① 每 lane 的判据分类（done/running/queued/terminal-no-result/dead/skipped/dispatch-failed）；
 *  ② 降级集合 = 不可用 lane（queued 不算降级）；
 *  ③ 死亡判据只用 pid 探活 ∨ 心跳超阈，**绝不用 lastActivityAt**（tab-runs.ts 注释里的
 *     61min 冻结误杀事故就是判据选错的代价）；
 *  ④ 「在队待发 + 无 state」⇒ queued（不进分母、不算死）；
 *  ⑤ meta 无 tabRunId 且不在队列 ⇒ dispatch-failed 一等终态（缺陷本体的直接反例）；
 *  ⑥ writeDegradedLanes 必须把原因写进 meta（不得静默，R-2）；
 *  ⑦ seedDispatchState 接线：派发即登记 pid+心跳，且**不得覆盖已存在的活状态**。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { degradedFacts, laneFacts, seedDispatchState, writeDegradedLanes, HEARTBEAT_DEAD_MS } from "./trace-fusion/lane-facts.ts";
import { tabStatePath } from "./tab-runs.ts";
import type { LaneId, TraceRunMeta } from "./trace-fusion/types.ts";

const root = mkdtempSync(join(tmpdir(), "tf-lanefacts-"));
const tabRunsDir = join(root, "tab-runs");
const runDir = join(root, "run");
mkdirSync(tabRunsDir, { recursive: true });
mkdirSync(runDir, { recursive: true });

const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);
const now = () => NOW;

const mkMeta = (
	lanes: Partial<Record<LaneId, { tabRunId?: string; laneStatus?: string; reason?: string }>>,
): TraceRunMeta =>
	({
		runId: "tfl-lf",
		runDir,
		lanes: {
			A: { lane: "A", worktree: "", tabRunId: lanes.A?.tabRunId ?? "", provision: {} as never, laneStatus: lanes.A?.laneStatus as never, laneStatusReason: lanes.A?.reason },
			B: { lane: "B", worktree: "", tabRunId: lanes.B?.tabRunId ?? "", provision: {} as never, laneStatus: lanes.B?.laneStatus as never, laneStatusReason: lanes.B?.reason },
			C: { lane: "C", worktree: "", tabRunId: lanes.C?.tabRunId ?? "", provision: {} as never, laneStatus: lanes.C?.laneStatus as never, laneStatusReason: lanes.C?.reason },
		},
	} as unknown as TraceRunMeta);

const writeState = (id: string, st: Record<string, unknown>) => writeFileSync(tabStatePath(tabRunsDir, id), JSON.stringify(st), "utf8");
const writeResult = (id: string) => writeFileSync(join(tabRunsDir, `${id}.result.json`), JSON.stringify({ status: "completed", summary: "s" }), "utf8");

try {
	// ── ①④⑤ 分类与分母 ──
	{
		writeResult("tabA"); // A 有结果
		writeState("tabB", { id: "tabB", phase: "working", turn: "working", terminal: false, pid: process.pid, heartbeatAt: new Date(NOW).toISOString() }); // B 活
		// C：无 tabRunId、不在队列 ⇒ 派发失败空洞（缺陷本体）
		const meta = mkMeta({ A: { tabRunId: "tabA" }, B: { tabRunId: "tabB" }, C: { tabRunId: "" } });
		const f = laneFacts(meta, tabRunsDir, { now });
		const by = (l: LaneId) => f.find((x) => x.lane === l)!;
		assert.equal(by("A").status, "done", "有 result.json ⇒ done");
		assert.equal(by("B").status, "running", "活 pid ⇒ 在跑");
		assert.equal(by("C").status, "dispatch-failed", "无 tabRunId 且不在队列 ⇒ 一等终态（旧版这里让收集永远差一个）");
		assert.equal(degradedFacts(f).length, 1, "降级集合只含不可用 lane（C）");

		// 同一个 C 若在待发队列里 ⇒ queued（不进分母，也不算降级）
		const f2 = laneFacts(meta, tabRunsDir, { now, queuePending: new Set<LaneId>(["C"]) });
		assert.equal(f2.find((x) => x.lane === "C")!.status, "queued", "在队待发 ⇒ queued");
		assert.equal(degradedFacts(f2).length, 0, "queued 不得算降级");
	}

	// ── skipped / dispatch-failed 直接采信 meta ──
	{
		const meta = mkMeta({ A: { tabRunId: "", laneStatus: "skipped", reason: "KV 池不足" }, B: { tabRunId: "tabB2" }, C: { tabRunId: "tabC2" } });
		writeResult("tabB2");
		writeResult("tabC2");
		const f = laneFacts(meta, tabRunsDir, { now });
		assert.equal(f.find((x) => x.lane === "A")!.status, "skipped", "meta 标 skipped ⇒ 采信");
		assert.ok(f.find((x) => x.lane === "A")!.reason.includes("KV 池不足"), "原因要带出来");
		assert.equal(degradedFacts(f).length, 1, "A 是降级项");
	}

	// ── ③ 死亡判据：pid 探活 / 心跳超阈；lastActivityAt 一律不参与 ──
	{
		writeState("tabDead", { id: "tabDead", phase: "working", turn: "working", terminal: false, pid: 999_999, heartbeatAt: new Date(NOW).toISOString() });
		// 心跳新鲜 + lastActivityAt 冻结 61min ⇒ **不得判死**（tab-runs.ts 注释里的误杀事故）
		writeState("tabLongTool", {
			id: "tabLongTool",
			phase: "working",
			turn: "working",
			terminal: false,
			pid: process.pid,
			heartbeatAt: new Date(NOW).toISOString(),
			lastActivityAt: new Date(NOW - 61 * 60_000).toISOString(),
		});
		// pid 缺失 + 心跳超阈 ⇒ 判死
		writeState("tabNoPid", { id: "tabNoPid", phase: "working", turn: "working", terminal: false, heartbeatAt: new Date(NOW - HEARTBEAT_DEAD_MS - 1000).toISOString() });
		const meta = mkMeta({ A: { tabRunId: "tabDead" }, B: { tabRunId: "tabLongTool" }, C: { tabRunId: "tabNoPid" } });
		const f = laneFacts(meta, tabRunsDir, { now });
		const by = (l: LaneId) => f.find((x) => x.lane === l)!;
		assert.equal(by("A").status, "dead", "pid 不在 ⇒ dead");
		assert.equal(by("B").status, "running", "lastActivityAt 冻结 61min 不得判死（长工具调用不写 state，实测误杀过）");
		assert.equal(by("C").status, "dead", "pid 缺失且心跳超阈 ⇒ dead");
		assert.ok(by("C").reason.includes("心跳"), "原因要写明依据是心跳");

		// terminal=true 且无结果 ⇒ terminal-no-result（可收集，不是"在跑"）
		writeState("tabTerm", { id: "tabTerm", phase: "failed", turn: "error", terminal: true, pid: process.pid, heartbeatAt: new Date(NOW).toISOString() });
		const f2 = laneFacts(mkMeta({ A: { tabRunId: "tabTerm" }, B: { tabRunId: "tabLongTool" }, C: { tabRunId: "tabLongTool" } }), tabRunsDir, { now });
		assert.equal(f2.find((x) => x.lane === "A")!.status, "terminal-no-result", "tab 终态无结果 ⇒ 计入终态");
	}

	// ── 无 state 文件 ⇒ 保守在跑（绝不当作全部终态提前收集） ──
	{
		const f = laneFacts(mkMeta({ A: { tabRunId: "tabNoState" }, B: { tabRunId: "tabNoState" }, C: { tabRunId: "tabNoState" } }), tabRunsDir, { now });
		assert.ok(f.every((x) => x.status === "running"), "无 state 无从判活 ⇒ 保守在跑，不得提前收集");
		assert.ok(f.every((x) => x.reason.includes("保守")), "理由要在场（不得静默）");
	}

	// ── ⑥ 降级必须写进 meta ──
	{
		const meta = mkMeta({ A: { tabRunId: "tabA" }, B: { tabRunId: "", laneStatus: "skipped", reason: "池不足" }, C: { tabRunId: "tabC3" } });
		writeResult("tabA");
		writeResult("tabC3");
		const metaPathLocal = join(runDir, "meta.json");
		writeFileSync(metaPathLocal, JSON.stringify({ runId: "tfl-lf", status: "running" }), "utf8");
		const ok = writeDegradedLanes(meta, laneFacts(meta, tabRunsDir, { now }), now);
		assert.ok(ok, "写 meta 必须成功");
		const raw = JSON.parse(readFileSync(metaPathLocal, "utf8")) as { degradedLanes?: { lane: string; reason: string }[] };
		assert.equal(raw.degradedLanes?.length, 1, "meta 必须带 degradedLanes（不得静默）");
		assert.ok(raw.degradedLanes![0].reason.includes("池不足"), "降级原因要可读");
		// meta 不可写 ⇒ 返回 false（调用方要记日志，不得静默）
		mkdirSync(join(root, "badmeta"), { recursive: true });
		const bad = { ...meta, runDir: join(root, "badmeta", "meta.json") } as TraceRunMeta;
		assert.equal(writeDegradedLanes(bad, laneFacts(meta, tabRunsDir, { now }), now), false, "写失败必须返回 false");
	}

	// ── ⑦ seedDispatchState 接线 ──
	{
		seedDispatchState(tabRunsDir, "tabSeed", { title: "t", now });
		const p = tabStatePath(tabRunsDir, "tabSeed");
		assert.ok(existsSync(p), "派发时必须预置 state.json（dispatch 失败发生在 wt 启动之后 ⇒ 否则永无 state）");
		const st = JSON.parse(readFileSync(p, "utf8")) as { pid?: number; heartbeatAt?: string; terminal?: boolean };
		assert.equal(typeof st.pid, "number", "必须带 pid（死亡判据要用它）");
		assert.ok(st.heartbeatAt, "必须带心跳");
		assert.equal(st.terminal, false, "预置状态不是终态");
		// 已存在 ⇒ 不得覆盖（tab 侧写的活状态优先）
		writeFileSync(p, JSON.stringify({ id: "tabSeed", phase: "working", turn: "working", terminal: false, pid: 4242, heartbeatAt: "KEEP" }), "utf8");
		seedDispatchState(tabRunsDir, "tabSeed", { now });
		const st2 = JSON.parse(readFileSync(p, "utf8")) as { pid?: number; heartbeatAt?: string };
		assert.equal(st2.pid, 4242, "seed 不得覆盖已存在的活状态");
		assert.equal(st2.heartbeatAt, "KEEP", "seed 不得覆盖心跳");
	}

	console.log("trace-fusion lane-facts tests passed");
} finally {
	try {
		rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
	} catch {
		/* 尽力 */
	}
}
