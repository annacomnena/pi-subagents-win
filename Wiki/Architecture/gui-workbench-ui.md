---
title: GUI 工作台 UI（token / 组件 / 导航）
kind: architecture
status: current
updated: 2026-09-30
source_paths:
  - gui/src/index.css
  - gui/src/ui/index.tsx
  - gui/src/App.tsx
  - gui/src/main.tsx
  - gui/src/store.ts
  - gui/src/pages/Sidebar.tsx
  - gui/src/pages/TimelinePage.tsx
  - gui/src/pages/RuntimeOverlay.tsx
---

# GUI 工作台 UI（token / 组件 / 导航）

## Summary

GUI 工作台（`gui/`）的视觉与导航现状：整表移植 ZCode 的语义 token 体系、暗色单主题常驻；组件层是「shadcn 套件为内核 + `ui/index.tsx` 薄适配层」的双体系；导航契约为「顶栏 + 常驻左栏（会话列表 + 次级导航）+ 中央主路由（chat/timeline 两 Tab）+ 运行时全屏覆盖层」。消息数据面另见 [[GUI 消息管道与延迟贡献项]]。

## 主题 token 体系（index.css）

- **底座 1:1 移植**：token 保 zcode 原名，值照抄 zcode `packages/ui/src/styles.css`——`:root` 亮色定义（仅留定义，不接切换器）+ `.theme-zai-dark` 生效值。`main.tsx` 给 `documentElement` 常挂 `.theme-zai-dark`，**暗色是唯一生效主题**，无切换器（`gui/src/index.css:22-162`、`gui/src/main.tsx:12`）。
- **四枚有意补齐**（zcode 未定义，按暗色可读性拍板取值，非照抄）：`ring`（亮 `rgba(0,0,0,0.35)` / 暗 `rgba(255,255,255,0.5)`，调制后 ≈25% 白环）、`muted`（暗 `#242424`，背景与卡底之间的抬升档）、`muted-foreground`（暗 = neutral-400）、`info`（暗 `#38bdf8`，真信息蓝）（`gui/src/index.css:89-93,153-160`）。
- **一处有意偏离 zcode 原值**：暗色 `foreground-subtlest` 由 30% 调到 50%（对比度 ≈2.2:1 → ≈4:1），测试断言同步（`gui/src/index.css:161`）。
- **信息分级约定**：`foreground-subtle`（60% 调制）= 信息性文字（导语、ID、相对时间、缺字段提示）；`foreground-subtlest`（暗 50% 调制）= **仅装饰**（空态图标、占位、水印）。信息性内容不得用 subtlest。
- **字阶**：`--ui-font-size: 14px` 基准派生 `text-ui-2xs…ui-xl` 七档；mono 字体显式加入 CJK 段（Consolas 无中文字形）（`gui/src/index.css:17-33,23-26`）。
- shadcn 语义 variant（`data-open`/`data-checked`/`data-active`/`data-horizontal` 等）按 shadcn 4.1.1 dist 手写在 `index.css`，不引 shadcn 包（`gui/src/index.css:384-445`）。

## 组件双体系（shadcn 内核 + 薄适配层）

- **内核 = shadcn 套件**：`gui/src/ui/` 下 button/badge/card/dialog/dropdown-menu/input/textarea/tabs/toast/tooltip/separator/spinner/collapsible/kbd 均为 shadcn 组件（Radix 行为 + 语义 token），`cn`（tailwind-merge）合并 class。
- **适配层 = `gui/src/ui/index.tsx`**：面向八页的手写门面，prop API 稳定，页内 import 零改动即可换内核——
  - `Button`：内核 shadcn Button，legacy 四档 variant 映射（primary→default / secondary / danger→destructive / ghost），新增 size/class 透传（`gui/src/ui/index.tsx:17-60`）。
  - `Badge`：内核 shadcn Badge（outline 胶囊），七档 tone 全走语义 token；`blue` 档指 `info` 真信息蓝（brand 暗色=纯白，蓝徽章会渲染成白块）（`gui/src/ui/index.tsx:79-101`）。
  - `Card`：内核 shadcn Card size=sm，`bg-card` 实底；标题 `text-ui-sm text-foreground-subtle`（`gui/src/ui/index.tsx:62-77`）。
  - `Toggle`/`EmptyState` 仍为手写但全 token 化；EmptyState 支持可选 icon 且默认色为 subtle 档（`gui/src/ui/index.tsx:112-145`）。
  - `Term` 的「?」hint、`PageIntro`、`ShortId`（点击复制全量）、`RelTime`（悬停显完整时间）为 G5.1 人话化微增组件（`gui/src/ui/index.tsx:147-213`）。
- **Tooltip 统一 radix**：CSS-only 版已删除，`TooltipProvider` 全局挂载于 `App.tsx`（delayDuration=0）（`gui/src/App.tsx:46`）。
- 自研零依赖 Markdown 渲染器 `ui/Markdown.tsx` 产出 `md-*` 字面类，样式在 `index.css` 的 `.md-prose` 块，与 ZCode token 同源（`gui/src/index.css:447-498`）。

## 导航契约

- **三栏壳**（`gui/src/App.tsx:43-70`）：顶栏 `TopBar` + 左栏 `Sidebar`（常驻）+ 中央 `main`。右侧 Inspector 不存在。断连时顶栏下插警告条；底栏常驻「回执条」显示最近命令。
- **主路由只有两个 Tab**：`TabId = "chat" | "timeline"`（`gui/src/store.ts:31`），默认 chat。master/workstream/attention/runtime 四状态页**不占主路由**，收进「运行时」全屏覆盖层。
- **Sidebar 结构**（`gui/src/pages/Sidebar.tsx:24-90`）：264px 宽，折叠 = `w-0 + opacity-0 + pointer-events-none`；自上而下 = 新建会话钮（灰显占位：本地无 create-session 后端）→ `SessionList`（会话列表 + 过滤 Input，常驻）→ 次级导航组（**Timeline 入口**：走既有 `setActiveTab`，再点切回 chat 的 toggle，`aria-current` 显选中态 + `shadow-[inset_2px_0_0_0_var(--color-brand)]` 左侧 2px 高亮条——暗色下「当前在时间线」可见；进入 timeline 的入口只有这一处）→ footer 设置钮（打开 RuntimeOverlay）。
- **TimelinePage 返回契约**（`gui/src/pages/TimelinePage.tsx`）：与 RuntimeOverlay 同口径的三条返回路径——① 页内 Esc（`keydown` 监听 → `setActiveTab("chat")`，useEffect 挂载/卸载随页）② 页头右侧「返回会话」按钮（lucide `ArrowLeft` + 文案，title 标注「也可按 Esc」）③ Sidebar 次级导航 toggle 再点一次。`setActiveTab` 只在 `gui/src/store.ts` 定义，页面不新增状态。
- **RuntimeOverlay 全屏覆盖层**（`gui/src/pages/RuntimeOverlay.tsx`）：壳 = absolute inset-0 整层替换，z 序 `toast 9999 > dropdown 60 > dialog/tooltip 50 > RuntimeOverlay 30 > composer 20`；左栏 68px 图标轨（≥lg 268px 全栏），五 section = attention / master / workstream / runtime / wechat，`runtimeOverlay` 值即打开并定位的 section，Esc 关闭；微信连接入口**始终渲染**（不按 bind status 探测隐藏），403/401 时页内给启用引导。
- **切 Tab = 组件级 remount**（`gui/src/App.tsx:41` 条件渲染）：timeline↔chat 切换时 ChatPage 整树卸载/重挂；行数据在 `store.chatRowsBySession` 缓存不丢，但 DOM 全量重建。大 transcript（2k+ 行）在 `ChatPage.tsx` 采用**分块渲染**：首屏只渲尾部 200 行，贴底时后台分块补齐更早行（回看暂停防跳位，头部占位提示）；切回瞬态（WS 非 down）且行已缓存时跳过 3s 轮询的即时全量 GET。
- 全局轮询编排在 `App.tsx`（2s 档 events/attention/health/interactions，6s 档 snapshot/timeline/sessions），任意 Tab 下都活。

## Focus 基线

- 全局 reset 仅清 `outline`：`*:focus, *:focus-visible { outline: none !important }`——**不清 box-shadow**，shadcn 组件以 `box-shadow`（`ring-*`）实现 focus-visible 焦点环（`gui/src/index.css:185-191`）。
- 高对比（`forced-colors: active`）下恢复系统 `outline: 2px solid Highlight`，因 forced-colors 下 ring 不可靠（`gui/src/index.css:193-199`）。

## Evidence

- token 表与 focus reset：`gui/src/index.css`（`@theme` 亮色基底 L22-94、`.theme-zai-dark` 生效值 L98-162、focus reset L185-199、shadcn variant L384-445）
- 适配层组件与 variant/tone 映射：`gui/src/ui/index.tsx`（BUTTON_VARIANT_MAP L21-26、BADGE_TONES L83-93）
- 布局/路由/轮询/TooltipProvider：`gui/src/App.tsx`（TabId L17-22、三栏 L43-70）
- 暗色常驻：`gui/src/main.tsx:12`
- 导航与覆盖层：`gui/src/pages/Sidebar.tsx`（次级导航组 L54-72、footer L73-87）、`gui/src/pages/TimelinePage.tsx`（Esc 监听 + 页头返回钮）、`gui/src/pages/RuntimeOverlay.tsx`（SECTIONS L26-32、头部注释 z 序与入口语义）

## Links Out

- [[GUI 消息管道与延迟贡献项]]
