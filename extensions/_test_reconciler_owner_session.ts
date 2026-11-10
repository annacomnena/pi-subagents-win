/**
 * _test_reconciler_owner_session.ts — B 类缺陷修复回归
 *
 * 【事故（2026-11-10，gen14 实测 7 条 pending + 每 15min 新增）】
 * tab 会话派 subagent 时，`links.jsonl` 的 `sessionId` 记的是 **tabRunId**（`tab_xxx`），
 * 而真实 pi 会话 UUID 记在 `ownerSessionId`（`index.ts:4534-4536` 双身份，**additive**）。
 *
 * 但 `resolveDispatcherFromLinks`（`delivery-reconciler-loop.ts`）**只读 `sessionId`、不看
 * `ownerSessionId`** ⇒ `dispatcherSessionId = "tab_xxx"` ⇒ B 补投写
 * `to = pi://tab_xxx`，而 outbox-bridge 的 filter 是
 * `it.to === piSessionAddress(自己的真 sessionId)` ⇒ **永不匹配** ⇒ 永停 pending，且
 * `events=0 / receipt=0`（桥连 claimInjection 都没走到）。
 *
 * 分母：`links.jsonl` kind=async 共 1197 条，其中 565（**47.2%**）是 `tab_` 形态。
 *
 * 【修法（gen14 授权「修」）】
 * 1. `resolveDispatcherFromLinks` 优先 `ownerSessionId`（**仅当 `sessionId` 是 `tab_` 形态**时，
 *    避免改动非 tab 场景的既有行为），回落 `sessionId`。
 * 2. `makeOutboxDeliver` 在**幂等命中**（`existing !== null`）时，若 `existing.to/sessionId`
 *    与当前算出的不一致且该项仍 `pending`，**修正这两个字段**（id/dedupeKey 不变 ⇒ 身份不变）
 *    —— 这是存量 7 条的迁移路径（无需删建，无重复注入）。
 * 3. 目标地址**不可达**时（`pi://tab_*` 且 link 无 `ownerSessionId`）：不写 outbox，返回
 *    `"unreachable"` 让 reconcileOnce 记 incident（**不静默**）。
 *
 * 【本测试覆盖】
 *   ① tab link 有 ownerSessionId ⇒ resolver 返回 UUID（不是 tab_xxx）
 *   ② 非 tab link ⇒ 行为完全不变（返回 sessionId，不因 ownerSessionId 存在而变）
 *   ③ tab link 无 ownerSessionId ⇒ 返回 undefined（fail closed，不猜）
 *   ④ deliver：新事件 ⇒ to 是 `pi://<UUID>`
 *   ⑤ deliver：存量项 to=pi://tab_xxx 且 pending ⇒ 被就地修正为 UUID（id/dedupeKey 不变）
 *   ⑥ deliver：存量项已终态 ⇒ **不碰**（防回滚）
 *   ⑦ 不可达地址 ⇒ 不写 item，返回 "unreachable"
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "recon-owner-"));
const LINKS = join(ROOT, "links.jsonl");
const STATE = join(ROOT, "state");

process.env.PI_LINKS_PATH = LINKS;
process.env.PI_RUNTIME_DIR = ROOT;

import { resolveDispatcherFromLinks, makeOutboxDeliver } from "./runtime-host/delivery-reconciler-loop.ts";
import { outboxDir, readOutboxItem, outboxItemId } from "./runtime/message-outbox.ts";

let n = 0;
const ok = (name: string): void => {
  n += 1;
  console.log(`ok ${n} - ${name}`);
};

const TABRUN = "tab_test_9999";
const UUID = "01a1c3a6-81dd-72ea-a41c-810bb4e6cb5d";
const RUN = "run_test_owner_1";

/** 覆写 links.jsonl（每例独立）。 */
function writeLinks(records: unknown[]): void {
  writeFileSync(LINKS, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

const linkOf = (over: Record<string, unknown> = {}) => ({
  sessionId: TABRUN,
  kind: "async",
  targetId: RUN,
  detail: "test",
  at: new Date().toISOString(),
  pid: 1,
  ...over,
});

try {
  mkdirSync(STATE, { recursive: true });

  // ── ① tab link 有 ownerSessionId ⇒ 返回 UUID ─────────────────────
  {
    writeLinks([linkOf({ ownerSessionId: UUID })]);
    assert.equal(resolveDispatcherFromLinks(RUN), UUID, "① tab link 有 owner ⇒ 必须返回真 UUID");
    ok("① tab link + ownerSessionId ⇒ UUID（不再返回 tab_xxx）");
  }

  // ── ② 非 tab link ⇒ 行为完全不变 ────────────────────────────────
  {
    const REAL = "01a1a019-b332-73ec-847d-0964dbe9592e";
    writeLinks([linkOf({ sessionId: REAL, ownerSessionId: "01a1dead-beef-0000-0000-000000000000" })]);
    assert.equal(resolveDispatcherFromLinks(RUN), REAL, "② 非 tab ⇒ 必须返回 sessionId（不因 owner 存在而变）");
    ok("② 非 tab link ⇒ 行为零变化（哪怕带了 ownerSessionId）");
  }

  // ── ③ tab link 无 ownerSessionId ⇒ undefined（fail closed）──────
  {
    writeLinks([linkOf()]);
    assert.equal(resolveDispatcherFromLinks(RUN), undefined, "③ tab 且无 owner ⇒ fail closed（不猜 tab 可达）");
    ok("③ tab link 无 ownerSessionId ⇒ undefined（不猜、不发注定到不了的补投）");
  }

  // ── ④ deliver 新事件 ⇒ to 是 pi://<UUID> ─────────────────────────
  {
    writeLinks([linkOf({ ownerSessionId: UUID })]);
    const deliver = makeOutboxDeliver({ stateDir: STATE });
    const ev = { eventId: `async:${RUN}:rev1`, runId: RUN, terminalAt: new Date().toISOString(), dispatcherSessionId: UUID };
    const st = deliver(ev as never, "att-1", 1);
    assert.equal(st, "sent", "④ 新事件应写入 outbox");
    const id = outboxItemId(`delivery-reconciler:${ev.eventId}`);
    const item = readOutboxItem(outboxDir(STATE), id);
    assert.ok(item !== null, "④ outbox item 应存在");
    assert.equal(item!.to, `pi://${UUID}`, "④ to 必须是真 UUID（不是 tab_xxx）");
    assert.equal(item!.sessionId, UUID, "④ sessionId 同理");
    ok("④ 新事件的补投地址 = pi://<真 UUID>");
  }

  // ── ⑤ 存量项 to=pi://tab_xxx 且 pending ⇒ 就地修正 ─────────────
  {
    writeLinks([linkOf({ ownerSessionId: UUID })]);
    const deliver = makeOutboxDeliver({ stateDir: STATE });
    const ev = { eventId: `async:${RUN}:rev2`, runId: RUN, terminalAt: new Date().toISOString(), dispatcherSessionId: UUID };
    const dedupeKey = `delivery-reconciler:${ev.eventId}`;
    const id = outboxItemId(dedupeKey);
    const dir = outboxDir(STATE);
    mkdirSync(dir, { recursive: true });
    // 造一条「历史遗留」的 pending 项：to=pi://tab_xxx
    writeFileSync(
      join(dir, `${id}.json`),
      JSON.stringify({
        version: 1,
        type: "session.message",
        id,
        dedupeKey,
        commandKey: id,
        to: `pi://${TABRUN}`,
        sessionId: TABRUN,
        text: "old",
        status: "pending",
        createdAt: "2026-11-09T00:00:00.000Z",
        updatedAt: "2026-11-09T00:00:00.000Z",
      }),
      "utf8",
    );
    const st = deliver(ev as never, "att-2", 1);
    assert.equal(st, "sent", "⑤ 幂等命中仍返回 sent");
    const after = readOutboxItem(dir, id);
    assert.ok(after !== null);
    assert.equal(after!.to, `pi://${UUID}`, "⑤ 存量 pending 项的 to 应被就地修正");
    assert.equal(after!.sessionId, UUID, "⑤ sessionId 同理");
    assert.equal(after!.id, id, "⑤ id 不变（身份不变）");
    assert.equal(after!.dedupeKey, dedupeKey, "⑤ dedupeKey 不变");
    assert.equal(after!.status, "pending", "⑤ 仍是 pending（下一 tick 可被桥消费）");
    ok("⑤ 存量 to=pi://tab_xxx 的 pending 项被就地修正（id/dedupeKey 不变）");
  }

  // ── ⑥ 存量项已终态 ⇒ 不碰 ──────────────────────────────────────
  {
    writeLinks([linkOf({ ownerSessionId: UUID })]);
    const deliver = makeOutboxDeliver({ stateDir: STATE });
    const ev = { eventId: `async:${RUN}:rev3`, runId: RUN, terminalAt: new Date().toISOString(), dispatcherSessionId: UUID };
    const dedupeKey = `delivery-reconciler:${ev.eventId}`;
    const id = outboxItemId(dedupeKey);
    const dir = outboxDir(STATE);
    mkdirSync(dir, { recursive: true });
    const terminal = {
      version: 1, type: "session.message", id, dedupeKey, commandKey: id,
      to: `pi://${TABRUN}`, sessionId: TABRUN, text: "old",
      status: "delivered",
      createdAt: "2026-11-09T00:00:00.000Z", updatedAt: "2026-11-09T00:00:00.000Z",
    };
    writeFileSync(join(dir, `${id}.json`), JSON.stringify(terminal), "utf8");
    deliver(ev as never, "att-3", 1);
    const after = readOutboxItem(dir, id);
    assert.deepEqual(after, terminal, "⑥ 终态项必须逐字段不变（防回滚成 pending 造成重复注入）");
    ok("⑥ 已终态项不被任何修正触碰");
  }

  // ── ⑦ 不可达 ⇒ 不写 item + 返回 unreachable ────────────────────
  {
    writeLinks([linkOf()]); // tab link 无 owner ⇒ resolver undefined
    const deliver = makeOutboxDeliver({ stateDir: STATE });
    const ev = { eventId: `async:${RUN}:rev4`, runId: RUN, terminalAt: new Date().toISOString(), dispatcherSessionId: TABRUN };
    const dedupeKey = `delivery-reconciler:${ev.eventId}`;
    const id = outboxItemId(dedupeKey);
    const dir = outboxDir(STATE);
    const st = deliver(ev as never, "att-4", 1);
    assert.equal(st, "failed", "⑦ 地址不可达应返回 failed（不写注定永停的 pending；B 有上限故不无限重试）");
    assert.equal(existsSync(join(dir, `${id}.json`)), false, "⑦ 不应写出任何 outbox 项");
    ok("⑦ 目标地址不可达 ⇒ 不写 item、返回 failed（有界重试后 exhausted+incident，不静默）");
  }

  console.log(`_test_reconciler_owner_session: ${n} checks passed`);
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}
