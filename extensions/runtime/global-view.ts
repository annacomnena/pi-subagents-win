/**
 * runtime/global-view.ts — 全局工作视野只读聚合（0923 计划 §2 首阶段）。
 *
 * 深模块：collector（只读扫描 + 归并）+ formatter（纯格式化），slash 与 tool
 * 共用同一查询 interface。never-throw：单文件坏只记 warnings，不整体失败。
 * GC apply / mailbox 执行链不在本模块内（gc 子命令只回用法 + disabled 提示）。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { normalizeExactPath, isNoisePath } from "./recent-scopes.ts";
import { localMasterAddress } from "./scope.ts";
import {
	classifyTabStatus,
	readTabResultFile,
	readTabState,
	validateTabDispatchRecord,
	type TabDispatchRecord,
} from "../tab-runs.ts";
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
}

const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_PAGE_SIZE = 20;
const MAX_SCAN_FILES = 5000;

function defaultAgentDir(): string { return join(homedir(), ".pi", "agent"); }
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
		allRows.sort((x, y) =>
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
		};
	} catch (e) {
		return {
			owner: "none", generation: "-", cutover: "off", asof: new Date(opts.now ?? Date.now()).toISOString(),
			reposTotal: 0, shown: 0, tabsActive: 0, timersPending: 0, inboxPending: 0, inboxClaimed: 0,
			home: { repoPath: "__HOME__", display: "HOME", local: "unknown", branch: "-", dirty: "-", tabText: "-", tabActive: 0, attention: 0, timer: 0, overdue: 0, mail: "p0/c0", mailPending: 0, plans: "-", plansCount: null, lastMs: 0, lastText: "?" },
			rows: [], totals: { orphaned: 0, terminal: 0, noResult: 0, attention: 0, gitUnknown: 0, otherMail: 0 },
			warnings: [`collect 失败（never-throw）：${e instanceof Error ? e.message : String(e)}`],
			cursor: { page: 1, pageSize: 20, totalPages: 1 }, history: [], historyTotal: 0, partial: true,
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
	for (const w of s.warnings.slice(0, 2)) lines.push(`warn: ${sanitize(w).slice(0, 100)}`);
	if (s.partial && !lines.some((l) => l.includes("partial"))) lines.push(`partial: 扫描超预算，计数可能不完整`);
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
	return {
		text: formatGlobalView(snap),
		details: {
			owner: snap.owner, generation: snap.generation, reposTotal: snap.reposTotal,
			tabsActive: snap.tabsActive, totals: snap.totals, cursor: snap.cursor,
			rows: snap.rows.map((r) => ({ ...r })), warnings: snap.warnings,
		},
	};
}

export function isNoiseRepoPath(p: string): boolean { return isNoisePath(p); }
export { localMasterAddress };
