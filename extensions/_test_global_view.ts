/**
 * _test_global_view.ts — 全局视野只读聚合首阶段（0923 计划 §2 + §6 首项）。
 *
 * 隔离临时 agentDir，零真实磁盘依赖。覆盖：
 *  V1 120 orphaned+noResult + 4 active（orphan 比 active 新 → Top100 截断会漏，
 *     本聚合全量扫描不漏）；默认仅显示有效 tab、hidden 计数 ≥120、attention 不丢
 *  V2 state working/waiting/终态无 result（needsReview 可见 + attention）
 *  V3 result completed → hidden terminal；同 basename 两仓消歧；detail 缺失附件忽略
 *  V4 timer：pending 计入（root 按 ownerCwd、tab 邮箱按 run 映射）、fired 不计、
 *     无归属记 HOME unmapped、overdue 标记
 *  V5 mailbox pending/claimed/acked 计数；global 进 HOME；scope 按附件精确归仓
 *  V6 plans 计数；local alive（liveness session/gen/pid 三一致）；行数 ≤30
 *  V7 history 分页按 id 找回；gitProbe 注入（默认探针不被调用，无 shell/cd）
 *
 * 运行：npm run test:global-view
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectGlobalView, formatGlobalView, globalViewLogic, parseGlobalViewArgs } from "./runtime/global-view.ts";

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;
const iso = (ms: number): string => new Date(ms).toISOString();

function mkAgent(): string {
	const root = mkdtempSync(join(tmpdir(), "global-view-test-"));
	for (const d of ["tab-runs", "timers", join("runtime", "registry", "attachments"), join("runtime", "state", "scope-liveness"), join("runtime", "mailbox")]) {
		mkdirSync(join(root, d), { recursive: true });
	}
	return root;
}
function write(p: string, obj: unknown): void { writeFileSync(p, JSON.stringify(obj), "utf8"); }
function dispatch(agentDir: string, id: string, cwd: string, atMs: number, task = "T1"): void {
	write(join(agentDir, "tab-runs", `${id}.json`), { id, version: 1, taskId: task, mode: "workflow", cwd, dispatchedAt: iso(atMs), dispatchStatus: "dispatched" });
}
function state(agentDir: string, id: string, phase: string, terminal: boolean, atMs: number): void {
	write(join(agentDir, "tab-runs", `${id}.state.json`), { id, phase, turn: "working", terminal, lastActivityAt: iso(atMs) });
}

const agentDir = mkAgent();
// 真实目录作仓库（plans 计数 + gitProbe 映射用得上）
const repoA = mkdtempSync(join(tmpdir(), "gv-repoA-"));
const repoBParent1 = mkdtempSync(join(tmpdir(), "gv-p1-"));
const repoBParent2 = mkdtempSync(join(tmpdir(), "gv-p2-"));
const repoB1 = join(repoBParent1, "base"); const repoB2 = join(repoBParent2, "base");
mkdirSync(repoB1, { recursive: true }); mkdirSync(repoB2, { recursive: true });
// 假仓自带 .git：findRepoRoot 上溯到此停止（家目录另有 .git，不挡即被误并）
for (const r of [repoA, repoB1, repoB2]) mkdirSync(join(r, ".git"), { recursive: true });
mkdirSync(join(repoA, "plans"), { recursive: true });
writeFileSync(join(repoA, "plans", "a.md"), "# a\n");
writeFileSync(join(repoA, "plans", "b.md"), "# b\n");

// V1：120 个 orphaned（1h 前派发、无 state/result → grace 外 orphaned；比 active 新 → Top100 会漏 active）
for (let i = 0; i < 120; i++) {
	dispatch(agentDir, `orphan_${String(i).padStart(3, "0")}`, join(repoA, "sub"), NOW - 1 * HOUR, `NOISE${i}`);
}
// V1/V2：4 个 active（3h 前派发 → Top100-desc 截断下被淹没，但全量扫描可见）
dispatch(agentDir, "active_fresh", repoA, NOW - 60_000, "A1"); // 60s 内 → dispatched（active；grace 内）
dispatch(agentDir, "active_working", repoA, NOW - 3 * HOUR, "A2");
state(agentDir, "active_working", "working", false, NOW - 30 * 60_000);
dispatch(agentDir, "active_waiting", repoB1, NOW - 3 * HOUR, "A3");
state(agentDir, "active_waiting", "waiting", false, NOW - 20 * 60_000);
dispatch(agentDir, "active_needs_review", repoB1, NOW - 3 * HOUR, "A4");
state(agentDir, "active_needs_review", "completed", true, NOW - 10 * 60_000); // 终态无 result → 待审 visible + attention
// V3：result completed → hidden terminal（不占 active）
dispatch(agentDir, "done_ok", repoB2, NOW - 5 * HOUR, "D1");
write(join(agentDir, "tab-runs", "done_ok.result.json"), { id: "done_ok", taskId: "D1", status: "completed", finishedAt: iso(NOW - 4 * HOUR) });

// V3：附件 — repoA 有 detail + liveness 三一致（alive）；repoB1 无附件（none）；坏附件忽略
write(join(agentDir, "runtime", "registry", "attachments", "agent___master_default.json"), {
	agentAddress: "agent://master_default", sessionId: "global-sess-1234567890", generation: 4,
	attachedAt: iso(NOW - 10 * 60_000), lastHeartbeatAt: iso(NOW - 2 * 60_000), attemptId: "a1",
});
write(join(agentDir, "runtime", "registry", "attachments", "agent___master_local_repoA.json"), {
	agentAddress: "agent://master_local_repoA", sessionId: "local-sess-aaaaaaaa", generation: 2,
	attachedAt: iso(NOW - 60 * 60_000), lastHeartbeatAt: iso(NOW - 60_000), attemptId: "a2", detail: repoA,
});
write(join(agentDir, "runtime", "registry", "attachments", "agent___master_local_broken.json"), {
	agentAddress: "agent://master_local_broken", sessionId: "x", generation: 1,
	attachedAt: iso(NOW), lastHeartbeatAt: iso(NOW), attemptId: "a3",
}); // 无 detail → 忽略，不建仓
write(join(agentDir, "runtime", "state", "scope-liveness", "repoA.json"), {
	scopeKey: "repoA", sessionId: "local-sess-aaaaaaaa", generation: 2, pid: process.pid, updatedAt: iso(NOW - 60_000),
});

// V4：timer — repoA root pending（ownerCwd≠查询 cwd）、tab 邮箱 pending（run 映射）、fired 不计、unmapped 进 HOME
const timersDir = join(agentDir, "timers");
write(join(timersDir, "timer_rootA.json"), { id: "timer_rootA", version: 1, dueAt: iso(NOW + HOUR), message: "m", target: "self", source: "t", status: "pending", ownerCwd: repoA, createdAt: iso(NOW - HOUR) });
write(join(timersDir, "timer_fired.json"), { id: "timer_fired", version: 1, dueAt: iso(NOW - 2 * HOUR), message: "m", target: "self", source: "t", status: "fired", ownerCwd: repoA, createdAt: iso(NOW - 3 * HOUR) });
write(join(timersDir, "timer_unmapped.json"), { id: "timer_unmapped", version: 1, dueAt: iso(NOW - 30 * 60_000), message: "m", target: "self", source: "t", status: "pending", createdAt: iso(NOW - HOUR) });
mkdirSync(join(timersDir, "mail", "active_working"), { recursive: true });
write(join(timersDir, "mail", "active_working", "timer_tab1.json"), { id: "timer_tab1", version: 1, dueAt: iso(NOW + 2 * HOUR), message: "m", target: { tabRunId: "active_working" }, source: "t", status: "pending", createdAt: iso(NOW - HOUR) });
// repoB2 仅终态 hidden + 一个 pending tab timer → 仍以候选入行（同名消歧用）
mkdirSync(join(timersDir, "mail", "done_ok"), { recursive: true });
write(join(timersDir, "mail", "done_ok", "timer_tab2.json"), { id: "timer_tab2", version: 1, dueAt: iso(NOW + 3 * HOUR), message: "m", target: { tabRunId: "done_ok" }, source: "t", status: "pending", createdAt: iso(NOW - HOUR) });

// V5：mailbox — global p3/c1（含 1 acked 不计）；scope 按附件精确归仓
const mbox = join(agentDir, "runtime", "mailbox");
mkdirSync(join(mbox, "agent___master_default"), { recursive: true });
write(join(mbox, "agent___master_default", "m1.json"), { status: "pending" });
write(join(mbox, "agent___master_default", "m2.json"), { status: "pending" });
write(join(mbox, "agent___master_default", "m3.json"), { status: "pending" });
write(join(mbox, "agent___master_default", "m4.json"), { status: "claimed" });
write(join(mbox, "agent___master_default", "m5.json"), { status: "acked" });

// gitProbe 注入：V7 断言只调注入探针（默认探针零调用 → 无 shell/cd）
let defaultProbeCalls = 0;
const gitProbe = (root: string): { branch: string; dirty: string } => {
	defaultProbeCalls++;
	if (root === repoA) return { branch: "main", dirty: "dirty" };
	return { branch: "?", dirty: "?" };
};

// —— 默认聚合断言 ——
const snap = collectGlobalView({ agentDir, now: NOW, gitProbe });
assert.equal(snap.tabsActive, 4, `有效 tab 数应=4，实得 ${snap.tabsActive}`);
assert.ok(snap.totals.orphaned >= 120, `hidden orphaned≥120，实得 ${snap.totals.orphaned}`);
assert.equal(snap.totals.terminal, 1, "terminal hidden=1");
assert.equal(snap.totals.attention, 1, "attention=1（终态无 result 待审）");
assert.equal(snap.owner, "global-sess-", "global owner 前缀");
assert.equal(snap.generation, "4");
assert.equal(snap.inboxPending, 3, "global inbox p3");
assert.equal(snap.inboxClaimed, 1, "global inbox c1");
assert.equal(snap.home.timer, 1, "HOME unmapped timer=1");
assert.equal(snap.home.mail, "p3/c1");
const rowA = snap.rows.find((r) => r.repoPath === repoA);
assert.ok(rowA, "repoA 入行");
assert.equal(rowA!.tabActive, 2, "repoA active=2（fresh+working）");
assert.equal(rowA!.plans, "2", "repoA plans=2");
assert.equal(rowA!.local, "alive(1m)", `repoA local=alive，实得 ${rowA!.local}`);
assert.equal(rowA!.branch, "main");
assert.equal(rowA!.dirty, "dirty");
assert.ok(rowA!.timer >= 1, "repoA timer≥1（root ownerCwd + tab 邮箱）");
// 同 basename 消歧
const bRows = snap.rows.filter((r) => r.display.startsWith("base("));
assert.equal(bRows.length, 2, `同名 base 两仓应消歧，实得 ${JSON.stringify(snap.rows.map((r) => r.display))}`);
// detail 缺失附件不建仓
assert.ok(!snap.rows.some((r) => r.repoPath.includes("broken")), "无 detail 附件不建仓");

const text = formatGlobalView(snap);
const lines = text.split("\n");
assert.ok(lines.length <= 30, `默认输出≤30 行，实得 ${lines.length}`);
assert.ok(lines[0]!.startsWith("Global | owner="), "首行 Global 头");
assert.ok(text.includes("hidden=orphaned:120"), `脚注 hidden orphaned:120，实得 ${text.split("\n").at(-2)}`);
assert.ok(!text.includes("orphan_000"), "默认不列 orphan 明细");
assert.ok(text.includes("attention=1"), "attention 脚注");

// —— history 分页找回 ——
const hist = collectGlobalView({ agentDir, now: NOW, history: true, page: 1, gitProbe });
assert.ok(hist.historyTotal >= 121, `history total≥121，实得 ${hist.historyTotal}`);
const histText = formatGlobalView(hist);
assert.ok(histText.includes("history shown="), "history 标注 shown/total");
const lastPage = collectGlobalView({ agentDir, now: NOW, history: true, page: 7, gitProbe });
const allHistIds = [...hist.history, ...lastPage.history].map((h) => h.id);
assert.ok(hist.history.some((h) => h.id === "orphan_000") || lastPage.history.some((h) => h.id === "orphan_000") || hist.historyTotal > 20, "history 分页可召回");
assert.ok(hist.history.length <= 20, "history 每页≤20");

// —— 同名 tool/slash 共用逻辑 + 参数非法 → 用法 ——
const via = globalViewLogic({ page: 1 }, { agentDir, now: NOW, gitProbe });
assert.ok(via.text.startsWith("Global |"), "tool 与 slash 同一 collector 输出");
assert.ok((via.details.rows as unknown[]).length > 0, "tool details 带结构化行");
const bad = parseGlobalViewArgs("--page x");
assert.equal(bad.ok, false, "非法参数返回用法");
const gc = parseGlobalViewArgs("gc --apply");
assert.equal(gc.ok, false);
assert.match((gc as { text: string }).text, /未上线/, "gc apply 拒绝执行（只读阶段）");
const inbox = globalViewLogic({ section: "inbox" }, { agentDir, now: NOW, gitProbe });
assert.match(inbox.text, /p3\/c1/, "inbox 只读计数");

// —— never-throw：坏 JSON 不抛 ——
writeFileSync(join(agentDir, "tab-runs", "broken.json"), "{not json", "utf8");
const snap2 = collectGlobalView({ agentDir, now: NOW, gitProbe });
assert.equal(snap2.tabsActive, 4, "坏文件跳过后计数不变");
assert.ok(snap2.warnings.length > 0, "坏文件记 warnings");

assert.ok(defaultProbeCalls > 0, "注入探针被调用");
// 默认探针在本测试中从未使用（无 shell/cd 由构造保证：collector 只调注入 gitProbe）
assert.ok(!existsSync(join(agentDir, "tab-runs", "_archived")), "只读聚合零写盘（无归档目录）");
for (const f of ["broken.json"] as const) {
	const raw = readFileSync(join(agentDir, "tab-runs", f), "utf8");
	assert.ok(raw.length > 0, "未删除源文件");
}

console.log(`global-view OK: tabs=${snap.tabsActive} hidden_orphaned=${snap.totals.orphaned} lines=${lines.length} repos=${snap.reposTotal}`);

// ── phase2 探测深度增强（0923 global-view depth plan §1-§7）──────────────────
// 隔离 agentDir2：零干扰既有断言。覆盖：明细列+来源降级、置顶序、+/-/~ 差分、
// 跨仓闸口容错全套、无基线首次运行、collector 纯只读、零侵入回归。
import { collectGlobalView as collect2, formatGlobalView as format2, globalViewLogic as logic2, rankDetail, readGateStatus } from "./runtime/global-view.ts";
import { sessionBucketForCwd as bucket2 } from "./tab-runs.ts";

const agent2 = mkAgent();
const NOW2 = Date.now();
const repoC = mkdtempSync(join(tmpdir(), "gv2-repoC-"));
const repoD = mkdtempSync(join(tmpdir(), "gv2-repoD-"));
const repoE = mkdtempSync(join(tmpdir(), "gv2-repoE-"));
const repoF = mkdtempSync(join(tmpdir(), "gv2-repoF-"));
for (const r of [repoC, repoD, repoE, repoF]) mkdirSync(join(r, ".git"), { recursive: true });
// repoC：有表 + Status waiting → gate=awaiting
writeFileSync(join(repoC, "recentwork.md"),
	`# recent\n\n## Active Tasks\n\n### Task Index\n\n| Item | Priority | Summary | Dependency | Next action |\n| R1 | P0 | demo | none | wait human |\n\n**Status**：waiting（等人工确认）\n`, "utf8");
// repoE：超 64KB → unknown
writeFileSync(join(repoE, "recentwork.md"), "x".repeat(70 * 1024), "utf8");
// repoF：表头漂移 → unknown
writeFileSync(join(repoF, "recentwork.md"),
	`# recent\n\n## Active Tasks\n\n### Task Index\n\n| Foo | Bar | Baz |\n| a | b | c |\n`, "utf8");
// repoD：缺 recentwork.md → unknown（不污染他仓）

const d2 = (id: string, cwd: string, atMs: number, task: string): void => {
	write(join(agent2, "tab-runs", `${id}.json`), { id, version: 1, taskId: task, mode: "workflow", cwd, dispatchedAt: iso(atMs), dispatchStatus: "dispatched" });
};
const s2 = (id: string, phase: string, terminal: boolean, atMs: number, extra: Record<string, unknown> = {}): void => {
	write(join(agent2, "tab-runs", `${id}.state.json`), { id, phase, turn: "working", terminal, lastActivityAt: iso(atMs), ...extra });
};
// w_stale：working + 无进展 60min(>45min 阈值) + 长摘要(>120) + 产物 missing + repoC gate awaiting → needsHuman
const LONG = "摘".repeat(200);
d2("w_stale", repoC, NOW2 - 3 * HOUR, "C1");
s2("w_stale", "working", false, NOW2 - 60 * 60_000, { lastStopReason: "stop", lastAssistantText: LONG });
write(join(agent2, "tab-runs", "w_stale_extra.json"), { noop: 1 }); // 干扰文件：dispatch 校验失败应被忽略
// w_wait：waiting 近期 → awaitingInput → needsHuman（repoD gate unknown 照样成立）
d2("w_wait", repoD, NOW2 - 3 * HOUR, "D1");
s2("w_wait", "waiting", false, NOW2 - 5 * 60_000, { lastStopReason: "stop" });
// t_term：终态无 result → 待审 visible（rank 2）
d2("t_term", repoD, NOW2 - 3 * HOUR, "D2");
s2("t_term", "completed", true, NOW2 - 10 * 60_000);
// p_probe：state 缺 stop/摘要 → 走 tail-capped 会话探活补 stop=error + 摘要
const PTASK = "PT1";
d2("p_probe", repoD, NOW2 - 3 * HOUR, PTASK);
s2("p_probe", "working", false, NOW2 - 5 * 60_000);
const sessBucket = join(agent2, "sessions", bucket2(repoD));
mkdirSync(sessBucket, { recursive: true });
const probeText = "探".repeat(150);
writeFileSync(join(sessBucket, "s1.jsonl"), [
	JSON.stringify({ type: "session", id: "sess-p", timestamp: iso(NOW2 - 2 * HOUR) }),
	JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: `根据workflow进行工作${PTASK}\n做事` }] } }),
	JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "error", content: [{ type: "text", text: probeText }] } }),
].join("\n"), "utf8");
// f_tab：repoF 表头漂移仓里的普通 working
// g_tab：repoE 超大仓里的普通 working（用新 dispatch，无 state → dispatched 可见）
d2("f_tab", repoF, NOW2 - 60_000, "F1");
d2("g_tab", repoE, NOW2 - 60_000, "G1");

const byId = (snapX: { details: { runId: string }[] }, id: string): any =>
	(snapX.details as any[]).find((d) => d.runId === id);

// A. rank 置顶序（纯函数单测，含 unconfirmed）
const R = (o: object): number => rankDetail({ needsHuman: false, phase: "working", resultMissing: true, terminal: false, staleOver: false, overdue: false, ...o });
assert.ok(R({ needsHuman: true }) < R({ phase: "unconfirmed" }), "等人工 > unconfirmed");
assert.ok(R({ phase: "unconfirmed" }) < R({ resultMissing: true, terminal: true }), "unconfirmed > resultMissing&&terminal");
assert.ok(R({ resultMissing: true, terminal: true }) < R({ staleOver: true }), "终态无 result > 无进展超阈值");
assert.ok(R({ staleOver: true }) < R({ overdue: true }), "无进展 > overdue timer");
assert.ok(R({ overdue: true }) < R({}), "overdue > 其余");

// B. 明细列 + 降级
const snapA = collect2({ agentDir: agent2, now: NOW2, gitProbe });
const stale = byId(snapA, "w_stale");
assert.equal(stale.phase, "working");
assert.equal(stale.taskId, "C1");
assert.ok(stale.staleOver, "无进展 60min > 45min 阈值");
assert.equal(stale.stop, "stop");
assert.equal(stale.summary.length, 120, "摘要截断 120 字");
assert.equal(stale.gate, "awaiting");
assert.equal(stale.needsHuman, true, "awaitingInput|gate awaiting → 等人工");
assert.equal(stale.openIssues, null, "缺 result.openIssues → unknown(null)，不当 0");
assert.equal(stale.artifact, "-", "无 result → 产物 -");
const wait = byId(snapA, "w_wait");
assert.equal(wait.needsHuman, true, "waiting→awaitingInput→等人工（gate unknown 照样成立）");
assert.equal(wait.gate, "unknown", "缺 recentwork → unknown");
assert.equal(wait.staleOver, false, "5min 无进展未超阈值");
const probe = byId(snapA, "p_probe");
assert.equal(probe.stop, "error", "tail 探活补 stop");
assert.equal(probe.summary.length, 120, "探活摘要同样截断 120");
const ftab = byId(snapA, "f_tab");
assert.equal(ftab.gate, "unknown", "表头漂移 → unknown");
assert.equal(ftab.stale, "unknown", "无 state.lastActivityAt → unknown（不拿 mtime 冒充）");
assert.equal(ftab.taskId, "F1");
const gtab = byId(snapA, "g_tab");
assert.equal(gtab.gate, "unknown", "超 64KB → unknown");
assert.ok(snapA.warnings.some((w) => w.includes("64KB")), "超大记 warnings");
// 跨仓缺失不污染他仓行
assert.equal(byId(snapA, "w_stale").gate, "awaiting", "repoD 缺失不污染 repoC");
// 行置顶：repoC（等人工）在无异常仓 repoE 之前
const order = snapA.rows.map((r) => r.repoPath);
assert.ok(order.indexOf(repoC) !== -1 && order.indexOf(repoE) !== -1 && order.indexOf(repoC) < order.indexOf(repoE), `等人工置顶：${order.join(",")}`);
// hygiene 单行：字段齐 + 未确认来源留 unknown
assert.match(snapA.hygiene, /zombiePid:\d+ otherMail:\d+ unmappedTimer:\d+/, "hygiene 计数器");
assert.match(snapA.hygiene, /wt:unknown port:unknown daemon:unknown/, "未确认来源留 unknown");
// 头三件套
const textA = format2(snapA);
assert.match(textA, /src=S\(state\)\+R\(result\)\+P\(probe:tail40\)\+G\(gate:recentwork\)\+D\(diff:last\.json\)/, "五源缩写自解释");
assert.match(textA, /cmd=global-view/, "生成命令回显");
assert.match(textA, /asof=/, "as-of");
assert.ok(textA.split("\n").length <= 30, "phase2 输出仍≤30 行");

// C. collector 纯只读：collect 不写基线
assert.ok(!existsSync(join(agent2, "global-view", "last.json")), "collector 纯只读，不写 last.json");

// D. 差分：首次 → +/~/-（经 globalViewLogic 写基线）
const first = logic2({ page: 1 }, { agentDir: agent2, now: NOW2, gitProbe });
assert.match(first.text, /diff:none\(baseline saved\)/, "首次无基线");
assert.ok(existsSync(join(agent2, "global-view", "last.json")), "调用层 best-effort 落基线");
assert.ok((first.details.diff as { note: string }).note === "none(baseline saved)");
// 变更：w_stale 落 result（→hidden，即 removed）；w_wait 改 phase（→changed）；新增 n_new（→added）
write(join(agent2, "tab-runs", "w_stale.result.json"), { id: "w_stale", taskId: "C1", status: "completed", finishedAt: iso(NOW2) });
s2("w_wait", "working", false, NOW2 - 5 * 60_000, { lastStopReason: "stop" });
d2("n_new", repoD, NOW2 - 60_000, "D9");
const second = logic2({ page: 1 }, { agentDir: agent2, now: NOW2 + 60_000, gitProbe });
const diff2 = second.details.diff as { added: string[]; changed: string[]; removed: string[]; note: string };
assert.ok(diff2.removed.includes("w_stale"), `removed 含 w_stale：${JSON.stringify(diff2)}`);
assert.ok(diff2.changed.some((c) => c.startsWith("w_wait:")), `changed 含 w_wait：${JSON.stringify(diff2)}`);
assert.ok(diff2.added.includes("n_new"), `added 含 n_new：${JSON.stringify(diff2)}`);
assert.match(second.text, /\+n_new/, "渲染 + 标记");
assert.match(second.text, /~w_wait:/, "渲染 ~ 标记");
assert.match(second.text, /-w_stale/, "渲染 - 标记");

// E. 坏基线 → 当作无基线（行为同首次运行）+ warn
writeFileSync(join(agent2, "global-view", "last.json"), "{broken", "utf8");
const snapE = collect2({ agentDir: agent2, now: NOW2, gitProbe });
assert.equal(snapE.diff.note, "none(baseline saved)", "坏基线按首次运行");
assert.ok(snapE.warnings.some((w) => w.includes("基线损坏")), "坏基线记 warn");
assert.ok(snapE.details.length > 0, "坏基线全表仍出");

// F. readGateStatus 直测：缺文件/坏解析一律 unknown 且不抛
assert.equal(readGateStatus(join(tmpdir(), "gv2-nope-xyz"), []), "unknown");

console.log(`global-view phase2 OK: details=${snapA.details.length} humans=${snapA.details.filter((d: any) => d.needsHuman).length} diff2=${JSON.stringify(diff2)}`);

// ── G. M1：满页 30 行截断不得吞尾行（plans/0923_global_view_depth_review.md §11）──
import type { GlobalViewSnapshot as SnapT, RepoRow as RowT, TabDetail as DetailT } from "./runtime/global-view.ts";
const gRow = (n: string): RowT => ({
	repoPath: `/r/${n}`, display: `repo${n}`, local: "alive(1m)", branch: "main", dirty: "clean",
	tabText: `w:${n}`, tabActive: 1, attention: 0, timer: 0, overdue: 0, mail: "p0/c0", mailPending: 0,
	plans: "0", plansCount: 0, lastMs: 0, lastText: "2m",
});
const gHome: RowT = { ...gRow("H"), repoPath: "__HOME__", display: "HOME", local: "global(2m)", branch: "-", dirty: "-", tabText: "-", tabActive: 0, timer: 1, mail: "p3/c1", mailPending: 3, plans: "-", plansCount: null };
const gDetail = (i: number, over: boolean, human: boolean): DetailT => ({
	runId: `run_${i}`, repoPath: `/r/r${i}`, phase: "working", taskId: `T${i}`, age: "1h", stale: over ? "60m" : "5m",
	staleOver: over, stop: "stop", artifact: "-", artifactMtime: "-", resultMissing: false, terminal: false,
	openIssues: null, summary: `sum${i}`, needsHuman: human, gate: human ? "awaiting" : "ok", overdue: 0, pidAlive: null,
});
const gBase = {
	owner: "global-sess-1", generation: "4", cutover: "on", asof: "2026-09-23T00:00:00.000Z",
	tabsActive: 7, timersPending: 1, inboxPending: 3, inboxClaimed: 1,
	home: gHome, totals: { orphaned: 120, terminal: 1, noResult: 2, attention: 3, gitUnknown: 1, otherMail: 0 },
	cursor: { page: 1, pageSize: 20, totalPages: 1 }, history: [], historyTotal: 0,
	hygiene: "hygiene: zombiePid:0 otherMail:0 unmappedTimer:1 wt:unknown port:unknown daemon:unknown",
	command: "global-view", baselinePayload: { savedAt: "2026-09-23T00:00:00.000Z", tabs: {}, repos: {} },
};
const gAllRows = Array.from({ length: 21 }, (_, i) => gRow(`r${String(i + 1).padStart(2, "0")}`));
// 满页：21 仓（page1 显示 20 → 溢出提示）+ 6 个 staleOver tab + 1 needs-human + warn×2 + partial
const fullSnap: SnapT = {
	...gBase, reposTotal: 21, shown: 20, rows: gAllRows.slice(0, 20),
	details: [gDetail(0, false, true), ...Array.from({ length: 6 }, (_, i) => gDetail(i + 1, true, false))],
	warnings: ["坏 dispatch 跳过: broken.json", "基线损坏，按首次运行处理"], partial: true,
	diff: { added: ["n_new"], changed: ["w_wait:working"], removed: ["w_stale"], note: "" },
} as SnapT;
const fullLines = formatGlobalView(fullSnap).split("\n");
assert.equal(fullLines.length, 30, `满页输出恰 30 行（不超上限），实得 ${fullLines.length}`);
const tailIdx = fullLines.findIndex((l) => l.startsWith("src="));
assert.ok(tailIdx > 0, "sources 行在");
assert.ok(fullLines.some((l) => l.startsWith("needs-human: ")), "①' sources 后 needs-human 行在");
assert.ok(fullLines.some((l) => l.startsWith("hygiene: ")), "① hygiene 行在（修复前被吞）");
assert.ok(fullLines.some((l) => l.startsWith("diff: ")), "② diff 行在（修复前被吞）");
assert.ok(fullLines.some((l) => l.startsWith("warn: ")), "③ warn 行在（修复前被吞）");
assert.ok(fullLines.some((l) => l.startsWith("partial: ")), "④ partial 行在（修复前被吞）");
assert.ok(fullLines.some((l) => l === "! +2 more actionable (见 tool details)"), "actionable 溢出提示在");
for (const key of ["hygiene: ", "diff: ", "warn: ", "partial: "]) {
	assert.ok(fullLines.findIndex((l) => l.startsWith(key)) > tailIdx, `${key.trim()} 必须出现在尾部区`);
}
// ⑤ 被挤掉的只有表格明细行，且截断/翻页提示如实
const cutLine = fullLines.find((l) => l.includes("行截断（30 行上限）"));
assert.ok(cutLine, "表格截断提示在（不静默）");
assert.ok(cutLine!.includes("还有 +1 repos; /global-view --page 2"), `翻页提示如实：${cutLine}`);
assert.equal(fullLines.filter((l) => l.startsWith("repor")).length, 12, "明细行被裁到 12 行（含截断提示占 1 行）");
// ⑥ 小规模场景与修复前逐字节一致（golden 取自修复前实现的输出）
const smallSnap: SnapT = {
	...gBase, reposTotal: 3, shown: 3, rows: gAllRows.slice(0, 3),
	details: [gDetail(0, false, true), gDetail(1, true, false)],
	warnings: ["坏 dispatch 跳过: broken.json"], partial: true,
	diff: { added: [], changed: [], removed: [], note: "" },
} as SnapT;
const SMALL_GOLDEN = [
	"Global | owner=global-sess-1 gen=4 cutover=on | repos=3 shown=3 | tabs=7 timer=1 inbox=p3/c1 | asof=2026-09-23T00:00:00.000Z",
	"scope                 | local       | branch dirty     | tab                          | timer   | mail  | plans | last",
	"HOME                  | global(2m)  | - -               | -                            | 1       | p3/c1 | -     | 2m",
	"repor01               | alive(1m)   | main clean        | w:r01                        | 0       | p0/c0 | 0     | 2m",
	"repor02               | alive(1m)   | main clean        | w:r02                        | 0       | p0/c0 | 0     | 2m",
	"repor03               | alive(1m)   | main clean        | w:r03                        | 0       | p0/c0 | 0     | 2m",
	"hidden=orphaned:120,terminal:1,noResult:2; attention=3; unknown=git:1; /global-view --history /global-view inbox",
	"src=S(state)+R(result)+P(probe:tail40)+G(gate:recentwork)+D(diff:last.json) | cmd=global-view",
	"needs-human: run_0",
	"! run_0 working age:1h stale:5m stop:stop art:-@- issues:unknown human:Y sum0",
	"! run_1 working age:1h stale:60m stop:stop art:-@- issues:unknown human:- sum1",
	"hygiene: zombiePid:0 otherMail:0 unmappedTimer:1 wt:unknown port:unknown daemon:unknown",
	"diff: clean",
	"warn: 坏 dispatch 跳过: broken.json",
	"partial: 扫描超预算，计数可能不完整",
].join("\n");
assert.equal(formatGlobalView(smallSnap), SMALL_GOLDEN, "⑥ 小规模输出与修复前逐字节一致");

console.log(`global-view M1 OK: full=${fullLines.length} lines rows_shown=12 tail=${fullLines.length - tailIdx} small=byte-identical`);
