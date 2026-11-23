/**
 * 模型别名解析、本地模型目录读取与角色默认模型解析
 * 拆分自 extensions/index.ts (Phase 1.2)
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isExternalCliModel, normalizeExternalCliModel } from "./external-cli.ts";

export interface LocalModelEntry {
	provider: string;
	id: string;
	name?: string;
}

export interface AgentDef {
	name: string;
	description?: string;
	frontmatterModel?: string;
	frontmatterThinking?: string;
	frontmatterTools?: string[];
	sourcePath: string;
}

export interface ModelCatalogConfig {
	models: Record<string, string>;
	thinking: Record<string, string>;
	[key: string]: unknown;
}

let cachedModelCatalog: LocalModelEntry[] | null = null;

export function clearModelCatalogCache(): void {
	cachedModelCatalog = null;
}

export function loadLocalModelCatalog(): LocalModelEntry[] {
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

/** Normalize free-form model requests into provider/id for pi --model, or cli:<backend> (default model only). */
export function normalizeModelRef(raw?: string | null): string | undefined {
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

/** Resolve defaults at the call seam so config changes apply without recreating agents. */
export function agentDefaultModel(agent?: AgentDef | null, cfg?: ModelCatalogConfig): string | undefined {
	if (!agent) return undefined;
	return agent.frontmatterModel ?? cfg?.models[agent.name];
}

export function agentDefaultThinking(agent?: AgentDef | null, cfg?: ModelCatalogConfig): string | undefined {
	if (!agent) return undefined;
	return agent.frontmatterThinking ?? cfg?.thinking[agent.name];
}

export function resolveCallModel(override?: string, agent?: AgentDef | null, cfg?: ModelCatalogConfig): string | undefined {
	// Call-site model always wins over agent frontmatter / current config defaults.
	return normalizeModelRef(override) ?? agentDefaultModel(agent, cfg);
}

export function displayModelForCall(
	override: string | undefined,
	agentName: string | undefined,
	agent?: AgentDef | null,
	cfg?: ModelCatalogConfig,
): string {
	const defaultModel = agentDefaultModel(agent, cfg) ?? (agentName && cfg ? cfg.models[agentName] : undefined);
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
