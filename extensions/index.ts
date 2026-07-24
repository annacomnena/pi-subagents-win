/**
 * subagent-win — Windows 兼容的轻量子 agent 扩展
 *
 * 核心机制：
 *   - 默认：spawn("node", [piCliPath, "--mode", "json", ...])
 *   - 外部 CLI：model 为 cli:claude | cli:codex | cli:agy 时，spawn 本地 harness
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = resolve(__dirname, "..");
const RUNS_DIR = join(homedir(), ".pi", "agent", "subagent-runs");
const MAX_CONCURRENCY = 6;

// ── pi CLI 路径探测 ────────────────────────────────────────────────

function findPiCli(): string {
	const env = process.env.PI_CLI_PATH;
	if (env && existsSync(env)) return resolve(env);
	const piDir = dirname(process.argv[1] ?? "");
	const candidates = [
		join(piDir, "dist", "cli.js"),
		join(piDir, "..", "dist", "cli.js"),
		join(dirname(process.execPath), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
		join(homedir(), "AppData", "Local", "nvm", "v22.19.0", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
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

// ── Agent 定义 ─────────────────────────────────────────────────────

interface AgentConfig {
	models: Record<string, string>;
	fallbackModels: Record<string, string[]>;
	thinking: Record<string, string>;
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
		};
	} catch {
		return { models: {}, fallbackModels: {}, thinking: {} };
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
	const message = result.error.toLowerCase();
	// Any error that is plausibly about the model/provider/CLI layer,
	// not about the task content, should trigger fallback. This includes
	// external CLI spawn/exit failures, timeouts, and agy-style errors.
	return /(api key|authentication|unauthorized|forbidden|rate limit|too many requests|quota|credit|model.{0,80}(not found|unavailable|may not exist|not exist|no access)|issue with the selected model|provider|\b401\b|\b403\b|\b404\b|\b408\b|\b429\b|econnreset|enotfound|fetch failed|network|overloaded|service unavailable|cli not found on path|timeout|exited with code|agent execution terminated|claude failed|claude error|codex failed|codex error|agy|location is not supported)/i.test(message);
}

/** Normalize free-form model requests into provider/id for pi --model, or cli:<backend> (default model only). */
function normalizeModelRef(raw?: string | null): string | undefined {
	if (!raw) return undefined;
	const input = String(raw).trim();
	if (!input) return undefined;

	// External CLI harness: cli:claude | cli:codex | cli:agy (always CLI default model)
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

async function runSingle(
	agent: AgentDef | null,
	task: string,
	systemPrompt?: string,
	model?: string,
	timeoutMs?: number,
	signal?: AbortSignal,
	onUpdate?: (status: string, text: string) => void,
): Promise<SubagentResult> {
	const finalPrompt = systemPrompt ?? agent?.body ?? "";
	// model arg is already normalized by resolveCallModel / runWithFallback.
	const resolvedModel = model ?? agentDefaultModel(agent);
	const resolvedThinking = agentDefaultThinking(agent);

	// External CLI backends (claude / codex / agy) — spawn local harness, not pi.
	if (resolvedModel && isExternalCliModel(resolvedModel)) {
		const ext = await runExternalCli({
			modelRef: resolvedModel,
			task,
			systemPrompt: finalPrompt || undefined,
			thinking: resolvedThinking,
			timeoutMs,
			signal,
			agentName: agent?.name,
			onUpdate,
		});
		return externalResultToSubagentResult(ext, agent?.name);
	}

	const cliPath = findPiCli();
	// 保留项目 AGENTS.md / CLAUDE.md 注入（勿加 --no-context-files）。
	// 仍用 --no-session 隔离会话；排除 subagent-win 防止递归派发。
	const argv = [
		cliPath,
		"--mode", "json", "--print", "--no-session",
		"--exclude-tools", "subagent-win",
	];
	if (resolvedModel) argv.push("--model", resolvedModel);
	if (resolvedThinking) argv.push("--thinking", resolvedThinking);
	if (finalPrompt) argv.push("--append-system-prompt", finalPrompt);
	argv.push(`Task: ${task}`);

	// 首次进度：显示真正传给 pi 的模型
	onUpdate?.(`🤖 ${resolvedModel ?? "default"}`, "starting...");

	return new Promise((resolve_) => {
		const child = spawn(process.execPath, argv, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
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
				result.error ??= stderrBuf || `exit ${code}`;
			} else if (!timedOut && result.status !== "failed" && result.status !== "cancelled") {
				// If the process exited cleanly after only toolUse turns (no stop), keep best partial
				// and mark failed-incomplete so main agent doesn't treat narration as final answer.
				if (result.status !== "completed" && result.text) {
					result.status = "failed";
					result.error ??= "incomplete: no final stop turn";
				} else if (result.status !== "completed") {
					result.status = "failed";
					result.error ??= stderrBuf || `exit ${code ?? 0}`;
				}
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
function withAllAttemptUsage(result: SubagentResult, events: SubagentUsageEvent[], dispatchRunId: string): SubagentResult {
	result.runId = dispatchRunId;
	result.usageEvents = events;
	result.usage = totalUsage(events);
	return result;
}

async function runWithFallback(
	agent: AgentDef | null,
	task: string,
	systemPrompt?: string,
	model?: string,
	timeoutMs?: number,
	signal?: AbortSignal,
	onUpdate?: (text: string) => void,
): Promise<SubagentResult> {
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
		return runSingle(agent, task, systemPrompt, undefined, timeoutMs, signal, onUpdate);
	}

	let lastResult: SubagentResult | undefined;
	const dispatchRunId = randomUUID();
	const allUsageEvents: SubagentUsageEvent[] = [];
	for (let index = 0; index < candidates.length; index++) {
		const candidate = candidates[index];
		const result = await runSingle(agent, task, systemPrompt, candidate, timeoutMs, signal, onUpdate);
		result.requestedModel = candidate;
		allUsageEvents.push(...result.usageEvents.map((event) => ({ ...event, runId: dispatchRunId })));
		lastResult = result;
		if (result.status === "completed" || result.status === "cancelled") return withAllAttemptUsage(result, allUsageEvents, dispatchRunId);
		if (!isRetryableModelFailure(result) || index === candidates.length - 1) return withAllAttemptUsage(result, allUsageEvents, dispatchRunId);
	}
	return lastResult
		? withAllAttemptUsage(lastResult, allUsageEvents, dispatchRunId)
		: { status: "failed", text: "", usage: emptyUsageSummary(), usageEvents: [], runId: dispatchRunId, error: "no model attempt" };
}

// ── 并行 ────────────────────────────────────────────────────────────

interface TaskInput {
	agent?: string;
	task: string;
	systemPrompt?: string;
	model?: string;
	timeoutMs?: number;
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
			results[idx] = await runWithFallback(agentDef, t.task, t.systemPrompt, t.model, t.timeoutMs, signal, taskCb);
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
		lines.push("External CLI harnesses: `cli:claude`, `cli:codex`, `cli:agy` only. These spawn local CLIs with each tool's own default model — never pass provider/id or cli:backend/model overrides.");
		lines.push("Example: subagent-win({ agent: \"code-reviewer\", model: \"Zhipu/glm-5.2\", task: \"...\" })");
		lines.push("Example external: subagent-win({ agent: \"searcher\", model: \"cli:claude\", task: \"...\" })");
		lines.push("TUI call line shows `override:<model>` when model is overridden; tool result header shows the requested model.");
		lines.push("Do NOT permanently rewrite config.json just to try another model once; use the per-call `model` field.");
		lines.push("Note: Models with <200K context should split large exploration into parallel subtasks; task findings stay in replies or plans/*_research.md, not task-oriented Wiki pages.");
		return { message: { customType: "subagent-win-config", content: lines.join("\n"), display: false } };
	});

	pi.registerTool({
		name: "subagent-win",
		label: "Subagent Win",
		description: [
			"Windows 兼容的子 agent 工具。",
			"单 agent: { agent, task, model? }",
			"并行: { tasks: [{agent, task, model?}, ...], concurrency? }",
			"异步: { agent, task, model?, async: true }",
			"查状态: { action: \"status\", runId? }",
			"model 可覆盖该 agent 默认模型（仅本次调用）；优先 provider/id，如 Zhipu/glm-5.2；也接受 glm-5.2 / glm5.2 等短名。",
			"外部 CLI: model=\"cli:claude\" | \"cli:codex\" | \"cli:agy\"（使用各 CLI 默认模型，不支持覆盖）。",
		].join(" "),
		parameters: Type.Object({
			agent: Type.Optional(Type.String({ description: "agent 名称" })),
			task: Type.Optional(Type.String({ description: "任务描述" })),
			tasks: Type.Optional(Type.Array(Type.Object({
				agent: Type.Optional(Type.String({ description: "agent 名称" })),
				task: Type.String({ description: "任务描述" }),
				systemPrompt: Type.Optional(Type.String()),
				model: Type.Optional(Type.String({
					description: "覆盖该 task 的模型。provider/id、短名，或外部 CLI 后端（cli:claude / cli:codex / cli:agy，均用 CLI 默认模型）",
				})),
				timeoutMs: Type.Optional(Type.Number()),
			}))),
			concurrency: Type.Optional(Type.Number({ description: "并行并发数（默认 3）" })),
			async: Type.Optional(Type.Boolean({ description: "异步执行" })),
			action: Type.Optional(Type.String({ description: "status" })),
			runId: Type.Optional(Type.String({ description: "异步 run id" })),
			systemPrompt: Type.Optional(Type.String()),
			model: Type.Optional(Type.String({
				description: "覆盖本次调用模型（优先于 config.json / agent frontmatter）。provider/id 或短名，如 Zhipu/glm-5.2、glm-5.2；外部 CLI 仅后端：cli:claude / cli:codex / cli:agy（使用 CLI 默认模型）",
			})),
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
						c.addChild(new Text(`${rIcon} ${theme.fg("accent", r.agent ?? "?")}${modelTag}`, 0, 0));
						c.addChild(new Text(theme.fg("dim", r.text?.slice(0, 200) ?? r.error ?? ""), 0, 0));
						if (r.usage?.turns) c.addChild(new Text(theme.fg("dim", `↑${r.usage.input} ↓${r.usage.output} $${r.usage.cost.toFixed(4)}`), 0, 0));
					}
					return c;
				}
				const lines = results.map((r) => {
					const mark = r.status === "completed" ? "✓" : r.status === "cancelled" ? "⛔" : "✗";
					const modelTag = (r.requestedModel ?? r.model) ? ` (${r.requestedModel ?? r.model})` : "";
					return `${mark} ${r.agent ?? "?"}${modelTag}: ${(r.text ?? r.error ?? "").slice(0, 80)}`;
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
			const modelTag = modelLabel ? theme.fg("dim", modelLabel) : "";
			const usageTag = r.usage?.turns ? theme.fg("dim", `↑${r.usage.input} ↓${r.usage.output} $${r.usage.cost.toFixed(4)}`) : "";

			// status line: agent name + actual requested model + usage
			const statusLine = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent ?? "subagent"))}  ${modelTag}  ${usageTag}`.replace(/\s{2,}/g, " ");

			if (expanded) {
				const c = new Container();
				c.addChild(new Text(statusLine, 0, 0));
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
					return "### " + icon + " " + (r.agent || "task-" + (i + 1)) + " (" + r.status + ")\n\n" + (r.text || r.error || "(no output)");
				});
				var okCount = results.filter(function(r) { return r.status === "completed"; }).length;
				return { content: [{ type: "text", text: "Parallel: " + okCount + "/" + results.length + " succeeded\n\n" + parts.join("\n\n---\n\n") }], details: { results } };
			}

			if (p.async) {
				const runId = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
				if (!existsSync(RUNS_DIR)) mkdirSync(RUNS_DIR, { recursive: true });
				const record: AsyncRunRecord = { id: runId, agent: p.agent, task: p.task ?? "", status: "running", startedAt: new Date().toISOString() };
				writeFileSync(join(RUNS_DIR, `${runId}.json`), JSON.stringify(record));
				const agentDef = p.agent ? agents.find((a) => a.name === p.agent) ?? null : null;
				runWithFallback(agentDef, p.task ?? "", p.systemPrompt, p.model, p.timeoutMs).then((result) => {
					record.status = result.status; record.result = result;
					recordUsage(agentDef?.name, result);
					writeFileSync(join(RUNS_DIR, `${runId}.json`), JSON.stringify(record));
				});
				return { content: [{ type: "text", text: `Async run started: ${runId}\nCheck with: subagent-win({ action: "status", runId: "${runId}" })` }] };
			}

			if (p.task) {
				const agentDef = p.agent ? agents.find((a) => a.name === p.agent) ?? null : null;
				if (p.agent && !agentDef) {
					return { content: [{ type: "text", text: `Unknown agent "${p.agent}". Available: ${agents.map((a) => a.name).join(", ")}` }], isError: true };
				}
				const cb = onUpdate ? (s: string, t: string) => onUpdate({ content: [{ type: "text", text: s + " " + t }] }) : undefined;
				const result = await runWithFallback(agentDef, p.task, p.systemPrompt, p.model, p.timeoutMs, signal, cb);
				recordUsage(agentDef?.name, result);
				const modelBits = [
					result.requestedModel ? `requested=${result.requestedModel}` : null,
					result.model && result.model !== result.requestedModel ? `reported=${result.model}` : null,
					p.model ? "source=call-override" : "source=agent-default",
					result.error ? `error=${result.error}` : null,
				].filter(Boolean).join(" ");
				const modelLine = modelBits ? `[subagent ${modelBits}]\n\n` : "";
				// Timeout may still leave partial text; surface it instead of empty "(no output)".
				if (result.status === "completed") {
					return { content: [{ type: "text", text: modelLine + (result.text || "(no output)") }], details: { result } };
				}
				const body = result.text
					? `${result.error || result.status}\n\n--- partial output ---\n${result.text}`
					: (result.error || "failed");
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

	// ── /today-usage 命令 ──
	// Aggregates ALL sessions + subagent runs for the local calendar day.
	pi.registerCommand("today-usage", {
		description: "查看今日 token 用量总计（本地日全部 session + subagent）",
		handler: async (_args, ctx) => {
			const day = localDayBounds();
			const subTotal = collectSubagentUsage(day);
			// Respect the resolved session directory (settings/env/CLI), not a hard-coded default.
			const main = collectMainSessionUsage(day, ctx.sessionManager.getSessionDir() ?? DEFAULT_SESSIONS_ROOT);
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
						`${name}  [${cfg.models[name] ?? "pi default"}; fallback: ${(cfg.fallbackModels[name] ?? []).length}; thinking: ${cfg.thinking[name] ?? "default"}]`,
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
				//   [1..E] external CLI backends (cli:claude / cli:codex / cli:agy)
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
}
