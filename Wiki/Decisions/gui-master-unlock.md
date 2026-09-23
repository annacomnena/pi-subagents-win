---
title: GUI 解锁 Master
kind: decision
status: draft
updated: 2026-09-23
source_paths:
  - extensions/runtime-host/server.ts#L625-L664
  - extensions/runtime-host/commands.ts#L66-L72
  - extensions/gui-autostart.ts#L298
  - plans/0923_decisions.md
---

# GUI 解锁 Master

## Summary

决策（D9）：提前切片只解锁"本机受信 GUI → 活着的 master 进程"这一条注入路径。通道侧代码（bootstrap OTT + 护栏映射）已落地，但端到端注入验收未补，故本页为 `draft`。

## Current Contract

- 只开一条：本机受信 GUI → 活着的 master 进程；`agent://master_default` 的通用 403 保持不变。
- Bootstrap：`POST /v1/bootstrap` 用 host token 换一次性短时 OTT（60s，单用），经 `GET /v1/bootstrap/exchange?ott=` 换 HttpOnly SameSite=Strict 同源 cookie；长 token 永不进 URL/HTML/JS；仅接受本机回环连接；GUI 未启用 → 403。
- Master 无活进程时明确拒绝（`master-offline` → 409）；会话受保护拒绝（`master-session-protected` → 403）。
- 无头接续（G1）后续再做，不在本切片。
- 残余风险：daemon 只 bind `127.0.0.1`，host token 是本机信任；禁止端口转发/反代/公网暴露（D10）；恶意 agent 隔离 v1 不承诺（D11）。

## Key Symbols

- `bootstrapStore` — `extensions/runtime-host/server.ts`，OTT 进程内存签发/核销。
- `loopbackSocket` / `readGuiEnabled` — bootstrap 准入条件。
- `reasonToStatus` — `extensions/runtime-host/commands.ts`，拒绝 reason → HTTP status 映射。
- `/gui open` — `extensions/gui-autostart.ts`，换 OTT 并拉起浏览器走 exchange。

## Evidence

- `extensions/runtime-host/server.ts#L625-L664` — bootstrap OTT 签发/核销与 loopback + gui-enabled 门禁。
- `extensions/runtime-host/commands.ts#L66-L72` — `master-session-protected: 403`、`master-offline: 409`。
- `extensions/gui-autostart.ts#L298`、`#L464-L465` — `/gui open` 换 OTT 流程。
- 本地 `plans/0923_decisions.md` D8–D10。
- commit `c3f69c5`（GUI autostart opt-in）、`c3003d5`（detached 无控制台子进程继承修复）为同通道相关提交。

## Links Out

- [[Runtime Daemon 架构]]
- [[Wiki 索引]]

## Backlinks

- [[Wiki 索引]]

## Open Questions

- GUI → master 活进程注入的端到端验收（占用锁、审计行、`master-offline` 文案）待补；补完后本页方可转 `current`。
