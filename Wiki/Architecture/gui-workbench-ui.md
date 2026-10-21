---
title: GUI 工作台 UI（token / 组件 / 导航）
kind: architecture
status: current
updated: 2026-10-22
source_paths:
  - gui/src/index.css
  - gui/src/writeCard.ts
  - gui/src/pages/WriteCard.tsx
  - gui/src/pages/ChatPage.tsx
  - gui/src/_test_write_card.ts
  - gui/src/theme.ts
  - gui/src/useTheme.ts
  - gui/src/pages/TopBar.tsx
  - gui/src/pages/AppearancePage.tsx
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
  - gui/src/pages/WorkstreamPage.tsx
  - gui/src/api/types.ts
  - gui/src/usePoll.ts
  - gui/src/useEventStream.ts
  - gui/src/_test_contrast.ts
  - gui/src/_test_session_first.ts
  - extensions/runtime-host/server.ts
  - extensions/runtime-host/ws.ts
  - extensions/runtime-host/session-title.ts
  - extensions/runtime/transcript.ts
  - extensions/hotspot/inject.ts
  - extensions/_test_session_title.ts
---

# GUI 工作台 UI（token / 组件 / 导航）

## Summary

GUI 工作台（`gui/`）的视觉与导航现状：Anthropic 暖纸语义 token 体系 + **双档主题（默认暖亮、可一键切暖暗，内存态不持久化）**；组件层是「shadcn 套件为内核 + `ui/index.tsx` 薄适配层」的双体系；导航契约为「顶栏 + 常驻左栏（会话列表 + 次级导航）+ 中央主路由（chat/timeline 两 Tab）+ 运行时全屏覆盖层」。消息数据面另见 [[GUI 消息管道与延迟贡献项]]。

## 主题 token 体系（index.css）

- **底座（2026-10-15 起 Anthropic 暖纸体系，非 ZCode）**：`@theme` 是亮色基底（`gui/src/index.css:24`），两档生效值分别为 `.theme-warm-dark`（`gui/src/index.css:158`）与 `.theme-warm-light`（`gui/src/index.css:245`）；`applyTheme` 先清两档再挂当前档，防并存歧义（`gui/src/theme.ts`）。
- **默认档 = `warm-light`**（2026-10-19 用户改口径，原「暖暗优先」作废；`gui/src/theme.ts:26` `DEFAULT_THEME`）。`main.tsx` 挂 `DEFAULT_THEME`；`applyColorScheme` 同步 `color-scheme`（原生滚动条跟随）。
- **切换入口两处、共享单份状态**：顶栏开关（`gui/src/pages/TopBar.tsx`，`data-theme-toggle="1"`，tooltip 仅「主题亮/暗」短词，当前档/目标档由 `aria-label` 表达）+ 「外观」页（`gui/src/pages/AppearancePage.tsx`）。状态是 `useTheme.ts` 的**模块级 store + `useSyncExternalStore`**（不是各调用点 `useState`，否则顶栏与设置页各持一份）。
- **不持久化**：`gui/src` 全量禁止 WebStorage（K3 断言，`gui/src/_test_zcode_replica.ts:61` 静态断言 `theme.ts` 零 `localStorage|sessionStorage`），故主题仅本次会话内存态，刷新回默认暖亮；不写 `config.json`、不加后端端点。（注：会话列表的折叠/排序展开态**是** localStorage 持久化的，键 `saw-ws-expansion|saw-ws-overflow|saw-ws-sort|saw-ws-tabgroups`，见 `gui/src/workspaceExpansion.ts` / `workspaceRailExpand.ts` / `workspaceSort.ts`——K3 只约束主题链路，不是全 GUI 禁 WebStorage。）
- **字阶**：`--ui-font-size: 14px` 基准派生七档 `text-ui-2xs…ui-xl`（`gui/src/index.css:20` + `:47-58`；mono 字体显式加入 CJK 段 `:41-43`，Consolas 无中文字形）；`text-ui-3xl` 是主控页压力大数字的**一次性例外**（`:50` 注释明写不得用于列表/正文）。
- shadcn 语义 variant（`data-open`/`data-checked`/`data-active`/`data-horizontal` 等）按 shadcn 4.1.1 dist 手写在 `index.css`，不引 shadcn 包（`gui/src/index.css:1014-1074` 的 `@custom-variant` 块）。
- **对比度硬门**：`npm run test:gui-contrast` 实测 **142 对**全部 ≥ 阈值（非 write 基底 **118 对** + write 卡 **24 对** = 暗 12 / 亮 12；正文/元信息/徽章 ≥4.5:1、大字与图标 ≥3:1）；阈值常数与下限断言在 `gui/src/_test_contrast.ts:221-222`（`TEXT_MIN=4.5` / `GRAPHIC_MIN=3`）与 `:460`（`pairs >= 107` 防误删）+ ④ 段负向自检证明阈值真会拦。
- **四枚补齐 token（2026-10-15 暖纸体系当前值，已实测）**：`ring`（亮 `brand-ink` 22% 调制 / 暗 `surface-warm` 28%）、`muted`（亮 = `brand-sand` / 暗 = `hover` 暖抬升档）、`muted-foreground`（亮 `#5e5d59` / 暗 = `foreground-subtle`）、`info`（亮 `#2d70ab` / 暗 = `brand-focus` `#3898ec`，系统唯一冷色）（`gui/src/index.css:116-135,220-240`）。
- **`foreground-subtlest` 取 hex 硬值**：亮 `#6c6b65`（L4 复算修正，原 `#706f69` 在 sidebar 上仅 4.27:1）、暗 `#898880`（§3.1 权威值，5.18:1 on `#141413`）（`gui/src/index.css:91,196,267`）。
- **信息分级约定（单位：本页唯一版本；旧版重复段已合并）**：`foreground-subtle`（60% 调制）= 信息性文字（导语、ID、相对时间、缺字段提示）；`foreground-subtlest`（暗 50% 调制）= **仅装饰**（空态图标、占位、水印）。信息性内容不得用 subtlest。实测存量：`text-foreground-subtlest` **43 处**（分母 = `gui/src/pages/*.tsx` + `gui/src/ui/*.tsx` 全量 grep）：ChatPage 20 / TopBar 7 / SessionList 7 / dropdown-menu 5 / Sidebar 1 / index 1 / input 1 / textarea 1——改任一处前先确认它真的是「装饰」而不是「信息性文字」。

## 组件双体系（shadcn 内核 + 薄适配层）

- **内核 = shadcn 套件**：`gui/src/ui/` 下 button/badge/card/dialog/dropdown-menu/input/textarea/tabs/toast/tooltip/separator/spinner/collapsible/kbd 均为 shadcn 组件（Radix 行为 + 语义 token），`cn`（tailwind-merge）合并 class。
- **适配层 = `gui/src/ui/index.tsx`**：面向八页的手写门面，prop API 稳定，页内 import 零改动即可换内核——
  - `Button`：内核 shadcn Button，legacy 四档 variant 映射（primary→default / secondary / danger→destructive / ghost），新增 size/class 透传（`gui/src/ui/index.tsx:21-60`，`BUTTON_VARIANT_MAP` L21-26）。
  - `Badge`：内核 shadcn Badge（outline 胶囊），七档 tone 全走语义 token；`blue` 档指 `info` 真信息蓝（brand 暗色=纯白，蓝徽章会渲染成白块）（`gui/src/ui/index.tsx:80-106`，`BADGE_TONES` L87-98）；`naBadge(why?)` = `tone="na"` 缺字段快捷方式（`:109`）。
  - `Card`：内核 shadcn Card size=sm，`bg-card` 实底；标题 `font-display text-ui-lg font-medium text-foreground-subtle`（`gui/src/ui/index.tsx:62-78`）。
  - `Toggle`（`:119`）/`EmptyState`（`:145`，可选 icon + 一个明确出口 `action`）仍为手写但全 token 化；EmptyState 默认色为 subtle 档。
  - `Term` 的「?」hint（`:161`）、`PageIntro`（`:184`）、`ShortId`（`:190`，点击复制全量）、`RelTime`（`:216`，悬停显完整时间）为 G5.1 人话化微增组件。
- **Tooltip 统一 radix**：CSS-only 版已删除，`TooltipProvider` 全局挂载于 `App.tsx`（delayDuration=0）（`gui/src/App.tsx:68`）。
- 自研零依赖 Markdown 渲染器 `ui/Markdown.tsx` 产出 `md-*` 字面类，样式在 `index.css` 的 `.md-prose` 块（`gui/src/index.css:1076+`），与暖纸 token 同源。

## 导航契约

- **三栏壳**（`gui/src/App.tsx:68-92`：`TooltipProvider` L68 / 壳 `div` L69 / 断连警告条 L71-75 / `<Sidebar/>` L77 / `<main>` L79-81 / 覆盖层挂载 L84 / 回执条 L85-90）：顶栏 `TopBar` + 左栏 `Sidebar`（常驻）+ 中央 `main`。右侧 Inspector 不存在。断连时顶栏下插警告条；底栏常驻「回执条」显示最近命令。
- **主路由只有两个 Tab**：`TabId = "chat" | "timeline"`（`gui/src/store.ts:37`；state 初值 `:338`、setter `:339`），默认 chat。master/workstream/attention/runtime 四状态页 + wechat（微信连接）、autonomy（主动性）两设置页**不占主路由**，收进「运行时」全屏覆盖层。
- **Sidebar 结构**（`gui/src/pages/Sidebar.tsx:24-90`）：264px 宽，折叠 = `w-0 + opacity-0 + pointer-events-none`；自上而下 = 新建会话钮（灰显占位：本地无 create-session 后端）→ `SessionList`（会话列表 + 过滤 Input，常驻）→ 次级导航组（**Timeline 入口**：走既有 `setActiveTab`，再点切回 chat 的 toggle，`aria-current` 显选中态 + `shadow-[inset_2px_0_0_0_var(--color-accent)]` 左侧 2px 高亮条（`gui/src/pages/Sidebar.tsx:67`；同款亦用于 `WorkstreamPage.tsx:81`）——暗色下「当前在时间线」可见；进入 timeline 的入口只有这一处）→ footer 设置钮（打开 RuntimeOverlay）。
- **TimelinePage 返回契约**（`gui/src/pages/TimelinePage.tsx`）：与 RuntimeOverlay 同口径的三条返回路径——① 页内 Esc（`keydown` 监听 → `setActiveTab("chat")`，useEffect 挂载/卸载随页）② 页头右侧「返回会话」按钮（lucide `ArrowLeft` + 文案，title 标注「也可按 Esc」）③ Sidebar 次级导航 toggle 再点一次。`setActiveTab` 只在 `gui/src/store.ts` 定义，页面不新增状态。
- **RuntimeOverlay 全屏覆盖层**（`gui/src/pages/RuntimeOverlay.tsx`）：壳 = absolute inset-0 整层替换，z 序 `toast 9999 > dropdown 60 > dialog/tooltip 50 > RuntimeOverlay 30 > composer 20`；左栏 68px 图标轨（≥lg 268px 全栏），**八** section = attention / master / workstream / runtime / **runs（运行）** / wechat / **autonomy（主动性）** / appearance（外观）——`RuntimeOverlaySection` 八值 union（`gui/src/store.ts:44`；SECTIONS 表 `gui/src/pages/RuntimeOverlay.tsx:31-43`，`runs` 项 `:38`），`runtimeOverlay` 值即打开并定位的 section，Esc 关闭；autonomy 页 = `AutonomyPage`（AutonomySettings 总门开关 + frontier 可视化，自微信页拆出，详见 [[主动性套件（Autonomy Suite）]]）；微信连接入口**始终渲染**（不按 bind status 探测隐藏），403/401 时页内给启用引导。
- **切 Tab = 组件级 remount**（`gui/src/App.tsx:19-22` `PAGES: Record<TabId,…>` 表 + `:63` `const Page = PAGES[activeTab]` + `:80` `<Page />` 条件渲染；**无路由库**——`gui/src` 全量零 `react-router`/`useNavigate`/`history.pushState`）：timeline↔chat 切换时 ChatPage 整树卸载/重挂；行数据在 `store.chatRowsBySession` 缓存不丢，但 DOM 全量重建。大 transcript（2k+ 行）在 `ChatPage.tsx` 采用**分块渲染**：首屏只渲尾部 200 行，贴底时后台分块补齐更早行（回看暂停防跳位，头部占位提示）；切回瞬态（WS 非 down）且行已缓存时跳过 3s 轮询的即时全量 GET。
- 全局轮询编排在 `App.tsx:32-61`（2s 档 health/events/attention/interactions；6s 档 snapshot/sessions/timeline；chat 页另有 200/400/500/2000/30000ms 五档），任意 Tab 下都活，两处例外：**timeline 6s 档按需门控**（`usePoll` 第三参 = `activeTab === "timeline" || runtimeOverlay === "master"`，消费方不在场不拉）；sessions/snapshot 走条件请求（ETag/304 命中回 304 空体）——带宽口径见 [[GUI 消息管道与延迟贡献项]]。

### 新增一页 / 一个 section 的改动面（IA 契约，实测计数）

**主路由新增一个 Tab（今天是 `chat | timeline` 两项）须改 3 处，全部类型强耦合、无路由库旁路：**

| # | 文件:行 | 改什么 | 不改的后果 |
|---|---|---|---|
| 1 | `gui/src/store.ts:37` | `TabId` union 加值（接口 `:135-136`、初值/setter `:338-339` 已泛化，通常零改） | `PAGES` 的 `Record<TabId,…>` 缺键 ⇒ `tsc --noEmit` 直接红 |
| 2 | `gui/src/App.tsx:19-22` | `PAGES` 表加一项（import 页面组件） | 同上，类型断点必红 |
| 3 | 入口处（今天是 `gui/src/pages/Sidebar.tsx:57-74` 次级导航组唯一按钮） | 加一个进/出按钮，`aria-current` + `setActiveTab` toggle | 页面存在但**零入口**（不可发现；`plans/20260930_gui_visual_polish_plan.md:29` 明写「TimelinePage 无 UI 入口一事只作风险备注…不加入口（零 IA 变化）」） |

**第 4 处容易被漏：chat 专属的 5 路轮询会被新 Tab 静默关掉。** `App.tsx:45/48/52/54/60` 五处 `usePoll` 的第三个参数全是 `activeTab === "chat"`（流式 200ms、notify 2s、busy 400ms、commands 30s、stop 回执 500ms）⇒ 停在第三个 Tab 上时这五路全停。新增 Tab 时要么把这五路改成 `activeTab !== "timeline"`，要么接受「离开 chat 就无实时聊天面」（今天只有两 Tab、timeline 是排障页，这个代价被默默接受了）。也可参考 `:40` 的反面先例——timeline 那一路用 `activeTab === "timeline" || runtimeOverlay === "master"` **显式列举消费方**。

**覆盖层新增一个 section 须改 4 处（+ 1 处测试契约）：**

| # | 文件:行 | 改什么 |
|---|---|---|
| 1 | `gui/src/store.ts:44` | `RuntimeOverlaySection` union 加值（接口 `:140-141`、初值/setter `:342-343` 泛化，零改） |
| 2 | `gui/src/pages/RuntimeOverlay.tsx:29-39` | `SECTIONS` 表加 `{ id, zh, icon }`（lucide 图标必填，窄栅 68px 只显图标） |
| 3 | `gui/src/pages/RuntimeOverlay.tsx:111-129` | 右内容栏 `{sec.id === "<新id>" && <新页 />}` 分支 |
| 4 | 入口处（顶栏 `TopBar.tsx:207-215` 的「运行时」图标钮，或左栏 footer `Sidebar.tsx:78-87`） | `setRuntimeOverlay("<新id>")`；无入口 = 不可发现 |
| 5 | `gui/src/_test_session_first.ts:55` | F3a 逐 section 断言列表 = **全部 8 个值**（含 `runs`）；**2026-10-22 加固**：列表由 `Record<RuntimeOverlaySection, true>` 穷尽性对象派生 ⇒ 新增 union 成员时 `tsc --noEmit` **直接红**（编译期强制），不再依赖人工记得改 |

**书面的「IA 变化需派发者批准」记载：只有一处，且是条内注释、不是规则**——`gui/src/pages/Sidebar.tsx:56`：「2026-09-30 派发者批准，本次唯一 IA 变化」。等价表述见 `plans/0922_gui_session_first_plan.md:15`（「状态页去向结论：master/workstream/attention/runtime 收进『运行时』全屏覆盖层」属拍板项，含三条理由）；`plans/0922_zcode_ui_layout_research.md:13` 是它的依据（「没有任何一个『状态页』与 Chat 平级——状态以徽标、header 摘要行、侧栏槽位的形式渗入会话主界面」）。**AGENTS.md 与 Wiki 均无「IA 变化须批准」的成文规则**（`grep -rn "IA" AGENTS.md` = 0 命中）⇒ 该约束是会话惯例，不是仓库硬规则。

## 可承载「运行态」的挂载面清单（现状分工，实测）

GUI 里能放「运行中对象」的位置有 **6 类**，各自的现成数据源与变更成本差一个量级：

| # | 挂载面 | 文件:行 | 今天承载什么 | 数据来源 | 变更成本 / IA 影响 |
|---|---|---|---|---|---|
| 1 | **Coverage 覆盖层 section** | `pages/RuntimeOverlay.tsx:31-43` + `:111-129` | 8 个状态/设置页（attention/master/workstream/runtime/**runs**/wechat/autonomy/appearance） | 各页自取（`snapshot.*`、`/v1/autonomy/frontier`、`/v1/wechat/*`） | **最低**：4 处编辑、无路由改动、组件原样复用；IA 影响=「设置层多一项」 |
| 2 | **WorkstreamPage 运行卡片** | `pages/WorkstreamPage.tsx:45,52-58,215-237` | `snapshot.runs` 按 `taskSelector.runSubjects` / `externalTaskId` 过滤后的 `status`+`summary` | `store.snapshot.runs`（6s 轮询 + ETag/304） | **低**：只改一个 `<ul>` 的渲染；但**过滤谓词写死在 L52-58**，非 workstream 归属的 run 永远不显示 |
| 3 | **左栏会话列表行** | `pages/SessionList.tsx:147-220`（行体）、`:223`（容器）、`:259-330`（分组滚动区） | 会话行三段式：16px 状态槽 / 标题+徽标 / `basename(cwd)·相对时间` | `store.chatSessions`（6s，`server.ts:1925-1951` 下发 `title/titleSource/isMaster/isScopeMaster/masterProtected`） | **中**：新增一行「按 run 聚合」需要新数据源 + 新分组键；**IA 影响=左栏语义从「会话」扩到「会话+运行」** |
| 4 | **顶栏状态条** | `pages/TopBar.tsx:129-215` | host 端点/journal 计数/信箱积压/服务点/上下文用量/待决策徽标/主题/运行时入口 | `health`(2s)、`chatSessions`、`chatUsageBySession`（transcript 同源）、`interactions`(2s) | **低-中**：加一个计数徽标 ≈ +8 行；顶栏右区已是 `gap-3` 密集区，宽度是硬约束（窄屏 `hidden md:inline`/`lg:inline` 已有先例） |
| 5 | **TimelinePage 过滤器 + 行** | `pages/TimelinePage.tsx:13-19`（FILTERS）、`:107-125`（行渲染） | journal 人话时间线（`type.startsWith("run.")` 已是「任务运行」档） | `store.timeline`（WS journal 250ms tick 增量 + `/v1/timeline` 6s **按需门控**） | **最低**：run 事件已入 timeline；但**只有 dispatch/terminal 事件**，没有「per-turn 进度」，且是**历史**不是「当前态」 |
| 6 | **新建独立页（主路由 Tab）** | `store.ts:37` + `App.tsx:19-22` + 入口 `Sidebar.tsx:57-74` | — | 需新数据源 | **最高**：3 处类型强耦合编辑 + 1 个入口 + `TabId` 收窄历史（`store.ts:35-36` 注释明写「会话为主重构 S4 收窄」）⇒ **IA 影响最大，直接违背「中央永远是对话视图」的既定口径**（`plans/0922_zcode_ui_layout_research.md:13`） |

**另有两处「隐式挂载面」不算列表页但有先例**：`ChatPage` transcript 行（`pages/ChatPage.tsx:687-702` 的 `RowView` 按 `row.kind` 分派 5 种行 + `:1189-1265` 页面主体与滚动视口，数据源 `/v1/sessions/:id/transcript` + WS `transcript:<sid>`，行契约 `gui/src/api/types.ts:396-410`）与 `AutonomyPage` 的 `runId → phase` 内联文本（`pages/AutonomyPage.tsx:71,84-92`，数据源 `/v1/autonomy/frontier`，5s 轮询 `:126`）。

**「这个 run 是哪个会话派发的」的既有桥（挂载面 3 必需）**：`~/.pi/agent/links.jsonl` 的 `kind:"async"` 行（写点 `extensions/index.ts:4419-4424` 单发 / `:4327`/`:4333` 并行）与 `kind:"tab"` 行（`:3423` local master / `:5123`/`:5184` trace-fusion）。读侧已有两个先例可直接照：`extensions/runtime-host/timeline.ts:181-193`（`listLinks` → `targetId → actor` enrichment，best-effort 静默降级）与 `extensions/runtime-host/delivery-reconciler-loop.ts:198-210`（派发者解析）；左栏筛选「本会话派发的 run」就是这条桥（`subagent-kill.ts` 的 `resolveSessionRun` 同源）。

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

## write 工具卡渲染契约（落笔迷你编辑器）

`write` 是全系统唯一「生产内容」的工具；本卡把它渲染成一块**正在被书写的小编辑纸**（陶土=墨、卡片=纸）。契约如下（改卡前先读本节）：

- **触发面唯一**：`name === "write"` 且 `arguments` 可解析出 `content`（`string` 或 `string[]`，数组按 `\n` join）⇒ 渲染 `WriteCardBody`；否则**保持原 `JSON.stringify(row.arguments, null, 2)` 的 `<pre>` 路径**（`gui/src/pages/ChatPage.tsx:382,463,531`，`readWriteArgs` 是唯一入口 `gui/src/writeCard.ts:32`）。`edit` / `multi_edit` **不得**套用本卡（它们该给 diff，不是文件预览）。
  - `readWriteArgs` 拿不到 `content`（键名不对 / 非 `string`·`string[]` / `arguments` 非对象）时**返回 `null` ⇒ 回退 pre**，**不得**渲染「空白纸」把原始入参吞掉（`content: ""` 是合法入参，仍走本卡）。R5 的形状断言钉住这条。
- **行号契约**：渲染的是**文件绝对行号**（尾部滑窗 `base = total - keep + 1`），React `key = 行号` ⇒ 老行复用 DOM、不重放入场动画。`countLines` **不把结尾 `\n` 当一行**（`gui/src/writeCard.ts:57`），否则每个正常文件都多报 1 行。半行（流式 args 只给到一半）按现有字节渲染，**不等闭合**。
- **几何常数（是 DOM 常数，不是 max-height）**：`WRITE_VISIBLE_ROWS = 10` / `WRITE_KEEP_ROWS = 12`（`gui/src/writeCard.ts:12,14`，即 DOM 里恒 ≤12 个 row 元素）；行高 `--write-row-h: calc((var(--ui-font-size) - 2px) * 1.72)` = 20.64px@14px；视口 `height: calc(var(--write-row-h) * 10 + 18px)` = 224.39px（`gui/src/index.css:598,692`），顶部 26px `mask-image` 渐隐表示「上面还有」。
- **溢出方向必须向上**：`.write-lines` 绝对贴底（`gui/src/index.css:700`）。**不能用 `justify-content:flex-end` 贴底** —— 负剩余空间下规范把它退化为 `flex-start`，正在写的那一行会被顶出下边界（实测踩过）。
- **折行**：一行 = 一个 `grid-template-columns: minmax(30px, max-content) 1fr` 元素 + `white-space: pre-wrap` + `word-break: break-word`（**不用 `break-all`**，它会切断标识符）。不能用「行号列 + 代码列」两块独立容器：遇折行必错位。
- **三幕动效口径**（全部只由 `data-status` + 一个 DOM 类驱动，无 JS 逐帧）：①**落纸** `running` ⇒ 描边 `color-mix(accent 40%, border)`；②**书写** ⇒ 新行 `write-line-in 220ms`（blur 2px→0 + 上浮 3px）+ 末行 `.stream-caret` + 墨线 `inkPercent = 100*(1-e^{-n/11})` **渐近但永不满**（总行数不可知，不假装百分比）+ 笔尖 `write-pen-tip 1.1s` 循环；③**收笔** ⇒ 墨线塌成 1px 残线（`opacity .3`）+ `write-dry-sweep 520ms` + 勾 `write-check-draw 300ms` + 徽标 `write-delta-pop 420ms`。
- **收笔只在「刚写完」那一拍播，且不能让自动合上截断它**：`settling` 由 `ChatPage` 在 `running → 终态` 转场开 `WRITE_SETTLE_MS = 700ms`（`gui/src/pages/ChatPage.tsx:77,413`），**不是**纯 CSS `[data-status="done"]` —— 否则历史卡片挂载时也会播，一屏几十张卡同时弹一下是噪音。
  - **`holdOpen = isWrite && settling && !userLockedRef.current` 必须在 settling 期间压住自动合上**（`autoExpandTarget` 的结果被强制成 `true`，且 `holdOpen` 进 effect 依赖，settling 落下后才真正合上）。没有它时：自动合上 → 300ms 卸载延迟 → 展开体被卸，而扫光是 520ms ⇒ 实测 settling 起 **+350ms 时 `.write-sweep` 已 `ABSENT`**，520ms 的「墨干」只剩前 300ms。
  - 门槛等式：`WRITE_SETTLE_MS ≥ max(扫光 520, 勾 300+90, 徽标 420)`。**改任一动画时长必须重算**；R9 直接读这两处真实常数（`test:write-card`）。
  - **`userLocked` 优先于 `holdOpen`**：用户手动收起 write 卡后，`autoExpandTarget` 返回 `null`（一动不动）；若 `holdOpen` 盖掉它，卡片完成瞬间会被收笔动画强行再展开 700ms 再合上 —— 等于和用户抢开合（`chatAutoExpand.ts` 的既有契约）。
  - 同理 `is-new` 只在 `running` 给；`prefers-reduced-motion: reduce` 下 6 个 keyframes 全 `animation:none` 且只留终态，**且 reduced-motion 选择器必须与动画规则同文本**（`.write-card[data-status="done"].is-settling .write-sweep`；弱化成 `.write-sweep` 会被 specificity 反杀，R7 守门）。
- **error 态判据（据上游写盘语义实测，勿改回「墨停在断点」）**：pi 的 `write` = `mkdir` + `fs.writeFile(path, content, "utf-8")` 的**单次整文件覆盖写**，无 temp+rename、无回滚（`@earendil-works/pi-coding-agent/dist/core/tools/write.js:16-19,30-54`）⇒ **断点不可知**。故 `inkHeightCss(total, "error") === undefined`（`gui/src/writeCard.ts:111`）让 CSS 只画 14px destructive 残线；**「降饱和」不得用 opacity**（`.write-lines` 的三档墨色本身已降过透明度，再乘 .62 ⇒ 亮层 1.98–2.73:1、暗层 2.34–3.16:1，正文跌破 AA；行号乘 .4 ⇒ 1.73:1），改由 destructive 描边 + 残线 + 注脚这些信号承担；`test:gui-contrast` ②b 段断言 error 态不得对 `.write-no`/`.write-lines` 叠 opacity；注脚两段 = 工具真实输出首行 + `WRITE_ERROR_CAVEAT`（`gui/src/writeCard.ts:116`：失败时目标文件**可能**是截断/空文件，也**可能**完全未改动 —— 无法从结果判定）；徽标 error = `N 行 · 未确认`（`未写入` 是不可验证的断言）。测试 R6 静态断言禁止注脚出现「已回滚 / 原文件未改动」。
- **零新增颜色约束**：整卡只用 `--color-accent`（陶土=墨）/ `--color-border` / `--color-card` / `--color-foreground-subtle|subtlest` / `--color-destructive`，浓淡全靠 `color-mix` 与 `opacity`；**不得**引入进度条式第二套色语言（蓝/绿）。三档墨色层次（注释 `.82` / 特性·结构 `.76` / 成员声明 `1.0`）也只调透明度。
  - **文字降透明度后必须仍 ≥4.5:1**（本卡最容易复发的一条）：正文基色是 `--color-foreground`（**不是** `-subtle`），实测（亮/暗）正文 17.50 / 7.32、注释 `.82` 10.29 / 5.39、特性·结构 `.76` 8.30 / 4.83。旧值（`-subtle` 基底 + `.72/.66`）实测亮 3.34/2.95、暗 3.85/3.46，**全部跌破 AA**，而当时 `test:write-card` 与 `test:gui-contrast` 两道门都是绿的 ⇒ 现由 `test:gui-contrast` ②b 段按真实 opacity 合成后逐对断言（含反例自检）。
  - `--color-accent` **只能做非文字**（3.70/4.17:1）：当前行号、`running` 徽标文字一律用 `--color-accent-text`（5.24/5.21:1）；勾图标可用 `--color-accent`（图形门 3:1 即达标，**不用** `--color-success` —— 绿成功 = 第二套色语言）。
- **running 帧的结构性边界（约束后续任何「给工具卡加 running 动效」的设计）**：本地快速写的可见窗口 ≲1ms（实测 6 次真实 `write` 的 toolResult 时间戳彼此差 1ms），而宿主 transcript tail 是 **250ms 一拍**（`extensions/runtime-host/ws.ts:813`）、流式快照只携带 `reasoning|text` **无 partial tool args**（`gui/src/api/types.ts:506`）⇒ GUI 里 `write` 卡实际只会以「已终态」出现；「落纸/书写」两幕只在慢盘 / 超大文件 / 慢网络下可见。要让「书写」真实可见必须改**传输面**（让快照携带 partial tool args），不是改样式。
- **门**：`cd gui && npm run test:write-card`（12 组：纯函数 R1–R4 + R5 接线 + R6 error 口径 + R7 减动效同文本 + R9 收笔时序）、`npm run test:gui-contrast`（②b 段：write 卡 **24 对** = 12 暗 / 12 亮，含透明度合成 + 反例自检；全库合计 142 对）、`npm run build`（`tsc --noEmit && vite build`）。

## Focus 基线

- **`focus-visible` 不由全局 reset 清零**（2026-10-22 校准：旧记载「`*:focus{outline:none!important}`」已不成立）：现行为 `:focus:not(:focus-visible){outline:none}`（鼠标点击不显环）+ `:focus-visible{outline:2px solid var(--color-focus-ring); outline-offset:2px}` —— **outline 就真的在画**，不再是仅靠 shadcn 的 `box-shadow` ring（`gui/src/index.css:334-341`）。
- 高对比（`forced-colors: active`）下以 `!important` 提为系统 `outline: 2px solid Highlight`（`gui/src/index.css:343-349`）。

## Evidence

- token 表与 focus reset：`gui/src/index.css`（`@theme` 亮色基底 L24-136、`.theme-warm-dark` L158-242、`.theme-warm-light` L245-309、`focus` 三段 L334-349、`.tone-chip` L146-151、shadcn `@custom-variant data-*` L1014-1074）；主题纯逻辑 `gui/src/theme.ts`（`DEFAULT_THEME` L26）、共享态 `gui/src/useTheme.ts`、顶栏开关 `gui/src/pages/TopBar.tsx`、外观页 `gui/src/pages/AppearancePage.tsx`、默认主题挂载 `gui/src/main.tsx:14-15`
- 适配层组件与 variant/tone 映射：`gui/src/ui/index.tsx`（BUTTON_VARIANT_MAP L21-26、BADGE_TONES L87-98、naBadge L109）
- 布局/路由/组件门面：`gui/src/App.tsx`（`PAGES: Record<TabId,…>` L19-22、`const Page` L63、三栏壳 L68-92）、`gui/src/ui/index.tsx`（适配层总入口，prop API 见各组件注释）
- 暗色常驻已废止：`main.tsx` 挂 `DEFAULT_THEME = "warm-light"`（2026-10-19 用户改口径），暗色为可选档（`gui/src/theme.ts:26` + `gui/src/main.tsx:11-15`）
- 导航与覆盖层：`gui/src/pages/Sidebar.tsx`（次级导航组 L54-72、footer L73-87）、`gui/src/pages/TimelinePage.tsx`（Esc 监听 + 页头返回钮）、`gui/src/pages/RuntimeOverlay.tsx`（SECTIONS L29-39 七项、右栏 section 分支 L111-129、头部注释 z 序与入口语义）
- 会话列表标题契约：`extensions/runtime-host/session-title.ts`（解析链 + `MACHINE_INJECTED_TAGS` registry 四标签（file/skill/system-reminder/recent-working-set，各带注入源注释）→ 生成 `LEADING_OPEN_TAG/LEADING_CLOSED_BLOCK/LEADING_UNCLOSED_BLOCK/TRAILING_INJECTED_BLOCK` 通用正则、领头/尾部循环剥、只剥 registry 内标签防误伤、剥空回退 P3、P1 `ledgerProbeFirstLine` 开标签行跳过同为 registry 通用）、`extensions/hotspot/inject.ts`（注入恒 `text: ${text}\n\n${sel.block}` 追加在首条 user 消息末尾）、测试 `extensions/_test_session_title.ts`（T12a/T12b：尾部 recent-working-set 块 → title 不含标签、回退 P3；T13a–T13e：纯 skill→null、skill+正文→取正文、领头 skill+尾部 RWS→取中间正文、registry 外 XML 不剥防误伤、存量回归，`npm run test:session-title`）、`extensions/runtime/transcript.ts`（`readHead` 分块扫描常量 `HEAD_READ_BYTES/HEAD_CHUNK_BYTES/HEAD_SCAN_MAX_BYTES`、`StringDecoder` 跨块解码、`FIRST_USER_TEXT_CAP`）、`gui/src/workspaceGroup.ts`（`GROUP_VISIBLE_LIMIT = 3`、`resolveGroupOpen`）、`gui/src/workspaceRailExpand.ts`（`saw-ws-overflow` 展开态）、`extensions/runtime-host/server.ts:1925-1951`（`titleSource` 字段下发）
- 覆盖层 section 与主动性入口：`gui/src/store.ts:44`（`RuntimeOverlaySection` 七值 union）、`gui/src/pages/RuntimeOverlay.tsx:29-39`（SECTIONS 表，含 `appearance` 第 7 项）、`gui/src/pages/AutonomyPage.tsx`
- 轮询门控与条件请求：`gui/src/App.tsx:32-61`（timeline `usePoll` 第三参门控 L40；`usePoll` 三参签名 `gui/src/usePoll.ts:12`）、`gui/src/api/client.ts:62-68,71-110`（etagCache/notModifiedCache + 304 同引用）、`extensions/runtime-host/server.ts:891-908`（`sha1Etag`/`matchEtag`/`respondNotModified`）+ `:1841-1859`（snapshot 接入，ETag 剔除 `generatedAt`）
- write 卡契约：`gui/src/writeCard.ts`（常量 L12,14、`readWriteArgs` L32、`countLines` L57、`inkHeightCss` L111、`WRITE_ERROR_CAVEAT` L116）、`gui/src/pages/WriteCard.tsx`（`WriteCardBody` L38、水位 ref 写进 `useEffect` L67-70、注脚 L107）、`gui/src/pages/ChatPage.tsx`（L77 `WRITE_SETTLE_MS`、L382 `isWrite`、L393-410 `settling`、L413 `holdOpen`、L463 解析、L531 分支）、`gui/src/index.css`（`.write-card` L597、行高 L598、视口 L692、贴底 L700、error 段 L662-683、三档墨色 L746-755）、测试 `gui/src/_test_write_card.ts`；上游写盘语义 `@earendil-works/pi-coding-agent/dist/core/tools/write.js:16-19,30-54`；不可观测边界 `extensions/runtime-host/ws.ts:813`（tail 250ms）+ `gui/src/api/types.ts:506`（快照无 tool args）。提交：`d7964db`（落笔卡 + error 态按实测写盘语义收口）、`cb1ea8f`（本节首次入库）、L4 审查修复见 `plans/20261021_write_card/l4_review_close.md`（4 项 blocking：对比度/收笔被截断/吞入参/恒真断言）。
- 提交：`ffdef07`（会话列表标题契约节）、`b619edb`（StringDecoder 跨块 UTF-8 + 注释同步）、`eef10cb`（每组可见行 6→3）、`6ee8191`（覆盖层第 6 section + AutonomySettings 迁出微信页）。
- **2026-10-22 校准轮（本节行号与读数系统核对，代码为准）**：`TabId` 在 `store.ts:37`（非 L31）；主壳在 `App.tsx:68-92`；`PAGES` 表 `App.tsx:19-22`；轮询编排 `App.tsx:32-61`；`SECTIONS` `RuntimeOverlay.tsx:29-39` + 右栏分支 `:111-129`；`BADGE_TONES` L87-98 / `naBadge` L109；`TooltipProvider` `App.tsx:68`；`titleSource` 下发 `server.ts:1925-1951`（原记 1404 已漂）；`index.css` 的 shadcn `@custom-variant` 在 **1014-1074**（原记 384-445 已漂）与 `.md-prose` 在 **1076+**（原记 447-498）；`focus` 行为已从「全局 outline 清零」改为 `:focus:not(:focus-visible){outline:none}` + `:focus-visible{outline:2px solid var(--color-focus-ring)}`（`index.css:334-349`）；对比度门实测 **142 对**（原记 118）；卡片高亮条用 `--color-accent`（非 `--color-brand`）；`Card` 标题是 `font-display text-ui-lg`（非 `text-ui-sm`）。另新增两节：“新增一页 / 一个 section 的改动面（IA 契约）”与“可承载‘运行态’的挂载面清单”。

## Links Out

- [[GUI 消息管道与延迟贡献项]]
- [[Tab 运行账本与运行态数据面]] — 左栏会话标题的 P1 台账、`/v1/snapshot.runs` 字段面与 GUI 侧消费现状（仅 WorkstreamPage / AutonomyPage 两处间接展示）
