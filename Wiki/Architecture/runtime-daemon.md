---
title: Runtime Daemon 架构
kind: concept
status: draft
updated: 2026-09-23
source_paths:
  - extensions/runtime-host/server.ts#L1-L51
  - extensions/runtime-host/daemon-lifecycle.ts#L1-L30
  - plans/0923_runtime_daemon_final_plan.md
---

# Runtime Daemon 架构

## Summary

目标三层：Client Plane（TUI/GUI/ACP/微信）/ Runtime Daemon（内含 Communication Fabric）/ Agent workers（独立进程 + Job Object 限额）。写侧按五本账逐个迁移，以 G0/G1 为闸口。本页多为方向性设计（`draft`），已验证部分见 [[Runtime Daemon 存活机制]]。

## Current Contract

- 三层划分：Client Plane 只做呈现与一次性审批；Runtime Daemon 持有 Communication Fabric（事件、租约、投影）；Agent workers 独立进程跑任务，仅承诺崩溃隔离。
- 写侧五本账迁移顺序与切换/回滚：见本地定稿计划 §6（页面内不复制全文）。
- G0 闸口：存活 + 身份（`scripts/verify-runtime-g0.ps1` §8 设计）；G1 闸口：无头接续。停止条件与交付门见定稿计划 §8–§10。
- 第一切片（已落地）：detached 生命周期 + 静态托管 + 单实例身份；写侧完全不动。

## Key Symbols

- `startRuntimeHost` / `stopRuntimeHost` — `extensions/runtime-host/server.ts`。
- `ensureRuntimeDaemon` / `defaultSpawnDaemon` — `extensions/runtime-host/daemon-lifecycle.ts`。
- `classifyHost` — `extensions/runtime-host/discovery.ts`。

## 重启命令 `/runtime-host restart [--force]`（`1743061`）

**动机**：本轮反复需要重启 daemon 才能加载新代码（W1/W2 落地、worker 协议修复、开关生效），每次手工杀进程。命令面原有 `start|stop|status`，本切片补 `restart`。

**语义（按序，任一步 fail-closed 即中止并如实报错，不留半死状态）**：
1. **停**：`stopRuntimeDaemon()`（既有：身份核验 `classifyHost` + 按 instanceId 条件清理）。返回 `uncertain` → **中止**（不 kill、不硬闯 ensure），提示 `--force` 人工恢复路径；`--force` **仅显式传入**才裸 kill。
2. **有界等锁释放**（≤10s，轮询 `readRuntimeLock`/`lockHolderAlive`）；超时 → 中止并报等待毫秒数。
3. **起**：`ensureRuntimeDaemon()` → 新 daemon（新 pid/port/**新 token**）。
4. **回报必含三条后果**：`旧 pid → 新 pid port`、⚠️ **GUI cookie 已失效（新 host token）→ 需 `/gui open`**、微信 worker 由新 daemon 的 supervisor 重新 spawn（若 `receive.enabled=true`）。`ensure` 返回 `already:true`（窗口内被抢先起好并复用）时显式标注「（复用现有实例）」，**不笼统报"已重启"**。

**实现**：`extensions/runtime-host/daemon-lifecycle.ts::restartRuntimeDaemon()`（依赖注入 `stop/ensure/readLock/isLockAlive/sleep` + `waitForLockMs/pollMs`，便于单测；**既有 `stopRuntimeDaemon`/`ensureRuntimeDaemon` 语义未改**）；`extensions/index.ts` 最小 hunk（命令分支 + 用法串/description 补 `restart`，D17 可发现性）。

**验收**：`extensions/_test_runtime_host_restart.ts` 5 组（uncertain 中止不调 ensure / happy path 调用顺序+回报含 cookie 提示 / 锁未释放有界超时 / ensure 失败如实报错 / `--force` 仅显式透传）；第 6 组可选的 worker-only restart **如实 SKIP**。L4 独立复核 **PASS**（无 must-fix）。**真实重启实测**：旧 pid=195936 port=53872 → 新 pid=254488 port=51984，`/v1/health` 200。

**未做**：worker-only restart（可选，SKIP）；`restart --force extra`/`-f` 落到用法提示（fail-closed，无误触发）。

## 派生形状更正：`windowsHide` 必须 true（2026-09-24 真机对照实测）

**用户现象**：daemon 每次启动都**必定弹一个终端窗口**（Win11 把新控制台交给 Windows Terminal，表现为一个标题为 `C:
vm4w
odejs
ode.exe` 的 WT 窗口）。

**旧结论（已被推翻）**：`daemon-lifecycle.ts` 原注释称"DETACHED_PROCESS 与 CREATE_NO_WINDOW 不可叠用，故 windowsHide 必须 false"。该结论**对 daemon 这种单进程派生是错的**。

**实测方法**：`EnumWindows` 枚举**可见窗口**（含类名/标题/pid）+ 子进程存活检查；四种形状各起一个 20s 的 node：

| 变体 | 出现窗口 | 父进程退出后存活 |
|---|---|---|
| `detached:true + windowsHide:true` | **不出现** | **存活** ✅ |
| `detached:true + windowsHide:false`（旧现状） | **出现**（= 用户看到的现象） | 存活 |
| `detached:false + windowsHide:true` | 不出现 | **死亡**（不满足） |

⇒ **修法**：daemon 用 `{detached:true, stdio:'ignore', windowsHide:true}`。
**连带必修**：旧"孙进程各自 alloc 新控制台"风险的真实来源是 **daemon 的子进程** —— `channel-supervisor.ts` 的 worker spawn 也必须 `windowsHide:true`，否则 daemon 无控制台时 worker 会自己开一个窗口。
**验证**：重启后可见控制台窗口数 **4 → 3**（daemon 窗口消失），daemon 存活（`/v1/health` 200）、worker 正常 spawn 且**无新增窗口**；worker 只有 1 个（`worker.json` pid 与 daemon 子进程一致）。

**教训**：`windowsHide` 与 `detached` 的兼容性**必须按"本进程 + 它的子进程"两层分别实测**，不能靠一次探针或历史注释外推。

## Evidence

- `extensions/runtime-host/server.ts#L1-L51` — 模块头注释（职责、fail-closed、不变量）。
- 本地 `plans/0923_runtime_daemon_final_plan.md` §1（架构与 opt-in 不变量）、§2（寿命/发现/接管）、§6（写侧迁移）、§8（G0 验证）、§9（第一批切片）、§10（测试矩阵与停止条件）。
- 已验证切片证据见 [[Runtime Daemon 存活机制]]；commit `bdb6674`。

## Links Out

- [[Wiki 索引]]

## Backlinks

- [[Wiki 索引]]
- [[Runtime Daemon 存活机制]]
- [[GUI 解锁 Master]]
- [[Local Master 认领与接管]]

## Open Questions

- 写侧迁移（§6）、G1 无头接续、崩溃自愈/登录自启（可选增强）均未实现；实现后按切片更新本页。
