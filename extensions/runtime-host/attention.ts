/**
 * runtime-host/attention.ts — G3：Attention 投影（总计划 §30/§31；plans/0920_G3_attention_plan.md §2）
 *
 * 纯函数 `buildAttentionItems`：聚合三大原料（§31 五段）为 AttentionItem[]。
 * 只读派生、**不写回**（resolved 是派生状态；dismiss 属 G4 command executor，§29）。
 *
 * 原料（全部现成 tolerant 只读端，零 diff 复用，写面零改动）：
 *   1. `state/master-attention.json`   → runtime-risk（S3 auto-handoff 失败；S3 OFF 时
 *      文件缺失 = 正常，投影得 []；master-auto.ts 的 interface/写路径不动——S3 面）
 *   2. `state/master-succession.json`  → master-handoff（readProposal 单记录）
 *   3. `mailbox/<recipient>/*.json`    → escalation / question（pending 信按 frame.kind 过滤）
 *   4. `state/workstreams/*.json`      → blocked（workstream.status === "blocked"）
 *
 * 纪律（G1/G2 同款）：
 *   - 全路径注入（stateDir/mailboxDir，同 SnapshotOptions 模式），可单测；
 *   - 每源独立 try/catch：段级降级 = 该源缺席，**never-throw**；
 *   - 纯读、零写盘、无 Pi API；只 import node 内建 + `runtime/*` 纯读函数。
 *
 * 去重（主会话拍板①）：候选共享「源 key」——proposal 与 auto_failed 指向同一 transfer
 *   即同源双条目：proposal 条目 key = transferId ?? proposalId；attention 条目 key =
 *   transferId ?? 自身 id。**source key 最新胜出**（createdAt 最新者；同刻高 severity 者，
 *   再并列则先构造者，确定性）。
 *
 * resolved 过滤（主会话拍板①）：status=resolved 条目**默认不输出**；`includeResolved: true`
 *   （server `GET /v1/attention?includeResolved=1`）看历史。`dismissed` v1 永不出现。
 *
 * 无损映射（research ⑤.1）：master-attention 原 7 字段（id/at/kind/transferId/error/
 *   generation/pressure）全部保留在 `payload`；映射规则由 _test_runtime_host_projections 锁定。
 *
 * recipient 反解（best-effort，research ⑤.3）：mailbox.ts#L41 sanitize 的逆映射——`___`
 *   还原 `://`、其余 `_` 原样保留；非唯一重建（如 `run://tab/x` 二级 `/` 丢失）。`source`
 *   字段本就可选：反解校验不过 → 静默省略，不炸。
 *
 * 形状用 type 别名（非 interface）：保持可赋值 snapshot.ts 的 `Record<string, unknown>`
 *   占位类型（主会话拍板③：snapshot.ts 只做加法、不收紧已有类型）。
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isObjectAddress, workstreamAddress, type ObjectAddress } from "../runtime/address.ts";
import { readAttentionItems } from "../runtime/master-auto.ts";
import { defaultRuntimeDir } from "../runtime/journal.ts";
import { defaultMailboxDir, listLetters } from "../runtime/mailbox.ts";
import type { Letter } from "../runtime/protocol.ts";
import { readProposal } from "../runtime/master-succession.ts";
import { listWorkstreams } from "../runtime/workstreams.ts";

// ── 契约（§31 v1 形状）────────────────────────────────────────────

export type AttentionSeverity = "critical" | "warning" | "info";
export type AttentionType = "runtime-risk" | "master-handoff" | "escalation" | "question" | "blocked";
/** v1 只有 open/resolved（纯派生）；dismissed 归 G4 command executor（§29），永不出现。 */
export type AttentionStatus = "open" | "resolved";

export type AttentionItem = {
	id: string;
	type: AttentionType;
	severity: AttentionSeverity;
	title: string;
	summary: string;
	/** 原料带地址字段才有：mailbox = recipient 反解（best-effort）；workstream = 逻辑地址。缺省 = 省略。 */
	source?: ObjectAddress;
	status: AttentionStatus;
	/** v1 恒缺省（GUI 无写操作前不发明空动作，G4）。 */
	actions?: string[];
	/** 源时间：master-attention.at / proposal.proposedAt / letter.sentAt / ws.updatedAt。 */
	createdAt: string;
	/** 无损源 payload（master-attention 原 7 字段全保留；其余源放展示级补全字段）。 */
	payload?: Record<string, unknown>;
};

export interface AttentionOptions {
	/** 缺省 join(defaultRuntimeDir(), "state")。 */
	stateDir?: string;
	/** 缺省 defaultMailboxDir()。 */
	mailboxDir?: string;
	/** 含 resolved 条目（默认 false；server /v1/attention?includeResolved=1）。 */
	includeResolved?: boolean;
}

const SEV_RANK: Record<AttentionSeverity, number> = { critical: 3, warning: 2, info: 1 };
/** proposal 状态机（master-succession.ts#L25-L31）：前三态 = open，其余 = resolved。 */
const PROPOSAL_OPEN = new Set(["pending", "accepted", "transferring"]);

// ── 内部 ──────────────────────────────────────────────────────────

type Candidate = AttentionItem & { dedupeKey: string };

/**
 * mailbox.ts#L41 sanitize 的 best-effort 逆映射（research ⑤.3）：`://`（3 字符 → `___`）
 * 还原，其余 `_` 原样。非唯一重建（`/` 与 `:` 混排的地址无法唯一反解）——校验不过 →
 * undefined（source 可选，静默省略；注释如实，不假装无碰撞）。
 */
function unsanitizeRecipient(name: string): ObjectAddress | undefined {
	const cand = name.replace(/_{3}/g, "://");
	return isObjectAddress(cand) ? cand : undefined;
}

function pushMasterAttention(stateDir: string, out: Candidate[]): void {
	for (const a of readAttentionItems(stateDir)) {
		out.push({
			id: `runtime-risk:${a.id}`,
			type: "runtime-risk",
			severity: "critical",
			title: `自动交接失败：${a.transferId || a.id}`,
			summary: `auto handoff failed (gen ${a.generation}, pressure ${a.pressure ?? "n/a"})：${a.error}`,
			status: "open",
			createdAt: a.at,
			// transferId 可能为空串（transfer 记录未落盘的归一化路径，master-auto.ts#L291）→ 退回自身 id
			dedupeKey: a.transferId !== "" ? a.transferId : a.id,
			// 无损：原 7 字段全保留（research ⑤.1；master-auto.ts 写面零改动）
			payload: { id: a.id, at: a.at, kind: a.kind, transferId: a.transferId, error: a.error, generation: a.generation, pressure: a.pressure },
		});
	}
}

function pushProposal(stateDir: string, out: Candidate[]): void {
	const p = readProposal(stateDir);
	if (!p) return;
	const open = PROPOSAL_OPEN.has(p.status);
	const percent = Math.round(p.pressure * 100);
	const payload: Record<string, unknown> = {
		proposalId: p.proposalId,
		generation: p.generation,
		sessionId: p.sessionId,
		pressure: p.pressure,
		status: p.status,
		proposedAt: p.proposedAt,
	};
	if (p.decidedAt !== undefined) payload.decidedAt = p.decidedAt;
	if (p.transferId !== undefined) payload.transferId = p.transferId;
	out.push({
		id: `master-handoff:${p.proposalId}`,
		type: "master-handoff",
		// v1 默认表（plan §2）：open：pending/accepted=warning、transferring=critical；
		// resolved：failed=critical、其余 info
		severity: open ? (p.status === "transferring" ? "critical" : "warning") : p.status === "failed" ? "critical" : "info",
		title: `Handoff ${p.status}（gen ${p.generation}）`,
		summary: `Handoff ${p.status} at ${percent}% (gen ${p.generation}${p.transferId ? `, transfer ${p.transferId}` : ""})`,
		status: open ? "open" : "resolved",
		createdAt: p.proposedAt,
		// 同源双条（拍板①）：failed 的 proposal 与 auto_failed attention 共享 transferId → 同一 key
		dedupeKey: p.transferId !== undefined && p.transferId !== "" ? p.transferId : p.proposalId,
		payload,
	});
}

function pushMailbox(mailboxDir: string, out: Candidate[]): void {
	if (!existsSync(mailboxDir)) return;
	for (const d of readdirSync(mailboxDir, { withFileTypes: true })) {
		if (!d.isDirectory()) continue;
		const recoveredRecipient = unsanitizeRecipient(d.name);
		// 常见单段地址可由目录名反解，复用现成 tolerant reader。run:// 等地址中的
		// 路径分隔符也被 sanitize 成 `_`，不可逆；此时从信封的 to 字段恢复真实 recipient，
		// 而不是静默漏掉该收件箱的 attention。
		let letters: Letter[];
		if (recoveredRecipient) {
			letters = listLetters(recoveredRecipient, "pending", mailboxDir);
		} else {
			letters = [];
			for (const name of readdirSync(join(mailboxDir, d.name))) {
				if (!name.endsWith(".json")) continue;
				try {
					const letter = JSON.parse(readFileSync(join(mailboxDir, d.name, name), "utf8")) as Letter;
					if (letter.status === "pending") letters.push(letter);
				} catch {
					/* 坏信跳过（与 listLetters 一致） */
				}
			}
		}
		for (const letter of letters) {
			const f = letter.frame;
			if (f.frame !== "message" || (f.kind !== "ESCALATION" && f.kind !== "QUESTION") || !isObjectAddress(f.to)) continue;
			const type: AttentionType = f.kind === "ESCALATION" ? "escalation" : "question";
			const s = f.body.summary;
			out.push({
				id: `${type}:${f.id}`,
				type,
				severity: type === "escalation" ? "warning" : "info",
				title: `${type === "escalation" ? "Escalation" : "Question"}: ${s.slice(0, 48)}`,
				summary: `${f.kind} ${f.id} from ${f.from} → ${f.to}: ${s}`,
				source: f.to,
				status: "open",
				createdAt: f.sentAt,
				dedupeKey: f.id,
				payload: { messageId: f.id, kind: f.kind, from: f.from, to: f.to, ...(f.subject ? { subject: f.subject } : {}), sentAt: f.sentAt, summary: s },
			});
		}
	}
}

function pushWorkstreams(stateDir: string, out: Candidate[]): void {
	for (const ws of listWorkstreams(stateDir)) {
		if (ws.status !== "blocked") continue;
		out.push({
			id: `blocked:${ws.id}`,
			type: "blocked",
			severity: "warning",
			title: `Workstream blocked：${ws.mission.slice(0, 48)}`,
			summary: `ws ${ws.id} is blocked (mission: ${ws.mission.slice(0, 80)})`,
			source: workstreamAddress(ws.id),
			status: "open",
			createdAt: ws.updatedAt,
			dedupeKey: ws.id,
			payload: { workstreamId: ws.id, status: ws.status, mission: ws.mission },
		});
	}
}

// ── 入口（纯函数，永不 throw）─────────────────────────────────────

export function buildAttentionItems(opts: AttentionOptions = {}): AttentionItem[] {
	const stateDir = opts.stateDir ?? join(defaultRuntimeDir(), "state");
	const mailboxDir = opts.mailboxDir ?? defaultMailboxDir();
	const out: Candidate[] = [];

	// 每源独立 try/catch：段级降级 = 该源缺席（never-throw，G1 惯例；
	// 源文件缺失不算 error——readAttentionItems/readProposal 本就缺失→[]/null）
	try {
		pushMasterAttention(stateDir, out);
	} catch {
		/* 段降级 */
	}
	try {
		pushProposal(stateDir, out);
	} catch {
		/* 段降级 */
	}
	try {
		pushMailbox(mailboxDir, out);
	} catch {
		/* 段降级 */
	}
	try {
		pushWorkstreams(stateDir, out);
	} catch {
		/* 段降级 */
	}

	// 同源双条去重（拍板①）：source key 最新胜出；同刻高 severity 胜；再并列先构造者胜（确定性）
	const byKey = new Map<string, Candidate>();
	for (const c of out) {
		const prev = byKey.get(c.dedupeKey);
		if (
			prev === undefined ||
			c.createdAt > prev.createdAt ||
			(c.createdAt === prev.createdAt && SEV_RANK[c.severity] > SEV_RANK[prev.severity])
		) {
			byKey.set(c.dedupeKey, c);
		}
	}

	// resolved 默认过滤（拍板①）+ 输出序：severity 降 → createdAt 降 → id（展示序稳定）
	const items = [...byKey.values()]
		.filter((c) => (opts.includeResolved === true ? true : c.status !== "resolved"))
		.map(({ dedupeKey: _drop, ...item }) => item);
	items.sort(
		(a, b) =>
			SEV_RANK[b.severity] - SEV_RANK[a.severity] ||
			b.createdAt.localeCompare(a.createdAt) ||
			a.id.localeCompare(b.id),
	);
	return items;
}
