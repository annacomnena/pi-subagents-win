/**
 * hotspot/store — 热点文件的读写、严格解析、乐观锁与跨进程安全写入
 *
 * v2 §6.3 写入六步：获取跨进程锁 → 重读磁盘 → 检查 expected_revision 与指纹 →
 * 验证候选内容（调用方）→ 临时文件安全替换 → 返回新版本。
 * 工具外编辑通过指纹发现；文件无法解析时停止自动写入、保留用户内容。
 */

import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";
import {
	FIELD_LABELS,
	HOTSPOT_FILENAME,
	HOTSPOT_TRASH_FILENAME,
	MULTI_FIELD_LABELS,
	SCHEMA_VERSION,
	type HotspotEntry,
	type HotspotFile,
	type ParseResult,
	type Rel,
	type SymbolRef,
	type WikiRef,
} from "./types.ts";

export interface ReadResult {
	/** 文件不存在 → exists=false（file/parseError 均为空） */
	exists: boolean;
	file: HotspotFile | null;
	/** sha1(raw)；exists=false 时为 null */
	fingerprint: string | null;
	/** 解析失败原因（exists=true 且 parse 失败时） */
	parseError: string | null;
}

/** 仓库根：向上找 .git（目录或文件，worktree 的 .git 是文件）；找不到用 cwd（非 Git 项目的显式热点根）。 */
export function findRepoRoot(cwd: string): string {
	const parts = cwd.split(/[\\/]/);
	for (let i = parts.length; i > 0; i--) {
		const dir = parts.slice(0, i).join(sep);
		if (dir && existsSync(join(dir, ".git"))) return dir;
	}
	return cwd;
}

export function hotspotPath(root: string): string {
	return join(root, "Wiki", HOTSPOT_FILENAME);
}

export function trashPath(root: string): string {
	return join(root, "Wiki", HOTSPOT_TRASH_FILENAME);
}

export function fingerprintOf(raw: string): string {
	return createHash("sha1").update(raw, "utf8").digest("hex");
}

export function readHotspot(path: string): ReadResult {
	if (!existsSync(path)) return { exists: false, file: null, fingerprint: null, parseError: null };
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (e) {
		return { exists: true, file: null, fingerprint: null, parseError: `读取失败: ${String(e)}` };
	}
	const parsed = parseHotspot(raw);
	return {
		exists: true,
		file: parsed.ok ? parsed.file : null,
		fingerprint: fingerprintOf(raw),
		parseError: parsed.ok ? null : parsed.error,
	};
}

// ── 解析（严格：未知字段/重复单值字段/坏时间戳 → 整体失败）──────────────

const WIKI_RE = /^(.+?)(?:\s+→\s+(.+))?$/u; // path 或 path → section（懒惰匹配：第一个 " → " 分隔）

/** 手写边行格式：`topic_id → kind（note?）`——topic_id 严格（TOPIC_ID 字符集），
 *  → 分隔，末尾全角括号可选为 note。 */
const REL_RE = /^([a-z0-9][a-z0-9-]{0,63})\s+→\s+(.+?)(?:\s*（([^）]*)）)?\s*$/u;

export function parseHotspot(raw: string): ParseResult {
	const lines = raw.split(/\r?\n/);
	let i = 0;
	let schemaVersion = 0;
	let revision = -1;

	// frontmatter（可选前导空行；--- 开始）
	while (i < lines.length && lines[i]!.trim() === "") i++;
	if (i < lines.length && lines[i]!.trim() === "---") {
		i++;
		while (i < lines.length && lines[i]!.trim() !== "---") {
			const m = /^([A-Za-z_]+):\s*(.*)$/.exec(lines[i]!.trim());
			if (!m) return { ok: false, error: `frontmatter 行无法解析: ${lines[i]}` };
			if (m[1] === "schema_version") schemaVersion = Number(m[2]);
			else if (m[1] === "revision") revision = Number(m[2]);
			else return { ok: false, error: `frontmatter 未知字段: ${m[1]}` };
			i++;
		}
		if (i >= lines.length) return { ok: false, error: "frontmatter 未闭合（缺 ---）" };
		i++;
	}
	if (schemaVersion !== SCHEMA_VERSION) return { ok: false, error: `schema_version ${schemaVersion} != ${SCHEMA_VERSION}` };
	if (!Number.isInteger(revision) || revision < 0) return { ok: false, error: `revision 非法: ${revision}` };

	const entries: HotspotEntry[] = [];
	let cur: Partial<HotspotEntry> & { wiki?: WikiRef[]; symbols?: SymbolRef[]; evidence?: WikiRef[]; rel?: Rel[] } | null = null;
	const seenTopics = new Set<string>();
	const fail = (msg: string): ParseResult => ({ ok: false, error: `${msg}（行 ${i + 1}）` });

	for (; i < lines.length; i++) {
		const line = lines[i]!;
		const trimmed = line.trim();
		if (trimmed === "") continue;
		const topic = /^##\s+(\S+)\s*$/.exec(trimmed);
		if (topic) {
			if (cur && cur.topicId) {
				const done = finalizeEntry(cur);
				if (!done.ok) return done;
				entries.push(done.entry);
			}
			if (seenTopics.has(topic[1]!)) return { ok: false, error: `主题重复: ${topic[1]}` };
			seenTopics.add(topic[1]!);
			cur = { topicId: topic[1]!, wiki: [], symbols: [], evidence: [], rel: [] };
			continue;
		}
		const field = /^-\s+([^：]+)：(.*)$/u.exec(trimmed);
		if (!field || !cur) return fail("无法识别的行（既非 '## topic' 也非 '- 键：值'）");
		const [, label, value] = field as unknown as [string, string, string];
		const v = value.trim();
		switch (label) {
			case FIELD_LABELS.title:
				if (cur.title) return fail("标题 重复");
				cur.title = v;
				break;
			case FIELD_LABELS.scope:
				if (cur.scope) return fail("适用范围 重复");
				cur.scope = v;
				break;
			case FIELD_LABELS.updatedAt:
				if (cur.updatedAt) return fail("内容更新 重复");
				if (Number.isNaN(Date.parse(v))) return fail(`内容更新 非法时间: ${v}`);
				cur.updatedAt = v;
				break;
			case FIELD_LABELS.verifiedAt:
				if (cur.verifiedAt) return fail("引用验证 重复");
				if (Number.isNaN(Date.parse(v))) return fail(`引用验证 非法时间: ${v}`);
				cur.verifiedAt = v;
				break;
			case MULTI_FIELD_LABELS.wiki: {
				const m = WIKI_RE.exec(v);
				if (!m) return fail(`Wiki 引用无法解析: ${v}`);
				cur.wiki!.push({ path: m[1]!, ...(m[2] ? { section: m[2] } : {}) });
				break;
			}
			case MULTI_FIELD_LABELS.evidence: {
				const m = WIKI_RE.exec(v);
				if (!m) return fail(`证据引用无法解析: ${v}`);
				cur.evidence!.push({ path: m[1]!, ...(m[2] ? { section: m[2] } : {}) });
				break;
			}
			case MULTI_FIELD_LABELS.symbols: {
				const idx = v.lastIndexOf("::");
				if (idx <= 0) return fail(`入口格式应为 path::Symbol: ${v}`);
				cur.symbols!.push({ path: v.slice(0, idx), name: v.slice(idx + 2) });
				break;
			}
			case MULTI_FIELD_LABELS.rel: {
				const m = REL_RE.exec(v);
				if (!m) return fail(`关联格式应为 topic_id → kind（note?）: ${v}`);
				cur.rel!.push({ topic_id: m[1]!, kind: m[2]!, ...(m[3] !== undefined ? { note: m[3] } : {}) });
				break;
			}
			default:
				return fail(`未知字段: ${label}`);
		}
	}
	if (cur && cur.topicId) {
		const done = finalizeEntry(cur);
		if (!done.ok) return done;
		entries.push(done.entry);
	}
	return { ok: true, file: { schemaVersion, revision, entries } };
}

function finalizeEntry(
	cur: Partial<HotspotEntry> & { wiki?: WikiRef[]; symbols?: SymbolRef[]; evidence?: WikiRef[]; rel?: Rel[] },
): { ok: true; entry: HotspotEntry } | { ok: false; error: string } {
	const missing: string[] = [];
	if (!cur.title) missing.push(FIELD_LABELS.title);
	if (!cur.updatedAt) missing.push(FIELD_LABELS.updatedAt);
	if (!cur.verifiedAt) missing.push(FIELD_LABELS.verifiedAt);
	if (missing.length) return { ok: false, error: `主题 ${cur.topicId} 缺少必填字段: ${missing.join("、")}` };
	return {
		ok: true,
		entry: {
			topicId: cur.topicId!,
			title: cur.title!,
			scope: cur.scope,
			wiki: cur.wiki ?? [],
			symbols: cur.symbols ?? [],
			evidence: cur.evidence ?? [],
			updatedAt: cur.updatedAt!,
			verifiedAt: cur.verifiedAt!,
			rel: cur.rel ?? [],
		},
	};
}

// ── 序列化（与解析对称；工具生成的唯一合法格式）──────────────────────────

export function serializeHotspot(file: HotspotFile): string {
	const out: string[] = ["---", `schema_version: ${file.schemaVersion}`, `revision: ${file.revision}`, "---", ""];
	for (const e of file.entries) {
		out.push(`## ${e.topicId}`, "", `- ${FIELD_LABELS.title}：${e.title}`);
		if (e.scope) out.push(`- ${FIELD_LABELS.scope}：${e.scope}`);
		for (const w of e.wiki) out.push(`- ${MULTI_FIELD_LABELS.wiki}：${w.path}${w.section ? ` → ${w.section}` : ""}`);
		for (const s of e.symbols) out.push(`- ${MULTI_FIELD_LABELS.symbols}：${s.path}::${s.name}`);
		for (const ev of e.evidence) out.push(`- ${MULTI_FIELD_LABELS.evidence}：${ev.path}${ev.section ? ` → ${ev.section}` : ""}`);
		for (const r of e.rel ?? []) out.push(`- ${MULTI_FIELD_LABELS.rel}：${r.topic_id} → ${r.kind}${r.note ? `（${r.note}）` : ""}`);
		out.push(`- ${FIELD_LABELS.updatedAt}：${e.updatedAt}`, `- ${FIELD_LABELS.verifiedAt}：${e.verifiedAt}`, "");
	}
	return out.join("\n") + "\n";
}

// ── 跨进程锁 + 安全提交 ─────────────────────────────────────────────

const LOCK_STALE_MS = 30_000;
const LOCK_RETRIES = 40;
const LOCK_RETRY_DELAY_MS = 50;

function tryAcquireLock(lockPath: string): boolean {
	const now = Date.now();
	try {
		const fd = openSync(lockPath, "wx");
		writeFileSync(fd, `${process.pid}\n${now}\n`, "utf8");
		closeSync(fd);
		return true;
	} catch (e: unknown) {
		const code = (e as { code?: string }).code;
		if (code !== "EEXIST") return false; // 权限等错误：视为拿不到锁
		// 陈旧锁：写入时间超过 LOCK_STALE_MS → 抢占
		try {
			const raw = readFileSync(lockPath, "utf8").trim().split("\n");
			const ts = Number(raw[1]);
			if (Number.isFinite(ts) && now - ts > LOCK_STALE_MS) {
				unlinkSync(lockPath);
				return tryAcquireLock(lockPath);
			}
		} catch {
			/* 读失败继续重试 */
		}
		return false;
	}
}

export async function withHotspotLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
	const lockPath = `${path}.lock`;
	try {
		mkdirSync(dirname(path), { recursive: true }); // 锁文件所在目录可能尚不存在（首次写入）
	} catch {
		/* 目录创建失败会在拿锁时暴露 */
	}
	let acquired = false;
	for (let i = 0; i < LOCK_RETRIES && !acquired; i++) {
		acquired = tryAcquireLock(lockPath);
		if (!acquired) await new Promise((r) => setTimeout(r, LOCK_RETRY_DELAY_MS));
	}
	if (!acquired) throw new Error("热点文件写入锁获取超时（另一进程持有且未释放）");
	try {
		return await fn();
	} finally {
		try {
			unlinkSync(lockPath);
		} catch {
			/* 已被抢占时忽略 */
		}
	}
}

export interface CommitInput {
	/** 乐观锁：调用者读到的 revision；新建文件传 0 */
	expectedRevision: number;
	/** 指纹校验（与 expectedRevision 二选一必过）。调用者读到的指纹；新建文件传 null */
	expectedFingerprint: string | null;
	/** 在锁内对最新文件做变更；返回 null 表示放弃（如相同内容不写入） */
	mutate: (latest: HotspotFile | null) => { next: HotspotFile; skipped?: boolean } | null;
}

export type CommitResult =
	| { ok: true; revision: number; skipped: boolean }
	| { ok: false; kind: "parse_error" | "conflict" | "busy" | "io"; message: string; currentRevision?: number; currentFingerprint?: string };

/** 六步安全写入。锁内重读磁盘并对 revision+指纹双重校验，任何不一致 → conflict（不自动覆盖）。 */
export async function commitHotspot(path: string, input: CommitInput): Promise<CommitResult> {
	return withHotspotLock(path, async () => {
		const latest = readHotspot(path);
		if (latest.exists && latest.parseError) {
			return { ok: false, kind: "parse_error", message: `热点文件无法解析，停止自动写入以保留内容: ${latest.parseError}` };
		}
		const curRev = latest.exists && latest.file ? latest.file.revision : 0;
		if (curRev !== input.expectedRevision || latest.fingerprint !== input.expectedFingerprint) {
			return {
				ok: false,
				kind: "conflict",
				message: `版本冲突：磁盘 revision=${curRev}，期望 revision=${input.expectedRevision}（请 read 后重试）`,
				currentRevision: curRev,
				currentFingerprint: latest.fingerprint ?? undefined,
			};
		}
		let mutated: { next: HotspotFile; skipped?: boolean } | null;
		try {
			mutated = input.mutate(latest.exists ? latest.file : null);
		} catch (e) {
			return { ok: false, kind: "io", message: `变更被拒绝: ${e instanceof Error ? e.message : String(e)}` };
		}
		if (!mutated) return { ok: true, revision: curRev, skipped: true };
		const next: HotspotFile = { ...mutated.next, revision: curRev + 1 };
		const raw = serializeHotspot(next);
		const tmp = `${path}.tmp-${process.pid}`;
		try {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(tmp, raw, "utf8");
			renameSync(tmp, path);
		} catch (e) {
			try {
				if (existsSync(tmp)) rmSync(tmp);
			} catch {
				/* ignore */
			}
			return { ok: false, kind: "io", message: `写入失败: ${String(e)}` };
		}
		return { ok: true, revision: next.revision, skipped: Boolean(mutated.skipped) };
	}).catch((e: unknown) => ({ ok: false, kind: "busy", message: String(e) }) as CommitResult);
}

/** remove 的受限恢复副本：追加 JSONL（含被删条目全文、原因与删除时 revision）。 */
export function appendTrash(root: string, record: unknown): string | null {
	const p = trashPath(root);
	try {
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, `${JSON.stringify(record)}\n`, { flag: "a" });
		return p;
	} catch {
		return null;
	}
}
