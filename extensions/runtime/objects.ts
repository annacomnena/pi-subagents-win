/**
 * runtime/objects.ts — Persistent Object Model v1（Phase 1B，设计稿 §6）
 *
 * 四个逻辑对象：Master / Workstream / Task / Run。
 *
 * 原则（设计稿 §2/§6）：
 *   - 物理身份（sessionId / pid / tabRunId）≠ 逻辑身份（本模块的 id）。
 *     物理承载只允许出现在 RunRecord.physical，且全部可选。
 *   - 现有外派 taskId（workflow 编号 / 用户标识）语义不动，
 *     通过 TaskRecord.externalTaskId 桥接（§2.3 / §6.3）。
 *   - 只保留稳定跨后端的最小公共字段，不强制一次映射全部现有字段（§6.4）。
 *   - Phase 1 只定义类型与状态词表，不实现任何 behavior（§6.2）。
 */

import type { MasterId, RunId, TaskId, WorkstreamId } from "./ids.ts";

// ── Master（§6.1）──────────────────────────────────────────────────

export interface MasterRecord {
	version: 1;
	kind: "master";

	id: MasterId;

	createdAt: string;
	updatedAt: string;
}

// ── Workstream（§6.2）──────────────────────────────────────────────

export type WorkstreamStatus = "active" | "waiting" | "blocked" | "paused" | "completed" | "failed";

export interface WorkstreamRecord {
	version: 1;
	kind: "workstream";

	id: WorkstreamId;
	masterId: MasterId;

	mission: string;
	status: WorkstreamStatus;

	/** 指向 workspace 的引用（Logical Address 或文件路径），Phase 1 不解释。 */
	workspaceRef?: string;

	createdAt: string;
	updatedAt: string;
}

// ── Task（§6.3）────────────────────────────────────────────────────

export type RuntimeTaskStatus = "pending" | "running" | "waiting" | "blocked" | "completed" | "failed" | "cancelled";

export interface TaskRecord {
	version: 1;
	kind: "task";

	id: TaskId;

	workstreamId?: WorkstreamId;

	/** 桥接现有 TabDispatchRecord.taskId（workflow 编号 / 用户标识），语义不改名（§2.3）。 */
	externalTaskId?: string;

	objective: string;

	status: RuntimeTaskStatus;

	createdAt: string;
	updatedAt: string;
}

// ── Run（§6.4）─────────────────────────────────────────────────────

export type ExecutionKind = "main" | "tab" | "subagent" | "trace-lane" | "fusion" | "external-cli";

export type RuntimeRunStatus =
	| "created"
	| "dispatched"
	| "running"
	| "waiting"
	| "completed"
	| "failed"
	| "cancelled"
	| "orphaned";

export interface RunRecord {
	version: 1;
	kind: "run";

	id: RunId;

	taskId?: TaskId;
	parentRunId?: RunId;

	executionKind: ExecutionKind;

	/** 物理承载（全部可选；物理身份漂移不改变 Run 的逻辑身份）。 */
	physical?: {
		sessionId?: string;
		pid?: number;
		tabRunId?: string;
	};

	/** session profile（main / workflow-tab / trace-worker / subagent），Phase 1 仅记录。 */
	profile?: string;

	status: RuntimeRunStatus;

	createdAt: string;
	updatedAt: string;
}

// ── 状态词表（运行时常量，供 journal / 后续 projector 校验用）──────

export const WORKSTREAM_STATUSES: readonly WorkstreamStatus[] = [
	"active",
	"waiting",
	"blocked",
	"paused",
	"completed",
	"failed",
];

export const RUNTIME_TASK_STATUSES: readonly RuntimeTaskStatus[] = [
	"pending",
	"running",
	"waiting",
	"blocked",
	"completed",
	"failed",
	"cancelled",
];

export const EXECUTION_KINDS: readonly ExecutionKind[] = [
	"main",
	"tab",
	"subagent",
	"trace-lane",
	"fusion",
	"external-cli",
];

export const RUNTIME_RUN_STATUSES: readonly RuntimeRunStatus[] = [
	"created",
	"dispatched",
	"running",
	"waiting",
	"completed",
	"failed",
	"cancelled",
	"orphaned",
];
