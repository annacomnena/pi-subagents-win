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
}

/**
 * 扫一个文件（只读尾部 ≤ tailBytes）找 `[evt:<eventId>]`，**且必须在该行 `message.role==="user"`**。
 *
 * 实现细节（判别力所在）：
 *   - 先做**子串**预筛（`indexOf(marker)`）——不含标记的行**不做 JSON 解析**（性能主因）；
 *   - 命中子串后才解析该行，并要求 `message.role === "user"`；
 *   - `role` 取不到（非 message 行 / 结构异常）⇒ **不算命中**（fail-closed，见模块头）。
 */
function scanFileForMarker(file: string, marker: string, tailBytes: number): ScanOutcome {
	let size = 0;
	try {
		size = statSync(file).size;
	} catch {
		return { hit: false, bytes: 0, truncated: true };
	}
	const start = size > tailBytes ? size - tailBytes : 0;
	const want = size - start;
	if (want <= 0) return { hit: false, bytes: 0, truncated: false };
	let fd: number;
	try {
		fd = openSync(file, "r");
	} catch {
		return { hit: false, bytes: 0, truncated: true };
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
		return { hit: false, bytes: 0, truncated: true };
	} finally {
		try { closeSync(fd); } catch { /* ignore */ }
	}

	// 截断扫描时首行可能不完整：丢掉（它本来就在 start 之前开始）
	let text = buf.toString("utf8");
	if (start > 0) {
		const nl = text.indexOf("\n");
		text = nl >= 0 ? text.slice(nl + 1) : "";
	}
	const lines = text.split("\n");
	for (const line of lines) {
		if (line.length === 0) continue;
		if (line.indexOf(marker) < 0) continue;
		let role: unknown;
		try {
			const e = JSON.parse(line) as { message?: { role?: unknown }; type?: unknown };
			// 只认 message 行上的 role；toolResult / compaction / 其它 type 一律不认
			if (e?.type !== "message") continue;
			role = e?.message?.role;
		} catch {
			continue;
		}
		if (role !== "user") continue;
		return { hit: true, bytes: buf.length, truncated: start > 0 };
	}
	return { hit: false, bytes: buf.length, truncated: start > 0 };
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
}): MarkerProbeResult {
	const base: MarkerProbeResult = { verdict: "inconclusive", scannedBytes: 0, sessionFile: null, candidateFiles: 0, truncated: false };
	try {
		const marker = eventMarker(opts.eventId);
		const files = sessionFilesFor(opts.sessionsDir, opts.sessionId);
		if (files.length === 0) return { ...base, verdict: "inconclusive", error: "session-file-not-found" };
		const tail = Math.max(1, Math.trunc(opts.tailBytes ?? MARKER_PROBE_TAIL_BYTES));
		let scanned = 0;
		let truncated = false;
		for (const f of files) {
			const r = scanFileForMarker(f, marker, tail);
			scanned += r.bytes;
			truncated = truncated || r.truncated;
			if (r.hit) return { verdict: "found", scannedBytes: scanned, sessionFile: f, candidateFiles: files.length, truncated };
		}
		// 扫完都没找到：只有**全部文件都未截断**时才有资格说 absent
		return {
			verdict: truncated ? "inconclusive" : "absent",
			scannedBytes: scanned,
			sessionFile: null,
			candidateFiles: files.length,
			truncated,
			...(truncated ? { error: "truncated-scan" } : {}),
		};
	} catch (e) {
		return { ...base, verdict: "inconclusive", error: e instanceof Error ? e.message : String(e) };
	}
}
