---
title: GUI 消息管道与延迟贡献项
kind: concept
status: current
updated: 2026-09-30
source_paths:
  - gui/src/useEventStream.ts
  - gui/src/store.ts
  - gui/src/api/client.ts
  - gui/src/App.tsx
  - gui/src/usePoll.ts
  - gui/src/pages/ChatPage.tsx
  - extensions/runtime-host/commands.ts
  - extensions/runtime-host/server.ts
  - extensions/runtime-host/ws.ts
  - extensions/outbox-bridge.ts
---

# GUI 消息管道与延迟贡献项

## Summary

"消息显示不及时"的**逐项归因**（2026-09-23，含实测证据）。核心结论：**最大的那一项不在本仓**——assistant 正文只在 `message_end` 落盘（pi core），流式期间会话文件没有新行，因此本仓投影无 delta 可推，延迟等于整条消息的生成时长。

## Current Contract（延迟贡献项）

| 贡献项 | 量级 | 归属 | 现状 |
|---|---|---|---|
| assistant 仅 `message_end` 落盘 ⇒ 投影延迟 = 单条生成时长（秒~分钟级） | **主导项** | **pi core**（`dist/core/agent-session.js`） | 已知限制；本仓无 `row.delta` 生产者（`extensions/runtime/transcript.ts` 只应用既有 op）。修复需 pi 侧提供流式事件或 delta op |
| 用户消息入会话原走 outbox-bridge 10s tick | 均值 +5s / 最大 +10s → **已修至 ~9ms（同进程）/ ≤200ms（跨进程）** | 本仓 | **已修**：`notifyOutboxArrived` 同进程钩子 + `fs.watch` debounce 200ms 双唤醒，10s tick 降级为兜底（claim 幂等保证不重复）；mailbox-consumer 的 10s tick 属 master 域 mailbox 消费，与本路径独立、**未动** |
| WS 断线盲区：退避 1→10s 期间 transcript 零刷新 | 0~10s+ → **已修至 ≤3s** | 本仓 | 已修：`useEventStream` 的 `onOpen`（每次连接建立含重连先触发）即时用 `after=<head.seq>` 增量补差 + 断线 3s 兜底轮询 |
| 非 chat 页从未订阅 WS：仅靠轮询（2s/6s 档） | 2s/6s → **已修至 ≤300ms**（WS 连接期） | 本仓 | 已修：订阅 `journal`/`interactions` 主题（服务端 `ws.ts` 早已支持）+ store 帧路由 |
| 轮询档位（events/attention/interactions/health 2s；snapshot/sessions/timeline 6s） | 均值 +1s/+3s；sessions/snapshot 另实测 ~104 KB/s 持续带宽 + `/v1/sessions` 每拍全量重建 ~313ms（800 会话） | 本仓 | 保留为 WS 断开时的兜底（双通道按 id 去重），但 **6s 三路已降本**：sessions/snapshot 改条件请求（ETag/304 命中 → 空体，且 sessions 走指纹快路 ~20ms 才重建）；timeline 改按需门控（消费方在场才拉，稳态省 17.5KB/s）——见下节 |

## 读投影降本：条件请求（ETag/304）+ 指纹快路 + 按需门控（2026-09-30）

全部 **additive**：不带 `If-None-Match` 的旧客户端行为逐字节不变（照常 200 全量），契约零变化。

- **服务端**（`extensions/runtime-host/server.ts`）：`sha1Etag`（强校验器 `"<sha1hex>"`，node:crypto 零新依赖）+ `matchEtag`（支持逗号列表 / `W/` 弱前缀 / `*`）+ `respondNotModified`（304 空体，RFC 9110 回显 `etag` 头）（`server.ts:371-392`）。两个端点接入：
  - `GET /v1/snapshot`：状态体剔除 `generatedAt` 后哈希（响应时间戳非状态，相邻两拍唯一 diff 字段），命中 → 304（`server.ts:1295-1301`）。
  - `GET /v1/sessions`：`sessionsBodyFingerprint` **指纹快路**（`server.ts:408+`）——四路输入拼指纹：sessions 目录 stat-only 扫描（`[rel, mtimeMs, size]`，全精度防快速同尺寸改写误命中）+ 台账顶层 `*.json`（排除 `.state/.result.json`，gc-cleaner 归档表现为条目消失天然生效）+ registry/attachments + masterProtected sessionId；指纹与缓存一致 → 直接复用 `bodyJson/etag`（~20ms vs 全量重建 ~313ms），否则全量重建且该拍不落缓存；随后同样比对 `If-None-Match` → 304（`server.ts:1371-1421`）。**任何 IO 失败 → null → 全量重建**，never-throw。
  - ETag 对最终 JSON 串哈希（含标题解析结果）→ 标题变化自然 miss。
- **客户端**（`gui/src/api/client.ts:60-101`）：`etagCache`（key→ETag）+ `notModifiedCache`（key→上次 200 数据），`fetchJson(path, init, timeout, etagKey)` 带 `If-None-Match`；304 → 返回上次 200 的**同一对象引用**，store `set` 同引用 → zustand 选择器 `Object.is` → 零重渲染；200 → 更新两缓存；无 ETag/坏响应 → 删缓存下次回全量；无缓存却 304（不应发生）→ 按失败处理（调用方保留旧数据）。接线端点：`/v1/sessions`、`/v1/snapshot`（`client.ts:215` 等）。
- **timeline 按需门控**（`gui/src/App.tsx:40`）：`usePoll(pollTimeline, 6000, activeTab === "timeline" || runtimeOverlay === "master")`——`/v1/timeline?limit=200` 全量尾窗（实测 97KB/拍、稳态 17.5KB/s）只在两消费方（主路由 TimelinePage / 覆盖层 MasterPage）任一在场才拉；不空屏（另有 2s events 轮询 + WS journal 供数），门控打开时 `usePoll` effect 立即补一拍。`usePoll` 三参签名：`enabled = true`（`gui/src/usePoll.ts:12`）。

**不重不漏的机制**：增量帧按 `rowId` 幂等 upsert（回填保位、新行按投影序追加）；`frame.seq` 倒退防御（丢弃）；HTTP resync 响应若 `seq` 低于已收帧 seq 则丢弃（**避免旧响应覆盖新状态**——这是独立 L4 复核发现并修掉的竞态）。

## 输入编码契约（intake 侧）

客户端 → runtime-host 的两条 intake 通道均为**严格解码、永不有损替换**（`U+FFFD` 只允许来自客户端原文）。动因：Windows curl 等 cp936 客户端按系统代码页发请求体，旧 `toString("utf8")` 把非 UTF-8 字节静默烧成 `U+FFFD` 并照常落盘 outbox，事后不可恢复——故全链路改 fail-closed。

1. **HTTP `POST /v1/commands`（及 challenge）请求体** — `decodeCommandBody`（`extensions/runtime-host/commands.ts#L49`），按序先命中先返回：
   - `charset=utf-8/utf8` → 仅严格 UTF-8，出错 → `400 invalid-encoding`（**尊重声明，不兜底**）；
   - `charset=gbk/gb18030/cp936` → `TextDecoder("gb18030",{fatal:true})`，失败 → `400`；
   - 其他未知 charset → `400 unsupported-charset`；
   - 无 charset 声明 → 先严格 UTF-8，失败再 **GB18030 兜底**（cp936 客户端事实标准）；两路皆败 → `400 invalid-encoding`。
   - **fail-closed 语义**：400 时零写盘（outbox / commands 状态均不动）；合法 UTF-8 路径显式 `ignoreBOM:true`，与旧 `Buffer.toString("utf8")` 逐字节同轨（含 BOM）。零新依赖（Node 内置 TextDecoder）。
   - 接线：`extensions/runtime-host/server.ts` 的 `/v1/commands`（`#L642`）与 challenge（`#L748`），按 `content-type` 的 charset 分派。
2. **WS `OP_TEXT` 帧** — `extensions/runtime-host/ws.ts` 严格 UTF-8（`ignoreBOM:true`）；非法帧 → `close(1007, "invalid-utf8")` 且**不投 `onText`**（RFC 6455 §8.1：文本帧必须是合法 UTF-8）。

## 实测证据（C1 实验，257 次采样）

- 新会话流式 5000 字/154s：采样全程**无文件**（pi 首条 assistant 前内存暂存不落盘），文件首次出现即 6 行，且 `mtime == assistant 条目 ts`（毫秒级一致）。
- 既有会话流式 1608 字/60s：采样全程行数恒定，`message_end` 时 +1 行。
- 结论：**假设证实**——流式期间 `.jsonl` 无新行。

## 附：markdown 渲染

正文此前是 `whitespace-pre-wrap` 纯文本（markdown 原样显示）。现由自研 `gui/src/ui/Markdown.tsx`（330 行、零新依赖）渲染：**无 innerHTML 路径**（只产 React 元素 ⇒ 文本由 React 转义）+ 链接协议白名单（http/https）+ 外链 `rel="noopener noreferrer"`。未采用 zcode 的 `streamdown`（remark+rehype+shiki+mermaid 体积大、与零依赖纪律冲突），只借鉴其元素划分与流式容错思路。

## Evidence

- `gui/src/useEventStream.ts`（`onOpen` 回调）、`gui/src/store.ts`（`chatJournalHead` 指针、`resyncChatSession`、journal/interactions 帧路由、seq 防御）、`gui/src/api/client.ts`（`after=` 增量）。
- `extensions/runtime-host/ws.ts` 的 `journal`/`interactions` 主题支持。
- 独立 L4 复核：本地 `plans/0923_gui_ux_fix_review.md`；计划 `plans/0923_gui_ux_fix_plan.md`；实现 `plans/0923_gui_ux_fix_impl.md`（含 27 例 XSS/兼容实测）。
- 提交：`6d4ba67`（管道修复）、`911c397`（markdown 测试入库 + 围栏收紧）、`e7475e3`（outbox 事件唤醒）。
- 读投影降本：`fd75285`（服务端 ETag/304 + sessions 指纹快路）、`c83ea9b`（客户端条件请求接线）、`0310f05`（timeline 轮询按需门控）、`ecbdd8b`（指纹改全精度 mtimeMs+ctimeMs）；诊断与实测数据（带宽/重建耗时）见 `plans/20260930_gui_perf_diagnosis.md`。
- 输入编码契约：本地 `plans/0924_remote_input_encoding_fix.md` / `_impl.md` / `_review.md`（PASS-WITH-FIXES）；`extensions/_test_runtime_commands.ts`（`decodeCommandBody` 单测）、`extensions/_test_runtime_host_server.ts`（端到端：GBK 字节 → 200 中文完好；双重非法 → 400 且 outbox/commands 目录零新增）。

## Links Out

- [[Wiki 索引]]

## Backlinks

- [[Wiki 索引]]

## Open Questions

- 是否推动 pi 侧提供流式 delta（`row.delta` op 生产者）以实现打字机效果；若推动，投影侧需定义 delta 合并与终态对齐规则。
- ~~outbox-bridge 10s tick 是否缩短或事件化~~ **已做（`e7475e3`）**；剩余：mailbox-consumer 的 10s tick（master 域 mailbox 消费）是否同样事件化——需先解决 `readCutover`/`readAttachment` 前置门的复用风险。
- ~~自研 markdown 渲染器尚无入库回归测试；围栏闭合识别偏宽~~ **已关闭（`911c397`）**：新增 `gui/tests/markdown.test.mjs`（node 直跑、零新增依赖、33 项断言含 XSS/元素清单/流式容错/围栏正反例/golden），并把围栏闭合收紧到 CommonMark 口径（`isClosingFence`：同种字符 + run 长度≥开启长度 + ≤3 空格缩进 + 独占一行）。
