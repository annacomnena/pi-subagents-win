/**
 * subagent-kill — async run 的「直接 kill」能力（无需手工找 PID）
 *
 * 背景（用户痛点）：异步 subagent 有时会卡住，但此前没有直接终止入口，
 * 只能自己去翻进程 id 再 taskkill，很不方便。
 *
 * 本模块给 `subagent-win` 工具补三个动作的底座：
 *   - action:"kill" / "cancel"  按 runId 终止该 run 的整棵进程树（Windows: taskkill /T /F）
 *   - action:"list"             列出当前 async runs（runId/agent/状态/pid/启动/lastActivity）
 *
 * 安全校验（防误杀，两项必备，缺一不可）：
 *   1. pid 归属：pid 必须由「该 runId 的派发链路」登记（registry 或 run json 的 pid 字段），
 *      绝不接受「pid 存在就杀」。
 *   2. 进程身份：向 OS 查询该 pid 的**启动时间**与**命令行**，与登记基线比对——
 *      命令行必须包含登记 marker（PI CLI 脚本路径 / 外部 CLI 可执行路径），
 *      启动时间必须落在登记时刻的容差窗口内（防止 pid 被 OS 重用后误杀新进程）。
 *
 * 幂等 / 终态语义（明确选择，见 plans/20261013_subagent_kill_impl.md）：
 *   - runId 不存在          → isError=true（调用方给错了 id，需要显式纠错）
 *   - run 已 cancelled      → 幂等成功（isError=false），不重复杀
 *   - run 已 completed/failed 且进程已不在 → 幂等成功（isError=false）
 *   - run 已 completed/failed 但登记进程仍在（孤儿）→ 仍按安全校验杀树，保留原终态
 *   - pid 被重用 / 身份不匹配 / 无基线 → isError=true 并拒绝（宁可不杀，不误杀）
 *
 * 范围：只动目标 run 自己登记的 pid 及其子树；不扫描、不模糊匹配任何别的进程。
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * runs 目录解析口径（单一来源，启动时读一次 env）：
 *   PI_SUBAGENT_RUNS_DIR 覆盖缺省真实运行目录，供测试用临时目录隔离（零写入 ~/.pi/agent）。
 * index.ts 直接复用本常量，避免两处硬编码漂移。
 */
export const DEFAULT_RUNS_DIR = process.env.PI_SUBAGENT_RUNS_DIR ?? join(homedir(), ".pi", "agent", "subagent-runs");

/** 子进程登记信息：pid + 命令行 marker（该 run 的启动指纹）。 */
export interface ChildSpawnInfo {
	pid: number;
	/** 命令行中必须出现的稳定子串（PI CLI 脚本路径 / 外部 CLI 可执行路径）。 */
	marker: string;
}

/** run json 记录中与 kill 相关的可选字段（index.ts 的 AsyncRunRecord 是其超集）。 */
export interface KillableRunRecord {
	id: string;
	agent?: string;
	task?: string;
	status: string;
	startedAt?: string;
	cwd?: string;
	/** 登记的子进程 pid（每次 spawn 覆盖为当前 attempt）。 */
	pid?: number;
	/** 登记时刻（wall clock ISO）。 */
	pidRecordedAt?: string;
	/** 命令行 marker 基线。 */
	pidCmdMarker?: string;
	/** 最近一次活动脉搏（ISO）。 */
	lastActivity?: string;
	/** kill 元数据。 */
	killedAt?: string;
	killedBy?: string;
	killReason?: string;
	result?: unknown;
	[k: string]: unknown;
}

export interface KillResult {
	ok: boolean;
	code:
		| "killed"
		| "already_terminal"
		| "not_found"
		| "no_pid"
		| "pid_reused"
		| "identity_unknown"
		| "kill_failed";
	message: string;
	killedPids?: number[];
	alreadyDead?: boolean;
}

export interface RunSummary {
	id: string;
	agent?: string;
	status: string;
	pid?: number;
	pidAlive?: boolean;
	startedAt?: string;
	lastActivity?: string;
	/** 距 lastActivity 的毫秒数（越大越可能卡住）。 */
	idleMs?: number;
	taskPreview: string;
}

/** OS 实际进程信息（用于身份校验）。 */
export interface LiveProcInfo {
	pid: number;
	/** 进程启动时间（epoch ms）。 */
	startedAtMs?: number;
	cmd?: string;
}

interface ProcEntry {
	pid: number;
	marker: string;
	recordedAtMs: number;
	lastActivityMs: number;
	lastPersistedMs: number;
}

interface KillMeta {
	killedAt: string;
	killedBy: string;
	killReason?: string;
}

/** 进程内登记表（同一 extension host 内的权威 pid 归属）。 */
const procRegistry = new Map<string, ProcEntry>();
/** 已被 kill 的 run（供完成回调 finalize 时保留 cancelled，不被 result 覆盖）。 */
const killedRuns = new Map<string, KillMeta>();

/** 登记基线容差：登记后子进程启动时间应落在此窗口内（防 pid 重用）。 */
const START_TOLERANCE_EARLY_MS = 300_000; // 允许登记前最多 5 分钟（时钟偏差/慢启动）
const START_TOLERANCE_LATE_MS = 180_000; // 允许登记后最多 3 分钟
/** lastActivity 落盘节流：心跳 1s，但只在 >5s 时写一次文件。 */
const ACTIVITY_PERSIST_INTERVAL_MS = 5_000;

function readRecord(runsDir: string, runId: string): KillableRunRecord | null {
	const file = join(runsDir, `${runId}.json`);
	if (!existsSync(file)) return null;
	try {
		return JSON.parse(readFileSync(file, "utf8")) as KillableRunRecord;
	} catch {
		return null;
	}
}

function writeRecord(runsDir: string, record: KillableRunRecord): void {
	try {
		writeFileSync(join(runsDir, `${record.id}.json`), JSON.stringify(record));
	} catch {
		/* best-effort：kill 语义不因落盘失败而回退 */
	}
}

/** 该 pid 是否存活（signal 0 探测；EPERM 视为存活）。 */
export function isPidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException)?.code === "EPERM";
	}
}

/**
 * 查询 OS 实际进程信息（启动时间 + 命令行）。
 * Windows 用 PowerShell CIM（Get-CimInstance 返回 DateTime 对象，转 UTC ISO）；
 * POSIX 用 ps。查询失败返回 null。
 */
export function inspectLiveProcess(pid: number): LiveProcInfo | null {
	if (!isPidAlive(pid)) return null;
	if (process.platform === "win32") {
		const script =
			`$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue; ` +
			`if ($p) { $p.CreationDate.ToUniversalTime().ToString("o"); $p.CommandLine }`;
		try {
			const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
				encoding: "utf8",
				timeout: 20_000,
				windowsHide: true,
			});
			const lines = out.split(/\r?\n/);
			const startedAtMs = Date.parse((lines[0] ?? "").trim());
			const cmd = lines.slice(1).join("\n").trim() || undefined;
			if (!Number.isFinite(startedAtMs) && !cmd) return null;
			return { pid, startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : undefined, cmd };
		} catch {
			return null;
		}
	}
	try {
		const startOut = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 10_000 }).trim();
		const cmdOut = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 10_000 }).trim();
		const startedAtMs = Date.parse(startOut);
		return { pid, startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : undefined, cmd: cmdOut || undefined };
	} catch {
		return null;
	}
}

/**
 * 终止整棵进程树。
 * Windows: taskkill /PID <pid> /T /F（树杀，含孙进程）。
 * POSIX: 先收集后代再自底向上 SIGKILL（detached 时优先杀进程组）。
 */
export function killProcessTree(pid: number): { ok: boolean; alreadyDead: boolean; out: string } {
	if (process.platform === "win32") {
		const r = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
			encoding: "utf8",
			timeout: 30_000,
			windowsHide: true,
		});
		const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
		if (r.status === 0) return { ok: true, alreadyDead: false, out };
		// taskkill 对已消失进程返回非 0；识别 “not found / 没有找到”。
		if (/not found|没有找到|找不到/i.test(out) || !isPidAlive(pid)) {
			return { ok: true, alreadyDead: true, out };
		}
		return { ok: false, alreadyDead: false, out };
	}
	// POSIX
	try {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			/* 非进程组长，走后代遍历 */
		}
		const descendants = collectDescendants(pid);
		for (const p of descendants.reverse()) {
			try { process.kill(p, "SIGKILL"); } catch { /* ignore */ }
		}
		try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
		return { ok: true, alreadyDead: descendants.length === 0 && !isPidAlive(pid), out: `killed tree: ${[pid, ...descendants].join(",")}` };
	} catch (err) {
		return { ok: false, alreadyDead: !isPidAlive(pid), out: err instanceof Error ? err.message : String(err) };
	}
}

function collectDescendants(rootPid: number): number[] {
	try {
		const out = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", timeout: 10_000 });
		const children = new Map<number, number[]>();
		for (const line of out.split("\n")) {
			const [pidStr, ppidStr] = line.trim().split(/\s+/);
			const pid = Number(pidStr);
			const ppid = Number(ppidStr);
			if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
			const arr = children.get(ppid) ?? [];
			arr.push(pid);
			children.set(ppid, arr);
		}
		const acc: number[] = [];
		const queue = [rootPid];
		while (queue.length > 0) {
			const cur = queue.shift() as number;
			for (const child of children.get(cur) ?? []) {
				acc.push(child);
				queue.push(child);
			}
		}
		return acc;
	} catch {
		return [];
	}
}

/**
 * 登记 run → 子进程 pid（在 runSingle/外部 CLI spawn 成功后立刻调用）。
 * 同时把 pid/pidRecordedAt/pidCmdMarker 落盘到 run json，供跨进程/重启后 kill 校验。
 */
export function registerRunProcess(runsDir: string, runId: string, info: ChildSpawnInfo): void {
	if (!Number.isInteger(info.pid) || info.pid <= 0) return;
	const now = Date.now();
	const marker = (info.marker ?? "").trim();
	procRegistry.set(runId, {
		pid: info.pid,
		marker,
		recordedAtMs: now,
		lastActivityMs: now,
		lastPersistedMs: now,
	});
	const record = readRecord(runsDir, runId);
	if (!record) return;
	record.pid = info.pid;
	record.pidRecordedAt = new Date(now).toISOString();
	record.pidCmdMarker = marker || undefined;
	record.lastActivity = new Date(now).toISOString();
	writeRecord(runsDir, record);
}

/** 完成回调里清理登记（不动 kill 元数据）。 */
export function clearRunProcess(runId: string): void {
	procRegistry.delete(runId);
}

/** 活动脉搏：心跳/进度调用；内存实时更新，落盘节流。 */
export function touchRunActivity(runId: string, runsDir: string = DEFAULT_RUNS_DIR): void {
	const now = Date.now();
	const entry = procRegistry.get(runId);
	if (entry) {
		entry.lastActivityMs = now;
		if (now - entry.lastPersistedMs < ACTIVITY_PERSIST_INTERVAL_MS) return;
		entry.lastPersistedMs = now;
	}
	const record = readRecord(runsDir, runId);
	if (!record) return;
	// 未登记（尚未 spawn / 已清理）时也按记录里的 lastActivity 节流，避免每心跳一次 IO。
	if (!entry) {
		const last = Date.parse(record.lastActivity ?? "");
		if (Number.isFinite(last) && now - last < ACTIVITY_PERSIST_INTERVAL_MS) return;
	}
	record.lastActivity = new Date(now).toISOString();
	writeRecord(runsDir, record);
}

/** 该 run 是否已被 kill（完成回调 finalize 时用于保留 cancelled）。 */
export function isRunKilled(runId: string): boolean {
	return killedRuns.has(runId);
}

/**
 * 完成回调 finalize 前调用：若该 run 已被 kill，强制保留 cancelled 与 kill 元数据，
 * 防止 `.then((result) => record.status = result.status)` 把 cancelled 覆盖成 failed。
 */
export function applyKillOutcome(record: {
	id: string;
	agent?: string;
	status: string;
	result?: unknown;
	lastActivity?: string;
	killedAt?: string;
	killedBy?: string;
	killReason?: string;
	pid?: number;
	pidRecordedAt?: string;
	pidCmdMarker?: string;
}): void {
	const meta = killedRuns.get(record.id);
	if (!meta) return;
	record.status = "cancelled";
	record.killedAt = meta.killedAt;
	record.killedBy = meta.killedBy;
	if (meta.killReason) record.killReason = meta.killReason;
	record.lastActivity = meta.killedAt;
	const prevText = (record.result as { text?: unknown } | undefined)?.text;
	record.result = {
		status: "cancelled",
		text: typeof prevText === "string" ? prevText : "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		usageEvents: [],
		runId: record.id,
		error: `killed by user (subagent-win action=kill, ${meta.killedBy})`,
		agent: record.agent,
	};
	delete record.pid;
	delete record.pidRecordedAt;
	delete record.pidCmdMarker;
}

/** 列出 async runs（running 优先，便于一眼看出谁卡住）。 */
export function listAsyncRunSummaries(runsDir: string = DEFAULT_RUNS_DIR, limit = 20): RunSummary[] {
	if (!existsSync(runsDir)) return [];
	const now = Date.now();
	const records: KillableRunRecord[] = [];
	for (const f of readdirSync(runsDir)) {
		if (!f.endsWith(".json")) continue;
		try {
			const rec = JSON.parse(readFileSync(join(runsDir, f), "utf8")) as KillableRunRecord;
			if (rec && typeof rec.id === "string") records.push(rec);
		} catch {
			/* skip bad json */
		}
	}
	const summaries: RunSummary[] = records.map((r) => {
		const lastIso = r.lastActivity ?? r.pidRecordedAt ?? r.startedAt;
		const lastMs = Date.parse(lastIso ?? "");
		return {
			id: r.id,
			agent: r.agent,
			status: r.status,
			pid: typeof r.pid === "number" ? r.pid : undefined,
			pidAlive: typeof r.pid === "number" ? isPidAlive(r.pid) : undefined,
			startedAt: r.startedAt,
			lastActivity: lastIso,
			idleMs: Number.isFinite(lastMs) ? now - lastMs : undefined,
			taskPreview: String(r.task ?? "").replace(/\s+/g, " ").slice(0, 40),
		};
	});
	summaries.sort((a, b) => {
		const ra = a.status === "running" ? 0 : 1;
		const rb = b.status === "running" ? 0 : 1;
		if (ra !== rb) return ra - rb;
		return (b.startedAt ?? "").localeCompare(a.startedAt ?? "");
	});
	return summaries.slice(0, limit);
}

function fmtClock(iso?: string): string {
	if (!iso) return "?";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "?";
	return d.toLocaleTimeString("en-GB", { hour12: false });
}

function fmtIdle(idleMs?: number): string {
	if (idleMs === undefined) return "?";
	if (idleMs < 60_000) return `${Math.max(0, Math.round(idleMs / 1000))}s`;
	if (idleMs < 3_600_000) return `${Math.round(idleMs / 60_000)}m`;
	return `${(idleMs / 3_600_000).toFixed(1)}h`;
}

/** 短输出格式：一行一个 run（list 专用，保持 TUI 可读）。 */
export function formatRunList(summaries: RunSummary[]): string {
	if (summaries.length === 0) return "No async runs found.";
	const running = summaries.filter((s) => s.status === "running");
	const lines = [`Async runs (${summaries.length}, running=${running.length}):`];
	for (const s of summaries) {
		const pid = s.pid ? `pid=${s.pid}${s.pidAlive === false ? "(dead)" : ""}` : "pid=none";
		const idle = s.status === "running" ? ` idle=${fmtIdle(s.idleMs)}` : "";
		lines.push(
			`${s.id}  [${s.agent ?? "-"}] ${s.status}  ${pid}  start=${fmtClock(s.startedAt)}${idle}  ${s.taskPreview}`,
		);
	}
	return lines.join("\n");
}

function verifyIdentity(record: KillableRunRecord, live: LiveProcInfo): { ok: boolean; reason: string } {
	const marker = (record.pidCmdMarker ?? "").trim();
	const recordedMs = Date.parse(record.pidRecordedAt ?? "");
	const problems: string[] = [];

	// 校验 2a：命令行 marker 必须命中（大小写不敏感，Windows 路径）。
	if (marker) {
		const hay = live.cmd ?? "";
		if (!hay) problems.push("live command line unavailable");
		else if (!hay.toLowerCase().includes(marker.toLowerCase())) {
			problems.push(`command line does not contain expected marker "${marker}"`);
		}
	} else {
		problems.push("no recorded command-line marker");
	}

	// 校验 2b：启动时间必须落在登记窗口内（防 pid 重用）。
	if (Number.isFinite(recordedMs) && live.startedAtMs !== undefined) {
		const delta = live.startedAtMs - recordedMs;
		if (delta < -START_TOLERANCE_EARLY_MS || delta > START_TOLERANCE_LATE_MS) {
			problems.push(
				`start time mismatch (live ${new Date(live.startedAtMs).toISOString()} vs recorded ${new Date(recordedMs).toISOString()})`,
			);
		}
	} else if (live.startedAtMs === undefined) {
		problems.push("live start time unavailable");
	} else {
		problems.push("no recorded start time");
	}

	return problems.length === 0
		? { ok: true, reason: "identity verified" }
		: { ok: false, reason: `pid ${live.pid} identity check failed: ${problems.join("; ")}` };
}

function markKilled(
	runsDir: string,
	record: KillableRunRecord,
	meta: KillMeta,
	opts: { preserveTerminal: boolean },
): void {
	const next: KillableRunRecord = { ...record };
	if (!opts.preserveTerminal) next.status = "cancelled";
	next.killedAt = meta.killedAt;
	next.killedBy = meta.killedBy;
	if (meta.killReason) next.killReason = meta.killReason;
	next.lastActivity = meta.killedAt;
	if (!opts.preserveTerminal && !next.result) {
		next.result = {
			status: "cancelled",
			text: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
			usageEvents: [],
			runId: next.id,
			error: `killed by user (subagent-win action=kill, ${meta.killedBy})`,
			agent: next.agent,
		};
	}
	delete next.pid;
	delete next.pidRecordedAt;
	delete next.pidCmdMarker;
	writeRecord(runsDir, next);
	killedRuns.set(next.id, meta);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitPidGone(pid: number, timeoutMs = 3_000): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (!isPidAlive(pid)) return true;
		await sleep(50);
	}
	return !isPidAlive(pid);
}

export interface KillAsyncRunOptions {
	runId: string;
	runsDir?: string;
	/** 调用者标签（写入 killedBy，缺省 "tool:subagent-win"）。 */
	caller?: string;
	reason?: string;
}

/**
 * 按 runId 终止该 run 的进程树，并把记录落成 cancelled。
 * 见文件头「安全校验 / 幂等与终态语义」。
 */
export async function killAsyncRun(opts: KillAsyncRunOptions): Promise<KillResult> {
	const runsDir = opts.runsDir ?? DEFAULT_RUNS_DIR;
	const { runId } = opts;
	const record = readRecord(runsDir, runId);
	if (!record) {
		return { ok: false, code: "not_found", message: `Run ${runId} not found` };
	}
	const status = record.status;

	const buildMeta = (): KillMeta => ({
		killedAt: new Date().toISOString(),
		killedBy: opts.caller ?? "tool:subagent-win",
		killReason: opts.reason,
	});

	// 已 cancelled → 幂等成功。
	if (status === "cancelled") {
		return { ok: true, code: "already_terminal", message: `Run ${runId} already cancelled (idempotent, nothing killed)` };
	}

	const pid = typeof record.pid === "number" ? record.pid : undefined;
	const terminal = status === "completed" || status === "failed";

	// 终态 + 无登记 pid 或进程已不在 → 幂等成功（没有可杀的）。
	if (terminal && (!pid || !isPidAlive(pid))) {
		return { ok: true, code: "already_terminal", message: `Run ${runId} already ${status}; no live process to kill` };
	}

	// 运行中但无 pid：老记录（本能力上线前派发）无法安全定位。
	if (!pid) {
		return {
			ok: false,
			code: "no_pid",
			message: `Run ${runId} has no recorded pid (dispatched before kill support); cannot locate the process tree safely`,
		};
	}

	// 进程已消失但记录仍 running → 落 cancelled（幂等收尾）。
	if (!isPidAlive(pid)) {
		markKilled(runsDir, record, buildMeta(), { preserveTerminal: terminal });
		return {
			ok: true,
			code: "killed",
			message: `Run ${runId}: process ${pid} already exited; marked ${terminal ? status : "cancelled"}`,
			killedPids: [],
			alreadyDead: true,
		};
	}

	// ── 安全校验：身份（pid 归属在上面已由 record.pid 保证）──
	const live = inspectLiveProcess(pid);
	if (!live) {
		if (!isPidAlive(pid)) {
			markKilled(runsDir, record, buildMeta(), { preserveTerminal: terminal });
			return { ok: true, code: "killed", message: `Run ${runId}: process ${pid} exited during inspection; marked done`, alreadyDead: true };
		}
		return {
			ok: false,
			code: "identity_unknown",
			message: `Run ${runId}: cannot query identity of pid ${pid}; refusing to kill (safety)`,
		};
	}
	const verdict = verifyIdentity(record, live);
	if (!verdict.ok) {
		return {
			ok: false,
			code: "pid_reused",
			message: `Run ${runId}: refusing to kill. ${verdict.reason}`,
		};
	}

	// ── 树杀 ──
	// 先置 kill 意图：kill 会让子进程 close → index.ts 的 .then 回写 result，
	// 可能早于下面的 markKilled；先记入 killedRuns 保证 finalize 保留 cancelled。
	const meta = buildMeta();
	killedRuns.set(runId, meta);
	const killRes = killProcessTree(pid);
	if (!killRes.ok) {
		killedRuns.delete(runId);
		return {
			ok: false,
			code: "kill_failed",
			message: `Run ${runId}: taskkill failed for pid ${pid}: ${killRes.out || "unknown error"}`,
		};
	}
	await waitPidGone(pid);
	procRegistry.delete(runId);
	markKilled(runsDir, record, meta, { preserveTerminal: terminal });
	return {
		ok: true,
		code: "killed",
		message: terminal
			? `Run ${runId}: killed lingering process tree (pid ${pid}, run already ${status})`
			: `Run ${runId}: killed process tree (pid ${pid}) and marked cancelled`,
		killedPids: [pid],
		alreadyDead: killRes.alreadyDead,
	};
}

/** 仅供测试/诊断：清空进程内登记与 kill 记忆。 */
export function __resetKillState(): void {
	procRegistry.clear();
	killedRuns.clear();
}
