---
title: 当前路线
kind: decision
status: current
updated: 2026-11-25
source_paths:
  - Wiki/Development/Implementation-Gates.md
  - Wiki/Architecture/autonomy-suite.md
  - Wiki/Architecture/autonomy-consumer-gap.md
  - extensions/runtime/wake.ts
  - extensions/runtime/autonomy/collect.ts
---

# 当前路线（Current Roadmap）

> 本页是**当前有效的实施顺序**。它不重复设计理由（那是决策页与 Architecture 页的事），
> 只回答：**下一步做什么、按什么顺序、每步的验收是什么。**
>
> 前置约束见 [[Implementation-Gates]]。

## 核心原则（2026-11-25 修订）

> **当前最值得建设的不是更聪明的 Global Master，
> 而是一个知道自己的信息是否可靠、知道自己的系统是否正常运行、知道自己什么时候不能行动的 Global Master。**

据此，把原 S0「核对现有载体与观测基线」拆成三个**基础设施修复**里程碑（S0.1–S0.3），
它们不是新功能，而是后续自主能力的**正确性基础**。

---

## S0.1 约束入库 —— **已完成（2026-11-25）**

**目标**：任何新 agent / 新机器都能获得有效开发约束。

**产出**
- 本页 + [[Implementation-Gates]]（`Wiki/Development/`）
- `AGENTS.md` 新增「Implementation Gates」指针节
- `scripts/check-development-contracts.mjs` + `package.json` 的 `check:dev-contracts`

**验收**
- [ ] 全新 clone 后，`Wiki/Development/*.md` 可读（不依赖 `plans/`）
- [ ] `npm run check:dev-contracts` 通过
- [ ] `AGENTS.md` 里能一路点到这里

**为什么先做这个**：约束只有对「会读到它的人」才成立。此前 A4/A5/A6/A7 的缓行约束
只写在 `plans/`（gitignored，实测入库只有 6 个文件）⇒ 对新机器等于不存在。

---

## S0.2 运行可观测性 —— **已完成（2026-11-25，commit d9b5370）**

**目标**：**即使功能关闭，也能观察自主运行链路的真实状态。**
这是本路线中优先级最高的工程问题。

**要解决的问题（实测）**

当前系统**无法区分**这两种情况：
1. 系统正常运行，决定不行动；
2. 自主运行链路实际上没有工作。

本机实测（2026-11-25）：
```
config.json:  autonomy.enabled = true, autonomy.actions.enabled = true
registry/cutover.json:  不存在
state/autonomy/:  heartbeat.json（新鲜）+ non-owner-ticks/
                  ❌ 无 frontier.json  ❌ 无 actions/  ❌ 无 audit.jsonl
```
心跳新鲜 + 配置开着 + **零实际动作** —— 任何单一读数都像「一切正常」。

**机制上的三处黑洞**
1. `wake.ts:103-106` `if (!cutover?.enabled) return []` —— 注释自写「**零动作零审计**」
2. `wake.ts:99/135` `auditedSkip` 是 per-process Set（同 `(ws.id,reason)` 只写一次）
   ⇒ 回答「出现过吗」，**不是「出现了多少次」**
3. 观测点位于 `mailboxOwnerEligible` 门**之后**（`mailbox-consumer.ts:1081`）
   ⇒ 非 owner 进程的自主链状态**永远不可见**

**设计要点**

| # | 要点 | 理由 |
|---|---|---|
| 1 | **报「第一个失败的门」**，不是笼统 `cutover-missing` | 五道门串联：`isSubagent` → `mailboxOwnerEligible` → `cutover.enabled` → `autonomyGate` → `actions.enabled`。报错门才能指向正确修法 |
| 2 | 观测点放在**比 owner 门更前** | 否则非 owner 进程盲区 |
| 3 | 三载体分离：**Status Snapshot / Metrics / Audit** | 不能每 tick 写一条日志（cutover 关几天会产生海量重复）。审计只在**状态变化**时写 |
| 4 | 宿主层要有**独立存活信号** | tick 函数根本没被调用时，函数内 telemetry 无用 |

**outcome 词表：先落 6 态，每态必须能演示**（R-20：写进规则的状态必须真的可达）

```
NOT_SCHEDULED      自主评估周期没有运行
DISABLED           配置明确关闭
GATED              前置门未满足（带 firstFailedGate）
OBSERVATION_FAILED 无法获得可靠工作状态
INSUFFICIENT_EVIDENCE  已评估，但证据不足
NO_ACTION_NEEDED   已评估，当前无需行动
```
> `STALE_EVIDENCE` / `ACTION_PROPOSED` / `APPROVAL_REQUIRED` / `ACTION_EXECUTED` /
> `EXECUTION_FAILED` 等 S3/S4 真正产生 Action Intent 时再加 —— 一次性加 11 态而没有输入，
> 后来者无法判断「这一态是设计如此还是 bug」。

**⚠️ 必须显式登记的约束：观测产物在 `state/` 下，会随清理消失**

`state/autonomy/` 里的 `audit.jsonl` / `actions/*.jsonl` / `frontier.json` 全部位于
**可丢弃的运行时目录**。历史证据：`Wiki/Architecture/autonomy-consumer-gap.md` 记录
2026-11-01 本机 `actions.jsonl` 有 **209 条、执行 22 次**；而 2026-11-25 实测该目录已无
`actions/` 与 `audit.jsonl`（重装系统清理所致）。

⇒ **累积计数器不能只写 `state/`**。要么放到跨清理持久的位置，要么在 UI/status 上
明确标注「本数据随 `state/` 清理丢失，不可作长期审计证据」。
不允许让读者以为拿到了权威历史（R-26 家族）。

**实现位置**
- `extensions/runtime/autonomy/control-plane.ts`（三载体 + 6 态 + 六门）
- `extensions/runtime/wake.ts`（`evaluateWakes` 可选 `observe`，判定仍单点）
- `extensions/runtime/autonomy/action/run.ts`（`runAutonomyActions` 返回 `RunActionsResult`）
- `extensions/mailbox-consumer.ts`（tick `try/finally`，观测点在 owner 门**之前**）
- `extensions/runtime/autonomy/status-body.ts`（`/autonomy status` 新增「自主控制面」行）
- 测试：`test:autonomy-control-plane`（60 checks，含 ⑦ evaluateWakes 与 ⑧ tick 两层**真实接线**）

**验收**
- [x] Cutover 文件不存在 ⇒ 可观测地报告阻塞 + 零实际动作
- [x] Cutover 长时间关闭 ⇒ 可统计**评估次数**，不产生海量重复审计（边沿触发验证）
- [x] 自主调度器**完全未运行** ⇒ 可通过独立监测发现（`inferNotScheduled` 快照超龄推断）
- [x] 非 owner 进程也能看到自己的门状态（观测点在 owner 门之前）

**已验证的两个架构事实**
1. `NOT_SCHEDULED` **不能**由 tick 内产出 —— tick 无法自证「没被调用」，只能由观测侧推断（测试已钉死）
2. `cutover` 对读取、唤醒两条链效果**不同**：消费链在 cutover 未开时回退 `legacy-main-session`（不关），
   而唤醒链在 `wake.ts:106` 直接 return（旧版本零审计）

**仍未闭合**
- metrics 仍在 `state/` 下，**随清理/重装丢失**（不许当长期审计证据；本页已登记）
- 只落 6 态；S3/S4 的 5 态留待真正产生 Action Intent 时再加
- `/autonomy status` 这行未接入 GUI
- 运行中 daemon 跑旧码 ⇒ 真实读数需重启才生效（R-18）

---

## S0.3 Frontier 归属与 fencing —— **下一步**

**目标**：消除多写者覆盖及过期证据问题。

**现状问题（实测）**
- `collect.ts:172` 注释明确 frontier 是「**C4 派生缓存**」（R-3：可作最佳近似，不可当权威）
- **多写者共写同一文件**：1 global + N local 各写同一个 `frontier.json` ⇒ 最后写入者覆盖
- 本机实测 **8 个 master attachment** 同时存在（1 global + 7 local）
- 读到的可能是「某一次某个进程的视角」，含幽灵引用（已删除的 tab id）

**两步走（每步可独立验收）**

| 步 | 内容 | 不做的后果 |
|---|---|---|
| 1 | **原地加归属元数据 + fencing**（`producer.masterId/generation`、`computed_at`），读点兼容 | 无法判断「这份快照是谁的视角」 |
| 2 | **换布局** `registry/frontiers/{global,local/<owner>}/current.json` + 存量迁移 | 多 owner 仍互相覆盖 |

**fencing 判据可复用**：`runtime/scope-consume.ts` 的 `judgeConsumeFresh()`
（证据绑定 `sessionId + generation + lastTickAt`，旧代/异身份一律不算数）。
**仅加 `generation` 字段不够** —— 必须阻止已失去写入权的进程覆盖当前快照。

**设计原则**
> **Frontier 可以决定「值得关注什么」，但不能独立决定「允许执行什么」。**
> 即使 Frontier 完全正确，它也只是一个时刻的快照。

**验收**
- [ ] 1 Global + 7 Local 并行写入 ⇒ 视角互不覆盖
- [ ] 旧代 Master 尝试更新 ⇒ fencing 拒绝
- [ ] Frontier 引用已删除 Tab ⇒ 标记失效，不产生有效执行授权

---

## S1 工作状态捕捉（Work State Capture）

**目标**：新增**独立、可信**的结构化声明入口。

**已关闭的技术选项**（不再做兼容性测试）
- ❌ **不复用 `tab-report`** —— 三个硬点：
  1. `tab-runs-runtime.ts:405` 硬性要求 runId 取自 `PI_TAB_RUN_ID`，「不接受外部传入——防止伪造」
     ⇒ **Local Master 主会话用不了**，而 S2 的核心动作正是 Local Master 声明阻塞
  2. `recipientSessionIdFor` 不认 `agent://master_*`
  3. 解析失败落 `.unroutable`，**零消费者**
- ❌ **不放宽 `PI_TAB_RUN_ID` 信任规则** —— 那是防伪造的正确设计，放宽 = 用安全换方便
- ❌ **不把新声明系统架在 Mailbox 地址解析器上**

**做法**：新增 `work-report`（身份**由 Runtime 注入**，不信模型填写的 owner/runId）。
声明直接进 Runtime 事件链，不经 Master Mailbox。

**权限矩阵**

| 操作 | Worker | Local Master | Global Master |
|---|---|---|---|
| 声明自身进展/阻塞 | ✅ | ✅ | ✅ |
| 提议任务依赖 | ✅ | ✅ | ✅ |
| 确认项目内依赖 | ❌ | 授权范围内 | 授权范围内 |
| 确认跨项目依赖 | ❌ | 提议 | 授权范围内 |
| 声明任务已验收 | 提供证据 | 按验收规则 | 按验收规则 |
| 修改其他 agent 身份 | ❌ | ❌ | ❌ |

**两类真实性必须分开**：声明的**真实性**（确实由该 agent 发出）由 Journal 权威记录；
声明的**内容真实性**（描述是否正确）Journal **不保证**。

**⚠️ 隐藏问题：agent 忘记报告怎么办**

若状态捕捉依赖 agent 主动调用 `work-report`，必须能发现「该报没报」。建议每个活跃任务记两个独立时间：

| | 语义状态新鲜 | 语义状态陈旧 |
|---|---|---|
| **运行活动**新鲜 | 正常工作 | **工作中，但语义不透明** |
| **运行活动**陈旧 | 可能在等待/休眠 | 需要诊断，状态不确定 |

- `last_runtime_activity_at`：最近一次确定性运行活动
- `last_semantic_update_at`：最近一次工作语义声明

这是**诊断分类**，不直接构成任务失败或新动作依据。

**验收**
- [ ] Worker 伪造其他 Run ID ⇒ 拒绝
- [ ] Local Master 无 Tab Run ID ⇒ 能用独立声明入口
- [ ] Local Master 声明其他项目状态 ⇒ 未授权时拒绝

---

## S2 Semantic Work Graph

增加动态依赖、阻塞和决策关系。Graph 保持**确定性只读投影**。

**验收**
- [ ] A、B 并行，C 依赖 A 的验收 ⇒ A 的 run 成功但验收未完成**不能**释放 C
- [ ] 重放/重试/乱序/循环依赖/缺失信息均不产生错误自动行动

---

## S3 只读自主决策轮（proposal-only）

**目标**：验证 Global Master 能否根据可靠证据产生合理行动意图。**不执行。**

**试点边界（第一轮强制）**

| 约束 | 要求 |
|---|---|
| Owner | 单一逻辑 Owner |
| Frontier | 固定来源及修订号 |
| Graph | 可重建、可验证 |
| 输出 | Action Intent 或 No Action |
| 实际动作 | **不执行** |
| 多进程 | 独立验证后再扩大 |

**Action Intent 必须引用原始证据 + 前置条件，执行前复验**
（`owner_generation` / `task_revision` / `expires_at`）。任何一项变化 ⇒ 拒绝或重新评估，不沿旧计划执行。

**验收**
- [ ] 同一 Frontier 变化只形成一个待决策工作项
- [ ] 用户工作优先；不在 busy session 强插用户消息
- [ ] 重启可恢复；Kill Switch 关闭后不再启动新自主轮
- [ ] **证据不足 ⇒ `INSUFFICIENT_EVIDENCE`，而非自动扩大权限**
- [ ] Action Intent 生成后状态变化 ⇒ 执行前复验失败

---

## S4 受控自主执行

前置条件（S0.1–S3）全部通过验收后开放。复用 `runtime/autonomy/action/` 的
`policy / registry / ledger / breaker / replay`（刹车保留，且给刹车加读数）。

---

## 不做

通用 DAG 编排平台、知识图谱数据库迁移、全量 transcript LLM 抽取、
每次 tool call 唤醒 Global Master、全自动跨项目重规划、新增远程通道或组织治理。

---

## 版本建议（仅供参考）

| 版本 | 范围 |
|---|---|
| v0.8.1 | S0.1 约束入库、文档导航、开发门 |
| v0.8.2 | S0.2 Autonomy 可观测性、阻塞原因、运行诊断 |
| v0.8.3 | S0.3 Frontier 归属、代数 fencing、证据修订 |
| v0.9.0 | S1 Work State Capture、S2 Semantic Work Graph |
| v0.9.x | S3 只读自主决策回放与评估 |
| v0.10.0 | 满足全部实施门后，受控 Global 自主决策与行动 |

> 版本号仅是建议；**升级依据应当是验收条件，而不是版本发布时间。**
