/**
 * runtime/session-owner.ts — 全生命周期 session↔pid 记录（项 1，2026-11-03）。
 *
 * ## 为什么需要这个模块（真机事故）
 *
 * `state/scope-liveness/<scope>.json` 只有 local master owner 会写（`session-hooks.ts`
 * 的身份门 `if (!att || att.sessionId !== sid) return;`），普通 TUI 会话**零写**
 * ⇒ `probeTargetSessionLiveness`（outbox-target-liveness.ts）对它们恒 `unknown`
 * ⇒ B 通道（目标死 ⇒ 快速 failed）与 S2（目标死 ⇒ 拉起）同时失效。
 *
 * 而且 scope-liveness 只在 `agent_start`/`agent_end` 写 ⇒ 即使 owner，
 * **空闲期心跳必然超龄** ⇒ 真机会发生「pid 活着、会话文件仍在写，但被 B 判 dead」。
 *
 * ## 三条不变量（逐条对应一个失败模式）
 *
 * 1. **全生命周期**：`session_start` 写、`session_shutdown` 删 ⇒ 与忙闲无关，空闲也在。
 * 2. **pid 身份 = pid + 进程启动时间**：只看 pid 会被 PID 复用骗（2026-10-20 wechat worker
 *    事故：pid 7016 死后被 Windows 复用给 "Memory Compression"）。
 * 3. **never-throw + 僵尸懒删**：写失败只是丢一条 gauge；pid 已死的记录在**读**时删掉。
 *
 * ## 判死纪律（与 lane-facts / staleLeaseVerdict 同型）
 *
 * 死亡判据**只能是 pid 探活 ∨ 启动时间不匹配（PID 复用）**，绝不用
 * `lastActivityAt` / `updatedAt` 年龄判死（同 `trace-fusion/lane-facts.ts` 的理由：
 * 一次长工具调用期间不写 state，实测有正常工作的 tab 因活动时间冻结 61min 被误判僵尸）。
 * 本模块的 `updatedAt` 只是写入时刻的记录（新鲜度诊断用），不参与判定。
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { probePidState } from "./liveness.ts";

/** 记录版本（坏版本 → 容忍读 null）。 */
const VERSION = 1;

/**
 * 启动时间容差：OS 报的启动时间比记录晚于这个数 ⇒ PID 复用（判 dead）。
 *
 * 为什么不是 0：记录侧 `startedAt` 是估算值（`Date.now() - uptime*1000`，见
 * liveness.ts::processStartedAt），与 OS 报告值天然有秒级偏差；实测会话注册到
 * session_start 钩子执行还有启动开销 ⇒ 留 60s。反向（OS 更早）不判 —— 复用的 pid
 * 对应的进程必然比原进程**晚**启动，早于记录只可能是估算偏差，判死没有依据。
 */
export const SESSION_OWNER_START_TOLERANCE_MS = 60_000;

export interface SessionOwnerRecord {
	version: typeof VERSION;
	sessionId: string;
	pid: number;
	/** 进程启动时刻估算（ISO；pid 复用防御）。 */
	startedAt?: string;
	/** 本记录写入时刻（ISO；仅诊断用，**不参与判死**）。 */
	updatedAt: string;
}

export interface SessionOwnerWriteInput {
	sessionId: string;
	pid: number;
	startedAt?: string;
	stateDir: string;
	now?: Date;
}

/** 记录目录：`<stateDir>/session-owner/<sessionId>.json`（一文件一会话，删 = unlink）。 */
export function sessionOwnerDir(stateDir: string): string {
	return join(stateDir, "session-owner");
}

export function sessionOwnerPath(sessionId: string, stateDir: string): string {
	// sessionId 来自 pi 会话 JSONL 的 id（UUID 形状）；防御性替换路径分隔符
	const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
	return join(sessionOwnerDir(stateDir), `${safe}.json`);
}

/**
 * 容忍读：缺失 / 坏 JSON / 坏版本 / 缺 `sessionId` / 缺 `pid` / 缺 `updatedAt` → null
 * （同 `liveness.ts::readScopeLiveness` 惯例）。**不删文件**（读是无副作用面，删在 probe）。
 */
export function readSessionOwner(sessionId: string, stateDir: string): SessionOwnerRecord | null {
	try {
		const raw = JSON.parse(readFileSync(sessionOwnerPath(sessionId, stateDir), "utf8")) as SessionOwnerRecord;
		if (
			raw?.version !== VERSION ||
			typeof raw.sessionId !== "string" ||
			typeof raw.pid !== "number" ||
			!Number.isInteger(raw.pid) ||
			raw.pid <= 0 ||
			typeof raw.updatedAt !== "string"
		) {
			return null;
		}
		if (raw.startedAt !== undefined && typeof raw.startedAt !== "string") return null;
		return raw;
	} catch {
		return null;
	}
}

/**
 * `session_start` 等价动作：写（覆盖）本会话的 owner 记录。never-throw，失败返回 false。
 * 原子写：tmp + rename（不留 .tmp 残留，同 writeScopeLiveness 惯例）。
 */
export function writeSessionOwner(input: SessionOwnerWriteInput): boolean {
	try {
		const path = sessionOwnerPath(input.sessionId, input.stateDir);
		mkdirSync(sessionOwnerDir(input.stateDir), { recursive: true });
		const record: SessionOwnerRecord = {
			version: VERSION,
			sessionId: input.sessionId,
			pid: input.pid,
			...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
			updatedAt: (input.now ?? new Date()).toISOString(),
		};
		const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
		renameSync(tmp, path);
		return true;
	} catch {
		return false; // never-throw：丢一条 gauge 不打断主流程
	}
}

/**
 * `session_shutdown` 等价动作：删记录。幂等（再删返回 false）、never-throw。
 */
export function deleteSessionOwner(sessionId: string, stateDir: string): boolean {
	try {
		const path = sessionOwnerPath(sessionId, stateDir);
		if (!existsSync(path)) return false;
		rmSync(path);
		return true;
	} catch {
		return false;
	}
}

/** Windows：OS 报告的进程启动时间（ISO）。查询不可用 → undefined（不猜）。 */
function winProcessStartedAt(pid: number): string | undefined {
	// Get-Process -Id 需要的权限与 process.kill 同级（不需要 admin）；
	// ToString('o') 给带时区偏移的 ISO，Date.parse 可直接比。
	const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
		`(Get-Process -Id ${pid}).StartTime.ToString('o')`], {
		timeout: 15_000, // 同 winPidEnumerated 的放宽口径（本机高负载时 tasklist 实测 >2s）
		windowsHide: true,
		encoding: "utf8",
	});
	if (r.error || typeof r.stdout !== "string") return undefined;
	const m = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.exec(r.stdout);
	if (m === null) return undefined; // 进程不在 / 输出形状不对 ⇒ 查询不可用
	return r.stdout.trim();
}

export interface SessionOwnerProbeOptions {
	stateDir: string;
	now?: Date;
	/** pid 探针（缺省 `liveness.ts::probePidState` 三态；测试注入）。 */
	probePid?: (pid: number) => { state: "alive" | "dead" | "unknown"; basis: string };
	/** 进程启动时间探针（缺省 Windows PowerShell；测试注入）。 */
	probeProcessStartedAt?: (pid: number) => string | undefined;
	/** 容差覆盖（测试注入）。 */
	startToleranceMs?: number;
}

export interface SessionOwnerProbeResult {
	state: "alive" | "dead" | "unknown";
	/** 判定依据（可诊断，含 pid / 复用 / 不可用等要素）。 */
	basis: string;
	/** 原记录（无记录 ⇒ undefined；结论要能带回「谁的记录被判了」）。 */
	record?: SessionOwnerRecord;
}

/**
 * 判定会话 owner 进程是否还在（P-1/B 通道的 session 级判据面）。
 *
 * 判定表（never-throw；探针异常 ⇒ unknown 不猜）：
 *   无记录                          ⇒ unknown(no-record)（可能从未写/已 shutdown，**不猜**）
 *   pid dead                        ⇒ dead + **懒删**僵尸记录（否则目录无限增长）
 *   pid alive + 启动时间晚于记录+容差 ⇒ dead(pid-reused)：那个号已是别的进程
 *   pid alive + 启动时间匹配/更早     ⇒ alive
 *   pid alive + 启动时间查询不可用    ⇒ alive + basis 标注 start-time-unavailable（不猜）
 *   pid unknown / 探针抛异常          ⇒ unknown（探不到 ≠ 已死）
 */
export function probeSessionOwner(sessionId: string, opts: SessionOwnerProbeOptions): SessionOwnerProbeResult {
	const record = readSessionOwner(sessionId, opts.stateDir);
	if (record === null) return { state: "unknown", basis: "no-record" };

	let pidState: "alive" | "dead" | "unknown";
	let pidBasis: string;
	try {
		const p = (opts.probePid ?? ((pid: number) => probePidState(pid)))(record.pid);
		pidState = p.state;
		pidBasis = p.basis;
	} catch {
		// 探针异常不得删记录（S7）：那可能只是一次查询失败
		return { state: "unknown", basis: `probe-threw(pid=${record.pid})`, record };
	}

	if (pidState === "dead") {
		deleteSessionOwner(sessionId, opts.stateDir); // 僵尸懒删（不变量 3）
		return { state: "dead", basis: `pid-dead(pid=${record.pid},${pidBasis})`, record };
	}
	if (pidState === "unknown") {
		return { state: "unknown", basis: `pid-unknown(pid=${record.pid},${pidBasis})`, record };
	}

	// pid alive ⇒ 用启动时间做身份交叉验证（不变量 2：防 PID 复用）
	if (record.startedAt === undefined) {
		return { state: "alive", basis: `pid-alive(pid=${record.pid},${pidBasis}) start-time-unavailable(no-recorded-start)`, record };
	}
	let osStart: string | undefined;
	try {
		osStart = (opts.probeProcessStartedAt ?? winProcessStartedAt)(record.pid);
	} catch {
		osStart = undefined;
	}
	if (osStart === undefined) {
		return { state: "alive", basis: `pid-alive(pid=${record.pid},${pidBasis}) start-time-unavailable`, record };
	}
	const os = Date.parse(osStart);
	const rec = Date.parse(record.startedAt);
	const tol = opts.startToleranceMs ?? SESSION_OWNER_START_TOLERANCE_MS;
	if (Number.isFinite(os) && Number.isFinite(rec) && os > rec + tol) {
		deleteSessionOwner(sessionId, opts.stateDir); // 复用的号 ⇒ 记录已无意义
		return { state: "dead", basis: `pid-reused(pid=${record.pid},os-start=${osStart},recorded=${record.startedAt})`, record };
	}
	return { state: "alive", basis: `pid-alive(pid=${record.pid},${pidBasis}) start-time-match`, record };
}
