---
title: GUI 解锁 Master
kind: decision
status: draft
updated: 2026-09-23
source_paths:
  - extensions/runtime-host/server.ts#L625-L664
  - extensions/runtime-host/commands.ts#L66-L72
  - extensions/gui-autostart.ts#L300
  - extensions/runtime/master-injection.ts
  - plans/0923_decisions.md
---

# GUI 解锁 Master

## Summary

决策（D9）：提前切片只解锁"本机受信 GUI → 活着的 master 进程"这一条注入路径。通道侧代码（bootstrap OTT + 护栏映射）**仅在未提交工作树**（`server.ts` bootstrap 段、新文件 `master-injection.ts`、`commands.ts` 的 `master-offline:409` 增补均未提交；基线 `49d5fd0` 时尚不存在），端到端注入验收未补，故本页为 `draft`。

## Current Contract

- 只开一条：本机受信 GUI → 活着的 master 进程；`agent://master_default` 的通用 403 保持不变。
- Bootstrap：`POST /v1/bootstrap` 用 host token 换一次性短时 OTT（60s，单用），经 `GET /v1/bootstrap/exchange?ott=` 换 HttpOnly SameSite=Strict 同源 cookie；长 token 永不进 URL/HTML/JS；仅接受本机回环连接；GUI 未启用 → 403。
- Master 无活进程时明确拒绝（`master-offline` → 409）；会话受保护拒绝（`master-session-protected` → 403）。
- 无头接续（G1）后续再做，不在本切片。
- 残余风险：daemon 只 bind `127.0.0.1`，host token 是本机信任；禁止端口转发/反代/公网暴露（D10）；恶意 agent 隔离 v1 不承诺（D11）。

## 已决策未实现：浏览器凭据作用域化（B 案，用户已批准）（已决策，未实现）

- `<runtimeDir>` 侧派生 `guiToken = HMAC-SHA256(hostToken, "pi:gui-cookie:v1")`；新 cookie 名 `sw_gui_token`；**浏览器不再持有 host token 本体**。
- 接受面限定**仅 cookie 位置**：`X-Command-Token: <派生值>` → 401；WS `?token=<派生值>` → 401。
- **`/v1/bootstrap` 不接受 `sw_gui_token`**（堵自续期）；TTL 12h（`Max-Age=43200`）；`/gui off` 清 cookie；重启轮换即失效。
- 动机：cookie **不受端口限制**（`127.0.0.1` 任意端口的本机服务都可能收到），而当前实现下 cookie 值等于 host token 且可经 `/v1/bootstrap` 自续期 + 1 年 Max-Age ⇒ 实际永久。

## must-fix 修复轮（已实现，待 L4）

- M1：bootstrap 双端点补 Host 精确白名单（复用同一 `isLoopbackHostname`，短路于 OTT 核销前）。
- M2：claim 前 master-offline 预检（409 不消耗 commandKey）。
- M3：审计 0600 + ~1MB 轮转（留两代）+ `denied` 行（无正文/密钥），server 层为唯一落盘点。
- 独立 L4 复核进行中，结论未定。

## Key Symbols

- `bootstrapStore` — `extensions/runtime-host/server.ts`，OTT 进程内存签发/核销。
- `loopbackSocket` / `readGuiEnabled` — bootstrap 准入条件。
- `REJECT_HTTP_STATUS` — `extensions/runtime-host/commands.ts`，拒绝 reason → HTTP status 映射。
- `handleGuiCommand` / `mintGuiBootstrap` — `extensions/gui-autostart.ts`，`/gui open` 换 OTT 并拉起浏览器走 exchange。
- `checkTrustedLocalChannel` / `readGuiEnabled` — `extensions/runtime/master-injection.ts`，窄口三证据与 opt-in 开关。

## Evidence

- `extensions/runtime-host/server.ts#L625-L664` — bootstrap OTT 签发/核销与 loopback + gui-enabled 门禁（未提交工作树；基线 `49d5fd0` 时尚不存在）。
- `extensions/runtime-host/commands.ts#L66-L72` — `master-session-protected: 403`、`master-offline: 409`（未提交工作树；基线 `49d5fd0` 时尚不存在）。
- `extensions/gui-autostart.ts#L300`、`#L464-L465` — `/gui open` 换 OTT 流程（未提交工作树；基线 `49d5fd0` 时尚不存在）。
- `extensions/runtime/master-injection.ts` — 窄口三证据、OTT 签发/核销、审计（**未跟踪新文件**，尚未合入任何提交）。
- 本地 `plans/0923_decisions.md` D8–D10。
- 历史提交 `c3f69c5`（GUI autostart opt-in）、`c3003d5`（空壳 WT 修复）为**同域**提交，**不含**本通道代码。

## Links Out

- [[Runtime Daemon 架构]]
- [[Wiki 索引]]

## Backlinks

- [[Wiki 索引]]

## Open Questions

- GUI → master 活进程注入的端到端验收（占用锁、审计行、`master-offline` 文案）待补；补完后本页方可转 `current`。
- B 案（浏览器凭据作用域化，`sw_gui_token`）落地待实现。
- must-fix 轮（M1–M3）的独立 L4 复核结论待定。
