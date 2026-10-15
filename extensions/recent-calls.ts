/**
 * recent-calls — 环路观测（`action:"recent-calls"`）核心纯函数 + 有界 IO
 *
 * 目标：给主会话一个只读探针，回答「某个 run 最近调了哪些工具 / 是否在原地打转」。
 *  - async subagent：读 run 记录里派发侧派生的环形明细（无 spawn 协议变更）；
 *  - task tab：有界读会话 JSONL 尾部，回填 toolCall / toolResult。
 *
 * 本模块**只含纯函数与最小同步 IO**，不注册工具、不改 index.ts。
 * 参照（形状，不 import 其 projector）：`extensions/runtime/transcript.ts#L733 readHead`、
 * `extensions/runtime/hydrate.ts#L179 truncateUtf8`。
 *
 * 约束：任何成功返回 ≤ `RECENT_CALLS_TOTAL_BYTES` 字节（UTF-8）；
 *       参数摘要绝不整段回吐（只保留键名 + 截断值）；never-throw 优先。
 */

import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { modePrefix, type LaunchMode } from "./launch.ts";
import { sessionBucketForCwd, type TabDispatchRecord } from "./tab-runs.ts";

// ── 硬常量（测试断言）─────────────────────────────────────────────

/** 单次 `recent-calls` 文本输出的硬字节上限。 */
export const RECENT_CALLS_TOTAL_BYTES = 1536;
/** 展示用参数摘要最大字符数（`args=`）。 */
export const ARGS_DIGEST_MAX_CHARS = 160;
/** 结果预览最大字符数（`result:`）。 */
export const RESULT_PREVIEW_MAX_CHARS = 120;
/** 请求条数上限 `n`。 */
export const RECENT_CALLS_N_MAX = 5;
/** 请求条数缺省 `n`。 */
export const RECENT_CALLS_N_DEFAULT = 3;
/** async 环形缓冲容量 K。 */
export const RECENT_CALLS_CAP = 8;
/** 比较用规范化摘要最大字符数（落 run json 有界）。 */
export const RECENT_CALLS_NORM_MAX_CHARS = 512;
/** 尾部读取的字节上限（256KB）。 */
export const TAIL_READ_MAX_BYTES = 262144;
/** 头部读取的字节上限（64KB；定位 tab 会话时用）。 */
export const HEAD_READ_MAX_BYTES = 65536;

// 计划/任务书里出现过的别名（保持兼容，值同主名）。
export const MAX_TOTAL_BYTES = RECENT_CALLS_TOTAL_BYTES;
export const MAX_ARGS_DIGEST = ARGS_DIGEST_MAX_CHARS;
export const MAX_RESULT_PREVIEW = RESULT_PREVIEW_MAX_CHARS;
export const MAX_N = RECENT_CALLS_N_MAX;
export const DEFAULT_N = RECENT_CALLS_N_DEFAULT;
export const RING_K = RECENT_CALLS_CAP;

// ── 类型 ─────────────────────────────────────────────────────────

/** 一次工具调用的有界元数据（环形缓冲元素 / tab 尾部提取结果）。 */
export interface RecentCallEntry {
	tool: string;
	/** 规范化参数摘要（键排序、空白折叠；用于相等比较）。截断至 ≤512 字符。 */
	argsDigest: string;
	/** ISO8601 时间戳。 */
	ts: string;
	/** 触发该调用的 assistant 回合序号（1-based）。 */
	turn: number;
	/** tab 路径回填 / async 视事件可得性回填；缺失时显示 "(unavailable)"。 */
	resultPreview?: string;
	/** 与下一条 ts 差（async）或 toolResult ts 差（tab）；末条/缺失 → undefined。 */
	durationMs?: number;
}

/** loopGuard 配置（从 config.json 归一化而来）。 */
export interface LoopGuardConfig {
	enabled: boolean;
	threshold: number;
	action: "warn" | "kill";
}

/** 取数/解析失败原因（不静默）。 */
export type RecentCallsReason = "not-found" | "no-session" | "unreadable" | "ambiguous" | "no-detail";

// ── 字符串 / 摘要纯函数 ───────────────────────────────────────────

/** 折叠内部空白并去首尾空白（比较与展示共用）。 */
function collapseWs(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

/**
 * 按 UTF-8 字节安全截断并追加 “…” 标记。
 * 参照 `extensions/runtime/hydrate.ts#L179 truncateUtf8`（未 export）的字符边界回退，
 * 但**预留省略标记字节**（hydrate 版会把 `…[truncated]` 追加到上限之外，本函数保证
 * 返回值 `Buffer.byteLength(out,"utf8") <= maxBytes`，否则 #T8「argsDigest≤160」不成立）。
 * 保证不切出半个多字节字符；maxBytes 小于标记字节且无正文可留时退化为空串。
 */
export function truncateUtf8(s: string, maxBytes: number): string {
	const bytes = new TextEncoder().encode(s);
	if (bytes.length <= maxBytes) return s;
	const marker = "…";
	const markerBytes = Buffer.byteLength(marker, "utf8");
	let end = Math.max(0, maxBytes - markerBytes);
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
	const body = new TextDecoder().decode(bytes.slice(0, end));
	return maxBytes - Buffer.byteLength(body, "utf8") >= markerBytes ? body + marker : body;
}

/** 敏感键名（凭据硬规则）：键名含凭据词 → 值一律 `***`，绝不把凭据片段/前缀写进 digest。 */
const SENSITIVE_KEY_RE = /authorization|token|password|secret|api[_-]?key/i;

// 2026-10-16 二轮必修（值侧凭据扫描）：非敏感键名值内的凭据片段 + 工具回显 resultPreview
// 都必须同样脱敏（独立探针实测 3 条 secret 全部泄漏）。
// 模式：`Bearer <非空白>` / `sk-<≥8 字母数字>` / `token|password|api_key=|:<值>` → `***`。
const CREDENTIAL_VALUE_RE = /Bearer\s+\S+|sk-[A-Za-z0-9]{8,}|\b(?:token|password|api[_-]?key)\s*[=:]\s*\S+/gi;

/** 值侧凭据脱敏：字符串中的凭据模式一律替换为 `***`（所有输出路径共用）。 */
export function maskCredentials(s: string): string {
	return s.replace(CREDENTIAL_VALUE_RE, "***");
}

/** 单个值 → 展示片段（string 折叠+截断；object 只列键名）。敏感键一律 mask；值内凭据片段同样脱敏。 */
function digestValue(key: string, v: unknown): string {
	if (SENSITIVE_KEY_RE.test(key)) return "***";
	if (typeof v === "string") return maskCredentials(truncateUtf8(collapseWs(v), 40));
	if (v === null) return "null";
	if (Array.isArray(v)) return `[${v.length}]`;
	if (typeof v === "object") return `{${Object.keys(v as Record<string, unknown>).sort().join(",")}}`;
	return String(v);
}

/**
 * 展示用参数摘要：只保留键名 + 截断值（`k=v; k2=v2`），绝不整段回吐。
 * 非对象 → String(args)；键排序；总长 ≤ ARGS_DIGEST_MAX_CHARS。
 */
export function digestArgs(args: unknown): string {
	if (args === null || typeof args !== "object") {
		return truncateUtf8(collapseWs(maskCredentials(String(args ?? ""))), ARGS_DIGEST_MAX_CHARS);
	}
	if (Array.isArray(args)) return truncateUtf8(`[${args.length}]`, ARGS_DIGEST_MAX_CHARS);
	const rec = args as Record<string, unknown>;
	const parts: string[] = [];
	for (const k of Object.keys(rec).sort()) parts.push(`${k}=${digestValue(k, rec[k])}`);
	return truncateUtf8(collapseWs(parts.join("; ")), ARGS_DIGEST_MAX_CHARS);
}

/** 递归稳定化：键排序 + 字符串折叠空白（其余 JSON 原样）。 */
function stableValue(v: unknown): unknown {
	if (typeof v === "string") return collapseWs(v);
	if (Array.isArray(v)) return v.map(stableValue);
	if (v !== null && typeof v === "object") {
		const rec = v as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const k of Object.keys(rec).sort()) out[k] = stableValue(rec[k]);
		return out;
	}
	return v;
}

/**
 * 比较用规范化摘要（判重）。对象 → 键递归排序 + 空白折叠后稳定序列化；
 * 字符串入参（async 环形已存的 argsDigest）→ 仅折叠空白，幂等友好。
 * 结果 ≤ RECENT_CALLS_NORM_MAX_CHARS。
 */
export function normalizeArgsDigest(args: unknown): string {
	if (typeof args === "string") return truncateUtf8(collapseWs(args), RECENT_CALLS_NORM_MAX_CHARS);
	let s: string;
	try {
		s = JSON.stringify(stableValue(args ?? null)) ?? "";
	} catch {
		s = String(args);
	}
	return truncateUtf8(s, RECENT_CALLS_NORM_MAX_CHARS);
}

/** 环形 push：超容量则丢最旧（纯数组操作，不改文件）。 */
export function pushRecentCall(ring: RecentCallEntry[], entry: RecentCallEntry, cap: number = RECENT_CALLS_CAP): void {
	ring.push(entry);
	while (ring.length > cap) ring.shift();
}

// ── 解析 / 提取 ─────────────────────────────────────────────────

function asRec(v: unknown): Record<string, unknown> | null {
	return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** 拼接 content[] 中 text 分片（镜像 transcript.ts#L251 joinTextParts）。 */
function joinText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const texts: string[] = [];
	for (const p of content) {
		const rec = asRec(p);
		if (rec && rec.type === "text" && typeof rec.text === "string") texts.push(rec.text);
	}
	return texts.join("\n\n");
}

/** 取数组尾部至多 n 项（保持原序）。 */
function tail<T>(arr: T[], n: number): T[] {
	return arr.slice(Math.max(0, arr.length - Math.max(0, n)));
}

/** `n` 夹紧到 [1, RECENT_CALLS_N_MAX]；非法值回落 DEFAULT。 */
export function clampN(n: unknown): number {
	if (typeof n !== "number" || !Number.isFinite(n)) return RECENT_CALLS_N_DEFAULT;
	const i = Math.trunc(n);
	if (i < 1) return 1;
	if (i > RECENT_CALLS_N_MAX) return RECENT_CALLS_N_MAX;
	return i;
}

/**
 * 解析会话 JSONL 行 → 按时间升序的工具调用（toolResult 回填 resultPreview/durationMs）。
 * 兼容两种形状：完整会话条目（`type:"message"` + `message.role`）与投影后的扁平
 * toolCall 行（`type:"toolCall"`）。坏行/无法解析行静默丢弃（有界优先）。
 */
export function parseRecentCalls(jsonlLines: string[]): RecentCallEntry[] {
	const entries: RecentCallEntry[] = [];
	const byCallId = new Map<string, RecentCallEntry>();
	let turn = 0;
	for (const raw of jsonlLines) {
		const line = raw.trim();
		if (!line) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		const rec = asRec(parsed);
		if (!rec) continue;
		// 扁平投影行
		if (rec.type === "toolCall") {
			const callId = typeof rec.callId === "string" ? rec.callId : typeof rec.id === "string" ? rec.id : "";
			const ts = typeof rec.at === "string" ? rec.at : typeof rec.timestamp === "string" ? rec.timestamp : "";
			const e: RecentCallEntry = {
				tool: typeof rec.name === "string" ? rec.name : "",
				argsDigest: normalizeArgsDigest(rec.arguments),
				ts,
				turn: typeof rec.turnIndex === "number" ? rec.turnIndex : turn,
			};
			if (callId) byCallId.set(callId, e);
			entries.push(e);
			continue;
		}
		const msg = asRec(rec.message) ?? rec;
		const role = typeof msg.role === "string" ? msg.role : undefined;
		const ts =
			typeof rec.timestamp === "string" ? rec.timestamp : typeof msg.timestamp === "string" ? msg.timestamp : "";
		if (role === "assistant") {
			turn += 1;
			const parts = Array.isArray(msg.content) ? msg.content : [];
			for (const p of parts) {
				const pr = asRec(p);
				if (!pr || pr.type !== "toolCall") continue;
				const e: RecentCallEntry = {
					tool: typeof pr.name === "string" ? pr.name : "",
					argsDigest: normalizeArgsDigest(pr.arguments),
					ts,
					turn,
				};
				if (typeof pr.id === "string" && pr.id) byCallId.set(pr.id, e);
				entries.push(e);
			}
		} else if (role === "toolResult") {
			const callId = typeof msg.toolCallId === "string" ? msg.toolCallId : "";
			const e = callId ? byCallId.get(callId) : undefined;
			if (!e) continue;
			e.resultPreview = truncateUtf8(maskCredentials(joinText(msg.content)), RESULT_PREVIEW_MAX_CHARS);
			const d = Date.parse(ts) - Date.parse(e.ts);
			if (Number.isFinite(d) && d >= 0) e.durationMs = d;
		}
	}
	return entries;
}

// ── 有界字节 IO（同步；never-throw）───────────────────────────────

export interface HeadRead {
	lines: string[];
	truncated: boolean;
}

export interface TailRead {
	lines: string[];
	truncated: boolean;
	bytesRead: number;
}

/**
 * 从文件头有界读取 ≤maxBytes 字节并切行。
 * 镜像 `extensions/runtime/transcript.ts#L733 readHead` 的 `openSync`+`readSync` 范式
 * （未 export，就地实现）。多字节字符用 StringDecoder 处理；窗口截断时丢尾段半截行。
 */
export function readHeadBytes(path: string, maxBytes: number = HEAD_READ_MAX_BYTES): HeadRead {
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch {
		return { lines: [], truncated: false };
	}
	try {
		const buf = Buffer.alloc(maxBytes);
		let n = 0;
		try {
			n = readSync(fd, buf, 0, maxBytes, 0);
		} catch {
			return { lines: [], truncated: false };
		}
		if (n <= 0) return { lines: [], truncated: false };
		const text = new StringDecoder("utf8").write(buf.subarray(0, n));
		const truncated = n === maxBytes;
		let lines = text.split("\n");
		if (truncated && !text.endsWith("\n")) lines = lines.slice(0, -1); // 丢半截尾行
		return { lines: lines.filter((l: string) => l.trim().length > 0), truncated };
	} finally {
		try {
			closeSync(fd);
		} catch {
			/* ignore */
		}
	}
}

/**
 * 从文件尾有界读取 ≤maxBytes 字节并切行。
 * start>0 时丢弃首个不完整行（下一个 `\n` 之后开始），避免半截 JSON。
 * 截断且无完整行 → lines=[]（调用方按 unreadable/空处理）。
 */
export function readTailBytes(path: string, maxBytes: number = TAIL_READ_MAX_BYTES): TailRead {
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch {
		return { lines: [], truncated: false, bytesRead: 0 };
	}
	try {
		let size: number;
		try {
			size = statSync(path).size;
		} catch {
			return { lines: [], truncated: false, bytesRead: 0 };
		}
		const start = Math.max(0, size - maxBytes);
		const len = size - start;
		if (len <= 0) return { lines: [], truncated: false, bytesRead: 0 };
		const buf = Buffer.alloc(len);
		let n = 0;
		try {
			n = readSync(fd, buf, 0, len, start);
		} catch {
			return { lines: [], truncated: false, bytesRead: 0 };
		}
		let text = new StringDecoder("utf8").write(buf.subarray(0, n));
		const truncated = start > 0;
		if (truncated) {
			const nl = text.indexOf("\n");
			text = nl >= 0 ? text.slice(nl + 1) : ""; // 丢半截首行
		}
		const lines = text.split("\n").filter((l: string) => l.trim().length > 0);
		return { lines, truncated, bytesRead: n };
	} finally {
		try {
			closeSync(fd);
		} catch {
			/* ignore */
		}
	}
}

// ── 两类目标的取数 ─────────────────────────────────────────────

/** 统计窗口内 assistant 回合数（与 `parseRecentCalls` 的 turn 计数同语义：`role==="assistant"` 的消息行各计 1，
 *  扁平 `toolCall` 投影行不计；坏行/无法解析行静默跳过）。这是 tab 路径 turnClock 的来源：
 *  窗口相对计数是真实会话回合计数的**下界**（尾部窗口可能从会话中段开始），偏保守不虚报。 */
export function countAssistantTurns(jsonlLines: string[]): number {
	let turns = 0;
	for (const raw of jsonlLines) {
		const line = raw.trim();
		if (!line) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		const rec = asRec(parsed);
		if (!rec) continue;
		if (rec.type === "toolCall") continue; // 扁平投影行非 assistant 回合（parseRecentCalls 亦不计）
		const msg = asRec(rec.message) ?? rec;
		if (typeof msg.role === "string" && msg.role === "assistant") turns += 1;
	}
	return turns;
}

export interface TabCallsWindow {
	/** 尾部窗口内最近 n 次工具调用（newest-last）。 */
	entries: RecentCallEntry[];
	/** 窗口内 assistant 回合总数（窗口相对计数；接线层作为 tab 的 turnClock）。 */
	windowTurns: number;
}

/**
 * tab：有界读会话尾部（单次读取，entries 与 windowTurns 同窗口不二次 IO）。
 * 2026-10-16：原 `collectTabCalls` 只返回 entries，接线层 `turnClock = lastToolTurn` ⇒ 差值恒 0，
 * tab 路径 `no_progress` 永不可触发；现同时回传窗口内 assistant 回合数供 turnClock 使用。
 */
export function collectTabWindow(
	sessionPath: string,
	n: number,
	deps?: { readTail?: (p: string, m: number) => TailRead },
): TabCallsWindow {
	const read = (deps?.readTail ?? readTailBytes)(sessionPath, TAIL_READ_MAX_BYTES);
	if (read.lines.length === 0) return { entries: [], windowTurns: 0 };
	return { entries: tail(parseRecentCalls(read.lines), clampN(n)), windowTurns: countAssistantTurns(read.lines) };
}

/** async run 环形明细的最小形状（避免 import index.ts）。 */
export interface AsyncCallsSource {
	recentCalls?: RecentCallEntry[];
	lastAssistantTurn?: number;
}

/** 取数后输出为 newest-last → 展示层需 newest-first（见 formatRecentCalls）。 */
export function collectAsyncCalls(record: AsyncCallsSource | null | undefined, n: number): RecentCallEntry[] {
	const calls = record?.recentCalls;
	if (!Array.isArray(calls) || calls.length === 0) return [];
	const entries: RecentCallEntry[] = calls.map((e) => ({ ...e }));
	for (let i = 0; i < entries.length - 1; i++) {
		if (entries[i].durationMs === undefined) {
			const d = Date.parse(entries[i + 1].ts) - Date.parse(entries[i].ts);
			if (Number.isFinite(d) && d >= 0) entries[i].durationMs = d;
		}
	}
	return tail(entries, clampN(n));
}

// ── tab 会话文件定位 ───────────────────────────────────────────

export interface LocateTabSessionDeps {
	readHead?: (p: string, m: number) => HeadRead;
	listDir?: (d: string) => string[];
	stat?: (p: string) => { mtimeMs: number };
	joinPath?: (a: string, b: string) => string;
}

export interface LocatedTabSession {
	path: string | null;
	ambiguous: boolean;
	candidates: string[];
	reason?: RecentCallsReason;
}

/** 在头部行中找首个 user 消息是否命中 taskId+mode 前缀；顺带取 header 时间戳。 */
function matchHead(lines: string[], prefix: string): { matched: boolean; sessionTimestamp?: string } {
	let header: Record<string, unknown> | null = null;
	for (const raw of lines) {
		const line = raw.trim();
		if (!line) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		const rec = asRec(parsed);
		if (!rec) continue;
		if (header === null) header = rec;
		if (rec.type !== "message") continue;
		const msg = asRec(rec.message);
		if (!msg || msg.role !== "user") continue;
		const firstLine = joinText(msg.content).split(/\r?\n/)[0]?.trim() ?? "";
		if (firstLine === prefix || firstLine.startsWith(`${prefix} `)) {
			const ts = header && typeof header.timestamp === "string" ? header.timestamp : undefined;
			return { matched: true, ...(ts ? { sessionTimestamp: ts } : {}) };
		}
	}
	return { matched: false };
}

/**
 * 定位 tab 派发对应的会话 JSONL（有界头部读 + 时间窗消歧）。
 * 与 `probeSessionsForDispatch` 同时间窗语义；>1 个同分候选 → ambiguous。
 * never-throw。
 */
export function locateTabSession(
	dispatch: TabDispatchRecord,
	sessionsRoot: string,
	deps: LocateTabSessionDeps = {},
): LocatedTabSession {
	const readHead = deps.readHead ?? readHeadBytes;
	const listDir = deps.listDir ?? ((d: string) => readdirSync(d));
	const statP = deps.stat ?? ((p: string) => statSync(p));
	const joinPath = deps.joinPath ?? join;
	const bucket = joinPath(sessionsRoot, sessionBucketForCwd(dispatch.cwd));
	let files: string[];
	try {
		files = listDir(bucket).filter((f: string) => f.endsWith(".jsonl"));
	} catch {
		return { path: null, ambiguous: false, candidates: [], reason: "no-session" };
	}
	const dispatchedMs = Date.parse(dispatch.dispatchedAt);
	const prefix = modePrefix(dispatch.taskId, dispatch.mode as LaunchMode);
	const cands: { path: string; ts: number }[] = [];
	for (const f of files) {
		const full = joinPath(bucket, f);
		if (!Number.isNaN(dispatchedMs)) {
			let mtime = Number.NaN;
			try {
				mtime = statP(full).mtimeMs;
			} catch {
				/* stat 失败视为无法判定，保留候选 */
			}
			if (!Number.isNaN(mtime) && mtime < dispatchedMs - 60_000) continue;
		}
		const head = readHead(full, HEAD_READ_MAX_BYTES);
		if (head.lines.length === 0) continue;
		const m = matchHead(head.lines, prefix);
		if (!m.matched) continue;
		const ts = m.sessionTimestamp ? Date.parse(m.sessionTimestamp) : Number.NaN;
		cands.push({ path: full, ts: Number.isNaN(ts) ? 0 : ts });
	}
	if (cands.length === 0) return { path: null, ambiguous: false, candidates: [], reason: "no-session" };
	cands.sort((a, b) => b.ts - a.ts);
	const ambiguous = cands.length > 1 && cands[0].ts === cands[1].ts;
	const candidates = cands.map((c) => c.path);
	if (ambiguous) return { path: null, ambiguous: true, candidates, reason: "ambiguous" };
	return { path: cands[0].path, ambiguous: false, candidates };
}

// ── 判定（repeating / no_progress）───────────────────────────────

export type Verdict = "ok" | "repeating" | "no_progress";

/**
 * 判定环路（终段优先）。
 *  - repeating：尾段连续 ≥thr 次同 tool + 同规范化 args；
 *  - no_progress：turnClock - lastToolTurn ≥ thr 且 turnClock ≥ thr；
 *  - 优先级 repeating > no_progress > ok。
 */
export function classifyLoop(
	entries: RecentCallEntry[],
	turnInfo: { turnClock: number; lastToolTurn: number },
	threshold: number = 3,
): { verdict: Verdict; basis: string; hint: string } {
	const thr = Number.isFinite(threshold) ? Math.max(1, Math.trunc(threshold)) : 3;
	const m = entries.length;
	if (m >= thr) {
		const last = entries[m - 1];
		const normLast = normalizeArgsDigest(last.argsDigest);
		let start = m - 1;
		while (start > 0) {
			const prev = entries[start - 1];
			if (prev.tool !== last.tool || normalizeArgsDigest(prev.argsDigest) !== normLast) break;
			start -= 1;
		}
		const segLen = m - start;
		if (segLen >= thr) {
			return {
				verdict: "repeating",
				basis: `repeating: ${last.tool}×${segLen} same args (turn ${entries[start].turn}-${last.turn})`,
				hint: "steer 注入纠偏消息打断；持续则 kill 终止",
			};
		}
	}
	const turnClock = Number.isFinite(turnInfo.turnClock) ? turnInfo.turnClock : 0;
	const lastToolTurn = Number.isFinite(turnInfo.lastToolTurn) ? turnInfo.lastToolTurn : 0;
	if (turnClock - lastToolTurn >= thr && turnClock >= thr) {
		return {
			verdict: "no_progress",
			basis: `no_progress: ${turnClock - lastToolTurn} turns without tool (last tool turn ${lastToolTurn}, now ${turnClock})`,
			hint: "steer 注入新指令；无响应则 kill",
		};
	}
	return { verdict: "ok", basis: `ok: last ${m} call(s), no tail repetition`, hint: "继续观察" };
}

// ── loopGuard 配置归一化（仿 normalizeMasterSuccession）────────────

export const DEFAULT_LOOP_GUARD: LoopGuardConfig = { enabled: false, threshold: 3, action: "warn" };

/** never-throw：缺省/垃圾 → 默认；enabled 严格 === true；threshold clamp [2,10]；action 仅 warn|kill。 */
export function normalizeLoopGuard(raw: unknown): LoopGuardConfig {
	if (typeof raw !== "object" || raw === null) return { ...DEFAULT_LOOP_GUARD };
	const o = raw as Record<string, unknown>;
	let threshold = DEFAULT_LOOP_GUARD.threshold;
	const rawT = typeof o.threshold === "number" ? o.threshold : Number.NaN;
	if (Number.isFinite(rawT)) {
		threshold = Math.min(10, Math.max(2, Math.trunc(rawT)));
	}
	return {
		enabled: o.enabled === true, // fail-closed
		threshold,
		action: o.action === "kill" ? "kill" : "warn", // kill 须显式且合法
	};
}

// ── 输出组装（≤RECENT_CALLS_TOTAL_BYTES 字节硬上限）───────────────

export interface RecentCallsFormatInput {
	id: string;
	source: "async" | "tab";
	agent?: string;
	model?: string;
	status?: string;
	/** 请求条数（header 里的分母）。 */
	n: number;
	loopGuard?: LoopGuardConfig;
	/** 已确认命中的依据（index 接线判定）；给定且 enabled 时渲染 loopGuard 行。 */
	loopGuardBasis?: string;
}

export interface RecentCallsVerdict {
	verdict: Verdict | "unknown";
	basis: string;
	hint: string;
}

type CallBlock = { tool: string; ts: string; turn: number; dur: string; digest: string; result?: string; argMax: number };

function byteLen(s: string): number {
	return Buffer.byteLength(s, "utf8");
}

/** 硬字节切割：预留 “…” 标记字节，保证结果 ≤maxBytes。 */
function hardCapUtf8(s: string, maxBytes: number): string {
	if (byteLen(s) <= maxBytes) return s;
	const marker = "…";
	const bytes = new TextEncoder().encode(s);
	let end = Math.max(0, maxBytes - byteLen(marker));
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
	return new TextDecoder().decode(bytes.slice(0, end)) + marker;
}

function formatDur(d: number | undefined): string {
	return typeof d === "number" && Number.isFinite(d) ? String(Math.trunc(d)) : "-";
}

/**
 * 组装纯文本输出（newest-first）。先 per-field 截断，再总长截断：
 * 删最旧 result → 缩最旧 args 至 64 → 硬切至 1536 字节。
 * 不变式：返回 ≤RECENT_CALLS_TOTAL_BYTES。
 */
export function formatRecentCalls(
	input: RecentCallsFormatInput,
	entries: RecentCallEntry[],
	verdict: RecentCallsVerdict,
): string {
	const head = [`recent-calls ${input.id || "-"}`, `[source=${input.source}]`];
	if (input.agent) head.push(`[agent=${truncateUtf8(input.agent, 40)}]`);
	if (input.model) head.push(`[model=${truncateUtf8(input.model, 60)}]`);
	if (input.status) head.push(`[status=${truncateUtf8(input.status, 32)}]`);
	const blocks: CallBlock[] = entries
		.slice()
		.reverse() // newest-first
		.map((e) => ({
			tool: e.tool,
			ts: e.ts,
			turn: e.turn,
			dur: formatDur(e.durationMs),
			digest: e.argsDigest,
			...(e.resultPreview !== undefined ? { result: e.resultPreview } : {}),
			argMax: ARGS_DIGEST_MAX_CHARS,
		}));
	head.push(`[n=${blocks.length}/${input.n}]`);
	const header = head.join(" ");
	const verdictLine = `verdict: ${verdict.verdict} (basis: ${verdict.basis})`;
	const hintLine = `hint: ${verdict.hint}`;
	const lgLine =
		input.loopGuard?.enabled && input.loopGuardBasis
			? `[loopGuard: ${input.loopGuard.action} threshold=${input.loopGuard.threshold} — ${input.loopGuardBasis}]`
			: null;
	const render = (bs: CallBlock[]): string => {
		const lines = [header, verdictLine, "calls (newest first):"];
		bs.forEach((b, i) => {
			lines.push(`  ${i + 1}) tool=${b.tool} ts=${b.ts} turn=${b.turn} dur=${b.dur} args=${truncateUtf8(maskCredentials(b.digest), b.argMax)}`);
			if (b.result !== undefined) lines.push(`     result: ${truncateUtf8(maskCredentials(b.result), RESULT_PREVIEW_MAX_CHARS)}`);
		});
		lines.push(hintLine);
		if (lgLine) lines.push(lgLine);
		return lines.join("\n");
	};
	for (let i = blocks.length - 1; i >= 0 && byteLen(render(blocks)) > RECENT_CALLS_TOTAL_BYTES; i--) {
		delete blocks[i].result; // 先删最旧 result
	}
	for (let i = blocks.length - 1; i >= 0 && byteLen(render(blocks)) > RECENT_CALLS_TOTAL_BYTES; i--) {
		blocks[i].argMax = 64; // 再缩最旧 args
	}
	return hardCapUtf8(render(blocks), RECENT_CALLS_TOTAL_BYTES);
}

/** 错误/边界响应（同样 ≤1536 字节；不静默）。 */
export function formatRecentCallsError(reason: RecentCallsReason, id: string = "", detail?: string): string {
	const body = `recent-calls ${id || "-"} error: ${reason}`;
	return hardCapUtf8(detail ? `${body}\n${detail}` : body, RECENT_CALLS_TOTAL_BYTES);
}
