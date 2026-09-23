---
title: Host 暴露面加固
kind: decision
status: proposed
updated: 2026-09-23
source_paths:
  - plans/0923_opencode_permission_recon.md
  - plans/0923_openclaw_security_recon.md
  - extensions/runtime-host/server.ts
---

# Host 暴露面加固

## Summary

本机服务（daemon / eventual wechat bridge）默认只 bind loopback；对外暴露必须显式 opt-in + 认证；配置改动不热切换（改完重启服务）。**本页是决策记录，实现尚未落地，一律按 `proposed` 理解。**

## Current Contract

- 默认只 bind loopback：daemon 现状 `server.listen(0, "127.0.0.1")`（`extensions/runtime-host/server.ts#L885`；`#L365` 仅是该行为的注释行），保持此默认。
- 对外暴露必须显式 opt-in + 认证：非 loopback bind 仍强制鉴权；公网模式缺 Origin 白名单就拒绝启动（两条硬约束，见下）。
- 配置改动不热切换：hostname/port/password/cors 类改动改完重启服务，避免热切换扩大暴露面（抄 opencode `service set` 语义）。

## Key Symbols

- 待实现；落点预计为 `extensions/runtime-host/server.ts` 的 bind/鉴权参数与启动闸。

## Evidence

- 本地 `plans/0923_opencode_permission_recon.md` §3.2 — 默认 `127.0.0.1:4096`；`--hostname 0.0.0.0` 时文档明确警告必须设 `OPENCODE_SERVER_PASSWORD`；CORS/mDNS 显式 opt-in。
- 本地 `plans/0923_openclaw_security_recon.md` §4 — `bind:loopback` 默认 + token；exposure-runbook 五档；公网 Control UI 缺 `allowedOrigins` 拒绝启动；非 loopback 仍强制鉴权；Tailscale Funnel 强制 password。
- `extensions/runtime-host/server.ts#L885` — daemon 现状 `server.listen(0, "127.0.0.1")`（已验证；`#L365` 为注释行）。
- 两条独立来源（opencode §3.2 + openclaw §4）互相印证：默认 loopback、出网 opt-in + 认证、缺白名单拒绝启动。

## Hardened 基线（拟，抄 openclaw 形态）

- loopback + token 鉴权。
- 最窄工具面（`tools.profile:messaging` 同构：只暴露必要能力）。
- `exec.security:deny` + `ask:always`（执行默认全禁，问询默认全问）。
- 禁提权（`elevated.enabled:false` 同构）。
- 一次只放宽一项。
- 每次放宽前跑 doctor/审计（`openclaw doctor` / `security audit` 同构）。

## Links Out

- [[审批门策略]]
- [[Wiki 索引]]

## Backlinks

- [[Wiki 索引]]
- [[审批门策略]]

## Open Questions

- 与现有决定 D10（README 公网声明）的映射：D10 据此可加硬两条 —— 非 loopback 必须仍强制鉴权、公网模式缺 Origin 白名单就拒绝启动。D10 台账在本地 `plans/0923_decisions.md`，改 D10 前先与主会话确认。
- wechat bridge 的公网 runbook（鉴权+TLS+限流+allowlist+审计+轮换清单）未写，另案。
