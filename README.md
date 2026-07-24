# subagent-win

Windows-friendly pi subagent package: single / parallel / async runs, role agents, workflow-orchestrator skill, and optional external CLI backends (Claude Code / Codex / Antigravity).

**Version:** 0.1.7

## Features

- **Single agent**: `{ agent, task, model? }`
- **Parallel agents**: `{ tasks: [{agent, task, model?}, ...], concurrency? }`
- **Async execution**: `{ agent, task, async: true }`
- **Per-call model override**: pass `model` field with `provider/id` or short alias
- **External CLI backends**: `cli:claude` / `cli:codex` / `cli:agy` (always each CLI's own default model; no model override)
- **Model alias expansion**: short names like `glm-5.2` auto-resolve from `~/.pi/agent/models.json`
- **Smart fallback**: retry on model/auth/rate-limit/**usage-cap (GLM 套餐上限等)** errors using `fallbackModels`; failures return structured `USAGE_CAP` guidance so the main agent can `/model` switch to a higher-tier model
- **Timeout handling**: per-task timeout with partial output preservation
- **Smart text selection**: picks best final answer across multi-turn conversations
- **TUI integration**: rich rendering of calls and results with model/usage info
- **Usage tracking**: per-agent daily token/cost logging
- **`/today-usage` command**: aggregates all sessions + subagent runs for the local calendar day
- **`/sub-models` command**: interactive primary-model, fallback-model, and thinking config via TUI (external CLIs listed first)
- **`/codex-headers` command**: per-provider Codex request-header compat (`originator` / `User-Agent` / `OAI-Product-Sku`) for 公益站 / reverse proxies

## External CLI backends

Inspired by [pi-flow-external](https://github.com/tranhoangnguyen03/pi-flow-external), but integrated into the existing `subagent-win` tool surface (no separate `Agent` tool install required).

| Model ref | Spawns | Notes |
|-----------|--------|--------|
| `cli:claude` | `claude` | stream-json, `--dangerously-skip-permissions`, **CLI default model** |
| `cli:codex` | `codex exec --json` | stdin prompt, sandbox/approvals bypassed, **CLI default model** |
| `cli:agy` | `agy` | plain stdout capture, native `--effort`, **CLI default model** |

**Policy:** never pass `--model` / model ids to external harnesses. Configure models inside Claude Code / Codex / Antigravity themselves. Refs like `cli:claude/sonnet` are rejected.

Prerequisites: the chosen CLI must be on `PATH` and authenticated. This package does not install those CLIs.

### Use from tool call

```ts
// Backend selector only — uses each CLI's own default model
subagent-win({ agent: "searcher", model: "cli:claude", task: "Map this repo read-only." })
subagent-win({ agent: "code-reviewer", model: "cli:codex", task: "Review the diff." })
subagent-win({ agent: "planner", model: "cli:agy", task: "Draft a plan." })
```

### Configure via `/sub-models`

1. Run `/sub-models` in TUI
2. Pick an agent (searcher / planner / …)
3. Model list starts with:
   - `(use pi default)`
   - `cli:claude` / `cli:codex` / `cli:agy` (shows available / not on PATH)
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
- System prompt = agent body (or `systemPrompt` override); task is the user prompt.
- Thinking from config/frontmatter is forwarded (`--effort` for Claude and Agy; `model_reasoning_effort` for Codex). Model selection is never forwarded.
- External CLIs run with no-approval / dangerous modes — use only in trusted repos (same policy as pi-flow-external).
- Windows-aware spawn: resolves `.exe` / `.cmd`, no process-group kill on win32.
- **Windows proxy bridge**: explicit `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` inherited by pi take priority. When none exist, subagent-win reads an enabled Windows system proxy (WinINET) and forwards it as upper- and lower-case standard proxy variables to every external CLI, including agy. `ProxyOverride` is translated to `NO_PROXY`.

## Knowledge rules

- **Wiki/** = theme-oriented durable facts only (`Concepts|Modules|Architecture|Decisions|Workflows`, `status: current`)
- **Task findings** = agent replies or `plans/*_research.md` — not Wiki
- **Plans** = `plans/` · **Progress** = `recentwork.md`
- Goal mode: omit `token_budget` unless user sets one
- Subagents load project `AGENTS.md` (no `--no-context-files`) when using the pi backend
- Models with <200K context should split large exploration into parallel subtasks

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
- `extensions/external-cli.ts` — Claude / Codex / Agy spawn runners (library, not a separate extension entry)
- `agents/` — searcher, planner, plan-reviewer, implementer, code-reviewer
- `skills/workflow-orchestrator/SKILL.md`
- `config.json` — per-agent model/thinking defaults (edit after install with `/sub-models`)
- `package.json` — pi package manifest (`pi.extensions` → `./extensions/index.ts` only)

## Default Agents

| Agent | Default Model | Context |
|-------|--------------|---------|
| searcher | opencodego/deepseek-v4-flash | 1000K |
| planner | openai-codex/gpt-5.6-sol | 372K |
| plan-reviewer | Zhipu/glm-5.2 | 400K |
| implementer | opencodego/deepseek-v4-flash | 1000K |
| code-reviewer | openai-codex/gpt-5.6-terra | 372K |

Override per call: `{ agent: "code-reviewer", model: "Zhipu/glm-5.2", task: "..." }`  
Or external: `{ agent: "searcher", model: "cli:claude", task: "..." }`
