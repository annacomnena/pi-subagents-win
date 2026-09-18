/**
 * master-auto.ts — S3 Opt-in Automatic Master Succession（A1，Phase 5.5 后续）。
 *
 * Master owner 会话在 agent turn 结束时，若 opt-in 开启且通过 8 项 Safety Gate，
 * 自动执行与 master-transfer 完全相同的一键交接事务（fresh handoff → token →
 * spawn 后继 → gen+1）；失败则旧主保留（transferMaster 自带）+ Attention item +
 * journal 事件 + 回退 S2 proposal（禁无限重试：同 generation 至多 1 次自动尝试）。
 *
 * 纪律：
 *   - 默认 `auto:false`；OFF 时零行为变化——checkAutoGate 第一关 auto-off 短路，
 *     后续零磁盘写（不写 marker/attention/transfer 记录）、零 journal 事件、零 notify、零 spawn。
 *   - ⑦（turn ended / agent idle）是结构性保证：maybeAutoSucceed 的唯一调用点
 *     是 session-hooks.ts 的 agent_end hook（turn 已结束才触发），不导出给任何
 *     tool/命令直接调用，故无独立检查项。
 *   - 失败路径禁无限重试：auto marker 在发起 transferMaster 前写入（先标后做，
 *     跨进程崩溃也保证同代至多 1 次）；marker 停留 "attempting" 时方向正确
 *     （宁可少一次自动，不多一次）。
 *
 * 纯逻辑模块：无 pi 依赖，stateDir/journalPath/spawn 全部可注入，可单测。
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { masterAddress } from "./address.ts";
import { newEventEnvelope } from "./envelope.ts";
import { defaultJournalPath, defaultRuntimeDir, emitRuntimeEventOnce } from "./journal.ts";
import { transferMaster, type SpawnSuccessor } from "./master-transfer.ts";
import { maybePropose } from "./master-succession.ts";
import type { PressureReading } from "./master-pressure.ts";
import { readAttachment, readCutover } from "./registry.ts";

// ── 配置（config.json 切片；缺失/非法 = 全默认 = 现状零差）────────────

export interface MasterSuccessionConfig {
	/** 必须严格 === true 才开启（truthy 字符串/1 一律 false） */
	auto: boolean;
	/** S2 提议线，百分比（hook 传给 maybePropose 时 /100） */
	proposalPercent: number;
	/** S3 自动交接线，百分比 */
	autoPercent: number;
}

export const DEFAULT_MASTER_SUCCESSION: MasterSuccessionConfig = { auto: false, proposalPercent: 75, autoPercent: 90 };

const clampPercent = (v: unknown, dflt: number): number =>
	typeof v === "number" && Number.isFinite(v) ? Math.min(100, Math.max(1, v)) : dflt;

export function normalizeMasterSuccession(raw: unknown): MasterSuccessionConfig {
	if (typeof raw !== "object" || raw === null) return { ...DEFAULT_MASTER_SUCCESSION };
	const o = raw as Record<string, unknown>;
	return {
		auto: o.auto === true,
		proposalPercent: clampPercent(o.proposalPercent, DEFAULT_MASTER_SUCCESSION.proposalPercent),
		autoPercent: clampPercent(o.autoPercent, DEFAULT_MASTER_SUCCESSION.autoPercent),
	};
}

// ── 阈值（token 绝对值判定，不 race Pi 自 compaction）────────────────

export const HANDOFF_SAFETY_TOKENS = 8192;
/** Pi 自 compaction 余量估算初始值（docs/compaction.md 未公布具体数值；标定后只改这一个常量）。
 *  min() 保证方向安全：估大 → 阈值更低 → 提前交接；绝不会晚于 Pi compaction 触发。 */
export const PI_COMPACTION_RESERVE_TOKENS = 16384;

export function effectiveAutoThresholdTokens(
	reading: { tokens: number | null; contextWindow: number | null },
	autoPercent: number,
): number | null {
	if (reading.tokens === null || reading.contextWindow === null) return null; // no decision，不猜
	const pct = Math.round((reading.contextWindow * autoPercent) / 100);
	const headroom = reading.contextWindow - PI_COMPACTION_RESERVE_TOKENS - HANDOFF_SAFETY_TOKENS;
	if (headroom <= 0) return null; // 窗口小到没有余量 → no decision
	return Math.min(pct, headroom);
}

// ── auto marker（同代至多 1 次自动尝试；先标后做，崩溃安全）─────────

export interface AutoMarker {
	version: 1;
	lastAttemptGeneration: number;
	lastAttemptAt: string;
	lastOutcome: "attempting" | "completed" | "failed";
	lastTransferId?: string;
}

function autoMarkerPath(stateDir?: string): string {
	return join(stateDir ?? join(defaultRuntimeDir(), "state"), "master-auto.json");
}

export function readAutoMarker(stateDir?: string): AutoMarker | null {
	try {
		const raw = JSON.parse(readFileSync(autoMarkerPath(stateDir), "utf8")) as AutoMarker;
		if (raw?.version !== 1 || typeof raw.lastAttemptGeneration !== "number") return null;
		return raw;
	} catch {
		return null;
	}
}

function writeAutoMarkerAtomic(marker: AutoMarker, stateDir?: string): void {
	const path = autoMarkerPath(stateDir);
	const dir = path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")));
	if (dir) mkdirSync(dir, { recursive: true });
	const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}

// ── in-flight 检测（⑤：initiated/spawned/attached 阻断新尝试）────────

export function hasInFlightTransfer(stateDir?: string): boolean {
	const dir = join(stateDir ?? join(defaultRuntimeDir(), "state"), "master-transfers");
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return false;
	}
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		try {
			const rec = JSON.parse(readFileSync(join(dir, name), "utf8")) as { status?: string };
			if (rec.status === "initiated" || rec.status === "spawned" || rec.status === "attached") return true;
		} catch { /* tolerant：坏记录不阻断（与 journal tolerant read 同纲） */ }
	}
	return false;
}

// ── Safety Gate（按「便宜→昂贵」短路；全部通过才 pass）────────────────
// ③ auto → ① owner → ② cutover → ④ usage → ⑤ in-flight → ⑥ 同代已尝试 → ⑧ spawn
// ⑦（turn ended）结构性保证，见头注；达 auto 线由 maybeAutoSucceed 单独判（below-threshold）。

export type AutoGateReason =
	| "auto-off" | "not-owner" | "cutover-off" | "no-usage"
	| "in-flight-transfer" | "already-attempted" | "no-spawn";

export type AutoGateResult = { pass: true } | { pass: false; reason: AutoGateReason };

export function checkAutoGate(input: {
	sessionId: string;
	generation: number;
	reading: PressureReading;
	cfg: MasterSuccessionConfig;
	spawn: SpawnSuccessor | null;
	stateDir?: string;
}): AutoGateResult {
	if (input.cfg.auto !== true) return { pass: false, reason: "auto-off" };
	const att = readAttachment(masterAddress());
	if (!att || att.sessionId !== input.sessionId || att.generation !== input.generation) {
		return { pass: false, reason: "not-owner" };
	}
	if (readCutover()?.enabled !== true) return { pass: false, reason: "cutover-off" };
	if (input.reading.tokens === null || input.reading.contextWindow === null || input.reading.percent === null) {
		return { pass: false, reason: "no-usage" };
	}
	if (hasInFlightTransfer(input.stateDir)) return { pass: false, reason: "in-flight-transfer" };
	const marker = readAutoMarker(input.stateDir);
	if (marker && marker.lastAttemptGeneration === input.generation) {
		return { pass: false, reason: "already-attempted" };
	}
	if (input.spawn === null) return { pass: false, reason: "no-spawn" };
	return { pass: true };
}

// ── Attention item（state/master-attention.json，追加数组，原子写）────

export interface AttentionItem {
	id: string;
	at: string;
	kind: "auto-handoff-failed";
	transferId: string;
	error: string;
	generation: number;
	pressure: number | null;
}

function attentionPath(stateDir?: string): string {
	return join(stateDir ?? join(defaultRuntimeDir(), "state"), "master-attention.json");
}

export function readAttentionItems(stateDir?: string): AttentionItem[] {
	try {
		const raw = JSON.parse(readFileSync(attentionPath(stateDir), "utf8")) as AttentionItem[];
		if (!Array.isArray(raw)) return [];
		return raw.filter((i) => i && typeof i.id === "string" && typeof i.transferId === "string");
	} catch {
		return [];
	}
}

function appendAttentionItem(item: AttentionItem, stateDir?: string): void {
	const path = attentionPath(stateDir);
	const items = readAttentionItems(stateDir);
	items.push(item);
	const dir = path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")));
	if (dir) mkdirSync(dir, { recursive: true });
	const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(items, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}

function newAttentionId(): string {
	return `attn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── 主入口 ─────────────────────────────────────────────────────────

export interface AutoSucceedOptions {
	stateDir?: string;
	journalPath?: string;
}

export type AutoSucceedResult =
	| { action: "none"; reason: AutoGateReason | "below-threshold" }
	| { action: "transferred"; transferId: string; successorRunId: string; generation: number }
	| { action: "failed"; transferId: string; error: string | undefined; generation: number; pressure: number | null };

/**
 * turn 结束自动交接入口（唯一调用点：session-hooks.ts agent_end，⑦ 结构性保证）。
 * 流程：gate 短路（不写任何状态）→ 阈值判定 → 先写 marker 后做 transferMaster →
 * 成功 marker=completed；失败 marker=failed + Attention item + auto_failed 事件 + 回退 S2 proposal。
 *
 * 失败承诺边界（review §2 裁决）：`transferMaster` 在其 spawn try/catch **之前**抛出的
 * 非 spawn I/O 异常（handoff 文档 / token / 记录 / journal 写）在 `maybeAutoSucceed` 内
 * 归一化为同一失败回退序列（旧主保留——异常未改 attachment；transferId 未知——记录
 * 可能未落盘，取空串）。agent_end 外层 catch 因此不再是唯一的异常出口。
 */
export function maybeAutoSucceed(
	input: {
		sessionId: string;
		generation: number;
		reading: PressureReading;
		cfg: MasterSuccessionConfig;
		spawn: SpawnSuccessor | null;
	},
	opts: AutoSucceedOptions = {},
): AutoSucceedResult {
	const gate = checkAutoGate({
		sessionId: input.sessionId,
		generation: input.generation,
		reading: input.reading,
		cfg: input.cfg,
		spawn: input.spawn,
		stateDir: opts.stateDir,
	});
	if (!gate.pass) return { action: "none", reason: gate.reason };
	// gate pass 蕴含 spawn 非 null（⑧）；显式收窄 + 防御
	const spawn = input.spawn;
	if (spawn === null) return { action: "none", reason: "no-spawn" };

	const threshold = effectiveAutoThresholdTokens(input.reading, input.cfg.autoPercent);
	if (threshold === null || input.reading.tokens === null || input.reading.tokens < threshold) {
		return { action: "none", reason: "below-threshold" };
	}

	const gen = input.generation;
	const markerBase: AutoMarker = {
		version: 1,
		lastAttemptGeneration: gen,
		lastAttemptAt: new Date().toISOString(),
		lastOutcome: "attempting",
	};
	writeAutoMarkerAtomic(markerBase, opts.stateDir);

	let r: ReturnType<typeof transferMaster>;
	try {
		r = transferMaster(
			{
				sessionId: input.sessionId,
				reason: `auto-succession @ ${input.reading.percent}%`,
				spawn,
			},
			opts,
		);
	} catch (e) {
		// 非 spawn I/O 异常归一化：统一走下方失败回退（marker failed + Attention +
		// auto_failed 事件 + S2 回退），不向 agent_end 外抛；transferId 未知 → 空串。
		r = { ok: false, reason: "spawn-failed", error: e instanceof Error ? e.message : String(e), transferId: "" };
	}
	if (r.ok) {
		writeAutoMarkerAtomic({ ...markerBase, lastOutcome: "completed", lastTransferId: r.transferId }, opts.stateDir);
		// journal 事件复用 master.handoff.started/spawned（transferMaster 内已发），不新增。
		return { action: "transferred", transferId: r.transferId, successorRunId: r.successorRunId, generation: r.generation };
	}

	// 失败回退（§18）：旧主保留（transferMaster 自带）→ marker=failed → Attention item
	// → auto_failed 事件 → 回退 S2 proposal（同代 pending 已存在则保留；不存在则新落）。
	const transferId = r.transferId ?? "";
	writeAutoMarkerAtomic({ ...markerBase, lastOutcome: "failed", lastTransferId: transferId }, opts.stateDir);
	appendAttentionItem(
		{
			id: newAttentionId(),
			at: new Date().toISOString(),
			kind: "auto-handoff-failed",
			transferId,
			error: r.error ?? "unknown",
			generation: gen,
			pressure: input.reading.percent,
		},
		opts.stateDir,
	);
	const at = new Date().toISOString();
	emitRuntimeEventOnce(
		newEventEnvelope({
			type: "master.handoff.auto_failed",
			source: masterAddress(),
			subject: masterAddress(),
			at,
			recordedAt: at,
			payload: { transferId, fromGeneration: gen, status: "failed" },
			dedupeKey: `auto-failed:${transferId}`,
		}),
		opts.journalPath ?? defaultJournalPath(),
	);
	maybePropose(
		{ sessionId: input.sessionId, generation: gen, reading: input.reading, proposalPercent: input.cfg.proposalPercent / 100 },
		opts,
	);
	return { action: "failed", transferId, error: r.error, generation: gen, pressure: input.reading.percent };
}
