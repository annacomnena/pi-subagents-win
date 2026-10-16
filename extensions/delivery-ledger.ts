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
export type DeliveryStage = (typeof DELIVERY_STAGES)[number] | "retry_scheduled" | "failed_delivery";

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

export type AttemptStatus = "sent" | "busy" | "failed" | "no-injector" | "unconfirmed";

export interface DeliveryAttempt {
	attemptId: string;
	channel: "A" | "B";
	at: string;
	/** **只表示调过发送**，不是送达（咨询 §6.1）。 */
	status: AttemptStatus;
	leaseOwner?: string;
	leaseUntil?: string;
	error?: string;
}

export function recordAttempt(dir: string, eventId: string, a: DeliveryAttempt): void {
	ensureDir(dir);
	const key = eventFileKey(eventId);
	const path = join(dir, `${key}.attempt.${encodeURIComponent(a.attemptId)}.json`);
	// append-only + 幂等：同 attemptId 重复写不覆盖（`wx`）
	try {
		const fd = openSync(path, "wx");
		try { writeFileSync(fd, JSON.stringify(a), "utf8"); } finally { closeSync(fd); }
	} catch {
		/* EEXIST（同 attempt 已记）或其他：不覆盖 */
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
 * 优先级（高者胜）：**failed_delivery（已发布 incident）> consumed > received > attempted > retry_scheduled > pending**。
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
	| { action: "retry"; reason: string; attemptId: string }
	| { action: "fail_delivery"; reason: string };

/**
 * 对账判定（纯函数）。
 *
 * 规则（咨询 §6.4/§6.2）：
 *   1. 已 consumed / 已 failed_delivery → none；
 *   2. 过 `deliveryDeadline` 仍未 consumed → **fail_delivery**（不 kill、不改进程、不改 run）；
 *   3. 超过 `RECONCILE_FIRST_RETRY_MS` 仍未 consumed → retry（B 通道补投，同 eventId、新 attemptId）；
 *   4. 距上次尝试不足 15s（租约）→ none（不惊群）。
 */
export function reconcileDecision(
	event: DeliveryEvent,
	view: StageView,
	attempts: DeliveryAttempt[],
	now: number,
	opts: { reconcileFirstRetryMs?: number; leaseMs?: number } = {},
): ReconcileAction {
	if (view.stage === "consumed") return { action: "none", reason: "consumed" };
	if (view.stage === "failed_delivery") return { action: "none", reason: "already-failed-delivery" };

	const deadlineMs = Date.parse(event.deliveryDeadline);
	if (Number.isFinite(deadlineMs) && now >= deadlineMs) {
		return { action: "fail_delivery", reason: `deadline-exceeded(deadline=${event.deliveryDeadline},stage=${view.stage})` };
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

	const attemptId = `${event.eventId}@${now}@${Math.random().toString(36).slice(2, 8)}`;
	return { action: "retry", reason: last ? `retry-after-${view.stage}` : "first-retry", attemptId };
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

/** 清空（测试用）。 */
export function _resetDeliveryDir(dir: string): void {
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
