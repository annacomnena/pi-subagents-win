---
title: 主动性套件（Autonomy Suite）
kind: concept
status: current
updated: 2026-09-23
source_paths:
  - extensions/runtime/autonomy/config.ts
  - extensions/runtime/autonomy/kill-switch.ts
  - extensions/runtime/autonomy/frontier.ts
  - extensions/runtime/autonomy/wake-gate.ts
  - extensions/runtime/autonomy/watchdog.ts
  - extensions/runtime/autonomy/collect.ts
  - extensions/runtime/autonomy/gate.ts
  - extensions/runtime/wake.ts
  - extensions/master-tools.ts
  - extensions/index.ts
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
- **frontier**（`frontier.ts`，**纯零 IO**）：C5 相位→项目状态映射固化、规格 §25 九规则的 v1 子集、`meaningful_state_version`、`RECORD_ONLY_NOCARRIER`（**每帧无条件输出 ④⑥⑧ 三条 no-carrier 常量**，`frontier.ts:281`——生产路径 `diff.recordOnly` 恒非空）。
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
- **唤醒总门落点**（`wake.ts:evaluateWakes`）：owner 门（L93）之后、ws 遍历之前，+1 import +3 行：`evaluateAutonomyWakeGate({ stateDir, configPath: opts.autonomyConfigPath, now })`，`engaged && !proceed` → `return []`（claim 前短路，`evaluateOne`/`claimLetters` 零改动）。`WakeOptions` + test-only `autonomyConfigPath`（仿 `now`/`inFlightWindowMs` 先例；生产不传）。**`mailbox-consumer.ts`/`registry.ts`/`scope.ts`/dispatch 侧零改动**（消费点经 `evaluateWakes` 自动带门）。
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

## 接线落点与边界（v2 已接线形态）

- **总门**：`wake.ts:evaluateWakes` 顶层（套件级门，不是 ws 级；cutover off / non-owner 提前返回不触本层——省 IO）。per-repo scope wake（`scope.ts`/`mailbox-consumer.ts` 平行接线面）**未接**，列后续。
- **可见性**：master-status 条件增量行 + `/autonomy status` 全字段回显（gating 三元组、frontier meta、wake-gate 最近判定、audit 尾 5 行）。watchdog **不展示**（3/8 恒 unknown，数据源缺口未补，D-D）。
- **审计**：`state/autonomy/audit.jsonl`，两类格式共存（v1 无 ts 前缀诊断行 + v2 `ts=…` 五字段行）。per-reason 进程内去重仅用于 `cat=gating`（kill 压制行内容恒定、gate-error 防 30s tick 刷屏）；`cat=wake` **每次判定落一行**（含 no-wake）；`cat=kill` 来自 `/autonomy kill/clear`。
- **enabled 模式预期语义（R4）**：frontier 不消费 ws-mail 到信（`backlog` 只透传）→ ws-mail 到信不构成 frontier 触发 → 启用后 wake-gate 常态 no-wake（`record-only`）会压制本会 fire 的 legacy ws 唤醒；恢复 legacy 的正道 = **移除 config.json 的 autonomy 键**（kill 是压制而非恢复；clear 后需 frontier 出现真触发才放行）。
- **回滚**：v1 等式（删 `autonomy/**` + 测试两路径）已失效；v2 回滚 = `git revert <v2-wiring-commit>`（单 commit 纪律）。回滚后 `state/autonomy/` 数据成为惰性缓存/日志；kill engaged 时 legacy 唤醒不受影响（D-E），语义自洽。

## Evidence

- v1：`extensions/_test_runtime_autonomy.ts` A1–A11 断言（含"测试不触真实 `~/.pi/agent/runtime`"隔离断言）；提交 `3922ef4`；L4 复核 `plans/0923_autonomy_suite_v1_review.md`（PASS，must-fix 0）。
- v2（2026-09-23 实测）：
  - `npx tsx extensions/_test_runtime_autonomy.ts` → **all 56 checks passed**（55 基线 + A10.1b；A10.1 改 allowlist 后绿）。
  - `npx tsx extensions/_test_autonomy_wiring.ts`（新，W1/W1b/W2.1–W2.5/W3/W4.1–W4.4/W5/W6）→ **all 14 checks passed**；W1 默认关闭端到端（显式注入 temp no-key config，不依赖包根现状——R10）、W2 kill 演练两层断言（evaluateWakes 层只断返回值；gate 层 temp agentDir 断 reason：首帧 `record-only`）、W5 五字段行格式 + 消毒 + never-throw、W6 单次完整评估 = frontier 1 + watchdog 1 + `cat=wake` 恰 1（3 行基线）。
  - `npm run smoke:extension-load` → extension load OK；`_test_runtime_wake.ts`/`_test_runtime_master_control.ts`（含 masterStatusLogic 文案 parity）/`_test_local_master.ts`/register-graph 本体全绿。
  - tab 内独立 L4 审查：`plans/0923_autonomy_suite_v2_review.md`（**PASS-WITH-MUST-FIX，must-fix 0**；残余风险 5 条见 Open Questions）。
  - v2 计划/实现：`plans/0923_autonomy_suite_v2_plan.md`（7 裁定 D-A~D-H + 接线点清单）、`plans/0923_autonomy_suite_v2_impl.md`（逐文件行段 + 偏差 8 条，其中偏差 1 修正了原计划对空盘面二帧 reason 的错误预期：实为 `record-only` 非 `no-meaningful-change`）。

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
- 审计 `concl` 参数当前为普通 `string`，依赖内部调用者传固定常量（L4 残余风险 5：可收窄为字面量联合类型或消毒强化契约）。
