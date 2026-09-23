---
title: 统一审批门架构
kind: concept
status: proposed
updated: 2026-09-23
source_paths:
  - plans/0923_unified_approval_gate_plan.md
  - plans/0923_approval_hermes_delta.md
  - plans/0923_hermes_approval_recon.md
---

# 统一审批门架构

## Summary

方案：三端（TUI/GUI/ACP）共用一门，`tool_call` 钩子做 fail-safe 拦截，优先级 deny > ask > auto，跨进程答案经私有 IPC + 进程身份绑定 + fence 回传，执行器最后入口复核防 TOCTOU。**纯方案，未实现。**

## Current Contract

- 三端共用一门；`tool_call` 钩子可 block、可改参、可抛错，异常时 fail-safe（fail-closed）。
- 判定优先级：deny > ask > auto；floor（见 [[审批门策略]]）在任何模式之前先生效。
- 跨进程答案回传：私有 IPC + 进程身份绑定 + fence，防止答案被冒充或错配到其他进程。
- TOCTOU：工具执行器在最后入口复核一次审批状态，审批与执行之间不留窗口。
- 三端呈现与超时：TUI 60s / GUI 120s / ACP 60s，超时按 deny 处理；微信只做状态呈现与一次审批，不产生 always。
- 与既有门分工、OFF 不变量：关门时即原生体验（opt-in 零侵入延续）。

## Key Symbols

- 方案阶段，无稳定符号；文件级改动清单见本地统一方案 §F。

## Evidence

- 本地 `plans/0923_unified_approval_gate_plan.md` §A（策略引擎）、§B（阻塞等待与答案回传）、§C（持久账/challenge/TOCTOU）、§D（无 UI/子进程/daemon 动作）、§E（分工与 OFF 不变量）、§F（切片与验收）。
- 本地 `plans/0923_approval_hermes_delta.md` §A–B（Hermes 对齐增量）。
- 本地 `plans/0923_hermes_approval_recon.md`（Hermes 参考实现侦察：网关阻塞队列约 L99、ACP 桥约 L100、fail-open 点约 L135）。
- 策略拍板见 [[审批门策略]]；本地 `plans/0923_decisions.md` D1–D4、D11–D13。

## Links Out

- [[审批门策略]]
- [[Wiki 索引]]

## Backlinks

- [[Wiki 索引]]
- [[审批门策略]]

## Open Questions

- 私有 IPC 形态、fence 实现、持久账 schema 均未定；等 Hermes/opencode/openclaw 侦察收尾后再定第一切片。
