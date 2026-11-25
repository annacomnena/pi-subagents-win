---
title: 实施门
kind: decision
status: current
updated: 2026-11-25
source_paths:
  - plans/global_master_autonomy_suite_v0.4.md
  - extensions/runtime/wake.ts
  - extensions/runtime/autonomy/action/run.ts
  - extensions/runtime-host/ws.ts
  - Wiki/Decisions/approval-gate-policy.md
  - Wiki/Decisions/host-exposure-hardening.md
  - Wiki/Development/Current-Roadmap.md
---

# 实施门（Implementation Gates）

> **本页是强制约束，不是说明文档。**
> 任何 agent / 人，在实现或修改「Global Master 自主行为」相关功能**之前**，必须先读本页
> 与 [[Current-Roadmap]]。违反本页的改动应被拒绝合并。

## 为什么有这页

原设计文档 `plans/global_master_autonomy_suite_v0.4.md` 早就把 A4/A5/A6/A7 标为**缓行**并写明前置条件
（`:6` `:18` `:33` `:1302`）。但 `plans/` 被 `.gitignore:19` 忽略
（实测 `git ls-files plans` 只有 6 个历史文件）⇒ **新机器 clone 后拿不到这条约束**。

结果就是：约束只对本机成立，对后来者等于不存在 ⇒ 下一个 agent 很可能直接去实现 A4，
撞上前置条件后才发现白做，甚至可能引入绕过审批的路径。

**本页存在的唯一目的**：让「目前不许做什么、为什么」在任何机器上都能读到。

## 硬规则

1. **A4 / A5 / A6 / A7 当前全部 BLOCKED**，见下方各门。
2. 禁止在前置未通过验收时：
   - 接通生产环境的 Global Autonomous Turn 调度；
   - 扩展未经批准的自主行动执行路径；
   - 绕过宿主归属、身份验证或审批门。
3. **允许**在隔离环境做：只读实验（`isolated-replay`）、测试夹具（`test-fixture`）、决策回放（`decision-replay`）。
4. `plans/` 里的任何文件都是**非权威工作草稿**。**任何正式约束不得仅存在于 `plans/`。**
5. 门的状态会过期。**每次要动这些功能前，重新核实本页「当前实测状态」列**，不要相信旧结论。

---

## gate: global-autonomous-turn （A4）

```yaml
gate_id: global-autonomous-turn
feature: A4 — Global Turn Scheduler
status: blocked
requires:
  - id: graph-g6-subscription
    status: pending
    what: "Graph 增量订阅（ws.ts 增加 graph topic）"
  - id: graph-g7
    status: pending
    what: "G7（定义在原设计 §13.1，需逐项补齐后才可判状态）"
  - id: autonomy-host-ownership
    status: pending
    what: "常驻宿主归属拍板：extension vs runtime-host detached 进程"
  - id: approval-gate
    status: proposed
    what: "审批门两页落地（见下）"
allowed:
  - isolated-replay
  - read-only-experiment
  - test-fixture
  - decision-replay
forbidden:
  - production-scheduling
  - unapproved-autonomous-execution
```

**当前实测状态（2026-11-25，逐项核实）**

| requires | 状态 | 证据 |
|---|---|---|
| `graph-g6-subscription` | **pending** | `extensions/runtime-host/ws.ts` 现有 topic = `journal` / `outbox`（G6-P2）/ `transcript:<sid>` / `interactions`（G6-P3）—— **没有 `graph` topic** |
| `graph-g7` | **pending（定义未迁移）** | 原设计只写「G6 订阅与 G7 落地」，G7 的具体定义在 §13.1；本次**未逐项核实 G7 是什么**，故按 pending 处理（不假设它已完成） |
| `autonomy-host-ownership` | **pending** | 原设计 `:1507` 明确「extension vs runtime-host detached 进程**未拍板**」，本次未见任何拍板记录 |
| `approval-gate` | **proposed（未落地）** | 实测 `Wiki/Decisions/approval-gate-policy.md` 与 `Wiki/Decisions/host-exposure-hardening.md` 的 frontmatter 均为 `status: proposed` —— 与原设计 `:1302` 一致 |

⇒ **A4 的四个前置无一满足，门保持 BLOCKED。**

---

## gate: watchdog-scheduler （A5）

```yaml
gate_id: watchdog-scheduler
feature: A5 — Watchdog Scheduler
status: blocked
requires:
  - id: global-autonomous-turn     # 同 A4 全部前置
    status: pending
  - id: graph-state-engine-before-a5
    status: pending
    what: "Graph/State Engine 必须先于 A5 落地"
allowed:
  - read-only-checks
  - test-fixture
forbidden:
  - production-scheduling
```

**为什么多一条前置**：原设计 `:1306` 的硬判断 —— `watchdog.ts` 的检查 3
（`pending_request_timeout`）与检查 8（`state_projection_inconsistent`）在 Graph 落地前
**恒 `unknown`**（无载体）⇒ 调度器建好也是空转。
「调度器在跑但恒 unknown」正是本仓最该避免的形状（看起来在工作，实际零信息）。

---

## gate: adaptive-cadence （A6）

```yaml
gate_id: adaptive-cadence
feature: A6 — Adaptive Cadence
status: blocked
requires:
  - id: global-autonomous-turn
    status: pending
  - id: execution-persistence-expiry
    status: pending
    what: "执行端/持久化/到期裁决，以原设计 §15 补节为准（该补节是否存在未核实）"
```

> 注意：上一版《Next Phase》文档只点了 A4/A5/A7，**漏了 A6**。A6 同样缓行（原设计 `:1318-1322`）。

---

## gate: strategic-review （A7）

```yaml
gate_id: strategic-review
feature: A7 — Strategic Review
status: blocked
requires:
  - id: global-autonomous-turn
    status: pending
  - id: config-executor
    status: pending
    what: "config.ts#L32-L37 目前仅常量（注释写「v1 只落常量，无执行端」）"
```

---

## 与既有决策页的关系

**不要为这些前置新建 `ADR-00x` 页** —— 本仓已有 `Wiki/Decisions/`（7 页，frontmatter `kind: decision` + `status:`）
作为决策记录体系。A4 前置 ③ 要求的两页已经在那里：

- [[审批门策略]]（`Wiki/Decisions/approval-gate-policy.md`，`status: proposed`）
- [[Host 暴露面加固]]（`Wiki/Decisions/host-exposure-hardening.md`，`status: proposed`）

新增决策走既有目录即可；**本页只负责「门」**（前置 + 当前状态 + 允许/禁止），
不重复记录决策理由。

## 校验

`scripts/check-development-contracts.mjs` 会检查：

1. 本页引用的 `Wiki/**` 路径是否存在；
2. 每个 `gate_id` 唯一且 `status` 在允许集合内（`blocked` / `open`）；
3. `Current-Roadmap.md` 里出现的 gate 引用都能在本页找到；
4. `Wiki/Development/` 下的页面确实被 `Wiki/_index.md` 导航到（防止写入却无人读）。
