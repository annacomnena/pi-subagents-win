# Autonomy 从「只观察」到「可回滚动手」——设计与判据（L1）

> 本文档只做设计与判据，不含任何已实施的代码改动。分期实施计划见 `plans/20261001_autonomy_actionable_plan.md`（下称「计划文档」）。

## 依据

- searcher 已验证事实全文：`C:\Users\Annacomnena\.pi\agent\subagent-runs\dd559f6f-3625-49c7-9ef5-56406415295c_full.md`（审计行签名 / frontier 词表 / command-executor 形态 / 回滚基建现状 / 安全面 / 测试覆盖，每条带 file#L；关键引用已抽查复核一致）。
- consultant（gpt-6-sol，用户授权点名）咨询结论全文：`C:\Users\Annacomnena\.pi\agent\subagent-runs\c6ceeaf1-e4a0-463c-90ec-43a0ce9c19cd_full.md`（四节：派活许可伪代码、三件套判据、熔断建议值、trigger 首版最小集）。逐条回应见 §6。
- 已 read 的 Wiki 章节：
  - `Wiki/Architecture/autonomy-suite.md`（#Current Contract、#v2 接线、#接线落点与边界、#Evidence、#Open Questions）
  - `Wiki/Architecture/approval-gate.md`（status: proposed 未实现；deny>ask>auto、fail-closed、TOCTOU 最后入口复核——本设计直接承接其「auto 分支判定器」定位）
  - `Wiki/Decisions/gui-master-unlock.md`（#Current Contract 三证据合取；M3 审计 0600 + ~1MB 两代 rename 先例）
  - `Wiki/Architecture/local-master-ensure.md`（四层授权合取、wx first-wins in-flight marker、fail-closed 认领、审计六字段无正文、USER_DIRECTIVE 先例）
- 关键代码抽查（本次复核，行号与 searcher 一致）：`extensions/runtime/autonomy/collect.ts:261-267`、`extensions/runtime/autonomy/frontier.ts:285-350`、`extensions/runtime/command-executor.ts:68-90/:216-229`、`extensions/runtime/autonomy/gate.ts:63-89`、`extensions/runtime/autonomy/kill-switch.ts:30/48/68/83`、`extensions/runtime/wake.ts:100-115`、`extensions/runtime/autonomy/config.ts:28-60`。

## 目标

在**不破坏现有内容**的前提下，把 autonomy 从「只观察 + 放行既有唤醒链」升级为「可执行**可回滚**动作」：

1. 给出「允许自主 / 必须交人 / 拒绝」的**可执行判据**（决策树 + 伪代码，未知即拒绝 fail-closed）；
2. 判定四类候选动作（派活 / 重启 worker / 写文件 / git commit）的许可等级，**正面处理「派活不可回滚」反例**；
3. 设计熔断与预算（带建议值 + 理由）、动作审计与回放（与既有 `appendAuditEvent` 兼容）、trigger→action 首版映射；
4. 产出分期实施计划（计划文档），每期含可测验收与**可执行的回退演练**。

**用户唯一硬边界（原话裁定）**：「1 可以在不破坏现有内容的状况下动手 —— 只要最终能恢复到现状就无所谓」⇒ 允许自主 = 动作最终能恢复到现状（可回滚）；禁止自主 = 不可逆 / 无法恢复。

## 工程约束

- **零破坏唤醒循环**：既有不对称语义保留——wake-gate 装配层崩溃 fail-open 走 legacy（`gate.ts:117-125`），而**新动作面必须 fail-closed**（两层语义不同：观察面宁可放行既有链，动作面宁可不动作）。
- **只写自有 namespace**：v1 红线延续（`Wiki/Architecture/autonomy-suite.md` 红线：不写共享账本、不改其它仓库、不消费/ack 他人 mailbox；只写 `<stateDir>/autonomy/`）。v1 动作效应面⊆自有 namespace。
- **默认关闭零行为**：`config.json` 无键 = 逐字节现状（D7 先例，`config.ts` 严格归一化 `=== true` + 逐字段回落）；动作开关独立于 `autonomy.enabled`，双层合取。
- **不改 `audit.jsonl` 既有语义**：W5 冻结正则 `concl=(engage|clear|wake|no-wake|pass)`（`extensions/_test_autonomy_wiring.ts:330`）与 W6「单次评估恰 3 行」体积基线不得因动作面而漂移（方案见 §3）。
- **本任务只写 plans/**：不触 `extensions/`、`gui/`、Wiki。

## 术语

- **效应面（effect surface）**：一个动作可能写入/影响/触发的全部状态集合（文件路径集、git 对象、进程、外部系统调用……）。
- **可恢复状态域（recoverable state domain）**：用户裁定中「现状」所覆盖的状态集合。域内状态必须可被快照并恢复；域外效果 = 不可回退例外（需用户显式批准，见 §6 决策点 D1）。
- **动作事务**：attempt → precheck → snapshot → effect → postverify →（mismatch 则 rollback + reverify）→ settle 的完整包裹，全程落动作账本。

---

## 1. 可回滚动作分级与许可模型（核心）

### 1.1 对起点判据「前置快照 + 回退句柄 + 后置验证，缺一不可」的充分性评估

**结论：三件套是必要条件，不充分。**（与 consultant §2 判断一致，采纳。）缺以下四件时，三件套形同虚设：

1. **副作用封闭先于快照**：快照只覆盖「已知的」效应面。若动作的效应面不可枚举或未证明 ⊆ 可恢复状态域，「快照→回退」是对着子集做的戏——未覆盖的写入（如 push、外发消息、触发外部 hook）发生后，post-verify 只能**发现**失配，不能**撤销**失配。⇒ 封闭性必须作为**前置**判据（preflight），而非事后验证。
2. **并发/独占控制**：快照与回退之间若有并发写者（他人/他进程写同一文件、git ref 竞争），回退会**覆盖别人的写**——回退本身变成新的不可逆动作。⇒ 效应面需独占租约；拿不到就放弃（fail-closed，不排队重试）。
3. **回退失败路径**：回退句柄可能失效（快照损坏、文件系统错误、外部系统已变更）。必须预先定义：回退失败 ⇒ 立即熔断 + 冻结 + 交人，**绝不自动重试**。
4. **不可回退例外的显式边界**：token/时间成本、审计留痕、通知发送天然不可快照。判据必须声明它们在（或不在）可恢复状态域内，否则「可回滚」在字面上永假（见 §6 D1）。

另加两条工程要求（源自本仓既有纪律）：**未知即拒绝**（任何 precheck 项返回 unknown → DENY，fail-closed，区别于 kill-switch 的容忍读 `kill-switch.ts:30`）；**TOCTOU 最后入口复核**（效果执行前重验第 0–3 层全部判据，形态承接 `Wiki/Architecture/approval-gate.md` #Current Contract「执行器最后入口复核」与 command-executor 的 claim 前预检先例 `command-executor.ts:190-214`）。

### 1.2 许可判定决策树（可执行伪代码；每动作一次，效果执行前再复核一次）

```text
decide(action, ctx):                       # 返回 AUTO_EXEC | HUMAN | DENY(reason)
  # ── 第 0 层：总门（全部 fail-closed 读；读不到 = 拒绝，与 wake 面的 fail-open 相反）
  if read_autonomy_config().actions.enabled !== true:      → SKIP      # 默认关闭零行为
  if read_kill_switch() exists:                            → DENY(kill-engaged)        # kill-switch.ts:30
  if read_breaker() is unreadable or .tripped:             → DENY(breaker)             # §2
  if read_budget_counters() is unreadable:                 → DENY(budget-unreadable)   # 计数持久化失败即拒绝
  if ctx is not (main session or master owner):            → DENY(not-owner)           # 仿 scope ownership 门 scope.ts:331-375 / masterDispatchGate 口径

  # ── 第 1 层：白名单（trigger × 动作类，双维度都要在册）
  if action.trigger.rule not in TRIGGER_ALLOWLIST:         → DENY(trigger-not-allowed)  # 可另行 record-only；不进入许可分支
  if action.class not in ACTION_CLASS_ALLOWLIST:           → DENY(class-not-allowed)   # HUMAN 仅作上层呈现，不是许可结果
  if action.trigger.approximate === true:                  → DENY(approximate-trigger) # frontier.ts:337/:345 的 approx 标志

  # ── 第 2 层：可回滚四要件（快照/句柄/验证 + 封闭 + 独占；unknown 一律 DENY）
  if not provable_side_effect_closure(action):             → DENY(surface-open)        # 效应面可枚举 且 ⊆ 可恢复状态域
  if not snapshot_covers(effect_surface, before):          → DENY(no-snapshot)
  if not rollback_handle_valid(action):                    → DENY(no-rollback)
  if not postverify_covers(effect_surface):                → DENY(no-postverify)
  if not lease_exclusive(effect_surface):                  → DENY(no-lease)

  # ── 第 3 层：预算与熔断（数值见 §2）
  if in_flight_actions >= 1 or new_this_tick >= 1 or started_in_last_1h >= 2: → DENY(budget)
  if consecutive_failures(trigger×class×project) >= 2:     → DENY(repeat-fail)
  if dedup_window_hit(rule × project, 1h):                 → SKIP(cooldown)

  # ── 执行（事务式；effect 前重验第 0–3 层 = TOCTOU 最后入口复核）
  ledger.append(attempted {trigger, intent, snapshot_ref})
  ledger.append(precheck {result: pass})
  revalidate(L0..L3)                                        # 任一变 false → DENY(race-detected)，不执行
  effect()
  ledger.append(executed)
  if postverify() !== match:
      rollback(); ledger.append(rolled_back | rollback_failed)
      if rollback_failed or reverify_after_rollback() !== ok:
          trip_breaker(immediate); notify_local(); FREEZE   # 冻结 = 拒绝一切后续动作直到人工 clear
  else:
      ledger.append(postverified)
```

> **D4 裁定标注（2026-10-01）**：对「派活」类，第 0/2 层中依赖「环境层隔离/sandbox」的判据（封闭 ⊆ 可恢复状态域须由隔离证明）被 D4 裁定取代——不再要求隔离证明；派活类的第 2 层检查改由 **§6.3 许可检查表**（git 纪律 + 文件夹边界 + 只增不删）承担。本决策树对其余动作类（写文件/git commit）原文继续有效。

**已验证事实锚点**：kill-switch 容忍读/原子写/优先级 kill>enabled>active（`kill-switch.ts:30/48/68/83`），唯一消费点 `gate.ts:75-89`、短路点 `wake.ts:108-109`、enabled 旁路 `gate.ts:71-73`、装配层 fail-open `gate.ts:117-125`；wx 排他 first-wins marker 先例 `local-master-launch.ts:251`；原子 tmp+rename 先例 `kill-switch.ts:48`、config RMW `command-executor.ts:381-420`。**以上为现状；决策树本身是建议（标注为建议）。**

### 1.3 四类候选动作逐一判定

| 动作 | 效应面（已验证/分析） | 判定 | 理由 |
|---|---|---|---|
| **派活（launch tab）** | 任意 LLM agent 进程 = 以当前 OS 用户身份的无界写入（文件系统全域、git push 凭据、网络外发、mailbox/outbox 副作用、token 消耗）。关 tab 不撤销以上任何一项 | **本体不可回滚 → v1 DENY**；阶段二起派活可开（原「受强制隔离」表述被 D4 裁定取代，见 **§6.3**） | 反例核心：tab 会改代码/发消息/耗 token，这些都在效应面内且多数不可快照。除非把效应面**机械地**压缩到「可销毁的隔离区」，否则三件套无从谈起 |
| **重启 worker** | 进程内存态 + 在途操作（半写文件、已发未回执消息、租约）。仓库现状：command-executor 全文无 child_process、无进程管理（searcher 核实）——该动作今天甚至不存在执行器 | **全阶段 DENY（永久交人，除非出现进程态检查点基建）** | 「重启」的回退 = 恢复进程前状态，需 checkpoint 而仓库无任何先例；且重启修复不了可证明的任何东西——post-verify 无法断言「恢复现状」（新进程 ≠ 旧状态）。另注意：重启消费循环的诱人替代 `local-master-ensure` 本身就是「开新 tab + 认领 scope」= 派活类动作，其工具描述明令「仅在用户明确要求时调用；禁止自行决定接管」（`master-tools.ts:219`）——autonomy 不得绕过该 USER_DIRECTIVE |
| **写文件** | 可枚举路径集 + 文件系统语义（字节/权限/存在性） | **有条件 AUTO**：路径集封闭 ⊆ 可恢复状态域 + 独占 + 原字节/权限/存在性快照 + 原子替换 + 逐文件 post-verify + 恢复式回退。**v1 仅限自有 namespace 内的报告文件**（效应面 = `<stateDir>/autonomy/actions/**`） | 唯一能完整满足四要件的动作类。不满足情形：写共享配置被活进程消费（RMW 竞争，如 config.json 被 daemon 读取）、触发外部同步、路径集不可枚举 |
| **git commit** | refs + index + worktree + untracked；hook/CI/push 等外部触发面 | **阶段三有条件 AUTO**（v1/v2 不开）：私有未发布分支（从未 push）+ `--no-verify`（禁 hook 外部效果）+ 专属 worktree 独占 + 快照 = (HEAD, porcelain, 全量 diff, untracked 清单) + 回退 = 按 (HEAD, diff, untracked 清单) 逐项恢复 + post-verify = HEAD/porcelain/diff 三比对 | 已 push / 触发外部 CI / 有并行写入 ⇒ 不满足。仓内可复用件：porcelain 干净判定口径 `global-view.ts:151-181`、合成快照技术 `trace-fusion/snapshot.ts:21-84`（但它是只读证据链，非 undo——searcher 已核实与 autonomy 无耦合）。回退 = 人工回放级别的 `git revert` 纪律只适用于「单 commit 特性回滚」，不是动作级 undo |

### 1.4 核心难点正面处理：派活反例与解法论证

**反例**：autonomy 派一个 tab，tab 里的 agent 改了代码、push 了分支、发了消息。关掉 tab ≠ 恢复现状——写入在盘上、push 在远端、消息在收件人那里。**该动作本体不可回滚。**

四个候选解法逐一评估（与 consultant §1 对齐，结论一致）：

- **(a) 只派只读任务**（prompt 写「不要写文件」）：**不成立，单独不可授权**。任务描述不是权限边界——LLM 可能跑写命令（本仓 headless 子 agent 甚至有 `DEFAULT_EXCLUDE_TOOLS` 机制 `runner-argv.ts:20-27`，恰说明「prompt 约束会被突破」是已知威胁模型）。只有当「文件系统只读 + 私有可写输出区 + 禁外发」是**机制强制**时，(a) 才成立——那时它已变成 (c) 的一个属性。
- **(b) 派前工作区干净 + 事后强制 diff/revert**：**只能作检测/补救，不可作授权**。`git status` 干净 + 事后 diff 能发现**受 git 管理的**改动，但覆盖不了：已发生的 push、消息发送、被 .gitignore 的写入、git 元数据（refs/储藏）破坏。发现 ≠ 撤销。
- **(c) sandbox / worktree 隔离**：**方向正确但 worktree 单独不够**。worktree 共享宿主 `.git`（可写 refs、删分支）、共享全局凭据（可 push）、共享网络（可外发）。必须强化为**受强制隔离的派活**：宿主文件系统只读（或不可见）、私有可写状态区、无共享 git 写、无凭据注入、无网络出口（或出口白名单）。此时效应面 = 隔离区，回退 = **销毁隔离区 + 与基线逐项比对宿主可观测状态**（porcelain + 关键路径 mtime/哈希），全部一致才算回退成功。**〔已被 D4 裁定（2026-10-01）取代〕**用户否决隔离路线（不用容器/ACL/VM）；派活许可模型改按 **§6.3**（git 纪律 + 文件夹边界 + 只增不删）执行，本 (c) 保留为评估过程记录。
- **(d) commit 基线 + revert**：同 (b) 的盲区（revert 恢复不了 untracked/外部副作用；并行改动下 revert 误伤）。只在 (c) 之上作为**快照格式**之一有价值。

**裁定（建议）**：v1（阶段一）**完全不开派活**；阶段二只开「受强制隔离的派活」，且首版任务域限定为**只读调研**，产物留在隔离区、是否带回由人决定（带回动作本身走人门）。隔离的具体机制（Windows 容器 / 受限 token + ACL / VM）是可行性决策，见 §6 D4——**机制未定且未通过对抗演练前，派活在决策树里恒为 DENY**。**〔D4 已裁定（2026-10-01）〕**「受强制隔离的派活」表述被取代：用户否决隔离路线，阶段二派活改按 **§6.3 无隔离许可检查表**（四条派活许可 + 派活前/后检查表 + 回退演练）执行；「对抗演练通过前派活恒 DENY」相应改为「**§6.3 违规演练（故意越界写/删除 ⇒ 必须触发熔断）通过前，派活不开**」。首版任务域限定只读调研、产物带回走人门两点保留。

**结构性防火墙（本设计新增，标注为建议）**：必须把「autonomy 自主动作」与「放行既有 legacy 唤醒链」严格分开。已验证事实：wake 链 passthrough 会 claim 信并 spawn **当前 cwd 的 tab**（`wake.ts:evaluateWakes` → evaluateOne → claim，`gate.ts` 只做放行/压制），即**仓库今天就存在一个不受隔离的派活路径**——那是用户配置的既有行为，v2 审计诚实记为 `acted=false`（`collect.ts:264`）。本设计规定：动作账本（§3）**永不收录** legacy 放行为「autonomy 动作」；autonomy 新增动作**永不搭** legacy 唤醒的 spawn 通道（不复用 dispatch/wiring spawn，另走承载 §6.3 检查表的独立动作启动器）。是否反过来给 legacy 唤醒 tab 也加隔离，是既有行为变更，不在本设计范围（见 §6 D3）。

---

## 2. 熔断与预算（建议值 + 理由）

**先说结论**：以下数值是**试运行保守值**（不是从负载推算的最优值），代码内常量、不可经 config 放大（config 只允许收紧，`clampEnsureTimeout` 先例 `local-master-launch.ts:68`）；跑出运营经验后再调。

| 维度 | 建议值 | 理由 |
|---|---|---|
| 每 tick 新动作上限 | **1** | tick 基线 30s（scope 消费循环 `mailbox-consumer.ts` 30s interval）；1/tick 把单次误判的爆炸半径钉死在单周期内 |
| 全局在途动作 | **1** | 串行化 ⇒ 回退验证归因无歧义（无交错效应面），独占租约才可判 |
| 滚动 1h 新动作 | **2** | 试运行节奏：足够观察两个独立 incident，累积风险有界 |
| 同类连续失败停 | **2 次**（按 trigger×class×project 三元组） | 1 次可能是瞬时故障（spawn 抖动）；2 次指向系统性误判，且每次失败都该消耗人的注意力而不是机器的重试 |
| 立即熔断类（第 1 次即停 + 冻结） | 隔离逃逸 / 意外宿主改动 / 回退验证失败 / 回退后复验失败 / 在途动作无法停止 | 这五类 = 「可回滚承诺被证伪」，继续跑等于在未知状态上叠动作 |
| 单动作 token/时长（派活类） | **20k tokens 或 10 分钟，先到即停**；全局 1h **40k tokens** | 阶段二起生效。阶段一动作是本地文件事务（无 LLM 调用、无 tab），token 预算按构造有界——以「诊断数据读取字节上限 + 墙钟上限」替代（建议：单动作 ≤256KB 读取、≤5s 墙钟） |
| 计数口径 | 以**实际启动尝试**计，失败尝试也占额度；计数持久化（`actions/breaker.json`，原子写）；**读不到计数 = 拒绝动作** | 防崩溃清零刷额度；与 kill-switch 容忍读（`kill-switch.ts:30`）刻意相反——观察面容忍、动作面 fail-closed |
| kill-switch 联动 | 每动作 preflight 读 kill；kill 在场 ⇒ 拒新动作；阶段二起运行中周期复查，kill 触发 ⇒ 终止/隔离在途 tab，**回退验证通过后才允许人工 clear** | 复用既有灭火开关信号（`gate.ts:75-89` 唯一消费点先例），但**不得把 kill 文件当安全执行门**——已验证：kill 坏文件按未 kill 处理（容忍读）+ gate 装配层 fail-open（`gate.ts:117-125`）。执行门必须是独立的 fail-closed breaker |
| 通知人 | **立即**：五类立即熔断事件。**汇总**：连续失败 2 次 / 预算耗尽 / 反复 unknown 拒绝。**通道 v1 = 仅本地**（动作账本行 + master-status 可见面 + `/autonomy status` 尾行） | 学术语诚实：**发外部通知（微信等）本身就是不可回滚动作**——用不可回滚手段管理可回滚承诺是自相矛盾；v1 先本地，外发通道列入不可回退例外后再开（§6 D5） |

---

## 3. 审计与可回放

### 3.1 与既有 `appendAuditEvent` 的兼容方案：**additive、新文件、零触碰**

**结论：动作事件不进 `audit.jsonl`，新开 `<stateDir>/autonomy/actions.jsonl`（JSON Lines，自有 namespace，红线内）。** 理由：

1. **W5 冻结**：`concl=(engage|clear|wake|no-wake|pass)` 正则冻结在 `extensions/_test_autonomy_wiring.ts:330`；且已验证词表实际 7 值（生产还发 enable/disable，`extensions/index.ts:2005/:2171`）而 `concl` 类型是裸 string（autonomy-suite Open Questions 已列敞口）。往 `audit.jsonl` 加新 cat/concl 值 = 要么违反冻结、要么先做词表收窄前置任务——为一个新事件类型动两处冻结面，收益为零。
2. **W6 体积基线**：W6 钉死「单次完整评估恰 3 行」；动作事件若混入，每动作一次评估就变 4+ 行，基线作废。
3. **表达力**：kv 行式（reason 截 200、消毒）装不下回放所需的嵌套结构（precheck 矩阵、快照引用、回退句柄）。JSON 行是自有 namespace 新文件，格式自由。
4. **`acted` 语义分离**：`audit.jsonl` 的 `acted=false` 恒真（`collect.ts:264`，v2 语义：gate 只是放行既有链）**保持不动**；`acted=true` 只存在于 actions.jsonl。cat=wake 行继续只描述「放行/压制判定」，与 §1.4 的结构性防火墙一致。

**采纳既有先例**：轮转从第一天就有（0600 + ~1MB 两代 rename，`master-injection.ts` M3 先例，`Wiki/Decisions/gui-master-unlock.md` #must-fix 两轮）——不重蹈 audit.jsonl 无轮转（R5）的覆辙。原子写 tmp+rename（`kill-switch.ts:48` 先例）。never-throw（`collect.ts:261-267` 同款纪律）。

### 3.2 动作记录 schema（建议）

每动作多事件、每事件一行：

```jsonc
{"v":1,"id":"act_20261001T120000Z_ab12","kind":"attempted",        // attempted|precheck|executed|postverified|rolled_back|rollback_failed|frozen|rejected|skipped
 "ts":"2026-10-01T12:00:00.123Z","policyVersion":"actions-v1",
 "trigger":{"rule":"working_to_failed","project":"repo:X","evidence":"run:...","approximate":false},  // 哪条 trigger、依据
 "actionClass":"diagnostic-report","intent":"collect failure evidence for run ...",   // 意图
 "precheck":{"L0":true,"L1":true,"L2":{"closure":true,"snapshot":"actions/snaps/act_.../","rollback":true,"postverify":true,"lease":true},"L3":{"budget":true}},
 "effect":{"paths":["..."],"bytes":1234},
 "postverify":{"result":"match","detail":"..."},
 "rollbackHandle":{"type":"restore-files","snapshots":["actions/snaps/act_.../report.md.bin"],"validUntil":null},
 "reason":"..."}   // rejected/skipped/frozen 的原因
```

**回放必须能回答的三问**（验收口径，计划文档 P1 测试断言）：

1. 「autonomy 昨天做了什么」→ 按 ts 过滤 kind ∈ {attempted, executed}；
2. 「为什么」→ trigger（rule+project+evidence）+ intent + policyVersion；
3. 「现在能不能撤」→ 该 id 最新 kind ∈ {rolled_back(已撤), rollback_failed(不可撤，已冻结), postverified(可撤：rollbackHandle 存在且复验快照可读)}；快照缺失/不可读 ⇒ 如实报「无法保证可撤」，不猜。

回放工具 v1 = 只读解析函数 + `/autonomy status` 尾行展示；`/autonomy actions --since` 查询面列阶段三。

---

## 4. trigger → action 第一版映射表

已验证事实：frontier 全词表与近似标志（`extensions/runtime/autonomy/frontier.ts`）——`ws_mail_backlog`:289（approx:false，baseline 帧也产出）、`expected_event_timeout`:296-311（approx:false，level 触发）、`working_to_completed`:320/:328、`working_to_failed`:322/:330（approx:false）、`blocked_to_ready`:337（**approx:true**）、`needs_user`:341（approx:false）、`deadline_urgency`:345（**approx:true**）、`stagnation`:349（approx:false）、`needs_global`/`risk_high` 恒不产出仅 record-only 常量（:156）；⑧ 账本存在时被 filter（:387-391）。

| trigger | approx | v1 自主响应 | 理由 |
|---|---|---|---|
| `working_to_failed` | false | ✅ **诊断报告动作**（读失败证据 → 写自有 namespace 报告） | 证据收集只读；报告写入是最安全动作类（§1.3）。不自动重试/修复——失败原因未知，重试副作用不可枚举 |
| `stagnation` | false | ✅ **诊断报告动作**（限额核查进展 → 报告），按 run×原因去重 | 可能是正常长任务；只观察不催促不重启。边沿触发（false→true）天然一次 |
| `expected_event_timeout` | false | ⏸ 阶段二加入诊断类（v1 不响应） | 证据链要读期望账本（`expectations`）+ 回执状态，组装略复杂；排队在第二个开闸的 trigger |
| `working_to_completed` | false | ❌ 不响应（record 已足够） | 信息性事件，无可证明需要动作的缺口；未来或配「归档/清理」类（move-to-trash 模式，另案） |
| `needs_user` | false | ❌ **永远交人** | 该 trigger 的语义就是「系统声明需要人」——用它触发代用户做决定是语义自反 |
| `needs_global` | —（恒不产出） | ❌ 永远交人 | record-only 常量（:156）；升级 global master = 派活类，受 §1.4 约束 |
| `risk_high` | —（恒不产出） | ❌ 永远交人 | 风险语义下动手 = 与判据反向 |
| `deadline_urgency` | **true** | ❌ 不响应 | timer overdue ≠ 真实 deadline（近似标志已验证 :345）；紧迫只证成「呈现」，不证成「动手」 |
| `blocked_to_ready` | **true** | ❌ 不响应 | gate 迁移近似（:337）；且「解除阻塞」的动作本体是派活类 |
| `ws_mail_backlog` | false | ❌ 不消费、不派活；仅计数/呈现 | 红线：不消费/ack 他人 mailbox；信可能含需人裁决的指令；到信的处置已由 legacy 唤醒链承担（用户配置的既有行为，acted=false 语义，§1.4 防火墙） |

**TRIGGER_ALLOWLIST(v1) = {working_to_failed, stagnation} × ACTION_CLASS_ALLOWLIST(v1) = {diagnostic-report}**。其余一律 HUMAN/record-only。

---

## 5. 分期实施概览（详见计划文档）

- **P1（最小可回滚动作）**：只开 diagnostic-report 一类（写自有 namespace 报告），但**事务/账本/熔断/回退全套齐装**——在最低风险效应面上把 harness 磨熟。验收含自动化回退演练（seed→act→undo→逐字节比对）+ 特性级 `git revert` 演练。
- **P2（派活，无隔离路线）**：**〔D4 裁定 2026-10-01〕**原「受强制隔离的派活」及「隔离机制拍板 + 对抗演练（故意写宿主/改共享 git/试 push 必须被拦）」前置**作废**——用户否决隔离路线；改为 **§6.3 无隔离许可检查表**（四条派活许可 + 派活前 C0–C5 / 派活后 P1–P5 检查表）+ 违规演练（故意越界写/删除 ⇒ 必须触发熔断，取代原「机制必须被拦」对抗演练）。只读调研任务域保留；产物带回走人门。
- **P3（受限写文件 + 私有 git commit + 回放工具）**：效应面扩到「显式授权路径集」与「专属 worktree 私有分支」，条件见 §1.3。
- **重启 worker：全阶段不做**（需进程态检查点基建，本仓无先例；列为长期研究项）。

---

## 6. 咨询结论逐条回应 + 需用户拍板项

### 6.1 对 gpt-6-sol 四节的逐条回应

**§1 派活许可** —— **采纳核心结论**：只有「受强制隔离的派活」可授权；(a) 单独不成立（任务描述非权限边界）、(b)(d) 只能作检测/补救——三条论证全部同意且与本仓事实互证（`runner-argv.ts:20-27` 的工具排除机制恰是「prompt 不可信」的仓内证据）。其伪代码（enabled/kill/owner/lease → allowlist → sandbox_proven → baseline/rollback/postcheck → limits/audit → 执行+终态验证）与 §1.2 决策树同构，采纳并**收紧两处**：① `sandbox_proven` 必须给出**机制**而非配置清单（对抗演练证明拦截，见 P2 验收）；② 终态 `verification_unknown` 从 FREEZE_AND_HUMAN 细化为「立即熔断五类事件」（§2），杜绝「unknown 但继续」的灰色路径。**补充其未覆盖的一点**：legacy 唤醒链本身已是免隔离派活路径（§1.4 防火墙）——consultant 只说「不能当隔离执行器」，未要求做结构性分离，本设计补上。

**§2 三件套判据** —— **全盘采纳**「必要不充分 + 副作用封闭 + 独占/并发控制 + 回退失败停机路径」四补充，已并入 §1.1/§1.2。四动作判定表结论一致（派活仅隔离后可、重启默认不、写文件/git commit 有条件）。**新增两条**consultant 未提：TOCTOU 最后入口复核（承接 approval-gate 方案）、未知即拒绝的显式化（区别于 kill 容忍读）。其「待用户拍板：现状是否含 token/成本/审计留痕」转记为 D1。

**§3 熔断值** —— **采纳全部数值**（1/tick、全局在途 1、1h 2、同类连败 2 停、立即停五类、10min/20k、1h 40k、按启动尝试计数、持久化失败即拒绝、kill 联动含回退验证后才 clear）。**三处修正**：① 阶段一无 tab/LLM 调用，token 预算不 binding——替换为读取字节/墙钟上限（§2 表）；② 「立即通知人」v1 限定本地通道（外发通知自身不可回滚，鸡生蛋问题，consultant 未处理）；③ 其「kill 文件不能当安全执行门」的论证与仓内事实完全一致（`kill-switch.ts:30` 容忍读、`gate.ts:117-125` fail-open），采纳为独立 fail-closed breaker 的立论。

**§4 trigger 最小集** —— **采纳**：首版只给 `working_to_failed` + `stagnation` 窄许可；`needs_user` 永远交人；`ws_mail_backlog` 仅计数；两个 approximate trigger 不动手。**修正一处**：consultant 只列六类，遗漏 `expected_event_timeout`（approx:false、账本已生产化）——本设计把它排为阶段二诊断类的第二成员；`working_to_completed`/`needs_global`/`risk_high` 的处置由本表（§4）补全为十规则全覆盖。其「现状差距」段（gate 只放行、审计恒 acted=false、legacy 路径 claim 信、唤醒 tab 用当前 cwd）与 searcher 事实一致，采纳。

### 6.2 需用户拍板项（已裁定）

> 用户裁定原话（逐字，2026-10-01）：「肯定不能容器。不用隔离，git 版本管理做好，文件夹分好，不删除原有文件就行」

| # | 问题（原文保留作上下文） | 原建议 | 用户裁定 |
|---|---|---|---|
| **D1** | **「现状」的定义**：可恢复状态域是否排除 token/时间成本、审计与动作账本留痕、本地通知/GUI 呈现、（阶段二）沙箱内即弃产物？ | 建议排除 | **已裁定：排除**——token/时间成本、审计与动作账本留痕、本地通知/GUI 呈现、沙箱即弃产物，列为**显式不可回退例外** |
| **D2** | P1 动作类确认：仅 diagnostic-report（自有 namespace 报告）+ 全套事务/熔断/回退，是否批准开做 | 建议批准 | **已裁定：批准 P1** |
| **D3** | legacy 唤醒链 passthrough 仍 spawn 当前 cwd 的 tab（既有行为，acted=false）：保持现状（本设计范围外）还是 actions 启用后要求其也隔离？ | 建议 v1 保持现状 | **已裁定：v1 保持现状**（legacy 唤醒链 passthrough 不变） |
| **D4** | 阶段二隔离机制选型（Windows）：容器（Docker/WSL2，网络 none + 只读 bind）/ 受限 token + 只读 ACL / VM | 建议容器优先 | **用户否决「隔离」路线**（不用容器/ACL/VM）；新可回滚判据 = 「git 版本管理做好 + 文件夹分好 + 不删除原有文件」（原文：「肯定不能容器。不用隔离，git 版本管理做好，文件夹分好，不删除原有文件就行」）⇒ 展开见 **§6.3** |
| **D5** | 通知通道：v1 仅本地（外发微信等 = 不可回滚动作）是否接受 | 建议接受 | **已裁定：接受 v1 通知仅本地** |
| **D6** | §2 试运行数值（1/1/2、连败 2、20k/10min、40k/h）是否按此首版固化 | 建议按此固化 | **已裁定：固化试运行数值**——1/tick、在途 1、1h≤2、连败 2 停、20k/10min、40k/h |
| **D7** | 前置卫生任务是否顺带做：`server.ts:29` 头注漂移修正（「mailbox 命令信不消费」已过时）；`concl` 类型收窄为 7 值字面量联合 | 建议做 | **已裁定：做前置卫生**（D7-a server.ts 头注 + D7-b concl 收窄，本批已完成） |

### 6.3 D4 简化后的许可判据：git 纪律 + 文件夹边界 + 只增不删

> 本节是「派活」许可模型的**现时权威**：取代 §1.4 (c) 隔离路线与 consultant 的 `sandbox_proven` 判据（衔接标注见 §1.2/§1.3/§1.4/§5/风险 1）。

**三条工程纪律**（用户裁定原话：「git 版本管理做好，文件夹分好，不删除原有文件」）：

1. **git 版本管理做好**——动作产生的改动必须能通过 git 回退；
2. **文件夹分好**——改动落在明确、可辨识的位置（不散落、不越界）；
3. **不删除原有文件**——只增不删（新增文件/新增段落；删除 = DENY，或必须有人批）。

**由此推出的硬要求（须实现）**：

- **动作前工作区干净**：动作执行前目标工作区必须干净（`git status --porcelain` 为空），或动作前先 commit 快照；
- **动作后必须 commit**：动作执行后必须 commit——未 commit 的改动不在 git 里 ⇒ 不可回退，直接违反用户唯一硬边界；
- **本仓教训**：agent 曾连续 3 次「报告完成但未 commit」⇒ autonomy 必须**比人更严格**（commit 不是 best-effort，是动作的强制关口）；
- **「不删除原有文件」须可执行检测**：回退句柄必须包含「本次动作删除了哪些文件」清单（应为空；非空即违规 ⇒ 熔断 + 冻结 + 通知人）；
- **「文件夹分好」落到动作类 namespace 声明**：每类动作声明允许写的目录前缀，越界 = DENY（fail-closed）。

**阶段二改写**（取代原文「受强制隔离的派活」表述）：

- 不再需要环境层隔离证明：`sandbox_proven` 判据**移除**（取代 §1.2 第 0/2 层中的 sandbox 引用与 §1.4 (c) 的地位——(c) 被本裁定取代）；
- 派活许可改为**四条**：
  1. **目标工作区干净**（porcelain 为空，或已先 commit 快照）；
  2. **任务描述限定目录**（不改无关键：任务描述必须显式含目标目录清单，改动只落在清单内）；
  3. **派活后必须 commit 或 revert**（留痕：动作改动要么成 commit，要么回滚到基线 HEAD）；
  4. **事后发现越界/删除 ⇒ 熔断**（立即停 + 冻结 + 本地通知，不继续跑）。

#### 无隔离前提下「派活」的完整许可检查表 + 回退演练

**派活前许可检查表**（逐项可执行；fail-closed——任一项 unknown/读失败 ⇒ DENY，不做「存疑放行」）：

| # | 检查项 | 可执行判定 | 不满足处置 |
|---|---|---|---|
| C0 | 总门（开关/kill/熔断/预算/owner/白名单） | §1.2 决策树 L0–L3（全部 fail-closed 读） | DENY（动作账本记 reason） |
| C1 | 目标工作区干净 | `git -C <目标仓> status --porcelain` 输出为空（命令失败/非 git 仓/状态未知 = unknown） | DENY；或先做 C4 快照 commit 后复查 |
| C2 | 任务描述限定目录 | 任务描述文本必须显式含目标目录清单：可解析、每项为仓根下合法相对路径前缀、无通配、无 `..` 越级 | DENY |
| C3 | 目录 ⊆ 动作类 namespace 声明 | 任务目录清单 ⊆ 该动作类声明的「允许写目录前缀」之并集（动作类注册处声明；未声明 = 空集） | DENY（fail-closed） |
| C4 | 派活前快照 commit | 记录基线 HEAD（H0，short SHA）；工作区不干净时先 commit `autonomy-snapshot:<action-id>`（快照 commit 本身受「只增不删」约束：不得含 D 条目） | 失败 ⇒ DENY |
| C5 | 无待提交删除 | porcelain 中无 `D ` 条目（未提交的删除） | DENY |

**派活后生命周期检查**（运行中/结束后；任一项违规 ⇒ 立即停 + 冻结 + 本地通知）：

| # | 检查项 | 可执行判定 | 违规处置 |
|---|---|---|---|
| P1 | 预算 | 20k tokens 或 10 分钟，先到即停（D6 固化）；全局 1h 40k | 停止在途任务 |
| P2 | 越界核查 | 结束后工作区 diff 的全部新增/修改路径 ⊆ C2∩C3 目录集 | 熔断 + 冻结 + 通知（越界清单落动作账本） |
| P3 | 删除清单核查 | diff 中删除集（D 状态）= ∅ | 熔断 + 冻结 + 通知人（「不删除原有文件」违规） |
| P4 | commit 或 revert | 动作改动全部已 commit（`autonomy-<class>: <intent>`）或已 revert 回基线 H0 | 未 commit 改动 = 不可回退 ⇒ 熔断 |
| P5 | 回退句柄闭合 | 回退句柄 = (H0, 动作 commit SHA, 删除清单(应为空), 越界清单(应为空)) 已入动作账本 | 句柄缺失 ⇒ 按不可回退处置 ⇒ 熔断 |

**回退演练（必须可跑，全绿才可合入）**：

1. **基线**：记录 H0（派活前 clean HEAD）与 porcelain 空指纹；
2. **正向**：执行一次真实派活动作 → 断言：工作区 clean（porcelain 空）**且** HEAD = H1（H1 含本动作全部改动、commit 信息符合 P4 格式）；
3. **回退**：`git reset --hard H0`（回退句柄）→ 断言：porcelain 空、HEAD = H0、untracked 清单与动作前基线一致（untracked 亦入账本、逐项清理）；
4. **违规演练**：故意让样本任务 ① 写 C2∩C3 集之外的路径 ② 删除一个原有文件 ⇒ 断言：P2/P3 均触发、breaker tripped、frozen、本地通知行在、越界/删除清单如实落动作账本；
5. **特性级**：`git revert <派活特性 commit>`（单 commit 纪律）→ 测试套件回到特性前基线全绿。

**断言核心（演练通过口径）**：动作后工作区**要么 clean（已 commit）要么有可 revert 的 commit**——不存在第三种状态；任何「工作区留有未 commit 改动」即为违规。

## 风险（设计层）

1. ~~隔离机制在 Windows 的可行性未证~~ → **〔D4 裁定（2026-10-01）消除〕**：隔离路线被用户否决，「隔离可行性」风险不复存在；**转为新判据的执行纪律风险**——「git 版本管理做好 / 文件夹分好 / 不删除原有文件」不再由环境机制保证，而靠**检查表机械执行**：若 C1–C5 或 P2–P5 任一项漏检/放宽、或 commit 强制关口被绕过，即直接出现不可回退改动。缓解：全部检查项 fail-closed（unknown = DENY）、违规演练作为合入前置（§6.3）、动作账本如实记录越界/删除清单、连败 2 停 + 立即熔断五类不变。
2. **快照域漂移**：未来给动作类加效应面时若漏枚举（如新文件格式带外部副作用），封闭性证明失效——缓解：每动作类注册效应面时必须同时注册 postverify 与 rollback 的同一清单（单一事实源）。
3. **账本/快照体积**：动作频繁时快照与 actions.jsonl 增长——缓解：轮转从第一天有（§3.1）、自有 namespace 内快照按 id 目录隔离可整目录删。
4. **「可回滚」的心理安全感错配**：账本会诚实记录 rollback_failed/frozen——文档与 GUI 文案不得宣称「一定能撤」，只能宣称「不能撤时会冻结并留痕」（学术诚实，与 v2「不执行任何自动动作」文案同纪律）。
