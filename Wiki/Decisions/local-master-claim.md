---
title: Local Master 认领与接管
kind: decision
status: current
updated: 2026-09-23
source_paths:
  - extensions/master-tools.ts
  - extensions/index.ts
  - extensions/runtime/scope.ts
  - extensions/runtime/registry.ts
  - extensions/runtime/master-home-guard.ts
  - extensions/runtime/liveness.ts
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
- **liveness 来源**：`<runtimeDir>/state/scope-liveness/<scope>.json`（pid + sessionId + generation + updatedAt），判活走 `process.kill(pid, 0)`。

## 已知缺口（记录，未修）

- **自动回收依赖 liveness 文件**：`judgeScopeOwnerStale` 在 `no-liveness` 时**恒 skip（保守不动）**。2026-09-20 之前建立的会话没有该文件 ⇒ 其僵尸 owner **无法被自动回收**（例：`master_local_GreenCAD` 的 09-20 僵尸，附件已由人工移入 `registry/attachments-backup/` 方可释放）。当前唯一出路是**显式接管**（本页合同第 4 条）。是否给自动路径加兜底判据（会话文件静默时长 / 进程表反查）**待裁定**。
- **回执不含被顶掉的 owner**：`--force-stale` 成功时回执只给新 gen，不显示"顶掉了 gen=N/owner=…"。global 路径同样如此（非本轮引入）。

## Evidence

- `extensions/master-tools.ts` — `localAgentFromCwd`、`masterStatusLogic(cfg, { cwd })`、`master-attach` 的 `local` 参数与描述。
- `extensions/index.ts` — `/master-attach --local`（地址只从 `ctx.cwd` 派生）、`/master-status` 复用 `masterStatusLogic`。
- `extensions/runtime/master-control.ts` — `attachCurrentSession({ agent? })`（home 守卫只约束 global）。
- `extensions/runtime/master-home-guard.ts` — "local / 其他地址直接放行"。
- `extensions/runtime/registry.ts` — `attachMaster`（genesis / token / forceStale）与 scope 侧 stale 判据注释。
- `extensions/_test_local_master.ts` — U1–U9 / E1–E5 / L1–L7 断言（local 只写 local、global 零变化、无 confirm 拒、接管 gen+1、同会话不 bump、home 会话 `--local` 仍 local、status 三种 liveness、不带 local 的既有行为不变）。
- 独立 L4 复核：本地 `plans/0923_local_master_attach_review.md`（PASS，权限面未放大；真实 registry / scope-liveness / attachments-backup 三目录零污染）。
- 提交：`5b56ecf`。

## Links Out

- [[Runtime Daemon 架构]]
- [[Wiki 索引]]

## Backlinks

- [[Wiki 索引]]

## Open Questions

- 自动回收兜底判据是否引入（`no-liveness` 时会话静默时长 / 进程表反查），以及"顶掉活 owner"是否需要在回执与 journal 中显式记录 prev owner/gen。
