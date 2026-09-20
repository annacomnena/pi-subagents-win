/**
 * runtime/scope.ts — 二级 master v1（per-repo local master，0920 L2 计划）
 *
 * 二级写按仓库 scope 的键（agent://master_local_<scope>），不动全局 agent://master_default：
 *   - scope 键：git toplevel basename（无 git 回退 cwd basename，**不复用** title 用的
 *     repoName()——其 origin remote 优先级违反「toplevel basename」契约，L4 M1）
 *     + worktree 加 `-worktree` 后缀（launch-tabs 标题惯例）；basename 再经单段编码
 *     （L4 M2：可逆无歧义，覆盖空白 + registry sanitize 折叠字符），恒为合法单段：
 *     parseObjectAddress 可解析、attachment 文件名 sanitize 无碰撞；
 *   - 驱动器相对归一（L4 M3）：C:a → C:/a 在**所有 git 调用前**应用（normalizeDriveColon）；
 *   - 静默 genesis（F6 豁免仅限「无 owner 的 scope 级 genesis」，无 stale 分支）：
 *     session_start 时本 scope 无 owner → wx 原子单赢认领；已有 owner / 身份 unknown /
 *     attach 全部失败 → 静默 no-op，只写一条 journal 审计（复用 attachMasterWithAudit），
 *     永不抛（session_start 主流程纪律）。不调 triggerOwnershipRecheck（scope-only
 *     owner 对它 no-op 但语义污染，research §5.2 形态 C 纪律）；
 *   - 权力上限 v1：本仓 tab 唤醒（scope mailbox 的 wake/命令类信驱动，spawn cwd =
 *     scope 仓 toplevel）+ 本地 attention（state/local-master-attention/<scope>.json，
 *     与全局 master-attention.json 不共享 marker 文件）。**无** succession /
 *     transfer / auto / stale / 心跳——全局 S2/S3/transfer 模块恒写死全局地址，
 *     「零改动」即防线（research §5.3）；
 *   - REPORT 单投维持（选项 a，S7）：scope 消费端只吃 wake/命令类信，REPORT 形态
 *     直接 skip（不 claim、不 suppress 审计）；dedupeId / receipt key 不动，
 *     event-bus 归属锁不动；
 *   - cutover 门继承全局（Q4）：cutover off → scope 消费端空转。
 *
 * 认领时解析出的 toplevel 全路径落 attachment 的 detail 自由字段（主会话拍板：
 * 直接写完整路径），spawn 时读回作唤醒 tab 的 cwd（v1 同名跨盘/跨 worktree 碰撞
 * 为已知局限，不修）。
 *
 * 纯库：无 Pi API 依赖，全部 IO 走 PI_RUNTIME_DIR 可注入路径，可单测。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitToplevel, isWorktreePath, normalizeDriveColon } from "../launch.ts";
import type { ObjectAddress } from "./address.ts";
import { defaultRuntimeDir } from "./journal.ts";
import { ackClaimedBy, claimLetters, defaultMailboxDir, listLetters, mailboxDirFor, type Letter } from "./mailbox.ts";
import { attachMasterWithAudit } from "./adapters/session-lifecycle.ts";
import { readAttachment, readCutover, type MasterAttachment } from "./registry.ts";
import { isInFlight, readWakeState, wakeHolder, writeWakeState, type WakeLetter } from "./wake.ts";

// ── scope 键（S1 + L4 M1/M2/M3 返修，纯函数）──────────────────────────────────────────

/** 合法 basename 单段（与 registry attachment sanitize 的折叠域 `[^A-Za-z0-9._-]` 一致）。 */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
/** 编码保留前缀：编码后形式恒在 `e39` 命名空间内，与 passthrough 原样名不交。 */
const ENCODED_PREFIX = "e39";

/**
 * basename → 可逆、无歧义单段编码（L4 M2）：
 *   - 纯 `[A-Za-z0-9._-]` 且不在 `e39` 保留命名空间 → 原样（短、可读）；
 *   - 含空白/控制字符/其他折叠字符，或本身落在 `e39` 命名空间 → `e39` + hex(utf8)。
 * 编码后恒为 SAFE_SEGMENT 子集 → parseObjectAddress 可解析、registry sanitize 不动。
 * 注入性：passthrough 分支与编码分支像集不相交（原样名不得以 `e39` 开头），
 * hex 可逆 → 不同 basename 不撞键；不引入 `a b`/`a_b` 型未声明碰撞（一编码一原样，键不同）。
 */
export function encodeScopeSegment(name: string): string {
	if (SAFE_SEGMENT.test(name) && !name.startsWith(ENCODED_PREFIX)) return name;
	return `${ENCODED_PREFIX}${Buffer.from(name, "utf8").toString("hex")}`;
}

/** encodeScopeSegment 的逆（仅编码分支可逆；`-worktree` 后缀由调用方自处理）。 */
export function decodeScopeSegment(encoded: string): string {
	if (encoded.startsWith(ENCODED_PREFIX)) {
		const h = encoded.slice(ENCODED_PREFIX.length);
		if (h.length % 2 === 0 && /^[0-9a-f]+$/.test(h)) return Buffer.from(h, "hex").toString("utf8");
	}
	return encoded;
}

/**
 * 仓库 scope 键（纯函数，永不抛错）：
 *   归一后（L4 M3：git 调用前）的 git toplevel basename +（isWorktreePath 为真时）`-worktree` 后缀；
 *   无 git → cwd basename。结果恒为合法单段（无 `/`/空白/控制字符）→
 *   parseObjectAddress 可解析、attachment 文件名 sanitize 无路径碰撞。
 * **不复用 repoName()**（L4 M1：其 origin 优先级使不同目录/同 origin 错撞、同目录换 origin 变键）。
 */
export function localMasterScope(cwd: string): string {
	const norm = normalizeDriveColon(cwd);
	const top = (gitToplevel(norm) ?? norm).replace(/[\\/]+$/, "");
	const base = top.split(/[\\/]/).pop() || norm;
	return isWorktreePath(norm) ? `${encodeScopeSegment(base)}-worktree` : encodeScopeSegment(base);
}

/** 二级 master 逻辑地址：agent://master_local_<scope>（单段，无 `/`）。 */
export function localMasterAddress(scope: string): ObjectAddress {
	return `agent://master_local_${scope}`;
}

// ── 静默 genesis（S2）──────────────────────────────────────────────

export type ScopeGenesisOutcome =
	| { outcome: "attached"; scope: string; attachment: MasterAttachment }
	| { outcome: "skipped"; scope?: string; reason: "bad-session" | "no-cwd" | "owner-active" | "attach-failed" | "io-error" };

/**
 * 静默 genesis 认领。前置门（全部不过 = 静默 no-op，不重试不上报）：
 *   1. sessionId 非 "unknown"（M1 哨兵，registry 层双满足）；
 *   2. 本 scope 无 owner（有 owner 无论死活一律不动——v1 无 stale 分支）；
 *   3. cwd 可解析。
 * 成功：attachMaster（wx 原子单赢）+ toplevel 全路径落 detail 字段 + journal 审计。
 * 失败（bad-session / owner-active / lease 阻塞）：静默吞掉，仅一条 journal 审计
 *（attachMasterWithAudit）。本函数永不抛。
 */
export function silentScopeGenesis(sessionId: string, cwd?: string): ScopeGenesisOutcome {
	try {
		if (!sessionId || sessionId === "unknown") return { outcome: "skipped", reason: "bad-session" };
		let resolved = cwd && cwd.trim() ? cwd : "";
		if (!resolved) {
			try {
				resolved = process.cwd();
			} catch {
				return { outcome: "skipped", reason: "no-cwd" };
			}
		}
		const norm = normalizeDriveColon(resolved); // L4 M3：git 调用前归一
		const scope = localMasterScope(norm);
		const addr = localMasterAddress(scope);
		if (readAttachment(addr)) return { outcome: "skipped", scope, reason: "owner-active" };
		// 主会话拍板：toplevel 完整路径直接写 attachment detail 自由字段（无 git 回退 cwd 本身）
		const detail = gitToplevel(norm) ?? norm;
		const r = attachMasterWithAudit({ sessionId, agent: addr, detail });
		if (r.ok) return { outcome: "attached", scope, attachment: r.attachment };
		return {
			outcome: "skipped",
			scope,
			reason: r.reason === "owner-active" || r.reason === "bad-session" ? r.reason : "attach-failed",
		};
	} catch {
		return { outcome: "skipped", reason: "io-error" };
	}
}

// ── 帧类型谓词（S7：scope 消费端只吃 wake/命令类信）────────────────

/**
 * REPORT 形态判定与 mailbox-consumer / consumer-scan 的 receiptKeyFor 同规则：
 * message 帧 + subject run://tab/* + body.details.status。
 */
function isReportShape(letter: Letter): boolean {
	const f = letter.frame;
	if (f.frame !== "message") return false;
	const details = f.body.details as { status?: string } | undefined;
	return f.subject?.startsWith("run://tab/") === true && Boolean(details?.status);
}

/**
 * scope 唤醒谓词（S7 双保险）：
 *   - command 帧（agent.wake / task.cancel / workstream.pause）→ wake/命令类，处理；
 *   - REPORT 形态 message → skip（REPORT 单投 master_default，不 claim 不审计）；
 *   - 其余 message → 视为 wake 类（v1 scope 目录无其他 message 生产者，防御性放行）。
 */
export function isScopeWakeLetter(letter: Letter): boolean {
	if (letter.frame.frame === "command") return true;
	return !isReportShape(letter);
}

/** 信描述（与 wake.ts describeLetter 同规则）。 */
function describeLetter(letter: Letter): WakeLetter {
	if (letter.frame.frame === "message") {
		return { messageId: letter.frame.id, subject: letter.frame.subject, summary: letter.frame.body.summary, sentAt: letter.frame.sentAt };
	}
	return { messageId: `cmd:${letter.frame.commandKey}`, summary: `command ${letter.frame.type}`, sentAt: letter.frame.issuedAt };
}

/**
 * 本 scope 的 pending wake 类信（逐文件列出，S7：REPORT 形态只读即跳过、**不 claim**）。
 * 返回 fileId（= spool 文件名去 .json，F7 命名不变量：文件名恒等于 messageId，
 * message/command 皆然）供定向 claim。
 */
function listScopeWakeLetters(addr: ObjectAddress, mailboxDir: string): Array<{ fileId: string; letter: Letter }> {
	const dir = mailboxDirFor(addr, mailboxDir);
	if (!existsSync(dir)) return [];
	const out: Array<{ fileId: string; letter: Letter }> = [];
	for (const f of readdirSync(dir)) {
		if (!f.endsWith(".json")) continue;
		try {
			const letter = JSON.parse(readFileSync(join(dir, f), "utf8")) as Letter;
			if (letter.status !== "pending") continue;
			if (!isScopeWakeLetter(letter)) continue; // REPORT 形态：不是它的信，只读不 claim
			out.push({ fileId: f.slice(0, -".json".length), letter });
		} catch {
			continue;
		}
	}
	return out;
}

// ── scope 唤醒评估（S4，纯判定 + claim，不 spawn 不 ack）───────────

export interface ScopeWakeDecision {
	scope: string;
	fire: boolean;
	reason?: "cutover-off" | "no-owner" | "not-owner" | "no-mail" | "in-flight" | "claim-missed";
	letters: WakeLetter[];
	/** fire 时的 bounded prompt（调用方经 launch 纪律块包装后 spawn） */
	prompt?: string;
	/** 仓库 toplevel（读回 attachment.detail）；null → 调用方回退 process.cwd() */
	repoCwd: string | null;
}

export interface ScopeWakeOptions {
	sessionId: string | undefined;
	scope: string;
	mailboxDir?: string;
	stateDir?: string;
	runsDir?: string;
	/** fake clock（毫秒，测试用；缺省 Date.now()） */
	now?: number;
	inFlightWindowMs?: number;
}

/**
 * 单 scope 唤醒评估（与 workstream wake 同链的 scope 变体，无 ws policy）：
 *   cutover 门（Q4 继承全局）→ scope owner 门 → in-flight（wake-state 复用，
 *   <scope> 命名）→ scope mailbox 有 wake 类信（S7 谓词）→ claim 全 inbox → fire。
 * claim 是既有屏障：claimed 信不进下轮 pending，无重复唤醒；spawn 失败信留
 * claimed（stale 恢复），并落 per-scope attention。
 */
export function evaluateScopeWake(opts: ScopeWakeOptions): ScopeWakeDecision {
	const now = opts.now ?? Date.now();
	const addr = localMasterAddress(opts.scope);
	const repoCwdOf = (att: MasterAttachment | null): string | null =>
		att && typeof att.detail === "string" && att.detail.trim() ? att.detail.trim() : null;

	if (!readCutover()?.enabled) return { scope: opts.scope, fire: false, reason: "cutover-off", letters: [], repoCwd: null };
	const att = readAttachment(addr);
	if (!att) return { scope: opts.scope, fire: false, reason: "no-owner", letters: [], repoCwd: null };
	if (!opts.sessionId || opts.sessionId !== att.sessionId) {
		return { scope: opts.scope, fire: false, reason: "not-owner", letters: [], repoCwd: repoCwdOf(att) };
	}

	// in-flight：上次 spawn 的 tab 无终态且 dispatch 年轻 → 等（与 wake 层同规则）
	const state = readWakeState(opts.scope, opts.stateDir);
	if (state.lastTabRunId && isInFlight(state.lastTabRunId, { runsDir: opts.runsDir, now, inFlightWindowMs: opts.inFlightWindowMs })) {
		return { scope: opts.scope, fire: false, reason: "in-flight", letters: [], repoCwd: repoCwdOf(att) };
	}

	let wake: Array<{ fileId: string; letter: Letter }>;
	try {
		wake = listScopeWakeLetters(addr, opts.mailboxDir ?? defaultMailboxDir());
	} catch {
		return { scope: opts.scope, fire: false, reason: "no-mail", letters: [], repoCwd: repoCwdOf(att) };
	}
	if (!wake.length) return { scope: opts.scope, fire: false, reason: "no-mail", letters: [], repoCwd: repoCwdOf(att) };

	// 定向 claim 仅 wake 类信（REPORT 形态不进 claim，S7）
	const claimed = claimLetters(addr, {
		claimedBy: wakeHolder(opts.sessionId, opts.scope),
		mailboxDir: opts.mailboxDir,
		ids: wake.map((w) => w.fileId),
	});
	if (!claimed.length) return { scope: opts.scope, fire: false, reason: "claim-missed", letters: [], repoCwd: repoCwdOf(att) };

	const letters = claimed.map(describeLetter);
	const repoCwd = repoCwdOf(att);
	return { scope: opts.scope, fire: true, letters, prompt: buildScopeWakePrompt(opts.scope, letters, repoCwd), repoCwd };
}

// ── scope 唤醒确认 / 失败记账 ──────────────────────────────────────

/**
 * spawn 成功后确认：wake-state 以 <scope> 命名落盘（per-workstream 结构复用）+
 * 同 holder ack scope 信。与 confirmWakeSpawn 同形，仅地址换成 scope 地址。
 */
export function confirmScopeWakeSpawn(
	scope: string,
	tabRunId: string,
	opts: { stateDir?: string; mailboxDir?: string; sessionId: string; now?: number },
): void {
	const now = opts.now ?? Date.now();
	const stateDir = opts.stateDir ?? join(defaultRuntimeDir(), "state");
	const state = readWakeState(scope, stateDir);
	const windowStart = now - 24 * 60 * 60 * 1000;
	const iso = new Date(now).toISOString();
	writeWakeState(stateDir, {
		workstreamId: scope,
		lastSpawnAt: iso,
		lastTabRunId: tabRunId,
		spawnAt: [...state.spawnAt.filter((t) => Date.parse(t) >= windowStart), iso],
		updatedAt: iso,
	});
	const addr = localMasterAddress(scope);
	ackClaimedBy(addr, wakeHolder(opts.sessionId, scope), opts.mailboxDir ?? defaultMailboxDir());
}

/** spawn 失败记账（per-scope attention；信留 claimed，stale 恢复；不占 cooldown）。 */
export function auditScopeWakeSpawnFailed(scope: string, error: string, stateDir?: string): ScopeAttentionItem {
	return appendScopeAttentionItem(
		{ scope, kind: "wake-spawn-failed", error: error.slice(0, 200) },
		stateDir,
	);
}

// ── Bounded prompt（调用方经 launch 纪律块包装）────────────────────

export function buildScopeWakePrompt(scope: string, letters: WakeLetter[], repoCwd: string | null): string {
	const lines = [
		`你是仓库 ${scope} 的本地 Sub-Master（local master v1 唤醒，有终态的一次执行）。`,
		repoCwd ? `工作目录：${repoCwd}（本仓）` : null,
		`待处理输入（${letters.length}）：`,
		...letters.slice(0, 10).map((l) => `- [${l.subject ?? "no-subject"}] ${l.summary.slice(0, 200)}`),
		`规则：单次有界执行，做完即 tab-finish（天然 sleep）；禁止设 timer 自续命，再入只能经本地 wake 层；`,
		`无 actionable 输入时立即 tab-finish 报 no-op，不许挂等；`,
		`你不是全局 Master：不得调用 master-attach/master-transfer/master-cutover，不处理 run 完成回收（run 归派发者）。`,
	].filter((l): l is string => l !== null);
	return lines.join("\n");
}

// ── 本地 attention（S3：per-scope 文件，独立于全局 master-attention.json）

export interface ScopeAttentionItem {
	id: string;
	at: string;
	scope: string;
	/** 读本仓 wake 类信的相关事件：pending（owner 感知到待处理 wake 输入）/
	 *  spawn-failed（唤醒 spawn 失败）/ consume-error（消费异常） */
	kind: "wake-pending" | "wake-spawn-failed" | "wake-consume-error";
	letterId?: string;
	summary?: string;
	error?: string;
}

function scopeAttentionPath(scope: string, stateDir?: string): string {
	return join(stateDir ?? join(defaultRuntimeDir(), "state"), "local-master-attention", `${scope}.json`);
}

export function readScopeAttention(scope: string, stateDir?: string): ScopeAttentionItem[] {
	try {
		const raw = JSON.parse(readFileSync(scopeAttentionPath(scope, stateDir), "utf8")) as ScopeAttentionItem[];
		if (!Array.isArray(raw)) return [];
		return raw.filter((i) => i && typeof i.id === "string" && typeof i.scope === "string" && typeof i.kind === "string");
	} catch {
		return [];
	}
}

function newAttentionId(): string {
	return `attn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 追加一条 per-scope attention（原子写；best-effort，失败不打断主流程）。 */
export function appendScopeAttentionItem(item: { scope: string; kind: ScopeAttentionItem["kind"]; letterId?: string; summary?: string; error?: string }, stateDir?: string): ScopeAttentionItem {
	const full: ScopeAttentionItem = { id: newAttentionId(), at: new Date().toISOString(), ...item };
	try {
		const path = scopeAttentionPath(item.scope, stateDir);
		const items = readScopeAttention(item.scope, stateDir);
		items.push(full);
		const dir = path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")));
		if (dir) mkdirSync(dir, { recursive: true });
		const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(items, null, 2)}\n`, "utf8");
		renameSync(tmp, path);
	} catch {
		/* attention 是诊断性通道，best-effort */
	}
	return full;
}

/**
 * agent_end 的 scope 分支（与全局 S2/S3 分支严格分离，不共享 marker 文件）：
 * 本会话是本 scope owner → 读本仓 scope mailbox 的 pending wake 类信 →
 * 逐 letterId 去重后追加 wake-pending 条目。非 scope owner / 无信 → 零写。
 * 全部 best-effort，永不抛。
 */
export function noteScopeWakeInbox(
	sessionId: string,
	cwd: string,
	opts: { stateDir?: string; mailboxDir?: string } = {},
): ScopeAttentionItem[] {
	const added: ScopeAttentionItem[] = [];
	try {
		const scope = localMasterScope(cwd);
		const addr = localMasterAddress(scope);
		const att = readAttachment(addr);
		if (!att || att.sessionId !== sessionId) return added;
		let pending: Letter[];
		try {
			pending = listLetters(addr, "pending", opts.mailboxDir ?? defaultMailboxDir());
		} catch {
			return added;
		}
		const existing = readScopeAttention(scope, opts.stateDir);
		for (const letter of pending) {
			if (!isScopeWakeLetter(letter)) continue;
			const f = letter.frame;
			const letterId = f.frame === "message" ? f.id : `cmd:${f.commandKey}`;
			if (existing.some((i) => i.kind === "wake-pending" && i.letterId === letterId)) continue;
			if (added.some((i) => i.letterId === letterId)) continue;
			added.push(
				appendScopeAttentionItem(
					{
						scope,
						kind: "wake-pending",
						letterId,
						summary: (f.frame === "message" ? f.body.summary : `command ${f.type}`).slice(0, 200),
					},
					opts.stateDir,
				),
			);
		}
	} catch {
		/* best-effort */
	}
	return added;
}
