/**
 * injection-gate.ts — 三路注入统一门（Phase 4d，A5 F2/F10/F15/F16）
 *
 * event-bus followUp / reports 监听器 / mailbox-consumer 在注入前一律过此门：
 *   - cutover 未启用或无 registry → {inject:true}（legacy 原行为，零变化）
 *   - 启用 + 有 registry：非 owner → suppress（记结构化审计，不注入不 claim）；
 *     owner → claimInjection 互斥（won → 注入；injected-already/claimed-by-other → 跳过）
 *   - 无 sessionId 时启用态 → 拒绝（默认拒绝，非默认放行，F15）
 *
 * postInject(ok)：成功 → confirmInjection；失败 → 留 claiming 给 stale 接管。
 * holder 统一形 `${path}:${sessionId}`，claim/confirm 两端同构。
 *
 * 抑制审计：runtime/suppressions.jsonl（append-only，F10：可审计、防重复制造）。
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { defaultRuntimeDir } from "./runtime/journal.ts";
import { masterAddress, type ObjectAddress } from "./runtime/address.ts";
import { readAttachment, readCutover } from "./runtime/registry.ts";
import { resolveRecipient } from "./runtime/resolver.ts";
import { claimInjection, confirmInjection } from "./runtime/receipts.ts";

export type InjectionPath = "legacy-eventbus" | "legacy-reports" | "mailbox-consumer";

export interface InjectionContext {
	key: string;
	sessionId: string | undefined;
	path: InjectionPath;
	/** 派发者唤醒（run 完成归派发者，不归 master owner）：跳过 owner 压制，但保留
	 *  claimInjection 互斥（exactly-once 不变）。仅 links recipient 即本会话的 run 完成路径置位。 */
	dispatcherWake?: boolean;
}

export type InjectionVerdict =
	| { inject: true; holder: string }
	| { inject: false; reason: "suppressed-not-owner" | "already-injected" | "claimed-by-other" | "no-session" };

function holderOf(ctx: InjectionContext): string {
	return `${ctx.path}:${ctx.sessionId}`;
}

/**
 * 注入前门。纯判定 + 原子 claim（claim 是唯一写操作；suppress 只写审计）。
 */
export function preInject(ctx: InjectionContext): InjectionVerdict {
	const cutover = readCutover();
	const attachment = readAttachment(masterAddress());
	// 未切换或无 registry → legacy 原行为
	if (!cutover?.enabled || !attachment) return { inject: true, holder: holderOf(ctx) };

	if (!ctx.sessionId) return { inject: false, reason: "no-session" };

	// 派发者唤醒不归 owner 管（run 完成属于派发者）：跳过 owner 压制，直接走互斥领取。
	// claimInjection 的 exactly-once 语义不变；审计仍可追踪 holder。
	if (ctx.dispatcherWake) {
		const claim = claimInjection(ctx.key, holderOf(ctx));
		if (claim.status === "claimed") return { inject: true, holder: holderOf(ctx) };
		if (claim.status === "injected-already") return { inject: false, reason: "already-injected" };
		return { inject: false, reason: "claimed-by-other" };
	}

	// owner 判定（新鲜快照；generation 前进视为易主）
	const fresh = resolveRecipient(masterAddress());
	if (!fresh || fresh.sessionId !== ctx.sessionId) {
		auditSuppression(ctx, "suppressed-not-owner", fresh);
		return { inject: false, reason: "suppressed-not-owner" };
	}

	const claim = claimInjection(ctx.key, holderOf(ctx));
	if (claim.status === "claimed") return { inject: true, holder: holderOf(ctx) };
	if (claim.status === "injected-already") return { inject: false, reason: "already-injected" };
	return { inject: false, reason: "claimed-by-other" };
}

/**
 * 注入后记。ok → confirm（写收据）；!ok → 留 claiming（stale 接管重试）。
 * 调用方必须只在真正调用 sendUserMessage 成功后传 true。
 */
export function postInject(ctx: InjectionContext, ok: boolean): void {
	if (!ok) return;
	try {
		confirmInjection(ctx.key, holderOf(ctx));
	} catch {
		/* best-effort：confirm 失败则收据缺失，at-least-once 重试可接受 */
	}
}

export interface SuppressionRecord {
	at: string;
	path: InjectionPath;
	key: string;
	reason: string;
	ownerSession?: string;
	ownerGeneration?: number;
	selfSession?: string;
}

function suppressionsPath(): string {
	return join(defaultRuntimeDir(), "suppressions.jsonl");
}

/** 结构化抑制审计（F10）。tolerant：审计写失败不影响调用方。 */
export function auditSuppression(
	ctx: InjectionContext,
	reason: SuppressionRecord["reason"],
	owner?: { sessionId: string; generation: number } | null,
	extra?: Record<string, unknown>,
): void {
	try {
		mkdirSync(defaultRuntimeDir(), { recursive: true });
		const record: SuppressionRecord & Record<string, unknown> = {
			at: new Date().toISOString(),
			path: ctx.path,
			key: ctx.key,
			reason,
			ownerSession: owner?.sessionId,
			ownerGeneration: owner?.generation,
			selfSession: ctx.sessionId,
			...extra,
		};
		appendFileSync(suppressionsPath(), `${JSON.stringify(record)}\n`, "utf8");
	} catch {
		/* 审计 best-effort */
	}
}

/** 供测试与命令使用：当前是否处于切换态（cutover 启用 + 有 owner）。 */
export function isCutoverActive(agent: ObjectAddress = masterAddress()): boolean {
	const cutover = readCutover();
	if (!cutover?.enabled) return false;
	return readAttachment(agent) !== null;
}
