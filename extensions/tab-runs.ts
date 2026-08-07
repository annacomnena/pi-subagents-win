/**
 * tab-runs — 标签页回收（reclaim）核心纯函数模块
 *
 * 目标：让主会话能对 launch-tabs 派发的标签页做「回收」——
 * 派发时落账本（tab-runs/<runId>.json）、轮询 session JSONL 探活、
 * 读取结构化结果文件，支撑超长程任务的编排与推进。
 *
 * 本模块只含纯函数与最小文件 IO，不注册任何工具、不修改 launch 流程
 * （阶段 0：先证明「按 taskId 前缀命中 session + 保守判态」成立）。
 *
 * 状态语义（保守原则，来自 GPT/GLM 研究报告共识）：
 *   - 只有显式结果文件（result.json）才能给出工作流终态 completed/failed/cancelled。
 *   - session JSONL 的 stopReason 只是「单轮消息原因」：
 *       toolUse → 仍在工作；stop/length → 等待输入（waiting，不是完成）；
 *       error/aborted → 本回合失败（unconfirmed，非工作流终态）。
 *   - 缺失显式结果时一律标 unconfirmed/resultMissing，绝不静默当完成。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { modePrefix, type LaunchMode } from "./launch.ts";

// ── 类型 ───────────────────────────────────────────────────────────

export type TabMode = LaunchMode;

/** 派发时主会话写入的账本记录（launch-tabs 每 task 一条）。 */
export interface TabDispatchRecord {
	/** runId，回收闭环的唯一令牌。 */
	id: string;
	version: 1;
	taskId: string;
	mode: TabMode;
	title?: string;
	/** 解析后的绝对 cwd（决定 session 桶）。 */
	cwd: string;
	requestedModel?: string;
	dispatchedAt: string;
	dispatchStatus: "dispatched" | "launch_failed";
	error?: string;
}

export interface TabUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

/** 标签页工作流终态结果（由 tab-finish 工具 / 约束契约写入）。 */
export interface TabResult {
	id: string;
	taskId: string;
	status: "completed" | "failed" | "cancelled";
	finishedAt: string;
	summary?: string;
	finalText?: string;
	artifacts?: string[];
	reportPath?: string;
	openIssues?: string[];
	usage?: TabUsage;
}

/** 单个 session JSONL 文件的探测结果。 */
export interface SessionProbe {
	filePath: string;
	/** 首条 user 消息文本是否以「根据<mode>进行工作<taskId>」前缀命中。 */
	matched: boolean;
	matchReason?: string;
	sessionId?: string;
	sessionCwd?: string;
	sessionTimestamp?: string;
	lastRole?: "user" | "assistant" | "toolResult" | "unknown";
	lastStopReason?: string;
	lastAssistantText?: string;
	usage?: TabUsage;
	messageCount: number;
	/** 探测到的首条 user 文本（截断，供诊断）。 */
	firstUserTextPreview?: string;
}

/** 保守判态结果。 */
export interface TabStatus {
	/** 生命周期阶段：只有 completed/failed/cancelled 是工作流终态。 */
	phase:
		| "dispatched"
		| "attached"
		| "working"
		| "waiting"
		| "completed"
		| "failed"
		| "cancelled"
		| "orphaned"
		| "unconfirmed";
	/** 当前回合：working / idle / error / unknown。 */
	turn: "working" | "idle" | "error" | "unknown";
	terminal: boolean;
	resultMissing: boolean;
	lastStopReason?: string;
	lastAssistantText?: string;
	usage?: TabUsage;
	source: "ledger-only" | "session-jsonl" | "result-file";
	note?: string;
}

// ── 纯函数：runId / 路径 ──────────────────────────────────────────

/** 生成回收令牌：tab_<base36 时间戳>_<随机>。 */
export function newTabRunId(now: Date = new Date()): string {
	const ts = now.getTime().toString(36);
	const rand = Math.random().toString(36).slice(2, 6);
	return `tab_${ts}_${rand}`;
}

/** 复刻 pi 的 session 桶命名：--<cwd 去首斜杠、/ \ : 转 ->--。 */
export function sessionBucketForCwd(cwd: string): string {
	const resolved = cwd.replace(/[\\/]+$/, "") || cwd;
	return `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** 默认会话根目录：~/.pi/agent/sessions。 */
export function defaultSessionsRoot(agentDir: string = join(homedir(), ".pi", "agent")): string {
	return join(agentDir, "sessions");
}

/** 默认标签页账本根目录：~/.pi/agent/tab-runs。 */
export function defaultTabRunsDir(agentDir: string = join(homedir(), ".pi", "agent")): string {
	return join(agentDir, "tab-runs");
}

// ── 纯函数：session JSONL 解析（无副作用）────────────────────────

/** 解析单行 JSON；损坏/空行返回 null（与 pi parseSessionEntryLine 一致）。 */
export function parseSessionLine(line: string): Record<string, unknown> | null {
	if (!line || !line.trim()) return null;
	try {
		const parsed = JSON.parse(line);
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function asRecord(v: unknown): Record<string, unknown> | null {
	return v !== null && typeof v === "object" && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: null;
}

/** 取消息文本：content 数组的 text 块，或纯字符串。 */
export function messageText(message: Record<string, unknown> | null): string {
	if (!message) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				const block = asRecord(part);
				return block && block.type === "text" && typeof block.text === "string"
					? block.text
					: undefined;
			})
			.filter((t): t is string => Boolean(t))
			.join("");
	}
	return "";
}

/** 累加一条 assistant 消息的 usage 到总计。 */
function accumulateUsage(total: TabUsage, message: Record<string, unknown> | null): void {
	const usage = message ? asRecord(message.usage) : null;
	if (!usage) return;
	const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
	total.input += n(usage.input);
	total.output += n(usage.output);
	total.cacheRead += n(usage.cacheRead);
	total.cacheWrite += n(usage.cacheWrite);
	total.cost += n(usage.cost);
	if (n(usage.input) > 0 || n(usage.output) > 0) total.turns += 1;
}

export function emptyTabUsage(): TabUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

/**
 * 探测一个 session JSONL 文件。
 *
 * 只读：header（首行）、逐行解析全部（大文件场景由调用方决定是否截断尾部）；
 * 对每条 message 累积 usage；记录首条 user 文本与最后一条 assistant 的 stopReason。
 * 纯函数（读文件是唯一 IO），供单测与探活共用。
 */
export function probeSessionFile(
	filePath: string,
	taskId: string,
	mode: TabMode,
	opts?: { maxTailLines?: number },
): SessionProbe {
	const probe: SessionProbe = {
		filePath,
		matched: false,
		messageCount: 0,
	};
	let text: string;
	try {
		text = readFileSync(filePath, "utf8");
	} catch {
		return probe;
	}
	const lines = text.split("\n");
	const tailLimit = opts?.maxTailLines;
	const slice = tailLimit && tailLimit > 0 ? lines.slice(-tailLimit) : lines;

	let firstUserText = "";
	let lastRole: SessionProbe["lastRole"];
	let lastStopReason: string | undefined;
	let lastAssistantText = "";
	let sawAssistant = false;
	const usage = emptyTabUsage();
	const usageSeen = new Set<string>(); // P2-1：按 message id|responseId 去重，避免多回合重复累加

	for (const line of slice) {
		const entry = parseSessionLine(line);
		if (!entry) continue;
		if (entry.type === "session") {
			probe.sessionId = typeof entry.id === "string" ? entry.id : undefined;
			probe.sessionCwd = typeof entry.cwd === "string" ? entry.cwd : undefined;
			probe.sessionTimestamp = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
			continue;
		}
		if (entry.type !== "message") continue;
		probe.messageCount += 1;
		const message = asRecord(entry.message);
		if (!message) continue;
		const role = typeof message.role === "string" ? message.role : "unknown";
		const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
		const textContent = messageText(message);
		if (role === "user") {
			// P2-2：取「第一条命中前缀的 user」而非第一条 user（避免头部被注入/空行污染）
			if (!firstUserText && textContent.trim()) {
				const firstLine = textContent.split(/\r?\n/)[0].trim();
				const prefixCheck = modePrefix(taskId, mode);
				if (firstLine === prefixCheck || firstLine.startsWith(`${prefixCheck}\n`) || firstLine.startsWith(`${prefixCheck} `)) {
					firstUserText = textContent;
				}
			}
			lastRole = "user";
		} else if (role === "assistant") {
			sawAssistant = true;
			lastRole = "assistant";
			lastStopReason = stopReason;
			const ukey = `${typeof message.id === "string" ? message.id : ""}|${typeof message.timestamp === "string" ? message.timestamp : ""}|${typeof message.responseId === "string" ? message.responseId : ""}`;
			if (ukey !== "||" && !usageSeen.has(ukey)) {
				usageSeen.add(ukey);
				accumulateUsage(usage, message);
			}
			if (textContent) lastAssistantText = textContent;
		} else if (role === "toolResult") {
			lastRole = "toolResult";
		}
	}

	probe.usage = usage;
	probe.lastRole = lastRole;
	probe.lastStopReason = lastStopReason;
	if (lastAssistantText) probe.lastAssistantText = lastAssistantText.slice(0, 2000);
	probe.firstUserTextPreview = firstUserText.slice(0, 120) || undefined;

	// 匹配：firstUserText 已在循环内按「命中前缀」选取，这里做最终判定。
	const prefix = modePrefix(taskId, mode);
	const textPart = firstUserText.split(/\r?\n/)[0].trim();
	if (textPart === prefix || textPart.startsWith(`${prefix}\n`) || textPart.startsWith(`${prefix} `)) {
		probe.matched = true;
		probe.matchReason = "first-user-prefix";
	} else {
		probe.matchReason = sawAssistant ? "no-prefix-but-active" : "no-prefix";
	}
	return probe;
}

// ── 纯函数：判态（保守）──────────────────────────────────────────

/**
 * 保守判态：把 session 探测结果映射为 TabStatus。
 *
 * 规则（GPT 报告核心安全约束）：
 *  - 无匹配 session  → dispatched（尚未附着/尚未开始写会话）
 *  - toolUse         → working
 *  - stop/length     → waiting（交互会话只是回合结束，不是完成！）
 *  - error/aborted   → unconfirmed + turn=error
 *  - 只有 user 无 assistant → working（消息在途）
 */
export function classifyTabStatus(
	probe: SessionProbe | null,
	opts?: { hasResult?: boolean; graceMs?: number; dispatchedAt?: string },
): TabStatus {
	if (opts?.hasResult) {
		// 显式结果文件优先：终态由结果文件给出（本函数不读文件，仅标记）
		return {
			phase: "completed", // 由调用方在读取 result.json 后改写为实际 status
			turn: "idle",
			terminal: true,
			resultMissing: false,
			lastStopReason: probe?.lastStopReason,
			lastAssistantText: probe?.lastAssistantText,
			usage: probe?.usage,
			source: "result-file",
			note: "explicit result present; caller must map status from result.json",
		};
	}
	if (!probe || !probe.matched) {
		// P1-1：无匹配且超过 grace 宽限 → orphaned（标签页早夭/从未附着，收敛到可重派）
		const dispatchedMs = opts?.dispatchedAt ? Date.parse(opts.dispatchedAt) : NaN;
		const graceMs = opts?.graceMs ?? 5 * 60_000;
		const now = Date.now();
		if (!Number.isNaN(dispatchedMs) && now > dispatchedMs + graceMs) {
			return {
				phase: "orphaned",
				turn: "unknown",
				terminal: false,
				resultMissing: true,
				lastStopReason: probe?.lastStopReason,
				source: "ledger-only",
				note: `no session/state within grace (${Math.round((now - dispatchedMs) / 1000)}s since dispatch)`,
			};
		}
		return {
			phase: "dispatched",
			turn: "unknown",
			terminal: false,
			resultMissing: true,
			lastStopReason: probe?.lastStopReason,
			source: "ledger-only",
			note: probe ? probe.matchReason : "no matching session file yet",
		};
	}

	const reason = probe.lastStopReason;
	const lastRole = probe.lastRole;
	const base = {
		lastStopReason: reason,
		lastAssistantText: probe.lastAssistantText,
		usage: probe.usage,
		resultMissing: true,
		source: "session-jsonl" as const,
	};

	if (reason === "toolUse") {
		return { ...base, phase: "working", turn: "working", terminal: false };
	}
	if (reason === "stop" || reason === "length") {
		return { ...base, phase: "waiting", turn: "idle", terminal: false };
	}
	if (reason === "error" || reason === "aborted") {
		return {
			...base,
			phase: "unconfirmed",
			turn: "error",
			terminal: false,
			note: `last assistant stopReason=${reason}; no explicit result — workflow completion unconfirmed`,
		};
	}
	if (lastRole === "user") {
		return { ...base, phase: "working", turn: "working", terminal: false, note: "user message in flight" };
	}
	if (!lastRole || lastRole === "unknown") {
		return { ...base, phase: "dispatched", turn: "unknown", terminal: false };
	}
	return { ...base, phase: "working", turn: "working", terminal: false };
}

// ── 纯函数：结果文件读写与校验 ──────────────────────────────────

/** 校验 TabResult 的字段类型（宽松：可选字段缺省即通过，错误字段拒绝）。 */
export function validateTabResult(raw: unknown): { ok: boolean; errors: string[]; value?: TabResult } {
	const record = asRecord(raw);
	if (!record) return { ok: false, errors: ["not an object"] };
	const errors: string[] = [];
	const str = (v: unknown): string | undefined =>
		typeof v === "string" ? v : undefined;
	const strArr = (v: unknown): string[] | undefined =>
		Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;

	const status = str(record.status);
	if (!status || !["completed", "failed", "cancelled"].includes(status)) {
		errors.push(`status must be completed|failed|cancelled, got ${String(status)}`);
	}
	if (!str(record.id)) errors.push("id (runId) required");
	if (!str(record.taskId)) errors.push("taskId required");
	if (!str(record.finishedAt)) errors.push("finishedAt required");

	const value: TabResult = {
		id: str(record.id) ?? "",
		taskId: str(record.taskId) ?? "",
		status: (status as TabResult["status"]) ?? "failed",
		finishedAt: str(record.finishedAt) ?? "",
		summary: str(record.summary),
		finalText: str(record.finalText),
		artifacts: strArr(record.artifacts),
		reportPath: str(record.reportPath),
		openIssues: strArr(record.openIssues),
	};
	if (asRecord(record.usage)) {
		const u = asRecord(record.usage)!;
		const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
		value.usage = {
			input: n(u.input),
			output: n(u.output),
			cacheRead: n(u.cacheRead),
			cacheWrite: n(u.cacheWrite),
			cost: n(u.cost),
			turns: n(u.turns),
		};
	}
	return { ok: errors.length === 0, errors, value };
}

/** 读取并校验 <runsDir>/<runId>.result.json；缺失/损坏返回 null。 */
export function readTabResultFile(runsDir: string, runId: string): TabResult | null {
	const path = join(runsDir, `${runId}.result.json`);
	if (!existsSync(path)) return null;
	try {
		const raw = JSON.parse(readFileSync(path, "utf8"));
		const check = validateTabResult(raw);
		return check.ok && check.value ? check.value : null;
	} catch {
		return null;
	}
}

/** 列出 <runsDir> 下全部 .result.json 的 runId（去 .result.json 后缀）。 */
export function listTabResults(runsDir: string): string[] {
	if (!existsSync(runsDir)) return [];
	return readdirSync(runsDir)
		.filter((f) => f.endsWith(".result.json"))
		.map((f) => f.slice(0, -".result.json".length));
}

// ── 账本 / 状态文件（派发记录、state、result 路径与原子读写）────────

/** 标签页生命周期状态（由标签页进程遥测写入）。 */
export interface TabState {
	id: string;
	phase: "attached" | "working" | "waiting" | "completed" | "failed" | "cancelled" | "orphaned";
	turn: "working" | "idle" | "error" | "unknown";
	/** 只有显式终态信号才为 true。 */
	terminal: boolean;
	sessionPath?: string;
	pid?: number;
	lastActivityAt?: string;
	lastAssistantText?: string;
	lastStopReason?: string;
	usage?: TabUsage;
	error?: string;
}

export function tabDispatchPath(runsDir: string, runId: string): string {
	return join(runsDir, `${runId}.json`);
}

export function tabStatePath(runsDir: string, runId: string): string {
	return join(runsDir, `${runId}.state.json`);
}

export function tabResultPath(runsDir: string, runId: string): string {
	return join(runsDir, `${runId}.result.json`);
}

/** 原子写 JSON：写 .tmp 后 rename。目录自动创建。 */
export function writeJsonAtomic(filePath: string, value: unknown): void {
	// P1-6：用 path.dirname 替代手写 slice，dir==="" 时回退到当前目录
	const dir = dirname(filePath);
	if (dir && dir !== "." && !existsSync(dir)) mkdirSync(dir, { recursive: true });
	const tmp = `${filePath}.tmp`;
	writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
	renameSync(tmp, filePath);
}

/** 校验 TabDispatchRecord（宽松校验）。 */
export function validateTabDispatchRecord(raw: unknown): { ok: boolean; errors: string[]; value?: TabDispatchRecord } {
	const record = asRecord(raw);
	if (!record) return { ok: false, errors: ["not an object"] };
	const errors: string[] = [];
	const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
	if (!str(record.id)) errors.push("id required");
	if (record.version !== 1) errors.push("version must be 1");
	if (!str(record.taskId)) errors.push("taskId required");
	if (!str(record.cwd)) errors.push("cwd required");
	if (!str(record.dispatchedAt)) errors.push("dispatchedAt required");
	if (!["dispatched", "launch_failed"].includes(String(record.dispatchStatus))) {
		errors.push("dispatchStatus must be dispatched|launch_failed");
	}
	const mode = str(record.mode);
	if (mode && !["workflow", "research", "execute"].includes(mode)) errors.push("mode must be workflow|research|execute");
	if (errors.length > 0) return { ok: false, errors };
	const value: TabDispatchRecord = {
		id: str(record.id)!,
		version: 1,
		taskId: str(record.taskId)!,
		mode: (mode as TabDispatchRecord["mode"]) ?? "workflow",
		cwd: str(record.cwd)!,
		dispatchedAt: str(record.dispatchedAt)!,
		dispatchStatus: record.dispatchStatus === "launch_failed" ? "launch_failed" : "dispatched",
	};
	const title = str(record.title);
	if (title !== undefined) value.title = title;
	const requestedModel = str(record.requestedModel);
	if (requestedModel !== undefined) value.requestedModel = requestedModel;
	const error = str(record.error);
	if (error !== undefined) value.error = error;
	return { ok: true, errors, value };
}

/** 写派发账本：<runsDir>/<runId>.json。 */
export function writeTabDispatch(runsDir: string, record: TabDispatchRecord): void {
	writeJsonAtomic(tabDispatchPath(runsDir, record.id), record);
}

/** 读派发账本；缺失/损坏返回 null。 */
export function readTabDispatch(runsDir: string, runId: string): TabDispatchRecord | null {
	const path = tabDispatchPath(runsDir, runId);
	if (!existsSync(path)) return null;
	try {
		const check = validateTabDispatchRecord(JSON.parse(readFileSync(path, "utf8")));
		return check.ok && check.value ? check.value : null;
	} catch {
		return null;
	}
}

/** 列出全部派发记录（按 dispatchedAt 倒序）。 */
export function listTabDispatches(runsDir: string): TabDispatchRecord[] {
	if (!existsSync(runsDir)) return [];
	const out: TabDispatchRecord[] = [];
	for (const f of readdirSync(runsDir)) {
		if (!f.endsWith(".json") || f.endsWith(".state.json") || f.endsWith(".result.json") || f.endsWith(".tmp")) continue;
		const r = readTabDispatch(runsDir, f.slice(0, -".json".length));
		if (r) out.push(r);
	}
	return out.sort((a, b) => Date.parse(b.dispatchedAt) - Date.parse(a.dispatchedAt));
}

/** 校验 TabState（宽松校验）。 */
export function validateTabState(raw: unknown): { ok: boolean; errors: string[]; value?: TabState } {
	const record = asRecord(raw);
	if (!record) return { ok: false, errors: ["not an object"] };
	const errors: string[] = [];
	const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
	if (!str(record.id)) errors.push("id required");
	const phase = str(record.phase);
	if (!phase || !["attached", "working", "waiting", "completed", "failed", "cancelled", "orphaned"].includes(phase)) {
		errors.push(`phase invalid: ${String(phase)}`);
	}
	const turn = str(record.turn);
	if (turn && !["working", "idle", "error", "unknown"].includes(turn)) errors.push(`turn invalid: ${String(turn)}`);
	if (typeof record.terminal !== "boolean") errors.push("terminal must be boolean");
	if (errors.length > 0) return { ok: false, errors };
	const value: TabState = {
		id: str(record.id)!,
		phase: (phase as TabState["phase"]) ?? "attached",
		turn: (turn as TabState["turn"]) ?? "unknown",
		terminal: record.terminal as boolean,
	};
	const sessionPath = str(record.sessionPath);
	if (sessionPath !== undefined) value.sessionPath = sessionPath;
	if (typeof record.pid === "number") value.pid = record.pid;
	const lastActivityAt = str(record.lastActivityAt);
	if (lastActivityAt !== undefined) value.lastActivityAt = lastActivityAt;
	const lastAssistantText = str(record.lastAssistantText);
	if (lastAssistantText !== undefined) value.lastAssistantText = lastAssistantText;
	const lastStopReason = str(record.lastStopReason);
	if (lastStopReason !== undefined) value.lastStopReason = lastStopReason;
	const err = str(record.error);
	if (err !== undefined) value.error = err;
	if (asRecord(record.usage)) {
		const u = asRecord(record.usage)!;
		const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
		value.usage = {
			input: n(u.input), output: n(u.output), cacheRead: n(u.cacheRead),
			cacheWrite: n(u.cacheWrite), cost: n(u.cost), turns: n(u.turns),
		};
	}
	return { ok: true, errors, value };
}

/** 写标签页状态：<runsDir>/<runId>.state.json（原子）。 */
export function writeTabState(runsDir: string, runId: string, state: TabState): void {
	writeJsonAtomic(tabStatePath(runsDir, runId), state);
}

/** 读标签页状态；缺失/损坏返回 null。 */
export function readTabState(runsDir: string, runId: string): TabState | null {
	const path = tabStatePath(runsDir, runId);
	if (!existsSync(path)) return null;
	try {
		const check = validateTabState(JSON.parse(readFileSync(path, "utf8")));
		return check.ok && check.value ? check.value : null;
	} catch {
		return null;
	}
}

/** 读派发记录（别名，供运行时使用）。 */
export function readTabDispatchRecord(runsDir: string, runId: string): TabDispatchRecord | null {
	return readTabDispatch(runsDir, runId);
}

/**
 * 按派发记录探活：在 cwd 对应的 session 桶里找「首条 user 前缀匹配 taskId」的会话文件。
 * 同 taskId 重复派发时，用 dispatchedAt 时间窗消歧（dispatchedAt-60s 之后创建的才候选，取最近）。
 */
export function probeSessionsForDispatch(
	record: TabDispatchRecord,
	sessionsRoot: string = defaultSessionsRoot(),
): SessionProbe[] {
	const bucket = join(sessionsRoot, sessionBucketForCwd(record.cwd));
	if (!existsSync(bucket)) return [];
	const dispatchedMs = Date.parse(record.dispatchedAt);
	const out: SessionProbe[] = [];
	for (const f of readdirSync(bucket)) {
		if (!f.endsWith(".jsonl")) continue;
		const full = join(bucket, f);
		const probe = probeSessionFile(full, record.taskId, record.mode);
		if (!probe.matched) continue;
		if (!Number.isNaN(dispatchedMs)) {
			// 时间窗消歧：优先 header.sessionTimestamp；缺失时回退文件 mtime（P1-3）
			let sessionMs = probe.sessionTimestamp ? Date.parse(probe.sessionTimestamp) : NaN;
			if (Number.isNaN(sessionMs)) {
				try {
					sessionMs = statSync(full).mtimeMs;
				} catch {
					/* stat 失败视为无法判定，保留候选 */
				}
			}
			if (!Number.isNaN(sessionMs) && sessionMs < dispatchedMs - 60_000) continue;
		}
		out.push(probe);
	}
	// 最近创建的优先（sessionTimestamp 降序；缺失回退 mtime）
	return out.sort((a, b) => {
		const ta = a.sessionTimestamp ? Date.parse(a.sessionTimestamp) : NaN;
		const tb = b.sessionTimestamp ? Date.parse(b.sessionTimestamp) : NaN;
		const sa = Number.isNaN(ta) ? 0 : ta;
		const sb = Number.isNaN(tb) ? 0 : tb;
		return sb - sa;
	});
}

/** 组装单个 runId 的完整回收快照（dispatch + state + result + probe）。 */
export function buildTabStatusView(
	runsDir: string,
	runId: string,
	sessionsRoot: string = defaultSessionsRoot(),
): TabStatusView {
	const dispatch = readTabDispatch(runsDir, runId);
	const state = readTabState(runsDir, runId);
	const result = readTabResultFile(runsDir, runId);
	const probe = dispatch ? (probeSessionsForDispatch(dispatch, sessionsRoot)[0] ?? null) : null;
	// P1-1：透传 dispatchedAt 供 orphaned grace 判定
	return composeTabStatus({ runId, dispatch, state, result, probe, dispatchedAt: dispatch?.dispatchedAt });
}

// ── 组合判态：dispatch + state + result + probe 汇总 ────────────────

/** 主会话视角的完整回收快照（tab-status / reclaim-tabs 的机器接口）。 */
export interface TabStatusView {
	runId: string;
	dispatch: TabDispatchRecord | null;
	phase: TabLifecyclePhase;
	turn: "working" | "idle" | "error" | "unknown";
	terminal: boolean;
	resultMissing: boolean;
	result?: TabResult;
	state?: TabState;
	probe?: SessionProbe | null;
	lastAssistantText?: string;
	usage?: TabUsage;
	source: "result-file" | "state-file" | "session-jsonl";
	note?: string;
}

/**
 * 组合判态优先级：result（显式终态）> state（标签页遥测）> JSONL 探活（保守降级）。
 * 纯函数，供 tab-status / reclaim-tabs 共用。
 */
export function composeTabStatus(opts: {
	runId: string;
	dispatch: TabDispatchRecord | null;
	state: TabState | null;
	result: TabResult | null;
	probe: SessionProbe | null;
	/** P1-1：orphaned grace 判定所需（由 buildTabStatusView 透传 dispatch.dispatchedAt）。 */
	dispatchedAt?: string;
	graceMs?: number;
}): TabStatusView {
	const { runId, dispatch, state, result, probe, dispatchedAt, graceMs } = opts;

	// 1) 显式结果：唯一工作流终态来源
	if (result) {
		return {
			runId,
			dispatch,
			result,
			state,
			probe,
			phase: result.status,
			turn: "idle",
			terminal: true,
			resultMissing: false,
			lastAssistantText: result.finalText,
			usage: result.usage,
			source: "result-file",
		};
	}

	// 2) 标签页遥测状态
	if (state) {
		return {
			runId,
			dispatch,
			state,
			probe,
			result: undefined,
			phase: state.phase,
			turn: state.turn,
			terminal: state.terminal,
			resultMissing: true,
			lastAssistantText: state.lastAssistantText,
			usage: state.usage,
			source: "state-file",
			note: state.terminal ? undefined : "no explicit result yet",
		};
	}

	// 3) JSONL 探活（保守；无匹配时按 dispatchedAt+grace 收敛 orphaned）
	const status = classifyTabStatus(probe, { dispatchedAt, graceMs });
	return {
		runId,
		dispatch,
		state: undefined,
		probe,
		result: undefined,
		phase: status.phase,
		turn: status.turn,
		terminal: status.terminal,
		resultMissing: status.resultMissing,
		lastAssistantText: status.lastAssistantText,
		usage: status.usage,
		source: "session-jsonl",
		note: status.note,
	};
}
