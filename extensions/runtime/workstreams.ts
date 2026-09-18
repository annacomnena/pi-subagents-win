/**
 * runtime/workstreams.ts — Workstream/Task 显式库（Phase 5a，附记 A7 F18/F21/F22）
 *
 * 文件：
 *   runtime/state/workstreams/<ws-id>.json   → WorkstreamRecord
 *   runtime/state/tasks/<task-id>.json       → TaskRecord
 *   runtime/state/workstreams.audit.jsonl    → 独立审计尾迹（F21：不进 journal）
 *
 * 纪律：
 *   - 只显式创建（命令/库调用），telemetry 永不回写 taskSelector/status；
 *   - TaskRecord.status 库仅允许 pending/cancelled/completed/failed（用户意图），
 *     running/waiting/blocked 拒绝（telemetry 保留位）；
 *   - 审计：每次变更 append {at, session, op, id, summary}（session 显式传入）；
 *   - enrichment（run→taskRef/workstreamRef 派生 + 匹配方式标注）为纯函数，
 *     供命令/hydrate 调用，不写回任何文件。
 *
 * 纯库（除 state 文件 IO）、无接线、无 Pi API 依赖。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultRuntimeDir } from "./journal.ts";
import { DEFAULT_MASTER_ID, newTaskId, newWorkstreamId, type TaskId, type WorkstreamId } from "./ids.ts";
import {
	RUNTIME_TASK_STATUSES,
	WORKSTREAM_STATUSES,
	type RuntimeTaskStatus,
	type TaskRecord,
	type WorkstreamRecord,
	type WorkstreamStatus,
} from "./objects.ts";
import type { ProjectedRun } from "./projector.ts";

/** 库可手设的 Task 状态（用户意图；telemetry 位拒绝）。 */
export const MANUAL_TASK_STATUSES: readonly RuntimeTaskStatus[] = ["pending", "cancelled", "completed", "failed"];

// ── 路径 ───────────────────────────────────────────────────────────

function workstreamsDir(stateDir?: string): string {
	return join(stateDir ?? join(defaultRuntimeDir(), "state"), "workstreams");
}

function tasksDir(stateDir?: string): string {
	return join(stateDir ?? join(defaultRuntimeDir(), "state"), "tasks");
}

function auditPath(stateDir?: string): string {
	return join(stateDir ?? join(defaultRuntimeDir(), "state"), "workstreams.audit.jsonl");
}

// ── Workstream CRUD ────────────────────────────────────────────────

export interface CreateWorkstreamInput {
	mission: string;
	successCriteria?: string;
	taskSelector?: WorkstreamRecord["taskSelector"];
	wakePolicy?: WorkstreamRecord["wakePolicy"];
	session?: string;
	stateDir?: string;
}

export function createWorkstream(input: CreateWorkstreamInput): WorkstreamRecord {
	if (!input.mission || !input.mission.trim()) throw new Error("createWorkstream: mission required");
	if (input.wakePolicy && !(input.wakePolicy.cooldownMs > 0)) {
		throw new Error("createWorkstream: wakePolicy.cooldownMs must be > 0 (F20 防无限重生)");
	}
	const now = new Date().toISOString();
	const record: WorkstreamRecord = {
		version: 1,
		kind: "workstream",
		id: newWorkstreamId(),
		masterId: DEFAULT_MASTER_ID,
		mission: input.mission,
		status: "active",
		successCriteria: input.successCriteria,
		taskSelector: input.taskSelector,
		wakePolicy: input.wakePolicy,
		createdAt: now,
		updatedAt: now,
	};
	const dir = workstreamsDir(input.stateDir);
	mkdirSync(dir, { recursive: true });
	writeJsonAtomic(join(dir, `${record.id}.json`), record);
	audit(input.stateDir, input.session, "workstream.create", record.id, input.mission.slice(0, 120));
	return record;
}

export function readWorkstream(id: string, stateDir?: string): WorkstreamRecord | null {
	try {
		return JSON.parse(readFileSync(join(workstreamsDir(stateDir), `${id}.json`), "utf8")) as WorkstreamRecord;
	} catch {
		return null;
	}
}

export interface UpdateWorkstreamInput {
	mission?: string;
	status?: WorkstreamStatus;
	successCriteria?: string;
	taskSelector?: WorkstreamRecord["taskSelector"];
	wakePolicy?: WorkstreamRecord["wakePolicy"];
	session?: string;
	stateDir?: string;
}

export function updateWorkstream(id: string, patch: UpdateWorkstreamInput): WorkstreamRecord | null {
	const current = readWorkstream(id, patch.stateDir);
	if (!current) return null;
	if (patch.status !== undefined && !(WORKSTREAM_STATUSES as readonly string[]).includes(patch.status)) {
		throw new Error(`updateWorkstream: bad status ${patch.status}`);
	}
	const updated: WorkstreamRecord = {
		...current,
		mission: patch.mission ?? current.mission,
		status: patch.status ?? current.status,
		successCriteria: patch.successCriteria ?? current.successCriteria,
		taskSelector: patch.taskSelector ?? current.taskSelector,
		wakePolicy: patch.wakePolicy ?? current.wakePolicy,
		updatedAt: new Date().toISOString(),
	};
	writeJsonAtomic(join(workstreamsDir(patch.stateDir), `${id}.json`), updated);
	audit(patch.stateDir, patch.session, "workstream.update", id, `status=${updated.status}`);
	return updated;
}

export function listWorkstreams(stateDir?: string): WorkstreamRecord[] {
	const dir = workstreamsDir(stateDir);
	if (!existsSync(dir)) return [];
	const out: WorkstreamRecord[] = [];
	for (const f of readdirSync(dir)) {
		if (!f.endsWith(".json")) continue;
		try {
			out.push(JSON.parse(readFileSync(join(dir, f), "utf8")) as WorkstreamRecord);
		} catch {
			continue;
		}
	}
	return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// ── Task CRUD ──────────────────────────────────────────────────────

export interface CreateTaskInput {
	objective: string;
	externalTaskId?: string;
	workstreamId?: WorkstreamId;
	session?: string;
	stateDir?: string;
}

export function createTask(input: CreateTaskInput): TaskRecord {
	if (!input.objective || !input.objective.trim()) throw new Error("createTask: objective required");
	const now = new Date().toISOString();
	const record: TaskRecord = {
		version: 1,
		kind: "task",
		id: newTaskId(),
		workstreamId: input.workstreamId,
		externalTaskId: input.externalTaskId,
		objective: input.objective,
		status: "pending",
		createdAt: now,
		updatedAt: now,
	};
	const dir = tasksDir(input.stateDir);
	mkdirSync(dir, { recursive: true });
	writeJsonAtomic(join(dir, `${record.id}.json`), record);
	audit(input.stateDir, input.session, "task.create", record.id, input.objective.slice(0, 120));
	return record;
}

export function readTask(id: string, stateDir?: string): TaskRecord | null {
	try {
		return JSON.parse(readFileSync(join(tasksDir(stateDir), `${id}.json`), "utf8")) as TaskRecord;
	} catch {
		return null;
	}
}

/** 手设 Task 状态（仅用户意图四态；telemetry 位拒绝并抛错）。 */
export function setTaskStatus(
	id: string,
	status: RuntimeTaskStatus,
	opts: { session?: string; stateDir?: string } = {},
): TaskRecord | null {
	if (!MANUAL_TASK_STATUSES.includes(status)) {
		throw new Error(`setTaskStatus: ${status} is telemetry-reserved (F18); manual states: ${MANUAL_TASK_STATUSES.join("|")}`);
	}
	if (!(RUNTIME_TASK_STATUSES as readonly string[]).includes(status)) throw new Error(`setTaskStatus: bad status ${status}`);
	const current = readTask(id, opts.stateDir);
	if (!current) return null;
	const updated: TaskRecord = { ...current, status, updatedAt: new Date().toISOString() };
	writeJsonAtomic(join(tasksDir(opts.stateDir), `${id}.json`), updated);
	audit(opts.stateDir, opts.session, "task.status", id, status);
	return updated;
}

export function listTasks(workstreamId?: string, stateDir?: string): TaskRecord[] {
	const dir = tasksDir(stateDir);
	if (!existsSync(dir)) return [];
	const out: TaskRecord[] = [];
	for (const f of readdirSync(dir)) {
		if (!f.endsWith(".json")) continue;
		try {
			const t = JSON.parse(readFileSync(join(dir, f), "utf8")) as TaskRecord;
			if (!workstreamId || t.workstreamId === workstreamId) out.push(t);
		} catch {
			continue;
		}
	}
	return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// ── Enrichment（纯函数，派生不落盘）─────────────────────────────────

export type RefMatch = "runSubject" | "externalTaskId";

export interface RunRefs {
	taskRef?: TaskId;
	workstreamRef?: WorkstreamId;
	/** 匹配方式标注（F18：label 匹配明知 best-effort） */
	match?: RefMatch;
}

/**
 * run 投影 → taskRef/workstreamRef 派生：
 *   runSubject 精确匹配优先；externalTaskId label 匹配次之（best-effort 标注）。
 * tasks/workstreams 由调用方一次读入（命令/hydrate 侧）。
 */
export function enrichRunRefs(
	run: Pick<ProjectedRun, "subject" | "externalTaskId">,
	tasks: Pick<TaskRecord, "id" | "externalTaskId" | "workstreamId">[],
	workstreams: Pick<WorkstreamRecord, "id" | "taskSelector">[],
): RunRefs {
	// 1) runSubject 精确：selector.runSubjects 命中
	for (const ws of workstreams) {
		if (ws.taskSelector?.runSubjects?.includes(run.subject)) {
			return { workstreamRef: ws.id, match: "runSubject" };
		}
	}
	// 2) externalTaskId label：task 记录直连，其次 workstream selector
	if (run.externalTaskId) {
		const task = tasks.find((t) => t.externalTaskId === run.externalTaskId);
		if (task) {
			return { taskRef: task.id, workstreamRef: task.workstreamId, match: "externalTaskId" };
		}
		for (const ws of workstreams) {
			if (ws.taskSelector?.externalTaskIds?.includes(run.externalTaskId)) {
				return { workstreamRef: ws.id, match: "externalTaskId" };
			}
		}
	}
	return {};
}

// ── 审计尾迹（F21）─────────────────────────────────────────────────

export interface WorkstreamAuditEntry {
	at: string;
	session?: string;
	op: string;
	id: string;
	summary?: string;
}

function audit(stateDir: string | undefined, session: string | undefined, op: string, id: string, summary?: string): void {
	try {
		const dir = join(stateDir ?? join(defaultRuntimeDir(), "state"));
		mkdirSync(dir, { recursive: true });
		const entry: WorkstreamAuditEntry = { at: new Date().toISOString(), session, op, id, summary };
		appendFileSync(auditPath(stateDir), `${JSON.stringify(entry)}\n`, "utf8");
	} catch {
		/* 审计 best-effort，不阻塞业务写（写本身失败则抛——调用方感知） */
	}
}

/** 读审计尾迹（tolerant）。 */
export function listAudit(stateDir?: string, limit = 100): WorkstreamAuditEntry[] {
	return readAuditLines(stateDir, limit);
}

/** 审计写入口（wake 等模块复用 F21 尾迹；调用方传 session 显式归属）。 */
export function auditWorkstreamOp(stateDir: string | undefined, session: string | undefined, op: string, id: string, summary?: string): void {
	audit(stateDir, session, op, id, summary);
}

function readAuditLines(stateDir: string | undefined, limit: number): WorkstreamAuditEntry[] {
	let lines: string[];
	try {
		lines = readFileSync(auditPath(stateDir), "utf8").trim().split("\n").filter(Boolean);
	} catch {
		return [];
	}
	const out: WorkstreamAuditEntry[] = [];
	for (const line of lines.slice(-limit)) {
		try {
			out.push(JSON.parse(line) as WorkstreamAuditEntry);
		} catch {
			continue;
		}
	}
	return out;
}

// ── 内部 ───────────────────────────────────────────────────────────

function writeJsonAtomic(path: string, value: unknown): void {
	const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}
