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
export interface TraceFusionConfig {
	workerModel?: string;
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
	provisioning: TraceFusionProvisioning;
}

export const DEFAULT_TRACE_FUSION_CONFIG: TraceFusionConfig = {
	consultMode: "auto",
	maxRounds: 2,
	maxConsultations: 1,
	maxTargetedProbes: 2,
	maxWallClockPerLaneMin: 45,
	finalizerStallTimeoutMin: 30,
	maxActiveRuns: 1,
	provisioning: {
		junction: ["node_modules"],
		copy: [".env", ".env.local"],
		command: "",
	},
};

/** run 生命周期状态（meta.json / status 命令消费）。 */
export type TraceRunStatus = "running" | "collecting" | "fusing" | "completed" | "failed" | "cancelled";

/** run 的 cancelled/failed 附加说明（自动回收/人工取消时写入 meta.json）。 */
export type TraceRunMetaExtra = { cancelledReason?: string };

/** artifact 根：~/.pi/agent/trace-fusion-runs/<runId>/（§15：artifact 可放长路径）。 */
export function defaultRunsDir(): string {
	return join(homedir(), ".pi", "agent", "trace-fusion-runs");
}

/** worktree 根：~/.pi/tfl-wt/<shortRunId>/（§15：Windows 路径要尽量短）。 */
export function defaultWorktreeRoot(): string {
	return join(homedir(), ".pi", "tfl-wt");
}

import { join } from "node:path";
import { homedir } from "node:os";
