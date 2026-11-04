/**
 * trace-fusion/types.ts — 共享类型与默认值（trace-fusion C5）
 *
 * 设计稿 §47（config）、§15（布局）、§24.1（run 持久化契约）。
 * 只放类型与纯默认值；任何 I/O 都在兄弟模块。
 */

export type LaneId = "A" | "B" | "C";

export const TRACE_LANES: readonly LaneId[] = ["A", "B", "C"] as const;

/** 单条 lane 的 worktree 供给配置（设计稿 §16.1/§47）。 */
export interface TraceFusionProvisioning {
	/** junction 到主树的目录名（如 node_modules）；Windows mklink /J 语义，无管理员。 */
	junction: string[];
	/** 从主树复制的小文件（如 .env）。 */
	copy: string[];
	/** 兜底自定义 setup 命令（在每个 worktree 内执行）；空串 = 不执行。 */
	command: string;
}

/** traceFusionLoop 配置块（设计稿 §47；存于 subagent-win config.json）。 */
/** traceFusionLoop 配置块（设计稿 §47；存于 subagent-win config.json）。 */
export interface TraceFusionConfig {
	/**
	 * run 模式（真实运行驱动，2026-09-17）：
	 *   diagnose（默认）— lane 只读诊断主仓库，产出诊断+方案；零 worktree、零磁盘代价；
	 *   implement — lane 在独立 worktree 内实现+构建+测试（12GB/轮级，真实验证证据，opt-in）。
	 */
	mode?: "diagnose" | "implement";
	workerModel?: string;
	/** per-lane worker 模型（2026-10-30）：lane → `provider/id`；未设的 lane 回落到 workerModel。 */
	workerModelByLane?: Partial<Record<LaneId, string>>;
	fusionModel?: string;
	consultMode: "auto" | "always" | "never";
	consultModel?: string;
	finalizerModel?: string;
	maxRounds: number;
	maxConsultations: number;
	maxTargetedProbes: number;
	/** 单 lane 墙钟时限（分钟，§24.2），超时判 failed 走 2/3 降级。 */
	maxWallClockPerLaneMin: number;
	finalizerStallTimeoutMin: number;
	/** v1 同时允许的 active run 数。 */
	maxActiveRuns: number;
	/**
	 * 并行度（treats KV 共享池约束，2026-10-30）——决定同时派发几条 lane。
	 * 背景：服务端 KV 池是**所有 slot 共享的**（本机实测 nl_ctx 名义 262144/slot，
	 * 实际可用池 ~204800），三路并发在中等任务上必然撞池（第三条会裸 fetch failed）。
	 * 1 = 严格串行（只在前一条 lane 终态后才派下一条）；2 = 双路并发；3 = 三路全并发（原行为）。
	 * 缺省 3 = **与今天逐字节一致**（不改变存量用户行为）。
	 */
	laneConcurrency?: 1 | 2 | 3;
	/**
	 * 盘根递归扫描（R-13）机械门是否**也作于主会话/普通会话**（2026-11-04）。
	 * 背景：R-13 事故的发起者就是主会话自己（一条无超时的 `find /` 挂 2.7h、699 万句柄）。
	 * 本门只拦「递归命令 + 盘根/家目录目标」单一形状，仓库内搜索零影响。
	 * 缺省 true；显式设 false 可关（关掉后仅 lane/融合会话受约束）。
	 */
	guardMainRootScan?: boolean;
	/**
	 * 「跑完一个删一个」（2026-11-04 用户批准）：lane 自报终态 ⇒ 先收该 lane 产物
	 * （patch.diff / status.txt 都来自 worktree）⇒ 收集成功才回收该树。
	 * 缺省 true；false 回到旧的「run 终态后手动 /trace-fusion-clean」行为。
	 */
	reclaimLaneWorktree?: boolean;
	provisioning: TraceFusionProvisioning;
}

export const DEFAULT_TRACE_FUSION_CONFIG: TraceFusionConfig = {
	mode: "diagnose",
	consultMode: "auto",
	maxRounds: 2,
	maxConsultations: 1,
	maxTargetedProbes: 2,
	maxWallClockPerLaneMin: 45,
	finalizerStallTimeoutMin: 30,
	maxActiveRuns: 1,
	// 缺省 3 = 保持历史全并发行为；本机共享 KV 池场景应显式设为 1 或 2。
	laneConcurrency: 3,
	// 盘根递归扫描门默认也管主会话（R-13 事故发起者就是主会话）
	guardMainRootScan: true,
	// 跑完一个删一个（缺省开）：lane 终态即回收其 worktree，不必等 run 结束手动 clean
	reclaimLaneWorktree: true,
	provisioning: {
		junction: ["node_modules"],
		copy: [".env", ".env.local"],
		command: "",
	},
};

/** run 生命周期状态（meta.json / status 命令消费）。 */
export type TraceRunStatus = "running" | "collecting" | "fusing" | "completed" | "failed" | "cancelled";

/** run 的 cancelled/failed 附加说明（自动回收/人工取消/清理时写入 meta.json）。 */
export type TraceRunMetaExtra = { cancelledReason?: string; cleanedAt?: string };

/** diagnose 模式的启动时工作树基线（collect 时对比，确定性检 lane 是否违规写主仓库）。 */
export type DiagnoseMetaExtra = { dirtyBaselineFile?: string };

/** artifact 根：~/.pi/agent/trace-fusion-runs/<runId>/（§15：artifact 可放长路径）。
 *
 * 测试/隔离旁路（计划 D6）：`PI_TRACE_FUSION_RUNS_DIR` 指向临时根，避免测试往用户真实目录
 * 写 run（否则 `maxActiveRuns=1` 会与线上 running run 互斥）。未设 ⇒ 与今天逐字节一致。
 */
export function defaultRunsDir(): string {
	const override = (process.env.PI_TRACE_FUSION_RUNS_DIR ?? "").trim();
	if (override) return override;
	return join(homedir(), ".pi", "agent", "trace-fusion-runs");
}

/** worktree 根：~/.pi/tfl-wt/<shortRunId>/（§15：Windows 路径要尽量短）。 */
export function defaultWorktreeRoot(): string {
	return join(homedir(), ".pi", "tfl-wt");
}

/**
 * lane 产物白名单（2026-11-03 tfl-20261103-192444-c7e2 首跑驱动）。
 *
 * 事故：lane 目录里的**非契约文件**（如 lane 自己写的分析笔记/测试产物）在收集侧
 * 逐字沉默——collect 只查 trajectory.md / validation.json 的存在性，从不枚举 laneDir，
 * 而 diagnose 模式的 `diagnoseDirtyViolations` 只对比**主仓** porcelain 基线，覆盖不到
 * `lanes/<lane>/` ⇒ stray 文件既不进 cross-test 报告也不进 issues（首跑 lanes/A 实测：
 * 只有 supervisor 自产的 patch.diff/status.txt/result.json；上一轮 c2f5 的 lane A 曾有
 * 402B 的 triangle.md 混在产物里无人识别）。
 *
 * 白名单必须含 **supervisor 自产文件**（patch.diff / status.txt / result.json）与
 * `archiveUntracked` 产出的 `untracked.md` / `untracked/`，否则收集器会把自己写的文件
 * 判成 lane 违规（假阳）。
 *
 * 两个消费方：`artifacts.ts`（收集侧 stray 检查）与 `citation-check.ts`（行号越界判定）
 * ⇒ 共享常量放 types.ts，禁止两处各自硬写名单。
 */
export const LANE_ARTIFACT_NAMES: ReadonlySet<string> = new Set([
	"trajectory.md",
	"validation.json",
	"patch.diff",
	"status.txt",
	"result.json",
	"untracked.md",
	// 2026-11-04 L4 必修（B-1）：**supervisor 自产文件全部要进名单**，否则收集器把自产文件
	// 判成 lane 违规（假阳）。实测分母：34 个 lane 目录里 6 个已被误判（全是 `provision*`），
	// 真 stray 只有 1 个。写盘点：`worktrees.ts:40` 写 `provision.json`（launch 阶段）、
	// `cross-test.ts:329` 写 `provision-eval.json`（implement 分支）。
	"provision.json",
	"provision-eval.json",
	// 2026-11-04「跑完一个删一个」：收集器自产，记首次收集的 changedFiles/testFiles
	// （worktree 回收后的二次收集靠它沿用，不得被当成 lane 契约外文件）
	"collect-manifest.json",
]);

/** lane 目录内允许存在的**目录**（supervisor 归档产物）；目录名的白名单单独维护。 */
export const LANE_ARTIFACT_DIRS: ReadonlySet<string> = new Set(["untracked"]);

import { join } from "node:path";
import { homedir } from "node:os";

// 2026-11-04 L4 类型收口：lane/run 元数据的**规范定义在本文件**（此前定义在 launch-workers.ts，
// 而 6 个模块从本文件 import 这两个类型 ⇒ TS2305）。
import type { ProvisionReport } from "./worktrees.ts";

export interface TraceLaneMeta {
	lane: LaneId;
	worktree: string;
	tabRunId: string;
	provision: ProvisionReport;
	/**
	 * lane 参与状态（2026-11-02，状态机修复）。
	 *
	 * 起因：supervisor 原来**固定等 A/B/C 三份 result.json**，而被 skip 的 lane /
	 * spawn 失败的 lane 根本没有 tabRunId ⇒ `done` 永远 < 3 ⇒ **永不自动收集**，
	 * run 停在 `running` 占住 `active-run-mutex` ⇒ 一次 wt.exe 启动失败就能锁死 trace-fusion。
	 * 宣称的「2/3 降级」在代码里根本不可达。
	 *
	 * 收集判据改为「**预期参与的 lane 集合**」：`skipped` / `dispatch-failed` 是一等终态，
	 * 不进分母。缺省（字段缺失的旧 meta）= `active` ⇒ 零回归。
	 */
	laneStatus?: "active" | "skipped" | "dispatch-failed";
	laneStatusReason?: string;
	/** §29.6 供给失败时的降级原因（与 provision.issues 同源；进 meta 让下游可见）。 */
	degradedReason?: string;
	/** 跑完一个删一个：本 lane worktree 已回收的时刻（产物已先收，见 worktree-reclaim.ts）。 */
	worktreeReclaimedAt?: string;
}

export interface TraceRunMeta {
	runId: string;
	shortId: string;
	status: "running";
	/** run 模式（2026-09-17）：diagnose 只读诊断（默认）| implement worktree 读写实现。 */
	mode: "diagnose" | "implement";
	task: string;
	repoRoot: string;
	createdAt: string;
	baseCommit: string;
	headBefore: string;
	runDir: string;
	/** worktree 根目录；diagnose 模式为空串（不开 worktree）。 */
	wtDir: string;
	laneWallClockMin: number;
	laneDeadlineAt: string;
	lanes: Record<LaneId, TraceLaneMeta>;
	/** diagnose 模式：启动时主仓库 porcelain 基线文件路径（collect 时对比检违规写入）。 */
	dirtyBaselineFile?: string;
	/**
	 * 派发者会话指纹（2026-11-02）：`sessionScopeKey()` 的返回值（tab runId 优先，否则持久 UUID）。
	 *
	 * 修缺陷：`isMainSession()` 让**所有**非 tab 会话都 watch 同一个全局 `tab-runs/`，
	 * 而 meta 里没有任何字段能判定「这个 run 是谁派的」，且 lane tab 不进 `links.jsonl`
	 * ⇒ event-bus 的 `recipient` 恒 undefined ⇒ `isDispatcher` 恒 false ⇒ fencing 全部走
	 * legacy 无归属兜底 ⇒ 跨会话重复通知（实测 a726 两路会话各收一份、单会话内重复 3 次）。
	 * 写入后由 `isDispatcherSession(meta)` 用于过滤，不新造机制。
	 * 旧的 meta（字段缺失）一律当作「无归属」→ 保持 legacy 行为（零回归）。
	 */
	dispatcherSessionId?: string;
}

