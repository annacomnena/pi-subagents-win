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
// E2.0：carrier 闸口口径单一真相源（type-only，不引入运行时依赖，保持 types.ts 零 IO）。
import type { GateStatus } from "../frontier-carriers.ts";

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
	/** E2.0 carrier（只读引用共享 `reduceTabCarrier` 结论；缺 → null，**不猜**）。 */
	gate?: GateStatus | null;
	needsHuman?: boolean | null;
	staleOver?: boolean | null;
	overdue?: number | null;
	/** state.pid + process.kill 探活；无 state.pid → null。 */
	pidAlive?: boolean | null;
}

/** E2.0：单 run 的 carrier 输入（collect 层用共享归约填充；缺 → GraphRunRef 对应字段 null）。 */
export interface GraphRunCarrier {
	gate: GateStatus;
	needsHuman: boolean;
	staleOver: boolean;
	overdue: number;
	pidAlive: boolean | null;
}

/**
 * ⑧ 期望账本 open 期望的只读引用（collect 层 `listOpenExpectations` 装配；缺 → 无 next_expected_event）。
 * 纯投影输入：不写账本、不消费；project 为 null（未归因 / mailbox: 键）→ 不映射任何 project 节点。
 */
export interface GraphExpectationRef {
	/** 归一化 repoPath（normalizeRepoKey 口径，同 normalizeExactPath）；未归因 → null。 */
	project: string | null;
	/** 预期回信 kind（→ project 节点 `nextExpectedEventType`）。 */
	expectedType: string;
	/** deadline（epoch ms；→ project 节点 `nextExpectedEventDeadline`）。 */
	deadlineAt: number;
	/** 请求主键（审计溯源，不参与语义比较）。 */
	requestId: string;
}

export interface GraphProjectView {
	/** 归一化 repoPath（normalizeRepoKey 口径，同 recent-scopes normalizeExactPath）。 */
	project: string;
	attention: number;
	runs: GraphRunRef[];
}

export interface GraphSnapshot {
	version: 2;
	/** journal 最后有效 seq（diff 游标）。 */
	headSeq: number;
	logEpoch: string;
	/** 按 id 升序（确定性）。 */
	nodes: GraphNode[];
	/** 按 kind,from,to 升序（确定性）。 */
	edges: GraphEdge[];
	/** 按 project 升序（E2 翻转输入）。 */
	projects: GraphProjectView[];
	/**
	 * E2.0 观测载体（**不参与 frontier 输入**：E2.1 `toFrontierInput` 恒 emit []，MF1）。
	 * hidden tab 的 id/reason，按 id 升序；缺省不发出（保持 E1 快照形状向后兼容）。
	 */
	history?: { id: string; reason: string }[];
	/** E2.0 诊断时间戳（ms）；缺省不发出。 */
	asof?: number;
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
	/** subject（run://tab/<id>）→ carrier（只读引用共享归约，可选；缺 → 对应字段 null）。 */
	runCarriers?: Record<string, GraphRunCarrier>;
	/** ⑧ 期望账本 open 期望（只读引用；可选；缺 → project 节点无 next_expected_event 字段值）。 */
	openExpectations?: GraphExpectationRef[];
	/** hidden tab 观测载体的原始输入（project 层纯透传；**不参与 frontier 输入**）。 */
	history?: { id: string; reason: string }[];
	/** 诊断时间戳（ms）；缺省不发出。 */
	asof?: number;
}

// ── 冻结常量 ───────────────────────────────────────────────────────

export const GRAPH_SNAPSHOT_VERSION = 2 as const;

/** Graph 认识的 journal 事件词表 = projector.ts 冻结的 run 五型（L1 §1）。 */
export const GRAPH_RUN_EVENT_TYPES: readonly string[] = [
	"run.dispatched",
	"run.launch_failed",
	"run.completed",
	"run.failed",
	"run.cancelled",
];

/**
 * ⑧ 期望事件词表（v2-b 三型；`expectations.ts` 常量同体）：进 Graph 词表 → 不记
 * `skipped.unknownEventTypes`（前向兼容改为「已知项目级事件」）。仅识别不产 run 节点
 *（非 run:// 寻址）；project 节点 `nextExpectedEvent*` 由 `openExpectations`（账本）装配。
 */
export const GRAPH_EXPECTED_EVENT_TYPES: readonly string[] = [
	"project.expected_event_set",
	"project.expected_event_arrived",
	"project.expected_event_timeout",
];

/** terminal 优先不回退的状态（projector.ts#L153-L155 同口径）。 */
export const GRAPH_TERMINAL_RUN_STATUSES: readonly RuntimeRunStatus[] = ["completed", "failed", "cancelled"];

export const GRAPH_DEFAULT_MASTERS: readonly { id: string }[] = [{ id: "master_default" }];
