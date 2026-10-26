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
 *   T11 归属三态纯函数（indexRunAttribution）：complete/partial/unavailable + 四类残差
 *   T12 会话过滤（`?sessionId=`）：过滤在截断前、total=过滤后数、双身份（tab+owner）命中
 *   T13 参数 fail-closed：6 类非法参数 ⇒ 400，**带 `If-None-Match: *` 仍 400**（不是 304）
 *   T14 规范化：`b,a` 与 `a,b` 同 ETag；A 与 B 不同；304 空体
 *   T15 卡片新字段：dispatchedBy（冲突⇒null）/ durationMs（末次尝试，缺失⇒null）
 *   T16 links 不可读 / 解析异常率高 ⇒ `attribution:"unavailable"` 但缺省查询仍 200 全量
 *
 * 隔离纪律：links 账本用 `PI_LINKS_PATH` + 显式 `linksPath` 双双改道（绝不读真实
 * `~/.pi/agent/links.jsonl`——否则断言会随本机历史漂移）。
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
// 归属账本隔离（P1A）：同目录临时文件，零污染 ~/.pi/agent/links.jsonl。
process.env.PI_LINKS_PATH = join(ROOT, "links.jsonl");
mkdirSync(process.env.PI_RUNTIME_DIR, { recursive: true });

// 动态 import（AGENTS「模块加载时读 env」纪律）：`subagent-kill.ts` 在**模块加载时**固定
// `DEFAULT_RUNS_DIR = env.PI_SUBAGENT_RUNS_DIR ?? ~/.pi/agent/subagent-runs`，静态 import 会被
// 提升到上面两行 env 赋值之前执行 ⇒ 夹具 env 失效并读到真实目录。必须 await import。
const { createRuntimeHostServer } = (await import("./runtime-host/server.ts")) as typeof import("./runtime-host/server.ts");
const { DEFAULT_RUNS_DIR, RUNS_LIMIT_MAX, classifyRunLiveness, indexRunAttribution, isPidAlive, listAsyncRunCards } = await import("./subagent-kill.ts");
const { parseRunsSessionScope } = (await import("./runtime-host/server.ts")) as typeof import("./runtime-host/server.ts");
import type { RuntimeHostHandle } from "./runtime-host/server.ts";
import type { RunCard, RunAttributionDetail } from "./subagent-kill.ts";
import type { LinkRecord } from "./links.ts";

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
function writeRun(id: string, over: Record<string, unknown>, dir: string = FIX): void {
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
	writeFileSync(join(dir, `${id}.json`), JSON.stringify(rec), "utf8");
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
	// P1A 新增字段（version:1 后只增不改）：durationMs 恒存在（值可为 null）；
	// dispatchedBy 只在有 link 时出现（本夹具未传 links ⇒ 不存在）。
	assert.ok("durationMs" in completed, "durationMs 恒存在（值可为 null）");
	assert.equal(!("dispatchedBy" in alive), true, "未传 links ⇒ dispatchedBy 不存在（与冲突的 null 区分）");
	ok("T1b 卡片字段面冻结且不含 idleMs/相对量（+ durationMs/dispatchedBy 新增字段口径）");

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
			linksPath: join(ROOT, "links.jsonl"),
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
	assert.deepEqual(listAsyncRunCards(join(ROOT, "does-not-exist"), { limit: 5 }), {
		total: 0,
		runs: [],
		attribution: "unavailable",
		attributionDetail: { resolved: 0, tabUnmapped: 0, missing: 0, conflict: 0 },
	}, "目录缺失 → 空投影（未传 links ⇒ 归属 unavailable）");
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

// ── T11 归属三态纯函数 ─────────────────────────────────────────────
// 口径（§3.2）：分母 = 过滤前、去重后可读 run 数；三类残差互斥计数。
const link = (o: { sessionId: string; targetId: string; ownerSessionId?: string; kind?: string; at?: string }): LinkRecord =>
	({
		sessionId: o.sessionId,
		kind: (o.kind ?? "async") as LinkRecord["kind"],
		targetId: o.targetId,
		detail: "d",
		at: o.at ?? iso(0),
		pid: 1234,
		...(o.ownerSessionId !== undefined ? { ownerSessionId: o.ownerSessionId } : {}),
	});
const ZERO: RunAttributionDetail = { resolved: 0, tabUnmapped: 0, missing: 0, conflict: 0 };
const SX = "01a17608-0000-4000-8000-00000000000a";
const SY = "01a17608-0000-4000-8000-00000000000b";
const TAB1 = "tab_mvevitap_dlxf";
{
	// a) 全部 UUID 派发者 ⇒ complete
	const a = indexRunAttribution(["r1", "r2"], [link({ sessionId: SX, targetId: "r1" }), link({ sessionId: SY, targetId: "r2" })]);
	assert.equal(a.attribution, "complete", "全 UUID ⇒ complete");
	assert.deepEqual(a.attributionDetail, { ...ZERO, resolved: 2 });
	assert.equal(a.dispatchedBy.get("r1"), SX, "dispatchedBy = 直接派发者");
	ok("T11a 全可解析 ⇒ complete / resolved=分母");

	// b) tab 且在写时就记了 ownerSessionId ⇒ resolved（P1A 双身份的核心价值）
	const b = indexRunAttribution(["r1"], [link({ sessionId: TAB1, targetId: "r1", ownerSessionId: SX })]);
	assert.equal(b.attribution, "complete", "tab + ownerSessionId ⇒ 可映射 ⇒ complete");
	assert.deepEqual(b.matchableIds.get("r1"), [TAB1, SX], "双身份两路都可命中（sessionId + ownerSessionId）");
	assert.equal(b.dispatchedBy.get("r1"), TAB1, "dispatchedBy 是**直接**派发者（tab id），不是映射后的 pi 会话");
	ok("T11b tab + ownerSessionId ⇒ resolved，且 dispatchedBy 仍报直接派发者");

	// c) tab 且无 ownerSessionId（存量记录）⇒ tabUnmapped，不可映射
	const c = indexRunAttribution(["r1"], [link({ sessionId: TAB1, targetId: "r1" })]);
	assert.equal(c.attribution, "partial");
	assert.deepEqual(c.attributionDetail, { ...ZERO, tabUnmapped: 1 });
	assert.deepEqual(c.matchableIds.get("r1"), [TAB1], "只有 tab id 可与 scope 比对（UUID scope 命中不了——存量边界）");
	ok("T11c tab 无 owner ⇒ tabUnmapped（存量旧记录不做事后回填）");

	// d) 无 link ⇒ missing；非 async kind 不算归属证据
	const d = indexRunAttribution(["r1", "r2"], [link({ sessionId: SX, targetId: "r1", kind: "tab" })]);
	assert.equal(d.attribution, "partial");
	assert.deepEqual(d.attributionDetail, { ...ZERO, missing: 2 });
	assert.equal(d.dispatchedBy.has("r1"), false, "非 async link 不算归属（kind=tab 不得当成 async 派发者）");
	ok("T11d 无 async link ⇒ missing（kind≠async 不作数）");

	// e) 同一 targetId 多个不同派发者 ⇒ conflict，dispatchedBy=null（不取第一个）
	const e = indexRunAttribution(["r1"], [link({ sessionId: SX, targetId: "r1" }), link({ sessionId: SY, targetId: "r1" })]);
	assert.equal(e.attribution, "partial");
	assert.deepEqual(e.attributionDetail, { ...ZERO, conflict: 1 });
	assert.equal(e.dispatchedBy.get("r1"), null, "冲突 ⇒ dispatchedBy=null（**不取第一个**）");
	assert.equal(e.matchableIds.has("r1"), false, "冲突时不给可命中身份（不猜）");
	ok("T11e 多派发者 ⇒ conflict=1 且 dispatchedBy=null");

	// f) 同派发者但多个 owner ⇒ 映射歧义 ⇒ 也计 conflict（保守）
	const f = indexRunAttribution(["r1"], [
		link({ sessionId: TAB1, targetId: "r1", ownerSessionId: SX }),
		link({ sessionId: TAB1, targetId: "r1", ownerSessionId: SY }),
	]);
	assert.deepEqual(f.attributionDetail, { ...ZERO, conflict: 1 }, "同派发者多 owner ⇒ conflict（映射歧义不猜）");
	assert.equal(f.dispatchedBy.get("r1"), null);
	ok("T11f 同派发者多 owner ⇒ conflict（保守口径）");

	// g) 账本不可用 ⇒ unavailable，且**不**把 run 当 missing（不是“没有派发”）
	const g = indexRunAttribution(["r1", "r2"], null);
	assert.equal(g.attribution, "unavailable");
	assert.deepEqual(g.attributionDetail, ZERO, "unavailable 时残差计数全 0（不得混成 missing）");
	assert.equal(g.dispatchedBy.size, 0);
	ok("T11g links=null ⇒ unavailable（与 missing 严格区分）");
}

// ── T12 会话过滤（纯函数层：过滤在截断前、双身份命中、total=过滤后数）────────
const FIX2 = join(ROOT, "runs-scoped");
mkdirSync(FIX2, { recursive: true });
const LINK2 = join(ROOT, "links-scoped.jsonl");
const SESSIONS = {
	a: "01a17608-1111-4000-8000-0000000000aa",
	b: "01a17608-1111-4000-8000-0000000000bb",
	c: "01a17608-1111-4000-8000-0000000000cc",
};
const TAB_A = "tab_scoped_aaaa";
const TAB_OLD = "tab_scoped_old";
// 9 条可读 run：a 三个（含 1 条 tab+owner）、b 两个、c 一个、conflict 一个、tab 存量一个、无 link 一个。
for (const [id, min] of [
	["r_a1", 1], ["r_a2", 2], ["r_a3", 3], ["r_b1", 4], ["r_b2", 5],
	["r_c1", 6], ["r_conf", 7], ["r_tabold", 8], ["r_none", 9],
] as [string, number][]) {
	writeRun(id, { startedAt: iso(min), lastActivity: iso(min) }, FIX2);
}
writeFileSync(
	LINK2,
	[
		link({ sessionId: SESSIONS.a, targetId: "r_a1" }),
		link({ sessionId: TAB_A, targetId: "r_a2", ownerSessionId: SESSIONS.a }),
		link({ sessionId: SESSIONS.a, targetId: "r_a3" }),
		link({ sessionId: SESSIONS.b, targetId: "r_b1" }),
		link({ sessionId: SESSIONS.b, targetId: "r_b2" }),
		link({ sessionId: SESSIONS.c, targetId: "r_c1" }),
		link({ sessionId: SESSIONS.b, targetId: "r_conf" }),
		link({ sessionId: SESSIONS.c, targetId: "r_conf" }),
		link({ sessionId: TAB_OLD, targetId: "r_tabold" }),
	].map((l) => JSON.stringify(l)).join("\n") + "\n",
	"utf8",
);
const { readLinksWithStats } = (await import("./links.ts")) as typeof import("./links.ts");
const LINKS2 = readLinksWithStats(LINK2).links;
assert.equal(LINKS2.length, 9, "夹具前提：9 条 link");
{
	// 本机全量（无 scope）⇒ 不依赖 links 的“全量”语义：9 条全在
	const all = listAsyncRunCards(FIX2, { limit: 100, links: LINKS2 });
	assert.equal(all.total, 9, "无 scope ⇒ 9 条（total=`可读总数`）");
	assert.equal(all.attribution, "partial", "存在 tabUnmapped/conflict/missing ⇒ partial");
	assert.deepEqual(all.attributionDetail, { resolved: 6, tabUnmapped: 1, missing: 1, conflict: 1 }, "四类计数（分母：过滤前、去重后）");
	ok("T12a 无 scope ⇒ 全量 9 + attributionDetail 四类各命中一次");

	const a = listAsyncRunCards(FIX2, { limit: 100, links: LINKS2, sessionScope: [SESSIONS.a] });
	assert.deepEqual(a.runs.map((r) => r.id), ["r_a3", "r_a2", "r_a1"], "scope=A ⇒ 只回 A 的 3 条（含 tab+owner 那条）");
	assert.equal(a.total, 3, "total = **过滤后**数，不是本机总数 9");
	ok("T12b scope=A ⇒ 3 条（tab+ownerSessionId 精确命中；total=过滤后）");

	const ab = listAsyncRunCards(FIX2, { limit: 100, links: LINKS2, sessionScope: [SESSIONS.a, SESSIONS.b] });
	assert.equal(ab.total, 5, "scope=A,B ⇒ 5（多会话 union）");
	const cOnly = listAsyncRunCards(FIX2, { limit: 100, links: LINKS2, sessionScope: [SESSIONS.c] });
	assert.deepEqual(cOnly.runs.map((r) => r.id), ["r_c1"], "scope=C ⇒ 1 条（冲突的 r_conf 不归属任何一方）");
	ok("T12c 多会话 union；冲突 run 不落入任何 scope");

	// limit 必须在**过滤后**生效（否则小会话会被全局前 N 摊平到空）
	const aLimited = listAsyncRunCards(FIX2, { limit: 2, links: LINKS2, sessionScope: [SESSIONS.a] });
	assert.equal(aLimited.runs.length, 2, "limit=2 在过滤后生效 ⇒ 拿到 2 条");
	assert.equal(aLimited.total, 3, "total 仍 = 过滤后数 3（不受 limit 影响）");
	assert.deepEqual(aLimited.runs.map((r) => r.id), ["r_a3", "r_a2"], "先排序→过滤→截断（顺序可观测）");
	ok("T12d limit 在过滤之后截断（total 保持过滤后全集）");

	// 无 link ⇒ 任何 scope 都不命中（含“未知归属”不得被任意会话认为自己的）
	const unknownHit = listAsyncRunCards(FIX2, { limit: 100, links: LINKS2, sessionScope: [SESSIONS.a, SESSIONS.b, SESSIONS.c] });
	assert.equal(unknownHit.total, 6, "A+B+C ⇒ 6（r_none/r_tabold/r_conf 三个不落入任何会话）");
	assert.equal(unknownHit.runs.some((r) => r.id === "r_none"), false, "无 link 的 run 不得被任意会话命中");
	ok("T12e 未知归属的 run 不被任何 scope 命中");

	// links 不可用 + 有 scope ⇒ 空集但 attribution 如实说 unavailable（不谎报“没有派发”）
	const unavail = listAsyncRunCards(FIX2, { limit: 100, links: null, sessionScope: [SESSIONS.a] });
	assert.equal(unavail.total, 0);
	assert.equal(unavail.attribution, "unavailable", "过滤需 links ⇒ 不可用时只能如实报 unavailable");
	ok("T12f links 不可用 + scope ⇒ 空集 + attribution=unavailable（不谎报空=没派发）");
}

// ── T13 参数 fail-closed（含 `If-None-Match: *` 仍 400）────────────────
const PARAMS = (s: string): URLSearchParams => new URLSearchParams(s);
{
	// 通过：去重 + 确定性排序（locale 无关）
	assert.deepEqual(parseRunsSessionScope(PARAMS("")), [], "缺省 ⇒ 空 scope = 本机全量");
	assert.deepEqual(parseRunsSessionScope(PARAMS("sessionId=b,a")), ["a", "b"], "排序");
	assert.deepEqual(parseRunsSessionScope(PARAMS("sessionId=b,a,b")), ["a", "b"], "去重");
	assert.deepEqual(parseRunsSessionScope(PARAMS(`sessionId=${TAB_A}`)), [TAB_A], "tab id 允许（含下划线）");
	assert.deepEqual(parseRunsSessionScope(PARAMS(`sessionId=${SESSIONS.a}`)), [SESSIONS.a], "UUID 允许（含连字符）");
	ok("T13a 合法参数：去重 + 排序 + tab/UUID 字符集");

	for (const [label, qs] of [
		["空串", "sessionId="],
		["空 token（A,,B）", "sessionId=a,,b"],
		["首逗号", "sessionId=,a"],
		["尾逗号", "sessionId=a,"],
		["同名参数重复", "sessionId=a&sessionId=b"],
		["6 个原始 token", "sessionId=a,b,c,d,e,f"],
		["重复 token 也算原始 6 个", "sessionId=a,a,a,a,a,a"],
		["非法字符（空格）", "sessionId=a%20b"],
		["非法字符（斜杠）", "sessionId=a/b"],
		["非法字符（星号）", "sessionId=*"],
	] as [string, string][]) {
		assert.throws(
			() => parseRunsSessionScope(PARAMS(qs)),
			/^Error: http 400$|http 400/,
			`${label} ⇒ 400（fail-closed）`,
		);
	}
	ok("T13b 十类非法参数全部 fail-closed（空串/空 token/重复参数/6 token/非法字符）");
}

// ── T14/T15/T16 HTTP：规范化 ETag / 卡片新字段 / 归属 unavailable ────────
{
	let h: RuntimeHostHandle | null = null;
	try {
		h = await createRuntimeHostServer({
			hostPath: join(ROOT, "host2.json"),
			stateDir: join(ROOT, "state2"),
			mailboxDir: join(ROOT, "mailbox2"),
			journalPath: join(ROOT, "journal2.jsonl"),
			sessionsDir: join(ROOT, "sessions2"),
			runsDir: FIX2,
			linksPath: LINK2,
			lockWaitMs: 1000,
		});
		const base = `http://127.0.0.1:${h.info.port}`;

		// T13c 非法参数在**条件请求之前**被拒：带 `If-None-Match: *` 仍必须是 400
		for (const qs of ["sessionId=", "sessionId=a,,b", "sessionId=a&sessionId=b", "sessionId=a,b,c,d,e,f", "sessionId=a%20b"]) {
			const r = await fetch(`${base}/v1/runs?${qs}`, { headers: { "if-none-match": "*" } });
			assert.equal(r.status, 400, `?${qs} + INM:* ⇒ 400（**不是** 304；实际 ${r.status}）`);
			const body = (await r.json()) as { error?: string; hint?: string };
			assert.equal(body.error, "bad-session-scope", "错误体 {error,hint} 风格");
			assert.equal(typeof body.hint, "string", "带可操作 hint");
		}
		ok("T13c HTTP：5 类非法参数带 If-None-Match:* 仍 400（校验先于 ETag 判定）");

		// T14a 规范化：b,a 与 a,b 命中同一 ETag
		const q1 = `sessionId=${SESSIONS.b},${SESSIONS.a}`;
		const q2 = `sessionId=${SESSIONS.a},${SESSIONS.b}`;
		const q3 = `sessionId=${SESSIONS.a},${SESSIONS.a},${SESSIONS.b}`;
		const rA = await fetch(`${base}/v1/runs?${q1}`);
		assert.equal(rA.status, 200);
		const eA = rA.headers.get("etag");
		assert.ok(eA);
		const rB = await fetch(`${base}/v1/runs?${q2}`);
		assert.equal(rB.headers.get("etag"), eA, "?b,a 与 ?a,b ⇒ 同一 ETag（排序用 locale 无关 sort）");
		const rC = await fetch(`${base}/v1/runs?${q3}`);
		assert.equal(rC.headers.get("etag"), eA, "重复 token 去重后同 ETag");
		ok("T14a 规范化：b,a / a,b / a,a,b ⇒ 同一 ETag");

		// T14b 不同 scope ⇒ 不同 ETag（且 count 正确）
		const rOnlyA = await fetch(`${base}/v1/runs?sessionId=${SESSIONS.a}`);
		const bOnlyA = (await rOnlyA.json()) as { count: number; total: number; etagless?: never };
		assert.notEqual(rOnlyA.headers.get("etag"), eA, "A 与 A+B 不同 ETag");
		assert.equal(bOnlyA.total, 3, "?sessionId=A ⇒ total=3（过滤后）");
		assert.equal(bOnlyA.count, 3);
		const rAll = await fetch(`${base}/v1/runs`);
		const bAll = (await rAll.json()) as { total: number; attribution: string; attributionDetail: RunAttributionDetail };
		assert.equal(bAll.total, 9, "缺省（无 sessionId）⇒ 本机全量 9");
		assert.notEqual(rAll.headers.get("etag"), rOnlyA.headers.get("etag"));
		assert.equal(bAll.attribution, "partial");
		assert.deepEqual(bAll.attributionDetail, { resolved: 6, tabUnmapped: 1, missing: 1, conflict: 1 });
		ok("T14b A 与 A+B 不同 ETag；缺省仍本机全量且带 attribution");

		// T14c 304 复请求 ⇒ 0 字节
		const r304 = await fetch(`${base}/v1/runs?${q2}`, { headers: { "if-none-match": eA! } });
		assert.equal(r304.status, 304, "规范等价 URL + INM ⇒ 304");
		assert.equal((await r304.text()).length, 0, "304 body 0 字节");
		ok("T14c 304 复请求 body 0 字节");

		// T15 dispatchedBy / durationMs
		// 先给 r_b1 写真 durationMs（终态）与 r_b2 写“非法” durationMs（字符串）
		writeRun("r_b1", { startedAt: iso(4), lastActivity: iso(4), result: { status: "completed", text: "d", usageEvents: [], durationMs: 123456, priorFailures: [{ attempt: 1 }] } }, FIX2);
		writeRun("r_b2", { startedAt: iso(5), lastActivity: iso(5), result: { status: "completed", text: "d", usageEvents: [], durationMs: "1234" } }, FIX2);
		const rb = (await (await fetch(`${base}/v1/runs?sessionId=${SESSIONS.b}`)).json()) as { runs: RunCard[] };
		const cardB1 = rb.runs.find((r) => r.id === "r_b1")!;
		const cardB2 = rb.runs.find((r) => r.id === "r_b2")!;
		assert.equal(cardB1.durationMs, 123456, "durationMs 透传 record.result.durationMs（末次尝试）");
		assert.equal(cardB1.dispatchedBy, SESSIONS.b, "dispatchedBy = 直接派发者");
		assert.equal(cardB2.durationMs, null, "非数值 durationMs ⇒ null（不臆造）");
		const cardNone = ((await (await fetch(`${base}/v1/runs?includeRecentCalls=1`)).json()) as { runs: RunCard[] }).runs.find((r) => r.id === "r_none")!;
		assert.equal(cardNone.durationMs, null, "无 result.durationMs ⇒ null");
		assert.equal("dispatchedBy" in cardNone, false, "无 link ⇒ dispatchedBy 键不出现（≠ 冲突 null）");
		const cardConf = ((await (await fetch(`${base}/v1/runs`)).json()) as { runs: RunCard[] }).runs.find((r) => r.id === "r_conf")!;
		assert.equal(cardConf.dispatchedBy, null, "冲突 ⇒ dispatchedBy=null（不取第一个）");
		assert.equal(cardConf.durationMs, null, "无 result.durationMs ⇒ null（冲突不影响其它字段）");
		ok("T15 dispatchedBy 冲突 null / 无 link 键不出现 / durationMs 透传与缺失");
	} finally {
		if (h !== null) await h.close();
	}
}

// ── T16 links 不可读 / 解析异常率高 ⇒ unavailable，但全量查询仍 200 ────────
{
	const BAD_DIR = join(ROOT, "links-as-dir");
	mkdirSync(BAD_DIR, { recursive: true }); // readFileSync 目录 ⇒ EISDIR ⇒ 读失败
	const RATIO = join(ROOT, "links-ratio.jsonl");
	// 3 行里 1 行坏 = 33% > 10% 阈值 ⇒ unavailable
	writeFileSync(RATIO, [JSON.stringify(link({ sessionId: SESSIONS.a, targetId: "r_a1" })), "{not json", JSON.stringify(link({ sessionId: SESSIONS.a, targetId: "r_a2" }))].join("\n") + "\n", "utf8");
	const OK_RATIO = join(ROOT, "links-ratio-ok.jsonl");
	const okLines = Array.from({ length: 20 }, (_, i) => JSON.stringify(link({ sessionId: SESSIONS.a, targetId: `r_${i}` })));
	okLines[0] = "{not json"; // 1/20 = 5% ≤ 10% ⇒ 仍可用（坏行跳过）
	writeFileSync(OK_RATIO, okLines.join("\n") + "\n", "utf8");

	let h: RuntimeHostHandle | null = null;
	try {
		h = await createRuntimeHostServer({
			hostPath: join(ROOT, "host3.json"),
			stateDir: join(ROOT, "state3"),
			mailboxDir: join(ROOT, "mailbox3"),
			journalPath: join(ROOT, "journal3.jsonl"),
			sessionsDir: join(ROOT, "sessions3"),
			runsDir: FIX2,
			linksPath: BAD_DIR,
			lockWaitMs: 1000,
		});
		const base = `http://127.0.0.1:${h.info.port}`;
		const r = await fetch(`${base}/v1/runs`);
		assert.equal(r.status, 200, "links 不可读**不得**让端点失败");
		const b = (await r.json()) as { total: number; attribution: string; attributionDetail: RunAttributionDetail; runs: RunCard[] };
		assert.equal(b.attribution, "unavailable", "links 不可读 ⇒ attribution=unavailable");
		assert.deepEqual(b.attributionDetail, ZERO, "unavailable 时残差全 0（不混成 missing）");
		assert.equal(b.total, 9, "缺省（全量）查询仍返回 9 条——读失败不能把全量入口打空");
		assert.equal(b.runs.every((x) => !("dispatchedBy" in x)), true, "归属不可用 ⇒ 卡片不带 dispatchedBy");
		ok("T16a links 读失败 ⇒ 200 + unavailable + 全量 9 条仍在");
	} finally {
		if (h !== null) await h.close();
	}

	try {
		h = await createRuntimeHostServer({
			hostPath: join(ROOT, "host4.json"),
			stateDir: join(ROOT, "state4"),
			mailboxDir: join(ROOT, "mailbox4"),
			journalPath: join(ROOT, "journal4.jsonl"),
			sessionsDir: join(ROOT, "sessions4"),
			runsDir: FIX2,
			linksPath: RATIO,
			lockWaitMs: 1000,
		});
		const base = `http://127.0.0.1:${h.info.port}`;
		const b = (await (await fetch(`${base}/v1/runs`)).json()) as { attribution: string; total: number };
		assert.equal(b.attribution, "unavailable", "坏行占比 33% > 10% ⇒ unavailable（不是“跳过坏行照常可信”）");
		assert.equal(b.total, 9, "仍然 200 全量");
		await h.close();
		h = await createRuntimeHostServer({
			hostPath: join(ROOT, "host5.json"),
			stateDir: join(ROOT, "state5"),
			mailboxDir: join(ROOT, "mailbox5"),
			journalPath: join(ROOT, "journal5.jsonl"),
			sessionsDir: join(ROOT, "sessions5"),
			runsDir: FIX2,
			linksPath: OK_RATIO,
			lockWaitMs: 1000,
		});
		const base2 = `http://127.0.0.1:${h.info.port}`;
		const b2 = (await (await fetch(`${base2}/v1/runs`)).json()) as { attribution: string };
		assert.equal(b2.attribution, "partial", "坏行占比 5% ≤ 10% ⇒ 账本仍可用（坏行跳过，残差如实计 missing）");
		ok("T16b 解析异常率阈值：33%>10% ⇒ unavailable；5% ⇒ 仍可用");
	} finally {
		if (h !== null) await h.close();
	}
}

// ── 环境口径：DEFAULT_RUNS_DIR 读 env（未被本测试污染真实目录）──────
assert.equal(DEFAULT_RUNS_DIR, process.env.PI_SUBAGENT_RUNS_DIR, "DEFAULT_RUNS_DIR 走 PI_SUBAGENT_RUNS_DIR 口径");
ok("T9 DEFAULT_RUNS_DIR 与 PI_SUBAGENT_RUNS_DIR 同源（测试零污染真实目录）");

rmSync(ROOT, { recursive: true, force: true });
console.log(`_test_runs_endpoint: all assertions passed (${n} groups)`);
