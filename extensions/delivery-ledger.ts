/**
 * delivery-ledger.ts — 交付真账本（唤醒必达，咨询 §6.1 最小 Interface）
 *
 * ## 解决什么
 * 旧机制用 `<runId>.notified` 一个文件当「已投递」的全部证明。两个已被独立探针
 * 复算过的缺陷（P1/P2）：
 *   - **P1** pre-send claim 跨重启存活 ⇒ 该 run 的完成事件被**永久抑制**；
 *   - **P2** 发送失败仍留下 `.notified` ⇒ 压掉**无关**事件。
 * 根因是把「占位/调用返回」当成「接收/接续」。本模块把交付拆成**可判定的阶段**，
 * 并规定：**只有 `consumed` 才是交付成功的唯一证明**。
 *
 * ## 硬语义（咨询 §6.1/§6.3，逐条落地）
 *   - `eventId = async:<runId>:<terminalRevision>`（revision = 稳定结果字段的 hash，
 *     **不含**通知重试字段 ⇒ 重试不产生新事件，同一 run 的同一终态恒同 eventId）；
 *   - 阶段：`pending → leased → attempted → received → consumed`，
 *     任何未 consumed 且过 `deliveryDeadline` ⇒ `failed_delivery` + incident；
 *   - `attempted` 只表示「调过发送」；`received` 需接收端看到带 eventId 的消息；
 *     `consumed` 需该 event 进入本次模型请求的有效 context（由本地关联，不靠 LLM 自述）；
 *   - 租约 15s，**租约不是已送达**；
 *   - `sent` **不得**命名 delivered；`.notified` **不得**当最终交付证明。
 *
 * ## 为什么用「多文件」而不是「一个 JSON 读改写」
 * 咨询 §6.1 明确：单纯 rename 不等于 CAS，两个进程不能直接读改写同一文件。
 * 因此本模块把**写入方按角色分离**，每个角色只追加自己的文件，不共享可变文档：
 *   - **事件元数据**（`<eid>.json`）：由创建者**单写者** atomic temp+rename 发布，创建后不变
 *     （除 incident 字段）；
 *   - **尝试**（`<eid>.attempt.<attemptId>.json`）：投递方 append-only（A/B 各自写）；
 *   - **回执**（`<eid>.ack.<stage>.<attemptId>.json`）：接收端 append-only（`wx` 创建，不可变）。
 * 有效阶段 = 由「已存在的回执文件」推导 —— 因此**不需要**任何跨进程读改写。
 *
 * ## 与在研 wall-budget / 僵尸看门狗 / force 的职责边界（咨询 §7）
 * 本层**只交付终态**，绝不改 run 的终态、不 kill 进程、不设第二个执行 timer、不 force。
 * `failed_delivery` **不改变 run**（completed 仍是 completed），业务面与交付面分开记账。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, openSync, closeSync, appendFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { defaultRuntimeDir } from "./runtime/journal.ts";

// ── 常量（口径写死，可被参数覆盖但默认值即规格）──────────────────────

/** 租约（ms）：咨询 §6.4「租约默认 15s」。 */
export const LEASE_MS = 15_000;
/** 交付期限（ms）：咨询 §6.4「deliveryDeadline = terminalAt + 60s」。 */
export const DELIVERY_DEADLINE_MS = 60_000;
/** B 对账通道首投阈值（ms）：咨询 §6.2「超过 20s 仍未 consumed 就补投」。 */
export const RECONCILE_FIRST_RETRY_MS = 20_000;
/** incident 重试节流（5s 起、最长 60s）。 */
export const INCIDENT_RETRY_BASE_MS = 5_000;
export const INCIDENT_RETRY_MAX_MS = 60_000;

/** 交付阶段（顺序即推进方向）。 */
export const DELIVERY_STAGES = ["pending", "leased", "attempted", "received", "consumed"] as const;
export type DeliveryStage =
	| (typeof DELIVERY_STAGES)[number]
	| "retry_scheduled"
	| "failed_delivery"
	/**
	 * 租约过期 + 持有者进程已死 ⇒ 该事件**已被判死并落终态**（P-1）。
	 * 语义上与 `failed_delivery` 同级（都是「不再尝试」），但原因不同、不需要 incident：
	 * 交付通道本身可能完全健康，只是当年的持有者进程没了、且没有真回执能证明送达。
	 */
	| "expired_dead_lease";

/** 只有它是交付成功。`attempted`/`sent`/`.notified` 都不是（P1/P2/P3 的核心纪律）。 */
export function isDelivered(stage: DeliveryStage): boolean {
	return stage === "consumed";
}

// ── eventId / terminalRevision（纯函数）──────────────────────────────

/**
 * 规范终态快照 hash。**只含稳定结果字段**，不含通知重试字段
 * （attempts/lease/nextAttemptAt/incident…）⇒ 重试/重启不改变 eventId。
 */
export function terminalRevisionOf(rec: Record<string, unknown>): string {
	const r = (rec.result ?? {}) as Record<string, unknown>;
	const f = (rec.failure ?? {}) as Record<string, unknown>;
	const stable = [
		rec.status ?? null,
		rec.endedAt ?? null,
		rec.zombieReapedAt ?? null,
		r.status ?? null,
		r.error ?? null,
		r.text ?? null,
		f.kind ?? null,
		f.source ?? null,
		// wall-budget 到点属于**结果**（决定事件内容），故计入 revision
		(rec as { killReason?: unknown }).killReason ?? null,
	];
	return createHash("sha256").update(JSON.stringify(stable)).digest("hex").slice(0, 16);
}

/** `eventId = async:<runId>:<terminalRevision>`（咨询 §6.1 逐字）。 */
export function deriveEventId(runId: string, terminalRevision: string): string {
	return `async:${runId}:${terminalRevision}`;
}

export function parseEventId(eventId: string): { runId: string; revision: string } | null {
	const m = /^async:(run_[^:]+):([0-9a-f]+)$/.exec(eventId);
	return m ? { runId: m[1], revision: m[2] } : null;
}

// ── 存储布局 ─────────────────────────────────────────────────────────

export function deliveryDir(runtimeDir: string = defaultRuntimeDir()): string {
	return join(runtimeDir, "delivery");
}

/** 缺省交付账本目录（生产默认；测试注入隔离目录）。 */
export function defaultDeliveryDir(): string {
	return deliveryDir();
}

/** 文件名安全化：eventId 含 `:`，Windows 文件名非法 ⇒ 编码（可逆，不改 eventId 本身）。 */
export function eventFileKey(eventId: string): string {
	return encodeURIComponent(eventId);
}

function ensureDir(dir: string): void {
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** 原子发布（temp + rename，同分区原子）。单写者语义由调用方保证（创建者/对账者）。 */
function atomicWrite(path: string, content: string): void {
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	writeFileSync(tmp, content, "utf8");
	renameSync(tmp, path);
}

// ── 事件元数据（单写者创建，创建后不变）──────────────────────────────

export interface DeliveryEvent {
	eventId: string;
	runId: string;
	terminalRevision: string;
	terminalSnapshotPath: string;
	/**
	 * **终态发生时刻**（来自 run 的 `endedAt`/`zombieReapedAt`）。
	 *
	 * 与 `observedAt`（发现时刻）区分：B 可能晚于终态很久才第一次扫到该 run，
	 * 若用 `observedAt` 算期限，则「晚发现的旧事件」会被错误地给予新的 60s
	 * （相当于隐式展期，违反咨询 §6.5「不隐式展期」）。故所有期限以本字段为准。
	 */
	terminalAt: string;
	/** 派发者稳定身份（links 解析结果）。 */
	dispatcherSessionId: string;
	/** 接收者世代（迁移接收者时保留 eventId、递增 generation）。 */
	recipientGeneration: number;
	observedAt: string;
	deliveryDeadline: string;
	/** incident 一旦发布即持久（跨重启保留，显式 ack 才清）。 */
	incidentId?: string;
	incidentAt?: string;
	incidentReason?: string;
}

export function loadEvent(dir: string, eventId: string): DeliveryEvent | null {
	try {
		const raw = JSON.parse(readFileSync(join(dir, `${eventFileKey(eventId)}.json`), "utf8")) as unknown;
		if (typeof raw !== "object" || raw === null) return null;
		const e = raw as Record<string, unknown>;
		return typeof e.eventId === "string" && typeof e.runId === "string" ? (raw as DeliveryEvent) : null;
	} catch {
		return null;
	}
}

/**
 * `ensureEvent`：不存在则创建。**已存在即原样返回**（不覆盖 ⇒ 重试不重置 deadline/attempts，
 * 也不会把已发布的 incident 抹掉）。
 */
export function ensureEvent(
	dir: string,
	input: {
		runId: string;
		terminalRevision: string;
		terminalSnapshotPath: string;
		dispatcherSessionId: string;
		recipientGeneration?: number;
		observedAt?: string;
		/** 终态发生时刻（缺省回退 observedAt）；期限基准，见 DeliveryEvent.terminalAt。 */
		terminalAt?: string;
		deliveryDeadlineMs?: number;
	},
): { event: DeliveryEvent; created: boolean } {
	ensureDir(dir);
	const eventId = deriveEventId(input.runId, input.terminalRevision);
	const existing = loadEvent(dir, eventId);
	if (existing) return { event: existing, created: false };
	const observedAt = input.observedAt ?? new Date().toISOString();
	const terminalAt = input.terminalAt ?? observedAt;
	const deadlineMs = input.deliveryDeadlineMs ?? DELIVERY_DEADLINE_MS;
	const event: DeliveryEvent = {
		eventId,
		runId: input.runId,
		terminalRevision: input.terminalRevision,
		terminalSnapshotPath: input.terminalSnapshotPath,
		dispatcherSessionId: input.dispatcherSessionId,
		recipientGeneration: input.recipientGeneration ?? 1,
		observedAt,
		terminalAt,
		deliveryDeadline: new Date(Date.parse(terminalAt) + deadlineMs).toISOString(),
	};
	atomicWrite(join(dir, `${eventFileKey(eventId)}.json`), JSON.stringify(event));
	return { event, created: true };
}

export function listEvents(dir: string, limit = 500): DeliveryEvent[] {
	if (!existsSync(dir)) return [];
	const out: DeliveryEvent[] = [];
	for (const f of readdirSync(dir)) {
		if (!f.endsWith(".json") || f.includes(".attempt.") || f.includes(".ack.") || f.includes(".incident.")) continue;
		try {
			const e = JSON.parse(readFileSync(join(dir, f), "utf8")) as DeliveryEvent;
			if (e?.eventId) out.push(e);
		} catch { /* 半截/损坏跳过，下轮重试 */ }
		if (out.length >= limit) break;
	}
	return out;
}

// ── 尝试（append-only，A/B 各自写）──────────────────────────────────

export type AttemptStatus =
	| "sent"
	| "busy"
	| "failed"
	| "no-injector"
	| "unconfirmed"
	/**
	 * **租约终态化（P-1，2026-11-03）**：该 attempt 的租约已过期，且租约里的 pid 探活为 DEAD。
	 * 这是**终态**：事件不再走 B 通道补投（不再向已死进程的持有面重复播发）。
	 * 由 `staleLeaseVerdict` 判定，`reconcileOnce` 落盘（含 reason/leaseOwner，AGENTS.md R-2）。
	 */
	| "expired-dead-owner";

export interface DeliveryAttempt {
	attemptId: string;
	channel: "A" | "B";
	at: string;
	/** **只表示调过发送**，不是送达（咨询 §6.1）。 */
	status: AttemptStatus;
	leaseOwner?: string;
	leaseUntil?: string;
	error?: string;
	/**
	 * 落终态时写入的**可读原因**（P-1/P-2 要求：不得静默，AGENTS.md R-2）。
	 * 形状示例：`lease-expired+owner-dead(leaseOwner=MB:10248,pid=10248,leaseUntil=...)`。
	 */
	reason?: string;
	/** 落终态（`expired-dead-owner`）的时刻；与 `at`（原 attempt 时刻）区分。 */
	finalizedAt?: string;
}

/**
 * 写一条 attempt 的返回口径（2026-11-03 L4 驱动）：调用方必须能区分
 * 「写成功 / 幂等命中 / 真失败」——旧版 `void` + 吞掉全部异常 ⇒ 落盘失败可被上面报成成功（R-2）。
 */
export type AttemptWriteOutcome = "written" | "exists" | "failed";

export function recordAttempt(dir: string, eventId: string, a: DeliveryAttempt): AttemptWriteOutcome {
	ensureDir(dir);
	const key = eventFileKey(eventId);
	const path = join(dir, `${key}.attempt.${encodeURIComponent(a.attemptId)}.json`);
	// append-only + 幂等：同 attemptId 重复写不覆盖（`wx`）
	try {
		const fd = openSync(path, "wx");
		try { writeFileSync(fd, JSON.stringify(a), "utf8"); } finally { closeSync(fd); }
		return "written";
	} catch (e) {
		// EEXIST = 同一 attempt 已记录（幂等命中，不是失败）；其余一律 "failed"，由调用方决定怎么报告
		if ((e as { code?: string } | null)?.code === "EEXIST") return "exists";
		return "failed";
	}
}

export function listAttempts(dir: string, eventId: string): DeliveryAttempt[] {
	const key = `${eventFileKey(eventId)}.attempt.`;
	if (!existsSync(dir)) return [];
	const out: DeliveryAttempt[] = [];
	for (const f of readdirSync(dir)) {
		if (!f.startsWith(key) || !f.endsWith(".json")) continue;
		try {
			out.push(JSON.parse(readFileSync(join(dir, f), "utf8")) as DeliveryAttempt);
		} catch { /* ignore */ }
	}
	return out.sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
}

// ── 租约终态化（P-1，2026-11-03）：纯判据 + append-only 落终态 ──────────

/**
 * 从 `leaseOwner`（`MB:10248` / `OB:76520` / `A:64712` / `B:47648`）里取出 pid。
 *
 * 前缀是**历史演进**的结果（MB=mailbox 消费、A/B=投递通道、OB=outbox 桥），
 * 全都遵循 `<tag>:<pid>` 形状 ⇒ 统一取最后一个 `:` 之后的十进制数，不按前缀白名单
 * 枚举（否则新增一个 writers 就会静默逃过判据）。取不到 ⇒ null（判据据此 fail-closed）。
 */
export function parsePidFromLeaseOwner(leaseOwner: string | undefined): number | null {
	if (typeof leaseOwner !== "string") return null;
	const m = /(\d+)$/.exec(leaseOwner.trim());
	if (m === null) return null;
	const pid = Number(m[1]);
	return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** `staleLeaseVerdict` 的唯一判定值（写成字面量，便于断言与 grep）。 */
export const EXPIRED_DEAD_OWNER = "expired-dead-owner" as const;

/**
 * **P-1 租约终态化判据（纯函数）**。
 *
 * 判据 = `leaseUntil < now` **∧** `leaseOwner` 里的 pid 探活为 **DEAD** ⇒ `"expired-dead-owner"`；
 * 其余一律 `null`（不动）。
 *
 * ## 死亡判据只用 pid 探活（照 `trace-fusion/lane-facts.ts` 的写法与理由）
 * lane-facts 的文件头原话：「单看 `lastActivityAt` 会误判：一次长工具调用期间不写 state
 * （实测有正常工作的 tab 因 lastActivityAt 冻结 61min 被误判僵尸并 abort，随后重复派发）。
 * 因此本模块**绝不用 lastActivityAt 判死**。」
 * ⇒ 本判据同样**只**用 pid 探活（可选再叠心跳超阈，见 `isPidAlive` 注入面），**绝不**看
 * `lastActivityAt` / attempt 的 `at` 年龄。用一条时间戳当死亡证据是把「没动静」当「没了」。
 *
 * ## 为什么必须 pid 死才算
 * 租约过期只证明「持有人没在租约内确认」，**不**证明它死了：活着的进程可能只是慢。
 * 对活着的持有者落终态 = 抢走它正在做的事（把 at-least-once 变成 at-most-once）。
 * 只有「租约过期」+「持有人进程确定不在」同时成立，才既无风险又无意义再等。
 *
 * 注入面（`isPidAlive`）缺省 = 真实 `process.kill(pid,0)` 探针（`runtime/liveness.ts::isProcessAlive`）。
 * `isProcessAlive` 的 ESRCH/EPERM 语义：「EPERM = 进程在（无信号权限）；其余 = 不在」。
 * 注意它在 Windows 上会把「已终止但仍有句柄」的 pid 判成**活**（EPERM）——那种情况下本判据
 * 返回 `null`（不动），属**故意**的保守方向：漏判只是继续补投，误判会丢真活目标的投递。
 */
export function staleLeaseVerdict(
	attempt: Pick<DeliveryAttempt, "leaseUntil" | "leaseOwner" | "status">,
	opts: { now: number; isPidAlive: (pid: number) => boolean },
): typeof EXPIRED_DEAD_OWNER | null {
	// 已终态的 attempt 不再判（幂等：重复调用同一判据不产生第二次落盘）
	if (attempt.status === EXPIRED_DEAD_OWNER) return null;
	// **作用门面**（2026-11-03 干跑实测驱动）：P-1 只针对「持有租约且从未确认」的 attempt。
	// 未加本门前干跑读数：8 条候选里 **7 条是 `status="sent"`（已送达）**，1 条 unconfirmed。
	// 对已送达的投递落 `expired-dead-owner` = 零信息增量 + 账本污染（把成功记录改成终态失败形状）。
	// `sent` / `failed` / `no-injector` / `busy` 都是**显式结果**，各自已有处理路径（incident / retry），
	// 不由租约终态化接管。
	if (attempt.status !== "unconfirmed") return null;
	const leaseUntil = typeof attempt.leaseUntil === "string" ? Date.parse(attempt.leaseUntil) : Number.NaN;
	if (!Number.isFinite(leaseUntil)) return null;
	// ① 租约未过期 ⇒ 不判死（活持有者的正常窗口）
	if (!(leaseUntil < opts.now)) return null;
	// ② 取不到 pid ⇒ fail-closed（没有死亡证据，不动）
	const pid = parsePidFromLeaseOwner(attempt.leaseOwner);
	if (pid === null) return null;
	// ③ pid 探活为活 ⇒ 不判死（慢 ≠ 死）
	let alive: boolean;
	try {
		alive = opts.isPidAlive(pid);
	} catch {
		return null; // 探针异常 ⇒ 不判（不猜）
	}
	if (alive) return null;
	return EXPIRED_DEAD_OWNER;
}

/**
 * 落终态时写入的**可读原因**（AGENTS.md R-2：不得静默）。含判据三要素 + leaseOwner。
 * 纯函数，与 `staleLeaseVerdict` 同源分发，保证「判定」与「记录」不会漂移。
 */
export function staleLeaseReason(attempt: Pick<DeliveryAttempt, "leaseUntil" | "leaseOwner">, now: number): string {
	const pid = parsePidFromLeaseOwner(attempt.leaseOwner);
	return `lease-expired+owner-dead(leaseOwner=${attempt.leaseOwner ?? "?"},pid=${pid ?? "?"},leaseUntil=${attempt.leaseUntil ?? "?"},judgedAt=${new Date(now).toISOString()})`;
}

/**
 * **append-only 落终态**：追加一条 `status="expired-dead-owner"` 的 attempt 记录。
 *
 * 为什么是「追加一条」而不是「改写原 attempt」：本模块的核心不变量是
 * **attempt 文件 append-only + `wx` 幂等**（见文件头『为什么用多文件』）——跨进程读改写会
 * 丢更新。追加一条终态记录后，`listAttempts` 按 `at` 升序把最后一条作为「最近 attempt」，
 * `effectiveStageOf` 据此判 `expired_dead_lease`。原 attempt 原样保留（可审计：「谁在何时领了什么租约」）。
 *
 * 幂等：attemptId 由原 attemptId 确定性派生（`<orig>@expired`），`recordAttempt` 用 `wx`
 * ⇒ 重复调用不产生第二条。
 *
 * @returns true = 本次写入；false = 已存在（幂等命中）。
 */
export function finalizeExpiredLease(
	dir: string,
	eventId: string,
	attempt: DeliveryAttempt,
	now: number,
): boolean {
	const at = new Date(now).toISOString();
	const attemptId = `${attempt.attemptId}@${EXPIRED_DEAD_OWNER}`;
	const path = join(dir, `${eventFileKey(eventId)}.attempt.${encodeURIComponent(attemptId)}.json`);
	if (existsSync(path)) return false;
	const outcome = recordAttempt(dir, eventId, {
		attemptId,
		channel: attempt.channel,
		at,
		status: EXPIRED_DEAD_OWNER,
		// 保留原租约事实（审计要能看出是谁的租约被判死）
		...(attempt.leaseOwner !== undefined ? { leaseOwner: attempt.leaseOwner } : {}),
		...(attempt.leaseUntil !== undefined ? { leaseUntil: attempt.leaseUntil } : {}),
		reason: staleLeaseReason(attempt, now),
		finalizedAt: at,
	});
	// 只有**真写进去**才算落终态（幂等命中 exists / 真失败 failed 都不得报成成功，R-2）
	return outcome === "written";
}

// ── 回执（append-only，接收端写；`wx` 不可变）────────────────────────

/** 接收端可确认的阶段（**不含** leased/attempted —— 那些是投递方的，不是送达证据）。 */
export type AckStage = "received" | "consumed";

export interface DeliveryAck {
	eventId: string;
	stage: AckStage;
	attemptId: string;
	recipientGeneration: number;
	at: string;
	evidence: string;
	disposition?: string;
}

/**
 * 写回执（`wx` 原子创建 ⇒ 不可变、幂等）。
 * 返回 true = 本次创建；false = 已存在（他人已 ack，等价成功）。
 */
export function writeAck(dir: string, ack: DeliveryAck): boolean {
	ensureDir(dir);
	const path = join(dir, `${eventFileKey(ack.eventId)}.ack.${ack.stage}.${encodeURIComponent(ack.attemptId)}.json`);
	try {
		const fd = openSync(path, "wx");
		try { writeFileSync(fd, JSON.stringify(ack), "utf8"); } finally { closeSync(fd); }
		return true;
	} catch {
		return false;
	}
}

export function listAcks(dir: string, eventId: string): DeliveryAck[] {
	const key = `${eventFileKey(eventId)}.ack.`;
	if (!existsSync(dir)) return [];
	const out: DeliveryAck[] = [];
	for (const f of readdirSync(dir)) {
		if (!f.startsWith(key) || !f.endsWith(".json")) continue;
		try {
			out.push(JSON.parse(readFileSync(join(dir, f), "utf8")) as DeliveryAck);
		} catch { /* ignore */ }
	}
	return out.sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
}

// ── 阶段推导 + 对账判定（纯函数，可测）──────────────────────────────

export interface StageView {
	stage: DeliveryStage;
	/** 阶段所依据的证据（审计用）。 */
	evidence: string;
	lastAt?: string;
	/** `consumed` 的证据（disposition 等）。 */
	consumedBy?: DeliveryAck;
}

/** 账本状态（单一入参对象；D-2：把 incident 状态显式化，禁止各消费点自行 if-else）。 */
export interface LedgerState {
	event: DeliveryEvent;
	attempts: DeliveryAttempt[];
	acks: DeliveryAck[];
}

/** incident 状态（缺省 = 未发布）。 */
export interface IncidentState {
	incidentId?: string;
	incidentAt?: string;
}

/**
 * **唯一**的阶段推导纯函数（D-2，2026-10-16 global Master 裁定）。
 *
 * 优先级（高者胜）：**failed_delivery（已发布 incident）> consumed > received > attempted/expired_dead_lease > retry_scheduled > pending**。
 *
 * `expired_dead_lease`（P-1）与 `attempted` 同级：两者都是「当前的最近一次记录不再要求重试」。
 * 区别：`attempted` 表示「调过发送，仍等回执 / 还可重投」；`expired_dead_lease` 表示
 * 「租约已过期且持有者进程已死 ⇒ 不再重投」（见 `staleLeaseVerdict`）。
 *
 * **硬约束（D-2）**：`incident` 已发布 ⇒ 本次交付已终结为失败，**任何路径都不得再返回
 * `consumed`/成功态**（迟到 consumed ACK 不反悔；重新投递属**新 delivery generation**，
 * 由消费方另行处理，见咨询 §6.1）。所有消费方**必须**经本函数取阶段，禁止各自 if-else。
 *
 * 关键纪律：`attempted` 即使 status==="sent" 也**只是 attempted**（P3：wrapper 的 sent 是假阳性）。
 */
export function effectiveStageOf(ledger: LedgerState, incident: IncidentState, now: number): StageView {
	const { event, attempts, acks } = ledger;
	if (incident.incidentId) {
		return { stage: "failed_delivery", evidence: `incident:${incident.incidentId}`, lastAt: incident.incidentAt };
	}
	const consumed = acks.filter((a) => a.stage === "consumed").at(-1);
	if (consumed) return { stage: "consumed", evidence: `consumed:${consumed.evidence}`, lastAt: consumed.at, consumedBy: consumed };
	const received = acks.filter((a) => a.stage === "received").at(-1);
	if (received) return { stage: "received", evidence: `received:${received.evidence}`, lastAt: received.at };
	const last = attempts.at(-1);
	if (last) {
		// P-1：租约终态化（终态，与 failed_delivery 同级「不再尝试」）
		// 注意优先级必须在 sent 之前：终态记录与 sent 可能同时是「最后一条」，
		// 但终态记录 by construction 在时间上更晚（at = 判定时刻）。
		if (last.status === EXPIRED_DEAD_OWNER) {
			return { stage: "expired_dead_lease", evidence: `attempt:${last.channel}:${EXPIRED_DEAD_OWNER}(${last.reason ?? "no-reason"})`, lastAt: last.at };
		}
		if (last.status === "sent") return { stage: "attempted", evidence: `attempted:${last.channel}:sent`, lastAt: last.at };
		return { stage: "retry_scheduled", evidence: `attempt:${last.channel}:${last.status}`, lastAt: last.at };
	}
	return { stage: "pending", evidence: "no-attempt", lastAt: event.observedAt };
}

/**
 * 兼容入口（从 event 提取 incident 状态）。**实现与 `effectiveStageOf` 同源**（不重复逻辑）；
 * 生产消费方新代码请直接用 `effectiveStageOf(ledger, incident, now)` 显式传 incident 状态。
 */
export function effectiveStage(
	event: DeliveryEvent,
	attempts: DeliveryAttempt[],
	acks: DeliveryAck[],
	now: number,
): StageView {
	return effectiveStageOf({ event, attempts, acks }, { incidentId: event.incidentId, incidentAt: event.incidentAt }, now);
}

export type ReconcileAction =
	| { action: "none"; reason: string }
	| { action: "retry"; reason: string; attemptId: string; /** P-3：这是第几次 B 补投（从 1 开始）。 */ retryOrdinal: number }
	| { action: "fail_delivery"; reason: string }
	/**
	 * P-1：租约过期的持有者进程已死 ⇒ 不补投，落终态（由调用方写审计行 + 终态记录）。
	 * 与 `fail_delivery` 分开是因为语义不同：交付通道本身没坏，不需要 incident 升级。
	 */
	| { action: "finalize_expired_lease"; reason: string; attemptId: string };

/**
 * **P-3：同一 eventId 的 B 通道补投次数上限 = 2**。
 *
 * 依据（实测）：同一 eventId 的记录数分布 1 条→61 | 2 条→908 | **3 条→96**。
 * 那 96 个到 3 次的事件，第 3 次及以后对会话侧是纯噪声（正文带 `⏱ [B 对账补投]`，
 * 但同一 eventId 的信息量不随次数增长）。
 *
 * 取舍（AGENTS.md R-5「宁可重发，不可漏发」，**显式登记**）：
 *   - 本上限**只限制「同一 eventId 的 B 补投」**，不碰 A 通道的首投，也不碰
 *     `failed_delivery` 升级（后者是持久 incident，不是会话注入）；
 *   - 活目标仍能得到 **首次投递（A）+ 至多 2 次补投（B）**，比原来的「限期内每 15s 一次」
 *     只减少了**对同一 eventId 的重复播发次数**，没有减少「至少一次」的可能性；
 *   - 超过上限后事件**不是**静默丢弃：`reconcileDecision` 返回 `none`，到
 *     `deliveryDeadline` 仍会 `fail_delivery` + 持久 incident 可见（不静默）。
 *   - 真正的“漏发”风险窗口在：2 次补投都未到达。这与原设计一致（原来也只是反复重试，
 *     并非无限久）——期限 60s 内的重试次数从 ~3 次降到 2 次，量级不变。
 */
export const MAX_B_RETRIES_PER_EVENT = 2;

/**
 * 对账判定（纯函数）。
 *
 * 规则（咨询 §6.4/§6.2，行号指修改后）：
 *   0. **P-1**：最近 attempt 的租约已过期 ∧ 持有者 pid 已死 ⇒ `finalize_expired_lease`（不补投）；
 *   1. 已 consumed / 已 failed_delivery → none；已 expired_dead_lease → 期限前 none（不再补投），
 *      **期限一到照旧升级 fail_delivery**（见下方顺序注释）；
 *   2. 过 `deliveryDeadline` 仍未 consumed → **fail_delivery**（不 kill、不改进程、不改 run）；
 *   3. 超过 `RECONCILE_FIRST_RETRY_MS` 仍未 consumed → retry（B 通道补投，同 eventId、新 attemptId）；
 *      但 **P-3**：已补投次数 ≥ `MAX_B_RETRIES_PER_EVENT` ⇒ none（不再向会话播发）；
 *   4. 距上次尝试不足 15s（租约）→ none（不惊群）。
 *
 * 顺序说明（P-1 为何在 deadline 之后判 fail_delivery 之前）：
 *   `fail_delivery` 是更强的终态（发 incident，跨重启可见）；让期限优先保证
 *   「该升级的照升级」。P-1 只在期限未到时接住「本来还要补投」的那些路径。
 */
export function reconcileDecision(
	event: DeliveryEvent,
	view: StageView,
	attempts: DeliveryAttempt[],
	now: number,
	opts: {
		reconcileFirstRetryMs?: number;
		leaseMs?: number;
		/** P-3 上限覆盖（测试用；缺省 = MAX_B_RETRIES_PER_EVENT）。 */
		maxBRetries?: number;
		/**
		 * P-1 判据注入：提供则启用租约终态化（返回 non-null ⇒ 落终态）。
		 * 不提供 ⇒ 保持原行为（**默认关**，见 AGENTS「破坏性修改必须显式开启」）。
		 */
		staleLease?: (attempt: DeliveryAttempt) => string | null;
	} = {},
): ReconcileAction {
	if (view.stage === "consumed") return { action: "none", reason: "consumed" };
	if (view.stage === "failed_delivery") return { action: "none", reason: "already-failed-delivery" };

	// **顺序硬要求（2026-11-03 L4 审查实测驱动）**：deadline 必须在 `expired_dead_lease` 短路**之前**判。
	// 旧顺序（expired 短路在前）会把「租约终态」变成**整个事件的永久静默**：不再补投、
	// 且期限到了也不发 incident ⇒ 漏发不可见。本仓取舍（AGENTS.md R-5）是「宁可重发，不可漏发」，
	// R-2 又禁止静默失效 ⇒ 停投只能降噪，**不得**顺手取消期限升级。
	const deadlineMs = Date.parse(event.deliveryDeadline);
	if (Number.isFinite(deadlineMs) && now >= deadlineMs) {
		return { action: "fail_delivery", reason: `deadline-exceeded(deadline=${event.deliveryDeadline},stage=${view.stage})` };
	}
	// 租约终态（P-1）且期限未到 ⇒ 不再补投。**代价显式登记**：若目标进程后来复活，
	// 该事件不会再被投递（at-most-once 面）；由期限到点的 fail_delivery incident 兜住可见性。
	if (view.stage === "expired_dead_lease") {
		return { action: "none", reason: "already-expired-dead-lease(escalate-at-deadline)" };
	}

	// 期限未到：先看是否该落租约终态（P-1）——这是「本来要补投」的分支上的拦截。
	if (opts.staleLease) {
		// 只看最近一次尝试：历史 attempt 的租约早过期是常态（不可拿来判死当前状态）。
		// 但“最近一次”自身也可能是某条早期的 unconfirmed（后无任何尝试）——那正是要判的对象。
		const last0 = attempts.at(-1);
		if (last0) {
			const verdict = opts.staleLease(last0);
			if (verdict !== null) {
				return { action: "finalize_expired_lease", reason: verdict, attemptId: last0.attemptId };
			}
		}
	}

	const observed = Date.parse(event.terminalAt ?? event.observedAt);
	const firstRetryMs = opts.reconcileFirstRetryMs ?? RECONCILE_FIRST_RETRY_MS;
	const leaseMs = opts.leaseMs ?? LEASE_MS;
	if (!Number.isFinite(observed)) return { action: "none", reason: "no-observed-at" };

	const last = attempts.at(-1);
	const baseMs = last ? Date.parse(last.at) : observed;
	if (!Number.isFinite(baseMs)) return { action: "none", reason: "no-time-basis" };

	// 租约内不重复投（防 A/B 惊群）
	if (now - baseMs < leaseMs) return { action: "none", reason: "within-lease" };

	// 到首投阈值才补投
	if (!last && now - observed < firstRetryMs) return { action: "none", reason: "before-first-retry" };

	// P-3：B 补投次数上限（只数 channel==="B" 且真正投递过的 attempt；终态记录不算）。
	// **口径登记（2026-11-03 L4）**：限的是**尝试次数**，不是「已确认重复次数」——
	// `failed/busy/no-injector` 都占额度（它们是真实发生过的播发）。
	// **作用面登记**：本门**不受 `staleLeaseFinalize` 开关控制**（无条件生效）⇒ 「P-1 默认关」
	// 不等于「行为与改动前逐字节等价」，见 `_test_delivery_stale.ts` S3 的措辞。
	const bRetries = attempts.filter((a) => a.channel === "B" && a.status !== EXPIRED_DEAD_OWNER).length;
	const maxB = opts.maxBRetries ?? MAX_B_RETRIES_PER_EVENT;
	if (bRetries >= maxB) {
		return { action: "none", reason: `b-retry-cap-reached(${bRetries}/${maxB})` };
	}

	const attemptId = `${event.eventId}@${now}@${Math.random().toString(36).slice(2, 8)}`;
	return { action: "retry", reason: last ? `retry-after-${view.stage}` : "first-retry", attemptId, retryOrdinal: bRetries + 1 };
}

// ── incident（跨重启保留；仅显式 ack 才清）───────────────────────────

export interface Incident {
	incidentId: string;
	eventId: string;
	runId: string;
	reason: string;
	createdAt: string;
	/** 未读项跨重启保留；GUI 连接后补显，直到显式 ack。 */
	ackedAt?: string;
	ackedBy?: string;
	/** 通知出口重试（5s 起、最长 60s）。 */
	nextAttemptAt?: string;
	notifyAttempts?: number;
}

/**
 * 发布 incident（幂等：同 eventId 已有 incident 则复用，不重复制造）。
 * incident 是**不调用模型的失败出口**（咨询 §6.2）：与 provider 额度无关，必然写盘。
 */
export function publishIncident(dir: string, event: DeliveryEvent, reason: string, now: number): Incident {
	ensureDir(dir);
	const existing = loadEvent(dir, event.eventId);
	if (existing?.incidentId) {
		const inc = loadIncident(dir, existing.incidentId);
		if (inc) return inc;
	}
	const incidentId = `inc_${event.runId}_${terminalRevisionOrRandom(event)}`;
	const incident: Incident = {
		incidentId,
		eventId: event.eventId,
		runId: event.runId,
		reason,
		createdAt: new Date(now).toISOString(),
		nextAttemptAt: new Date(now + INCIDENT_RETRY_BASE_MS).toISOString(),
		notifyAttempts: 1,
	};
	atomicWrite(join(dir, `${eventFileKey(event.eventId)}.incident.${incidentId}.json`), JSON.stringify(incident));
	// 事件元数据记 incident（此处是**唯一**对已发布事件记录的合法更新：incident 一旦发布即持久）
	if (existing) {
		atomicWrite(join(dir, `${eventFileKey(event.eventId)}.json`), JSON.stringify({
			...existing,
			incidentId,
			incidentAt: incident.createdAt,
			incidentReason: reason,
		}));
	}
	return incident;
}

function terminalRevisionOrRandom(event: DeliveryEvent): string {
	return event.terminalRevision || Math.random().toString(36).slice(2, 8);
}

export function loadIncident(dir: string, incidentId: string): Incident | null {
	if (!existsSync(dir)) return null;
	for (const f of readdirSync(dir)) {
		if (!f.includes(".incident.") || !f.endsWith(".json")) continue;
		try {
			const inc = JSON.parse(readFileSync(join(dir, f), "utf8")) as Incident;
			if (inc?.incidentId === incidentId) return inc;
		} catch { /* ignore */ }
	}
	return null;
}

/** 未 ack 的 incident（跨重启保留；GUI 启动/刷新时显示）。 */
export function listOpenIncidents(dir: string): Incident[] {
	if (!existsSync(dir)) return [];
	const out: Incident[] = [];
	for (const f of readdirSync(dir)) {
		if (!f.includes(".incident.") || !f.endsWith(".json")) continue;
		try {
			const inc = JSON.parse(readFileSync(join(dir, f), "utf8")) as Incident;
			if (inc?.incidentId && !inc.ackedAt) out.push(inc);
		} catch { /* ignore */ }
	}
	return out.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

/** 显式 ack 才清（咨询 §6.2：不能因为 toast 调用成功就消失）。 */
export function ackIncident(dir: string, incidentId: string, by: string, now: number): boolean {
	const inc = loadIncident(dir, incidentId);
	if (!inc || inc.ackedAt) return false;
	const path = join(dir, `${eventFileKey(inc.eventId)}.incident.${incidentId}.json`);
	atomicWrite(path, JSON.stringify({ ...inc, ackedAt: new Date(now).toISOString(), ackedBy: by }));
	return true;
}

/** incident 通知重试时刻（指数退避，5s→60s 封顶）。 */
export function nextIncidentNotifyAt(inc: Incident, now: number): string {
	const n = Math.min(inc.notifyAttempts ?? 1, 10);
	const delay = Math.min(INCIDENT_NOTIFY_CAP, INCIDENT_RETRY_BASE_MS * 2 ** (n - 1));
	return new Date(now + delay).toISOString();
}

const INCIDENT_NOTIFY_CAP = INCIDENT_RETRY_MAX_MS;

// ── 顶层：一次对账（供 A/B 通道调用）────────────────────────────────

export interface ReconcileOutcome {
	eventId: string;
	stage: DeliveryStage;
	action: ReconcileAction;
}

/**
 * 对单事件跑一次对账。**只读 + 必要时发布 incident / 记录 attempt**；
 * 投递动作由调用方（A/B 通道）执行 —— 本函数保证「判定」与「副作用」分离，便于测试。
 *
 * @param deliver 可选：真正投递的实现（返回 true = 已尝试发送）。未提供则只判定不投。
 */
export async function reconcileEvent(
	dir: string,
	event: DeliveryEvent,
	now: number,
	opts: {
		reconcileFirstRetryMs?: number;
		leaseMs?: number;
		maxBRetries?: number;
		/**
		 * P-1 判据注入：提供则启用租约终态化。**默认关**（破坏性回归面必须调用方显式开启）。
		 * 生产入口（`runtime-host/delivery-reconciler-loop.ts`）由
		 * `PI_DELIVERY_STALE_FINALIZE=1` 打开。
		 */
		staleLease?: (attempt: DeliveryAttempt) => string | null;
		/** 落终态后的审计回调（生产接 `appendAuditLine` / `appendTrace`）。 */
		onExpiredLease?: (ev: { eventId: string; attemptId: string; reason: string; leaseOwner?: string }) => void;
		/** 投递实现：返回 attempt 状态。 */
		deliver?: (attemptId: string) => Promise<AttemptStatus> | AttemptStatus;
		channel?: "A" | "B";
		/** incident 出口（不调用模型；失败不阻断 incident 本身）。 */
		onIncident?: (inc: Incident) => void;
	} = {},
): Promise<ReconcileOutcome> {
	const attempts = listAttempts(dir, event.eventId);
	const acks = listAcks(dir, event.eventId);
	// D-2：显式传 incident 状态（唯一纯函数 `effectiveStageOf`）
	const view = effectiveStageOf({ event, attempts, acks }, { incidentId: event.incidentId, incidentAt: event.incidentAt }, now);
	const action = reconcileDecision(event, view, attempts, now, opts);

	if (action.action === "finalize_expired_lease") {
		const target = attempts.find((a) => a.attemptId === action.attemptId);
		if (target) {
			const written = finalizeExpiredLease(dir, event.eventId, target, now);
			if (written) {
				// R-2：不静默 —— 落终态后必须写一条审计（不可抛：审计失败不得回滚终态）。
				try {
					opts.onExpiredLease?.({ eventId: event.eventId, attemptId: target.attemptId, reason: action.reason, leaseOwner: target.leaseOwner });
				} catch { /* best-effort */ }
			}
		}
		return { eventId: event.eventId, stage: "expired_dead_lease", action };
	}

	if (action.action === "fail_delivery") {
		const inc = publishIncident(dir, event, action.reason, now);
		try { opts.onIncident?.(inc); } catch { /* best-effort：出口失败不抹 incident */ }
		return { eventId: event.eventId, stage: "failed_delivery", action };
	}

	if (action.action === "retry" && opts.deliver) {
		// 先记租约（attempted 之前），再投；投递状态记入 attempt（append-only）
		let status: AttemptStatus = "unconfirmed";
		try {
			status = await opts.deliver(action.attemptId);
		} catch (e) {
			status = "failed";
			recordAttempt(dir, event.eventId, {
				attemptId: action.attemptId, channel: opts.channel ?? "B", at: new Date(now).toISOString(),
				status, leaseOwner: `reconcile:${process.pid}`, leaseUntil: new Date(now + (opts.leaseMs ?? LEASE_MS)).toISOString(),
				error: String((e as Error)?.message ?? e).slice(0, 200),
			});
			return { eventId: event.eventId, stage: view.stage, action };
		}
		recordAttempt(dir, event.eventId, {
			attemptId: action.attemptId, channel: opts.channel ?? "B", at: new Date(now).toISOString(),
			status, leaseOwner: `reconcile:${process.pid}`, leaseUntil: new Date(now + (opts.leaseMs ?? LEASE_MS)).toISOString(),
		});
	}

	return { eventId: event.eventId, stage: view.stage, action };
}

/**
 * 清空（**仅测试**用）。
 *
 * ## 生产守卫（2026-11-03 体检事故驱动）
 * 体检实测：`runtime/delivery/` 从 3470 条→689 条（我 05:47Z 数的，07:19Z 复数），
 * 1-7 天的历史**全没**，且**无备份**（`runtime/` 下只有 `events.jsonl.bak-cleanup-*`）。
 * 全仓 grep 找到的**唯一**删除动作就是本函数（对目录无守卫）⇒ 任何拿到默认目录的
 * 调用都会**静默销毁生产交付账本**（AGENTS.md R-2：静默失效不可接受）。
 * 现硬拦：目标目录 == 生产账本目录 ⇒ 抛错（不是 no-op），除非显式 `PI_ALLOW_PROD_RESET=1`。
 */
export function _resetDeliveryDir(dir: string): void {
	// 守卫必须在 existsSync **之前**（首版写在后面 ⇒ 目录不存在时早退，守卫被绕过；由新断言拓出）。
	const prod = join(defaultRuntimeDir(), "delivery");
	const same = (a: string, b: string) => a.replace(/[\\/]+$/, "").toLowerCase() === b.replace(/[\\/]+$/, "").toLowerCase();
	if (same(dir, prod) && process.env.PI_ALLOW_PROD_RESET !== "1") {
		throw new Error(
			`_resetDeliveryDir 拒绝对生产账本目录操作：${dir}（要确实要清生产目录请显式设 PI_ALLOW_PROD_RESET=1）。` +
				`测试请用 PI_RUNTIME_DIR 隔离到临时目录。`,
		);
	}
	if (!existsSync(dir)) return;
	for (const f of readdirSync(dir)) {
		try { unlinkSync(join(dir, f)); } catch { /* ignore */ }
	}
}

/** 追加一条原始轨迹（审计/独立 oracle 复算，不参与判定）。 */
export function appendTrace(dir: string, entry: Record<string, unknown>): void {
	ensureDir(dir);
	try {
		appendFileSync(join(dir, "trace.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, "utf8");
	} catch { /* best-effort */ }
}
