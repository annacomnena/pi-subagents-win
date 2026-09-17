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

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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

// ── 注入互斥（F14，附记 A5：跨路径注入 mutex）──────────────────────

export type InjectionClaimStatus = "claimed" | "injected-already" | "claimed-by-other";

export interface InjectionClaimResult {
	status: InjectionClaimStatus;
	/** 当前 claiming 持有者（claimed-by-other 时由谁占着；claimed 时是自己） */
	by?: string;
	/** stale 接管（at-least-once 重试语义） */
	tookOver?: boolean;
}

function claimingPath(key: string): string {
	return join(receiptsDir(), `${key.replace(/[^A-Za-z0-9._-]/g, "_")}.claiming.json`);
}

/**
 * 声明注入权：wx first-wins；已 injected → injected-already；被占 → claimed-by-other；
 * 占位超 staleAfterMs（缺省 10min，同 mailbox 纪律）→ 接管（tookOver，at-least-once 重试）。
 * 三路注入（event-bus / reports / mailbox）在此互斥：同时查空不可能同时注入。
 */
export function claimInjection(key: string, by: string, staleAfterMs = 10 * 60 * 1000): InjectionClaimResult {
	if (!key || /\s/.test(key) || !by) return { status: "claimed-by-other" };
	mkdirSync(receiptsDir(), { recursive: true });
	if (hasNotificationReceipt(key)) return { status: "injected-already" };
	const path = claimingPath(key);
	const content = JSON.stringify({ key, by, claimedAt: new Date().toISOString() });
	try {
		writeFileSync(path, content, { flag: "wx", encoding: "utf8" });
		return { status: "claimed", by };
	} catch {
		try {
			const existing = JSON.parse(readFileSync(path, "utf8")) as { by?: string; claimedAt?: string };
			const age = Date.now() - Date.parse(existing.claimedAt ?? "");
			if (Number.isFinite(age) && age > staleAfterMs) {
				writeFileSync(path, content, "utf8"); // stale 接管（有意覆盖）
				return { status: "claimed", by, tookOver: true };
			}
			return { status: "claimed-by-other", by: existing.by };
		} catch {
			return { status: "claimed-by-other" };
		}
	}
}

/**
 * 确认注入完成：仅 claiming 持有者可确认（by 必须一致，防他人冒确认）；
 * 成功写 injected 收据并删 claiming。返回 false 时调用方不得 ack（4d 顺序保证 F16）。
 */
export function confirmInjection(key: string, by: string): boolean {
	if (!key || !by) return false;
	const path = claimingPath(key);
	try {
		const existing = JSON.parse(readFileSync(path, "utf8")) as { by?: string };
		if (existing.by !== by) return false;
	} catch {
		return false;
	}
	if (!recordNotificationReceipt(key, by)) return false;
	try {
		unlinkSync(path);
	} catch {
		/* claiming 残留无害（stale 后可接管；injected 已存在则 claim 直接短路） */
	}
	return true;
}
