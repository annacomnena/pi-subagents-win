---
title: 子代理模型解析 / fallback 链 / 用量账本
kind: concept
status: current
updated: 2026-10-22
source_paths:
  - extensions/index.ts#L858-L875
  - extensions/index.ts#L2065-L2092
  - extensions/index.ts#L2184-L2220
  - extensions/runtime/session-usage.ts
  - extensions/runtime-host/server.ts#L2042-L2057
  - extensions/gc-cleaner.ts#L100-L122
  - extensions/index.ts#L427-L490
  - extensions/index.ts#L521-L546
  - extensions/index.ts#L633-L679
  - extensions/index.ts#L881-L915
  - extensions/index.ts#L1248-L1263
  - extensions/index.ts#L1274-L1420
  - extensions/index.ts#L2035-L2092
  - extensions/index.ts#L2184-L2220
  - extensions/index.ts#L1757
  - extensions/index.ts#L1603
  - extensions/index.ts#L2343-L2347
  - extensions/runner-argv.ts#L70
  - extensions/index.ts#L253-L254
  - extensions/index.ts#L258-L308
  - extensions/index.ts#L3137
  - extensions/index.ts#L3399
  - extensions/index.ts#L4132
  - extensions/tiers.ts
  - extensions/identity.ts#L95-L97
  - extensions/runner-argv.ts#L67-L90
  - extensions/model-presets.ts#L39
  - extensions/model-presets.ts#L64-L65
  - extensions/model-presets.ts#L102-L103
  - extensions/model-presets.ts#L207-L208
  - extensions/index.ts::runWithFallback
  - extensions/index.ts::SAME_MODEL_RETRY
  - extensions/index.ts::SAME_MODEL_NEVER_RETRY
  - extensions/index.ts::resolveSameModelRetryMax
  - extensions/index.ts::sleepAbortable
  - extensions/index.ts::describeSameModelRetries
  - extensions/index.ts::fallbackChainText
  - extensions/_test_model_retry.ts
  - extensions/_test_model_failure_classify.ts
---

# 子代理模型解析 / fallback 链 / 用量账本

## Summary

`subagent-win` 派发一条子代理时，模型从「call override → agent frontmatter → config.json.models → 展开 fallback 链」逐级解析，最终由 `runWithFallback` 试跑：**每个候选先在自己的 model 上有界重试**（默认额外 2 次、递增退避 30s/60s），耗尽后才换下一个 fallback 候选；**候选集展开后、任何 spawn 之前**再过一道 costTier 派发门（角色区间 × 模型成本层级，见 §8），每次真实尝试都写一条用量账本。本页是这条链路的稳定事实底座（costTier 派发门、`/tiers usage` 聚合、USAGE_CAP 指引改造都挂在这条链上）。

## Current Contract

### 1. 模型解析（call seam）

- `normalizeModelRef` (`extensions/index.ts#L427-L490`)：自由文本 → `provider/id`，或 `cli:<backend>`；从 `~/.pi/agent/models.json`（`loadLocalModelCatalog`，失败回落 `~/.pi/models.json`）做模糊匹配；**唯一**高置信匹配才展开，多匹配抛 `Ambiguous model alias`，零匹配原样返回。已含 `/` 视为 canonical 直通。
- `agentDefaultModel` (`extensions/index.ts#L521-L525`)：`agent.frontmatterModel ?? readConfig().models[agent.name]`（config 每次现读，改配置无需重建 agent）。
- `resolveCallModel` (`extensions/index.ts#L531-L534`)：`normalizeModelRef(override) ?? agentDefaultModel(agent)` —— **call-site override 最高优先**。
- 最终生效模型在 `runSingle` 落定：`const resolvedModel = model ?? agentDefaultModel(agent)`（`extensions/index.ts#L928`），随后 `buildPiArgv` 产出 `--model`（`extensions/runner-argv.ts#L67-L82`）。

### 2. fallback 链消费与 `tried_models`

- 消费点 `runWithFallback` (`extensions/index.ts#L1274-L1420`)：
  - 读 `readConfig().fallbackModels[agent.name] ?? []`（`#L1298`），逐个 `normalizeModelRef`，与 primary `[...new Set([primary, ...fallbacks])]` 去重成 `candidates`（`#L1311`）。
  - **costTier 派发门插在候选集展开之后、spawn 之前**（`#L1313-L1348`，见 §8.4）。
  - 外层顺序 for 循环逐个候选（`runWithFallback`，`extensions/index.ts::runWithFallback`）；`tried.push(candidate)` **每候选只一次**，`result.triedModels = [...tried]`（紧随其后，均在 `runSingle` 调用前）。
  - **内层同模型有界重试**（`index.ts::runWithFallback` 内层 `for (let attemptNo = 1; ; attemptNo++)` 循环，2026-10-18 新增）：同一候选先在自己的 model 上重试至多 `resolveSameModelRetryMax()` 次（默认 2，`index.ts::resolveSameModelRetryMax`），耗尽后才走外层 fallback 判断。
    - 判据 `canRetrySame`（`index.ts::runWithFallback` 内 `const canRetrySame`）= `cls.retryable && !SAME_MODEL_NEVER_RETRY.has(cls.kind) && !signal?.aborted && sameRetries < max`。**黑名单再挡一次**（`index.ts::SAME_MODEL_NEVER_RETRY` = `wall_budget|stall|auth`）：`classifyModelFailure` 对 `auth` 返回 `retryable:true`（既有语义，不改），所以 auth 只能靠这张显式黑名单挡住。
    - 退避 `SAME_MODEL_RETRY.backoffMs(n) = min(30s·n, 60s)`（`index.ts::SAME_MODEL_RETRY`，遵守 AGENTS R-7b「同一 provider 连败冷却 ≥30s」）；`usage_cap` 乘 `usageCapMultiplier=2`（60s/120s，额度型恢复更慢）。
    - 退避 `sleepAbortable`（`index.ts::sleepAbortable`）**可被 signal abort 打断**（clearTimeout + removeEventListener 双清）；被中断 ⇒ 终态 `cancelled`、不再 spawn、不睡满 30s。
    - 每次重试前先 `onUpdate("⟳ 同模型重试 n/max（LABEL）")`（先报后睡，TUI 不用等退避完才可见）。
    - 每次尝试的 `usageEvents` 全部并入 `allUsageEvents`（`index.ts::runWithFallback` 内层循环首部）⇒ 重试不丢计费。
    - 耗尽且有重试时，`result.error` 追加 `describeSameModelRetries()`（`index.ts::describeSameModelRetries`）记录块：`retries=<n>/<max>` + `[1][2][3]` 逐条原始错误 + 建议。**原始 error 串保留在最前。**
  - 外层继续条件：本轮（含重试耗尽）仍失败且 `isRetryableModelFailure`（= `classifyModelFailure(...).retryable`，定义 `index.ts::isRetryableModelFailure`）且还有下一候选；否则 `withAllAttemptUsage` 收口。
  - 失败轮把 `{model, kind, error}` 记入 `priorFailures`；**只有重试条目（attemptNo > 1）才追加 `attempt: n`**（`AttemptFailure.attempt?`，`index.ts::AttemptFailure`）——首次尝试形状与引入重试前逐字节一致，`maxSameModel=0` 时零行为变化。
  - **`current` 语义**：`retryable:true` 现在有两层含义 —— ①同一 model 上有界重试 ②耗尽后可试下一候选。`general` 不在 `config.json` 的 `fallbackModels` 里（用户裁决：不给 general 加 fallback 链，模型由用户/主 agent 动态指定）⇒ 候选数 1 ⇒ 只靠内层重试自愈瞬时故障。
  - 前置条件（`maxSameModel=0` 或 env `PI_SUBAGENT_RETRY_MAX=0`）：完全回退旧行为，只 spawn 一次、不包装 error。
  - 重试上限钳制：`resolveSameModelRetryMax()`（`index.ts::resolveSameModelRetryMax`）clamp 到 `[0,4]`，禁止无限重试；env `PI_SUBAGENT_RETRY_MAX` / `PI_SUBAGENT_RETRY_BACKOFF_MS` 是**测试缝隙**（照 `PI_MODEL_COST_TIERS_PATH` 风格，不改 `config.json`），非法值忽略。
- `SubagentResult.triedModels` / `priorFailures` / `requestedModel` 定义见 `extensions/index.ts#L661-L679`。
- 调用方（全部走 `runWithFallback`）：sync 单发；async 单发；sync 并行（`runParallel`）；async 并行。
- **同模型重试 ≠ 候选回退**：`fallbackChainText`（`index.ts::fallbackChainText`）把连续同 model 的失败段合并成 `✗(KIND；同模型重试×N)`；`sameModelRetryFailure`（`index.ts::sameModelRetryFailure`）/`hasActualFallback`（`index.ts::hasActualFallback`）让 TUI 与主-agent 文案只在**真的换了 model** 时才说 fallback / `↺fallback×N`。否则 3 次同模型重试会显示成「试了 3 个不同模型」，误导主 agent 判断。

### 3. 失败分类与主-agent 指引

- `classifyModelFailure` (`extensions/index.ts::classifyModelFailure`)：返回 `{retryable, kind, label}`；kind ∈ `usage_cap|rate_limit|auth|provider|provider_network|timeout|stall|wall_budget|other`。Zhipu/GLM 家族 + 429/quota 措辞 → `USAGE_CAP`（retryable）。
  - 连接类（`terminated` / `socket hang up` / `50x no body` / **`Connection error.`**）→ `provider_network`（retryable）；此前落 `other`(retryable:false) 会触发 `runSingle` 的 fatal 门（`!retryable ⇒ onFatalFailure`）⇒ 子进程被立即 SIGTERM、零重试零产出（R-7b 同源事故）。
  - `wall_budget` / `stall` → retryable:**false**（换模型也救不回）；`auth` → retryable:**true**（既有语义，同模型重试层面靠 `SAME_MODEL_NEVER_RETRY` 显式挡）。
  - 注意：retryable 不等于「会重试」——最终是否重试取决于 `SAME_MODEL_NEVER_RETRY` 黑名单 + 剩余额度（见 §2）。
- `formatFailureForMainAgent` (`extensions/index.ts#L384-L419`)：拼 `[subagent-failure kind=...]` 块 + `tried_models=` + `ACTION_REQUIRED`。
- 主-agent 指引字符串注入点（均已改为同层替身口径，见 §8.6）：`formatFailureForMainAgent` 内 `#L436-L442`；注入主会话上下文 `before_agent_start` note `#L2928`；同步并行 USAGE_CAP 汇总头 `#L3712`；单发失败正文注释 `#L3804`。

### 4. 用量账本

- 目录：`USAGE_DIR = process.env.PI_SUBAGENT_USAGE_DIR ?? ~/.pi/agent/subagent-usage`（`extensions/index.ts#L1428`）。
- 按**本地日**切分文件：`localDayBounds` (`#L1439-L1447`) → `dailyUsagePath` = `<USAGE_DIR>/<YYYY-MM-DD>.jsonl`（`#L1449-L1452`）。
- 写入 `recordUsage(agent, result)` (`extensions/index.ts#L2065-L2092`)：对 `result.usageEvents` 逐条 append。v2 行结构：
  `{version:2, id, runId, ts, agent, model, usage:{input, output, cacheRead, cacheWrite, cost, turns}}`。
  每个事件按其**自身 assistant 消息 ts** 落到对应本地日文件（run 跨日也正确归属）。事件为空时退一条 `${result.runId}:empty` 占位行（`#L2068-L2073`）。
- **两个 id 体系并存（关键 join 约束）**：账本行的 `runId` 字段是 **`dispatchRunId = randomUUID()`**（`index.ts#L1757`，由 `withAllAttemptUsage` 赋给 `result.runId`，`#L1603`），**不是** run json 的文件名 `run_<ts>_<rand>`（`index.ts#L4414`）。实测（2026-10-22 复核，分母 153 份 run json）：`result.runId == 文件名 id` 仅 **13/153**（且这 13 份全是 12 cancelled + 1 zombie failed，`turns` 全为 0），不一致 **140/153**；按 `result.runId` join 账本命中 **140/153**，按文件名 id join **0/153**。单日样本：2026-10-21 账本 2334 行 / 81 distinct UUID，命中 run json **56/81**（其余是 run json 已被 gc）；2026-10-18 命中 5/78、2026-10-20 22/119、2026-10-22 2/19 —— 历史命中率随 gc 单调下降。⇒ 任何「把账本用量挂到 run json 记录」的 join **必须用 `result.runId`（UUID）**；且**账本里存在 `run_*` 形态的 `runId` 行数 = 0/118,984**（全部是 UUID）。
- 读取/聚合 `collectSubagentUsage(day)` (`extensions/index.ts#L2222-L2230`)：按事件 `id` 去重，按本地日 + UTC 命名 legacy 文件双读；产出 `UsageBucket{input,output,cacheRead,cacheWrite,cost,turns,count,byModel}`。`/today-usage` 消费。
- 账本行读取已抽成公开 `readUsageRecords(day)` (`extensions/index.ts#L2184-L2220`)，`/today-usage` 与 `/tiers usage` 共用。
- **`cancelled` run 的 `result` 是占位体，且 join 键在 kill 路径被写坏**（见 [[异步 Run 控制面（list / kill）]] 限制 9）——其用量只能从账本读，而 `applyKillOutcome`/`markKilled` 把 `result.runId` 写成**文件名 id**（`run_*`）而非 dispatch UUID ⇒ **账本 join 必失败**（实测账本里 `run_*` 形态 `runId` 行数 = 0/118,984）。变通（时间窗 + agent 名）实测只能无歧义恢复 **8/12**（turns 173），另 4/12 有 2–5 个并发候选 ⇒ **必须存 join 键，不能靠时间窗**。
- 注：账本行**不含 role/costTier 字段**——`collectSubagentUsage` 的聚合键仍只有 `model`；role×costTier 视角是 `/tiers usage` 的**读时 join**（见 §8）。
- **账本不是 `/v1/sessions/:id/usage` 的同源不同口径，而是完全不同源不同口径**（易混淆，写清）：
  - `/v1/sessions/:id/usage`（`server.ts#L2042-L2057` → `runtime/session-usage.ts::readSessionUsage`）读**会话 JSONL 尾部**，答的是「**当前轮次**上下文占用」（`tokens` 优先 provider `totalTokens`、`percent`、`cachePercent`）；
  - 账本 / `result.usage` 答的是「**整个 run 的累计计费**」（`input/output/cacheRead/cacheWrite/cost/turns` 求和），无 `totalTokens`、无 `reasoning`。
  - **对 async run 不能用 `/usage`**：async 子进程 `--no-session`（`runner-argv.ts#L70`）⇒ `SessionManager.inMemory` ⇒ **无会话文件** ⇒ `/v1/sessions/run_*/usage` 实测 **404 `no-session`**。⇒ GUI 要「这个 run 花了多少/每回合增量」，只有账本或 run json 的 `result.usageEvents` 两条来源。

### 4.1 账本结构与体量（2026-10-22 全量实测）

| 读数 | 值 |
|---|---|
| 文件数（本地日切分） | **78** |
| 总行数 / 总字节 | **119,171 行** / 34,646,862 B |
| 单行字节 min / q25 / **median** / q75 / p90 / max | 32 / 281 / **293** / 299 / 305 / 318（极窄 ⇒ 行体积由字段名常数决定） |
| distinct `runId` | **3,959** |
| 每 run 行数 min / **median** / max | 1 / **19** / **1,883**（avg 30.1） |
| 坏行 / 重复 `id` | **0 / 0** |
| `usage.turns` 分布 | `1` 占 **118,694（99.5%）**；`0` 占 189（`:empty` 占位行）；其余 2..N 共 76 取值 ⇒ **一行 = 一个 assistant 回合** |
| legacy 行（无 `version`/`id`/`runId`） | **297** |

**join 现实（分母 153 份 run json）**：`result.runId`（UUID）命中账本 **140/153**；文件名 id 命中 **0/153**。
细看 13 份 miss：**12/12 cancelled + 1 zombie failed**，其 `turns` **全为 0**、只可能命中 `:empty` 占位行（实测 0 命中）。
反向：`turns>0` 的 **133/133 全部命中真实明细行**；那 140 份的 `result.usage.turns` 与账本 `sum(usage.turns)` **140/140 完全相等**。

**账本比 run json 长寿**：账本 3,959 distinct UUID vs run json 153 份（run json 被 `/subagent-gc` 按 48h mtime 删：`gc-cleaner.ts#L100-L122`，入口 `index.ts#L4839`）⇒ 账本是**更长期**的权威，run json 是**短期**的。

### 4.2 `usageEvents` 的类型、体积与被剥的代价

**类型**：`SubagentUsageEvent`（`extensions/index.ts#L867-L875`）= `{id, runId, ts, model?, usage}`；内嵌 `UsageSummary`（`#L858-L865`）= `{input, output, cacheRead, cacheWrite, cost, turns}`。
**无可变长 payload**（无文本/工具名/参数）⇒ 体积由字段名常数决定，实测 **266.2 B/事件**（1,261,193 B ÷ 4,737 条）。

**现网体量**（分母 = 153 份 run json）：`usageEvents` 键 **153/153** 存在，**非空 78/153**，`usage.turns>0 但事件空` **55/153**（= 已被剥）；
事件条数 total **4,737**，每 run 中位 40 / max 261；事件数组单文件最大 **70,808 B（261 条）**。

**被剥的代价可量化**：55 份被剥记录 `turns` 合计 **2,151** × 266 B ⇒ **约 572 KB** 逐轮明细已从盘上消失（≈ 现 3.12 MB 总量的 **+18.3%**）。
`turns` 与事件数 **1:1**（实测 78 份非空记录 avg events/run 60.7 = avg turns/run 60.7）——这是「用 `turns` 反推已丢明细量」的前提。

**引入动机**：`git log -S slimRunRecordForDisk` → 唯一 commit **`0dfc70d`**（2026-10-20），提交说明写的是「顺带（同日性能问题）… run json 里 usageEvents 占 83–93% 体积但**只读查询方从不使用**」。
⇒ 这是**顺带性能优化**（`status/kill` 全量读目录的热读成本），不是安全/正确性要求；且「当时的读取方」≠「未来的读取方」——GUI 用量视图正是新的读取方。

> **⚠ 注释里的占比数字已不可复现**：`extensions/index.ts#L2337` 注释写「**83–93%**：85KB 文件里 usageEvents 74.5KB」，
> 实测 max 仅 **78.7%**；真正的 93.5KB 文件（`run_mvf26raa_9w5l.json`）事件为 **70,808 B**（且 76288/93563 也只得 81.5%）。
> 三种分母全给：事件÷整个 run json = **10.4% / 41.5% / 78.7%**（min/median/max）；事件÷`JSON.stringify(result)` = 16.9% / 58.4% / 88.9%；
> 事件÷(文件−事件) = 11.6% / 71.0% / 369.0%。**引用时必须写清分母**，否则读数差一倍。


### 5. 派发门（工具参数校验）现状

- 工具注册 `pi.registerTool({name:"subagent-win"})` `extensions/index.ts#L3022-L3067`（`tools`/`excludeTools` 为 per-call opt-in 参数，仅显式传入才生效）。
- `runSingle` 内的 `if (!toolsSupportedForBackend(resolvedModel, tools))`（`extensions/index.ts#L933`，实现在 `extensions/runner-argv.ts#L84-L90`）——显式 `--tools` 遇外部 CLI 后端即拒派。另有未知 agent 前置拒绝（`#L1509` / `#L3641` / `#L3768` 等）。
- costTier / 角色区间门见 **§8**（挂在 `runWithFallback` 候选集层，不在工具参数校验层）。
- 其它「白名单/分级」校验先例：微信远程命令 `RemoteCommandTier` 白名单 (`extensions/runtime/wechat-remote-command.ts#L28`、`#L163-L261`)；`validateTabDispatchRecord`（`extensions/tab-runs.ts#L488`）；预设文件形状校验 `isPreset`（`extensions/model-presets.ts#L56-L66`）。

### 6. 配置读写与写 models/fallbackModels 的位置

- `readConfig` (`extensions/index.ts#L258-L280`)：`JSON.parse` + 对 7 个枚举键归一化覆盖，未枚举顶层键原样保留；坏 JSON 回落缺省。**无 schema / 白名单校验**。
- `writeConfig` (`extensions/index.ts#L282-L305`)：整对象 `JSON.stringify` + tmp+rename 原子写（EPERM×3 重试）。
- `/sub-models` 写点：交互 primary `#L3680`（写后 `#L3681`）、交互 fallback `#L3716-L3717`；文本 `set` 批量 `cfg.models[agent]=` `#L3756`、`fallback <a,b>` `#L3788`、`thinking` `#L3802`、单 model `#L3818`（各随 `writeConfig`）。
- `/tiers role` 是**第二个**写 `config.json` 的命令（写 `roleTier` 键，经注入的 `deps.reloadConfig`/`writeConfig`，见 §8.7）。
- `/sub-presets` 应用：`applyPreset` 整体替换三张表后 `deps.writeConfig(cfg)` (`extensions/model-presets.ts#L188-L196`)，命令注册在 `#L272`（`registerSubPresetsCommand`，接线于 `extensions/index.ts#L3825`）。
- 注：全仓**无**「模型是否为合法 provider/id」的写前校验；`normalizeModelRef` 仅在派发时使用。

### 7. 与 costTier 正交的既有 `tier` 语义

- 成本层级统一叫 **`costTier`**（free|cheap|standard|premium|selfpaid|unknown），契约见 §8；以下 `tier` 用法**均与模型成本无关**，不得复用/覆盖该命名：
  - `liteTiers` — lite 模式的模型**能力档** small/medium/large，投影自 `config.models`（`extensions/lite-mode.ts#L48-L54`，展示 `#L123-L130`）。
  - `proposalTierCap` — master 压力线的 token 档位封顶（`extensions/runtime/master-pressure.ts#L40-L47`）。
  - `RemoteCommandTier` — 远程命令权限档 safe/sensitive（`extensions/runtime/wechat-remote-command.ts#L28`）；`steer` 的 `runAbortTier`（`extensions/steer-consumer.ts#L172`）。
- 「graph/frontier」相关的是 **`level`**（⑧ expected-event 触发层级，`extensions/runtime/autonomy/frontier.ts#L47`、`#L293-L299`）与 `GateStatus`，**不是** `tier`。故「harness 现有 tier 是 graph/frontier 事件层级」在本仓源码中**不成立**。

## costTier 派发门与 /tiers 维护面

「模型贵不贵」与「这个角色配不配用」分两张**正交**表存，门在派发时把两者 join 起来判定。

### 8.1 两张表（角色策略 vs 模型属性）

| | 角色策略 | 模型属性 |
|---|---|---|
| 存哪 | `config.json.roleTier`（代码默认 `DEFAULT_ROLE_TIER`） | `~/.pi/agent/model-cost-tiers.json` |
| 维度 | 角色 → 允许层级**区间** `{min,max}` | 模型 → 层级（全局、角色无关） |
| 归一化 | `normalizeRoleTier` (`tiers.ts#L95-L110`)：`DEFAULT ∪ 合法覆盖`，未知角色 / 非法 tier / `max<min` / 边界为 `selfpaid\|unknown` → 忽略 + `console.warn`，never-throw | `loadCostTiers` (`tiers.ts#L169-L180`)：缺文件 / 坏 JSON / `version!==1` → `{present:false, table:emptyTable()}`（`present` 是非枚举运行时标记） |
| 写盘 | `/tiers role` → `writeConfig`（写前反校验，见 8.4） | `/tiers set\|rm` → `writeTiersFile` tmp+rename（Windows EPERM×3 重试，`tiers.ts#L521-L540`） |

- 层级取值 `CostTier`（`tiers.ts#L30-L33`）：`free|cheap|standard|premium|selfpaid|unknown`。
- `TIER_RANK`（`tiers.ts#L35-L41`）：`free=0, cheap=1, standard=2, premium=3`；**`selfpaid` / `unknown` 的 rank = null → 不可比，永远不落在任何区间内**。
- `DEFAULT_ROLE_TIER`（`tiers.ts#L46-L54`，7 键、含 `general`）：`searcher`/`implementer`/`general` = `[free,cheap]`；`planner`/`plan-reviewer`/`code-reviewer`/`consultant` = `[standard,premium]`。
- 表形状 `{version:1, tiers:{model:tier}, byProvider:{provider:tier}, patterns:[{match,tier}]}`（`ModelCostTiersTable`，`tiers.ts#L122-L128`）。
- 路径 `costTiersPath()`（`tiers.ts#L141-L144`）= env `PI_MODEL_COST_TIERS_PATH` ?? `~/.pi/agent/model-cost-tiers.json`。
- `config.json.roleTier` 在 `AgentConfig` 上是 `roleTier?: Record<string,{min,max}>`（`index.ts#L253-L254`）：`readConfig` **裸透传**（不校验、不归一化），归一化只在消费端（派发门 / `/tiers`）做。

### 8.2 解析顺序（模型 → costTier）

`resolveCostTier(model, table)`（`tiers.ts#L193-L210`），**越具体越优先**：

1. `tiers[全名]`（`provider/id` 整体精确命中）
2. `patterns`：**首个**命中者生效；匹配对象是 `全名`，全名无 `/` 时跳过、否则还试 `/` 之后的 `id`；glob 语义 `*` = 任意字符（含 `/`）、`?` = 单字符，其余元字符转义（`globToRegExp`，`tiers.ts#L182-L191`）
3. `byProvider[provider]`（全名里 `/` 之前那段）
4. 兜底 `unknown`（空串 / 未标注 / 表缺失）

> **⚠ pattern 粗粒度误伤（已知限制，不预置宽泛 pattern）**：`globToRegExp` 的 `*` **跨 `/`**（`tiers.ts#L182-L191`），因此 `*-flash → cheap` 会把 `Zhipu/glm-5.3-flash`（planner 主模型，min=standard）判 cheap → **below-min 硬拦 planner 全链**；同族：`deepseek-v4.1-flash` 对 planner/plan-reviewer/consultant/code-reviewer 的 fallback 位全 below-min（被静默跳过，fallback 链被掏空）；`byProvider` 粗标（如 `Zhipu → cheap`）同理。**建表优先用 `/tiers draft` 全名 `tiers` 精确标注，不用通配/按 provider 粗标。**

### 8.3 区间语义与 10 行处置矩阵

- 区间语义：`tierInInterval`（`tiers.ts#L112-L119`）要求三个 rank 均可比且 **`min ≤ tier ≤ max`**（含两端）。边界若为 `selfpaid|unknown` 则视为非法配置（`normalizeRoleTier` / `/tiers role` 均拒收）。
- 矩阵入口 `checkDispatchTier({role, model, table, roleTier, explicitOverride, allowTierEscalation, mainCall})`（`tiers.ts#L260-L367`），返回 `GateDecision{allowed, code, tier, message, warn?, side?}`；`code` ∈ `ok|table_missing|in_range|unknown_override|unknown_blocked|selfpaid_override|selfpaid_blocked|out_of_range_blocked|escalated`（`tiers.ts#L212-L221`）。矩阵要点：
  - **表缺失** → 放行（`table_missing`），信息里给「同层替身、全尽停下问人」口径。
  - **角色无区间**（不在默认 7 键、也未在 `config.roleTier` 定义）→ 拒绝（`unknown_blocked`），**不静默放行**。
  - **`unknown`**：仅「主会话 + （显式 override 或 `allowTierEscalation`）」放行 + `warn`（`unknown_override`）；否则一律拦（`unknown_blocked`）。
  - **`selfpaid`**：同 `unknown` 逻辑（`selfpaid_override` / `selfpaid_blocked`），默认不落任何区间，只有主会话显式点名可用。
  - **`free..premium`**：`rank < min` → **任意情况硬拦**（`out_of_range_blocked`，`side=below-min`）；`rank > max` → 仅「主会话 + `allowTierEscalation`」放行 + `warn`（`escalated`，`side=above-max`），否则硬拦；区间内 → 放行（`in_range`）。
  - 区间边界不可比 → 拦（`out_of_range_blocked`）。
- 拦下来的文案固定：`[subagent-tier-blocked role=… model=… tier=… interval=… side=…] <详情>`（`tierBlockMessage`，`tiers.ts#L243-L253`）+ `fixHint`（`/tiers set` 重标注 / `/tiers role` 调区间 / 主会话 `allowTierEscalation` 升层须显式向用户报告）。放行侧告警前缀 `[subagent-tier-gate]`（`gateNote`，`tiers.ts#L255-L257`）。

### 8.4 门挂在哪儿（fallback 候选集层，不是工具校验层）

- 挂点 `runWithFallback`（`extensions/index.ts#L1274-L1420`）：在 `candidates = [...new Set([primary, ...normalizedFallbacks])]` 展开后、任何 `runSingle` spawn 之前读 `loadCostTiers().table` + `normalizeRoleTier(readConfig().roleTier)` + `readConfig().costTier?.enforce === true`（`#L1313-L1328`）。三处门点都经纯函数 **`costTierGate`**（`#L1248-L1263`，可单测）：内部调 `checkDispatchTier`，再叠 `enforce` 灰度。
- **`enforce` 灰度开关（warn-only）**：`config.json.costTier.enforce`，**默认 `false`**（未写 = false）——`false` 时门不通过只降级为 `onUpdate("⚠ tier <code>（enforce=false warn-only，未拦）")` 告警放行，原始判定保留在 `gate`；`true` 时硬拦。首次建表落地时保持 `false` 观察，确认无误再切 `true`（`config.example.json` 有样例）。
- **无模型名门（L4 M1）**：`candidates.length === 0`（角色既无 config 模型也无 fallback）时，整体语义上正是 `unknown`——表 present 且角色区间可解析时，先以 `model:""`（`resolveCostTier` → unknown）跑一次门，不通过 → 与主门同形的 `[subagent-tier-blocked … model=(none) …]` 结构化失败；**表缺失 → `table_missing` 放行（维持 fail-open）**（`#L1321-L1340`）。
- **主门（候选 0）**：`allowed=false` → 立即返回结构化失败（`status:"failed"`、`triedModels: []`、error 前缀 `[subagent-tier-blocked …]`），**不进入 fallback、不写 `priorFailures`、不经 `classifyModelFailure` / `isRetryableModelFailure`**（`#L1331-L1348`）。
- **fallback 逐候选复跑门**：`index>0` 的每个候选在 spawn 前再判一次；**强制 `explicitOverride:false`**（L4 M2：「用户点名」只覆盖 candidate 0，不覆盖 fallback 链，unknown 兜底不得被点名误放行）；越界 → `priorFailures.push({model, kind:"TIER_BLOCKED", error})` 并 `continue`（**不 spawn、不记 `tried`**，`#L1358-L1366`）。
- 全部候选在 spawn 前被跳完 → 返回最后一条 blocked 的结构化失败（`#L1402-L1415`）。
- 放行但带 `warn`（`escalated` / `unknown_override` / `selfpaid_override`）→ `onUpdate("⚠ tier <code>", candidate)` 上报（`#L1349`、`#L1366`）；`enforce=false` 未拦场景另带「warn-only」标注（`#L1349`、`#L1365`）。
- **升层只认人在场**：工具参数 `allowTierEscalation`（`index.ts#L3137`）在 handler 入口有身份门——`p.allowTierEscalation === true && !isMainSession()` → 直接 `isError` 拒收（`index.ts#L3399`；`isMainSession = !getTabRunId() && !isSubagent()`，`extensions/identity.ts#L95-L97`）。派发时透传 `allowTierEscalation` + `mainCall: isMainSession()`（sync/async 单发 `#L3743`/`#L3777`、异步并行 `#L3652`、同步并行 `#L1537`）。因此**子 agent / task tab 既不能自称主会话，也不能越过 max**。

### 8.5 配置互校验（角色区间 × models/fallbackModels）

`validateRoleTierAgainstModels(cfg, table)`（`tiers.ts#L381-L426`）三分类：

- 已标注且越界 → `errors: TierContradiction[]`（**硬错**）；`/tiers role` 写盘前与 **`/tiers set` 写表前**都先跑它，有错就不写盘（`tiers.ts#L655`、`#L599-L606`）——`/tiers set` 防一条错标（如把 planner 主模型标 cheap）静默打挂 planner 全链；unknown 不拒，表缺失 fail-soft。
- 未标注（`unknown`）→ `unknown[]`（**pending，不算错**）。
- 成本表缺失 → `skipped: true`（fail-soft，跳过区间校验）。
- 检查面 = `models[role]` 单个 primary + `fallbackModels[role]` 整条链；角色集合 = `normalizeRoleTier(roleTier)` 键 ∪ `models` 键 ∪ `fallbackModels` 键；未知角色 key 无区间可比 → 跳过（由 `/tiers check` 单独报 `roleTier` 非法项）。

### 8.6 同层替身口径（USAGE_CAP 指引）

USAGE_CAP（套餐用量用尽）后的主 agent 指引已从旧的「switch main session to a higher-tier via /model」改为**同层替身**口径，共 4 处：

- 「选 **same-costTier** 替身 = 同 costTier 且落在该角色 `[min,max]` 内（`/tiers show` 查层）→ 用 `model=` 重试；**不升出 max、不降出 min；同层替身全用尽 → STOP 问人**」：
  - `extensions/index.ts#L436-L442` — `formatFailureForMainAgent` 的 `usage_cap` 块
  - `extensions/index.ts#L2928` — 注入主会话上下文的 `before_agent_start` note
  - `extensions/index.ts#L3712` — 同步并行 USAGE_CAP 汇总头
  - `extensions/index.ts#L3804` — 单发失败正文注释（同一口径）

### 8.7 用量聚合（role × costTier）与命令面

- `aggregateUsageByRoleAndTier(records, table)`（`tiers.ts#L456-L474`）纯 join：`role` = 账本行的 `agent`（空/null → `(unattributed)`），`costTier` = `resolveCostTier(model)`；产出三张 Map：`byRole` / `byRoleTier`（键 `role|tier`）/ `byTier`，bucket = `{input,output,cacheRead,cacheWrite,cost,turns,count}`（`cost` 兼容数字或 `{total}`，`tiers.ts#L432-L435`）。账本来源 = `readUsageRecords`（`index.ts#L1644`）。
- `/tiers` 命令面（`registerTiersCommand`，`tiers.ts#L772-L818`；接线 `index.ts#L4132`，deps `{reloadConfig, writeConfig, readUsageRecords}`）：

| 子命令 | 作用 |
|---|---|
| `show` | 合并后 `roleTier` 区间（标「(覆盖)」）+ 成本表 presence/计数 + 每个引用模型解析到的层级（`unknown` 标 ⚠） |
| `set <model> <tier>` | 写 `table.tiers`（**写前 roleTier 互校验**，硬矛盾拒写；原子写） |
| `rm <model>` | 只删 `tiers` 显式条目（`patterns`/`byProvider` 需手改文件） |
| `draft` | 引用模型 ∪ 本地 store 模型（`~/.pi/agent/models.json` + `models-store.json`）里 `unknown` 者 → 空白骨架 |
| `check` | `roleTier` 非法项 + 区间 × `models`/`fallbackModels` 互校验 + pending（表缺失 fail-soft） |
| `pending` | 被引用但 `unknown` 的模型清单；进程内只提醒一次（`notifyUnknownOnce`，`tiers.ts#L559-L564`） |
| `usage` | 当日 `byRole` / `byRole × costTier` 聚合 + 未标注占比 |
| `role <role> <min> <max>` \| `role <role> clear` | 编辑 `config.roleTier`（写前反校验，见 8.5） |

- 命令骨架沿用本仓范式：无参数且 `ctx.hasUI` → `ui.select` 菜单（`set`/`rm`/`role` 跟随 `ui.input`），非 TUI 回退纯文本帮助（范式见 [[扩展命令面与测试隔离约定]] §1–§2）。
- 命名纪律：本机制只用 `costTier`，**不复用/覆盖**既有 `tier` 语义（`liteTiers` 能力档 / `proposalTierCap` / `RemoteCommandTier`，见 §7）。

### 8.8 预设携带与测试

- 预设快照携带 `roleTier`（`extensions/model-presets.ts`）：`PresetConfigLike.roleTier?`（`#L39`）；`isPreset` 允许该键缺失（旧预设兼容），存在时必须是对象非数组（`#L64-L65`）；`save` 仅当来源配置有 `roleTier` 才复制进快照（`#L102-L103`）；`apply` 仅当预设含该键才整体替换，**旧预设不带 `roleTier` 时保留当前配置**（不删除，`#L207-L208`）；`configLines` 展示角色区间摘要（`#L115-L118`）。
- 测试：`extensions/_test_tiers.ts`（门矩阵 1–14 + 互校验 + glob，记忆表 / `mkdtemp` 显式路径）、`extensions/_test_tiers_usage.ts`（聚合 + `/tiers usage` handler + **`/tiers set` 写前互校验拒写**，fake pi + 内存 deps + `PI_MODEL_COST_TIERS_PATH` 改道）、`extensions/_test_tiers_gate.ts`（**`costTierGate`：无模型名门 / fallback `explicitOverride:false` / `enforce` 灰度**，全内存表）；npm `test:tiers` / `test:tiers-usage` / `test:tiers-gate`（`package.json#L133-L136`）——隔离纪律同 [[扩展命令面与测试隔离约定]] §5。

### 8.9 维护操作手册（3 例）

把 8.1–8.8 的机制压成三个日常操作剧本。

**例 1 · 新模型接入如何标注**（避免派发被门拦或静默用 `unknown` 兜底）
1. `/tiers draft` — 扫 `models.json` + `models-store.json` 里的**被引用模型 ∪ 本地 store 模型**，列出所有解析为 `unknown` 者，产出空白骨架（`registerTiersCommand`，`tiers.ts#L762-L808`）。
2. `/tiers set <provider/id> <free|cheap|standard|premium|selfpaid>` — 写 `table.tiers`（tmp+rename 原子写，写入 `~/.pi/agent/model-cost-tiers.json`）。
3. `/tiers check` — 确认**无「已标注越界」错误**（`validateRoleTierAgainstModels`：已标注且越界 = 硬错；未标注 = `pending` 非错；**成本表缺失 = fail-soft 跳过区间校验**）。

拦/放口径：**未标注（`unknown`）→ 所有角色被拦**，仅主会话显式点名（override 或 `allowTierEscalation`）放行 **+ 告警**（`unknown_blocked` / `unknown_override`）；表整张缺失时门放行（`table_missing`），不拦。

> **运维风险（建表 runbook 必读）**：① **删表即整门失效**——删除 `~/.pi/agent/model-cost-tiers.json` 后所有模型 `unknown` + `table_missing` → 门全放行（计划内 fail-open，`tiers.ts#L276`），属运维绕过面；删表前确认知悉。② **表必须一次性标全所有配置模型**（`/tiers draft` 看骨架），否则未标注模型在非主会话一律拦（unknown 全拦），建表不完整 = 静默打挂相应角色全链。③ 首次建表后保持 `costTier.enforce=false`（默认）warn-only 观察，确认无误再切 `true` 硬拦。完整操作步骤见 §8.10 灰度 runbook。

**例 2 · 额度尽时同层替身怎么走**（USAGE_CAP 命中后的处置）
1. 在同 `costTier` 且落在该角色 `[min,max]` 区间内找替身 —— `/tiers show` 查每个引用模型解析到的层级与角色区间（`(覆盖)` 标显式覆盖）。
2. 用 `model=` 重试被 USAGE_CAP 打断的任务（避开 `tried_models`），指引文案见 §8.6 的 4 处注入点。
3. **区间内替身全尽 → STOP 停下问人**。**不得升出 `max`、不降出 `min`**；主会话确需升层用 `allowTierEscalation`（`escalated` + `warn`），且**子 agent / task tab 传入一律被身份门拒收**（`!isMainSession()` → `isError`，§8.4）。

**例 3 · 用 `/tiers usage` 查泄漏**
- `/tiers usage` 输出当日 `role|costTier` 聚合（`aggregateUsageByRoleAndTier`：账本 `agent` → role 维，`resolveCostTier(model)` → costTier 维；读时 join 按日用量账本 `readUsageRecords`），并给未标注占比。
- **信号**：若**执行类角色**（如 `implementer` / `general` / `searcher`，默认区间 `[free,cheap]`）出现在 `premium` 桶 → 即「**泄漏**」：说明有派发绕过了门 / 用了 `allowTierEscalation` 升层 / 模型被误标为 premium。据此回到例 1 校准标注或检查升层来源。

### 8.10 `costTier.enforce` 灰度 runbook（建表 → 观察 → 硬拦 → 回滚）

> 本节是 §8.9 例 1 的完整操作剧本：`costTier.enforce`（`AgentConfig.costTier?{enforce?}`，`index.ts#L278`，缺省 = `false`）从 warn-only 切到硬拦的标准顺序，以及出事时怎么安全退回。全程**不碰成本表文件**——理由见 R0。

**R0 · 先读风险：删表即整门失效（不要用删表当开关）**
- 成本表（`costTiersPath()` = `PI_MODEL_COST_TIERS_PATH` ?? `~/.pi/agent/model-cost-tiers.json`）**删除 / 坏 JSON / `version≠1` → `loadCostTiers` 返回 `present:false` → 门矩阵第 1 行 `table_missing` 直接放行**（`tiers.ts#L274-L281`，计划内 fail-open）。即：**删表 = 整门失效 = 无声回到无门状态**，属运维绕过面。备份/改名/恢复表前必须确认知悉。
- 因此**「临时关门」一律走回滚路径（R3 置 `enforce:false`），不要删表**——删表还会丢失全部标注，重建需重走 R1。
- 反向风险：表 present 后所有 `unknown` 模型在非主会话一律 `unknown_blocked`（主会话显式 override 例外 + warn，`tiers.ts#L282-L302`）。**表不完整 = 静默打挂用到漏标模型的角色全链**，所以 R1 必须一次标全。

**R1 · 建表（`enforce` 保持 false，全程不拦）**
1. `/tiers pending` — 列出配置引用（`models`/`fallbackModels`）但解析为 `unknown` 的模型（`tiers.ts#L716-L733`）。
2. `/tiers draft` — 产出空白骨架（`tiers.ts#L670-L688`）；逐模型 `/tiers set <provider/id> <free|cheap|standard|premium|selfpaid>` 标注（原子写，**写前 roleTier 互校验**：硬矛盾拒写，防一条错标静默打挂角色全链，`tiers.ts#L590-L632`）。批量语义（`patterns`/`byProvider`）需手改文件。
3. `/tiers check` — **全绿标准**：无 roleTier 非法项、无「已标注越界」硬错（`✗` 行）、pending 清零（`tiers.ts#L690-L714`）。若输出「成本表缺失 → 跳过区间校验（fail-soft）」**不是绿**，回到第 2 步。

**R2 · 灰度（false → true，只在前门验完后切）**
1. 保持 `config.json` 不写 `costTier`（或显式 `"costTier": {"enforce": false}`，样例 `config.example.json#L30`），跑真实负载。此态下门判定照跑但**只告警不拦**：`costTierGate` 返回 `allowed: gate.allowed || !enforce`，不通过时派发继续 + 状态行 `⚠ tier <code>（enforce=false warn-only，未拦）`（`index.ts#L1248-L1263`；三处门点：主门 `#L1425-L1441` / fallback 逐候选 `#L1462` / 无模型名门 `#L1404-L1418`）。
2. 观察手段：状态行 `⚠ tier` 告警 + `/tiers usage`（执行类角色出现在 `premium` 桶 = 泄漏/误标，见 §8.9 例 3）+ `/tiers pending`（新接入模型漏标）。
3. **清空 `/tiers pending` → `/tiers check` 通过（无 `✗`）→ 灰度期无异常告警**，三条都满足才把 `costTier.enforce` 置 `true`。置 `true` 后门不通过即结构化拦截（`[subagent-tier-blocked role=… model=… tier=… interval=… side=…]` 失败返回，`index.ts#L1413`/`#L1435`/`#L1508`）。
4. **env 短路注意**：`enforce = PI_COST_TIER_ENFORCE==="1" || config.costTier.enforce===true`（`index.ts#L1398`）——**env 置 1 会无视 config 的 false 强制硬拦**；灰度期「为什么明明 false 还拦」先查这个 env。

**R3 · 回滚（误标打挂 / 拦截风暴时）**
1. **第一动作：`enforce` 置回 `false`**（或从 `config.json` 删除 `costTier` 键，缺省即 false）→ 立即回到 warn-only，门不再拦。**不要删表**（见 R0）。
2. 若进程环境设了 `PI_COST_TIER_ENFORCE=1`，必须同时 unset（env 优先于 config，见 R2.4）。
3. 误标修正：`/tiers set <model> <tier>` 重标（写前互校验拦硬矛盾）；角色区间错了用 `/tiers role <role> <min> <max>` 改区间或 `/tiers role <role> clear` 清覆盖回默认（`tiers.ts#L634-L668`；全部角色清空时连 `config.roleTier` 键一并移除）。
4. **彻底退役门**（最后手段，等同 R0 的「无门」状态）：逐角色 `/tiers role <role> clear` 清空 `config.roleTier` + 删成本表 → 回到 `table_missing` 全放行。仅在接受「无门」时使用。

## Evidence

- `extensions/index.ts#L427-L490` — `normalizeModelRef`
- `extensions/index.ts#L894` — `runSingle` 落定 `resolvedModel`
- `extensions/index.ts#L521-L534` — `agentDefaultModel` / `resolveCallModel`
- `extensions/index.ts#L323-L378` — `classifyModelFailure`
- `extensions/index.ts#L384-L419` — `formatFailureForMainAgent`
- `extensions/index.ts#L1248-L1263` — `costTierGate`（门 + enforce 灰度，纯函数）
- `extensions/index.ts#L1274-L1420` — `runWithFallback` 候选集 + 无模型名门 / costTier 主门 / fallback 逐候选门（tried / priorFailures）
- `extensions/index.ts#L2035-L2092` — `USAGE_DIR`（`#L2035`）/ 按日切分（`localDayBounds` `#L2046` / `dailyUsagePath` `#L2056`）/ `recordUsage`（`#L2065-L2092`）
- `extensions/index.ts#L2184-L2220` — `readUsageRecords`；`#L2222-L2230` — `collectSubagentUsage`
- `extensions/index.ts#L1757` / `#L1603` — `dispatchRunId = randomUUID()`（账本 `runId` 口径）/ `withAllAttemptUsage` 赋 `result.runId`
- `extensions/index.ts#L4414` — run json 文件名 id 口径（`run_<ts>_<rand>`），与账本 UUID **不同源**
- `extensions/index.ts#L2343-L2347` — `slimRunRecordForDisk`（落盘剥 `result.usageEvents`）
- `extensions/runner-argv.ts#L70` — `--no-session`（async 不产会话 JSONL ⇒ 账本是唯一逐轮明细）
- `extensions/index.ts#L933` — `toolsSupportedForBackend` 派发门
- `extensions/index.ts#L253-L254` — `AgentConfig.roleTier?`（裸透传）；`#L278` — `AgentConfig.costTier?{enforce?}`（裸透传）；`#L258-L308` — `readConfig` / `writeConfig`
- `extensions/index.ts#L3137` — 工具参数 `allowTierEscalation`；`#L3399` — handler 身份门（`isMainSession()`）
- `extensions/index.ts#L4132` — `/tiers` 接线
- `extensions/tiers.ts#L30-L54` — `CostTier` / `TIER_RANK` / `DEFAULT_ROLE_TIER`
- `extensions/tiers.ts#L95-L110` — `normalizeRoleTier`
- `extensions/tiers.ts#L141-L180` — `costTiersPath` / `loadCostTiers`
- `extensions/tiers.ts#L193-L210` — `resolveCostTier`（tiers > patterns > byProvider > unknown）
- `extensions/tiers.ts#L260-L367` — `checkDispatchTier`（10 行门矩阵）
- `extensions/tiers.ts#L381-L426` — `validateRoleTierAgainstModels`
- `extensions/tiers.ts#L456-L474` — `aggregateUsageByRoleAndTier`
- `extensions/tiers.ts#L762-L808` — `registerTiersCommand`（/tiers 子命令面）
- `extensions/tiers.ts#L274-L281` — `table_missing` fail-open（删表即整门失效，§8.10 R0）；`#L282-L302` — 角色区间兑底 + unknown 拦/override 行
- `extensions/tiers.ts#L590-L632` — `cmdSet`（写前 roleTier 互校验）；`#L634-L668` — `cmdRole`（clear 语义）；`#L670-L688` — `cmdDraft`；`#L690-L714` — `cmdCheck`；`#L716-L733` — `cmdPending`
- `extensions/index.ts#L1398` — `enforce` 读取（`PI_COST_TIER_ENFORCE==="1"` env 短路 ‖ `config.costTier.enforce===true`）；`#L1413`/`#L1435`/`#L1508` — 三处 `[subagent-tier-blocked …]` 结构化拦截点
- `config.example.json#L30` — `"costTier": { "enforce": false }` 样例（§8.10 R2）
- `extensions/model-presets.ts#L39` / `#L64-L65` / `#L102-L103` / `#L207-L208` — 预设携带 `roleTier`
- `extensions/_test_tiers.ts` / `extensions/_test_tiers_usage.ts` — 门/聚合测试（`package.json#L133-L134`）
- **同模型有界重试（2026-10-18）**：`extensions/index.ts::SAME_MODEL_RETRY`（`maxSameModel=2` / `usageCapMultiplier=2` / `backoffMs=min(30s·n,60s)`）、`::SAME_MODEL_NEVER_RETRY`（`wall_budget|stall|auth`）、`::resolveSameModelRetryMax`（env `PI_SUBAGENT_RETRY_MAX`，clamp `[0,4]`）、`::retryBackoffMs`、`::sleepAbortable`（signal 可打断）、`::describeSameModelRetries`（终态文案含 `retries=n/max`）、`AttemptFailure.attempt?`（仅重试条目出现）；接线在 `::runWithFallback` 内层 `for (let attemptNo = 1; ; attemptNo++)` 循环；文案修正 `::fallbackChainText` / `::sameModelRetryFailure` / `::hasActualFallback`
- `extensions/_test_model_retry.ts` — 8 组真实接线级断言（`PI_CLI_PATH` stub 真 spawn，不 mock `runSingle`）：spawn 次数 3/2/1、`maxSameModel=0` 时 `priorFailures` 怡 3 键与 `error` 不含 `retries=`、auth 黑名单必挡、abort 打退避 <6s、`usage_cap` 退避长于普通曲线；`package.json` 的 `test:model-retry`
- `extensions/_test_model_failure_classify.ts` — 失败分类回归（`Connection error.` ⇒ `provider_network`/retryable，与 R-7b 同源）

## Links Out

- [[扩展命令面与测试隔离约定]]

## Backlinks

- [[扩展命令面与测试隔离约定]]
