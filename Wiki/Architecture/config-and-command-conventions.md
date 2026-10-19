---
title: 扩展命令面与测试隔离约定
kind: architecture
status: current
updated: 2026-10-14
source_paths:
  - extensions/index.ts#L3825
  - extensions/index.ts#L3903
  - extensions/index.ts#L3596-L3821
  - extensions/index.ts#L3877-L3903
  - extensions/model-presets.ts
  - extensions/lite-mode.ts
  - extensions/tiers.ts#L141-L144
  - extensions/tiers.ts#L521-L540
  - extensions/tiers.ts#L762-L808
  - extensions/index.ts#L3916
  - extensions/_test_tiers.ts
  - extensions/_test_tiers_usage.ts
  - extensions/codex-headers.ts#L51-L86
  - extensions/capabilities.ts#L29-L77
  - extensions/_test_model_presets.ts
  - extensions/_test_readconfig_preserve_keys.ts
  - extensions/_test_lite_mode.ts
  - extensions/_test_links.ts#L11
  - node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts#L72-L80
  - node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts#L219
  - node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts#L1123-L1183
---

# 扩展命令面与测试隔离约定

## Summary

subagent-win 扩展的 slash 命令遵循一条稳定范式：**`index.ts` 只做接线，命令逻辑独立成模块，config 读写经 `CommandDeps` 结构类型注入**，从而避免 `index.ts` 继续膨胀并让命令可单测（注入内存 deps，零写真实文件）。本页记录该范式、命令注册 API 的真实签名、`~/.pi/agent/**` 用户数据小表的路径/缺省惯例、角色名单事实源，以及配套的测试隔离纪律。模型解析 / fallback / `config.json` 读写细节见 [[子代理模型解析 / fallback 链 / 用量账本]]。

## Current Contract

### 1. 命令注册 API（宿主签名）

- `pi.registerCommand(name, options)`（宿主类型 `types.d.ts#L1123-L1183`）：`options = { description?: string; getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null | Promise<...>; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }`。
  - **没有 `args` 字段**：命令参数是 handler 的第一个字符串入参，命令自行 `text.split(/\s+/).filter(Boolean)` 解析；`sourceInfo` 由宿主注入（故 `Omit<RegisteredCommand, "name" | "sourceInfo">`）。
- `ExtensionCommandContext`：`hasUI: boolean`（`types.d.ts#L219`）+ `ui: ExtensionUIContext`（`types.d.ts#L72-L80`）：
  `select(title, options: string[], opts?) : Promise<string | undefined>`、`input(title, placeholder?, opts?) : Promise<string | undefined>`、`confirm(title, message, opts?)`、`notify(msg, "info" | "warning" | "error") : void`；`opts: ExtensionUIDialogOptions = { signal?, timeout? }`（`types.d.ts#L40-L45`）。
- **无 UI 回退**：命令先判 `ctx.hasUI`——TUI 走 `select`/`input` 交互菜单，非 TUI（print 模式 / 测试 mock）回退纯文本输出或参数校验错误。`/sub-presets` 无参数且无 UI 时等同 `list`。

### 2. deps 注入范式（逻辑外置）

- 独立模块导出 `registerXxxCommand(pi, deps)`，`deps` 是最小结构类型 `{ reloadConfig: () => XxxConfigLike; writeConfig: (cfg: XxxConfigLike) => void }`；`XxxConfigLike` 结构兼容 `index.ts` 的 `AgentConfig`（只声明自己需要的切片），因此 `writeConfig` 才能保留其余字段。
  - `/sub-presets`：`extensions/model-presets.ts`，`registerSubPresetsCommand`（`#L271`）、`CommandDeps`（`#L266-L269`）。
  - `/lite`：`extensions/lite-mode.ts`，`registerLiteCommand`（`#L102`）、`CommandDeps`（`#L91-L94`）。
  - `/tiers`：`extensions/tiers.ts`，`registerTiersCommand`（`#L762`）、`TiersDeps`（多一个 `readUsageRecords` 注入）；契约见 [[子代理模型解析 / fallback 链 / 用量账本]] §8。
  - 接线：`registerSubPresetsCommand(pi, { reloadConfig, writeConfig })`（`index.ts#L3825`）、`registerTiersCommand(pi, { reloadConfig, writeConfig, readUsageRecords })`（`index.ts#L3916`）、`registerLiteCommand(pi, { reloadConfig, writeConfig })`（`index.ts#L3903`）。
- **写命令通用纪律**：先 `deps.reloadConfig()` 拿最新对象、只改自己那个键/切片、再 `deps.writeConfig(cfg)`（保留其它 owner 字段；见 [[子代理模型解析 / fallback 链 / 用量账本]] §6）。`/sub-presets` 的 `applyPreset`（`model-presets.ts#L189-L196`）整体替换 `models/fallbackModels/thinking` 三张表后写回。
- **多子命令样板**：`/sub-presets`（`model-presets.ts#L272` 起 handler）——`parts[0].toLowerCase()` 分派 `list|save|load|show|clear|rename`；无参数且 `ctx.hasUI` 时 `ctx.ui.select(ACTIONS)` 菜单 + `switch` 到 `interactiveXxx`；每个子命令校验参数后用 `notify(..., "error")` 给用法。同文件内 `/sub-models`（`index.ts#L3596`）是另一多子命令样板（交互选 agent/模型 + `set a=b` 批量 + `agent fallback|thinking`）。

### 3. `~/.pi/agent/**` 用户数据小表：路径 / 缺省 / 写盘

| 模块 | 路径常量 / 函数 | env 覆盖 | 写盘 |
|---|---|---|---|
| 模型预设 | `PRESETS_PATH = join(homedir(), ".pi", "agent", "subagent-model-presets.json")`（`model-presets.ts#L50`） | **无** | `writeStore` 直接 `writeFileSync`（非原子） |
| Codex 请求头 | `CONFIG_PATH() = join(CONFIG_DIR(), "codex-headers.json")`（`codex-headers.ts#L51-L53`） | `PI_CODING_AGENT_DIR` | `writeCodexHeadersConfig` 直接 `writeFileSync`（非原子） |
| trace-fusion 信任 | `join(homedir(), ".pi", "agent", "trust.json")`（`trace-fusion/trust.ts#L22`） | 无 | tmp+rename（`trust.ts#L69-L70`） |
| hotspot 工作集 | `PI_CODING_AGENT_DIR ?? ~/.pi/agent`（`hotspot/store.ts#L32-L36`） | `PI_CODING_AGENT_DIR` | 快照 tmp+rename（`store.ts#L182-L183`） |
| steer 回执 | `defaultSteerDir(agentDir = ~/.pi/agent)`（`steer.ts#L121`） | 注入 `agentDir` | tmp+rename（`steer.ts#L315-L316`） |
| timers | `defaultTimersDir(agentDir = ~/.pi/agent)`（`timers.ts#L82`） | 注入 `agentDir` | tmp+rename（`timers.ts#L279-L280`/`#L404-L405`） |
| 用量账本 | `USAGE_DIR = PI_SUBAGENT_USAGE_DIR ?? ~/.pi/agent/subagent-usage`（`index.ts#L1428`） | `PI_SUBAGENT_USAGE_DIR` | 逐行 append |
| 模型成本层级 | `costTiersPath() = PI_MODEL_COST_TIERS_PATH ?? ~/.pi/agent/model-cost-tiers.json`（`tiers.ts#L141-L144`） | `PI_MODEL_COST_TIERS_PATH` | tmp+rename（EPERM×3，`tiers.ts#L521-L540`） |
| 模型目录（只读） | `~/.pi/agent/models.json`、`~/.pi/models.json`（`index.ts#L496-L497`、`codex-headers.ts#L222-L223`） | — | 不写 |
| agent 目录（只读） | `<PKG_DIR>/agents`、`~/.pi/agent/agents`、`<cwd>/.pi/agents`（`index.ts#L582-L586`，`discoverAgents`） | — | 不写 |

- 缺省惯例一致：文件不存在 / 坏 JSON → 回落纯缺省对象，never-throw（`emptyStore`/`emptyConfig`/`emptyUsage`）。
- 原子写惯例不统一：新代码优先 tmp+rename（同 `index.ts::writeConfig`，Windows 下需 EPERM×3 重试）；`PRESETS_PATH` 与 `codex-headers.json` 仍是裸写。无 env 覆盖的小表（如 `PRESETS_PATH`）测试须备份真实文件。

### 4. 角色名单事实源（无单一常量表）

- `agents/*.md` 目录（7 个）：`searcher`、`planner`、`plan-reviewer`、`implementer`、`code-reviewer`、`consultant`、`general`；`discoverAgents()` 扫描 frontmatter `name`（`index.ts#L581-L610`）。
- `config.json` 的 `models`/`fallbackModels`/`thinking` 键：真实文件含 6 个（不含 `general`）；`/sub-models` 用「agents 名 ∪ 三张表键」求并集（`index.ts#L3602-L3606`）。
- `capabilities.ts#L58`：workflow-tab 的 `delegateAgents` 白名单 = `["searcher","planner","plan-reviewer","implementer","code-reviewer","consultant"]`（`SessionCapabilities.delegateAgents`，`#L37`）。
- `lite-mode.ts` 的能力档投影：`small→models.searcher`、`medium→models.implementer`、`large→models.consultant`（`liteTiers`，`#L48-L55`）。
- **没有** `AGENT_ROLES` / 角色常量数组。首个「按角色默认值」常量是 `DEFAULT_ROLE_TIER`（`extensions/tiers.ts#L46-L54`，**7 键含 `general`**，契约见 [[子代理模型解析 / fallback 链 / 用量账本]] §8.1）；新增其他按角色默认值时应仿它自建常量并覆盖上述来源的**并集**（含 `general`）。

### 5. 测试约定与隔离纪律

- 单文件测试：`extensions/_test_<topic>.ts`，直接 `import` 被测 `.ts`；断言用 `node:assert/strict`（早期文件用自写 `assert(label, cond)` 计数，二者并存）。
- 运行命令：`node --experimental-strip-types [--import ./extensions/runtime-host/pi-deps-loader.mjs] ./extensions/_test_xxx.ts`。**需要宿主包（`@earendil-works/pi-tui`/`typebox`/`marked`）或 `import index.ts` 时**才加 `--import pi-deps-loader.mjs`（否则裸 Node ESM 解析不到 pi 安装树的 nested `node_modules`）；纯模块测试可省略。`npx tsx` 仅个别测试用（`test:autonomy-actions`）。
- package.json scripts：每个测试一行 `"test:<kebab>": "node --experimental-strip-types [--import …] ./extensions/_test_xxx.ts"`（`test:lite-mode` 见 `package.json#L60`）；个别需先建 junction 依赖的脚本以 `node ./scripts/ensure-pi-test-deps.mjs && …` 开头。**无聚合 runner**；也未强制每个测试登记（`_test_model_presets.ts`、`_test_readconfig_preserve_keys.ts` 目前无 npm script，可手动直跑）。
- 隔离纪律（**跑测试零写真实 `~/.pi/agent/**`**）：
  - 纯注入：`deps` 全内存（`_test_lite_mode.ts` 零碰真实 `config.json`；`_test_model_presets.ts` 传内存 `reloadConfig`/`writeConfig`）。
  - 临时目录：`mkdtempSync(join(tmpdir(), "<prefix>-"))` + `rmSync(dir, {recursive:true, force:true})`（`_test_links.ts#L11`）。
  - env 改道：模块加载时读一次 env，故须在 `import` **之前**设置（`PI_SUBAGENT_USAGE_DIR`/`PI_SUBAGENT_RUNS_DIR`/`PI_LINKS_PATH`/`PI_RUNTIME_DIR`/`PI_MODEL_COST_TIERS_PATH`/`PI_NOTIFY_DISABLE`；见 [[异步 Run 控制面（list / kill）]]「可测试性 env 一览」与 [[子代理模型解析 / fallback 链 / 用量账本]] §8.8）。
  - 真实文件备份/恢复：必须改真实文件时（`_test_model_presets.ts` 改 `PRESETS_PATH`、`_test_readconfig_preserve_keys.ts` 改仓库根 `config.json`）先读原字节，`finally` 原样写回；这两者的已知缺口是被 SIGKILL/硬超时打断会留夹具。
  - 身份环境隔离：测试前清 `PI_SUBAGENT`、`PI_TAB_RUN_ID`、`PI_SESSION_PROFILE`（否则 handler 的 capability/身份 guard 正确拒绝 → 测试假红）。

## Evidence

- 命令注册类型：`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts#L1123-L1183`（`RegisteredCommand` 无 `args`；`registerCommand` 在 `#L1183`）、`#L72-L80`（`ExtensionUIContext`）、`#L219`（`hasUI`）。- `/sub-presets`：`extensions/model-presets.ts#L34`（`PresetConfigLike`）、`#L50`（`PRESETS_PATH`）、`#L68-L86`（read/writeStore）、`#L148-L205`（save/apply）、`#L266-L271`（`CommandDeps`/`registerSubPresetsCommand`）、`#L272` 起 handler。
- `/lite` deps 注入：`extensions/lite-mode.ts#L91-L102`。
- 角色名单：`extensions/capabilities.ts#L29-L77`、`extensions/lite-mode.ts#L48-L55`、`extensions/index.ts#L582-L610`、`#L3602-L3606`、`extensions/tiers.ts#L46-L54`（`DEFAULT_ROLE_TIER`）。
- 测试隔离样板：`extensions/_test_model_presets.ts`、`extensions/_test_readconfig_preserve_keys.ts`、`extensions/_test_lite_mode.ts`、`extensions/_test_links.ts#L11`。
- 配置读写与用量账本细节（本页不重复）：[[子代理模型解析 / fallback 链 / 用量账本]]。

## Links Out

- [[子代理模型解析 / fallback 链 / 用量账本]]
- [[异步 Run 控制面（list / kill）]]

## Backlinks

- [[子代理模型解析 / fallback 链 / 用量账本]]
- [[异步 Run 控制面（list / kill）]]
- [[工具调用可观测与循环判定]]
