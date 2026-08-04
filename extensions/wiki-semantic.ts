import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { Index } from "usearch";

const CONFIG_ENV = "WIKI_EMBEDDINGS_CONFIG";
const STORE_ENV = "WIKI_SEMANTIC_DIR";
const DEFAULT_CONFIG = join(homedir(), ".pi", "agent", "embeddings.json");
const INDEX_VERSION = 1;
const CONNECTIVITY = 16;
const EXPANSION_ADD = 64;
const EXPANSION_SEARCH = 64;

interface EmbeddingModel {
	id: string;
	name?: string;
	dimensions: number;
	maxBatchSize?: number;
}

interface EmbeddingProvider {
	baseUrl: string;
	api: "openai-embeddings";
	apiKey: string;
	models: EmbeddingModel[];
}

interface EmbeddingsConfig {
	providers: Record<string, EmbeddingProvider>;
	default?: string;
}

interface ResolvedEmbeddingModel {
	providerId: string;
	modelId: string;
	baseUrl: string;
	apiKey: string;
	dimensions: number;
	batchSize: number;
}

interface SemanticNode {
	id: string;
	term: string;
	inputHash: string;
}

interface SemanticManifest {
	version: number;
	keywordGeneratedAt: string;
	provider: string;
	model: string;
	dimensions: number;
	nodes: SemanticNode[];
}

interface KeywordIndex {
	version: number;
	generatedAt: string;
	terms: string[];
}

export interface SemanticResult {
	text: string;
	isError?: boolean;
}

export interface SemanticParams {
	action: "semantic-status" | "semantic-rebuild" | "semantic-terms";
	wikiDir?: string;
	queries?: string[];
	limit?: number;
	model?: string;
}

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function configPath(): string {
	return process.env[CONFIG_ENV]?.trim() || DEFAULT_CONFIG;
}

function semanticRoot(wikiDir: string): string {
	const configured = process.env[STORE_ENV]?.trim();
	if (configured) return resolve(configured, hash(resolve(wikiDir)).slice(0, 16));
	return join(homedir(), ".pi", "wiki-semantic", hash(resolve(wikiDir)).slice(0, 16));
}

function readJson<T>(path: string): T | null {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return null;
	}
}

function resolveApiKey(raw: string): string {
	const match = raw.trim().match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/);
	return match ? (process.env[match[1]] ?? "") : raw.trim();
}

function resolveEmbeddingModel(requested?: string): { model?: ResolvedEmbeddingModel; error?: string } {
	const path = configPath();
	const config = readJson<EmbeddingsConfig>(path);
	if (!config?.providers) {
		return { error: `Embedding config not found or invalid: ${path}. Create it with providers/default like ~/.pi/agent/models.json, using api=\"openai-embeddings\".` };
	}
	const ref = requested?.trim() || config.default;
	if (!ref) return { error: `Embedding config ${path} has no default model; pass model=\"provider/id\" or set default.` };
	const slash = ref.indexOf("/");
	if (slash <= 0 || slash === ref.length - 1) return { error: `Embedding model must be provider/id, got \"${ref}\".` };
	const providerId = ref.slice(0, slash);
	const modelId = ref.slice(slash + 1);
	const provider = config.providers[providerId];
	if (!provider) return { error: `Embedding provider \"${providerId}\" is not configured in ${path}.` };
	if (provider.api !== "openai-embeddings") return { error: `Embedding provider \"${providerId}\" must use api=\"openai-embeddings\".` };
	const definition = provider.models?.find((candidate) => candidate.id === modelId);
	if (!definition || !Number.isInteger(definition.dimensions) || definition.dimensions <= 0) {
		return { error: `Embedding model \"${ref}\" needs a positive integer dimensions field.` };
	}
	const apiKey = resolveApiKey(provider.apiKey ?? "");
	if (!apiKey) return { error: `Embedding provider \"${providerId}\" has no resolved apiKey. Use \"$ENV_VAR\" and set that environment variable.` };
	return {
		model: {
			providerId,
			modelId,
			baseUrl: provider.baseUrl.replace(/\/+$/, ""),
			apiKey,
			dimensions: definition.dimensions,
			batchSize: Math.max(1, Math.min(256, definition.maxBatchSize ?? 64)),
		},
	};
}

function loadKeywords(wikiDir: string): { index?: KeywordIndex; error?: string } {
	const path = join(wikiDir, "_keywords.json");
	const index = readJson<KeywordIndex>(path);
	if (!index || index.version !== 2 || !Array.isArray(index.terms)) {
		return { error: `No current v2 _keywords.json under ${wikiDir}. Run wiki-nav rebuild first.` };
	}
	return { index };
}

function vectorPaths(root: string): { manifest: string; vectors: string; index: string } {
	return {
		manifest: join(root, "manifest.json"),
		vectors: join(root, "vectors.json"),
		index: join(root, "index.usearch"),
	};
}

function embeddingText(term: string): string {
	const expanded = term
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.replace(/[_./-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return expanded.toLowerCase() === term.toLowerCase() ? term : `${term}\n${expanded}`;
}

function normalize(vector: number[]): Float32Array {
	const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
	if (!Number.isFinite(norm) || norm === 0) throw new Error("Embedding provider returned a zero-length vector.");
	return new Float32Array(vector.map((value) => value / norm));
}

async function embed(model: ResolvedEmbeddingModel, inputs: string[]): Promise<number[][]> {
	const response = await fetch(`${model.baseUrl}/embeddings`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${model.apiKey}`,
		},
		body: JSON.stringify({ model: model.modelId, input: inputs }),
	});
	if (!response.ok) throw new Error(`Embedding request failed: HTTP ${response.status}.`);
	const payload = await response.json() as { data?: Array<{ index?: number; embedding?: unknown }> };
	if (!Array.isArray(payload.data) || payload.data.length !== inputs.length) throw new Error("Embedding response has an invalid data array.");
	const ordered = [...payload.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
	return ordered.map((item) => {
		if (!Array.isArray(item.embedding) || item.embedding.length !== model.dimensions || !item.embedding.every(Number.isFinite)) {
			throw new Error(`Embedding response dimension does not match configured ${model.dimensions}.`);
		}
		return item.embedding as number[];
	});
}

function loadStore(root: string, model: ResolvedEmbeddingModel): { manifest: SemanticManifest | null; vectors: Record<string, number[]> } {
	const paths = vectorPaths(root);
	const manifest = readJson<SemanticManifest>(paths.manifest);
	const valid = manifest && manifest.version === INDEX_VERSION && manifest.provider === model.providerId && manifest.model === model.modelId && manifest.dimensions === model.dimensions;
	return { manifest: valid ? manifest : null, vectors: valid ? (readJson<Record<string, number[]>>(paths.vectors) ?? {}) : {} };
}

function writeAtomically(path: string, content: string): void {
	const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(temp, content, "utf8");
	renameSync(temp, path);
}

function newIndex(dimensions: number): Index {
	return new Index({
		metric: "cos",
		dimensions,
		connectivity: CONNECTIVITY,
		expansion_add: EXPANSION_ADD,
		expansion_search: EXPANSION_SEARCH,
	});
}

function sanitizeQueries(queries: string[] | undefined): { values?: string[]; error?: string } {
	if (!queries?.length) return { error: "semantic-terms requires queries: an array of 1-5 short phrases." };
	if (queries.length > 5) return { error: "semantic-terms accepts at most 5 short phrases." };
	const values = queries.map((query) => query.trim()).filter(Boolean);
	if (values.length !== queries.length || values.some((query) => query.length < 2 || query.length > 32 || /[\r\n]/.test(query))) {
		return { error: "Each semantic query must be a single 2-32 character phrase, not a full task or paragraph." };
	}
	return { values };
}

export async function semanticStatus(wikiDir: string, requestedModel?: string): Promise<SemanticResult> {
	const keywords = loadKeywords(wikiDir);
	if (!keywords.index) return { text: keywords.error!, isError: true };
	const resolved = resolveEmbeddingModel(requestedModel);
	if (!resolved.model) return { text: resolved.error!, isError: false };
	const root = semanticRoot(wikiDir);
	const { manifest } = loadStore(root, resolved.model);
	const current = manifest?.keywordGeneratedAt === keywords.index.generatedAt && existsSync(vectorPaths(root).index);
	return {
		text: [
			"wiki-nav semantic-status",
			`  model: ${resolved.model.providerId}/${resolved.model.modelId} (${resolved.model.dimensions}d)`,
			`  vocabulary: ${keywords.index.terms.length} terms`,
			`  index: ${current ? "current" : "missing or stale"}`,
			`  store: ${root}`,
		].join("\n"),
	};
}

export async function semanticRebuild(wikiDir: string, requestedModel?: string): Promise<SemanticResult> {
	const keywords = loadKeywords(wikiDir);
	if (!keywords.index) return { text: keywords.error!, isError: true };
	const resolved = resolveEmbeddingModel(requestedModel);
	if (!resolved.model) return { text: resolved.error!, isError: true };
	const model = resolved.model;
	const root = semanticRoot(wikiDir);
	mkdirSync(root, { recursive: true });
	const { vectors } = loadStore(root, model);
	const nodes = keywords.index.terms.map((term, offset) => ({ id: String(offset), term, inputHash: hash(`${model.providerId}/${model.modelId}\0${embeddingText(term)}`) }));
	const missing = nodes.filter((node) => !vectors[node.inputHash]);
	for (let start = 0; start < missing.length; start += model.batchSize) {
		const batch = missing.slice(start, start + model.batchSize);
		const embeddings = await embed(model, batch.map((node) => embeddingText(node.term)));
		for (let i = 0; i < batch.length; i++) vectors[batch[i].inputHash] = [...normalize(embeddings[i])];
	}
	const index = newIndex(model.dimensions);
	for (const node of nodes) index.add(BigInt(node.id), normalize(vectors[node.inputHash]));
	const paths = vectorPaths(root);
	const indexTemp = `${paths.index}.${process.pid}.${Date.now()}.tmp`;
	index.save(indexTemp);
	renameSync(indexTemp, paths.index);
	const manifest: SemanticManifest = {
		version: INDEX_VERSION,
		keywordGeneratedAt: keywords.index.generatedAt,
		provider: model.providerId,
		model: model.modelId,
		dimensions: model.dimensions,
		nodes,
	};
	writeAtomically(paths.manifest, JSON.stringify(manifest, null, 2) + "\n");
	writeAtomically(paths.vectors, JSON.stringify(vectors) + "\n");
	return { text: `wiki-nav semantic-rebuild OK\n  ${nodes.length} terms (${missing.length} remotely embedded, ${nodes.length - missing.length} cached)\n  model: ${model.providerId}/${model.modelId}\n  store: ${root}` };
}

export async function semanticTerms(wikiDir: string, queries: string[] | undefined, limitRaw?: number, requestedModel?: string): Promise<SemanticResult> {
	const clean = sanitizeQueries(queries);
	if (!clean.values) return { text: clean.error!, isError: true };
	const keywords = loadKeywords(wikiDir);
	if (!keywords.index) return { text: keywords.error!, isError: true };
	const exactByLower = new Map(keywords.index.terms.map((term) => [term.toLowerCase(), term]));
	const exact = new Map<string, string>();
	const misses: string[] = [];
	for (const query of clean.values) {
		const term = exactByLower.get(query.toLowerCase());
		if (term) exact.set(query, term);
		else misses.push(query);
	}
	const limit = Math.max(1, Math.min(10, Math.floor(limitRaw ?? 5)));
	const lines = ["wiki-nav semantic-terms"];
	for (const [query, term] of exact) lines.push(`  ${query}: exact → ${term}`);
	if (misses.length === 0) {
		lines.push("\nAll phrases had exact vocabulary terms. Locate selected terms with: grep -rni \"<term>\" Wiki/");
		return { text: lines.join("\n") };
	}
	const resolved = resolveEmbeddingModel(requestedModel);
	if (!resolved.model) return { text: `${lines.join("\n")}\n\nExact misses require configured remote embeddings: ${resolved.error}`, isError: false };
	const model = resolved.model;
	const root = semanticRoot(wikiDir);
	const paths = vectorPaths(root);
	const manifest = readJson<SemanticManifest>(paths.manifest);
	if (!manifest || manifest.version !== INDEX_VERSION || manifest.keywordGeneratedAt !== keywords.index.generatedAt || manifest.provider !== model.providerId || manifest.model !== model.modelId || manifest.dimensions !== model.dimensions || !existsSync(paths.index)) {
		return { text: `${lines.join("\n")}\n\nSemantic index is missing or stale. Run wiki-nav semantic-rebuild first.`, isError: false };
	}
	const index = newIndex(model.dimensions);
	index.load(paths.index);
	const embeddings = await embed(model, misses.map(embeddingText));
	for (let i = 0; i < misses.length; i++) {
		const results = index.search(normalize(embeddings[i]), limit);
		const candidates: string[] = [];
		for (let j = 0; j < results.keys.length; j++) {
			const node = manifest.nodes[Number(results.keys[j])];
			if (!node) continue;
			const score = 1 - results.distances[j];
			candidates.push(`${node.term}  ${score.toFixed(3)}`);
		}
		lines.push(`  ${misses[i]}: candidates`);
		for (const candidate of candidates) lines.push(`    · ${candidate}`);
	}
	lines.push("\nCandidates are vocabulary hints, not facts. Select a term, then: grep -rni \"<term>\" Wiki/");
	return { text: lines.join("\n") };
}
