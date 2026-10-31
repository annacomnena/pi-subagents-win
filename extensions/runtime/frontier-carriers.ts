/**
 * runtime/frontier-carriers.ts — 共享 carrier 归约（E2.0，MF4）。
 *
 * 从 `global-view.ts` 抽出的三个纯/准纯归约，供 GlobalView 与 Graph 两侧共用，
 * 消除「Graph 自写一份 TabDetail 计算」的双真相源（plans/0924_graph_E2_impl_plan.md §2/§3/§4）：
 *   1) `classifyDispatch`   — 可见性 / hidden 分流 + attention（原 global-view.ts 私有）
 *   2) `collectTimerByRepo` — timers pending-only 聚合成 per-repo {n,overdue}（原闭包内联）
 *   3) `reduceTabCarrier`   — 单条可见 tab 明细（原 buildTabDetail）；carrier 字段为
 *      `FrontierSourceTab` 子集，返回值保留 `TabDetail` 全字段供 global-view 渲染。
 *
 * 顺序依赖（行为保持，勿改）：v2 `collectGlobalView` 先以 `repoOverdue=0` 调
 * `reduceTabCarrier`（原 `#L586`），timers 聚合完成后再回填 `d.overdue`（原 `#L784`）；
 * Graph 侧预先算终值传入，终值等价。`readGateStatus` 留在调用点（本模块导出定义，
 * 但 `reduceTabCarrier` 只接收已算好的 `gate`，不再接收 `warnings`）。
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname as dirnameOf, join, resolve as resolveCwd } from "node:path";
import { normalizeExactPath } from "./recent-scopes.ts";
import {
	classifyTabStatus,
	composeTabStatus,
	isPersistentTabTaskId,
	probeSessionFile,
	readTabResultFile,
	readTabState,
	sessionBucketForCwd,
	type SessionProbe,
	type TabDispatchRecord,
	type TabResult,
	type TabState,
} from "../tab-runs.ts";
import { classifyForReclaim } from "../tab-runs-runtime.ts";
// 2026-11-01 L4 N-1：recentwork 文本解析已搬到零依赖模块，此处 re-export
// 保持既有 import 方（hydrate 之外的调用方 / 测试）零改动。
export { extractActiveTasksSection, buildRecentWorkExcerpt, GATE_ACTIVE_HEADING, GATE_INDEX_HEADING } from "./recentwork-text.ts";
import { extractActiveTasksSection, GATE_ACTIVE_HEADING, GATE_INDEX_HEADING } from "./recentwork-text.ts";

// ── 共享常量 / 基础工具 ────────────────────────────────────────────

/** 无进展阈值 45min（0923 phase2 裁定）：对齐 localText 既有 stale(30min) 口径上浮。 */
export const STALE_NO_PROGRESS_MS = 45 * 60 * 1000;
/** 最后 assistant 摘要截断 120 字。 */
export const SUMMARY_TRUNCATE_CHARS = 120;
/** 探活抽尾行数上限：lastStopReason/摘要只在 visible/active tab 上探。 */
export const MAX_PROBE_TAIL_LINES = 40;
/** 跨仓 `recentwork.md` 的 **`Active Tasks` 区段**读取上限（超 → 该仓 gate=unknown）。
 *  2026-10-12：语义由「整文件」改为「区段」，上限 64KB → 256KB（旧值使常见仓永久 unknown，见 readGateStatus 注）。 */
export const MAX_GATE_BYTES = 256 * 1024;

export function warn(out: string[], msg: string): void { if (out.length < 20) out.push(msg); }

export function readJson(path: string): Record<string, unknown> | null {
	try {
		const v: unknown = JSON.parse(readFileSync(path, "utf8"));
		return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
	} catch { return null; }
}

export function toMs(v: unknown): number | null {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v === "string" && v) { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
	return null;
}

export function relText(ms: number | null, now: number): string {
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

function truncateSummary(s: string): string {
	const t = s.replace(/[\x00-\x1f\x7f]/g, "").replace(/\n/g, " ").trim();
	return t ? t.slice(0, SUMMARY_TRUNCATE_CHARS) : "-";
}

/** cwd 沿父目录向上找 .git（≤8 层，不过 profile/盘根）；无则回退 cwd 本身。 */
export function findRepoRoot(cwd: string, cache: Map<string, string>): string {
	const norm = normalizeExactPath(cwd);
	const hit = cache.get(norm);
	if (hit) return hit;
	try {
		let cur = resolveCwd(cwd);
		for (let i = 0; i < 8; i++) {
			try {
				const g = join(cur, ".git");
				if (existsSync(g)) { cache.set(norm, cur); return cur; }
			} catch { break; }
			const parent = dirnameOf(cur);
			if (parent === cur) break;
			cur = parent;
		}
	} catch { /* fall through */ }
	cache.set(norm, cwd);
	return cwd;
}

// ── 闸口状态 / 可见性分流 ──────────────────────────────────────────

/** 跨仓闸口状态：awaiting=等人工动作 | ok=表中有行但无等人工 | unknown=缺文件/区段超限/表头漂移/解析异常 */
export type GateStatus = "awaiting" | "ok" | "unknown";

/** 索引表头列名别名（每一组**任一**命中即算该列在位）。 */
const GATE_HEADER_COLS: ReadonlyArray<readonly string[]> = [
	["item", "编号"],
	["priority", "优先级", "评级"],
	["summary", "简报", "一句话说明", "摘要"],
];
/** 状态行标记：`**Status**`（英）/ `**状态**`（中）。 */
const GATE_STATUS_LINE = /\*\*\s*(?:Status|状态)\s*\*\*/;
/** 「等人工」词（英中并集，只在区段内匹配）。 */
const GATE_AWAITING =
	/(?:waiting|awaiting|needs?-?human|等人工|需人工|待人工|待用户|待验收|待实机|待宿主|待复测|挂账)/i;




/**
 * 只读各仓 `<repo>/recentwork.md` 的 **`## Active Tasks` 区段**（含 `### Task Index` 表与 `**Status**` 行），
 * 判定「等人工动作」证据。方言并集见上方常量——英文表头与 GreenCAD 的中文表头都能解析。
 *
 * `unknown` 情形（单仓异常由调用方记 warnings）：
 *   文件缺失 / **`Active Tasks` 区段**超 `MAX_GATE_BYTES` / 缺索引表标题 / 表头漂移 / 解析异常。
 *
 * 2026-10-12 修复（“套件瞎了一只眼”）：
 *   - 上限**只作用于 `Active Tasks` 区段**，不再作用于整文件。旧实现按整文件卡 64KB，
 *     使 recentwork 自然膨胀的仓（GreenCAD 214KB、本仓 100KB+）**永久降级 `unknown`**，
 *     于是 gate 类触发（`blocked_to_ready`、“gate=awaiting → needs_user”）**永不触发**、
 *     actions 自 10-08 起零产出。上限抬到 256KB（区段级），仅当区段病态膨胀时才降级。
 *   - 旧实现只认英文表头（`## Active Tasks` / `### Task Index` / `Item|Priority|Summary`），
 *     中文方言仓因此永久 `unknown`；现并集两种方言。
 *   - `readFileSync` 本来就是整文件读（上限不是省内存手段），故区段化**不增加**读取成本。
 */
export function readGateStatus(repoPath: string, warnings: string[]): GateStatus {
	try {
		const f = join(repoPath, "recentwork.md");
		if (!existsSync(f)) return "unknown";
		let text: string;
		try { text = readFileSync(f, "utf8"); } catch { return "unknown"; }
		// 切出 Active Tasks 区段（到下一个 `## ` 为止）；区段缺失 → unknown
		const section = extractActiveTasksSection(text);
		if (section === null) return "unknown";
		if (section.length > MAX_GATE_BYTES) {
			warn(warnings, `gate 区段超 ${Math.round(MAX_GATE_BYTES / 1024)}KB 降级 unknown: ${basename(repoPath)}`);
			return "unknown";
		}
		let sawIndex = false; let colsOk = false; let awaiting = false;
		for (const line of section.split("\n")) {
			if (GATE_INDEX_HEADING.test(line)) { sawIndex = true; continue; }
			if (GATE_STATUS_LINE.test(line) && GATE_AWAITING.test(line)) awaiting = true;
			if (sawIndex && !colsOk && line.includes("|")) {
				const h = line.toLowerCase();
				colsOk = GATE_HEADER_COLS.every((alias) => alias.some((a) => h.includes(a.toLowerCase())));
				if (!colsOk) { warn(warnings, `gate 表头漂移降级 unknown: ${basename(repoPath)}`); return "unknown"; }
			}
		}
		if (!sawIndex || !colsOk) return "unknown";
		return awaiting ? "awaiting" : "ok";
	} catch { return "unknown"; }
}

export interface TabNote { phase: string; active: boolean; attention: boolean; hiddenKind: "orphaned" | "terminal" | null; noResult: boolean; at: string }

/** 单条 dispatch 的可见性/attention 分流（visible = hiddenKind===null）。 */
export function classifyDispatch(rec: TabDispatchRecord, runsDir: string, now?: number): TabNote {
	const at = rec.dispatchedAt;
	try {
		const result = readTabResultFile(runsDir, rec.id);
		if (result) {
			const terminal = result.status === "completed" || result.status === "failed" || result.status === "cancelled";
			if (terminal) return { phase: result.status, active: false, attention: false, hiddenKind: "terminal", noResult: false, at };
			// RF-1（2026-10-18）：兜底结果（unconfirmed/autoGenerated）**不是终态，也不得隐藏**。
			// 修前此分支把任何非三态 result 硬写成 `phase:"completed" + hiddenKind:"terminal"`，
			// 等于把「tab 没回报」伪装成「完成」并从摘要里摘掉（违反 RF-1 硬约束 1）；
			// 且 `refs.runPhases` 取到的 completed 会让监管判 DONE，需人核实的信号彻底消失。
			// 唯一合法的非终态 result 形状就是兜底 unconfirmed ⇒ 可见 + 待审（attention=true），
			// 且 active=true（未确认完成 ⇒ 不得计入「可关账」，与下面 state.terminal 无 result 分支同口径）。
			return { phase: result.status, active: true, attention: true, hiddenKind: null, noResult: true, at };
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
		const st = classifyTabStatus(null, { dispatchedAt: rec.dispatchedAt, now });
		if (st.phase === "orphaned") return { phase: "orphaned", active: false, attention: false, hiddenKind: "orphaned", noResult: true, at };
		return { phase: st.phase, active: true, attention: st.phase === "unconfirmed", hiddenKind: null, noResult: true, at };
	} catch {
		return { phase: "unknown", active: false, attention: false, hiddenKind: null, noResult: true, at };
	}
}

// ── tab 明细（carrier 归约核心）────────────────────────────────────

/** carrier 子集（frontier 输入载体，plans/0924_graph_E2_impl_plan.md §3 `FrontierSourceTab`）。 */
export interface FrontierSourceTab {
	runId: string;
	repoPath: string;
	phase: string;
	/** 最后一条 assistant 消息 stopReason（`state.lastStopReason ?? probe.lastStopReason ?? "unknown"`）。
	 *  2026-10-17 监管 P0：进 carrier 才能区分「正在跑工具(toolUse) vs 真空闲(stop)」。 */
	stop: string;
	/** 距 state.lastActivityAt 的毫秒数；无 state / 无该字段 → null（**不拿 mtime 冒充**）。
	 *  监管 P0：SOFT/PUSH/USER 分档需要结构化时间基（旧 staleOver 只是 45min 布尔）。 */
	idleMs: number | null;
	needsHuman: boolean;
	gate: GateStatus;
	staleOver: boolean;
	overdue: number;
	resultMissing: boolean;
	/** state.pid + process.kill 探活（同 global-view 原 #L404-L408）；无 state.pid → null，不猜。 */
	pidAlive: boolean | null;
}

/** phase2 每 tab 明细行（纯增量列；读不到一律 unknown，绝不猜、绝不拿 mtime 冒充 lastActivityAt）。 */
export interface TabDetail extends FrontierSourceTab {
	taskId: string;
	age: string;
	stale: string;
	artifact: string;
	artifactMtime: string;
	terminal: boolean;
	openIssues: number | null;
	summary: string;
}

export interface TabCarrierInput {
	rec: TabDispatchRecord;
	/** probe 决策依赖 sessionsRoot（`!state?.lastStopReason || !state?.lastAssistantText` → probeVisibleTab）。 */
	sessionsRoot: string;
	repoPath: string;
	/** 顺序依赖：v2 先传 0（原 #L586），timers 聚合后由调用方回填（原 #L784）。 */
	repoOverdue: number;
	now: number;
	/** readGateStatus 结论由调用点算好传入（warnings 留在调用点）。 */
	gate: GateStatus;
	/** state/result 由调用点读取后传入（composeTabStatus 抛错时 phase 回退链依赖二者）。 */
	state: TabState | null;
	result: TabResult | null;
}

// ── 常驻 local master 识别（autonomy 越界修法，2026-10-19）────────

/**
 * 是否「常驻 local master / master 派发」tab（`lms-*` / `master-*`）。
 *
 * 判据本身是共享的（`tab-runs.ts::isPersistentTabTaskId`，**唯一真相源**）：
 * `lms-` 前缀的唯一产生点 = `runtime/local-master-launch.ts` `ensureTaskId(scope)`。
 * 本模块只负责把它翻成 autonomy 语义（见 `computeNeedsHuman`）。禁止在此重写前缀字面量。
 */
export function isResidentLocalMasterTab(rec: Pick<TabDispatchRecord, "taskId">): boolean {
	return isPersistentTabTaskId(rec.taskId);
}

/**
 * carrier `needsHuman` 计算（**唯一计算点**，v1 与 graph 两源共用 reduceTabCarrier）。
 *
 * ## 为什么普通 tab 用 `reclaim === "awaitingInput"`
 * `classifyForReclaim` 把 `phase==="waiting"` 归 `awaitingInput`（tab-runs-runtime.ts:547）——
 * 对**任务 tab** 这是对的：这回合跑完了、在等主会话下一步。**该函数是共享的，不得为本修复改动**
 * （`reclaim-tabs` / `tab-status` 依赖同一语义，见计划 §3.1）。
 *
 * ## 为什么常驻 tab 必须收紧（2026-10-19 越界事故）
 * local master 的**正常态就是 `waiting`（等信）**，它有自己的 per-repo scope wake（30s tick）负责唤醒，
 * **不由 autonomy 代管**（用户裁决：autonomy 只为主会话服务）。旧判据把它的「空闲」读成
 * 「用户在等人决策」⇒ `needs_user` 边沿 ⇒ 拉起 `l2-*` ⇒ 无活可干 ⇒ 又回 waiting ⇒ **无限回声**。
 *
 * 常驻 tab 的 needsHuman 收紧为：
 *   `gate === "awaiting"`  —— 仓级载体，与本收紧**正交**（仓在等人工与 tab 相位无关，不受影响）
 *   `∨ stop === "error"`  —— 本回合真报错（唯一真实可命中的分支；lms 长期 `stop=stop`/`toolUse`）
 *   `∨ pidAlive === false` —— 结构性保险。**不得声称它是主要发现手段**：`state.pid` 只在
 *      `session_start` 写一次、下一回合即被整文件替换丢掉 ⇒ 实测 3/3 lms `pidAlive=null`（计划 §5.2）。
 *
 * **不得**加入的判据（审查已核实，勿再犯）：
 *   - `phase === "waiting"`：常驻等待是常态，这正是回声源。
 *   - `resultMissing`：carriers 层语义是「无 result 文件」（tab-runs.ts `composeTabStatus` 无条件 true），
 *     而 local master 明令不调 tab-finish、兜底写入器对常驻身份豁免（`tab-runs-runtime.ts`）
 *     ⇒ 真实 lms 恒 true ⇒ 等于没改。
 *   - `idleMs` 超阈值：常驻等待数小时是常态，任何阈值都会成为新的边沿源（审查明确不建议）。
 *
 * 真「死了」的发现通道不在本判据（正交且已存在）：`local-master-ensure` 的 `owner-pid-dead`（读
 * scope-liveness 真 pid）、mailbox 积压 → `ws_mail_backlog`。**已知边界**：无周期性 lms liveness 巡检。
 */
export function computeNeedsHuman(input: {
	rec: Pick<TabDispatchRecord, "taskId">;
	/** classifyForReclaim 结论（仅普通 tab 消费）。 */
	reclaim: string;
	gate: GateStatus;
	stop: string;
	pidAlive: boolean | null;
}): boolean {
	const { rec, reclaim, gate, stop, pidAlive } = input;
	if (isResidentLocalMasterTab(rec)) {
		return gate === "awaiting" || stop === "error" || pidAlive === false;
	}
	return reclaim === "awaitingInput" || gate === "awaiting";
}

/**
 * 可见 tab 的 tail-capped 会话探活（复用 probeSessionFile；只读 bucket 内 .jsonl）。
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

/**
 * 构建单条可见 tab 明细（原 buildTabDetail）。判态复用 composeTabStatus（result>state>probe 回退链）
 * + classifyForReclaim（awaitingInput 判定）；每列读不到→unknown，绝不猜。
 */
export function reduceTabCarrier(input: TabCarrierInput): TabDetail | null {
	const { rec, sessionsRoot, repoPath, repoOverdue, now, gate, state, result } = input;
	try {
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
			const view = composeTabStatus({ runId: rec.id, dispatch: rec, state, result, probe, dispatchedAt: rec.dispatchedAt, now });
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
		const computedNeedsHuman = computeNeedsHuman({ rec, reclaim, gate, stop, pidAlive });
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
		return {
			runId: rec.id, repoPath, phase, taskId: rec.taskId || "unknown",
			age: ageMs !== null ? relText(now - ageMs, now) : "?",
			stale: staleMs !== null ? relText(now - staleMs, now) : "unknown",
			staleOver, stop, idleMs: staleMs,
			artifact, artifactMtime, resultMissing, terminal,
			openIssues: Array.isArray(result?.openIssues) ? result.openIssues.length : null,
			summary: truncateSummary(probe?.lastAssistantText ?? state?.lastAssistantText ?? result?.finalText ?? result?.summary ?? ""),
			needsHuman: computedNeedsHuman,
			gate, overdue: repoOverdue, pidAlive,
		};
	} catch { return null; }
}

// ── timers 聚合（pending-only）─────────────────────────────────────

export interface TimerByRepo {
	/** 归一化 repoPath → {n: pending 总数, overdue: due<now 数}。 */
	byRepo: Map<string, { n: number; overdue: number }>;
	/** pending 总数（含 unmapped）。 */
	pending: number;
	/** 无 repo 归属（ownerCwd 缺失/不可映射、mail run 未映射）的 pending 数。 */
	unmapped: number;
	/** 扫描异常信息（调用方记 warnings）；成功时 undefined。 */
	error?: string;
}

/**
 * timers → per-repo pending/overdue 聚合（原 collectGlobalView 闭包内联代码）。
 * pending-only；root timer 按 ownerCwd 归属、mail timer 按 runToRepo 映射；
 * `due < now` 计 overdue；无归属计 unmapped。never-throw。
 */
export function collectTimerByRepo(timersDir: string, now: number, runToRepo: ReadonlyMap<string, string>): TimerByRepo {
	const byRepo = new Map<string, { n: number; overdue: number }>();
	let pending = 0; let unmapped = 0;
	const repoCache = new Map<string, string>();
	const bump = (repoPath: string | null, dueAt: unknown): void => {
		const due = toMs(dueAt) ?? 0;
		const od = due > 0 && due < now ? 1 : 0;
		if (!repoPath) { unmapped++; return; }
		const k = normalizeExactPath(repoPath);
		const e = byRepo.get(k) ?? { n: 0, overdue: 0 };
		e.n++; e.overdue += od; byRepo.set(k, e);
	};
	try {
		if (existsSync(timersDir)) {
			for (const f of readdirSync(timersDir)) {
				if (!f.endsWith(".json") || f.endsWith(".tmp")) continue;
				const full = join(timersDir, f);
				try { if (statSync(full).isDirectory()) continue; } catch { continue; }
				const r = readJson(full);
				if (!r || r.status !== "pending") continue;
				pending++;
				const ownerCwd = typeof r.ownerCwd === "string" && r.ownerCwd ? r.ownerCwd : null;
				bump(ownerCwd ? findRepoRoot(ownerCwd, repoCache) : null, r.dueAt);
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
						pending++;
						const repo = runToRepo.get(run) ?? null;
						bump(repo, r.dueAt);
					}
				}
			}
		}
	} catch (e) {
		return { byRepo, pending, unmapped, error: e instanceof Error ? e.message : String(e) };
	}
	return { byRepo, pending, unmapped };
}
