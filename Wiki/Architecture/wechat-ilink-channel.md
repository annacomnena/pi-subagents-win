---
title: 微信 iLink 通道
kind: concept
status: current
updated: 2026-09-25
source_paths:
  - scripts/wechat-ilink-probe.mjs
  - plans/0923_wechat_ilink_probe_checklist.md
  - plans/0923_ilink_channel_adapter_plan.md
  - plans/0923_ilink_master_binding_delta.md
  - extensions/channel-wechat/send.ts
  - plans/0924_wechat_w3a_calibration.md
  - extensions/wechat-reply-hook.ts
  - extensions/runtime-host/wechat-reply.ts
  - extensions/runtime-host/wechat-bind.ts
  - extensions/runtime/wechat-reply.ts
  - extensions/channel-wechat/store.ts
  - extensions/channel-wechat/parser.ts
  - extensions/runtime/wechat-remote-command.ts
  - extensions/wechat-command-consumer.ts
  - extensions/runtime-host/wechat-input.ts
  - extensions/index.ts
  - plans/0925_wechat_media_probe_results.md
  - plans/0924_wechat_media_gateway_research.md
---

# 微信 iLink 通道

## Summary

iLink 属 Client Plane：长轮询、无公网 webhook；探针、绑定、接收、master 注入、文本出站回复、**入站媒体规格（真机实测：item type 矩阵 / 嵌套 `media.*` 形状 / `base64(hex32)` AES key / AES-128-ECB+PKCS7 解密 6/6 + 魔数，见「入站媒体与附件规格」节）**、**出站媒体规格（三段式 getuploadurl → CDN 密文 POST → 纯媒体 `item_list`；caption 必须单独发；不需 `context_token`；1×1 PNG 端到端人工确认，见「出站媒体规格」节）**、**`client_id` 去重语义（服务端按 id 去重，同 id 双发只投 1 条 → 多收件人必须 per-recipient clientId，人工确认）**、**出站广播**（`reply.mode="broadcast"`：global master 会话 → 全部已知私聊）与**远程斜杠命令旁路**（`/xxx` 在进 LLM 前被消费端拿下 → `consumed`，零转写污染）均已实现。广播契约见 [[#出站广播]]，命令通道契约见 [[#远程斜杠命令]]。协议剩余未知项及校准状态见「Open Questions」与各契约节。

## Current Contract

- 通道定位：iLink 是 Client Plane 的一端，只做状态呈现与一次审批（D1②、D2）；微信里发"确认"不构成第二因素（D4）。
- 传输：长轮询（HTTP 超时默认 95000ms，必须 >90s），无公网 webhook。
- Reply sink：真机入站信封顶层无 `context_token`（已实测，至少 4 条）；回复按 `to_user_id` 直发，不依赖最近入站 context token。凭据与 token 不进入日志/GUI。
- Token/QR 生命周期："无人开 UI 即失能"——以真网测量为准，失效以首次 401/403 时间戳判定。
- 进程放置：受监督 worker，不进 daemon 事件循环。
- 安全约束：仅访问 `https://ilinkai.weixin.qq.com` + allowlist 附件 CDN 主机；`send` 当前仅 text。

## 出站协议契约（真机校准 2026-09-24）

- **请求**：`POST {base}/ilink/bot/sendmessage`；鉴权头同 getupdates（`AuthorizationType: ilink_bot_token`、`Authorization: Bearer <bot_token>`、`X-WECHAT-UIN`，另有 JSON content-type）。出处：`extensions/channel-wechat/send.ts#L110-L113`；`plans/0924_wechat_w3a_calibration.md`。
- **Body**：`base_info.channel_version="2.0.0"`；`msg` 含 `from_user_id:""`、`to_user_id`、`client_id`、`message_type:2`、`message_state:2`、`item_list:[{type:1,text_item:{text}}]`；**不带 `context_token`**。出处：`extensions/channel-wechat/send.ts#L121-L128`；校准依据：`plans/0924_wechat_w3a_calibration.md`。
- **真机响应**：HTTP 200 + `{message_id}`；无 `ret`/`errcode`/`errmsg`。`send.ts` 将缺失业务码按 0 处理，因此该响应判为成功。出处：`extensions/channel-wechat/send.ts#L159-L170`；`plans/0924_wechat_w3a_calibration.md`。
- **client_id 去重（已定，人工确认）**：服务端**按 `client_id` 去重——相同 id 双发只投递 1 条**（第四轮固定 id 连发 2 次均 `ret=0`，用户手机只收到 1 条；B + 人工确认）⇒ **多收件人必须 per-recipient clientId**。出处：`plans/0925_wechat_media_probe_results.md` §11.5；见「`client_id` 去重语义」节。
- **出站 URL 渲染（已定，人工确认）**：`text_item.text` 原样发出的 URL **被微信端渲染为链接形态**（B + 人工确认）；是否出卡片缩略图、可点性未验证。出处：同上 §11.5 判定表 #2。
- **未验证**：429/并发 poll 限流（读端点并发 3× 无 429 已测）、bot 自发回声（窗口内未观测到，非穷尽）、**4001 字符在微信端是否被截断（服务端 `ret=0` 接受 = B，截断 = U）**。出处：`plans/0924_wechat_w3a_calibration.md` + `plans/0925_wechat_media_probe_results.md` §11。

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
- W3 出站回复已实现（W3a 协议发送、W3b 意图触发、W3c daemon 发送/审计、W3d 只读状态投影）；**出站广播**（`reply.mode="broadcast"`，master 会话 → 全部已知私聊）已实现，见 [[#出站广播]]；typing、限流聚合、附件/媒体/解密/Artifact Plane 仍未做。
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

### 真机消息条目形状（**已实测**，2026-09-24）

由 quarantine 的脱敏形状签名抓到（`msgs[]` 内每条 = **消息信封**）：

```
{ seq:number, message_id:number, from_user_id:string, to_user_id:string, client_id:string,
  create_time_ms:number, update_time_ms:number, delete_time_ms:number,
  session_id:string, group_id:string, message_type:number, message_state:number, item_list:[...] }
```

与指南/ZCode 的差异（**我们原先全部踩中**）：
| 项 | 指南/我们的旧假设 | **真机** |
|---|---|---|
| 消息 id | `entry.id`（字符串） | **`message_id`（数字）** ⇒ 旧 `pickMsgId` 只收字符串 → 判"缺 id" → **全部 quarantine** |
| 发送者 | `msg.from.id` | **`from_user_id`**（顶层） |
| 文本 | `c.text` / `c.content` | **`c.text_item.text`**（对象） |
| 群标识 | 无 | **`group_id`**（非空 = 群消息 ⇒ D15 仅私聊拒收） |

**这解释了"消息收不到"的最后一段**：协议修复后消息**一直在到**（`quarantined` 计数增长），但 parser 读不懂字段 ⇒ 全部进 quarantine ⇒ **GUI「收到的消息」读的是 inbox，因此界面显示为空**，用户以为完全没收到。

**教训（两条）**：① 未知形状的解析必须把**脱敏形状签名**写进 quarantine reason（本次正是靠它一次定位）；② **quarantine 必须可见**（当前 GUI 只读 inbox ⇒ 用户看不到被拒记录，这是真实的 UX 盲区，已列为后续项）。

## W2b 界面开关切片（**已落地** `18ba74d`，D17）

**动机**：D17「任何 opt-in 开关必须界面可达」——W2 的注入开关原先只能手改 `config.json`。

**三端点**（均在 `authorizeCommand` 之后；`wechat.enabled=false` 时 **403**）：
| 端点 | 语义 |
|---|---|
| `POST /v1/wechat/input/set` | `{enabled?, allowFrom?, add?: string[]（完整 openid）, remove?: string[]（hash id）}`；原子 read-modify-write 保留其它字段；trim/去重/去空；幂等；写失败 500。**响应只回 `{id, masked}` 投影，不回显完整 openid** |
| `GET /v1/wechat/input/status` | `{enabled, allowFrom:[{id: sha256前12, masked}], allowFromCount, masterAlive, masterSid12?, lastDecision/lastReason/lastAt}`（`masterAlive` = **tick 级** `sessionAlive`；后三者取审计尾行） |
| `GET /v1/wechat/senders` | 最近发送者（**完整 openid**，仅供本机受信 GUI 一键加白名单）：inbox 归并去重、按 lastAt 降序、**上限 20**、**不写审计/日志** |

**GUI**：新增「允许微信消息进入对话」区块——开关 + 醒目警示（开启 = 微信当你的输入）+ 白名单列表（掩码 + 按 **hash id** 删除，**刷新后仍可维护**）+ 从最近发送者一键添加 + **「为什么没进来」**（`masterAlive` 红/绿 + 最近判定 + 时间 + 离线时提示 `/gui open`）。

**L4 收口**（`plans/0924_wechat_input_w2b_l4_review.md`，PASS-with-must-fix）抓到并已修两处契约偏差：① `input/set` 原先置于 opt-in 闸**之前** ⇒ 禁用时返回 200 且写盘（规格要求 403）；② `set` 响应原先回显**完整 openid**（规格：仅 `/senders` 与 GUI 内存）。两处均补测试锁定。

**操作顺序（重要，有依赖）**：① 先让消息"收得到" → ② 在「收到的消息」看到 → 点「从最近发送者一键添加」→ ③ 再打开 `input` 开关。**⚠️ 若白名单为空就先开 `input`，期间收到的消息会被判 `denied` 并标 `rejected`（终态），事后加白名单不补投。**

## 真机协议实测（2026-09-24，**指南不可信**）

**结论：指南 §3 描述的响应形状与真机不符，实现必须按真机校准。**

| 项 | 指南写的 | **真机实测** |
|---|---|---|
| 响应字段 | `{ret, buf, item_list}` | **`{msgs, sync_buf, get_updates_buf}`**（**无** `ret`/`buf`/`item_list`） |
| 游标字段 | `buf` | **`get_updates_buf`**（长，96 字符 base64）+ `sync_buf`（短，12 字符） |
| 消息列表 | `item_list` | **`msgs`** |
| 长轮询时长 | 60~90s | **约 18s** 返回（差 3~5 倍） |
| 请求头 | `AuthorizationType` + `Authorization: Bearer` + `X-WECHAT-UIN` | ✅ 均被接受（HTTP 200） |
| 空批 | 未说明 | `msgs:[]` + **仍带新游标**（可推进，W1 空批推进语义成立） |

**影响与修法**：W1 原按指南实现 ⇒ 游标取不到（`protocolErrors` 累积、游标永不推进）⇒ **一条消息也收不到**。修法 = `client.ts` 接受真机字段（游标 `get_updates_buf`→`sync_buf`→`buf`；列表 `msgs`→`item_list`），**两种形状都兼容**；`parser.ts` 宽容取 msgId（`id`/`msgId`/`msg_id`/`msg.id`）、无 `msg` 包装时按条目自身解析、内容项接受 `item_list`/`items`/`content_list`，并新增**脱敏形状签名**（未知结构 quarantine 时记 `shape={key:type}`，**只记键名与类型**）——用于一次性对齐真机字段。

**教训（可复用）**：第三方协议文档**必须用真机响应校准**后才能作为实现依据；"真网未测"清单里的项要尽早打真机，否则整个通道可能只是"看起来实现了"。

### 判定实验：消息不进长轮询队列（2026-09-24）

两个受控探针（均为唯一消费者，worker 已停）：
1. **随机 UIN + 空游标**：6 次 poll 全 `msgs:[]`；
2. **固定 UIN（跨请求稳定）+ 空游标**：6 次 poll 全 `msgs:[]`（HTTP 200、服务端接受并返回新游标、`sentBufLen` 96）。

**结论**：① 请求与游标处理**正常**（服务端接受并推进游标）；② **UIN 是否跨请求稳定不影响投递**；③ 该 bot 的消息**根本不进入长轮询队列** ⇒ 属**平台侧投递路径**问题（如平台仍把消息推给某个 webhook/后端、或该 bot 的消息走别的投递方式），不是本机实现缺陷。用户侧现象佐证：曾收到 bot 自动回复"暂无法连接openclaw"（说明**有东西在应答**），该回复消失后长轮询仍恒空。

**待用户在平台侧核对**：① bot 的「消息推送 / Webhook / 回调 URL」是否配置（应清空才能走长轮询）；② 绑定用的 `bot_type`（我们用 3）与所聊 bot 是否同一个；③ 是否需要先与 bot 建立会话/好友关系才投递。

## 入站媒体与附件规格（真机实测 2026-09-25，媒体探针 Phase ③）

> **证据级别 B（本机真机实测）**：`plans/0925_wechat_media_probe_results.md` §9/§10（三轮探针，commit `6a72b19` → `9f52a4a` → `d724f6a`，唯一入库文件 `scripts/wechat-ilink-probe.mjs`，**未改任何生产代码**）+ `plans/.wechat-probe/items.jsonl`（43 行脱敏键名签名）+ `plans/.wechat-probe/key-format.json`（6 样本脱敏诊断 + `conclusion` 汇总）。
> **⚠️ 高价值发现：实测与官方接入指南（C 级）描述不符** —— 指南 §二.3 的平铺 `image_item:{file_id, url, aes_key}` 形状、以及「`aes_key` = 32 hex 或 16B base64」的解密口径，在真机上**都不成立**；入站媒体实现必须按本节真机形状（这与「真机协议实测：指南不可信」是同一类教训的第二例）。

### item type 矩阵（B）

| `type` | 含义 | item 变体键 | 真机样本 |
|---|---|---|---|
| `1` | 文本 | `text_item` | `items.jsonl`（含纯 URL 文本） |
| `2` | 图片 | `image_item` | `items.jsonl` + 2 个解密 jpg |
| `3` | 语音 | `voice_item` | `items.jsonl` + 2 个解密 silk |
| `4` | 文件 | `file_item` | `items.jsonl` + 2 个解密 pdf |

- **链接作为文本处理**（无独立 item type）：43 条样本中只出现 1/2/3/4，链接走 `type=1 text_item`。
- `type=5`（video）**未采样**（U）；群 / 小程序卡片的 item 也未采（U，不影响类型矩阵）。
- 口径提醒：`type` 是 **item 级**枚举，与信封级 `message_type`（实测取值 1）不是同一枚举，不得互推。

### 信封与 item 公共字段（B）

- **信封（逐条消息）**：`{message_type, message_state, hasContextToken, hasGroupId}`，实测取值 `message_type=1`、`message_state=2`、`hasContextToken=true`、`hasGroupId=false`。
- **id 双层**：信封层 `message_id`（number，`msgIdPath="message_id"`）；item 层 `msg_id`（string）。信封无 item 级 id 字段。
- **item 公共键（四类全有）**：`create_time_ms:number`、`update_time_ms:number`、`is_completed:boolean`、`msg_id:string`、`button_item_list:array`、`at_bot_username_list:array`。

### 各类型 item 形状（签名降级为类型，原文见 `items.jsonl`）

| type | 变体键形状 |
|---|---|
| 1 | `text_item:{text:string}` |
| 2 | `image_item:{aeskey:string, **media:{encrypt_query_param, aes_key, full_url}**, mid_size:number, thumb_size:number, thumb_height:number, thumb_width:number, hd_size:number}` |
| 3 | `voice_item:{media:{encrypt_query_param, aes_key, full_url}, encode_type:number, bits_per_sample:number, sample_rate:number, playtime:number, text:string}` |
| 4 | `file_item:{media:{encrypt_query_param, aes_key, full_url}, file_name:string, md5:string, len:string}` |

- **附件 URL / key 在嵌套 `media.full_url` 与 `media.aes_key`**（不是平铺顶层）；图片另有顶层小写 `aeskey`（见下节）。文件名在 `file_item.file_name`（image/voice 无文件名字段，落盘名需安全化派生）。
- 尺寸用 `mid_size` / `thumb_*` / `hd_size` / `len`，**没有**通用 `size`；`file_id`/`media_id` **未观测到**（指南写法不成立）。
- 与旧读数的差异及失败根因（平铺 `media.url` 提取 → URL 为空 → 下载/解密从未发起）：`plans/0925_wechat_media_probe_results.md` §9.1–§9.2。

### AES key 格式与解密（B，6/6）

| 项 | 真机实测（6 样本一致） |
|---|---|
| `media.aes_key` | **`len=44` / base64 / 带 padding** → base64 解码得 **32B ASCII hex 文本** → hex 解码得 **16B AES-128 key**，即 **`base64(hex32)` 双层编码** |
| 顶层 `aeskey`（**仅 `image_item` 有**） | **`len=32` / hex** → 16B；与 `media.aes_key` **字符串不同**（`same:false`）但**派生 16B key 相同**（`sameDerivedKey:true`）= 同一把 key 两种编码 |
| `file_item` / `voice_item` 顶层 | **无** `aeskey`（key 只在 `media.aes_key`） |
| 解密算法 | **AES-128-ECB + PKCS7**；候选链（32hex / base64→16B / base64url / `base64(hex32)`）**逐方案试出**，判优 = PKCS7+魔数 > 魔数 > PKCS7，全不中如实失败 —— **不是硬编码成功** |
| 真机结果 | **解密 6/6 + 魔数 6/6**：`FFD8FF`→jpeg×2（plainBytes = `mid_size`）、`%PDF`→pdf×2、`0x02`+`#!SILK_V3`→silk×2 |

- **与指南（C 级）冲突点**：指南 L200 称「`aes_key` = 32 hex 或 16B base64」——真机值两者都不是（base64 解出 **32B** 而非 16B），旧 `parseAesKey` 因此直接判「格式无效」；Hermes `weixin.py#L2145-L2225`「`aes_key` 必须是 base64(hex 字符串)、`b64(raw)` 会灰图」与实测自洽（C↔B），photon-hq 的 `aes_key(base64)` 是**不完整表述**。
- 脱敏纪律：诊断只记 `len/charset/hasPadding/prefix4/decodedByteLen/sampleHexPreview(≤4B)/same`，**无完整 key**；grep 44 字符 base64 / 32 hex / 完整 key = 0 命中。

### CDN 边界与下载纪律（B）

- 6/6 附件 host = **`novac2c.cdn.weixin.qq.com`**，命中 allowlist 后缀 **`.qq.com`**，**hops=0**（本轮未见 302）。探针侧 `CDN_SUFFIX_ALLOW = [.qq.com, .qpic.cn, .weixin.qq.com, .wx.qq.com, .cdn.cn]` + 同源 host + `WECHAT_PROBE_EXTRA_HOSTS`（`scripts/wechat-ilink-probe.mjs#L141-L149::isHostAllowed`）。
- 下载面：`redirect:"manual"` + **每跳复检** `isHostAllowed`（≤3 跳），拒绝记 `attachment_download_blocked{reason,host,hops}`；**302 越域实测被拒**（stub 回归 `host-not-allowed hops=1`），初始越域补记 `hops=0` 审计；成功记 `attachment_download{status,host,hops,plainBytes}`（**不记 URL/key/密文**）。
- **生产侧仍无任何下载/解密代码**（M1 范围）；文件名安全化实测中文保留、`../` 路隔符 → `_`（无穿越）。

### 出站 upload 端点（B，硬门 P5 已通过）

| 探测 | 实测 | 判读 |
|---|---|---|
| `POST /ilink/bot/getuploadurl`（占位参数） | **200**，响应**单键 `upload_full_url`**（816B 预签名 URL，host=`novac2c.cdn.weixin.qq.com` 命中 allowlist），无 `data` 包裹 | **端点存在并真的发预签名 URL** |
| 同上，坏 / 无 token | `errcode=-14`（session timeout） | **鉴权生效** |
| 同上，空 body | `ret=-2` | 参数校验生效 |
| `POST /ilink/bot/upload`（multipart 候选） | **404 + 空体** | **路径不存在** ⇒ D 级分歧收敛，**两段式** |
| `OPTIONS`（任一路径） | 照样走鉴权+参数校验 | **方法论：不能用 OPTIONS 判「方法是否支持」** |

- 负控制（不存在路径 → 404）证明本服务**能**用 404 区分「路径不存在」⇒ 200 有信息量；`getuploadurl` 只回 `upload_full_url`、无 `upload_param`，落在 Hermes 已覆盖的分支（C↔B 自洽）。
- **仍未测（U）**：~~CDN 是否收我们的密文与 POST 方法、`x-encrypted-param` 是否返回、`sendmessage` 带媒体 item 是否被接受、是否强制 `context_token`~~ —— **均已在第四轮真机收口（B + 人工确认）**，见下节「出站媒体规格」。**残余仅剩**：大媒体（本轮 70B/80B 密文）、其它 `media_type`、上传失败/重试语义。

### 出站媒体规格（真机实测 2026-09-25 第四轮 + 人工确认）

> **证据级别 B（本机真机）+ 人工确认**：`plans/0925_wechat_media_probe_results.md` §11（第四轮，探针 commit `56e5088`，基线 `4f67753`）+ §11.5（用户人工判定，原话「1条，4001个a我不太确定其实，链接收到了，肯定打不开毕竟不是真网站」）。

**三段式全部本机真机打通**：

| 段 | 规格 | 实测 |
|---|---|---|
| ① 申请预签名 URL | `POST /ilink/bot/getuploadurl`，body `filekey, media_type, to_user_id, rawsize, rawfilemd5, filesize, no_need_thumb, aeskey` | 200 + **单键 `upload_full_url`**（host 落 allowlist）；无 `upload_param` 分支 |
| ② 上传密文 | **AES-128-ECB（随机 16B key + PKCS#7）→ `POST` `application/octet-stream`** 到该预签名 URL | **4/4 HTTP 200**，响应头 **`x-encrypted-param`（480B）= `encrypt_query_param`**；**无需 PUT** |
| ③ 发消息 | `sendmessage`，`item_list` **只放一个媒体 item** | **200 + `message_id`** |

**实测通过的出站媒体 body（字段不得增删）**：
```
{ base_info:{channel_version:"2.0.0"},
  msg:{ from_user_id:"", to_user_id:<收件人>, client_id:<per-recipient uuid>,
        message_type:2, message_state:2,
        item_list:[{ type:2,
          image_item:{ media:{ encrypt_query_param:<x-encrypted-param 480B>, aes_key:base64(hex32), encrypt_type:1 },
                       mid_size:<密文字节> } }] } }
```

- **`item_list` 只放媒体项，caption 必须单独发一条文本**：`[text, image]` 同 `item_list` → **`HTTP 200 / ret=-2 invalid arguments / 无 message_id`**（n=2，B）。与 Hermes「caption 单独发」一致（C↔B）；photon-hq「caption 可与媒体同条」**被本机否证**。
- **`media` 三键**：`encrypt_query_param`（= CDN 响应头 `x-encrypted-param` 480B）、`aes_key` = **`base64(hex32)`**（与入站同格式）、`encrypt_type:1`。
- **`mid_size` = 密文字节**（同 Hermes `ciphertext_size`）。注意与入站口径不同：入站 `mid_size` = 解密后 plainBytes，两侧勿混用。
- **不需要 `context_token`**：出站 send 未带该字段仍拿到 `message_id` ⇒ 研究 U4 对「出站 send 段」给出正向证据。
- **端到端人工确认（B + 人工确认）**：用户确认 **1×1 纯色 PNG 已收到** ⇒ **出站发图端到端通过**；**URL 被渲染为链接形态**（同为人工确认）。
- **残余 U（出站媒体）**：大媒体（>100B）、其它 `media_type`、**上传失败/重试语义**、caption 单独发是否实际可用。

### `client_id` 去重语义（**人工确认**，契约级）

- **服务端按 `client_id` 去重：相同 id 双发只投递 1 条。** 证据：第四轮固定 `client_id` 连发 2 次同文（13:23:09Z / 13:23:13Z，均 200 / `ret=0`），**用户手机只收到 1 条**。证据级 = **B + 人工确认**（`plans/0925_wechat_media_probe_results.md` §11.5 判定表 #1）——这是 **W3a E-2 遗留问题的最终答案**，本页 Open Questions ⑤ 由此关闭。
- **推论（广播/回复的硬约束）**：**广播给多收件人时必须 per-recipient clientId** —— 若复用同一 id，不同收件人会因服务端按 id 去重而**互相吞掉**（部分收件人收不到）。
- **既有实现因此被真机验证为「必要且正确」**：`deriveBroadcastClientId(roundId, toUserId)` = `sha256("wechat-broadcast-client:"+roundId+":"+toUserId)`（`extensions/channel-wechat/send.ts#L72-L74`）；命令回执 clientId 同纪律（`send.ts#L82`）。
- **边界（勿过度外推）**：去重发生在**投递层**——协议层两次调用都成功（`ret=0`），**不能**拿「第二次被拒」当去重信号；同 id 跨轮次/长时间窗是否仍只投一条**未穷尽测试** ⇒ 幂等键仍应 per-recipient 派生，不要依赖跨轮去重。

### 采集方法备忘：只读回放（B）

`getupdates` 的 `get_updates_buf` 是 proto `{内层 field1 = last-seen seq, …}/{会话标识}`；把内层 seq 回退后**服务端按该 seq 回放保留窗口历史消息**（单批 ≤20；空 buf → 0 条、无关 buf → `ret=-3` 拒绝）。探针 `listen --replay-seq N` 只发只读 `getupdates`、回放批忽略 seen 去重、**落盘游标只进不退**、不回写过期 `context_token`、与 worker 两套 buf 独立 —— 这是「无需用户重发即可重取历史附件样本」的可复用取证手段。

## W2 实现切片（**已落地** `168fed1`：微信私聊文本 → 当前 master owner）

**边界**：只做「判定 + 注入通路」；**界面开关属 W2b**（D17：开关必须界面可达）。

**开关**：`channels.wechat.input.enabled`（**缺省 false**）+ `allowFrom`（openid 数组，空 = 拒绝所有，fail-closed）。

**六条件按序短路**（`extensions/runtime-host/wechat-input.ts`，daemon 进程内，**不经过 HTTP**）：① opt-in（false ⇒ 不读 registry/不建审计/不注入）② 发送者 openid 与 `allowFrom` **全等**（权限只由服务端白名单决定；昵称/正文/请求体不得决定权限）③ 仅私聊 ④ master 活着（**tick 级** `sessionAlive`，空闲也算活）⑤ generation 二次确认（变化即放弃）⑥ 单条一次批 + **脱敏审计**（`state/wechat-input-audit.jsonl` 0600：无正文/无 token/无完整 openid）。

**注入通路**：复用 GUI 窄路径同一条——`newOutboxItem` + `writeOutboxItem` → 目标会话自己的桥注入 followUp；**worker 永不成为 Pi 的写者**；**不改**既有 `session.message → master` 403 规则（这是新开的显式窄通道）。
**幂等键 = msgId**：成功后把 inbox 记录原子覆盖为 `state:"injected"`（**复用 store 的 `inboxFileName`**——L4 抓到重复实现导致非 BMP msgId 命名分歧 ⇒ 重复注入，故从根上共用同一函数）；写失败/结果不明 → 记录 `rejected` + 审计 `uncertain`，**不自动重试**。

**验收**：`npx tsx extensions/_test_wechat_input.ts` → 13 组断言全绿（T1 缺省零行为 / T2 denied 终态 / T3 注入成功 / T4 幂等 / **T5 非 BMP msgId** / T6 master-offline / T7 generation 变化 / T8 单条一次批 / T9 正文精确等值 `[微信 <脱敏id>] <原文>` / **T10 真实 `sessionAlive` 反向验证** / T11–T12 秘密卫生 / T13 写失败 uncertain）。

**L4 轨迹（三轮，每轮都有真发现）**：首轮 **FAIL**（MF1 非 BMP msgId 命名分歧→重复注入〔有实跑证据〕/ MF2 denied 无界重审 ~17k 行/天 / MF3 注入正文含不可信昵称 / MF4 `timersDir` 未透传致注入门**静默失效**）→ 修复轮（4 项代码全改对，但改坏测试且未写报告）→ 主会话重写测试 → 收敛 L4 **PASS**（并**反向复现旧缺陷**证明 T5 真能抓住该类缺陷）。

**已知残余（不得当成已解决）**：① ~~群消息无法独立识别~~——**stale，2026-09-24 修正**：parser 已按 `group_id` 非空直接 quarantine 群消息、不落 inbox（`extensions/channel-wechat/parser.ts#L134-L137`），群/私聊在 inbox 层即可独立识别（注入侧仍叠加 openid 白名单，D15 仅私聊双保险）② denied 记录**终态** ⇒ 事后加白名单**不补投**旧消息（运维取舍，如需补投要另做"重新评估 rejected"手段）③ 真网 7 项未测。

## 出站广播（已实现 `0a2b292`，L4 修复 `0337aac`）

**一句话**：`channels.wechat.reply.mode="broadcast"`（**缺省值**）下不再要求本轮由微信触发——global master 会话每轮 `agent_settled` 后，把该轮末条非空 assistant 原文发给**全部已知私聊**（一收件人一 intent）；`"reply-only"` = 完全回旧行为（marker 路径逐字节保留）。L4 独立复核 **PASS-with-fixes**（M1 必须修 + S1–S5 建议修已闭环 `0337aac`）。

### 配置面

- `channels.wechat.reply.enabled`：总开关，缺省 **true**（判定表达式未改）；false = 两模式全停（watcher 不消费、pending 保留）。出处：`extensions/runtime-host/wechat-bind.ts#L267`。
- `channels.wechat.reply.mode`：缺省 **`"broadcast"`**；`"reply-only"` = 旧 marker 路径；**mode 取值非法或配置文件整体坏 → fail-closed `"reply-only"`**（`enabled` 仍按红线 true）。出处：`extensions/runtime-host/wechat-bind.ts#L263-L278`。
- `channels.wechat.reply.sessionScope`：缺省 **`"owner"`**（合法值 `owner|main|any`，非法/坏文件 → `owner`）；`main` = `isMainSession()`（tab 拒，审计 `not-main-session`）；`any` = 仅 subagent 门。出处：`extensions/runtime-host/wechat-bind.ts#L271-L273`。
- **资格门（owner，fail-closed）**：只有 **global master 会话**广播——`readAttachment(masterAddress())?.sessionId === getCurrentSessionId()`；attachment 读不到 → 审计 `master-attachment-unavailable`、不匹配 → `not-master-owner`，两者均**丢弃暂存不广播**；且**本会话无暂存时资格门失败静默返回**（不落审计，防 audit jsonl 单向增长）。出处：`extensions/wechat-reply-hook.ts#L100-L105`。
- subagent 一律不广播（`isSubagent()` 门，`flushWechatBroadcast` 首门）。出处：`extensions/wechat-reply-hook.ts#L93`。

### 触发时机（`agent_end` 暂存 / `agent_settled` flush）

- `agent_end` = 一次低层 run 结束（重试/compaction/steering 后可继续），**只暂存不写意图**：mode=broadcast 时 `extractWechatReply` 走 broadcast 分支 → `stashWechatBroadcast`（每次覆盖 = 本轮最终态）；`agent_settled` = 权威终界，才 flush 出意图。出处：`extensions/wechat-reply-hook.ts#L146`、`#L163-L165`。
- flush 无暂存（如 Esc 中断路径未产生 `agent_end` 暂存）→ 审计 **`no-stash`**、零动作（`wechat-reply-hook.ts#L110`）；**`agent_settled` 的 Esc/中断触发面未真机实测**（见 Open Questions）。
- 暂存会话 ≠ 当前 settled 会话 → 丢弃 + 审计 `stash-session-mismatch`（防 tab 先暂存、master 后 settled 时张冠李戴）：`wechat-reply-hook.ts#L114-L117`。
- mode 已翻回 `reply-only` / `enabled=false` → flush **丢弃暂存静默返回**（零 reply 侧副作用）：`wechat-reply-hook.ts#L96`。

### 收件人集合

- `WechatStore.knownChats()` = `readInbox(0)`（receivedAt 降序全量）→ 滤空 `fromId`、滤 `@im.bot` 域 → 按 `fromId` 去重**保序**（首见 = 最近入站优先）。出处：`extensions/channel-wechat/store.ts#L349-L358`。
- **群消息天然不进 inbox**：parser 对 `group_id` 非空直接 quarantine（不落 inbox）⇒「已知 chat」只有私聊，广播侧无需再判别。出处：`extensions/channel-wechat/parser.ts#L134-L137`。
- 集合在 flush 时刻现算并由本轮 intent 文件冻结（轮内快照）：中途新入站的 chat **下一轮**才开始收；空集合 → 审计 `no-known-chats`、零 intent（`wechat-reply-hook.ts#L121-L122`）。

### 内容

- 该轮**末条非空 assistant 原文**（倒序扫描 `lastNonEmptyAssistantText`），`>4000` → `slice(0,4000)+"…[截断]"`（暂存时即截断）；全空 → 审计 `no-text`、零 intent。出处：`extensions/wechat-reply-hook.ts#L39-L41`、`#L72-L73`、`#L118`。

### 身份派生（幂等与排队）

- roundId = `sha256(`${sessionId}:${firstUserTs ?? "no-ts"}:sha256(firstUserText)}`)`——同会话同首问同时间戳 → 同 roundId。出处：`extensions/wechat-reply-hook.ts#L61-L64`。
- **intent id** = `sha256("wechat-broadcast:"+roundId+":"+fromId)`；**一个 intent 一收件人**（`kind:"broadcast"` 字段，旧文件无 `kind` 按 reply 兼容——`valid()` 放宽）。出处：`extensions/runtime/wechat-reply.ts#L24-L27`、`#L31`、`extensions/wechat-reply-hook.ts#L125-L132`。
- **per-recipient clientId** = `sha256("wechat-broadcast-client:"+roundId+":"+toUserId)`——**服务端 `client_id` 去重语义已人工确认（B + 人工确认）：同 id 双发只投 1 条**（见「`client_id` 去重语义」节）⇒ 跨收件人复用同一 id **必然**造成按 id 全局去重丢件，**per-recipient 是硬要求**，独立 id 同时成为 per-recipient 幂等键。出处：`extensions/channel-wechat/send.ts#L72-L74`。
- **同轮幂等**：重复 flush → 同 id → `linkSync` EEXIST → 不重写不重发；**不同轮不覆盖**：不同 roundId → 不同文件，`listReplyIntents` 按 `createdAt` 升序排队串行消费。出处：`extensions/runtime/wechat-reply.ts#L41`、`extensions/wechat-reply-hook.ts#L127`。

### 发送三门（watcher 侧，顺序即契约；reply intent 三门全不受约束）

每 tick（5s + fs.watch debounce 200ms）消费 pending，门序（`extensions/runtime-host/wechat-reply.ts#L33-L70`）：

1. **mode 门（最前）**：`kind==="broadcast" && cfg.mode !== "broadcast"` → **整轮跳过**——保留 pending、**零审计**（与 enabled=false 同形态；TTL 窗口照走，翻回 broadcast 后过期即 failed、未过期续发）。出处：`#L43`（L4 M1 必须修）。其后是新旧共用的一次机会规则：`attempts>=1` → `unknown(attempts-exhausted)`（`#L45-L49`）。
2. **TTL 门（先于 connected）**：`BROADCAST_INTENT_TTL_MS = 10min`（常量，不可配）超期 → `failed(broadcast-expired)`；`createdAt` **不可解析**（`Date.parse`→NaN）同样判过期（fail-closed 防倾泻方向）。出处：`#L13`、`#L50-L57`。
3. **connected 门**：`new WechatStore(WechatStore.resolveDir(runtimeDir)).readState().status !== "connected"` → 审计 `channel-not-connected`，**保留 pending 排队顺延**（转 connected 即续发，不 mark failed、不丢）；每轮现读新实例（readState 有实例内缓存）。出处：`#L58-L61`。

三门全过 → 缺 credentials 跳过（`no-credentials` 保留 pending）→ `attempts` 先落盘再发 → `sent`/`failed`/`unknown` 回写 + 脱敏审计。**失败语义 per-recipient**：每收件人一次机会、不自动重试（`failed`/`unknown` 终态），A `sent` / B `failed` 互不连坐。出处：`#L64-L77`。

### 回滚

- **`reply.mode="reply-only"`**（首选，秒级）：hook 立即弃暂存走 marker 路径；watcher 对残留 pending 广播 intent **整轮跳过（不发、不丢）**——翻回 broadcast 后过期即 failed、未过期续发（L4 M1 修复后的口径）。
- **`reply.enabled=false`**：全停（watcher 不消费任何 intent，pending 保留，恢复后续发）。
- CLI/端点：`/wechat reply mode broadcast|reply-only`（`extensions/index.ts#L2053-L2058`）；`/wechat status` 显示行含 `mode=`/`scope=`（`extensions/index.ts#L2084`）；`GET /v1/wechat/reply/status` 响应含 `mode`（`extensions/runtime-host/server.ts#L928`）。

### 已知近似 / 残余（诚实清单，不得当成已解决）

- **`receive/state.json.status` 是接收 worker 健康，不是发送能力**：发送只依赖 `credentials.json`，两者解耦 ⇒ worker 死但 token 有效时会保守地**不出站**（反向：token 失效但 status=connected → 发送 failed(auth)）。用 status 判出站是近似。
- `receive.enabled=false` → status 恒 `disconnected` → 广播永不出站（此时 inbox 也空、无收件人，两门自然一致）。
- **升级即行为变化**：存量配置无 `mode` 键 → 缺省 broadcast + owner，部署后 master 下一次 settled 即向全部已知 chat 群发；要灰度须先手工钉 `reply-only`。
- roundId 退化：首问无 timestamp 且同会话首问原文完全相同 → 两轮 roundId 相同 → 第二轮被同轮幂等**吞掉**（吞而不覆盖：丢件、不串内容）。
- 部分广播窗口：hook 循环写 N 个 intent 非单事务，进程死在中间 → 本轮部分收件人收到、部分没收到（下轮恢复全量）。
- 发信量放大：每 settled 轮 × N 收件人串行发；断连期每 pending 每 tick 落一行 `channel-not-connected`（≈12 行/min，被 TTL 10min 封顶）；audit 无轮转、读端只 `slice(-500)`。服务端 429/限流未实测（Open Questions ⑥）。
- TTL 10min 为常量不可配（用户裁定④）：断连 >10min 的积压轮整轮作废（failed 不重试）。

### 验收

- `npx tsx extensions/_test_wechat_broadcast.ts` → **18 组断言块全绿**（含 M1 回滚止发、S5 的 TTL 先于 connected 门序 + 真实 `readAttachment(masterAddress())` 缺省路径 + `currentSid=undefined`）；`_test_wechat_reply.ts` **22 组旧路径红线原样通过**；回归 `_test_message_outbox`/`_test_outbox_latency`/`_test_wechat_bind`/`_test_runtime_host_server` 全绿。L4 报告：本地 `plans/0924_wechat_broadcast_l4_review.md`（PASS-with-fixes，M1 + S1–S5 已闭环 `0337aac`）。

## 远程斜杠命令（已实现 `488e942`，L4 修复 `ebb9e04`）

**一句话**：微信私聊里的 `/xxx` 在 host 侧 `wechat-input` 写 outbox **之前**被会话消费端拿下（inbox 记录 → `state:"consumed"`）——**零 LLM、零 `sendUserMessage(用户原文)`、零 outbox 项、零转写污染**；回执 = `kind:"command"` 的 reply intent，由既有 watcher 发出。L4 独立复核 PASS-with-fixes（M1 归一化 + M2 注入点 fail-closed + S1–S6 已闭环 `ebb9e04`）。

### 旁路机制与执行顺序

- **消费端** `scanWechatRemoteCommands`（`extensions/wechat-command-consumer.ts#L250`）门序 = ① 能力门（`#L257`）→ ② 会话门：subagent 恒拒（`#L262`）、仅 **global master owner 会话**（`readAttachment(masterAddress()).sessionId === getCurrentSessionId()`，`#L266`）→ ③ 轴一 openid 白名单（`#L292`）→ ④ 分类 → ⑤ 标终态 `consumed`（`#L305`）→ ⑥ `wcmd:` claim（`#L309`）→ ⑦ 执行/拒绝 → ⑧ 写回执 intent（`#L342`）→ ⑨ 脱敏审计 → ⑩ `defer()`（`#L372`）。任何异常内部吞掉，消费端永不抛。
- **形态与节拍**：`session_start` 起 **fs.watch 立即扫描（无 debounce）** + 启动即扫 + 5s tick 兜底（`registerWechatRemoteCommands`，`#L494`；接线 `extensions/index.ts#L1868`）；host 侧注入器的 fs.watch 有 **200ms debounce**（`wechat-input.ts::startWechatInput`）⇒ 正常路径先于 host 拿下记录。**残余竞态不再靠抢跑**（见下「注入点双防护」）。
- **回执**：intent id `sha256("wechat-command:"+msgId)`（`extensions/runtime/wechat-reply.ts#L34`）、clientId `sha256("wechat-command-client:"+msgId+":"+toUserId)`（`extensions/channel-wechat/send.ts#L82`），`outboxId = intent id`（同 msgId 重写被 `linkSync` EEXIST 挡住）。watcher 三门（mode/TTL/connected）只对 `kind==="broadcast"` 生效 ⇒ command 与 reply 同待遇；另**豁免 `reply.enabled` 门**（S2：`extensions/runtime-host/wechat-reply.ts#L36`、`#L44`——否则远程 `/wechat reply off` 会吞掉自身回执），reply/broadcast 的门零改动。
- **终态第三值**：`InboundRecord.state` 增 `"consumed"` 且读回透传（`extensions/channel-wechat/store.ts#L57`、`#L332`；**透传是承重改动**——不透传会被映回 `pending` → 注入路重复拿到）。`consumed` 记录不带 `outboxId`、不满足 `wechat-reply-hook` 的 `state==="injected"` 门 ⇒ **回执不可能被当成 marker 轮回执**。
- **防环**：命令轮不产生 turn ⇒ 无 `agent_end`/`agent_settled` ⇒ 无广播暂存（`flushWechatBroadcast → no-stash`）。
- **执行面**：配置类（`/wechat …`）直连 `wechat-bind` 同步写盘、如实回报 ok/error；会话类（`/reload` `/compact` `/model` `/thinking`）经 `pi.sendUserMessage("/wechat-remote-run …", {expandPromptTemplates:true})` 走 pi 正规扩展命令派发拿 `ExtensionCommandContext.reload()/compact()`（`defaultRemoteCommandDeps`，`#L404`；内部命令注册 `#L504`）。**S3**：内部命令未注册 → dispatch **no-op**（不把内部命令文本跌落成普通 user 消息）。**S4 运行时依赖**：`expandPromptTemplates` 需**运行时 pi ≥ 0.87**——仓库 devDep 的 pi 0.80.6 硬编码 `expandPromptTemplates:false`（`.d.ts` 无该属性），低于版本会把内部命令文本当字面 prompt 注入；已写入 `README.md` §2「Runtime requirement」。
- **审计（独立文件）**：`state/wechat-command-audit.jsonl`（0600），行含 `decision=command-accepted|command-denied|command-failed` + `tier` + `reason`，**只记首 token**（`auditCmdToken`，参数不落盘）+ 掩码 msgId/openid；诊断面 `GET /v1/wechat/quarantine` 响应带 `commandAuditLines` 行数（`extensions/runtime-host/server.ts#L1082-L1084`，S6）。

### 注入点双防护（M2 必须修后）

- `wechat-input.ts::tryInjectPending` 在能力开启（`readWechatRemoteCommandConfig(configPath).enabled===true`）时**先 classify**（`extensions/runtime-host/wechat-input.ts#L39`）：`kind !== "not-command"` 的记录**按序跳过**（不选它、继续找下一条，避免一条滞留命令饿死其后的普通文本）；全部被跳过时 → `return {injected:false, reason:"command-shaped"}` + 输入审计 `skipped/command-shaped`（`#L50-L51`），**不改终态、不写 outbox**，留待消费端下一轮拿下。
- 结构性 fail-closed：裁定③「未知 `/xxx` 绝不回落成文本注入」不再依赖「消费端比 host 快 200ms」——冷启动 5s tick 窗口、会话门失败（`not-owner`/`subagent`）、dedupe 重投窗口下，**即使消费端不在线，命令也不会被当普通文本注入**。
- 轴一 not-allowlisted 判定位置保持今天口径（全被跳过时对**首条** pending 记录判白名单：未授权 → 既有 `not-allowlisted` rejected 终态 + 审计；授权 → `command-shaped`）。
- 普通文本不受影响：`gate=false`（能力关）时逐字节今天行为；能力开时 `not-command` 记录照旧注入。

### 归一化与绕过矩阵（M1 必须修后）

**入口先归一化**（`normalizeForClassify`，`extensions/runtime/wechat-remote-command.ts#L118`，**只作用于分类副本**，不改写入库正文/回执展示）：① **NFKC 兼容分解**（全角 `／`→`/`、全角字母数字 `ｒｅｌｏａｄ`→ASCII、全角空格→半角；顺带 `！`→`!`、`；`→`;`，与既有 ASCII danger 口径一致，不新增判定面）→ ② **剔不可见字符**（ZWSP/ZWNJ/ZWJ/双向控制符/word joiner/BOM/软连字符，整串，含中缀插入）→ ③ **trimStart**（`SHELL_LIKE` `#L80` 与首 token 正则 `#L86` 都锚定第 0 列）。

**判定分界**（归一化后）：`/` 单斜杠或斜杠后带空白（`/`、`/ ok`）→ `not-command`（聊天分隔符，L3 行为）；两段路径（`PATH_LIKE_RE` `#L92`，`/etc/passwd`、`/tmp/f.txt`）→ `not-command`；**其余以 `/` 开头却解析不出命令名**（`//x` `/_x` `/1x` `/-x` `/reload/`）→ **显式 deny(unknown)**，绝不落 `not-command`；不以 `/` 且不以 shell 运算符开头 → 散文/URL `not-command`。

**15 条绕过形态全挡**（`_test_wechat_remote_command.ts` BYPASS_MATRIX，T14 分类 / T15 端到端 / T16 注入门，实测）：

| 形态 | 例 | 分类（修后） |
|---|---|---|
| 前导空白 + 命令 | ` /nonexistent-cmd …`、`\t/x`、`\n/x`、`\r\n/reload` | deny/unknown 或 exec（归一后落第 0 列） |
| 前导空白 + shell | ` !rm -rf /`、` ; id`、`\n!rm …` | deny/**danger** |
| 首字符非 `[A-Za-z]` | `//reload`、`/_internal`、`/1cmd …`、`/-x` | deny/unknown |
| 全角斜杠/字母 | `／reload`、`/ｒｅｌｏａｄ` | exec/sensitive |
| 零宽字符插入 | `/​reload`（ZWSP） | exec/sensitive |
| 尾斜杠 | `/reload/` | deny/unknown |

- **15/15 `kind !== "not-command"`**；端到端 **15/15 → `consumed`、零 outbox、零用户原文 `sendUserMessage`**（exec 类的 `send=1` 只可能是内部命令 `/wechat-remote-run …`）；**M2 注入门下**（消费端会话门失败）连跑 3 轮 15/15 `injected=false reason=command-shaped`、state 仍 `pending`。
- **8 条正常文本零误伤**（仍 `not-command`）：`hello 世界`、`/etc/passwd`、`/`、`/ ok`、`/tmp/f.txt`、`https://example.com/x`、`我明天 /食堂见`、`今天​很好`。
- **误伤面（如实）**：以全角 `！`/`；` 开头的正常中文散文被判 danger 恒拒（与半角 `!`/`;` 同待遇，回执告知、不静默丢）；形如 `/tmp file.txt` 的首 token 命中命令形态 → `Unknown command` 拒而非注入（Hermes 同款取舍「去掉前导斜杠重发」）。

### 分级白名单（裁定①②③，`classifyRemoteCommand` `#L227`）

| 档 | 命令 | 说明 |
|---|---|---|
| **safe** | `/wechat status`（或 `/wechat`）、`/wechat reply mode broadcast\|reply-only`、`/wechat reply on\|off` | 只读或仅改出站偏好，免确认 |
| **sensitive** | `/reload`、`/compact`、`/model <id>`（`MODEL_ID_RE` 校验）、`/thinking off\|minimal\|low\|medium\|high\|xhigh`（枚举）、`/wechat on\|off` | **免确认直接执行**（用户裁定②，无 nonce/确认弹窗），审计保留 `tier=sensitive` |
| **danger（恒拒）** | shell 形态 `!` `;` `\|` `&` `$(` 反引号开头；`master-*` 前缀；`DANGER_EXACT`（`new/fork/clone/resume/quit/login/logout/trust/export/import/share/yolo/approve/deny/rm/sh/bash/exec/shell/sudo`）；**任何含 `:` 的名**（skill/prompt 模板展开面，**永不展开**） | 回执原文「**该命令不支持远程执行**」（`REMOTE_COMMAND_DANGER_TEXT`） |
| **usage 拒** | 白名单命令但参数非法（`/reload now`、`/wechat reply mode foo`、`/model a;id`、`/thinking HIGH`） | 第三种文案 `用法：…`；仍属显式拒绝，绝不回落正文 |
| **unknown** | 白名单外 `/xxx` | 回执 ``Unknown command `/xxx`…``（对齐 Hermes），**零 `sendUserMessage`、零 outbox** |

- **解析纪律**：只认首 token 精确匹配 `^/([A-Za-z][\w:.-]*)(\s|$)` + 参数枚举校验；命令名 lower-case 归一（`/RELOAD` → exec、`/EXPORT` → danger，大小写无逃逸）；**参数永不进 shell**（新文件 grep `child_process|execSync|spawn|exec(` 零命中）。
- **双轴授权（裁定⑥）**：轴一 = `channels.wechat.input.allowFrom` ∪ owner openid（**全等**比较，与 `wechat-input.ts` 同口径）；轴二 = 上表命令白名单。**会话门 = global master owner 会话**（= 注入路本会投递的目标会话），subagent 恒拒——避免 tab/subagent 抢执行。轴一未授权 → 消费端**不 claim**，交回注入路产生既有 `not-allowlisted` rejected 终态（今天行为不变）。

### 配置门（裁定⑤ fail-closed）

- `channels.wechat.remoteCommands.enabled === true` 才开（`extensions/runtime-host/wechat-bind.ts#L249-L257`）；缺段/坏 JSON/文件不存在/`enabled:"true"`/`enabled:1` → **false**。与 Hermes `slash_access.py` 的 fail-open（未配 admin 即全开）**刻意相反**。
- **关闭（= 缺省态）时行为精确回退今天**：消费端 `scan.reason="disabled"` 零 IO 零副作用、记录留 `pending`；注入器 `gate=false` 不做 classify，逐字节旧路径。
- **与 `input.enabled` 解耦**：能力门只看 `remoteCommands.enabled` + 轴一 allowFrom/owner——`input.enabled=false` 只关文本注入，不关命令通道。
- **无二次确认开关**（裁定②明确否掉 nonce 挑战）；白名单覆盖留代码表（改动需发版），配置面只有 `enabled` 一个键。

### 幂等与顺序

- 收据 = `runtime/receipts.ts` first-wins，键 **`wcmd:<sha256(msgId)>`**（`wcmdReceiptKey`；命名空间避开 `outbox:`/`run-`/`msg:`/`cmd:`）；claim 输家只收敛终态、不重复执行（重放实测 `alreadyClaimed=1`、副作用=1、回执=1）。
- 顺序 = **标终态 → claim → 执行 → 回执落盘 → `defer()`**（回执先落盘再 reload：`ctx.reload()` 后旧 ctx 即 stale）。
- intent id 确定性 + `linkSync` EEXIST ⇒ 同 msgId 不重写不重发；TOCTOU 复核（S1：`raw.state !== "pending"` 即让位，`#L302`）⇒ host 已写下 `injected` 时不覆盖、不双动作。

### 已知残余（诚实清单，不得当成已解决）

1. **崩溃反向窗口（S5）**：回执已落盘（措辞「已请求执行 …」）而 `defer()` 未跑 → 用户被告知已执行、实际没执行，且 `wcmd:` 收据已耗 → **永不重试**；实现选择不改写已落盘回执（改写同样有窗口）。
2. **崩溃正向窗口**：标终态/claim 后中断 → 该条命令**丢失不重放**（at-most-once：宁丢一条 `/reload` 也不重复执行敏感操作）。
3. **消费端不在线/会话门失败**时：M2 保证命令**不被注入**，但记录滞留 `pending`（命令未执行、无回执）直到消费端下一轮拿下；能力关闭时整条回退今天行为（文本注入）。
4. **未授权记录交回注入路** → 既有 `not-allowlisted` rejected 终态（事后加白名单不补投，与 W2 同口径）。
5. **命令审计在独立文件** `state/wechat-command-audit.jsonl`（与 `wechat-input-audit.jsonl` 分离）；诊断端只回行数 `commandAuditLines`，`consumed` 明细不在 quarantine 列表内；GUI 面未做——`remoteCommands.enabled` 无界面开关（D17 后续切片）、inbox 徽章对 `state:"consumed"` 渲染为字面 `consumed`。
6. **`/model <id>` 存在性校验只在本地**（registry 精确匹配），错误只在本机 `ctx.ui.notify` 可见；远程回执措辞保守「已请求执行 …」（研究 Q7-4 既定缓解）。**内部派发的真机会话行为未实跑**（只有静态依据 + fakePi 单测）。
7. **测试面既有问题（非本通道引入，L4 独立复核已确认）**：`_test_message_outbox` 双进程 CAS 断言偶发红（父提交 50 跑 2 次）、`_test_tui_progress` pre-existing 红。

### 验收

- `npx tsx extensions/_test_wechat_remote_command.ts` → **22 组断言块全绿**（含 BYPASS_MATRIX 15 条的 T14 分类/T15 端到端/T16 注入门、T17 冷启动、S1→T18、S2→T19、S3→T20）；回归 10/10：`_test_wechat_reply` 22 组 / `_test_wechat_broadcast` 18 组 / `_test_wechat_input` 14 组 / `input_set` / `message_outbox` / `outbox_latency` / `_test_wechat_receive` 7 组 / `_test_wechat_bind` 12 组 / `_test_runtime_host_server` / `check-extension-load`。
- **变异测试**：把 `classify` 还原成 `488e942` 版 → T14/T15/T16 FAIL；把 M2 `gate` 恒 false → T16/T17 FAIL（exit 1）——非恒绿假象。
- L4 报告：本地 `plans/0924_wechat_remote_command_l4_review.md`（PASS-with-fixes，M1+M2+S1–S6 已闭环 `ebb9e04`）。

## Evidence

- `scripts/wechat-ilink-probe.mjs`（commit `658306e`）— 头部用法注释与六命令实现。
- 本地 `plans/0923_wechat_ilink_probe_checklist.md` — 可执行清单与未知项测量对照表（①–⑦）。
- 本地 `plans/0923_ilink_channel_adapter_plan.md` §2.1–2.6（六个缺口规格）、§4（交付门）。
- 本地 `plans/0923_ilink_master_binding_delta.md` §B（投递模式决策表）、§F（回执不得谎称已执行）、§G（安全红线）。
- 决策依据见 [[审批门策略]]；本地 `plans/0923_decisions.md` D1②、D2、D4。
- 出站广播（commit `0a2b292`，L4 修复 `0337aac`）：`extensions/wechat-reply-hook.ts`（`stashWechatBroadcast`/`flushWechatBroadcast`/owner 资格门）、`extensions/runtime-host/wechat-reply.ts#L13-L61`（mode/TTL/connected 三门与顺序）、`extensions/runtime-host/wechat-bind.ts#L263-L278`（`{enabled, mode, sessionScope}` 与 fail-closed）、`extensions/runtime/wechat-reply.ts#L24-L27` + `extensions/channel-wechat/send.ts#L72-L74`（intent id / clientId 派生）、`extensions/channel-wechat/store.ts#L349-L358`（`knownChats()`）。
- 广播验收：`extensions/_test_wechat_broadcast.ts`（18 组断言块，修复后实跑全绿）；L4 复核 `plans/0924_wechat_broadcast_l4_review.md`（本地 gitignored）。
- 远程斜杠命令（commit `488e942`，L4 修复 `ebb9e04`）：`extensions/runtime/wechat-remote-command.ts`（`normalizeForClassify#L118`、`classifyRemoteCommand#L227`、`ENTRIES#L166`、`DANGER_EXACT#L130`）、`extensions/wechat-command-consumer.ts`（`scanWechatRemoteCommands#L250`、`registerWechatRemoteCommands#L494`、`defaultRemoteCommandDeps#L404`、`buildWechatStatusText#L170`）、`extensions/runtime-host/wechat-input.ts#L39-L51`（M2 注入点门）、`extensions/runtime-host/wechat-bind.ts#L249-L257`（能力门 fail-closed）、`extensions/channel-wechat/store.ts#L57`+`#L332`（`consumed` 终态与透传）、`extensions/runtime/wechat-reply.ts#L34` + `extensions/channel-wechat/send.ts#L82`（intent id / clientId 派生）、`extensions/runtime-host/wechat-reply.ts#L36`+`#L44`（command 豁免 `reply.enabled` 门）、`extensions/index.ts#L1868`（接线）、`README.md#L71`（运行时 pi ≥ 0.87）。
- 命令通道验收：`extensions/_test_wechat_remote_command.ts`（22 组断言块 + 15 条绕过矩阵，修复后实跑全绿）；L4 复核 `plans/0924_wechat_remote_command_l4_review.md`（本地 gitignored）。
- 入站媒体与附件规格（媒体探针三轮，commit `6a72b19` + `9f52a4a` + `d724f6a`，仅 `scripts/wechat-ilink-probe.mjs`）：`scripts/wechat-ilink-probe.mjs`（`isHostAllowed`/`CDN_SUFFIX_ALLOW#L141-L149`、key 候选链 `#L202`、解密与判优 `#L276-L303`、`extractAttachments` 按 `media.full_url`/`media.aes_key`、`--replay-seq#L700`、`upload-probe`/`media-probe`）；本地 `plans/0925_wechat_media_probe_results.md` §9/§10（B 级权威）+ `plans/0924_wechat_media_gateway_research.md` §0/§3.4（P1–P8 判读口径与 M1/M4 依赖）；脱敏测量 `plans/.wechat-probe/items.jsonl`（43 行签名，type 1/2/3/4 全覆盖）、`key-format.json`（6 样本 + `conclusion{decryptOk:"6/6", magicOk:"6/6"}`）、`measure.jsonl`（`kind=attachment_download` 带 `magic/sha256_8/keyScheme`）。
- 出站媒体规格 + `client_id` 去重语义（第四轮补测，commit `56e5088`，基线 `4f67753`；**B + 人工确认**）：本地 `plans/0925_wechat_media_probe_results.md` §11（发送时间线 / 三段实测 / 形状 A `ret=-2` 否证）与 **§11.5（用户人工确认：P3 收到 1 条 / P8 链接已收到 / P6 图已收到 / P2 「不太确定」）**、§11.8（Phase ③ 最终结论与残余 U 7 项）；脱敏测量 `plans/.wechat-probe/measure.jsonl`（`kind=media_probe` ×13、`kind=send_dedup` ×3 带 `textLen`/`clientIdReused`）；per-recipient clientId 派生 `extensions/channel-wechat/send.ts#L72-L74`。

## Links Out

- [[审批门策略]]
- [[Wiki 索引]]

## Backlinks

- [[Wiki 索引]]

## Open Questions

- 真网待测：①bot_token 失效/续期语义未测；②真机入站信封顶层无 `context_token`（至少 4 条实测），其过期语义不适用当前直发路径；③同 buf 重放已测（`--replay-seq` 只读回放，见「采集方法备忘」）；④空批推进游标已测；~~⑤相同 `client_id` 的服务端去重未定论~~ → **已定（人工确认）：同 id 双发只投 1 条**，见「`client_id` 去重语义」节；⑥并发 poll+send 限流/429 未测（读端点 3× 已测无 429）；⑦附件 **host 已测**（`novac2c.cdn.weixin.qq.com`，命中 `.qq.com` allowlist，6/6 hops=0），**单文件体积上限/长语音/大文件表现/下载耗时未测**。另：**出站文本长度——服务端 4001 字符 `ret=0` 接受（B），微信端是否截断未定（U，用户「不太确定」）**；**bot 回声**——第四轮窗口内未观测到（非穷尽）；**出站 URL 已渲染为链接形态（人工确认）**。
- 媒体（Phase ③ 残留 U 项，**第四轮 + 人工确认后已大幅收口**）：~~① P6-cdn / ② P6-send / ③ P2 长度 / ④ P3 去重 / ⑤ P8 URL 渲染与回声~~ **均已收口**（①② = 真机 B + 1×1 PNG 人工确认；③ = 服务端接受 B、**截断仍 U**；④ = **1 条 → 去重成立，人工确认**；⑤ = 链接形态人工确认、回声窗口内未观测到）；**⑩ 是否强制 `context_token`** → 出站 send 段已证**不需**（B）。**仍开的残余**：⑥ **P4-poll+send** 并发 429/`Retry-After`；⑦ **真机 302 实况**（6/6 hops=0，越域拒绝只有 stub 证据）；⑧ **附件体积上限 / 长语音 / 下载耗时 / probe 与 worker 双游标互抢**；⑨ **`type=5`（video）与群/小程序卡片 item 形状**；**新增：⑪ 大媒体（>100B）与其它 `media_type`；⑫ 上传失败/重试语义；⑬ 4001 字符截断与 URL 卡片缩略图形态**。
- 真机 `msgs[]` 消息条目形状已在 2026-09-24 校准，见「真机消息条目形状」节；不再列作未确认项。
- 出站广播待实测：① `agent_settled` 在 Esc/中断路径的触发面未真机实测（不触发 → 该轮不广播 + 一行 `no-stash`）；② 多收件人放量下的 429/限流未测（沿用真网待测⑥）；~~③ 服务端 `client_id` 去重语义仍未定论~~ → **已定（人工确认）：同 id 双发只投 1 条 ⇒ per-recipient clientId 是硬要求**，见「`client_id` 去重语义」节；④ 出站文本长度——4000 为本地预算，协议层 4001 已证被服务端接受（B），**微信端截断未定（U）**。
- 远程斜杠命令通道待实测/未决：① 真机会话内 `/wechat-remote-run` 派发（含 agent 忙时 defer 窗口）只有静态依据 + fakePi 单测，**未做真机会话验证**；② GUI 面未做——`remoteCommands.enabled` 界面开关（D17）与 inbox 对 `state:"consumed"` 的徽章渲染（当前显示字面 `consumed`）；③ 诊断面只给 `commandAuditLines` 行数，`consumed` 记录明细仍不可见（quarantine 列表只列 `rejected`）；④ 真机端到端被平台侧消息投递问题阻塞（见「判定实验」节）——通道目前只有本机断言与 fakePi 证据。
