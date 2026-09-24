/**
 * graph/diff.ts — E1 diffGraph(prev,next,sinceSeq) 纯差分（零 IO、确定性）。
 *
 * 游标语义（v0.2 §26 R-A12）：`sinceSeq` = 只消费 journal `seq > sinceSeq` 的事件。
 * 节点带 firstSeq/lastSeq 可自证新鲜度；边无 seq → 用两端节点的 seq 归属判定。
 * 非 journal 源（firstSeq=0：master/workstream/task/project）恒在范围内（其变化不能被 seq 过滤掉）。
 * `prev = null` → baseline（全部 added）。
 */

import type { GraphDiff, GraphEdge, GraphNode, GraphSnapshot } from "./types.ts";
import { cmp } from "./edges.ts";

/** 节点是否在本游标之后新鲜（非 journal 源恒 true）。 */
function nodeInScope(n: GraphNode, sinceSeq: number): boolean {
	return n.firstSeq === 0 || n.lastSeq > sinceSeq;
}

function edgeKey(e: GraphEdge): string {
	return `${e.kind}|${e.from}|${e.to}`;
}

/** 边的新鲜度：两端节点任一新鲜即算新鲜；端点节点缺失 → 保守算新鲜（不吞）。 */
function edgeInScope(e: GraphEdge, byId: Map<string, GraphNode>, sinceSeq: number): boolean {
	for (const id of [e.from, e.to]) {
		const n = byId.get(id);
		if (!n || nodeInScope(n, sinceSeq)) return true;
	}
	return false;
}

export function diffGraph(prev: GraphSnapshot | null, next: GraphSnapshot, sinceSeq: number): GraphDiff {
	if (!prev) {
		return {
			sinceSeq,
			headSeq: next.headSeq,
			addedNodes: [...next.nodes],
			removedNodes: [],
			changedNodes: [],
			addedEdges: [...next.edges],
			removedEdges: [],
		};
	}

	const prevNodes = new Map(prev.nodes.map((n) => [n.id, n] as const));
	const nextNodes = new Map(next.nodes.map((n) => [n.id, n] as const));

	const addedNodes: GraphNode[] = [];
	const changedNodes: GraphNode[] = [];
	for (const n of next.nodes) {
		const p = prevNodes.get(n.id);
		if (!p) {
			if (nodeInScope(n, sinceSeq)) addedNodes.push(n);
		} else if (JSON.stringify(p) !== JSON.stringify(n)) {
			if (nodeInScope(n, sinceSeq)) changedNodes.push(n);
		}
	}
	const removedNodes: string[] = [];
	for (const n of prev.nodes) {
		if (nextNodes.has(n.id)) continue;
		if (nodeInScope(n, sinceSeq)) removedNodes.push(n.id);
	}

	const prevEdges = new Map(prev.edges.map((e) => [edgeKey(e), e] as const));
	const nextEdges = new Map(next.edges.map((e) => [edgeKey(e), e] as const));
	const addedEdges = next.edges.filter((e) => !prevEdges.has(edgeKey(e)) && edgeInScope(e, nextNodes, sinceSeq));
	const removedEdges = prev.edges.filter((e) => !nextEdges.has(edgeKey(e)) && edgeInScope(e, prevNodes, sinceSeq));

	addedNodes.sort((a, b) => cmp(a.id, b.id));
	changedNodes.sort((a, b) => cmp(a.id, b.id));
	removedNodes.sort(cmp);
	return { sinceSeq, headSeq: next.headSeq, addedNodes, removedNodes, changedNodes, addedEdges, removedEdges };
}
