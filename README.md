# pi-subagents-win

Windows-native subagent orchestration for [pi](https://github.com/earendil-works/pi-coding-agent): role agents for delegation, visible parallel tabs for long-running work, and a full ultra-long task infrastructure (tab reclaim, auto-push timers, an event bus, and active reporting) on top of it.

**Package:** `subagent-win` · **Repo:** `pi-subagents-win` · **Version:** 0.2.1

---

## 1. Overview

### What it solves

- **Delegate** any step to a role agent (search / plan / review / implement) without leaving your session.
- **Parallelize** independent work with a single tool call.
- **Run hours-long pipelines unattended**: spawn visible tabs, let them report back, auto-advance with timers, reclaim results, launch the next batch.

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

### 3.2 External CLI backends

| Model ref | Spawns | Notes |
|-----------|--------|--------|
| `cli:claude` | `claude` | stream-json, `--dangerously-skip-permissions`, CLI default model |
| `cli:codex` | `codex exec --json` | stdin prompt, approvals bypassed, CLI default model |
| `cli:agy` | `agy` | plain stdout capture, native `--effort`, CLI default model |
| `cli:atomcode` | `atomcode -y -p <prompt>` | headless, no-approval, CLI default model |
| `cli:zcode` | `node zcode.cjs` | plain stdout capture (-p), GLM-5.3 fixed |

**Policy:** never pass `--model` to external harnesses; configure models inside each CLI. Refs like `cli:claude/sonnet` are rejected. Backends are used only when an agent's `config.json` default/fallback selects them — do not override an unrelated agent with one. `cli:zcode` is special: it spawns `zcode.cjs` through `node` and always uses the fixed GLM-5.3 configured in `~/.zcode/cli/config.json`.

### 3.3 Consultant — user-named model evaluation

When the user names a model ("请glm来评估一下", "请gpt5.6看看截图"), dispatch `agent: "consultant"` with that model as a per-call `model` override. Short aliases expand from `~/.pi/agent/models.json`. The consultant answers from that model's perspective; screenshot paths go in the `task` (it reads images with `read`).

### 3.4 Timeout semantics — stall, not wall-clock

`timeoutMs` is an **inactivity (stall) timeout**, not a total-run cap:

- **Error** → stop (exit≠0 / `stopReason=error`).
- **Stall** → "an operation is stuck with no output" → stop after `timeoutMs` of silence.
- **Progress** → any stdout/stderr output resets the timer; a healthy long task never gets killed.

A stall is classified as `STALL` (non-retryable) — it does not burn a fallback attempt, because a stuck task won't fix itself on another model.

### 3.5 Failure classification & fallback

Retryable failures (`USAGE_CAP`, `RATE_LIMIT`, `AUTH`, `TIMEOUT`, `PROVIDER`) walk the agent's `fallbackModels` chain. `USAGE_CAP` (e.g. Zhipu/GLM package quota, often a bare 429) surfaces as `[subagent-failure kind=USAGE_CAP]` telling the main agent to switch model via `/model` instead of retrying.

---

## 4. Tabs — visible parallel sessions

### `/launch` and `launch-tabs`

`/launch <request>` is an orchestration request: the current agent analyzes the conversation, identifies independent ready tasks, and calls `launch-tabs` once — opening all tabs in parallel.

```text
/launch 你来并行启动已满足条件的任务
/launch -t <title> <single task>        # explicit single tab
/launch --direct <task>                 # single tab, derived title
```

`launch-tabs` normalizes every prompt to `根据workflow进行工作<taskId>` (or `根据research/execute进行工作<taskId>`) and appends a **workflow discipline block** — read the `workflow-orchestrator` skill, act as project manager, delegate stages to subagent-win agents, never do it all yourself.

Three task modes:

| Mode | Prefix | Pipeline |
|---|---|---|
| `workflow` (default) | `根据workflow进行工作<id>` | search → plan → review → implement → review → Wiki wrap-up |
| `research` | `根据research进行工作<id>` | parallel searchers → research report → Wiki maintenance (no implementation) |
| `execute` | `根据execute进行工作<id>` | skip search/planning → implement → review → Wiki wrap-up |

Tab titles: `<repo>[-worktree]-[<taskId>-]<label>`. Each tab returns a **`runId`** (see §5).

---

## 5. Ultra-long Task Infrastructure

### 5.1 Tab reclaim

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

### 5.2 Auto-push timers

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

### 5.3 Event bus — completion is felt, not polled

The main session `fs.watch`es `tab-runs/`; when a tab writes `result.json`, it is noticed sub-second: a Windows toast fires and a user message is injected telling the model to reclaim and continue. Startup snapshots dedupe (no re-fire after restart); a 10s tick covers Windows `fs.watch` misses.

### 5.4 Active reporting — tab → main session

`tab-report` (inside a tab) actively contacts the main session: `reports/<id>.json` is written atomically, the main session notices it and injects a user message with the full content. The tab's model calls it when work completes or attention is needed — it does not wait to be polled.

### 5.5 Provenance — who spawned what

`~/.pi/agent/links.jsonl` logs every dispatch: `{ sessionId, kind: tab|async|timer, targetId, detail, at }`. `/links` lists them (filter by session/kind/runId). `sessionIdentity` resolves `PI_TAB_RUN_ID` → `sessionManager.sessionId` automatically.

### 5.6 Closed orchestration loop

```text
launch-tabs(batch N)                 # returns runIds
  → set-timer(advance message)       # auto-nudge in the future
  → [tab completes → event bus wakes main session with full result]
  → reclaim-tabs(batch N)            # ready[] with results
  → launch-tabs(batch N+1)           # next batch, results as input
```

Hours-long, unattended pipelines become a sequence of small orchestration steps.

---

## 6. UI Integration

- **Async task panel** — opencode-style widget above the editor: running background jobs (`agent: task (runId · age)`), recently completed (✓/✗); footer status `subagents: N running`; completion toasts.
- **Windows toasts** — subagent start/end, async completion, tab completion, tab reports. Toggle with `/notify on|off` or `config.json: notifications`.
- **Config commands** — `/sub-models` (interactive model/fallback/thinking), `/codex-headers` (per-provider Codex request-header compat for reverse proxies), `/runs`, `/tabs`, `/timers`, `/links`, `/agents`.

---

## 7. Configuration & Runtime State

### config.json (copy from `config.example.json`)

```json
{
  "models": { "searcher": "provider/id", "planner": "…", "implementer": "…", "code-reviewer": "…", "consultant": "…" },
  "fallbackModels": { "searcher": ["provider/id2"] },
  "thinking": { "searcher": "low", "planner": "high" },
  "notifications": true
}
```

Model selection priority: (1) configured default + fallback chain; (2) override only when the chain is exhausted, the user names a model, or the default is clearly unsuitable; (3) prefer normal `provider/id` — never switch to an external CLI unless configured or user-requested.

### Ledger files (all under `~/.pi/agent/`)

| Path | Contents |
|---|---|
| `subagent-runs/<id>.json` | async subagent run records |
| `tab-runs/<runId>.json` | tab dispatch ledger (`.state.json` lifecycle, `.result.json` terminal) |
| `timers/<id>.json` | self timers; `timers/mail/<runId>/` tab mailboxes |
| `reports/<id>.json` | tab → main active reports |
| `links.jsonl` | provenance log (who spawned what) |

### Environment variables

| Var | Meaning |
|---|---|
| `PI_TAB_RUN_ID` | set on launched tabs (reclaim identity); cleared for subagents |
| `PI_TAB_RUNS_DIR` | tab ledger dir override |
| `PI_SUBAGENT` | set on subagent processes (they never own tabs/timers, never open tabs) |

---

## 8. Knowledge Management (project document system)

The workflow ships a full documentation system for long-lived repos. **Four separate document families — don't confuse them:**

| Family | Where | Purpose | Written by |
|--------|-------|---------|------------|
| **Wiki** | `Wiki/{Concepts,Modules,Architecture,Decisions,Workflows}/` | durable cross-task facts, `status: current`, `source_paths` + Evidence | searcher (proactively maintained) |
| **Plans** | `plans/` | per-task implementation plans & research notes | planner; research mode |
| **Timeline / recentwork** | `recentwork.md` or `Timeline/current.md` | task progress log (`Item NN` entries) | implementer / reviewer |
| **Changelog** | `changelog.md` + `changelog/YYYY/YYYY-MM.md` | monthly release history | release time (wiki-and-task templates) |

### 8.1 Wiki — durable knowledge

- Theme pages only (a topic = one page with sections), `status: current`, `source_paths` + Evidence.
- **Hard rule: task findings NEVER go to Wiki** — they live in replies or `plans/*_research.md`.
- `wiki-nav` tool: `tree` / `around` / `find` / `keywords` / `path` / `rebuild` (progressive navigation, no need to read whole indexes). Optional semantic term expansion via `~/.pi/agent/embeddings.json` (see `examples/embeddings.json`).
- After any Wiki page change: `wiki-nav rebuild` regenerates `_navigation.json` / `_search.json` / `_keywords.json`.

### 8.2 Timeline / recentwork

- `Item NN` = the repo timeline/task identifier when that file exists — **not** a GitHub issue.
- `recentwork.md` rows: what changed, paths, status. The launcher/runner may be wired to the task board server (wiki-and-task).

### 8.3 Changelog

- Month-based release history (`changelog.md` quick nav + `changelog/YYYY/YYYY-MM.md`), per wiki-and-task templates.
- Distinct from this package's own `CHANGELOG.md` (package release log — see §9).

### 8.4 How documents flow in a workflow run

```text
search ──► Wiki verify/update (searcher)
   │          plans/ research notes (if oversized)
   ▼
plan ──► plans/<date_topic>.md (planner)
   ▼
implement/review ──► recentwork.md row (progress)
   ▼
Wiki wrap-up (stage 5) ──► update the corresponding theme page; may be "none"
```

---

## 9. Development

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
```

### extensions/ file map

| File | Responsibility |
|---|---|
| `index.ts` | tool/command registration, subagent runner, launch-tabs, `/launch` |
| `tab-runs.ts` | tab reclaim pure functions (ledger, probe, classify, compose) |
| `tab-runs-runtime.ts` | tab lifecycle telemetry, `tab-finish`, `tab-report`, `tab-status`, `reclaim-tabs`, `/tabs` |
| `timers.ts` | timer pure functions (validation, due/late, CAS claim, mailbox) |
| `timers-runtime.ts` | timer scheduler + `set/cancel/list-timers`, `/timers` |
| `async-panel.ts` | background-subagent TUI panel |
| `event-bus.ts` | fs.watch completion detection (main session) |
| `report.ts` | tab → main active-report channel |
| `links.ts` | provenance log |
| `external-cli.ts` | Claude/Codex/Agy/AtomCode/ZCode spawn runners |
| `codex-headers.ts`, `notify-windows.ts`, `launch.ts`, `wiki-nav.ts`, `wiki-semantic.ts` | supporting modules |

### How the event layer works

File system is the bus: ledgers under `~/.pi/agent/` are the shared state; `fs.watch` makes completion event-driven (sub-second); a tick interval is the fallback for Windows `fs.watch` misses. No in-memory daemon, no single point of failure.

---

## 10. FAQ / Known limits

- **Async subagents die with the session.** `async: true` runs in a child process of your pi session; closing/restarting it kills them. For work that must survive, use tabs.
- **Stall timeout** is per-process inactivity; it cannot detect a "busy but wrong" loop.
- **Windows `fs.watch`** can miss events on large/network directories — the 5–10s tick fallback covers this.
- **External CLIs** run with no-approval/dangerous modes — use only in trusted repos (same policy as pi-flow-external).
- **Two changelogs:** the project's `changelog.md` (wiki-and-task monthly history) vs this package's `CHANGELOG.md` (release log).

---

## License

MIT
