---
title: Work Graph 只读关系面
kind: concept
status: current
updated: 2026-09-24
source_paths:
  - extensions/runtime/graph/types.ts#L16-L133
  - extensions/runtime/graph/edges.ts#L22-L44
  - extensions/runtime/graph/edges.ts#L52-L136
  - extensions/runtime/graph/project.ts#L84-L268
  - extensions/runtime/graph/diff.ts#L31-L72
  - extensions/runtime/graph/collect.ts#L29-L92
  - extensions/runtime/graph/index.ts#L7-L11
  - extensions/_test_runtime_graph.ts#L87-L358
---

# Work Graph 只读关系面

## Summary

Work Graph（E1 MVP）= 本仓既有四对象（Master / Workstream / Task / Run）之上的**只读关系面**：以 journal + tab-runs 账本 + workstreams 显式库为输入，提供对象注册、跨对象**引用式边**与 `diff(since)` 查询。它是这些既有真相源的**投影与求值器，不是任何一家的替代者**——对齐 `plans/global_work_graph_service_v0.2.md` §6A 边界裁定 (a)：不替代 tab-runs 判态机 / recentwork 时间线，只弱耦合引用。

E1 形态 = **影子运行**：纯库 + 零生产接线（无消费者），单 commit 可 revert；`RuntimeSnapshot v1` / `protocol.ts` / `index.ts` / A10.1 allowlist 均未变。

## Current Contract

### 四对象注册 + project 别名节点

`projectGraph(input)`（`project.ts#L84`）产出 `GraphSnapshot`（`types.ts#L73`）：`nodes` 覆盖 Master（缺省 `[master_default]`，`types.ts#L133`）、Workstream、Task、Run（journal 投影）四对象；`project:<normalizedRepoPath>` 是**别名节点**（`projectNodeId`，`edges.ts#L42`），不是第五种真相源。

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

`collect.ts` 是 graph 模块中**唯一**做 IO 的文件：`collectGraphInput`（`collect.ts#L42`）只读装配 `scanJournalSeq`（journal+seq）/ `listWorkstreams`+`listTasks`（显式库）/ tab-runs 账本（`composeTabStatus` phase 结论 + `findRepoRoot(cwd)` repoPath 引用）；never-throw（IO 失败收敛空输入）。`readGraphSnapshot`（`collect.ts#L84`）= `projectGraph ∘ collectGraphInput` 快捷方式。

### 零写路径

`graph/**` 无任何 writer：不写 journal / tab-runs / workstreams / registry / state；无 `state/work-graph/*.json` 落盘（O-C：E1 不落盘）。`index.ts`（`index.ts#L7`）导出面全为纯函数 + 类型。

## Evidence

- E1 测试 13 组（`extensions/_test_runtime_graph.ts#L87-L311`）：空输入 / 单对象 / 边三来源 / 孤儿引用 / dedupe 幂等 / 乱序 terminal / diff 边界 / 确定性+路径口径 tripwire / 10k 性能 / 未知事件 / workspaceRef 弱载体 / 坏行只读 / replay 等价 + collect 装配；T13 含病态事件（type 与 payload.status 矛盾）下 Graph ≡ projector 的等价断言。
- 实测数字：10_000 合成事件 `projectGraph` 约 11–16ms（预算 2000ms；多次运行波动）。replay 等价 `replayEquivalenceDiff === []`；Graph run `status` 与 `projector.rebuildFromEnvelopes` 逐 run 相等。
- 回归全绿：`test:runtime-projector` / `test:runtime-workstream` / `test:runtime-snapshot` / `test:tab-runs` + `_test_runtime_autonomy.ts`（57 checks，A10.1 allowlist 未扩）。
- L4 独立审查（`plans/0924_graph_E1_l4_review.md`）：**PASS**（必须修 0；建议修 5）。

## Links Out

- [[Wiki 索引]]

## Backlinks

- [[Wiki 索引]]

## Open Questions

- **attention 收集侧未接线**：`GraphInput.projectAttention` 存在但 `collect.ts` 不填 → collect 快照 attention 恒 0。E2 翻转 frontier `attentionByRepo` 前必须接线 RepoRow（E2 义务）。
- **GraphRunRef 载体不足**：frontier 还消费 `TabDetail.gate/needsHuman/staleOver/overdue` 与 `snapshot.history`，`GraphRunRef`/`GraphSnapshot` 无对应字段 → E2 翻转实为 `aggregateProject` 签名 + history 路径**多点改动**，非纯单点（E2.0 前置）。
- **`state/work-graph` 落盘**：`diff(since)` 的 `prev` 快照归属（内存缓存 vs 落盘）未定，落盘归 E2（O-C：E1 不落盘）。
- **弱载体残余**：`isPathShapedRef` 对含 `/` 的自由字符串（如 `a/b` 标签）判为路径形 → 伪 project 节点（已测试固化，属 best-effort 已知残余）。
- **`run_subject` 自环 / 无 changedEdges**：`diffGraph` 边只按键增删，evidence/match 标注变化不可见；E2 文档需显式声明。
