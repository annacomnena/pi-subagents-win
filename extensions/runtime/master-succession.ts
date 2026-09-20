/**
 * master-succession.ts — Proposal-driven Handoff State（Phase 5.5 M5）。
 *
 * S2 提议制交接的状态机（用户文档 §10-13）：
 *   turn 检查达线 → 每 generation 最多 1 次 pending proposal →
 *   before_agent_start 注入短提醒 → 用户批准则调 master-transfer →
 *   transfer 认领（transferring）→ confirm 完成（completed）。
 *
 * R2（plans/0921_G52_patch_review.md 必修 2）：maybePropose 的 proposal 创建走
 * <generation> 级 wx claim / 原子 create 协议（下方 R2 段），覆盖 agent_end 与
 * prepare 两个调用方；agent_end 既有语义（owner+达线+同代未提过才提议、同代去重）
 * 逐字保持。
 *
 * M3 独立可用：无 pending 时 transfer/confirm 照常工作（adopt/complete 皆为 no-op）。
 * 单记录文件（同代覆盖即隐式 supersede；历史留痕走 journal 事件）。
 */
import {
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
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

// ── R2（plans/0921_G52_patch_review.md 必修 2）：代级 proposal 创建权（wx claim / 原子 create）──
//
// why：maybePropose 有两个调用方（session-hooks agent_end / command-executor prepare），
// 后者跨进程且可携带不同 commandKey——既有 commandKey claim 只约束同键重放，两个不同
// commandKey 的 prepare 可同时越过 readProposal 双查（TOCTOU），各自生成 proposal 并各发
// 一条 proposed 事件，单记录文件只留最后一份。此处为 <generation> 引入 wx 排他 claim：
// 同代创建权全局唯一（覆盖 agent_end 与 prepare 两个调用方），赢家原子落盘；输家自旋回读
// 同代 proposal → already-proposed，**绝不覆盖**。claim 与「每 generation 至多一次
// proposal」同生命周期（永不释放）；赢家 claim 后写盘前崩溃由超龄接管恢复（10s，
// proposal 本体在任何路径下都不被覆盖）。
const PROPOSAL_CLAIM_SPIN_MS = 20;
/** 输家自旋上限 ~1.5s：赢家 claim→写盘窗口本地盘亚毫秒级，绰绰有余。 */
const PROPOSAL_CLAIM_SPIN_MAX = 75;
/** claim 超过此年龄仍无同代 proposal → 视为赢家已崩溃，可被接管（可恢复性）。 */
const PROPOSAL_CLAIM_STALE_MS = 10_000;

function proposalClaimsDir(stateDir?: string): string {
	return join(stateDir ?? join(defaultRuntimeDir(), "state"), "master-succession.claims");
}

function proposalClaimPath(generation: number, stateDir?: string): string {
	return join(proposalClaimsDir(stateDir), `gen-${generation}.claim`);
}

/** wx 排他领取 <generation> 的 proposal 创建权；false = 已有赢家（输家应回读同代 proposal）。 */
function claimProposalGeneration(generation: number, stateDir?: string): boolean {
	mkdirSync(proposalClaimsDir(stateDir), { recursive: true }); // IO 异常向上抛（调用方收敛）
	let fd: number;
	try {
		fd = openSync(proposalClaimPath(generation, stateDir), "wx");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw e;
	}
	try {
		writeSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
	} catch {
		/* 领取已成立，debug 内容写失败不影响 */
	}
	try {
		closeSync(fd);
	} catch {
		/* ignore */
	}
	return true;
}

/** claim 文件年龄（ms）；不可读视为超龄（文件消失时重领也必赢，接管安全）。 */
function proposalClaimAgeMs(generation: number, stateDir?: string): number {
	try {
		return Date.now() - statSync(proposalClaimPath(generation, stateDir)).mtimeMs;
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

/** 同步 sleep（输家自旋等待用；Atomics.wait 主线程可用，极端宿主退化忙等一步）。 */
function sleepSync(ms: number): void {
	try {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
	} catch {
		/* 忙等退化：单步自旋即可 */
	}
}

export type ProposeResult =
	| { proposed: true; proposal: SuccessionProposal }
	| { proposed: false; reason: "not-owner" | "no-decision" | "below-threshold" | "already-proposed" };

/**
 * turn 检查入口：owner + 达线 + 同代未提过 → 落 pending（§10）。
 * `enabled === false`（总开关 /master-succession off）→ 静默返回 null：
 * 不落 state、不发事件、不通知；已落盘的旧 pending 不清除（既有生命周期处理）；
 * 压力满由 pi 原生 compaction 自然接管。缺省（undefined）= true，现状零差。
 */
export function maybePropose(
	input: { sessionId: string; generation: number; reading: PressureReading; proposalPercent?: number; enabled?: boolean },
	opts: SuccessionOptions = {},
): ProposeResult | null {
	if (input.enabled === false) return null;
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
	// R2 代级 claim 竞争（两次尝试 = 正常竞争 1 次 + 超龄接管 1 次）
	for (let attempt = 0; attempt < 2; attempt++) {
		if (claimProposalGeneration(input.generation, opts.stateDir)) {
			// 赢家：防御 double-check（claim 等待期间同代 proposal 落盘的理论窗口）后原子创建
			const dup = readProposal(opts.stateDir);
			if (dup && dup.generation === input.generation) {
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
		// 输家：自旋回读同代 proposal（等赢家 claim→写盘窗口），绝不覆盖
		for (let i = 0; i < PROPOSAL_CLAIM_SPIN_MAX; i++) {
			const p = readProposal(opts.stateDir);
			if (p && p.generation === input.generation) return { proposed: false, reason: "already-proposed" };
			sleepSync(PROPOSAL_CLAIM_SPIN_MS);
		}
		// 赢家疑似 claim 后写盘前崩溃：仅当 claim 已超龄才接管一次
		if (proposalClaimAgeMs(input.generation, opts.stateDir) < PROPOSAL_CLAIM_STALE_MS) break;
		try {
			unlinkSync(proposalClaimPath(input.generation, opts.stateDir));
		} catch {
			break; // 接管失败 → 保守放弃（不覆盖、不二次创建）
		}
	}
	// 同代创建权在他人手中且 proposal 不可见（亚秒级窗口/崩溃恢复期）：同代已被领取，
	// 按 already-proposed 返回（失败方回读语义；绝不覆盖、绝不二次创建）。
	return { proposed: false, reason: "already-proposed" };
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

/** confirm 完成后：凭 transferId 将 transferring proposal → completed。 */
export function completeProposalForTransfer(
	transferId: string,
	opts: SuccessionOptions = {},
): { completed: boolean } {
	const existing = readProposal(opts.stateDir);
	if (!existing || existing.status !== "transferring" || existing.transferId !== transferId) {
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
