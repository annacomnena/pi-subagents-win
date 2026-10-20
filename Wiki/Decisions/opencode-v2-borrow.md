---
title: OpenCode v2 借鉴评估
kind: decision
status: current
updated: 2026-10-20
source_paths:
  - plans/20261020_opencode_v2_borrow_eval.md
  - extensions/runtime-host/ws.ts
  - extensions/runtime/stream-gen.ts
  - extensions/runtime/transcript.ts
---

# OpenCode v2 借鉴评估

## Summary

对 OpenCode 2.0 架构文档的逐条对照结论：本仓**已具备**其「快」的四条地基（准入只登记、高频增量不落盘、
慢客户端可丢、断线只补差），真正差距在**读取路径的常数成本**。本轮据此落地三项（删指纹快路、
流代际改采样指纹、WS 订阅空快路），并明确列出**不抄**的六条及理由。

## 已具备（核对结论，非计划）

| 机制 | 本仓实现 |
|---|---|
| 单 daemon 持有会话，客户端是视图 | `runtime-host/server.ts` + `host.json` 注册 + `sw_gui_token` 派生 cookie |
| 服务发现（注册文件给 URL/凭据） | `~/.pi/agent/runtime/host.json`；GUI 走 `/v1/bootstrap` OTT 换 cookie |
| 持久事实 vs 流式增量 | `runtime/journal.ts` 只追加 + WS volatile 帧；且明示 pi core「正文只在 message_end 落盘」的硬限制 |
| 先订阅→重放→水位标记 | `ws.ts::subscribeJournal`：`ack(mode:resume, head)` → 回放 `(base, head]` → live；跨代 → `ack(snapshot)` 且不激活 live |
| 背压：慢客户端不拖累 agent | `ws.ts::send()`：`conn.send()===false` ⇒ `close(1013,"backpressure")`，无每客户端队列 |
| 准入与执行分离 | outbox（落盘 + dedupeKey 幂等）+ mailbox-consumer 另一条命消费；GUI 乐观上屏 + 对账 |

## 本轮落地（详见 [[GUI 消息管道与延迟贡献项]] 第三轮）

1. 删 `/v1/sessions` 指纹快路（stat 风暴 130-146ms/拍 → 0；热路径 145-178ms → 44-46ms）。
2. `validateStreamGen` 整文件 sha1 → 采样指纹（152MB 会话 ~120ms → ~1ms）。
3. `projectSessionOps` 无新行快路（152MB 订阅 ~500ms 阻塞 → 空 ops 直返）。

## 不抄（附理由）

| 主张 | 理由 |
|---|---|
| SQLite 投影表 | 真相是 pi 的 JSONL（不可改），第二份真相的迁移/一致性代价 > 收益；用身份缓存 + 行索引达到同等读成本 |
| 高频 delta 不进持久层 | 本来就没有（pi core 只在 `message_end` 落盘），本仓无 delta 生产者 |
| Effect `HttpApi` schema 即契约 | 已有「手写类型 + 形状断言测试」的等价约束，改造成本远大于收益 |
| 虚拟化时间线 | **有价值但未做**（中等改造：滚动锚定/贴底/工具卡高度），已单列下一步 |
| 远程配对 / 隧道 | 改变安全边界（本机进程 → 网络服务），须用户显式决定 |
| exactly-once 副作用 | 与文档一致不做；本仓已在 AGENTS.md R-5 登记「宁可重发，不可漏发」 |

## Open Questions

- 虚拟化时间线是否值得做（当前首屏长任务 90ms，200 行 DOM + markdown）。
- 极端大会话（152MB、119KB/行）尾窗解析 181ms 是否可接受（典型会话 3-10ms）。
