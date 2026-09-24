---
title: Hotspot 工作集
kind: module
aliases:
  - Hotspot Working Set
  - Hotspot v4
  - 热点工作集
tags:
  - hotspot
  - working-set
  - cache
  - projection
status: current
source_paths:
  - extensions/hotspot/types.ts#L12-L39
  - extensions/hotspot/decay.ts#L14-L37
  - extensions/hotspot/store.ts#L61-L75
  - extensions/hotspot/collect.ts#L92-L233
  - extensions/hotspot/workset.ts#L29-L100
  - extensions/hotspot/inject.ts#L82-L235
  - extensions/hotspot/tool.ts#L24-L49
  - extensions/hotspot/command.ts#L53-L99
  - extensions/hotspot/log.ts#L28-L46
  - extensions/hotspot/index.ts#L43-L80
updated: 2026-09-24
---

# Hotspot 工作集

## Summary

Hotspot v4（commit `8a9f09a`）是依附于工具事件的**短期工作集 projection**：回答「当前 task/workstream 最近在读/写/验证哪些文件」。它是 cache 不是 memory——可丢失、可重建、非权威、短 TTL、非阻塞；全部存储在 `<agentDir>/hotspot/<wsid>/`，repo 内零运行状态。旧 v2「Wiki 路由缓存」（`Wiki/_hotspot.md` 托管、`hotspot` 工具 upsert/remove）已整体退役，本仓不再读写该文件。

## Current Contract

### v4 定义与三层职责边界

- Hotspot 只维护「当前工作集在哪里」（分钟～数天尺度）；「发生过什么」归 Timeline/recentwork，「最终知道什么」归 Wiki。热度只表示近期活动，不表示重要性/正确性/长期有效，也不直接晋升 Wiki。
- 丢失容忍：删除全部 hotspot 数据不损害任何知识；可由近期工具事件重新积累（`store.ts::readEvents` 每次全量重放分片，`extensions/hotspot/store.ts#L134-L175`）。
- 非阻塞：采集/存储/注入/日志的所有异常路径均静默（如 `collect.ts#L152-L233` 各 try/catch、`store.ts::ensureWorkspace` 失败静默 `extensions/hotspot/store.ts#L77-L86`）。

### 数据模型与常量（types.ts）

- `SCHEMA_VERSION = 4`（`extensions/hotspot/types.ts#L12`）；权重 `WEIGHTS = { write: 3, read: 1, test: 2 }`（`types.ts#L22`）。
- 半衰期 `HALF_LIFE_MS = 12h`；`SOFT_TTL_MS = 48h`（soft 后不参与注入、lookup 可见）；`HARD_TTL_MS = 72h`（hard 后从投影剪除）（`types.ts#L15-L19`）。
- 同 run 上限 `RUN_CAP = { read: 4, write: 3, test: 2 }`（每文件每 kind，防循环刷分；`types.ts#L25`）。
- 投影上限 `WORKSET_TOP_N = 50`（`types.ts#L28`）；注入 `INJECT_MAX_FILES = 5` / `INJECT_MIN_FILES = 2` / `INJECT_CHAR_BUDGET = 560`（≈160 token ×3.5 字符；`types.ts#L31-L33`）；幂等标记 `INJECT_CUSTOM_TYPE = "hotspot-injected"`（沿用 v2 旧值，老会话标记仍能挡重复注入；`types.ts#L36`）；snapshot 节流 `SNAPSHOT_MIN_INTERVAL_MS = 5min`（`types.ts#L39`）。
- 事件行 `HotEvent { v:4, at, kind, path, scope, taskId?, wsId? }`（`types.ts#L45-L56`）；投影条目 `HotEntry`（score/lastSeen/kinds/counts/lastTestAt/ttl∈{fresh,soft}）（`types.ts#L58-L71`）；派生缓存 `HotspotSnapshot`（`types.ts#L73-L77`）。
- 总开关 `hotspotEnabled()`：`PI_HOTSPOT_ENABLED=0|false` → 全部能力不注册，缺省开（`types.ts#L86-L90`）。

### 存储布局与原子写（store.ts）

- 目录：`<agentDir = PI_CODING_AGENT_DIR ?? ~/.pi/agent>/hotspot/<wsid>/{meta.json, events/<pid>-<startTs>-<rand>.jsonl, snapshot.json, log.jsonl}`（`store.ts#L8-L14` 模块头注释、`wsPaths` `store.ts#L65-L75`）；`agentDir` 覆盖入口 `defaultAgentDir()`（`store.ts#L33-L37`）。
- `wsid = sha1(normalizeExactPath(findRepoRoot(cwd))).slice(0,16)`（`store.ts::workspaceIdOf` `#L61-L63`；worktree 各自 `.git` → 各自 wsid，`findRepoRoot` `#L23-L30`）。
- 分片：每进程独占文件名（`newShardName` `#L92-L94`），append-only 无锁（单文件单写者）；`meta.json` 首次建分片 best-effort 写（`ensureWorkspace` `#L77-L86`）。
- 写入侧路径拒绝 `isLegalEventPath`（L4 must-fix 1a）：非法字符（尖括号/控制字符 `ILLEGAL_EVENT_PATH_RE` `#L104`）、空、绝对路径/盘符、`..` 越界段一律不落盘（`#L110-L118`；`appendEvent` `#L122-L130`）。
- 读取容忍：坏行/半行（崩溃残骸）、`v!==4`、坏时间戳全部跳过（`readEvents` `#L134-L175`）。
- snapshot 原子写 `writeSnapshotAtomic`：tmp 名 = `<snapshot>.tmp-<pid>-<randomBytes(4).hex>` + rename，失败清理 tmp（`#L178-L194`）；容忍读 `readSnapshot`（`#L196-L205`）；TTL 清理 `cleanupStaleShards` 删 mtime < now−72h−24h 的分片（`#L221-L241`）。
- snapshot 编排 `writeSnapshotIfDue` 在 index.ts（不放 store.ts 是为避免 store→workset 循环依赖）：主会话 `agent_end` 时，本会话追过分片且距上次写 ≥5min 才写（`extensions/hotspot/index.ts#L43-L61`；注册点 `#L73-L79`）。

### 采集规则（collect.ts）

- 白名单工具 `COLLECT_TOOLS = { edit, write, read, bash }`（`collect.ts#L121`）；grep/find/ls/powershell 等扫描类与其余工具不计；hotspot 自身不计。start 按 `toolCallId` 暂存 args（有界 Map 1024，`#L120`），end 成功才计分，`isError` 不计（`onToolEnd` `#L205-L231`）。
- bash 保守 test 识别 `detectConservativeTest`（`#L98-L118`）：命令含测试关键词（`TEST_KEYWORD_RE` `#L92`）且 token 中**恰好一个**可归一为 repo 内现存**文件**（含 glob `*`/`?` 或多路径即拒绝）→ 记 test；宁缺勿滥。
- 路径归一 `toRepoRelative`（store.ts `#L40-L50`）：root 外绝对路径 → 弃。
- 身份解析 `resolveIdentity`（`#L53-L67`）：子 agent → `{scope:"subagent"}`（不伪造 task_id，拍板 #4）；主会话 → `{scope:"main"}`（无 task_id，拍板 #6）；tab → 派发账本 `externalTaskId` + `enrichRunRefs` 派生 workstream。会话内惰性缓存一次（`sessionHotIdentity` `#L80-L84`）。
- 注册面（`extensions/hotspot/index.ts::registerHotspot` `#L64-L80`）：采集与 lookup 工具在主/Tab/子 agent 全注册；`/hotspot` 命令与注入不注册给子 agent；snapshot 写与 TTL 清理仅主会话。

### 衰减公式（decay.ts）

- `scoreEvents`（`decay.ts#L14-L28`）：`score(t) = score(t0)·2^(−(t−t0)/HALF_LIFE_MS) + weight`，事件按 `at` 升序遍历、事件间先衰减后累加、末次事件到 now 的衰减最后一次性应用；乱序输入容错，坏时间戳/空序列 → 0。
- `ttlState`（`#L33-L37`）：age ≥ 72h → `pruned`（不入投影）；≥ 48h → `soft`（lookup 可见、注入排除）；否则 `fresh`（边界 48:00 整 → soft、72:00 整 → pruned）。

### 投影与 lookup（workset.ts）

- `buildWorkset`（`workset.ts#L29-L46`）：读全部分片（读侧窗口 = now−72h）→ 按 path 聚合 → `scoreEvents` → score 降序（同分按 path 字典序）→ top `WORKSET_TOP_N`（默认 50）。task 视图过滤 `e.taskId===taskId || e.wsId===wsId`，无命中回退 workspace 视图并标注 `fellBack`（主会话工作全在 workspace 视图）。
- `lookupWorkset`（`#L95-L100`）：limit 默认 10（`LOOKUP_DEFAULT_LIMIT` `#L87`）、上限 50（`LOOKUP_MAX_LIMIT` `#L88`）、下限 clamp 1。
- `hotspot` 工具 = **仅 lookup**（`extensions/hotspot/tool.ts::registerHotspotTool` `#L49-L96`）：参数 `task_id`/`workstream_id`/`limit`（typebox schema）；显式参数优先，缺省用当前会话身份；结果文本 `renderLookupText`（`#L24-L45`，存储字段经 `esc`）。旧 read/upsert/remove 已随 v2 退役。
- `/hotspot` 命令 = 只读诊断（`extensions/hotspot/command.ts::buildHotspotReport` `#L53-L97`）：仓库/wsid/身份/参数、条目（score/kinds/lastSeen/ttl）、自动注入开关与本会话注入状态、存储概况；不显示 REM/学习权重/知识分。

### 注入门与幂等（inject.ts）

- 走 `input` 通道（子 agent 不注册；`registerInject` `inject.ts#L237-L256`）；extension 源输入、斜杠命令、空文本直接跳过（`handleInput` `#L179-L235`）。
- 两级门 `planGate`（`#L112-L142`）：**task 门**——当前身份 taskId/wsId 精确命中工作集且任务非终态（`isTaskTerminal` `#L82-L91`，status∈{completed,cancelled,failed}）且 fresh 条目 ≥2；**路径门**——首条用户消息的路径 token（`extractPathTokens` `#L98-L108`，空白+全角/括号再切+标点去边）精确 ∈ workspace 工作集 fresh 条目（≥1 命中后 top-up 到 ≤5 条）。两级皆无 → 拒绝（`no_evidence`）：新任务/身份不明/全局热/模糊相似度都不是证据。
- 幂等双保险（`#L73-L79`、`handleInput` `#L187-L192`）：已有 user 消息（恢复会话）或已有 `hotspot-injected` custom 标记 → 不注入；会话状态不可读 → 不注入（安全侧）。
- 预算 `selectWithinBudget`（`#L181-L194`）：按 score 序逐条尝试，超 560 字符预算**整条省略不截断**；剩 <2 条放弃。
- 工作集已在上下文去重：用户文本已提及候选路径 ≥2 → `already_in_context` 拒绝（`#L199-L201`）。
- 注入块 `renderWorkingSetBlock`（`#L162-L178`）：单个 `<recent-working-set>` 块（任务标识 + ≤5 行 path·kinds·相对时间 + 最近验证入口 + 免责声明），先 `appendCustomEntry` 落档再 transform 返回；决策全量写 `log.jsonl`（`extensions/hotspot/log.ts::logHotspotEvent` `#L28-L36`，kind=inject/lookup，失败静默）。
- 不保留 v2 的 `session_before_compact` 压缩保留提示（返回字段与声明不符；压缩丢块可接受——lookup 工具可重取，`inject.ts#L6-L10` 模块头）。

### 渲染转义（两轮 L4 must-fix）

- 共享单一实现 `esc()`（`extensions/hotspot/types.ts#L96-L99`）：控制字符（C0/DEL，含换行/制表）→ 空格，`<`/`>` → 全角。inject（`renderWorkingSetBlock`）、command（`buildHotspotReport`）、tool（`renderLookupText`）三处统一 import，禁止复制漂移。
- 写入侧 `isLegalEventPath`（store.ts `#L110-L118`）与渲染侧 `esc` 两层独立成立：渲染侧不信任任何已落盘字段（手工注入/旧分片也安全），写入侧从源头保证分片不出现此类 path。

### v2 退役边界

- v2 = 「主题 → Wiki 切片/符号/证据」路由缓存（`Wiki/_hotspot.md` + `_hotspot.trash.jsonl`，`hotspot` 工具 read/upsert/remove）。v4 删除 v2 全部实现（detect/graph/heat/usage/validate/_test_hotspot/_seed_greencad，共 1874 行），**不读写不删除** `Wiki/_hotspot.md`（v2 唯一副本，留作历史）。
- 回退到 v2 = `git revert 8a9f09a`（旧文件未动，可原样恢复）。确认不再回退后，按 v3 计划 §12-4 旧实现退出策略：备份移出仓库并清理 `.gitignore` 的 `state/`/trash 遗留规则。
- 即时关停（无需回退）：`PI_HOTSPOT_ENABLED=0`。

## Key Symbols

- `registerHotspot` — 模块入口与注册矩阵（`extensions/hotspot/index.ts#L64`）。
- `scoreEvents` / `ttlState` — 衰减与 TTL 纯函数（`extensions/hotspot/decay.ts#L14` / `#L33`）。
- `createCollector` / `detectConservativeTest` / `resolveIdentity` — 采集、保守 test 识别、身份解析（`extensions/hotspot/collect.ts#L152` / `#L98` / `#L53`）。
- `workspaceIdOf` / `wsPaths` / `appendEvent` / `readEvents` / `writeSnapshotAtomic` / `cleanupStaleShards` — 存储层（`extensions/hotspot/store.ts#L61`/`#L65`/`#L122`/`#L134`/`#L178`/`#L221`）。
- `buildWorkset` / `lookupWorkset` — 投影与查询（`extensions/hotspot/workset.ts#L29` / `#L95`）。
- `planGate` / `handleInput` / `selectWithinBudget` / `extractPathTokens` — 注入门、入口钩子、预算、路径分词（`extensions/hotspot/inject.ts#L112` / `#L179` / `#L181` / `#L98`）。
- `renderLookupText` / `buildHotspotReport` / `esc` — 渲染与转义（`extensions/hotspot/tool.ts#L24` / `command.ts#L53` / `types.ts#L96`）。
- `hotspotEnabled` — 总开关（`extensions/hotspot/types.ts#L86`）。

## Evidence

- `extensions/hotspot/types.ts#L12-L39` — 全部常量与数据模型（SCHEMA_VERSION=4、权重、TTL、RUN_CAP、注入预算、开关）。
- `extensions/hotspot/decay.ts#L14-L37` — 衰减公式与 TTL 边界（实跑 §1/§7 用例）。
- `extensions/hotspot/store.ts#L61-L241` — wsid、目录布局、分片追加、写入侧拒绝、容忍读、snapshot 原子写、TTL 清理。
- `extensions/hotspot/collect.ts#L92-L233` — 保守 test 识别、白名单、失败不计、同 run 上限、身份解析。
- `extensions/hotspot/workset.ts#L29-L100` — 归并投影、task 回退、lookup clamp。
- `extensions/hotspot/inject.ts#L82-L235` — 终态判定、路径分词、两级门、幂等双保险、预算整条省略、落档先行。
- `extensions/hotspot/tool.ts#L24-L96` / `command.ts#L53-L128` — lookup 工具与 /hotspot 只读诊断（渲染可导出直测）。
- `extensions/hotspot/log.ts#L28-L46` — 效果日志（inject/lookup 决策）。
- `extensions/hotspot/index.ts#L43-L80` — snapshot 编排（主会话 agent_end 节流）与注册矩阵。
- 验证：`npm run test:hotspot` = `node --experimental-strip-types ./extensions/hotspot/_test_hotspot_v4.ts`（13/13 passed，2026-09-24 复跑）；真机四项见 `plans/0924_hotspot_v4_impl_report.md` §F4；L4 链 `plans/0924_hotspot_v4_{l4_review,fix_report,fix_l4_confirm,fix2_report,fix2_l4_confirm}.md`（终判 PASS）。
- 设计：`plans/0924_hotspot_v4_ephemeral_working_set.md`（v4 定义与边界）。

## Links Out

- [[Wiki 索引]]

## Backlinks

- [[Wiki 索引]]

## Open Questions

- 子 agent Fast-Path：`extensions/index.ts` 的子代理早退先于 `registerHotspot`，子 agent 采集分片在当前接线下不可达（模块内部按矩阵实现，上层放宽即生效；见 `plans/0924_hotspot_v4_impl_report.md` ⑥-1）。
- Phase 3（Timeline 整合）未做：`buildWorkset` 以 `HotEvent[]` 语义消费分片，未来可换 journal 订阅、snapshot 从 Timeline 重建（`extensions/hotspot/workset.ts#L1-L10` 模块头）。
