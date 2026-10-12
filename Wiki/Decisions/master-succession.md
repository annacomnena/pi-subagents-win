---
title: Master 交接继任者形态
kind: decision
status: current
updated: 2026-10-12
source_paths:
  - extensions/index.ts#L2523-L2566
  - extensions/tab-launch-core.ts#L255-L352
  - extensions/tab-launch-core.ts#L402-L417
  - extensions/runtime/master-transfer.ts#L22-L60
  - extensions/runtime/master-transfer.ts#L120-L190
  - extensions/runtime/master-transfer.ts#L305-L355
  - extensions/runtime/master-transfer.ts#L400-L410
  - extensions/runtime/registry.ts#L440-L490
  - extensions/capabilities.ts#L54-L61
  - extensions/capabilities.ts#L125-L141
  - extensions/identity.ts#L95-L97
  - extensions/gui-autostart.ts#L350
  - plans/20261012_bc_fix_plan.md
  - plans/20261012_bc_fix_impl.md
  - plans/20261012_bc_fix_n3fix.md
  - plans/20261012_bc_fix_delta_review.md
---

# Master 交接继任者形态

## Summary

决策（2026-10-12，C）：`/master-transfer`、`master-transfer` 工具与 S3 自动交接的**继任者会话**从「标签页派发」改为**非标签页常驻会话**。动机是身份决定能力：`isMainSession()` 决定能力档与多项自启/追赶行为，而标签页继任者被判 `workflow-tab`（`lite/launchTabs/timerOrchestration/directExecution` 全 false）且不触发 GUI 自启等——与「继任 master」职责冲突。改后 `successorRunId` 由 tab runId 变为不透明关联 id，继任者退出 tab-runs 账本。**失败路径**同步重做：异步 spawn 失败必须收尾 record + 清 transfer 窗口 + 必发失败事件，审计归属随交接主体（global/local）。

## Current Contract

### spawn 形状（唯一通道）

继任者 spawn 通道唯一 = `extensions/index.ts#L2531::spawnSuccessor`（slash `#L2285`、工具 `#L2632`、S3 自动交接经 `registerSessionHooks` `#L2570` 共用）。改后行为：

- **不**生成 tab runId、**不**写 tab-runs 派发账本（`writeTabDispatch`）、**不** `recordLink(kind:"tab")`、**不**发 `tabDispatchToRuntimeEvent`。
- `spawnPiTab({ …, title: sanitizeWtTitle(title), clearTabIdentity: true, onSpawnError })`（`extensions/index.ts#L2543-L2544`；标题过 `sanitizeWtTitle` 是零成本防御——`reason` 可能含 `%`/`;`/换行并进 `--title`）。
- 返回 `{ successorRunId: succ_<transferId> }`（`#L2565`，不透明关联 id，不再是 tab runId）。
- 投递交接提示不变：`wtPromptArg` 对含换行/分号的 prompt 物化 `@file` 随机 key；`buildSuccessorPrompt` 不依赖任何 tab 身份。

### `clearTabIdentity` 与继承坑（must-fix）

| 项 | 事实 | 出处 |
|---|---|---|
| 选项 | `TabLaunchOptions.clearTabIdentity?: boolean` | `extensions/tab-launch-core.ts#L288` |
| 纯函数 | `buildTabSpawnEnv(baseEnv, opts)` | `extensions/tab-launch-core.ts#L332` |
| 清理名单 | 8 个身份键：`PI_TAB_RUN_ID / PI_TAB_RUNS_DIR / PI_SESSION_PROFILE / PI_TRACE_RUN_ID / PI_TRACE_LANE / PI_SESSION_ID / PI_SESSION_FILE / PI_SUBAGENT` | `#L303-L312` |
| 语义 | 有 `tabRunId` → 注入本次派发身份；无 `tabRunId` 且 `clearTabIdentity` → 返回 baseEnv 副本并 **delete** 身份键（**显式传 env**，覆盖 Node spawn「`undefined` = 继承父 env」默认）；其余 → `undefined`（历史行为不变） | `#L335-L349` |

**关键隐藏坑**：`tabRunId` 缺省时旧代码传 `env: undefined` → Node 用父进程 `process.env`。若旧 master 本身是标签页，其 `PI_TAB_RUN_ID` 会被继任者**继承** → 继任者 `getTabRunId()` 非空 → `isMainSession()===false` → C 的目标（心跳自写 / GUI 自启 / 能力档 main）全部落空。故必须清空身份 env（对齐 `scripts/boot-resume-master.ps1` 的身份清理清单；**故意不清** `PI_PROVIDER/PI_MODEL/PI_REASONING_LEVEL` 等运行环境配置）。

### 为何必须非标签页

- `extensions/identity.ts#L95::isMainSession()` = `!getTabRunId() && !isSubagent()`。
- `extensions/capabilities.ts#L125::currentProfile()`：flag/env profile 优先 → `isSubagent()` → `"subagent"`；`isTabSession()` → `"workflow-tab"`；否则 `"main"`。
- `CAPS`（`extensions/capabilities.ts#L44-L80`）：`workflow-tab` 的 `lite=false / launchTabs=false / timerOrchestration=false / directExecution=false`；`main` 全 true。
- 其它以 `isMainSession()` 为门的行为：GUI 自启（`extensions/gui-autostart.ts#L350`）、hotspot 采集（`extensions/hotspot/index.ts#L71`）、async-result-watcher（`extensions/async-result-watcher.ts#L335`）、event-bus legacy 回退（`extensions/event-bus.ts#L107`）。标签页继任者会在这些路径上失效。

### 失败路径（异步 spawn 失败 = 原账本落点已消失）

取消 tab-runs 账本后，**同步** preflight 失败仍走 `throw` → `transferMaster` catch 落 `record.status="failed"` + `clearTransferWindow(master)`（`extensions/runtime/master-transfer.ts#L320-L329`）。**异步** `child.on("error")` 的落点改为 `failTransferPostSpawn`（`extensions/runtime/master-transfer.ts#L165`，由 `index.ts#L2553` 调用）：

1. **record**：仅 `spawned → failed`（不覆盖已 `completed/failed` 的终态），读/写失败不阻断；
2. **窗口**：仅当窗口 `transferId` == 本次 `transferId` 时才清（窗口是 **agent 级单槽**，防清掉期间新发起的交接窗口）；
3. **事件**：`emitPostSpawnFailureEvent`（`#L133`）**必发**（在 try/catch 之外），dedupe 键 `master.handoff.failed:<transferId>:post-spawn`（独立于 `transferMaster` catch 的正典 `master.handoff.failed:<transferId>`，避免 launcher-unhealthy 路径双发被去重吞掉）。

三步 never-throw（①②各自 try/catch；③在外）⇒ 清理失败绝不吞失败事件。**审计归属随交接主体**：`agent ?? masterAddress()`（`#L133`/`#L165`），local 交接过 local 地址、global/未传回退 global（M1 fix；`SpawnSuccessor` 入参增 `agent?`，`transferMaster` 传 `agent: master`，`#L314`）。

**不削弱防 zombie-reclaim 语义**：`child.on("error")` 在 Node 中只表示**进程未能 spawn**（ENOENT/EACCES…），「启动后立即退出」是 `'exit'` 而非 `'error'` ⇒ 触发本次清理时继任者**永不诞生、永不到达**，窗口不再有需保护的正当继任者；旧主若仍活着，其心跳新鲜度独立使 `forceStale` 拒绝抢代（与窗口无关）。

### transfer 窗口（TTL 24h）

窗口由 `transferMaster` 在 **spawn 成功返回后**落（`extensions/runtime/master-transfer.ts#L337`，`record.status="spawned"` 之后）；成功路径由后继 `master-attach` → `confirmTransferAttach` 清（`#L405`）。窗口文件在 `registry/transfer-window/`，TTL `24h`（`extensions/runtime/registry.ts#L450`）；`isTransferInFlight`（`#L485`）在窗口内抑制 `forceStale` attach 与 stale `takeoverMaster`（`#L217`/`#L404`），仅 human cancel 越过。**可用性后果**：窗口残留会让 `boot-resume-master.ps1` P2 `skip: transfer-in-flight`（master 不恢复，远程输入离线）——这正是异步失败必须清窗的原因（见 [[Master 开机自启与防双开]]）。

### 与 boot-resume 后继形态对照

| 维度 | `boot-resume-master.ps1` spawn | C 之后 `spawnSuccessor` | 一致 |
|---|---|---|---|
| `--tab-run-id` | 不带 | 不带 | ✅ |
| 身份 env | 全清（`Get-BootEnvScrubKeys`） | `clearTabIdentity` 清 8 键 | ✅ |
| `--session <file>` | **带**（resume 同 sid） | **不带**（继任者是新 sid） | ❌ 有意不同 |
| prompt | 不带 | 带交接提示 | ❌ 有意不同 |
| cwd | home | home | ✅ |
| `isMainSession()` | true | true | ✅ C 的核心目标 |

## Evidence

- spawn 通道与形态：`extensions/index.ts#L2523-L2566`；`extensions/tab-launch-core.ts#L281-L352`（选项 + `buildTabSpawnEnv`）、`#L402-L417`（`spawnPiTab` env/`child.on("error")`）。
- 身份与能力档：`extensions/identity.ts#L95-L97`、`extensions/capabilities.ts#L44-L80`、`#L125-L141`；消费 `isMainSession()` 的路径见 `gui-autostart.ts#L350`、`hotspot/index.ts#L71`、`async-result-watcher.ts#L335`、`event-bus.ts#L107`。
- 失败路径：`extensions/runtime/master-transfer.ts#L133-L186`（事件 + 三步收尾）、`#L305-L355`（`agent` 透传 / spawned 落库 / spawn 窗口）、`#L400-L410`（confirm 清窗）；`extensions/runtime/registry.ts#L440-L490`（TTL / `isTransferInFlight`）。
- 计划与报告：`plans/20261012_bc_fix_plan.md` §3（C 设计与隐藏坑）、`plans/20261012_bc_fix_impl.md`（落地）、`plans/20261012_bc_fix_n3fix.md`（#3 收尾）、`plans/20261012_bc_fix_delta_review.md`（**PASS，must-fix 0**）。
- 单测：`npm run test:runtime-master-transfer`（`# pass 20`，含 ok13–20）、`npm run test:launch` 新增 `buildTabSpawnEnv` 断言、`npm run test:timers-runtime`（T-B1..T-B4）。
- 校准状态：本 C 改动为**工作区未提交**（基线提交 `e12954f`），已过双重独立复核（L4 + delta）。
- `local-master-ensure` 的 **可见 tab** 通道（`extensions/index.ts` 的 `ensureLocalMasterTab`）是**另一条**通道，本决策**不改**（见 [[Local Master Ensure（幂等确保）]]）。

## Links Out

- [[Master 在线判据与远程输入门]]
- [[Master 开机自启与防双开]]
- [[Local Master Ensure（幂等确保）]]
- [[Local Master 认领与接管]]
- [[GUI 解锁 Master]]
- [[Wiki 索引]]

## Backlinks

- [[Master 在线判据与远程输入门]]
- [[Master 开机自启与防双开]]
- [[Local Master Ensure（幂等确保）]]
- [[GUI 解锁 Master]]
- [[Wiki 索引]]

## Open Questions

- **二次交接重复 spawn**：`transferMaster` 未加「已有 in-flight 窗口即拒绝二次 spawn」的防护（计划标「建议，非必须」）；缓解靠既有交接窗口抑制 + 用户不重复调用。
- `failTransferPostSpawn` 的 record 清理固定用默认 `stateDir`（生产路径全为默认，无影响；若未来传自定义 `stateDir` 会静默 no-op，失败事件仍必发）。
- `extensions/tab-launch-core.ts#L413` 的注释「异步 error（如 wt.exe 立即退出）」不准确——「立即退出」是 `'exit'`；该不变量正是本次失败语义安全性的前提，宜校正注释以固化认知。
