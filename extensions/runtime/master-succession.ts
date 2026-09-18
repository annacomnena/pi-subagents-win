/**
 * master-succession.ts — Proposal-driven Handoff State（Phase 5.5 M5）。
 *
 * S2 提议制交接的状态机（用户文档 §10-13）：
 *   turn 检查达线 → 每 generation 最多 1 次 pending proposal →
 *   before_agent_start 注入短提醒 → 用户批准则调 master-transfer →
 *   transfer 认领（transferring）→ confirm 完成（completed）。
 *
 * M3 独立可用：无 pending 时 transfer/confirm 照常工作（adopt/complete 皆为 no-op）。
 * 单记录文件（同代覆盖即隐式 supersede；历史留痕走 journal 事件）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { masterAddress } from "./address.ts";
import { newEventEnvelope } from "./envelope.ts";
import { defaultJournalPath, defaultRuntimeDir, emitRuntimeEventOnce } from "./journal.ts";
import {
	DEFAULT_PROPOSAL_PERCENT,
	meetsProposalThreshold,
	type PressureReading,
} from "./master-pressure.ts";
import { readAttachment } from "./registry.ts";

export type ProposalStatus =
	| "pending"
	| "accepted"
	| "declined"
	| "superseded"
	| "transferring"
	| "completed"
	| "failed";

export interface SuccessionProposal {
	version: 1;
	proposalId: string;
	generation: number;
	sessionId: string;
	pressure: number;
	status: ProposalStatus;
	proposedAt: string;
	decidedAt?: string;
	transferId?: string;
}

export interface SuccessionOptions {
	stateDir?: string;
	journalPath?: string;
}

function proposalPath(stateDir?: string): string {
	return join(stateDir ?? join(defaultRuntimeDir(), "state"), "master-succession.json");
}

function writeProposalAtomic(path: string, proposal: SuccessionProposal): void {
	const dir = path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")));
	if (dir) mkdirSync(dir, { recursive: true });
	const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(proposal, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}

export function readProposal(stateDir?: string): SuccessionProposal | null {
	try {
		const raw = JSON.parse(readFileSync(proposalPath(stateDir), "utf8")) as SuccessionProposal;
		if (raw?.version !== 1 || typeof raw.proposalId !== "string") return null;
		return raw;
	} catch {
		return null;
	}
}

function emitSuccessionEvent(
	type: "master.handoff.proposed" | "master.handoff.accepted",
	proposal: SuccessionProposal,
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
				proposalId: proposal.proposalId,
				generation: proposal.generation,
				pressure: proposal.pressure,
				status: proposal.status,
			},
			dedupeKey: `${type}:${proposal.proposalId}`,
		}),
		journalPath ?? defaultJournalPath(),
	);
}

function newProposalId(): string {
	return `hp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export type ProposeResult =
	| { proposed: true; proposal: SuccessionProposal }
	| { proposed: false; reason: "not-owner" | "no-decision" | "below-threshold" | "already-proposed" };

/** turn 检查入口：owner + 达线 + 同代未提过 → 落 pending（§10）。 */
export function maybePropose(
	input: { sessionId: string; generation: number; reading: PressureReading; proposalPercent?: number },
	opts: SuccessionOptions = {},
): ProposeResult {
	const att = readAttachment(masterAddress());
	if (!att || att.sessionId !== input.sessionId || att.generation !== input.generation) {
		return { proposed: false, reason: "not-owner" };
	}
	if (input.reading.percent === null) return { proposed: false, reason: "no-decision" };
	const threshold = input.proposalPercent ?? DEFAULT_PROPOSAL_PERCENT;
	if (!meetsProposalThreshold(input.reading, threshold)) {
		return { proposed: false, reason: "below-threshold" };
	}
	const existing = readProposal(opts.stateDir);
	if (existing && existing.generation === input.generation) {
		return { proposed: false, reason: "already-proposed" };
	}
	const proposal: SuccessionProposal = {
		version: 1,
		proposalId: newProposalId(),
		generation: input.generation,
		sessionId: input.sessionId,
		pressure: input.reading.percent,
		status: "pending",
		proposedAt: new Date().toISOString(),
	};
	writeProposalAtomic(proposalPath(opts.stateDir), proposal);
	emitSuccessionEvent("master.handoff.proposed", proposal, opts.journalPath);
	return { proposed: true, proposal };
}

export type DecideResult =
	| { ok: true; proposal: SuccessionProposal }
	| { ok: false; reason: "no-proposal" | "bad-state" | "not-owner" };

/** 用户明确拒绝/批准（批准后实际交接走 master-transfer，这里只记 accepted）。 */
export function decideProposal(
	input: { sessionId: string; decision: "accepted" | "declined" },
	opts: SuccessionOptions = {},
): DecideResult {
	const existing = readProposal(opts.stateDir);
	if (!existing) return { ok: false, reason: "no-proposal" };
	if (existing.status !== "pending") return { ok: false, reason: "bad-state" };
	if (existing.sessionId !== input.sessionId) return { ok: false, reason: "not-owner" };
	existing.status = input.decision;
	existing.decidedAt = new Date().toISOString();
	writeProposalAtomic(proposalPath(opts.stateDir), existing);
	if (input.decision === "accepted") {
		emitSuccessionEvent("master.handoff.accepted", existing, opts.journalPath);
	}
	return { ok: true, proposal: existing };
}

/** transfer 成功后认领：同代 pending → transferring。无 pending 即 no-op（M3 独立）。 */
export function adoptTransfer(
	input: { transferId: string; fromGeneration: number },
	opts: SuccessionOptions = {},
): { adopted: boolean } {
	const existing = readProposal(opts.stateDir);
	if (!existing || existing.status !== "pending" || existing.generation !== input.fromGeneration) {
		return { adopted: false };
	}
	existing.status = "transferring";
	existing.transferId = input.transferId;
	writeProposalAtomic(proposalPath(opts.stateDir), existing);
	return { adopted: true };
}

/** confirm 完成后：同代 transferring → completed。 */
export function completeProposalForGeneration(
	generation: number,
	opts: SuccessionOptions = {},
): { completed: boolean } {
	const existing = readProposal(opts.stateDir);
	if (!existing || existing.status !== "transferring" || existing.generation !== generation) {
		return { completed: false };
	}
	existing.status = "completed";
	writeProposalAtomic(proposalPath(opts.stateDir), existing);
	return { completed: true };
}

/** before_agent_start 提醒缝：pending 即返回短提醒（§12），否则 null。 */
export function getPendingReminder(stateDir?: string): string | null {
	const existing = readProposal(stateDir);
	if (!existing || existing.status !== "pending") return null;
	return [
		`A pending Master handoff proposal exists (proposal ${existing.proposalId}, pressure ${existing.pressure}%, gen ${existing.generation}).`,
		"If the user's latest message approves the handoff, call master-transfer.",
		"Otherwise continue normally.",
	].join("\n");
}
