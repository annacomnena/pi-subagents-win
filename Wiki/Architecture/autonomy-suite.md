---
title: 主动性套件（Autonomy Suite）
kind: concept
status: current
updated: 2026-10-30
source_paths:
  - extensions/runtime/autonomy/config.ts::normalizeAutonomy
  - extensions/runtime/autonomy/frontier.ts
  - extensions/runtime/autonomy/frontier.ts::buildFrontier
  - extensions/runtime/autonomy/frontier.ts::deriveTabSupervisionState
  - extensions/runtime/autonomy/frontier.ts::BLOCKED_OVERDUE_THROTTLE_MS
  - extensions/runtime/autonomy/frontier.ts::blockedOverdueThrottle
  - extensions/runtime/autonomy/frontier.ts::blockedOverdueLastAt
  - extensions/runtime/autonomy/collect.ts::readSupervisionInputs
  - extensions/supervision-runtime.ts::evaluatePushGuards
  - extensions/supervision-runtime.ts::pushTemplate
  - extensions/supervision-runtime.ts::supervisePush
  - extensions/supervision-runtime.ts::registerSupervisionTools
  - extensions/supervise-gate.ts::supervisePushGate
  - extensions/supervise-gate.ts::readLocalOwnerAttachment
  - extensions/one-shot-tab.ts::spawnOneShotTab
  - extensions/runtime/wake.ts::normRepoPath
  - extensions/runtime/wake.ts::repoPathMatches
  - extensions/runtime/wake.ts::buildSupervisionBlock
  - extensions/supervision-runtime.ts::countPushes
  - extensions/supervision-runtime.ts::clampMaxPushes
  - extensions/runtime/wake.ts::buildWakePrompt
  - extensions/runtime/wake.ts::buildSupervisionBlock
  - extensions/runtime/wake.ts::deriveSupervisionItems
  - extensions/runtime/wake.ts::WakeSupervisionItem
  - extensions/runtime/scope.ts::buildScopeWakePrompt
  - extensions/runtime/scope.ts::evaluateScopeWake
  - extensions/tab-runs.ts::TabState.currentToolStartedAt
  - extensions/tab-runs-runtime.ts#L96-L107
  - extensions/runtime/frontier-carriers.ts#L338
  - extensions/index.ts#L2543
  - extensions/_test_runtime_supervision_push.ts
  - extensions/_test_supervise_gate.ts
  - extensions/runtime/supervision.ts::setSupervisionStatus
  - extensions/runtime/supervision.ts::setSupervisionOptOut
  - extensions/runtime/supervision.ts::autoRegisterDispatchedTabs
  - extensions/runtime/supervision.ts::handleSuperviseCommand
  - extensions/tab-runs.ts#L356-L369
  - extensions/tab-runs.ts::validateTabResult
  - extensions/tab-runs.ts::classifyTabStatus
  - extensions/tab-runs-runtime.ts::classifyForReclaim
  - extensions/tab-runs-runtime.ts::writeSettlementFallback
  - extensions/master-tools.ts#L731
  - extensions/_test_runtime_supervision_default_on.ts
  - extensions/runtime/autonomy/kill-switch.ts
  - extensions/runtime/expectations.ts
  - extensions/runtime/autonomy/wake-gate.ts
  - extensions/runtime/autonomy/watchdog.ts
  - extensions/runtime/autonomy/collect.ts
  - extensions/mailbox-consumer.ts#L65-L70
  - extensions/runtime/autonomy/gate.ts
  - extensions/runtime/autonomy/action/policy.ts::decide
  - extensions/runtime/autonomy/action/policy.ts::TRIGGER_CLASS_MAP
  - extensions/runtime/autonomy/action/policy.ts::TRIGGER_ALLOWLIST
  - extensions/runtime/autonomy/action/policy.ts::BUDGET
  - extensions/runtime/autonomy/action/breaker.ts::readBreaker
  - extensions/runtime/autonomy/action/ledger.ts::appendActionEvent
  - extensions/runtime/autonomy/action/ledger.ts::hasRecentNotifyForProject
  - extensions/runtime/autonomy/action/gitguard.ts::discoverRepoRoot
  - extensions/runtime/autonomy/action/gitguard.ts::discoverRepoRootForProject
  - extensions/runtime/autonomy/action/gitguard.ts::isLocalRepoPath
  - extensions/runtime/autonomy/action/gitguard.ts::gitPrecheck
  - extensions/runtime/autonomy/action/classes/report.ts::diagnosticReportClass
  - extensions/runtime/autonomy/action/classes/notify.ts::notifyLocalMasterClass
  - extensions/runtime/autonomy/action/classes/notify.ts::ownerCheck
  - extensions/runtime/autonomy/action/classes/types.ts::ActionClass
  - extensions/runtime/autonomy/action/registry.ts::getActionClassRegistry
  - extensions/runtime/mailbox.ts::deliverLetter
  - extensions/runtime/autonomy/action/run.ts::runAutonomyActions
  - extensions/runtime/autonomy/action/run.ts::undoAction
  - extensions/runtime/autonomy/action/run.ts::summarizeActionsStatus
  - extensions/runtime/autonomy/action/replay.ts::queryActionsUndo
  - extensions/runtime/wake.ts#L120
  - extensions/master-tools.ts
  - extensions/index.ts
  - extensions/runtime-host/autonomy-config.ts
  - extensions/runtime-host/server.ts
  - gui/src/pages/AutonomyPage.tsx
  - gui/src/pages/RuntimeOverlay.tsx
  - gui/src/api/client.ts
  - gui/src/api/types.ts::ProjectFrontier
  - gui/src/api/types.ts::ProjectSupervision
  - gui/src/api/types.ts::SupervisionState
  - extensions/_test_runtime_autonomy.ts
  - extensions/_test_autonomy_wiring.ts
  - extensions/_test_register_graph.ts
---

# 主动性套件（Autonomy Suite）

## Summary

global master 从"被动等指令"走向"主动推导 + 显式动作"的套件。**v1 是纯函数层（`3922ef4`）；v2 已接线**（唤醒总门进入 `evaluateWakes`、master-status 条件增量行、`/autonomy` 手动运维命令、结构化审计），本套件首次进入生产路径，故 `status: current`。v2 **不新增任何自动动作**：wake-gate `wake=true` 只放行既有 legacy 唤醒链，全部 v2 审计行 `acted=false` 恒真（动作面是其后独立子系统才打开的，见「动作面」节）。规格见本地 `plans/0923_global_master_autonomy_suite_v0.2.md`（v0.2）；v1 计划/实现/复核见 `plans/0923_autonomy_suite_v1_{plan,impl,review}.md`；v2 计划/实现/审查见 `plans/0923_autonomy_suite_v2_{plan,impl,review}.md`。

**监管账本（supervision）已并入本页**（「监管账本（supervision）与默认开启」节）：它是 `stagnation` 判据的唯一载体，与 frontier 同一 tick 链路，故不单独开页。**P1 主动推动（`supervise-push`）也并入本页**同节末尾——它只写监管账本 `epoch.pushes[]` + steer 通道，无自有数据面。

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
  - `readAuditTail`：容忍读 audit.jsonl 尾部 ≤limit 行（默认 5，`/autonomy status` 用）。**2026-10-29（`0cfbd59`）已重写**：不再 `readFileSync` 全文件，改为 `fstat` 取大小 → 只读尾部固定字节窗口（初始 64 KB；行数不足按 8x 扩大，最多 3 次，窗口已覆盖全文件则直返）。实测 29.4 MB 文件 **0.39 ms vs 旧 123.24 ms（313x）**，结果逐行相同。
  - `rotateAuditIfNeeded` + `AUDIT_ROTATE_BYTES = 8 MB`（`0cfbd59`）：`appendAuditLine` 追加前调用，超阈值把 `audit.jsonl` rename 为 `audit-<YYYYMMDDTHHMMSSZ>.jsonl`（同名冲突追加 `-<pid>`），**只归档不删除**；轮转失败 never-throw（宁可继续追加也不丢审计）。
  - `collectAutonomyInputs` + optional `configPath`（**纯加法**：不传 = 原行为逐字节不变；gate 经 configPath 注入 temp config 时透传，否则 collect 无参双读真实包根 config → 判定分叉 + 误导性 `gating no-wake reason=autonomy-disabled` 杂行，工程约束 3 / W6 钉死）。
- **状态类型**（`wake-gate.ts:WakeGateState`）：+ optional `lastReason`（**仅此一个字段**，D-G；`lastDecisionAt` 本就每次评估更新，不另加时间戳）。纯模块保持纯，v1 测试构造不含此字段不受影响。
- **master-status 增量行**（`master-tools.ts:masterStatusLogic`）：lines 末尾条件展开 `...(autonomyFootprintExists() ? [autonomyStatusLine()] : [])`；**谓词**：`cfg.enabled===true || kill 在场 || frontier 快照 || wake-gate state` 任一为真才显示；纯净默认态 → 无此行 → `/master-status` 与 master-status tool 输出**逐字节一致**（opt-in 可见性，D7 形态）。行内容四要素：enabled / kill(reason@ts) / frontier(asof, projects) / wake-gate(lastReason@lastDecisionAt)；两 helper 均 never-throw（读失败 → 行缺席或 `(unreadable)`，W3 钉死）。`getMasterStatus`/`MasterStatusView` 契约未动 → GUI/runtime-host 投影零影响。
- **`/autonomy` 命令**（`index.ts`，`/master-status` 块后纯加法）：`/autonomy [status]` | `/autonomy kill [reason]` | `/autonomy clear`。**学术诚实定性：kill/clear 是用户在交互会话手动键入的运维命令**（不新增 LLM 可调 tool，tool 快照与 dispatch 侧零变化）；subagent 会话拦截 kill/clear（复用 `isSubagent`）；**不写 config.json**——启用 autonomy = 用户手动加 `"autonomy":{"enabled":true}`；kill 用非 Audited 变体 + `appendAuditEvent("kill",…)` 单行（避免 v1 格式行 + v2 格式行双写）。
- **tripwire 形态变更**（`_test_runtime_autonomy.ts` A10.1）：v1 "生产文件零 import `runtime/autonomy`" 不变量在 v2 接线后合法化失败 → 改为 **allowlist 双向精确匹配**（`ALLOW=[index.ts, master-tools.ts]` 相对名，offenders push 相对路径；排除集 = autonomy/** + 两个测试文件）+ **A10.1b 正向接线断言**（`wake.ts` 位于 runtime/ 内，import 写作 `"./autonomy/gate.ts"` 不含字面量 `runtime/autonomy` → 字面量 tripwire 天然盲区，用正向断言钉死；后续新增 runtime/ 内接线点须同步扩展）。55→56 项。
- **注册快照**（`_test_register_graph.ts`）：commands +`autonomy`（纯机械追加）；同批修复存量漂移（tools 与 commands 均补 `global-view`，0923 首阶段注册未同步快照所致）。
- **默认关闭零行为**（硬约束）：config 无 `autonomy` 键时 `evaluateWakes` 输出与 legacy 期望同构 + `state/autonomy/` 零新文件 + masterStatusLogic 无 `autonomy:` 行（W1/W1b 端到端）；生产默认路径唯一额外成本 = 每 tick 一次包根 `config.json` 读。

### 动作面（actions）：默认关闭的可回滚动作子系统（P1 报告 + 阶段二 notify）

子系统 `extensions/runtime/autonomy/action/`，让 autonomy 具备**可回滚的最小动作能力**（现 2 类：`diagnostic-report` 只读诊断报告（效应面 = 自有 namespace）+ `notify-local-master` 本地通知信（效应面 = 目标 scope master mailbox spool 内恰一个新信件文件））。语义纪律与 wake 面相反：**动作面全链 fail-closed**——任何 unknown / 读失败 / 异常一律拒绝（区别于 wake 面 fail-open 与 kill-switch 容忍读：**观察面容忍、动作面 fail-closed**）。

- **默认关闭（硬约束）**：总入口 `runAutonomyActions` 挂在 `wake.ts:evaluateWakes` 的 autonomy gate 块后（+1 import +1 个 never-throw 调用，`wake.ts#L120`）；门 = **双层合取** `cfg.enabled===true && cfg.actions?.enabled===true`（`run.ts::runAutonomyActions`；config 切片 `actions:{enabled}` 严格 `===true` 归一，`config.ts::normalizeAutonomy`）。默认（无 `actions` 键）⇒ 除一次 config 读外**零 IO、零新文件**；W1c 断言此时 `evaluateWakes` 完整序列化输出与 legacy **逐字节同构** + `state/autonomy/actions*` 零新文件。代码缺省 `defaultAutonomyConfig().actions.enabled` **仍为 `false`**（A10.1d 钉死「默认关闭零行为」）；**开的是配置，不是缺省**——包根 `config.json`（gitignored，不走 git）自 2026-10-02 起已开 `autonomy.actions.enabled=true` 切片，**一键回退 = 删除该子键**。report 类效应只写自有 namespace `<stateDir>/autonomy/actions/**`；notify 类效应面 = mailbox spool 内恰一个新信件文件（授权扩域，见下）；不搭 legacy 唤醒 spawn 通道（结构性防火墙）。
- **动作类与效应面边界**：全局类白名单 `ACTION_CLASS_ALLOWLIST={diagnostic-report, notify-local-master}` × **trigger→class 逐规则映射 `TRIGGER_CLASS_MAP`**（`policy.ts#L35-L41`，替代「单 trigger 白名单 × 全 class 白名单」的笛卡尔积；**恰五条规则**：`working_to_failed` → 两 class（既留诊断记录也通知）、`stagnation` → 两 class、`needs_user` → 仅 `notify-local-master`（语义 = 系统声明需要人，交人 = 通知 scope master；诊断记录需求已由其余规则覆盖，不给额外面）、`expected_event_timeout` → 仅 `diagnostic-report`（诊断类第二成员；⑧ 是 level 触发，映射 notify 会放大信件面，且其 project key 未必是文件系统路径、notify 对非路径 project 本就 fail-closed 拒绝，report 对任意 project key 稳定）、`blocked_overdue` → 仅 `notify-local-master`（BLOCKED_USER ∧ idle > userMs 的超龄提醒；**刻意不映射 `diagnostic-report`**：诊断面已被 ③⑨⑧ 覆盖，本规则 evidence 只有 run/idle 不携带新诊断信息；且它是 level 触发（每 runId ≤1 次/小时），映射 report 会让 1/tick 预算被它长期占住）。`TRIGGER_ALLOWLIST` 由映射 key 派生 **size=5**（对外导出兼容，`policy.ts#L44`，`_test_runtime_autonomy_actions.ts` 逐值断言 5）；approximate trigger 一律不动手。**候选 = 按映射枚举 class**（`run.ts#L110` `TRIGGER_CLASS_MAP[rule] ?? []`，保持 report→notify 插入序 ⇒「同 incident 两 class 分 tick 落」不变），每组合独立 1h 去重（dedupKey = `rule:class:project`，class 段防同一 incident 两 class 互饿，`run.ts#L153`）。report 类效应面**仅** `<stateDir>/autonomy/actions/reports/`（`classes/report.ts::diagnosticReportClass.allowedPrefixes`）；notify 类效应面 = `defaultMailboxDir()` 基目录（`classes/notify.ts::notifyLocalMasterClass.allowedPrefixes`，授权扩域，边界 = 恰一信件文件 + 只 deliver 不消费）。`withinSurface` 目录前缀判定在 policy 层与 TOCTOU 复验各查一次，越界 = DENY(namespace-escape)。效应只创建/覆盖写、**永不 unlink 既有文件** ⇒ `deletedFiles` 恒 `[]`，非空 = 违规 → 立即熔断冻结（notify 同理：回退删自创信件 = 撤销自身效应，不计 deletedFiles）。
- **notify-local-master 类（阶段二，只发信不写文件）**（`classes/notify.ts::notifyLocalMasterClass`）：效应 = 恰一个新信件文件 `mailboxDirFor(to)/<messageId>.json`（`deliverLetter` 落盘）。「只发信不写文件」的机械保证：`requiresAck:false` + `expectReply:false`（不写 expectation 账本，`expectations.ts:336` 对 false 短路）+ **不传 dedupeId**（不写 claims slot）——除信件本身与自有 harness（ledger/breaker/snaps）外零额外写入。`subject` 恒 `autonomy-notify/<rule>`（**不以 `run://tab/` 开头**；`run://tab/` 开头是 scope wake 链不认领的 report-shape ⇒ 信永远无人看）；`from=agent://autonomy-actions`（标明动作来源）；`to=localMasterAddress(localMasterScope(project))`（project 非路径 / scope 解析失败 ⇒ `targetPath` 返哨兵 `""` ⇒ closure=false ⇒ **fail-closed DENY(surface-open)**）。**发信前查 scope owner**（`classes/notify.ts#L150 ownerCheck` → `PolicyContext.notifyScopeOwner` → 决策树 L1.5；旧「目标 scope 无 owner 也可投递」契约已废）：① `readAttachment` 读不到 attachment（无 owner；含 scope 解析失败与 IO 异常，按读不到处理 fail-closed）→ **DENY(`scope-ownerless`)**；② attachment 在位但 `judgeScopeOwnerStale` 判 `stale`（liveness 身份匹配 + pid 死）→ **DENY(`scope-owner-stale`)**；③ liveness 缺失 / 身份不匹配（verdict `skip`）或 pid 活 → **放行**（与系统同保守度，不发明第二级探活）；report 类该字段为 `"n/a"` 不受此门影响。无主/死主的 notify 被拒后，同 tick 内映射中的 report 候选照旧执行（事件留痕 `rejected(reason=scope-ownerless)`，mailbox 零信件）。**绝不消费/ack 他人 mailbox**（红线不变，只 deliver）。投递前置校验：实际落点与预检 `targetPath` 一致 + `deliverLetter` 返回 `created:false`（已有信件/并发赢家）⇒ 拒绝效应（不认领他人信件，防回退误删）；postverify = 结构校验（有效 Letter + `frame.id/to` 一致 + `status=pending`）。
- **类注册表**（`action/registry.ts::getActionClassRegistry`）：name → `ActionClass`（`classes/types.ts`，FileSnapshot/EffectResult 自 report.ts 迁出为单一事实源），**惰性构建**（破 ESM 循环 import `notify→scope→wake→run→registry`）；`runOneAction` 按 class 名取 6 个事务原语（`run.ts::getClass`，未注册 = null = fail-closed 防御性二校）。
- **「发信是否可回滚」裁定结论**：① 文件层——messageId 全新 ⇒ 快照 = 不存在；回退 = 删除自创信件 + 复验不存在（report 类「撤销自身效应不计 deletedFiles」同款先例）；**回滚窗口 = 信件 status 仍 pending**。② 消费端 claim 后状态改写/信息可能已达 ⇒ 不可撤；按 D1 裁定（2026-10-01 用户裁定）本地通知/GUI 呈现列为**显式不可回退例外**，**如实记账不冻结**（非 `rollback_failed` 冻结）。③ 红线——notify 效应面离开 `<stateDir>/autonomy/`（写进 mailbox spool），属**授权扩域**，边界 = 恰一信件文件 + 只 deliver 不消费。
- **许可判据（三工程纪律，取代环境隔离路线）**：可回滚判据 = **git 版本管理做好 + 文件夹分好 + 不删除原有文件**（D4 裁定：隔离路线被否决，spec `plans/20261001_autonomy_actionable_design.md` §6.3），机械执行在 `gitguard.ts`。**仓根解析是三路优先级**（`run.ts#L241`）：`ctx.repoRoot ?? discoverRepoRootForProject(trigger.project) ?? discoverRepoRoot()`——
  1. `ctx.repoRoot`：显式注入（测试 / 上层调用方），最高优先；
  2. `discoverRepoRootForProject(t.project)`（`gitguard.ts#L80`）：从 `trigger.project`（= frontier 的 project 键 = 本次动作影响的**那个项目仓**）用 `git -C <project> rev-parse --show-toplevel` 解析；`isLocalRepoPath`（`gitguard.ts#L65`，与 `classes/notify.ts::isRepoProjectPath` 同口径**双写**：Windows 盘符 / UNC / POSIX 绝对）判非路径形状（`mailbox:…` / `repo:X`）⇒ 返回 null，**不猜**；路径形状但非仓 / 目录不存在 / git 不可达 ⇒ 同样 null；
  3. `discoverRepoRoot()`（`gitguard.ts#L44`，可选 `cwd`，零参 = 进程 cwd，行为与旧实现逐字节一致）：兜底。
  **为什么改成这样**：扩展宿主进程的 cwd 常常不是 git 仓（实测主会话 cwd=`C:/Users/Annacomnena` ⇒ 非仓），旧实现只有 `ctx.repoRoot ?? discoverRepoRoot()`，拿进程 cwd 当检查对象 ⇒ 生产上 notify 类动作**全部**被 `git-repo-not-found(fail-closed)` 拒绝（实测 `state/autonomy/actions/actions.jsonl` 的 `rejected` 事件：`needs_user` 6 次 + `blocked_overdue` 11 次 + `expected_event_timeout` 1 次，reason 全为 `git-repo-not-found(fail-closed)`）。**fail-closed 语义不变**：三路都拿不到 ⇒ 仍 `DENY(git-repo-not-found(fail-closed))`，只是不再读错对象。其余纪律不变：动作前 `git status --porcelain` 记基线，动作后 porcelain **逐项比对**，任何新条目 = 违规 → 回退 + 熔断冻结；tracked 文件路径（P3 才出现）前置 dirty 即 DENY，且 autonomy **不代人 commit**。
- **决策树 L0–L3（含 L1.5）**（`policy.ts::decide`，纯零 IO，输入由 run.ts 从 fail-closed 读装配）：L0 总门（actionsEnabled / kill 在场 / breaker 可读且未 trip / isOwner）→ **L1 映射**（rule ∈ `TRIGGER_CLASS_MAP` ∧ class ∈ `map[rule]` ∧ class ∈ `ACTION_CLASS_ALLOWLIST`：映射外 rule = `DENY(trigger-not-allowed)`、映射内 class 不合 = `DENY(class-not-allowed)`；非 approximate）→ **L1.5 notify scope-owner 门**（仅 `notify-local-master` 生效：`ownerless` → `DENY(scope-ownerless)`、`stale` → `DENY(scope-owner-stale)`、`ok` 才放行，其余状态（`unknown` = hook 缺失、`n/a`）一律 `DENY(scope-owner-unknown)` fail-closed）→ L2 可回滚四要件（closure/snapshot/rollback/postverify/lease，unknown 一律 false → DENY）→ L3 预算熔断；verdict ∈ `AUTO_EXEC | SKIP | DENY | HUMAN`（HUMAN 仅作上层呈现，P1 无 HUMAN 出口——`needs_user` 已进映射且**仅映射 `notify-local-master`：永远交人 = 只通知 scope master、不代决**，不再被白名单拦截）。
- **预算/熔断常量**（`policy.ts::BUDGET`，**硬编码不可经 config 放大**，config 只许收紧）：每 tick 新动作 1、全局在途 1（串行化 ⇒ 回退归因无歧义）、滚动 1h ≤2、同 trigger×class×project 连败 2 停、rule:project 1h 去重 → SKIP(cooldown)、单动作读 ≤256KB、墙钟 ≤5s、frontier 快照逾 2 tick → TOCTOU SKIP(stale)。计数持久化 `state/autonomy/actions/breaker.json`（原子 tmp+rename）：**文件不存在 = 首次零计数（合法起点）；存在但损坏/形状漂移 = 读不到 = 拒绝动作**（防崩溃清零刷额度）；**失败尝试也占额度**。五类「可回滚承诺被证伪」→ `tripBreaker`（tripped+frozen，拒绝一切后续动作），仅人工 `clearActionsBreaker` 可解（非 autonomy 自主）。
- **账本**：动作事件**只进** `state/autonomy/actions/actions.jsonl`（append mode **0600** + **~1MB 两代 rename 轮转**，`ledger.ts`），**audit.jsonl 零污染**——W5 冻结行格式与 W6「单次评估恰 3 行」体积基线一字不动；账本写不进 = 不留无审计的动作（emit 失败 → 拒绝）。事件 kind：`attempted` / `precheck`（L0–L3 逐项实判）/ `executed`（effect + rollbackHandle）/ `postverified` / `rolled_back` / `rollback_failed` / `frozen` / `rejected` / `skipped`；`POLICY_VERSION=actions-v1`（未变）。可选字段 `suspectedEcho?: true`（additive，`v:1` 不变，见下条）。
- **疑似回声标记（短环可见化）**：动作发起时若 `actions.jsonl` 尾部存在**同 project 的 `executed` `notify-local-master` 事件且 ts 在 `BUDGET.hourMs`（1h）内**（`ledger.ts::hasRecentNotifyForProject`，扫尾部 200 条、排除未来时间戳、never-throw），本次动作**全部事件行**附 `suspectedEcho: true`（`run.ts#L157`）；`/autonomy status` 的 recent 行相应追加 `⚠echo`（`run.ts#L515`）。**只标记不改判定**——不 DENY、不 SKIP，纯可观测性；异 project / 超 1h 窗口 / 无近期 notify ⇒ 无标记。
- **事务包裹与回退**（`run.ts::runOneAction`）：attempted → 快照落盘（`actions/snaps/<id>/`，原字节/权限/存在性）→ precheck → **TOCTOU 最后入口复验**（重读 frontier 快照时效 + 目录前缀 + breaker 复读 + 预算复验）→ 原子写 effect → executed → postverify 回读比对；失配 → 按快照回退 + 回退后复验（复验失败 = 熔断冻结）；git 后置 porcelain 一致才 `postverified`。`undoAction(id)` 按账本快照句柄做动作级回退——无句柄 / 快照不可读 = 如实报 + 熔断（不猜）。
- **回放三问**（`replay.ts`，纯只读 never-throw）：① 做了什么 `queryActionsWhat`（ts ≥ since，kind ∈ {attempted, executed}）；② 为什么 `queryActionsWhy`（首事件 trigger + intent + policyVersion）；③ 能不能撤 `queryActionsUndo`（终态 = 已撤 / 不可撤已冻结 / 可撤（快照 meta.json 全可读）/ 无法保证可撤 / 未知终态）。
- **可见性**：`/autonomy status` 尾行 = `summarizeActionsStatus()`（never-throw ≤5 行；未启用且无记录 → 单行 `actions: disabled/无记录`；否则 `actions: enabled=… breaker=…` + 最近一条动作（回声命中附 `⚠echo`，`run.ts#L515`），`index.ts#L2754`；生产现状 `actions: enabled=on`）。
- **GUI 诚实文案（阶段二升级）**：`gui/src/pages/AutonomyPage.tsx` 两处（卡片段 + 页 intro）= 「开启动作开关后仅执行可回滚动作（诊断报告 + 本地通知信），不自动派活、不自动重启 worker」；纯文案，不动逻辑。
- **测试基线**：`npm run test:autonomy-actions`（`_test_runtime_autonomy_actions.ts`）**97 checks**（决策树矩阵 / 事务四行 / git 前后置 / 熔断预算 / 回退 / 回放三问 + notify 组：allowlist / 信件效应面 / pending 窗回滚 / claim 后处置 / dedupKey 含 class 段 / expectation 零写入 / 只发信不写文件 / 非 owner-kill-breaker 拒绝路径照旧 + **映射矩阵组**：既有 4 rule × 2 class 逐格 allowed/DENY、`needs_user`+report 与 `expected_event_timeout`+notify 两反例 `DENY(class-not-allowed)`、**scope-owner 组**：`ownerCheck` 三态直测 / 无主 → `DENY(scope-ownerless)` 且 mailbox 零信件 / notify + `unknown`·`n/a` → `DENY(scope-owner-unknown)`（fail-closed） / 有主正路径四行 / stale(pid 死) → `DENY(scope-owner-stale)` / report 类 `"n/a"` 不受影响 / **回声组**：同 project 1h 内再动作 → `suspectedEcho=true`、异 project·超窗无标记、status `⚠echo` / **⑤⑧ 防循环组**：`expected_event_timeout` 只产 report → 再 tick `skipped(cooldown)`、`needs_user` 只产 notify、无主 → DENY 永不产无主信 / **blocked_overdue 映射组**：只映 notify、已进 allowlist、cfgOn 下真投信且零 `diagnostic-report` 事件 / **仓根三路优先级组**：`ctx.repoRoot` > `trigger.project`（路径形状且真仓）> 进程 cwd 兜底，非路径 project 不猜、三路全空仍 `DENY(git-repo-not-found)`）；`_test_runtime_autonomy.ts` **79 checks**（含 ⑨b 发射/节流不变式组）；`_test_autonomy_wiring.ts` **15 项**（W1c 默认关逐字节同构 + `state/autonomy/actions*` 零新文件断言通过；W1b/W2.3/W3 为**既有基线失败**，与动作面无关——W2.3 连删 autonomy 键亦失败，W1b/W3 由 config 既有 `autonomy.enabled:true` 触发）。

## 监管账本（supervision）与默认开启（2026-10-18）

`stagnation` 的**权威意图载体**：每 runId 一份账本文件，由**主会话侧**写入，autonomy **只读**。默认值于 2026-10-18 **翻转为「派发即登记」**——旧默认相反（无账本 ⇒ `NOT_MONITORED` ⇒ 静默），把「记得授权」的负担留给人，缺陷实况 = SBS tab 停 8.5h 且三次 `stop=error` 卡死、autonomy 一次没报。

### 存储形状与路径

```
<stateDir>/supervision/open/<runId>.json     ← 监管中（status = active | paused）
<stateDir>/supervision/closed/<runId>.json   ← 已关账（终态：closedBy / closedAt / closeReason）
```

`stateDir` 缺省 `<runtimeDir>/state`（`~/.pi/agent/runtime/state`）。条目字段：`version:1` / `runId` / `taskId` / `repoPath` / `status:"active"|"paused"` / `setBy`（`master:<sid>` 或 `user:<sid>`）/ `setAt` / `pausedAt` / `pauseReason` / `softMs? pushMs? userMs?`（逐账本覆盖阈值）/ `epoch:{startedAt,pushes[]}`（P0 恒空；P1 起由 `supervise-push` 追加，见「主动推动」节）/ **`optOut?: true`** /（closed 才有）`closedBy? closedAt? closeReason?`。

纪律逐条镜像 `expectations.ts`：SoT = 一对象一文件、原子 tmp+rename、**全 never-throw**、**`closed/` 优先读取**（同 id 两目录并存的关账竞态残留 ⇒ 终态收敛）、`listOpenSupervisionEntries` 跳过 closed 有同 id 的僵尸 open。读侧 `validateEntry` 严格：`version` 必须 `===1`、`status` ∈ {active,paused}、`optOut` 缺失合法但存在必须**严格 `=== true`**（拒绝 `"yes"`/`1` 等宽松形状）。已关账条目**不可复活**（`setSupervisionStatus` / `setSupervisionOptOut` 见 `closedAt` 一律 `{ok:false, reason:"invalid"}`）。

### 六态语义与判据优先级

`deriveTabSupervisionState`（纯函数、每 tick 重算、零 IO）按下列顺序**短路**：

| # | 条件 | 结果 |
|---|---|---|
| 1 | 无账本条目（`!ledger`） | `NOT_MONITORED` |
| 2 | `ledger.optOut === true` | `NOT_MONITORED`（静默留档：不问不动） |
| 3 | `ledger.status === "paused"` | `PAUSED_USER` |
| 3a | `tab.phase === "unconfirmed" ∧ tab.stop !== "aborted"`（RF-1，`frontier.ts#L378`） | `BLOCKED_USER`（兜底结果：回合结束但没 `tab-finish` ⇒ 需人核实；`aborted` 例外 = 主动中断，不属静默卡死） |
| 3b | `tab.resultMissing === true ∧ mapPhaseToProjectState(tab.phase).terminal`（RF-1，`frontier.ts#L380`） | `BLOCKED_USER`（终态 phase 但 `result.json` 缺失 ⇒ **不得**伪装成 `DONE`） |
| 4 | tab phase 终态 | `DONE`（等主会话关账） |
| 5 | `needsHuman ∨ gate==="awaiting" ∨ attention>0` | `BLOCKED_USER`（提醒、不推动） |
| 6 | `tab.stop === "error"` | `BLOCKED_USER`（需人介入重派） |
| 7 | `tab.stop === "toolUse"` | `ACTIVE`（toolUse 豁免：跑长工具 ≠ 停滞） |
| 8 | `phase==="waiting" ∧ idleMs 有限 ∧ idleMs > pushMs` | `STALLED` |
| 9 | 其余 | `ACTIVE` |

- 行号锚点（2026-10-22 校准）：上表 1–9 条件对应 `extensions/runtime/autonomy/frontier.ts#L364-L394`（函数体逐行：`L372` 无账本 / `L374` optOut / `L375` paused / `L378` RF-1 3a / `L380` RF-1 3b / `L381` 终态 / `L382` needsHuman∨gate∨attention / `L386` stop=error / `L387` toolUse 豁免 / `L393` STALLED / `L394` ACTIVE）；`VARIANT_RANK` `#L325`、`SUPERVISION_RANK` `#L328`。
- 3a/3b（RF-1 两支）**必须先于** 4（终态→DONE）：否则「终态但没 result」会被判成 DONE（可以回收关账），把「没回报」伪装成「完成」。
- `idleMs === null`（无 `state.lastActivityAt` 载体）**不得**当停滞（不猜）。
- 阈值缺省 `SUPERVISION_THRESHOLDS` = SOFT 5min / PUSH 15min / USER 30min / HANG 60min，在 `supervision.ts#L48` 与 `frontier.ts#L86` 各存一份同源常量（frontier 零 IO 不得 import 该文件）。
- 项目级取**最严重**一个 tab 的派生（`SUPERVISION_RANK`）；`ProjectFrontier.stagnation` 判据**未变**，仍是 `supervision.state === "STALLED"`（brief 明令一字不动）。

#### `blocked_overdue`：与 `stagnation` 正交的超龄提醒载体（trigger ⑨b）

六态派生只规定了「如何分类」，但 `BLOCKED_USER`（在等人 / 出错等人重派）原本是个**永久静默区**——只显示、永不出声。`blocked_overdue` 补上机器链路上的出声路径：

- **正交关系**：`stagnation` = `STALLED`（idle 超 pushMs 的**边沿**，项目内最严重者）；`blocked_overdue` = `BLOCKED_USER ∧ idle > userMs`（**level**，已卡住并在等人、且已超龄太久）。两者判据互斥（STALLED vs BLOCKED_USER），**`stagnation` 判据一字未改**。
- **判据不重写**（`frontier.ts#L438-L465`）：在跑六态派生的**同一循环**里复用 `deriveTabSupervisionState` 的返回值——`st === "BLOCKED_USER"` 且该 tab 自身 `idleMs` 有限且 `> userMs`（`userMs` 先取账本覆盖值，否则取 `SUPERVISION_THRESHOLDS.userMs`）⇒ 收进 `odHits`。收集**全部**命中 runId（不只最重一个），按 idle 降序 + runId 升序排序得到 `ProjectCore.blockedOverdueRunIds` / `blockedOverdueRunId`（`frontier.ts#L462-L465`）。
- **发射纪律**（`frontier.ts#L617-L644`）：**每项目每帧最多 1 条** trigger（`blockedOverdueEmitted.set(...)` 后立即 `break`），逐 runId 判窗跳过窗内的，evidence = `blocked_overdue:run=<runId>:idleMin=<该 runId 自身 idle>`（不取项目 max，否则把“别的 tab 停得久”算成本 tab 的逾期度）。
- **节流账：权威在快照顶层**——`FrontierSnapshot.blockedOverdueThrottle`（`frontier.ts#L194-L203`，形状 `projectKey → runId → 上次提醒时刻 epoch ms`，窗口 `BLOCKED_OVERDUE_THROTTLE_MS = 1h`）。`ProjectFrontier.blockedOverdueLastAt`（`frontier.ts#L169-L176`）**只是它在项目上的投影**（供展示 / 图投影 / 测试），**发射判定不得读它**。
  - **为什么必须在顶层**：项目可能**整帧从可见集合消失**（tab 全变终态被 hidden / 进程重启 / 瞬时无 tab）⇒ `next.projects` 里没有它 ⇒ 账本挂在项目上就**整块丢失**，重现时所有 runId 都被当作「从未提醒」⇒ 窗内重发。节流语义是「这个 runId 多久前被提醒过」，与「本帧能否看到它」无关。
  - **裁剪与继承**（`frontier.ts#L670-L681`）：从 prev 快照**顶层**继承**全部项目**（含本帧不可见项目），只按 **1h 时间窗**裁剪（不按「本帧是否仍超龄」、也不按项目可见性），本帧发射的 runId 记 `now`。窗裁剪同时给出账本上界。未发射且 prev 无记录 ⇒ **不预置** `now`（预置会把「首次发现」自己静默 1h ⇒ 漏发；不预置 ⇒ 下帧必发，不可能风暴也不可能漏发）。
  - **已知边界**：`frontier.json` 被删 / 损坏 ⇒ 基线帧重建 ⇒ 节流状态丢失 ⇒ 同一 runId 最多**多提醒一次**（「宁可重发，不可漏发」，与 AGENTS R-5 同方向；不另立第二真相源）。
- **动作映射**：`blocked_overdue → 仅 notify-local-master`（见「动作面」的 `TRIGGER_CLASS_MAP`）。notify 对非路径 project 仍 fail-closed；路径形状 project 的仓根由三路优先级解析（同前）。

#### `stop="error"` ⇒ `BLOCKED_USER`：为什么故意不限定 phase

`extensions/tab-runs.ts` 的 phase 派生：`toolUse→working`、`stop|length→waiting`、**`error|aborted→unconfirmed`**。所以真实的 `stop="error"` 卡死 tab 其 `phase` 是 **`unconfirmed`** 而非 `waiting`——若把判据写成 `phase==="waiting" ∧ stop==="error"`，恰好漏掉最该人介入的形状（实证：SBS tab 三次 `stop=error` 卡死，phase 全为 `unconfirmed`）。故该判据**只判 `stop`，不判 `phase`**。

- `aborted` **明确不并入**：用户主动中断不属于静默卡死。
- `stop="error"` **不得**归 `STALLED`：它已经报错了，推它没用，需要的是人重派。

### 默认开启契约：派发即登记

`autoRegisterDispatchedTabs(results, deps)`（`extensions/runtime/supervision.ts`）是 launch-tabs 与 master-dispatch 共用的登记入口：

- 只登记 `!item.error && item.runId` 的条目（失败项不建账本——`error` 结果也可能带 runId）；
- 每条调 `setSupervisionStatus({ runId, status:"active", setBy, fromDispatch:true })`，`setBy = master:<sessionId>`；
- **整体 never-throw**：单条写失败继续处理其余条目，失败只 `deps.audit(...)` 记一行（注入的 audit 自身抛异常也被 catch 住，不外泄给派发）；返回 `{registered, failed}`。

三个接线点（同一原因：这三条派发都会产生 tab runId）：

- `extensions/index.ts` 的 `launch-tabs` tool execute（`const ok = results.filter(...)` 之后）：返回文本追加 `监管: N 个已自动登记（用 /supervise off <runId> 可取消，/supervise optout <runId> 可静默留档）`；`isError` 仍**只**由 `ok === 0` 决定——监管写失败**不得**把派发变成 error。
- `extensions/index.ts` 的 `dispatchTab` 闭包（`master-dispatch` 通道，`masterDispatchLaunch` 之后）：仅 `!res.stale && !res.error && res.runId` 才登记；返回形状不变；`extensions/master-tools.ts` 的成功文本同样提示「监管: 已自动登记」。
- **`extensions/one-shot-tab.ts::spawnOneShotTab`**（2026-10-19 补，`wake-*` / `l2-*` 一次性 wake tab 共用）：**spawn 成功之后**（`if (result.error) return` 之后）登记，与上面两处同语义——失败派发（已回写 `launch_failed`）不建账本。不补这一步，即使 ownership 门放行了本仓 owner，七门之 `no-mandate` 仍会先拒（`supervise-push` 推不动 `l2-*`）。

**尚未接自动登记的派发路径**（已知缺口，勿声称已覆盖）：`/launch` 直开 tab、`local-master-ensure` spawn、trace-fusion lane tab。

### 两种「别管」：`off` vs `optout`

| 命令 | 语义 | 账本形态 | 派生 |
|---|---|---|---|
| `/supervise off <runId>` | **关账**（「这个结束了」） | open → closed（wx first-wins） | 条目**离开**监管集合 |
| `/supervise optout <runId>` | **静默留档**（「这个别管我」） | **仍在 `open/`**，`status` 仍 `active`，写 `optOut: true` | `NOT_MONITORED` |

`optout` 是「这个别管」的机器表达：留档（可审计、可回看）与不问不动（派生等价于未登记）同时成立；`optOut` 与 `status` **正交**（静默 ≠ 暂停）。已关账（closed/）条目做 optout → `{ok:false, reason:"invalid"}`（终态不得重开）。

清除规则：`/supervise on|resume` **清除** `optOut`（显式「要监管」覆盖静默 —— `setSupervisionStatus` 在 `input.fromDispatch !== true` 时 `delete base.optOut`）；**自动派发登记不清除**（`input.fromDispatch === true`）——理由：重复登记同一 runId 不是用户的新意图，不得覆盖用户刚设的静默。`pause` 分支**不碰** `optOut`（暂停 ≠ 取消静默）。`/supervise` 的写操作在子 agent 会话被拒（`isSubagent()`），与 `/autonomy` 手动运维命令同口径。

### 只读红线（未破）

- autonomy 侧唯一接触点 = `collect.ts::readSupervisionInputs`，**只调读入口**（`supervisionRootForStateDir` + `listOpenSupervisionEntries`）；根目录不存在 ⇒ 返回 `undefined`（frontier 侧按「无载体」处理，不猜），读失败同样 `undefined`。它把 `optOut` 透传进 `FrontierSupervision` 供 `deriveTabSupervisionState` 判据，**不写任何账本文件**。
- **被监管者（tab 自身）永不写自己的账本**：写入口调用方只有主会话侧（`/supervise` 命令 + `autoRegisterDispatchedTabs`）。理由：被监管者不得自报停滞，否则「关掉监管」与「没有停滞」在派生面不可区分。
- **P0 阶段零推动**、**autonomy 侧永不写账本**（红线）：自动链只记录意图 + 派生显示，不调 tab-steer / set-timer / steer / spawn。P1 起 `epoch.pushes` 有了唯一写入者 —— 主会话工具 `supervise-push`（见下节），它由**被唤醒的 master 显式调用**、不在 autonomy tick 内 ⇒ 红线未破。

### 主动推动 supervise-push（P1，`2a4024a`）

把「知道谁停滞」变成「**能推、且推不动时拒绝**」。主会话工具 `supervise-push({runId, mode?})` 对停滞 tab 推一次有界提醒（C.2 模板），并把这次推动写进监管账本的 `epoch.pushes[]`。**推的理由是被唤醒的 master 显式调用，不是 autonomy tick 自动动手**：本模块是「**窄写入路径**」（只写 steer + 记 pushes + 一行 audit），不做任何自主决策循环。

#### 七条拒绝路径（`evaluatePushGuards`，纯函数，顺序先命中先返回）

`reason` 字符串**逐字固定**（测试逐条断言），这不是排序美学——顺序本身是策略：

| # | reason | 判据 | 为什么在这个位置 |
|---|---|---|---|
| 1 | `no-mandate` | `ledger === null` **或** `ledger.optOut === true` | 连监管意图都没有，后面所有判据都无载体。`optOut` 并入此门（与 `deriveTabSupervisionState` 的 `NOT_MONITORED` 同口径，不新增第 8 条语义） |
| 2 | `paused` | `ledger.status === "paused"` | 用户**显式意图**否决优先于一切机械判据（比「已终态」还优先：用户说停就停） |
| 3 | `terminal` | `view.terminal === true \|\| hasRealResult`，其中 `hasRealResult = result !== null && result.status !== "unconfirmed"`（`supervision-runtime.ts:413-414`） | 已终态 ⇒ 该回收（reclaim-tabs）而不是推。**兜底生成的 `status:"unconfirmed"` 结果不算终态证据**：它不是「tab 自己完成」，只是「回合结束了但没调 tab-finish」。`writeSettlementFallback`（`dd13dba`）会在 `agent_settled` **同秒**给它写这条 unconfirmed result ⇒ 若按旧的 `result !== null` 判终态，门 4b 专门放行的「`stop=error` 首次推动」**永远走不到**（SBS-B1 实测形状正是 `stop=error` + unconfirmed 同秒落盘）。判据合法性：`tab-runs.ts::validateTabResult` 双向强制 `status==="unconfirmed" ⟺ autoGenerated===true` ⇒ 用 `status` 判等价于判「是否兜底」 |
| 4 | `needs-human` | `gate === "awaiting" ∨ attention > 0`（`hardBlocked`：除调用方 `needsHuman` 布尔外**再独立复核** gate/attention） | 真的在等人 ⇒ **只告不推**（C.4）。**判定口径见下方「口径差异」** |
| 4b | `needs-human`（同一 reason 字符串，不新增） | `stopReason === "error"` **∧** `pushesThisEpoch >= 1` | `stop=error` 不是「在等人」，是「出错了要重试」。**首次（本 epoch 未推过）放行**去试复活；推过一次仍 error ⇒ 错误不是瞬时的，才升级给人。放行路径**不豁免**任何门：预算（2/epoch、4/1h）、`pid-dead`、`tool-use` 照旧约束 |
| 5 | `budget-exhausted` | `pushesThisEpoch >= maxPushes` **∨** `pushesLastHour >= 4` | 预算在活性判据之前：预算已尽时推不推都没意义，先给出可行动结论（升级用户） |
| 6 | `pid-dead` | `pidAlive === false` | 推是写空气 ⇒ 转重派决策。`pidAlive === null`（无 pid 字段/探活抛错）**不拒**（不猜） |
| 7 | `tool-use` | `phase === "working" ∧ stopReason === "toolUse"` | 最弱的软门：只挡「在跑工具被误当 idle」 |

`reason: "io-error"` **不属于这七条**：基础设施失败（读账本/写 steer/写账本异常）与**空 `runId`**（`detail` 前缀 `invalid-input:`）都收敛为 `io-error`，保证七条策略门互斥干净、可被逐条断言。工具输出层另有 `REJECT_HINT`（`supervision-runtime.ts` 内部常量，不导出）给每条一句中文人读提示。

#### 模板（`pushTemplate`，C.2 逐字，不可美化改写）

```
【监管推动 #N/预算M】任务 <taskId>（<repo 目录名>）已停 <idleMin>min。
最后状态：stop=<stop>，摘要：<summary ≤120 字>。
1) 若仍可推进：继续当前任务，不要重做已完成部分（先读你自己的交接/计划文件再续）。
2) 若在等外部条件（解封/窗口/他人）：回报【等什么|谁解锁|预计何时】，我转告用户。
3) 若已完成：立即调用 tab-finish 回报（不调 = 未完成）。
```

第 2 条是设计要点：把「未知原因的停」翻译成显式 BLOCKED 信号——48min 等解封那类事故会在 15min 就被顶到台面，而不是 48min 后靠猜。摘要截断常量 `SUPERVISION_SUMMARY_MAX = 120`（与 wake 监管块 `WAKE_SUMMARY_MAX = 120` 同口径）。

#### 预算机制与返回形状

- `SUPERVISION_MAX_PUSHES = 2`（每停滞 epoch）；`clampMaxPushes` 钳 `[1,3]`（非法/缺失 → 常量缺省；`deps.maxPushes` **仅测试用**）。
- `SUPERVISION_PUSH_HOURLY_CAP = 4`：单 runId **近 1h** 滚动节流（防抖振荡）。
- **epoch 计数是读侧重置，不写盘**：`effectiveEpochStart = max(epoch.startedAt, state.lastActivityAt)`（`epochStartMsOf`）⇒ tab 在上次推动后有过活动，那些 push 不再计入本 epoch；`countPushes` 同时算 `thisEpoch` 与 `lastHour`。理由：`supervise-push` 是窄路径，多一次账本写就多一个竞态窗口（同 AGENTS R-3 多写者纪律）。代价：账本 `epoch.pushes[]` 只增（当前无人显式重置 `epoch.startedAt`），且 frontier 的 `epochPushes`（`collect.ts:395`，全量 `pushes.length`）与这里的 `pushesThisEpoch`（读侧重置后）**口径不同，未合并**。
- **返回形状**（`SupervisePushResult`）：成功 `{ok:true, steerId, pushIndex, remainingBudget, mode}`；失败 `{ok:false, reason: PushRejectReason | "io-error", detail}`。`supervisePush` **never-throw**（所有异常收敛 `io-error`；审计注入抛错也被吞，同 `autoRegisterDispatchedTabs` 纪律）。
- **七步编排**（`supervisePush`）：读账本+dispatch+state+result → `composeTabStatus` 组判态（`probe: null`，不猜 JSONL）→ 聚合 needsHuman/terminal/pid → `evaluatePushGuards` → `pushTemplate` + `writeSteerAtomic`（**复用** `steer.ts::newSteerId` / `writeSteerAtomic`，不自造 id/文件）→ `epoch.pushes` 回写（**复用** `writeSupervisionEntry`）→ audit 一行。
- **档位（按相位自动选，显式优先）**：`mode` 取值顺序 = **显式传入永远优先**；否则 `phase === "working"` ⇒ `"steer"`，其余（`waiting` 等空闲相位）⇒ `"abort"`。
  - **为什么这样切**：`STALLED` 的定义就是 idle 超阈值 ⇒ 必然 `waiting` ⇒ 自动档必须是 `abort`；而 `steer` 档带 `deliverAs:"steer"`（等下一个 tool 边界），对已 settled 的 tab **永不起新 turn** ⇒ 缺省 `steer` 会让工具对它唯一的目标场景完全无效。
  - **C.3「绝不自动升级」的解读边界**（关键，勿再误读）：C.3 原文约束的是**不打断正在运行的工具**——这一条已由 `tool-use` 门机械保证（`working ∧ stop=toolUse` ⇒ 拒绝，根本不会推），**与档位选择无关**。它**不**约束「idle tab 也不许用 abort」：idle tab 没有 run 可打断，abort 只是无害前置（`steer-consumer.ts`：abort → 等 idle ≤30s → 发消息起新 turn）。把「缺省 steer、abort 必须显式传入」当成 C.3 的要求是**误读**。
- **账本推动记录**：`push = {at, mode, steerId, reason:"stalled", outcome:"pending"}`——`mode`/`reason` 是 `SupervisionPushRecord` 的**运行时超集**（读侧宽容，v1 形状不变）。
- **身份门**（2026-10-19 方案 C 修订，`plans/20261019_supervise_push_gate_task_brief.md`）：`execute` 层**三档 fail-closed**，判定体在纯函数 `extensions/supervise-gate.ts::supervisePushGate`（零 IO；`readLocalOwnerAttachment(cwd)` 是唯一 IO 入口）：
  - **子 agent**（`isSubagent()`）⇒ 拒（`subagent`）。
  - **`getTabRunId()` 为空（主会话）⇒ 直接 `via:"main"` 放行，不进 ownership 门、不读 attachment/dispatch**（R3 硬规则：主会话路径逐字节不变；否则 `masterDispatchGate` 的 `unknown-session` 分支会误伤「拿不到 `ctx` 的主会话」）。
  - **tab 且是本仓 local owner**（`sessionId === durableSessionIdentity(ctx)` + `masterDispatchGate` 的**双读 generation fencing**）⇒ 放行 `via:"owner"`，但**加目标约束**：目标 `dispatch.cwd` 必须落在本仓子树内（`runtime/wake.ts::repoPathMatches`，与监管块 repo 过滤**同一函数**）；目标是自身 ⇒ `self-push`，他仓/无仓载体 ⇒ `cross-repo`。
  - **tab 非 owner**（普通 workflow tab / `l2-*` / `wake-*`）⇒ 拒（`tab-session`）。
  - **注入地址必须是本仓 local**：`readAttachment(localAgentFromCwd(ctx.cwd))`。**禁止** `masterAddress()`（全局）——实盘全局 `agent://master_default` 与 `agent://master_local_<scope>` 是**不同 sessionId**，注入全局地址会让 owner 判定恒假 ⇒ 改门等于没改。
  - `cross-repo` / `self-push` / `tab-session` / `generation-mismatch` / `unknown-session` / `subagent` 是 **execute 层**拒绝：**不进**七条 `PushRejectReason`、**不进** `SupervisePushResult`，但**写 audit 行**（`supervision-push reject-gate …`）。
  - **能力边界**：本门修好的是 local master 的**推动能力**，**不是** autonomy 链的自动化——今天两条 wake 路的执行者（`wake-*` / `l2-*` 一次性 tab）**都不是 owner** ⇒ 它们仍推不动任何 tab。把推动指令真正送到 local master 手上属另一任务。
- **派发即登记覆盖一次性 wake tab**（同批，2026-10-19）：`spawnOneShotTab`（`extensions/one-shot-tab.ts`，`wake-*` / `l2-*` 共用）在 spawn **成功后**调 `autoRegisterDispatchedTabs`。不补这一步，本仓 owner 即使过了 ownership 门也会被七门之 `no-mandate` 先拒。语义与另两处（`dispatchTab` = master-dispatch、`launch-tabs`）一致：**失败的派发不登记**。
- **审计行**：成功 `supervision-push ok runId=… steerId=… push=N/M remaining=… mode=… task=… idle=…min`；拒绝 `supervision-push reject runId=… reason=… detail=…`；基础设施失败 `supervision-push io-error …`（经 `index.ts` 注入的 `appendAuditLine` 落 `state/autonomy/audit.jsonl`）。

#### ⚠️ 口径差异（刻意，不是 bug）：`frontier` 的 `BLOCKED_USER` ≠ `supervise-push` 的 `needs-human`

**同一个 runId 可以同时是「frontier 显示 `BLOCKED_USER`」和「`supervise-push` 可推」**。这个差异是实测驱动的设计修正，**不要当成 bug 去「修」**：

| 侧 | 判据 | 源码 |
|---|---|---|
| `frontier` → `BLOCKED_USER`（P0 定稿，**未改**） | `tab.needsHuman` ∨ `gate==="awaiting"` ∨ `attention>0`，再 ∨ `stop==="error"`；而 `tab.needsHuman = reclaim === "awaitingInput" \|\| gate === "awaiting"`（**广义 reclaim**） | `frontier-carriers.ts#L301-L314`（`return` 在 `#L313`）→ `frontier.ts#L382`（2026-10-22 校准；旧引 `frontier-carriers.ts:338` / `frontier.ts:329-331` 已漂移） |
| `supervise-push` → `needs-human`（**两次收窄**） | ① `gate === "awaiting"` ∨ `attention > 0`；② **或** `stop === "error" ∧ pushesThisEpoch >= 1`（**不含 `awaitingInput`**；`stop=error` 首推放行） | `supervision-runtime.ts::evaluatePushGuards` 门 4 / 4b |

理由（关键）：`tab-runs-runtime.ts::classifyForReclaim`（`:541-551`）把 `phase === "waiting"` 映射成 `awaitingInput`，而 **`waiting` 正是已 `agent_settled` 的 idle tab 的形状 = STALLED 的形状**。若把 `awaitingInput` 计入 `needs-human`，则**真实 idle tab 恒被拒** ⇒ `STALLED` 永不触发 ⇒ P1 核心交付在真实盘面完全不可用（已用独立探针实测证明：把聚合改回含 `awaitingInput` 后，真实端到端成功用例实红且命中预期断言）。

因此：`supervision-runtime.ts` 的 `supervisePush` 仍**调用** `classifyForReclaim(view)`（保持与 P0 同一视图，便于对照），但**不把它的返回值当 `needsHuman` 判据**。真正需人介入只由 `gate === "awaiting"` / `attention > 0` 两个实质载体挡住。

**`stop="error"` 已移出 `needsHuman`**（第二次收窄）：它是「出错了，需要重试」，不是「在等人」。原先把 error 并入 `needsHuman` ⇒ error tab 被 `needs-human` 永久拒绝 ⇒ **永不推**，而 error 恰恰是最该推的一类（瞬时 `Connection error` 卡死的 tab）。现在：本 epoch 未推过 ⇒ 放行推一次试复活；推过一次仍 error ⇒ 才以 `needs-human` 升级给人。**`gate=awaiting` / `attention>0` 永不走这条放行路径**（`hardBlocked` 在 4b 之前判定，且 `evaluatePushGuards` 独立复核 gate/attention，不只信调用方的聚合布尔）。

> 若将来要统一两侧口径，正确方向是**收窄 frontier 的 `needsHuman`**（把 `awaitingInput` 从 `tab.needsHuman` 里拆出去，另给「空闲待聊」单独语义），而不是放宽 `supervise-push`——放宽会让 P1 失效。

#### 回收分桶 `unconfirmed`（七类，与门 3 同一条语义）

`tab-runs-runtime.ts::classifyForReclaim`（`:541-551`）把回收口径从六类拆成**七类**：`launch_failed → failed`（最高优先）→ **`unconfirmed`** → `ready` / `pending` / `awaitingInput` / `failed` / `orphaned`。

- **`unconfirmed` 的语义** =「**回合结束但未调用 tab-finish** ⇒ 需人工核实实际进度，**核实前不得直接另派同一任务**」。判据 `view.phase === "unconfirmed"`（`composeTabStatus` 对 `status:"unconfirmed"` 的 result 派生 `phase:"unconfirmed"` / `terminal:false` / `resultMissing:true`）。
- **顺序**：`launch_failed` 第一，`unconfirmed` 第二——**显式前置到 `TERMINAL_PHASES`（completed/failed/cancelled）之前**，让「phase 字面 unconfirmed ⇒ 独立桶」不依赖 phase 集合的当前内容。
- **为什么从 `failed` 拆出**（不是措辞洁癖）：`failed` 的语义是「已失败 ⇒ **可以另起新 tab**」；而 unconfirmed 只说明「这回合 settle 了、成果未声明」——tab 可能只是**中途停下**，成果真实存在（SBS-B1 的 commit 是真的）。归 `failed` 会通过 event-bus 的 reclaim 编排诱导主会话「失败 ⇒ 另派」，与**可能复活的原 tab 双写竞争**（两个 tab 改同一批文件）。
- **消费点**（口径一致，全部新增该组）：`reclaim-tabs` 的返回分组 `details.unconfirmed[]` + `summary`（`unconfirmed=N`）+ `renderResult` 分组 + 工具 description；`failed` 组退化为「真失败 + 派发失败（`launch_failed`）」。
- **文案硬约束**：unconfirmed 分组正文**不得**含「重派 / rerun / re-run / 重启 / retry」——改用「另派**同一任务**」+「先读该 tab 的交付物/计划文件再决定」。理由同拆分理由：正文出现「重派」就等于在建议另起新 tab。`_test_tab_runs_runtime` 有禁词正则断言。
- **`needsHuman` 刻意不含 `unconfirmed`**（`frontier-carriers.ts#L313`：`needsHuman = reclaim === "awaitingInput" || gate === "awaiting"`）：若把 unconfirmed 纳入，unconfirmed tab 会命中 `supervise-push` 的 `needs-human` 门 ⇒ **与门 3（terminal）修复互相抵消**（门 3 刚放开「兜底 unconfirmed 不挡推」，门 4 又用 needs-human 挡回）。这是**刻意口径**，不是漏改。
- **兜底 unconfirmed 的 `attention:true`**（`frontier-carriers.ts:203`）会让该仓 attention > 0 ⇒ 同仓所有受监管 tab 派生 `BLOCKED_USER`（六态规则 5）⇒ `STALLED` 不可达。这正是 `writeSettlementFallback` 必须有**常驻身份豁免**的原因（见下条），而不是靠 frontier 侧放宽。

#### 兜底写入的常驻身份豁免（`writeSettlementFallback`，`tab-runs-runtime.ts:105-131`）

`SettlementFallbackOutcome` 新增取值 **`"skip-persistent-identity"`**：`dispatch.taskId` 以 **`lms-`**（local master，`runtime/local-master-launch.ts::ensureTaskId` = `lms-<scope>`）或 **`master-`** 开头 ⇒ **不写兜底结果**（`_test_tab_report_fallback` 10(a)–10(d)，经真实 `agent_settled` 入口 + 普通 taskId 对照）。

- **理由**：`runtime/local-master-launch.ts:249` 明令 local master「**不要 tab-finish、不要退出**」⇒ 它每次 settle 都是**设计行为**，不是「忘了回报」。给常驻 tab 写兜底 ⇒ **每回合一条永久 unconfirmed** ⇒ 其 `attention:true` 把该仓 attention 抬成 > 0 ⇒ 同仓所有受监管 tab 派生 `BLOCKED_USER` ⇒ `STALLED` 从此不可达。
- **位置**：「已有 result 检查」之后、「写盘」之前 ⇒ 幂等语义（`skip-has-result` / `skip-no-dispatch`）不变，且不浪费 IO。
- **已知边界（勿夸大）**：`master-` 前缀是**命名约定**——`master-dispatch` 的 taskId 由调用方自由传入（示例是 `S2`），生产上不带 `master-` 前缀的 master 派发**不受豁免**；`lms-` 是唯一强保证（唯一构造点 `ensureTaskId`）。

#### 相关字段与接线

- `extensions/runtime/wake.ts::buildWakePrompt(ws, letters, supervision?)`——**第三可选参** `WakeSupervisionItem[]`（`{runId, taskId, repoPath, idleMs, stopReason, summary, pushesUsed, maxPushes}`），非空时插入「停滞监管」块（最多 10 条；摘要截断 120）。`undefined` / `[]` ⇒ **输出逐字节不变**（`Array.isArray(supervision) && length > 0` 才调用 `buildSupervisionBlock`）。
- `extensions/runtime/wake.ts::buildSupervisionBlock(items, opts?)`——**渲染层**，`opts.executorIsOwner`（缺省 `false`，fail-closed）决定是否渲染「`用 supervise-push({runId:"…"}) 推动`」那一行：
  - 停滞信息行（`已停 Nmin` / `stop=` / `push=x/y` / 摘要）**恒渲染**；
  - `executorIsOwner === true` ⇒ 追加上推动指令行；`false` / 缺省 ⇒ 只有停滞信息。
  - 原因：执行者若不是本仓 owner（今天两条 wake 路的 `wake-*` / `l2-*` 都是一次性 tab），那条指令必被 execute 层 ownership 门拒 ⇒ 是「说能推、实际被拒」的误导。
  - **`buildWakePrompt`（workstream 路）显式传 `{executorIsOwner: true}`** 以保持逐字节不变；该路的重路由属独立任务。
- `extensions/runtime/scope.ts::buildScopeWakePrompt(scope, letters, repoCwd, supervision?, executorIsOwner = false)`——**第四可选参**（监管块）+ **第五参 `executorIsOwner`**（缺省 `false`，fail-closed）。与 `buildWakePrompt` **同源**（均调 `wake.ts::buildSupervisionBlock`，`scope.ts#L46` import）且同为「`待处理输入` 行之后、回执块之前」；`undefined` / `[]` 与三参调用**逐字节相同**。scope 路的派生点在 `evaluateScopeWake`（`scope.ts#L401-L416`）——**claim 成功后**才调 `deriveSupervisionItems`（`no-mail` / `claim-missed` 早退路径零 IO），并传 `repoPath: repoCwd` 做仓过滤。
- **scope 路当前传 `executorIsOwner=false`**：执行者是 `registerScopeWakeLoop` spawn 的 `l2-*` 一次性 tab，`durableSessionIdentity` 是新会话 UUID，不等于 scope owner 的 sessionId ⇒ 推不动。这是**当前事实**，不是永久契约：若将来把推动指令重路由给真 owner，该处改传 `true`。
- **派生接线（生产已有两个调用方）**：`wake.ts::deriveSupervisionItems`（读监管账本 + tab 账本 + tab result）产出条目后传入 prompt——workstream 路在 `evaluateOne` 的 fire 分支传入 `buildWakePrompt(ws, letters, supervision)`；**scope 路在 `evaluateScopeWake` 的 claim 成功后**传入 `buildScopeWakePrompt(scope, letters, repoCwd, supervision)`（`scope.ts#L401-L411`），并带 `repoPath: repoCwd` 做仓过滤。取两类：`stopReason === "error"`（BLOCKED_USER 里唯一该被推的子类）与 STALLED 形状（`phase === "waiting" ∧ idleMs > thresholdsOf(entry).pushMs ∧ stop ∉ {toolUse,error,aborted}`）；跳过 `status !== "active"` / `optOut === true` / `view.terminal === true`（后者必被 `terminal` 门拒，不进 prompt 以免噪声）。**整段 never-throw**：读失败/为空 ⇒ `undefined`（保持逐字节不变的既有保证）。
- **依赖方向（不得反向）**：`wake.ts` 只 import 纯库 `./supervision.ts`（`listOpenSupervisionEntries` / `thresholdsOf`）+ `../tab-runs.ts`；**不得** import `../supervision-runtime.ts`（Pi tool 层，import `@earendil-works/pi-coding-agent` / `pi-tui` / typebox，反向会把它拖进 wake 的依赖闭包）。已实测无循环依赖。
- **双写登记点**：`wake.ts::pushesThisEpochOf` / `WAKE_PUSH_MAX_DEFAULT` / `clampPushMax` 与 tool 层 `supervision-runtime.ts::countPushes` / `SUPERVISION_MAX_PUSHES` / `clampMaxPushes` **同口径双写**（各仅两行逻辑，双写成本低于破层成本）。**改动任一侧必须同步另一侧**——这是唯一登记点。
- `extensions/tab-runs.ts::TabState.currentToolStartedAt?: string`（ISO 时刻）：**写入** `tool_execution_start`；**清除** `tool_execution_end` / `agent_settled` / `session_shutdown`（`tab-runs-runtime.ts:96-107/140`）。配套新增 `tool_execution_end` 监听（原先只有 start）⇒ `lastActivityAt` 在**每个工具完成时**也刷新（不只是开始时）。目的：让 HANG 判据（`working ∧ stop=toolUse` 满分 60min）能区分「一个工具跑了 55min」vs「一连串工具各跑几分钟」。
- `extensions/index.ts:2543`：`collect(registerSupervisionTools(pi, { audit: (line) => appendAuditLine(line) }))`，紧跟 `registerSteerTools`。
- **验证入口**：`npm run test:supervision-push`（`extensions/_test_runtime_supervision_push.ts`，**77 checks**；第 10 组为「兜底 unconfirmed 不得作为 terminal 证据」10(a)/10(b)，第 11 组为 scope 路 `buildScopeWakePrompt` 第四/五参冻结/过滤/「非 owner 不渲染推动指令」11(a)–11(e)，第 12 组为 end-to-end：frontier → actions → scope mailbox → scope wake prompt）。ownership 门的矩阵与接线回归在 `extensions/_test_supervise_gate.ts`（**48 checks**，含 G1–G9、P0–P6 路径穿越反例、S1–S4 §5.1 fail-closed、W1–W7、R6 跨进程）。

#### `repoPathMatches` / `normRepoPath`：路径穿越防护（安全边界，勿简化）

- **`normRepoPath(p)`**：先 canonicalize（按输入形状显式择一：盘符绝对 / UNC ⇒ `node:path.win32.resolve`；POSIX 绝对 ⇒ `node:path.posix.resolve`），再 反斜杠→斜杠 / 去非根尾斜杠 / 小写。**相对路径（含 `C:repo`）⇒ 返回 `""`（fail-closed，绝不对相对路径调 `resolve`：那会吃 `process.cwd()` 并把相对路径变成某仓内的路径）。**
- **`repoPathMatches(candidate, filter)`**：**两端**都 `normRepoPath` 后比较；任一端为空 ⇒ `false`。相等 ⇒ 命中；`filter` 是根（`/`、`c:/`、UNC 共享根，即归一后以 `/` 结尾）⇒ 整树子树；否则必须按 `/` 分段前缀（`c:/repo2` **不得**算 `c:/repo` 的子目录）。
- **为什么必须 canonicalize**：旧实现只做斜杠/尾斜杠/小写 ⇒ `C:/repo/../OtherRepo` 归一成 `c:/repo/../otherrepo`，满足 `startsWith("c:/repo/")` ⇒ `supervise-push` 的跨仓约束被**绕过**（真调用返回 `{ok:true,via:"owner"}`，文件系统实际解析到 `C:/OtherRepo`）。`dispatch.cwd` 是派发时写入的原始字符串，**不保证已规范化** ⇒ 不能指望上游。
- **两个消费方，同一判据**：`extensions/supervise-gate.ts`（execute 层「本仓子树」目标约束）+ `extensions/runtime/wake.ts::deriveSupervisionItems` 的 `repoPath` 过滤（scope 路）。改动此函数会同时影响两者——这是期望行为，改完必须跑 `_test_supervise_gate` + `_test_runtime_supervision_push` + `_test_runtime_wake` + `_test_local_master`。
- **已知未覆盖（登记，非缺陷遗漏）**：8.3 短名 / 符号链接 / 硬链接 / 扩展长度前缀的**实体**解析。需要磁盘 IO，做了会把判据变成「盘上存在才判」。字形不同的后果方向是**误拒**（`cross-repo`），不是误放。

#### 未闭合边界（勿当成已完成）

1. ~~`buildWakePrompt` 第三参无生产调用方~~ **已闭合**：`evaluateOne` 的 fire 分支经 `deriveSupervisionItems` 派生后传入（见「相关字段与接线」）。
2. ~~steer 档对 idle tab 不起新 turn~~ **已闭合**：缺省档改为按相位自动选（`waiting` ⇒ `abort`），显式传入仍优先。
3. **`currentToolStartedAt` 不做嵌套计数**：并行工具时 `tool_execution_start` 只保留**最后一个**起始时刻，任一 `tool_execution_end` 就清空 ⇒ 并行工具批次里 HANG 判据可能**提前归零**。要修需计数器/栈（改 `TabState` 形状 + bump 版本）。
4. **`io-error` 形状借用了空 `runId` 的收敛口**：空/非法 `runId` 也走 `io-error`（不是第 8 条策略门）⇒ 调用方无法从 `reason` 区分「参数错」与「磁盘满」，只能读 `detail`（前缀 `invalid-input:`）。另：`writeSteerAtomic` 成功但 `writeSupervisionEntry` 失败 ⇒ 返回 `io-error` 而 **steer 已落盘**（真实推动已发生），`detail` 带 `steerId=` 便于追责；取舍同 AGENTS R-5「宁可重发不可漏发」（重试会多一条推动，1h ≤4 上限兜住），未做成显式 `partial` reason（那会变成第 8 条语义，与 spec 冲突）。
5. **workstream 路（`wake-*`）仍渲染不可执行的推动指令**：`buildWakePrompt` 为保住逐字节冻结基线显式传 `{executorIsOwner: true}`，而执行者（`wake-*` 一次性 tab）不是本仓 owner ⇒ 仍会收到「用 supervise-push 推动」而实际被拒。**scope 路已修**（`l2-*` 不再收到）。真解是把推动指令重路由给 local master 自己（或采纳建议队列），属独立任务。

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
- GUI 设置区「主动性套件」卡片 + **诚实文案**（初版："当前不执行任何自动动作"，已随动作面阶段二升级，现文见「动作面」节）
- HTTP 只读 `GET /v1/autonomy/frontier`（见下节）

### GUI 落点（RuntimeOverlay 第 6 section + frontier 读端点）

- **`GET /v1/autonomy/frontier`（只读）**（`extensions/runtime-host/server.ts:1264`）：与 status/set 同一授权档（`authorizeCommand`，未认证 401）；只调 `readFrontierSnapshot({ stateDir })`——**读盘即返回完整 `FrontierSnapshot`，不重计算、零写入**；快照缺失/坏 JSON/字段漂移 → `200 null`（客户端据此区分「无文件」与「0 项目基线帧」）；仅 GET，其余方法 405。`/v1/autonomy/status` 形状未改（向后兼容）。
- **GUI 第 6 section**：`RuntimeOverlaySection` 六值 union（`gui/src/store.ts:38`：attention/master/workstream/runtime/wechat/**autonomy**），`RuntimeOverlay` SECTIONS 表新增「主动性」（Activity 图标，`gui/src/pages/RuntimeOverlay.tsx:28-35`），`runtimeOverlay === "autonomy"` 打开即定位该 section；覆盖层页内容 = `gui/src/pages/AutonomyPage.tsx`：
  - `AutonomySettings`（总门开关）——**自微信连接页（ChannelsPage）整体迁出**，ChannelsPage 零引用；开关行为/API 逐字不变（`GET /v1/autonomy/status` + `POST /v1/autonomy/set`）。迁出后卡片不再位于任何带 401/403 早退分支的页内 → 默认配置与未认证/无权限各态下开关均可见（D17 可达性由此结构性保证，非逐分支补钉）。仍保留诚实文案（现文见「动作面」节 GUI 条目）与 `awayMode`「未实现（保留字段），不提供开关」。
  - `FrontierViz`（frontier 可视化，`api.autonomyFrontier()`，**5s 轮询**，`gui/src/api/client.ts#L155` + `gui/src/pages/AutonomyPage.tsx#L126`）三块：**C 快照时效**（`asof` 相对时间 + `baseline` 首帧徽标 + 项目/触发计数）、**A 项目状态矩阵**（每项目 state+variant / needsUser 高亮 / gate / resultMissing / stagnation / overdue / runs 明细）、**B 触发记录表**（rule/project/evidence，`approximate` 降透明度 + 「近似」徽标）。状态语义：`snap===undefined` 加载中、`null` → 「快照尚未生成（autonomy 未启用，或尚未完成首次 tick）」；读失败显示可恢复错误、保留最近快照（不留永久加载态）；`gate:"unknown"` 呈中性「未知」（与 watchdog 3/8 恒 unknown 同款“不猜”语义）。零图表库（Badge/Card 手写）。
  - **GUI 侧类型已同步 / 渲染仍故意不做（2026-10-22 实测分母）**：`gui/src/api/types.ts#L730-L780` 现已同步服务端四组字段——`SupervisionState`（`#L730-L737` 六态联合）+ `ProjectSupervision{state,idleMs,epochPushes}`（`#L739-L746`）+ `ProjectFrontier.supervision`（`#L780`）+ `blockedOverdue`（`#L766`）+ `blockedOverdueRunId(s)`（`#L768`/`#L770`）+ `blockedOverdueLastAt`（`#L778`）；`rg -c 'supervision|blockedOverdue|epochPushes|idleMs' gui/src` 命中 **1 文件 / 14 行**（全部在 `types.ts`，即类型层）。**字段有 ≠ 漏渲染**：`gui/src/pages/AutonomyPage.tsx` 有意不展示这两组（类型/注释块 `#L747-L754` 已写明理由）——① 六态机是**监管派生判据**，需账本语义（谁登记、optOut、epoch 预算）才能读对，直接当「项目状态」展示易误读；② `blockedOverdue*` 是**周期提醒**的发射/节流载体（1h/runId，权威账本在快照顶层 `blockedOverdueThrottle[project]`，本字段只是投影），不是面板指标。故 GUI 面板仍只消费 `state`/`variant`/`gate`/`needsUser`/`resultMissing`/`stagnation`/`overdue`/`runs`。
  - `stagnation` 仍只是 `supervision.state === "STALLED"` 的**布尔投影**（`frontier.ts#L147-L151` 注释；GUI 侧 `stagnation` 字面出现在 `gui/src` 共 6 行 / 2 文件——`api/types.ts` 3 行 + `pages/AutonomyPage.tsx` 3 行）。其 tooltip 口径现为「六态机 STALLED：有监管账本 + waiting 相位 + idle > `pushMs`（默认 15min = `frontier.ts:88`，可被账本覆盖）；无账本/在等人/报错/跑长工具都不算」——旧文案「非终态 45min 无进展 ∨ 结果缺失」已汰除（`staleOver(45min)` 是**已拆除的旧语义**，见 `frontier.ts#L149`）。

### A3 awayMode 空壳
`autonomy.awayMode.enabled` 被解析但**无任何生产消费者** ⇒ 保留字段但 GUI 明确标注"未实现（保留字段）"，且**不提供开关**（不让界面出现按了没反应的按钮）。

### GUI 挂载位置约束（D17 可达性）

开关必须挂在**不受错误态早退影响**的位置：若把 `AutonomySettings` 放进带 `disabled`(403)/`unauthorized`(401) 提前 return 的页，卡片会被埋在闸后、默认配置下不可见（端点本身没问题，是挂载位置遮蔽）。现组件位于独立的 `AutonomyPage`（无任何早退分支），因此默认配置 + 各错误态下开关均可见；**验收口径**：D17 可达性须覆盖「默认配置 + 各错误态」，只看正常态会漏。

## Evidence

- **P1 主动推动 + 三处修正（`2a4024a` + 后续 commit，2026-10-18 实测）**：`npm run test:supervision-push`（`extensions/_test_runtime_supervision_push.ts`）→ **all 71 checks passed**（七条拒绝路径逐条 + 门 4b `stop=error` 首推放行 + `io-error` 两条 + 模板逐字 + 预算/读侧重置 + `buildWakePrompt` 第三参 undefined/[] 与手写冻结字面量逐字节相等 + 工具注册与身份门 + 真实 `writeTabState(waiting)` 端到端成功 + 相位自动选档三例 + `evaluateWakes` 真派发监管块两例 + **第 10 组跨提交交互**：10(a) `stop=error ∧ result={status:"unconfirmed",autoGenerated:true} ∧ pushesThisEpoch=0` ⇒ `ok:true` + steer 真落盘 + `pushes=1`（夹具先经 `composeTabStatus` 断言 phase=unconfirmed/terminal=false，确保形状真实）、10(b) 对照 `result={status:"completed"}` ⇒ 仍拒 `terminal` 且不落 steer）；`npx tsx extensions/_test_runtime_autonomy.ts` → **66 checks passed**；`npm run test:autonomy-actions` → **87 checks passed**；`npm run test:model-retry` → **8 组**；`npm run test:model-failure-classify` → **3 组**；`npm run test:runtime-wake` → all assertions passed。源码：`extensions/supervision-runtime.ts::{evaluatePushGuards,pushTemplate,supervisePush,registerSupervisionTools,countPushes,clampMaxPushes}`、`extensions/runtime/wake.ts::{buildWakePrompt,deriveSupervisionItems,WakeSupervisionItem}`、`extensions/tab-runs.ts::TabState.currentToolStartedAt` + `extensions/tab-runs-runtime.ts#L96-L107`、接线 `extensions/index.ts#L2543`。**接线变异验证**（69 checks 基线时执行）：将 `buildWakePrompt(ws, letters, supervision)` 变异回两参 ⇒ 监管块断言实红（1 failed / 68 passed），字节级还原后 sha256 一致 ⇒ 断言确实经由真实接线而非直调纯函数。**口径差异的证据链**：`needs-human` 含 `awaitingInput` 时真实端到端成功用例实红（命中预期断言，8 组）⇒ 第一次收窄为 `gate==="awaiting" ∨ attention>0`；随后 `stop="error"` 移出 `needsHuman`、由门 4b（`pushesThisEpoch>=1` 才升 needs-human）单独判定 ⇒ 第二次收窄。`frontier-carriers.ts:313` / `frontier.ts:382` 的 P0 广义 reclaim 判据**零改动**。

- **兜底 unconfirmed 三处契约（2026-10-18 实测，`6dc1821`）**：`npm run test:supervision-push` → **all 71 checks passed**（新增第 10 组 2 条：兜底 unconfirmed 首推放行 + completed 对照）；`npx tsx extensions/_test_tab_report_fallback.ts` → **all 37 checks passed**（新增第 10 组 4 条：`lms-*` / `master-*` 经真实 `agent_settled` 不写 result、普通 taskId 对照仍写、函数级 `skip-persistent-identity` 且未落盘）；`npx tsx extensions/_test_tab_runs_runtime.ts` → passed（新增 `classifyForReclaim(phase:"unconfirmed") === "unconfirmed"`、`launch_failed` 仍归 failed、以及经 `registerTabStatusTools` 真实工具入口的 `details.unconfirmed` 分组 / `summary unconfirmed=N` / 「核实」文案 / 禁词正则 `/重派|rerun|re-run|重启|retry/i` 断言）。源码：`extensions/supervision-runtime.ts:413-414`、`extensions/tab-runs-runtime.ts::{writeSettlementFallback(SettlementFallbackOutcome),classifyForReclaim}`、`extensions/tab-runs.ts::{validateTabResult,composeTabStatus,isUnconfirmedFallback}`、`extensions/runtime/frontier-carriers.ts:203/338`。未闭合：`master-` 前缀为命名约定、`unconfirmed` 桶只解决误导重派（不解决「谁来核实」）、`_test_graph_carriers`/`_test_frontier_attention_window` 在基线即为红（frontier 面未改）。
- **监管账本默认开启（2026-10-18 实测）**：`npx tsx extensions/_test_runtime_supervision_default_on.ts` → **all 26 checks passed**（自动登记两接线点 / `optout` 与 `off` 语义 / `stop=error→BLOCKED_USER` 不限 phase / 重复登记不清 optOut / 用法串含 optout）；`npx tsx extensions/_test_runtime_autonomy.ts` → **all 66 checks passed**（SUP-P0 六态组未回归）；`npm run test:autonomy-actions` → **all 87 checks passed**；`npm run smoke:extension-load` → extension load OK；`npm run test:master-dispatch` → **# pass 16**。源码：`extensions/runtime/supervision.ts::{autoRegisterDispatchedTabs,setSupervisionStatus,setSupervisionOptOut,handleSuperviseCommand}`、`extensions/runtime/autonomy/frontier.ts::deriveTabSupervisionState`、`extensions/runtime/autonomy/collect.ts::readSupervisionInputs`、接线 `extensions/index.ts`（launch-tabs execute + `dispatchTab` 闭包）、`extensions/master-tools.ts#L731`；phase 派生 `extensions/tab-runs.ts#L356-L369`（`error|aborted → unconfirmed`）。

- v1：`extensions/_test_runtime_autonomy.ts` A1–A11 断言（含"测试不触真实 `~/.pi/agent/runtime`"隔离断言）；提交 `3922ef4`；L4 复核 `plans/0923_autonomy_suite_v1_review.md`（PASS，must-fix 0）。
- v2（2026-09-23 实测）：
  - `npx tsx extensions/_test_runtime_autonomy.ts` → **all 56 checks passed**（55 基线 + A10.1b；A10.1 改 allowlist 后绿）。
  - `npx tsx extensions/_test_autonomy_wiring.ts`（新，W1/W1b/W2.1–W2.5/W3/W4.1–W4.4/W5/W6）→ **all 14 checks passed**；W1 默认关闭端到端（显式注入 temp no-key config，不依赖包根现状——R10）、W2 kill 演练两层断言（evaluateWakes 层只断返回值；gate 层 temp agentDir 断 reason：首帧 `record-only`）、W5 五字段行格式 + 消毒 + never-throw、W6 单次完整评估 = frontier 1 + watchdog 1 + `cat=wake` 恰 1（3 行基线）。
  - `npm run smoke:extension-load` → extension load OK；`_test_runtime_wake.ts`/`_test_runtime_master_control.ts`（含 masterStatusLogic 文案 parity）/`_test_local_master.ts`/register-graph 本体全绿。
  - tab 内独立 L4 审查：`plans/0923_autonomy_suite_v2_review.md`（**PASS-WITH-MUST-FIX，must-fix 0**；残余风险 5 条见 Open Questions）。
- 动作面 P1（2026-10-01 实测）：`npx tsx extensions/_test_runtime_autonomy_actions.ts` → **all 63 checks passed**；`npx tsx extensions/_test_runtime_autonomy.ts` → **all 60 checks passed**；`_test_autonomy_wiring.ts` 15 checks（W1c 默认关逐字节同构 + actions 零新文件断言）。源码：`extensions/runtime/autonomy/action/{policy,breaker,ledger,gitguard,run,replay}.ts` + `action/classes/report.ts`；接线 `extensions/runtime/wake.ts#L120`；`/autonomy status` 尾行 `extensions/index.ts#L2754`；config 切片 `extensions/runtime/autonomy/config.ts::normalizeAutonomy`；npm script `package.json::test:autonomy-actions`。
- 动作面阶段二（2026-10-02 实测）：`npm run test:autonomy-actions` → **all 72 checks passed**；`npx tsx extensions/_test_runtime_autonomy.ts` → **all 60 checks passed**；`_test_autonomy_wiring.ts` 12/3（W1c 过，W1b/W2.3/W3 为既有基线失败）；`npm run smoke:extension-load` → extension load OK。真机：注入 allowlist trigger → `state/autonomy/actions/actions.jsonl` 四行账本（attempted/precheck/executed/postverified）+ notify 信件落于目标 scope mailbox spool（status=pending）；`/autonomy status` 尾行 `actions: enabled=on`。源码：`extensions/runtime/autonomy/action/classes/{types,notify}.ts` + `action/registry.ts`；`policy.ts` class allowlist、`run.ts` dedupKey class 段；包根 `config.json`（gitignored）`autonomy.actions.enabled=true`（代码缺省仍 false，一键回退 = 删该子键）。
- 动作面 trigger 映射 + scope owner 门 + 疑似回声标记（2026-10-02 实测；**下列数字均为当时读数**）：`npm run test:autonomy-actions` → **all 87 checks passed**（72 基线 + 15 新增：映射矩阵 / scope-owner 四态 / 回声三态 / ⑤⑧ 防循环 / unknown·n/a fail-closed）；`npx tsx extensions/_test_runtime_autonomy.ts` → **all 60 checks passed**；`_test_autonomy_wiring.ts` 12 过 / 3 既有基线失败（W1b/W2.3/W3，W5/W6 通过）；`npm run smoke:extension-load` → extension load OK。源码：`action/policy.ts::TRIGGER_CLASS_MAP`（当时 4 规则映射，`TRIGGER_ALLOWLIST` 派生 size=4；**现为 5 规则 / size=5，见下条当前读数**）+ L1.5 `notifyScopeOwner` 门、`action/classes/notify.ts::ownerCheck`、`action/classes/types.ts::ActionClass.ownerCheck?`、`action/ledger.ts::{ActionEvent.suspectedEcho, hasRecentNotifyForProject}`、`action/run.ts#L110`（按映射枚举候选）/`#L157`（回声标记）/`#L515`（status `⚠echo`）。预算常量 `BUDGET` 与 `POLICY_VERSION=actions-v1` 零改动；`frontier.ts`/`wake-gate.ts`/`protocol.ts`/audit 写路径零改动。
  - **当前契约读数（2026-10-19 实测，与本节历史读数不同）**：`TRIGGER_CLASS_MAP` 现 **5 规则**（新增 `blocked_overdue` → 仅 `notify-local-master`，`policy.ts#L35-L41`），`TRIGGER_ALLOWLIST` 现 **size=5**（`policy.ts#L44`）；`_test_runtime_autonomy_actions.ts` 现 **97 checks**、`_test_runtime_autonomy.ts` 现 **79 checks**、`_test_runtime_supervision_push.ts` 现 **76 checks**。上段保留其「当时读数」语义（不重写历史）。
  - v2 计划/实现：`plans/0923_autonomy_suite_v2_plan.md`（7 裁定 D-A~D-H + 接线点清单）、`plans/0923_autonomy_suite_v2_impl.md`（逐文件行段 + 偏差 8 条，其中偏差 1 修正了原计划对空盘面二帧 reason 的错误预期：实为 `record-only` 非 `no-meaningful-change`）。
- GUI 落点（2026-09-30）：`gui/src/pages/AutonomyPage.tsx`（AutonomySettings + FrontierViz）、`gui/src/pages/RuntimeOverlay.tsx`（SECTIONS 六值）、`gui/src/store.ts:38`、`gui/src/api/client.ts:147`（`autonomyFrontier`）、`extensions/runtime-host/server.ts:1243-1267`（frontier 路由）；提交 `d321c50`（只读 frontier 端点）、`6ee8191`（覆盖层第 6 section + AutonomySettings 迁出微信页）、`661c8f2`（FrontierViz）、`39e6677`（读失败不留加载态 + Toggle focus 环）。

## Links Out

- [[Wiki 索引]]

## Backlinks

- [[Wiki 索引]]

## Open Questions

- **open 账本无 GC**：`autoRegisterDispatchedTabs` 使账本条目随每次派发增长，`closed/` 只在 `/supervise off` 时产生；无自动关账、无过期清理，长期运行会积累不过问的 open 条目（派生面仍正确——`DONE`/`NOT_MONITORED` 不报——只是文件数单调增长）。
- ~~监管块在生产上还不会出现~~ **已闭合**：workstream 路经 `evaluateWakes → evaluateOne → deriveSupervisionItems` 真派发；scope 路经 `evaluateScopeWake`（claim 后）真派发（见「相关字段与接线」）。
- ~~对已 settled tab，缺省 `steer` 档是无效推动~~ **已闭合**：缺省档按相位自动选（`waiting` ⇒ `abort`），显式传入优先。
- **账本 `epoch.pushes[]` 只增**：`epoch.startedAt` 当前无人重置，读侧重置只在 `countPushes` 内部生效 ⇒ 账本体积单调增长；且 frontier `epochPushes`（全量）与 `push` 判定用的 `pushesThisEpoch`（读侧重置后）口径不同，未合并。
- **两侧 `needs-human` 口径差是刻意的**（frontier 广义 reclaim vs `supervise-push` 收窄），未统一；统一时应收窄 frontier 侧而非放宽推动侧。
- **三条派发路径尚未接自动登记**：`/launch` 直开 tab、`local-master-ensure` spawn、trace-fusion lane tab —— 这些 tab 仍落在旧默认（无账本 ⇒ `NOT_MONITORED`）。

- **OQ-1（notify 间接 wake）**：notify 信件是 wake 形态、可被 legacy scope wake 链认领（间接 spawn 风险）；其是否构成「autonomy 搭 legacy spawn 通道派自己的活」（设计 §1.4 结构性防火墙）未完全闭合。既有缓解 = `subject` 恒 `autonomy-notify/<rule>`（不以 `run://tab/` 开头）+ 只 deliver 不消费 + 效应面 = 恰一信件文件。**已补两项缓解**：① **效应 C 缓解已落地**——发信前查 scope owner 的 L1.5 门（无主 `scope-ownerless` / 死主 `scope-owner-stale` 拒投，liveness 判不了则放行），掐断「信滞留 pending → backlog 计数 → level 恒触发 → gate 稳态翻转」的产生条件；② **短环 B 可见化**——同 project 1h 内 notify 后再有动作 ⇒ 事件行 `suspectedEcho:true` + status `⚠echo`（只标记不改判定）。**仍开放：通道 D**——被信件唤醒的**下游 spawn 不在动作事务承诺面**（事务只管自身效应与回退，信被认领后派生的会话不归本事务管辖），其是否构成派活防火墙破口未闭合。
- ~~**audit 轮转仍无**（R5）~~ **已闭合（2026-10-29 `0cfbd59`）**：`rotateAuditIfNeeded` 在 `AUDIT_ROTATE_BYTES = 8 MB` 阈值触发 rename 归档（`audit-<stamp>.jsonl`，只归档不删除、失败 never-throw），`readAuditTail` 同步改为尾部定长窗口读（29.4 MB 文件 123ms → 0.39ms）。**真机证据**：`state/autonomy/` 现存 `audit-20261030T000837Z.jsonl`（32.5 MB，末行 `ts=2026-10-30T00:05:21Z`）与新生 `audit.jsonl`（从 0 起增长，末行 `ts=2026-10-30T03:59:33Z`）并存 —— 轮转确已在生产路径发生。**残留（未闭合）**：存量归档文件无 GC（只增不减，需人工/后续排期）；本次修复**未**清理修复前已有的 29.4 MB 存量文件（已由本次轮转自然归档）。
- **watchdog 数据源缺口仍挂**：三项恒 `unknown` 的判据无数据源（与 `global-view` 卫生行缺口同源）；v2 状态面不展示 watchdog（D-D）。
- **envelope.priority 队列仍 pending**（L1-B 未决 3，独立接线面）。
- `no-meaningful-change` 分支在 collect 生产路径休眠（recordOnly 恒非空，frontier.ts:281）；`maintainBatchAnchor` 的"全空 diff 重置"分支同源休眠（W4.4 单测覆盖）。
- frontier 不消费 ws-mail 到信（R4，见"接线落点与边界"）；debounce 2s / cooldown 15s 在 30s tick 下近似 inert（R6；事件驱动/缩短 interval 后续）。
- ~~审计 `concl` 参数当前为普通 `string`，依赖内部调用者传固定常量（L4 残余风险 5：可收窄为字面量联合类型或消毒强化契约）~~ **已解决**：`appendAuditEvent` 的 `concl` 已收窄为 7 值字面量联合 `AuditConcl`（`engage|clear|wake|no-wake|pass|enable|disable`，`collect.ts::AuditConcl`），全仓调用点与发射值不变，W5 冻结行格式正则不受影响。
