---
title: 异步 Run 卡片端点（GET /v1/runs）
kind: architecture
status: current
updated: 2026-10-22
source_paths:
  - extensions/runtime-host/server.ts
  - extensions/runtime-host/server.ts#case "/v1/runs"
  - extensions/subagent-kill.ts
  - extensions/subagent-kill.ts::listAsyncRunCards
  - extensions/subagent-kill.ts::classifyRunLiveness
  - extensions/recent-calls.ts::classifyLoop
  - extensions/recent-calls.ts::ARGS_DIGEST_MAX_CHARS
  - extensions/_test_runs_endpoint.ts
  - extensions/_probe_runs_endpoint_real.ts
  - gui/src/runsView.ts
  - gui/src/pages/RunsPage.tsx
  - gui/src/api/client.ts
  - gui/src/api/types.ts
  - gui/src/_test_runs_view.ts
---

# 异步 Run 卡片端点（GET /v1/runs）

## Summary

async subagent 的 run 记录（`~/.pi/agent/subagent-runs/*.json`）此前**只能**经工具
`subagent-win{status,list,recent-calls}` 与进程内 TUI 面板看到，daemon 侧零读取面 ⇒ GUI 里
连「现在有几个在跑」都没有。本页记录新增的**只读**端点 `GET /v1/runs`：
它把 run 记录投影成「一行一 run」的卡片，用**三态判活**表达「这个 run 的进程还在不在」，
并显式规定 `unknown` **不得**当「运行中」展示。

三个不可动摇的取舍（本页的存在理由，改动前先读）：

1. **独立端点，不塞 `/v1/snapshot`**。snapshot 实测已 412,084 B，其中 `runs` 段占 81.2%；
   追加 154 份 run 即便只取 min-card 也要 +80 KB（+19.5%），且 `buildRunsSection` 是同步投影，
   154 次 `readFileSync`+`JSON.parse` 会阻塞事件循环。
2. **判活只认 pid，不认 `status`**。`status === "running"` 是「记录还没落终态」，不是「进程还活着」。
   实测 154 份记录里带 `pid` 的**只有 1 份**成常态缺失 ⇒ 绝大多数记录的正确答案是 `unknown`。
3. **响应内不含任何 `now -` 相对量**（`idleMs`/`ageMs` 一概不出）。相对量每拍都变 ⇒ ETag 永不命中；
   年龄由 GUI 用 `lastActivity` 自己算。

## Current Contract

### 请求

```
GET /v1/runs?limit=<1..200，缺省 50>&includeRecentCalls=0|1
```

| 项 | 规则 |
|---|---|
| 鉴权 | 与其余 GET 读投影同档（loopback 只读面；不新增写路径、不新增 token 面） |
| 数据源 | `subagent-kill.ts::DEFAULT_RUNS_DIR`（= `env PI_SUBAGENT_RUNS_DIR` 覆盖，否则 `~/.pi/agent/subagent-runs`） |
| 注入 | `RuntimeHostServerOptions.runsDir?`（测试注入夹具目录；**测试不得读真实目录**） |
| 排序 | `running` 优先 → `startedAt` 降序；`limit` 在**排序之后**截断 |
| 副作用 | **零写盘**：不写 run json、不碰 registry、不 kill；单份坏 json 跳过（never-throw） |
| 方法 | 仅 GET（`POST /v1/runs` → 405） |

### 响应（`version:1` 后只增不改）

```json
{
  "version": 1,
  "asof": "2026-10-22T06:10:00.000Z",
  "count": 154,
  "total": 154,
  "runs": [{
    "id": "run_mvei90jy_lkkf",
    "agent": "general",
    "taskPreview": "…（空白折叠 + 截 40 字符）",
    "status": "failed",
    "liveness": "dead",
    "pid": 1144148,
    "startedAt": "2026-10-19T00:17:22.703Z",
    "lastActivity": "2026-10-19T00:19:19.817Z",
    "usage": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "cost": 0, "turns": 0 },
    "recentCalls": [{ "tool": "bash", "argsDigest": "…", "ts": "…", "turn": 17 }],
    "loopVerdict": "unknown"
  }]
}
```

| 字段 | 规则（**冻结**） |
|---|---|
| `liveness` | `pid` 为整数 ⇒ `isPidAlive(pid) ? "alive" : "dead"`；`pid` 缺失/非法 ⇒ **`"unknown"`**（**永不**从 `status` 猜） |
| `pid` | `number` 或 `null` |
| `status` | 记录里的 `status` 原值（`running\|completed\|failed\|cancelled`；未知值原样透传） |
| `usage` | `result.usage` 的六聚合量；缺失 ⇒ `null`（**运行中恒缺失**，不从别处推断） |
| `lastActivity` | `lastActivity` → `pidRecordedAt` → `startedAt` 回退链 |
| `taskPreview` | 空白压单空格 + 截 40 字符（与 `listAsyncRunSummaries` 同口径） |
| `recentCalls` | **仅** `includeRecentCalls=1` 出现；最近 **3** 条、**newest-first**；`argsDigest` 截 `ARGS_DIGEST_MAX_CHARS`(160) |
| `loopVerdict` | **仅** `includeRecentCalls=1` 出现；`classifyLoop` 三值，**只对 `status==="running"` 计算，终态恒 `"unknown"`** |
| `asof` | 响应时间戳；**不参与 ETag** |
| **不得**出现 | `idleMs` / `ageMs` / 任何 `now -` 相对量 |

### ETag / 304

复刻 `/v1/snapshot` 手法：`sha1Etag(JSON.stringify({...body, asof: undefined}))` + `matchEtag`
（支持逗号列表 / `W/` 弱前缀 / `*`）→ `respondNotModified`。旧客户端不带 `If-None-Match` ⇒ 照常 200 全量。

## 三态判活语义（本页最重要的约定）

| 记录的 `status` | `liveness` | 展示 | ≥「运行中」? |
|---|---|---|---|
| `running` | `alive` | 运行中 | **是** |
| `running` | `dead` | 进程已退出（记录没落终态，进程没了） | 否 |
| `running` | `unknown` | 状态未知（没有 pid 可判） | **否** |
| `completed` / `failed` / `cancelled` | 任意 | 已完成 / 失败 / 已取消 | 否 |

- `unknown` **既不是** alive **也不是** dead：`pid` 缺失是**常态**（实测 153/154），
  把它算成运行中会常态谎报「有任务在跑」，算成失败会常态谎报「任务都挂了」。
- 终态记录的 `liveness === "dead"` 是**正常现象**（进程正常退出），不是「中断」。
- 判据只有一处实现：`gui/src/runsView.ts::deriveRunDisplay`。头部计数走 `runningCount`，
  **不得**用 `runs.filter(r => r.status === "running").length` 代替。
- 服务端不判「运行中」，只给 `status` + `liveness` 两个正交事实；「算不算运行中」是展示层决定。

## 实测读数（2026-10-22，分母 = 真实 `~/.pi/agent/subagent-runs/` 154 份 run json）

### 数据分布（`?limit=154&includeRecentCalls=1` 一次取样）

| 指标 | 读数 |
|---|---|
| `total` / `count` | 154 / 154 |
| `liveness` 分布 | `unknown` **153** / `dead` **1** / `alive` 0 |
| `status` 分布 | completed 123 / failed 19 / cancelled 12（**0 条 running**） |
| 带 `pid` | **1/154**（唯一的 `dead`：`run_mvei90jy_lkkf`，pid 1144148） |
| 有 `usage` | 154/154（`result.usage` 恒在） |
| `recentCalls` 非空 | 141/154（另有 12 条 `recentCalls: []`，1 条无该字段） |

⇒ `unknown` 占比 **99.4%**。**UI 若不能显示「状态未知」，这一页对真实数据就是错的。**

### 活体样本：运行中那一行长什么样（同一分母，2026-10-22 06:34–06:35 两个探针）

上表是**无活 run 时刻**的快照（154/154 无 `running`）。为免又出现「运行中字段面靠推断」，
另派两个 `bash sleep` 探针（`run_mvins99q_6nxe` / `run_mviow5q8_ogqq`）在存活期直接读端点：

```json
{"id":"run_mviow5q8_ogqq","status":"running","liveness":"alive","pid":233300,
 "startedAt":"2026-10-21T22:34:24.896Z","lastActivity":"2026-10-21T22:34:34.935Z",
 "usage":null,
 "recentCalls":[{"tool":"bash","argsDigest":"{\"command\":\"sleep 240\",\"timeout\":300}","ts":"2026-10-21T22:34:29.811Z","turn":1}],
 "loopVerdict":"ok"}
```

三个只有活体采样能给出的事实（**别再从代码推断**）：

1. **`usage` 在运行中恒为 `null`** —— run json 此时**没有 `result`**（`'usage' in rec === false`，3/3 采样）。
   卡片上 running 行的用量只能是「—」，这是数据面事实，不是展示选择。
2. **`lastActivity` 由脉搏推进**（约 20s 一跳：22:34:34 → 22:35:09），因此 **ETag 会随脉搏变化**
   （35s 两次采样 `etagChanged=true`）——「运行中稳定 304」不成立，属预期。
3. **`recentCalls` 不是实时增量**：睡眠期间恒 1 条，增量只在工具**返回后**写盘 ⇒ 端点只能承诺
   「最近一次已落地的调用」，任何「实时进度」承诺都不成立（档 B/C 同样不成立）。


### 体积与延迟（同一 server 实例，每项 7 次连测）

| 查询 | 响应体 | min / median / P95 / max (ms) | 判据 |
|---|---|---|---|
| `?limit=154` | **56,316 B（55.0 KB）** | 21.25 / 22.73 / **36.14** / 36.14 | ≤120 KB ✅ / P95 <50 ms ✅ |
| `?limit=154&includeRecentCalls=1` | **154,595 B（151.0 KB）** | 23.08 / 23.95 / **34.95** / 34.95 | ≤420 KB ✅ / P95 <50 ms ✅ |

条件请求：`200 etag="ebff96f2247ed7ef8387da4928837c1f5943ecdb"` → 带该值 `If-None-Match`
⇒ **304，body 0 字节**。`includeRecentCalls=1` 的 ETag 为 `"6606cf11…"`（**与 min-card 不同**：
不同查询的响应体不同，客户端 ETag cache key 必须带 query，否则会串数据）。

成本结构：判活 `isPidAlive` 单次约 0.12 ms，全量 1 次；开销几乎全在 154 次
`readFileSync` + `JSON.parse`（`listAsyncRunSummaries(dir, 10000)` 实测 median 26.36 ms，
与本端点 min-card P95 36 ms 同量级 ⇒ 端点没有引入额外放大）。

## 不得用作「运行中」的证据（清单）

以下都不是「这个 run 正在跑」的证明，改动展示逻辑前逐条核对：

- `status === "running"` —— 只说明记录没落终态（进程可能已死，终态还没写）。
- `lastActivity` 很新 —— 脉搏由写盘节流推进（≤1 次/5s），陈旧记录也可能刚被写过。
- `liveness === "unknown"` —— 恰恰是**不知道**，不是「大概在跑」。
- `loopVerdict !== "ok"` —— `classifyLoop` 只看最近 3 次调用与 turnClock，不是进度证据；
  终态恒 `unknown`，那是「不算」，不是「卡住」。
- `recentCalls` 有内容 —— 只在工具**返回后**写入，睡眠/长工具期间恒 1 条且不增量。
- `/v1/snapshot.runs` —— 那是 **tab run** 的 journal 投影，与 async subagent run 无关。

## 实现落点

| 面 | 文件 | 说明 |
|---|---|---|
| 数据层 | `extensions/subagent-kill.ts::listAsyncRunCards` / `classifyRunLiveness` | 与 `listAsyncRunSummaries` **同文件不同投影**；后者的返回形状（`RunSummary`，pidAlive 二态）**未改**——`subagent-win{status,list}` 与 async-panel 都在消费 |
| 端点 | `extensions/runtime-host/server.ts` `case "/v1/runs"` + `RuntimeHostServerOptions.runsDir?` | 与 `/v1/snapshot` 同款 ETag/304 |
| GUI 纯函数 | `gui/src/runsView.ts`（`deriveRunDisplay`/`runningCount`/`livenessTally`/`formatUsage`/`loopBadge`） | 判活唯一入口，可 node 直载测试 |
| GUI 视图 | `gui/src/pages/RunsPage.tsx`（RuntimeOverlay `SECTIONS` 项「运行」） | 5s 轮询；失败保留旧数据；`running` 组只放 `countsAsRunning` 的记录，其余进「最近记录」 |
| 契约类型 | `gui/src/api/types.ts`（`RunCard`/`RunLiveness`/`AsyncRunStatus`/`RunsResponse`） | `AsyncRunStatus` 与 tab run 的 `RunStatus`（七态）**故意区分命名** |
| 测试 | `extensions/_test_runs_endpoint.ts`（22 组）、`gui/src/_test_runs_view.ts`（10 组） | 夹具照真实字段集；含反向断言「unknown 不算运行中」 |

**命名陷阱（本仓已踩）**：`gui/src/api/types.ts` 已有 `RunStatus`（tab run 的 journal 投影七态
`created/dispatched/running/waiting/completed/failed/cancelled/orphaned`）。async run 的状态是另一套四态
⇒ 新类型叫 `AsyncRunStatus`，不要复用旧名（`tsc` 会以 duplicate identifier 挡住，但混读更难查）。

## Evidence

- `extensions/_test_runs_endpoint.ts` — 22 组断言：三态各命中、`limit` 在排序后截断、
  `includeRecentCalls` 字段存在性、ETag/304、POST→405、零写盘（目录树哈希）、坏 json 跳过。
- `gui/src/_test_runs_view.ts` — 10 组断言，含反向断言「`running`+`unknown` ⇒ `countsAsRunning===false`
  且 `label !== "运行中"`」与「3 条 `status=running` 但只有 1 条真活 ⇒ `runningCount===1`」。
- `extensions/_probe_runs_endpoint_real.ts` — 对真实 154 份记录取体积/延迟/三态分布/304 的探针。
- 变异验证（两项均字节级还原，`sha256` 前后一致）：
  - 变异 `server.ts` 去掉 `limit` 应用 ⇒ `test:runs-endpoint` 的 `T6f HTTP ?limit=2 → count=2`
    红（`actual: 4, expected: 2`）；还原后 `b88af240…ee290a0c` 一致。
  - 变异 `runsView.ts` 的 `unknown` 分支（`countsAsRunning: true` 且 label「运行中」）⇒
    `test:gui-runs-view` 的 `R1c` 红（`actual: '运行中', expected: '状态未知'`；
    `countsAsRunning` 版 `actual: true, expected: false`）；还原后 `dbd4ef7c…3ee1f0ae5` 一致。

## Links Out

- [[异步 Run 控制面（list / kill）]] —— run json 字段面、kill 语义、判活基线、观测面现状。
- [[Runtime Daemon 架构]] —— `HTTP 端点全量清单`（本端点是该表的一行）。
- [[工具调用可观测与循环判定]] —— `classifyLoop` / `recentCalls` 的口径来源。
- [[GUI 工作台 UI（token / 组件 / 导航）]] —— `RuntimeOverlay` section 契约与对比度门。

## Open Questions

- 终态记录的 `pid`/`lastActivity` 会被落盘瘦身抹掉（现仅 1/154 保留）⇒ 终态卡片目前只能显示
  「已完成/失败/已取消」，无法回答「它跑了多久」。补齐需要改落盘写点，不在本端点范围内。
- 运行中记录的 `usage` 恒缺（`result` 未生成）⇒ 卡片显示「—」。要有实时用量需要逐事件回写，代价见
  [[异步 Run 控制面（list / kill）]] 的 (c) 路径。
- `includeRecentCalls=1` 的体积（151 KB）在 154 条时安全，但记录数线性增长；超过 ~400 条需重新评估
  是否分页（当前 `limit` 已能截断，但 UI 侧默认 50）。
