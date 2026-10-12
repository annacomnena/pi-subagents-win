---
title: Master 开机自启与防双开
kind: concept
status: current
updated: 2026-10-12
source_paths:
  - scripts/boot-resume-master.ps1
  - scripts/boot-autostart-status.ps1
  - extensions/runtime/master-transfer.ts#L305-L355
  - extensions/runtime/registry.ts#L440-L490
  - extensions/timers.ts#L391-L431
  - extensions/identity.ts#L77-L97
  - plans/20261012_wechat_master_offline_diagnosis.md
  - plans/20261012_bc_fix_plan.md
  - plans/20261012_bc_fix_impl.md
---

# Master 开机自启与防双开

## Summary

两条开机任务（`pi-runtime-host-boot` 起 runtime host daemon / `pi-master-resume-boot` 恢复 master 会话）+ `scripts/boot-resume-master.ps1` 的 **P1–P6 / G1–G3** 流水线，负责开机后把 global master 会话恢复成**非标签页常驻会话**。防双开原判据（命令行含 sid / 会话文件被占用）对**标签页型 master**与 2026-10-12 C 之后的**常驻继任者**都是**假阴性**（两者命令行都不含自身 sid），裸跑 boot-resume 会双开同一 attachment owner 会话。2026-10-12 新增判据 **G2.5（心跳新鲜 + 写于本次开机后）**。另：P2 的 transfer-window 24h skip 有直接的**可用性后果**（窗口残留 ⇒ master 不恢复）。

## Boot 链路职责

- `pi-runtime-host-boot` → 起 runtime host daemon（detached 生命周期；微信 worker 由 daemon 的 supervisor spawn）。见 [[Runtime Daemon 架构]] / [[Runtime Daemon 存活机制]]。
- `pi-master-resume-boot` → 恢复 global master 会话（调 `boot-resume-master.ps1`）。
- 诊断工具 `scripts/boot-autostart-status.ps1`（`master-status.cmd` 双击入口）——只读健康检查：`[attach]` 归属、`[process] sid holders`（`#L71-L78`，**只按命令行含 sid**）、daemon/worker 状态。
- 两条任务曾出现瞬时 `timeout 8000ms`（host 冷启动窗口偏短），由僵尸接管自愈（`plans/20261012_wechat_master_offline_diagnosis.md` §三）。

## boot-resume 流水线（`scripts/boot-resume-master.ps1`）

**前置判据 P1–P6**：
- P1 attachment（`#L329`）——拿目标 sid，缺则 `no-attachment` skip；
- P2 transfer-window（`#L342-L351`）——见下节；
- P3 session 文件（`#L354`）——取最新 mtime，绝不自动 `--session-id` 建空会话；
- P4/P5 header 复核（`#L364-L377`）——`header.id==sid` + cwd 一致，防「假 master」（文件缺失/异常时 pi 会造新 UUID）；
- P6 审计基线（`#L381`）——fileSize + mtime，`ownerIsNewest` 供 G3 的 `--continue` 分档。

**防重 G1–G3**：
- **G1** claim 锁 `state/boot-resume.lock`（`#L390`）——`wx` 排他创建 + pid/cmdline 身份复核；**可证死 / 可证 pid 复用**才清 + 重读复核（镜像 daemon-lifecycle 的 `stealStaleLock`）。
- **G2** 进程扫描（`#L449`）——`node.exe` 命令行含目标 sid ⇒ `already-running via=process`；CommandLine 读不出 ⇒ `uncertain-unreadable`（fail-closed）。
- **G2.5** 心跳新鲜（`#L467-L486`）——见下节。
- **G3** 歧义交互 pi 扫描（`#L488`）——`--session` 参数值先按 pi `resolveSessionPath` 语义分档（路径含全长 sid / 精确等于 sid / sid 开头 = 就是我们；后缀/子串/通配符等无法确证 → skip），再对裸 / `-c` / `-r` / `--session-dir` 分档；判不准一律 skip。

**spawn 形态**（`#L537-L538`）：`wt -w 0 new-tab --title "pi master" --suppressApplicationTitle -d <home> <node> <cli.js> --session <file>` + env 身份类清理（`Get-BootEnvScrubKeys`，`#L89-L96`：含 `PI_PROVIDER/PI_MODEL/PI_REASONING_LEVEL` 等，**比 C 的 `clearTabIdentity` 更彻底**）+ `shell:false` + cwd=home + **不带 prompt**。随后 0→20s 找**恰好一个** holder：0 个 → `spawn-unconfirmed`（非零退出、claim 保留待下次「可证死」清）、>1 个 → `dup-detected`（告警不自动 kill）。

## P2 transfer-window 24h skip（可用性后果）

- 窗口由 `transferMaster` 在 **spawn 成功返回后**落（`extensions/runtime/master-transfer.ts#L337`），TTL 24h（`extensions/runtime/registry.ts#L450`）；窗口在场抑制 `forceStale` attach 与 stale takeover（`#L217`/`#L404`）。
- `boot-resume` P2 见窗口 `(now - createdAt) < 24h` → **`skip: transfer-in-flight`**（主动不恢复 master，不是报错）。
- **后果**：异步 spawn 失败若不清窗（record 停 `spawned`、窗口残留），重启后 master 不恢复 → 微信/网页远程输入离线。这是 nice-to-have #3 修复（`failTransferPostSpawn`，见 [[Master 交接继任者形态]]）的动机。

## 双开检测的坑（重要）

原判据（G2 命令行含 sid / G3 `--session` 分档 / `boot-autostart-status.ps1#L75` 的 holders）**只覆盖 `--session` 形态**：

- **标签页型 master**：命令行只有 `--tab-run-id <runId>` + 提示文件 `@file`，**无 sid**；且 pi **不长期持有会话文件句柄** ⇒ 「文件被占用」检测同样假阴性。
- **C 之后的常驻继任者**：**无 `--session`** ⇒ 命令行不含 sid。
- G3 原对 `--tab-run-id` **无条件 `continue`**（剔除表，`#L511`）→ 直接绕过。
- ⇒ 裸跑 boot-resume 会**双开同一 attachment owner 会话**（同一 session 文件被两个进程写）。

### 新判据 G2.5（已落地）

`scripts/boot-resume-master.ps1#L467-L486`：
1. 读 `timers/sessions/<encodeURIComponent(sid)>.json` 的 `lastActiveAt`；
2. `age < 30s` **且** `LastWriteTime >= now - Environment.TickCount`（**写于本次开机之后**）；
3. 命中 → `skip: already-running via=heartbeat`（不 spawn）。

「写于本次开机后」是**必需收紧**：否则快速重启会读到上次运行的残留心跳 → 误 skip → master 不恢复（可用性风险 > 本次引入的误 skip）。B（标签页 owner 写心跳）+ C（继任者为主会话自写心跳）之后，本条覆盖**所有**常驻形态（见 [[Master 在线判据与远程输入门]]）。

### 未落地项与外部多路取证

- **判据 2（tab-run 账本映射）未落地**（计划标「可后置」）：对 `--tab-run-id` 读 `<runsDir>/<runId>.state.json` 的 `sessionPath/pid` 判归属，否则 `uncertain-tab-run`（fail-closed）。残留影响：**旧标签页 master 进程**（跑无 B 的旧代码 → 无心跳）仍会被 G3 剔除表放行 → 双开隐患仅剩升级瞬间的窄窗。
- **外部辅助工具的多路取证**（工作区**未跟踪**脚本 `scripts/open-master.ps1` / `master-open.cmd`，非本次交付）：双击打开/切回 master，取证 `E1` cmdline 含 sid / `E2` claim pid 存活 / `E3` 心跳新鲜 / `E4` tab-runs 里「cwd=home 且标题以 master 开头、paired state 非终态」的标签页记录；任一命中即「在运行」（fail-closed 拒绝 spawn，退出码 3）。它与 G2.5 互补，覆盖判据 2 想解决的问题；因其未纳入版本控制，**不列入本页 `source_paths`**。

## Evidence

- 流水线：`scripts/boot-resume-master.ps1` 头部 DESCRIPTION（`#L8-L16`）与 P1（`#L329`）、P2（`#L342-L351`）、P3（`#L354`）、P4/P5（`#L364-L377`）、P6（`#L381`）、G1（`#L390`）、G2（`#L449`）、G2.5（`#L467-L486`）、G3（`#L488`）、spawn（`#L537-L538`）、env 清理（`#L89-L96`）。
- holder 判定：`scripts/boot-autostart-status.ps1#L71-L78`；任务名 `#L23`。
- transfer 窗口：`extensions/runtime/master-transfer.ts#L305-L355`、`extensions/runtime/registry.ts#L440-L490`；心跳：`extensions/timers.ts#L391-L431`；身份：`extensions/identity.ts#L77-L97`。
- 背景：`plans/20261012_wechat_master_offline_diagnosis.md` §三/§五（自启任务状态、G2 跳过 `--tab-run-id` 的双开隐患）；G2.5 设计与实现 `plans/20261012_bc_fix_plan.md` §4.2、`plans/20261012_bc_fix_impl.md`（HB-1..HB-4 harness PASS=4 FAIL=0）。
- 校准状态：G2.5 与 §3.4 must-fix 为**工作区未提交**（基线提交 `e12954f`），已过「L4 全量 + delta 增量」双重独立复核（`plans/20261012_bc_fix_delta_review.md`：**PASS，must-fix 0**）。`scripts/open-master.ps1` 为未跟踪脚本（存在、未纳入版本控制）。

## Links Out

- [[Master 在线判据与远程输入门]]
- [[Master 交接继任者形态]]
- [[Runtime Daemon 架构]]
- [[Runtime Daemon 存活机制]]
- [[Wiki 索引]]

## Backlinks

- [[Master 在线判据与远程输入门]]
- [[Master 交接继任者形态]]
- [[Wiki 索引]]

## Open Questions

- 判据 2（tab-run 账本映射）未落地 → 升级瞬间的旧标签页 master 窄窗双开隐患残留（依赖 B 生效后由 G2.5 覆盖）。
- G2.5 心跳文件名用 `[uri]::EscapeDataString`（≈`encodeURIComponent`，对 `!'()*` 略有差异）；当前 sid 恒为 UUID，两者一致，非 UUID 场景才可能不匹配。
- 两条开机任务的电池设置（`DisallowStartIfOnBatteries` / `StopIfGoingOnBatteries`）与 TaskScheduler Operational 日志 Enabled=False 是「偶发自启不生效」候选，属运维配置，未写入本页（待办清单）。
