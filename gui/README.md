# gui/ — Browser Runtime Workbench v0（G5）

vite + react + ts + tailwind v4 + zustand 的浏览器工作台，经 **vite dev proxy** 同源访问
runtime-host（`/v1/*` 转发，server 零改动：无 CORS、不托管 dist）。

## 视觉体系：Anthropic 暖纸（2026-10-15 起）

界面为 **Anthropic 暖纸体系**：暖炭底 + 暖灰字 + **单一陶土重音**（`#c96442`）+ 环状边框分层
+ **衬线只在 ≥20px 标题**。不再是 ZCode「Zai Dark」1:1 复刻。（S1–S6c 已全量切完：token 底座、
shadcn 套件、门面、12 页面、圆角与焦点收敛。）

**权威文档（改 UI 前先读）**：

| 文档 | 角色 |
|---|---|
| `plans/20261015_gui_anthropic_style_guide.md` | **数值权威**：§3 设计 token 值表、§3.5 圆角 px↔class 映射表、§4 字阶、§6 对比度实测表、§7 逐文件改动清单 |
| `plans/20261015_gui_anthropic_refactor_instructions.md` | 执行切片 S1–S7 + 铁律（红线文件清单）+ 验收清单 |
| `index.html` 配套原型（**不在本仓**，在派发方手上）| **观感参照** |

> ⚠️ 原型 `index.html` **未入库**（仓内 `gui/index.html` 是 vite 入口，不是原型）——只看本仓时，
> 以指导文档 §3/§3.5 的数值为准即可。两者冲突时：**数值听指导文档，观感听原型**。

**硬门（改配色必须复算）**：正文/元信息/徽章 ≥ **4.5:1**；大字与图标 ≥ **3:1**。
暗/亮两主题各 4 个实际表面（`bg-background` / `bg-sidebar` / `bg-panel` / `bg-card`）逐对核。
最新独立复核（L4，从 `dist` 实际 CSS 常量重算）：**102 对全通过**。

**两条易错点**（已踩过）：
1. **圆角 px ≠ 类名直觉**：Tailwind v4 实测 `rounded-md` = **6px**、`rounded-lg` = **8px**。
   一律查 §3.5 映射表，不要靠直觉写类名。
2. **主题是双层的**：`@theme`（亮基底）+ `.theme-warm-dark` / `.theme-warm-light`（生效层）。
   改 token 必须三层同改，否则某主题下静默失效。

## ⚠️ import 惯例分叉（勿互相「修正」）

**gui/ 内所有 import 不带 `.ts` / `.tsx` 扩展名**（vite/esbuild bundler resolution 硬要求）。
这与仓库根 `extensions/` 的 strip-types「强制带 `.ts` 扩展名」惯例**相反**——两边各自成立，
不要把 gui/ 的 import 改成带扩展名，也不要把根代码改成不带。

## 启动

```bash
npm run gui:dev    # 根目录：探活 host（不活则代启）→ 起 vite → 打印 URL（不开浏览器）
npm run gui:build  # tsc --noEmit && vite build
```

## 生产部署（第一切片：daemon 自托管 dist，禁 vite）

生产 GUI = Runtime Daemon 同源静态托管 `gui/dist`（`GET /` + `/assets/*`，`/v1/*`
永不 fallback），随 daemon 不可变 release 同步发布（`npm run gui:build` 产物）。

- **生产永不跑 vite**：`gui/vite.config.ts` 在 `PI_RUNTIME_PROFILE=prod` 下拒绝 dev
  server；`gui/package.json#predev` 同守。浏览器打开 `http://127.0.0.1:<daemon-port>/`
  （`/gui open` 自动 ensure daemon 并打开此地址）。
- **dev profile 隔离**：`npm run gui:dev` 缺省 `PI_RUNTIME_PROFILE=dev`，未显式设
  `PI_RUNTIME_DIR` 时用独立 `~/.pi/agent/runtime-dev`（不碰生产 host.json/host.lock）。

- 端口发现：`GUI_HOST_TARGET` env > `GUI_HOST_PORT` env > `host.json`（`PI_RUNTIME_DIR` 感知）> 兜底 `http://127.0.0.1:4317`。
- **vite 启动时只读一次 host.json**：host 重启换了端口需重启 vite（gui:dev 会自动代启新 host，实际影响窗口极小）。
- `/runtime-host start` 行为零变化（不会自动开浏览器）；host 由 gui:dev 代启时是 detached 进程，Ctrl+C 只清 vite，host 存活（用 `/runtime-host stop` 管理）。

## 结构

```
src/api/types.ts    version:1 冻结契约手抄（勿跨 package import server 类型）
src/api/client.ts   fetch never-throw + 6 端点封装；409 → resync 信号
src/store.ts        zustand：数据 + nextCursor + connection + activeTab + autoHandoff 本地态
src/usePoll.ts      分档轮询（2s 增量 / 5-10s 全量）；visibilitychange 暂停
src/index.css       主题底座：@theme 亮基底 + .theme-warm-dark / .theme-warm-light + .tone-chip
src/ui/             shadcn 套件（14 件）+ 门面（Button/Badge/Card/Toggle/EmptyState/Term/ShortId/RelTime）
src/pages/          顶栏/侧栏+会话列表/聊天 · 覆盖层（Master / Workstream / Attention / Runtime / Channels / Autonomy / Timeline / RuntimeOverlay）
```

主题测试门禁：`npm run test:gui-theme-contract`（token 值 + 冷灰零残留 + WCAG 自算）；
布局冒烟：`npm run test:gui-zcode-replica`。
