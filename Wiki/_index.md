---
title: Wiki 索引
kind: concept
status: current
updated: 2026-09-24
source_paths:
  - plans/0923_decisions.md
  - extensions/hotspot/index.ts
---

# Wiki 索引

## Summary

本 Wiki 是仓库的耐久知识面：只记录跨任务仍成立、已验证（或已拍板）的事实。时序进度看 `recentwork.md`，任务草稿看本地 `plans/`（gitignored，不进库）。

## 页面导航

### 决策（Decisions）

- [[审批门策略]] — D1–D4、D11–D13（`status: proposed`，未实现）
- [[Host 暴露面加固]] — loopback 默认 + opt-in 暴露 + 不热切换（`status: proposed`，未实现）
- [[Runtime Daemon 存活机制]] — 切片一已验证的存活/身份机制（`status: current`）
- [[GUI 解锁 Master]] — 本机受信 GUI 注入 master 的边界（`status: draft`）
- [[Local Master 认领与接管]] — local/global 认领合同、僵尸接管、已知缺口（`status: current`）

### 架构（Architecture）

- [[Runtime Daemon 架构]] — 三层结构、写侧迁移顺序、G0/G1 闸口（`status: draft`）
- [[统一审批门架构]] — 三端共用一门、TOCTOU、超时（`status: proposed`）
- [[微信 iLink 通道]] — Client Plane 通道定位、七项待测未知项（`status: proposed`）
- [[主动性套件（Autonomy Suite）]] — v1 纯函数层 + v2 唤醒总门 / 状态行 / /autonomy 命令已接线（`status: current`）
- [[Hotspot 工作集]] — v4 短期工作集 projection：采集、衰减、注入门与 lookup（`status: current`）
- [[GUI 消息管道与延迟贡献项]] — 消息不及时的逐项归因 + pi core 限制（`status: current`）
- [[Wake 回信（round-trip 回执）]] — wake-spawn tab 无发信工具，回信必须走 deliverLetter 的渠道与 prompt 契约（`status: current`）
- [[Work Graph 只读关系面]] — 既有四对象之上的只读关系面（引用式边 + 纯投影 + diff，零接线影子）（`status: current`）

## Links Out

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
- [[Wake 回信（round-trip 回执）]]
- [[Work Graph 只读关系面]]

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
- [[Wake 回信（round-trip 回执）]]
- [[Work Graph 只读关系面]]

## Open Questions

- G0 完整 10/10 实测、微信真网七项测量完成后，各相关页面的状态需要重新判定。
