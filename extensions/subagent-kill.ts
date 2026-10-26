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
// 卡片投影的循环判据与摘要截断与 TUI 侧同源（classifyLoop / ARGS_DIGEST_MAX_CHARS），
// 不复制阈值：两边口径漂移会让「GUI 说卡住」与「工具说 ok」互相打脸。
import { ARGS_DIGEST_MAX_CHARS, classifyLoop, truncateUtf8, type RecentCallEntry } from "./recent-calls.ts";
// 归属元数据（P1A）：只借类型，不借实现——links 的读盘/统计仍留在 links.ts（单一入口）。
import type { LinkRecord } from "./links.ts";

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
/** 运行中 recentCalls 明细落盘节流：≤1 次/5s（与心跳同频上限，避免 tool 事件风暴写盘）。 */
export const RECENT_CALLS_PERSIST_INTERVAL_MS = 5_000;

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

/**
 * 增量合并写 run json（同步读-改-写，保留其它字段）。
 *
 * 用途：运行中的 async run 把最近工具调用明细（recentCalls/lastToolTurn/turnClock）同步回
 * run json，供 `action:"recent-calls"` 在 run **运行期间**就能发现重复循环，
 * 而不是等 close 后才由 result.recentCalls 快照写入（旧行为运行中只有 no-detail）。
 *
 * 合并安全（防与 killAsyncRun 竞态 / 防旧快照回滚）：写前**重新读盘**，再把 patch 覆盖到
 * 盘上最新记录，而不是调用方持有的旧快照——因此 killAsyncRun / registerRunProcess /
 * touchRunActivity 写入的 status/killedAt/pid/lastActivity 不会被旧快照回滚。
 * 本函数与 markKilled 都是同步读-改-写，事件循环内不会相互穿插。
 * patch 中值为 undefined 的键跳过；记录不存在（尚未落盘/已清理）→ no-op 返回 false。
 */
export function mergeRunRecord(
	runId: string,
	patch: Record<string, unknown>,
	runsDir: string = DEFAULT_RUNS_DIR,
): boolean {
	const record = readRecord(runsDir, runId);
	if (!record) return false;
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined) continue;
		record[key] = value;
	}
	writeRecord(runsDir, record);
	return true;
}

/**
 * 节流版 mergeRunRecord：同一 run 内 ≤1 次 / intervalMs（缺省 5s）。
 * 被节流时返回 false（未落盘）；真正写入返回 mergeRunRecord 结果。首调用立即落盘。
 */
export function createThrottledRunMerger(
	runId: string,
	runsDir: string = DEFAULT_RUNS_DIR,
	intervalMs: number = RECENT_CALLS_PERSIST_INTERVAL_MS,
): (patch: Record<string, unknown>) => boolean {
	let lastPersistedMs = 0;
	return (patch: Record<string, unknown>): boolean => {
		const now = Date.now();
		if (now - lastPersistedMs < intervalMs) return false;
		lastPersistedMs = now;
		return mergeRunRecord(runId, patch, runsDir);
	};
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

/**
 * ── 卡片投影（`GET /v1/runs` 端点专用，2026-10-22）────────────────
 *
 * 与 `listAsyncRunSummaries` 的关系：**同一份读盘逻辑的另一个投影**，不改它的返回形状
 * （`subagent-win{status/list}` 与 async-panel 都在消费 `RunSummary`）。两者的关键差别：
 *   - `RunSummary.pidAlive?: boolean` 是**二态**，pid 缺失时是 `undefined`；卡片需要**三态**
 *     `alive | dead | unknown`，因为 UI 必须能把「不知道」和「确定没活」分开显示——
 *     把 unknown 当 running 展示是错的（会谎报「运行中」），当 dead 展示也是错的（会谎报失败）。
 *   - 卡片带 `usage`（`result.usage`，运行中恒 null）与可选 `recentCalls` / `loopVerdict`。
 *
 * **纯读**：不写盘、不碰 registry、不 kill；任何单份坏 json 跳过（never-throw）。
 */
export type RunLiveness = "alive" | "dead" | "unknown";

/** `result.usage` 的六个聚合量（与 `AsyncRunRecord.result.usage` 同形）。 */
export interface RunCardUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

/** 一次工具调用（`recentCalls` 元素；`argsDigest` 已截 ≤160 字节）。 */
export interface RunCardCall {
	tool: string;
	argsDigest: string;
	ts: string;
	turn: number;
}

/** 循环判据：`classifyLoop` 的三值 + 终态恒 `unknown`（终态 verdict 不是「卡住」的证据）。 */
export type RunCardVerdict = "ok" | "repeating" | "no_progress" | "unknown";

/** 一行一 run 的卡片数据（`GET /v1/runs` 契约字段面，version:1 后只增不改）。 */
export interface RunCard {
	id: string;
	agent: string | null;
	taskPreview: string;
	status: string;
	liveness: RunLiveness;
	pid: number | null;
	startedAt: string | null;
	lastActivity: string | null;
	/** `result.usage`；缺失（运行中常态）⇒ null。**不从 result 之外推断**。 */
	usage: RunCardUsage | null;
	/**
	 * 末次尝试耗时（ms，2026-10-26 additive）。
	 *
	 * ⚠️ **不是整趟墙钟**：`runSingle()` 每次尝试各自起钟（`index.ts:1478/1488`），
	 * `runWithFallback` 有 fallback/重试时会多次调用，而 `withAllAttemptUsage()` **只聚合用量
	 * 不聚合时长** ⇒ 有 `priorFailures` 的 run 这里只是**最后一次尝试**的耗时。
	 * UI 必须照“末次尝试耗时”措辞展示；缺失（运行中/旧记录）⇒ null，**不反推 startedAt↔endedAt**。
	 */
	durationMs: number | null;
	/**
	 * 直接派发者（`links.jsonl` kind=async 的 `sessionId`：pi 会话 UUID 或 `tab_<runId>`）。
	 *
	 * 口径（2026-10-26）：“直接”= 发起该 run 的那一条 link，**不取兄弟 run、不取第一个匹配**。
	 * - 冲突（同一 targetId 有多个不同派发者）⇒ **null**，绝不取第一个；
	 * - 无 link（missing）⇒ 本键**不出现**（与冲突的 null 区分）。
	 */
	dispatchedBy?: string | null;
	/** 仅 includeRecentCalls=1 出现；最近 3 条，**newest-first**。 */
	recentCalls?: RunCardCall[];
	/** 仅 includeRecentCalls=1 出现；只对 `status==="running"` 给 verdict，终态恒 "unknown"。 */
	loopVerdict?: RunCardVerdict;
}

/**
 * 归属可判定性（`GET /v1/runs` 的 `attribution`，2026-10-26）。
 * - `complete`：每条可读 run 都能解析出**唯一**直接派发者，且该身份**可直接**与 scope 比较
 *   （UUID 直接用；`tab_*` 有 `ownerSessionId` 才可映射）。
 * - `partial`：存在 `tabUnmapped` / `missing` / `conflict` 中的任意一项（详见 `attributionDetail`）。
 * - `unavailable`：`links.jsonl` 不可读/解析异常率异常 ⇒ **归属元数据不可用**，
 *   而不是“没有派发”（两者绝不能混为一谈）。
 */
export type RunAttribution = "complete" | "partial" | "unavailable";

/** 归属三类残差计数（分母 = **过滤前、去重后**的可读 run 总数；计数在 limit 截断前）。 */
export interface RunAttributionDetail {
	/** 唯一派发者且可直接与 scope 比较。 */
	resolved: number;
	/** 派发者是 `tab_*` 且无 `ownerSessionId` ⇒ 无法映射到 pi 会话（存量记录的形态）。 */
	tabUnmapped: number;
	/** 无 kind=async link。 */
	missing: number;
	/** 同一 targetId 有多个不同派发者（或同一派发者多个 owner）⇒ 不猜。 */
	conflict: number;
}

/** `indexRunAttribution` 的产出：归属三态 + 计数 + 两张 per-run 索引。 */
export interface RunAttributionIndex {
	attribution: RunAttribution;
	attributionDetail: RunAttributionDetail;
	/** runId → 直接派发者（唯一）；冲突 ⇒ null；无 link ⇒ **不出现该键**。 */
	dispatchedBy: Map<string, string | null>;
	/** runId → 可与 scope 比对的身份集合（`sessionId` + 可用的 `ownerSessionId`）。 */
	matchableIds: Map<string, string[]>;
}

/** `?limit` 缺省 50 / 上限 200（与端点契约一致）。 */
export const RUNS_LIMIT_DEFAULT = 50;
export const RUNS_LIMIT_MAX = 200;
/** 卡片携带的 recentCalls 条数上限。 */
export const RUN_CARD_RECENT_CALLS = 3;

/**
 * pid → 三态判活。**永不从 status 猜**（R-11：缺 pid 是常态——实测 2/154 带 pid）。
 * 负数/非整数视为「没有 pid」⇒ unknown（不是 dead）。
 */
export function classifyRunLiveness(pid: unknown): { liveness: RunLiveness; pid: number | null } {
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return { liveness: "unknown", pid: null };
	return { liveness: isPidAlive(pid) ? "alive" : "dead", pid };
}

function readRunRecords(runsDir: string): KillableRunRecord[] {
	if (!existsSync(runsDir)) return [];
	const records: KillableRunRecord[] = [];
	for (const f of readdirSync(runsDir)) {
		if (!f.endsWith(".json")) continue;
		try {
			const rec = JSON.parse(readFileSync(join(runsDir, f), "utf8")) as KillableRunRecord;
			if (rec && typeof rec.id === "string") records.push(rec);
		} catch {
			/* skip bad json（never-throw：一份坏文件不能拖垮整个列表） */
		}
	}
	return records;
}

function usageOf(record: KillableRunRecord): RunCardUsage | null {
	const raw = (record.result as { usage?: unknown } | undefined)?.usage;
	if (raw === null || typeof raw !== "object") return null;
	const u = raw as Record<string, unknown>;
	const num = (k: string): number => (typeof u[k] === "number" && Number.isFinite(u[k]) ? (u[k] as number) : 0);
	return { input: num("input"), output: num("output"), cacheRead: num("cacheRead"), cacheWrite: num("cacheWrite"), cost: num("cost"), turns: num("turns") };
}

function recentCallsOf(record: KillableRunRecord): RecentCallEntry[] {
	const raw = (record as { recentCalls?: unknown }).recentCalls;
	if (!Array.isArray(raw)) return [];
	const out: RecentCallEntry[] = [];
	for (const item of raw) {
		if (item === null || typeof item !== "object") continue;
		const e = item as Record<string, unknown>;
		if (typeof e.tool !== "string" || typeof e.ts !== "string") continue;
		out.push({
			tool: e.tool,
			argsDigest: typeof e.argsDigest === "string" ? e.argsDigest : "",
			ts: e.ts,
			turn: typeof e.turn === "number" && Number.isFinite(e.turn) ? e.turn : 0,
		});
	}
	return out;
}

/**
 * 归属索引（纯函数，2026-10-26 P1A）：把「runId 集合 × links 账本」归约为三态 + 计数 + 两张索引。
 *
 * 输入纪律：
 * - `runIds`：**过滤前、去重后**的可读 runId（分母就在这里固定）；
 * - `links`：`null` = 账本不可读/解析异常率异常 ⇒ **`unavailable`**（不是“没有派发”）。
 *
 * 判据（每条 run 独立）：
 * 1. 无 kind=async link（`sessionId` 非空且 ≠"unknown"）⇒ `missing`；
 * 2. 不同派发者 >1 ⇒ `conflict`（`dispatchedBy=null`，**不取第一个**）；
 * 3. 单一派发者但 owner 候选 >1 ⇒ 也计 `conflict`（映射歧义，宁可不猜）；
 * 4. 单一派发者且 `tab_*` 无 `ownerSessionId` ⇒ `tabUnmapped`（存量记录）；
 * 5. 其余 ⇒ `resolved`（UUID 直接用；`tab_*` 有 owner 可映射）。
 */
export function indexRunAttribution(
	runIds: readonly string[],
	links: readonly LinkRecord[] | null,
): RunAttributionIndex {
	const detail: RunAttributionDetail = { resolved: 0, tabUnmapped: 0, missing: 0, conflict: 0 };
	const dispatchedBy = new Map<string, string | null>();
	const matchableIds = new Map<string, string[]>();
	if (links === null) {
		// 账本不可用：**不**输出任何 per-run 归属（不谎报 missing/complete），计数全 0 并整体标 unavailable。
		return { attribution: "unavailable", attributionDetail: detail, dispatchedBy, matchableIds };
	}
	// 一次遍历建 targetId → links 索引（避免 O(run×link) 重扫；links 实测可到数千行）。
	const byTarget = new Map<string, LinkRecord[]>();
	for (const link of links) {
		if (link.kind !== "async") continue;
		if (typeof link.sessionId !== "string" || link.sessionId.length === 0 || link.sessionId === "unknown") continue;
		if (typeof link.targetId !== "string" || link.targetId.length === 0) continue;
		const arr = byTarget.get(link.targetId);
		if (arr === undefined) byTarget.set(link.targetId, [link]);
		else arr.push(link);
	}
	for (const runId of runIds) {
		const own = byTarget.get(runId);
		if (own === undefined || own.length === 0) {
			detail.missing += 1;
			continue;
		}
		const dispatchers = [...new Set(own.map((l) => l.sessionId))].sort();
		if (dispatchers.length > 1) {
			detail.conflict += 1;
			dispatchedBy.set(runId, null);
			continue;
		}
		const dispatcher = dispatchers[0]!;
		const owners = [
			...new Set(
				own
					.map((l) => l.ownerSessionId)
					.filter((v): v is string => typeof v === "string" && v.length > 0),
			),
		].sort();
		if (owners.length > 1) {
			// 同一 run 的多个 link 指向不同属主 ⇒ 映射歧义（例：同 run 被两个会话重复登记）。
			detail.conflict += 1;
			dispatchedBy.set(runId, null);
			continue;
		}
		dispatchedBy.set(runId, dispatcher);
		matchableIds.set(runId, owners.length === 1 ? [dispatcher, owners[0]!] : [dispatcher]);
		if (dispatcher.startsWith("tab_") && owners.length === 0) detail.tabUnmapped += 1;
		else detail.resolved += 1;
	}
	const incomplete = detail.tabUnmapped + detail.missing + detail.conflict > 0;
	return { attribution: incomplete ? "partial" : "complete", attributionDetail: detail, dispatchedBy, matchableIds };
}

/**
 * 列出 run 卡片（running 优先 → `startedAt` 降序；`limit` 截断在排序**之后**）。
 * 返回 `total` = **过滤后**、截断前的记录数（UI 用它表达「显示 N / 共 M」）。
 *
 * 过滤（`sessionScope`，2026-10-26 P1A）在**本函数内部**、排序后、`limit` **之前**执行——
 * 若交给调用方“先取 50 条再筛”，小会话会被全局前 50 摊平到空。
 * 口径：`link.sessionId === sid || link.ownerSessionId === sid`（双身份，见 links.ts）。
 */
export function listAsyncRunCards(
	runsDir: string = DEFAULT_RUNS_DIR,
	opts: {
		limit?: number;
		includeRecentCalls?: boolean;
		/** `links.jsonl` 的 async 记录；`null`/缺省 ⇒ 归属不可用（不影响卡片本身）。 */
		links?: readonly LinkRecord[] | null;
		/** 规范化后的 scope（已去重/排序）；缺省/空 ⇒ 本机全量。 */
		sessionScope?: readonly string[];
	} = {},
): { total: number; runs: RunCard[]; attribution: RunAttribution; attributionDetail: RunAttributionDetail } {
	const limitRaw = opts.limit;
	const limit =
		typeof limitRaw === "number" && Number.isInteger(limitRaw) && limitRaw > 0
			? Math.min(limitRaw, RUNS_LIMIT_MAX)
			: RUNS_LIMIT_DEFAULT;
	const includeRecentCalls = opts.includeRecentCalls === true;
	const records = readRunRecords(runsDir);
	// 分母：过滤前、去重后的可读 runId（去重是因为“读到的记录数”与“可读 run 数”不是同一个量）。
	const attributionIndex = indexRunAttribution([...new Set(records.map((r) => r.id))], opts.links ?? null);
	const cards: RunCard[] = records.map((r) => {
		const { liveness, pid } = classifyRunLiveness(r.pid);
		const lastIso = r.lastActivity ?? r.pidRecordedAt ?? r.startedAt;
		const durRaw = (r.result as { durationMs?: unknown } | undefined)?.durationMs;
		const card: RunCard = {
			id: r.id,
			agent: typeof r.agent === "string" ? r.agent : null,
			taskPreview: String(r.task ?? "").replace(/\s+/g, " ").slice(0, 40),
			status: r.status,
			liveness,
			pid,
			startedAt: r.startedAt ?? null,
			lastActivity: lastIso ?? null,
			usage: usageOf(r),
			// 末次尝试耗时（见 RunCard.durationMs 注释）；非 finite 数值一律 null（不臆造）。
			durationMs: typeof durRaw === "number" && Number.isFinite(durRaw) ? durRaw : null,
		};
		const by = attributionIndex.dispatchedBy.get(r.id);
		if (by !== undefined) card.dispatchedBy = by;
		if (includeRecentCalls) {
			// newest-first（与 formatRecentCalls 的展示口径一致）；record 内是 newest-last 环形。
			const ring = recentCallsOf(r);
			const tail = ring.slice(Math.max(0, ring.length - RUN_CARD_RECENT_CALLS));
			card.recentCalls = tail
				.slice()
				.reverse()
				.map((e) => ({ tool: e.tool, argsDigest: truncateUtf8(e.argsDigest, ARGS_DIGEST_MAX_CHARS), ts: e.ts, turn: e.turn }));
			// 终态 verdict 不是「卡住」证据（报告 §1.5）⇒ 终态恒 unknown，不算不猜。
			card.loopVerdict =
				r.status === "running"
					? classifyLoop(ring, {
							turnClock: typeof r.turnClock === "number" && Number.isFinite(r.turnClock) ? r.turnClock : 0,
							lastToolTurn: typeof r.lastToolTurn === "number" && Number.isFinite(r.lastToolTurn) ? r.lastToolTurn : 0,
						}).verdict
					: "unknown";
		}
		return card;
	});
	cards.sort((a, b) => {
		const ra = a.status === "running" ? 0 : 1;
		const rb = b.status === "running" ? 0 : 1;
		if (ra !== rb) return ra - rb;
		return (b.startedAt ?? "").localeCompare(a.startedAt ?? "");
	});
	// 过滤在排序后、limit 前（§3.2）；scope 为空/缺省 ⇒ 本机全量，**不依赖 links**。
	const scope = opts.sessionScope ?? [];
	const scopeSet = new Set(scope.filter((s) => typeof s === "string" && s.length > 0));
	const visible = scopeSet.size === 0
		? cards
		: cards.filter((c) => (attributionIndex.matchableIds.get(c.id) ?? []).some((sid) => scopeSet.has(sid)));
	return {
		total: visible.length,
		runs: visible.slice(0, limit),
		attribution: attributionIndex.attribution,
		attributionDetail: attributionIndex.attributionDetail,
	};
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
