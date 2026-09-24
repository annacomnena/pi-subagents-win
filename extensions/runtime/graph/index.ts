/**
 * graph/index.ts — E1 只读关系面 barrel（显式命名导出，避免 * 重名歧义）。
 *
 * 影子模式：本模块只被 `extensions/_test_runtime_graph.ts` import；生产文件零消费者。
 */

export * from "./types.ts";
export { projectGraph, runIdFromSubject } from "./project.ts";
export { normalizeRepoKey, isPathShapedRef, projectNodeId, deriveEdges, compareEdges } from "./edges.ts";
export { diffGraph } from "./diff.ts";
export { collectGraphInput, readGraphSnapshot, type CollectGraphOptions } from "./collect.ts";
