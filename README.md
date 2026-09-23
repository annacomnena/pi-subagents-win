# pi-subagents-win

Windows-native subagent orchestration for [pi](https://github.com/earendil-works/pi-coding-agent): role agents for delegation, visible parallel tabs for long-running work, and a full ultra-long task infrastructure (tab reclaim, auto-push timers, an event bus, and active reporting) on top of it.

**Package:** `subagent-win` · **Repo:** `pi-subagents-win` · **Version:** 0.3.0

---

## 1. Overview

### What it solves

- **Delegate** any step to a role agent (search / plan / review / implement) without leaving your session.
- **Parallelize** independent work with a single tool call.
- **Run hours-long pipelines unattended**: spawn visible tabs, let them report back, auto-advance with timers, reclaim results, launch the next batch.
- **Spend quota you already own**: point role agents at local CLI harnesses (Claude Code / Codex / Agy / AtomCode / ZCode / MimoCode) — subscriptions, free tiers, discounted dedicated-tool billing, and plans that can't be reverse-proxied into an API all become usable as subagent workers (§4).
- **Scale reasoning on hard problems** with trace-fusion (§7): three independent read-only diagnosis rollouts on the same task, auto-collected and fused — the agent can self-trigger it when a problem looks underdetermined.

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
pi install /path/to/pi-subagents-win
```

The package is a pi extension (`pi.extensions` → `./extensions/index.ts`) with a bundled skill (`pi.skills` → `./skills`).

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

Every role agent (`searcher` / `planner` / `implementer` / `code-reviewer` / `consultant`) can be pointed at a **local CLI harness** instead of an API model. The subagent then runs inside Claude Code / Codex CLI / Agy / AtomCode / ZCode / MimoCode and bills against **quota you may already own** — a subscription, a free tier, or a dedicated-tool plan with preferential rates — instead of per-token API credits. Each CLI also brings its own quota pool, so provider outages and rate limits stop being single points of failure.

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
2. **Handoffs land on disk** — >30-line artifacts go to `plans/` or Wiki; the reply carries the path + ≤10-line summary.
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

**Known limitation (Q2)**: the scope key is a basename — two *different* repos with the same name on different drives/paths (e.g. `D:\proj` and `E:\proj`) collide into one scope. Worktrees vs. same-named plain repos are distinguished by the `-worktree` suffix; cross-drive same-name repos are not (accepted in v1).

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

## 8. UI Integration

- **Async task panel** — opencode-style widget above the editor: running background jobs (`agent: task (runId · age)`), recently completed (✓/✗); footer status `subagents: N running`; completion toasts.
- **Windows toasts** — subagent start/end, async completion, tab completion, tab reports. Toggle with `/notify on|off` or `config.json: notifications`.
- **Web Console (dev form)** — `gui/` + `npm run gui:dev` (vite dev server proxying `/v1` to the runtime-host). Opt-in auto-start: `/gui on` (writes `config.json: "gui": {"autoStart": true}` + starts host/vite detached if not already running) · `/gui off` · `/gui status` · `/gui open` (opens `http://localhost:5173` in your browser). `vite` is a **development server** — static `dist` hosting is a later milestone.
- **Config commands** — `/sub-models` (interactive model/fallback/thinking), `/sub-presets` (save/load named subagent-model snapshots across 5 slots, e.g. night-time cheap models or local-only fallback), `/codex-headers` (per-provider Codex request-header compat for reverse proxies), `/runs`, `/tabs`, `/timers`, `/links`, `/agents`.

---

## 9. Configuration & Runtime State

### config.json (copy from `config.example.json`)

```json
{
  "models": { "searcher": "provider/id", "planner": "…", "implementer": "…", "code-reviewer": "…", "consultant": "…" },
  "fallbackModels": { "searcher": ["provider/id2"] },
  "thinking": { "searcher": "low", "planner": "high" },
  "notifications": true,
  "searcherMode": "auto",
  "liteMode": "off",
  "traceFusionLoop": { "mode": "diagnose", "maxWallClockPerLaneMin": 45, "maxActiveRuns": 1 }
}
```

`searcherMode`: `auto|serial|parallel` searcher dispatch discipline. `liteMode`: `off|on|auto` — lightweight in-session workflow chain (see §5); tiers are projected live from `models`, no separate tier table. `traceFusionLoop`: see §7 — `mode` `diagnose|implement`, `workerModel`, `maxWallClockPerLaneMin` (nudge + timedOut semantics), `maxActiveRuns` (v1: 1), `provisioning` (junction/copy/command for implement-mode worktrees).

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
| `trust.json` | pre-granted trusted paths (e.g. worktree root for implement mode) |

### Environment variables

| Var | Meaning |
|---|---|
| `PI_TAB_RUN_ID` | set on launched tabs (reclaim identity); cleared for subagents |
| `PI_TAB_RUNS_DIR` | tab ledger dir override |
| `PI_SUBAGENT` | set on subagent processes (they never own tabs/timers, never open tabs) |

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

## 10. Knowledge Management (project document system)

The workflow ships a full documentation system for long-lived repos. **Five separate document families — don't confuse them:**

| Family | Where | Purpose | Written by |
|--------|-------|---------|------------|
| **Wiki** | `Wiki/{Concepts,Modules,Architecture,Decisions,Workflows}/` | durable cross-task facts, `status: current`, `source_paths` + Evidence | searcher (proactively maintained) |
| **Hotspot cache** | `Wiki/_hotspot.md` | routing snapshot of recently-active topics (Wiki section slices, symbol entry points, evidence pointers) | main session via `hotspot` tool |
| **Plans** | `plans/` | per-task implementation plans & research notes | planner; research mode |
| **Timeline / recentwork** | `recentwork.md` or `Timeline/current.md` | task progress log (`Item NN` entries) | implementer / reviewer |
| **Changelog** | `changelog.md` + `changelog/YYYY/YYYY-MM.md` | monthly release history | release time (wiki-and-task templates) |

### 10.1 Wiki — durable knowledge

- Theme pages only (a topic = one page with sections), `status: current`, `source_paths` + Evidence.
- **Hard rule: task findings NEVER go to Wiki** — they live in replies or `plans/*_research.md`.
- `wiki-nav` tool: `tree` / `around` / `find` / `keywords` / `path` / `rebuild` (progressive navigation, no need to read whole indexes). Optional semantic term expansion via `~/.pi/agent/embeddings.json` (see `examples/embeddings.json`).
- After any Wiki page change: `wiki-nav rebuild` regenerates `_navigation.json` / `_search.json` / `_keywords.json`.

### 10.2 Timeline / recentwork

- `Item NN` = the repo timeline/task identifier when that file exists — **not** a GitHub issue.
- `recentwork.md` rows: what changed, paths, status. The launcher/runner may be wired to the task board server (wiki-and-task).

### 10.3 Changelog

- Month-based release history (`changelog.md` quick nav + `changelog/YYYY/YYYY-MM.md`), per wiki-and-task templates.
- Distinct from this package's own `CHANGELOG.md` (package release log — see §11).

### 10.4 How documents flow in a workflow run

```text
search ──► Wiki verify/update (searcher)
   │          plans/ research notes (if oversized)
   │          hotspot candidates in the reply (searcher returns, never writes)
   ▼
plan ──► plans/<date_topic>.md (planner)
   ▼
implement/review ──► recentwork.md row (progress)
   ▼
Wiki wrap-up (stage 5) ──► update the corresponding theme page; may be "none"
                        ──► hotspot upsert if a routing pointer changed (idle if not)
```

### 9.5 Hotspot routing cache (`Wiki/_hotspot.md`)

A routing-only working set for **new-session cold starts**. When a session's first user message is submitted, the extension appends one `<system-reminder>` block (once, idempotent — resume/retry never re-injects) containing:

- **Recent tasks** — latest 3 active `recentwork.md` rows (one pointer line each; status stays owned by recentwork)
- **Recently modified functions** — top 5 method-level hunk contexts aggregated from the **uncommitted working tree** + last 30 commits (purely derived, recomputed each injection; needs `*.cs diff=csharp` funcname for C# quality, falls back to file level)
- **Topic entries** — per topic: Wiki section slice, symbol entry points (`path::Symbol`, resolvable via CodeGraph), evidence pointers — sorted by heat and capped at ~1k tokens total

Heat signals are **computed, never stored**: uncommitted `git diff HEAD` (×5 — git log can't see in-progress work), 14-day churn (×3), active recentwork rows. The file stores only what can't be computed: routing pointers, pitfalls, semantic links.

- **`hotspot` tool** (`read` / `upsert` / `remove`) — the only write path. Strict parse, shape + path-boundary + CodeGraph-symbol validation, revision + fingerprint optimistic lock, cross-process `.lock`, atomic tmp-rename, identical-content no-op, removal keeps a `_hotspot.trash.jsonl` recovery copy. Subagent processes get none of it (candidates travel in replies; the main session commits).
- **`/hotspot`** — read-only diagnostics: disk vs injected revision, per-topic heat score **with its reasoning**, budget estimate, degradation causes.
- **Effect log** — `~/.pi/agent/hotspot-logs/<repo-key>.jsonl` (topic/version/action/time only); two weeks of this data decides the v3 candidates (dynamic CodeGraph relation projection, usage feedback into heat, curator).

Design principles: *compute what you can, store only the rest*; *routing pointers, never explanatory knowledge* (that's Wiki's job); *no daemon, no timers* — everything lives inside pi session lifecycles. Underscore prefix keeps `_hotspot.md` out of `wiki-nav` indexes. Design doc: `plans/20260915_plan_hotspot_memory_layer.md`.

---

## 11. Development

### Tests

```bash
npm run test:tab-runs
npm run test:tab-runs-runtime
npm run test:timers
npm run test:timers-runtime
npm run test:async-panel
npm run test:links
npm run test:event-bus
npm run test:report
npm run test:launch
npm run test:external-cli
npm run smoke:reclaim-loop      # full loop (dispatch → timer → finish → reclaim)
npm run smoke:real-tab          # real pi process (needs network/model)
npm run test:trace-fusion-git   # trace-fusion: git primitives (worktree, snapshot, normalization)
npm run test:trace-fusion-launch    # dispatch orchestration (implement + diagnose branches)
npm run test:trace-fusion-collect   # authoritative artifact collection
npm run test:trace-fusion-crosstest # cross-test matrix + diagnose skip report
npm run test:trace-fusion-supervisor # auto-collect decision matrix + claim idempotency
npm run test:trace-worker       # worker identity/profile/guard
npm run test:register-graph     # tool/command registration snapshot
```

### extensions/ file map

| File | Responsibility |
|---|---|
| `index.ts` | tool/command registration, subagent runner, launch-tabs, `/launch` |
| `tab-runs.ts` | tab reclaim pure functions (ledger, probe, classify, compose) |
| `tab-runs-runtime.ts` | tab lifecycle telemetry, `tab-finish`, `tab-report`, `tab-status`, `reclaim-tabs`, `/tabs` |
| `timers.ts` | timer pure functions (validation, due/late, CAS claim, mailbox) |
| `lite-mode.ts` | `/lite` on\|auto\|off + lite-chain system-prompt injection (tier projection from `models`; zero injection when off) |
| `timers-runtime.ts` | timer scheduler + `set/cancel/list-timers`, `/timers` |
| `async-panel.ts` | background-subagent TUI panel |
| `event-bus.ts` | fs.watch completion detection (main session) |
| `report.ts` | tab → main active-report channel |
| `links.ts` | provenance log |
| `external-cli.ts` | Claude/Codex/Agy/AtomCode/ZCode spawn runners |
| `codex-headers.ts`, `notify-windows.ts`, `launch.ts`, `wiki-nav.ts`, `wiki-semantic.ts` | supporting modules |
| `trace-fusion/` | trace-fusion-loop: `types`/`config` (mode, defaults), `git` (worktree/patch primitives), `snapshot` (synthetic base), `worktrees` (lane provisioning), `trust` (pre-grant), `worker-prompt` (implement/diagnose contracts), `launch-workers` (run orchestration + lane timers), `artifacts` (authoritative collect, dirty-baseline check), `cross-test` (eval-tree matrix / diagnose skip report), `supervisor` (auto-collect decisions, claim), `collect-cli` (background collection worker), `clean` (worktree disposal) |
| `trace-worker.ts`, `capabilities.ts`, `identity.ts`, `runner-argv.ts`, `tab-launch-core.ts` | trace lane identity/tool isolation, capability matrix, pi argv builder, single-tab spawn primitive |

### How the event layer works

File system is the bus: ledgers under `~/.pi/agent/` are the shared state; `fs.watch` makes completion event-driven (sub-second); a tick interval is the fallback for Windows `fs.watch` misses. No in-memory daemon, no single point of failure.

---

## 12. FAQ / Known limits

- **Async subagents die with the session.** `async: true` runs in a child process of your pi session; closing/restarting it kills them. For work that must survive, use tabs.
- **Stall timeout** is per-process inactivity; it cannot detect a "busy but wrong" loop.
- **Windows `fs.watch`** can miss events on large/network directories — the 5–10s tick fallback covers this.
- **External CLIs** run with no-approval/dangerous modes — use only in trusted repos (same policy as pi-flow-external). See §4 for wiring them as role-agent backends.
- **Two changelogs:** the project's `changelog.md` (wiki-and-task monthly history) vs this package's `CHANGELOG.md` (release log).
- **trace-fusion diagnose vs implement:** diagnose never runs commands in your repo (evidence claims are reviewed, not rerun); implement gives real build/test evidence but costs 10GB+ disk per run on large repos — clean with `/trace-fusion-clean` when done. Lane reads/writes inside gitignored paths are not visible to the dirty-baseline check (documented residual risk).

---

## License

MIT
