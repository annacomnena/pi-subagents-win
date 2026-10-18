# G1-1 实现规格（执行链接通三处断点）— 给 implementer

> 权威任务书：`plans/20261018_group1_task_brief.md`
> 独立审查依据：`plans/20261018_glm_review_autonomy.md`（C/E 两节）
> 基线：`6dc1821`（`git log --oneline -3` 已核对；工作树有其他任务的未提交改动，**不得把它们混进本 commit**）
> 本文件由主会话（G1-1 tab）在勘察后写定，实现者按此执行，**不得重新调研、不得扩大范围**。

## 0. 已核实的事实（勘察结论，可作为依据）

| # | 事实 | 位置 | 校准 |
|---|------|------|------|
| F1 | `runAutonomyActions` 双层合取：`cfg.enabled !== true \|\| cfg.actions?.enabled !== true` ⇒ 零行为 | `extensions/runtime/autonomy/action/run.ts:90` | ✅ 已读源码 |
| F2 | 生产 `config.json` 的 `autonomy` = `{"enabled": true}`，**无 `actions`**；顶层 10 键，顺序 `models, fallbackModels, thinking, notifications, searcherMode, liteMode, masterSuccession, gui, channels, autonomy` | `config.json`（`python -c` 实测） | ✅ 实测 |
| F3 | `buildScopeWakePrompt(scope, letters, repoCwd)` 三参、无监管块；调用点仅 `scope.ts:392` | `extensions/runtime/scope.ts:432` / `:392` | ✅ 已读源码 |
| F4 | `deriveSupervisionItems` / `buildSupervisionBlock` 均为 wake.ts **模块私有**，`WakeSupervisionItem` 已导出 | `extensions/runtime/wake.ts:240` / `:393` / `:373` | ✅ |
| F5 | `deriveSupervisionItems` 消费 `listOpenSupervisionEntries`（全机账本，**无 repo 过滤**） | `wake.ts:242` | ✅ |
| F6 | scope wake 的 spawn 执行者是**一次性 tab**（`spawnOneShotTab` 带 `tabRunId`）⇒ `getTabRunId()` 为真 | `extensions/index.ts:2642` 区块 / `mailbox-consumer.ts` tick | ✅ |
| F7 | `supervise-push` 身份门：子 agent 拒绝 **且 `getTabRunId()` 存在即拒绝**（"标签页会话不得推动"） | `extensions/supervision-runtime.ts` execute 内前两行 | ✅ 见任务 §3 |
| F8 | `stagnation = supervision.state === "STALLED"`（P0 定稿，**禁止改动**） | `extensions/runtime/autonomy/frontier.ts:398` | ✅ |
| F9 | `TRIGGER_CLASS_MAP` 现 4 条；测试断言 `TRIGGER_ALLOWLIST.size === 4` | `action/policy.ts:30` / `_test_runtime_autonomy_actions.ts:847` | ✅ |
| F10 | 通知信 subject = `autonomy-notify/<rule>`、`kind: REPORT`、无 `details.status` ⇒ `isReportShape` 为假 ⇒ scope wake 认领（链路可达） | `action/classes/notify.ts` / `scope.ts:253,266` | ✅ |

**基线读数（本人 2026-10-18 实测）**：`_test_runtime_supervision_push` 71 ✓、`_test_tab_report_fallback` 37 ✓、
`_test_runtime_autonomy` 66 ✓、`test:autonomy-actions` 87 ✓、`_test_model_retry` 8 ✓、
**既有红**：`_test_frontier_attention_window` 2 failed / `_test_graph_carriers` 失败（**不得修**）。

---

## 1. 改动 ①：`config.json` 开 `autonomy.actions.enabled`（严格遵守 AGENTS R-1）

**禁止**整文件重写、禁止 `write` 工具覆盖、禁止顺手整理格式/键序。

```bash
cd <repo>
cp config.json config.json.bak-actions-$(date +%Y%m%dT%H%M%S)
python -c "import json;d=json.load(open('config.json',encoding='utf-8'));print(len(d),list(d));print(d.get('autonomy'))"   # 改前基线
python - <<'PY'
import json
p = 'config.json'
d = json.load(open(p, encoding='utf-8'))
assert isinstance(d, dict) and 'autonomy' in d
aut = d['autonomy']
assert isinstance(aut, dict)
aut['actions'] = {'enabled': True}          # 只加这一个键，不动 autonomy.enabled、不动任何其他顶层键
with open(p, 'w', encoding='utf-8', newline='\n') as f:
    json.dump(d, f, indent=2, ensure_ascii=False)
    f.write('\n')
PY
python -c "import json;d=json.load(open('config.json',encoding='utf-8'));print(len(d),list(d));print(d['autonomy'])"
```

核对清单（报告必须贴前后两份输出原文）：
- 顶层键数量 **10 → 10**，键序**逐字相同**；
- `autonomy` 改后 = `{'enabled': True, 'actions': {'enabled': True}}`；
- 备份文件存在，路径写进报告。
- `config.json` 在 `.gitignore` 中 ⇒ **不进 commit**，必须在报告与 e2e proof 里写清"这是运行态配置改动"。

**不要**改 `config.example.json`（工作树里它已有其他任务未提交的改动，混入即污染）。

## 2. 改动 ②：`buildScopeWakePrompt` 加第四参 `supervision?`（复用，不重复实现）

### 2.1 `extensions/runtime/wake.ts`
1. `export function deriveSupervisionItems(...)` —— 仅加 `export`。
2. 新增可选过滤参数：`opts.repoPath?: string | null`。语义：给出时**只保留该仓的条目**。
   - 归一比较（本地小函数，勿引新依赖）：`s.replace(/\\/g,"/").replace(/\/+$/,"").toLowerCase()`；
   - 命中判据：`norm(cand) === norm(filter) || norm(cand).startsWith(norm(filter) + "/")`（覆盖 dispatch.cwd 在子目录的情形）；
   - `cand` 取 `dispatch?.cwd ?? entry.repoPath ?? ""`（与 `repoPath` 字段同源）；
   - 过滤后为空 ⇒ 返回 `undefined`（保持"无监管 ⇒ 逐字节不变"）；
   - 整段仍在既有 `try/catch` 里（never-throw 不变）。
3. `export function buildSupervisionBlock(...)` —— 仅加 `export`，**渲染逻辑一字不改**（wake 路与 scope 路必须同源）。
4. `buildWakePrompt` 的调用形状与输出**零变化**（不改它的第三参语义）。

### 2.2 `extensions/runtime/scope.ts`
1. import 追加：`deriveSupervisionItems, buildSupervisionBlock, type WakeSupervisionItem`（与既有 wake.ts import 合并在同一 import 块）。
2. 签名改为：
   ```ts
   export function buildScopeWakePrompt(
       scope: string,
       letters: WakeLetter[],
       repoCwd: string | null,
       supervision?: WakeSupervisionItem[],
   ): string
   ```
3. 组装：`const supervisionBlock = Array.isArray(supervision) && supervision.length > 0 ? buildSupervisionBlock(supervision) : [];`
   插入位置与 `buildWakePrompt` 保持一致 ⇒ 放在 **`待处理输入` 行之后、`replyBlock` 之前**：
   `...shown.map(...) , ...supervisionBlock, ...replyBlock, `规则：…``。
4. `evaluateScopeWake`（`scope.ts:355`）在 fire 分支派生并传入：
   ```ts
   const supervision = deriveSupervisionItems({ stateDir: opts.stateDir, runsDir: opts.runsDir ?? defaultTabRunsDir(), now, repoPath: repoCwd });
   return { scope: opts.scope, fire: true, letters, prompt: buildScopeWakePrompt(opts.scope, letters, repoCwd, supervision), repoCwd };
   ```
   `defaultTabRunsDir` 若未 import 则从 `../tab-runs.ts` 引入（`wake.ts:240` 同源写法）；`repoCwd` 为 `null` 时不传 `repoPath`（= 不过滤）。
   **注意**：`deriveSupervisionItems` 必须**放在 claim 成功之后**（不影响 `claim-missed`/`no-mail` 早退路径的零 IO 语义）。

### 2.3 硬要求（测试会钉死）
- `buildScopeWakePrompt(s, l, c)` 三参、四参且 `undefined`、四参且 `[]` ⇒ **三者逐字节相同**（用**手写冻结字面量**断言，不许"调两次比两次"）。
- 账本有本仓条目 ⇒ prompt 含 `停滞监管`、`runId`、`supervise-push`。
- 账本只有**他仓**条目 ⇒ 本仓 prompt **不含**监管块（过滤生效）。

## 3. 改动 ③：新增独立 trigger `blocked_overdue`（**不改 `stagnation`**）

### 3.1 `extensions/runtime/autonomy/frontier.ts`（纯函数层，零 IO，禁止 import node:fs）
1. `FrontierRule` 联合类型 + 一条：
   ```ts
   | "blocked_overdue" // BLOCKED_USER ∧ idle > userMs（超龄无人处理：周期提醒，节流 ≤1 次/小时/runId）
   ```
2. `FrontierTrigger` 增可选字段（与 `requestId` 同风格文档）：
   ```ts
   /** blocked_overdue：逾期最重的 runId（节流键；其余规则缺省）。 */
   runId?: string;
   ```
3. `ProjectFrontier` 增三字段（**都带文档注释**）：
   ```ts
   /** ③ 载体：存在「监管账本 active ∧ 派生 BLOCKED_USER ∧ idleMs > userMs」的 tab。 */
   blockedOverdue: boolean;
   /** blocked_overdue 的节流键（上一帧已提醒的 runId；无则缺省）。 */
   blockedOverdueRunId?: string;
   /** blocked_overdue 上次提醒时刻（epoch ms；节流窗 1h）。 */
   blockedOverdueLastAt?: number;
   ```
4. `aggregateProject`（`frontier.ts:354`）：在既有 `for (const t of tabs)` 循环（`:390` 附近，和 `deriveTabSupervisionState` 同一处）里同时累计：
   - 先算 `const userMs = typeof ledger?.userMs === "number" && Number.isFinite(ledger.userMs) && ledger.userMs > 0 ? ledger.userMs : SUPERVISION_THRESHOLDS.userMs;`
   - 命中判据（**必须复用六态派生结果，不许自己重写判据**）：
     `st === "BLOCKED_USER" && typeof t.idleMs === "number" && Number.isFinite(t.idleMs) && t.idleMs > userMs`
   - 记 `blockedOverdue = true` 且按 `idleMs` 取**最大**的那个 tab 的 `runId` 作为 `blockedOverdueRunId`。
   - `stagnation` 一行（`:398`）**逐字不动**。
5. 返回对象（`:402`）追加 `blockedOverdue` / `blockedOverdueRunId`（`blockedOverdueLastAt` 在 buildFrontier 里算，见下）。
6. `buildFrontier` 触发发射（在 `if (!baseline)` 块内、`stagnation` 边沿附近，`:523` 之后）：
   ```ts
   // ⑨b blocked_overdue（level + 1h/runId 节流；基线帧同样压制）
   if (cur.blockedOverdue && cur.blockedOverdueRunId) {
       const prevSameRun = pv.blockedOverdue === true && pv.blockedOverdueRunId === cur.blockedOverdueRunId;
       const lastAt = prevSameRun && typeof pv.blockedOverdueLastAt === "number" ? pv.blockedOverdueLastAt : null;
       if (lastAt === null || now - lastAt >= BLOCKED_OVERDUE_THROTTLE_MS) {
           triggers.push({
               rule: "blocked_overdue",
               project: key,
               evidence: `blocked_overdue:run=${cur.blockedOverdueRunId}:idleMin=${...}`,
               approximate: false,
               runId: cur.blockedOverdueRunId,
           });
           emittedBlockedOverdue = true;
       }
   }
   ```
   并在 `projects` 组装循环里把 throttle 状态落到 `next`：
   - 本帧发射 ⇒ `blockedOverdueLastAt = now`；
   - 本帧 blockedOverdue 但未发射 ⇒ 沿用 `pv.blockedOverdueLastAt`（若无则置 `now`，避免下帧立刻再发）；
   - 本帧未 blockedOverdue ⇒ 两个字段都不写（缺省）。
   - 新增模块常量 `export const BLOCKED_OVERDUE_THROTTLE_MS = 3_600_000;`（1h；注释说明"≤1 次/小时/runId，沿用 push 预算纪律"）。
   - **语义登记注释**：若 frontier.json 被删 ⇒ 节流状态丢失 ⇒ 最多多提醒一次（"宁可重发不可漏发"同 R-5 方向），显式写在注释里。
7. 不要去改 `meaningfulStateVersion` 的 bump 规则（`blocked_overdue` 属非 `expected_event_timeout` ⇒ 自然计入 bump，行为与 `stagnation` 同类，无需特殊处理）。

### 3.2 `extensions/runtime/autonomy/action/policy.ts`
```ts
blocked_overdue: ["notify-local-master"],   // 只提醒，**不映射 diagnostic-report**（避免噪音）
```
并更新文件头映射表注释（加一行说明 blocked_overdue 语义 + 为何只 notify）。

### 3.3 不改的东西（硬约束）
- `stagnation` 判据/边沿一行不改。
- `supervision-runtime.ts` 的门 4b 不改。
- `tab-runs-runtime.ts` 的 unconfirmed 桶不改。
- `watchdog.ts`、`wake-gate.ts` 的 bypass 表不动（blocked_overdue 走 ordinary）。

## 4. 测试（三处各一条新断言组 + 变异可红）

### 4.1 `extensions/_test_runtime_autonomy.ts`（纯函数层，必须零 IO）
- `TRIGGER_ALLOWLIST.size` 断言在 **actions** 测试里，改成 5。
- 新增 SUP-B 组：
  - **B1**：`buildFrontier` 两帧，账本 `{runId, status:"active", epochPushes:0}`，tab `phase:"waiting", stop:"error", idleMs: 31*60_000` ⇒ 帧2 `diff.triggers` 含 `{rule:"blocked_overdue", runId, project: K}`，且 `next.projects[0].blockedOverdue === true`。
  - **B2**：同上但 `idleMs: 29*60_000` ⇒ 无 `blocked_overdue` 触发、`blockedOverdue === false`。
  - **B3 节流**：帧2（t0）发射；帧3 `t0+5min` 不发射（diff 无该规则）；帧4 `t0+61min` 再发射。
  - **B4 不越界**：同一帧 `stagnation` 语义不变 —— `BLOCKED_USER` 的项目 `stagnation === false`；`STALLED` 的项目仍发 `stagnation` 且 `blockedOverdue === false`。
  - **B5 静默优先**：账本 `status:"paused"` 或 `optOut:true` + idle 2h ⇒ 无 `blocked_overdue`。
  - **B6 无账本**：NOT_MONITORED 项目 ⇒ 无 `blocked_overdue`（不猜）。

### 4.2 `extensions/_test_runtime_autonomy_actions.ts`（动作面真实接线）
- 更新 `TRIGGER_ALLOWLIST.size` 4 → 5，并加注释说明扩容来源。
- 新增 check（验证 B）：
  - 构造 frontier 快照 `triggers: [{rule:"blocked_overdue", project: NT_PROJECT, evidence:"...", approximate:false, runId:"r1"}]`；
  - `runAutonomyActions` + `cfgOn` + scope owner 在位 ⇒ `actions.jsonl` 出现 `actionClass==="notify-local-master"` 且 `kind==="executed"`，且**无** `diagnostic-report` 事件（只 notify）；
  - 对照：`cfgOff`（无 `actions` 键）⇒ **零新文件、零事件**（默认关闭零行为不回归）；
  - 再一 tick（+60s）⇒ `skipped(reason==="cooldown")`（沿用 1h 去重，不刷屏）。

### 4.3 `extensions/_test_runtime_supervision_push.ts`（scope 路真实入口）
- 新增第 11 组「scope wake prompt 监管块」：
  - 手写冻结字面量 `SCOPE_FROZEN`（照 `buildScopeWakePrompt` 现有行序/标点写死，3 参调用）；
  - `buildScopeWakePrompt(s, L, c)` === `SCOPE_FROZEN`；四参 `undefined` / `[]` 亦 === `SCOPE_FROZEN`；
  - 真账本：`writeSupervisionEntry`（本仓 tab 账本 + `stop=error`，使其进 `deriveSupervisionItems`）⇒ prompt 含 `停滞监管`、`runId`、`supervise-push`；
  - 他仓账本条目 ⇒ prompt 不含 `停滞监管`（repo 过滤）。
- 新增第 12 组「端到端到执行者之前」（**必须走真实入口**，AGENTS R-4）：
  1. `setCutover(true)` + scope owner attach（复用文件内既有 helper）；
  2. `buildFrontier`（用 4.1 的 fixture 形状）产出 `blocked_overdue` → `writeFrontierSnapshot`；
  3. `runAutonomyActions` ⇒ 断言 scope mailbox 里真出现 `msg_autonomy*.json`（`existsSync` + 读回 subject `autonomy-notify/blocked_overdue`）；
  4. `evaluateScopeWake({ sessionId: ownerSid, scope })` ⇒ `fire === true` 且 `prompt` 含 `supervise-push` 与目标 `runId`。
  - 该组**不要**断言 `supervise-push` 被调用成功（见 §5 断点 #4）。

### 4.4 全套回归（报告必须贴原始输出尾部）
```
node --experimental-strip-types --import ./extensions/runtime-host/pi-deps-loader.mjs ./extensions/_test_runtime_autonomy.ts
npx tsx extensions/_test_runtime_autonomy_actions.ts
npx tsx extensions/_test_runtime_supervision_push.ts
node --experimental-strip-types --import ./extensions/runtime-host/pi-deps-loader.mjs ./extensions/_test_tab_report_fallback.ts
node --experimental-strip-types --import ./extensions/runtime-host/pi-deps-loader.mjs ./extensions/_test_model_retry.ts
node --experimental-strip-types --import ./extensions/runtime-host/pi-deps-loader.mjs ./extensions/_test_local_master.ts     # scope.ts 改动后必须回归
```
既有红（**如实记录、不得修**）：
```
node ... ./extensions/_test_frontier_attention_window.ts     # 期望 FAILED (2 failed)
node ... ./extensions/_test_graph_carriers.ts                # 期望失败
```
若 `_test_graph_carriers` 的失败信息因新增 `ProjectFrontier` 字段而**形状变化**（例如 deepEqual 多出字段名），必须在报告里**逐字贴出改前/改后失败信息**，并说明"是否仍属既有红"。若新增字段导致**新的** carrier 断言失败 → 说明 `ProjectFrontier` 字段进了 carrier 投影，需检查 `extensions/runtime/frontier-carriers.ts` / `graph/frontier-input.ts` 是否有**显式字段白名单**：有白名单则不需动（新字段本就不进投影，如实记录）；若是全量 spread 导致新字段进投影，**停下来报告**，不要自行改投影契约。

## 5. 变异验证（三处各一次，必须自己做，byte-level 还原 + sha256 前后值）

| 变异 | 操作 | 必须实红的测试 |
|---|---|---|
| ① 动作面开关接线 | ①a 把 `config.json` 的 `autonomy.actions` 键临时删除（然后按 §1 恢复，贴 sha256 前后）；①b 把 `action/run.ts:90` 的合取改成只判 `cfg.enabled !== true` | ①a：`readAutonomyConfig` 对**生产 config** 的 `actions.enabled` 从 true 变 false（贴命令输出）；①b：`_test_runtime_autonomy_actions` 的「默认关闭零行为」组实红 |
| ② scope 监管块 | `evaluateScopeWake` 里把第 4 参改成不传（`buildScopeWakePrompt(opts.scope, letters, repoCwd)`） | 4.3 第 11/12 组实红（prompt 不含 `停滞监管` / `supervise-push`） |
| ③ blocked_overdue | 把 `aggregateProject` 里 `blockedOverdue` 恒置 `false` | 4.1 的 B1/B3 实红 |

每处变异都要：改 → 跑测试贴红 → 还原 → `sha256sum` 前后一致 → 再跑一次贴绿。报告里给 `sha256` 前后值。

## 6. 交付物

1. `plans/20261018_group1_impl.md`：三处改动（文件:行 + 为什么）、每条新测试的行号、config 前后对比原文、测试与变异输出摘要、未闭合项。
2. `plans/20261018_group1_e2e_proof.md`：**核心交付**。逐步 `file:line`：
   - 步骤 1 tick 检测（`mailbox-consumer.ts` wake tick → `wake.ts:evaluateWakes` → `gate.ts:evaluateAutonomyWakeGate` → `collect.ts:collectAutonomyInputs` → `frontier.ts:buildFrontier` 产出 `blocked_overdue`）；
   - 步骤 2 动作面（`wake.ts:runAutonomyActions` 调用点 → `action/run.ts` 双层合取 → `policy.ts` 映射 → `classes/notify.ts` 投递）；
   - 步骤 3 执行者被拉起（`scope.ts:evaluateScopeWake` → `buildScopeWakePrompt`（含监管块）→ `mailbox-consumer.ts` scope tick → `index.ts:spawnOneShotTab`）；
   - 步骤 4 执行者调 `supervise-push`（`supervision-runtime.ts` 七门 → steer 落盘）——**并如实写清"仍有断点 #4：`supervise-push` 拒绝标签页身份"，给出 `file:line` 证据与两个候选修法（本次不实现，交主会话裁决）**；
   - 结论段必须**逐字回答**："关掉定时器、一个 tab 停了 8 小时、系统会不会自己推它？"——按当前代码给出**分环节的是/否**，不许含糊。
3. 单 commit（**不要 push**，不要 `git add -A`）：
   ```
   git add extensions/runtime/autonomy/frontier.ts extensions/runtime/autonomy/action/policy.ts \
           extensions/runtime/scope.ts extensions/runtime/wake.ts \
           extensions/_test_runtime_autonomy.ts extensions/_test_runtime_autonomy_actions.ts \
           extensions/_test_runtime_supervision_push.ts \
           plans/20261018_group1_impl_spec.md plans/20261018_group1_impl.md plans/20261018_group1_e2e_proof.md
   git commit -m "feat(autonomy): 执行链接通三处断点（actions 开启 / scope wake 监管块 / blocked_overdue 触发）"
   ```
   提交信息正文必须含：**根因 / 改了什么 / 怎么验证 / 未闭合项**（未闭合项至少含断点 #4 与既有基线红）。
   Wiki 页由后续阶段处理，**本 commit 不动 Wiki**。

## 7. 纪律（违反即返工）

- 先 `read AGENTS.md`（R-1 配置纪律、R-4 审查分离、R-11 分母、R-12 时间窗）。
- 不碰 `stagnation` 判据、`supervision-runtime.ts` 门 4b、`tab-runs-runtime.ts` unconfirmed 桶。
- 不修既有基线红。
- 不扩大范围（不改 `config.example.json`、不改 watchdog/wake-gate、不放宽 `supervise-push` 身份门）。
- 一切"已修好"的结论必须带本次实测输出。
