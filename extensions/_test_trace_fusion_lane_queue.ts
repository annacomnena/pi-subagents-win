/**
 * _test_trace_fusion_lane_queue.ts — laneConcurrency 续发侧（2026-10-30）
 *
 * 锁定 resumeQueuedLane 的纯逻辑：
 *   ① 无队列文件 ⇒ no-queue（存量全并发路径零影响）
 *   ② 队列空 ⇒ empty
 *   ③ 名额已满 ⇒ no-capacity，且**零 spawn**
 *   ④ 有名额 ⇒ 派队首、移出队列、回写 meta.lanes[X].tabRunId、写计时器
 *   ⑤ 队列派完 ⇒ 删除队列文件
 *
 * 用 fake spawner + 临时目录；不碰真实 tab / 真实 config。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resumeQueuedLane, readLaneQueue, writeLaneQueue, markLaneQueueDrained } from "./trace-fusion/lane-queue.ts";
import type { TraceRunMeta } from "./trace-fusion/types.ts";
import type { TabLaunchOptions } from "./tab-launch-core.ts";

type Call = TabLaunchOptions & { __prompt: string };
function makeFakeSpawner() {
	const calls: Call[] = [];
	const spawner = (opts: TabLaunchOptions) => {
		calls.push({ ...opts, __prompt: String(opts.prompt ?? "") });
		return { title: opts.title, prompt: opts.prompt, model: opts.model };
	};
	return { spawner, calls };
}

const root = mkdtempSync(join(tmpdir(), "tf-laneq-"));
try {
	const mkMeta = (runDir: string, lanes: Record<"A" | "B" | "C", string>): TraceRunMeta => ({
		runId: "run_test",
		shortId: "test",
		status: "running",
		mode: "diagnose",
		task: "任务",
		repoRoot: root,
		createdAt: new Date().toISOString(),
		baseCommit: "deadbeef",
		headBefore: "deadbeef",
		runDir,
		wtDir: "",
		dispatcherSessionId: "sess-dispatcher-0001",
		laneWallClockMin: 45,
		laneDeadlineAt: new Date(Date.now() + 45 * 60_000).toISOString(),
		lanes: {
			A: { lane: "A", worktree: root, tabRunId: lanes.A, provision: { junction: [], copied: [], commandOk: true, degraded: false, issues: [] } },
			B: { lane: "B", worktree: root, tabRunId: lanes.B, provision: { junction: [], copied: [], commandOk: true, degraded: false, issues: [] } },
			C: { lane: "C", worktree: root, tabRunId: lanes.C, provision: { junction: [], copied: [], commandOk: true, degraded: false, issues: [] } },
		},
	});
	const mkRun = (name: string) => { const d = join(root, name); mkdirSync(d, { recursive: true }); return d; };
	const base = (runDir: string, meta: TraceRunMeta, over: Partial<Parameters<typeof resumeQueuedLane>[0]> = {}) => ({
		meta, tabRunsDir: join(runDir, "tab-runs"), concurrency: 1,
		wtExe: "wt.exe", piCli: "pi.cmd",
		workerModelFor: () => "prov/x",
		rereadMeta: () => meta,
		...over,
	});

	// ① 无队列
	{
		const d = mkRun("q-none");
		const r = resumeQueuedLane(base(d, mkMeta(d, { A: "tab_a", B: "", C: "" }), { spawnTab: makeFakeSpawner().spawner }));
		assert.equal(r.resumed, false);
		assert.equal((r as { reason: string }).reason, "no-queue");
	}

	// ② 队列空
	{
		const d = mkRun("q-empty");
		markLaneQueueDrained(d, 1); // 显式空队列（保留文件），区别于"无队列"
		const r = resumeQueuedLane(base(d, mkMeta(d, { A: "tab_a", B: "", C: "" }), { spawnTab: makeFakeSpawner().spawner }));
		assert.equal(r.resumed, false);
		assert.equal((r as { reason: string }).reason, "empty");
	}

	// ③ 名额满 ⇒ 零 spawn（A 已派且未终态，并发度 1）
	{
		const d = mkRun("q-full");
		writeLaneQueue(d, { lanes: ["B", "C"], concurrency: 1 });
		const { spawner, calls } = makeFakeSpawner();
		const r = resumeQueuedLane(base(d, mkMeta(d, { A: "tab_a", B: "", C: "" }), { spawnTab: spawner }));
		assert.equal(r.resumed, false);
		assert.equal((r as { reason: string }).reason, "no-capacity");
		assert.equal(calls.length, 0, "无名额必须零 spawn");
	}

	// ④ 有名额 ⇒ 派队首 + 移出队列 + 回写 meta + 删队列（队列只剩一条）
	{
		const d = mkRun("q-ok");
		writeLaneQueue(d, { lanes: ["B", "C"], concurrency: 1 });
		const meta = mkMeta(d, { A: "tab_a", B: "", C: "" });
		// A 已终态（写 result.json）⇒ 名额空出
		mkdirSync(join(d, "tab-runs"), { recursive: true });
		writeFileSync(join(d, "tab-runs", "tab_a.result.json"), "{}");
		const { spawner, calls } = makeFakeSpawner();
		const r = resumeQueuedLane(base(d, meta, { spawnTab: spawner }));
		assert.equal(r.resumed, true, `应有名额：${JSON.stringify(r)}`);
		if (r.resumed) {
			assert.equal(r.lane, "B", "派队首 B");
			assert.deepEqual(r.remaining, ["C"], "队列剩 C");
			assert.equal(calls.length, 1, "只派一条");
			assert.equal(meta.lanes.B.tabRunId, r.tabRunId, "meta 回写新 tabRunId");
			const q = readLaneQueue(d);
			assert.ok(q, "队列仍在");
			assert.deepEqual(q!.lanes, ["C"], "磁盘队列剩 C");
			assert.ok(existsSync(join(d, "meta.json")), "meta.json 已落盘");
			assert.equal(JSON.parse(readFileSync(join(d, "meta.json"), "utf8")).lanes.B.tabRunId, r.tabRunId);
		}
	}

	// ⑤ 队列最后一条派完 ⇒ 删除队列文件
	{
		const d = mkRun("q-last");
		writeLaneQueue(d, { lanes: ["C"], concurrency: 1 });
		const meta = mkMeta(d, { A: "tab_a", B: "tab_b", C: "" });
		mkdirSync(join(d, "tab-runs"), { recursive: true });
		writeFileSync(join(d, "tab-runs", "tab_a.result.json"), "{}");
		writeFileSync(join(d, "tab-runs", "tab_b.result.json"), "{}");
		const { spawner } = makeFakeSpawner();
		const r = resumeQueuedLane(base(d, meta, { spawnTab: spawner }));
		assert.equal(r.resumed, true);
		if (r.resumed) {
			assert.equal(r.lane, "C");
			assert.equal(existsSync(join(d, "lane-queue.json")), false, "队列空了必须删文件");
		}
	}

	// ⑥ 并发度 2：A 在飞 + B 已终态 ⇒ 仍有名额
	{
		const d = mkRun("q-c2");
		writeLaneQueue(d, { lanes: ["C"], concurrency: 2 });
		const meta = mkMeta(d, { A: "tab_a", B: "tab_b", C: "" });
		mkdirSync(join(d, "tab-runs"), { recursive: true });
		writeFileSync(join(d, "tab-runs", "tab_b.result.json"), "{}");
		const { spawner } = makeFakeSpawner();
		const r = resumeQueuedLane(base(d, meta, { spawnTab: spawner, concurrency: 2 }));
		assert.equal(r.resumed, true, "并发 2 下 A 在飞但 B 已终态 ⇒ 应派 C");
	}

	// 溯源链接必须在**拿到真实 tabRunId 的那一刻**写（2026-11-02 乱回事故根因）：
	// 旧行为只在派发时一次性写三路，串行模式下 B/C 无 tabRunId ⇒ 空 targetId 死账
	// ⇒ recipientSessionIdFor 查不到归属 ⇒ 完成消息落回「先到先得」并乱投 global master。
	{
		const d = mkRun("linktrace");
		const meta = mkMeta(d, { A: "tab_a", B: "", C: "" });
		writeLaneQueue(d, { lanes: ["B", "C"], concurrency: 1 });
		// 并发 1 要续发 B，必须先让 A 终态（否则无名额 ⇒ no-capacity，续发不会发生）
		mkdirSync(join(d, "tab-runs"), { recursive: true });
		writeFileSync(join(d, "tab-runs", "tab_a.result.json"), JSON.stringify({ status: "completed" }));
		const linksPath = join(d, "links.jsonl");
		const { spawner } = makeFakeSpawner();
		const r = resumeQueuedLane(base(d, meta, { spawnTab: spawner, linksPath }));
		assert.equal(r.resumed, true, "应成功续发 B");
		const lines = readFileSync(linksPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
		const mine = lines.filter((l) => l.kind === "tab");
		assert.equal(mine.length, 1, "续发只写一条链接");
		assert.equal(mine[0].targetId, (r as { tabRunId: string }).tabRunId, "targetId 必须是真实 tabRunId");
		assert.ok(String(mine[0].targetId).startsWith("tab_"), "targetId 不得为空（空 targetId = 死账）");
		assert.equal(mine[0].sessionId, "sess-dispatcher-0001", "归属必须是派发者会话");
		assert.ok(String(mine[0].detail).includes("lane=B"), "detail 要带 lane");
		void meta;
	}

	console.log("trace-fusion lane-queue tests passed");
} finally {
	try { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* 尽力 */ }
}
