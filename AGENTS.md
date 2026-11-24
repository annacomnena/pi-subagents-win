# AGENTS.md — subagent-win 仓库工作约定

> 本文件是**给 agent（含 local master / subagent / tab 会话）的强制约束**。
> 每条规则都对应一次真实事故；不写「理论应该」，只写「已经踩过、必须避免」的坑。

---

## 0. 第一原则：证据优先于记忆

- **任何"已经好了/已经修了/应该没问题"的判断，必须有本次实测读数**（命令 + 原始输出 + 时间戳）。
- 交接陈述、上一位 agent 的结论、计划文档里的描述 —— **都是线索，不是证据**。要用就自己复核。
- **声明的作用域不得宽于证明的作用域**。抽样通过 ≠ 全量通过；`strings` 命中 ≠ 二进制属性；注册表有这一行 ≠ 功能已实现。

---

## 1. 配置文件：**禁止整文件重写**（R-1，2026-10-17 事故）

### 事故
`config.json` 一次**整文件重写**（模型路由切换）丢掉了顶层 `autonomy` 键 ⇒ 整条 autonomy 链
**静默死亡 29 小时**（`frontier.json` / `wake-gate.json` / `audit.jsonl` 同秒停更于 2026-10-16 10:38:07），
无人发现。备份考古：`bak-glmreview`(10:37) 还有 `autonomy`，`bak-luna-weak`(10:43) 已丢失。

### 规则
1. **改 `config.json` 必须 read-modify-write 单键**，不得用 `write`/`>` 整文件覆盖。
   - 正确：读 JSON → 只改目标键 → 写回（保留其余全部顶层键）
   - 禁止：手写完整 JSON 内容覆盖
2. **改配置前先备份**：`cp config.json config.json.bak-<用途>-<ts>`。
3. **能用斜杠命令就别手改文件**。已有安全入口：
   - `/autonomy on|off|status|kill|clear` —— 走 `setAutonomyEnabled()`，read-modify-write，不动其他键
   - 模型路由类改动若没有命令入口，**优先补一个命令**而不是教人（或 agent）手改 JSON。
4. **改完必须核对顶层键数量与关键键存在性**：
   ```bash
   python -c "import json;d=json.load(open('config.json'));print(len(d),list(d))"
   ```
   与改前对比，少一个键就是事故。

---

## 2. 静默失效不可接受（R-2，同上事故）

### 事故
`extensions/runtime/autonomy/gate.ts:73` 的 `enabled !== true ⇒ 完全旁路（零 IO/零审计/零写盘）`
是**刻意的默认关闭设计**，但代价是：**开启后被人误关，也完全无声**。

### 规则
1. **任何"开关关掉就彻底不工作"的功能，必须有独立于该开关的存活信号**（心跳/计数器/最近活动时间）。
   - 参考实现：`writeAutonomyHeartbeat()`（`extensions/runtime/autonomy/collect.ts`）在 wake tick
     **开头无条件**写 `state/autonomy/heartbeat.json`，即使后续被 gate 旁路也写。
2. **状态展示必须给"年龄"，不能只给"绝对时间"**。
   - 反例（旧 `/autonomy status`）：`frontier: asof=2026-10-16T02:38:07` —— 读的人看不出陈旧 29 小时。
   - 正例：`asof=... (29.0h 前) ⚠️STALE(>5min)` + 诊断行。
3. **必须能区分三种状态**：① 进程/tick 死 ② 功能被关 ③ 正常工作。
   - 参考实现：`frontierFreshness()` 的 `suspectedDisabled`（心跳新鲜但快照陈旧 ⇒ 最可能是被关）。

---

## 3. 缓存 / 派生数据：作者怎么定义，就按怎么用（R-3）

- `collect.ts:172` 注释明写 frontier 是 **「C4 派生缓存」**。**派生缓存可以被读作"当前最佳近似"，
  但不能被当成权威状态** —— 读它之前先看 `asof` 年龄。
- 任何派生缓存必须有**新鲜度判定 + 显式 STALE 标记**（见 R-2.2）。
- **多写者共写单文件 = 最后写入者覆盖**。已知未修：1 global + 3 local master 各写同一
  `frontier.json`。读的时候要意识到"你看到的是某一次某个进程的视角"，里面可能有幽灵引用
  （如已删除的 tab id）。结构性修复（per-project 分文件）待排期。

---

## 4. 审查纪律：**实现与判定不得同一主体**

1. **L4 代码审查必须另起进程**（`subagent-win` 派 `code-reviewer`/`general`），交 `git diff`。
2. **变异验证必须变异"真实接线"，不能只变异函数体**。
   - 事故：测试**直接调** `broadcastWechatMessage`，绕开 `pi.on("message_end")` 注册线；
     变异函数体 ⇒ 5 项实红（假的）；变异**接线** ⇒ 23 组全绿（真缺陷）。
   - 规则：断言必须经过**真实入口**（注册/事件派发/CLI 解析），否则该测试不证明接线正确。
3. **变异的判据是"命中预期断言"**，不是"任意错误退出"。
4. **变异后必须字节级还原**并报 `sha256` 前后值。

---

## 5. 测试夹具必须贴近真实形状（R-4）

- 事故：夹具 `round()` 造的 assistant 消息**不带 `timestamp`/`responseId`**，导致消息级幂等键
  退化为「正文哈希」⇒ 两轮同正文被误判重复 ⇒ T3 红。
- 规则：**夹具字段必须与真实运行时消息一致**。真实字段约束要**实测统计**（本仓实测：902 文件 /
  68718 条 assistant；`timestamp` 100% / `responseId` 96.74% / `message.id` **0%**）。
- **不要用"必然带某字段"做设计前提** —— 要么实测，要么对缺失字段显式支持。

---

## 6. 幂等与重复：明确取舍方向（R-5）

- 异步交付类（广播/通知/唤醒）在「**可能重发**」与「**可能漏发**」之间，**本仓选择：宁可重发，不可漏发**。
  - 理由：漏发是静默的（用户不知道），重发是可见的（用户能忽略）。
- 该取舍必须**在代码注释与报告中显式登记**，不得当成"没有这个问题"。
- **已知边界**（勿声称已解决）：WeakMap nonce 使「反序列化成新对象」的同一消息被视为新消息 ⇒ 会重发；
  无真实 id 的克隆对象跨进程不幂等。

---

## 7. push / 提交 / 环境

- **push 走 443**：本机 DNS 把 `github.com` 解析到非 GitHub 地址（`28.0.0.71`），22 端口被封。
  仓库本地已配 `url."ssh://git@ssh.github.com:443/".insteadOf="git@github.com:"`。**不要改全局 SSH 配置。**
- **agent 不得自行 push**，除非用户在当次会话明确授权。
- 提交信息必须含：根因、改了什么、怎么验证、**未闭合项**。

### 7a. 生产 GUI 跑 `gui/dist`（**不入库**）—— 改源码不 build = 没生效（2026-11-10）

**事故**：排查 GUI 的 400 时，一直以为改 `gui/src/**` 就会生效；实测 `gui/dist/assets/*.js`
的 mtime 停在 **11-05 01:03**，而 host（pid 25588）自签发那刻起读的就是它 ⇒ 改了一个多月前的代码。

**事实**：
- 生产路径 = daemon 自托管 `gui/dist`（`gui-autostart.ts` 头注释：生产禁 vite）
- `gui/dist/` 被 `.gitignore:15` 忽略 ⇒ **`git add gui/dist` 会报 "paths are ignored"，那不是错误，是设计**
- 只有 `npm run gui:dev`（独立 dev profile）走 vite 实时编译

**规则**：
1. 改 `gui/src/**` 后**必须** `npm run gui:build`，否则 host 仍取旧 bundle。
2. **验证拿新 bundle（三件事都要）**：
   ```bash
   ls -la gui/dist/assets/*.js                 # mtime 必须是本次构建
   curl -s 127.0.0.1:<hostPort>/ | grep -o 'index-[A-Za-z0-9_-]*\.js'   # index.html 指向的名字
   curl -s -o /dev/null -w '%{http_code}' 127.0.0.1:<hostPort>/assets/<该名字>.js   # 期望 200
   ```
   `hostPort` 从 `~/.pi/agent/runtime/host.json` 的 `port` 读，**不要写死**。
3. 新 bundle 里必须能 grep 到新逻辑（如 `grep -c "<新文案关键词>" gui/dist/assets/<新名字>.js`）
   —— 否则「文件重建了但内容没进去」也会骗人。
4. **不要**把 `dist` 产物入库（已忽略，强加会污染仓库）；重新 clone / 换机器**必须自行 build**。

### R-7b 同一 provider 连续失败必须冷却 ≥30s（2026-10-17 实测）

**事故**：主会话在 14:56→14:58→14:59→15:00 连续重派 4 个 subagent，四个全 `Connection error`；
又把此误归因为「代理不稳定」或「provider 限流」。

**实测根因**（对照实验，两条路同秒同时挂）：
```
短连接 6 路并发 × 3 轮：直连 18/18 ✅  走代理 18/18 ✅   ⇒ 并发本身没问题
长连接 60s 每 2s 一请求 × 2 路：
  直连：成功 4 / 失败 26（从第 5 次起连续 000）
  代理：成功 4 / 失败 26（从第 5 次起连续 000）  ← 同秒同时挂 ⇒ 不是代理
等 45s 后单发 ⇒ 恢复 401 ✅                      ← 临时封禁，会自动恢复
响应头：Server: cloudflare / cf-cache-status: DYNAMIC
```
⇒ **是 Cloudflare 对「高频短连接」的临时封禁**（~4 次后封约 45–60s），**与代理无关**。

**规则**：
1. **同一个 provider** 连续失败后，**必须等 ≥30 秒**再重派；**禁止连着重派**。
2. **跨 provider 不算冷却**（不同上游不同 CDN）—— 但若它们共用同一 CDN/代理出口，仍应降频。
3. 失败重派前先单发一次**探针**（一次轻请求）确认已恢复，再派正式任务。
4. **不要把 `Connection error` / `fetch failed` / `terminated` 一律归因为「代理」或「配额」** —— 先做对照实验（直连 vs 代理、并发 vs 串行），再下结论。
5. 改配置不是首选（用户可能因 codex 等依赖代理而**不能关代理**）⇒ **优先降频/冷却，而不是改网络配置**。

---

## 8. 长跑任务：增量落盘 + 切片

1. 单片 ≤ ~15 轮工具调用；超了就切。
2. **>3 步的任务必须写明每子步落盘位置**；落的是**结论/证据**，不只是产物。
3. **预供锚点**（`file:line`）+ 禁止全仓巡查 —— 勘察密集阶段最容易超时/被杀。
4. 失败 run 的部分成果**核验后可复用**；但**复用前先验**（文件在不在、测试过不过）。

---

## 9. 用户交互边界（硬）

- **不做会抢鼠标/键盘、用户不在场时弹窗、或"关窗又弹起"的自动化** —— 遇到**先停手并问**。
- GUI 测试只在**用户明确给出的无人用机窗口**内跑。
- 用户输入画像（如"无人用机"）是**时间敏感的授权**，过期需重新确认。

---

## 9b. 归因纪律：证据的作用域与时间窗（R-11 / R-12，2026-10-18 两次事故）

### R-11 断言「异常」必须给分母，单位数样本不算证据

**事故**：我据单个 state 文件的 `pid=null`，断定「pid 缺失是异常，应判死并实现」。
实测 **28 个 state 只有 2 个带 pid（93% 缺失）** —— 缺失才是常态。
按该任务书实现会把 **26 个正常长任务 tab 误报成 BLOCKED_USER**。
同时我称「幽灵 run 压住项目级判断」，实测它**不在监管账本**，派生 `NOT_MONITORED`，零影响。

**规则**：
1. 写「这是异常 / 这是缺陷」类断言前，**必须做分母统计**（`grep -c` / 遍历目录），
   并在任务书里附分布（如「2/28」）。
2. **单样本不得用于断言「异常」**。单样本只能提出假设。
3. 派生判据的断言前，**先确认该对象真的在该判据的输入集合里**（上例：不在监管账本 ⇒
   根本进不了六态机的 ACTIVE 分支）。

### R-12 事后探测不能证否历史瞬时故障

**事故**：用户说「刚才那会是瞬时 connection error」，我用事后的 `curl` 6/6 全通，
得出「不是网络问题」。**时间窗错位**——事后探测只证明「此刻正常」。

**规则**：
1. 用户报告的**历史瞬时故障**，不能用**事后探测**否定；只能补充「当前状态」证据。
2. 归因前先对齐时间窗：故障发生时刻，我有什么同时刻的证据？（会话 JSONL / killAudit /
   audit.jsonl 时间戳）。没有就如实说「无同时刻证据」。
3. 跨时间点的相关不等于因果；**「此刻通」与「刚才断过」可以同时为真**。

---

## 9c. 系统资源纪律：全盘搜索必须带超时（R-13，2026-10-18 事故）

### 事故：一条 `find` 挂了 2.7 小时，撑爆内存，间接造成 pi 包反复损坏

**我做了什么**：为找 `cli.js`，在**根目录**跑：
```bash
find / -maxdepth 8 -name cli.js -path *pi-coding-agent/dist*
```
**没加 `timeout`**，它从 22:10 挂到 00:40（**2.7 小时**）。

**后果链**：
```
扫全盘 → 打开 696 万个文件句柄（实测 HandleCount=6,984,230）
  ↓
内核非分页池 3282MB（正常 <1000）+ 分页池 3978MB（正常 <800）
  ↓
物理内存 99.4%（31.1GB 总量，可用仅 0.2GB）
  ↓
★ 内存/句柄枯竭下，文件写操作随机失败（EBUSY / 半途失败）
  ↓
★ pi 包「反复部分损坏」4 次 —— dist 消失 / 子包丢失 / pi-tui/dist 缺失
```

**归因教训**：我先前把损坏归因为「npm EBUSY」，**只对了一半** —— EBUSY 是现象，
**内存枯竭才是根因**。而内存枯竭是**我自己那条 find** 造成的。

### 规则

1. **禁止在 `/`、`C:/`、`G:/` 等盘根跑无超时的 `find` / `grep -r` / `du`**。
   必须带超时且限定目录：
   ```bash
   timeout 30 find <具体目录> -maxdepth 4 -name 'x'   # 正确
   timeout 30 find / -maxdepth 8 -name 'x'            # 禁止
   ```
2. **长命令一律 `timeout N`**（本仓 bash 工具支持 `timeout` 参数，优先用它）。
3. **后台进程要有归属**：任何 >1 分钟的命令，必须知道它在哪、怎么停。
4. **诊断「文件写失败」前先查资源**：
   ```powershell
   Get-CimInstance Win32_OperatingSystem | Select TotalVisibleMemorySize,FreePhysicalMemory
   Get-Process | Sort HandleCount -Desc | Select -First 5 Name,Id,HandleCount
   ```
   **句柄 TOP1 远超 10 万 ⇒ 先杀掉它再看文件问题。**
5. **`pi --version` 不足以判断包健康**（见 R-14）。

### R-14 pi 包健康检查：`--version` 会骗人

**事故**：第 4 次损坏时 `pi --version` 正常报 `0.99.1`，但 `pi-tui/dist/index.js` 缺失 ——
只有实际执行 subagent 时才炸 `ERR_MODULE_NOT_FOUND`。

**规则**：健康检查必须验 **import 图**，不是版本号：
```bash
node plans/pi-corruption-diagnostics/health.mjs <pi包根目录>
# 期望：HEALTHY_IMPORT_GRAPH + IMPORT_OK（TUI + main 两个）+ earendilPackages=7
```

### 环境事实（别再搞错）

- `C:\nvm4w\nodejs` 是 **Junction** → `C:\Users\Annacomnena\AppData\Local\nvm\v22.19.0`
  ⇒ 「两处安装路径」**是同一实体**，改一即改二。
- 独立安装在 `C:/pi-standalone/`（完好，已用于恢复 4 次）。
- `subagent-win/node_modules/@earendil-works/` 下**已是真实副本**（原来的两个指向全局的软链接
  已于 2026-10-18 删除）。

---

## 10. 已知未闭合项（勿当成已完成）

| 项 | 状态 |
|---|---|
| `frontier.json` 多写者共写、无 per-project 隔离 | 未修（结构性，需排期） |
| autonomy 心跳**不自愈**（只让"被关"可见，不会自动重启） | 设计如此；恢复需 `/autonomy on` |
| 广播：进程在 `agent_settled` 前被杀 ⇒ 该条可能漏推 | 未闭合 |
| 广播：反序列化克隆 ⇒ 同一条可能重发 | 已知取舍（见 R-5） |
| `config.json` 整文件重写的**机制性防护**（自动校验顶层键） | 未实现（目前靠本文件 R-1 人工遵守） |
| **`tab-status` 从不读 `heartbeatAt` 判死** | **2026-11-09 已修**（`b618298`）：`tabLivenessVerdict()` 三层判据（pid 探活 ∧ 心跳超龄，或 pid 复用），`phase="stale"` **刻意不进归档集合**（`archiveStaleTabRuns` 零改动）。实测 >7d 非终态账本 **340 个**，`deliverable` 从 **340/340 → 0**；列表全量 **555 项 spawn=0**；`tabNeedsIdleWake` 对死账本返回 `needsWake:false`。**`stale` 是只读侧判定，账本原地保留**（搬走会破坏 `steer` 可见性） |
| **tab 身份在会话 resume 后丢失**（`PI_TAB_RUN_ID` 不重放） | 未修（需建 `sessionPath → runId` 索引，结构性改动）。后果：workflow-tab 形态的 local master 被 resume 后 `tab-report` 自助回报通道对该进程永久失效，而账本仍显示 `phase=working` |
| **交付期限 `DELIVERY_DEADLINE_MS=60s` 与真实 ACK 时延量级错配** | **2026-11-24 已修（P0-a 期限分级）**。旧症状（2026-11-05 实测，分母 442 事件）：328 个发过 incident（**74%**），其中 **14 个在 incident 之后仍收到 consumed ACK** ⇒ 同事件两个矛盾终态；单例 `run_mw3flr49_7d1z` deadline 19:04:49 判死、ACK 19:11:25（晚 6'36"）。**分母复核（2026-11-24，本机 `runtime/delivery` 141 事件 / 140 个有 consumed ACK）**：ACK−terminalAt `p50=0.31s / p90=323.8s / p95=913.8s / p99=2836.9s / max=3005.8s`；按 60s 判死 ⇒ **40/140 = 28.6%** 的**已送达**事件被判死。**修法**：拆成两条独立期限 —— `DELIVERY_DEADLINE_MS=60s` **降级为观测**（过它只落一条 `B-slow-delivery` trace 边沿触发，不判死、不发 incident、不终止补投），新增 `DELIVERY_FAIL_DEADLINE_MS=600s` 才是判死线（`failDeadlineOf()`，基准锚 `terminalAt` 而非 `observedAt` ⇒ 晚发现不隐式展期；存量事件无该字段时按 `terminalAt+600s` 现算）。**代价显式登记（R-23）**：真漏发的可见时间由 ≤75s 推到 ≤600s+一 tick —— 咨询 §6.5 的「failed_delivery ≤75s 可见」行**已被本改动取代**，`_test_delivery_host_contract.ts` H3-P2② 同步改成「60s 不判死 / 600s 判死」两半都验。理由：75s 并不能「发现」漏发（它只在 ACK 到达前把一切判死），28.6% 误判是确定发生的噪声。**教训（R-26）**：一条判据不得兼任「观测」与「判死」两件事（R-20 姊妹）；参数与真实时延量级错配时，先测分母分布再定阈值 |
| `state/autonomy/non-owner-ticks/` 无 GC（每 sessionId 一文件） | **2026-11-09 已修**（`1ff21a1`）：`gcNonOwnerTicks()` 按年龄（30 天）淘汰，挂在 wake tick 的维护块。判据是**年龄不是文件数**（文件名是 sha256(sid) ⇒ 同会话天然一份），写死数量会删掉「刚挂起还会回来的会话」。真机实测 22 文件 / removed=0 / keptOldestDays=4.7。**未接 `/autonomy status` 展示**（`keptOldestDays` 已备好） |
| **mailbox `claimed` 卡死：`consumed` ACK 写了但 `ackLetter` 永不执行** | **2026-11-10 已修**（`1a6d760` + `c526f94`）。根因：消费入口只枚举 `pending`（`listLetters(recipient,"pending")`），而 C-3 收尾在循环体内 ⇒ claimed 的信永不进列表 ⇒ 永不 ack ⇒ 每封最多 6 次退避重投后永停（实测 6 封）。修法：`sweepClaimedLetters()` 接在 pending 枚举**之前**，只 ack 有 `consumed` ACK 的（无 ACK 不碰，守 R-5）。真机 `swept=6`，8→0。**性能：readdirSync 从 30 次降到 1 次（95ms→0.8ms）**。**未接 `/autonomy status` 展示**；**无 ACK 的 claimed 信仍会停**（下一项） |
| **`releaseClaimed` 循环的真实周期（勿再写「高频来回」）** | **2026-11-10 实测（分母 6 封全量）**：每封 attempts 恒 **6**，gaps 实测 `10/20/30/50/80s`。节流点是 **D-1 退避门**（`mailbox-consumer.ts:284-300` `mailboxRetryGate`）：`MAILBOX_RETRY_MAX_RETRIES=5`（首投+5 重投=6）到顶 ⇒ `exhausted` / incident；`MAILBOX_RETRY_BACKOFF_MS=[5s,10s,20s,40s,80s]`（±20% 抖动，`mailboxRetryGate:297`）与 10s 消费 tick（`:702`）**叠加** ⇒ 观察值 `10/20/30/50/80`。**注意：不是单纯的「被 tick 量化」**——纯 ceil 会给出 `10/10/20/40/80`，给不出 30 和 50；30 与 50 来自「抖动的上沿 + 落后一个 tick」的合成（`base=20s` 抖到 24s ⇒ 跨两次 tick ⇒ 30s；`base=40s` 抖到 48s ⇒ 跨一次 ⇒ 50s）。本机 6 封实测全部落在各 base 的「可观察范围」（5s→4~15 / 10s→8~21 / 20s→16~33 / 40s→32~57 / 80s→64~105）。**不是「每 tick 高频来回」**（那时 attempts 应该几十上百）。全程约 190s 到顶。**措辞错了会误导下一个修的人** |
| **outbox-bridge 的 `unconfirmed ⇒ confirmInjection` 死锁** | **2026-11-10 新发现（未修）**。`0a9a85cc` 实测：目标会话活着、attempt=`unconfirmed`、injected 收据写成功，但正文**没进会话**（GreenCAD JSONL `grep 0a9a85cc`=0）⇒ `consumed` ACK 永不产生 ⇒ outbox 永停 pending，每次重投撞同一堵墙。机制：`confirmInjection` 写出 injected 收据 ⇒ `claimInjection` 恒返 `injected-already` ⇒ strict 只记 received、**永不写 delivered**。**触及 2026-11-02 的防双投修复，需裁定后才能改**。附：PI 层 `sendUserMessage` 在「无 turn 可附着」时 reject，但 wrapper 不 return Promise ⇒ 注入层只看到 `undefined`（见 `injection-gate.ts:125-145` 注释）；注入层**没有**起 turn 的能力（`grep resumeSession|startTurn` = 0） |
| **B 类：B 补投地址发成 `pi://tab_xxx`，bridge 永不匹配** | **2026-11-10 已修**（`0d73702`）。根因：tab 会话的 `links.sessionId` 是 **tabRunId**，真 UUID 在 `ownerSessionId`（`index.ts:4534-4536` 双身份），而 `resolveDispatcherFromLinks` 只读 `sessionId` ⇒ 补投 `to=pi://tab_xxx`，而 outbox-bridge filter 只认 `pi://<自己的真 sessionId>`（`:288/350`，读 `ctx.sessionManager.sessionId`）⇒ **永不匹配、永停 pending、`events=0/receipt=0` 零痕迹**。分母：1197 条 async link 里 **565（47.2%）** 是 tab 形态。修法：resolver 仅对 `tab_` 前缀优先读 `ownerSessionId`（非 tab 逐字节不变；无 owner ⇒ **fail closed 返回 undefined**）；不可达 ⇒ **不写 outbox、返回 `failed`**（有界重试后 exhausted+incident，不扩 `AttemptStatus` 词表）；**存量 migration** = 幂等命中时就地修正 `to`/`sessionId`（id/dedupeKey 不变、终态不碰）。真机 7+3 条迁移后 `to=tab_*` 归零。**未闭合**：① host pid 25588 启动于 11-09，**代码改动尚未生效**（R-18）⇒ 重启前每条新增仍需手工修 ② 565 条 tab link 里 **471 条无 `ownerSessionId`** ⇒ 补投转 `failed`+incident（不静默但消息仍到不了，无 UUID 可解） ③ **A 通道 `async-result-watcher.ts:163-175` 同样只读 `sessionId`** 未改（它不写 outbox，地址不参与送达） |
| trace-fusion 融入 adaptive 的**门槛口径未定义** | 未落地。「连续无返修 run」按连续口径现为 0（最新两个 run 是 cancelled/abandoned，且与他仓），按累计口径为 5。建议改用「最近 N 次 qualified 成功率」并把 cancelled/abandoned 排除出分母（见 `plans/20261105_tracefusion_adaptive_gate_metric.md`），**待 gen14 裁定** |
| trace-fusion **融合者**在所有 UI 面不可见（不是 tab、曾被写进孤岛账本目录） | **2026-11-04 已修账本落点**（见 R-17）；融合者仍是无头子进程，只经 `subagent-runs/run_fuse*.json` + 完成通知呈现，**不会**作为 tab 出现（设计约束） |
| **回报通道三位黑洞（Item 66）** | **2026-11-24 修了第 3 层（P0）**，第 1/2 层**未修**。已修：`markReportSeen` 移到 recipient 判定之后 + 门之后、解析失败落 `.unroutable`（可重试）+ 指数退避（5s→5min 封顶、**无次数上限**）、`snapshotExisting` 只把有 `.notified` 的算已处理、`already-injected` 收工。**未修的三条**：① `tab-report` 对非 tab 进程硬拒绝（`tab-runs-runtime.ts` 无 fallback）② `recipientSessionIdFor` 不认 `agent://master_*`（**⇒ Item 66 那份 `report_mwucgcad_r1a0` 修后仍送不到 global，只是从「静默」变成「可见 + 无限重试」**；数据源 `runtime/registry/attachments/agent___master_*.json` 有 attachment 可用）③ `.unroutable` **零消费者**（无 `/autonomy status` 行、无 GC，只能人工 `ls` —— R-17 原样） |
| **`.notified` 的语义是 claim 不是 delivered** | **2026-11-24 登记（未修）**。写序是 `markSeen → claimReportNotified(.notified) → send → postInject(delivered 收据)` ⇒ claim 成功但 send 失败（异步 reject 不可见，`pi.sendUserMessage` wrapper 不 return 底层 Promise）时，重启后该回报被 `snapshotExisting` 当已处理、不再重投。要修需走 `injectFollowUpQuietly(strict)` ⇒ 会把**所有**通知降级 unconfirmed（仓库级裁定，未做） |
| **回报通道 `selfDisabled` 后整条静默停摆** | **2026-11-24 登记（未修）**。`report.ts` 的 send **同步抛**一次 ⇒ 置 `selfDisabled` ⇒ 本进程每 tick 直接 `return false`，**无日志/无标记/无心跳/无 status 展示**，只能 `/reload` 恢复（R-2 第①态「进程内通道死了」仍不可观测）。`session_start` 也不清它 |
| **`claimReportNotified` 把任何 IO 失败当「已被消费」** | **2026-11-24 登记（未修）**。`catch { return false }` 丢失 EEXIST / EACCES / ENOSPC 区分 ⇒ 调用点随即 `postInject(true)` 写 delivered 收据（断言一次不存在的注入），并造成「有收据、无 `.notified`」状态 |
| **`!mySession`（identityless 进程）会放弃目录里所有回报** | **2026-11-24 登记（未修）**。与非本会话共用 `markReportSeen` ⇒ 范围比注释登记的 `tab_*` 更大，无标记 |

## R-25（2026-11-24）：**判断异步投递是否送达，必须看接收侧消费证据**

### 事故（Item 66：master 之间的回报通道是静默黑洞）

GreenCAD 的 local master（`agent://master_local_GreenCAD`）要向 global master 汇报离线解析成果。它三次尝试：

1. `tab-report` → 被拒（非 tab 进程无 `PI_TAB_RUN_ID`）
2. 查 master 工具 → `master-dispatch` 作 local owner 只能派本仓子树；`global-view` 只读；无 global tab 可 steer
3. **自己按信封格式落盘成功**（`~/.pi/agent/reports/report_mwucgcad_r1a0.json`，3351 B）

然后它据「同目录另两份历史 report 都有 `.notified`、本份没有」判断为「等 global 扫到」——
**这个推断合理，但结论错了**：那份永远不会有 `.notified`。

### 根因（三层，任一层都足以让汇报丢失）

| 层 | 机制 | 后果 |
|---|---|---|
| 1 | `tab-report` 对非 tab 进程硬拒绝，无 fallback | local master（主会话）永远用不了这个「唯一文档化的主动回报工具」 |
| 2 | `recipientSessionIdFor` 只认 `tab_*` 与裸 UUID，`agent://master_*` 全部 `undefined` | master 体系自己闭环不了 |
| 3 | `markReportSeen` 在 recipient 判定**之前**执行 | 解析失败 `return false` 时不写 `.notified`、却已进 `seenReports` ⇒ tick 守卫跳过 ⇒ 重启 `snapshotExisting` 又当已处理 ⇒ **不报错/不打日志/无 toast/无标记** |

### 规则

1. **判断「发出去了没有」必须看接收侧消费证据**（`.notified` / 回执 / ack），
   **不能看发送侧文件是否写出**。发送侧写成功只证明「我写了文件」。
2. **一个会报错的通道，agent 会重试或换路；一个静默成功的假通道，agent 会停下来等。**
   ⇒ 通道失败必须有**可见**（`.unroutable` 一类标记）且**可重试**（不得设次数上限——设上限 = 又造黑洞）。
3. **`markSeen`/`markDone` 一律放在「所有会让本次处理中止的判定之后」**：
   recipient 判定、owner 门、注入门。任一瞬时拒绝（attach 晚到、stale claim）被当成「永久已处理」
   = 与要消灭的缺陷同形（本轮 L4 两轮连续抓到同一形状）。
4. **启动快照只能用「接收侧消费事实」判已处理**，不能用「文件存在」判。
   代价是本进程重启会把未消费存量重投一次 —— 取舍同 R-5（宁可重发不可漏发）。
5. **退避必须落在成本点**（`recipientSessionIdFor` 的全扫 links 实测 2.8–5.2ms，
   而写标记 <0.05ms）；注释声明的节流若不覆盖真成本，「注释不算实现」（R-20）。
6. **新增「测试专用导出」时，要一并验证变异能命中**：
   本轮 `onNewReport(...)===false` 对「有没有 markSeen」**零判别力** ⇒ 删掉 markSeen 仍全绿（假绿）；
   改用 `_isReportSeen()` 才真红（M9 已验）。

### 为什么它比「找通道」更根本

业主原话是「他找不到合适的通道」，**实际是通道存在、文件写成功、另一端永不消费且不报错**。
⇒ 症状描述（「找不到通道」）与真因（「通道静默失效」）方向相反；**照症状修（加文档/加命令）不会修好**。

## R-26（2026-11-24）：**一条判据不得兼任「观测」与「判死」**（参数与真实时延量级错配时，先测分母）

### 事故（交付期限 60s：28.6% 的**已送达**事件被判死）

`DELIVERY_DEADLINE_MS = 60_000` 同时承担两件事：
1. 「这条跑了很久」的**观测**；
2. 「这条永远到不了」的**判定**。

实测本机 `~/.pi/agent/runtime/delivery`（141 事件 / 140 个有 `consumed` ACK）：

```
ACK − terminalAt（秒）  p50=0.31  p90=323.8  p95=913.8  p99=2836.9  max=3005.8
按 60s 判死 ⇒ 40/140 = 28.6% 的已送达事件被判死
```

后果不是「逻辑 bug」（`stage==="consumed"` 早已短路），而是**同一条判据把「目标会话正常排队」也判成死**。
历史上已造出 14 个「`fail_delivery` 与 `consumed` 并存」的矛盾终态（单例晚 6'36"）。

### 规则

1. **观测阈值与判定阈值必须分开。** 「慢」用低阈值记读数（`B-slow-delivery` trace，边沿触发），
   「死」用高于真实分布 p95 的阈值（本仓 600s）。**观测阈值不得触发任何终态/incident/停止重试。**
2. **定阈值前先测分母，不看单例**（R-11）。`_test_*` 里的「≤75s 可见」这类 SLO 断言，来自咨询文档而非实测分布；
   实测推翻它时，**改断言并在断言处写明口径变更与代价**（不是悄悄删掉）。
3. **判据的时间基准锚在事件发生时刻**（`terminalAt`），不是发现时刻（`observedAt`）。
   晚发现不隐式展期（咨询 §6.5）；存量事件缺字段时按 `terminalAt + 新阈值` 现算，不靠「重新写事件」补。
4. **改了阈值要连带检查所有把该常量当时间偏移用的测试**（本仓 6 个 `_test_delivery_*` 直接用 `NOW + DELIVERY_DEADLINE_MS`），
   并**为分档的每一档各写一个能红的断言**——只验「600s 会判死」不验「60s 不判死」，等于没验分档。
5. **观测必须验「真的落盘且有边沿」**（R-17 家族）：只断言「没发 incident」时，把观测整段删掉仍然全绿。
   本仓为此加了「`B-slow-delivery` 恰好 1 条 + 连跑两轮不增」两条断言（M5/M6 变异各自命中）。

### R-26 补充（2026-11-24 / P0-b）：**「扫不到」不是「不存在」——跨进程观测必须先证明观测面已追上事实**

D3 用「会话 JSONL 里 grep 不到 `[evt:...]` marker」当「消息没进会话」的证据，据此放行重投。
实测（QC 现场 6 个 run）：注入行**落盘滞后 ≥246s**（line 1533 ts=06:13:26 排在 line 1532
ts=06:17:32 之后）。D3 在注入后 **61s** 就扫了 4.16MB 并判 `absent` ⇒ 放行 ⇒ 同一 item 注入两次。

规则：
1. **「读不到」要分三态**：`found`（有）/ `absent`（读到了、确实没有）/ `inconclusive`（没读到、或观测面没追上）。
   只有 `absent` 能用于「不存在」的判断；把 `inconclusive` 当 `absent` 用 = 把「不知道」偷换成「没有」。
2. **`absent` 必须有「观测面已追上」的独立证据**。本仓用**文件 mtime > 注入时刻**（追加证据）；
   **不能用消息自带 timestamp** —— 它是产生时刻，在文件里可以乱序（实测差 ≥246s）。
   另一个常见错法：用「文件大小/行数没变」当证据，那在真实并发写入下恒不成立。
3. **时间阈值要有分母**。D3 原来的 60s 冷却没有任何实测支撑；本仓实测 ACK `p90=323.8s` ⇒ 提到 300s。
4. **改了判据必须同时改「生产是否真的把它接上」的测试**：本项变异发现「判据写对了、桥没传参」时
   原有 wiring 测试**照样全绿**（夹具 mtime 天然新鲜）。补一条**生产形状**的用例（把 mtime 回溯到注入之前）才抓得到。

### 与 R-20 的关系

R-20 说「三态机的注释不算实现，每一态都要有能演示它的输入」；
R-26 说「一档阈值不能兼任两件事，每一档都要有能红的断言」。同一类错误的两个面：**用一条判据省事**。

## R-15（2026-10-19）：不要把「用户本人的操作」误判成 agent 越权

**事故**：GreenCAD local master 派出 implementer 做 Item 1027 P3a，我看到 `run_mvevitap_dlxf`
（06:28 启动、running）后，仅凭「我没有派过它」+「它任务内容是删工具（不可逆）」，
就断言「local master 绕过我的约束直接开工 P3」，并建议用户立刻停下。

**实际**：用户当时**正在和那个会话直接对话**，是他本人授权推进的。

**根因**：我把「主会话视角看不到的来源」默认归因为「下级 agent 自作主张」，
而**没有先问一句**。用户与任意 tab/subagent 直接对话是常态，不是异常。

**规则**：
1. 发现「不是我派的」运行中任务，**先报告事实（runId/agent/启动时间/task 摘要）+ 问一句**，
   **不得**直接下「越权」判断，更不得建议强制终止。
2. 「任务内容触碰不可逆面」是**提示风险**的理由，不是**推定违规**的理由。
3. 同理：用户与 tab 直连对话期间，该 tab 的产出**不归主会话账**，不要拿它去反推「谁绕过了约束」。

---

## R-16（2026-11-03）：junction 目录**禁止递归删除**；基线 worktree 用 `PI_NODE_MODULES_DIR`，不要 mklink

### 事故（我造成的一次真实损坏，全过程与读数见 `plans/20261103_incident_junction_recursive_delete.md`）

为做基线对照我跑了：

```bash
git worktree add -q ../wt-base 6f86b3b
cmd //c "mklink /J ..\wt-base\node_modules  <主仓>\node_modules"
git worktree remove ../wt-base        # ← 报 "failed to delete … Invalid argument"
```

`git worktree remove` 的递归删除**会穿过 junction 走进目标目录**。沿链删掉了主仓 `node_modules`
里 junction 的**目标内容** = **全局 pi 安装**（本仓 `node_modules/@earendil-works/pi-coding-agent`
与 `pi-tui` 实测 `LinkType=Junction`，指向 `C:\nvm4w\nodejs\node_modules\@earendil-works\...`）。

后果实测：全局 `pi-coding-agent/dist/` 文件数 **0**（应 28）、嵌套包只剩 `pi-tui=5`、
**`pi --version` 直接 module loader 报错**（CLI 起不来）、`health.mjs` 判 `UNHEALTHY`。

### 规则

1. **禁止对含 junction 的目录做递归删除**：`git worktree remove` / `rmdir /s /q` /
   `fs.rmSync(..., {recursive:true})` / robocopy `/MIR`，都会穿 junction 删目标。
   删目录前用 PowerShell 查 reparse 点（`Get-ChildItem -Force | Where Attributes -match ReparsePoint`），
   有则先**只删链接**（`(Get-Item x).Delete()`），并认识到删链接也改变消费方视角。
2. **基线/对照 worktree 复用依赖的正规做法 = 环境变量，不是 junction**：
   `PI_NODE_MODULES_DIR=<主仓>\node_modules`（`scripts/ensure-pi-test-deps.mjs` 认它），
   基线目录里**不建 junction**。这样递归删除最多删掉基线目录自己。
3. **数 junction 里的文件不能用 MSYS `find`**——`find` 不穿 junction，会得到假的 0。
   用 PowerShell `Get-ChildItem -Recurse -File` 或直接查 junction 目标路径。
4. **`@earendil-works` 的布局事实（纠正 §14 环境事实里那句"已是真实副本"）**：
   本仓 `node_modules/@earendil-works/{pi-coding-agent,pi-tui}` 是**由
   `scripts/ensure-pi-test-deps.mjs` 创建的 junction**（指向 pi 安装树）。
   **不要**用实体副本替换它们——脚本会判 `CONFLICT … refusing to replace an existing path`
   ⇒ `smoke:wiki-nav` / `smoke:wiki-semantic` / `test:register-graph` 三条直接红（实测 3/3 稳定）。
   依赖坏了的正确顺序：修**目标**（pi 安装树）→ 跑 `node scripts/ensure-pi-test-deps.mjs` 重建 junction
   → 用 `plans/pi-corruption-diagnostics/health.mjs` 验收（R-14）。
5. **从 `C:/pi-standalone` 复制实体修全局时：禁 `/MIR`**（运行中的 pi 持有旧文件）。
   实测 `/E` 的 robocopy 会以 exit=9 结束，且唯一失败项是**在用的**
   `pi-tui/native/win32/prebuilds/win32-x64/win32-platform.node`（EBUSY，该文件本就存在 ⇒ 无损失）。

## R-17（2026-11-04）：账本落点必须与消费端同源；「写进去了」≠「看得见」

### 事故（用户原话：「融合者也不会作为一个 subagent 去呈现，任何地方都找不到它」）

`extensions/trace-fusion/fusion-dispatch.ts:394` 用 `process.env.APPDATA` 拼账本目录：

```ts
const runsDir = input.runsDir ?? join(process.env.APPDATA ?? "", "pi", "agent", "subagent-runs");
```

本机实测这两个是**两个互不相关的目录**（PowerShell 查 `LinkType` 均为空，不是 junction）：

```
C:\Users\<u>\AppData\Roaming\pi\agent\subagent-runs   ← 融合者写这里（孤岛）
C:\Users\<u>\.pi\agent\subagent-runs                  ← 真实账本目录（index.ts:208 RUNS_DIR）
```

而消费端 `extensions/index.ts:2649` 盯的是**另一个**：

```ts
collect(registerAsyncResultWatcher(pi, { runsDir: RUNS_DIR }));   // RUNS_DIR = DEFAULT_RUNS_DIR
```

⇒ 融合者写了账本，但 `registerAsyncResultWatcher` 永远监听不到它 ⇒ `subagent-win list` / async 面板 / 完成通知 / kill **全部空白**。
实测存量 9 份孤岛账本（从 `run_fusemw0mh6mm_eeyu` 11-03 19:46 到 `run_fusemw1utt8t_yc1w` 11-04 16:31）—— **从功能落地那天起每一次融合都是「看不见」的**，无人发现。

### 规则

1. **账本/派生目录不得自行拼路径**。仓内已有单一常量（`subagent-kill.ts:43` `DEFAULT_RUNS_DIR`，注释就写着「避免两处硬编码漂移」），必须复用它。
2. **写账本前先找消费端**：`grep -rn "registerAsyncResultWatcher\|listTabDispatches\|defaultTabRunsDir"`，确认自己写的目录与消费端读的是同一个。
3. **「写进去了」不等于「看得见」**：验证可观测性不能只看文件存在，要看**消费面**（list / 面板 / 通知）真的有那一行。
4. **存量迁移必须带去重标记**：迁 `run_*.json` 到真实目录时，**每份同时写 `.notified`**，否则 watcher 的 tick 会把全部陈旧完成通知一次注入当前会话（本次 9 份，实测会刷屏）。
5. **不自动迁移存量**：迁移会让旧完成事件重新进入投递链，属人的决定。

### 为什么它是 R-2 的姊妹条

R-2 说的是「开关关掉就彻底不工作，必须有独立存活信号」；
R-17 说的是「在工作，但产物写到了没人读的地方」—— **同样是静默失效，同样只能靠消费面读数发现**。

---

## R-18（2026-11-05）：**改了不等于生效**——会话内常驻路径必须用新进程验收

### 事故（我自己踩的，gen14 复现确认）

`#8` 修了 diagnose 模式把 `repoRoot` 当 lane worktree 的缺陷（`fd12c6d`，04:07 提交）。
之后我在**同一个主会话进程**里跑了一次 trace-fusion，reclaim 仍然报 6 条
`fatal: '<repo>' is a main working tree`，仓外 `.stale.json` 野文件又出现。

**不是修复无效，是修复没被加载**：
- 主会话进程 pid 5420 **启动于 11-04 16:00:33**
- `fd12c6d` 提交于 **11-05 04:07:21**
⇒ 那个进程跑的是**旧码**。而写 `.stale.json` 的调用链
`index.ts:2661 onTabFinished → maybeAutoCollectTraceRun → reclaimTerminalLaneWorktrees`
**跑在主会话进程里**，不是 lane 进程。

### 规则

1. **凡修改「会话进程内常驻代码路径」，验收必须用新进程。**
   这类路径包括（不限于）：`supervisor` / `worktree-reclaim` / `async-result-watcher` /
   `sweepDeadTargets` / `autonomy tick` / `event-bus` —— 全部由 session 事件驱动，
   只在长驻进程里跑。
2. **验收方式（按成本从低到高）**：
   · 起一个独立 node 进程 `import` 该模块直接验（最快，本次 gen14 就是这么验的）
   · `/reload`（同进程重读扩展，覆盖大部分场景）
   · 重启会话 / 重启 host（最彻底，但会影响当前所有会话 ⇒ **必须用户批**）
3. **禁止的验收方式**：`git log` 有 commit + 单测绿 ⇒ 就宣布「已修」。长驻进程不会热更新，
   这正是「改了但没生效」的形状。
4. **一批改动要登记「需重启才生效」清单**，并在下一次重启时一次性核对。
   2026-11-05 本批有 4 项属于这一类：
   `fd12c6d`（#8 worktree）、`654aeed`（journal R-2 信号）、
   `cc3a1f2`（项 6 死信终结）、`47bf3cb`（项 0 判活判据）。
5. **区分「改了但没生效」与「改错了」**：前者重跑即好，后者要返修。
   判据是「进程启动时刻 vs commit 时刻」，不是「现象有没有」。

---

## R-19（2026-11-05）：提交前自检——改含转义字面量的 `.ts` 后必须 import 加载验证

### 事故（同一天两次，都是我自己）

1. **第一次**：用 `node -e` / heredoc 写含 `\n` 的 TS 字面量 ⇒ 三层转义（shell → node → JS 引擎）
   各吃一层反斜杠 ⇒ 写进文件的是真实换行。改用 `String.fromCharCode(10,10)` 后正常。
2. **第二次**（`7e8e3ac`）：用 **python 的 `s.replace()`** 写入含 `\r?\n` 的 TS 正则 ⇒
   `md.split(/` + 真实换行 + `?` + 换行 + `/)` ⇒ `SyntaxError: Unterminated regexp literal`。
   后果真机实测：run `tfl-20261105-050830-7ccc` 三路终态后 collect worker **起不来**，
   claim 被领走、worker 一启动就崩、cross-test/fusion 全没生成、run 卡在 `running`。

### 规则

1. **改 `.ts` 里含转义字面量（`\n` / `\r?\n` / 正则 `/.../`）的代码后，提交前必须做一次加载验证**：
   ```bash
   node --experimental-strip-types --import ./extensions/runtime-host/pi-deps-loader.mjs \
     -e "import('./path/to/file.ts').then(()=>console.log('load ok'))"
   ```
2. **不要用字符串替换（python `s.replace()` / `sed` / heredoc）写带反斜杠的字面量**。
   改用：`edit` 工具、或按行号整体替换函数体、或用 `chr(92)` 显式拼接。
3. **进程入口文件（`*-cli.ts` / `main` 入口）必须有加载 smoke 测试**。
   它们只在被 spawn 时才执行 ⇒ 语法错能完整逃过整套测试网
   （本次已补 `test:trace-fusion-collect-cli-import`，~50ms）。
4. **测试不覆盖 = 不等于没问题**。看一个改动的验证是否充分，要看
   「这类错误有没有任何测试会红」，而不是「我跑的那几个套件绿了」。

> **另见 R-24**（提交前自查四条：untracked 夹带）。两条都是「提交前」、都会在
> commit 里留下不记录。**只找到一条就收手 = 没查完**——R-24 的病因正是「以为查过了」。

---

## R-20（2026-11-05）：**三态机的注释不算实现**——写进规则的那一态必须真的可达

### 事故

R-2 规则 3 早在 2026-10-17 就写明要区分三态：**①进程/tick 死 ②功能被关 ③正常工作**。
`frontierFreshness`（`runtime/autonomy/collect.ts`）只实现了 ② 和 ③。缺的 ① 恰恰是本次
真实故障的形态：

```
心跳 age = 46min（周期 30s）→ hbFresh=false
frontier age = 12h          → stale=true
suspectedDisabled = stale && hbFresh = false
hb && !stale = false
!hb && frontier = false     ← 心跳**存在**，只是旧
⇒ 三分支全 false ⇒ /autonomy status 只报「诊断：未知」
```

唯一能走到「tick 未在跑」的分支要求 `!hb`（心跳**完全不存在**）。而故障时心跳文件还在，
只是停了 ⇒ 那条分支永远走不到。

### 规则

1. **每加一条「三态/多态」规则，必须逐态写出一个能演示它的输入。** 缺一态 = 规则没落地。
2. **「删除类」与「陈旧类」必须分开表达**：`!hb`（从未有过/被删）和 `hb 但旧`（停了）
   是两种故障，不能让后者被前者遮蔽。
3. **写了 sessionId 不等于用了它**。同 R-17：产物带身份字段但读方不比对 = 白写。
4. **诊断文案不得超出证据作用域**（L4 F2 教训）：wake 心跳陈旧只证明「wake tick 没在跳」，
   不能证明 mailbox 消费链（独立 10s interval）也停了。措辞必须收窄到「这份证据能说明什么」。

---

## R-21（2026-11-05）：**owner 门不得阻塞 interval 注册**——session_start 与 attach 是时序竞争

### 事故（local↔global 通信实际断了 25 小时，无人发现）

```
主会话（gen14）session_start   11-04 15:57:35
global attach 写入             11-04 15:58:01   ← 晚 26 秒
```

`registerMailboxConsumer` / `registerWakeLoop` 在 `session_start` 回调里判：

```ts
const eligible = cut?.enabled && att ? sid === att.sessionId : isMainSession();
if (!eligible) return;          // ← interval 永不启动
interval = setInterval(...);    // ← 唯一启动点，在 return 之后
```

那一刻 `att` 还是旧值 ⇒ `eligible=false` ⇒ **interval 从没起过**。
而 attach 之后**没有任何事件重跑这段判定** ⇒ 接管方拿到的是「owner 名义 + 零消费者」。

实测后果（分母 26 封信）：自动 17 / **人工 8** / 无 1。
自动链最后一次 11-04 10:49，此后全靠人手 ack；一封 RESULT 5.7 小时无人认领。

`extensions/report.ts` 有**同一形状**的既存遗漏（L4 F5 指出），一并修了。

### 规则

1. **注册层只判「身份类型」（子 agent / 非子 agent），不判「当前是不是 owner」。**
   owner 判定必须在 **tick 内**每次重读——因为 owner 会在会话生命周期中途变化
   （attach / handoff / cutover 翻转 / 撤销）。
2. **任何「只在 session_start 判一次」的门都要问：如果条件在第 2 秒才成立，
   它还会不会被重新求值？** 不会 ⇒ 这就是一个必然的静默死锁。
3. **interval 必须 unref，但 `fs.watch` 不能 unref** ⇒ 用 `fs.watch` 的模块必须有
   可靠 `stop()`，且**临时验证脚本必须显式调它**，否则进程永不退出。
   （本次我因此让一条命令挂了一个多小时——脚本调了 `registerReportListener` 却没 `stop()`。）
4. **共享槽位只能由「语义上的主体」写。** `heartbeat.json` 是「owner 的 wake 链活着」的
   唯一槽位；非 owner 写它会覆盖真 owner 的存活信号，把「owner 停了」变成
   「tick 活着，autonomy 很可能被关」（L4 用真实注册链隔离复现，P1）。
   非 owner 的存活必须写 **per-session 分文件**，且不被「被关」判据读取。
5. **测试要过真实注册入口**（`pi.on` 回调 → interval → poll），不能只调内部函数。
   本次 `report.ts` 的 tick 是 5000ms，测试等 300ms ⇒ **测不到 tick 链路**。
   故把 `pollIntervalMs` 做成可注入（生产仍 5000ms）。同 R-4：夹具必须贴近真实形状，
   但也要把「等不到的时间」变成可注入的参数，否则等于没测。

---

## R-22（2026-11-05）：错误分类的词表**宁窄勿宽**——一个裸词就能把瞬时故障变成"换模型"

### 事故

opendesign-go 返回：
```
503 {"code":"database_unavailable","message":"resolve Billing Scope: status 503"}
```
`classifyModelFailure` 的额度正则里有裸词 `billing` ⇒ 命中 `resolve **Billing** Scope`
⇒ 判成 `usage_cap`。两个后果都错：

| | 旧（usage_cap） | 应然（provider_network） |
|---|---|---|
| 处置建议 | 「换模型」← 换模型救不了后端 DB 不可用 | 「可自愈，重试」 |
| 退避 | 60s/120s（×usageCapMultiplier=2） | 30s/60s |

而这条 503 本该命中已有的 `\b50[0-4]\b` 连接类规则——是**判定顺序**让它被额度词抢走。

### 规则

1. **单一裸词不得作为"额度耗尽"的证据**。`billing` / `plan` / `limit` 这类词会大量出现在
   路径名、服务名、字段名里。要求「词 + 上下文」（quota/credit/额度/套餐…），或本身是 429。
2. **HTTP 5xx = 服务端暂时不可用，优先级高于额度判定**。额度耗尽用 4xx 报；用 5xx 报的
   "billing" 几乎都是服务内部路径。
3. **分类错误的代价被退避倍数放大**：`usageCapMultiplier` 会把 30s 变 60s。分类要连同
   "这个 kind 会触发什么退避" 一起看。
4. **多余的护栏要显式登记为冗余**。本次留了一条冗余护栏（`http5xx && billingish`），
   第一次变异发现"只删护栏不变红"——这正是冗余的证据。要么删掉，要么在注释里写明
   "它是冗余的、单独回退不会红"，**不能让后来者以为它有判别力**。
5. **测试要对每条独立生效路径都有判别力**。一个行为有两条路径都能达成时，单独回退任何
   一条都不会红 ⇒ 必须再补一组只走单条路径的用例（本次 C5 就是补这个）。

---

## R-23（2026-11-05）：**「全闭合」类声明必须逐条给证据**——整体结论不合格

### 事故（就是 2026-11-05 本会话自己）

我向 global Master 回报「R-21 的 F1–F5 + N1/N2/N3 **全部闭合**」。
实际是：**F2 的越界仍在**、**F4 三条缺口里两条根本没做**。
是 gen14 追问「我特别关心 F2 和 F4 是否被默默放过」才逼出真相，然后又是两轮独立 L4 才收干净。

我自己的复盘中出现了两句关键的自白：
- 「F2 我原以为已收窄到位」
- 「F4 我只补了注释」

**「以为」+「只补了注释」= 用一句话概括了三条要求的处置，其中两条未做而没写。**
这不是说谎，是**用整体结论掩盖了逐条的差异**——危害等同。

### 规则

1. **禁止只给一条整体结论**（「全部闭合」/「都修了」/「已验收」）。每一条必须写三件事：
   - ① **改了什么**：`file:line` 或 commit hash（不能是「改了相关逻辑」）
   - ② **怎么验证的**：命令 + 预期读数 + **变异是否命中**（没做变异就写「未做变异」）
   - ③ **若未做**：明确写「**未做 + 理由 + 登记在哪**」（不是省略，也不是写成「已覆盖」）
2. **「登记为未闭合」≠「验收豁免」**。登记只能保证它不消失，不能让它变成通过。
   若某项仍未做，回报里必须与已闭合项**分开列**，不得混在同一句话里。
3. **自查发现的自白必须写进回报**，不要只在心里想。
   本次「F2 我原以为已收窄」这句自白如果在第一封回报里就写出来，能省两轮 L4。
4. **这条对下属 agent 同样适用**：派 L4 / 派实现时，要求它们也按三件事格式回。
   「测试全绿」「已修复」不是可验收的陈述。

### 为什么它比「写测试」更根本

L4 能查出缺陷，但它**查不出「你没说的东西」**。第一轮 L4 之所以能抓到 F2/F4，
是因为我在派单里**主动列了「我特别担心 F2/F4」**——那是运气，不是流程。
**回报格式才是那道强制检查**：它逼你在写之前先逐条确认，而整体结论允许你在写之前什么都不确认。

---

## R-24（2026-11-10）：**提交前自查四条缺一不可**；`git diff --numstat` 单独一条不构成检查

### 事故（`6cacb26`，我自己的操作）

我把三个临时统计脚本 `_tmp_cost.mjs` / `_tmp_cost2.mjs` / `_tmp_cost3.mjs`（97 行）夹进了
一个「只改成本口径」的文档 commit。该 commit 实际新增 **126 行**，正式改动只有 **29 行**
⇒ **77% 是野文件**。

**为什么没发现**：commit 前我跑了 `git diff --numstat`，输出只有 `4 1 gate.ts` / `25 6 SKILL.md`，
看起来完全干净。**因为它只统计已跟踪文件，不含 untracked。** 我随后用 `git add -A`，
把未跟踪的三个脚本一并收了进去。

⇒ **我把一条有盲区的命令，当成了完备检查。** 这不是「忘了查」，是「以为查过了」。

### 规则：提交前四条全过，才算检查过

```bash
git status --short             # ① 看 untracked —— numstat 看不到，这是本次事故
git diff --cached --numstat    # ② 看暂存区实际内容（行数对不对）
git diff --cached --name-only  # ③ 逐条确认每个文件名都属本次改动
# ④ 禁用 git add -A / git add . —— 一律 git add <具体路径>
```

- **`git diff --numstat` 单独一条不构成自查**（它沉默地看着 untracked 文件进库）。
- 若已经用了 `git add -A`：`git diff --cached --name-only` 是唯一能抓到夹带的命令。
- **commit message 里的行数必须与 `git show --numstat --format="" <hash>` 的合计一致**
  （本次 message 报 `4 1` + `25 6` = 29，实际 126 —— 前后对不上，就是因为只抄了已跟踪部分）。

### 附带：`.gitignore` 前缀要覆盖实际写法

本仓已有 `.tmp_*`（点前缀），而我的文件叫 `_tmp*`（**下划线前缀**）—— 两条不同规则，没覆盖。
现已补上 `_tmp*`（`.gitignore` 第 48 行）。**新增临时文件前先看已有规则的前缀，不要假设。**

### R-24 补充（2026-11-20 / 11-23 两次）：**`git checkout HEAD -- <file>` 也是整文件覆盖**

**两次同类事故，都是我：**

| 日期 | 操作 | 后果 |
|---|---|---|
| 2026-11-20（`572185f` 期间）| `git checkout HEAD -- package.json` 复原工作树 | 抺掉别人 11-13 未提交的 **16 行** script |
| 2026-11-23（`f27379e` 期间）| 同上 | 抺掉 **17 行**（多了一行）|

**为什么会这样**：我的流程是「把只有我那一行的版本 `git add` 进暂存区，然后把工作树恢复成
以待提交版本为准」—— 于是用 `git checkout HEAD -- file` 去“恢复”。但 `HEAD` 是**上提交**，
里面没有别人那些未提交的行 ⇒ **“恢复”实际是“回滚到 HEAD” ⇒ 抹掉所有未提交改动**。

⇒ **R-1 的“禁止整文件覆盖”不只管 `write`/`>`，也管 `git checkout HEAD --`。**
它看起来像“恢复”，实际是**单文件 reset**。

**正确顺序（把工作树改动与我自己改动分开）**：
```bash
# ① 先抓一个工作树快照（含别人的未提交行）
cp package.json C:/tmp/pkg_wt_<ts>.json
# ② 从 HEAD 重建「HEAD + 仅我的一行」，写进文件 → git add
# ③ **把快照拷回来**（不是 git checkout HEAD）
cp C:/tmp/pkg_wt_<ts>.json package.json
```
**禁止 `git checkout HEAD --` 作用于“含他人未提交改动”的文件。**
（`git checkout HEAD --` 只允许作用于“工作树本无未提交改动”的文件。）

**为何写进规则而不是只写 commit message**：两次犯时我都知道 R-24，
但 R-24 四条里**没有一条能拦住 `git checkout HEAD --`** —— 它是“恢复”动作，看起来不属于
“提交前自查”。⇒ **触发条件漏了一个入口，不是“我又忘了”**。同类：R-1 只写了 `write`/`>`，
没写 `git checkout`；R-16 只写了递归删除，没写单文件 reset。

### 与 R-23 的关系

R-23 管「声称做了但没做」；R-24 管「**检查了但检查本身有盲区**」。
两者同一个后果：**记录与事实不符**，只是前者在言，后者在行。

## 快捷按钮面板（2026-11-20）：agent 侧契约

右栏「按钮」面板按仓库 cwd 隔离。本节只在本仓作为 cwd 的会话里自动进上下文；**其它仓库靠面板上的「让 agent 推荐」按钮**把同样的信息注入那一次会话（不能假设 agent 天生知道这套 schema）。

- **权威配置**：`<agentDir>/gui-shortcuts/<repo-key>.json`；提案放同目录的 `proposals/<32位小写hex>.json`。`repo-key` 与详情由 GUI 面板/GET 给出，不要自己猜绝对路径。
- **提案阶段只写提案文件，不改主配置**。字段：`{version:1, proposalId, cwd, baseHash, reason, sourceSession, createdAt, ops[]}`；`proposalId` 与文件名相同，`baseHash` 取面板当前 `contentHash`，`sourceSession` 取当前会话 id（批准后的回注要回到这里）。`ops` 三种：`{op:"add",action}` / `{op:"update",targetId,action}` / `{op:"remove",targetId}`。
- `action.kind` 仅 `url|file|script|process`，分别填 `url` / 仓库内相对 `path` / 仓库内 `.ps1` 相对 `command`+`args` / `matchCommandLine`；危险动作 `confirm:true`。`script` 不需要 shell 或 CLI，服务端按参数数组执行。
- **批准阶段**会收到一条自包含的 `session.message`（主配置绝对路径 + ops + 改法）。此时才用 `Write`/`Edit` 改主配置：**先重读**（用户可能在你提案后改过），精确编辑，不要整文件覆盖。改完面板 1s poll 按语义 hash 自动折叠为 applied。
- 没有批准指令时改主配置 = 绕过用户决策；基于旧快照整文件覆盖 = 抹掉他人改动。两条都禁止。

### 与 R-19 的关系（**两条都要过**）

R-19 与 R-24 都叫「提交前自检」，但管的是不同的洞：
- **R-19**：改含转义字面量（`\n` / `\r?\n` / 正则）的代码后，**必须 import 加载验证**。
  查的是「文件内容本身有没有被写坏」。
- **R-24**：查的是「**有哪些文件进了这个 commit**」，untracked 与 `git add -A` 是主要风险。

**只过一条 = 没查完。** 这正是 R-24 的病因（我以为查过了）在规则层面的复现。
两条互引，看到任何一条都必须读到另一条。
