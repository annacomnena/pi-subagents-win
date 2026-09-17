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

import { appendFileSync, existsSync, mkdirSync, readFileSync, openSync, closeSync } from "node:fs";
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
 * dedupeKey 含 scheme 字符（`run.completed:run://tab/x`），claim 文件名做受限替换；
 * tab runId 为 base36 无 `/` `:`，受控格式下无碰撞面。
 */
export function claimRuntimeEmission(dedupeKey: string, claimsDir: string = defaultClaimsDir()): boolean {
	if (!dedupeKey || /\s/.test(dedupeKey)) return false;
	try {
		mkdirSync(claimsDir, { recursive: true });
	} catch {
		return false;
	}
	const fileName = `${dedupeKey.replace(/[^A-Za-z0-9._-]/g, "_")}.claimed`;
	try {
		const fd = openSync(join(claimsDir, fileName), "wx");
		try { closeSync(fd); } catch { /* ignore */ }
		return true;
	} catch {
		return false;
	}
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

/** Safe wrapper：吞掉一切异常（含 envelope 非法），失败只体现在返回值。接线点一律走这里。 */
export function appendRuntimeEnvelopeSafe(envelope: RuntimeEnvelope, path: string = defaultJournalPath()): SafeAppendResult {
	try {
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
