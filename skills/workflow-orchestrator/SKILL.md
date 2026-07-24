---
name: workflow-orchestrator
description: 使用 subagent-win 工具编排多步骤工作流（搜索→计划→审查→执行→审查），自动在步骤间传递上下文。当用户要求执行完整工作流时使用。与 pi-codex-goal 联用时默认不设 token_budget（不限预算），仅用户显式给出预算时才限制。Wiki 只收主题向持久事实；任务临时发现不进 Wiki。
---

# Workflow Orchestrator

通过 `subagent-win` 工具编排多步骤工作流。**你是项目经理，把具体工作委派给子 agent**，自己保持轻量上下文。

## 知识落盘总原则（强制）

| 内容 | 落点 |
|------|------|
| **主题向、跨任务仍成立的已验证源码事实** | `Wiki/` 正式页：`Concepts/` `Modules/` `Architecture/` `Decisions/` `Workflows/`，`status: current` |
| **任务临时发现 / Item 调研 / 背景拼装** | **searcher 回复**；过大时 `plans/YYYYMMDD_item<NN>_<topic>_research.md`。**禁止进 Wiki** |
| **实现计划** | `plans/` |
| **任务进度** | `recentwork.md`（仓库有且任务需要时） |

**Wiki 不是任务草稿纸。**

禁止：

- `Wiki/Explorations/**`
- 任务号 Wiki 文件：`item114_*.md`、`#114_*.md`、`114_*.md`、`Item114.md`
- 把计划步骤、进度、TODO、未验证猜测写入 Wiki
- 仅为“给 planner 看”而新建 Wiki 页

正式 Wiki 页要求：主题命名（如 `plants_ui.md`）、YAML frontmatter、`status: current`、`source_paths` / Evidence；优先 edit 已有页。

## 上下文感知的任务拆分

主 agent 每次启动时都会收到 subagent-win 的当前配置，包括每个 agent 所用模型的上下文窗口大小。

**当模型上下文低于 200K 时：**

- 大范围探索拆成多个并行 searcher，每个只探索一个模块/目录
- 各 searcher **在回复中**返回已验证事实（不要写任务向 Wiki）
- 主 agent 汇总回复后交给 planner；过大发现可令 searcher 写入 `plans/*_research.md`

**当模型上下文 >= 200K 时：**

- 可一次探索较大范围
- 仍建议按目录/模块并行，提高效率

## 核心原则

1. **委派，不要亲自执行** — 搜索、实现、审查交给子 agent
2. **多用 codegraph** — 搜索阶段优先 `codegraph explore / query / node / impact`
3. **任务临时发现不进 Wiki** — 搜索结论走回复或 `plans/*_research.md`；进度走 `recentwork.md`
4. **正式 Wiki 仅主题持久事实** — 实现后若契约/模块形态长期变化，再更新正式页
5. **积极分派搜索** — 多方向时并行 searcher
6. **两种执行模式** — 单 agent 或并行 subagent
7. **前置串行，独立并行** — 有依赖串行，无依赖并行
8. **合理使用 fallback** — 仅模型层错误；逻辑失败不靠换模型掩盖
9. **Goal 默认不限预算** — `create_goal` 默认省略 `token_budget`
10. **子 agent 读 AGENTS.md** — runtime 加载 context files；角色卡仍要求显式 `read AGENTS.md`
11. **硬交接搜索结论** — 主 agent 必须把 searcher 的「已验证事实」原文或 research 路径写入下游 task，禁止假设子 agent 能看见主会话

## Goal 模式与 token 预算（默认不限制）

工作流可与 `pi-codex-goal` 联用。**预算策略优先于任何“省 token”的临时判断：**

### 默认：不限制

- 调用 `create_goal` 时 **省略 `token_budget`**
- 不要自设总数或分阶段配额
- 完整链路默认跑完

### 仅在用户显式要求时设预算

例如：「预算 300k」「token_budget=300000」

1. 只设一个覆盖整条工作流的总预算（除非用户要求按阶段拆）
2. `300k` → `300000`
3. 数字不清先问，禁止猜
4. `budgetLimited` 时汇总进度，**不要** `update_goal(complete)`

### 续跑

- 默认仍不设 `token_budget`
- 提高预算 = 用户给出新数字后重建 goal

```text
# 正确（默认）
create_goal({ objective: "...", replace_existing: true })

# 正确（用户明确 300k）
create_goal({ objective: "...", token_budget: 300000, replace_existing: true })

# 错误
create_goal({ objective: "...", token_budget: 150000 })  # 自设
```

## 跨 agent 上下文交接（强制）

子 agent 是**独立 pi 进程**（`--no-session`），不继承主会话，也看不到上一个 searcher 的回复，除非你写进 task。

### 共享外存

| 介质 | 用途 |
|------|------|
| searcher **回复文本** | 任务向已验证事实（默认） |
| `plans/*_research.md` | 过长搜索落盘 |
| `plans/<主题>.md` | 实现计划 |
| `Wiki/` 正式页 | 仅主题持久知识 |
| `recentwork.md` | 进度摘要 |

### AGENTS.md

- runtime **不**传 `--no-context-files`，会注入项目 `AGENTS.md` / `CLAUDE.md`
- 各 agent 仍应 `read` 仓库根 `AGENTS.md`
- 派 task 时可写：`先 read AGENTS.md，再执行下列任务`

### 主 agent 交接清单

阶段 1 结束后整理（记在自己上下文 / recentwork）：

```text
搜索结论（粘贴或摘要+要点列表）:
- ...
研究备注（如有）:
- plans/20260714_item112_plant_seed_research.md
正式 Wiki（仅当 searcher 实际更新了主题页）:
- Wiki/Modules/plants_ui.md
```

派 `planner` / `plan-reviewer` / `implementer` / `code-reviewer` 时：

- **必须**带上搜索结论要点或 research 路径 + 计划路径
- **不要**要求他们读 `Wiki/Explorations`
- **禁止**只说「参考刚才的搜索」而不粘贴内容/路径

### 交接失败

下游说没看到搜索依据、或计划无「依据」段：

1. 主 agent 补全结论/路径
2. 重派该步

## Agent 角色

| 角色 | 工具 | 用途 |
|------|------|------|
| `searcher` | read, grep, find, ls, bash, write, edit | codegraph 搜索；默认回复内交付事实；极少更新正式 Wiki |
| `planner` | read, grep, find, ls, write, edit | 读搜索结论 → 写 `plans/` |
| `plan-reviewer` | read, grep, find, ls, bash, write, edit | 审查并修订计划 |
| `implementer` | 全工具 | 按计划实现；长期契约变化才更新正式 Wiki |
| `code-reviewer` | read, grep, find, ls, bash, write, edit | 审查修复；对照计划 |

## 工作流：完整链路

### 阶段 1：搜索 (Search)

**不要自己搜代码。** 并行 searcher。任务发现写在**回复**里，不进 Wiki。

```json
{ "tasks": [
  { "agent": "searcher", "task": "先 read AGENTS.md。Item <NN> 背景搜索：主题 <A>。使用 codegraph explore 搜索相关结构，返回类型、接口、调用链与已验证事实（写在回复的「已验证事实」中）。不要写 Wiki/Explorations 或任务号 Wiki 页。仅当发现跨任务仍成立的主题契约缺失/过时，才 edit 正式 Wiki 页（Modules/Architecture/...）。若结论过长，可写入 plans/YYYYMMDD_item<NN>_<topic_a>_research.md。仓库有 recentwork.md 且需要时追加一行进度。Wiki 更新默认写「无」。" },
  { "agent": "searcher", "task": "先 read AGENTS.md。Item <NN> 背景搜索：主题 <B>。同上；任务发现只在回复或 plans/*_research.md。" }
], "concurrency": 3 }
```

`searcher` 会：

- 读 `AGENTS.md`、相关正式 Wiki、源码
- 用 codegraph 搜索
- 任务向结论 → 回复（或 `plans/*_research.md`）
- 仅主题持久事实 → 可选 edit 正式 Wiki
- recentwork 只记一行摘要

主 agent 进入阶段 2 前：

1. 汇总各 searcher「已验证事实」与 research 路径
2. 若有人误写任务向 Wiki：移到 `plans/*_research.md` 或删掉任务页，再继续
3. 正式 Wiki 误写任务叙事：改回主题表述或撤销

### 阶段 2：制定计划 (Plan)

**步骤 1 — 汇总（你来做）**

粘贴/提炼搜索结论；列出 research 路径。更新 `recentwork.md`（如有）。

**步骤 2 — planner**

```json
{ "agent": "planner", "task": "先 read AGENTS.md。\n\n以下为 searcher 已验证事实（全文采用）：\n---\n<粘贴汇总的已验证事实>\n---\n\n研究备注（如有，全文 read）：\n- plans/YYYYMMDD_item<NN>_<topic>_research.md\n\n相关正式 Wiki（可选背景）：\n- Wiki/Modules/....md\n\n基于上述材料制定实现计划，write 到 plans/<月日_主题>.md。要求：复用现有抽象、遵循 AGENTS.md、步骤可验证、低耦合、写清测试与风险。计划文首「依据」写清搜索结论来源与 research 路径。只改 plans/，不要写任务向 Wiki。\n\n用户需求：<原始需求>" }
```

计划应含：依据、目标、工程约束、前置/并行/后续任务、文件清单、测试与风险。

**步骤 3 — plan-reviewer**

```json
{ "agent": "plan-reviewer", "task": "先 read AGENTS.md。\n\n审查计划：plans/<月日_主题>.md\n\n对照下列搜索依据（及 research 路径）与 codegraph：\n---\n<关键已验证事实摘要>\n---\n\n重点：方案合理性、是否吸收搜索证据、标准化/工程化。直接修订计划直至初级工程师可执行。不要把任务笔记写入 Wiki。" }
```

### 阶段 3：实施

#### 模式 A：单 agent

```json
{ "agent": "implementer", "task": "先 read AGENTS.md。\n\n按计划实现：plans/<月日_主题>.md\n\n计划依据中的 research（如有）可 read。相关正式 Wiki 仅作主题背景。完成后：长期成立的接口/模块变更才写入正式 Wiki 页；任务进度写 recentwork.md（如有）。禁止 Wiki/Explorations 与任务号 Wiki 页。" }
```

```json
{ "agent": "code-reviewer", "task": "先 read AGENTS.md。\n\n对照 plans/<月日_主题>.md 审查实现完整性，直接修复。长期契约变化才更新正式 Wiki。禁止任务向 Wiki。" }
```

#### 模式 B：并行

每个 implementer/reviewer 的 task 带 **同一计划路径** + 该模块相关搜索要点（可从计划「依据」引用）。

### 阶段 4：最终审查

```json
{ "agent": "code-reviewer", "task": "先 read AGENTS.md。\n\n全量审查：对照 plans/<xxx>.md 检查改动是否完整。直接修复。仅将跨任务仍成立的事实写入正式 Wiki（Modules/Architecture/...）。更新 recentwork.md（如有）。" }
```

**正式 Wiki（可选）**

- 仅主题向、`status: current`、有 Evidence
- 可重建 `Wiki/_navigation.json`（若仓库使用）
- 不把进度/计划留在 Wiki

**recentwork.md**

- 改了哪些文件、计划路径、正式 Wiki 是否更新（一行级摘要）

## 落盘时机速查

| 步骤 | Wiki | plans / 回复 | recentwork.md |
|------|------|----------------|---------------|
| searcher | 默认 ❌；仅正式主题页可 ✅ | 回复必有事实；过大 → `*_research.md` | ✅ 一行摘要 |
| planner | ❌ | ✅ `plans/<主题>.md` | ✅ 计划已创建 |
| plan-reviewer | ❌ | ✅ 修订计划 | ✅ 已审查 |
| implementer | 仅长期主题事实 ✅ | 按计划改代码 | ✅ 实现摘要 |
| code-reviewer | 仅长期主题事实 ✅ | 修代码 | ✅ 审查摘要 |

## 快捷入口

**"完整走一遍：xxx"**  
→ goal 默认不设预算 → 并行 search（结论在回复）→ planner + plan-reviewer → implement + review → 正式 Wiki 仅收持久事实 → 证据齐备才 `update_goal(complete)`

**"先做个计划：xxx"**  
→ search → `plans/` → plan-reviewer → recentwork

**"执行计划：plans/xxx.md"**  
→ 读计划 → 缺背景再 search → implement + review

**"审查实施情况"**  
→ code-reviewer 对照计划修复；正式 Wiki 仅主题事实

## Fallback 与错误处理

- `config.json` 的 `fallbackModels` 仅用于模型层错误
- 逻辑/测试失败 → 审查或重规划，不换模型掩盖
- `isError: true` → 中止当前阶段并报告

## 中断处理（Ctrl+C / abort）

1. 当前 `subagent-win` 返回 `cancelled`，保留已有输出
2. 主 agent 判断：续跑 / 询问用户 / 终止
3. 不回滚已完成步骤（含已写的 plans/正式 Wiki）
4. 建议询问：「步骤 N 被中断。重试 / 跳过 / 终止？」
