---
title: 期望账本（⑧ 请求—回执期望）
kind: concept
status: current
updated: 2026-09-29
source_paths:
  - extensions/runtime/expectations.ts#L335-L338
  - extensions/runtime/expectations.ts#L344-L390
  - extensions/runtime/mailbox.ts#L110-L117
  - extensions/mailbox-consumer.ts#L225-L230
  - extensions/mailbox-consumer.ts#L149
  - extensions/runtime/autonomy/collect.ts#L332-L353
  - extensions/runtime/autonomy/frontier.ts#L387-L391
  - extensions/runtime-host/attention.ts#L219-L244
  - extensions/runtime/adapters/tab-run.ts#L97-L103
  - extensions/event-bus.ts#L257-L258
  - extensions/index.ts#L2061-L2115
  - extensions/_test_expectations.ts
updated: 2026-09-29
---

# 期望账本（⑧ 请求—回执期望）

## Summary

请求方在**投递成功点**声明「我在等什么回信」，请求方消费链在**回信匹配点**关闭等待，超期由显式 `now` 派生（无定时器）。账本 SoT = `<stateDir>/expectations/{open,closed}/<requestId>.json` 每请求一文件（非 journal）；journal 只落 3 个 additive 事件 `project.expected_event_{set,arrived,timeout}`。纯库、全部 never-throw；**autonomy 红线：只读账本，journal 写者在消费轮次**。来源：0928 P2 v2-b 最小切片（`33c8a9b`）。

## 声明谓词

`shouldDeclareExpectation(frame, expectReply)`（`expectations.ts#L335-L338`）全过才写账本：

```
expectReply !== false
∧ frame.frame === "message"        // command 帧无回信语义，mailbox.ts#L115 只对 message 声明
∧ frame.requiresAck === true       // newMessageFrame 工厂：requiresAck = kind !== "ACK"（protocol.ts#L176）
∧ !frame.inReplyTo                  // 带 inReplyTo = 回信本身，不是请求
∧ frame.from !== frame.to          // 自地址观察型报告（event-bus REPORT）不是请求
```

首写者条件（`created===true`）由 `deliverLetter` 天然保证：已存在 / dedupe 输家在 `mailbox.ts#L104-107` 提前 return，到不了声明点。`opts.expectReply`：`undefined`=按谓词自动、`false`=显式关、对象=覆盖 `deadlineAt/expectedType/project`（`mailbox.ts#L61-L66`）。默认 deadline `DEFAULT_EXPECT_DEADLINE_MS = 30min`（`expectations.ts#L52`）。

## 两个生产者与消费面

| 角色 | 落点 | 时机 |
|---|---|---|
| **声明** | `mailbox.ts#L110-L117` → `declareExpectationSafe`（`expectations.ts#L344`，全仓唯一生产调用点） | 落盘成功后、返回 `created:true` 前；never-throw |
| **到达** | `mailbox-consumer.ts#L225-L230` → `matchAndCloseExpectationSafe` | claim + F16 fencing 复检通过后、`preInject` 之前；四键匹配（`inReplyTo/from/kind/to`），不读 body |
| **超期事件** | `mailbox-consumer.ts#L149` `materializeTimeoutNotices` | 每消费轮次；claim-then-append，每 `(id,rev)` 至多一行；超期**不关闭**期望 |

读取面三条：`collect.ts#L332-L353 readExpectationInputs`（**账本目录不存在 → `undefined`**）→ frontier 触发 + watchdog `overdueRequests`；`attention.ts#L219 pushExpectations` → `request-timeout` 条目（纯读，独立于 autonomy 开关）；账本自读。frontier 的 ⑧ record-only 条件化：`expectations === undefined` 才保留 `expected_event_timeout:record-only(no-carrier)` 行（`frontier.ts#L387-L391`；常量本身 `RECORD_ONLY_NOCARRIER` 不改）。

## 生产侧现状

### 0929 更新：生产入口已接通（`/send-letter`）

**0929 切片 A（`d421525` + `a15bced`）新增生产创建点**：`extensions/index.ts` 的 `/send-letter` slash（`#L2068` 起），薄包装 `deliverLetter` + `newMessageFrame({kind:"DELEGATION", …, requiresAck:true})`，解析 `<to> [--subject S] [--body B] [--deadline 30m] [--no-expect]` 三态。自此**账本有常驻生产侧入账方**。

| 门 | 位置 | 语义 |
|---|---|---|
| `isSubagent()` | `index.ts#L2071`（handler 第一句）| 子 agent 会话拒发 + 审计 `send-letter rejected:subagent`（S2）|
| 地址校验 | `index.ts#L2086` | `isObjectAddress` 不过 ⇒ 拒绝 + 审计 `rejected:bad-address` |
| 非 `agent://` 域提示 | `index.ts#L2093` | S1：无回信消费者 ⇒ 提示「期望将走超期路径」（不阻断）|
| 自环提示 | `index.ts` 回执构造段 | S3：`to===masterAddress()` ⇒ 谓词挡下、提示「非在等回信」|
| 留痕 | 同段 | `appendAuditEvent("gating", "pass", "send-letter by=user:… to=… id=… expect=on|off")`——**`cat`/`concl` 均落 W5 冻结词表**，细节入 `reason` |

**行为门重开（切片 B，`f09ab1e`）**：A10.1 allowlist 确认（`index.ts` 基线已在 ALLOW，无需改）、`_test_graph_frontier_shadow` 双态断言、`_test_runtime_autonomy` ⑧ 语义断言、`_test_expectations` 去运行期字符串拼接 import。
 **L4 复核**：`plans/0929_m1_send_letter_l4_review.md` —— **可直接采信（0 阻断）**；建议修 3 项已随 `a15bced` 闭合。

### 0929 之前（历史基线，保留作对照）

- 全仓非测试 `deliverLetter*` 调用点仅：`event-bus.ts#L257-L258`（`tabResultToReportLetter`，`from===to` 自环 REPORT，`tab-run.ts#L101` → **被 `from!==to` 排除**）、wake/scope 回信 recipe 文案（`inReplyTo` → 排除）、验收 harness `scripts/local-master-loop-acceptance.mjs#L316-L324`（`ESCALATION`，**会入账**但仅脚本运行时）。
- 因此**稳态运行没有任何帧会入账**：账本根不被创建 → frontier ⑧ 恒 no-carrier、watchdog 检查 3 恒 unknown。`expectationsDirExists`（`expectations.ts#L135`）当前仅测试使用。
- 逻辑上本该入账的请求方 = **master ↔ local master 跨仓委托**（DELEGATION/ESCALATION/QUESTION/CONTROL，对端按 [[Wake 回信（round-trip 回执）]] recipe 回 `RESULT`）——历史上真实发生过，但创建方式是临时手写脚本，仓内无生产创建点。**⇒ 现由 `/send-letter` 补上。**
- 微信线（`extensions/channel-wechat/*`）与 message-outbox 不经 mailbox，结构上不在本账本范围。

## Evidence

- `extensions/_test_expectations.ts`（23 断言组：声明/四键匹配/重复/迟到/取消/deadline 更新/重启回放）。
- 盘面实测 2026-09-29：`~/.pi/agent/runtime/state/` 无 `expectations/`；`events.jsonl` 中 `expected_event*` 0 行；邮箱 50 封中 10 封满足声明条件但 `sentAt` 均早于 `33c8a9b`（09-28）。
- 红队复核：`plans/0929_p2_slice_l4_review.md` §D9–D12（判定链、生产请求方缺口、行为门未重开）；裁定依据 `plans/0928_p2_expected_reply_slice_plan.md` §2.4/§5/§10。

## Links Out

- [[Wake 回信（round-trip 回执）]]
- [[主动性套件（Autonomy Suite）]]
- [[Wiki 索引]]

## Backlinks

- [[Wiki 索引]]

## Open Questions

- **生产请求方缺口**（L4 阻断项 B1）：需补一个真实调用点，或明确标注「仅 acceptance harness / 手写脚本可达」；在补齐前「frontier ⑧ 获真载体」应读作**能力已就绪、生产数据面未接通**。
- **v2-b 三型事件的语义审批文书**与**行为门重开**（A10.1 allowlist tripwire / `_test_graph_frontier_shadow` / `_test_runtime_autonomy` 补 ⑧ 断言）尚未执行（L4 阻断项 B2）。
- gate `ack` 只等于「放行过一次 wake」，**不等于该请求被处置**；scope 域无到达生产者；pre-cutover 回信不关期望（既定接受项）。
