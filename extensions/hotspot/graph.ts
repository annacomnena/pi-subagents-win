/**
 * hotspot/graph — ① 动态投影（0922 组合计划 §0.1/§1；v2 §14.1/§14.2）
 *
 * `hotspot read` 时对本条目符号现算 codegraph callers/callees，**只保留两端都
 * 命中热点条目符号的边**（一跳裁剪，防 callers 拉出 30+ 噪声，§14.2）。
 * **边不存储**：codegraph 是唯一真相源，热点层只出工作视角投影（§14.1 红线：
 * 拓扑仅一跳/动态投影；热点层图化存储已被否决）。
 * **投影失败/超时 → 降级缺边**，绝不阻塞 read；read 输出标注"现算、非存储"。
 *
 * 性能预算：整体 6s，单 codegraph 调用 2s。execFileSync 是同步调用，
 * Promise.race 无法真正中断子进程，"超时即弃"实现为：
 * 1) 单次调用 execFileSync timeout=2s（子进程被杀）；
 * 2) 每个符号调用前检查已用时间，超 6s 预算 → 停止后续调用，剩余视为缺边。
 */

import { execFileSync } from "node:child_process";
import { posix } from "node:path";
import { codegraphAvailable, SYMBOL_NAME_RE } from "./validate.ts";
import type { HotspotEntry } from "./types.ts";

export interface GraphEdge {
	/** 调用方 `path::Symbol`（posix 归一） */
	a: string;
	/** 被调方 `path::Symbol`（posix 归一） */
	b: string;
	/** 固定 "calls"：a 调用 b */
	dir: "calls";
}

export interface ProjectionResult {
	/** 去重后的边（两端都命中全条目符号集） */
	edges: GraphEdge[];
	/** 降级原因（read 展示；空 = 投影完整可用） */
	degraded: string[];
}

export const PROJECTION_TOTAL_BUDGET_MS = 6_000;
export const CODEGRAPH_CALL_TIMEOUT_MS = 2_000;

/** CLI 桥（与 validate.ts 同款：win32 走 .cmd + shell；测试注入 mock 用）。 */
export type CodegraphRunner = (args: string[], opts: { cwd: string; timeoutMs: number }) => string | null;

export const defaultCodegraphRunner: CodegraphRunner = (args, opts) => {
	const cmd = process.platform === "win32" ? "codegraph.cmd" : "codegraph";
	try {
		return execFileSync(cmd, args, {
			cwd: opts.cwd,
			timeout: opts.timeoutMs,
			encoding: "utf8",
			windowsHide: true,
			shell: true, // Windows .cmd 必须经 shell；symbol 已过白名单校验，无注入面
		}) as string;
	} catch {
		return null; // 不可用/超时 → null（缺边）
	}
};

export interface NeighborRef {
	name: string;
	filePath: string;
}

export interface NeighborsResult {
	callers: NeighborRef[];
	callees: NeighborRef[];
	/** 非 null = 该符号的邻居数据不完整（缺边原因） */
	degraded: string | null;
}

/** `codegraph callers <sym> -j` / `callees <sym> -j` → 邻居列表。
 *  -j 输出形如 {"symbol":"X","callers":[{"name","kind","filePath","startLine"}]}；
 *  CLI 不可用/超时/JSON 损坏 → 对应半边为空 + degraded 原因。 */
export function codegraphNeighbors(
	sym: string,
	root: string,
	timeoutMs: number = CODEGRAPH_CALL_TIMEOUT_MS,
	run: CodegraphRunner = defaultCodegraphRunner,
	/** 本符号 callers+callees 共享的总预算；省略时仅施加每调用上限（供独立调用/测试）。 */
	totalBudgetMs: number = Number.POSITIVE_INFINITY,
): NeighborsResult {
	if (!SYMBOL_NAME_RE.test(sym)) return { callers: [], callees: [], degraded: `符号名含非法字符: ${sym}` };
	const start = Date.now();
	const remaining = (): number => Math.max(0, totalBudgetMs - (Date.now() - start));
	const call = (args: string[]): string | null => {
		const left = remaining();
		if (left <= 0) return null;
		return run(args, { cwd: root, timeoutMs: Math.min(timeoutMs, left) });
	};
	const parse = (json: string, key: "callers" | "callees"): NeighborRef[] | null => {
		try {
			const data = JSON.parse(json) as Record<string, unknown>;
			const arr = data[key];
			if (!Array.isArray(arr)) return null;
			const out: NeighborRef[] = [];
			for (const item of arr) {
				const it = item as { name?: unknown; filePath?: unknown };
				if (typeof it?.name === "string" && typeof it?.filePath === "string") out.push({ name: it.name, filePath: it.filePath });
			}
			return out;
		} catch {
			return null;
		}
	};
	const cOut = call(["callers", sym, "-j"]);
	if (cOut === null) return { callers: [], callees: [], degraded: "codegraph callers 失败或超时" };
	const callers = parse(cOut, "callers");
	if (callers === null) return { callers: [], callees: [], degraded: "codegraph callers 输出格式异常" };
	const lOut = call(["callees", sym, "-j"]);
	if (lOut === null) return { callers, callees: [], degraded: "codegraph callees 失败或超时" };
	const callees = parse(lOut, "callees");
	if (callees === null) return { callers, callees: [], degraded: "codegraph callees 输出格式异常" };
	return { callers, callees, degraded: null };
}

/** 一跳投影：收集全部条目符号集 `Set<path::Symbol>`，对每个符号查 codegraph，
 *  只保留两端都命中符号集的边（一跳裁剪），去重输出 `{a,b,dir}[]`。
 *  codegraph 不可用 → 空 + degraded；超预算 → 停止 + degraded；绝不抛异常。
 *  run/available 可注入（单测 mock -j 输出/不可用/超时）。 */
export function projectEdges(
	root: string,
	entries: HotspotEntry[],
	run: CodegraphRunner = defaultCodegraphRunner,
	budgetMs: number = PROJECTION_TOTAL_BUDGET_MS,
	available: (root: string) => boolean = codegraphAvailable,
): ProjectionResult {
	const degraded: string[] = [];
	const symbolSet = new Set<string>();
	for (const e of entries) {
		for (const s of e.symbols) symbolSet.add(`${posix.normalize(s.path)}::${s.name}`);
	}
	if (symbolSet.size === 0) return { edges: [], degraded: ["无符号条目，无可投影"] };
	const start = Date.now();
	if (!available(root)) return { edges: [], degraded: ["CodeGraph 不可用，投影缺边"] };
	if (Date.now() - start >= budgetMs) {
		return { edges: [], degraded: [`整体 ${budgetMs}ms 预算超支，投影缺边（CodeGraph 可用性检查已耗尽预算）`] };
	}

	const edgeKeys = new Set<string>();
	const edges: GraphEdge[] = [];
	const addEdge = (a: string, b: string): void => {
		const k = `${a}\u0000${b}`;
		if (edgeKeys.has(k)) return;
		edgeKeys.add(k);
		edges.push({ a, b, dir: "calls" });
	};

	for (const symKey of [...symbolSet]) {
		// 整体 6s 预算：超预算即弃（剩余符号视为缺边，不阻塞 read）
		if (Date.now() - start >= budgetMs) {
			degraded.push(`整体 ${budgetMs}ms 预算超支，投影缺边（部分符号未查）`);
			break;
		}
		const idx = symKey.lastIndexOf("::");
		const name = symKey.slice(idx + 2);
		// callers/callees 共享剩余总预算；每次仍最多 2s，避免最后一个符号把整体 6s 拉长。
		const remainingBudget = Math.max(0, budgetMs - (Date.now() - start));
		const nb = codegraphNeighbors(name, root, CODEGRAPH_CALL_TIMEOUT_MS, run, remainingBudget);
		if (nb.degraded) {
			degraded.push(`${name}: ${nb.degraded}`);
			continue;
		}
		for (const c of nb.callers) {
			// 一跳裁剪：两端都命中热点条目符号集才留边
			const nkey = `${posix.normalize(c.filePath)}::${c.name}`;
			if (symbolSet.has(nkey)) addEdge(nkey, symKey); // 邻居调用本符号
		}
		for (const l of nb.callees) {
			const nkey = `${posix.normalize(l.filePath)}::${l.name}`;
			if (symbolSet.has(nkey)) addEdge(symKey, nkey); // 本符号调用邻居
		}
	}
	return { edges, degraded };
}
