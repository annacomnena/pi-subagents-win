---
title: GUI 消息管道与延迟贡献项
kind: concept
status: current
updated: 2026-09-23
source_paths:
  - gui/src/useEventStream.ts
  - gui/src/store.ts
  - gui/src/api/client.ts
  - gui/src/pages/ChatPage.tsx
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
| 用户消息入会话走 outbox-bridge 10s tick（`extensions/outbox-bridge.ts:278`；mailbox-consumer 同 10s） | 均值 +5s / 最大 +10s | 本仓 | **未改**（后续项）；GUI 侧用户自己的话已有乐观回执（`store.ts` 本地 entry 即时渲染） |
| WS 断线盲区：退避 1→10s 期间 transcript 零刷新 | 0~10s+ → **已修至 ≤3s** | 本仓 | 已修：`useEventStream` 的 `onOpen`（每次连接建立含重连先触发）即时用 `after=<head.seq>` 增量补差 + 断线 3s 兜底轮询 |
| 非 chat 页从未订阅 WS：仅靠轮询（2s/6s 档） | 2s/6s → **已修至 ≤300ms**（WS 连接期） | 本仓 | 已修：订阅 `journal`/`interactions` 主题（服务端 `ws.ts` 早已支持）+ store 帧路由 |
| 轮询档位本身（events/attention/interactions 2s；snapshot/timeline/sessions 6s） | 均值 +1s/+3s | 本仓 | 保留作为 WS 断开时的兜底（双通道按 id 去重，不重复） |

**不重不漏的机制**：增量帧按 `rowId` 幂等 upsert（回填保位、新行按投影序追加）；`frame.seq` 倒退防御（丢弃）；HTTP resync 响应若 `seq` 低于已收帧 seq 则丢弃（**避免旧响应覆盖新状态**——这是独立 L4 复核发现并修掉的竞态）。

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
- 提交：`6d4ba67`。

## Links Out

- [[Wiki 索引]]

## Backlinks

- [[Wiki 索引]]

## Open Questions

- 是否推动 pi 侧提供流式 delta（`row.delta` op 生产者）以实现打字机效果；若推动，投影侧需定义 delta 合并与终态对齐规则。
- outbox-bridge 10s tick 是否缩短或事件化（影响用户消息入会话延迟）。
- 自研 markdown 渲染器**尚无入库回归测试**（27 例 XSS/兼容验证是临时脚本，跑完即删）；围栏闭合识别偏宽（`startsWith(marker)`）属已知兼容性缺口。
