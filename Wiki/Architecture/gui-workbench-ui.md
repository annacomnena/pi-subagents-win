---
title: GUI 工作台 UI（token / 组件 / 导航）
kind: architecture
status: current
updated: 2026-10-01
source_paths:
  - gui/src/index.css
  - gui/src/ui/index.tsx
  - gui/src/App.tsx
  - gui/src/main.tsx
  - gui/src/store.ts
  - gui/src/pages/Sidebar.tsx
  - gui/src/pages/TimelinePage.tsx
  - gui/src/pages/RuntimeOverlay.tsx
  - gui/src/pages/SessionList.tsx
  - gui/src/workspaceGroup.ts
  - gui/src/workspaceRailExpand.ts
  - gui/src/pages/AutonomyPage.tsx
  - extensions/runtime-host/session-title.ts
  - extensions/runtime/transcript.ts
  - extensions/hotspot/inject.ts
  - extensions/_test_session_title.ts
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
- **主路由只有两个 Tab**：`TabId = "chat" | "timeline"`（`gui/src/store.ts:31`），默认 chat。master/workstream/attention/runtime 四状态页 + wechat（微信连接）、autonomy（主动性）两设置页**不占主路由**，收进「运行时」全屏覆盖层。
- **Sidebar 结构**（`gui/src/pages/Sidebar.tsx:24-90`）：264px 宽，折叠 = `w-0 + opacity-0 + pointer-events-none`；自上而下 = 新建会话钮（灰显占位：本地无 create-session 后端）→ `SessionList`（会话列表 + 过滤 Input，常驻）→ 次级导航组（**Timeline 入口**：走既有 `setActiveTab`，再点切回 chat 的 toggle，`aria-current` 显选中态 + `shadow-[inset_2px_0_0_0_var(--color-brand)]` 左侧 2px 高亮条——暗色下「当前在时间线」可见；进入 timeline 的入口只有这一处）→ footer 设置钮（打开 RuntimeOverlay）。
- **TimelinePage 返回契约**（`gui/src/pages/TimelinePage.tsx`）：与 RuntimeOverlay 同口径的三条返回路径——① 页内 Esc（`keydown` 监听 → `setActiveTab("chat")`，useEffect 挂载/卸载随页）② 页头右侧「返回会话」按钮（lucide `ArrowLeft` + 文案，title 标注「也可按 Esc」）③ Sidebar 次级导航 toggle 再点一次。`setActiveTab` 只在 `gui/src/store.ts` 定义，页面不新增状态。
- **RuntimeOverlay 全屏覆盖层**（`gui/src/pages/RuntimeOverlay.tsx`）：壳 = absolute inset-0 整层替换，z 序 `toast 9999 > dropdown 60 > dialog/tooltip 50 > RuntimeOverlay 30 > composer 20`；左栏 68px 图标轨（≥lg 268px 全栏），六 section = attention / master / workstream / runtime / wechat / **autonomy（主动性）**——`RuntimeOverlaySection` 六值 union（`gui/src/store.ts:38`），`runtimeOverlay` 值即打开并定位的 section，Esc 关闭；autonomy 页 = `AutonomyPage`（AutonomySettings 总门开关 + frontier 可视化，自微信页拆出，详见 [[主动性套件（Autonomy Suite）]]）；微信连接入口**始终渲染**（不按 bind status 探测隐藏），403/401 时页内给启用引导。
- **切 Tab = 组件级 remount**（`gui/src/App.tsx:41` 条件渲染）：timeline↔chat 切换时 ChatPage 整树卸载/重挂；行数据在 `store.chatRowsBySession` 缓存不丢，但 DOM 全量重建。大 transcript（2k+ 行）在 `ChatPage.tsx` 采用**分块渲染**：首屏只渲尾部 200 行，贴底时后台分块补齐更早行（回看暂停防跳位，头部占位提示）；切回瞬态（WS 非 down）且行已缓存时跳过 3s 轮询的即时全量 GET。
- 全局轮询编排在 `App.tsx:32-42`（2s 档 health/events/attention/interactions；6s 档 snapshot/sessions/timeline），任意 Tab 下都活，两处例外：**timeline 6s 档按需门控**（`usePoll` 第三参 = `activeTab === "timeline" || runtimeOverlay === "master"`，消费方不在场不拉）；sessions/snapshot 走条件请求（ETag/304 命中回 304 空体）——带宽口径见 [[GUI 消息管道与延迟贡献项]]。

## 会话列表标题契约（/v1/sessions → 左栏 SessionList）

- **字段**：条目 `title` + `titleSource`（`ledger | first-user | id`），服务端解析链权威产物（`extensions/runtime-host/session-title.ts`）；GUI 只渲染，不自行派生。`titleSource==='ledger'` 同时是「全 tab 组默认折叠」判据（`workspaceGroup.resolveGroupOpen`）；`!=='id'` 时行内显示 title，`'id'` 时灰显 shortId。
- **P1 ledger**：全局 tab-runs 台账（`~/.pi/agent/tab-runs/<runId>.json` 顶层记录，env `PI_TAB_RUNS_DIR` 覆盖）；同 cwd 桶 + 首条 user 严格前缀匹配 + 派发时间窗（会话不得早于派发 60s）。派发会话首条 user 常以注入块（`<file>`/`<skill>` 等 registry 标签）包装、前缀行在块内 → 匹配前只跳过首个开标签行（`ledgerProbeFirstLine` 用 registry 通用的 `LEADING_OPEN_TAG`），只剥开标签行、不剥整块——整块剥除是 P2 语义，会把块内前缀行一并剥掉。
- **P2 first-user**：`transcript.ts readHead` 分块头扫描——首读 32KB（取首行头），header 解析成功且未见首条 user 则以 64KB 分块续扫，上限 256KB，命中即提前停（800 会话全扫 ≈200ms）；跨块半截行以 `pending` 携带、跨块多字节字符由 `StringDecoder("utf8")` 解码（普通 `toString("utf8")` 会在块边界把多字节字符烧成 `U+FFFD`）；窗口打满后首个被截断的完整行视半截行丢弃。`firstUserText` 截 8000 字符（需覆盖附件块闭合）。派生前由 **`MACHINE_INJECTED_TAGS` registry（标签 → 注入源）生成的通用正则**做两段对称剥离，顺序 = 先尾部后领头：
  - **尾部循环剥**（`TRAILING_INJECTED_BLOCK`）：正文末尾已闭合注入块逐个剥（hotspot 注入恒追加在首条 user 消息末尾，`inject.ts` 返回 `text: \`${text}\n\n${sel.block}\``；循环处理叠尾）。
  - **领头循环剥**（`LEADING_CLOSED_BLOCK`，`stripLeadingAttachmentBlocks`）：开头已闭合注入块连续剥（file → system-reminder → skill …可多块）；领头开标签到文本尾无闭合（8000 截断把闭合截掉）→ `LEADING_UNCLOSED_BLOCK` 判定整段视附件返回空串；剥空 → null 回退 P3。
  - **registry 四标签**（各带注入源注释，单点扩展：新注入块只加一行，正则自动生效）：`<file>` = pi harness 附件包装（领头）；`<skill>` = pi skill 展开、用户原文在 `</skill>` 后（领头）；`<system-reminder>` = hotspot v2 首轮注入（领头/尾部，存量）；`<recent-working-set>` = hotspot v4 注入恒追加尾部。
  - **防误伤硬约束**：只剥 registry 内标签，registry 之外零剥离（用户正文自带未知 XML 开头 → 不剥、原样取该行）；任何「剥所有领头 XML」的通用结构规则不采用。截 24 字符（taskTitleLabel 同款规则独立重实现）。
- **P3 id**：会话 id 兜底。
- **行数上限（与标题契约同屏）**：每组非置顶可见行默认 3（`workspaceGroup.ts` 的 `GROUP_VISIBLE_LIMIT = 3`），超出收进「还有 N 个 · 展开查看全部」行；置顶行豁免不计、展开态持久化 `saw-ws-overflow`（`workspaceRailExpand.ts` 统一读写 localStorage）。
- **结构性降级（正常态，非 bug）**：gc-cleaner 把终态台账记录移入 `_archived/`（解析链只读顶层）→ 历史派发会话的 P1 永久不可达，按链降 P2/P3；新派发会话在台账归档前可命中 P1。

## Focus 基线

- 全局 reset 仅清 `outline`：`*:focus, *:focus-visible { outline: none !important }`——**不清 box-shadow**，shadcn 组件以 `box-shadow`（`ring-*`）实现 focus-visible 焦点环（`gui/src/index.css:185-191`）。
- 高对比（`forced-colors: active`）下恢复系统 `outline: 2px solid Highlight`，因 forced-colors 下 ring 不可靠（`gui/src/index.css:193-199`）。

## Evidence

- token 表与 focus reset：`gui/src/index.css`（`@theme` 亮色基底 L22-94、`.theme-zai-dark` 生效值 L98-162、focus reset L185-199、shadcn variant L384-445）
- 适配层组件与 variant/tone 映射：`gui/src/ui/index.tsx`（BUTTON_VARIANT_MAP L21-26、BADGE_TONES L83-93）
- 布局/路由/轮询/TooltipProvider：`gui/src/App.tsx`（TabId L17-22、三栏 L43-70）
- 暗色常驻：`gui/src/main.tsx:12`
- 导航与覆盖层：`gui/src/pages/Sidebar.tsx`（次级导航组 L54-72、footer L73-87）、`gui/src/pages/TimelinePage.tsx`（Esc 监听 + 页头返回钮）、`gui/src/pages/RuntimeOverlay.tsx`（SECTIONS L26-32、头部注释 z 序与入口语义）
- 会话列表标题契约：`extensions/runtime-host/session-title.ts`（解析链 + `MACHINE_INJECTED_TAGS` registry 四标签（file/skill/system-reminder/recent-working-set，各带注入源注释）→ 生成 `LEADING_OPEN_TAG/LEADING_CLOSED_BLOCK/LEADING_UNCLOSED_BLOCK/TRAILING_INJECTED_BLOCK` 通用正则、领头/尾部循环剥、只剥 registry 内标签防误伤、剥空回退 P3、P1 `ledgerProbeFirstLine` 开标签行跳过同为 registry 通用）、`extensions/hotspot/inject.ts`（注入恒 `text: ${text}\n\n${sel.block}` 追加在首条 user 消息末尾）、测试 `extensions/_test_session_title.ts`（T12a/T12b：尾部 recent-working-set 块 → title 不含标签、回退 P3；T13a–T13e：纯 skill→null、skill+正文→取正文、领头 skill+尾部 RWS→取中间正文、registry 外 XML 不剥防误伤、存量回归，`npm run test:session-title`）、`extensions/runtime/transcript.ts`（`readHead` 分块扫描常量 `HEAD_READ_BYTES/HEAD_CHUNK_BYTES/HEAD_SCAN_MAX_BYTES`、`StringDecoder` 跨块解码、`FIRST_USER_TEXT_CAP`）、`gui/src/workspaceGroup.ts`（`GROUP_VISIBLE_LIMIT = 3`、`resolveGroupOpen`）、`gui/src/workspaceRailExpand.ts`（`saw-ws-overflow` 展开态）、`extensions/runtime-host/server.ts:1404`（`titleSource` 字段下发）
- 覆盖层六 section 与主动性入口：`gui/src/store.ts:38`（`RuntimeOverlaySection` union）、`gui/src/pages/RuntimeOverlay.tsx:28-35`（SECTIONS 表）、`gui/src/pages/AutonomyPage.tsx`
- 轮询门控与条件请求：`gui/src/App.tsx:32-42`（timeline `usePoll` 第三参门控）
- 提交：`ffdef07`（会话列表标题契约节）、`b619edb`（StringDecoder 跨块 UTF-8 + 注释同步）、`eef10cb`（每组可见行 6→3）、`6ee8191`（覆盖层第 6 section + AutonomySettings 迁出微信页）。

## Links Out

- [[GUI 消息管道与延迟贡献项]]
