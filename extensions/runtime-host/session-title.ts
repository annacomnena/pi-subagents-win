/**
 * runtime-host/session-title.ts — 会话列表可读标题解析链（plans/0922_session_title_research.md §5）。
 *
 * 优先级（逐级回退，全链 never-throw）：
 *   P1 ledger     — 全局 tab-runs 台账（`~/.pi/agent/tab-runs/<runId>.json`，env PI_TAB_RUNS_DIR
 *                   覆盖）：record.cwd 同桶 + 会话首条 user 严格前缀匹配 + 派发时间窗 → record.title。
 *   P2 first-user — 首条 user 文本剥前缀（launch.ts taskTitleLabel 同款规则独立重实现）：
 *                   跳 `##`/`>`/「根据X进行工作」前缀行，取首个有意义行，去 markdown 噪音，截 24 字符。
 *   P3 id         — 会话 id 兜底（GUI 灰显 shortId）。
 *
 * 纪律：台账探测 / 桶名 / 前缀形状按 tab-runs.ts・launch.ts 语义**独立重实现**——
 * 禁止 import tab-runs.ts（该文件携并行会话未提交改动）。只读、容错损坏行/缺失目录。
 */

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionSummary } from "../runtime/transcript.ts";

// ── P1：台账（只读、容错）────────────────────────────────────────

/** 台账标题来源标记（/v1/sessions 的 titleSource，GUI 调试用）。 */
export type SessionTitleSource = "ledger" | "first-user" | "id";

export interface SessionTitle {
	title: string;
	source: SessionTitleSource;
}

interface TabLedgerEntry {
	runId: string;
	taskId: string;
	mode: string;
	title: string;
	cwd: string;
	dispatchedAtMs: number;
}

/** 台账根目录：env PI_TAB_RUNS_DIR 覆盖，默认 ~/.pi/agent/tab-runs（与 tab-runs.ts defaultTabRunsDir 同语义）。 */
export function tabRunsDir(): string {
	const override = process.env.PI_TAB_RUNS_DIR;
	if (override && override.trim()) return override.trim();
	return join(homedir(), ".pi", "agent", "tab-runs");
}

/** 复刻 pi 的 session 桶命名（tab-runs.ts sessionBucketForCwd 同语义）：--<cwd 去首斜杠、/ \ : 转 ->--。 */
function sessionBucketForCwd(cwd: string): string {
	const resolved = cwd.replace(/[\\/]+$/, "") || cwd;
	return `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** 前缀形状（launch.ts modePrefix 同语义）：`根据<mode>进行工作<taskId>`。 */
function modePrefixLike(taskId: string, mode: string): string {
	return `根据${mode}进行工作${taskId}`;
}

/**
 * 读台账目录：仅顶层 `<runId>.json` 派发记录（排除 `.state.json`/`.result.json`/子目录）。
 * 损坏行 / 形状不符 / 读取失败 → skip（never-throw）。
 */
export function loadTabLedger(runsDir: string): TabLedgerEntry[] {
	const out: TabLedgerEntry[] = [];
	let entries: string[];
	try {
		entries = readdirSync(runsDir, { withFileTypes: true })
			.filter(
				(d) =>
					d.isFile() &&
					d.name.endsWith(".json") &&
					!d.name.endsWith(".state.json") &&
					!d.name.endsWith(".result.json"),
			)
			.map((d) => d.name);
	} catch {
		return out;
	}
	for (const name of entries) {
		let raw: string;
		try {
			raw = readFileSync(join(runsDir, name), "utf8");
		} catch {
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			continue;
		}
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
		const rec = parsed as Record<string, unknown>;
		const runId = typeof rec.id === "string" ? rec.id : name.replace(/\.json$/, "");
		const taskId = typeof rec.taskId === "string" ? rec.taskId.trim() : "";
		const cwd = typeof rec.cwd === "string" ? rec.cwd : "";
		const title = typeof rec.title === "string" ? rec.title.trim() : "";
		if (!taskId || !cwd || !title) continue;
		const dispatchedRaw = typeof rec.dispatchedAt === "string" ? rec.dispatchedAt : "";
		const dispatchedMs = dispatchedRaw ? Date.parse(dispatchedRaw) : Number.NaN;
		out.push({
			runId,
			taskId,
			mode: typeof rec.mode === "string" && rec.mode ? rec.mode : "workflow",
			title,
			cwd,
			dispatchedAtMs: Number.isNaN(dispatchedMs) ? 0 : dispatchedMs,
		});
	}
	return out;
}

/** 首条 user 首行必须是完整派发前缀（或其后接空白）。禁止 taskId 子串匹配，避免 T7 命中 T70/正文。 */
function hasLedgerPrefix(entry: TabLedgerEntry, firstUserText: string): boolean {
	const firstLine = firstUserText.split(/\r?\n/)[0].trim();
	const prefix = modePrefixLike(entry.taskId, entry.mode);
	return firstLine === prefix || (firstLine.startsWith(prefix) && /^\s/.test(firstLine.slice(prefix.length)));
}

/** P1：同 cwd 桶内严格前缀探测；同 taskId 重派发用 session 起始时间排除未来派发，再取最新候选。 */
function pickLedgerTitle(cwd: string | null, firstUserText: string | null, startedAt: string | undefined, ledger: TabLedgerEntry[]): string | null {
	if (cwd === null || firstUserText === null) return null;
	const bucket = sessionBucketForCwd(cwd);
	const sessionAt = startedAt ? Date.parse(startedAt) : Number.NaN;
	let best: { title: string; at: number } | null = null;
	let candidates = 0;
	for (const entry of ledger) {
		if (sessionBucketForCwd(entry.cwd) !== bucket || !hasLedgerPrefix(entry, firstUserText)) continue;
		// 与 tab-runs.ts probeSessionsForDispatch 同款：会话不能早于派发 60 秒以上。
		// 这使同桶同 taskId 的后续重派发不会覆盖更早会话的标题。
		if (!Number.isNaN(sessionAt) && entry.dispatchedAtMs > 0 && sessionAt < entry.dispatchedAtMs - 60_000) continue;
		candidates += 1;
		if (best === null || entry.dispatchedAtMs > best.at) best = { title: entry.title, at: entry.dispatchedAtMs };
	}
	// 缺 session 时间时，同 taskId 的多条台账没有可验证关联；宁可回退 P2，不猜最新记录。
	return Number.isNaN(sessionAt) && candidates > 1 ? null : (best?.title ?? null);
}

// ── P2：首条 user 剥前缀（taskTitleLabel 同款，独立重实现）────────

/**
 * launch.ts taskTitleLabel 的 prompt 分支同款规则（独立实现）：
 * 跳过 `##`/`>`/「根据X进行工作」行，取首个有意义行，去 markdown 噪音 / `Item N` /
 * `(P0)` / 句尾标点，截 24 字符；无有意义行 → null（回退 P3）。
 */
export function deriveTitleFromFirstUserText(text: string | null): string | null {
	if (text === null) return null;
	const firstLine =
		text
			.split(/\r?\n/)
			.map((l) => l.trim())
			.find((l) => l && !/^(##|>|根据workflow进行工作|根据research进行工作|根据execute进行工作|根据adaptive进行工作)/.test(l)) ?? "";
	if (!firstLine) return null;
	const label = firstLine
		.replace(/^[*#\-\s]+/, "")
		.replace(/^(?:Item\s+\d+\s*[—\-:]*\s*)/i, "")
		.replace(/[（(]P[0-9][）)]/g, "")
		.replace(/[。.!！]+$/, "")
		.slice(0, 24)
		.trim();
	return label || null;
}

// ── 解析链入口 ───────────────────────────────────────────────────

/** 单会话解析（纯函数；ledger 可预载注入）。 */
export function resolveSessionTitle(
	session: { sessionId: string; cwd: string | null; firstUserText: string | null; startedAt?: string | null },
	ledger: TabLedgerEntry[],
): SessionTitle {
	const fromLedger = pickLedgerTitle(session.cwd, session.firstUserText, session.startedAt ?? undefined, ledger);
	if (fromLedger !== null) return { title: fromLedger, source: "ledger" };
	const fromUser = deriveTitleFromFirstUserText(session.firstUserText);
	if (fromUser !== null) return { title: fromUser, source: "first-user" };
	return { title: session.sessionId, source: "id" };
}

/** 批量解析：台账整目录读一次（缺失/全损 = 空台账，P2/P3 照常）。 */
export function resolveSessionTitles(sessions: SessionSummary[], runsDir: string = tabRunsDir()): Map<string, SessionTitle> {
	const ledger = loadTabLedger(runsDir);
	const map = new Map<string, SessionTitle>();
	for (const s of sessions) map.set(s.sessionId, resolveSessionTitle(s, ledger));
	return map;
}
