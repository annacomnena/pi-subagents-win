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

## W1 接收切片（**已实现**：长轮询 worker + 游标/去重/私有 inbox + 只读可见）

**边界**：只收不投——把微信**私聊文本**收下来、持久化、在 GUI 可见；**不注入任何 pi 会话**（注入是 [[#W2 准入]]，用户已批准但属下一片）。

**新增**：`extensions/channel-wechat/{client,parser,store,worker,index}.ts`、`extensions/runtime-host/channel-supervisor.ts`、`extensions/_test_wechat_receive.ts`；**最小 hunk**：`extensions/runtime-host/server.ts`（只读端点 + receive 闸）、`wechat-bind.ts`、`gui/src/pages/ChannelsPage.tsx`；`extensions/index.ts` **零改动**。

**开关**：`channels.wechat.receive.enabled`（**缺省 false**，D7 零行为变化：不 spawn、不开长轮询、不写 inbox；两个只读端点在 `receive.enabled=false` 时 403 `wechat-receive-disabled`）。

**不变量（实现层）**：①顺序 = `getUpdates → parseBatch → 逐条 claim(去重先落盘) → putInbox/quarantine → 全部落盘后才 commitBatch(游标)`；②去重前置（重复 msgId 不重复落盘/计数）；③`auth`(401/403) → `auth_required` 停 poll（不风暴）；④空批也推进游标；⑤坏格式 → quarantine（可查，不静默丢）；⑥凭据/`context_token` 永不进日志/错误/argv/URL/GUI 响应；⑦只读端点零副作用；⑧不新增监听端口（worker 只发出站 HTTPS）；⑨daemon 停机收掉 worker（显式 kill + pid 文件识别 + 父死亡看门狗）。

**计数语义（L4 收敛后钉死）**：`received` **只来自"是否真的新建 inbox 文件"**（`putInbox` 返回 `!existed`），**不得**由 `claim.materialized` 推断——`isMaterialized` 在读失败/坏 JSON/去重容量裁剪后会偏 false，据此计数会重复计。

**验收**：`npx tsx extensions/_test_wechat_receive.ts` → 7 组断言全绿（R1 协议分支 / R2 崩溃重放 / R2b putInbox 故障重放 + 裁剪后不重复计数 / R3 游标顺序 / R4 秘密卫生 / R5 opt-in OFF 零行为 + receive 闸 403 / R6 停机回收），含 **180s 硬看门狗**（EB-004）。

**已知残余（诚实清单，不得当成已解决）**：
- **quarantine 重放会重复追加行/重复计 `quarantined`**：有 msgId 的在去重裁剪或行不可读时会重复；**无 msgId 的必然重复**。影响面 = 记录/统计膨胀，**不丢正常 inbox 消息**；**W2 处理附件类 quarantine 必须按 msgId 幂等**。
- WAL 强事务（`batch.accepted` + commit marker 重放）**未做**——用"先落盘后提交游标"的顺序约束替代（不等价）。
- 多 worker fence（`daemonEpoch`/`workerAttempt` 晚 ACK 拒绝）**未强制**；supervisor 维持**单 worker**（`existsSync → 原子写` 在多 worker 下有竞态，不得声称多 worker 安全）。
- Windows **Job Object 整树回收**未做（用显式 kill + pid 文件 + 看门狗替代）。
- 附件/媒体/解密/Artifact Plane、ReplySink/出站/typing/限流聚合（W3）未做。
- 真网 7 项未测（见本页 Open Questions）。

## W2 准入：微信文本注入 master（决策 D15，**用户 2026-09-24 明确批准**）

**允许**把微信**私聊文本**按「本人远程输入」注入当前 master owner 会话——**六个条件必须同时成立**（任一不成立即 fail-closed，不注入、只持久化 + Attention）：

1. 显式 opt-in（`channels.wechat.input`，缺省 false ⇒ 关掉即零行为变化，见 D7）
2. 发送者 openid 命中**服务端 allowlist**（昵称 / 正文 / 请求体**不得**决定权限，D1）
3. **仅私聊**；群消息一律拒
4. master **进程活着**——判据是 **tick 级 session heartbeat**（`extensions/timers.ts::sessionAlive`，`<timersDir>/<sessionId>.json` 的 `lastActiveAt`，grace 15s；空闲也算活）。**不是** `state/master-liveness.json`（该文件 `agent_end` 写、用于压力/续任）。见 [[GUI 解锁 Master]] 的「注入门判据（实测澄清，2026-09-24）」
5. 目标 == **当前 owner** 且 **generation 一致**（沿用 GUI 窄路径同一 fence）
6. **脱敏审计** + 单条一次批（复用 D1 的 `ask` 档）

**边界**：既有 `session.message → master` 的 **403 语义不被绕过**——这是**新开的显式窄通道**，不是放宽旧规则。
**G1 不是 W2 的前提**：G1 只解决「没有任何进程持有该会话（TUI 关闭）」；master 开着（含空闲）时注入路径已实测可用（`Wiki/Decisions/gui-master-unlock.md`）。

### 交互期口径（D16）

远程消息到达而用户正在 master 交互时：缺省**直接插入**（远程通道本分），TUI 给醒目提示；「排队到本轮结束」留作后续可选开关。

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
