---
title: 审批门策略
kind: decision
status: proposed
updated: 2026-09-23
source_paths:
  - plans/0923_decisions.md
  - plans/0923_hermes_approval_recon.md
  - plans/0923_unified_approval_gate_plan.md
  - plans/0923_approval_hermes_delta.md
---

# 审批门策略

## Summary

用户已拍板审批档位 C（折中）：floor 永不可批、ask 可远程一次批、always 仅受限租约且需本机二次确认。**本页是决策记录，实现尚未落地，一律按 `proposed` 理解，不得当成已实现行为引用。**

## Current Contract

- Floor 永不可批：hardline（删根/系统目录/裸设备/关机）、提权（`sudo -S` 等）、密钥读取或外发、支付/部署、直接写共享账本——任何端（本机/微信/GUI）都不能批准（D1①）。
- Ask 带可远程一次批准：删/覆盖文件、批量仓库改动、shell、未知动态展开等，本机或微信均可一次批准；拒绝理由原文回传模型，且禁止重试/改写/换路（Hermes 语义，silence≠consent）（D1②、D2）。
- always 受限：仅给"作用域 + TTL + 额度"的受限租约（工具执行器 ID/版本 + 命令模板 + 参数槽位 + 物理资源集合），且需一次本机二次确认；微信端不得单独产生 always（D1③）。
- 高风险动作必须本机确认；微信里发"确认"不构成第二因素（D4）。
- 恶意 agent 隔离 v1 不承诺，仅承诺崩溃隔离（独立进程 + Job Object 限额）（D11）。
- 未装扩展的 pi 并发打开同一 session 是残余风险：非租约持有者写入 → `uncertain` + GUI 降只读 + 告警，不承诺拦住刻意绕过（D12）。
- 结束阶段：不采用 Hermes 的 headless auto-approve（fail-open）、不让辅助 LLM 代批、不采用 ACP workspace 自动放行编辑（D13）。

## Key Symbols

- 待实现，见 [[统一审批门架构]] 的文件级改动清单。

## Evidence

- 本地 `plans/0923_decisions.md` — D1–D4、D11–D13 决策表（权威台账，gitignored）。
- 本地 `plans/0923_hermes_approval_recon.md`：hardline 黑名单（`H/tools/approval.py:365`，约 L72）、网关 `/approve|/deny`（`H/gateway/slash_commands.py:4304/4362`，约 L13）、deny 理由原文回传（约 L99）、headless fail-open 宽松点（约 L135）、session/always 存储（约 L112–113）。
- 本地 `plans/0923_unified_approval_gate_plan.md` §A–F、`plans/0923_approval_hermes_delta.md` §A–B — 方案细节（未实现）。

## Links Out

- [[统一审批门架构]]
- [[Wiki 索引]]

## Backlinks

- [[Wiki 索引]]
- [[统一审批门架构]]
- [[微信 iLink 通道]]

## Open Questions

- Hermes/opencode/openclaw 侦察未完；策略引擎分类默认值、跨进程答案回传形态以实现为准。
