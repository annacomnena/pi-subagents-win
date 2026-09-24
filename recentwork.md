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
| 30 | P2 | `/runtime-host restart [--force]`（用户提出；已实现 `1743061`） | none | worker-only restart（可选，SKIP） |
| 29 | P1 | 微信输入 W2b：GUI 开关 + 白名单（hash id 可维护）+ 「为什么没进来」反馈（已实现 `18ba74d`） | Item 28 | 真机验证被**平台侧**阻塞（消息不进长轮询队列）→ 待用户核对推送/webhook 配置 |
| 28 | P1 | 微信输入 W2（私聊文本注入 master，D15 六条件，已实现 `168fed1`） | Item 25 | W2b：GUI 开关 + 白名单（从最近发送者一键添加）+ 「为什么没进来」反馈 |
| 27 | P3 | `_test_message_outbox.ts` 双进程 CAS 断言偶发失败（L4 实跑命中 1 次；主会话连跑 3 次均过） | none | 判性质：真竞态 vs 测试抖动；给该断言加确定化（重试/显式同步） |
| 11 | P2 | 仓库记忆层建立（双层记忆 + hotspot 修复，已完成） | none | —（已完成，无） |
| 10 | P1 | GUI 扫码连接微信切片（v1 绑定/解绑/状态，设计完成待实现） | Item 5 | 实现并验收，转 Wiki current |
| 5 | P1 | 微信 iLink 探针（七项未知项待真网测量） | none | 真网测量并回填 Wiki |
| 4 | P0 | runtime daemon 切片一（G0 完整 10/10 待实测） | none | 跑 G0 十轮 + 人工核对 |

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
