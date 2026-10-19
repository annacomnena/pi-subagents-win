---
title: Agent 记忆机制与 pi 能力边界
kind: concept
aliases:
  - Agent Memory Mechanisms
  - Memory Layer Reference
  - 记忆层参考
tags:
  - memory
  - context-injection
  - hotspot
  - wiki
  - reference-design
status: current
source_paths:
  - extensions/hotspot/types.ts#L12-L39
  - extensions/hotspot/inject.ts#L82-L235
  - extensions/hotspot/store.ts#L61-L75
  - extensions/index.ts#L3223-L3257
  - extensions/wiki-nav.ts#L1-L28
  - extensions/wiki-semantic.ts#L85-L88
  - extensions/session-hooks.ts#L1-16
  - extensions/injection-gate.ts#L36-75
updated: 2026-10-16
---

# Agent 记忆机制与 pi 能力边界

## Summary

pi 本体**没有内置长期记忆**：没有 MEMORY/USER 文件、没有记忆检索工具、没有自动写入/整理。pi 的"持久指令"只有人写的上下文文件（`<agent-dir>/AGENTS.md`、项目 `AGENTS.md`/`CLAUDE.md` 等），全文注入 system prompt 且**无大小预算**。本仓（subagent-win）已有的"记忆类"构件都不是长期记忆：hotspot 是短期路由 cache、Wiki 是主题知识库、`recentwork.md` 是时序进度、memory guard 是运行时内存卫生。参考实现（Hermes、OpenClaw）提供了两套可借鉴的范式；本页固化"pi 侧记忆相关层的分工与约束"，供后续任何记忆功能设计复用。

## Current Contract

### pi 原生能力（外部包 `@earendil-works/pi-coding-agent`，非本仓代码）

- **无长期记忆**：`grep memory` 在 pi 包内只命中 in-memory 会话、llama.cpp 内存、SDK 内存态（`docs/cli.md`、`docs/sdk.md`）。
- **上下文文件加载**：候选 `<agent-dir>/AGENTS.override.md|AGENTS.md|AGENTS.MD|CLAUDE.md|CLAUDE.MD`；加载源 = agent 目录 + 工作目录 + 父目录；**发现不需项目信任**；`-nc/--no-context-files` 可禁（`docs/configuration.md`、`docs/security.md`、`docs/cli.md`）。顺序为全局文件最先，其后祖先→cwd 逐级各至多一个、路径去重；全文拼接进 system prompt `project_context` 节，每文件包 `<project_instructions path>`；**无大小/预算/截断**（pi `dist/core/resource-loader.js`、`dist/core/system-prompt.js`）。
- **会话与压缩**：JSONL 存 `~/.pi/agent/sessions/--<path>--/<ts>_<id>.jsonl`；压缩触发 `contextTokens > contextWindow - reserveTokens`；原 entry 留树不删；**无面向模型的跨会话召回**（`docs/sessions.md`、`docs/session-format.md`、`docs/compaction.md`）。
- **扩展注入点**：`before_agent_start` 可改写 `systemPromptOptions.sections`（等价"每次会话开始动态追加 system prompt 段"）；`input` 可改写用户消息；`session_before_compact` 可在压缩前落盘；`tool_call` 可拦截/阻断（`docs/extensions.md`、`docs/compaction.md`）。`registerTool`/`registerCommand` 可注册记忆工具与斜杠命令。

### 本仓记忆相关层的职责分工（必须保持分层）

- **Hotspot = 短期路由工作集 cache**：回答"最近在哪读/写/验证"，per-user×per-repo、TTL 12h/48h/72h、注入 ≤5 条/560 字符；**"它是 cache 不是 memory"**——可丢失、可重建、非权威，绝不晋升 Wiki。见 [[Hotspot 工作集]]。
- **Wiki = 主题知识库**：跨任务仍成立的已验证事实，人审写入，`status: current|draft|proposed|stale` + `source_paths` + Evidence。
- **`recentwork.md` = 时序进度**；`links.jsonl`/`reports/`/`tab-runs/`/`subagent-usage/`/`global-view`/`trust.json`/`runtime/events.jsonl` = 运行时状态/账本，**不是长期记忆**。
- **memory guard（`extensions/_test_memory_guard.ts`）= 运行时内存卫生**：归档陈旧 tab 账本、瘦身子代理返回值、有界 Set，防止宿主会话历史树膨胀；**不是记忆写入护栏**（无 `memoryGuard` 源符号）。

### 参考实现的范式（外部，非本仓事实）

- **Hermes**：built-in = `MEMORY.md`+`USER.md` 纯文本（`§` 分隔，无 schema），字符硬上限 2200/1375（超限**拒写**而非截断），冻结快照全量注入 volatile 层（会话中途写入不改本会话 prompt）；写审批 `write_approval` 默认关；**无 TTL/衰减/遗忘/修订**；明确**禁止时序事实**入 memory（PR/commit/进度），时序靠 `session_search`。
- **OpenClaw**：五 tier（Instructions / Curated core / Episodic / Prospective / Review）+ Markdown 正典 + per-agent SQLite（FTS5+向量）索引；混合检索（向量+BM25→recency×importance→MMR）；**provenance origin 闭集（owner/agent/untrusted/system）+ quarantine by tier**；唯一长期写者 = dreaming 定时整理；无自动 TTL 删除；memory-wiki 插件是编译知识面（不替代召回/晋升）。

### 设计约束（未来记忆功能必须遵守）

- **人写指令与机器记忆分层**：`AGENTS.md` 保持人写、低频、稳定；机器可写记忆必须独立载体并有**硬预算**（pi 上下文文件无预算，已有 48KB 实例的上下文税风险）。
- **写门先行**：agent 自动写入必须配写入护栏（Hermes `write_approval` 范式：超限拒写、写前扫描、可选 stage）；本仓 Wiki 写入目前零门控，不能直接照抄到记忆层。
- **禁时序事实入记忆**：任务进度归 `recentwork.md`，主题知识归 Wiki，记忆只存稳定偏好/环境事实——避免第二事实源。
- **遗忘语义要写清**：删除什么、不删什么（参考 OpenClaw `forget` 的 lineage 覆盖缺口）。
- **写入并发**：复用 hotspot 的"每进程独占分片 append + 原子 snapshot"与 `injection-gate` 的 exactly-once claim 模式，不引入全局锁。

## Key Symbols

- `extensions/hotspot/inject.ts::registerInject` — 首条用户消息注入门（记忆注入可复用的预算/幂等范式）。
- `extensions/hotspot/store.ts::wsPaths` — per-workspace 分片存储路径派生。
- `extensions/injection-gate.ts::claimInjection` / `confirmInjection` — exactly-once 写/投递模式。
- `extensions/wiki-nav.ts` / `extensions/wiki-semantic.ts` — 现成关键词/术语检索件（记忆检索可复用其索引模式）。
- `extensions/index.ts::sanitizeResultForDetails` — 运行时内存卫生（非记忆写入护栏）。

## Evidence

- `extensions/hotspot/types.ts#L12-L39` — 工作集常量与 TTL/注入预算。
- `extensions/hotspot/inject.ts#L82-L235` — 两级注入门与幂等标记。
- `extensions/hotspot/store.ts#L61-L75` — 分片目录布局。
- `extensions/index.ts#L3223-L3257` — `sanitizeResultForDetails` / `MAX_SUBAGENT_RETURN_CHARS`。
- `extensions/session-hooks.ts`、`extensions/injection-gate.ts#L36-L75` — 会话钩子与注入闸门。
- pi 包文档（外部，核对时间 2026-10-16）：`docs/configuration.md`、`docs/security.md`、`docs/extensions.md`、`docs/compaction.md`、`docs/sessions.md`；`dist/core/resource-loader.js`、`dist/core/system-prompt.js`。
- 外部参考（核对时间 2026-10-16）：Hermes 本机 `hermes-agent/tools/memory_tool.py`、`agent/memory_manager.py`；OpenClaw `2026.10.3` 官方 `docs/concepts/memory-*.md`、`docs/plugins/memory-wiki.md`、`docs/plugins/sdk-overview/memory-and-context.md`。

## Links Out

- [[Hotspot 工作集]]
- [[Wiki 索引]]

## Backlinks

- [[Wiki 索引]]
- [[Hotspot 工作集]]

## Open Questions

- pi `before_agent_start` 的保留 section 键名全表与多扩展同事件合并语义未文档化，落地前需实测。
- `session_before_compact` 内做耗时 LLM 抽取+落盘是否有超时上限未文档化。
- 记忆作用域（用户级 vs 仓库级）与多 tab/多进程写并发归属尚未决策。
- 本页只固化"能力边界与约束"，具体方案取舍（最小静态版 vs 检索式版）尚未拍板。
