/**
 * graph/edges.ts — E1 引用式边派生（纯函数、确定性、零 IO）。
 *
 * 计划 §1 表 / §3：边**只从既有载体派生**，不做声明式 depends_on/blocks/requires。
 *   task → workstream      TaskRecord.workstreamId（objects.ts#L84）
 *   run  → externalTaskId  run payload externalTaskId（adapters/tab-run.ts#L68）
 *   run  → subject         RuntimeEnvelope.subject（envelope.ts#L36）
 *   run  → workstream      WorkstreamRecord.taskSelector.runSubjects/externalTaskIds（objects.ts#L56）
 *   workstream → project   WorkstreamRecord.workspaceRef（objects.ts#L44，**弱载体**：仅路径形时派生）
 *
 * 路径口径 helper 落在本文件（project.ts re-export），以避免 project→edges 与 edges→project 的循环 import。
 */

import type { GraphEdge, GraphInput, GraphNode } from "./types.ts";

// ── 路径口径（normalizeRepoKey 本地副本，与 recent-scopes.ts::normalizeExactPath 同函数）──
//
// 目的：保持 graph 依赖图零 node:fs（纯函数层），且与 global-view/frontier 的项目键同一口径。
// 漂移由测试 tripwire 固化（_test_runtime_graph.ts T8 与 recent-scopes normalizeExactPath 逐例比对）。

/** 精确路径规范化：统一斜杠、盘符小写、去尾部分隔符、整体小写（P0：不删内部 `-`/分隔符）。 */
export function normalizeRepoKey(p: string): string {
	let s = p.replace(/\\/g, "/");
	s = s.replace(/^[A-Za-z]:/, (m) => m.toLowerCase());
	s = s.replace(/\/+$/, "");
	return s.toLowerCase();
}

/**
 * workspaceRef 是否可解释为文件路径（弱载体红线：不猜）。
 * 逻辑地址（`scheme://…`，如 agent://x、workstream://x）不算路径；须含 `/` 或 `\`。
 */
export function isPathShapedRef(ref: string | undefined | null): boolean {
	if (typeof ref !== "string") return false;
	const s = ref.trim();
	if (s.length === 0) return false;
	if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(s)) return false; // scheme:// = 逻辑地址
	return s.includes("/") || s.includes("\\");
}

/** 项目节点 id（确定性）。 */
export function projectNodeId(normalizedRepo: string): string {
	return `project:${normalizedRepo}`;
}

// ── 边派生 ─────────────────────────────────────────────────────────

/**
 * 从节点表 + 显式库输入派生引用式边（纯、确定性；输出按 kind,from,to 升序）。
 * `runPhases` 仅为接口稳定接受（phase 不产边）；`nodes` 决定两侧对象是否存在（孤儿引用不产边、不抛）。
 */
export function deriveEdges(
	nodes: GraphNode[],
	input: Pick<GraphInput, "tasks" | "workstreams" | "runPhases">,
): GraphEdge[] {
	const nodeIds = new Set(nodes.map((n) => n.id));
	const runNodes = nodes.filter((n) => n.kind === "run");
	const edges: GraphEdge[] = [];

	// 1) task → workstream（TaskRecord.workstreamId；指向不存在的 ws → 不产边，孤儿引用不猜）
	for (const t of input.tasks) {
		if (!t.workstreamId || !nodeIds.has(t.workstreamId)) continue;
		edges.push({
			kind: "task_workstream",
			from: t.id,
			to: t.workstreamId,
			evidence: `TaskRecord.workstreamId=${t.workstreamId} (objects.ts#L84)`,
		});
	}

	for (const r of runNodes) {
		const ext = typeof r.attrs.externalTaskId === "string" && r.attrs.externalTaskId.length > 0 ? r.attrs.externalTaskId : null;

		// 2) run → externalTaskId（run payload → TaskRecord.externalTaskId 桥接；无 task 命中 → 不产边）
		if (ext) {
			const task = input.tasks.find((t) => t.externalTaskId === ext);
			if (task && nodeIds.has(task.id)) {
				edges.push({
					kind: "run_task",
					from: r.id,
					to: task.id,
					evidence: `run payload externalTaskId=${ext} (adapters/tab-run.ts#L68)`,
				});
			}
		}

		// 3) run → workstream（taskSelector：runSubjects 精确优先；否则 externalTaskIds best-effort 标注）
		const subjectHit = input.workstreams.find((ws) => ws.taskSelector?.runSubjects?.includes(r.id));
		if (subjectHit) {
			edges.push({
				kind: "run_workstream",
				from: r.id,
				to: subjectHit.id,
				evidence: `taskSelector.runSubjects 命中 ${r.id} (objects.ts#L56)`,
				match: "runSubject",
			});
		} else if (ext) {
			const labelHit = input.workstreams.find((ws) => ws.taskSelector?.externalTaskIds?.includes(ext));
			if (labelHit) {
				edges.push({
					kind: "run_workstream",
					from: r.id,
					to: labelHit.id,
					evidence: `taskSelector.externalTaskIds 命中 ${ext} (objects.ts#L56, best-effort)`,
					match: "externalTaskId",
				});
			}
		}

		// 4) run → subject：run 节点以 envelope.subject 为主键；此处固化身份绑定边
		//    （v0.2 §8 示例「Run ── subject ──▶ run://tab_...」）。仅 journal 源的 run（firstSeq>0）产出。
		if (r.firstSeq > 0) {
			edges.push({
				kind: "run_subject",
				from: r.id,
				to: r.id,
				evidence: `envelope.subject=${r.id} (envelope.ts#L36)`,
			});
		}
	}

	// 5) workstream → project（workspaceRef 弱载体：仅路径形时派生，否则 unknown 不猜）
	for (const ws of input.workstreams) {
		if (!isPathShapedRef(ws.workspaceRef)) continue;
		const to = projectNodeId(normalizeRepoKey(ws.workspaceRef!));
		if (!nodeIds.has(to)) continue;
		edges.push({
			kind: "workstream_project",
			from: ws.id,
			to,
			evidence: `workspaceRef=${ws.workspaceRef} (objects.ts#L44, 弱载体)`,
		});
	}

	return edges.sort(compareEdges);
}

/** 确定性排序：kind → from → to（同 key 保留输入序，输入序本身确定）。 */
export function compareEdges(a: GraphEdge, b: GraphEdge): number {
	return cmp(a.kind, b.kind) || cmp(a.from, b.from) || cmp(a.to, b.to);
}

export function cmp(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
