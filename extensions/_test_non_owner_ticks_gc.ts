/**
 * `state/autonomy/non-owner-ticks/` GC 回归（2026-11-09）。
 *
 * 背景：R-21 修复引入该目录（`writeNonOwnerTick`，让非 owner 会话也有独立存活信号），
 * 当时**没配 GC** ⇒ 无界增长（实测 22 个文件 / 27KB / 4 天涨 7 个）。
 *
 * 判据设计（**语义规则，不是写死文件数上限**）：
 *   文件名 = sha256(sessionId) ⇒ 同一会话天然只有一份（每次 tick 覆盖写同一路径）。
 *   所以「只留最近 N 个」会无差别删掉更早的所有会话 —— 而那可能包含刚挂起、还会回来的。
 *   正确判据是「多久没再 tick 过」⇒ 按年龄淘汰。
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { gcNonOwnerTicks, NON_OWNER_TICK_RETAIN_DAYS } = await import("./runtime/autonomy/collect.ts");

let pass = 0;
const ok = (n: string) => { pass++; console.log(`  ✅ ${n}`); };
const DAY = 86_400_000;

function mkState(): string {
  const st = mkdtempSync(join(tmpdir(), "gc-not-"));
  mkdirSync(join(st, "autonomy", "non-owner-ticks"), { recursive: true });
  return st;
}
const tickDir = (st: string) => join(st, "autonomy", "non-owner-ticks");
const writeTick = (st: string, key: string, atMs: number, sid = `sid-${key}`) =>
  writeFileSync(join(tickDir(st), `${key}.json`),
    JSON.stringify({ version: 1, at: atMs, iso: new Date(atMs).toISOString(), pid: 1, sessionId: sid, tickIntervalMs: 30_000, reason: "not-owner" }), "utf8");

// ── ① 超龄被删、未超龄保留 ──
{
  const st = mkState();
  const now = Date.now();
  writeTick(st, "fresh", now - 1 * DAY);
  writeTick(st, "borderline", now - (NON_OWNER_TICK_RETAIN_DAYS - 1) * DAY);
  writeTick(st, "aged", now - (NON_OWNER_TICK_RETAIN_DAYS + 1) * DAY);
  writeTick(st, "ancient", now - 400 * DAY);
  const r = gcNonOwnerTicks({ stateDir: st, now });
  assert.equal(r.scanned, 4, `扫描数应为 4（实际 ${r.scanned}）`);
  assert.equal(r.removed, 2, `应删 2 个（aged/ancient），实际删 ${r.removed}`);
  assert.ok(existsSync(join(tickDir(st), "fresh.json")), "新条目必须保留");
  assert.ok(existsSync(join(tickDir(st), "borderline.json")), "临近边界（保留期内）必须保留");
  assert.ok(!existsSync(join(tickDir(st), "aged.json")), "刚过保留期必须删除");
  assert.ok(!existsSync(join(tickDir(st), "ancient.json")), "远古条目必须删除");
  ok("① 按年龄淘汰：超龄删、保留期内留、边界不误删");
}

// ── ② 坏文件（无法解析 / 无 at）**不删** —— 它是发现问题的证据 ──
{
  const st = mkState();
  writeFileSync(join(tickDir(st), "broken.json"), "{not json", "utf8");
  writeFileSync(join(tickDir(st), "noat.json"), JSON.stringify({ sessionId: "x" }), "utf8");
  writeTick(st, "aged", Date.now() - 400 * DAY);
  const r = gcNonOwnerTicks({ stateDir: st });
  assert.equal(r.removed, 1, `只应删 aged 一个，实际 ${r.removed}`);
  assert.ok(existsSync(join(tickDir(st), "broken.json")), "坏 JSON 不得删除（是诊断证据）");
  assert.ok(existsSync(join(tickDir(st), "noat.json")), "无 at 字段不得删除");
  ok("② 坏文件保留：JSON 损坏 / 缺 at 都不删");
}

// ── ③ `.tmp` 不删（写入方的 rename 目标，删它会造成竞态）──
{
  const st = mkState();
  writeFileSync(join(tickDir(st), "abc.123.deadbeef.tmp"), JSON.stringify({ at: Date.now() - 400 * DAY }), "utf8");
  const r = gcNonOwnerTicks({ stateDir: st });
  assert.equal(r.scanned, 0, "只扫 .json（.tmp 不计入扫描数）");
  assert.ok(existsSync(join(tickDir(st), "abc.123.deadbeef.tmp")), ".tmp 必须保留");
  ok("③ .tmp 不动（避免与写入方 rename 竞态）");
}

// ── ④ 目录不存在 ⇒ 零动作、不抛 ──
{
  const st = mkdtempSync(join(tmpdir(), "gc-empty-"));
  const r = gcNonOwnerTicks({ stateDir: st });
  assert.deepEqual(r, { scanned: 0, removed: 0, keptOldestDays: null });
  ok("④ 目录不存在：零动作不抛");
}

// ── ⑤ **绝不碰 owner 心跳**（heartbeat.json 在上级目录）──
{
  const st = mkState();
  writeFileSync(join(st, "autonomy", "heartbeat.json"),
    JSON.stringify({ at: Date.now() - 400 * DAY, iso: "", pid: 1, sessionId: "owner", tickIntervalMs: 30_000 }), "utf8");
  writeTick(st, "aged", Date.now() - 400 * DAY);
  const r = gcNonOwnerTicks({ stateDir: st });
  assert.ok(existsSync(join(st, "autonomy", "heartbeat.json")), "⚠ owner 心跳绝不能被 GC 删");
  assert.equal(r.removed, 1, "只删 non-owner-ticks 里的超龄条目");
  ok("⑤ owner 心跳零影响（GC 只作用 non-owner-ticks/）");
}

// ── ⑥ 幂等：连跑两次，第二次不删任何东西 ──
{
  const st = mkState();
  writeTick(st, "fresh", Date.now() - DAY);
  writeTick(st, "aged", Date.now() - 400 * DAY);
  const r1 = gcNonOwnerTicks({ stateDir: st });
  const r2 = gcNonOwnerTicks({ stateDir: st });
  assert.equal(r1.removed, 1);
  assert.equal(r2.removed, 0, "第二次应零删除（幂等）");
  ok("⑥ 幂等：重复调用不误删");
}

// ── ⑦ keptOldestDays 反映保留条目的最老年龄（供 status 展示）──
{
  const st = mkState();
  writeTick(st, "a", Date.now() - 5 * DAY);
  writeTick(st, "b", Date.now() - 20 * DAY);
  const r = gcNonOwnerTicks({ stateDir: st });
  assert.ok(r.keptOldestDays !== null, "有保留条目时应给出最老年龄");
  assert.ok(r.keptOldestDays! > 19 && r.keptOldestDays! < 21, `应约 20 天（实际 ${r.keptOldestDays}）`);
  ok("⑦ keptOldestDays 可用于 status 展示（让「最老多少天」可见）");
}

console.log(`\n_test_non_owner_ticks_gc: ${pass} checks passed`);
