# pi-subagents-win

Windows-native subagent orchestration for [pi](https://github.com/earendil-works/pi-coding-agent): role agents for delegation, visible parallel tabs for long-running work, and a full ultra-long task infrastructure (tab reclaim, auto-push timers, an event bus, and active reporting) on top of it.

**Package:** `subagent-win` · **Repo:** `pi-subagents-win` · **Version:** 0.7.0

---

## 1. Overview

### What it solves

- **Delegate** any step to a role agent (search / plan / review / implement) without leaving your session.
- **Parallelize** independent work with a single tool call.
- **Run hours-long pipelines unattended**: spawn visible tabs, let them report back, auto-advance with timers, reclaim results, launch the next batch.
- **Spend quota you already own**: point role agents at local CLI harnesses (Claude Code / Codex / Agy / AtomCode / ZCode / MimoCode) — subscriptions, free tiers, discounted dedicated-tool billing, and plans that can't be reverse-proxied into an API all become usable as subagent workers (§4).
- **Scale reasoning on hard problems** with trace-fusion (§7): three independent read-only diagnosis rollouts on the same task, auto-collected and fused — the agent can self-trigger it when a problem looks underdetermined.
- **Control it from your phone**: an opt-in WeChat channel — inbound text + image attachments, outbound reply/broadcast, tiered remote slash commands — fail-closed end to end (§10).
- **Observe & steer locally**: a resident runtime daemon + local web console (GUI), default OFF, loopback-only (§8, §14).
- **Manage long-lived "master" sessions**: a gated family of master tools — the agent can never take over / hand off / switch on its own (§9).
- **Let the master watch for you** (optional): an autonomy suite + expectation ledger — default: zero automatic action (§11).

### Architecture

```
                  ┌──────────────────── main session ────────────────────┐
                  │  subagent-win  ·  launch-tabs  ·  tab-status/          │
                  │  reclaim-tabs  ·  set-timer  ·  tab-report listener   │
                  └──────────┬──────────────────────────┬────────────────┘
                             │                          │
              ┌──────────────▼──────────────┐  ┌────────▼─────────────────────┐
              │  subagents (one-shot)        │  │  tabs (visible pi sessions)   │
              │  sync / parallel / async     │  │  /launch → wt.exe new-tab      │
              └──────────────────────────────┘  └───────────────────────────────┘
```

### Subagents vs. Tabs

Both delegate work to a separate pi process, but they are different tools for different jobs:

| | **Subagent** | **Tab** |
|---|---|---|
| Spawned by | `subagent-win` tool | `launch-tabs` tool / `/launch` |
| Process | `pi --mode json` (headless) | `wt.exe new-tab` (visible interactive TUI) |
| Lifetime | One-shot; **dies when the session exits** | Independent; survives main-session restarts |
| Visibility | Invisible to the user | Fully visible, human can type into it |
| Result | Returned inline (sync) or via async `runId` | Ledger + `tab-finish` structured result |
| Reclaim | `{ action: "status", runId }` | `reclaim-tabs` / event bus / `tab-report` |
| Interaction | None (fire and read) | User can steer mid-run |
| Communication | None | Timers in, reports out |
| Best for | Quick delegation inside a turn | Long parallel batches, unattended pipelines |

**Rule of thumb:** if you need the answer this turn, use a subagent. If the work is long, independent, or should survive a restart, use a tab.

### Three execution modes (for subagents)

| Mode | Call shape | Waits? | Use when |
|---|---|---|---|
| **Sync** | `{ agent, task }` | Yes | Result needed immediately for the next step |
| **Parallel** | `{ tasks: [...] }` | Yes, all | Several independent tasks, wait for all |
| **Async** | `{ agent, task, async: true }` | No (returns `runId`) | Long independent work; you continue, poll later |

**Decision rule:** if the result gates the next action → sync/parallel. If you can wait without blocking this turn (minutes-long exploration, batches) → async. When in doubt, async is safe.

---

## 2. Quick Start

```bash
# from a local path
pi install /path/to/pi-subagents-win

# or from git — pi supports npm: / git: / URL / local package sources
pi install git:github.com/annacomnena/pi-subagents-win
```

> **新机器部署 / 升级（2026-10-08 修订，peerDeps 修正）：**
> 1. 备份 zip 不含 `node_modules` —— 新机器/解包后 `npm install` 即可（只装 `usearch` 等真依赖；`@earendil-works/pi-tui`、`typebox`、`@earendil-works/pi-coding-agent` 是 **pi 宿主提供**的包，声明在 `peerDependencies`（`"*"`），进程内由 pi 扩展加载器解析到宿主副本，npm 不再安装实体副本；裸 node 场景（daemon/测试）由自带 resolve hook（`pi-deps-loader.mjs`，测试脚本已统一前置 `--import`）映射到宿主安装。
> 2. 升级后验证（daemon 形态必须带 resolve hook）：`node --experimental-strip-types --import extensions/runtime-host/pi-deps-loader.mjs extensions/runtime-host/server.ts` 起一下看 health（或直接看 `runtimeDir/daemon-stderr.log`）。
> 3. 手工 symlink/junction 指向 pi 内嵌副本 **一律不再需要（已废除）**——测试与 daemon 均走 resolve hook 自举，无需仓内任何宿主包副本；编辑器类型提示如需解析宿主包，可临时建 junction（dev-only，不提交，`npm install` 会剪掉它，届时重建即可）。
> 4. 启动失败先看 `runtimeDir/daemon-stderr.log`（daemon spawn 的 stderr 已落盘；loader 找不到宿主包时也会在这里报清晰错误）。

The package is a pi extension (`pi.extensions` → `./extensions/index.ts`) with a bundled skill (`pi.skills` → `./skills` — the `workflow-orchestrator` skill).

**Runtime requirement:** the WeChat remote-command channel (`/wechat …`, `/reload`, `/model` … sent from WeChat) dispatches its internal `/wechat-remote-run` command via `sendUserMessage(…, { expandPromptTemplates: true })`, which requires a **runtime `pi` ≥ 0.87**. Older runtimes (e.g. the 0.80.x line) hard-code that option to `false`, so the internal command text would fall into the conversation instead of being dispatched. Unit tests are unaffected (they use fakes).

1. Copy `config.example.json` → `config.json` and set models per agent (or run `/sub-models`).
2. Reload pi (`/reload`) or restart.

```ts
// first subagent call
subagent-win({ agent: "searcher", task: "Map this repository read-only." })

// first tab launch
launch-tabs({
  tasks: [{ taskId: "1001", prompt: "根据workflow进行工作1001 …" }],
})
```

---

## 3. Subagents

### 3.1 Single / parallel / async

```ts
// sync — result returned inline
subagent-win({ agent: "searcher", task: "Explain module X." })

// parallel — all independent, wait for all
subagent-win({
  tasks: [
    { agent: "searcher", task: "Explore module A." },
    { agent: "searcher", task: "Explore module B." },
  ],
  concurrency: 3,
})

// async — non-blocking; returns a runId you poll later
subagent-win({ agent: "searcher", task: "Deep-dive module C.", async: true })
// → "Async run started: run_xxx"
subagent-win({ action: "status", runId: "run_xxx" })
```

The async task panel (TUI widget + status bar + completion toast) shows running background jobs; `/runs` lists recent ones.

### 3.2 Consultant — user-named model evaluation

When the user names a model ("请glm来评估一下", "请gpt5.6看看截图"), dispatch `agent: "consultant"` with that model as a per-call `model` override. Short aliases expand from `~/.pi/agent/models.json`. The consultant answers from that model's perspective; screenshot paths go in the `task` (it reads images with `read`).

### 3.3 Timeout semantics — stall, not wall-clock

`timeoutMs` is an **inactivity (stall) timeout**, not a total-run cap:

- **Error** → stop (exit≠0 / `stopReason=error`).
- **Stall** → "an operation is stuck with no output" → stop after `timeoutMs` of silence.
- **Progress** → any stdout/stderr output resets the timer; a healthy long task never gets killed.

A stall is classified as `STALL` (non-retryable) — it does not burn a fallback attempt, because a stuck task won't fix itself on another model.

### 3.4 Failure classification & fallback

Retryable failures (`USAGE_CAP`, `RATE_LIMIT`, `AUTH`, `TIMEOUT`, `PROVIDER`) walk the agent's `fallbackModels` chain. `USAGE_CAP` (e.g. Zhipu/GLM package quota, often a bare 429) surfaces as `[subagent-failure kind=USAGE_CAP]` telling the main agent to switch model via `/model` instead of retrying.

---

## 4. External CLI agents — spend quota you already own (CLI backends)

Every role agent (`searcher` / `planner` / `plan-reviewer` / `implementer` / `code-reviewer` / `consultant`) can be pointed at a **local CLI harness** instead of an API model. The subagent then runs inside Claude Code / Codex CLI / Agy / AtomCode / ZCode / MimoCode and bills against **quota you may already own** — a subscription, a free tier, or a dedicated-tool plan with preferential rates — instead of per-token API credits. Each CLI also brings its own quota pool, so provider outages and rate limits stop being single points of failure.

### Why this matters for your wallet

The point is not "CLIs are cheaper than APIs" — it is that a lot of usable quota is **locked inside CLI tools** and unreachable any other way:

- **Subscriptions you already pay for**: Claude Code / Codex / … flat-rate plans. Agent work bills against quota that is already sunk cost; heavy stages (an `implementer` rewriting 500 lines, a `code-reviewer` reading a whole diff) stop burning per-token API credits.
- **Free tiers**: several CLI tools include free or near-free usage bands that plain API access does not get.
- **Preferential dedicated-tool billing**: e.g. ZCode bills GLM-5.3 inside the tool at a discounted rate/multiplier that raw API calls do not enjoy.
- **Plans that cannot be reverse-proxied**: some subscriptions can neither contractually nor technically be exposed as an OpenAI-compatible API endpoint — the official CLI is the **only** access path. Without the `cli:` backends that quota simply sits stranded; with them, orchestration spends it at zero marginal cost.
- **Budget isolation**: role agents on CLI + main session on API = the experiment loop can run wild without touching your API balance (and vice versa).
- **Quota safety net**: put a CLI in `fallbackModels` — when the API primary hits `USAGE_CAP`/`RATE_LIMIT`, the chain walks into stranded subscription quota instead of stalling (see §3.3).

### Supported backends

| Model ref | Spawns | Notes |
|-----------|--------|--------|
| `cli:claude` | `claude` | stream-json, `--dangerously-skip-permissions`, CLI default model |
| `cli:codex` | `codex exec --json` | stdin prompt, approvals bypassed, CLI default model |
| `cli:agy` | `agy` | plain stdout capture, native `--effort`, CLI default model |
| `cli:atomcode` | `atomcode -y -p <prompt>` | headless, no-approval, CLI default model |
| `cli:zcode` | `node zcode.cjs` | plain stdout capture (-p), GLM-5.3 fixed |
| `cli:mimo` | `mimo run` | JSON event stream, `--dangerously-skip-permissions`, CLI configured/default model |

**Policy:** never pass `--model` to external harnesses; configure models inside each CLI. Refs like `cli:claude/sonnet` are rejected. Backends are used only when an agent's `config.json` default/fallback selects them — do not override an unrelated agent with one. `cli:zcode` is special: it spawns `zcode.cjs` through `node` and always uses the fixed GLM-5.3 configured in `~/.zcode/cli/config.json`. `cli:mimo` (also accepts the alias `cli:mimocode`) runs `mimo run <prompt> --format json --dangerously-skip-permissions --dir <cwd>`; it discovers `MIMOCODE_BIN`, then `%USERPROFILE%\\.mimocode\\bin\\mimo.exe`, then PATH. The current MimoCode installation must be signed in or configured with a usable provider/model; the harness does not supply credentials.

### Wiring it up

Set the CLI ref as an agent's **default or fallback** in `config.json` (or interactively via `/sub-models`):

```json
{
  "models": { "implementer": "cli:agy", "code-reviewer": "openai-codex/gpt-5.6-luna" },
  "fallbackModels": { "consultant": ["cli:codex"], "implementer": ["openai-codex/gpt-5.6-terra", "cli:zcode"] }
}
```

A CLI ref only routes when it sits in that agent's own default/fallback chain — the dispatcher never sends an unrelated agent to a CLI on a whim, and per-call `model:` overrides **cannot select a CLI backend** (passing `cli:x/...` model refs is rejected outright).

### What transfers — and what doesn't

| | API subagent | CLI subagent |
|---|---|---|
| task text, cwd, stall timeout (`timeoutMs`) | ✅ | ✅ |
| failure classification + fallback chain | ✅ | ✅ (a CLI failure walks the chain like any other) |
| per-call `model` override | ✅ | ❌ — the CLI runs **its own configured/default model**; configure models inside each CLI |
| per-call `tools` allowlist | ✅ | ❌ — not supported by external harnesses (explicitly passing it errors) |
| billing | API tokens | the CLI's own plan — subscription, free tier, or discounted dedicated-tool billing |

### Safety

External CLIs are spawned in their no-approval / auto-approve modes (`--dangerously-skip-permissions`, bypassed approvals — see table above), and they execute with full tool access in your repo. **Use them only in trusted repositories**, same policy as the CLIs themselves. For Codex behind a reverse proxy, `/codex-headers` configures per-provider request-header compatibility.

---

## 5. Tabs — visible parallel sessions

### `/launch` and `launch-tabs`

`/launch <request>` is an orchestration request: the current agent analyzes the conversation, identifies independent ready tasks, and calls `launch-tabs` once — opening all tabs in parallel.

```text
/launch 你来并行启动已满足条件的任务
/launch -t <title> <single task>        # explicit single tab
/launch --direct <task>                 # single tab, derived title
```

`launch-tabs` is the explicit workflow launcher: it normalizes every prompt to `根据workflow进行工作<taskId>` (or `根据research/execute/adaptive进行工作<taskId>`) and appends a **workflow discipline block**. A direct `/launch -t` or `/launch --direct` tab remains a plain task by default; a task number alone never enables workflow constraints. Direct tabs receive workflow constraints only when the user explicitly supplies a mode flag or workflow prefix.

Four task modes:

| Mode | Prefix | Pipeline |
|---|---|---|
| `workflow` (default) | `根据workflow进行工作<id>` | search → plan → review → implement → review → Wiki wrap-up |
| `research` | `根据research进行工作<id>` | parallel searchers → research report → Wiki maintenance (no implementation) |
| `execute` | `根据execute进行工作<id>` | skip search/planning → implement → review → Wiki wrap-up |
| `adaptive` | `根据adaptive进行工作<id>` | tab self-assesses handoff completeness at startup → A fast lane (verify ≤3 tool calls → implement → review → Wiki) / B medium (mini plan → quick review → implement → review → Wiki) / C full chain; upgrades allowed & declared, downgrades forbidden |

**lite mode** is not a tab mode — it runs **inside the current session**; the full discipline is in the Lite workflow subsection below.

### Full workflow — the tab chain

A `workflow`/`research`/`execute`/`adaptive` tab is not a lone worker: on startup it reads the bundled `workflow-orchestrator` skill and acts as a **project manager** — it breaks the task into stages and delegates each stage to a **role agent** via `subagent-win` (headless subagents inside the tab):

```text
searcher → planner → plan-reviewer → implementer → code-reviewer → (consultant when stuck)
    └────────── every handoff lands on disk (plans/, Wiki) ──────────┘
```

- **Stage discipline is enforced, not suggested**: the tab may not complete the task in one shot; the searcher maintains Wiki theme pages; findings stay out of Wiki; the reviewer is always an independent process reviewing a `git diff`.
- **Model per role**: each role agent has its own configured default + fallback chain (see §3); per-call overrides only on exhaustion/user request/mismatch.
- **Why a tab**: the chain is long and produces large relay material; a visible tab survives main-session restarts, lets the human steer mid-run, and reclaims results via the event bus.

Use the full chain when the task is heavy, needs role separation, parallel batches, or must survive the session.

### Lite workflow — the in-session chain

`/lite on|auto|off` (persisted as `config.json` `liteMode`; `off` injects nothing). When on, **workflow requests run inside the current session** — no `launch-tabs`, no role agents. Instead a single `general` agent is dispatched per stage, with a **tier model** projected live from your `models` config:

| Stage | Tier | Model from |
|---|---|---|
| L1 search / docs | `small` | `models.searcher` |
| L2 plan / L3 implement | `medium` | `models.implementer` |
| L4 independent review / L5 consult / plan revision | `large` | `models.consultant` |

Chain: **L1 search → L2 plan → L3 implement → L4 review → L5 Wiki wrap-up**. This is the lite mechanism, not a per-call exception — the caller just passes `model=` per dispatch.

Lite discipline (all six enforced):
1. **Sync/parallel only** — async `status` returns a 500-char preview, not enough for handoffs.
2. **Handoffs land on disk** — >30-line artifacts go to plans/ or Wiki; the reply carries the path + ≤10-line summary.
3. **Retrieved facts** still carry code location + Wiki section reference + calibration status.
4. **Searcher dispatch mode** (serial/parallel) applies to L1 unchanged.
5. **L4 is never skipped** — independent `general` process, reviews the `git diff`; never self-review.
6. **Escalation lines** — relay material >~10K tokens, fan-out ≥3, or cross-session survival needed → stop lite, escalate to a full-chain tab (`mode=workflow/adaptive`).

**Boundary**: lite only changes how the current session orchestrates; task tabs (their prompt's first line) keep their own mode discipline and are unaffected. A one-shot `这次走完整链` from the user overrides back to a full-chain tab.

### Choosing an execution style

| | **Full chain (tab)** | **Lite (in-session)** | **trace-fusion (§7)** |
|---|---|---|---|
| Runs in | visible tab (survives restart) | current session | 3 visible tabs |
| Workers | role agents via `subagent-win` | one `general` agent per stage, tier models | 3 independent full rollouts |
| Divergence | none (one plan) | none (one plan) | 3 diagnoses fused |
| Cost | tab + role models | lowest (small models on easy stages) | 3× wall clock, ~zero disk (diagnose) |
| Use when | heavy tasks, batches, must survive | quick single tasks in-session | hard/uncertain tasks, need independent diagnoses |

Tab titles: `<repo>[-worktree]-[<taskId>-]<label>`. Each tab returns a **`runId`** (see §6).

---

## 6. Ultra-long Task Infrastructure

### 6.1 Tab reclaim

`launch-tabs` writes a dispatch ledger (`~/.pi/agent/tab-runs/<runId>.json`) and returns the `runId`. Tabs report lifecycle via `PI_TAB_RUN_ID` and finish with a structured result.

```ts
// inspect one or all tabs
tab-status({ runId: "tab_xxx" })

// collect results — NEVER blocks: returns an immediate snapshot
tab-status()                                  // full picture
reclaim-tabs({ runIds: ["tab_xxx", "tab_yyy"] })
// → { ready[], pending[], awaitingInput[], failed[], orphaned[] }
```

**Never block (since 2026-08-13)** — `reclaim-tabs` does **not** wait/poll. It returns the current snapshot instantly (`wait`/`timeoutMs`/`intervalMs` are deprecated no-ops kept for backward compat). Waiting is replaced by two non-blocking mechanisms:
- **Event bus**: a tab writing `result.json` wakes the main session sub-second with the full result (no polling needed).
- **`set-timer`**: periodic self-nudge for check-ins when no completion is expected.

The orchestration loop is therefore: `launch-tabs(batch)` → [event-bus wakes you on completion] → `reclaim-tabs()` snapshot → `launch-tabs(batch+1)`.

**State machine** — `dispatched → attached → working → waiting → completed/failed/cancelled`, plus `orphaned` (no contact past grace) and `unconfirmed` (turn failed, no explicit result).

**Safety rules (hard):**
- Only an explicit `result.json` (via `tab-finish`) is a workflow-terminal state.
- `stop`/`length` means *waiting for input*, not done. `toolUse` means working.
- A terminal phase without a result is `resultMissing: true, completion: "unconfirmed"` — never treated as success.
- `reclaim-tabs` never blocks, never kills a tab and never fakes completion; on a snapshot it reports exactly what the ledger/state says. `waiting`/`orphaned`/missing-result are never counted as done.

`tab-finish` (inside the tab) is the only explicit terminal signal: status/summary/artifacts/reportPath. The `runId` comes from the environment, so a tab cannot forge another run's result.

`/tabs` lists all dispatched tabs for humans.

### 6.2 Auto-push timers

```ts
set-timer({ message: "检查批次结果并汇报", delayMs: 600000, label: "advance" })
set-timer({ message: "继续下一阶段", delayMs: 900000, target: { tabRunId: "tab_xxx", taskId: "1001" } })
list-timers({ status: "pending" })
cancel-timer({ timerId: "timer_xxx" })
```

When a timer expires the system **auto-sends a user message** to the target session (TUI-visible, human-steerable; busy sessions queue it via `followUp` so tool loops are never interrupted). `target: "self"` = current session; `target: { tabRunId }` = that tab's mailbox (`timers/mail/<runId>/`, consumed only by that tab). `launch-tabs` per-task `timers: [{delayMs, message}]` preloads a tab's mailbox at dispatch. `/timers` lists them. Subagents can neither set timers nor own tab identity.

**Reliability & ownership (since 2026-08-13):**
- **At-least-once delivery** — the scheduler sends the message *before* persisting terminal state, so a transient send failure keeps the timer `pending` and the next tick retries (a crash between send and persist may duplicate a nudge once; acceptable for push messages).
- **Session heartbeat ownership** — self timers carry `ownerCwd`+`ownerSessionId`; the scheduler writes a heartbeat (`timers/sessions/<id>.json`) every tick. A timer is consumable only by its owner while the owner's heartbeat is fresh, preventing double-fire when two main sessions share a cwd; a dead owner's timers are reclaimed by any same-cwd session after the grace (15s) — restart takeover preserved.
- **GC** — terminal timers (`fired/cancelled/missed`) older than 24h and stale heartbeats are swept every ~60s, so the ledger does not grow unbounded.
- **Capacity** — up to 50 pending timers per target (self or a single tab mailbox).

### 6.3 Event bus — completion is felt, not polled

The main session `fs.watch`es `tab-runs/`; when a tab writes `result.json`, it is noticed sub-second: a Windows toast fires and a user message is injected telling the model to reclaim and continue. Startup snapshots dedupe (no re-fire after restart); a 10s tick covers Windows `fs.watch` misses.

### 6.4 Active reporting — tab → main session

`tab-report` (inside a tab) actively contacts the main session: `reports/<id>.json` is written atomically, the main session notices it and injects a user message with the full content. The tab's model calls it when work completes or attention is needed — it does not wait to be polled.

### 6.5 Provenance — who spawned what

`~/.pi/agent/links.jsonl` logs every dispatch: `{ sessionId, kind: tab|async|timer, targetId, detail, at }`. `/links` lists them (filter by session/kind/runId). `sessionIdentity` resolves `PI_TAB_RUN_ID` → `sessionManager.sessionId` automatically.

### 6.6 Closed orchestration loop

```text
launch-tabs(batch N)                 # returns runIds
  → set-timer(advance message)       # auto-nudge in the future
  → [tab completes → event bus wakes main session with full result]
  → reclaim-tabs(batch N)            # ready[] with results
  → launch-tabs(batch N+1)           # next batch, results as input
```

Hours-long, unattended pipelines become a sequence of small orchestration steps.

### 6.7 Local master v1 — per-repo local master

A second-level master scoped **per repository** sits under the global master. Each repo gets its own local master address `agent://master_local_<scope>`; a pi session started in that repo silently becomes its owner (if the scope is unowned) and runs a per-repo wake loop for its scope mailbox. The global master (`agent://master_default`) and its event-bus registration are untouched.

**Scope key rule** (`localMasterScope`, pure, never throws):
- git repo → basename of `git rev-parse --show-toplevel` (a subdirectory cwd resolves to the repo root, not the subdirectory name);
- non-git → basename of cwd;
- worktree path → suffix `-worktree` (same title convention as launch-tabs), so a worktree and a same-named plain repo get distinct scopes;
- drive-relative drive-letter input is deliberately canonicalized before every Git lookup (`C:a` → `C:/a`, equivalent here to `C:\a`), so both styles map to the same basename key.

The result is always a short basename-style key (no `/`, no spaces) → parseable as a single-segment agent address and collision-free after attachment-file sanitize.

**Silent genesis** (on `session_start`): if the scope has no owner, the session `attach`es the scope address (wx atomic — concurrent starts yield exactly one winner); the repo **toplevel full path** is written into the attachment `detail` free field (used as the wake spawn cwd; fallback = cwd). All failure paths (bad session, owner already present, IO) are silent — genesis never throws and never touches an existing owner's attachment.

**Per-repo wake loop** (`registerScopeWakeLoop`): only the scope owner registers a tick; each tick reads cutover fresh (global cutover off → idle, Q4), then evaluates the scope mailbox: wake/command-class letters spawn a tab with `cwd` = the scope repo toplevel (read back from `attachment.detail`); REPORT-shape letters are skipped without claim (they belong to the global master, S7 double insurance). Spawn success confirms a `<scope>`-named wake state; spawn failure lands a per-scope attention item.

**Per-scope attention**: `~/.pi/agent/state/local-master-attention/<scope>.json` — separate from the global `master-attention.json`; a session with both global and scope identity writes to both, with no shared marker files.

**`preInject` recipient**: the injection gate accepts an optional `recipient` address. When absent, behavior is byte-identical to the global master path (zero regression). Scope consumers pass their scope address so owner suppression / dispatcher-wake exemption are judged per recipient.

**Power boundary (v1 exclusions)**: no succession/transfer, no stale/heartbeat re-attach, no auto master selection, no `workstream --cwd`. A lost owner simply means the scope stays owned-but-inactive until the attachment is manually cleared.

**Known limitation (Q2)**: the scope key is a basename — two *different* repos with the same name on different drives/paths (for example, same-named repositories on different drives) collide into one scope. Worktrees vs. same-named plain repos are distinguished by the `-worktree` suffix; cross-drive same-name repos are not (accepted in v1).

---

## 7. Trace Fusion Loop — three-lane parallel diagnosis (`/trace-fusion-loop`)

A standalone SWE test-time scaling command: launch **three fully independent rollouts on the same task**, let them diagnose separately, then fuse. It is its own island — it never enters the Lite/Full workflow chains, and lane tabs cannot see orchestration tools (launch/timers/wiki/trace-fusion are excluded at dispatch).

### Two run modes

| | **`diagnose` (default)** | **`implement` (opt-in, expensive)** |
|---|---|---|
| Lane workspace | main repo, **read-only** | isolated git worktree (read-write) |
| Disk cost | ~0 | 10GB+/run on large repos (source ×3 + build outputs ×3) |
| Output | 3 × diagnosis +推进方案 (8-section trajectory + read-only evidence claims) | patch + trajectory + executable validation per lane |
| Cross-validation | skip-type report + deterministic dirty-baseline violation check (no commands run in the user's repo) | cross-test matrix: patches replayed on fresh eval trees, pooled commands rerun, flaky debounce |
| Handoff | main session fuses the three plans → single implementation | promote best patch / fresh synthesis (v0.4) |

### Trigger paths

- **`/trace-fusion-loop <task>`** (human, main session only) — honors `traceFusionLoop.mode`.
- **`trace-fusion` tool** (main session **agent**, self-triggered) — always forced to `diagnose`: when the model judges a task hard / root cause unclear / single-trajectory confidence low, it can fan out on its own. The expensive worktree tier stays human-only.
- Dispatch returns immediately with lane `runId`s; you keep working. Wall-clock timers are preloaded into each lane's mailbox (deadline −5min nudge, deadline finish) — reminder-only; enforcement happens at collection (`timedOut` degradation).

### Zero-touch lifecycle

```text
launch 3 lanes → lanes run (45min default wall clock each)
  → each lane tab-finish → event bus notices (code-level, zero tokens)
  → 3/3 terminal → background worker: authoritative collect → cross-test/skip report
     → meta status=completed, notification injected
  → main session closed/restarted mid-run? session_start catch-up re-scans and resumes
claim file prevents double-spawn across watcher / catch-up / duplicate sessions
```

### Commands & state

```text
/trace-fusion-loop <task>       # start (mode from config; agent tool is always diagnose)
/trace-fusion-status            # rebuild view from disk (survives restarts)
/trace-fusion-collect [id] [--force]   # manual fallback; refuses until all 3 lanes tab-finish
/trace-fusion-clean <runId> [--force]  # remove worktrees, keep runDir artifacts (patches stay replayable)
```

Artifacts (kept forever, never auto-deleted): `~/.pi/agent/trace-fusion-runs/<runId>/` — `meta.json`, `lanes/{A,B,C}/trajectory.md + validation.json + patch.diff + result.json`, `collect.json`, `cross-test.json`, `cross-test-report.md`, `collect-worker.log`. Worktrees (implement mode only) live short at `~/.pi/tfl-wt/<shortId>/{a,b,c}` and are removable via `/trace-fusion-clean`.

Read-only guarantees (diagnose): `edit`/`write` excluded from lane tools at dispatch; porcelain baseline captured at launch and diffed at collection — out-of-baseline entries are flagged as suspected lane writes (writes inside gitignored paths are a documented residual risk).

Fusion/consultant arbitration/targeted probes/promotion are v0.4 (model-judgment layer); today the deterministic report + three trajectories are the deliverable, fused by the main session or by you.

---

## 8. Runtime Daemon & Local Control Plane (runtime-host)

The runtime daemon is a **resident local control plane** for your pi sessions — an ordinary detached node process, **not a network service** (loopback-only; see the 安全边界 section below). It is the **prerequisite for the local GUI** (§14): the web console is served by the daemon itself.

- **Lifecycle** — spawned detached (survives the closing of the tab that started it); single-instance identity via `host.json` + nonce challenge; a dead zombie or orphan lock after a reboot is **rebuilt under the lock automatically** (only when the lock holder is provably dead — live locks are never force-removed, and no pid is ever blind-killed).
- **Discovery** — binds `127.0.0.1:0` (dynamic port); the actual pid / port / token / instance id are written to `~/.pi/agent/runtime/host.json` (0600); clients discover it there. `host.json` is a hint, not a lock.
- **Surface** — read-only projection endpoints (`/v1/health`, `/v1/snapshot`, `/v1/events`, `/v1/attention`, `/v1/interactions`, `/v1/timeline`, `/v1/sessions` + transcript) and **exactly one** write endpoint `POST /v1/commands` (token-authenticated; missing/wrong token → 401, fail-closed), plus a WebSocket event stream for live frames.
- **Troubleshooting** — daemon stderr is captured to `~/.pi/agent/runtime/daemon-stderr.log`; when anything on the daemon misbehaves, start there.
- **Commands** — `/runtime-host start|stop|status|restart [--force]`. `restart` is fail-closed stepwise (stop → bounded wait for lock release → spawn) and its report always states three consequences: the new pid/port, **the GUI cookie is invalidated** (re-run `/gui open`), and the wechat worker is respawned by the new daemon (if receive is enabled).
- **Fail-closed when absent** — with the daemon not running, shared control writes are rejected with a clear error; normal conversation, tools, and subagents are unaffected. Opt-in, zero-intrusion: never start it and you get the vanilla pi experience.
- **Design direction** (partially shipped): three layers — Client Plane (TUI / GUI / WeChat) → Runtime Daemon (communication fabric: events, leases, projections) → agent workers (crash-isolated processes). The shipped slice today is the daemon itself (lifecycle, identity, read projections, the command endpoint); the write-side migration proceeds gate by gate. The planned G0 ten-round validation has **not** been completed, so daemon lifetime claims should not be read as a full G0 pass.

## 9. Master Tool Family & Local Master

Long-lived "master" sessions — the global `agent://master_default` and the per-repo local masters (`agent://master_local_<scope>`, §6.7) — are managed by a family of **11 tools** (most with same-name slash commands). **Positioning (hard rule, embedded in every tool description): call only when the user explicitly asks; the agent must never decide on its own to take over (attach) / hand off (detach/transfer) / switch (cutover).**

| Tool | Responsibility | Who may call it |
|---|---|---|
| `master-status` | Master ownership: attachment / resolver / cutover / mailbox backlog + this repo's local ownership line (+ a conditional autonomy line, §11). Read-only. | Any session |
| `master-pressure` | Reads the current master session's context-window pressure (read-only; feeds the succession proposal line). | Any session |
| `master-handoff` | Generates the handoff-package markdown (read-only assembly; writes to disk, never injects). | Any session |
| `master-attach` | Explicitly takes over the logical master — genesis / token handoff / `forceStale` (requires `confirm` double-check). Repo sessions hold **local**, home sessions hold **global** (the home guard rejects everything else). | Subagents refused |
| `master-detach` | Hands over the master and issues a handoff token. | Owner only; subagents refused |
| `master-cutover` | Master on/off switch for consumer-side takeover (turning it on requires an existing attach). | Subagents refused |
| `master-transfer` | One-click succession transaction: fresh handoff package → token → spawn successor → successor takes over (gen+1). On spawn failure the old master **stays** owner; no retry. | Owner only; subagents refused |
| `master-transfer-confirm` | Successor session confirms the takeover (validates gen+1 + owner; lands the transaction). | Successor session |
| `master-dispatch` | Master dispatches one **visible** task tab — same ledger / reclaim chain as `launch-tabs`; journal source recorded as `agent://master_default`. | Main session or the current global master owner; task tabs & subagents hard-blocked |
| `local-master-ensure` | **Idempotent ensure** that the target repo's local master is alive: live owner → zero action; otherwise opens a **visible** tab and lets the new session's own `session_start` path claim the scope (this tool never attaches on your behalf — **zero new authority**). Strict readiness judgment: insufficient evidence → `stalled`, never guessed. | Main session or global master owner (four-layer gate: identity / eligibility / parameter surface / directive) |
| `global-view` | Read-only global work view (tabs / timers / mailboxes / plans / last); does not consume, does not archive. | Any session |

**Slash equivalents:** `/master-status` · `/master-attach [token] [--force-stale --confirm] [--local]` · `/master-cutover on|off` · `/master-transfer [--local] [reason]` · `/master-detach [reason]` · `/master-handoff [repoRoot]` · `/local-master-ensure <cwd> [--no-wait] [--timeout <ms>]` · `/global-view [--history] [--page N] | /global-view inbox`.

**Succession switches:** `/master-succession on|off` (master switch, default **on**: at the pressure proposal line the master offers a succession proposal) and `/master-auto-handoff on|off` (automatic handoff, default **off**, strictly opt-in: at turn end, if 8 safety gates pass, the master performs exactly the same one-click transfer; on failure the old master is retained, at most one attempt per generation).

**Wake round-trip discipline:** tabs spawned by the wake chain have **no letter-sending tool** — after handling an incoming `requiresAck` message they must reply with a `kind=RESULT` receipt via `deliverLetter` (the recipe is embedded in the spawn prompt); command frames never require a reply.

## 10. WeChat Channel (iLink)

The WeChat channel is a **Client Plane** endpoint: long-polling against the WeChat iLink bot API (HTTP timeout > 90 s), **no public webhook**, running in a supervised worker process (kept out of the daemon's event loop). Receive, inbound input, image artifacts, and remote commands are individually opt-in and fail-closed: their respective gates require the JSON literal `true`. The reply switch has a separate compatibility default documented below.

**Config family** — `channels.wechat.*` in `config.json` (top level):

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Channel master switch (bind / receive / reply all depend on it) |
| `receive.enabled` | `false` | Inbound receive (long-poll worker: private-chat text into a durable inbox) |
| `input.enabled` | `false` | Inject inbound private-chat text into the current master owner session |
| `input.allowFrom` | `[]` | OpenID allowlist — **empty = reject all**; server-side only (a nickname / message body / request body can never grant permission) |
| `reply.enabled` | `true` | Outbound reply master switch (`false` stops both modes) |
| `reply.mode` | `"reply-only"` | `"broadcast"` must be enabled **explicitly** (default = legacy reply-only behavior) |
| `reply.sessionScope` | `"owner"` | Which session may produce broadcasts (`owner` \| `main` \| `any`) |
| `reply.allowOut` | `[]` | Outbound broadcast subscription set; recipients = bound owner ∪ `allowOut`; **config-file only** (no HTTP write surface) |
| `artifact.enabled` | `false` | Inbound **image** attachments (requires the JSON literal `true`); **restart-free** — re-read on every poll batch, effective within ≈95 s |
| `remoteCommands.enabled` | `false` | Remote slash-command bypass (below) |

**Inbound:**
- **Text** — private chat only (group messages are quarantined at the parser). Injection requires **six fail-closed conditions** to hold at once: opt-in, allowlist hit, private chat, master process alive (tick-level session heartbeat — an idle master counts as alive), target = current owner **and** matching generation, and a sanitized audit line (`state/wechat-input-audit.jsonl`: no body / no token / no full openid). A denied record is terminal — adding to the allowlist later does not re-deliver old messages.
- **Images (opt-in `artifact.enabled`)** — the worker downloads (CDN host-suffix allowlist + `redirect: manual`, ≤3 hops, each hop re-checked) → decrypts (AES-128-ECB, `base64(hex32)` key format) → stores content-addressed at `<runtimeDir>/wechat/artifacts/files/<sha256>.jpg|png` (8 MB/file, one image per message). The injected body only appends a `〔附件：<absolute path> (mime, bytes)〕` suffix — no base64 / URL / key in the body. The model reads the image with pi's built-in `read` tool, which **requires a multimodal session model** (`input` includes `image`) and a separate text message to trigger the read. Inbound voice and file downloads are **not implemented**; those message types remain quarantined.

**Outbound:**
- **Reply** — sent to the triggering `to_user_id` (real-device verified: no `context_token` needed).
- **Broadcast** (`reply.mode="broadcast"`) — after each settled turn of the global master session, the last non-empty assistant message goes to the authorized recipients. **Per-recipient `client_id` is mandatory**: the server dedupes by `client_id` (verified on real devices — the same id sent twice is delivered only once), so a shared id would make recipients swallow each other's messages.

**Remote slash commands** (opt-in `remoteCommands.enabled`): messages starting with `/` are consumed **before** they reach the LLM (zero transcript pollution) and classified into a three-tier whitelist:
- **safe** (e.g. `/wechat status`) — executed directly;
- **sensitive** (e.g. `/reload`, `/compact`, `/model <provider/id>`, `/thinking <level>`, `/wechat on|off`) — executed directly + audit line (no second confirmation, by explicit user ruling);
- **danger** (shell shapes `!cmd` / `;` / `|` / `&` / `$(…)` / backtick, file-write / session-destruct surfaces) — **always rejected**;
- **unknown** `/xxx` → **explicitly rejected — never falls back to plain-text injection**.

**Secret hygiene:** `bot_token` never enters logs / GUI / WS / argv; credentials are stored 0600 under `<runtimeDir>/wechat/`; all outbound network goes only to the iLink base URL + allow-listed attachment CDN hosts. Binding (QR) is done from the GUI "WeChat" section, which is always rendered (with an in-page "enable" affordance while the channel is off).

## 11. Autonomy Suite & Expectation Ledger

**Autonomy suite** — moves the global master from "passively waits for instructions" to "proactively derives + explicit actions".
- **Default: zero automatic action.** The whole suite is opt-in — `config.json "autonomy": {"enabled": true}` (strict `=== true`, per-field fail-closed normalization). When off, wake-loop behavior is byte-identical to the legacy path and `state/autonomy/` creates no new files.
- **Switches** — `/autonomy on|off|status|kill [reason]|clear` (manual operations commands; subagent sessions blocked; every flip leaves an audit line) + a GUI settings card. `kill` is the in-suite fire switch (suppresses the wake gate); stopping the legacy wake itself is `/master-cutover off`.
- **When enabled** — each tick collects a *frontier* (project-level state map); a **wake gate** (gating / 2 s debounce / 15 s cooldown) decides whether the existing wake chain is allowed to proceed. v2 only gates and records — it never acts.
- **Action surface (separately default-OFF)** — `autonomy.actions.enabled === true` opens a **rollback-only** action subsystem. Two action classes today: `diagnostic-report` (effect confined to its own namespace) and `notify-local-master` (exactly **one new letter file** in the target scope master's mailbox — deliver only, never consume/ack anyone else's mailbox). The whole chain is **fail-closed** (any unknown / read failure / exception → refuse), with hard-coded budgets (1 new action per tick, ≤2/hour rolling, per-trigger dedupe) and a persistent circuit breaker (a falsified rollback promise freezes everything until manual clear), plus a git porcelain pre/post guard (any new dirty entry → rollback + freeze). It **never auto-dispatches work and never auto-restarts workers**.
- **Where the evidence lives** — `state/autonomy/`: `audit.jsonl` (structured decision lines), the frontier snapshot, the wake-gate state, and `actions/actions.jsonl` (per-action ledger: attempted / precheck / executed / postverified / rolled_back / …, 0600, ~1 MB two-generation rotation). `/autonomy status` prints the summary; the GUI shows a live frontier visualization.

**Expectation ledger (⑧ request → reply expectation)** — the requester declares *what reply it is waiting for* at the moment of successful delivery; the consumer chain closes the wait when the matching reply arrives (four-key match, body never read); timeouts are derived from an explicit `now` at read time — **no timers, no background process**.
- SoT: `~/.pi/agent/runtime/state/expectations/{open,closed}/<requestId>.json` (one file per request); the journal receives only 3 additive events (`project.expected_event_{set,arrived,timeout}`). Default deadline 30 min, overridable per letter.
- **Production entry point** — `/send-letter <to> [--subject S] [--body B] [--deadline 30m] [--no-expect]` (manual operations command; subagent sessions blocked; rejections are audited).
- **Read surfaces** — the autonomy frontier trigger (`expected_event_timeout`), the watchdog overdue check, attention entries (`request-timeout`), and the read-only work-graph projection (§12). The autonomy suite is **read-only** on this ledger; the writer is the consumer chain.

## 12. Work Graph — Read-only Projection (experimental)

> **Status: experimental / internal.** A read-only relationship surface — **not a user-facing feature** (no tool or command exposes it directly); safe to ignore.

A pure-library projection over the four existing objects (**Master / Workstream / Task / Run**) plus the expectation ledger's open list:
- **Reference-style edges only** (task→workstream, run→task/subject/workstream, workstream→project), derived from existing carriers — it does not invent `depends_on` / `blocks` / `requires`.
- **Pure projection, zero write paths** — a projector / evaluator over the existing sources of truth, not a replacement for any of them (the tab-runs state machine and the timeline keep their jobs).
- `diff(since)` for change tracking; snapshot schema v2 (run carrier fields, derived project fields, next expected event).
- **Wiring status** — introduced as a **shadow run** (zero production wiring, revertible with a single commit); since 2026-10-02 it serves as the **autonomy frontier data source** behind a single-point switch (`PI_AUTONOMY_FRONTIER_SOURCE`; production default `graph`, an externally pre-set non-empty value wins — the escape hatch). A 34-frame shadow comparison proved the graph-derived frontier input canonical-equal to the legacy path (zero unexplained differences).

## 13. Approval Gate — planned, not shipped in v0.7.0

A unified approval gate (one gate shared by the TUI / GUI / WeChat surfaces) is **designed and decided, but not implemented**:
- priority `deny > ask > auto`; **floor actions are never approvable on any surface** (root / system-directory deletion, privilege escalation, reading or exfiltrating keys, payments / deploys, direct writes to the shared ledger);
- `ask` may be approved once remotely (WeChat); `always` is only a **scoped + TTL-bounded + revocable lease** requiring one local second confirmation — a "confirm" typed in WeChat **never** constitutes a second factor;
- headless / no-UI defaults to **fail-closed** (parked pending, waiting for local confirmation); timeout = deny; silence ≠ consent.

**Boundary with shipped behavior:** the GUI → master injection path (§14) and the wechat input allowlist (§10) are **explicitly opened narrow channels with their own gates** — they are not the (not-yet-shipped) approval gate. The residual-risk paragraph in the 安全边界 section applies to them.

## 14. UI Integration

- **Async task panel** — opencode-style widget above the editor: running background jobs (`agent: task (runId · age)`), recently completed (✓/✗); footer status `subagents: N running`; completion toasts.
- **Windows toasts** — subagent start/end, async completion, tab completion, tab reports. Toggle with `/notify on|off` or `config.json: notifications`.
- **Web Console (local GUI)** — default **OFF**. Production form: the runtime daemon (§8) serves the built `gui/dist` itself (no vite in production); dev form: `npm run gui:dev` (vite dev server proxying `/v1` to the daemon).
  - `/gui on` (writes `config.json: "gui": {"autoStart": true}` + starts the daemon detached if not already running) · `/gui off` (stops auto-start; a running daemon is **not** killed — that is `/runtime-host stop`) · `/gui status` · `/gui open`.
  - **Credentials**: `/gui open` mints a one-time short-lived OTT (`POST /v1/bootstrap`, host token, loopback connections only) which the browser exchanges for a derived `HttpOnly; SameSite=Strict` cookie — `sw_gui_token = HMAC-SHA256(key="pi:gui-cookie:v1", msg=hostToken)`. The browser never holds the host token itself; 12h true ceiling; `/v1/bootstrap` rejects the derived cookie (no self-renewal); `/gui off` → next request 403 + cookie cleared.
  - **Shape**: three-pane workbench — top bar, persistent left rail (session list + timeline entry), central route with two tabs (chat / timeline) — plus a full-screen runtime overlay with six sections (attention / master / workstream / runtime / wechat / autonomy). 微信回复状态为只读展示；关闭请在 TUI 执行 `/wechat reply off`（GUI 不写此开关）。
- **Garbage collection** — `/gc` (alias) / `/subagent-gc [maxAgeHours=48]`: frees module-level memory caches, archives terminal tab-run files past 48 h (pass `0` for all terminal) into `tab-runs/_archived/`, sweeps dead timers and stale session heartbeats, cleans up old `subagent-runs` artifacts, optionally triggers V8 GC, and prints before/after memory deltas.
- **Config commands** — `/sub-models` (interactive model/fallback/thinking), `/sub-presets` (save/load named subagent-model snapshots across 5 slots, e.g. night-time cheap models or local-only fallback), `/codex-headers` (per-provider Codex request-header compat for reverse proxies), `/searcher-mode auto|serial|parallel`, `/notify on|off`, `/agents`, `/runs`, `/tabs`, `/timers`, `/links`, `/today-usage` (daily token totals across all sessions + subagents), `/lite` (§5), `/launch` (§5). Master / wechat / autonomy / runtime commands are documented in their own sections (§8–§11).

---

## 15. Configuration & Runtime State

### config.json (copy from `config.example.json`)

```json
{
  "models": { "searcher": "provider/id", "planner": "…", "plan-reviewer": "…", "implementer": "…", "code-reviewer": "…", "consultant": "…" },
  "fallbackModels": { "searcher": ["provider/id2"] },
  "thinking": { "searcher": "low", "planner": "high" },
  "notifications": true,
  "searcherMode": "auto",
  "liteMode": "off",
  "traceFusionLoop": { "mode": "diagnose", "maxWallClockPerLaneMin": 45, "maxActiveRuns": 1 },
  "gui": { "autoStart": false },
  "masterSuccession": { "enabled": true, "auto": false },
  "autonomy": { "enabled": false },
  "channels": { "wechat": { "enabled": false } }
}
```

`searcherMode`: `auto|serial|parallel` searcher dispatch discipline. `liteMode`: `off|on|auto` — lightweight in-session workflow chain (see §5); tiers are projected live from `models`, no separate tier table. `traceFusionLoop`: see §7 — `mode` `diagnose|implement`, `workerModel`, `maxWallClockPerLaneMin` (nudge + timedOut semantics), `maxActiveRuns` (v1: 1), `provisioning` (junction/copy/command for implement-mode worktrees). `gui.autoStart`: see §14 (default off). `masterSuccession`: see §9 — succession master switch (default on) + auto handoff (default off). `autonomy`: see §11 (strict `=== true`, default off). `channels.wechat`: see §10 (fully opt-in, fail-closed).

Model selection priority: (1) configured default + fallback chain; (2) override only when the chain is exhausted, the user names a model, or the default is clearly unsuitable; (3) prefer normal `provider/id` — never switch to an external CLI unless configured or user-requested.

### Ledger files (all under `~/.pi/agent/`)

| Path | Contents |
|---|---|
| `subagent-runs/<id>.json` | async subagent run records |
| `tab-runs/<runId>.json` | tab dispatch ledger (`.state.json` lifecycle, `.result.json` terminal) |
| `timers/<id>.json` | self timers; `timers/mail/<runId>/` tab mailboxes |
| `reports/<id>.json` | tab → main active reports |
| `links.jsonl` | provenance log (who spawned what) |
| `trace-fusion-runs/<runId>/` | trace-fusion run artifacts (meta, lanes/{A,B,C}, collect, cross-test, logs) |
| `runtime/host.json` | daemon discovery: pid / port / token / instance id (0600; §8) |
| `runtime/daemon-stderr.log` | daemon stderr capture — first stop for daemon troubleshooting |
| `runtime/events.jsonl` | runtime journal (append-only event envelopes, seq-ordered) |
| `runtime/state/` | master registry (attachments / cutover), scope liveness, `expectations/{open,closed}/` (§11), `autonomy/` audit + action ledger (§11), `work-graph/` read-only cache (§12), `master-injections.jsonl` (GUI injection audit, bodyless), `wechat-input-audit.jsonl`, `local-master-ensure-audit.jsonl`, `message-outbox/` |
| `trust.json` | pre-granted trusted paths (e.g. worktree root for implement mode) |
| `hotspot/<wsid>/` | v4 ephemeral working set: `events/*.jsonl` shards, `snapshot.json`, `log.jsonl` (see §15.5) |
| `state/wechat-reply/<id>.json` | 微信出站回复意图及终态（pending/sent/failed/unknown；包含私有正文，仅本机状态目录） |
| `state/wechat-reply-audit.jsonl` | 微信回复脱敏审计（无正文/token/完整 openid）；开关 `/wechat reply on|off`，GUI 仅只读计数 |

_Excerpt — the state layout grows with the feature set; everything lives under `~/.pi/agent/` (overridable via `PI_CODING_AGENT_DIR`), never inside the repo._

### Environment variables

| Var | Meaning |
|---|---|
| `PI_TAB_RUN_ID` | set on launched tabs (reclaim identity); cleared for subagents |
| `PI_TAB_RUNS_DIR` | tab ledger dir override |
| `PI_SUBAGENT` | set on subagent processes (they never own tabs/timers, never open tabs) |
| `PI_HOTSPOT_ENABLED` | `0`/`false` disables the hotspot working set entirely — collection/injection/tool/command all unregister (default on; see §15.5) |
| `PI_RUNTIME_DIR` | runtime state dir override (default `~/.pi/agent/runtime`) |
| `PI_CODING_AGENT_DIR` | agent dir override (default `~/.pi/agent`) — root of the ledgers above |
| `PI_CHANNEL_WECHAT_CONFIG` | wechat `config.json` path (injected by the daemon's worker supervisor) |
| `PI_AUTONOMY_FRONTIER_SOURCE` | autonomy frontier data source: `graph` vs legacy (an externally pre-set non-empty value wins; §11/§12) |

_Excerpt — see `extensions/` sources for the full set._

### 15.5 Hotspot working set (v4 — ephemeral projection)

Hotspot answers one question: **"which files was this task/workstream touching just now?"** It is a *cache, not memory*: **losable** (deleting all hotspot data loses no knowledge), **rebuildable** (re-accumulates from fresh tool activity), **non-authoritative** (heat ≠ importance or correctness), **short-lived** (12h half-life, 48h/72h TTL), **non-blocking** (every failure path is silent; coding/Master/Timeline/Wiki run normally without it). "What happened" belongs to Timeline/recentwork, "what we know" belongs to Wiki — Hotspot holds neither.

**Storage** — all under `<agentDir = PI_CODING_AGENT_DIR ?? ~/.pi/agent>/hotspot/<wsid>/`, never inside the repo (no `.gitignore` edits, no runtime state in the worktree):

```text
meta.json          # {schema:4, workspaceRoot, createdAt}
events/<pid>-<startTs>-<rand>.jsonl   # append-only shards, one per process (no locks)
snapshot.json      # derived cache: tmp+rename atomic write, sole writer = main session
log.jsonl          # inject/lookup decision log
```

`wsid` = first 16 hex chars of sha1(repo root) — each worktree gets its own namespace.

**Collection & weights** — tool events only: successful `edit`/`write` → **write 3**, successful `read` → **read 1**, `bash` conservatively recognized as a targeted single-file test → **test 2**. Failures (`isError`), broad scans (grep/find/ls are outside the whitelist), and hotspot's own activity never count. A per-run cap per file per kind (read 4 / write 3 / test 2) stops loops from cooking scores. Score decays as `score(t) = score(t0)·2^(−Δt/12h) + weight`; entries turn **soft at 48h** (still visible in lookup, excluded from injection) and are **pruned at 72h**.

**Conservative injection** — at most one `<recent-working-set>` block appended to a session's first user message, and only when a gate passes: (a) the current task/workstream exactly matches entries in the set (and the task is not terminal), or (b) the first message mentions exact repo paths that are fresh in the set. New tasks, unknown identity, "globally hot" files, and fuzzy text similarity never trigger injection. Budget: ≤5 entries (≥2 to inject at all), ~560 chars ≈ 80–160 tokens; over-budget entries are omitted whole, never truncated. Idempotent twice over: a resumed session (existing user messages) or a prior `hotspot-injected` custom entry suppresses re-injection.

- **`hotspot` tool** — **lookup only** (read-only): task/workstream view, `limit` (default 10, max 50). The v2 `read`/`upsert`/`remove` routing-cache writes are gone.
- **`/hotspot`** — read-only diagnostics: identity, parameters, entries with score/kind/age/TTL, injection switch state, storage summary.
- **Kill switch** — `PI_HOTSPOT_ENABLED=0` (default on): collection/injection/tool/command all unregister; everything else keeps working.

**v2 retirement** — `Wiki/_hotspot.md` + `Wiki/_hotspot.trash.jsonl` are the only remaining copies of the v2 routing cache; v4 never reads, writes, or deletes them (deliberately left untouched). Rolling back to v2 = `git revert 8a9f09a` (the old files are intact, so the revert restores the old behavior wholesale). Once rollback is off the table, retire them for good: back them up out of the repo and drop the now-dead `state/`/trash `.gitignore` rules (old-implementation exit strategy).

---

## 安全边界：不要把 runtime 暴露到公网

runtime-host / daemon 是**本机**控制面，不是网络服务。以下红线不接受例外：

- daemon 只 bind `127.0.0.1`（动态端口，`host.json` 做发现）。不要改绑 `0.0.0.0`。
- `host.json` 里的 host token 是**本机信任**：同机任何能读该文件（0600，当前用户）的进程都可连。拿到 token = 拿到全部读投影 + 唯一写端点 `POST /v1/commands`。
- 禁止把端口带到公网：SSH `-L/-R` 端口转发、nginx/Caddy 等反向代理、公网域名、容器 `-p` 端口映射、云主机安全组放行，一律不做。跨站坏 `Origin` 会被服务端拒绝，但这只是纵深，不是暴露的理由。
- 需要远程访问时走既定通道（微信网关、VPN/内网穿透到**你的人**而不是到端口），而不是暴露 HTTP。
- token 泄漏等于把 runtime 交给对方：轮换 = 删 `host.json` + 重启 daemon（新 token），并检查 `master-injections.jsonl` 与 journal 有无异常注入。
- 公网暴露会同时暴露两样东西：全部会话内容（转写/事件/注意力投影）与工具执行能力（命令入口直达工作流状态与会话注入）。
- 残余风险（已接受，`/gui on` 即显式接受）：本机 GUI 经受信通道可注入 master 会话——浏览器上下文一旦被注入内容（如转写里的恶意文本诱导复制/点击），等于直接驱动 master；审批门尚在建设中。缓解：GUI 缺省 OFF（`/gui on` 显式启用才存在该通道）、一次性 OTT 换 `HttpOnly; SameSite=Strict` 派生凭据 cookie（`sw_gui_token = HMAC-SHA256(key="pi:gui-cookie:v1", msg=hostToken)`，浏览器不持 host token 本体）、每次 master 注入记 `state/master-injections.jsonl` 审计行（无正文）。诚实说明：该 cookie 是作用域化凭据（只解锁命令面 + WS 流；`Max-Age=43200`/12h；`/v1/bootstrap` 不认它故无自续期，12h 为真上限；`/gui off` 后浏览器下一次请求即 403 并被清除；重启轮换 host token 即失效；被盗=12h 窗口命令面能力；纯 http 下无 `Secure` 可用；本机持 token 进程用 `curl -b sw_host_token=` 以 cookie 呈现过门属预期行为，不是漏洞）。**该 cookie 不按端口隔离**：cookie 按 host 而非端口回传，`127.0.0.1` 上**任意端口**的本机服务都可能收到它（这正是把本体换成派生凭据的动机——本体泄漏=全权，派生泄漏=12h 窗口命令面）；`/gui off` 同样切断 WS 面（派生 cookie 握手 fail-closed 401）。

---

## 16. Knowledge Management (project document system)

The workflow ships a full documentation system for long-lived repos. **Five separate document families — don't confuse them:**

| Family | Where | Purpose | Written by |
|--------|-------|---------|------------|
| **Wiki** | `Wiki/{Concepts,Modules,Architecture,Decisions,Workflows}/` | durable cross-task facts, `status: current`, `source_paths` + Evidence | searcher (proactively maintained) |
| **Hotspot working set** | `~/.pi/agent/hotspot/<wsid>/` (outside the repo) | v4 ephemeral projection: task/workstream → recently read/written/tested files (12h half-life, 48h/72h TTL; losable, rebuildable — see §15.5) | runtime collector (automatic) |
| **Plans** | `plans/` | per-task implementation plans & research notes | planner; research mode |
| **Timeline / recentwork** | `recentwork.md` or `Timeline/current.md` | task progress log | implementer / reviewer |
| **Changelog** | `changelog.md` + `changelog/YYYY/YYYY-MM.md` | monthly release history | release time (bundled templates) |

### 16.1 Wiki — durable knowledge

- Theme pages only (a topic = one page with sections), `status: current`, `source_paths` + Evidence.
- **Hard rule: task findings NEVER go to Wiki** — they live in replies or research notes under `plans/`.
- `wiki-nav` tool: `tree` / `around` / `find` / `keywords` / `path` / `rebuild` (progressive navigation, no need to read whole indexes). Optional semantic term expansion via `~/.pi/agent/embeddings.json` (see `examples/embeddings.json`).
- After any Wiki page change: `wiki-nav rebuild` regenerates `_navigation.json` / `_search.json` / `_keywords.json`.

### 16.2 Timeline / recentwork

- Timeline entries are repository-local progress identifiers, not GitHub issues.
- `recentwork.md` rows: what changed, paths, status. The launcher/runner may be wired to an external task-board server (optional integration).

### 16.3 Changelog

- Month-based release history (`changelog.md` quick nav + `changelog/YYYY/YYYY-MM.md`), per bundled templates.
- Distinct from this package's own `CHANGELOG.md` (package release log — see §17).

### 16.4 How documents flow in a workflow run

```text
search ──► Wiki verify/update (searcher)
   │          plans/ research notes (if oversized)
   ▼
plan ──► plans/<topic>.md (planner)
   ▼
implement/review ──► recentwork.md row (progress)
   │          hotspot: tool calls collected to the working set along the way (v4, automatic)
   ▼
Wiki wrap-up (stage 5) ──► update the corresponding theme page; may be "none"
                        ──► no hotspot action here: the working set was collected live;
                            the next session recovers it via inject gate / `hotspot` lookup (§15.5)
```

---

## 17. Development

### Tests

There is **no aggregate `npm test` script** — each suite runs as its own `package.json` script (80+ of them), all via `node --experimental-strip-types` with the repo's `pi-deps-loader.mjs` resolve hook. Representative suites (excerpt):

```bash
# core orchestration
npm run test:launch
npm run test:tab-runs            # tab ledger pure functions
npm run test:tab-runs-runtime    # tab lifecycle + tab-finish/report/status/reclaim
npm run test:timers              # timer pure functions
npm run test:timers-runtime      # scheduler + set/cancel/list-timers
npm run test:async-panel
npm run test:links               # provenance
npm run test:event-bus
npm run test:report
npm run test:external-cli
npm run test:lite-mode
npm run test:gc-cleaner          # /gc runtime cleanup
npm run smoke:reclaim-loop       # full loop (dispatch → timer → finish → reclaim)
npm run smoke:real-tab           # real pi process (needs network/model)

# trace-fusion (§7)
npm run test:trace-fusion-git    # git primitives (worktree, snapshot, normalization)
npm run test:trace-fusion-launch # dispatch orchestration (implement + diagnose branches)
npm run test:trace-fusion-collect  # authoritative artifact collection
npm run test:trace-fusion-crosstest  # cross-test matrix + diagnose skip report
npm run test:trace-fusion-supervisor # auto-collect decision matrix + claim idempotency
npm run test:trace-worker        # worker identity/profile/guard
npm run test:register-graph      # tool/command registration snapshot

# runtime daemon & GUI (§8, §14)
npm run test:runtime-host-server # HTTP endpoints (read projections + /v1/commands)
npm run test:runtime-host-ws     # WebSocket event stream
npm run test:runtime-core        # protocol / journal / registry / consumer / cutover
npm run test:runtime-protocol
npm run test:runtime-mailbox
npm run test:runtime-registry
npm run test:runtime-consumer
npm run test:runtime-cutover
npm run test:gui-autostart       # /gui on|off|status|open
npm run test:gui-master-unlock   # narrow GUI→master injection path + scoped cookie
npm run test:gui-daemon-lifecycle

# master & local master (§9)
npm run test:runtime-master-control   # attach/detach/status/cutover logic
npm run test:runtime-master-transfer  # one-click succession transaction
npm run test:runtime-master-pressure  # context-window pressure gauge
npm run test:runtime-master-succession
npm run test:runtime-master-auto      # S3 auto handoff (8 safety gates)
npm run test:master-dispatch
npm run test:master-home-guard
npm run test:local-master            # scope genesis / stale takeover / wake loop
npm run test:local-master-ensure     # idempotent ensure (23 assertion groups)
npm run test:runtime-wake
npm run test:scope-stale-takeover
npm run accept:local-master-loop     # acceptance harness

# wechat channel (§10)
npm run test:wechat-reply
npm run test:wechat-broadcast
npm run test:wechat-outbound-auth
npm run test:wechat-artifact         # inbound image M1 (download/decrypt/store/inject)
npm run test:wechat-remote-command   # tiered whitelist classification

# autonomy & expectation ledger (§11)
npm run test:autonomy-actions        # decision tree / transaction / breaker / replay (87 checks)
npm run test:expectations            # declare / 4-key match / timeout / restart replay
npm run test:message-outbox

# hotspot (§15.5)
npm run test:hotspot                 # decay/collect/store/inject/lookup, incl. adversarial escaping
```

The full script list is in `package.json`.

### extensions/ file map (excerpt)

The extension is **255 `.ts` files** in total; the table below groups the key ones. `_test_*` / `_smoke_*` files (run via the `package.json` scripts above) are omitted.

| Area | Files | Responsibility |
|---|---|---|
| Registration hub | `index.ts` | All tool/slash registration: `subagent-win`, `launch-tabs`, `trace-fusion`, master / wechat / autonomy / `send-letter` / `global-view` / workstream / task / runtime-host / gc commands, subagent runner, `/launch` |
| Tab infra | `tab-runs.ts`, `tab-runs-runtime.ts` | tab reclaim pure functions (ledger, probe, classify, compose) / tab lifecycle, `tab-finish`, `tab-report`, `tab-status`, `reclaim-tabs`, `/tabs` |
| Timers | `timers.ts`, `timers-runtime.ts` | timer pure functions (validation, due/late, CAS claim, mailbox, session heartbeat) / scheduler + `set/cancel/list-timers`, `/timers` |
| In-session workflow | `lite-mode.ts`, `launch.ts`, `launch-workflow.ts` | `/lite` on\|auto\|off + tier projection / `/launch` parsing + workflow discipline block |
| UI & misc | `async-panel.ts`, `async-result-watcher.ts`, `event-bus.ts`, `report.ts`, `links.ts`, `no-poll.ts`, `notify-windows.ts`, `model-presets.ts`, `capabilities.ts`, `identity.ts`, `runner-argv.ts`, `tab-launch-core.ts`, `spawn-trace.ts`, `wiki-nav.ts`, `wiki-semantic.ts`, `gc-cleaner.ts`, `session-hooks.ts`, `injection-gate.ts`, `outbox-bridge.ts`, `external-cli.ts`, `codex-headers.ts` | TUI panel / fs.watch completion / active reports / provenance / Windows toasts / `/sub-presets` / capability matrix / pi argv builder / single-tab spawn / wiki navigation / GC / master hook wiring / master injection gate / outbox → session bridge / CLI backend runners / Codex header compat |
| Master family | `master-tools.ts` | the 11 master tools of §9 (gates, USER_DIRECTIVE descriptions) |
| Mailbox & wake | `mailbox-consumer.ts`, `wechat-reply-hook.ts`, `wechat-command-consumer.ts`, `gui-autostart.ts` | master mailbox consumption + scope wake-loop registration / wechat reply+broadcast hooks / remote slash-command consumer / `/gui` + daemon ensure |
| `runtime/` (65 files) | `address`, `ids`, `envelope`, `protocol`, `journal`, `journal-seq` (addressing, frames, journal) · `registry` (attachments, cutover) · `master-control`, `master-home-guard`, `master-injection`, `master-pressure`, `master-succession`, `master-transfer`, `master-auto`, `local-master-launch` (master logic, §9) · `mailbox`, `message-outbox`, `receipts`, `wake`, `scope`, `scope-consume` (mailbox & wake) · `expectations` (§11) · `global-view`, `frontier-carriers`, `recent-scopes` (read projections) · `transcript`, `stream-gen`, `snapshot`, `projector`, `hydrate`, `objects` (session projections) · `liveness`, `state-store`, `resolver`, `consumer-scan`, `command-executor` · `adapters/` (session-lifecycle, tab-run) · `autonomy/` (v1 pure functions + `action/` rollback-only subsystem, §11) · `graph/` (work graph read-only projection, §12) |
| `runtime-host/` (19 files) | `server.ts` (HTTP: read projections + the single `POST /v1/commands`) · `daemon-lifecycle.ts` (detached spawn / restart, `daemon-stderr.log`) · `discovery.ts` (`host.json` + `classifyHost`) · `identity.ts` (nonce challenge) · `ws.ts` (RFC6455 text frames) · `commands.ts` (strict body decoding, UTF-8/GB18030 fail-closed) · `snapshot`, `timeline`, `attention`, `interactions` (projection builders) · `session-title`, `session-pin` (session-list contract) · `wechat-bind`, `wechat-input`, `wechat-reply`, `wechat-outbound-auth` (wechat endpoints, §10) · `channel-supervisor.ts` (supervised wechat worker) · `autonomy-config.ts`, `static.ts`, `pi-deps-loader.mjs` |
| `channel-wechat/` (7 files) | `client` (long-poll) · `parser` (shape-tolerant; quarantine with sanitized shape signatures) · `store` (inbox + quarantine, dedupe-first) · `worker` (the long-poll loop) · `send` (outbound, per-recipient client ids) · `artifact` (image download + decrypt + content-addressed store) · `index` (wiring) |
| `hotspot/` (11 files) | `types` / `decay` / `store` / `collect` / `workset` / `inject` / `tool` / `command` / `log` / `index` — the v4 working set of §15.5 |
| `trace-fusion/` (14 files) | `types`/`config` (mode, defaults), `git` (worktree/patch primitives), `snapshot` (synthetic base), `worktrees` (lane provisioning), `trust` (pre-grant), `worker-prompt` (implement/diagnose contracts), `launch-workers` (run orchestration + lane timers), `artifacts` (authoritative collect, dirty-baseline check), `cross-test` (eval-tree matrix / diagnose skip report), `supervisor` (auto-collect decisions, claim), `collect-cli` (background collection worker), `clean` (worktree disposal) |
| `gui/` (separate npm package) | vite + React front end: `src/pages/` (Chat / Timeline / SessionList / Sidebar / TopBar + the six-section RuntimeOverlay incl. Autonomy and WeChat channels), `src/ui/` (shadcn kernel + thin adapter layer, zero-dependency Markdown renderer), `src/api/` (client with ETag conditional requests), `store.ts` (zustand) |

### How the event layer works

File system is the bus: ledgers under `~/.pi/agent/` are the shared state; `fs.watch` makes completion event-driven (sub-second); a tick interval is the fallback for Windows `fs.watch` misses. No in-memory daemon, no single point of failure.

---

## 18. FAQ / Known limits

- **Async subagents die with the session.** `async: true` runs in a child process of your pi session; closing/restarting it kills them. For work that must survive, use tabs.
- **Stall timeout** is per-process inactivity; it cannot detect a "busy but wrong" loop.
- **Windows `fs.watch`** can miss events on large/network directories — the 5–10s tick fallback covers this.
- **External CLIs** run with no-approval/dangerous modes — use only in trusted repos (same policy as those CLIs themselves). See §4 for wiring them as role-agent backends.
- **Two changelogs:** the project's `changelog.md` (monthly project history) vs this package's `CHANGELOG.md` (release log).
- **trace-fusion diagnose vs implement:** diagnose never runs commands in your repo (evidence claims are reviewed, not rerun); implement gives real build/test evidence but costs 10GB+ disk per run on large repos — clean with `/trace-fusion-clean` when done. Lane reads/writes inside gitignored paths are not visible to the dirty-baseline check (documented residual risk).

---

## License

MIT
