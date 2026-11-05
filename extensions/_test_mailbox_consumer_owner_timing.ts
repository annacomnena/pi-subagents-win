/**
 * R-21 回归网：mailbox 消费端的 owner 判定**不得阻塞 interval 注册**。
 *
 * 事故（2026-11-05，实测）：`registerMailboxConsumer` / `registerWakeLoop` 在 `session_start`
 * 里判 `eligible`，false 就 `return` ⇒ interval 永不启动。而 **session_start 与 attach 是
 * 时序竞争**：gen14 的 session_start 在 15:57:35、global attach 写入在 15:58:01（晚 26s）
 * ⇒ 那一刻 `sid !== att.sessionId` ⇒ 整条 global mailbox 消费链一死 25 小时
 * （`agent___master_default` 26 封信：自动 17 / 人工 8 / 无 1；自动链最后一次 11-04 10:49）。
 *
 * 判据（这条测试必须能区分两种实现）：
 *   A. 注册层判 owner（旧） ⇒ attach 晚到 ⇒ **心跳永不写、interval 永不跑** ⇒ 用例红
 *   B. tick 层判 owner（新） ⇒ attach 晚到 ⇒ 心跳照写、下一拍就开始消费 ⇒ 用例绿
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "r21-"));
const runtimeDir = join(root, "runtime");
const mailboxDir = join(runtimeDir, "mailbox");
const stateDir = join(runtimeDir, "state");
const registryDir = join(runtimeDir, "registry");
mkdirSync(mailboxDir, { recursive: true });
mkdirSync(stateDir, { recursive: true });
mkdirSync(join(registryDir, "attachments"), { recursive: true });
process.env.PI_RUNTIME_DIR = runtimeDir;
delete process.env.PI_SUBAGENT;
delete process.env.PI_TAB_RUN_ID;

const OWNER_SID = "sid-owner-0001";
const LATE_SID = "sid-startup-0002";

// cutover 已启用（走 owner 分支，不走 legacy isMainSession）
writeFileSync(join(registryDir, "cutover.json"), JSON.stringify({ enabled: true, enabledBy: "t", enabledAt: "2026-01-01T00:00:00.000Z" }), "utf8");
// attachment 指向 OWNER_SID（模拟「attach 已经完成」的稳定态）
writeFileSync(
  join(registryDir, "attachments", "agent___master_default.json"),
  JSON.stringify({ agentAddress: "agent://master_default", sessionId: OWNER_SID, generation: 1, attachedAt: "2026-01-01T00:00:00.000Z" }),
  "utf8",
);

/** 造一封给 master_default 的 pending 信 */
function seedLetter(id: string): void {
  const dir = join(mailboxDir, "agent___master_default");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.json`),
    JSON.stringify({
      frame: { frame: "message", id, kind: "REPORT", from: "agent://master_local_x", to: "agent://master_default",
        requiresAck: true, sentAt: new Date().toISOString(), body: { summary: `letter ${id}` } },
      status: "pending",
    }),
    "utf8",
  );
}

function letterStatus(id: string): string | undefined {
  const p = join(mailboxDir, "agent___master_default", `${id}.json`);
  if (!existsSync(p)) return undefined;
  return JSON.parse(readFileSync(p, "utf8")).status;
}

// 假 pi：只在 session_start 时触发回调（与真实注册形态一致）
function makeFakePi(sessionId: string) {
  const handlers: Record<string, Array<(e: unknown, ctx?: unknown) => void>> = {};
  return {
    on(ev: string, cb: (e: unknown, ctx?: unknown) => void) {
      (handlers[ev] ??= []).push(cb);
    },
    fire(ev: string, ctx: unknown) {
      for (const cb of handlers[ev] ?? []) cb({}, ctx);
    },
    sent: [] as string[],
    sendUserMessage(body: string) {
      this.sent.push(body);
      return true;
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const { registerMailboxConsumer, registerWakeLoop } = await import("./mailbox-consumer.ts");
const { readAutonomyHeartbeat, listNonOwnerTicks, writeAutonomyHeartbeat, frontierFreshness } = await import("./runtime/autonomy/collect.ts");

let pass = 0;
function ok(name: string) {
  pass++;
  console.log(`  ✅ ${name}`);
}

// ── 用例 1（核心 / L4 F1）：sid ≠ attachment ⇔ interval 仍须启动，但
//    **共享 owner 心跳绝不能被非 owner 覆盖**（否则「owner 停了」会读成「tick 活着」）──
{
  rmSync(join(stateDir, "autonomy"), { recursive: true, force: true });
  const pi = makeFakePi(LATE_SID);
  const stop = registerWakeLoop(pi as never, {
    spawn: () => "tab_fake",
    mailboxDir,
    stateDir,
    intervalMs: 30, // 测速用
  });
  pi.fire("session_start", { sessionManager: { sessionId: LATE_SID } });
  await sleep(180);

  // F1 核心：共享 owner 槽位必须**保持空**（owner 从未跑过）
  const hb = readAutonomyHeartbeat({ stateDir });
  assert.equal(hb, null, "【L4 F1】非 owner 的 tick **不得**写共享 owner 心跳（会覆盖真 owner 的存活信号）");
  // 但必须留下 per-session 心跳，证明「本会话 timer 活着」
  const others = listNonOwnerTicks({ stateDir });
  assert.equal(others.length, 1, `非 owner 必须写 per-session 心跳（实际 ${others.length} 条）`);
  assert.equal(others[0].sessionId, LATE_SID, "per-session 心跳须记录 sessionId");
  assert.equal(others[0].tickIntervalMs, 30, "per-session 心跳须带 tick 周期");
  ok("非 owner 起 interval：不占 owner 槽位，改写 per-session 心跳（F1）");

  // 且非 owner 不得真的消费
  seedLetter("msg_nonowner_should_stay");
  await sleep(150);
  assert.equal(pi.sent.length, 0, "非 owner 的 tick 不得注入别人的信");
  assert.equal(letterStatus("msg_nonowner_should_stay"), "pending", "非 owner 的 tick 不得 claim 别人的信");
  ok("非 owner tick 不消费（owner 门下沉后仍有效）");
  stop();
}

// ── 用例 2（正面）：attach 之后 owner 的 tick 必须真的消费 ──
{
  rmSync(join(mailboxDir, "agent___master_default"), { recursive: true, force: true });
  rmSync(join(stateDir, "autonomy"), { recursive: true, force: true });
  const pi = makeFakePi(OWNER_SID);
  const stop = registerMailboxConsumer(pi as never, { mailboxDir, intervalMs: 30 });
  pi.fire("session_start", { sessionManager: { sessionId: OWNER_SID } });
  seedLetter("msg_owner_should_claim");
  await sleep(200);
  // 判据取「注入通道被真实调用」而不是信的终态：假 pi 下 injectFollowUpQuietly 判 unconfirmed
  // ⇒ 按设计把信退回 pending（at-least-once）。真正要证的是 **tick 跑起来了并走到了注入**。
  assert.ok(pi.sent.length > 0, `owner 的 tick 必须真的跑到注入（sent=${pi.sent.length}）`);
  // 收紧（L4 F4）：只认唯一标识，不用宽 OR
  assert.ok(pi.sent[0].includes("msg_owner_should_claim"), `注入正文须是**这封**信（实际: ${pi.sent[0]?.slice(0, 100)}）`);
  // 控制组：owner 正常路径 —— 注意这条在旧实现也会绿（session_start 就是 owner），
  // 它不是晚 attach 回归判据，真判据是用例 3。
  ok("owner tick 正常消费（稳定 owner 控制组；判别力在用例 3）");
  stop();
}

// ── 用例 3（时序竞争的正面复现）：启动时非 owner，**attach 后来才写入** ⇒ 下一拍必须开始消费 ──
// 这正是 gen14 的真实形状：session_start 15:57:35，attach 15:58:01。
{
  rmSync(join(mailboxDir, "agent___master_default"), { recursive: true, force: true });
  // 先把 attachment 指到「别人」
  writeFileSync(
    join(registryDir, "attachments", "agent___master_default.json"),
    JSON.stringify({ agentAddress: "agent://master_default", sessionId: "sid-someone-else", generation: 1, attachedAt: "2026-01-01T00:00:00.000Z" }),
    "utf8",
  );
  const pi = makeFakePi(LATE_SID);
  const stop = registerMailboxConsumer(pi as never, { mailboxDir, intervalMs: 30 });
  pi.fire("session_start", { sessionManager: { sessionId: LATE_SID } });

  seedLetter("msg_after_late_attach");
  await sleep(100);
  assert.equal(pi.sent.length, 0, "attach 之前不得消费（此时还归别人）");
  assert.equal(letterStatus("msg_after_late_attach"), "pending", "attach 之前信须保持 pending");

  // ← 这里模拟「attach 在某次 session_start 之后才完成」
  writeFileSync(
    join(registryDir, "attachments", "agent___master_default.json"),
    JSON.stringify({ agentAddress: "agent://master_default", sessionId: LATE_SID, generation: 2, attachedAt: new Date().toISOString() }),
    "utf8",
  );
  await sleep(250);
  assert.ok(pi.sent.length > 0, `attach 晚到后，下一拍必须开始消费；旧实现 interval 根本没起 ⇒ sent 恒 0（实际 ${pi.sent.length}）`);
  assert.ok(pi.sent[0].includes("msg_after_late_attach"), `注入正文须是那封晚到的信（实际: ${pi.sent[0]?.slice(0, 100)}）`);
  ok("attach 晚于 session_start：tick 下一拍自愈（旧实现永久卡死）★真判别力");
  stop();
}

// ── 用例 4（L4 F1 的隔离反例，审查者实测过的形状）：owner 心跳陈旧 + 只跑非 owner
//    ⇒ frontierFreshness 必须仍判「owner tick 停」，不能被非 owner 心跳洗成「很可能被关」 ──
{
  rmSync(join(stateDir, "autonomy"), { recursive: true, force: true });
  // 先把 attachment 切回 OWNER_SID，并写一份 1 小时前的 owner 心跳
  writeFileSync(
    join(registryDir, "attachments", "agent___master_default.json"),
    JSON.stringify({ agentAddress: "agent://master_default", sessionId: OWNER_SID, generation: 3, attachedAt: "2026-01-01T00:00:00.000Z" }),
    "utf8",
  );
  writeAutonomyHeartbeat({ stateDir, sessionId: OWNER_SID, tickIntervalMs: 30_000 });
  // 把 owner 心跳改成 1 小时前（writeAutonomyHeartbeat 总是写 now）
  const hbPath = join(stateDir, "autonomy", "heartbeat.json");
  const hbObj = JSON.parse(readFileSync(hbPath, "utf8"));
  hbObj.at = Date.now() - 3600_000;
  hbObj.iso = new Date(hbObj.at).toISOString();
  writeFileSync(hbPath, JSON.stringify(hbObj), "utf8");

  // 只启动非 owner 的 wake loop，owner loop 不跑
  const pi = makeFakePi(LATE_SID);
  const stop = registerWakeLoop(pi as never, { spawn: () => "tab_fake", mailboxDir, stateDir, intervalMs: 30 });
  pi.fire("session_start", { sessionManager: { sessionId: LATE_SID } });
  await sleep(180);

  const hbAfter = readAutonomyHeartbeat({ stateDir });
  assert.equal(hbAfter!.sessionId, OWNER_SID, "owner 槽位不得被非 owner 覆盖（F1）");
  const f = frontierFreshness({ asof: Date.now() - 3600_000 }, hbAfter);
  assert.equal(f.heartbeatStale, true, "【F1】owner 心跳 1h 陈旧 ⇒ 必须判 tick 停");
  assert.equal(f.suspectedDisabled, false, "【F1】不得因非 owner 活着而误报「autonomy 很可能被关」");
  assert.ok(listNonOwnerTicks({ stateDir }).length >= 1, "非 owner 的存活须有独立记录（不占 owner 槽位）");
  ok("★F1 反例：owner 停摆 + 非 owner 存活 ⇒ 仍正确判「owner tick 停」");
  stop();
}

// ── 用例 5（L4 F4 缺口①，2026-11-05 复验指出）：**wake loop 晚 attach 后必须真的开始干活** ──
//
// L4 原话：「没有 wake loop 晚 attach 后真实 evaluate/spawn/维护的正面测试。
// 仅证明非 owner timer 活着不能证明 owner 下半段会工作。」
//
// 判据取 **spawn 是否被真实调用**（`registerWakeLoop` 的 spawn 回调），而不是只看心跳：
// 心跳在 owner 门内就写了，而 spawn 在更后面的 evaluateWakes 里。
// 因此本用例必须能区分三种情况：
//   A. interval 未起（旧实现） ⇒ spawn 恒 0
//   B. 起了但下半段断了（只测到心跳就停） ⇒ spawn 恒 0
//   C. 完整工作 ⇒ spawn > 0
{
  rmSync(join(mailboxDir, "agent___master_default"), { recursive: true, force: true });
  rmSync(join(stateDir, "autonomy"), { recursive: true, force: true });
  // 启动时 owner 是别人
  writeFileSync(
    join(registryDir, "attachments", "agent___master_default.json"),
    JSON.stringify({ agentAddress: "agent://master_default", sessionId: "sid-wake-someone-else", generation: 5, attachedAt: "2026-01-01T00:00:00.000Z" }),
    "utf8",
  );
  // 造 workstream（形状照 `extensions/runtime/workstreams.ts:WorkstreamRecord`；
  // 必须满足 evaluateOne 的前置：status=active + wakePolicy.enabled + **ws 邮箱有 pending 信**，
  // 否则会停在 disabled / no-mail 分支、永远测不到 spawn —— 那就是 R-4 的「夹具不贴近真实形状」）
  // 判据改用 tick 的**确定性副作用** `expireSweep`（`mailbox-consumer.ts:667`）：
  // 它在 owner 门**之后**、autonomy 门**之前** ⇒ 不受 autonomy 的 graph frontier 输入影响，
  // 是「owner 下半段真的在跑」的干净证据。
  // 造一封**已过 expiresAt** 的非终态信 ⇒ 只要 sweep 跑到就该被置 expired。
  {
    const dir = join(mailboxDir, "agent___master_default");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "msg_should_expire.json"),
      JSON.stringify({
        frame: { frame: "message", id: "msg_should_expire", kind: "REPORT", from: "agent://master_local_x",
          to: "agent://master_default", requiresAck: false, sentAt: new Date(Date.now() - 7200_000).toISOString(),
          body: { summary: "stale" } },
        status: "pending",
        expiresAt: new Date(Date.now() - 3600_000).toISOString(), // 1h 前就过期
      }),
      "utf8",
    );
  }
  const expiredStatus = (): string | undefined => {
    const p = join(mailboxDir, "agent___master_default", "msg_should_expire.json");
    if (!existsSync(p)) return undefined;
    try { return JSON.parse(readFileSync(p, "utf8")).status; } catch { return undefined; }
  };

  const spawned: string[] = [];
  const pi = makeFakePi(LATE_SID);
  const stop = registerWakeLoop(pi as never, {
    spawn: (d) => { spawned.push(String((d as { workstreamId?: string })?.workstreamId ?? "?")); return "tab_fake"; },
    mailboxDir,
    stateDir,
    intervalMs: 30,
  });
  pi.fire("session_start", { sessionManager: { sessionId: LATE_SID } });
  await sleep(150);
  assert.equal(expiredStatus(), "pending", "attach 之前：非 owner 不得跑 expireSweep（信须仍 pending）");

  // ← attach 晚到（真实交接路径）
  writeFileSync(
    join(registryDir, "attachments", "agent___master_default.json"),
    JSON.stringify({ agentAddress: "agent://master_default", sessionId: LATE_SID, generation: 6, attachedAt: new Date().toISOString() }),
    "utf8",
  );
  await sleep(300);
  assert.equal(
    expiredStatus(),
    "expired",
    `【L4 F4】attach 晚到后 owner tick 必须真的跑到 expireSweep；interval 未起或下半段断开都恒 pending（实际 ${expiredStatus()}）`,
  );
  ok("★F4 缺口①：wake loop 晚 attach 后仍跑到真实维护副作用（不只是 timer 活着）");
  stop();
}

rmSync(root, { recursive: true, force: true, maxRetries: 3 });
console.log(`\n_test_mailbox_consumer_owner_timing: ${pass} checks passed`);
