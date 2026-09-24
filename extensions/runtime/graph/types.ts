/**
 * graph/types.ts — E1 只读关系面 MVP：类型 + 冻结常量（零 IO）。
 *
 * 计划：plans/0924_graph_E1_impl_plan.md §3；L1 校准：plans/0924_graph_E1_recon.md §1/§7。
 * 定位：Graph = journal + workstreams 显式库 + tab-runs 账本只读引用的**确定性只读投影**
 * （影子模式：零生产消费者；类型层无任何 writer——不改写 Task/Run 运行态，F18/§6A）。
 *
 * 纯类型/常量文件：不 import node:fs、不读时间、不用随机（同上层的纯度纪律）。
 */

import type { JournalSeqEntry } from "../journal-seq.ts";
import type { RuntimeRunStatus, TaskRecord, WorkstreamRecord } from "../objects.ts";

// ── 节点 / 边 ──────────────────────────────────────────────────────

export type GraphNodeKind = "master" | "workstream" | "task" | "run" | "project";

export interface GraphNode {
	/** master_default | ws_* | task_* | run://tab/* | project:<normalizedRepoPath> */
	id: string;
	kind: GraphNodeKind;
	/** mission / objective / subject / repoPath（只读引用，不派生新语义）。 */
	label: string;
	/** 原样引用既有词表（Run=journal 投影，Task/Workstream=JSON 字段）；不派生、不写回。 */
	status: string | null;
	/** 稳定标量（JSON 可比较）；不放 age/stale 之类墙钟展示文本。 */
	attrs: Record<string, string | number | boolean | null>;
	/** 首次出现 seq；0 = 非 journal 源（workstreams/tasks/registry）。 */
	firstSeq: number;
	lastSeq: number;
}

/** 仅引用式边（从既有载体派生）；**不含**声明式 depends_on/blocks/requires（零载体零生产者）。 */
export type GraphEdgeKind =
	| "task_workstream"
	| "run_task"
	| "run_workstream"
	| "run_subject"
	| "workstream_project";

export interface GraphEdge {
	kind: GraphEdgeKind;
	from: string;
	to: string;
	/** 溯源：载体 file#L + 字段值（可诊断，不参与语义比较）。 */
	evidence: string;
	/** F18 best-effort 标注：runSubject 精确匹配 / externalTaskId label 匹配。 */
	match?: "runSubject" | "externalTaskId";
}

// ── 只读运行视图 / 项目视图（E2 单点翻转契约，§5）─────────────────

export interface GraphRunRef {
	/** tab 账本 runId（run://tab/<id> 去前缀）；无账本 id 时回退 subject。 */
	runId: string;
	/** 主键：run://tab/<tabRunId>（envelope.subject 原样）。 */
	subject: string;
	status: RuntimeRunStatus;
	/** tab-runs composeTabStatus 结论原样（只读引用；缺 → null，不猜）。 */
	phase: string | null;
	externalTaskId?: string;
	/** 归一化 repoPath（tab-runs 账本引用）；无法归属 → null。 */
	project: string | null;
}

export interface GraphProjectView {
	/** 归一化 repoPath（normalizeRepoKey 口径，同 recent-scopes normalizeExactPath）。 */
	project: string;
	attention: number;
	runs: GraphRunRef[];
}

export interface GraphSnapshot {
	version: 1;
	/** journal 最后有效 seq（diff 游标）。 */
	headSeq: number;
	logEpoch: string;
	/** 按 id 升序（确定性）。 */
	nodes: GraphNode[];
	/** 按 kind,from,to 升序（确定性）。 */
	edges: GraphEdge[];
	/** 按 project 升序（E2 翻转输入）。 */
	projects: GraphProjectView[];
	skipped: { badLines: number; unknownEventTypes: string[] };
}

export interface GraphDiff {
	sinceSeq: number;
	headSeq: number;
	addedNodes: GraphNode[];
	removedNodes: string[];
	changedNodes: GraphNode[];
	addedEdges: GraphEdge[];
	removedEdges: GraphEdge[];
}

// ── 复合输入（L1 发现 2：Task/Workstream 不在 journal，必须显式库另读）──

export interface GraphInput {
	/** scanJournalSeq 产物（seq 单调；排序在 projectGraph 内兜底）。 */
	journal: JournalSeqEntry[];
	logEpoch?: string;
	headSeq?: number;
	badLines?: number;
	/** registry 只读引用（缺省 [master_default]：Phase 1 单例 master）。 */
	masters?: { id: string }[];
	workstreams: Pick<WorkstreamRecord, "id" | "mission" | "status" | "workspaceRef" | "taskSelector">[];
	tasks: Pick<TaskRecord, "id" | "workstreamId" | "externalTaskId" | "objective" | "status">[];
	/** subject → phase（tab-runs composeTabStatus 只读引用，可选）。 */
	runPhases?: Record<string, string>;
	/** subject → repoPath（tab-runs 账本引用，可选；E1 收集层填 findRepoRoot(cwd)）。 */
	runProjects?: Record<string, string>;
	/** 归一化 repoPath → attention（只读引用，可选）。 */
	projectAttention?: Record<string, number>;
}

// ── 冻结常量 ───────────────────────────────────────────────────────

export const GRAPH_SNAPSHOT_VERSION = 1 as const;

/** Graph 认识的 journal 事件词表 = projector.ts 冻结的 run 五型（L1 §1）。 */
export const GRAPH_RUN_EVENT_TYPES: readonly string[] = [
	"run.dispatched",
	"run.launch_failed",
	"run.completed",
	"run.failed",
	"run.cancelled",
];

/** terminal 优先不回退的状态（projector.ts#L153-L155 同口径）。 */
export const GRAPH_TERMINAL_RUN_STATUSES: readonly RuntimeRunStatus[] = ["completed", "failed", "cancelled"];

export const GRAPH_DEFAULT_MASTERS: readonly { id: string }[] = [{ id: "master_default" }];
