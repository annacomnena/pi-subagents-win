---
title: Runtime Daemon 存活机制
kind: decision
status: current
updated: 2026-09-23
source_paths:
  - extensions/runtime-host/daemon-lifecycle.ts#L149-L163
  - extensions/runtime-host/server.ts#L365
  - extensions/runtime-host/server.ts#L465-L475
  - extensions/runtime-host/discovery.ts#L34-L44
  - extensions/runtime-host/discovery.ts#L215-L218
  - scripts/verify-runtime-g0.ps1
---

# Runtime Daemon 存活机制

## Summary

切片一已验证：daemon 以 `detached:true + stdio:ignore + unref + windowsHide:false` 派生，托管生产 `gui/dist` 静态文件，单实例身份经 `host.json` 九字段 + nonce 挑战确认；关闭发起 tab 后 daemon 存活（pid/health/静态页均正常），vite 不再常驻。**G0 完整 10/10 轮测尚未实测，见 Open Questions。**

## Current Contract

- Spawn 形状必须为 `{detached:true, stdio:'ignore', windowsHide:false}` + `unref()`；DETACHED_PROCESS 与 CREATE_NO_WINDOW（`windowsHide:true`）在 Win32 不可叠用，同用时后者被忽略，子进程回到无控制台短命孙进程各自 alloc 新控制台的老路。
- `windowsHide`-only 方案会随派生它的命令 job 一起死（实测结论），故切到 detached 为主路径。
- 生产只托管静态 `gui/dist`，vite 不再常驻（D5）。
- 单实例：`host.json` 九字段（实例 id、runtimeId、releaseId、端口、token 等）+ 本地 nonce 挑战（HMAC-SHA256，secret = host.json token）；`stale`（进程在、探活失败）→ `uncertain`，绝不盲杀 pid。
- daemon 不在时的共享控制写 fail-closed（拒绝 + 明确报错）；对话/工具/子 agent 照常（D6）。
- opt-in 零侵入：不开此功能即原生 pi 体验（D7）。

## Key Symbols

- `defaultSpawnDaemon` — `extensions/runtime-host/daemon-lifecycle.ts` 派生形状。
- `startRuntimeHost` — `extensions/runtime-host/server.ts`，bind `127.0.0.1:0`，实际端口写盘发现。
- `classifyHost` — `extensions/runtime-host/discovery.ts`，host 四态 `missing/alive/stale/dead` 判定。
- `answerChallenge` / `verifyChallengeResponse` / `runLocalChallenge` — `extensions/runtime-host/identity.ts`（L103 / L118 / L146），nonce 挑战。

## dead 僵尸 / 孤儿锁重建契约（2026-09-23，`e262eb8`）

- **dead host.json（pid 已死）→ 持锁重建**：不再是 `uncertain`。此前 `tryReuse` 对任何
  `state !== "alive"` 都 fail-closed，使文件头声明的"dead pid/坏文件才在确已持锁后重建"分支
  在主路径上**不可达**。
- **孤儿锁（锁 holder 也已死）→ 允许清抢后重建**：取锁失败时，仅当**可证持有人已死**（重读复核
  instanceId 仍一致且仍死）才 `stealStaleLock`；**活锁永不强删**、绝不 kill 任何 pid。这是对
  "取锁失败必须 fail-closed"的唯一收窄（理由：该情形锁并非被活方持有）。
- **仍然 fail-closed（未放松）**：`stale`（pid 活但探活超时）、`runtimeId` 不符、身份挑战失败、
  legacy 弱确权失败、**活锁占用**、**交接等待**（活方持有）——一律不 spawn、不 kill、不删锁、不覆盖。
- **典型症状与恢复**：重启电脑后 daemon 死、host.json 与锁变僵尸 ⇒ 以前 `/gui on` 永远报
  `未确权（dead）… GUI 地址未知`（只能手工删文件）；现在应自动"检测到僵尸，已接管（持锁重建）"。
- **残余**：坏锁（不可解析 ⇒ 无法证死）仍 fail-closed（需人工删锁 / `stop --force`）；清抢存在
  微秒级 TOCTOU（daemon 启动侧二次抢锁串行化）；同进程 own-pid 锁重入仍 fail-closed。

## Evidence

- `extensions/runtime-host/daemon-lifecycle.ts#L15-L16`、`#L149-L163` — 派生形状与 Win32 约束注释。
- `extensions/runtime-host/server.ts#L885` — 真实 `server.listen(0, "127.0.0.1")`（`#L365` 仅是该行为的注释行）；`#L465-L475` — 身份元组与 host token 落盘。
- `extensions/runtime-host/discovery.ts#L34-L44` — host.json 内容契约；`#L215-L218` — `classifyHost` 的 stale 判定（探活失败）。
- `scripts/verify-runtime-g0.ps1` — G0 存活/身份验证脚本（save/check 两阶段；挑战未接线前显式返回 INCONCLUSIVE，不用匿名 health 冒充通过）。
- commit `bdb6674`（daemon 切片一）、本地 `plans/0923_runtime_daemon_slice1_impl.md`、本地 `plans/0923_decisions.md` D5–D7。
- 实测结论：切片一后关闭发起 tab，daemon 仍存活（D5 台账记录）。
- `e262eb8`：dead 僵尸 / 孤儿锁 → 持锁重建（见上节契约）；测试 `extensions/_test_ensure_dead_rebuild.ts`（①①b②③④ 五夹具）。

## Links Out

- [[Runtime Daemon 架构]]
- [[Wiki 索引]]

## Backlinks

- [[Wiki 索引]]
- [[Runtime Daemon 架构]]

## Open Questions

- G0 完整 10/10 轮（各 5 轮"最后 tab"/"整个窗口" + 空壳 WT=0 + 生产 vite/esbuild 孙进程=0）**待实测**，不得写成已通过；以 `scripts/verify-runtime-g0.ps1` 输出 + 人工窗口/进程树核对为准。
