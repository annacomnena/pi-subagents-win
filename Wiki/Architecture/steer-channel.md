---
title: Steer 通道（立即插入消息）
kind: concept
status: current
updated: 2026-10-13
source_paths:
  - extensions/steer.ts
  - extensions/steer-consumer.ts
  - extensions/steer-runtime.ts
  - extensions/injection-gate.ts
  - extensions/index.ts
  - extensions/_test_steer.ts
  - extensions/_test_steer_consumer.ts
  - extensions/_test_steer_takeover_worker.ts
---

# Steer 通道（立即插入消息）

## Summary

Steer 通道让**主会话（Master）向某个正在运行的标签页会话立即插入一条消息**，与 timers 的「延迟投递」在**目录、模块、记录字段、语义**上完全分离。通道本体是 `~/.pi/agent/steer/<tabRunId>/` 文件账本；标签页内常驻消费者（`fs.watch` + tick 兜底）只消费**自己**的目录；Master 侧工具 `tab-steer` 写记录、`steer-status` 读落盘回执。

当前交付为 **M1 + M2 两档**：`mode:"steer"`（缺省，消息在**当前 assistant turn 的 tool calls 全部跑完、下一次 LLM 调用之前**送达，**不打断在跑的工具**）与 `mode:"abort"`（升级档，**打断当前 run（含杀挂死工具进程树）→ 等目标空闲 → 再发消息**）。

## Current Contract

### 通道布局

```
~/.pi/agent/steer/<tabRunId>/<id>.json              # 记录本体（Master 原子写；消费者原子改写）
~/.pi/agent/steer/<tabRunId>/<id>.claimed           # 跨实例消费认领（openSync "wx" 原子 sidecar）
~/.pi/agent/steer/<tabRunId>/<id>.claimed.takeover  # 租约接管的独占令牌（CAS；见「消费与去重」）
~/.pi/agent/steer/<tabRunId>/<id>.json.tmp          # 原子写中转（rename 后消失）
```

- 与 `~/.pi/agent/timers/mail/<runId>/` **并列但语义不复用**（延迟投递 vs 立即投递，见「纪律」）。
- `<id>` = `steer_<base36 时间戳>_<rand>`；`<tabRunId>` 与 `<id>` 均过安全组件守卫（`SAFE_ID_PART` 且显式拒绝 `.`/`..`，`steer.ts::isSafeSteerComponent`），防路径注入。
- 消费者在 `session_start` 后、身份就绪时 `mkdirSync` 自己的目录再挂 `fs.watch`——目录必须早于 Master 首次写入而存在。
- 目录清理：终态记录超 TTL 删除、孤儿 sidecar/令牌回收、空目录删除。

### 两档投递语义

**`steer` 档（M1）**

- 动作：`sendUserMessage(body, { deliverAs: "steer" })`，`await`。
- 生效时点：**当前 assistant turn 的 tool calls 全部返回后、下一次 LLM 调用前**（pi `agent-session.js` 的 steer 语义）。若某个工具永不返回，该消息也永不生效。
- 推荐把 `delivered` 读成「**已入 steering 队列**」，不是「已生效」。

**`abort` 档（M2）**

- 动作（固定序列，见 `steer-consumer.ts::runAbortTier`）：
  1. 先把 `abortedAt` 落盘（保证「abort 已发生但无回执」窗口为 0，记录此时仍为 `pending`）；
  2. `ctx.abort()`（TUI 下经宿主 abortHandler 清队列 + `session.abort()`；挂死工具进程经 `killProcessTree` 被杀）；
  3. 轮询 `ctx.isIdle()`（间隔 `ABORT_IDLE_POLL_MS = 250ms`，上限 `ABORT_IDLE_TIMEOUT_MS = 30s`）；
  4. 观察到空闲 → 记 `idleAt`；`body` 非空 → `sendUserMessage(body)`（**不带 `deliverAs`**，空闲态走 `prompt()` 正常路径起新 turn）→ 记 `deliveredAt`；`body` 为空 = 纯打断（无 `deliveredAt`）；
  5. 终态 `status:"aborted"`。
- **固定序列必须是「abort → 等 idle → 再发消息」，绝不能「先 steer 再 abort」**：TUI 模式下 `ctx.abort()` 经宿主的 abortHandler 走 `restoreQueuedMessagesToEditor` → `clearAllQueues`，会把调用瞬间已排队的消息**清回用户编辑器**（`dist/modes/interactive/interactive-mode.js`），因此 steer 后再 abort 必然丢失刚插入的消息。该「清队列进编辑器」是宿主既定行为，不在本通道修正范围。
- **ctx 来源与刷新（A8）**：`ctx` 在每次 `session_start` 捕获并覆盖（`new`/`fork`/`switch`/`reload` 都会触发 `session_start`）；`steer-consumer.ts` 另有 `ctxGen` 代次，每次捕获递增。abort 档在轮询中检测到代次变化（= 会话被替换、旧 runner 的 ctx 已被 pi invalidate）→ 立即停手、回执 `failed` + `stale-ctx`，**绝不向已失效 ctx 半途发消息**；`ctx.abort()`/`ctx.isIdle()` 抛出的 stale 错误也被归类为 `stale-ctx`。
- **何时该用 abort**：仅当 steer **无法送达**（目标卡在永不返回的 tool 里，tool 边界永不发生）时使用。abort 会打断当前 run（含杀挂死工具进程树），代价是丢失在跑工具的输出。

### 回执状态机

| status | 含义 |
|---|---|
| `pending` | Master 已落盘，尚无消费者认领（长 tool 批期间 pending 是正常态） |
| `delivered` | 消费方已把消息交给 pi 且 `sendUserMessage` resolve（**= 已入 steering 队列，不等于已生效**） |
| `aborted` | abort 档已执行：已 abort（+ 已观察到 idle）；`body` 非空且发送成功时同时有 `deliveredAt` |
| `failed` | 消费方尝试后真实失败（reject / abort 后仍非 idle / ctx stale），带 `error` |
| `undelivered` | 从未被活 tab 消费（目标不活 + TTL），带 `undeliveredReason` |

- 时间戳字段：`createdAt`、`claimedAt`/`claimedBy`、`deliveredAt`、`failedAt`+`error`、`undeliveredAt`+`undeliveredReason`、`abortedAt`/`idleAt`。
- abort 档失败分类（均写终态、不半途）：`no-ctx`（无可用 ctx）、`stale-ctx`（会话替换/ctx 失效，含轮询期间代次变化、以及 idle 与 send 之间代次漂移或 send 抛 stale）、`still-streaming-after-abort`（超时仍非 idle）、`abort-failed: …` / `idle-check-failed: …`。abort+idle 已达成但随后 `sendUserMessage` 遇**不可重试**失败时，状态仍为 `aborted`（abort 确实发生）但无 `deliveredAt`、带 `error`；命中可重试分类（compaction / already processing / 无 injector）则与 steer 档一致：释放认领、保持 `pending`、下 tick 重试。
- 注入收据（SF-5）：abort 档只在**消息真正送达**（`deliveredAt` 已写）时才 `postInject(true)`；纯打断或发送失败都不确认注入，避免收据把「已打断」当成「已送达」。
- **`undelivered` 只在有「目标不活」证据时才写**：Master sweep 判据 = `readTabState` 缺失 / `terminal===true` / `lastActivityAt` 超过 `STEER_TARGET_STALE_MS`（30min），并叠加「目标有新鲜 `.claimed`」作为活证据（`steerHasFreshClaim`）。**单纯 pending 超时不足以判 undelivered**（长单工具期间 pending 正常）。
- 可重试分类（不伪造终态）：compaction 进行中、`already processing`、无 injector → 释放认领、保持 pending、下 tick 重试；其他 reject/throw → `failed`。

### 工具与 scope

| 工具 | 参数 | 说明 |
|---|---|---|
| `tab-steer` | `{ tabRunId, message, mode?, waitMs? }` | `mode` 缺省 `"steer"`，可选 `"steer"`\|`"abort"`（schema 为 Union）；`message` ≤ `MAX_STEER_MESSAGE = 2048`（`abort` 档允许空串 = 纯打断）；`waitMs>0` 时轮询回执至终态或超时（上限 `MAX_STEER_WAIT_MS = 30s`，间隔 250ms），否则立即返回 `pending` |
| `steer-status` | `{ tabRunId?, id? }` | 读回执并按需过滤；顺带做一次惰性 sweep |

- **scope**：主会话可写/查任意 tab；**标签页只能给自己**（`validateSteerRequest` 的 `myRunId` 自限 + `steer-status` 身份自限）；**subagent 一律拒绝**（execute 首行 `isSubagent()`）。
- **写前守卫（拒绝而非写后清理）**：`tabRunId` 非法 → 拒；无派发账本（`readTabDispatch` 为空）→ `unknown tab`；已终态（`readTabResultFile` 非空或 `readTabState().terminal===true`）→ `tab already terminal`；`message` 空/超长、`mode` 非法 → 拒。以上一律返回 `isError` 且**不产生任何文件**。
- 路径注入（如 `tabRunId:"../../evil"`）由安全组件守卫拒绝。

### 消费与去重

- 标签页内 `registerSteerConsumer`：`session_start` 捕获 ctx（并递增 `ctxGen`）+ 设定 sessionId，`isSubagent()` 不注册；`getTabRunId()` **每 tick 惰性重取**，身份就绪才建目录/挂 watch。
- 分档执行：`consumeSteerRecord` 在认领章落盘后按 `record.mode` 分派——`steer` 走 `sendUserMessage(deliverAs:"steer")`；`abort` 走 `runAbortTier`（序列见「两档投递」）。
- 三层去重：① 内存 `seenIds`（同实例幂等，只挡终态/畸形）＋ ② `<id>.claimed` 的 `openSync("wx")` 原子认领（跨实例/跨 reload）＋ ③ `injection-gate` 的 `claimInjection` 互斥（`path:"steer-channel"`、`dispatcherWake:true` 跳过 owner 压制但保留互斥）。
- 认领租约 `STEER_CLAIM_LEASE_MS = 10min`：认领者崩溃留下的陈旧 `.claimed` 由后来者接管（at-least-once，最终收敛到终态）。接管临界区（复核陈旧 → 删旧 sidecar → 重认领）由 `<id>.claimed.takeover` 的 `wx` 独占令牌串行化（真 CAS）；令牌租约 `STEER_TAKEOVER_LEASE_MS = 30s`，孤儿令牌由 sweep 回收。
- 半截/损坏 JSON：`readSteerRecord` 返回 null → 不标 seen、不认领，下 tick 重试，消费者不崩。

### 纪律（关键）

- **steer 到不了「挂死在 tool 里」的会话**：tool 边界被永久阻断，消息只会在队列里等到永不发生。
- 叫醒/中断挂死会话用 **abort 档**（`mode:"abort"`）：打断当前 run（含杀挂死工具进程树）后起新 turn；代价是丢失在跑工具的输出。
- **与 `timers/mail` 的分工**：timer 是**延迟投递**（到点开火、一次性推进），steer 是**立即投递**（带回执状态机）。**不要混用**：需要「稍后」用 `set-timer`，需要「现在」用 `tab-steer`。

## 已知限制（NF-1：接管令牌的租约 fencing 窗口）

- 现象：持有 `<id>.claimed.takeover` 令牌的进程若被**外部冻结超过令牌租约**（`STEER_TAKEOVER_LEASE_MS = 30s`，如 SIGSTOP / 任务管理器挂起 / 机器休眠 / VM 暂停 / 调试器断点），解冻后会继续执行临界区余下步骤、**删掉接管者已建立的新鲜 `.claimed`** 并重新认领 → 双认领、极端下同一 steer 注入两次。
- 可达性：生产路径临界区**只含同步 fs 调用**（微秒级），**无 `await`、无用户代码**，故正常调度不可达（3 个真实进程 × 200 轮并发接管 0 命中）；只有在**注入进程冻结**的确定性复现实验中才触发。这是所有基于租约的锁的固有性质。
- 影响：极端运维场景下的重复投递（一次消息注两次）。
- 缓解/后续方向：给 `<id>.claimed` 引入 **fencing 代次**（令牌创建时写随机 nonce；接管者 `acquire()` 成功后回读校验自身 nonce；`unlink` 前复核目标 claim 代次仍等于自己复核的那一代，不等则让位）。未做；触发条件不在生产代码可达域内，宜独立切片评估。

## 未证实（UNKNOWN）清单

以下项**尚未端到端实证**（多为需真实 TUI tab 的手测，见下节清单）：

1. **A1**：忙碌 tab 在下一个 tool 边界插入、不打断在跑工具——单测只证明「原样 `sendUserMessage(deliverAs:"steer")` 恰好一次」，生效时点由 pi `agent-session.js` 决定，真实 tab 端到端**未执行**。
2. **A2**：空闲 tab 收到即起新 turn（`deliveredAt - createdAt < 2000ms`）——端到端**未执行**；且 `STEER_TICK_MS = 5000` 与 2000ms 指标存在天然张力（`fs.watch` 丢事件时只能等 tick）。
3. **A6**：真实「未启动 / 已退出 tab」的僵尸收敛——单测已证等价语义（写前守卫 + 惰性 sweep → `undelivered`），真实派发后不启动/退出的端到端**未做**。
4. **A5′**：两个**真实 pi 进程**同时 watch 同一 steer 目录只注入一次——已用真实多进程验证到完整消费链（认领→发送）200 轮 exactly-once，但**未用两个真实 `pi` CLI 实例**端到端 watch 同一目录。
5. **M2（A3/A8）**：abort 档单测已覆盖固定序列（abort 严格早于 send）、`still-streaming-after-abort`、`no-ctx`、`stale-ctx`、会话替换后 ctx 刷新、空 body 纯打断；但**真实 TUI 端到端手测（A3 杀挂死 pwsh、A8 `/new` 后 abort）仍未执行**——`ctx.abort()` 在真实 TUI 下是否 killProcessTree 生效、isIdle 翻转时延，待人工按「M2 人工手测」执行。
6. **M2 前置 spike（J1/J2/J4）**：计划 §9 的 abort 前置 spike **未执行**——J1（后台 `ctx.abort()` 不 deadlock）、J2（`isIdle` ≤5s 翻转且杀挂死 pwsh）、J4（空闲后新 turn 真起）均无实测证据。**A3/A8 实机通过前不得声明 M2 验收通过**。
7. **U-ENV**（审查范围项，非功能事实）：`G:/code/**`、`~/.pi/agent/runtime/**` 是否被触碰，因无基线无法机器复核。

## 人工端到端手测清单（M1 + M2）

> 目标：独立复核者按步可照做、每步有预期观察点。覆盖 **A1 / A2 / A3 / A4 / A5 / A6 / A7 / A8 / A9**。

**前置条件**

- Windows 11 + Windows Terminal(`wt.exe`) + 可用 pi provider；harness 已作为 pi package 加载（`package.json.pi.extensions → ./extensions/index.ts`）。
- 一个 **全新标签页** 作为被测对象（用 `launch-tabs` 派发，记下返回的 `tabRunId`）。
- ⚠️ **安全提醒**：**只在新建的测试 tab 上做**；**不要**向任何正在运行或已完成的其他 tab 投递 steer，免得打断它们的工作。被测 tab 也可以只做「长任务 + 收到消息后输出一行」即可。
- 观测面：被测 tab 的 TUI、`~/.pi/agent/steer/<tabRunId>/*.json`、`steer-status` 输出、会话 transcript。

**步骤**

1. **构造「忙碌 tab」（测 A1）**：让被测 tab 连续执行多次单独的工具调用，调用之间有明显间隔。例如给它这条任务：「依次单独运行 6 次 `pwsh -Command "Start-Sleep 6; Get-Date"`，每次一个工具调用，不要合并」。确认 tab 正在跑工具。
   - 预期：tab TUI 里在跑工具、尚未空闲。
2. **A1（忙碌 steer）**：在 Master 调 `tab-steer({ tabRunId, message: "立即插入：把当前进度写成一行小结", mode: "steer" })`。
   - 预期观察点：该 user message 出现在**当前 tool 批结果之后、下一次模型请求之前**（不打断在跑的工具）；`~/.pi/agent/steer/<tabRunId>/` 下出现 `<id>.json` 与 `<id>.claimed`。
3. **A4（回执）**：调 `steer-status({ tabRunId })`。
   - 预期：该条为 `delivered` 且 `deliveredAt ≥ createdAt`，并附带「已入 steering 队列（下一个 tool 边界才生效）」提示。
   - 对照：另取一个**已终态**的 `tabRunId` 调 `tab-steer` → 预期 `isError: tab already terminal`（**不出现 `delivered`**）。
4. **A2（空闲 steer）**：等被测 tab 空闲（无在跑工具）后，重复第 2 步投一条新消息。
   - 预期：tab 立刻出现新 turn；`steer-status` 里 `deliveredAt - createdAt < 2000ms`（若 `fs.watch` 丢事件、只能等 tick，可能接近 5000ms——如实记录数值）。
5. **A5（去重）**：tab 运行期间连续投两条不同 `message`。
   - 预期：tab 里恰好各出现一次（两条，不是四条）；目录里每条记录各有对应 `<id>.claimed`，`steer-status` 为单条终态。
6. **A6（僵尸防治）**：
   - `tab-steer({ tabRunId: "tab_does_not_exist_0000", message: "x" })` → 预期 `isError: unknown tab（无派发账本）`，且 `~/.pi/agent/steer/tab_does_not_exist_0000/` **未被创建**。
   - 从一个已完成的 tab-runs 结果文件取一个 `tabRunId` 投递 → 预期 `isError: tab already terminal`，同样不产生文件。
   - （TTL 收敛部分需等待 `STEER_PENDING_TTL_MS = 30min` 才可显露；手测只做上面的写前守卫部分即可。）
7. **A7（半截 JSON）**：手工在被测 tab 目录写入一个截断的 `*.json`（如 `{"id":"steer_manual_1","version":1,"tabRunId":"<tabRunId>","mode":"steer"`）。
   - 预期：消费者**不崩、不投递、不标 seen**；把该文件补全为合法记录后，**下一 tick** 内正常投递（`delivered`）。
8. **A9（入参安全与边界）**：依次调：
   - `tab-steer({ tabRunId: "../../evil", message: "x" })` → 预期 `isError`（unsafe tabRunId）。
   - `tab-steer({ tabRunId, message: <2049 字符> })` → 预期 `isError`（超长）。
   - `tab-steer({ tabRunId, message: "x", mode: "bogus" })` → 预期 `isError`（非法 mode；`"steer"`/`"abort"` 为合法值）。
   - `tab-steer({ tabRunId, message: "", mode: "steer" })` → 预期 `isError`（steer 空 message）；`mode:"abort"` + 空 message 则允许（纯打断）。
   - 预期全局：`~/.pi/agent/` 下**无越界文件生成**。
9. **收尾核查**：`steer-status({ tabRunId })` 无残留 `pending`；`~/.pi/agent/steer/**` 无空目录堆积。

**A3 / A8（abort 档，M2 已实现）**：

- **A3 构造「挂死 tab」**：让被测 tab 执行 `pwsh -Command "Start-Sleep 600"` 并确认卡住（提醒：外层用 `timeout` 包裹，如 `timeout 700 pwsh -Command "Start-Sleep 600"`，避免留下永不退出的 pwsh 需手工清理；无 `timeout` 时用 `taskkill /PID <pid> /F`）。用 `tasklist | findstr pwsh` 记下 PID。Master 调 `tab-steer({ tabRunId, message: "打断：改做 X", mode: "abort" })`，预期：该 pwsh PID 消失（`tasklist`）、tab 回到 idle 并执行「改做 X」、`steer-status` 为 `aborted` 且 `abortedAt`/`idleAt`/`deliveredAt` 齐全。
- **A3 反面（永不 idle）**：若目标 abort 后仍持续 streaming 超 30s，预期 `steer-status` 为 `failed` + `error: still-streaming-after-abort`，且**无** `deliveredAt`（绝不伪造送达）。
- **A8（会话替换后 ctx 不 stale）**：tab 内 `/new`（或 reload）后再次投 `mode:"abort"` → 不出现 “This extension ctx is stale” 类错误，abort 生效、`steer-status` 为 `aborted`。
- **纯打断**：`tab-steer({ tabRunId, message: "", mode: "abort" })` → `aborted`，带 `abortedAt`/`idleAt`、无 `deliveredAt`。

## Evidence

- `extensions/steer.ts` — 常量 `MAX_STEER_MESSAGE`(:40)、`STEER_PENDING_TTL_MS`(:42)、`STEER_TERMINAL_TTL_MS`(:44)、`STEER_TICK_MS`(:46)、`STEER_SWEEP_MS`(:48)、`STEER_TARGET_STALE_MS`(:50)、`STEER_CLAIM_LEASE_MS`(:56)、`ABORT_IDLE_TIMEOUT_MS`(:59)、`ABORT_IDLE_POLL_MS`(:61)、`STEER_TAKEOVER_LEASE_MS`(:68)；类型 `SteerMode/SteerStatus/SteerSendStatus`(:73–76)、`SteerRecord`(:78)、`M1_STEER_MODES`(:107)、`M2_STEER_MODES`(:109)；路径/守卫 `isSafeSteerComponent`(:131)、`steerFilePath`(:142)、`steerClaimPath`(:148)、`steerTakeoverPath`(:154)；校验 `validateSteerRecord`(:171，缺省 M2 白名单)、`validateSteerRequest`(:247，abort 允许空 body)；状态机 `isSteerTerminal`(:281)、`withSteerStatus`(:286)、`withClaim`(:295)；IO `writeSteerAtomic`(:309)、`readSteerRecord`(:319)、`listSteerIds`(:333)；认领 `claimSteerAtomicDetailed`(:377, CAS 接管)、`steerHasFreshClaim`(:466)；发送分类 `sendSteerDetailed`(:512)；GC `sweepTerminalSteerRecords`(:543)、`expirePendingSteerRecords`(:614)。
- `extensions/steer-consumer.ts` — `runAbortTier`(:164，abort → 轮询 isIdle → 再发，含 no-ctx/stale-ctx/still-streaming-after-abort 分类)、`capturedCtx`/`ctxGen`(:88/:94，session_start 刷新)、`isStaleCtxError`(:133)、`consumeSteerRecord`(:259，三层去重 + 按 mode 分档)、`registerSteerConsumer`(:370)、`snapshotExisting`（只对终态标 seen）、`resetSteerConsumer`。
- `extensions/steer-runtime.ts` — `MAX_STEER_WAIT_MS`、`WAIT_POLL_MS`、活性判据 `targetTabAlive`、`targetRunTerminal`、sweep `sweepAllSteerDirs`、`renderRecord`(:162，含 abortedAt/idleAt)、`registerSteerTools`(:187, `tab-steer` + `steer-status` + Master-only 60s sweep；`mode` schema 为 `Union("steer","abort")` :209)、`waitForTerminal`。
- `extensions/injection-gate.ts:24` — `InjectionPath` 新增 `"steer-channel"`（不改 `preInject/postInject` 逻辑）。
- `extensions/index.ts:1845–1849` — `collect(registerSteerTools(pi))` + `collect(registerSteerConsumer(pi))`（子 agent 已在上方 early-return）。
- 测试与夹具：`extensions/_test_steer.ts`（纯函数/守卫/状态机/TTL/发送分类/M2 白名单）、`extensions/_test_steer_consumer.ts`（消费者/去重/分档/abort 档固定序列与失败分类/接管并发）、`extensions/_test_steer_takeover_worker.ts`（真实多进程并发接管夹具）；scripts `npm run test:steer`、`npm run test:steer-consumer`。
- pi 侧语义（`@earendil-works/pi-coding-agent` 0.99.1）：`dist/core/agent-session.js` 的 steer（tool 边界后、下次 LLM 前）与 followUp 语义、`prompt()` streaming 分支与 compaction reject；TUI 的 abortHandler → `restoreQueuedMessagesToEditor` → `clearAllQueues`（`dist/modes/interactive/interactive-mode.js`）——abort 清队列进编辑器是 M2 固定序列「abort → 等 idle → 再发」的根据。

## Links Out

- [[Wiki 索引]]
- [[微信 iLink 通道]]（同为「进程外 → 运行中会话」的投递通道，可对照其注入门/回执纪律）
- [[期望账本（⑧ 请求—回执期望）]]（请求—回执语义的另一载体）
- [[异步 Run 控制面（list / kill）]]（另一种「运行中对象」控制面：整棵进程树 kill 与工具返回式错误语义，可对照本通道的落盘回执）

## Backlinks

- [[Wiki 索引]]

## Open Questions

- A3/A8 的真实 TUI 端到端手测待人工执行（单测已覆盖固定序列与失败分类，但 `ctx.abort()` 在真实 TUI 下杀挂死进程树/空闲翻转时延未实测）。
- NF-1 的 fencing 代次加固是否值得做（触发条件不在生产代码可达域内）。
- 端到端手测（A1/A2/A6/A5′）待人工执行以关闭对应 UNKNOWN。
- abort 档在 idle 后 `sendUserMessage` 若被 compaction 拒绝，当前记为 `aborted` + `error`（不重试）；是否需要「idle 后发送重试」待评估。
- `steeringMode` 默认 `one-at-a-time` 会让连续多条 steer 被「一个 turn 一条」节流；运行中改写 `steeringMode/followUpMode` 未支持。
