/**
 * 不变量回归网（gen14 裁定二·第 3 条，2026-11-05）：
 * **同一交付事件不得同时存在 `fail_delivery` 与 `consumed` 两个矛盾终态。**
 *
 * 事故（实测分母 442 个交付事件）：
 *   - 328 个发过 incident（74%）—— 期限 60s 与真实 ACK 时延（单例 6'36" = 6.6 倍）量级错配
 *   - 其中 **14 个在 incident 之后仍收到 consumed ACK** ⇒ 矛盾终态
 *
 * 两条修法各自单测（这是裁定要求的「分别可验」）：
 *   ① `effectiveStageOf`：incident 之后又来了 consumed ACK ⇒ 翻案为 consumed
 *   ② `publishIncident`：写之前复查 ACK，已 consumed ⇒ 返回 suppressed 占位，不写盘不通知
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "inv-"));
const {
  ensureEvent, writeAck, publishIncident, effectiveStageOf, listAcks,
} = await import("./delivery-ledger.ts");

let pass = 0;
const ok = (n: string) => { pass++; console.log(`  ✅ ${n}`); };

const mkEvent = (runId: string, deadlineOffsetMs: number) => {
  const { event } = ensureEvent(dir, {
    runId,
    terminalRevision: `rev-${runId}`,
    terminalSnapshotPath: join(dir, `${runId}.snap`),
    dispatcherSessionId: "sid-test",
    observedAt: new Date(Date.now() - 600_000).toISOString(),
    terminalAt: new Date(Date.now() - 600_000).toISOString(),
    deliveryDeadlineMs: deadlineOffsetMs,
  });
  return event;
};
const ackConsumed = (eventId: string, atOffsetMs: number) =>
  writeAck(dir, { eventId, stage: "consumed", evidence: "e2e", at: new Date(Date.now() + atOffsetMs).toISOString() } as never);

// ── ① effectiveStageOf：ACK 晚于 incident ⇒ 翻案为 consumed（不是 failed_delivery）──
{
  const ev = mkEvent("run_inv_1", 60_000);
  const incAt = new Date(Date.now() - 60_000).toISOString();
  const ackAt = new Date(Date.now() - 10_000).toISOString(); // ACK 晚于 incident
  const view = effectiveStageOf(
    { event: ev, attempts: [], acks: [{ stage: "consumed", evidence: "e2e", at: ackAt }] } as never,
    { incidentId: "inc_x", incidentAt: incAt },
    Date.now(),
  );
  assert.equal(view.stage, "consumed", `① ACK 晚于 incident ⇒ 必须翻案为 consumed（实际 ${view.stage}）`);
  assert.ok(String(view.evidence).includes("consumed-after-incident"), `① evidence 须标明翻案（实际 ${view.evidence}）`);
  ok("① incident 之后到来的 ACK ⇒ 终态翻案为 consumed（消除矛盾终态）");
}

// ── ② 反例：ACK 早于 incident（数据矛盾）⇒ 保守仍判 failed_delivery ──
{
  const ev = mkEvent("run_inv_2", 60_000);
  const incAt = new Date(Date.now() - 10_000).toISOString();
  const ackAt = new Date(Date.now() - 60_000).toISOString(); // ACK 早于 incident
  const view = effectiveStageOf(
    { event: ev, attempts: [], acks: [{ stage: "consumed", evidence: "e2e", at: ackAt }] } as never,
    { incidentId: "inc_y", incidentAt: incAt },
    Date.now(),
  );
  assert.equal(view.stage, "failed_delivery", "② ACK 早于 incident 不得当成本次复活证据（保守判死）");
  ok("② 反例：ACK 早于 incident 仍判 failed_delivery（不滥用翻案）");
}

// ── ③ 无 incident 时 ACK 语义零变化（回退保护）──
{
  const ev = mkEvent("run_inv_3", 60_000);
  const view = effectiveStageOf(
    { event: ev, attempts: [], acks: [{ stage: "consumed", evidence: "e2e", at: new Date().toISOString() }] } as never,
    {},
    Date.now(),
  );
  assert.equal(view.stage, "consumed", "③ 无 incident ⇒ 旧语义不变");
  ok("③ 无 incident 时零变化");
}

// ── ④ publishIncident：已 consumed ⇒ suppressed，**不写盘** ──
{
  const ev = mkEvent("run_inv_4", 60_000);
  ackConsumed(ev.eventId, -1_000); // ACK 已存在
  const before = readdirSync(dir).filter((f) => f.includes(".incident.")).length;
  const inc = publishIncident(dir, ev, "deadline-exceeded(deadline=x,stage=attempted)", Date.now());
  const after = readdirSync(dir).filter((f) => f.includes(".incident.")).length;
  assert.equal(inc.suppressed, true, "④ 已有 consumed ACK ⇒ 必须返回 suppressed");
  assert.ok(String(inc.reason).includes("suppressed"), `④ reason 须标明被抑制（实际 ${inc.reason}）`);
  assert.equal(after, before, "④ 被抑制时**不得**写 incident 文件（否则又造出矛盾终态）");
  ok("④ publishIncident 写前复查 ACK ⇒ 抑制且零写盘");
}

// ── ⑤ 反例：无 ACK ⇒ 正常发 incident（不得把正常死件也抑制掉）──
{
  const ev = mkEvent("run_inv_5", 60_000);
  const inc = publishIncident(dir, ev, "deadline-exceeded(deadline=x,stage=attempted)", Date.now());
  assert.notEqual(inc.suppressed, true, "⑤ 无 ACK ⇒ 必须正常发 incident（不得全抑制）");
  assert.ok(inc.incidentId.startsWith("inc_"), "⑤ 正常 incident 的 id 前缀不变");
  ok("⑤ 反例：无 ACK 时 incident 正常发出");
}

// ── ⑥ listAcks 能被 publishIncident 真实读到（接线检查）──
{
  const ev = mkEvent("run_inv_6", 60_000);
  ackConsumed(ev.eventId, -500);
  assert.ok(listAcks(dir, ev.eventId).some((a: { stage: string }) => a.stage === "consumed"), "⑥ 夹具自检：ACK 确实落盘且可读");
  ok("⑥ 接线自检：publishIncident 读的是同一份 ACK 账本");
}

rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
console.log(`\n_test_delivery_incident_ack_invariant: ${pass} checks passed`);
