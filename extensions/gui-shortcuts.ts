/**
 * extensions/gui-shortcuts.ts — GUI 右栏「仓库专属快捷按钮」共享纯库（设计稿 plans/20261120_*.md v4）。
 *
 * TUI / GUI host / agent 三端共用；权威正文：<agentDir>/gui-shortcuts/<repo-key>.json。
 * 本文件**不碰 HTTP、不碰 Pi API、不 spawn 进程**，只做配置/提案/决策的读写与校验；
 * server.ts 只做鉴权 + body 解析 + 错误码映射（薄绑定）。执行器在 gui-shortcuts-runner.ts（P3）。
 *
 * 硬纪律（对齐 AGENTS.md §0/§1/§4）：
 *  1. **never-throw**：所有导出函数以判别联合返回，调用方不靠 try/catch 判失败。
 *  2. **并发正确性来自 per-repo wx 锁**，不来自 rename：tmp+rename 只保证不半写
 *     （与 session-note.ts 同款；实测 rename ≠ CAS）。
 *  3. **版本 = 语义内容 hash**，不是递增整数：agent 用 Write/Edit 直改文件时不会带
 *     expectedRevision；hash 基于规范化后的 {version,cwd,actions}，与 updatedAt / 字段顺序 /
 *     空白无关 —— agent 重排格式但语义不变 ⇒ hash 不变 ⇒ 不误触发刷新。
 *  4. **cwd 必须落白名单**：cwd 拼进路径前先做形状检查，哈希碰撞/非法串一律拒绝。
 *  5. **不宣称物理隔离**：agent 直写主配置是普通文件，服务端不产生审计；applied 只能推断。
 *
 * 目录布局（全部在 <agentDir>/gui-shortcuts/ 下，与 config.json 分离）：
 *   <repo-key>.json                 主配置（repo-key = sha256(norm cwd) 前 16 位）
 *   proposals/<proposalId>.json     agent 提案（agent 用 Write 落盘）
 *   decisions/<proposalId>.json     用户决策（服务端写，含完整 ops 快照）
 *   locks/<repo-key>.lock           per-repo 互斥锁（wx）
 *   audit.jsonl                     独立审计（经 API 的写；不污染 autonomy namespace）
 */
import { createHash } from "node:crypto";
import {
	appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readdirSync,
	renameSync, statSync, unlinkSync, writeFileSync, writeSync,
} from "node:fs";
import { dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { defaultAgentDir } from "./runtime/global-view.ts";

// ─────────────────────────────────────────────────────────────────────────────
// 常量与类型
// ─────────────────────────────────────────────────────────────────────────────

export const SHORTCUTS_SCHEMA_VERSION = 1;
/** 单仓库动作数上限（防配置膨胀）。 */
export const MAX_ACTIONS = 30;
/** 提案 / 决策文件的最大字节数。 */
export const MAX_PROPOSAL_BYTES = 64 * 1024;
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PROPOSAL_ID_RE = /^[a-f0-9]{32}$/;
/** PowerShell 注入元字符（args 逐项校验；虽走参数数组 shell:false，仍纵深防御）。 */
const PS_META_RE = /[;|&`$<>^(){}]|(?:\r?\n)/;

export type ShortcutKind = "url" | "file" | "script" | "process";

export interface ShortcutAction {
	id: string;
	label: string;
	kind: ShortcutKind;
	url?: string;
	path?: string;
	command?: string;
	args?: string[];
	timeoutMs?: number;
	matchCommandLine?: string;
	confirm: boolean;
}

export interface ShortcutsConfig {
	version: 1;
	cwd: string;
	updatedAt: string | null;
	actions: ShortcutAction[];
}

export type ProposalOp =
	| { op: "add"; action: ShortcutAction }
	| { op: "update"; targetId: string; action: ShortcutAction }
	| { op: "remove"; targetId: string };

export interface ShortcutProposal {
	version: 1;
	proposalId: string;
	cwd: string;
	baseHash: string;
	reason: string;
	sourceSession: string;
	createdAt: string;
	ops: ProposalOp[];
}

export type DecisionKind = "approved" | "declined";

export interface ShortcutDecision {
	version: 1;
	proposalId: string;
	cwd: string;
	decidedAt: string;
	decision: DecisionKind;
	baseHash: string;
	ops: ProposalOp[];
	injectedAt: string | null;
	appliedAt: string | null;
}

export type ProposalStatus = "pending" | "approved" | "applied" | "declined" | "expired";

export interface ProposalView {
	proposal: ShortcutProposal;
	status: ProposalStatus;
	decision: ShortcutDecision | null;
}

export interface ShortcutsDirs {
	/** 根：<agentDir>/gui-shortcuts（测试注入隔离目录）。 */
	root: string;
}

export function defaultShortcutsDirs(agentDir?: string): ShortcutsDirs {
	return { root: join(agentDir ?? defaultAgentDir(), "gui-shortcuts") };
}

function configPathFor(cwd: string, dirs: ShortcutsDirs): string {
	return join(dirs.root, `${repoKey(cwd)}.json`);
}
function proposalsDir(dirs: ShortcutsDirs): string { return join(dirs.root, "proposals"); }
function decisionsDir(dirs: ShortcutsDirs): string { return join(dirs.root, "decisions"); }
function locksDir(dirs: ShortcutsDirs): string { return join(dirs.root, "locks"); }
function proposalPathFor(id: string, dirs: ShortcutsDirs): string { return join(proposalsDir(dirs), `${id}.json`); }
function decisionPathFor(id: string, dirs: ShortcutsDirs): string { return join(decisionsDir(dirs), `${id}.json`); }
function lockPathFor(cwd: string, dirs: ShortcutsDirs): string { return join(locksDir(dirs), `${repoKey(cwd)}.lock`); }
function auditPath(dirs: ShortcutsDirs): string { return join(dirs.root, "audit.jsonl"); }

/** cwd → 稳定 repo-key（归一化：resolve + win32 小写）。非法 cwd 返回 null。 */
export function repoKey(cwd: string): string | null {
	if (typeof cwd !== "string" || cwd.trim() === "" || cwd.length > 4096) return null;
	// eslint-disable-next-line no-control-regex
	if (/[\x00-\x1f\x7f]/.test(cwd)) return null;
	try {
		const n = resolve(cwd);
		const norm = process.platform === "win32" ? n.toLowerCase() : n;
		return createHash("sha256").update(norm, "utf8").digest("hex").slice(0, 16);
	} catch {
		return null;
	}
}

function errCode(e: unknown): string {
	if (e !== null && typeof e === "object" && "code" in e) return String((e as { code: unknown }).code);
	return "";
}
function busyWait(ms: number, until: number): void { while (Date.now() < until) { /* 同步忙等 */ } }
const LOCK_WAIT_MS = 500;
const LOCK_POLL_MS = 25;
const LOCK_STALE_MS = 15_000;

interface LockGuard { release(): void }

/** per-repo 互斥锁：openSync "wx" 原子性保证唯一赢家；stale 清理也走 wx（与 session-note 同款）。 */
function acquireLock(lockPath: string): LockGuard | null {
	const deadline = Date.now() + LOCK_WAIT_MS;
	const token = `${process.pid}-${Math.random().toString(36).slice(2, 12)}`;
	for (;;) {
		try {
			const fd = openSync(lockPath, "wx");
			try { writeSync(fd, token, "utf8"); } catch { /* 诊断信息 */ } finally { closeSync(fd); }
			return {
				release(): void {
					try { if (readFileSync(lockPath, "utf8") === token) unlinkSync(lockPath); } catch { /* 别人已释放 */ }
				},
			};
		} catch (e) {
			if (errCode(e) !== "EEXIST") return null;
			try {
				const st = statSync(lockPath);
				if (Date.now() - st.mtimeMs > LOCK_STALE_MS) { try { unlinkSync(lockPath); } catch { /* next */ } continue; }
			} catch { /* next */ }
			if (Date.now() >= deadline) return null;
			busyWait(LOCK_POLL_MS, Date.now() + LOCK_POLL_MS);
		}
	}
}

function renameWithRetry(src: string, dst: string): void {
	const deadline = Date.now() + 1000;
	for (;;) {
		try { renameSync(src, dst); return; } catch (e) {
			const code = errCode(e);
			if (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") throw e;
			if (Date.now() >= deadline) throw e;
			busyWait(20, Date.now() + 20);
		}
	}
}

function ensureDirs(dirs: ShortcutsDirs): boolean {
	try {
		for (const d of [dirs.root, proposalsDir(dirs), decisionsDir(dirs), locksDir(dirs)]) {
			mkdirSync(d, { recursive: true });
		}
		return true;
	} catch { return false; }
}

// ─────────────────────────────────────────────────────────────────────────────
// 校验与规范化
// ─────────────────────────────────────────────────────────────────────────────

function normalizedInside(target: string, root: string): boolean {
	try {
		const t = resolve(target);
		const r = resolve(root);
		const tn = process.platform === "win32" ? t.toLowerCase() : t;
		const rn = process.platform === "win32" ? r.toLowerCase() : r;
		return tn === rn || tn.startsWith(rn.endsWith(sep) ? rn : rn + sep);
	} catch { return false; }
}

/** 校验并规范化单个 action；非法返回 error 说明。规范化 = 固定字段顺序 + 去多余字段。 */
function normalizeAction(v: unknown, cwd: string): { ok: true; action: ShortcutAction } | { ok: false; error: string } {
	if (v === null || typeof v !== "object" || Array.isArray(v)) return { ok: false, error: "action 须为对象" };
	const a = v as Record<string, unknown>;
	if (typeof a.id !== "string" || !ID_RE.test(a.id)) return { ok: false, error: "id 须匹配 [a-z0-9][a-z0-9_-]{0,63}" };
	if (typeof a.label !== "string" || a.label.length < 1 || a.label.length > 40) return { ok: false, error: "label 须 1–40 字符" };
	const kind = a.kind;
	if (kind !== "url" && kind !== "file" && kind !== "script" && kind !== "process") {
		return { ok: false, error: "kind 须为 url|file|script|process" };
	}
	const base: ShortcutAction = { id: a.id, label: a.label, kind, confirm: a.confirm === true };
	if ((kind === "script" || kind === "process") && a.confirm !== true) {
		return { ok: false, error: "script/process 的 confirm 必须为 true" };
	}
	if (kind === "url") {
		if (typeof a.url !== "string") return { ok: false, error: "url 须为字符串" };
		let u: URL;
		try { u = new URL(a.url); } catch { return { ok: false, error: "url 格式非法" }; }
		if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, error: "url 仅允许 http/https" };
		base.url = u.href;
		return { ok: true, action: base };
	}
	if (kind === "file") {
		if (typeof a.path !== "string" || a.path.trim() === "") return { ok: false, error: "path 须为非空字符串" };
		const abs = isAbsolute(a.path) ? resolve(a.path) : resolve(cwd, a.path);
		if (!normalizedInside(abs, cwd)) return { ok: false, error: "path 解析后超出仓库目录" };
		base.path = a.path;
		return { ok: true, action: base };
	}
	if (kind === "script") {
		if (typeof a.command !== "string") return { ok: false, error: "command 须为字符串" };
		// 单个 .ps1 文件名：不含路径分隔符 / 空格 / shell 元字符
		if (!/^[^\\/:*?"<>|\s]+\.ps1$/i.test(a.command)) return { ok: false, error: "command 须为单个 .ps1 文件名（不含路径/空格/元字符）" };
		const abs = resolve(cwd, a.command);
		if (!normalizedInside(abs, cwd)) return { ok: false, error: "command 解析后超出仓库目录" };
		base.command = a.command;
		if (a.args !== undefined) {
			if (!Array.isArray(a.args) || a.args.length > 64) return { ok: false, error: "args 须为 ≤64 项的字符串数组" };
			const out: string[] = [];
			for (const x of a.args) {
				if (typeof x !== "string" || x.length > 512) return { ok: false, error: "args 每项须为 ≤512 字符的字符串" };
				if (PS_META_RE.test(x)) return { ok: false, error: `args 含 PowerShell 元字符：${x}` };
				out.push(x);
			}
			base.args = out;
		} else { base.args = []; }
		const t = a.timeoutMs;
		if (t !== undefined && (typeof t !== "number" || !Number.isSafeInteger(t) || t < 5000 || t > 600000)) {
			return { ok: false, error: "timeoutMs 须为 5000–600000 的整数" };
		}
		base.timeoutMs = t !== undefined ? (t as number) : 120000;
		return { ok: true, action: base };
	}
	// process
	if (typeof a.matchCommandLine !== "string") return { ok: false, error: "matchCommandLine 须为字符串" };
	const m = a.matchCommandLine;
	if (m.length < 4 || m.length > 200) return { ok: false, error: "matchCommandLine 须 4–200 字符" };
	if (/[*?]/.test(m)) return { ok: false, error: "matchCommandLine 不支持 * ? 通配符" };
	base.matchCommandLine = m;
	const t = a.timeoutMs;
	if (t !== undefined && (typeof t !== "number" || !Number.isSafeInteger(t) || t < 5000 || t > 600000)) {
		return { ok: false, error: "timeoutMs 须为 5000–600000 的整数" };
	}
	base.timeoutMs = t !== undefined ? (t as number) : 120000;
	return { ok: true, action: base };
}

/** 规范化整份配置（固定字段顺序）；重复 id 拒绝。 */
function normalizeConfig(v: unknown, expectedCwd: string): { ok: true; config: ShortcutsConfig } | { ok: false; error: string } {
	if (v === null || typeof v !== "object" || Array.isArray(v)) return { ok: false, error: "配置须为对象" };
	const o = v as Record<string, unknown>;
	if (o.version !== SHORTCUTS_SCHEMA_VERSION) return { ok: false, error: `version 须为 ${SHORTCUTS_SCHEMA_VERSION}` };
	if (typeof o.cwd !== "string" || o.cwd.trim() === "") return { ok: false, error: "cwd 须为非空字符串" };
	// cwd 必须归一化后一致（哈希碰撞/改名 ⇒ 拒绝）
	const normExpected = resolve(expectedCwd);
	const normActual = resolve(o.cwd);
	const key = (p: string): string => (process.platform === "win32" ? p.toLowerCase() : p);
	if (key(normExpected) !== key(normActual)) return { ok: false, error: "配置文件 cwd 与请求 cwd 不一致" };
	if (!Array.isArray(o.actions)) return { ok: false, error: "actions 须为数组" };
	if (o.actions.length > MAX_ACTIONS) return { ok: false, error: `actions 不得超过 ${MAX_ACTIONS} 项` };
	const actions: ShortcutAction[] = [];
	const seen = new Set<string>();
	for (const raw of o.actions) {
		const r = normalizeAction(raw, expectedCwd);
		if (!r.ok) return r;
		if (seen.has(r.action.id)) return { ok: false, error: `重复 action id：${r.action.id}` };
		seen.add(r.action.id);
		actions.push(r.action);
	}
	const updatedAt = typeof o.updatedAt === "string" && !Number.isNaN(Date.parse(o.updatedAt)) ? o.updatedAt : null;
	return { ok: true, config: { version: SHORTCUTS_SCHEMA_VERSION, cwd: o.cwd, updatedAt, actions } };
}

/** 语义内容 hash（不含 updatedAt；基于规范化对象）。 */
export function configHash(config: ShortcutsConfig): string {
	const payload = JSON.stringify({ version: config.version, cwd: config.cwd, actions: config.actions });
	return createHash("sha256").update(payload, "utf8").digest("hex");
}

function emptyConfig(cwd: string): ShortcutsConfig {
	return { version: SHORTCUTS_SCHEMA_VERSION, cwd, updatedAt: null, actions: [] };
}

// ─────────────────────────────────────────────────────────────────────────────
// 配置读 / 写
// ─────────────────────────────────────────────────────────────────────────────

export type ReadConfigResult =
	| { ok: true; config: ShortcutsConfig; contentHash: string; exists: boolean }
	| { ok: false; reason: "invalid-cwd" | "corrupt" | "read-failed"; detail?: string };

/** 锁内读（不做 cwd 白名单以外的检查）。 */
function readConfigUnsafe(cwd: string, dirs: ShortcutsDirs): ReadConfigResult {
	const path = configPathFor(cwd, dirs);
	let raw: string;
	try { raw = readFileSync(path, "utf8"); } catch (e) {
		if (errCode(e) === "ENOENT") {
			const c = emptyConfig(cwd);
			return { ok: true, config: c, contentHash: configHash(c), exists: false };
		}
		return { ok: false, reason: "read-failed", detail: String(e) };
	}
	let parsed: unknown;
	try { parsed = JSON.parse(raw); } catch (e) { return { ok: false, reason: "corrupt", detail: `bad-json: ${String(e)}` }; }
	const norm = normalizeConfig(parsed, cwd);
	if (!norm.ok) return { ok: false, reason: "corrupt", detail: norm.error };
	return { ok: true, config: norm.config, contentHash: configHash(norm.config), exists: true };
}

/** 读配置（文件不存在 = 空配置 exists=false；坏文件 = corrupt，绝不伪装成空）。 */
export function readShortcuts(cwd: string, dirs: ShortcutsDirs = defaultShortcutsDirs()): ReadConfigResult {
	if (repoKey(cwd) === null) return { ok: false, reason: "invalid-cwd" };
	return readConfigUnsafe(cwd, dirs);
}

export type WriteFailureReason =
	| "invalid-cwd" | "invalid-action" | "conflict" | "lock-busy"
	| "read-failed" | "corrupt" | "write-failed";

export interface WriteOk {
	ok: true;
	config: ShortcutsConfig;
	contentHash: string;
}
export interface WriteErr {
	ok: false;
	reason: WriteFailureReason;
	current?: ShortcutsConfig;
	currentHash?: string;
	detail?: string;
}
export type WriteConfigResult = WriteOk | WriteErr;

/**
 * 用一组完整 actions 覆写配置（锁内 CAS：expectedHash === 当前内容 hash）。
 * expectedHash 省略 = 不校验（仅 host-apply / 测试用）；用户写必须带。
 */
function writeActionsLocked(
	cwd: string,
	actions: ShortcutAction[],
	expectedHash: string | undefined,
	dirs: ShortcutsDirs,
): WriteConfigResult {
	const currentRes = readConfigUnsafe(cwd, dirs);
	if (!currentRes.ok) {
		return { ok: false, reason: currentRes.reason, detail: currentRes.detail };
	}
	if (expectedHash !== undefined && expectedHash !== currentRes.contentHash) {
		return { ok: false, reason: "conflict", current: currentRes.config, currentHash: currentRes.contentHash };
	}
	const next: ShortcutsConfig = {
		version: SHORTCUTS_SCHEMA_VERSION,
		cwd: currentRes.config.cwd,
		updatedAt: new Date().toISOString(),
		actions,
	};
	const path = configPathFor(cwd, dirs);
	let tmp: string | null = null;
	try {
		tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
		const fd = openSync(tmp, "wx");
		try { writeSync(fd, JSON.stringify(next), "utf8"); } catch (e) { try { closeSync(fd); } catch { /* ignore */ } throw e; }
		closeSync(fd);
		renameWithRetry(tmp, path);
		tmp = null;
		return { ok: true, config: next, contentHash: configHash(next) };
	} catch (e) {
		return { ok: false, reason: "write-failed", detail: String(e) };
	} finally {
		if (tmp !== null) { try { unlinkSync(tmp); } catch { /* 自己创建的才清 */ } }
	}
}

/** 新增/修改单个 action（锁内 read → 改 → CAS 写 → 审计）。 */
export function upsertAction(
	cwd: string,
	actionInput: unknown,
	expectedHash: string,
	dirs: ShortcutsDirs = defaultShortcutsDirs(),
	source: "user" | "host" = "user",
): WriteConfigResult {
	if (repoKey(cwd) === null) return { ok: false, reason: "invalid-cwd" };
	const norm = normalizeAction(actionInput, cwd);
	if (!norm.ok) return { ok: false, reason: "invalid-action", detail: norm.error };
	if (!ensureDirs(dirs)) return { ok: false, reason: "write-failed", detail: "mkdir" };
	const lock = acquireLock(lockPathFor(cwd, dirs));
	if (lock === null) return { ok: false, reason: "lock-busy" };
	try {
		const cur = readConfigUnsafe(cwd, dirs);
		if (!cur.ok) return { ok: false, reason: cur.reason, detail: cur.detail };
		const actions = cur.config.actions.slice();
		const idx = actions.findIndex((a) => a.id === norm.action.id);
		if (idx >= 0) actions[idx] = norm.action;
		else {
			if (actions.length >= MAX_ACTIONS) return { ok: false, reason: "invalid-action", detail: `actions 上限 ${MAX_ACTIONS}` };
			actions.push(norm.action);
		}
		const r = writeActionsLocked(cwd, actions, expectedHash, dirs);
		if (r.ok) audit(dirs, source, idx >= 0 ? "update" : "add", cwd, { id: norm.action.id });
		return r;
	} finally { lock.release(); }
}

/** 删除单个 action（锁内 CAS）。 */
export function deleteAction(
	cwd: string,
	id: string,
	expectedHash: string,
	dirs: ShortcutsDirs = defaultShortcutsDirs(),
): WriteConfigResult {
	if (repoKey(cwd) === null) return { ok: false, reason: "invalid-cwd" };
	if (!ID_RE.test(id)) return { ok: false, reason: "invalid-action", detail: "非法 id" };
	if (!ensureDirs(dirs)) return { ok: false, reason: "write-failed", detail: "mkdir" };
	const lock = acquireLock(lockPathFor(cwd, dirs));
	if (lock === null) return { ok: false, reason: "lock-busy" };
	try {
		const cur = readConfigUnsafe(cwd, dirs);
		if (!cur.ok) return { ok: false, reason: cur.reason, detail: cur.detail };
		const actions = cur.config.actions.filter((a) => a.id !== id);
		const r = writeActionsLocked(cwd, actions, expectedHash, dirs);
		if (r.ok) audit(dirs, "user", "delete", cwd, { id });
		return r;
	} finally { lock.release(); }
}

// ─────────────────────────────────────────────────────────────────────────────
// 提案 / 决策 / 状态机
// ─────────────────────────────────────────────────────────────────────────────

function normalizeProposal(v: unknown): ShortcutProposal | null {
	if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
	const p = v as Record<string, unknown>;
	if (p.version !== SHORTCUTS_SCHEMA_VERSION) return null;
	if (typeof p.proposalId !== "string" || !PROPOSAL_ID_RE.test(p.proposalId)) return null;
	if (typeof p.cwd !== "string" || repoKey(p.cwd) === null) return null;
	if (typeof p.baseHash !== "string" || typeof p.reason !== "string"
		|| typeof p.sourceSession !== "string" || typeof p.createdAt !== "string") return null;
	if (!Array.isArray(p.ops)) return null;
	const ops: ProposalOp[] = [];
	for (const raw of p.ops) {
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
		const o = raw as Record<string, unknown>;
		if (o.op === "add") {
			// 提案里的 action 用宽松 cwd 校验（cwd 未知时跳过 path 落点检查，decide 时再校验）
			const a = o.action as Record<string, unknown> | undefined;
			if (!a || typeof a.id !== "string" || !ID_RE.test(a.id)) return null;
			ops.push({ op: "add", action: a as unknown as ShortcutAction });
		} else if (o.op === "update") {
			if (typeof o.targetId !== "string" || !ID_RE.test(o.targetId) || !o.action) return null;
			ops.push({ op: "update", targetId: o.targetId, action: o.action as unknown as ShortcutAction });
		} else if (o.op === "remove") {
			if (typeof o.targetId !== "string" || !ID_RE.test(o.targetId)) return null;
			ops.push({ op: "remove", targetId: o.targetId });
		} else return null;
	}
	return {
		version: SHORTCUTS_SCHEMA_VERSION, proposalId: p.proposalId, cwd: p.cwd,
		baseHash: p.baseHash, reason: p.reason, sourceSession: p.sourceSession,
		createdAt: p.createdAt, ops,
	};
}

/** 读单个提案（agent 用 Write 落盘的原始 JSON）。 */
export function readProposal(proposalId: string, dirs: ShortcutsDirs = defaultShortcutsDirs()): ShortcutProposal | null {
	if (!PROPOSAL_ID_RE.test(proposalId)) return null;
	try {
		const raw = readFileSync(proposalPathFor(proposalId, dirs), "utf8");
		if (Buffer.byteLength(raw, "utf8") > MAX_PROPOSAL_BYTES) return null;
		return normalizeProposal(JSON.parse(raw));
	} catch { return null; }
}

/** 列某仓库的全部提案（按 createdAt 降序），附状态与决策。 */
export function listProposalViews(cwd: string, dirs: ShortcutsDirs = defaultShortcutsDirs()): ProposalView[] {
	if (repoKey(cwd) === null) return [];
	const key = (p: string): string => (process.platform === "win32" ? p.toLowerCase() : p);
	let files: string[];
	try { files = readdirSync(proposalsDir(dirs)); } catch { return []; }
	const out: ProposalView[] = [];
	for (const f of files) {
		if (!f.endsWith(".json")) continue;
		const id = f.slice(0, -5);
		const proposal = readProposal(id, dirs);
		if (proposal === null || key(proposal.cwd) !== key(cwd)) continue;
		const decision = readDecision(id, dirs);
		out.push({ proposal, decision, status: deriveStatus(proposal, decision) });
	}
	out.sort((a, b) => (a.proposal.createdAt < b.proposal.createdAt ? 1 : a.proposal.createdAt > b.proposal.createdAt ? -1 : 0));
	return out;
}

const PROPOSAL_EXPIRE_MS = 24 * 60 * 60 * 1000;

/** 状态推断（applied 宽松：hasAppliedOps 为真且决策 approved）。 */
function deriveStatus(proposal: ShortcutProposal, decision: ShortcutDecision | null): ProposalStatus {
	if (decision === null) {
		const age = Date.now() - Date.parse(proposal.createdAt);
		return Number.isFinite(age) && age > PROPOSAL_EXPIRE_MS ? "expired" : "pending";
	}
	if (decision.decision === "declined") return "declined";
	return decision.appliedAt !== null ? "applied" : "approved";
}

/** 读决策记录。 */
export function readDecision(proposalId: string, dirs: ShortcutsDirs = defaultShortcutsDirs()): ShortcutDecision | null {
	if (!PROPOSAL_ID_RE.test(proposalId)) return null;
	try {
		const d = JSON.parse(readFileSync(decisionPathFor(proposalId, dirs), "utf8")) as Record<string, unknown>;
		if (d.version !== SHORTCUTS_SCHEMA_VERSION || d.proposalId !== proposalId || typeof d.cwd !== "string") return null;
		if (d.decision !== "approved" && d.decision !== "declined") return null;
		if (!Array.isArray(d.ops)) return null;
		return d as unknown as ShortcutDecision;
	} catch { return null; }
}

export type DecideResult =
	| { ok: true; decision: ShortcutDecision }
	| { ok: false; reason: "invalid-proposal" | "stale" | "lock-busy" | "write-failed" | "invalid-cwd"; detail?: string; currentHash?: string };

/**
 * 点「同意/拒绝」：锁内原子重校验 proposal + baseHash → 写决策记录（完整 ops 快照）。
 * 幂等：决策记录已存在 ⇒ 返回首次结果（不重复回注）。
 */
export function decideProposal(
	cwd: string,
	proposalId: string,
	decision: DecisionKind,
	dirs: ShortcutsDirs = defaultShortcutsDirs(),
): DecideResult {
	if (repoKey(cwd) === null) return { ok: false, reason: "invalid-cwd" };
	if (!PROPOSAL_ID_RE.test(proposalId) || (decision !== "approved" && decision !== "declined")) {
		return { ok: false, reason: "invalid-proposal" };
	}
	if (!ensureDirs(dirs)) return { ok: false, reason: "write-failed" };
	const lock = acquireLock(lockPathFor(cwd, dirs));
	if (lock === null) return { ok: false, reason: "lock-busy" };
	try {
		const existing = readDecision(proposalId, dirs);
		if (existing !== null) return { ok: true, decision: existing }; // 幂等
		const proposal = readProposal(proposalId, dirs);
		if (proposal === null || keyEq(proposal.cwd, cwd) === false) return { ok: false, reason: "invalid-proposal" };
		const cur = readConfigUnsafe(cwd, dirs);
		if (!cur.ok) return { ok: false, reason: "write-failed", detail: cur.detail };
		if (proposal.baseHash !== cur.contentHash) return { ok: false, reason: "stale", currentHash: cur.contentHash };
		const rec: ShortcutDecision = {
			version: SHORTCUTS_SCHEMA_VERSION, proposalId, cwd: proposal.cwd,
			decidedAt: new Date().toISOString(), decision, baseHash: proposal.baseHash,
			ops: proposal.ops, injectedAt: null, appliedAt: null,
		};
		const path = decisionPathFor(proposalId, dirs);
		let tmp: string | null = null;
		try {
			tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
			const fd = openSync(tmp, "wx");
			try { writeSync(fd, JSON.stringify(rec), "utf8"); } catch (e) { try { closeSync(fd); } catch { /* ignore */ } throw e; }
			closeSync(fd);
			renameWithRetry(tmp, path);
			tmp = null;
			audit(dirs, "user", `decide:${decision}`, cwd, { proposalId });
			return { ok: true, decision: rec };
		} catch (e) {
			return { ok: false, reason: "write-failed", detail: String(e) };
		} finally {
			if (tmp !== null) { try { unlinkSync(tmp); } catch { /* ignore */ } }
		}
	} finally { lock.release(); }
}

function keyEq(a: string, b: string): boolean {
	const k = (p: string): string => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
	try { return k(a) === k(b); } catch { return false; }
}

/** 标记决策已把批准指令注入目标会话（best-effort，失败不影响主链路）。 */
export function markInjected(proposalId: string, dirs: ShortcutsDirs = defaultShortcutsDirs()): boolean {
	let lock: ReturnType<typeof acquireLock> = null;
	try {
		const first = readDecision(proposalId, dirs);
		if (first === null || first.injectedAt !== null) return false;
		// 与 applyDecisionOps 共用 per-repo 锁：此前无锁整文件写会覆盖并发写入的 appliedAt，
		// 导致决策文件失真 / 重复 host-apply 审计（L4 复审重要项）。
		lock = acquireLock(lockPathFor(first.cwd, dirs));
		if (lock === null) return false;
		const d = readDecision(proposalId, dirs);
		if (d === null || d.injectedAt !== null) return false;
		d.injectedAt = new Date().toISOString();
		const path = decisionPathFor(proposalId, dirs);
		const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
		try {
			const fd = openSync(tmp, "wx");
			try { writeSync(fd, JSON.stringify(d), "utf8"); } catch (e) { try { closeSync(fd); } catch { /* ignore */ } throw e; }
			closeSync(fd);
			renameWithRetry(tmp, path);
			return true;
		} catch {
			try { unlinkSync(tmp); } catch { /* ignore */ }
			return false;
		}
	} catch { return false; }
	finally { if (lock !== null) lock.release(); }
}

/** 把决策 ops 应用到当前配置（host 降级 或 agent 直写后的 applied 核对）。锁内 CAS。 */
export function applyDecisionOps(
	cwd: string,
	proposalId: string,
	dirs: ShortcutsDirs = defaultShortcutsDirs(),
): WriteConfigResult & { applied?: boolean } {
	if (repoKey(cwd) === null) return { ok: false, reason: "invalid-cwd" };
	if (!ensureDirs(dirs)) return { ok: false, reason: "write-failed" };
	const lock = acquireLock(lockPathFor(cwd, dirs));
	if (lock === null) return { ok: false, reason: "lock-busy" };
	try {
		// 锁内重读决策：此前锁外读 appliedAt 的过期快照让并发两次 apply 都进入应用分支（L4 复审）。
		const decision = readDecision(proposalId, dirs);
		if (decision === null || decision.decision !== "approved") return { ok: false, reason: "invalid-action", detail: "无已批准决策" };
		const cur = readConfigUnsafe(cwd, dirs);
		if (!cur.ok) return { ok: false, reason: cur.reason, detail: cur.detail };
		// applied 幂等：已应用过 ⇒ 直接返回当前配置
		if (decision.appliedAt !== null) return { ok: true, config: cur.config, contentHash: cur.contentHash, applied: false };
		const actions = cur.config.actions.slice();
		for (const op of decision.ops) {
			if (op.op === "add") {
				const norm = normalizeAction(op.action, cwd);
				if (!norm.ok) return { ok: false, reason: "invalid-action", detail: norm.error };
				if (!actions.some((a) => a.id === norm.action.id)) actions.push(norm.action);
			} else if (op.op === "update") {
				const norm = normalizeAction(op.action, cwd);
				if (!norm.ok) return { ok: false, reason: "invalid-action", detail: norm.error };
				const idx = actions.findIndex((a) => a.id === op.targetId);
				if (idx >= 0) actions[idx] = norm.action;
			} else {
				const idx = actions.findIndex((a) => a.id === op.targetId);
				if (idx >= 0) actions.splice(idx, 1);
			}
		}
		const r = writeActionsLocked(cwd, actions, undefined, dirs);
		if (r.ok) {
			decision.appliedAt = new Date().toISOString();
			try { writeFileSync(decisionPathFor(proposalId, dirs), JSON.stringify(decision), "utf8"); } catch { /* applied 标记失败不影响配置已写 */ }
			audit(dirs, "host", "host-apply", cwd, { proposalId });
		}
		return { ...r, applied: r.ok };
	} finally { lock.release(); }
}

/** 推断提案 ops 是否已体现在当前配置（agent 直写后的 applied 判据）。 */
export function proposalApplied(cwd: string, proposalId: string, dirs: ShortcutsDirs = defaultShortcutsDirs()): boolean {
	const decision = readDecision(proposalId, dirs);
	if (decision === null || decision.decision !== "approved") return false;
	if (decision.appliedAt !== null) return true;
	const cur = readConfigUnsafe(cwd, dirs);
	if (!cur.ok) return false;
	for (const op of decision.ops) {
		if (op.op === "add") {
			if (!actionReflects(cur.config.actions, op.action)) return false;
		} else if (op.op === "remove") {
			if (cur.config.actions.some((a) => a.id === op.targetId)) return false;
		} else {
			// update：目标存在，且关键字段已反映提案（宽松：kind/command/url/path/match 命中即可）
			if (!actionReflects(cur.config.actions, op.action, op.targetId)) return false;
		}
	}
	return true;
}

/** 提案 action 是否已体现在配置里：id 命中 + kind 一致 + 该 kind 的主字段相等（设计稿 §4.3 判据）。 */
function actionReflects(actions: ShortcutAction[], proposed: ShortcutAction, targetId?: string): boolean {
	// 服务端 apply 按 targetId 定位、但写入的是 id=proposed.id 的 action；agent 直写同理。
	// 因此 update 落地后 id 可能是 targetId（保持 id）或 proposed.id（改名）。双查兼容两种，
	// 否则正确直写会被漏判为 approved（L4 终审重要项）。add 无 targetId ⇒ 只查 proposed.id。
	const ids = [targetId, proposed.id].filter((x): x is string => typeof x === "string");
	if (ids.length === 0) return false;
	const found = actions.find((a) => ids.includes(a.id));
	if (found === undefined) return false;
	if (found.kind !== proposed.kind) return false;
	switch (proposed.kind) {
		case "url": return found.url === proposed.url;
		case "file": return found.path === proposed.path;
		case "script": return found.command === proposed.command
			&& JSON.stringify(found.args ?? []) === JSON.stringify(proposed.args ?? []);
		case "process": return found.matchCommandLine === proposed.matchCommandLine;
	}
	return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// 审计（独立文件，绝不污染 autonomy namespace）
// ─────────────────────────────────────────────────────────────────────────────

function audit(dirs: ShortcutsDirs, source: string, action: string, cwd: string, extra: Record<string, unknown>): void {
	try {
		mkdirSync(dirs.root, { recursive: true });
		appendFileSync(auditPath(dirs), JSON.stringify({
			at: new Date().toISOString(), source, action, cwd, ...extra,
		}) + "\n", "utf8");
	} catch { /* 审计失败不影响主操作（R-2：不能静默失效到主链，故记录在返回中不可见但操作已成功） */ }
}

/** 供测试/诊断：读审计尾部。 */
export function readAuditTail(dirs: ShortcutsDirs = defaultShortcutsDirs(), lines = 50): string[] {
	try {
		const all = readFileSync(auditPath(dirs), "utf8").split("\n").filter((s) => s.length > 0);
		return all.slice(-lines);
	} catch { return []; }
}
