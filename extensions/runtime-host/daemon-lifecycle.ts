/**
 * runtime-host/daemon-lifecycle.ts — Runtime Daemon 单实例 ensure / 接管 / 停止（第一切片）
 *
 * 依据 plans/0923_runtime_daemon_final_plan.md §2（进程寿命/发现/接管契约）与 §9：
 *   - 先取跨进程独占锁，再绑定端口/写账（锁文件 `<host.json>.lock`，exclusive-create 原子；
 *     Windows named mutex 的同等原语后补——本切片以 pid 存活判 stale，局限已在 G0 备注）。
 *   - 锁内容 `{kind,pid,instanceId,runtimeId,acquiredAt}`；kind=daemon（daemon 自持，
 *     随进程生死）/ handoff（ensure  spawned 交接期父进程短持，子 ready 后释放）。
 *   - 复用必须本次挑战成功（identity.runLocalChallenge：nonce+HMAC 对 token），
 *     legacy 无 token 文件走 pid+startedAt+runtimeId 比对分支并注记（过渡兼容）。
 *   - 接管 fail-closed：dead pid/坏文件才在确已持锁后重建；pid 活但超时（stale）/
 *     身份不符/锁被活持有人占用 → `uncertain`，**禁止**按 host.json pid 盲目 kill
 *     或覆盖活锁。 wedged daemon 恢复路径：确认归属后 `stopRuntimeDaemon({force:true})`
 *    （legacy 裸 kill 分支，显式opt）再 ensure。
 *   - spawn 形状 §2.1：`{detached:true, stdio:'ignore', windowsHide:false}` + `unref()`
 *     （见 defaultSpawnDaemon 注释：DETACHED_PROCESS 与 CREATE_NO_WINDOW 不可叠用）。
 *
 * 本模块不碰任何共享写账本（mailbox/journal/receipts/timers/registry），只读写
 * host.json/host.lock 发现文件。测试经 opts 全注入（spawn/wait/now），不碰真实目录。
 */

import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	classifyHost,
	isProcessAlive,
	readHostInfo,
	removeHostInfo,
	type HostInfo,
} from "./discovery.ts";
import { defaultRuntimeDir } from "../runtime/journal.ts";
import { runtimeIdForDir, runLocalChallenge, type ChallengeMeta } from "./identity.ts";
import { traceSpawn } from "../spawn-trace.ts";

// ── 锁文件 ──────────────────────────────────────────────────────────

export type RuntimeLockKind = "daemon" | "handoff";

export interface RuntimeLock {
	kind: RuntimeLockKind;
	pid: number;
	instanceId: string;
	runtimeId: string;
	acquiredAt: string;
}

/** 锁路径：`<host.json>.lock`（与 host.json 同目录；hostPath 注入即隔离）。 */
export function lockPathFor(hostPath: string): string {
	return `${hostPath}.lock`;
}

/** 读锁（缺失/坏文件/字段缺 → null = 视为空闲；调用方另行按 host 活性 fail-closed）。 */
export function readRuntimeLock(lockPath: string): RuntimeLock | null {
	try {
		if (!existsSync(lockPath)) return null;
		const v = JSON.parse(readFileSync(lockPath, "utf8")) as Record<string, unknown>;
		if (
			typeof v !== "object" || v === null ||
			(v.kind !== "daemon" && v.kind !== "handoff") ||
			typeof v.pid !== "number" || !Number.isInteger(v.pid) || v.pid <= 0 ||
			typeof v.instanceId !== "string" || v.instanceId.length === 0 ||
			typeof v.runtimeId !== "string" || v.runtimeId.length === 0
		) {
			return null;
		}
		return {
			kind: v.kind,
			pid: v.pid,
			instanceId: v.instanceId,
			runtimeId: v.runtimeId,
			acquiredAt: typeof v.acquiredAt === "string" ? v.acquiredAt : "",
		};
	} catch {
		return null;
	}
}

/** 锁持有人是否存活（同进程 pid 视为自持=活，由调用方按 kind 决策）。 */
export function lockHolderAlive(lock: RuntimeLock | null): boolean {
	if (!lock) return false;
	return isProcessAlive(lock.pid);
}

/**
 * 原子取锁（exclusive-create；成功 → 我们持有）。
 * 失败 → { acquired:false, existing }（existing=null 含坏文件/竞争窗口，调用方重读）。
 */
export function acquireRuntimeLock(
	lockPath: string,
	entry: RuntimeLock,
): { acquired: boolean; existing: RuntimeLock | null } {
	const body = `${JSON.stringify(entry, null, 2)}\n`;
	try {
		const fd = openSync(lockPath, "wx", 0o600);
		try {
			writeFileSync(fd, body, "utf8");
		} finally {
			try {
				closeSync(fd);
			} catch {
				/* ignore */
			}
		}
		return { acquired: true, existing: null };
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
			return { acquired: false, existing: readRuntimeLock(lockPath) };
		}
		return { acquired: false, existing: readRuntimeLock(lockPath) };
	}
}

/** 条件释锁（内容 instanceId 仍是我们才删，防误删接管后的新锁）。 */
export function releaseRuntimeLock(lockPath: string, instanceId: string): boolean {
	try {
		const cur = readRuntimeLock(lockPath);
		if (!cur || cur.instanceId !== instanceId) return false;
		rmSync(lockPath, { force: true });
		return true;
	} catch {
		return false;
	}
}

/** 坏锁/僵尸锁清理后取锁（仅持锁确认路径调用；活锁永不强删）。 */
function stealStaleLock(lockPath: string, entry: RuntimeLock): boolean {
	try {
		rmSync(lockPath, { force: true });
	} catch {
		return false;
	}
	return acquireRuntimeLock(lockPath, entry).acquired;
}

export function newHandoffId(now: Date = new Date()): string {
	return `handoff_${now.getTime().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── spawn（§2.1 形状） ──────────────────────────────────────────────

export interface DaemonSpawnHandle {
	pid?: number;
	kill: () => void;
}

function defaultSpawnDaemon(o: { serverPath: string; runtimeDir: string }): DaemonSpawnHandle {
	// §2.1：detached:true（DETACHED_PROCESS）→ daemon 活过派生它的 WT 标签页/窗口关闭；
	// windowsHide 必须 false：DETACHED_PROCESS 与 CREATE_NO_WINDOW（windowsHide:true）
	// 在 Win32 不可叠用——同用时 CREATE_NO_WINDOW 被忽略，子进程又回到无控制台、
	// 短命孙进程各自 alloc 新控制台的老路（此前 windowsHide:true 方案见 git 历史）。
	// 空壳 WT 风险改由 G0 真机验证（关标签/关窗口 0 新增窗口，scripts/verify-runtime-g0.ps1）。
	// unref：pi 退出不连带杀 daemon（隐藏与否属于 daemon 自身控制台）。
	traceSpawn("console-child", `runtime-daemon spawn exec=${process.execPath} server=${o.serverPath}`);
	const child = spawn(process.execPath, ["--experimental-strip-types", o.serverPath], {
		detached: true,
		stdio: "ignore",
		windowsHide: false,
		cwd: dirname(o.serverPath),
		env: { ...process.env, PI_RUNTIME_DIR: o.runtimeDir },
	});
	child.unref();
	return {
		pid: child.pid,
		kill: () => {
			try {
				child.kill();
			} catch {
				/* ignore */
			}
		},
	};
}

// ── ensure ──────────────────────────────────────────────────────────

export interface DaemonEnsureOptions {
	/** 缺省 defaultRuntimeDir()；hostPath 显式而 runtimeDir 缺省 → 取 hostPath 所在目录。 */
	runtimeDir?: string;
	hostPath?: string;
	serverPath?: string;
	waitMs?: number;
	challengeTimeoutMs?: number;
	spawn?: (o: { serverPath: string; runtimeDir: string }) => DaemonSpawnHandle;
	now?: () => string;
}

export interface DaemonEnsureResult {
	ok: boolean;
	already?: boolean;
	/** fail-closed：未确权，不复用、不重建、不 kill。 */
	uncertain?: boolean;
	note?: string;
	info: HostInfo | null;
	url: string | null;
	pid: number | null;
	port: number | null;
	error?: string;
}

/** 同源静态 GUI 地址（daemon 自托管 gui/dist，无 vite）。 */
export function daemonUrlFor(port: number): string {
	return `http://127.0.0.1:${port}/`;
}

function defaultServerPath(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "server.ts");
}

function expectedMetaFor(file: HostInfo, runtimeId: string): { meta: ChallengeMeta; legacy: boolean } {
	if (typeof file.token === "string" && file.token.length > 0) {
		return {
			meta: {
				instanceId: file.instanceId,
				runtimeId: file.runtimeId ?? runtimeId,
				protocolVersion: file.protocolVersion,
				releaseId: file.releaseId ?? "rel_unknown",
				schemaVersion: file.schemaVersion ?? 1,
				processStartIdentity: file.processStartIdentity ?? `unknown@${file.startedAt}`,
			},
			legacy: false,
		};
	}
	return {
		meta: {
			instanceId: file.instanceId,
			runtimeId: file.runtimeId ?? runtimeId,
			protocolVersion: file.protocolVersion,
			releaseId: file.releaseId ?? "rel_unknown",
			schemaVersion: file.schemaVersion ?? 1,
			processStartIdentity: file.processStartIdentity ?? `unknown@${file.startedAt}`,
		},
		legacy: true,
	};
}

/** legacy 无 token 文件的弱确权：pid+startedAt+runtimeId 全等（过渡兼容，注记返回）。 */
function legacyIdentityMatches(file: HostInfo, runtimeId: string): boolean {
	if (!isProcessAlive(file.pid)) return false;
	if (typeof file.runtimeId === "string" && file.runtimeId !== runtimeId) return false;
	return true;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function ensureRuntimeDaemon(opts: DaemonEnsureOptions = {}): Promise<DaemonEnsureResult> {
	const runtimeDir = resolve(
		opts.runtimeDir ?? (opts.hostPath ? dirname(resolve(opts.hostPath)) : defaultRuntimeDir()),
	);
	const runtimeId = runtimeIdForDir(runtimeDir);
	const hostPath = opts.hostPath ?? join(runtimeDir, "host.json");
	const lockPath = lockPathFor(hostPath);
	const serverPath = opts.serverPath ?? defaultServerPath();
	const waitMs = opts.waitMs ?? 8000;
	const now = opts.now ?? (() => new Date().toISOString());
	const spawnFn = opts.spawn ?? defaultSpawnDaemon;

	const fail = (error: string, extra: Partial<DaemonEnsureResult> = {}): DaemonEnsureResult => ({
		ok: false,
		info: null,
		url: null,
		pid: null,
		port: null,
		error,
		...extra,
	});

	// 确权复用：classify alive + runtimeId 一致 +（有 token：本次挑战成功；无：legacy 弱确权）
	const tryReuse = async (file: HostInfo): Promise<DaemonEnsureResult | null> => {
		if (file.runtimeId && file.runtimeId !== runtimeId) {
			return fail(`身份不符：host.json runtimeId=${file.runtimeId} ≠ 本目录 ${runtimeId}（fail-closed，未复用）`, { uncertain: true, info: file, pid: file.pid, port: file.port });
		}
		const state = await classifyHost(file, { timeoutMs: opts.challengeTimeoutMs ?? 2000 });
		if (state === "dead") {
			// 仅放行 dead：不可复用 ≠ 不确定——返回 null（=「不可复用，继续往下走」）。
			// 由**已持锁**的主路径（下方「重读 → dead → 僵尸接管重建」分支）决策；
			// stale（pid 活但探活超时）/身份不符/挑战失败/legacy 弱确权失败仍 fail-closed。
			return null;
		}
		if (state !== "alive") {
			return fail(`host 不可确权（${state}）：fail-closed，未复用、未重建、未 kill`, { uncertain: true, info: file, pid: file.pid, port: file.port });
		}
		const { meta, legacy } = expectedMetaFor(file, runtimeId);
		if (!legacy) {
			const ch = await runLocalChallenge({ hostPath, port: file.port, expected: meta, timeoutMs: opts.challengeTimeoutMs ?? 3000 });
			if (!ch.ok) {
				return fail(`身份挑战失败（${ch.reason}）：fail-closed，未复用`, { uncertain: true, info: file, pid: file.pid, port: file.port });
			}
			return { ok: true, already: true, info: file, url: daemonUrlFor(file.port), pid: file.pid, port: file.port };
		}
		if (!legacyIdentityMatches(file, runtimeId)) {
			return fail("legacy host.json 弱确权失败（pid/启动身份不一致）：fail-closed", { uncertain: true, info: file, pid: file.pid, port: file.port });
		}
		return { ok: true, already: true, note: "legacy host.json（无 token）：pid+startedAt 弱确权复用", info: file, url: daemonUrlFor(file.port), pid: file.pid, port: file.port };
	};

	// A) 锁被其它活进程持有 → 只读确权路径（绝不 spawn、不删锁）
	const held = readRuntimeLock(lockPath);
	if (held && held.pid !== process.pid && lockHolderAlive(held)) {
		if (held.kind === "handoff") {
			// 另一 ensure 正在交接：等它发布的新文件（等锁释放+新 host.json），超时 → uncertain
			const t0 = Date.now();
			const startedAt0 = now();
			for (;;) {
				const cur = readHostInfo(hostPath);
				if (cur && cur.startedAt >= startedAt0 && isProcessAlive(cur.pid)) {
					const r = await tryReuse(cur);
					if (r) return r;
					return fail("交接后文件仍不可确权：fail-closed", { uncertain: true, info: cur, pid: cur.pid, port: cur.port });
				}
				const still = readRuntimeLock(lockPath);
				if ((!still || !lockHolderAlive(still)) && Date.now() - t0 > 2000) {
					break; // 交接方已退且无新文件 → 落到 B 路径重决策
				}
				if (Date.now() - t0 > waitMs) {
					return fail("等待交接超时：fail-closed（未 kill 交接方）", { uncertain: true });
				}
				await sleep(100);
			}
		} else {
			const cur = readHostInfo(hostPath);
			if (!cur) {
				return fail("锁被活 daemon 持有但 host.json 缺失：fail-closed（未碰活锁）", { uncertain: true });
			}
			const r = await tryReuse(cur);
			if (r) return r;
			return fail("活锁占用且身份不可确权：fail-closed", { uncertain: true, info: cur, pid: cur.pid, port: cur.port });
		}
	}

	// B) 取 handoff 锁后决策（确已持锁；race 输了 → 回 A 只读路径）
	const handoff: RuntimeLock = { kind: "handoff", pid: process.pid, instanceId: newHandoffId(), runtimeId, acquiredAt: now() };
	let ac = acquireRuntimeLock(lockPath, handoff);
	if (!ac.acquired && ac.existing) {
		// 取锁失败且读到现有锁：仅**可证持有人已死**的孤儿/僵尸锁（daemon 崩溃遗留）才清抢，
		// 使 dead host.json 能进入下方持锁重建（否则永远停在 fail-closed = 用户症状根因）。
		// 重读复核 instanceId + 仍死才 rm（防误删他方新锁）；stealStaleLock 语义不变：活锁永不强删。
		// 活持有人（真竞争）与坏锁（不可证死）→ 仍走下方 fail-closed，不 kill 不覆盖。
		const cur = readRuntimeLock(lockPath);
		if (
			cur && cur.instanceId === ac.existing.instanceId &&
			!lockHolderAlive(cur) && stealStaleLock(lockPath, handoff)
		) {
			ac = { acquired: true, existing: null };
		}
	}
	if (!ac.acquired) {
		const cur = readHostInfo(hostPath);
		if (cur) {
			const r = await tryReuse(cur);
			if (r) return r;
		}
		return fail("取锁竞争失败且无可确权实例：fail-closed", { uncertain: true, info: cur, pid: cur?.pid ?? null, port: cur?.port ?? null });
	}
	try {
		const cur = readHostInfo(hostPath);
		if (cur) {
			const state = await classifyHost(cur, { timeoutMs: 1500 });
			if (state === "alive") {
				// 锁空闲但服务活着（pre-lock 旧 daemon 或锁丢失）：挑战确权后复用，不重建
				const r = await tryReuse(cur);
				if (r) return r;
				return fail("服务活着但身份不可确权：fail-closed（未覆盖活服务）", { uncertain: true, info: cur, pid: cur.pid, port: cur.port });
			}
			if (state === "stale") {
				// pid 活但服务面超时 → 可能是陌生进程（pid 复用）：fail-closed，不覆盖
				return fail(`host 超时（pid=${cur.pid} 存活但探活失败）：fail-closed；禁止覆盖，确认归属后 stop --force（legacy）再重试`, { uncertain: true, info: cur, pid: cur.pid, port: cur.port });
			}
			// dead：僵尸文件 → 持锁重建（仅本分支 spawn）
		}

		const zombieNote = cur
			? `检测到僵尸，已接管（原 pid=${cur.pid} dead，持锁重建）`
			: null;
		const startedAt0 = now();
		let handle: DaemonSpawnHandle;
		try {
			handle = spawnFn({ serverPath, runtimeDir });
		} catch (e) {
			return fail(`spawn failed: ${e instanceof Error ? e.message : String(e)}`);
		}
		const t0 = Date.now();
		for (;;) {
			const fresh = readHostInfo(hostPath);
			if (fresh && fresh.startedAt >= startedAt0 && isProcessAlive(fresh.pid)) {
				const r = await tryReuse(fresh);
				if (r && r.ok) {
					return { ...r, already: false, ...(zombieNote ? { note: zombieNote } : {}) };
				}
				try {
					handle.kill();
				} catch {
					/* ignore */
				}
				return fail(`新实例确权失败（${r?.error ?? "dead：spawn 后新实例未存活"}）：已要求回收子进程，fail-closed`, { uncertain: true, info: fresh, pid: fresh.pid, port: fresh.port });
			}
			if (Date.now() - t0 > waitMs) {
				try {
					handle.kill();
				} catch {
					/* ignore */
				}
				return fail(`timeout ${waitMs}ms：host.json 未就绪（server 可能启动失败）`, { info: readHostInfo(hostPath) });
			}
			await sleep(100);
		}
	} finally {
		releaseRuntimeLock(lockPath, handoff.instanceId);
	}
}

// ── stop（fail-closed；force = legacy 裸 kill 分支，显式 opt）────────

export interface DaemonStopOptions {
	hostPath?: string;
	runtimeDir?: string;
	/** true = 沿用旧语义（kill host.json pid + 删文件），用于 wedged 实例的人工恢复。 */
	force?: boolean;
	timeoutMs?: number;
}

export interface DaemonStopResult {
	stopped: boolean;
	/** fail-closed：未确权停机，不 kill 不删。 */
	uncertain?: boolean;
	legacy?: boolean;
	info: HostInfo | null;
	reason?: string;
}

export async function stopRuntimeDaemon(opts: DaemonStopOptions = {}): Promise<DaemonStopResult> {
	const hostPath = opts.hostPath ?? join(resolve(opts.runtimeDir ?? defaultRuntimeDir()), "host.json");
	const lockPath = lockPathFor(hostPath);
	const info = readHostInfo(hostPath);
	if (!info) return { stopped: false, info: null, reason: "未启动（无 host.json 或不可解析）" };

	const conditionalCleanup = (): void => {
		// 条件删：文件仍是同一 instanceId 才删（防误删接管后的新文件）；锁同理
		try {
			const cur = readHostInfo(hostPath);
			if (cur && cur.instanceId === info.instanceId) removeHostInfo(hostPath);
		} catch {
			/* ignore */
		}
		try {
			const lock = readRuntimeLock(lockPath);
			if (lock && lock.instanceId === info.instanceId) rmSync(lockPath, { force: true });
			else if (lock && !lockHolderAlive(lock)) {
				// 僵尸锁兜底（持有人已死）：清掉，防下次 ensure 误判
				try {
					rmSync(lockPath, { force: true });
				} catch {
					/* ignore */
				}
			}
		} catch {
			/* ignore */
		}
	};

	if (opts.force === true) {
		// legacy 分支：裸 kill + 删文件（wedged 实例人工恢复用；调用方已确认归属）
		try {
			process.kill(info.pid);
		} catch {
			/* pid 可能已退出——继续清理文件 */
		}
		conditionalCleanup();
		return { stopped: true, legacy: true, info };
	}

	const lock = readRuntimeLock(lockPath);
	if (lock && lockHolderAlive(lock) && lock.pid !== info.pid && lock.pid !== process.pid) {
		// 锁被第三方活进程持有 → 不碰（既不 kill 也不删）
		return { stopped: false, uncertain: true, info, reason: `锁被未知活进程持有（pid=${lock.pid} ${lock.kind}）：fail-closed，未 kill 未删` };
	}
	const state = await classifyHost(info, { timeoutMs: opts.timeoutMs });
	if (state === "alive") {
		if (lock && lockHolderAlive(lock) && lock.kind === "daemon" && lock.pid !== info.pid) {
			return { stopped: false, uncertain: true, info, reason: "daemon 锁持有人与 host.json pid 不一致（疑似 pid 复用）：fail-closed" };
		}
		try {
			process.kill(info.pid);
		} catch {
			/* 竞争窗口已退出——继续条件清理 */
		}
		conditionalCleanup();
		return { stopped: true, info };
	}
	if (state === "dead") {
		// 僵尸文件：只清理文件，不 kill（进程本就不存在；也不按 pid 补 kill——防 pid 复用误杀）
		conditionalCleanup();
		return { stopped: true, info, reason: "僵尸文件已清理（进程本就不存在，未 kill）" };
	}
	// stale：pid 活但服务面不可用 → 可能是陌生进程 → fail-closed（提示 force 恢复路径）
	return { stopped: false, uncertain: true, info, reason: `host 超时（pid=${info.pid} 存活但探活失败）：fail-closed，未 kill；确认归属后用 force 重试` };
}

export interface DaemonRestartOptions extends DaemonStopOptions, DaemonEnsureOptions {
	waitForLockMs?: number;
	pollMs?: number;
	stop?: (opts: DaemonStopOptions) => Promise<DaemonStopResult>;
	ensure?: (opts: DaemonEnsureOptions) => Promise<DaemonEnsureResult>;
	readLock?: (path: string) => RuntimeLock | null;
	isLockAlive?: (lock: RuntimeLock | null) => boolean;
	sleep?: (ms: number) => Promise<void>;
}

export interface DaemonRestartResult {
	ok: boolean;
	message: string;
	oldPid: number | null;
	result?: DaemonEnsureResult;
}

/** Fail-closed stop → lock release → ensure orchestration. */
export async function restartRuntimeDaemon(opts: DaemonRestartOptions = {}): Promise<DaemonRestartResult> {
	const hostPath = opts.hostPath ?? join(resolve(opts.runtimeDir ?? defaultRuntimeDir()), "host.json");
	const stop = await (opts.stop ?? stopRuntimeDaemon)({ hostPath, ...(opts.force === true ? { force: true } : {}) });
	const oldPid = stop.info?.pid ?? null;
	if (!stop.stopped) {
		const forceHint = stop.uncertain ? "；确认实例归属后可显式使用 --force（会裸 kill，有风险）" : "";
		return { ok: false, oldPid, message: `runtime-host restart 中止：${stop.reason ?? "stop 失败"}${forceHint}` };
	}
	const lockPath = lockPathFor(hostPath);
	const waitMs = Math.min(10_000, Math.max(0, opts.waitForLockMs ?? 10_000));
	const started = Date.now();
	const readLock = opts.readLock ?? readRuntimeLock;
	const alive = opts.isLockAlive ?? lockHolderAlive;
	const pause = opts.sleep ?? sleep;
	while (readLock(lockPath) && alive(readLock(lockPath))) {
		const elapsed = Date.now() - started;
		if (elapsed >= waitMs) return { ok: false, oldPid, message: `runtime-host restart 中止：等待锁释放超时（${waitMs}ms），未调用 ensure` };
		await pause(Math.min(opts.pollMs ?? 100, waitMs - elapsed));
	}
	const result = await (opts.ensure ?? ensureRuntimeDaemon)(opts);
	if (!result.ok || !result.info) return { ok: false, oldPid, result, message: `runtime-host restart 起动失败：${result.error ?? "ensure 未返回 host 信息"}` };
	// L4 m2：ensure 返回 already:true = 等待窗口内被其他调用抢先起好并复用（pid/port 真实）——
	// 不得笼统报"已重启"，必须区分“新起”与“复用现有实例”，否则误导用户以为换了进程。
	const reuseNote = result.already === true ? "（复用现有实例：等待窗口内已由其他调用起好）" : "";
	return { ok: true, oldPid, result, message: `runtime-host 已重启${reuseNote}：旧 pid=${oldPid ?? "?"} → 新 pid=${result.info.pid} port=${result.info.port}。⚠️ GUI cookie 已失效（新 host token），需 /gui open。微信 worker 将由新 daemon 的 supervisor 重新 spawn（若 receive.enabled=true）。` };
}
