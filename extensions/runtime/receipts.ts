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
 * 声明注入权：wx first-wins；已 injected → injected-already；被占（新鲜，含同 holder）→
 * claimed-by-other；占位超 staleAfterMs（缺省 10min，同 mailbox 纪律）→ CAS 接管
 * （tookOver，at-least-once 重试）。
 *
 * L4 返修（plans/0922_g6p2_review.md 必修 1）：stale 接管不再是「读-覆盖写」——旧实现两个
 * 竞争者可读到同一过期 claim、双双无条件覆盖并各自返回 claimed（双注入）。改 unlink 门控
 * CAS：unlink 是每代文件的唯一线性化点（恰一个成功 unlink），wx 竞败者重读重判；接管前
 * 瞬时重读收窄 TOCTOU。残余 µs 级窗口（重读后、unlink 前他人恰好接管）由诚实 at-least-once
 * + 目标端 dedupe（outboxId 稳定身份，见 outbox-bridge.ts）兜底——本函数只保证「重试收敛、
 * 不永久双主」，不再声称 exactly-once。
 * 同 holder 新鲜 claim 不自取回：claim→confirm 全程互斥是 injection-gate「同 key 双链互斥」
 * 契约（_test_runtime_cutover §4）；崩溃自愈统一走 stale 接管，不开同 holder 捷径。
 * 三路注入（event-bus / reports / mailbox）在此互斥：同时查空不可能同时注入。
 */
export function claimInjection(key: string, by: string, staleAfterMs = 10 * 60 * 1000): InjectionClaimResult {
	if (!key || /\s/.test(key) || !by) return { status: "claimed-by-other" };
	mkdirSync(receiptsDir(), { recursive: true });
	if (hasNotificationReceipt(key)) return { status: "injected-already" };
	const path = claimingPath(key);
	let tookOver = false;
	for (let attempt = 0; attempt < 4; attempt++) {
		try {
			writeFileSync(path, JSON.stringify({ key, by, claimedAt: new Date().toISOString() }), { flag: "wx", encoding: "utf8" });
			return tookOver ? { status: "claimed", by, tookOver: true } : { status: "claimed", by };
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") return { status: "claimed-by-other" };
		}
		// wx 竞败：单次读现状重判（by + claimedAt 同源；读失败 → 文件恰被删/重建，回 wx 重试）
		let existingBy: string | undefined;
		let fresh: boolean;
		try {
			const existing = JSON.parse(readFileSync(path, "utf8")) as { by?: string; claimedAt?: string };
			existingBy = existing.by;
			const age = Date.now() - Date.parse(existing.claimedAt ?? "");
			fresh = Number.isFinite(age) && age <= staleAfterMs;
		} catch {
			continue;
		}
		if (hasNotificationReceipt(key)) return { status: "injected-already" };
		// 新鲜（含同 holder）→ 让位（同 key 双链互斥契约，_test_runtime_cutover §4）
		if (fresh) return { status: "claimed-by-other", by: existingBy };
		// stale → 接管；unlink 前瞬时重读收窄 TOCTOU（他人刚接管 → 其 claimedAt 新鲜 → 放弃）
		try {
			const re = JSON.parse(readFileSync(path, "utf8")) as { by?: string; claimedAt?: string };
			const reAge = Date.now() - Date.parse(re.claimedAt ?? "");
			if (Number.isFinite(reAge) && reAge <= staleAfterMs) return { status: "claimed-by-other", by: re.by };
		} catch {
			continue; // 恰被删 → 回 wx 重试
		}
		try {
			unlinkSync(path);
			tookOver = true; // 接管成功（本代唯一）：wx 重建后带 tookOver 回传（at-least-once 重试语义）
		} catch {
			continue; // ENOENT：他人接管中 → 重读重判
		}
		// unlink 成功 = 本代唯一接管者；回 wx 重建（EEXIST = 全新 claimant 抢先 → 下一轮重判）
	}
	return { status: "claimed-by-other" };
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

/**
 * 释放注入互斥占位（best-effort，L3 忙时冲突静默重试）：仅 holder 一致时删 `<key>.claiming.json`。
 *
 * send 被 busy 拒绝（agent 忙，消息**未真正注入**）时，调用方**不得** confirm（写 injected
 * 收据 = 伪造终态）；应释放本次 claim 供下 tick 重新领取并重试（下 tick = 10s 轮询，而非
 * 10min stale 接管）。
 *
 * at-least-once 收敛语义：最坏情形是「释放与投递竞态」——目标其实已收到（释放稍迟）→ 重投
 * 会重复一条消息，由目标端按稳定身份（outboxId / runId / messageId）幂等去重兜底，可接受。
 * 本函数只保证「释放后可被重新领取」，不保证 exactly-once。
 *
 * best-effort：文件不存在、holder 已变或 IO 错误均不抛——占位若残留，10min
 * stale 接管（claimInjection）终会收敛，不丢消息。
 */
export function releaseInjectionClaim(key: string, by: string): void {
	if (!key || /\s/.test(key) || !by) return;
	const path = claimingPath(key);
	try {
		const existing = JSON.parse(readFileSync(path, "utf8")) as { by?: string };
		if (existing.by !== by) return;
		unlinkSync(path);
	} catch {
		/* best-effort：ENOENT、已接管或其他 IO 错误静默容忍 */
	}
}
