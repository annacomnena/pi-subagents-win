/**
 * Codex request-header compat (lives in subagent-win, independent of agent config).
 *
 * Scope: per-provider enable/disable via /codex-headers.
 * Config: ~/.pi/agent/codex-headers.json
 *
 * Mechanism (two layers):
 *   1. before_provider_headers — mark the request + best-effort early rewrite
 *      (enough for openai-responses / completions where options.headers win).
 *   2. globalThis.fetch wrap — re-apply after pi-ai's openai-codex-responses
 *      hardcodes originator:"pi" / User-Agent:"pi (...)". Marker is stripped
 *      before the wire request leaves.
 *
 * Default rewrites (when a provider is ON):
 *   originator: codex_cli_rs
 *   User-Agent: codex_cli_rs/<ver> (<os>; <arch>)
 *   OAI-Product-Sku: codex   (optional, default on)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, homedir, release, type } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/** Internal marker: set in before_provider_headers, consumed by fetch wrap. */
const MARKER_HEADER = "x-pi-codex-headers-provider";

// ── Config types ───────────────────────────────────────────────────

export interface CodexProviderRule {
	/** When false, this provider is skipped even if global enabled. Default true when present. */
	enabled?: boolean;
	/** Default: codex_cli_rs */
	originator?: string;
	/** Default: codex_cli_rs/0.1.0 (<os> <release>; <arch>) */
	userAgent?: string;
	/** When true (default), set OAI-Product-Sku: codex */
	productSku?: boolean;
}

export interface CodexHeadersConfig {
	/** Master switch. Default false so we never surprise existing providers. */
	enabled: boolean;
	providers: Record<string, CodexProviderRule>;
}

const CONFIG_DIR = () =>
	process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const CONFIG_PATH = () => join(CONFIG_DIR(), "codex-headers.json");

const DEFAULT_ORIGINATOR = "codex_cli_rs";
const DEFAULT_PRODUCT_SKU = "codex";

function defaultUserAgent(): string {
	// Mirrors codex-cli shape: originator/ver (os ver; arch)
	// Version is a static compat string — not tied to a real codex install.
	return `${DEFAULT_ORIGINATOR}/0.1.0 (${type()} ${release()}; ${arch()})`;
}

function emptyConfig(): CodexHeadersConfig {
	return { enabled: false, providers: {} };
}

export function readCodexHeadersConfig(): CodexHeadersConfig {
	const path = CONFIG_PATH();
	if (!existsSync(path)) return emptyConfig();
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<CodexHeadersConfig>;
		return {
			enabled: Boolean(raw.enabled),
			providers: raw.providers && typeof raw.providers === "object" ? raw.providers : {},
		};
	} catch {
		return emptyConfig();
	}
}

export function writeCodexHeadersConfig(cfg: CodexHeadersConfig): void {
	const dir = CONFIG_DIR();
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(CONFIG_PATH(), JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

/** Resolve effective rule for a provider name (case-sensitive as in models.json). */
export function resolveProviderRule(
	cfg: CodexHeadersConfig,
	provider: string | undefined,
): CodexProviderRule | null {
	if (!cfg.enabled || !provider) return null;
	const rule = cfg.providers[provider];
	if (!rule) return null;
	if (rule.enabled === false) return null;
	return rule;
}

/** Resolved header values for a rule (defaults applied). */
export function resolvedHeaderValues(rule: CodexProviderRule): {
	originator: string;
	userAgent: string;
	productSku: string | null;
} {
	return {
		originator: rule.originator?.trim() || DEFAULT_ORIGINATOR,
		userAgent: rule.userAgent?.trim() || defaultUserAgent(),
		productSku: rule.productSku === false ? null : DEFAULT_PRODUCT_SKU,
	};
}

/** Apply codex-compat headers in place. null values delete headers (pi convention). */
export function applyCodexHeaders(
	headers: Record<string, string | null>,
	rule: CodexProviderRule,
	options?: { markProvider?: string },
): void {
	const { originator, userAgent, productSku } = resolvedHeaderValues(rule);

	headers["originator"] = originator;
	// Cover common casings used by fetch / undici / pi-ai
	headers["User-Agent"] = userAgent;
	headers["user-agent"] = userAgent;

	if (productSku) {
		headers["OAI-Product-Sku"] = productSku;
		headers["oai-product-sku"] = productSku;
	}

	// Marker so the fetch wrap can re-apply after openai-codex-responses overwrites.
	if (options?.markProvider) {
		headers[MARKER_HEADER] = options.markProvider;
	}
}

// ── Fetch wrap (final wire-level rewrite) ──────────────────────────

let fetchPatched = false;

function headerMapFromInit(
	input: RequestInfo | URL,
	init?: RequestInit,
): Headers {
	const headers = new Headers();
	if (typeof Request !== "undefined" && input instanceof Request) {
		input.headers.forEach((value, key) => headers.set(key, value));
	}
	if (init?.headers) {
		new Headers(init.headers).forEach((value, key) => headers.set(key, value));
	}
	return headers;
}

function applyRuleToHeaders(headers: Headers, rule: CodexProviderRule): void {
	const { originator, userAgent, productSku } = resolvedHeaderValues(rule);
	headers.set("originator", originator);
	headers.set("User-Agent", userAgent);
	if (productSku) headers.set("OAI-Product-Sku", productSku);
	else {
		headers.delete("OAI-Product-Sku");
		headers.delete("oai-product-sku");
	}
	// Never leak the internal marker onto the wire.
	headers.delete(MARKER_HEADER);
}

/**
 * Install a one-shot globalThis.fetch wrapper.
 * Only rewrites when MARKER_HEADER is present (set by before_provider_headers),
 * so unrelated traffic is untouched.
 */
function installFetchPatch(): void {
	if (fetchPatched) return;
	if (typeof globalThis.fetch !== "function") return;

	const originalFetch = globalThis.fetch.bind(globalThis);

	globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const headers = headerMapFromInit(input, init);
		const marker = headers.get(MARKER_HEADER);
		if (!marker) {
			return originalFetch(input, init);
		}

		const cfg = readCodexHeadersConfig();
		const rule = resolveProviderRule(cfg, marker);
		if (!rule) {
			// Stale marker or disabled mid-flight: strip and pass through.
			headers.delete(MARKER_HEADER);
		} else {
			applyRuleToHeaders(headers, rule);
		}

		// Prefer rewriting a Request clone so body/method/signal stay intact.
		if (typeof Request !== "undefined" && input instanceof Request) {
			return originalFetch(new Request(input, { headers }));
		}
		return originalFetch(input, { ...init, headers });
	};

	fetchPatched = true;
}

// ── Provider discovery (for menu) ──────────────────────────────────

export function listKnownProviders(ctx?: ExtensionContext | ExtensionCommandContext): string[] {
	const names = new Set<string>();

	// From live registry (configured + available)
	try {
		const models = ctx?.modelRegistry?.getAvailable?.() ?? [];
		for (const m of models) {
			if (m?.provider) names.add(m.provider);
		}
	} catch {
		/* ignore */
	}

	// From models.json on disk
	const paths = [
		join(CONFIG_DIR(), "models.json"),
		join(homedir(), ".pi", "models.json"),
	];
	for (const p of paths) {
		if (!existsSync(p)) continue;
		try {
			const raw = JSON.parse(readFileSync(p, "utf8")) as {
				providers?: Record<string, unknown>;
			};
			for (const key of Object.keys(raw.providers ?? {})) {
				names.add(key);
			}
		} catch {
			/* ignore */
		}
	}

	// Already configured rules (even if not in models.json)
	const cfg = readCodexHeadersConfig();
	for (const key of Object.keys(cfg.providers)) names.add(key);

	// Current session model
	if (ctx?.model?.provider) names.add(ctx.model.provider);

	return [...names].sort((a, b) => a.localeCompare(b));
}

function formatProviderLabel(name: string, cfg: CodexHeadersConfig): string {
	const rule = cfg.providers[name];
	if (!rule) return `${name}  [— no rule]`;
	const on = rule.enabled !== false && cfg.enabled;
	const flag = on ? "ON" : rule.enabled === false ? "OFF" : "rule (global off)";
	const origin = rule.originator ?? DEFAULT_ORIGINATOR;
	return `${name}  [${flag}; originator=${origin}]`;
}

function statusText(cfg: CodexHeadersConfig): string {
	const lines = [
		`Codex headers compat`,
		`  config: ${CONFIG_PATH()}`,
		`  global: ${cfg.enabled ? "ON" : "OFF"}`,
	];
	const keys = Object.keys(cfg.providers).sort();
	if (keys.length === 0) {
		lines.push("  providers: (none)");
	} else {
		lines.push("  providers:");
		for (const k of keys) {
			const r = cfg.providers[k];
			const en = r.enabled === false ? "off" : "on";
			lines.push(
				`    ${k}: ${en}` +
					`  originator=${r.originator ?? DEFAULT_ORIGINATOR}` +
					`  productSku=${r.productSku !== false ? "yes" : "no"}`,
			);
		}
	}
	lines.push(
		"",
		"Usage:",
		"  /codex-headers              interactive menu",
		"  /codex-headers status       show config",
		"  /codex-headers on|off       global switch",
		"  /codex-headers <provider> on|off",
		"  /codex-headers current on   enable for session provider",
	);
	return lines.join("\n");
}

// ── Interactive menu ───────────────────────────────────────────────

async function interactiveMenu(ctx: ExtensionCommandContext): Promise<void> {
	const cfg = readCodexHeadersConfig();
	const current = ctx.model?.provider;

	const items = [
		`Toggle global  [now: ${cfg.enabled ? "ON" : "OFF"}]`,
		current
			? `Enable current provider  [${current}]`
			: `Enable current provider  [(no model)]`,
		`Manage providers…`,
		`Show status`,
		`Disable all providers (clear rules)`,
	];

	const pick = await ctx.ui.select("Codex headers compat:", items);
	if (!pick) return;

	if (pick.startsWith("Toggle global")) {
		cfg.enabled = !cfg.enabled;
		writeCodexHeadersConfig(cfg);
		ctx.ui.notify(`codex-headers: global ${cfg.enabled ? "ON" : "OFF"}`, "info");
		return;
	}

	if (pick.startsWith("Enable current provider")) {
		if (!current) {
			ctx.ui.notify("No current model/provider. Use /model first.", "warning");
			return;
		}
		cfg.enabled = true;
		cfg.providers[current] = {
			...(cfg.providers[current] ?? {}),
			enabled: true,
		};
		writeCodexHeadersConfig(cfg);
		ctx.ui.notify(
			`codex-headers: ${current} ON (originator=${cfg.providers[current].originator ?? DEFAULT_ORIGINATOR})`,
			"info",
		);
		return;
	}

	if (pick.startsWith("Show status")) {
		ctx.ui.notify(statusText(cfg), "info");
		return;
	}

	if (pick.startsWith("Disable all")) {
		const ok = await ctx.ui.confirm(
			"Clear all provider rules?",
			"This removes every entry under providers{} and turns global OFF.",
		);
		if (!ok) return;
		writeCodexHeadersConfig(emptyConfig());
		ctx.ui.notify("codex-headers: cleared", "info");
		return;
	}

	if (pick.startsWith("Manage providers")) {
		await manageProvidersMenu(ctx);
	}
}

async function manageProvidersMenu(ctx: ExtensionCommandContext): Promise<void> {
	const providers = listKnownProviders(ctx);
	if (providers.length === 0) {
		ctx.ui.notify(
			"No providers found. Add one in models.json or select a model first.",
			"warning",
		);
		return;
	}

	const cfg = readCodexHeadersConfig();
	const labels = providers.map((p) => formatProviderLabel(p, cfg));
	const selected = await ctx.ui.select("Choose provider:", labels);
	if (!selected) return;
	const idx = labels.indexOf(selected);
	const provider = providers[idx];
	if (!provider) return;

	await providerDetailMenu(ctx, provider);
}

async function providerDetailMenu(
	ctx: ExtensionCommandContext,
	provider: string,
): Promise<void> {
	const cfg = readCodexHeadersConfig();
	const rule = cfg.providers[provider] ?? {};
	const isOn = rule.enabled !== false && Boolean(cfg.providers[provider]) && cfg.enabled;

	const choices = [
		isOn || (cfg.providers[provider] && rule.enabled !== false)
			? `Disable ${provider}`
			: `Enable ${provider}`,
		`Edit originator  [${rule.originator ?? DEFAULT_ORIGINATOR}]`,
		`Edit User-Agent  [${rule.userAgent ? "custom" : "default"}]`,
		`Toggle OAI-Product-Sku  [${rule.productSku !== false ? "ON" : "OFF"}]`,
		`Remove rule for ${provider}`,
		`Back`,
	];

	const pick = await ctx.ui.select(`Provider: ${provider}`, choices);
	if (!pick || pick === "Back") return;

	if (pick.startsWith("Enable ")) {
		cfg.enabled = true;
		cfg.providers[provider] = { ...rule, enabled: true };
		writeCodexHeadersConfig(cfg);
		ctx.ui.notify(`codex-headers: ${provider} ON`, "info");
		return;
	}
	if (pick.startsWith("Disable ")) {
		cfg.providers[provider] = { ...rule, enabled: false };
		writeCodexHeadersConfig(cfg);
		ctx.ui.notify(`codex-headers: ${provider} OFF`, "info");
		return;
	}
	if (pick.startsWith("Edit originator")) {
		const next = await ctx.ui.input(
			`originator for ${provider}`,
			rule.originator ?? DEFAULT_ORIGINATOR,
		);
		if (next === undefined) return;
		const trimmed = next.trim();
		cfg.providers[provider] = {
			...rule,
			enabled: rule.enabled !== false,
			originator: trimmed || DEFAULT_ORIGINATOR,
		};
		writeCodexHeadersConfig(cfg);
		ctx.ui.notify(`codex-headers: ${provider}.originator = ${cfg.providers[provider].originator}`, "info");
		return;
	}
	if (pick.startsWith("Edit User-Agent")) {
		const next = await ctx.ui.input(
			`User-Agent for ${provider} (empty = default)`,
			rule.userAgent ?? defaultUserAgent(),
		);
		if (next === undefined) return;
		const trimmed = next.trim();
		const nextRule: CodexProviderRule = {
			...rule,
			enabled: rule.enabled !== false,
		};
		if (trimmed) nextRule.userAgent = trimmed;
		else delete nextRule.userAgent;
		cfg.providers[provider] = nextRule;
		writeCodexHeadersConfig(cfg);
		ctx.ui.notify(
			`codex-headers: ${provider}.userAgent = ${trimmed || "(default)"}`,
			"info",
		);
		return;
	}
	if (pick.startsWith("Toggle OAI-Product-Sku")) {
		const next = rule.productSku === false;
		cfg.providers[provider] = {
			...rule,
			enabled: rule.enabled !== false,
			productSku: next,
		};
		writeCodexHeadersConfig(cfg);
		ctx.ui.notify(
			`codex-headers: ${provider}.productSku = ${next ? "ON" : "OFF"}`,
			"info",
		);
		return;
	}
	if (pick.startsWith("Remove rule")) {
		delete cfg.providers[provider];
		writeCodexHeadersConfig(cfg);
		ctx.ui.notify(`codex-headers: removed rule for ${provider}`, "info");
	}
}

// ── Text command parsing ───────────────────────────────────────────

async function handleTextCommand(
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const text = args.trim();
	if (!text || text === "status") {
		ctx.ui.notify(statusText(readCodexHeadersConfig()), "info");
		return;
	}

	const parts = text.split(/\s+/).filter(Boolean);
	const cfg = readCodexHeadersConfig();

	// global on|off
	if (parts.length === 1 && (parts[0] === "on" || parts[0] === "off")) {
		cfg.enabled = parts[0] === "on";
		writeCodexHeadersConfig(cfg);
		ctx.ui.notify(`codex-headers: global ${cfg.enabled ? "ON" : "OFF"}`, "info");
		return;
	}

	// current on|off
	if (parts[0] === "current" && (parts[1] === "on" || parts[1] === "off")) {
		const provider = ctx.model?.provider;
		if (!provider) {
			ctx.ui.notify("No current model/provider. Use /model first.", "warning");
			return;
		}
		if (parts[1] === "on") {
			cfg.enabled = true;
			cfg.providers[provider] = { ...(cfg.providers[provider] ?? {}), enabled: true };
		} else {
			cfg.providers[provider] = { ...(cfg.providers[provider] ?? {}), enabled: false };
		}
		writeCodexHeadersConfig(cfg);
		ctx.ui.notify(
			`codex-headers: ${provider} ${parts[1] === "on" ? "ON" : "OFF"}`,
			"info",
		);
		return;
	}

	// <provider> on|off
	if (parts.length >= 2 && (parts[1] === "on" || parts[1] === "off")) {
		const provider = parts[0];
		if (parts[1] === "on") {
			cfg.enabled = true;
			cfg.providers[provider] = { ...(cfg.providers[provider] ?? {}), enabled: true };
		} else {
			cfg.providers[provider] = { ...(cfg.providers[provider] ?? {}), enabled: false };
		}
		writeCodexHeadersConfig(cfg);
		ctx.ui.notify(
			`codex-headers: ${provider} ${parts[1] === "on" ? "ON" : "OFF"}`,
			"info",
		);
		return;
	}

	ctx.ui.notify(
		"Usage: /codex-headers [status|on|off|current on|off|<provider> on|off]",
		"error",
	);
}

// ── Registration ───────────────────────────────────────────────────

/**
 * Wire header rewrite + /codex-headers into the extension host.
 * Safe to call from the main export; inactive until a provider is enabled.
 */
export function registerCodexHeaders(pi: ExtensionAPI): void {
	// Final wire-level rewrite (handles openai-codex-responses overwrite).
	installFetchPatch();

	// Early rewrite + marker. Config is re-read each request so menu toggles
	// apply without /reload.
	pi.on("before_provider_headers", (event, ctx) => {
		const cfg = readCodexHeadersConfig();
		const provider = ctx.model?.provider;
		const rule = resolveProviderRule(cfg, provider);
		if (!rule || !provider) return;
		applyCodexHeaders(event.headers, rule, { markProvider: provider });
	});

	pi.registerCommand("codex-headers", {
		description:
			"按 provider 开关 Codex 请求头兼容（originator / User-Agent / OAI-Product-Sku）",
		handler: async (args, ctx) => {
			const text = (args ?? "").trim();
			// Interactive when no args and UI available
			if (!text && ctx.hasUI) {
				await interactiveMenu(ctx);
				return;
			}
			await handleTextCommand(text, ctx);
		},
	});
}
