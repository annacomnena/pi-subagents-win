---
title: 工具调用可观测与循环判定
kind: architecture
status: current
updated: 2026-10-26
source_paths:
  - extensions/recent-calls.ts
  - node_modules/@earendil-works/pi-agent-core/dist/types.d.ts
  - node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/types.d.ts
  - extensions/runtime/streaming-snapshot.ts#L194-L203
  - extensions/index.ts#L356
  - extensions/index.ts#L911
  - extensions/index.ts#L1894
  - extensions/index.ts#L1253
  - extensions/index.ts#L1424-L1426
  - extensions/index.ts#L1478
  - extensions/index.ts#L1490
  - extensions/index.ts#L2304-L2307
  - extensions/index.ts#L3784-L3788
  - extensions/index.ts#L4181-L4300
  - extensions/index.ts#L4240
  - extensions/index.ts#L4246-L4248
  - extensions/index.ts#L4335
  - extensions/index.ts#L4437
  - extensions/index.ts#L4347
  - extensions/index.ts#L4448
  - extensions/runner-argv.ts#L64-L70
  - extensions/subagent-kill.ts#L130-L132
  - extensions/subagent-kill.ts#L295-L310
  - extensions/subagent-kill.ts#L327
  - extensions/subagent-kill.ts#L346
  - extensions/tab-runs.ts#L122-L136
  - extensions/tab-runs.ts#L531
  - extensions/launch.ts#L237
  - extensions/_test_recent_calls.ts
  - extensions/fixtures/recent-calls-distinct.jsonl
  - extensions/fixtures/recent-calls-repeat.jsonl
  - extensions/fixtures/recent-calls-noprogress.jsonl
  - extensions/fixtures/recent-calls-tab-noprogress.jsonl
---

# 工具调用可观测与循环判定

## Summary

`subagent-win({ action: "recent-calls" })` 给主会话一个**只读探针**，回答「某个 run / task tab 最近调了哪些工具、是否在原地打转」。它把两类目标（async subagent 的 run json、task tab 的会话 JSONL）统一归一到「最近 n 次工具调用 + verdict（`ok|repeating|no_progress`）」的**有界纯文本**输出。查询本身**不改变 spawn 协议、不阻塞派发**；为支持运行中观测，派发侧会**节流增量写回 run json**（≤1 次/5s，见 §1，「async 环形明细」），但 `recent-calls` 查询路径只读不写。可选的 `loopGuard` 自动处置默认关闭，仅命中且 `action:"kill"` 时复用既有 `killAsyncRun`。

设计边界（两条硬约束）：
- 任何成功/错误返回 **≤ `RECENT_CALLS_TOTAL_BYTES` = 1536 字节**（UTF-8）。
- **绝不静默空**：取数失败一律返回带 reason 的 error（`isError:true`）；唯一非 error 的降级是 `no-detail`（无工具明细但有记录）。

## Current Contract

### 1. 两条取数路径

| | task tab | async subagent |
|---|---|---|
| 触发键 | `tabRunId`（参数优先级最高；`runId` 以 `tab_` 开头也识别为 tab，`index.ts#L4183-L4185`） | `runId`（省略则取本会话唯一 run） |
| 数据源 | 会话 JSONL（`~/.pi/agent/sessions/**/<bucket>/*.jsonl`） | `<runId>.json` 的字段 `recentCalls`（`AsyncRunRecord.recentCalls?`，`index.ts#L2304`） |
| 读取方式 | **有界尾读** + 定位 | `listAsyncRuns()` 读 `<runId>.json`，取 `target.recentCalls ?? target.result?.recentCalls`（运行中增量写 / 终态快照，`index.ts#L4240`） |
| toolResult 回填 | ✅ 从 toolResult 行回填 `resultPreview` / `durationMs` | ⚠️ 仅视事件可得性；缺失显示 `(unavailable)` / `-` |

- **定位（tab）** `locateTabSession(dispatch, sessionsRoot)`（`recent-calls.ts#L433`）：在 `join(sessionsRoot, sessionBucketForCwd(dispatch.cwd))`（`tab-runs.ts#L122`）下枚举 `.jsonl`，先用 `mtime >= dispatchedAt - 60_000` 时间窗粗筛（`stat` 失败则保留候选），再 `readHeadBytes`（≤64KB）在该文件**首个 user 消息**首行匹配 `modePrefix(taskId, mode)`（`launch.ts#L237`），命中者按 header 时间戳倒序；**同分（`cands[0].ts === cands[1].ts`）→ ambiguous**。返回 `{path|null, ambiguous, candidates, reason?}`。
- **有界尾读（tab）** `readTailBytes(path, maxBytes=TAIL_READ_MAX_BYTES=262144)`（`recent-calls.ts#L325`）：`openSync`+`statSync`+`readSync` 从 `size - maxBytes` 起读；`start>0` 时**丢弃首个不完整行**（找第一个 `\n` 之后的全部），`StringDecoder("utf8")` 防多字节乱码；截断且无完整行 → `lines=[]`。`collectTabWindow`（`recent-calls.ts#L403`）用**同一次尾读**产出 `{entries, windowTurns}`：`entries` = `parseRecentCalls` 解析后 `tail(..., clampN(n))`；`windowTurns` = `countAssistantTurns`（`recent-calls.ts#L371`）数窗口内 `role==="assistant"` 消息行（与 `parseRecentCalls` 的 turn 计数同语义，扁平 `toolCall` 投影行不计）——这是 tab 路径 `turnClock` 的来源（2026-10-16 修复，见 §3）。
- **async 环形明细**：派发侧在 `runSingle` 内维护**内存环形 `ring`**（`RECENT_CALLS_CAP`/`RING_K` = 8；`recent-calls.ts#L35`/`#L49`，ring 在 `index.ts#L1253`），每次进度事件 `type:"tool"` → `pushRecentCall(ring, {tool, argsDigest, ts, turn}, RING_K)`（`index.ts#L1424`，超容量丢最旧，`recent-calls.ts#L171`）。**运行中即增量写回**：每次 tool 事件另经 `opts.onRecentCalls(ring.slice(-RING_K), turn)`（`index.ts#L1426` 调用；回调签名 `#L1894`）推给派发侧，派发侧用 `createThrottledRunMerger(runId, RUNS_DIR)`（`subagent-kill.ts#L346`）以 **≤1 次/5s**（`RECENT_CALLS_PERSIST_INTERVAL_MS=5_000`，`subagent-kill.ts#L132`；首调用立即写）合并写回 `<runId>.json` 的 `recentCalls`/`lastToolTurn`/`turnClock`（单发 `index.ts#L4437`+`#L4442-L4445` / 并行 `#L4335`+`#L4341-L4344`）。`mergeRunRecord` 同步读-改-写、只覆盖 patch 字段、`undefined` 跳过、记录不存在 no-op（`subagent-kill.ts#L327`），故不覆盖 `status/pid/killedAt/lastActivity`，与 `killAsyncRun` 不竞态。**终态快照仍在**：子进程 `close`/`error` 写 `result.recentCalls = ring.slice(-RING_K)`（`index.ts#L1478`/`#L1490`），完成回调再 `record.recentCalls = result.recentCalls` 落盘（单发 `#L4448` / 并行 `#L4347`）。
- **`--no-session`（关键设计约束）**：async 子进程 argv 恒含 `--no-session`（`runner-argv.ts#L70`，`buildPiArgv` 的固定旗标 `["--mode","json","--print","--no-session"]`）。因此 **async subagent 不产生会话 JSONL**，无法走 tab 的尾读路径；这正是改读 run json `recentCalls` 的原因。**为什么不改 `--no-session`**：它是派发隔离契约的一部分——子进程不落会话、不留可被注入的历史，改用持久会话会破坏每 run 隔离与并发安全。观测能力纯加法地落在「派发侧派生的环形明细」上，**不引入 spawn 协议变更**。
- 另一处 `touchRunActivity(runId)` 脉搏落盘受 `ACTIVITY_PERSIST_INTERVAL_MS = 5_000` 节流（`subagent-kill.ts#L130`/`L293-L310`）：内存实时更新、**落盘 ≥5s 间隔**。`recentCalls`/`lastToolTurn`/`turnClock` 是独立于脉搏的字段，由 `createThrottledRunMerger`（`RECENT_CALLS_PERSIST_INTERVAL_MS=5_000`，`subagent-kill.ts#L132`/`#L346`）在**运行中**增量写回（同样 ≤1 次/5s，首调用立即写），终态 `close` 再做一次完整快照。因此运行中的 async run 也有**有界明细（≤5s 滞后）**，不再只依赖完成时快照。

### 2.1 工具参数的两个粒度：**完整 args 可得，partial args 无载体**（2026-10-22 实测）

| 粒度 | 载体 | 本仓是否消费 | 位置 |
|---|---|---|---|
| **完整 arguments**（调用决定后立即全量） | pi-agent-core `tool_execution_start.args`（= `toolCall.arguments` 原值） | ✅ 是（`argsDigest` → `recentCalls`） | `pi-agent-core/dist/types.d.ts#L471-L476`；发出 `dist/agent-loop.js#L379-L383`（seq）/ `#L415-L419`（parallel）；消费 `index.ts#L1014-L1016` |
| 执行中部分结果 | `tool_execution_update`（`args` 完整 + `partialResult`） | ❌ 零处理（`grep -c tool_execution_update` = 0） | `types.d.ts#L477-L483` |
| **partial JSON 参数增量** | pi-ai `AssistantMessageEvent.toolcall_delta`（`delta: string`） | ❌ 零处理 | `pi-ai/dist/types.d.ts#L599-L604` |
| 参数流式到一半的「可解析前缀」 | `assistantMessageEvent.partial.content[i].arguments`（`parseStreamingJson` 渐进解析） | ❌ 零处理 | `pi-ai/dist/api/openai-completions.js#L440-L441` + `utils/json-parse.js#L90-L112` |

**关键结论（勿误读成「参数只在结束后可见」）**：`tool_execution_start` 已带**完整** `args`——GUI 若要「正在执行什么工具 + 它的参数」，
**现在就能做**（`recentCalls.argsDigest` 运行中 ≤5s 增量写回，实测落盘 median 252 B / max 511 B）。

**「partial args 流式」= 无载体**，四条依据：
1. 唯一带 partial 增量的事件是 `toolcall_delta`，它只出现在 `message_update` 里；
2. 本仓 `parseJsonEvents`（`index.ts#L1009-L1240`）只认 `tool_execution_start` 与 `message_end`，**无 `message_update` 分支** ⇒ 子进程 stdout 上的 `toolcall_delta` 被静默丢弃；
3. `state/streaming/<sid>.json` 写端**显式拒绝** `toolcall_delta`（`runtime/streaming-snapshot.ts#L202`，单测 `_test_streaming_snapshot.ts#L59` 把该拒绝钉成契约）；且该载体 `kind` 是单值 `"reasoning" | "text"`（`#L46-L57`），容纳不了「按 toolCallId 分槽的并行调用」；
4. `tool_execution_update` 全仓零消费。

**且 `/v1/streaming/:sid` 对 async run 恒不可用**：该端点 `sid` 是 pi sessionId，而 async 子进程 argv 恒带 `--no-session`
（`runner-argv.ts#L70`）⇒ `SessionManager.inMemory`（`pi-coding-agent/dist/main.js#L286-L288`）⇒ 子进程无会话文件、其
`resolveSessionId` 拿到的是 in-memory UUID（`session-manager.js#L695`），**外部无任何可寻址性**。


字段（`RecentCallEntry`，`recent-calls.ts#L54-L62`）：`tool` / `argsDigest`（规范化参数摘要）/ `ts`（ISO8601）/ `turn`（1-based）/ `resultPreview?` / `durationMs?`。

**async 路径实测只有 4 个字段**（分母 1090 条盘上 ring 元素）：`tool 1090 / argsDigest 1090 / ts 1090 / turn 1090`，`resultPreview **0** / durationMs **0**` ⇒ async **没有工具结果预览**，`dur=` 是接线层用相邻 `ts` 差补算的（`collectAsyncCalls`，`recent-calls.ts#L420-L434`），末条恒 `-`。tab 路径才有 `resultPreview`（从 toolResult 行回填，`parseRecentCalls` `#L212-L269`）。

`argsDigest` 落盘长度实测：max **511** / min 20 / median **252**，`>160` 者 **709/1090**（`>512` 者 0）。⇒ 盘上存的是**完整命令行**（可读出 agent 在干什么），160/64 只是**展示层**截断（`ARGS_DIGEST_MAX_CHARS` / 降级到 64）。凭据正则扫全部 1090 条 digest：命中 1/1090（内容为 shell 变量名 `token: $token`）——即 `maskCredentials` **只在展示层跑，落盘未脱敏**（模型把真实 token 写进命令行时会原样落盘）。

硬上限（`recent-calls.ts#L25-L49`，均有测试断言）：

| 常量 | 值 | 含义 |
|---|---|---|
| `RECENT_CALLS_TOTAL_BYTES` | 1536 | 单次输出硬字节上限 |
| `ARGS_DIGEST_MAX_CHARS` | 160 | 展示参数摘要上限（`args=`） |
| `RESULT_PREVIEW_MAX_CHARS` | 120 | 结果预览上限（`result:`） |
| `RECENT_CALLS_N_MAX` / `_DEFAULT` | 5 / 3 | `n` 上限 / 缺省（`clampN` 夹紧到 `[1,5]`） |
| `RECENT_CALLS_CAP` / `RING_K` | 8 | async 派发侧环形容量 |
| `TAIL_READ_MAX_BYTES` | 262144 | tab 会话尾读上限（256KB） |
| `HEAD_READ_MAX_BYTES` | 65536 | tab 定位头部读上限（64KB） |

输出为 **newest-first**；总长超限按序降级：**删最旧 `result` → 缩最旧 `args` 至 64 → 硬切至 1536B**（`formatRecentCalls`，`recent-calls.ts#L639`）。

**reason 集合**（`RecentCallsReason`，`recent-calls.ts#L76`）：`not-found | no-session | unreadable | ambiguous | no-detail`。

- `not-found`（无该 run/派发记录）· `no-session`（bucket 不存在或头匹配无候选）· `unreadable` · `ambiguous`（多个同分候选）→ 走 `formatRecentCallsError`，`isError:true`。
- `no-detail`（有记录但无工具明细，**且 tab 窗口内 assistant 回合不足阈值**）→ **非 error**：verdict = `unknown`，basis `no tool detail (…toolCallsCount=N)`，提示看 `status`/`toolCallsCount`（`index.ts#L3538-L3546`；tab 判定条件 `index.ts#L3648`）。
- 二者都**绝不静默空**：至少给出一条可读状态行。

### 3. 判定规则（`classifyLoop`，`recent-calls.ts#L536-L571`）

形式化定义（阈值 `thr`，默认 3）：

- **`repeating`**：尾段连续 **≥ thr** 次 `tool` 相同 **且** `normalizeArgsDigest(argsDigest)` 相等（`normalizeArgsDigest` 对对象做键递归排序 + 空白折叠后稳定序列化，字符串入参仅折叠空白；≤512 字符，`recent-calls.ts#L159`）。basis 记 `repeating: <tool>×<segLen> same args (turn A-B)`，hint 指向 steer 纠偏 / 持续则 kill。
- **`no_progress`**：`turnClock - lastToolTurn ≥ thr` **且** `turnClock ≥ thr`（连续若干回合无工具调用）。hint 指向 steer 注入新指令。
- **`ok`**：其余。

**优先级：`repeating` > `no_progress` > `ok`**（先尾段重复判定，再回合时钟判定）。`turnClock`（总回合数）/ `lastToolTurn`（最后一次工具调用所在回合）由接线层提供：

### 3.1 `n` 与 `threshold` 的交互边界（2026-10-22 实测）

判定只看**传入的 entries**（无历史窗口，不回读盘）。而 `n` 被 `clampN` 夹到 **≤ `RECENT_CALLS_N_MAX`=5**（`recent-calls.ts#L199`），`loopGuard.threshold` 可被 `normalizeLoopGuard` clamp 到 **[2,10]**（`recent-calls.ts#L578-L592`）。实测（`classifyLoop` 直接 probe）：

```
entries=3 thr=2  -> repeating: bash×3 same args
entries=3 thr=5  -> ok            # thr > 可用条数 ⇒ repeating 结构上不可达
entries=5 thr=6  -> ok
entries=5 thr=10 -> ok
empty entries thr=3 turnClock=3 -> no_progress
```

⇒ **`threshold ≥ 6` 时 `repeating` 永远不可能命中**（除非调用方绕过 `clampN` 直接喂 ≥thr 条）。`no_progress` 不受此限（只依赖 `turnClock - lastToolTurn`）。这是**配置交互边界**，不是缺陷；改 `threshold` 时应知道这一上限。
- **tab 路径（2026-10-16 修复，原已知限制已闭合）**：`turnClock = collectTabWindow(...).windowTurns`（尾部有界窗口内的 assistant 回合数，`index.ts#L4216-L4219`）；`lastToolTurn = max(entries.turn)`（`#L4217`）。修复前 `turnClock = lastToolTurn` ⇒ 差值恒 0，tab 只能判 `repeating`；现在最后一次工具调用之后每多一个纯文本 assistant 回合差值 +1 → `no_progress` 可触发。窗口相对计数是真实会话回合数的**下界**（尾部窗口可能从会话中段开始），`turnClock ≥ thr` 守卫保持保守不虚报；窗口内零工具调用但回合已达标（`entries=[] && windowTurns ≥ thr`）也交 `classifyLoop` 判 `no_progress`，仅回合数不足时才降级 `no-detail`/unknown（`#L4221-L4224`）。
- **async 路径**：先取 `target.recentCalls ?? target.result?.recentCalls`（运行中增量写回的明细，`index.ts#L4240`），再 `lastToolTurn = max(target.lastToolTurn, 环内最大 turn)`（`#L4246-L4247`）、`turnClock = result.usage.turns || target.turnClock || lastToolTurn`（`#L4248`）。`AsyncRunRecord.lastToolTurn?`/`turnClock?`（`index.ts#L2306-L2307`）即增量写回落下的字段。
- **async 的 `no_progress` 对运行中 run 结构性不可触发（2026-10-26 实测复核，**尚未修**）**：写点 `index.ts#L4449-L4450` 令 `lastToolTurn = max(calls[].turn)`、`turnClock = max(turn, lastToolTurn)`，而 `calls[].turn` 就是 `result.usage.turns`（`index.ts#L1428`）⇒ **两值恒等**；且该写点**只在 tool 事件触发**，纯文本回合根本不推进 `turnClock`。实测（分母 220 份 run json）：有 `turnClock` 的 5 条**差值全为 0**（含 2 条 running：`38/38`、`44/44`）⇒ 运行中只剩 `repeating` 一条有效判据。**tab 路径 2026-10-16 已修同一类缺陷**（改用 `windowTurns`，见本节上一条），async 路径漏了同一个修法；调阈值无效，必须换回合计数载体。报告：`plans/20261026_research_subagent_gui_presentation.md` §2.1 D3。
- **终态记录的 verdict 不可当「卡住」证据**（2026-10-22 全量实测）：153 份终态 run 跑同一判定（n=3/thr=3）得 `ok 125 / unknown 13 / no_progress 15`，而 **15/15 的 `no_progress` 全部落在 `completed`**——因为终态用 `result.usage.turns` 当 `turnClock`，长任务收尾段天然「多回合无工具调用」。且 `lastToolTurn`/`turnClock` 在终态记录上实测 **1/153**（被 `.then` 整份覆盖抹掉，见 [[异步 Run 控制面（list / kill）]]），所以终态判定实际退化为环内最大 turn 自比。**verdict 只对 `status:"running"` 记录有诊断意义**；`no-detail`（13 份）则来自 `recentCalls` 为空（僵尸/无工具调用）。

### 4. `loopGuard` 配置

- 默认值 `DEFAULT_LOOP_GUARD = { enabled: false, threshold: 3, action: "warn" }`（`recent-calls.ts#L575`）；`config.example.json#L29` 同形。
- `normalizeLoopGuard(raw)`（`recent-calls.ts#L578`，never-throw，仿 `normalizeMasterSuccession`）：缺省/垃圾 → 默认；`enabled` **严格 `=== true`**（fail-closed）；`threshold` 数字则 **clamp `[2,10]`** 取整；`action` 仅 `"kill"`（显式且合法）否则 `"warn"`。
- `AgentConfig.loopGuard?`（`index.ts#L279-L280`）在 `readConfig` 归一化（`index.ts#L305`/`L308`）。
- **`enabled:false` 不影响只读查询**：`recent-calls` 始终正常返回调用列表与 verdict；`loopGuard` 只控制是否**额外**渲染 `[loopGuard: …]` 行 + 是否自动处置（`index.ts#L4269-L4289`）。
- **只有 `action:"kill"` 才终止**，且复用既有 `killAsyncRun`（双重安全校验、幂等；见 [[异步 Run 控制面（list / kill）]]）。命中 kill 的前提是 `source === "async" && running && id`；**tab 无 kill 能力 → 降级为 warn 并在 hint 加「tab 无 kill 能力，请手工处理」**。

### 5. 测试

- `extensions/_test_recent_calls.ts`：**178 断言**（`assertions=178 failed=0`），覆盖 `truncateUtf8` 字节边界（含打断多字节）、`readTailBytes`（半截首行丢弃 / 多字节不乱码 / never-throw）、`digestArgs ≤160`、`clampN`、`normalizeLoopGuard`、`locateTabSession`（时间窗 / ambiguous / no-session）、`classifyLoop`、`formatRecentCalls`/`formatRecentCallsError`，**T9/T10 输出字节上限断言（`bytes ≤ RECENT_CALLS_TOTAL_BYTES`）**，**T11 运行中增量写（`mergeRunRecord` 保留 `pid`/`lastActivity`/`status`/`startedAt`/`killedAt` 等其它字段、`createThrottledRunMerger` 首调用立即写 + 窗口内节流 + 超窗恢复）**，以及 **T5b `collectTabWindow`/`countAssistantTurns`（entries+windowTurns 同窗单次读、坏行/扁平行不计、尾部纯文本回合 → `no_progress`）**。T10 集成含「运行中记录 → 不判 `no-detail`、能看出 `repeating`」与 **2026-10-16 tab turnClock 修复矩阵（每场景独立 cwd 桶防同前缀互抢）**：① tab 重复同一调用 → `repeating`（复用 repeat 夹具）② 工具调用后 4 个纯文本回合 → `no_progress`（basis 含 `4 turns without tool`）③ 窗口零工具但回合达标 → `no_progress`（不降级 unknown）④ 短会话（1 回合 < 阈值）→ 仍 `no-detail`/unknown 不虚报。
- 4 个 fixture：`recent-calls-distinct.jsonl`（不同调用）、`recent-calls-repeat.jsonl`（连续重复 → `repeating`）、`recent-calls-noprogress.jsonl`（无工具调用 → `no_progress`）、`recent-calls-tab-noprogress.jsonl`（tab：工具调用后纯文本回合推进 → `no_progress`）。

## Evidence

- `extensions/recent-calls.ts#L25-L41` — 硬常量（`RECENT_CALLS_TOTAL_BYTES=1536` `#L25` / `ARGS_DIGEST_MAX_CHARS=160` `#L27` / `RESULT_PREVIEW_MAX_CHARS=120` `#L29` / `RECENT_CALLS_N_MAX=5` `#L31` / `RECENT_CALLS_CAP=8` `#L35` / `TAIL_READ_MAX_BYTES=262144` `#L39` / `HEAD_READ_MAX_BYTES=65536` `#L41`）
- `extensions/recent-calls.ts#L54-L76` — `RecentCallEntry` / `LoopGuardConfig` / `RecentCallsReason`
- `extensions/recent-calls.ts#L185-L274` — `clampN` / `parseRecentCalls`
- `extensions/recent-calls.ts#L290-L367` — `readHeadBytes` / `readTailBytes`
- `extensions/recent-calls.ts#L371-L436` — `countAssistantTurns` / `collectTabWindow`（tab 尾窗 `{entries, windowTurns}` 同窗单次读）/ `collectAsyncCalls`
- `extensions/recent-calls.ts#L481-L534` — `locateTabSession`
- `extensions/recent-calls.ts#L536-L571` — `classifyLoop`
- `extensions/recent-calls.ts#L575-L591` — `DEFAULT_LOOP_GUARD` / `normalizeLoopGuard`
- `extensions/recent-calls.ts#L639-L691` — `formatRecentCalls` / `formatRecentCallsError`
- `extensions/index.ts#L336` / `#L356` — `AgentConfig.loopGuard?`（类型声明；`readConfig` 归一化调用点另见 `readConfig` 内 `normalizeLoopGuard`）
- `extensions/index.ts#L911` — `RunnerResult.recentCalls?`（另有 `AsyncRunRecord.recentCalls?` `#L2304`）
- `extensions/index.ts#L1253` — `runSingle` 内存环形 `ring`
- `extensions/index.ts#L1424` / `#L1426` — 进度事件 `pushRecentCall(ring, …, RING_K)` + `opts?.onRecentCalls(ring.slice(-RING_K), turn)`
- `extensions/index.ts#L1478` / `#L1490` — `error`/`close` 快照 `result.recentCalls = ring.slice(-RING_K)`
- `extensions/index.ts#L1894` — `RunOptions.onRecentCalls?`（运行中回调签名）
- `extensions/index.ts#L2304-L2307` — `AsyncRunRecord.recentCalls?` / `lastToolTurn?` / `turnClock?`（运行中增量写 + 终态快照；kill 后保留）
- `extensions/index.ts#L3758` / `#L3784-L3788` — 工具 description 行 + schema 参数 `action`/`runId`/`tabRunId`/`n`
- `extensions/index.ts#L4181-L4300` — `action:"recent-calls"` 分支（两条取数路径 + verdict + loopGuard 处置 + `formatRecentCalls` 输出 `#L4290-L4300`）；`renderCall` 在 `#L3825-L3828`
- `extensions/index.ts#L4216-L4223` — tab 取数 + turnClock（`collectTabWindow` → `entries`/`windowTurns`；零工具但回合达标不降级 no-detail）
- `extensions/index.ts#L4240` / `#L4246-L4248` — async 运行中读 `target.recentCalls ?? target.result?.recentCalls`；`lastToolTurn`/`turnClock` 取增量字段
- `extensions/index.ts#L4335` / `#L4437` — `createThrottledRunMerger(runId, RUNS_DIR)`（并行 / 单发异步）
- `extensions/index.ts#L4347` / `#L4448`（`record.recentCalls = result.recentCalls`）— 终态快照落盘（并行 / 单发）
- `extensions/runner-argv.ts#L64-L70` — `buildPiArgv` 固定 `--no-session`
- `extensions/subagent-kill.ts#L295-L310` — `touchRunActivity`（`ACTIVITY_PERSIST_INTERVAL_MS=5_000`，`#L130`）
- `extensions/subagent-kill.ts#L132` / `#L327` / `#L346` — `RECENT_CALLS_PERSIST_INTERVAL_MS=5_000` / `mergeRunRecord`（读-改-写保留其它字段，不覆盖 kill 字段）/ `createThrottledRunMerger`（≤1 次/5s，首调用立即写）
- `extensions/tab-runs.ts#L122` / `#L128` / `#L133` / `#L531` — `sessionBucketForCwd` / `defaultSessionsRoot` / `defaultTabRunsDir` / `readTabDispatch`
- `extensions/launch.ts#L237` — `modePrefix`
- `extensions/_test_recent_calls.ts`（178 断言，含 T9/T10 字节上限 + T11 运行中增量写合并/节流 + T5b/T10 tab turnClock 修复矩阵）+ `extensions/fixtures/recent-calls-{distinct,repeat,noprogress,tab-noprogress}.jsonl`

## Links Out

- [[异步 Run 控制面（list / kill）]] — `killAsyncRun` 的双重安全校验与幂等语义（loopGuard `action:"kill"` 复用）
- [[扩展命令面与测试隔离约定]] — `deps` 注入范式、`~/.pi/agent/**` 小表、测试隔离纪律

## Backlinks

- [[异步 Run 控制面（list / kill）]]
- [[扩展命令面与测试隔离约定]]
