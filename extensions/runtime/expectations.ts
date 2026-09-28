/**
 * runtime/expectations.ts — ⑧ 请求—回执期望账本（0928 P2 · v2-b 最小事实切片）
 *
 * 语义（plans/0928_p2_expected_reply_slice_plan.md §2/§3 裁定逐条落实）：
 *   - **声明**：请求方在投递成功点说「我在等什么回信」（deliverLetter 成功返回前，never-throw）；
 *   - **到达**：消费链 claim + F16 fencing 通过后的回信匹配点关闭等待（只做键/地址/类型匹配，
 *     **不读 body、不做内容猜测**）；
 *   - **超期**：只由显式 `now` + 未关闭期望派生（`overdue ⟺ open ∧ now > deadlineAt`），
 *     无定时器、无后台写者；超期**不关闭**期望（等迟到回信收敛）。
 *
 * 存储（SoT = 每请求一文件的账本，**非 journal**）：
 *   <stateDir>/expectations/open/<requestId>.json     ← 等待中（声明 / deadline 更新写这里）
 *   <stateDir>/expectations/closed/<requestId>.json   ← 终态（wx first-wins = 原子线性化点）
 *   <stateDir>/expectations/audit.jsonl               ← 本账本自有审计（mismatch/duplicate/late/cancel）
 *
 * - `stateDir` 缺省 `join(defaultRuntimeDir(), "state")`（同 liveness / scope-consume 惯例）；
 *   **投递侧从 `mailboxDir` 父目录推导同一根**（`expectationsDirForMailboxDir`），
 *   测试传自定义 `mailboxDir` 时账本随其隔离，生产默认恒等。
 * - **status 不存字段、由目录派生**（open/ = 等待中，closed/ = 终态）；同 id 两目录并存
 *   （update/close 竞态残留）时读取 **closed 优先**（终态收敛）。
 * - 与 mailbox 解耦：原信被 claim/ack/stale 回收都不改变期望状态，**回信到达才改变**；
 *   与 receipts 不互读（那是「是否已注入过」的跨通道去重收据），只复用其文件纪律。
 *
 * journal 只落 v2-b ⑧ 族三个 additive 事件（`project.expected_event_{set,arrived,timeout}`），
 * 统一走 `newEventEnvelope`（自由 type 字符串，projector 未知 type 跳过 → 前向兼容）；
 * claims/journal 路径由账本根推导（`<runtimeRoot>/claims` + `<runtimeRoot>/events.jsonl`），
 * 同 key 先 claim 再 append → **每 (id, rev) 至多一行**。
 *
 * 纪律（receipts.ts / scope-consume.ts 先例）：路径可注入、原子 tmp+rename、**全部 never-throw**、
 * 纯库无 Pi API。**autonomy 红线**：本库可被 autonomy 只读消费，journal 写者在消费轮次
 *（consumeMailboxOnce），绝不从 autonomy 侧调用写入口。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultRuntimeDir, appendRuntimeEnvelopeSafe, claimRuntimeEmission } from "./journal.ts";
import { newEventEnvelope, type RuntimeEnvelope } from "./envelope.ts";
import { isObjectAddress, type ObjectAddress } from "./address.ts";
import { normalizeExactPath } from "./recent-scopes.ts";
import { readAttachment } from "./registry.ts";
import { readWorkstream } from "./workstreams.ts";
import type { MessageFrame } from "./protocol.ts";

// ── 常量 ───────────────────────────────────────────────────────────

/** 默认超期线（未决 R2 拍板：30min > 90s 接单预算与 5min 小任务预算，容纳 wake 排队）。不加 config 键，测试可注入。 */
export const DEFAULT_EXPECT_DEADLINE_MS = 30 * 60_000;

/** 回信缺省预期类型（硬规则：wake recipe 回 kind=RESULT，wake.ts）。 */
export const DEFAULT_EXPECTED_REPLY_TYPE = "RESULT";

export const EXPECTED_EVENT_SET = "project.expected_event_set";
export const EXPECTED_EVENT_ARRIVED = "project.expected_event_arrived";
export const EXPECTED_EVENT_TIMEOUT = "project.expected_event_timeout";

// ── 记录形状（version 1）───────────────────────────────────────────

export type ProjectSource = "explicit" | "attachment" | "workspace-ref" | "unresolved";

export interface ExpectedReplyRecord {
	version: 1;
	/** = 请求 MessageId（msg_…）：请求/期望的稳定主键，跨重启不变（mailbox 命名不变量 F7）。 */
	requestId: string;
	/** 回信应到地址（谁在等）= 请求 frame.from。 */
	replyTo: ObjectAddress;
	/** 请求发往地址（**预期回信发送者**）= 请求 frame.to。 */
	target: ObjectAddress;
	/** 预期回信 kind（缺省 RESULT）。 */
	expectedType: string;
	/** 归一化 repoPath（recent-scopes normalizeExactPath 口径，与 frontier 键同体）；解析失败 = null。 */
	project: string | null;
	/** frontier / attention 聚合键：`project ?? "mailbox:${target}"`（⑩ ws_mail_backlog 的 mailbox:<recipient> 先例）。 */
	projectKey: string;
	/** 归因诚实标注（best-effort 解析不冒充权威）。 */
	projectSource: ProjectSource;
	declaredAt: string;
	deadlineAt: string;
	/** deadline 修订号（更新 +1；事件 dedupeKey 含 rev）。 */
	rev: number;
	/** 派发证据（审计用）。 */
	source: { dispatch: "deliverLetter" };
	// ── 终态字段（closed/ 才有；open/ 恒缺省）──
	closedBy?: "arrived" | "cancelled";
	closedAt?: string;
	/** 到达时记：late = 到达时刻已过 deadline（超期不是终态，迟到回信仍正常结案）。 */
	arrival?: { messageId: string; kind: string; from: string; late: boolean };
	cancel?: { by: string; reason: string };
}

export interface ExpectReplyOptions {
	/** 显式超期线（ISO）；缺省 declaredAt + DEFAULT_EXPECT_DEADLINE_MS。 */
	deadlineAt?: string;
	/** 预期回信 kind；缺省 RESULT。 */
	expectedType?: string;
	/** 显式归一化项目键；缺省 best-effort 解析。 */
	project?: string;
}

// ── 路径 ───────────────────────────────────────────────────────────

/** 账本根：`<stateDir>/expectations`（stateDir 缺省 = `<runtimeDir>/state`，同 liveness 模式）。 */
export function expectationsRootForStateDir(stateDir?: string): string {
	return join(stateDir ?? join(defaultRuntimeDir(), "state"), "expectations");
}

/**
 * 投递侧从 mailboxDir 推导同一根：`<mailboxDir 父>/state/expectations`。
 * 生产 defaultMailboxDir = `<runtimeDir>/mailbox` → 与 expectationsRootForStateDir() 恒等。
 */
export function expectationsDirForMailboxDir(mailboxDir: string): string {
	return join(dirname(mailboxDir), "state", "expectations");
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

function openPath(root: string, requestId: string): string {
	return join(openDir(root), `${safeFile(requestId)}.json`);
}

function closedPath(root: string, requestId: string): string {
	return join(closedDir(root), `${safeFile(requestId)}.json`);
}

/** 账本根是否存在 ⟺ 本进程可见的账本载体存在（frontier recordOnly 条件化的判据）。 */
export function expectationsDirExists(opts: { root?: string; stateDir?: string } = {}): boolean {
	try {
		return existsSync(opts.root ?? expectationsRootForStateDir(opts.stateDir));
	} catch {
		return false;
	}
}

/** journal/claims 由账本根推导（`<root>` = `<runtimeRoot>/state/expectations` → 上两级 = runtimeRoot）。 */
function journalPathsOf(root: string): { journalPath: string; claimsDir: string } {
	const runtimeRoot = dirname(dirname(root));
	return { journalPath: join(runtimeRoot, "events.jsonl"), claimsDir: join(runtimeRoot, "claims") };
}

// ── 内部 IO（原子 / tolerant）──────────────────────────────────────

function writeJsonAtomic(path: string, value: unknown): void {
	const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}

function validateRecord(v: unknown): v is ExpectedReplyRecord {
	if (typeof v !== "object" || v === null) return false;
	const r = v as Record<string, unknown>;
	return (
		r.version === 1 &&
		typeof r.requestId === "string" &&
		r.requestId.length > 0 &&
		isObjectAddress(String(r.replyTo)) &&
		isObjectAddress(String(r.target)) &&
		typeof r.expectedType === "string" &&
		typeof r.projectKey === "string" &&
		typeof r.declaredAt === "string" &&
		typeof r.deadlineAt === "string" &&
		Number.isFinite(Date.parse(String(r.deadlineAt))) &&
		typeof r.rev === "number"
	);
}

function readRecordFile(path: string): ExpectedReplyRecord | null {
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
		return validateRecord(raw) ? raw : null;
	} catch {
		return null;
	}
}

// ── 读（closed 优先）───────────────────────────────────────────────

/** 容忍读单条：**closed/ 优先**（终态收敛，update/close 竞态残留由读取侧吸收）；缺失/坏 → null。 */
export function readExpectation(requestId: string, opts: { root?: string; stateDir?: string } = {}): ExpectedReplyRecord | null {
	const root = opts.root ?? expectationsRootForStateDir(opts.stateDir);
	try {
		return readRecordFile(closedPath(root, requestId)) ?? readRecordFile(openPath(root, requestId));
	} catch {
		return null;
	}
}

/** 全部未关闭期望（open/ 且 closed/ 无同 id；坏文件跳过）。目录缺失 → []。 */
export function listOpenExpectations(opts: { root?: string; stateDir?: string } = {}): ExpectedReplyRecord[] {
	const root = opts.root ?? expectationsRootForStateDir(opts.stateDir);
	const dir = openDir(root);
	if (!existsSync(dir)) return [];
	const out: ExpectedReplyRecord[] = [];
	try {
		for (const f of readdirSync(dir)) {
			if (!f.endsWith(".json")) continue;
			const requestId = f.slice(0, -".json".length);
			if (existsSync(closedPath(root, requestId))) continue; // closed 优先：僵尸 open 不进等待集合
			const rec = readRecordFile(join(dir, f));
			if (rec) out.push(rec);
		}
	} catch {
		return out;
	}
	return out.sort((a, b) => a.requestId.localeCompare(b.requestId));
}

/** 超期派生（只由显式 now + 未关闭期望决定；超期不关闭期望）。 */
export function deriveOverdue(rec: ExpectedReplyRecord, now: number): boolean {
	const dl = Date.parse(rec.deadlineAt);
	return Number.isFinite(dl) && now > dl;
}

/** notice ack 键（wake 级「只报一次」）：`<requestId>:r<rev>`——deadline 更新（rev+1）= 新一轮。 */
export function noticeAckKey(requestId: string, rev: number): string {
	return `${requestId}:r${rev}`;
}

// ── 审计（本账本自有命名空间，never-throw）────────────────────────

function auditPath(root: string): string {
	return join(root, "audit.jsonl");
}

function appendAudit(root: string, line: string): void {
	try {
		mkdirSync(root, { recursive: true });
		writeFileSync(auditPath(root), `${line}\n`, { encoding: "utf8", flag: "a" });
	} catch {
		/* never-throw：审计不阻塞语义 */
	}
}

/** 容忍读审计行（缺失/不可读 → []）。 */
export function readExpectationAudit(opts: { root?: string; stateDir?: string } = {}): string[] {
	const root = opts.root ?? expectationsRootForStateDir(opts.stateDir);
	try {
		return readFileSync(auditPath(root), "utf8").split("\n").filter((l) => l.trim().length > 0);
	} catch {
		return [];
	}
}

// ── journal 事件（三型；claim-then-append 幂等）────────────────────

function emitOnce(env: RuntimeEnvelope, root: string): boolean {
	if (!env.dedupeKey) return false;
	const { journalPath, claimsDir } = journalPathsOf(root);
	try {
		if (!claimRuntimeEmission(env.dedupeKey, claimsDir)) return false;
	} catch {
		return false;
	}
	return appendRuntimeEnvelopeSafe(env, journalPath).ok;
}

function setEnvelope(rec: ExpectedReplyRecord, at: string, now: Date): RuntimeEnvelope {
	return newEventEnvelope(
		{
			type: EXPECTED_EVENT_SET,
			source: rec.replyTo,
			target: rec.target,
			subject: rec.target,
			correlationId: rec.requestId,
			at,
			dedupeKey: `expected_set:${rec.requestId}:r${rec.rev}`,
			payload: {
				requestId: rec.requestId,
				project: rec.project,
				projectSource: rec.projectSource,
				target: rec.target,
				replyTo: rec.replyTo,
				expectedType: rec.expectedType,
				deadlineAt: rec.deadlineAt,
				rev: rec.rev,
			},
		},
		now,
	);
}

// ── project 归因（best-effort，失败不阻塞声明）────────────────────

function isPathShaped(v: unknown): v is string {
	if (typeof v !== "string") return false;
	const s = v.trim();
	return s.length > 0 && (s.includes("/") || s.includes("\\")) && !s.includes("://");
}

function resolveProject(target: ObjectAddress, explicit: string | undefined, stateDir: string): { project: string | null; projectSource: ProjectSource } {
	if (typeof explicit === "string" && explicit.trim()) {
		return { project: normalizeExactPath(explicit.trim()), projectSource: "explicit" };
	}
	// agent://master_local_<scope>（及任何带仓库 toplevel detail 的 agent 地址）→ attachment 归因
	if (target.startsWith("agent://")) {
		try {
			const detail = readAttachment(target)?.detail;
			if (isPathShaped(detail)) return { project: normalizeExactPath(detail.trim()), projectSource: "attachment" };
		} catch {
			/* 归因失败照常声明 */
		}
	}
	// workstream://<id> → workspaceRef（弱载体：仅路径形可解释，否则 unresolved 不猜）
	if (target.startsWith("workstream://")) {
		try {
			const ws = readWorkstream(target.slice("workstream://".length), stateDir);
			if (isPathShaped(ws?.workspaceRef)) return { project: normalizeExactPath(ws!.workspaceRef!.trim()), projectSource: "workspace-ref" };
		} catch {
			/* 同上 */
		}
	}
	return { project: null, projectSource: "unresolved" };
}

// ── 声明（生产者 1：投递成功点）────────────────────────────────────

export interface DeclareExpectationInput {
	frame: MessageFrame;
	/** deliverLetter 的 opts.expectReply（undefined = 按谓词自动声明；false = 显式关）。 */
	expectReply?: false | ExpectReplyOptions;
	mailboxDir?: string;
	stateDir?: string;
	now?: Date;
}

/** 声明谓词（§2.4；deliver created===true 由调用点保证，本函数再做 first-wins 幂等）。 */
export function shouldDeclareExpectation(frame: MessageFrame, expectReply: false | ExpectReplyOptions | undefined): boolean {
	if (expectReply === false) return false;
	return frame.frame === "message" && frame.requiresAck === true && !frame.inReplyTo && frame.from !== frame.to;
}

/**
 * 声明一条期望并落 `open/` + journal `expected_event_set`（rev=0）。
 * **never-throw**：任何失败返回 null，绝不影响投递（调用方是唯一生产咽喉 deliverLetter）。
 */
export function declareExpectationSafe(input: DeclareExpectationInput): ExpectedReplyRecord | null {
	try {
		return declareExpectation(input);
	} catch {
		return null;
	}
}

function declareExpectation(input: DeclareExpectationInput): ExpectedReplyRecord | null {
	const frame = input.frame;
	if (!shouldDeclareExpectation(frame, input.expectReply)) return null;
	const root = input.stateDir
		? expectationsRootForStateDir(input.stateDir)
		: expectationsDirForMailboxDir(input.mailboxDir ?? join(defaultRuntimeDir(), "mailbox"));
	// first-wins：同 requestId 已有记录（open 或 closed）→ 幂等返回，无第二行、无第二事件
	const existing = readExpectation(frame.id, { root });
	if (existing) return existing;

	const opt = typeof input.expectReply === "object" && input.expectReply !== null ? input.expectReply : {};
	const now = input.now ?? new Date();
	const declaredAt = now.toISOString();
	const deadlineAt = opt.deadlineAt ?? new Date(now.getTime() + DEFAULT_EXPECT_DEADLINE_MS).toISOString();
	if (!Number.isFinite(Date.parse(deadlineAt))) return null; // 非法显式 deadline → 不生成虚假等待
	const attr = resolveProject(frame.to, opt.project, dirname(root));
	const record: ExpectedReplyRecord = {
		version: 1,
		requestId: frame.id,
		replyTo: frame.from,
		target: frame.to,
		expectedType: opt.expectedType ?? DEFAULT_EXPECTED_REPLY_TYPE,
		...attr,
		// projectKey 在 attr 之后计算（依赖 project）
		projectKey: attr.project ?? `mailbox:${frame.to}`,
		declaredAt,
		deadlineAt,
		rev: 0,
		source: { dispatch: "deliverLetter" },
	};
	mkdirSync(openDir(root), { recursive: true });
	writeJsonAtomic(openPath(root, record.requestId), record);
	emitOnce(setEnvelope(record, declaredAt, now), root);
	return record;
}

// ── 终态收敛（closed wx first-wins = 线性化点）────────────────────

/**
 * 关闭等待：**wx 创建 closed 文件 = 原子线性化点**（恰一个赢家；输家 EEXIST → 幂等放弃），
 * 成功后 best-effort 删 open 残留（读取侧 closed 优先兜底）。
 * 说明（相对计划 §2.1「rename 原子线性化」的实现取舍）：终态记录要携带 closedBy/arrival 等
 * **因赢家而异**的内容，纯 rename 无法先改内容再原子移动；wx 首写者 + closed 优先读取给出
 * 同样的「先到先得、单终态」语义，且输家检测是单次系统调用。
 */
function closeRecord(root: string, requestId: string, terminal: ExpectedReplyRecord): boolean {
	mkdirSync(closedDir(root), { recursive: true });
	try {
		writeFileSync(closedPath(root, requestId), `${JSON.stringify(terminal, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
	} catch {
		return false; // EEXIST = 已有终态（输家）；其余 IO 错误按输家处理（never-throw）
	}
	try {
		unlinkSync(openPath(root, requestId));
	} catch {
		/* 残留由 closed 优先读取收敛 */
	}
	return true;
}

// ── 到达（生产者 2：消费链回信匹配点）──────────────────────────────

export type ExpectationOutcome =
	| "arrived" // 四键全中 → 关闭
	| "duplicate-reply" // 终态后再到 → 幂等 no-op
	| "reply-mismatch" // inReplyTo 命中但 sender/type/to 任一不符 → 不关闭
	| "late-reply-cancelled" // 取消后到达 → 不重开
	| "no-expectation" // 无对应期望（含非回信帧）
	| "error"; // IO 异常（never-throw 边界）

export interface MatchExpectationInput {
	/** 消费链已 claim + fencing 通过的回信帧。 */
	frame: MessageFrame;
	mailboxDir?: string;
	stateDir?: string;
	now?: Date;
}

/**
 * 四键匹配关闭（r2/r3/r4/r5）：`inReplyTo===requestId ∧ from===target ∧ kind===expectedType ∧ to===replyTo`。
 * 只做键/地址/类型匹配，**不读 body**；任何不符 → 审计行、不关闭（期望保持 open 直到 deadline/cancel）。
 */
export function matchAndCloseExpectationSafe(input: MatchExpectationInput): ExpectationOutcome {
	try {
		return matchAndCloseExpectation(input);
	} catch {
		return "error";
	}
}

function matchAndCloseExpectation(input: MatchExpectationInput): ExpectationOutcome {
	const frame = input.frame;
	if (frame.frame !== "message" || !frame.inReplyTo) return "no-expectation";
	const root = input.stateDir
		? expectationsRootForStateDir(input.stateDir)
		: expectationsDirForMailboxDir(input.mailboxDir ?? join(defaultRuntimeDir(), "mailbox"));
	const rec = readExpectation(frame.inReplyTo, { root });
	if (!rec) return "no-expectation";

	if (rec.closedBy === "arrived") {
		appendAudit(root, `duplicate-reply id=${rec.requestId} reply=${frame.id}`);
		return "duplicate-reply";
	}
	if (rec.closedBy === "cancelled") {
		appendAudit(root, `late-reply-cancelled id=${rec.requestId} reply=${frame.id}`);
		return "late-reply-cancelled";
	}
	// open：四键匹配
	const matched = frame.from === rec.target && frame.kind === rec.expectedType && frame.to === rec.replyTo;
	if (!matched) {
		appendAudit(root, `reply-mismatch id=${rec.requestId} reply=${frame.id} from=${frame.from} kind=${frame.kind} to=${frame.to} want(from=${rec.target} kind=${rec.expectedType} to=${rec.replyTo})`);
		return "reply-mismatch";
	}
	const now = input.now ?? new Date();
	const late = deriveOverdue(rec, now.getTime());
	const terminal: ExpectedReplyRecord = {
		...rec,
		closedBy: "arrived",
		closedAt: now.toISOString(),
		arrival: { messageId: frame.id, kind: frame.kind, from: frame.from, late },
	};
	if (!closeRecord(root, rec.requestId, terminal)) {
		// 并发关闭竞态输家：按现状归类（诚实，不覆盖既有终态）
		const cur = readExpectation(rec.requestId, { root });
		return cur?.closedBy === "cancelled" ? "late-reply-cancelled" : "duplicate-reply";
	}
	emitOnce(
		newEventEnvelope(
			{
				type: EXPECTED_EVENT_ARRIVED,
				source: rec.replyTo,
				target: rec.target,
				subject: rec.target,
				correlationId: rec.requestId,
				at: now.toISOString(),
				dedupeKey: `expected_arrived:${rec.requestId}`,
				payload: {
					requestId: rec.requestId,
					replyMessageId: frame.id,
					from: frame.from,
					kind: frame.kind,
					late,
				},
			},
			now,
		),
		root,
	);
	return "arrived";
}

// ── 取消（r6）──────────────────────────────────────────────────────

export interface CancelResult {
	ok: boolean;
	reason?: "no-expectation" | "closed" | "error";
	record?: ExpectedReplyRecord;
}

/**
 * 显式取消等待：open → closed(closedBy=cancelled)，wx 线性化（与并发 arrive 竞态先到先得）。
 * 取消后超期派生立即停止（listOpenExpectations 不再含它）。
 * **v1 无 journal 取消事件**（v2-b ⑧ 族无此名；账本 + 审计承载，事件化留后续 additive 批次——
 * 诚实标注为 trail 缺口）。
 */
export function cancelExpectation(
	requestId: string,
	by: string,
	reason: string,
	opts: { root?: string; stateDir?: string; now?: Date } = {},
): CancelResult {
	try {
		const root = opts.root ?? expectationsRootForStateDir(opts.stateDir);
		const rec = readExpectation(requestId, { root });
		if (!rec) return { ok: false, reason: "no-expectation" };
		if (rec.closedBy) return { ok: false, reason: "closed" };
		const now = opts.now ?? new Date();
		const terminal: ExpectedReplyRecord = { ...rec, closedBy: "cancelled", closedAt: now.toISOString(), cancel: { by, reason } };
		if (!closeRecord(root, requestId, terminal)) return { ok: false, reason: "closed" }; // 输家（并发已终态）
		appendAudit(root, `cancel id=${requestId} by=${by} reason=${reason}`);
		return { ok: true, record: terminal };
	} catch {
		return { ok: false, reason: "error" };
	}
}

// ── deadline 更新（r7：rev+1，只在 open 内）───────────────────────

export interface UpdateDeadlineResult {
	ok: boolean;
	reason?: "no-expectation" | "closed" | "invalid-deadline" | "error";
	record?: ExpectedReplyRecord;
}

/**
 * 更新超期线：仅 open/ 内允许，`rev+1` + 重写 open + journal `expected_event_set`（dedupeKey 含 rev）。
 * 已终态一律拒绝（closed 不得重开）；与 close 竞态写回的僵尸 open 由写后复查收敛（主动清理）。
 */
export function updateDeadline(
	requestId: string,
	deadlineAt: string,
	opts: { root?: string; stateDir?: string; now?: Date } = {},
): UpdateDeadlineResult {
	try {
		if (!Number.isFinite(Date.parse(deadlineAt))) return { ok: false, reason: "invalid-deadline" };
		const root = opts.root ?? expectationsRootForStateDir(opts.stateDir);
		const cur = readExpectation(requestId, { root });
		if (!cur) return { ok: false, reason: "no-expectation" };
		if (cur.closedBy) return { ok: false, reason: "closed" };
		const now = opts.now ?? new Date();
		const next: ExpectedReplyRecord = { ...cur, deadlineAt, rev: cur.rev + 1 };
		if (readRecordFile(closedPath(root, requestId))) return { ok: false, reason: "closed" }; // 写前复查
		writeJsonAtomic(openPath(root, requestId), next);
		if (readRecordFile(closedPath(root, requestId))) {
			// 写后复查：close 恰在窗口内发生 → 清掉刚写的僵尸（终态收敛，不留双真相）
			try {
				unlinkSync(openPath(root, requestId));
			} catch {
				/* 已被并发清理 */
			}
			return { ok: false, reason: "closed" };
		}
		emitOnce(setEnvelope(next, now.toISOString(), now), root);
		return { ok: true, record: next };
	} catch {
		return { ok: false, reason: "error" };
	}
}

// ── 超期物化（timeout 事件；消费轮次调用，claim-then-append 幂等）────

export interface MaterializeResult {
	/** 本轮新写入的 timeout 行数。 */
	written: number;
	/** 本轮 open∧overdue 的期望数（含已写过的）。 */
	overdue: number;
}

/**
 * 对 open∧overdue 的期望尝试落 journal `project.expected_event_timeout`。
 * **每 (id, rev) 至多一行**（claimRuntimeEmission 幂等）；超期不关闭期望。
 * 由 `consumeMailboxOnce` 每轮调用（autonomy 红线禁写 journal → 记录面由消费侧写者承载）。
 */
export function materializeTimeoutNotices(opts: { root?: string; stateDir?: string; mailboxDir?: string; now?: Date } = {}): MaterializeResult {
	try {
		const root = opts.root
			?? (opts.stateDir ? expectationsRootForStateDir(opts.stateDir) : expectationsDirForMailboxDir(opts.mailboxDir ?? join(defaultRuntimeDir(), "mailbox")));
		const now = opts.now ?? new Date();
		let overdue = 0;
		let written = 0;
		for (const rec of listOpenExpectations({ root })) {
			if (!deriveOverdue(rec, now.getTime())) continue;
			overdue += 1;
			const env = newEventEnvelope(
				{
					type: EXPECTED_EVENT_TIMEOUT,
					source: rec.replyTo,
					target: rec.target,
					subject: rec.target,
					correlationId: rec.requestId,
					at: now.toISOString(),
					dedupeKey: `expected_timeout:${rec.requestId}:r${rec.rev}`,
					payload: { requestId: rec.requestId, project: rec.project, deadlineAt: rec.deadlineAt, rev: rec.rev },
				},
				now,
			);
			if (emitOnce(env, root)) written += 1;
		}
		return { written, overdue };
	} catch {
		return { written: 0, overdue: 0 };
	}
}
