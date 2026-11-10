/**
 * V5 护栏（gen14 最关心的第二条）：**列表视图必须零 PowerShell spawn**。
 *
 * 为什么这条重要：`inspectLiveProcess` 每次 spawn 一个 PowerShell（单次 ~1-2s）。
 * 若有任何代码在列表路径上传 `probePidStart: true`，557 个账本 ⇒ 最坏 15 分钟卡死。
 *
 * 本测试用计数探针锁住：`buildTabStatusView(..., {probeLiveness:false})` 与
 * `countStaleByHeartbeat` 全程 **0 次 spawn**；同时对照组证明 `probeLiveness:true`
 * 确实会 spawn（否则护栏是假的）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { bindTabLivenessProbes, buildTabStatusView, countStaleByHeartbeat } = await import("./tab-runs.ts");

let pass = 0;
const ok = (n: string) => { pass++; console.log(`  ✅ ${n}`); };
const OLD = new Date(Date.now() - 10 * 86_400_000).toISOString();

// 计数探针：替换真实 inspectLiveProcess
let spawns = 0;
function arm(isAlive: boolean, startMs?: number) {
  spawns = 0;
  bindTabLivenessProbes({
    isPidAlive: () => isAlive,
    inspectLiveProcess: () => { spawns += 1; return startMs !== undefined ? { startedAtMs: startMs } : null; },
  });
}

function mkRuns(dir: string, n: number) {
  for (let i = 0; i < n; i++) {
    writeFileSync(join(dir, `tab_${i}.json`), JSON.stringify({ id: `tab_${i}`, version: 1, taskId: `t${i}`, mode: "execute", title: "t", cwd: ".", dispatchedAt: OLD, dispatchStatus: "dispatched" }), "utf8");
    writeFileSync(join(dir, `tab_${i}.state.json`), JSON.stringify({ id: `tab_${i}`, phase: "waiting", turn: "idle", terminal: false, pid: 1000 + i, heartbeatAt: OLD }), "utf8");
  }
}

// ── ① 列表视图（probeLiveness:false）：0 spawn ──
{
  const d = mkdtempSync(join(tmpdir(), "ns1-"));
  mkRuns(d, 20);
  arm(true, Date.now() - 3600_000);
  for (let i = 0; i < 20; i++) buildTabStatusView(d, `tab_${i}`, undefined, { probeLiveness: false });
  assert.equal(spawns, 0, `列表视图必须 0 spawn（实际 ${spawns}）`);
  ok("① 列表视图 20 项 ⇒ inspectLiveProcess 0 次");
  rmSync(d, { recursive: true, force: true });
}

// ── ② 对照组：精确查询（probeLiveness:true）确实会 spawn（证明护栏不是假的）──
{
  const d = mkdtempSync(join(tmpdir(), "ns2-"));
  mkRuns(d, 3);
  arm(true, Date.now() - 3600_000);
  for (let i = 0; i < 3; i++) buildTabStatusView(d, `tab_${i}`, undefined, { probeLiveness: true });
  assert.ok(spawns > 0, `精确查询必须会 spawn（否则 ①② 的护栏是假的）；实际 ${spawns}`);
  ok("② 对照组：精确查询确实 spawn（>0 次）");
  rmSync(d, { recursive: true, force: true });
}

// ── ③ 聚合计数零 spawn ──
{
  const d = mkdtempSync(join(tmpdir(), "ns3-"));
  mkRuns(d, 5);
  arm(true);
  const views = [];
  for (let i = 0; i < 5; i++) views.push(buildTabStatusView(d, `tab_${i}`, undefined, { probeLiveness: false }));
  const c = countStaleByHeartbeat(views, Date.now());
  assert.equal(spawns, 0, `countStaleByHeartbeat 必须 0 spawn（实际 ${spawns}）`);
  assert.equal(c.total, 5, `5 个超龄应全部计入（实际 ${c.total}）`);
  ok("③ 聚合计数零 spawn（只用已落盘的 heartbeatAt）");
  rmSync(d, { recursive: true, force: true });
}

// ── ④ 默认（不传 probeLiveness）= 精确语义（spawn）—— 防止默认值被改成 false ──
{
  const d = mkdtempSync(join(tmpdir(), "ns4-"));
  mkRuns(d, 2);
  arm(true, Date.now() - 3600_000);
  buildTabStatusView(d, "tab_0");
  assert.ok(spawns > 0, `不传 probeLiveness 时应按精确语义（spawn）—— 防默认值被悄悄改成 false；实际 ${spawns}`);
  ok("④ 缺省 = 精确语义（spawn），不会被静默降级");
  rmSync(d, { recursive: true, force: true });
}

console.log(`\n_test_tab_liveness_nospawn: ${pass} checks passed`);
