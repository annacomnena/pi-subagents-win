/**
 * runtime/session-control.ts — 会话**控制指令**盘面（2026-10-20，停止按钮）。
 *
 * ## 为什么需要独立通道
 * GUI/daemon 是**独立进程**，没有 pi 的 `ExtensionContext`；而「停止当前 turn」只能由
 * 会话进程内的 `ctx.abort()` 完成（`dist/core/extensions/types.d.ts:242`）。
 * 现有 `message-outbox` 是**封闭**的单一命令通道（`OUTBOX_COMMAND_TYPE = "session.message"`，
 * 且已被 delivery-reconciler / wechat / GUI outbox 主题共用），把 abort 塞进去会牵动
 * 多个既有消费者 ⇒ 单独开一个只服务「控制类」指令的盘面，互不影响。
 *
 * ## 状态机（封闭，与 outbox 同纪律）
 *   pending → running → done | failed
 * - `pending`：daemon 写入，等会话进程领取
 * - `running`：会话进程已领取（防双执行；`running` 超龄由领取方按 stale 处理）
 * - `done` / `failed`：终态，不再迁移
 *
 * ## 幂等
 * 文件名 = `sha256(commandKey)`（与 `commands/`、`message-outbox/` 同范式），同 commandKey
 * 重复写入不产生第二条（已存在则原样保留，返回已有 id）。
 *
 * ## 红线
 * - 纯库：无 pi API 依赖；读 tolerant never-throw，写失败向上抛（调用方收敛为 io-error）。
 * - 请求正文只存**动作与命令键**，不存任何会话内容。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultRuntimeDir } from "./journal.ts";

/** 控制动作白名单（封闭；新增动作必须同时改这里 + 会话进程的 handler）。 */
export const CONTROL_ACTIONS = ["abort"] as const;
export type ControlAction = (typeof CONTROL_ACTIONS)[number];

export const CONTROL_STATUSES = ["pending", "running", "done", "failed"] as const;
export type ControlStatus = (typeof CONTROL_STATUSES)[number];

/** `running` 超过此时长视为领取方已死（可被重新领取）。 */
export const CONTROL_RUNNING_STALE_MS = 60_000;

/** 控制指令结果词表（GUI 直接展示；新增需同步 GUI 文案）。 */
export type ControlResult =
	| "aborted" // 已调用 ctx.abort()（当时确实在流式）
	| "not-streaming" // 当时已空闲（明确告知，不静默 no-op）
	| "stale-ctx" // 会话进程的 ctx 已失效（例如 /reload 之后旧 runner）
	| "unknown-action"; // 动作不在白名单（防旧 GUI 打新 daemon）

export interface ControlRequest {
	version: 1;
	/** = sha256(`session.control:<commandKey>`) 前 32 hex（文件名同名去后缀）。 */
	id: string;
	sessionId: string;
	action: ControlAction;
	commandKey: string;
	status: ControlStatus;
	requestedAt: string;
	/** 领取方标识（`session-control:<sid>`），诊断用。 */
	claimedBy?: string;
	claimedAt?: string;
	completedAt?: string;
	result?: ControlResult;
	/** failed 时的错误摘要（≤512 字节）。 */
	error?: string;
}

/**
 * 控制盘面目录 = `<stateDir>/session-control`（与 `message-outbox` 同层级口径：
 * 参数是**state 目录**，不是 runtime 目录 —— `command-executor` 的 `stateRoot(opts)`
 * 直接传进来即可）。
 */
export function controlDir(stateDir: string): string {
	return join(stateDir, "session-control");
}

/** 缺省控制盘面目录（`<runtimeDir>/state/session-control`）。 */
export function defaultControlDir(): string {
	return controlDir(join(defaultRuntimeDir(), "state"));
}

export function controlIdFor(commandKey: string): string {
	return createHash("sha256").update(`session.control:${commandKey}`, "utf8").digest("hex").slice(0, 32);
}

export function controlRequestPath(id: string, dir: string = defaultControlDir()): string {
	return join(dir, `${id}.json`);
}

/** 构造一条 pending 请求（纯函数，不落盘）。 */
export function newControlRequest(input: {
	sessionId: string;
	action: ControlAction;
	commandKey: string;
	now?: Date;
}): ControlRequest {
	return {
		version: 1,
		id: controlIdFor(input.commandKey),
		sessionId: input.sessionId,
		action: input.action,
		commandKey: input.commandKey,
		status: "pending",
		requestedAt: (input.now ?? new Date()).toISOString(),
	};
}

/** 原子写（tmp + rename）。同 id 已存在且非 pending → 保留原样（幂等：不覆盖已完成的终态）。 */
export function writeControlRequest(req: ControlRequest, dir: string = defaultControlDir()): { written: boolean; existing?: ControlRequest } {
	mkdirSync(dir, { recursive: true });
	const path = controlRequestPath(req.id, dir);
	const existing = readControlRequest(req.id, dir);
	if (existing !== null && existing.status !== "pending") return { written: false, existing };
	if (existing !== null && existing.status === "pending") return { written: false, existing };
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(req), "utf8");
	renameSync(tmp, path);
	return { written: true };
}

/** 读一条（tolerant：不存在/坏 JSON → null）。 */
export function readControlRequest(id: string, dir: string = defaultControlDir()): ControlRequest | null {
	try {
		const raw = readFileSync(controlRequestPath(id, dir), "utf8");
		const parsed = JSON.parse(raw) as unknown;
		if (typeof parsed !== "object" || parsed === null) return null;
		const rec = parsed as ControlRequest;
		if (rec.version !== 1 || typeof rec.id !== "string") return null;
		return rec;
	} catch {
		return null;
	}
}

/**
 * 列出某会话的请求（按 requestedAt 倒序）。
 * tolerant：坏文件跳过；目录不存在 → 空数组。
 */
export function listControlRequests(sessionId: string, dir: string = defaultControlDir()): ControlRequest[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const out: ControlRequest[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue; // 排除 .tmp 原子写中间态
		const id = name.slice(0, -".json".length);
		const rec = readControlRequest(id, dir);
		if (rec === null) continue;
		if (rec.sessionId !== sessionId) continue;
		out.push(rec);
	}
	out.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
	return out;
}

/** 某会话最近一条请求（无 → null）。 */
export function latestControlRequest(sessionId: string, dir: string = defaultControlDir()): ControlRequest | null {
	return listControlRequests(sessionId, dir)[0] ?? null;
}

/**
 * 领取（pending → running）。
 * - 已是 running 且未超龄 → null（别人在飞）
 * - 已是 running 但超龄 → 重新领取（原领取方多半已死）
 * - 终态 → null
 */
export function claimControlRequest(
	id: string,
	claimedBy: string,
	opts: { dir?: string; now?: Date } = {},
): ControlRequest | null {
	const dir = opts.dir ?? defaultControlDir();
	const now = opts.now ?? new Date();
	const cur = readControlRequest(id, dir);
	if (cur === null) return null;
	if (cur.status === "done" || cur.status === "failed") return null;
	if (cur.status === "running") {
		const claimedAt = cur.claimedAt !== undefined ? Date.parse(cur.claimedAt) : Number.NaN;
		const age = Number.isNaN(claimedAt) ? Number.POSITIVE_INFINITY : now.getTime() - claimedAt;
		if (age < CONTROL_RUNNING_STALE_MS) return null;
	}
	const next: ControlRequest = { ...cur, status: "running", claimedBy, claimedAt: now.toISOString() };
	const path = controlRequestPath(id, dir);
	const tmp = `${path}.${process.pid}.tmp`;
	try {
		writeFileSync(tmp, JSON.stringify(next), "utf8");
		renameSync(tmp, path);
	} catch {
		try {
			rmSync(tmp, { force: true });
		} catch {
			/* ignore */
		}
		return null;
	}
	return next;
}

/** 落终态（done/failed）。已终态 → 不覆盖（返回 false）。 */
export function completeControlRequest(
	id: string,
	outcome: { ok: true; result: ControlResult } | { ok: false; error: string },
	opts: { dir?: string; now?: Date } = {},
): boolean {
	const dir = opts.dir ?? defaultControlDir();
	const now = opts.now ?? new Date();
	const cur = readControlRequest(id, dir);
	if (cur === null) return false;
	if (cur.status === "done" || cur.status === "failed") return false;
	const next: ControlRequest = outcome.ok
		? { ...cur, status: "done", result: outcome.result, completedAt: now.toISOString() }
		: { ...cur, status: "failed", error: outcome.error.slice(0, 512), completedAt: now.toISOString() };
	const path = controlRequestPath(id, dir);
	const tmp = `${path}.${process.pid}.tmp`;
	try {
		writeFileSync(tmp, JSON.stringify(next), "utf8");
		renameSync(tmp, path);
		return true;
	} catch {
		try {
			rmSync(tmp, { force: true });
		} catch {
			/* ignore */
		}
		return false;
	}
}

/** 目录是否存在（daemon 侧读投影前先判，避免每次 mkdir）。 */
export function controlDirExists(dir: string = defaultControlDir()): boolean {
	return existsSync(dir);
}
