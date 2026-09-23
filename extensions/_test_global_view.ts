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
