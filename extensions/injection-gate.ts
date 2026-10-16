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

export type InjectionPath = "legacy-eventbus" | "legacy-reports" | "mailbox-consumer" | "steer-channel";

export interface InjectionContext {
	key: string;
	sessionId: string | undefined;
	path: InjectionPath;
	/** 派发者唤醒（run 完成归派发者，不归 master owner）：跳过 owner 压制，但保留
	 *  claimInjection 互斥（exactly-once 不变）。仅 links recipient 即本会话的 run 完成路径置位。 */
	dispatcherWake?: boolean;
	/** 接收逻辑地址（local master v1，S6）：owner 判定按此地址的 attachment；
	 *  缺省 = 全局 masterAddress()（消费端不传 → 行为与现状逐字节一致，零回归）。
	 *  语义：「消费端传谁的地址，就按谁的归属判」——scope 消费端传
	 *  agent://master_local_<scope> 时不读全局 attachment（Q1-F6 落点）。 */
	recipient?: ObjectAddress;
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
	const recipient = ctx.recipient ?? masterAddress();
	const cutover = readCutover();
	const attachment = readAttachment(recipient);
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

	// owner 判定（新鲜快照；generation 前进视为易主）：按 recipient 归属判（全局消费端缺省全局）
	const fresh = resolveRecipient(recipient);
	if (!fresh || fresh.sessionId !== ctx.sessionId) {
		// scope 侧 suppress 用 extra 带 recipient 区分（§5.4）；全局路径不传 recipient → 审计形状不变
		auditSuppression(ctx, "suppressed-not-owner", fresh, ctx.recipient ? { recipient: ctx.recipient } : undefined);
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

// ── L3 忙时冲突静默重试（注入发送结果分类）──────────────────────────

/**
 * 注入发送结果分类（L3 修复：await send 结果，busy 冲突不再逃逸到 bindCore）。
 *   - "sent"        发送成功（Promise resolve）→ 调用方走原 receipt 路径（postInject/confirm/ack）
 *   - "busy"        发送 reject 且含 "already processing"（agent 忙）→ 消息**未真正注入**；
 *                   调用方不得记 delivered、不得 selfDisable，应释放本次 claim 供下 tick 重试
 *   - "failed"      其余 reject / 同步 throw（真实失败）→ 调用方走原失败路径（可 selfDisable）
 *   - "no-injector" send 非函数（host 进程 / 测试桩未接注入通道）→ 调用方走原 no-injector 路径
 */
/**
 * C-3 可回滚开关：调用点是否采用**严格模式**（`undefined ⇒ unconfirmed`，delivered 改由 ACK 驱动）。
 *
 * `PI_DELIVERY_STRICT=0` ⇒ 回滚到旧的「返回值当 sent」行为（兼容窗口用，**会重新引入 P3 假阳性**）。
 * 缺省启用：因为生产 `pi.sendUserMessage` 恒返回 `undefined`（两级 delegate 都不 return），
 * 旧行为等于「无条件认为成功」—— 那不是有效证据，只是承重的假阳性（见 P3 探针）。
 */
export function deliveryStrictEnabled(): boolean {
	return process.env.PI_DELIVERY_STRICT !== "0";
}

export type InjectionSendStatus = "sent" | "busy" | "failed" | "no-injector" | "unconfirmed";

/**
 * 判定 send 的返回值是否**可信的已发送**证明。
 *
 * ## 为何需要这个判定（P3，已由异 provider 独立复算）
 * 本机 Pi 的 `pi.sendUserMessage` **不是**底层方法，而是 `bindCore` 包装：
 * `dist/core/agent-session.js:2644-2652` 的 wrapper
 * ```js
 * sendUserMessage: (content, options) => {
 *   this.sendUserMessage(content, options).catch((err) => { runner.emitError({...}); });
 * }   // ← 不 return 底层 Promise
 * ```
 * **底层 reject 时 wrapper 同步返回 `undefined`**（错误只进 emitError）⇒ 调用方看到的
 * 是「无 rejection」，极易被误记成成功。底层确实会 reject（`agent-session.js:1485` busy、
 * `:1468` compaction；对照：替换上下文交真 Promise `:3479`；类型声明 `agent-session.d.ts:569`
 * 写明 `Promise<void>`）。
 *
 * ## 反面证据（防过度修，同样采纳）
 * **不是所有 reject 都等于没发出去**：streaming 且 `deliverAs:"followUp"` 会入队后正常
 * 返回（`agent-session.js:1489-1494`，且 `:1804` 说明 `streamingBehavior = options.deliverAs`）。
 * 故本函数**不**把「任何非 Promise 返回值」一律判死；只在**返回值既不是 Promise 也不是
 * 非空确证**时降级为 `unconfirmed`（诚实降级，咨询 §6.3.5）。
 *
 * 语义：`undefined`/`null` ⇒ **unconfirmed**（既不能证明发出、也不能证明失败）。
 * 调用方 **不得**将 unconfirmed 当 sent/receipt（这正是 P3 的最小修法 ②）。
 */
export function classifySendReturn(value: unknown): "confirmed" | "unconfirmed" {
	if (value === undefined || value === null) return "unconfirmed";
	if (typeof (value as { then?: unknown }).then === "function") return "confirmed"; // 真 Promise ⇒ 由 then/catch 决定
	return "confirmed"; // 其他非空返回值（如 {ok:true}）：视为同步确证
}

/**
 * 静默发送一条 followUp 注入并 await 其结果（L3 修复核心）。
 *
 * 根因：`pi.sendUserMessage` 运行时是 async（返回 Promise，类型却标 void），旧调用点用**同步**
 * try/catch 包着——busy 时的 rejection 逃过 try/catch，落到 bindCore 的包装器（agent-session.js
 * `sendUserMessage(...).catch(err => emitError({ extensionPath: "<runtime>", ... }))`），被统一报成
 * `Extension "<runtime>" error: Agent is already processing a prompt…`（<runtime> 是硬编码标签，
 * 并非某个扩展名）。本函数 await send 结果并把异常**分类吞掉**（永不 reject），调用方即可据此
 * 决定 receipt 时机与 claim 释放。
 *
 * 用法约束（调用方多为同步函数）：
 *   - 用 `.then` 链衔接 receipt，**不要**把整条消费链改 async（防竞态面扩大）；
 *   - **receipt 只在 "sent" 之后**："busy" 不得 postInject/confirm/ack（未真正注入，不得伪造终态）；
 *   - 同步 throw（send 同步抛）与异步 reject（Promise reject）都被 `.catch` 捕获并分类。
 *
 * @param send  注入实现（生产接 pi.sendUserMessage，测试传 fake；undefined = 无注入通道）。
 *              形参用 `unknown` 兼容「类型 void / 运行时 Promise」的 sendUserMessage。
 * @param body  注入正文（字符串）。
 * @param opts  `strict`（**P3，opt-in**）：`true` 时把「无可信确证」（wrapper 返回
 *              `undefined` —— 本机 pi 的两级 delegate 都不 return，见 `classifySendReturn`）
 *              降级为 `unconfirmed` 而不是 `sent`。
 *
 *              为何默认 `false`（**如实声明，不是偷懒**）：本机 pi 生产链恒返回 `undefined`
 *              ⇒ 开严格模式后 **`sent` 分支永不发生**，所有既有调用点会从「已确认」变成
 *              「未确认」⇒ 交付不再 confirm/ack（大面积重投）。
 *              咨询 §6.3.5 的正解正是「最小诚实降级 = attempted-unconfirmed → failed_delivery；
 *              需宿主适配后再开放自动接续保证」—— 但那需要同步改动 4 个调用点语义，
 *              属重大行为变更，**待裁决后单独落地**。当前先提供可测的能力与回归，不静默改现状。
 */
export function injectFollowUpQuietly(
	send: ((body: string, opts?: { deliverAs?: string }) => unknown) | undefined,
	body: string,
	opts: { strict?: boolean } = {},
): Promise<InjectionSendStatus> {
	if (typeof send !== "function") return Promise.resolve("no-injector");
	// ⚠ 实现要点：**不能**写 `.then(() => send(...)).then((ret) => …)` —— 链式 then 会
	// **自动展平** send 返回的 Promise，`ret` 拿到的是 resolve 后的值（普通情况就是
	// `undefined`），就无法区分「wrapper 未 return」与「真 Promise resolve」。
	// 因此必须先在回调内**捕获原始返回值**，再决定是否 await。
	let raw: unknown;
	try {
		raw = send(body, { deliverAs: "followUp" });
	} catch (e) {
		return Promise.resolve(classifyThrown(e));
	}
	// P3（strict）：wrapper 不 return 底层 Promise ⇒ 底层 reject 时我们只看到 `undefined`，
	// 与成功形态无法区分 ⇒ 这类「无 rejection 也无确证」**不得**记 sent。
	if (opts.strict === true && classifySendReturn(raw) === "unconfirmed") return Promise.resolve("unconfirmed");
	return Promise.resolve(raw)
		.then((): InjectionSendStatus => "sent")
		.catch((e: unknown): InjectionSendStatus => classifyThrown(e));
}

/** 异常分类（busy 与 failed 的判定口径，两处共用）。 */
function classifyThrown(e: unknown): InjectionSendStatus {
	const msg = e instanceof Error ? e.message : String(e);
	return /already processing/i.test(msg) ? "busy" : "failed";
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
