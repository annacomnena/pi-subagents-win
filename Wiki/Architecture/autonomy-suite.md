---
title: 主动性套件（Autonomy Suite）
kind: concept
status: draft
updated: 2026-09-23
source_paths:
  - extensions/runtime/autonomy/config.ts
  - extensions/runtime/autonomy/kill-switch.ts
  - extensions/runtime/autonomy/frontier.ts
  - extensions/runtime/autonomy/wake-gate.ts
  - extensions/runtime/autonomy/watchdog.ts
  - extensions/runtime/autonomy/collect.ts
  - extensions/_test_runtime_autonomy.ts
---

# 主动性套件（Autonomy Suite）

## Summary

global master 从"被动等指令"走向"主动推导 + 显式动作"的套件。**v1 只是纯函数层：未接线**（尚未接入 master 工具与唤醒路径），因此本页 `status: draft`。规格见本地 `plans/0923_global_master_autonomy_suite_v0.2.md`（v0.2，1335 行）；v1 计划/实现/复核见本地 `plans/0923_autonomy_suite_v1_{plan,impl,review}.md`。

## Current Contract（v1 已实现部分，`3922ef4`）

- **配置**（`config.ts`）：`config.json` 的 `autonomy` 切片；`DEFAULT_AUTONOMY` 取规格 §27 精确值；`normalizeAutonomy` **严格 `=== true` + 逐字段回落**（fail-closed）；`readAutonomyConfig` 容忍读（缺/坏 JSON → 默认）。
- **kill-switch**（`kill-switch.ts`）：`readKillSwitch`（容忍读）/ `engageKillSwitch`（原子 tmp+rename）/ `clearKillSwitch`；`evaluateAutonomyGating` 优先级 **kill > enabled > active**。
- **frontier**（`frontier.ts`，**纯零 IO**）：C5 相位→项目状态映射固化、规格 §25 九规则的 v1 子集、`meaningful_state_version`、`RECORD_ONLY_NOCARRIER`。
- **wake-gate**（`wake-gate.ts`，**纯**）：`evaluateWakeGate` 四类（gating / debounce 2s / cooldown 15s / bypass）；审计行为纯返回，不落盘。
- **watchdog**（`watchdog.ts`，**纯**）：`evaluateWatchdogChecks` 八项三态（**3/8 恒 `unknown`**、第 7 项 `null→unknown`，不猜）；`validateWatchdogPlan` **只钳制与封顶、不执行**；`WATCHDOG_HEARTBEAT_STALE_MS = 10m`。
- **collect**（`collect.ts`，薄 IO 层，**唯一批量 IO 文件**）：`collectAutonomyInputs` 只读聚合 + **只写自有 namespace**（frontier 快照、审计行），顶层 never-throw。
- **红线**（规格条款 7/C1）：不写共享账本、不改其它仓库、不消费/ack 他人 mailbox；v1 **零既有文件改动**（回滚 = 删 `extensions/runtime/autonomy/**` 与 `extensions/_test_runtime_autonomy.ts`）。

## 未接线（v2 待办）

- 未接入 master 工具面（无 `/autonomy` 类命令、无 tool 暴露）；未接入唤醒/派发路径；未与 `global-view` 的探测结果联动；未定义"自动动作"的用户可见回执与审计留存位置。
- 规格中的其余部分（大量规则与场景）尚未实现——v1 明确只取"可离线验证、依赖最少"的一层。

## Evidence

- `extensions/runtime/autonomy/{config,kill-switch,frontier,wake-gate,watchdog,collect}.ts` — 上表各契约的实现。
- `extensions/_test_runtime_autonomy.ts` — A1–A11 共 55 项断言全绿（`npx tsx extensions/_test_runtime_autonomy.ts`）；含"测试不触真实 `~/.pi/agent/runtime`"的隔离断言。
- tab 内独立 L4 复核：本地 `plans/0923_autonomy_suite_v1_review.md`（PASS，must-fix 0）。
- 提交：`3922ef4`。

## Links Out

- [[Wiki 索引]]

## Backlinks

- [[Wiki 索引]]

## Open Questions

- v2 接线形态：主动性动作以什么形态暴露（tool / 命令 / 事件驱动），以及"自动动作必须可审计 + 有 kill-switch"的落地点（审计文件位置、轮转策略）。
- watchdog 三项恒 `unknown` 的判据何时具备数据源（与 `global-view` 的卫生行缺口同源）。
