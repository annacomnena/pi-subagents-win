/**
 * runtime/local-master-launch.ts — 主会话按 cwd 幂等确保他仓 local master 存活
 * （0924 计划 §1/§2 MVP；用户裁定 1-10 落地）。
 *
 * 职责边界（**零新增权力**）：
 *   - 不写 attachment、不代替 attach、不带 forceStale/token/cutover/detach——认领一律由
 *     新会话 session_start 的既有静默路径完成（silentScopeGenesis / takeoverStaleScopeOwner，
 *     见 mailbox-consumer.ts registerScopeWakeLoop 的 session_start 处理块）；
 *   - 只收 cwd：scope/地址由 localMasterScope(cwd) 派生，参数面不收 scope/地址（防指向混淆）；
 *   - spawn 形态 = 可见 WT tab（非无头）：常驻会话唯一现成通道，可见性本身是安全特性。
 *
 * 三段幂等：
 *   1. precheck：已有**活** owner（attachment+liveness 同身份同代 + pid 活）→ `already-running`，
 *      零 spawn 零 in-flight 写（并顺手关掉历史窗口）；
 *   2. in-flight marker first-wins：`state/local-master-launch/<scope>.json`，窗口 = timeout+30s；
 *      窗口内同 scope 重调 → `launched` + inFlight=true（零第二个 spawn）；
 *   3. spawn 后按就绪判据轮询（waitForReady=false 则直接 `launched`）。
 *
 * 就绪判据（用户裁定 #7，严格）：
 *   liveness && attachment && 同 sessionId && 同 generation && isProcessAlive(pid)
 *   && launchAt < liveness.updatedAt → `ready`；拿不到 liveness → 如实 `stalled`（不猜）。
 *
 * 消费侧就绪（追加要求 #A）：local master 的信箱消费循环只在 `session_start` 注册
 * （mailbox-consumer.ts registerScopeWakeLoop），且**注册与认领在同一处理块内**——
 * session_start 里 silentScopeGenesis / takeoverStaleScopeOwner 之后 `att.sessionId === sid`
 * 才 setInterval。新会话的认领只可能来自该处理块，故 launched 模式在 #7 判据之上再要求
 * **观测到 claim**（attachment.generation 高于 precheck 快照；无 attachment 时快照记 0，
 * genesis 生成 1 恒前进）：claim ⟹ 消费循环已随 session_start 注册。liveness 全绿但
 * generation 未前进（既有 owner 复活/后补写心跳，其消费侧无法从盘面验证）→ 不判 ready，
 * 归 `stalled(claim-not-observed)`。这是不扩权前提下可机器验证的最强判据；残余见实现报告。
 *
 * 纯库：spawn/clock/sleep/fs 全可注入，无 Pi API 依赖（同 master-transfer 纪律）。
 * 审计：`state/local-master-ensure-audit.jsonl`，行 {at, by, cwd, scope, action, result}，无正文。
 */

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	openSync,
	closeSync,
	readFileSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ObjectAddress } from "./address.ts";
import { defaultRuntimeDir } from "./journal.ts";
import { isProcessAlive, readScopeLiveness, type ScopeLiveness } from "./liveness.ts";
import { readAttachment, type MasterAttachment } from "./registry.ts";
import { localMasterAddress, localMasterScope } from "./scope.ts";

// ── 常量 ───────────────────────────────────────────────────────────

export const ENSURE_DEFAULT_TIMEOUT_MS = 60_000;
export const ENSURE_MAX_TIMEOUT_MS = 180_000;
/** in-flight 窗口 = timeout + 30s（用户裁定 #8）。 */
export const ENSURE_IN_FLIGHT_EXTRA_MS = 30_000;
/** in-flight marker 目录名（state/local-master-launch/<scope>.json）。 */
export const ENSURE_MARKER_DIR = "local-master-launch";
/** 审计行文件（state/local-master-ensure-audit.jsonl；无正文纪律同 master-injections.jsonl）。 */
export const ENSURE_AUDIT_FILE = "local-master-ensure-audit.jsonl";

/** 超时归一：缺省 60s、上限 180s、下限 100ms（非法值回落缺省）。 */
export function clampEnsureTimeout(ms?: number): number {
	if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return ENSURE_DEFAULT_TIMEOUT_MS;
	return Math.min(Math.max(ms, 100), ENSURE_MAX_TIMEOUT_MS);
}

function defaultIsDirectory(p: string): boolean {
	try {
		return existsSync(p) && statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function sid12(s: string): string {
	return s.slice(0, 12);
}

// ── 结果形状 ───────────────────────────────────────────────────────

export type LocalMasterEnsureStatus =
	| "already-running"
	| "launched"
	| "ready"
	| "spawn-failed"
	| "timeout"
	| "invalid-cwd"
	| "stalled";

export interface EnsureLivenessSnapshot {
	sessionId: string;
	pid: number;
	alive: boolean;
	updatedAt: string;
}

export interface LocalMasterEnsureResult {
	status: LocalMasterEnsureStatus;
	scope: string | null;
	agentAddress: ObjectAddress | null;
	runId?: string;
	liveness?: EnsureLivenessSnapshot;
	generation?: number;
	/** status=launched 且命中 in-flight 窗口（零第二个 spawn）时 true。 */
	inFlight?: boolean;
	/** 受控枚举原因（no-liveness / no-owner / claim-not-observed / identity-mismatch /
	 *  generation-mismatch / owner-pid-dead / liveness-not-updated / cwd-not-directory / in-flight …） */
	reason?: string;
	/** 仅 spawn-failed：spawn 层原始错误串（launch_failed 账本同源）。 */
	detail?: string;
}

/** status → 是否算错误回执（invalid-cwd/spawn-failed/timeout/stalled 为错）。 */
export function ensureResultIsError(r: LocalMasterEnsureResult): boolean {
	return r.status === "invalid-cwd" || r.status === "spawn-failed" || r.status === "timeout" || r.status === "stalled";
}

// ── 就绪判据（纯函数，可单测）──────────────────────────────────────

export interface ReadyCheckInput {
	attachment: MasterAttachment | null;
	liveness: ScopeLiveness | null;
	launchAt: string;
	isAlive?: (pid: number) => boolean;
	/** launched 模式：precheck 快照 generation（无 attachment 记 0）。给出时必须观测到前进（#A claim 判据）。 */
	claimedFromGeneration?: number;
}

/**
 * #7 就绪判据逐条 + #A claim 观测。首次不满足的 reason 即回执 reason（受控枚举，无正文）。
 * 不满足 ≠ 失败：调用方轮询到 deadline 再分类（stalled vs timeout）。
 */
export function judgeLocalMasterEnsureReady(input: ReadyCheckInput): { ready: boolean; reason: string } {
	const alive = input.isAlive ?? isProcessAlive;
	const { attachment, liveness } = input;
	if (!liveness) return { ready: false, reason: "no-liveness" };
	if (!attachment) return { ready: false, reason: "no-owner" };
	if (liveness.sessionId !== attachment.sessionId) return { ready: false, reason: "identity-mismatch" };
	if (liveness.generation !== attachment.generation) return { ready: false, reason: "generation-mismatch" };
	if (!alive(liveness.pid)) return { ready: false, reason: "owner-pid-dead" };
	if (!(input.launchAt < liveness.updatedAt)) return { ready: false, reason: "liveness-not-updated" };
	if (input.claimedFromGeneration !== undefined && !(attachment.generation > input.claimedFromGeneration)) {
		return { ready: false, reason: "claim-not-observed" };
	}
	return { ready: true, reason: "ready" };
}

/** deadline 分类：判不了/没认领 → stalled（不猜）；判得了但没就绪 → timeout（带快照）。 */
export function ensureStatusForReason(reason: string | undefined): "stalled" | "timeout" {
	return reason === "no-liveness" || reason === "no-owner" || reason === "claim-not-observed"
		? "stalled"
		: "timeout";
}

// ── bootstrap prompt（照计划 §1：无 token、不指示 forceStale、不指示碰 global）──

export function buildLocalMasterBootstrapPrompt(scope: string, addr: ObjectAddress, repoCwd: string): string {
	return [
		`你是 ${addr} 的 local master（仓库 ${scope}），常驻本仓履职：不要 tab-finish、不要退出、不要设 timer 自续命。`,
		`工作目录：${repoCwd}（本仓）。session_start 会自动认领/接管本仓 attachment（无 owner 静默 genesis；僵尸仅按 pid 死判据接管）——先用 /master-status 核验 local 归属行 owner 是你、generation 与 liveness 一致。`,
		"若核验发现 owner 不是你（liveness 缺失/身份不匹配等死角）：如实说明并停在原地，不要自行强接（强接参数只归用户）、不要 attach 到别的地址；死角交还用户人工处置。",
		"收信处理与回信 recipe 遵循既有 wake prompt 纪律（本仓 scope 唤醒循环为 wake/命令类信拉起一次性 tab；需要回信的信按原信 from/inReplyTo 用 deliverLetter 回 RESULT）。",
		"你只持有本仓 local Master：不要触碰全局 Master（agent://master_default），不要调用 master-attach/master-detach/master-transfer/master-cutover。",
	].join("\n");
}

/** 账本 taskId（计划 §6：`lms-<scope>`）。 */
export function ensureTaskId(scope: string): string {
	return `lms-${scope}`;
}

// ── in-flight marker IO ────────────────────────────────────────────

export interface LaunchMarker {
	scope: string;
	runId: string | null;
	at: string;
}

function markerPath(scope: string, stateDir: string): string {
	const safe = scope.replace(/[^A-Za-z0-9._-]/g, "_");
	return join(stateDir, ENSURE_MARKER_DIR, `${safe}.json`);
}

function tolerantReadMarker(path: string): LaunchMarker | null {
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as LaunchMarker;
		if (typeof raw?.scope !== "string" || typeof raw?.at !== "string") return null;
		if (typeof raw.runId !== "string" && raw.runId !== null) return null;
		return { scope: raw.scope, runId: raw.runId ?? null, at: raw.at };
	} catch {
		return null;
	}
}

function writeMarker(path: string, marker: LaunchMarker): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
}

/**
 * first-wins 认领 in-flight 窗口（用户裁定 #8）：
 *   wx 排他创建成功 → claimed（本次 spawn）；
 *   EEXIST → 读旧 marker：窗口内 → 不认领（调用方回 launched(in-flight) 零 spawn）；过期 → 删旧再 wx 一轮；
 *   仍失败（并发/IO）→ 不认领（宁可少开一个 tab；attachment 层 CAS 仍是最终单赢）。
 * 任何 IO 异常 never-throw。
 */
export function claimLocalMasterLaunchMarker(
	scope: string,
	opts: { stateDir: string; nowMs: number; windowMs: number },
): { claimed: true; marker: null } | { claimed: false; marker: LaunchMarker } {
	const path = markerPath(scope, opts.stateDir);
	try {
		mkdirSync(dirname(path), { recursive: true });
	} catch {
		/* 目录创建失败交给 openSync 报错 */
	}
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(path, "wx");
			try {
				writeFileSync(fd, `${JSON.stringify({ scope, runId: null, at: new Date(opts.nowMs).toISOString() } satisfies LaunchMarker, null, 2)}\n`, "utf8");
			} finally {
				closeSync(fd);
			}
			return { claimed: true, marker: null };
		} catch (e) {
			if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") {
				// 非竞争性写失败（权限/磁盘）：降级为无 marker 的尽力启动（registry CAS 兜底单赢）。
				return { claimed: true, marker: null };
			}
			const existing = tolerantReadMarker(path);
			const atMs = existing ? Date.parse(existing.at) : NaN;
			if (existing && Number.isFinite(atMs) && opts.nowMs - atMs < opts.windowMs) {
				return { claimed: false, marker: existing };
			}
			try {
				unlinkSync(path);
			} catch {
				/* 删旧失败 → 下一轮 wx 仍 EEXIST → 不认领 */
			}
		}
	}
	return { claimed: false, marker: tolerantReadMarker(path) ?? { scope, runId: null, at: new Date(opts.nowMs).toISOString() } };
}

/** spawn 成功后回写 runId（同窗口覆盖写；never-throw）。 */
export function updateLocalMasterLaunchMarker(scope: string, runId: string, opts: { stateDir: string; nowMs: number }): void {
	try {
		writeMarker(markerPath(scope, opts.stateDir), { scope, runId, at: new Date(opts.nowMs).toISOString() });
	} catch {
		/* best-effort：marker 只服务防重，不影响回执 */
	}
}

/** 窗口关闭（ready / already-running / spawn-failed）。never-throw。 */
export function clearLocalMasterLaunchMarker(scope: string, stateDir: string): void {
	try {
		rmSync(markerPath(scope, stateDir), { force: true });
	} catch {
		/* best-effort */
	}
}

/** 读 marker（测试/诊断用）。 */
export function readLocalMasterLaunchMarker(scope: string, stateDir: string): LaunchMarker | null {
	return tolerantReadMarker(markerPath(scope, stateDir));
}

// ── 审计（每次调用含被拒；无正文）─────────────────────────────────

export interface EnsureAuditEntry {
	at: string;
	by: string;
	cwd: string;
	scope: string | null;
	action: string;
	result: string;
}

export function ensureAuditPath(stateDir?: string): string {
	return join(stateDir ?? join(defaultRuntimeDir(), "state"), ENSURE_AUDIT_FILE);
}

/** 追加一行审计 {at, by, cwd, scope, action, result}（截断保护 + never-throw）。 */
export function auditLocalMasterEnsure(
	entry: { by: string; cwd: string; scope: string | null; action: string; result: string; at?: string },
	stateDir?: string,
): void {
	try {
		const line: EnsureAuditEntry = {
			at: entry.at ?? new Date().toISOString(),
			by: String(entry.by ?? "unknown").slice(0, 64),
			cwd: String(entry.cwd ?? "").slice(0, 400),
			scope: entry.scope === null || entry.scope === undefined ? null : String(entry.scope).slice(0, 120),
			action: String(entry.action ?? "ensure").slice(0, 40),
			result: String(entry.result ?? "").slice(0, 120),
		};
		const path = ensureAuditPath(stateDir);
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${JSON.stringify(line)}\n`, "utf8");
	} catch {
		/* 审计永不打断主流程（同 master-injections.jsonl 纪律） */
	}
}

/** 读全部审计行（测试/诊断用；容忍坏行）。 */
export function readLocalMasterEnsureAudit(stateDir?: string): EnsureAuditEntry[] {
	try {
		const raw = readFileSync(ensureAuditPath(stateDir), "utf8");
		const out: EnsureAuditEntry[] = [];
		for (const l of raw.split("\n")) {
			if (!l.trim()) continue;
			try {
				out.push(JSON.parse(l) as EnsureAuditEntry);
			} catch {
				/* 坏行跳过 */
			}
		}
		return out;
	} catch {
		return [];
	}
}

// ── spawn 契约 ─────────────────────────────────────────────────────

export interface LocalMasterSpawnArgs {
	/** 调用者会话（links 溯源用）。 */
	sessionId: string;
	cwd: string;
	scope: string;
	agentAddress: ObjectAddress;
	prompt: string;
	taskId: string;
	launchAt: string;
}

export type LocalMasterSpawn = (args: LocalMasterSpawnArgs) => { runId?: string; error?: string };

export interface LocalMasterEnsureDeps {
	spawn: LocalMasterSpawn;
	/** 毫秒时钟（测试注入 fake clock）。 */
	now?: () => number;
	/** 轮询间隔等待（测试注入；**注入方必须推进 now()**，否则永不超时）。 */
	sleep?: (ms: number) => Promise<void>;
	readAttachment?: (agent: ObjectAddress) => MasterAttachment | null;
	readLiveness?: (scope: string) => ScopeLiveness | null;
	isAlive?: (pid: number) => boolean;
	isDirectory?: (cwd: string) => boolean;
	stateDir?: string;
	pollIntervalMs?: number;
}

// ── 编排 ───────────────────────────────────────────────────────────

/**
 * 幂等 ensure（详见头注）。不抛：spawn 抛错归 spawn-failed；IO 全部容忍读。
 *
 * 调用方（master-tools 工具 / index.ts slash 命令）负责四层授权与审计行；
 * 本函数只做 precheck → in-flight → spawn → 就绪轮询。
 */
export async function ensureLocalMaster(
	input: { cwd: string; sessionId: string; waitForReady?: boolean; timeoutMs?: number },
	deps: LocalMasterEnsureDeps,
): Promise<LocalMasterEnsureResult> {
	const now = deps.now ?? Date.now;
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const readAtt = deps.readAttachment ?? ((agent: ObjectAddress) => readAttachment(agent));
	const readLv = deps.readLiveness ?? ((scope: string) => readScopeLiveness(scope));
	const isAlive = deps.isAlive ?? isProcessAlive;
	const isDirectory = deps.isDirectory ?? defaultIsDirectory;
	const stateDir = deps.stateDir ?? join(defaultRuntimeDir(), "state");
	const timeoutMs = clampEnsureTimeout(input.timeoutMs);
	const pollIntervalMs = Math.max(10, deps.pollIntervalMs ?? 250);

	const cwd = typeof input.cwd === "string" ? input.cwd.trim() : "";
	const scope = cwd ? localMasterScope(cwd) : null;
	const agentAddress = scope ? localMasterAddress(scope) : null;

	// 层③参数面：cwd 必须存在且为目录。invalid-cwd 零 spawn、零状态写（此处尚未碰任何状态）。
	if (!cwd || !isDirectory(cwd)) {
		return { status: "invalid-cwd", scope, agentAddress, reason: "cwd-not-directory" };
	}
	const scopeKey = scope!;
	const addr = agentAddress!;

	// ── precheck：活 owner → already-running（幂等零动作；顺手关掉历史 in-flight 窗口）──
	const preAtt = readAtt(addr);
	const preLv = readLv(scopeKey);
	if (preAtt && preLv && preLv.sessionId === preAtt.sessionId && preLv.generation === preAtt.generation && isAlive(preLv.pid)) {
		clearLocalMasterLaunchMarker(scopeKey, stateDir);
		return {
			status: "already-running",
			scope: scopeKey,
			agentAddress: addr,
			liveness: { sessionId: preLv.sessionId, pid: preLv.pid, alive: true, updatedAt: preLv.updatedAt },
			generation: preAtt.generation,
		};
	}

	// ── in-flight 防重（first-wins；窗口 = timeout + 30s）──
	const claim = claimLocalMasterLaunchMarker(scopeKey, {
		stateDir,
		nowMs: now(),
		windowMs: timeoutMs + ENSURE_IN_FLIGHT_EXTRA_MS,
	});
	if (!claim.claimed) {
		return {
			status: "launched",
			scope: scopeKey,
			agentAddress: addr,
			...(claim.marker.runId ? { runId: claim.marker.runId } : {}),
			inFlight: true,
			reason: "in-flight",
		};
	}

	// ── spawn：可见 tab + bootstrap prompt（不带 token/forceStale/global 指令）──
	const launchAt = new Date(now()).toISOString();
	let spawned: { runId?: string; error?: string };
	try {
		spawned = deps.spawn({
			sessionId: input.sessionId,
			cwd,
			scope: scopeKey,
			agentAddress: addr,
			prompt: buildLocalMasterBootstrapPrompt(scopeKey, addr, cwd),
			taskId: ensureTaskId(scopeKey),
			launchAt,
		});
	} catch (e) {
		spawned = { error: e instanceof Error ? e.message : String(e) };
	}
	if (spawned.error || typeof spawned.runId !== "string") {
		clearLocalMasterLaunchMarker(scopeKey, stateDir);
		return {
			status: "spawn-failed",
			scope: scopeKey,
			agentAddress: addr,
			...(spawned.runId ? { runId: spawned.runId } : {}),
			detail: spawned.error ?? "spawn returned no runId",
			reason: "spawn-error",
		};
	}
	updateLocalMasterLaunchMarker(scopeKey, spawned.runId, { stateDir, nowMs: now() });
	const runId = spawned.runId;

	if (input.waitForReady === false) {
		return { status: "launched", scope: scopeKey, agentAddress: addr, runId };
	}

	// ── 就绪轮询（launchAt 之前的 liveness 一律不算数）──
	const deadline = now() + timeoutMs;
	const preGen = preAtt ? preAtt.generation : 0; // #A：无 attachment 快照记 0（genesis → 1 恒前进）
	for (;;) {
		const att = readAtt(addr);
		const lv = readLv(scopeKey);
		const v = judgeLocalMasterEnsureReady({
			attachment: att,
			liveness: lv,
			launchAt,
			isAlive,
			claimedFromGeneration: preGen,
		});
		if (v.ready && att && lv) {
			clearLocalMasterLaunchMarker(scopeKey, stateDir);
			return {
				status: "ready",
				scope: scopeKey,
				agentAddress: addr,
				runId,
				liveness: { sessionId: lv.sessionId, pid: lv.pid, alive: true, updatedAt: lv.updatedAt },
				generation: att.generation,
			};
		}
		if (now() >= deadline) {
			return {
				status: ensureStatusForReason(v.reason),
				scope: scopeKey,
				agentAddress: addr,
				runId,
				reason: v.reason,
				...(att ? { generation: att.generation } : {}),
				...(lv ? { liveness: { sessionId: lv.sessionId, pid: lv.pid, alive: isAlive(lv.pid), updatedAt: lv.updatedAt } } : {}),
			};
		}
		await sleep(pollIntervalMs);
	}
}

// ── 回执文案（工具与 slash 命令共用）──────────────────────────────

export function formatLocalMasterEnsureResult(r: LocalMasterEnsureResult): string {
	const head = `local-master-ensure ${r.status}`;
	const where = `scope=${r.scope ?? "-"} ${r.agentAddress ?? "-"}`;
	const run = r.runId ? ` runId=${r.runId}` : "";
	switch (r.status) {
		case "already-running":
			return `${head}: ${where} owner=${r.liveness ? sid12(r.liveness.sessionId) : "?"} gen=${r.generation} liveness pid=${r.liveness?.pid} alive（活 master，零动作零 spawn）`;
		case "launched":
			return r.inFlight
				? `${head}(in-flight): ${where}${run}（窗口内在途启动，零第二个 spawn）`
				: `${head}: ${where}${run}（可见 tab 已开，等待 session_start 静默认领）`;
		case "ready":
			return `${head}: ${where} owner=${r.liveness ? sid12(r.liveness.sessionId) : "?"} gen=${r.generation} liveness pid=${r.liveness?.pid} alive updated=${r.liveness?.updatedAt}${run}`;
		case "spawn-failed":
			return `${head}: ${where}（${r.detail ?? "unknown"}）——不自动重试；重调用等价手动重试（precheck 幂等）`;
		case "invalid-cwd":
			return `${head}: ${where} 目标目录不存在或不是目录（零 spawn 零状态写）`;
		case "timeout":
			return `${head}: ${where} reason=${r.reason}（会话已开但判据未满足；不杀 tab，窗口到期可重调）${r.liveness ? ` liveness=${r.liveness.sessionId.slice(0, 12)}/gen? pid=${r.liveness.pid}${r.liveness.alive ? " alive" : " dead"} updated=${r.liveness.updatedAt}` : ""}`;
		case "stalled":
			return `${head}: ${where} reason=${r.reason}（判据证据不足，不猜）。指引：人工在该仓开 pi 会话用 /master-status 核查，或由用户走 /master-attach --local --force-stale --confirm 处置死角（本工具不带该权力）`;
	}
}
