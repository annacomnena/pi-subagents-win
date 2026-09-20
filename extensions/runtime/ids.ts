/**
 * runtime/ids.ts — Persistent Object 稳定 ID（Phase 1A，设计稿 §5）
 *
 * 目标：为 Master / Workstream / Task / Run / Envelope 提供 branded string 身份
 * 与统一生成格式，让后续所有 Runtime 模块共享同一个 identity namespace。
 *
 * 原则（设计稿 §5）：
 *   - identity namespace 稳定 > ID 算法高级：不引入 UUID framework，
 *     沿用仓库现有 `tab_<base36 时间戳>_<随机>` 的同族格式。
 *   - 物理 ID 不被重命名：现有 `tab_*` / `tfl-*` runId 原样保留，
 *     Runtime 通过 Logical Address 引用它们（run://tab/<tabRunId> 等），
 *     不生成第二套平行 Run ID。
 *   - Master 第一版只有 `master_default`（不做多 Master）。
 */

// ── Branded ID 类型 ────────────────────────────────────────────────

export type MasterId = string & { readonly __brand: "MasterId" };
export type WorkstreamId = string & { readonly __brand: "WorkstreamId" };
export type TaskId = string & { readonly __brand: "TaskId" };
export type RunId = string & { readonly __brand: "RunId" };
export type EnvelopeId = string & { readonly __brand: "EnvelopeId" };

// ── 生成原语 ───────────────────────────────────────────────────────

/** base36 随机段：保证精确长度（Math.random 可能产生短串，循环补齐）。 */
function rand36(len: number): string {
	let s = "";
	while (s.length < len) s += Math.random().toString(36).slice(2);
	return s.slice(0, len);
}

function stampAndRand(now: Date): string {
	return `${now.getTime().toString(36)}_${rand36(6)}`;
}

// ── branded cast ───────────────────────────────────────────────────

export function asMasterId(s: string): MasterId {
	return s as MasterId;
}
export function asWorkstreamId(s: string): WorkstreamId {
	return s as WorkstreamId;
}
export function asTaskId(s: string): TaskId {
	return s as TaskId;
}
export function asRunId(s: string): RunId {
	return s as RunId;
}
export function asEnvelopeId(s: string): EnvelopeId {
	return s as EnvelopeId;
}

// ── Master：第一版固定单例 ─────────────────────────────────────────

/** 逻辑 Master 的稳定标识（Session rollover 不改变它，设计稿 §0/§29）。 */
export const DEFAULT_MASTER_ID = asMasterId("master_default");

// ── 各对象 ID 生成 ─────────────────────────────────────────────────

/** ws_<base36 时间戳>_<6 位随机>。 */
export function newWorkstreamId(now: Date = new Date()): WorkstreamId {
	return asWorkstreamId(`ws_${stampAndRand(now)}`);
}

/** task_<base36 时间戳>_<6 位随机>。注意与现有外派 taskId（workflow 编号等）语义无关——桥接走 TaskRecord.externalTaskId。 */
export function newTaskId(now: Date = new Date()): TaskId {
	return asTaskId(`task_${stampAndRand(now)}`);
}

/** run_<base36 时间戳>_<6 位随机>。Runtime 自有 Run 身份；现有 tab/tfl runId 不迁移。 */
export function newRunId(now: Date = new Date()): RunId {
	return asRunId(`run_${stampAndRand(now)}`);
}

/** Envelope 前缀白名单：Phase 1 只产生 evt_；msg_/cmd_ 留给 Phase 3（设计稿 §8/§26）。 */
export type EnvelopeIdPrefix = "evt" | "msg" | "cmd";

const ENVELOPE_PREFIXES: readonly EnvelopeIdPrefix[] = ["evt", "msg", "cmd"];

/** <prefix>_<base36 时间戳>_<6 位随机>；非法前缀抛错（namespace 不允许第三方扩展）。 */
export function newEnvelopeId(prefix: EnvelopeIdPrefix = "evt", now: Date = new Date()): EnvelopeId {
	if (!ENVELOPE_PREFIXES.includes(prefix)) {
		throw new Error(`newEnvelopeId: prefix must be one of ${ENVELOPE_PREFIXES.join("|")}, got "${prefix}"`);
	}
	return asEnvelopeId(`${prefix}_${stampAndRand(now)}`);
}
