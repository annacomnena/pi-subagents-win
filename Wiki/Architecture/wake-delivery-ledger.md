---
title: 唤醒必达（交付真账本 + ACK 驱动）
kind: architecture
status: current
updated: 2026-10-21
source_paths:
  - extensions/delivery-ledger.ts
  - extensions/delivery-ack.ts
  - extensions/delivery-reconciler.ts
  - extensions/runtime-host/server.ts
  - extensions/async-result-watcher.ts
  - extensions/mailbox-consumer.ts
  - extensions/outbox-bridge.ts
  - extensions/injection-gate.ts
  - extensions/index.ts
  - extensions/_test_delivery_crash_window.ts
  - extensions/_test_delivery_host_contract.ts
  - extensions/_test_c3_mailbox_ack.ts
  - extensions/_test_c3_outbox_ack.ts
  - extensions/_test_p3_provenance.ts
---

# 唤醒必达（交付真账本 + ACK 驱动）

**一句话**：run 终态写盘 ≠ 归属会话真的处理了该事件。本页记录「终态事件必达」的机制、
不变量与已核实的边界（来源：`plans/20261016_consult_scheduling_and_wake_reliability.md` 设计 +
C 序列实现 + 两轮独立复核）。

## 不变量（可验收口径）

- **执行面与交付面分开记账**：`failed_delivery` **不改** run 终态；run 的
  `completed/failed/cancelled` 由执行层唯一写（见 [[异步子 agent 与 run 控制]]）。
- **交付面**：每条已持久化终态事件在期限内成为 `consumed`，或 `failed_delivery + durable incident`；
  **不得**永停在 pending/claimed/sent。
- **证据面**：`consumed` 由**接收端可观测事实**（`pi.on("context")` 在消息里检出 eventId）驱动，
  **不是**发送方返回值（`delivery-ack.ts` 头注；P3 自证见下）。

## 数据模型（`delivery-ledger.ts`）

- `eventId = async:<runId>:<terminalRevision>`（`:85-88`）；`terminalRevisionOf` 只取**稳定结果字段**
  （status/endedAt/zombieReapedAt/result.*/failure.*/killReason，`:68-83`）——**不得含 now/attempt/lease 等时变字段**
  （否则每 tick 换 id ⇒ 重复事件 + ACK 永不对不上）。
- 阶段机：`pending → leased → attempted → received → consumed`，任一未 consumed 到期限 ⇒ `failed_delivery`
  （`:300-330` `effectiveStage`，`:345-378` `reconcileDecision`）。
- 租约 `LEASE_MS = 15s`（`:44`）；交付期限 `DELIVERY_DEADLINE_MS = 60s`，**锚定 `terminalAt`（终态时刻）而非发现时刻**
  （`:45-46`、`:185-195`）——防晚发现获得隐式展期。
- incident：跨重启保留、**仅显式 ack 才清**（`:382+` `publishIncident`），通知出口不调用模型。

## 两条通道（独立性边界）

- **A 快通道**：`async-result-watcher.ts`（fs.watch + 10s tick）→ 注入并记 attempt（`channel:"A"`）。
- **B 对账通道**：`delivery-reconciler.ts` —— 模块头明示**不 import watcher**（不共享 selfDisabled/seen/.notified），
  只读权威终态 JSON + 账本；`scanTerminalRuns` 公平分页 round-robin（`:100-133`）。
- **⚠ 生产接线状态（2026-10-16 切片 1）**：B 已接线 **runtime-host**（`runtime-host/delivery-reconciler-loop.ts`，由 `server.ts` 随 host 起停；kill switch `PI_DELIVERY_RECONCILER=0`；cursor 持久化 `state/delivery-reconciler.json`）。
  **仍不得宣称「双通道运行时」**：**host 为 opt-in（默认 OFF）** ⇒ host 不在时 B 缺席；`degraded(reconciler-host-down)` 可见面属**切片 2（未做）**。
- **共同故障域（不得宣称全链路双活）**：A/B 最终都走同一个 Pi 注入器（`loader.js:295-297` +
  `agent-session.js:2644-2652`）；且 `consumed` ACK 的唯一生产写点在 watcher 的 `pi.on("context")` 钩子
  ⇒ 接收会话未部署本扩展时两条通道同时失去 consumed 证据。

## P3：为什么「返回值」不能作送达证据（自证，承重）

- 本机已安装 pi **两级 delegate 都不 return**：`loader.js:295-297`（extension 工厂拿到的 `pi`）与
  `agent-session.js:2644-2652`（bindCore wrapper，只 `.catch(emitError)`）⇒ **生产恒 `undefined`**。
- 底层**确实会 reject**（busy `:1485` 仅当未传 `streamingBehavior`；compaction `:1467`）；
  **反面证据**：传 `deliverAs:"followUp"` 走 `_queueFollowUp` 正常返回（`:1487-1488`）⇒ 不得把「非 Promise 返回值」一律判死。
- 唯一返回**真 Promise** 的路径 = `createReplacedSessionContext()`（`:3476-3482`）。
- ⇒ `classifySendReturn`：**只认 thenable**；`undefined`/数字/字符串/普通对象一律 `unconfirmed`（`injection-gate.ts`）。
- **证据定源纪律**：承重 = 自证探针（`scripts/_probe_p3_senduser_message.mjs` + `npm run test:p3-provenance`，
  直读本机安装包，`self-verified=8 / peer-weak=0`）；第三方（已删除的 krill/grok）报告为**旁证弱档、未采信**。

## C-3：四个注入调用点已切换（strict 缺省）

| 调用点 | file | unconfirmed 行为 | 终态触发器 |
|---|---|---|---|
| watcher（A） | `async-result-watcher.ts` | 不释放 claim、记 trace | consumed ACK |
| mailbox **信** | `mailbox-consumer.ts` | **释放两处 claim 退回 pending**（避免永久停滞）+ 记 trace | consumed ACK ⇒ `ackLetter` |
| outbox | `outbox-bridge.ts` | 不释放 claim（10min stale 重投） | **consumed ACK 闭环**；`sent`/收据只记 `message.received`（strict） |
| 通知类（index trace-fusion / 命令回执） | `index.ts`、`mailbox-consumer.ts` | 经 `notifyFollowUpQuietly` 写 `C3-notify-<status>` trace | 无终态（纯通知） |

- 回滚档位：`PI_DELIVERY_STRICT=0` 恢复旧契约（`sent`/收据 ⇒ delivered）。
- **mailbox 必须释放**（源码依据）：消费循环只枚举 `listLetters(recipient,"pending")`（严格 `status==="pending"`）
  ⇒ 留在 `claimed` 的信**永不重新入循环**，`mailbox.ts` 的 stale reclaim 在该消费路径不可达 ⇒ 不释放 = 永久停滞。

## 已知缺口（记录，未修）

1. ~~`effectiveStage` 在 incident 已发布时不返回 `failed_delivery`（有 attempt 时恒报 attempted/received）~~
   ⇒ **已不成立（2026-10-21 复核）**：`949be704`（2026-10-16 11:30，已推送）引入
   `effectiveStageOf(ledger, incident, now)`，其中 **incident 分支优先于一切成功态**
   （`delivery-ledger.ts:337-339` `if (incident.incidentId) return { stage: "failed_delivery" }`）。
   回归：`test:delivery-ledger` D8 + **D13「24 组合 incident 开启恒 failed_delivery（无成功态泄漏）」**。
   本页原据旧记录写成缺口，实测已闭合 —— 保留此条仅为防止有人按旧结论“再修一次”。
2. mailbox unconfirmed 重投**无次数上界**（每 tick 一个新 attempt 文件）——与 watcher/outbox 范式不一致；
   待裁（退避 or 改枚举）。
3. B 未接线生产（见上）。
4. `reliability-acceptance.mjs`（R1–R4/R9–R14）未建。
5. **incident 曾经没有任何可见面/Ack 入口（2026-10-21 已修）**：实测 `ackIncident` / `listOpenIncidents`
   **全仓零调用** ⇒ 106 条 incident 积压（ack 数 0，最旧 4.8 天，91/106 > 1 天）。
   设计说「incident 是 durable 可见出口，显式 ack 才清」，但**既无可见面也无 ack 入口** = AGENTS R-2 静默失效。
   现交付：`/v1/health` 新增 `delivery` 段（`openIncidents`/`oldestAgeMs`/`byReason`/`stale`/`sampledAt`，
   按 R-2.2 给**年龄**）+ 只读 `/v1/incidents` + `POST /v1/incidents/:id/ack`（走后 `authorizeCommand` 鉴权）。
   **故意不自动 ack**（红线：不能因为通知发出去就当作已处理）。回归 `test:incident-visibility`（6 组）。
   仍未闭合：GUI 卡片未做；incident **无 GC**（ack 后文件仍在盘上，只加 `ackedAt`）；
   仍有 106 条待人工 ack。

## Evidence

- `extensions/delivery-ledger.ts` — eventId/阶段机/租约/期限/incident/attempt/ack（`:68-88`、`:165-200`、`:300-378`）。
- `extensions/delivery-ack.ts` — `eventMarker`/`extractEventIdsFromMessages`/`ackConsumed`/`ackReceived`。
- `extensions/delivery-reconciler.ts` — 独立进程对账、公平分页（`:100-133`）。
- `extensions/async-result-watcher.ts` — A 通道注入与 attempt 入账、`pi.on("context")` 写 consumed。
- `extensions/outbox-bridge.ts` — ACK 驱动闭环 + strict/回滚两态（delivered 三个写点）。
- `extensions/injection-gate.ts` — `classifySendReturn`/`injectFollowUpQuietly(strict)`/`notifyFollowUpQuietly`。
- 测试：`_test_delivery_ledger.ts`(12) / `_test_delivery_reconciler.ts`(8) / `_test_delivery_ack.ts`(5) /
  `_test_delivery_crash_window.ts`(R7,5) / `_test_delivery_host_contract.ts`(R8,5) /
  `_test_c3_mailbox_ack.ts`(4) / `_test_c3_outbox_ack.ts`(5) / `_test_p3_provenance.ts`(8 条自证)。
- 审查：`plans/20261016_c3_l4_review.md`（首轮 FAIL→修；增量 PASS-WITH-NITS）、
  `plans/20261016_delivery_arch_glm_review.md`（GLM-5.3 架构复核 PASS-WITH-NITS）。
