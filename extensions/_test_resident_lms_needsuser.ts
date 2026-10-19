/**
 * _test_resident_lms_needsuser.ts — 常驻 local master（`lms-*`）不得被 autonomy 判「等人」
 *
 * 计划：plans/20261019_autonomy_resident_lms_scope_plan.md（以 §3.2 审查修订 v2 为准）
 * 审查：plans/20261019_autonomy_resident_lms_scope_plan_review.md
 *
 * 缺陷：`classifyForReclaim`（tab-runs-runtime.ts:547）把 `phase==="waiting"` 判 `awaitingInput`
 * ⇒ carriers `needsHuman=true` ⇒ `needsUser` 边沿 ⇒ `needs_user` 触发 ⇒ 拉起 `l2-*` tab
 * ⇒ 该 tab 无活可干 ⇒ 报 no-op ⇒ local master 回 `waiting` ⇒ **无限回声**。
 * 而 `waiting` 正是 local master 的**正常态**（等信）；autonomy 只应为主会话服务。
 *
 * 修法落点：`runtime/frontier-carriers.ts::computeNeedsHuman` —— `lms-*`/`master-*`（常驻身份，
 * 判据唯一真相源 `tab-runs.ts::isPersistentTabTaskId`）的 needsHuman 收紧为
 * `gate==="awaiting" ∨ stop==="error" ∨ pidAlive===false`。
 * **`classifyForReclaim` 一字不改**（`reclaim-tabs` 的 `waiting ⇒ awaitingInput` 语义必须保留，W6 钉死）。
 *
 * 夹具纪律（AGENTS R-4）：`lms-*` 的 state/dispatch 形状**照抄真盘产物**：
 *   实测三个活 lms（`tab_mveijxe4_n17e` / `tab_mveijzy4_p63g` / `tab_mveik3bs_cnz5`）：
 *   dispatch = `{id,version:1,taskId:"lms-<scope>",mode:"execute",title:"local-master <scope>",cwd,dispatchedAt,dispatchStatus:"dispatched"}`；
 *   state    = `{id,phase,turn,terminal:false,lastActivityAt,lastAssistantText,lastStopReason,usage}` ——
 *             **无 `pid`**（`state.pid` 只在 session_start 写一次，下一回合整文件替换即丢）；
 *   result   = **不存在**（local master 明令不调 tab-finish，兜底写入器对常驻身份豁免）。
 *   ⇒ 真实形状就是 `resultMissing=true, terminal=false, pidAlive=null`。
 *
 * 隔离（AGENTS R-3）：全部 agentDir/stateDir/mailboxDir 走 mkdtemp，**不碰本机真盘**
 * （本机 subagent-win 仓 `gate=awaiting`，真盘上 needsUser 恒 true，断言不可重复）。
 *
 * 运行：node --experimental-strip-types --import ./extensions/runtime-host/pi-deps-loader.mjs \
 *         ./extensions/_test_resident_lms_needsuser.ts
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 进程环境隔离：被测代码的 tab 身份 guard 行为可预期（与 _test_tab_runs_runtime 同款）。
// PI_AUTONOMY_FRONTIER_SOURCE 必须删：W1/W2 走的是默认 v2 分支（collectGlobalView）；
// 若宿主环境 export 了 graph（本机 agent 会话即如此），collectAutonomyInputs 会改走
// graph 分支读 graph 快照（夹具未造）⇒ projects=0 ⇒ 断言不可重复。
delete process.env.PI_SUBAGENT;
delete process.env.PI_TAB_RUN_ID;
delete process.env.PI_TAB_RUNS_DIR;
delete process.env.PI_AUTONOMY_FRONTIER_SOURCE;

import {
	classifyTabStatus,
	composeTabStatus,
	readTabDispatch,
	readTabResultFile,
	readTabState,
	type TabDispatchRecord,
} from "./tab-runs.ts";
import { classifyForReclaim, writeSettlementFallback } from "./tab-runs-runtime.ts";
import {
	classifyDispatch,
	computeNeedsHuman,
	isResidentLocalMasterTab,
	reduceTabCarrier,
	readGateStatus,
	type GateStatus,
	type TabDetail,
} from "./runtime/frontier-carriers.ts";
import { collectAutonomyInputs, readFrontierSnapshot } from "./runtime/autonomy/collect.ts";

const NOW = Date.parse("2026-10-19T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (ms: number): string => new Date(ms).toISOString();

const ROOT = mkdtempSync(join(tmpdir(), "resident-lms-"));
const CONFIG_ENABLED = join(ROOT, "config-enabled.json");
writeFileSync(CONFIG_ENABLED, JSON.stringify({ autonomy: { enabled: true } }), "utf8");

const writeJson = (p: string, v: unknown): void => writeFileSync(p, JSON.stringify(v), "utf8");

const GATE_OK = "# r\n\n## Active Tasks\n\n### Task Index\n\n| Item | Priority | Summary |\n| R1 | P0 | d |\n";
const GATE_AWAITING = "# r\n\n## Active Tasks\n\n### Task Index\n\n| Item | Priority | Summary |\n| R1 | P0 | d |\n\n**Status**：waiting\n";

interface World {
	tag: string;
	root: string;
	agentDir: string;
	runsDir: string;
	sessionsRoot: string;
	timersDir: string;
	stateDir: string;
	mailboxDir: string;
	reposRoot: string;
	repos: Map<string, string>;
	gates: Map<string, GateStatus>;
}

/** 造一个隔离 world；`repos` = [[name, gate]]。 */
function makeWorld(tag: string, repos: Array<[string, "ok" | "awaiting"]>): World {
	const root = join(ROOT, tag);
	const w: World = {
		tag, root,
		agentDir: join(root, "agent"),
		runsDir: join(root, "agent", "tab-runs"),
		sessionsRoot: join(root, "agent", "sessions"),
		timersDir: join(root, "agent", "timers"),
		stateDir: join(root, "state"),
		mailboxDir: join(root, "mailbox"),
		reposRoot: join(root, "repos"),
		repos: new Map(),
		gates: new Map(),
	};
	for (const d of [w.runsDir, w.sessionsRoot, w.timersDir, join(w.timersDir, "mail"), w.stateDir, w.mailboxDir, w.reposRoot]) {
		mkdirSync(d, { recursive: true });
	}
	for (const [name, gate] of repos) {
		const p = join(w.reposRoot, name);
		mkdirSync(join(p, ".git"), { recursive: true });
		writeFileSync(join(p, "recentwork.md"), gate === "awaiting" ? GATE_AWAITING : GATE_OK, "utf8");
		w.repos.set(name, p);
		w.gates.set(name, gate);
	}
	return w;
}

/** 真实形状的 lms dispatch + state（无 pid / 无 result，见文件头实测）。 */
function writeLmsTab(w: World, runId: string, scope: string, stateOver: Record<string, unknown> = {}): void {
	const cwd = w.repos.get(scope)!;
	writeJson(join(w.runsDir, `${runId}.json`), {
		id: runId, version: 1, taskId: `lms-${scope}`, mode: "execute",
		title: `local-master ${scope}`, cwd, dispatchedAt: iso(NOW - 3 * HOUR), dispatchStatus: "dispatched",
	});
	writeJson(join(w.runsDir, `${runId}.state.json`), {
		id: runId, phase: "waiting", turn: "idle", terminal: false,
		lastActivityAt: iso(NOW - 5 * MIN), lastAssistantText: "等信（常驻）",
		lastStopReason: "stop",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
		...stateOver,
	});
}

/** 任务的普通 tab（`launch-tabs` 派发形态）。 */
function writeTaskTab(w: World, runId: string, taskId: string, scope: string, stateOver: Record<string, unknown> = {}): void {
	const cwd = w.repos.get(scope)!;
	writeJson(join(w.runsDir, `${runId}.json`), {
		id: runId, version: 1, taskId, mode: "workflow",
		title: `T ${taskId}`, cwd, dispatchedAt: iso(NOW - 3 * HOUR), dispatchStatus: "dispatched",
	});
	writeJson(join(w.runsDir, `${runId}.state.json`), {
		id: runId, phase: "waiting", turn: "idle", terminal: false,
		lastActivityAt: iso(NOW - 5 * MIN), lastStopReason: "stop",
		...stateOver,
	});
}

/** 单条可见 tab 的真实 carrier（经 reduceTabCarrier 真实入口，不直调判据）。 */
function carrierOf(w: World, runId: string): TabDetail {
	const rec = readTabDispatch(w.runsDir, runId);
	assert.ok(rec, `dispatch 缺失: ${runId}`);
	const repoPath = rec!.cwd;
	return reduceTabCarrier({
		rec: rec!,
		sessionsRoot: w.sessionsRoot,
		repoPath,
		repoOverdue: 0,
		now: NOW,
		gate: w.gates.get(repoPath.split(/[\\/]/).pop()!) ?? "ok",
		state: readTabState(w.runsDir, runId),
		result: readTabResultFile(w.runsDir, runId),
	})!;
}

/** 一帧真实全链：collectAutonomyInputs（collect → buildFrontier），注入隔离 agentDir/stateDir/mailboxDir。 */
function frame(w: World, now: number): ReturnType<typeof collectAutonomyInputs> {
	return collectAutonomyInputs({
		agentDir: w.agentDir, stateDir: w.stateDir, mailboxDir: w.mailboxDir, now, configPath: CONFIG_ENABLED,
	});
}

const auditLines = (w: World): string[] => {
	const p = join(w.stateDir, "autonomy", "audit.jsonl");
	if (!existsSync(p)) return [];
	return readFileSync(p, "utf8").split("\n").filter(Boolean);
};

let passed = 0;
const EXPECTED = 20;
function check(name: string, fn: () => void): void {
	fn();
	passed += 1;
	console.log(`  ok ${name}`);
}

try {
	// ═════════════════ U 组：carrier 判据（真实形状夹具，AGENTS R-4）═════════════════
	console.log("U 组 computeNeedsHuman / reduceTabCarrier（真实 lms 形状）");

	const UW = makeWorld("u", [["u-a", "ok"], ["u-b", "ok"], ["u-c", "ok"], ["u-await", "awaiting"]]);

	check("U0 常驻身份识别：lms-*/master-* ⇒ true；任务 tab / l2 / 空串 ⇒ false（共享 helper 单源）", () => {
		assert.equal(isResidentLocalMasterTab({ taskId: "lms-GreenCAD" }), true);
		assert.equal(isResidentLocalMasterTab({ taskId: "master-default" }), true);
		assert.equal(isResidentLocalMasterTab({ taskId: "1027" }), false);
		assert.equal(isResidentLocalMasterTab({ taskId: "l2-GreenCAD" }), false);
		assert.equal(isResidentLocalMasterTab({ taskId: "" }), false);
		// 前缀是**开头**匹配，不是子串（防「任务号里带 lms-」误豁免）
		assert.equal(isResidentLocalMasterTab({ taskId: "T-lms-x" }), false);
	});

	writeLmsTab(UW, "u_lms_wait", "u-a");
	check("U1 lms waiting + 真实形状（resultMissing=true / terminal=false / pidAlive=null / stop=stop）⇒ needsHuman=false", () => {
		const c = carrierOf(UW, "u_lms_wait");
		// 先钉夹具真实性：这就是盘上真实形状，不是「造出来的干净 waiting」
		assert.equal(c.phase, "waiting");
		assert.equal(c.resultMissing, true, "无 result 是常态（local master 不调 tab-finish）");
		assert.equal(c.terminal, false);
		assert.equal(c.pidAlive, null, "state.pid 恒缺失 ⇒ pidAlive null（不猜）");
		assert.equal(c.stop, "stop");
		assert.equal(c.needsHuman, false, "核心：常驻 waiting 不再被当「等人」");
	});

	writeLmsTab(UW, "u_lms_term", "u-b", { phase: "completed", terminal: true, turn: "idle" });
	check("U2 lms 终态且无 result ⇒ needsHuman=false（冻结既有行为：终态无 result 走 reclaim=pending）", () => {
		const c = carrierOf(UW, "u_lms_term");
		assert.equal(c.terminal, true);
		assert.equal(c.resultMissing, true);
		assert.equal(c.needsHuman, false, "终态+无 result 修复前就 false，防令后改回 true");
	});

	writeLmsTab(UW, "u_lms_deadpid", "u-c", { pid: 999_999_999 });
	check("U3 lms waiting + state.pid 死 ⇒ pidAlive=false ⇒ needsHuman=true（结构性保险；实测盘上恒 null）", () => {
		const c = carrierOf(UW, "u_lms_deadpid");
		assert.equal(c.pidAlive, false, "合成夹具：死 pid 可被判死");
		assert.equal(c.needsHuman, true, "结构性保险分支命中");
	});

	writeLmsTab(UW, "u_lms_error", "u-a", { lastStopReason: "error" });
	check("U4 lms + lastStopReason=error（其余真实形状）⇒ needsHuman=true（唯一真实可命中的收紧分支）", () => {
		const c = carrierOf(UW, "u_lms_error");
		assert.equal(c.stop, "error");
		assert.equal(c.needsHuman, true);
	});

	writeTaskTab(UW, "u_task", "1027", "u-b");
	check("U5 普通任务 tab（taskId=1027）waiting 无 result ⇒ needsHuman=true（原语义不变）", () => {
		const c = carrierOf(UW, "u_task");
		assert.equal(c.phase, "waiting");
		assert.equal(c.needsHuman, true, "任务 tab 的 waiting 仍是「等主会话下一步」");
	});

	writeTaskTab(UW, "u_l2", "l2-u-c", "u-c");
	check("U6 l2-* 一次性 tab waiting 无 result ⇒ needsHuman=true（不享常驻豁免）", () => {
		const c = carrierOf(UW, "u_l2");
		assert.equal(c.needsHuman, true);
	});

	check("U6b 兜底写入器：l2 settled 无 tab-finish ⇒ 写 unconfirmed 兜底 ⇒ classifyDispatch attention=true（lms 仍豁免）", () => {
		const l2Rec = readTabDispatch(UW.runsDir, "u_l2")!;
		const out = writeSettlementFallback({ runsDir: UW.runsDir, runId: "u_l2", lastStopReason: "stop", dispatch: l2Rec, now: new Date(NOW) });
		assert.equal(out, "written", "l2 不在常驻豁免内 ⇒ 落兜底 result");
		const res = readTabResultFile(UW.runsDir, "u_l2");
		assert.equal(res?.status, "unconfirmed");
		const note = classifyDispatch(l2Rec, UW.runsDir, NOW);
		assert.equal(note.attention, true, "兜底 unconfirmed ⇒ 可见待审（RF-1 通道，与 needsHuman 正交）");
		assert.equal(note.hiddenKind, null, "兜底结果不得被 hidden 分流");
		const lmsRec = readTabDispatch(UW.runsDir, "u_lms_wait")!;
		assert.equal(
			writeSettlementFallback({ runsDir: UW.runsDir, runId: "u_lms_wait", lastStopReason: "stop", dispatch: lmsRec, now: new Date(NOW) }),
			"skip-persistent-identity",
			"lms 常驻豁免仍然生效（:128 已改为复用共享 helper）",
		);
		assert.equal(readTabResultFile(UW.runsDir, "u_lms_wait"), null, "lms 永不落兜底 result（⇒ resultMissing 恒 true 的根因）");
	});

	check("U7 三个 lms 同时 waiting（gate 全 ok）⇒ 各 needsHuman=false", () => {
		const WW = makeWorld("u7", [["w-a", "ok"], ["w-b", "ok"], ["w-c", "ok"]]);
		writeLmsTab(WW, "u7_a", "w-a");
		writeLmsTab(WW, "u7_b", "w-b");
		writeLmsTab(WW, "u7_c", "w-c");
		for (const id of ["u7_a", "u7_b", "u7_c"]) assert.equal(carrierOf(WW, id).needsHuman, false, `${id} 不得 needsHuman`);
	});

	check("U7b 三个 lms waiting 但某仓 gate=awaiting ⇒ 该仓 needsHuman=true（仓级载体不受本修复影响）", () => {
		const GW = makeWorld("u7b", [["g-a", "ok"], ["g-b", "ok"], ["g-await", "awaiting"]]);
		writeLmsTab(GW, "u7b_a", "g-a");
		writeLmsTab(GW, "u7b_b", "g-b");
		writeLmsTab(GW, "u7b_c", "g-await");
		assert.equal(carrierOf(GW, "u7b_a").needsHuman, false);
		assert.equal(carrierOf(GW, "u7b_c").needsHuman, true, "gate=awaiting 走仓级载体（与 lms 相位正交）");
		assert.equal(carrierOf(GW, "u7b_c").gate, "awaiting");
	});

	check("U8 混合：lms waiting + 普通任务 tab waiting ⇒ 只有任务 tab needsHuman=true", () => {
		const MW = makeWorld("u8", [["m-a", "ok"], ["m-b", "ok"]]);
		writeLmsTab(MW, "u8_lms", "m-a");
		writeTaskTab(MW, "u8_task", "1027", "m-b");
		assert.equal(carrierOf(MW, "u8_lms").needsHuman, false);
		assert.equal(carrierOf(MW, "u8_task").needsHuman, true);
	});

	check("U9 生产函数未被绕过：computeNeedsHuman 只是 reduceTabCarrier 内的唯一计算点（源码守卫）", () => {
		const src = readFileSync(join(process.cwd(), "extensions", "runtime", "frontier-carriers.ts"), "utf8");
		assert.equal((src.match(/needsHuman: computedNeedsHuman/g) ?? []).length, 1, "needsHuman 在 carriers 内只有一处赋值（防令后多写一份判据）");
		const codeLines = src.split("\n").filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l));
		assert.equal(codeLines.filter((l) => l.includes('reclaim === "awaitingInput"')).length, 1, "旧一刀切表达式只允许出现在 computeNeedsHuman 的普通 tab 分支里（注释不计）");
		// 共享 helper 单源：carriers 不得自带前缀字面量
		assert.ok(!src.includes('"lms-"'), "carriers 不得重写前缀（唯一真相源在 tab-runs.ts）");
		const shared = readFileSync(join(process.cwd(), "extensions", "tab-runs.ts"), "utf8");
		assert.ok(shared.includes("export function isPersistentTabTaskId"), "共享 helper 在 tab-runs.ts");
		const rt = readFileSync(join(process.cwd(), "extensions", "tab-runs-runtime.ts"), "utf8");
		assert.ok(rt.includes("isPersistentTabTaskId(persistentTaskId)"), "tab-runs-runtime 常驻豁免必须复用共享 helper");
		assert.ok(!/persistentTaskId\.startsWith\("lms-"\)/.test(rt), "不得保留旧的就地前缀判断（防三处判据漂移）");
	});

	// ═════════════════ W 组：真实全链（collectAutonomyInputs → buildFrontier）═════════════════
	console.log("W 组 真实链路（隔离 agentDir/stateDir/mailboxDir）");

	check("W1 三 lms waiting + gate 全 ok ⇒ needsUser=false 且非基线帧零触发", () => {
		const WW = makeWorld("w1", [["a", "ok"], ["b", "ok"], ["c", "ok"]]);
		writeLmsTab(WW, "w1_a", "a");
		writeLmsTab(WW, "w1_b", "b");
		writeLmsTab(WW, "w1_c", "c");
		const f1 = frame(WW, NOW);
		assert.ok(f1.frontier, "首帧 frontier 非 null");
		assert.equal(f1.frontier!.next.baseline, true, "首帧 = 基线");
		assert.equal(f1.frontier!.next.projects.length, 3, "三仓各一项目");
		for (const p of f1.frontier!.next.projects) {
			assert.equal(p.needsUser, false, `回声消除：${p.project} 不得 needsUser`);
		}
		// 第二帧（非基线，真边沿判定）：同输入 ⇒ 零触发
		const f2 = frame(WW, NOW + 30_000);
		assert.equal(f2.frontier!.next.baseline, false);
		assert.deepEqual(f2.frontier!.diff.triggers.map((t) => t.rule), [], "lms 空闲不产生任何触发");
		for (const p of f2.frontier!.next.projects) assert.equal(p.needsUser, false);
	});

	check("W2 回声回归：连续 3 帧 collect（prev 链真实演进）⇒ audit 里 rule=needs_user 计数 0", () => {
		const WW = makeWorld("w2", [["a", "ok"], ["b", "ok"], ["c", "ok"]]);
		writeLmsTab(WW, "w2_a", "a");
		writeLmsTab(WW, "w2_b", "b");
		writeLmsTab(WW, "w2_c", "c");
		for (let i = 0; i < 3; i++) frame(WW, NOW + i * 30_000);
		// prev 链真实演进：snapshot 已落盘且 asof = 最后一帧
		assert.equal(readFrontierSnapshot({ stateDir: WW.stateDir })!.asof, NOW + 60_000, "prev 链按真实帧推进");
		const needsUserLines = auditLines(WW).filter((l) => l.includes("rule=needs_user"));
		assert.deepEqual(needsUserLines, [], `needs_user 触发为零：\n${needsUserLines.join("\n")}`);
		assert.ok(auditLines(WW).some((l) => l.includes("frontier baseline=")), "audit 有 frontier 摘要行（非空跑）");
	});

	check("W2b 对照：同一夹具把 lms 换成等待中的任务 tab ⇒ 真的产出 needs_user（证明 W1/W2 不是空断言）", () => {
		const WW = makeWorld("w2b", [["a", "ok"]]);
		writeTaskTab(WW, "w2b_t", "1027", "a");
		frame(WW, NOW); // 基线帧
		const f2 = frame(WW, NOW + 30_000);
		assert.equal(f2.frontier!.next.projects[0]!.needsUser, true, "任务 tab waiting ⇒ needsUser=true（对照组必须真）");
	});

	check("W3 对照：lms 停止报错 ⇒ 项目 needsUser=true（stop=error 分支真实接线）", () => {
		const WW = makeWorld("w3", [["a", "ok"]]);
		writeLmsTab(WW, "w3_a", "a", { lastStopReason: "error" });
		const f1 = frame(WW, NOW);
		assert.equal(f1.frontier!.next.projects[0]!.needsUser, true, "lms 真报错必须能被 autonomy 看见");
	});

	check("W4 对照：lms 仓 gate=awaiting ⇒ 项目 needsUser=true（本机现状的形状，仓级载体不受本修复影响）", () => {
		const WW = makeWorld("w4", [["a", "awaiting"]]);
		writeLmsTab(WW, "w4_a", "a");
		const f1 = frame(WW, NOW);
		assert.equal(f1.frontier!.next.projects[0]!.gate, "awaiting");
		assert.equal(f1.frontier!.next.projects[0]!.needsUser, true, "仓在等人工 ⇒ 仍报（U7b 全链版）");
	});

	// ═════════════════ W6：共享判据未被动过 ═════════════════
	console.log("W6 共享判据（classifyForReclaim）冻结");

	check("W6 reclaim-tabs 对 lms waiting 仍返回 awaitingInput（证明 classifyForReclaim 一字未改）", () => {
		const WW = makeWorld("w6", [["a", "ok"]]);
		writeLmsTab(WW, "w6_a", "a");
		const rec = readTabDispatch(WW.runsDir, "w6_a")!;
		const view = composeTabStatus({
			runId: "w6_a", dispatch: rec, state: readTabState(WW.runsDir, "w6_a"),
			result: readTabResultFile(WW.runsDir, "w6_a"), probe: null, dispatchedAt: rec.dispatchedAt, now: NOW,
		});
		assert.equal(view.phase, "waiting");
		assert.equal(classifyForReclaim(view), "awaitingInput", "主会话查 tab：waiting 仍是「等你下一步」");
		// 同一份 view：carrier 的 needsHuman 已收紧（两处语义不同是**刻意的**）
		assert.equal(carrierOf(WW, "w6_a").needsHuman, false);
	});

	check("W6b classifyTabStatus 不变：waiting 仍是 waiting（非终态）", () => {
		const st = classifyTabStatus(null, { dispatchedAt: iso(NOW - 5 * MIN), now: NOW });
		assert.equal(st.terminal, false);
	});

	// ═════════════════ 分母：本机真盘基线（只读，不写真盘）═════════════════
	check("W7 本机真盘只读分母：活动 lms dispatch 的 state 无 pid / 无 result（支撑「pidAlive 恒 null」登记）", () => {
		const realRuns = join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".pi", "agent", "tab-runs");
		if (!existsSync(realRuns)) {
			console.log("    （skipped：本机无 tab-runs 目录）");
			return;
		}
		const names = readdirSync(realRuns);
		const lms = names.filter((n) => n.endsWith(".json") && !n.endsWith(".state.json") && !n.endsWith(".result.json"));
		let total = 0; let withPid = 0; let withResult = 0;
		for (const n of lms) {
			let rec: TabDispatchRecord;
			try { rec = JSON.parse(readFileSync(join(realRuns, n), "utf8")) as TabDispatchRecord; } catch { continue; }
			if (!String(rec.taskId ?? "").startsWith("lms-")) continue;
			total += 1;
			try {
				const st = JSON.parse(readFileSync(join(realRuns, `${rec.id}.state.json`), "utf8")) as { pid?: unknown };
				if (typeof st.pid === "number") withPid += 1;
			} catch { /* 无 state */ }
			if (existsSync(join(realRuns, `${rec.id}.result.json`))) withResult += 1;
		}
		console.log(`    实测分母：lms dispatch=${total}，state 带 pid=${withPid}，有 result=${withResult}`);
		if (total > 0) {
			assert.equal(withResult, 0, "lms 从不 tab-finish ⇒ 无 result（resultMissing 恒 true 的实证）");
		}
	});

	assert.equal(passed, EXPECTED, `应跑满 ${EXPECTED} 组，实际 ${passed}`);
	console.log(`_test_resident_lms_needsuser: ${passed}/${EXPECTED} 组通过（U0-U9 + W1-W7）`);
} finally {
	rmSync(ROOT, { recursive: true, force: true });
}
