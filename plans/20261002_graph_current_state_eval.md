# Global Work Graph 现状评估（L1 检索 + 评估结论）

- 日期：2026-10-02 · 性质：**research-only（只读 + 本文件 + 1 处 Wiki 陈旧句校准，零源码改动）**
- 服务对象：`plans/global_master_autonomy_suite_v0.4.md`（Global Master 自主化套件设计）的事实基础
- 一句话判断：**Work Graph 作为「先能自主动手」的决策底座——关系骨架与 run 级判态够用，但 project 级语义字段（status / goal / needs_user / blockers / progress / next_expected_event）几乎全部缺失，`diff()` 的覆盖面比快照面更窄一层（carrier 字段根本不进 diff），④⑥⑧ 三条 Wake 规则中 ④⑥ 仍无任何载体、⑧ 的载体在 Graph 之外。**
- 校准状态图例：✅代码已验证 / ✏️部分（代码验证但有前提或文档需修）/ ⚠️仅文档 / ➖不适用

---

## 0. 研究目标与范围边界

**目标**：回答「Work Graph 现状够不够支撑 v0.4 自主化决策，缺什么，缺口有多重」。

**范围边界**：

- 只读：`extensions/runtime/graph/*`、`extensions/runtime/autonomy/frontier.ts`、`extensions/runtime/autonomy/collect.ts`、`plans/global_master_autonomy_suite_v0.4.md` §4/§9/§26、`plans/0925_autonomy_E3_value_research.md`、Wiki 两主题页、本机生产盘面（`~/.pi/agent/runtime/state/*`、`events.jsonl`）。
- **零源码改动**；Wiki 仅修正 1 处被 E2.3 超越的「零生产接线」陈述（见 §10）。
- 本文件所有「事实」条目均带 `file#L`；设计推论/补齐清单标注为**建议，非已验证事实**。

---

## A. Graph 实际是什么

### A1. 节点 / 边 / 字段完整清单 ✅代码已验证

**GraphNode 公共壳**（`extensions/runtime/graph/types.ts#L20-L33`）：`id` / `kind` / `label` / `status: string|null` / `attrs: Record<string, string|number|boolean|null>` / `firstSeq` / `lastSeq`（非 journal 源恒 0）。

| kind | id | label | status | attrs（逐字段） | firstSeq/lastSeq | 源 |
|---|---|---|---|---|---|---|
| `master` | `DEFAULT_MASTER_ID`（`master_default`） | = id | **恒 null** | **恒 `{}`（空）** | 0/0 | `project.ts#L175-L176`；输入由 `collect.ts#L87` **硬编码单例**（不读 registry） |
| `workstream` | `ws.id` | `ws.mission` | `ws.status`（`active\|waiting\|blocked\|paused\|completed\|failed`，`objects.ts#L31`） | `{ workspaceRef: string\|null, hasTaskSelector: boolean }` | 0/0 | `project.ts#L179-L187`；**未投影**：`masterId`/`successCriteria`/`wakePolicy`/`taskSelector` 明细/`createdAt`/`updatedAt` |
| `task` | `t.id` | `t.objective` | `t.status`（7 值，`objects.ts#L76`） | `{ workstreamId: string\|null, externalTaskId: string\|null }` | 0/0 | `project.ts#L190-L198`；**未投影**：`createdAt`/`updatedAt` |
| `run` | `envelope.subject`（`run://tab/<id>`） | = subject | 由**事件 type 派生**（`dispatched/completed/failed/cancelled`；`launch_failed→failed`；**不读 payload.status**） | `{ executionKind, externalTaskId, mode, title, phase, project }`（`project.ts#L206-L213`） | journal seq | `project.ts#L201-L217`；**未投影**：`envelope.at`（墙钟，`envelope.ts#L53`）、pid、`gate/needsHuman/staleOver/overdue/pidAlive` |
| `project`（别名节点） | `project:<normalizeRepoKey(repoPath)>`（`edges.ts#L42`） | 归一 repoPath | **恒 null**（`project.ts#L222`） | `{ repoPath, attention: number\|null }`（`project.ts#L224`） | 0/0 | `project.ts#L218-L226`；**没有** status/current_goal/current_assignment/needs_*/risk/blockers/active_children/progress/next_expected_event 任何一个 |

**快照另外三段（不在 `nodes` 里）** ✅：

- `projects[]`（`GraphProjectView`，`types.ts#L84-L89`；装配 `project.ts#L262-L268`）：`{ project, attention, runs: GraphRunRef[] }`。
- `GraphRunRef`（`types.ts#L55-L74`）：`runId/subject/status/phase/externalTaskId/project` + **carrier 五字段** `gate/needsHuman/staleOver/overdue/pidAlive`（恒赋，缺 → null 不猜，`project.ts#L244-L256`）。
- `history[]`（hidden tab `{id,reason}`，`types.ts#L101-L106`；由 `collect.ts#L153-L157` 填充）与 `asof`（诊断时间戳）。

> **关键结构事实**：**carrier 五字段（gate/needsHuman/staleOver/overdue/pidAlive）只存在于 `projects[]` 视图，从不进节点 `attrs`**（`project.ts#L206-L213` 无这些键）。`attention`/`phase`/`status` 则**双写**（既进节点 attrs 又进视图）。这一点直接决定 §C7 的 diff 覆盖面。

**边（5 种，全部引用式；零声明式）** ✅：

| kind | 载体 | 派生条件（不满足则不产边） | 证据 |
|---|---|---|---|
| `task_workstream` | `TaskRecord.workstreamId` | 目标 ws 节点必须存在（孤儿不猜） | `edges.ts#L61-L70` |
| `run_task` | run payload `externalTaskId` ↔ `TaskRecord.externalTaskId` | 有 task 精确命中该 externalTaskId | `edges.ts#L75-L85` |
| `run_workstream` | `WorkstreamRecord.taskSelector.runSubjects`（精确，`match:"runSubject"`）或 `.externalTaskIds`（best-effort，`match:"externalTaskId"`） | 精确优先，否则回退 label 匹配 | `edges.ts#L88-L107` |
| `run_subject` | `envelope.subject`（身份自环 `from===to`） | 仅 journal 源 run（`firstSeq>0`） | `edges.ts#L111-L119` |
| `workstream_project` | `WorkstreamRecord.workspaceRef`（**弱载体**） | `isPathShapedRef`（`edges.ts#L33-L41`，`scheme://` 逻辑地址不算路径）**且**目标 project 节点存在 | `edges.ts#L124-L134` |

**不存在的边**：`depends_on` / `blocks` / `requires` —— 「零载体零生产者」（`types.ts#L36-L41` 注释原文）✅。

### A2. 数据来源 + 读不到的路径 ✅代码已验证

| 来源 | 派生什么 | 证据 |
|---|---|---|
| **journal**（`events.jsonl`） | 全部 `run` 节点、`headSeq`/`logEpoch`/`badLines`；事件词表 = **run 五型**（`GRAPH_RUN_EVENT_TYPES`，`types.ts#L153-L159`），其余 type 只进 `skipped.unknownEventTypes` **不投影** | `collect.ts#L64`、`project.ts#L119-L123` |
| **workstreams 显式库** | `workstream` 节点（mission/status/workspaceRef/taskSelector）+ `task` 节点（workstreamId/externalTaskId/objective/status） | `collect.ts#L65-L78` |
| **tab-runs 账本** | `run` 的 `phase`（composeTabStatus 结论）、`project`（cwd→`findRepoRoot`，`collect.ts#L193-L211`）、carrier 五字段（共享归约 `reduceTabCarrier`，`collect.ts#L166-L178`）、`projectAttention`（`collect.ts#L177-L184`）、`history`（hidden 分流，`collect.ts#L153-L157`） | `collect.ts#L122-L186` |
| **registry** | **不读**。`masters` 被硬编码为 `[{"id":"master_default"}]`，注释自述「Phase 1 单例 master：registry 附件只描述同一逻辑身份」 | `collect.ts#L86-L87` ✅（`types.ts#L136` 把 `masters` 描述为「registry 只读引用（缺省…）」是**类型层可选入参**，生产装配并未接 registry ⚠️类型注释易误读） |
| **mailbox / backlog** | **不在 Graph**（frontier ⑩ 的 `backlog` 由 `mailboxBacklog()` 单独喂入） | `autonomy/collect.ts#L158` |
| **期望账本 `state/expectations/`** | **不在 Graph**（代码注释原文「期望账本不经 Graph」） | `autonomy/collect.ts#L164-L165` |

**never-throw → 空输入的收敛路径（「读不到」就当「没有」）** ✅：

1. `collectGraphInput` 顶层 try/catch → `EMPTY_INPUT`（journal/workstreams/tasks 全空）：`collect.ts#L97-L99`。
2. `readGraphSnapshot` catch → `projectGraph(EMPTY_INPUT)`：`collect.ts#L107-L108`。
3. `listTabDispatches` 抛 → 仅 tab 侧 refs 全空（journal/workstreams 保留）：`collect.ts#L125-L128`。
4. 单条坏 dispatch 跳过 / 单条坏 carrier 跳过：`collect.ts#L139-L142`、`collect.ts#L180-L182`。
5. `findRepoRoot` 失败 → 回退 cwd 本身（可能产生伪 project 键）：`collect.ts#L205-L210` + 弱载体残余（Wiki Open Questions 已记）。

**含义（任务向结论）**：Graph **没有任何「数据源故障」的可观测信号**（除 `skipped.badLines`），盘上账本被清 → 快照静默变空；这正是 E3 研究 §4.2 提到的「账本丢失 → frontier 失明」风险的代码级确认。

### A3. 影子模式的准确含义 + env flag + 实际在跑哪条路 ✅

**「影子模式」三层现状（易被一句话误导，逐层拆开）**：

| 层 | 现状 | 证据 |
|---|---|---|
| **读侧接线** | **已有生产 import**：`autonomy/collect.ts` 顶层 `import { readGraphSnapshot } from "../graph/collect.ts"` + `import { toFrontierInput } from "../graph/frontier-input.ts"`；由 env flag 二选一的**条件分支**调用 | `autonomy/collect.ts#L24-L25`、`#L119-L127`（graphFrontierSnapshot）、`#L153-L156`（分支）✅ |
| **开关** | `process.env.PI_AUTONOMY_FRONTIER_SOURCE?.trim() === "graph"` 才走 Graph；**缺省/任何其它值 = v2（`collectGlobalView`）** | `autonomy/collect.ts#L154-L156` ✅ |
| **开关是否被设置** | **没有**。全仓 grep（含 `config.json`/`config.example.json`/`package.json`/`scripts/`/`*.env`）只有测试、`plans/`、`CHANGELOG.md` 命中；`config.json` 只有 `autonomy.enabled=true`，无该 env 键；本机 `~/.pi/` 下亦无 | grep 全仓 + `config.json#L78-L80` ✅ |
| **实际在跑哪条** | **v2（`collectGlobalView`）**，非 graph | 合上前两条 ✅ |

**仍然「零消费者」的部分（E2.1 之后新增的事实）** ✅：

- `graph/index.ts` barrel：**零 import 方**（全仓 grep 只命中自身）。
- `diffGraph`：**零生产消费方**（只被 `graph/index.ts#L10` re-export + `extensions/_test_runtime_graph.ts` 使用）。
- `writeGraphSnapshotCache` / `readGraphSnapshotCache`：**零调用方**；本机 `~/.pi/agent/runtime/state/work-graph/` **不存在**（磁盘实测），即缓存从未在生产落盘。
- `toFrontierInput` 的**默认执行路径不经过**（flag 未设 → v2 分支）。

**结论（任务向）**：「影子模式」今天的准确含义 = **「生产代码里有一条被 env flag 关着的 Graph 读支路（默认不走）+ diff/barrel/缓存三件套完全无消费者」**——比 E1 的「纯库零接线」多了一层接线、比「已切源」少了开关。

- E2.1 声称的「`frontier-input.ts` 零生产接线」**不再成立**（E2.3 起被 `autonomy/collect.ts#L25` import）：✏️（阶段快照属实、作为当前状态已过期；Wiki 已补前向指针，见 §10）
- 源码内两处头注释仍写「零生产消费者」（`graph/types.ts#L7`、`graph/index.ts#L5`）：⚠️陈旧注释，**本轮不改源码**，列为风险点。

---

## B. 与 v0.4 设计差距（核心）

### B4. v0.4 §4 字段对照表 ✅（v0.4 §4 = `plans/global_master_autonomy_suite_v0.4.md#L187-L214`；R-B6 修订 = `#L216-L221`）

| # | 字段（v0.4 §4 YAML 原文行） | v0.4 要求 | Graph 现状（file#L） | 缺口性质 |
|---|---|---|---|---|
| 1 | `project: greencad`（#L187） | 逻辑 id = 归一化 repoPath（#L221 注） | **已有**：`project:<normalizeRepoKey>`（`project.ts#L218-L224`） | ✅无缺口 |
| 2 | `status: working`（#L189） | project 级状态 | 节点 `status: null`（`project.ts#L222`）；状态只在 **frontier 层**由 runs phase 聚合派生（`frontier.ts#L202-L219`），Graph 节点无 | **只缺投影**（数据=各 run phase 已在快照；需裁决 project 级状态派生规则并写回节点） |
| 3 | `current_goal`（#L191-L192） | project 当前目标 | project 节点无；近似物分散在 `workstream.mission`（`project.ts#L182`）/ `task.objective`（`project.ts#L193`） | **混合**：goal 文本部分存在（只缺投影），但「project ↔ goal」的**当前性**映射无载体（需语义裁定） |
| 4 | `current_assignment`（#L194-L195） | 当前在做的活 | 近似物 = `run.title`（`project.ts#L210`）+ `task.objective`；无 project 级 assignment 字段 | 同上：**半只缺投影、半无载体**（assignment 归属语义未定义） |
| 5 | `needs_global: false`（#L197） | 项目级布尔 | **无任何生产者**（全仓非测试 grep：`needs_global` 只出现在 `frontier.ts#L17/L43/L157` 的注释/类型/常量） | **无载体**（需新协议事件/新生产者，重） |
| 6 | `needs_user: false`（#L198） | 项目级布尔 | 数据已全在：`GraphRunRef.needsHuman`（`types.ts#L67`）+ `project.attention`（`project.ts#L224`）+ `gate`；frontier 已能派生 `needsUser`（`frontier.ts#L222`）；**Graph 节点未投影** | **只缺投影**（轻；派生规则已有现成实现可复用） |
| 7 | `risk: low`（#L200） | 项目级风险等级 | **无载体**（`frontier.ts#L45/L158`；`wake-gate.ts#L53` 注释「无 risk 载体，永不匹配」；`WorkstreamStatus`/`RuntimeTaskStatus` 词表均无 risk） | **无载体**（重；v2-b 才引入，R-B6 #L216-L219 明示非 A0 义务） |
| 8 | `blockers: []`（#L202） | 阻塞项列表 | 半：`status==="blocked"` 已投影在 ws/task 节点（`objects.ts#L31/L76` → `project.ts#L183/L194`）；**「谁挡谁」的关系边不存在**（`types.ts#L36-L41` 零载体） | **混合**：blocked 状态=只缺投影；blocker 关系=**无载体**（需声明式边新载体） |
| 9 | `active_children: {running, waiting}`（#L204-L206） | 子活动计数 | 数据已在：`projects[].runs[].phase`（`types.ts#L55-L74`）可数 | **只缺投影**（轻，纯派生计数） |
| 10 | `last_meaningful_progress: {summary, at}`（#L208-L210） | 最近有意义进展 + 时刻 | 节点只有 `firstSeq/lastSeq`（**journal seq，非墙钟**，`types.ts#L31-L32`）；通用 `envelope.at` 存在（`envelope.ts#L53`）但未投影；`summary` 与「meaningful」判定无定义 | **混合**：时间戳有候选源可投影，但选定「meaningful」事件及 summary 需语义定义/生产者；整体不能视为纯投影缺口 |
| 11 | `next_expected_event: {type, timeout}`（#L212-L214） | 期望事件声明 | 账本已有 `expectedType/deadlineAt/projectKey`（`expectations.ts#L69-L77`；本机 open 文件实测含全字段），journal 已有 `project.expected_event_set/arrived/timeout` 事件（本机 `events.jsonl` 44 行）；**Graph 不投影**（词表外 → `skipped.unknownEventTypes`，`project.ts#L119-L123`；装配注释「期望账本不经 Graph」`autonomy/collect.ts#L164`） | **只缺投影**（轻——生产者已在生产跑；但 Graph 词表 + 节点字段 + diff 三处都要补） |

> **R-B6 边界确认**（`v0.4#L216-L219`，⚠️文档）：`next_expected_event` / `active_children` / `last_meaningful_progress` / `risk` 属 **protocol v2-b 批次义务**，非 A0 schema 义务；④⑥⑧ 在 v2-b 落地前维持 record-only。→ 上表 4 个字段的「缺口」是**设计上已知的分期**，不是 A0 违约；但 `needs_user`/`status`/`blockers 状态`这三项**不在 R-B6 豁免内**，是当前就该有却没投影的。

**小结（B4）**：11 项里 **1 项已有**（project id）、**4 项只缺投影**（status / needs_user / active_children / next_expected_event，其中 status 需一条派生规则）、**4 项混合**（current_goal / current_assignment / blockers / last_meaningful_progress）、**2 项纯无载体**（needs_global / risk）。

### B5. 10 条 Wake 规则逐条判定 ✅代码已验证

> **前提高示**：E2.3 已用 S19 证明 `flag=graph` 与 v2 输出 canonical 全等（Wiki E2.3 契约 + `_test_graph_frontier_shadow.ts#L886`），所以**凡 v2 能判的，Graph 路同样能判**——下面「Graph 支撑度」问的是「该规则依赖的载体是否已进 `GraphSnapshot`」，而非「切源后会不会变」。

| 规则 | v0.4 §26 | frontier.ts 实现体（file#L） | 分布核实 | Graph 快照是否含该载体 | Graph 支撑判定 |
|---|---|---|---|---|---|
| ① `blocked_to_ready` | blocked→ready | gate `awaiting→ok` 边沿，`approximate:true`：`#L335-L337` | **≈ approx ✅** | `GraphRunRef.gate`（`types.ts#L66`，collect.ts#L166-L178 填充）✅ | **能（近似语义不变）**；真 blocked→ready 需 ws/task status 或 gate 外新载体 |
| ② `working_to_completed` | working→completed | run 级 phase 边沿 `#L318-L323` + hidden 回填 `#L325-L329` | **实做 ✅** | `phase` 在节点 attrs + 视图 ✅；`history` Graph 收集（`collect.ts#L153-L157`）但 `toFrontierInput` **恒 emit `[]`**（`frontier-input.ts#L75`，MF1） | **能（可见 run）**；hidden 回填支路两路都休眠（v2 生产 `history` 亦恒 `[]`，`global-view.ts#L614`） |
| ③ `working_to_failed` | working→failed | 同上 `#L321-L330` | **实做 ✅** | 同上 | **能**（同②） |
| ④ `needs_global` | false→true | **永不进 triggers**（规则注释 `#L43` + 常量 `#L157`） | **record-only ✅** | **无载体**（见 B4#5） | **不能**——缺权威语义断言（无生产者） |
| ⑤ `needs_user` | false→true | `needsUser` 边沿 `#L339-L341`；判据 `#L222` | **实做 ✅** | `needsHuman` + `attention` + `gate` 全在 ✅ | **能** |
| ⑥ `risk_high` | low/medium→high | **永不进 triggers**（`#L45` + `#L158`） | **record-only ✅** | **无载体** | **不能** |
| ⑦ `deadline_urgency` | crosses threshold | `overdue 0→正`，`approximate:true`：`#L343-L345`；判据 `#L227` | **≈ approx ✅** | `GraphRunRef.overdue`（`types.ts#L70`）✅ | **能（approx 不变）**；真 deadline 需期望账本/新字段（Graph 内没有） |
| ⑧ `expected_event_timeout` | expected event timeout | 账本存在 → **level 触发** `#L297-L307`；`expectations===undefined` 才留 record-only `#L386-L391` | **⚠️已变化**：不再是恒 record-only（0928 P2 起条件化） | 载体在**期望账本**，**不在 Graph**（`autonomy/collect.ts#L164-L165` 正交） | **frontier 能判、Graph 不能承载**（需补投影） |
| ⑨ `stagnation` | becomes true | `stagnation` 边沿 `#L347-L349`；判据 `staleOver ∨ unconfirmed` `#L226` | **实做 ✅** | `staleOver` + `phase` ✅ | **能**（近似：resultMissing 无独立时基，`frontier.ts#L224-L225` 自陈已知缺口） |
| ⑩ `ws_mail_backlog` | pending>0 | `#L287-L291`（非 approx） | **实做 ✅** | **不在 Graph**：backlog 来自 `mailboxBacklog()`（`autonomy/collect.ts#L158`） | **不能靠 Graph**——该输入与 snapshot 无关（Mailbox 是 Graph 外的第 5 个真相源） |

**已知分布「②③⑤⑨⑩ 实做；①⑦ approx；④⑥⑧ record-only」是否仍准确？** → **部分不准确 ✏️**：

- ②③⑤⑨⑩ 实做 ✅、①⑦ approx ✅、④⑥ record-only ✅ **全部仍成立**；
- **⑧ 已从 record-only 升级为「账本存在即 level 触发」**（`frontier.ts#L297-L307` + `#L386-L391`）。本机生产盘面实测 `audit.jsonl` 尾部 `recordonly=2`（非 3），`state/expectations/open/` 有 1 个进行中的期望 → **当前生产 ⑧ 是活的**。
- 因此 `v0.4#L1195` 的「④⑥⑧ record-only（无载体）」实现状态对照 **已过期**（⚠️文档需更新：应写成「④⑥ record-only；⑧ 条件化=账本存在即实做」）。

---

## C. Diff 能力

### C6. `graph/diff.ts` 实现了什么 ✅

| 能力 | 有无 | 证据 |
|---|---|---|
| `addedNodes` | 有 | `diff.ts#L47-L56`（`!prevNodes.has` + `nodeInScope`） |
| `removedNodes`（返回 id 数组） | 有 | `diff.ts#L57-L62` |
| `changedNodes`（`JSON.stringify` 深比较） | 有 | `diff.ts#L48-L55` |
| `addedEdges` / `removedEdges`（键 `kind\|from\|to`） | 有 | `diff.ts#L19-L21`（edgeKey）、`diff.ts#L64-L66` |
| **`changedEdges`** | **无**（`GraphDiff` 类型即无此字段） | `types.ts#L112-L120`；`diff.ts` 全文无对应逻辑 ✅ |
| 游标 `sinceSeq`（节点新鲜度） | 有；**非 journal 源（firstSeq=0）恒在范围** | `diff.ts#L14-L16` |
| 边新鲜度（两端任一新） | 有；端点缺失 → 保守算新鲜 | `diff.ts#L23-L30` |
| `prev=null` → baseline 全量 | 有 | `diff.ts#L33-L43` |

**Diff 的三个结构性盲区（决定 §C7）** ✅：

1. **`projects[]` 视图完全不进 diff**——`gate/needsHuman/staleOver/overdue/pidAlive` 这五个 carrier 字段**只在视图里**（B1 结论），故**它们的任何变化都产生不了 GraphDiff**。`attention`/`phase`/`run.status` 因为双写进节点 attrs 才可见。
2. **`history[]` / `skipped.unknownEventTypes` / `asof` 不进 diff**（`GraphDiff` 只有 nodes/edges + sinceSeq/headSeq，`types.ts#L112-L120`）→ 期望事件到达（落在 skipped）对 diff 完全不可见。
3. **边无 changedEdges** → `evidence`/`match` 标注变化不可见（Wiki Open Questions 已记，仍成立 ✅）。
4. 补充：`diffGraph` **零生产消费者**（grep 证实，见 A3）——它现在只是库能力，不是任何唤醒链路的一环。

### C7. v0.4 §9 九类变化 → Diff 支撑度逐类判定 ✅

| §9 类别（v0.4 行号） | Diff 现在能检测吗 | 靠什么 / 缺什么 | 缺口性质 |
|---|---|---|---|
| **9.1 Actionability**（`#L417`：blocked→ready / waiting→actionable / dep resolved） | **部分** | ws/task `status` 字面变化 → `changedNodes`（`project.ts#L183/L194` + `diff.ts#L48-L55`）；但 `gate awaiting→ok` **不在节点 attrs** → diff 看不见；「ready」派生规则不存在；`dependency resolved` 无载体（无依赖边） | **需字段但字段不在 diff 面**（gate 已在 `projects[]`，属「只缺投影到节点」的轻改）+ 依赖边**无载体** |
| **9.2 Assignment Lifecycle**（`#L429`：working→completed/failed/cancelled） | **能** ✅ | run 节点 `status` 变化 + `lastSeq > sinceSeq`（`project.ts#L205/L215` + `diff.ts#L48-L55`） | 无缺口（cancelled 同理由 type 派生） |
| **9.3 Responsibility**（`#L448`：needs_global / needs_user false→true） | **部分** | `needs_user`：`attention` 变化可见（project 节点 attrs，`project.ts#L224`）；`needsHuman` 变化**不可见**（不在节点）；`needs_global` **无载体** | attention 半边=只缺投影；needsGlobal=**无载体** |
| **9.4 Risk**（`#L466`） | **不能** | Graph 无任何 risk 字段/事件（B4#7） | **完全无载体** |
| **9.5 Priority / Deadline**（`#L486`） | **不能** | `priority`/`deadline` 字段不存在；`overdue` 只在 `projects[]` 视图（diff 盲区 1）；期望账本 deadline 不经 Graph | **完全无载体**（deadline 近似数据存在但不在 diff 面） |
| **9.6 Capacity**（`#L499`：idle slot / worker freed） | **不能** | 无 capacity/idle 字段；勉强可用「run 节点增删」当代理，但语义不等价 | **完全无载体** |
| **9.7 Expected Event Arrived**（`#L523`） | **不能** | journal 里事件**已存在**（本机 17 行 `project.expected_event_arrived`），但 Graph 词表只认 run 五型 → 只进 `skipped.unknownEventTypes`（`project.ts#L119-L123`），且 `skipped` 不进 diff | **只缺投影**（生产者已在生产跑，轻） |
| **9.8 Expected Event Timeout**（`#L545`） | **不能（在 Diff 层）** | frontier ⑧ 已实现（`frontier.ts#L297-L307`），但那是 **frontier 层 + 账本输入**，不是 `diffGraph`；账本/journal timeout 事件不进 Graph | **只缺投影**（同 9.7） |
| **9.9 Stagnation**（`#L563`：`now - last_meaningful_progress > threshold`） | **部分** | `phase: unconfirmed` 变化可 diff（节点 attrs）；但**时间基不存在**（节点只有 seq，无 `at`）→ `staleOver` 又在视图盲区 | 时间戳与 staleOver 进 diff 面=**只缺投影**；但把某个 `envelope.at` 选作「last meaningful progress」需语义规则/生产者，故整体为**混合** |

**计数**：**九类中完全能检测 1 类（9.2）；部分可检测 3 类（9.1 / 9.3 / 9.9）；不能 5 类**——其中 **2 类只缺投影（9.7 / 9.8）**、**3 类完全无载体（9.4 / 9.5 / 9.6）**（9.1/9.3/9.9 的残余缺口同表内逐条标注）。

---

## D. 最小补齐清单

### D8. 三档清单（**建议，非已验证事实**）

**必须（不补则「Graph 当决策底座」不成立）**

| # | 项 | 理由 | 量级判断 |
|---|---|---|---|
| M1 | **carrier 五字段进 diff 面**：把 `gate/needsHuman/staleOver/overdue/pidAlive` 投影进 run 节点 attrs（或给 `GraphDiff` 增加 projects 段） | 否则 §9.1/9.3/9.5/9.9 的核心信号在 diff 里是盲的（C6 盲区 1）；现状 `attention`/`phase` 因双写才可见，说明「双写进节点」是既成模式 | 轻：只缺投影（数据已在 `projects[]`），需 bump `GRAPH_SNAPSHOT_VERSION`（`collect.ts#L12-L14` R5 约定） |
| M2 | **project 节点 `status` + `needs_user` 派生投影**（B4#2/#6） | Global Master 判断「这仓现在什么状态、要不要人」是最基础两问；派生规则在 `frontier.ts#L202-L227` 已有实现可复用 | 轻：只缺投影 + 一次派生规则裁定 |
| M3 | **明确 Graph vs frontier 职责分界**（谁持有 project 级语义字段） | v0.4 §4 要求 Graph 是唯一事实源，但现状 project 级语义全在 frontier 层；不定分界，M1/M2 会做成第二份副本 | 治理：一次裁定，零代码 |
| M4 | **`next_expected_event` 进 Graph 投影**（B4#11 / §9.7 / §9.8） | 期望账本+三事件已在生产跑，是**最便宜的真字段**；且 ⑧ 现在是 frontier 与 Graph 之外的第三个输入口 | 轻：只缺投影（词表 + 节点字段 + diff） |

**应该（决定自主化的判断质量）**

| # | 项 | 分类 |
|---|---|---|
| S1 | `active_children` 计数投影（B4#9） | 只缺投影 |
| S2 | `last_meaningful_progress.at`（候选时间源为 `envelope.at`，B4#10） | 混合：时间可投影，「meaningful」事件选择规则未定义 |
| S3 | `blockers` 的 **blocked 状态聚合**到 project 节点（B4#8 半边） | 只缺投影 |
| S4 | `diffGraph` 接到唤醒/审计链路（当前零消费者，A3） | 接线（无新载体） |
| S5 | ① 的真 blocked→ready 载体（ws/task status 边沿替代 gate 近似） | 混合：状态已在节点（只缺投影 + 裁定），ready 派生需规则 |
| S6 | diff 对 `skipped.unknownEventTypes` 的可见性（否则任何新事件类型对 diff 永久不可见） | 只缺投影（结构已存在） |

**可以后补（重 / 需协议拍板）**

| # | 项 | 分类 |
|---|---|---|
| L1 | `needs_global` 生产者 + 字段（B4#5、④） | **无载体**（新协议事件 + 权威写入方，v2-b 拍板） |
| L2 | `risk` 评分与字段（B4#7、⑥、9.4、wake-gate `high_risk_failure` dormant） | **无载体**（v2-b 拍板 + 评分语义） |
| L3 | 声明式依赖边 `depends_on/blocks`（B4#8 另半边、9.1 的 dep resolved） | **无载体**（新边载体 + 生产者） |
| L4 | `priority` / 真 `deadline`（9.5） | **无载体** |
| L5 | `capacity`（9.6） | **无载体** |
| L6 | `current_goal` / `current_assignment` 的 project 归属语义 | 混合：文本已在，归属规则需裁定 |

### D9. 「无载体 vs 只缺投影」分类表（逐条 + 证据）

| 缺口 | 分类 | 证据（数据已在 / 数据不存在） | 轻重 |
|---|---|---|---|
| project `status` | **只缺投影** | runs phase 已在 `projects[]`（`types.ts#L55-L74`），frontier 已有派生实现（`frontier.ts#L202-L219`） | 轻 |
| `needs_user` | **只缺投影** | `needsHuman`（`types.ts#L67`）+ `attention`（`project.ts#L224`）已在；派生式 `frontier.ts#L222` | 轻 |
| `active_children` | **只缺投影** | `phase` 可数（`types.ts#L55-L74`） | 轻 |
| `next_expected_event` | **只缺投影** | 账本字段全（`expectations.ts#L69-L77`）+ journal 三事件（本机 44 行）；Graph 词表外（`project.ts#L119-L123`） | 轻（但要动词表/快照版本） |
| `last_meaningful_progress.at` | **混合** | 通用 `envelope.at`（`envelope.ts#L53`）未投影，但没有定义哪些事件代表 meaningful progress；时间戳可投影，语义选择仍需载体规则/生产者 | 中 |
| `blockers`（blocked 状态） | **只缺投影** | `WorkstreamStatus/TaskStatus` 含 `blocked`（`objects.ts#L31/L76`）且已进节点 status | 轻 |
| carrier 五字段进 diff | **只缺投影** | 数据已在 `projects[]`（`project.ts#L244-L256`），只是不进节点/diff | 轻 |
| 9.7 / 9.8（expected event arrived/timeout 进 Graph diff） | **只缺投影** | 生产者在跑（本机 journal 44 行 + open 账本 1 条） | 轻 |
| `current_goal` / `current_assignment` | **混合** | 文本在 mission/objective/title（`project.ts#L182/L193/L210`），**project 归属语义无定义** | 中（需裁定） |
| `last_meaningful_progress.summary` | **无载体** | 「meaningful」无定义、无写入者 | 中 |
| ① 真 blocked→ready（dep resolved） | **无载体**（依赖关系）+ **只缺投影**（blocked 状态） | `types.ts#L36-L41` 零声明式边 | 中 |
| `needs_global`（④ / 9.3 上半） | **无载体** | 全仓非测试 grep 零生产者 | 重（v2-b + 生产者） |
| `risk`（⑥ / 9.4） | **无载体** | 词表无 risk（`objects.ts#L31/L76`）；`wake-gate.ts#L53` dormant | 重 |
| `priority` / `deadline`（9.5） | **无载体** | Graph/frontier 均无该字段（`overdue` 是 timer 近似，非 deadline） | 重 |
| `capacity`（9.6） | **无载体** | 快照无 capacity/idle 概念 | 重 |
| ⑩ `ws_mail_backlog` 的 Graph 化 | **无载体**（对 Graph 而言） | backlog 是 mailbox 输入（`autonomy/collect.ts#L158`），与 snapshot 正交 | 重（= 第 5 个真相源要不要并入 Graph，需裁定） |

### D10. E3 结论复核 ✅代码已验证

**原结论**（`plans/0925_autonomy_E3_value_research.md#L13`、`#L62`）：「E3 对 ④⑥⑧ 判态收益 = 0/3」。

**复核结果**：

1. **红线仍在**：`RECORD_ONLY_NOCARRIER` 三行常量原样（`frontier.ts#L156-L159`）；④⑥ 在 `triggers` 中**无任何 push 点**（全文件 grep，仅注释/类型/常量命中）；⑧ 的 record-only 条件化逻辑仍在（`frontier.ts#L386-L391`）✅。
2. **载体是否出现**：
   - ④ `needs_global`：**仍无**（零生产者，grep 证实）✅；
   - ⑥ `risk`：**仍无**（`wake-gate.ts#L53` dormant 注释仍在）✅；
   - ⑧：**已出现**，但来源是 **0928 P2 期望账本**（`expectations.ts#L52-L54` 三事件 + `collect.ts#L339-L360 readExpectationInputs` + `/send-letter` 生产入口），**不是 E3**；本机盘面实测：`state/expectations/open/` 1 条、`events.jsonl` 44 行 `expected_event*`、`audit.jsonl` 尾部 `recordonly=2` ✅。
3. **判定**：
   - **「E3 对 ④⑥⑧ 判态收益 = 0/3」仍成立**（E3 = P-A..P-F 数据面退役，不产生任何一个新语义生产者；④⑥ 依旧无载体、⑧ 的载体与 E3 无关）✅。
   - 但该研究的**现状基线陈述已过期**：「`recordOnly` 恒 3 条」「⑧ 恒 record-only」「E3 完成后三条一行都不会变」（`#L13` 上下文、`#L197`）在 0928 P2 后**对 ⑧ 不再成立**（实测 2 条）；研究文档本身不改，**此处为任务临时发现**。
   - 研究 §8.7 提到的行号漂移（`frontier.ts#L37-L47` 实为 `#L40-L49`，`RECORD_ONLY` 实为 `#L156`）**仍存在**（v0.4 `#L1195`、`#L219` 引用 `frontier.ts#L37-L47`）⚠️。

---

## 10. 风险点与未决问题

1. **`projects[]` 视图与 `nodes` 的双写不一致**：`attention/phase/status` 双写，carrier 单写在视图 → 任何基于 `diffGraph` 的消费方都会系统性漏掉 carrier 变化（C6 盲区 1）。**这是本评估发现的最高优先级结构缺口。**
2. **Graph 无数据源故障信号**：never-throw 一路吞异常到空快照（A2），空盘面与「无事发生」不可区分；没有 `partial`/`degraded` 标记。
3. **`graph/types.ts#L7`、`graph/index.ts#L5` 头注释仍写「零生产消费者」**——与 `autonomy/collect.ts#L24-L25` 矛盾（本轮零源码改动，未修）。
4. **`registry` 读取名不副实**：`types.ts#L136` 注释暗示 masters 来自 registry，实际硬编码（`collect.ts#L87`）；多 master 场景 Graph 会静默只呈现一个。
5. **`diffGraph` 零消费者**：即使补齐字段，也不存在「diff → wake」的接线；v0.4 §9 的九类变化目前**没有任何一条走 GraphDiff**（全部在 frontier 层用 prev/next 快照对比实现）。
6. **E2.2 影子双硬门的长期有效性**：P-C（global-view 换源 Graph）后两路同源 → `unexplained=0` 退化为自比较（E3 研究 §5 已预警，本轮无新证据推翻）。
7. **`audit.jsonl` 7.8MB 无轮转**（本机实测）——与 Wiki Open Questions R5 一致，autonomy 常开的运维风险。
8. **未决**：`phase` 是否应该从 `projects[]` 视图彻底移到节点（当前双写是巧合还是约定，无文档）；`project` 节点 `status` 的派生规则该由 Graph 还是 frontier 持有（D8-M3 裁定项）。

---

## 11. 建议方向（**建议，非已验证事实**）

1. **先做 D8-M1/M2（只缺投影档）再谈协议批次**：把 carrier 与 project 级派生字段补齐进节点/diff，是让 Graph 真正成为「变化感知底座」的最短路径，且不触 `protocol.ts`、不需 v2-b。
2. **把 ⑧（期望账本）当作「只缺投影」的第一个样板**：生产者已在跑、数据结构齐、语义已拍板——投影进 Graph 后，§9.7/9.8 两类变化从「不能」升「能」，可作为 A0 验收的第一个可量化增量。
3. **④⑥ 不要塞进第一版框架**：无载体即无事实，红线 9「不猜」仍然成立；用 record-only 如实报告即可（与 R-B6 分期一致）。
4. **diff 若要服务唤醒，必须先接线（S4）并解决盲区 1（M1）**，否则 v0.4 §9 的九类变化会继续全部落在 frontier 层，Graph 只剩展示价值。
5. **⑩ 是否并入 Graph 建议单列裁定**：它是当前唯一「在 Graph 外却直接决定唤醒」的输入，长期留外面 = Graph「唯一事实源」的说法不成立。

---

## 12. Wiki 章节引用清单（跨 agent 复用）

- `Wiki/Architecture/work-graph-read-only-projection.md` — Work Graph 只读关系面契约（四对象注册/引用式边/纯投影/diff/唯一 IO/零写路径/E2.0–E2.3 全套契约）— 本轮 ✅一致采用（1 句 E2.1 陈旧陈述已 ✏️修正，见下）
- `Wiki/Architecture/work-graph-read-only-projection.md#diffGraph(prev next sinceSeq)` — diff 五元组与「无 changedEdges」— ✅一致
- `Wiki/Architecture/work-graph-read-only-projection.md#E23-单点翻转契约pi_autonomy_frontier_source缺省-v222e398a--f89abdbg-b-全部完成` — flag 语义/缺省 v2 — ✅一致（本轮补「flag 无人设置」的实测）
- `Wiki/Architecture/autonomy-suite.md#Current-Contract-v1-纯函数层3922ef4保留为休眠库资产` — 10 规则子集、`RECORD_ONLY_NOCARRIER`、⑧ 条件化 — ✅一致
- `Wiki/Architecture/autonomy-suite.md#接线落点与边界v2-已接线形态` — wake 总门/R4/开关面 — ✅一致
- `Wiki/Architecture/expectation-ledger.md#两个生产者与消费面` — ⑧ 载体、`readExpectationInputs`、record-only 条件化 — ✅一致（与本机盘面实测互证）
- `Wiki/_index.md` — 主题导航（Work Graph / Autonomy / 期望账本 三条目已覆盖本任务主题）— ✅一致

## 13. Wiki 维护记录

- ✏️ `Wiki/Architecture/work-graph-read-only-projection.md` — 更新：E2.1 章节「**零生产接线**：`frontier-input.ts` 不被任何生产文件 import」补前向指针（该陈述已被 E2.3 超越：现由 `extensions/runtime/autonomy/collect.ts#L24-L25` 条件 import，flag 缺省不走）；frontmatter `updated` → 2026-10-02。已 `wiki-nav rebuild`。
- 其余主题页（autonomy-suite / expectation-ledger / _index）核对无误，未改动。
