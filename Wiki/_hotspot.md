---
title: Hotspot 路由缓存
kind: concept
status: current
updated: 2026-09-23
schema_version: 1
revision: 8
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

## approval-gate

- 标题：统一审批门策略与架构（三份参考实现对照已收尾）
- 适用范围：审批门策略判定、待审队列接口形状拟定；边界与入口抄 openclaw，准入后动作分级抄 Hermes，队列形状抄 opencode（三处保守化改造）
- Wiki：Wiki/Decisions/approval-gate-policy.md
- Wiki：Wiki/Architecture/approval-gate.md
- 证据：plans/0923_hermes_approval_recon.md
- 证据：plans/0923_opencode_permission_recon.md
- 证据：plans/0923_openclaw_security_recon.md
- 证据：Wiki/Architecture/approval-gate.md#待审队列接口形状（拟）
- 内容更新：2026-09-23T00:00:00.000Z
- 引用验证：2026-09-23T00:00:00.000Z

## host-exposure-hardening

- 标题：本机服务默认 loopback，对外暴露显式 opt-in + 认证（拟）
- 适用范围：daemon / eventual wechat bridge 的 bind 面与暴露审批；配置改动不热切换
- Wiki：Wiki/Decisions/host-exposure-hardening.md
- 入口：extensions/runtime-host/server.ts::startRuntimeHost
- 证据：plans/0923_opencode_permission_recon.md#3.2
- 证据：plans/0923_openclaw_security_recon.md#4
- 证据：extensions/runtime-host/server.ts
- 内容更新：2026-09-23T00:00:00.000Z
- 引用验证：2026-09-23T00:00:00.000Z

## wechat-ilink-login

- 标题：微信 iLink 绑定+接收 W1+W2
- 适用范围：微信 iLink 通道：绑定 v1 + 接收 W1 + W2 注入 + W2b 界面开关（真机协议已校准）
- Wiki：Wiki/Architecture/wechat-ilink-channel.md → 登录/绑定协议契约（源码已验证）
- Wiki：Wiki/Architecture/wechat-ilink-channel.md → 真机协议实测（2026-09-24，**指南不可信**）
- Wiki：Wiki/Architecture/wechat-ilink-channel.md → W2b 界面开关切片（**已落地** `18ba74d`，D17）
- 入口：extensions/runtime-host/wechat-bind.ts::setWechatEnabled
- 入口：extensions/channel-wechat/worker.ts::startWechatWorker
- 入口：extensions/runtime-host/channel-supervisor.ts::ChannelSupervisor
- 证据：plans/0923_wechat_gui_bind_plan.md
- 证据：extensions/_test_wechat_receive.ts
- 证据：recentwork.md → Item 25 - 微信 iLink 接收 W1（只收不投：长轮询 + 游标/去重/私有 inbox + GUI 可见）
- 内容更新：2026-09-24T02:52:53.388Z
- 引用验证：2026-09-24T02:52:53.388Z

## gui-master-inject-trust

- 标题：本机 GUI 注入 master 信任通道
- 适用范围：本机 GUI 注入 master 的信任通道（bootstrap OTT + 派生 cookie），四轮 L4 已收敛
- Wiki：Wiki/Decisions/gui-master-unlock.md → 注入门判据（实测澄清，2026-09-24）
- 入口：extensions/runtime/master-injection.ts::checkTrustedLocalChannel
- 入口：extensions/runtime-host/server.ts::createRuntimeHostServer
- 证据：plans/0923_gui_master_unlock_review.md
- 证据：plans/0923_gui_master_unlock_fix.md
- 证据：Wiki/Decisions/gui-master-unlock.md → 注入门判据（实测澄清，2026-09-24）
- 内容更新：2026-09-24T02:53:07.301Z
- 引用验证：2026-09-24T02:53:07.301Z

