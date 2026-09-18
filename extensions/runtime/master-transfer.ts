/**
 * master-transfer.ts — Transactional Master Transfer（Phase 5.5 M3）。
 *
 * 一键交接事务（用户文档 §5 九步）：
 *   owner 校验 → fresh handoff → 发 token → spawn 后继 → 后继凭 token attach
 *   → generation+1 → 旧主被 fencing（读时自然成立，无动作）→ completed 事件。
 *
 * 安全性质（§6）：detach 只发 token 不删 attachment；spawn 失败旧主仍是 owner，
 * 永无"无人接班"空窗；禁无限重试（失败转 failed 状态，人工/M5 接手）。
 * spawn 由调用方注入（可测；线上实现见 index.ts 传给 registerMasterTools 的回调）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { masterAddress } from "./address.ts";
import { newEventEnvelope } from "./envelope.ts";
import { defaultJournalPath, defaultRuntimeDir, emitRuntimeEventOnce } from "./journal.ts";
import { buildHandoff } from "./hydrate.ts";
import { issueMasterHandoffToken } from "./master-control.ts";
import { adoptTransfer, completeProposalForGeneration } from "./master-succession.ts";
import { readAttachment } from "./registry.ts";

export type TransferStatus = "initiated" | "spawned" | "attached" | "completed" | "failed";

export interface TransferRecord {
	version: 1;
	transferId: string;
	fromSession: string;
	fromGeneration: number;
	token: string;
	handoffPath: string;
	successorRunId?: string;
	status: TransferStatus;
	reason?: string;
	error?: string;
	createdAt: string;
	updatedAt: string;
}

/** spawn 后继的实现由调用方注入；抛错即 spawn 失败。 */
export type SpawnSuccessor = (args: {
	transferId: string;
	title: string;
	prompt: string;
	sessionId: string;
}) => { successorRunId: string };

export interface TransferOptions {
	stateDir?: string;
	journalPath?: string;
}

function transferDir(stateDir?: string): string {
	return join(stateDir ?? join(defaultRuntimeDir(), "state"), "master-transfers");
}

function recordPath(transferId: string, stateDir?: string): string {
	return join(transferDir(stateDir), `${transferId}.json`);
}

function writeRecordAtomic(path: string, record: TransferRecord): void {
	mkdirSync(transferDir(), { recursive: true });
	const dir = path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")));
	if (dir) mkdirSync(dir, { recursive: true });
	const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}

export function readTransferRecord(transferId: string, stateDir?: string): TransferRecord | null {
	try {
		const raw = JSON.parse(readFileSync(recordPath(transferId, stateDir), "utf8")) as TransferRecord;
		if (raw?.version !== 1 || typeof raw.transferId !== "string") return null;
		return raw;
	} catch {
		return null;
	}
}

function emitTransferEvent(
	type: "master.handoff.started" | "master.handoff.spawned" | "master.handoff.attached" | "master.handoff.completed" | "master.handoff.failed",
	record: TransferRecord,
	journalPath?: string,
): void {
	const at = new Date().toISOString();
	emitRuntimeEventOnce(
		newEventEnvelope({
			type,
			source: masterAddress(),
			subject: masterAddress(),
			at,
			recordedAt: at,
			payload: {
				transferId: record.transferId,
				fromSession: record.fromSession,
				fromGeneration: record.fromGeneration,
				status: record.status,
			},
			dedupeKey: `${type}:${record.transferId}`,
		}),
		journalPath ?? defaultJournalPath(),
	);
}

function newTransferId(): string {
	return `tr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 后继首轮 prompt：handoff 路径 + token + generation + transferId（§5 step 5）。 */
export function buildSuccessorPrompt(input: {
	transferId: string;
	token: string;
	handoffPath: string;
	fromGeneration: number;
}): string {
	return [
		"你是新一代逻辑 Master（succession 接班），不要 tab-finish，不要退出，常驻履职。",
		`交接包：${input.handoffPath}（先读它恢复上下文）。`,
		`handoff token：${input.token}（仅你可用）。transfer id：${input.transferId}，from generation ${input.fromGeneration}。`,
		"步骤：①读交接包；②调 master-attach 工具并传入 token 接管；③调 master-status 确认 generation+1 且 owner 是你；④调 master-transfer-confirm 并传入 transferId（标记交接完成）。",
	].join("\n");
}

export type TransferResult =
	| { ok: true; transferId: string; successorRunId: string; token: string; handoffPath: string; generation: number }
	| { ok: false; reason: "not-owner" | "spawn-failed"; error?: string; transferId?: string };

export function transferMaster(
	input: { sessionId: string; reason?: string; spawn: SpawnSuccessor },
	opts: TransferOptions = {},
): TransferResult {
	const master = masterAddress();
	const att = readAttachment(master);
	if (!att || att.sessionId !== input.sessionId) {
		return { ok: false, reason: "not-owner" };
	}
	const doc = buildHandoff({});
	const tok = issueMasterHandoffToken({ sessionId: input.sessionId, reason: input.reason });
	if (!tok.ok) return { ok: false, reason: "not-owner" };
	const token = tok.token!;

	const now = new Date().toISOString();
	const record: TransferRecord = {
		version: 1,
		transferId: newTransferId(),
		fromSession: input.sessionId,
		fromGeneration: att.generation,
		token,
		handoffPath: doc.path,
		status: "initiated",
		reason: input.reason,
		createdAt: now,
		updatedAt: now,
	};
	writeRecordAtomic(recordPath(record.transferId, opts.stateDir), record);
	emitTransferEvent("master.handoff.started", record, opts.journalPath);

	const prompt = buildSuccessorPrompt({
		transferId: record.transferId,
		token,
		handoffPath: doc.path,
		fromGeneration: att.generation,
	});
	try {
		const spawned = input.spawn({
			transferId: record.transferId,
			title: `successor ${record.transferId.slice(3, 9)} (gen ${att.generation + 1})`,
			prompt,
			sessionId: input.sessionId,
		});
		record.successorRunId = spawned.successorRunId;
	} catch (e) {
		record.status = "failed";
		record.error = e instanceof Error ? e.message : String(e);
		record.updatedAt = new Date().toISOString();
		writeRecordAtomic(recordPath(record.transferId, opts.stateDir), record);
		emitTransferEvent("master.handoff.failed", record, opts.journalPath);
		return { ok: false, reason: "spawn-failed", error: record.error, transferId: record.transferId };
	}
	record.status = "spawned";
	record.updatedAt = new Date().toISOString();
	writeRecordAtomic(recordPath(record.transferId, opts.stateDir), record);
	emitTransferEvent("master.handoff.spawned", record, opts.journalPath);
	adoptTransfer({ transferId: record.transferId, fromGeneration: att.generation }, opts);
	return {
		ok: true,
		transferId: record.transferId,
		successorRunId: record.successorRunId!,
		token,
		handoffPath: doc.path,
		generation: att.generation,
	};
}

export type ConfirmResult =
	| { ok: true; transferId: string; generation: number }
	| { ok: false; reason: "no-transfer" | "bad-state" | "not-owner" | "generation-mismatch" };

/** 后继 attach 成功后调用：校验 gen+1 与 owner，落 attached→completed。 */
export function confirmTransferAttach(
	input: { transferId: string; sessionId: string },
	opts: TransferOptions = {},
): ConfirmResult {
	const record = readTransferRecord(input.transferId, opts.stateDir);
	if (!record) return { ok: false, reason: "no-transfer" };
	if (record.status !== "spawned") return { ok: false, reason: "bad-state" };
	const att = readAttachment(masterAddress());
	if (!att || att.generation !== record.fromGeneration + 1) {
		return { ok: false, reason: "generation-mismatch" };
	}
	if (att.sessionId !== input.sessionId) return { ok: false, reason: "not-owner" };
	record.status = "attached";
	record.updatedAt = new Date().toISOString();
	writeRecordAtomic(recordPath(record.transferId, opts.stateDir), record);
	emitTransferEvent("master.handoff.attached", record, opts.journalPath);
	record.status = "completed";
	record.updatedAt = new Date().toISOString();
	writeRecordAtomic(recordPath(record.transferId, opts.stateDir), record);
	emitTransferEvent("master.handoff.completed", record, opts.journalPath);
	completeProposalForGeneration(att.generation, opts);
	return { ok: true, transferId: record.transferId, generation: att.generation };
}
