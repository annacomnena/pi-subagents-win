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
]);

/** lane 目录内允许存在的**目录**（supervisor 归档产物）；目录名的白名单单独维护。 */
export const LANE_ARTIFACT_DIRS: ReadonlySet<string> = new Set(["untracked"]);

import { join } from "node:path";
import { homedir } from "node:os";
