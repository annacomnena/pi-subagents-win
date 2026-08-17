# Changelog

## [Unreleased] — 2026-08-13

### Added
- External CLI backend `cli:mimo` (MimoCode): resolves `MIMOCODE_BIN`, then `%USERPROFILE%\.mimocode\bin\mimo.exe`, then PATH; runs `mimo run <prompt> --format json --dangerously-skip-permissions --dir <cwd>` and parses its JSON event stream. The CLI's own configured provider/model and credentials remain authoritative.
- External CLI backends: `cli:claude`, `cli:codex`, `cli:agy`, `cli:atomcode`, `cli:zcode` (the latter spawns `node D:\Software\zcode\resources\glm\zcode.cjs -p <prompt> --cwd <cwd>`, plain stdout capture, fixed GLM-5.3)

### Changed
- **派发 tab 多开无用标签页修复（wt 命令行 prompt 物化）**：`wt.exe` 会用自有 tokenizer 重解析命令行——**含换行的参数被拆成多条命令**，剩余行变成标题/内容都是首轮 prompt 残留的无用 tab（实证：workflow 派发几乎必现，因派发 prompt 恒为多行）。新增 `wtPromptArg`：凡含换行/`;`/引号/`%`（wt 的分号命令分隔、引号解析、%env% 展开）的 prompt 一律物化为临时 `@file`（pi 原生 `pi @file.md` 机制读文件内容当首轮消息），wt 命令行上只留一个不含换行的 `@路径`；安全单行 prompt 保持内联零变化。临时文件写入 `~/.pi/agent/launch-prompts/`，5 分钟后自动删除 + 顺带清理 24h 前陈旧文件。接入点：`dispatchPiTab`（launch-tabs 与 /launch 的唯一 wt 派发入口）。`_test_launch.ts` 新增物化/清理/内联用例。
- **派发时强提醒完成回报（tab-finish）**：针对部分子 tab 完成任务后不调 `tab-finish`（停在 waiting/resultMissing，主会话等不到 event-bus 唤醒）——`workflowDisciplineBlock` 的**三种模式**（workflow/research/execute）统一附加「⚠️【完成回报 · 强制】」行：全部工作完成后必须调用 `tab-finish`（status/summary/artifacts/reportPath），不调 = 未完成、主会话会一直等；workflow-orchestrator SKILL.md 同步（核心原则 12 + 阶段 5/R3/E3 收尾各加「回报主会话（强制）」）；`tab-finish` 工具描述也加了「【完成回报 · 强制】你是主会话派发的任务 tab」声明。`_test_launch.ts` 新增三模式均含 tab-finish 提醒的断言。
- **`reclaim-tabs` 移除轮询硬等，永不阻塞**：此前 `wait:true` 会进入 sleep 轮询循环（默认 2 分钟、可被显式拉满 10 分钟）且忽略中止信号（Esc 无法终止），实测会在主会话硬卡数分钟。现在工具**始终立即返回单次快照**（wait/timeoutMs/intervalMs 降为废弃 no-op 参数仅保向后兼容），完成感知完全交给 event-bus（子 tab 写 result.json 自动唤醒主会话），编排巡检用 set-timer。删除了 `RECLAIM_*` 常量和不再使用的 `sleep()`。README §5.1 同步更新。
- **timer 基建加固（三方评估后落地的 P1/P2）**：
  - 投递改 **at-least-once**：`fireOneTimer` 先 `sendUserMessage` 成功才落账（one-shot 置 fired / repeat 重置 pending），send 失败保持 pending 下个 tick 自动重试——原实现先置 fired 再 send，失败即永久丢消息。
  - **所有权门槛加会话活性**：`rootTimerConsumable` 现在同时比对 `ownerCwd` 与 `ownerSessionId`——owner 心跳存活时只有 owner 自己可消费（同 cwd 多主会话防双发）；owner 失活（心跳缺失/超宽限）其他同目录会话可接手（保留重启接管耐久性）。新增 `timers/sessions/<id>.json` 心跳，调度器每 tick 刷新，宽限 15s。
  - **终态 GC**：`sweepTerminalTimers` 清理超过 24h 的 fired/cancelled/missed 文件；`sweepStaleHeartbeats` 清理失活心跳。调度器每 12 tick（≈60s）执行一次，账本不再无限膨胀。
  - **tick 连续失败报警**：连续 3 次 tick 异常向会话注入报警消息（不再静默吞掉）。
  - **路径注入防护**：`timerId`/`tabRunId` 须匹配 `SAFE_ID_PART`（拒绝 `../`、`/` 等危险组件），`listTimerFiles` 同步过滤。
  - **容量措辞修正**：set-timer 描述改为「每个目标（self 或单个 tab 邮箱）最多 50 个 pending」。
  - `registerTimers` 增加可选 `opts.timersDir`（测试可注入目录）。
- **回归测试**：`_test_timers.ts` 新增心跳/所有权门槛/终态 GC/路径安全用例；`_test_timers_runtime.ts` 新增「投递失败重试（at-least-once）」与「registerTimers 注册的 set/list/cancel 工具 + /timers 命令实际执行」用例（覆盖 isSubagentProcess 类闭包漏定义）；`_test_tab_runs_runtime.ts` 同步 reclaim-tabs 非阻塞语义。

### Fixed
- **event-bus 完成消息投错会话（溯源路由缺失）**：tab 完成时 event-bus 的唤醒权是「任意 identityless 进程 claimNotified 先到先得」——多个主会话形态的 pi 进程（不同目录/同一目录不同会话）同时 watch，谁先抢到就把「⏱ Tab 已完成」注入**自己**，真正派发该 tab 的编排会话收不到回报（实证：GreenCAD 编排会话 019ff8b4 派发的 275-280 完成消息全部落到无关的 Annacomnena 会话 019ff89d）。修复：`onTabResultFile` 在 claim 前先按 `links.jsonl` 溯源（`recipientSessionIdFor`，与 report.ts 0.2.2 同一模式）——只注入给派发该 tab 的会话；其他会话静默跳过（不 claim/不 toast/不注入），把唤醒权留给真正的编排会话；溯源解析不到（旧账本无 sessionId）时回退 claim 先到先得。`registerEventBus` 的 session_start 同步捕获本会话 UUID。`_test_event_bus.ts` 新增会话定位回归（非派发会话跳过 / 派发会话注入 / 无溯源回退）。
- **`set-timer` / `cancel-timer` / `list-timers` / `/timers` 全部抛 `isSubagentProcess is not defined`**：`timers-runtime.ts` 在 4 处引用了 `isSubagentProcess` 但从未定义/导入（`tab-runs-runtime.ts` 有 `const isSubagentProcess = isSubagent()`，timers 文件漏了），导致计时器整套工具在运行期直接崩溃。在 `registerTimers()` 开头补齐与 tab-runs-runtime 一致的定义。

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