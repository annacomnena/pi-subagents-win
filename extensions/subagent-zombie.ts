/**
 * subagent-zombie.ts — 僵尸 run 看门狗（失败必达终态：宿主侧兜底）。
 *
 * ## 为什么需要它（真实事故）
 *
 * 2026-10-15：**6 个 run 挂在 `running` 而 pid 早已死亡（idle 9h+）** ⇒ 上游会话死等
 * **100 分钟**，最后由主会话手工 `kill` 才解开。根因：`running` 状态**没有任何超时/僵尸出口** ——
 * `async-result-watcher` 只处理**已进终态**的 run（`status ∈ {completed,failed,cancelled}`），
 * 所以死进程产生的 `running` 记录**不在任何人的视野内**。
 *
 * ## 设计口径（来自独立计划审查 must-fix，见 plans/20261015_subagent_failure_plan_review.md）
 *
 * - **M1/M3（最重要）**：不能靠「字段缺失」判死。审查实测确认：`subagent-kill.ts` 的
 *   `markKilled()` 会 `delete pid/pidRecordedAt/pidCmdMarker` 并刷新 `lastActivity` ⇒
 *   **事后 json 的 pid 缺失不代表当时缺失**。故判定**以活进程证据为主**：
 *     ① pid 存在 + `isPidAlive` 为假           → 硬证据（进程确实没了）
 *     ② pid 存在 + 身份不匹配（pid 被重用）      → 硬证据（原进程已死）
 *     ③ pid 缺失 + `lastActivity` 超龄          → **弱证据 ⇒ 默认只观察（写 suspect 标记 + 审计），
 *                                                  不落终态**（除非显式开启 auto）
 * - **M2**：幂等不靠 read-check-write，靠**文件系统排他创建**（`wx` flag）做跨进程 CAS。
 * - **M8**：不阻塞 UI 读路径；`inspectLiveProcess` 走 PowerShell（单次可阻塞 ~20s）
 *   ⇒ **只在「pid 存在且 signal-0 判活为真」时才调用**（需要身份确认的少见分支）。
 * - **纪律**：本模块**只落终态，绝不杀进程**（进程已死才判 zombie）。
 *
 * ## 默认行为：观察模式（保守）
 *
 * `PI_SUBAGENT_ZOMBIE_AUTO !== "1"` 时，弱证据（③）**只写 `.zombie-suspect` 标记**，
 * 不改变 run 状态；硬证据（①②）**总是**落终态（因为那是确定的死亡）。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_RUNS_DIR, isPidAlive, inspectLiveProcess, type KillableRunRecord } from "./subagent-kill.ts";

// ── 阈值（可 env 覆盖，便于测试与线上调参）──────────────────────────

/** 最小年龄：小于此值不判定（避免与「刚 spawn、pid 尚未落盘」竞争）。 */
export function zombieMinAgeMs(): number {
	return intEnv("PI_SUBAGENT_ZOMBIE_MIN_AGE_MS", 120_000);
}
/** 有 pid 分支的空闲阈值（其实由 isPidAlive 直接证据主导，此项只作二次保守）。 */
export function zombieIdleMs(): number {
	return intEnv("PI_SUBAGENT_ZOMBIE_IDLE_MS", 120_000);
}
/**
 * **无 pid 分支**的弱证据阈值。审查 M3 指出「无 pid + 年龄」不能证明死亡 ⇒
 * 取一个**远大于**正常任务耗时、且默认仅观察的值（2h）。
 */
export function zombieNoPidIdleMs(): number {
	return intEnv("PI_SUBAGENT_ZOMBIE_NO_PID_IDLE_MS", 2 * 60 * 60 * 1000);
}
/** 是否允许弱证据自动落终态（默认 **关** = 观察模式）。 */
export function zombieAutoEnabled(): boolean {
	return process.env.PI_SUBAGENT_ZOMBIE_AUTO === "1";
}

function intEnv(name: string, dflt: number): number {
	const raw = process.env[name];
	if (!raw) return dflt;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : dflt;
}

// ── 判定（纯函数，可测）────────────────────────────────────────────

export type ZombieReason =
	| "pid-dead"          // 硬证据：登记的 pid 不存活
	| "pid-reused"        // 硬证据：pid 存活但身份不匹配（原进程已死，pid 被 OS 重用）
	| "no-pid-idle"       // 弱证据：无 pid 且 lastActivity 超龄（默认仅观察）
	| "alive"             // 未判：进程证据显示还活着
	| "too-young"         // 未判：年龄不足
	| "no-time-basis"     // 未判：无 startedAt 也无 pidRecordedAt（无法算年龄）
	| "already-terminal"  // 未判：已是终态
	| "not-running";      // 未判：非 running

export interface ZombieVerdict {
	/** 是否判定为僵尸（应落终态）。 */
	zombie: boolean;
	/** 弱证据（需 auto 开关才落终态；否则只记 suspect）。 */
	weak: boolean;
	reason: ZombieReason;
	/** 判定所依据的时间基准（epoch ms），用于审计。 */
	basisMs?: number;
}

/** 依赖注入（测试可替换，避免真查进程）。 */
export interface ZombieDeps {
	now?: () => number;
	isPidAlive?: (pid: number) => boolean;
	inspectLiveProcess?: (pid: number) => { pid: number; startedAtMs?: number; cmd?: string } | null;
	/**
	 * 跳过 `inspectLiveProcess`（PowerShell，单次可阻塞 ~20s）——**周期 tick 路径专用**。
	 *
	 * 理由（审查 M8）：tick 是同步 setInterval 回调，在事件循环里跑 20s 的 PowerShell 不可接受。
	 * 跳过只损失「pid-reused」这一罕见情况的检测（此时 isPidAlive 为真 ⇒ 我们不判 ⇒ **保守不误杀**），
	 * on-read 惰性路径（用户主动查询）不跳，仍能抓到它。
	 */
	skipInspect?: boolean;
}

/** 解析时间基准：优先 pidRecordedAt，其次 startedAt；都没有 ⇒ undefined。 */
function timeBasis(rec: KillableRunRecord): number | undefined {
	for (const k of ["pidRecordedAt", "startedAt"] as const) {
		const v = rec[k];
		if (typeof v === "string") {
			const ms = Date.parse(v);
			if (Number.isFinite(ms)) return ms;
		}
	}
	return undefined;
}

function lastActivityMs(rec: KillableRunRecord): number | undefined {
	const v = rec.lastActivity;
	if (typeof v !== "string") return undefined;
	const ms = Date.parse(v);
	return Number.isFinite(ms) ? ms : undefined;
}

/**
 * 判定单个 run 是否僵尸。**纯函数**（除 deps 注入口），不做任何 IO 副作用。
 *
 * 判定顺序（保守优先）：终态 → 年龄 → 进程证据 → 弱证据。
 */
export function detectZombie(rec: KillableRunRecord, deps: ZombieDeps = {}): ZombieVerdict {
	const now = deps.now?.() ?? Date.now();
	const alive = deps.isPidAlive ?? isPidAlive;
	const inspect = deps.inspectLiveProcess ?? inspectLiveProcess;

	if (rec.status !== "running") return { zombie: false, weak: false, reason: "not-running" };

	// 已是终态（result 已带终态 status）⇒ 不覆盖
	const rStatus = (rec.result as { status?: string } | undefined)?.status;
	if (rStatus === "completed" || rStatus === "failed" || rStatus === "cancelled") {
		return { zombie: false, weak: false, reason: "already-terminal" };
	}

	const basis = timeBasis(rec);
	if (basis === undefined) return { zombie: false, weak: false, reason: "no-time-basis" };
	if (now - basis < zombieMinAgeMs()) {
		return { zombie: false, weak: false, reason: "too-young", basisMs: basis };
	}

	const pid = rec.pid;
	if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) {
		const idleBase = lastActivityMs(rec) ?? basis;
		if (now - idleBase < zombieIdleMs()) {
			// 有 pid 但还在活动窗口内：先按「可能还活着」处理，不查进程（省 PowerShell 开销）
			return { zombie: false, weak: false, reason: "alive", basisMs: idleBase };
		}
		// 硬证据 ①：signal-0 判死
		if (!alive(pid)) return { zombie: true, weak: false, reason: "pid-dead", basisMs: idleBase };
		// 硬证据 ②：pid 活着但身份不匹配（OS 重用了该 pid）——仅在需要时查（PowerShell 慢）
		// tick 路径 skipInspect ⇒ 跳过（保守：不判、不误杀；on-read 路径仍会抳）
		const live = deps.skipInspect ? null : inspect(pid);
		if (live !== null && typeof live.startedAtMs === "number") {
			const recMs = Date.parse(String(rec.pidRecordedAt ?? ""));
			// 登记容差窗口（与 subagent-kill 同量级：前 5min / 后 3min）
			if (Number.isFinite(recMs)) {
				const drift = live.startedAtMs - recMs;
				if (drift < -300_000 || drift > 180_000) {
					return { zombie: true, weak: false, reason: "pid-reused", basisMs: recMs };
				}
			}
		}
		return { zombie: false, weak: false, reason: "alive", basisMs: idleBase };
	}

	// 弱证据（无 pid）：审查 M1/M3 ⇒ 默认只观察
	const idleBase = lastActivityMs(rec) ?? basis;
	if (now - idleBase >= zombieNoPidIdleMs()) {
		return { zombie: zombieAutoEnabled(), weak: true, reason: "no-pid-idle", basisMs: idleBase };
	}
	return { zombie: false, weak: false, reason: "too-young", basisMs: idleBase };
}

// ── 原子写 + 跨进程 CAS ────────────────────────────────────────────

/**
 * 原子写 run json（tmp + rename，同分区 rename 是原子的）。
 *
 * 审查 M2 指出：`subagent-kill.ts` 的 `writeRecord` 是**直接 writeFileSync**（非原子）⇒
 * 并发读方可能读到半截文件。本函数用于**终态落盘**这类「不能读坏」的写。
 */
export function writeRecordAtomic(runsDir: string, id: string, rec: unknown): void {
	if (!existsSync(runsDir)) mkdirSync(runsDir, { recursive: true });
	const finalPath = join(runsDir, `${id}.json`);
	const tmp = join(runsDir, `.${id}.tmp-${process.pid}-${Date.now()}`);
	writeFileSync(tmp, JSON.stringify(rec));
	renameSync(tmp, finalPath);
}

/** 锁身份指纹：每次接管生成唯一 token，用于「移走的是不是我看到的那枚锁」核对。 */
function mintToken(): string {
	return `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 测试专用 seam（**唯一用途**：确定性复现「两个接管者同时判定僵锁」这个窄竞态窗口）。
 * 生产代码永不设置它。这是必要的：实测证明「顺序调用」与「多进程撞窗口」都无法稳定复现
 * 该竞态（TTL 会挡住顺序第二次；撞窗口概率过低），故只能显式注入。
 */
let __claimReapTestHook: (() => void) | undefined;
/** 仅供测试：设置在「判定僵锁」与「实际接管」之间执行的钩子。 */
export function __setClaimReapTestHook(h: (() => void) | undefined): void {
	__claimReapTestHook = h;
}

/** CAS 锁的 TTL：赢家若在写终态前崩溃，超此龄的锁被视为僵锁（可被接管），避免永久卡死。 */
export function reapLockTtlMs(): number {
	return intEnv("PI_SUBAGENT_ZOMBIE_LOCK_TTL_MS", 5 * 60 * 1000);
}

/**
 * 跨进程「恰好一次」CAS：用 `.reaped` 文件的**排他创建**（`wx`）判定归属。
 *
 * 审查 M2 明确：read-check-write 与普通 rename **都不是 CAS**。本函数用
 * `writeFileSync(..., {flag:"wx"})` —— OS 保证同时只有一个调用者能创建成功。
 *
 * **僵锁接管（L4 P1-3）**：赢家可能在「拿到锁 → 写终态」之间崩溃，使 `.reaped` 永久存在
 * 而 run 永远不被回收。故锁带 TTL：若已存在的锁龄 > TTL 且 run 仍非终态，则可接管
 * （删锁重建）。这保留了「恰好一次」在正常路径的保证，又避免单点永久卡死。
 *
 * @returns true=本进程赢得 CAS（应继续落终态）；false=已被别人处理（应短路）
 */
export function claimReap(
	runsDir: string,
	id: string,
	meta: { reason: ZombieReason; pid?: number; at: string },
	opts: { now?: () => number } = {},
): boolean {
	if (!existsSync(runsDir)) mkdirSync(runsDir, { recursive: true });
	const lockPath = join(runsDir, `${id}.reaped`);
	try {
		writeFileSync(lockPath, JSON.stringify({ ...meta, token: mintToken() }), { flag: "wx" });
		return true;
	} catch (e) {
		if ((e as { code?: string }).code !== "EEXIST") throw e;
	}
	// 已存在：判定是否为僵锁（赢家崩溃）
	try {
		const rawLock = readFileSync(lockPath, "utf8");
		const raw = JSON.parse(rawLock) as { at?: string; token?: string };
		const atMs = Date.parse(String(raw.at ?? ""));
		// 与 detectZombie 同一时钟源（可注入，便于测试与控制）
		const nowMs = opts.now?.() ?? Date.now();
		const age = Number.isFinite(atMs) ? nowMs - atMs : Number.POSITIVE_INFINITY;
		if (age < reapLockTtlMs()) return false; // 别人的活锁 ⇒ 正常短路
		// 测试 seam（仅用于确定性验证「僵锁接管」的原子性）：
		// 在「认定是僵锁」之后、「实际接管」之前调用。测试借此模拟**另一个接管者
		// 恰好在此刻插入**（这是旧实现 rmSync+wx 产生双赢家的真实窗口）。
		// 同时它也暴露了「原子 rename」的漏洞：A 移走的可能是 B 刚建的新锁。
		__claimReapTestHook?.();
		// 僵锁接管（L4 二轮 + 自测 Z18 修正：**必须带身份校验的原子接管**）
		//
		// 演进史（三步，每步都被一个真实测试推翻过）：
		//  1. `rmSync(lock) + writeFileSync(lock, wx)` —— 两步之间 B 可删 A 刚建的新锁 ⇒ 双赢家。
		//  2. 仅靠 `renameSync(lock, graveyard)` 视为原子 —— **仍双赢家**：
		//     时序：A 读锁（僵） → 【B 移走僵锁、建新锁】 → A 的 rename 移走的是 **B 的新锁**
		//     （路径存在就成功）⇒ A 也认为自己赢了。Z18（seam 注入）确定复现了这个缺陷。
		//  3. 本实现：rename **之后再核对**自己移走的那枚锁的 **token** 是否等于最初读到的那枚。
		//     不等 ⇒ 自己移走的是别人的新锁 ⇒ 把锁**原子放回**（rename 回去）并认输。
		//     这才能真正保证「恰好一个赢家」。
		const observedToken = typeof raw.token === "string" ? raw.token : undefined;
		const graveyard = join(runsDir, `.${id}.reaped.stale-${process.pid}-${nowMs}`);
		try {
			renameSync(lockPath, graveyard); // 原子：源不存在则 ENOENT
		} catch {
			return false; // 别人先移走了 ⇒ 认输
		}
		// 身份核对：确认坟墓里的是「我读到的那枚锁」
		try {
			const moved = JSON.parse(readFileSync(graveyard, "utf8")) as { token?: string };
			const movedToken = typeof moved.token === "string" ? moved.token : undefined;
			if (observedToken !== movedToken) {
				// 不等 ⇒ 我移走的是别人的（更新的）锁 ⇒ 放回并认输（不双赢、不破坏别人的锁）
				// 注：用 `!==` 而非「双方都定义才比」——旧锁/测试造的锁可能**无 token**（undefined），
				// 此时若按「都定义才比」会跳过核对 ⇒ 双赢家（Z18 实测暴露）。
				try { renameSync(graveyard, lockPath); } catch { /* 放回失败：best-effort，仍认输 */ }
				return false;
			}
		} catch {
			// 坟墓不可读：无法证明归属 ⇒ 保守认输（放回）
			try { renameSync(graveyard, lockPath); } catch { /* ignore */ }
			return false;
		}
		try {
			writeFileSync(lockPath, JSON.stringify({ ...meta, tookOver: true, token: mintToken() }), { flag: "wx" });
		} catch {
			return false; // 别人已重建 ⇒ 认输
		}
		// 清掉坟墓（best-effort；已是自己的锁）
		try { rmSync(graveyard, { force: true }); } catch { /* ignore */ }
		return true;
	} catch {
		return false; // 锁文件不可读/竞态失败 ⇒ 保守不接管（宁可不判）
	}
}

/** 读 run json（容错：解析失败返回 null）。 */
export function readRunRecord(runsDir: string, id: string): KillableRunRecord | null {
	const f = join(runsDir, `${id}.json`);
	if (!existsSync(f)) return null;
	try {
		return JSON.parse(readFileSync(f, "utf8")) as KillableRunRecord;
	} catch {
		return null;
	}
}

export interface ReapResult {
	/** 是否由本次调用落了终态。 */
	reaped: boolean;
	/** 未落终态时的原因（便于审计/测试断言）。 */
	reason: ZombieReason | "already-reaped" | "not-found" | "observe-only";
	/** 是否写了观察标记（弱证据 + 观察模式）。 */
	suspect?: boolean;
}

/**
 * 幂等落终态：僵尸 run ⇒ `status="failed"` + `failure{kind:"zombie",…}` + `endedAt`。
 *
 * 幂等保证（两道）：
 *  ① **CAS**：`claimReap()` 排他创建 `.reaped`（跨进程恰好一次）；
 *  ② **状态短路**：落终态前重读，若已非 `running` 则放弃（防「迟到旧 finalize」被覆盖）。
 *
 * 纪律：**不杀进程**（调用方已在 detectZombie 拿到「进程已死」证据时才走此路）。
 */
export function reapZombie(
	runsDir: string,
	id: string,
	opts: { deps?: ZombieDeps; now?: () => number } = {},
): ReapResult {
	const now = opts.now?.() ?? Date.now();
	const rec = readRunRecord(runsDir, id);
	if (!rec) return { reaped: false, reason: "not-found" };

	const verdict = detectZombie(rec, { now: () => now, ...(opts.deps ?? {}) });
	if (!verdict.zombie) {
		// 弱证据 + 观察模式 ⇒ 只写标记，不改状态
		if (verdict.weak) {
			try {
				if (!existsSync(join(runsDir, `${id}.zombie-suspect`))) {
					writeFileSync(
						join(runsDir, `${id}.zombie-suspect`),
						JSON.stringify({ reason: verdict.reason, at: new Date(now).toISOString() }),
						{ flag: "wx" },
					);
				}
			} catch { /* 观察标记失败不影响主流程 */ }
			return { reaped: false, reason: "observe-only", suspect: true };
		}
		return { reaped: false, reason: verdict.reason };
	}

	// CAS：跨进程恰好一次
	const at = new Date(now).toISOString();
	if (!claimReap(runsDir, id, { reason: verdict.reason, pid: rec.pid, at }, { now: () => now })) {
		return { reaped: false, reason: "already-reaped" };
	}

	// 迟到旧 finalize 防护（L4 修正：不只查顶层 status，还要查 result.status）：
	// 真完成可能只写在 result 上（而顶层仍是 running）——此时不得覆盖。
	const fresh = readRunRecord(runsDir, id);
	if (!fresh || fresh.status !== "running") {
		return { reaped: false, reason: "already-terminal" };
	}
	const freshResultStatus = (fresh.result as { status?: string } | undefined)?.status;
	if (freshResultStatus === "completed" || freshResultStatus === "failed" || freshResultStatus === "cancelled") {
		return { reaped: false, reason: "already-terminal" };
	}

	const next: KillableRunRecord = {
		...fresh,
		status: "failed",
		endedAt: at,
		zombieReapedAt: at,
		failure: {
			kind: "zombie",
			provider: undefined,
			model: (fresh as { model?: string }).model,
			httpStatus: null,
			message:
				verdict.reason === "no-pid-idle"
					? `watchdog: pid 缺失且 ${Math.round(zombieNoPidIdleMs() / 60000)}min 无活动（弱证据）`
					: verdict.reason === "pid-reused"
						? "watchdog: 登记 pid 已被 OS 重用（原进程已退出）"
						: "watchdog: 登记 pid 不存活（进程已退出）",
			at,
			source: "watchdog",
		},
	};
	// 保留既有 result 形状（若有），否则補一个失败的（供既有消费方读取）
	if (!next.result) {
		next.result = {
			status: "failed",
			text: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
			usageEvents: [],
			runId: id,
			error: `[subagent-failure kind=ZOMBIE reason=${verdict.reason}] ${(next.failure as { message: string }).message}`,
			agent: fresh.agent,
		};
	}

	writeRecordAtomic(runsDir, id, next);
	return { reaped: true, reason: verdict.reason };
}

/**
 * 扫描并清理僵尸（on-read 惰性与周期 tick 共用）。
 *
 * 审查 M8：调大列表时不做无界扫描——`limit` 限制单轮处理量（默认 50）。
 * 仅处理 `*.json`（实测 runs 目录 654 文件中只有 54 个 JSON）。
 */
export function reapZombiesInDir(
	runsDir: string = DEFAULT_RUNS_DIR,
	opts: { deps?: ZombieDeps; now?: () => number; limit?: number; runIds?: string[] } = {},
): { scanned: number; reaped: string[]; observed: string[] } {
	const reaped: string[] = [];
	const observed: string[] = [];
	if (!existsSync(runsDir)) return { scanned: 0, reaped, observed };

	const limit = opts.limit ?? 50;
	let ids = opts.runIds;
	if (!ids) {
		try {
			ids = readdirJson(runsDir);
		} catch {
			return { scanned: 0, reaped, observed };
		}
	}

	let scanned = 0;
	for (const id of ids) {
		if (scanned >= limit) break;
		scanned += 1;
		try {
			const r = reapZombie(runsDir, id, opts);
			if (r.reaped) reaped.push(id);
			else if (r.suspect) observed.push(id);
		} catch { /* 单条失败不影响其余 */ }
	}
	return { scanned, reaped, observed };
}

function readdirJson(dir: string): string[] {
	return readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.map((f) => f.slice(0, -".json".length));
}
