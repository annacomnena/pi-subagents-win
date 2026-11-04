/**
 * runtime/journal.ts — Shadow Runtime Journal（Phase 1E，设计稿 §9）
 *
 * `~/.pi/agent/runtime/events.jsonl`：append-only、一行一个 JSON envelope。
 *
 * 原则（设计稿 §2/§9）：
 *   - Phase 1 只做 JSONL shadow projection：不做 index / sqlite / compaction / snapshot。
 *   - **journal 写失败 ≠ launch 失败**：所有接线点必须走 Safe wrapper（emitRuntimeEvent /
 *     appendRuntimeEnvelopeSafe），任何 IO 异常被吞成返回值，绝不向上抛（§9 best effort）。
 *   - tolerant read：磁盘坏行（半截 JSON / 不合 schema）跳过并计数，绝不改写文件。
 *   - legacy 文件（tab-runs/*.json 等）仍是 source of truth；本 journal 只观察。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, openSync, closeSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { validateEnvelope, type RuntimeEnvelope } from "./envelope.ts";

// ── 路径 ───────────────────────────────────────────────────────────

export function defaultRuntimeDir(): string {
	// env override：测试隔离用（同 PI_TAB_RUNS_DIR 模式）；不发则用真实用户目录
	const override = process.env.PI_RUNTIME_DIR;
	if (override && override.trim()) return override.trim();
	return join(homedir(), ".pi", "agent", "runtime");
}

export function defaultJournalPath(): string {
	return join(defaultRuntimeDir(), "events.jsonl");
}

/** 语义去重 claim 目录：`<dedupeKey sanitized>` 排他创建，跨实例/跨 rollover 幂等（terra 裁决缺陷 1/4）。 */
function defaultClaimsDir(): string {
	return join(defaultRuntimeDir(), "claims");
}

/**
 * 原子领取一个 dedupeKey 的「已写入 journal」权：第一个 open('wx') 成功者获得写权，
 * 其余实例/后续重放看到标记直接跳过。与 legacy .notified 唤醒幂等完全解耦——
 * journal 的完备性不依赖 recipient 路由，rollover 后新 master session 仍能补写终态。
 *
 * dedupeKey 含 scheme 字符（`run.completed:run://tab/x`）⇒ 文件名用 sha256 定长映射（见 claimFileName）。
 */
/**
 * claim 标记文件名（定长 sha256）。
 *
 * 【为何不用 sanitize（L4 M2，2026-11-05）】旧版 `key.replace(/[^A-Za-z0-9._-]/g,"_")` 有两个可达缺陷：
 * ① 碰撞：`keyA/v1` 与 `keyA_v1` 映射到同一个文件名 ⇒ 后者的 journal 行被当成「已写过」而**静默吞掉**
 *   （旧注释「受控格式下无碰撞面」只对 tab runId 成立，对 commandKey 不成立——它是自由文本）。
 * ② 超长：文件名 256 字符时 open(wx) 报 ENOENT ⇒ claim 永远 false ⇒ 静默丢行（commandKey ≥ 232 字符即触发）。
 * 定长 sha256（与 command-executor.ts:897 `commandArtifactName` 同一范式）同时消灭两个缺陷。
 */
function claimFileName(dedupeKey: string): string {
	return createHash("sha256").update(dedupeKey, "utf8").digest("hex") + ".claimed";
}

/** claim 结果三态（L4 M1）：必须把「已写过」与「claim 机制坏了」区分开。 */
export type ClaimOutcome =
	| { state: "claimed" }
	| { state: "duplicate" }
	| { state: "unavailable"; error: string };

/**
 * 原子领取一个 dedupeKey 的「已写入 journal」权：第一个 open('wx') 成功者获得写权，
 * 其余实例/后续重放看到标记直接跳过。与 legacy .notified 唤醒幂等完全解耦——
 * journal 的完备性不依赖 recipient 路由，rollover 后新 master session 仍能补写终态。
 */
export function claimRuntimeEmissionDetailed(dedupeKey: string, claimsDir: string = defaultClaimsDir()): ClaimOutcome {
	if (!dedupeKey || /\s/.test(dedupeKey)) return { state: "unavailable", error: "empty-or-whitespace-key" };
	try {
		mkdirSync(claimsDir, { recursive: true });
	} catch (e) {
		// 目录建不出来（同名文件占位 / 权限 / 磁盘满）⇒ 机制坏，不是「已写过」
		return { state: "unavailable", error: `claims-dir-unusable: ${e instanceof Error ? e.message : String(e)}` };
	}
	try {
		const fd = openSync(join(claimsDir, claimFileName(dedupeKey)), "wx");
		try { closeSync(fd); } catch { /* ignore */ }
		return { state: "claimed" };
	} catch (e) {
		// EEXIST = 已有赢家（正常幂等路径）；其余（ENOENT/权限/磁盘）都是机制坏
		const code = (e as NodeJS.ErrnoException)?.code;
		if (code === "EEXIST") return { state: "duplicate" };
		return { state: "unavailable", error: `claim-open-failed(${code ?? "?"}): ${e instanceof Error ? e.message : String(e)}` };
	}
}

/** 向后兼容的布尔入口（既有测试与调用方用它）。语义：claimed=true，其余 false。 */
export function claimRuntimeEmission(dedupeKey: string, claimsDir: string = defaultClaimsDir()): boolean {
	return claimRuntimeEmissionDetailed(dedupeKey, claimsDir).state === "claimed";
}

// ── 写 ─────────────────────────────────────────────────────────────

/** 追加一个 envelope（一行 JSON + 换行）。目录不存在自动创建；IO 失败会抛（直接用请自担）。 */
export function appendRuntimeEnvelope(envelope: RuntimeEnvelope, path: string = defaultJournalPath()): void {
	const errs = validateEnvelope(envelope);
	if (errs.length > 0) throw new Error(`appendRuntimeEnvelope: invalid envelope — ${errs.join("; ")}`);
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${JSON.stringify(envelope)}\n`, "utf8");
}

export interface SafeAppendResult {
	ok: boolean;
	/** 失败原因（诊断用；不进日志服务——shadow journal 自己就是日志）。 */
	error?: string;
}

/**
 * journal 不可用状态文件（R-2：降级不得静默）。
 *
 * 【为何需要】`claimRuntimeEmissionDetailed` 的 `unavailable`（claims 目录建不出 / 权限 /
 * 磁盘满 / 文件名非法）会让 8 个写点**全部**停写，而它们都忽略返回值 ⇒
 * 「机制坏掉但没人知道」——比原来「重复写 199 次」更难发现（重复至少看得见）。
 *
 * 【为何不用 journal 自己记】自己坏了写不了 —— 必须用独立于 journal 的通道。
 *
 * 形状：`<runtimeDir>/state/journal-unavailable.json`，**只写不删**（供运维观察；
 * 无 GC 是故意的——这个文件的成长本身就是一个信号）。
 */
const JOURNAL_UNAVAILABLE_REL = join("state", "journal-unavailable.json");

/** 进程内计数器（避免每一条失败都写盘；仅首次 + 每 N 次或错误变化时落盘）。 */
const journalUnavailable = { count: 0, firstAt: "" as string, lastAt: "" as string, lastError: "" as string, persisted: 0 };

/** 可观测的状态快照（含 "degraded" 判定；供 `/autonomy status` 一类的诊断面消费）。 */
export function journalUnavailableSnapshot(): {
	count: number;
	firstAt: string | null;
	lastAt: string | null;
	lastError: string | null;
	degraded: boolean;
} {
	return {
		count: journalUnavailable.count,
		firstAt: journalUnavailable.firstAt || null,
		lastAt: journalUnavailable.lastAt || null,
		lastError: journalUnavailable.lastError || null,
		degraded: journalUnavailable.count > 0,
	};
}

/** 测试用：重置进程内计数器（不影响盘上状态文件）。 */
export function _resetJournalUnavailableForTests(): void {
	journalUnavailable.count = 0;
	journalUnavailable.firstAt = "";
	journalUnavailable.lastAt = "";
	journalUnavailable.lastError = "";
	journalUnavailable.persisted = 0;
}

/**
 * 留下一次**可见信号**（R-2）。
 *
 * 频率限制：首次必写；之后每 100 次或错误内容变化时再写（避免一条坏磁盘把日志写爆）。
 * never-throw：连状态文件都写不了时只能放弃（但 stderr 至少会有一行）。
 */
function signalJournalUnavailable(error: string, path: string): void {
	const at = new Date().toISOString();
	journalUnavailable.count += 1;
	if (!journalUnavailable.firstAt) journalUnavailable.firstAt = at;
	journalUnavailable.lastAt = at;
	const errorChanged = journalUnavailable.lastError !== error;
	journalUnavailable.lastError = error;
	const shouldPersist = journalUnavailable.count === 1 || errorChanged || journalUnavailable.count - journalUnavailable.persisted >= 100;
	// ⚠ stderr **每次**都写（最弱但最快可见；daemon 日志可直接 grep `journal-unavailable`）
	try {
		process.stderr.write(`[journal-unavailable] ${at} count=${journalUnavailable.count} path=${path} error=${error}\n`);
	} catch { /* stderr 都不可用就只能算了 */ }
	if (!shouldPersist) return;
	journalUnavailable.persisted = journalUnavailable.count;
	try {
		const statePath = join(defaultRuntimeDir(), JOURNAL_UNAVAILABLE_REL);
		mkdirSync(dirname(statePath), { recursive: true });
		writeFileSync(
			statePath,
			JSON.stringify(
				{
					count: journalUnavailable.count,
					firstAt: journalUnavailable.firstAt,
					lastAt: journalUnavailable.lastAt,
					lastError: error,
					lastJournalPath: path,
					pid: process.pid,
				},
				null,
				2,
			) + "\n",
			"utf8",
		);
	} catch { /* 状态文件也写不了：stderr 那行是最后的信号 */ }
}

/** Safe wrapper：吞掉一切异常（含 envelope 非法），失败只体现在返回值。接线点一律走这里。 */
export function appendRuntimeEnvelopeSafe(envelope: RuntimeEnvelope, path: string = defaultJournalPath()): SafeAppendResult {
	try {
		appendRuntimeEnvelope(envelope, path);
		return { ok: true };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}

/**
 * 幂等 Safe wrapper（2026-11-05，plans/20261104_delivery_defects_L2_item1.md；L4 返修后）。
 * 带 dedupeKey ⇒ 先跨进程 claim 再写（同一 key 只落盘一次）；无 key ⇒ 退化为普通 safe 写。
 *
 * 为何新增本函数而不是改 `appendRuntimeEnvelopeSafe`（首版尝试的错误）：
 * `emitRuntimeEventOnce` 已在内部先 claim 再调 `emitRuntimeEvent` ⇒ 后者再调 safe ⇒
 * 若 safe 也 claim，**同一 key 会被 claim 两次**，第二次必然失败 ⇒ 真正那一行再也写不进去
 * （实测：原「emitRuntimeEventOnce 同键双调用只落盘一次」用例直接红成 0 条）。
 *
 * 【claim 三态（L4 M1 必修）】旧版把 `claimRuntimeEmission` 的**全部** false 原因当成
 * 「同 key 已写过」⇒ claims 目录建不出来 / 文件名非法 / 权限 / 磁盘满 时，
 * 8 个写点全部静默停写且返回 ok:true（AGENTS R-2 的教科书形状）。现改为：
 *   · claimed      ⇒ 写盘，ok:true
 *   · duplicate    ⇒ 不写盘，ok:true（幂等成功）
 *   · unavailable  ⇒ 不写盘，**ok:false + error**（可诊断；不能再慌报成功）
 *
 * 【at-most-once 取舍（L4 M3，必须显式登记）】本入口把 8 个写点从**可能重发**变为
 * **可能漏发**（claim 一旦成功、后续 append 失败就永远不再补）。这与 AGENTS R-5
 * 「宁可重发，不可漏发」方向相反，所以这里显式记下理由：
 *   · journal 是 **shadow / 派生审计面**，不是交付真相；交付真相在 outbox 盘面与会话转写；
 *   · 重复行已实测造成 10 分钟空转与 4.6MB 日志（`message.received` 单键 62 次），
 *     而漏行可由消费面（list / 面板 / 通知）补齐；
 *   · **如果将来发现 journal 行被当作交付判据使用，本取舍必须重审**。
 * 且 `unavailable` 现在返回 ok:false，调用方若需要区分「漏行」可以自行记一行 trace
 * （当前 8 个调用方均忽略返回值，属已知且已登记的状态）。
 */
export function appendRuntimeEnvelopeOnceSafe(envelope: RuntimeEnvelope, path: string = defaultJournalPath()): SafeAppendResult {
	try {
		const key = envelope.dedupeKey;
		// 无 key ⇒ 不参与幂等（旧行为不变）
		if (key) {
			const claim = claimRuntimeEmissionDetailed(key);
			if (claim.state === "duplicate") return { ok: true };
			if (claim.state === "unavailable") {
				// R-2（2026-11-05 必修）：claim 机制坏掉时 8 个写点会**全部**停写，
				// 而它们都忽略返回值 ⇒ 必须在这里留下独立于 journal 的可见信号
				// （stderr 每次 + <runtimeDir>/state/journal-unavailable.json 限频落盘）。
				signalJournalUnavailable(claim.error, path);
				return { ok: false, error: claim.error };
			}
		}
		appendRuntimeEnvelope(envelope, path);
		return { ok: true };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}

/** 接线点语义入口（设计稿 §11 emitRuntimeEvent 形状）：发一个已构造好的 envelope，成功与否都不影响调用方。 */
export function emitRuntimeEvent(envelope: RuntimeEnvelope, path: string = defaultJournalPath()): boolean {
	return appendRuntimeEnvelopeSafe(envelope, path).ok;
}

/**
 * 幂等语义入口：有 dedupeKey 时先跨进程排他领取再写入（同键重放/双触发只落盘一次）。
 * 无 dedupeKey 的 envelope 退化为普通 emit（不拦截）。
 * index.ts / event-bus.ts 的全部接线点一律走这里——写端不重复，读端（Phase 2 projector）
 * 仍按 dedupeKey 再防一道（防御纵深）。
 */
export function emitRuntimeEventOnce(envelope: RuntimeEnvelope, path: string = defaultJournalPath()): boolean {
	if (!envelope.dedupeKey) return emitRuntimeEvent(envelope, path);
	if (!claimRuntimeEmission(envelope.dedupeKey)) return false;
	return emitRuntimeEvent(envelope, path);
}

// ── 读（tolerant）─────────────────────────────────────────────────

export interface JournalReadResult<T = unknown> {
	envelopes: RuntimeEnvelope<T>[];
	/** 无法解析或不合 schema 而被跳过的行数（文件保持原样，绝不改写）。 */
	skippedBadLines: number;
}

export interface ListRuntimeEnvelopesOptions {
	path?: string;
	/** 只取某 type（如 "run.dispatched"）。 */
	type?: string;
	/** 取最近 N 条（journal 单调增长，读者通常只要尾部）。 */
	limit?: number;
}

export function listRuntimeEnvelopes<T = unknown>(opts: ListRuntimeEnvelopesOptions = {}): JournalReadResult<T> {
	const path = opts.path ?? defaultJournalPath();
	if (!existsSync(path)) return { envelopes: [], skippedBadLines: 0 };

	const text = readFileSync(path, "utf8");
	const envelopes: RuntimeEnvelope<T>[] = [];
	let skippedBadLines = 0;

	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			skippedBadLines += 1;
			continue;
		}
		if (validateEnvelope(parsed).length > 0) {
			skippedBadLines += 1;
			continue;
		}
		const env = parsed as RuntimeEnvelope<T>;
		if (opts.type !== undefined && env.type !== opts.type) continue;
		envelopes.push(env);
	}

	const limited =
		opts.limit !== undefined && envelopes.length > opts.limit ? envelopes.slice(-opts.limit) : envelopes;
	return { envelopes: limited, skippedBadLines };
}

/** 按 id 找单条；不存在返回 null（tolerant read 语义同 list）。 */
export function readRuntimeEnvelope<T = unknown>(
	id: string,
	opts: { path?: string } = {},
): RuntimeEnvelope<T> | null {
	const { envelopes } = listRuntimeEnvelopes<T>(opts);
	return envelopes.find((e) => e.id === id) ?? null;
}
