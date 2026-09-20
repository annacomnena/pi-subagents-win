# gui/ — Browser Runtime Workbench v0（G5）

vite + react + ts + tailwind v4 + zustand 的浏览器工作台，经 **vite dev proxy** 同源访问
runtime-host（`/v1/*` 转发，server 零改动：无 CORS、不托管 dist）。

## ⚠️ import 惯例分叉（勿互相「修正」）

**gui/ 内所有 import 不带 `.ts` / `.tsx` 扩展名**（vite/esbuild bundler resolution 硬要求）。
这与仓库根 `extensions/` 的 strip-types「强制带 `.ts` 扩展名」惯例**相反**——两边各自成立，
不要把 gui/ 的 import 改成带扩展名，也不要把根代码改成不带。

## 启动

```bash
npm run gui:dev    # 根目录：探活 host（不活则代启）→ 起 vite → 打印 URL（不开浏览器）
npm run gui:build  # tsc --noEmit && vite build
```

- 端口发现：`GUI_HOST_TARGET` env > `GUI_HOST_PORT` env > `host.json`（`PI_RUNTIME_DIR` 感知）> 兜底 `http://127.0.0.1:4317`。
- **vite 启动时只读一次 host.json**：host 重启换了端口需重启 vite（gui:dev 会自动代启新 host，实际影响窗口极小）。
- `/runtime-host start` 行为零变化（不会自动开浏览器）；host 由 gui:dev 代启时是 detached 进程，Ctrl+C 只清 vite，host 存活（用 `/runtime-host stop` 管理）。

## 结构

```
src/api/types.ts    version:1 冻结契约手抄（勿跨 package import server 类型）
src/api/client.ts   fetch never-throw + 6 端点封装；409 → resync 信号
src/store.ts        zustand：数据 + nextCursor + connection + activeTab + autoHandoff 本地态
src/usePoll.ts      分档轮询（2s 增量 / 5-10s 全量）；visibilitychange 暂停
src/ui/             手写小组件（≤8 个，无 shadcn/radix）
src/pages/          Master / Workstream / Attention / Timeline / Runtime
```
