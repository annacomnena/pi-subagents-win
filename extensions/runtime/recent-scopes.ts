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

/**
 * 精确路径规范化（仅用于 tab-runs 的真实 cwd 合并）：统一斜杠、盘符小写、去尾部分隔符。
 * 刻意**保留**内部 `-` 与路径边界——`C:/a-b/c` 与 `C:/a/b-c` 必须保持为两条
 * （P0：归一化键删分隔符会导致不同仓库误合并，已复现）。Windows 下全小写安全
 * （同盘同路径大小写不敏感）；POSIX 大小写敏感路径理论上可误合并，本工具以 Windows 为主，
 * 已在注释声明。
 */
export function normalizeExactPath(p: string): string {
	let s = p.replace(/\\/g, "/");
	s = s.replace(/^[A-Za-z]:/, (m) => m.toLowerCase());
	s = s.replace(/\/+$/, "");
	return s.toLowerCase();
}

/**
 * 路径噪音判定（按路径段匹配，非子串）：任一段（`/`/`\\` 切分后，不分大小写）满足即为噪音——
 *   - 整段 == `temp` / `tmp`（临时目录；`TemplateEngine`/`temporal` 等含子串但段不同，不误杀）；
 *   - 整段匹配 trace 测试命名 `^tfl-([a-z0-9]+-test-|wt($|[-_]))`（如 `tfl-c6-test-x`、`tfl-wt`；
 *     合法的 `my-tfl-tools` 等不以该模式开头的段不受影响）；
 *   - 整段 == `launch-prompts` / `node_modules`；
 *   - 路径含 `/.pi/` 或 `\.pi\`（pi 内部数据目录）。
 * `scope:` 键永不参与噪音判定——liveness 是显式 owner 心跳，不是文件系统噪音
 * （如 scope 名恰为 `Temp` 也是真实 scope，master 应当知道）。
 */
export function isNoisePath(p: string): boolean {
	const low = p.toLowerCase();
	if (low.includes("/.pi/") || low.includes("\\.pi\\")) return true;
	const segs = low.split(/[/\\]+/).filter((s) => s.length > 0);
	for (const s of segs) {
		if (s === "temp" || s === "tmp") return true;
		if (s === "launch-prompts" || s === "node_modules") return true;
		if (/^tfl-([a-z0-9]+-test-|wt($|[-_]))/.test(s)) return true;
	}
	return false;
}

/** pi sessions 目录名 → 可读路径（`--G--code-GreenCAD--` → `G:/code/GreenCAD`）。
 *
 * 注意 pi 编码本身有损：字面 `-`（如 `subagent-win`）与分隔符 `-` 不作区分，
 * 故本函数是最佳努力展示，不保证逐字符还原。精确路径以 tab-runs/liveness 的
 * 原始值为准（归并时见 normalizeExactPath）。失败原样回显，永不抛。 */
export function decodeSessionsDirName(name: string): string {
	try {
		if (!name.startsWith("--") || !name.endsWith("--")) return name;
		const inner = name.slice(2, -2);
		const parts = inner.split("--");
		if (parts.length >= 2 && /^[A-Za-z]$/.test(parts[0]!)) {
			// pi 真实形式：盘符双 `--`，其余单 `-`（有损，见上注）
			const rest = parts.slice(1).join("-").split("-").filter((s) => s.length > 0);
			return `${parts[0]}:/${rest.join("/")}`;
		}
		// sessionBucketForCwd 全单 `-` 形式：`--G-code-X--` → 首段单字母即盘符
		const m = /^([A-Za-z])-(.+)$/.exec(inner);
		if (m) {
			const rest = m[2]!.split("-").filter((s) => s.length > 0);
			return `${m[1]}:/${rest.join("/")}`;
		}
		return parts.join("/");
	} catch {
		return name;
	}
}

/**
 * （已删除 normalizeRepoKey，P0：删分隔符归并会把不同仓库压成一条。）
 * 合并统一用 normalizeExactPath（保留内部结构），见 touch。
 */

/**
 * sessions 解码回填：pi 编码有损（字面 `-` 被切散），解码串若在磁盘上不存在，
 * 按 join 数从少到多试不同分组（`a/b/c` → `a-b/c`、`a/b-c` → `a-b-c`），
 * 命中第一个存在的即返回。BFS 上限 maxChecks 次 existsSync（缺省 24），
 * 全不存在则保留解码串（证据有效性不受影响，只是展示欠精确）。never-throw。
 */
export function resolveDecodedPath(guess: string, maxChecks = 24): string {
	try {
		if (existsSync(guess)) return guess;
		const parts = guess.split("/");
		if (parts.length < 2) return guess;
		// 组合数由 k<=3 与 maxChecks 双重封顶（与 parts 深度无关；前导固定段多只影响单次 existsSync 成本）
		let checks = 0;
		const gaps = parts.length - 1;
		const build = (joinSet: Set<number>): string => {
			const out: string[] = [parts[0]!];
			for (let i = 0; i < gaps; i++) {
				if (joinSet.has(i)) out[out.length - 1] += `-${parts[i + 1]}`;
				else out.push(parts[i + 1]!);
			}
			return out.join("/");
		};
		// k=1..gaps：先少 join 后多 join；同 k 内优先尾部（仓库名多半在尾）
		for (let k = 1; k <= gaps && checks < maxChecks; k++) {
			const combos = gapCombinations(gaps, k);
		// 尾部优先：按最大 join 位置倒序
		combos.sort((a, b) => Math.max(...b) - Math.max(...a));
		for (const c of combos) {
			if (checks >= maxChecks) break;
			checks++;
			const cand = build(new Set(c));
			if (existsSync(cand)) return cand;
		}
		if (combos.length === 0) break;
		// 组合数过大（C(9,4)=126）时只试尾部优先的前 maxChecks 个，k 即停
		if (k >= 3) break;
		}
		return guess;
	} catch {
		return guess;
	}
}

/** C(n,k) 间隙组合（n<=9 才调，调用方已限深） */
function gapCombinations(n: number, k: number): number[][] {
	const out: number[][] = [];
	const rec = (start: number, acc: number[]): void => {
		if (acc.length === k) {
			out.push([...acc]);
			return;
		}
		for (let i = start; i < n; i++) {
			acc.push(i);
			rec(i + 1, acc);
			acc.pop();
		}
	};
	rec(0, []);
	return out;
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
	const out = new Map<string, { last: number; sources: Set<string>; display: string }>();
	try {
		const now = opts.now ?? Date.now();
		const since = now - (opts.sinceMs ?? DEFAULT_SINCE_MS);
		const agentDir = opts.agentDir ?? join(homedir(), ".pi", "agent");
		const includeNoise = opts.includeNoise ?? false;
		// touch 用归并键合并（P0：精确路径用 normalizeExactPath，保留内部结构，
		// 不同仓库永不互并；scope: 键自成命名空间，不与路径合并），但展示保留
		// 最精确的原始串（tab-runs 的真实 cwd 优先于 sessions 的有损解码）。
		const touch = (rawKey: string, atMs: number | null, source: string): void => {
			if (atMs === null || atMs < since || atMs > now + 60_000) return;
			const isScope = rawKey.startsWith("scope:");
			// P0：scope 心跳是显式信号，永不按路径噪音过滤；路径才走段级噪音判定
			if (!isScope && !includeNoise && isNoisePath(rawKey)) return;
			const mergeKey = isScope ? rawKey : `repo:${normalizeExactPath(rawKey)}`;
			const e = out.get(mergeKey) ?? { last: 0, sources: new Set<string>(), display: rawKey };
			if (atMs > e.last) e.last = atMs;
			// 展示优先级：含路径分隔符的精确串 > 纯解码猜测 > 短键
			const score = (s: string): number =>
				(s.includes("\\") ? 3 : 0) + (s.includes("/") ? 2 : 0) + (s.includes(":") ? 1 : 0) + Math.min(s.length / 64, 1);
			if (score(rawKey) > score(e.display)) e.display = rawKey;
			e.sources.add(source);
			out.set(mergeKey, e);
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
				if (latest > 0) touch(resolveDecodedPath(decodeSessionsDirName(d)), latest, "session");
			}
		} catch {
			/* 账本缺失只跳过 */
		}

		return [...out.entries()]
			.map(([, e]) => ({
				key: e.display,
				lastActiveAt: new Date(e.last).toISOString(),
				sources: [...e.sources].sort(),
			}))
			.sort((a, b) => (a.lastActiveAt < b.lastActiveAt ? 1 : -1));
	} catch {
		return [...out.entries()].map(([, e]) => ({
			key: e.display,
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

/**
 * 三账本是否至少其一存在（P0 返修：区分“窗口内无活动”与“无证据可读”）。
 * 调用方（recentScopesLine）：items 为空且三账本全缺席 → "(unknown)"；
 * 账本存在但窗口内无命中 → "(none in window)"。never-throw。
 */
export function anyLedgerPresent(agentDir?: string): boolean {
	try {
		const root = agentDir ?? join(homedir(), ".pi", "agent");
		return (
			existsSync(join(root, "sessions")) ||
			existsSync(join(root, "tab-runs")) ||
			existsSync(join(root, "runtime", "state", "scope-liveness"))
		);
	} catch {
		return false;
	}
}
