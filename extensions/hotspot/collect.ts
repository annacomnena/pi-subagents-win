/**
 * hotspot/collect — 工具事件采集（v4 §6；计划 §C.1）
 *
 * - 白名单：edit/write（成功 → write）、read（成功 → read）、bash（保守 test 识别）；
 *   grep/find/ls/powershell 与其余工具一律不计（broad scan 天然排除）；hotspot 自身不计。
 * - start 按 toolCallId 暂存 args（end 无 args；有界 Map 1024，detect.ts 模式），
 *   end 成功才计分；失败（isError）不计。
 * - bash 保守 test（拍板 #5，宁缺勿滥）：命令含测试关键词 且 从 token 提取的路径里
 *   恰好一个可归一为 repo 内现存文件（无 glob、无多路径）→ 记 test。
 * - 同 run 上限（RUN_CAP）：agent_start 重置计数器，超出不落盘（读侧无需后滤）。
 * - 身份解析（§C.1，会话内惰性一次并缓存）：tab → 派发账本 externalTaskId +
 *   enrichRunRefs 派生 workstream；主会话/子 agent → taskId 留空（拍板 #6/#4）。
 * - 一切 try/catch 静默：采集失败绝不打断工具流。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { getTabRunId, isSubagent } from "../identity.ts";
import { defaultRuntimeDir } from "../runtime/journal.ts";
import { enrichRunRefs, listTasks, listWorkstreams } from "../runtime/workstreams.ts";
import { readTabDispatch, type TabDispatchRecord } from "../tab-runs.ts";
import {
	appendEvent,
	defaultAgentDir,
	ensureWorkspace,
	findRepoRoot,
	newShardName,
	toRepoRelative,
	workspaceIdOf,
	wsPaths,
} from "./store.ts";
import { RUN_CAP, type HotEvent, type HotKind, type HotScope } from "./types.ts";

// ── 身份解析 ─────────────────────────────────────────────────────

export interface HotIdentity {
	scope: HotScope;
	/** tab 会话的 runId */
	runId?: string;
	/** externalTaskId（来自派发账本 TabDispatchRecord.taskId；主会话/子 agent 留空） */
	taskId?: string;
	/** enrichRunRefs 派生的 workstream 关联 */
	wsId?: string;
}

export interface IdentityDeps {
	agentDir?: string;
	stateDir?: string;
}

/** 现场解析身份（纯读；不做会话级缓存——缓存见 sessionHotIdentity）。 */
export function resolveIdentity(deps?: IdentityDeps): HotIdentity {
	const agentDir = deps?.agentDir ?? defaultAgentDir();
	const stateDir = deps?.stateDir ?? join(defaultRuntimeDir(), "state");
	if (isSubagent()) return { scope: "subagent" }; // 拍板 #4：子 agent 只采 workspace 级，不伪造 task_id
	const runId = getTabRunId();
	if (!runId) return { scope: "main" }; // 拍板 #6：主会话无 task_id
	const dispatch = safeRead(join(agentDir, "tab-runs"), runId);
	const taskId = dispatch?.taskId || undefined;
	const refs = enrichRunRefs(
		{ subject: `run://tab/${runId}`, externalTaskId: taskId },
		listTasks(undefined, stateDir),
		listWorkstreams(stateDir),
	);
	return { scope: "tab", runId, taskId, wsId: refs.workstreamRef };
}

function safeRead(runsDir: string, runId: string): TabDispatchRecord | null {
	try {
		return readTabDispatch(runsDir, runId); // 缺失/损坏返回 null
	} catch {
		return null;
	}
}

let cachedIdentity: HotIdentity | null = null;

/** 会话内惰性一次并缓存（dispatch/task 记录不可变，缓存安全；§C.1）。 */
export function sessionHotIdentity(): HotIdentity {
	if (!cachedIdentity) cachedIdentity = resolveIdentity();
	return cachedIdentity;
}

/** 测试用：清身份缓存。 */
export function resetIdentityCacheForTest(): void {
	cachedIdentity = null;
}

// ── bash 保守 test 识别（纯函数） ─────────────────────────────────

const TEST_KEYWORD_RE = /\b(test|vitest|jest|pytest|mocha|node --test)\b/i;

/**
 * 保守 test 判定：命令含测试关键词，且 token 中恰好一个可归一为 repo 内现存**文件**
 * （无 `*`/`?` glob、无多路径）。返回该文件 repo 相对路径；不满足 → null。
 */
export function detectConservativeTest(command: string, root: string): string | null {
	if (!TEST_KEYWORD_RE.test(command)) return null;
	let hit: string | null = null;
	let hits = 0;
	for (const raw of command.split(/\s+/)) {
		const t = raw.replace(/^["'`({[<]+/, "").replace(/["'`)}\]>,.;:!?]+$/, "");
		if (!t) continue;
		if (t.includes("*") || t.includes("?")) return null; // glob → 不采（宁缺勿滥）
		const rel = toRepoRelative(t, root);
		if (!rel) continue;
		const abs = join(root, rel);
		if (existsSync(abs) && statSync(abs).isFile()) {
			hits++;
			hit = rel;
		}
	}
	if (hits !== 1) return null; // 恰好一个路径才采
	return hit;
}

// ── 采集器（可注入 deps 供测试） ─────────────────────────────────

const STASH_LIMIT = 1024;
const COLLECT_TOOLS = new Set(["edit", "write", "read", "bash"]);

export interface ToolStartEvent {
	toolCallId: string;
	toolName: string;
	args?: unknown;
}

export interface ToolEndEvent {
	toolCallId: string;
	toolName: string;
	result?: unknown;
	isError?: boolean;
}

export interface CollectDeps {
	agentDir: string;
	/** 工作目录（repo root 解析基准）；缺省 process.cwd() */
	cwd?: string;
	/** 身份（缺省 sessionHotIdentity 缓存） */
	identity?: () => HotIdentity;
}

export interface Collector {
	readonly shard: string;
	onToolStart(event: ToolStartEvent): void;
	onToolEnd(event: ToolEndEvent): void;
	/** run 边界：重置同 run 计数 */
	onAgentStart(): void;
}

export function createCollector(deps: CollectDeps): Collector {
	const cwd = deps.cwd ?? process.cwd();
	const root = findRepoRoot(cwd);
	const wsid = workspaceIdOf(root);
	const p = wsPaths(deps.agentDir, wsid);
	const shard = newShardName();
	const stash = new Map<string, { tool: string; path: string | null; command: string | null }>();
	const runCounts = new Map<string, Map<HotKind, number>>();
	let workspaceReady = false;

	function record(kind: HotKind, path: string): void {
		try {
			// 同 run 上限：超出不落盘（读侧无需后滤）
			const per = runCounts.get(path) ?? new Map<HotKind, number>();
			if ((per.get(kind) ?? 0) >= RUN_CAP[kind]) return;
			per.set(kind, (per.get(kind) ?? 0) + 1);
			runCounts.set(path, per);
			if (!workspaceReady) {
				ensureWorkspace(deps.agentDir, wsid, root);
				workspaceReady = true;
			}
			const id = deps.identity ? deps.identity() : sessionHotIdentity();
			const ev: HotEvent = {
				v: 4,
				at: new Date().toISOString(),
				kind,
				path,
				scope: id.scope,
				...(id.taskId ? { taskId: id.taskId } : {}),
				...(id.wsId ? { wsId: id.wsId } : {}),
			};
			appendEvent(p.eventsDir, shard, ev);
		} catch {
			/* 静默 */
		}
	}

	return {
		shard,
		onAgentStart() {
			runCounts.clear();
		},
		onToolStart(event) {
			try {
				if (!COLLECT_TOOLS.has(event.toolName)) return; // hotspot 自身/扫描类工具不计
				const args = (event.args ?? {}) as Record<string, unknown>;
				stash.set(event.toolCallId, {
					tool: event.toolName,
					path: typeof args.path === "string" ? args.path : null,
					command: typeof args.command === "string" ? args.command : null,
				});
				if (stash.size > STASH_LIMIT) {
					const first = stash.keys().next().value;
					if (first !== undefined) stash.delete(first); // 有界，防泄漏
				}
			} catch {
				/* 静默 */
			}
		},
		onToolEnd(event) {
			try {
				const info = stash.get(event.toolCallId);
				stash.delete(event.toolCallId);
				if (!info || event.isError) return; // 失败不计
				if (info.tool === "bash") {
					if (!info.command) return;
					const rel = detectConservativeTest(info.command, root);
					if (rel) record("test", rel);
					return;
				}
				if (!info.path) return;
				const rel = toRepoRelative(info.path, root);
				if (!rel) return; // root 外 → 弃
				record(info.tool === "read" ? "read" : "write", rel);
			} catch {
				/* 静默 */
			}
		},
	};
}

/** 注册采集（主/Tab/子 agent 全注册；拍板 #4：子 agent 只追加 workspace 级分片）。 */
export function registerHotspotCollect(pi: ExtensionAPI): void {
	const collector = createCollector({ agentDir: defaultAgentDir() });
	pi.on("tool_execution_start", (event) => {
		try {
			collector.onToolStart(event);
		} catch {
			/* 静默 */
		}
	});
	pi.on("tool_execution_end", (event) => {
		try {
			collector.onToolEnd(event);
		} catch {
			/* 静默 */
		}
	});
	pi.on("agent_start", () => {
		try {
			collector.onAgentStart();
		} catch {
			/* 静默 */
		}
	});
}
