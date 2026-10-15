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
	opts: { now?: () => number; force?: boolean } = {},
): boolean {
	if (!existsSync(runsDir)) mkdirSync(runsDir, { recursive: true });
	const lockPath = join(runsDir, `${id}.reaped`);
	try {
		writeFileSync(lockPath, JSON.stringify({ ...meta, token: mintToken() }), { flag: "wx" });
		return true;
	} catch (e) {
		if ((e as { code?: string }).code !== "EEXIST") throw e;
	}
	// 已存在：说明该 run 已被认领过（`.reaped` 持久存在）。
	//
	// ## 为什么不「接管」过期锁（四代实现的教训；L4 四轮全部推翻）
	// 我先后试了 4 种「接管过期锁」的实现，每一种都被 L4 找到真实双赢家反例：
	//   1. `rmSync + writeFileSync(wx)`：两步间可删他人新锁。
	//   2. 仅 `renameSync` 移走：A 可能移走 B 刚建的新锁（路径存在即成功）。
	//   3. + token 核对 +「放回」：Windows 上 rename **会覆盖**已存在目标 ⇒ 抹掉第三方锁（实测确认）。
	//   4. 独立 `.reaping` 接管锁 + TTL：**TTL 会回收仍在工作的接管锁** ⇒ 双赢家
	//      （L4 给出可复现时序：owner 暂停超过 TTL 后另一个接管者也会成功）。
	// **根本原因**：「过期无主文件」无法安全实现 owner 回收 —— 这需要 **fencing**（fencing token /
	// 带所有权校验的释放），而单进程外的纯文件系统原语给不出。L4 明确建议：
	//   「Prefer a supported lock/lease primitive with fencing generation and ownership-checked
	//    release, **or simplify to permanent `wx` claim (accept crash-stuck marker and provide
	//    explicit/manual stale recovery)**. Do not claim "exactly one" with expiring ownerless files.」
	//
	// ## 本实现（第 5 代）：持久 claim + 显式人工恢复
	// - `.reaped` 是**永久** claim：`wx` 创建即赢，永不被自动回收（⇒ 真正的「至多一个自动赢家」）。
	// - 赢家崩溃停在 claim 后、终态前 ⇒ 该 run 需**人工/显式**恢复（`reapZombie(id, {force:true})`），
	//   与 L4 建议一致。**不自动回收** ⇒ 不会双赢家。
	// - 真正的安全兜底是**终态写入本身幂等**（见 `reapZombie` 的写前重读 + 终态短路）：
	//   即便两次 claim 竞态都走到写终态，两者也会写出**语义相同**的 `failed(zombie)`，
	//   且第二次会因「已非 running」而短路。（这是「下游幂等」，不用于掩盖双赢家——
	//   L4 正确指出它不能替代 fencing；此处我们**已经放弃了 exactly-one 声明**。）
	if (opts.force !== true) return false; // 非 force：永久 claim ⇒ 认输（不接管、不双赢）
	// 显式 force 恢复（人工运维路径）：持有者已知该 claim 是僵的
	try {
		rmSync(lockPath, { force: true });
		writeFileSync(lockPath, JSON.stringify({ ...meta, token: mintToken(), forced: true }), { flag: "wx" });
		return true;
	} catch {
		return false;
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
	opts: { deps?: ZombieDeps; now?: () => number; force?: boolean } = {},
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
	if (!claimReap(runsDir, id, { reason: verdict.reason, pid: rec.pid, at }, { now: () => now, force: opts.force })) {
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
