// Smoke test for wiki-nav.ts dispatch logic (assertion-based).
// Run: node ./scripts/ensure-pi-test-deps.mjs && node --experimental-strip-types ./extensions/_smoke_wiki_nav.ts
//
// Exit code 0 = all assertions pass; non-zero = failure.
// Black-box via the exported dispatch(); indirectly covers buildTree / acts / ancestors / trimming.
import { dispatch } from "./wiki-nav.ts";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

// ── fixture: a small tree with one stale + one hidden page ────────
const nav = {
	version: 1,
	generatedAt: "2026-07-27T00:00:00Z",
	pages: [
		{ id: "Modules/plants_ui", title: "Plants UI", aliases: ["Planting Interface"], kind: "module", status: "current", tags: ["ui", "plants"], parentId: null, navOrder: 10, navHidden: false, mdFile: "Modules/plants_ui.md", updated: "2026-07-01", groupId: "Modules" },
		{ id: "Modules/plant_seed", title: "Plant Seed", aliases: [], kind: "module", status: "stale", tags: ["plants"], parentId: "Modules/plants_ui", navOrder: 5, navHidden: false, mdFile: "Modules/plant_seed.md", updated: "2025-01-01", groupId: "Modules" },
		{ id: "Modules/plant_harvest", title: "Harvest", aliases: [], kind: "module", status: "current", tags: ["plants"], parentId: "Modules/plants_ui", navOrder: 20, navHidden: false, mdFile: "Modules/plant_harvest.md", updated: "2026-06-01", groupId: "Modules" },
		{ id: "Architecture/state_sync", title: "State Sync", aliases: ["State Bus"], kind: "contract", status: "current", tags: ["state"], parentId: null, navOrder: 5, navHidden: false, mdFile: "Architecture/state_sync.md", updated: "2026-05-01", groupId: "Architecture" },
		{ id: "Concepts/legacy_auth", title: "Legacy Auth", aliases: [], kind: "concept", status: "current", tags: ["auth"], parentId: null, navOrder: 30, navHidden: true, mdFile: "Concepts/legacy_auth.md", updated: "2024-01-01", groupId: "Concepts" },
	],
};

const tmp = mkdtempSync(join(tmpdir(), "subagent-win-wiki-nav-"));
const wikiDir = join(tmp, "Wiki");
mkdirSync(wikiDir, { recursive: true });
writeFileSync(join(wikiDir, "_navigation.json"), JSON.stringify(nav), "utf8");

const opts = { wikiDir };
let passed = 0;
function check(name, fn) {
	try {
		fn();
		passed++;
		console.log("  ✓ " + name);
	} catch (err) {
		console.error("  ✗ " + name + "\n    " + err.message);
		throw err;
	}
}

try {
	console.log("wiki-nav smoke — fixture has 5 pages (1 hidden, 1 stale)");

	// 1. tree depth 1: top-level only, hidden page excluded
	const t1 = dispatch({ action: "tree", depth: 1, ...opts });
	check("tree depth=1 lists top-level, excludes hidden", () => {
		assert.match(t1.text, /Plants UI/);
		assert.match(t1.text, /State Sync/);
		assert.doesNotMatch(t1.text, /Legacy Auth/); // navHidden excluded from tree
	});

	// 2. tree depth 2: reveals children of plants_ui
	const t2 = dispatch({ action: "tree", depth: 2, ...opts });
	check("tree depth=2 reveals plant_seed & plant_harvest", () => {
		assert.match(t2.text, /Plant Seed/);
		assert.match(t2.text, /Harvest/);
	});

	// 3. around by id: ancestors + siblings + descendants
	const a1 = dispatch({ action: "around", node: "Modules/plants_ui", depth: 2, ...opts });
	check("around by id lists descendants", () => {
		assert.match(a1.text, /Plant Seed/);
		assert.match(a1.text, /ancestor path/);
		assert.match(a1.text, /top-level/); // plants_ui has no parent
	});

	// 4. around by alias: "State Bus" resolves to state_sync
	const a2 = dispatch({ action: "around", node: "State Bus", depth: 1, ...opts });
	check("around resolves alias 'State Bus'", () => {
		assert.match(a2.text, /State Sync/);
	});

	// 5. find "plants": matches plant pages (title/tags); hidden legacy_auth must NOT match "plants"
	const f1 = dispatch({ action: "find", query: "plants", depth: 1, ...opts });
	check("find 'plants' matches plant pages, not hidden auth", () => {
		assert.match(f1.text, /plants/);
		assert.match(f1.text, /Plants UI|Plant Seed|Harvest/);
		assert.doesNotMatch(f1.text, /Legacy Auth/);
	});

	// 6. find "auth": hidden page IS searchable (find searches hidden too)
	const f2 = dispatch({ action: "find", query: "auth", depth: 1, ...opts });
	check("find 'auth' matches the hidden page", () => {
		assert.match(f2.text, /Legacy Auth/);
	});

	// 7. path: ancestor chain to a nested node
	const p1 = dispatch({ action: "path", node: "Modules/plant_seed", ...opts });
	check("path shows ancestor chain", () => {
		assert.match(p1.text, /Plants UI/);
		assert.match(p1.text, /Plant Seed/);
	});

	// 8. missing index: hint, not an execution error
	const m1 = dispatch({ action: "tree", wikiDir: join(tmp, "nope") });
	check("missing index returns build hint, isError falsy", () => {
		assert.match(m1.text, /_navigation\.json/);
		assert.match(m1.text, /build|grep|wiki/i);
		assert.ok(!m1.isError, "missing index must not be flagged as an error");
	});

	// 9. around with unknown node: not-found hint (normal feedback, not an error)
	const e1 = dispatch({ action: "around", node: "Does/Not/Exist", ...opts });
	check("around unknown node -> not-found hint, isError falsy", () => {
		assert.match(e1.text, /not found/);
		assert.ok(!e1.isError, "unknown node is normal feedback, not an error");
	});

	// 10. around without node: usage error
	const e2 = dispatch({ action: "around", ...opts });
	check("around without node -> usage error", () => {
		assert.equal(e2.isError, true);
	});

	// 11. tree must not silently fall back to root when its requested page is absent.
	const e3 = dispatch({ action: "tree", node: "Modules", ...opts });
	check("tree unknown node -> explicit not-found, never root tree", () => {
		assert.match(e3.text, /node "Modules" not found/);
		assert.doesNotMatch(e3.text, /Plants UI/);
	});

	// ── rebuild：从真实 .md 文件重建索引 ──
	const rbDir = join(tmp, "WikiRB", "Wiki");
	mkdirSync(join(rbDir, "Modules"), { recursive: true });
	mkdirSync(join(rbDir, "Architecture"), { recursive: true });
	writeFileSync(join(rbDir, "Modules", "plants_ui.md"), [
		"---",
		"title: Plants UI",
		"kind: module",
		"status: current",
		"tags:",
		"  - ui",
		"  - plants",
		"aliases:",
		"  - Planting Interface",
		"nav_order: 10",
		"source_paths:",
		"  - src/ForbiddenPlacementPipeline.ts#L1",
		"---",
		"# Plants UI",
		"## Forbidden Placement",
		"Forbidden placement is rejected inside the protected zone.",
	].join("\n"), "utf8");
	writeFileSync(join(rbDir, "Architecture", "state_sync.md"), [
		"---",
		'title: "State Sync"',
		"kind: contract",
		"status: current",
		"parent: Plants UI",
		"nav_order: 5",
		"---",
		"body",
	].join("\n"), "utf8");
	// a maintenance file that must be skipped (starts with _)
	writeFileSync(join(rbDir, "_maintenance.md"), "---\ntitle: Should Be Skipped\nstatus: current\n---\n", "utf8");

	const rbOpts = { wikiDir: join(tmp, "WikiRB", "Wiki") };
	const rb = dispatch({ action: "rebuild", ...rbOpts });
	check("rebuild writes index for 2 pages (skips _maintenance)", () => {
		assert.ok(!rb.isError, "rebuild must not error: " + rb.text);
		assert.match(rb.text, /rebuild OK/);
		assert.match(rb.text, /2 pages/);
		assert.doesNotMatch(rb.text, /Should Be Skipped|3 pages/);
	});

	// verify the generated _navigation.json content
	{
		const nav2 = JSON.parse(readFileSync(join(rbDir, "_navigation.json"), "utf8"));
		check("generated index has correct pages + parent resolution", () => {
			assert.equal(nav2.pages.length, 2);
			const st = nav2.pages.find((p) => p.id === "Architecture/state_sync");
			assert.equal(st.parentId, "Modules/plants_ui", "parent 'Plants UI' must resolve to the page id");
			assert.equal(st.title, "State Sync");
			const ui = nav2.pages.find((p) => p.id === "Modules/plants_ui");
			assert.deepEqual(ui.aliases, ["Planting Interface"]);
		});
		check("generated v2 _search.json exists", () => {
			assert.ok(existsSync(join(rbDir, "_search.json")), "_search.json written");
			const s = JSON.parse(readFileSync(join(rbDir, "_search.json"), "utf8"));
			assert.equal(s.version, 2, "search index must support full-text queries");
			assert.ok(s.terms && Object.keys(s.terms).length > 0, "search index has terms");
			assert.ok(s.terms.forbidden?.includes("Modules/plants_ui"), "Markdown body terms must be indexed");
		});
		check("generated _keywords.json is a compact global term list", () => {
			assert.ok(existsSync(join(rbDir, "_keywords.json")), "_keywords.json written");
			const k = JSON.parse(readFileSync(join(rbDir, "_keywords.json"), "utf8"));
			assert.equal(k.version, 2);
			assert.ok(Array.isArray(k.terms));
			assert.ok(k.terms.includes("ForbiddenPlacementPipeline"), "source-path symbols must be searchable");
			assert.ok(!k.terms.includes("Forbidden Placement"), "Markdown headings must not enter the vocabulary");
			assert.equal(k.pages, undefined, "global vocabulary must not include page mappings");
		});
	}

	// after rebuild, queries against the rebuilt dir work and see the tree
	const t3 = dispatch({ action: "tree", depth: 2, ...rbOpts });
	check("query works on rebuilt index", () => {
		assert.match(t3.text, /Plants UI/);
		assert.match(t3.text, /State Sync/); // child of plants_ui visible at depth 2
	});
	const f3 = dispatch({ action: "find", query: "forbidden placement", ...rbOpts });
	check("find queries Markdown body through the full-text index", () => {
		assert.match(f3.text, /Plants UI/);
		assert.match(f3.text, /full-text/);
	});
	const k1 = dispatch({ action: "keywords", query: "forbidden", ...rbOpts });
	check("keywords query returns a term only, with grep as the locator", () => {
		assert.match(k1.text, /ForbiddenPlacementPipeline/);
		assert.match(k1.text, /grep -rni/);
		assert.doesNotMatch(k1.text, /Plants UI|Modules\/plants_ui/);
	});
	const k2 = dispatch({ action: "keywords", queries: ["Planting Interface", "unknown phrase"], ...rbOpts });
	check("keywords queries preserves metadata aliases and performs exact-only checks", () => {
		assert.match(k2.text, /Planting Interface: exact → Planting Interface/);
		assert.match(k2.text, /unknown phrase: exact → \(none\)/);
		assert.match(k2.text, /Only exact misses may be sent to semantic-terms/);
	});

	console.log(`\nAll ${passed} assertions passed.`);
} finally {
	rmSync(tmp, { recursive: true, force: true });
}
