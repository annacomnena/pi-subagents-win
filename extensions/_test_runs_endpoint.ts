/**
 * _test_runs_endpoint.ts — 档 A「运行态可视化」M1 的数据面测试（`GET /v1/runs`）。
 *
 * 覆盖：
 *   T1 卡片投影契约：version/count/total 正确；字段面与冻结契约一致（不缺不多）
 *   T2 三态 liveness：running+活 pid → alive；running 无 pid → unknown；completed 无 pid → unknown；
 *      failed+死 pid → dead。**unknown 不得被投影成 running/dead**
 *   T3 usage 缺失 ⇒ null（运行中常态）；有 result.usage ⇒ 六字段齐全
 *   T4 limit 在排序之后截断（`?limit=2` ⇒ count=2 且 total=4）
 *   T5 includeRecentCalls=1 ⇒ recentCalls ≤3（newest-first）+ argsDigest ≤160 + loopVerdict 终态恒
 *      unknown；缺省 ⇒ 字段**不存在**
 *   T6 HTTP 真入口：起 server（runsDir=夹具）→ 200 + etag 头；带 If-None-Match 再请求 → 304 空体；
 *      W/ 前缀与列表形式也命中；内容变化 → 200 且 ETag 变
 *   T7 纯读：整轮调用前后夹具目录树（文件名 + 内容哈希）不变
 *   T8 never-throw：runsDir 不存在 / 含坏 json ⇒ 200 且坏文件被跳过
 *
 * 夹具纪律（AGENTS §5）：字段形状照**真实 run json 实测字段集**（154 份实测：
 * id/agent/task/status/startedAt/result 100%，recentCalls 153/154，pid 仅 1/154），
 * 不造真实记录里不存在的形状（如 `round()` 式缺 timestamp）。
 *
 * 运行：npm run test:runs-endpoint
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "runs-endpoint-"));
process.env.PI_RUNTIME_DIR = join(ROOT, "runtime");
process.env.PI_SUBAGENT_RUNS_DIR = join(ROOT, "subagent-runs-env");
mkdirSync(process.env.PI_RUNTIME_DIR, { recursive: true });

// 动态 import（AGENTS「模块加载时读 env」纪律）：`subagent-kill.ts` 在**模块加载时**固定
// `DEFAULT_RUNS_DIR = env.PI_SUBAGENT_RUNS_DIR ?? ~/.pi/agent/subagent-runs`，静态 import 会被
// 提升到上面两行 env 赋值之前执行 ⇒ 夹具 env 失效并读到真实目录。必须 await import。
const { createRuntimeHostServer } = (await import("./runtime-host/server.ts")) as typeof import("./runtime-host/server.ts");
const { DEFAULT_RUNS_DIR, RUNS_LIMIT_MAX, classifyRunLiveness, isPidAlive, listAsyncRunCards } = await import("./subagent-kill.ts");
import type { RuntimeHostHandle } from "./runtime-host/server.ts";
import type { RunCard } from "./subagent-kill.ts";

let n = 0;
const ok = (name: string): void => {
	n += 1;
	console.log(`ok ${n} - ${name}`);
};

const FIX = join(ROOT, "runs");
mkdirSync(FIX, { recursive: true });

const DEAD_PID = 2147483647; // 实测进程不存在（process.kill 抛 ESRCH）
assert.equal(isPidAlive(DEAD_PID), false, "夹具前提：DEAD_PID 必须判死");

const T0 = "2026-10-22T06:00:00.000Z";
const iso = (min: number): string => new Date(Date.parse(T0) + min * 60_000).toISOString();

/** 真实记录里出现过的完整字段集（照 §1 活体样本 + 终态样本）。 */
function writeRun(id: string, over: Record<string, unknown>): void {
	const rec = {
		id,
		agent: "general",
		task: "只做一件事：调用 bash 工具执行 `sleep 150` 然后原样回报结果",
		status: "completed",
		startedAt: iso(0),
		result: {
			status: "completed",
			text: "done",
			usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 0, cost: 0.0123, turns: 2 },
			usageEvents: [],
			runId: id,
			agent: "general",
		},
		recentCalls: [
			{ tool: "bash", argsDigest: "{\"command\":\"sleep 150\",\"timeout\":200}", ts: iso(1), turn: 1 },
		],
		...over,
	};
	writeFileSync(join(FIX, `${id}.json`), JSON.stringify(rec), "utf8");
}

// a) running + 活 pid（process.pid 恒活）
writeRun("run_alive", {
	status: "running",
	startedAt: iso(0),
	pid: process.pid,
	pidRecordedAt: iso(0),
	pidCmdMarker: process.execPath,
	lastActivity: iso(1),
	lastToolTurn: 1,
	turnClock: 1,
	// 运行中**没有** result（实测 3/3 采样）：显式删掉，验 usage=null
	result: undefined,
});
// b) running 无 pid → unknown
writeRun("run_unknown_running", { status: "running", startedAt: iso(2), result: undefined });
// c) completed 无 pid → unknown
writeRun("run_completed", { status: "completed", startedAt: iso(3) });
// d) failed + 死 pid → dead
writeRun("run_dead", {
	status: "failed",
	startedAt: iso(4),
	pid: DEAD_PID,
	pidRecordedAt: iso(4),
	lastActivity: iso(9),
	recentCalls: [
		{ tool: "bash", argsDigest: "a".repeat(300), ts: iso(5), turn: 1 },
		{ tool: "read", argsDigest: "b".repeat(40), ts: iso(6), turn: 2 },
		{ tool: "write", argsDigest: "c".repeat(40), ts: iso(7), turn: 3 },
		{ tool: "edit", argsDigest: "d".repeat(40), ts: iso(8), turn: 4 },
	],
});

// ── T1/T2/T3/T5 纯函数层（listAsyncRunCards）────────────────────────
{
	const { total, runs } = listAsyncRunCards(FIX, { limit: 10, includeRecentCalls: true });
	assert.equal(total, 4, "total = 截断前记录数");
	assert.equal(runs.length, 4);
	// running 优先；组内 startedAt 降序（run_unknown_running 02 > run_alive 00）
	assert.deepEqual(
		runs.map((r) => r.id),
		["run_unknown_running", "run_alive", "run_dead", "run_completed"],
		"排序：running 优先 → startedAt 降序",
	);
	ok("T1a total/count 与排序（running 优先 → startedAt 降序）");

	const byId = new Map<string, RunCard>(runs.map((r) => [r.id, r] as [string, RunCard]));
	const alive = byId.get("run_alive")!;
	const unknown = byId.get("run_unknown_running")!;
	const completed = byId.get("run_completed")!;
	const dead = byId.get("run_dead")!;

	// 字段面冻结：无 idleMs / 无相对量
	for (const k of ["id", "agent", "taskPreview", "status", "liveness", "pid", "startedAt", "lastActivity", "usage", "recentCalls", "loopVerdict"] as const) {
		assert.ok(k in alive, `契约字段 ${k} 必须存在`);
	}
	for (const banned of ["idleMs", "ageMs", "idle"]) assert.ok(!(banned in alive), `不得包含 ${banned}（会让 ETag 永不命中）`);
	ok("T1b 卡片字段面冻结且不含 idleMs/相对量");

	assert.equal(alive.liveness, "alive", "running + 活 pid → alive");
	assert.equal(alive.pid, process.pid);
	assert.equal(unknown.liveness, "unknown", "running 无 pid → unknown（不猜活）");
	assert.equal(unknown.pid, null);
	assert.equal(completed.liveness, "unknown", "completed 无 pid → unknown（不猜死）");
	assert.equal(dead.liveness, "dead", "failed + 死 pid → dead");
	assert.equal(dead.pid, DEAD_PID);
	ok("T2 三态 liveness 各命中一次（alive/unknown/unknown/dead 共 4 条 3 态）");

	// unknown 不得被投影成 running 的「活着」：卡片 liveness 是唯一判活字段
	assert.notEqual(unknown.liveness, "alive", "unknown ≠ alive（反向断言：不得把未知当运行中）");
	assert.notEqual(completed.liveness, "dead", "无 pid 不得判死（缺 pid 是常态，2/154 带 pid）");
	ok("T2b 反向断言：unknown 既不是 alive 也不是 dead");

	assert.equal(alive.usage, null, "运行中无 result.usage → null（不从别处推断）");
	assert.equal(completed.usage?.input, 100);
	assert.equal(completed.usage?.cacheRead, 30);
	assert.equal(completed.usage?.cost, 0.0123);
	assert.equal(completed.usage?.turns, 2);
	ok("T3 usage：缺失 ⇒ null；存在 ⇒ 六字段齐全");

	assert.equal(alive.lastActivity, iso(1), "lastActivity 优先取脉搏");
	assert.equal(completed.lastActivity, iso(3), "无脉搏回退 startedAt");
	assert.equal(alive.taskPreview.length <= 40, true, "taskPreview ≤40 字符");
	ok("T3b lastActivity 回退链 + taskPreview 截断");

	assert.ok(Array.isArray(dead.recentCalls));
	assert.equal(dead.recentCalls!.length, 3, "recentCalls 最多 3 条");
	assert.equal(dead.recentCalls![0]!.tool, "edit", "newest-first（最后一条调用排第一）");
	assert.equal(dead.recentCalls![2]!.tool, "read");
	for (const c of dead.recentCalls!) assert.ok(c.argsDigest.length <= 160, `argsDigest ≤160（实际 ${c.argsDigest.length}）`);
	assert.equal(dead.loopVerdict, "unknown", "终态 verdict 恒 unknown（终态不是卡住证据）");
	assert.equal(alive.loopVerdict, "ok", "running 真算 verdict");
	ok("T5 includeRecentCalls=1：≤3 条/newest-first/argsDigest≤160/终态 verdict=unknown");

	const noDetail = listAsyncRunCards(FIX, { limit: 10 });
	for (const r of noDetail.runs) {
		assert.ok(!("recentCalls" in r), "缺省时 recentCalls 字段不存在");
		assert.ok(!("loopVerdict" in r), "缺省时 loopVerdict 字段不存在");
	}
	ok("T5b includeRecentCalls 缺省 ⇒ 两字段不存在（不是空数组）");

	const limited = listAsyncRunCards(FIX, { limit: 2 });
	assert.equal(limited.runs.length, 2, "limit=2 生效");
	assert.equal(limited.total, 4, "total 仍是全集");
	assert.deepEqual(limited.runs.map((r) => r.id), ["run_unknown_running", "run_alive"], "limit 截断在排序之后");
	ok("T4 limit=2 在排序之后截断（total 保持全集）");

	assert.equal(listAsyncRunCards(FIX, { limit: 9999 }).runs.length, 4, "超上限仍返回全集（4 < 上限）");
	assert.equal(RUNS_LIMIT_MAX, 200);
	assert.equal(listAsyncRunCards(FIX).runs.length, 4);
	ok("T4b limit 上限/缺省不改变本次结果");
}

// ── T7 纯读：目录树（文件名 + sha256）前后一致 ─────────────────────
function treeHash(dir: string): string {
	const h = createHash("sha256");
	for (const f of readdirSync(dir).sort()) {
		h.update(f);
		h.update(readFileSync(join(dir, f)));
	}
	return h.digest("hex");
}
const beforeHash = treeHash(FIX);
{
	listAsyncRunCards(FIX, { limit: 10, includeRecentCalls: true });
	assert.equal(treeHash(FIX), beforeHash, "listAsyncRunCards 不得写盘");
	ok("T7a 卡片投影零写盘（目录树哈希不变）");
}

// ── T6 HTTP 真入口 ─────────────────────────────────────────────────
{
	let h: RuntimeHostHandle | null = null;
	try {
		h = await createRuntimeHostServer({
			hostPath: join(ROOT, "host.json"),
			stateDir: join(ROOT, "state"),
			mailboxDir: join(ROOT, "mailbox"),
			journalPath: join(ROOT, "journal.jsonl"),
			sessionsDir: join(ROOT, "sessions"),
			runsDir: FIX,
			lockWaitMs: 1000,
		});
		const base = `http://127.0.0.1:${h.info.port}`;
		const hashBeforeHttp = treeHash(FIX);

		const r1 = await fetch(`${base}/v1/runs?limit=10`);
		assert.equal(r1.status, 200, `/v1/runs 200（实际 ${r1.status}）`);
		const etag1 = r1.headers.get("etag");
		assert.ok(etag1, "200 带 etag 头");
		const b1 = (await r1.json()) as { version: number; asof: string; count: number; total: number; runs: RunCard[] };
		assert.equal(b1.version, 1);
		assert.equal(b1.count, 4);
		assert.equal(b1.total, 4);
		assert.equal(typeof b1.asof, "string");
		assert.equal(b1.runs.length, 4);
		ok("T6a HTTP 200：version/count/total/asof/runs 契约齐");

		// ETag 命中 → 304 空体
		const r2 = await fetch(`${base}/v1/runs?limit=10`, { headers: { "if-none-match": etag1 } });
		assert.equal(r2.status, 304, `INM 命中 → 304（实际 ${r2.status}）`);
		assert.equal((await r2.text()).length, 0, "304 空体");
		ok("T6b If-None-Match 命中 → 304 空体");

		const r2b = await fetch(`${base}/v1/runs?limit=10`, { headers: { "if-none-match": `W/${etag1}, "other"` } });
		assert.equal(r2b.status, 304, "W/ 前缀 + 列表形式命中 304");
		const r2c = await fetch(`${base}/v1/runs?limit=10`, { headers: { "if-none-match": "" } });
		assert.equal(r2c.status, 200, "空 INM → 200 全量（旧客户端）");
		ok("T6c W/ 前缀与列表形式命中；空 INM 照常 200");

		// asof 变化不影响 ETag（两次 200 的 etag 相同）
		const r3 = await fetch(`${base}/v1/runs?limit=10`);
		assert.equal(r3.headers.get("etag"), etag1, "ETag 排除 asof（响应时间戳不是状态）");
		ok("T6d ETag 排除 asof（相邻两拍同 ETag）");

		// 纯读：到目前为止全是 GET，夹具目录树一字未变
		assert.equal(treeHash(FIX), hashBeforeHttp, "HTTP 读请求不得改动 run 记录（零写盘）");
		ok("T7b HTTP GET 链路零写盘（夹具目录树哈希不变）");

		// 内容变化 → ETag 变 + 旧 INM 不再命中
		writeRun("run_alive", { status: "completed", startedAt: iso(0), lastActivity: iso(2) });
		const hashAfterMutation = treeHash(FIX);
		assert.notEqual(hashAfterMutation, hashBeforeHttp, "夹具确由测试自身改写（ETag 变化的前提）");
		const r4 = await fetch(`${base}/v1/runs?limit=10`, { headers: { "if-none-match": etag1 } });
		assert.equal(r4.status, 200, "内容变化 → 200");
		const etag2 = r4.headers.get("etag");
		assert.ok(etag2 && etag2 !== etag1, "ETag 随内容变化");
		ok("T6e 内容变化 → ETag 变、旧 INM 不再命中");

		// HTTP 层 limit 生效（真接线：query 解析 → 投影 limit）
		const r5 = (await (await fetch(`${base}/v1/runs?limit=2`)).json()) as { count: number; total: number };
		assert.equal(r5.count, 2, "HTTP ?limit=2 → count=2");
		assert.equal(r5.total, 4, "HTTP ?limit=2 → total=4");
		ok("T6f HTTP ?limit=2 生效且 total 保持全集");

		// HTTP 层 includeRecentCalls
		const r6 = (await (await fetch(`${base}/v1/runs?includeRecentCalls=1`)).json()) as { runs: RunCard[] };
		assert.ok(r6.runs.every((x) => Array.isArray(x.recentCalls) && x.recentCalls.length <= 3), "recentCalls ≤3");
		assert.ok(r6.runs.every((x) => x.recentCalls !== undefined && x.recentCalls.every((c) => c.argsDigest.length <= 160)));
		const r6b = (await (await fetch(`${base}/v1/runs`)).json()) as { runs: RunCard[] };
		assert.ok(r6b.runs.every((x) => !("recentCalls" in x)), "缺省无 recentCalls");
		ok("T6g HTTP includeRecentCalls=1/缺省 两端行为正确");

		// POST → 405（GET-only 纪律）
		const r7 = await fetch(`${base}/v1/runs`, { method: "POST" });
		assert.equal(r7.status, 405, "POST /v1/runs → 405");
		ok("T6h POST /v1/runs → 405（只读端点）");

		assert.equal(treeHash(FIX), hashAfterMutation, "后续读请求仍零写盘");
	} finally {
		if (h !== null) await h.close();
	}
}

// ── T8 never-throw ─────────────────────────────────────────────────
{
	assert.deepEqual(listAsyncRunCards(join(ROOT, "does-not-exist"), { limit: 5 }), { total: 0, runs: [] }, "目录缺失 → 空投影");
	writeFileSync(join(FIX, "bad.json"), "{not json", "utf8");
	const { total } = listAsyncRunCards(FIX, { limit: 10 });
	assert.equal(total, 4, "坏 json 被跳过（4 条有效记录）");
	rmSync(join(FIX, "bad.json"));
	ok("T8 never-throw：目录缺失 → 空；坏 json 跳过不炸");
}

// ── T10 非法 pid 的判活边界（L4 审查遗留缺口：负数/0/浮点/字符串/NaN）────
// 口径：**只有真正可用于进程查活的 pid 才判 dead**；非法值一律 unknown（不猜死、不猜活）。
// 反例驱动：若把非法值当 dead，UI 会把「没登记 pid」的历史记录谎报成「进程已退出」。
{
	for (const [label, raw] of [
		["负数", -1],
		["0", 0],
		["浮点", 1234.5],
		["字符串数字", "1234"],
		["NaN", Number.NaN],
		["Infinity", Number.POSITIVE_INFINITY],
		["null", null],
		["undefined", undefined],
	] as [string, unknown][]) {
		const r = classifyRunLiveness(raw);
		assert.equal(r.liveness, "unknown", `非法 pid（${label}）→ unknown`);
		assert.equal(r.pid, null, `非法 pid（${label}）→ pid null（不透传脏值）`);
	}
	assert.equal(classifyRunLiveness(DEAD_PID).liveness, "dead", "合法但不存在的 pid 仍是 dead（不能被上面收成 unknown）");
	ok("T10 非法 pid（负/0/浮点/字符串/NaN/Infinity/null/undefined）一律 unknown，合法死 pid 仍 dead");
}

// ── 环境口径：DEFAULT_RUNS_DIR 读 env（未被本测试污染真实目录）──────
assert.equal(DEFAULT_RUNS_DIR, process.env.PI_SUBAGENT_RUNS_DIR, "DEFAULT_RUNS_DIR 走 PI_SUBAGENT_RUNS_DIR 口径");
ok("T9 DEFAULT_RUNS_DIR 与 PI_SUBAGENT_RUNS_DIR 同源（测试零污染真实目录）");

rmSync(ROOT, { recursive: true, force: true });
console.log(`_test_runs_endpoint: all assertions passed (${n} groups)`);
