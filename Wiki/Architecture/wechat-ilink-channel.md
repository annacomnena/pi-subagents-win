---
title: 微信 iLink 通道
kind: concept
status: proposed
updated: 2026-09-23
source_paths:
  - scripts/wechat-ilink-probe.mjs
  - plans/0923_wechat_ilink_probe_checklist.md
  - plans/0923_ilink_channel_adapter_plan.md
  - plans/0923_ilink_master_binding_delta.md
---

# 微信 iLink 通道

## Summary

iLink 属 Client Plane：长轮询、无公网 webhook；探针脚本已落地（commit `658306e`），七项协议未知项待真网测量；adapter 与 master 绑定均为方案（`proposed`）。

## Current Contract

- 通道定位：iLink 是 Client Plane 的一端，只做状态呈现与一次审批（D1②、D2）；微信里发"确认"不构成第二因素（D4）。
- 传输：长轮询（HTTP 超时默认 95000ms，必须 >90s），无公网 webhook。
- Reply sink 与游标持久化：用持久化的最近入站 `context_token` 回复；`bot_token`/`context_token`/`aes_key` 永不打到 stdout 与 measure 日志，只记存在性与长度。
- Token/QR 生命周期："无人开 UI 即失能"——以真网测量为准，失效以首次 401/403 时间戳判定。
- 进程放置：受监督 worker，不进 daemon 事件循环。
- 安全约束：仅访问 `https://ilinkai.weixin.qq.com` + allowlist 附件 CDN 主机；`send` 当前仅 text。

## Key Symbols

- `scripts/wechat-ilink-probe.mjs` — `login` / `listen` / `send` / `reply` / `typing` / `status` 六命令。
- `plans/.wechat-probe/` — 凭据与测量目录（`WECHAT_PROBE_DIR` 可覆盖）。

## Evidence

- `scripts/wechat-ilink-probe.mjs`（commit `658306e`）— 头部用法注释与六命令实现。
- 本地 `plans/0923_wechat_ilink_probe_checklist.md` — 可执行清单与未知项测量对照表（①–⑦）。
- 本地 `plans/0923_ilink_channel_adapter_plan.md` §2.1–2.6（六个缺口规格）、§4（交付门）。
- 本地 `plans/0923_ilink_master_binding_delta.md` §B（投递模式决策表）、§F（回执不得谎称已执行）、§G（安全红线）。
- 决策依据见 [[审批门策略]]；本地 `plans/0923_decisions.md` D1②、D2、D4。

## Links Out

- [[审批门策略]]
- [[Wiki 索引]]

## Backlinks

- [[Wiki 索引]]

## Open Questions

- 七项待真网测量：①bot_token 何时失效 ②context_token 过期行为 ③同 buf 是否重放 ④空批是否推进 buf ⑤固定 client_id 重发是否去重 ⑥同 token 并发 poll+send 是否限流 ⑦附件 URL 主机/大小限制。测完回填本页。
