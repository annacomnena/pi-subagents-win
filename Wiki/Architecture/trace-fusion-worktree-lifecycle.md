---
title: trace-fusion lane worktree 生命周期与磁盘成本
kind: architecture
status: current
updated: 2026-11-04
source_paths:
  - extensions/trace-fusion/worktrees.ts#L43-L100
  - extensions/trace-fusion/worktrees.ts#L163-L200
  - extensions/trace-fusion/worktrees.ts#L255-L300
  - extensions/trace-fusion/worktree-reclaim.ts#L44-L130
  - extensions/trace-fusion/supervisor.ts#L333-L350
  - extensions/trace-fusion/artifacts.ts#L198-L210
  - extensions/trace-fusion/artifacts.ts#L280-L370
  - extensions/trace-fusion/types.ts#L134-L152
  - extensions/trace-fusion/clean.ts#L36-L80
  - extensions/trace-fusion/config.ts#L60-L72
---

# trace-fusion lane worktree 生命周期与磁盘成本

> 校准状态：**current（2026-11-04 源码级核实 + 沙盒对照实验 + 磁盘实测分母）**
> 关联：`trace-fusion-architecture.md`、`trace-fusion-artifact-contract.md`、`tab-run-ledger.md`
>
> 本文回答三个问题：**一轮要花多少磁盘**、**什么时候可以安全删**、**删的时候什么会杀死你的依赖**。

---

## 1. 磁盘账：贵的是「每棵树独立编译一遍」，不是 worktree

实测分母（2026-11-04，PowerShell 遍历求和）：

| 对象 | 实测 | 说明 |
|---|---|---|
| GreenCAD 主仓全量 | **16.87 GB / 86585 文件** | 内含 `debug/` 构建产物 **6.3 GB**、`ref/` 1.67 GB、`.codegraph` 0.22 GB —— 这些**不进 git** |
| 一个活跃 worktree | **1.76 GB / 10045 文件** | 只含被 git 跟踪的源码+资源（Raster 544MB、External 293MB、plans 208MB…） |
| implement 一轮 | **12 GB 级** | 源树 ×3 + 构建产物 ×3（设计稿 `plans/pi_trace_fusion_loop_complete_design.md` 记为 12GB/轮级；`clean.ts:4` 头部注释记同一件事） |

要点：`git worktree add` 只复制**被跟踪的文件**；构建产物是 **untracked**，git 不共享，
每个 lane 想跑构建就得**各自攒一份**。所以「开一个 worktree 不贵，开三个还各编译一遍」才贵。

怎么判当前模式：`meta.mode`（`types.ts` `TraceRunMeta.mode`）。
- **diagnose（缺省）**：**零 worktree**、lane 只读 ⇒ 磁盘账基本为零。
- **implement**：每 lane 一棵 detached worktree + 各自构建。

复跑口径：`git -C <repo> worktree list`；目录大小用 PowerShell
`Get-ChildItem -Recurse -File -Force | Measure-Object Length -Sum`（**别用 MSYS `find`/`du` 数 junction**，见第 3 节）。

---

## 2. 生命周期：谁创建 → 谁收 → 谁删

```
launch-workers: createLaneWorktrees（同一 baseCommit，A/B/C 三树同源）
        └─ provisionWorktree（junction 只读依赖 + copy .env）→ 写 lanes/<lane>/provision.json
lane 跑完自报终态（tab-finish）
        └─ supervisor.outcomeForMeta → reclaimTerminalLaneWorktrees   ← 「跑完一个删一个」
                ① collectLaneArtifacts 先收产物  ② 收齐才 removeWorktreeRetry  ③ 写 reclaim.jsonl
run 终态 collect → cross-test → fusion（产物在长路径 runDir，永不随 worktree 删除）
人工兜底：/trace-fusion-clean <runId> [--force]（extensions/index.ts:5648 → clean.ts:36）
```

**「跑完一个删一个」的顺序是硬约束，不能颠倒**（`worktree-reclaim.ts:44`）：
`patch.diff` / `status.txt` 都**来自 worktree**，删早了就没有证据。
- 收齐 ⇒ 删树，`action:"reclaimed"`，meta 写 `lanes.<lane>.worktreeReclaimedAt`；
- 收不齐 ⇒ **保留树** + `action:"deferred"`（**绝不拿删树换空间**）；
- 移除失败（树被进程占用 / git 锁）⇒ 保留树 + `deferred` + `.stale.json` 标记；
- 每条都写 `runDir/reclaim.jsonl`（`{lane, at, action, reason, linksRemoved, worktree}`）——
  没有这行你就只能靠猜（AGENTS.md R-2）。

开关：`config.json → traceFusionLoop.reclaimLaneWorktree`（缺省 true；读侧 `config.ts:68`，
关掉就回到「run 终态后手动 clean」的旧行为）。
触发位置在**续发之前**（`supervisor.ts:340`）⇒ `laneConcurrency=1` 时效果就是
「派发下一个 lane 之前，上一棵已落盘并释放」，峰值只有 1 棵树。

---

## 3. junction 是地雷：删除前必须先解链接

供给用 junction（`worktrees.ts:104`，Node `symlinkSync(target, link, "junction")`，无需管理员），
指向**主仓的活数据**（`node_modules` → 全局 pi 安装）。于是：

> **`git worktree remove --force` 的递归删除会穿过 junction，删掉目标目录的内容。**
> 对照实验（`plans/_wt_junction_experiment.ps1`，2026-11-04 实跑）：
> - `-Mode remove`（旧写法）：目标目录 `[keep.txt, extra.txt]` → **空**；
> - `-Mode safe`（先解链接）：目标目录 `[keep.txt, extra.txt]` **完好**，worktree 正常移除。

这就是 AGENTS.md **R-16** 那次「把全局 pi 安装删光」的机制。安全形状三件套（`worktrees.ts`）：

1. `listReparseLinks(root, depth=8)`（L43）——枚举目录树里的 reparse 链接，**绝不进入链接内部**；
2. `removeLinksOnly(root)`（L79）——`rmSync(p)` **不带 recursive** ⇒ 删的是链接本身，不是目标内容；
3. 然后才交给 `git worktree remove --force`；解不掉的链接 ⇒ 只写 `.stale.json`，**绝不递归删除该目录**。

消费方（改删除逻辑时四处都要看）：`removeWorktreeRetry`（L255，被 `clean.ts` / `cross-test.ts` /
`launch-workers.ts` 共用）、`createSingleWorktree` 的 stale 回收（L163）、`clean.ts` 删 wtDir（L36 之后）。

**数 junction 里的文件不要用 MSYS `find`** —— `find` 不穿 junction，会给你假的 0。

---

## 4. 回收之后：终态收集不得在已删除的树上重跑

已实现的守卫：`artifacts.ts:203` —— worktree 不存在且首次产物在 ⇒ 走 `reuseHarvestedReport`
（L326）沿用首次产物，**不重跑 git**，并在 `issues` 明示「沿用首次收集产物」（不静默）。

为什么必须有：worktree 被回收后，run 终态的收集会在**已删除的树**上跑 `git diff` /
`git status` ⇒ 全部失败 ⇒ 把首次收集好的 `patch.diff` / `status.txt` **覆盖成空文件**（证据被清空）。

配套数据契约：**`lanes/<lane>/collect-manifest.json`**（写入点 `artifacts.ts:284`）——
`changedFiles` / `untrackedFiles` / `testFiles` / `patchBytes` / `strayFiles` / `trustedCommands`。
`cross-test.ts:336-345` 的冲突检测要吃 `changedFiles` / `testFiles`，回收后**只能靠它还原**
（manifest 缺失时 reuse 会在 issues 里明说「以空集降级」）。
该文件已进 lane 产物白名单（`types.ts:149`），否则会被判成「lane 契约外文件」。

---

## 5. 改之前必查的清单

1. 你要动删除路径？⇒ 三处消费方一起看（`removeWorktreeRetry` / `createSingleWorktree` / `clean.ts`），
   并在测试里放一个**真 junction**，承重断言是「**目标内容完好**」。
2. 你要让收集/清理顺序变化？⇒ 先问「产物在不在」，再问「树在不在」；产物永远优先于空间。
3. 新增收集器自产文件？⇒ 进 `types.ts` 的 `LANE_ARTIFACT_NAMES`（白名单漏项的代价：
   实测 34 个 lane 目录里 6 个被误判成 lane 违规）。
4. 判磁盘成本？⇒ 分母要用「主仓 vs 单树 vs 一轮」三个数，不能拿单个 worktree 大小代表一轮成本。

---

## 6. 已知未闭合（勿当成已完成）

| 项 | 状态 |
|---|---|
| `config.ts` 不读 `mode` ⇒ **implement 分支生产不可达**（现存 run 全 diagnose） | 未修；本功能在 implement 开闸后才真正生效，diagnose 零影响 |
| `linksFailed`（占用中的 junction）只写审计，不重试解链接 | 未闭合；需等持有进程退出后由下轮回收处理 |
| 六节长度门保持 40（分节阈值未做） | 未做；门只保证「写了」，不保证「写够」 |
