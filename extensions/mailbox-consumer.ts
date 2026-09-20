/**
 * mailbox-consumer.ts — Mailbox 真消费端（Phase 4d，A5 F10/F16/F17）
 *
 * 单封顺序（F16，任一点崩溃可证 at-least-once）：
 *   list 圈定 → fencing 预检 → 定向 claim → fencing 复检 → preInject 门
 *   → sendUserMessage 注入 → postInject 确认 → .notified 补认领（best-effort）
 *   → ackLetter
 *
 * F17 旧信保护：sentAt/issuedAt 早于 cutover.enabledAt 的信一律跳过
 * （pre-cutover-legacy），留给 legacy——9903 信即此类，永不重注。
 * 未切换（flag 关/无 registry）时本消费端零动作（legacy 原行为）。
 *
 * 注册形态同 report 监听器：session_start（仅主会话）+ interval tick。
 * 所有异常内部吞掉，绝不破坏宿主会话。
 */

import {
	ackLetter,
	claimLetters,
	defaultMailboxDir,
	listLetters,
	type Letter,
} from "./runtime/mailbox.ts";
import { masterAddress, type ObjectAddress } from "./runtime/address.ts";
import { readAttachment, readCutover } from "./runtime/registry.ts";
import { resolveRecipient } from "./runtime/resolver.ts";
import { auditSuppression, postInject, preInject } from "./injection-gate.ts";
import { claimNotified } from "./event-bus.ts";
import { defaultTabRunsDir } from "./tab-runs.ts";
import { isMainSession, isSubagent } from "./identity.ts";
import { NO_POLL_HINT } from "./no-poll.ts";
import { auditWakeSpawnFailed, confirmWakeSpawn, evaluateWakes, type WakeDecision } from "./runtime/wake.ts";

export interface ConsumeOptions {
	sessionId: string | undefined;
	recipient?: ObjectAddress;
	mailboxDir?: string;
	/** .notified 认领目录（缺省真实 tab-runs；测试传隔离目录） */
	runsDir?: string;
	/** 注入实现（生产接 pi.sendUserMessage，测试传 fake） */
	sendUserMessage?: (body: string, opts?: { deliverAs?: string }) => void;
}

export interface ConsumeEntry {
	messageId: string;
	action: "injected" | "skipped";
	reason?: string;
}

export interface ConsumeReport {
	owner: string | null;
	consumed: ConsumeEntry[];
}

/** 信件领域时间（F17 比较用）。 */
function letterTime(letter: Letter): string {
	return letter.frame.frame === "message" ? letter.frame.sentAt : letter.frame.issuedAt;
}

/** 信标识（与 consumer-scan 同规则）。 */
function describeLetter(letter: Letter): string {
	return letter.frame.frame === "message" ? letter.frame.id : `cmd:${letter.frame.commandKey}`;
}

/** 收据键（与 consumer-scan 同规则；派生不出 → msg:<id> 兜底）。 */
function receiptKeyFor(letter: Letter): string {
	if (letter.frame.frame === "command") return `cmd:${letter.frame.commandKey}`;
	const subject = letter.frame.subject;
	const details = letter.frame.body.details as { status?: string } | undefined;
	if (subject && subject.startsWith("run://tab/") && details?.status) {
		return `run-${subject.slice("run://tab/".length)}-${details.status}`;
	}
	return `msg:${letter.frame.id}`;
}

function holderOf(sessionId: string): string {
	return `mailbox-consumer:${sessionId}`;
}

/** 已审计过的 pre-cutover 键（进程内去重：tick 每轮重扫不再重复记审计；审计是诊断性的） */
const auditedPreCutover = new Set<string>();

/**
 * 消费一轮（owner 会话调用）。返回报告；任何单封失败不影响其余。
 */
export function consumeMailboxOnce(opts: ConsumeOptions): ConsumeReport {
	const report: ConsumeReport = { owner: null, consumed: [] };
	try {
		return consumeMailboxOnceInner(opts);
	} catch {
		return report; // 顶层兜底：消费端永不抛
	}
}

function consumeMailboxOnceInner(opts: ConsumeOptions): ConsumeReport {
	const report: ConsumeReport = { owner: null, consumed: [] };
	const recipient = opts.recipient ?? masterAddress();
	const mailboxDir = opts.mailboxDir ?? defaultMailboxDir();
	const cutover = readCutover();
	const attachment = readAttachment(recipient);
	if (!cutover?.enabled || !attachment) return { owner: null, consumed: [] }; // 未切换：零动作
	if (!opts.sessionId || opts.sessionId !== attachment.sessionId) {
		return { owner: attachment.sessionId, consumed: [] }; // 非 owner：零动作（抑制审计由 legacy 门负责）
	}
	const owner = attachment.sessionId;
	report.owner = owner;

	const pending = listLetters(recipient, "pending", mailboxDir);
	for (const letter of pending) {
		const messageId = describeLetter(letter);
		try {
			// F17：cutover 前的旧信留给 legacy（每键只审计一次，防 tick 刷屏）
			if (letterTime(letter) < cutover.enabledAt) {
				const auditKey = receiptKeyFor(letter);
				if (!auditedPreCutover.has(auditKey)) {
					auditedPreCutover.add(auditKey);
					auditSuppression(
						{ key: auditKey, sessionId: opts.sessionId, path: "mailbox-consumer" },
						"pre-cutover-legacy",
						{ sessionId: attachment.sessionId, generation: attachment.generation },
					);
				}
				reportPush(report, messageId, "skipped", "pre-cutover-legacy");
				continue;
			}
			// 定向 claim（单封）
			const frameId = letter.frame.frame === "message" ? letter.frame.id : undefined;
			const taken = frameId
				? claimLetters(recipient, { claimedBy: holderOf(opts.sessionId), mailboxDir, ids: [frameId], limit: 1 })
				: [];
			if (taken.length === 0) {
				reportPush(report, messageId, "skipped", "claim-missed");
				continue;
			}
			// F16：claim 后 fencing 复检
			const fresh = resolveRecipient(recipient);
			if (!fresh || fresh.sessionId !== opts.sessionId) {
				reportPush(report, messageId, "skipped", "generation-moved");
				continue; // 已 claim 的信留给 stale 回收（不丢）
			}
			// 统一门
			const key = receiptKeyFor(letter);
			const verdict = preInject({ key, sessionId: opts.sessionId, path: "mailbox-consumer" });
			if (!verdict.inject) {
				if (verdict.reason === "already-injected") {
					ackLetter(recipient, frameId!, { mailboxDir }); // 活干完了，收尾 ack
					reportPush(report, messageId, "skipped", "already-injected-acked");
				} else {
					reportPush(report, messageId, "skipped", verdict.reason);
				}
				continue;
			}
			// 注入
			let ok = false;
			try {
				opts.sendUserMessage?.(buildInjectBody(letter), { deliverAs: "followUp" });
				ok = true;
			} catch {
				ok = false;
			}
			postInject({ key, sessionId: opts.sessionId, path: "mailbox-consumer" }, ok);
			if (!ok) {
				reportPush(report, messageId, "skipped", "inject-failed");
				continue;
			}
			// .notified 补认领（best-effort：堵 legacy 路径重注，terra 三路去重）
			try {
				if (letter.frame.frame === "message" && letter.frame.subject?.startsWith("run://tab/")) {
					claimNotified(opts.runsDir ?? defaultTabRunsDir(), letter.frame.subject.slice("run://tab/".length));
				}
			} catch {
				/* best-effort */
			}
			ackLetter(recipient, frameId!, { mailboxDir });
			reportPush(report, messageId, "injected");
		} catch {
			reportPush(report, messageId, "skipped", "error");
		}
	}
	return { owner, consumed: report.consumed };
}

function reportPush(report: ConsumeReport, messageId: string, action: "injected" | "skipped", reason?: string): void {
	report.consumed.push({ messageId, action, reason });
}

/** 注入正文（与 followUp 同风格，标注 mailbox 路径来源）。 */
function buildInjectBody(letter: Letter): string {
	if (letter.frame.frame === "command") {
		return `📬 mailbox 命令 ${letter.frame.type}（key=${letter.frame.commandKey}）待执行：请按命令语义处理。`;
	}
	const details = letter.frame.body.details as { tabRunId?: string; taskId?: string } | undefined;
	const task = details?.taskId ? ` task=${details.taskId}` : "";
	return [
		`📬 Tab ${details?.tabRunId ?? letter.frame.subject} 已完成（mailbox REPORT${task}）`,
		`摘要: ${letter.frame.body.summary.slice(0, 500)}`,
		`下一步: 用 reclaim-tabs 确认并编排后续；本消息已在 mailbox ack，不会重复。`,
		// 完成类消息（command 分支不附；与 event-bus 完成体同一常量，cutover 切流前后纪律一致）
		NO_POLL_HINT,
	].join("\n");
}

/**
 * 注册主会话消费循环（形态同 report 监听器：session_start + interval tick）。
 * flag 关/非 owner 时 tick 为空转（零行为变化）。
 */
export function registerMailboxConsumer(
	pi: {
		on: (event: string, cb: (event: unknown, ctx?: { sessionManager?: { sessionId?: string } }) => void) => void;
		sendUserMessage?: (body: string, opts?: { deliverAs?: string }) => void;
	},
	opts: { mailboxDir?: string; intervalMs?: number } = {},
): () => void {	let interval: ReturnType<typeof setInterval> | null = null;
	let sessionGen = 0;
	pi.on("session_start", (_event, ctx) => {
		try {
			if (isSubagent()) return;
			// 消费注册 ownership-gated（M1，与 event-bus watcher 同不变量）：cutover 启用时
			// 「owner 是谁谁消费」（UUID 域，与 attach 写入侧同域——tab 形态 owner 重启前也可消费）；
			// 未启用/无 registry → legacy 回退 isMainSession（零变化）；子 agent 恒不消费。
			const sid = (ctx as { sessionManager?: { sessionId?: string } } | undefined)?.sessionManager?.sessionId;
			const cut = readCutover();
			const att = readAttachment(masterAddress());
			const eligible = cut?.enabled && att
				? Boolean(sid && sid === att.sessionId)
				: isMainSession();
			if (!eligible) return;
		} catch {
			return;
		}
		const myGen = ++sessionGen;
		const closed = (): boolean => myGen !== sessionGen;
		if (interval) clearInterval(interval);
		const sid = ctx?.sessionManager?.sessionId;
		const send = pi.sendUserMessage?.bind(pi);
		interval = setInterval(() => {
			if (closed()) return;
			try {
				consumeMailboxOnce({ sessionId: sid, mailboxDir: opts.mailboxDir, sendUserMessage: send });
			} catch {
				/* 消费端永不破坏会话 */
			}
		}, opts.intervalMs ?? 10_000);
		interval.unref?.();
	});
	return () => {
		sessionGen++;
		if (interval) clearInterval(interval);
		interval = null;
	};
}

/**
 * 注册 Sub-Master 唤醒循环（Phase 5c）：与消费循环同形态但独立 interval。
 * tick 内：evaluateWakes（纯评估+claim）→ spawn（调用方注入）→ confirm/audit。
 * cutover 关/非 owner/无 ws/无信时全程空转（零行为变化）。
 * spawn 抛错 → auditWakeSpawnFailed，信留 claimed（stale 恢复），tick 继续。
 */
export function registerWakeLoop(
	pi: {
		on: (event: string, cb: (event: unknown, ctx?: { sessionManager?: { sessionId?: string } }) => void) => void;
	},
	opts: {
		spawn: (decision: WakeDecision, sessionId: string | undefined) => string;
		mailboxDir?: string;
		stateDir?: string;
		runsDir?: string;
		intervalMs?: number;
	},
): () => void {
	let interval: ReturnType<typeof setInterval> | null = null;
	let sessionGen = 0;
	pi.on("session_start", (_event, ctx) => {
		try {
			if (isSubagent()) return;
			// 消费注册 ownership-gated（M1，与 event-bus watcher 同不变量）：cutover 启用时
			// 「owner 是谁谁消费」（UUID 域，与 attach 写入侧同域——tab 形态 owner 重启前也可消费）；
			// 未启用/无 registry → legacy 回退 isMainSession（零变化）；子 agent 恒不消费。
			const sid = (ctx as { sessionManager?: { sessionId?: string } } | undefined)?.sessionManager?.sessionId;
			const cut = readCutover();
			const att = readAttachment(masterAddress());
			const eligible = cut?.enabled && att
				? Boolean(sid && sid === att.sessionId)
				: isMainSession();
			if (!eligible) return;
		} catch {
			return;
		}
		const myGen = ++sessionGen;
		const closed = (): boolean => myGen !== sessionGen;
		if (interval) clearInterval(interval);
		const sid = ctx?.sessionManager?.sessionId;
		interval = setInterval(() => {
			if (closed()) return;
			try {
				const decisions = evaluateWakes({
					sessionId: sid,
					mailboxDir: opts.mailboxDir,
					stateDir: opts.stateDir,
					runsDir: opts.runsDir,
				});
				for (const d of decisions) {
					if (!d.fire) continue;
					try {
						const tabRunId = opts.spawn(d, sid);
						confirmWakeSpawn(d.workstreamId, tabRunId, {
							stateDir: opts.stateDir,
							mailboxDir: opts.mailboxDir,
							sessionId: sid!,
						});
					} catch (e) {
						auditWakeSpawnFailed(d.workstreamId, e instanceof Error ? e.message : String(e), {
							stateDir: opts.stateDir,
							sessionId: sid,
						});
					}
				}
			} catch {
				/* 唤醒循环永不破坏会话 */
			}
		}, opts.intervalMs ?? 30_000);
		interval.unref?.();
	});
	return () => {
		sessionGen++;
		if (interval) clearInterval(interval);
		interval = null;
	};
}
