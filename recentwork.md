# Recent Work（时序面）

> 定位：任务进度与时间线。耐久知识看 `Wiki/_index.md`，任务草稿看本地 `plans/`（gitignored）。
> 条目倒序（新在前）。`Item NN` 是本仓任务编号，不指 GitHub issue。

## Maintenance Rules

- Task IDs are stable and never reused.
- Each task appears once.
- `Status` 是进度唯一真相源；Wiki 只记已验证的耐久事实。
- Commit hash 取自 `git log --oneline` 真实值。

## Active Tasks

### Task Index

| Item | Priority | Summary | Dependency | Next action |
|---|---|---|---|---|
| 51 | P1 | GUI 三项：会话标题可读（titleSource 契约 + 256KB 分块头扫 + `<file>`/`<system-reminder>` 附件块剥离；ledger 0→20、XML 噪音标题→可读/灰 shortId）+ 每组截断 6→3 + Web Console 输入失败诊断（零服务端痕迹 ⇒ 最可能 composer 未选会话禁用态） | msg_mungitzk_7kj5b7 | R1/R2 已实现 `c39c7a0`+`1eeb62d`+`40b3448`+`eef10cb`；R3 只诊断（建议：chatActiveId 持久化 + 8000 字节 vs 8000 字符对齐）；待重启 host 验线上 API |
| 50 | P1 | **M1 入站图片附件真机验收通过**（gate `channels.wechat.artifact.enabled=true` 免重启 ≤95s；落盘 46,499B / `FFD8FF` / 1200×2670；注入 `〔附件：<路径> (image/jpeg, 46499B)〕`；**⭐ 模型经内建 `read` 读出 `test-9f3a`**；实现 `6ae8e0d`+`972e29f`） | Item 48 | 残余转 M2/M3（artifacts 明文无 GC、IP 段复验、语音/文件入站） |
| 49 | P1 | 微信媒体探针第四轮出站补测 + **人工确认收口**（P6 出站发图 e2e / P3 `client_id` 去重=1 条 / P8 链接形态 / P2 截断仍 U；`56e5088`） | Item 48 | 残余 U 7 项（大媒体·其它 `media_type`、上传失败语义、长语音/体积上限、真机 302、P2 截断、回声/卡片、P4-poll+send）；可开 media gateway 实现 |
| 48 | P1 | 微信媒体探针 Phase ③ 收尾（入站 type 矩阵 + 嵌套形状 + `base64(hex32)` key + 解密/魔数 6/6 + P5 两段式；`6a72b19`+`9f52a4a`+`d724f6a`） | Item 5 | —（第四轮补测 + 人工确认已由 **Item 49** 收口） |
| 47 | P1 | local-master-ensure（主会话按 cwd 幂等确保他仓 local master 存活；双入口四层授权 + 零新增权力 + 七态；`0586030`+`f5a9b90`） | Item 13 | —（已完成 + 文档收尾） |
| 46 | P1 | 微信远程斜杠命令旁路（`/xxx` 进 LLM 前被消费端拿下 → `consumed`，分级白名单 + 归一化防绕过 + 注入点 fail-closed；`488e942`+`ebb9e04`） | Item 36 | —（已完成 + 文档收尾） |
| 45 | P1 | 微信出站广播（master 会话 → 全部已知私聊，`reply.mode` 缺省 broadcast；`0a2b292`+`0337aac`） | Item 36 | —（已完成 + 文档收尾） |
| 44 | P1 | G-B 收口：E2.3 单点翻转（`PI_AUTONOMY_FRONTIER_SOURCE`，缺省 v2 opt-in；`22e398a`+`f89abdb`） | Item 43 | —（**G-B 全部完成**） |
| 43 | P1 | E2.2 影子对照 harness（O-B schema，双硬门 `unexplained=0 且 explained=0`，623 行全 same，`de84baa`+`154bf8d`） | Item 42 | —（已完成） |
| 42 | P1 | E2.1 Graph→frontier 输入适配器 `toFrontierInput`（零接线，R4 单一口径，`b59ee68`+`513623c`） | Item 40 | —（已完成） |
| 41 | P0 | G-A：修 frontier ⑤ 的 GUI 分页耦合 latent bug（页外漏检 + 排名假边沿；P0 证据 `cd061cc`，修复 `93f8447`+`fae1aa2`） | none | —（已完成） |
| 40 | P1 | E2.0 Graph 载体对齐 + 共享 carrier 归约抽取（`7672771`+`ed5278a`+`c7b977a`） | Item 39 | —（已完成） |
| 39 | P1 | E1 Work Graph 只读关系面 MVP（四对象注册 + 引用式边 + diff，零接线影子，`d54c09b`+`97ef7e2`） | none | —（已完成） |
| 38 | P1 | wake round-trip 回信（wake/spawn prompt 带 deliverLetter RESULT 回原信 from，修法 A，`f299758`） | bug #4（`msg_muf5tqq8_8mbtg4`） | —（已完成） |
| 36 | P1 | 微信出站回复 W3a–W3d（已完成） | Item 34 | —（文档收尾完成） |
| 37 | P1 | local Master 自动交接（`master-transfer --local`，含安全级跨 scope token 修复，已实现 `b0ff266`） | none | —（已完成） |
| 35 | P1 | 热点层 v4 重做（短期工作集 projection，已实现 `8a9f09a`） | none | —（文档收尾完成） |
| 12 | P2 | global-view phase 2 探测深度增强（已完成） | none | —（已完成 `70c8aa3`） |
| 13 | P1 | Local Master 可得性修复（工具/命令可设 local；僵尸可显式接管） | none | 已完成 `5b56ecf`；待裁定自动回收兜底判据 |
| 14 | P1 | 微信扫码连接页 v1（绑定/解绑/状态，已实现 `8ee843d`） | none | 真网扫码测量 7 项 |
| 15 | P2 | 主动性套件 v1（纯函数层，已实现 `3922ef4`，未接线） | none | v2：接线到 master 工具/唤醒路径 + 审计落点 |
| 16 | P1 | GUI 三毛病修复（遮挡/markdown/不及时，已实现 `6d4ba67`） | none | 人工目视确认；markdown 渲染器补入库回归测试 |
| 17 | P2 | markdown 回归测试入库 + 围栏收紧（已实现 `911c397`） | none | —（已完成） |
| 18 | P1 | outbox 事件唤醒（延迟 5s→9ms/≤200ms，已实现 `e7475e3`） | none | mailbox-consumer 10s tick 是否同样事件化（需先解前置门复用） |
| 19 | P2 | set-timer target schema 恒拒修复（已实现） | none | —（已完成） |
| 20 | P3 | hotspot pending 队列误写仓库根 state/（待修） | none | 改路径推导至 agentDir；去掉临时 .gitignore 止血 |
| 21 | P1 | dead 僵尸/孤儿锁重建（修重启后 GUI 起不来，已实现 `e262eb8`） | none | L4 复核结论；坏锁不可解析仍 fail-closed |
| 22 | P1 | ComputerUse 立项：C0 探针通过（含 SetValue 抢焦点证伪）→ **C1 Broker 已完成** | none | C2 pi 工具 → C3 skill（C1 已入库 `0470527`） |
| 23 | P2 | 主动性套件 v2 接线（已实现 `1972aac`，无自动动作） | none | R5 审计轮转；enabled=true 语义裁定 |
| 24 | P1 | 微信页 opt-in UX 修复（已实现 `5bfd258`） | none | 补 TUI `/wechat on/off/status` |
| 26 | P1 | 远程输入中文 U+FFFD 乱码修复（严格 UTF-8 + GB18030 兜底，已实现 `88ba26a`） | none | —（已完成；根因是主会话诊断 curl 按 cp936 编码请求体） |
| 25 | P1 | 微信 iLink 接收 W1（长轮询 worker + 游标/去重/私有 inbox + GUI 可见，**已实现待提交**） | Item 14 | 提交 → 派 W2（注入 master，D15 六条件） |
| 34 | P0 | **微信端到端已打通**（真机消息正确解析并落 inbox；W2c owner 默认准入待 L4）+ 待办：热点层 v4 重做 | none | 见下「交接状态」 |
| 33 | P0 | **微信接收真正打通**：真机消息形状对齐（message_id 数字/from_user_id/text_item.text/group_id） | none | quarantine 在 GUI 可见（当前盲区） |
| 32 | P1 | autonomy 开关界面可达（D17）+ **前置修 R4**（ws-mail 到信成为 frontier 触发，已实现 `3d8409f`） | none | A4 `/wechat on|off|status`；audit 轮转（R5） |
| 31 | P1 | 修 daemon 弹终端窗口（spawn 形状 windowsHide:false → true，含 worker 连带修） | none | —（已完成） |
| 30 | P2 | `/runtime-host restart [--force]`（用户提出；已实现 `1743061`） | none | worker-only restart（可选，SKIP） |
| 29 | P1 | 微信输入 W2b：GUI 开关 + 白名单（hash id 可维护）+ 「为什么没进来」反馈（已实现 `18ba74d`） | Item 28 | 真机验证被**平台侧**阻塞（消息不进长轮询队列）→ 待用户核对推送/webhook 配置 |
| 28 | P1 | 微信输入 W2（私聊文本注入 master，D15 六条件，已实现 `168fed1`） | Item 25 | W2b：GUI 开关 + 白名单（从最近发送者一键添加）+ 「为什么没进来」反馈 |
| 27 | P3 | `_test_message_outbox.ts` 双进程 CAS 断言偶发失败（L4 实跑命中 1 次；主会话连跑 3 次均过） | none | 判性质：真竞态 vs 测试抖动；给该断言加确定化（重试/显式同步） |
| 11 | P2 | 仓库记忆层建立（双层记忆 + hotspot 修复，已完成） | none | —（已完成，无） |
| 10 | P1 | GUI 扫码连接微信切片（v1 绑定/解绑/状态，设计完成待实现） | Item 5 | 实现并验收，转 Wiki current |
| 5 | P1 | 微信 iLink 探针（七项未知项待真网测量） | none | 真网测量并回填 Wiki |
| 4 | P0 | runtime daemon 切片一（G0 完整 10/10 待实测） | none | 跑 G0 十轮 + 人工核对 |

### Item 50 - M1 入站图片附件：真机验收通过 + 文档收尾

- **日期**：2026-09-28
- **一句话**：M1（入站图片附件）在真机**完整验收通过**并完成文档收尾——**启用 `channels.wechat.artifact.enabled = true` 免重启生效（worker 每批读 gate，时延 ≤95s）**；用户从微信发图 → worker CDN 下载 → AES-128-ECB 解密 → 落盘 `artifacts/files/<sha256>.jpg`（**46,499 字节、魔数 `FFD8FF`、1200×2670**）→ 注入正文带 ` 〔附件：<绝对路径> (image/jpeg, 46499B)〕` → **⭐ 模型用 pi 内建 `read` 读该 jpg 并复述图中文字 `test-9f3a`**（astra 硬标准「只有路径进注入正文不算、下载成功也不算」⇒ **验收成立**）。
- **验收证据链（2026-09-28，权威）**：① gate = `true`（仓库根 `config.json`，`readWechatArtifactConfig` `=== true` 才开）；② 落盘 `~/.pi/agent/runtime/wechat/artifacts/files/18aac6b930d75f083…daad2.jpg`（46,499B / `FFD8FF E1` baseline / SOF 1200×2670 / 目录恰 1 文件）；③ inbox `7510263246191068000.bb23b816.json` = `text:""` + 相对 `artifactRef` + `state:injected`；④ outbox `172d8d19….json` 正文含 `〔附件：… (image/jpeg, 46499B)〕`（delivered）+ 审计 `accepted/injected` 09:04:54Z；⑤ **transcript 09:05:20Z：`read` 调用 `path=…/18aac6b9….jpg` → assistant 复述 `test-9f3a`**；⑥ 前置：`models.json` `mimo-v2.6-flash` `input:["text","image"]`（**纯文本模型下验收不成立**）；⑦ 操作要点：注入正文只有路径、无"读图"指令 ⇒ **需另发一条文本触发 `read`**。
- **涉及模块**：**本阶段零生产代码改动**；被固化的事实逐文件核对：`extensions/runtime-host/wechat-bind.ts#L270`（`readWechatArtifactConfig` fail-closed）、`extensions/channel-wechat/index.ts#L80-81`（每批 `readArtifactGate` + `artifactDir`）、`worker.ts#L179`（`gateOn`）、`artifact.ts`（`ARTIFACT_REL_BASE`/原子写/`sweepStaleTmp`）、`wechat-input.ts#L31/L42`（`ARTIFACT_REF_RE` 单一形状门 + `artifactSuffix`/`composeWechatBody`）、`server.ts#L1111`（投影形状门 L4-S4）。
- **产物**：`plans/0928_wechat_artifact_M1_wrapup_report.md`（收尾报告：Wiki 页/章节、条目号、验收证据链、残余、语音/文件移交要点）
- **Wiki**：`Wiki/Architecture/wechat-ilink-channel.md` 新增 **「入站图片附件 M1」** 章节（启用配置与免重启语义 / 落盘规格 / 注入正文形状 / 模型读图机制〔pi 内建 read + 多模态前置〕/ 真机验收证据表 / 已知边界）+ Summary、Current Contract、Evidence、Open Questions（M2/M3 残余）修订 + frontmatter `source_paths`/`updated`；`wiki-nav rebuild`
- **残余（M2/M3，均未做）**：M2 R1 artifacts 明文保留期限/容量/GC + 孤儿回收；R4 IP 段复验；R5/R6 CLI/GUI 开关与 quarantine 徽章；R8「只落盘不注入」子开关；U8 下载耗时/体积回采；**M3 语音（type=3）/文件（type=4）入站**（今天只进 quarantine 不下载；silk 非图片 ⇒ 模型 `read` 用不上，需转写机制）；已知边角：pi `read` 把渐进式 JPEG / 动画 PNG 读成乱码（pi 读侧行为）。
- **Priority**：P1
- **Status**：done（M1 全链路真机验收通过；L4 PASS/0 阻断，S3/S4 已修）
- **Commit**：实现 `6ae8e0d`（feat M1）+ `972e29f`（S3/S4）；本次文档收尾 commit 见 CHANGELOG 同 Item 行
- **Verification**：落盘文件属性/魔数/SOF 尺寸实测、inbox/outbox/审计三处正文逐字段比对、transcript 中 `read` 调用与 `test-9f3a` 复述、`models.json` `input` 含 `image` 均本机实查；纪律 = 只 `git add` Wiki/recentwork/CHANGELOG 三个具体文件（不碰生产代码、不碰 `scripts/boot-*`）。

### Item 49 - 微信媒体探针第四轮出站补测 + 人工确认收口（Phase ③ 最终定稿）

- **日期**：2026-09-25
- **一句话**：用户授权的第四轮出站补测（commit **`56e5088`**，探针观测面）跑完 **P6 / P2 / P3 / P8**，再由**用户逐条人工确认**收口——**Phase ③ 至此定稿：入站媒体（P1/P7）与出站媒体（P5/P6）规格均已真机定稿**。
- **四条最终判定（证据形态 = B + 人工确认，权威人工判定）**：① **P3 同 `client_id` 双发 → 手机只收到 1 条 ⇒ 服务端按 `client_id` 去重，同 id 双发只投 1 条**（W3a E-2 最终答案）；② **P8 URL →「链接收到了」⇒ 原样发出且被渲染为链接形态**（可点性因非真站不可验）；③ **P6 出站发图 → 1×1 纯色 PNG 已收到 ⇒ 端到端通过**；④ **P2 4001 字符 → 用户「不太确定」⇒ 半边结论保留：服务端 `ret=0` 接受（B）、微信端截断仍 U**。
- **契约级推论**：既然服务端按 `client_id` 去重，**广播给多收件人必须 per-recipient clientId**（否则不同收件人因同 id 互相去重吞件）⇒ 已实现的 `deriveBroadcastClientId(roundId, toUserId)`（`extensions/channel-wechat/send.ts#L72-L74`）**被真机验证为必要且正确**。
- **出站媒体规格（B，三段全通）**：`getuploadurl`（单键 `upload_full_url`）→ AES-128-ECB 密文 `POST` → `x-encrypted-param`(480B)=`encrypt_query_param` → `sendmessage` **`item_list` 只放媒体项**（**caption 必须单独发**，同条 = `ret=-2 invalid arguments`）、`media:{encrypt_query_param, aes_key:base64(hex32), encrypt_type:1}`、`mid_size`=密文字节、**不需 `context_token`**。
- **涉及模块**：探针 `scripts/wechat-ilink-probe.mjs`（`--to-last` 收件人反查、`textLen`/`errmsg` 落 measure、`@im.bot` 收件人防环；commit `56e5088`）；**生产代码零改动**。
- **产物**：`plans/0925_wechat_media_probe_results.md`（§11 第四轮 + **§11.5 人工确认结果** + §11.8 Phase ③ 最终结论）/ `plans/0925_wechat_media_probe_wrapup_report.md`（收尾报告，含规格移交清单）
- **Wiki**：`Wiki/Architecture/wechat-ilink-channel.md` 新增 **「出站媒体规格（第四轮 + 人工确认）」** 与 **「`client_id` 去重语义（人工确认）」** 两节，修订「出站 upload 端点」残余 U、出站协议契约、出站广播 per-recipient clientId、Open Questions（⑤③⑩ 等已定划除，新增⑪⑫⑬）、Summary、Evidence；`wiki-nav rebuild`
- **残余 U（7）**：P2 4001 截断 / 大文件·长语音体积上限与下载耗时 / 真机 302 / 大媒体·其它 `media_type` / 上传失败·重试语义 / 回声·卡片缩略图 / P4-poll+send 429（另：`type=5` 与群·小程序形状仍未采）。
- **Priority**：P1
- **Status**：done（Phase ③ 探针阶段全部收口；media gateway 实现依赖的 P1/P5/P6/P7 均已 B 级定稿）
- **Commit**：`56e5088`（第四轮探针观测面）；本次文档收尾 commit 见 CHANGELOG 同 Item 行
- **Verification**：`measure.jsonl` `kind=send_dedup{textLen:4001, ret:0}` ×3 + `kind=media_probe.stage=send messageIdPresent:true` 与报告 §11 时间线一致；四条人工判定原话已原文入档（§11.5）；纪律 = 零生产代码、零探针脚本改动，`git add` 只含 Wiki/recentwork/CHANGELOG 三个具体文件。

### Item 48 - 微信媒体探针 Phase ③ 收尾（入站媒体与附件规格真机定稿）

- **日期**：2026-09-25
- **一句话**：三轮真机探针把「入站媒体能不能收、怎么解密」从 C 级猜测变成 **B 级规格**——**item type 矩阵 `1`=文本(`text_item`)/`2`=图片(`image_item`)/`3`=语音(`voice_item`)/`4`=文件(`file_item`)，链接走文本无独立 type**；**附件 URL/key 在嵌套 `media.full_url`/`media.aes_key`**（顶层另有 `image_item.aeskey`），item 公共键 `create_time_ms/update_time_ms/is_completed/msg_id/button_item_list/at_bot_username_list`，信封 `{message_type, message_state, hasContextToken, hasGroupId}`；**key 格式 = `media.aes_key` 为 `base64(hex32)`（len44 → 32B hex 文本 → 16B）、顶层 `aeskey` 为 hex len32（派生同一把 key）**；**AES-128-ECB + PKCS7 真机 6/6 解密 + 6/6 魔数**（jpeg×2 / pdf×2 / silk×2 `0x02#!SILK_V3`）。**实测与官方指南（C 级）不符**：指南的平铺 `image_item:{file_id,url,aes_key}` 与「aes_key = 32hex 或 16B base64」均不成立（这是「指南不可信」的第二例）。
- **P5 出站硬门通过（B）**：`ilink/bot/getuploadurl` **存在**（200 + 单键 `upload_full_url`，816B 预签名 URL，host=`novac2c.cdn.weixin.qq.com` 命中 allowlist `.qq.com`；坏/无 token → -14、空 body → -2）；`ilink/bot/upload` **404 ⇒ 两段式**；OPTIONS 被当普通请求处理（不能用它判方法支持）。**CDN 密文 POST 与 `sendmessage` 带媒体 item 仍未测（U）** ⇒ M4 出站媒体在 P6 取证前不写生产代码。
- **CDN 边界（B）**：6/6 host 命中 allowlist、**hops=0**；探针下载 `redirect:"manual"` + 每跳复检（302 越域 stub 实测被拒）；**取证手段新增**：`listen --replay-seq N` 只读回放（buf 内层 seq 回退 → 服务端回放历史，游标只进不退），无需用户重发。
- **涉及模块**：`scripts/wechat-ilink-probe.mjs`（唯一入库文件；`extractAttachments` 按实测形状、key 候选链与解密判优、`CDN_SUFFIX_ALLOW`/`isHostAllowed`、`--replay-seq`、`upload-probe`/`media-probe` 同意门）；**生产代码零改动**（`extensions/**`、`runtime/graph/**`、各 wechat 生产文件一律未碰）。
- **产物**：`plans/0925_wechat_media_probe_results.md`（§0/§5/§9/§10 权威报告）/ `plans/0924_wechat_media_gateway_research.md`（§0 探针清单 / §3.4 设计 / §7 路线图）/ `plans/.wechat-probe/{items.jsonl, key-format.json, measure.jsonl, attachments/}`（本地 gitignored，key-format 已脱敏）/ `plans/0925_wechat_media_probe_wrapup_report.md`（L5 收尾）
- **Wiki**：`Wiki/Architecture/wechat-ilink-channel.md` **新增「入站媒体与附件规格（真机实测 2026-09-25，媒体探针 Phase ③）」**（type 矩阵 / 字段形状表 / AES key 格式与解密 / CDN allowlist 与下载纪律 / 出站 upload 端点 / 只读回放备忘）+ frontmatter `source_paths` + Evidence + Open Questions（残留 U 10 项）+ Summary 互链；`wiki-nav rebuild`
- **Priority**：P1
- **Status**：done（探针阶段完成；P6/P2/P3/P8 与体积上限类 U 项阻塞在「需用户同意/需用户重发」）
- **Commit**：`6a72b19`（探针 M0 实验子命令）+ `9f52a4a`（附件提取按真机实测形状 + 全类型签名 + 短跑）+ `d724f6a`（AES key 格式诊断 + 真机解密落盘 + `--replay-seq` 只读重放）；文档收尾 commit 见 CHANGELOG 同 Item 行
- **Verification**：`key-format.json` `conclusion{decryptOk:"6/6", magicOk:"6/6", winningSchemes:{"base64(hex32)":6}, magics:{jpeg:2,pdf:2,silk:2}}` 与报告 §10 交叉一致；`items.jsonl` 43 行覆盖 type 1/2/3/4 四类签名；stub 回归 35/35 PASS（key/URL/token 泄漏 grep 0）；纪律复核 = 零 `sendmessage`、零上传、零生产代码改动、`git add` 只含具体文档文件。

### Item 47 - local-master-ensure（主会话按 cwd 幂等确保他仓 local master 存活）

- **日期**：2026-09-25
- **一句话**：把「人手动去目标仓开 pi + `/master-attach --local`」变成主会话可调用的**幂等 ensure**——工具 `local-master-ensure` + 同名 slash `/local-master-ensure <cwd> [--no-wait] [--timeout <ms>]` 双入口，三段幂等（活 owner → `already-running` 零动作；`state/local-master-launch/<scope>.json` wx first-wins 防重 → 窗口内重调 `launched(in-flight)` 零第二个 spawn；spawn **可见 WT tab** 后按严格判据轮询）。**零新增权力（核心）**：生产代码零 `attachMaster`/`forceStale`/`token`/`cutover`/`detach` 调用、不写 attachment、不代替 attach；认领由新会话 `session_start` 既有静默路径（`silentScopeGenesis` / `takeoverStaleScopeOwner`）完成；bootstrap prompt 无 token、不指示 forceStale、负向禁碰 global。**四层授权合取**：① `isSubagent()` 首行硬挡 + `DEFAULT_EXCLUDE_TOOLS` 纵深 ② `localMasterEnsureGate`（复用 `masterDispatchGate`：main / global owner 放行，tab/not-owner/unknown 拒）③ 只收 `cwd`（不收 scope/地址）④ 描述带 `USER_DIRECTIVE`；**免二次确认（用户裁定）**。参数 `{cwd, waitForReady?=true, timeoutMs?=60000（上限 180000）}` → 七态 `already-running|launched|ready|spawn-failed|timeout|invalid-cwd|stalled`；就绪判据六条（liveness/attachment/同 sessionId/同 generation/pid 活/`launchAt < liveness.updatedAt`）+ #A claim 观测（generation 前进），**拿不到 liveness 如实 `stalled` 不猜**；审计 `state/local-master-ensure-audit.jsonl` 每次调用（含被拒）一行 `{at,by,cwd,scope,action,result}` 六字段无正文。
- **#A 消费循环注册语义（重要）**：注册点**唯一** = `mailbox-consumer.ts::registerScopeWakeLoop()`（`session_start` 处理块内 `setInterval(30s)`），全仓接线仅 `index.ts:1945`；**认领 ⟺ 注册**（同一 `session_start` 处理块内）；`triggerOwnershipRecheck()` 只补注册全局 watcher、**不**注册 scope 消费循环；**手动 `/master-attach --local` 不经过 `session_start` → 不注册消费循环**（L4 独立验证，限定：直到下一个 `session_start` 才补注册）——因此 ensure 的 `ready` 路径**必然注册**，也是「信躺着」（computer-use 死会话 mailbox 永远 pending）的机制解释。
- **涉及模块**：`extensions/runtime/local-master-launch.ts`（`ensureLocalMaster`/`parseLocalMasterEnsureArgs`/`judgeLocalMasterEnsureReady`/`buildLocalMasterBootstrapPrompt`/marker 与审计 IO，纯库无 Pi API）、`extensions/master-tools.ts`（工具注册 + `localMasterEnsureGate`）、`extensions/index.ts`（slash handler + `ensureLocalMasterTab` spawn 通道 + `registerScopeWakeLoop` 接线）、`extensions/runner-argv.ts`（`DEFAULT_EXCLUDE_TOOLS`）、`extensions/_test_local_master_launch.ts`、`package.json`（`test:local-master-ensure`）
- **产物**：`plans/0924_local_master_launch_recon.md`（L1）/ `plans/0924_local_master_launch_plan.md`（L2）/ `plans/0924_local_master_ensure_impl_report.md`（L3 + §7 L4 后修复）/ `plans/0924_local_master_ensure_l4_review.md`（L4 独立复核）（本地 gitignored）
- **Wiki**：**新建** `Wiki/Architecture/local-master-ensure.md`（能力语义 / 七态 / 就绪判据六条+claim 观测 / 零新增权力 / 四层授权 / in-flight / 审计 / spawn 形状 / **#A 消费循环注册语义含「手动 attach 不注册」** / 已知残余 / Evidence / Open Questions）+ `Wiki/Decisions/local-master-claim.md`（补「认领路径与消费循环注册的耦合」句 + 互链）+ `Wiki/Architecture/wake-roundtrip-ack.md`（互链）+ `Wiki/_index.md`（架构导航条目）
- **Priority**：P1
- **Status**：done
- **Commit**：`0586030`（feat：主会话按 cwd 幂等确保他仓 local master 存活，7 files）+ `f5a9b90`（fix：L4 必须修 M1 slash 参数解析纯函数 + 建议修 S1 fail-closed/S2 `windowEndsAt` 落盘/S3/S4/S5/S7，3 files）
- **Verification**：`_test_local_master_launch.ts` **23 组断言块全绿**（2026-09-25 文档轮复跑 exit=0，含 F3/F4、H claim 观测、J1/J2 #A、K 静态耦合、L 解析 4 例）；L4 独立复核 `PASS-with-fixes`（4/4 变异被捕获；M1 已修，S1–S5/S7 已闭环，S6 端到端真 spawn 手测留人工）；文档轮 `check_repo_wiki.py` OK（16 页）+ `wiki-nav rebuild`。

### Item 46 - 微信远程斜杠命令旁路（`/xxx` → `consumed`，分级白名单 + 防绕过 + fail-closed）

- **日期**：2026-09-25
- **一句话**：微信私聊里的 `/xxx` 在 host 侧 `wechat-input` 写 outbox **之前**被会话消费端拿下（inbox → `state:"consumed"`）——零 LLM、零 `sendUserMessage(用户原文)`、零 outbox、零转写污染；回执 = `kind:"command"` reply intent 由既有 watcher 发出（不产生 turn ⇒ 不进广播环路）。**归一化（M1）**：NFKC + 剔零宽 + trimStart 后再分类，归一化后以 `/` 开头却解析不出命令名（`//x` `/_x` `/1x` `/-x` `/reload/`）→ 显式 deny 不落 `not-command`，**15 条绕过形态全挡、8 条正常文本零误伤**。**注入点双防护（M2）**：`wechat-input.ts::tryInjectPending` 能力开启时先 classify，`kind!=="not-command"` → 按序跳过 → `reason:"command-shaped"`（不改终态、不写 outbox）→ 结构性 fail-closed，不靠消费端抢跑 200ms。**分级白名单**：safe（`/wechat status`、`/wechat reply mode|on|off`）｜sensitive（`/reload` `/compact` `/model <id>` `/thinking <lvl>` `/wechat on|off`）免确认直接执行｜danger 恒拒（shell 形态 / `master-*` / 会话销毁与凭据导出面 / 含 `:` 的名）→「该命令不支持远程执行」；未知 `/xxx` → ``Unknown command `/xxx`…``，零派发零 outbox。**配置门**：`channels.wechat.remoteCommands.enabled` 缺省 false（fail-closed），关闭时回退今天；双轴 = `allowFrom` ∪ owner openid × 命令白名单，会话门 = global master owner、subagent 恒拒；幂等 = `wcmd:<sha256(msgId)>` first-wins，顺序 标终态→claim→执行→回执→`defer()`。
- **涉及模块**：`extensions/runtime/wechat-remote-command.ts`（`normalizeForClassify`/`classifyRemoteCommand`/`ENTRIES`/`DANGER_EXACT`，纯函数零 IO）、`extensions/wechat-command-consumer.ts`（`scanWechatRemoteCommands`/`registerWechatRemoteCommands`/`defaultRemoteCommandDeps`/`buildWechatStatusText`/`wcmdReceiptKey`）、`extensions/runtime-host/wechat-input.ts`（M2 注入点门）、`extensions/runtime-host/wechat-bind.ts`（`readWechatRemoteCommandConfig` fail-closed）、`extensions/runtime-host/wechat-reply.ts`（S2 command 豁免 `reply.enabled` 门）、`extensions/channel-wechat/store.ts`（`consumed` 终态 + 读回透传）、`extensions/runtime/wechat-reply.ts` + `extensions/channel-wechat/send.ts`（intent id / clientId 派生）、`extensions/runtime-host/server.ts`（S6 `commandAuditLines`）、`extensions/index.ts`（接线 + `/wechat status` 抽公共函数）、`README.md`（S4 Runtime requirement）
- **产物**：`plans/0924_wechat_remote_slash_command_research.md` / `plans/0924_wechat_remote_command_impl_report.md`（含 §10 L4 后修复 + 绕过矩阵三张表）/ `plans/0924_wechat_remote_command_l4_review.md` / `plans/0924_wechat_remote_command_wrapup_report.md`（本地 gitignored）
- **Wiki**：更新 `Wiki/Architecture/wechat-ilink-channel.md`——新增「远程斜杠命令（已实现 488e942，L4 修复 ebb9e04）」节（旁路机制与执行顺序 / 注入点双防护 / 归一化与绕过矩阵 / 分级白名单 / 配置门 / 幂等 / 已知残余 / 验收）+ Summary 补指路 + Evidence 补代码位置与验收 + Open Questions 补通道待实测项 + frontmatter `updated`/`source_paths` 维护
- **Priority**：P1
- **Status**：done
- **Commit**：`488e942`（feat：旁路 + 白名单分级 + 未知命令显式拒绝，9 files）+ `ebb9e04`（fix：L4 必须修 M1 归一化防绕过 + M2 注入点 fail-closed + S1–S6，8 files）
- **Verification**：`_test_wechat_remote_command.ts` **22 组断言块全绿**（BYPASS_MATRIX 15 条 T14 分类 / T15 端到端零原文派发零 outbox / T16 注入门 ×3 轮 + T17 冷启动 + T18 S1 / T19 S2 / T20 S3）；回归 10/10（`_test_wechat_reply` 22 / `_test_wechat_broadcast` 18 / `_test_wechat_input` 14 / `input_set` / `message_outbox` / `outbox_latency` / `_test_wechat_receive` 7 / `_test_wechat_bind` 12 / `_test_runtime_host_server` / `check-extension-load`）；变异测试（还原 M1、关 M2 门）→ exit 1；L4 `plans/0924_wechat_remote_command_l4_review.md` **PASS-with-fixes**（2 必须修 M1/M2 + 6 建议修 S1–S6 全部采纳闭环）。

### Item 45 - 微信出站广播（master 会话 → 全部已知私聊，`reply.mode` 缺省 broadcast）

- **日期**：2026-09-24
- **一句话**：出站从「只回复微信触发轮」升级为**广播**——`channels.wechat.reply.mode` 缺省 `"broadcast"`；只有 **global master 会话**（`sessionScope` 缺省 `"owner"`：`readAttachment(masterAddress())?.sessionId === getCurrentSessionId()`，读不到/不匹配 fail-closed 不广播）在 `agent_settled`（`agent_end` 只暂存；Esc 中断无暂存 → 审计 `no-stash`）把该轮末条非空 assistant 原文（`>4000` 截断）发给 `WechatStore.knownChats()` 全部曾入站私聊（滤空/`@im.bot`、去重保序；群消息天然不进 inbox——parser `group_id` quarantine）。身份：intent id `sha256("wechat-broadcast:"+roundId+":"+fromId)`、per-recipient clientId `sha256("wechat-broadcast-client:"+roundId+":"+toUserId)`，一收件人一 intent（`kind:"broadcast"`），同轮 EEXIST 幂等、不同轮 `createdAt` 排队不覆盖。发送三门（watcher，顺序即契约）：mode 非 broadcast → 跳过（保留 pending、零审计）→ 共用一次机会 `attempts>=1`→`unknown` → TTL 10min（`BROADCAST_INTENT_TTL_MS`，createdAt 不可解析判过期）`failed(broadcast-expired)` **先于** connected 门（非 connected 保留 pending + 审计 `channel-not-connected`）；失败 per-recipient 一次机会不重试。回滚：`reply.mode="reply-only"`（秒级止发、pending 保留）或 `reply.enabled=false`（全停）。
- **涉及模块**：`extensions/wechat-reply-hook.ts`（暂存/flush/资格门）、`extensions/runtime-host/wechat-reply.ts`（mode/TTL/connected 三门 `#L43-L61`）、`extensions/runtime-host/wechat-bind.ts#L263-L278`（`{enabled,mode,sessionScope}` + fail-closed）、`extensions/runtime/wechat-reply.ts#L24-L27` + `extensions/channel-wechat/send.ts#L72-L74`（intent id/clientId 派生）、`extensions/channel-wechat/store.ts#L349-L358`（`knownChats()`）、`extensions/index.ts#L2053-L2084`（`/wechat reply mode` + status 行）、`extensions/runtime-host/server.ts#L928`（status 响应 `mode` 字段）
- **产物**：`plans/0924_wechat_broadcast_recon.md` / `plans/0924_wechat_broadcast_plan.md` / `plans/0924_wechat_broadcast_impl_report.md` / `plans/0924_wechat_broadcast_l4_review.md`（本地 gitignored）
- **Wiki**：更新 `Wiki/Architecture/wechat-ilink-channel.md`——新增「出站广播」节（资格门 / mode 配置 / 触发时机 / 收件人集合 / 内容 / 身份派生 / 发送三门与顺序 / TTL / 回滚 / 已知近似）+ 修正 stale 句「群消息无法独立识别」（已被 parser `group_id` quarantine 取代）+ Open Questions 补广播待测项 + Evidence/source_paths 补代码位置
- **Priority**：P1
- **Status**：done
- **Commit**：`0a2b292`（feat：出站广播，11 files）+ `0337aac`（fix：L4 必须修 M1 reply-only 回滚止发 + 建议修 S1–S5，4 files）
- **Verification**：`_test_wechat_broadcast.ts` **18 组断言块全绿**（含 M1 回滚止发 fetch=0、S5 的 TTL 先于 connected 门序 + 真实 `readAttachment(masterAddress())` 缺省路径 + `currentSid=undefined`）；`_test_wechat_reply.ts` **22 组旧路径红线原样**；`_test_message_outbox`/`_test_outbox_latency`/`_test_wechat_bind`/`_test_runtime_host_server` 回归全绿；L4 `plans/0924_wechat_broadcast_l4_review.md` **PASS-with-fixes**（1 必须修 + 5 建议修全部采纳闭环）。

### Item 44 - G-B 收口：E2.3 单点翻转（`PI_AUTONOMY_FRONTIER_SOURCE`，缺省 v2 opt-in）

- **日期**：2026-09-24
- **一句话**：E2.3 = G-B 最后一环——`autonomy/collect.ts` 的 frontier 数据源**单点二选一**：env `PI_AUTONOMY_FRONTIER_SOURCE.trim()==="graph"` 才走 Graph（`readGraphSnapshot`→`toFrontierInput`），**缺省/其它值（含 `""`/`"v2"`/`"graphx"`/`"GRAPH"`）= v2**（`collectGlobalView`）。**不写 `config.json`、不新增 opts、`graph/**`/`frontier.ts`/`protocol.ts`/`index.ts`/`package.json` 零改**；单 commit 可 revert；`frontier.json` 两版 schema 兼容（同一 `buildFrontier` 产物，不清 `prev`）。graph 路经 graph-only helper `graphFrontierSnapshot` 派生 `agentDir` 并**显式传 `tabRunsDir`/`sessionsRoot`/`timersDir`**（防 `PI_TAB_RUNS_DIR`/`defaultTabRunsDir()` 分叉）。L4 必须修（`f89abdb`）：v2 分支**保留原调用形状** `collectGlobalView({ agentDir: opts?.agentDir, now })`，`defaultAgentDir()` 仍归 `collectGlobalView` 自己的 `try` → 缺省生产行为与异常边界逐字节不变。**G-B 全部完成**（E2.1 适配器 + E2.2 影子双硬门 + E2.3 生产接线）。
- **涉及模块**：`extensions/runtime/autonomy/collect.ts`（单点翻转 `#L146-L148` + graph-only helper `#L111`）、`extensions/_test_graph_frontier_shadow.ts`（S18–S23）
- **产物**：`plans/0924_graph_E2_3_recon.md` / `plans/0924_graph_E2_3_impl_plan.md` / `plans/0924_graph_E2_3_l4_review.md` / `plans/0924_graph_E2_3_wrapup_report.md`
- **Wiki**：更新正式主题页 `Wiki/Architecture/work-graph-read-only-projection.md`（Current Contract 新增「E2.3 单点翻转契约」节：env-only 开关 / 缺省 v2 / 参数分叉防护 / v2 分支形状保持 / schema 兼容 / **G-B 完成**；Evidence 补 E2.3；source_paths 补 `collect.ts#L104-L124`/`#L142-L148` + shadow `#L800-L1000`；双 `findRepoRoot` Open Question 标闭合）
- **Priority**：P1
- **Status**：done
- **Commit**：`22e398a`（E2.3 单点翻转：env `PI_AUTONOMY_FRONTIER_SOURCE`，缺省 v2，显式三路径）+ `f89abdb`（L4 必须修：v2 分支保留原调用形状，`agentDir` 仅在 graph 分支派生）
- **Verification**：`_test_graph_frontier_shadow.ts` **28 checks，exit 0，`frames=33 rows=623 same=623 unexplained=0 explained=0`**（S18 缺省=v2 等价，含写出 `frontier.json` 原始文本 + watchdog/audit 可观测 / S19 graph 等价 + `runs` 序指纹 + 原始文本键序差异仅 `runId` vs `rankDetail` / S20 decoy `PI_TAB_RUNS_DIR` 防护 / S21a 非 graph 值=v2 / S21b enabled=false 零行为 / **S22 `agentDir` 未传：v2 源码形状 + 异常边界归 `collectGlobalView`** / **S23 graph flag `pidAlive=false` 的 `runStateMismatch` 端到端**）；`E22_REVERSE_SELFTEST=1` **29 checks**、`unexplained=1`（判别力有效）；**删 `tabRunsDir:` 行实验 → exit 1 / S19+S20+S23 FAIL**（漏传被有效捕获）；`_test_runtime_autonomy.ts` 57（A10.1 ALLOW 仍恰 3、A11.2 零新文件）/ `_test_graph_frontier_input.ts` 15/15 / `_test_frontier_attention_window.ts` 18 / `_test_runtime_graph.ts` 13/13 / `_test_graph_carriers.ts` 5/5（golden 未变）+ `test:global-view`/`test:runtime-projector`/`workstream`/`snapshot`/`tab-runs`/`runtime-wake`/`local-master` 全绿；L4 `plans/0924_graph_E2_3_l4_review.md` **PASS-with-fixes**（1 必须修 + 建议修已闭环）。

### Item 43 - E2.2 影子对照 harness（O-B schema，双硬门 `unexplained=0 且 explained=0`）

- **日期**：2026-09-24
- **一句话**：新增**测试态** `extensions/_test_graph_frontier_shadow.ts`——G-B 核心验收件：同一 fixture、同一 `(backlog, prev, now)` 下逐项对照 v2 生产路径（`collectGlobalView`→`buildFrontier`）与 graph 路径（`readGraphSnapshot`→`toFrontierInput`→`buildFrontier`），产 O-B 行（五源 snapshot/project/run/trigger/recordOnly）；**双硬门 `unexplained=0 且 explained=0`（`WHITELIST=[]` 空集）+ DoD-3 canonical 全等**。实测 `frames=33 rows=623 same=623 triggerRows=10 unexplained=0 explained=0`（21 checks，exit 0）→ **E2.3 翻转硬门证据**。**零生产接线、零行为**（只写临时 `state/work-graph/shadow.jsonl`）。L4 独立审查 **PASS-with-fixes**（1 必须修 + 3 建议修已闭环）；**篡改反向实验**证明非恒真假绿（graph-only attention 0 化 → exit 1 / `unexplained=15`）。
- **涉及模块**：`extensions/_test_graph_frontier_shadow.ts`（新，~810 行，S1–S17 + S-R 反向自检）、`extensions/_test_runtime_autonomy.ts`（A10.1 排除列表 +1 行，ALLOW 仍恰 3）
- **产物**：`plans/0924_graph_E2_2_recon.md` / `plans/0924_graph_E2_2_impl_plan.md` / `plans/0924_graph_E2_2_impl_report.md` / `plans/0924_graph_E2_2_l4_review.md` / `plans/0924_graph_E2_2_wrapup_report.md`
- **Wiki**：更新正式主题页 `Wiki/Architecture/work-graph-read-only-projection.md`（Current Contract 新增「E2.2 影子对照契约」节：O-B schema / 双硬门 / canonical 序 / E2.3 硬门证据 / 篡改反向实验 / 测试态零行为 + source_paths 补真实行号）
- **Priority**：P1
- **Status**：done
- **Commit**：`de84baa`（E2.2 影子对照 harness：O-B schema + 两路装配 + S1–S17 + 双硬门）+ `154bf8d`（L4 必须修/建议修：S8a 固定时钟 + trigger `groupByKey` 不折叠 + S16 输入分叉断言 + `E22_REVERSE_SELFTEST` 反向自检）
- **Verification**：`_test_graph_frontier_shadow.ts` **21 checks，exit 0，`frames=33 rows=623 same=623 triggerRows=10 unexplained=0 explained=0`**（双硬门 + 全 33 帧 `next`/`diff` canonical 全等）；**篡改反向实验 exit 1 / `unexplained=15 explained=0`**（graph-only attention 0 化被 O-B + canonical 捕获 → 非恒真假绿）；`E22_REVERSE_SELFTEST=1` 自检报 `unexplained=1`（判别力有效）；`_test_runtime_autonomy.ts` 57 checks（A10.1 ALLOW 仍恰 3）；`_test_graph_frontier_input.ts` 15/15；`_test_frontier_attention_window.ts` 18；`_test_runtime_graph.ts` 13/13；`_test_graph_carriers.ts` 5/5（golden 未变）；`test:global-view` + `test:runtime-projector`/`workstream`/`snapshot`/`tab-runs`/`runtime-wake`/`local-master` 全绿；L4 `plans/0924_graph_E2_2_l4_review.md` **PASS-with-fixes**（1 必须修 + 3 建议修已闭环）。

### Item 42 - E2.1 Graph → frontier 输入适配器（`toFrontierInput`，零接线）

- **日期**：2026-09-24
- **一句话**：新增**纯函数** `toFrontierInput(snap, {now})`（`extensions/runtime/graph/frontier-input.ts`）把 `GraphSnapshot` 投影为 `FrontierSourceSnapshot`，为 E2.2 影子对照冻结输入契约。要点：零 IO / 零墙钟 / 确定性；**R4 单一口径**（键直接取 `GraphProjectView.project`，`normalizeRepoKey` ≡ `normalizeExactPath` 逐字节同体，严禁第三份 normalizer）；`now` 取自 `opts.now`（不用 `snap.asof`）；`history` 恒 `[]`（MF1，填充会造出 v2 生产从不产的 ②③）；`attentionByRepo` 只写 >0 项（缺项=0，全量无裁剪）；**零生产接线**（只被测试调用，`extensions/index.ts`/`graph/index.ts` 未动）。`autonomy/frontier.ts` 仅类型放宽（`FrontierInputs.snapshot` 改结构化接口，`buildFrontier` 体零改）。L4 独立审查 **PASS-with-fixes**（2 必须修 + 3 建议修已闭环）。
- **涉及模块**：`extensions/runtime/graph/frontier-input.ts`（新，~76 行）、`extensions/runtime/autonomy/frontier.ts`（+类型放宽，算法体零改）、`extensions/_test_graph_frontier_input.ts`（新，T1–T15）、`extensions/_test_runtime_autonomy.ts`（A10.1 排除列表 +1 行）
- **产物**：`plans/0924_graph_E2_1_recon.md` / `plans/0924_graph_E2_1_impl_plan.md` / `plans/0924_graph_E2_1_impl_report.md` / `plans/0924_graph_E2_1_l4_review.md` / `plans/0924_graph_E2_1_wrapup_report.md`
- **Wiki**：更新正式主题页 `Wiki/Architecture/work-graph-read-only-projection.md`（Current Contract 新增「E2.1 契约：`toFrontierInput` 适配器」节 + Open Questions 的 `asof`/双 normalizer 条目闭合 + source_paths 补真实行号）
- **Priority**：P1
- **Status**：done
- **Commit**：`b59ee68`（E2.1 适配器，零接线，R4 单一口径 + attention 全量等价）+ `513623c`（L4 必须修/建议修：T9 固定时钟 + T8 零路径转换守卫扩白名单 + 重复 runId tie-break）
- **Verification**：`_test_graph_frontier_input.ts` **15/15**（T1–T15；T9 双路径结构等价：帧0 `JSON.stringify` 严格全等、帧1 canonical 全等且含非 mailbox 边沿 `working_to_completed`/`stagnation`/`needs_user`，端到端覆盖 `staleOver=true`/`needsHuman=true`/`pidAlive=false`）；`_test_runtime_autonomy.ts` 57 checks（A10.1 ALLOW 仍恰 3）；`_test_runtime_graph.ts` 13/13；`_test_graph_carriers.ts` 5/5（golden 未变）；`_test_frontier_attention_window.ts` 18；`test:global-view` + `test:runtime-projector`/`workstream`/`snapshot`/`tab-runs`/`runtime-wake`/`local-master` 全绿；`test:register-graph` 因外部依赖预备冲突失败（`CONFLICT @earendil-works/pi-coding-agent`，非断言失败），直跑 `_test_register_graph.ts` 通过；L4 `plans/0924_graph_E2_1_l4_review.md` **PASS-with-fixes**（2 必须修 + 3 建议修已闭环）。

### Item 41 - G-A：frontier ⑤ 语义修复（消费分页前全量 attention，修 GUI 分页耦合 latent bug）

- **日期**：2026-09-24
- **一句话**：修 frontier ⑤（`needs_user`）的 **latent bug**——⑤ 曾消费 `snapshot.home/rows`（GUI 分页后投影，生产 `page=1/pageSize=20`）→ >20 仓时页外 attention 仓**漏触发** `needs_user`（21 仓漏 1、40 仓漏 20），且仅改显示排名会产生**假边沿**（⑤ 触发集合成了显示排序/页码的函数）。修复 = `collectGlobalView` 暴露**分页前全量投影** `GlobalViewSnapshot.attentionByRepo`（必填、缺项=0、`Σ===totals.attention`），frontier ⑤ 直接消费；GUI 分页契约逐字节不变。P0 反例证据 `cd061cc`，生产修复 `93f8447`，L4 必须修/建议修补强 `fae1aa2`。
- **涉及模块**：`extensions/runtime/global-view.ts`（`GlobalViewSnapshot.attentionByRepo` 字段 + `#L539-L541` 切片前聚合 + 主/catch return）、`extensions/runtime/autonomy/frontier.ts`（`#L201`/`#L216` 改消费全量投影 + 缺项=0 注释）、`extensions/_test_frontier_attention_window.ts`（P0 十条翻转 + N1-N4 + M1/M2/M3 + K1 tripwire）、`extensions/_test_global_view.ts`（Σ 不变量三路径）、`extensions/_test_runtime_autonomy.ts`（`makeSnapshot`/A3.4 改新字段）、`extensions/_test_graph_carriers.ts`（T5 golden 加性新增一个键）
- **产物**：`plans/0924_attention_window_bug_evidence.md` / `plans/0924_attention_semantics_fix_recon.md` / `plans/0924_attention_semantics_fix_plan.md` / `plans/0924_attention_semantics_fix_impl_report.md` / `plans/0924_attention_semantics_fix_l4_review.md` / `plans/0924_attention_semantics_fix_wrapup_report.md`
- **Wiki**：更新正式主题页 `Wiki/Architecture/work-graph-read-only-projection.md`（Current Contract 新增「G-A：attention 载体语义修复」节 + Open Questions 的 attention 待办标为已修复 + source_paths 补真实行号）
- **Priority**：P0（bug 修复）
- **Status**：done
- **Commit**：`cd061cc`（P0 反例测试，断言 buggy 行为）+ `93f8447`（生产修复）+ `fae1aa2`（L4 必须修/建议修：M2 双向切换 + msv/Σ 不变量 + normalizer tripwire + 缺项=0 注释）
- **Verification**：P0 反例四档数字（19/20/21/40 仓：页外漏检 `0/0/1/20`、假边沿 `0/0/1/1`）→ 修复后全部归零（`_test_frontier_attention_window.ts` 18/18：P0 十条翻转 + N1-N4 + M1/M2/M3 + K1）；`test:global-view` M1 byte-identical + Σ 三路径；`_test_runtime_autonomy.ts` 57 checks（A10.1 ALLOW 仍恰 3）；`_test_graph_carriers.ts` 5/5（T5 golden 仅加性新增 `attentionByRepo` 一个键）；`_test_runtime_graph.ts` 13/13 + runtime-projector/workstream/snapshot/tab-runs/wake/local-master 全绿；L4 `plans/0924_attention_semantics_fix_l4_review.md` **PASS-with-fixes**（1 必须修 M2 已闭环）。

### Item 40 - E2.0 Graph 载体对齐 + 共享 carrier 归约抽取

- **日期**：2026-09-24
- **一句话**：把 frontier 消费的载体补齐到 Graph 只读投影，并把 carrier 归约抽成单一真相源——① `GraphRunRef` 增 `gate/needsHuman/staleOver/overdue/pidAlive`（缺→null 不猜）；② `GraphSnapshot.history` 仅观测载体（E2.1 恒 emit `[]`，不参与 frontier 输入）；③ `state/work-graph/<scope>.json` 只读缓存（唯一写者 `graph/collect.ts`，版本+子结构校验）；④ 抽 `frontier-carriers.ts`（`reduceTabCarrier`/`collectTimerByRepo`/`classifyDispatch`）为唯一真相源，`global-view.ts` 与 `graph/collect.ts` 共用。仍为影子运行（零生产接线）。L4 独立审查 **PASS**（0 必须修 / 5 建议修 / 5 遗漏）；L5 收尾落地 4 条 E2.1 前必修 + 文档收尾。
- **涉及模块**：`extensions/runtime/frontier-carriers.ts`（新，359 行）、`extensions/runtime/global-view.ts`（净删 288 行，re-export 保持导出面）、`extensions/runtime/graph/{types,project,collect}.ts`（+169/-26）、`extensions/_test_graph_carriers.ts`（新，含 legacy oracle 双跑 + 全量 golden）
- **产物**：`plans/0924_graph_E2_impl_plan.md` / `plans/0924_graph_E2_plan_review.md` / `plans/0924_graph_E2_recon.md` / `plans/0924_graph_E2_0_impl_report.md` / `plans/0924_graph_E2_0_l4_review.md` / `plans/0924_graph_E2_0_wrapup_report.md`
- **Wiki**：更新正式主题页 `Wiki/Architecture/work-graph-read-only-projection.md`（Current Contract 新增「E2.0 载体对齐与共享归约」节 + source_paths 补 `frontier-carriers.ts` 真实行号）
- **Priority**：P1
- **Status**：done
- **Commit**：`7672771`（抽 frontier-carriers 共享归约，行为保持）+ `ed5278a`（Graph 载体对齐 + 只读缓存）+ `c7b977a`（L4 建议修：缓存版本校验 + tmp 防冲突 + warning 序注释 + golden 入库）
- **Verification**：行为保持由 **pre/post golden 逐字节复现** + `_test_graph_carriers.ts` 5/5（legacy oracle 双跑 4 组 + 全量 golden 入库）证明；`_test_runtime_graph.ts` 13/13；`_test_runtime_autonomy.ts` 57 checks（A10.1 allowlist 仍恰好 3）；回归 6×npm（`test:global-view`/`runtime-projector`/`runtime-workstream`/`runtime-snapshot`/`tab-runs`/`runtime-wake` + `local-master`）全绿；L4 审查 PASS。

### Item 39 - E1 Work Graph 只读关系面 MVP（四对象注册 + 引用式边 + diff，零接线）

- **日期**：2026-09-24
- **一句话**：Work Graph 第一版（E1）落地为既有四对象（Master/Workstream/Task/Run）之上的**只读关系面**——journal + workstreams 显式库 + tab-runs 账本只读引用 → 纯投影 `projectGraph` + 引用式边（task→workstream / run→externalTaskId|subject / workstream→repoPath 弱载体）+ `diffGraph(since)`；边界裁定 (a)：是既有真相源的投影与求值器，**不替代** tab-runs 判态机 / recentwork；影子运行（零生产接线，单 commit 可 revert）。L4 独立审查 PASS（0 必须修 / 5 建议修）；L5 收尾落地建议修（去死参数、T13 恒等断言→手构快照、`isPathShapedRef` 补例）+ 文档收尾。
- **涉及模块**：`extensions/runtime/graph/{types,project,edges,diff,collect,index}.ts`（新增 7 文件）、`extensions/_test_runtime_graph.ts`（13 组）
- **产物**：`plans/0924_graph_E1_impl_plan.md` / `plans/0924_graph_E1_recon.md` / `plans/0924_graph_E1_l4_review.md` / `plans/0924_graph_E1_impl_report.md` / `plans/0924_graph_E1_wrapup_report.md`
- **Wiki**：新建正式主题页 `Wiki/Architecture/work-graph-read-only-projection.md`（`status: current`，只读关系面边界/契约/证据；`_index.md` 导航已收录）
- **Priority**：P1
- **Status**：done
- **Commit**：`d54c09b`（E1 MVP）+ `97ef7e2`（L4 建议修）
- **Verification**：`_test_runtime_graph.ts` 13/13 组绿（T9 10_000 事件 ~15ms / 预算 2000ms；含病态事件 Graph≡projector 等价断言）；回归 `test:runtime-projector` / `test:runtime-workstream` / `test:runtime-snapshot` / `test:tab-runs` 全绿 + `_test_runtime_autonomy.ts` 57 checks 绿；L4 审查 PASS。

### Item 38 - wake round-trip 回信（wake spawn prompt 带 deliverLetter RESULT 回信）

- **日期**：2026-09-24
- **一句话**：bug #4（ESCALATION `msg_muf5tqq8_8mbtg4`）——wake-spawn 链路没把「回信给来信者」翻译成 `deliverLetter`，回程只走 tab-report（派发者归属，wake 场景来信者收不到）→ 修法 A：`buildWakePrompt`/`buildScopeWakePrompt` 为每封「message 且 requiresAck」来信加回执行（回 kind=RESULT 到原信 `from`，inReplyTo=原信 messageId）+ 可执行 recipe（bash + 临时 .mjs 调 deliverLetter，file:// URL 动态 import）+ 硬规则（禁只依赖 tab-report；command 帧不回信）。
- **涉及模块**：`extensions/runtime/wake.ts`（`WakeLetter`+from/to/requiresAck、`MAILBOX_MODULE_URL`、`buildReplyRecipe`、`buildWakePrompt`、`describeLetter`）、`extensions/runtime/scope.ts`（同形）、`extensions/_test_runtime_wake.ts`、`extensions/_test_local_master.ts`
- **产物**：`plans/20260924_wake_roundtrip_reply_impl.md`
- **Wiki**：新建正式主题页 `Wiki/Architecture/wake-roundtrip-ack.md`（`status: current`，回信渠道事实：tab-report 派发者归属不可达来信者、回信走 deliverLetter、prompt 形状与 recipe 约束；`_index.md` 导航已收录）
- **Priority**：P1
- **Status**：done（`f299758`）
- **Commit**：`f299758`（基线 `ad72cd4`）
- **Verification**：recipe 本机实测跑通（隔离 `PI_RUNTIME_DIR`、未污染真实 mailbox；回执信 `kind=RESULT / inReplyTo=原信 messageId / to=agent://master_default`）；`test:runtime-wake` / `test:local-master` / `test:runtime-mailbox` / `test:mailbox-command-consume` 全绿 + `test:scope-stale-takeover` 绿；`_test_autonomy_wiring` W2.3 为基线既有（`git stash` 后复现，与本改动无关）。

### Item 37 - local Master 自动交接（`master-transfer --local`）

- **日期**：2026-09-24
- **一句话**：让仓库会话（持 local Master）也能自动交接——`master-transfer` 支持 `--local`（此前只面向 global，仓库会话调用被拒）；L4 首轮 **FAIL**（7 条 must-fix，含安全级跨 scope token 绕过）→ 修复轮全落地 → 窄 L4 确认 **PASS**。
- **涉及模块**：`extensions/runtime/{master-transfer,master-control,registry}.ts`、`extensions/master-tools.ts`、`extensions/index.ts`、`extensions/_test_local_master_transfer.ts`（新，~470 行 T1–T13）
- **产物**：`plans/0924_local_master_auto_transfer_{report,l4_review,fix_report,fix_l4_confirm}.md`
- **Priority**：P1
- **Status**：done
- **Commit**：`b0ff266`
- **Verification**：`npx tsx extensions/_test_local_master_transfer.ts` 13/13；`_test_runtime_master_transfer.ts`（global 既有）12/12；`npm run smoke:extension-load`、`_test_local_master`、`_test_master_home_guard`、`_test_runtime_commands`、`_test_register_graph`（本体直跑）、`gui tsc --noEmit` 全绿。
- **安全修（最关键）**：`registry.ts` token attach **一律不得走 genesis**（`!existing && input.token → bad-token`，零写）——修前 local token 可在空 global attachment 上认领 global owner。窄确认用自建对抗探针验四种跨 scope 组合（local→空global / global→空local / global→非空local / local→非空global）全部 `bad-token` 且全 runtime 树字节零差异。
- **其它 must-fix**：local 后继 prompt 带 `local:true`+同地址；home→local fail-closed（与 `master-attach --local` 不冲突）；local transfer 不碰 global succession（字节不变）；四要素回报（旧/新 sid12+gen、token 消费时刻）；transfer-window marker 抑制 reclaim/takeover（humanCancel 越过）。
- **残余**：窗口 marker TTL 24h；多 daemon 并发假设（当前为单 daemon 迁移）；global 路径行为有源码变化（签名/record/spawn cwd）但 12 项回归绿。

### Item 36 - 微信出站回复 W3a–W3d

- **日期**：2026-09-24
- **一句话**：微信入站触发的 assistant 最终文本经 daemon 意图 watcher 发回发送者；提供受鉴权/通道开关闸保护的只读状态投影和 GUI 卡片，GUI 不写开关。
- **涉及模块**：`extensions/channel-wechat/send.ts`、`extensions/runtime/wechat-reply.ts`、`extensions/runtime-host/wechat-reply.ts`、`extensions/runtime-host/server.ts`、`gui/src/pages/ChannelsPage.tsx`、`gui/src/api/types.ts`
- **Priority**：P1
- **Status**：done
- **Commit**：`a282848`（W3a 协议底座） / `d4b3ebf`（W3b 触发与意图） / `b9b6726`（W3c daemon 发送与审计） / `aab6bf6`（W3d 只读端点 + GUI + Wiki/文档）
- **Verification**：按 W3d 实跑记录执行回归；真机校准确认 HTTP 200 + `{message_id}`、无 `ret`/`errcode`/`errmsg`；client_id 去重未定论，文本长度上限/429/回声未验证；本轮未发送真机消息。

### Item 35 - 热点层 v4 重做（短期工作集 projection）

- **日期**：2026-09-24
- **一句话**：Hotspot 从 v2「Wiki 路由缓存」重做为可丢失、可重建、非权威的短期工作集；按 task/workstream 投影最近 read/write/test 文件，工具仅 lookup，`/hotspot` 只读诊断。
- **涉及模块**：`extensions/hotspot/{types,store,collect,decay,workset,inject,tool,command,log,index}.ts`；删除 v2 detect/graph/heat/usage/validate 等实现；文档 `README.md`、`CHANGELOG.md`、`skills/workflow-orchestrator/SKILL.md`、`agents/searcher.md`、`Wiki/Architecture/hotspot-working-set.md`
- **产物**：设计 `plans/0924_hotspot_v4_ephemeral_working_set.md`；实现 `plans/0924_hotspot_v4_impl_report.md`；L4 链 `plans/0924_hotspot_v4_{l4_review,fix_report,fix_l4_confirm,fix2_report,fix2_l4_confirm}.md`
- **Wiki**：`Wiki/Architecture/hotspot-working-set.md`（current；源码逐项出处）
- **Priority**：P1
- **Status**：done
- **Commit**：`8a9f09a`
- **Verification**：实现报告记载 `npm run test:hotspot` 13/13、extension smoke、注册图测试本体、真机采集/注入/开关/lookup 四项通过；L4 两轮修复后终判 PASS。`npm run test:register-graph` 脚本前置依赖检查环境性失败，但底层测试直跑通过。文档收尾另实跑验证见本轮结果。
- **L4 教训**：① 注入块字段必须在写入端拒绝非法路径，并在渲染端共享转义（控制字符压平、尖括号全角化），防存储/旧分片内容伪造标签或行；② 不能只审查主渲染函数，lookup 工具与 `/hotspot` 诊断是渲染旁路，必须使用同一 `esc()` 并对三条输出路径分别回归。
- **退役边界**：`Wiki/_hotspot.md` 与 `_hotspot.trash.jsonl` 保留为 v2 唯一副本；v4 不读写删除。回退为 `git revert 8a9f09a`；确认不再回退后再按旧计划备份移出并清理 `.gitignore` 遗留规则。

### Item 34 - 交接状态（2026-09-24，compaction 不可用 → 自动交接新会话）

**微信链路（P0，已打通）**
- 真机消息**已能正确接收并解析**：GUI 实测 `msgId=7508724292610502000`（数字 `message_id`）/ `from=o9cq…`（`from_user_id`）/ 正文 `现在测试微信途径。你好？`（`text_item.text`）。链路：`iLink 长轮询 → 真机字段解析 → 私有 inbox → GUI 只读展示`。
- 关键修复：`3babd63`（真机形状：`message_id` 数字 / `from_user_id` / `text_item.text` / `group_id` 群消息拒收）；`842d49a`（真机协议：`get_updates_buf`/`msgs`，指南不可信）；`00b5f32`（W1 接收）；`168fed1`（W2 注入）；`18ba74d`（W2b 界面开关）。
- **未提交（工作树）**：W2c = owner 默认准入（`ownerOpenId` 来自绑定响应 `ilink_user_id`）+ rejected 复活 + `GET /v1/wechat/quarantine` + GUI 被拒可见性。文件：`extensions/runtime-host/{wechat-bind.ts,wechat-input.ts,server.ts}`、`extensions/channel-wechat/store.ts`、`gui/src/pages/ChannelsPage.tsx`。
- **在飞**：W2c 的 L4 = `run_mueyl6qa_r5w2`（产物 `plans/0924_wechat_owner_default_l4_review.md`）。PASS → 提交；must-fix → 修复轮。
- 已知缺口（实现者自认）：owner 命中/缺失、复活幂等与"其它原因不复活"、quarantine 端点 401/脱敏 的**专项断言**未补（L4 已要求其自写探针）。

**下一步（用户明确要求）**：**重做热点层** —— 依据 `plans/0924_hotspot_v4_ephemeral_working_set.md`（用户指出的计划文件；当前热点层"不理想"）。
- 现状事实：`Wiki/_hotspot.md` rev 8、9 主题（上限 8）；`extensions/hotspot/{store.ts,tool.ts,validate.ts}`；上限语义已修（只在新增时生效，`e4a5874`）；CodeGraph 已初始化（`.codegraph/` 28MB 已 gitignore，符号验证可用）。
- 待读该 v4 计划后按 lite 链推进（L1 检索 → L2 计划 → L3 实现 → L4 → L5）。

**其它待办**：worker 成功时未清陈旧 `lastError`；微信真网 7 项已测 4 项（空批推进/响应形状/长轮询时长/消息形状），余 5 项待测；W3 出站回复（待用户定）。

### Item 33 - 微信接收真正打通：真机消息形状对齐

- **日期**：2026-09-24
- **一句话**：用户"重绑+重启后仍收不到"——真相是**消息一直在到**（`quarantined` 从 0 涨到 4，含用户刚发的那条），但 `parser.ts` 读不懂真机字段 ⇒ 全部 quarantine ⇒ GUI 读 inbox 显示为空。修后真机形状解析正确。
- **真机形状**（quarantine 的脱敏签名抓到）：`{seq:number, message_id:number, from_user_id, to_user_id, client_id, create_time_ms, …, session_id, group_id, message_type, message_state, item_list:[{type:1,text_item:{text}}]}`。
- **涉及模块**：`extensions/channel-wechat/parser.ts`（`pickMsgId` 接受数字 `message_id`；发送者取 `from_user_id`；文本取 `text_item.text`；`group_id` 非空 ⇒ 群消息拒收（D15 仅私聊）；`shapeSig` 上限 12→24 便于一次看清未知形状）
- **Wiki**：`Wiki/Architecture/wechat-ilink-channel.md` → 「真机消息条目形状（已实测）」
- **Priority**：P0（"微信能不能通"的最后一段）
- **Status**：done
- **Verification**：用真机形状构造用例实测（文本→正确解析 / 群消息→拒收 / 图片→quarantine 不误当文本）；smoke + W1 7 组 + W2 13 组回归全绿。
- **教训**：① 未知形状解析必须把**脱敏形状签名**写进 quarantine（本次靠它一次定位）；② **quarantine 必须可见**——GUI 只读 inbox ⇒ 用户看不到被拒记录，是真实 UX 盲区（已列后续项）。

### Item 32 - autonomy 开关界面可达（D17）+ 前置修 R4

- **日期**：2026-09-24
- **一句话**：用户要求"主动话套件也要能在设置中开启"。**先修 R4**（否则开关一开反而压制唤醒），再给开关：`/autonomy on|off` + HTTP 端点 + GUI 卡片（含 D17a 四要素反馈与"当前不执行任何自动动作"的诚实文案）；`awayMode` 空壳明确标注"未实现"。
- **涉及模块**：`extensions/runtime/autonomy/frontier.ts`（A1）、新增 `extensions/runtime-host/autonomy-config.ts`、`extensions/index.ts`（最小 hunk）、`extensions/runtime-host/server.ts`（端点）、`gui/src/pages/ChannelsPage.tsx`、三个测试文件
- **产物**：`plans/0924_autonomy_switch_spec.md`、`plans/0924_autonomy_switch_impl_report.md`、`plans/0924_autonomy_switch_l4_review.md`（PASS-with-must-fix）
- **Wiki**：`Wiki/Architecture/autonomy-suite.md` → 「开关可达化 + R4 已修」
- **Priority**：P1
- **Status**：done（`3d8409f`）
- **Commit**：`3d8409f`
- **Verification**：A1 由 L4 在**装配层**实测放行 + 改动前实现并排逐字节比对（6/6）；`_test_runtime_autonomy`(57)、`_test_autonomy_switch`（保留字段/幂等/写失败无半写）、`_test_runtime_host_server`（401/写入/status 四要素）、`_test_runtime_commands`、`_test_register_graph`、smoke、GUI tsc/build 全绿。
- **L4 抓到的 D17 违背（已修）**：GUI 卡片原先只在最终 return 渲染 ⇒ 默认配置（wechat 403）与未授权（401）两个早退分支下**开关完全不可见**。教训：D17 验收必须覆盖"默认配置 + 各错误态"。
- **残余**：R5 audit 无轮转（~1MB/天）；`enabled=true` 时长期 pending 到信是否导致 trigger 重复（L4 已列为观察项）；config 写入无锁（与 setWechatEnabled 同款先例）。

### Item 31 - 修 daemon 必定弹终端窗口（spawn 形状更正 + worker 连带修）

- **日期**：2026-09-24
- **一句话**：用户报"runtime 必定起一个终端窗口"——根因是 daemon 的 spawn 形状 `{detached:true, windowsHide:false}` 会分配一个控制台，Win11 交给 Windows Terminal 显示为窗口；**旧注释声称"两者不可叠用"被真机对照实测推翻**。
- **涉及模块**：`extensions/runtime-host/daemon-lifecycle.ts`（windowsHide:false→true + 注释更正）、`extensions/runtime-host/channel-supervisor.ts`（worker spawn 同样改 true——daemon 无控制台后 worker 会自己开窗口）
- **Wiki**：`Wiki/Architecture/runtime-daemon.md` → 「派生形状更正」
- **Priority**：P1（用户直接可见的体验缺陷）
- **Status**：done
- **Verification**：`EnumWindows` 可见窗口枚举 + 存活检查的三变体对照（detached+hide:true = 不弹窗且存活；detached+nohide = 弹窗；nodetach+hide:true = 存活失败）；修复后实测可见控制台窗口 **4 → 3**、daemon 存活（health 200）、worker 正常 spawn 且无新增窗口、worker 唯一（worker.json pid = daemon 子进程）。
- **触发**：本轮 `/runtime-host restart` 测试（它重新 spawn 了 daemon）让旧形状的问题暴露出来。
- **教训**：`windowsHide`/`detached` 兼容性必须按"本进程 + 其子进程"两层分别实测，不能靠历史注释外推。

### Item 30 - `/runtime-host restart [--force]`（用户提出）

- **日期**：2026-09-24
- **一句话**：把"反复手工杀 daemon 重启"变成一条命令：复用既有 `stopRuntimeDaemon`（身份核验 + fail-closed）+ `ensureRuntimeDaemon`，**有界等锁释放**，回报必含"GUI cookie 已失效需 `/gui open`"+worker 重新 spawn；`uncertain` 一律中止；`--force` 仅显式传入。
- **涉及模块**：`extensions/runtime-host/daemon-lifecycle.ts`（新增 `restartRuntimeDaemon()`；既有语义未改）、`extensions/index.ts`（最小 hunk：命令分支 + 用法串/description 补 restart）、`extensions/_test_runtime_host_restart.ts`
- **产物**：`plans/0924_runtime_host_restart_spec.md`、`plans/0924_runtime_host_restart_impl_report.md`、`plans/0924_runtime_host_restart_l4_review.md`（**PASS**，无 must-fix；5 条 minor 中 2 条已修：用法串可发现性 + `already:true` 不得谎称"新起"）
- **Wiki**：`Wiki/Architecture/runtime-daemon.md` → 「重启命令」
- **Priority**：P2
- **Status**：done（`1743061`）
- **Commit**：`1743061`
- **Verification**：单测 5 组 PASS（第 6 组可选 worker-only restart 如实 SKIP）；smoke + 3 个回归测试全绿；**真实重启实测**：旧 pid=195936 port=53872 → 新 pid=254488 port=51984、`/v1/health` 200、回报含 cookie 失效提示。
- **未做**：worker-only restart（可选）；`restart --force extra`/`-f` 落到用法提示（fail-closed）。

### Item 29 - 微信输入 W2b（界面开关 + 白名单 + 未生效反馈）+ 真机接收被平台侧阻塞

- **日期**：2026-09-24
- **一句话**：按 D17 把 W2 的注入开关从"手改 config.json"搬到 GUI：三端点（`input/set`、`input/status`、`senders`）+ GUI 区块（开关/白名单/一键加/为什么没进来）；白名单用 **hash id** 维护（刷新后仍可增删，且不暴露完整 openid）。
- **涉及模块**：`extensions/runtime-host/{server.ts,wechat-bind.ts}`、`gui/src/pages/ChannelsPage.tsx`、`extensions/_test_wechat_input_set.ts`
- **产物**：`plans/0924_wechat_input_w2b_spec.md`、`plans/0924_wechat_input_w2b_impl_report.md`、`plans/0924_wechat_input_w2b_l4_review.md`（PASS-with-must-fix，2 处契约偏差已修并加锁）
- **Wiki**：`Wiki/Architecture/wechat-ilink-channel.md` → 「W2b 界面开关切片」
- **Priority**：P1
- **Status**：done（`18ba74d`）
- **Commit**：`18ba74d`
- **Verification**：端点级测试（401/403、status 零泄漏完整 openid、masterAlive 随心跳、审计尾行、senders 20 上限+去重+不写审计、set 保留其它字段/幂等/原子失败）+ W2 13 组 + W1 7 组 + runtime-host-server + smoke + GUI tsc/build 全绿。
- **⚠️ 真机接收被平台侧阻塞（未解）**：两个受控探针（随机 UIN / **固定 UIN**，均空游标起步、唯一消费者）各 6 次 poll 全 `msgs:[]`，HTTP 200 且服务端接受并推进游标 ⇒ **本机实现无缺陷**，但该 bot 的消息**不进长轮询队列**。用户侧现象：曾收到 bot 自动回复"暂无法连接openclaw"（说明有东西在应答），该回复消失后长轮询仍恒空。**待用户在平台侧核对**：①「消息推送/Webhook/回调 URL」是否配置（应清空才能走长轮询）②绑定的 `bot_type=3` 与所聊 bot 是否同一个 ③是否需先建立会话。详见 Wiki 微信页「判定实验」节。
- **旁**：`input.enabled=true` 且白名单为空时，期间收到的消息会被标 `rejected`（终态）——已在 Wiki 写明操作顺序。

### Item 28 - 微信输入 W2（私聊文本注入当前 master owner）

- **日期**：2026-09-24
- **一句话**：用户批准 W2（D15）后，把微信**私聊文本**按「本人远程输入」注入当前 master owner 会话——六条件按序短路（opt-in / openid 全等白名单 / 仅私聊 / tick 级心跳判活 / generation 二次确认 / 单条一次批 + 脱敏审计），幂等键 `msgId`，注入复用 GUI 窄路径同一条 outbox 通路，**worker 永不成为 Pi 的写者**，**不改**既有 `session.message → master` 403。
- **涉及模块**：新增 `extensions/runtime-host/wechat-input.ts`、`extensions/_test_wechat_input.ts`；最小 hunk `extensions/runtime-host/server.ts`（3 行接线，透传 `timersDir` + `stateDir` 兜底统一）、`wechat-bind.ts`（`readWechatInputConfig`）、`gui/src/pages/ChannelsPage.tsx`、`extensions/channel-wechat/store.ts`（仅 `inboxFileName` 改 export，**主会话批准的一行级豁免**）。
- **产物**：`plans/0924_wechat_input_w2_spec.md`（规格 + 豁免记录）、`plans/0924_wechat_input_w2_impl_report.md`、`plans/0924_wechat_input_w2_l4_review.md`（**FAIL**，4 must-fix）、`plans/0924_wechat_input_w2_fix_report.md`（补写）、`plans/0924_wechat_input_w2_l4_convergence.md`（**PASS**）
- **Wiki**：`Wiki/Architecture/wechat-ilink-channel.md` → 「W2 实现切片」
- **Priority**：P1
- **Status**：done（`168fed1`）；W2b（界面开关）待做
- **Commit**：`168fed1`
- **Verification**：13 组断言全绿（116ms）；收敛 L4 **PASS**（并反向复现旧缺陷证明 T5 有效）；smoke + 既有 5 个测试 + GUI 构建全绿。
- **L4 三轮轨迹**：首轮抓到 **MF1 非 BMP msgId 命名分歧 → 重复注入**（实跑证据）/ MF2 denied 无界重审（~17k 行/天）/ MF3 注入正文含不可信昵称 / MF4 `timersDir` 未透传 → **注入门静默失效**；修复轮 4 项代码全改对但改坏测试且未写报告；主会话重写测试后收敛 PASS。
- **已知残余**：群消息无法独立识别（靠 openid 白名单兜住）；denied 终态 ⇒ 事后加白名单不补投旧消息；真网 7 项未测。

### Item 26 - 远程输入中文 U+FFFD 乱码修复（严格 UTF-8 + GB18030 兜底）

- **日期**：2026-09-24
- **一句话**：master 会话里出现一条 U+FFFD 乱码消息——**根因是主会话一次诊断 `curl`（Windows/mingw curl 按 cp936 编码请求体）**，而 `POST /v1/commands` 旧实现用 `Buffer.toString("utf8")` 把非 UTF-8 字节静默烧成 U+FFFD 并照常落盘 outbox（事后不可恢复）。
- **涉及模块**：`extensions/runtime-host/commands.ts`（新 `decodeCommandBody`）、`extensions/runtime-host/ws.ts`（文本帧严格 UTF-8 → 非法 close 1007）、`extensions/runtime-host/server.ts`（两处接线，最小 hunk）、两个测试文件。
- **产物**：`plans/0924_remote_input_encoding_fix.md`、`plans/0924_remote_input_encoding_impl.md`、`plans/0924_remote_input_encoding_review.md`（独立 L4：PASS-WITH-FIXES，含 T16 补强）
- **Wiki**：`Wiki/Architecture/gui-message-pipeline.md`（编码口径）
- **Priority**：P1（阻塞 W2 的中文输入正确性）
- **Status**：done（由用户开的 `l2-subagent-win` execute tab 完成；主会话按 hunk 精确暂存提交，未夹带同树 W1 半成品）
- **Commit**：`88ba26a`
- **Verification**：合法 UTF-8（含 BOM/emoji/原文 U+FFFD）逐字节等于旧行为；GBK 中文正确恢复；双非法 → 400 且 outbox 与 state/commands 零新增；runtime-commands / runtime-host-server / runtime-host-ws / message-outbox / gui-chat-guard / smoke 全 PASS。

### Item 25 - 微信 iLink 接收 W1（只收不投：长轮询 + 游标/去重/私有 inbox + GUI 可见）

- **日期**：2026-09-24
- **一句话**：用户报“GUI 通了、微信还没通”——查明绑定早已成功（`credentials.json` 已存 bot_token），**缺的是接收侧**：v1 只做了绑定页，没有任何东西在跑 iLink 长轮询，所以微信发的消息从没进过 pi。W1 落地“收到并可见”（**不注入**，注入是 W2/D15）。
- **涉及模块**：新增 `extensions/channel-wechat/{client,parser,store,worker,index}.ts`、`extensions/runtime-host/channel-supervisor.ts`、`extensions/_test_wechat_receive.ts`；最小 hunk：`extensions/runtime-host/server.ts`（2 只读端点 + receive 闸）、`wechat-bind.ts`、`gui/src/pages/ChannelsPage.tsx`；`extensions/index.ts` **零改动**。
- **产物**：`plans/0924_wechat_receive_w1_spec.md`（规格：九条不变量 + 6 组断言 + 诚实延期清单）、`plans/0924_wechat_w1_impl_report.md`、`plans/0924_wechat_w1_l4_review.md`（**FAIL**，2 must-fix）、`plans/0924_wechat_w1_l4_convergence.md`（收敛轮）
- **Wiki**：`Wiki/Architecture/wechat-ilink-channel.md`（W1 状态 + 延期项）
- **Priority**：P1
- **Status**：已实现（L3）→ L4 首轮 **FAIL**（抓到 MF1 数据丢失级 + MF2 opt-in 闸）→ 修复轮（agent 超时死掉无报告，主会话接手收尾）→ L4 收敛 **PASS-with-must-fix**（MF2/MF3 真修；MF1 反向重复计数仍存）→ 主会话修计数语义（`putInbox` 返回是否新建，计数只来自真实写入）→ 窄范围 L4 确认：**计数修复四条路径均被独立确认有效**，quarantine 重放重复**裁定为明确接受的残余**（不丢消息，W2 必须按 msgId 幂等）。
- **Commit**：`00b5f32`
- **Verification**：`npx tsx extensions/_test_wechat_receive.ts` 7 组断言全绿（~3.5s，含 180s 看门狗）；smoke OK；`_test_gui_master_unlock`/`_test_injection_gate`/`_test_runtime_commands`/`_test_runtime_host_server` 全绿；GUI `tsc --noEmit` + `vite build` 通过。
- **教训（EB-004）**：agent 超时失败时工作树可能停在**中间态**（半写代码），此时跑会 spawn 子进程的测试会挂死——本次实测挂 **6 小时**（两棵进程树未退出）；已给该测试加 180s 硬看门狗。
- **旁发现（Item 27）**：L4 实跑时 `_test_message_outbox.ts` 的“恰一个 CAS 赢家”断言失败 1 次（两进程均 claimed）；主会话连跑 3 次均过 ⇒ 竞争敏感，待判真竞态/测试抖动。

### Item 24 - 微信连接页 opt-in UX 修复（入口不可发现/不可启用）

- **日期**：2026-09-23
- **一句话**：用户实测"GUI 里找不到微信连接"——根因是入口仅在 opt-in 开启后才渲染、而全仓无任何 `/wechat` 命令可开；改为入口常显 + 页内启用按钮 + 补 `POST /v1/wechat/enable|disable`（走既有 token 鉴权、原子写、保留其它字段）。
- **涉及模块**：`extensions/runtime-host/{server.ts,wechat-bind.ts}`、`extensions/_test_wechat_bind.ts`、`gui/src/pages/{ChannelsPage,RuntimeOverlay}.tsx`、`gui/src/api/{client,types}.ts`、`gui/src/store.ts`
- **产物**：本地 `plans/0923_wechat_optin_ux_fix.md`
- **Wiki**：[[微信 iLink 通道]]（新增"开关路径"节）
- **Priority**：P1
- **Status**：complete（TUI 对等命令 `/wechat` 待补）
- **Commit**：`5bfd258`
- **Verification**：smoke OK；`_test_wechat_bind.ts` 12 组断言（新增 T12：无 token 401／开关幂等／写盘保留其它字段／status 403↔200／写失败 500）；gui tsc + vite build 成功。

### Item 23 - 主动性套件 v2 接线（可观察/可开关/可审计，不自动动手）

- **日期**：2026-09-23
- **一句话**：把 v1 纯函数层接进生产路径（唤醒总门 + master-status 增量行 + `/autonomy kill|clear` + 结构化审计），并保证 **enabled 缺省时零行为变化、无任何自动动作**（审计行 `acted=false` 恒真）。
- **涉及模块**：`extensions/runtime/autonomy/{gate.ts（新）,collect.ts,wake-gate.ts}`、`extensions/runtime/wake.ts`、`extensions/master-tools.ts`、`extensions/index.ts`、测试三个
- **产物**：本地 `plans/0923_autonomy_suite_v2_{plan,impl,review}.md`、`plans/0923_autonomy_v2_L1B_research.md`
- **Wiki**：[[主动性套件（Autonomy Suite）]]（`draft` → `current`，含 v1 休眠库 / v2 接线两节）
- **Priority**：P2
- **Status**：complete（L4 PASS，must-fix 0）
- **Commit**：`1972aac`
- **Verification**：`_test_autonomy_wiring.ts` 14 项 + `_test_runtime_autonomy.ts` 56 项 + `_test_register_graph.ts` 全绿 + smoke OK；tab 内独立 L4 PASS。未决：R4（enabled=true 预期语义，ws-mail 不触发）、R5（审计文件无轮转）、watchdog #3/#8 数据源缺口。

### Item 22 - ComputerUse（CUA）立项：C0 可行性探针通过 → C1 开工

- **日期**：2026-09-23
- **一句话**：把 iCloud 的 CUA 设计文集（8 篇）落成工程：先做 C0 可行性探针（Windows UIA 能否不抢焦点地观察+动作），得出**关键证伪**后立项新包 `pi-packages/computer-use`，C1（pwsh 常驻 Broker 守护进程）已开工。
- **涉及模块**：新包 `C:/Users/Annacomnena/pi-packages/computer-use`（独立仓库；`bin/cua-broker.ps1`、`roadmap.md`、`reports/`）
- **产物**：本地 `plans/20260923_cua_c0_probe.md`（C0 结论 + 实测输出）、`plans/.cua-probe/`（探针脚本，已拷为新包 `probe-seed/`）
- **Wiki**：无（新包自带 README/roadmap；本仓 Wiki 不承载其设计）
- **Priority**：P1（新方向）
- **Status**：C0 complete；**C1 complete**（tab 3001，workflow 六阶段走齐 + 独立 code-reviewer L4 两轮；e2e 24 PASS/0 FAIL/1 WARN）；C2 待开工
- **Commit**：新包 `0470527`（本仓仅此记录）
- **Verification（C1 实测结论）**：`bin/cua-broker.ps1`（989 行）pwsh7 常驻 Broker + stdio JSON 行协议（ping/observe/act/capture/diff/lease）；三档动作焦点回执 **wm_settext=none（不抢）/ setvalue=steals（实测）/ invoke=may_steal（实测在本环境 steals）**；非幂等动作抛错即 `dispatched_unknown`（不自动重试）；常驻复用 walk 118.6→63.7ms、client_rt 161→67ms。未决：PS5.1 回退未实跑、单实例 Notepad 目标选择依附用户进程、其它控件类型 focus 未穷举。
- **Commit**：—（新包未提交；本仓仅此记录）
- **Verification（C0 实测结论）**：传输选型 = **PowerShell + System.Windows.Automation 常驻进程**（冷启动太贵⇒必须常驻；Python/node-ffi-napi 出局）；**`ValuePattern.SetValue` 被证伪会抢前台焦点**（干净基线、两窗口复现；`WM_SETTEXT` 已证不抢、`Invoke` 未决）；树 22–26 节点/62–122ms、扁平化 ≈600–750 tokens/窗；字段级 diff 可行但**主键须改用 RuntimeId**；截屏证实。⇒ 动作能力必须分三档 + 内建 FG 断言器。

### Item 21 - dead 僵尸 host.json / 孤儿锁重建（修「重启后 GUI 永远起不来」）

- **日期**：2026-09-23
- **一句话**：`ensureRuntimeDaemon` 此前对 dead host.json 直接 fail-closed，且 daemon 崩溃遗留的**孤儿锁**使取锁失败（`stealStaleLock` 定义了却从未接线）⇒ 重启电脑后 `/gui on` 永远拿不到 GUI 地址，只能手工删文件。
- **涉及模块**：`extensions/runtime-host/daemon-lifecycle.ts`、`extensions/_test_ensure_dead_rebuild.ts`（新）
- **产物**：本地 `plans/0923_daemon_dead_rebuild_fix.md`（+ L4 复核 `plans/0923_daemon_dead_rebuild_review.md` 并发中）
- **Wiki**：[[Runtime Daemon 存活机制]]（新增"dead 僵尸 / 孤儿锁重建契约"节）
- **Priority**：P1
- **Status**：complete（**L4 独立复核 PASS / 无 must-fix**）
- **Commit**：`e262eb8`
- **Verification**：L4 独立复核 `plans/0923_daemon_dead_rebuild_review.md` **PASS**（真退出的死 pid 端到端复现 A 孤儿锁→重建 / B 活锁→fail-closed / C 活 handoff→fail-closed；实测真实 runtime 目录 mtime 未变；确认 `stealStaleLock` 只 rm 锁+重新 wx 取锁、绝不 kill、并对清抢后二次抢锁串行化）。`npx tsx extensions/_test_ensure_dead_rebuild.ts` 五夹具全过（dead 无锁→重建、dead+孤儿锁→重建、stale→uncertain spawn=0、runtimeId 不符→uncertain spawn=0、dead+活锁→fail-closed 且锁/host.json 未动）；smoke OK；daemon-lifecycle/gui-autostart/runtime-host-server 相邻测试全过。

### Item 20 - hotspot 工具 pending 队列误写仓库根 state/（待修）

- **日期**：2026-09-23
- **一句话**：`hotspot` 工具把待办队列写到 **CWD 的 `state/hotspot-pending.jsonl`**（应在 agentDir），在仓库里留下 `state/` 目录并污染工作树。
- **涉及模块**：`extensions/hotspot/**`（路径推导处）
- **产物**：无（现场证据：`state/hotspot-pending.jsonl`，已临时加入 `.gitignore` 止血）
- **Wiki**：无
- **Priority**：P3
- **Status**：active（待修）
- **Commit**：—
- **Verification**：修后断言 pending 队列落在 agentDir（`~/.pi/agent/...`）；仓库根不再出现 `state/`。

### Item 19 - set-timer 的 target 参数 schema 恒拒修复

- **日期**：2026-09-23
- **一句话**：`set-timer` 的 `target` 对象参数被 pi 校验层恒拒（`Type.Union([Literal("self"), Object])` 对模型序列化出的 JSON 字符串 / 裸 runId 全分支失败，execute 根本跑不到）；改为先归一化再校验。
- **涉及模块**：`extensions/timers.ts`（新增 `normalizeTargetParam` 纯函数）、`extensions/timers-runtime.ts`（schema 增 `Type.String()` 分支 + `resolveWriteScope`/execute 归一化 + `renderCall` 兼容）、`extensions/_test_timers_target_compat.ts`（新回归测试）
- **产物**：本 tab 会话内直接完成（无独立 plans 报告）
- **Wiki**：无（Wiki 无 timers 主题页；契约记入工具 description 与代码注释）
- **Priority**：P2
- **Status**：complete
- **Commit**：`9960ed9`
- **Verification**：`npx tsx extensions/_test_timers_target_compat.ts` 通过 + `npm run smoke:extension-load` OK。

### Item 18 - outbox 事件唤醒（消息入会话延迟 5s → 9ms/≤200ms）

- **日期**：2026-09-23
- **一句话**：outbox 投递从"10s tick 轮询"改为"同进程钩子 + `fs.watch` debounce 双唤醒"，tick 降级为兜底；用户消息入会话延迟从均值 5s 降到同进程 ~9ms / 跨进程 ≤200ms。
- **涉及模块**：`extensions/outbox-bridge.ts`（+90）、`extensions/_test_outbox_latency.ts`（新探针）
- **产物**：本地 `plans/0923_outbox_latency_{impl,review}.md`
- **Wiki**：[[GUI 消息管道与延迟贡献项]]（该行状态已更新，Open Question 划掉）
- **Priority**：P1
- **Status**：complete
- **Commit**：`e7475e3`
- **Verification**：探针 `npx tsx extensions/_test_outbox_latency.ts`（前后 67ms→9ms、不重复断言 `injectedCount===1`）；`_test_message_outbox.ts` 通过（含 crash-window 重投幂等）；smoke OK；独立 L4 复核通过。未动 `mailbox-consumer.ts`（master 域 mailbox 消费，独立路径）。

### Item 17 - markdown 渲染器回归测试入库 + 围栏闭合收紧

- **日期**：2026-09-23
- **一句话**：把上一批"临时脚本验证"落成入库测试（33 项断言，`node` 直跑、零新增依赖），并修掉 L4 指出的围栏闭合偏宽（收紧到 CommonMark 口径）。
- **涉及模块**：`gui/tests/markdown.test.mjs`（新）、`gui/src/ui/Markdown.tsx`（+16/-1）
- **产物**：本地 `plans/0923_markdown_test_{impl,review}.md`
- **Wiki**：[[GUI 消息管道与延迟贡献项]]（Open Questions 两条已关闭）
- **Priority**：P2
- **Status**：complete
- **Commit**：`911c397`
- **Verification**：`node gui/tests/markdown.test.mjs` 33/33；`cd gui && npx tsc --noEmit` 0 错误 + `vite build` 成功；反例验证（故意破坏链接协议白名单 → 测试必红 → 改回）。

### Item 16 - GUI 三毛病修复（设置层遮挡 / markdown 渲染 / 消息不及时）

- **日期**：2026-09-23
- **一句话**：逐项定位并修复：设置层被输入区压住（同层叠上下文 z 倒挂）、正文未渲染 markdown、消息延迟（WS 断线盲区 + 非 chat 页从未订阅 WS）；并**实验证实**主导延迟项属 pi core（assistant 仅 message_end 落盘）。
- **涉及模块**：`gui/src/ui/Markdown.tsx`（新）、`gui/src/pages/{ChatPage,RuntimeOverlay}.tsx`、`gui/src/{store,useEventStream,index.css}`、`gui/src/api/client.ts`
- **产物**：本地 `plans/0923_gui_ux_fix_{plan,impl,review}.md`
- **Wiki**：[[GUI 消息管道与延迟贡献项]]（`status: current`）
- **Priority**：P1
- **Status**：complete（三项已修；C1 流式属 pi core，记为已知限制）
- **Commit**：`6d4ba67`
- **Verification**：`cd gui && npx tsc --noEmit` 0 错误 + `vite build` 成功（JS gzip 129.65 kB，持平）；27 例 XSS/兼容实测（临时脚本）；tab 内独立 L4 通过并修掉 resync 竞态。**待人工**：打开 GUI 目视确认遮挡消失 + markdown 渲染 + 更新及时性。

### Item 15 - global master 主动性套件 v1（纯函数层，未接线）

- **日期**：2026-09-23
- **一句话**：按 1335 行规格切出 v1 最小切片并实现（配置/ kill-switch / frontier / wake-gate / watchdog / collect），**只新建、零既有文件改动**，但**尚未接线**到 master 工具与唤醒路径。
- **涉及模块**：`extensions/runtime/autonomy/{config,kill-switch,frontier,wake-gate,watchdog,collect}.ts`（新）、`extensions/_test_runtime_autonomy.ts`（新）
- **产物**：本地 `plans/0923_autonomy_suite_v1_{plan,impl,review}.md`、`plans/0923_autonomy_L1{A,B}_*_research.md`；规格 `plans/0923_global_master_autonomy_suite_v0.2.md`
- **Wiki**：[[主动性套件（Autonomy Suite）]]（`status: draft`，含未接线清单）
- **Priority**：P2
- **Status**：v1 complete（待 v2 接线）
- **Commit**：`3922ef4`
- **Verification**：`npx tsx extensions/_test_runtime_autonomy.ts` 55 项断言全绿 + `npm run smoke:extension-load` OK；tab 内独立 L4 PASS（must-fix 0）；回滚 = 删两个新路径。

### Item 14 - 微信扫码连接页 v1（绑定/解绑/状态）

- **日期**：2026-09-23
- **一句话**：GUI 设置里新增「微信连接」页 + daemon 侧 5 个端点，实现 iLink 扫码绑定/解绑/状态；v1 不含消息收发。
- **涉及模块**：`extensions/runtime-host/wechat-bind.ts`（新）、`extensions/runtime-host/server.ts`、`gui/src/pages/ChannelsPage.tsx`（新）、`gui/src/pages/RuntimeOverlay.tsx`、`gui/src/store.ts`、`gui/src/api/{client,types}.ts`
- **产物**：本地 `plans/0923_wechat_gui_bind_plan.md`（设计）、`plans/0923_wechat_gui_bind_impl.md`、`plans/0923_wechat_gui_bind_review.md`（tab 内独立 L4，条件通过）
- **Wiki**：[[微信 iLink 通道]]（协议契约 + 已实现边界）
- **Priority**：P1
- **Status**：complete（代码级验收通过；真网 7 项待测）
- **Commit**：`8ee843d`
- **Verification**：`npm run smoke:extension-load` OK；`npx tsx extensions/_test_wechat_bind.ts` 11 组断言全过；`gui` tsc --noEmit + vite build 成功。L4 已修两项实问题（QR 代理跨源 SSRF、轮询故障热循环）。**待用户扫码**做真网测量。

### Item 13 - Local Master 可得性修复（工具/命令可设 local + status 可见）

- **日期**：2026-09-23
- **一句话**：补上"仓库会话无法认领自己的 local master、僵尸 owner 无法显式回收"的能力缺口（底层早已支持，只是入参表面没暴露）。
- **涉及模块**：`extensions/master-tools.ts`、`extensions/index.ts`、`extensions/_test_local_master.ts`
- **产物**：本地 `plans/0923_local_master_attach_impl.md`、`plans/0923_local_master_attach_review.md`（独立 L4 PASS）
- **Wiki**：[[Local Master 认领与接管]]（`status: current`）
- **Priority**：P1
- **Status**：complete
- **Commit**：`5b56ecf`
- **Verification**：`npx tsx extensions/_test_local_master.ts`（U1-U9/E1-E5/L1-L7）+ `npm run smoke:extension-load`；L4 核对真实 registry/scope-liveness/attachments-backup 零污染。已知缺口（自动回收在 no-liveness 时恒 skip；回执不含被顶掉的 owner）写入 Wiki 页"已知缺口"节待裁定。

### Item 12 - global-view phase 2 探测深度增强

- **日期**：2026-09-23
- **一句话**：为“一次探测看不够深”补内容层/异常聚合/差分/跨仓闸口读取；实现 + 独立 L4 复核 + M1 修复均已落地。
- **产物**：本地 `plans/0923_global_view_depth_plan.md`（设计）、`plans/0923_global_view_depth_impl.md`（实现）、`plans/0923_global_view_depth_review.md`（L4 复核 PASS-WITH-MUST-FIX）、`plans/0923_global_view_tail_lines_fix.md`（M1 修复）
- **Wiki**：无（工具增强，暂无需耐久页）
- **Priority**：P2
- **Status**：complete（待提交后随分支推送）
- **Commit**：`70c8aa3`

### Item 10 - GUI 扫码连接微信切片（v1 绑定/解绑/状态）

- **日期**：2026-09-23
- **一句话**：设计完成、协议已源码验证、待实现（v1 只做扫码绑定 + 解绑 + 状态显示，不做消息收发）。
- **涉及模块**：`gui/src/pages/ChannelsPage.tsx`（新，拟）、`extensions/runtime-host/wechat-bind.ts`（拟）、`extensions/runtime-host/server.ts`
- **产物**：`plans/0923_wechat_gui_bind_plan.md`（本地 gitignored）
- **Wiki**：[[微信 iLink 通道]]（`status: proposed`）
- **Priority**：P1
- **Status**：planning/active（尚未实现）
- **Commit**：`c54c378`（协议契约 + 切片设计）

### Item 6 - 本机 GUI 解锁 master 切片

- **日期**：2026-09-23
- **一句话**：本机受信 GUI → 活着的 master 进程注入通道已实现并提交（bootstrap OTT + 窄口护栏 + B 案凭据作用域化）；**仅剩端到端 GUI 注入的人工验收**未做。
- **涉及模块**：`extensions/runtime/master-injection.ts`（新增）、`extensions/runtime/command-executor.ts`、`extensions/runtime-host/server.ts`、`extensions/runtime-host/ws.ts`、`extensions/runtime-host/commands.ts`、`extensions/gui-autostart.ts`、`gui/src/**`
- **Commit**：`00202cb`（切片 + B 案 + 两轮 must-fix）；`c3f69c5`（GUI autostart opt-in）、`c3003d5`（空壳 WT 修复）为同域历史提交，不含本通道代码。
- **Wiki**：[[GUI 解锁 Master]]（`status: draft`）
- **Priority**：P1
- **Status**：active（代码完整，人工验收待补）
- **Verification**：四轮独立 L4 逐轮收敛（PASS-WITH-MUST-FIX → PASS → 发现并修掉 `/v1/challenge` 预言机与 `/gui off` WS 缺口 → 聚焦复验 PASS）；**仍待人工**：开启 GUI 后注入一条消息，看占用锁/审计行/`master-offline` 文案的端到端表现。。当前真实状态：B 案（浏览器凭据作用域化，`sw_gui_token`）**已决策、未实现**；must-fix（M1–M3）**已实现、独立 L4 复核进行中结论未定**；通道代码仍仅在未提交工作树。

### Item 5 - 微信 iLink 探针

- **日期**：2026-09-23
- **一句话**：独立真网实验探针落地，login/listen/reply/send/typing/status 六命令就绪，七项未知项待真网测量。
- **涉及模块**：`scripts/wechat-ilink-probe.mjs`
- **Commit**：`658306e`
- **Wiki**：[[微信 iLink 通道]]（`status: proposed`）
- **Priority**：P1
- **Status**：waiting（待真网测量）
- **Verification**：`node scripts/wechat-ilink-probe.mjs status`；真网七项对照本地 `plans/0923_wechat_ilink_probe_checklist.md`

### Item 4 - runtime daemon 切片一

- **日期**：2026-09-23
- **一句话**：detached 生命周期 + 静态托管 + 单实例身份落地；关闭发起 tab 后 daemon 存活已实测，G0 完整 10/10 待实测。
- **涉及模块**：`extensions/runtime-host/daemon-lifecycle.ts`、`extensions/runtime-host/static.ts`、`extensions/runtime-host/identity.ts`、`extensions/runtime-host/server.ts`、`extensions/runtime-host/discovery.ts`、`scripts/verify-runtime-g0.ps1`
- **Commit**：`bdb6674`
- **Wiki**：[[Runtime Daemon 存活机制]]（`status: current`）、[[Runtime Daemon 架构]]（`status: draft`）
- **Priority**：P0
- **Status**：active（G0 十轮待跑）
- **Verification**：`scripts/verify-runtime-g0.ps1` save/check + 人工窗口/进程树核对；已验证部分见 Wiki Evidence

## Archived Tasks

### Item 11 - 仓库记忆层建立

- **日期**：2026-09-23
- **一句话**：建立“耐久+时序”双层记忆：`Wiki/` 8 页（Decisions/Architecture）+ `recentwork.md` 时间线 + hotspot 路由缓存；含 hotspot frontmatter 契约冲突修复。
- **Commit**：`cb9c3b5`（hotspot 兼容）、`49d5fd0`（记忆层）、`e473804`（参考对照 + L4 修正）
- **Wiki**：[[Wiki 索引]]
- **Priority**：P2
- **Status**：complete
- **Verification**：`check_repo_wiki.py` OK + `wiki-nav rebuild`；独立 L4 复核本地 `plans/0923_memory_layer_review.md`（PASS-WITH-MUST-FIX，5 项已修）

### Item 9 - Hermes 审批机制侦察

- **日期**：2026-09-23
- **一句话**：Hermes 审批四层判定（floor-before-yolo）+ 网关阻塞队列 + once/session/always + 超时即 BLOCKED 结论已提取，准入后动作分级可抄、headless fail-open 与 smart 代批不抄。
- **产物**：`plans/0923_hermes_approval_recon.md`（本地 gitignored）
- **Wiki**：[[审批门策略]]（参考实现对照）、[[统一审批门架构]]（待审队列接口形状拟定背景）
- **Priority**：P2
- **Status**：complete
- **Commit**：`e473804`（产物=本地 recon（gitignored）+ Wiki 对照表）

### Item 8 - openclaw 安全模型侦察

- **日期**：2026-09-23
- **一句话**：openclaw 入站信任（pairing/allowlist/owner）+ exec policy + exposure-runbook 五档结论已提取，边界与入口可抄、远端代批需改造。
- **产物**：`plans/0923_openclaw_security_recon.md`（本地 gitignored）
- **Wiki**：[[审批门策略]]（参考实现对照）、[[Host 暴露面加固]]（新建，`status: proposed`）
- **Priority**：P2
- **Status**：complete
- **Commit**：`e473804`（产物=本地 recon（gitignored）+ Wiki 对照表）

### Item 7 - opencode 权限/服务信任侦察

- **日期**：2026-09-23
- **一句话**：opencode 权限三态（deny > ask > allow）+ action×resource 粒度 + session 待审队列 + 默认 loopback 服务边界结论已提取，队列形状可抄、默认集与 yolo 开关需改造/不引入。
- **产物**：`plans/0923_opencode_permission_recon.md`（本地 gitignored）
- **Wiki**：[[审批门策略]]（参考实现对照）、[[统一审批门架构]]（待审队列接口形状拟定）、[[Host 暴露面加固]]（新建，`status: proposed`）
- **Priority**：P2
- **Status**：complete
- **Commit**：`e473804`（产物=本地 recon（gitignored）+ Wiki 对照表）

### Item 3 - runtime 卫生三连

- **日期**：2026-09-23
- **一句话**：有界缓存、tab-run 归档、`/gc` + TUI 进度完成并合入。
- **涉及模块**：runtime 缓存/`/gc` 命令/TUI 进度
- **Commit**：`6feef36`（merge；含 `0f565e1`、`37bd5e6`）
- **Wiki**：无（行为卫生项，无耐久契约页）
- **Priority**：P2
- **Status**：complete

### Item 2 - async 终态只投派发者 + async 专用注册谓词

- **日期**：2026-09-23
- **一句话**：async 完成通知只路由给派发者，link 缺失 fail closed；注册谓词收敛到 async 专用。
- **涉及模块**：async 结果投递/注册
- **Commit**：`5387546`
- **Wiki**：无（路由事实见 `Wiki/_hotspot.md` 的 async-delivery-ownership 条目）
- **Priority**：P1
- **Status**：complete

### Item 1 - 0.6.0 release

- **日期**：2026-09-23（发布提交 `c59e92f` 前）
- **一句话**：session 隔离 / parallel 默认异步 / master home-guard / global-view / 后续标题随 0.6.0 发布。
- **涉及模块**：session、parallel、master、global-view
- **Commit**：`a1fd9c6`（merge）、`c59e92f`（release）
- **Wiki**：无（发布纪要，无新增耐久页）
- **Priority**：P0
- **Status**：complete

0924 远程输入编码契约修复 → 更新 `Wiki/Architecture/gui-message-pipeline.md#输入编码契约（intake 侧）`；plans：`plans/0924_remote_input_encoding_fix.md` / `_impl.md` / `_review.md`

0930 GUI 视觉质量改进 L3 实现（S1–S8 八片，b88c531…7659908）→ token 底座补 ring/muted/info + 组件收敛 shadcn + 键盘焦点 + RuntimeOverlay 图标化 + Sidebar Timeline 入口（派发者批准唯一 IA 变化）；计划 `plans/20260930_gui_visual_polish_plan.md`；待人工目检（暗色 dev）

0930 TimelinePage 返回可发现性修复（df70d1b）：Esc + 页内「返回会话」钮 + Sidebar timeline 选中态 2px 高亮条；build 零错误、9 项 test:gui-* 全绿、真机 CDP 四条验证 4/4；更新 `Wiki/Architecture/gui-workbench-ui.md#导航契约`（TimelinePage 返回契约）

0930 Timeline D4 切回延迟诊断+优化：真机 CDP 复现 3721 行会话切回 2.2s（根因=App.tsx:41 条件渲染致 ChatPage 全量重挂载同步渲染，非网络）；ChatPage 分块渲染（首屏 200 行+贴底分块补齐）+ 切回瞬态跳过冗余全量 GET → 首帧 60ms（36x）；build 零错误 + 9 项 test:gui-* 全绿 + 改前/改后实测对比；报告 plans/20260930_timeline_switch_latency_d4.md
0930 会话标题契约修复（40b3448/b619edb/ecbdd8b）：/v1/sessions 发 titleSource + transcript readHead 32KB→256KB 分块扫描（StringDecoder 跨块 UTF-8）+ 解析链剥 <file>/<system-reminder> 附件块（P1 剥开标签行）+ SessionList 每组非置顶可见行 6→3；计划 plans/20260930_l2_task1_session_titles.md（含 _impl_report/_l4_review）；Wiki：Wiki/Architecture/gui-workbench-ui.md#会话列表标题契约
0930 GUI 性能（fd75285/c83ea9b/0310f05/ecbdd8b）：/v1/sessions + /v1/snapshot ETag/304 条件请求 + sessions 指纹快路（~20ms vs ~313ms）+ 客户端条件请求复用同引用 + timeline 轮询按需门控；计划 plans/20260930_l2_task2_gui_perf.md + plans/20260930_gui_perf_diagnosis.md（含 _impl_report/_l4_review）；Wiki：Wiki/Architecture/gui-message-pipeline.md#读投影降本：条件请求（ETag/304）+ 指纹快路 + 按需门控（2026-09-30）
0930 主动性设置页（d321c50/6ee8191/661c8f2/39e6677）：GET /v1/autonomy/frontier 只读端点 + RuntimeOverlay 第 6 section「主动性」+ AutonomySettings 从微信页迁出 + FrontierViz（C 时效/A 项目矩阵/B 触发记录）；计划 plans/20260930_l2_task3_autonomy_page.md（含 _impl_report/_l4_review）；Wiki：Wiki/Architecture/autonomy-suite.md#GUI-落点（RuntimeOverlay-第-6-section--frontier-读端点）、Wiki/Architecture/gui-workbench-ui.md#导航契约
