# G1-1 端到端论证：关掉定时器后，一个停了 8 小时的 tab 会不会被系统自己推

- 实现报告：`plans/20261018_group1_impl.md`
- 实现规格：`plans/20261018_group1_impl_spec.md`
- 独立审查依据：`plans/20261018_glm_review_autonomy.md`（C/E 两节）
- 基线：`6dc1821`
- 本文所有 `file:line` 均为**本次改动落地后**（工作树）的实际行号，均已用 `grep -n` 复核

> **先给结论（逐字回答任务书 §D 的问题）**
>
> **关掉 30 分钟定时器、一个 tab 停了 8 小时（`stop=error`，落 `unconfirmed` 兜底）——系统会不会自己推它？**
>
> **检测：会。提醒：会（本任务接通）。推动：不会（仍差最后一步）。**
>
> 分环节：
> - ① tick 检测到「这个 tab 是 `BLOCKED_USER` 且已超龄 > 30min」→ **会**（`blocked_overdue` 触发，本任务新增）
> - ② 触发变成一封投到该仓 scope master 信箱的信 → **会**（`notify-local-master`，本任务开启 `actions`）
> - ③ 该仓 local master 被拉起来，且它拿到的 prompt 里**带**这个 tab 的 runId + `supervise-push` 指令 → **会**（本任务给 scope wake prompt 加监管块）
> - ④ 被拉起的执行者真的调 `supervise-push` 并推动成功 → **不会**（`supervision-runtime.ts:600` 的标签页身份门会拒绝它；见 §4 断点 #4）
>
> 也就是说：**这只 tab 不会再"8 小时无人知晓"，但"自动推动"仍差一步。**`supervise-push` 目前**只有人**（主会话 TUI）能调。

---

## 0. 全链一览（四个环节 + 每个环节的门）

```
[主会话 pi 进程 ~30s tick]
  mailbox-consumer.ts:599  interval(tick)
    └─ ① mailbox-consumer.ts:609  writeAutonomyHeartbeat（无条件存活信号）
    └─ mailbox-consumer.ts:614  evaluateWakes(...)
         ├─ wake.ts:104-106        cutover 门 + 全局 master owner 门
         ├─ wake.ts:110            evaluateAutonomyWakeGate  ← autonomy.enabled 门
         │    └─ gate.ts:63-115     kill/gating → collectAutonomyInputs → evaluateWakeGate → 审计
         │         └─ collect.ts:146  collectAutonomyInputs
         │              ├─ collect.ts:156 collectGlobalView（tab 快照）
         │              ├─ collect.ts:173 readSupervisionInputs（监管账本，只读）
         │              └─ collect.ts:175 buildFrontier   ← ③ blocked_overdue 在这里产生
         ├─ wake.ts:120            runAutonomyActions     ← 动作面（① config.actions 门在这里）
         └─ wake.ts:127-130        for ws of listWorkstreams → evaluateOne（workstream 路；本任务未改其语义）

[动作面：触发 → 信]
  run.ts:91    cfg.enabled !== true || cfg.actions?.enabled !== true → return   ← 断点 ①（已开）
  run.ts:103   candidateTriggers = snap.triggers ∩ TRIGGER_ALLOWLIST
  run.ts:109   classesForRule = TRIGGER_CLASS_MAP[rule]  ← policy.ts:36-42
  run.ts:111   runOneAction → decide(policy) → cls.effect()
    └─ classes/notify.ts:121-142  buildContent（subject=autonomy-notify/<rule>, kind=REPORT）
    └─ classes/notify.ts:183-     effect → deliverLetter → mailboxDirFor(scope master)/msg_*.json

[scope 路：信 → 执行者]
  mailbox-consumer.ts:786  interval(tick) → evaluateScopeWake
    ├─ scope.ts:365  cutover 门
    ├─ scope.ts:366-369  scope owner 门
    ├─ scope.ts:373-375  in-flight 门
    ├─ scope.ts:378-383  listScopeWakeLetters（S7 谓词：REPORT 形态但非 run://tab/ ⇒ 是 wake 类）
    ├─ scope.ts:387  claimLetters
    ├─ scope.ts:401  deriveSupervisionItems（本任务新增：带 repoPath 过滤）← 断点 ②（已接）
    └─ scope.ts:411  buildScopeWakePrompt(..., supervision)  ← 监管块进 prompt
  mailbox-consumer.ts:805  wiring.spawn(fired, sid)
    └─ index.ts:2661-2668  spawnOneShotTab({prompt: decision.prompt, cwd: decision.repoCwd})
         └─ index.ts:2625-2628 spawnPiTab({tabRunId: runId, ...})
              └─ tab-launch-core.ts:375-384  PI_TAB_RUN_ID=runId → 新 tab 进程

[新 tab 进程：执行者]
  identity.ts:89-91      isSubagent() → false（PI_SUBAGENT 不是 1）
  identity.ts:94-96      isMainSession() → false（因为有 PI_TAB_RUN_ID）
  index.ts:3267-3271     注释即证："标签页老 master 的 PI_TAB_RUN_ID 会被子进程继承，后继仍被判为 tab"
  调 supervise-push
    └─ supervision-runtime.ts:599  isSubagent() → 否
    └─ supervision-runtime.ts:600  getTabRunId() → 真 ⇒ 拒绝  ← ⚠️ 断点 #4（未闭合）
```

---

## 1. 步骤 1：tick 检测（`blocked_overdue` 怎么被算出来）

### 1.1 心跳（存活信号，独立于一切开关）

`extensions/mailbox-consumer.ts:609`
```ts
writeAutonomyHeartbeat({ stateDir: opts.stateDir, sessionId: sid, tickIntervalMs: opts.intervalMs ?? 30_000 });
```
位置在 `evaluateWakes` **之前**、`try/catch` 内 ⇒ 即使随后被 autonomy 门旁路，心跳照样写（AGENTS R-2.1 要求）。

### 1.2 唤醒评估入口

`extensions/mailbox-consumer.ts:614` → `extensions/runtime/wake.ts:104`
- `wake.ts:105` `readCutover()` 未开启 ⇒ 返回 `[]`（零动作）
- `wake.ts:106-107` 全局 master attachment 不是本会话 ⇒ 返回 `[]`
- `wake.ts:110` `evaluateAutonomyWakeGate({stateDir, configPath, now})` ⇒ **`autonomy.enabled` 门在这里**

### 1.3 autonomy 门 → 采集 → frontier

`extensions/runtime/autonomy/gate.ts:73`
```ts
if (cfg.enabled !== true) return { engaged: false, proceed: true, reason: "autonomy-disabled" };
```
- `gate.ts:76` kill switch 读；`gate.ts:77-85` gating（kill > enabled）不 active ⇒ **`proceed:false`** ⇒ 本 tick 不采集、不产触发（fail-closed 压制）
- `gate.ts:88` `collectAutonomyInputs(...)`

`extensions/runtime/autonomy/collect.ts:146-181`
- `collect.ts:156` frontier 源：`collectGlobalView(...)` 或 `graphFrontierSnapshot(...)`（由 `PI_AUTONOMY_FRONTIER_SOURCE` 决定）
- `collect.ts:173` `readSupervisionInputs({stateDir})` ⇒ 监管账本 open 集（**只读**）
- `collect.ts:175-179` `buildFrontier({snapshot, backlog, prev, now, supervision})`
- `collect.ts:180` `writeFrontierSnapshot(next, {stateDir})` ⇒ 落 `state/autonomy/frontier.json`（派生缓存 C4）
- `collect.ts:181-184` 审计行 `frontier baseline=… triggers=…`

### 1.4 `blocked_overdue` 的判据（本任务新增）

**a) tab 级派生（六态机，未改）** — `extensions/runtime/autonomy/frontier.ts:413-431`（`deriveTabSupervisionState` 调用在 `:415`）

对 `stop=error` 的 tab：`frontier.ts:357`（`if (tab.stop === "error") return "BLOCKED_USER";`）。
> 注意：这条在 `phase === "unconfirmed"`（兜底结果）时**更早**命中 —— `frontier.ts:349` `if (tab.phase === "unconfirmed" && tab.stop !== "aborted") return "BLOCKED_USER";`。SBS-B1 形状（`stop=error` + 兜底 `unconfirmed`）走的是 `:349`，结果同为 `BLOCKED_USER`。

**b) 项目级累计（本任务新增；2026-10-18 返工 R1 改为收集全部命中）** — `extensions/runtime/autonomy/frontier.ts:421-448`
```ts
const odHits: Array<{ runId: string; idleMs: number }> = [];   // :423（返工 R1：不再只记最重一个）
for (const t of tabs) {                           // :424  ← 既有循环，与六态派同一处
    const st = deriveTabSupervisionState(...);    // :426  ← 复用派生结果，不重写判据
    const userMs = typeof ledger?.userMs === "number" && ... > 0 ? ledger.userMs : SUPERVISION_THRESHOLDS.userMs;  // :431-435
    if (st === "BLOCKED_USER" && typeof t.idleMs === "number" && Number.isFinite(t.idleMs) && t.idleMs > userMs) {  // :435
        odHits.push({ runId: t.runId, idleMs: t.idleMs });  // :436
    }
}
odHits.sort((a, b) => b.idleMs - a.idleMs || a.runId.localeCompare(b.runId));  // :445（idle 降序 + runId 升序幂等）
const blockedOverdue = odHits.length > 0;                  // :446
const blockedOverdueRunId = odHits[0]?.runId;              // :447（本帧默认候选：最重）
const blockedOverdueRunIds = odHits.length > 0 ? odHits.map((h) => h.runId) : undefined;  // :448（全部超龄 runId）
```
阈值 `SUPERVISION_THRESHOLDS.userMs = 30 * 60_000`（`frontier.ts:89`）。

**c) 触发发射（level + **per-runId** 1h 节流）** — `extensions/runtime/autonomy/frontier.ts:599-646`
> 返工 R1：旧形状是 `prevSameRun`（只在 prev.runId === cur.runId 时读 lastAt）⇒ 最重者交替时两条 runId 的节流记录互相覆盖，同一 runId 可在窗内重发。现改为遍历 `blockedOverdueRunIds`，每个 runId 各自查自己的账本时刻。
> **返工 R3（2026-10-18 晚）**：节流来源改为**快照顶层的权威账本** `prev.blockedOverdueThrottle[projectKey]`，不再读 `pv.blockedOverdueLastAt`（后者降级为**投影**：项目整帧从 `details` 消失时它不存在，读它会把该项目所有 runId 当作「从未提醒」而窗内重发）。
```ts
const blockedOverdueEmitted = new Map<string, string>();                                    // :546（project → 本帧发射的 runId）
const prevThrottleAll = prev?.blockedOverdueThrottle && typeof prev.blockedOverdueThrottle === "object" ? prev.blockedOverdueThrottle : {};  // :549-550（权威账本）
if (cur.blockedOverdue && cur.blockedOverdueRunIds && cur.blockedOverdueRunIds.length > 0) {  // :623
    const prevProjLedger = prevThrottleAll[key];                                            // :626（顶层账本按项目取；**不读** pv.blockedOverdueLastAt）
    const prevLedger = prevProjLedger && typeof prevProjLedger === "object" ? prevProjLedger : {};  // :627
    for (const rid of cur.blockedOverdueRunIds) {                                           // :628
        const last = prevLedger[rid];                                                       // :629
        if (typeof last === "number" && Number.isFinite(last) && now - last < BLOCKED_OVERDUE_THROTTLE_MS) continue;  // :630（该 runId 窗内）
        triggers.push({ rule: "blocked_overdue", project: key, runId: rid, ... });          // :635-641
        blockedOverdueEmitted.set(key, rid);                                                // :642
        break;  // 每项目每帧最多 1 条（:643）
    }
}
```
- `BLOCKED_OVERDUE_THROTTLE_MS = 3_600_000`（`frontier.ts:100`）
- **权威账本落盘**：`next.blockedOverdueThrottle`（`frontier.ts:663-684` 构建、`:713` 写入快照）——
  继承 prev **全部项目（含本帧未出现的项目）**（`:671` 遍历 `prevThrottleAll`，**不按可见性过滤**），
  只按 1h 时间窗裁剪（`:675`：`now - ts >= BLOCKED_OVERDUE_THROTTLE_MS` 才出账）；本帧发射的 runId 记 `now`（`:681-683`）。
  裁剪语义来自返工 R2（**不按「本帧是否仍超龄」裁剪**，否则 tab 短暂活动会剔除键 ⇒ 窗内重发）；
  跨项目可见性存活来自返工 R3（否则项目整帧消失 ⇒ 账本整块丢失 ⇒ 重现后窗内重发）。
- **项目字段是投影**：`ProjectFrontier.blockedOverdueLastAt`（`frontier.ts:698-702`）= `nextThrottle[key]` 的投影，
  仅供展示/图投影/测试；**不作为发射判定来源**。
- **基线帧压制**：整段在 `if (!baseline) {`（`frontier.ts:537`）之内 ⇒ 冷启动/快照丢失不会风暴
- **测试证据**：`:1436`（**SUP-B11**，项目整帧 `details=[]` 后重现不得窗内重发，6 帧 + 1 补充帧）、
  `:1493`（**SUP-B12**，伪随机 60 帧属性不变式：同一 runId 任意两次发射间隔 ≥ 1h）

### 1.5 8 小时的具体读数（按代码推理，非真机演练）

一个 `stop=error` + 兜底 `unconfirmed` 的 tab，`idleMs = 8 * 3600_000 = 28_800_000`：
- `:349` 命中 ⇒ `BLOCKED_USER`
- `28_800_000 > 1_800_000` ⇒ `blockedOverdue = true`，`blockedOverdueRunIds = [tab.id]`（单 tab 时与 `blockedOverdueRunId` 同值）
- 首帧（账本里该 runId 无记录）⇒ **立刻发一次** `blocked_overdue`
- 之后每 **1 小时**（`now - ledger[runId] >= 3_600_000`）再发一次 ⇒ 8 小时内约 8 次提醒，且每次都带同一个 runId
- **多 tab 情形（返工 R1）**：同项目内 A/B 两个超龄 tab 交替成为「最重」时，**各自独立**计 1h 窗（权威账本 `blockedOverdueThrottle[project] = { A: tA, B: tB }`）⇒ 任一 runId 不得在窗内被重复提醒。账本**按 1h 时间窗裁剪**（返工 R2）⇒ tab 短暂活动（idle 掉回阈值下）不会把它的键剔除；账本**挂在快照顶层**（返工 R3）⇒ 项目整帧从 `details` 消失也不会丢失。**测试证据**：`extensions/_test_runtime_autonomy.ts:1265`（SUP-B8，6 帧交替最重序列；帧 5 = 修复前的窗内重发红点）、`:1309`（SUP-B9a，4 帧：窗内不因暂离超龄集合而丢节流）、`:1349`（SUP-B9b，窗过期才出账/上界）、`:1371`（SUP-B10，单 tab 短暂活动 5 帧）、**`:1436`（SUP-B11，项目整帧消失 6 帧 + 1 补充帧；帧 2 `details=[]` 时顶层账本必须保留）、` :1493`（SUP-B12，伪随机 60 帧属性不变式）**
> **R3 的缓解事实（不得当成「没问题」）**：frontier 层若因 `frontier.json` 被删而丢账，仍会重出一遍 trigger，但 actions 层还有一道 1h 去重
>（`breaker.ts::dedupHit`，key = `rule:class:project`）⇒ 同一项目 1h 内的第二次 `notify-local-master` 会被 `SKIP(cooldown)`，**不会真发第二封信**；
> 代价只是**多一次无效唤醒**（wake-gate 可能多叫一次 master）。

**这一步的测试证据**：`extensions/_test_runtime_autonomy.ts:1111`（SUP-B1，31min 边界）、`:1131`（SUP-B3，t0/t0+5min/t0+61min 三帧节流；账本为 `{runId: ts}` 映射）、`:1151`（SUP-B4，`BLOCKED_USER` 不越界成 `stagnation`）。

---

## 2. 步骤 2：动作面（触发 → 一封真信）

### 2.1 调用点

`extensions/runtime/wake.ts:120`
```ts
runAutonomyActions({ stateDir, configPath: opts.autonomyConfigPath, sessionId: opts.sessionId, now });
```
位置：`autonomyGate` 判定之后（`wake.ts:110`）、ws 遍历之前（`wake.ts:127`）。**不在 scope 路**——这是有意的：动作面是「触发 → 信」的唯一桥，信投到 scope mailbox 后由 scope tick 消费。

### 2.2 双层合取（断点 ①）

`extensions/runtime/autonomy/action/run.ts:90-91`
```ts
const cfg = readAutonomyConfig({ configPath: opts.configPath });
if (cfg.enabled !== true || cfg.actions?.enabled !== true) return;   // 双层合取；任一未严格开启即零行为
```
- 生产 `config.json` 现为 `{"enabled": true, "actions": {"enabled": true}}`（本任务改动 ①，见 impl 报告 §1）
- `readAutonomyConfig` 实测：`PROD config actions.enabled = true | enabled = true`
- 默认关闭零行为不回归：`actions` 缺键 ⇒ `run.ts:91` 直接 return，除一次 config 读外零 IO（测试 `_test_runtime_autonomy_actions.ts:1603` G1-1(c)）

### 2.3 候选与映射

- `run.ts:103` `candidateTriggers = snap.triggers.filter((t) => TRIGGER_ALLOWLIST.has(t.rule))`
- `TRIGGER_ALLOWLIST` 由 `TRIGGER_CLASS_MAP` 派生（`policy.ts:43`），现 **5 条**
- `policy.ts:40` `blocked_overdue: ["notify-local-master"]` ⇒ **只 notify，不 diagnostic-report**
- `run.ts:107-114` 按 `TRIGGER_CLASS_MAP[rule]` 枚举 class；`started` 即 return（`maxNewPerTick=1`，`run.ts:111-112`）

### 2.4 决策树（L0–L3）

`policy.ts:128-165` `decide(ctx)`，逐层短路：
- L0（`policy.ts:130-134`）：`actionsEnabled` / `killPresent` / `breakerReadable` / `breakerTripped` / `isOwner`
- L1（`policy.ts:137-141`）：`TRIGGER_CLASS_MAP[rule]` 存在 ∧ `class ∈ map[rule]` ∧ `class ∈ ACTION_CLASS_ALLOWLIST` ∧ `!approximate`
- L1.5（`policy.ts:143-148`）：notify 类必须 `notifyScopeOwner === "ok"`（**发信前查目标 scope owner**；无主/死主 → DENY）
- L2（`policy.ts:151-155`）：closure / snapshot / rollback / postverify / lease
- L3（`policy.ts:158-162`）：inFlight / newPerTick / 1h / 连败 / **dedup（`SKIP cooldown`，1h 窗）**

`notifyScopeOwner` 的取值来自 `run.ts:195-198` → `classes/notify.ts:149-163` `ownerCheck`：
- 无 attachment ⇒ `"ownerless"` ⇒ DENY（`policy.ts:145`）
- liveness 判 stale ⇒ `"stale"` ⇒ DENY（`policy.ts:146`）
- 其余（alive / liveness 缺失 / 身份不匹配）⇒ `"ok"` ⇒ 放行

### 2.5 投递（效应面 = 恰一个信件文件）

`classes/notify.ts:121-142` `buildContent`
```ts
subject: `autonomy-notify/${trigger.rule}`,   // 不以 run://tab/ 开头
kind: "REPORT",
requiresAck: false,
from: "agent://autonomy-actions",
to:   localMasterAddress(localMasterScope(project)),
```
`classes/notify.ts:183` 的 `effect()` → `deliverLetter`（`runtime/mailbox.ts:78-118`）⇒ `mailboxDirFor(to)/<messageId>.json`，落盘形状是 `{ frame, status:"pending", expiresAt }`（`mailbox.ts:108`）。

> **为什么这封信能被 scope wake 认领**（GLM F10 / spec F10）：`scope.ts:257-264` `isReportShape` 要求 `subject.startsWith("run://tab/")` **且** `body.details.status` 存在。本信 subject 是 `autonomy-notify/blocked_overdue`、details 里只有 `{rule, project, evidence, approximate}`（无 `status`）⇒ `isReportShape === false` ⇒ `isScopeWakeLetter === true`（`scope.ts:270-273`）⇒ 进 scope 的 wake 候选集。

### 2.6 1h 去重（不刷屏）

`run.ts:184` `dedupHit(breaker, dedupKey, now)`；`dedupKey = rule:class:project`（`run.ts:152`）；`breaker.ts:129-134` 判 `now - last < BUDGET.hourMs`（1h）。
⇒ 与 frontier 的 `blockedOverdueThrottle`（per-runId 1h 节流账，快照顶层）**同一量级**（1h），两层都拦得住。
> 注意两层粒度不同：frontier 层按 **runId**（`blockedOverdueThrottle[project]: Record<runId, ts>`），actions 层按 **`rule:class:project`**（项目级）。⇒ 最保守（1h 内同项目同 rule 至多动作一次）。
> **这也是 R3 的缓解事实**：即便 frontier 层账本全丢（`frontier.json` 被删）导致 trigger 重出，actions 层 1h 去重仍会 `SKIP(cooldown)` ⇒ **不会真发第二封信**，只是多一次无效唤醒。
**测试证据**：`_test_runtime_autonomy_actions.ts:1618`（G1-1(d)：第二 tick +60s ⇒ `skipped(reason==="cooldown")`，且 mailbox 仍只有 1 封）。

### 2.7 生产配置下的实际可达性（诚实标注）

- `runAutonomyActions` 的唯一生产调用点是 `wake.ts:120`，它在 `evaluateWakes` 里、**全局 master owner 门之后**（`wake.ts:106`）。⇒ 需要主会话进程活着 + 主会话是全局 master owner。
- `notify-local-master` 还需要**目标仓 scope 有 owner**（`policy.ts:151-155`）⇒ 该仓没人 `master-attach local` 过 ⇒ 这封信会被 DENY(`scope-ownerless`)。
- 这两条都不在本任务范围内（前者是既有拓扑，后者是方案 A 的刻意设计：不给无主仓投"无人看"的信）。

---

## 3. 步骤 3：执行者被拉起（含监管块）

### 3.1 scope 路的 tick

`extensions/mailbox-consumer.ts:786`
```ts
const d = evaluateScopeWake({ sessionId: sid, scope: scopeKey, mailboxDir, stateDir, runsDir });
```
tick 自检在前（`mailbox-consumer.ts:776-780`）：attachment 换主/换代 ⇒ 停自己（`deactivateScopeConsumption`）。

### 3.2 `evaluateScopeWake` 的六道门 + claim + 派生

`extensions/runtime/scope.ts:359-416`

| 行 | 门/动作 | 不通过时 |
|---|---|---|
| `:365` | `readCutover()?.enabled` | `reason:"cutover-off"` |
| `:366` | `readAttachment(addr)` 存在 | `reason:"no-owner"` |
| `:367-369` | `opts.sessionId === att.sessionId` | `reason:"not-owner"` |
| `:373-375` | `isInFlight(state.lastTabRunId, …)` | `reason:"in-flight"` |
| `:378-383` | `listScopeWakeLetters(...)` 有 wake 类信 | `reason:"no-mail"` |
| `:387-392` | `claimLetters(...)` 拿到 ≥1 | `reason:"claim-missed"` |
| **`:401-407`** | **`deriveSupervisionItems({stateDir, runsDir, now, repoPath: repoCwd})`** | 派生失败/空 ⇒ `undefined`（→ prompt 不变） |
| `:406-415` | `buildScopeWakePrompt(scope, letters, repoCwd, supervision)` | — |

**派生位置在 claim 之后**（`:387` claim → `:401` 派生）⇒ 六条早退路径的"零 IO"语义未变。

### 3.3 监管块怎么进 prompt（断点 ②，本任务接通）

`extensions/runtime/scope.ts:460-497`
```ts
export function buildScopeWakePrompt(scope, letters, repoCwd, supervision?: WakeSupervisionItem[]): string {
    ...
    const supervisionBlock = Array.isArray(supervision) && supervision.length > 0 ? buildSupervisionBlock(supervision) : [];  // :479
    const lines = [
        `你是仓库 ${scope} 的本地 Sub-Master（…）。`,                    // :481
        repoCwd ? `工作目录：${repoCwd}（本仓）` : null,                  // :482
        `待处理输入（${letters.length}）：`,                              // :483
        ...shown.map(...),                                              // :484
        ...supervisionBlock,                                            // :485  ← 插入点
        ...replyBlock,                                                  // :486
        `规则：单次有界执行…`,                                          // :487
        ...
    ]
}
```
渲染复用 `wake.ts:428` `buildSupervisionBlock`（**同一份代码**，workstream 路与 scope 路不会漂）：
```
停滞监管（需推动的 tab，按 budget 余量决定是否推）：
- <runId> task=<taskId> repo=<basename> 已停 <N>min stop=<stop> push=<used>/<max> 摘要：<≤120 字>
  用 supervise-push({runId:"<runId>"}) 推动（预算耗尽则升级用户，勿 abort）。
```

**派生的 repo 过滤**（本任务新增）：`wake.ts:265-330`
- `repoFilter = opts.repoPath ? normRepoPath(opts.repoPath) : null`（`:291`）
- 命中判据 `repoPathMatches(itemRepoPath, repoFilter)`（`:306` → `:243-249`）：相等 ∨ 候选在本仓**子目录**下（`dispatch.cwd` 可能是 repo 子目录）
- 过滤后为空 ⇒ `undefined`（`:333`）⇒ prompt 逐字节不变

### 3.4 spawn

`extensions/mailbox-consumer.ts:803-812`
```ts
const tabRunId = wiring.spawn(fired, sid);
confirmScopeWakeSpawn(scopeKey, tabRunId, {...});   // wake-state + ack
```
spawn 抛错 ⇒ `auditScopeWakeSpawnFailed`（`:812`），信留 claimed（stale 恢复）。

生产 wiring：`extensions/index.ts:2657-2672`（spawn 回调 `:2659-2671`）
```ts
collect(registerScopeWakeLoop(pi, {
    intervalMs: 30_000,
    spawn: (decision, sessionId) => {
        const r = spawnOneShotTab({
            taskId: `l2-${decision.scope.slice(0,14)}`,
            prompt: decision.prompt ?? "",          // ← 含监管块
            cwd: decision.repoCwd ?? process.cwd(),
            ...
        });
        if (r.error) throw new Error(r.error);
        return r.runId;
    },
}));
```

`extensions/index.ts:2593-2634` `spawnOneShotTab`
- `:2621-2623` 写 dispatch（`writeTabDispatch`）+ 事件 + link
- `:2625-2628` `spawnPiTab({ ..., tabRunId: runId, runsDir })`   ← **一行把新 tab 变成"标签页会话"**

`extensions/tab-launch-core.ts:375-384` `buildTabSpawnEnv`
```ts
if (opts.tabRunId) {
    return { ...baseEnv, PI_TAB_RUN_ID: opts.tabRunId, PI_TAB_RUNS_DIR: opts.runsDir, ... };
}
```
（另有 authoritative 的 `--tab-run-id` CLI flag，见 `tab-launch-core.ts:394-397` 注释。）

**这一步的测试证据**：
- `_test_runtime_supervision_push.ts:1181`（11(a) 三参 == 冻结字面量）
- `:1184`（11(b) `undefined`/`[]` 同；含 `repoCwd=null` 分支）
- `:1191`（11(c) 真账本 ⇒ prompt 含 `停滞监管` / runId / `supervise-push`）
- `:1220`（11(d) 他仓条目被过滤 ⇒ prompt 回冻结字面量；子目录命中）
- `:1281`（12(a) **真实入口全链**：`buildFrontier` → `writeFrontierSnapshot` → `runAutonomyActions` → scope mailbox 出现 `msg_autonomy*.json`（`existsSync` + 读回 `subject==="autonomy-notify/blocked_overdue"`）→ `evaluateScopeWake` `fire===true` 且 prompt 含 `停滞监管` + runId + `supervise-push`）

---

## 4. 步骤 4：执行者调 `supervise-push` —— **断点 #4（未闭合）**

### 4.1 事实证据（`file:line`）

新 tab 进程拿到 `PI_TAB_RUN_ID` ⇒ `getTabRunId()` 为真：

`extensions/identity.ts:77-87`
```ts
export function getTabRunId(): string | undefined {
    if (cachedPi) { const fromFlag = cachedPi.getFlag(FLAG_NAME); if (...) return fromFlag.trim(); }
    return envTabRunId();     // ← PI_TAB_RUN_ID
}
```

工具注册面在 execute 的第一道（第二行）就拒绝：

`extensions/supervision-runtime.ts:599-600`
```ts
async execute(_toolCallId, rawParams) {
    if (isSubagent()) return text("子 agent 中不可推动（supervise-push 仅主会话可用）", true);        // :599
    if (getTabRunId()) return text("监管推动仅主会话可用（标签页会话不得推动）", true);                // :600  ← 断点 #4
```

工具描述也明写同一约束：`supervision-runtime.ts:578` `"仅主会话可用（子 agent / 标签页身份调用一律拒绝）。"`

⇒ **本任务之后，链路仍然止于「执行者被拉起、prompt 里带着 `supervise-push({runId:"…"})` 指令、但它一调就被拒」。**

**为什么这不是本任务能修的**（spec §3.3 硬约束 + §7 纪律）：spec 明确"不改 `supervision-runtime.ts` 的门 4b"、"不放宽 `supervise-push` 身份门"。放宽身份门是**权限模型变更**，必须由主会话裁决。

**因此第 12 组测试刻意只断言到"执行者之前"**（spec §4.3 明确要求："该组**不要**断言 `supervise-push` 被调用成功（见 §5 断点 #4）"）。

### 4.2 两个候选修法（**本次不实现，交主会话裁决**）

#### 候选 A：给"被 scope wake 拉起的一次性 tab"发受限能力（最小侵入，需显式授权位）

- 现状接线点：`extensions/index.ts:2593` `spawnOneShotTab` 是 `wake` 与 `l2-` 两条 spawn 的**共同**通道；`index.ts:2626` 一行（`tabRunId: runId`）决定"是新 tab"。
- 做法：`spawnOneShotTab` 加一个显式旗标（如 `allowSupervisePush?: boolean`），只在 `registerScopeWakeLoop` 的 spawn 里传 `true`；`spawnPiTab` 把它变成 env（如 `PI_SUPERVISE_PUSH_ALLOWED=1`，与 `PI_TAB_RUN_ID` 同一条 `buildTabSpawnEnv` 链路，`tab-launch-core.ts:375-384`）。
- 工具侧：`supervision-runtime.ts:600` 从 `if (getTabRunId()) return 拒绝` 改为 `if (getTabRunId() && !allowedByExplicitEnv()) return 拒绝`。
- **代价/风险**：这是"用 env 白名单放宽身份门"。env 是进程级可伪造的，必须同时收紧到"仅此一次启动、仅此工具"；且需新增测试钉死"普通 workflow tab 仍然被拒"。**必须新增一条门，而不是删一条门**。
- 额外必要（否则推了也没用）：`l2-` tab 的 `getTabRunId()` 是**它自己**的 runId，而它要推的是**别人**；候选 A 只解决"能不能调"，不解决"该不该推自己/推别人"的边界 —— 需要配套"目标 runId ≠ 自身 runId"的断言。

#### 候选 B：不放开执行者身份，改成"执行者只产出建议，主会话执行推动"

- 做法：scope wake prompt 里的指令从"你调 `supervise-push`"改为"你回一封信/写一条建议（含 runId + 建议动作），主会话下一 tick 读信后由**主会话**调 `supervise-push`"。
- 落点：`extensions/runtime/scope.ts:479` 的监管块渲染（本任务刚改的地方）+ `deliverLetter` 回执链路（`scope.ts` 已有 `buildReplyRecipe` 机制，`wake.ts:353-370`）。
- **代价**：多一次往返（约 1 个 tick + 1 次唤醒），且需要主会话在下一 tick 真的去读建议 —— 需要一个新的"建议队列"载体，否则退化成"信在 mailbox 里没人看"（正是 GLM 批评的 C.2 问题）。
- **优点**：**完全不动权限模型**，身份门保持原样；与"主会话是唯一有权推动者"的设计一致。
- **缺点**：多一跳延迟；且 `supervise-push` 的预算/熔断计数仍由主会话侧记，与方案 A 等价。

> **我的倾向（只是建议，未实现）**：候选 B 更符合现有权限模型（`supervision-runtime.ts:578` 的显式设计意图是"推动是主会话的职责"），且不需要新增 env 白名单攻击面。但它需要"建议队列"这个新载体，工作量大一档。

### 4.3 如果断点 #4 被修好，后续环节的现状（供裁决参考）

即使 `supervise-push` 被放行，下游还有既有门（`supervision-runtime.ts:155-211` 七条）：
1. `no-mandate`（`:155/:158`）—— 该 runId 必须在监管账本 open 集且非 optOut。生产上：`index.ts:3335`（master-dispatch）与 `index.ts:3581`（launch-tabs）两处自动登记；`spawnOneShotTab`（`index.ts:2593`）**未**接 `autoRegisterDispatchedTabs` ⇒ 被 scope wake 拉起的这个 tab **很可能不在账本里** ⇒ 它想推别人没问题（推的是别人），但它自己不会被别人推。
2. `paused`（`:161`）—— 用户显式暂停。
3. `terminal`（`:166`）—— 已终态 ⇒ 该回收。
4. `needs-human`（`:174/:185`）—— `needsHuman ∨ gate==="awaiting" ∨ attention>0`，以及 `stop=error ∧ pushesThisEpoch>=1`（`:181-188`）。
5. `budget-exhausted`（`:194/:201`）—— 本 epoch `maxPushes`（clamp [1,3]）+ 近 1h cap。
6. `pid-dead`（`:207`）—— `state.pid` 探活失败。
7. `tool-use`（`:211`）—— `phase=working ∧ stop=toolUse`。

对本文的 8 小时场景（`stop=error` + 兜底 `unconfirmed`，`pushesThisEpoch=0`）：**第 3 门已由 `6dc1821` 修好**（兜底 `unconfirmed` 不再当 terminal 证据，见 `_test_runtime_supervision_push.ts:1140` 组 10(a) 实测 `ok:true` + steer 真落盘）⇒ 若能调，这一推**会成功**。

---

## 5. 结论段（逐字回答）

### 「关掉定时器、一个 tab 停了 8 小时、系统会不会自己推它？」

| 环节 | 会不会 | 代码位置 | 本次任务前 |
|---|---|---|---|
| ① tick 检测出「BLOCKED_USER 且超龄 > 30min」 | **会** | `frontier.ts:423`（判据）+ `:585-601`（触发）+ `mailbox-consumer.ts:614`（tick） | **不会**（`stagnation` 只认 `STALLED`，`needs_user` 只在边沿出一次且早已消费） |
| ② 触发 → 一封投到该仓 scope master 的信 | **会** | `run.ts:91`（开关）+ `policy.ts:40`（映射）+ `notify.ts:121-142`（组装）`/`:183-`（effect） | **不会**（`config.json` 无 `actions` 键 ⇒ `run.ts:91` 直接 return，从未发射） |
| ③ 该仓 local master 被拉起，prompt 带 runId + `supervise-push` 指令 | **会** | `scope.ts:401-415` + `:479`（监管块）+ `mailbox-consumer.ts:805` + `index.ts:2661` | **不会**（`buildScopeWakePrompt` 三参、无监管块 ⇒ 被唤醒的 master 只会看到一行 `[autonomy] … @ repo`） |
| ④ 执行者真的调成功 `supervise-push` 推动 | **不会** | `supervision-runtime.ts:600`（标签页身份门） | **不会**（同上，且这一环本任务未碰） |

**一句话**：**「8 小时无人知晓」在本任务后结束了 —— 每小时会有人（该仓 local master）被叫起来、并被明确告知"这只 tab 停了多久、用 supervise-push 推它"。但"推动"这一动作现在仍只有主会话能做，被叫起来的执行者一调就被身份门挡住（断点 #4）。所以：检测✅ 提醒✅ 拉起✅ 推动❌。**

**能不能撤定时器？** —— **不能全撤。** 准确表述：
- 若主会话（拥有全局 master 身份的那个 pi 进程）**一直开着**，且目标仓有 local master owner 在位 ⇒ 本任务后"提醒 + 拉起执行者"可自动发生，**不再需要人挂定时器去看**。
- 但"实际推动"仍需人（主会话）出手，或先修断点 #4。
- 若主会话进程**关掉** ⇒ tick 不跑（`mailbox-consumer.ts:599` 的 interval 在主会话扩展宿主里）⇒ 链路整体冻结；心跳只能让"死相可见"，**不自愈**（AGENTS §10 已登记）。

### 附加诚实标注（避免结论被读得比证据宽）

1. 本文是**代码级完整路径论证 + 单测覆盖**，**不是真机演练**（任务书 §D 明确"真机演练不在本任务内"）。
2. 第 ③ 环的"执行者被拉起"我**没有**起真 WT tab 验证（`spawnPiTab` 需要 `wt.exe` 与真实 GUI 会话，且 AGENTS §9 禁止在用户不在场时操作 GUI）。测试证据止于 `evaluateScopeWake` 返回的 `prompt`（`_test_runtime_supervision_push.ts:1281`）+ 生产 wiring 的静态读出（`index.ts:2657-2672`）。
3. 第 ② 环在生产上还有两道未验证的前置：全局 master owner 在位（`wake.ts:106`）、目标仓 scope owner 在位（`policy.ts:151-155`）。二者不满足时信不会发出，`actions.jsonl` 会留 `rejected(not-owner)` / `rejected(scope-ownerless)`。**我没有对本机生产运行态做这些读数的实测**（避免与正在跑的会话互相干扰），因此"生产上此刻真的会发信"这一点**未被本次证据覆盖**。
4. `blocked_overdue` 的 1h 节流状态存在派生缓存 `frontier.json`；该文件被删/损坏 ⇒ 最多多提醒一次（`frontier.ts:94-100` 注释登记）。
