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
| 11 | P2 | 仓库记忆层建立（双层记忆 + hotspot 修复，已完成） | none | —（已完成，无） |
| 10 | P1 | GUI 扫码连接微信切片（v1 绑定/解绑/状态，设计完成待实现） | Item 5 | 实现并验收，转 Wiki current |
| 5 | P1 | 微信 iLink 探针（七项未知项待真网测量） | none | 真网测量并回填 Wiki |
| 4 | P0 | runtime daemon 切片一（G0 完整 10/10 待实测） | none | 跑 G0 十轮 + 人工核对 |

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
