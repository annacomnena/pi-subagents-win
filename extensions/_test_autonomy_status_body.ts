/**
 * F4② 回归网（R-21 L4 第二轮，2026-11-05）：`/autonomy status` 的**真实分支输出**。
 *
 * 为什么需要它 —— L4 实测的空白：
 *   这段诊断逻辑原先内联在 `extensions/index.ts` 的 `/autonomy` 命令 handler 里，
 *   而 `index.ts` 整包 import 会 stack overflow ⇒ **测试加载不到它**。
 *   L4 实测：把整段诊断清空，11/11 测试仍绿、`index.ts` 加载次数 0。
 *
 * 抽取后（`runtime/autonomy/status-body.ts`），本套件直接断言**真实函数**的输出，
 * 不是为测试另写一份 —— `index.ts` 的 handler 调用的就是这一个。
 *
 * 覆盖目标：R-2 规则 3 要求的**三态可分** + N1 归因 + F3 未来时间。
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "statusbody-"));
const runtimeDir = join(root, "runtime");
const stateDir = join(runtimeDir, "state");
const autonomyDir = join(stateDir, "autonomy");
const registryDir = join(runtimeDir, "registry");
for (const d of [autonomyDir, join(registryDir, "attachments")]) mkdirSync(d, { recursive: true });
process.env.PI_RUNTIME_DIR = runtimeDir;

const { buildAutonomyStatusBody } = await import("./runtime/autonomy/status-body.ts");

let pass = 0;
const ok = (n: string) => { pass++; console.log(`  ✅ ${n}`); };

const OWNER = "sid-owner-status";
const setOwner = (sid: string | null) => {
  const p = join(registryDir, "attachments", "agent___master_default.json");
  if (sid === null) { rmSync(p, { force: true }); return; }
  writeFileSync(p, JSON.stringify({ agentAddress: "agent://master_default", sessionId: sid, generation: 1, attachedAt: "2026-01-01T00:00:00.000Z" }), "utf8");
};
const writeHb = (atMsAgo: number, sessionId: string, tick = 30_000) => {
  const at = Date.now() - atMsAgo;
  writeFileSync(join(autonomyDir, "heartbeat.json"), JSON.stringify({ at, iso: new Date(at).toISOString(), pid: 1234, sessionId, tickIntervalMs: tick }), "utf8");
};
const writeFrontier = (asofMsAgo: number) => {
  writeFileSync(join(autonomyDir, "frontier.json"), JSON.stringify({ asof: Date.now() - asofMsAgo, baseline: false, projects: [], triggers: [] }), "utf8");
};
const clearAll = () => {
  rmSync(join(autonomyDir, "heartbeat.json"), { force: true });
  rmSync(join(autonomyDir, "frontier.json"), { force: true });
  rmSync(join(autonomyDir, "non-owner-ticks"), { recursive: true, force: true });
};

// ── ① 最重要的：函数**不崩**。修复前 `supervisionLines(...)` 是不存在的符号 ──
// （真实导出是 `supervisionLedgerLines`）⇒ 每次执行到这行都 ReferenceError
// ⇒ 被 catch 吞掉 ⇒ status 永远只返回「(状态不可读)」。
{
  clearAll();
  setOwner(OWNER);
  writeHb(5_000, OWNER);
  writeFrontier(10_000);
  const body = buildAutonomyStatusBody();
  assert.ok(!body.includes("状态不可读"), `① status 不得落到「(状态不可读)」（实际：${body.slice(0, 120)}）`);
  assert.ok(body.includes("autonomy: enabled="), "① 必须包含首行 enabled 读数");
  assert.ok(body.includes("supervision"), `① 必须包含监管账本行（这是修复前抛异常的那一行）—— 实际 body 末尾：${body.slice(-160)}`);
  ok("① 真实函数不崩，且监管账本行存在（修复 supervisionLines 未定义）");
}

// ── ② 三态之一：正常工作 ──
{
  clearAll(); setOwner(OWNER); writeHb(5_000, OWNER); writeFrontier(10_000);
  const body = buildAutonomyStatusBody();
  assert.ok(body.includes("诊断：正常"), `② 心跳 5s + 快照 10s ⇒ 应为「诊断：正常」（实际诊断行：${(body.match(/诊断：[^\n]*/) ?? ["<无>"])[0].slice(0, 80)}）`);
  ok("② 三态·正常工作");
}

// ── ③ 三态之二：①tick 死（心跳存在但陈旧）—— R-20 缺的那一态 ──
{
  clearAll(); setOwner(OWNER); writeHb(46 * 60_000, OWNER); writeFrontier(12 * 3600_000);
  const body = buildAutonomyStatusBody();
  const d = (body.match(/诊断：[^\n]*/) ?? ["<无>"])[0];
  assert.ok(d.includes("心跳已") && d.includes("未更新"), `③ 心跳 46min 陈旧 ⇒ 必须报「心跳已 Xmin 未更新」（实际：${d.slice(0, 110)}）`);
  assert.ok(!d.includes("诊断：未知"), "③ 不得落回「诊断：未知」（那正是 R-20 要消灭的）");
  ok("③ 三态·tick 死（R-20 第①态真实可达）");
}

// ── ④ 三态之三：②被关（心跳新鲜 + 快照陈旧）──
{
  clearAll(); setOwner(OWNER); writeHb(5_000, OWNER); writeFrontier(12 * 3600_000);
  const body = buildAutonomyStatusBody();
  assert.ok(body.includes("很可能被关"), `④ 心跳新鲜 + 快照 12h ⇒ 应为「很可能被关」（实际：${(body.match(/诊断：[^\n]*/) ?? ["<无>"])[0].slice(0, 90)}）`);
  ok("④ 三态·被关");
}

// ── ⑤ N1：上一任 owner 的陈旧心跳 ⇒ 必须「无法归因」，不得说当前 owner 死了/被关 ──
{
  clearAll(); setOwner(OWNER); writeHb(60 * 60_000, "previous-owner"); writeFrontier(12 * 3600_000);
  const body = buildAutonomyStatusBody();
  const d = (body.match(/诊断：[^\n]*/) ?? ["<无>"])[0];
  assert.ok(d.includes("无法归因"), `⑤ 心跳属上一任 owner ⇒ 必须「无法归因」（实际：${d.slice(0, 110)}）`);
  assert.ok(!d.includes("很可能被关"), "⑤ 不得报「被关」（那是当前 owner 的判断）");
  ok("⑤ N1 归因：上一任 owner 的心跳不被算作当前 owner");
}

// ── ⑥ F3：未来超容差的心跳 ⇒ 必须「无法判定」，不得报正常 ──
{
  clearAll(); setOwner(OWNER);
  const at = Date.now() + 120_000;
  writeFileSync(join(autonomyDir, "heartbeat.json"), JSON.stringify({ at, iso: new Date(at).toISOString(), pid: 1, sessionId: OWNER, tickIntervalMs: 30_000 }), "utf8");
  writeFrontier(10_000);
  const body = buildAutonomyStatusBody();
  const d = (body.match(/诊断：[^\n]*/) ?? ["<无>"])[0];
  assert.ok(d.includes("未来") || d.includes("无法判定"), `⑥ 未来 +120s ⇒ 必须报「无法判定」（实际：${d.slice(0, 110)}）`);
  assert.ok(!d.includes("诊断：正常"), "⑥ 不得报正常");
  ok("⑥ F3：未来心跳不判正常");
}

// ── ⑦ 无心跳 ⇒ 不得冒称「tick 未在跑」是唯一解释 ──
{
  clearAll(); setOwner(OWNER); writeFrontier(10_000);
  const body = buildAutonomyStatusBody();
  const d = (body.match(/诊断：[^\n]*/) ?? ["<无>"])[0];
  assert.ok(/无法确定|无法归因|未知/.test(d), `⑦ 无心跳 ⇒ 必须承认不确定（实际：${d.slice(0, 110)}）`);
  ok("⑦ 无心跳：措辞不越界");
}

rmSync(root, { recursive: true, force: true, maxRetries: 3 });
console.log(`\n_test_autonomy_status_body: ${pass} checks passed`);
