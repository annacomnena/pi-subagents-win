#!/usr/bin/env node
/**
 * check-development-contracts.mjs — 开发约束契约检查（S0.1）
 *
 * 为什么需要它：`Wiki/Development/Implementation-Gates.md` 声称「本页是强制约束」。
 * 但只靠人/agent 自觉读文档，无法防止两种情况：
 *   ① 文档里引用的路径已经不存在（文档腐烂，读者以为有据可查，实际打不开）；
 *   ② 新加的开发页没人导航到（写进去了但没人读 —— R-17 同形）。
 * 本脚本只做机械可判的那部分；它不能替代运行时测试（行为约束仍需代码级测试）。
 *
 * 检查项：
 *   C1 Wiki/Development/Implementation-Gates.md 存在且含 gate 定义
 *   C2 每个 gate 必须有 gate_id / feature / status，且 gate_id 唯一
 *   C3 gate.status 必须在允许集合内（blocked | open）
 *   C4 两类文档 frontmatter 里的 source_paths 指向的**仓库内路径**必须存在
 *      （跳过以 plans/ 开头的 —— 那是 gitignored 草稿，允许不存在）
 *   C5 Wiki/Development/ 下每个 .md 都必须被 Wiki/_index.md 导航到
 *   C6 Wiki/Development/Current-Roadmap.md 里引用的 [[页面名]] 必须能在 Wiki 里解析到
 *
 * 用法：node ./scripts/check-development-contracts.mjs
 * 退出码 0 = 全过；1 = 有失败项（逐条打印）
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEV_DIR = join(repoRoot, "Wiki", "Development");
const GATES = join(DEV_DIR, "Implementation-Gates.md");
const ROADMAP = join(DEV_DIR, "Current-Roadmap.md");
const WIKI_INDEX = join(repoRoot, "Wiki", "_index.md");
const ALLOWED_GATE_STATUS = new Set(["blocked", "open"]);

let pass = 0;
const fails = [];
function check(name, ok, detail) {
	if (ok) {
		pass++;
	} else {
		fails.push(`${name}${detail ? `: ${detail}` : ""}`);
	}
}

/** 解析 YAML frontmatter 的 source_paths 列表（只支持本仓使用的简单块状列表） */
function parseFrontmatter(text) {
	const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!m) return null;
	const body = m[1];
	const out = { raw: body, sourcePaths: [] };
	const sp = body.match(/^source_paths:\s*\r?\n((?:\s+-\s+.*\r?\n)+)/m);
	if (sp) {
		out.sourcePaths = sp[1]
			.split(/\r?\n/)
			.map((l) => l.replace(/^\s+-\s+/, "").trim())
			.filter(Boolean);
	}
	return out;
}

// ── C1 ────────────────────────────────────────────────────────────────
const gateText = existsSync(GATES) ? readFileSync(GATES, "utf8") : null;
check("C1 Implementation-Gates.md 存在", gateText !== null);
check("C1 gates 文件含 gate 定义", !!gateText && /gate_id:/g.test(gateText));

// ── C2/C3 ─────────────────────────────────────────────────────────────
const gateIds = [];
const gateStatuses = [];
if (gateText) {
	for (const line of gateText.split(/\r?\n/)) {
		const idm = line.match(/^\s*gate_id:\s*(\S+)/);
		if (idm) gateIds.push(idm[1]);
		const sm = line.match(/^\s*status:\s*(\S+)/);
		// 只收 gate 块内的 status（gate 块以 gate_id 之后出现），用简单状态跟踪
		if (sm && gateIds.length > 0) gateStatuses.push(sm[1]);
	}
}
check("C2 至少定义 1 个 gate", gateIds.length > 0, `gate_ids=${gateIds.length}`);
const dupIds = gateIds.filter((v, i) => gateIds.indexOf(v) !== i);
check("C2 gate_id 唯一", dupIds.length === 0, `重复=${dupIds.join(",")}`);
check("C2 每个 gate 都有 feature", !gateText || (gateText.match(/gate_id:/g) || []).length === (gateText.match(/^\s*feature:/gm) || []).length,
	`gate_id=${(gateText?.match(/gate_id:/g) || []).length} feature=${(gateText?.match(/^\s*feature:/gm) || []).length}`);

// C3：gate 块内（gate_id 之后到下一个 gate_id / 标题之前）的**第一个** status 才是 gate 自身状态。
// （后面 requires[].status 是前置项状态，不得混淆。2026-11-25 实测踩中过。）
if (gateText) {
	const lines = gateText.split(/\r?\n/);
	let curId = null;
	let seenStatusForCur = false;
	for (const line of lines) {
		const idm = line.match(/^\s*gate_id:\s*(\S+)/);
		if (idm) {
			curId = idm[1];
			seenStatusForCur = false;
			continue;
		}
		if (curId && /^#{1,3}\s/.test(line)) {
			curId = null;
			continue;
		}
		if (curId && !seenStatusForCur) {
			const sm = line.match(/^\s*status:\s*(\S+)/);
			if (sm) {
				seenStatusForCur = true;
				check(`C3 gate "${curId}" status 合法`, ALLOWED_GATE_STATUS.has(sm[1]), `status=${sm[1]}`);
			}
		}
	}
}
// 每个 gate 必须出现一次 status（在 gate 块内，通常是 gate_id 之后的第三行）
check("C3 gate 数量与 status 行数量匹配", gateIds.length > 0 && gateStatuses.length >= gateIds.length,
	`gates=${gateIds.length} statusLines=${gateStatuses.length}`);

// ── C4 ────────────────────────────────────────────────────────────────
const docsToCheck = [GATES, ROADMAP];
const wikiDir = join(repoRoot, "Wiki");
if (existsSync(wikiDir)) {
	for (const sub of readdirSync(wikiDir)) {
		const p = join(wikiDir, sub);
		if (statSync(p).isDirectory()) {
			for (const f of readdirSync(p)) if (f.endsWith(".md")) docsToCheck.push(join(p, f));
		} else if (sub.endsWith(".md")) {
			docsToCheck.push(p);
		}
	}
}
let pathChecked = 0;
let pathSkipped = 0;
for (const doc of docsToCheck) {
	if (!existsSync(doc)) continue;
	const fm = parseFrontmatter(readFileSync(doc, "utf8"));
	if (!fm) continue;
	for (const sp of fm.sourcePaths) {
		// 允许 URL / 以 plans/ 开头的草稿
		if (/^[a-z]+:\/\//i.test(sp) || sp.startsWith("plans/") || sp.startsWith("node_modules/")) {
			pathSkipped++;
			continue;
		}
		pathChecked++;
		// 既有 Wiki 页用三种锚点格式：`file`、`file#L123-L456`（行号）、`file::Symbol`（符号）。
		// 只校验“路径部分”是否存在；锚点部分由 wiki-nav / 读者自行解析。
		const filePart = sp.split(/::|#/)[0].replace(/^```+/, "").trim();
		if (!filePart) {
			pathSkipped++;
			continue;
		}
		const abs = join(repoRoot, filePart.replace(/^\.\//, ""));
		check(`C4 ${doc.replace(repoRoot, "").replace(/\\/g, "/")} 的 source_path 存在`, existsSync(abs), sp);
	}
}
console.log(`[C4] 核对仓库内路径 ${pathChecked} 条，跳过 plans/ 草稿 ${pathSkipped} 条`);

// ── C5 ────────────────────────────────────────────────────────────────
if (existsSync(DEV_DIR) && existsSync(WIKI_INDEX)) {
	const indexText = readFileSync(WIKI_INDEX, "utf8");
	for (const f of readdirSync(DEV_DIR)) {
		if (!f.endsWith(".md")) continue;
		const stem = f.replace(/\.md$/, "");
		const p = join(DEV_DIR, f);
		// 判据与 C6 一致：文件名 **或** title 任一被 _index.md 引用即算导航
		const titleMatch = readFileSync(p, "utf8").match(/^title:\s*(.+)$/m);
		const title = titleMatch ? titleMatch[1].trim() : null;
		const named = indexText.includes(stem) || (title !== null && indexText.includes(title));
		check(`C5 Wiki/Development/${f} 被 _index.md 导航`, named, `未在 _index.md 出现（stem=${stem}, title=${title}）`);
	}
}

// ── C6 ────────────────────────────────────────────────────────────────
/** 收集 Wiki 全部页面的 title / 文件名，用于解析 [[名称]] */
const wikiNames = new Set();
function collectWiki(dir) {
	if (!existsSync(dir)) return;
	for (const e of readdirSync(dir)) {
		const p = join(dir, e);
		if (statSync(p).isDirectory()) collectWiki(p);
		else if (e.endsWith(".md")) {
			wikiNames.add(e.replace(/\.md$/, ""));
			const t = readFileSync(p, "utf8").match(/^title:\s*(.+)$/m);
			if (t) wikiNames.add(t[1].trim());
		}
	}
}
collectWiki(wikiDir);
if (existsSync(ROADMAP)) {
	const t = readFileSync(ROADMAP, "utf8");
	const links = [...t.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1].trim());
	for (const l of links) {
		check(`C6 [[${l}]] 可解析`, wikiNames.has(l), "Wiki 中无同名页面/标题");
	}
	console.log(`[C6] 核对 wiki 链接 ${links.length} 条`);
}

// ── 汇总 ──────────────────────────────────────────────────────────────
console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length) {
	for (const f of fails) console.log(`  FAIL ${f}`);
	process.exit(1);
}
console.log("development contracts OK");
