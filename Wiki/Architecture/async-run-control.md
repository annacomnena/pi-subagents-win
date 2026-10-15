---
title: 异步 Run 控制面（list / kill）
kind: concept
status: current
updated: 2026-10-16
source_paths:
  - extensions/subagent-zombie.ts
  - extensions/_test_subagent_zombie.ts
  - extensions/async-result-watcher.ts
  - extensions/subagent-kill.ts
  - extensions/index.ts#L1428
  - extensions/index.ts#L1665-L1684
  - extensions/index.ts#L1695-L1710
  - extensions/index.ts#L2981-L2983
  - extensions/index.ts#L3309-L3327
  - extensions/index.ts#L3361-L3368
  - extensions/external-cli.ts#L830-L833
  - extensions/links.ts#L33-L39
  - extensions/notify-windows.ts#L41-L53
  - extensions/spawn-trace.ts#L22-L24
  - extensions/_test_subagent_kill.ts
---

# 异步 Run 控制面（list / kill）

## Summary

异步 subagent（`subagent-win({ async: true })`，缺省即异步）的运行记录是 `~/.pi/agent/subagent-runs/<runId>.json`。此前要终止一个卡住的 run 只能自己去翻 PID 再 `taskkill`；本控制面把**观察**与**终止**并进既有 `subagent-win` 工具的 `action` 联合（**不新开工具**）：`action:"list"` 一眼看出谁卡住，`action:"kill"`（别名 `cancel`）按 runId **终止该 run 的整棵进程树**并落成 `status:"cancelled"`。

终止前有**双重安全校验**（pid 必须来自该 run 的派发登记；并向 OS 核对启动时间 + 命令行 marker 防 pid 重用误杀），缺一即拒杀；重复 kill / 已终态 / 进程已消失都走**幂等成功**。记录文件里的 `pid`/`pidRecordedAt`/`pidCmdMarker`/`lastActivity` 是控制面的数据底座。

## Current Contract

### 工具入口、签名与返回

| action | 参数 | 说明 |
|---|---|---|
| `"list"` | 无 | 列出**全局** async runs（**不按会话过滤**，便于发现任意卡住的 run） |
| `"kill"` / `"cancel"` | `runId?`、`reason?` | 终止该 run 的整棵进程树；`cancel` 与 `kill` 完全等价。`runId` 省略时取**本会话唯一的 running run**；`reason` 写入 run json 的 `killReason`（审计用） |

- `list` 排序：running 优先，其次按 `startedAt` 倒序，至多返回 20 条（`listAsyncRunSummaries(limit = 20)`）。无记录时一行 `No async runs found.`。
- `list` 行格式（每行一个 run）：
  `run_xxx  [agent] status  pid=NNN(dead?)  start=HH:MM:SS idle=Ns  <task 前 40 字>`
  - `pid=none` = 该记录无登记 pid（旧记录，或已被 kill/清理后 `pid*` 字段被删除）；
  - `(dead)` = 登记 pid 已不在（`isPidAlive` 为假）；
  - `idle=` = `now - lastActivity`，**只对 running 打印**，数值越大越可能卡住（脉搏见下）。
- `kill` 省略 `runId` 的便捷解析 `resolveSessionRun`：按 `links.jsonl` 中 `kind:"async"` 的派发记录归属过滤「本会话」（`sessionScopeKey()` / 当前 sessionId）。命中 0 个 → `isError`（提示先 `list` 再显式传 runId）；命中 >1 → `isError` 并列出候选（防错杀）。
- 返回即结果：成功/幂等成功都是 `isError: false`，`kill` 成功后顺带刷新 async panel。**kill 没有 steer 那样的落盘回执文件**——结果由工具返回，记录体现在 run json 上（口径差异见「与 steer 通道的口径对照」）。

### 终止语义：整棵树，只动该 run 的树

- Windows：`taskkill /PID <pid> /T /F`（`/T` = 连同后代，含子 agent 拉起的孙进程；30s 超时）；随后 `waitPidGone(pid, ≤3s)` 轮询确认（50ms 间隔），再落记录。
- POSIX：先尝试杀进程组 `process.kill(-pid, SIGKILL)`（外部 CLI 在 POSIX 以 `detached` 起新进程组），再 `ps -A -o pid=,ppid=` 遍历后代、自底向上 SIGKILL，最后杀 pid 自身。
- **只杀该 runId 登记过的那一个 pid 及其子树**；不扫描、不按进程名模糊匹配任何其它进程。用户自己独立开的程序不受影响。
- **如实标注**：`/T` 的语义是「该 pid 的后代」，因此**若用户程序恰好是该子 agent 进程树的子孙**（例如子 agent 自己拉起的 AutoCAD/Blender），会被一并终止。这是 tree-kill 的定义语义，已在工具 description 与模块头注明。

### 双重安全校验（缺一即拒杀）

1. **pid 归属**：kill 只接受该 runId 派发时写进 run json 的 `pid`（`registerRunProcess`，`extensions/index.ts#L985` 内部子进程取 `argv[0]` 作 marker；`external-cli.ts#L831` 外部 CLI 取命令路径）。进程内 `procRegistry` 仅用于脉搏节流与清理，**不构成 kill 依据**；更不接受「pid 存在就杀」。
2. **进程身份**（`verifyIdentity`）：向 OS 查该 pid 的 `inspectLiveProcess` —— Windows `Get-CimInstance Win32_Process -Filter "ProcessId=N"` 取 `CreationDate`(UTC ISO) + `CommandLine`；POSIX 用 `ps`。两项**都必须通过**：
   - 命令行**必须**包含登记 marker（大小写不敏感）；marker 缺失、命令行不可得 → 拒；
   - 启动时间必须落在登记时刻的容差窗口 `[-5min, +3min]`（`START_TOLERANCE_EARLY_MS = 300_000` / `START_TOLERANCE_LATE_MS = 180_000`；容忍时钟偏差与慢启动），窗口外 → 拒；
   - 二者任一不成立都**在调用 taskkill 之前**返回错误，**绝不误杀**。

### 幂等与状态机

`AsyncRunRecord.status ∈ running | completed | failed | cancelled`。kill 的判定顺序与结果：

| 场景 | 返回 | `isError` |
|---|---|---|
| running，校验通过，树杀成功 | `ok:true, code:"killed"`（`killedPids:[pid]`） | false |
| run 已 `cancelled` | `ok:true, code:"already_terminal"`（幂等，不再重复杀） | false |
| `completed`/`failed` 且登记 pid 不存在或已不活 | `ok:true, code:"already_terminal"` | false |
| `completed`/`failed` 但登记进程**仍在**（孤儿） | 仍走安全校验并树杀；**保留原终态**（`preserveTerminal`），只写 kill 元数据 | false |
| 记录仍 running 但 pid 已消失（含检查中消失） | 落 `cancelled`（终态则保留原终态），`alreadyDead:true` | false |
| `runId` 不存在 | `code:"not_found"` | **true** |
| running 但无 `pid`（本能力上线前的旧记录） | `code:"no_pid"`（无法安全定位，宁可不杀） | **true** |
| marker / 启动时间不匹配（pid 重用） | `code:"pid_reused"` | **true** |
| 进程活着但身份查询不可达 | `code:"identity_unknown"` | **true** |
| `taskkill` 失败 | `code:"kill_failed"` | **true** |

选择依据：**「终态已无关可杀」走幂等成功**（重复调用不产生噪音、不打断工作流）；**「无法证明归属/身份」走 `isError`**（安全优先，宁可不杀也不误杀）；**runId 不存在走 `isError`**（调用方 bug，应显式暴露）。

kill 成功（非 preserveTerminal）后落盘：`status:"cancelled"` + `killedAt`(ISO) + `killedBy`(缺省 `"tool:subagent-win"`) + `killReason?`，`lastActivity` 置为 `killedAt`，并写一个 `status:"cancelled"` 的占位 `result`（`error: "killed by user (…)"`）；随后删除 `pid`/`pidRecordedAt`/`pidCmdMarker`（故 kill 后 `list` 显示 `pid=none`）。

**竞态保护**：kill 会使子进程 close → 完成回调 `.then` 回写 `result`，可能早于落 `cancelled`。故在 `taskkill` **之前**先把 kill 意图写入进程内 `killedRuns`，`.then` 里的 `applyKillOutcome` 据此强制保留 `cancelled`；`taskkill` 失败则回滚该意图。

### 脉搏（lastActivity）

`touchRunActivity` 由 async 派发的 `onUpdate` 心跳触发，但**只在距上次落盘 >5s 时写文件**（`ACTIVITY_PERSIST_INTERVAL_MS = 5_000`），因此 `list` 的 `idle` 有最多 5s 的粒度误差。它是「谁卡住」的唯一判据来源（`lastActivity` → `pidRecordedAt` → `startedAt` 逐级回退）。

### config.json 未枚举顶层键的往返保留

- 事实：`readConfig()` 先展开解析结果、再用归一化后的 7 个枚举键（`models`/`fallbackModels`/`thinking`/`notifications`/`searcherMode`/`liteMode`/`masterSuccession`）覆盖（`extensions/index.ts#L268` 的 `...parsed`）；`writeConfig` 仍是整对象 `JSON.stringify` + tmp+rename 原子写。此前**任一**命令的 read→write 往返都会抹掉未枚举顶层键。
- 影响：真实 `config.json` 里由**其它 owner** 持有的顶层键（`gui`/`channels`/`autonomy` 等）不再被本扩展的配置往返丢掉；枚举键的行为逐字节不变（仍归一化覆盖；脏枚举值原样透传是既有行为）。文件不存在或坏 JSON 仍回落纯缺省（无键可保留）。
- 仍未覆盖：`masterSuccession` **切片内**的未知键仍会丢；跨进程 read-modify-write 的 lost update 仍存在（非本控制面范围）。

### 僵尸看门狗（失败必达终态 · 宿主侧兜底）

**问题（2026-10-15 真实事故）**：6 个 async run 挂在 `running` 而 pid 已死（idle 9h+）⇒ 上游会话
**死等 100 分钟**，最后人工 `kill` 才解开。根因：**`running` 没有任何超时/僵尸出口**——
watcher 只处理**已进终态**的 run（`status ∈ {completed,failed,cancelled}`），死进程产生的
`running` 记录**不在任何人的视野内**。

**模块**：`extensions/subagent-zombie.ts`（新增）。**纪律：只落状态、绝不杀进程**
（进程已死才判 zombie；杀进程是 `subagent-kill` 的取权，三道门一字未改）。

**判定（以「活进程证据」为主，不以「字段缺失」为主）**：

| 分支 | 条件 | 证据强度 | 动作 |
|---|---|---|---|
| `pid-dead` | `pid` 存在 ∧ signal-0 判死 | **硬** | 落 `failed(zombie)` |
| `pid-reused` | `pid` 活但启动时间不在登记容差窗口（前 5min/后 3min）| **硬** | 落 `failed(zombie)` |
| `no-pid-idle` | 无 `pid` ∧ `lastActivity` 超 2h | **弱** | 默认**只写** `.zombie-suspect`；`PI_SUBAGENT_ZOMBIE_AUTO=1` 才落终态 |

全部前置：`status==="running"` ∧ 年龄 ≥ `ZOMBIE_MIN_AGE_MS`(120s) ∧ 无终态（含 `result.status`）。
**为何不能靠字段缺失判死**（L4 审查关键事实）：`subagent-kill` 的 `markKilled()` 会
`delete pid/pidRecordedAt/pidCmdMarker` 并刷新 `lastActivity` ⇒ **事后 json 的 pid 缺失不代表当时缺失**。

**触发（双路，复用既有设施）**：
- **on-read 惰性**：`subagent-win({action:"status"|"list"})` 查询前先收口（等待方不必等 tick）；
  **按会话归属收窄**（`scopedRunIds()`，与 `resolveSessionRun` 同口径）⇒ 不回收他会话的 run。
- **周期 tick**：复用 `async-result-watcher` 既有 10s tick（**不新增定时器**）；`skipInspect:true`
  避免在同步回调里跑 PowerShell（单次可阻塞 ~20s）；`limit:50` 防无界扫描。

**幂等：持久 claim + 显式恢复（第 5 代，四代被推翻后的收敛）**

`.reaped` 是 **永久** claim（`writeFileSync(..., {flag:"wx"})` 排他创建）。
**语义 = 「至多一个非-force 赢家」，不声称 exactly-one。**

演进史（每一代都被独立 L4 给出可复现时序推翻，全部留痕于 `plans/20261016_subagent_zombie_l4_review{,2,3,4}.md`）：

| 代 | 实现 | 被推翻的原因 |
|---|---|---|
| 1 | `rmSync + writeFileSync(wx)` | 两步之间可删他人新锁 |
| 2 | 仅 `renameSync` 移走视为原子 | A 可能移走 B 刚建的新锁（路径存在即成功）|
| 3 | + token 核对 +「放回」 | **Windows 上 rename 会覆盖已存在目标**（实测）⇒ 抹掉第三方锁 |
| 4 | 独立 `.reaping` 接管锁 + TTL | TTL **会回收仍在工作的接管锁**（owner 暂停超过 TTL）|
| **5** | **永久 claim + `force` 人工恢复** | —— 结构上排除双赢家 |

**根本结论**：一个「标记 + TTL」的看门狗**无法用「过期无主文件」安全实现 owner 回收**
（那需要 fencing token；纯文件系统原语给不出）。故采纳 L4 建议：
**simplify to permanent `wx` claim + explicit/manual stale recovery**。
代价：赢家崩溃停在 claim 后会**永久卡住**，需人工 `reapZombie(id, {force:true})`。

**降级保障（不用于掩盖双赢家）**：`reapZombie` 写终态前**重读**（顶层 `status` + `result.status`），
已终态则短路 ⇒ 「真完成永不被覆盖」。

**失败分类投影**：async 注入正文带 `失败分类: kind=… source=… model=… http=…`（读新 `failure` 字段）；
`failure{kind,provider,model,httpStatus,message,at,source}` + `endedAt` 写入 run json。

**可测性 env**：`PI_SUBAGENT_ZOMBIE_MIN_AGE_MS`(120s) / `PI_SUBAGENT_ZOMBIE_IDLE_MS`(120s) /
`PI_SUBAGENT_ZOMBIE_NO_PID_IDLE_MS`(2h) / `PI_SUBAGENT_ZOMBIE_AUTO`(=1 才让弱证据落终态)。

**相关修复（同批）**：`index.ts` 的 `stopReason==="error"` 分支原先只置 `failed` + `continue`
⇒ 子进程不退出、上游无限等；现按 `classifyModelFailure` 判为不可恢复（`usage_cap`/`auth`/`!retryable`）
时**回调 `onFatalFailure` → kill 子进程**。另修 `close` 中 `stderrBuf` **提前清空**导致
provider 错误/额度线索丢失（GLM 套餐提示多在 stderr）。

### 可测试性 env 一览

| env | 作用 | 缺省（未设时语义逐字节不变） |
|---|---|---|
| `PI_SUBAGENT_RUNS_DIR` | async run json 目录；`list`/`kill`/`status`/派发记录的共同来源 | `~/.pi/agent/subagent-runs`（模块加载时读一次） |
| `PI_LINKS_PATH` | 派发溯源账本 `links.jsonl` 路径（`defaultLinksPath`） | `~/.pi/agent/links.jsonl` |
| `PI_SUBAGENT_USAGE_DIR` | 用量账本目录 | `~/.pi/agent/subagent-usage` |
| `PI_RUNTIME_DIR` | runtime 根（journal/receipts）与 spawn 取证 `<root>/tmp/spawn-trace.log` | `~/.pi/agent`（+ `tmp/spawn-trace.log`） |
| `PI_NOTIFY_DISABLE` | `=1` 时 `sendWindowsToast` **首行**早退：不弹窗、不派生 `powershell.exe`、不落 toast 取证 | 未设即正常弹窗 |
| （既有，非本次新增）`PI_SPAWN_TRACE` | `=0` 关闭 spawn 取证 | 未设即记录 |

**纪律：跑测试必须零写真实 `~/.pi/agent/**`。** `_test_subagent_kill.ts` 在 `await import("./index.ts")` **之前**把上表前 4 个目录指向 `mkdtemp`、设 `PI_NOTIFY_DISABLE=1`，跑完递归清理；并以「临时 links 有新行、临时 usage 有文件、临时 toast trace 行数 ≤0」自证改道生效、`toastSpawns > 0` 即判 FAIL。**曾有的反例**：修前负对照实测该测试会真实追加 `links.jsonl` +1 行、`subagent-usage/<day>.jsonl` +1 条，并真的派生 `powershell.exe` 弹一个「❌ subagent 异步失败」toast；隔离修复后同一指纹前后逐项零变化（除常驻 pi 进程自身写入）。

## 已知限制 / UNKNOWN

1. **身份校验的容差窗口**（`[-5min, +3min]`）：监控 pid 在窗口外被重用必然拒杀；理论上 pid 在窗口内被重用、且新进程命令行恰好也含同一 marker（例如同一 PI CLI 脚本路径）时会误判为「同一进程」——未做压力实证，属**已知残余风险**，不是已证实的缺陷。
2. **脱离进程树的孙进程可能漏杀**：Windows `taskkill /T` 沿父链枚举后代，若后代自行 `detached`/新建进程组、或父进程先退出导致 re-parent，该后代可能不在树内。POSIX 分支先杀进程组可缓解；Windows 无等价保证。**未实测**。
3. **外部 CLI 后端未端到端**：`cli:claude`/`cli:codex`/`cli:agy`/`cli:atomcode`/`cli:zcode`/`cli:mimo` 已接 `onChildSpawn` 登记 pid + 走同一 `taskkill /T`，但本机未安装这些 CLI，**端到端集成测试未做**（仅 `smoke:extension-load` 覆盖接线）。
4. **POSIX 分支未实测**：进程组 + 后代遍历 SIGKILL 的路径在 Windows 开发机上无法执行。
5. **跨宿主重启**：kill 依据是 run json 里登记的 pid + OS 身份基线（跨重启仍可查），但「保留 cancelled 不被 `.then` 覆盖」的 `killedRuns` 是**进程内**状态；宿主重启后旧 run 若仍 running、子进程成孤儿，kill 仍能按 pid+身份校验树杀并落 `cancelled`（此路径无 `.then` 可覆盖，语义正常）——**未实机演练**。
6. **`PI_SUBAGENT_RUNS_DIR` 非全仓单一口径**：`async-panel.ts#L40` 与 `gc-cleaner.ts#L53` 仍硬编码 `~/.pi/agent/subagent-runs`。生产环境设了该 env 时 panel/gc 会与之漂移（gc 甚至可能清理真实目录）；本控制面自身口径单一（`subagent-kill.ts#L38` → `index.ts#L150`）。
7. **旧记录不可杀**：本能力上线前派发、无 `pid` 字段的 run 只能返回 `no_pid` 安全报错，仍需手工处理。
8. **僵尸看门狗的未覆盖面**（Item 52 新增）：
   - **等待仍无界（P0，可分离议题）**：本看门狗只覆盖「僵尸」，**不提供端到端等待预算**——
     持续输出的活进程 / external CLI / fallback 链仍无墙钟总上限（`timeoutMs` 是 stall 语义，
     有输出就重置）⇒ **不得宣称整体失败等待有界**。
   - **无 pid 僵尸默认不自动终结**：只写 `.zombie-suspect`；这是有意的保守边界（见上文判定表）。
   - **`force` 无产品级入口**：`reapZombie(...,{force:true})` 仅在导出 API，尚无 CLI/工具包装 ⇒
     永久 claim 的崩溃残留目前需开发者手工调用。
   - **`force` 不保证排他**：多个 `force` 或 force 与在飞 claim 交错时可能多个返回 true
     （属显式绕过人工路径的边界，非自动路径保证）。
   - **跨进程僵锁竞态未做受控交错测试**：Z3 仅烟雾级（两真进程竞争）；无「暂停 owner 跨 TTL」的
     确定性用例（第 5 代已无 TTL 接管路径，该用例随之失效并被删除）。
8. **测试隔离纪律的已知缺口（非本控制面范围）**：`_test_async_panel.ts` 仍可经 `notifyAsyncCompletion` 弹真实 toast（可用 `PI_NOTIFY_DISABLE=1` 抑制，测试 runner 未统一设置）；`_test_readconfig_preserve_keys.ts` 会临时改写真实 `config.json` 字节（`finally` 还原，被 SIGKILL/硬超时打断的窗口内会留下夹具配置）。

### 已实证（勿拔高、也勿贬低）

- **Windows 真实进程树树杀已实证**：集成测试真实 `spawn` 一个必挂住的子进程 + 一个孙进程，`action:"list"` 可见、`kill` 后 stub 与孙进程都消失、记录落 `status:"cancelled"`/`killedBy`、二次 kill 幂等、未知 runId 报错、marker 不匹配拒杀且无关进程存活、无 pid 与终态幂等，全部通过且无残留进程。
- 冻结树上由独立复审复跑 `test:subagent-kill`：`EXIT=0`、`cleanup ok: no leftover processes`。
- 上述 1–5 仍是**未覆盖面**，不在「已实证」之内。

## 未证实（UNKNOWN）清单

1. **U-CLI**：外部 CLI 后端的端到端 kill（见限制 3）。
2. **U-POSIX**：POSIX 进程组/后代遍历分支（见限制 4）。
3. **U-RESTART**：跨宿主重启后的孤儿 run kill 演练（见限制 5）。
4. **U-DETACH**：脱离进程树的孙进程是否漏杀（见限制 2）。
5. **U-REUSE**：容差窗口内 marker 相同的 pid 重用误判概率（见限制 1）。
6. **U-RUNNER**：`PI_NOTIFY_DISABLE` 是否在测试 runner 层统一设置（当前仅 kill 测试自设）。

## 人工端到端手测清单（补充 UNKNOWN）

> 目标：独立复核者按步可照做、每步有预期观察点。**只在新建的测试 run / 测试机上做**。

1. **U-CLI（外部 CLI e2e）**：在装有 `cli:codex`（或其它）的机器上派发一个会挂住的外部 CLI 长任务 → `subagent-win({ action: "list" })` 应显示该 run 与 `pid=NNN` → `kill` → 预期该 CLI 进程及其孙进程从 `tasklist` 消失、记录 `status:"cancelled"`、`killedBy="tool:subagent-win"`。
2. **U-POSIX**：在 Linux/macOS 上跑 `npm run test:subagent-kill` → 预期 `ALL PASS`，且日志/记录显示走 `killed tree:`（进程组 + 后代遍历）路径。
3. **U-RESTART**：派发一个长 async run → 重启宿主 → `list` 仍应显示该 run（running）与 pid → `kill` 应安全树杀并落 `cancelled`。
4. **反向误杀防护**：手工把某 run json 的 `pidCmdMarker` 改成不匹配值 → `kill` 应 `isError` + `code:"pid_reused"`，且目标进程**仍存活**。

## 与 steer 通道的口径对照（一致性检查）

对照 [[Steer 通道（立即插入消息）]]：

- **命名不混用**：本面讲 async **run 记录**的 `status ∈ running | completed | failed | cancelled`；steer 讲**回执记录**的 `status ∈ pending | delivered | aborted | failed | undelivered`。两者都是「运行中对象的控制面」，但载体、字段、终态词各成一套，**不要互相套用**。
- **失败语义不同且各自自洽**：steer 的失败落到回执文件（`failed` + `error`）；kill 的失败是**工具返回** `isError:true` + `code`（`not_found`/`no_pid`/`pid_reused`/`identity_unknown`/`kill_failed`）。kill 无独立回执文件——这是有意的（无异步接收方，调用方就在同一次工具调用里拿到结果）。
- **共用的安全取向一致**：与 steer 的「写前守卫、拒绝而非写后清理」「无法证明即拒」同源——kill 在 `taskkill` 之前完成归属 + 身份校验，任一不成立即拒杀。
- **范式一致**：本页沿用同一「Summary → 合同 → 已知限制 → 未证实（UNKNOWN）清单 → 人工端到端手测清单 → Evidence → Links Out/Backlinks → Open Questions」骨架，与 steer 通道页可并列阅读。

## Evidence

- `extensions/subagent-kill.ts` — `DEFAULT_RUNS_DIR`(:38)、`START_TOLERANCE_EARLY_MS`/`LATE_MS`(:127–128)、`ACTIVITY_PERSIST_INTERVAL_MS`(:130)、`isPidAlive`(:151)、`inspectLiveProcess`(:166，Windows `Get-CimInstance Win32_Process` :170)、`killProcessTree`(:202，Windows `taskkill /PID /T /F` :204；POSIX 进程组 :220 + 后代遍历 :235)、`registerRunProcess`(:267)、`clearRunProcess`(:288)、`touchRunActivity`(:293)、`isRunKilled`(:313)、`applyKillOutcome`(:321)、`listAsyncRunSummaries`(:357，limit=20 / running 优先)、`formatRunList`(:409)、`verifyIdentity`(:423)、`markKilled`(:458，preserveTerminal + 删除 pid 字段)、`waitPidGone`(:490)、`killAsyncRun`(:511，判定顺序与 `KillResult.code` union :73–84)、`procRegistry`/`killedRuns`(:122/:124)。
- `extensions/index.ts` — `RUNS_DIR = DEFAULT_RUNS_DIR`(:150)；`USAGE_DIR` env(:1428)；`AsyncRunRecord`(:1665，`cancelled` + pid/killed 字段 :1669–1682)；`resolveSessionRun`(:1695)；工具 description(:2955–2957)、参数 `action`/`reason`(:2981/:2983)、`renderCall` kill/list 分支(:3012/:3015)、`list` 处理器(:3310)、`kill`/`cancel` 处理器(:3314–3325)；异步派发登记与收尾 `onChildSpawn`/`applyKillOutcome`(:3363–3368 单发、:3443–3450 并行)；内部子进程 marker `argv[0]`(:985)；`readConfig` 的 `...parsed`(:268)。
- `extensions/external-cli.ts` — `onChildSpawn` 类型与调用点(:70/:805/:831)；外部 CLI POSIX `detached`(:~830)。
- 隔离/配置口：`extensions/links.ts#L34`（`PI_LINKS_PATH`）、`extensions/notify-windows.ts#L42`/`#L52`（`PI_NOTIFY_DISABLE` 首行早退）、`extensions/spawn-trace.ts#L22`（`PI_RUNTIME_DIR`）。
- 测试：`extensions/_test_subagent_kill.ts`（真实进程树 + 孙进程、`list`/`kill`/安全反向用例、env 隔离与 toast 守卫、清理）；脚本 `npm run test:subagent-kill`。

## Links Out

- [[Wiki 索引]]
- [[Steer 通道（立即插入消息）]]（同为「运行中对象」的控制面：回执落盘 vs 工具返回，可对照其守卫/失败语义）

## Backlinks

- [[Wiki 索引]]
- [[工具调用可观测与循环判定]]（复用本页 `killAsyncRun`）

## Open Questions

- 是否给 `list` 增加「脉搏超时自动判死」：`idle > 2×timeoutMs` 时提示或自动调用同一 `killAsyncRun`（当前 `list` 只暴露 `idle`，不自动动手）。
- `run json` 是否补 `finishedAt`/`killable` 显式字段（当前终态 TTL 用文件 mtime）。
- 外部 CLI 是否统一「Windows 也建进程组 + 后代遍历」做双保险，避免 `/T` 的父链依赖（见限制 2）。
- `PI_SUBAGENT_RUNS_DIR` 是否全仓统一到单一常量（见限制 6）。
