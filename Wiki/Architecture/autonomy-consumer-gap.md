# Autonomy 计算图的消费者缺口

> 校准状态：**current（2026-10-31 源码级核实 + 真机读数）**
> 关联：`autonomy-suite.md`（契约与开关）、`wake-delivery-ledger.md`（交付账本）
>
> 本文记录一个**结构性事实**，不是任务记录：`buildFrontier` 算出的触发有一条完整的
> 生产链，但**没有消费者**。它直接决定了「状态计算图能不能自己唤醒 agent」这个问题的答案。

---

## 结论：算得对，但没人执行

```
collectAutonomyInputs()  collect.ts:184
  → buildFrontier()      frontier.ts:502   纯函数，零 IO
  → 9 类触发规则
  → evaluateWakeGate()   wake-gate.ts:59
  → writeWakeGateState() + 审计行
  → return { proceed }   gate.ts:118       ← 到此为止
```

`gate.ts:118` 原文：

```typescript
return { engaged: true, proceed: decision.wake, reason: decision.reason };
```

**没有任何 spawn 调用。** `proceed` 唯一的用途是给 legacy 邮箱通道当闸门（`wake.ts:114-115`）：

```typescript
const autonomyGate = evaluateAutonomyWakeGate({ stateDir, configPath: opts.autonomyConfigPath, now });
if (autonomyGate.engaged && !autonomyGate.proceed) return [];
```

---

## 两条通道的真实分工

| | 通道 A（legacy 邮箱） | 通道 B（v2 计算图） |
|---|---|---|
| 入口 | `mailbox-consumer.ts:614`，`setInterval(30s)` | `collectAutonomyInputs()` |
| 判据 | 邮箱有 pending 信 + 非 cooldown + 非 in-flight + 未超 maxSpawns | 9 类 diff 规则 |
| 会 spawn 吗 | **会** | **不会** |
| 看对方结论吗 | 只看「拦/放」一个 bit | 不看 |

**关键事实**：`evaluateOne`（`wake.ts:135`）的 fire 条件里**没有任何 `diff` / `triggers` 判断**。计算图算出「该动了」，这个结论只影响「邮箱通道这次允不允许跑」，不影响「要不要因为计算图的结论去跑」。

---

## 为什么「累积阈值」看起来像实现了但实际不工作

`maintainBatchAnchor`（`gate.ts:51`）：

```typescript
export function maintainBatchAnchor(state: WakeGateState, diff: FrontierDiff, now: number): WakeGateState {
	const hasDiff = diff.triggers.length > 0 || diff.recordOnly.length > 0;
	return { ...state, batchFirstSeenAt: hasDiff ? (state.batchFirstSeenAt ?? now) : null };
}
```

`?? now` = **只在首次出现时置一次**，之后不刷新。它本该在 diff 被消费后清为 `null`。

因为**没有消费者**，`hasDiff` 永远为真，锚点永久卡在首次值。真机实测：

```
batchFirstSeenAt = 1790332810040  =  2026-09-25T10:40:10Z
距 2026-10-31 实测时 = 36.2 天
```

**这就是「累积逻辑写着但卡死」的直接证据**：逻辑是对的，缺的是让它推进的那一步。

同时 `lastWakeAt === lastDecisionAt`（每帧同一刻）⇒ `decision.wake` 恒为 true ⇒ 门在无条件放行。

---

## `ProjectState = "Working"` 不等于「在干活」

`aggregateProject`（`frontier.ts:405`）：

```typescript
const nonTerm = tabs.filter((t) => !mapPhaseToProjectState(t.phase).terminal);
if (nonTerm.length > 0) { state = "Working"; }
```

只要有一个 tab 不在终态，整个项目就是 `Working`。而 `mapPhaseToProjectState`（`frontier.ts:301`）把
`waiting` / `orphaned` / `unconfirmed` / `working` / `attached` / `dispatched` 全归为非终态。

**所以 `Working` 的语义是「没结束」，不是「在干活」。** 真机实测 5 个项目全部 `Working`，
其中包含已死 6 小时的 local master 与卡了 5.4 天没动的 tab。

这是判据的**正确**行为，问题在命名会误导人。

---

## `STALLED` 极难触发（四条全中）

`deriveTabSupervisionState`（`frontier.ts:364`）：

```typescript
if (!ledger) return "NOT_MONITORED";                                    // ① 没有监管账本
if (ledger.optOut === true) return "NOT_MONITORED";
if (tab.phase === "unconfirmed" && tab.stop !== "aborted") return "BLOCKED_USER";
if (tab.resultMissing === true && terminal) return "BLOCKED_USER";
if (terminal) return "DONE";
if (tab.needsHuman || tab.gate === "awaiting" || attention > 0) return "BLOCKED_USER";
if (tab.stop === "error") return "BLOCKED_USER";
if (tab.stop === "toolUse") return "ACTIVE";                            // 跑长工具豁免
if (tab.phase === "waiting" && tab.idleMs !== null && tab.idleMs > pushMs) return "STALLED";  // ②③④
return "ACTIVE";
```

要同时满足：**有监管账本** + `phase === "waiting"`（不是 working）+ `idleMs` 有真实值
（`state.lastActivityAt` 存在，缺则 `null`，绝不拿文件 mtime 冒充）+ 超 `pushMs`（缺省 15 分钟）。

真机实例：`subagent-win` 项目有 tab `idleMs = 465,760,413 ms`（5.4 天）仍报
`supervision.state = "NOT_MONITORED"` —— 因为没有账本。

**取向是「宁可漏报，不可误报」。** 代价：**不主动登记 = 永远不提醒。**

---

## 接上这一环之前必须先补的三件事

`decision.wake` 实测**恒为 true**。直接接线 = 每 30 秒 spawn 一个 tab，无法停止。

1. **消费语义**：spawn 后把 diff 标记已消费（否则同一触发每帧重复）
2. **每个 trigger 的 dedupeKey**：同一条触发不重复计
3. **速率上限**：每 tick ≤1 次 spawn，每小时 ≤N 次

以及一份 `trigger → action` 决策表。现有 rule 全清单（`frontier.ts` 各 push 点）：

| rule | approximate | 合理动作 |
|---|---|---|
| `ws_mail_backlog` | false | 交给 legacy 通道（已实现） |
| `expected_event_timeout` | false | 提醒 / 重派 |
| `working_to_completed` | false | reclaim |
| `working_to_failed` | false | 报人 / 重派 |
| `blocked_to_ready` | **true** | 评估后决定 |
| `needs_user` | false | 报人 |
| `deadline_urgency` | **true** | 提醒 |
| `stagnation` | false | supervise-push |
| `blocked_overdue` | false | 提醒（1h 节流/runId） |

`meaningfulChanges` 只数 `approximate === false` 的（`frontier.ts` 末尾），即 approx 触发只记录不叫醒。

---

## 相关实测读数（可作为回归基线）

清理前 `wake-gate.json`：

```json
{ "lastDecisionAt": 1793470903664, "lastWakeAt": 1793470903664,
  "batchFirstSeenAt": 1790332810040, "lastReason": "ordinary" }
```

清理 `batchFirstSeenAt` 为 `null` 后 30 秒，它自动重建且 `lastReason` 变为 `"debounce"`：

```json
{ "lastDecisionAt": 1793470933671, "lastWakeAt": 1793470903664,
  "batchFirstSeenAt": 1793470933671, "lastReason": "debounce" }
```

**判别法**：`lastReason` 长期恒为 `ordinary` ⇒ 门在无条件放行（异常）；
出现 `debounce` / `no-wake` / 具体 reason ⇒ 它在真的做判断。

---

## 方法论：判断「有没有实现」不能只看代码在不在

本仓已发生过同类事故：`_test_session_liveness.ts:80` 曾断言「dead 必须优先于 alive」，
**测试把 bug 锁成了规范**，6 个测试全绿不是「没测冲突」，而是「测了冲突并确认了错误答案」。

本次是另一个形态：9 类触发规则全都写了、算出过、跑了 36 天 —— 但结论被拿去当闸门用，
**从来没被当成命令用**。

**判据：一个计算的结果，要问「谁在消费它」，而不是问「它算对了吗」。**
