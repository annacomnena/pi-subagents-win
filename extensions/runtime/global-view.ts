/**
 * runtime/global-view.ts — 全局工作视野只读聚合（0923 计划 §2 首阶段）。
 *
 * 深模块：collector（只读扫描 + 归并）+ formatter（纯格式化），slash 与 tool
 * 共用同一查询 interface。never-throw：单文件坏只记 warnings，不整体失败。
 * GC apply / mailbox 执行链不在本模块内（gc 子命令只回用法 + disabled 提示）。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { normalizeExactPath, isNoisePath } from "./recent-scopes.ts";
import { localMasterAddress } from "./scope.ts";
import {
	classifyTabStatus,
	composeTabStatus,
	probeSessionFile,
	readTabResultFile,
	readTabState,
	sessionBucketForCwd,
	validateTabDispatchRecord,
	type SessionProbe,
	type TabDispatchRecord,
	type TabResult,
	type TabState,
} from "../tab-runs.ts";
import { classifyForReclaim } from "../tab-runs-runtime.ts";
import { mailboxDirFor, type ObjectAddress } from "./mailbox.ts";
import { masterAddress } from "./address.ts";

// ── 输入 / 输出 ────────────────────────────────────────────────────

export interface GitProbeResult { branch: string; dirty: string; unknown?: string }
export type GitProbe = (repoRoot: string) => GitProbeResult;

export interface GlobalViewOptions {
	agentDir?: string;
	/** 测试注入；缺省 Date.now() */
	now?: number;
	windowMs?: number;
	history?: boolean;
	page?: number;
	pageSize?: number;
	gitProbe?: GitProbe;
}

export interface RepoRow {
	repoPath: string;
	display: string;
	local: string;
	branch: string;
	dirty: string;
	tabText: string;
	tabActive: number;
	attention: number;
	timer: number;
	overdue: number;
	mail: string;
	mailPending: number;
	plans: string;
	plansCount: number | null;
	lastMs: number;
	lastText: string;
	gitUnknown?: boolean;
}

export interface HiddenTabEntry { id: string; repoPath: string; reason: string; at: string }

export interface GlobalViewSnapshot {
	owner: string;
	generation: string;
	cutover: string;
	asof: string;
	reposTotal: number;
	shown: number;
	tabsActive: number;
	timersPending: number;
	inboxPending: number;
	inboxClaimed: number;
	home: RepoRow;
	rows: RepoRow[];
	totals: { orphaned: number; terminal: number; noResult: number; attention: number; gitUnknown: number; otherMail: number };
	warnings: string[];
	cursor: { page: number; pageSize: number; totalPages: number };
	history: HiddenTabEntry[];
	historyTotal: number;
	partial: boolean;
	/** phase2 增量（纯加列；现有字段语义冻结） */
	details: TabDetail[];
	diff: ViewDiff;
	hygiene: string;
	command: string;
	/** 调用层写基线用载荷（不渲染） */
	baselinePayload: BaselinePayload;
}

const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_PAGE_SIZE = 20;
const MAX_SCAN_FILES = 5000;

/**
 * 无进展阈值 45min（0923 phase2 裁定）：对齐 localText 既有 stale(30min)
 * 口径上浮，避免两处阈值打架。仅用于排序/标注，不改变任何字段语义。
 */
export const STALE_NO_PROGRESS_MS = 45 * 60 * 1000;
/** 最后 assistant 摘要截断 120 字（0923 phase2 裁定；state/probe 侧 2000 截断之上再截）。 */
export const SUMMARY_TRUNCATE_CHARS = 120;
/**
 * 差分基线相对路径 `<agentDir>/global-view/last.json`（0923 phase2 裁定）。
 * collector 保持纯只读（只读基线）；写基线只发生在调用层 globalViewLogic
 * 执行后的 best-effort 路径（原子写 tmp+rename，失败只记 warnings）。
 */
export const GLOBAL_VIEW_BASELINE_REL = "global-view/last.json";
/** 探活抽尾行数上限：lastStopReason/摘要只在 visible/active tab 上探，terminal 跳过。 */
export const MAX_PROBE_TAIL_LINES = 40;
/** 跨仓 recentwork.md 读取上限 64KB（超→该仓 gate=unknown）。 */
export const MAX_GATE_BYTES = 64 * 1024;
/** 五源缩写自解释（输出头三件套用）：S=state R=result P=probe(session JSONL 抽尾) G=gate(各仓 recentwork.md) D=diff(last.json 基线)。 */
export const SOURCES_LEGEND = "src=S(state)+R(result)+P(probe:tail40)+G(gate:recentwork)+D(diff:last.json)";

/** 跨仓闸口状态：awaiting=等人工动作 | ok=表中有行但无等人工 | unknown=缺文件/超限/表头漂移/解析异常 */
export type GateStatus = "awaiting" | "ok" | "unknown";

/** phase2 每 tab 明细行（纯增量列；读不到一律 unknown，绝不猜、绝不拿 mtime 冒充 lastActivityAt）。 */
export interface TabDetail {
	runId: string;
	repoPath: string;
	phase: string;
	taskId: string;
	age: string;
	stale: string;
	staleOver: boolean;
	stop: string;
	artifact: string;
	artifactMtime: string;
	resultMissing: boolean;
	terminal: boolean;
	openIssues: number | null;
	summary: string;
	needsHuman: boolean;
	gate: GateStatus;
	overdue: number;
	pidAlive: boolean | null;
}

/** 差分输出（键=runId；仓库行用归一化 repoPath）。 */
export interface ViewDiff { added: string[]; changed: string[]; removed: string[]; note: string }

/** 差分基线载荷（只写本机 <agentDir>/global-view/last.json，不记业务状态）。 */
export interface BaselinePayload {
	savedAt: string;
	tabs: Record<string, { phase: string; stop: string; missing: boolean; human: boolean; issues: string }>;
	repos: Record<string, string>;
}

export function defaultAgentDir(): string { return join(homedir(), ".pi", "agent"); }
function warn(out: string[], msg: string): void { if (out.length < 20) out.push(msg); }
function readJson(path: string): Record<string, unknown> | null {
	try {
		const v: unknown = JSON.parse(readFileSync(path, "utf8"));
		return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
	} catch { return null; }
}
function toMs(v: unknown): number | null {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v === "string" && v) { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
	return null;
}
function relText(ms: number | null, now: number): string {
	if (ms === null || ms <= 0) return "?";
	const d = now - ms;
	if (d < 0) return "0m";
	const m = Math.floor(d / 60000);
	if (m < 1) return "0m";
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 48) return `${h}h`;
	return `${Math.floor(h / 24)}d`;
}
function sanitize(s: string): string {
	return s.replace(/[\x00-\x1f\x7f]/g, "").replace(/\n/g, " ").slice(0, 120);
}
function truncateSummary(s: string): string {
	const t = s.replace(/[\x00-\x1f\x7f]/g, "").replace(/\n/g, " ").trim();
	return t ? t.slice(0, SUMMARY_TRUNCATE_CHARS) : "-";
}

/**
 * 异常置顶序（0923 phase2 §2）：等人工动作(0) > unconfirmed(1) >
 * resultMissing&&terminal(2) > 无进展超阈值(3) > overdue timer(4) > 其余(5)。
 * 纯函数，供 repo 行排序与明细置顶共用。
 */
export function rankDetail(d: {
	needsHuman: boolean; phase: string; resultMissing: boolean;
	terminal: boolean; staleOver: boolean; overdue: boolean;
}): number {
	if (d.needsHuman) return 0;
	if (d.phase === "unconfirmed") return 1;
	if (d.resultMissing && d.terminal) return 2;
	if (d.staleOver) return 3;
	if (d.overdue) return 4;
	return 5;
}

/**
 * 只读各仓 `<repo>/recentwork.md` 的 `## Active Tasks` → `### Task Index` 表
 * + `**Status**` 行，判定等人工动作证据。任一触发→该仓 gate=unknown：
 * 文件缺失 / 超 64KB / 表头漂移 / 解析异常。单仓异常由调用方记 warnings，
 * 不影响其它仓行。绝不写任何其它仓库。
 */
export function readGateStatus(repoPath: string, warnings: string[]): GateStatus {
	try {
		const f = join(repoPath, "recentwork.md");
		if (!existsSync(f)) return "unknown";
		try {
			if (statSync(f).size > MAX_GATE_BYTES) { warn(warnings, `gate 超 64KB 降级 unknown: ${basename(repoPath)}`); return "unknown"; }
		} catch { return "unknown"; }
		let text: string;
		try { text = readFileSync(f, "utf8"); } catch { return "unknown"; }
		let inActive = false; let sawIndex = false; let colsOk = false; let awaiting = false;
		for (const line of text.split("\n")) {
			if (/^##\s+Active Tasks/.test(line)) { inActive = true; continue; }
			if (inActive && /^##\s+/.test(line)) break;
			if (!inActive) continue;
			if (/\*\*Status\*\*/.test(line) && /(waiting|等人工|awaiting|needs?-?human|需人工)/i.test(line)) awaiting = true;
			if (/^###\s+Task Index/.test(line)) { sawIndex = true; continue; }
			if (sawIndex && !colsOk && line.includes("|")) {
				const h = line.toLowerCase();
				if (h.includes("item") && h.includes("priority") && h.includes("summary")) colsOk = true;
				else { warn(warnings, `gate 表头漂移降级 unknown: ${basename(repoPath)}`); return "unknown"; }
				continue;
			}
		}
		if (!sawIndex || !colsOk) return "unknown";
		return awaiting ? "awaiting" : "ok";
	} catch { return "unknown"; }
}

/**
 * 可见 tab 的 tail-capped 会话探活（复用 probeSessionFile；只读 bucket 内
 * .jsonl，匹配规则/时间窗消歧与 probeSessionsForDispatch 一致）。
 * 失败→null（调用方降级 unknown）。
 */
function probeVisibleTab(rec: TabDispatchRecord, sessionsRoot: string): SessionProbe | null {
	try {
		const bucket = join(sessionsRoot, sessionBucketForCwd(rec.cwd));
		if (!existsSync(bucket)) return null;
		const dispatchedMs = Date.parse(rec.dispatchedAt);
		for (const f of readdirSync(bucket)) {
			if (!f.endsWith(".jsonl")) continue;
			const full = join(bucket, f);
			let probe: SessionProbe;
			try { probe = probeSessionFile(full, rec.taskId, rec.mode, { maxTailLines: MAX_PROBE_TAIL_LINES }); }
			catch { continue; }
			if (!probe.matched) continue;
			if (!Number.isNaN(dispatchedMs)) {
				let sessionMs = probe.sessionTimestamp ? Date.parse(probe.sessionTimestamp) : NaN;
				if (Number.isNaN(sessionMs)) {
					try { sessionMs = statSync(full).mtimeMs; } catch { /* 保留候选 */ }
				}
				if (!Number.isNaN(sessionMs) && sessionMs < dispatchedMs - 60_000) continue;
			}
			return probe;
		}
		return null;
	} catch { return null; }
}

/** 默认 git 探针：只读 HEAD + `git status --porcelain=v1 --untracked-files=normal`。失败/超时 → `?`。 */
export function defaultGitProbe(repoRoot: string): GitProbeResult {
	try {
		const gitPath = join(repoRoot, ".git");
		let headFile = join(repoRoot, ".git", "HEAD");
		try {
			const st = statSync(gitPath);
			if (st.isFile()) {
				const link = readFileSync(gitPath, "utf8").trim();
				const m = /^gitdir:\s*(.+)$/.exec(link);
				if (m) headFile = resolve(repoRoot, m[1].trim(), "HEAD");
			} else if (!st.isDirectory()) {
				return { branch: "-", dirty: "-" };
			}
		} catch { return { branch: "-", dirty: "-" }; }
		let branch = "?";
		try {
			const head = readFileSync(headFile, "utf8").trim();
			const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
			branch = m ? m[1]! : head.length >= 7 && /^[0-9a-f]{4,40}$/i.test(head) ? `@${head.slice(0, 7)}` : "?";
		} catch { /* branch stays ? */ }
		let dirty = "?";
		try {
			const out = execFileSync("git", ["-C", repoRoot, "status", "--porcelain=v1", "--untracked-files=normal"], {
				encoding: "utf8", timeout: 800, stdio: ["ignore", "pipe", "ignore"],
				env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
			});
			dirty = out.split("\n").some((l) => l.trim().length > 0) ? "dirty" : "clean";
		} catch { dirty = "?"; }
		return { branch, dirty };
	} catch { return { branch: "?", dirty: "?" }; }
}

/** cwd 沿父目录向上找 .git（≤8 层，不过 profile/盘根）；无则回退 cwd 本身。 */
function findRepoRoot(cwd: string, cache: Map<string, string>): string {
	const norm = normalizeExactPath(cwd);
	const hit = cache.get(norm);
	if (hit) return hit;
	try {
		let cur = resolve(cwd);
		for (let i = 0; i < 8; i++) {
			try {
				const g = join(cur, ".git");
				if (existsSync(g)) { cache.set(norm, cur); return cur; }
			} catch { break; }
			const parent = dirname(cur);
			if (parent === cur) break;
			cur = parent;
		}
	} catch { /* fall through */ }
	cache.set(norm, cwd);
	return cwd;
}

interface TabNote { phase: string; active: boolean; attention: boolean; hiddenKind: "orphaned" | "terminal" | null; noResult: boolean; at: string }

function classifyDispatch(rec: TabDispatchRecord, runsDir: string): TabNote {
	const at = rec.dispatchedAt;
	try {
		const result = readTabResultFile(runsDir, rec.id);
		if (result) {
			const terminal = result.status === "completed" || result.status === "failed" || result.status === "cancelled";
			if (terminal) return { phase: result.status, active: false, attention: false, hiddenKind: "terminal", noResult: false, at };
			return { phase: "completed", active: false, attention: false, hiddenKind: "terminal", noResult: false, at };
		}
		const state = readTabState(runsDir, rec.id);
		if (state) {
			if (state.phase === "orphaned") return { phase: "orphaned", active: false, attention: false, hiddenKind: "orphaned", noResult: true, at: state.lastActivityAt ?? at };
			if (state.terminal) {
				// 终态但无 result → 待审（可见），绝不静默归 hidden
				return { phase: state.phase, active: true, attention: true, hiddenKind: null, noResult: true, at: state.lastActivityAt ?? at };
			}
			const att = state.phase === "attached" || state.phase === "working" || state.phase === "waiting";
			return { phase: state.phase, active: att, attention: state.phase === "working" || state.phase === "waiting" ? false : att, hiddenKind: null, noResult: true, at: state.lastActivityAt ?? at };
		}
		const st = classifyTabStatus(null, { dispatchedAt: rec.dispatchedAt });
		if (st.phase === "orphaned") return { phase: "orphaned", active: false, attention: false, hiddenKind: "orphaned", noResult: true, at };
		return { phase: st.phase, active: true, attention: st.phase === "unconfirmed", hiddenKind: null, noResult: true, at };
	} catch {
		return { phase: "unknown", active: false, attention: false, hiddenKind: null, noResult: true, at };
	}
}

// ── phase2 明细 / 基线 IO（只读；写基线仅 writeGlobalViewBaseline，由调用层 best-effort 调用） ──

/**
 * 构建单条可见 tab 明细。判态复用 composeTabStatus（result>state>probe 回退链）
 * + classifyForReclaim（awaitingInput 判定）；每列读不到→unknown，绝不猜。
 */
function buildTabDetail(
	rec: TabDispatchRecord,
	runsDir: string,
	sessionsRoot: string,
	repoPath: string,
	repoOverdue: number,
	now: number,
	warnings: string[],
	gateCache: Map<string, GateStatus>,
): TabDetail | null {
	try {
		let state: TabState | null = null;
		let result: TabResult | null = null;
		try { result = readTabResultFile(runsDir, rec.id); } catch { result = null; }
		try { state = readTabState(runsDir, rec.id); } catch { state = null; }
		// 探活成本控制：只在 state 缺 stop/摘要时探（terminal 已由 hidden 分流跳过）
		let probe: SessionProbe | null = null;
		if (!state?.lastStopReason || !state?.lastAssistantText) {
			probe = probeVisibleTab(rec, sessionsRoot);
		}
		let phase: string = state?.phase ?? (result ? result.status : "unknown");
		let terminal = state?.terminal ?? !!result;
		let resultMissing = !result;
		let reclaim: string = "pending";
		try {
			const view = composeTabStatus({ runId: rec.id, dispatch: rec, state, result, probe, dispatchedAt: rec.dispatchedAt });
			phase = view.phase; terminal = view.terminal; resultMissing = view.resultMissing;
			reclaim = classifyForReclaim(view);
		} catch { /* 保持 state/result 直读值 */ }
		const dispMs = toMs(rec.dispatchedAt);
		const ageMs = dispMs && dispMs > 0 ? now - dispMs : null;
		// stale 只认 TabState.lastActivityAt；无 state/无该字段→unknown，绝不拿 mtime 冒充
		const actMs = toMs(state?.lastActivityAt);
		const staleMs = actMs && actMs > 0 ? now - actMs : null;
		const staleOver = staleMs !== null && staleMs > STALE_NO_PROGRESS_MS && (phase === "working" || phase === "waiting");
		const stop = state?.lastStopReason ?? probe?.lastStopReason ?? "unknown";
		let pidAlive: boolean | null = null;
		if (typeof state?.pid === "number" && Number.isFinite(state.pid)) {
			try { process.kill(state.pid, 0); pidAlive = true; } catch { pidAlive = false; }
		}
		let artifact = "-"; let artifactMtime = "?";
		const cands = result?.reportPath ? [result.reportPath] : [...(result?.artifacts ?? [])];
		const last = cands[cands.length - 1];
		if (result && last) {
			artifact = last;
			try {
				const p = existsSync(last) ? last : join(repoPath, last);
				const m = statSync(p).mtimeMs;
				artifactMtime = relText(m, now);
			} catch { artifactMtime = "missing"; }
		}
		const gk = normalizeExactPath(repoPath);
		let gate = gateCache.get(gk);
		if (!gate) { gate = readGateStatus(repoPath, warnings); gateCache.set(gk, gate); }
		return {
			runId: rec.id, repoPath, phase, taskId: rec.taskId || "unknown",
			age: ageMs !== null ? relText(now - ageMs, now) : "?",
			stale: staleMs !== null ? relText(now - staleMs, now) : "unknown",
			staleOver, stop,
			artifact, artifactMtime, resultMissing, terminal,
			openIssues: Array.isArray(result?.openIssues) ? result.openIssues.length : null,
			summary: truncateSummary(probe?.lastAssistantText ?? state?.lastAssistantText ?? result?.finalText ?? result?.summary ?? ""),
			needsHuman: reclaim === "awaitingInput" || gate === "awaiting",
			gate, overdue: repoOverdue, pidAlive,
		};
	} catch { return null; }
}

/** 只读基线；缺失→{base:null}；损坏/不可解析→当作无基线 + warn（行为同首次运行）。 */
function loadBaseline(agentDir: string, warnings: string[]): { base: BaselinePayload | null; corrupt: boolean } {
	try {
		const f = join(agentDir, GLOBAL_VIEW_BASELINE_REL);
		if (!existsSync(f)) return { base: null, corrupt: false };
		const raw: unknown = JSON.parse(readFileSync(f, "utf8"));
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) { warn(warnings, "基线损坏，按首次运行处理"); return { base: null, corrupt: true }; }
		const b = raw as { tabs?: unknown; repos?: unknown };
		if (!b.tabs || typeof b.tabs !== "object" || !b.repos || typeof b.repos !== "object") {
			warn(warnings, "基线损坏，按首次运行处理"); return { base: null, corrupt: true };
		}
		return { base: raw as BaselinePayload, corrupt: false };
	} catch {
		warn(warnings, "基线损坏，按首次运行处理");
		return { base: null, corrupt: true };
	}
}

/** 差分比对（stable 字段 only：stale/age 墙钟每次都变，不参与 changed）。 */
function computeDiff(prev: BaselinePayload | null, details: TabDetail[], repoSig: Map<string, string>): ViewDiff {
	const d: ViewDiff = { added: [], changed: [], removed: [], note: "" };
	if (!prev) { d.note = "none(baseline saved)"; return d; }
	const cur = new Map(details.map((t) => [t.runId, t] as const));
	for (const t of details) {
		const p = prev.tabs[t.runId];
		if (!p) { d.added.push(t.runId); continue; }
		if (p.phase !== t.phase) d.changed.push(`${t.runId}:phase`);
		else if (p.stop !== t.stop) d.changed.push(`${t.runId}:stop`);
		else if (p.missing !== t.resultMissing) d.changed.push(`${t.runId}:result`);
		else if (p.human !== t.needsHuman) d.changed.push(`${t.runId}:human`);
		else if (String(p.issues) !== String(t.openIssues)) d.changed.push(`${t.runId}:issues`);
	}
	for (const id of Object.keys(prev.tabs)) if (!cur.has(id)) d.removed.push(id);
	for (const [k, sig] of repoSig) {
		const ps = prev.repos[k];
		if (ps !== undefined && ps !== sig) d.changed.push(`repo:${basename(k)}:tabs`);
	}
	return d;
}

/**
 * 原子写基线（临时文件 + rename）。仅由 globalViewLogic 在 collector 执行后
 * best-effort 调用；失败抛给调用方记 warnings，绝不影响输出。
 */
export function writeGlobalViewBaseline(agentDir: string, payload: BaselinePayload): void {
	const dir = join(agentDir, "global-view");
	mkdirSync(dir, { recursive: true });
	const tmp = join(dir, `last.${process.pid}.tmp`);
	writeFileSync(tmp, JSON.stringify(payload), "utf8");
	renameSync(tmp, join(dir, "last.json"));
}

// ── collector ──────────────────────────────────────────────────────

export function collectGlobalView(opts: GlobalViewOptions = {}): GlobalViewSnapshot {
	const warnings: string[] = [];
	try {
		const agentDir = opts.agentDir ?? defaultAgentDir();
		const now = opts.now ?? Date.now();
		const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
		const history = opts.history ?? false;
		const pageSize = Math.max(1, Math.min(opts.pageSize ?? DEFAULT_PAGE_SIZE, 20));
		const page = Math.max(1, opts.page ?? 1);
		const gitProbe = opts.gitProbe ?? defaultGitProbe;
		const runsDir = join(agentDir, "tab-runs");
		const timersDir = join(agentDir, "timers");
		const mailboxRoot = join(agentDir, "runtime", "mailbox");
		const attachDir = join(agentDir, "runtime", "registry", "attachments");
		const livenessDir = join(agentDir, "runtime", "state", "scope-liveness");
		const repoCache = new Map<string, string>();

		// 附件：repo 精确路径 ← detail；global ← master_default
		let owner = "none"; let generation = "-"; let cutover = "off";
		let globalAttach: Record<string, unknown> | null = null;
		const repoAttach = new Map<string, Record<string, unknown>>();
		try {
			for (const f of readdirSync(attachDir)) {
				if (!f.endsWith(".json")) continue;
				const r = readJson(join(attachDir, f));
				if (!r || typeof r.sessionId !== "string") continue;
				const addr = typeof r.agentAddress === "string" ? r.agentAddress : "";
				if (addr === masterAddress()) { globalAttach = r; continue; }
				const detail = typeof r.detail === "string" && r.detail ? r.detail : null;
				if (detail) {
					try {
						const root = findRepoRoot(detail, repoCache);
						repoAttach.set(normalizeExactPath(root), r);
					} catch { warn(warnings, `attach detail 解析失败: ${f}`); }
				}
			}
		} catch { /* 无附件账本：HOME=none */ }
		try {
			if (globalAttach) {
				owner = String(globalAttach.sessionId ?? "none").slice(0, 12);
				generation = String((globalAttach as { generation?: unknown }).generation ?? "-");
			}
			const cut = readJson(join(agentDir, "runtime", "state", "cutover.json"));
			if (cut && cut.enabled === true) cutover = "on";
		} catch { /* keep defaults */ }

		// liveness：sessionId→记录（local 活性证据）
		const liveBySession = new Map<string, Record<string, unknown>>();
		try {
			for (const f of readdirSync(livenessDir)) {
				if (!f.endsWith(".json")) continue;
				const r = readJson(join(livenessDir, f));
				if (r && typeof r.sessionId === "string") liveBySession.set(r.sessionId as string, r);
			}
		} catch { /* 无心跳账本 */ }

		// tab 派发：全量扫描（不用 Top100 缺省截断）
		const sessionsRoot = join(agentDir, "sessions");
		const details: TabDetail[] = [];
		const gateCache = new Map<string, GateStatus>();
		interface Agg {
			repoPath: string; counts: Map<string, number>; active: number; attention: number;
			lastMs: number; hidden: HiddenTabEntry[];
		}
		const aggs = new Map<string, Agg>();
		const runToRepo = new Map<string, string>();
		let orphaned = 0; let terminal = 0; let noResult = 0; let attentionTotal = 0; let tabsActive = 0;
		const historyEntries: HiddenTabEntry[] = [];
		let scanned = 0;
		const ensure = (repoPath: string): Agg => {
			const k = normalizeExactPath(repoPath);
			let a = aggs.get(k);
			if (!a) { a = { repoPath, counts: new Map(), active: 0, attention: 0, lastMs: 0, hidden: [] }; aggs.set(k, a); }
			return a;
		};
		try {
			const files = existsSync(runsDir) ? readdirSync(runsDir) : [];
			for (const f of files) {
				if (scanned++ > MAX_SCAN_FILES) { warn(warnings, "tab-runs 扫描超预算，部分计数记 partial"); break; }
				if (!f.endsWith(".json") || f.endsWith(".state.json") || f.endsWith(".result.json") || f.endsWith(".tmp")) continue;
				if (f.startsWith("_archived")) continue;
				const raw = readJson(join(runsDir, f));
				if (!raw) { warn(warnings, `坏 dispatch 跳过: ${f}`); continue; }
				const chk = validateTabDispatchRecord(raw);
				if (!chk.ok || !chk.value) continue;
				const rec = chk.value;
				if (rec.dispatchStatus === "launch_failed") continue;
				let repoPath = rec.cwd;
				try { repoPath = findRepoRoot(rec.cwd, repoCache); } catch { /* keep cwd */ }
				runToRepo.set(rec.id, repoPath);
				const note = classifyDispatch(rec, runsDir);
				const atMs = toMs(note.at) ?? 0;
				if (note.hiddenKind === "orphaned") {
					orphaned++; noResult++;
					const e = { id: rec.id, repoPath, reason: "orphaned", at: note.at };
					ensure(repoPath).hidden.push(e); historyEntries.push(e);
					continue;
				}
				if (note.hiddenKind === "terminal") {
					terminal++;
					const e = { id: rec.id, repoPath, reason: `terminal:${note.phase}`, at: note.at };
					ensure(repoPath).hidden.push(e); historyEntries.push(e);
					continue;
				}
				// phase2 明细：仅可见 tab 做探活增强（never-throw，单条失败不影响表）
				try {
					const d = buildTabDetail(rec, runsDir, sessionsRoot, repoPath, 0, now, warnings, gateCache);
					if (d) details.push(d);
				} catch { /* 忽略 */ }
				const a = ensure(repoPath);
				a.counts.set(note.phase, (a.counts.get(note.phase) ?? 0) + 1);
				if (note.noResult) noResult++;
				if (atMs > a.lastMs) a.lastMs = atMs;
				if (note.active) { a.active++; tabsActive++; }
				if (note.attention) { a.attention++; attentionTotal++; }
			}
		} catch (e) { warn(warnings, `tab-runs 扫描失败: ${e instanceof Error ? e.message : String(e)}`); }

		// timers：pending only；root 按 ownerCwd，mail 按 run→repo；未映射记 unmapped
		const timerByRepo = new Map<string, { n: number; overdue: number }>();
		let unmappedTimer = 0; let timersPending = 0;
		const bumpTimer = (repoPath: string | null, dueAt: unknown): void => {
			const due = toMs(dueAt) ?? 0;
			const od = due > 0 && due < now ? 1 : 0;
			if (!repoPath) { unmappedTimer++; return; }
			const k = normalizeExactPath(repoPath);
			const e = timerByRepo.get(k) ?? { n: 0, overdue: 0 };
			e.n++; e.overdue += od; timerByRepo.set(k, e);
		};
		try {
			if (existsSync(timersDir)) {
				for (const f of readdirSync(timersDir)) {
					if (!f.endsWith(".json") || f.endsWith(".tmp")) continue;
					const full = join(timersDir, f);
					try { if (statSync(full).isDirectory()) continue; } catch { continue; }
					const r = readJson(full);
					if (!r || r.status !== "pending") continue;
					timersPending++;
					const ownerCwd = typeof r.ownerCwd === "string" && r.ownerCwd ? r.ownerCwd : null;
					bumpTimer(ownerCwd ? findRepoRoot(ownerCwd, repoCache) : null, r.dueAt);
				}
				const mailRoot = join(timersDir, "mail");
				if (existsSync(mailRoot)) {
					for (const run of readdirSync(mailRoot)) {
						const dir = join(mailRoot, run);
						let files: string[] = [];
						try { files = readdirSync(dir); } catch { continue; }
						for (const f of files) {
							if (!f.endsWith(".json") || f.endsWith(".tmp")) continue;
							const r = readJson(join(dir, f));
							if (!r || r.status !== "pending") continue;
							timersPending++;
							const repo = runToRepo.get(run) ?? null;
							bumpTimer(repo, r.dueAt);
						}
					}
				}
			}
		} catch (e) { warn(warnings, `timers 扫描失败: ${e instanceof Error ? e.message : String(e)}`); }

		// mailbox：pending/claimed 计数；global 进 HOME，其余按附件 detail 精确归仓，未解析记 other
		const mailByRepo = new Map<string, { p: number; c: number }>();
		let homeP = 0; let homeC = 0; let otherMail = 0; let inboxPending = 0; let inboxClaimed = 0;
		const globalDir = mailboxDirFor(masterAddress() as ObjectAddress, mailboxRoot);
		try {
			if (existsSync(mailboxRoot)) {
				for (const d of readdirSync(mailboxRoot)) {
					const dir = join(mailboxRoot, d);
					try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
					let p = 0; let c = 0;
					try {
						for (const f of readdirSync(dir)) {
							if (!f.endsWith(".json")) continue;
							const r = readJson(join(dir, f));
							if (!r) continue;
							if (r.status === "pending") p++;
							else if (r.status === "claimed") c++;
						}
					} catch { warn(warnings, `mailbox 读取失败: ${d}`); continue; }
					inboxPending += p; inboxClaimed += c;
					if (dir === globalDir) { homeP = p; homeC = c; continue; }
					// 精确匹配附件文件名（sanitize 对称），不猜别名
					let mapped: string | null = null;
					try {
						const att = readJson(join(attachDir, `${d}.json`));
						const detail = att && typeof att.detail === "string" ? (att.detail as string) : null;
						if (detail) mapped = findRepoRoot(detail, repoCache);
					} catch { /* unmapped */ }
					if (mapped) {
						const k = normalizeExactPath(mapped);
						const e = mailByRepo.get(k) ?? { p: 0, c: 0 };
						e.p += p; e.c += c; mailByRepo.set(k, e);
					} else if (p + c > 0) { otherMail += p + c; }
				}
			}
		} catch (e) { warn(warnings, `mailbox 扫描失败: ${e instanceof Error ? e.message : String(e)}`); }

		// 候选仓并集：7d 窗口 + 窗外但有 active/pending/local 的仓
		const since = now - windowMs;
		const candKeys = new Set<string>();
		for (const [k, a] of aggs) {
			if (a.active > 0 || a.attention > 0) { candKeys.add(k); continue; }
			const t = timerByRepo.get(k); const m = mailByRepo.get(k);
			if ((t && t.n > 0) || (m && (m.p + m.c) > 0) || repoAttach.has(k)) { candKeys.add(k); continue; }
			if (a.lastMs >= since) candKeys.add(k);
		}
		for (const k of timerByRepo.keys()) candKeys.add(k);
		for (const k of mailByRepo.keys()) candKeys.add(k);
		for (const k of repoAttach.keys()) {
			const a = aggs.get(k);
			if (!a) {
				// 有 owner 但窗口内无活动：仍入行（last=?）
				aggs.set(k, { repoPath: k, counts: new Map(), active: 0, attention: 0, lastMs: 0, hidden: [] });
			}
			candKeys.add(k);
		}

		const isPidAlive = (pid: unknown): boolean | null => {
			if (typeof pid !== "number" || !Number.isFinite(pid)) return null;
			try { process.kill(pid, 0); return true; } catch { return false; }
		};
		const localText = (repoPath: string): string => {
			const k = normalizeExactPath(repoPath);
			const att = repoAttach.get(k);
			if (!att) return "none";
			const sid = att.sessionId as string;
			const live = liveBySession.get(sid);
			if (!live) return "unknown";
			try {
				if (live.generation !== (att as { generation?: unknown }).generation) return "unknown";
				const upd = toMs(live.updatedAt) ?? 0;
				const age = now - upd;
				const alive = isPidAlive((live as { pid?: unknown }).pid);
				if (alive === true && age <= 2 * 60_000) return `alive(${relText(upd, now)})`;
				if (alive === false || age > 30 * 60_000) return `stale(${relText(upd, now)})`;
				return "unknown";
			} catch { return "unknown"; }
		};

		// sessions mtime 弱证据补 last（预算内）
		try {
			const sessRoot = join(agentDir, "sessions");
			if (existsSync(sessRoot)) {
				let files = 0;
				const buckets = readdirSync(sessRoot).slice(0, 200);
				for (const b of buckets) {
					const dir = join(sessRoot, b);
					let names: string[] = [];
					try { names = readdirSync(dir); } catch { continue; }
					for (const f of names) {
						if (files++ > MAX_SCAN_FILES) { warn(warnings, "sessions 扫描超预算（partial）"); break; }
						let m = 0;
						try { m = statSync(join(dir, f)).mtimeMs; } catch { continue; }
						if (m < since) continue;
						// 弱证据：不建新仓，仅刷新已有候选的 last
						for (const [k, a] of aggs) {
							if (m > a.lastMs && candKeys.has(k)) { /* 无法精确归属：跳过 */ }
						}
					}
				}
			}
		} catch { /* 弱证据失败忽略 */ }

		const allRows: RepoRow[] = [];
		let gitUnknown = 0;
		for (const k of candKeys) {
			const a = aggs.get(k);
			const repoPath = a?.repoPath ?? k;
			let git: GitProbeResult = { branch: "?", dirty: "?" };
			try { git = gitProbe(repoPath); }
			catch { git = { branch: "?", dirty: "?" }; }
			if (git.branch === "?" || git.dirty === "?") gitUnknown++;
			const t = timerByRepo.get(k) ?? { n: 0, overdue: 0 };
			const m = mailByRepo.get(k) ?? { p: 0, c: 0 };
			const tabText = a && a.counts.size > 0
				? [...a.counts.entries()].map(([ph, n]) => `${ph}:${n}`).join(" ") : "-";
			let plans = "?"; let plansCount: number | null = null;
			try {
				const pdir = join(repoPath, "plans");
				if (existsSync(pdir)) {
					const n = readdirSync(pdir).filter((f) => f.endsWith(".md")).length;
					plans = String(n); plansCount = n;
				} else { plans = "0"; plansCount = 0; }
			} catch { plans = "?"; }
			const base = basename(repoPath) || repoPath;
			// 同名消歧：同 basename 多仓 → 加短父路径
			const sameBase = [...candKeys].filter((x) => {
				const ax = aggs.get(x);
				return (basename(ax?.repoPath ?? x) || "") === base;
			});
			const display = sameBase.length > 1 ? `${base}(${basename(dirname(repoPath))})` : base;
			allRows.push({
				repoPath, display: sanitize(display), local: localText(repoPath),
				branch: sanitize(git.branch), dirty: sanitize(git.dirty),
				tabText: sanitize(tabText), tabActive: a?.active ?? 0, attention: a?.attention ?? 0,
				timer: t.n, overdue: t.overdue,
				mail: `p${m.p}/c${m.c}`, mailPending: m.p,
				plans, plansCount, lastMs: a?.lastMs ?? 0, lastText: relText(a?.lastMs ?? 0, now) === "?" && (a?.lastMs ?? 0) === 0 ? "?" : relText(a?.lastMs ?? 0, now),
				gitUnknown: git.branch === "?" || git.dirty === "?",
			});
		}
		// phase2：回填各明细的 repo overdue；置顶序聚合；hygiene；差分（只读基线）
		for (const d of details) {
			const t = timerByRepo.get(normalizeExactPath(d.repoPath));
			d.overdue = t?.overdue ?? 0;
		}
		const prioByRepo = new Map<string, number>();
		for (const d of details) {
			const k = normalizeExactPath(d.repoPath);
			const r = rankDetail({ needsHuman: d.needsHuman, phase: d.phase, resultMissing: d.resultMissing, terminal: d.terminal, staleOver: d.staleOver, overdue: d.overdue > 0 });
			const cur = prioByRepo.get(k);
			if (cur === undefined || r < cur) prioByRepo.set(k, r);
		}
		const repoPrio = (repoPath: string): number => prioByRepo.get(normalizeExactPath(repoPath)) ?? 5;
		details.sort((a, b) =>
			(rankDetail({ needsHuman: a.needsHuman, phase: a.phase, resultMissing: a.resultMissing, terminal: a.terminal, staleOver: a.staleOver, overdue: a.overdue > 0 }) -
				rankDetail({ needsHuman: b.needsHuman, phase: b.phase, resultMissing: b.resultMissing, terminal: b.terminal, staleOver: b.staleOver, overdue: b.overdue > 0 })) ||
			(a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
		const zombiePid = details.filter((d) => d.pidAlive === false && (d.phase === "working" || d.phase === "waiting" || d.phase === "attached")).length;
		// TODO(phase2-hygiene): 空壳 WT 窗 / 端口占用 / daemon 存活尚无现成只读枚举器，先留 unknown，不发明新口径
		const hygiene = `hygiene: zombiePid:${zombiePid} otherMail:${otherMail} unmappedTimer:${unmappedTimer} wt:unknown port:unknown daemon:unknown`;
		const repoSig = new Map<string, string>();
		for (const k of candKeys) {
			const ag = aggs.get(k);
			const tt = timerByRepo.get(k) ?? { n: 0, overdue: 0 };
			const mm = mailByRepo.get(k) ?? { p: 0, c: 0 };
			repoSig.set(k, `${ag?.active ?? 0}/${ag?.attention ?? 0}/${tt.n}/${mm.p}/${tt.overdue}`);
		}
		const prev = loadBaseline(agentDir, warnings);
		const diff = computeDiff(prev.base, details, repoSig);
		const baselinePayload: BaselinePayload = {
			savedAt: new Date(now).toISOString(),
			tabs: Object.fromEntries(details.map((t) => [t.runId, { phase: t.phase, stop: t.stop, missing: t.resultMissing, human: t.needsHuman, issues: String(t.openIssues) }] as const)),
			repos: Object.fromEntries(repoSig),
		};
		allRows.sort((x, y) =>
			(repoPrio(x.repoPath) - repoPrio(y.repoPath)) ||
			(y.attention - x.attention) || (y.tabActive - x.tabActive) ||
			((y.mailPending + y.timer) - (x.mailPending + x.timer)) ||
			(y.lastMs - x.lastMs) || (x.repoPath < y.repoPath ? -1 : x.repoPath > y.repoPath ? 1 : 0));

		const totalPages = Math.max(1, Math.ceil(allRows.length / pageSize));
		const pg = Math.min(page, totalPages);
		const rows = history ? [] : allRows.slice((pg - 1) * pageSize, pg * pageSize);
		historyEntries.sort((a, b) => (a.at < b.at ? 1 : -1));
		const histPage = historyEntries.slice((pg - 1) * pageSize, pg * pageSize);

		let homeLocal = "none";
		try {
			if (globalAttach) {
				const upd = toMs((globalAttach as { lastHeartbeatAt?: unknown }).lastHeartbeatAt) ?? 0;
				homeLocal = `global(${relText(upd, now)})`;
			}
		} catch { homeLocal = "unknown"; }

		return {
			owner, generation, cutover,
			asof: new Date(now).toISOString(),
			reposTotal: allRows.length, shown: rows.length,
			tabsActive, timersPending: timersPending + unmappedTimer,
			inboxPending, inboxClaimed,
			home: {
				repoPath: "__HOME__", display: "HOME", local: homeLocal,
				branch: "-", dirty: "-", tabText: "-", tabActive: 0, attention: 0,
				timer: unmappedTimer, overdue: 0, mail: `p${homeP}/c${homeC}`, mailPending: homeP,
				plans: "-", plansCount: null, lastMs: 0,
				lastText: globalAttach ? relText(toMs((globalAttach as { lastHeartbeatAt?: unknown }).lastHeartbeatAt) ?? 0, now) : "?",
			},
			rows,
			totals: { orphaned, terminal, noResult, attention: attentionTotal, gitUnknown, otherMail },
			warnings,
			cursor: { page: pg, pageSize, totalPages },
			history: history ? histPage : [],
			historyTotal: historyEntries.length,
			partial: warnings.some((w) => w.includes("partial") || w.includes("超预算")),
			details, diff, hygiene, command: "global-view", baselinePayload,
		};
	} catch (e) {
		return {
			owner: "none", generation: "-", cutover: "off", asof: new Date(opts.now ?? Date.now()).toISOString(),
			reposTotal: 0, shown: 0, tabsActive: 0, timersPending: 0, inboxPending: 0, inboxClaimed: 0,
			home: { repoPath: "__HOME__", display: "HOME", local: "unknown", branch: "-", dirty: "-", tabText: "-", tabActive: 0, attention: 0, timer: 0, overdue: 0, mail: "p0/c0", mailPending: 0, plans: "-", plansCount: null, lastMs: 0, lastText: "?" },
			rows: [], totals: { orphaned: 0, terminal: 0, noResult: 0, attention: 0, gitUnknown: 0, otherMail: 0 },
			warnings: [`collect 失败（never-throw）：${e instanceof Error ? e.message : String(e)}`],
			cursor: { page: 1, pageSize: 20, totalPages: 1 }, history: [], historyTotal: 0, partial: true,
			details: [], diff: { added: [], changed: [], removed: [], note: "none(baseline saved)" },
			hygiene: "hygiene: unknown", command: "global-view",
			baselinePayload: { savedAt: new Date(opts.now ?? Date.now()).toISOString(), tabs: {}, repos: {} },
		};
	}
}

// ── formatter（纯，≤30 行） ─────────────────────────────────────────

export function formatGlobalView(s: GlobalViewSnapshot): string {
	const lines: string[] = [];
	lines.push(`Global | owner=${s.owner} gen=${s.generation} cutover=${s.cutover} | repos=${s.reposTotal} shown=${s.shown} | tabs=${s.tabsActive} timer=${s.timersPending} inbox=p${s.inboxPending}/c${s.inboxClaimed} | asof=${s.asof}`);
	lines.push(`scope                 | local       | branch dirty     | tab                          | timer   | mail  | plans | last`);
	const fmt = (r: RepoRow): string => {
		const scope = r.display.padEnd(21).slice(0, 21);
		const local = r.local.padEnd(11).slice(0, 11);
		const bd = `${r.branch} ${r.dirty}`.padEnd(17).slice(0, 17);
		const tab = (r.tabText + (r.overdue > 0 || r.attention > 0 ? "" : "")).padEnd(28).slice(0, 28);
		const timer = (r.timer > 0 ? String(r.timer) + (r.overdue > 0 ? ` overdue:${r.overdue}` : "") : r.display === "HOME" && r.timer > 0 ? String(r.timer) : r.timer > 0 ? String(r.timer) : (r.display === "HOME" ? String(r.timer) : "0")).padEnd(7).slice(0, 7);
		return `${scope} | ${local} | ${bd} | ${tab} | ${timer} | ${r.mail.padEnd(5).slice(0, 5)} | ${r.plans.padEnd(5).slice(0, 5)} | ${r.lastText}`;
	};
	lines.push(fmt(s.home));
	if (s.history.length > 0) {
		for (const h of s.history.slice(0, 20)) lines.push(`  ${sanitize(h.id).slice(0, 24)} ${sanitize(h.reason)} ${sanitize(h.repoPath).slice(0, 40)} ${h.at.slice(0, 19)}`);
		lines.push(`history shown=${s.history.length}/total=${s.historyTotal} page=${s.cursor.page}/${s.cursor.totalPages}`);
	} else {
		for (const r of s.rows) lines.push(fmt(r));
		if (s.reposTotal > s.shown) lines.push(`… +${s.reposTotal - s.shown} repos; /global-view --page ${s.cursor.page + 1}`);
		lines.push(`hidden=orphaned:${s.totals.orphaned},terminal:${s.totals.terminal},noResult:${s.totals.noResult}; attention=${s.totals.attention}; unknown=git:${s.totals.gitUnknown}; /global-view --history /global-view inbox`);
	}
	// phase2 增量行：头三件套来源 + 等人工 + 可行动明细(≤5) + hygiene + 差分（行宽规则不动）
	const tailStart = lines.length; // 以下为尾部必出行区（sources…partial）
	lines.push(`${SOURCES_LEGEND} | cmd=${sanitize(s.command || "global-view")}`);
	const humans = s.details.filter((d) => d.needsHuman);
	if (humans.length > 0) lines.push(`needs-human: ${humans.slice(0, 5).map((d) => sanitize(d.runId)).join(", ")}${humans.length > 5 ? ` +${humans.length - 5} more` : ""}`);
	const actionable = s.details.filter((d) =>
		rankDetail({ needsHuman: d.needsHuman, phase: d.phase, resultMissing: d.resultMissing, terminal: d.terminal, staleOver: d.staleOver, overdue: d.overdue > 0 }) <= 3);
	for (const d of actionable.slice(0, 5)) {
		lines.push(`! ${sanitize(d.runId).slice(0, 24)} ${sanitize(d.phase)} age:${sanitize(d.age)} stale:${sanitize(d.stale)} stop:${sanitize(d.stop).slice(0, 20)} art:${sanitize(d.artifact).slice(0, 30)}@${sanitize(d.artifactMtime)} issues:${d.openIssues === null ? "unknown" : d.openIssues} human:${d.needsHuman ? "Y" : "-"} ${sanitize(d.summary).slice(0, 60)}`);
	}
	if (actionable.length > 5) lines.push(`! +${actionable.length - 5} more actionable (见 tool details)`);
	lines.push(sanitize(s.hygiene).slice(0, 120));
	if (s.diff.note) lines.push(`diff:${sanitize(s.diff.note)}`);
	else {
		const parts = [...s.diff.added.map((i) => `+${i}`), ...s.diff.changed.map((i) => `~${i}`), ...s.diff.removed.map((i) => `-${i}`)].slice(0, 8);
		lines.push(`diff: ${parts.join(" ") || "clean"}`);
	}
	for (const w of s.warnings.slice(0, 2)) lines.push(`warn: ${sanitize(w).slice(0, 100)}`);
	if (s.partial && !lines.some((l) => l.includes("partial"))) lines.push(`partial: 扫描超预算，计数可能不完整`);
	// M1：尾部必出行（sources/needs-human/actionable/hygiene/diff/warn/partial）永不截断；
	// 总行数仍 ≤30，超限时只截表格明细行（前 3 行头 + 末 1 行脚注保留），并保留溢出提示不静默。
	if (lines.length > 30) {
		const detail = tailStart - 1 - 3; // 表格明细行（含既有 repos 溢出提示行）
		const budget = Math.max(0, 30 - (lines.length - tailStart) - 4); // 尾部 + 3 头行 + 1 脚注
		if (detail > budget) {
			const keep = Math.max(0, budget - 1); // 给截断提示留 1 行
			const moreRepos = s.history.length > 0 ? 0 : Math.max(0, s.reposTotal - s.shown);
			lines.splice(3 + keep, detail - keep,
				`… 本页 ${detail - keep} 行截断（30 行上限）${moreRepos > 0 ? `; 还有 +${moreRepos} repos; /global-view --page ${s.cursor.page + 1}` : ""}`);
		}
	}
	return lines.slice(0, 30).join("\n");
}

// ── slash/tool 共用逻辑 ────────────────────────────────────────────

export const GLOBAL_VIEW_USAGE = "用法：/global-view [--history] [--page N] | /global-view inbox [--page N] | /global-view gc --dry-run|--apply（gc 未上线）";

export function parseGlobalViewArgs(raw: string): { ok: true; history: boolean; page: number; inbox: boolean } | { ok: false; text: string } {
	const parts = (raw ?? "").trim().split(/\s+/).filter(Boolean);
	let history = false; let inbox = false; let page = 1;
	for (let i = 0; i < parts.length; i++) {
		const p = parts[i]!;
		if (p === "--history") history = true;
		else if (p === "inbox") inbox = true;
		else if (p === "--page") {
			const n = Number(parts[++i]);
			if (!Number.isFinite(n) || n < 1) return { ok: false, text: GLOBAL_VIEW_USAGE };
			page = Math.floor(n);
		} else if (p === "gc") {
			return { ok: false, text: "global-view gc 未上线（只读阶段）：旧删源路径冻结中，不执行任何归档/删除" };
		} else return { ok: false, text: GLOBAL_VIEW_USAGE };
	}
	return { ok: true, history, page, inbox };
}

export function globalViewLogic(
	args: { history?: boolean; page?: number; section?: string },
	env: { agentDir?: string; now?: number; gitProbe?: GitProbe } = {},
): { text: string; details: Record<string, unknown> } {
	const section = (args.section ?? "").trim();
	if (section && section !== "inbox") return { text: GLOBAL_VIEW_USAGE, details: { isError: true } };
	const snap = collectGlobalView({
		...(env.agentDir ? { agentDir: env.agentDir } : {}),
		...(env.now !== undefined ? { now: env.now } : {}),
		history: section === "inbox" ? false : (args.history ?? false),
		page: args.page ?? 1,
		...(env.gitProbe ? { gitProbe: env.gitProbe } : {}),
	});
	if (section === "inbox") {
		const text = [`Global inbox p${snap.inboxPending}/c${snap.inboxClaimed}（只读计数，不消费/不 ack）`, `HOME ${snap.home.mail}`, ...snap.rows.filter((r) => r.mail !== "p0/c0").map((r) => `${r.display} ${r.mail}`)].join("\n");
		return { text, details: { pending: snap.inboxPending, claimed: snap.inboxClaimed, rows: snap.rows.map((r) => ({ repoPath: r.repoPath, mail: r.mail })) } };
	}
	// 头三件套之生成命令回显
	snap.command = `/global-view${section ? ` ${section}` : ""}${args.history ? " --history" : ""}${(args.page ?? 1) !== 1 ? ` --page ${args.page}` : ""}`;
	// 差分基线 best-effort 写（原子 tmp+rename；失败只记 warnings，绝不影响输出；只写本机 agentDir）
	try {
		writeGlobalViewBaseline(env.agentDir ?? defaultAgentDir(), snap.baselinePayload);
	} catch (e) {
		snap.warnings.push(`基线写失败(不影响输出): ${e instanceof Error ? e.message : String(e)}`);
	}
	return {
		text: formatGlobalView(snap),
		details: {
			owner: snap.owner, generation: snap.generation, reposTotal: snap.reposTotal,
			tabsActive: snap.tabsActive, totals: snap.totals, cursor: snap.cursor,
			rows: snap.rows.map((r) => ({ ...r })), warnings: snap.warnings,
			details: snap.details.map((d) => ({ ...d })), diff: { ...snap.diff },
			hygiene: snap.hygiene, command: snap.command,
		},
	};
}

export function isNoiseRepoPath(p: string): boolean { return isNoisePath(p); }
export { localMasterAddress };
