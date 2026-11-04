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
 * ## 判据来源（多源交叉）
 *
 * 1. **scope-liveness 心跳**（`state/scope-liveness/<scopeKey>.json`，仅 owner 会话写）
 *    - 记录 `sessionId` + `pid` + `updatedAt`；找不到 ⇒ 回退 **session-owner**（见下）
 * 2. **进程表**（`probePidState`）：pid 不在 ⇒ 强证据。Windows 上 `kill(pid,0)` 抛 EPERM
 *    （进程在但无权限）⇒ enumerate 兜底（见 liveness.ts）。
 * 3. **session-owner 进程启动时间交叉验证**（`state/session-owner/`，项 1）：防 PID 复用。
 *
 * ## 2026-11-03 项 1 改判：心跳超龄不再单独判死（旧判据的真机误杀）
 *
 * 旧判定表把「pid 活 + 心跳超龄」判 dead（当 PID 复用）。真机证伪：scope-liveness
 * 只在 agent_start/agent_end 写 ⇒ **空闲会话心跳必然超龄**；local master pid 76520
 * 活着、会话文件仍在写，却被判 dead ⇒ 一条补投消息被错标 failed
 * （error=`pid-reused-or-hung(pid=76520,heartbeat-age=14.6min)`）。这是「活着被判死」。
 *
 * 现判据（死亡只能由下面两条支撑，**绝不用 lastActivityAt / 心跳单独判死**，
 * 同 trace-fusion/lane-facts 的纪律）：
 *   - pid 探活为 **dead**（最硬证据）；或
 *   - **PID 复用的强证据**：session-owner 记录的进程启动时间 vs OS 报告值不匹配（项 1）。
 * 心跳超龄降为弱信号：pid 活 + 心跳超龄 ⇒ **unknown**（不判死，不驱动有副作用的动作）；
 * pid unknown + 心跳超龄 ⇒ dead（查不到进程 + 久无心跳，两个独立源都指向没了）。
 *
 * ## session-owner 回退（项 1）
 *
 * `state/session-owner/<sessionId>.json`（全生命周期 session↔pid 记录，普通 TUI 会话也写）：
 * 无 scope 心跳记录时用它判：pid 死 ⇒ dead；pid 活 + 启动时间匹配 ⇒ alive；
 * 启动时间晚于记录+容差 ⇒ dead（PID 复用）。僵尸记录在读时懒删。
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

import { defaultRuntimeDir } from "./journal.ts";
import { probePidState, readScopeLiveness } from "./liveness.ts";
import { readAttachment } from "./registry.ts";
import { probeSessionOwner } from "./session-owner.ts";
import { defaultSessionsDir, findSessionFile } from "./transcript.ts";
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
	/** 进程启动时间探针（session-owner 回退路径用；测试可注入）。 */
	probeProcessStartedAt?: (pid: number) => string | undefined;
	/** transcripts 根（仅 `treatMissingTranscriptAsGone` 用；缺省 `PI_SESSIONS_DIR` 口径）。 */
	sessionsDirForTranscript?: string;
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
 * **按逻辑地址**（`agent://` / `pi://`）判会话存活 —— P-2 死信判据的生产探针。
 *
 * 为何需要这一层：`probeTargetSessionLiveness` 吃 **sessionId**，而信箱里的收件人是
 * **逻辑地址**（`letter.frame.to` = `agent://master_default` / `pi://<sessionId>`）。
 * 两者之间唯一权威映射是 registry 的 attachment（`agent://` → 当前代 sessionId）。
 *
 * 解析不到 ⇒ `unknown`（**不猜**）：`workstream://` / `task://` / `run://` 这类收件人
 * 不是会话，本探针不适用；`agent://` 无 attachment 説明该 local master 从未认领或已清。
 */
export function probeAddressLiveness(
	address: string,
	opts: TargetLivenessOptions & {
		resolveAgentSession?: (agent: string) => string | null;
		/**
		 * **可选强证据（缺省 OFF）**：无 scope 心跳记录 ∧ 目标会话 transcript 不存在 ⇒ 判 dead。
		 *
		 * 为何缺省关：单看「transcript 不在」不足以判死（会话目录可被归档/清理），
		 * 而 `session-liveness.ts` 的硬不变量是「缺证据 ≠ dead」。两者同时缺（agent 从未/已停止写心跳
		 * + pi 会话文件也已经不存在 + 信件超龄 72h）才是强组合。
		 * P-2 生产调用方显式传 true（见 `scripts/delivery-stale-dryrun.ts` 的对照口径）；
		 * 其它调用方（host `/v1/sessions`）保持原行为不变。
		 */
		treatMissingTranscriptAsGone?: boolean;
	} = {},
): TargetLivenessProbe {
	if (address.startsWith("pi://")) {
		const sid = address.slice("pi://".length);
		if (sid.length === 0) return { state: "unknown", basis: "empty-pi-session" };
		const base = probeTargetSessionLiveness(sid, opts);
		if (base.state !== "unknown" || opts.treatMissingTranscriptAsGone !== true) return base;
		// 只在「零证据」时补一手 transcript 存在性（不推翻任何已有结论）
		if (base.basis !== "no-scope-liveness-record") return base;
		try {
			const present = findSessionFile(opts.sessionsDirForTranscript ?? defaultSessionsDir(), sid) !== null;
			return present
				? { state: "unknown", basis: "no-liveness-but-transcript-present" }
				: { state: "dead", basis: "no-liveness+no-transcript" };
		} catch {
			return base; // 扫描异常 ⇒ 不判（不猜）
		}
	}
	if (address.startsWith("agent://")) {
		const resolve = opts.resolveAgentSession ?? ((agent: string) => readAttachment(agent as never)?.sessionId ?? null);
		let sid: string | null;
		try {
			sid = resolve(address);
		} catch {
			sid = null;
		}
		if (sid === null || sid.length === 0) {
			// 无 attachment = agent 从未认领。**不**据此判死：可能刚启动还没 attach。
			return { state: "unknown", basis: "no-registry-attachment" };
		}
		return probeAddressLiveness(`pi://${sid}`, opts);
	}
	return { state: "unknown", basis: `non-session-address(${address.split("://")[0]})` };
}

/**
 * 判定目标会话是否还活着。
 *
 * 返回 `alive` 需要**全部**证据支持；`dead` 需要至少一条强证据 + 无相反证据；
 * 其余一律 `unknown`（调用方据此跳过，不误杀）。
 *
 * 强证据只有两种（2026-11-03 项 1 改判后）：① pid 探活 dead；② PID 复用
 * （session-owner 启动时间不匹配 / pid unknown + 心跳超岭）。
 * 心跳超岭单独**不构成**死亡证据（scope 心跳只在 agent_start/end 写，空闲必超岭；
 * 真机 pid 76520 活着被旧判据错杀 ⇒ 降为弱信号，见文件头）。
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
		// 无 scope 心跳记录（普通 TUI 会话从不写 scope-liveness）⇒ 回退 session-owner（项 1）。
		// 两者都无 ⇒ 保持原 basis 字面量（probeAddressLiveness 的 transcript 兜底门
		// 按这个字符串识别「零证据」，不能改）。
		const owner = probeSessionOwner(sessionId, {
			stateDir,
			// 【2026-11-04 修，L4 审查 B1】deleteZombie: false —— **本调用点原来会删记录**。
			//
			// 事故链（L4 审查实测确认）：
			//   ① S2 探针（server.ts）传 deleteZombie:false ⇒ 不删，保留证据
			//   ② **本调用点没传** ⇒ 默认 true ⇒ B 判 dead 时**删掉 owner 记录**
			//   ③ S2 下次探针只看到 no-record ⇒ unknown ⇒ 永不拉起
			// ⇒ 能力断链原样重现（且只在「B 先扫过同一会话」时发生 ⇒ 难复现）。
			//
			// 目录卫生改由 `gcSessionOwners`（超龄 GC）承担 ⇒ 谁需要证据谁就不删。
			deleteZombie: false,
			...(opts.now !== undefined ? { now: opts.now } : {}),
			...(opts.probePid !== undefined ? { probePid: opts.probePid } : {}),
			...(opts.probeProcessStartedAt !== undefined ? { probeProcessStartedAt: opts.probeProcessStartedAt } : {}),
		});
		if (owner.basis === "no-record") {
			return { state: "unknown", basis: "no-scope-liveness-record" };
		}
		return { state: owner.state, basis: `session-owner:${owner.basis}` };
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
	// pid 活 + 心跳超龄            ⇒ **unknown**（2026-11-03 项 1 改判：弱信号不判死）
	// 旧判据把这当 PID 复用判 dead，真机把活着的 pid 76520 错杀（见文件头）。
	// 真正的 PID 复用检测改由 session-owner 的进程启动时间承担（无 scope 记录的会话
	// 走上面回退；有 scope 记录但无 owner 记录的旧会话：宁漏不枉，不猜）。
	if (pidState === "alive" && !heartbeatFresh) {
		const ageMin = Math.round((heartbeatAge / 60_000) * 10) / 10;
		return { state: "unknown", basis: `heartbeat-stale-weak-signal(pid=${rec.pid},heartbeat-age=${ageMin}min)` };
	}
	// pid unknown + 心跳超龄       ⇒ dead（进程查不到 + 久无心跳）
	if (pidState === "unknown" && !heartbeatFresh) {
		const ageMin = Math.round((heartbeatAge / 60_000) * 10) / 10;
		return { state: "dead", basis: `pid-unknown-heartbeat-stale(${ageMin}min)` };
	}
	// 其余（pid unknown + 心跳新鲜 / 心跳时间戳坏）⇒ unknown，不判
	return { state: "unknown", basis: `pid-${pidState}-heartbeat-${heartbeatFresh ? "fresh" : "unparsable"}` };
}
