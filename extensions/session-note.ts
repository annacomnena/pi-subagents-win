/**
 * extensions/session-note.ts — 会话 Note（旁路便签）共享纯库
 *
 * 设计稿：plans/20261117_session-note-design.md。TUI / GUI host / agent 三端共用本文件，
 * 权威正文只有一份：<agentDir>/session-notes/<pi session UUID>.json。
 *
 * 三条硬纪律：
 *  1. **never-throw**：所有导出函数以判别联合返回结果，调用方不得靠 try/catch 判失败；
 *     唯一例外是进程被强杀，此时锁文件可能残留 —— 由 stale 清理兜底。
 *  2. **并发正确性来自 per-sid 锁**，不来自 rename：tmp+rename 只保证文件不半写。
 *  3. **sid 必须经白名单**才能拼进路径；文件内 sessionId 与请求 sid 不一致按坏文件处理。
 *
 * 不依赖 Pi API，node 可直接加载（测试脚本带 pi-deps-loader 仅为满足 defaultAgentDir
 * 所在模块的既有依赖图）。
 */
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultAgentDir } from "./runtime/global-view.ts";

/** 单次 note 的 UTF-8 字节上限（64 KiB）；超出返回 too-large，防止便签变垃圾桶。 */
export const MAX_NOTE_BYTES = 64 * 1024;
/** 注入到 agent 上下文的规则段预算（字符数）；超出截断并标注，完整内容走 note_read。 */
export const NOTE_INJECTION_BUDGET = 1500;
/**
 * 静态系统提示声明：文本恒定，不随 note 内容变化。
 * Pi 对 systemPromptOptions.sections 做 diff，只有变化时追加 patch —— 恒定文本
 * 首次注入一次，之后零 patch，prompt cache 前缀不动（设计稿 §4.3.2④）。
 */
export const NOTE_AUTHORITY_SECTION =
	"会话便签（customType=session-note）可能有多条历史版本；以时间戳最新的一条为唯一现行版本，更早的一律忽略。完整内容请调 note_read。";

export interface SessionNote {
	schemaVersion: 1;
	sessionId: string;
	text: string;
	/** 仅不存在的空 note 为 null；写入的文件恒为合法 ISO 串。 */
	updatedAt: string | null;
	/** 文件不存在 = 0；实际文件从 1 开始。 */
	version: number;
}

export type ReadResult =
	| { ok: true; note: SessionNote; exists: boolean }
	| { ok: false; reason: "invalid-session-id" | "read-failed" | "corrupt"; detail?: string };

export type WriteFailureReason =
	| "invalid-session-id"
	| "too-large"
	| "version-conflict"
	| "lock-busy"
	| "read-failed"
	| "corrupt"
	| "write-failed";

export type WriteResult =
	| { ok: true; note: SessionNote }
	| { ok: false; reason: WriteFailureReason; current?: SessionNote; detail?: string };

function emptyNote(sid: string): SessionNote {
	return { schemaVersion: 1, sessionId: sid, text: "", updatedAt: null, version: 0 };
}

/**
 * 便签正文指纹。注入判据用它而非 version：version 会被「内容没变但仍调了一次写」空转
 * （GUI 重复点保存 / agent 重写同文），只看 version 会把同一份规则反复注入会话。
 * 用 noise 剥离后的**原文**做指纹，不用注入摘要——摘要带时间戳会每次不同。
 * 指纹按磁盘原文算，**不做** canonicalNoteText 归一化（写入侧同文判定才归一化，分工见那里的注释）。
 */
export function noteFingerprint(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * 比较用规范化（canonical）：折掉「编辑器边界产生的伪差异」，**只用于同文判定**，
 * 不改存储内容、不进指纹。口径对齐 pi 宿主两处真实行为（2026-11-20 实测：含 tab 的便签
 * 在 TUI 打开 /note 零编辑直接提交，v1→v2 版本空转 + 指纹变化导致同规则重复注入）：
 *  1. pi-tui `Editor.normalizeText`（components/editor.js）：`\r\n|\r → \n`、`\t → 4 空格`；
 *  2. pi-coding-agent `editInExternalEditor` 回写：剥 BOM、剥尾随换行（宿主只剥**一个**
 *     `\n`；canonical 折掉**全部**尾随 `\n` —— 只剥一个的话多轮零编辑往返会逐次掉行、
 *     持续空转，实现必须宽于宿主）。
 * 取舍登记（AGENTS §6）：「只把 tab 改成 4 空格 / 只调整尾随换行 / 只去 BOM」的刻意编辑
 * 会被判为同文 no-op；清空（写入空文本）永远走真实写入，保住 tombstone 语义。
 */
export function canonicalNoteText(text: string): string {
	// 首字符 U+FEFF（BOM）直接剥掉，不用正则转义（源码里 \uFEFF 跨层转义易写错）。
	const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	return body
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.replace(/\t/g, "    ")
		.replace(/\n+$/, "");
}

function errCode(e: unknown): string {
	if (e !== null && typeof e === "object" && "code" in e) return String((e as { code: unknown }).code);
	return "";
}

/** 有界忙等（锁/Windows rename 重试共用，避免异步化把锁的持有范围切断）。 */
function busyWait(ms: number, until: number): void {
	while (Date.now() < until) { /* 同步等待；单次 ≤25ms */ }
}

// 500ms 而非 2s：host 单进程里锁等待是同步的，竞争几乎不会发生（单次写毫秒级），
// 真发生时也不该把事件循环冻住 2 秒；超时返回 lock-busy（503 + Retry-After）。
const LOCK_WAIT_MS = 500;
const LOCK_POLL_MS = 25;
/** 进程被强杀后残留的锁；超过此时长才允许清理（写操作本身是毫秒级）。 */
const LOCK_STALE_MS = 15_000;

interface LockGuard { release(): void }

/**
 * 跨进程 per-sid 互斥锁：`openSync(..., "wx")` 的原子性保证唯一赢家。
 * stale 清理也走 "wx" 抢占，因此不会引入第二个持有者。
 */
function acquireLock(lockPath: string): LockGuard | null {
	const deadline = Date.now() + LOCK_WAIT_MS;
	// 唯一 token：stale 清理后若别人已用 wx 抢占，本持有者释放时必须认出那不是自己的锁（ABA）。
	const token = `${process.pid}-${Math.random().toString(36).slice(2, 12)}`;
	for (;;) {
		try {
			const fd = openSync(lockPath, "wx");
			try { writeSync(fd, token, "utf8"); } catch { /* 锁内容只是诊断信息 */ } finally { closeSync(fd); }
			return {
				release(): void {
					try {
						// 只在锁文件仍是自己创建的那一份时才删（read+unlink 仍有极小的 TOCTOU
						// 窗口，但写操作是毫秒级，AB-A 竞争只可能发生在 stale 清理之后）。
						if (readFileSync(lockPath, "utf8") === token) unlinkSync(lockPath);
					} catch { /* 锁已被别人释放/抢占：绝不能强行删 */ }
				},
			};
		} catch (e) {
			if (errCode(e) !== "EEXIST") return null; // 目录不存在/权限错：交由上层映射 write-failed
			try {
				const st = statSync(lockPath);
				if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
					try { unlinkSync(lockPath); } catch { /* 别人先清了，下一轮 wx 重抢 */ }
					continue;
				}
			} catch { /* stat 失败：可能是刚被释放，下一轮 wx 重抢 */ }
			if (Date.now() >= deadline) return null;
			busyWait(LOCK_POLL_MS, Date.now() + LOCK_POLL_MS);
		}
	}
}

/** Windows 上 rename 覆盖已有文件偶发 EPERM/EACCES/EBUSY；有界重试，不静默失败。 */
function renameWithRetry(src: string, dst: string): void {
	const deadline = Date.now() + 1000;
	for (;;) {
		try { renameSync(src, dst); return; } catch (e) {
			const code = errCode(e);
			if (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") throw e;
			if (Date.now() >= deadline) throw e;
			busyWait(20, Date.now() + 20);
		}
	}
}

function validNoteShape(v: unknown, sid: string): v is SessionNote {
	if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
	const o = v as Record<string, unknown>;
	return o.schemaVersion === 1
		&& o.sessionId === sid
		&& typeof o.text === "string"
		&& typeof o.updatedAt === "string"
		&& !Number.isNaN(Date.parse(o.updatedAt))
		&& Number.isSafeInteger(o.version)
		&& (o.version as number) >= 1;
}

/** 锁内读：不重复做 sid 校验（调用方已校验），但校验文件内 sessionId。 */
function readNoteUnsafe(path: string, sid: string): ReadResult {
	let raw: string;
	try { raw = readFileSync(path, "utf8"); } catch (e) {
		if (errCode(e) === "ENOENT") return { ok: true, note: emptyNote(sid), exists: false };
		return { ok: false, reason: "read-failed", detail: String(e) };
	}
	let parsed: unknown;
	try { parsed = JSON.parse(raw); } catch (e) { return { ok: false, reason: "corrupt", detail: `bad-json: ${String(e)}` }; }
	if (!validNoteShape(parsed, sid)) return { ok: false, reason: "corrupt", detail: "bad-shape-or-sid-mismatch" };
	return { ok: true, note: parsed, exists: true };
}

/**
 * sid → 绝对路径。非法 sid 返回 null，**绝不拼进路径**。
 * 长度 ≤128 且仅 `[A-Za-z0-9_-]`（与 server.ts `/v1/session-commands/:sid` 同口径）。
 */
export function notePath(sessionId: string, agentDir?: string): string | null {
	if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 128) return null;
	if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return null;
	return join(agentDir ?? defaultAgentDir(), "session-notes", `${sessionId}.json`);
}

/** 读便签。文件不存在 → 空 note（version=0）；坏文件 → corrupt，绝不伪装成空。 */
export function readSessionNote(sessionId: string, opts?: { agentDir?: string }): ReadResult {
	const path = notePath(sessionId, opts?.agentDir);
	if (path === null) return { ok: false, reason: "invalid-session-id" };
	return readNoteUnsafe(path, sessionId);
}

/**
 * TUI widget 摘要文本：**每次调用都实时读盘**（2026-11-18 修「widget 永远为空」）。
 * 原实现在 session_start 把摘要算成死字符串塞进 Text，agent/GUI 写入后再无刷新路径；
 * 改成 render 时调本函数即天然跟随任意写入方，无需事件推送、无跨进程单点故障（R-2）。
 */
export function liveNoteSummary(sessionId: string, opts?: { agentDir?: string }): string {
	const r = readSessionNote(sessionId, opts);
	if (!r.ok) return "⚠ Note 读取失败 · /note 查看";
	return r.note.text.trim().length === 0
		? "📝 Note: 空 · 点开或 /note 写提醒"
		: `📝 Note: ${r.note.text.length} 字 · v${r.note.version} · 点开或 /note`;
}

/**
 * 写便签。expectedVersion 提供时必须是非负安全整数，且等于当前版本；冲突返回 current。
 * 锁的持有范围：read current → version 检查 → tmp 写入 → rename → 释放。
 */
export function writeSessionNote(
	sessionId: string,
	text: string,
	opts?: { agentDir?: string; expectedVersion?: number; now?: () => Date },
): WriteResult {
	const path = notePath(sessionId, opts?.agentDir);
	if (path === null) return { ok: false, reason: "invalid-session-id" };
	if (typeof text !== "string") return { ok: false, reason: "write-failed", detail: "text-not-string" };
	if (Buffer.byteLength(text, "utf8") > MAX_NOTE_BYTES) return { ok: false, reason: "too-large" };

	try { mkdirSync(dirname(path), { recursive: true }); } catch (e) {
		return { ok: false, reason: "write-failed", detail: `mkdir: ${String(e)}` };
	}
	const lock = acquireLock(`${path}.lock`);
	if (lock === null) return { ok: false, reason: "lock-busy", detail: "per-sid lock timeout" };

	let tmp: string | null = null;
	try {
		const currentRes = readNoteUnsafe(path, sessionId);
		if (!currentRes.ok) {
			return { ok: false, reason: currentRes.reason === "corrupt" ? "corrupt" : "read-failed", detail: currentRes.detail };
		}
		const current = currentRes.note;
		const expected = opts?.expectedVersion;
		if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 0)) {
			return { ok: false, reason: "version-conflict", current, detail: "expectedVersion-not-safe-nonnegative" };
		}
		if (expected !== undefined && expected !== current.version) {
			return { ok: false, reason: "version-conflict", current };
		}
		// 内容没变 ⇒ 绝不写盘、绝不涨版本：否则 GUI 重复点保存 / agent 重写同文会把
		// version 空转，注入判据只看 version 时就会把同一份规则反复塞进会话。
		// 2026-11-20 放宽：字节相等**或归一化后相等**都算同文 —— pi-tui 编辑器会把
		// tab→4 空格 / CRLF→LF、外部编辑器剥 BOM 与尾随换行（canonicalNoteText），
		// 零编辑提交不该因此被当成新版本（实测 tab 便签 v1→v2 空转 + 重复注入）。
		// 空文本写入除外：清空必须真写，保住 tombstone 语义（哪怕旧文只剩换行）。
		// 短路仍返回 ok + 当前 note（磁盘原文），调用方拿到的 version 与磁盘一致。
		if (current.text === text
			|| (text.length > 0 && current.text.length > 0
				&& canonicalNoteText(current.text) === canonicalNoteText(text))) {
			return { ok: true, note: current };
		}
		const now = opts?.now ?? (() => new Date());
		const next: SessionNote = {
			schemaVersion: 1,
			sessionId,
			text,
			updatedAt: now().toISOString(),
			version: current.version + 1,
		};
		tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
		const fd = openSync(tmp, "wx");
		try { writeSync(fd, JSON.stringify(next), "utf8"); } catch (e) {
			try { closeSync(fd); } catch { /* ignore */ }
			throw e;
		}
		closeSync(fd);
		renameWithRetry(tmp, path);
		tmp = null;
		return { ok: true, note: next };
	} catch (e) {
		return { ok: false, reason: "write-failed", detail: String(e) };
	} finally {
		if (tmp !== null) { try { unlinkSync(tmp); } catch { /* 自己创建的 tmp 才清 */ } }
		lock.release();
	}
}

// ── 脏时注入的纯逻辑（P4 handler 直接调用；测试可 node 直载）─────────────────

export interface NoteInjectionInput {
	/** 当前 note 文件版本（不存在 = 0）。 */
	currentVersion: number;
	/** 上次注入版本；无 state entry = null；压缩后被强制写成 -1。 */
	injectedVersion: number | null;
	text: string;
	/**
	 * 上次注入时的正文指纹；null = 旧 state entry 没有该字段 / 压缩重注的 -1 entry。
	 * 非 null 时**以指纹为准**判脏：note 内容没变即使 version 空转也不注入（本次修复的核心）。
	 */
	injectedFingerprint?: string | null;
}

export type NoteInjectionDecision =
	| { inject: false }
	| { inject: true; kind: "content" | "cleared" };

/**
 * 真值表（设计稿 §8.1b，2026-11-18 修订：脏判据由「比版本」改为「比正文指纹」）：
 *   note 从未写过 且 从未注入        → 不注入
 *   injectedVersion === -1（压缩后） → 强制重注（summary 里的旧规则不能冒充现行）
 *   有指纹且指纹相同                 → 不注入（内容没变；**核心断言**，version 空转不再触发）
 *   指纹不同 / 无指纹回退比版本      → text 空则 cleared tombstone，否则 content
 * 被外力删除（current=0 但曾注入）也走 tombstone，否则 agent 永远以为旧规则还有效。
 */
export function decideNoteInjection(input: NoteInjectionInput): NoteInjectionDecision {
	const { currentVersion, injectedVersion, text, injectedFingerprint } = input;
	const neverInjected = injectedVersion === null;
	const noteEmpty = currentVersion === 0 && text.length === 0;
	const verdict = (): NoteInjectionDecision => ({ inject: true, kind: text.length === 0 ? "cleared" : "content" });

	// note 从未写过、也从没注入过 ⇒ 零消息（G3）
	if (noteEmpty && neverInjected) return { inject: false };
	// 压缩后强制重注：即使正文一字未变也要发，否则 compaction summary 里的旧规则长期冒充现行。
	if (injectedVersion === -1) return verdict();
	// 主判据：正文指纹相同 ⇒ 内容没变 ⇒ 不注入（version 可能被重复保存空转，不可信）。
	if (injectedFingerprint != null) {
		return injectedFingerprint === noteFingerprint(text) ? { inject: false } : verdict();
	}
	// 兼容回退：旧 state entry 无指纹 ⇒ 仍按 version 比对（升级前的会话不会突然漏注入）。
	if (injectedVersion !== null && injectedVersion === currentVersion) return { inject: false };
	return verdict();
}

/** 取「给 agent 的规则」段；没有该 heading 或该段为空 → 全文（宁可多注入，不可漏人类提醒）。 */
export function extractNoteRules(text: string): string {
	const out: string[] = [];
	let collecting = false;
	for (const line of text.split("\n")) {
		if (/^##\s+/.test(line)) {
			if (collecting) break;
			collecting = /^##\s+给\s*agent\s*的规则/.test(line);
			continue;
		}
		if (collecting) out.push(line);
	}
	return out.join("\n").trim() || text.trim();
}

/**
 * 脏时注入的**完整组合判定**：handler 直接返回本函数结果（null = 干净，不返回 message）。
 * 抽出来是为了让「handler 体逻辑」也能被 node 直载测试执行 —— 只测 decide + build
 * 两个纯函数仍抓不到组合处写反（`if (decision.inject) return` 这类真缺陷）。
 */
export function composeNoteInjection(
	note: SessionNote,
	injectedVersion: number | null,
	now?: () => Date,
	injectedFingerprint?: string | null,
): { customType: "session-note"; content: string; display: true } | null {
	const decision = decideNoteInjection({
		currentVersion: note.version,
		injectedVersion,
		text: note.text,
		injectedFingerprint,
	});
	if (!decision.inject) return null;
	return { customType: "session-note", content: buildNoteInjectionContent(note, now), display: true };
}

/** 注入消息正文：首行 `v<N> · <ISO>` 供 agent 按静态规则挑最新版本。 */
export function buildNoteInjectionContent(note: SessionNote, now?: () => Date): string {
	const stamp = (now ?? (() => new Date()))().toISOString();
	const head = `v${note.version} · ${stamp}`;
	if (note.text.trim().length === 0) {
		return `### 会话便签（session-note）\n${head}\n\n便签已清空：忽略此前所有版本的会话便签规则。`;
	}
	const rules = extractNoteRules(note.text);
	const truncated = rules.length > NOTE_INJECTION_BUDGET;
	const body = truncated ? `${rules.slice(0, NOTE_INJECTION_BUDGET)}\n…已截断` : rules;
	return `### 会话便签（session-note）\n${head}\n\n${body}\n\n（完整便签请调用 note_read；可用 note_write 追加待人办）`;
}
