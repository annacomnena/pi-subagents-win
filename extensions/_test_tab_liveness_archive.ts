/**
 * V3 护栏（gen14 最关心的一条）：**`stale` 不得进入任何归档终态集合**。
 *
 * 为什么这条比「改哪里」更重要：`archiveStaleTabRuns` 的两处字面集合当前是
 * `["completed", "failed", "cancelled", "orphaned"]`。一旦有人把 `stale` 加进去，
 * 340 个死账本会被立刻搬进 `_archived/` ⇒ `tab-steer` 查不到 ⇒ **静默丢消息**
 * （`tab-runs.ts:688-695` 的注释里已用事故登记过这个坑）。
 *
 * 本测试锁三件事：
 *   ① stale 账本**不被归档**（还在活跃目录）
 *   ② 真终态账本**仍会被归档**（对照组，防止把归档整体关掉）
 *   ③ 源码里两处集合**字面不含 stale**（静态锁，防止将来被加进去）
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { archiveStaleTabRuns } = await import("./tab-runs.ts");

let pass = 0;
const ok = (n: string) => { pass++; console.log(`  ✅ ${n}`); };
const OLD = new Date(Date.now() - 10 * 86_400_000).toISOString();

function mkPair(dir: string, id: string, phase: string, terminal: boolean) {
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, version: 1, taskId: id, mode: "execute", title: id, cwd: ".", dispatchedAt: OLD, dispatchStatus: "dispatched" }), "utf8");
  writeFileSync(join(dir, `${id}.state.json`), JSON.stringify({ id, phase, turn: "idle", terminal, pid: 1234, heartbeatAt: OLD }), "utf8");
}

// ── ① stale 账本不被归档；② 真终态仍归档 ──
{
  const d = mkdtempSync(join(tmpdir(), "arc-"));
  mkPair(d, "tab_s", "stale", false);      // 死了但**不是**终态 ⇒ 必须留在活跃目录
  mkPair(d, "tab_c", "completed", true);   // 真终态 ⇒ 对照组，应被归档
  const n = archiveStaleTabRuns(d, 72);
  const active = readdirSync(d);
  assert.ok(active.includes("tab_s.json"), "① stale 账本必须留在活跃目录（否则 steer 丢消息）");
  assert.ok(!active.includes("tab_c.json"), "② 真终态账本必须仍被归档（归档功能不能被关掉）");
  assert.equal(n, 1, `归档数应为 1（只有 tab_c），实际 ${n}`);
  ok("①② stale 不归档 / 真终态仍归档");
  rmSync(d, { recursive: true, force: true });
}

// ── ③ 静态锁：源码里两处归档集合字面不含 stale ──
{
  const src = readFileSync(new URL("./tab-runs.ts", import.meta.url), "utf8");
  const hits = src.match(/\["completed", "failed", "cancelled", "orphaned"\]/g) ?? [];
  assert.ok(hits.length >= 2, `应至少找到 2 处归档终态集合字面（实际 ${hits.length}）`);
  for (const h of hits) assert.ok(!h.includes("stale"), `归档集合里出现了 stale：${h}`);
  // 再反向确认：**归档语义**集合不得含 stale。
  // 怎么区分「归档集合」与「合法相位白名单」：前者只有终态值、**不含** attached；
  // 后者含 attached/working/waiting（那是 TabState 的完整域，**本该**含 stale）。
  const arrayLits = src.match(/\[[^\]]*\]/g) ?? [];
  const archiveLike = arrayLits.filter((a) => a.includes('"orphaned"') && a.includes('"completed"') && !a.includes('"attached"'));
  assert.ok(archiveLike.length >= 2, `应至少找到 2 处归档语义集合（实际 ${archiveLike.length}）`);
  for (const a of archiveLike) {
    assert.ok(!a.includes('"stale"'), `归档语义集合里出现了 stale（会导致 steer 丢消息）：${a}`);
  }
  ok("③ 静态锁：两处归档终态集合字面不含 stale");
}

// ── ④ maxAgeHours=0 路径（"仅归档已具备终态"）同样不碰 stale ──
{
  const d = mkdtempSync(join(tmpdir(), "arc2-"));
  mkPair(d, "tab_s", "stale", false);
  const n = archiveStaleTabRuns(d, 0);
  assert.ok(readdirSync(d).includes("tab_s.json"), "④ maxAgeHours=0 也不得归档 stale");
  assert.equal(n, 0, `maxAgeHours=0 时归档数应为 0，实际 ${n}`);
  ok("④ maxAgeHours=0 路径同样不碰 stale");
  rmSync(d, { recursive: true, force: true });
}

console.log(`\n_test_tab_liveness_archive: ${pass} checks passed`);
