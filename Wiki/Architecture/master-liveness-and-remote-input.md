---
title: Master 在线判据与远程输入门
kind: concept
status: current
updated: 2026-10-12
source_paths:
  - extensions/timers.ts#L31
  - extensions/timers.ts#L380-L460
  - extensions/timers-runtime.ts#L210-L232
  - extensions/timers-runtime.ts#L548-L566
  - extensions/runtime-host/wechat-input.ts#L78-L86
  - extensions/runtime/command-executor.ts#L190-L214
  - extensions/runtime/command-executor.ts#L520-L540
  - extensions/runtime-host/server.ts#L748-L758
  - extensions/runtime-host/server.ts#L1065-L1075
  - extensions/runtime/liveness.ts#L10
  - plans/20261012_wechat_master_offline_diagnosis.md
  - plans/20261012_bc_fix_plan.md
---

# Master 在线判据与远程输入门

## Summary

运行期「master 在线」只有**一个**权威判据：会话心跳 `<timersDir>/sessions/<encodeURIComponent(sid)>.json` 的 `lastActiveAt` 是否新鲜（`sessionAlive`，宽限 `SESSION_HEARTBEAT_GRACE_MS = 15000`）。四个消费点共享同一判据（微信文本注入门 / 执行器 `master-offline` 409 / host 的 `masterAlive` 投影 / 心跳清扫）。心跳由调度器 tick 每 5s 写；**标签页会话（`--tab-run-id`）历来不写**，故全局 master 一旦是标签页，微信与 GUI 远程输入**恒**判 `master-offline`——这是 2026-10-11 现网「微信持续 13h 不进会话、同一条消息重试 7622 次」的根因。2026-10-12（工作区，未提交）新增条件写：标签页**恰为全局 attachment owner** 时也写心跳；local master 仍不写（有意）。

## Current Contract

### 判据：写 / 读 / 清

| 动作 | 函数 | 落点 | 事实 |
|---|---|---|---|
| 写 | `touchSessionHeartbeat(timersDir, sid, now)` | `extensions/timers.ts#L409` | 原子写 `{sessionId, lastActiveAt}`（tmp+rename） |
| 读 | `sessionAlive(timersDir, sid, now, graceMs)` | `extensions/timers.ts#L417` | 文件存在 **且** `now - Date.parse(lastActiveAt) < grace`；缺文件/坏 JSON/读失败 → `false`（fail-closed） |
| 清理 | `sweepStaleHeartbeats(timersDir, opts)` | `extensions/timers.ts#L435` | 删所有 `!sessionAlive` 的 `.json`；返回清理数 |
| 宽限 | `SESSION_HEARTBEAT_GRACE_MS` | `extensions/timers.ts#L31` | `15000` |
| 文件名 | `sessionHeartbeatPath` / `safeSessionId` | `extensions/timers.ts#L395` / `#L390` | `sessions/<encodeURIComponent(sid)>.json`；记录内比较仍用原始 sid |

写侧节拍：`registerTimers` 的 tick `TICK_MS = 5000`（`extensions/timers-runtime.ts#L52`）+ 启动 `STARTUP_FIRE_DELAY_MS = 1500`。`TICK_MS(5000) < grace(15000)` ⇒ **只要会话进程活着（含空闲、无对话），心跳恒新鲜** → 空闲也算「活」（这就是「空闲 master 收得到远程消息」的正确依据）。

### 四个消费点（同一判据、同一全局 attachment owner）

| 消费点 | 落点 | 语义 |
|---|---|---|
| 微信文本注入门 | `extensions/runtime-host/wechat-input.ts#L80-L81` | `owner = readAttachment(masterAddress())`；`!owner \|\| !sessionAlive(timersDir, owner.sessionId, now)` → `skipped/master-offline`（不注入、只审计） |
| 执行器 `master-offline` 409 预检（claim **之前**） | `extensions/runtime/command-executor.ts#L195-L213` | `trustedLocal && guiEnabled && masterAlive !== true` 且目标 == 当前 owner → 409，**不占幂等键**（master 上线后同 `commandKey` 可真正执行） |
| 执行器 handler 护栏（同一布尔，**不重算证据**） | `extensions/runtime/command-executor.ts#L524-L540` | 策略面 `TrustedMasterInjectionPolicy`（三条件合取，见 [[GUI 解锁 Master]]） |
| host `masterAlive` 投影（注入策略计算） | `extensions/runtime-host/server.ts#L750-L758` | 仅当 `peek.type === "session.message"` 且目标 == 当前 master owner 才算，值 = `sessionAlive(timersDir, att.sessionId, …)` |
| 微信 `/v1/wechat/input/status` 的 `masterAlive` | `extensions/runtime-host/server.ts#L1071-L1074` | GUI「为什么没进来」红/绿 |
| 心跳清扫 | `extensions/timers-runtime.ts#L227-L230` → `timers.ts#L435` | 每 12 tick（≈60s）跑；**仅非标签页分支**（`if (!tabRunId)`） |

### tick 分支与标签页盲区（根因）

`registerTimers` 的 tick（`extensions/timers-runtime.ts#L214-L225`）：

```ts
const tabRunId = getTabRunId();
const sid = getCurrentSessionId();
if (tabRunId) {
    // B：标签页若恰为全局 attachment owner，也写心跳
    if (sid && isCurrentAttachmentOwner(sid)) touchSessionHeartbeat(timersDir, sid);
    pumpDueTimers(pi, timersDir, { tabRunId, ... });
} else {
    if (sid) touchSessionHeartbeat(timersDir, sid);
    pumpDueTimers(pi, timersDir, { cwd: process.cwd(), sessionId: sid, ... });
}
```

- **历史（B 之前）**：`if (tabRunId)` 分支只 `pumpDueTimers`，**从不写心跳**。全局 master 若是标签页会话（`--tab-run-id` 非空）→ 它的心跳文件从不存在 → `sessionAlive` 恒 `false` → 四个消费点全判离线。
- **B（2026-10-12，工作区未提交）**：仅当本会话 sid == 全局 `masterAddress()` attachment owner 时补写（`isCurrentAttachmentOwner`，`extensions/timers-runtime.ts#L558`：`readAttachment(masterAddress())?.sessionId === sessionId`，tolerant/never-throw，缺 sid/读失败 → false 回退旧行为）。**只对 owner 写**，非 owner 标签页不写（不污染心跳目录）。
- **作用域取舍**：只判**全局** `masterAddress()`。local master 的活性走 `state/scope-liveness/<scope>.json` 的 pid 判活（见 [[Local Master 认领与接管]]），不依赖会话心跳 ⇒ local owner **有意不写**。

### 与 `state/master-liveness.json` 的区分（易踩坑）

`state/master-liveness.json` 是**另一根轴**：由 `agent_start`/`agent_end` 写（`extensions/runtime/liveness.ts#L10`，落点 `#L156`），用于压力/续任（如 `command-executor.ts#L448` 的错误文案）。它与会话心跳**同名不同物**：会话心跳 tick 级、判「在线」；`master-liveness.json` 按轮写、判压力/续任。把二者混为一谈会得出「空闲 master 收不到消息」的错误结论。

## 根因事件（2026-10-11，诊断）

- 症状：开机自启后微信消息不再进会话；所有微信输入被注入器以 `master-offline` 跳过，每 5s 重试同一条消息持续 13h（7622 次）。
- 根因（代码级）：全局 master 是**标签页会话**（pid 命令行含 `--tab-run-id tab_…`），tick 走标签页分支 ⇒ 从不写心跳；`timers/sessions/` 里**从未**出现该 sid 的心跳文件 ⇒ `wechat-input.ts#L81` 恒 `master-offline`。
- **不是** daemon/runtime 自启失败：`pi-runtime-host-boot` / `pi-master-resume-boot` 均 Ready、`LastTaskResult=0x0`，host `/v1/health` 200、微信 worker 存活。
- 单变量验证：手写一次 `timers/sessions/<sid>.json`（`lastActiveAt=now`）→ 2s 后审计即 `accepted/injected`；45s 后心跳过期 → 又回 `master-offline`（证明「只差这一个心跳文件」，也证明无人刷新）。

## Evidence

- `extensions/timers.ts#L31`（宽限）、`#L390-L396`（文件名）、`#L409-L414`（写）、`#L417-L431`（读）、`#L435-L457`（清扫）。
- `extensions/timers-runtime.ts#L52`（`TICK_MS=5000`）、`#L214-L232`（tick 分支 + 定期维护）、`#L558-L566`（`isCurrentAttachmentOwner`）。
- `extensions/runtime-host/wechat-input.ts#L80-L81`；`extensions/runtime/command-executor.ts#L195-L213`、`#L524-L540`；`extensions/runtime-host/server.ts#L750-L758`、`#L1071-L1074`。
- `extensions/runtime/liveness.ts#L10`、`#L156`（`master-liveness.json` 另一轴）。
- 根因与单变量实验：`plans/20261012_wechat_master_offline_diagnosis.md`；B 语义与影响面论证：`plans/20261012_bc_fix_plan.md` §2。
- 实现与单测：`plans/20261012_bc_fix_impl.md`（T-B1..T-B4，`npm run test:timers-runtime` PASS）。
- 校准状态：B 改动为**工作区未提交**（基线提交 `e12954f`）；其余（判据函数 / 消费点 / 根因）为已核实源码事实。

## Links Out

- [[GUI 解锁 Master]]
- [[微信 iLink 通道]]
- [[Master 交接继任者形态]]
- [[Local Master 认领与接管]]
- [[Wiki 索引]]

## Backlinks

- [[GUI 解锁 Master]]
- [[微信 iLink 通道]]
- [[Master 交接继任者形态]]
- [[Local Master 认领与接管]]
- [[Wiki 索引]]

## Open Questions

- `sweepStaleHeartbeats` 只在**非标签页**分支跑（`timers-runtime.ts#L229`）：若系统里唯一的常驻 master 是标签页，死标签页的心跳文件不会被清扫（仅磁盘卫生，`sessionAlive` 只看新鲜度）。
- B 的「标签页 owner 写心跳」仅在**新代码/扩展重载后**生效；升级瞬间仍可能有旧标签页进程不写心跳（见 [[Master 开机自启与防双开]] 的判据 2 残留）。
