/**
 * wiki-nav — 渐进式 Wiki 导航查询工具（pi tool）
 *
 * 解决问题：随着 Wiki 覆盖整个库，`Wiki/_navigation.json`（全局树）会膨胀到
 * 几十~几百 KB（几千~几万 token），一次 read 会撑爆 <200K 上下文模型。
 * 本工具不返回整个索引，而是按**要求的层级数量**调取**附近节点**，
 * 让 agent 用"全局视野 → 定位 → 深入"的渐进式探索，token 可控。
 *
 * 数据源：wiki-and-task 的 `build_wiki_navigation.py` 生成的 `Wiki/_navigation.json`
 * （派生数据，非手写）。仓库无此文件时返回提示并建议构建 / 回退 grep。
 *
 * 九个动作：
 *   tree     [--depth N] [--node <id>]  从根（或某节点）往下 N 层
 *   around   <id> [--depth N]            某节点邻域：祖先链 + 兄弟 + 子孙 N 层
 *   find     <keyword> [--depth N]       按索引的标题/aliases/tags/正文匹配，带父链
 *   keywords [--query <q>]              自动生成的全局可检索术语表（不含地址）
 *   path     <id>                        从根到该节点的祖先链
 *   rebuild                              从 Wiki/*.md 重建导航、全文与关键词索引
 *   semantic-status                      检查私有术语 HNSW 索引状态
 *   semantic-rebuild                     显式调用远程 embedding，增量重建术语 HNSW 索引
 *   semantic-terms <phrases[]>           对 exact miss 短语返回术语候选（随后 grep 定位）
 *
 * 输出：树形文本（缩进表层级），每页只给精简导航元数据（id/title/status/kind/子节点数），
 * 不含正文——所以"附近 N 层"很便宜。子节点过多时裁剪 + 提示再 drill down。
 */

import { existsSync, statSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { semanticRebuild, semanticStatus, semanticTerms } from "./wiki-semantic.ts";

// ── 数据结构（对应 build_wiki_navigation.py 的输出）──────────────

interface WikiNavPage {
	id: string;
	title: string;
	aliases: string[];
	kind: string;
	status: string;
	tags: string[];
	parentId: string | null;
	navOrder: number;
	navHidden: boolean;
	mdFile: string;
	updated: string;
	groupId: string | null;
}

interface NavigationIndex {
	version: number;
	generatedAt: string;
	pages: WikiNavPage[];
}

interface SearchIndex {
	version: number;
	generatedAt: string;
	terms: Record<string, string[]>;
}

/** Compact global vocabulary derived from Wiki source; never hand-maintained or used for page location. */
interface KeywordIndex {
	version: number;
	generatedAt: string;
	terms: string[];
}

// ── 索引加载（带 mtime 缓存）──────────────────────────────────────

interface CachedIndex {
	path: string;
	mtimeMs: number;
	index: NavigationIndex;
}

let cache: CachedIndex | null = null;
const DEFAULT_WIKI_DIR = "Wiki";

function wikiDirFromEnv(): string {
	return (process.env.WIKI_NAV_DIR ?? DEFAULT_WIKI_DIR).trim() || DEFAULT_WIKI_DIR;
}

function navigationPath(wikiDir: string): string {
	const root = process.cwd();
	const dir = isAbsolute(wikiDir) ? wikiDir : resolve(root, wikiDir);
	return join(dir, "_navigation.json");
}

function searchPath(wikiDir: string): string {
	const root = process.cwd();
	const dir = isAbsolute(wikiDir) ? wikiDir : resolve(root, wikiDir);
	return join(dir, "_search.json");
}

function keywordsPath(wikiDir: string): string {
	const root = process.cwd();
	const dir = isAbsolute(wikiDir) ? wikiDir : resolve(root, wikiDir);
	return join(dir, "_keywords.json");
}

/** Resolve a page id by id / title / alias (first unique match). */
function resolvePageId(index: NavigationIndex, token: string): WikiNavPage | null {
	if (!token) return null;
	const lower = token.toLowerCase();
	const byId = index.pages.find((p) => p.id.toLowerCase() === lower);
	if (byId) return byId;
	const byTitle = index.pages.filter((p) => p.title.toLowerCase() === lower);
	if (byTitle.length === 1) return byTitle[0];
	const byAlias = index.pages.filter((p) => aliasHas(p, lower));
	if (byAlias.length === 1) return byAlias[0];
	return null;
}

// attach a tiny helper onto pages via standalone functions to avoid mutating JSON shape
const aliasHas = (page: WikiNavPage, lowerAlias: string): boolean =>
	(page.aliases ?? []).some((a) => (a ?? "").toLowerCase() === lowerAlias);

function loadIndex(wikiDir?: string): NavigationIndex | null {
	const dir = wikiDir?.trim() || wikiDirFromEnv();
	const path = navigationPath(dir);
	if (!existsSync(path)) return null;
	let mtimeMs = 0;
	try {
		mtimeMs = statSync(path).mtimeMs;
	} catch {
		return null;
	}
	if (cache && cache.path === path && cache.mtimeMs === mtimeMs) {
		return cache.index;
	}
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as NavigationIndex;
		if (!raw || !Array.isArray(raw.pages)) return null;
		cache = { path, mtimeMs, index: raw };
		return raw;
	} catch {
		return null;
	}
}

/** Load the v2 full-text index generated alongside navigation. Invalid/stale indexes are ignored. */
function loadSearchIndex(wikiDir: string, navigation: NavigationIndex): SearchIndex | null {
	const path = searchPath(wikiDir);
	if (!existsSync(path)) return null;
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as SearchIndex;
		if (raw.version !== 2 || raw.generatedAt !== navigation.generatedAt || !raw.terms) return null;
		return raw;
	} catch {
		return null;
	}
}

function loadKeywordIndex(wikiDir: string, navigation: NavigationIndex): KeywordIndex | null {
	const path = keywordsPath(wikiDir);
	if (!existsSync(path)) return null;
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as KeywordIndex;
		if (raw.version !== 2 || raw.generatedAt !== navigation.generatedAt || !Array.isArray(raw.terms)) return null;
		return raw;
	} catch {
		return null;
	}
}

// ── 树形结构辅助 ──────────────────────────────────────────────────

interface TreeModel {
	pages: WikiNavPage[];
	byId: Map<string, WikiNavPage>;
	childrenOf: Map<string | null, WikiNavPage[]>;
}

function buildTree(index: NavigationIndex): TreeModel {
	const byId = new Map<string, WikiNavPage>();
	const childrenOf = new Map<string | null, WikiNavPage[]>();
	for (const p of index.pages) byId.set(p.id, p);
	for (const p of index.pages) {
		// parent sanity: ignore parentId that points to a non-existent page
		const parent = p.parentId && byId.has(p.parentId) ? p.parentId : null;
		const list = childrenOf.get(parent) ?? [];
		list.push(p);
		childrenOf.set(parent, list);
	}
	// stable sort each bucket: navOrder, then title, then id
	for (const list of childrenOf.values()) {
		list.sort(
			(a, b) =>
				a.navOrder - b.navOrder ||
				a.title.localeCompare(b.title) ||
				a.id.localeCompare(b.id),
		);
	}
	return { pages: index.pages, byId, childrenOf };
}

function visibleChildren(model: TreeModel, id: string | null): WikiNavPage[] {
	const all = model.childrenOf.get(id) ?? [];
	return all.filter((p) => !p.navHidden);
}

function ancestors(model: TreeModel, id: string): WikiNavPage[] {
	const chain: WikiNavPage[] = [];
	const seen = new Set<string>();
	let current = model.byId.get(id) ?? null;
	while (current && !seen.has(current.id)) {
		seen.add(current.id);
		chain.unshift(current);
		current = current.parentId ? (model.byId.get(current.parentId) ?? null) : null;
	}
	return chain;
}

// ── 裁剪 / 渲染 ────────────────────────────────────────────────────

const MAX_CHILDREN_VISIBLE = 12;

interface RenderOpts {
	depth: number;
}

interface NodeLine {
	page: WikiNavPage;
	indent: number;
	visibleChildren: number; // total (pre-trim) direct children
	totalChildren: number;
}

/** Collect a subtree up to `depth` levels, trimming wide nodes. */
function collectSubtree(
	model: TreeModel,
	rootId: string | null,
	maxDepth: number,
): NodeLine[] {
	const out: NodeLine[] = [];
	const walk = (id: string | null, indent: number, remaining: number): void => {
		if (remaining < 0) return;
		const allChildren = model.childrenOf.get(id) ?? [];
		const vis = visibleChildren(model, id);
		const trimmed = vis.slice(0, MAX_CHILDREN_VISIBLE);
		for (const child of trimmed) {
			out.push({
				page: child,
				indent,
				visibleChildren: visibleChildren(model, child.id).length,
				totalChildren: allChildren.length,
			});
			if (remaining > 0) walk(child.id, indent + 1, remaining - 1);
		}
	};
	walk(rootId, 0, maxDepth - 1);
	return out;
}

const STATUS_ICON: Record<string, string> = {
	current: "✓",
	stale: "⚠",
	draft: "…",
	proposed: "○",
};

function pageSig(page: WikiNavPage, model: TreeModel): string {
	const icon = STATUS_ICON[page.status] ?? "·";
	const kind = page.kind ? `${page.kind}` : "";
	const kids = visibleChildren(model, page.id).length;
	const kidsStr = kids > 0 ? ` (${kids}↓)` : "";
	const kindStr = kind ? ` ${kind}` : "";
	return `${icon} ${page.title}${kindStr}${kidsStr}  [${page.id}]`;
}

function renderLines(model: TreeModel, lines: NodeLine[]): string[] {
	const out: string[] = [];
	for (const line of lines) {
		const pad = "  ".repeat(line.indent);
		out.push(`${pad}▸ ${pageSig(line.page, model)}`);
		if (line.visibleChildren > MAX_CHILDREN_VISIBLE) {
			out.push(
				`${pad}    … +${line.visibleChildren - MAX_CHILDREN_VISIBLE} more — wiki-nav around "${line.page.id}"`,
			);
		}
	}
	return out;
}

function headerSummary(model: TreeModel): string {
	const total = model.pages.length;
	const roots = visibleChildren(model, null).length;
	const stale = model.pages.filter((p) => p.status === "stale").length;
	const hidden = model.pages.filter((p) => p.navHidden).length;
	const parts = [
		`${total} pages`,
		`${roots} top-level`,
	];
	if (stale > 0) parts.push(`${stale} stale`);
	if (hidden > 0) parts.push(`${hidden} hidden`);
	return parts.join(" · ");
}

// ── 动作实现 ───────────────────────────────────────────────────────

function actTree(model: TreeModel, node: string | undefined, depth: number): string {
	const head = node
		? resolvePageId({ pages: model.pages } as NavigationIndex, node)
		: null;
	if (node && !head) {
		return `wiki-nav tree: node "${node}" not found. Node must be a page id, title, or unique alias; directory names alone are not nodes. Use wiki-nav find "<topic>" first.`;
	}
	const rootId = head ? head.id : null;
	const label = head ? `subtree of "${head.title}" [${head.id}]` : "top-level tree";
	const collected = collectSubtree(model, rootId, depth);
	const topLevelCount = rootId === null ? visibleChildren(model, null).length : 0;
	const lines = [
		`wiki-nav tree  (depth=${depth}, ${label})`,
		`${headerSummary(model)}`,
		"",
		...renderLines(model, collected),
	];
	if (topLevelCount > MAX_CHILDREN_VISIBLE) {
		lines.push(`… root view is trimmed: ${MAX_CHILDREN_VISIBLE} of ${topLevelCount} top-level pages shown. Use wiki-nav find "<topic>" to locate another page.`);
	}
	if (collected.length === 0) lines.push("(no visible pages at this level)");
	return lines.join("\n");
}

function actAround(model: TreeModel, node: string, depth: number): string {
	const target = resolvePageId({ pages: model.pages } as NavigationIndex, node);
	if (!target) {
		return `wiki-nav around: node "${node}" not found.\nUse wiki-nav find "<keyword>" to discover ids, or wiki-nav tree for top-level.`;
	}
	const chain = ancestors(model, target.id);
	const parent = target.parentId && model.byId.has(target.parentId) ? target.parentId : null;
	const siblings = visibleChildren(model, parent).filter((p) => p.id !== target.id);
	const descendants = collectSubtree(model, target.id, depth);

	const lines: string[] = [];
	lines.push(`wiki-nav around  (depth=${depth})  ${pageSig(target, model)}`);
	lines.push("");
	lines.push("ancestor path:");
	if (chain.length <= 1) {
		lines.push("  (top-level)");
	} else {
		for (const a of chain.slice(0, -1)) {
			lines.push(`  ‹ ${pageSig(a, model)}`);
		}
	}
	lines.push("");
	lines.push("siblings:");
	const sibShown = siblings.slice(0, MAX_CHILDREN_VISIBLE);
	if (sibShown.length === 0) lines.push("  (none)");
	for (const s of sibShown) lines.push(`  = ${pageSig(s, model)}`);
	if (siblings.length > MAX_CHILDREN_VISIBLE) {
		lines.push(`  … +${siblings.length - MAX_CHILDREN_VISIBLE} more`);
	}
	lines.push("");
	lines.push("descendants:");
	if (descendants.length === 0) {
		lines.push("  (no visible children)");
	} else {
		lines.push(...renderLines(model, descendants));
	}
	return lines.join("\n");
}

function actFind(model: TreeModel, search: SearchIndex | null, query: string, depth: number): string {
	const q = query.trim().toLowerCase();
	if (!q) return "wiki-nav find: empty query.";
	let matches: WikiNavPage[];
	let source: string;
	if (search) {
		const queryTerms = [...tokenize(q)];
		const matchingIds = queryTerms.reduce<Set<string> | null>((intersection, term) => {
			const ids = search.terms[term] ?? [];
			if (intersection === null) return new Set(ids);
			return new Set([...intersection].filter((id) => ids.includes(id)));
		}, null) ?? new Set<string>();
		matches = model.pages.filter((p) => matchingIds.has(p.id));
		source = "full-text";
	} else {
		const terms = q.split(/\s+/);
		matches = model.pages.filter((p) => {
			const hay = [p.id, p.title, ...(p.aliases ?? []), ...(p.tags ?? [])].join(" ").toLowerCase();
			return terms.every((t) => hay.includes(t));
		});
		source = "metadata only (run wiki-nav rebuild to enable full-text)";
	}
	if (matches.length === 0) {
		return `wiki-nav find "${query}": no matches (${source}).\nDo not inspect index JSON or repeat rebuild unless Wiki changed. Try a shorter/distinctive term, then grep -rni "${query}" Wiki/ for an exact body search.`;
	}
	const shown = matches.slice(0, 20);
	const lines = [
		`wiki-nav find "${query}"  (${matches.length} match${matches.length === 1 ? "" : "es"}${matches.length > shown.length ? `, showing ${shown.length}` : ""}; ${source})`,
		"",
	];
	for (const p of shown) {
		const chain = ancestors(model, p.id)
			.slice(0, -1)
			.map((a) => a.title);
		const where = chain.length ? `  ‹ ${chain.join(" ‹ ")}` : "  (top-level)";
		lines.push(`  ${pageSig(p, model)}${where}`);
	}
	if (matches.length > shown.length) {
		lines.push(`  … +${matches.length - shown.length} more — refine your query`);
	}
	lines.push("");
	lines.push(`Drill in with: wiki-nav around "<id>" --depth ${depth}`);
	return lines.join("\n");
}

function actKeywords(keywords: KeywordIndex | null, query: string | undefined, queries: string[] | undefined, limitRaw: number | undefined): string {
	if (!keywords) return "wiki-nav keywords: no current _keywords.json. Run wiki-nav rebuild after Wiki changes.";
	if (queries?.length) {
		if (queries.length > 5 || queries.some((value) => value.trim().length < 2 || value.trim().length > 32 || /[\r\n]/.test(value))) {
			return "wiki-nav keywords: queries accepts 1-5 single 2-32 character phrases.";
		}
		const exactByLower = new Map(keywords.terms.map((term) => [term.toLowerCase(), term]));
		const lines = ["wiki-nav keywords exact"];
		const misses: string[] = [];
		for (const value of queries) {
			const phrase = value.trim();
			const exact = exactByLower.get(phrase.toLowerCase());
			if (exact) lines.push(`  ${phrase}: exact → ${exact}`);
			else {
				lines.push(`  ${phrase}: exact → (none)`);
				misses.push(phrase);
			}
		}
		if (misses.length) lines.push(`\nOnly exact misses may be sent to semantic-terms: ${misses.join(" | ")}`);
		else lines.push("\nAll phrases are exact vocabulary terms. Locate selected terms with: grep -rni \"<term>\" Wiki/");
		return lines.join("\n");
	}
	const limit = Math.max(1, Math.min(100, Math.floor(limitRaw ?? 50)));
	const parts = query?.trim().toLowerCase().split(/\s+/).filter(Boolean) ?? [];
	const matches = keywords.terms
		.filter((term) => parts.every((part) => term.toLowerCase().includes(part)))
		.slice(0, limit);
	if (matches.length === 0) {
		return query?.trim()
			? `wiki-nav keywords "${query}": no vocabulary terms match. Try another fragment or use grep -rni "${query}" Wiki/.`
			: "wiki-nav keywords: no searchable terms generated.";
	}
	const scope = query?.trim() ? ` "${query}"` : "";
	const lines = [`wiki-nav keywords${scope}  (${matches.length} term${matches.length === 1 ? "" : "s"} shown${keywords.terms.length > matches.length ? ` of ${keywords.terms.length}` : ""})`, ""];
	for (const term of matches) lines.push(`  · ${term}`);
	if (query?.trim()) lines.push(`\nLocate a selected term with: grep -rni "<term>" Wiki/`);
	else if (keywords.terms.length > matches.length) lines.push("\nUse keywords query=\"<fragment>\" to narrow the vocabulary, then grep -rni \"<term>\" Wiki/.");
	return lines.join("\n");
}

function actPath(model: TreeModel, node: string): string {
	const target = resolvePageId({ pages: model.pages } as NavigationIndex, node);
	if (!target) {
		return `wiki-nav path: node "${node}" not found.`;
	}
	const chain = ancestors(model, target.id);
	const lines = [`wiki-nav path  [${target.id}]`];
	for (let i = 0; i < chain.length; i++) {
		const indent = "  ".repeat(i);
		lines.push(`${indent}${i === chain.length - 1 ? "◉" : "▸"} ${pageSig(chain[i], model)}`);
	}
	return lines.join("\n");
}

// ── 入口/调度 ──────────────────────────────────────────────────────

// ── rebuild：从 Wiki/*.md 重建 _navigation.json + _search.json ─────

const ALLOWED_STATUS = new Set(["current", "draft", "proposed", "stale"]);
const NAV_WORD_RE = /[a-z0-9]{2,}|[\u3400-\u9fff]+/g;

function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
function asStrList(v: unknown): string[] {
	if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
	if (typeof v === "string" && v.trim()) return [v.trim()];
	return [];
}
function numOr(v: unknown, dflt: number): number {
	const n = Number(v);
	return Number.isFinite(n) ? n : dflt;
}
function boolOr(v: unknown, dflt: boolean): boolean {
	if (typeof v === "boolean") return v;
	const s = String(v ?? "").trim().toLowerCase();
	if (s === "true" || s === "yes" || s === "1") return true;
	if (s === "false" || s === "no" || s === "0") return false;
	return dflt;
}
function unquote(s: string): string {
	const t = s.trim();
	if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
		return t.slice(1, -1);
	return t;
}
function parseScalar(val: string): unknown {
	const t = val.trim();
	if (t.startsWith("[") && t.endsWith("]")) {
		return t.slice(1, -1).split(",").map((x) => unquote(x)).filter((x) => x !== "");
	}
	return unquote(t);
}

/** Parse a simple YAML frontmatter block (key: value, multi-line & inline lists, quotes). */
export function parseFrontmatter(md: string): { fm: Record<string, unknown>; body: string } {
	const fm: Record<string, unknown> = {};
	if (!md.startsWith("---")) return { fm, body: md };
	const lines = md.split(/\r?\n/);
	let end = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === "---") {
			end = i;
			break;
		}
	}
	if (end === -1) return { fm, body: md };
	const body = lines.slice(end + 1).join("\n");
	let curKey: string | null = null;
	for (const raw of lines.slice(1, end)) {
		const line = raw.replace(/\s+$/, "");
		if (!line.trim()) continue;
		const itemMatch = line.match(/^\s+-\s+(.*)$/);
		if (itemMatch && curKey) {
			const arr = (fm[curKey] as unknown[]) ?? (fm[curKey] = []);
			if (Array.isArray(arr)) arr.push(unquote(itemMatch[1]));
			continue;
		}
		const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
		if (!m) continue;
		curKey = m[1];
		const val = m[2].trim();
		fm[curKey] = val === "" ? [] : parseScalar(val);
	}
	return { fm, body };
}

function resolveWikiDir(wikiDirRaw?: string): string {
	return wikiDirRaw?.trim() || wikiDirFromEnv();
}

/** Tokenize Latin words + CJK unigrams/bigrams for the search index. */
function tokenize(text: string): Set<string> {
	const terms = new Set<string>();
	for (const m of text.matchAll(NAV_WORD_RE)) {
		const w = m[0];
		if (/[a-z0-9]/.test(w[0])) {
			terms.add(w);
		} else {
			for (const ch of w) terms.add(ch);
			for (let i = 0; i < w.length - 1; i++) terms.add(w.slice(i, i + 2));
		}
	}
	return terms;
}

const KEYWORD_STOP_WORDS = new Set([
	"and", "are", "for", "from", "into", "not", "the", "this", "that", "with", "wiki",
	"page", "section", "source", "paths", "code", "true", "false", "null", "none",
]);
const CODE_IDENTIFIER_RE = /\b[A-Za-z_][A-Za-z0-9_]{2,}\b/g;
const MAX_KEYWORDS_PER_PAGE = 64;

function cleanKeyword(raw: string): string {
	return raw
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/[`*_#>|]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** Extract compact, inspectable terms from metadata and code anchors, never headings or raw body-word soup. */
function extractKeywords(page: {
	title: string; aliases: string[]; tags: string[]; sourcePaths: string[]; body: string;
}): string[] {
	const scores = new Map<string, { term: string; score: number }>();
	const add = (raw: string, score: number) => {
		const term = cleanKeyword(raw);
		const key = term.toLowerCase();
		if (term.length < 2 || term.length > 100 || KEYWORD_STOP_WORDS.has(key)) return;
		const old = scores.get(key);
		if (!old || score > old.score) scores.set(key, { term, score });
	};
	// Page metadata is the canonical human vocabulary and must never be crowded out by API symbols.
	add(page.title, 1000);
	for (const alias of page.aliases) add(alias, 990);
	for (const tag of page.tags) add(tag, 980);
	for (const bold of page.body.matchAll(/\*\*([^*]{2,100})\*\*/g)) add(bold[1], 65);
	const addIdentifiers = (text: string, score: number) => {
		for (const ident of text.matchAll(CODE_IDENTIFIER_RE)) {
			const token = ident[0];
			if (/^L\d+$/i.test(token)) continue; // source_paths line anchors, not domain terms
			if (/[A-Z_]/.test(token) || token.length >= 8) add(token, score);
		}
	};
	// Source paths are verified API anchors. Extract only their file/symbol tails, never directory names.
	for (const sourcePath of page.sourcePaths) {
		const tail = sourcePath.replace(/\\/g, "/").split("/").pop() ?? sourcePath;
		addIdentifiers(tail, 98);
	}
	for (const code of page.body.matchAll(/`([^`]{2,120})`/g)) addIdentifiers(code[1], 88);
	return [...scores.values()]
		.sort((a, b) => b.score - a.score || a.term.localeCompare(b.term))
		.slice(0, MAX_KEYWORDS_PER_PAGE)
		.map(({ term }) => term);
}

/** Rebuild _navigation.json + _search.json from Wiki/*.md. Best-effort: always writes a usable index, reports warnings. */
export function actRebuild(wikiDirRaw?: string): { text: string; isError?: boolean } {
	const dir = resolveWikiDir(wikiDirRaw);
	const root = process.cwd();
	const abs = isAbsolute(dir) ? dir : resolve(root, dir);
	if (!existsSync(abs)) {
		return { text: `wiki-nav rebuild: Wiki directory not found: ${abs}`, isError: true };
	}

	let mdFiles: string[];
	try {
		mdFiles = (readdirSync(abs, { recursive: true }) as string[])
			.map((f) => String(f))
			.filter((f) => f.endsWith(".md"));
	} catch (err) {
		return { text: `wiki-nav rebuild: cannot read ${abs}: ${errMsg(err)}`, isError: true };
	}
	// drop generated/maintenance markdown except _index.md
	mdFiles = mdFiles.filter((f) => {
		const base = (f.replace(/\\/g, "/").split("/").pop() ?? f).toLowerCase();
		return base === "_index.md" || !base.startsWith("_");
	});

	const warnings: string[] = [];
	interface RawPage {
		id: string; title: string; aliases: string[]; kind: string; status: string;
		tags: string[]; sourcePaths: string[]; parent: string; navOrder: number; navHidden: boolean;
		mdFile: string; updated: string; groupId: string | null; body: string;
	}
	const rawPages: RawPage[] = [];

	for (const rel of mdFiles) {
		const posix = rel.replace(/\\/g, "/");
		let md: string;
		try {
			md = readFileSync(join(abs, posix), "utf8");
		} catch (err) {
			warnings.push(`${posix}: unreadable (${errMsg(err)})`);
			continue;
		}
		const { fm, body } = parseFrontmatter(md);
		const id = posix.replace(/\.md$/, "");
		const status = String(fm.status ?? "");
		if (status && !ALLOWED_STATUS.has(status)) warnings.push(`${posix}: unsupported status '${status}'`);
		rawPages.push({
			id,
			title: String(fm.title ?? posix.split("/").pop()?.replace(/\.md$/, "") ?? id),
			aliases: asStrList(fm.aliases),
			kind: String(fm.kind ?? ""),
			status,
			tags: asStrList(fm.tags),
			sourcePaths: asStrList(fm.source_paths),
			parent: String(fm.parent ?? ""),
			navOrder: numOr(fm.nav_order, 1000),
			navHidden: boolOr(fm.nav_hidden, false),
			mdFile: posix,
			updated: String(fm.updated ?? ""),
			groupId: posix.includes("/") ? posix.slice(0, posix.lastIndexOf("/")) : null,
			body,
		});
	}

	// identity (id/title/alias) -> set of ids, for parent resolution
	const lookup = new Map<string, Set<string>>();
	const addIdent = (ident: string, id: string) => {
		const k = ident.toLowerCase();
		const s = lookup.get(k) ?? new Set<string>();
		s.add(id);
		lookup.set(k, s);
	};
	for (const p of rawPages) {
		addIdent(p.id, p.id);
		addIdent(p.title, p.id);
		for (const a of p.aliases) addIdent(a, p.id);
	}

	// resolve parent -> parentId
	const pages: WikiNavPage[] = rawPages.map((p) => {
		let parentId: string | null = null;
		if (p.parent) {
			const cands = lookup.get(p.parent.toLowerCase());
			if (!cands || cands.size === 0) warnings.push(`${p.mdFile}: unknown parent '${p.parent}'`);
			else if (cands.size > 1) warnings.push(`${p.mdFile}: ambiguous parent '${p.parent}'`);
			else parentId = [...cands][0];
		}
		return {
			id: p.id, title: p.title, aliases: p.aliases, kind: p.kind, status: p.status,
			tags: p.tags, parentId, navOrder: p.navOrder, navHidden: p.navHidden,
			mdFile: p.mdFile, updated: p.updated, groupId: p.groupId,
		};
	});
	const pageById = new Map(pages.map((p) => [p.id, p]));

	// cycle detection
	for (const p of pages) {
		const seen = new Set<string>([p.id]);
		let cur = p.parentId;
		while (cur) {
			if (seen.has(cur)) {
				warnings.push(`${p.mdFile}: parent cycle involving '${cur}'`);
				p.parentId = null;
				break;
			}
			seen.add(cur);
			cur = pageById.get(cur)?.parentId ?? null;
		}
	}

	pages.sort(
		(a, b) => a.navOrder - b.navOrder || a.title.localeCompare(b.title) || a.id.localeCompare(b.id),
	);
	const generatedAt = new Date().toISOString();

	writeFileSync(
		join(abs, "_navigation.json"),
		JSON.stringify({ version: 1, generatedAt, pages }, null, 2) + "\n",
		"utf8",
	);

	// Full-text search index (term -> page ids): navigation metadata plus Markdown body.
	const rawById = new Map(rawPages.map((p) => [p.id, p]));
	const terms = new Map<string, Set<string>>();
	for (const p of pages) {
		const body = rawById.get(p.id)?.body ?? "";
		const hay = [p.id, p.title, ...p.aliases, ...p.tags, body].join(" ").toLowerCase();
		for (const term of tokenize(hay)) {
			const s = terms.get(term) ?? new Set<string>();
			s.add(p.id);
			terms.set(term, s);
		}
	}
	const searchObj: Record<string, string[]> = {};
	for (const [k, v] of [...terms].sort()) searchObj[k] = [...v].sort();
	writeFileSync(
		join(abs, "_search.json"),
		JSON.stringify({ version: 2, generatedAt, terms: searchObj }) + "\n",
		"utf8",
	);

	// Compact global vocabulary only. It intentionally stores neither page ids nor source locations.
	const keywordTerms = new Map<string, string>();
	for (const page of pages) {
		const raw = rawById.get(page.id);
		for (const term of raw ? extractKeywords(raw) : []) {
			const key = term.toLowerCase();
			if (!keywordTerms.has(key)) keywordTerms.set(key, term);
		}
	}
	const keywordList = [...keywordTerms.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, term]) => term);
	writeFileSync(
		join(abs, "_keywords.json"),
		JSON.stringify({ version: 2, generatedAt, terms: keywordList }, null, 2) + "\n",
		"utf8",
	);

	cache = null; // invalidate; next query reloads from disk

	const navPath = join(abs, "_navigation.json").replace(/\\/g, "/");
	const lines = [
		`wiki-nav rebuild OK`,
		`  ${pages.length} pages → ${navPath}`,
		`  search index → ${join(abs, "_search.json").replace(/\\/g, "/")}`,
		`  keyword index → ${join(abs, "_keywords.json").replace(/\\/g, "/")}`,
	];
	if (warnings.length > 0) {
		lines.push(`  ⚠ ${warnings.length} warning(s):`);
		for (const w of warnings.slice(0, 20)) lines.push(`    - ${w}`);
		if (warnings.length > 20) lines.push(`    … +${warnings.length - 20} more`);
	}
	return { text: lines.join("\n") };
}

interface WikiNavParams {
	action: "tree" | "around" | "find" | "keywords" | "path" | "rebuild" | "semantic-status" | "semantic-rebuild" | "semantic-terms";
	node?: string;
	query?: string;
	queries?: string[];
	model?: string;
	depth?: number;
	limit?: number;
	wikiDir?: string;
}

export function dispatch(params: WikiNavParams): { text: string; isError?: boolean } {
	// rebuild 不依赖已有索引：它从 Wiki/*.md 生成索引
	if (params.action === "rebuild") return actRebuild(params.wikiDir);
	const wikiDir = params.wikiDir?.trim() || undefined;
	const index = loadIndex(wikiDir);
	if (!index) {
		const dir = wikiDir ?? wikiDirFromEnv();
		return {
			text:
				`wiki-nav: no \`_navigation.json\` found under \`${dir}/\`.\n` +
				`This repo has no built Wiki navigation index yet.\n` +
				`Options:\n` +
				`  • Run \`wiki-nav rebuild\` to generate it from Wiki/*.md (TS, self-contained).\n` +
				`  • Or the wiki-and-task builder: python .agents/skills/wiki-and-task/scripts/build_wiki_navigation.py --root .\n` +
				`  • Or fall back to \`grep\`/\`read\` directly on Wiki/ pages.\n` +
				`Once built, wiki-nav gives a global, depth-limited view instead of crawling links.`,
			isError: false,
		};
	}
	const model = buildTree(index);
	const indexDir = wikiDir ?? wikiDirFromEnv();
	const search = loadSearchIndex(indexDir, index);
	const keywords = loadKeywordIndex(indexDir, index);
	const depth = Math.max(1, Math.min(5, Math.floor(params.depth ?? 1)));
	switch (params.action) {
		case "tree":
			return { text: actTree(model, params.node, depth) };
		case "around":
			if (!params.node) return { text: "wiki-nav around: requires `node` (a page id). Use find/tree first.", isError: true };
			return { text: actAround(model, params.node, depth) };
		case "find":
			if (!params.query) return { text: "wiki-nav find: requires `query`.", isError: true };
			return { text: actFind(model, search, params.query, depth) };
		case "keywords":
			return { text: actKeywords(keywords, params.query, params.queries, params.limit) };
		case "path":
			if (!params.node) return { text: "wiki-nav path: requires `node` (a page id).", isError: true };
			return { text: actPath(model, params.node) };
		default:
			return { text: `wiki-nav: async or unknown action "${params.action}". Use tree|around|find|keywords|path|rebuild through dispatch.`, isError: true };
	}
}

// ── 注册 ───────────────────────────────────────────────────────────

export function registerWikiNav(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "wiki-nav",
		label: "Wiki Nav",
		description: [
			"渐进式查询 Wiki 导航索引 `_navigation.json`，按层级调取附近节点（不读整个索引）。",
			"动作：tree（从根/某节点往下 N 层）| around <id>（祖先链+兄弟+子孙 N 层）| find <关键词>（v2 全文：metadata+正文）| keywords（自动生成、无地址的可检索术语表）| path <id>（根→该节点）| rebuild（本地重建导航/全文/关键词索引）| semantic-status | semantic-rebuild（显式远程 embedding 建 HNSW）| semantic-terms（只扩展 exact miss 短语为术语候选）。",
			"depth 控制层数（1-5，默认1）；node 接受 id/title/alias；keywords 的 query 过滤术语、无参数给裁剪术语表、queries 对 1-5 个短语做 exact-only 批量检查。semantic-terms 只接收这些 exact miss，再远程查询。语义结果只给术语；选择术语后用 grep 定位。", 
			"无 _navigation.json 时提示构建/回退 grep。用于搜索阶段拿全局视野、定位主题页后再 read 章节。", 
		].join(" "),
		parameters: Type.Object({
			action: Type.Optional(
				Type.String({
					description: "tree | around | find | keywords | path | rebuild | semantic-status | semantic-rebuild | semantic-terms。rebuild 仅本地重建索引；semantic-rebuild 才调用远程 embedding。", 
				}),
			),
			node: Type.Optional(
				Type.String({
					description: "tree 的起始节点 / around、path 的目标页面。接受 page id、title 或 alias。", 
				}),
			),
			query: Type.Optional(
				Type.String({ description: "find 的全文查询，或 keywords 的术语过滤（空格为 AND）。" }),
			),
			queries: Type.Optional(
				Type.Array(Type.String({ description: "keywords 的 exact-only 批量检查或 semantic-terms 的 1-5 个短语，每个 2-32 字符；禁止传完整任务或段落。" })),
			),
			model: Type.Optional(
				Type.String({ description: "可选 embedding provider/id；未给时用 ~/.pi/agent/embeddings.json 的 default。" }),
			),
			depth: Type.Optional(
				Type.Number({ description: "tree/around/find 的展开层数 1-5，默认 1。" }),
			),
			limit: Type.Optional(
				Type.Number({ description: "keywords 返回术语数 1-100，或 semantic-terms 每短语候选数 1-10。" }),
			),
			wikiDir: Type.Optional(
				Type.String({ description: "Wiki 目录（默认 Wiki，或 WIKI_NAV_DIR 环境变量）。" }),
			),
		}),

		renderCall(args, theme) {
			const a = args as WikiNavParams;
			const action = a.action ?? "tree";
			const bits: string[] = [theme.fg("toolTitle", theme.bold("wiki-nav")), theme.fg("accent", action)];
			if ((action === "find" || action === "keywords") && a.query) bits.push(theme.fg("dim", `"${a.query}"`));
			if ((action === "semantic-terms" || action === "keywords") && a.queries?.length) bits.push(theme.fg("dim", a.queries.join(" | ")));
			if ((action === "semantic-status" || action === "semantic-rebuild" || action === "semantic-terms") && a.model) bits.push(theme.fg("muted", a.model));
			if ((action === "around" || action === "path" || (action === "tree" && a.node)) && a.node)
				bits.push(theme.fg("dim", a.node));
			if (a.depth && a.depth !== 1) bits.push(theme.fg("muted", `depth=${a.depth}`));
			if (a.limit) bits.push(theme.fg("muted", `limit=${a.limit}`));
			return new Text(bits.join(" "), 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			if (!expanded) {
				const first = text.split("\n").slice(0, 2).join("\n");
				return new Text(first, 0, 0);
			}
			const c = new Container();
			for (const line of text.split("\n")) {
				c.addChild(new Text(line, 0, 0));
			}
			c.addChild(new Spacer(1));
			c.addChild(new Text(theme.fg("dim", "Drill: wiki-nav around \"<id>\" --depth N · read <page>.md#section"), 0, 0));
			return c;
		},

		async execute(_toolCallId, rawParams) {
			const params = rawParams as WikiNavParams;
			const wikiDir = params.wikiDir?.trim() || wikiDirFromEnv();
			const out = params.action === "semantic-status"
				? await semanticStatus(wikiDir, params.model)
				: params.action === "semantic-rebuild"
					? await semanticRebuild(wikiDir, params.model)
					: params.action === "semantic-terms"
						? await semanticTerms(wikiDir, params.queries, params.limit, params.model)
						: dispatch(params);
			return {
				content: [{ type: "text", text: out.text }],
				isError: out.isError,
			};
		},
	});
}
