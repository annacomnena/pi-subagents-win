---
title: Wiki 索引
kind: concept
status: current
updated: 2026-10-13
source_paths:
  - plans/0923_decisions.md
  - extensions/hotspot/index.ts
  - extensions/runtime/expectations.ts
---

# Wiki 索引

## Summary

本 Wiki 是仓库的耐久知识面：只记录跨任务仍成立、已验证（或已拍板）的事实。时序进度看 `recentwork.md`，任务草稿看本地 `plans/`（gitignored，不进库）。

## 页面导航

### 决策（Decisions）

- [[审批门策略]] — D1–D4、D11–D13（`status: proposed`，未实现）
- [[Host 暴露面加固]] — loopback 默认 + opt-in 暴露 + 不热切换（`status: proposed`，未实现）
- [[Runtime Daemon 存活机制]] — 切片一已验证的存活/身份机制（`status: current`）
- [[GUI 解锁 Master]] — 本机受信 GUI 注入 master 的三证据合取窄路径 + B 案凭据作用域化（`status: current`）
- [[Local Master 认领与接管]] — local/global 认领合同、僵尸接管、已知缺口（`status: current`）
- [[Master 交接继任者形态]] — 继任者改为非标签页常驻会话（能力档/自启/心跳自写）+ 异步失败收尾（`status: current`）
- [[OpenCode v2 借鉴评估]] — 逐条对照：本仓已具备 6 条地基，差距在读取路径常数成本；含「不抄」清单（`status: current`）

### 架构（Architecture）

- [[Runtime Daemon 架构]] — 三层结构、写侧迁移顺序、G0/G1 闸口（`status: draft`）
- [[统一审批门架构]] — 三端共用一门、TOCTOU、超时（`status: proposed`）
- [[微信 iLink 通道]] — Client Plane 通道定位、七项待测未知项（`status: proposed`）
- [[主动性套件（Autonomy Suite）]] — v1 纯函数层 + v2 唤醒总门 / 状态行 / /autonomy 命令已接线；含**监管账本与默认开启**（派发即登记、六态、`off` vs `optout`）与**主动推动 `supervise-push`**（P1 七条拒绝路径、模板、预算、与 frontier 的 `needs-human` 口径差异）（`status: current`）
- [[Hotspot 工作集]] — v4 短期工作集 projection：采集、衰减、注入门与 lookup（`status: current`）
- [[GUI 消息管道与延迟贡献项]] — 消息不及时的逐项归因 + pi core 限制（`status: current`）
- [[GUI 工作台 UI（token / 组件 / 导航）]] — 语义 token 体系、shadcn 内核 + 适配层、三栏导航契约（`status: current`）
- [[Wake 回信（round-trip 回执）]] — wake-spawn tab 无发信工具，回信必须走 deliverLetter 的渠道与 prompt 契约（`status: current`）
- [[期望账本（⑧ 请求—回执期望）]] — 请求—回执期望的声明/到达/超期语义、两生产者落点、生产侧入账方现状与读取面（含 Graph 只读投影）（`status: current`）
- [[Work Graph 只读关系面]] — 既有四对象之上的只读关系面（引用式边 + 纯投影 + diff；快照 v2，含⑧期望投影；E2.3 起接线、生产缺省 graph 源）（`status: current`）
- [[Local Master Ensure（幂等确保）]] — 主会话按 cwd 幂等确保他仓 local master：四层授权 + 零新增权力 + 严格就绪判据 + #A 消费循环注册语义（`status: current`）
- [[Master 在线判据与远程输入门]] — 会话心跳（`sessionAlive` 15s）为唯一在线门、四消费点、标签页 master 盲区与 B 修复（`status: current`）
- [[Master 开机自启与防双开]] — `pi-runtime-host-boot`/`pi-master-resume-boot` 与 boot-resume P1–P6/G1–G3、G2.5 心跳判据、P2 transfer-window 24h（`status: current`）
- [[Steer 通道（立即插入消息）]] — Master → 运行中 tab 的立即投递：steer/abort 两档、落盘回执状态机、写前守卫与 scope、已知限制 NF-1（`status: current`）
- [[异步 Run 控制面（list / kill）]] — async subagent 的观察与终止：list 脉搏、整棵进程树 kill、双重安全校验、幂等终态（`status: current`）

## Links Out

- [[审批门策略]]
- [[Host 暴露面加固]]
- [[Runtime Daemon 存活机制]]
- [[GUI 解锁 Master]]
- [[Local Master 认领与接管]]
- [[Master 交接继任者形态]]
- [[Runtime Daemon 架构]]
- [[统一审批门架构]]
- [[微信 iLink 通道]]
- [[主动性套件（Autonomy Suite）]]
- [[Hotspot 工作集]]
- [[GUI 消息管道与延迟贡献项]]
- [[GUI 工作台 UI（token / 组件 / 导航）]]
- [[Wake 回信（round-trip 回执）]]
- [[期望账本（⑧ 请求—回执期望）]]
- [[Work Graph 只读关系面]]
- [[Local Master Ensure（幂等确保）]]
- [[Master 在线判据与远程输入门]]
- [[Master 开机自启与防双开]]
- [[Steer 通道（立即插入消息）]]
- [[异步 Run 控制面（list / kill）]]

## Backlinks

- [[审批门策略]]
- [[Host 暴露面加固]]
- [[Runtime Daemon 存活机制]]
- [[GUI 解锁 Master]]
- [[Local Master 认领与接管]]
- [[Runtime Daemon 架构]]
- [[统一审批门架构]]
- [[微信 iLink 通道]]
- [[主动性套件（Autonomy Suite）]]
- [[Hotspot 工作集]]
- [[GUI 消息管道与延迟贡献项]]
- [[GUI 工作台 UI（token / 组件 / 导航）]]
- [[Wake 回信（round-trip 回执）]]
- [[期望账本（⑧ 请求—回执期望）]]
- [[Work Graph 只读关系面]]
- [[Local Master Ensure（幂等确保）]]
- [[Master 在线判据与远程输入门]]
- [[Master 交接继任者形态]]
- [[Master 开机自启与防双开]]
- [[Steer 通道（立即插入消息）]]
- [[异步 Run 控制面（list / kill）]]

## Open Questions

- G0 完整 10/10 实测、微信真网七项测量完成后，各相关页面的状态需要重新判定。
