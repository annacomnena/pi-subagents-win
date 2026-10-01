---
title: 主动性套件（Autonomy Suite）
kind: concept
status: current
updated: 2026-10-02
source_paths:
  - extensions/runtime/autonomy/config.ts::normalizeAutonomy
  - extensions/runtime/autonomy/frontier.ts
  - extensions/runtime/autonomy/kill-switch.ts
  - extensions/runtime/expectations.ts
  - extensions/runtime/autonomy/wake-gate.ts
  - extensions/runtime/autonomy/watchdog.ts
  - extensions/runtime/autonomy/collect.ts
  - extensions/mailbox-consumer.ts#L65-L70
  - extensions/runtime/autonomy/gate.ts
  - extensions/runtime/autonomy/action/policy.ts::decide
  - extensions/runtime/autonomy/action/policy.ts::BUDGET
  - extensions/runtime/autonomy/action/breaker.ts::readBreaker
  - extensions/runtime/autonomy/action/ledger.ts::appendActionEvent
  - extensions/runtime/autonomy/action/gitguard.ts::discoverRepoRoot
  - extensions/runtime/autonomy/action/gitguard.ts::gitPrecheck
  - extensions/runtime/autonomy/action/classes/report.ts::diagnosticReportClass
  - extensions/runtime/autonomy/action/run.ts::runAutonomyActions
  - extensions/runtime/autonomy/action/run.ts::undoAction
  - extensions/runtime/autonomy/action/run.ts::summarizeActionsStatus
  - extensions/runtime/autonomy/action/replay.ts::queryActionsUndo
  - extensions/runtime/wake.ts#L111-L116
  - extensions/master-tools.ts
  - extensions/index.ts
  - extensions/runtime-host/autonomy-config.ts
  - extensions/runtime-host/server.ts
  - gui/src/pages/AutonomyPage.tsx
  - gui/src/pages/RuntimeOverlay.tsx
  - gui/src/api/client.ts
  - extensions/_test_runtime_autonomy.ts
  - extensions/_test_autonomy_wiring.ts
  - extensions/_test_register_graph.ts
---

# 主动性套件（Autonomy Suite）

## Summary

global master 从"被动等指令"走向"主动推导 + 显式动作"的套件。**v1 是纯函数层（`3922ef4`）；v2 已接线**（唤醒总门进入 `evaluateWakes`、master-status 条件增量行、`/autonomy` 手动运维命令、结构化审计），本套件首次进入生产路径，故 `status: current`。v2 **不新增任何自动动作**：wake-gate `wake=true` 只放行既有 legacy 唤醒链，全部 v2 审计行 `acted=false` 恒真。规格见本地 `plans/0923_global_master_autonomy_suite_v0.2.md`（v0.2）；v1 计划/实现/复核见 `plans/0923_autonomy_suite_v1_{plan,impl,review}.md`；v2 计划/实现/审查见 `plans/0923_autonomy_suite_v2_{plan,impl,review}.md`。

## Current Contract

### v1 纯函数层（`3922ef4`，保留为休眠库资产）

- **配置**（`config.ts`）：`config.json` 的 `autonomy` 切片；`DEFAULT_AUTONOMY` 取规格 §27 精确值；`normalizeAutonomy` **严格 `=== true` + 逐字段回落**（fail-closed）；`readAutonomyConfig` 容忍读（缺/坏 JSON → 默认）。
- **kill-switch**（`kill-switch.ts`）：`readKillSwitch`（容忍读）/ `engageKillSwitch`（原子 tmp+rename）/ `clearKillSwitch`；`evaluateAutonomyGating` 优先级 **kill > enabled > active**。
- **frontier**（`frontier.ts`，**纯零 IO**）：C5 相位→项目状态映射固化、规格 §25 九规则的 v1 子集、`meaningful_state_version`、`RECORD_ONLY_NOCARRIER`（④⑥⑧ 三条 no-carrier 常量，`frontier.ts:156`）。**0928 起 ⑧ 行条件化**：`buildFrontier` 仅当 `inputs.expectations === undefined`（账本目录不存在）才输出 3 条，账本存在时 filter 掉 `expected_event_timeout:` 行（`frontier.ts#L387-L391`；常量本身与逐字断言不改）。**0929 起账本有了生产入口**（`/send-letter`，`index.ts#L2068`）——首次有请求入账后 ⑧ 行即从盘面消失、④⑥ 仍恒在，见 [[期望账本（⑧ 请求—回执期望）]]。
- **wake-gate**（`wake-gate.ts`，**纯**）：`evaluateWakeGate` 四类（gating / debounce 2s / cooldown 15s / bypass）；审计行为纯返回，不落盘。
- **watchdog**（`watchdog.ts`，**纯**）：`evaluateWatchdogChecks` 八项三态（**3/8 恒 `unknown`**、第 7 项 `null→unknown`，不猜）；`validateWatchdogPlan` **只钳制与封顶、不执行**；`WATCHDOG_HEARTBEAT_STALE_MS = 10m`。
- **collect**（`collect.ts`，薄 IO 层，**唯一批量 IO 文件**）：`collectAutonomyInputs` 只读聚合 + **只写自有 namespace**（frontier 快照、审计行），顶层 never-throw。
- **红线**（规格条款 7/C1）：不写共享账本、不改其它仓库、不消费/ack 他人 mailbox；只写自有 namespace `<stateDir>/autonomy/`。

### v2 接线（已提交 `1972aac`）

- **装配层**（`gate.ts`，新）：`evaluateAutonomyWakeGate`（never-throw）——
  - **D-E 默认 no-op**：`cfg.enabled !== true` → 完全旁路（不读 kill、不评估 wake-gate、不审计、零写盘），唯一额外成本 = 每 tick 一次 `config.json` 读；**kill 文件仅在 `enabled===true` 时被唤醒路径消费**（kill 是套件内灭火开关，不是唤醒循环总开关；紧急停 legacy 唤醒 = `/master-cutover off`）。
  - enabled 模式 **fail-closed**：collect 失败 → gating inactive → wake-gate no-wake 压制；装配层自身崩溃 → **fail-open** 走 legacy（"autonomy 永不破坏唤醒循环"；二者不对称，D-E/R7 已文档化于代码注释）。
  - 返回 `AutonomyGateDecision { engaged, proceed, reason }`；`maintainBatchAnchor`（导出纯函数）维护 debounce 锚点：diff 有内容且 `batchFirstSeenAt===null` → 置 now；diff 全空 → 重置 null（**生产路径休眠分支**——recordOnly 恒非空，由 W4.4 单测直测钉死）。
  - 本层不直接 import `node:fs`（"批量 IO 只在 collect.ts"的 v1 约束延续）。
- **唤醒总门落点**（`wake.ts:evaluateWakes`）：owner 门（L93）之后、ws 遍历之前，+1 import +3 行：`evaluateAutonomyWakeGate({ stateDir, configPath: opts.autonomyConfigPath, now })`，`engaged && !proceed` → `return []`（claim 前短路，`evaluateOne`/`claimLetters` 零改动）。`WakeOptions` + test-only `autonomyConfigPath`（仿 `now`/`inFlightWindowMs` 先例；生产不传）。**v2 接线当时 `mailbox-consumer.ts`/`registry.ts`/`scope.ts`/dispatch 侧零改动**（消费点经 `evaluateWakes` 自动带门）；后续变化仅 `mailbox-consumer.ts` 模块顶层的 frontier 源缺省注入一行（见「接线落点与边界」）。
- **collect.ts 新 IO/审计 helper**（全部 never-throw，只写自有 namespace）：
  - `readWakeGateState`：容忍读 `state/autonomy/wake-gate.json` → null（缺失/坏 JSON/字段漂移）。
  - `writeWakeGateState`：原子 tmp+rename，返回是否实际写盘。
  - `appendAuditEvent(cat, concl, reason, stateDir?)`：结构化行 `ts=<ISO> cat=<gating|wake|kill> concl=<...> reason=<...> acted=false` 落 `state/autonomy/audit.jsonl`；**`acted=false` 恒真**（v2 无自动动作）；reason 消毒（CR/LF/TAB→空格、截断 200、空→`"-"`）保护行式格式；**与 v1 `appendAuditLine`（无 ts 前缀）两格式共存**。
  - `readAuditTail`：容忍读 audit.jsonl 尾部 ≤limit 行（默认 5，`/autonomy status` 用）。
  - `collectAutonomyInputs` + optional `configPath`（**纯加法**：不传 = 原行为逐字节不变；gate 经 configPath 注入 temp config 时透传，否则 collect 无参双读真实包根 config → 判定分叉 + 误导性 `gating no-wake reason=autonomy-disabled` 杂行，工程约束 3 / W6 钉死）。
- **状态类型**（`wake-gate.ts:WakeGateState`）：+ optional `lastReason`（**仅此一个字段**，D-G；`lastDecisionAt` 本就每次评估更新，不另加时间戳）。纯模块保持纯，v1 测试构造不含此字段不受影响。
- **master-status 增量行**（`master-tools.ts:masterStatusLogic`）：lines 末尾条件展开 `...(autonomyFootprintExists() ? [autonomyStatusLine()] : [])`；**谓词**：`cfg.enabled===true || kill 在场 || frontier 快照 || wake-gate state` 任一为真才显示；纯净默认态 → 无此行 → `/master-status` 与 master-status tool 输出**逐字节一致**（opt-in 可见性，D7 形态）。行内容四要素：enabled / kill(reason@ts) / frontier(asof, projects) / wake-gate(lastReason@lastDecisionAt)；两 helper 均 never-throw（读失败 → 行缺席或 `(unreadable)`，W3 钉死）。`getMasterStatus`/`MasterStatusView` 契约未动 → GUI/runtime-host 投影零影响。
- **`/autonomy` 命令**（`index.ts`，`/master-status` 块后纯加法）：`/autonomy [status]` | `/autonomy kill [reason]` | `/autonomy clear`。**学术诚实定性：kill/clear 是用户在交互会话手动键入的运维命令**（不新增 LLM 可调 tool，tool 快照与 dispatch 侧零变化）；subagent 会话拦截 kill/clear（复用 `isSubagent`）；**不写 config.json**——启用 autonomy = 用户手动加 `"autonomy":{"enabled":true}`；kill 用非 Audited 变体 + `appendAuditEvent("kill",…)` 单行（避免 v1 格式行 + v2 格式行双写）。
- **tripwire 形态变更**（`_test_runtime_autonomy.ts` A10.1）：v1 "生产文件零 import `runtime/autonomy`" 不变量在 v2 接线后合法化失败 → 改为 **allowlist 双向精确匹配**（`ALLOW=[index.ts, master-tools.ts]` 相对名，offenders push 相对路径；排除集 = autonomy/** + 两个测试文件）+ **A10.1b 正向接线断言**（`wake.ts` 位于 runtime/ 内，import 写作 `"./autonomy/gate.ts"` 不含字面量 `runtime/autonomy` → 字面量 tripwire 天然盲区，用正向断言钉死；后续新增 runtime/ 内接线点须同步扩展）。55→56 项。
- **注册快照**（`_test_register_graph.ts`）：commands +`autonomy`（纯机械追加）；同批修复存量漂移（tools 与 commands 均补 `global-view`，0923 首阶段注册未同步快照所致）。
- **默认关闭零行为**（硬约束）：config 无 `autonomy` 键时 `evaluateWakes` 输出与 legacy 期望同构 + `state/autonomy/` 零新文件 + masterStatusLogic 无 `autonomy:` 行（W1/W1b 端到端）；生产默认路径唯一额外成本 = 每 tick 一次包根 `config.json` 读。

### 动作面（actions）P1：默认关闭的可回滚动作子系统

子系统 `extensions/runtime/autonomy/action/`，让 autonomy 具备**可回滚的最小动作能力**（P1 唯一动作类 = `diagnostic-report` 只读诊断报告）。语义纪律与 wake 面相反：**动作面全链 fail-closed**——任何 unknown / 读失败 / 异常一律拒绝（区别于 wake 面 fail-open 与 kill-switch 容忍读：**观察面容忍、动作面 fail-closed**）。

- **默认关闭（硬约束）**：总入口 `runAutonomyActions` 挂在 `wake.ts:evaluateWakes` 的 autonomy gate 块后（+1 import +1 个 never-throw 调用，`wake.ts#L111-L116`）；门 = **双层合取** `cfg.enabled===true && cfg.actions?.enabled===true`（`run.ts::runAutonomyActions`；config 切片 `actions:{enabled}` 严格 `===true` 归一，`config.ts::normalizeAutonomy`）。默认（无 `actions` 键）⇒ 除一次 config 读外**零 IO、零新文件**；W1c 断言此时 `evaluateWakes` 完整序列化输出与 legacy **逐字节同构** + `state/autonomy/actions*` 零新文件。动作只写自有 namespace `<stateDir>/autonomy/actions/**`，不搭 legacy 唤醒 spawn 通道（结构性防火墙）。
- **动作类与效应面边界**：白名单 `ACTION_CLASS_ALLOWLIST={diagnostic-report}` × `TRIGGER_ALLOWLIST={working_to_failed, stagnation}`（approximate trigger 一律不动手，`policy.ts`）。效应面**仅** `<stateDir>/autonomy/actions/reports/`（`classes/report.ts::diagnosticReportClass.allowedPrefixes`）；`withinSurface` 目录前缀判定在 policy 层与 TOCTOU 复验各查一次，越界 = DENY(namespace-escape)。效应只创建/覆盖写、**永不 unlink 既有文件** ⇒ `deletedFiles` 恒 `[]`，非空 = 违规 → 立即熔断冻结。
- **许可判据（三工程纪律，取代环境隔离路线）**：可回滚判据 = **git 版本管理做好 + 文件夹分好 + 不删除原有文件**（D4 裁定：隔离路线被否决，spec `plans/20261001_autonomy_actionable_design.md` §6.3），机械执行在 `gitguard.ts`：仓根默认 `git rev-parse --show-toplevel` 自动发现（发现失败 = null = fail-closed 拒绝，调用方不需显式传）；动作前 `git status --porcelain` 记基线，动作后 porcelain **逐项比对**，任何新条目 = 违规 → 回退 + 熔断冻结；tracked 文件路径（P3 才出现）前置 dirty 即 DENY，且 autonomy **不代人 commit**。
- **决策树 L0–L3**（`policy.ts::decide`，纯零 IO，输入由 run.ts 从 fail-closed 读装配）：L0 总门（actionsEnabled / kill 在场 / breaker 可读且未 trip / isOwner）→ L1 白名单（trigger × class 双在册 + 非 approximate）→ L2 可回滚四要件（closure/snapshot/rollback/postverify/lease，unknown 一律 false → DENY）→ L3 预算熔断；verdict ∈ `AUTO_EXEC | SKIP | DENY | HUMAN`（HUMAN 仅作上层呈现，P1 无 HUMAN 出口——永久交人的 trigger 在白名单外已被 DENY 拦截）。
- **预算/熔断常量**（`policy.ts::BUDGET`，**硬编码不可经 config 放大**，config 只许收紧）：每 tick 新动作 1、全局在途 1（串行化 ⇒ 回退归因无歧义）、滚动 1h ≤2、同 trigger×class×project 连败 2 停、rule:project 1h 去重 → SKIP(cooldown)、单动作读 ≤256KB、墙钟 ≤5s、frontier 快照逾 2 tick → TOCTOU SKIP(stale)。计数持久化 `state/autonomy/actions/breaker.json`（原子 tmp+rename）：**文件不存在 = 首次零计数（合法起点）；存在但损坏/形状漂移 = 读不到 = 拒绝动作**（防崩溃清零刷额度）；**失败尝试也占额度**。五类「可回滚承诺被证伪」→ `tripBreaker`（tripped+frozen，拒绝一切后续动作），仅人工 `clearActionsBreaker` 可解（非 autonomy 自主）。
- **账本**：动作事件**只进** `state/autonomy/actions/actions.jsonl`（append mode **0600** + **~1MB 两代 rename 轮转**，`ledger.ts`），**audit.jsonl 零污染**——W5 冻结行格式与 W6「单次评估恰 3 行」体积基线一字不动；账本写不进 = 不留无审计的动作（emit 失败 → 拒绝）。事件 kind：`attempted` / `precheck`（L0–L3 逐项实判）/ `executed`（effect + rollbackHandle）/ `postverified` / `rolled_back` / `rollback_failed` / `frozen` / `rejected` / `skipped`；`POLICY_VERSION=actions-v1`。
- **事务包裹与回退**（`run.ts::runOneAction`）：attempted → 快照落盘（`actions/snaps/<id>/`，原字节/权限/存在性）→ precheck → **TOCTOU 最后入口复验**（重读 frontier 快照时效 + 目录前缀 + breaker 复读 + 预算复验）→ 原子写 effect → executed → postverify 回读比对；失配 → 按快照回退 + 回退后复验（复验失败 = 熔断冻结）；git 后置 porcelain 一致才 `postverified`。`undoAction(id)` 按账本快照句柄做动作级回退——无句柄 / 快照不可读 = 如实报 + 熔断（不猜）。
- **回放三问**（`replay.ts`，纯只读 never-throw）：① 做了什么 `queryActionsWhat`（ts ≥ since，kind ∈ {attempted, executed}）；② 为什么 `queryActionsWhy`（首事件 trigger + intent + policyVersion）；③ 能不能撤 `queryActionsUndo`（终态 = 已撤 / 不可撤已冻结 / 可撤（快照 meta.json 全可读）/ 无法保证可撤 / 未知终态）。
- **可见性**：`/autonomy status` 尾行 = `summarizeActionsStatus()`（never-throw ≤5 行；未启用且无记录 → 单行 `actions: disabled/无记录`；否则 `actions: enabled=… breaker=…` + 最近一条动作，`index.ts#L2046-L2056`）。
- **测试基线**：`npm run test:autonomy-actions`（`_test_runtime_autonomy_actions.ts`）**63 checks**（决策树矩阵 / 事务四行 / git 前后置 / 熔断预算 / 回退 / 回放三问）；`_test_runtime_autonomy.ts` **60 checks**；`_test_autonomy_wiring.ts` **15 checks**（含 W1c 默认关逐字节同构 + `state/autonomy/actions*` 零新文件断言）。

## 接线落点与边界（v2 已接线形态）

- **总门**：`wake.ts:evaluateWakes` 顶层（套件级门，不是 ws 级；cutover off / non-owner 提前返回不触本层——省 IO）。per-repo scope wake（`scope.ts`/`mailbox-consumer.ts` 平行接线面）**未接**，列后续。
- **frontier 数据源缺省（2026-10-02 起）**：`collectAutonomyInputs` 的 snapshot 分支由 `PI_AUTONOMY_FRONTIER_SOURCE` 单点二选一（collect 层判定：值 `graph` 才走 Graph，缺省/其它值 = v2）；**生产进程缺省 = graph**——`mailbox-consumer.ts#L70` 模块顶层在进程未预设该 env 时注入 `"graph"`（外部预设非空值优先，逃生舱保留；daemon 不跑 `evaluateWakes`，注入无效）。单行 revert 即回缺省 v2、无状态迁移。契约与测试证据见 [[Work Graph 只读关系面]]「E2.3 契约」。
- **可见性**：master-status 条件增量行 + `/autonomy status` 全字段回显（gating 三元组、frontier meta、wake-gate 最近判定、audit 尾 5 行）。watchdog **不展示**（3/8 恒 unknown，数据源缺口未补，D-D）。
- **审计**：`state/autonomy/audit.jsonl`，两类格式共存（v1 无 ts 前缀诊断行 + v2 `ts=…` 五字段行）。per-reason 进程内去重仅用于 `cat=gating`（kill 压制行内容恒定、gate-error 防 30s tick 刷屏）；`cat=wake` **每次判定落一行**（含 no-wake）；`cat=kill` 来自 `/autonomy kill/clear`。
- **enabled 模式预期语义（R4）**：frontier 不消费 ws-mail 到信（`backlog` 只透传）→ ws-mail 到信不构成 frontier 触发 → 启用后 wake-gate 常态 no-wake（`record-only`）会压制本会 fire 的 legacy ws 唤醒；恢复 legacy 的正道 = **移除 config.json 的 autonomy 键**（kill 是压制而非恢复；clear 后需 frontier 出现真触发才放行）。
- **回滚**：v1 等式（删 `autonomy/**` + 测试两路径）已失效；v2 回滚 = `git revert <v2-wiring-commit>`（单 commit 纪律）。回滚后 `state/autonomy/` 数据成为惰性缓存/日志；kill engaged 时 legacy 唤醒不受影响（D-E），语义自洽。

## 开关可达化（D17）+ **R4 已修**（`3d8409f`）

**用户要求**：主动性套件也要能在设置里开（此前 `/autonomy` 只有 `status|kill|clear`，注释自述"启用需手改 config.json"；`config.json` 里也没有该段 ⇒ 界面上等于没有开关）。

### A1（前置，必须先做）：R4 —— ws-mail 到信成为 frontier 触发
计划风险表 R4：frontier v1 不消费 backlog ⇒ `enabled=true` 时 wake-gate 判 `no-meaningful-change` 而**压制**本来会 fire 的 legacy 唤醒（**打开开关反而更差**）。
**修法**：`extensions/runtime/autonomy/frontier.ts` 对 `pending>0` 的 backlog 产生非近似 `ws_mail_backlog` trigger（**不消费/不 ack/不动 mailbox**，仍只影响"是否放行 legacy 唤醒"）。
**L4 装配层实测**（自写 stub 走 `evaluateAutonomyWakeGate`）：到信 `t0+30s → proceed=true reason=ordinary`（真放行）；该信改 `claimed` 后 `proceed=false reason=record-only`（**不误触发**）；并把**改动前的实现并排 import** 做 6 组输入逐字节比对（6/6 相同 ⇒ 无到信时零回归）。

### A2 开关（TUI + HTTP + GUI）
- `extensions/runtime-host/autonomy-config.ts::setAutonomyEnabled`：原子 read-modify-write、保留其它字段、幂等、写失败如实报错
- TUI `/autonomy on|off|status`（保留 `kill|clear`）；子 agent 会话拦截（与 kill/clear 对齐）+ 翻转留审计行
- HTTP `GET /v1/autonomy/status`（**D17a 四要素**：enabled / kill / frontier 快照时间 / wake-gate 最近判定）+ `POST /v1/autonomy/set`（鉴权沿用 `authorizeCommand`，未认证 401）
- GUI 设置区「主动性套件」卡片 + **诚实文案**："当前不执行任何自动动作"
- HTTP 只读 `GET /v1/autonomy/frontier`（见下节）

### GUI 落点（RuntimeOverlay 第 6 section + frontier 读端点）

- **`GET /v1/autonomy/frontier`（只读）**（`extensions/runtime-host/server.ts:1264`）：与 status/set 同一授权档（`authorizeCommand`，未认证 401）；只调 `readFrontierSnapshot({ stateDir })`——**读盘即返回完整 `FrontierSnapshot`，不重计算、零写入**；快照缺失/坏 JSON/字段漂移 → `200 null`（客户端据此区分「无文件」与「0 项目基线帧」）；仅 GET，其余方法 405。`/v1/autonomy/status` 形状未改（向后兼容）。
- **GUI 第 6 section**：`RuntimeOverlaySection` 六值 union（`gui/src/store.ts:38`：attention/master/workstream/runtime/wechat/**autonomy**），`RuntimeOverlay` SECTIONS 表新增「主动性」（Activity 图标，`gui/src/pages/RuntimeOverlay.tsx:28-35`），`runtimeOverlay === "autonomy"` 打开即定位该 section；覆盖层页内容 = `gui/src/pages/AutonomyPage.tsx`：
  - `AutonomySettings`（总门开关）——**自微信连接页（ChannelsPage）整体迁出**，ChannelsPage 零引用；开关行为/API 逐字不变（`GET /v1/autonomy/status` + `POST /v1/autonomy/set`）。迁出后卡片不再位于任何带 401/403 早退分支的页内 → 默认配置与未认证/无权限各态下开关均可见（D17 可达性由此结构性保证，非逐分支补钉）。仍保留诚实文案「当前不执行任何自动动作」与 `awayMode`「未实现（保留字段），不提供开关」。
  - `FrontierViz`（frontier 可视化，`api.autonomyFrontier()`，**5s 轮询**，`gui/src/api/client.ts:147`）三块：**C 快照时效**（`asof` 相对时间 + `baseline` 首帧徽标 + 项目/触发计数）、**A 项目状态矩阵**（每项目 state+variant / needsUser 高亮 / gate / resultMissing / stagnation / overdue / runs 明细）、**B 触发记录表**（rule/project/evidence，`approximate` 降透明度 + 「近似」徽标）。状态语义：`snap===undefined` 加载中、`null` → 「快照尚未生成（autonomy 未启用，或尚未完成首次 tick）」；读失败显示可恢复错误、保留最近快照（不留永久加载态）；`gate:"unknown"` 呈中性「未知」（与 watchdog 3/8 恒 unknown 同款“不猜”语义）。零图表库（Badge/Card 手写）。

### A3 awayMode 空壳
`autonomy.awayMode.enabled` 被解析但**无任何生产消费者** ⇒ 保留字段但 GUI 明确标注"未实现（保留字段）"，且**不提供开关**（不让界面出现按了没反应的按钮）。

### GUI 挂载位置约束（D17 可达性）

开关必须挂在**不受错误态早退影响**的位置：若把 `AutonomySettings` 放进带 `disabled`(403)/`unauthorized`(401) 提前 return 的页，卡片会被埋在闸后、默认配置下不可见（端点本身没问题，是挂载位置遮蔽）。现组件位于独立的 `AutonomyPage`（无任何早退分支），因此默认配置 + 各错误态下开关均可见；**验收口径**：D17 可达性须覆盖「默认配置 + 各错误态」，只看正常态会漏。

## Evidence

- v1：`extensions/_test_runtime_autonomy.ts` A1–A11 断言（含"测试不触真实 `~/.pi/agent/runtime`"隔离断言）；提交 `3922ef4`；L4 复核 `plans/0923_autonomy_suite_v1_review.md`（PASS，must-fix 0）。
- v2（2026-09-23 实测）：
  - `npx tsx extensions/_test_runtime_autonomy.ts` → **all 56 checks passed**（55 基线 + A10.1b；A10.1 改 allowlist 后绿）。
  - `npx tsx extensions/_test_autonomy_wiring.ts`（新，W1/W1b/W2.1–W2.5/W3/W4.1–W4.4/W5/W6）→ **all 14 checks passed**；W1 默认关闭端到端（显式注入 temp no-key config，不依赖包根现状——R10）、W2 kill 演练两层断言（evaluateWakes 层只断返回值；gate 层 temp agentDir 断 reason：首帧 `record-only`）、W5 五字段行格式 + 消毒 + never-throw、W6 单次完整评估 = frontier 1 + watchdog 1 + `cat=wake` 恰 1（3 行基线）。
  - `npm run smoke:extension-load` → extension load OK；`_test_runtime_wake.ts`/`_test_runtime_master_control.ts`（含 masterStatusLogic 文案 parity）/`_test_local_master.ts`/register-graph 本体全绿。
  - tab 内独立 L4 审查：`plans/0923_autonomy_suite_v2_review.md`（**PASS-WITH-MUST-FIX，must-fix 0**；残余风险 5 条见 Open Questions）。
- 动作面 P1（2026-10-01 实测）：`npx tsx extensions/_test_runtime_autonomy_actions.ts` → **all 63 checks passed**；`npx tsx extensions/_test_runtime_autonomy.ts` → **all 60 checks passed**；`_test_autonomy_wiring.ts` 15 checks（W1c 默认关逐字节同构 + actions 零新文件断言）。源码：`extensions/runtime/autonomy/action/{policy,breaker,ledger,gitguard,run,replay}.ts` + `action/classes/report.ts`；接线 `extensions/runtime/wake.ts#L111-L116`；`/autonomy status` 尾行 `extensions/index.ts#L2046-L2056`；config 切片 `extensions/runtime/autonomy/config.ts::normalizeAutonomy`；npm script `package.json::test:autonomy-actions`。
  - v2 计划/实现：`plans/0923_autonomy_suite_v2_plan.md`（7 裁定 D-A~D-H + 接线点清单）、`plans/0923_autonomy_suite_v2_impl.md`（逐文件行段 + 偏差 8 条，其中偏差 1 修正了原计划对空盘面二帧 reason 的错误预期：实为 `record-only` 非 `no-meaningful-change`）。
- GUI 落点（2026-09-30）：`gui/src/pages/AutonomyPage.tsx`（AutonomySettings + FrontierViz）、`gui/src/pages/RuntimeOverlay.tsx`（SECTIONS 六值）、`gui/src/store.ts:38`、`gui/src/api/client.ts:147`（`autonomyFrontier`）、`extensions/runtime-host/server.ts:1243-1267`（frontier 路由）；提交 `d321c50`（只读 frontier 端点）、`6ee8191`（覆盖层第 6 section + AutonomySettings 迁出微信页）、`661c8f2`（FrontierViz）、`39e6677`（读失败不留加载态 + Toggle focus 环）。

## Links Out

- [[Wiki 索引]]

## Backlinks

- [[Wiki 索引]]

## Open Questions

- **audit 轮转仍无**（R5）：enabled 常开 ≈ 3 行/次评估 ≈ 2.6 万行/天（24h），无轮转无上限；先例 `master-injection.ts:268-287`（~1MB 两代 rename）留后续任务。
- **watchdog 数据源缺口仍挂**：三项恒 `unknown` 的判据无数据源（与 `global-view` 卫生行缺口同源）；v2 状态面不展示 watchdog（D-D）。
- **envelope.priority 队列仍 pending**（L1-B 未决 3，独立接线面）。
- `no-meaningful-change` 分支在 collect 生产路径休眠（recordOnly 恒非空，frontier.ts:281）；`maintainBatchAnchor` 的"全空 diff 重置"分支同源休眠（W4.4 单测覆盖）。
- frontier 不消费 ws-mail 到信（R4，见"接线落点与边界"）；debounce 2s / cooldown 15s 在 30s tick 下近似 inert（R6；事件驱动/缩短 interval 后续）。
- ~~审计 `concl` 参数当前为普通 `string`，依赖内部调用者传固定常量（L4 残余风险 5：可收窄为字面量联合类型或消毒强化契约）~~ **已解决**：`appendAuditEvent` 的 `concl` 已收窄为 7 值字面量联合 `AuditConcl`（`engage|clear|wake|no-wake|pass|enable|disable`，`collect.ts::AuditConcl`），全仓调用点与发射值不变，W5 冻结行格式正则不受影响。
