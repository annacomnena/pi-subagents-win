---
name: workflow-orchestrator
description: 使用 subagent-win 工具编排多步骤工作流（搜索→计划→审查→执行→审查→Wiki 收尾），自动在步骤间传递上下文；也支持深度研究模式（research-only：并行搜索→研究报告→Wiki 收尾，不做实现）与快速执行模式（execute-only：结论已明确，跳过搜索与计划，实现→审查→Wiki 收尾）。当用户要求执行完整工作流、深度研究或快速执行时使用。与 pi-codex-goal 联用时默认不设 token_budget（不限预算），仅用户显式给出预算时才限制。Wiki 只更新对应功能/主题正式页；禁止 taskXXX 任务描述进 Wiki；任务临时发现不进 Wiki。
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
- 仅为“给下游看”而新建 Wiki 页——页必须因「跨任务主题」而存在，不是当传递便签

**Wiki 是跨 agent 的共享知识源**：searcher 主动维护主题页（过期更新、缺失且已验证的跨任务主题新建）；主 agent 派发 planner/implementer/reviewer 时**必须带上 searcher 产出的 Wiki 章节引用**，要求下游先 `read` 这些章节复用知识，避免重复探索。任务临时发现仍只进回复/`plans/`，绝不进 Wiki。

正式 Wiki 页要求：主题/功能命名（如 `plants_ui.md`）、YAML frontmatter、`status: current`、`source_paths` / Evidence；优先 edit 已有**功能页**。

**Wiki 收尾（完整链路必做阶段 5）：** 实现与审查后对照改动，更新**对应功能**正式页；可结论「Wiki 更新：无」。**禁止**把 `taskXXX` / Item 号 / 计划步骤写进 Wiki——那是 recentwork / plans 的事，不是 Wiki 的事。

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
2. **Wiki 第一站（术语发现 → 精确定位 → 直接交接）+ codegraph** — 仅新主题查询时，用 `wiki-nav keywords queries=[...]` 查精确术语，exact miss 才用 `semantic-terms` 扩展候选，选词后 grep 定位 Wiki；searcher 一旦确认 `Wiki/path.md#章节`，该地址就是本 workflow 的规范交接物，后续 agent 直接 read，绝不重新术语发现。再按页内 `source_paths` 直达代码，联合 `codegraph explore / query / node / impact` 追溯；**主动维护主题页：过期更新、缺失且已验证的跨任务主题新建、同主题碎片自主合并**
3. **任务临时发现不进 Wiki** — 搜索结论走回复或 `plans/*_research.md`；进度走 `recentwork.md`
4. **正式 Wiki 仅主题/功能页** — 收尾阶段必须对照改动更新**对应功能**正式页；禁止 task/Item 叙事进 Wiki
5. **积极分派搜索** — 多方向时并行 searcher
6. **两种执行模式** — 单 agent 或并行 subagent
7. **前置串行，独立并行** — 有依赖串行，无依赖并行
8. **模型选择守配置优先** — 默认走各 agent 的 config 默认 + fallback 链，不主动 override；仅当 fallback 也用尽/用户指定/配置模型明显不合适才换；勿擅自用未配置的外部 CLI
9. **Goal 默认不限预算** — `create_goal` 默认省略 `token_budget`
10. **子 agent 读 AGENTS.md** — runtime 加载 context files；角色卡仍要求显式 `read AGENTS.md`
11. **硬交接搜索结论 + Wiki 章节透传** — 主 agent 必须把 searcher 的「已验证事实」原文（每条含**代码位置 + Wiki 章节引用 + 校准状态**）或 research 路径写入下游 task；**并显式列出 searcher 产出的「Wiki 章节引用清单」与「Wiki 维护记录」，要求下游先 `read` 这些章节**。这些地址在本 workflow 内是规范输入：planner/implementer/reviewer 不得对已交接主题重跑 keywords/semantic/grep 猜地址，除非引用失效或要发现新主题。禁止假设子 agent 能看见主会话

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
搜索结论（粘贴或摘要+要点列表；每条事实保留：代码位置 + Wiki 章节引用 + 校准状态）:
- 事实A  · 代码：path/to/file.ts:Symbol  · Wiki：Wiki/Modules/xxx.md#章节  · 校准：✅/✏️/⚠️/➖
- ...
Wiki 章节引用清单（透传给下游，要求他们先 read）:
- Wiki/Modules/xxx.md#章节 — <主题>（状态 ✅/✏️/⚠️/✚）
Wiki 维护记录（searcher 本轮新建/更新/标 stale 的页，供阶段 5 参考）:
- Wiki/Modules/xxx.md — ✏️已更新 / ✚新建 / ⚠️标 stale …
研究备注（如有）:
- plans/20260714_item112_plant_seed_research.md
```

派 `planner` / `plan-reviewer` / `implementer` / `code-reviewer` 时：

- **必须**带上搜索结论要点或 research 路径 + 计划路径
- **必须**列出 searcher 的「Wiki 章节引用清单」，并在 task 里写明「先 `read` 这些 Wiki 章节」，让下游复用已沉淀知识
- **不要**要求他们读 `Wiki/Explorations`
- **禁止**只说「参考刚才的搜索」/「看下 Wiki」而不粘贴内容/具体章节路径

### 交接失败

下游说没看到搜索依据、或计划无「依据」段：

1. 主 agent 补全结论/路径
2. 重派该步

## Agent 角色

| 角色 | 工具 | 用途 |
|------|------|------|
| `searcher` | read, grep, find, ls, bash, write, edit | **Wiki 第一站**（关键词 → `source_paths` → codegraph）；**主动维护主题页**（过期更新/缺失创建）；回复内交付「代码位置+Wiki 章节」结构化事实 + 维护记录 |
| `planner` | read, grep, find, ls, write, edit | 先 read 指定 Wiki 章节 + 搜索结论 → 写 `plans/` |
| `plan-reviewer` | read, grep, find, ls, bash, write, edit | 先 read 指定 Wiki 章节；审查并修订计划 |
| `implementer` | 全工具 | 先 read 指定 Wiki 章节；按计划实现；长期契约变化更新正式 Wiki |
| `code-reviewer` | read, grep, find, ls, bash, write, edit | 先 read 指定 Wiki 章节；审查修复；对照计划 |
| `consultant` | read, grep, find, ls, bash, write, edit | **用户点名模型的咨询/评估**（「请glm来评估一下」「请gpt5.6看看截图仿照设计」）；模型用用户点名模型作 `model` override（短名自动展开），未点名用 config 默认 |

## 工作流：完整链路

### 阶段 1：搜索 (Search)

**不要自己搜代码。** 并行 searcher。任务发现写在**回复**里，不进 Wiki。

```json
{ "tasks": [
  { "agent": "searcher", "task": "先 read AGENTS.md，再 read Wiki/_index.md（若存在）。Item <NN> 背景搜索：主题 <A>。**以 Wiki 为第一站**：仅对尚未定位的新主题，将任务拆成 1-5 个短语→`wiki-nav keywords queries=[...]` exact-check→仅对 exact miss 用 `semantic-terms` 获取术语候选→选词 grep 定位 Wiki；一旦确认 `Wiki/path.md#章节`，记录它为本 workflow 的规范地址，后续下游直接 read、不可重新猜地址。再读该页 frontmatter 的 `source_paths` 与 Evidence → 按其直达源码（`file#L49` / `file::Symbol`）→ 联合 codegraph node/impact 追溯调用链 → **主动维护主题页**：过期则按源码修正（status: current，更新 source_paths/updated/Evidence，或标 stale）；若某跨任务主题尚无正式页且已源码验证，新建主题命名页。回复必含：①「已验证事实」每条带代码位置+Wiki 章节引用（`Wiki/Modules/xxx.md#章节`，无则 Wiki：无）+校准状态；②「Wiki 章节引用清单」（给主 agent 透传下游，作为直接 read 的规范地址）；③「Wiki 维护记录」（新建/更新/标 stale 的页，无则写无；若有任何页变动，随后必须调 `wiki-nav rebuild` 重建索引）。禁止 Wiki/Explorations 与任务号页；任务发现只进回复或 plans/*_research.md。若结论过长可写入 plans/YYYYMMDD_item<NN>_<topic_a>_research.md。recentwork（如有）追加一行进度。" },
  { "agent": "searcher", "task": "先 read AGENTS.md，再 read Wiki/_index.md（若存在）。Item <NN> 背景搜索：主题 <B>。同上流程（Wiki 第一站 → source_paths → codegraph → 主动维护主题页）；回复同样含 ①已验证事实（带代码位置+Wiki 章节+校准状态）②Wiki 章节引用清单 ③Wiki 维护记录。" }
], "concurrency": 3 }
```

`searcher` 会：

- 读 `AGENTS.md`、`Wiki/_index.md`、相关正式 Wiki、源码
- **按关键词查 Wiki → 按 `source_paths` 直达代码 → 联合 codegraph 追溯**
- **主动维护主题页**：过期按源码修正（`current`/标 `stale`）；缺失且已验证的跨任务主题 → 新建主题页
- 任务向结论 → 回复（或 `plans/*_research.md`），每条事实带**代码位置 + Wiki 章节引用 + 校准状态**
- 回复另含「Wiki 章节引用清单」与「Wiki 维护记录」（供主 agent 透传下游 / 阶段 5）
- recentwork 只记一行摘要

主 agent 进入阶段 2 前：

1. 汇总各 searcher「已验证事实」（保留每条的代码位置 + Wiki 章节引用 + 校准状态）与 research 路径
2. **确认每个改动过 wiki 的 searcher 都已调 `wiki-nav rebuild`**；合并各 searcher 的「Wiki 章节引用清单」与「Wiki 维护记录」——这是后续每个下游 task 的必带项 + 阶段 5 的依据
3. 若有人误写任务向 Wiki：移到 `plans/*_research.md` 或删掉任务页，再继续
4. 正式 Wiki 误写任务叙事：改回主题表述或撤销

### 阶段 2：制定计划 (Plan)

**步骤 1 — 汇总（你来做）**

粘贴/提炼搜索结论；列出 research 路径。更新 `recentwork.md`（如有）。

**步骤 2 — planner**

```json
{ "agent": "planner", "task": "先 read AGENTS.md。\n\n先 read 下列已验证 Wiki 章节（searcher 本轮确认/维护的规范地址，复用知识；不得重跑 keywords/semantic/grep 猜地址）：\n- Wiki/Modules/xxx.md#章节\n\n以下为 searcher 已验证事实（全文采用，每条含代码位置+Wiki 章节+校准状态）：\n---\n<粘贴汇总的已验证事实>\n---\n\n研究备注（如有，全文 read）：\n- plans/YYYYMMDD_item<NN>_<topic>_research.md\n\n基于上述材料制定实现计划，write 到 plans/<月日_主题>.md。要求：复用现有抽象、遵循 AGENTS.md、步骤可验证、低耦合、写清测试与风险。计划文首「依据」写清搜索结论来源、read 过的 Wiki 章节与 research 路径。只改 plans/，不要写任务向 Wiki。\n\n用户需求：<原始需求>" }
```

计划应含：依据、目标、工程约束、前置/并行/后续任务、文件清单、测试与风险。

**步骤 3 — plan-reviewer**

```json
{ "agent": "plan-reviewer", "task": "先 read AGENTS.md。\n\n先 read 下列已验证 Wiki 章节（searcher 交接的规范地址，理解现状契约；不得重跑术语发现）：\n- Wiki/Modules/xxx.md#章节\n\n审查计划：plans/<月日_主题>.md\n\n对照下列搜索依据（及 research 路径）与 codegraph：\n---\n<关键已验证事实摘要>\n---\n\n重点：方案合理性、是否吸收搜索证据、是否与 Wiki 现状契约一致、标准化/工程化。直接修订计划直至初级工程师可执行。不要把任务笔记写入 Wiki。" }
```

### 阶段 3：实施

#### 模式 A：单 agent

```json
{ "agent": "implementer", "task": "先 read AGENTS.md。\n\n先 read 下列已验证 Wiki 章节（searcher 交接的规范地址，复用现状认知；不得重跑术语发现）：\n- Wiki/Modules/xxx.md#章节\n\n按计划实现：plans/<月日_主题>.md\n\n计划依据中的 research（如有）可 read。完成后：长期成立的接口/模块变更才写入正式 Wiki 页；任务进度写 recentwork.md（如有）。禁止 Wiki/Explorations 与任务号 Wiki 页。" }
```

```json
{ "agent": "code-reviewer", "task": "先 read AGENTS.md。\n\n先 read 下列已验证 Wiki 章节（searcher 交接的规范地址，核对实现是否符合现状契约；不得重跑术语发现）：\n- Wiki/Modules/xxx.md#章节\n\n对照 plans/<月日_主题>.md 审查实现完整性，直接修复。长期契约变化才更新正式 Wiki。禁止任务向 Wiki。" }
```

#### 模式 B：并行

每个 implementer/reviewer 的 task 带 **同一计划路径** + 该模块相关搜索要点（可从计划「依据」引用）。

### 阶段 4：最终审查

```json
{ "agent": "code-reviewer", "task": "先 read AGENTS.md。\n\n先 read 下列已验证 Wiki 章节（核对改动与现状契约）：\n- Wiki/Modules/xxx.md#章节\n\n全量审查：对照 plans/<xxx>.md 检查改动是否完整。直接修复。本步以代码为准；正式 Wiki 留给阶段 5 收尾统一更新（若你顺手改了正式功能页，只写主题契约，禁止 task/Item 叙事）。更新 recentwork.md（如有）。" }
```

### 阶段 5：Wiki 收尾（强制走一遍；可结论为「无」）

实现与审查结束后，**主 agent 必须做一次 Wiki 收尾**，而不是把任务笔记塞进 Wiki。

#### 目标

- **直接更新对应功能/主题的正式页**（如 `Wiki/Modules/plants_ui.md`、`Wiki/Architecture/...`、`Wiki/Concepts/...`）
- 写清：**现在系统怎样**、关键路径/接口、`source_paths` / Evidence、`status: current`
- **禁止**在 Wiki 写任务过程：`taskXXX` / `Item NN` / `#114` / 计划步骤 / TODO /「本次做了什么」叙事
- **禁止**新建任务向页：`Wiki/Explorations/**`、`item114_*.md`、`#114_*.md`、`114_*.md`、`Item114.md`、`task_*.md`

#### 怎么做

1. **对照材料**（主 agent 自己整理，不必再开大搜索）：
   - 计划路径 `plans/<主题>.md` 的目标与文件清单
   - 实际改动的源码路径 / 接口
   - 已有正式 Wiki 中与这些模块相关的页（优先 **edit 已有功能页**，不要为任务新建页）
2. **判断是否需要写 Wiki**：
   - 有长期成立的行为/契约/模块边界变化 → **必须**更新对应功能页
   - 纯内部重构、无对外行为变化、或仓库无 Wiki 约定 → 结论 **「Wiki 更新：无」**，记入 `recentwork.md` 即可
2.5. **碎片化收敛（自主决定）**：用 `wiki-nav around "<相关主题>" --depth 2` 看相关子树；若发现**同一主题被分散在多个页**，自主判断是否合并成「一页多章节」（并入最贴切的页当章节，其余删除/重定向）。这是语义判断，由执行 agent 决定；不合并就在回复写一句理由。

3. **委派或自改**（二选一；改动面大时委派）：

```json
{ "agent": "searcher", "task": "先 read AGENTS.md。\n\n【Wiki 收尾 · 仅功能页】\n计划：plans/<主题>.md\n本轮相关源码改动（摘要）：\n- path/a.ts …\n- path/b.ts …\n\n任务：\n1. 先用 `wiki-nav find/around` 确认归属主题页：能 `edit` 进现有页当章节就**不新建**（合并优先）。找到并 edit **对应功能/主题** 的正式 Wiki 页（Modules/Architecture/Concepts/Decisions/Workflows）。没有合适页且确实形成了新的跨任务主题时，才新建**主题命名**页（如 plants_ui.md），禁止任务号/task 文件名。若 `wiki-nav` 发现同一主题散在多页，自主合并成「一页多章节」。\n2. 页面内容写「功能现在如何工作 / 关键接口与路径 / 约束」，YAML frontmatter：status: current，补 source_paths 与 Evidence。\n3. **禁止**写入：taskXXX、Item NN、计划步骤、进度、TODO、未验证猜测、「本次任务做了…」。\n4. 若无需更新，回复明确写：Wiki 更新：无（理由一句话）。\n5. 改完 wiki 后调 `wiki-nav rebuild` 重建 _navigation.json + _search.json + _keywords.json（快，亚秒~秒级，勿跳过）；不要把进度写进 Wiki。" }
```

4. **主 agent 验收清单**（进入 complete 前）：
   - [ ] 每个有长期契约变化的功能，已落到**功能页**而非任务页
   - [ ] 无碎片化：`wiki-nav around` 检查过相关子树，同一主题未分散在多个页（或已自主合并）
   - [ ] 已调 `wiki-nav rebuild` 重建索引，`_navigation.json` 反映本轮所有新增/合并/删除
   - [ ] 全文检索不应出现新建的 `task`/`itemNN`/`#NN` Wiki 文件
   - [ ] `recentwork.md`（如有）一行：改了哪些正式 Wiki 页，或「Wiki 更新：无」

**recentwork.md**

- 改了哪些文件、计划路径、**正式功能 Wiki 页列表或「无」**（一行级摘要）

## 工作流：深度研究模式（research-only）

**适用**：用户要求「深度研究 / 最大化搜索 / 彻底调研 / 摸底某主题」，只要结论不要实现（如评估方案、摸清现状、对比架构、排查范围界定）。由 launch-tabs 以 `mode: "research"` 启动（首行前缀 `根据research进行工作<taskId>`），或在本会话里直接按本节执行。

**与完整链路的区别**：不做 planner / plan-reviewer / implementer / code-reviewer；不写实现计划（`plans/<主题>.md`）；产出是**研究报告**而非计划。搜索纪律不变：Wiki 第一站、`source_paths` 直达、codegraph 验证、主动维护主题页；任务临时发现仍只进回复 / `plans/*_research.md`。

### 阶段 R1：最大化并行搜索

- 把主题按**模块 / 目录 / 问题维度**拆成多个**并行 searcher**（searcher 的模型上下文 <200K 时应拆得更细；这里是「广度优先」，宁可多拆几个）。
- 每个 searcher 用与完整链路阶段 1 相同的任务模板（先 read AGENTS.md 与 Wiki/_index.md → Wiki 第一站定位 → `source_paths` 直达代码 → codegraph 追溯 → **主动维护主题页**）。并在 task 里写明研究深度：覆盖现状、接口、调用链、风险点、未决问题。
- 回复必含：①「已验证事实」每条带代码位置 + Wiki 章节引用 + 校准状态；②「Wiki 章节引用清单」；③「Wiki 维护记录」（改过页的 searcher 随后调 `wiki-nav rebuild`）。
- 结论过大 → searcher 写 `plans/YYYYMMDD_research_<topic>_partN.md`。

### 阶段 R2：汇总 + 研究报告

主 agent 合并各 searcher 结论、合并 Wiki 维护记录并确认已 rebuild，然后 **write `plans/YYYYMMDD_research_<topic>.md`**（研究报告，不是实现计划）：

- 研究目标 / 范围边界
- **事实表**：每条 = 事实 + 代码位置 + Wiki 章节引用 + 校准状态（✅/✏️/⚠️/➖）
- 架构现状 / 调用链 / 接口清单（任务向结论，写这里，不进 Wiki）
- 风险点与未决问题
- 可选：建议方向（**明确标注为建议**，非已验证事实）

`recentwork.md`（如有）记一行：报告路径 + 涉及主题。

### 阶段 R3：Wiki 收尾

同完整链路阶段 5：只更新/新建**主题向**正式页（委派 searcher 或自己改），改后 `wiki-nav rebuild`；无变化则结论「Wiki 更新：无」。验收：无任务号 / Explorations 页；全文检索无 `itemNN` / `#NN` 新建文件。

> 若研究过程中发现必须实现 → 回主会话说明，由用户决定是否升级为完整链路（重新用 `mode: "workflow"` 启动或按完整链路续跑）。

## 工作流：快速执行模式（execute-only）

**适用**：任务已有**明确结论/已确认方案**（用户拍板、research 报告结论、既有 `plans/` 计划、或上一轮讨论已收敛），只需落地代码，不需要再搜索或规划。由 launch-tabs 以 `mode: "execute"` 启动（首行前缀 `根据execute进行工作<taskId>`），或在本会话直接按本节执行。

**与完整链路的区别**：不做阶段 1 搜索、不做 planner / plan-reviewer；直接用交接材料进入实现。**交接材料缺失/矛盾时**（无结论、无计划、范围不明、结论与现状冲突）→ 先回主会话/向用户确认，**不要凭空设计或自行扩大范围**。

### 阶段 E1：实施（implementer）

- 先 read 仓库根 AGENTS.md，再 read 交接材料：结论原文 / 计划路径（`plans/<主题>.md`）/ research 报告 / 交接的 Wiki 章节清单。
- 按交接结论直接实现；若结论是研究报告而非实现计划，可先由主 agent 或 implementer 落一份简短实现要点（写 `plans/` 或直接在实现中体现），但**不做重新调研**。
- 缺背景时可 read 交接材料引用的 Wiki 章节或文件补上下文，不做全量搜索。
- 长期成立的接口/模块契约变化才写正式 Wiki 页（顺手）；任务进度写 recentwork.md。

### 阶段 E2：审查（code-reviewer）

- 对照结论/计划审查实现完整性，**直接修复**。以代码为准。

### 阶段 E3：Wiki 收尾

同完整链路阶段 5：只更新/新建**主题向**正式页；改后 `wiki-nav rebuild`；无变化则结论「Wiki 更新：无」。验收：无任务号 / Explorations 页。

## 落盘时机速查

| 步骤 | Wiki | plans / 回复 | recentwork.md |
|------|------|----------------|---------------|
| searcher | **主动维护主题页**：过期 ✏️、缺失 ✚（仅主题）；任务发现仍 ❌；**负责阶段 5 Wiki 收尾** | 回复必有事实；过大 → `*_research.md` | ✅ 一行摘要 |
| planner | ❌（先 read 指定 Wiki 章节） | ✅ `plans/<主题>.md` | ✅ 计划已创建 |
| plan-reviewer | ❌（先 read 指定 Wiki 章节） | ✅ 修订计划 | ✅ 已审查 |
| implementer | 先 read 指定 Wiki 章节；实现中顺手改长期契约 ✅；收尾移交 searcher | 按计划改代码 | ✅ 实现摘要 |
| code-reviewer | 先 read 指定 Wiki 章节；默认留给阶段 5 | 修代码 | ✅ 审查摘要 |
| **阶段 5 Wiki 收尾（searcher）** | **✅ searcher 更新对应功能页**；可结论「无」 | 可选 | ✅ 列出页或「无」 |
| **深度研究模式（research-only）** | 只更新主题页（searcher） | ✅ `plans/YYYYMMDD_research_<topic>.md` 研究报告；过大 → `*_research.md` | ✅ 一行摘要 |
| **快速执行模式（execute-only）** | 长期契约变化才更新（E1 顺手 / E3 收尾） | ✅ 按交接结论/计划实现 | ✅ 一行摘要 |

## 快捷入口

**"完整走一遍：xxx"**  
→ goal 默认不设预算 → 并行 search（结论在回复）→ planner + plan-reviewer → implement + review → **阶段 5：更新对应功能 Wiki 页（禁止 task 叙事）** → 证据齐备才 `update_goal(complete)`

**"先做个计划：xxx"**  
→ search → `plans/` → plan-reviewer → recentwork（通常不做 Wiki 收尾）

**"深度研究：xxx" / "对 xxx 做最大化搜索/调研/摸底"**  
→ **research 模式**：并行 searcher 最大化搜索（结论在回复）→ 汇总 → write `plans/YYYYMMDD_research_<topic>.md` 研究报告 → **Wiki 收尾（只更新主题页）**。不做 planner/implementer/reviewer，不写实现计划。

**"结论已明确，执行：xxx" / "按已确认的方案实现" / "执行计划 plans/xxx.md"**  
→ **execute 模式**：跳过搜索与计划 → implementer 按交接结论/计划实现 → code-reviewer 审查 → **Wiki 收尾（功能页）**。

**"执行计划：plans/xxx.md"**  
→ 读计划 → 缺背景再 search → implement + review → **Wiki 收尾（功能页）**

**"审查实施情况"**  
→ code-reviewer 对照计划修复 → 若有契约变化则 **Wiki 收尾更新功能页**

**"请 <模型> 来评估一下 / 看看截图仿照设计"（用户点名模型咨询）**  
→ **派 `consultant`**，`model` 传用户点名的模型（短名如 glm / gpt5.6 / opus4.6 自动展开为 provider/id），task 里写明以该模型视角作答；截图场景把截图路径写进 task，让 consultant `read` 图片后仿照设计。**不要**用 searcher / code-reviewer / planner 顶替这类请求。用户未点名模型时用 consultant 的 config 默认。

## Fallback 与错误处理

### 模型选择优先级（遵守）

1. **默认走配置**：派 subagent 时**不传 `model`**，让它跑各自 `config.json` 的默认模型 + fallback 链。这是常态。
2. **才 override `model`**，且仅当下列之一成立：
   - fallback 链也用尽（默认+所有 fallback 都失败，如整链 USAGE_CAP）；
   - **用户明确指定**某个模型/agent；
   - 配置模型对本任务**明显不合适**（上下文太小、能力不匹配）。
3. override 时优先用普通 `provider/id`；**勿主动切外部 CLI**（`cli:claude/codex/agy/atomcode`），除非该 agent 的配置本就用它、或用户明确要求——「存在某个 cli: 后端」本身绝不是用它的理由。

### 机制

- `config.json` 的 `fallbackModels` 仅用于模型层错误（含 **GLM 套餐/额度上限**、429、鉴权、网络）
- 子 agent 失败时工具结果会带结构化块：`[subagent-failure kind=USAGE_CAP|…]`、`tried_models=…`、`error=…`
- **kind=USAGE_CAP**（套餐/用量到顶）时，主 agent **必须**：
  1. 不要用同一模型盲目重试
  2. 用 `/model`（或 `setModel`）把**主会话**切到更高阶/其他 provider
  3. 重跑失败步骤时传 `model=` 覆盖，或更新 `/sub-models` 默认值；避开 `tried_models`
- 逻辑/测试失败 → 审查或重规划，不换模型掩盖
- `isError: true` → 中止当前阶段并报告；若是 USAGE_CAP，先换模再决定是否重跑

## 中断处理（Ctrl+C / abort）

1. 当前 `subagent-win` 返回 `cancelled`，保留已有输出
2. 主 agent 判断：续跑 / 询问用户 / 终止
3. 不回滚已完成步骤（含已写的 plans/正式 Wiki）
4. 建议询问：「步骤 N 被中断。重试 / 跳过 / 终止？」
