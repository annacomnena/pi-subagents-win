/**
 * `runtime/transcript-marker-probe.ts` — **D3 的反查**：outbox 消息到底有没有进会话？
 *
 * ## 为什么需要它（A 类死锁）
 *
 * `attempt.status=unconfirmed` + `injected` 收据存在，正文却没进会话 ⇒ `consumed` ACK
 * 永不产生 ⇒ outbox 永停 pending，每次重投撞同一堵墙。真机铁证 `0a9a85cc`：
 * 目标会话活着（pid 在写盘），收据在，`grep` 正文 = 0。
 *
 * 但「正文没进」这个结论**不能靠读正文得出**（`plans/20261110_outbox_injected_deadlock_analysis.md`
 * 的否决理由：格式耦合 + 性能 + 转义差异假阴性）。违反它 = D3 应当放弃。
 *
 * ⇒ **只查一个长度固定、可精确匹配的字符串**：`buildOutboxInjectBody` 在正文尾部拼的
 * `[evt:<eventId>]`（`delivery-ack.ts::eventMarker`）。
 *
 * ## 为什么必须限定 `message.role === "user"`（这条是实测逼出来的，不是理论）
 *
 * 2026-11-16 实测：死锁 id `0a9a85cc…` 的 marker 在会话 JSONL 里**确实出现过 1 次**
 * —— 出现在一条 **assistant** 消息里（agent 把收到的正文连同 marker 一起回述）。
 * 若不限角色，「assistant 回述」会被读成「消息已进会话」＝ **假阳性** ⇒ D3 会把
 * 一个真死锁判成已送达，永远不重投。**这条约束是 D3 的正确性前提。**
 *
 * 同批实测（分母 418 条已 `delivered` 的 outbox 项、目标会话文件可全读的 252 条）：
 * ```
 * role=user 里找到 marker : 252
 * role=user 里找不到       :   0      ← 零假阴性（已送达的都能被这条判据认出来）
 * 会话文件太大只能扫尾部   : 166（判 inconclusive，不参与判定）
 * ```
 *
 * ## 三态，不许压成两态（R-20 同款纪律）
 *
 * | verdict | 含义 | 调用方该做什么 |
 * |---|---|---|
 * | `found` | 目标会话的 **user 消息**里有该 marker | 消息真进了 ⇒ **不得**重投 |
 * | `absent` | 扫完了（未截断）且没有 | 有证据的「没进」 ⇒ 允许**有界**放行一次重投 |
 * | `inconclusive` | 会话文件找不到 / 只能扫尾部没扫到 / 读失败 | **没有证据** ⇒ 保持现状（不重投），但必须可见 |
 *
 * `inconclusive` 绝不能当 `absent` 用 —— 那会把「不知道」变成「允许重投」，
 * 等于把 R-5 的取舍从「宁可重发」偷换成「不确定就重发」（2026-11-02 双投事故的形状）。
 *
 * ## 性能（实测 2026-11-16）
 *
 * 只读尾部（缺省 8MB），**不对不含 marker 的行做 JSON 解析**：
 * ```
 * 159.8MB 会话 → 读 8.4MB 尾部 + 计数 = 9.5ms
 *  44.6MB       → 8.5ms
 *  29.9MB       → 9.6ms
 *  25.9MB       → 10.8ms（含 65 行 marker 候选）
 * ```
 * 每 tick 每个 `injected-already` 项一次；该项本就是少数派（正常路径不进来）。
 */

import { closeSync, openSync, readSync, readdirSync, statSync, type Stats } from "node:fs";
import { join } from "node:path";
import { eventMarker } from "../delivery-ack.ts";

export type MarkerProbeVerdict = "found" | "absent" | "inconclusive";

export interface MarkerProbeResult {
	verdict: MarkerProbeVerdict;
	/** 实际扫过的字节数（诊断用；`absent` 只在未截断时有意义） */
	scannedBytes: number;
	/** 命中的会话文件（`found` 时非空） */
	sessionFile: string | null;
	/** 找了多少个该 sessionId 的候选文件（>`1` = 该会话被 resume 过） */
	candidateFiles: number;
	/** 是否至少有一个候选文件因太大而只扫了尾部（`inconclusive` 的主要来源） */
	truncated: boolean;
	/** 读失败原因（不抛，落进这里） */
	error?: string;
	/**
	 * 被扫文件的最后修改时刻（ms epoch；多候选取最大）。**「落盘滞后」判据的输入**。
	 * 读不到 ⇒ null。
	 */
	fileMtimeMs?: number | null;
	/**
	 * 扫到的最新一条消息行的 `timestamp`（ms epoch；会话 JSONL 里消息自带该字段）。
	 *
	 * ⚠️ **不能用它判「是否已 flush」**：实测注入消息的 timestamp 是**产生时刻**，
	 * 而它在文件里的位置可能晚于更新的行（QC 实测 line 1533 ts=06:13:26 排在 line 1532
	 * ts=06:17:32 之后 ⇒ 落后 ≥246s）。这里是诊断读数，判据用 `fileMtimeMs`。
	 */
	newestMsgTsMs?: number | null;
}

/** 缺省尾部预算：8MB（与 `transcript.ts` 的 `SESSION_TAIL_SOFT_CAP_BYTES` 同量级）。 */
export const MARKER_PROBE_TAIL_BYTES = 8 * 1024 * 1024;

/** sessionId → 候选会话文件（文件名形态 `<ts>_<sessionId>.jsonl`，sessionsDir 直下或一层 cwd 子目录）。 */
export function sessionFilesFor(sessionsDir: string, sessionId: string): string[] {
	if (!sessionId || /[/\\\s]/.test(sessionId)) return [];
	const suffix = `_${sessionId}.jsonl`;
	const out: string[] = [];
	let top: string[] = [];
	try {
		top = readdirSync(sessionsDir);
	} catch {
		return out;
	}
	for (const name of top) {
		const full = join(sessionsDir, name);
		let st: Stats;
		try {
			st = statSync(full);
		} catch {
			continue;
		}
		if (st.isDirectory()) {
			let inner: string[] = [];
			try {
				inner = readdirSync(full);
			} catch {
				continue;
			}
			for (const f of inner) if (f.endsWith(suffix)) out.push(join(full, f));
			continue;
		}
		if (name.endsWith(suffix)) out.push(full);
	}
	return out;
}

interface ScanOutcome {
	hit: boolean;
	bytes: number;
	truncated: boolean;
	/** 文件 mtime（ms epoch）；stat 失败 ⇒ null */
	mtimeMs: number | null;
	/** 扫到的最大 `timestamp`（ms epoch）；没有/不可解析 ⇒ null */
	newestMsgTsMs: number | null;
}

/**
 * 扫一个文件（只读尾部 ≤ tailBytes）找 `[evt:<eventId>]`，**且必须在该行 `message.role==="user"`**。
 *
 * 实现细节（判别力所在）：
 *   - 先做**子串**预筛（`indexOf(marker)`）——不含标记的行**不做 JSON 解析**（性能主因）；
 *   - 命中子串后才解析该行，并要求 `message.role === "user"`；
 *   - `role` 取不到（非 message 行 / 结构异常）⇒ **不算命中**（fail-closed，见模块头）。
 */
const EMPTY_SCAN: ScanOutcome = { hit: false, bytes: 0, truncated: true, mtimeMs: null, newestMsgTsMs: null };

function scanFileForMarker(file: string, marker: string, tailBytes: number): ScanOutcome {
	let size = 0;
	let mtimeMs: number | null = null;
	try {
		const st = statSync(file);
		size = st.size;
		mtimeMs = Number.isFinite(st.mtimeMs) ? st.mtimeMs : null;
	} catch {
		return EMPTY_SCAN;
	}
	const start = size > tailBytes ? size - tailBytes : 0;
	const want = size - start;
	if (want <= 0) return { hit: false, bytes: 0, truncated: false, mtimeMs, newestMsgTsMs: null };
	let fd: number;
	try {
		fd = openSync(file, "r");
	} catch {
		return { ...EMPTY_SCAN, mtimeMs };
	}
	let buf: Buffer;
	try {
		buf = Buffer.allocUnsafe(want);
		let read = 0;
		while (read < want) {
			const n = readSync(fd, buf, read, want - read, start + read);
			if (n <= 0) break;
			read += n;
		}
		if (read < want) buf = buf.subarray(0, read);
	} catch {
		closeSync(fd);
		return { ...EMPTY_SCAN, mtimeMs };
	} finally {
		try { closeSync(fd); } catch { /* ignore */ }
	}

	// 截断扫描时首行可能不完整：丢掉（它本来就在 start 之前开始）
	let text = buf.toString("utf8");
	if (start > 0) {
		const nl = text.indexOf("\n");
		text = nl >= 0 ? text.slice(nl + 1) : "";
	}
	// 最新消息时间戳（诊断用）：只从**命中 marker 的行**取（未命中行不解析 = 性能主因）。
	// ⇒ 它是下界；只用于诊断展示，**不参与判定**（判据用 mtime，见 probe 函数头）。
	let newestMsgTsMs: number | null = null;
	const lines = text.split("\n");
	for (const line of lines) {
		if (line.length === 0) continue;
		if (line.indexOf(marker) < 0) continue;
		let role: unknown;
		let ts: unknown;
		try {
			const e = JSON.parse(line) as { message?: { role?: unknown; timestamp?: unknown }; type?: unknown; timestamp?: unknown };
			// 只认 message 行上的 role；toolResult / compaction / 其它 type 一律不认
			if (e?.type !== "message") continue;
			role = e?.message?.role;
			ts = e?.message?.timestamp ?? e?.timestamp;
		} catch {
			continue;
		}
		const tsMs = typeof ts === "string" ? Date.parse(ts) : Number.NaN;
		if (Number.isFinite(tsMs) && (newestMsgTsMs === null || tsMs > newestMsgTsMs)) newestMsgTsMs = tsMs;
		if (role !== "user") continue;
		return { hit: true, bytes: buf.length, truncated: start > 0, mtimeMs, newestMsgTsMs };
	}
	return { hit: false, bytes: buf.length, truncated: start > 0, mtimeMs, newestMsgTsMs };
}

/**
 * 判定「这条 outbox 消息是否真的进了目标会话」。**never-throw**。
 *
 * @param tailBytes 单文件尾部预算；缺省 {@link MARKER_PROBE_TAIL_BYTES}
 */
export function probeEventMarkerInUserMessages(opts: {
	sessionsDir: string;
	sessionId: string;
	eventId: string;
	tailBytes?: number;
	/**
	 * 该消息**被注入的时刻**（ms epoch）。提供则启用「落盘滞后」判据（P0-b，2026-11-24）：
	 * 只有当**文件在注入之后确实被追加过**（`mtime > injectedAtMs`）时，才允许把「扫不到」
	 * 判成 `absent`；否则降级为 `inconclusive`（`error: "no-flush-since-attempt"`）。
	 *
	 * 不提供 ⇒ 保持旧行为（只按截断判据），调用方可逐步接入。
	 */
	injectedAtMs?: number;
	/** 本函数内取「现在」的时刻（测试注入；缺省 `Date.now()`）。 */
	now?: number;
}): MarkerProbeResult {
	const base: MarkerProbeResult = { verdict: "inconclusive", scannedBytes: 0, sessionFile: null, candidateFiles: 0, truncated: false };
	try {
		const marker = eventMarker(opts.eventId);
		const files = sessionFilesFor(opts.sessionsDir, opts.sessionId);
		if (files.length === 0) return { ...base, verdict: "inconclusive", error: "session-file-not-found" };
		const tail = Math.max(1, Math.trunc(opts.tailBytes ?? MARKER_PROBE_TAIL_BYTES));
		let scanned = 0;
		let truncated = false;
		let mtimeMs: number | null = null;
		let newestMsgTsMs: number | null = null;
		for (const f of files) {
			const r = scanFileForMarker(f, marker, tail);
			scanned += r.bytes;
			truncated = truncated || r.truncated;
			if (r.mtimeMs !== null && (mtimeMs === null || r.mtimeMs > mtimeMs)) mtimeMs = r.mtimeMs;
			if (r.newestMsgTsMs !== null && (newestMsgTsMs === null || r.newestMsgTsMs > newestMsgTsMs)) newestMsgTsMs = r.newestMsgTsMs;
			if (r.hit) {
				return { verdict: "found", scannedBytes: scanned, sessionFile: f, candidateFiles: files.length, truncated, mtimeMs, newestMsgTsMs };
			}
		}
		// 扫完都没找到：**两层**条件都满足才有资格说 absent。
		if (truncated) {
			return { verdict: "inconclusive", scannedBytes: scanned, sessionFile: null, candidateFiles: files.length, truncated, mtimeMs, newestMsgTsMs, error: "truncated-scan" };
		}
		// ── P0-b：「落盘滞后」判据 ────────────────────────────────────────────
		// 会话 JSONL 的落盘**滞后于 context** 是常态，实测注入消息的行可能晚 ≥246s 才出现
		// （QC 现场：line 1533 ts=06:13:26 排在 line 1532 ts=06:17:32 之后；D3 在 61s 时扫
		// 4.16MB，那条行还不存在 ⇒ 判 absent ⇒ 放行重投 ⇒ 同一 item 注入了两次）。
		// ⇒ 只有「文件在注入之后确实被追加过」才把「扫不到」当证据。
		//   mtime 是**追加的证据**（与 timestamp 无序性无关：消息 timestamp 是产生时刻，
		//   在文件里的位置可以乱序 —— QC 实测，故不能用 newestMsgTsMs 判 flush）。
		if (opts.injectedAtMs !== undefined && Number.isFinite(opts.injectedAtMs)) {
			if (mtimeMs === null || mtimeMs <= opts.injectedAtMs) {
				return {
					verdict: "inconclusive", scannedBytes: scanned, sessionFile: null, candidateFiles: files.length, truncated,
					mtimeMs, newestMsgTsMs,
					error: `no-flush-since-attempt(mtime=${mtimeMs === null ? "unknown" : new Date(mtimeMs).toISOString()},injectedAt=${new Date(opts.injectedAtMs).toISOString()})`,
				};
			}
		}
		return { verdict: "absent", scannedBytes: scanned, sessionFile: null, candidateFiles: files.length, truncated, mtimeMs, newestMsgTsMs };
	} catch (e) {
		return { ...base, verdict: "inconclusive", error: e instanceof Error ? e.message : String(e) };
	}
}
