# Changelog

## [0.2.2] — 2026-08-11

### Fixed
- **Timer / report 投错对话（身份隔离）**：此前任何无 `--tab-run-id` 的 pi 进程（不同目录的主会话、直开标签页、手动打开的 pi 窗口）都被当作"主会话"，会抢 `~/.pi/agent/timers/*.json` 的 self timer 和 `~/.pi/agent/reports/*.json` 的回报，导致编排消息/任务回报落到无关目录的会话（实证：233 重复 timer 同秒双发、task 238 回报投到 subagent-win 会话）。
  - `set-timer` 的 self timer 记录 `ownerCwd`（+ `ownerSessionId`）；identityless 进程只消费 `ownerCwd == 自己 cwd` 的 root timer，旧账本（无 ownerCwd）一律不消费（宁可静默不投错）；repeat 消费时重新盖章 `ownerSessionId`（重启后同目录新会话可接手）。
  - 标签页内 `target=self` 的 timer 现在写入**自己的邮箱**（此前写根目录被主会话抢走）；标签页的 `cancel-timer` / `list-timers` 缺省也指向自己邮箱。
  - `tab-report` 回报按派发溯源（links.jsonl：tab runId → 派发会话 UUID）定位接收方，只有派发该 tab 的会话消费；其他 identityless 进程不再抢（`.notified` 仍做跨实例去重）。
  - `/launch` 直开标签页也注入 runId + 派发账本（`direct: true`），不再是无身份进程（可正常用 tab-report、不抢 root timer）。

## [0.2.1] — 2025-08-05

### Added
- Consultant agent: user-named model evaluation / screenshot design (`agent="consultant"`)
- `/launch` command: workflow orchestration with visible Windows Terminal tabs
  - `--research` / `-r` mode: deep research only (parallel searchers → research report → Wiki maintenance)
  - `--execute` / `-e` mode: quick execute (skip search/planning → implement → review → Wiki wrap-up)
- `launch-tabs` tool: parallel tab launch with normalized workflow prompts and discipline blocks
- `wiki-nav` tool: progressive Wiki navigation (tree / around / find / keywords / path / rebuild)
- `wiki-semantic` extension: optional remote embedding with local USearch HNSW term expansion
- `notify-windows` extension: Windows Toast notifications for subagent events
- `codex-headers` extension: per-provider Codex request-header compat (`originator`, `User-Agent`, `OAI-Product-Sku`)
- External CLI backends: `cli:claude`, `cli:codex`, `cli:agy`, `cli:atomcode`
- WinINET proxy bridge for external CLI child processes on Windows
- `searchableSelect` TUI component: fuzzy-filtered model picker for large lists

### Changed
- Fallback chain now surfaces `priorFailures` with structured `USAGE_CAP` / `RATE_LIMIT` / `AUTH` / `PROVIDER` / `TIMEOUT` / `OTHER` classification
- Zhipu/GLM bare HTTP 429 treated as `USAGE_CAP` (package quota exhaustion) rather than rate-limit
- Tab title naming: `<repo>[-worktree]-[<taskId>-]<label>`, no meaningless `wlc` defaults
- `buildWorkflowTabPrompt` supports three modes: `workflow`, `research`, `execute`

### Fixed
- `mergeProviderError` prioritizes quota/usage-cap wording from stderr
- `pickBestAssistantText` prefers structured final answers over short tool-use narration
- `collectMainSessionUsage` parses JSONL timestamps directly (file names/mtimes are not reliable)

## [0.1.7] — 2025-07-30

### Added
- `USAGE_CAP` failure classification: surfaces Zhipu/GLM package quota exhaustion as a distinct retryable failure kind
- Main-agent guidance: when `USAGE_CAP` is detected, instructs the main agent to switch model via `/model` instead of retrying

### Changed
- `formatFailureForMainAgent` now includes explicit `ACTION_REQUIRED` instructions for usage-cap and provider failures
- Fallback chain UI: TUI shows `↺fallback×N` badge and per-attempt failure details

## [0.1.6] — 2025-07-24

### Added
- `codex-headers` extension: per-provider Codex header compat (`originator`, `User-Agent`, `OAI-Product-Sku`)
- `before_provider_headers` event handler + `globalThis.fetch` wrap for wire-level header rewrite
- `/codex-headers` command with interactive TUI menu and text mode

### Changed
- `package.json` description updated to reflect Codex header compat feature

## [0.1.5] — 2025-07-23

### Added
- Initial release: subagent-win v0.1.5
- Core subagent execution: single, parallel, async modes
- Role agents: searcher, planner, plan-reviewer, implementer, code-reviewer
- Per-call model override with short alias expansion from `~/.pi/agent/models.json`
- Smart fallback chain with retryable failure classification
- Timeout handling with partial output preservation
- TUI integration with rich rendering of calls and results
- Usage tracking: per-agent daily token/cost logging
- `/today-usage` command: aggregates all sessions + subagent runs
- `/sub-models` command: interactive model/fallback/thinking config
- `workflow-orchestrator` skill: multi-step workflow orchestration (search → plan → review → implement → review → Wiki wrap-up)
- Windows Toast notifications via `/notify` command