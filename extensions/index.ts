/**
 * subagent-win — Windows 兼容的轻量子 agent 扩展
 *
 * 核心机制：
 *   - 默认：spawn("node", [piCliPath, "--mode", "json", ...])
 *   - 外部 CLI：model 为 cli:claude | cli:codex | cli:agy | cli:atomcode 时，spawn 本地 harness
 * 支持单 agent、并行、异步三种模式。
 */

import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
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
import { registerWikiNav } from "./wiki-nav.ts";
import { sendWindowsToast } from "./notify-windows.ts";
import { registerTimers } from "./timers-runtime.ts";
import { registerTabTelemetry, registerTabStatusTools } from "./tab-runs-runtime.ts";
import { bindAsyncPanelUi, notifyAsyncCompletion, refreshAsyncPanel, registerAsyncPanel } from "./async-panel.ts";
import { registerEventBus } from "./event-bus.ts";
import { recordLink, sessionIdentity, listLinks, type LinkKind } from "./links.ts";
import {
	defaultTabRunsDir,
	newTabRunId,
	validateTabDispatchRecord,
	writeTabDispatch,
	type TabDispatchRecord,
} from "./tab-runs.ts";
import {
	defaultTimersDir,
	dueAtFromDelay,
	newTimerId,
	validateTimerRecord,
	writeTimerAtomic,
} from "./timers.ts";
import {
	buildWindowsTerminalArgs,
	buildWorkflowTabPrompt,
	launchTaskTitle,
	parseLaunchRequest,
	type LaunchMode,
} from "./launch.ts";

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
	try {
		const child = spawn(wtPath, buildWindowsTerminalArgs(title, prompt, {
			cwd,
			piCli,
			execPath: process.execPath,
			model,
			skills,
		}), {
			shell: false,
			// 把回收身份传入新标签页：wt.exe 继承环境 → shell → pi 进程
			env: runId ? { ...process.env, PI_TAB_RUN_ID: runId, PI_TAB_RUNS_DIR: runsDir } : undefined,
		});
		child.on("error", (err: Error) => {
			// 同步 try/catch 只覆盖 spawn 本身的异常；异步 error（如 wt.exe 立即退出）也回写账本
			console.error(`[subagent-win launch] ${title}: ${err.message}`);
			onSpawnError?.(err);
		});
		child.unref();
		return { title, prompt, model, runId };
	} catch (err) {
		return { title, prompt, model, error: err instanceof Error ? err.message : String(err), runId };
	}
}

// ── Agent 定义 ─────────────────────────────────────────────────────

interface AgentConfig {
	models: Record<string, string>;
	fallbackModels: Record<string, string[]>;
	thinking: Record<string, string>;
	notifications?: boolean;
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
		};
	} catch {
		return { models: {}, fallbackModels: {}, thinking: {}, notifications: true };
	}
}

function writeConfig(cfg: AgentConfig): void {
	writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + "\n");
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
function classifyModelFailure(
	error: string,
	modelHint?: string,
): {
	retryable: boolean;
	kind: "usage_cap" | "rate_limit" | "auth" | "provider" | "timeout" | "other";
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
	if (/(timeout|\b408\b|timed?\s*out)/i.test(message)) {
		return { retryable: true, kind: "timeout", label: "TIMEOUT" };
	}
	const providerish =
		/(model.{0,80}(not found|unavailable|may not exist|not exist|no access)|issue with the selected model|provider|\b404\b|econnreset|enotfound|fetch failed|network|service unavailable|cli not found on path|exited with code|agent execution terminated|claude failed|claude error|codex failed|codex error|agy|atomcode|location is not supported)/i.test(
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

	// External CLI harness: cli:claude | cli:codex | cli:agy | cli:atomcode (always CLI default model)
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
	cwd?: string,
): Promise<SubagentResult> {
	const finalPrompt = systemPrompt ?? agent?.body ?? "";
	const workingDirectory = resolveSubagentCwd(cwd);
	// model arg is already normalized by resolveCallModel / runWithFallback.
	const resolvedModel = model ?? agentDefaultModel(agent);
	const resolvedThinking = agentDefaultThinking(agent);

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
	// 同时排除 launch-tabs —— 子 agent 禁止开新标签页（launch 编排只属于主会话）。
	const argv = [
		cliPath,
		"--mode", "json", "--print", "--no-session",
		"--exclude-tools", "subagent-win,launch-tabs",
	];
	if (resolvedModel) argv.push("--model", resolvedModel);
	if (resolvedThinking) argv.push("--thinking", resolvedThinking);
	if (finalPrompt) argv.push("--append-system-prompt", finalPrompt);
	argv.push(`Task: ${task}`);

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
		const timer = timeoutMs
			? setTimeout(() => {
				timedOut = true;
				result.status = "failed";
				result.error = "timeout";
				onUpdate?.("⏱ timeout", `killing ${resolvedModel ?? "default"}`);
				kill();
			}, timeoutMs)
			: null;

		// 输出缓冲上限 5MB，防止子进程输出过大撑爆 RangeError
		const MAX_BUF = 5_000_000;
		const parseOpts = { timedOut: () => timedOut, candidates: textCandidates };

		child.stdout.on("data", (chunk: Buffer) => {
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
			if (stderrBuf.length < MAX_BUF) stderrBuf += chunk.toString("utf8");
		});
		child.on("error", (err) => {
			result.status = "failed";
			result.error = err.message;
			result.agent = agent?.name;
			resolve_(result);
		});
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
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
	cwd?: string,
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
		const result = await runSingle(agent, task, systemPrompt, undefined, timeoutMs, signal, onUpdate, cwd);
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
		const result = await runSingle(agent, task, systemPrompt, candidate, timeoutMs, signal, onUpdate, cwd);
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

interface TaskInput {
	agent?: string;
	task: string;
	systemPrompt?: string;
	model?: string;
	timeoutMs?: number;
	/** Working directory / git worktree for this task. */
	cwd?: string;
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
			results[idx] = await runWithFallback(agentDef, t.task, t.systemPrompt, t.model, t.timeoutMs, signal, taskCb, t.cwd);
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
}

function emptyUsage(): UsageBucket {
	return { ...emptyUsageSummary(), count: 0 };
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
				addUsage(total, {
					input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite,
					cost: u.cost?.total, turns: 1,
				});
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

	// 子 agent 进程（嵌套 pi 会话）由 PI_SUBAGENT=1 标记：
	// 禁止注册 launch-tabs 工具与 /launch 命令，杜绝子 agent 开新标签页。
	// （主会话不受影响；工具排除名单之外仍有兜底保护。）
	const isSubagentProcess = process.env.PI_SUBAGENT === "1";

	// Codex 请求头兼容（独立配置 ~/.pi/agent/codex-headers.json，命令 /codex-headers）
	registerCodexHeaders(pi);

	// 计时器：到期自动向目标会话发送用户消息推进工作（超长程任务基础设施）
	registerTimers(pi);

	// 后台异步子 agent 面板（opencode 风格：widget + 状态栏 + 完成通知）
	registerAsyncPanel(pi);

	// 事件总线：tab 完成即感知（fs.watch → toast + 自动唤醒模型去 reclaim）
	registerEventBus(pi);

	// 标签页回收：生命周期遥测（PI_TAB_RUN_ID 时生效）+ tab-status/reclaim-tabs//tabs
	registerTabTelemetry(pi);
	registerTabStatusTools(pi);

	// wiki-nav：渐进式 Wiki 导航查询工具（按层级调取附近节点，避免一次读整个 _navigation.json）
	registerWikiNav(pi);

	// ── Windows 通知 hook（受 config.json notifications 开关控制）──

	function notifyEnabled(): boolean {
		return readConfig().notifications !== false;
	}

	// subagent-win 工具开始执行时通知
	pi.on("tool_execution_start", (event) => {
		if (event.toolName !== "subagent-win") return;
		if (!notifyEnabled()) return;
		const args = event.args as Record<string, unknown> | undefined;
		const agent = args?.agent ?? args?.tasks?.[0]?.agent ?? "subagent";
		const task = (args?.task ?? args?.tasks?.[0]?.task ?? "") as string;
		const preview = String(task).slice(0, 60);
		sendWindowsToast({
			title: `🤖 ${agent} 开始工作`,
			body: preview || "(无任务描述)",
			duration: "short",
		});
	});

	// subagent-win 工具执行结束时通知
	pi.on("tool_execution_end", (event) => {
		if (event.toolName !== "subagent-win") return;
		if (!notifyEnabled()) return;
		const result = event.result as Record<string, unknown> | undefined;
		const details = result?.details as Record<string, unknown> | undefined;
		const results = details?.results as Array<Record<string, unknown>> | undefined;

		if (results) {
			// 并行模式
			const ok = results.filter((r) => r.status === "completed").length;
			const total = results.length;
			const icon = ok === total ? "✅" : "⚠️";
			sendWindowsToast({
				title: `${icon} Parallel: ${ok}/${total}`,
				body: ok === total ? "全部 task 完成" : `${total - ok} 个 task 失败`,
				duration: ok === total ? "short" : "long",
			});
		} else {
			// 单 agent 模式
			const r = details?.result as Record<string, unknown> | undefined;
			const agent = (r?.agent ?? "subagent") as string;
			const status = (r?.status ?? "completed") as string;
			const isOk = status === "completed";
			const error = r?.error as string | undefined;
			const usage = r?.usage as Record<string, unknown> | undefined;
			const cost = usage?.cost as number | undefined;

			sendWindowsToast({
				title: isOk ? `✅ ${agent} 完成` : `❌ ${agent} 失败`,
				body: isOk
					? cost !== undefined
						? `✓ 成功  ($${cost.toFixed(4)})`
						: "✓ 成功"
					: `✗ ${(error ?? "未知错误").slice(0, 100)}`,
				duration: isOk ? "short" : "long",
			});
		}
	});

	// update_goal(complete) 时通知 goal 完成
	pi.on("tool_execution_end", (event) => {
		if (event.toolName !== "update_goal") return;
		if (event.isError) return;
		if (!notifyEnabled()) return;
		const result = event.result as Record<string, unknown> | undefined;
		const content = result?.content as Array<Record<string, unknown>> | undefined;
		if (!content) return;
		const text = content.map((c) => String(c.text ?? "")).join("");
		// 检查输出是否包含 complete 状态的确认
		if (/complete|完成|✅|✓/i.test(text)) {
			sendWindowsToast({
				title: "🎯 Goal 已完成",
				body: text.slice(0, 120) || "所有目标达成",
				duration: "long",
			});
		}
	});

	// 注册包内 skill 路径
	pi.on("resources_discover", async () => {
		return { skillPaths: [join(PKG_DIR, "skills")] };
	});

	// 注入 subagent-win 配置到 LLM 上下文
	pi.on("before_agent_start", async (_event, ctx) => {
		const cfg = readConfig();
		const allModels = ctx.modelRegistry?.getAvailable() ?? [];
		const lines: string[] = [
			"### Subagent-win default config (config.json only; NOT the model of the last/current run)",
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
		lines.push("External CLI harnesses exist (`cli:claude`, `cli:codex`, `cli:agy`, `cli:atomcode`) but are ONLY used by agents whose config.json default or fallback is set to one (e.g. implementer=`cli:agy`). These spawn local CLIs with each tool's own default model — never pass provider/id or cli:backend/model overrides.");
		lines.push("Example: subagent-win({ agent: \"code-reviewer\", model: \"Zhipu/glm-5.2\", task: \"...\" })");
		lines.push("Model selection priority (follow strictly): (1) DEFAULT — let each agent run its configured default + its fallback chain above; do NOT pass `model` to override. (2) Only override `model` when ONE of these is true: (a) the fallback chain is also unavailable (every default+fallback attempt failed, e.g. USAGE_CAP across the whole chain); (b) the USER explicitly asked for a specific model or agent; (c) the configured model is clearly unsuitable for THIS task (context window too small, or capability mismatch). (3) When overriding, prefer a normal provider/id — do NOT proactively switch to an external CLI (cli:claude/codex/agy/atomcode) unless that agent's config already uses one or the user explicitly asked. The mere existence of a cli: backend is never a reason to use it.");
		lines.push("Sync/async decision (you decide per dispatch): SYNC (no `async`) when the result is needed immediately to decide the next step; PARALLEL (`tasks: [...]`) for several independent tasks you must all wait for; ASYNC (`async: true`) for long independent work that does not block the current turn — the tool returns a runId instantly, you continue or finish, then poll `{action:\"status\", runId}` later (pair with set-timer / reclaim-tabs for batch orchestration). When in doubt, async is safe for anything minutes-long whose result you do not need in this turn; sync/parallel for anything whose result gates the next action.");
		lines.push("consultant 派发规则：当用户显式点名某模型并要求评估/审查/咨询/看截图（如「请glm来评估一下」「请gpt5.6看看截图仿照设计」「请opus4.6点评一下」）时，dispatch agent=\"consultant\" 并把用户点名的模型作为 model override（短名如 glm / gpt5.6 / opus4.6 会自动展开为 provider/id）；该 subagent 以被点名模型的视角作答。这类请求不得派给 searcher / code-reviewer / planner 顶替。用户未点名模型时，用 consultant 的 config 默认模型，或由你根据任务判断选择合适的 model override。截图场景：把截图路径写进 task，让 consultant 用 read 读取图片后仿照设计。");
		lines.push("TUI call line shows `override:<model>` when model is overridden; tool result header shows the requested model.");
		lines.push("Do NOT permanently rewrite config.json just to try another model once; use the per-call `model` field.");
		lines.push("Note: When dispatching the searcher, ask it to query `Wiki/` by keyword first, jump straight to code via each page's `source_paths` (e.g. `file#L49` / `file::Symbol`, no grep guessing), cross-check with codegraph, and PROACTIVELY maintain theme pages — update stale ones (re-verify as `current` or mark `stale`) and CREATE a missing page when a durable, source-verified cross-task theme is absent. Require each returned fact to carry a code location AND a Wiki section reference (or `Wiki: none`) plus a calibration status, plus a 'Wiki section list' and a 'Wiki maintenance record' to forward to downstream agents.");
		lines.push("Note: Wiki is reused across agents — when dispatching planner/plan-reviewer/implementer/code-reviewer, forward the searcher's Wiki section list and instruct them to `read` those sections first (free knowledge, no re-exploration). Task findings still never go to Wiki.");
		lines.push("Note: Use `wiki-nav` progressively instead of reading whole index JSON. This discovery flow is ONLY for a new/unlocated topic: split it into 1-5 short phrases → `keywords queries=[...]` exact-check → only exact misses may use `semantic-terms queries=[...]` (returns terms only) → grep a selected term to locate Wiki. Once a searcher confirms `Wiki/path.md#section`, that exact reference is the workflow handoff: forward it to planner/implementer/reviewer and have them read it directly; never rediscover a known reference. `keywords query=<fragment>` filters vocabulary only. Do NOT inspect `_navigation.json`/`_search.json`/`_keywords.json`. `tree node` requires a real page id/title/unique alias, not a directory name.");
		lines.push("Note: Run `wiki-nav rebuild` ONLY after Wiki was created/updated/merged/deleted, or when the tool reports a missing index. It regenerates `_navigation.json` + `_search.json` + `_keywords.json` from Wiki/*.md (TS, self-contained, sub-second). Rebuilding cannot make an unchanged no-match query succeed.");
		lines.push("Note: Models with <200K context should split large exploration into parallel subtasks; task findings stay in replies or plans/*_research.md, not task-oriented Wiki pages.");
		lines.push("Note: If a subagent returns [subagent-failure kind=USAGE_CAP] (GLM package/quota limit), switch the main session model via /model to a higher-tier/different provider, then retry with model= override — do not retry the same model.");
		lines.push("Visible workflow launch: when the user asks `/launch` without `-t`/`--direct`, first analyze the current conversation, identify all independent ready tasks, then call `launch-tabs` once with all tasks. Do not open a tab for the orchestration sentence. Each launch-tabs prompt must contain the relevant workflow handoff; its first line is normalized to `根据workflow进行工作<taskId>` and a mandatory workflow-discipline block is appended (read the workflow-orchestrator skill, act as project manager and delegate stages to subagent-win agents, never complete the task in one shot). Three task modes are available on launch-tabs tasks: `workflow` (default full chain), `research` (deep research only: parallel searchers → research report in plans/YYYYMMDD_research_<topic>.md → Wiki theme-page maintenance, no implementation; tab starts with `根据research进行工作<taskId>`), and `execute` (conclusion already settled: skip search and planning → implementer → code-reviewer → Wiki wrap-up; tab starts with `根据execute进行工作<taskId>`).");
		lines.push("Tab reclaim + timer orchestration (ultra-long task infra): launch-tabs returns a `runId` per tab; use `tab-status` to inspect phase (dispatched/attached/working/waiting/completed/failed/cancelled/orphaned/unconfirmed), `reclaim-tabs({runIds, wait, timeoutMs})` to collect results and get ready[]/pending[]/awaitingInput[]/failed[]/orphaned[] for the next batch — never treat `waiting` or missing-result as done (resultMissing/unconfirmed). `set-timer({message, delayMs, target})` makes the system auto-send a user message when the timer expires (target=self or a tab's runId via launch-tabs `timers` param) to push work forward; `list-timers`/`cancel-timer`/`/timers` manage them. Closed loop: launch-tabs(batch N) → set-timer to advance → reclaim-tabs(batch N) → launch-tabs(batch N+1).");
		return { message: { customType: "subagent-win-config", content: lines.join("\n"), display: false } };
	});

	if (isSubagentProcess) {
		// 子 agent：跳过 launch-tabs 工具注册（双重防护，见 runSingle 的 --exclude-tools）
	} else {
	pi.registerTool({
		name: "launch-tabs",
		label: "Launch Pi Tabs",
		description: [
			"在 Windows Terminal 中并行打开一个或多个可见、独立的 pi 交互标签页。",
			"先分析当前会话并只提交彼此独立、启动条件已满足的任务；不要为编排请求本身打开标签页。",
			"每项必须提供 taskId、具体 prompt；prompt 会自动以 `根据workflow进行工作<taskId>` 开头，并附加 workflow-orchestrator 强制约束块（先 read 技能、委派 subagent-win 各角色执行、禁止单 agent 一路干完）。",
			"任务模式 mode：workflow（默认，完整链路）| research（深度研究：只并行搜索 + 研究报告 plans/*_research.md + Wiki 主题页维护，不做计划与实现；前缀 `根据research进行工作<taskId>`）| execute（快速执行：结论已明确，跳过搜索与计划，仅实现→审查→Wiki 收尾；前缀 `根据execute进行工作<taskId>`）。",
			"一次调用传入全部任务以保证并行启动。",
			"标签自动生成规范名 `<仓库名>[-worktree]-<taskId>-<标签>`（仓库名取自 git origin/toplevel，worktree 路径自动加 -worktree- 标记，标签取显式 title 或从 prompt 首行提取）；不再使用无意义的 wlc 默认名。",
			"每项返回 runId（回收令牌）：用 tab-status 查询状态、reclaim-tabs 回收结果后编排下一批；每项可传 timers: [{delayMs, message, label?, repeatMs?}] 写入该标签页邮箱，到期自动发送推进消息（超长程编排）。",
			"每项可传 cwd 指定新标签页工作目录（默认当前目录）；独立 worktree 场景必须显式传 cwd。",
		].join(" "),
		parameters: Type.Object({
			tasks: Type.Array(Type.Object({
				taskId: Type.String({ description: "任务编号，例如 1007" }),
				prompt: Type.String({ description: "该任务的首轮 prompt；应包含 workflow 交接材料与具体范围" }),
				cwd: Type.Optional(Type.String({ description: "新标签页工作目录；缺省用当前目录。独立 worktree 场景必填，如 G:/code/worktrees/GreenCAD-123" })),
				model: Type.Optional(Type.String({ description: "仅用户明确要求或配置不适用时覆盖新 pi 会话模型" })),
				title: Type.Optional(Type.String({ description: "标签名（可选）：仅作为标签部分，自动剥离开头的 pi-/wlc- 前缀；缺省从 prompt 首行提取" })),
				mode: Type.Optional(Type.String({ description: "任务模式（可选）：workflow（默认，完整链路 搜索→计划→审查→实现→审查→Wiki 收尾）| research（深度研究：仅并行搜索 + 研究报告 + Wiki 主题页维护，不做计划与实现）| execute（快速执行：结论已明确，跳过搜索与计划，仅实现→审查→Wiki 收尾）" })),
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
				const taskId = (item.taskId ?? "").trim();
				const prompt = (item.prompt ?? "").trim();
				if (!taskId || !prompt) {
					return { title: item.title ?? (taskId || "?"), prompt, model: item.model, error: "taskId and prompt are required" };
				}
				// workflow 绑定：前缀 + 强制约束块 + 原始 handoff；--skill 保证技能在标签会话里可见
				const skillRef = existsSync(WORKFLOW_SKILL_FILE) ? WORKFLOW_SKILL_FILE : undefined;
				const skillArgs = existsSync(WORKFLOW_SKILL_ROOT) ? [WORKFLOW_SKILL_ROOT] : undefined;
				const mode: LaunchMode = item.mode === "research" ? "research" : item.mode === "execute" ? "execute" : "workflow";
				const normalizedPrompt = buildWorkflowTabPrompt({ taskId, title: item.title, prompt, model: item.model }, skillRef, mode);
				const cwdRaw = (item.cwd ?? "").trim() || process.cwd();
				const cwd = resolve(cwdRaw);
				const title = launchTaskTitle({ taskId, title: item.title, prompt: normalizedPrompt, model: item.model }, cwd);

				// 1) 派发前写账本：回收闭环的 runId 唯一令牌
				const runId = newTabRunId();
				const dispatch: TabDispatchRecord = {
					id: runId,
					version: 1,
					taskId,
					mode,
					title: item.title ?? title,
					cwd,
					requestedModel: item.model,
					dispatchedAt: new Date().toISOString(),
					dispatchStatus: "dispatched",
				};
				writeTabDispatch(runsDir, dispatch);
				// 溯源：记录「本会话唤起了这个 tab」
				recordLink({
					sessionId: sessionIdentity(_ctx as never),
					kind: "tab",
					targetId: runId,
					detail: `task=${taskId} mode=${mode} ${title}`,
				});

				// 2) 写入该标签页邮箱的计时器（到期自动发送推进消息）
				for (const t of item.timers ?? []) {
					if (typeof t.delayMs !== "number" || !Number.isFinite(t.delayMs) || t.delayMs <= 0) continue;
					if (typeof t.message !== "string" || !t.message.trim()) continue;
					const timerRaw: Record<string, unknown> = {
						id: newTimerId(),
						version: 1,
						dueAt: dueAtFromDelay(t.delayMs),
						message: t.message.trim(),
						target: { tabRunId: runId, taskId },
						source: "launch-tabs",
						label: typeof t.label === "string" && t.label.trim() ? t.label.trim() : undefined,
						repeatMs: t.repeatMs,
						status: "pending",
						createdAt: new Date().toISOString(),
					};
					const check = validateTimerRecord(timerRaw);
					if (check.ok && check.value) writeTimerAtomic(timersDir, check.value, { tabRunId: runId });
				}

				// 3) spawn（env 携带 PI_TAB_RUN_ID / PI_TAB_RUNS_DIR）
				const result = dispatchPiTab(wtPath, piCli, cwd, title, normalizedPrompt, item.model, skillArgs, runId, runsDir, (err) => {
					// P1-2：异步 spawn 失败也回写 launch_failed（不静默卡 dispatched）
					console.error(`[subagent-win launch] async spawn failed ${runId}: ${err.message}`);
					writeTabDispatch(runsDir, { ...dispatch, dispatchStatus: "launch_failed", error: err.message });
				});
				if (result.error) {
					// 派发失败保留 launch_failed 记录（不静默消失）
					writeTabDispatch(runsDir, { ...dispatch, dispatchStatus: "launch_failed", error: result.error });
				}
				return { ...result, runId, taskId, cwd };
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
			"Windows 兼容的子 agent 工具。",
			"单 agent: { agent, task, model?, cwd? }",
			"并行: { tasks: [{agent, task, model?, cwd?}, ...], concurrency? }",
			"异步: { agent, task, model?, cwd?, async: true }",
			"查状态: { action: \"status\", runId? }",
			"【async 决策准则——由你自主选择】同步（不传 async）：需要本次结果才能继续下一步（结果驱动下一步动作）。并行（tasks[]）：多个独立任务、要等全部完成再统一处理。异步（async: true）：任务独立、结果不阻塞当前回合——派发后工具立即返回 runId，你继续做别的事或结束回合，稍后用 { action: \"status\", runId } 或结合 set-timer/reclaim-tabs 查询推进。适合：长耗时（分钟级+）、可后台跑的探索/搜索/实现、编排多个批次。判据：如果这个任务的结果马上要用，用同步/并行；如果可以不阻塞地等它，用异步。",
			"model 可覆盖该 agent 默认模型（仅本次调用）；优先 provider/id，如 Zhipu/glm-5.2；也接受 glm-5.2 / glm5.2 等短名。",
			"外部 CLI 后端（仅当某 agent 的 config 默认/fallback 已设为该后端时才走，勿主动用其 override 未配置的 agent）：model=\"cli:claude\" | \"cli:codex\" | \"cli:agy\" | \"cli:atomcode\"（各 CLI 默认模型，不支持覆盖）。cwd 可指定项目 worktree。",
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
					description: "覆盖该 task 的模型。provider/id、短名，或外部 CLI 后端（cli:claude / cli:codex / cli:agy / cli:atomcode，均用 CLI 默认模型）",
				})),
				cwd: Type.Optional(Type.String({ description: "该 task 的工作目录；指定 git worktree 路径，子 agent 将在此目录运行，而不是主分支" })),
				timeoutMs: Type.Optional(Type.Number()),
			}))),
			concurrency: Type.Optional(Type.Number({ description: "并行并发数（默认 3）" })),
			async: Type.Optional(Type.Boolean({ description: "异步执行" })),
			action: Type.Optional(Type.String({ description: "status" })),
			runId: Type.Optional(Type.String({ description: "异步 run id" })),
			systemPrompt: Type.Optional(Type.String()),
			model: Type.Optional(Type.String({
				description: "覆盖本次调用模型（优先于 config.json / agent frontmatter）。provider/id 或短名，如 Zhipu/glm-5.2、glm-5.2；外部 CLI 仅后端：cli:claude / cli:codex / cli:agy / cli:atomcode（使用 CLI 默认模型）",
			})),
			cwd: Type.Optional(Type.String({ description: "工作目录；指定 git worktree 路径，子 agent 将在此目录运行，而不是主分支" })),
			timeoutMs: Type.Optional(Type.Number()),
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

			if (p.action === "status") {
				const runs = listAsyncRuns();
				const target = p.runId ? runs.find((r) => r.id === p.runId) : runs[0];
				if (!target) return { content: [{ type: "text", text: p.runId ? `Run ${p.runId} not found` : "No async runs yet" }] };
				return {
					content: [{ type: "text", text: [
						`Run: ${target.id}`,
						`Agent: ${target.agent ?? "(none)"}`,
						`Task: ${target.task}`,
						target.cwd ? `CWD: ${target.cwd}` : null,
						`Status: ${target.status}`,
						target.result ? `Output: ${target.result.text.slice(0, 500)}` : null,
						target.result?.usage ? `Tokens: ↑${target.result.usage.input} ↓${target.result.usage.output} $${target.result.usage.cost.toFixed(4)}` : null,
					].filter(Boolean).join("\n") }],
				};
			}

			if (p.tasks && Array.isArray(p.tasks)) {
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
					return "### " + icon + " " + (r.agent || "task-" + (i + 1)) + " (" + r.status + ")\n\n" + body;
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

			if (p.async) {
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
				// 方案 B：面板可视化 —— 绑定当前 UI，派发即刷新（opencode 风格常驻任务列表）
				bindAsyncPanelUi((_ctx as { ui?: ExtensionCommandContext["ui"] })?.ui);
				refreshAsyncPanel();
				runWithFallback(agentDef, p.task ?? "", p.systemPrompt, p.model, p.timeoutMs, undefined, undefined, p.cwd).then((result) => {
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
				const result = await runWithFallback(agentDef, p.task, p.systemPrompt, p.model, p.timeoutMs, signal, cb, p.cwd);
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
				// Timeout may still leave partial text; surface it instead of empty "(no output)".
				if (result.status === "completed") {
					return { content: [{ type: "text", text: modelLine + (result.text || "(no output)") }], details: { result } };
				}
				// Failed: structured error for main agent (usage cap → switch higher-tier model).
				const body = formatFailureForMainAgent(result, result.triedModels);
				return { content: [{ type: "text", text: modelLine + body }], isError: true, details: { result } };
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

			const grandTotal = {
				input: subTotal.input + mainTotal.input,
				output: subTotal.output + mainTotal.output,
				cacheRead: subTotal.cacheRead + mainTotal.cacheRead,
				cacheWrite: subTotal.cacheWrite + mainTotal.cacheWrite,
				cost: subTotal.cost + mainTotal.cost,
			};
			const tokenTotal = (usage: Pick<UsageSummary, "input" | "output" | "cacheRead" | "cacheWrite">) =>
				usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
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
				`\n=== Total ===` + usageLines({ ...grandTotal, turns: 0 }),
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
				//   [1..E] external CLI backends (cli:claude / cli:codex / cli:agy / cli:atomcode)
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

	// ── /launch 命令（子 agent 进程不注册）──
	if (isSubagentProcess) {
		// 子 agent：跳过 /launch 命令（双重防护）
	} else {
	pi.registerCommand("launch", {
		description: "编排可见 pi 标签页；/launch -t <标题> 或 --direct 才直接启动单个任务",
		handler: async (args, ctx) => {
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
				const modeHint = request.execute || request.research
					? `\n用户请求为${request.execute ? "快速执行模式（--execute）：结论/方案已明确，跳过搜索与计划" : "深度研究模式（--research）：只要结论不要实现"}。把对应任务在 launch-tabs 里传 mode: ${request.execute ? "\"execute\"" : "\"research\""}；这些标签页将以 ${request.execute ? "`根据execute进行工作<taskId>`" : "`根据research进行工作<taskId>`"} 启动，只做${request.execute ? "实现 → 审查 → Wiki 收尾" : "并行搜索 + 研究报告 + Wiki 维护"}。`
					: "";
				pi.sendUserMessage([
					"这是一个 /launch workflow 编排请求，不要把这句话直接作为新标签页任务。",
					`用户请求：${request.task}`,
					modelHint,
					modeHint,
					"请先分析当前会话上下文，找出用户明确表示启动条件已满足、且彼此独立的任务。",
					"对每个任务调用 launch-tabs；一次调用提交全部任务以并行打开标签页。",
					"每项必须有准确的 taskId（例如 1007）、具体且可执行的首轮 prompt，并保留 workflow 的 Wiki/plan/审查交接；不要把未满足条件的任务启动。",
					"launch-tabs 会确保每个首轮 prompt 以 `根据workflow进行工作<taskId>` 开头并附带 workflow-orchestrator 强制约束块（先 read 技能、委派执行、禁止自己一路干完）；任务模式由每项 mode 决定——research（深度研究，前缀 `根据research进行工作<taskId>`，只做并行搜索+研究报告+Wiki 维护）或 execute（结论已明确，前缀 `根据execute进行工作<taskId>`，跳过搜索与计划，只做实现+审查+Wiki 收尾）。若没有足够明确的独立任务，先说明原因，不要开标签页。",
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

			// 任务文本带任务序号（如 "Fix 1004 detector lifecycle"）时同样绑定 workflow 约束：
			// 前缀 根据workflow进行工作<序号> / 根据research进行工作<序号> + 强制约束块 + 原始任务；无序号则保持直开（用户自定任务）。
			const taskNum = request.task.match(/\b\d{3,5}\b/)?.[0] ?? "";
			const workflowBound = taskNum !== "";
			const skillRef = existsSync(WORKFLOW_SKILL_FILE) ? WORKFLOW_SKILL_FILE : undefined;
			const skillArgs = existsSync(WORKFLOW_SKILL_ROOT) ? [WORKFLOW_SKILL_ROOT] : undefined;
			const mode: LaunchMode = request.execute ? "execute" : request.research ? "research" : "workflow";
			const prompt = workflowBound
				? buildWorkflowTabPrompt({ taskId: taskNum, title: request.title, prompt: request.task, model: request.model }, skillRef, mode)
				: request.task;
			const boundTitle = launchTaskTitle({ taskId: workflowBound ? taskNum : "", title: request.title, prompt, model: request.model }, request.cwd ?? process.cwd());

			const result = dispatchPiTab(wtPath, piCli, request.cwd ?? process.cwd(), boundTitle, prompt, request.model, workflowBound ? skillArgs : undefined);
			if (result.error) {
				ctx.ui.notify(`❌ 启动失败: ${result.error}`, "error");
				return;
			}
			const modelHint = request.model ? ` (model: ${request.model})` : "";
			const modeName = request.execute ? "快速执行" : request.research ? "深度研究" : "workflow";
			const boundHint = workflowBound ? ` (workflow 约束已绑定 · ${modeName}模式)` : "";
			ctx.ui.notify(`✅ 已启动标签页 [${boundTitle}]${modelHint}${boundHint}，pi 将在新终端中运行`, "info");
		},
	});
	}
}