/**
 * `runtime/outbox-injection-recovery.ts` — D3 的**决策层**（A 类死锁的有界自愈）
 *
 * ## A 类死锁是什么（真机 `0a9a85cc`，2026-11-10）
 *
 * ```
 * outbox 项 pending ↓
 *   桥 claimInjection → claimed → 注入 sendUserMessage
 *     → 生产形态恒 undefined ⇒ status=unconfirmed
 *     → confirmInjection 写 injected 收据（2026-11-02 防双投修复要求）
 *   下一 tick: claimInjection 直接短路成 injected-already ⇒ 只记 received ⇒ 永不 delivered
 * ```
 * 而**正文实际没进会话**（`grep [evt:0a9a85cc]` 在 user 消息里 = 0）⇒ `consumed` ACK 永不产生
 * ⇒ 项永久 pending，每次重投撞同一堵墙。收据挡住的不是「已送达」，而是「再试一次」。
 *
 * ## 为什么必须有界（这条比「能不能修」更重要）
 *
 * D3 如果放开重投而**不限次数**，就会变成死循环：
 * ```
 * 放行 → 注入 → unconfirmed（无 turn 可附着，还是会失败）→ confirm → injected-already
 *      → 反查 absent → 再放行 → ……
 * ```
 * 每 10s tick 一次，等于把「静默永停」换成「每 10s 撞墙」。**这比原缺陷更糟**：
 * journal 会被灌满，且真正的根因（注入层无起 turn 能力）被噪声淹没。
 *
 * ⇒ 本模块的判据里**次数上限是第一位的**，反查只是「放行前的证据前提」。
 *
 * ## 三条判据（缺一不可，各有各的理由）
 *
 * | 判据 | 值 | 为什么需要 |
 * |---|---|---|
 * | 反查结论 | `absent`（且非截断） | `found` ⇒ 其实进了，**不得**重投（2026-11-02 双投的形状）；`inconclusive` ⇒ 没证据 |
 * | 已注入未确认次数 | `< 2`（即只剩 1 次额度） | 上限 1 次额外尝试后必须停手（见上） |
 * | 距上次注入的时长 | `>= 60s` | 会话 JSONL 可能还没 flush ⇒ 立刻反查会把「刚写进内存」读成 `absent`（假阴性） |
 *
 * ## 「收据让路」的实现选择：**隔离重命名，不删除**
 *
 * D1 的做法是给收据加状态；D2 是取消收据。D3 两者都不做 —— 但「放行一次」必须让
 * `claimInjection` 的 `hasNotificationReceipt` 返回 false，所以收据**不能留在原路径**。
 *
 * 选择**重命名到 `<key>.d3-quarantined.<ts>.json`**而不是 `unlink`：
 *   - 收据内容仍在盘上 ⇒ 可审计「这条曾被认为已注入、后来被判没进」；
 *   - 重命名是原子操作，不需要新状态机；
 *   - 若重投成功，`confirmInjection` 会在**原路径**写新收据 ⇒ 语义自然恢复。
 *
 * ⚠ **代价（必须登记）**：原路径空出来之后，`claimInjection` 会重新 `claimed` ——
 * 也就是说这**确实**打破了「收据 = 不可撤销事实」。D3 的正当性完全建立在
 * 「反查有证据表明它没进」之上；`inconclusive` 一律不放行就是为此。
 */

import { renameSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DeliveryAttempt } from "../delivery-ledger.ts";
import type { MarkerProbeResult } from "./transcript-marker-probe.ts";

/** D3 允许的**额外**注入次数（1 = 只放行一次；达到上限后一律不放行）。 */
export const D3_MAX_EXTRA_INJECTIONS = 1;

/** 距上次注入的最小间隔：低于它不反查/不放行（会话 JSONL 可能尚未 flush）。 */
export const D3_MIN_ATTEMPT_AGE_MS = 60_000;

export type RecoveryAction = "keep" | "release";

export interface RecoveryDecision {
	action: RecoveryAction;
	/**
	 * 机器可读理由（进 journal/trace，也用于测试断言）。
	 *   - `probe-skipped`         调用方没做反查（“没查”不是证据）
	 *   - `probe-found`           反查命中 ⇒ 已进会话，不重投
	 *   - `probe-inconclusive`    没有证据（文件缺失/截断）⇒ 不重投
	 *   - `attempts-exhausted`    已达额外次数上限 ⇒ 不重投
	 *   - `attempt-too-fresh`    上次注入太近，等 flush
	 *   - `no-prior-attempt`      找不到注入记录（不猜，保持现状）
	 *   - `absent-evidenced`      证据齐全 ⇒ **放行一次**
	 */
	reason:
		| "probe-skipped"
		| "probe-found"
		| "probe-inconclusive"
		| "attempts-exhausted"
		| "attempt-too-fresh"
		| "no-prior-attempt"
		| "absent-evidenced";
	/** 已注入未确认次数（诊断） */
	unconfirmedAttempts: number;
	/** 距最近一次注入的毫秒数（诊断；无记录 ⇒ null） */
	msSinceLastAttempt: number | null;
}

/**
 * 纯决策（无 IO）。判据顺序即优先级：**先看反查，再看次数，最后看年龄**。
 *
 * `probe === null` 表示**调用方没做反查**（因为次数/年龄已注定不放行，省 IO）。
 * 这时永远不得 `release` —— 「没查」不是「查了没有」的证据（R-20 三态纪律）。
 *
 * 注意 `attempts` 只应包含**已注入但未确认**的那些（调用方过滤），本函数不做过滤，
 * 以免两处口径漂移 —— 过滤规则写在调用点的注释里。
 */
export function decideInjectionRecovery(opts: {
	probe: MarkerProbeResult | null;
	attempts: Pick<DeliveryAttempt, "at">[];
	now: number;
}): RecoveryDecision {
	const { probe, attempts, now } = opts;
	const unconfirmedAttempts = attempts.length;

	// ① 反查优先：**没查** / 命中 / 无证据 都不放行
	//
	// `probe === null` 是「调用方根本没做反查」⇒ “没查” 不是 “查了没有” 的证据。
	// 若此处除帰到下面几条判据（次数够 / 年龄够），就会在“零证据”的情况下 release
	// ⇒ “不确定就重发” —— 那正是 2026-11-02 双投事故的形状（R-5 的取舍不能被偷换）。
	if (probe === null) {
		return { action: "keep", reason: "probe-skipped", unconfirmedAttempts, msSinceLastAttempt: null };
	}
	if (probe.verdict === "found") {
		return { action: "keep", reason: "probe-found", unconfirmedAttempts, msSinceLastAttempt: null };
	}
	if (probe.verdict !== "absent") {
		return { action: "keep", reason: "probe-inconclusive", unconfirmedAttempts, msSinceLastAttempt: null };
	}

	// ② 次数上限（先于年龄判定：已达上限就不必再看时间）
	// 允许放行的唯一形状是「恰好 1 次已注入未确认」—— 那 1 次就是被判「没进」的那次。
	// 已有 2 次（原 1 次 + 已放行过的 1 次）⇒ 到此为止；0 次 ⇒ 根本没走过这条路径
	// （没有「注入了却没进」的记录，说明修的不是这个病）。
	if (unconfirmedAttempts >= D3_MAX_EXTRA_INJECTIONS + 1) {
		return { action: "keep", reason: "attempts-exhausted", unconfirmedAttempts, msSinceLastAttempt: null };
	}
	if (unconfirmedAttempts === 0) {
		return { action: "keep", reason: "no-prior-attempt", unconfirmedAttempts, msSinceLastAttempt: null };
	}

	// ③ 冷却：等会话 JSONL flush
	const lastAt = attempts[0]?.at !== undefined ? Date.parse(String(attempts[0].at)) : Number.NaN;
	const msSince = Number.isFinite(lastAt) ? Math.max(0, now - lastAt) : null;
	if (msSince === null || msSince < D3_MIN_ATTEMPT_AGE_MS) {
		return { action: "keep", reason: "attempt-too-fresh", unconfirmedAttempts, msSinceLastAttempt: msSince };
	}

	return { action: "release", reason: "absent-evidenced", unconfirmedAttempts, msSinceLastAttempt: msSince };
}

/** 收据隔离后缀（`<key>.d3-quarantined.<ts>.json`）。 */
export function quarantinedReceiptPath(receiptPath: string, ts: string): string {
	return receiptPath.replace(/\.json$/, `.d3-quarantined.${ts.replace(/[^0-9A-Za-z]/g, "")}.json`);
}

/**
 * 把 injected 收据**改名**（不让路 = 不删；见模块头「隔离重命名」）。
 *
 * 调用方传入**原路径**。返回是否真的让路了；不存在 ⇒ false（幂等，不需报错）。
 * never-throw：改名失败（EBUSY/权限）⇒ false ⇒ 调用方保持现状（不重投）。
 */
export function quarantineReceipt(receiptPath: string, now: number): boolean {
	try {
		if (!existsSync(receiptPath)) return false;
		const ts = new Date(now).toISOString();
		const to = quarantinedReceiptPath(receiptPath, ts);
		renameSync(receiptPath, to);
		return true;
	} catch {
		return false;
	}
}

/** 便捷：给定 receipts 根与 receipt-key，拼出原路径（与 `receipts.ts` 的 sanitize 口径一致）。 */
export function receiptPathFor(receiptsDir: string, key: string): string {
	return join(receiptsDir, `${key.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

/** 便于调用方按 holder 判断是否本进程写的收据（诊断用，不参与判定）。 */
export function readReceiptBy(receiptPath: string): string | null {
	try {
		const raw = JSON.parse(readFileSync(receiptPath, "utf8")) as { by?: unknown };
		return typeof raw.by === "string" ? raw.by : null;
	} catch {
		return null;
	}
}
