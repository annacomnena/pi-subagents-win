/**
 * runtime/stream-gen.ts — G6-P1 L4 必修①：流文件持久代际（generation）判代 sidecar 纯库
 * （plans/0921_g6p1_review.md §必修结论 1）。
 *
 * 问题：`logEpoch`（journal 首 envelope id / transcript session 头 id）不能识别「保留首行的
 * 重写/轮转」——重写后首 id 不变 → 旧 base 被误判同代 → resume 把不同代际的相同行号当旧
 * 历史，违反不重不漏。文件变短已有 byte-cursor 截断检出，但**等长替换/变长重写**离线期不可见。
 *
 * 方案：host 维护 sidecar `<runtimeDir>/state/stream-gen.json`（跨 host 重启持久），按流键
 * 记录 `{ firstId, size, fullHash, gen, updatedAt }`：
 *   - `firstId` = 首 record id（= logEpoch；"" = 上次校验时无完整记录）；
 *   - `size`/`fullHash` = 校验时文件字节数与整文件 sha1（廉价：一次 read + 两次 hash）；
 *   - `gen` = 代际号，从 1 起。
 *
 * 判定（每次 resume / subscribe 前调 `validateStreamGen`）：
 *   1. 无记录 → 建 gen=1；
 *   2. size+fullHash 全同 → 未变（fast path，不写盘）；
 *   3. firstId 变（双方非空）→ 重写/轮转 → gen+1（epoch 本也会变，bump 保持一致）；
 *   4. size 增长且前缀 [0..旧size) 哈希与旧 fullHash 一致 → 纯追加 → gen 不变（更新记录）；
 *   5. 其余（等长替换、变长重写、截断、首 id 缺失期）→ firstId 相同即 gen+1（核心检出）；
 *      上次无完整记录（firstId=""）无从判代 → 不 bump（正常从空增长路径）。
 * resume 协议：客户端 base 带 `gen`（ack/GET head 回带）；base.gen ≠ 当前 gen → snapshot
 * （客户端重 GET 全量再以新 head 重订阅）→ 不重不漏。base 无 gen（旧客户端）→ 仅 epoch 判代
 * （向后兼容，回退到修复前语义）。
 *
 * 残余局限（明示不设防）：
 *   - sidecar 丢失/损坏 → 各流 gen 从 1 重来，退化回 epoch-only 判代；
 *   - 重写后与上次**逐字节完全一致**（含 size）→ 无信息可检，不设防（也无害：内容相同）；
 *   - live 连接期不做 gen 校验（250ms tick 只做 byte-cursor 截断检出）；等长重写在该连接的
 *     下次 resume 必被检出；
 *   - 上次校验时无完整记录（firstId=""）期间的变更无从判代。
 *
 * 红线：只读流文件、tolerant（sidecar 坏 JSON/IO 失败落兜底、never-throw）、§22（投影状态
 * 可再生意，非真相）。纯 node 内建。
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultRuntimeDir } from "./journal.ts";

// ── 状态模型 ─────────────────────────────────────────────────────

export interface StreamGenEntry {
	/** 首 record id（journal 首 envelope id / transcript session 头 id；"" = 校验时无完整记录）。 */
	firstId: string;
	/** 校验时文件字节数。 */
	size: number;
	/** 校验时整文件 sha1 hex。 */
	fullHash: string;
	/** 代际号（检测到非追加变更 → +1；从 1 起）。 */
	gen: number;
	/** ISO 时间（诊断用）。 */
	updatedAt: string;
}

export interface StreamGenState {
	version: 1;
	/** 流键 → 记录。流键：`journal` | `session:<sessionId>`。 */
	streams: Record<string, StreamGenEntry>;
}

export function streamGenPath(): string {
	return join(defaultRuntimeDir(), "state", "stream-gen.json");
}

/** 读 sidecar（tolerant：缺失/坏 JSON/形状不符 → 空状态，永不 throw）。 */
export function readStreamGenState(path: string = streamGenPath()): StreamGenState {
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		if (typeof raw !== "object" || raw === null || raw.version !== 1) return { version: 1, streams: {} };
		const streams = typeof raw.streams === "object" && raw.streams !== null ? raw.streams : {};
		const out: Record<string, StreamGenEntry> = {};
		for (const [k, v] of Object.entries(streams as Record<string, unknown>)) {
			const e = v as Record<string, unknown>;
			if (
				typeof e === "object" && e !== null &&
				typeof e.firstId === "string" &&
				typeof e.size === "number" && e.size >= 0 && Number.isInteger(e.size) &&
				typeof e.fullHash === "string" &&
				typeof e.gen === "number" && e.gen >= 1 && Number.isInteger(e.gen)
			) {
				out[k] = { firstId: e.firstId, size: e.size, fullHash: e.fullHash, gen: e.gen, updatedAt: typeof e.updatedAt === "string" ? e.updatedAt : "" };
			}
		}
		return { version: 1, streams: out };
	} catch {
		return { version: 1, streams: {} };
	}
}

/** 原子写 sidecar（tmp+rename；失败吞掉——sidecar 是易失投影，写失败 ≠ 校验失败）。 */
function writeStreamGenState(state: StreamGenState, path: string): void {
	const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
	try {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
		renameSync(tmp, path);
	} catch {
		try {
			rmSync(tmp, { force: true });
		} catch {
			/* ignore */
		}
	}
}

// ── 校验（每次 resume / subscribe 前调）──────────────────────────

export interface ValidateStreamGenOptions {
	/** sidecar 路径（缺省 streamGenPath()；测试注入隔离用）。 */
	statePath?: string;
}

function sha1hex(buf: Buffer): string {
	return createHash("sha1").update(buf).digest("hex");
}

/**
 * 校验并推进流代际：对比 sidecar 记录与文件现状，检出「保留首行的重写/轮转」等非追加变更
 * → gen+1；纯追加/未变 → gen 不变。返回当前 gen。never-throw（IO 失败落兜底 gen）。
 *
 * @param key      流键（`journal` | `session:<sessionId>`）
 * @param path     流文件路径
 * @param firstId  本次读到的首 record id（与 logEpoch 同源：调用方用同一 scan/project 结果传入）
 */
export function validateStreamGen(key: string, path: string, firstId: string, opts?: ValidateStreamGenOptions): number {
	const statePath = opts?.statePath ?? streamGenPath();
	try {
		let buf: Buffer;
		try {
			buf = readFileSync(path);
		} catch {
			buf = Buffer.alloc(0);
		}
		const size = buf.length;
		const fullHash = sha1hex(buf);

		const state = readStreamGenState(statePath);
		const entry = state.streams[key];
		if (entry === undefined) {
			state.streams[key] = { firstId, size, fullHash, gen: 1, updatedAt: new Date().toISOString() };
			writeStreamGenState(state, statePath);
			return 1;
		}
		if (entry.size === size && entry.fullHash === fullHash) return entry.gen; // 未变（不写盘）

		let bump: boolean;
		if (entry.firstId !== "" && firstId !== entry.firstId) {
			bump = true; // 首记录 id 变（轮转/重写换首行；epoch 本也变，bump 保持一致）
		} else if (entry.firstId !== "" && size > entry.size && sha1hex(buf.subarray(0, entry.size)) === entry.fullHash) {
			bump = false; // 纯追加：前缀逐字节完好
		} else if (entry.firstId !== "") {
			bump = true; // 前缀不再完好：等长替换 / 变长重写 / 截断重写（核心检出）
		} else {
			bump = false; // 上次无完整记录，无从判代（正常从空增长）
		}
		const gen = bump ? entry.gen + 1 : entry.gen;
		state.streams[key] = { firstId, size, fullHash, gen, updatedAt: new Date().toISOString() };
		writeStreamGenState(state, statePath);
		return gen;
	} catch {
		// 兜底：任何意外不炸调用方（gen 尽力沿用盘面记录）
		return readStreamGenState(statePath).streams[key]?.gen ?? 1;
	}
}
