---
title: Wiki 索引
kind: concept
status: current
updated: 2026-09-23
source_paths:
  - plans/0923_decisions.md
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
- [[主动性套件（Autonomy Suite）]] — 主动权 v1 纯函数层（未接线）（`status: draft`）

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

## Open Questions

- G0 完整 10/10 实测、微信真网七项测量完成后，各相关页面的状态需要重新判定。
