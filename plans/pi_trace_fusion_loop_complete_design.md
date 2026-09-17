# PI `subagent-win`：`/trace-fusion-loop` 完整设计方案

> **设计状态**：Proposed / implementation-ready  
> **修订**：v2（2026-09-15 review）——修正 P1 工具名事实错误（pi 无 grep/find/ls 工具）、P2 Commit 2 全局 allowlist 回归风险、P3 补 Worktree Provisioning、P4 硬证据改 supervisor 自算、P5 coordinator 重启恢复、P6 lane 时限；里程碑切分 v0.3/v0.4/v0.5。  
> **基线插件**：`subagent-win v0.2.1`（2026-09-15 上传版本）  
> **目标命令**：`/trace-fusion-loop`  
> **第一阶段原则**：作为独立 orchestration island 实现，**不接入 Lite / Full workflow**。  
> **默认计算拓扑**：3 条独立、可写、可测试的 Git worktree trajectory → Fusion → 必要时高阶模型咨询 → 定向补证据 → 最终候选提升或 fresh synthesis。  
> **默认 Trace worker 权限**：自己可直接搜索 / 编辑 / 测试；**禁止任何 workflow；最多只能委派 searcher**。

---

# 0. 执行摘要

本方案不再把目标定义为“给 PI 加一个 Trace as State 开关”，而是实现一个针对软件工程任务的独立 **Trace Fusion Loop（TFL）**：

```text
/trace-fusion-loop <task>

                         当前仓库状态 X
                              │
                    Freeze Base Snapshot
                              │
             ┌────────────────┼────────────────┐
             │                │                │
             ▼                ▼                ▼
         Trace A          Trace B          Trace C
         WT-A             WT-B             WT-C
         visible tab      visible tab      visible tab
         full direct      full direct      full direct
         execution        execution        execution
             │                │                │
        reasoning          reasoning         reasoning
        edits/tests        edits/tests       edits/tests
        failures           failures          failures
             │                │                │
             └────────────────┼────────────────┘
                              ▼
                         Fusion Layer
                   executable evidence first
                              │
               ┌──────────────┴──────────────┐
               │                             │
          confidence high               confidence weak
               │                             │
               │                       High-tier Consultant
               │                             │
               │                       targeted probes
               │                             │
               └──────────────┬──────────────┘
                              ▼
                         Re-evaluate
                              │
                ┌─────────────┴─────────────┐
                │                           │
         promote candidate             fresh synthesis
                │                           │
                └─────────────┬─────────────┘
                              ▼
                           WT-S
                    final validation/tests
                              │
                              ▼
                         final patch
```

它借鉴但不等同于任何一篇论文：

- **Scaling Test-Time Compute for Agentic Coding**：长程 coding rollout 应被表示、选择并复用；PDR 把 prior rollout summaries 用于新的 rollout。
- **CodeFuse-Agent Trajectory-Aware TTS**：多 trajectory 生成 patch，再把各 trajectory 中发现的测试汇总，用可执行 cross-validation 选解。
- **EGSS**：不要无脑扩大 ensemble，只在不确定节点增加 test-time compute。
- **CAID**：并发 SWE agent 应使用 isolated workspaces / git worktrees / branch-and-merge primitives。
- **Reflexion / ReasoningBank**：失败 trajectory 的经验可以成为下一次尝试的语言状态。
- **Trace as State**：prior trajectory 可以作为 fresh pass 的条件状态，但该论文针对 long-context reasoning，而非 SWE；这里只借鉴“先形成状态，再 fresh solve”的思想。

TFL 的核心不是“三个 agent 投票”，而是：

> **让三个独立 rollout 真正尝试解决同一个问题，利用真实编译、测试、运行错误提前暴露不同失败模式；Fusion 以可执行证据为主，提炼当下最优解；如果本地证据仍不足，再把“已经缩窄的问题”交给高阶模型，而不是让高阶模型从头重做整个仓库。**

---

# 1. 为什么第一版必须独立于 Lite / Full

当前 `subagent-win` 已经同时承担：

- headless subagent；
- parallel/async；
- visible tab；
- workflow / research / execute / adaptive；
- Lite workflow；
- timers；
- event bus；
- tab reclaim；
- report；
- Wiki。

继续把 Trace 深嵌到 Lite / Full 会立即产生以下耦合问题：

```text
Lite fan-out threshold
×
Trace 固定 3 路

Full workflow stages
×
每个 stage 是否再 3 路

workflow agent roles
×
Trace worker 自己也是完整 rollout

tab lifecycle
×
Trace round lifecycle
```

所以第一版采用：

```text
                  Existing system

       Lite / Full / research / execute / adaptive
                       │
                       │  不修改语义
                       │
────────────────────────────────────────────────

                  Trace Fusion Loop

                 /trace-fusion-loop
                       │
               own coordinator
               own worktrees
               own worker profile
               own fusion policy
```

只有验证 TFL 对真实任务稳定有收益以后，再考虑把它变成 Lite / Full 可以调用的 reasoning primitive。

---

# 2. 目标与非目标

## 2.1 v1 目标

v1 必须完成：

1. 一个独立 `/trace-fusion-loop` slash command；
2. 从用户当前可见仓库状态冻结同一个 **Base Snapshot X**；
3. 从 X 创建三个独立 Git worktree；
4. 同时打开三个可见 Windows Terminal PI tab；
5. 三个 tab 都是完整 coding rollout：
   - 可读；
   - 可编辑；
   - 可运行 PowerShell/bash、build、test；
   - 可失败、回退和重新尝试；
6. 三条轨迹互相隔离；
7. Trace worker：
   - 不得运行 Full workflow；
   - 不得运行 Lite；
   - 不得 `launch-tabs`；
   - 不得调用 planner / implementer / reviewer / consultant；
   - 最多只能委派 `searcher`；
8. 每条 trajectory 产生标准化 evidence artifact；
9. Fusion 对三个 trajectory 做证据级比较，而非模型自信投票；
10. 支持 pooled/cross validation；
11. 如果证据不足，调用配置的 **高阶 consultant model**；
12. 高阶模型主要负责：
   - 判断冲突；
   - 指出最关键缺失证据；
   - 设计信息增益最高的下一实验；
   - 不默认直接接管整个 coding task；
13. 最多一轮 targeted probe；
14. 最终：
   - 若存在已充分验证 candidate → promote；
   - 否则从同一个 Base Snapshot 建 fresh WT-S 做 synthesis；
15. 对用户主工作树的最终 apply 必须保守；
16. 支持 Windows 下可靠 cleanup / stale worktree GC；
17. 保留完整 trace artifacts 供复盘和以后 benchmark。

---

## 2.2 v1 明确不做

第一版不做：

- 不自动接入 `/lite`；
- 不自动接入 Full workflow；
- 不让 Trace worker 再开 workflow；
- 不做 MCTS；
- 不无限递归 rollout；
- 不做 5/8/16 路 ensemble；
- 不做 multi-agent debate；
- 不让三个 trajectory 互相实时通信；
- 不让高阶模型默认从零重做 task；
- 不自动把任何 candidate commit merge 到用户 branch；
- 不以 LLM 自报 confidence 作为主要 selection 信号；
- 不要求论文意义上的 raw chain-of-thought；
- 不需要修改 PI core。

---

# 3. 理论与相关工程依据

## 3.1 Scaling Test-Time Compute for Agentic Coding

论文 `arXiv:2604.16529` 指出：

> coding agent 的一个 attempt 不是一个短答案，而是包含 actions、observations、errors、partial progress 的长 trajectory；test-time scaling 的核心是如何表示、筛选和复用这些 trajectory。

其方法把 rollout 压缩为保留：

- salient hypotheses；
- progress；
- failure modes；

的 structured summary，并以：

- RTV：parallel selection；
- PDR：prior attempts → distilled summaries → new rollout；

扩展 test-time compute。

TFL 最直接借鉴的是：

```text
rollout experience
→ compact reusable representation
→ new/final rollout
```

但 TFL 增加：

- Git worktree isolation；
- executable cross-test；
- conditional high-tier consultation；
- evidence-derived confidence；
- fresh synthesis / candidate promotion 双路径。

参考：

- https://arxiv.org/abs/2604.16529

---

## 3.2 CodeFuse-Agent Trajectory-Aware Test-Time Scaling

CodeFuse 的关键发现尤其适合 TFL：

1. 单条 trajectory 的 self-validation 不可靠；
2. 多条 rollout 中常常已经存在正确 patch；
3. 真正困难的是如何选择它；
4. 将多 trajectory 中生成的测试汇总，能用 executable evidence cross-validate candidate patches。

其方法可抽象为：

```text
patch A + tests A
patch B + tests B
patch C + tests C
        │
        ▼
T = tests A ∪ B ∪ C ∪ existing tests
        │
        ▼
patch A → T
patch B → T
patch C → T
```

TFL 因此必须把：

```text
tests / repro / execution failures
```

视为一等 artifact，而不是只保存文字 reasoning。

参考：

- https://github.com/codefuse-ai/CodeFuse-Agent/blob/main/tech_report.md

---

## 3.3 EGSS

`EGSS: Entropy-guided Stepwise Scaling for Reliable Software Engineering` 的核心启发：

> test-time compute 不应该在所有位置等量展开，而应该集中在不确定性高、candidate selection 困难的阶段，同时用更强 test-suite augmentation 约束 selection。

TFL 第一轮固定 3 路是人为设定的工程起点，但后续：

```text
Round 2
```

不能再机械 3 路，而应该只对当前最大的不确定性做 1–2 个 targeted probes。

参考：

- https://arxiv.org/abs/2602.05242
- ACL 2026: https://aclanthology.org/2026.acl-long.1359/

---

## 3.4 CAID / isolated workspaces

`Effective Strategies for Asynchronous Software Engineering Agents` 明确指出 SWE 多 agent 并发的核心难点包括：

- concurrent edits interfere；
- dependency synchronization；
- partial progress integration。

其 CAID 方法把：

- centralized delegation；
- asynchronous execution；
- isolated workspaces；

作为核心，并实证讨论 Git worktree / commit / merge 等 SWE primitives。

TFL 虽然不是让 A/B/C 做不同 subtask，而是让三条 trajectory 做**同一个 task 的独立 rollout**，但 isolation primitive 完全适用：

```text
X_A = X_B = X_C = same Base Snapshot
```

参考：

- https://arxiv.org/abs/2603.21489

---

## 3.5 Reflexion / ReasoningBank

Reflexion：

```text
attempt
→ feedback
→ verbal reflection
→ episodic memory
→ next attempt
```

说明失败不应被直接丢弃。

ReasoningBank 更进一步，把成功/失败 experience 中的可泛化 reasoning 提炼为 memory，并结合 test-time scaling。

TFL 不做跨任务永久记忆，v1 只做：

```text
same-task temporary experience reuse
```

但它们支持一个关键原则：

> **失败 trajectory 仍然可能包含高价值因果信息。**

参考：

- Reflexion: https://arxiv.org/abs/2303.11366
- ReasoningBank: https://arxiv.org/abs/2509.25140

---

## 3.6 Trace as State：只借鉴 fresh-state 思想

`Trace as State` 本身研究 long-context reasoning，不是 SWE agent。

其核心是：

```text
prior reasoning traces
→ place before original long context
→ fresh reread
```

TFL 不声称复现其实验协议。

我们只借鉴：

> Finalizer 不应该机械继续某一条已有 trajectory；必要时应该带着 prior experience，在 fresh environment 中重新解决原始任务。

参考：

- https://arxiv.org/abs/2609.02702

---

# 4. 当前 `subagent-win v0.2.1` 的实现审计

本节只描述本次上传版本的实际代码。

---

## 4.1 可直接复用的能力

### `identity.ts`

已有：

```text
--tab-run-id <runId>
```

并明确采用：

```text
CLI flag 优先
env fallback
lazy getFlag()
```

这非常重要，因为代码已经记录：

> Windows Terminal 下 env 透传并不完全可靠。

Trace 身份系统必须沿用同一经验。

---

### `launch.ts`

已有成熟的：

- Windows Terminal title sanitation；
- cwd handling；
- `@prompt-file` materialization；
- `buildWindowsTerminalArgs()`；
- worktree title recognition；
- workflow prompt builder。

Trace **只能复用底层 tab launch primitive**，不能复用 workflow prompt builder。

---

### `tab-runs.ts` / `tab-runs-runtime.ts`

已有：

- dispatch ledger；
- state；
- result；
- runId；
- `tab-finish`；
- `tab-status`；
- `reclaim-tabs`；
- usage；
- event bus。

Trace 不需要重造一套 tab 存活检测。

---

### `event-bus.ts`

已有：

```text
tab result
→ main session wakeup
```

未来 Trace coordinator 可以利用这一闭环。

---

### `subagent-win`

已有：

- sync；
- parallel；
- async；
- model override；
- model fallback；
- stall timeout；
- usage accounting；
- cwd override。

Fusion、Consultant、targeted probe 都可以复用 headless runner。

---

## 4.2 必须先修 / 在 TFL 中绕开的现有问题

### 问题 A：`index.ts` 是过大的 orchestration hub

当前 `index.ts` 已经同时包含：

- config；
- agent discovery；
- child process runner；
- model fallback；
- usage；
- UI；
- launch-tabs；
- subagent tool；
- commands；
- workflow injection。

TFL 不应继续直接堆进去。

---

### 问题 B：agent frontmatter 的 `tools:` 被解析，但没有真正应用

当前：

```ts
interface AgentDef {
    tools?: string[];
}
```

且 `discoverAgents()` 会解析：

```text
tools: read, grep, find, ls, bash, write, edit, wiki-nav
```

但当前 `runSingle()` 构造 PI argv 时只有：

```text
--exclude-tools subagent-win,launch-tabs,set-timer,cancel-timer,list-timers
```

没有：

```text
--tools ...
```

因此：

> **Agent frontmatter 当前不是硬 tool capability。**

这在 TFL 中必须修，但**修法必须是 per-call opt-in，不能全局激活**。

### 修订（P2）：frontmatter → 硬 allowlist 的全局切换有回归风险

如果把 `agent.tools` 直接变成每次派发的硬 `--tools`，所有现存 agent 的行为都会改变：

```text
frontmatter 列了不存在工具名 → 被静默窄化
frontmatter 未覆盖的扩展工具（goal 工具等）→ 消失
现状：所有 agent 实际全量工具
```

这直接违反验收项「原有 Lite / Full / launch-tabs 行为不回归」。

正确做法：runner 新增 per-call 参数，**只有调用方显式传入才生效**：

```ts
interface RunSubagentOptions {
    tools?: string[];        // per-call 显式 opt-in；未传 → 不加 --tools
    excludeTools?: string[]; // 在默认 exclude 基础上叠加
}
```

优先级（修订后）：

```text
call-site tools（唯一来源）
>
PI defaults（未传时不加 --tools，行为与现状一致）
```

`agent.tools` frontmatter 继续解析、继续展示，但 v1 不作为硬约束来源。将来若要全局激活，必须先审计所有 agents/*.md 的 frontmatter 工具名是否存在于 pi（见 P1），单独评估、单独提交。

Trace helper searcher 要使用一个更窄的 allowlist（见 §11 修订）。

---

### 问题 C：现有 searcher 并非“纯搜索”

当前 `agents/searcher.md` 的 frontmatter 是：

```text
read, grep, find, ls, bash, write, edit, wiki-nav
```

并且其 prompt 还要求主动维护 Wiki。

对于普通 workflow 很合理。

对于 Trace worker：

> “最多可以用 searcher”

不应等于：

> “searcher 可以替 trace worker 实现代码 / 改 Wiki / 做第二套 workflow”。

因此 Trace 中需要：

```text
searcher role
+
trace-search override
+
narrow tool allowlist
```

建议（P1 修订：pi 内置工具只有 `read / bash / edit / write`，没有独立的 grep/find/ls 工具，搜索全走 bash）：

```text
--tools read,bash
+ prompt 纪律（只跑非变更命令）
+ supervisor 在派发前后 git status 守卫
```

注意：现有 `agents/searcher.md` frontmatter 写的 `read, grep, find, ls, ...` 本身就包含不存在的工具名——这正是 P2 要求 frontmatter 不能直接当硬 allowlist 的原因之一。

如以后确实需要 Wiki 查询，可单独增加一个只读 Wiki 查询 surface，而不是直接给现有可写 `wiki-nav rebuild` 能力。

---

### 问题 D：`resources_discover` 当前始终暴露 workflow skill

目前：

```ts
return { skillPaths: [join(PKG_DIR, "skills")] };
```

Trace worker 必须看不到 `workflow-orchestrator`。

---

### 问题 E：`before_agent_start` 当前统一注入 workflow/subagent 编排说明

Trace worker 必须走独立 early-return prompt。

不能：

```text
先注入大量 workflow 规则
最后再说“你别用 workflow”
```

---

### 问题 F：`registerLiteCommand()` 当前无条件注册

Trace worker 不应拥有 `/lite` 语义。

即使因为 extension lifecycle 无法在 factory 阶段完美隐藏命令，handler 也必须有 runtime capability guard。

---

### 问题 G：当前 `TabMode = LaunchMode`

现在：

```text
workflow | research | execute | adaptive
```

Trace tab 需要新的生命周期类型：

```text
trace
```

但不能把 `"trace"` 粗暴加入 `LaunchMode` 后让 `workflowDisciplineBlock()` fallback 到 workflow。

正确做法是：

```ts
type LaunchMode =
  | "workflow"
  | "research"
  | "execute"
  | "adaptive";

type TabMode =
  | LaunchMode
  | "trace";
```

`tab-runs` 自己理解 `trace`，而 workflow builder 不理解。

---

### 问题 H：`systemPrompt` 当前是 replacement

`runSingle()`：

```ts
const finalPrompt = systemPrompt ?? agent?.body ?? "";
```

如果调用方传 extra system prompt，agent body 被整个替换。

TFL 需要：

```text
base role prompt
+
trace-specific constraints
```

建议抽：

```ts
composeSystemPrompt(base, extra[])
```

---

# 5. 产品行为

## 5.1 主入口

第一版用户 API：

```text
/trace-fusion-loop <task>
```

例如：

```text
/trace-fusion-loop 修复 TurboQuant K8V4 在该 checkpoint 下实际回退到 FP8 KV 的问题，并补最小回归测试
```

无参数时 v1 直接显示用法并拒绝启动（修订：猜错方向的三个 rollout 太贵，不做「最近 user task」推断）。

---

## 5.2 可选状态命令

建议同时提供：

```text
/trace-fusion-status
/trace-fusion-abort
/trace-fusion-clean
/trace-fusion-last
/trace-fusion-resume   # 修订（P5）：主会话重启后从磁盘 artifact 恢复并续跑 fusion
```

v1 可以把 status/last 合并。

---

## 5.3 第一版不提供

不要一上来暴露：

```text
--workers
--fanout
--temperature
--raw-trace
--judge-count
--debate-rounds
```

固定：

```text
workers = 3
maxRounds = 2
maxConsultations = 1
```

---

# 6. Session Profile：硬能力边界

必须新增一个统一 session profile 概念。

```ts
export type SessionProfile =
  | "main"
  | "workflow-tab"
  | "trace-worker"
  | "subagent";
```

未来可扩：

```text
fusion-evaluator
trace-finalizer
```

但 v1 的 headless evaluator/finalizer 可仍归类为 `subagent`。

---

## 6.1 新 CLI flags

新增：

```text
--session-profile trace-worker
--trace-run-id <runId>
--trace-lane A
```

同时 env fallback：

```text
PI_SESSION_PROFILE=trace-worker
PI_TRACE_RUN_ID=...
PI_TRACE_LANE=A
```

**CLI flag 是 authoritative source。**

env 只用于：

- extension factory 很早期的 best-effort gating；
- backward compatibility；
- debug。

---

## 6.2 为什么必须“双轨 identity”

当前代码已经明确：

> CLI flag value 在 extension load 完成后才写入 runtime.flagValues。

所以：

- 工厂阶段完全依赖 `getFlag()` 不可靠；
- Windows env 又不能被视为唯一可靠身份通道。

因此：

### 硬安全检查

必须放在：

- tool execute；
- command handler；
- event callback；
- `before_agent_start`；
- `resources_discover`；

这些**运行时可 lazy getFlag** 的位置。

### factory-time 隐藏

只做 UX 优化，不做安全保证。

---

# 7. Capability Matrix

这是 TFL v1 最重要的契约之一。

| Capability | Main | Workflow Tab | Trace Worker | Headless Searcher |
|---|---:|---:|---:|---:|
| 直接 read/edit/test | ✓ | 依 workflow | **✓** | 搜索限定 |
| `launch-tabs` | ✓ | ✗ | **✗** | ✗ |
| `/launch` | ✓ | ✗ | **✗** | ✗ |
| `/lite` | ✓ | 现状 | **✗** | ✗ |
| workflow skill | ✓ | ✓ | **✗** | ✗ |
| planner | ✓ | ✓ | **✗** | ✗ |
| implementer | ✓ | ✓ | **✗** | ✗ |
| reviewer | ✓ | ✓ | **✗** | ✗ |
| consultant | ✓ | ✓ | **✗** | ✗ |
| searcher | ✓ | ✓ | **✓（唯一允许委派）** | ✗ |
| timer orchestration | ✓ | 现状 | **✗** | ✗ |
| tab reclaim | ✓ | ✗ | **✗** | ✗ |
| `tab-finish` | N/A | ✓ | **✓** | ✗ |
| 自己完成任务 | ✓ | PM/模式决定 | **✓** | ✗ |

---

# 8. `trace-worker` 不是 workflow PM

三个 Trace tab 的 mental model 应是：

> **我自己就是一次完整的、独立的 coding rollout。**

而不是：

> 我是 PM，我要再调用 planner → implementer → reviewer。

因此：

```text
Trace A
├── 自己 inspect
├── 自己 reason
├── 自己 edit
├── 自己 run tests
├── 自己遇错
├── 自己 revise
└── optional searcher

Trace B
└── 同上

Trace C
└── 同上
```

最大嵌套深度：

```text
Trace Worker
    └── Searcher
```

绝不能出现：

```text
Trace
  └── planner
       └── implementer
            └── reviewer
```

---

# 9. Trace worker 的三层限制

仅 prompt 约束不够。

必须三层：

## Layer 1：Identity

```text
session-profile=trace-worker
```

---

## Layer 2：Runtime capability guard

`subagent-win.execute()`：

```ts
if (isTraceWorker()) {
    assertOnlySearcher(rawParams);
}
```

无论 single / parallel：

```text
agent 必须等于 searcher
```

禁止：

```text
agent omitted
agent=general
planner
implementer
reviewer
consultant
```

因为 `agent omitted` 可能变成 unrestricted child。

---

## Layer 3：System prompt

告诉 Trace worker：

- 你不是 orchestrator；
- 你不得 workflow；
- 你自己完成 task；
- searcher 只做 targeted information retrieval。

---

# 10. Workflow / Lite 必须在 Trace tab 中消失

## 10.1 `before_agent_start`

当前普通注入逻辑之前：

```ts
if (isTraceWorker()) {
    return traceWorkerSystemInjection(...);
}
```

必须 early return。

不允许之后继续：

```text
litePromptLines
workflow descriptions
launch-tabs selection rules
```

---

## 10.2 `resources_discover`

Trace worker：

```ts
if (isTraceWorker()) {
    return { skillPaths: [] };
}
```

至少不能暴露：

```text
workflow-orchestrator/SKILL.md
```

如果未来 package 增加其它非 workflow skill，再按 allowlist 暴露。

---

## 10.3 `/lite`

handler：

```ts
if (isTraceWorker()) {
    notify("Trace worker 不支持 Lite workflow");
    return;
}
```

即使 UI 中因 extension 生命周期仍看得到 `/lite`，也必须无法生效。

---

## 10.4 `/launch`

同样增加 runtime guard。

不能只依赖：

```ts
const canOrchestrateTabs = isMainSession();
```

在 factory 阶段决定是否注册。

handler 里必须再次：

```ts
if (!capabilities().launchTabs) reject;
```

---

# 11. Trace Searcher：允许，但必须变窄

用户要求：

> Trace tab 最多可以使用 searcher。

这里建议**保留现有 searcher 角色语义中的“搜索员”部分，但不沿用其写 Wiki / edit / bash 能力**。

Trace-specific call：

```ts
subagent-win({
    agent: "searcher",
    task: "...",
    tools: ["read", "bash"],   // P1 修订：pi 内置工具只有 read/bash/edit/write；搜索走 bash
    systemPromptMode: "append",
    extraSystemPrompt: TRACE_SEARCHER_APPEND
})
```

其中：

```text
TRACE_SEARCHER_APPEND:

You are assisting an independent trace rollout.

Only gather and verify information.
Do not implement the parent task.
Do not modify code or Wiki.
Do not create plans.
Do not invoke workflows.
Return:
- exact locations
- verified facts
- contradictory evidence
- unresolved questions
```

补充约束（修订）：

- `bash` 仅限非变更命令（ls / rg / grep / find / git status / git log /只读诊断如 `tsc --noEmit --incremental false`）；
- supervisor 在派发前后各记录一次 `git status --porcelain`，tracked 文件发生变化则该 searcher 结果标记 `mutated` 并降权；
- 三路并行只读诊断（如 tsc）无共享写入状态，无冲突。

---

# 12. Runner 改造：tool allowlist 必须真正生效

`runSingle()` 需要从：

```ts
runSingle(agent, task, systemPrompt, model, ...)
```

演进为：

```ts
interface RunSubagentOptions {
    agent?: AgentDef | null;
    task: string;
    cwd?: string;
    model?: string;
    thinking?: string;

    tools?: string[];
    excludeTools?: string[];

    extraSystemPrompts?: string[];

    stallTimeoutMs?: number;
    signal?: AbortSignal;
}
```

工具解析（P2 修订：只有 call-site 显式传入才生效，agent frontmatter 不作为硬约束来源，避免现有 workflow 行为回归）：

```ts
effectiveTools = opts.tools ?? undefined;  // 未传 → 不加 --tools，与现状一致
```

PI argv：

```text
--tools read,grep,find,ls
```

然后仍然可以：

```text
--exclude-tools subagent-win,launch-tabs,...
```

做纵深防御。

---

## 12.1 Trace worker 调 searcher 时的 child identity

这是很容易漏掉的细节。

Trace worker 本身可能具有：

```text
PI_SESSION_PROFILE=trace-worker
PI_TRACE_RUN_ID=...
PI_TRACE_LANE=A
```

当前 `runSingle()` 是：

```ts
env: {
    ...process.env,
    PI_SUBAGENT: "1",
    PI_TAB_RUN_ID: "",
    PI_TAB_RUNS_DIR: "",
}
```

如果不处理：

> headless searcher 会继承 Trace profile。

所以必须显式清理：

```ts
PI_SUBAGENT: "1",
PI_SESSION_PROFILE: "subagent",
PI_TRACE_RUN_ID: "",
PI_TRACE_LANE: "",
PI_TAB_RUN_ID: "",
PI_TAB_RUNS_DIR: "",
```

保证：

```text
Trace worker → searcher child
```

child 只拥有 subagent 身份。

---

# 13. Base Snapshot：不能简单等于 HEAD

这是 TFL correctness 的基础。

用户常常在：

```text
HEAD
+ staged changes
+ unstaged changes
+ untracked files
```

状态下启动。

如果三个 worktree 只从 HEAD 建：

```text
A/B/C 看不到用户当前修改
```

结果失真。

因此必须构造一个不修改用户 branch 的 **synthetic snapshot commit**。

---

# 14. 推荐的 synthetic snapshot commit

不要：

```text
git add .
git commit
```

去碰用户 branch/index。

推荐利用 temporary index：

```text
1. 创建临时 GIT_INDEX_FILE
2. git read-tree HEAD
3. git add -A
4. git write-tree
5. git commit-tree
```

伪代码：

```bash
set GIT_INDEX_FILE=<traceDir>/base.index

git read-tree HEAD
git add -A
TREE=$(git write-tree)
BASE=$(echo "pi trace base snapshot" | git commit-tree $TREE -p HEAD)
```

该 commit：

- 写入 Git object database；
- 不移动任何用户 ref；
- 不改变当前 branch；
- 不改变用户真实 index；
- 可以被 `git worktree add --detach` 使用；
- cleanup 后成为 unreachable object，未来由 git gc 回收。

---

## 14.1 Snapshot 语义

TFL 关心：

```text
用户当前看到的文件内容
```

而不是 staged/unstaged 的逻辑区分。

因此 synthetic tree 可以把它们折叠成：

```text
one content snapshot X
```

这是合理的。

---

## 14.2 Snapshot 限制

v1 应明确：

- ignored files 不进入；
- submodule 内部 dirty working tree 不完整快照；
- LFS / giant untracked 可能有成本；
- unborn repository 可暂不支持；
- active merge/rebase/cherry-pick 状态建议拒绝启动；
- sparse checkout 要测试。

建议 preflight：

```text
git rev-parse --show-toplevel
git rev-parse HEAD
git status --porcelain=v1
git rev-parse -q --verify MERGE_HEAD
git rev-parse -q --verify REBASE_HEAD
```

另加（修订）：

```text
检查 ~/.pi/agent/trace-fusion-runs/ 是否存在 status=running 的 run
→ 存在则拒绝启动（v1 同时只允许一个 active TFL run）
```

---

# 15. Worktree 布局

Windows 路径要尽量短。

不要：

```text
~/.pi/agent/trace-fusion-runs/.../worktrees/attempt-a/...
```

建议：

```text
~/.pi/tfl-wt/<shortRunId>/
├── a/
├── b/
├── c/
├── s/
├── p1/       # targeted probe，可选
└── p2/       # targeted probe，可选
```

artifact 则可放长路径：

```text
~/.pi/agent/trace-fusion-runs/<runId>/
```

---

# 16. 创建 worktree

全部从同一个：

```text
syntheticBaseCommit
```

创建：

```bash
git worktree add --detach <a> <base>
git worktree add --detach <b> <base>
git worktree add --detach <c> <base>
git worktree add --detach <s> <base>
```

必须满足：

```text
X_A = X_B = X_C = X_S
```

这是 trajectory independence 的物理基础。

## 16.1 Worktree Provisioning（P3 修订：依赖与环境供给——缺失则整个 evidence-first 前提坍塌）

Git snapshot 只携带 tracked 内容；`node_modules` / venv / `.env` 等都是 ignored，**不会出现在新 worktree 里**。不补供给，worker 的 "may run builds and tests" 就是空话，§26–28 的可执行证据层全部落空。

因此 `CREATE_WORKTREES` 之后、`LAUNCH_TRACE_A_B_C` 之前必须有 provisioning 步骤：

```jsonc
// config（per-repo 可覆盖）
"traceFusionLoop": {
  "provisioning": {
    "junction": ["node_modules"],   // mklink /J 指向主树；typecheck/build 只读场景安全且免费
    "copy": [".env", ".env.local"], // 小文件直接复制
    "command": ""                    // 兑底：自定义 setup 脚本（在每 worktree 内执行）
  }
}
```

规则：

1. **junction 优先**：Windows `mklink /J` 无需管理员；对 tsc / vite 等 read-mostly 场景安全；
2. **例外要文档化**：往 `node_modules/.cache` 写缓存的构建（vite/jest 部分配置）会三路互踩——此时 config 切 `copy` 或 `command` 自理；
3. **eval worktrees（§28）同样要过 provisioning**；pooled test 在无依赖的 eval 树里跑不起来；
4. provisioning 失败的 lane 标记 `degraded: no-build-env`，Fusion 降权其可执行证据，而不是整 run 失败；
5. junction/copy 不进入 snapshot commit，只作用于 worktree 磁盘状态——与 git 层隔离正交。

---

# 17. 三个 visible Trace tabs

用户调用：

```text
/trace-fusion-loop <task>
```

后只自动打开：

```text
[TRACE A] <repo>-<task>
[TRACE B] <repo>-<task>
[TRACE C] <repo>-<task>
```

Trace worker tab 的 pi argv 必须带（修订，比 workflow tab 更窄）：

```text
--exclude-tools launch-tabs,set-timer,cancel-timer,list-timers,wiki-nav,wiki-semantic
```

- `wiki-nav` / `wiki-semantic` 有 rebuild/写能力，trace worker 不得碰 Wiki；
- `subagent-win` 保留（searcher 委派需要），靠 §9 的 runtime guard 窄化到 searcher-only；
- `tab-finish` / `tab-status` / `reclaim-tabs` 保留（lane 终态上报需要，复用 §23 契约）。

Fusion / consultant / finalizer 默认 headless，不继续制造 UI 噪声。

---

# 18. Trace tab 不能走现有 `launch-tabs` workflow builder

当前 `launch-tabs` 会：

```text
buildWorkflowTabPrompt()
→ workflowDisciplineBlock()
→ --skill workflow-orchestrator
```

Trace 完全不能经过该路径。

应抽出：

```text
tab-launch-core
```

供两类上层复用：

```text
launch-tabs
   ↓
workflow prompt builder
   ↓
tab-launch-core

trace-fusion-loop
   ↓
trace worker prompt builder
   ↓
tab-launch-core
```

---

# 19. 新底层模块 `tab-launch-core`

建议从 `index.ts` 抽出现在的 `dispatchPiTab()`。

```ts
interface TabLaunchOptions {
    cwd: string;
    title: string;
    prompt: string;
    model?: string;

    tabRunId: string;

    sessionProfile?: SessionProfile;
    traceRunId?: string;
    traceLane?: "A" | "B" | "C";

    skills?: string[];
}
```

`buildWindowsTerminalArgs()` 增加：

```text
--session-profile
--trace-run-id
--trace-lane
```

---

# 20. Trace tab prompt

三个 tab 接收**同一个原始 task**。

只允许 metadata 不同：

```text
lane=A/B/C
```

不要给 A/B/C 人为指定：

```text
A scheduler
B cache
C parser
```

默认必须让它们自由产生不同 trajectory。

否则会把模型强制推向三条人为假设。

---

## 20.1 Trace Worker System Prompt

建议：

```text
### Trace Fusion Worker

You are Trace {LANE}, one of three independent coding rollouts.

ROLE
- Independently attempt to solve the original task in your isolated Git worktree.
- You are the executor and investigator of this trajectory.
- You are NOT a workflow orchestrator.

HARD ORCHESTRATION BOUNDARY
- Do not use Full workflow.
- Do not use Lite workflow.
- Do not invoke launch-tabs or /launch.
- Do not invoke planner, implementer, reviewer, consultant, general, or other role agents.
- The only delegated agent you may use is searcher.
- Searcher is optional and must only gather targeted evidence.

EXECUTION
- You may inspect files.
- You may edit code.
- You may run builds and tests.
- You may add temporary instrumentation.
- You may create experimental patches.
- Failures are useful evidence.

INDEPENDENCE
- You cannot see Trace A/B/C peers.
- Do not speculate about what other traces are doing.
- Do not optimize for agreement.
- Solve the task independently.

GIT
- Your worktree is disposable.
- Do not merge/cherry-pick from external branches.
- Do not modify the parent repository outside this worktree.
- Avoid commits unless required by a tool; final evidence is collected relative to the trace base.

FINISH
Before tab-finish, produce:
1. root cause / hypotheses
2. experiments performed
3. failures and what they teach
4. successful observations
5. files changed
6. validation commands and results
7. new/modified tests
8. unresolved risks
9. recommended final direction
```

---

# 21. Trajectory Artifact Contract

每个 lane 都必须产生：

```text
trace-fusion-runs/<runId>/lanes/A/
├── trajectory.md
├── result.json
├── patch.diff
├── status.txt
├── validation.json
└── logs/
```

B/C 相同。

## 21.0 权威来源划分（P4 修订：硬证据 supervisor 自算，不信 worker 自报）

弱模型会忘写 artifact、写错路径、甚至幻觉内容。因此：

```text
supervisor 计算（权威，Fusion 只信这些）：
  patch.diff / changed files / untracked 列表 / build 可达性

worker 叙事（参考，不作硬证据）：
  trajectory.md / validation.json 中的口头描述
```

worker 的 `validation.json` 中仅 `reproductionCommands`（命令本身）和 `testFiles` 被采信并交 cross-test 复跑验证——命令的**结果**一律以 supervisor 复跑为准。

---

## 21.1 `trajectory.md`

结构：

```markdown
# Trace A

## Final hypothesis / root cause

## What I tried

## Failed approaches
- attempt
- observed failure
- implication

## Successful evidence

## Code changes

## Tests / reproductions

## Contradictory evidence

## Remaining uncertainty

## Recommended final direction
```

---

## 21.2 `validation.json`

例如：

```json
{
  "reproductions": [
    {
      "command": "npm test -- foo",
      "before": "fail",
      "after": "pass",
      "portable": true
    }
  ],
  "validationCommands": [
    "npm test -- foo",
    "npm test"
  ],
  "testFiles": [
    "tests/foo.test.ts"
  ],
  "buildStatus": "pass",
  "targetStatus": "pass",
  "regressionStatus": "partial"
}
```

这里的 `portable` 很重要：

> Fusion 可以尝试把相同 command 用到其它 candidate。

---

## 21.3 `patch.diff`

不要只：

```text
git diff
```
假设 worker 没 commit。

P4 修订：patch.diff 由 **supervisor 在 lane 终态后自己计算**（三段式，覆盖 worker 已 commit 与未 commit 两种情形）：

```text
part1: git -C <WT-X> diff --binary <baseCommit> HEAD   # worker 已 commit 的部分
part2: git -C <WT-X> diff --binary                      # 未提交部分（相对其 HEAD）
part3: git -C <WT-X> status --porcelain                # untracked 文件清单，单独归档
```

合并为 `patch.diff`（part1 + part2 语义上等价于 worktree 全部修改相对 base）；untracked 文件打包到 `lanes/X/untracked/` 并在 `status.txt` 里登记。

worker 不再被要求自己产出 patch.diff（它的终态职责只剩 trajectory.md + validation.json + tab-finish）。

---

# 22. Trace worker 的终态

v1 为了降低复杂度：

> 每个 Trace tab 只跑一轮完整 rollout，然后调用现有 `tab-finish`。

不在 v1 做：

```text
same visible tab round1 → wait → round2 steering
```

这样可以直接复用：

- result.json；
- event bus；
- reclaim；
- usage。

如果后面需要真正复用同三个 tab 做 targeted round，再增加 `trace-checkpoint`。

---

# 23. `tab-finish` 如何复用

Trace worker 调：

```text
tab-finish(
  status="completed",
  summary="...",
  reportPath=".../trajectory.md",
  artifacts=[
    ".../patch.diff",
    ".../validation.json"
  ],
  openIssues=[...]
)
```

无需第一版再造 `trace-finish`。

但 `tab-finish` 的 description 应根据 session profile 注入一条 Trace-specific completion contract。

---

# 24. Fusion Supervisor

三个 Trace tab terminal 后：

```text
Fusion Supervisor
```

启动。

Supervisor 本身主要是 deterministic orchestration code，不应该全交给模型。

职责：

1. 检查 A/B/C 是否都产生有效 artifacts；
2. 解析 patch/status/validation；
3. 收集 tests/reproduction commands；
4. 执行 cross validation；
5. 构造 Fusion Packet；
6. 调用 Fusion Evaluator model；
7. 应用 confidence gates；
8. 决定：
   - promote；
   - fresh synthesis；
   - consult；
   - targeted probe。

## 24.1 Coordinator 持久化与重启恢复（P5 修订）

Fusion Supervisor 活在主会话扩展进程里，但三个 tab 要跑十几分钟——**用户中途重启主会话时 supervisor 内存态会丢**。恢复契约：

```text
磁盘是唯一真相源：meta.json + lanes/*/ + base/ 始终实时落盘

/trace-fusion-status：
  读 meta.json → tab-status 探测三个 tabRunId 终态 → 重建状态视图

发现「三路皆终态但 final/ 不存在」：
  提示 /trace-fusion-resume
  → 从磁盘 artifact 重跑 deterministic 部分（collect + cross-test，零损失）
  → 续跑 fusion/consult/finalize（模型调用可重发）
```

规则：

- tab 本身是独立进程，主会话重启不影响三个 worker 继续跑；
- event bus 唤醒只是加速器，不是正确性依赖——没被唤醒时 status/resume 兼容手动触发；
- resume 前重新校验 base commit 仍可解析（gc 安全窗口内），不可解析则降级为「artifacts-only 报告」。

## 24.2 Lane 时限（P6 修订）

可见 tab 不受 `runSingle` 的 stall timeout 约束，一个 lane 卡死（模型端 hang、worker 死循环）会让 WAIT_TRACE_RESULTS 永远等下去。

```text
maxWallClockPerLane：默认 45min，可配
超时 → 该 lane 判 failed（error=wall-clock-limit）
→ 走 §45 单路失败语义：其余 lane 继续，run 降级 2/3
→ artifact 仍按 supervisor 三段式收集（部分修改也是证据）
```

临近超时（剩 5min）向该 tab 发一条推进提醒（复用 launch-tabs timers 邮箱机制，仅提醒不强制）。

---

# 25. Fusion 不等于 voting

禁止：

```text
A 说 X
B 说 X
C 说 Y
→ X 胜
```

也禁止主要依据：

```text
A confidence=0.95
B confidence=0.82
```

因为同模型 rollout 的错误高度相关，而且 LLM self-confidence 校准有限。

正确 Fusion：

```text
A:
  diagnosis useful
  patch incomplete

B:
  patch clean
  misses edge test

C:
  implementation failed
  discovered decisive regression

Final:
  A diagnosis
  + B implementation structure
  + C regression evidence
```

---

# 26. Evidence-first candidate evaluation

每个 candidate 的 evidence 至少分：

```text
E1 reproduction evidence
E2 target test evidence
E3 existing regression suite
E4 cross-trajectory tests
E5 build/static checks
E6 root-cause consistency
E7 unresolved risks
E8 patch scope/minimality
```

其中 E1–E5 是更硬的 evidence。

模型 judgment 不允许覆盖：

```text
failing executable tests
```

---

# 27. Cross-Test 设计

## 27.1 最基础 pooled command

先收：

```text
Commands =
  commands_A
  ∪ commands_B
  ∪ commands_C
  ∪ project-required tests
```

在每个候选环境中运行 portable commands。

修订补充：

1. **命令归一化**：worker 报的命令可能带 lane worktree 绝对路径，collector 要剥除/重写为相对路径后再跨 worktree 执行，否则 eval 树里必挂；
2. **抖动防护**：判别性测试（决定 candidate 去去的 pooled test）fail 时**重跑一次**再定性，防止 flaky 假阴性击穿好候选；重跑仍 fail 才记 fail，两次不一致标 `flaky` 供 Fusion 参考。

---

## 27.2 Test patch consolidation

如果 A/B/C 新增了测试：

```text
tests_A
tests_B
tests_C
```

可以构造：

```text
Pooled Test Patch
```

但不要粗暴把所有 test files 直接拼进去。

第一版建议：

1. lane 显式报告 `testFiles`；
2. Fusion 提取这些文件相对 Base 的 diff；
3. 检查 path collision；
4. 无冲突时 merge 为 pooled tests；
5. 有冲突时交 Test Consolidator（本地模型）生成统一 test patch；
6. 在临时 evaluation worktree 中验证 pooled tests 自身可运行。

---

# 28. Evaluation worktree

不要为了 cross-test 修改 A/B/C 原始 evidence worktree。

可以临时创建：

```text
eval-a
eval-b
eval-c
```

从 Base：

```text
Base
+ candidate patch A
+ pooled test patch
```

然后执行统一验证。

验证结束即可删除。

---

# 29. Candidate Score：可排序，但不是最终真理

可以建立一个 deterministic evidence vector：

```ts
interface CandidateEvidence {
    appliesCleanly: boolean;
    buildPass: boolean;
    reproductionPass: boolean;
    targetTestsPass: boolean;
    pooledTestsPass: boolean;
    regressionPass: boolean | "partial" | "unknown";

    rootCauseSupport: "strong" | "medium" | "weak";
    unresolvedRisks: string[];
    changedFiles: number;
}
```

不要强求伪精确概率。

排序：

```text
hard pass gates
→ executable evidence count
→ unresolved risk
→ patch minimality
```

---

# 30. Confidence 采用等级，不采用假概率

建议：

```text
HIGH
MEDIUM
LOW
```

---

## 30.1 HIGH

满足类似：

```text
✓ 至少一个 candidate 可 clean apply
✓ 原始 reproduction 被解决
✓ target tests pass
✓ pooled cross-tests pass
✓ 没有新 regression
✓ 没有关键未解释矛盾
```

可以跳过高阶咨询。

---

## 30.2 MEDIUM

例如：

```text
✓ 有 plausible candidate
× pooled tests 不够完整
或
× A/B 两种 root cause 都能解释部分现象
或
× candidate 之间测试互相击穿
```

触发 consultant。

---

## 30.3 LOW

例如：

```text
× 三个 candidate 都失败
× 无法稳定 reproduce
× 三个根因完全冲突
× build/test 环境本身异常
× 所有 candidate 都只能通过自己写的测试
```

必须 consultant。

---

# 31. Fusion Evaluator model

在 deterministic evidence 形成后再调用本地 evaluator。

输入只包含：

```text
Original task
Base metadata

A summary
A patch summary
A tests/failures

B ...
C ...

Cross-test matrix

Hard evidence
Unresolved conflicts
```

不要把三个几十万 token raw session 全部塞进去。

---

## 31.1 Fusion Evaluator 输出

结构化：

```json
{
  "decision": "promote_A | promote_B | promote_C | synthesize | consult",
  "confidence": "high | medium | low",
  "bestAvailable": "A | B | C | fused",
  "why": [],
  "hardEvidence": [],
  "conflicts": [],
  "missingEvidence": [],
  "recommendedProbe": null
}
```

模型可以建议 confidence，但 extension 的 hard gates 拥有最终否决权。

JSON 容错（修订）：弱模型输出 JSON 不可靠——解析失败（非法 JSON / 缺 decision 字段）时默认降级为 `decision=consult, confidence=medium`，原文落盘 `evaluation/fusion-raw.md` 供复盘，不重试不阻断。

---

# 32. 高阶模型咨询

这是 TFL 与普通 ensemble 最大的产品差异之一。

原则：

> **高阶模型只在本地 search 已经把问题缩窄以后调用。**

---

## 32.1 Consultant 不从头读全部 repository

Consultation Packet：

```text
Original task

Relevant source locations

Trace A:
  hypothesis
  experiments
  failures
  patch summary
  tests

Trace B:
  ...

Trace C:
  ...

Cross-test matrix

Areas of agreement
Areas of conflict

Question:
What is the most likely explanation?
What evidence is still missing?
What single experiment would maximally distinguish the competing hypotheses?
What constraints should the final implementation preserve?
```

高阶模型 token 花在：

```text
disambiguation
```

而不是：

```text
重复 grep 整个 repo
```

---

## 32.2 Consultant 默认不改代码

建议 headless consultant tool allowlist（P1 修订：pi 无 grep/find/ls 独立工具）：

```text
--tools read,bash
+ prompt 纪律（只跑非变更命令）
```

cwd 指向：

```text
WT-S
```

即同一个 Base Snapshot 的 fresh read-only environment。

---

## 32.3 Consultant 输出

```json
{
  "preferredHypothesis": "...",
  "reasoning": "...",
  "missingEvidence": ["..."],
  "recommendedExperiment": {
    "goal": "...",
    "steps": ["..."],
    "expectedDiscriminator": "..."
  },
  "finalConstraints": ["..."],
  "confidence": "..."
}
```

JSON 容错（修订）：consultant 输出解析失败时不重试——原文全文进 Finalizer Packet（`consultant-raw.md`），conflict 判断回落到 executable evidence；consult 次数仍计 1。

---

# 33. Targeted Probe

如果 consultant / Fusion 仍认为缺证据：

```text
Round 2
```

最多启动：

```text
1–2 个 targeted probes
```

而不是再来三个完整 trajectory。

---

## 33.1 Probe worktree

默认：

```text
P1 = Base Snapshot
P2 = Base Snapshot
```

必要时 Fusion 可以指定：

```text
P1 = Base + candidate B
```

用于检验一个具体假设。

---

## 33.2 Probe 不是新 workflow

Probe 可以是：

```text
headless general/trace-probe
```

直接：

- edit；
- test；
- instrument；

但不允许继续 spawn subagents。

其任务必须窄：

```text
只回答一个判别问题
```

例如：

```text
在 scheduler 不变时禁用 cache reuse。
如果 bug 消失 → 支持 hypothesis B；
若仍存在 → 反对 B。
```

---

# 34. Loop 上限

固定：

```text
Round 1:
  3 full traces

Fusion

Optional:
  1 consultant

Round 2:
  max 2 targeted probes

Re-fusion

Stop
```

配置：

```text
maxRounds = 2
maxConsultations = 1
maxTargetedProbes = 2
```

绝不无限：

```text
uncertain → 3 more → uncertain → 3 more...
```

---

# 35. Finalization 的两条路径

## 35.1 Candidate Promotion

如果某个 candidate：

```text
✓ patch 完整
✓ pooled tests 全过
✓ root cause 与 evidence 一致
✓ 没有关键风险
```

则：

```text
promote candidate patch
```

不必浪费一次模型重新实现。

---

## 35.2 Fresh Synthesis

以下情况必须 fresh synthesis：

- A 的诊断最好，但 patch 不完整；
- B 的实现最好，但 C 找到其遗漏 edge case；
- candidate 之间要组合；
- consultant 给出新的实现约束；
- candidate 都不是完整最优解。

Finalizer：

```text
WT-S = same original Base Snapshot
```

输入：

```text
Fusion State
Consultant Advice (if any)
Relevant trajectory summaries
Selected diffs/snippets
Pooled tests
Original task
```

然后：

```text
fresh implement
→ test
→ final patch
```

---

# 36. 为什么 Finalizer 不直接继承某条 worktree

否则：

```text
“融合”
```

会悄悄退化成：

```text
“让胜出的 Agent 继续改”
```

Fresh WT-S 可以减少：

- accidental artifacts；
- temporary instrumentation；
- dead-end code；
- hidden assumptions；
- lane-specific contamination。

---

# 37. Finalizer Tool Policy

Finalizer 是完整 coding agent（P1 修订：pi 内置工具即 read/bash/edit/write，bash 覆盖 powershell/build/test）：

```text
read
bash
edit
write
```

注意：finalizer 以 headless `runSingle` 跑完整实现任务，默认 10min stall timeout 不够——TFL 调用时显式传宽松 `stallTimeoutMs`（默认 30min，可配）。

但禁止：

```text
subagent-win
launch-tabs
workflow
lite
```

因为 Fusion 已完成。

---

# 38. 最终 apply 回用户主工作树

必须非常保守。

TFL 启动时记录：

```text
mainTreeFingerprintAtStart
```

包括：

```text
HEAD
git status
tracked content digest / diff hash
```

Final 完成时再次检查。

---

## 38.1 主工作树没有变化

可以：

```text
git apply --3way final.patch
```

或由主 Agent正常应用。

仍建议默认：

```text
生成 final.patch
+ 请求主会话应用
```

而不是 extension 静默修改。

---

## 38.2 主工作树期间发生变化

禁止自动 apply。

返回：

```text
FINAL_READY_BUT_MAIN_CHANGED
```

给用户：

```text
final.patch
base commit
conflict risk
```

避免覆盖同时进行的人工或 Agent 工作。

---

# 39. Worktree 不是完整 sandbox

必须明确：

Git worktree 隔离：

- tracked files；
- index；
- HEAD；
- branch/worktree state。

但不隔离：

- 数据库；
- Docker；
- 网络服务；
- 用户 Home；
- global npm/pip cache；
- registry；
- OS process；
- external API；
- shared temp path；
- credentials。

因此 Trace worker prompt 必须禁止：

```text
production deploy
destructive database migration
external destructive API
global environment mutation
```

除非 task 明确允许。

---

# 40. Windows 专项

## 40.1 短路径

```text
~/.pi/tfl-wt/<short>/a
```

junction 依赖供给（§16.1）也落在该层：`mklink /J <wt>/node_modules <main>/node_modules`，无需管理员，路径短。

---

## 40.2 Process tree cleanup

Windows 下只 `child.kill()` 不总能杀掉孙进程。

需要考虑：

```text
taskkill /PID <pid> /T /F
```

作为 fallback。

---

## 40.3 Worktree removal retry

流程：

```text
stop PI tab child
↓
kill leaked build/test processes when attributable
↓
git worktree remove --force
↓
retry exponential backoff
↓
failure → mark stale
↓
next startup /trace-fusion-clean
```

cleanup failure 不应把一个成功的 coding run 标记失败。

---

# 41. Artifact Layout

```text
~/.pi/agent/trace-fusion-runs/<runId>/
├── meta.json
├── base/
│   ├── snapshot.json
│   ├── status.txt
│   └── base-commit.txt
│
├── lanes/
│   ├── A/
│   │   ├── trajectory.md
│   │   ├── patch.diff
│   │   ├── validation.json
│   │   └── result.json
│   ├── B/
│   └── C/
│
├── evaluation/
│   ├── pooled-tests.diff
│   ├── cross-test-matrix.json
│   ├── candidate-evidence.json
│   └── fusion-packet.md
│
├── consultant/
│   └── consultation.json
│
├── probes/
│   ├── p1/
│   └── p2/
│
├── final/
│   ├── final-report.md
│   ├── final.patch
│   ├── validation.json
│   └── decision.json
│
└── logs/
```

---

# 42. `meta.json`

```json
{
  "version": 1,
  "runId": "tfl_...",
  "status": "running",
  "task": "...",

  "repoRoot": "...",
  "originalHead": "...",
  "baseSnapshotCommit": "...",

  "startedAt": "...",

  "workers": 3,
  "workerModel": "...",
  "consultMode": "auto",
  "consultModel": "...",

  "lanes": {
    "A": {"tabRunId": "...", "cwd": "..."},
    "B": {"tabRunId": "...", "cwd": "..."},
    "C": {"tabRunId": "...", "cwd": "..."}
  },

  "round": 1,
  "maxRounds": 2
}
```

---

# 43. 状态机

```text
IDLE
 ↓
PREFLIGHT
 ↓
SNAPSHOT
 ↓
CREATE_WORKTREES
 ↓
LAUNCH_TRACE_A_B_C
 ↓
WAIT_TRACE_RESULTS
 ↓
COLLECT_ARTIFACTS
 ↓
CROSS_VALIDATE
 ↓
FUSION_EVALUATE
 ├─────────────────────────┐
 │ confidence HIGH         │
 │                         │
 │                    MEDIUM / LOW
 │                         │
 │                         ▼
 │                      CONSULT
 │                         │
 │                evidence sufficient?
 │                    ┌────┴────┐
 │                   yes        no
 │                    │          │
 │                    │      TARGETED_PROBE
 │                    │          │
 │                    │      RE_EVALUATE
 │                    │          │
 └────────────────────┴──────────┘
                 │
                 ▼
            FINAL_DECISION
            /            \
       PROMOTE          SYNTHESIZE
          \              /
           \            /
            FINAL_TEST
                │
                ▼
            FINAL_PATCH
                │
                ▼
              DONE
                │
                ▼
             CLEANUP
```

---

# 44. 失败语义

## 3/3 trace 成功

正常 Fusion。

## 2/3 成功

允许 Fusion，但：

```text
run = degraded
```

且 confidence 上限默认不超过 MEDIUM，除非 executable evidence 极强。

## 1/3 成功

不做普通 Fusion。

直接：

```text
consult
```

或失败返回。

## 0/3

run failed。

---

# 45. Worker crash 不应污染其它 lane

A crash：

```text
B/C 继续
```

不取消整个 run。

只有：

- Base corruption；
- repo-level destructive failure；
- user abort；

才停止全部。

---

# 46. User Abort

`/trace-fusion-abort`：

1. 标记 run cancelling；
2. 终止 visible trace PI processes；
3. 终止 evaluator / consultant / probes；
4. 不自动删除 artifacts；
5. 尝试 remove worktrees；
6. cleanup 不成功 → stale；
7. run status=cancelled。

---

# 47. Model Policy

建议 config：

```json
{
  "traceFusionLoop": {
    "workerModel": "local/ornith",
    "fusionModel": "local/ornith",
    "consultMode": "auto",
    "consultModel": "openai/...",
    "finalizerModel": "local/ornith",
    "maxRounds": 2,
    "maxConsultations": 1,
    "maxTargetedProbes": 2,

    "maxWallClockPerLaneMin": 45,
    "finalizerStallTimeoutMin": 30,
    "maxActiveRuns": 1,

    "provisioning": {
      "junction": ["node_modules"],
      "copy": [".env"],
      "command": ""
    }
  }
}
```

---

## 47.1 三个 worker 默认同模型

第一阶段最好：

```text
Ornith
Ornith
Ornith
```

这样测的是：

```text
independent trajectory scaling
```

而不是 heterogeneous ensemble。

---

## 47.2 Consultant 才升级模型

这正是产品价值：

```text
cheap/local broad search
→ evidence fusion
→ only uncertainty escalates
→ expensive strong model
```

---

# 48. Fallback Policy

普通 subagent fallback 可以继续。

但 Trace metadata 必须记录：

```text
requestedModel
actualModel
fallbackChain
```

如果 A/B/C 实际用了不同模型：

```text
homogeneous=false
```

Fusion 仍可继续，但 benchmark 时必须区分。

---

# 49. 高阶模型不是“第四票”

Consultant 不能：

```text
看 A/B/C
→ 选一个
```

它的主要任务：

```text
解释冲突
寻找 missing evidence
设计 discriminating experiment
审查 hidden assumption
```

最终 selection 仍回到：

```text
executable evidence
```

---

# 50. Main UI

用户调用后主界面：

```text
Trace Fusion Loop · tfl_ab12
Base: 9f83...
Workers: 3

A  ● running  WT-A
B  ● running  WT-B
C  ● running  WT-C

Fusion      waiting
Consultant  standby
Round       1 / 2
```

---

三个 tab 标题：

```text
[TRACE A] repo-fix-cache
[TRACE B] repo-fix-cache
[TRACE C] repo-fix-cache
```

---

# 51. Fusion UI

全部回来：

```text
Trace Fusion Loop · Fusion

A ✓ candidate patch
B ✓ candidate patch
C ✓ failed patch / useful evidence

Cross-test:
A  8/10
B 10/10
C  5/10

Confidence: MEDIUM
Consultant: requesting...
```

最终：

```text
Trace Fusion Loop ✓

Decision: fresh synthesis
Source evidence: A+B+C
Consultant: used
Targeted probes: 1
Final validation: PASS

Patch:
~/.pi/agent/trace-fusion-runs/.../final/final.patch
```

---

# 52. 代码模块结构

建议：

```text
extensions/
├── index.ts
│
├── identity.ts
├── capabilities.ts                 # 新
│
├── subagent-core/                  # 从 index 抽
│   ├── types.ts
│   ├── runner.ts
│   ├── parallel.ts
│   ├── model-resolution.ts
│   ├── usage.ts
│   └── prompt.ts
│
├── tab-launch-core.ts              # 新：纯 tab spawn primitive
│
├── trace-fusion/
│   ├── index.ts
│   ├── commands.ts
│   ├── types.ts
│   ├── config.ts
│   ├── preflight.ts
│   ├── snapshot.ts
│   ├── worktrees.ts
│   ├── launch-workers.ts
│   ├── worker-prompt.ts
│   ├── artifacts.ts
│   ├── collect.ts
│   ├── cross-test.ts
│   ├── fusion.ts
│   ├── consultant.ts
│   ├── probes.ts
│   ├── finalizer.ts
│   ├── apply.ts
│   ├── cleanup.ts
│   └── renderer.ts
│
├── launch.ts                       # 继续服务 workflow
├── lite-mode.ts
└── ...
```

---

# 53. 依赖方向

必须：

```text
                  subagent-core
                  ↑     ↑
                  │     │
         existing workflow   trace-fusion
                  │
                  │
             tab-launch-core
```

不要：

```text
trace-fusion
→ launch-tabs workflow builder
→ workflow skill
```

---

# 54. `capabilities.ts`

示例：

```ts
interface SessionCapabilities {
    workflow: boolean;
    lite: boolean;
    launchTabs: boolean;
    delegateAgents: "*" | string[];
    timerOrchestration: boolean;
    directExecution: boolean;
}

const CAPS = {
    main: {
        workflow: true,
        lite: true,
        launchTabs: true,
        delegateAgents: "*",
        timerOrchestration: true,
        directExecution: true,
    },

    "workflow-tab": {
        workflow: true,
        lite: false,
        launchTabs: false,
        delegateAgents: [
            "searcher",
            "planner",
            "plan-reviewer",
            "implementer",
            "code-reviewer",
            "consultant",
        ],
        timerOrchestration: false,
        directExecution: false,
    },

    "trace-worker": {
        workflow: false,
        lite: false,
        launchTabs: false,
        delegateAgents: ["searcher"],
        timerOrchestration: false,
        directExecution: true,
    },

    subagent: {
        workflow: false,
        lite: false,
        launchTabs: false,
        delegateAgents: [],
        timerOrchestration: false,
        directExecution: true,
    },
};
```

---

# 55. Runtime Guard

`subagent-win.execute()`：

```ts
const caps = currentCapabilities();

if (isTraceWorker()) {
    const requested = collectRequestedAgentNames(params);

    if (
        requested.length === 0 ||
        requested.some(name => name !== "searcher")
    ) {
        return error(
          "Trace workers may only delegate to agent=searcher."
        );
    }
}
```

**必须禁止 agent omitted。**

---

# 56. `resources_discover`

```ts
pi.on("resources_discover", async () => {
    if (isTraceWorker()) {
        return { skillPaths: [] };
    }

    return {
        skillPaths: [join(PKG_DIR, "skills")]
    };
});
```

---

# 57. `before_agent_start`

```ts
pi.on("before_agent_start", async (...) => {
    if (isTraceWorker()) {
        return {
            message: {
                customType: "trace-worker-profile",
                content: buildTraceWorkerSystemPrompt(),
                display: false,
            }
        };
    }

    // 原现有逻辑
});
```

---

# 58. `/lite` guard

```ts
handler: async (...) => {
    if (!capabilities().lite) {
        notify("Trace worker does not support Lite workflow");
        return;
    }

    ...
}
```

---

# 59. `/launch` guard

同理：

```ts
if (!capabilities().launchTabs) {
    reject;
}
```

不要只依赖 extension factory 阶段是否注册。

---

# 60. Worktree API

建议：

```ts
interface TraceBaseSnapshot {
    repoRoot: string;
    originalHead: string;
    baseCommit: string;
    dirty: boolean;
    status: string;
}

createTraceBaseSnapshot(repoRoot): TraceBaseSnapshot

createTraceWorktree(
  repoRoot,
  baseCommit,
  path
): void

removeTraceWorktree(...): CleanupResult
```

---

# 61. Fusion Packet

传给 Fusion Evaluator：

```markdown
# Original Task

...

# Base

commit: ...
dirty snapshot: yes/no

# Candidate A

## Diagnosis
## Patch summary
## Tests
## Failures
## Open risks

# Candidate B
...

# Candidate C
...

# Cross Validation

| candidate | build | repro | A-tests | B-tests | C-tests | regression |
...

# Hard Facts

...

# Conflicts

...

# Instruction

Do not vote by majority.
Executable evidence dominates self-reported confidence.
Determine the best currently available solution.
If evidence is insufficient, identify the smallest high-information experiment
or consultant question required to resolve the uncertainty.
```

---

# 62. Finalizer Packet

如果 fresh synthesis：

```text
Prior states / evidence FIRST

Original task

Relevant original files / locations

Final constraints

Pooled tests
```

这里可以借鉴 Trace as State 的“状态先于 fresh solve”，但不要声称这是论文原始 SWE 方法。

---

# 63. Telemetry

TFL 应记录：

```text
wallClock
worker A/B/C duration
worker model
actual fallback model
input/output tokens
cache read/write
consultant usage
probe usage
finalizer usage
```

以及：

```text
candidate selected?
fresh synthesis?
consult triggered?
number probes?
cross-test discriminated?
```

---

# 64. 成功率评估

以后做 A/B：

```text
Single Ornith
vs
TFL Ornith×3
vs
TFL Ornith×3 + consult
```

指标：

```text
task success
tests pass
first-run success
user rework count
wall clock
GPU/token cost
consult trigger rate
```

不要只看 tok/s。

---

# 65. TFL 是否值得的关键统计

尤其关注：

```text
Oracle@3:
三条中是否至少一条本来就有正确解？

Fusion@1:
系统能不能找出/融合正确解？

Consult uplift:
consult 后解决率提高多少？

Cross-test value:
有多少错误 candidate 是被其它 trajectory 的 test 击穿的？

Fresh synthesis value:
最终解有多少不是单一 candidate，而是多个 trajectory 信息融合得到的？
```

这些指标非常适合判断系统是否真的工作。

---

# 66. 测试计划

## Phase 0：现有 baseline

先跑当前全部：

```text
test:identity
test:launch
test:lite-mode
test:tab-runs
test:tab-runs-runtime
test:event-bus
test:report
smoke:extension-load
```

锁 baseline。

---

## Phase 1：Session Profile

新增：

```text
_test_session_profile.ts
```

覆盖：

```text
flag > env
trace-worker
workflow-tab
subagent inheritance clearing
```

---

## Phase 2：Capability Guard

测试：

```text
trace-worker → searcher ✓
trace-worker → planner ✗
trace-worker → implementer ✗
trace-worker → consultant ✗
trace-worker → agent omitted ✗
trace-worker → launch-tabs ✗
trace-worker → /lite ✗
```

---

## Phase 3：Runner tool policy

这是现有插件必须补的测试：

```text
searcher tools frontmatter
→ child argv 包含 --tools
```

以及：

```text
trace searcher override
→ read,grep,find,ls only
```

---

## Phase 4：Synthetic Snapshot

准备 repo：

```text
HEAD file
staged edit
unstaged edit
untracked file
```

创建 snapshot 后：

```text
WT-A
WT-B
WT-C
```

必须看到相同文件内容。

用户真实：

```text
branch
index
status
```

必须不变。

---

## Phase 5：Isolation

A 修改：

```text
foo.ts
```

B/C 不得看到。

---

## Phase 6：Trace launch

断言：

```text
prompt 不包含 workflowDisciplineBlock
skill args 不包含 workflow-orchestrator
session-profile=trace-worker
trace lane 正确
cwd 正确
```

---

## Phase 7：Artifact

模拟三条结果：

```text
A pass
B partial
C fail with useful test
```

Collector 必须完整解析。

---

## Phase 8：Cross Test

候选矩阵应 deterministic。

---

## Phase 9：Consult gating

HIGH：

```text
不得调用 consultant
```

MEDIUM/LOW：

```text
consult once
```

---

## Phase 10：Targeted Probe

最多 2 个。

---

## Phase 11：Finalizer

测试：

```text
promote path
synthesis path
```

---

## Phase 12：Main tree changed

TFL 期间改变主工作树。

Final：

```text
不得自动 apply
```

---

## Phase 13：Windows cleanup

模拟：

```text
file lock
worktree removal fail
```

run 本身仍可 `completed_with_cleanup_warning`。

## Phase 14：Provisioning（P3）

```text
junction 建立成功 → worktree 内 tsc/build 可跑
copy .env 生效
写缓存的构建 → 切 copy 后三路无互踩
provisioning 失败 → lane degraded 而非 run failed
```

## Phase 15：Supervisor 权威 artifact（P4）

```text
worker commit 后 → 三段式 diff 仍完整
worker 未写 trajectory.md → supervisor artifact 不受影响
worker 幻觉 validation 结果 → 以 supervisor 复跑为准
```

## Phase 16：重启恢复（P5）

```text
主会话重启 → /trace-fusion-status 从磁盘重建视图
三路终态无 final/ → /trace-fusion-resume 续跑 deterministic 部分零损失
并发第二run → 拒绝（maxActiveRuns=1）
```

## Phase 17：Lane 时限（P6）

```text
lane 超 maxWallClockPerLane → 判 failed、其余继续、run 降级 2/3
部分修改仍被三段式收集
```

---

# 67. 分阶段实现顺序

## Commit 1

```text
refactor: extract session capability helpers
```

只重构身份，不改变功能。

---

## Commit 2

```text
feat: add per-call tools allowlist to subagent runner (opt-in only)
```

P2 修订：只加 per-call `tools` 参数，**不激活 agent frontmatter 作为硬约束**——未传参时 argv 完全不变，现有 workflow 零回归。frontmatter → 硬 allowlist 的全局切换另行评估。

---

## Commit 3

```text
refactor: extract tab launch primitive from workflow launcher
```

现有 `/launch` 行为保持。

---

## Commit 4

```text
feat: add trace-worker session profile and hard capability guards
```

此时还没有 TFL。

---

## Commit 5

```text
feat: add synthetic repo snapshot and worktree manager
```

---

## Commit 6

```text
feat: add /trace-fusion-loop three-tab dispatch
```

做到：

```text
3 worktrees + 3 visible tabs
```

先人工看结果。

---

## Commit 7

```text
feat: persist trace trajectory artifacts
```

---

## Commit 8

```text
feat: add cross-trajectory validation
```

---

## Commit 9

```text
feat: add fusion evaluator
```

---

## Commit 10

```text
feat: add confidence-gated high-tier consultation
```

---

## Commit 11

```text
feat: add targeted probe round
```

---

## Commit 12

```text
feat: add final candidate promotion and fresh synthesis
```

---

## Commit 13

```text
feat: trace-fusion status, abort, cleanup, telemetry
```

---

## 67.1 里程碑切分（修订：一次性交付 30+ 验收项 = 不可验证）

| 里程碑 | Commits | 内容 | 性质 |
|---|---|---|---|
| **v0.3** | C1–C8 | capability 体系 + snapshot + provisioning + worktrees + 3 tabs + artifacts + deterministic cross-test 矩阵报告 | **零模型判断**，全部人工可核对；独立可用（best-of-3 + 交叉测试报告，人定夺）；Oracle@3 从第一天可采集 |
| **v0.4** | C9–C12 | fusion evaluator + consult gating + probes + finalizer | 模型判断进入，每步靠 v0.3 真实数据校准 |
| **v0.5** | C13 | status/abort/clean/resume/telemetry 完善 | — |

v0.3 交付时 `/trace-fusion-loop` 终态 = 「交叉验证矩阵 + 三份 trajectory + 三份 patch，等待人工裁决」，已是一个能用的产品。

---

# 68. 验收标准（修订：按里程碑分期验收，不再一次性交付）

## v0.3（C1–C8，deterministic 层）

- [ ] `/trace-fusion-loop` 只允许 main session 启动；
- [ ] 无参数时拒绝启动并显示用法；
- [ ] 并发第二个 run 被拒绝（maxActiveRuns=1）；
- [ ] 启动时不进入 Lite；
- [ ] 不经过 workflow prompt builder；
- [ ] 不加载 workflow-orchestrator skill；
- [ ] 生成 3 个 visible tabs；
- [ ] 3 个 worktree 来自同一个 Base Snapshot；
- [ ] Base Snapshot 包含用户 staged/unstaged/untracked 非忽略内容；
- [ ] 不修改用户 branch/index；
- [ ] **provisioning 生效：junction node_modules 后 worktree 内可 build/test**；
- [ ] Trace A/B/C 互相看不到修改；
- [ ] Trace worker 可直接 edit/test；
- [ ] Trace worker 不能 launch-tabs / `/launch` / `/lite`；
- [ ] Trace worker 的 `subagent-win` 只允许 searcher；agent omitted 被禁止；
- [ ] searcher child 不能递归 subagent，tools 被硬限制（read,bash）；
- [ ] 三条 trajectory 都产生标准 artifact（**硬证据为 supervisor 三段式自算**）；
- [ ] patch relative to base 可复现（含 worker 已 commit 情形）；
- [ ] cross-test 矩阵 deterministic，判别性测试 fail 重跑一次防抖；
- [ ] lane 超 maxWallClockPerLane 判 failed、其余继续；
- [ ] 主会话重启后 `/trace-fusion-status` 从磁盘重建视图；
- [ ] 原有 Lite / Full / launch-tabs 行为不回归（**含 per-call tools 未传时 argv 不变**）。

## v0.4（C9–C12，模型判断层）

- [ ] Fusion 先做 executable evidence；
- [ ] candidate selection 不使用 majority vote；
- [ ] fusion evaluator JSON 解析失败降级为 consult/medium，不阻断；
- [ ] HIGH confidence 不调用高阶模型；MEDIUM/LOW 才咨询；
- [ ] consultant 最多一次；输出解析失败时原文进 finalizer packet；
- [ ] targeted probe 最多两个；总 rounds ≤2；
- [ ] 可以 promote 已充分验证 candidate；否则 WT-S fresh synthesis；
- [ ] 最终 patch 通过最终验证；
- [ ] 主 tree 变化时不自动 apply。

## v0.5（C13，运维层）

- [ ] Abort 可停止全部运行；
- [ ] cleanup 失败只产生 warning；
- [ ] `/trace-fusion-resume` 可从磁盘续跑；
- [ ] telemetry 完整（含 Oracle@3 / Fusion@1 / consult uplift）。

---

# 69. 以后再与 Lite / Full 集成

只有 TFL 独立验证稳定以后，才考虑：

```text
Lite
  └── high-uncertainty node → TFL primitive

Full
  └── plan/root-cause conflict → TFL

Adaptive C
  └── TFL optional
```

但不要让：

```text
每个 workflow stage
×
3 traces
```

造成指数膨胀。

未来正确抽象应是：

```text
Workflow decides WHEN to call
Trace Fusion decides HOW to search uncertainty
```

---

# 70. 最终推荐架构

```text
                              PI Main
                                │
                     /trace-fusion-loop
                                │
                       Trace Supervisor
                                │
                    synthetic Base Snapshot
                                │
                ┌───────────────┼───────────────┐
                │               │               │
                ▼               ▼               ▼
           TRACE A TAB      TRACE B TAB      TRACE C TAB
              WT-A             WT-B             WT-C
                │               │               │
          direct coding    direct coding    direct coding
                │               │               │
          optional only    optional only    optional only
            searcher         searcher         searcher
                │               │               │
                ▼               ▼               ▼
             evidence         evidence         evidence
                └───────────────┼───────────────┘
                                ▼
                      Deterministic Collector
                                │
                           Cross Tests
                                │
                                ▼
                         Fusion Evaluator
                                │
                       confidence gate
                         /            \
                       HIGH         MED/LOW
                        │              │
                        │        High Model Consult
                        │              │
                        │        Targeted Probe(s)
                        │              │
                        └───────┬──────┘
                                ▼
                         Final Decision
                         /             \
                   Promote           WT-S Fresh
                   Candidate         Synthesis
                         \             /
                          \           /
                           Final Tests
                                │
                            final.patch
                                │
                           Main Session
```

---

# 71. 设计的核心原则

可以把整个方案浓缩成 8 条：

1. **三个 trajectory 真正独立，而不是三个角色开会。**
2. **三个 trajectory 可以真实改代码和跑测试，因为每个拥有独立 worktree。**
3. **失败 trajectory 不是废物；失败实验和新测试可能比失败 patch 更有价值。**
4. **Fusion 以可执行证据为主，不以 majority vote 和 self-confidence 为主。**
5. **高阶模型是 uncertainty consultant，不是默认第四个全能 Agent。**
6. **第二轮只做 targeted information gain，不再暴力展开三个完整 rollout。**
7. **Trace worker 自己就是完整 coding rollout；禁止 workflow，最多只允许窄 searcher。**
8. **第一版完全独立于 Lite / Full，先把方法本身测清楚。**

---

# 72. References

### PI

- Pi Design Principles / Usage  
  https://pi.dev/docs/latest/usage

- Pi SDK  
  https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md

- Pi official subagent extension example  
  https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent

### Test-time scaling / SWE

- Kim et al. (2026), **Scaling Test-Time Compute for Agentic Coding**  
  https://arxiv.org/abs/2604.16529

- Mao et al. (2026), **EGSS: Entropy-guided Stepwise Scaling for Reliable Software Engineering**  
  https://arxiv.org/abs/2602.05242  
  https://aclanthology.org/2026.acl-long.1359/

- CodeFuse-Agent, **Trajectory-Aware Test-Time Scaling**  
  https://github.com/codefuse-ai/CodeFuse-Agent/blob/main/tech_report.md

- Geng & Neubig (2026), **Effective Strategies for Asynchronous Software Engineering Agents**  
  https://arxiv.org/abs/2603.21489

- Antoniades et al., **SWE-Search: Enhancing Software Agents with Monte Carlo Tree Search and Iterative Refinement**  
  https://arxiv.org/abs/2410.20285

### Experience / memory

- Shinn et al., **Reflexion: Language Agents with Verbal Reinforcement Learning**  
  https://arxiv.org/abs/2303.11366

- Ouyang et al., **ReasoningBank: Scaling Agent Self-Evolving with Reasoning Memory**  
  https://arxiv.org/abs/2509.25140

### Trace state

- Zou & Tang (2026), **Trace as State: Reasoning Traces as Conditional States for Long-Context Transformers**  
  https://arxiv.org/abs/2609.02702

---

# 73. 一句话产品定义

> **`/trace-fusion-loop` 是一个独立的 SWE test-time scaling 命令：它从同一仓库快照启动三个隔离 worktree 中的完整 coding rollout，让它们分别真实试错；随后以跨轨迹测试和执行证据融合最优解，只在证据不足时咨询更强模型并做少量定向实验，最后生成经过统一验证的最终 patch。**

---

# 74. 附记 A1（2026-09-17，真实运行驱动）：diagnose 成为默认模式

## 74.1 触发

首次 implement 真实 run（tfl-20260915-222111-484b，GreenCAD）实测：

- worktree 占用 **12GB**（源树 ×3 + bin/obj ×3，`~/.pi/tfl-wt/<shortId>/{a,b,c}`）；
  外加更早僵尸 run 残留 1.1GB
- 三路 45 分钟各自完成实现，但分化主要在「改动幅度」（保守/广谱/折中），
  **根因诊断三路完全一致**——这一信息在方案层即可合成，无需 3×实现+构建

## 74.2 决策

引入 run 模式 `mode: diagnose | implement`（config `traceFusionLoop.mode`，默认 **diagnose**）：

| | diagnose（默认） | implement（opt-in 昂贵档） |
|---|---|---|
| lane 工作区 | 主仓库只读 | 独立 worktree 读写 |
| 磁盘代价 | ~0 | 12GB/轮级（随仓库） |
| 产物 | 诊断+推进方案（trajectory 八节 + 只读证据主张） | patch + trajectory + 可执行验证 |
| 交叉验证 | 不在用户仓库执行命令（无隔离）；dirty-baseline 违规检查 | cross-test 矩阵（eval 树复跑） |
| 后续 | 主会话融合三份方案 → 单次实现 | promote / fresh synthesis（v0.4） |

diagnose 的工具隔离：dispatch 时 excludeTools 追加 `edit`/`write`；bash 保留（只读探查
用），纪律入 prompt，违规由 **dirty-baseline 确定性检查**兜底（启动 porcelain 基线 vs
collect 时对比；gitignore 内写入为已记录的残余风险）。不建 synthetic snapshot、不触碰
用户 HEAD、不做 trust 预授权。

implement 管线（C5–C8）原样保留：需要真实执行证据的任务（高风险重构等）显式开启。

## 74.3 配套

- `/trace-fusion-clean <runId> [--force]`（v0.5 §13 提前落地）：移除 lane worktrees +
  prune，**runDir artifact 永不删**（patch 可随时重放复验）；running run 需 --force
- supervisor 自动收集对 diagnose 天然生效（finishDiagnoseRun 落盘 skip 型
  cross-test.json，幂等检查直接命中）
- 与 §15 的关系：worktree 短路径布局仅 implement 模式使用；§68 分期不变，
  v0.4 fusion 的输入从「三份 patch」变为「三份方案」（diagnose）或保持 patch（implement）
