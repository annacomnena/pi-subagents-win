---
title: Work Graph 只读关系面
kind: concept
status: current
updated: 2026-09-24
source_paths:
  - extensions/runtime/graph/types.ts#L16-L150
  - extensions/runtime/graph/edges.ts#L22-L44
  - extensions/runtime/graph/edges.ts#L52-L136
  - extensions/runtime/graph/project.ts#L84-L268
  - extensions/runtime/graph/diff.ts#L31-L72
  - extensions/runtime/graph/collect.ts#L55-L104
  - extensions/runtime/graph/collect.ts#L230-L284
  - extensions/runtime/frontier-carriers.ts#L108-L359
  - extensions/runtime/global-view.ts#L88-L90
  - extensions/runtime/global-view.ts#L539-L541
  - extensions/runtime/autonomy/frontier.ts#L197-L216
  - extensions/runtime/graph/frontier-input.ts#L16-L76
  - extensions/runtime/autonomy/frontier.ts#L103-L129
  - extensions/_test_graph_frontier_input.ts#L263-L398
  - extensions/runtime/graph/index.ts#L7-L11
  - extensions/_test_runtime_graph.ts#L87-L358
  - extensions/_test_frontier_attention_window.ts#L1-L30
---

# Work Graph 只读关系面

## Summary

Work Graph（E1 MVP）= 本仓既有四对象（Master / Workstream / Task / Run）之上的**只读关系面**：以 journal + tab-runs 账本 + workstreams 显式库为输入，提供对象注册、跨对象**引用式边**与 `diff(since)` 查询。它是这些既有真相源的**投影与求值器，不是任何一家的替代者**——对齐 `plans/global_work_graph_service_v0.2.md` §6A 边界裁定 (a)：不替代 tab-runs 判态机 / recentwork 时间线，只弱耦合引用。

E1 形态 = **影子运行**：纯库 + 零生产接线（无消费者），单 commit 可 revert；`RuntimeSnapshot v1` / `protocol.ts` / `index.ts` / A10.1 allowlist 均未变。

## Current Contract

### 四对象注册 + project 别名节点

`projectGraph(input)`（`project.ts#L84`）产出 `GraphSnapshot`（`types.ts#L91`）：`nodes` 覆盖 Master（缺省 `[master_default]`，`types.ts#L130`）、Workstream、Task、Run（journal 投影）四对象；`project:<normalizedRepoPath>` 是**别名节点**（`projectNodeId`，`edges.ts#L42`），不是第五种真相源。

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

`projectGraph`（`project.ts#L84`）零 IO、同输入同输出：Run 语义镜像 `projector.ts`（dedupeKey 幂等、terminal 优先不回退、孤立终态 pending 配对、未知 type 记 `skipped.unknownEventTypes` 不抛、`run.launch_failed → failed`）。**终态状态恒由事件 type 派生**（`terminalStatusFromType`）——与 projector 同口径，两者都**不读** `envelope.payload.status`（真实发射点 type / payload.status 恒一致，`adapters/tab-run.ts`）。`nodes`/`edges`/`projects` 全排序后冻结。

### diffGraph(prev, next, sinceSeq)

`diffGraph`（`diff.ts#L31`）纯函数：按 `sinceSeq` 计算 `addedNodes`/`removedNodes`/`changedNodes`（`JSON.stringify` 深比较）与 `addedEdges`/`removedEdges`（键 `kind|from|to`；**无 changedEdges**）。`prev=null` → 全量 baseline。

### collectGraphInput = 唯一 IO

`collect.ts` 是 graph 模块中**唯一**做 IO 的文件：`collectGraphInput`（`collect.ts#L55`）只读装配 `scanJournalSeq`（journal+seq）/ `listWorkstreams`+`listTasks`（显式库）/ tab-runs 账本（`composeTabStatus` phase 结论 + `findRepoRoot(cwd)` repoPath 引用）；never-throw（IO 失败收敛空输入）。`readGraphSnapshot`（`collect.ts#L104`）= `projectGraph ∘ collectGraphInput` 快捷方式。

### 零写路径

`graph/**` 无业务态 writer：不写 journal / tab-runs / workstreams / registry。E2.0 起新增 `state/work-graph/<scope>.json` **只读派生缓存**（O-C：可删，缺失等同无缓存；纯函数层 `types`/`project`/`edges`/`diff` 仍零 IO，唯一写者 `graph/collect.ts::writeGraphSnapshotCache`）。`index.ts`（`index.ts#L7`）导出面全为纯函数 + 类型。

### E2.0 载体对齐与共享归约

E2.0 把 frontier 消费的载体补齐到 Graph 只读投影，并把 carrier 归约抽成单一真相源（仍为影子运行，零生产接线；`RuntimeSnapshot v1`/`protocol.ts`/A10.1 allowlist 未变）：

1. **`GraphRunRef` 增 carrier 字段**（`types.ts#L55`）：`gate` / `needsHuman` / `staleOver` / `overdue` / `pidAlive`；`projectGraph`（`project.ts#L252-L256`）**恒赋**，carrier 缺 → **null 不猜**。`GraphRunCarrier`（`types.ts#L76`）为上述五字段的子集输入。
2. **`GraphSnapshot.history` 仅观测载体，不参与 frontier 输入**（`types.ts#L91`）：hidden tab 的 `{id, reason}`，按 id 升序；E2.1 `toFrontierInput` 恒 emit `[]`（MF1）。v2 生产路径 `collect.ts` 不传 history → 快照不发出该键（保持 E1 快照形状向后兼容）。
3. **`state/work-graph/<scope>.json` 只读缓存**（O-C）：唯一写者 = `graph/collect.ts`（`writeGraphSnapshotCache` `collect.ts#L230`，tmp+rename 原子写，tmp 名含 pid+时间戳+计数器防同进程并发冲突）；`readGraphSnapshotCache`（`collect.ts#L279`）容忍缺失/坏 JSON/版本不符，并做 **carrier/history 子结构校验**（旧形无 carrier 键 → 拒绝，防 E2.1 读出后 carrier 全 null 致 watchdog 检查 6 静默失活）；约定 `GRAPH_SNAPSHOT_VERSION` 随 schema 扩字段必须 bump。
4. **`frontier-carriers.ts` 是 carrier 归约的唯一真相源**（`runtime/frontier-carriers.ts`）：`reduceTabCarrier`（`#L243`）/ `collectTimerByRepo`（`#L314`）/ `classifyDispatch`（`#L139`），由 `global-view.ts`（`#L212`/`#L389`/`#L359`）与 `graph/collect.ts`（`#L165`/`#L146`/`#L140`）**共用同一实现，禁止各写一份**；`global-view.ts` 以 re-export 保持原导出面（`readGateStatus`/`TabDetail`/常量等）。

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

### E2.1 契约：`toFrontierInput` 适配器（Graph → frontier 输入，零接线）

E2.1 新增**纯函数** `toFrontierInput(snap, {now})`（`graph/frontier-input.ts#L55`）：把 `GraphSnapshot` 投影为 `FrontierSourceSnapshot`（`autonomy/frontier.ts#L116`，其 `FrontierSourceTab` `#L103`），为 E2.2 影子对照冻结输入契约。**零生产接线**：`frontier-input.ts` 不被任何生产文件 import，只被 `_test_graph_frontier_input.ts` 消费（`extensions/index.ts`/`graph/index.ts` 未加导出面）；`autonomy/frontier.ts` 仅做**类型放宽**（`FrontierInputs.snapshot` 改结构化接口 `#L124`，`buildFrontier` 算法体与 v2 调用点零改）。

契约（`frontier-input.ts#L16-L76`）：

- **纯度**：零 IO、零墙钟、零随机、确定性；两 `import` 均为 `import type`（零运行时依赖）。T8 以**源码读取守卫**（`readFileSync` 直读生产源码做 substring 断言，**非 shell grep**）把 `node:fs`/`Date.now`/`Math.random`/`writeFile`/`toLowerCase`/`toLocaleLowerCase`/`replace(`/`function|const|let|var normalize`/`normalize =`/两既有 normalizer 调用列入**零路径转换白名单**（`_test_graph_frontier_input.ts#L263`）。
- **R4 单一口径**：直接把 `GraphProjectView.project`（已由 `normalizeRepoKey` 归一）写入 `attentionByRepo` 键与 `details[].repoPath`（`frontier-input.ts#L60`）——**不做任何转换、严禁自写第三份 normalizer**；`normalizeRepoKey` ≡ `normalizeExactPath` 逐字节同体，由 T4 机器钉死。
- **`now` 来源**：`FrontierInputOptions.now` 必填（`#L16`），**不使用 `snap.asof`**（`collect.ts#L96` 缺省不发出 → 采用会得 `undefined`）；适配器自身不消费墙钟，`now` 由调用方以同一值透传 `buildFrontier`（T11 断言 `next.asof === opts.now`）。
- **`history` 恒 `[]`**（MF1）：不读 `snap.history`（`#L75` 字面量）；填充会造出 v2 生产从不产的 ②③ hidden 触发（T6 双向反例）。
- **attention 全量无裁剪**：仅 `attention > 0` 写键（缺项 = 0，`#L59-L60`），无窗口裁剪；键/值逐字等于 v2 `attentionByRepo`（G-A 全量口径）。
- **details 成员过滤 + 确定性**：仅 carrier 存在（`gate`/`needsHuman`/`staleOver`/`overdue` 非 null）且 `project`/`phase` 非 null 的可见 tab 进 `details`（`#L27-L47`，缺 carrier 不猜、`pidAlive=null` 合法保留）；按 `runId` 升序，**重复 `runId` 时按 `repoPath` 升序 tie-break**（`#L70`，T15）。

验证：T1–T15 全绿（`_test_graph_frontier_input.ts`，含 T9 双路径结构等价：同 fixture 帧0 `JSON.stringify` 严格全等、帧1 canonical 全等且含非 mailbox 边沿 `working_to_completed`/`stagnation`/`needs_user`；T9 端到端覆盖 `staleOver=true`/`needsHuman=true`/`pidAlive=false`）。

## Evidence

- E1 测试 13 组（`extensions/_test_runtime_graph.ts#L87-L311`）：空输入 / 单对象 / 边三来源 / 孤儿引用 / dedupe 幂等 / 乱序 terminal / diff 边界 / 确定性+路径口径 tripwire / 10k 性能 / 未知事件 / workspaceRef 弱载体 / 坏行只读 / replay 等价 + collect 装配；T13 含病态事件（type 与 payload.status 矛盾）下 Graph ≡ projector 的等价断言。
- 实测数字：10_000 合成事件 `projectGraph` 约 11–16ms（预算 2000ms；多次运行波动）。replay 等价 `replayEquivalenceDiff === []`；Graph run `status` 与 `projector.rebuildFromEnvelopes` 逐 run 相等。
- 回归全绿：`test:runtime-projector` / `test:runtime-workstream` / `test:runtime-snapshot` / `test:tab-runs` + `_test_runtime_autonomy.ts`（57 checks，A10.1 allowlist 未扩）。
- L4 独立审查（`plans/0924_graph_E1_l4_review.md`）：**PASS**（必须修 0；建议修 5）。
- E2.0 载体对齐 + 共享归约（`7672771`+`ed5278a`，L4 `plans/0924_graph_E2_0_l4_review.md` **PASS**）：`_test_graph_carriers.ts` 5 组（legacy oracle 双跑 + `collectGlobalView` 全量 golden 入库，路径归一化、固定 now）；`_test_runtime_graph.ts` 13/13（T13 快照形状零漂移）；`_test_runtime_autonomy.ts` 57 checks（A10.1 allowlist 仍恰好 3）；`test:global-view`（含 M1 golden）绿。行为保持由 pre/post golden 逐字节复现证明。
- G-A 语义修复（`93f8447` + `fae1aa2`；L4 `plans/0924_attention_semantics_fix_l4_review.md` **PASS-with-fixes**，必须修 M2 已闭环）：`_test_frontier_attention_window.ts` 18 checks（P0 十条翻转 + N1-N4 + M1/M2/M3 + K1 tripwire）；规模 19/20/21/40 四档页外漏检=0、假边沿=0；`test:global-view` M1 byte-identical + Σ 不变量三路径；`_test_runtime_autonomy.ts` 57 checks（A10.1 ALLOW 仍恰 3）；`_test_graph_carriers.ts` 5/5（golden 仅加性新增 `attentionByRepo` 一个键）；其余 runtime 回归全绿。
- E2.1 适配器契约（`b59ee68` + `513623c`；L4 `plans/0924_graph_E2_1_l4_review.md` **PASS-with-fixes**，2 必须修 + 3 建议修已闭环）：`_test_graph_frontier_input.ts` **15/15**（T1–T15：T8 源码读取守卫扩零路径转换白名单、T9 `FAR_PAST` 相对固定 `NOW` + 双路径双帧非 mailbox 边沿、T15 重复 runId tie-break）；`frontier-input.ts` 零生产接线（`rg -l frontier-input extensions --include=*.ts` 仅命中自身 + 测试）；回归 `_test_runtime_autonomy.ts` 57 checks（A10.1 ALLOW 仍恰 3）/ `_test_runtime_graph.ts` 13/13 / `_test_graph_carriers.ts` 5/5（golden 未变）/ `_test_frontier_attention_window.ts` 18 + `test:global-view` + 6×npm 全绿。

## Links Out

- [[Wiki 索引]]

## Backlinks

- [[Wiki 索引]]

## Open Questions

- **attention 当页窗口口径（MF2）**：~~E2.0 未动 v2 `frontier.ts` rows 当页 slice 口径；`attentionWindow` 参数零实现。E2.1/E2.3 翻转前的 attention 口径仍待用户裁定。~~ **已由 G-A 修复（`93f8447`）**：frontier ⑤ 改为消费分页前全量 `GlobalViewSnapshot.attentionByRepo`（见 Current Contract「G-A 语义修复契约」），`attentionWindow` 仍零实现但不再构成 latent bug；G-B `toFrontierInput` 须从 graph `projectAttention`（全量归约）填充该字段，**不得**引入窗口裁剪。
- **~~`asof` 缺省不发出~~ 已闭合（E2.1）**：`toFrontierInput` 取 `opts.now` 必填、**不使用 `snap.asof`**（`collectGraphInput` 仅在显式提供 `opts.asof` 时透传）；`now` 由调用方以同一值透传 `buildFrontier`（见 Current Contract「E2.1 契约」）。
- **弱载体残余**：`isPathShapedRef` 对含 `/` 的自由字符串（如 `a/b` 标签）判为路径形 → 伪 project 节点（已测试固化，属 best-effort 已知残余）。
- **`run_subject` 自环 / 无 changedEdges**：`diffGraph` 边只按键增删，evidence/match 标注变化不可见；E2 文档需显式声明。
- **双 `findRepoRoot` 口径（E2.1 已定单一口径）**：共享版用 `normalizeExactPath`，graph 本地版（`collect.ts`）用 `normalizeRepoKey`（case-insensitive）并存（E1 遗留）；E2.1 裁定 = **R4 单一口径**——适配器直接把 graph `project` 键当规范键使用、**不新增第三份 normalizer**（T4/T8 机器钉死）；E2.3 翻转前仍需保证该键与 v2 `attentionByRepo` 键逐字同口径。
