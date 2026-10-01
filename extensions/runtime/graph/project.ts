/**
 * graph/project.ts — E1 纯投影 projectGraph(input)（零 IO、同输入同输出）。
 *
 * 计划 §4：
 *   1) Run upsert 镜像 projector.ts 冻结语义（dedupeKey 幂等、terminal 优先不回退、
 *      未知 type 记 skipped.unknownEventTypes 不抛、subject 非 run:// 忽略）；
 *   2) Master/Workstream/Task 来自显式输入（非 journal 源，firstSeq/lastSeq=0）；
 *   3) Project 节点 = 归一化 repoPath 别名（runProjects 账本 / workspaceRef 弱载体 / attention 键）；
 *   4) 边由 edges.ts::deriveEdges 派生（引用式）；
 *   5) 输出全排序后冻结（只读投影，类型层无 writer）。
 *
 * 纯度：不 import node:fs、不读时间、不用随机。
 */

import type { RuntimeRunStatus } from "../objects.ts";
import { cmp, deriveEdges, isPathShapedRef, normalizeRepoKey, projectNodeId } from "./edges.ts";
import {
	GRAPH_DEFAULT_MASTERS,
	GRAPH_EXPECTED_EVENT_TYPES,
	GRAPH_RUN_EVENT_TYPES,
	GRAPH_SNAPSHOT_VERSION,
	GRAPH_TERMINAL_RUN_STATUSES,
	type GraphEdge,
	type GraphInput,
	type GraphNode,
	type GraphProjectView,
	type GraphRunRef,
	type GraphSnapshot,
} from "./types.ts";

// normalizeRepoKey / isPathShapedRef 的规范导出面（plan §3 记于 project.ts）。
export { isPathShapedRef, normalizeRepoKey } from "./edges.ts";

// ── 内部：Run 累积态（镜像 ProjectedRun 的 Graph 只读视图）─────────

interface RunAcc {
	subject: string;
	status: RuntimeRunStatus;
	executionKind: string | null;
	externalTaskId: string | null;
	mode: string | null;
	title: string | null;
	firstSeq: number;
	lastSeq: number;
}

interface DispatchPayload {
	executionKind?: unknown;
	externalTaskId?: unknown;
	mode?: unknown;
	title?: unknown;
}

interface TerminalPayload {
	externalTaskId?: unknown;
}

interface PendingTerminal {
	subject: string;
	type: string;
	/** 终态状态：由事件 type 派生（与 projector.ts::applyTerminal 的 `payloadStatus` 参数同义，**非** envelope.payload.status）。 */
	derivedStatus: string | null;
}

function asStr(v: unknown): string | null {
	return typeof v === "string" && v.length > 0 ? v : null;
}

function isTerminalStatus(s: RuntimeRunStatus): boolean {
	return (GRAPH_TERMINAL_RUN_STATUSES as readonly string[]).includes(s);
}

/** run.completed|failed|cancelled → 状态后缀（launch_failed 在 dispatch 分支特判）。 */
function terminalStatusFromType(type: string): RuntimeRunStatus | null {
	const suffix = type.slice("run.".length);
	return (GRAPH_TERMINAL_RUN_STATUSES as readonly string[]).includes(suffix) ? (suffix as RuntimeRunStatus) : null;
}

// C5 相位 → 项目态（与 autonomy/frontier.ts::mapPhaseToProjectState 逐字同体）。
// graph 模块禁 import autonomy（A10.1 allowlist 不扩）→ 本地双写；测试 tripwire 防漂移。
// 语义：非终态任一 → Working；全终态 → Failed > Cancelled > Completed；无 run → Working。
const C5_TERMINAL_PHASES = new Set(["completed", "failed", "cancelled"]);
/** phase 是否终态（completed/failed/cancelled）；null → 非终态（不猜）。 */
export function phaseIsTerminal(phase: string | null): boolean {
	return phase !== null && C5_TERMINAL_PHASES.has(phase);
}
/** 由 run phase 集合派生 project 级 status（同 frontier aggregateProject 的状态裁定）。 */
export function projectStatusFromPhases(phases: (string | null)[]): string {
	const nonTerm = phases.filter((p) => !phaseIsTerminal(p));
	if (nonTerm.length > 0) return "Working";
	if (phases.length > 0) {
		if (phases.includes("failed")) return "Failed";
		if (phases.includes("cancelled")) return "Cancelled";
		return "Completed";
	}
	return "Working";
}

export function runIdFromSubject(subject: string): string {
	return subject.startsWith("run://tab/") ? subject.slice("run://tab/".length) : subject;
}

// ── 投影 ───────────────────────────────────────────────────────────

export function projectGraph(input: GraphInput): GraphSnapshot {
	const entries = [...input.journal].sort((a, b) => a.seq - b.seq);
	const runs = new Map<string, RunAcc>();
	const pending = new Map<string, PendingTerminal>();
	const seenDedupeKeys = new Set<string>();
	const unknownTypes = new Set<string>();
	let headSeq = input.headSeq ?? 0;

	const applyTerminal = (subject: string, seq: number, type: string, derivedStatus: string | null, payload: TerminalPayload): void => {
		const existing = runs.get(subject);
		if (!existing) {
			// 孤立终态：等 dispatched 配对（projector 同语义；Graph 不为孤立终态发明 run 节点）
			pending.set(subject, { subject, type, derivedStatus });
			return;
		}
		if (isTerminalStatus(existing.status)) return; // terminal 优先不回退
		// 终态恒由事件 type 派生（run.launch_failed 已在调用侧显式映射为 failed）。
		// 对齐 projector.ts：其 `payloadStatus` 是**函数参数**（仅 launch_failed 传 "failed"），并非 envelope.payload.status；
		// 两投影都不读 payload.status。此处保持 type 派生——若改为 `payload.status ?? type 派生`，病态事件（type 与
		// payload.status 矛盾）反而会制造 Graph ≠ projector 分歧（E2 影子 diff 假分歧源）。
		const status = derivedStatus as RuntimeRunStatus | null;
		if (!status || !isTerminalStatus(status)) return;
		existing.status = status;
		existing.externalTaskId = existing.externalTaskId ?? asStr(payload.externalTaskId);
		existing.lastSeq = seq;
	};

	for (const entry of entries) {
		const envelope = entry.envelope;
		// dedupeKey 幂等（projector.ts#L120-L124：先消费键，未知类型也消费）
		if (envelope.dedupeKey) {
			if (seenDedupeKeys.has(envelope.dedupeKey)) continue;
			seenDedupeKeys.add(envelope.dedupeKey);
		}
		if (entry.seq > headSeq) headSeq = entry.seq;

		if (!GRAPH_RUN_EVENT_TYPES.includes(envelope.type)) {
			// ⑧ 期望事件：进词表 → 识别（不记 unknown）；不产 run 节点（非 run:// 寻址）。
			if (!GRAPH_EXPECTED_EVENT_TYPES.includes(envelope.type)) {
				unknownTypes.add(envelope.type); // 前向兼容：不投影、不抛
			}
			continue;
		}
		const subject = envelope.subject;
		if (!subject || !subject.startsWith("run://")) continue; // 非 run 寻址忽略

		if (envelope.type === "run.dispatched") {
			const existing = runs.get(subject);
			if (existing && isTerminalStatus(existing.status)) continue; // terminal 优先
			const payload = (envelope.payload ?? {}) as DispatchPayload;
			runs.set(subject, {
				subject,
				status: "dispatched",
				executionKind: asStr(payload.executionKind),
				externalTaskId: asStr(payload.externalTaskId),
				mode: asStr(payload.mode),
				title: asStr(payload.title),
				firstSeq: existing?.firstSeq ?? entry.seq,
				lastSeq: entry.seq,
			});
			const pend = pending.get(subject);
			if (pend) {
				pending.delete(subject);
				applyTerminal(subject, entry.seq, pend.type, pend.derivedStatus, {});
			}
			continue;
		}

		const type = envelope.type === "run.launch_failed" ? "failed" : terminalStatusFromType(envelope.type);
		if (!type) continue;
		applyTerminal(subject, entry.seq, envelope.type, type, (envelope.payload ?? {}) as TerminalPayload);
	}

	// ── 项目键集合（归一化 repoPath）──────────────────────────────
	const attentionByProject = new Map<string, number>();
	for (const [k, v] of Object.entries(input.projectAttention ?? {})) attentionByProject.set(normalizeRepoKey(k), v);

	const projectKeys = new Set<string>();
	for (const raw of Object.values(input.runProjects ?? {})) {
		if (isPathShapedRef(raw)) projectKeys.add(normalizeRepoKey(raw));
	}
	for (const ws of input.workstreams) {
		if (isPathShapedRef(ws.workspaceRef)) projectKeys.add(normalizeRepoKey(ws.workspaceRef!));
	}
	for (const k of attentionByProject.keys()) projectKeys.add(k);
	// ⑧ open expectation 是 project 级载体本身；即使当前没有 run/attention/workstream，也须能投影出 project 节点。
	for (const e of input.openExpectations ?? []) {
		if (e.project !== null) projectKeys.add(normalizeRepoKey(e.project));
	}

	const phaseOf = (subject: string): string | null => input.runPhases?.[subject] ?? null;
	const projectOf = (subject: string): string | null => {
		const raw = input.runProjects?.[subject];
		return isPathShapedRef(raw) ? normalizeRepoKey(raw!) : null;
	};

	// 项目 → run 视图（E2 翻转输入 + ② project 节点派生共用；提前到节点段前）。
	const runsByProject = new Map<string, GraphRunRef[]>();
	for (const acc of runs.values()) {
		const project = projectOf(acc.subject);
		if (!project) continue;
		const carrier = input.runCarriers?.[acc.subject];
		const ref: GraphRunRef = {
			runId: runIdFromSubject(acc.subject),
			subject: acc.subject,
			status: acc.status,
			phase: phaseOf(acc.subject),
			externalTaskId: acc.externalTaskId ?? undefined,
			project,
			// E2.0：carrier 缺失 → null（不猜）
			gate: carrier?.gate ?? null,
			needsHuman: carrier?.needsHuman ?? null,
			staleOver: carrier?.staleOver ?? null,
			overdue: carrier?.overdue ?? null,
			pidAlive: carrier?.pidAlive ?? null,
		};
		const arr = runsByProject.get(project);
		if (arr) arr.push(ref);
		else runsByProject.set(project, [ref]);
	}

	// ⑧ 期望账本 → 每 project 的 next_expected_event（最早 deadline 的 open 期望；不猜）
	const nextExpectedByProject = new Map<string, { type: string; deadline: number }>();
	for (const e of input.openExpectations ?? []) {
		if (e.project === null) continue; // 未归因（mailbox: 键）→ 无 project 节点
		const key = normalizeRepoKey(e.project);
		const cur = nextExpectedByProject.get(key);
		if (!cur || e.deadlineAt < cur.deadline) nextExpectedByProject.set(key, { type: e.expectedType, deadline: e.deadlineAt });
	}

	// ── 节点 ──────────────────────────────────────────────────────
	const nodes: GraphNode[] = [];
	for (const m of input.masters ?? GRAPH_DEFAULT_MASTERS) {
		nodes.push({ id: m.id, kind: "master", label: m.id, status: null, attrs: {}, firstSeq: 0, lastSeq: 0 });
	}
	for (const ws of input.workstreams) {
		nodes.push({
			id: ws.id,
			kind: "workstream",
			label: ws.mission,
			status: ws.status,
			attrs: { workspaceRef: ws.workspaceRef ?? null, hasTaskSelector: ws.taskSelector !== undefined },
			firstSeq: 0,
			lastSeq: 0,
		});
	}
	for (const t of input.tasks) {
		nodes.push({
			id: t.id,
			kind: "task",
			label: t.objective,
			status: t.status,
			attrs: { workstreamId: t.workstreamId ?? null, externalTaskId: t.externalTaskId ?? null },
			firstSeq: 0,
			lastSeq: 0,
		});
	}
	for (const acc of runs.values()) {
		// ① carrier 五字段双写进节点 attrs（与 attention/phase/status 同模式）→ diffGraph 可见（§C6 盲区1）。
		const carrier = input.runCarriers?.[acc.subject];
		nodes.push({
			id: acc.subject,
			kind: "run",
			label: acc.subject,
			status: acc.status,
			attrs: {
				executionKind: acc.executionKind,
				externalTaskId: acc.externalTaskId,
				mode: acc.mode,
				title: acc.title,
				phase: phaseOf(acc.subject),
				project: projectOf(acc.subject),
				gate: carrier?.gate ?? null,
				needsHuman: carrier?.needsHuman ?? null,
				staleOver: carrier?.staleOver ?? null,
				overdue: carrier?.overdue ?? null,
				pidAlive: carrier?.pidAlive ?? null,
			},
			firstSeq: acc.firstSeq,
			lastSeq: acc.lastSeq,
		});
	}
	for (const key of projectKeys) {
		// ② project 级「只缺投影」字段：派生规则与 frontier 一致（不引入第二套语义）。
		const projRuns = runsByProject.get(key) ?? [];
		const attention = attentionByProject.get(key) ?? 0;
		const phases = projRuns.map((r) => r.phase);
		const status = projectStatusFromPhases(phases);
		const needsUser = projRuns.some((r) => r.needsHuman === true || r.gate === "awaiting") || attention > 0;
		const activeRuns = projRuns.filter((r) => !phaseIsTerminal(r.phase));
		const activeWaiting = activeRuns.filter((r) => r.phase === "waiting").length;
		const activeRunning = activeRuns.length - activeWaiting;
		const ne = nextExpectedByProject.get(key);
		nodes.push({
			id: projectNodeId(key),
			kind: "project",
			label: key,
			status,
			attrs: {
				repoPath: key,
				attention: attentionByProject.get(key) ?? null,
				needsUser,
				activeRunning,
				activeWaiting,
				// next_expected_event {type,timeout} 扁平化（attrs 仅接受标量）；无 open 期望 → 双 null。
				nextExpectedEventType: ne?.type ?? null,
				nextExpectedEventDeadline: ne?.deadline ?? null,
			},
			firstSeq: 0,
			lastSeq: 0,
		});
	}
	nodes.sort((a, b) => cmp(a.id, b.id));

	// ── 边（引用式）───────────────────────────────────────────────
	const edges: GraphEdge[] = deriveEdges(nodes, {
		tasks: input.tasks,
		workstreams: input.workstreams,
		runPhases: input.runPhases,
	});

	// ── 项目视图（E2 翻转输入）─────────────────────────────────────
	// runsByProject 已在节点段前装配（project 节点派生与视图共用同一 run 集）。
	const projects: GraphProjectView[] = [...projectKeys].sort(cmp).map((project) => ({
		project,
		attention: attentionByProject.get(project) ?? 0,
		runs: (runsByProject.get(project) ?? []).sort((a, b) => cmp(a.runId, b.runId)),
	}));

	const snapshot: GraphSnapshot = {
		version: GRAPH_SNAPSHOT_VERSION,
		headSeq,
		logEpoch: input.logEpoch ?? "",
		nodes: Object.freeze(nodes) as GraphNode[],
		edges: Object.freeze(edges) as GraphEdge[],
		projects: Object.freeze(projects) as GraphProjectView[],
		skipped: { badLines: input.badLines ?? 0, unknownEventTypes: Object.freeze([...unknownTypes].sort(cmp)) as string[] },
	};
	// E2.0：history/asof 为观测载体，仅在输入提供时发出（保持 E1 快照形状向后兼容）。
	if (input.history !== undefined) snapshot.history = Object.freeze([...input.history].sort((a, b) => cmp(a.id, b.id))) as { id: string; reason: string }[];
	if (input.asof !== undefined) snapshot.asof = input.asof;
	return Object.freeze(snapshot);
}
