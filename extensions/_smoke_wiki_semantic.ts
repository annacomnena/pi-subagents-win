// Smoke test for remote embedding + USearch HNSW semantic term expansion.
// Uses a local OpenAI-compatible mock; no external provider, API key, or Wiki content is sent.
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { semanticRebuild, semanticStatus, semanticTerms } from "./wiki-semantic.ts";

const tmp = mkdtempSync(join(tmpdir(), "subagent-win-semantic-"));
const wikiDir = join(tmp, "Wiki");
const configPath = join(tmp, "embeddings.json");
const storeRoot = join(tmp, "store");
mkdirSync(wikiDir, { recursive: true });
writeFileSync(join(wikiDir, "_keywords.json"), JSON.stringify({
	version: 2,
	generatedAt: "2026-07-27T00:00:00.000Z",
	terms: ["AreaRole", "ForbiddenPlacementPipeline", "PlacementCandidateSet"],
}), "utf8");

let requests = 0;
const vectorFor = (text: string): number[] => {
	if (/forbidden|禁止/i.test(text)) return [1, 0, 0];
	if (/area|区域/.test(text)) return [0, 1, 0];
	return [0, 0, 1];
};
const server = createServer(async (req, res) => {
	if (req.method !== "POST" || req.url !== "/v1/embeddings") {
		res.writeHead(404).end();
		return;
	}
	let raw = "";
	for await (const chunk of req) raw += chunk;
	const body = JSON.parse(raw) as { input: string[] };
	requests++;
	res.setHeader("content-type", "application/json");
	res.end(JSON.stringify({ data: body.input.map((text, index) => ({ index, embedding: vectorFor(text) })) }));
});

function check(name: string, fn: () => void): void {
	try {
		fn();
		console.log("  ✓ " + name);
	} catch (err) {
		console.error("  ✗ " + name + "\n    " + (err as Error).message);
		throw err;
	}
}

try {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("mock server did not bind");
	process.env.WIKI_EMBEDDINGS_CONFIG = configPath;
	process.env.WIKI_SEMANTIC_DIR = storeRoot;
	process.env.TEST_EMBED_KEY = "test-key";
	writeFileSync(configPath, JSON.stringify({
		providers: {
			mock: {
				baseUrl: `http://127.0.0.1:${address.port}/v1`,
				api: "openai-embeddings",
				apiKey: "$TEST_EMBED_KEY",
				models: [{ id: "tiny", dimensions: 3, maxBatchSize: 10 }],
			},
		},
		default: "mock/tiny",
	}), "utf8");

	console.log("wiki semantic smoke — local OpenAI-compatible mock + USearch HNSW");
	const rebuilt = await semanticRebuild(wikiDir);
	check("semantic-rebuild embeds all new vocabulary terms", () => {
		assert.ok(!rebuilt.isError, rebuilt.text);
		assert.match(rebuilt.text, /3 terms \(3 remotely embedded, 0 cached\)/);
		assert.equal(requests, 1);
	});
	const status = await semanticStatus(wikiDir);
	check("semantic-status reports a current HNSW index", () => {
		assert.match(status.text, /index: current/);
		assert.match(status.text, /mock\/tiny \(3d\)/);
	});
	const terms = await semanticTerms(wikiDir, ["AreaRole", "禁止布置"]);
	check("semantic-terms keeps exact matches local and expands only misses", () => {
		assert.ok(!terms.isError, terms.text);
		assert.match(terms.text, /AreaRole: exact → AreaRole/);
		assert.match(terms.text, /禁止布置: candidates/);
		assert.match(terms.text, /ForbiddenPlacementPipeline  1\.000/);
		assert.doesNotMatch(terms.text, /Wiki\/[A-Z]|sourcePath|\.md/);
		assert.match(terms.text, /grep -rni/);
		assert.equal(requests, 2, "one build request + one miss-query request");
	});
	const rebuiltAgain = await semanticRebuild(wikiDir);
	check("second rebuild reuses cached vectors", () => {
		assert.match(rebuiltAgain.text, /0 remotely embedded, 3 cached/);
		assert.equal(requests, 2);
	});
	const rejected = await semanticTerms(wikiDir, ["这是一个不应整体送入语义检索的完整多行任务\n第二行"]);
	check("semantic-terms rejects task paragraphs", () => {
		assert.equal(rejected.isError, true);
		assert.match(rejected.text, /single 2-32 character phrase/);
	});
	console.log("\nAll semantic assertions passed.");
} finally {
	delete process.env.WIKI_EMBEDDINGS_CONFIG;
	delete process.env.WIKI_SEMANTIC_DIR;
	delete process.env.TEST_EMBED_KEY;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	rmSync(tmp, { recursive: true, force: true });
}
