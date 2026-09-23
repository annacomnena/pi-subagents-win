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
| 6 | P1 | 本机 GUI 解锁 master 切片（通道已落地，端到端验收待补） | Item 4 | 补注入验收，转 Wiki current |
| 5 | P1 | 微信 iLink 探针（七项未知项待真网测量） | none | 真网测量并回填 Wiki |
| 4 | P0 | runtime daemon 切片一（G0 完整 10/10 待实测） | none | 跑 G0 十轮 + 人工核对 |

### Item 6 - 本机 GUI 解锁 master 切片

- **日期**：2026-09-23
- **一句话**：本机受信 GUI → 活着的 master 进程注入通道已落地（bootstrap OTT + 护栏），端到端验收待补，进行中。
- **涉及模块**：`extensions/runtime-host/server.ts`、`extensions/runtime-host/commands.ts`、`extensions/gui-autostart.ts`
- **Commit**：通道代码随切片一及 GUI 相关提交落地（`c3f69c5`、`c3003d5`）；本切片验收未合。
- **Wiki**：[[GUI 解锁 Master]]（`status: draft`）
- **Priority**：P1
- **Status**：active
- **Verification**：待补（占用锁、审计行、`master-offline` 文案的端到端验收）

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
