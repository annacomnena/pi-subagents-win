/**
 * hotspot/validate — 条目结构校验与引用验证
 *
 * v2 §6.2：写入前检查结构/长度/数量/预算、路径仓库边界、文件与章节存在、
 * CodeGraph 可用时符号存在且对应指定文件。验证失败或歧义 → 明确诊断，不猜测补全。
 * 这些检查证明引用有效，不能证明主题关联或业务结论正确。
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { serializeHotspot } from "./store.ts";
import {
	DEFAULT_STORE_CHAR_LIMIT,
	ENTRY_LIMITS,
	TOPIC_ID_RE,
	type HotspotEntry,
	type HotspotFile,
} from "./types.ts";

export interface ValidationProblem {
	field: string;
	message: string;
}

export interface RefCheck {
	path: string;
	section?: string;
	fileExists: boolean;
	sectionFound: boolean | null; // null = 未检查（无 section 或文件不存在）
}

export interface EntryValidation {
	problems: ValidationProblem[]; // 非空 → 拒绝写入
	refChecks: RefCheck[];
	/** true=CodeGraph 确认每个符号存在于指定文件；false=未验证（不可用时不算 problem） */
	symbolVerified: boolean;
	/** CodeGraph 是否被尝试调用 */
	codegraphAttempted: boolean;
	notes: string[];
}

/** 结构校验：topicId 格式、长度、数量、路径形态。路径以仓库根解析并检查不越界。 */
export function validateEntryShape(entry: HotspotEntry, root: string): ValidationProblem[] {
	const problems: ValidationProblem[] = [];
	if (!TOPIC_ID_RE.test(entry.topicId)) {
		problems.push({ field: "topic_id", message: `须匹配 ${TOPIC_ID_RE}（小写字母数字连字符）` });
	}
	if (!entry.title?.trim()) problems.push({ field: "entry.title", message: "标题不能为空" });
	else if ([...entry.title].length > ENTRY_LIMITS.title) {
		problems.push({ field: "entry.title", message: `标题超过 ${ENTRY_LIMITS.title} 字符` });
	}
	if (entry.scope && [...entry.scope].length > ENTRY_LIMITS.scope) {
		problems.push({ field: "entry.scope", message: `适用范围超过 ${ENTRY_LIMITS.scope} 字符` });
	}
	for (const [field, refs] of [
		["entry.wiki", entry.wiki],
		["entry.symbols", entry.symbols],
		["entry.evidence", entry.evidence],
	] as const) {
		if (refs.length > ENTRY_LIMITS.refs) {
			problems.push({ field, message: `超过 ${ENTRY_LIMITS.refs} 条上限` });
		}
		for (const r of refs as Array<{ path: string }>) {
			const p = validateRepoRelativePath(r.path, root);
			if (p) problems.push({ field, message: p });
		}
	}
for (const s of entry.symbols) {
		if (!s.name?.trim()) problems.push({ field: "entry.symbols", message: `符号名为空: ${s.path}` });
	}
	// ② 手写边：数量/形态（topic_id 严格字符集；kind 非空且不含全角括号——行格式歧义面）
	const rels = entry.rel ?? [];
	if (rels.length > ENTRY_LIMITS.rel) {
		problems.push({ field: "entry.rel", message: `超过 ${ENTRY_LIMITS.rel} 条上限` });
	}
	for (const r of rels) {
		if (!TOPIC_ID_RE.test(r.topic_id ?? "")) {
			problems.push({ field: "entry.rel", message: `关联 topic_id 须匹配 ${TOPIC_ID_RE}: ${r.topic_id}` });
		}
		if (!r.kind?.trim()) problems.push({ field: "entry.rel", message: `关联 kind 不能为空: ${r.topic_id}` });
		else if ([...r.kind].length > ENTRY_LIMITS.relKind) {
			problems.push({ field: "entry.rel", message: `关联 kind 超过 ${ENTRY_LIMITS.relKind} 字: ${r.kind}` });
		} else if (/[（）]/.test(r.kind)) {
			problems.push({ field: "entry.rel", message: `关联 kind 不得含全角括号（行格式歧义）: ${r.kind}` });
		}
		if (r.note && [...r.note].length > ENTRY_LIMITS.relNote) {
			problems.push({ field: "entry.rel", message: `关联 note 超过 ${ENTRY_LIMITS.relNote} 字: ${r.note}` });
		} else if (r.note && /[（）]/.test(r.note)) {
			// serialize 使用全角括号承载 note，允许其出现在正文会破坏 parse/serialize 往返。
			problems.push({ field: "entry.rel", message: `关联 note 不得含全角括号（行格式歧义）: ${r.note}` });
		}
	}
	for (const ts of [entry.updatedAt, entry.verifiedAt] as const) {
		if (!ts || Number.isNaN(Date.parse(ts))) {
			problems.push({ field: "entry", message: "内容更新/引用验证 须为合法 ISO 时间" });
			break;
		}
	}
	return problems;
}

/** 相对路径校验：正斜杠、不越出仓库根、解析后确实存在性由引用验证负责。 */
export function validateRepoRelativePath(p: string, root: string): string | null {
	if (!p) return "路径为空";
	if (p.includes("\\")) return `路径须用正斜杠: ${p}`;
	if (p.includes("..")) return `路径不得包含 ..: ${p}`;
	if (/^[a-zA-Z]:/.test(p)) return `路径须为仓库相对路径: ${p}`;
	if (p.startsWith("/")) return `路径须为仓库相对路径（不以 / 开头）: ${p}`;
	const abs = join(root, ...p.split("/"));
	if (!abs.startsWith(root)) return `路径越出仓库边界: ${p}`;
	return null;
}

/** 引用验证：文件存在 + 章节标题存在（精确匹配，trim 比较）；符号经 CodeGraph 验证。
 *  ② 手写边存在性 gate：`rel.topic_id` 必须指向已存在条目（knownTopics，含本条目自身），
 *  指向不存在 → problem 拒写（手写边过期会误导，§14.2）。 */
export function verifyReferences(
	entry: HotspotEntry,
	root: string,
	opts: { codegraph?: boolean; codegraphTimeoutMs?: number; knownTopics?: Set<string> } = {},
): EntryValidation {
	const problems: ValidationProblem[] = [];
	const refChecks: RefCheck[] = [];
	const notes: string[] = [];
	const useCodegraph = opts.codegraph ?? true;

	const checkRef = (r: { path: string; section?: string }): void => {
		const abs = join(root, ...r.path.split("/"));
		let fileExists = false;
		try {
			fileExists = statSync(abs).isFile();
		} catch {
			fileExists = false;
		}
		let sectionFound: boolean | null = null;
		if (fileExists && r.section) {
			sectionFound = sectionExists(abs, r.section);
			if (!sectionFound) {
				problems.push({ field: "entry", message: `章节不存在: ${r.path} → ${r.section}` });
			}
		} else if (!fileExists) {
			problems.push({ field: "entry", message: `文件不存在: ${r.path}` });
		}
		refChecks.push({ path: r.path, section: r.section, fileExists, sectionFound });
	};

	for (const w of entry.wiki) checkRef(w);
	for (const ev of entry.evidence) checkRef(ev);
	for (const s of entry.symbols) checkRef({ path: s.path });

	// ② 手写边存在性 gate（upsert 时拒写；read 时仅标 [失效] 不拒读）
	const known = opts.knownTopics ?? new Set([entry.topicId]);
	for (const r of entry.rel ?? []) {
		if (!known.has(r.topic_id)) {
			problems.push({ field: "entry.rel", message: `关联指向的主题不存在: ${r.topic_id}（请先 upsert 该主题或移除此关联）` });
		}
	}

	// 符号验证（CodeGraph 可用时）
	let symbolVerified = entry.symbols.length === 0; // 无符号条目视为“符号验证通过”（无符号可验）
	let codegraphAttempted = false;
	if (entry.symbols.length > 0 && useCodegraph) {
		codegraphAttempted = true;
	const available = codegraphAvailable(root);
		if (!available) {
			notes.push("CodeGraph 不可用：符号未验证（仅文件存在性检查通过）");
		} else {
			symbolVerified = true;
			for (const s of entry.symbols) {
				const hit = codegraphQuerySymbol(s.name, root, opts.codegraphTimeoutMs ?? 10_000);
				if (hit.kind === "error") {
					symbolVerified = false;
					notes.push(`CodeGraph 查询失败（${s.name}）: ${hit.message}；符号未验证`);
				} else if (!hit.found) {
					symbolVerified = false;
					problems.push({ field: "entry.symbols", message: `CodeGraph 查无此符号: ${s.name}` });
				} else if (!hit.paths.has(s.path)) {
					symbolVerified = false;
					problems.push({
						field: "entry.symbols",
						message: `符号 ${s.name} 存在但不在指定文件（命中: ${[...hit.paths].slice(0, 3).join(", ")}）`,
					});
				}
			}
		}
	}
	return { problems, refChecks, symbolVerified, codegraphAttempted, notes };
}

/** 章节标题存在：文件内任意层级标题精确匹配（trim）。 */
export function sectionExists(absPath: string, section: string): boolean {
	let raw: string;
	try {
		raw = readFileSync(absPath, "utf8");
	} catch {
		return false;
	}
	const want = section.trim();
	for (const line of raw.split(/\r?\n/)) {
		const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
		if (m && m[1]!.trim() === want) return true;
	}
	return false;
}

// ── CodeGraph 桥（CLI 文本解析；符号名白名单校验后进命令行）──────────────

export const SYMBOL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.]*$/;

export function codegraphAvailable(root: string): boolean {
	// Windows 下 .cmd 必须经 shell 调用（Node 安全限制）；--version 零退出即视为 CLI 可用。
	for (const cmd of process.platform === "win32" ? ["codegraph.cmd", "codegraph"] : ["codegraph"]) {
		try {
			execFileSync(cmd, ["--version"], { cwd: root, timeout: 5_000, stdio: "ignore", windowsHide: true, shell: true });
			return true;
		} catch {
			/* 试下一个候选 */
		}
	}
	return false;
}

export type SymbolQueryResult =
	| { kind: "ok"; found: boolean; paths: Set<string> }
	| { kind: "error"; message: string };

/** `codegraph query <name>` 输出形如：
 *  method      MeshPushCoordinator
 *    GreenCAD.AutoCAD/Services/MeshPushCoordinator.cs:32
 *  解析「名字行 + 缩进路径行」对，收集路径集合。 */
export function codegraphQuerySymbol(name: string, root: string, timeoutMs: number): SymbolQueryResult {
	if (!SYMBOL_NAME_RE.test(name)) return { kind: "error", message: `符号名含非法字符: ${name}` };
	const cmd = process.platform === "win32" ? "codegraph.cmd" : "codegraph";
	try {
		const out = execFileSync(cmd, ["query", name], {
			cwd: root,
			timeout: timeoutMs,
			encoding: "utf8",
			windowsHide: true,
			shell: true, // Windows .cmd 必须经 shell；name 已过白名单校验，无注入面
		}) as string;
		const paths = new Set<string>();
		const lines = out.split(/\r?\n/);
		for (let i = 0; i < lines.length; i++) {
			const nameLine = /^(?:method|class|interface|struct|function|property|field|enum|type_alias|constant)\s+(\S+)$/.exec(lines[i]!.trim());
			if (nameLine) {
				const next = lines[i + 1]?.trim() ?? "";
				const loc = /^(\S+?):\d+$/.exec(next);
				if (loc) paths.add(posix.normalize(loc[1]!));
			}
		}
		return { kind: "ok", found: paths.size > 0, paths };
	} catch (e) {
		return { kind: "error", message: String(e).slice(0, 200) };
	}
}

/** 存储预算：序列化后总长超限拒写（与注入预算分别限制）。 */
export function checkStoreBudget(file: HotspotFile): ValidationProblem[] {
	const len = serializeHotspot(file).length;
	if (len > DEFAULT_STORE_CHAR_LIMIT) {
		return [
			{
				field: "store",
				message: `存储超限：${len} > ${DEFAULT_STORE_CHAR_LIMIT} 字符；请先 remove 冷却主题再写入`,
			},
		];
	}
	return [];
}

/** 用于 upsert 的“相同内容”判定：忽略时间戳差异只比较路由内容（含手写边）。 */
export function sameRoutingContent(a: HotspotEntry, b: HotspotEntry): boolean {
	return (
		a.topicId === b.topicId &&
		a.title === b.title &&
		(a.scope ?? "") === (b.scope ?? "") &&
		JSON.stringify(a.wiki) === JSON.stringify(b.wiki) &&
		JSON.stringify(a.symbols) === JSON.stringify(b.symbols) &&
		JSON.stringify(a.evidence) === JSON.stringify(b.evidence) &&
		JSON.stringify(a.rel ?? []) === JSON.stringify(b.rel ?? [])
	);
}

export function fileExistsAbs(absPath: string): boolean {
	return existsSync(absPath);
}
