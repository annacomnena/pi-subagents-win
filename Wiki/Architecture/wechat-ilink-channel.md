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

## 登录/绑定协议契约（源码已验证）

- 取码：`GET {base}/ilink/bot/get_bot_qrcode?bot_type=3` → `qrcode`（轮询凭证）+ `qrcode_img_content`（图片 URL，按 URL 设计）+ `expires_in`（数字秒，缺省 120s）。字段别名兼容：`qr_code` / `qrcode_url`；`payload = json.data ?? json`。【已源码验证】
- 轮询：`GET {base}/ilink/bot/get_qrcode_status?qrcode=<urlenc>` → 数字 `0=pending / 1=scanned / 2=confirmed / 3,4=expired`；字符串别名 `status ?? qrcode_status`。【已源码验证】
- confirmed 时**同一次轮询响应直接带回** `bot_token`（别名 `token`）+ `ilink_bot_id`（别名 `bot_id`，可选），**无需二次请求**。【已源码验证】
- 节拍与过期：建议轮询间隔 2.5s（探针 `QR_POLL_INTERVAL_MS=2500`）；服务端过期 120s（`expires_in` 缺省 120），过期后重调取码接口。【已源码验证：节拍+缺省；指南声称：URL 可直接渲染】
- 网络错误→退避继续（轮询 HTTP 非 ok 只记 `api_error` 继续；catch 后重试），不抛错中断。【已源码验证】

### 未确认清单（未确认，不得当事实引用）

① `bot_type=3` 语义与其他取值；② `qrcode_img_content` 是图片 URL 还是 base64/内容串（按 URL 设计 + 代理回退）；③ 过期/取消的服务端错误码（3 vs 4 vs cancel vs `ret≠0`）；④ 429/限流阈值与 Retry-After；⑤ `bot_token` 的 TTL/续期/多端互踢语义；⑥ context_token 相关（本片不用）。

### 登录协议证据

- `scripts/wechat-ilink-probe.mjs` L29（`QR_POLL_INTERVAL_MS=2500`）、L167–177（取码 URL+字段别名+`expires_in || 120`）、L184–196（轮询节拍+状态映射+同响应取 `bot_token`/`ilink_bot_id`）、L203–206（`raw===3||4` 判过期，HTTP 非 ok 记 `api_error` 继续）。
- 本地 `plans/0923_wechat_gui_bind_plan.md` §阶段 1（协议事实核对，逐条带【已源码验证 / 指南声称 / 未确认】校准；plans/ gitignored）。
- 三处交叉验证：探针 `scripts/wechat-ilink-probe.mjs`（`cmdLogin`）/ iLink 接入指南（§二.1–二.2）/ zcode 客户端（`wechatILinkClient.ts:fetchLoginQrCode` + `pollQrLoop` + `normalizeQrStatus`，2.5s 节拍同）。分歧点：指南把 3/4 统称 expired；zcode 另以 `expiresAt` 做客户端超时；`imGatewayService` 凭据纯内存无落盘。

## 绑定切片边界（**已实现** `8ee843d`）

- v1 只做绑定/解绑/状态（**已实现**）：5 端点（start/status/qr-image/cancel/unbind）+ GUI「微信连接」section；默认 OFF（`channels.wechat.enabled`）。

### 开关路径（`5bfd258`）

- **入口常显**：GUI「微信连接」section **始终渲染**（原先"未启用即不渲染"导致功能不可发现）；未启用时页内给出说明 +「启用微信连接」按钮。
- **启用端点**：`POST /v1/wechat/enable|disable` —— 置于 `authorizeCommand`（无/错 token → 401）之后、opt-in 闸**之前**（避免鸡生蛋）；幂等；写 `config.json` 走 read-modify-write **保留其它字段** + 原子写；写盘失败 → 500（不谎称成功）。
- **401 提示**：页内明示"请先在 TUI 执行 `/gui open` 后再刷新"（凭据 cookie 只能由 bootstrap exchange 种下）。
- **待补**：TUI 对等命令 `/wechat on|off|status`（可复用 `setWechatEnabled`）。**token 永不进浏览器/日志/WS/argv**；凭据拟落 `<runtimeDir>/wechat/credentials.json`（0600）；二维码由 daemon 代理取图转 data URL（**已实现**，限与 iLink base URL 同 origin 且 ≤200KB/10s，失败安全回退 URL 文本）。进程放置已裁定（D14）：登录/绑定 = daemon 内**有界异步任务**（取码 1 次 + ≤120s 轮询 + AbortController 超时 + 结束即释放）；**长驻长轮询通道仍走受监督 worker**。（v1 只做绑定/解绑/状态，未实现）

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
