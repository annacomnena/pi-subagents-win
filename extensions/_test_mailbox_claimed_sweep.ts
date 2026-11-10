/**
 * _test_mailbox_claimed_sweep.ts — P0：claimed 卡死信的 consumed-ACK 清扫
 *
 * 【事故（2026-11-10，gen14 实测 6 封）】
 * `mailbox-consumer.ts` 的消费入口是 `listLetters(recipient, "pending")` —— **只枚举 pending**。
 * 于是 C-3 收尾（`if (listAcks(dDir, mbEventId).some(a => a.stage === "consumed")) ackLetter(...)`）
 * 只在 pending 循环体里，**claimed 的信永远走不到** ⇒ `consumed` ACK 写成功了，信仍停在 claimed
 * ⇒ 每 10min stale reclaim 重投一次，无限循环（实测 6 次/封）。
 *
 * 【修法（方案 C：不改 schema、不改 claim 路径，纯增清扫器）】
 * `sweepClaimedLetters`：枚举 claimed，反查 `mailbox_<frameId>` 的 delivery 事件，
 * **只有存在 `stage === "consumed"` 的 ACK 才 `ackLetter`**。
 * 没有 ACK 的**不碰**（必须有 consumed 证据才 ack，否则会把「claimed 但还没真消费」的信 ack 掉
 * ⇒ 丢消息，违反 AGENTS R-5「宁可重发，不可漏发」）。
 *
 * 【覆盖】① 有 consumed ACK ⇒ ack；② 无 ACK ⇒ 不动；③ ack 但 stage≠consumed ⇒ 不动；
 *          ④ 重复清扫幂等；⑤ delivery 目录缺失 ⇒ never-throw。
 */

import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "mb-sweep-"));
process.env.PI_RUNTIME_DIR = ROOT;

import { masterAddress } from "./runtime/address.ts";
import { attachMaster, setCutover } from "./runtime/registry.ts";
import { claimLetters, deliverLetter, listLetters } from "./runtime/mailbox.ts";
import { newEnvelopeId } from "./runtime/ids.ts";
import { newMessageFrame } from "./runtime/protocol.ts";
import { consumeMailboxOnce, sweepClaimedLetters } from "./mailbox-consumer.ts";
import { ensureEvent, eventFileKey } from "./delivery-ledger.ts";
import { ackConsumed } from "./delivery-ack.ts";

let n = 0;
const ok = (name: string): void => {
  n += 1;
  console.log(`ok ${n} - ${name}`);
};

const MAILBOX = join(ROOT, "mailbox");
const DELIVERY = join(ROOT, "delivery");
const master = masterAddress();
const SESSION = "sess-sweep";

/** 造一封 claimed 信（落盘 → claim → 返回 frame.id）。 */
function seedClaimed(): string {
  const frame = newMessageFrame({
    id: newEnvelopeId("msg"),
    kind: "REPORT",
    from: "agent://agent_worker_sweep",
    to: master,
    subject: "run://tab/tab_sweep",
    // sentAt 必须 ≥ cutover.enabledAt（setCutover 用真实 now）—— 否则被判 pre-cutover-legacy
    sentAt: new Date().toISOString(),
    summary: "sweep probe",
    details: {},
  });
  deliverLetter(frame, { mailboxDir: MAILBOX });
  const taken = claimLetters(master, {
    claimedBy: `mailbox-consumer:${SESSION}`,
    mailboxDir: MAILBOX,
    ids: [frame.id],
    limit: 1,
  });
  assert.equal(taken.length, 1, `seed: claim ${frame.id} 应成功`);
  return frame.id;
}

const claimedCount = (mid: string): number =>
  listLetters(master, "claimed", MAILBOX).filter((l) => l.frame.id === mid).length;
const ackedCount = (mid: string): number =>
  listLetters(master, "acked", MAILBOX).filter((l) => l.frame.id === mid).length;

try {
  mkdirSync(MAILBOX, { recursive: true });
  mkdirSync(DELIVERY, { recursive: true });
  attachMaster({ sessionId: SESSION });
  setCutover(true);

  // ── ① 有 consumed ACK 的 claimed 信 ⇒ 被 ack ──────────────────────
  let midA = "";
  {
    midA = seedClaimed();
    assert.equal(claimedCount(midA), 1, "① seed 后应 claimed");

    const { event } = ensureEvent(DELIVERY, {
      runId: `mailbox_${midA}`,
      terminalRevision: "rev1",
      terminalSnapshotPath: join(MAILBOX, midA),
      dispatcherSessionId: SESSION,
      observedAt: new Date().toISOString(),
      terminalAt: new Date().toISOString(),
    });
    ackConsumed(DELIVERY, [event.eventId], { evidence: "context-observed" });

    const swept = sweepClaimedLetters({ recipient: master, mailboxDir: MAILBOX, deliveryDir: DELIVERY });
    assert.equal(swept, 1, "① 应清扫 1 封");
    assert.equal(ackedCount(midA), 1, "① 应已 acked");
    assert.equal(claimedCount(midA), 0, "① 不应再 claimed");
    ok("① 有 consumed ACK ⇒ ack");
  }

  // ── ② 无 ACK 的 claimed 信 ⇒ 不动 ────────────────────────────────
  let midB = "";
  {
    midB = seedClaimed();
    const swept = sweepClaimedLetters({ recipient: master, mailboxDir: MAILBOX, deliveryDir: DELIVERY });
    assert.equal(swept, 0, "② 本轮不应清扫任何信");
    assert.equal(claimedCount(midB), 1, "② 无 ACK 应保持 claimed");
    ok("② 无 ACK ⇒ 不动（不丢消息）");
  }

  // ── ③ 有 ack 但 stage≠consumed ⇒ 不动 ────────────────────────────
  let midC = "";
  {
    midC = seedClaimed();
    const { event } = ensureEvent(DELIVERY, {
      runId: `mailbox_${midC}`,
      terminalRevision: "rev1",
      terminalSnapshotPath: join(MAILBOX, midC),
      dispatcherSessionId: SESSION,
      observedAt: new Date().toISOString(),
      terminalAt: new Date().toISOString(),
    });
    // 造一个 stage=expired 的 ack 文件（文件名必须用 eventFileKey 编码，与 listAcks 同源）
    writeFileSync(
      join(DELIVERY, eventFileKey(event.eventId) + ".ack.expired.x.json"),
      JSON.stringify({ eventId: event.eventId, stage: "expired", at: new Date().toISOString() }),
    );

    const swept = sweepClaimedLetters({ recipient: master, mailboxDir: MAILBOX, deliveryDir: DELIVERY });
    assert.equal(swept, 0, "③ 非 consumed ack 不应触发");
    assert.equal(claimedCount(midC), 1, "③ 应保持 claimed");
    ok("③ 非 consumed ack ⇒ 不动");
  }

  // ── ④ 重复清扫幂等 ──────────────────────────────────────────────
  {
    const again = sweepClaimedLetters({ recipient: master, mailboxDir: MAILBOX, deliveryDir: DELIVERY });
    assert.equal(again, 0, "④ 已 acked 的信不再进 claimed 列表 ⇒ 零动作");
    assert.equal(claimedCount(midA), 0, "④ A 仍不 claimed");
    ok("④ 重复清扫幂等");
  }

  // ── ⑤ delivery 目录缺失 ⇒ never-throw ─────────────────────────
  {
    let threw = false;
    try {
      sweepClaimedLetters({ recipient: master, mailboxDir: MAILBOX, deliveryDir: join(ROOT, "no-such-dir") });
    } catch {
      threw = true;
    }
    assert.equal(threw, false, "⑤ 目录缺失不应抛");
    ok("⑤ delivery 目录缺失 ⇒ never-throw");
  }

  // ── ⑥ 【真实入口】consumeMailboxOnce 内部是否真的调了清扫器 ───────────
  //  为什么必须这一条：本文件①②③④⑤ 都是**直接调** sweepClaimedLetters，
  //  「tick 里有没有接它」测不到（AGENTS R-21 教训：测试必须过真实注册/入口，
  //  否则变异「摘掉接线」不会红）。
  {
    const midD = seedClaimed();
    const { event } = ensureEvent(DELIVERY, {
      runId: `mailbox_${midD}`,
      terminalRevision: "rev1",
      terminalSnapshotPath: join(MAILBOX, midD),
      dispatcherSessionId: SESSION,
      observedAt: new Date().toISOString(),
      terminalAt: new Date().toISOString(),
    });
    ackConsumed(DELIVERY, [event.eventId], { evidence: "context-observed" });

    // 走真实入口（owner 门 + cutover + recipient 全在）
    consumeMailboxOnce({
      sessionId: SESSION,
      recipient: master,
      mailboxDir: MAILBOX,
      deliveryDir: DELIVERY,
      nowMs: Date.now(),
    });

    assert.equal(claimedCount(midD), 0, "⑥ consumeMailboxOnce 应把有 consumed ACK 的 claimed 信 ack 掉");
    assert.equal(ackedCount(midD), 1, "⑥ 应已 acked");
    ok("⑥ 真实入口 consumeMailboxOnce 内置清扫生效");
  }

  // ── ⑦ 之前先造「大目录」夹具（否则两版都快，测不出差异 = R-22 第 5 条）──
  //  真实生产 delivery 有 1837 个 .json（含 1104 派生）；这里造 1500 个派生 + 120 个 mailbox 事件，
  //  让「每事件一次 listAcks（内部 readdirSync 全目录）」的退回版超 50ms，而一次 readdir 建索引的
  //  当前版仍远低于门槛。
  {
    const { writeFileSync: wf } = await import("node:fs");
    // 60 个额外的 mailbox 事件（各自没有 consumed ACK，只为撑大事件数）
    for (let i = 0; i < 120; i++) {
      ensureEvent(DELIVERY, {
        runId: `mailbox_msg_bign${i}`,
        terminalRevision: "rev1",
        terminalSnapshotPath: join(MAILBOX, `msg_bign${i}`),
        dispatcherSessionId: SESSION,
        observedAt: new Date().toISOString(),
        terminalAt: new Date().toISOString(),
      });
    }
    // 600 个派生占位文件（模拟真实目录的 .ack./.attempt. 噪声）
    for (let i = 0; i < 1500; i++) {
      wf(join(DELIVERY, `pad-event-${i}.attempt.pad-${i}.json`), "{}");
    }
  }

  // ── ⑦ 性能回归：本轮必须 < 50ms（gen14 门槛，2026-11-10）──
  //  为什么要有这条：`listAcks` 每次内部 `readdirSync` 全目录，而 claimed/事件数会随使用增长。
  //  实测对照（本机真实 delivery 1837 项 / 30 个 mailbox 事件）：
  //    · 每事件一次 listAcks  ⇒ 95ms（readdir 55170 次）**超门槛**
  //    · 一次 readdir 建索引  ⇒ 1.3ms median（readdir 1 次）
  //  本测试用造出来的 20 封 claimed + 20 个事件，断言 < 50ms（真实环境更宽裕）。
  {
    const ROUNDS = 10;
    const times: number[] = [];
    for (let i = 0; i < ROUNDS; i++) {
      const t0 = performance.now();
      sweepClaimedLetters({ recipient: master, mailboxDir: MAILBOX, deliveryDir: DELIVERY });
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(ROUNDS / 2)]!;
    assert.ok(median < 50, `⑦ 清扫器 median 必须 < 50ms（实测 ${median.toFixed(2)}ms）`);
    ok(`⑦ 性能门槛 < 50ms（median ${median.toFixed(2)}ms）`);
  }

  console.log(`_test_mailbox_claimed_sweep: ${n} checks passed`);
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}
