# Changelog

## [Unreleased] — 2026-09-28 (微信**入站图片附件 M1 真机验收通过** + 文档收尾；实现 `6ae8e0d` + L4 建议修 `972e29f`，本条目为纯文档提交)

- **真机验收证据链（2026-09-28，权威）**：启用 `channels.wechat.artifact.enabled = true`（**免重启**——`worker.ts#L179` 每批 `readArtifactGate()` 重读仓库根 `config.json`，生效时延 ≤ 一个长轮询周期 ≈≤95.3s，实测 ≤95s）→ 用户发图 → worker CDN 下载 + AES-128-ECB 解密 → 落盘 `~/.pi/agent/runtime/wechat/artifacts/files/18aac6b930d75f083…daad2.jpg`（**46,499 字节**、魔数 **`FFD8FF`**（`FFE1` baseline）、SOF **1200×2670**、目录恰 1 文件 = 内容寻址去重）→ inbox 记录 `text:""` + 相对 `artifactRef` + `state:"injected"` → outbox 正文 `[微信 o9cq80…chat] 〔附件：<绝对路径> (image/jpeg, 46499B)〕`（delivered，审计 `accepted/injected`）。
- **⭐ 验收核心（astra 硬标准「只有路径进注入正文不算通过，下载成功也不算通过」）**：模型用 pi 内建 **`read`** 工具读该 jpg（transcript 中 `read.arguments.path = …/18aac6b9….jpg`）→ **复述出图中文字 `test-9f3a`** ⇒ **验收成立**。**两个前置（缺一不成立）**：① 会话模型必须多模态——`models.json` `mimo-v2.6-flash` `input:["text","image"]` ✓（**纯文本模型下 read 仍返回附件但模型看不见，验收不成立**）；② 注入正文只有路径、**无"读图"指令** ⇒ 必须**另发一条文本**（如「读出上一条附件图片里的文字」）触发 read。
- **机制与边界（固化进 Wiki）**：gate = `wechat-bind.ts#L270 readWechatArtifactConfig`（`=== true`，never-throw fail-closed）；落盘 `<runtimeDir>/wechat/artifacts/files/<sha256>.(jpg|png)`（原子写 tmp→rename + 0600 尽力位 + L4-S3 `sweepStaleTmp` 清 >1h 明文残留）；注入后缀 = `wechat-input.ts::artifactSuffix`，形状门 `ARTIFACT_REF_RE`（投影侧 `server.ts` 同一常量 = L4-S4），后缀绝无 base64/URL/key；**已知边界**：pi `read` 把**渐进式 JPEG / 动画 PNG 读成乱码**（pi 读侧行为）、**artifacts 明文长期保留、无 GC/配额（= M2 R1）**、语音/文件（type 3/4）仍只进 quarantine 不下载。
- **残余（M2/M3 待做）**：R1 artifacts 保留期限/容量/清理 + 孤儿回收；R4 下载 host IP 段复验；R5/R6 CLI/GUI 开关与 quarantine 徽章；R8「只落盘不注入」子开关；U8 下载耗时/体积常数回采；**M3 语音/文件入站**（silk 非图片 ⇒ 需转写机制，`read` 用不上）。
- **文档**：Wiki `Wiki/Architecture/wechat-ilink-channel.md` 新增「入站图片附件 M1」章节（启用配置与免重启语义 / 落盘规格 / 注入正文形状 / 模型读图机制〔内建 read + 多模态前置〕/ 真机验收证据表 / 已知边界）+ Summary、Current Contract、Evidence、Open Questions、frontmatter `source_paths`/`updated` 修订；`wiki-nav rebuild`；Recent Work **Item 50**；收尾报告 `plans/0928_wechat_artifact_M1_wrapup_report.md`（含 M2/M3 残余与「发语音/文件」移交要点）。**本条目零生产代码改动。**

## [Unreleased] — 2026-09-25 (微信出站收件授权 P0：`005410a` + L4 建议修〔本提交〕)

- **授权集合与入站解耦（P0，用户已批准推翻信任假设）**：广播收件人 = `knownChats()` **候选池** ∩ **授权集合**（绑定 owner `credentials.ownerOpenId` ∪ `channels.wechat.reply.allowOut` 显式订阅，**缺省 `[]`**）；入站 `input.allowFrom` 与 rejected 记录**不参与**出站裁决（读/写/裁决三路零耦合，`wechat-outbound-auth.ts` 全文不出现 `allowFrom`/`knownChats`）；`allowOut` 三态 fail-closed（缺失/非法/坏文件均只收缩，`wechat-bind.ts::readWechatReplyConfig`）；HTTP 面**无任何端点可写 `allowOut`**（只能改配置文件）。
- **发送前二次复核（现读当前授权，非入队快照）**：watcher 每轮现读 `ownerOpenId+allowOut`，门序 `enabled → 授权 → mode → attempts → TTL → connected`；入队后撤权/换绑的旧 pending 下一轮即 `failed(broadcast-unauthorized)`（`attempts=0`、终态 CAS 不可复活）+ `event:"denied"`（掩码 fromId + 具体 `authz`）审计；hook flush 侧先过滤候选池——全拒 → `no-authorized-recipients` 零 intent，部分拒 → 单行 `recipients-filtered{authorized,denied}`。
- **`reply.mode` 缺省翻转 `broadcast` → `reply-only`（0925 P0 复裁）**：显式开启 ⇒ 缺省必须不开播 ⇒ **升级即停播**：存量无 `mode` 键的配置升级后不再广播，须显式 `mode:"broadcast"`；远程 `/wechat reply off → on` 也不再隐式开播（需同时 `reply mode broadcast`）。本仓 `config.json` 已显式 `reply-only` ⇒ 当前部署零影响。
- **L4 建议修 S1–S6（`plans/0925_p0_outbound_auth_l4_review.md`：PASS-with-fixes，0 阻断）**：S1 `/v1/wechat/reply/status` 白名单增 `broadcast-unauthorized`/`broadcast-expired` + `event:"denied"` 并入失败列表（**策略拒绝不再投影成泛化 `send-error`**）+ 投影断言入 `_test_runtime_host_server`；S2 本条与 0924 广播条目改写（原「缺省开启/升级即开播」与现状相反）；S3 Wiki「出站广播」整段改写并标 0925 P0 复裁；S4 `_test_wechat_reply` 过期注释；S5 残余文档化（`enabled=false` 全关期间撤权 pending 不终态、无审计行，重开时授权门最先执行）；S6 `test:wechat-broadcast`/`test:wechat-outbound-auth` 登记进 npm test 族。
- **验收**：`_test_wechat_outbound_auth` 7 组 / `_test_wechat_broadcast` 18 组 / `_test_wechat_reply` 22 组 / `_test_wechat_remote_command` 22 组 / `_test_runtime_host_server` + `node ./scripts/check-extension-load.mjs` 全绿（`timeout 300 npx tsx` 本机实跑）。
- **文档**：Wiki `Wiki/Architecture/wechat-ilink-channel.md`「出站广播」整段改写（0925 P0 复裁） + `wiki-nav rebuild`。

## [Unreleased] — 2026-09-25 (微信媒体探针**第四轮出站补测 + 人工确认收口**：`56e5088`；只改探针 + 文档，生产代码零改动)

- **Phase ③ 最终结论**：**入站媒体（P1/P7）与出站媒体（P5/P6）规格均已真机定稿**——研究 §7 的依赖 **M1 ← P7** 与 **M4 ← P5→P6** 全部勾销，可开始 media gateway 实现（形状已锁，禁止在 P6 通过的形状外新增字段）。
- **四条最终判定（证据形态 = B + 人工确认，用户逐条原话入档 `plans/0925_wechat_media_probe_results.md` §11.5）**：① **P3 同 `client_id` 双发 → 手机只收到 1 条 ⇒ 服务端按 `client_id` 去重：同 id 双发只投递 1 条**（W3a E-2 遗留问题最终答案）；② **P8 URL →「链接收到了」⇒ 原样发出且被渲染为链接形态**（可点性因非真实站点不可验、卡片缩略图仍 U）；③ **P6 出站发图 → 1×1 纯色 PNG 已收到 ⇒ 出站发图端到端通过**；④ **P2 4001 字符 → 用户「不太确定」⇒ 保留半边结论：服务端 `ret=0` 接受（B），微信端截断仍为 U（不硬下结论）**。
- **契约级推论（广播/回复都适用）**：服务端按 `client_id` 去重 ⇒ **广播给多收件人必须 per-recipient clientId**，否则不同收件人因共用同 id **互相去重吞掉**；已实现的 `deriveBroadcastClientId(roundId, toUserId)`（`extensions/channel-wechat/send.ts#L72-L74`）**被真机验证为必要且正确**（本页 Open Questions ⑤ / 广播 ③ 由此关闭）。
- **出站媒体规格（B，三段全通）**：`POST /ilink/bot/getuploadurl`（单键 `upload_full_url`）→ **AES-128-ECB + PKCS7 密文 `POST` `application/octet-stream`** → **`x-encrypted-param`（480B）= `encrypt_query_param`**（无需 PUT / 无 `upload_param` 分支）→ `sendmessage` **`item_list` 只放媒体项**（**caption 必须单独发一条文本**，同条 = `ret=-2 invalid arguments` n=2 否证）、`media:{encrypt_query_param, aes_key:base64(hex32), encrypt_type:1}`、`mid_size`=密文字节、**不需 `context_token`**。
- **第四轮探针观测面（commit `56e5088`）**：`send --to-last`（收件人反查，openid 不上命令行）、`textLen`/`errmsg`/`itemListLen` 落 `measure.jsonl`、`latestInboxFromId()` 跳过 `@im.bot`（收件人防环）。
- **残余 U（7）**：P2 4001 字符截断 / 入站附件体积上限·长语音·下载耗时·双游标互抢 / 真机 302 实况 / 大媒体·其它 `media_type` / 上传失败·重试语义 / bot 回声·URL 卡片缩略图 / P4-poll+send 429（另：`type=5` 与群·小程序卡片 item 形状未采）。
- **文档**：Wiki `Wiki/Architecture/wechat-ilink-channel.md` 新增「出站媒体规格（第四轮 + 人工确认）」与「`client_id` 去重语义（人工确认）」两节 + 出站协议契约 / 出站 upload 残余 / 广播 per-recipient clientId / Open Questions / Summary / Evidence 修订；`wiki-nav rebuild`；Recent Work Item 49；收尾报告 `plans/0925_wechat_media_probe_wrapup_report.md`（含 media gateway 规格移交清单）。

## [Unreleased] — 2026-09-25 (微信媒体探针 Phase ③ 收尾：`6a72b19`/`9f52a4a`/`d724f6a`；**只改探针，生产代码零改动**)

- **入站 item type 矩阵（B 级真机）**：`1`=文本(`text_item`) / `2`=图片(`image_item`) / `3`=语音(`voice_item`) / `4`=文件(`file_item`)；**链接作为文本处理（无独立 type）**；信封 `{message_type, message_state, hasContextToken, hasGroupId}`（实测 1/2/true/false）；item 公共键 `create_time_ms/update_time_ms/is_completed/msg_id(string)/button_item_list/at_bot_username_list`，id 双层（信封 `message_id:number` / item `msg_id:string`）。
- **字段形状（实测与官方指南 C 级描述不符——高价值发现）**：附件 URL/key 在**嵌套 `media.full_url` / `media.aes_key`**（非平铺），图片另有顶层小写 `aeskey`；尺寸用 `mid_size/thumb_*/hd_size/len`（无通用 `size`），`file_id`/`media_id` **未观测到** ⇒ 指南的平铺 `image_item:{file_id,url,aes_key}` 不成立；43 行脱敏签名覆盖四类（`voice_item` 另有 `encode_type/bits_per_sample/sample_rate/playtime/text`，`file_item` 另有 `file_name/md5/len`）。
- **AES key 格式（关键结论，6/6 一致）**：`media.aes_key` = **base64（len44 带 padding）→ 32B ASCII hex 文本 → 16B key（即 `base64(hex32)` 双层）**；顶层 `aeskey` = **hex（len32）→ 16B**，与前者字符串不同但**派生同一把 key**（`sameDerivedKey:true`）；`file_item`/`voice_item` 无顶层 `aeskey`。**解密 = AES-128-ECB + PKCS7**，候选链逐方案试出（非硬编码），**真机 6/6 解密 + 6/6 魔数**（`FFD8FF` jpeg×2 / `%PDF` pdf×2 / `0x02#!SILK_V3` silk×2）；指南「aes_key = 32hex 或 16B base64」两种说法均不成立（旧 `parseAesKey` 据此判「格式无效」是第二轮失败根因）。
- **CDN 边界（B）**：6/6 host=`novac2c.cdn.weixin.qq.com` 命中 allowlist 后缀 `.qq.com`、**hops=0**（未见 302）；探针下载 `redirect:"manual"` + 每跳复检 `isHostAllowed`（≤3 跳），**302 越域 stub 实测被拒**（`host-not-allowed hops=1`）+ 初始越域 `hops=0` 审计；落盘名安全化（中文保留、`../` → `_`）。**生产侧仍无下载/解密代码（M1 范围）**。
- **出站 upload（硬门 P5 通过，B）**：`POST /ilink/bot/getuploadurl` **存在**（200 + 单键 `upload_full_url`，816B 预签名 URL，host 命中 allowlist；坏/无 token → `errcode=-14`、空 body → `ret=-2`）；`POST /ilink/bot/upload` **404 ⇒ 两段式**（D 级分歧收敛）；OPTIONS 被当普通请求处理（**不能用 OPTIONS 判方法支持**）。**仍未测（U）**：CDN 密文 POST/`x-encrypted-param`、`sendmessage` 带媒体 item、是否强制 `context_token` ⇒ **P6 取证前不写任何出站媒体生产代码**。
- **取证手段新增（B）**：`getupdates` buf 内层 seq 回退 → 服务端按 seq **只读回放**保留窗口历史（单批 ≤20，空 buf 0 条、无关 buf `ret=-3`）；`listen --replay-seq N` 忽略 seen 去重、**落盘游标只进不退**、不回写过期 `context_token` —— 无需用户重发即可重取历史附件样本。
- **残留 U 项（10）**：P6-cdn / P6-send / P2 长度 4000·4001·8000 / P3 同 `client_id` 双发去重 / P8 URL 渲染+回声 / P4-poll+send 429（读端点并发已测 3× 无 429）/ 真机 302 实况 / 附件体积上限·长语音·probe 与 worker 游标互抢 / `type=5` 与群·小程序卡片 item 形状 / 是否强制 `context_token`。前 5 项阻塞在**需用户同意**。
- **验收与纪律**：`key-format.json` `conclusion{decryptOk:"6/6", magicOk:"6/6"}` 与报告 §10 一致；`items.jsonl` 43 行覆盖四类签名；stub 回归 35/35 PASS、key/URL/token 泄漏 grep 0；本轮**零 `sendmessage`、零上传、零生产代码改动**。
- **文档**：Wiki `Wiki/Architecture/wechat-ilink-channel.md`（新增「入站媒体与附件规格（真机实测 2026-09-25，媒体探针 Phase ③）」+ frontmatter/Evidence/Open Questions/Summary 互链）；Recent Work Item 48。

## [Unreleased] — 2026-09-25 (local-master-ensure：`0586030`/`f5a9b90`)

- **能力（双入口，幂等 ensure）**：工具 `local-master-ensure`（`master-tools.ts:739`）+ 同名 slash `/local-master-ensure <cwd> [--no-wait] [--timeout <ms>]`（`index.ts:2194`）——同一四层门、同一 `ensureLocalMaster()` 编排、同一审计（`ensure:tool`/`ensure:slash`）。语义 = **幂等“确保活着”而非强行接管**：三段 = precheck（活 owner → `already-running` 零动作零状态写）→ in-flight `wx` first-wins（窗口内重调 `launched(in-flight)` 零第二个 spawn）→ spawn **可见 WT tab**（`spawnPiTab`，taskId `lms-<scope>`、账本 dispatch+link、wt 缺席零账本、失败回写 `launch_failed`）后轮询就绪。参数 `{cwd, waitForReady?=true, timeoutMs?=60000}`，`clampEnsureTimeout` 上限 180000/下限 100ms/非法回落缺省 → 七态 `already-running|launched|ready|spawn-failed|timeout|invalid-cwd|stalled`（`invalid-cwd/spawn-failed/timeout/stalled` 为错态）。
- **零新增权力（核心）**：生产代码零 `attachMaster`/`forceStale`/`token`/`cutover`/`detach` 调用、attachment 只读、**不写 attachment 不代替 attach**——认领一律由新会话 `session_start` 既有静默路径（`silentScopeGenesis`/`takeoverStaleScopeOwner`）完成；bootstrap prompt（`buildLocalMasterBootstrapPrompt`）无 token、不指示 forceStale、负向禁碰 global 且禁调 master-attach/detach/transfer/cutover；**免二次确认（用户裁定）**，靠 USER_DIRECTIVE + 可见 tab + 防重 + 审计 + precheck 幂等。
- **四层授权合取（缺一即拒，两入口同）**：① `isSubagent()` execute/handler 首行硬挡 + `DEFAULT_EXCLUDE_TOOLS` 含 `local-master-ensure`（`runner-argv.ts:26`）② `localMasterEnsureGate`（`master-tools.ts:314`）复用 `masterDispatchGate` 口径——main session 或 global master owner 放行，tab/not-owner/unknown 拒 ③ 只收 `cwd`（不收 scope/地址，防指向混淆；必须存在且为目录 → 零 spawn 零状态写）④ 描述带 `USER_DIRECTIVE`（slash 面补「仅在用户明确要求时使用」，L4-S5）。
- **就绪判据（严格六条 + #A claim 观测）**：`liveness && attachment && 同 sessionId && 同 generation && isProcessAlive(pid) && launchAt < liveness.updatedAt`；再加 #A 的 `attachment.generation > precheck 快照`（不成立 → `claim-not-observed`）。`ensureStatusForReason` 把 `no-liveness/no-owner/claim-not-observed` 归 **`stalled`（判据证据不足，不猜）**、其余归 `timeout`（带快照、不杀 tab）；`stalled` 回执指引人工 `/master-attach --local --force-stale --confirm`（工具不代持）。
- **in-flight 与审计**：`state/local-master-launch/<scope>.json`，`openSync(wx)` first-wins，窗口 = 首次认领时的 `timeout+30s` 且**落盘 `windowEndsAt` 以盘上值为准**（属那次 spawn，不按后续调用方 timeout 现算）；非 EEXIST 写失败 **fail-closed 不认领**；`ready`/`already-running`/`spawn-failed` 关窗，`timeout`/`stalled` 留窗口自失效。审计 `state/local-master-ensure-audit.jsonl` **每次调用（含被拒）一行，恰六字段 `{at,by,cwd,scope,action,result}` 无正文**，`result` 为受控枚举。
- **#A 消费循环注册语义（Wiki 重点事实）**：scope 消费循环注册点**唯一** = `mailbox-consumer.ts::registerScopeWakeLoop()`（`session_start` 处理块内 `setInterval(30s)`），全仓接线仅 `index.ts:1945`；**认领 ⟺ 注册**（同一处理块，`if (!att || att.sessionId !== sid) return` 才不注册）；`triggerOwnershipRecheck()` 只补注册**全局** watcher；**手动 `/master-attach --local` 不经过 `session_start` → 不注册 scope 消费循环**（L4 独立验证；限定：到下一个 `session_start` 才补）⇒ ensure 的 `ready` **必然注册**，也是「死仓信件永远 pending（没有消费端在跑）」的机制解释。
- **L4 必须修 + 建议修（`f5a9b90`）**：M1 slash 解析抽成导出纯函数 `parseLocalMasterEnsureArgs()`（flag/位置参数任意顺序，`--timeout 5000 C:\repo` 不再取 `cwd="5000"`）+ L 组 4 例单测 + K 组静态接线断言；S1 marker 非 EEXIST 写失败改 fail-closed；S2 窗口 `windowEndsAt` 落盘 first-wins（回写 runId 保留该字段）；S3 测试挂 `process.on("exit")` 清理；S5 slash 描述对齐；S7 显式调 disposer。变异验证：还原 M1/S1/S2 → 对应测试立即 FAIL。
- **已知残余（诚实清单，来自 L4）**：in-flight 窗口竞态残余（**“窗口不落盘/按调用方 timeout 现算”已由 S2 修复**；残余 = 窗口过期撞车仍可能开第二个 tab、无全局并发/速率上限，attachment 层 CAS 单赢）；**僵尸 attachment 处置保守（只报不删，零删改/归档，阶段二 `assumeStale+confirm` 与阶段三 `/master-registry-health` 未做）**；claim 观测极窄盲区（轮询窗口内人工 `--force-stale`/transfer attach 推进 generation → 可能 `ready` 而该 owner 不消费）；`no-liveness`/`identity-mismatch` 僵尸只能如实 `stalled`；人工 attach 不注册消费循环属**既有缺陷**（另案）；端到端真 spawn 手测（L4-S6）与 bootstrap tab × `reclaim-tabs` 交互未实测。
- **验收**：`_test_local_master_launch.ts` **23 组断言块全绿**（四层逐层拒绝 / 幂等零动作 / invalid-cwd 零写 / in-flight F–F4 / ready 与 stalled 不猜 / claim 观测 / #A J1–J3 / 审计六字段 / 双入口 + 注册点静态耦合 / slash 解析 4 例；L4 变异 4/4 被捕获）；回归 `_test_local_master`/`_test_runner_tools`/`_test_runtime_master_dispatch`/`_test_runtime_host_server`/微信 reply·broadcast·remote_command/`check-extension-load` 全绿；L4 `plans/0924_local_master_ensure_l4_review.md` **PASS-with-fixes**（M1 + S1–S7 已闭环，S6 留人工）。
- **文档**：Wiki 新建 `Wiki/Architecture/local-master-ensure.md`（含 #A 节与已知残余），`Wiki/Decisions/local-master-claim.md`（补“认领 ⟺ 注册 / 手动 attach 不注册”句 + 互链）、`Wiki/Architecture/wake-roundtrip-ack.md`（互链）、`Wiki/_index.md`（导航）；Recent Work Item 47。

## [Unreleased] — 2026-09-25 (微信远程斜杠命令旁路：`488e942`/`ebb9e04`)

- **旁路（零 LLM、零转写污染）**：微信私聊里的 `/xxx` 在 host 侧 `wechat-input` 写 outbox **之前**被会话消费端 `wechat-command-consumer.ts::scanWechatRemoteCommands` 拿下——inbox 记录标第三终态 `state:"consumed"`（`channel-wechat/store.ts` 读回透传，承重），零 outbox 项、零 `sendUserMessage(用户原文)`；回执 = `kind:"command"` 的 reply intent（id `sha256("wechat-command:"+msgId)`、clientId `sha256("wechat-command-client:…")`），由**既有** watcher 发出（三门只对 broadcast 生效 ⇒ 与 reply 同待遇），不产生 turn ⇒ 不进广播环路（防环）。消费节拍 = `session_start` 起 fs.watch **立即扫描（无 debounce）** + 5s tick 兜底（host 侧 debounce 200ms）。
- **注入点双防护（L4-M2 必须修 `ebb9e04`）**：`runtime-host/wechat-input.ts::tryInjectPending` 在 `channels.wechat.remoteCommands.enabled===true` 时先 `classifyRemoteCommand`，`kind !== "not-command"` → **按序跳过**（不饿死后续普通文本）→ `return {injected:false, reason:"command-shaped"}` + 审计（不改终态、不写 outbox）——裁定③「未知 `/xxx` 绝不回落成文本注入」改为**结构性 fail-closed**，不靠消费端抢跑 200ms，覆盖冷启动 5s 窗口 / 会话门失败 / dedupe 重投。
- **归一化防绕过（L4-M1 必须修 `ebb9e04`）**：`classifyRemoteCommand` 入口先 `normalizeForClassify`（NFKC → 剔零宽/不可见字符 → trimStart，只作用于分类副本）再分类；归一化后以 `/` 开头但首 token 解析不出命令名（`//x` `/_x` `/1x` `/-x` `/reload/`）→ **显式 deny(unknown)** 不落 `not-command`；`/`、`/ ok`、两段路径（`/etc/passwd`、`/tmp/f.txt`）保留 `not-command`（L3 行为不变）。**绕过矩阵 15/15 全挡**（前导空白/全角斜杠/全角字母/ZWSP/首字符非字母/尾斜杠/shell 带前导空白），端到端 15/15 `consumed` + 零 outbox + 零用户原文派发，M2 注入门下连跑 3 轮仍 `command-shaped`；**8 条正常文本零误伤**。
- **分级白名单（裁定①②③）**：safe（`/wechat status`、`/wechat reply mode|on|off`）｜sensitive（`/reload` `/compact` `/model <id>` `/thinking <lvl>` `/wechat on|off`）→ **免确认直接执行**（无 nonce/确认，审计 `tier=sensitive` 只记首 token）｜danger 恒拒（shell 形态：`!` `;` `|` `&` `$(` 与反引号开头；`master-*`；`new/fork/clone/resume/quit/login/logout/trust/export/import/share/yolo/approve/deny/rm/sh/bash/exec/shell/sudo`、**任何含 `:` 的名**（永不展开））→ 回执「该命令不支持远程执行」；未知 `/xxx` → ``Unknown command `/xxx`…``（对齐 Hermes），**零 `sendUserMessage`、零 outbox**；参数非法 → 第三种文案 `用法：…`。首 token 精确匹配 + 参数枚举校验，参数永不进 shell（零 `child_process` 面）。
- **配置门与双轴授权**：`channels.wechat.remoteCommands.enabled` **缺省 false（fail-closed）**，`wechat-bind.ts::readWechatRemoteCommandConfig`，坏 JSON/`"true"`/`1` 均 false；与 Hermes fail-open 刻意相反）——关闭时消费端零 IO 零副作用、记录留 `pending`、注入器不 classify，**行为精确回退今天**；与 `input.enabled` 解耦（只看 `remoteCommands.enabled` + 轴一）。双轴 = `channels.wechat.input.allowFrom` ∪ owner openid（全等）× 命令白名单；会话门 = global master owner 会话，subagent 恒拒；轴一未授权 → 不 claim、交回注入路产生既有 `not-allowlisted`。
- **幂等与执行面**：收据 `wcmd:<sha256(msgId)>` first-wins（命名空间避开 `outbox:`/`run-`/`msg:`/`cmd:`）；顺序 = 标终态 → claim → 执行 → 回执落盘 → `defer()`（回执先落盘再 reload，防 ctx stale）。配置类直连 `wechat-bind` 同步写盘；会话类经内部命令 `/wechat-remote-run` + `sendUserMessage(…, {expandPromptTemplates:true})` 派发（S3：未注册即 no-op，不跌落成普通 user 消息）。**运行时依赖：pi ≥ 0.87**（仓库 devDep 0.80.6 硬编码 `expandPromptTemplates:false`；已写入 README §2 Runtime requirement）。
- **S1–S6 已闭环 `ebb9e04`**：S1 TOCTOU（`raw.state !== "pending"` 即让位）；S2 command intent 豁免 `reply.enabled` 门（否则 `/wechat reply off` 吞掉自身回执，reply/broadcast 门零改动）；S3 `registered` 旗标；S4 版本声明；S5 头注释补崩溃反向窗口；S6 `/v1/wechat/quarantine` 响应增 `commandAuditLines`。
- **已知残余（诚实清单）**：崩溃反向窗口（回执已写而 `defer()` 未跑 → 告知已执行实际未执行，收据已耗永不重试，不改写已落盘回执）；崩溃正向 = at-most-once 丢失不重放；消费端不在线时命令滞留 `pending`（M2 保证不被注入，但未执行无回执）；未授权命令形态交回注入路 → 既有 `not-allowlisted` 终态（不补投）；命令审计在独立文件 `state/wechat-command-audit.jsonl`、诊断只回行数；GUI 无 `remoteCommands.enabled` 开关且 inbox 徽章显示字面 `consumed`；`/model` 存在性只在本地校验、回执措辞保守「已请求执行」；真机会话内派发未实跑；全角 `！`/`；` 开头中文散文与 `/tmp file.txt` 类会误伤（前者 danger、后者 Unknown，均回执告知）。
- **验收**：`_test_wechat_remote_command.ts` **22 组断言块全绿**（含 15 条绕过矩阵 T14/T15/T16 + T17 冷启动 + T18/T19/T20）；回归 10/10（reply 22 / broadcast 18 / input 14 / input_set / message_outbox / outbox_latency / receive 7 / bind 12 / runtime_host_server / check-extension-load）；变异测试（还原 M1、关 M2 门）→ exit 1，非恒绿。L4 `plans/0924_wechat_remote_command_l4_review.md` **PASS-with-fixes**（2 必须修 M1/M2 + 6 建议修 S1–S6 全部采纳闭环）。
- **文档**：Wiki `Wiki/Architecture/wechat-ilink-channel.md`（新增「远程斜杠命令」节）；Recent Work Item 46。

## [Unreleased] — 2026-09-24 (微信出站广播：`0a2b292`/`0337aac`)

- **出站广播（0924 上线时缺省开启；0925 P0 复裁后缺省已翻转为 `reply-only`，见顶部 0925 P0 条目）**：`channels.wechat.reply.mode="broadcast"` 时 global master 会话每轮 `agent_settled` 把该轮末条非空 assistant 原文（`>4000` → `slice(0,4000)+"…[截断]"`）发给**授权收件人**（0925 P0：候选池 = 已曾入站私聊，授权 = 绑定 owner ∪ `reply.allowOut`；0924 当时为「全部已曾入站私聊」）；`"reply-only"` = 完全回旧行为（marker 路径逐字节不变）。`reply.enabled` 仍是总开关（缺省 true）。
- **资格**：`channels.wechat.reply.sessionScope` 缺省 `"owner"`——`readAttachment(masterAddress())?.sessionId === getCurrentSessionId()`；attachment 读不到/不匹配 → fail-closed 不广播（审计 `master-attachment-unavailable`/`not-master-owner`，本会话无暂存时静默不落行）；另有 `main`/`any` 取值；subagent 一律不广播。
- **触发**：`agent_end` 只暂存（每次覆盖 = 本轮最终态），`agent_settled` 才 flush 出意图；flush 无暂存（如 Esc 中断路径）→ 审计 `no-stash`；暂存会话 ≠ settled 会话 → 丢弃 + `stash-session-mismatch`。
- **收件人（0925 P0 修正）**：候选池 `WechatStore.knownChats()`（inbox 全量 → 滤空 fromId 与 `@im.bot` → fromId 去重保序，最近入站优先）**∩ 授权集合（绑定 owner ∪ `reply.allowOut`，入站 `allowFrom` 不参与）**；**群消息天然不进 inbox**（parser 对 `group_id` 非空直接 quarantine）；候选池空 → 审计 `no-known-chats`、零 intent；授权全拒 → `no-authorized-recipients`、零 intent。
- **身份派生**：roundId = `sha256(sessionId:firstUserTs??"no-ts":sha256(firstUserText))`；intent id = `sha256("wechat-broadcast:"+roundId+":"+fromId)`，per-recipient clientId = `sha256("wechat-broadcast-client:"+roundId+":"+toUserId)`；一个 intent 一收件人（`kind:"broadcast"`，旧文件无 kind 兼容为 reply）；同轮 `linkSync` EEXIST 幂等不重发、不同轮按 `createdAt` 升序排队。
- **发送门序（watcher，顺序即契约；reply/command intent 不受 mode/TTL/connected 门约束）**：① `reply.enabled`（command 回执豁免）→ ② **收件授权二次复核（0925 P0）**：未授权 → `failed(broadcast-unauthorized)` + `event:"denied"` 审计、`attempts` 不动 → ③ mode 非 broadcast → broadcast intent 整轮跳过（保留 pending、零审计）→ 共用一次机会规则 `attempts>=1` → `unknown(attempts-exhausted)` → ④ TTL `BROADCAST_INTENT_TTL_MS=10min`（`createdAt` 不可解析也判过期，fail-closed）→ `failed(broadcast-expired)`，**先于** ⑤ connected 门（`status!=="connected"` → 审计 `channel-not-connected`、保留 pending 排队续发）。失败语义 per-recipient、一次机会不自动重试。
- **回滚**：`reply.mode="reply-only"`（hook 立即弃暂存 + watcher 跳过残留 pending 广播 intent——秒级止发且不丢）或 `reply.enabled=false`（全停、pending 保留）。CLI `/wechat reply mode broadcast|reply-only`；`/wechat status` 含 `mode=`/`scope=`；`GET /v1/wechat/reply/status` 响应含 `mode`。
- **已知近似（诚实记录）**：`receive/state.json.status` 是**接收 worker** 健康而非发送能力（worker 死但 token 有效时保守不出站）；配置文件整体坏 fail-closed 到 `reply-only`；roundId 无时间戳且同会话同文碰撞会吞第二轮（吞而不覆盖）；**升级即停播（0925 P0 复裁，与原条目相反）**：存量无 `mode` 键 → 缺省 `reply-only`，升级后不再广播，须显式 `mode:"broadcast"`（远程 `/wechat reply off→on` 同样不再隐式开播）；`reply.enabled=false` 全关期间被撤权的旧广播 pending 不终态、无审计行，重新 enabled 后授权门最先执行（先终态再发送）。
- **验收**：`_test_wechat_broadcast.ts` **18 组断言块**全绿（含 M1 回滚止发、TTL 先于 connected 门序、真实 `readAttachment(masterAddress())` 缺省路径）；`_test_wechat_reply.ts` 22 组旧路径红线原样；`_test_message_outbox`/`_test_outbox_latency`/`_test_wechat_bind`/`_test_runtime_host_server` 回归全绿；L4 `plans/0924_wechat_broadcast_l4_review.md` **PASS-with-fixes**（1 必须修 M1 + 5 建议修已闭环 `0337aac`）。
- **文档**：Wiki `Wiki/Architecture/wechat-ilink-channel.md`（新增「出站广播」节 + 修正 stale 句「群消息无法独立识别」）；Recent Work Item 45。

## [Unreleased] — 2026-09-24 (E2.3 单点翻转落地：`22e398a`/`f89abdb`；**G-B 完成**)

- **单点翻转落地、缺省仍 v2（opt-in 逃生舱）**：`autonomy/collect.ts` 的 frontier 数据源改为按 env `PI_AUTONOMY_FRONTIER_SOURCE` 单点二选一——`trim()==="graph"` 才走 Graph（`readGraphSnapshot`→`toFrontierInput`），**缺省/其它任何值 = v2**（`collectGlobalView`）。**不写 `config.json`**、不新增 `collectAutonomyInputs` opts、`graph/**`/`autonomy/frontier.ts`/`protocol.ts`/`index.ts`/`package.json` 零改；单 commit 可 revert（`git revert 22e398a` 即回 v2，无状态迁移）。
- **参数分叉防护**：graph 路经 graph-only helper `graphFrontierSnapshot` 派生 `agentDir = opts?.agentDir ?? defaultAgentDir()`，并**显式传 `tabRunsDir`/`sessionsRoot`/`timersDir`**——否则 `readGraphSnapshot` 缺省 `PI_TAB_RUNS_DIR || defaultTabRunsDir()`（`graph/collect.ts#L58-L62`）会与 v2 的 `join(agentDir,"tab-runs")` 分叉；`journalPath` 不传（生产默认）。
- **v2 分支形状保持（L4 必须修 `f89abdb`）**：v2 分支字面量为 `collectGlobalView({ agentDir: opts?.agentDir, now })`——**不在共同分支预先解析 `agentDir`**，使 `defaultAgentDir()` 仍归 `collectGlobalView` 自己的 `try`（缺省生产行为与异常边界逐字节不变；S22 源码形状 + 异常边界用例钉死）。graph 分支的 `defaultAgentDir()` 归外层 try（opt-in 路，有意不对称）。
- **`frontier.json` 两版 schema 兼容**：两路都由同一个 `buildFrontier` 产 `FrontierSnapshot`，`readFrontierSnapshot` 仅校验 `asof/projects/triggers/baseline`；不清空 `prev`，双向切换共用同一文件。
- **验收**：`_test_graph_frontier_shadow.ts` **28 checks，exit 0，`frames=33 rows=623 same=623 unexplained=0 explained=0`**（S18 缺省=v2 含写出 `frontier.json` 原始文本 + watchdog/audit / S19 graph 等价 + 序指纹 / S20 decoy `PI_TAB_RUNS_DIR` / S21a 非 graph 值=v2 / S21b enabled=false 零行为 / S22 `agentDir` 未传形状与异常边界 / S23 graph flag `pidAlive=false` `runStateMismatch` 端到端）；`E22_REVERSE_SELFTEST=1` **29 checks**、`unexplained=1`；删 `tabRunsDir:` 行实验 → exit 1（S19+S20+S23 FAIL）；`_test_runtime_autonomy.ts` 57（A10.1 ALLOW 仍恰 3）/ `_test_graph_frontier_input.ts` 15/15 / `_test_frontier_attention_window.ts` 18 / `_test_runtime_graph.ts` 13/13 / `_test_graph_carriers.ts` 5/5 + `test:global-view`/`runtime-projector`/`workstream`/`snapshot`/`tab-runs`/`runtime-wake`/`local-master` 全绿；L4 `plans/0924_graph_E2_3_l4_review.md` **PASS-with-fixes**（1 必须修 + 建议修已闭环）。
- **文档**：Wiki `Wiki/Architecture/work-graph-read-only-projection.md`（「E2.3 单点翻转契约」节，**G-B 完成**）；Recent Work Item 44。

## [Unreleased] — 2026-09-24 (E2.2 影子对照 harness：`de84baa`/`154bf8d`)

- **影子对照证明 Graph 派生输入与 v2 生产输入语义等价；硬门 `unexplained=0` 且 `explained=0`**：新增测试态 `extensions/_test_graph_frontier_shadow.ts`（G-B 核心验收件）——同一 fixture、同一 `(backlog, prev, now)` 下逐项对照 v2 生产路径（`collectGlobalView`→`buildFrontier`）与 graph 路径（`readGraphSnapshot`→`toFrontierInput`→`buildFrontier`），产 O-B 行（五源 snapshot/project/run/trigger/recordOnly）。实测 `frames=33 rows=623 same=623 triggerRows=10 unexplained=0 explained=0`（21 checks，exit 0），全 33 帧 `next`/`diff` canonical 全等 → **E2.3 翻转硬门证据**。
- **双硬门（不可协商）**：`unexplained=0` **且** `explained=0`（`WHITELIST=[]` 空集——G-A 后任何差异都是真差异，`explained>0` 即「白名单塞未批准条目」）；canonical 序只消序不抹值（对象键递归排序 + `triggers` 按 `rule|project|evidence`、`details` 按 `runId|repoPath`，下标序不参与）。
- **篡改反向实验证明非恒真假绿**：graph-only 输入注入 `attentionByRepo[首个正键]:=0` → 进程 **exit 1**、`unexplained=15 explained=0`（S2/S3/S4/S6/S11/S12×4/S13/S16/S17 失败）。已落成受控自检 `E22_REVERSE_SELFTEST=1`（缺省关闭；篡改 graph-only 输入 → 断言必报 `unexplained>0`，判别力有效时 exit 0），供未来改 canonical/verdict 时复验。
- **零行为**：测试态临时 `PI_RUNTIME_DIR`/`PI_TAB_RUNS_DIR` + 显式 `stateDir`；影子行只写 `<tmp>/state/work-graph/shadow.jsonl`，不写生产 `state/autonomy/audit.jsonl`；零生产接线（`index.ts`/`protocol.ts`/`autonomy/collect.ts`/`graph/**` 未动）；A10.1 排除列表 +1 行，ALLOW 仍恰 3。
- **E2.2 L4 收尾（`154bf8d`）**：S8a 固定时钟（`dispatchedAtMs = NOW - 60_000`，去 `Date.now()`）；trigger Map 改 `groupByKey` 数组保 multiplicity；S16 显式断言输入分叉（graph 源 journal cwd lower-case vs v2 源账本 cwd upper-case 变体 → 归一键唯一）。
- **验收**：`_test_graph_frontier_shadow.ts` 21 checks（`unexplained=0 explained=0`）；`_test_runtime_autonomy.ts` 57 checks（A10.1 ALLOW 仍恰 3）；`_test_graph_frontier_input.ts` 15/15；`_test_frontier_attention_window.ts` 18；`_test_runtime_graph.ts` 13/13；`_test_graph_carriers.ts` 5/5（golden 未变）；`test:global-view` + `runtime-projector`/`workstream`/`snapshot`/`tab-runs`/`runtime-wake`/`local-master` 全绿；L4 `plans/0924_graph_E2_2_l4_review.md` **PASS-with-fixes**（1 必须修 + 3 建议修已闭环）。
- **文档**：Wiki `Wiki/Architecture/work-graph-read-only-projection.md`（「E2.2 影子对照契约」节）；Recent Work Item 43。

## [Unreleased] — 2026-09-24 (E2.1 Graph → frontier 输入适配器 `toFrontierInput`：`b59ee68`/`513623c`)

- **E2.1 适配器（零接线）**：新增纯函数 `toFrontierInput(snap, {now})`（`extensions/runtime/graph/frontier-input.ts`），把 `GraphSnapshot` 投影为 `FrontierSourceSnapshot`，冻结 E2.2 影子对照输入契约；`autonomy/frontier.ts` 仅类型放宽（`FrontierInputs.snapshot` 改结构化接口，`buildFrontier` 算法体与 v2 调用点零改）。**零生产接线**（`rg -l frontier-input extensions --include=*.ts` 仅命中自身 + 测试）。
- **R4 单一口径勘误**：适配器**直接取 `GraphProjectView.project`**（零转换），**严禁自写第三份 normalizer**；`normalizeRepoKey` ≡ `normalizeExactPath` 逐字节同体（T4 钉死）。T8 源码读取守卫扩为**零路径转换白名单**（新禁 `replace(`/`toLocaleLowerCase`/`function|const|let|var normalize`/`normalize =`），抗改名绕过。
- **三契约落地**：`now` 取自 `opts.now`（必填，不用 `snap.asof`）；`history` 恒 `[]`（MF1，填充会造出 v2 生产从不产的 ②③ hidden 触发）；`attentionByRepo` 只写 `>0` 项（缺项=0，全量无裁剪）。`details` 按 `runId` 升序、重复 `runId` 按 `repoPath` tie-break。
- **T9 结构等价 v2 通过**：同 fixture 下 `buildFrontier(toFrontierInput)` ≡ `buildFrontier(collectGlobalView)`——帧0 `JSON.stringify` **严格全等**、帧1 canonical 全等且含非 mailbox 边沿（`working_to_completed`/`stagnation`/`needs_user`）；T9 fixture 端到端覆盖 `staleOver=true`/`needsHuman=true`/`pidAlive=false`，`FAR_PAST` 改相对固定 `NOW`（不偷读墙钟）。
- **验收**：`_test_graph_frontier_input.ts` 15/15（T1–T15）；`_test_runtime_autonomy.ts` 57 checks（A10.1 ALLOW 仍恰 3）；`_test_runtime_graph.ts` 13/13；`_test_graph_carriers.ts` 5/5（golden 未变）；`_test_frontier_attention_window.ts` 18；`test:global-view` + 6×npm 回归全绿；L4 `plans/0924_graph_E2_1_l4_review.md` **PASS-with-fixes**（2 必须修 + 3 建议修已闭环）。`test:register-graph` 因外部依赖预备冲突（`CONFLICT @earendil-works/pi-coding-agent`）失败，非断言失败；直跑 `_test_register_graph.ts` 通过。
- **文档**：Wiki `Wiki/Architecture/work-graph-read-only-projection.md`；Recent Work Item 42。

## [Unreleased] — 2026-09-24 (G-A frontier ⑤ 语义修复：`93f8447`/`fae1aa2`)

- **latent bug（P0，`cd061cc` 反例）**：frontier ⑤（`needs_user`）曾消费 `snapshot.home/rows`（GUI 分页后投影，生产实参 `page=1/pageSize=20`）→ **>20 仓时页外 attention 仓漏触发 `needs_user`**（21 仓漏 1、40 仓漏 20），且**仅改显示排名会产生假边沿**（出页→入页仓 ⑤ `0→1`）——⑤ 触发集合成了显示排序/页码的函数，而非工作状态的函数。
- **修复**：`collectGlobalView` 暴露**分页前全量投影** `GlobalViewSnapshot.attentionByRepo`（必填 `Record<string, number>`，键=`normalizeExactPath(repoPath)`，仅含 `attention>0` 条目，**缺项=0**，`Σ===totals.attention`）；frontier ⑤ 改为直接消费该投影（`frontier.ts#L201`/`#L216`），⑤ 算法体（`needsUser` 判据 / false→true 边沿）一行未改。
- **GUI 分页契约未变**：`rows`/`cursor`/`formatGlobalView`/`globalViewLogic` 的 tool `details` 逐字节不变（`test:global-view` M1 `small=byte-identical`）；新字段不进 details。
- **迁移**：schema 未变，双向切换共用同一 `state/autonomy/frontier.json`，**不清空 prev**；旧 prev 页外仓首帧每仓**一次性** `needs_user` 补报（已批准，靠既有 wake-gate debounce/cooldown 合并）。
- **机器证据出处**：反例 `plans/0924_attention_window_bug_evidence.md`（四档 19/20/21/40：页外漏检 `0/0/1/20`、假边沿 `0/0/1/1`）；修复后全部归零 `extensions/_test_frontier_attention_window.ts`（18 checks：P0 十条翻转 + N1-N4 + M1/M2/M3 + normalizer tripwire K1）；L4 `plans/0924_attention_semantics_fix_l4_review.md` **PASS-with-fixes**（1 必须修 M2 已闭环）；`_test_graph_carriers.ts` 5/5（T5 golden 仅加性新增 `attentionByRepo` 一个键）。
- **文档**：Wiki `Wiki/Architecture/work-graph-read-only-projection.md`；Recent Work Item 41。

## [Unreleased] — 2026-09-24 (E2.0 Graph 载体对齐 + 共享 carrier 归约：`7672771`/`ed5278a`/`c7b977a`)

- **E2.0 载体对齐**：`GraphRunRef` 增 `gate`/`needsHuman`/`staleOver`/`overdue`/`pidAlive`（缺→null 不猜）；`GraphSnapshot.history` 为**仅观测载体，不参与 frontier 输入**（E2.1 `toFrontierInput` 恒 emit `[]`，MF1）；`state/work-graph/<scope>.json` 只读缓存（唯一写者 `graph/collect.ts`，version + carrier/history 子结构校验，tmp 名含 pid+时间戳+计数器）。仍为影子运行（零生产接线）。
- **共享归约单一真相源**：抽 `extensions/runtime/frontier-carriers.ts`（`reduceTabCarrier`/`collectTimerByRepo`/`classifyDispatch`），`global-view.ts` 与 `graph/collect.ts` **共用同一实现，禁止各写一份**（`global-view.ts` 以 re-export 保持原导出面）。
- **行为保持由 golden 双跑证明**：pre/post `collectGlobalView` 快照逐字节相等；全量 golden 已随 `_test_graph_carriers.ts` 入库（路径归一化 + 固定 now），E2.1 之后仍可复现回归。
- **E2.1 前的 4 条修复已落地**（L4 建议修/遗漏）：① 缓存 carrier/history 子结构校验 + `GRAPH_SNAPSHOT_VERSION` 扩字段必 bump 约定（R5）；② tmp 文件名加 pid+时间戳+计数器防同进程并发冲突（遗漏 4）；③ `buildTabDetail` 注释钉死 gate 前移导致的病态 warning 序差异（R2，选注释方案）；④ before/after golden 基线入库（遗漏 1）。
- **验收**：`_test_graph_carriers.ts` 5/5（legacy oracle 双跑 4 组 + golden）；`_test_runtime_graph.ts` 13/13；`_test_runtime_autonomy.ts` 57 checks（A10.1 allowlist 仍恰好 3）；`test:global-view` + 6×npm 回归全绿；L4 独立审查 PASS（0 必须修）。Wiki `Wiki/Architecture/work-graph-read-only-projection.md`；Recent Work Item 40。

## [Unreleased] — 2026-09-24 (E1 Work Graph 只读关系面 MVP：`d54c09b`/`97ef7e2`)

- **E1 只读关系面 MVP**：新增纯库 `extensions/runtime/graph/{types,project,edges,diff,collect,index}.ts` + `extensions/_test_runtime_graph.ts`（13 组）——既有四对象（Master/Workstream/Task/Run）之上的**只读关系面**：引用式边（`task→workstream` / `run→externalTaskId|subject` / `workstream→repoPath` 弱载体，**不做**声明式 `depends_on`）+ 纯投影 `projectGraph` + `diffGraph(since)`；`collect.ts` 唯一 IO，`graph/**` 零写路径。
- **边界裁定 (a)**：Graph 是既有真相源的**投影与求值器，不是替代者**——不替代 tab-runs 判态机、不写 recentwork、不落盘（`state/work-graph` 归 E2）；影子运行（零生产接线，单 commit 可 revert；`RuntimeSnapshot v1`/`protocol.ts`/A10.1 allowlist 未变）。
- **验收**：13 组测试绿（replay 等价 + 确定性 + 10k 事件 ~15ms）；回归 `test:runtime-projector`/`test:runtime-workstream`/`test:runtime-snapshot`/`test:tab-runs` + `_test_runtime_autonomy.ts`（57 checks）全绿；L4 独立审查 PASS。
- **文档**：Wiki `Wiki/Architecture/work-graph-read-only-projection.md`；Recent Work Item 39；L4 建议修落地（去 `collect.ts` 死参数 `now`、T13 恒等断言→手构期望快照、`isPathShapedRef` 补「含 `/` 非绝对路径」用例）。

## [Unreleased] — 2026-09-24 (local Master 自动交接：`b0ff266`)

- **local Master 自动交接**：`master-transfer` 支持 `--local`（仓库会话持 local 也能自动交接）；后继 prompt 携带 scope（`master-attach({token, local:true})` + 同一 local 地址）；home→local fail-closed；local transfer 不碰 global succession；四要素回报（旧/新 sid12+gen、token 消费时刻）；transfer-window marker 抑制 reclaim/takeover。
- **安全修**：`registry.ts` token attach 一律不得走 genesis（`!existing && input.token → bad-token`，零写）——修前 local token 可在空 global attachment 上认领 global owner。
- 新增 `extensions/_test_local_master_transfer.ts`（T1–T13）。L4 链：首轮 FAIL（7 条）→ 修复 → 窄确认 PASS；global 既有 12 项回归保持绿。

## [Unreleased] — 2026-09-24 (微信出站回复 W3a–W3d：`a282848`/`d4b3ebf`/`b9b6726`/`aab6bf6`)

- **微信出站回复只读状态**：新增 `GET /v1/wechat/reply/status`，鉴权后受 `wechat.enabled` 闸保护，投影回复意图计数/最近时间/安全错误摘要；GUI Channels 页新增始终可见的只读卡（401/403 也可见），关闭开关引导 TUI `/wechat reply off`，GUI 不提供写操作。
- **文档收尾**：README 记录回复开关、意图目录和脱敏审计文件；Wiki 补真机校准出站协议契约与未验证项；Recent Work 追加 Item 36。
- **真机校准**：sendmessage 返回 HTTP 200 + `{message_id}`，无 `ret`/`errcode`/`errmsg`；`client_id` 去重尚未定论，长度上限/429/回声未验证。

## [Unreleased] — 2026-09-24 (hotspot v4: ephemeral working set)

- **热点层 v4 重做（`8a9f09a`）**：Hotspot 从「Wiki 路由缓存（主题 → Wiki 切片/符号/证据，`hotspot` 工具 read/upsert/remove 托管 `Wiki/_hotspot.md`）」整体重做为「短期工作集 projection（task/workstream → 最近读/写/测试文件）」。定位：cache 不是 memory——可丢失/可重建/非权威/短 TTL（半衰 12h、soft 48h、hard 72h）/非阻塞（全静默失败，丢失不影响编码/Master/Timeline/Wiki）。
- **新增**：`decay.ts`（`score(t)=score·2^(−Δt/12h)+w` 纯函数 + TTL 判定）；`collect.ts`（工具事件采集：edit/write 成功→3、read 成功→1、bash 保守单文件 test→2；失败/broad scan（grep/find/ls 白名单外）/hotspot 自身不计；同 run 每文件每 kind 上限 read4/write3/test2；tab 身份 = 派发账本 externalTaskId + enrichRunRefs 派生 workstream，主会话/子 agent 无 task_id 不伪造）；`workset.ts`（归并投影 buildWorkset/lookupWorkset，task 视图无命中回退 workspace 并标注）；`_test_hotspot_v4.ts`（13 组用例，含两轮 L4 对抗回归）。
- **重写**：`types/store/inject/command/tool/log/index`。存储全部移到 `<agentDir>/hotspot/<wsid>/{meta.json,events/*.jsonl,snapshot.json,log.jsonl}`（repo 零运行状态、不动 `.gitignore`；wsid=sha1(repoRoot)[:16]，worktree 各自命名空间；分片 append-only 无锁单写者；snapshot tmp+随机后缀+rename 原子写、唯一写者=主会话、5min 节流 + TTL 清理）；首条用户消息两级保守注入（task/workstream 精确命中且非终态，或路径 token 精确命中工作集）+ 幂等双保险（已有 user 消息 / `hotspot-injected` 标记）+ 预算内整条省略（≤5 条、≥2 条、~560 字符）+ 工作集已在上下文去重；`hotspot` 工具只剩只读 lookup（limit 默认 10 上限 50）；`/hotspot` 只读诊断（buildHotspotReport）；决策全量进 `log.jsonl`。
- **安全加固（两轮 L4 must-fix）**：写入侧 `isLegalEventPath` 拒绝非法 path（尖括号/控制字符/绝对路径/`..` 越界段）；渲染侧共享 `esc()`（types.ts 唯一实现：控制字符压平空格 + `<`/`>` 全角化）覆盖注入块（renderWorkingSetBlock）、`/hotspot` 报告与 lookup 工具文本——手工/旧分片的恶意字段无法伪造行或标签。
- **删除（v2 专属，共 1874 行）**：`detect/graph/heat/usage/validate/_test_hotspot/_seed_greencad`（pending 自动探测、动态关系投影、路由热度与 used 度量、引用与 CodeGraph 符号校验）。`Wiki/_hotspot.md`/`_hotspot.trash.jsonl` 不删不改不读写（v2 唯一副本留作历史；回退 v2 = `git revert 8a9f09a`，确认不回退后再按 v3 计划 §12-4 备份移出并清理 `.gitignore` 遗留规则）。
- **回退开关**：`PI_HOTSPOT_ENABLED=0`（缺省开）——采集/注入/工具/命令全部不注册，其余扩展功能不受影响。
- **验收**：`npm run test:hotspot` 13/13 绿；`npm run smoke:extension-load` 绿；`_test_register_graph` 绿（注册面快照：事件表删 `session_before_compact`，工具/命令不变）；真机四项实测（采集落分片 / 首条消息路径注入且被模型消费 / 开关关闭 `agent/hotspot/` 零创建 / lookup 渲染）；两轮 L4 独立复核终判 PASS。
- **报告**：设计 `plans/0924_hotspot_v4_ephemeral_working_set.md`；实现 `plans/0924_hotspot_v4_impl_report.md`；L4 链 `plans/0924_hotspot_v4_{l4_review,fix_report,fix_l4_confirm,fix2_report,fix2_l4_confirm}.md`；Wiki `Wiki/Architecture/hotspot-working-set.md`。

## [0.6.0] — 2026-09-23 (session isolation + parallel async + master governance + global view)

- **async 终态只投派发者**：onRunFile link 路由 fail-closed（外会话零副作用、可补投）；async 专用注册谓词（任意 tab 派发者都 watch）。
- **status 默认会话隔离**：无参只返本会话最新 run，显式 runId 保持跨会话可查。
- **parallel 缺省异步**：tasks 不带 async:false 即 fan-out 立返 runId（async:false 保留阻塞）；单发/并行/status 全带 Model: 行。
- **master 治理**：global 只能在 home 会话持有（token/forceStale/genesis 一律不放行、initialCwd 防 cd 绕过、后继 home 启动）；后继标题 `master-MMDD-HHmm-<工作>`。
- **global-view 首阶段**：只读跨仓聚合（一屏 ≤30 行，orphaned 默认隐藏计数）；GC/mailbox 执行链未进本版。
- **launch  robustness**：wt.exe 别名断裂直连回退、Get-AppxPackage 兜底、traceSpawn 探针、preflight。
- **recent 原生感知**：master-status `recent:` 行（三账本归并）；lite 档位不规定模型（编排自选）。
- **修复备注**：09-23 10:32 三处 pi 安装 dist+依赖被掏空致宿主崩溃，已按 0.87.1 shrinkwrap 逐包恢复；停用直接调底层 attachMaster 绕守卫。

## [0.5.3] — 2026-09-22 (rail trio + hotspot graph + async overhaul + launch preflight)

- **会话 rail 三件套**：master 置顶区 + scope master 组内置顶（`isMaster/isScopeMaster`，session-pin + /v1/sessions additive）；每仓库最多 6 个（overflow 展开持久化）；全 tab 组默认折叠。
- **hotspot 知识图谱+评分**：动态关系投影（read 现算一跳边，边不存）+ 手写 rel 边（存在性 gate）+ 拒收回显（superseded）+ used 度量（held-out 防自嗨）+ 14 天热度项 + P0 自动探测（pending 队列，永不直写）。
- **async 大修**：完成 watcher（终态 followUp 注入）+ TUI 卡片清零/TTL/去 error 尾/短标签/成功折叠计数 + 默认派发切非阻塞 async + 注入忙冲突静默重试（根治 Extension "<runtime>" 刷屏）。
- **tab 启动 pre-flight**：spawnPiTab 拦截非法 cwd/execPath/piCli（空 WT 窗口根因），失败进 launch_failed 账本。
- **仓库分组 P1 跟进**：组头键盘可达、subtle label、sortBy 持久化。

## [0.5.2] — 2026-09-22 (ZCode 1:1 workbench + autostart)

- **gui/ 1:1 复刻 ZCode 主工作台**：zai-dark token 整表移植（原名）、14px 基准、滚动条/动画参数；radix-ui + CVA + 5 依赖；14 个零后端 ui 组件；左栏会话列表/中央 transcript 5 行型/user 气泡/工具折叠卡+扫光/composer/topbar h-12/设置层 grid 全 class 逐字对齐；发送链复用 P2（Stop/加号灰显占位；⌘K/文件树/git/账号不渲染）。旧 zinc 调色零残留。
- **可读会话标题**：/v1/sessions 增 title+titleSource（tab-runs 台账→首条 user 剥前缀→shortId 回退；spawn --name 待冻结解除后补 1 行）。
- **GUI 自动拉起**：`/gui on|off|status|open` + session_start 自动 ensure（默认 OFF；已为本机开启 autoStart）。

## [0.5.1] — 2026-09-22 (session-first GUI shell)

- **gui/ 布局反转**（用户指示：会话为主、状态为辅，全面参照 ZCode Web 骨架）：会话列表常驻左栏（三段式列表项+背景色选中态+过滤）、中央永远是对话视图（sticky composer dock、贴底锚定+回看锁定+回到底部）、master/workstream/attention/runtime 四状态页收进「运行时」全屏覆盖层、timeline 保留唯一次级全页、顶栏保留状态徽标露出口。八枚 zcode 语义 token（暗色 v1）；sessions 轮询上移 App 全局第七路；store 最小改动（TabId→chat|timeline 默认 chat + runtimeOverlay；chatActiveId 零改动）。L4 PASS（含覆盖层关闭/流式贴底/死 token 三项在审修复）。

## [0.5.0] — 2026-09-22 (G6 Web Console: WS streaming, chat, interactions — ZCode-referenced)

- **参照 ZCode（zai-org，2026-09-20 开源）架构**：解剖报告 `plans/0920_zcode_reference_research.md`，分阶段计划 `plans/0920_g6_webconsole_plan.md`；采纳其可续传订阅/封闭 delta 操作/审批状态投影/诚实投递语义思想，明确不抄二进制 RPC/SQLite/手机端。
- **P1 只读数据面**：手写 RFC6455 WebSocket `/v1/events/stream`（journal+transcript 两路复用，seq/logEpoch/gen 三元续传）；pi session JSONL → 5 种自包含行投影 + coalesce 纯函数（黄金 10 例）；GET /v1/sessions、/v1/sessions/:id/transcript?after=；启动 token 落 host.json（0600）fail-closed；GUI 第 6 页「会话」只读 chat。L4 NEEDS-CHANGES→PASS：持久 stream-gen sidecar 判代（同首行重写/轮转检出）+ RFC 层回归 10 项 + token hygiene 套件。
- **P2 控制面**：`session.message` 命令（pi:// 寻址、master 会话双层 403 护栏、payload 白名单）；executor→outbox 纯状态盘面→桥 claimInjection 注入的两段式 **at-least-once** 投递（诚实语义：稳定 dedupe 身份 + 目标端去重，crash-window/双进程 CAS 竞速测试）；24h TTL expired 无永久孤儿；POST /v1/commands 认证 fail-closed（timing-safe）；GUI 输入框+两段回执徽标（服务端权威 masterProtected）。L4 BLOCK→PASS 四必修。
- **P3 审批投影+多端附着**：`/v1/interactions` 纯只读投影（attention 1:1 + pending proposal 携 response 命令意图）+ WS interactions 主题（订阅即全量重放）；GUI 待决策徽标/按钮由投影驱动；多 client 独立游标互不干扰（[ws <cid>] 追踪）。
- 全程 §22/§29 红线：Host 不拥有真相（JSONL 只读）、投影零控制流、WS 永不接受 client 命令帧；gui/ 五页轮询零改动，第 6 页走事件流。

## [0.4.1] — 2026-09-20 (backlog: mailbox command consumption + scope stale takeover)

- **mailbox 命令信消费接线**：`agent://master_default` 域命令信在 fencing 复检后、注入前交由确定性执行器 `executeCommand`（红线：命令内容永不进 LLM——回执为逐字节固定模板+受控枚举，L4 三轮打磨内容隔离）；mailbox at-least-once ack × executor wx-claim 双层幂等；`{fileId, letter}` 唯一遍历源防 claim/执行错配；rejected/failed 终态 ack 不重投；ws/scope 域命令信维持现状。生产者 v1 仍为零（POST /v1/commands 不经 mailbox），接线为后续 agent 发起命令铺路。
- **二级 master stale 恢复**：scope owner 心跳双写（agent_start+agent_end，30s 节流，含 pid+startedAt）；接管判据 v1 只做 **pid 死**（长 turn 心跳间隙不误杀）；`takeoverMaster` lease+CAS gen+1（双 session 竞争恰一生效、journal terminal 恰一条、败方 skip）；旧 owner 复活经 UUID 不匹配自动失效。hung-owner 接管、全局 stale 自动化、跨机均不做。
- `SESSION_LIFECYCLE_TYPES` 补 taking_over/takeover/takeover_failed；`isProcessAlive` EPERM/ESRCH 语义单测锁定。

## [0.4.0] — 2026-09-20 (runtime GUI: G1–G5 vertical slice)

- **Runtime Host（G2）**：`/runtime-host start|stop|status`，GET /v1/health|snapshot|events?after|attention|timeline?before + POST /v1/commands（唯一写端点）；host.json 动态端口发现（tri-state 探活）。
- **投影（G3）**：attention 三源聚合（§31 九字段、去重）、timeline journal 升序人话时间线；快照 additive 扩展 master.liveness / autoHandoff / per-ws wakeState+mailboxBacklog。
- **命令执行器（G4）**：`runtime/command-executor.ts` 确定性执行首批命令 workstream.pause/resume、master.handoff.accept、master.auto-handoff.set、master.handoff.prepare；state/commands/ wx-claim 幂等（SHA-256 无碰撞工件名、dedupeKey=<type>:<commandKey>）+ journal command.* 审计；generation 级 proposal 原子 create（agent_end 与 prepare 双调用方防 TOCTOU）；writeConfig tmp+rename 原子化。L4 两轮 APPROVED（collision/master-only/payload 白名单/4 进程真并发）。
- **GUI v0（G5）**：`gui/` vite+react+ts+tailwind4+zustand 浏览器工作台，五页（主控/时间线/需要关注/工作流/运行时），2s/6s 轮询+409 resync+诚实 as-of；中文白话化（G5.1）；GUI 独立 beforeCursor 分页容量策略（G5.2 R3）。server 零 CORS/零 dist 托管，vite dev proxy 同源。
- **心跳写手**：session agent_end 节流落盘 master-liveness（活压力 + 值守会话心跳），prepare 仅认当前 owner 的活值（R1 绑定校验）。
- **S2 Gate 终审（附录A）**：采 b 案（1 次自然提案 + 14 天浸泡至 2026-10-04 开放 S3 opt-in，默认仍 OFF）。
- 事件链四层修复、dispatcher-wake、二级 master v1、`/master-succession` 总开关、档位表 proposal 线（详见 feat/trace-fusion-loop 0918–0920 提交序列）。

## [0.3.0] — 2026-09-17 (trace-fusion diagnose mode)

- **新增主会话工具 `trace-fusion`**：agent 判断任务困难/根因不明时可自主触发只读诊断 rollout（强制 diagnose 模式，零磁盘零主仓库写入），发起后立即可继续其它工作，三路终态自动收集并通知；lane tab 不可见该工具（排除名单 + 运行时能力二次校验）。implement（worktree 读写）仍仅限人工命令。

- **trace-fusion-loop 新增 diagnose 模式并设为默认**（`traceFusionLoop.mode`，`implement` 为 opt-in）：lane 只读诊断主仓库，产出诊断+推进方案，零 worktree、零磁盘代价（implement 实测 12GB/轮）。edit/write 派发期禁用 + dirty-baseline 违规确定性检查；cross-test 以 skip 型报告 + 融合交接说明替代（不在用户仓库执行命令）。管线其余（三 tab 派发/墙钟/权威收集/自动收集）不变。
- **`/trace-fusion-clean <runId> [--force]`**：清理 run 的 worktree 占用（v0.5 提前落地）；runDir artifact（patch/trajectory）永不删，patch 可重放复验。running run 需 `--force`。
- supervisor 自动收集 + session_start 追赶 + claim 幂等（2026-09-16/17 系列）：三路终态自动后台 cross-test，主会话重启可追赶，claim 文件防双 spawn。
- 修复：collect-cli 主模块守卫在 Windows 永假（路径分隔符未归一化）导致后台 worker 空转。
- 真实首跑修复（2026-09-15/16）：validation.json 数组形状容错、墙钟过期 run 自动回收、worktree 根 trust 预授权。

## [Unreleased] — 2026-09-17

### Added
- **热点路由缓存首版（extensions/hotspot/，v2 设计落地）**：新会话首轮用户消息末尾附加一次 `<system-reminder>` 热点块（幂等：entries 检查 + `hotspot-injected` custom entry 双保险；恢复/旧会话不注入；压缩经 customInstructions 保留指针提示；字段 `<` 转义防提前闭合）；`hotspot` 工具（read/upsert/remove：严格解析文件格式、结构+引用+CodeGraph 符号三重验证、存储与注入双预算、revision+指纹乐观锁、`.lock` 跨进程锁（陈旧 30s 抢占）、临时文件原子替换、相同路由内容不写入不增版、remove 保留 `_hotspot.trash.jsonl` 恢复副本）；`/hotspot` 只读诊断（磁盘/注入版本、热度排序含评分依据、预算估算、降级原因、效果日志路径）；热度信号现算不落盘；效果日志 `~/.pi/agent/hotspot-logs/<repo-key>.jsonl`（仅必要指标）。子 agent 进程不注册任何能力；主 `index.ts` 仅 +5 行。配套：`_test_hotspot.ts`、`_seed_greencad.ts`（真实 CodeGraph 验证试点条目 mesh-push）；searcher.md 增「热点候选」回返纪律，workflow-orchestrator 阶段 5 验收清单增热点路由检查项。设计：`plans/20260915_plan_hotspot_memory_layer.md`（v2 §11 代码结构约束）。
- **热点首版验收补账（§8.2 修订，同日）**：①热度信号补**未提交工作树 diff**（`git diff HEAD --name-only`，命中 ×5/目录 ×2 高于已提交 churn——实测 greencad 有 246 文件/7804 行进行中改动对 git log 完全不可见，原排序失真）；②注入头新增「最近任务 / 最近改动」两行现算小节：任务按 Item 编号降序 top3（指针式一行，不复制状态），函数级从未提交 diff + 近 30 条 commit hunk 上下文聚合 top5（`extractFuncContexts` 过滤 namespace/using 噪声，空时降级文件级）；③greencad 配置 `*.cs diff=csharp` + xfuncname（C# 默认 xfunc 抓 namespace，配置后方法签名级可用，实测 `ClearMaterialSelection(`、`TrySample(` 命中）。固定说明预算 600→900 字符；实测注入总量 323 token 零降级。

## [0.3.0] — trace-fusion-loop (feat branch)

### Fixed
- **Luna 复核轮修复（2 major + 4 partial 补全）**：`PiLaunchArgsOptions` 补声明 `excludeTools`（静态类型同步）；cross-test `testFileDiff` 改 `diff HEAD`（上轮批量修复因脚本中断遗漏，实测复现 staged 测试 diff 丢失）；`/trace-fusion-collect` 增加终态门槛（三 lane 未全部 tab-finish 时拒绝，除非 `--force` 显式放弃等待——防撕裂证据与错误终结 run）；命令归一化改【路径→`.`】策略（`cd "."`/`npm --prefix .`/`./f.js` 全部语义正确；lookahead 路径边界防 `C:\wtx` 误伤；URL scheme 不折叠）；异步 spawn 失败时清理该 lane 邮箱的 pending deadline timers；`timedOut` 判定改 `>=`；cross-test 报告落盘移到 cleanup 之后（cleanup notes 持久化进报告）。
- **Luna C4–C8 审查修复（13 项 major/critical + 3 minor）**：①trace worker 身份 env 化（spawnPiTab 注入 PI_SESSION_PROFILE/PI_TRACE_*，factory 阶段即可判定）+ `/trace-fusion-loop` handler 内运行时能力二次校验；②trace tab 工具隔离落地（spawnPiTab 新增 excludeTools 通道，C6 强制传 §17 名单 launch/timer/wiki 写工具）；③delegation guard 加固（空 task/空 tasks 入参校验封死绕过面；trace worker 派 searcher 强制 tools=read,bash 不可覆盖）；④synthetic snapshot 拒绝 run 目录在仓库内（防自吸产物）；⑤execGit 默认剔除继承的 GIT_INDEX_FILE（防污染后续 git 操作）；⑥stale worktree 自动回收（带标记的残留目录启动时清理）；⑦异步 spawn 失败回写 launch_failed 账本 + launch-errors.log；⑧§24.2 墙钟邮箱计时器（deadline-5min 提醒 + deadline 收口）；⑨**三段式 patch part2 改 `diff HEAD`**（原裸 diff 漏 staged，cross-test testFileDiff 同步修）；⑩命令归一化全局+大小写不敏感+引号形式，归一化后仍引用 worktree 的命令拒绝入池；⑪changedFiles 改 name-status 三段（覆盖重命名/删除）；⑫untracked 测试文件从其它 lane 归档复制进 eval 树；⑬新增 `/trace-fusion-collect` 把收集+cross-test 接入生产生命周期（meta 终态化）；minor：result.json 归档进 lane 目录、eval 清理失败记 note、EOF 空白/缩进、lite 测试清理身份 env。

### Added
- **C8 deterministic cross-test + /trace-fusion-status（cross-test.ts）**：§27–§28 落地——pooled commands（跨 lane 去重 + 来源合并；命令归一化剥除 lane worktree 绝对路径含后续分隔符）；每个 candidate 建 eval worktree（Base + candidate patch + untracked 归档 + **其它 lane 无冲突 testFiles 的测试 diff**；path collision 跳过并记 note，Test Consolidator 留 v0.4）；判别 fail **重跑一次防抖**（fail+fail=fail、fail→pass=flaky）；blocked 语义（eval 树不可用/patch 未干净应用）；矩阵落盘 `cross-test.json`（供 v0.4 fusion 消费）+ 人读 `cross-test-report.md`；eval 树用后即删（失败标 stale），不碰 A/B/C 原始 evidence worktree。`/trace-fusion-status` 从磁盘重建视图（meta.json + result.json + 产物清单，主会话重启无损）。worktrees.ts 抽出 `createSingleWorktree` 原语（lane 树/eval 树共用）。新增 `_test_trace_fusion_crosstest.ts`（真实 git 临时仓库 + exec seam：pooled 合并与归一化/flaky 防抖语义/pooled 测试跨 lane 注入/collision 跳过/报告落盘/eval 树清理）。
- **C7 权威收集：supervisor 三段式 patch 自算 + 可信命令池（artifacts.ts）**：按 §21.0 权威来源划分——supervisor 自算 patch.diff/changedFiles/untracked 清单（part1 `diff --binary <base> HEAD` 覆盖已 commit + part2 覆盖未 commit + part3 untracked 单独归档 `lanes/X/untracked/` 并写 status.txt）；worker 叙事（trajectory.md/validation.json）仅参考，缺失记 issue 不致命；validation.json 宽松解析，**仅 portable 复现命令 + validationCommands 进可信命令池**（命令结果一律以复跑为准）；worker 终态探测（result.json）与 §24.2 墙钟超时判定；汇总报告落 `collect.json`（含全 lane 可信命令池，供 C8 cross-test 消费）。§23：tab-finish description 按 session profile 注入 Trace 完成契约（isTraceWorker 时）。新增 `_test_trace_fusion_collect.ts`（真实 git 临时仓库：未 commit/已 commit/untracked 归档排除 ignored/叙事缺失容错/超时判定/汇总落盘）。
- **C6 三 tab 派发：/trace-fusion-loop 主入口（launch-workers + worker-prompt + config）**：新命令 `/trace-fusion-loop <任务>`（主会话专属，canOrchestrateTabs 分支内）一次完成 preflight → runId/目录 → synthetic snapshot → 三 worktree + provisioning → meta.json → 三 tab 派发。`launch-workers.ts`：派发经 C3 原语 `spawnPiTab` 直连（**不经 workflow prompt builder**，设计稿 §18），注入 `sessionProfile: "trace-worker"` + `traceRunId` + `traceLane`；spawn 走注入 seam（测试可注入 fake，无 WT 也可测编排）；单 lane 派发失败 → run 降级 2/3，全部失败 → meta 标 failed + worktree 回滚；账本 mode 新增 `"trace"`（tab-runs.ts TabMode 扩展）。`worker-prompt.ts`：§20 纪律——三 tab 收到同一原始 task，只差 lane metadata，严禁人为分派假设；含 evidence-first 纪律、searcher-only 委派声明、trajectory.md 九节 + validation.json 契约、**patch.diff 由 supervisor 自算（worker 不写）**、tab-finish 完成契约、降级 lane 提示。`config.ts`：读包 config.json 的 `traceFusionLoop` 块（§47 默认值深合并，缺失不致命）。capabilities 补注册 `--trace-run-id/--trace-lane` 旗标（不注册 worker tab 会死于 CLI 解析）+ `traceRunId()/traceLane()` 读取器（flag > env）。meta.json 含 laneDeadlineAt（§24.2 墙钟时限起点）。新增 `_test_trace_fusion_launch.ts`（真实 git 临时仓库 + fake spawner：目录布局/同源三树/同 task 异 lane/workerModel 透传/降级入 prompt/2-3 降级/全失败回滚 failed/preflight 拦截）。register-graph 快照更新（+trace-fusion-loop 命令、+2 旗标）。
- **C5 git 层：synthetic snapshot + worktree manager + provisioning（新目录 `extensions/trace-fusion/`）**：`snapshot.ts` 按 §13–§14 用临时 `GIT_INDEX_FILE`（read-tree HEAD → add -A → write-tree → commit-tree）构造合成 base 提交——折叠 staged/unstaged/untracked（ignored 不进入），不移动用户 ref、不碰用户 index，固定作者身份不依赖用户 git config；落盘 `base/{base-commit.txt,status.txt,snapshot.json}` 三件套；`resolveBaseCommit` 供 §24.1 重启恢复（对象不可解析 → null 降级）。`preflight.ts` 按 §14.2 拒绝非仓库/unborn HEAD/进行中 merge·rebase·cherry-pick/超 maxActiveRuns 的 running run（单 run 互斥，扫 runsDir 下 meta.json）；dirty 工作树不拒绝（正是 snapshot 的折叠对象）。`worktrees.ts`：三 lane 从同一 baseCommit `worktree add --detach`（X_A=X_B=X_C），短路径 `~/.pi/tfl-wt/<run>/`；provisioning（§16.1）junction（Node 原生 symlink 'junction'，Windows 免管理员）/copy/command，失败标 degraded 不致命，报告落 `provision.json`；removal 指数退避重试，仍失败写 `.stale.json` 标记 + prune 兜底（§40.3）。`git.ts` spawnSync 包装 + 固定身份 env；`types.ts` §47 配置类型与默认值。新增 `_test_trace_fusion_git.ts` 真实临时仓库集成测试。
- **trace-worker session profile 接线 + 硬 capability guards（C4）**：工厂注册 `--session-profile` flag（registerCapabilityFlags，与 registerIdentityFlag 同时序约束：工厂内只注册不读值）；subagent-win execute 增加 trace worker 委派硬 guard（只允许 agent=searcher，**agent omitted 拒绝**，覆盖 single/parallel/async 三路径，status 查询放行）；before_agent_start 对 trace worker **early return** 专属注入段（新模块 `trace-worker.ts` buildTraceWorkerSystemPrompt：硬编排边界/执行自由/独立性/GIT 纪律/FINISH 九项终态契约，声明运行时 guard 兜底而非纯 prompt 约束）；resources_discover 对 trace worker 返回空 skillPaths（不见 workflow-orchestrator）；/lite（capabilities().lite）与 /launch（capabilities().launchTabs）增加运行时防护（设计稿 §58/§59：不依赖 factory 阶段注册与否）。新增 `assertDelegationAllowed` 纯函数（白名单 gate，omitted/空串/越权/混合委派全部锁定）+ `_test_trace_worker.ts` + register-graph flag 快照更新（tab-run-id + session-profile）。
- **tab 启动原语抽取（tab-launch-core）**：新增 `extensions/tab-launch-core.ts`——`buildWindowsTerminalArgs`（新增 sessionProfile / traceRunId / traceLane 字段，仅显式传入才发射 `--session-profile` / `--trace-run-id` / `--trace-lane` 旗标）、`wtPromptArg` / `sweepStaleWtPrompts` / `cleanupWtPromptArg` / `sanitizeWtTitle` 及新 spawn 原语 `spawnPiTab`（自 index.ts dispatchPiTab 抽出，TabLaunchOptions/TabSpawnResult 接口化）。依赖方向落地设计稿 §53：workflow prompt builder（launch.ts）与未来 trace worker prompt builder 都只消费 tab-launch-core。launch.ts 保留 workflow 语义层并对原语 re-export，既有导入方零改动；dispatchPiTab 变为 spawnPiTab 薄委托。`_test_launch.ts` 新增 profile 旗标仅显式发射断言。
- **per-call tools allowlist（runner，仅显式传入才生效）**：新增 `extensions/runner-argv.ts`（纯函数 `buildPiArgv`，subagent-core 第一块种子）；`tools` / `excludeTools` 以末位 options 贯通 `runSingle` / `runWithFallback` / `runParallel` / `TaskInput` 与 subagent-win 工具 schema（单个 + tasks 每项）。P2 修订契约：未传时 argv 逐字节不变（不读 agent frontmatter，避免现存 workflow 回归）；显式传入外部 CLI 后端（cli:*）时快速失败而非静默忽略。配套 `_test_runner_tools.ts`（7 组用例：缺省无 --tools、旗标顺序锁定、排他叠加、frontmatter 非硬约束、cli:* 拒绝、清洗去重）与 `npm run test:runner-tools`。
- **会话能力矩阵（capabilities）**：新增 `extensions/capabilities.ts`，定义四类 session profile（main / workflow-tab / trace-worker / subagent）的能力面（workflow / lite / launch-tabs / 角色委派白名单 / timer 编排 / 直接执行）。身份判定沿用 identity 双轨经验：flag `--session-profile`（authoritative，本提交仅注册函数，工厂接线留待 trace-worker 提交）→ env `PI_SESSION_PROFILE` 兜底 → identity 推导。本提交行为零变化：矩阵与 isMainSession/isTabSession/isSubagent 判定完全等价，trace-worker 检测处于休眠态；`index.ts` 两处 launch-tabs 门槛改为 `capabilities().launchTabs`（语义等价替换）。配套 `_test_capabilities.ts`（8 组用例：推导等价、env/flag 优先级、非法值忽略、委派白名单、矩阵快照防漂移）与 `npm run test:capabilities`。

## [Unreleased] — 2026-09-15

### Added
- **lite 轻量工作流模式（/lite on|auto|off）**：中小任务不开 launch-tabs、不用六角色 agent，主会话直接编排单一 `general` agent（新角色卡 `agents/general.md`），按阶段以 `model=` 传档位模型：small（检索/文档）= `models.searcher`、medium（实现/常规计划）= `models.implementer`、large（咨询/修订计划/独立审查）= `models.consultant`（从 config.models 实时投影，无独立配置表）。链路 L1 检索→L2 计划→L3 实现→L4 独立审查（不可省）→L5 文档收尾；上下文纪律：只派 sync/parallel（async status 仅 500 字符预览）、交接默认落盘（>30 行写文件，回复只带路径+≤10 行摘要）、升级线（中转材料 >10K token / fan-out≥3 / 需跨会话存活 → 完整链 tab）。落地：`extensions/lite-mode.ts`（独立模块，纯函数 litePromptLines 生成注入段，off 零注入；deps 注入 config 读写，同 model-presets 约束）、`index.ts` 仅 +7 行接线（import/类型/readConfig×2/configPrompt 注入点/命令注册）、config.json 新键 `liteMode: "off"`、workflow-orchestrator SKILL.md（frontmatter、lite 节、落盘速查行、快捷入口「lite 走一遍」）、`_test_lite_mode.ts`（33 用例：纯函数三态/档位投影/缺模型降级 + 命令注册/写入/状态显示/非法参数）。

## [Unreleased] — 2026-09-06

### Changed
- **直接启动不再自动绑定 workflow**：`/launch -t` 与 `/launch --direct` 只有在用户显式指定 `--research`、`--execute`、`--adaptive`，或在任务文本中使用 `根据...进行工作<taskId>` 前缀时，才附加 workflow 约束；单独出现任务编号不再触发 workflow。普通直接任务保持原始 prompt。

### Added
- **第四种任务模式 adaptive（自适应工作流）**：链深由任务书信息完备度决定，不由仪式感决定（源案例 BidRadar 1030：主会话已给出根因+方案+文件域+验收标准，tab 仍走完整六阶段重复已知信息，耗时翻倍）。`launch-tabs` 传 `mode: "adaptive"`（前缀 `根据adaptive进行工作<taskId>`），tab 启动自评完备度选链深：**A 快链**（四要素齐全：根因/结论+代码位置、方案方向、文件域、可测验收标准）→ 校验性核对（≤3 轮工具调用，codegraph/read/bash 验证假设，禁止重新调研）→ implementer → code-reviewer → Wiki；**B 中链**（缺验收或缺方案）→ planner 微型计划 → plan-reviewer 快审 → implementer → code-reviewer → Wiki；**C 全链**（仅问题描述）→ 同 workflow 六阶段。升降级规则：执行中发现假设失效升档并声明；降级禁止（A 档至少保留码审）；存疑取高档。首轮回复必须声明档位与依据。落地：`launch.ts`（LaunchMode/modePrefix/adaptive 纪律块/taskTitleLabel 前缀过滤/`--adaptive` 旗标解析剥离）、`index.ts`（launch-tabs 工具与 schema 描述、mode 归一化、/launch 文案与 modeHint/modeName、系统提示 Four task modes）、`tab-runs.ts`（账本 mode 校验加 adaptive）、workflow-orchestrator SKILL.md（frontmatter、新增「自适应模式（adaptive）」节含 A0 校验/升降级/模式边界、落盘速查行、快捷入口）、README（四模式表）。`_test_launch.ts` 新增 adaptive 前缀/纪律块/旗标用例。

## [Unreleased] — 2026-08-13

### Added
- External CLI backend `cli:mimo` (MimoCode): resolves `MIMOCODE_BIN`, then `%USERPROFILE%\.mimocode\bin\mimo.exe`, then PATH; runs `mimo run <prompt> --format json --dangerously-skip-permissions --dir <cwd>` and parses its JSON event stream. The CLI's own configured provider/model and credentials remain authoritative.
- External CLI backends: `cli:claude`, `cli:codex`, `cli:agy`, `cli:atomcode`, `cli:zcode` (the latter spawns `node D:\Software\zcode\resources\glm\zcode.cjs -p <prompt> --cwd <cwd>`, plain stdout capture, fixed GLM-5.3)

### Changed
- **派发 tab 多开无用标签页修复（wt 命令行 prompt 物化）**：`wt.exe` 会用自有 tokenizer 重解析命令行——**含换行的参数被拆成多条命令**，剩余行变成标题/内容都是首轮 prompt 残留的无用 tab（实证：workflow 派发几乎必现，因派发 prompt 恒为多行）。新增 `wtPromptArg`：凡含换行/`;`/引号/`%`（wt 的分号命令分隔、引号解析、%env% 展开）的 prompt 一律物化为临时 `@file`（pi 原生 `pi @file.md` 机制读文件内容当首轮消息），wt 命令行上只留一个不含换行的 `@路径`；安全单行 prompt 保持内联零变化。临时文件写入 `~/.pi/agent/launch-prompts/`，5 分钟后自动删除 + 顺带清理 24h 前陈旧文件。接入点：`dispatchPiTab`（launch-tabs 与 /launch 的唯一 wt 派发入口）。`_test_launch.ts` 新增物化/清理/内联用例。
- **派发时强提醒完成回报（tab-finish）**：针对部分子 tab 完成任务后不调 `tab-finish`（停在 waiting/resultMissing，主会话等不到 event-bus 唤醒）——`workflowDisciplineBlock` 的**三种模式**（workflow/research/execute）统一附加「⚠️【完成回报 · 强制】」行：全部工作完成后必须调用 `tab-finish`（status/summary/artifacts/reportPath），不调 = 未完成、主会话会一直等；workflow-orchestrator SKILL.md 同步（核心原则 12 + 阶段 5/R3/E3 收尾各加「回报主会话（强制）」）；`tab-finish` 工具描述也加了「【完成回报 · 强制】你是主会话派发的任务 tab」声明。`_test_launch.ts` 新增三模式均含 tab-finish 提醒的断言。
- **`reclaim-tabs` 移除轮询硬等，永不阻塞**：此前 `wait:true` 会进入 sleep 轮询循环（默认 2 分钟、可被显式拉满 10 分钟）且忽略中止信号（Esc 无法终止），实测会在主会话硬卡数分钟。现在工具**始终立即返回单次快照**（wait/timeoutMs/intervalMs 降为废弃 no-op 参数仅保向后兼容），完成感知完全交给 event-bus（子 tab 写 result.json 自动唤醒主会话），编排巡检用 set-timer。删除了 `RECLAIM_*` 常量和不再使用的 `sleep()`。README §5.1 同步更新。
- **timer 基建加固（三方评估后落地的 P1/P2）**：
  - 投递改 **at-least-once**：`fireOneTimer` 先 `sendUserMessage` 成功才落账（one-shot 置 fired / repeat 重置 pending），send 失败保持 pending 下个 tick 自动重试——原实现先置 fired 再 send，失败即永久丢消息。
  - **所有权门槛加会话活性**：`rootTimerConsumable` 现在同时比对 `ownerCwd` 与 `ownerSessionId`——owner 心跳存活时只有 owner 自己可消费（同 cwd 多主会话防双发）；owner 失活（心跳缺失/超宽限）其他同目录会话可接手（保留重启接管耐久性）。新增 `timers/sessions/<id>.json` 心跳，调度器每 tick 刷新，宽限 15s。
  - **终态 GC**：`sweepTerminalTimers` 清理超过 24h 的 fired/cancelled/missed 文件；`sweepStaleHeartbeats` 清理失活心跳。调度器每 12 tick（≈60s）执行一次，账本不再无限膨胀。
  - **tick 连续失败报警**：连续 3 次 tick 异常向会话注入报警消息（不再静默吞掉）。
  - **路径注入防护**：`timerId`/`tabRunId` 须匹配 `SAFE_ID_PART`（拒绝 `../`、`/` 等危险组件），`listTimerFiles` 同步过滤。
  - **容量措辞修正**：set-timer 描述改为「每个目标（self 或单个 tab 邮箱）最多 50 个 pending」。
  - `registerTimers` 增加可选 `opts.timersDir`（测试可注入目录）。
- **回归测试**：`_test_timers.ts` 新增心跳/所有权门槛/终态 GC/路径安全用例；`_test_timers_runtime.ts` 新增「投递失败重试（at-least-once）」与「registerTimers 注册的 set/list/cancel 工具 + /timers 命令实际执行」用例（覆盖 isSubagentProcess 类闭包漏定义）；`_test_tab_runs_runtime.ts` 同步 reclaim-tabs 非阻塞语义。

### Fixed
- **event-bus 完成消息投错会话（溯源路由缺失）**：tab 完成时 event-bus 的唤醒权是「任意 identityless 进程 claimNotified 先到先得」——多个主会话形态的 pi 进程（不同目录/同一目录不同会话）同时 watch，谁先抢到就把「⏱ Tab 已完成」注入**自己**，真正派发该 tab 的编排会话收不到回报（实证：GreenCAD 编排会话 019ff8b4 派发的 275-280 完成消息全部落到无关的 Annacomnena 会话 019ff89d）。修复：`onTabResultFile` 在 claim 前先按 `links.jsonl` 溯源（`recipientSessionIdFor`，与 report.ts 0.2.2 同一模式）——只注入给派发该 tab 的会话；其他会话静默跳过（不 claim/不 toast/不注入），把唤醒权留给真正的编排会话；溯源解析不到（旧账本无 sessionId）时回退 claim 先到先得。`registerEventBus` 的 session_start 同步捕获本会话 UUID。`_test_event_bus.ts` 新增会话定位回归（非派发会话跳过 / 派发会话注入 / 无溯源回退）。
- **`set-timer` / `cancel-timer` / `list-timers` / `/timers` 全部抛 `isSubagentProcess is not defined`**：`timers-runtime.ts` 在 4 处引用了 `isSubagentProcess` 但从未定义/导入（`tab-runs-runtime.ts` 有 `const isSubagentProcess = isSubagent()`，timers 文件漏了），导致计时器整套工具在运行期直接崩溃。在 `registerTimers()` 开头补齐与 tab-runs-runtime 一致的定义。

## [0.2.2] — 2026-08-11

### Fixed
- **Timer / report 投错对话（身份隔离）**：此前任何无 `--tab-run-id` 的 pi 进程（不同目录的主会话、直开标签页、手动打开的 pi 窗口）都被当作"主会话"，会抢 `~/.pi/agent/timers/*.json` 的 self timer 和 `~/.pi/agent/reports/*.json` 的回报，导致编排消息/任务回报落到无关目录的会话（实证：233 重复 timer 同秒双发、task 238 回报投到 subagent-win 会话）。
  - `set-timer` 的 self timer 记录 `ownerCwd`（+ `ownerSessionId`）；identityless 进程只消费 `ownerCwd == 自己 cwd` 的 root timer，旧账本（无 ownerCwd）一律不消费（宁可静默不投错）；repeat 消费时重新盖章 `ownerSessionId`（重启后同目录新会话可接手）。
  - 标签页内 `target=self` 的 timer 现在写入**自己的邮箱**（此前写根目录被主会话抢走）；标签页的 `cancel-timer` / `list-timers` 缺省也指向自己邮箱。
  - `tab-report` 回报按派发溯源（links.jsonl：tab runId → 派发会话 UUID）定位接收方，只有派发该 tab 的会话消费；其他 identityless 进程不再抢（`.notified` 仍做跨实例去重）。
  - `/launch` 直开标签页也注入 runId + 派发账本（`direct: true`），不再是无身份进程（可正常用 tab-report、不抢 root timer）。

## [0.2.1] — 2025-08-05

### Added
- Consultant agent: user-named model evaluation / screenshot design (`agent="consultant"`)
- `/launch` command: workflow orchestration with visible Windows Terminal tabs
  - `--research` / `-r` mode: deep research only (parallel searchers → research report → Wiki maintenance)
  - `--execute` / `-e` mode: quick execute (skip search/planning → implement → review → Wiki wrap-up)
- `launch-tabs` tool: parallel tab launch with normalized workflow prompts and discipline blocks
- `wiki-nav` tool: progressive Wiki navigation (tree / around / find / keywords / path / rebuild)
- `wiki-semantic` extension: optional remote embedding with local USearch HNSW term expansion
- `notify-windows` extension: Windows Toast notifications for subagent events
- `codex-headers` extension: per-provider Codex request-header compat (`originator`, `User-Agent`, `OAI-Product-Sku`)
- External CLI backends: `cli:claude`, `cli:codex`, `cli:agy`, `cli:atomcode`
- WinINET proxy bridge for external CLI child processes on Windows
- `searchableSelect` TUI component: fuzzy-filtered model picker for large lists

### Changed
- Fallback chain now surfaces `priorFailures` with structured `USAGE_CAP` / `RATE_LIMIT` / `AUTH` / `PROVIDER` / `TIMEOUT` / `OTHER` classification
- Zhipu/GLM bare HTTP 429 treated as `USAGE_CAP` (package quota exhaustion) rather than rate-limit
- Tab title naming: `<repo>[-worktree]-[<taskId>-]<label>`, no meaningless `wlc` defaults
- `buildWorkflowTabPrompt` supports three modes: `workflow`, `research`, `execute`

### Fixed
- `mergeProviderError` prioritizes quota/usage-cap wording from stderr
- `pickBestAssistantText` prefers structured final answers over short tool-use narration
- `collectMainSessionUsage` parses JSONL timestamps directly (file names/mtimes are not reliable)

## [0.1.7] — 2025-07-30

### Added
- `USAGE_CAP` failure classification: surfaces Zhipu/GLM package quota exhaustion as a distinct retryable failure kind
- Main-agent guidance: when `USAGE_CAP` is detected, instructs the main agent to switch model via `/model` instead of retrying

### Changed
- `formatFailureForMainAgent` now includes explicit `ACTION_REQUIRED` instructions for usage-cap and provider failures
- Fallback chain UI: TUI shows `↺fallback×N` badge and per-attempt failure details

## [0.1.6] — 2025-07-24

### Added
- `codex-headers` extension: per-provider Codex header compat (`originator`, `User-Agent`, `OAI-Product-Sku`)
- `before_provider_headers` event handler + `globalThis.fetch` wrap for wire-level header rewrite
- `/codex-headers` command with interactive TUI menu and text mode

### Changed
- `package.json` description updated to reflect Codex header compat feature

## [0.1.5] — 2025-07-23

### Added
- Initial release: subagent-win v0.1.5
- Core subagent execution: single, parallel, async modes
- Role agents: searcher, planner, plan-reviewer, implementer, code-reviewer
- Per-call model override with short alias expansion from `~/.pi/agent/models.json`
- Smart fallback chain with retryable failure classification
- Timeout handling with partial output preservation
- TUI integration with rich rendering of calls and results
- Usage tracking: per-agent daily token/cost logging
- `/today-usage` command: aggregates all sessions + subagent runs
- `/sub-models` command: interactive model/fallback/thinking config
- `workflow-orchestrator` skill: multi-step workflow orchestration (search → plan → review → implement → review → Wiki wrap-up)
- Windows Toast notifications via `/notify` command