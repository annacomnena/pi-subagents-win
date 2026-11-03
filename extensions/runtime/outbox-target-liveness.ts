/**
 * outbox-target-liveness.ts — 「目标会话是否还活着」的生产探针（B 修复的判定面）。
 *
 * ## 为什么需要这个
 *
 * 真机事故（2026-11-03）：3 条 GUI 消息卡 pending 10 小时，界面只显示「已提交等待注入」。
 * 目标会话 01a18af1 的进程 00:22 就没了，但 outbox 毫无感知：
 * - 消费者 `registerOutboxBridge` 挂在目标会话的 `session_start` ⇒ 会话死了就没人取
 * - `OUTBOX_PENDING_TTL_MS` 是 24 小时 ⇒ 要等一整天才会扫成 expired
 *
 * 中间的 10 小时是**静默**的。这个模块给 `sweepTargetDeadOutboxItems` 提供判据。
 *
 * ## 判据来源（三源并用，任一不足都不单独下结论）
 *
 * 1. **scope-liveness 心跳**（`state/scope-liveness/<scopeKey>.json`）
 *    - 记录 `sessionId` + `pid` + `updatedAt`
 *    - 先按 sessionId 找到对应 scope 记录
 * 2. **进程表**（`probePidState`）
 *    - pid 不在了 ⇒ 强证据
 *    - Windows 上 `kill(pid,0)` 会抛 EPERM（进程在但无权限）⇒ 需要 enumerate 兜底
 * 3. **心跳新鲜度**（`updatedAt`）
 *    - 心跳超龄（缺省 10 分钟）即使是活的进程也应视为「不再为本会话服务」
 *
 * 三源都要指向「死了」才返回 dead。任一为 unknown ⇒ 整体 unknown（不判，宁漏不枉）。
 *
 * ## 为什么不能只看进程
 *
 * PID 复用。实测事故（2026-10-20）：wechat worker pid 7016 死后被 Windows 立刻复用给
 * "Memory Compression" ⇒ 存活检查恒 true。所以「pid 活着」不能证明「我的进程活着」。
 * 这里用心跳新鲜度作为交叉验证：pid 活着但心跳停在很久以前 ⇒ 那个 pid 已经不是它了。
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

import { defaultRuntimeDir } from "./journal.ts";
import { probePidState, readScopeLiveness } from "./liveness.ts";
import type { TargetLivenessProbe } from "./message-outbox.ts";

/** 心跳超过这么久没更新 ⇒ 视为该会话已不再服务（缺省 10 分钟）。 */
export const TARGET_HEARTBEAT_STALE_MS = 10 * 60 * 1000;

export interface TargetLivenessOptions {
	stateDir?: string;
	now?: Date;
	/** 心跳超龄阈值（测试可注入）。 */
	heartbeatStaleMs?: number;
	/** 进程探针（测试可注入；缺省走 probePidState）。 */
	probePid?: (pid: number) => { state: "alive" | "dead" | "unknown"; basis: string };
}

/** 在一个 scope-liveness 目录里找 sessionId 对应的记录（可能有多代，取最新）。 */
function findScopeRecord(
	stateDir: string,
	sessionId: string,
): { scopeKey: string; pid: number; updatedAt: string } | null {
	const dir = join(stateDir, "scope-liveness");
	let files: string[];
	try {
		files = readdirSync(dir);
	} catch {
		return null;
	}
	let best: { scopeKey: string; pid: number; updatedAt: string } | null = null;
	for (const f of files) {
		if (!f.endsWith(".json")) continue;
		const scopeKey = f.slice(0, -".json".length);
		const rec = readScopeLiveness(scopeKey, stateDir);
		if (rec === null || rec.sessionId !== sessionId) continue;
		if (best === null || Date.parse(rec.updatedAt) > Date.parse(best.updatedAt)) {
			best = { scopeKey, pid: rec.pid, updatedAt: rec.updatedAt };
		}
	}
	return best;
}

/**
 * 判定目标会话是否还活着。
 *
 * 返回 `alive` 需要**全部**证据支持；`dead` 需要至少一条强证据 + 无相反证据；
 * 其余一律 `unknown`（调用方据此跳过，不误杀）。
 */
export function probeTargetSessionLiveness(
	sessionId: string,
	opts: TargetLivenessOptions = {},
): TargetLivenessProbe {
	const stateDir = opts.stateDir ?? join(defaultRuntimeDir(), "state");
	const now = opts.now ?? new Date();
	const staleMs = opts.heartbeatStaleMs ?? TARGET_HEARTBEAT_STALE_MS;

	const rec = findScopeRecord(stateDir, sessionId);
	if (rec === null) {
		// 没有心跳记录 —— 两种可能：从没写过（旧版本/子 agent），或已被清理。
		// 都不足以判定死亡（会话可能刚启动还没写第一拍）。
		return { state: "unknown", basis: "no-scope-liveness-record" };
	}

	const heartbeatAge = now.getTime() - Date.parse(rec.updatedAt);
	const heartbeatFresh = Number.isFinite(heartbeatAge) && heartbeatAge >= 0 && heartbeatAge < staleMs;

	let pidState: "alive" | "dead" | "unknown";
	let pidBasis: string;
	try {
		const probe = opts.probePid ?? ((p: number) => probePidState(p));
		const r = probe(rec.pid);
		pidState = r.state;
		pidBasis = r.basis;
	} catch {
		pidState = "unknown";
		pidBasis = "probe-threw";
	}

	// ── 判定表 ──
	// pid 死                      ⇒ dead（最硬证据；心跳再新也没用）
	if (pidState === "dead") {
		return { state: "dead", basis: `pid-dead(${rec.pid},${pidBasis})` };
	}
	// pid 活 + 心跳新鲜            ⇒ alive
	if (pidState === "alive" && heartbeatFresh) {
		return { state: "alive", basis: `pid-alive-heartbeat-fresh(${rec.pid})` };
	}
	// pid 活 + 心跳超龄            ⇒ dead（PID 复用：那个号已经不是它了）
	if (pidState === "alive" && !heartbeatFresh) {
		const ageMin = Math.round((heartbeatAge / 60_000) * 10) / 10;
		return { state: "dead", basis: `pid-reused-or-hung(pid=${rec.pid},heartbeat-age=${ageMin}min)` };
	}
	// pid unknown + 心跳超龄       ⇒ dead（进程查不到 + 久无心跳）
	if (pidState === "unknown" && !heartbeatFresh) {
		const ageMin = Math.round((heartbeatAge / 60_000) * 10) / 10;
		return { state: "dead", basis: `pid-unknown-heartbeat-stale(${ageMin}min)` };
	}
	// 其余（pid unknown + 心跳新鲜 / 心跳时间戳坏）⇒ unknown，不判
	return { state: "unknown", basis: `pid-${pidState}-heartbeat-${heartbeatFresh ? "fresh" : "unparsable"}` };
}
