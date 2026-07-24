/**
 * External CLI backends for subagent-win (inspired by pi-flow-external).
 *
 * Model refs (backend only — always use each CLI's own default model):
 *   cli:claude
 *   cli:codex
 *   cli:agy
 *
 * Never pass --model to the external harness; users configure models inside
 * Claude Code / Codex / Antigravity themselves.
 *
 * Spawns the local CLI harness instead of pi --mode json.
 * Windows-aware: resolves .exe/.cmd, process-group kill only on non-Windows.
 */

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

// ── public types (kept compatible with index.ts SubagentResult) ────────────

export type ExternalBackend = "claude" | "codex" | "agy";

export interface ExternalUsageSummary {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

export interface ExternalSubagentResult {
	status: "completed" | "failed" | "cancelled";
	text: string;
	usage: ExternalUsageSummary;
	usageEvents: Array<{
		id: string;
		runId: string;
		ts: string;
		model?: string;
		usage: ExternalUsageSummary;
	}>;
	runId: string;
	model?: string;
	requestedModel?: string;
	agent?: string;
	error?: string;
}

export interface RunExternalCliParams {
	/** Backend selector only: cli:claude | cli:codex | cli:agy */
	modelRef: string;
	task: string;
	/** Role system prompt (agent body / override). */
	systemPrompt?: string;
	thinking?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	cwd?: string;
	agentName?: string;
	onUpdate?: (status: string, text: string) => void;
}

export const EXTERNAL_CLI_PREFIX = "cli:";
export const EXTERNAL_BACKENDS: ExternalBackend[] = ["claude", "codex", "agy"];

const FORCE_KILL_DELAY_MS = 3000;
const MAX_STDERR_CHARS = 128 * 1024;
const MAX_STDOUT_LINE_CHARS = 4 * 1024 * 1024;
const MAX_BUF = 5_000_000;

// ── model ref parsing ──────────────────────────────────────────────────────

export function isExternalCliModel(ref?: string | null): boolean {
	if (!ref) return false;
	return ref.trim().toLowerCase().startsWith(EXTERNAL_CLI_PREFIX);
}

/**
 * Parse `cli:<backend>` into a backend selector.
 * Rejects `cli:<backend>/<model>` so we never override the CLI's default model.
 */
export function parseExternalCliModel(ref: string): {
	backend: ExternalBackend;
	canonical: string;
} | null {
	const raw = ref.trim();
	if (!raw.toLowerCase().startsWith(EXTERNAL_CLI_PREFIX)) return null;
	// Keep prefix length based on literal "cli:" (case-insensitive match already done).
	const rest = raw.slice(EXTERNAL_CLI_PREFIX.length).trim();
	if (!rest) return null;
	if (rest.includes("/")) {
		// Explicit policy: never choose models for external harnesses.
		return null;
	}
	const backendRaw = rest.toLowerCase();
	if (!EXTERNAL_BACKENDS.includes(backendRaw as ExternalBackend)) return null;
	const backend = backendRaw as ExternalBackend;
	return { backend, canonical: `${EXTERNAL_CLI_PREFIX}${backend}` };
}

/** Normalize free-form external refs; returns undefined if not an external ref. */
export function normalizeExternalCliModel(raw?: string | null): string | undefined {
	if (!raw) return undefined;
	const input = String(raw).trim();
	if (!input) return undefined;
	// Accept only: cli:claude | cli:codex | cli:agy (case-insensitive prefix/backend).
	if (!isExternalCliModel(input)) return undefined;
	const parsed = parseExternalCliModel(input);
	if (!parsed) {
		throw new Error(
			`Unknown external CLI model "${input}". Use cli:claude, cli:codex, or cli:agy (no model override; each CLI uses its own default model).`,
		);
	}
	return parsed.canonical;
}

export function listExternalCliModelOptions(): Array<{ ref: string; label: string }> {
	const available = detectAvailableBackends();
	const opts: Array<{ ref: string; label: string }> = [];
	for (const backend of EXTERNAL_BACKENDS) {
		const ok = available[backend];
		const status = ok ? "available" : "not on PATH";
		const label =
			backend === "claude"
				? `cli:claude  — Claude Code CLI, default model (${status})`
				: backend === "codex"
					? `cli:codex  — Codex CLI, default model (${status})`
					: `cli:agy  — Antigravity CLI, default model (${status})`;
		opts.push({ ref: `${EXTERNAL_CLI_PREFIX}${backend}`, label });
	}
	return opts;
}

export function detectAvailableBackends(): Record<ExternalBackend, boolean> {
	const out = { claude: false, codex: false, agy: false } as Record<ExternalBackend, boolean>;
	for (const b of EXTERNAL_BACKENDS) {
		out[b] = Boolean(resolveExternalCommand(b));
	}
	return out;
}

// ── command resolution (Windows-aware) ─────────────────────────────────────

function resolveExternalCommand(backend: ExternalBackend): string | undefined {
	const candidates =
		process.platform === "win32"
			? backend === "codex"
				? ["codex.cmd", "codex.exe", "codex"]
				: [`${backend}.exe`, backend]
			: [backend];

	for (const name of candidates) {
		try {
			const found = execFileSync(process.platform === "win32" ? "where" : "which", [name], {
				encoding: "utf8",
				shell: process.platform === "win32",
			})
				.split(/\r?\n/)
				.map((s) => s.trim())
				.find((s) => s && existsSync(s));
			if (found) return found;
		} catch {
			/* try next */
		}
	}
	// PATH lookup failed — still return bare name so spawn error is clear
	return undefined;
}

function commandForSpawn(backend: ExternalBackend): string {
	return resolveExternalCommand(backend) ?? backend;
}

// ── proxy environment ──────────────────────────────────────────────────────

const WININET_SETTINGS_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

function getEnvValue(env: NodeJS.ProcessEnv, names: readonly string[]): string | undefined {
	for (const name of names) {
		const value = env[name];
		if (value?.trim()) return value.trim();
	}
	// Environment names are case-insensitive on Windows, but a spawned Node
	// process can still expose a non-canonical spelling in its object.
	const wanted = new Set(names.map((name) => name.toLowerCase()));
	for (const [name, value] of Object.entries(env)) {
		if (wanted.has(name.toLowerCase()) && value?.trim()) return value.trim();
	}
	return undefined;
}

function readWinInetRegistryValue(name: string): string | undefined {
	if (process.platform !== "win32") return undefined;
	try {
		const output = execFileSync("reg", ["query", WININET_SETTINGS_KEY, "/v", name], {
			encoding: "utf8",
			windowsHide: true,
		});
		// Typical output: "    ProxyServer    REG_SZ    127.0.0.1:7897"
		const line = output.split(/\r?\n/).find((candidate) =>
			new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+`, "i").test(candidate),
		);
		if (!line) return undefined;
		return line.replace(new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+`, "i"), "").trim() || undefined;
	} catch {
		return undefined;
	}
}

function normalizeProxyUrl(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

function selectWinInetProxy(proxyServer: string, protocol: "http" | "https"): string | undefined {
	// WinINET supports either one shared value (host:port) or a map such as
	// "http=host:port;https=host:port". Use protocol-specific value first,
	// then HTTP/shared as a sensible fallback.
	if (!proxyServer.includes("=")) return normalizeProxyUrl(proxyServer);
	const entries = new Map<string, string>();
	for (const part of proxyServer.split(";")) {
		const separator = part.indexOf("=");
		if (separator <= 0) continue;
		entries.set(part.slice(0, separator).trim().toLowerCase(), part.slice(separator + 1).trim());
	}
	return normalizeProxyUrl(entries.get(protocol) ?? entries.get("http") ?? entries.get("https"));
}

/**
 * Build the external child's network environment.
 *
 * Explicit HTTP(S)/ALL_PROXY values already inherited by pi always win. On
 * Windows, when none are set, bridge the user's enabled WinINET proxy into the
 * conventional variables recognised by most CLI/network stacks. This matters
 * because child processes do not automatically receive WinINET settings.
 */
export function buildExternalCliEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...baseEnv };
	let httpProxy = getEnvValue(env, ["HTTP_PROXY", "http_proxy"]);
	let httpsProxy = getEnvValue(env, ["HTTPS_PROXY", "https_proxy"]);
	let allProxy = getEnvValue(env, ["ALL_PROXY", "all_proxy"]);
	let noProxy = getEnvValue(env, ["NO_PROXY", "no_proxy"]);

	if (!httpProxy && !httpsProxy && !allProxy && process.platform === "win32") {
		const enabled = readWinInetRegistryValue("ProxyEnable");
		const proxyServer = readWinInetRegistryValue("ProxyServer");
		if (enabled === "0x1" && proxyServer) {
			httpProxy = selectWinInetProxy(proxyServer, "http");
			httpsProxy = selectWinInetProxy(proxyServer, "https");
			allProxy = httpsProxy ?? httpProxy;
			if (!noProxy) {
				const bypass = readWinInetRegistryValue("ProxyOverride");
				if (bypass) {
					// WinINET uses semicolons; standard NO_PROXY convention is comma-separated.
					noProxy = bypass
						.split(";")
						.map((part) => part.trim())
						.filter((part) => part && part.toLowerCase() !== "<local>")
						.join(",") || undefined;
				}
			}
		}
	}

	// Make both canonical spellings available. This covers Go (agy), Node-based
	// wrappers and native tools without replacing a caller's explicit endpoint.
	if (httpProxy) env.HTTP_PROXY = env.http_proxy = httpProxy;
	if (httpsProxy) env.HTTPS_PROXY = env.https_proxy = httpsProxy;
	if (allProxy) env.ALL_PROXY = env.all_proxy = allProxy;
	if (noProxy) env.NO_PROXY = env.no_proxy = noProxy;
	return env;
}

// ── bounded buffer ─────────────────────────────────────────────────────────

interface BoundedBuffer {
	append(chunk: string): void;
	text(): string;
}

function createBoundedBuffer(maxChars: number): BoundedBuffer {
	const headLimit = Math.ceil(maxChars / 2);
	const tailLimit = Math.max(0, maxChars - headLimit);
	let head = "";
	let tail = "";
	let tailRawLen = 0;
	return {
		append(chunk) {
			if (!chunk) return;
			if (head.length < headLimit) {
				const room = headLimit - head.length;
				head += chunk.slice(0, room);
				chunk = chunk.slice(room);
			}
			if (chunk) {
				tailRawLen += chunk.length;
				tail = (tail + chunk).slice(-tailLimit);
			}
		},
		text() {
			if (tailRawLen === 0) return head;
			if (tailRawLen <= tailLimit) return head + tail;
			return `${head}\n…[truncated]\n${tail}`;
		},
	};
}

// ── process helpers ────────────────────────────────────────────────────────

function hasChildExited(child: ChildProcess): boolean {
	return child.exitCode !== null || child.signalCode !== null;
}

function signalChildTree(child: ChildProcess, signal: NodeJS.Signals): void {
	if (process.platform !== "win32" && child.pid) {
		try {
			process.kill(-child.pid, signal);
			return;
		} catch {
			/* fall through */
		}
	}
	try {
		child.kill(signal);
	} catch {
		/* already gone */
	}
}

function abortChild(child: ChildProcess): void {
	if (hasChildExited(child)) return;
	signalChildTree(child, "SIGTERM");
	setTimeout(() => {
		if (!hasChildExited(child)) signalChildTree(child, "SIGKILL");
	}, FORCE_KILL_DELAY_MS).unref?.();
}

function emptyUsage(): ExternalUsageSummary {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
	const n = Number(value);
	return Number.isFinite(n) ? n : undefined;
}

function parseJsonLine(line: string): Record<string, unknown> | undefined {
	const trimmed = line.trim();
	if (!trimmed) return undefined;
	try {
		const parsed = JSON.parse(trimmed);
		return asRecord(parsed);
	} catch {
		return undefined;
	}
}

// ── Claude ─────────────────────────────────────────────────────────────────

function buildClaudeArgs(systemPrompt: string | undefined, thinking: string | undefined): string[] {
	const args = [
		"-p",
		"--output-format",
		"stream-json",
		"--verbose",
		"--no-session-persistence",
		"--dangerously-skip-permissions",
	];
	// Never pass --model: respect Claude Code's user-configured default.
	if (systemPrompt) args.push("--append-system-prompt", systemPrompt);
	if (thinking) args.push("--effort", thinking);
	return args;
}

function extractClaudeUsage(event: Record<string, unknown>): ExternalUsageSummary | undefined {
	if (event.type === "result") {
		const modelUsage = asRecord(event.modelUsage);
		if (modelUsage) {
			const totals = emptyUsage();
			let found = false;
			for (const item of Object.values(modelUsage)) {
				const u = asRecord(item);
				if (!u) continue;
				const input = asFiniteNumber(u.inputTokens);
				const cacheRead = asFiniteNumber(u.cacheReadInputTokens ?? 0) ?? 0;
				const cacheWrite = asFiniteNumber(u.cacheCreationInputTokens ?? 0) ?? 0;
				const output = asFiniteNumber(u.outputTokens);
				if (input === undefined || output === undefined) continue;
				found = true;
				totals.input += input;
				totals.cacheRead += cacheRead;
				totals.cacheWrite += cacheWrite;
				totals.output += output;
				const cost = asFiniteNumber(u.costUSD);
				if (cost !== undefined) totals.cost += cost;
			}
			if (found) {
				totals.turns = 1;
				const totalCost = asFiniteNumber(event.total_cost_usd);
				if (totalCost !== undefined) totals.cost = totalCost;
				return totals;
			}
		}
		const usage = asRecord(event.usage);
		if (usage) {
			const input = asFiniteNumber(usage.input_tokens) ?? 0;
			const cacheRead = asFiniteNumber(usage.cache_read_input_tokens ?? 0) ?? 0;
			const cacheWrite = asFiniteNumber(usage.cache_creation_input_tokens ?? 0) ?? 0;
			const output = asFiniteNumber(usage.output_tokens) ?? 0;
			const cost = asFiniteNumber(event.total_cost_usd) ?? 0;
			return { input, output, cacheRead, cacheWrite, cost, turns: 1 };
		}
	}
	if (event.type === "assistant") {
		const message = asRecord(event.message);
		const usage = message ? asRecord(message.usage) : undefined;
		if (usage) {
			return {
				input: asFiniteNumber(usage.input_tokens) ?? 0,
				output: asFiniteNumber(usage.output_tokens) ?? 0,
				cacheRead: asFiniteNumber(usage.cache_read_input_tokens ?? 0) ?? 0,
				cacheWrite: asFiniteNumber(usage.cache_creation_input_tokens ?? 0) ?? 0,
				cost: 0,
				turns: 1,
			};
		}
	}
	return undefined;
}

function extractClaudeFinalText(event: Record<string, unknown>): string | undefined {
	if (event.type === "result") {
		if (event.structured_output !== undefined && event.structured_output !== null) {
			return typeof event.structured_output === "string"
				? event.structured_output
				: JSON.stringify(event.structured_output);
		}
		if (typeof event.result === "string") return event.result;
	}
	if (event.type === "assistant") {
		const message = asRecord(event.message);
		const content = message?.content;
		if (!Array.isArray(content)) return undefined;
		const text = content
			.map((part) => {
				const block = asRecord(part);
				return block?.type === "text" && typeof block.text === "string" ? block.text : undefined;
			})
			.filter((p): p is string => Boolean(p))
			.join("");
		return text || undefined;
	}
	return undefined;
}

function extractClaudeError(event: Record<string, unknown>): string | undefined {
	if (event.type === "result" && event.is_error === true) {
		const errors = Array.isArray(event.errors) ? event.errors : [];
		const first = errors.find((c) => typeof c === "string");
		const result = typeof event.result === "string" && event.result.trim() ? event.result.trim() : undefined;
		return `Claude failed: ${first ?? result ?? (typeof event.subtype === "string" ? event.subtype : "turn failed")}`;
	}
	if (event.type === "error") {
		return `Claude error: ${typeof event.message === "string" ? event.message : "unknown error"}`;
	}
	return undefined;
}

function claudeActivity(event: Record<string, unknown>): string | undefined {
	if (event.type === "system" && event.subtype === "init") return "claude session started";
	if (event.type === "result") return "claude turn completed";
	if (event.type === "assistant") {
		const message = asRecord(event.message);
		const content = message?.content;
		if (Array.isArray(content)) {
			for (const part of content) {
				const block = asRecord(part);
				if (block?.type === "tool_use") {
					const toolName = typeof block.name === "string" && block.name ? block.name : "tool_use";
					return toolName;
				}
			}
		}
	}
	return extractClaudeError(event);
}

// ── Codex ──────────────────────────────────────────────────────────────────

function buildConfigOverrideArg(key: string, rawValue: string): string {
	return `${key}=${JSON.stringify(rawValue)}`;
}

function buildCodexArgs(systemPrompt: string | undefined, thinking: string | undefined): string[] {
	const args = [
		"exec",
		"--json",
		"--skip-git-repo-check",
		"--dangerously-bypass-approvals-and-sandbox",
	];
	// Never pass --model: respect Codex CLI's user-configured default.
	if (systemPrompt) {
		args.push("-c", buildConfigOverrideArg("developer_instructions", systemPrompt));
	}
	if (thinking) {
		args.push("-c", buildConfigOverrideArg("model_reasoning_effort", thinking));
	}
	// Prompt via stdin (handles large prompts / leading '-')
	args.push("--", "-");
	return args;
}

function extractCodexUsage(event: Record<string, unknown>): ExternalUsageSummary | undefined {
	const parseUsage = (value: unknown): ExternalUsageSummary | undefined => {
		const usage = asRecord(value);
		if (!usage) return undefined;
		const inputTokens = asFiniteNumber(usage.input_tokens);
		const cached = asFiniteNumber(usage.cached_input_tokens ?? 0) ?? 0;
		const output = asFiniteNumber(usage.output_tokens);
		if (inputTokens === undefined || output === undefined) return undefined;
		const uncached = Math.max(0, inputTokens - cached);
		return {
			input: uncached,
			output,
			cacheRead: cached,
			cacheWrite: 0,
			cost: 0,
			turns: 1,
		};
	};
	if (event.type === "turn.completed") return parseUsage(event.usage);
	if (event.type === "event_msg") {
		const payload = asRecord(event.payload);
		if (payload?.type === "token_count") {
			const info = asRecord(payload.info);
			return info ? parseUsage(info.last_token_usage) : undefined;
		}
	}
	return undefined;
}

function extractCodexFinalText(event: Record<string, unknown>): string | undefined {
	const item = asRecord(event.item);
	if (event.type !== "item.completed" || !item || item.type !== "agent_message") return undefined;
	if (typeof item.text === "string") return item.text;
	if (typeof item.message === "string") return item.message;
	if (typeof item.content === "string") return item.content;
	if (item.structured_content !== undefined && item.structured_content !== null) {
		return typeof item.structured_content === "string"
			? item.structured_content
			: JSON.stringify(item.structured_content);
	}
	return "";
}

function extractCodexError(event: Record<string, unknown>): string | undefined {
	if (event.type === "turn.failed") {
		const error = asRecord(event.error);
		return `Codex failed: ${typeof error?.message === "string" ? error.message : "turn failed"}`;
	}
	if (event.type === "error") {
		return `Codex error: ${typeof event.message === "string" ? event.message : "unknown error"}`;
	}
	return undefined;
}

function codexActivity(event: Record<string, unknown>): string | undefined {
	if (event.type === "thread.started") return "codex session started";
	if (event.type === "turn.completed") return "codex turn completed";
	const item = asRecord(event.item);
	if ((event.type === "item.started" || event.type === "item.completed") && item && item.type !== "agent_message") {
		return typeof item.type === "string" ? item.type : "item";
	}
	return extractCodexError(event);
}

// ── Agy ────────────────────────────────────────────────────────────────────

function buildAgyArgs(prompt: string, thinking: string | undefined, timeoutMs?: number): string[] {
	const args = ["--dangerously-skip-permissions"];
	// Never pass --model: respect Antigravity's user-configured default.
	if (thinking) args.push("--effort", thinking);
	// Default print-timeout is 5 min; use caller timeout if longer, as Go duration.
	const callerMinutes = timeoutMs && timeoutMs > 0 ? Math.ceil(timeoutMs / 60_000) : 0;
	const minutes = Math.max(callerMinutes, 30);
	args.push("--print-timeout", `${minutes}m0s`);
	args.push("-p", prompt);
	return args;
}

// ── shared spawn runner ────────────────────────────────────────────────────

interface StreamRunOptions {
	backend: ExternalBackend;
	command: string;
	args: string[];
	/** If set, written to stdin then closed. */
	stdinText?: string;
	cwd: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	onUpdate?: (status: string, text: string) => void;
	/** Line-oriented JSON event handler (claude/codex). */
	onJsonLine?: (event: Record<string, unknown>) => void;
	/** Accumulate raw stdout (agy). */
	captureStdout?: boolean;
}

interface StreamRunOutcome {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	aborted: boolean;
	oversizeError?: string;
}

function spawnStreaming(opts: StreamRunOptions): Promise<StreamRunOutcome> {
	return new Promise((resolve) => {
		const isWin = process.platform === "win32";
		const child = spawn(opts.command, opts.args, {
			cwd: opts.cwd,
			env: buildExternalCliEnv(),
			stdio: opts.stdinText !== undefined ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
			// shell needed on Windows for .cmd wrappers (codex)
			shell: isWin && opts.command.toLowerCase().endsWith(".cmd"),
			detached: !isWin,
			windowsHide: true,
		});

		const stderrBuffer = createBoundedBuffer(MAX_STDERR_CHARS);
		let stdout = "";
		let lineBuf = "";
		let timedOut = false;
		let oversizeError: string | undefined;
		let forceKill: ReturnType<typeof setTimeout> | null = null;

		const kill = () => {
			abortChild(child);
			forceKill = setTimeout(() => abortChild(child), FORCE_KILL_DELAY_MS);
		};

		if (opts.signal?.aborted) kill();
		else opts.signal?.addEventListener("abort", kill, { once: true });

		const timer = opts.timeoutMs
			? setTimeout(() => {
					timedOut = true;
					opts.onUpdate?.("⏱ timeout", `killing ${opts.backend}`);
					kill();
				}, opts.timeoutMs)
			: null;

		if (child.stdout) {
			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				if (opts.captureStdout) {
					if (stdout.length < MAX_BUF) stdout += chunk;
					const first = stdout.split("\n").find((l) => l.trim());
					if (first) {
						const preview = first.replace(/^(Error:|Agent execution)/i, "").trim() || first;
						if (preview) opts.onUpdate?.(`🤖 ${opts.backend}`, preview.slice(0, 200));
					}
					return;
				}
				lineBuf += chunk;
				if (lineBuf.length > MAX_STDOUT_LINE_CHARS && !lineBuf.includes("\n")) {
					oversizeError = `${opts.backend} emitted a stdout line over ${MAX_STDOUT_LINE_CHARS} chars without a newline`;
					lineBuf = "";
					kill();
					return;
				}
				while (true) {
					const nl = lineBuf.indexOf("\n");
					if (nl < 0) break;
					const line = lineBuf.slice(0, nl);
					lineBuf = lineBuf.slice(nl + 1);
					const event = parseJsonLine(line);
					if (event) opts.onJsonLine?.(event);
				}
			});
		}

		if (child.stderr) {
			child.stderr.setEncoding("utf8");
			let stderrLineBuf = "";
			child.stderr.on("data", (chunk: string) => {
				stderrBuffer.append(String(chunk));
				if (opts.captureStdout) {
					// For capture-stdout backends (agy), relay stderr activity as
					// progress so the user knows the CLI is alive even when stdout
					// is silent during thinking / model calls.
					stderrLineBuf += String(chunk);
					while (true) {
						const nl = stderrLineBuf.indexOf("\n");
						if (nl < 0) break;
						const line = stderrLineBuf.slice(0, nl).trim();
						stderrLineBuf = stderrLineBuf.slice(nl + 1);
						if (!line) continue;
						// Skip noisy/internal lines; surface human-readable events.
						if (line.includes("log_context.go") || line.includes("log.go") || line.includes("Cache(")) continue;
						const match = line.match(/^[IW]\d{4} \d{2}:\d{2}:\d{2}[.:]\d+ \d+ \S+:\d+]\s*(.+)/);
						const msg = match ? match[1].trim() : line;
						if (msg.startsWith("Print mode:") || msg.startsWith("sending") || msg.includes("turn") || msg.includes("streaming") || msg.includes("completed")) {
							opts.onUpdate?.(`🔄 ${msg.slice(0, 200)}`);
						}
					}
				}
			});
		}

		// Heartbeat: emit elapsed time periodically so user sees it's alive even
		// when the CLI has no stdout/stderr output for a while.
		const startedAt = Date.now();
		let heartbeat: ReturnType<typeof setInterval> | null = null;
		if (opts.onUpdate) {
			heartbeat = setInterval(() => {
				const elapsed = Math.round((Date.now() - startedAt) / 1000);
				opts.onUpdate?.(`⏳ ${opts.backend} running`, `${elapsed}s elapsed`);
			}, 30_000);
			heartbeat.unref?.();
		}

		if (opts.stdinText !== undefined) {
			if (!child.stdin) {
				resolve({
					code: null,
					signal: null,
					stdout: "",
					stderr: `${opts.backend} stdin pipe unavailable`,
					timedOut: false,
					aborted: Boolean(opts.signal?.aborted),
				});
				return;
			}
			child.stdin.on("error", () => {
				/* EPIPE if child exits early — close handler reports real status */
			});
			child.stdin.end(opts.stdinText);
		}

		child.on("error", (err) => {
			if (timer) clearTimeout(timer);
			if (forceKill) clearTimeout(forceKill);
			if (heartbeat) clearInterval(heartbeat);
			resolve({
				code: null,
				signal: null,
				stdout,
				stderr: err.message,
				timedOut,
				aborted: Boolean(opts.signal?.aborted),
				oversizeError,
			});
		});

		child.on("close", (code, signal) => {
			if (timer) clearTimeout(timer);
			if (forceKill) clearTimeout(forceKill);
			if (heartbeat) clearInterval(heartbeat);
			if (!opts.captureStdout && lineBuf.trim()) {
				const event = parseJsonLine(lineBuf);
				if (event) opts.onJsonLine?.(event);
			}
			resolve({
				code,
				signal,
				stdout,
				stderr: stderrBuffer.text(),
				timedOut,
				aborted: Boolean(opts.signal?.aborted),
				oversizeError,
			});
		});
	});
}

// ── public runner ──────────────────────────────────────────────────────────

export async function runExternalCli(params: RunExternalCliParams): Promise<ExternalSubagentResult> {
	const parsed = parseExternalCliModel(params.modelRef);
	const runId = randomUUID();
	const base: ExternalSubagentResult = {
		status: "failed",
		text: "",
		usage: emptyUsage(),
		usageEvents: [],
		runId,
		requestedModel: params.modelRef,
		agent: params.agentName,
	};

	if (!parsed) {
		base.error = `Invalid external CLI model ref: ${params.modelRef}`;
		return base;
	}

	const { backend } = parsed;
	base.requestedModel = parsed.canonical;
	base.model = parsed.canonical;
	const cwd = params.cwd ?? process.cwd();
	const command = commandForSpawn(backend);
	params.onUpdate?.(`🤖 ${parsed.canonical}`, "starting...");

	if (backend === "claude") {
		return runClaude({ ...params, backend, command, cwd, runId, base });
	}
	if (backend === "codex") {
		return runCodex({ ...params, backend, command, cwd, runId, base });
	}
	return runAgy({ ...params, backend, command, cwd, runId, base });
}

interface BackendRunCtx extends RunExternalCliParams {
	backend: ExternalBackend;
	command: string;
	cwd: string;
	runId: string;
	base: ExternalSubagentResult;
}

function finalizeUsage(
	base: ExternalSubagentResult,
	usage: ExternalUsageSummary,
	runId: string,
	modelLabel: string,
): void {
	base.usage = usage;
	if (usage.input || usage.output || usage.cacheRead || usage.cacheWrite || usage.cost) {
		base.usageEvents = [
			{
				id: randomUUID(),
				runId,
				ts: new Date().toISOString(),
				model: modelLabel,
				usage: { ...usage },
			},
		];
	}
}

async function runClaude(ctx: BackendRunCtx): Promise<ExternalSubagentResult> {
	const { base, runId } = ctx;
	let usage = emptyUsage();
	let resultText = "";
	let eventError: string | undefined;
	let sawTerminal = false;

	const args = buildClaudeArgs(ctx.systemPrompt, ctx.thinking);
	const outcome = await spawnStreaming({
		backend: "claude",
		command: ctx.command,
		args,
		stdinText: ctx.task,
		cwd: ctx.cwd,
		timeoutMs: ctx.timeoutMs,
		signal: ctx.signal,
		onUpdate: ctx.onUpdate,
		onJsonLine: (event) => {
			if (event.type === "result" || event.type === "error") sawTerminal = true;
			const activity = claudeActivity(event);
			if (activity) ctx.onUpdate?.(`🤖 cli:claude`, activity.slice(0, 200));
			const u = extractClaudeUsage(event);
			if (u) usage = u;
			const text = extractClaudeFinalText(event);
			if (text !== undefined) resultText = text;
			const err = extractClaudeError(event);
			if (err) eventError ??= err;
		},
	});

	return finishStreamResult({
		base,
		runId,
		modelLabel: base.requestedModel ?? "cli:claude",
		usage,
		resultText,
		eventError,
		sawTerminal,
		outcome,
		backendLabel: "claude",
	});
}

async function runCodex(ctx: BackendRunCtx): Promise<ExternalSubagentResult> {
	const { base, runId } = ctx;
	let usage = emptyUsage();
	let resultText = "";
	let eventError: string | undefined;
	let sawTerminal = false;

	const args = buildCodexArgs(ctx.systemPrompt, ctx.thinking);
	const outcome = await spawnStreaming({
		backend: "codex",
		command: ctx.command,
		args,
		stdinText: ctx.task,
		cwd: ctx.cwd,
		timeoutMs: ctx.timeoutMs,
		signal: ctx.signal,
		onUpdate: ctx.onUpdate,
		onJsonLine: (event) => {
			if (event.type === "turn.completed" || event.type === "turn.failed") sawTerminal = true;
			const activity = codexActivity(event);
			if (activity) ctx.onUpdate?.(`🤖 cli:codex`, activity.slice(0, 200));
			const u = extractCodexUsage(event);
			if (u) usage = u;
			const text = extractCodexFinalText(event);
			if (text !== undefined) resultText = text;
			const err = extractCodexError(event);
			if (err) {
				if (event.type === "turn.failed") eventError ??= err;
				// non-terminal "error" events are diagnostic; only fail if no text
				else if (!resultText.trim()) eventError ??= err;
			}
		},
	});

	return finishStreamResult({
		base,
		runId,
		modelLabel: base.requestedModel ?? "cli:codex",
		usage,
		resultText,
		eventError,
		sawTerminal,
		outcome,
		backendLabel: "codex",
	});
}

async function runAgy(ctx: BackendRunCtx): Promise<ExternalSubagentResult> {
	const { base, runId } = ctx;
	// Keep system + task in the print prompt; effort goes via native --effort.
	// Never pass --model so Antigravity keeps the user's default model.
	const promptParts = [ctx.systemPrompt, ctx.task].filter(Boolean);
	const taskPrompt = promptParts.join("\n\n");
	const args = buildAgyArgs(taskPrompt, ctx.thinking, ctx.timeoutMs);

	const outcome = await spawnStreaming({
		backend: "agy",
		command: ctx.command,
		args,
		cwd: ctx.cwd,
		timeoutMs: ctx.timeoutMs,
		signal: ctx.signal,
		onUpdate: ctx.onUpdate,
		captureStdout: true,
	});

	const usage = emptyUsage();
	return finishStreamResult({
		base,
		runId,
		modelLabel: base.requestedModel ?? "cli:agy",
		usage,
		resultText: outcome.stdout,
		eventError: undefined,
		sawTerminal: true, // agy has no JSON terminal event
		outcome,
		backendLabel: "agy",
	});
}

function finishStreamResult(opts: {
	base: ExternalSubagentResult;
	runId: string;
	modelLabel: string;
	usage: ExternalUsageSummary;
	resultText: string;
	eventError?: string;
	sawTerminal: boolean;
	outcome: StreamRunOutcome;
	backendLabel: string;
}): ExternalSubagentResult {
	const { base, runId, modelLabel, usage, outcome, backendLabel } = opts;
	finalizeUsage(base, usage, runId, modelLabel);
	base.model = modelLabel;

	if (outcome.aborted) {
		base.status = "cancelled";
		base.error = "aborted";
		base.text = opts.resultText.trim();
		return base;
	}
	if (outcome.timedOut) {
		base.status = "failed";
		base.error = "timeout";
		base.text = opts.resultText.trim();
		return base;
	}
	if (outcome.oversizeError) {
		base.status = "failed";
		base.error = outcome.oversizeError;
		return base;
	}
	if (opts.eventError) {
		base.status = "failed";
		base.error = opts.eventError;
		base.text = opts.resultText.trim();
		return base;
	}
	if (outcome.code !== 0 && outcome.code !== null) {
		const stderr = outcome.stderr.trim();
		base.status = "failed";
		base.error = `${backendLabel} exited with code ${outcome.code}${outcome.signal ? ` (signal ${outcome.signal})` : ""}${stderr ? `: ${stderr}` : ""}`;
		base.text = opts.resultText.trim();
		return base;
	}
	// spawn error (code null, no signal, has stderr message like ENOENT)
	if (outcome.code === null && outcome.stderr && !opts.resultText.trim()) {
		base.status = "failed";
		base.error = outcome.stderr.includes("ENOENT")
			? `${backendLabel} CLI not found on PATH. Install and authenticate it, then retry with cli:${backendLabel}.`
			: outcome.stderr;
		return base;
	}
	// Some CLIs (e.g. agy) may exit 0 while only printing a fatal error on stderr.
	if (!opts.resultText.trim()) {
		const stderr = outcome.stderr.trim();
		if (stderr && /^(error:|fatal:|failed\b)/i.test(stderr)) {
			base.status = "failed";
			base.error = `${backendLabel}: ${stderr}`;
			return base;
		}
	}
	if (!opts.sawTerminal && !opts.resultText.trim()) {
		base.status = "failed";
		base.error = `${backendLabel} exited without a terminal event or output`;
		return base;
	}

	base.status = "completed";
	base.text = opts.resultText.trim() || "(no final text output)";
	return base;
}
