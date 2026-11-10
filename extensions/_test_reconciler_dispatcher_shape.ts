/**
 * _test_reconciler_dispatcher_shape.ts — P0：dispatcher 形状校验（UUID 才算可达地址）
 *
 * 【事故（2026-11-10）】
 * `links.jsonl` 的 `sessionId` 有三种形态（本机实测 1201 条 kind=async）：
 *   uuid 532 条 | tab_ 567 条（其中 96 条带 ownerSessionId、471 条无）| other 102 条
 *   （other 样例：`test-parallel-async` —— 测试遗留的假 id）
 *
 * 旧解析器无形状校验，遇到 `tab_` 或 `test-parallel-async` 都直接 return ⇒ 补投写
 * `to = pi://<脏值>` ⇒ outbox-bridge 的 `it.to === myAddress`（它只认 `pi://<真 UUID>`
 * 或 `pi://<tabRunId>` 中的**后者在 bridge 侧不存在**）⇒ **永不匹配、永停 pending**。
 *
 * 【本测试覆盖（P0 验收标准 ①②③ + 额外的「不误伤」组）】
 *   ① targetId 只有脏记录（tab_ 无 owner）⇒ undefined
 *   ② 同一 targetId「脏在前、正确在后」⇒ 返回正确 UUID（continue 而非 return）
 *   ③ 非 UUID 的 other 形态（`test-parallel-async`）⇒ undefined
 *   ④ **不误伤**：tab_ 且有 ownerSessionId ⇒ 返回 owner 的 UUID（这是已修好的 96 条，
 *      不能因为加形状校验而退回 undefined）
 *   ⑤ 纯 UUID ⇒ 原样返回（非 tab 场景逐字节不变）
 *   ⑥ `makeOutboxDeliver` 收到非 UUID dispatcher ⇒ 返回 failed 且不新增 pending 项
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "recon-shape-"));
const LINKS = join(ROOT, "links.jsonl");
const STATE = join(ROOT, "state");
process.env.PI_LINKS_PATH = LINKS;
process.env.PI_RUNTIME_DIR = ROOT;

import { resolveDispatcherFromLinks, makeOutboxDeliver } from "./runtime-host/delivery-reconciler-loop.ts";
import { outboxDir, outboxItemId, readOutboxItem } from "./runtime/message-outbox.ts";

let n = 0;
const ok = (name: string): void => {
  n += 1;
  console.log(`ok ${n} - ${name}`);
};

const RUN = "run_shape_1";
const TAB = "tab_shape_9999";
const UUID = "01a1bfaa-246f-7229-86fb-389655b06863";
const UUID2 = "01a1a019-b332-73ec-847d-0964dbe9592e";

const link = (over: Record<string, unknown> = {}) => ({
  sessionId: TAB, kind: "async", targetId: RUN, detail: "t",
  at: new Date().toISOString(), pid: 1, ...over,
});

function writeLinks(recs: unknown[]): void {
  writeFileSync(LINKS, recs.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

try {
  mkdirSync(STATE, { recursive: true });

  // ── ① 只有脏记录（tab_ 无 owner）⇒ undefined ───────────────────
  {
    writeLinks([link()]);
    assert.equal(resolveDispatcherFromLinks(RUN), undefined, "① tab_ 无 owner ⇒ undefined（不猜、不可达）");
    ok("① targetId 只有 tab_ 脏记录 ⇒ undefined");
  }

  // ── ② 脏在前、正确在后 ⇒ 返回正确 UUID（必须 continue）─────────
  {
    writeLinks([
      // ⚠ `listLinks` 按 `at` **倒序**（`links.ts:129`）⇒ 「排在前面」= at **更新**。
      // 所以脏记录要给**更新**的 at，正确记录给更旧的 at，才能造出「脏在前、正确在后」。
      { ...link(), sessionId: TAB, at: "2026-01-03T00:00:00.000Z" },                     // tab_ 无 owner（脏）→ 排最前
      { ...link(), sessionId: UUID, at: "2026-01-01T00:00:00.000Z" },                    // 正确 → 排后面
    ]);
    assert.equal(resolveDispatcherFromLinks(RUN), UUID, "② 必须跳过脏记录、返回后面的正确 UUID");
    ok("② 「脏在前、正确在后」⇒ 返回正确 UUID（continue 而非 return）");
  }

  // ── ③ other 形态（test-parallel-async）⇒ undefined ─────────────
  {
    writeLinks([{ ...link(), sessionId: "test-parallel-async" }]);
    assert.equal(resolveDispatcherFromLinks(RUN), undefined, "③ 非 UUID 非 tab_ 的假 id ⇒ undefined");
    ok("③ other 形态（test-parallel-async）⇒ undefined");
  }

  // ── ④ 不误伤：tab_ 且有 owner ⇒ 返回 owner 的 UUID ────────────
  {
    writeLinks([{ ...link(), sessionId: TAB, ownerSessionId: UUID2 }]);
    assert.equal(resolveDispatcherFromLinks(RUN), UUID2, "④ tab_ + owner ⇒ 必须返回 owner 的 UUID");
    ok("④ 不误伤：tab_ + ownerSessionId ⇒ UUID（96 条已修好的不能被回退）");
  }

  // ── ⑤ 纯 UUID ⇒ 原样返回 ─────────────────────────────────────
  {
    writeLinks([{ ...link(), sessionId: UUID, ownerSessionId: UUID2 }]);
    assert.equal(resolveDispatcherFromLinks(RUN), UUID, "⑤ 非 tab 的 UUID ⇒ 原样返回（不被 owner 抢走）");
    ok("⑤ 非 tab 场景逐字节不变（UUID 原样返回）");
  }

  // ── ⑥ makeOutboxDeliver 收到非 UUID dispatcher ⇒ failed 且不写 item ─
  {
    writeLinks([link()]); // tab_ 无 owner ⇒ resolver undefined；这里直接造非 UUID event
    const deliver = makeOutboxDeliver({ stateDir: STATE });
    const ev = {
      eventId: `async:${RUN}:rev9`, runId: RUN,
      terminalAt: new Date().toISOString(),
      dispatcherSessionId: "test-parallel-async",
    };
    const st = deliver(ev as never, "a1", 1);
    assert.equal(st, "failed", "⑥ 非 UUID dispatcher ⇒ failed（不静默写 pending）");
    const id = outboxItemId(`delivery-reconciler:${ev.eventId}`);
    assert.equal(existsSync(join(outboxDir(STATE), `${id}.json`)), false, "⑥ 不得新增 pending 项");
    assert.equal(readOutboxItem(outboxDir(STATE), id), null, "⑥ 目录里不应有该项");
    ok("⑥ 非 UUID dispatcher ⇒ failed + 零 outbox 项");
  }

  console.log(`_test_reconciler_dispatcher_shape: ${n} checks passed`);
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}
