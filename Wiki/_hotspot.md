---
title: Hotspot 路由缓存
kind: concept
status: current
updated: 2026-09-23
schema_version: 1
revision: 1
---

## async-delivery-ownership

- 标题：async 终态归属派发者（可见≠投递）
- 适用范围：async subagent 完成通知的路由；任何会话的 watcher 只投给派发者，非接收者不认领不注入；link 缺失 fail closed
- 入口：extensions/async-result-watcher.ts::onRunFile
- 入口：extensions/async-result-watcher.ts::asyncDispatcherFor
- 证据：plans/0923_async_misdelivery_opinion.md
- 证据：plans/0923_async_fix_impl.md
- 内容更新：2026-09-23T01:04:44.000Z
- 引用验证：2026-09-23T01:04:44.000Z

## recent-scopes-awareness

- 标题：master 原生最近活跃仓库感知
- 适用范围：`/master-status` 的 `recent:` 行；三账本只读归并（scope 心跳/tab 派发/sessions mtime），去噪，精确路径合并，空结果区分 unknown/none
- 入口：extensions/runtime/recent-scopes.ts::listRecentScopes
- 入口：extensions/runtime/recent-scopes.ts::normalizeExactPath
- 入口：extensions/runtime/recent-scopes.ts::isNoisePath
- 入口：extensions/runtime/recent-scopes.ts::resolveDecodedPath
- 入口：extensions/index.ts::recentScopesLine
- 证据：plans/0922_recent_scopes_review.md
- 内容更新：2026-09-23T01:04:44.000Z
- 引用验证：2026-09-23T01:04:44.000Z

## lite-orchestrator-picks

- 标题：lite 档位不规定模型（编排方自选）
- 适用范围：lite 链 L1-L5 的模型选择；档位只有相对大小，具体模型每次按 sub_models 现状自选，禁止写死 ID
- 入口：extensions/lite-mode.ts::CHAIN
- 入口：extensions/lite-mode.ts::liteTiers
- 证据：skills/workflow-orchestrator/SKILL.md → 档位（相对大小，不规定模型）
- 内容更新：2026-09-23T01:04:44.000Z
- 引用验证：2026-09-23T01:04:44.000Z

## hidden-console-spawn

- 标题：Windows 后台派生必须给隐藏控制台（勿用 detached）
- 适用范围：vite/runtime-host 等常驻进程的派生；`detached: true` 无控制台→子进程各自开新控制台→默认终端 WT 弹窗；改 `windowsHide: true` 让子树继承隐藏控制台
- 入口：extensions/gui-autostart.ts::defaultSpawnVite
- 入口：extensions/runtime-host/server.ts::startRuntimeHost
- 证据：plans/0922_empty_wt_window_diagnosis.md
- 证据：plans/0922_empty_wt_evidence.md
- 证据：plans/0922_empty_wt_gpt_verdict.md
- 内容更新：2026-09-23T01:04:44.000Z
- 引用验证：2026-09-23T01:04:44.000Z

## default-async-dispatch

- 标题：subagent-win 工具级默认异步
- 适用范围：`subagent-win` 无参即异步（`p.async !== false`）；只有显式 `async: false` 才同步等；提示词约束不可靠，行为必须落地实现
- 入口：extensions/index.ts::subagent-win execute
- 证据：skills/workflow-orchestrator/SKILL.md → 轻量链模式（lite）
- 内容更新：2026-09-23T01:04:44.000Z
- 引用验证：2026-09-23T01:04:44.000Z

## spawn-trace-probe

- 标题：开窗取证探针（谁派生了可见控制台）
- 适用范围：排查空壳终端/弹窗类问题；记录 wt.exe new-tab、detached 控制台子进程、浏览器拉起、powershell toast 的调用栈与 WT_SESSION
- 入口：extensions/spawn-trace.ts::traceSpawn
- 内容更新：2026-09-23T01:04:44.000Z
- 引用验证：2026-09-23T01:04:44.000Z
