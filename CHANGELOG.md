# Changelog

## [0.4.0] — 2026-09-20 (runtime GUI: G1–G5 vertical slice)

- **Runtime Host（G2）**：`/runtime-host start|stop|status`，GET /v1/health|snapshot|events?after|attention|timeline?before + POST /v1/commands（唯一写端点）；host.json 动态端口发现（tri-state 探活）。
- **投影（G3）**：attention 三源聚合（§31 九字段、去重）、timeline journal 升序人话时间线；快照 additive 扩展 master.liveness / autoHandoff / per-ws wakeState+mailboxBacklog。
- **命令执行器（G4）**：`runtime/command-executor.ts` 确定性执行首批命令 workstream.pause/resume、master.handoff.accept、master.auto-handoff.set、master.handoff.prepare；state/commands/ wx-claim 幂等（SHA-256 无碰撞工件名、dedupeKey=<type>:<commandKey>）+ journal command.* 审计；generation 级 proposal 原子 create（agent_end 与 prepare 双调用方防 TOCTOU）；writeConfig tmp+rename 原子化。L4 两轮 APPROVED（collision/master-only/payload 白名单/4 进程真并发）。
- **GUI v0（G5）**：`gui/` vite+react+ts+tailwind4+zustand 浏览器工作台，五页（主控/时间线/需要关注/工作流/运行时），2s/6s 轮询+409 resync+诚实 as-of；中文白话化（G5.1）；GUI 独立 beforeCursor 分页容量策略（G5.2 R3）。server 零 CORS/零 dist 托管，vite dev proxy 同源。
- **心跳写手**：session agent_end 节流落盘 master-liveness（活压力 + 值守会话心跳），prepare 仅认当前 owner 的活值（R1 绑定校验）。
- **S2 Gate 终审（附录A）**：采 b 案（1 次自然提案 + 14 天浸泡至 2026-10-04 开放 S3 opt-in，默认仍 OFF）。
- 事件链四层修复、dispatcher-wake、二级 master v1、`/master-succession` 总开关、档位表 proposal 线（详见 feat/trace-fusion-loop 0918–0920 提交序列）。

## [0.3.0] — 2026-09-17 (trace-fusion diagnose mode)

- **新增主会话工具 `trace-fusion`**：agent 判断任务困难/根因不明时可自主触发只读诊断 rollout（强制 diagnose 模式，零磁盘零主仓库写入），发起后立即可继续其它工作，三路终态自动收集并通知；lane tab 不可见该工具（排除名单 + 运行时能力二次校验）。implement（worktree 读写）仍仅限人工命令。

- **trace-fusion-loop 新增 diagnose 模式并设为默认**（`traceFusionLoop.mode`，`implement` 为 opt-in）：lane 只读诊断主仓库，产出诊断+推进方案，零 worktree、零磁盘代价（implement 实测 12GB/轮）。edit/write 派发期禁用 + dirty-baseline 违规确定性检查；cross-test 以 skip 型报告 + 融合交接说明替代（不在用户仓库执行命令）。管线其余（三 tab 派发/墙钟/权威收集/自动收集）不变。
- **`/trace-fusion-clean <runId> [--force]`**：清理 run 的 worktree 占用（v0.5 提前落地）；runDir artifact（patch/trajectory）永不删，patch 可重放复验。running run 需 `--force`。
- supervisor 自动收集 + session_start 追赶 + claim 幂等（2026-09-16/17 系列）：三路终态自动后台 cross-test，主会话重启可追赶，claim 文件防双 spawn。
- 修复：collect-cli 主模块守卫在 Windows 永假（路径分隔符未归一化）导致后台 worker 空转。
- 真实首跑修复（2026-09-15/16）：validation.json 数组形状容错、墙钟过期 run 自动回收、worktree 根 trust 预授权。

## [Unreleased] — 2026-09-17

### Added
- **热点路由缓存首版（extensions/hotspot/，v2 设计落地）**：新会话首轮用户消息末尾附加一次 `<system-reminder>` 热点块（幂等：entries 检查 + `hotspot-injected` custom entry 双保险；恢复/旧会话不注入；压缩经 customInstructions 保留指针提示；字段 `<` 转义防提前闭合）；`hotspot` 工具（read/upsert/remove：严格解析文件格式、结构+引用+CodeGraph 符号三重验证、存储与注入双预算、revision+指纹乐观锁、`.lock` 跨进程锁（陈旧 30s 抢占）、临时文件原子替换、相同路由内容不写入不增版、remove 保留 `_hotspot.trash.jsonl` 恢复副本）；`/hotspot` 只读诊断（磁盘/注入版本、热度排序含评分依据、预算估算、降级原因、效果日志路径）；热度信号现算不落盘；效果日志 `~/.pi/agent/hotspot-logs/<repo-key>.jsonl`（仅必要指标）。子 agent 进程不注册任何能力；主 `index.ts` 仅 +5 行。配套：`_test_hotspot.ts`、`_seed_greencad.ts`（真实 CodeGraph 验证试点条目 mesh-push）；searcher.md 增「热点候选」回返纪律，workflow-orchestrator 阶段 5 验收清单增热点路由检查项。设计：`plans/20260915_plan_hotspot_memory_layer.md`（v2 §11 代码结构约束）。
- **热点首版验收补账（§8.2 修订，同日）**：①热度信号补**未提交工作树 diff**（`git diff HEAD --name-only`，命中 ×5/目录 ×2 高于已提交 churn——实测 greencad 有 246 文件/7804 行进行中改动对 git log 完全不可见，原排序失真）；②注入头新增「最近任务 / 最近改动」两行现算小节：任务按 Item 编号降序 top3（指针式一行，不复制状态），函数级从未提交 diff + 近 30 条 commit hunk 上下文聚合 top5（`extractFuncContexts` 过滤 namespace/using 噪声，空时降级文件级）；③greencad 配置 `*.cs diff=csharp` + xfuncname（C# 默认 xfunc 抓 namespace，配置后方法签名级可用，实测 `ClearMaterialSelection(`、`TrySample(` 命中）。固定说明预算 600→900 字符；实测注入总量 323 token 零降级。

## [0.3.0] — trace-fusion-loop (feat branch)

### Fixed
- **Luna 复核轮修复（2 major + 4 partial 补全）**：`PiLaunchArgsOptions` 补声明 `excludeTools`（静态类型同步）；cross-test `testFileDiff` 改 `diff HEAD`（上轮批量修复因脚本中断遗漏，实测复现 staged 测试 diff 丢失）；`/trace-fusion-collect` 增加终态门槛（三 lane 未全部 tab-finish 时拒绝，除非 `--force` 显式放弃等待——防撕裂证据与错误终结 run）；命令归一化改【路径→`.`】策略（`cd "."`/`npm --prefix .`/`./f.js` 全部语义正确；lookahead 路径边界防 `C:\wtx` 误伤；URL scheme 不折叠）；异步 spawn 失败时清理该 lane 邮箱的 pending deadline timers；`timedOut` 判定改 `>=`；cross-test 报告落盘移到 cleanup 之后（cleanup notes 持久化进报告）。
- **Luna C4–C8 审查修复（13 项 major/critical + 3 minor）**：①trace worker 身份 env 化（spawnPiTab 注入 PI_SESSION_PROFILE/PI_TRACE_*，factory 阶段即可判定）+ `/trace-fusion-loop` handler 内运行时能力二次校验；②trace tab 工具隔离落地（spawnPiTab 新增 excludeTools 通道，C6 强制传 §17 名单 launch/timer/wiki 写工具）；③delegation guard 加固（空 task/空 tasks 入参校验封死绕过面；trace worker 派 searcher 强制 tools=read,bash 不可覆盖）；④synthetic snapshot 拒绝 run 目录在仓库内（防自吸产物）；⑤execGit 默认剔除继承的 GIT_INDEX_FILE（防污染后续 git 操作）；⑥stale worktree 自动回收（带标记的残留目录启动时清理）；⑦异步 spawn 失败回写 launch_failed 账本 + launch-errors.log；⑧§24.2 墙钟邮箱计时器（deadline-5min 提醒 + deadline 收口）；⑨**三段式 patch part2 改 `diff HEAD`**（原裸 diff 漏 staged，cross-test testFileDiff 同步修）；⑩命令归一化全局+大小写不敏感+引号形式，归一化后仍引用 worktree 的命令拒绝入池；⑪changedFiles 改 name-status 三段（覆盖重命名/删除）；⑫untracked 测试文件从其它 lane 归档复制进 eval 树；⑬新增 `/trace-fusion-collect` 把收集+cross-test 接入生产生命周期（meta 终态化）；minor：result.json 归档进 lane 目录、eval 清理失败记 note、EOF 空白/缩进、lite 测试清理身份 env。

### Added
- **C8 deterministic cross-test + /trace-fusion-status（cross-test.ts）**：§27–§28 落地——pooled commands（跨 lane 去重 + 来源合并；命令归一化剥除 lane worktree 绝对路径含后续分隔符）；每个 candidate 建 eval worktree（Base + candidate patch + untracked 归档 + **其它 lane 无冲突 testFiles 的测试 diff**；path collision 跳过并记 note，Test Consolidator 留 v0.4）；判别 fail **重跑一次防抖**（fail+fail=fail、fail→pass=flaky）；blocked 语义（eval 树不可用/patch 未干净应用）；矩阵落盘 `cross-test.json`（供 v0.4 fusion 消费）+ 人读 `cross-test-report.md`；eval 树用后即删（失败标 stale），不碰 A/B/C 原始 evidence worktree。`/trace-fusion-status` 从磁盘重建视图（meta.json + result.json + 产物清单，主会话重启无损）。worktrees.ts 抽出 `createSingleWorktree` 原语（lane 树/eval 树共用）。新增 `_test_trace_fusion_crosstest.ts`（真实 git 临时仓库 + exec seam：pooled 合并与归一化/flaky 防抖语义/pooled 测试跨 lane 注入/collision 跳过/报告落盘/eval 树清理）。
- **C7 权威收集：supervisor 三段式 patch 自算 + 可信命令池（artifacts.ts）**：按 §21.0 权威来源划分——supervisor 自算 patch.diff/changedFiles/untracked 清单（part1 `diff --binary <base> HEAD` 覆盖已 commit + part2 覆盖未 commit + part3 untracked 单独归档 `lanes/X/untracked/` 并写 status.txt）；worker 叙事（trajectory.md/validation.json）仅参考，缺失记 issue 不致命；validation.json 宽松解析，**仅 portable 复现命令 + validationCommands 进可信命令池**（命令结果一律以复跑为准）；worker 终态探测（result.json）与 §24.2 墙钟超时判定；汇总报告落 `collect.json`（含全 lane 可信命令池，供 C8 cross-test 消费）。§23：tab-finish description 按 session profile 注入 Trace 完成契约（isTraceWorker 时）。新增 `_test_trace_fusion_collect.ts`（真实 git 临时仓库：未 commit/已 commit/untracked 归档排除 ignored/叙事缺失容错/超时判定/汇总落盘）。
- **C6 三 tab 派发：/trace-fusion-loop 主入口（launch-workers + worker-prompt + config）**：新命令 `/trace-fusion-loop <任务>`（主会话专属，canOrchestrateTabs 分支内）一次完成 preflight → runId/目录 → synthetic snapshot → 三 worktree + provisioning → meta.json → 三 tab 派发。`launch-workers.ts`：派发经 C3 原语 `spawnPiTab` 直连（**不经 workflow prompt builder**，设计稿 §18），注入 `sessionProfile: "trace-worker"` + `traceRunId` + `traceLane`；spawn 走注入 seam（测试可注入 fake，无 WT 也可测编排）；单 lane 派发失败 → run 降级 2/3，全部失败 → meta 标 failed + worktree 回滚；账本 mode 新增 `"trace"`（tab-runs.ts TabMode 扩展）。`worker-prompt.ts`：§20 纪律——三 tab 收到同一原始 task，只差 lane metadata，严禁人为分派假设；含 evidence-first 纪律、searcher-only 委派声明、trajectory.md 九节 + validation.json 契约、**patch.diff 由 supervisor 自算（worker 不写）**、tab-finish 完成契约、降级 lane 提示。`config.ts`：读包 config.json 的 `traceFusionLoop` 块（§47 默认值深合并，缺失不致命）。capabilities 补注册 `--trace-run-id/--trace-lane` 旗标（不注册 worker tab 会死于 CLI 解析）+ `traceRunId()/traceLane()` 读取器（flag > env）。meta.json 含 laneDeadlineAt（§24.2 墙钟时限起点）。新增 `_test_trace_fusion_launch.ts`（真实 git 临时仓库 + fake spawner：目录布局/同源三树/同 task 异 lane/workerModel 透传/降级入 prompt/2-3 降级/全失败回滚 failed/preflight 拦截）。register-graph 快照更新（+trace-fusion-loop 命令、+2 旗标）。
- **C5 git 层：synthetic snapshot + worktree manager + provisioning（新目录 `extensions/trace-fusion/`）**：`snapshot.ts` 按 §13–§14 用临时 `GIT_INDEX_FILE`（read-tree HEAD → add -A → write-tree → commit-tree）构造合成 base 提交——折叠 staged/unstaged/untracked（ignored 不进入），不移动用户 ref、不碰用户 index，固定作者身份不依赖用户 git config；落盘 `base/{base-commit.txt,status.txt,snapshot.json}` 三件套；`resolveBaseCommit` 供 §24.1 重启恢复（对象不可解析 → null 降级）。`preflight.ts` 按 §14.2 拒绝非仓库/unborn HEAD/进行中 merge·rebase·cherry-pick/超 maxActiveRuns 的 running run（单 run 互斥，扫 runsDir 下 meta.json）；dirty 工作树不拒绝（正是 snapshot 的折叠对象）。`worktrees.ts`：三 lane 从同一 baseCommit `worktree add --detach`（X_A=X_B=X_C），短路径 `~/.pi/tfl-wt/<run>/`；provisioning（§16.1）junction（Node 原生 symlink 'junction'，Windows 免管理员）/copy/command，失败标 degraded 不致命，报告落 `provision.json`；removal 指数退避重试，仍失败写 `.stale.json` 标记 + prune 兜底（§40.3）。`git.ts` spawnSync 包装 + 固定身份 env；`types.ts` §47 配置类型与默认值。新增 `_test_trace_fusion_git.ts` 真实临时仓库集成测试。
- **trace-worker session profile 接线 + 硬 capability guards（C4）**：工厂注册 `--session-profile` flag（registerCapabilityFlags，与 registerIdentityFlag 同时序约束：工厂内只注册不读值）；subagent-win execute 增加 trace worker 委派硬 guard（只允许 agent=searcher，**agent omitted 拒绝**，覆盖 single/parallel/async 三路径，status 查询放行）；before_agent_start 对 trace worker **early return** 专属注入段（新模块 `trace-worker.ts` buildTraceWorkerSystemPrompt：硬编排边界/执行自由/独立性/GIT 纪律/FINISH 九项终态契约，声明运行时 guard 兜底而非纯 prompt 约束）；resources_discover 对 trace worker 返回空 skillPaths（不见 workflow-orchestrator）；/lite（capabilities().lite）与 /launch（capabilities().launchTabs）增加运行时防护（设计稿 §58/§59：不依赖 factory 阶段注册与否）。新增 `assertDelegationAllowed` 纯函数（白名单 gate，omitted/空串/越权/混合委派全部锁定）+ `_test_trace_worker.ts` + register-graph flag 快照更新（tab-run-id + session-profile）。
- **tab 启动原语抽取（tab-launch-core）**：新增 `extensions/tab-launch-core.ts`——`buildWindowsTerminalArgs`（新增 sessionProfile / traceRunId / traceLane 字段，仅显式传入才发射 `--session-profile` / `--trace-run-id` / `--trace-lane` 旗标）、`wtPromptArg` / `sweepStaleWtPrompts` / `cleanupWtPromptArg` / `sanitizeWtTitle` 及新 spawn 原语 `spawnPiTab`（自 index.ts dispatchPiTab 抽出，TabLaunchOptions/TabSpawnResult 接口化）。依赖方向落地设计稿 §53：workflow prompt builder（launch.ts）与未来 trace worker prompt builder 都只消费 tab-launch-core。launch.ts 保留 workflow 语义层并对原语 re-export，既有导入方零改动；dispatchPiTab 变为 spawnPiTab 薄委托。`_test_launch.ts` 新增 profile 旗标仅显式发射断言。
- **per-call tools allowlist（runner，仅显式传入才生效）**：新增 `extensions/runner-argv.ts`（纯函数 `buildPiArgv`，subagent-core 第一块种子）；`tools` / `excludeTools` 以末位 options 贯通 `runSingle` / `runWithFallback` / `runParallel` / `TaskInput` 与 subagent-win 工具 schema（单个 + tasks 每项）。P2 修订契约：未传时 argv 逐字节不变（不读 agent frontmatter，避免现存 workflow 回归）；显式传入外部 CLI 后端（cli:*）时快速失败而非静默忽略。配套 `_test_runner_tools.ts`（7 组用例：缺省无 --tools、旗标顺序锁定、排他叠加、frontmatter 非硬约束、cli:* 拒绝、清洗去重）与 `npm run test:runner-tools`。
- **会话能力矩阵（capabilities）**：新增 `extensions/capabilities.ts`，定义四类 session profile（main / workflow-tab / trace-worker / subagent）的能力面（workflow / lite / launch-tabs / 角色委派白名单 / timer 编排 / 直接执行）。身份判定沿用 identity 双轨经验：flag `--session-profile`（authoritative，本提交仅注册函数，工厂接线留待 trace-worker 提交）→ env `PI_SESSION_PROFILE` 兜底 → identity 推导。本提交行为零变化：矩阵与 isMainSession/isTabSession/isSubagent 判定完全等价，trace-worker 检测处于休眠态；`index.ts` 两处 launch-tabs 门槛改为 `capabilities().launchTabs`（语义等价替换）。配套 `_test_capabilities.ts`（8 组用例：推导等价、env/flag 优先级、非法值忽略、委派白名单、矩阵快照防漂移）与 `npm run test:capabilities`。

## [Unreleased] — 2026-09-15

### Added
- **lite 轻量工作流模式（/lite on|auto|off）**：中小任务不开 launch-tabs、不用六角色 agent，主会话直接编排单一 `general` agent（新角色卡 `agents/general.md`），按阶段以 `model=` 传档位模型：small（检索/文档）= `models.searcher`、medium（实现/常规计划）= `models.implementer`、large（咨询/修订计划/独立审查）= `models.consultant`（从 config.models 实时投影，无独立配置表）。链路 L1 检索→L2 计划→L3 实现→L4 独立审查（不可省）→L5 文档收尾；上下文纪律：只派 sync/parallel（async status 仅 500 字符预览）、交接默认落盘（>30 行写文件，回复只带路径+≤10 行摘要）、升级线（中转材料 >10K token / fan-out≥3 / 需跨会话存活 → 完整链 tab）。落地：`extensions/lite-mode.ts`（独立模块，纯函数 litePromptLines 生成注入段，off 零注入；deps 注入 config 读写，同 model-presets 约束）、`index.ts` 仅 +7 行接线（import/类型/readConfig×2/configPrompt 注入点/命令注册）、config.json 新键 `liteMode: "off"`、workflow-orchestrator SKILL.md（frontmatter、lite 节、落盘速查行、快捷入口「lite 走一遍」）、`_test_lite_mode.ts`（33 用例：纯函数三态/档位投影/缺模型降级 + 命令注册/写入/状态显示/非法参数）。

## [Unreleased] — 2026-09-06

### Changed
- **直接启动不再自动绑定 workflow**：`/launch -t` 与 `/launch --direct` 只有在用户显式指定 `--research`、`--execute`、`--adaptive`，或在任务文本中使用 `根据...进行工作<taskId>` 前缀时，才附加 workflow 约束；单独出现任务编号不再触发 workflow。普通直接任务保持原始 prompt。

### Added
- **第四种任务模式 adaptive（自适应工作流）**：链深由任务书信息完备度决定，不由仪式感决定（源案例 BidRadar 1030：主会话已给出根因+方案+文件域+验收标准，tab 仍走完整六阶段重复已知信息，耗时翻倍）。`launch-tabs` 传 `mode: "adaptive"`（前缀 `根据adaptive进行工作<taskId>`），tab 启动自评完备度选链深：**A 快链**（四要素齐全：根因/结论+代码位置、方案方向、文件域、可测验收标准）→ 校验性核对（≤3 轮工具调用，codegraph/read/bash 验证假设，禁止重新调研）→ implementer → code-reviewer → Wiki；**B 中链**（缺验收或缺方案）→ planner 微型计划 → plan-reviewer 快审 → implementer → code-reviewer → Wiki；**C 全链**（仅问题描述）→ 同 workflow 六阶段。升降级规则：执行中发现假设失效升档并声明；降级禁止（A 档至少保留码审）；存疑取高档。首轮回复必须声明档位与依据。落地：`launch.ts`（LaunchMode/modePrefix/adaptive 纪律块/taskTitleLabel 前缀过滤/`--adaptive` 旗标解析剥离）、`index.ts`（launch-tabs 工具与 schema 描述、mode 归一化、/launch 文案与 modeHint/modeName、系统提示 Four task modes）、`tab-runs.ts`（账本 mode 校验加 adaptive）、workflow-orchestrator SKILL.md（frontmatter、新增「自适应模式（adaptive）」节含 A0 校验/升降级/模式边界、落盘速查行、快捷入口）、README（四模式表）。`_test_launch.ts` 新增 adaptive 前缀/纪律块/旗标用例。

## [Unreleased] — 2026-08-13

### Added
- External CLI backend `cli:mimo` (MimoCode): resolves `MIMOCODE_BIN`, then `%USERPROFILE%\.mimocode\bin\mimo.exe`, then PATH; runs `mimo run <prompt> --format json --dangerously-skip-permissions --dir <cwd>` and parses its JSON event stream. The CLI's own configured provider/model and credentials remain authoritative.
- External CLI backends: `cli:claude`, `cli:codex`, `cli:agy`, `cli:atomcode`, `cli:zcode` (the latter spawns `node D:\Software\zcode\resources\glm\zcode.cjs -p <prompt> --cwd <cwd>`, plain stdout capture, fixed GLM-5.3)

### Changed
- **派发 tab 多开无用标签页修复（wt 命令行 prompt 物化）**：`wt.exe` 会用自有 tokenizer 重解析命令行——**含换行的参数被拆成多条命令**，剩余行变成标题/内容都是首轮 prompt 残留的无用 tab（实证：workflow 派发几乎必现，因派发 prompt 恒为多行）。新增 `wtPromptArg`：凡含换行/`;`/引号/`%`（wt 的分号命令分隔、引号解析、%env% 展开）的 prompt 一律物化为临时 `@file`（pi 原生 `pi @file.md` 机制读文件内容当首轮消息），wt 命令行上只留一个不含换行的 `@路径`；安全单行 prompt 保持内联零变化。临时文件写入 `~/.pi/agent/launch-prompts/`，5 分钟后自动删除 + 顺带清理 24h 前陈旧文件。接入点：`dispatchPiTab`（launch-tabs 与 /launch 的唯一 wt 派发入口）。`_test_launch.ts` 新增物化/清理/内联用例。
- **派发时强提醒完成回报（tab-finish）**：针对部分子 tab 完成任务后不调 `tab-finish`（停在 waiting/resultMissing，主会话等不到 event-bus 唤醒）——`workflowDisciplineBlock` 的**三种模式**（workflow/research/execute）统一附加「⚠️【完成回报 · 强制】」行：全部工作完成后必须调用 `tab-finish`（status/summary/artifacts/reportPath），不调 = 未完成、主会话会一直等；workflow-orchestrator SKILL.md 同步（核心原则 12 + 阶段 5/R3/E3 收尾各加「回报主会话（强制）」）；`tab-finish` 工具描述也加了「【完成回报 · 强制】你是主会话派发的任务 tab」声明。`_test_launch.ts` 新增三模式均含 tab-finish 提醒的断言。
- **`reclaim-tabs` 移除轮询硬等，永不阻塞**：此前 `wait:true` 会进入 sleep 轮询循环（默认 2 分钟、可被显式拉满 10 分钟）且忽略中止信号（Esc 无法终止），实测会在主会话硬卡数分钟。现在工具**始终立即返回单次快照**（wait/timeoutMs/intervalMs 降为废弃 no-op 参数仅保向后兼容），完成感知完全交给 event-bus（子 tab 写 result.json 自动唤醒主会话），编排巡检用 set-timer。删除了 `RECLAIM_*` 常量和不再使用的 `sleep()`。README §5.1 同步更新。
- **timer 基建加固（三方评估后落地的 P1/P2）**：
  - 投递改 **at-least-once**：`fireOneTimer` 先 `sendUserMessage` 成功才落账（one-shot 置 fired / repeat 重置 pending），send 失败保持 pending 下个 tick 自动重试——原实现先置 fired 再 send，失败即永久丢消息。
  - **所有权门槛加会话活性**：`rootTimerConsumable` 现在同时比对 `ownerCwd` 与 `ownerSessionId`——owner 心跳存活时只有 owner 自己可消费（同 cwd 多主会话防双发）；owner 失活（心跳缺失/超宽限）其他同目录会话可接手（保留重启接管耐久性）。新增 `timers/sessions/<id>.json` 心跳，调度器每 tick 刷新，宽限 15s。
  - **终态 GC**：`sweepTerminalTimers` 清理超过 24h 的 fired/cancelled/missed 文件；`sweepStaleHeartbeats` 清理失活心跳。调度器每 12 tick（≈60s）执行一次，账本不再无限膨胀。
  - **tick 连续失败报警**：连续 3 次 tick 异常向会话注入报警消息（不再静默吞掉）。
  - **路径注入防护**：`timerId`/`tabRunId` 须匹配 `SAFE_ID_PART`（拒绝 `../`、`/` 等危险组件），`listTimerFiles` 同步过滤。
  - **容量措辞修正**：set-timer 描述改为「每个目标（self 或单个 tab 邮箱）最多 50 个 pending」。
  - `registerTimers` 增加可选 `opts.timersDir`（测试可注入目录）。
- **回归测试**：`_test_timers.ts` 新增心跳/所有权门槛/终态 GC/路径安全用例；`_test_timers_runtime.ts` 新增「投递失败重试（at-least-once）」与「registerTimers 注册的 set/list/cancel 工具 + /timers 命令实际执行」用例（覆盖 isSubagentProcess 类闭包漏定义）；`_test_tab_runs_runtime.ts` 同步 reclaim-tabs 非阻塞语义。

### Fixed
- **event-bus 完成消息投错会话（溯源路由缺失）**：tab 完成时 event-bus 的唤醒权是「任意 identityless 进程 claimNotified 先到先得」——多个主会话形态的 pi 进程（不同目录/同一目录不同会话）同时 watch，谁先抢到就把「⏱ Tab 已完成」注入**自己**，真正派发该 tab 的编排会话收不到回报（实证：GreenCAD 编排会话 019ff8b4 派发的 275-280 完成消息全部落到无关的 Annacomnena 会话 019ff89d）。修复：`onTabResultFile` 在 claim 前先按 `links.jsonl` 溯源（`recipientSessionIdFor`，与 report.ts 0.2.2 同一模式）——只注入给派发该 tab 的会话；其他会话静默跳过（不 claim/不 toast/不注入），把唤醒权留给真正的编排会话；溯源解析不到（旧账本无 sessionId）时回退 claim 先到先得。`registerEventBus` 的 session_start 同步捕获本会话 UUID。`_test_event_bus.ts` 新增会话定位回归（非派发会话跳过 / 派发会话注入 / 无溯源回退）。
- **`set-timer` / `cancel-timer` / `list-timers` / `/timers` 全部抛 `isSubagentProcess is not defined`**：`timers-runtime.ts` 在 4 处引用了 `isSubagentProcess` 但从未定义/导入（`tab-runs-runtime.ts` 有 `const isSubagentProcess = isSubagent()`，timers 文件漏了），导致计时器整套工具在运行期直接崩溃。在 `registerTimers()` 开头补齐与 tab-runs-runtime 一致的定义。

## [0.2.2] — 2026-08-11

### Fixed
- **Timer / report 投错对话（身份隔离）**：此前任何无 `--tab-run-id` 的 pi 进程（不同目录的主会话、直开标签页、手动打开的 pi 窗口）都被当作"主会话"，会抢 `~/.pi/agent/timers/*.json` 的 self timer 和 `~/.pi/agent/reports/*.json` 的回报，导致编排消息/任务回报落到无关目录的会话（实证：233 重复 timer 同秒双发、task 238 回报投到 subagent-win 会话）。
  - `set-timer` 的 self timer 记录 `ownerCwd`（+ `ownerSessionId`）；identityless 进程只消费 `ownerCwd == 自己 cwd` 的 root timer，旧账本（无 ownerCwd）一律不消费（宁可静默不投错）；repeat 消费时重新盖章 `ownerSessionId`（重启后同目录新会话可接手）。
  - 标签页内 `target=self` 的 timer 现在写入**自己的邮箱**（此前写根目录被主会话抢走）；标签页的 `cancel-timer` / `list-timers` 缺省也指向自己邮箱。
  - `tab-report` 回报按派发溯源（links.jsonl：tab runId → 派发会话 UUID）定位接收方，只有派发该 tab 的会话消费；其他 identityless 进程不再抢（`.notified` 仍做跨实例去重）。
  - `/launch` 直开标签页也注入 runId + 派发账本（`direct: true`），不再是无身份进程（可正常用 tab-report、不抢 root timer）。

## [0.2.1] — 2025-08-05

### Added
- Consultant agent: user-named model evaluation / screenshot design (`agent="consultant"`)
- `/launch` command: workflow orchestration with visible Windows Terminal tabs
  - `--research` / `-r` mode: deep research only (parallel searchers → research report → Wiki maintenance)
  - `--execute` / `-e` mode: quick execute (skip search/planning → implement → review → Wiki wrap-up)
- `launch-tabs` tool: parallel tab launch with normalized workflow prompts and discipline blocks
- `wiki-nav` tool: progressive Wiki navigation (tree / around / find / keywords / path / rebuild)
- `wiki-semantic` extension: optional remote embedding with local USearch HNSW term expansion
- `notify-windows` extension: Windows Toast notifications for subagent events
- `codex-headers` extension: per-provider Codex request-header compat (`originator`, `User-Agent`, `OAI-Product-Sku`)
- External CLI backends: `cli:claude`, `cli:codex`, `cli:agy`, `cli:atomcode`
- WinINET proxy bridge for external CLI child processes on Windows
- `searchableSelect` TUI component: fuzzy-filtered model picker for large lists

### Changed
- Fallback chain now surfaces `priorFailures` with structured `USAGE_CAP` / `RATE_LIMIT` / `AUTH` / `PROVIDER` / `TIMEOUT` / `OTHER` classification
- Zhipu/GLM bare HTTP 429 treated as `USAGE_CAP` (package quota exhaustion) rather than rate-limit
- Tab title naming: `<repo>[-worktree]-[<taskId>-]<label>`, no meaningless `wlc` defaults
- `buildWorkflowTabPrompt` supports three modes: `workflow`, `research`, `execute`

### Fixed
- `mergeProviderError` prioritizes quota/usage-cap wording from stderr
- `pickBestAssistantText` prefers structured final answers over short tool-use narration
- `collectMainSessionUsage` parses JSONL timestamps directly (file names/mtimes are not reliable)

## [0.1.7] — 2025-07-30

### Added
- `USAGE_CAP` failure classification: surfaces Zhipu/GLM package quota exhaustion as a distinct retryable failure kind
- Main-agent guidance: when `USAGE_CAP` is detected, instructs the main agent to switch model via `/model` instead of retrying

### Changed
- `formatFailureForMainAgent` now includes explicit `ACTION_REQUIRED` instructions for usage-cap and provider failures
- Fallback chain UI: TUI shows `↺fallback×N` badge and per-attempt failure details

## [0.1.6] — 2025-07-24

### Added
- `codex-headers` extension: per-provider Codex header compat (`originator`, `User-Agent`, `OAI-Product-Sku`)
- `before_provider_headers` event handler + `globalThis.fetch` wrap for wire-level header rewrite
- `/codex-headers` command with interactive TUI menu and text mode

### Changed
- `package.json` description updated to reflect Codex header compat feature

## [0.1.5] — 2025-07-23

### Added
- Initial release: subagent-win v0.1.5
- Core subagent execution: single, parallel, async modes
- Role agents: searcher, planner, plan-reviewer, implementer, code-reviewer
- Per-call model override with short alias expansion from `~/.pi/agent/models.json`
- Smart fallback chain with retryable failure classification
- Timeout handling with partial output preservation
- TUI integration with rich rendering of calls and results
- Usage tracking: per-agent daily token/cost logging
- `/today-usage` command: aggregates all sessions + subagent runs
- `/sub-models` command: interactive model/fallback/thinking config
- `workflow-orchestrator` skill: multi-step workflow orchestration (search → plan → review → implement → review → Wiki wrap-up)
- Windows Toast notifications via `/notify` command