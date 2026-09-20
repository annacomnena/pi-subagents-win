/**
 * runtime/consumer-scan.ts — 扫描式影子消费端（Phase 4c，附记 A4 F8）
 *
 * 只读 mailbox + resolver + fencing 判定，输出 would-deliver 报告。
 * 硬约束：绝不调用 claimLetters / ackLetter / recordNotificationReceipt，
 * 不写 mailbox 任何字节——backlog 零污染（terra F8）。
 *
 * 判定链（per pending letter）：
 *   unattached（无 attachment：legacy 拥有）→ not-owner（非 attached 会话）
 *   → generation-moved（扫描中 generation 前进，TOCTOU 防线）
 *   → already-notified（统一收据已存在，F5）
 *   → would-deliver（followUp-inject / execute-command）
 *
 * 无收据键的信（非 run subject / 无 status）：按 at-least-once 宁可投递
 * （would-deliver + note），幂等由消费端兜底（§27 纪律）。
 */

import { listLetters, type Letter } from "./mailbox.ts";
import { resolveRecipient, type RecipientSnapshot } from "./resolver.ts";
import { hasNotificationReceipt, runReceiptKey } from "./receipts.ts";
import { masterAddress, type ObjectAddress } from "./address.ts";

export type SkipReason = "unattached" | "not-owner" | "generation-moved" | "already-notified";

export interface WouldDeliver {
	messageId: string;
	frameKind: string;
	subject?: string;
	summary: string;
	action: "followUp-inject" | "execute-command";
	receiptKey?: string;
	note?: string;
}

export interface ScanDecision {
	/** 信标识（messageId 或 fallback 文件名语义——只读报告用） */
	messageId: string;
	deliver: boolean;
	reason?: SkipReason;
	would?: WouldDeliver;
}

export interface MailboxScanReport {
	recipient: ObjectAddress;
	owner: RecipientSnapshot | null;
	decisions: ScanDecision[];
	generatedAt: string;
}

export interface ScanOptions {
	recipient?: ObjectAddress;
	/** 调用方会话身份（显式传入，不读 pi ctx——纯函数可测） */
	sessionId: string;
	mailboxDir?: string;
}

/**
 * 所有权门判定（纯函数，单测直测）：scan 起点快照 vs 新鲜快照 vs 自身。
 */
export function decideOwnership(
	scanStart: RecipientSnapshot | null,
	fresh: RecipientSnapshot | null,
	selfSessionId: string,
): { ok: true; owner: RecipientSnapshot } | { ok: false; reason: Exclude<SkipReason, "already-notified"> } {
	if (!scanStart) return { ok: false, reason: "unattached" };
	if (scanStart.sessionId !== selfSessionId) return { ok: false, reason: "not-owner" };
	if (!fresh || fresh.sessionId !== scanStart.sessionId || fresh.generation !== scanStart.generation) {
		return { ok: false, reason: "generation-moved" };
	}
	return { ok: true, owner: scanStart };
}

/** 扫描并判定（只读）。 */
export function scanMailboxForDelivery(opts: ScanOptions): MailboxScanReport {
	const recipient = opts.recipient ?? masterAddress();
	const scanStart = resolveRecipient(recipient);
	const pending = listLetters(recipient, "pending", opts.mailboxDir);
	const fresh = resolveRecipient(recipient);
	const gate = decideOwnership(scanStart, fresh, opts.sessionId);

	const decisions: ScanDecision[] = pending.map((letter) => {
		if (!gate.ok) {
			return { messageId: describeLetter(letter), deliver: false, reason: gate.reason };
		}
		if (letter.frame.frame === "command") {
			return {
				messageId: describeLetter(letter),
				deliver: true,
				would: {
					messageId: describeLetter(letter),
					frameKind: `command:${letter.frame.type}`,
					summary: `command ${letter.frame.type} key=${letter.frame.commandKey}`,
					action: "execute-command",
				},
			};
		}
		// message 帧
		const subject = letter.frame.subject;
		const details = letter.frame.body.details as { status?: string; tabRunId?: string } | undefined;
		const receiptKey = deriveReceiptKey(letter);
		if (receiptKey && hasNotificationReceipt(receiptKey)) {
			return { messageId: describeLetter(letter), deliver: false, reason: "already-notified" };
		}
		return {
			messageId: describeLetter(letter),
			deliver: true,
			would: {
				messageId: describeLetter(letter),
				frameKind: letter.frame.kind,
				subject,
				summary: letter.frame.body.summary,
				action: "followUp-inject",
				receiptKey,
				note: receiptKey ? undefined : "no-dedupe-key",
			},
		};
	});

	return { recipient, owner: scanStart, decisions, generatedAt: new Date().toISOString() };
}

/** 信标识：frame.id（message）或 commandKey（command，无 id 概念）。 */
function describeLetter(letter: Letter): string {
	if (letter.frame.frame === "message") return letter.frame.id;
	return `cmd:${letter.frame.commandKey}`;
}

/** run subject + details.status → 标准收据键；派生不出返回 undefined。 */
function deriveReceiptKey(letter: Letter): string | undefined {
	if (letter.frame.frame !== "message") return undefined;
	const subject = letter.frame.subject;
	const details = letter.frame.body.details as { status?: string; tabRunId?: string } | undefined;
	if (!subject || !subject.startsWith("run://tab/") || !details?.status) return undefined;
	const tabRunId = subject.slice("run://tab/".length);
	return runReceiptKey(tabRunId, details.status);
}
