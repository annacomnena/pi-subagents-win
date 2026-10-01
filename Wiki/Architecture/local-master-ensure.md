---
title: Local Master Ensure（幂等确保）
kind: concept
status: current
updated: 2026-10-01
source_paths:
  - extensions/runtime/local-master-launch.ts
  - extensions/master-tools.ts
  - extensions/index.ts
  - extensions/runner-argv.ts
  - extensions/mailbox-consumer.ts
  - extensions/event-bus.ts
  - extensions/_test_local_master_launch.ts
  - extensions/runtime/scope.ts#listScopeWakeLetters
  - extensions/runtime/scope.ts#evaluateScopeWake
  - extensions/runtime/mailbox.ts#claimLetters
  - extensions/_test_local_master.ts
---

# Local Master Ensure（幂等确保）

## Summary

`local-master-ensure`（工具 + 同名 slash 命令双入口；feat `0586030`，L4 修复 `f5a9b90`）把「人手动去目标仓开 pi 会话 + `/master-attach --local`」变成**主会话可调用的幂等 ensure**：目标仓已有活 local master → `already-running` 零动作；无 owner 或 owner pid 死 → 开一个**可见 Windows Terminal tab（非无头）**，认领交给新会话 `session_start` 的**既有静默路径**（`silentScopeGenesis` / `takeoverStaleScopeOwner`）。语义是**幂等"确保活着"，不是强行接管**；**零新增权力**是本能力的核心边界。

## Current Contract

### 双入口与参数

- **工具** `local-master-ensure`（`master-tools.ts:739`）+ **同名 slash** `/local-master-ensure <cwd> [--no-wait] [--timeout <ms>]`（`index.ts:2194`）——同一四层门、同一 `ensureLocalMaster()` 编排、同一审计（`action=ensure:tool` / `ensure:slash`）。
- 参数面 `{cwd, waitForReady?=true, timeoutMs?=60000}`；`timeoutMs` 经 `clampEnsureTimeout()` 归一（`local-master-launch.ts:68`：缺省 60s、**上限 180000**、下限 100ms、非法/非有限值回落缺省）。slash 的 `--no-wait` → `waitForReady:false`。
- **参数解析**：`parseLocalMasterEnsureArgs()`（`local-master-launch.ts:93`，导出纯函数）——flag 与 positional **位置无关**；`--timeout` 的值显式排除后再取第一个非 flag token。这是 L4 必须修 M1 的修复（`f5a9b90`）：旧实现 `parts.find(p => !p.startsWith("--"))` 会把 `--timeout 5000 C:\repo` 的 `cwd` 取成 `"5000"`，若会话 cwd 下恰有同名目录就会**在错误仓开 tab 并静默认领该仓 scope**。

### 七态回执

`already-running | launched | ready | spawn-failed | timeout | invalid-cwd | stalled`（`local-master-launch.ts:119`）。`ensureResultIsError()`（`:152`）把 `invalid-cwd` / `spawn-failed` / `timeout` / `stalled` 记为错误态。要点：

- `already-running`：precheck 命中**活 owner**（attachment + liveness 同 sessionId 同 generation + `isProcessAlive(pid)`）→ 零 spawn、零状态写，顺手关掉历史 in-flight 窗口（幂等）。
- `invalid-cwd`：cwd 空或非目录 → **零 spawn、零状态写**（`ensureLocalMaster` 首个检查，`local-master-launch.ts:456`）。
- `spawn-failed`：wt/pi 缺席或 spawn 抛错 → **不自动重试**，删 marker；重调用等价手动重试。
- `timeout`：判据可判但到 deadline 未满足 → 带 attachment/liveness 快照，**不杀 tab**、不关窗口。
- `stalled`：**判据证据不足，不猜**（见下）。

### 就绪判据（严格；六条 + #A claim 观测）

`judgeLocalMasterEnsureReady()`（`local-master-launch.ts:171`）按序返回首个不满足的 reason：

1. `!liveness` → `no-liveness`（**最先判**）
2. `!attachment` → `no-owner`
3. `liveness.sessionId !== attachment.sessionId` → `identity-mismatch`
4. `liveness.generation !== attachment.generation` → `generation-mismatch`
5. `!isProcessAlive(liveness.pid)` → `owner-pid-dead`
6. `!(launchAt < liveness.updatedAt)` → `liveness-not-updated`（启动前写的心跳一律不算数）
7. **（#A 追加）** `attachment.generation > precheck 快照` 不成立 → `claim-not-observed`

- **拿不到 liveness 一律如实 `stalled`，不猜**：`ensureStatusForReason()`（`:187`）把 `no-liveness` / `no-owner` / `claim-not-observed` 归 `stalled`，其余归 `timeout`；回执文案明写「判据证据不足，不猜」并指引人工 `/master-attach --local --force-stale --confirm`（工具不代持该权力）。
- 第 7 条是 #A 的机器判据：盘面上唯一能证明"认领发生过"的稳定信号是 **generation 前进**（precheck 无 attachment 记 0，genesis 生成 1 恒前进），而新会话认领 ⟹ 消费循环随 `session_start` 注册（见下节）。六条全绿但 generation 未前进 = 有进程在写心跳、**没有证据表明消费侧就绪** → 不判 ready。只收紧不放松，任何路径都不会谎报 `ready`。
- `waitForReady=false` 直接回 `launched` 是显式 opt-out，不绕过判据。

### 零新增权力（核心边界）

- **生产代码零** `attachMaster` / `forceStale` / `token` / `cutover` / `detach` 调用；对 attachment **只读**（`local-master-launch.ts` 只 import `readAttachment`；文件内唯一的删除动作是自建 in-flight marker 的 `unlinkSync`/`rmSync`）。
- **不写 attachment、不代替 attach**：认领一律由新会话 `session_start` 的既有静默路径完成——这是**既有权力的既有路径**，本能力零新增。
- **bootstrap prompt**（`buildLocalMasterBootstrapPrompt()`，`:195`，5 行）：**不含 token**、**不指示 `forceStale`**、负向禁令「不要触碰全局 Master（`agent://master_default`），不要调用 master-attach/master-detach/master-transfer/master-cutover」，并要求先用 `/master-status` 核验 local 归属行，核验不过（no-liveness / 身份不匹配死角）**停在原地交还用户**。
- **免二次确认**（用户裁定）：不设 `confirm` 参数；门控靠四层合取 + 可见 tab + in-flight 防重 + 逐次审计 + precheck 幂等（活 master 时零动作）。等价命题：开一个新进程 ≈ 用户手动去那个仓开一个会话。

### 四层授权合取（缺一即拒，两入口同）

| 层 | 规则 | 落点 |
|----|------|------|
| ① 身份硬挡 | `isSubagent()` 在 execute/handler **首行**拒（`rejected:subagent`） | `master-tools.ts:769`、`index.ts:2209` |
| ① 纵深 | `DEFAULT_EXCLUDE_TOOLS` 含 `"local-master-ensure"`（headless 子 agent argv 恒加） | `runner-argv.ts:20-L27` |
| ② 调用者资格 | `localMasterEnsureGate()`（`master-tools.ts:314`）**复用 `masterDispatchGate` 同款口径**：main session 或 global master owner 放行；**tab 会话 / not-owner / 身份 unknown 拒**（含 spawn 前 `{sessionId,generation}` 双读 fencing） | `master-tools.ts:780`、`index.ts:2212` |
| ③ 参数面 | 只收 `cwd`（**不收 scope / agent 地址**，防指向混淆）；scope/地址由 `localMasterScope(cwd)` 派生；cwd 必须存在且为目录 | 工具 schema `master-tools.ts:748`、`ensureLocalMaster()` 层③检查 |
| ④ 授权语义 | 描述带 `USER_DIRECTIVE`（`master-tools.ts:219`：「仅在用户明确要求时调用；禁止自行决定接管/交接/切换。」）+ NO_COMPOSE 同款句「不可与 attach/detach/transfer 组合」；slash description 末尾补「仅在用户明确要求时使用」（L4-S5） | `master-tools.ts:746`、`index.ts:2195` |

### in-flight 防重

- 文件 `state/local-master-launch/<scope>.json`（scope 键按 `[^A-Za-z0-9._-]` 净化），`openSync(wx)` **排他创建 first-wins**（`claimLocalMasterLaunchMarker()`，`local-master-launch.ts:251`）。
- 窗口 = 首次认领时的 `timeout + 30s`（`ENSURE_IN_FLIGHT_EXTRA_MS`），且**落盘 `windowEndsAt` 以盘上值为准**——first-wins 的窗口属于**那次 spawn**，不由后续调用方的 timeout 现算（L4-S2 修复，`f5a9b90`；旧 marker 无该字段时按 `at + 本次 windowMs` 兜底等价旧行为）。
- 窗口内同 scope 重调 → `launched` + `inFlight:true` + `reason:"in-flight"`、**零第二个 spawn**（回执复用旧 `runId`）。
- 非 EEXIST 写失败（ENOTDIR/EACCES/ENOSPC…）→ **fail-closed 不认领**（L4-S1，宁可少开一个 tab；attachment 层 CAS 仍是最终单赢）。
- 关窗时机：`ready` / `already-running` / `spawn-failed`；`timeout`/`stalled` **不关**（窗口到期自失效）。

### 审计

`state/local-master-ensure-audit.jsonl`，**每次调用（含被拒）一行**，恰六字段 `{at, by, cwd, scope, action, result}`、**无正文**（`auditLocalMasterEnsure()`，`:360`；never-throw）。`result` 是受控枚举 `status[:reason]` 或 `rejected:<subagent|unknown-session|<gate.reason>|no-channel>`；spawn 原始错误串只进回执、不进审计。

### spawn 形状（可见 tab）

`index.ts:2494` `ensureLocalMasterTab`：`findWindowsTerminal`/`findPiCli`（缺席在生成 runId **之前**返回 error，零账本）→ `newTabRunId` → 账本 `dispatch`（`mode:"execute"`、taskId `lms-<scope>`）→ link `local-master=<scope>` → `spawnPiTab`（**可见 WT tab**、`cwd=目标仓`、prompt 物化；异步失败回写 `launch_failed`）。**不设 `PI_SUBAGENT`、不传 `--no-session`**（否则结构上无法 attach），prompt 是常驻 master bootstrap、**不经** `buildWorkflowTabPrompt` 的一次性纪律包装。可见性本身是安全特性：用户看得见新开了什么。

## #A：scope 消费循环注册语义（重要，含"手动 attach 不注册"）

1. **注册点唯一** = `mailbox-consumer.ts::registerScopeWakeLoop()`（`:503`），`pi.on("session_start")` 处理块内 `setInterval(tick, 30s)`（`:557`）；全仓生产侧接线**仅** `index.ts:1945` 一处。tick → `evaluateScopeWake` → claim → spawn 唤醒 tab → ack。`consumeMailboxOnce()` 的 recipient 恒 `masterAddress()`（`mailbox-consumer.ts:151`，只吃 `master_default` 域）——**scope 信箱的唯一写消费端就是这个 tick**。**wake 信 claim 生命周期（长期契约）**：`listScopeWakeLetters`（`scope.ts:274`）列出 `pending` + **stale claimed**（`claimedAt` 年龄 > `reclaimAfterMs`，缺省 10min，与 `mailbox.ts::claimLetters` 同口径；`now` 由 `evaluateScopeWake` 的 `opts.now` 透传；fresh claimed 排除防重复唤醒，`delivered`/`acked`/`expired` 不纳入）——spawn 失败残留的 claimed wake 信因此在 reclaimAfterMs 后重新可达，实际重领仍由 `claimLetters` 原子完成，不会永久不可达。
2. **认领 ⟺ 注册（同一 `session_start` 处理块内）**：无 attachment → `silentScopeGenesis(sid, cwd)`（`:537`）；有 owner 且非本会话 → `takeoverStaleScopeOwner(sid, cwd)`（`:540`，判据 = liveness 身份严格匹配 **且** pid 死；`no-liveness`/`identity-mismatch`/pid 活 → skip）；随后 `if (!att || att.sessionId !== sid) return;`（`:553`，**不注册**）→ 否则 `setInterval`（`:557`）。即认领成功 ⟹ 注册；严谨的逆表述是"**本会话是 owner ⟺ 注册**"（在位 owner 的第二次 `session_start` 也会注册而本轮并未新认领）。
3. **`triggerOwnershipRecheck()` 只补注册全局 watcher**：`event-bus.ts:121` 实现体只有 `startWatch?.()`（全局 result watcher），**从不触碰** `registerScopeWakeLoop`；`consumeMailboxOnce` 也不消费 `agent://master_local_*`。
4. **手动 `/master-attach --local` 不经过 `session_start` → 不注册消费循环**（工具 `master-tools.ts:521`、slash `index.ts:2125` 成功后都只调 `triggerOwnershipRecheck()`；L4 独立验证成立）。限定：若同一进程此后再次触发 `session_start`（resume/新会话）会在那时补注册——所以"收不到信"精确指 **attach 之后到下一个 `session_start` 之间（通常即整个会话生命周期）**。
5. **因此 ensure 的 `ready` 路径必然注册**：spawn 载体是当前代码加载的普通 pi 会话（可见 tab、非 subagent、非 `--no-session`）→ `session_start` 必触发该处理块；全新 sessionId 的认领**只可能**来自该块（无 attachment → genesis；pid 死僵尸 → takeover gen+1）→ 成功即紧跟注册；再加上第 7 条 claim 观测，凡不能证明认领一律 `stalled(claim-not-observed)`。
6. **机制解释（"信躺着"）**：owner 会话死了（例：computer-use 仓 pid 死）→ 没有任何活着的会话持该 scope 的 tick → 信箱里的信永远 `pending`。这不是投递失败，是**没有消费端在跑**；对 pid 死型僵尸调一次 ensure 即可恢复消费。

## 已知残余（诚实清单）

1. **in-flight 竞态残余**：`wx` 是进程层防线，窗口过期撞车（`timeout`/`stalled` 不关窗、到期后重调再抢）仍可能开第二个 tab——attachment 层 lease+CAS 仍是最终单赢，另一个变惰性冗余会话；且**没有全局并发/速率上限**（N 个目录 = N 个可见 tab + N 个进程），缓解只有四层合取 + 审计可回放 + 可见 tab。（L4 原记「窗口不落盘 / 按调用方 timeout 现算」已由 `f5a9b90` 的 S2 落盘 `windowEndsAt` 修复；仅无该字段的旧 marker 走 `at+本次 windowMs` 兜底。）
2. **僵尸 attachment 处置保守（只报不删）**：本能力零 attachment 删改/归档；`stalled` 只"能报就报"并指引人工 `/master-attach --local --force-stale --confirm`。计划的阶段二 `assumeStale+confirm` 与阶段三 `/master-registry-health` + 归档命令**未做**。
3. **claim 观测的极窄盲区（R3）**：轮询窗口内若**人工** `--force-stale` attach 或 transfer 后继 attach 推进 generation，盘面无法区分"session_start 认领"与"事后 attach" → 可能报 `ready` 而该 owner 其实不消费（与第 4 条叠加）。概率极窄（需人同仓同时操作）。
4. **`no-liveness` / `identity-mismatch` 僵尸救不回**：新会话 skip → 不认领 → 不注册 → ensure 只能如实 `stalled`，修 = 扩权，符合裁定。
5. **人工 attach 不注册消费循环是既有缺陷**（本能力未引入也未修复）；建议另案给 attach 成功路径补一次 scope 消费循环重注册（与全局 watcher 补注册同构），或落盘"消费端已注册"标记供机器判据读取。
6. **端到端真 spawn 手测未做**（计划 §3 验收第 3 项 / L4-S6）：需真实开 WT tab + 写真实 attachment，留用户一次性手测（建议对死仓如 `computer-use` 执行）。
7. **tab 回收交互未实测**（计划 Q4）：master-bootstrap tab 有 `tab-run-id`、无终态 → 可能被 `tab-status`/`reclaim-tabs` 标 orphaned/unconfirmed（transfer 后继同先例）。

## Evidence

- `extensions/runtime/local-master-launch.ts` — 头注「职责边界（零新增权力）」、`clampEnsureTimeout`(:68)、`parseLocalMasterEnsureArgs`(:93)、`LocalMasterEnsureStatus` 七态(:119)、`judgeLocalMasterEnsureReady`(:171 六条+claim 观测)、`ensureStatusForReason`(:187 stalled 不猜)、`buildLocalMasterBootstrapPrompt`(:195 五行)、`claimLocalMasterLaunchMarker`(:251 wx first-wins + `windowEndsAt` + fail-closed)、`auditLocalMasterEnsure`(:360 六字段无正文)、`ensureLocalMaster`(:437 编排)、`formatLocalMasterEnsureResult`(:568 回执文案)。
- `extensions/master-tools.ts` — `USER_DIRECTIVE`(:219)、`localMasterEnsureGate`(:314 复用 `masterDispatchGate`)、工具 `local-master-ensure`(:739 起：schema 只有 `cwd/waitForReady/timeoutMs`、execute 首行 `isSubagent`、双入口同门、审计 `ensure:tool`)。
- `extensions/index.ts` — slash `/local-master-ensure`(:2194，解析走 `parseLocalMasterEnsureArgs`、审计 `ensure:slash`)、spawn 通道 `ensureLocalMasterTab`(:2494)、`registerMasterTools` 注入(:2529)、scope 消费循环唯一接线(:1945)。
- `extensions/runner-argv.ts:20-L27` — `DEFAULT_EXCLUDE_TOOLS` 含 `"local-master-ensure"`。
- `extensions/mailbox-consumer.ts` — `registerScopeWakeLoop`(:503)、genesis(:537)/takeover(:540)/owner 判定(:553)/注册(:557)；`consumeMailboxOnceInner` recipient 恒 `masterAddress()`(:151)。
- `extensions/runtime/scope.ts` — `listScopeWakeLetters`(:274，pending + stale claimed > `reclaimAfterMs` 缺省 10min，fresh claimed 与 delivered/acked/expired 不纳入)、`evaluateScopeWake`(:331，`opts.now` 透传 `now`)；`extensions/runtime/mailbox.ts:213` — `claimLetters`（同 `reclaimAfterMs ?? 10*60*1000` 口径，原子重领）。
- 测试 `extensions/_test_local_master.ts` U5b（:473 起，script `npm run test:local-master`）— 首次 fire → fresh claimed 不重复唤醒 → `claimedAt` 拨至 11min 前 → stale reclaim 再次 fire、重领后 `claimedAt` 更新为当前时间。
- `extensions/event-bus.ts:121` — `triggerOwnershipRecheck()` 只 `startWatch?.()`（全局 watcher）；`extensions/master-tools.ts:521`、`extensions/index.ts:2125` — `master-attach` 成功只调它。
- 测试 `extensions/_test_local_master_launch.ts`（script `npm run test:local-master-ensure`）— **23 组断言块全绿**（2026-09-25 复跑）：四层逐层拒绝 / `already-running` 幂等 / invalid-cwd 零写 / in-flight F–F4（含 `windowEndsAt` first-wins、fail-closed）/ ready 与 stalled 不猜 / claim 观测 H / #A J1–J3 / 审计六字段 / K 组双入口 + 注册点静态耦合 / L 组 slash 解析 4 例。L4 变异 4/4 被捕获（`plans/0924_local_master_ensure_l4_review.md`，本地 gitignored）。
- 提交：`0586030`（feat，7 files）+ `f5a9b90`（fix：L4-M1 slash 参数解析 + S1/S2/S3/S4/S5/S7，3 files）。

## Links Out

- [[Local Master 认领与接管]]
- [[Wake 回信（round-trip 回执）]]
- [[Wiki 索引]]

## Backlinks

- [[Local Master 认领与接管]]
- [[Wake 回信（round-trip 回执）]]
- [[Wiki 索引]]

## Open Questions

- 授权档位（L2-Q1/Q6「能力即扩散面」）：本轮用户裁定**免二次确认**，但**无全局并发/速率上限**的根治（如 ask 档 / config 开关 `localMasterLaunch.confirm`）仍待裁定。
- 手动 attach 补注册 scope 消费循环（残余 5）与"消费端已注册"盘上标记——另案修法待排期。
- 无头常驻形态（L2-Q3）：可见 tab 占终端窗口，去 `--no-session`/`PI_SUBAGENT` 的专用启动 profile 会改身份矩阵，另案。
- 端到端真 spawn 手测（残余 6）与 master-bootstrap tab × `reclaim-tabs` 交互（残余 7）待人工执行一次。
