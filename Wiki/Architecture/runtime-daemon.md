---
title: Runtime Daemon 架构
kind: concept
status: draft
updated: 2026-09-23
source_paths:
  - extensions/runtime-host/server.ts#L1-L51
  - extensions/runtime-host/daemon-lifecycle.ts#L1-L30
  - plans/0923_runtime_daemon_final_plan.md
---

# Runtime Daemon 架构

## Summary

目标三层：Client Plane（TUI/GUI/ACP/微信）/ Runtime Daemon（内含 Communication Fabric）/ Agent workers（独立进程 + Job Object 限额）。写侧按五本账逐个迁移，以 G0/G1 为闸口。本页多为方向性设计（`draft`），已验证部分见 [[Runtime Daemon 存活机制]]。

## Current Contract

- 三层划分：Client Plane 只做呈现与一次性审批；Runtime Daemon 持有 Communication Fabric（事件、租约、投影）；Agent workers 独立进程跑任务，仅承诺崩溃隔离。
- 写侧五本账迁移顺序与切换/回滚：见本地定稿计划 §6（页面内不复制全文）。
- G0 闸口：存活 + 身份（`scripts/verify-runtime-g0.ps1` §8 设计）；G1 闸口：无头接续。停止条件与交付门见定稿计划 §8–§10。
- 第一切片（已落地）：detached 生命周期 + 静态托管 + 单实例身份；写侧完全不动。

## Key Symbols

- `startRuntimeHost` / `stopRuntimeHost` — `extensions/runtime-host/server.ts`。
- `ensureRuntimeDaemon` / `defaultSpawnDaemon` — `extensions/runtime-host/daemon-lifecycle.ts`。
- `classifyHost` — `extensions/runtime-host/discovery.ts`。

## Evidence

- `extensions/runtime-host/server.ts#L1-L51` — 模块头注释（职责、fail-closed、不变量）。
- 本地 `plans/0923_runtime_daemon_final_plan.md` §1（架构与 opt-in 不变量）、§2（寿命/发现/接管）、§6（写侧迁移）、§8（G0 验证）、§9（第一批切片）、§10（测试矩阵与停止条件）。
- 已验证切片证据见 [[Runtime Daemon 存活机制]]；commit `bdb6674`。

## Links Out

- [[Wiki 索引]]

## Backlinks

- [[Wiki 索引]]
- [[Runtime Daemon 存活机制]]
- [[GUI 解锁 Master]]

## Open Questions

- 写侧迁移（§6）、G1 无头接续、崩溃自愈/登录自启（可选增强）均未实现；实现后按切片更新本页。
