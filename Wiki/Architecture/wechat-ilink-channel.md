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

## W2 实现切片（**已落地** `168fed1`：微信私聊文本 → 当前 master owner）

**边界**：只做「判定 + 注入通路」；**界面开关属 W2b**（D17：开关必须界面可达）。

**开关**：`channels.wechat.input.enabled`（**缺省 false**）+ `allowFrom`（openid 数组，空 = 拒绝所有，fail-closed）。

**六条件按序短路**（`extensions/runtime-host/wechat-input.ts`，daemon 进程内，**不经过 HTTP**）：① opt-in（false ⇒ 不读 registry/不建审计/不注入）② 发送者 openid 与 `allowFrom` **全等**（权限只由服务端白名单决定；昵称/正文/请求体不得决定权限）③ 仅私聊 ④ master 活着（**tick 级** `sessionAlive`，空闲也算活）⑤ generation 二次确认（变化即放弃）⑥ 单条一次批 + **脱敏审计**（`state/wechat-input-audit.jsonl` 0600：无正文/无 token/无完整 openid）。

**注入通路**：复用 GUI 窄路径同一条——`newOutboxItem` + `writeOutboxItem` → 目标会话自己的桥注入 followUp；**worker 永不成为 Pi 的写者**；**不改**既有 `session.message → master` 403 规则（这是新开的显式窄通道）。
**幂等键 = msgId**：成功后把 inbox 记录原子覆盖为 `state:"injected"`（**复用 store 的 `inboxFileName`**——L4 抓到重复实现导致非 BMP msgId 命名分歧 ⇒ 重复注入，故从根上共用同一函数）；写失败/结果不明 → 记录 `rejected` + 审计 `uncertain`，**不自动重试**。

**验收**：`npx tsx extensions/_test_wechat_input.ts` → 13 组断言全绿（T1 缺省零行为 / T2 denied 终态 / T3 注入成功 / T4 幂等 / **T5 非 BMP msgId** / T6 master-offline / T7 generation 变化 / T8 单条一次批 / T9 正文精确等值 `[微信 <脱敏id>] <原文>` / **T10 真实 `sessionAlive` 反向验证** / T11–T12 秘密卫生 / T13 写失败 uncertain）。

**L4 轨迹（三轮，每轮都有真发现）**：首轮 **FAIL**（MF1 非 BMP msgId 命名分歧→重复注入〔有实跑证据〕/ MF2 denied 无界重审 ~17k 行/天 / MF3 注入正文含不可信昵称 / MF4 `timersDir` 未透传致注入门**静默失效**）→ 修复轮（4 项代码全改对，但改坏测试且未写报告）→ 主会话重写测试 → 收敛 L4 **PASS**（并**反向复现旧缺陷**证明 T5 真能抓住该类缺陷）。

**已知残余（不得当成已解决）**：① 群消息无法独立识别（W1 记录不含会话类型；实际由 openid 白名单兜住）② denied 记录**终态** ⇒ 事后加白名单**不补投**旧消息（运维取舍，如需补投要另做"重新评估 rejected"手段）③ 真网 7 项未测。

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

- 真网待测（7 项，已测 1 项）：①bot_token 何时失效（**未测**）②context_token 过期行为（**未测**；真机消息形状未确认，该字段是否存在未知）③同 buf 是否重放（**未测**）④空批是否推进 buf —— **已测：会带新游标，可推进**（见上节）⑤固定 client_id 重发是否去重（**未测**）⑥同 token 并发 poll+send 是否限流（**未测**；注意同一 bot **只能一个长轮询**，多消费者会互相抢消息）⑦附件 URL 主机/大小限制（**未测**）。
- **真机消息条目形状仍未确认**（`msgs[]` 内每条结构）——已加脱敏形状签名机制：收到首条真实消息后从 quarantine 的 `shape=` 或 inbox 记录对齐，再回填本页。
