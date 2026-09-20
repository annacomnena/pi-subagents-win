/**
 * runtime/address.ts — Logical Address（Phase 1C，设计稿 §7）
 *
 * 统一逻辑对象寻址：
 *
 *   agent://master                       逻辑 Master（session rollover 不变）
 *   workstream://<workstreamId>
 *   task://<taskId>
 *   run://tab/<tabRunId>                 引用现有 tab runId（不迁移、不重生）
 *   run://subagent/<runId>               引用现有 subagent runId
 *   run://trace/<fusionRunId>/<lane>     trace-fusion lane
 *
 * 原则：
 *   - 纯函数、无 IO；构造与解析对称（round-trip 保证）。
 *   - 引用型地址（run://）直接携带现有物理 runId——物理 ID 在地址里是被引用物，
 *     不是被定义物（设计稿 §5：identity namespace 稳定优先）。
 */

import type { MasterId, RunId, TaskId, WorkstreamId } from "./ids.ts";

// ── 地址类型 ───────────────────────────────────────────────────────

export type ObjectAddress =
	| `agent://${string}`
	| `workstream://${string}`
	| `task://${string}`
	| `run://${string}`;

// ── 构造 ───────────────────────────────────────────────────────────

export function masterAddress(master: MasterId = "master_default" as MasterId): ObjectAddress {
	return `agent://${master}`;
}

export function workstreamAddress(id: WorkstreamId): ObjectAddress {
	return `workstream://${id}`;
}

export function taskAddress(id: TaskId): ObjectAddress {
	return `task://${id}`;
}

/** 现有 launch-tabs / dispatchPiTab 的 tabRunId（tab_*）。 */
export function tabRunAddress(tabRunId: string): ObjectAddress {
	return `run://tab/${tabRunId}`;
}

/** 现有 subagent-win async runId。 */
export function subagentRunAddress(runId: string): ObjectAddress {
	return `run://subagent/${runId}`;
}

/** trace-fusion run 的单 lane：fusionRunId（tfl-*）+ lane 名（a/b/c）。 */
export function traceLaneAddress(fusionRunId: string, lane: string): ObjectAddress {
	return `run://trace/${fusionRunId}/${lane}`;
}

// ── 解析 ───────────────────────────────────────────────────────────

export type ParsedObjectAddress =
	| { scheme: "agent"; value: string }
	| { scheme: "workstream"; value: string }
	| { scheme: "task"; value: string }
	| { scheme: "run"; kind: "tab"; value: string }
	| { scheme: "run"; kind: "subagent"; value: string }
	| { scheme: "run"; kind: "trace"; fusionRunId: string; lane: string };

/** value 段非法字符检查：非空、无空白、无控制字符（`/` 与 `:` 的细分规则由各 scheme 自查）。 */
function invalidValueSegment(s: string): boolean {
	return s.length === 0 || /\s/.test(s) || /[\x00-\x1f\x7f]/.test(s);
}

export function parseObjectAddress(address: string): ParsedObjectAddress | null {
	if (typeof address !== "string") return null;
	const sep = address.indexOf("://");
	if (sep <= 0) return null;
	const scheme = address.slice(0, sep);
	const rest = address.slice(sep + 3);
	if (rest.length === 0 || /\s/.test(rest) || /[\x00-\x1f\x7f]/.test(rest)) return null;

	switch (scheme) {
		case "agent":
		case "workstream":
		case "task":
			// 单段命名空间：不允许出现第二个 "/"（id 内不含路径）
			if (rest.includes("/")) return null;
			return { scheme, value: rest };
		case "run": {
			const parts = rest.split("/");
			if (parts.length === 2 && (parts[0] === "tab" || parts[0] === "subagent")) {
				if (invalidValueSegment(parts[1])) return null;
				return { scheme: "run", kind: parts[0], value: parts[1] } as ParsedObjectAddress;
			}
			if (parts.length === 3 && parts[0] === "trace") {
				if (invalidValueSegment(parts[1]) || invalidValueSegment(parts[2])) return null;
				return { scheme: "run", kind: "trace", fusionRunId: parts[1], lane: parts[2] };
			}
			return null;
		}
		default:
			return null;
	}
}

export function isObjectAddress(address: string): boolean {
	return parseObjectAddress(address) !== null;
}
