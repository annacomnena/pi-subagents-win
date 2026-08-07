# subagent-win

Windows-friendly pi subagent package: single / parallel / async runs, role agents, workflow-orchestrator skill, and optional external CLI backends (Claude Code / Codex / Antigravity / AtomCode).

**Version:** 0.2.1

## Features

- **Role agents**: searcher / planner / plan-reviewer / implementer / code-reviewer / **consultant**
- **Single agent**: `{ agent, task, model? }`
- **Parallel agents**: `{ tasks: [{agent, task, model?}, ...], concurrency? }`
- **Async execution**: `{ agent, task, async: true }`
- **Per-call model override**: pass `model` field with `provider/id` or short alias
- **External CLI backends**: `cli:claude` / `cli:codex` / `cli:agy` / `cli:atomcode` (always each CLI's own default model; no model override)
- **Model alias expansion**: short names like `glm-5.2` auto-resolve from `~/.pi/agent/models.json`
- **Smart fallback**: retry on model/auth/rate-limit/**usage-cap (GLM 套餐上限等)** errors using `fallbackModels`; failures return structured `USAGE_CAP` guidance so the main agent can `/model` switch to a higher-tier model
- **Timeout handling**: per-task timeout with partial output preservation
- **Smart text selection**: picks best final answer across multi-turn conversations
- **TUI integration**: rich rendering of calls and results with model/usage info
- **Usage tracking**: per-agent daily token/cost logging
- **`/today-usage` command**: aggregates all sessions + subagent runs for the local calendar day
- **`/sub-models` command**: interactive primary-model, fallback-model, and thinking config via TUI (external CLIs listed first)
- **`/codex-headers` command**: per-provider Codex request-header compat (`originator` / `User-Agent` / `OAI-Product-Sku`) for 公益站 / reverse proxies
- **`/launch` command**: let the current agent analyze workflow tasks, then open independent Windows Terminal tabs in parallel (`-t` / `--direct` keeps an explicit single-tab escape hatch). **Three task modes**: `workflow` (full search→plan→implement→review pipeline), `research` (deep research only — parallel searchers, research report, Wiki maintenance, no implementation), and `execute` (conclusion already settled — skip search/planning, implement → review → Wiki wrap-up), selectable via `--research` / `--execute` / `mode` per task.
- **Tab reclaim** (ultra-long task infra): `launch-tabs` returns a stable `runId` per tab; `tab-status` inspects phase, `reclaim-tabs` collects results (`ready/pending/awaitingInput/failed/orphaned`) for the next batch; tabs report lifecycle via `PI_TAB_RUN_ID` and finish via the `tab-finish` tool.
- **Auto-push timers**: `set-timer({message, delayMs, target})` — when the timer expires the system auto-sends a user message to advance work (`target=self` or a tab's `runId`); `launch-tabs` per-task `timers` param preloads a tab's mailbox.

## External CLI backends

Inspired by [pi-flow-external](https://github.com/tranhoangnguyen03/pi-flow-external), but integrated into the existing `subagent-win` tool surface (no separate `Agent` tool install required).

| Model ref | Spawns | Notes |
|-----------|--------|--------|
| `cli:claude` | `claude` | stream-json, `--dangerously-skip-permissions`, **CLI default model** |
| `cli:codex` | `codex exec --json` | stdin prompt, sandbox/approvals bypassed, **CLI default model** |
| `cli:agy` | `agy` | plain stdout capture, native `--effort`, **CLI default model** |
| `cli:atomcode` | `atomcode -y -p <prompt>` | headless plain stdout capture, no-approval mode, **CLI default model** |

**Policy:** never pass `--model` / model ids to external harnesses. Configure models inside Claude Code / Codex / Antigravity / AtomCode themselves. Refs like `cli:claude/sonnet` are rejected.

Prerequisites: the chosen CLI must be on `PATH` and authenticated. This package does not install those CLIs.

### Use from tool call

```ts
// Backend selector only — uses each CLI's own default model
subagent-win({ agent: "searcher", model: "cli:claude", task: "Map this repo read-only." })
subagent-win({ agent: "code-reviewer", model: "cli:codex", task: "Review the diff." })
subagent-win({ agent: "planner", model: "cli:agy", task: "Draft a plan." })
subagent-win({ agent: "searcher", model: "cli:atomcode", task: "Explain this repository read-only." })

// Run the subagent inside a separate git worktree, not the main checkout.
subagent-win({
  agent: "implementer",
  cwd: "G:/code/worktrees/GreenCAD-123",
  task: "Implement the requested change and run tests.",
})
```

### Consultant — user-named model evaluation / screenshot design

When the user names a specific model for evaluation, consultation, or screenshot-based design (e.g. “请glm来评估一下”, “请gpt5.6看看截图仿照一下进行设计”), dispatch the `consultant` agent and pass the user-named model as the `model` override. Short aliases like `glm` / `gpt5.6` / `opus4.6` auto-expand to `provider/id`. The consultant answers from that model's perspective and never touches business code (unless asked). For screenshots, include the image path(s) in the `task` — the consultant reads them with the `read` tool.

```ts
// User said: 请glm来评估一下这次重构的方案
subagent-win({ agent: "consultant", model: "glm", task: "请以 glm 视角评估 plans/0712_refactor.md 的方案…" })

// User said: 请gpt5.6看看截图仿照一下进行设计
subagent-win({ agent: "consultant", model: "gpt5.6", task: "请看截图 C:/shots/ui_ref.png，提炼视觉语言并给出仿照设计方案…" })

// No model named by the user → consultant runs its config default
subagent-win({ agent: "consultant", task: "评估当前代码中缓存策略的风险点…" })
```

### Configure via `/sub-models`

1. Run `/sub-models` in TUI
2. Pick an agent (searcher / planner / …)
3. Model list starts with:
   - `(use pi default)`
   - `cli:claude` / `cli:codex` / `cli:agy` / `cli:atomcode` (shows available / not on PATH)
   - then normal pi `provider/id` models
   - When the list is long, a **filter box** appears: type to fuzzy-match (e.g. `glm`, `claude`, `Zhipu/`), `↑↓` to move, `Enter` to select, `Esc` to cancel.
4. Optional fallback + thinking as before

Text form still works:

```text
/sub-models searcher cli:claude
/sub-models code-reviewer fallback cli:codex,Zhipu/glm-5.2
```

### Configure via `/codex-headers`

Per-provider rewrite of outbound LLM request headers so pi looks more like Codex CLI (`originator=codex_cli_rs`, matching `User-Agent`, optional `OAI-Product-Sku: codex`). Useful for reverse proxies / 公益站 that fingerprint clients.

**Config file (independent of agent `config.json`):** `~/.pi/agent/codex-headers.json`

```json
{
  "enabled": true,
  "providers": {
    "my-proxy": {
      "enabled": true,
      "originator": "codex_cli_rs",
      "userAgent": "codex_cli_rs/0.1.0 (Windows_NT 10.0; x64)",
      "productSku": true
    }
  }
}
```

1. Run `/codex-headers` in TUI
2. Toggle global, or **Enable current provider**, or **Manage providers…**
3. Per provider: enable/disable, edit originator / User-Agent, toggle product SKU

Text form:

```text
/codex-headers status
/codex-headers on|off
/codex-headers current on
/codex-headers my-proxy on|off
```

**How it works:** `before_provider_headers` marks the request; a lightweight `globalThis.fetch` wrap re-applies headers after pi-ai’s `openai-codex-responses` path hardcodes `originator: pi`. Marker never leaves on the wire. Changes apply immediately (no `/reload`). Default is **global OFF** — only listed providers are rewritten.

**Not covered yet:** JWT/`chatgpt-account-id` extraction failures for non-JWT API keys (separate problem from header fingerprinting).

### Design notes

- Role agents (`agents/*.md`) stay the same; only the **runtime backend** changes when model starts with `cli:`.
- **Worktree isolation**: pass `cwd` on a single task or each parallel task. The pi child and every external CLI child inherit that directory, so `cli:claude`, `cli:codex`, `cli:agy`, and `cli:atomcode` operate in the requested worktree.
- System prompt = agent body (or `systemPrompt` override); task is the user prompt.
- Thinking from config/frontmatter is forwarded (`--effort` for Claude and Agy; `model_reasoning_effort` for Codex). AtomCode uses its CLI defaults; model selection is never forwarded.
- External CLIs run with no-approval / dangerous modes — use only in trusted repos (same policy as pi-flow-external).
- Windows-aware spawn: resolves `.exe` / `.cmd`, no process-group kill on win32.
- **Windows proxy bridge**: explicit `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` inherited by pi take priority. When none exist, subagent-win reads an enabled Windows system proxy (WinINET) and forwards it as upper- and lower-case standard proxy variables to every external CLI, including agy and AtomCode. `ProxyOverride` is translated to `NO_PROXY`.

## `/launch` command — workflow orchestration and visible tabs

`/launch <request>` is an orchestration request. It sends a turn to the **current** agent, which can inspect the conversation, identify independent ready tasks, and call `launch-tabs` once to open all visible tabs in parallel. It does not open a tab for the natural-language request itself.

### Usage

```text
/launch [--model <model>] <orchestration request>
/launch --research [--model <model>] <orchestration request>
/launch --execute [--model <model>] <orchestration request>
/launch -t <title> [--model <model>] <single task>
/launch -t <title> --research <single research task>
/launch -t <title> --execute <single execute task>
/launch --direct [--model <model>] <single task>
/launch --direct --research <single research task>
/launch --direct --execute <single execute task>
```

| Form | Description |
|------|-------------|
| `/launch <request>` | Let the current agent analyze the conversation and dispatch multiple ready tasks through `launch-tabs`. |
| `/launch --research <request>` | Same orchestration, but research-type tasks must be dispatched with `mode: "research"` (deep research only). |
| `/launch --execute <request>` | Same orchestration, but settled-conclusion tasks must be dispatched with `mode: "execute"` (skip search/planning). |
| `/launch -t <title> <task>` | Explicitly launch one visible pi tab immediately. |
| `/launch --direct <task>` | Explicitly launch one tab immediately; title is derived from the task. |
| `-r` / `--research` | Deep-research mode: the tab (when bound to a task number) starts with `根据research进行工作<taskId>` and a research discipline block — parallel searchers, `plans/YYYYMMDD_research_<topic>.md` research report, Wiki theme-page maintenance; **no** planner/implementer/code-reviewer stages. |
| `-e` / `--execute` | Quick-execute mode: the tab (when bound to a task number) starts with `根据execute进行工作<taskId>` and an execute discipline block — skip search and planning, implementer implements the settled conclusion, code-reviewer reviews, Wiki wrap-up; **no** searcher/planner/plan-reviewer stages. |
| `--model <model>` | Optional model for directly launched sessions, or a constraint forwarded to the workflow dispatcher. |

### Example

```text
# The current agent analyzes the ready tasks and opens three tabs, if justified
/launch 你来并行启动已满足条件的任务

# The three initial prompts are produced from the current workflow context,
# and each starts with: 根据workflow进行工作1007 (or 1008 / 1009)

# Explicit one-tab escape hatch; the -t value is only the label part,
# and the final tab title is composed as <repo>[-worktree]-[<taskId>-]<label>
/launch -t detector-lifecycle Fix 1004 detector lifecycle
/launch --direct Clean up 1010 Provider deprecated enums
```

### How it works

1. A no-title invocation is sent back to the current agent with its full conversation context.
2. The agent analyzes dependencies and calls `launch-tabs` once with all independent tasks.
3. `launch-tabs` normalizes every initial prompt to `根据workflow进行工作<taskId>` (or `根据research进行工作<taskId>` for `mode: "research"`, `根据execute进行工作<taskId>` for `mode: "execute"`), appends a **mandatory discipline block** (read the `workflow-orchestrator` skill, act as project manager and delegate stages to `subagent-win` agents — never complete the task in one shot; research mode delegates parallel searchers and writes a research report; execute mode skips search/planning and only runs implementer → code-reviewer → Wiki wrap-up), and guarantees the skill is visible in the tab via `--skill`. Then it starts one `wt.exe new-tab` per task.
4. Each spawned pi session is visible, interactive, independent, and starts fresh with project context (`AGENTS.md`, Wiki, etc.).
5. `-t` / `--direct` bypass the orchestration conversation step for an explicitly requested single tab. When the task text carries a task number (e.g. `Fix 1004 detector lifecycle`), the tab is still bound to the workflow discipline; without a number it stays a plain ad-hoc session.

## Knowledge rules

- **Wiki/** = theme-oriented durable facts only (`Concepts|Modules|Architecture|Decisions|Workflows`, `status: current`)
- **Search uses Wiki first** — only for a new/unlocated topic, the searcher splits it into short phrases, runs `keywords queries=[...]` exact checks, expands exact misses with `semantic-terms` only when configured, then `grep -rni` locates Wiki. It jumps to code via the confirmed page's `source_paths`, cross-checks with codegraph, **proactively maintains theme pages**, and returns every fact with a code location + a Wiki section reference (or `Wiki: none`) + a calibration status.
- **Wiki is reused across agents** — a searcher-confirmed `Wiki/path.md#section` is the current workflow's canonical handoff. The main agent forwards that section list to planner/implementer/reviewer; they `read` it directly and do not rerun terminology discovery for already located topics. Task findings never go to Wiki.
- **`wiki-nav` tool** — progressive navigation over `Wiki/_navigation.json`: `tree`/`around`/`path` fetch nearby nodes; `find` uses the v2 index over page metadata **and Markdown body**; `keywords` presents a capped, automatically generated **global searchable-term list only**. It contains no page mappings, source paths, or Markdown headings; select a term then use `grep -rni` to locate it. Tree output is explicitly trimmed; `tree node` accepts a real page id/title/unique alias, not merely a directory name.
- **`wiki-nav rebuild`** — after any wiki page is created/updated/merged/deleted, run `wiki-nav rebuild` to regenerate `_navigation.json`, v2 full-text `_search.json`, and `_keywords.json` from `Wiki/*.md` (TS, self-contained, sub-second). `_keywords.json` derives high-signal terms only from page metadata, source-path file/symbol tails, inline symbols, and emphasis; it is not hand-maintained. `keywords queries=[...]` performs simultaneous exact checks; only misses may use `semantic-terms`.
- **Optional semantic term expansion** — configure an OpenAI-compatible embedding provider in `~/.pi/agent/embeddings.json` using [examples/embeddings.json](examples/embeddings.json) as the provider/model registry template. `semantic-rebuild` is explicit and the only action that embeds all changed terms remotely; it persists a private local USearch HNSW index under `~/.pi/wiki-semantic/`. `semantic-terms` returns terms only, never Wiki paths or chunks; select one and `grep -rni` to locate it.
- **Task findings** = agent replies or `plans/*_research.md` — not Wiki
- **Plans** = `plans/` · **Progress** = `recentwork.md`
- Goal mode: omit `token_budget` unless user sets one
- Subagents load project `AGENTS.md` (no `--no-context-files`) when using the pi backend
- Models with <200K context should split large exploration into parallel subtasks

## Tab reclaim & timers — ultra-long task orchestration

`launch-tabs` now returns a **`runId`** per dispatched tab (ledger at `~/.pi/agent/tab-runs/<runId>.json`). This enables a closed orchestration loop for hours-long, unattended pipelines:

```text
launch-tabs(batch N) → set-timer(advance message) → reclaim-tabs(batch N) → launch-tabs(batch N+1)
```

- **`tab-status`** `{ runId?, taskId? }` — phase: `dispatched | attached | working | waiting | completed | failed | cancelled | orphaned | unconfirmed`; only `completed/failed/cancelled` **with an explicit result** are terminal.
- **`reclaim-tabs`** `{ runIds, wait?, timeoutMs?, intervalMs? }` — polls until terminal (never kills tabs, never fakes completion); returns `ready[] / pending[] / awaitingInput[] / failed[] / orphaned[]`. A `waiting` tab is **not** done; a terminal tab without a result is `resultMissing: true, completion: "unconfirmed"`.
- **`tab-finish`** (inside the tab) — the only explicit workflow-terminal signal: writes `<runId>.result.json` with status/summary/artifacts. runId comes from the environment, so a tab cannot forge another run's result.
- **Lifecycle telemetry** — the tab process (detected via `PI_TAB_RUN_ID`) writes `attached/working/waiting/orphaned` state from `session_start` / `agent_start` / `agent_settled` / `session_shutdown`; `stop`/`toolUse` are **never** treated as workflow completion.
- **`set-timer` / `cancel-timer` / `list-timers` / `/timers`** — when a timer expires the system auto-sends a user message to advance work (`target=self`, or a tab via `launch-tabs` per-task `timers` param → mailbox `timers/mail/<runId>/`). Busy sessions queue the message (`followUp`), so tool loops are never interrupted. Subagents can neither set timers nor own tab identity.
- **`/tabs`** — human-readable tab list.

## Install

```bash
pi install /path/to/subagent-win
```

Or unpack first, then install the folder. This workspace already pins:

```json
"packages": ["..\\..\\pi-packages\\subagent-win"]
```

in `~/.pi/agent/settings.json`.

## Contents

- `extensions/index.ts` — subagent-win tool + commands
- `extensions/external-cli.ts` — Claude / Codex / Agy / AtomCode spawn runners (library, not a separate extension entry)
- `extensions/wiki-semantic.ts` — optional remote embedding + local USearch HNSW term expansion
- `agents/` — searcher, planner, plan-reviewer, implementer, code-reviewer, consultant
- `skills/workflow-orchestrator/SKILL.md`
- `config.json` — per-agent model/thinking defaults (edit after install with `/sub-models`)
- `package.json` — pi package manifest (`pi.extensions` → `./extensions/index.ts` only)

## Default Agents

| Agent | Default Model | Context |
|-------|--------------|---------|
| searcher | *(configurable via `config.json`)* | — |
| planner | *(configurable via `config.json`)* | — |
| plan-reviewer | *(configurable via `config.json`)* | — |
| implementer | *(configurable via `config.json`)* | — |
| code-reviewer | *(configurable via `config.json`)* | — |
| consultant | *(configurable via `config.json`)* | — |

Consultant is special: its model is **user-driven**. When the user names a model (“请glm来评估一下”, “请gpt5.6看看截图”), dispatch `consultant` with that model as a per-call `model` override; the config default is only the fallback when no model is named.

Override per call: `{ agent: "code-reviewer", model: "anthropic/claude-sonnet-4", task: "..." }`  
Or external: `{ agent: "searcher", model: "cli:claude", task: "..." }` (or `cli:atomcode`)
