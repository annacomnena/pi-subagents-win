---
title: Local Master 认领与接管
kind: decision
status: current
updated: 2026-10-16
source_paths:
  - extensions/master-tools.ts
  - extensions/index.ts
  - extensions/runtime/scope.ts
  - extensions/runtime/registry.ts
  - extensions/runtime/master-home-guard.ts
  - extensions/runtime/liveness.ts
  - extensions/runtime/master-control.ts
  - extensions/runtime/adapters/session-lifecycle.ts
  - extensions/session-hooks.ts
  - extensions/mailbox-consumer.ts
  - extensions/_test_local_master.ts
---

# Local Master 认领与接管

## Summary

每个仓库（scope）有自己的二级 Master：`agent://master_local_<scope>`，scope 由**可信会话 cwd** 推导（`localMasterScope`：git toplevel 的 basename，worktree 加 `-worktree` 标记）。**全局** `agent://master_default` 只能在用户 home 根目录会话持有；仓库会话持 local。本页记录"谁能设、怎么设、怎么回收僵尸"的合同（2026-09-23 修复：此前工具/命令只能设 global）。

## Current Contract

- **地址派生**：`localAgentFromCwd(cwd)` → `localMasterScope(cwd)` → `localMasterAddress(scope)`。**只接受可信 cwd**（工具 `gate.cwd` / 命令 `ctx.cwd`）；工具与命令参数表里**没有**接受用户传入 scope / 路径 / 地址的入口（防把本会话的认领写到别的仓库）。
- **两条认领路径**：
  1. **静默 genesis**：`session_start` 检查点（`mailbox-consumer`）——scope 无 owner → 建 attachment（gen=1）；有 owner 且非本会话 → 走 `takeoverStaleScopeOwner`（需 liveness 证据，见"已知缺口"）。
  2. **显式认领**：工具 `master-attach({ local: true })` 或命令 `/master-attach --local`。仓库会话设 global 仍被 home 守卫拒（`not-home-dir`，零写）。
- **同会话重复认领**：无 token/forceStale 时只刷新 `lastHeartbeatAt`，**不 bump gen**（幂等）。
- **接管僵尸**：`/master-attach --local --force-stale --confirm`（工具：`local:true, forceStale:true, confirm:true`）。`forceStale` 判据是 `lastHeartbeatAt` 年龄 > 10 分钟；**scope 侧该字段冻结在 attach 时刻**（`registry.ts` 注释明示"stale 判定由调用方完成"）⇒ 对 local 该判据**恒成立**，即"双确认下的无条件接管"。这是**有意接受**的边界：门控靠"仅用户指令可调 + `--confirm` 二次确认"，与 global 的 forceStale 同构。
- **可见性**：`master-status`（工具与 `/master-status` 命令共用 `masterStatusLogic`）输出 `local: <addr> owner=<sid12> gen=N liveness=<alive|stale|skip:reason|no-liveness>`；拿不到 liveness 一律如实写 `no-liveness`，**不猜**。
- **liveness 来源**：`<runtimeDir>/state/scope-liveness/<scope>.json`（pid + sessionId + generation + updatedAt），判活走 `process.kill(pid, 0)`。**与全局 master 的会话心跳（`timers/sessions/<sid>.json`）是两套互不相干的机制**：local 不依赖也不写会话心跳，故 2026-10-12 的「标签页 owner 写心跳」修复不涉及 local（见 [[Master 在线判据与远程输入门]]）。
- **`registry/.lease` 是全局单文件（2026-10-16 补，源码直读 + journal 逐帧复核）**：`acquireRegistryLease()` 的路径恒为 `join(registryDir(), ".lease")`（`registry.ts:330-331`）——**不分 scope、不分 agent**；`wx` 排他创建 first-wins，被占且 `age > staleAfterMs`（缺省 30s，`registry.ts:347`）则覆盖写抢走，否则认输（`registry.ts:354`）。`attach`（`registry.ts:167`）与 `takeover`（`registry.ts:406`）共用它。⇒ **跨 scope 假竞争**：多仓 local master 的会话并发认领时互相抢同一把锁。实证：2026-10-16 `02:02:09.942Z` `master_local_battlesandbox` `taking_over` → `:943` `master_local_GreenCAD` `taking_over` → `:949` **早 6ms** 的 `takeover_failed reason=lease-contended`，同一 tick 内 battlesandbox `takeover` 成功（`~/.pi/agent/runtime/events.jsonl`）。失败**零自动重试**：`takeoverStaleScopeOwner` 折叠为 `skipped:takeover-failed`（`scope.ts:217`），调用方 `mailbox-consumer.ts:830` 不重试，且非 owner 在 `:843` 早退 ⇒ 该会话生命周期内不再尝试。
- **非强接路径不消费 pid（2026-10-16 补）**：`attachMaster` → `attachWithOwnerLocked` 的判据只有「有无 owner」与同会话幂等（`registry.ts:187-190`、`:234`）。**pid 实证只存在于 `forceStale` 路径**（判据是 `lastHeartbeatAt` 年龄 > 10min，`registry.ts:218`；该路径**不看 pid**），而 registry 不 import liveness、`MasterAttachment` 无 pid 字段（`registry.ts:35-46`；`liveness.ts:32` 注释「pid/startedAt 只住本文件，不进 registry」）。⇒ **普通认领下 pid-dead 不可穿透**（异会话一律 `owner-active`）；**强接路径下 pid 判据也不参与**（local 心跳冻结，见上文合同第 4 条）。两条判据轴互不相通——想让 pid 死判据生效须改调用侧，不是现成行为。
- **认领路径与消费循环注册的耦合（2026-09-25 补，源码直读 + L4 独立验证）**：scope 信箱的消费循环**只**在 `session_start` 处理块里注册（`mailbox-consumer.ts::registerScopeWakeLoop`，接线全仓仅 `index.ts:1945` 一处），且**认领成功 ⟺ 注册**（同一处理块内）；`triggerOwnershipRecheck()` 只补注册**全局** result watcher。⇒ **手动 `/master-attach --local` 不经过 `session_start` → 不注册 scope 消费循环**（工具 `master-tools.ts:521`、slash `index.ts:2125` 成功后都只调 `triggerOwnershipRecheck()`）——该会话默认收不到本仓信箱的信，直到下一个 `session_start`。详见 [[Local Master Ensure（幂等确保）]] §#A。

## 已知缺口（记录，未修）

- **自动回收依赖 liveness 文件**：`judgeScopeOwnerStale` 在 `no-liveness` 时**恒 skip（保守不动）**。2026-09-20 之前建立的会话没有该文件 ⇒ 其僵尸 owner **无法被自动回收**（例：`master_local_GreenCAD` 的 09-20 僵尸，附件已由人工移入 `registry/attachments-backup/` 方可释放）。当前唯一出路是**显式接管**（本页合同第 4 条）。是否给自动路径加兜底判据（会话文件静默时长 / 进程表反查）**待裁定**。
- **回执不含被顶掉的 owner**：`--force-stale` 成功时回执只给新 gen，不显示"顶掉了 gen=N/owner=…"。global 路径同样如此（非本轮引入）。
- **`writeScopeLiveness` 不在认领路径上（2026-10-16 补，源码直读）**：唯一写手是 `session-hooks.ts:46 writeScopeOwnerLiveness`，调用点仅 `agent_end`（`:243`）与 `agent_start`（`:261`）——**按会话 turn 边界写，无定时器、无 tick**；节流 30s 且身份变化立即写（`liveness.ts:95-113`）。认领三条路径（`silentScopeGenesis` / `takeoverStaleScopeOwner` / 工具与 slash 的 `master-attach` 成功分支）**都不写 liveness**（`scope.ts:117`/`:187`；`master-tools.ts:524` 只调 `activateScopeConsumption`）。⇒ **新 owner 认领后，`scope-liveness/<scope>.json` 仍是旧代**（身份不匹配 ⇒ `judgeScopeOwnerStale` 返 `skip:identity-mismatch`，`ensureLocalMaster` 判 `stalled`），**直到该会话跑完第一个 agent turn 才被 `agent_start` 补写**；会话空闲则永不刷新（这也解释了「liveness 刷新频率远低于 consume tick」的现象：liveness 按 turn、consume 按 30s tick，`mailbox-consumer.ts:754` + `index.ts:2433`）。`readScopeLiveness` 本身**不做年龄判定**（`liveness.ts:71-90`，无 ttl）。

## Evidence

- `extensions/master-tools.ts` — `localAgentFromCwd`、`masterStatusLogic(cfg, { cwd })`、`master-attach` 的 `local` 参数与描述。
- `extensions/index.ts` — `/master-attach --local`（地址只从 `ctx.cwd` 派生）、`/master-status` 复用 `masterStatusLogic`。
- `extensions/runtime/master-control.ts` — `attachCurrentSession({ agent? })`（home 守卫只约束 global）。
- `extensions/runtime/master-home-guard.ts` — "local / 其他地址直接放行"。
- `extensions/runtime/registry.ts` — `attachMaster`（genesis / token / forceStale，`:119`）、`attachWithOwnerLocked` 的 `owner-active`（`:234`）与 forceStale `staleAfterMs` 缺省 10min（`:218`）、`acquireRegistryLease` 全局单文件 `.lease` + 30s stale（`:330-356`）、`takeoverMaster` 的 `lease-contended`（`:406-407`）与 scope 侧 stale 判据注释（`:391-397`）。
- `extensions/session-hooks.ts` — `writeScopeOwnerLiveness`（`:46`，身份门 `:50-53`）与双调用点 `agent_end`（`:243`）/`agent_start`（`:261`）。
- `extensions/runtime/liveness.ts` — `ScopeLiveness` 字段全集（`:36-48`，含 `pid`/`startedAt`）、`readScopeLiveness` 无 ttl（`:71`）、`writeScopeLiveness` 30s 节流（`:95`）、`isProcessAlive` EPERM=活（`:127`）。
- `extensions/runtime/master-control.ts` — `attachCurrentSession`（`:57`，home 守卫只约束 global）。
- `extensions/runtime/adapters/session-lifecycle.ts` — `SESSION_LIFECYCLE_TYPES` 九型（`:27-37`）、`takeover_failed` 落点（`:235`）。
- `extensions/_test_local_master.ts` — U1–U9 / E1–E5 / L1–L7 断言（local 只写 local、global 零变化、无 confirm 拒、接管 gen+1、同会话不 bump、home 会话 `--local` 仍 local、status 三种 liveness、不带 local 的既有行为不变）。
- 独立 L4 复核：本地 `plans/0923_local_master_attach_review.md`（PASS，权限面未放大；真实 registry / scope-liveness / attachments-backup 三目录零污染）。
- 提交：`5b56ecf`。

## Links Out

- [[Local Master Ensure（幂等确保）]]
- [[Runtime Daemon 架构]]
- [[Master 在线判据与远程输入门]]
- [[Wiki 索引]]

## Backlinks

- [[Local Master Ensure（幂等确保）]]
- [[Wiki 索引]]
- [[Master 在线判据与远程输入门]]

## Open Questions

- 自动回收兜底判据是否引入（`no-liveness` 时会话静默时长 / 进程表反查），以及"顶掉活 owner"是否需要在回执与 journal 中显式记录 prev owner/gen。
- 跨 scope 假竞争（全局 `.lease`）是否改为 per-agent/per-scope lock（或给 `lease-contended` 加一次退避重试）——现为 6ms 级 flaky，见上文。
- 是否把 `judgeScopeOwnerStale` 的 pid 判据接到 `master-attach` 的非强接路径（需把 liveness 以参数注入 registry，避免 registry 依赖 runtime 读盘）；若接，须保持 `skip`（`no-liveness`/`identity-mismatch`）仍拒绝的 fail-closed 语义。
- 认领成功后是否统一补一次 `writeScopeLiveness`（落在 `scope.ts` 的 genesis/takeover 成功分支，一处覆盖 `session_start` 与手动 attach 两条路径）。
