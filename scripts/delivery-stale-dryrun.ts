#!/usr/bin/env node
/**
 * delivery-stale-dryrun.ts — 投递污染止血 **干跑清单**（只读，绝不改数据）
 *
 * 用法：
 *   node --experimental-strip-types ./scripts/delivery-stale-dryrun.ts            # 人读
 *   node --experimental-strip-types ./scripts/delivery-stale-dryrun.ts --json     # 机器读
 *   node --experimental-strip-types ./scripts/delivery-stale-dryrun.ts --limit 20 # 样例条数
 *
 * ## 只读保证（三层）
 * 1. 本文件**不 import** `recordAttempt` / `finalizeExpiredLease` / `finalizeDeadLetters`
 *    等任何写入口；只调 `listAttempts` / `listEvents` / `findDeadLetters`（纯扫描）。
 * 2. P-1 判据 `staleLeaseVerdict` 与 `staleLeaseReason` 都是纯函数（无 IO）。
 * 3. 跑前后打印 `runtime/delivery` 与 `runtime/mailbox` 的文件数 + 目录 mtime，
 *    供人核对「真的没动」。脚本自身不写任何文件（连日志都不写）。
 *
 * ## 为什么需要它
 * P-1/P-2 的落终态能力默认关（`PI_DELIVERY_STALE_FINALIZE` 未设 ⇒ 干跑）。运维在开启前
 * 必须能先看清「会被判什么、判多少条」。这个脚本就是那个清单，产物见
 * `plans/20261103_delivery_stale_dryrun.md`。
 */

import { existsSync, readFileSync, readdirSync, mkdirSync, mkdtempSync, rmSync, cpSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	EXPIRED_DEAD_OWNER,
	deliveryDir,
	effectiveStageOf,
	listAcks,
	listAttempts,
	listEvents,
	reconcileDecision,
	staleLeaseReason,
	staleLeaseVerdict,
	type DeliveryAttempt,
} from "../extensions/delivery-ledger.ts";
import { defaultMailboxDir, findDeadLetters, type DeadLetterRow } from "../extensions/runtime/mailbox.ts";
import { isProcessAlive } from "../extensions/runtime/liveness.ts";
import { probeAddressLiveness } from "../extensions/runtime/outbox-target-liveness.ts";
import { defaultRuntimeDir } from "../extensions/runtime/journal.ts";

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const limitIdx = argv.indexOf("--limit");
const SAMPLE = limitIdx >= 0 ? Number(argv[limitIdx + 1] ?? 10) : 10;

/** 目录文件计数（不含子目录递归；子目录单独列计数）。 */
function dirStats(dir: string): { files: number; subdirs: number } {
	if (!existsSync(dir)) return { files: 0, subdirs: 0 };
	let files = 0;
	let subdirs = 0;
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		if (e.isDirectory()) subdirs += 1;
		else files += 1;
	}
	return { files, subdirs };
}

/**
 * P-2 的探针口径（**与生产 P-2 一致**，见 `plans/20261103_delivery_stale_impl.md` §2.2）：
 * 先走 `outbox-target-liveness`（scope 心跳 + pid 探活 + PID 复用交叉验证）；
 * 只有「零证据」时才用 transcript 存在性补一手（`treatMissingTranscriptAsGone`）。
 * 两级证据都必须缺才判 dead ⇒ 宁漏不枉。
 */
function probeForDeadLetter(addr: string, now: number): { state: "alive" | "dead" | "unknown"; basis: string } {
	return probeAddressLiveness(addr, {
		now: new Date(now),
		stateDir: MIRROR_ROOT, // ← 镜像（探针的懒删只会动镜像，机制上碰不到生产）
		treatMissingTranscriptAsGone: true,
	});
}

// ── P-1：租约终态化干跑 ───────────────────────────────────────────

interface StaleLeaseRow {
	eventId: string;
	runId: string;
	attemptId: string;
	leaseOwner: string;
	leaseUntil: string;
	status: string;
	ageHours: number;
	reason: string;
	/** 走**完整判定链**（stage + reconcileDecision）后是否真的会落终态（2026-11-03 L4 第 2 轮） */
	realAction: string;
	wouldFinalizeReal: boolean;
}

function scanStaleLeases(now: number): StaleLeaseRow[] {
	const dir = deliveryDir();
	const rows: StaleLeaseRow[] = [];
	const events = listEvents(dir, 100_000);
	for (const ev of events) {
		const attempts = listAttempts(dir, ev.eventId);
		if (attempts.length === 0) continue;
		// 只看**最近**一次尝试（历史 attempt 的租约早过期是常态，不构成「当前状态」）
		const last: DeliveryAttempt = attempts.at(-1)!;
		if (last.status === EXPIRED_DEAD_OWNER) continue; // 已终态化过
		const verdict = staleLeaseVerdict(last, { now, isPidAlive: isProcessAlive });
		if (verdict === null) continue;
		// **完整链对照（2026-11-03 L4 第 2 轮实测驱动）**：光用租约判据报「wouldFinalize」会高估
		// （实测 1/1 候选走完整 reconcileDecision 后 = none，因 deadline/stage 门先命中）。
		// 现在同时报：租约判据候选 + 完整链实际动作，不再把候选当结论。
		const view = effectiveStageOf({ event: ev, attempts, acks: listAcks(dir, ev.eventId) }, { incidentId: ev.incidentId, incidentAt: ev.incidentAt }, now);
		const dec = reconcileDecision(ev, view, attempts, now, {
			staleLease: (a: DeliveryAttempt) => staleLeaseVerdict(a, { now, isPidAlive: isProcessAlive }),
		});
		rows.push({
			eventId: ev.eventId,
			runId: ev.runId,
			attemptId: last.attemptId,
			leaseOwner: last.leaseOwner ?? "?",
			leaseUntil: last.leaseUntil ?? "?",
			status: last.status,
			ageHours: Math.round(((now - Date.parse(last.at)) / 3_600_000) * 10) / 10,
			reason: staleLeaseReason(last, now),
			realAction: dec.action,
			wouldFinalizeReal: dec.action === "finalize_expired_lease",
		});
	}
	rows.sort((a, b) => b.ageHours - a.ageHours);
	return rows;
}

/** 同一批事件里「本来会被判」 vs 「实际仍会被补投」的对照（说明真的止住了补投）。 */
function leasePopulationSummary(now: number): {
	events: number;
	deliverableNow: number;
	staleCandidates: number;
	deadPidsInPlay: number;
} {
	const dir = deliveryDir();
	const events = listEvents(dir, 100_000);
	let deliverableNow = 0;
	let staleCandidates = 0;
	const pids = new Set<number>();
	for (const ev of events) {
		const attempts = listAttempts(dir, ev.eventId);
		// 这些事件若「未 consumed 未 failed」，B 就会继续补投 ⇒ 用户看到重复注入
		const closed = ev.incidentId !== undefined;
		if (!closed) deliverableNow += 1;
		const last = attempts.at(-1);
		if (!last) continue;
		if (staleLeaseVerdict(last, { now, isPidAlive: isProcessAlive }) !== null) {
			staleCandidates += 1;
			const m = /(\d+)$/.exec(last.leaseOwner ?? "");
			if (m) pids.add(Number(m[1]));
		}
	}
	return { events: events.length, deliverableNow, staleCandidates, deadPidsInPlay: pids.size };
}

// ── P-2：死信终态化干跑 ───────────────────────────────────────────

function scanDeadLetters(now: number): DeadLetterRow[] {
	// 先描述当前信箱家底（按状态计数），再给死信清单
	return findDeadLetters({
		mailboxDir: defaultMailboxDir(),
		now,
		probe: (addr) => probeForDeadLetter(addr, now),
	});
}

/**
 * **候选但探针 unknown ⇒ 不判死**的超龄信件（与「判死」分开报，避免把 0 条误读成「无死信」）。
 *
 * 为什么必须分开：`unknown ≠ dead`（`session-liveness.ts` 硬不变量）。本机 2026-11-03 的
 * `state/scope-liveness/` 被归档到只剩 2 条记录 ⇒ 大多数目标会话都查不到心跳 ⇒ 探针一律
 * `unknown` ⇒ P-2 拒绝判死。这时报「0 条」如果不附候选清单，读者会以为死信不存在。
 */
function scanDeadLetterCandidates(now: number): { recipient: string; to: string; status: string; ageHours: number; probe: string }[] {
	const out: { recipient: string; to: string; status: string; ageHours: number; probe: string }[] = [];
	const base = defaultMailboxDir();
	if (!existsSync(base)) return out;
	for (const d of readdirSync(base, { withFileTypes: true })) {
		if (!d.isDirectory() || d.name.startsWith("_")) continue;
		const dir = join(base, d.name);
		for (const f of readdirSync(dir)) {
			if (!f.endsWith(".json")) continue;
			let letter: { status?: string; frame?: { to?: string; sentAt?: string; issuedAt?: string } };
			try {
				letter = JSON.parse(readFileSync(join(dir, f), "utf8")) as typeof letter;
			} catch {
				continue;
			}
			const st = letter.status;
			if (st !== "pending" && st !== "claimed") continue;
			const sentAt = letter.frame?.sentAt ?? letter.frame?.issuedAt;
			if (typeof sentAt !== "string" || !Number.isFinite(Date.parse(sentAt))) continue;
			const ageMs = now - Date.parse(sentAt);
			if (ageMs <= 72 * 3_600_000) continue; // 与 DEAD_LETTER_MIN_AGE_MS 同口径
			const to = typeof letter.frame?.to === "string" ? letter.frame.to : d.name;
			const p = probeForDeadLetter(to, now);
			if (p.state === "dead") continue; // 已进 findDeadLetters 清单
			out.push({ recipient: d.name, to, status: st, ageHours: Math.round((ageMs / 3_600_000) * 10) / 10, probe: `${p.state}:${p.basis}` });
		}
	}
	return out.sort((a, b) => b.ageHours - a.ageHours);
}

function mailboxInventory(): { recipient: string; status: string; count: number }[] {
	const out: { recipient: string; status: string; count: number }[] = [];
	const base = defaultMailboxDir();
	if (!existsSync(base)) return out;
	for (const d of readdirSync(base, { withFileTypes: true })) {
		if (!d.isDirectory() || d.name.startsWith("_")) continue;
		// 用 listLetters 的底层扫描（需要 ObjectAddress；这里按目录名反推不稳，
		// 改用 findDeadLetters 同源的文件遍历 —— 只为统计，不判死）
		const dir = join(base, d.name);
		const counts = new Map<string, number>();
		for (const f of readdirSync(dir)) {
			if (!f.endsWith(".json")) continue;
			try {
				const raw = JSON.parse(readFileSync(join(dir, f), "utf8")) as { status?: unknown };
				const st = typeof raw.status === "string" ? raw.status : "?";
				counts.set(st, (counts.get(st) ?? 0) + 1);
			} catch { /* skip */ }
		}
		for (const [status, count] of counts) out.push({ recipient: d.name, status, count });
	}
	return out.sort((a, b) => a.recipient.localeCompare(b.recipient) || a.status.localeCompare(b.status));
}

// ── 只读镜像（2026-11-03 L4 审查实测驱动）──────────────────────
// 问题：探针链里带「僵尸懒删」（`session-owner.ts` 的 dead 分支会 `deleteSessionOwner`）。
// 原先只在报告里数 delivery/mailbox 的文件数 ⇒ **作用域比声明窄**（没盖住 state/）。
// 现在：① 探针跑在 state/ 的**临时镜像**上（机制上删不到生产）；
//       ② 对生产 `state/scope-liveness` + `state/session-owner` 做**文件名+内容 sha256 快照**，
//          跑前后比对，报告里给 `stateUnchanged`（不相等就标红，不静默）。
const MIRROR_DIRS = ["scope-liveness", "session-owner"] as const;
const MIRROR_ROOT = mkdtempSync(join(tmpdir(), "dryrun-state-"));
for (const d of MIRROR_DIRS) {
	const src = join(defaultRuntimeDir(), "state", d);
	if (existsSync(src)) cpSync(src, join(MIRROR_ROOT, d), { recursive: true });
}
const stateSnapshot = (): string => {
	const lines: string[] = [];
	for (const d of MIRROR_DIRS) {
		const dir = join(defaultRuntimeDir(), "state", d);
		if (!existsSync(dir)) { lines.push(`${d}:<missing>`); continue; }
		for (const f of readdirSync(dir).sort()) {
			try {
				const h = createHash("sha256").update(readFileSync(join(dir, f))).digest("hex").slice(0, 16);
				lines.push(`${d}/${f}=${h}`);
			} catch { lines.push(`${d}/${f}=<unreadable>`); }
		}
	}
	return lines.join("|");
};
const stateSnapBefore = stateSnapshot();

/** main 之前的头部说明保留在文件头。 */



const NOW = Date.now();
const deliveryStatsBefore = dirStats(deliveryDir());
const mailboxStatsBefore = dirStats(defaultMailboxDir());

const staleLeases = scanStaleLeases(NOW);
const leaseSummary = leasePopulationSummary(NOW);
const deadLetters = scanDeadLetters(NOW);
const deadLetterCandidates = scanDeadLetterCandidates(NOW);
const inventory = mailboxInventory();

// 只读自证：再数一次（应与上面相同；如果不相同，说明扫描期间有**别的进程**在写，
// 不是本脚本写的 —— 报告中要如实区分）
const deliveryStatsAfter = dirStats(deliveryDir());
const mailboxStatsAfter = dirStats(defaultMailboxDir());

const stateSnapAfter = stateSnapshot();
const report = {
	generatedAt: new Date(NOW).toISOString(),
	readOnly: true,
	stateUnchanged: stateSnapBefore === stateSnapAfter,
	stateMirror: MIRROR_ROOT,
	deliveryDir: deliveryDir(),
	mailboxDir: defaultMailboxDir(),
	counts: {
		deliveryFilesBefore: deliveryStatsBefore.files,
		deliveryFilesAfter: deliveryStatsAfter.files,
		mailboxFilesBefore: mailboxStatsBefore.files,
		mailboxFilesAfter: mailboxStatsAfter.files,
		events: leaseSummary.events,
		eventsUnclosed: leaseSummary.deliverableNow,
		p1LeaseCandidates: staleLeases.length,
		p1WouldFinalize: staleLeases.filter((r) => r.wouldFinalizeReal).length,
		p1DistinctDeadPids: leaseSummary.deadPidsInPlay,
		p2WouldFinalize: deadLetters.length,
		p2CandidatesNotJudged: deadLetterCandidates.length,
	},
	mailboxInventory: inventory,
	deadLetterCandidates,
	samples: {
		p1: staleLeases.slice(0, SAMPLE),
		p2: deadLetters.slice(0, SAMPLE),
	},
};

if (asJson) {
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
	const line = (s: string): void => { process.stdout.write(`${s}\n`); };
	line("═".repeat(78));
	line(`投递污染干跑清单（只读）  ${report.generatedAt}`);
	line("═".repeat(78));
	line(`delivery 目录：${report.deliveryDir}`);
	line(`  files: ${report.counts.deliveryFilesBefore} → ${report.counts.deliveryFilesAfter}（扫描前后，应相等）`);
	line(`mailbox  目录：${report.mailboxDir}`);
	line(`  files: ${report.counts.mailboxFilesBefore} → ${report.counts.mailboxFilesAfter}（扫描前后，应相等）`);
	line("");
	line(`事件总数：${report.counts.events}   未关闭（无 incident ⇒ 仍可能被补投）：${report.counts.eventsUnclosed}`);
	line(`P-1 租约判据候选（**不等于会落终态**）：${report.counts.p1LeaseCandidates}；走完整判定链后真会落终态：${report.counts.p1WouldFinalize}`);
	line(`P-2 会被判 target-gone 的信件：${report.counts.p2WouldFinalize}（另有 ${report.counts.p2CandidatesNotJudged} 条超龄但探针 unknown ⇒ **不判死**）`);
	line("");
	line("── 信箱家底（按状态）──");
	for (const r of inventory) line(`  ${r.recipient.padEnd(42)} ${r.status.padEnd(12)} ${r.count}`);
	if (inventory.length === 0) line("  （空）");
	line("");
	line(`── P-1 样例（最近一次尝试的租约已过期且 pid 已死）top ${SAMPLE} ──`);
	for (const r of report.samples.p1) {
		line(`  ${r.runId.padEnd(28)} ${r.leaseOwner.padEnd(12)} ${r.status.padEnd(12)} ${String(r.ageHours).padStart(7)}h  ${r.attemptId}`);
		line(`      reason: ${r.reason}`);
	}
	if (report.samples.p1.length === 0) line("  （无）");
	line("");
	line(`── P-2 样例（pending/claimed 超龄 + 目标确定已死）top ${SAMPLE} ──`);
	for (const r of report.samples.p2) {
		line(`  ${r.recipient.padEnd(40)} ${r.status.padEnd(9)} ${Math.round((r.ageMs / 3_600_000) * 10) / 10}h  ${r.messageId}`);
		line(`      to=${r.to}  reason: ${r.reason}`);
	}
	if (report.samples.p2.length === 0) line("  （无）");
	line("");
	line("── P-2 候选但**不判死**（超龄 72h+ 且探针 unknown：缺证据）──");
	for (const r of deadLetterCandidates.slice(0, SAMPLE)) {
		line(`  ${r.recipient.padEnd(40)} ${r.status.padEnd(9)} ${String(r.ageHours).padStart(7)}h  ${r.to}`);
		line(`      probe=${r.probe}`);
	}
	if (deadLetterCandidates.length === 0) line("  （无）");
	line("");
}

// 只读自证（三层）：计数 + state 快照 + 探针跑在镜像上
if (deliveryStatsBefore.files !== deliveryStatsAfter.files || mailboxStatsBefore.files !== mailboxStatsAfter.files) {
	process.stderr.write(
		`\n⚠ 扫描期间账本文件数发生变化（delivery ${deliveryStatsBefore.files}→${deliveryStatsAfter.files}, ` +
		`mailbox ${mailboxStatsBefore.files}→${mailboxStatsAfter.files}）。本脚本不写盘 ⇒ 变化来自**其他进程**（host/consumer）。\n`,
	);
}
if (!report.stateUnchanged) {
	// 探针链带「僵尸懒删」⇒ state 快照必须全等；不相等就是本脚本动了生产数据（不静默）
	process.stderr.write("\n⛔ state 快照前后不一致（scope-liveness / session-owner）⇒ 本脚本动了生产数据，干跑不再算只读。\n");
	process.exitCode = 1;
}
rmSync(MIRROR_ROOT, { recursive: true, force: true });
