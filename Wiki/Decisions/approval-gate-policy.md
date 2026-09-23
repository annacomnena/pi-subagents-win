---
title: 审批门策略
kind: decision
status: proposed
updated: 2026-09-23
source_paths:
  - plans/0923_decisions.md
  - plans/0923_hermes_approval_recon.md
  - plans/0923_opencode_permission_recon.md
  - plans/0923_openclaw_security_recon.md
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
- [[Host 暴露面加固]]
- [[Wiki 索引]]

## Backlinks

- [[Wiki 索引]]
- [[Host 暴露面加固]]
- [[统一审批门架构]]
- [[微信 iLink 通道]]

## 参考实现对照

边界与入口抄 openclaw，准入后的动作分级抄 Hermes，审批队列接口形状抄 opencode，但三处都做保守化改造。

| 来源 | 它的做法 | 我们的判定 | 理由 |
|---|---|---|---|
| Hermes（§2.1） | floor-before-yolo 四层判定：hardline 黑名单 → sudo-stdin 卫 → 用户 deny glob → yolo/模式旁路 | 可借鉴 | "无恢复路径"动作做成低于一切开关的 floor，连微信端"全部放行"也不能解；证据 `plans/0923_hermes_approval_recon.md` §2.1（`H/tools/approval.py:365/432/465`） |
| Hermes（§3.2–3.3） | 网关阻塞队列 + `once/session/always` + `/approve\|/deny [reason]` | 可借鉴 | once/session/always 三档记忆语义来源是 Hermes（不是 openclaw——openclaw 无对等语义，只有 allowlist 预授权）；证据 Hermes 报告 §3.1/§3.3，openclaw 报告 §3(b) 对照段 |
| Hermes（§3.2） | 超时即 BLOCKED（silence≠consent），拒绝文案禁止重试/改写/换路 | 可借鉴 | 防模型软磨硬泡的关键；证据 Hermes 报告 §3.2（`approval.py:约2260`，issue #24912） |
| Hermes（§2.2） | 检测时归一化/去混淆 + 目的端锚定（`_COMMAND_TAIL`/`_WRITE_TARGET_BOUNDARY`） | 可借鉴 | 防 `rm` 变体/相对路径/符号链的核心，比多写正则更治本；证据 Hermes 报告 §2.2 |
| opencode（§1.1） | `deny > ask > allow`，`--auto` 永不越显式 deny（help+schema+文档三印证） | 可借鉴 | "本机确认"锚点不可被 auto 越过；证据 `plans/0923_opencode_permission_recon.md` §1.1 |
| opencode（§1.2） | 粒度 action × resource-pattern，last-match-wins，`"*"` 兜底 + 具体覆盖 | 可借鉴 | 与统一门（工具+命令模式+路径）同构；需叠加租约/账本维度（opencode 无此概念）；证据 opencode 报告 §1.2 |
| opencode（§1.3） | 默认集偏宽松（多数 allow，ask 是雕刻出的例外：external_directory、`*.env`、`doom_loop`） | 需改造 | 我们高风险默认 ask/deny，默认集要比 opencode 保守；证据 opencode 报告 §1.3（另：`.env` 默认 deny/ask 在文档与二进制间有差异，见该报告未确认清单 §6） |
| opencode（§2） | `once\|always\|reject` 三选项；HTTP `POST/GET /api/session/:sid/permission[/:rid]` + `/reply` + `permission.asked/replied` 事件；ACP `session/request_permission` | 可借鉴 | daemon 侧待审队列接口形状直接参考；证据 opencode 报告 §2.1–§2.2 |
| opencode（§1.1/§4.2） | `always` 疑似 project 级 saved permission 落盘 | 需改造 | 我们 `always` = 作用域+TTL+可撤销租约且需一次本机二次确认；微信端 `always` 降级为 once；且"always 是否精确等于写 saved 行"**未确认**（opencode 报告未确认清单 §2），不得当事实引用 |
| opencode（§1.1） | `yolo` / `dangerously-skip-permissions` 隐藏强开关 | 不适用 | 不引入 yolo 类开关，与 opt-in 零侵入相悖；证据 opencode 报告 §1.1 |
| opencode（§3） | `--standalone` 私有 server vs 后台 service；默认 `127.0.0.1`；CORS/mDNS 显式 opt-in；改配置需重启 | 可借鉴 | 信任边界整套借用，见 [[Host 暴露面加固]]；证据 opencode 报告 §3.1–§3.3 |
| openclaw（§2） | `dmPolicy = pairing\|allowlist\|open\|disabled`、群聊 `groupPolicy` 独立、配对码 8 位/1h/3 pending、未授权静默丢弃、fail-closed 回退 | 可借鉴 | "谁能进"的入站信任链与 L2 双检同构；证据 `plans/0923_openclaw_security_recon.md` §2 |
| openclaw（§3） | 信任模型 = "谁能进"，没有准入后降权 | 需改造 | 我们准入后仍有动作分级（抄 Hermes）；证据 openclaw 报告 §3 |
| openclaw（§5） | exec `deny\|allowlist\|full` × `ask off\|on-miss\|always` × `askFallback deny`（默认） | 可借鉴 | 与 deny-first 同构，可当 hardened 默认配置参照模板；证据 openclaw 报告 §5 |
| openclaw（§4） | hardened 基线 + 一次只放宽一项；exposure-runbook 五档 + 公网 Control UI 缺 `allowedOrigins` 拒绝启动 | 可借鉴 | 见 [[Host 暴露面加固]]；证据 openclaw 报告 §4 |
| openclaw（§3b） | 任意已鉴权 admin 可在远端代批（supervised + `RequireRequesterMatch=false` 时） | 需改造 | 我们微信不能自批：微信侧只推脱敏状态 + approvalId，本机才可 decide；且"官方版是否有 IM 内 `/approve <id>`"**未确认**（openclaw 报告 §3b/缺口 §2，仅 openclaw.net 移植版见，官方文档无），不得当事实引用 |
| opencode（§1.4） | `question`（追问工具）与 `doom_loop`（反复失败后继续）也要过审批门 | 可借鉴 | 防"审批外循环"：反思/追问型工具同样进门 + 失控循环熔断器；证据 opencode 报告 §1.4 |
| Hermes（§5） | 非交互非网关默认 auto-approve（fail-open） | 需改造 | headless 高风险默认 fail-closed（进 pending 账本等本机确认）；审批不是 OS 沙箱（openclaw 沙箱机制亦未确认，v1 不展开） |

## Open Questions

- 三份参考实现侦察已收尾（Hermes/opencode/openclaw），见 `## 参考实现对照`；策略引擎分类默认值、跨进程答案回传形态以实现为准。
