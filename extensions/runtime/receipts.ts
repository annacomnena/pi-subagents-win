/**
 * runtime/receipts.ts — 统一语义通知收据（Phase 4a，附记 A4 F5）
 *
 * 问题（terra 缺陷 #3）：event-bus 用 runId.notified、reports 用 reportId.notified、
 * mailbox 用 messageId/dedupe 文件名——三套命名空间，跨通道去重无统一键。
 * mailbox 消费端接入后，"同一 tab 终态已唤醒过"必须三路可查，否则漏注入或重复注入。
 *
 * 解：runtime/receipts/<receipt-key>.json（wx 原子创建，first-wins）。
 * 收据键约定：`run-<tabRunId>-<terminalStatus>`（与 mailbox dedupeId 同形，
 * 三处天然对齐）。加法门：各通道原 .notified/ack 机制不动（失败模式 E），
 * 注入前先查收据（有 → 跳过），注入后补写收据（best-effort，不阻塞）。
 *
 * 纯库、无接线。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultRuntimeDir } from "./journal.ts";

function receiptsDir(): string {
	return join(defaultRuntimeDir(), "receipts");
}

function receiptPath(key: string): string {
	return join(receiptsDir(), `${key.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

/** tab 终态的标准收据键（mailbox dedupeId 同形）。 */
export function runReceiptKey(tabRunId: string, status: string): string {
	return `run-${tabRunId}-${status}`;
}

/**
 * 记录收据：首个记录者返回 true；已存在返回 false（幂等，不覆盖）。
 * wx 排他创建 = 跨进程 first-wins。
 */
export function recordNotificationReceipt(key: string, by?: string): boolean {
	if (!key || /\s/.test(key)) return false;
	mkdirSync(receiptsDir(), { recursive: true });
	try {
		writeFileSync(
			receiptPath(key),
			JSON.stringify({ key, recordedAt: new Date().toISOString(), by: by ?? "unknown" }),
			{ flag: "wx", encoding: "utf8" },
		);
		return true;
	} catch {
		return false;
	}
}

/** 查询收据是否存在（tolerant）。 */
export function hasNotificationReceipt(key: string): boolean {
	try {
		const raw = JSON.parse(readFileSync(receiptPath(key), "utf8")) as { key?: string };
		return raw.key === key;
	} catch {
		return false;
	}
}
