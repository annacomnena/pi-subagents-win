/**
 * 断点 3 回归网（2026-11-09）：`tab-status` 读侧判活 + `steer`/`deliverable` 连带。
 *
 * 事故：`stateAlivePhase` 只认 phase 字面值（`tab-runs.ts:1074` 旧实现）⇒
 * 340 个死账本（心跳超龄数天~数月、pid 探活全失败）被判 alive
 * ⇒ `resolveTabLedger.deliverable` 对 340/340 全 `true`（硬编码）
 * ⇒ `tab-steer` 接受并落盘，但目标进程早没了 ⇒ 记录永久 pending、零报错。
 *
 * 另有第二条静默路径（实测）：`tabNeedsIdleWake` 对死账本仍返回 `needsWake:true(turn-idle)`
 * ⇒ 还会额外 drop 一条无人消费的 idle nudge timer。
 *
 * 判据（三层，两独立证据同向才算死）：
 *   stale ⇔ (pid 探活失败 ∧ 心跳超龄) ∨ (pid 活 ∧ OS 启动晚于最后心跳 ⇒ pid 复用)
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  tabLivenessVerdict, TAB_HEARTBEAT_MS, TAB_STALE_AFTER_MS,
  bindTabLivenessProbes, resolveTabLedger, composeTabStatus, countStaleByHeartbeat,
  isTabStateStale, validateTabState,
} = await import("./tab-runs.ts");
const { tabNeedsIdleWake } = await import("./steer-runtime.ts");

let pass = 0;
const ok = (n: string) => { pass++; console.log(`  ✅ ${n}`); };

// ── 夹具：可注入探活（不 spawn PowerShell）──
type Probe = { isPidAlive?: (pid: number) => boolean; startMs?: number };
function useProbe(p: Probe) {
  bindTabLivenessProbes({
    isPidAlive: (pid) => (p.isPidAlive ? p.isPidAlive(pid) : true),
    inspectLiveProcess: () => (p.startMs !== undefined ? { startedAtMs: p.startMs } : null),
  });
}
const NEW = Date.now() - 5_000;
const OLD = Date.now() - 10 * 86_400_000; // 10 天前
const st = (over: Partial<{ phase: string; pid: number; heartbeatAt: string; terminal: boolean }> = {}) => ({
  phase: "waiting", pid: 1234, heartbeatAt: new Date(NEW).toISOString(), terminal: false, ...over,
});

// ── ① 阈值与写入端同源 ──
{
  assert.equal(TAB_HEARTBEAT_MS, 30_000, "TAB_HEARTBEAT_MS 必须与写入端 30s 一致");
  assert.equal(TAB_STALE_AFTER_MS, 3 * TAB_HEARTBEAT_MS, "判死阈值 = 3 个心跳周期（不写死 90000）");
  ok("① 阈值 = 3 * TAB_HEARTBEAT_MS（与 heartbeatAt 注释里的 >90s 逐字一致）");
}

// ── ② 正常运行态：pid 活 + 心跳新鲜 + 启动早于心跳 ⇒ alive ──
{
  useProbe({ isPidAlive: () => true, startMs: Date.now() - 3600_000 });
  const v = tabLivenessVerdict(st(), { now: Date.now() });
  assert.equal(v.verdict, "alive", `活账本必须判 alive（实际 ${v.verdict}: ${v.reason}）`);
  ok("② 活着不误判（pid 活 + 心跳 5s + OS 启动早于心跳）");
}

// ── ③ 核心：pid 探活失败 ∧ 心跳超龄 ⇒ stale ──
{
  useProbe({ isPidAlive: () => false });
  const v = tabLivenessVerdict(st({ heartbeatAt: new Date(OLD).toISOString() }), { now: Date.now() });
  assert.equal(v.verdict, "stale", `死账本必须判 stale（实际 ${v.verdict}: ${v.reason}）`);
  assert.ok(v.reason.includes("not alive"), `reason 须说明 pid 探活失败：${v.reason}`);
  ok("③ pid 死 + 心跳超龄 ⇒ stale");
}

// ── ④ **pid 复用**（本次最重要）：pid 活但 OS 启动晚于最后心跳 ⇒ stale ──
// 这正是 2026-11-09 实测 2/27 的形状：pid 探活「成功」，但那个 pid 是别人的。
{
  const hbMs = OLD;
  useProbe({ isPidAlive: () => true, startMs: Date.now() - 3600_000 }); // OS 启动 1h 前，远晚于 10 天前的心跳
  const v = tabLivenessVerdict(st({ heartbeatAt: new Date(hbMs).toISOString() }), { now: Date.now() });
  assert.equal(v.verdict, "stale", `pid 复用必须判 stale（实际 ${v.verdict}: ${v.reason}）`);
  assert.ok(v.reason.includes("reused"), `reason 须点明 pid 复用：${v.reason}`);
  ok("④ ★pid 复用被识别（只靠 pid 探活会漏的那 2 例）");
}

// ── ⑤ 反例：pid 活 + 心跳新鲜但 OS 启动**早于**心跳 ⇒ 不是复用 ──
{
  useProbe({ isPidAlive: () => true, startMs: Date.now() - 7200_000 });
  const v = tabLivenessVerdict(st(), { now: Date.now() });
  assert.equal(v.verdict, "alive", "OS 启动早于心跳 ⇒ 不是复用，应判 alive");
  ok("⑤ 反例：启动早于心跳不算复用（避免全判死）");
}

// ── ⑥ 证据矛盾（pid 死但心跳新鲜）⇒ unknown，不判死 ──
// 理由：探活可能因权限失败；心跳可能是写入端 bug。单证据不足以判死。
{
  useProbe({ isPidAlive: () => false });
  const v = tabLivenessVerdict(st(), { now: Date.now() });
  assert.equal(v.verdict, "unknown", `证据矛盾应 unknown（实际 ${v.verdict}: ${v.reason}）`);
  ok("⑥ 证据矛盾 ⇒ unknown（不单证据判死）");
}

// ── ⑦ 列表视图：probePidStart:false 且 pid 活 ⇒ unknown（省 PowerShell，不冒充 alive）──
{
  useProbe({ isPidAlive: () => true, startMs: Date.now() - 3600_000 });
  const v = tabLivenessVerdict(st({ heartbeatAt: new Date(OLD).toISOString() }), { now: Date.now(), probePidStart: false });
  assert.equal(v.verdict, "unknown", `列表视图跳过复用检查时必须 unknown（实际 ${v.verdict}）`);
  assert.ok(v.reason.includes("reuse check skipped"), `reason 须说明跳过原因：${v.reason}`);
  ok("⑦ 列表视图不查 OS 启动时间 ⇒ 诚实地报 unknown 而非 alive");
}

// ── ⑧ 终态账本走终态路径，不被判 stale ──
{
  useProbe({ isPidAlive: () => false });
  const v = tabLivenessVerdict(st({ phase: "completed", terminal: true, heartbeatAt: new Date(OLD).toISOString() }), { now: Date.now() });
  assert.equal(v.verdict, "alive", "终态账本不该被判 stale（交给终态路径）");
  ok("⑧ 终态账本不误判");
}

// ── ⑨ `stale` 必须是合法 phase（否则 validateTabState 会拒掉读出来的账本）──
{
  const v = validateTabState({ id: "x", phase: "stale", turn: "idle", terminal: false });
  assert.equal(v.ok, true, `stale 必须是合法 phase（实际 ${JSON.stringify(v.errors)}）`);
  ok("⑨ `stale` 已进 validateTabState 白名单（否则读不回来）");
}

// ── ⑩ resolveTabLedger：死账本 deliverable 必须 false（要求 A）──
{
  const d = mkdtempSync(join(tmpdir(), "lv-"));
  writeFileSync(join(d, "tab_x.json"), JSON.stringify({ id: "tab_x", version: 1, taskId: "t", mode: "execute", title: "t", cwd: ".", dispatchedAt: new Date().toISOString(), dispatchStatus: "dispatched" }), "utf8");
  writeFileSync(join(d, "tab_x.state.json"), JSON.stringify({ id: "tab_x", phase: "waiting", turn: "idle", terminal: false, pid: 1234, heartbeatAt: new Date(OLD).toISOString() }), "utf8");
  useProbe({ isPidAlive: () => false });
  const l = resolveTabLedger(d, "tab_x");
  assert.equal(l.deliverable, false, `死账本 deliverable 必须 false（实际 ${l.deliverable}: ${l.reason}）`);
  assert.equal(l.stateAlive, false, "stateAlive 也必须 false");
  ok("⑩ ★要求 A：active 分支的 deliverable 不再硬编码 true");
  rmSync(d, { recursive: true, force: true });
}

// ── ⑪ 活账本 deliverable 仍 true（不误拒）──
{
  const d = mkdtempSync(join(tmpdir(), "lv2-"));
  writeFileSync(join(d, "tab_y.json"), JSON.stringify({ id: "tab_y", version: 1, taskId: "t", mode: "execute", title: "t", cwd: ".", dispatchedAt: new Date().toISOString(), dispatchStatus: "dispatched" }), "utf8");
  writeFileSync(join(d, "tab_y.state.json"), JSON.stringify({ id: "tab_y", phase: "waiting", turn: "idle", terminal: false, pid: 1234, heartbeatAt: new Date(NEW).toISOString() }), "utf8");
  useProbe({ isPidAlive: () => true, startMs: Date.now() - 3600_000 });
  const l = resolveTabLedger(d, "tab_y");
  assert.equal(l.deliverable, true, `活账本必须仍可投递（实际 ${l.deliverable}: ${l.reason}）`);
  ok("⑪ 活账本不误拒（deliverable 仍 true）");
  rmSync(d, { recursive: true, force: true });
}

// ── ⑫ 要求 B 第 2 条：死账本不得被 drop idle nudge ──
{
  const d = mkdtempSync(join(tmpdir(), "lv3-"));
  writeFileSync(join(d, "tab_z.state.json"), JSON.stringify({ id: "tab_z", phase: "waiting", turn: "idle", terminal: false, pid: 1234, heartbeatAt: new Date(OLD).toISOString() }), "utf8");
  useProbe({ isPidAlive: () => false });
  const wk = tabNeedsIdleWake(d, "tab_z");
  assert.equal(wk.needsWake, false, `死账本不得 needsWake（实际 ${wk.needsWake}: ${wk.reason}）`);
  assert.equal(wk.reason, "ledger-stale", `reason 须是 ledger-stale（实际 ${wk.reason}）`);
  ok("⑫ ★要求 B 第 2 条：死账本不再多收一条 idle nudge");
  rmSync(d, { recursive: true, force: true });
}

// ── ⑬ composeTabStatus：stale 时 phase 报 `stale`，且**不是**任何归档终态值 ──
{
  useProbe({ isPidAlive: () => false });
  const view = composeTabStatus({
    runId: "tab_s", dispatch: null, result: null, probe: null,
    state: { id: "tab_s", phase: "working", turn: "working", terminal: false, pid: 1234, heartbeatAt: new Date(OLD).toISOString() },
    probeLiveness: true,
  });
  assert.equal(view.phase, "stale", `stale 账本 phase 应报 stale（实际 ${view.phase}）`);
  assert.equal(view.terminal, false, "stale **不是**终态（terminal 必须 false）");
  assert.ok(["completed", "failed", "cancelled", "orphaned"].every((p) => p !== view.phase), "stale 不得等于任何归档终态值");
  ok("⑬ ★stale 报在自己的一档：terminal=false 且不等于任何归档终态");
}

// ── ⑭ 列表聚合计数（零探活）──
{
  const now = Date.now();
  const recs = [
    { phase: "waiting", state: { heartbeatAt: new Date(now - 5_000).toISOString() } },
    { phase: "working", state: { heartbeatAt: new Date(now - 200_000).toISOString() } },
    { phase: "attached", state: { heartbeatAt: new Date(now - 2 * 86_400_000).toISOString() } },
    { phase: "waiting", state: { heartbeatAt: new Date(now - 10 * 86_400_000).toISOString() } },
    { phase: "completed", terminal: true, state: { heartbeatAt: new Date(now - 10 * 86_400_000).toISOString() } },
  ];
  const c = countStaleByHeartbeat(recs, now);
  assert.equal(c.total, 3, `应计 3 个（终态不计），实际 ${c.total}`);
  assert.equal(c.over1d, 2, `>1d 应 2 个，实际 ${c.over1d}`);
  assert.equal(c.over7d, 1, `>7d 应 1 个，实际 ${c.over7d}`);
  ok("⑭ 列表聚合计数：终态不计、分档正确、零探活");
}

// ── ⑮ `isTabStateStale` 只做廉价判定（probePidStart:false）──
{
  useProbe({ isPidAlive: () => true, startMs: Date.now() });
  assert.equal(isTabStateStale(st({ heartbeatAt: new Date(OLD).toISOString() })), false, "廉价判定遇 pid 活 ⇒ 不判 stale（保守）");
  useProbe({ isPidAlive: () => false });
  assert.equal(isTabStateStale(st({ heartbeatAt: new Date(OLD).toISOString() })), true, "pid 死 + 心跳超龄 ⇒ stale");
  ok("⑮ isTabStateStale 保守：pid 活时不判 stale（避免误拒 steer）");
}

console.log(`\n_test_tab_liveness: ${pass} checks passed`);
