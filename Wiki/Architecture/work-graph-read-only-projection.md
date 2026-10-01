---
title: Work Graph 只读关系面
kind: concept
status: current
updated: 2026-10-02
source_paths:
  - extensions/runtime/graph/types.ts#L16-L192
  - extensions/runtime/graph/types.ts#L88-L97
  - extensions/runtime/graph/types.ts#L158-L187
  - extensions/runtime/graph/edges.ts#L22-L44
  - extensions/runtime/graph/edges.ts#L52-L136
  - extensions/runtime/graph/project.ts#L84-L347
  - extensions/runtime/graph/diff.ts#L31-L72
  - extensions/runtime/graph/collect.ts#L56-L124
  - extensions/runtime/graph/collect.ts#L97-L109
  - extensions/runtime/graph/collect.ts#L244-L301
  - extensions/runtime/frontier-carriers.ts#L108-L359
  - extensions/runtime/global-view.ts#L88-L90
  - extensions/runtime/global-view.ts#L539-L541
  - extensions/runtime/autonomy/frontier.ts#L202-L231
  - extensions/runtime/graph/frontier-input.ts#L16-L76
  - extensions/runtime/autonomy/frontier.ts#L110-L142
  - extensions/runtime/autonomy/collect.ts#L112-L131
  - extensions/runtime/autonomy/collect.ts#L153-L171
  - extensions/runtime/autonomy/collect.ts#L24-L25
  - extensions/mailbox-consumer.ts#L65-L70
  - extensions/_test_graph_frontier_input.ts#L263-L398
  - extensions/_test_graph_frontier_shadow.ts#L119-L243
  - extensions/_test_graph_frontier_shadow.ts#L433-L452
  - extensions/_test_graph_frontier_shadow.ts#L775-L830
  - extensions/_test_graph_frontier_shadow.ts#L859-L1035
  - extensions/runtime/graph/index.ts#L7-L11
  - extensions/_test_runtime_graph.ts#L87-L498
  - extensions/_test_frontier_attention_window.ts#L1-L30
---

# Work Graph 只读关系面

## Summary

Work Graph（E1 MVP）= 本仓既有四对象（Master / Workstream / Task / Run）之上的**只读关系面**：以 journal + tab-runs 账本 + workstreams 显式库 + **期望账本 open 列表（⑧）**为输入，提供对象注册、跨对象**引用式边**、`diff(since)` 与 project 级派生字段查询。它是这些既有真相源的**投影与求值器，不是任何一家的替代者**——对齐 `plans/global_work_graph_service_v0.2.md` §6A 边界裁定 (a)：不替代 tab-runs 判态机 / recentwork 时间线，只弱耦合引用。

E1 形态 = **影子运行**：纯库 + 零生产接线（无消费者），单 commit 可 revert；`RuntimeSnapshot v1` / `protocol.ts` / `index.ts` / A10.1 allowlist 均未变。**现状（2026-10-02）**：E2.3 起 `autonomy/collect.ts` 按 env 单点消费 Graph 快照；`mailbox-consumer.ts` 进程缺省注入 `PI_AUTONOMY_FRONTIER_SOURCE=graph` → **生产 frontier 数据源缺省 = graph**（快照 schema v2，见「快照 v2 扩字段」与「E2.3 契约」）。`RuntimeSnapshot v1` / `protocol.ts` / A10.1 allowlist 至今未变。

## Current Contract

### 四对象注册 + project 别名节点

`projectGraph(input)`（`project.ts#L105`）产出 `GraphSnapshot`（`types.ts#L106`）：`nodes` 覆盖 Master（缺省 `[master_default]`，`types.ts#L146`）、Workstream、Task、Run（journal 投影）四对象；`project:<normalizedRepoPath>` 是**别名节点**（`projectNodeId`，`edges.ts#L42`），不是第五种真相源。

### 引用式边（仅三来源，零声明式载体）

`deriveEdges`（`edges.ts#L52`）只从既有载体派生，**不做** `depends_on`/`blocks`/`requires`：

| 边 | 载体 | 备注 |
|---|---|---|
| `task → workstream` | `TaskRecord.workstreamId` | 指向不存在 ws → 不产边（孤儿不猜） |
| `run → externalTaskId`（`run_task`） | run payload `externalTaskId` ↔ `TaskRecord.externalTaskId` | 无 task 命中 → 不产边 |
| `run → subject`（`run_subject`） | `envelope.subject` | 身份自环边（`from===to===subject`，仅 journal 源 `firstSeq>0`） |
| `run → workstream`（`run_workstream`） | `WorkstreamRecord.taskSelector` | `runSubjects` 精确优先；否则 `externalTaskIds` best-effort（`match` 标注） |
| `workstream → repoPath`（`workstream_project`） | `WorkstreamRecord.workspaceRef` | **弱载体**：`agent://` 等逻辑地址 / 无值 → 省略边（`isPathShapedRef`，`edges.ts#L33`） |

边按 `kind,from,to` 升序排序（确定性）。

### projectGraph 纯投影

`projectGraph`（`project.ts#L105`）零 IO、同输入同输出：Run 语义镜像 `projector.ts`（dedupeKey 幂等、terminal 优先不回退、孤立终态 pending 配对、未知 type 记 `skipped.unknownEventTypes` 不抛、`run.launch_failed → failed`）。**终态状态恒由事件 type 派生**（`terminalStatusFromType`）——与 projector 同口径，两者都**不读** `envelope.payload.status`（真实发射点 type / payload.status 恒一致，`adapters/tab-run.ts`）。`nodes`/`edges`/`projects` 全排序后冻结。

### diffGraph(prev, next, sinceSeq)

`diffGraph`（`diff.ts#L31`）纯函数：按 `sinceSeq` 计算 `addedNodes`/`removedNodes`/`changedNodes`（`JSON.stringify` 深比较）与 `addedEdges`/`removedEdges`（键 `kind|from|to`；**无 changedEdges**）。`prev=null` → 全量 baseline。

### collectGraphInput = 唯一 IO

`collect.ts` 是 graph 模块中**唯一**做 IO 的文件：`collectGraphInput`（`collect.ts#L56`）只读装配 `scanJournalSeq`（journal+seq）/ `listWorkstreams`+`listTasks`（显式库）/ tab-runs 账本（`composeTabStatus` phase 结论 + `findRepoRoot(cwd)` repoPath 引用）/ **期望账本 open 列表**（`listOpenExpectations`，`collect.ts#L97-L109`，坏 `deadlineAt` 丢弃不猜、空数组删键）；never-throw（IO 失败收敛空输入）。`readGraphSnapshot`（`collect.ts#L118`）= `projectGraph ∘ collectGraphInput` 快捷方式。

### 零写路径

`graph/**` 无业务态 writer：不写 journal / tab-runs / workstreams / registry。E2.0 起新增 `state/work-graph/<scope>.json` **只读派生缓存**（O-C：可删，缺失等同无缓存；纯函数层 `types`/`project`/`edges`/`diff` 仍零 IO，唯一写者 `graph/collect.ts::writeGraphSnapshotCache`）。`index.ts`（`index.ts#L7`）导出面全为纯函数 + 类型。

### E2.0 载体对齐与共享归约

E2.0 把 frontier 消费的载体补齐到 Graph 只读投影，并把 carrier 归约抽成单一真相源（仍为影子运行，零生产接线；`RuntimeSnapshot v1`/`protocol.ts`/A10.1 allowlist 未变）：

1. **`GraphRunRef` 增 carrier 字段**（`types.ts#L55`）：`gate` / `needsHuman` / `staleOver` / `overdue` / `pidAlive`；`projectGraph`（`project.ts#L215-L219`）**恒赋**，carrier 缺 → **null 不猜**。`GraphRunCarrier`（`types.ts#L76`）为上述五字段的子集输入。2026-10-02 起同五字段**双写进 run 节点 `attrs`**（diff 盲区 1 已修，见「快照 v2 扩字段」）。
2. **`GraphSnapshot.history` 仅观测载体，不参与 frontier 输入**（`types.ts#L106`）：hidden tab 的 `{id, reason}`，按 id 升序；E2.1 `toFrontierInput` 恒 emit `[]`（MF1）。v2 生产路径 `collect.ts` 不传 history → 快照不发出该键（保持 E1 快照形状向后兼容）。
3. **`state/work-graph/<scope>.json` 只读缓存**（O-C）：唯一写者 = `graph/collect.ts`（`writeGraphSnapshotCache` `collect.ts#L244`，tmp+rename 原子写，tmp 名含 pid+时间戳+计数器防同进程并发冲突）；`readGraphSnapshotCache`（`collect.ts#L293`）容忍缺失/坏 JSON/版本不符，并做 **carrier/history 子结构校验**（旧形无 carrier 键 → 拒绝，防 E2.1 读出后 carrier 全 null 致 watchdog 检查 6 静默失活）；约定 `GRAPH_SNAPSHOT_VERSION` 随 schema 扩字段必须 bump（**已执行 1 → 2**，见「快照 v2 扩字段」）。
4. **`frontier-carriers.ts` 是 carrier 归约的唯一真相源**（`runtime/frontier-carriers.ts`）：`reduceTabCarrier`（`#L243`）/ `collectTimerByRepo`（`#L314`）/ `classifyDispatch`（`#L139`），由 `global-view.ts`（`#L212`/`#L389`/`#L359`）与 `graph/collect.ts`（`#L165`/`#L146`/`#L140`）**共用同一实现，禁止各写一份**；**时钟可注入**：`classifyDispatch(rec, runsDir, now?)` 与 `classifyTabStatus`/`composeTabStatus` 的可选 `now` 均**缺省 `Date.now()`**（2026-10-02 起，orphaned-grace 判定不再各自读墙钟，由调用装配的时钟统一提供；未传的既有调用方零行为变化），两处生产装配传入自身作用域的 `now`；`global-view.ts` 以 re-export 保持原导出面（`readGateStatus`/`TabDetail`/常量等）。

### G-A 语义修复契约：attention 载体（分页前全量投影；`93f8447` 生产 + `fae1aa2` 测试补强）

**latent bug**：frontier ⑤（`needs_user`）曾消费 `snapshot.home/rows`（GUI 分页后投影，生产实参 `page=1/pageSize=20`）→ >20 仓时页外 attention 仓**漏触发** `needs_user`；且仅改显示排名会产生**假边沿**——⑤ 触发集合成了显示排序/页码的函数。

**修复契约（`GlobalViewSnapshot.attentionByRepo`）**：

- **分页前全量投影**：`global-view.ts#L539-L541` 在 `allRows` 构造完成、`slice` **之前**聚合；键 = `normalizeExactPath(repoPath)`，仅含 `attention>0` 条目，与 `rows[].attention`/`totals.attention` 同源（同一 `allRows`/`aggs` 派生，零新计算）。
- **必填**：`global-view.ts#L90` 为非 optional `Record<string, number>`；主 return（`#L610`）与 never-throw catch return（`#L624`，`{}`）均给值。
- **缺项 = 0**：消费者 `frontier.ts#L201` 直接取用、`#L216` 以 `attentionByRepo[k] ?? 0` 查询；**缺项表示该仓 attention 为 0**，不得把「键存在」当作「仓存在」（仓存在由 `details`/`tabsByRepo` 决定）。
- **Σ 不变量**：`sum(Object.values(attentionByRepo)) === totals.attention`（同仓多计数、空输入、catch 三路径均有机器断言）。
- **⑤ 不再读分页**：`grep "snapshot.rows\|snapshot.home" extensions/runtime/autonomy/frontier.ts` 为空；⑤ 算法体（`frontier.ts#L170` 判据 / `#L257` 边沿）未改。
- **GUI 分页契约未变**：`rows`/`cursor`/`formatGlobalView`/`globalViewLogic` 的 tool `details` 逐字节不变；新字段不进 details。

**迁移**：schema 未变（双向切换共用同一 `state/autonomy/frontier.json`，无需数据迁移）；旧 prev 页外仓 `needsUser=false` → 新语义首帧每仓**一次性** `needs_user` 补报（已批准，靠既有 wake-gate debounce(2s)/cooldown(15s) 合并）；**不清空 prev**（清空会吞掉真实边沿）。M1/M2/M3 机器测试覆盖旧 prev 一次性补报、legacy↔new 双向反复切换（每仓 ⑤≤1、同口径连续帧 0、稳定帧 msv 不变）、新语义连续三帧 msv 不变。

**双 normalizer tripwire**：`global-view` 用 `recent-scopes.ts` 的 `normalizeExactPath`，`frontier` 用本地副本（为保持依赖图零 `node:fs`）；两份实现必须同口径——**单侧改动会静默表现为 attention=0**（键错配）。`_test_frontier_attention_window.ts` K1 用大小写/分隔符变体路径把「两 map 键集合逐字相等」钉死。

### E2.1 契约：`toFrontierInput` 适配器（Graph → frontier 输入；E2.1 阶段零接线，E2.3 起条件接线）

E2.1 新增**纯函数** `toFrontierInput(snap, {now})`（`graph/frontier-input.ts#L55`）：把 `GraphSnapshot` 投影为 `FrontierSourceSnapshot`（`autonomy/frontier.ts#L123`，其 `FrontierSourceTab` `#L110`），为 E2.2 影子对照冻结输入契约。**零生产接线（E2.1 阶段快照，已被 E2.3 超越）**：`frontier-input.ts` 当时不被任何生产文件 import，只被 `_test_graph_frontier_input.ts` 消费（`extensions/index.ts`/`graph/index.ts` 未加导出面）；**E2.3 起已由 `extensions/runtime/autonomy/collect.ts#L24-L25` 条件 import（env `PI_AUTONOMY_FRONTIER_SOURCE==="graph"` 才走；collect 层判定缺省 v2，但生产进程由 `mailbox-consumer.ts#L70` 缺省注入 graph，见下方 E2.3 契约）**；`autonomy/frontier.ts` 仅做**类型放宽**（`FrontierInputs.snapshot` 改结构化接口 `#L131`，`buildFrontier` 算法体与 v2 调用点零改）。

契约（`frontier-input.ts#L16-L76`）：

- **纯度**：零 IO、零墙钟、零随机、确定性；两 `import` 均为 `import type`（零运行时依赖）。T8 以**源码读取守卫**（`readFileSync` 直读生产源码做 substring 断言，**非 shell grep**）把 `node:fs`/`Date.now`/`Math.random`/`writeFile`/`toLowerCase`/`toLocaleLowerCase`/`replace(`/`function|const|let|var normalize`/`normalize =`/两既有 normalizer 调用列入**零路径转换白名单**（`_test_graph_frontier_input.ts#L263`）。
- **R4 单一口径**：直接把 `GraphProjectView.project`（已由 `normalizeRepoKey` 归一）写入 `attentionByRepo` 键与 `details[].repoPath`（`frontier-input.ts#L60`）——**不做任何转换、严禁自写第三份 normalizer**；`normalizeRepoKey` ≡ `normalizeExactPath` 逐字节同体，由 T4 机器钉死。
- **`now` 来源**：`FrontierInputOptions.now` 必填（`#L16`），**不使用 `snap.asof`**（`collect.ts#L110` 缺省不发出 → 采用会得 `undefined`）；适配器自身不消费墙钟，`now` 由调用方以同一值透传 `buildFrontier`（T11 断言 `next.asof === opts.now`）。
- **`history` 恒 `[]`**（MF1）：不读 `snap.history`（`#L75` 字面量）；填充会造出 v2 生产从不产的 ②③ hidden 触发（T6 双向反例）。
- **attention 全量无裁剪**：仅 `attention > 0` 写键（缺项 = 0，`#L59-L60`），无窗口裁剪；键/值逐字等于 v2 `attentionByRepo`（G-A 全量口径）。
- **details 成员过滤 + 确定性**：仅 carrier 存在（`gate`/`needsHuman`/`staleOver`/`overdue` 非 null）且 `project`/`phase` 非 null 的可见 tab 进 `details`（`#L27-L47`，缺 carrier 不猜、`pidAlive=null` 合法保留）；按 `runId` 升序，**重复 `runId` 时按 `repoPath` 升序 tie-break**（`#L70`，T15）。

验证：T1–T15 全绿（`_test_graph_frontier_input.ts`，含 T9 双路径结构等价：同 fixture 帧0 `JSON.stringify` 严格全等、帧1 canonical 全等且含非 mailbox 边沿 `working_to_completed`/`stagnation`/`needs_user`；T9 端到端覆盖 `staleOver=true`/`needsHuman=true`/`pidAlive=false`）。

### E2.2 影子对照契约：`_test_graph_frontier_shadow.ts`（测试态，零行为；`de84baa` + `154bf8d`）

E2.2 = **G-B 核心验收件**：在**测试态**逐项对照 v2 生产路径与 graph 路径，证明「Graph 派生输入 ≡ v2 生产输入」。**零生产接线、零行为**：不 import 进 `extensions/index.ts`/`protocol.ts`/`autonomy/collect.ts`；只写临时 `<tmp>/state/work-graph/shadow.jsonl`，不碰生产 `state/autonomy/audit.jsonl`（`_test_runtime_autonomy.ts` A10.1 排除列表 +1 行，ALLOW 仍恰 3）。

**两路装配（唯一自变量 = snapshot 载体）**：同一 fixture、同一 `(backlog, prev, now)` 下——

- v2：`collectGlobalView({agentDir, now, gitProbe})` → `buildFrontier`（**不传 `history`** → `history≡[]`，MF1）；
- graph：`readGraphSnapshot({journalPath, stateDir, tabRunsDir, sessionsRoot, timersDir, now})` → `toFrontierInput(gSnap,{now})` → `buildFrontier`；
- `backlog`（一次 `mailboxBacklog()`）/`prev`（同一对象）/`now`（同一标量）两路共享；每帧断言 `next.asof === NOW`（`#L433`）。

**O-B 行 schema**（`shadowCompare`，`#L222`，纯函数、零 IO）：`{ at, scope, itemKind: "snapshot"|"project"|"run"|"trigger"|"recordOnly", nodeId, v2Value, graphValue, verdict: "same"|"explained"|"unexplained", reason? }`。五源：snapshot（baseline/asof）· project（`msv` 折入本行）· run（carrier 七字段根因定位）· trigger（语义键 `rule|project|evidence`，`groupByKey` **数组保重复不折叠**，`#L198`）· recordOnly（存在性）。

**canonical 序**（`deepSort`，`#L134`）：对象键递归排序（消 `runs` 键序）；数组按**语义键**排序——`triggers` 按 `rule|project|evidence`、`details` 按 `runId|repoPath`（下标序不参与）。canonical 序只消序、不抹值。

**双硬门（不可协商）**：`rows.filter(unexplained).length === 0` **且** `rows.filter(explained).length === 0`——`WHITELIST = []`（空集，`#L119`）：G-A 后 v2 已消费全量 attention，任何差异都是真差异；`explained>0` 即「有人往白名单塞未批准条目」→ 失败。另加 DoD-3 全等：`canonicalJson(v2.next) === canonicalJson(graph.next)` 且 `diff` 同理（全 33 帧）。

**`unexplained=0 explained=0` 是 E2.3 翻转的硬门证据**（`0924_graph_E2_impl_plan.md#6`：翻转 commit 前必须附该机器输出原文）。实测：`frames=33 rows=623 same=623 triggerRows=10 unexplained=0 explained=0`，21 checks，exit 0。

**篡改反向实验证明 harness 非恒真假绿**：在 graph-only 输入注入 `attentionByRepo[首个正键]:=0` → 进程 **exit 1**、S2/S3/S4/S6/S11/S12×4/S13/S16/S17 失败、`unexplained=15 explained=0`（S17 打印 `unexplained=15 → s2@f2/project/…: needsUser …`）。该实验已落成**受控自检**（`E22_REVERSE_SELFTEST=1`，缺省关闭）：篡改 graph-only 输入 → 断言 O-B 必报 `unexplained>0`（判别力有效时自检通过、进程仍 exit 0），供未来改 canonical/verdict 时复验（`#L796-L815`）。

**E2.2 L4 收尾（`154bf8d`）**：S8a 固定时钟（`dispatchedAtMs = NOW - 60_000`，去 `Date.now()`；2026-10-02 进一步把 orphaned-grace 的时钟注入贯通——见「唯一真相源」的时钟可注入契约，S8a 由 FAIL 转绿）；trigger Map 改 `groupByKey` 数组保 multiplicity；S16 显式断言输入分叉（graph 源 journal cwd lower-case vs v2 源账本 cwd upper-case 变体 → 归一键唯一，`#L742`）；反向自检 helper。

### E2.3 单点翻转契约：`PI_AUTONOMY_FRONTIER_SOURCE`（collect 层判定缺省 v2；生产进程缺省注入 graph；`22e398a` + `f89abdb` + `mailbox-consumer.ts` 单行注入）——**G-B 全部完成**

E2.3 = G-B 最后一环：把 `autonomy/collect.ts` 的 frontier 数据源做成**单点二选一**（`collect.ts#L153-L156`）。落地后 **G-B（来源翻转）全部完成**：E2.1 适配器 + E2.2 影子双硬门 + E2.3 生产接线。**2026-10-02 起生产实跑 graph 路**（见下方“缺省注入”）。

- **单点开关（collect 层判定不变）**：`process.env.PI_AUTONOMY_FRONTIER_SOURCE?.trim() === "graph"` **才**走 Graph（`readGraphSnapshot`→`toFrontierInput`）；**collect 层判定下缺省/其它任何值（含 `""`/`"v2"`/`"graphx"`/`"GRAPH"`）= v2**（`collectGlobalView`）——此为 `collectAutonomyInputs` 单函数语义，S18/S21 断言仍钉在此层。**不写 `config.json`**、**不新增 `collectAutonomyInputs` opts**、`graph/**`/`autonomy/frontier.ts`/`protocol.ts`/`index.ts`/`package.json` 零改。**单 commit 可 revert**（`git revert 22e398a` 即回缺省 v2，无状态迁移）。
- **生产缺省注入 graph（2026-10-02 起）**：`extensions/mailbox-consumer.ts#L70` 顶部单行 `if (!process.env.PI_AUTONOMY_FRONTIER_SOURCE) process.env.PI_AUTONOMY_FRONTIER_SOURCE = "graph";` —— 进程**未预设（undefined/空串）→ 注入 `"graph"`**；**外部预设非空值优先**（如 `PI_AUTONOMY_FRONTIER_SOURCE="v2"` → 不覆盖，逃生舱保留）。注入点选在本文件：生产唤醒链 `evaluateWakes → evaluateAutonomyWakeGate → collectAutonomyInputs` 在本进程（pi 扩展宿主，本文件由 `index.ts` 注册）执行；`daemon/server.ts` 不跑 `evaluateWakes`，故 daemon 内注入无效。**revert 本行即回“collect 层缺省 v2”、无状态迁移**（`frontier.json` 两版 schema 兼容、prev 不清空）。S18/S21 的“缺省=v2”断言仍成立——测试直调 `collectAutonomyInputs`、不加载 `mailbox-consumer.ts`。
- **graph 路参数分叉防护**：graph 分支经 **graph-only helper `graphFrontierSnapshot`**（`collect.ts#L119`）派生 `agentDir = opts?.agentDir ?? defaultAgentDir()`，并**显式传 `tabRunsDir`/`sessionsRoot`/`timersDir`**（均从同一 `agentDir` 派生）。必须显式传：`readGraphSnapshot` 缺省 `tabRunsDir = PI_TAB_RUNS_DIR || defaultTabRunsDir()`（`graph/collect.ts#L60`）会与 v2 的 `join(agentDir,"tab-runs")` 分叉（S20 decoy 断言钉死）；`journalPath` 不传（生产默认 `defaultRuntimeDir()/events.jsonl`）。
- **v2 分支保留原调用形状**（L4 必须修，`f89abdb`）：v2 分支字面量为 `collectGlobalView({ agentDir: opts?.agentDir, now })`——**不在共同分支预先解析 `agentDir`**，使 `defaultAgentDir()` 仍归 `collectGlobalView` 自己的 `try`（异常边界与改造前逐字节等价；S22 源码形状 + 异常边界用例钉死）。graph 分支的 `defaultAgentDir()` 归外层 `collectAutonomyInputs` 的 try（opt-in 路，有意不对称）。
- **等价基准**：缺省 v2 行为逐字节不变（S18 比较 canonical + **写出的 `frontier.json` 原始文本** + watchdog/audit 可观测）；`flag=graph` 与 v2 canonical 全等（S19；原始文本 `runs` 键序差异仅 `runId` vs `rankDetail`，不参与消费）；`enabled=false` 零行为（S21b）。**`frontier.json` 两版 schema 兼容**：同一个 `buildFrontier` 产 `FrontierSnapshot`，`readFrontierSnapshot` 仅校验 `asof/projects/triggers/baseline`；不清空 `prev`、双向切换共用同一文件。
- **测试**：`_test_graph_frontier_shadow.ts` S18–S23（缺省=v2 / graph 等价+序指纹 / decoy `PI_TAB_RUNS_DIR` / 非 graph 值=v2 / enabled=false 零行为 / `agentDir` 未传形状与异常边界 / graph flag `pidAlive=false` 的 watchdog `runStateMismatch` 端到端），**28 checks**；`E22_REVERSE_SELFTEST=1` → 29 checks、`unexplained=1`。E2.2 影子双硬门仍 `unexplained=0 explained=0`（`frames=33 rows=623 same=623`）。

### 快照 v2 扩字段：run attrs carrier 双写 + project 节点派生字段 + ⑧ 期望投影（`GRAPH_SNAPSHOT_VERSION=2`，2026-10-02）

schema 扩字段按 R5 约定 bump：`GRAPH_SNAPSHOT_VERSION` **1 → 2**（`types.ts#L167`；`GraphSnapshot.version` 字面类型同步为 `2`，`types.ts#L107`）。`readGraphSnapshotCache` 的 `isCurrentSnapshot` 版本不符即拒（`graph/collect.ts#L269`）→ 旧 v1 缓存自动作废（行为同无缓存，无迁移）。

1. **run 节点 `attrs` 双写 carrier 五字段（盲区 1 已修）**：`gate`/`needsHuman`/`staleOver`/`overdue`/`pidAlive`（源 `input.runCarriers?.[subject]`，缺 → null 不猜）与既有 `attention`/`phase`/`status` 同模式写进 run 节点 `attrs`（`project.ts#L263-L281`）→ `diffGraph.changedNodes`（整节点 `JSON.stringify` 深比较，`diff.ts#L53`）**可见 carrier 变化**——此前 carrier 单写在 `projects[]` 视图、diff 面全盲（C6 盲区 1）。`projects[]` 视图本身不变，`toFrontierInput` 输入面零漂移。
2. **project 节点派生字段**（`project.ts#L287-L315`，派生规则与 frontier `aggregateProject` 同体、不引入第二套语义）：
   - 节点级 `status`：`projectStatusFromPhases`（`project.ts#L88-L97`，非终态任一 → Working；全终态 → Failed > Cancelled > Completed；无 run → Working）。
   - `attrs.needsUser`：任一 run `needsHuman===true || gate==="awaiting"` ∨ `attention>0`（`project.ts#L293`，同 frontier ⑤ 判据）。
   - `attrs.activeRunning` / `attrs.activeWaiting`（active_children）：非终态 run 计数，`waiting` 单列（`project.ts#L294-L296`）。
   - `attrs.nextExpectedEventType` / `attrs.nextExpectedEventDeadline`：见下 ⑧ 投影。
3. **⑧ 期望账本 → Graph 只读投影**：
   - **词表**：`GRAPH_EXPECTED_EVENT_TYPES`（`types.ts#L183-L187`，`project.expected_event_{set,arrived,timeout}` 三型）入 Graph 词表 → 不记 `skipped.unknownEventTypes`（`project.ts#L141-L147`；仅识别、不产 run 节点，非 run:// 寻址）。
   - **输入**：`GraphInput.openExpectations?: GraphExpectationRef[]`（`types.ts#L158`；结构 `types.ts#L88-L97`：`project`/`expectedType`/`deadlineAt`/`requestId`），由 `graph/collect.ts#L97-L109` 只读装配（`listOpenExpectations`；never-throw；坏 `deadlineAt` 丢弃不猜；空数组删键）。
   - **投影**：`project.ts#L227-L233` 每 project 取**最早 deadline** 的 open 期望 → `attrs.nextExpectedEventType/Deadline`（无 → 双 null）；**仅 expectation 归属的项目也生成 project 节点**（`project.ts#L191-L193`，不依赖 run/attention/workstream 在场；`project=null` 即未归因 → 不映射）。
   - **frontier ⑧ 输入不变**：frontier ⑧ 触发仍走 `autonomy/collect.ts::readExpectationInputs`（`#L167`），与 frontier source 选哪条分支**正交**（`collect.ts#L164-L166` 注释：frontier ⑧ 走本层、Graph 侧另只读装配进 project 节点投影）；Graph 侧纯投影、不写账本、不动 `protocol.ts`。
4. **约束不变**：Graph 仍是只读关系面——本扩字段不新增任何写路径（零写路径节仍成立）；A10.1 allowlist 不扩（`graph/collect.ts` 仅 import `expectations.ts` 的 `listOpenExpectations`，不 import `runtime/autonomy/**`）；`history` 仍不进 frontier 输入（MF1）。

## Evidence

- E1 测试 13 组（`extensions/_test_runtime_graph.ts#L87-L311`）：空输入 / 单对象 / 边三来源 / 孤儿引用 / dedupe 幂等 / 乱序 terminal / diff 边界 / 确定性+路径口径 tripwire / 10k 性能 / 未知事件 / workspaceRef 弱载体 / 坏行只读 / replay 等价 + collect 装配；T13 含病态事件（type 与 payload.status 矛盾）下 Graph ≡ projector 的等价断言。
- 实测数字：10_000 合成事件 `projectGraph` 约 11–16ms（预算 2000ms；多次运行波动）。replay 等价 `replayEquivalenceDiff === []`；Graph run `status` 与 `projector.rebuildFromEnvelopes` 逐 run 相等。
- 回归全绿：`test:runtime-projector` / `test:runtime-workstream` / `test:runtime-snapshot` / `test:tab-runs` + `_test_runtime_autonomy.ts`（57 checks，A10.1 allowlist 未扩）。
- L4 独立审查（`plans/0924_graph_E1_l4_review.md`）：**PASS**（必须修 0；建议修 5）。
- E2.0 载体对齐 + 共享归约（`7672771`+`ed5278a`，L4 `plans/0924_graph_E2_0_l4_review.md` **PASS**）：`_test_graph_carriers.ts` 5 组（legacy oracle 双跑 + `collectGlobalView` 全量 golden 入库，路径归一化、固定 now）；`_test_runtime_graph.ts` 13/13（T13 快照形状零漂移）；`_test_runtime_autonomy.ts` 57 checks（A10.1 allowlist 仍恰好 3）；`test:global-view`（含 M1 golden）绿。行为保持由 pre/post golden 逐字节复现证明。
- G-A 语义修复（`93f8447` + `fae1aa2`；L4 `plans/0924_attention_semantics_fix_l4_review.md` **PASS-with-fixes**，必须修 M2 已闭环）：`_test_frontier_attention_window.ts` 18 checks（P0 十条翻转 + N1-N4 + M1/M2/M3 + K1 tripwire）；规模 19/20/21/40 四档页外漏检=0、假边沿=0；`test:global-view` M1 byte-identical + Σ 不变量三路径；`_test_runtime_autonomy.ts` 57 checks（A10.1 ALLOW 仍恰 3）；`_test_graph_carriers.ts` 5/5（golden 仅加性新增 `attentionByRepo` 一个键）；其余 runtime 回归全绿。
- E2.1 适配器契约（`b59ee68` + `513623c`；L4 `plans/0924_graph_E2_1_l4_review.md` **PASS-with-fixes**，2 必须修 + 3 建议修已闭环）：`_test_graph_frontier_input.ts` **15/15**（T1–T15：T8 源码读取守卫扩零路径转换白名单、T9 `FAR_PAST` 相对固定 `NOW` + 双路径双帧非 mailbox 边沿、T15 重复 runId tie-break）；`frontier-input.ts` 零生产接线（`rg -l frontier-input extensions --include=*.ts` 仅命中自身 + 测试）；回归 `_test_runtime_autonomy.ts` 57 checks（A10.1 ALLOW 仍恰 3）/ `_test_runtime_graph.ts` 13/13 / `_test_graph_carriers.ts` 5/5（golden 未变）/ `_test_frontier_attention_window.ts` 18 + `test:global-view` + 6×npm 全绿。
- E2.2 影子对照 harness（`de84baa` + `154bf8d`；L4 `plans/0924_graph_E2_2_l4_review.md` **PASS-with-fixes**，1 必须修 + 3 建议修已闭环）：`_test_graph_frontier_shadow.ts` **21 checks，exit 0，`frames=33 rows=623 same=623 triggerRows=10 unexplained=0 explained=0`**（双硬门 + DoD-3 canonical 全等 33 帧）；篡改反向实验 **exit 1 / `unexplained=15`**（非恒真假绿）；`E22_REVERSE_SELFTEST=1` 自检报 `unexplained=1`；`_test_runtime_autonomy.ts` 57 checks（ALLOW 仍恰 3）/ `_test_graph_frontier_input.ts` 15/15 / `_test_frontier_attention_window.ts` 18 / `_test_runtime_graph.ts` 13/13 / `_test_graph_carriers.ts` 5/5（golden 未变）+ `test:global-view`/`runtime-projector`/`workstream`/`snapshot`/`tab-runs`/`runtime-wake`/`local-master` 全绿。
- E2.3 单点翻转（`22e398a` + `f89abdb`；L4 `plans/0924_graph_E2_3_l4_review.md` **PASS-with-fixes**，1 必须修 + 建议修已闭环）：`_test_graph_frontier_shadow.ts` **28 checks，exit 0，`frames=33 rows=623 same=623 unexplained=0 explained=0`**（S18–S23：缺省=v2 等价 / graph 等价+序指纹 / decoy `PI_TAB_RUNS_DIR` / 非 graph 值=v2 / enabled=false 零行为 / `agentDir` 未传形状与异常边界 / graph flag `pidAlive=false` `runStateMismatch` 端到端）；`E22_REVERSE_SELFTEST=1` **29 checks**、`unexplained=1`（判别力有效）；`_test_runtime_autonomy.ts` 57 checks（A10.1 ALLOW 仍恰 3、A11.2 零新文件）/ `_test_graph_frontier_input.ts` 15/15 / `_test_frontier_attention_window.ts` 18 / `_test_runtime_graph.ts` 13/13 / `_test_graph_carriers.ts` 5/5（golden 未变）+ `test:global-view`/`runtime-projector`/`workstream`/`snapshot`/`tab-runs`/`runtime-wake`/`local-master` 全绿。
- 快照 v2 扩字段 + 生产缺省 graph 源（2026-10-02 实测）：`_test_runtime_graph.ts` **16/16**（新增 T14 carrier 五字段进 diff 面 / T15 project 节点派生字段 status·needs_user·active_children / T16 next_expected_event 词表+节点字段+diff）；`_test_graph_frontier_input.ts` **15/15**；`_test_graph_carriers.ts` **5/5**（legacy oracle 双跑 + golden 未漂移）；`_test_runtime_autonomy.ts` **60 checks**（A10.1 ALLOW 仍恰 3、A12 ⑧ 语义）。`_test_graph_frontier_shadow.ts`：**S18–S23 全绿** + O-B 硬门 `frames=34 rows=627 same=627 triggerRows=9 unexplained=0 explained=0`（v2/graph 两路 frontier canonical 全等——graph 侧新增节点 attrs 字段不进 `toFrontierInput`，frontier 面零漂移）。**S8 残留已闭环（2026-10-02）**：S8（⑨ stagnation resultMissing 分支）的 FAIL 根因 = `classifyTabStatus` 的 orphaned-grace 分支读墙钟 `Date.now()`，fixture 固定 `NOW=2026-09-24` 时必然超 5min grace → 两路同判 orphaned/hidden → details 无该 run（O-B 因两路同丢而不报警）。修复 = 时钟注入贯通（`classifyTabStatus`/`composeTabStatus` 可选 `now` 缺省 `Date.now()`，`classifyDispatch` 第三参透传，`global-view.ts` 与 `graph/collect.ts` 两装配点传注入时钟；生产默认行为不变）。修复后 `_test_graph_frontier_shadow.ts` **29/29、exit 0、`unexplained=0 explained=0`**，`E22_REVERSE_SELFTEST=1` **30/30**（判别力保持）；`_test_graph_carriers.ts` 5/5、`_test_tab_runs.ts`/`_test_global_view.ts`/`_test_frontier_attention_window.ts` 18/`_test_runtime_graph.ts` 16/16/`_test_runtime_autonomy.ts` 60/60 全绿。

## Links Out

- [[Wiki 索引]]

## Backlinks

- [[Wiki 索引]]

## Open Questions

- **attention 当页窗口口径（MF2）**：~~E2.0 未动 v2 `frontier.ts` rows 当页 slice 口径；`attentionWindow` 参数零实现。E2.1/E2.3 翻转前的 attention 口径仍待用户裁定。~~ **已由 G-A 修复（`93f8447`）**：frontier ⑤ 改为消费分页前全量 `GlobalViewSnapshot.attentionByRepo`（见 Current Contract「G-A 语义修复契约」），`attentionWindow` 仍零实现但不再构成 latent bug；G-B `toFrontierInput` 须从 graph `projectAttention`（全量归约）填充该字段，**不得**引入窗口裁剪。
- **~~`asof` 缺省不发出~~ 已闭合（E2.1）**：`toFrontierInput` 取 `opts.now` 必填、**不使用 `snap.asof`**（`collectGraphInput` 仅在显式提供 `opts.asof` 时透传）；`now` 由调用方以同一值透传 `buildFrontier`（见 Current Contract「E2.1 契约」）。
- **弱载体残余**：`isPathShapedRef` 对含 `/` 的自由字符串（如 `a/b` 标签）判为路径形 → 伪 project 节点（已测试固化，属 best-effort 已知残余）。
- **`run_subject` 自环 / 无 changedEdges**：`diffGraph` 边只按键增删，evidence/match 标注变化不可见；E2 文档需显式声明。
- **双 `findRepoRoot` 口径（E2.1 已定单一口径；E2.3 已闭合）**：共享版用 `normalizeExactPath`，graph 本地版（`collect.ts`）用 `normalizeRepoKey`（case-insensitive）并存（E1 遗留）；E2.1 裁定 = **R4 单一口径**——适配器直接把 graph `project` 键当规范键使用、**不新增第三份 normalizer**（T4/T8 机器钉死）；**E2.3 已闭合**：影子 S12/S13/S18/S19 断言两路 `attentionByRepo` 键/值逐字相等且 `next`/`diff` canonical 全等（S16 大小写变体归一键唯一）。
