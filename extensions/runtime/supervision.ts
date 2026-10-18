/**
 * runtime/supervision.ts — 停滞监管账本（P0：显式人力监管意图，零推动行为）
 *
 * 方案：`plans/20261017_stagnation_supervision_plan.md` §B.2（账本地基）/ §E-P0；
 * 实现计划：`plans/20261017_supervision_p0_impl.md` §2.1。
 *
 * 为什么存在：`autonomy/frontier.ts` 的 `stagnation` 之前是 `staleOver ∨ resultMissing`，
 * 而 `resultMissing = phase==="unconfirmed"`（与时间无关）⇒ 任何没有 result.json 的非终态 tab
 * **立刻** stagnation=true，零区分度（实测三条线 3/3 全 true，其中两条是"在跑/用户暂停"）。
 * 修法不是缩阈值，而是先立「谁被要求监管」这个**权威意图**载体。
 *
 * 存储（SoT = 每 runId 一文件的账本，纪律逐条镜像 `expectations.ts`）：
 *   <stateDir>/supervision/open/<runId>.json     ← 监管中（active / paused）
 *   <stateDir>/supervision/closed/<runId>.json   ← 已关账（wx first-wins = 原子线性化点）
 *
 * - `stateDir` 缺省 `<runtimeDir>/state`（同 expectations / liveness / scope-consume 惯例）。
 * - **status 存字段**（active|paused 是用户显式意图，不是目录派生状态；目录只区分
 *   open/closed 两个生命周期状态，同 expectations 的 open/closed 语义）。
 * - 同 id 两目录并存（关账竞态残留）时读取 **closed 优先**（终态收敛）。
 * - 原子 tmp+rename、路径可注入、**全部 never-throw**、纯库无 Pi API。
 *
 * ## 红线（与 expectations.ts:25 同构）
 * **autonomy 只读本账本，永不写**：`autonomy/collect.ts::readSupervisionInputs` 是唯一
 * autonomy 侧接触点，且只调读入口。写入口的调用方只有主会话侧（`/supervise` 命令）。
 * 理由：被监管者不得自报停滞（否则「关掉监管」与「没有停滞」在派生面不可区分）。
 *
 * ## P0 边界（硬约束）
 * 本模块**只记录意图 + 派生显示**。P0 **不含**任何推动/注入/abort：不调用 tab-steer /
 * set-timer / steer / spawn。`epoch.pushes` 因此恒为空数组（字段留给 P1 的 `supervise-push`）。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { defaultRuntimeDir } from "./journal.ts";
import { defaultTabRunsDir, isUnconfirmedFallback, readTabDispatch, readTabResultFile } from "../tab-runs.ts";
import type { FrontierSnapshot, ProjectSupervision } from "./autonomy/frontier.ts";

// ── 常量 ───────────────────────────────────────────────────────────

/**
 * 分级阈值缺省值（方案 §A.1）。
 *   SOFT 5min  — 只进快照 + status 显示，不报
 *   PUSH 15min — STALLED 判据线（P0 只报不推）
 *   USER 30min — 升级用户线（P0 仅作派生展示）
 *   HANG 60min — working ∧ stop=toolUse 的"疑似工具挂死"线（P0 不动作，P2 才接）
 * 依据见方案 §A.1（正常推进 P95≈0.7min；≥15min 的 7 次里 5 次是合法停）。
 */
export const SUPERVISION_THRESHOLDS = {
	softMs: 5 * 60_000,
	pushMs: 15 * 60_000,
	userMs: 30 * 60_000,
	hangMs: 60 * 60_000,
} as const;

/** 账本记录版本（形状变更必须 bump；读侧严格校验）。 */
export const SUPERVISION_LEDGER_VERSION = 1 as const;

/** 监管生命周期的持久状态（`open/` 内的 status 字段）。 */
export type SupervisionStatus = "active" | "paused";

/** 派生态（每 tick 纯派生，不落盘；见 frontier.ts `SupervisionState`）。 */
export type SupervisionDerivedState =
	| "NOT_MONITORED"
	| "ACTIVE"
	| "PAUSED_USER"
	| "BLOCKED_USER"
	| "DONE"
	| "STALLED";

export interface SupervisionPushRecord {
	at: string;
	steerId: string;
	outcome: string;
}

export interface SupervisionEntry {
	version: 1;
	/** tab 账本 runId（与 `tab-runs/<runId>.json` 同主键）。 */
	runId: string;
	/** 任务标识（人类可读；缺省取 dispatch.taskId）。 */
	taskId: string;
	/** 归一化仓库路径（缺省取 dispatch.cwd；仅用于显示/归因，不参与判据键）。 */
	repoPath: string | null;
	status: SupervisionStatus;
	/** 谁写的（`user:<session>` / `master:<session>`）；审计用。 */
	setBy: string;
	setAt: string;
	/** 仅在 status==="paused" 时有值。 */
	pausedAt: string | null;
	pauseReason: string | null;
	/** 阈值覆盖（缺省 = SUPERVISION_THRESHOLDS；P0 不接 config，只允许逐账本覆盖）。 */
	softMs?: number;
	pushMs?: number;
	userMs?: number;
	/** 推动 epoch（P1 才写；P0 恒 `pushes: []`，只读消费）。 */
	epoch: { startedAt: string; pushes: SupervisionPushRecord[] };
	/**
	 * 显式「静默」标记（2026-10-18 默认监管开启后新增；v1 可选字段）。
	 * 语义：账本仍留档（open/ 不删、不进 closed/），但派生面按 NOT_MONITORED 处理（不问不动）。
	 * 与 `status` 正交：status 保持 active，optOut 只影响 `deriveTabSupervisionState` 的判据。
	 * 缺失 = 未静默（不是 false —— v1 不引入第二个 falsy 形状）。
	 */
	optOut?: true;
	// ── 终态字段（closed/ 才有；open/ 恒缺省）──
	closedBy?: string;
	closedAt?: string;
	closeReason?: string;
}

// ── 路径 ───────────────────────────────────────────────────────────

/** 账本根：`<stateDir>/supervision`（stateDir 缺省 = `<runtimeDir>/state`）。 */
export function supervisionRootForStateDir(stateDir?: string): string {
	return join(stateDir ?? join(defaultRuntimeDir(), "state"), "supervision");
}

function safeFile(id: string): string {
	return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

function openDir(root: string): string {
	return join(root, "open");
}

function closedDir(root: string): string {
	return join(root, "closed");
}

function entryPath(root: string, runId: string, closed: boolean): string {
	return join(closed ? closedDir(root) : openDir(root), `${safeFile(runId)}.json`);
}

/** 账本根是否存在 ⟺ 本进程可见的账本载体存在（frontier `supervision === undefined` 的判据）。 */
export function supervisionDirExists(opts: { root?: string; stateDir?: string } = {}): boolean {
	try {
		return existsSync(opts.root ?? supervisionRootForStateDir(opts.stateDir));
	} catch {
		return false;
	}
}

// ── 内部 IO（原子 / tolerant）──────────────────────────────────────

function writeJsonAtomic(path: string, value: unknown): void {
	const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}

function isFinitePositive(v: unknown): boolean {
	return typeof v === "number" && Number.isFinite(v) && v > 0;
}

function validateEntry(v: unknown): v is SupervisionEntry {
	if (typeof v !== "object" || v === null) return false;
	const r = v as Record<string, unknown>;
	if (r.version !== SUPERVISION_LEDGER_VERSION) return false;
	if (typeof r.runId !== "string" || r.runId.length === 0) return false;
	if (r.status !== "active" && r.status !== "paused") return false;
	if (typeof r.setBy !== "string" || typeof r.setAt !== "string") return false;
	if (!Number.isFinite(Date.parse(String(r.setAt)))) return false;
	const ep = r.epoch as Record<string, unknown> | undefined;
	if (typeof ep !== "object" || ep === null) return false;
	if (typeof ep.startedAt !== "string") return false;
	if (!Array.isArray(ep.pushes)) return false;
	for (const k of ["softMs", "pushMs", "userMs"] as const) {
		if (r[k] !== undefined && !isFinitePositive(r[k])) return false;
	}
	// optOut 为可选布尔标记：缺失合法；存在则必须严格 === true（拒绝 "yes"/1 等宽松形状）
	if (r.optOut !== undefined && r.optOut !== true) return false;
	return true;
}

function readEntryFile(path: string): SupervisionEntry | null {
	try {
		const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
		return validateEntry(raw) ? raw : null;
	} catch {
		return null;
	}
}

// ── 读（closed 优先）───────────────────────────────────────────────

/** 容忍读单条：**closed/ 优先**（终态收敛）；缺失/坏 → null。 */
export function readSupervisionLedger(runId: string, opts: { root?: string; stateDir?: string } = {}): SupervisionEntry | null {
	try {
		const root = opts.root ?? supervisionRootForStateDir(opts.stateDir);
		return readEntryFile(entryPath(root, runId, true)) ?? readEntryFile(entryPath(root, runId, false));
	} catch {
		return null;
	}
}

/** 全部未关账条目（open/ 且 closed/ 无同 id；坏文件跳过）。目录缺失 → []。 */
export function listOpenSupervisionEntries(opts: { root?: string; stateDir?: string } = {}): SupervisionEntry[] {
	const root = opts.root ?? supervisionRootForStateDir(opts.stateDir);
	const dir = openDir(root);
	if (!existsSync(dir)) return [];
	const out: SupervisionEntry[] = [];
	try {
		for (const f of readdirSync(dir)) {
			if (!f.endsWith(".json")) continue;
			const runId = f.slice(0, -".json".length);
			if (existsSync(entryPath(root, runId, true))) continue; // closed 优先：僵尸 open 不进集合
			const rec = readEntryFile(join(dir, f));
			if (rec) out.push(rec);
		}
	} catch {
		return out;
	}
	return out.sort((a, b) => a.runId.localeCompare(b.runId));
}

/** 未关账的 runId 列表（监管集合的最小投影）。 */
export function listSupervisedRunIds(opts: { root?: string; stateDir?: string } = {}): string[] {
	return listOpenSupervisionEntries(opts).map((e) => e.runId);
}

/** 条目生效阈值（账本覆盖优先，其次缺省常量）。 */
export function thresholdsOf(entry: SupervisionEntry | null): { softMs: number; pushMs: number; userMs: number; hangMs: number } {
	return {
		softMs: isFinitePositive(entry?.softMs) ? (entry!.softMs as number) : SUPERVISION_THRESHOLDS.softMs,
		pushMs: isFinitePositive(entry?.pushMs) ? (entry!.pushMs as number) : SUPERVISION_THRESHOLDS.pushMs,
		userMs: isFinitePositive(entry?.userMs) ? (entry!.userMs as number) : SUPERVISION_THRESHOLDS.userMs,
		hangMs: SUPERVISION_THRESHOLDS.hangMs,
	};
}

// ── 写（主会话侧专用；autonomy 红线：永不可达）──────────────────────

export type WriteResult = { ok: boolean; reason?: "invalid" | "error"; entry?: SupervisionEntry };

/**
 * 写/更新一条 open 记录（**原子 tmp+rename**；never-throw）。
 * 已关账（closed/ 有同 id）→ 拒绝（`invalid`）：终态不得重开（同 expectations 的 closed 语义）。
 */
export function writeSupervisionEntry(input: SupervisionEntry, opts: { root?: string; stateDir?: string } = {}): WriteResult {
	try {
		if (!validateEntry(input)) return { ok: false, reason: "invalid" };
		const root = opts.root ?? supervisionRootForStateDir(opts.stateDir);
		if (readEntryFile(entryPath(root, input.runId, true))) return { ok: false, reason: "invalid" };
		mkdirSync(openDir(root), { recursive: true });
		writeJsonAtomic(entryPath(root, input.runId, false), input);
		return { ok: true, entry: input };
	} catch {
		return { ok: false, reason: "error" };
	}
}

export interface SetStatusInput {
	runId: string;
	status: SupervisionStatus;
	/** 写者身份（`user:<sid>` / `master:<sid>`）。 */
	setBy: string;
	/** paused 时的理由（人类可读）。 */
	reason?: string;
	/** 阈值覆盖（仅首次登记/更新时生效）。 */
	overrides?: { softMs?: number; pushMs?: number; userMs?: number };
	/** 首次登记时从 tab-runs dispatch 补齐 taskId/repoPath；缺省 true。 */
	fromDispatch?: boolean;
}

/**
 * 登记或切换监管状态（active ⇄ paused）。不存在则新建（`on`/`resume`/`pause` 共用）。
 * - 新建：taskId/repoPath 缺省从 `tab-runs/<runId>.json` dispatch 取（读不到 → "unknown"/null，不猜）。
 * - 切换：保留 taskId/overrides/epoch；paused → 写 pausedAt/pauseReason；active → 清二者。
 * - never-throw；关账记录不可复活。
 */
export function setSupervisionStatus(input: SetStatusInput, opts: { root?: string; stateDir?: string; now?: Date; tabRunsDir?: string } = {}): WriteResult {
	try {
		const root = opts.root ?? supervisionRootForStateDir(opts.stateDir);
		const now = (opts.now ?? new Date()).toISOString();
		const cur = readSupervisionLedger(input.runId, { root });
		if (cur?.closedAt) return { ok: false, reason: "invalid" };
		let base: SupervisionEntry;
		if (cur) {
			base = { ...cur };
		} else {
			base = freshEntry(input.runId, input.setBy, now, opts.tabRunsDir, input.fromDispatch !== false);
			if (input.overrides) {
				if (isFinitePositive(input.overrides.softMs)) base.softMs = input.overrides.softMs;
				if (isFinitePositive(input.overrides.pushMs)) base.pushMs = input.overrides.pushMs;
				if (isFinitePositive(input.overrides.userMs)) base.userMs = input.overrides.userMs;
			}
		}
		base.status = input.status;
		base.setBy = input.setBy;
		base.setAt = now;
		if (input.status === "paused") {
			base.pausedAt = cur?.status === "paused" && cur.pausedAt ? cur.pausedAt : now; // 幂等：重复 pause 不改首次时刻
			base.pauseReason = input.reason ?? cur?.pauseReason ?? null;
		} else {
			base.pausedAt = null;
			base.pauseReason = null;
			// 显式用户 active（`/supervise on|resume`）覆盖此前的 optOut 静默标记；
			// 自动派发登记不是新的用户意图，重复登记同一 runId 不得清除用户 optOut。
			// paused 分支不碰 optOut（暂停 ≠ 取消静默），保持原值。
			if (input.fromDispatch !== true) delete base.optOut;
		}
		if (input.overrides) {
			if (isFinitePositive(input.overrides.softMs)) base.softMs = input.overrides.softMs;
			if (isFinitePositive(input.overrides.pushMs)) base.pushMs = input.overrides.pushMs;
			if (isFinitePositive(input.overrides.userMs)) base.userMs = input.overrides.userMs;
		}
		return writeSupervisionEntry(base, { root });
	} catch {
		return { ok: false, reason: "error" };
	}
}

/**
 * 新建一条 open 条目的骸架（`setSupervisionStatus` / `setSupervisionOptOut` 共用）。
 * taskId/repoPath 缺省从 `tab-runs/<runId>.json` dispatch 取（读不到 → "unknown"/null，不猜）。
 */
function freshEntry(runId: string, by: string, now: string, tabRunsDir: string | undefined, fromDispatch: boolean): SupervisionEntry {
	const dispatch = fromDispatch ? safeDispatch(runId, tabRunsDir) : null;
	return {
		version: SUPERVISION_LEDGER_VERSION,
		runId,
		taskId: dispatch?.taskId && dispatch.taskId.length > 0 ? dispatch.taskId : "unknown",
		repoPath: dispatch?.cwd && dispatch.cwd.length > 0 ? dispatch.cwd : null,
		status: "active",
		setBy: by,
		setAt: now,
		pausedAt: null,
		pauseReason: null,
		epoch: { startedAt: now, pushes: [] },
	};
}

/**
 * 显式「静默」写入口（2026-10-18 默认监管开启后新增；`/supervise optout <runId>`）。
 *
 * 与 `closeSupervisionEntry`（`/supervise off`）的区别：
 *   - `off`    = 关账（open → closed），条目**离开**监管集合 = 「这个结束了」
 *   - `optout` = 静默留档（open/ 不变、不进 closed/），status 仍 active 但 `optOut: true`
 *     ⇒ `deriveTabSupervisionState` 返 NOT_MONITORED（不问不动）= 「这个别管我」
 * 已关账（closed/）→ `{ok:false, reason:"invalid"}`：终态不得重开（同 writeSupervisionEntry 口径）。
 * never-throw。
 */
export function setSupervisionOptOut(
	runId: string,
	by: string,
	opts: { root?: string; stateDir?: string; now?: Date; tabRunsDir?: string } = {},
): WriteResult {
	try {
		const root = opts.root ?? supervisionRootForStateDir(opts.stateDir);
		const now = (opts.now ?? new Date()).toISOString();
		const cur = readSupervisionLedger(runId, { root });
		if (cur?.closedAt) return { ok: false, reason: "invalid" };
		const base: SupervisionEntry = cur ? { ...cur } : freshEntry(runId, by, now, opts.tabRunsDir, true);
		base.status = "active"; // 静默 ≠ 暂停：status 斜交，optOut 才是派生判据
		base.optOut = true;
		base.setBy = by;
		base.setAt = now;
		base.pausedAt = null;
		base.pauseReason = null;
		return writeSupervisionEntry(base, { root });
	} catch {
		return { ok: false, reason: "error" };
	}
}

function safeDispatch(runId: string, tabRunsDir?: string): { taskId?: string; cwd?: string } | null {
	try {
		const rec = readTabDispatch(tabRunsDir ?? defaultTabRunsDir(), runId);
		if (!rec) return null;
		return { taskId: rec.taskId, cwd: rec.cwd };
	} catch {
		return null;
	}
}

export interface CloseResult {
	ok: boolean;
	reason?: "no-entry" | "closed" | "error";
	entry?: SupervisionEntry;
}

/**
 * 关账（open → closed）。**wx first-wins = 原子线性化点**（恰一个赢家；输家 EEXIST 幂等放弃），
 * 成功后 best-effort 删 open 残留（读取侧 closed 优先兜底）。never-throw。
 */
export function closeSupervisionEntry(
	runId: string,
	by: string,
	opts: { root?: string; stateDir?: string; now?: Date; reason?: string } = {},
): CloseResult {
	try {
		const root = opts.root ?? supervisionRootForStateDir(opts.stateDir);
		const cur = readSupervisionLedger(runId, { root });
		if (!cur) return { ok: false, reason: "no-entry" };
		if (cur.closedAt) return { ok: false, reason: "closed" };
		const now = (opts.now ?? new Date()).toISOString();
		const terminal: SupervisionEntry = { ...cur, closedBy: by, closedAt: now, closeReason: opts.reason ?? "manual" };
		mkdirSync(closedDir(root), { recursive: true });
		try {
			writeFileSync(entryPath(root, runId, true), `${JSON.stringify(terminal, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
		} catch {
			return { ok: false, reason: "closed" }; // EEXIST = 已有终态（输家）；其余 IO 错误按输家处理
		}
		try {
			unlinkSync(entryPath(root, runId, false));
		} catch {
			/* 残留由 closed 优先读取收敛 */
		}
		return { ok: true, entry: terminal };
	} catch {
		return { ok: false, reason: "error" };
	}
}

// ── 派发即登记（2026-10-18 默认监管翻转）──────────────────────────

export interface DispatchedTabLike {
	runId?: string;
	error?: string;
	title?: string;
}

export interface AutoRegisterDeps {
	/** 写者身份（`master:<sessionId>`）。 */
	setBy: string;
	stateDir?: string;
	tabRunsDir?: string;
	now?: Date;
	/** 可注入的写入口（测试用）；缺省 `setSupervisionStatus`。 */
	setStatus?: typeof setSupervisionStatus;
	/** 审计行接收器（注入 `appendAuditLine`）；不传则静默丢弃（不 import autonomy/**）。 */
	audit?: (line: string) => void;
}

/**
 * 派发成功后自动登记监管账本（launch-tabs / master-dispatch 共用入口）。
 *
 * 背景（用户指令 2026-10-18）：**「只要是我派出去的 tab，默认就进监管账本」**。旧默认相反（无账本 ⇒
 * NOT_MONITORED ⇒ 静默），把「记得授权」的负担留给了人 ⇒ SBS tab 停 8.5h 无人报。
 *
 * 约束：
 *   - 只登记 `!item.error && item.runId` 的条目；失败项不建账本（error 也可能带 runId）。
 *   - **整体 never-throw**：单条失败继续，失败时调 `deps.audit`。即使注入的 setStatus 抛异常也 catch 住。
 *   - **不写 autonomy/**：audit 是注入的（supervision.ts 被 collect.ts import，反向 import 会成环
 *     并踩 `_test_runtime_autonomy.ts` A10）。
 */
export function autoRegisterDispatchedTabs(
	results: ReadonlyArray<DispatchedTabLike>,
	deps: AutoRegisterDeps,
): { registered: number; failed: number } {
	let registered = 0;
	let failed = 0;
	for (const item of Array.isArray(results) ? results : []) {
		if (!item || item.error) continue;
		const runId = typeof item.runId === "string" ? item.runId : "";
		if (!runId) continue;
		try {
			const setStatus = deps.setStatus ?? setSupervisionStatus;
			const r = setStatus(
				{ runId, status: "active", setBy: deps.setBy, fromDispatch: true },
				{ stateDir: deps.stateDir, tabRunsDir: deps.tabRunsDir, now: deps.now },
			);
			if (r?.ok === true) registered++;
			else {
				failed++;
				try { deps.audit?.(`supervision auto-register fail runId=${runId} reason=${r?.reason ?? "unknown"}`); } catch { /* audit failure must not escape dispatch */ }
			}
		} catch (e) {
			failed++;
			try { deps.audit?.(`supervision auto-register fail runId=${runId} reason=${e instanceof Error ? e.message : String(e)}`); } catch { /* audit failure must not escape dispatch */ }
		}
	}
	return { registered, failed };
}

// ── 显示（/autonomy status + /supervise status 共用）────────────────

/** 账本现状行（纯读；供命令渲染，不参与任何判据）。 */
export function supervisionLedgerLines(opts: { root?: string; stateDir?: string; tabRunsDir?: string } = {}): string[] {
	const entries = listOpenSupervisionEntries(opts);
	if (entries.length === 0) return ["supervision: (无监管条目——所有 tab 均为 NOT_MONITORED)"];
	const lines = [`supervision: ${entries.length} 条 active 账本`];
	for (const e of entries) {
		const th = thresholdsOf(e);
		const paused = e.status === "paused" ? ` ⏸ paused${e.pauseReason ? `(${e.pauseReason})` : ""} @${(e.pausedAt ?? e.setAt).slice(0, 19)}` : "";
		const optOut = e.optOut === true ? " ⏭ optout" : ""; // 纯展示；判据在 frontier.deriveTabSupervisionState
		lines.push(
			`  ${e.runId} task=${e.taskId} ${paused || "active"}${optOut} push=${Math.round(th.pushMs / 60_000)}m${e.repoPath ? ` repo=${basename(e.repoPath)}` : ""}` +
				unreportedMark(e.runId, opts.tabRunsDir),
		);
	}
	return lines;
}

/**
 * RF-1：`/supervise status` 行尾的「⚠未回报」标记（纯读，never-throw）。
 *
 * 判据与展示分离：是否 BLOCKED_USER 由 `frontier.deriveTabSupervisionState` 决定；
 * 这里只给**人看的**一行附加标记，因此**不参与任何判据**（不得被测试当作状态机的一部分）。
 * 读不到/读到真 tab-finish 结果 ⇒ 不标记（不猜、不误报）。
 */
function unreportedMark(runId: string, tabRunsDir?: string): string {
	try {
		const result = readTabResultFile(tabRunsDir ?? defaultTabRunsDir(), runId);
		return isUnconfirmedFallback(result) ? " ⚠未回报" : "";
	} catch {
		return ""; // 读不到就不标记（不猜，不污染行格式）
	}
}

// ── 命令体（/supervise）────────────────────────────────────────────

/**
 * `/supervise` 命令体（从 index.ts 抽出，以便机械测试；index.ts 只做 `pi.registerCommand` 薄壳）。
 *
 * 用法：`/supervise on|off|pause|resume|optout|status [runId]`
 *   - `on <runId>`     — 登记监管（active）；taskId/repoPath 从 tab-runs dispatch 取（并清除 optOut）
 *   - `off <runId>`    — 关账（open → closed）；不在 open 集则幂等提示
 *   - `pause <runId>`  — 用户显式暂停（PAUSED_USER：不报、不推）
 *   - `resume <runId>` — 恢复 active（并清除 optOut）
 *   - `optout <runId>` — 静默留档（`optOut: true` ⇒ 派生 NOT_MONITORED，entry 仍在 open/）
 *   - `status`         — 列出全部 open 账本
 *
 * **写操作在子 agent 会话被拒**（`isSubagent()`，与 `/autonomy` 手动运维命令同口径）。
 * P0 硬约束：本命令**不产生任何推动/注入/abort**——只改账本 + 回显。
 */
export interface SuperviseCommandCtx {
	ui: { notify: (msg: string, level?: "info" | "warning" | "error") => void };
}

export interface SuperviseCommandDeps {
	/** 子 agent 会话判定（index.ts 传 `isSubagent`）。 */
	isSubagent?: () => boolean;
	/** 写者身份（index.ts 传 `user:<sid 前12位>`）。 */
	setBy?: string;
	stateDir?: string;
	tabRunsDir?: string;
	now?: Date;
}

const SUPERVISE_USAGE = "用法：/supervise on|off|pause|resume|optout|status [runId]";

export function handleSuperviseCommand(args: string, ctx: SuperviseCommandCtx, deps: SuperviseCommandDeps = {}): void {
	const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
	const sub = parts[0] ?? "status";
	const runId = parts[1];
	const opts = { stateDir: deps.stateDir, now: deps.now, tabRunsDir: deps.tabRunsDir };
	const usage = (): void => ctx.ui.notify(SUPERVISE_USAGE, "warning");

	if (sub === "status") {
		ctx.ui.notify(supervisionLedgerLines({ stateDir: deps.stateDir, tabRunsDir: deps.tabRunsDir }).join("\n"), "info");
		return;
	}
	if (sub !== "on" && sub !== "off" && sub !== "pause" && sub !== "resume" && sub !== "optout") return usage();
	// 写操作：子 agent 会话拦截（手动运维面）
	if (deps.isSubagent?.()) {
		ctx.ui.notify("supervise: 子 agent 会话不可写监管账本（手动运维命令）", "warning");
		return;
	}
	if (!runId) return usage();
	if (sub === "off") {
		const r = closeSupervisionEntry(runId, deps.setBy ?? "user:cli", { ...opts, reason: "manual" });
		ctx.ui.notify(
			r.ok ? `supervise off ${runId} → closed` : `supervise off ${runId} 未生效（${r.reason}）`,
			r.ok ? "info" : "warning",
		);
		return;
	}
	if (sub === "optout") {
		const r = setSupervisionOptOut(runId, deps.setBy ?? "user:cli", opts);
		ctx.ui.notify(
			r.ok
				? `supervise optout ${runId} → 静默（NOT_MONITORED，账本仍留档）`
				: `supervise optout ${runId} 未生效（${r.reason}）`,
			r.ok ? "info" : "warning",
		);
		return;
	}
	const status: SupervisionStatus = sub === "pause" ? "paused" : "active";
	const r = setSupervisionStatus(
		{ runId, status, setBy: deps.setBy ?? "user:cli", reason: sub === "pause" ? "user-pause" : undefined },
		{ ...opts, fromDispatch: true },
	);
	ctx.ui.notify(
		r.ok
			? `supervise ${sub} ${runId} → ${status}${r.entry ? ` task=${r.entry.taskId}` : ""}`
			: `supervise ${sub} ${runId} 失败（${r.reason}）`,
		r.ok ? "info" : "warning",
	);
}
