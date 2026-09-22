/**
 * recent-scopes.ts — master 与生俱来的「最近活跃仓库」感知（2026-09-22）。
 *
 * 立场：7 日内哪个仓库动过，不是新功能，而是 master 本来就该知道的事。三本账全在本地磁盘：
 *   ① `state/scope-liveness/*.json`（scope owner 心跳：scopeKey + updatedAt）；
 *   ② `tab-runs/*.json`（派发表：cwd + dispatchedAt + taskId）；
 *   ③ `sessions/<cwd 编码>/`（pi 会话文件 mtime）。
 * 本模块只做一件事：把三处按“仓库”归并、去噪、按 recency 排序。纯函数，never-throw。
 *
 * 去噪规则（默认排除测试/临时路径，可用 includeNoise 关掉）：
 *   Temp（含大小写）、tfl-、tfl-wt、/.pi/、launch-prompts、node_modules。
 * sessions 目录名是 pi 的 cwd 编码（`--G--code-GreenCAD--`）：`--X--` 开头 = 盘符，
 * 其余 `--` 为路径分隔。解码只为展示，失败则原样回显（永不抛）。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface RecentScope {
	/** 展示键：scope 名或仓库路径 */
	key: string;
	/** 最近活跃时间（ISO） */
	lastActiveAt: string;
	/** 证据来源（liveness / tab:<taskId> / session，去重） */
	sources: string[];
}

export interface RecentScopesOptions {
	/** 回看窗口毫秒（缺省 7 天） */
	sinceMs?: number;
	/** 现在（测试注入） */
	now?: number;
	/** ~/.pi/agent 根（缺省 homedir 下） */
	agentDir?: string;
	/** 是否包含测试/临时噪音（缺省 false = 排除） */
	includeNoise?: boolean;
}

const DEFAULT_SINCE_MS = 7 * 24 * 60 * 60 * 1000;

/** 噪音路径片段（测试/临时目录；真实仓库名几乎不可能命中） */
const NOISE_RE = /Temp|tfl-|tfl-wt|\/\.pi\/|\\.pi\\|launch-prompts|node_modules/i;

function isNoise(s: string, includeNoise: boolean): boolean {
	return !includeNoise && NOISE_RE.test(s);
}

/** pi sessions 目录名 → 可读路径（`--G--code-GreenCAD--` → `G:/code/GreenCAD`；失败原样） */
export function decodeSessionsDirName(name: string): string {
	try {
		if (!name.startsWith("--") || !name.endsWith("--")) return name;
		const inner = name.slice(2, -2);
		const parts = inner.split("--");
		if (parts.length >= 2 && /^[A-Za-z]$/.test(parts[0]!)) {
			return `${parts[0]}:/${parts.slice(1).join("/")}`;
		}
		return parts.join("/");
	} catch {
		return name;
	}
}

function readJsonFile(path: string): Record<string, unknown> | null {
	try {
		const raw = readFileSync(path, "utf8");
		const v: unknown = JSON.parse(raw);
		if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
		return null;
	} catch {
		return null;
	}
}

function toMs(v: unknown): number | null {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v === "string" && v) {
		const t = Date.parse(v);
		return Number.isFinite(t) ? t : null;
	}
	return null;
}

/**
 * 列出回看窗口内活跃过的仓库/scope（按最近活跃倒序）。never-throw：任一账本不可读
 * 只跳过该账本，不整体失败；空目录/空结果返回 []。
 */
export function listRecentScopes(opts: RecentScopesOptions = {}): RecentScope[] {
	const out = new Map<string, { last: number; sources: Set<string> }>();
	try {
		const now = opts.now ?? Date.now();
		const since = now - (opts.sinceMs ?? DEFAULT_SINCE_MS);
		const agentDir = opts.agentDir ?? join(homedir(), ".pi", "agent");
		const includeNoise = opts.includeNoise ?? false;
		const touch = (key: string, atMs: number | null, source: string): void => {
			if (atMs === null || atMs < since || atMs > now + 60_000) return;
			if (isNoise(key, includeNoise)) return;
			const e = out.get(key) ?? { last: 0, sources: new Set<string>() };
			if (atMs > e.last) e.last = atMs;
			e.sources.add(source);
			out.set(key, e);
		};

		// ① scope-liveness 心跳
		try {
			const dir = join(agentDir, "runtime", "state", "scope-liveness");
			for (const f of readdirSync(dir)) {
				if (!f.endsWith(".json")) continue;
				const r = readJsonFile(join(dir, f));
				if (!r) continue;
				const key = typeof r.scopeKey === "string" && r.scopeKey ? r.scopeKey : f.replace(/\.json$/, "");
				touch(`scope:${key}`, toMs(r.updatedAt ?? r.startedAt), "liveness");
			}
		} catch {
			/* 账本缺失只跳过 */
		}

		// ② tab-runs 派发表
		try {
			const dir = join(agentDir, "tab-runs");
			for (const f of readdirSync(dir)) {
				if (!f.endsWith(".json") || f.includes(".state.") || f.includes(".result.")) continue;
				const r = readJsonFile(join(dir, f));
				if (!r) continue;
				const cwd = typeof r.cwd === "string" && r.cwd ? r.cwd : null;
				if (!cwd) continue;
				const task = typeof r.taskId === "string" && r.taskId ? r.taskId : "?";
				touch(cwd, toMs(r.dispatchedAt), `tab:${task}`);
			}
		} catch {
			/* 账本缺失只跳过 */
		}

		// ③ sessions/<cwd 编码>/ 会话文件 mtime
		try {
			const dir = join(agentDir, "sessions");
			for (const d of readdirSync(dir)) {
				let latest = 0;
				try {
					const dd = join(dir, d);
					for (const f of readdirSync(dd)) {
						try {
							const m = statSync(join(dd, f)).mtimeMs;
							if (m > latest) latest = m;
						} catch {
							/* 单文件失败跳过 */
						}
					}
				} catch {
					continue;
				}
				if (latest > 0) touch(decodeSessionsDirName(d), latest, "session");
			}
		} catch {
			/* 账本缺失只跳过 */
		}

		return [...out.entries()]
			.map(([key, e]) => ({
				key,
				lastActiveAt: new Date(e.last).toISOString(),
				sources: [...e.sources].sort(),
			}))
			.sort((a, b) => (a.lastActiveAt < b.lastActiveAt ? 1 : -1));
	} catch {
		return [...out.entries()].map(([key, e]) => ({
			key,
			lastActiveAt: new Date(e.last).toISOString(),
			sources: [...e.sources].sort(),
		}));
	}
}

/** master-status 展示用一行摘要（`key(MM-DD), ...`，缺省 Top 8） */
export function formatRecentScopes(items: RecentScope[], limit = 8): string {
	if (items.length === 0) return "(none in window)";
	return items
		.slice(0, limit)
		.map((it) => `${it.key}(${it.lastActiveAt.slice(5, 10)})`)
		.join(", ");
}
