---
title: GUI 解锁 Master
kind: decision
status: current
updated: 2026-10-01
source_paths:
  - extensions/runtime/master-injection.ts
  - extensions/runtime-host/server.ts#L651-L830
  - extensions/runtime-host/server.ts#L859-L948
  - extensions/runtime/command-executor.ts#L171-L232
  - extensions/runtime/command-executor.ts#L518-L570
  - extensions/runtime-host/commands.ts#L113-L120
  - extensions/gui-autostart.ts#L300-L330
  - extensions/_test_gui_master_unlock.ts
  - plans/0923_decisions.md
  - plans/0923_gui_master_unlock_fix_review.md
---

# GUI 解锁 Master

## Summary

决策（D9）：只解锁「本机受信 GUI → 活着的 master 进程」这一条注入路径，`agent://master_default` 的通用 403 保持不变。**B 案（浏览器凭据作用域化）与两轮 must-fix（M1–M3、R1–R2）均已实现并合入提交 `00202cb`（feat(gui,host): 本机 GUI 解锁 master（D9 窄路径）+ B 案凭据作用域化 + 两轮 must-fix）**；两轮独立 L4 复核 `plans/0923_gui_master_unlock_review.md`（PASS-WITH-MUST-FIX，M1/M2/M3）→ `plans/0923_gui_master_unlock_fix_review.md`（**总判定 PASS**，余 2 条低严重 R1/R2 后亦已补修）。故本页 `status: current`（此前 draft 的三条阻塞理由——代码未提交、B 案未实现、L4 结论未定——已全部消除）。

## Current Contract

- 只开一条：本机受信 GUI → 活着的 master 进程；`agent://master_default` 的通用 403（`master-session-protected` → HTTP 403）保持不变。
- **三证据合取**（`TrustedMasterInjectionPolicy`，`command-executor.ts#L130-L138`）：`trustedLocal && guiEnabled && masterAlive`，缺一即 403 旧语义；`alive=false` → 409 `master-offline`。**daemon 侧计算、executor 只认布尔、不重算证据**：计算点 `server.ts:749-757`（仅当 `peek.type==="session.message"` 且目标 == 当前 master owner 才算），消费点 `command-executor.ts:531`（handler 内）、`command-executor.ts:195`（claim **之前**的 master-offline 预检，409 不占幂等键）。
- Bootstrap：`POST /v1/bootstrap` 用 host token **本体**换一次性短时 OTT（60s，单用），经 `GET /v1/bootstrap/exchange?ott=` 换 HttpOnly SameSite=Strict 同源 cookie；长 token 永不进 URL/HTML/JS；仅接受本机回环连接 + 回环 Host 白名单；GUI 未启用 → 403。
- Master 无活进程时明确拒绝（`master-offline` → 409，`commands.ts:118`）；会话受保护拒绝（`master-session-protected` → 403，`commands.ts:117`）。
- 无头接续（G1：没有任何进程持有该会话时的续写）后续再做，不在本切片。
- 残余风险：daemon 只 bind `127.0.0.1`，host token 是本机信任；禁止端口转发/反代/公网暴露（D10）；恶意 agent 隔离 v1 不承诺（D11）。

## 浏览器凭据作用域化（B 案，已实现，`00202cb`）

- 派生 `guiToken = HMAC-SHA256(key="pi:gui-cookie:v1", msg=hostToken)`（`master-injection.ts:65::deriveGuiToken`，**key/message 互换**：`/v1/challenge` 只能用 hostToken 当 key 出题，无法由域常量反推本体）；cookie 名 `sw_gui_token`（`GUI_COOKIE_NAME`，`master-injection.ts:51`）；浏览器不再持有 host token 本体；TTL 12h 真上限（`GUI_COOKIE_MAX_AGE_SECONDS=43200`）。
- **接受面限定**：cookie 位置认「host token 本体（旧 `sw_host_token`，dev/测试兼容）**或**派生值」（`checkTrustedLocalChannel`，`master-injection.ts:166`）；header `X-Command-Token` 只认本体，派生值当 header 用恒不授信；`/v1/challenge` 用派生值 → 401。
- **`/v1/bootstrap` 只认本体**（`server.ts:680 authorizeHostOnly`；派生凭据在任何位置一律 401 ⇒ 堵自续期）；exchange 落 `Set-Cookie: sw_gui_token=…; HttpOnly; SameSite=Strict; Max-Age=43200`（`server.ts:945`）。
- **机会式清除**：带 `sw_gui_token` 但 `gui.autoStart` 已关 → 403 + 清 cookie（`server.ts:709-710` commands 面；`server.ts:929-930` exchange 面）。
- 动机：cookie **不受端口限制**（本机任意端口的服务都可能收到），若 cookie 值 == host token 且可经 `/v1/bootstrap` 自续期 + 1 年 Max-Age ⇒ 实际永久。

## must-fix 两轮（已实现，L4 PASS）

- **第一轮 M1–M3**（`plans/0923_gui_master_unlock_fix_review.md` 逐条 PASS）：M1 bootstrap 双端点补 Host 精确白名单（复用同一 `isLoopbackHostname`，短路于 OTT 核销前，`server.ts:870+`）；M2 claim 前 master-offline 预检（409 不消耗 commandKey，`command-executor.ts:190-214`）；M3 审计 0600 + ~1MB 两代 rename 轮转 + `denied` 行（`master-injection.ts:272-307`；server 层是唯一 denied 落盘点 `server.ts:775-805`，executor 预检保持零副作用）。
- **第二轮 R1/R2**（低严重，亦已修）：R1 离线 409 文案补「若仍 409 请重发（新 commandKey）」（`gui/src/store.ts:423`）；R2 补三用例（userinfo Host / gui-off 不核销 OTT / exchange 缺 Host），已见 `_test_gui_master_unlock.ts` 头注 R2 行。

## 注入门判据（实测澄清，2026-09-24）

- **`masterAlive` 读的是 tick 级 session heartbeat**（`<timersDir>/<sessionId>.json`，`timers.ts::sessionAlive`，grace `SESSION_HEARTBEAT_GRACE_MS`）——**会话进程活着就持续刷新，空闲也算「活」**。
- **不是** `state/master-liveness.json`（该文件只在 `agent_end` 写，用于压力/续任语义）；混为一会得出「空闲 master 收不到消息」的**错误结论**。
- **实测**（2026-09-24 00:06）：master 空闲时经 GUI 窄路径注入（cookie `sw_gui_token` + Origin 同端口 + 目标 = 当前 owner）→ HTTP 200 `accepted`，随后回执 `receipts/outbox_*.json` 的 `by = outbox-bridge:<master sessionId>` ⇒ **master 自己的桥把消息消费并注入成 followUp**（空闲会话被拉起来处理）。
- ⇒ 剩下的缺口只有一种：**没有任何进程持有该会话（TUI 关闭）** ⇒ 需 G1（无头 worker 续写同一 session 文件），仍未实现。

## Key Symbols

- `checkTrustedLocalChannel` / `deriveGuiToken` / `readGuiEnabled` — `extensions/runtime/master-injection.ts`，窄口三证据的 trustedLocal 判定、B 案派生凭据、opt-in 开关。
- `createBootstrapStore` / `BOOTSTRAP_OTT_TTL_MS` — 同文件，OTT 进程内签发/核销（单用、过期/复用 false）。
- `auditMasterInjection` / `MASTER_INJECTION_AUDIT_MAX_BYTES` — 同文件，窄路径 accepted/denied 审计（0600 + ~1MB 两代轮转、无正文字段）。
- `TrustedMasterInjectionPolicy` — `extensions/runtime/command-executor.ts:130`，executor 只认的布尔策略面。
- `authorizeHostOnly` / `presentsGuiCookie` / `respondGuiOffClear` — `extensions/runtime-host/server.ts:680/676/688`，B 案接受面与清除。
- `REJECT_HTTP_STATUS` — `extensions/runtime-host/commands.ts:113`，拒绝 reason → HTTP status 映射。
- `mintGuiBootstrap` — `extensions/gui-autostart.ts:300`，`/gui open` 换 OTT 并拉起浏览器走 exchange。

## Evidence

- `_test_gui_master_unlock.ts`（`npm run test:gui-master-unlock`，176 处断言）：E1 可信路径 accepted + outbox 落盘 + 审计行无正文；E2/E3 默认拒收与 `agent://master_default` 回归；E5 master 离线 409 零副作用；M2 同 key 离线 409 不占键 → 上线后真执行（非重放）；E6 审计字段键集精确；U2/S3 Host/Origin 对抗混淆矩阵；U3 审计 0600 + 轮转；S1/S2/S3/S4 HTTP 面与 bootstrap、B 案派生凭据、预言机回归；F1 前端静态断言。
- 代码：`extensions/runtime/master-injection.ts`（合取三条件注释 L11-L42 + 实现）、`extensions/runtime-host/server.ts#L744-L805`（策略计算与 denied 补记）、`extensions/runtime/command-executor.ts#L179-L214`（护栏与预检）、`#L518-L570`（handler 护栏二 + L3 放行 + accepted 审计）。
- 提交 `00202cb`（本页此前引用的「未提交工作树」基线 `49d5fd0` 已过时）；同域历史提交 `c3f69c5`（GUI autostart opt-in）、`c3003d5`（空壳 WT 修复）不含本通道代码。
- 复核：`plans/0923_gui_master_unlock_review.md`（PASS-WITH-MUST-FIX，M1/M2/M3）、`plans/0923_gui_master_unlock_fix_review.md`（PASS，R1/R2 后亦已补修）。
- 本地 `plans/0923_decisions.md` D8–D10。

## Links Out

- [[Runtime Daemon 架构]]
- [[Wiki 索引]]

## Backlinks

- [[Wiki 索引]]
- [[微信 iLink 通道]]

## Open Questions

- 无头接续（G1）：没有任何进程持有 master 会话（TUI 关闭）时的 worker 续写，未实现。
- 「心跳新鲜但进程已死」端到端场景未覆盖（第二轮复核 §12 明示范围外）。
- 恶意 agent 隔离（D11）v1 不承诺；本通道的信任边界 = 本机 token + loopback。
