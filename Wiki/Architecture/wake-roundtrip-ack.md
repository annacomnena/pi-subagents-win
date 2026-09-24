---
title: Wake 回信（round-trip 回执）
kind: concept
status: current
updated: 2026-09-24
source_paths:
  - extensions/runtime/wake.ts#L49-L64
  - extensions/runtime/wake.ts#L221
  - extensions/runtime/wake.ts#L228-L250
  - extensions/runtime/wake.ts#L255-L285
  - extensions/runtime/wake.ts#L326-L343
  - extensions/runtime/scope.ts#L248-L263
  - extensions/runtime/scope.ts#L400-L428
  - extensions/runtime/protocol.ts#L157-L179
  - extensions/runtime/mailbox.ts#L63
  - extensions/_test_local_master.ts#L959
  - extensions/_test_runtime_wake.ts#L194
---

# Wake 回信（round-trip 回执）

## Summary

wake-spawn 出的 tab（workstream Sub-Master / per-repo local Sub-Master）**没有发信工具**；处理完 `requiresAck=true` 的 message 来信后，必须用 mailbox 模块的 `deliverLetter` 给**来信者**回一封 `kind=RESULT` 回执。回执契约以可执行 recipe 的形式内嵌在 spawn 的 launch prompt 里（`buildWakePrompt` / `buildScopeWakePrompt`），不依赖协议层代投。

## Current Contract

### 为什么必须走 deliverLetter（tab-report 不可达）

tab-report 是**派发者归属通道**：wake 场景的派发者就是唤醒方自己（workstream 的 master / scope 的 local master），tab-report 只回派发者——**来信者收不到**。因此跨 master 的回执必须走信箱通道 `deliverLetter`（`mailbox.ts#L63`）。协议层自动代投（`replyTo` / `inReplyTo` 字段触发协议层投递）**未采用**；回信责任在 spawn 出的 tab 自身，由 prompt 纪律约束。

### WakeLetter 扩展字段（回信寻址来源）

`WakeLetter`（`wake.ts#L49-L64`）在基本字段外带三个可选字段：

- `from`：原信发信方（message 帧 `frame.from` / command 帧 `issuedBy`）= **回信目标**
- `to`：原信收件方（本收件地址）= **回信的 from**
- `requiresAck`：仅 message 帧有（`kind !== "ACK"`）；`true` → prompt 要求回 RESULT

`describeLetter`（`wake.ts#L326` 与 `scope.ts#L248`，两处规则一致）：message 帧逐字段取自原帧；command 帧只有 `from=issuedBy`、`to`，**没有 `requiresAck` → 永不回信**。

`requiresAck` 由 `newMessageFrame` 工厂固化（`protocol.ts#L176`）：`requiresAck: input.kind !== "ACK"`——非 ACK 类缺省即为 true。

### 回执触发条件（prompt 形状）

`buildWakePrompt`（`wake.ts#L255`）/ `buildScopeWakePrompt`（`scope.ts#L400`）逻辑一致：取前 10 封展示信，其中**存在 `requiresAck===true` 且 `from`/`to` 均非空**的 message 帧时，prompt 才出现「回执（round-trip…）」块：

- 每封一行：`回执：<messageId> → 用 deliverLetter 回 kind=RESULT 到 <原信 from>（from=<原信 to>, inReplyTo=<messageId>）`
- 紧跟完整 recipe（`buildReplyRecipe`，见下）
- 末尾硬规则行（两 prompt 文案同构）：「处理完必须逐封用 deliverLetter 回 kind=RESULT 给来信者；禁止只依赖 tab-report（它是派发者归属通道，…来信者收不到）；command 帧不要求回信。」

无回信件时该块与硬规则行**整段缺席**（prompt 逐字节保持旧形状）。

### buildReplyRecipe（内嵌的可执行 recipe）

`buildReplyRecipe`（`wake.ts#L228-L250`；scope 侧复用同一函数，`scope.ts#L45` 从 wake.ts import）：

1. tab 无发信工具 → 用 bash + 临时 `.mjs`，`import { deliverLetter, mailboxDirFor } from "<mailbox.ts 的 file:// 绝对 URL>"`（URL 由 `MAILBOX_MODULE_URL` 提供，`wake.ts#L221`；脚本体刻意不用模板字符串，避免与外层 TS 模板字面量转义冲突）
2. 回信帧字段：`kind: "RESULT"`、`from: <原信 to>`、`to: <原信 from>`、`inReplyTo: <原信 messageId>`、`requiresAck: true`、`body.summary` **≤512 字节**
3. `node <脚本>` 运行（本机 node v22 类型剥离默认可用，能直接 import 该 `.ts`；报错时 `node --experimental-strip-types`；**不用 npx**，依赖网络）
4. `ls <recipientDir>`（= `mailboxDirFor(REPLY.to)`，目录名规则：非 `[A-Za-z0-9._-]` 一律替换为 `_`，`mailbox.ts#L42`）断言出现新 `msg_*.json`
5. 删除临时脚本

### 约束

- **command 帧不回信**：`describeLetter` 对 command 帧不设 `requiresAck`，回信条件 `requiresAck===true` 恒不满足。
- **`requiresAck=false`（ACK 帧）不回信**。
- **逐封回**：prompt 要求对每封需回执的来信各回一封（每封一个独立 `inReplyTo`），不是一封回执合并多信。
- 回执是普通 message 帧信件，投递语义走 `deliverLetter` 既有契约（帧校验、原子写、`dedupeId` at-least-once，`mailbox.ts#L63-L97`）；来信者侧如何消费 RESULT 信不在本契约范围。

## Evidence

- `extensions/_test_local_master.ts#L959`（RT 段）：`buildScopeWakePrompt` 直测——message 帧 + `requiresAck=true` → prompt 含 `deliverLetter` / `RESULT 到 <原信 from>` / `inReplyTo` / 确认步骤 / `mailboxDirFor`；command 帧与 `requiresAck=false` → 不含 `deliverLetter`；`evaluateScopeWake` 端到端（ESCALATION + `requiresAck=true` → fire，`letters[0].from`/`.to` 与原信一致）。
- `extensions/_test_runtime_wake.ts#L194`（8. prompt 形状）：`buildWakePrompt` 同套断言（workstream 侧）。
- 协议层事实：`extensions/runtime/protocol.ts#L176`（`requiresAck = kind !== "ACK"`）。

## Links Out

- [[Wiki 索引]]

## Backlinks

- [[Wiki 索引]]

## Open Questions

- 回执是 **LLM 软约束**（prompt 纪律），协议层无补偿/重投机制；漏回率未测量。是否需要协议层 `replyTo` 代投或消费侧超时催回，待裁定。
- 回执 `summary ≤512 字节` 为 prompt 约定，`deliverLetter` 层不校验该长度。
