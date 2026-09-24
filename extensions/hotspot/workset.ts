/**
 * hotspot/workset — 归并全部分片 → 工作集投影（v4 §5；计划 §C.4）
 *
 * buildWorkset：读全部分片（窗口 = now-HARD_TTL）→ 按 path 聚合 → scoreEvents →
 * 排序 → top WORKSET_TOP_N。task 视图过滤 e.taskId===taskId || e.wsId===wsId，
 * 无命中回退 workspace 视图并标注（主会话工作全在 workspace 视图）。
 * Phase 3 接入点（§C.6）：buildWorkset 以 HotEvent[] 语义消费分片，未来换 journal
 * 订阅时数据源无关，届时删分片目录、snapshot 改从 Timeline 重建。
 */

import { scoreEvents, ttlState } from "./decay.ts";
import { readEvents, wsPaths } from "./store.ts";
import { HARD_TTL_MS, WORKSET_TOP_N, type HotEntry, type HotEvent, type HotKind } from "./types.ts";

export interface WorksetView {
	view: "task" | "workspace";
	/** 请求了 task 视图但无命中 → 回退 workspace（标注） */
	fellBack: boolean;
	entries: HotEntry[];
}

export interface BuildWorksetOpts {
	now: number;
	taskId?: string;
	wsId?: string;
	topN?: number;
}

export function buildWorkset(agentDir: string, wsid: string, opts: BuildWorksetOpts): WorksetView {
	let all: HotEvent[];
	try {
		all = readEvents(wsPaths(agentDir, wsid).eventsDir).filter((e) => {
			const t = Date.parse(e.at);
			return Number.isFinite(t) && t >= opts.now - HARD_TTL_MS; // 读侧窗口 = 72h
		});
	} catch {
		all = [];
	}
	const wantTask = Boolean(opts.taskId || opts.wsId);
	const taskEvents = wantTask
		? all.filter((e) => (opts.taskId ? e.taskId === opts.taskId : false) || (opts.wsId ? e.wsId === opts.wsId : false))
		: [];
	const useTask = wantTask && taskEvents.length > 0;
	const entries = aggregate(useTask ? taskEvents : all, opts.now).slice(0, opts.topN ?? WORKSET_TOP_N);
	return { view: useTask ? "task" : "workspace", fellBack: wantTask && !useTask, entries };
}

function aggregate(events: HotEvent[], now: number): HotEntry[] {
	const byPath = new Map<string, HotEvent[]>();
	for (const e of events) {
		const arr = byPath.get(e.path);
		if (arr) arr.push(e);
		else byPath.set(e.path, [e]);
	}
	const out: HotEntry[] = [];
	for (const [path, evs] of byPath) {
		evs.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
		const last = evs[evs.length - 1]!;
		const lastMs = Date.parse(last.at);
		const ttl = ttlState(lastMs, now);
		if (ttl === "pruned") continue; // hard TTL 外不入投影
		const counts = { write: 0, read: 0, test: 0 };
		const kinds = new Set<HotKind>();
		let lastTestAt: string | undefined;
		for (const e of evs) {
			counts[e.kind]++;
			kinds.add(e.kind);
			if (e.kind === "test" && (!lastTestAt || e.at > lastTestAt)) lastTestAt = e.at;
		}
		out.push({
			path,
			score: scoreEvents(evs, now),
			lastSeen: last.at,
			lastSeenMs: lastMs,
			kinds: [...kinds],
			counts,
			...(lastTestAt ? { lastTestAt } : {}),
			...(last.taskId ? { taskId: last.taskId } : {}),
			...(last.wsId ? { wsId: last.wsId } : {}),
			ttl,
		});
	}
	out.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
	return out;
}

export const LOOKUP_DEFAULT_LIMIT = 10;
export const LOOKUP_MAX_LIMIT = 50;

export interface LookupResult extends WorksetView {
	limit: number;
}

/** lookup（工具/查询入口）：limit 默认 10、上限 50（v4 §9.1）。 */
export function lookupWorkset(agentDir: string, wsid: string, opts: BuildWorksetOpts & { limit?: number }): LookupResult {
	const limit = Math.max(1, Math.min(LOOKUP_MAX_LIMIT, Math.floor(opts.limit ?? LOOKUP_DEFAULT_LIMIT)));
	const view = buildWorkset(agentDir, wsid, opts);
	return { ...view, entries: view.entries.slice(0, limit), limit };
}
