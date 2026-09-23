/**
 * subagent-win — Windows 兼容的轻量子 agent 扩展
 *
 * 核心机制：
 *   - 默认：spawn("node", [piCliPath, "--mode", "json", ...])
 *   - 外部 CLI：model 为 cli:claude | cli:codex | cli:agy | cli:atomcode | cli:zcode 时，spawn 本地 harness
 * 支持单 agent、并行、异步三种模式。
 */

import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Editor, fuzzyFilter, Key, Markdown, matchesKey, Spacer, Text, type EditorTheme } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	isExternalCliModel,
	normalizeExternalCliModel,
	listExternalCliModelOptions,
	runExternalCli,
	type ExternalSubagentResult,
} from "./external-cli.ts";
import { registerCodexHeaders } from "./codex-headers.ts";
import { registerSubPresetsCommand } from "./model-presets.ts";
import { litePromptLines, registerLiteCommand, type LiteMode } from "./lite-mode.ts";
import { launchTraceRun, readTraceRunMeta } from "./trace-fusion/launch-workers.ts";
import { maybeAutoCollectTraceRun } from "./trace-fusion/supervisor.ts";
import { readTraceFusionConfig } from "./trace-fusion/config.ts";
import { collectRunArtifacts } from "./trace-fusion/artifacts.ts";
import { cleanTraceRun } from "./trace-fusion/clean.ts";
import { registerHotspot } from "./hotspot/index.ts";
import { runCrossTest, finishDiagnoseRun } from "./trace-fusion/cross-test.ts";
import { defaultRunsDir as defaultTraceFusionRunsDir, TRACE_LANES } from "./trace-fusion/types.ts";
import { registerWikiNav } from "./wiki-nav.ts";
import { registerSessionHooks } from "./session-hooks.ts";
import { getPendingReminder } from "./runtime/master-succession.ts";
import { anyLedgerPresent, formatRecentScopes, listRecentScopes } from "./runtime/recent-scopes.ts";
import { runtimeHostStatus, startRuntimeHost, stopRuntimeHost } from "./runtime-host/server.ts";
import { registerTimers } from "./timers-runtime.ts";
import { registerTabTelemetry, registerTabStatusTools } from "./tab-runs-runtime.ts";
import { registerMasterTools, type DispatchTab } from "./master-tools.ts";
import { readAttachment } from "./runtime/registry.ts";
import { masterAddress } from "./runtime/address.ts";
import { normalizeMasterSuccession, type MasterSuccessionConfig } from "./runtime/master-auto.ts";
import type { SpawnSuccessor } from "./runtime/master-transfer.ts";
import { emitRuntimeEventOnce } from "./runtime/journal.ts";
import { tabDispatchToRuntimeEvent } from "./runtime/adapters/tab-run.ts";
import { bindAsyncPanelUi, notifyAsyncCompletion, refreshAsyncPanel, registerAsyncPanel } from "./async-panel.ts";
import { registerEventBus, triggerOwnershipRecheck } from "./event-bus.ts";
import { registerReportListener } from "./report.ts";
import { registerMailboxConsumer, registerWakeLoop, registerScopeWakeLoop } from "./mailbox-consumer.ts";
import { injectFollowUpQuietly } from "./injection-gate.ts"; // L3：忙时冲突静默重试（await send 结果）
import { registerOutboxBridge } from "./outbox-bridge.ts";
import { registerGuiAutoStart } from "./gui-autostart.ts";
import { registerAsyncResultWatcher } from "./async-result-watcher.ts";
import type { WakeDecision } from "./runtime/wake.ts";
import type { ScopeWakeDecision } from "./runtime/scope.ts";
import {
	attachCurrentSession,
	getMasterStatus,
	issueMasterHandoffToken,
	prepareMasterHandoff,
	setMasterCutover,
} from "./runtime/master-control.ts";
import {
	createTask,
	createWorkstream,
	enrichRunRefs,
	listAudit,
	listTasks,
	listWorkstreams,
	readWorkstream,
	setTaskStatus,
	updateWorkstream,
} from "./runtime/workstreams.ts";
import { listProjectedRuns } from "./runtime/state-store.ts";
import { recordLink, sessionIdentity, listLinks, type LinkKind } from "./links.ts";
import { durableSessionIdentity, getCurrentSessionId, getTabRunId, isMainSession, isSubagent, registerIdentityFlag, sessionScopeKey } from "./identity.ts";
import { NO_POLL_DISCIPLINE } from "./no-poll.ts";
import { assertDelegationAllowed, capabilities, isTraceWorker, registerCapabilityFlags } from "./capabilities.ts";
import { buildTraceWorkerSystemPrompt } from "./trace-worker.ts";
import { buildPiArgv, toolsSupportedForBackend, type RunnerToolsOptions } from "./runner-argv.ts";
import {
	defaultTabRunsDir,
	newTabRunId,
	readTabResultFile,
	validateTabDispatchRecord,
	writeTabDispatch,
	type TabDispatchRecord,
} from "./tab-runs.ts";
import type { TraceRunMeta } from "./trace-fusion/types.ts";
import {
	defaultTimersDir,
} from "./timers.ts";
import {
	buildWorkflowTabPrompt,
	launchTaskTitle,
	parseLaunchRequest,
	spawnPiTab,
	type LaunchMode,
} from "./launch.ts";
import { launchWorkflowTab, masterDispatchLaunch } from "./launch-workflow.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = resolve(__dirname, "..");
const RUNS_DIR = join(homedir(), ".pi", "agent", "subagent-runs");
const MAX_CONCURRENCY = 50;
/** 默认子 agent 超时：10 分钟（600 秒）。单次调用可通过 timeoutMs 覆盖。 */
const DEFAULT_TIMEOUT_MS = 600_000;
// 工作流技能：根目录与扩展 resources_discover 注册的是同一路径（--skill 传根目录可被按路径去重）；
// 约束块里给的是精确 SKILL.md 路径，让新会话直接 read。
const WORKFLOW_SKILL_ROOT = join(PKG_DIR, "skills");
const WORKFLOW_SKILL_FILE = join(WORKFLOW_SKILL_ROOT, "workflow-orchestrator", "SKILL.md");

// ── pi CLI 路径探测 ────────────────────────────────────────────────

function findPiCli(): string {
	const env = process.env.PI_CLI_PATH;
	if (env && existsSync(env)) return resolve(env);
	const piDir = dirname(process.argv[1] ?? "");
	const candidates = [
		join(piDir, "dist", "cli.js"),
		join(piDir, "..", "dist", "cli.js"),
		join(dirname(process.execPath), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
	];
	for (const c of candidates) {
		if (existsSync(c)) return resolve(c);
	}
	try {
		const which = execFileSync("where", ["pi"], { encoding: "utf8", shell: true }).split("\n")[0].trim();
		if (which && existsSync(which)) {
			const content = readFileSync(which, "utf8");
			const match = content.match(/node\s+"?([^"\s]+dist[\\/]cli\.js)"?/);
			if (match && existsSync(match[1])) return resolve(match[1]);
		}
	} catch { /* ignore */ }
	throw new Error("Cannot find pi CLI. Set PI_CLI_PATH env var.");
}

function findWindowsTerminal(): string | null {
	try {
		// WindowsApps is protected, so trust `where` rather than existsSync.
		const result = execFileSync("where", ["wt.exe"], { encoding: "utf8", shell: true });
		return result.split("\n")[0].trim() || null;
	} catch {
		return null;
	}
}

interface LaunchDispatch {
	title: string;
	prompt: string;
	model?: string;
	error?: string;
	/** 标签页回收闭环令牌（launch-tabs 生成，供 tab-status / reclaim-tabs 使用）。 */
	runId?: string;
	taskId?: string;
}

function dispatchPiTab(
	wtPath: string,
	piCli: string,
	cwd: string,
	title: string,
	prompt: string,
	model?: string,
	skills?: string[],
	runId?: string,
	runsDir?: string,
	/** P1-2：异步 spawn 失败（child error 事件）回调，用于回写 launch_failed 账本。 */
	onSpawnError?: (err: Error) => void,
): LaunchDispatch {
	// trace-fusion C3：spawn 逻辑已抽出至 tab-launch-core.spawnPiTab（workflow 与 trace 共用原语）。
	const result = spawnPiTab({ wtPath, piCli, cwd, title, prompt, model, skills, tabRunId: runId, runsDir, onSpawnError });
	return { title, prompt, model, error: result.error, runId };
}

// ── Agent 定义 ─────────────────────────────────────────────────────

interface AgentConfig {
	models: Record<string, string>;
	fallbackModels: Record<string, string[]>;
	thinking: Record<string, string>;
	notifications?: boolean;
	/** searcher 派发模式：auto（默认，orchestrator 自行判断）、serial（逐个串行）、parallel（并发） */
	searcherMode?: "auto" | "serial" | "parallel";
	/** lite 轻量工作流模式：off（默认，零注入）、on（一律走 lite 链）、auto（按任务判据自选）；逻辑在 lite-mode.ts */
	liteMode?: LiteMode;
	/** S3 自动交接（A1）：默认 auto:false；归一化见 master-auto.ts */
	masterSuccession?: MasterSuccessionConfig;
}

function configPath(): string {
	return join(PKG_DIR, "config.json");
}

function readConfig(): AgentConfig {
	try {
		const parsed = JSON.parse(readFileSync(configPath(), "utf8")) as Partial<AgentConfig>;
		return {
			models: parsed.models ?? {},
			fallbackModels: parsed.fallbackModels ?? {},
			thinking: parsed.thinking ?? {},
			notifications: parsed.notifications !== false,
			searcherMode: parsed.searcherMode ?? "auto",
			liteMode: parsed.liteMode ?? "off",
			masterSuccession: normalizeMasterSuccession(parsed.masterSuccession),
		};
	} catch {
		return { models: {}, fallbackModels: {}, thinking: {}, notifications: true, searcherMode: "auto", liteMode: "off", masterSuccession: normalizeMasterSuccession(undefined) };
	}
}

function writeConfig(cfg: AgentConfig): void {
	// G4（§2.4③）：裸写 → tmp+rename 原子写（与 runtime/command-executor.ts 同款模式），
	// 消除与 Host 侧 auto-handoff.set 并发时的 torn-write / JSON 损坏面。
	// EPERM×3 重试（10ms backoff）：Windows 下并发 reader 持句柄时 rename 短暂 EPERM。
	// 残余风险（显式记录）：read-modify-write 窗口非零，极小概率 lost update
	//（另一进程在调用方 fresh read（reloadConfig）与本 rename 之间写入）——后果 = 对方
	// 切片回退一次，重写自愈；跨进程文件锁不采（pi 侧写者不持锁，见 plans/0920_G4_cmdexec_plan.md §2.4）。
	const path = configPath();
	const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
	writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n");
	for (let attempt = 0; ; attempt++) {
		try {
			renameSync(tmp, path);
			return;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "EPERM" && attempt < 3) {
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
				continue;
			}
			try { unlinkSync(tmp); } catch { /* ignore */ }
			throw e;
		}
	}
}

function reloadConfig(): AgentConfig {
	return readConfig();
}

function isRetryableModelFailure(result: SubagentResult): boolean {
	if (result.status !== "failed" || !result.error) return false;
	return classifyModelFailure(result.error, result.requestedModel ?? result.model).retryable;
}

/**
 * Classify provider/model-layer failures so the main agent can act
 * (fallback chain + explicit "switch main model" guidance).
 *
 * Zhipu/GLM package exhaustion commonly surfaces as bare HTTP 429
 * (not a Chinese "套餐" string) — treat those as USAGE_CAP, not soft rate-limit.
 */
export function classifyModelFailure(
	error: string,
	modelHint?: string,
): {
	retryable: boolean;
	kind: "usage_cap" | "rate_limit" | "auth" | "provider" | "timeout" | "stall" | "other";
	label: string;
} {
	const message = error.toLowerCase();
	const model = (modelHint ?? "").toLowerCase();
	const isZhipuFamily =
		/(^|[\/\s_-])(zhipu|glm|智谱)/i.test(model) ||
		/(zhipu|glm|智谱|bigmodel)/i.test(message);

	// Explicit package / billing wording (CN + EN + common Zhipu codes)
	const usageWording =
		/(用量|额度|套餐|资源包|余量|余额不足|欠费|over.?quota|quota.?exceed|exceeded.{0,40}quota|usage.?limit|limit.?exceed|token.?limit|out of credit|insufficient.?credit|insufficient.?balance|billing|package.?limit|plan.?limit|subscription.?limit|free.?tier|capacity.?exceed|resource.?exhausted|tokens?.{0,20}(用尽|耗尽|上限)|已达上限|到达上限|超出限额|\b1302\b|\b1113\b)/i.test(
			error,
		) || /\b(quota|credit)\b/i.test(message);

	const is429 = /\b429\b|too many requests|rate.?limit|throttl/i.test(message);

	// Zhipu: exhausted package almost always returns 429 → USAGE_CAP (switch model).
	if (usageWording || (is429 && isZhipuFamily)) {
		return { retryable: true, kind: "usage_cap", label: "USAGE_CAP" };
	}

	// Non-Zhipu bare 429 without quota wording: still often hard cap on free tiers;
	// prefer USAGE_CAP guidance so main agent switches model rather than busy-waiting.
	if (is429) {
		// "retry-after" / pure overload → soft rate limit; otherwise treat as cap-like.
		if (/(retry.?after|overloaded|temporarily|try again later)/i.test(message) && !usageWording) {
			return { retryable: true, kind: "rate_limit", label: "RATE_LIMIT" };
		}
		return { retryable: true, kind: "usage_cap", label: "USAGE_CAP" };
	}

	if (/(api key|authentication|unauthorized|forbidden|\b401\b|\b403\b)/i.test(message)) {
		return { retryable: true, kind: "auth", label: "AUTH" };
	}
	// 停顿超时（stall）不是模型/Provider 错误——任务卡住换模型也救不回来，不触发 fallback
	if (/(stall|no output for|stall-timeout|\bstalled\b)/i.test(message)) {
		return { retryable: false, kind: "stall", label: "STALL" };
	}
	if (/(timeout|\b408\b|timed?\s*out)/i.test(message)) {
		return { retryable: true, kind: "timeout", label: "TIMEOUT" };
	}
	const providerish =
		/(model.{0,80}(not found|unavailable|may not exist|not exist|no access)|issue with the selected model|provider|\b404\b|econnreset|enotfound|fetch failed|network|service unavailable|cli not found on path|exited with code|agent execution terminated|claude failed|claude error|codex failed|codex error|agy|atomcode|zcode|location is not supported)/i.test(
			message,
		);
	if (providerish) {
		return { retryable: true, kind: "provider", label: "PROVIDER" };
	}
	return { retryable: false, kind: "other", label: "OTHER" };
}

/**
 * Build a main-agent-facing failure block: original error + what was tried +
 * explicit instruction to switch the main session model when usage is capped.
 */
function formatFailureForMainAgent(result: SubagentResult, triedModels?: string[]): string {
	const err = result.error || result.status || "failed";
	const model =
		result.requestedModel ||
		result.model ||
		"(unknown model)";
	const cls = classifyModelFailure(err, model);
	const tried =
		triedModels && triedModels.length > 0
			? triedModels
			: [model].filter(Boolean);
	const lines: string[] = [
		`[subagent-failure kind=${cls.label} retryable=${cls.retryable}]`,
		`agent=${result.agent ?? "(none)"}`,
		`failed_model=${model}`,
		`tried_models=${tried.join(" → ")}`,
		`error=${err}`,
	];
	if (cls.kind === "usage_cap") {
		lines.push(
			"",
			"ACTION_REQUIRED (main agent):",
			"- This is treated as a package/usage cap (Zhipu/GLM often returns bare HTTP 429 when 套餐用量用尽).",
			"- Do NOT retry the same model (waiting will not restore package quota).",
			"- Switch the main session to a higher-tier / different provider model via /model (or setModel),",
			"  then re-run the failed subagent step with model= override or updated /sub-models defaults.",
			"- Prefer a model not on the tried_models list above (avoid Zhipu/glm if that is exhausted).",
		);
	} else if (cls.retryable) {
		lines.push(
			"",
			"ACTION_REQUIRED (main agent):",
			"- Provider/model-layer failure after subagent fallback chain (if any).",
			"- Switch main session model (/model) or pass a different model= override, then retry the step.",
		);
	}
	if (result.text) {
		lines.push("", "--- partial output ---", result.text);
	}
	return lines.join("\n");
}

/** Normalize free-form model requests into provider/id for pi --model, or cli:<backend> (default model only). */
function normalizeModelRef(raw?: string | null): string | undefined {
	if (!raw) return undefined;
	const input = String(raw).trim();
	if (!input) return undefined;

	// External CLI harness: cli:claude | cli:codex | cli:agy | cli:atomcode | cli:zcode (always CLI default model)
	if (isExternalCliModel(input)) {
		return normalizeExternalCliModel(input);
	}

	// Already canonical provider/id (or nested provider path).
	if (input.includes("/")) return input;

	const catalog = loadLocalModelCatalog();
	if (catalog.length === 0) return input;

	const lower = input.toLowerCase();
	const compact = lower.replace(/[\s_]+/g, "-");
	const nosep = lower.replace(/[\s_.\-]+/g, "");

	const score = (entry: { provider: string; id: string; name?: string }): number => {
		const id = entry.id.toLowerCase();
		const name = (entry.name ?? "").toLowerCase();
		const full = `${entry.provider}/${entry.id}`.toLowerCase();
		const idCompact = id.replace(/[\s_]+/g, "-");
		const idNosep = id.replace(/[\s_.\-]+/g, "");
		const nameNosep = name.replace(/[\s_.\-]+/g, "");
		if (id === lower || name === lower || full === lower) return 100;
		if (idCompact === compact || idNosep === nosep || nameNosep === nosep) return 90;
		if (id.startsWith(lower) || idCompact.startsWith(compact)) return 70;
		if (id.includes(lower) || idCompact.includes(compact) || name.includes(lower)) return 50;
		if (nosep.length >= 4 && (idNosep.includes(nosep) || nameNosep.includes(nosep))) return 40;
		return 0;
	};

	let bestScore = 0;
	const top: LocalModelEntry[] = [];
	for (const entry of catalog) {
		const s = score(entry);
		if (s < 70) continue;
		if (s > bestScore) {
			bestScore = s;
			top.length = 0;
			top.push(entry);
		} else if (s === bestScore) {
			// Keep unique provider/id only.
			if (!top.some((e) => e.provider === entry.provider && e.id === entry.id)) top.push(entry);
		}
	}
	// Only auto-expand when a single confident match exists.
	if (top.length === 1) return `${top[0].provider}/${top[0].id}`;
	if (top.length > 1) {
		const options = top.map((e) => `${e.provider}/${e.id}`).join(", ");
		throw new Error(`Ambiguous model alias "${input}". Use a full provider/id. Candidates: ${options}`);
	}
	return input;
}

interface LocalModelEntry {
	provider: string;
	id: string;
	name?: string;
}

let cachedModelCatalog: LocalModelEntry[] | null = null;

function loadLocalModelCatalog(): LocalModelEntry[] {
	if (cachedModelCatalog) return cachedModelCatalog;
	const paths = [
		join(homedir(), ".pi", "agent", "models.json"),
		join(homedir(), ".pi", "models.json"),
	];
	const out: LocalModelEntry[] = [];
	for (const p of paths) {
		if (!existsSync(p)) continue;
		try {
			const raw = JSON.parse(readFileSync(p, "utf8")) as {
				providers?: Record<string, { models?: Array<{ id?: string; name?: string }> }>;
			};
			for (const [provider, def] of Object.entries(raw.providers ?? {})) {
				for (const m of def.models ?? []) {
					if (!m?.id) continue;
					out.push({ provider, id: m.id, name: m.name });
				}
			}
		} catch {
			/* ignore broken models.json */
		}
	}
	cachedModelCatalog = out;
	return out;
}

/** Resolve defaults at the call seam so config changes apply without recreating agents. */
function agentDefaultModel(agent?: AgentDef | null): string | undefined {
	if (!agent) return undefined;
	return agent.frontmatterModel ?? readConfig().models[agent.name];
}

function agentDefaultThinking(agent?: AgentDef | null): string | undefined {
	if (!agent) return undefined;
	return agent.frontmatterThinking ?? readConfig().thinking[agent.name];
}

function resolveCallModel(override?: string, agent?: AgentDef | null): string | undefined {
	// Call-site model always wins over agent frontmatter / current config defaults.
	return normalizeModelRef(override) ?? agentDefaultModel(agent);
}

function displayModelForCall(override: string | undefined, agentName: string | undefined, agent?: AgentDef | null): string {
	const defaultModel = agentDefaultModel(agent) ?? (agentName ? readConfig().models[agentName] : undefined);
	let overrideRef: string | undefined;
	try {
		overrideRef = normalizeModelRef(override);
	} catch {
		// Keep raw override text in TUI if alias is ambiguous.
		overrideRef = override?.trim() || undefined;
	}
	const resolved = overrideRef ?? defaultModel;
	if (!resolved) return "";
	if (overrideRef && overrideRef !== defaultModel) return ` override:${resolved}`;
	return ` ${resolved}`;
}

/** Resolve the requested checkout once and use it for both pi and external CLI children. */
function resolveSubagentCwd(cwd?: string): string {
	const requested = cwd?.trim();
	return requested ? resolve(requested) : process.cwd();
}

interface AgentDef {
	name: string;
	description?: string;
	tools?: string[];
	/** Only a model explicitly declared in agent frontmatter; config stays live. */
	frontmatterModel?: string;
	/** Only thinking explicitly declared in agent frontmatter; config stays live. */
	frontmatterThinking?: string;
	body: string;
}

function parseFrontmatter(md: string): { frontmatter: Record<string, unknown>; body: string } {
	if (!md.startsWith("---")) return { frontmatter: {}, body: md };
	const lines = md.split(/\r?\n/);
	const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
	if (end === -1) return { frontmatter: {}, body: md };
	const fm: Record<string, unknown> = {};
	for (const line of lines.slice(1, end)) {
		const m = line.match(/^(\w+):\s*(.*)$/);
		if (m) fm[m[1]] = m[2].trim();
	}
	return { frontmatter: fm, body: lines.slice(end + 1).join("\n").trim() };
}

function discoverAgents(): AgentDef[] {
	const dirs = [
		join(PKG_DIR, "agents"),
		join(homedir(), ".pi", "agent", "agents"),
		resolve(".pi", "agents"),
	];
	const agents: AgentDef[] = [];
	const seen = new Set<string>();
	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		for (const f of readdirSync(dir)) {
			if (!f.endsWith(".md")) continue;
			const content = readFileSync(join(dir, f), "utf8");
			const { frontmatter, body } = parseFrontmatter(content);
			const name = (frontmatter.name as string) ?? basename(f, ".md");
			if (seen.has(name)) continue;
			seen.add(name);
			// model/thinking 优先级：agent frontmatter > config.json > undefined
			const fmModel = frontmatter.model as string | undefined;
			const fmThinking = frontmatter.thinking as string | undefined;
			agents.push({
				name,
				description: frontmatter.description as string | undefined,
				tools: frontmatter.tools
					? String(frontmatter.tools).split(",").map((s) => s.trim())
					: undefined,
				frontmatterModel: fmModel,
				frontmatterThinking: fmThinking,
				body,
			});
		}
	}
	return agents;
}

// ── 子进程执行 ─────────────────────────────────────────────────────

/** Map external-cli result into the shared SubagentResult shape. */
function externalResultToSubagentResult(ext: ExternalSubagentResult, agentName?: string): SubagentResult {
	return {
		status: ext.status,
		text: ext.text,
		usage: ext.usage,
		usageEvents: ext.usageEvents,
		runId: ext.runId,
		model: ext.model,
		requestedModel: ext.requestedModel,
		agent: ext.agent ?? agentName,
		error: ext.error,
	};
}

interface UsageSummary {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

interface SubagentUsageEvent {
	/** Stable event identity: allows safe overlap between local-day and legacy UTC files. */
	id: string;
	runId: string;
	/** Assistant-message time, rather than subagent completion time. */
	ts: string;
	model?: string;
	usage: UsageSummary;
}

interface AttemptFailure {
	/** The model ref that was attempted. */
	model: string;
	/** Failure kind label (USAGE_CAP / RATE_LIMIT / AUTH / TIMEOUT / PROVIDER / OTHER). */
	kind: string;
	/** Error message from the failed attempt. */
	error: string;
}

interface SubagentResult {
	status: "completed" | "failed" | "cancelled";
	text: string;
	usage: UsageSummary;
	/** All attempts, including retryable failures before a fallback succeeds. */
	usageEvents: SubagentUsageEvent[];
	runId: string;
	/** Model id reported by assistant message_end (often bare id, e.g. glm-5.2). */
	model?: string;
	/** The model ref actually passed to pi --model (after override + alias expansion). */
	requestedModel?: string;
	/** Models attempted in order (primary + fallbacks) for this dispatch. */
	triedModels?: string[];
	/** Earlier attempts that failed before a fallback succeeded (or before giving up). */
	priorFailures?: AttemptFailure[];
	error?: string;
	agent?: string;
}

/** Assistant text snippets collected across multi-turn subagent runs. */
interface AssistantTextCandidate {
	text: string;
	stopReason?: string;
	turn: number;
}

function looksLikeFinalAnswer(text: string): boolean {
	const t = text.trim();
	if (t.length < 80) return false;
	// Common final-report shapes from reviewer/planner agents.
	if (/^#{1,3}\s/m.test(t)) return true;
	if (/(根因|结论|Findings|Root cause|Recommendation|验收|风险|修复建议)/i.test(t)) return true;
	if (t.split("\n").length >= 4 && t.length >= 200) return true;
	return false;
}

function pickBestAssistantText(candidates: AssistantTextCandidate[]): string {
	if (candidates.length === 0) return "";
	// 1) Prefer last explicit end-turn answer with real text.
	for (let i = candidates.length - 1; i >= 0; i--) {
		const c = candidates[i];
		if ((c.stopReason === "stop" || c.stopReason === "length") && c.text.trim()) return c.text;
	}
	// 2) Prefer text that looks like a structured final answer.
	const structured = [...candidates]
		.filter((c) => looksLikeFinalAnswer(c.text))
		.sort((a, b) => b.text.length - a.text.length);
	if (structured[0]) return structured[0].text;
	// 3) Longest non-empty text (avoids last short "let me check..." narration).
	const longest = [...candidates].sort((a, b) => b.text.length - a.text.length)[0];
	return longest?.text ?? "";
}

function usageEventTimestamp(value: unknown): string {
	const ms = typeof value === "number" && Number.isFinite(value)
		? value
		: typeof value === "string" ? Date.parse(value) : NaN;
	return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString();
}

function parseJsonEvents(
	buffer: string,
	result: SubagentResult,
	onUpdate?: (status: string, text: string) => void,
	opts?: {
		timedOut?: () => boolean;
		candidates?: AssistantTextCandidate[];
	},
): void {
	const candidates = opts?.candidates;
	for (const line of buffer.split("\n").filter((l) => l.trim())) {
		try {
			const ev = JSON.parse(line);
			if (ev.type === "tool_execution_start") {
				const toolName = ev.toolName ?? "";
				const args = ev.args ?? {};
				let detail = "";
				if (toolName === "bash" && args.command) detail = String(args.command).slice(0, 60);
				else if (toolName === "read" && args.path) detail = String(args.path);
				else if (toolName === "write" && args.path) detail = String(args.path);
				else if (toolName === "edit" && args.path) detail = String(args.path);
				onUpdate?.(`⚡ ${toolName}`, detail);
			}
			if (ev.type === "message_end" && ev.message?.role === "assistant") {
				const msg = ev.message;
				const stopReason = String(msg.stopReason ?? "");
				// Keep partial text/usage even after timeout/cancel so diagnostics remain useful.
				const textParts = (msg.content ?? [])
					.filter((c: any) => c?.type === "text" && typeof c.text === "string")
					.map((c: any) => c.text as string);
				const text = textParts.join("\n").trim();
				if (msg.model) result.model = msg.model;
				const usage: UsageSummary = {
					input: msg.usage?.input ?? 0,
					output: msg.usage?.output ?? 0,
					cacheRead: msg.usage?.cacheRead ?? 0,
					cacheWrite: msg.usage?.cacheWrite ?? 0,
					cost: msg.usage?.cost?.total ?? 0,
					turns: 1,
				};
				result.usage.input += usage.input;
				result.usage.output += usage.output;
				result.usage.cacheRead += usage.cacheRead;
				result.usage.cacheWrite += usage.cacheWrite;
				result.usage.cost += usage.cost;
				result.usage.turns += usage.turns;
				result.usageEvents.push({
					id: `${result.runId}:${result.usage.turns}`,
					runId: result.runId,
					ts: usageEventTimestamp(msg.timestamp),
					model: result.requestedModel,
					usage,
				});

				if (text) {
					candidates?.push({ text, stopReason, turn: result.usage.turns });
					// Always recompute best text; do not let a short toolUse narration clobber a prior answer.
					result.text = pickBestAssistantText(candidates ?? [{ text, stopReason, turn: result.usage.turns }]);
				}

				// Timeout/cancel win over intermediate completed turns.
				if (opts?.timedOut?.() || result.error === "timeout") {
					result.status = "failed";
					result.error = "timeout";
					onUpdate?.("⏱ timeout", result.text.slice(0, 120));
					continue;
				}
				if (result.status === "cancelled") {
					onUpdate?.("⛔ cancelled", result.text.slice(0, 120));
					continue;
				}

				// toolUse / intermediate turns are progress, not completion.
				if (stopReason === "toolUse") {
					onUpdate?.(`↻ turn ${result.usage.turns}`, text.slice(0, 120) || "tool call");
					continue;
				}
				if (stopReason === "error") {
					result.status = "failed";
					result.error = msg.errorMessage ?? "model error";
					onUpdate?.("✗ error", result.error.slice(0, 120));
					continue;
				}
				if (stopReason === "aborted") {
					result.status = "cancelled";
					result.error ??= "aborted";
					onUpdate?.("⛔ aborted", result.text.slice(0, 120));
					continue;
				}
				// stop / length / unknown end-of-turn reasons count as completed if we have text,
				// or completed empty if model truly returned nothing.
				result.status = "completed";
				if (stopReason === "length") result.error ??= "length";
				onUpdate?.("✓ done", result.text.slice(0, 120));
			}
		} catch { /* skip */ }
	}
}

/**
 * Prefer structured errorMessage; append/replace with stderr when it carries
 * quota/package wording the main agent needs (GLM 套餐上限 etc.).
 */
function mergeProviderError(
	existing: string | undefined,
	stderrBuf: string,
	code: number | null,
	modelHint?: string,
): string {
	const stderr = stderrBuf.trim().slice(-4000); // tail — last lines usually have the real error
	if (!existing && !stderr) return `exit ${code ?? 0}`;
	if (!existing) return stderr || `exit ${code ?? 0}`;
	if (!stderr) return existing;
	// Avoid doubling the same text
	if (stderr.includes(existing) || existing.includes(stderr.slice(0, 80))) {
		return stderr.length > existing.length ? stderr : existing;
	}
	// If stderr looks like usage/quota (or Zhipu 429), prefer it as primary.
	if (
		classifyModelFailure(stderr, modelHint).kind === "usage_cap" &&
		classifyModelFailure(existing ?? "", modelHint).kind !== "usage_cap"
	) {
		return `${stderr}\n(from assistant: ${existing})`;
	}
	return `${existing}\n--- stderr ---\n${stderr}`;
}

async function runSingle(
	agent: AgentDef | null,
	task: string,
	systemPrompt?: string,
	model?: string,
	timeoutMs?: number,
	signal?: AbortSignal,
	onUpdate?: (status: string, text: string) => void,
	opts?: RunDispatchOptions,
): Promise<SubagentResult> {
	const { cwd, tools, excludeTools } = opts ?? {};
	const finalPrompt = systemPrompt ?? agent?.body ?? "";
	const workingDirectory = resolveSubagentCwd(cwd);
	// model arg is already normalized by resolveCallModel / runWithFallback.
	const resolvedModel = model ?? agentDefaultModel(agent);
	const resolvedThinking = agentDefaultThinking(agent);

	// P2 修订：显式 tools + 外部 CLI 后端 → 快速失败（安全 allowlist 不许被静默忽略）。
	// 放在外部 CLI 分支之前才能拦住 cli:* 派发。
	if (!toolsSupportedForBackend(resolvedModel, tools)) {
		onUpdate?.("⛔ tools unsupported", `--tools is not supported for external CLI backend ${resolvedModel}`);
		return {
			status: "failed",
			text: "",
			usage: emptyUsageSummary(),
			usageEvents: [],
			runId: randomUUID(),
			error: `--tools allowlist is not supported for external CLI backend "${resolvedModel}"; use a normal provider/id model or drop tools`,
			agent: agent?.name,
			requestedModel: resolvedModel,
		};
	}

	// External CLI backends (claude / codex / agy / atomcode) — spawn local harness, not pi.
	if (resolvedModel && isExternalCliModel(resolvedModel)) {
		const ext = await runExternalCli({
			modelRef: resolvedModel,
			task,
			systemPrompt: finalPrompt || undefined,
			thinking: resolvedThinking,
			timeoutMs,
			signal,
			cwd: workingDirectory,
			agentName: agent?.name,
			onUpdate,
		});
		return externalResultToSubagentResult(ext, agent?.name);
	}

	const cliPath = findPiCli();
	// 保留项目 AGENTS.md / CLAUDE.md 注入（勿加 --no-context-files）。
	// 仍用 --no-session 隔离会话；排除 subagent-win 防止递归派发；
	// 同时排除 launch-tabs 与 timer 管理工具：子 agent 只执行工作，
	// 不得开新标签页，也不得创建/查询/取消计时器（编排只属于主会话）。
	// tools/excludeTools 为 per-call opt-in（runner-argv.ts P2 修订）：
	// 未显式传入时 argv 不含 --tools，与历史行为逐字节一致。
	const argv = buildPiArgv({
		cliPath,
		model: resolvedModel,
		thinking: resolvedThinking,
		systemPrompt: finalPrompt || undefined,
		task,
		tools,
		excludeTools,
	});

	// 首次进度：显示真正传给 pi 的模型
	onUpdate?.(`🤖 ${resolvedModel ?? "default"}`, "starting...");

	return new Promise((resolve_) => {
		const child = spawn(process.execPath, argv, {
			cwd: workingDirectory,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				// P1-4：子 agent 永不继承标签页身份（避免继承父标签页的 PI_TAB_RUN_ID 造成身份混淆）
				PI_SUBAGENT: "1",
				PI_TAB_RUN_ID: "",
				PI_TAB_RUNS_DIR: "",
				// review 修正（Luna major，设计稿 §12.1）：子 agent 身份恒为 subagent，
				// 不继承父进程的 trace/session profile（否则 trace worker 派 searcher 时
				// 子进程继承 PI_SESSION_PROFILE=trace-worker，能力矩阵误判）。
				PI_SESSION_PROFILE: "subagent",
				PI_TRACE_RUN_ID: "",
				PI_TRACE_LANE: "",
			},
		});
		let buf = "", lineBuf = "", stderrBuf = "";
		const result: SubagentResult = {
			status: "failed",
			text: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
			usageEvents: [],
			runId: randomUUID(),
			requestedModel: resolvedModel,
		};
		const textCandidates: AssistantTextCandidate[] = [];
		let timedOut = false;
		let forceKill: ReturnType<typeof setTimeout> | null = null;
		const kill = () => { child.kill("SIGTERM"); forceKill = setTimeout(() => child.kill("SIGKILL"), 2000); };
		if (signal?.aborted) kill(); else signal?.addEventListener("abort", kill, { once: true });

		// 停顿检测（inactivity/stall timeout）：不是给整个任务限时——
		// 只要子进程持续有输出（有进展）就重置计时器；只有「卡住不动超过 timeoutMs」才判超时停止。
		// 错误（exit≠0 / stopReason=error）走正常停止路径，不受此超时影响。
		let stallTimer: ReturnType<typeof setTimeout> | null = null;
		const resetStall = () => {
			if (stallTimer) clearTimeout(stallTimer);
			if (!timeoutMs) { stallTimer = null; return; }
			stallTimer = setTimeout(() => {
				timedOut = true;
				result.status = "failed";
				result.error = "stall-timeout";
				onUpdate?.("⏱ stalled", `killing ${resolvedModel ?? "default"} (no output for ${Math.round(timeoutMs / 1000)}s)`);
				kill();
			}, timeoutMs);
		};
		resetStall();

		// 输出缓冲上限 5MB，防止子进程输出过大撑爆 RangeError
		const MAX_BUF = 5_000_000;
		const parseOpts = { timedOut: () => timedOut, candidates: textCandidates };

		child.stdout.on("data", (chunk: Buffer) => {
			resetStall(); // 有进展：重置停顿计时
			const text = chunk.toString("utf8");
			if (buf.length < MAX_BUF) buf += text;
			lineBuf += text;
			// 逐行解析，实时推送进度
			while (true) {
				const nl = lineBuf.indexOf("\n");
				if (nl < 0) break;
				const line = lineBuf.slice(0, nl);
				lineBuf = lineBuf.slice(nl + 1);
				if (!line.trim()) continue;
				parseJsonEvents(line + "\n", result, onUpdate, parseOpts);
			}
		});
		child.stderr.on("data", (chunk: Buffer) => {
			resetStall(); // 错误输出也算进展（至少进程还活着）
			if (stderrBuf.length < MAX_BUF) stderrBuf += chunk.toString("utf8");
		});
		child.on("error", (err) => {
			if (stallTimer) clearTimeout(stallTimer);
			result.status = "failed";
			result.error = err.message;
			result.agent = agent?.name;
			resolve_(result);
		});
		child.on("close", (code) => {
			if (stallTimer) clearTimeout(stallTimer);
			if (forceKill) clearTimeout(forceKill);
			// 处理缓冲区中剩余行（即使中断也有部分结果）
			if (lineBuf.trim()) parseJsonEvents(lineBuf + "\n", result, onUpdate, parseOpts);
			// Final text selection across all assistant turns.
			const best = pickBestAssistantText(textCandidates);
			if (best) result.text = best;
			if (signal?.aborted) {
				result.status = "cancelled";
				result.error ??= "aborted";
				result.agent = agent?.name;
				if (onUpdate) onUpdate("⛔ cancelled", result.text.slice(0, 200));
				resolve_(result);
				return;
			}
			if (timedOut) {
				result.status = "failed";
				result.error = "timeout";
			} else if (code !== 0 && result.status !== "completed") {
				result.status = "failed";
				result.error = mergeProviderError(result.error, stderrBuf, code, resolvedModel);
			} else if (!timedOut && result.status !== "failed" && result.status !== "cancelled") {
				// If the process exited cleanly after only toolUse turns (no stop), keep best partial
				// and mark failed-incomplete so main agent doesn't treat narration as final answer.
				if (result.status !== "completed" && result.text) {
					result.status = "failed";
					result.error ??= "incomplete: no final stop turn";
				} else if (result.status !== "completed") {
					result.status = "failed";
					result.error = mergeProviderError(result.error, stderrBuf, code, resolvedModel);
				}
			} else if (result.status === "failed") {
				// Enrich stopReason=error messages with stderr (often holds GLM 套餐/额度 detail).
				result.error = mergeProviderError(result.error, stderrBuf, code, resolvedModel);
			}
			result.agent = agent?.name;
			// Prefer provider/id we requested when assistant only echoes bare id.
			if (!result.model && resolvedModel) result.model = resolvedModel;
			resolve_(result);
		});
	});
}

function emptyUsageSummary(): UsageSummary {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function totalUsage(events: SubagentUsageEvent[]): UsageSummary {
	const total = emptyUsageSummary();
	for (const event of events) {
		total.input += event.usage.input;
		total.output += event.usage.output;
		total.cacheRead += event.usage.cacheRead;
		total.cacheWrite += event.usage.cacheWrite;
		total.cost += event.usage.cost;
		total.turns += event.usage.turns;
	}
	return total;
}

/** Return the final attempt while retaining billable events from every fallback attempt. */
function withAllAttemptUsage(
	result: SubagentResult,
	events: SubagentUsageEvent[],
	dispatchRunId: string,
	triedModels?: string[],
	priorFailures?: AttemptFailure[],
): SubagentResult {
	result.runId = dispatchRunId;
	result.usageEvents = events;
	result.usage = totalUsage(events);
	if (triedModels && triedModels.length > 0) result.triedModels = triedModels;
	if (priorFailures && priorFailures.length > 0) result.priorFailures = priorFailures;
	return result;
}

/** Human-readable fallback chain, e.g. "cli:claude ✗ PROVIDER → miaomiao/...". Empty if no fallback occurred. */
function fallbackChainText(result: SubagentResult): string {
	const fails = result.priorFailures ?? [];
	if (fails.length === 0) return "";
	const ok = result.requestedModel ?? result.model ?? "?";
	const segs = fails.map((f) => `${f.model} ✗(${f.kind})`);
	return `${segs.join(" → ")} → ${ok}`;
}

async function runWithFallback(
	agent: AgentDef | null,
	task: string,
	systemPrompt?: string,
	model?: string,
	timeoutMs?: number,
	signal?: AbortSignal,
	onUpdate?: (status: string, text?: string) => void,
	opts?: RunDispatchOptions,
): Promise<SubagentResult> {
	// 未显式设置超时时使用默认值（10 分钟），避免长时间无响应
	if (timeoutMs === undefined) timeoutMs = DEFAULT_TIMEOUT_MS;
	// Explicit call-site model overrides agent default. Retryable failures still try fallbacks.
	let primary: string | undefined;
	try {
		primary = resolveCallModel(model, agent);
	} catch (err) {
		return {
			status: "failed",
			text: "",
			usage: emptyUsageSummary(),
			usageEvents: [],
			runId: randomUUID(),
			error: err instanceof Error ? err.message : String(err),
			agent: agent?.name,
		};
	}
	const configuredFallbacks = agent ? readConfig().fallbackModels[agent.name] ?? [] : [];
	let normalizedFallbacks: string[] = [];
	try {
		normalizedFallbacks = configuredFallbacks
			.map((value) => normalizeModelRef(value))
			.filter((value): value is string => Boolean(value));
	} catch {
		// Fallback chain misconfig should not block primary override.
		normalizedFallbacks = configuredFallbacks.filter(Boolean);
	}
	const candidates = [...new Set([primary, ...normalizedFallbacks].filter((value): value is string => Boolean(value)))];
	if (candidates.length === 0) {
		const result = await runSingle(agent, task, systemPrompt, undefined, timeoutMs, signal, onUpdate, opts);
		if (result.requestedModel) result.triedModels = [result.requestedModel];
		return result;
	}

	let lastResult: SubagentResult | undefined;
	const dispatchRunId = randomUUID();
	const allUsageEvents: SubagentUsageEvent[] = [];
	const tried: string[] = [];
	const priorFailures: AttemptFailure[] = [];
	for (let index = 0; index < candidates.length; index++) {
		const candidate = candidates[index];
		tried.push(candidate);
		const result = await runSingle(agent, task, systemPrompt, candidate, timeoutMs, signal, onUpdate, opts);
		result.requestedModel = candidate;
		result.triedModels = [...tried];
		allUsageEvents.push(...result.usageEvents.map((event) => ({ ...event, runId: dispatchRunId })));
		lastResult = result;
		if (result.status === "completed" || result.status === "cancelled") {
			return withAllAttemptUsage(result, allUsageEvents, dispatchRunId, tried, priorFailures);
		}
		const cls = result.error
			? classifyModelFailure(result.error, result.requestedModel ?? result.model)
			: null;
		// Record this failed attempt so downstream (main agent + TUI) can see WHY a fallback happened.
		if (result.error) {
			priorFailures.push({
				model: candidate,
				kind: cls?.label ?? "OTHER",
				error: result.error,
			});
		}
		const more = index < candidates.length - 1 && isRetryableModelFailure(result);
		if (more) {
			const next = candidates[index + 1];
			onUpdate?.(
				cls?.kind === "usage_cap"
					? `⚠ USAGE_CAP → ${next}`
					: `⚠ model error → ${next}`,
				candidate,
			);
			continue;
		}
		return withAllAttemptUsage(result, allUsageEvents, dispatchRunId, tried, priorFailures);
	}
	return lastResult
		? withAllAttemptUsage(lastResult, allUsageEvents, dispatchRunId, tried, priorFailures)
		: { status: "failed", text: "", usage: emptyUsageSummary(), usageEvents: [], runId: dispatchRunId, error: "no model attempt", triedModels: tried, priorFailures };
}

// ── 并行 ────────────────────────────────────────────────────────────

/** 末位派发选项：工作目录 + per-call 工具策略（仅显式传入才生效，见 runner-argv.ts）。 */
export interface RunDispatchOptions extends RunnerToolsOptions {
	/** Working directory / git worktree for this dispatch. */
	cwd?: string;
}

interface TaskInput {
	agent?: string;
	task: string;
	systemPrompt?: string;
	model?: string;
	timeoutMs?: number;
	/** Working directory / git worktree for this task. */
	cwd?: string;
	/** per-call 正向 allowlist（P2 修订：显式传入才加 --tools；不读 agent frontmatter）。 */
	tools?: string[];
	/** per-call 额外排他列表（叠加到默认防递归列表之后）。 */
	excludeTools?: string[];
}

async function runParallel(
	tasks: TaskInput[],
	concurrency: number,
	allAgents: AgentDef[],
	signal?: AbortSignal,
	onUpdate?: (status: string, text: string) => void,
): Promise<SubagentResult[]> {
	const limit = Math.max(1, Math.min(concurrency, MAX_CONCURRENCY));
	const results: SubagentResult[] = [];
	let next = 0;
	const worker = async (): Promise<void> => {
		while (true) {
			const idx = next++;
			if (idx >= tasks.length) return;
			const t = tasks[idx];
			const agentDef = t.agent ? allAgents.find((a) => a.name === t.agent) ?? null : null;
			if (t.agent && !agentDef) {
				results[idx] = {
					status: "failed", text: "", usage: emptyUsageSummary(), usageEvents: [], runId: randomUUID(),
					error: `unknown agent: ${t.agent}`, agent: t.agent,
				};
				continue;
			}
			const agentName = agentDef?.name ?? t.agent ?? `task-${idx}`;
			const taskCb = onUpdate
				? (s: string, _t: string) => onUpdate(`[${idx + 1}/${tasks.length}] ${agentName} ${s}`, _t)
				: undefined;
			results[idx] = await runWithFallback(agentDef, t.task, t.systemPrompt, t.model, t.timeoutMs, signal, taskCb, { cwd: t.cwd, tools: t.tools, excludeTools: t.excludeTools });
		}
	};
	await Promise.all(Array.from({ length: limit }, () => worker()));
	return results;
}

// ── 用量记录 ────────────────────────────────────────────────────────────

const USAGE_DIR = join(homedir(), ".pi", "agent", "subagent-usage");
const DEFAULT_SESSIONS_ROOT = join(homedir(), ".pi", "agent", "sessions");

interface DayBounds {
	/** Local calendar day, YYYY-MM-DD */
	label: string;
	startMs: number;
	endMs: number;
}

/** Local-day window [start, end). Avoids UTC midnight split for CN/other +8 zones. */
function localDayBounds(now = new Date()): DayBounds {
	const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const end = new Date(start);
	end.setDate(end.getDate() + 1);
	const y = start.getFullYear();
	const m = String(start.getMonth() + 1).padStart(2, "0");
	const d = String(start.getDate()).padStart(2, "0");
	return { label: `${y}-${m}-${d}`, startMs: start.getTime(), endMs: end.getTime() };
}

function dailyUsagePath(dayLabel?: string): string {
	const day = dayLabel ?? localDayBounds().label;
	return join(USAGE_DIR, `${day}.jsonl`);
}

function ensureUsageDir(): void {
	if (!existsSync(USAGE_DIR)) mkdirSync(USAGE_DIR, { recursive: true });
}

function recordUsage(agent: string | undefined, result: SubagentResult): void {
	try {
		ensureUsageDir();
		const events = result.usageEvents.length > 0
			? result.usageEvents
			: [{
				id: `${result.runId}:empty`, runId: result.runId, ts: new Date().toISOString(),
				model: result.requestedModel ?? result.model, usage: result.usage,
			}];
		for (const event of events) {
			const eventDate = new Date(event.ts);
			const day = Number.isNaN(eventDate.getTime()) ? undefined : localDayBounds(eventDate).label;
			const line = JSON.stringify({
				version: 2,
				id: event.id,
				runId: event.runId,
				ts: event.ts,
				agent: agent ?? null,
				model: event.model ?? result.requestedModel ?? result.model ?? null,
				usage: event.usage,
			});
			// Attribute each assistant request to its own local calendar day, even if the run ends later.
			writeFileSync(dailyUsagePath(day), line + "\n", { flag: "a" });
		}
	} catch {
		/* ignore usage write failures */
	}
}

interface UsageBucket extends UsageSummary {
	count: number;
	/** Per-model breakdown (key = provider/id when available). */
	byModel: Map<string, UsageBucket>;
}

function emptyUsage(): UsageBucket {
	return { ...emptyUsageSummary(), count: 0, byModel: new Map() };
}

function addUsage(target: UsageBucket, usage: Partial<UsageSummary>, count = 0): void {
	target.input += usage.input ?? 0;
	target.output += usage.output ?? 0;
	target.cacheRead += usage.cacheRead ?? 0;
	target.cacheWrite += usage.cacheWrite ?? 0;
	target.cost += usage.cost ?? 0;
	target.turns += usage.turns ?? 0;
	target.count += count;
}

function addModelUsage(target: UsageBucket, model: string, usage: Partial<UsageSummary>, count = 0): void {
	let bucket = target.byModel.get(model);
	if (!bucket) {
		bucket = emptyUsage();
		target.byModel.set(model, bucket);
	}
	addUsage(bucket, usage, count);
}

function modelKey(provider: unknown, model: unknown): string {
	if (typeof provider === "string" && provider && typeof model === "string" && model) return `${provider}/${model}`;
	if (typeof model === "string" && model) return model;
	return "unknown";
}

function mergeModelBuckets(target: Map<string, UsageBucket>, source: Map<string, UsageBucket>): void {
	for (const [model, bucket] of source) {
		let t = target.get(model);
		if (!t) {
			t = emptyUsage();
			target.set(model, t);
		}
		addUsage(t, { input: bucket.input, output: bucket.output, cacheRead: bucket.cacheRead, cacheWrite: bucket.cacheWrite, cost: bucket.cost, turns: bucket.turns }, 0);
	}
}

function parseTsMs(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		// session message.timestamp is ms; some sources may store seconds
		return value < 1e12 ? value * 1000 : value;
	}
	if (typeof value === "string" && value) {
		const ms = Date.parse(value);
		return Number.isNaN(ms) ? null : ms;
	}
	return null;
}

function inDay(ms: number | null, day: DayBounds): boolean {
	return ms !== null && ms >= day.startMs && ms < day.endMs;
}

/** UTC calendar dates that may overlap a local day (for filename prefilter). */
function overlappingUtcDates(day: DayBounds): string[] {
	const dates = new Set<string>();
	// sample start, mid, and just before end to catch timezone straddles
	for (const ms of [day.startMs, day.startMs + 12 * 3600_000, day.endMs - 1]) {
		dates.add(new Date(ms).toISOString().slice(0, 10));
	}
	return [...dates];
}

function listJsonlFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const out: string[] = [];
	const stack = [dir];
	while (stack.length > 0) {
		const cur = stack.pop()!;
		let entries;
		try { entries = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
		for (const ent of entries) {
			const full = join(cur, ent.name);
			if (ent.isDirectory()) stack.push(full);
			else if (ent.isFile() && ent.name.endsWith(".jsonl")) out.push(full);
		}
	}
	return out;
}

function collectSubagentUsage(day: DayBounds): UsageBucket {
	const total = emptyUsage();
	const utcDates = overlappingUtcDates(day);
	// Read the local format plus UTC-named legacy files that may overlap this local day.
	const candidates = new Set<string>([
		dailyUsagePath(day.label),
		...utcDates.map((d) => join(USAGE_DIR, `${d}.jsonl`)),
	]);
	const seenEvents = new Set<string>();
	const seenRuns = new Set<string>();
	for (const filePath of candidates) {
		if (!existsSync(filePath)) continue;
		let text: string;
		try { text = readFileSync(filePath, "utf8"); } catch { continue; }
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			try {
				const r = JSON.parse(line);
				if (!inDay(parseTsMs(r.ts), day)) continue;
				// v2 has a durable event ID. The full old record is a safe legacy fallback key.
				const eventId = typeof r.id === "string" ? r.id : `legacy:${r.ts}:${line}`;
				if (seenEvents.has(eventId)) continue;
				seenEvents.add(eventId);
				const runId = typeof r.runId === "string" ? r.runId : eventId;
				seenRuns.add(runId);
				const u = r.usage ?? {};
				addUsage(total, {
					input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite,
					cost: u.cost, turns: u.turns,
				});
				addModelUsage(total, typeof r.model === "string" && r.model ? r.model : "unknown", u, 0);
			} catch { /* skip bad line */ }
		}
	}
	total.count = seenRuns.size;
	return total;
}

interface MainSessionUsage {
	total: UsageBucket;
	sessionCount: number;
	sessionsWithUsage: number;
}

function collectMainSessionUsage(day: DayBounds, sessionsRoot = DEFAULT_SESSIONS_ROOT): MainSessionUsage {
	const total = emptyUsage();
	let sessionCount = 0;
	let sessionsWithUsage = 0;

	// Parse JSONL timestamps directly. File names and mtimes are not session semantics and can be stale.
	for (const filePath of listJsonlFiles(sessionsRoot)) {
		let text: string;
		try { text = readFileSync(filePath, "utf8"); } catch { continue; }

		let fileHasUsage = false;
		let fileTouchedToday = false;
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line);
				const entryTs = parseTsMs(entry.timestamp) ?? parseTsMs(entry.message?.timestamp);
				if (inDay(entryTs, day)) fileTouchedToday = true;

				if (entry.type !== "message") continue;
				const msg = entry.message;
				if (msg?.role !== "assistant" || !msg.usage) continue;

				const msgTs = parseTsMs(msg.timestamp) ?? entryTs;
				if (!inDay(msgTs, day)) continue;

				const u = msg.usage;
				const usagePart = { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, cost: u.cost?.total };
				addUsage(total, { ...usagePart, turns: 1 });
				addModelUsage(total, modelKey(msg.provider, msg.model), usagePart, 1);
				fileHasUsage = true;
			} catch { /* skip bad line */ }
		}

		if (fileTouchedToday) {
			sessionCount++;
			if (fileHasUsage) sessionsWithUsage++;
		}
	}

	return { total, sessionCount, sessionsWithUsage };
}

// ── 异步存储 ────────────────────────────────────────────────────────

interface AsyncRunRecord {
	id: string;
	agent?: string;
	/** L3：dispatch 时解析的 effective model（override ?? agent default），供 status 的 Model: 行展示。 */
	model?: string;
	task: string;
	status: "running" | "completed" | "failed";
	result?: SubagentResult;
	startedAt: string;
	cwd?: string;
}

function listAsyncRuns(): AsyncRunRecord[] {
	if (!existsSync(RUNS_DIR)) return [];
	return readdirSync(RUNS_DIR)
		.filter((f) => f.endsWith(".json"))
		.map((f) => { try { return JSON.parse(readFileSync(join(RUNS_DIR, f), "utf8")) as AsyncRunRecord; } catch { return null; } })
		.filter((r): r is AsyncRunRecord => r !== null)
		.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
}

// ── 可搜索选择器（TUI）────────────────────────────────────────────
// 当候选项较多时（如模型列表），提供一个带搜索框的选择器，避免在长列表里翻找。
// 返回用户选中的原始 options 字符串；取消或无匹配时返回 undefined。
// 非 TUI 模式或候选项很少时退化为原生 ctx.ui.select。
const SEARCHABLE_THRESHOLD = 14;

async function searchableSelect(
	ctx: ExtensionCommandContext,
	title: string,
	options: string[],
): Promise<string | undefined> {
	// 候选项不多，或非交互式 / 不支持 custom 组件：用原生选择器。
	if (options.length <= SEARCHABLE_THRESHOLD) {
		return ctx.ui.select(title, options);
	}
	if (ctx.mode !== "tui") {
		return ctx.ui.select(title, options);
	}

	const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		let query = "";
		let selectedIndex = 0;
		let cachedLines: string[] | undefined;
		// 渲染窗口（可见项数）。
		const maxVisible = 12;

		const editorTheme: EditorTheme = {
			borderColor: (s) => theme.fg("accent", s),
			selectList: {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			},
		};
		const editor = new Editor(tui, editorTheme);
		editor.setPaddingX?.(0);

		function filtered(): string[] {
			const q = query.trim().toLowerCase();
			if (!q) return options;
			return fuzzyFilter(options, q, (opt) => opt.toLowerCase());
		}

		function refresh() {
			cachedLines = undefined;
			tui.requestRender();
		}

		function clampIndex(list: string[]) {
			if (list.length === 0) {
				selectedIndex = 0;
				return;
			}
			if (selectedIndex >= list.length) selectedIndex = list.length - 1;
			if (selectedIndex < 0) selectedIndex = 0;
		}

		function handleInput(data: string) {
			// 导航 / 确认 / 取消
			if (matchesKey(data, Key.up)) {
				const list = filtered();
				if (list.length === 0) return;
				selectedIndex = selectedIndex === 0 ? list.length - 1 : selectedIndex - 1;
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				const list = filtered();
				if (list.length === 0) return;
				selectedIndex = selectedIndex === list.length - 1 ? 0 : selectedIndex + 1;
				refresh();
				return;
			}
			if (matchesKey(data, Key.enter)) {
				const list = filtered();
				const choice = list[selectedIndex];
				if (choice) done(choice);
				return;
			}
			if (matchesKey(data, Key.escape)) {
				done(null);
				return;
			}
			// 其余按键交给搜索框；输入变化后重置高亮并刷新。
			editor.handleInput(data);
			const next = editor.getText();
			if (next !== query) {
				query = next;
				selectedIndex = 0;
			}
			refresh();
		}

		function render(width: number): string[] {
			if (cachedLines) return cachedLines;
			const lines: string[] = [];
			const renderWidth = Math.max(1, width);

			lines.push(theme.fg("accent", "─".repeat(renderWidth)));
			lines.push(theme.fg("text", title));
			lines.push("");

			// 搜索框
			lines.push(theme.fg("muted", "Filter:"));
			for (const line of editor.render(Math.max(1, renderWidth - 0))) {
				lines.push(line);
			}
			lines.push("");

			const list = filtered();
			clampIndex(list);

			const total = list.length;
			const startIndex = total > maxVisible
				? Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), total - maxVisible))
				: 0;
			const endIndex = Math.min(startIndex + maxVisible, total);

			for (let i = startIndex; i < endIndex; i++) {
				const opt = list[i];
				const selected = i === selectedIndex;
				const prefix = selected ? theme.fg("accent", "→ ") : "  ";
				const body = selected ? theme.fg("accent", opt) : theme.fg("text", opt);
				lines.push(`${prefix}${body}`);
			}

			if (total === 0) {
				lines.push(theme.fg("warning", "  No matching models"));
			} else if (total > maxVisible) {
				lines.push(theme.fg("dim", `  (${selectedIndex + 1}/${total})`));
			}

			lines.push("");
			lines.push(theme.fg("dim", "Type to filter • ↑↓ navigate • Enter select • Esc cancel"));
			lines.push(theme.fg("accent", "─".repeat(renderWidth)));

			cachedLines = lines;
			return lines;
		}

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
			handleInput,
		};
	});

	return result === null ? undefined : result;
}

// ── 扩展入口 ────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const agents = discoverAgents();

	// 标签页身份 flag（--tab-run-id <runId>）：launch-tabs 派发时注入，可靠传递
	registerIdentityFlag(pi);
	// 会话身份 flag（--session-profile）：trace-fusion 派发 trace worker 时注入（C4 接线）。
	// 与 registerIdentityFlag 同时序约束：工厂内只注册不读值，消费点惰性读取。
	registerCapabilityFlags(pi);

	// 子 agent 进程（嵌套 pi 会话）由 PI_SUBAGENT=1 标记：
	// 禁止注册 launch-tabs 工具与 /launch 命令，杜绝子 agent 开新标签页。
	// （主会话不受影响；工具排除名单之外仍有兜底保护。）
	const isSubagentProcess = isSubagent();

	// Codex 请求头兼容（独立配置 ~/.pi/agent/codex-headers.json，命令 /codex-headers）
	registerCodexHeaders(pi);

	// 收集后台资源（interval/watcher）的清理函数：
	// reload/会话切换时 pi 会先发 session_shutdown，必须在此时清理，
	// 否则旧实例的后台定时器/监听器仍持有 stale 的 pi 引用并继续触发 sendUserMessage，
	// 导致新 turn 在旧扩展 ctx 上执行 → "This extension ctx is stale" 错误。
	const cleanups: Array<() => void> = [];
	const collect = (fn: (() => void) | undefined): void => { if (fn) cleanups.push(fn); };

	// 计时器：主会话与 tab 保持既有计时能力；子 agent 既不注册也不消费
	// （registerTimers 内按身份做纵深隔离，spawn argv 亦从工具表排除）。
	collect(registerTimers(pi));

	// 后台异步子 agent 面板（opencode 风格：widget + 状态栏 + 完成通知）
	collect(registerAsyncPanel(pi));

	// 事件总线：tab 完成即感知（fs.watch → toast + 自动唤醒模型去 reclaim）；
	// trace-fusion lane tab 则由 supervisor 自动后台收集（不注入 reclaim 提示）
	collect(registerEventBus(pi, {
		onTabFinished: (finishedTabRunId) => {
			const outcome = maybeAutoCollectTraceRun(finishedTabRunId);
			if (!outcome.isTrace) return false; // 普通 tab → 默认 toast + reclaim 注入
			if (outcome.phase === "started") {
				// L3：await send 结果吞掉 busy 拒绝（防逃逸到 bindCore 报成 Extension "<runtime>" error）；
				// 通知尽力而为（busy/failed 不阻塞），收集已在后台，用 /trace-fusion-status 查进度。
				injectFollowUpQuietly(
					pi.sendUserMessage,
					`🧬 trace-fusion run ${outcome.runId} 三路终态，已后台启动 deterministic cross-test（零模型调用）。
进度：/trace-fusion-status；报告：runDir/cross-test-report.md`,
				);
			}
			return true; // trace lane 消费（不注入 reclaim-tabs 提示）
		},
	}));

	// 热点路由缓存（v2 首版）：首轮 system-reminder 注入 + hotspot 工具 + /hotspot 诊断；
	// 结构约束（v2 §11）：主 index.ts 只加这一处注册
	collect(registerHotspot(pi));

	// 回报通道：tab 主动回报（tab-report）→ 主会话感知并注入消息
	collect(registerReportListener(pi));

	// mailbox 消费循环（Phase 4d）：flag 关/非 owner 时 tick 空转，零行为变化
	collect(registerMailboxConsumer(pi, {}));
	collect(registerOutboxBridge(pi));
	collect(registerGuiAutoStart(pi));
	collect(registerAsyncResultWatcher(pi, { runsDir: RUNS_DIR }));

	// 一次性 Sub-Master tab spawn（workstream wake 与 local master v1 共用账本序列：
	// dispatch → journal → link → spawn → failed 回写；wt 缺席在生成 runId 之前返回 error）。
	const spawnOneShotTab = (args: {
		sessionId: string;
		taskId: string;
		title: string;
		prompt: string;
		cwd: string;
		linkDetail: string;
	}): { runId: string; error?: string } => {
		const wtPath = findWindowsTerminal();
		if (!wtPath) return { runId: "", error: "no wt.exe" };
		const piCli = findPiCli();
		const runId = newTabRunId();
		const skillRef = existsSync(WORKFLOW_SKILL_FILE) ? WORKFLOW_SKILL_FILE : undefined;
		const prompt = buildWorkflowTabPrompt(
			{ taskId: args.taskId, title: args.title, prompt: args.prompt, model: undefined },
			skillRef,
			"execute",
		);
		const runsDir = defaultTabRunsDir();
		const dispatch: TabDispatchRecord = {
			id: runId, version: 1, taskId: args.taskId, mode: "execute", title: args.title, cwd: args.cwd,
			dispatchedAt: new Date().toISOString(), dispatchStatus: "dispatched",
		};
		const markFailed = (err: Error): void => {
			const failed = { ...dispatch, dispatchStatus: "launch_failed" as const, error: err.message };
			writeTabDispatch(runsDir, failed);
			emitRuntimeEventOnce(tabDispatchToRuntimeEvent(failed));
		};
		writeTabDispatch(runsDir, dispatch);
		emitRuntimeEventOnce(tabDispatchToRuntimeEvent(dispatch));
		recordLink({ sessionId: args.sessionId, kind: "tab", targetId: runId, detail: args.linkDetail });
		const result = spawnPiTab({
			wtPath, piCli, cwd: args.cwd, title: args.title, prompt, tabRunId: runId, runsDir,
			onSpawnError: (err) => markFailed(err),
		});
		if (result.error) {
			markFailed(new Error(result.error));
			return { runId, error: result.error };
		}
		return { runId };
	};

	// Sub-Master 唤醒循环（Phase 5c）：评估与消费同门；无 ws/无信/未切换时空转。
	// spawn 走与 launch-tabs 相同的账本序列（dispatch→journal→link→spawn→failed 回写）。
	collect(registerWakeLoop(pi, {
		intervalMs: 30_000,
		spawn: (decision: WakeDecision, sessionId: string | undefined) => {
			if (!sessionId) throw new Error("wake spawn: session unknown");
			const r = spawnOneShotTab({
				sessionId,
				taskId: `wake-${decision.workstreamId.slice(0, 14)}`,
				title: `wake ${decision.workstreamId.slice(0, 14)} (${decision.letters.length} inputs)`,
				prompt: decision.prompt ?? "",
				cwd: process.cwd(),
				linkDetail: `wake=${decision.workstreamId}`,
			});
			if (r.error) throw new Error(r.error);
			return r.runId;
		},
	}));

	// Local Master v1 唤醒循环（per-repo，0920）：本 scope 无 owner 时 session_start 静默认领；
	// 本会话为 scope owner 才 tick。spawn cwd = scope 仓 toplevel（读回 attachment.detail，缺省回退 cwd）。
	collect(registerScopeWakeLoop(pi, {
		intervalMs: 30_000,
		spawn: (decision: ScopeWakeDecision, sessionId: string | undefined) => {
			if (!sessionId) throw new Error("scope wake spawn: session unknown");
			const r = spawnOneShotTab({
				sessionId,
				taskId: `l2-${decision.scope.slice(0, 14)}`,
				title: `l2 ${decision.scope.slice(0, 20)} (${decision.letters.length} inputs)`,
				prompt: decision.prompt ?? "",
				cwd: decision.repoCwd ?? process.cwd(),
				linkDetail: `l2=${decision.scope}`,
			});
			if (r.error) throw new Error(r.error);
			return r.runId;
		},
	}));

	// ── /master-* 命令（Phase 4d，A5 F9/F11）──
	// master 原生感知：最近活跃仓库/scope（一行摘要）。三账本只读归并（recent-scopes.ts），
	// 任一账本不可读只降级为 "(unknown)"，永不打断 status。
	function recentScopesLine(): string {
		try {
			const items = listRecentScopes();
			// P0 返修：空结果须区分“窗口内无活动”与“三账本全缺席（无证据）”
			if (items.length === 0 && !anyLedgerPresent()) return "(unknown)";
			return formatRecentScopes(items);
		} catch {
			return "(unknown)";
		}
	}
	pi.registerCommand("master-status", {
		description: "查看逻辑 Master 归属：attachment / resolver / cutover / mailbox 积压",
		handler: async (_args, ctx) => {
			const { attachment: att, cutover: cut, snapshot: snap, backlog } = getMasterStatus();
			const lines = [
				`attachment: ${att ? `${att.sessionId.slice(0, 12)} gen=${att.generation} heartbeat=${att.lastHeartbeatAt.slice(11, 19)}` : "(none)"}`,
				`cutover: ${cut ? (cut.enabled ? `ON by=${cut.enabledBy.slice(0, 12)} at=${cut.enabledAt.slice(0, 19)}` : "OFF") : "(never set)"}`,
				`resolver: ${snap ? `${snap.sessionId.slice(0, 12)} gen=${snap.generation}` : "(null)"}`,
				`mailbox: ${backlog.map((b) => `${b.recipient}=p${b.pending}/c${b.claimed}`).join(" ") || "(empty)"}`,
				`recent: ${recentScopesLine()}`,
			];
			ctx.ui.notify(`Master status:\n${lines.join("\n")}`, "info");
		},
	});
	pi.registerCommand("master-attach", {
		description: "显式接管逻辑 Master：/master-attach [handoff-token] [--force-stale --confirm]",
		handler: async (args, ctx) => {
			// F9：sessionId 取自 Pi 上下文，禁参数伪造
			const sid = durableSessionIdentity(ctx as never); // 持久 UUID 域（DOG2 根因终修）
			if (!sid || sid === "unknown") { ctx.ui.notify("master-attach: 无法确定当前会话身份，拒绝", "warning"); return; }
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const token = parts.find((p) => !p.startsWith("--"));
			const force = parts.includes("--force-stale") && parts.includes("--confirm");
			if (parts.includes("--force-stale") && !parts.includes("--confirm")) {
				ctx.ui.notify("master-attach: --force-stale 须与 --confirm 同用（二次人工确认），拒绝", "warning");
				return;
			}
			const r = attachCurrentSession({ sessionId: sid, token, forceStale: force || undefined });
			if (!r.ok) { ctx.ui.notify(`master-attach 失败：${r.reason}`, "warning"); return; }
			// Phase 5.6：本会话刚 attach 成 owner → 补注册 result watcher（best-effort，与 master-attach 工具同）
			try { triggerOwnershipRecheck(); } catch { /* best-effort */ }
			ctx.ui.notify(`master-attach 成功：gen=${r.attachment.generation}${r.genesis ? "（genesis）" : ""} session=${sid.slice(0, 12)}`, "info");
		},
	});
	pi.registerCommand("master-cutover", {
		description: "切换消费端接管：/master-cutover on|off（需已 attach）",
		handler: async (args, ctx) => {
			const want = (args ?? "").trim().toLowerCase();
			if (want !== "on" && want !== "off") { ctx.ui.notify("用法：/master-cutover on|off", "warning"); return; }
			const sid = durableSessionIdentity(ctx as never); // 持久 UUID 域
			const st = setMasterCutover({ enabled: want === "on", by: sid });
			if (!st.ok) {
				ctx.ui.notify("master-cutover: 尚未 attach（先 /master-attach），拒绝开启", "warning");
				return;
			}
			ctx.ui.notify(`master-cutover 已${st.enabled ? "开启" : "关闭"}（by=${sid.slice(0, 12)}）`, "info");
		},
	});
	// succession 总开关（L3）：off = 不弹 proposal、不 auto transfer，压力满回落 pi 原生 compaction；
	// 缺省 on（现状零行为变化）。模式照 /master-auto-handoff：写 config 切片 + 回显；无参回显当前状态。
	pi.registerCommand("master-succession", {
		description: "succession 总开关：/master-succession on|off（默认 on；off 时静默提议/自动交接，回落 pi 原生 compaction）",
		handler: async (args, ctx) => {
			const want = (args ?? "").trim().toLowerCase();
			if (want !== "on" && want !== "off") {
				const cur = reloadConfig().masterSuccession.enabled ? "on" : "off";
				ctx.ui.notify(`succession 当前：${cur}（用法：/master-succession on|off）`, "info");
				return;
			}
			const cfg = reloadConfig();
			cfg.masterSuccession.enabled = want === "on";
			writeConfig(cfg);
			reloadConfig();
			ctx.ui.notify(
				want === "on"
					? `succession 已开启（auto=${cfg.masterSuccession.auto ? "ON" : "OFF"}）`
					: "succession 已关闭（不弹 proposal、不自动交接；压力满回落 pi 原生 compaction）",
				"info",
			);
		},
	});
	// S3 自动交接开关（A1）：持久化 config.json 切片，缺省 auto=false（OFF 零行为变化）
	pi.registerCommand("master-auto-handoff", {
		description: "S3 自动交接开关：/master-auto-handoff on|off（持久化 config，默认 off）",
		handler: async (args, ctx) => {
			const want = (args ?? "").trim().toLowerCase();
			if (want !== "on" && want !== "off") { ctx.ui.notify("用法：/master-auto-handoff on|off", "warning"); return; }
			const cfg = reloadConfig();
			cfg.masterSuccession.auto = want === "on";
			writeConfig(cfg);
			reloadConfig();
			ctx.ui.notify(`master 自动交接${want === "on" ? "已开启" : "已关闭"}（autoPercent=${cfg.masterSuccession.autoPercent}%，proposalPercent=${cfg.masterSuccession.proposalPercent}%）`, "info");
		},
	});
	pi.registerCommand("master-detach", {
		description: "交接逻辑 Master：颁发 handoff token（/master-detach [reason]）",
		handler: async (args, ctx) => {
			const sid = durableSessionIdentity(ctx as never); // 持久 UUID 域
			if (!sid || sid === "unknown") { ctx.ui.notify("master-detach: 无法确定当前会话身份，拒绝", "warning"); return; }
			const d = issueMasterHandoffToken({ sessionId: sid, reason: (args ?? "").trim() || undefined });
			if (!d.ok) {
				ctx.ui.notify("precheck" in d ? "master-detach: 你不是当前 owner，拒绝" : "master-detach 失败：not-owner", "warning");
				return;
			}
			ctx.ui.notify(`master-detach 成功：handoff token=${d.token}（接班者在新会话执行 /master-attach ${d.token}）`, "info");
		},
	});
	pi.registerCommand("master-handoff", {
		description: "生成交接包：/master-handoff [repoRoot]（只读装配，只落盘不注入）",
		handler: async (args, ctx) => {
			const repoRoot = (args ?? "").trim() || undefined;
			try {
				const doc = prepareMasterHandoff({ repoRoot });
				const present = doc.manifest.filter((m) => m.present).length;
				ctx.ui.notify(`handoff 已生成：${doc.path}\nmanifest ${present}/${doc.manifest.length} 项 present`, "info");
			} catch (e) {
				ctx.ui.notify(`master-handoff 失败：${e instanceof Error ? e.message : String(e)}`, "warning");
			}
		},
	});

	// ── /runtime-host 命令（Phase 6 G2：只读观察服务；拍板② 仅 slash 命令，默认不启动，零行为变化）──
	// start 派生独立 node 进程（bind 127.0.0.1:0，实际端口写 host.json 做发现）；stop 杀进程 +
	// 清 host.json（含僵尸文件）；status 回显 host.json + 探活（alive/stale/dead/missing）。
	pi.registerCommand("runtime-host", {
		description: "Runtime Host（G2 只读观察服务）：/runtime-host start|stop|status",
		handler: async (args, ctx) => {
			const cmd = (args ?? "").trim().toLowerCase();
			if (cmd === "start") {
				const r = await startRuntimeHost();
				if (r.error || !r.info) {
					ctx.ui.notify(`runtime-host 启动失败：${r.error ?? "未知错误"}`, "warning");
					return;
				}
				if (r.already) {
					ctx.ui.notify(`runtime-host 已在跑：pid=${r.info.pid} port=${r.info.port} startedAt=${r.info.startedAt}（回显现有，未重新 spawn）`, "info");
					return;
				}
				ctx.ui.notify(`runtime-host 已启动：127.0.0.1:${r.info.port} pid=${r.info.pid}（端口动态，实际值已写 host.json）`, "info");
				return;
			}
			if (cmd === "stop") {
				const r = await stopRuntimeHost();
				if (!r.stopped) {
					ctx.ui.notify(`runtime-host stop：${r.reason ?? "失败"}`, "warning");
					return;
				}
				ctx.ui.notify(`runtime-host 已停止：pid=${r.info?.pid ?? "?"}（host.json 已清理）`, "info");
				return;
			}
			if (cmd === "status") {
				const s = await runtimeHostStatus();
				if (s.state === "missing" || !s.info) {
					ctx.ui.notify("runtime-host：未启动（无 host.json）——/runtime-host start 启动", "info");
					return;
				}
				const i = s.info;
				const probe = s.state === "alive" ? "health=OK" : s.state === "stale" ? "probe=timeout（进程在、服务面不可用）" : "pid=dead（僵尸文件，可 stop 清理）";
				const master = (s.health as { master?: { attachment?: { sessionId?: string; generation?: number } | null } } | null)?.master;
				const owner = master?.attachment ? `master=${master.attachment.sessionId.slice(0, 12)} gen=${master.attachment.generation}` : "master=未 attach";
				ctx.ui.notify(
					`runtime-host：${s.state} pid=${i.pid} port=${i.port} startedAt=${i.startedAt}\nprobe: ${probe}\n${owner}`,
					s.state === "dead" || s.state === "stale" ? "warning" : "info",
				);
				return;
			}
			ctx.ui.notify("用法：/runtime-host start|stop|status", "warning");
		},
	});

	// ── /workstream* /task-* 命令（Phase 5a，A7 F18：显式优先）──
	const wsSid = (ctx: unknown): string | undefined => sessionIdentity(ctx as never);
	pi.registerCommand("workstream-create", {
		description: "创建 Workstream：/workstream-create <mission> [--criteria <成功标准>]",
		handler: async (args, ctx) => {
			const raw = (args ?? "").trim();
			if (!raw) { ctx.ui.notify("用法：/workstream-create <mission> [--criteria <成功标准>]", "warning"); return; }
			const ci = raw.indexOf("--criteria");
			const mission = (ci < 0 ? raw : raw.slice(0, ci)).trim();
			const criteria = ci < 0 ? undefined : raw.slice(ci + "--criteria".length).trim() || undefined;
			try {
				const ws = createWorkstream({ mission, successCriteria: criteria, session: wsSid(ctx) });
				ctx.ui.notify(`workstream 已创建：${ws.id}\nmission=${mission.slice(0, 80)}`, "info");
			} catch (e) {
				ctx.ui.notify(`workstream-create 失败：${e instanceof Error ? e.message : String(e)}`, "warning");
			}
		},
	});
	pi.registerCommand("workstream", {
		description: "查看 Workstream：/workstream [id]（无 id 列全部，含关联 runs 派生）",
		handler: async (args, ctx) => {
			const id = (args ?? "").trim();
			if (!id) {
				const all = listWorkstreams();
				if (!all.length) { ctx.ui.notify("暂无 workstream（/workstream-create 创建）", "info"); return; }
				ctx.ui.notify(all.map((w) => `${w.id} [${w.status}] ${w.mission.slice(0, 60)}`).join("\n"), "info");
				return;
			}
			const ws = readWorkstream(id);
			if (!ws) { ctx.ui.notify(`workstream 不存在：${id}`, "warning"); return; }
			const tasks = listTasks(ws.id);
			// 关联 runs（enrichment 派生，读时计算，F18）
			const runs = listProjectedRuns();
			const linked = runs.filter((r) => enrichRunRefs(r, tasks, [ws]).workstreamRef === ws.id);
			const lines = [
				`${ws.id} [${ws.status}]`,
				`mission=${ws.mission}`,
				ws.successCriteria ? `criteria=${ws.successCriteria}` : null,
				`tasks=${tasks.map((t) => `${t.id.slice(0, 14)}:${t.status}`).join(" ") || "(none)"}`,
				`runs=${linked.map((r) => `${r.subject.split("/").pop()}${r.status === "completed" ? "✓" : "…"}`).join(" ") || "(none)"}`,
			].filter((l): l is string => Boolean(l));
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
	pi.registerCommand("workstream-link", {
		description: "关联任务到 Workstream：/workstream-link <ws-id> <extId|run://…>…（run:// 精确，裸 id 为 label）",
		handler: async (args, ctx) => {
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const [wsId, ...refs] = parts;
			if (!wsId || !refs.length) { ctx.ui.notify("用法：/workstream-link <ws-id> <extId|run://…>…", "warning"); return; }
			const ws = readWorkstream(wsId);
			if (!ws) { ctx.ui.notify(`workstream 不存在：${wsId}`, "warning"); return; }
			const runSubjects = [...(ws.taskSelector?.runSubjects ?? [])];
			const externalTaskIds = [...(ws.taskSelector?.externalTaskIds ?? [])];
			for (const ref of refs) {
				if (ref.startsWith("run://")) { if (!runSubjects.includes(ref)) runSubjects.push(ref); }
				else if (!externalTaskIds.includes(ref)) externalTaskIds.push(ref);
			}
			updateWorkstream(wsId, { taskSelector: { runSubjects, externalTaskIds }, session: wsSid(ctx) });
			ctx.ui.notify(`已关联 ${refs.length} 个引用到 ${wsId}`, "info");
		},
	});
	pi.registerCommand("task-create", {
		description: "创建 Task：/task-create <objective> [--for <ws-id>] [--ext <外部任务号>]",
		handler: async (args, ctx) => {
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const flag = (name: string): string | undefined => {
				const i = parts.indexOf(name);
				return i >= 0 ? parts[i + 1] : undefined;
			};
			const objective = parts.filter((p, i) => !p.startsWith("--") && parts[i - 1] !== "--for" && parts[i - 1] !== "--ext").join(" ");
			if (!objective) { ctx.ui.notify("用法：/task-create <objective> [--for <ws-id>] [--ext <外部任务号>]", "warning"); return; }
			try {
				const t = createTask({ objective, workstreamId: flag("--for") as never, externalTaskId: flag("--ext"), session: wsSid(ctx) });
				ctx.ui.notify(`task 已创建：${t.id}（pending）`, "info");
			} catch (e) {
				ctx.ui.notify(`task-create 失败：${e instanceof Error ? e.message : String(e)}`, "warning");
			}
		},
	});
	pi.registerCommand("task-close", {
		description: "关闭 Task：/task-close <task-id> <completed|failed|cancelled>",
		handler: async (args, ctx) => {
			const [id, status] = (args ?? "").trim().split(/\s+/).filter(Boolean);
			if (!id || !["completed", "failed", "cancelled"].includes(status ?? "")) {
				ctx.ui.notify("用法：/task-close <task-id> <completed|failed|cancelled>", "warning"); return;
			}
			try {
				const t = setTaskStatus(id, status as never, { session: wsSid(ctx) });
				if (!t) { ctx.ui.notify(`task 不存在：${id}`, "warning"); return; }
				ctx.ui.notify(`task ${id.slice(0, 14)} → ${t.status}`, "info");
			} catch (e) {
				ctx.ui.notify(`task-close 失败：${e instanceof Error ? e.message : String(e)}`, "warning");
			}
		},
	});
	pi.registerCommand("workstream-pause", {
		description: "灭火开关：/workstream-pause <ws-id> [off]（缺省暂停，加 off 恢复 active；只封未来 wake，不杀在飞 tab）",
		handler: async (args, ctx) => {
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const [wsId, flag] = parts;
			if (!wsId) { ctx.ui.notify("用法：/workstream-pause <ws-id> [off]", "warning"); return; }
			const target = flag === "off" ? "active" : "paused";
			try {
				const ws = updateWorkstream(wsId, { status: target as never, session: sessionIdentity(ctx as never) });
				if (!ws) { ctx.ui.notify(`workstream 不存在：${wsId}`, "warning"); return; }
				ctx.ui.notify(`workstream ${wsId.slice(0, 14)} → ${ws.status}${target === "paused" ? "（未来 wake 已封，在飞 tab 需手动 reclaim）" : ""}`, "info");
			} catch (e) {
				ctx.ui.notify(`workstream-pause 失败：${e instanceof Error ? e.message : String(e)}`, "warning");
			}
		},
	});

	// reload/会话切换/退出前清理全部后台资源（旧实例的 interval/watcher 必须停止）
	// 后继 spawn 通道（wt.exe + spawnPiTab + 失败写 launch_failed）：master-transfer 工具与
	// S3 自动交接共用同一闭包（M3 内联实现原样提取，零逻辑变化）
	const spawnSuccessor: SpawnSuccessor = ({ transferId, title, prompt, sessionId }) => {
		const wtPath = findWindowsTerminal();
		if (!wtPath) throw new Error("master-transfer: no wt.exe");
		const piCli = findPiCli();
		const runId = newTabRunId();
		const taskId = `transfer-${transferId.slice(3, 9)}`;
		const cwd = process.cwd();
		const runsDir = defaultTabRunsDir();
		const dispatch: TabDispatchRecord = {
			id: runId, version: 1, taskId, mode: "execute", title, cwd,
			dispatchedAt: new Date().toISOString(), dispatchStatus: "dispatched",
		};
		writeTabDispatch(runsDir, dispatch);
		emitRuntimeEventOnce(tabDispatchToRuntimeEvent(dispatch));
		recordLink({ sessionId, kind: "tab", targetId: runId, detail: `transfer=${transferId}` });
		const result = spawnPiTab({
			wtPath, piCli, cwd, title, prompt, tabRunId: runId, runsDir,
			onSpawnError: (err) => {
				const failed = { ...dispatch, dispatchStatus: "launch_failed" as const, error: err.message };
				writeTabDispatch(runsDir, failed);
				emitRuntimeEventOnce(tabDispatchToRuntimeEvent(failed));
			},
		});
		if (result.error) {
			const failed = { ...dispatch, dispatchStatus: "launch_failed" as const, error: result.error };
			writeTabDispatch(runsDir, failed);
			emitRuntimeEventOnce(tabDispatchToRuntimeEvent(failed));
			throw new Error(result.error);
		}
		return { successorRunId: runId };
	};

	// 会话生命周期小 hook（session-hooks.ts，R1 抽取；before_agent_start 留在此文件）；
	// S3：spawn 通道 + 配置读取闭包一并传入（不传 = 不启用自动交接块）
	registerSessionHooks(pi, { cleanups, isNotifyEnabled: notifyEnabled, pkgDir: PKG_DIR, spawnSuccessor, masterSuccession: () => readConfig().masterSuccession });

	// 标签页回收：生命周期遥测（PI_TAB_RUN_ID 时生效）+ tab-status/reclaim-tabs//tabs
	registerTabTelemetry(pi);
	registerTabStatusTools(pi);

	// master tools：agent 可调用的 Master 控制（M2/M3，与 /master-* 同服务层）。
	// master-dispatch（0918 计划）：dispatchTab 闭包只做 findWindowsTerminal/findPiCli 解析 +
	// 注入 readAttachment（owner 路径最终 fencing 用），其余（wt 缺席在生成 runId 之前返回 error
	// 不落账本 + 账本/spawn）委托 masterDispatchLaunch。
	const dispatchTab: DispatchTab = (args) => {
		const wtPath = findWindowsTerminal();
		let piCli: string | undefined;
		let piErr: string | undefined;
		try {
			piCli = findPiCli();
		} catch (err) {
			piErr = `未找到 pi CLI: ${err instanceof Error ? err.message : String(err)}`;
		}
		return masterDispatchLaunch(args, { wtPath, piCli, piErr, env: { runsDir: defaultTabRunsDir(), timersDir: defaultTimersDir() }, readAttachment: () => readAttachment(masterAddress()) });
	};

	registerMasterTools(pi, { spawnSuccessor, masterSuccession: () => readConfig().masterSuccession, dispatchTab });

	// wiki-nav：渐进式 Wiki 导航查询工具（按层级调取附近节点，避免一次读整个 _navigation.json）
	registerWikiNav(pi);

	// ── Windows 通知 hook（受 config.json notifications 开关控制）──

	function notifyEnabled(): boolean {
		return readConfig().notifications !== false;
	}

	// 注册包内 skill 路径（注：小 hook 已迁 session-hooks.ts，此处仅保留 notify 开关与 prompt 注入）

	// 注入 subagent-win 配置到 LLM 上下文
	pi.on("before_agent_start", async (_event, ctx) => {
		// trace worker：early return（设计稿 §57）——不得先注入整套 workflow 编排规则再叮嘱别用。
		if (isTraceWorker()) {
			return {
				message: {
					customType: "trace-worker-profile",
					content: buildTraceWorkerSystemPrompt(),
					display: false,
				},
			};
		}
		const cfg = readConfig();
		const allModels = ctx.modelRegistry?.getAvailable() ?? [];
		const lines: string[] = [
			"### Subagent-win default config (config.json only; NOT the model of the last/current run)",
			"",
			"【会话与派发硬规则】subagent 是无头子 agent；tab 是可见的独立 pi 标签页。两者都可能有 runId，但 runId 不是同一种东西。",
			"1. `subagent-win` = 无头子 agent：sync、parallel、async 三种模式都不会打开 Windows Terminal 标签页。async subagent 的 runId 只能用 `subagent-win({ action: \"status\", runId })` 查询；不要使用 `tab-status`、`reclaim-tabs`、`tab-finish` 或 `set-timer`。",
			"2. `launch-tabs` = 可见任务 tab：只允许主会话调用，用于长时间、独立、需要可见 TUI 或跨主会话重启存活的工作。tab 的 runId 只能用 `tab-status` / `reclaim-tabs` 管理，完成用 `tab-finish`。",
			"3. 已派发的任务 tab 严禁再调用 `launch-tabs` / `/launch`；tab 内的角色委派只能使用 `subagent-win`。",
			"4. 选择规则：本轮需要结果 → `subagent-win`；长时间且需要可见/独立回收 → 主会话调用 `launch-tabs`。不要因为 subagent 使用 async 就把它当成 tab。",
			"5. timer 不是 async subagent 的配套机制：主会话可按需为 tab 编排巡检，subagent 不得设置 timer。",
			"",
		];
		const names = [...new Set([...agents.map((a) => a.name), ...Object.keys(cfg.models)])].sort();
		for (const name of names) {
			const modelRef = cfg.models[name] ?? "(pi default)";
			const isCli = isExternalCliModel(modelRef);
			const model = isCli ? undefined : allModels.find((m) => m.provider + "/" + m.id === modelRef);
			const ctxStr = isCli
				? "external-cli"
				: model?.contextWindow
					? (model.contextWindow / 1000).toFixed(0) + "K"
					: "?";
			lines.push("- " + name + ": " + modelRef + " (ctx: " + ctxStr + ")");
		}
		lines.push("");
		lines.push("Per-call model override: pass `model` on a single call or each parallel task. That value is what actually runs; the list above is only defaults.");
		lines.push("Canonical form is `provider/id` (example: `Zhipu/glm-5.2`). Short aliases such as `glm-5.2` / `glm5.2` expand from ~/.pi/agent/models.json when unambiguous.");
		lines.push("External CLI harnesses exist (`cli:claude`, `cli:codex`, `cli:agy`, `cli:atomcode`, `cli:zcode`) but are ONLY used by agents whose config.json default or fallback is set to one (e.g. implementer=`cli:agy`). These spawn local CLIs with each tool's own default model — never pass provider/id or cli:backend/model overrides.");
		lines.push("Example: subagent-win({ agent: \"code-reviewer\", model: \"Zhipu/glm-5.2\", task: \"...\" })");
		lines.push("Model selection priority (follow strictly): (1) DEFAULT — let each agent run its configured default + its fallback chain above; do NOT pass `model` to override. (2) Only override `model` when ONE of these is true: (a) the fallback chain is also unavailable (every default+fallback attempt failed, e.g. USAGE_CAP across the whole chain); (b) the USER explicitly asked for a specific model or agent; (c) the configured model is clearly unsuitable for THIS task (context window too small, or capability mismatch). (3) When overriding, prefer a normal provider/id — do NOT proactively switch to an external CLI (cli:claude/codex/agy/atomcode/zcode) unless that agent's config already uses one or the user explicitly asked. The mere existence of a cli: backend is never a reason to use it.");
		lines.push("Sync/async decision applies to subagent-win only: DEFAULT ASYNC (`async: true`, non-blocking; products drop to disk with path-first short summary, collected via completion event/watcher/timer); SYNC only when the result is needed this turn (dependent next step, L4 re-verification); PARALLEL (`tasks: [...]`) for independent headless subagents you must all wait for; ASYNC (`async: true`) for a headless subagent whose result is not needed this turn. Async subagent runId must be checked with `subagent-win({ action: \"status\", runId })`; it is not a tab and does not need set-timer, tab-status, reclaim-tabs, or tab-finish. Use launch-tabs separately only when the main session needs a visible independent tab.");
		lines.push("consultant 派发规则：当用户显式点名某模型并要求评估/审查/咨询/看截图（如「请glm来评估一下」「请gpt5.6看看截图仿照设计」「请opus4.6点评一下」）时，dispatch agent=\"consultant\" 并把用户点名的模型作为 model override（短名如 glm / gpt5.6 / opus4.6 会自动展开为 provider/id）；该 subagent 以被点名模型的视角作答。这类请求不得派给 searcher / code-reviewer / planner 顶替。用户未点名模型时，用 consultant 的 config 默认模型，或由你根据任务判断选择合适的 model override。截图场景：把截图路径写进 task，让 consultant 用 read 读取图片后仿照设计。");
		lines.push("TUI call line shows `override:<model>` when model is overridden; tool result header shows the requested model.");
		lines.push("Do NOT permanently rewrite config.json just to try another model once; use the per-call `model` field.");
		// searcher 派发模式
		const searcherMode = cfg.searcherMode ?? "auto";
		const searcherModeHint: Record<string, string> = {
			auto: "auto — orchestrator 根据模型上下文（<200K 拆分并行）和任务独立性自行决定串/并行",
			serial: "serial — 逐个串行派发 searcher（每次只跑一个，等返回后派下一个；适合 GPU 资源有限的本地模型）",
			parallel: "parallel — 并发派发所有 searcher（速度优先，多方向同时搜索）",
		};
		lines.push(`Searcher dispatch mode: ${searcherModeHint[searcherMode] ?? searcherModeHint["auto"]}`);
		if (searcherMode === "serial") {
			lines.push(`[searcher-mode=serial] 强制要求：所有 searcher 必须串行派发。主 agent 派发多个 searcher 时，必须等上一个 searcher 返回结果后再派下一个（sync 单次调用），不得使用 parallel tasks 数组并发。唯一例外：搜索方向完全独立且用户明确要求速度时，可临时 override 为 parallel。`);
		} else if (searcherMode === "parallel") {
			lines.push(`[searcher-mode=parallel] 所有 searcher 优先并发派发（parallel tasks 数组），除非搜索方向之间有严格依赖。`);
		}
		// lite 轻量工作流模式（逻辑在 lite-mode.ts；off 时零注入）
		lines.push(...litePromptLines(cfg));
		lines.push("Note: When dispatching the searcher, ask it to query `Wiki/` by keyword first, jump straight to code via each page's `source_paths` (e.g. `file#L49` / `file::Symbol`, no grep guessing), cross-check with codegraph, and PROACTIVELY maintain theme pages — update stale ones (re-verify as `current` or mark `stale`) and CREATE a missing page when a durable, source-verified cross-task theme is absent. Require each returned fact to carry a code location AND a Wiki section reference (or `Wiki: none`) plus a calibration status, plus a 'Wiki section list' and a 'Wiki maintenance record' to forward to downstream agents.");
		lines.push("Note: Wiki is reused across agents — when dispatching planner/plan-reviewer/implementer/code-reviewer, forward the searcher's Wiki section list and instruct them to `read` those sections first (free knowledge, no re-exploration). Task findings still never go to Wiki.");
		lines.push("Note: Use `wiki-nav` progressively instead of reading whole index JSON. This discovery flow is ONLY for a new/unlocated topic: split it into 1-5 short phrases → `keywords queries=[...]` exact-check → only exact misses may use `semantic-terms queries=[...]` (returns terms only) → grep a selected term to locate Wiki. Once a searcher confirms `Wiki/path.md#section`, that exact reference is the workflow handoff: forward it to planner/implementer/reviewer and have them read it directly; never rediscover a known reference. `keywords query=<fragment>` filters vocabulary only. Do NOT inspect `_navigation.json`/`_search.json`/`_keywords.json`. `tree node` requires a real page id/title/unique alias, not a directory name.");
		lines.push("Note: Run `wiki-nav rebuild` ONLY after Wiki was created/updated/merged/deleted, or when the tool reports a missing index. It regenerates `_navigation.json` + `_search.json` + `_keywords.json` from Wiki/*.md (TS, self-contained, sub-second). Rebuilding cannot make an unchanged no-match query succeed.");
		lines.push("Note: Models with <200K context should split large exploration into parallel subtasks; task findings stay in replies or plans/*_research.md, not task-oriented Wiki pages.");
		lines.push("Note: If a subagent returns [subagent-failure kind=USAGE_CAP] (GLM package/quota limit), switch the main session model via /model to a higher-tier/different provider, then retry with model= override — do not retry the same model.");
		lines.push("Visible workflow launch: when the user asks `/launch` without `-t`/`--direct`, first analyze the current conversation, identify all independent ready tasks, then call `launch-tabs` once with all tasks. Do not open a tab for the orchestration sentence. Each launch-tabs prompt must contain the relevant workflow handoff; its first line is normalized to `根据workflow进行工作<taskId>` and a mandatory workflow-discipline block is appended (read the workflow-orchestrator skill, act as project manager and delegate stages to subagent-win agents, never complete the task in one shot). Three task modes → replaced with: Four task modes are available on launch-tabs tasks: `workflow` (default full chain), `research` (deep research only: parallel searchers → research report in plans/YYYYMMDD_research_<topic>.md → Wiki theme-page maintenance, no implementation; tab starts with `根据research进行工作<taskId>`), `execute` (conclusion already settled: skip search and planning → implementer → code-reviewer → Wiki wrap-up; tab starts with `根据execute进行工作<taskId>`), and `adaptive` (tab self-assesses handoff completeness at startup and picks its own chain depth A0自执行快链/A快链/B中链/C全链 — use when the handoff already carries root cause + approach + file scope + acceptance criteria, i.e. you could write the acceptance criteria yourself; tab starts with `根据adaptive进行工作<taskId>`).");
		lines.push("Tab reclaim + timer orchestration (ultra-long task infra): launch-tabs returns a `runId` per tab; use `tab-status` to inspect phase (dispatched/attached/working/waiting/completed/failed/cancelled/orphaned/unconfirmed), `reclaim-tabs({runIds, wait, timeoutMs})` to collect results and get ready[]/pending[]/awaitingInput[]/failed[]/orphaned[] for the next batch — never treat `waiting` or missing-result as done (resultMissing/unconfirmed). `set-timer({message, delayMs, target})` makes the system auto-send a user message when the timer expires (target=self or a tab's runId via launch-tabs `timers` param) to push work forward; `list-timers`/`cancel-timer`/`/timers` manage them. Closed loop: launch-tabs(batch N) → set-timer to advance → reclaim-tabs(batch N) → launch-tabs(batch N+1).");
		// 主会话专属禁轮询纪律（isMainSession 门：tab/子 agent 不注入——"STOP 是合法终态"与 worker 的 tab-finish 纪律冲突，见 no-poll.ts 头注释）
		if (isMainSession()) lines.push(NO_POLL_DISCIPLINE);
		// S2 提议制交接提醒缝（M5）：存在 pending proposal 即追加短提醒（§12），否则零注入。
		// 总开关 enabled=false → 全静默（L3 返修）：不注入 reminder；pending state 保留不清除，
		// 开关回 on 后现有提醒生命周期原样恢复。
		const successionReminder = cfg.masterSuccession.enabled ? getPendingReminder() : null;
		if (successionReminder) lines.push(successionReminder);
		return { message: { customType: "subagent-win-config", content: lines.join("\n"), display: false } };
	});

	const canOrchestrateTabs = capabilities().launchTabs; // 主会话专属；trace-worker/subagent 禁止（矩阵见 capabilities.ts，现阶段与 isMainSession() 等价）
	if (!canOrchestrateTabs) {
		// 标签页 / 子 agent：跳过 launch-tabs 工具注册（防止孙 tab 派发）
	} else {
	pi.registerTool({
		name: "launch-tabs",
		label: "Launch Pi Tabs",
		description: [
			"这是可见任务 tab 编排工具，只允许主会话调用；不会启动无头 subagent。任务 tab 内也严禁再次调用 launch-tabs。",
			"在 Windows Terminal 中并行打开一个或多个可见、独立的 pi 交互标签页。",
			"先分析当前会话并只提交彼此独立、启动条件已满足的任务；不要为编排请求本身打开标签页。",
			"每项必须提供 taskId、具体 prompt；prompt 会自动以 `根据workflow进行工作<taskId>` 开头，并附加 workflow-orchestrator 强制约束块（先 read 技能、委派 subagent-win 各角色执行、禁止单 agent 一路干完）。",
			"任务模式 mode：workflow（默认，完整链路）| research（深度研究：只并行搜索 + 研究报告 plans/*_research.md + Wiki 主题页维护，不做计划与实现；前缀 `根据research进行工作<taskId>`）| execute（快速执行：结论已明确，跳过搜索与计划，仅实现→审查→Wiki 收尾；前缀 `根据execute进行工作<taskId>`）| adaptive（自适应：任务书含根因+方案+文件域+验收标准时用，tab 启动自评完备度选链深 A0自执行快链/A快链/B中链/C全链；前缀 `根据adaptive进行工作<taskId>`）。",
			"一次调用传入全部任务以保证并行启动。",
			"标签自动生成规范名 `<仓库名>[-worktree]-<taskId>-<标签>`（仓库名取自 git origin/toplevel，worktree 路径自动加 -worktree- 标记，标签取显式 title 或从 prompt 首行提取）；不再使用无意义的 wlc 默认名。",
			"每项返回 tab runId（只属于可见 tab）：用 tab-status 查询状态、reclaim-tabs 回收结果后编排下一批；不要把它与 subagent-win async runId 混用。每项可传 timers: [{delayMs, message, label?, repeatMs?}] 写入该标签页邮箱，到期自动发送推进消息（仅主会话的 tab 编排）。",
			"每项可传 cwd 指定新标签页工作目录（默认当前目录）；独立 worktree 场景必须显式传 cwd。",
		].join(" "),
		parameters: Type.Object({
			tasks: Type.Array(Type.Object({
				taskId: Type.String({ description: "任务编号，例如 1007" }),
				prompt: Type.String({ description: "该任务的首轮 prompt；应包含 workflow 交接材料与具体范围" }),
				cwd: Type.Optional(Type.String({ description: "新标签页工作目录；缺省用当前目录。独立 worktree 场景必填，如 G:/code/worktrees/GreenCAD-123" })),
				model: Type.Optional(Type.String({ description: "仅用户明确要求或配置不适用时覆盖新 pi 会话模型" })),
				title: Type.Optional(Type.String({ description: "标签名（可选）：仅作为标签部分，自动剥离开头的 pi-/wlc- 前缀；缺省从 prompt 首行提取" })),
				mode: Type.Optional(Type.String({ description: "任务模式（可选）：workflow（默认，完整链路 搜索→计划→审查→实现→审查→Wiki 收尾）| research（深度研究：仅并行搜索 + 研究报告 + Wiki 主题页维护，不做计划与实现）| execute（快速执行：结论已明确，跳过搜索与计划，仅实现→审查→Wiki 收尾）| adaptive（自适应：任务书四要素齐全时用，tab 启动自评完备度选链深 A0自执行快链/A快链/B中链/C全链）" })),
				timers: Type.Optional(Type.Array(Type.Object({
					delayMs: Type.Number({ description: "延时毫秒：到期后系统自动向该标签页发送消息推进工作" }),
					message: Type.String({ description: "到期自动发送的推进指令" }),
					label: Type.Optional(Type.String({ description: "可读说明" })),
					repeatMs: Type.Optional(Type.Number({ description: "周期重发间隔（≥10000ms）" })),
				}), { description: "派发时写入该标签页邮箱的计时器（超长程任务编排）" })),
			})),
		}),
		renderCall(args, theme) {
			const tasks = (args.tasks ?? []) as Array<{ taskId?: string }>;
			return new Text(
				`${theme.fg("toolTitle", theme.bold("launch-tabs"))} ${theme.fg("accent", `${tasks.length} tabs`)}${tasks.length ? `: ${tasks.map((task) => task.taskId ?? "?").join(", ")}` : ""}`,
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const details = result.details as { results?: LaunchDispatch[] } | undefined;
			const results = details?.results ?? [];
			const ok = results.filter((item) => !item.error).length;
			const lines = results.map((item) => item.error
				? `✗ ${item.title}: ${item.error}`
				: `✓ ${item.title} ← ${item.prompt.slice(0, 80)}`);
			return new Text(`${theme.fg(ok === results.length ? "success" : "warning", `launch-tabs ${ok}/${results.length}`)}${lines.length ? `\\n${lines.join("\\n")}` : ""}`, 0, 0);
		},
		async execute(_toolCallId, rawParams, _signal, _onUpdate, _ctx) {
			// 运行时防护：只允许主会话调用 launch-tabs
			if (!capabilities().launchTabs) {
				return { content: [{ type: "text", text: "launch-tabs 只允许主会话调用；标签页会话请用 subagent-win 委派各角色，或用 tab-finish 回报主会话。" }], isError: true };
			}

			const params = rawParams as { tasks?: Array<{ taskId?: string; title?: string; prompt?: string; cwd?: string; model?: string; mode?: string; timers?: Array<{ delayMs?: number; message?: string; label?: string; repeatMs?: number }> }> };
			const input = params.tasks ?? [];
			if (input.length === 0) {
				return { content: [{ type: "text", text: "launch-tabs requires at least one task" }], isError: true };
			}
			if (input.length > MAX_CONCURRENCY) {
				return { content: [{ type: "text", text: `launch-tabs supports at most ${MAX_CONCURRENCY} tabs per call` }], isError: true };
			}

			const wtPath = findWindowsTerminal();
			if (!wtPath) {
				return { content: [{ type: "text", text: "未找到 Windows Terminal (wt.exe)，无法启动标签页" }], isError: true };
			}
			let piCli: string;
			try {
				piCli = findPiCli();
			} catch (err) {
				return { content: [{ type: "text", text: `未找到 pi CLI: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
			}

			const runsDir = defaultTabRunsDir();
			const timersDir = defaultTimersDir();

			const results = input.map((item) => {
				const mode: LaunchMode = item.mode === "research" ? "research" : item.mode === "execute" ? "execute" : item.mode === "adaptive" ? "adaptive" : "workflow";
				return launchWorkflowTab(
					{
						taskId: item.taskId ?? "",
						title: item.title,
						prompt: item.prompt ?? "",
						model: item.model,
						cwd: item.cwd,
						mode,
						timers: item.timers,
						sessionId: sessionIdentity(_ctx as never),
						timerSource: "launch-tabs",
					},
					{ wtPath, piCli, runsDir, timersDir },
				);
			});
			const ok = results.filter((item) => !item.error).length;
			const lines = results.map((item) => item.error
				? `✗ ${item.title} [${item.runId}]: ${item.error}`
				: `✓ ${item.title} [${item.runId}]: ${item.prompt.slice(0, 60)}`);
			return {
				content: [{
					type: "text",
					text: `已并行启动 ${ok}/${results.length} 个 pi 标签页（runId 见下，用 tab-status / reclaim-tabs 回收）:\n${lines.join("\n")}`,
				}],
				details: { results },
				isError: ok === 0,
			};
		},
	});
	}

	pi.registerTool({
		name: "subagent-win",
		label: "Subagent Win",
		description: [
			"这是无头 subagent 工具，不会打开 Windows Terminal 标签页；sync/parallel/async 都仍是 subagent，不是 tab。需要可见独立标签页时，只有主会话才能调用 launch-tabs。",
			"单 agent: { agent, task, model?, cwd? }",
			"并行: { tasks: [{agent, task, model?, cwd?}, ...], concurrency?, async? }（缺省异步：立返 runId 列表，靠 action=status 收割；显式 async:false 才阻塞等待全部结果；concurrency 仅同步路径有效，异步 fan-out 忽略不限流）",
			"异步: { agent, task, model?, cwd? }（**缺省就是异步**，仍是无头 subagent；本轮就要结果才显式 async: false 走同步）",
			"查状态: { action: \"status\", runId? }（async subagent 的 runId 只能用这里查询）",
			"不要对 async subagent 使用 tab-status、reclaim-tabs、tab-finish 或 set-timer。",
			"【async 决策准则】缺省即异步（非阻塞，返回 runId，产物落盘 plans/，靠完成事件/async-result-watcher/status 收割）；只有结果本轮马上要用（下一步依赖、L4 复核）才显式 async: false 同步等待；同批独立任务用 tasks: [...] 并行（并行缺省同样异步，显式 async:false 才阻塞）。async subagent 不是可见 tab，不需要 timer。只有主会话需要可见、独立、可回收标签页时，才调用 launch-tabs。",
			"model 可覆盖该 agent 默认模型（仅本次调用）；优先 provider/id，如 Zhipu/glm-5.2；也接受 glm-5.2 / glm5.2 等短名。",
			"外部 CLI 后端（仅当某 agent 的 config 默认/fallback 已设为该后端时才走，勿主动用其 override 未配置的 agent）：model=\"cli:claude\" | \"cli:codex\" | \"cli:agy\" | \"cli:atomcode\" | \"cli:zcode\"（各 CLI 默认模型，不支持覆盖）。cwd 可指定项目 worktree。",
			"consultant（咨询/评估顾问）：当用户点名某个模型来做评估/咨询/看截图（如「请glm来评估一下」「请gpt5.6看看截图仿照设计」）时，用 agent=\"consultant\" 并把用户点名的模型作为 model override（短名自动展开）；截图路径写进 task。",
		].join(" "),
		parameters: Type.Object({
			agent: Type.Optional(Type.String({ description: "agent 名称" })),
			task: Type.Optional(Type.String({ description: "任务描述" })),
			tasks: Type.Optional(Type.Array(Type.Object({
				agent: Type.Optional(Type.String({ description: "agent 名称" })),
				task: Type.String({ description: "任务描述" }),
				systemPrompt: Type.Optional(Type.String()),
				model: Type.Optional(Type.String({
					description: "覆盖该 task 的模型。provider/id、短名，或外部 CLI 后端（cli:claude / cli:codex / cli:agy / cli:atomcode / cli:zcode，均用 CLI 默认模型）",
				})),
				cwd: Type.Optional(Type.String({ description: "该 task 的工作目录；指定 git worktree 路径，子 agent 将在此目录运行，而不是主分支" })),
				timeoutMs: Type.Optional(Type.Number({ description: "停顿超时（ms）：子 agent 持续无输出/无进展超过该时长才判停；不限制整个任务总时长。长任务只要持续输出就不会被打断；缺省不限。" })),
				tools: Type.Optional(Type.Array(Type.String({ description: "工具名，如 read / bash / edit / write" }), { description: "per-call 正向 allowlist（仅显式传入才生效）：传入则给子进程加 --tools；缺省不加（pi 默认全量）。pi 内置工具只有 read/bash/edit/write；外部 CLI 后端不支持，显式传入会报错" })),
				excludeTools: Type.Optional(Type.Array(Type.String(), { description: "per-call 额外排他工具列表，叠加到默认防递归排他（subagent-win/launch-tabs/timers）之后" })),
			}))),
			concurrency: Type.Optional(Type.Number({ description: "并行并发数（默认 3；仅 async:false 同步路径有效，异步 fan-out 忽略）" })),
			async: Type.Optional(Type.Boolean({ description: "异步执行（单发与并行 tasks 均适用）；**缺省 true（非阻塞，返回 runId 后靠完成事件/status 收割）**，只有本轮就要结果时才显式传 false 走同步等待" })),
			action: Type.Optional(Type.String({ description: "status" })),
			runId: Type.Optional(Type.String({ description: "异步 run id" })),
			systemPrompt: Type.Optional(Type.String()),
			model: Type.Optional(Type.String({
				description: "覆盖本次调用模型（优先于 config.json / agent frontmatter）。provider/id 或短名，如 Zhipu/glm-5.2、glm-5.2；外部 CLI 仅后端：cli:claude / cli:codex / cli:agy / cli:atomcode / cli:zcode（使用 CLI 默认模型）",
			})),
			cwd: Type.Optional(Type.String({ description: "工作目录；指定 git worktree 路径，子 agent 将在此目录运行，而不是主分支" })),
			timeoutMs: Type.Optional(Type.Number({ description: "停顿超时（ms）：持续无输出/无进展超过该时长才判停；不限制总时长；缺省不限。" })),
			tools: Type.Optional(Type.Array(Type.String({ description: "工具名，如 read / bash / edit / write" }), { description: "per-call 正向 allowlist（仅显式传入才生效）：传入则给子进程加 --tools；缺省不加（pi 默认全量）。pi 内置工具只有 read/bash/edit/write；外部 CLI 后端不支持，显式传入会报错" })),
			excludeTools: Type.Optional(Type.Array(Type.String(), { description: "per-call 额外排他工具列表，叠加到默认防递归排他（subagent-win/launch-tabs/timers）之后" })),
		}),

		// ── TUI 渲染 ──
		renderCall(args, theme) {
			const title = theme.fg("toolTitle", theme.bold("subagent-win"));
			if (args.tasks) {
				let text = `${title} ${theme.fg("accent", `parallel (${args.tasks.length} tasks)`)}${args.async ? " " + theme.fg("warning", "async") : ""}`;
				for (const t of args.tasks.slice(0, 3)) {
					const agent = t.agent ?? "?";
					const agentDef = t.agent ? agents.find((a) => a.name === t.agent) ?? null : null;
					const preview = (t.task ?? "").slice(0, 30);
					const modelTag = theme.fg("muted", displayModelForCall(t.model, agent, agentDef));
					text += `\n  ${theme.fg("accent", agent)}${modelTag} ${theme.fg("dim", preview)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.action === "status") {
				return new Text(`${title} ${theme.fg("muted", "status")}${args.runId ? " " + theme.fg("dim", args.runId) : ""}`, 0, 0);
			}
			if (args.async) {
				const agentDef = args.agent ? agents.find((a) => a.name === args.agent) ?? null : null;
				const modelTag = theme.fg("muted", displayModelForCall(args.model, args.agent, agentDef));
				return new Text(`${title} ${theme.fg("warning", "async")} ${theme.fg("accent", args.agent ?? "")}${modelTag} ${theme.fg("dim", (args.task ?? "").slice(0, 40))}`, 0, 0);
			}
			const agentName = args.agent ?? "";
			const agentDef = args.agent ? agents.find((a) => a.name === args.agent) ?? null : null;
			const taskPreview = (args.task ?? "").slice(0, 60);
			const modelTag = theme.fg("muted", displayModelForCall(args.model, agentName, agentDef));
			return new Text(`${title} ${theme.fg("accent", agentName)}${modelTag} ${theme.fg("dim", taskPreview)}`, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const d = result.details as Record<string, any> | undefined;
			const mdTheme = getMarkdownTheme();
			if (d?.results) {
				const results = d.results as SubagentResult[];
				const ok = results.filter((r) => r.status === "completed").length;
				const icon = ok === results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");
				if (expanded) {
					const c = new Container();
					c.addChild(new Text(`${icon} ${theme.fg("toolTitle", "parallel")} ${theme.fg("accent", `${ok}/${results.length}`)}`, 0, 0));
					for (const r of results) {
						c.addChild(new Spacer(1));
						const rIcon = r.status === "completed" ? theme.fg("success", "✓") : r.status === "cancelled" ? theme.fg("warning", "⛔") : theme.fg("error", "✗");
						const modelTag = (r.requestedModel ?? r.model) ? ` ${theme.fg("muted", r.requestedModel ?? r.model)}` : "";
						const fbMark = r.priorFailures?.length ? ` ${theme.fg("warning", `↺fallback×${r.priorFailures.length}`)}` : "";
						c.addChild(new Text(`${rIcon} ${theme.fg("accent", r.agent ?? "?")}${modelTag}${fbMark}`, 0, 0));
						c.addChild(new Text(theme.fg("dim", r.text?.slice(0, 200) ?? r.error ?? ""), 0, 0));
						if (r.priorFailures?.length) {
							for (const f of r.priorFailures) c.addChild(new Text(theme.fg("error", `fallback: ${f.model} failed (${f.kind}) — ${String(f.error).slice(0, 200)}`), 0, 0));
						}
						if (r.usage?.turns) c.addChild(new Text(theme.fg("dim", `↑${r.usage.input} ↓${r.usage.output} $${r.usage.cost.toFixed(4)}`), 0, 0));
					}
					return c;
				}
				const lines = results.map((r) => {
					const mark = r.status === "completed" ? "✓" : r.status === "cancelled" ? "⛔" : "✗";
					const modelTag = (r.requestedModel ?? r.model) ? ` (${r.requestedModel ?? r.model})` : "";
					const fbMark = r.priorFailures?.length ? ` ↺fallback` : "";
					return `${mark} ${r.agent ?? "?"}${modelTag}${fbMark}: ${(r.text ?? r.error ?? "").slice(0, 80)}`;
				});
				return new Text(`${icon} parallel ${ok}/${results.length}\n${lines.join("\n")}`, 0, 0);
			}
			const r = d?.result as SubagentResult | undefined;
			if (!r) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			const isOk = r.status === "completed";
			const icon = isOk ? theme.fg("success", "✓") : r.status === "cancelled" ? theme.fg("warning", "⛔") : theme.fg("error", "✗");
			// Prefer requestedModel (provider/id actually passed to pi); fall back to assistant-reported bare id.
			const modelLabel = r.requestedModel ?? r.model ?? "";
			const fbChain = r.priorFailures?.length ? fallbackChainText(r) : "";
			// When a fallback happened, surface the chain (warning color) instead of just the final model,
			// so it's clear the requested override failed and a fallback was used.
			const modelTag = fbChain
				? theme.fg("warning", fbChain)
				: modelLabel ? theme.fg("dim", modelLabel) : "";
			const usageTag = r.usage?.turns ? theme.fg("dim", `↑${r.usage.input} ↓${r.usage.output} $${r.usage.cost.toFixed(4)}`) : "";

			// status line: agent name + actual requested model + usage
			const statusLine = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent ?? "subagent"))}  ${modelTag}  ${usageTag}`.replace(/\s{2,}/g, " ");

			if (expanded) {
				const c = new Container();
				c.addChild(new Text(statusLine, 0, 0));
				if (r.priorFailures?.length) {
					for (const f of r.priorFailures) {
						c.addChild(new Text(theme.fg("error", `fallback: ${f.model} failed (${f.kind}) — ${String(f.error).slice(0, 300)}`), 0, 0));
					}
				}
				if (r.error) c.addChild(new Text(theme.fg("error", r.error), 0, 0));
				if (r.text) { c.addChild(new Spacer(1)); c.addChild(new Markdown(r.text.trim(), 0, 0, mdTheme)); }
				return c;
			}
			// collapsed: show status line + first line of output
			const preview = (r.text ?? r.error ?? "").slice(0, 200).split("\n")[0];
			return new Text(`${statusLine}\n${theme.fg("dim", " " + preview)}${r.text?.length > 200 ? "... (Ctrl+O)" : ""}`, 0, 0);
		},

		async execute(_toolCallId, rawParams, signal, onUpdate, _ctx) {
			const p = rawParams as Record<string, any>;

			// 入参校验：空 task 的派发在任何 profile 下都是调用方 bug
			// （同时封死 review 指出的绕过面：空字符串 task 不再进入派发分支）。
			if (p.task !== undefined && !String(p.task ?? "").trim()) {
				return { content: [{ type: "text", text: "⛔ task 不能为空字符串" }], isError: true };
			}
			if (Array.isArray(p.tasks)) {
				if (p.tasks.length === 0) {
					return { content: [{ type: "text", text: "⛔ tasks 不能为空数组" }], isError: true };
				}
				for (const t of p.tasks) {
					if (!String(t?.task ?? "").trim()) {
						return { content: [{ type: "text", text: "⛔ tasks 每项必须有非空 task" }], isError: true };
					}
				}
			}

			// trace-fusion C4：trace worker 委派硬 guard（设计稿 §55）——只允许 agent="searcher"，
			// agent omitted 必须拒绝（omitted 会变成 unrestricted child）。status 查询不属委派，放行。
			if (isTraceWorker() && (p.task || p.tasks)) {
				const requested: string[] = Array.isArray(p.tasks)
					? p.tasks.map((t: { agent?: string }) => t?.agent ?? "")
					: [typeof p.agent === "string" ? p.agent : ""];
				const verdict = assertDelegationAllowed(requested, "trace-worker");
				if (!verdict.ok) {
					return { content: [{ type: "text", text: `⛔ trace worker 委派被拒：${verdict.reason}` }], isError: true };
				}
				// §12：trace worker 派 searcher 时强制窄工具面（read/bash），调用方不得覆盖——
				// searcher 只收集证据，不实现。
				if (Array.isArray(p.tasks)) {
					for (const t of p.tasks) t.tools = ["read", "bash"];
				} else {
					p.tools = ["read", "bash"];
				}
			}

			if (p.action === "status") {
				const runs = listAsyncRuns();
				// L3 status 默认会话隔离（2026-09-23）：无参只返回本会话派发的 run（按时间最新的一个）；
				// 跨会话查看须显式带 runId（全局查找不变）。归属判定复用 async-result-watcher 范式：
				// links 首个可信 async 记录的 sessionId 与 sessionScopeKey()/getCurrentSessionId() 任一相等即放行。
				let target: AsyncRunRecord | undefined;
				if (p.runId) {
					target = runs.find((r) => r.id === p.runId);
					if (!target) return { content: [{ type: "text", text: `Run ${p.runId} not found` }] };
				} else {
					const myIds = new Set(
						[sessionScopeKey(), getCurrentSessionId()].filter((v): v is string => !!v),
					);
					let links: ReturnType<typeof listLinks> = [];
					try { links = listLinks(); } catch { links = []; }
					const dispatcherOf = (runId: string): string | undefined => {
						for (const link of links) {
							if (link.kind !== "async" || link.targetId !== runId) continue;
							if (link.sessionId && link.sessionId !== "unknown") return link.sessionId;
						}
						return undefined;
					};
					target = runs.filter((r) => {
						const d = dispatcherOf(r.id);
						return d !== undefined && myIds.has(d);
					})[0];
					if (!target) return { content: [{ type: "text", text: "No async runs for this session yet" }] };
				}
				return {
					content: [{ type: "text", text: [
						`Run: ${target.id}`,
						`Agent: ${target.agent ?? "(none)"}`,
						(target.result?.requestedModel ?? target.result?.model ?? target.model) ? `Model: ${target.result?.requestedModel ?? target.result?.model ?? target.model}` : null,
						`Task: ${target.task}`,
						target.cwd ? `CWD: ${target.cwd}` : null,
						`Status: ${target.status}`,
						target.result ? `Output: ${target.result.text.slice(0, 500)}` : null,
						target.result?.usage ? `Tokens: ↑${target.result.usage.input} ↓${target.result.usage.output} $${target.result.usage.cost.toFixed(4)}` : null,
					].filter(Boolean).join("\n") }],
				};
			}

			// L3 parallel 缺省异步（2026-09-23）：p.async !== false（缺省/true）时每个 subtask 走与单发
			// 完全同构的异步派发——写 RUNS_DIR 记录（status running + startedAt + resolveSubagentCwd）+
			// recordLink（kind async + sessionIdentity）+ 刷新 panel，然后 .then 回写终态；立返 runId 列表。
			// concurrency 在异步 fan-out 下无限流语义，忽略（见 description）。显式 async:false 才走下面的阻塞分支。
			if (p.tasks && Array.isArray(p.tasks) && p.async !== false) {
				const tasks = p.tasks as TaskInput[];
				if (!existsSync(RUNS_DIR)) mkdirSync(RUNS_DIR, { recursive: true });
				const asyncSid = sessionIdentity(_ctx as never);
				bindAsyncPanelUi((_ctx as { ui?: ExtensionCommandContext["ui"] })?.ui);
				const asyncRunIds: string[] = [];
				const asyncLines: string[] = [];
				tasks.forEach((t, idx) => {
					const agentDef = t.agent ? agents.find((a) => a.name === t.agent) ?? null : null;
					const label = agentDef?.name ?? t.agent ?? `task-${idx + 1}`;
					const runId = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}${idx.toString(36)}`;
					asyncRunIds.push(runId);
					const effModel = t.model ?? agentDefaultModel(agentDef);
					if (t.agent && !agentDef) {
						const record: AsyncRunRecord = { id: runId, agent: t.agent, task: t.task ?? "", model: effModel, status: "failed", startedAt: new Date().toISOString(), cwd: t.cwd ? resolveSubagentCwd(t.cwd) : undefined,
							result: { status: "failed", text: "", usage: emptyUsageSummary(), usageEvents: [], runId, error: `unknown agent: ${t.agent}`, agent: t.agent } };
						writeFileSync(join(RUNS_DIR, `${runId}.json`), JSON.stringify(record));
						recordLink({ sessionId: asyncSid, kind: "async", targetId: runId, detail: `parallel[${idx}] agent=${t.agent} unknown` });
						asyncLines.push(`${runId} [${label}] failed: unknown agent: ${t.agent}`);
						return;
					}
					const record: AsyncRunRecord = { id: runId, agent: agentDef?.name ?? t.agent, task: t.task ?? "", model: effModel, status: "running", startedAt: new Date().toISOString(), cwd: t.cwd ? resolveSubagentCwd(t.cwd) : undefined };
					writeFileSync(join(RUNS_DIR, `${runId}.json`), JSON.stringify(record));
					recordLink({ sessionId: asyncSid, kind: "async", targetId: runId, detail: `parallel[${idx}] agent=${label} ${String(t.task ?? "").slice(0, 60)}` });
					runWithFallback(agentDef, t.task ?? "", t.systemPrompt, t.model, t.timeoutMs, undefined, undefined, { cwd: t.cwd, tools: t.tools, excludeTools: t.excludeTools }).then((result) => {
						record.status = result.status; record.result = result;
						recordUsage(agentDef?.name, result);
						writeFileSync(join(RUNS_DIR, `${runId}.json`), JSON.stringify(record));
						refreshAsyncPanel();
						notifyAsyncCompletion({ id: runId, agent: agentDef?.name, task: t.task ?? "", status: result.status, result: { error: result.error, usage: result.usage }, startedAt: record.startedAt });
					});
					asyncLines.push(`${runId} [${label}] running`);
				});
				refreshAsyncPanel();
				return { content: [{ type: "text", text: `Async parallel started: ${asyncRunIds.length} task(s)\n${asyncLines.map((l) => `  ${l}`).join("\n")}\nCheck with: subagent-win({ action: "status", runId: "<runId>" })` }] };
			}

			if (p.tasks && Array.isArray(p.tasks) && p.async === false) {
				const tasks = p.tasks as TaskInput[];
				const results = await runParallel(tasks, p.concurrency ?? 3, agents, signal,
					onUpdate ? (msg, _d) => onUpdate({ content: [{ type: "text", text: msg }] }) : undefined,
				);
				for (const r of results) recordUsage(r.agent, r);
				const parts = results.map(function(r, i) {
					var icon = r.status === "completed" ? "\u2713" : "\u2717";
					var body =
						r.status === "completed"
							? (r.text || "(no output)")
							: formatFailureForMainAgent(r, r.triedModels);
					var effModel = r.requestedModel ?? r.model ?? "(default)";
					return "### " + icon + " " + (r.agent || "task-" + (i + 1)) + "/" + effModel + " (" + r.status + ")\n\n" + body;
				});
				var okCount = results.filter(function(r) { return r.status === "completed"; }).length;
				var failed = results.filter(function(r) { return r.status === "failed"; });
				var usageCaps = failed.filter(function(r) {
					return r.error && classifyModelFailure(r.error, r.requestedModel ?? r.model).kind === "usage_cap";
				});
				var header =
					"Parallel: " + okCount + "/" + results.length + " succeeded";
				if (usageCaps.length > 0) {
					header +=
						"\n\n[subagent-failure kind=USAGE_CAP] " +
						usageCaps.length +
						" task(s) hit package/usage cap. ACTION_REQUIRED (main agent): switch main session model via /model to a higher-tier/different provider, then retry failed tasks with model= override (avoid tried_models)." ;
				}
				return {
					content: [{ type: "text", text: header + "\n\n" + parts.join("\n\n---\n\n") }],
					details: { results },
					isError: failed.length > 0 && okCount === 0,
				};
			}

			// 默认异步（用户 2026-09-22 指令）：只认「显式 false」为同步，其余（缺省/true）一律非阻塞。
			// 动机：把「默认非阻塞」落到工具实现，而不是只靠提示词约束调用方（模型漏传 async 时旧实现会静默阻塞）。
			if (p.async !== false) {
				const runId = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
				if (!existsSync(RUNS_DIR)) mkdirSync(RUNS_DIR, { recursive: true });
				const record: AsyncRunRecord = { id: runId, agent: p.agent, task: p.task ?? "", status: "running", startedAt: new Date().toISOString(), cwd: p.cwd ? resolveSubagentCwd(p.cwd) : undefined };
				writeFileSync(join(RUNS_DIR, `${runId}.json`), JSON.stringify(record));
				// 溯源：记录「本会话唤起了这个异步子 agent」
				recordLink({
					sessionId: sessionIdentity(_ctx as never),
					kind: "async",
					targetId: runId,
					detail: `agent=${p.agent ?? "subagent"} ${String(p.task ?? "").slice(0, 60)}`,
				});
				const agentDef = p.agent ? agents.find((a) => a.name === p.agent) ?? null : null;
				// L3 Model 披露（纯加法）：dispatch 时把 effective model 写入记录，供 status 的 Model: 行展示。
				if (!record.model) { try { record.model = resolveCallModel(p.model, agentDef) ?? undefined; } catch { /* 保持无 model */ } writeFileSync(join(RUNS_DIR, `${runId}.json`), JSON.stringify(record)); }
				// 方案 B：面板可视化 —— 绑定当前 UI，派发即刷新（opencode 风格常驻任务列表）
				bindAsyncPanelUi((_ctx as { ui?: ExtensionCommandContext["ui"] })?.ui);
				refreshAsyncPanel();
				runWithFallback(agentDef, p.task ?? "", p.systemPrompt, p.model, p.timeoutMs, undefined, undefined, { cwd: p.cwd, tools: p.tools, excludeTools: p.excludeTools }).then((result) => {
					record.status = result.status; record.result = result;
					recordUsage(agentDef?.name, result);
					writeFileSync(join(RUNS_DIR, `${runId}.json`), JSON.stringify(record));
					// 方案 B：完成时刷新面板 + toast 通知
					refreshAsyncPanel();
					notifyAsyncCompletion({ id: runId, agent: agentDef?.name, task: p.task ?? "", status: result.status, result: { error: result.error, usage: result.usage }, startedAt: record.startedAt });
				});
				return { content: [{ type: "text", text: `Async run started: ${runId}\nCheck with: subagent-win({ action: "status", runId: "${runId}" })` }] };
			}

			if (p.task) {
				const agentDef = p.agent ? agents.find((a) => a.name === p.agent) ?? null : null;
				if (p.agent && !agentDef) {
					return { content: [{ type: "text", text: `Unknown agent "${p.agent}". Available: ${agents.map((a) => a.name).join(", ")}` }], isError: true };
				}
				const cb = onUpdate ? (s: string, t: string) => onUpdate({ content: [{ type: "text", text: s + " " + t }] }) : undefined;
				const result = await runWithFallback(agentDef, p.task, p.systemPrompt, p.model, p.timeoutMs, signal, cb, { cwd: p.cwd, tools: p.tools, excludeTools: p.excludeTools });
				recordUsage(agentDef?.name, result);
				const fallbackBits = result.priorFailures?.length
					? result.priorFailures.map((f) => `${f.model}(${f.kind}: ${String(f.error).replace(/\s+/g, " ").slice(0, 120)})`).join(" | ")
					: null;
				const modelBits = [
					result.requestedModel ? `requested=${result.requestedModel}` : null,
					result.model && result.model !== result.requestedModel ? `reported=${result.model}` : null,
					p.model ? "source=call-override" : "source=agent-default",
					result.triedModels?.length ? `tried=${result.triedModels.join(",")}` : null,
					fallbackBits ? `fallback_from=${fallbackBits}` : null,
				].filter(Boolean).join(" ");
				const fallbackHint = result.priorFailures?.length
					? `⚠ Requested model failed and a fallback was used: ${fallbackChainText(result)}\n`
					: "";
				const modelLine = (modelBits || fallbackHint) ? `[subagent ${modelBits}]\n\n${fallbackHint}` : "";
				// L3 模型披露（纯加法）：Agent:/Model: 头——Model 取实际跑起来的 requestedModel（含 default 回退链）。
				let headerResolve: string | undefined;
				try { headerResolve = resolveCallModel(p.model, agentDef); } catch { headerResolve = undefined; }
				const effectiveModel = result.requestedModel ?? result.model ?? headerResolve ?? "(default)";
				const identityHeader = `Agent: ${agentDef?.name ?? p.agent ?? "(none)"}\nModel: ${effectiveModel}\n\n`;
				// Timeout may still leave partial text; surface it instead of empty "(no output)".
				if (result.status === "completed") {
					return { content: [{ type: "text", text: identityHeader + modelLine + (result.text || "(no output)") }], details: { result } };
				}
				// Failed: structured error for main agent (usage cap → switch higher-tier model).
				const body = formatFailureForMainAgent(result, result.triedModels);
				return { content: [{ type: "text", text: identityHeader + modelLine + body }], isError: true, details: { result } };
			}

			return { content: [{ type: "text", text: "Invalid params" }], isError: true };
		},
	});

	// ── /agents 命令 ──
	pi.registerCommand("agents", {
		description: "列出可用 agent",
		handler: async (_args, ctx) => {
			if (agents.length === 0) { ctx.ui.notify("No agents found", "warning"); return; }
			ctx.ui.notify(`Available agents:\n${agents.map((a) => `${a.name} — ${a.description ?? ""}`).join("\n")}`, "info");
		},
	});

	// ── /runs 命令 ──
	pi.registerCommand("runs", {
		description: "列出异步运行记录",
		handler: async (_args, ctx) => {
			const runs = listAsyncRuns().slice(0, 10);
			if (runs.length === 0) { ctx.ui.notify("No async runs", "info"); return; }
			ctx.ui.notify(`Recent runs:\n${runs.map((r) => `${r.id} | ${r.agent ?? "-"} | ${r.status} | ${r.task.slice(0, 60)}`).join("\n")}`, "info");
		},
	});

	// ── /links 命令：会话溯源（哪个会话唤起了哪些任务）──
	pi.registerCommand("links", {
		description: "查看会话溯源：哪个会话唤起了哪些 tab/异步子 agent/计时器",
		handler: async (args, ctx) => {
			const links = listLinks();
			if (links.length === 0) { ctx.ui.notify("No links recorded yet", "info"); return; }
			const filter = (args ?? "").trim();
			const filtered = filter ? links.filter((l) => l.sessionId.includes(filter) || l.kind === filter || l.targetId.includes(filter)) : links;
			if (filtered.length === 0) { ctx.ui.notify(`No links matching "${filter}"`, "info"); return; }
			const lines = filtered.slice(0, 20).map((l) => `${l.at.slice(11, 19)} [${l.sessionId.slice(0, 12)}] ${l.kind} ${l.targetId}: ${l.detail.slice(0, 50)}`);
			ctx.ui.notify(`Links (${filtered.length}):\n${lines.join("\n")}`, "info");
		},
	});

	// ── /today-usage 命令 ──
	// Aggregates ALL sessions + subagent runs for the local calendar day.
	pi.registerCommand("today-usage", {
		description: "查看今日 token 用量总计（本地日全部 session + subagent）",
		handler: async (_args, ctx) => {
			const day = localDayBounds();
			const subTotal = collectSubagentUsage(day);
			// FIXED: now aggregates ALL sessions (root ~/.pi/agent/sessions/) instead of current project only
			const main = collectMainSessionUsage(day, DEFAULT_SESSIONS_ROOT);
			const mainTotal = main.total;

			const grandModelBuckets = new Map<string, UsageBucket>();
			mergeModelBuckets(grandModelBuckets, subTotal.byModel);
			mergeModelBuckets(grandModelBuckets, mainTotal.byModel);

			const grandTotal = {
				input: subTotal.input + mainTotal.input,
				output: subTotal.output + mainTotal.output,
				cacheRead: subTotal.cacheRead + mainTotal.cacheRead,
				cacheWrite: subTotal.cacheWrite + mainTotal.cacheWrite,
				cost: subTotal.cost + mainTotal.cost,
			};
			const tokenTotal = (usage: Pick<UsageSummary, "input" | "output" | "cacheRead" | "cacheWrite">) =>
				usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
			const modelNameWidth = Math.min(32, Math.max(8, ...[...grandModelBuckets.keys()].map((k) => k.length), 0));
			const modelLines = [...grandModelBuckets.entries()]
				.sort((a, b) => tokenTotal(b[1]) - tokenTotal(a[1]))
				.map(([model, bucket]) =>
					`\n  ${model.padEnd(modelNameWidth)}  ${tokenTotal(bucket).toLocaleString()} tokens  ${bucket.turns.toLocaleString()} turns  $${bucket.cost.toFixed(4)}`).join("");
			const usageLines = (usage: UsageSummary) =>
				`\n  ↑ ${usage.input.toLocaleString()} input` +
				`\n  ↓ ${usage.output.toLocaleString()} output` +
				`\n  ↻ ${usage.cacheRead.toLocaleString()} cache read` +
				`\n  ↻ ${usage.cacheWrite.toLocaleString()} cache write` +
				`\n  Σ ${tokenTotal(usage).toLocaleString()} total tokens` +
				`\n  💰 $${usage.cost.toFixed(4)}`;

			ctx.ui.notify(
				`Today token usage (${day.label}, local day)\n` +
				`\n=== Subagent runs (${subTotal.count} runs, ${subTotal.turns} turns) ===` + usageLines(subTotal) +
				`\n=== Main sessions (${main.sessionCount} sessions, ${main.sessionsWithUsage} with usage, ${mainTotal.turns} turns) ===` + usageLines(mainTotal) +
				`\n=== Total ===` + usageLines({ ...grandTotal, turns: 0 }) +
				`\n  by model:` + modelLines,
				"info",
			);
		},
	});

	// ── /sub-models 命令 ──
	// 用法:
	//   /sub-models                         查看当前 agent 模型配置
	//   /sub-models searcher provider/id    设置单个 agent 模型
	//   /sub-models searcher thinking high  设置单个 agent thinking
	//   /sub-models searcher fallback a,b  设置 fallback 链
	//   /sub-models searcher fallback clear  清除 fallback
	//   /sub-models set searcher=... planner=...  批量设置模型
	pi.registerCommand("sub-models", {
		description: "查看/设置 subagent 各 agent 的 model、fallback 和 thinking",
		handler: async (args, ctx) => {
			const text = (args ?? "").trim();
			const cfg = reloadConfig();

			const names = [...new Set([
				...agents.map((a) => a.name),
				...Object.keys(cfg.models),
				...Object.keys(cfg.fallbackModels),
				...Object.keys(cfg.thinking),
			])].sort();

			// 交互模式：先选 agent，再从 pi 原生模型注册表中选择模型。
			// /sub-models <agent> 也可以直接进入指定 agent 的模型选择。
			const interactiveAgent = !text || (names.includes(text) && text.split(/\s+/).length === 1);
			if (interactiveAgent && ctx.hasUI) {
				if (names.length === 0) {
					ctx.ui.notify("No agents configured", "warning");
					return;
				}

				let agentName: string | undefined = text || undefined;
				if (!agentName) {
					const agentLabels = names.map((name) =>
						`${name}  [${cfg.models[name] ?? "pi default"}; fallback: ${(cfg.fallbackModels[name] ?? []).join(", ") || "none"}; thinking: ${cfg.thinking[name] ?? "default"}]`,
					);
					const selectedAgent = await ctx.ui.select("Choose subagent:", agentLabels);
					if (!selectedAgent) return;
					agentName = names[agentLabels.indexOf(selectedAgent)];
				}
				if (!agentName) return;

				const allModels = ctx.modelRegistry.getAvailable()
					.slice()
					.sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));
				const externalOpts = listExternalCliModelOptions();
				// Labels layout:
				//   [0] pi default
				//   [1..E] external CLI backends (cli:claude / cli:codex / cli:agy / cli:atomcode / cli:zcode)
				//   [E+1..] registry models
				const modelLabels = [
					`(use pi default)  [current: ${cfg.models[agentName] ?? "default"}]`,
					...externalOpts.map((opt) => {
						const current = cfg.models[agentName] === opt.ref ? " ✓ current" : "";
						return `${opt.label}${current}`;
					}),
					...allModels.map((model) => {
						const ref = `${model.provider}/${model.id}`;
						const detail = model.name && model.name !== model.id ? ` — ${model.name}` : "";
						const current = cfg.models[agentName] === ref ? " ✓ current" : "";
						return `${ref}${detail}${current}`;
					}),
				];
				if (allModels.length === 0 && externalOpts.length === 0) {
					ctx.ui.notify("No models available. Check /model or models.json.", "error");
					return;
				}
				const selectedModel = await searchableSelect(
					ctx,
					`Choose model for ${agentName} (external CLI first, then pi providers):`,
					modelLabels,
				);
				if (!selectedModel) return;
				if (selectedModel === modelLabels[0]) {
					delete cfg.models[agentName];
				} else {
					const selectedIndex = modelLabels.indexOf(selectedModel);
					// 1..externalOpts.length → external CLI
					if (selectedIndex >= 1 && selectedIndex <= externalOpts.length) {
						cfg.models[agentName] = externalOpts[selectedIndex - 1].ref;
					} else {
						const modelIndex = selectedIndex - 1 - externalOpts.length;
						const model = allModels[modelIndex];
						if (!model) return;
						cfg.models[agentName] = `${model.provider}/${model.id}`;
					}
				}
				// A fallback identical to the primary can never run; remove it before presenting choices.
				if (cfg.models[agentName]) {
					const fallbacks = (cfg.fallbackModels[agentName] ?? []).filter((ref) => ref !== cfg.models[agentName]);
					if (fallbacks.length > 0) cfg.fallbackModels[agentName] = fallbacks;
					else delete cfg.fallbackModels[agentName];
				}
				writeConfig(cfg);
				reloadConfig();

				// Choose one interactive fallback immediately after the primary model. Advanced
				// comma-separated fallback chains remain available through the text command.
				const primaryModel = cfg.models[agentName];
				const currentFallbacks = cfg.fallbackModels[agentName] ?? [];
				const fallbackExternal = externalOpts.filter((opt) => opt.ref !== primaryModel);
				const fallbackModels = allModels.filter((model) => `${model.provider}/${model.id}` !== primaryModel);
				const fallbackLabels = [
					`(no fallback)  [current: ${currentFallbacks.join(", ") || "none"}]`,
					...fallbackExternal.map((opt) => {
						const current = currentFallbacks.includes(opt.ref) ? " ✓ current" : "";
						return `${opt.label}${current}`;
					}),
					...fallbackModels.map((model) => {
						const ref = `${model.provider}/${model.id}`;
						const detail = model.name && model.name !== model.id ? ` — ${model.name}` : "";
						const current = currentFallbacks.includes(ref) ? " ✓ current" : "";
						return `${ref}${detail}${current}`;
					}),
				];
				const selectedFallback = await searchableSelect(ctx, `Choose fallback model for ${agentName}:`, fallbackLabels);
				if (selectedFallback) {
					if (selectedFallback === fallbackLabels[0]) {
						delete cfg.fallbackModels[agentName];
					} else {
						const selectedIndex = fallbackLabels.indexOf(selectedFallback);
						if (selectedIndex >= 1 && selectedIndex <= fallbackExternal.length) {
							cfg.fallbackModels[agentName] = [fallbackExternal[selectedIndex - 1].ref];
						} else {
							const fallbackIndex = selectedIndex - 1 - fallbackExternal.length;
							const fallback = fallbackModels[fallbackIndex];
							if (fallback) cfg.fallbackModels[agentName] = [`${fallback.provider}/${fallback.id}`];
						}
					}
					writeConfig(cfg);
					reloadConfig();
				}

				const thinkingChoices = ["(keep current)", "off", "minimal", "low", "medium", "high", "xhigh", "max"];
				const selectedThinking = await ctx.ui.select(
					`Thinking level for ${agentName}:`,
					thinkingChoices.map((level) => level === "(keep current)" ? `${level} [${cfg.thinking[agentName] ?? "default"}]` : level),
				);
				if (selectedThinking && !selectedThinking.startsWith("(keep current)")) {
					cfg.thinking[agentName] = selectedThinking;
					writeConfig(cfg);
				}
				ctx.ui.notify(
					`${agentName}: model=${cfg.models[agentName] ?? "pi default"}, fallbacks=${(cfg.fallbackModels[agentName] ?? []).join(", ") || "none"}, thinking=${cfg.thinking[agentName] ?? "default"}`,
					"info",
				);
				return;
			}

			// 无 UI（例如 print 模式）时保留文本查看方式。
			if (!text) {
				if (names.length === 0) {
					ctx.ui.notify("No agents configured", "warning");
					return;
				}
				const lines = names.map((name) => `${name.padEnd(16)} model=${cfg.models[name] ?? "(default)"}  fallback=${(cfg.fallbackModels[name] ?? []).join(",") || "(none)"}  thinking=${cfg.thinking[name] ?? "(default)"}`);
				ctx.ui.notify(`Subagent models (config.json):\n${lines.join("\n")}\nUse /sub-models in TUI to choose interactively.`, "info");
				return;
			}

			// 批量: /sub-models set searcher=x planner=y
			if (text.startsWith("set ")) {
				const pairs = text.slice(4).trim().split(/\s+/).filter(Boolean);
				const updated: string[] = [];
				for (const pair of pairs) {
					const eq = pair.indexOf("=");
					if (eq <= 0) continue;
					const agent = pair.slice(0, eq).trim();
					const model = pair.slice(eq + 1).trim();
					if (!agent || !model) continue;
					cfg.models[agent] = model;
					updated.push(`${agent}=${model}`);
				}
				if (updated.length === 0) {
					ctx.ui.notify("Usage: /sub-models set searcher=provider/model planner=provider/model", "error");
					return;
				}
				writeConfig(cfg);
				reloadConfig();
				ctx.ui.notify(`Updated:\n${updated.join("\n")}`, "info");
				return;
			}

			// /sub-models <agent> thinking <level>
			// /sub-models <agent> <model>
			const parts = text.split(/\s+/).filter(Boolean);
			const agentName = parts[0];
			if (!agentName) {
				ctx.ui.notify("Usage: /sub-models <agent> <model>", "error");
				return;
			}

			if (parts[1] === "fallback" || parts[1] === "fallbacks") {
				const fallbackValue = parts.slice(2).join(" ").trim();
				if (!fallbackValue) {
					ctx.ui.notify(`${agentName}.fallbacks = ${(cfg.fallbackModels[agentName] ?? []).join(", ") || "(none)"}`, "info");
					return;
				}
				if (fallbackValue === "clear") {
					delete cfg.fallbackModels[agentName];
				} else {
					cfg.fallbackModels[agentName] = [...new Set(fallbackValue.split(",").map((value) => value.trim()).filter(Boolean))];
				}
				writeConfig(cfg);
				reloadConfig();
				ctx.ui.notify(`${agentName}.fallbacks = ${(cfg.fallbackModels[agentName] ?? []).join(", ") || "(none)"}`, "info");
				return;
			}

			if (parts[1] === "thinking") {
				const level = parts[2];
				if (!level) {
					ctx.ui.notify("Usage: /sub-models <agent> thinking <off|low|medium|high|xhigh>", "error");
					return;
				}
				cfg.thinking[agentName] = level;
				writeConfig(cfg);
				reloadConfig();
				ctx.ui.notify(`${agentName}.thinking = ${level}`, "info");
				return;
			}

			const model = parts.slice(1).join(" ").trim();
			if (!model) {
				const currentModel = cfg.models[agentName] ?? "(default)";
				const currentThinking = cfg.thinking[agentName] ?? "(default)";
				ctx.ui.notify(`${agentName}: model=${currentModel} thinking=${currentThinking}`, "info");
				return;
			}

			cfg.models[agentName] = model;
			writeConfig(cfg);
			reloadConfig();
			ctx.ui.notify(`${agentName}.model = ${model}`, "info");
		},
	});

	// ── /sub-presets 命令（模型预设槽位，逻辑在 model-presets.ts）──
	registerSubPresetsCommand(pi, { reloadConfig, writeConfig });

	// ── /notify on|off 命令 ──
	pi.registerCommand("notify", {
		description: "Windows 通知开关（/notify on 或 /notify off）",
		handler: async (args, ctx) => {
			const val = (args ?? "").trim().toLowerCase();
			const cfg = reloadConfig();
			if (val === "on") {
				cfg.notifications = true;
				writeConfig(cfg);
				ctx.ui.notify("🪟 Windows 通知已开启", "info");
			} else if (val === "off") {
				cfg.notifications = false;
				writeConfig(cfg);
				ctx.ui.notify("🪟 Windows 通知已关闭", "info");
			} else {
				const status = cfg.notifications !== false ? "🟢 已开启" : "🔴 已关闭";
				ctx.ui.notify(
					`🪟 Windows 通知：${status}\n用法：/notify on 或 /notify off`,
					"info",
				);
			}
		},
	});

	// ── /searcher-mode 命令 ──
	pi.registerCommand("searcher-mode", {
		description: "searcher 派发模式：auto / serial / parallel",
		handler: async (args, ctx) => {
			const val = (args ?? "").trim().toLowerCase();
			const cfg = reloadConfig();
			if (val === "auto" || val === "serial" || val === "parallel") {
				cfg.searcherMode = val;
				writeConfig(cfg);
				const labels: Record<string, string> = { auto: "🤖 自动（orchestrator 判断）", serial: "🔗 串行（逐个派发）", parallel: "⚡ 并行（并发派发）" };
				ctx.ui.notify(`🔍 searcher 模式已设为：${labels[val]}`, "info");
			} else {
				const current = cfg.searcherMode ?? "auto";
				const labels: Record<string, string> = { auto: "🤖 自动", serial: "🔗 串行", parallel: "⚡ 并行" };
				ctx.ui.notify(
					`当前 searcher 模式：${labels[current] ?? current}\n` +
					`用法：/searcher-mode <auto|serial|parallel>\n` +
					`  auto     — orchestrator 根据模型上下文和任务自行决定串/并行\n` +
					`  serial   — 逐个派发 searcher（适合 GPU 资源有限的本地模型）\n` +
					`  parallel — 并发派发所有 searcher（速度优先）`,
					"info",
				);
			}
		},
	});

	// ── /lite 命令（轻量工作流模式，逻辑在 lite-mode.ts）──
	registerLiteCommand(pi, { reloadConfig, writeConfig });

	// ── /launch 命令（只允许主会话）──
	if (!canOrchestrateTabs) {
		// 标签页 / 子 agent：跳过 /launch 命令（防止孙 tab 派发）
	} else {
	pi.registerCommand("launch", {
		description: "编排可见 pi 标签页；/launch -t <标题> 或 --direct 才直接启动单个任务",
		handler: async (args, ctx) => {
			// C4 运行时防护（设计稿 §59）：不依赖 factory 阶段注册与否，handler 内再验一次。
			if (!capabilities().launchTabs) {
				ctx.ui.notify("⛔ 当前会话无标签页编排权限（launch-tabs 只属于主会话）", "error");
				return;
			}
			const request = parseLaunchRequest(args ?? "");
			if (!request.task) {
				ctx.ui.notify("用法: /launch [--model <模型>] <编排请求>；单任务用 /launch -t <标题> <任务> 或 --direct <任务>", "error");
				return;
			}

			// Natural-language /launch is deliberately a turn for the current agent.
			// It has the full conversation (where the ready task IDs live), unlike a
			// fresh terminal tab. The agent must call launch-tabs after analyzing it.
			if (!request.direct) {
				const modelHint = request.model
					? `\n用户指定新 pi 会话模型为 \"${request.model}\"；只有在 launch-tabs 的每项需要时传入该 model。`
					: "";
				const modeHint = request.execute || request.research || request.adaptive
					? `\n用户请求为${request.execute ? "快速执行模式（--execute）：结论/方案已明确，跳过搜索与计划" : request.research ? "深度研究模式（--research）：只要结论不要实现" : "自适应模式（--adaptive）：tab 启动时按任务书信息完备度自评链深 A0自执行快链/A快链/B中链/C全链"}。把对应任务在 launch-tabs 里传 mode: ${request.execute ? "\"execute\"" : request.research ? "\"research\"" : "\"adaptive\""}；这些标签页将以 ${request.execute ? "`根据execute进行工作<taskId>`" : request.research ? "`根据research进行工作<taskId>`" : "`根据adaptive进行工作<taskId>`"} 启动，只做${request.execute ? "实现 → 审查 → Wiki 收尾" : request.research ? "并行搜索 + 研究报告 + Wiki 维护" : "启动自评链深后按对应档位执行（自适应）"}。`
					: "";
				pi.sendUserMessage([
					"这是一个 /launch workflow 编排请求，不要把这句话直接作为新标签页任务。",
					`用户请求：${request.task}`,
					modelHint,
					modeHint,
					"请先分析当前会话上下文，找出用户明确表示启动条件已满足、且彼此独立的任务。",
					"对每个任务调用 launch-tabs；一次调用提交全部任务以并行打开标签页。",
					"每项必须有准确的 taskId（例如 1007）、具体且可执行的首轮 prompt，并保留 workflow 的 Wiki/plan/审查交接；不要把未满足条件的任务启动。",
					"launch-tabs 会确保每个首轮 prompt 以 `根据workflow进行工作<taskId>` 开头并附带 workflow-orchestrator 强制约束块（先 read 技能、委派执行、禁止自己一路干完）；任务模式由每项 mode 决定——research（深度研究，前缀 `根据research进行工作<taskId>`，只做并行搜索+研究报告+Wiki 维护）、execute（结论已明确，前缀 `根据execute进行工作<taskId>`，跳过搜索与计划，只做实现+审查+Wiki 收尾）或 adaptive（任务书含根因+方案+文件域+验收标准时用，前缀 `根据adaptive进行工作<taskId>`，tab 启动自评完备度选链深）。若没有足够明确的独立任务，先说明原因，不要开标签页。",
				].filter(Boolean).join("\n"), { deliverAs: "followUp" });
				ctx.ui.notify("🧭 已交给当前 agent 分析；它会在确认任务后通过 launch-tabs 并行打开标签页", "info");
				return;
			}

			const wtPath = findWindowsTerminal();
			if (!wtPath) {
				ctx.ui.notify("❌ 未找到 Windows Terminal (wt.exe)。\n请从 Microsoft Store 安装 Windows Terminal。", "error");
				return;
			}

			let piCli: string;
			try {
				piCli = findPiCli();
			} catch (err) {
				ctx.ui.notify(`❌ 未找到 pi CLI: ${err instanceof Error ? err.message : String(err)}。请设置 PI_CLI_PATH 环境变量。`, "error");
				return;
			}

			// 只有用户显式选择模式时才绑定 workflow 约束。任务编号本身只是业务标识，
			// 不应把普通的单任务启动自动升级成 workflow。
			const taskNum = request.task.match(/\b\d{3,5}\b/)?.[0] ?? "";
			const explicitMode = request.execute || request.research || request.adaptive;
			const explicitWorkflowPrefix = /根据(?:workflow|research|execute|adaptive)进行工作\s*\d{3,5}/.test(request.task);
			const workflowBound = explicitMode || explicitWorkflowPrefix;
			const skillRef = existsSync(WORKFLOW_SKILL_FILE) ? WORKFLOW_SKILL_FILE : undefined;
			const skillArgs = existsSync(WORKFLOW_SKILL_ROOT) ? [WORKFLOW_SKILL_ROOT] : undefined;
			const mode: LaunchMode = request.execute ? "execute" : request.research ? "research" : request.adaptive ? "adaptive" : "workflow";
			const prompt = workflowBound
				? buildWorkflowTabPrompt({ taskId: taskNum, title: request.title, prompt: request.task, model: request.model }, skillRef, mode)
				: request.task;
			const boundTitle = launchTaskTitle({ taskId: workflowBound ? taskNum : "", title: request.title, prompt, model: request.model }, request.cwd ?? process.cwd());

			// 修复 2026-08-11：直开标签页也要有身份（runId + 派发账本）。
			// 此前 /launch 不带 runId → 标签页是无身份进程 → 会抢 root(self) timer、
			// 且不能用 tab-report（回报通道要求 runId）。
			const directRunId = newTabRunId();
			const directCwd = request.cwd ?? process.cwd();
			const directDispatch: TabDispatchRecord = {
				id: directRunId,
				version: 1,
				taskId: workflowBound ? taskNum : "",
				mode,
				title: boundTitle,
				cwd: directCwd,
				requestedModel: request.model,
				dispatchedAt: new Date().toISOString(),
				dispatchStatus: "dispatched",
				direct: true,
			};
			writeTabDispatch(defaultTabRunsDir(), directDispatch);
			// Phase 1 shadow emit（设计稿 §11）
			emitRuntimeEventOnce(tabDispatchToRuntimeEvent(directDispatch));

			const result = dispatchPiTab(wtPath, piCli, directCwd, boundTitle, prompt, request.model, workflowBound ? skillArgs : undefined, directRunId, defaultTabRunsDir(), (err) => {
				// terra 裁决缺陷 2：直开路径也要在异步 spawn 失败时回写 launch_failed
				//（否则 journal 永远只有 dispatched，Phase 2 投影为非终态）
				const failed = { ...directDispatch, dispatchStatus: "launch_failed" as const, error: err.message };
				writeTabDispatch(defaultTabRunsDir(), failed);
				emitRuntimeEventOnce(tabDispatchToRuntimeEvent(failed));
			});
			if (result.error) {
				const failed = { ...directDispatch, dispatchStatus: "launch_failed" as const, error: result.error };
				writeTabDispatch(defaultTabRunsDir(), failed);
				emitRuntimeEventOnce(tabDispatchToRuntimeEvent(failed));
				ctx.ui.notify(`❌ 启动失败: ${result.error}`, "error");
				return;
			}
			const modelHint = request.model ? ` (model: ${request.model})` : "";
			const modeName = request.execute ? "快速执行" : request.research ? "深度研究" : request.adaptive ? "自适应" : "workflow";
			const boundHint = workflowBound ? ` (workflow 约束已绑定 · ${modeName}模式)` : "";
			ctx.ui.notify(`✅ 已启动标签页 [${boundTitle}]${modelHint}${boundHint}，pi 将在新终端中运行`, "info");
		},
	});
	}

	// ── trace-fusion 工具（2026-09-17）：主会话 agent 自主触发只读诊断 rollout ──
	// 与 /trace-fusion-loop 命令同一套 launchTraceRun，但强制 diagnose 模式（零磁盘代价、
	// 零主仓库写入）；implement（worktree 读写）仅保留给人丁命令。lane tab 看不到本工具
	// （TRACE_WORKER_EXCLUDE_TOOLS）+ execute 内 capabilities 运行时二次校验。
	pi.registerTool({
		name: "trace-fusion",
		label: "Trace Fusion (diagnose)",
		description: [
			"主会话专属：对当前仓库启动三路完全独立的只读诊断 rollout（diagnose 模式 trace-fusion）——三个可见 pi 标签页各自独立诊断同一个任务，产出三份诊断+推进方案（trajectory），完成后自动收集，交本会话融合。",
			"适用：任务明显困难/根因不明/单一轨迹置信度低/值得 test-time scaling 时主动使用；简单任务勿用。",
			"成本：三路并行墙钟约 laneWallClockMin（默认 45min），零磁盘零主仓库写入（只读，edit/write 对 lane 禁用）。",
			"发起后立即可继续其它工作；三路全部完成后系统自动后台收集并通知你，届时读 runDir/lanes/{A,B,C}/trajectory.md 做融合（一致根因→高置信；分歧→仲裁）后单次实现。",
			"只允许主会话调用；同一时刻仅允许一个 active run（并发启动会被 preflight 拒绝）。",
		].join(" "),
		parameters: Type.Object({
			task: Type.String({ description: "任务描述（三路逐字相同）：要诊断/推进的具体问题，应包含足够上下文让独立诊断可执行" }),
		}),
		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			if (!capabilities().launchTabs) {
				return { content: [{ type: "text", text: "trace-fusion 只允许主会话调用。" }], isError: true };
			}
			const params = rawParams as { task?: string };
			const task = (params.task ?? "").trim();
			if (!task) {
				return { content: [{ type: "text", text: "task 不能为空：给出要诊断的具体问题。" }], isError: true };
			}
			let wtExe: string | null;
			let piCli: string;
			try {
				wtExe = findWindowsTerminal();
				piCli = findPiCli();
			} catch (err) {
				return { content: [{ type: "text", text: `启动环境不可用：${err instanceof Error ? err.message : String(err)}` }], isError: true };
			}
			if (!wtExe) {
				return { content: [{ type: "text", text: "未找到 Windows Terminal (wt.exe)，无法启动标签页。" }], isError: true };
			}
			const tfConfig = readTraceFusionConfig();
			// agent 主动触发永远只读：强制 diagnose，忽略 config 里的 implement 档
			const result = launchTraceRun({
				task,
				repoRoot: process.cwd(),
				wtExe,
				piCli,
				config: { ...tfConfig, mode: "diagnose" },
				runsDir: defaultTraceFusionRunsDir(),
			});
			const lines = result.lines ?? [];
			if (!result.ok) {
				return { content: [{ type: "text", text: ["trace-fusion 启动失败：", result.error, ...lines].join("\n") }], isError: true };
			}
			try {
				for (const lane of TRACE_LANES) {
					recordLink({ sessionId: sessionIdentity(ctx as never), kind: "tab", targetId: result.meta.lanes[lane].tabRunId, detail: `trace-fusion ${result.meta.runId} lane=${lane}` });
				}
			} catch { /* 溯源尽力而为 */ }
			const laneIds = TRACE_LANES.map((l) => `${l}=${result.meta.lanes[l].tabRunId}`).join(", ");
			return { content: [{ type: "text", text: [
				`✅ trace-fusion diagnose run 已启动：${result.meta.runId}`,
				...lines,
				`lane tabs: ${laneIds}`,
				"三路完成后自动后台收集（无需干预）；进度 /trace-fusion-status。",
				"完成后：读 ~/.pi/agent/trace-fusion-runs/<runId>/lanes/{A,B,C}/trajectory.md，融合三份诊断（一致根因→高置信；分歧→仲裁）后单次实现。",
			].join("\n") }] };
		},
	});

	// ── /trace-fusion-loop 命令（trace-fusion C6，只允许主会话）──
	// 设计稿 §5.1：主入口。编排 preflight → snapshot → 三 worktree → 三 trace worker tab。
	if (canOrchestrateTabs) {
		pi.registerCommand("trace-fusion-loop", {
			description: "三路独立 trace rollout + 证据融合（/trace-fusion-loop <任务>）",
			handler: async (args, ctx) => {
				// review 修正（Luna critical）：不信任 factory 阶段的 canOrchestrateTabs 布尔，
				// handler 内再验一次能力（profile 时序变化时的兑底防线）。
				if (!capabilities().launchTabs) {
					ctx.ui.notify("⛔ 当前会话无 trace-fusion 启动权限（仅主会话）", "error");
					return;
				}
				const task = (args ?? "").trim();
				if (!task) {
					ctx.ui.notify("用法：/trace-fusion-loop <任务描述>\n将对当前仓库开三个独立 worktree tab 并行求解，完成后证据融合。", "error");
					return;
				}
				let wtExe: string | null;
				let piCli: string;
				try {
					wtExe = findWindowsTerminal();
					piCli = findPiCli();
				} catch (err) {
					ctx.ui.notify(`❌ 启动环境不可用：${err instanceof Error ? err.message : String(err)}`, "error");
					return;
				}
				if (!wtExe) {
					ctx.ui.notify("❌ 未找到 Windows Terminal (wt.exe)。", "error");
					return;
				}
				const tfConfig = readTraceFusionConfig();
				const result = launchTraceRun({
					task,
					repoRoot: process.cwd(),
					wtExe,
					piCli,
					config: tfConfig,
					runsDir: defaultTraceFusionRunsDir(),
				});
				for (const line of result.lines ?? []) ctx.ui.notify(line, "info");
				if (!result.ok) {
					ctx.ui.notify(`❌ trace-fusion 启动失败：${result.error}`, "error");
					return;
				}
				// 溯源：本会话唤起了这三个 lane tab
				try {
					for (const lane of TRACE_LANES) {
						recordLink({ sessionId: sessionIdentity(ctx as never), kind: "tab", targetId: result.meta.lanes[lane].tabRunId, detail: `trace-fusion ${result.meta.runId} lane=${lane}` });
					}
				} catch {
					/* 溯源失败不阻塞 */
				}
				ctx.ui.notify(
					`🧬 run ${result.meta.runId} 已启动：TRACE A/B/C 三路独立求解中。\n` +
					`状态：/trace-fusion-status；中止：/trace-fusion-abort；\n` +
					`lane 时限 ${result.meta.laneWallClockMin}min，超时 lane 判 failed 走 2/3 降级。`,
					"info",
				);
			},
		});

		// ── /trace-fusion-status（§24.1：磁盘是唯一真相源，主会话重启后重建视图）──
		pi.registerCommand("trace-fusion-status", {
			description: "查看 trace-fusion run 状态（从磁盘重建，不依赖内存态）",
			handler: async (_args, ctx) => {
				const runsDir = defaultTraceFusionRunsDir();
				if (!existsSync(runsDir)) {
					ctx.ui.notify("尚无任何 trace-fusion run。", "info");
					return;
				}
				const runs = readdirSync(runsDir, { withFileTypes: true })
					.filter((e) => e.isDirectory())
					.map((e) => {
						try {
							return JSON.parse(readFileSync(join(runsDir, e.name, "meta.json"), "utf8")) as TraceRunMeta;
						} catch {
							return null;
						}
					})
					.filter((m): m is TraceRunMeta => m !== null)
					.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
					.slice(0, 5);
				if (runs.length === 0) {
					ctx.ui.notify("尚无任何 trace-fusion run。", "info");
					return;
				}
				const lines: string[] = [];
				for (const m of runs) {
					lines.push(`📦 ${m.runId} [${m.status}] ${m.task.slice(0, 50)}`);
					lines.push(`   base ${m.baseCommit.slice(0, 12)} · deadline ${m.laneDeadlineAt}`);
					for (const lane of TRACE_LANES) {
						const l = m.lanes[lane];
						const finished = l.tabRunId ? readTabResultFile(defaultTabRunsDir(), l.tabRunId) : null;
						const timedOut = Date.now() > new Date(m.laneDeadlineAt).getTime();
						const artifacts = existsSync(join(m.runDir, "lanes", lane, "patch.diff")) ? "patch✓" : "patch✗";
						lines.push(`   ${lane}: ${finished ? `终态 ${finished.status}` : timedOut ? "⏱ 超时未完成" : "运行中"} · ${artifacts} · ${l.worktree}`);
					}
					for (const f of ["collect.json", "cross-test.json", "cross-test-report.md"]) {
						if (existsSync(join(m.runDir, f))) lines.push(`   产物：${f}`);
					}
				}
				ctx.ui.notify(lines.join("\n"), "info");
			},
		});

		// ── /trace-fusion-collect（review 修正 Luna major：把 C7/C8 接入生产生命周期）──
		// 三路终态（或人工确认）后调用：权威收集 → deterministic cross-test → meta 终态。
		pi.registerCommand("trace-fusion-collect", {
			description: "收集 trace-fusion artifacts 并跑 deterministic cross-test（/trace-fusion-collect [runId]）",
			handler: async (args, ctx) => {
				const raw = (args ?? "").trim();
				const force = /(^|\s)--force(\s|$)/.test(raw);
				const runId = raw.replace(/--force/g, "").trim();
				const runsDir = defaultTraceFusionRunsDir();
				let runDir: string | null = null;
				if (runId) {
					runDir = existsSync(join(runsDir, runId, "meta.json")) ? join(runsDir, runId) : null;
				} else {
					// 默认取最新的 running run，否则最新 run
					const candidates = existsSync(runsDir)
						? readdirSync(runsDir, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(runsDir, e.name, "meta.json"))).map((e) => e.name).sort().reverse()
						: [];
					for (const name of candidates) {
						const m = readTraceRunMeta(join(runsDir, name));
						if (m?.status === "running") { runDir = join(runsDir, name); break; }
					}
					runDir = runDir ?? (candidates[0] ? join(runsDir, candidates[0]) : null);
				}
				if (!runDir) {
					ctx.ui.notify("未找到 trace-fusion run。用法：/trace-fusion-collect [runId]", "error");
					return;
				}
				const meta = readTraceRunMeta(runDir);
				if (!meta) {
					ctx.ui.notify(`run meta 不可读：${runDir}`, "error");
					return;
				}
				const tfConfig = readTraceFusionConfig();
				// review 复核修正（Luna major）：三 lane 未全部终态时拒绝收集（除非 --force）——
				// 运行中的 worker 仍在改 worktree，提前收集会拿到撕裂证据并错误终结 run。
				const pending = TRACE_LANES.filter((lane) => {
					const l = meta.lanes[lane];
					return !(l.tabRunId && readTabResultFile(defaultTabRunsDir(), l.tabRunId));
				});
				if (pending.length > 0 && !force) {
					ctx.ui.notify(
						`⏳ 以下 lane 尚未 tab-finish：${pending.join(", ")}。\n` +
						`等待完成后重试；确要放弃等待并对当前状态出报告，用 /trace-fusion-collect ${meta.runId} --force（后续 lane 的修改不再进入证据）。`,
						"info",
					);
					return;
				}
				ctx.ui.notify(`📦 收集 ${meta.runId} 的 lane artifacts（三段式 patch/叙事/终态）…`, "info");
				const collect = collectRunArtifacts(meta);
				// diagnose 模式（2026-09-17）：不在用户主仓库执行 pooled commands，
				// 落盘跳过型报告 + 违规写入确定性检查
				const matrix = meta.mode === "diagnose"
					? finishDiagnoseRun(meta, collect)
					: (() => {
						ctx.ui.notify(`🧪 跑 deterministic cross-test（${collect.commandPool.length} 条 pooled commands）…`, "info");
						return runCrossTest(meta, collect, {
							provisioning: tfConfig.provisioning,
							mainRoot: meta.repoRoot,
						});
					})();
				// deterministic 层终态：报告就绪，等待人工裁决（fusion/consult 为 v0.4）
				const finished = { ...meta, status: "completed" as const };
				writeFileSync(join(runDir, "meta.json"), JSON.stringify(finished, null, 2) + "\n", "utf8");
				const pass = matrix.cells.filter((c) => c.result === "pass").length;
				const fail = matrix.cells.filter((c) => c.result === "fail").length;
				ctx.ui.notify(
					`✅ cross-test 完成：${pass} pass / ${fail} fail / ${matrix.cells.length - pass - fail} 其它。\n` +
					`报告：${matrix.reportPath}\n三份 trajectory 与 patch 在 ${meta.runDir}\\lanes\\，等待人工裁决。`,
					"info",
				);
			},
		});

		// ── /trace-fusion-clean（v0.5 提前落地：§15「用完即删」的执行机制）──
		// implement 模式一轮真实 run 占 12GB+；清理 worktree、保留 runDir artifact（patch/trajectory）。
		pi.registerCommand("trace-fusion-clean", {
			description: "清理 trace-fusion run 的 worktree 占用（保留 artifact）：/trace-fusion-clean <runId> [--force]",
			handler: async (args, ctx) => {
				const raw = (args ?? "").trim();
				const force = /(^|\s)--force(\s|$)/.test(raw);
				const runId = raw.replace(/--force/g, "").trim();
				if (!runId) {
					ctx.ui.notify("用法：/trace-fusion-clean <runId> [--force]；runId 见 /trace-fusion-status", "error");
					return;
				}
				const result = cleanTraceRun(runId, { force, runsDir: defaultTraceFusionRunsDir() });
				for (const line of result.lines) ctx.ui.notify(line, "info");
				if (!result.ok) {
					ctx.ui.notify(`清理失败：${result.error}`, "error");
					return;
				}
				ctx.ui.notify(`✅ 清理完成：${result.removedWorktrees.length} 个 worktree 已移除`, "info");
			},
		});
	}
}