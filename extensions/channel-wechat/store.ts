/**
 * channel-wechat/store.ts — 微信接收私有持久化（W1：cursor / dedupe / inbox / state）
 *
 * 规格：plans/0924_wechat_receive_w1_spec.md §2/§4。目录布局（全部 0600 + tmp+rename 原子写，
 * 与 wechat-bind.writeWechatCreds0600 同口径；Windows ACL 尽力）：
 *   <runtimeDir>/wechat/receive/
 *     cursor.json      单账号游标 {lastBuf, prevBuf, updatedAt, epoch}（epoch = 提交计数）
 *     dedupe.jsonl     msgId 集合（每行 {id, at}；容量上限 + 裁剪计数）
 *     inbox/<safe>.json 脱敏入站记录（文本原值私有落盘；GUI 端点层再脱敏）
 *     quarantine.jsonl 非文本/坏格式条目（脱敏 reason；可查，不静默丢弃）
 *     state.json       {status, lastPollAt, counts, lastError, authRequiredAt, epoch}
 *     worker.json      supervisor 的 worker pid 文件（channel-supervisor.ts 读写）
 *
 * 不变量（§4.2/§4.3/§4.5 + MF1 修复 0924）：
 *   - commitBatch(prevBuf,nextBuf,recs) 只做游标提交——调用方（worker）必须**先** claimMessage +
 *     putInbox + quarantine 落盘，再调本方法（顺序约束替代事务，W1 诚实延期项）。
 *   - claimMessage 返回 {fresh:false, materialized:true} 的消息不得再落 inbox（去重前置）；
 *     materialized:false = dedupe 已声明但落盘事实缺失（claim 后 putInbox 失败的恢复路径）——
 *     调用方必须幂等补写，写成功才允许提交游标（claim 墓碑不得吞消息）。
 *   - 空批也由调用方调 commitBatch 推进游标（store 不判断批次是否为空）。
 *
 * 红线（§4.1）：store 只存脱敏记录——不存 bot_token/context_token（parser 已丢弃）。
 * 读方法 never-throw（缺文件/坏 JSON → 兜底）；写方法失败向上抛（fail-closed，游标不推进）。
 * 零 Pi API；只 import node 内建。
 */

import {
	chmodSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** dedupe 容量：超过即裁剪保留最近一半，并计 trims（规格：msgId 集合带容量告警）。 */
export const DEDUPE_MAX_ENTRIES = 20_000;

export type WechatReceiveStatus = "disconnected" | "polling" | "connected" | "auth_required" | "uncertain";

export interface InboundRecord {
	msgId: string;
	fromId: string;
	fromNickname: string | null;
	/** 清洗后文本（parser 上限内；GUI 端点层再截断显示）。 */
	text: string;
	receivedAt: string;
	/** W1 恒 pending（injected/rejected 留给 W2 注入门）。 */
	state: "pending" | "injected" | "rejected";
	artifactPending?: boolean;
}

export interface WechatReceiveCounts {
	polls: number;
	received: number;
	dedupeSkipped: number;
	quarantined: number;
	authErrors: number;
	transientErrors: number;
	rateLimited: number;
	protocolErrors: number;
	dedupeTrims: number;
}

export interface WechatReceiveState {
	status: WechatReceiveStatus;
	lastPollAt: string | null;
	updatedAt: string | null;
	counts: WechatReceiveCounts;
	lastError: string | null;
	authRequiredAt: string | null;
	epoch: number;
}

export interface WechatStoreStats {
	status: WechatReceiveStatus;
	lastPollAt: string | null;
	counts: WechatReceiveCounts;
	lastError: string | null;
	/** inbox 未决积压（state=pending 条数）。 */
	backlog: number;
	inboxTotal: number;
	dedupeSize: number;
	cursorEpoch: number;
	cursorPresent: boolean;
}

function emptyCounts(): WechatReceiveCounts {
	return { polls: 0, received: 0, dedupeSkipped: 0, quarantined: 0, authErrors: 0, transientErrors: 0, rateLimited: 0, protocolErrors: 0, dedupeTrims: 0 };
}

function defaultState(): WechatReceiveState {
	return { status: "disconnected", lastPollAt: null, updatedAt: null, counts: emptyCounts(), lastError: null, authRequiredAt: null, epoch: 0 };
}

/** 0600 + tmp(exclusive-create)+rename 原子写（wechat-bind.writeWechatCreds0600 同款）。 */
function atomicWrite0600(path: string, body: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	const tmp = `${path}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`;
	const fd = openSync(tmp, "wx", 0o600);
	try {
		writeFileSync(fd, body, "utf8");
	} finally {
		try {
			closeSync(fd);
		} catch {
			/* ignore */
		}
	}
	try {
		chmodSync(tmp, 0o600);
	} catch {
		/* Windows 尽力 */
	}
	try {
		renameSync(tmp, path);
	} catch (e) {
		try {
			rmSync(tmp, { force: true });
		} catch {
			/* ignore */
		}
		throw e;
	}
	try {
		chmodSync(path, 0o600);
	} catch {
		/* Windows 尽力 */
	}
}

/** msgId → 安全文件名（防路径穿越/非法字符；djb2 短哈希防脱敏碰撞）。 */
export function inboxFileName(msgId: string): string {
	const safe = msgId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
	let h = 5381;
	for (let i = 0; i < msgId.length; i++) {
		h = ((h * 33) ^ msgId.charCodeAt(i)) >>> 0;
	}
	return `${safe}.${h.toString(16)}.json`;
}

function readJsonTolerant<T>(path: string, fallback: T): T {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return fallback;
	}
}

export interface WechatStoreOptions {
	now?: () => Date;
	/** dedupe 容量上限（测试注入小值）。 */
	maxDedupeEntries?: number;
}

/** claimMessage 结果（MF1 修复 0924：区分「首次声明」与「落盘事实已在」）。 */
export interface MessageClaim {
	/** true = 本次调用首次声明（dedupe 此前不含；调用方须落盘）。 */
	fresh: boolean;
	/** true = 对应 inbox/quarantine 记录已在盘（含本次之前成功的写入）；false = 须（重新）落盘。 */
	materialized: boolean;
}

export class WechatStore {
	readonly dir: string;
	private readonly now: () => Date;
	private readonly maxDedupe: number;
	private dedupeLoaded = false;
	private dedupeIds: Set<string> = new Set();
	private dedupeOrder: string[] = [];
	private state: WechatReceiveState | null = null;

	constructor(dir: string, opts: WechatStoreOptions = {}) {
		this.dir = dir;
		this.now = opts.now ?? (() => new Date());
		this.maxDedupe = opts.maxDedupeEntries ?? DEDUPE_MAX_ENTRIES;
	}

	static resolveDir(runtimeDir: string): string {
		return join(runtimeDir, "wechat", "receive");
	}

	private iso(): string {
		return this.now().toISOString();
	}

	// ── dedupe（claim 前置；append-only jsonl + 内存集合）──────────────

	private ensureDedupeLoaded(): void {
		if (this.dedupeLoaded) return;
		this.dedupeLoaded = true;
		this.dedupeIds = new Set();
		this.dedupeOrder = [];
		try {
			const raw = readFileSync(join(this.dir, "dedupe.jsonl"), "utf8");
			for (const line of raw.split("\n")) {
				const t = line.trim();
				if (t === "") continue;
				try {
					const v = JSON.parse(t) as { id?: unknown };
					if (typeof v.id === "string" && v.id.length > 0 && !this.dedupeIds.has(v.id)) {
						this.dedupeIds.add(v.id);
						this.dedupeOrder.push(v.id);
					}
				} catch {
					/* 坏行跳过（append-only 容错） */
				}
			}
		} catch {
			/* 缺文件 = 空集 */
		}
	}

	/**
	 * 去重前置声明（MF1 修复 0924：claim 不得成为不可恢复墓碑）。
	 *   - fresh=true：msgId 未见过的 → 追加 dedupe.jsonl（durable）；调用方须落 inbox/quarantine。
	 *   - fresh=false && materialized=true：已声明**且**落盘事实已在（inbox 记录或 quarantine 行）
	 *     → 不得重复落盘/计数（§4.3 去重前置）。
	 *   - fresh=false && materialized=false：已声明但盘上无对应记录（claim 持久化后 putInbox/
	 *     recordQuarantine 失败的崩溃残留）→ 调用方必须幂等补写，写成功才允许提交游标。
	 * dedupe 追加失败向上抛（fail-closed：宁可不推进游标）；materialized 检查 never-throw
	 * （读失败按未落盘处理 → 走补写，方向安全：多写一次幂等，不丢消息）。
	 */
	claimMessage(msgId: string): MessageClaim {
		if (msgId.length === 0) return { fresh: false, materialized: true }; // 空 id：无可落盘事实，跳过
		this.ensureDedupeLoaded();
		if (this.dedupeIds.has(msgId)) return { fresh: false, materialized: this.isMaterialized(msgId) };
		mkdirSync(this.dir, { recursive: true });
		let line = `${JSON.stringify({ id: msgId, at: this.iso() })}\n`;
		// 容量：超限 → 裁剪保留最近一半（原子重写；trims 计数持久告警）
		if (this.dedupeOrder.length + 1 > this.maxDedupe) {
			const keep = this.dedupeOrder.slice(Math.floor(this.maxDedupe / 2));
			const kept = new Set(keep);
			const lines = keep.map((id) => `${JSON.stringify({ id, at: this.iso() })}\n`).join("");
			atomicWrite0600(join(this.dir, "dedupe.jsonl"), lines || "\n");
			this.dedupeIds = kept;
			this.dedupeOrder = [...keep];
			this.bumpState((s) => {
				s.counts.dedupeTrims += 1;
			});
		}
		// 追加（openSync append 语义：readFileSync→+line→rewrite 原子化，避免 O_APPEND 与原子写口径分裂）
		const prev = (() => {
			try {
				return readFileSync(join(this.dir, "dedupe.jsonl"), "utf8");
			} catch {
				return "";
			}
		})();
		atomicWrite0600(join(this.dir, "dedupe.jsonl"), prev.endsWith("\n") || prev === "" ? `${prev}${line}` : `${prev}\n${line}`);
		this.dedupeIds.add(msgId);
		this.dedupeOrder.push(msgId);
		return { fresh: true, materialized: false };
	}

	/** msgId 的落盘事实是否已在盘（inbox 记录 msgId 匹配，或 quarantine 行含该 msgId；never-throw）。 */
	private isMaterialized(msgId: string): boolean {
		try {
			const v = readJsonTolerant<Partial<InboundRecord> | null>(join(this.dir, "inbox", inboxFileName(msgId)), null);
			if (v !== null && v.msgId === msgId) return true;
		} catch {
			/* ignore */
		}
		try {
			const raw = readFileSync(join(this.dir, "quarantine.jsonl"), "utf8");
			for (const line of raw.split("\n")) {
				const t = line.trim();
				if (t === "") continue;
			try {
					const v = JSON.parse(t) as { msgId?: unknown };
					if (v.msgId === msgId) return true;
				} catch {
					/* 坏行跳过 */
				}
			}
		} catch {
			/* 缺文件 = 未落盘 */
		}
		return false;
	}

	dedupeSize(): number {
		this.ensureDedupeLoaded();
		return this.dedupeIds.size;
	}

	// ── inbox（脱敏私有记录）────────────────────────────────────────

	/**
	 * 落一条入站记录（原子写 inbox/<safe>.json）。失败抛（游标不得推进）。
	 * 返回 true = 本次**新建**（此前无该 msgId 的 inbox 文件）；false = 覆盖既有（重放/补写）。
	 *
	 * MF1 收敛（0924）：调用方必须据此计数，**不得**用 `claim.materialized` 推断——
	 * `isMaterialized` 读失败/坏 JSON/去重容量裁剪后均会偏 false，若据此 bump 会把
	 * 同一条消息重复计成 received（L4 收敛轮指出）。计数只能来自“是否真的新写入”。
	 */
	putInbox(rec: InboundRecord): boolean {
		mkdirSync(join(this.dir, "inbox"), { recursive: true });
		const file = join(this.dir, "inbox", inboxFileName(rec.msgId));
		const existed = existsSync(file);
		atomicWrite0600(file, `${JSON.stringify(rec, null, 2)}\n`);
		return !existed;
	}

	/** 读最近 limit 条（receivedAt 降序；never-throw）。 */
	readInbox(limit: number): InboundRecord[] {
		const out: InboundRecord[] = [];
		try {
			const files = readdirSync(join(this.dir, "inbox"));
			for (const f of files) {
				if (!f.endsWith(".json") || f.endsWith(".tmp")) continue;
				const v = readJsonTolerant<Partial<InboundRecord> | null>(join(this.dir, "inbox", f), null);
				if (v === null || typeof v.msgId !== "string") continue;
				out.push({
					msgId: v.msgId,
					fromId: typeof v.fromId === "string" ? v.fromId : "",
					fromNickname: typeof v.fromNickname === "string" ? v.fromNickname : null,
					text: typeof v.text === "string" ? v.text : "",
					receivedAt: typeof v.receivedAt === "string" ? v.receivedAt : "",
					state: v.state === "injected" || v.state === "rejected" ? v.state : "pending",
					...(v.artifactPending === true ? { artifactPending: true } : {}),
				});
			}
		} catch {
			return [];
		}
		out.sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : a.receivedAt > b.receivedAt ? -1 : a.msgId < b.msgId ? 1 : -1));
		return Number.isInteger(limit) && limit > 0 ? out.slice(0, limit) : out;
	}

	/** inbox 总条数 / pending 积压（never-throw）。 */
	inboxCounts(): { total: number; backlog: number } {
		const all = this.readInbox(0);
		return { total: all.length, backlog: all.filter((r) => r.state === "pending").length };
	}

	// ── quarantine（失败不吞：可查记录）──────────────────────────────

	recordQuarantine(entry: { msgId: string | null; reason: string; at: string; artifactPending?: boolean }): void {
		mkdirSync(this.dir, { recursive: true });
		const prev = (() => {
			try {
				return readFileSync(join(this.dir, "quarantine.jsonl"), "utf8");
			} catch {
				return "";
			}
		})();
		const line = `${JSON.stringify({ msgId: entry.msgId, reason: entry.reason, at: entry.at, ...(entry.artifactPending === true ? { artifactPending: true } : {}) })}\n`;
		atomicWrite0600(join(this.dir, "quarantine.jsonl"), prev.endsWith("\n") || prev === "" ? `${prev}${line}` : `${prev}\n${line}`);
		this.bumpState((s) => {
			s.counts.quarantined += 1;
		});
	}

	// ── cursor（顺序不变量：最后提交）────────────────────────────────

	getCursor(): { lastBuf: string; epoch: number } {
		const v = readJsonTolerant<{ lastBuf?: unknown; epoch?: unknown } | null>(join(this.dir, "cursor.json"), null);
		return {
			lastBuf: typeof v?.lastBuf === "string" ? v.lastBuf : "",
			epoch: typeof v?.epoch === "number" && Number.isFinite(v.epoch) ? v.epoch : 0,
		};
	}

	/**
	 * 提交游标（原子写 cursor.json：{lastBuf:nextBuf, prevBuf, updatedAt, epoch+1}）。
	 * 调用方必须已落盘本批全部 inbox/dedupe/quarantine（§4.2 顺序不变量；W1 用顺序替代事务）。
	 * 失败抛（下次以 prevBuf 重拉 → claimMessage 幂等去重；materialized=false 的残留 → 幂等补写）。
	 */
	commitBatch(prevBuf: string, nextBuf: string, recs: InboundRecord[]): void {
		if (nextBuf.length === 0) throw new Error("commitBatch 拒绝空 nextBuf（不推进游标）");
		const cur = this.getCursor();
		if (cur.lastBuf !== prevBuf && cur.epoch > 0) {
			throw new Error(`commitBatch 游标不连续：期望 prevBuf=当前 lastBuf（epoch=${cur.epoch}）`);
		}
		mkdirSync(this.dir, { recursive: true });
		const epoch = cur.epoch + 1;
		atomicWrite0600(
			join(this.dir, "cursor.json"),
			`${JSON.stringify({ lastBuf: nextBuf, prevBuf, updatedAt: this.iso(), epoch, ids: recs.map((r) => r.msgId) }, null, 2)}\n`,
		);
		this.bumpState((s) => {
			s.epoch = epoch;
		});
	}

	// ── state.json（状态投影 + 计数；never-throw 读，写失败抛）────────

	readState(): WechatReceiveState {
		if (this.state !== null) return this.state;
		const v = readJsonTolerant<Partial<WechatReceiveState> | null>(join(this.dir, "state.json"), null);
		const d = defaultState();
		if (v === null || typeof v !== "object") return d;
		const okStatus = ["disconnected", "polling", "connected", "auth_required", "uncertain"];
		return {
			status: typeof v.status === "string" && okStatus.includes(v.status) ? (v.status as WechatReceiveStatus) : d.status,
			lastPollAt: typeof v.lastPollAt === "string" ? v.lastPollAt : null,
			updatedAt: typeof v.updatedAt === "string" ? v.updatedAt : null,
			counts: typeof v.counts === "object" && v.counts !== null ? { ...emptyCounts(), ...(v.counts as Partial<WechatReceiveCounts>) } : emptyCounts(),
			lastError: typeof v.lastError === "string" ? v.lastError : null,
			authRequiredAt: typeof v.authRequiredAt === "string" ? v.authRequiredAt : null,
			epoch: typeof v.epoch === "number" && Number.isFinite(v.epoch) ? v.epoch : 0,
		};
	}

	private bumpState(mut: (s: WechatReceiveState) => void): WechatStore {
		const s = { ...this.readState(), counts: { ...this.readState().counts } };
		mut(s);
		s.updatedAt = this.iso();
		this.state = s;
		try {
			atomicWrite0600(join(this.dir, "state.json"), `${JSON.stringify(s, null, 2)}\n`);
		} catch (e) {
			// state.json 是易失投影：写失败不炸 worker（返回值/游标已 durable），只保内存值
			this.state = s;
			if (!(e instanceof Error)) throw e;
		}
		return this;
	}

	/** 状态迁移 + 可选计数/lastError（持久化；auth_required 带 authRequiredAt 持久告警）。 */
	setStatus(
		status: WechatReceiveStatus,
		extra: { lastError?: string | null; bump?: keyof WechatReceiveCounts; touchPoll?: boolean } = {},
	): void {
		this.bumpState((s) => {
			s.status = status;
			if (extra.lastError !== undefined) s.lastError = extra.lastError;
			if (extra.bump !== undefined) s.counts[extra.bump] += 1;
			if (extra.touchPoll === true) s.lastPollAt = this.iso();
			if (status === "auth_required") s.authRequiredAt = this.iso();
		});
	}

	/** 计一次 poll（lastPollAt 持久；never-throw 面：写失败不影响调用方）。 */
	touchPoll(): void {
		this.bumpState((s) => {
			s.counts.polls += 1;
			s.lastPollAt = this.iso();
		});
	}

	bumpCount(key: keyof WechatReceiveCounts): void {
		this.bumpState((s) => {
			s.counts[key] += 1;
		});
	}

	/** 聚合统计（never-throw；供 /v1/wechat/worker/status）。 */
	stats(): WechatStoreStats {
		const s = this.readState();
		const { total, backlog } = this.inboxCounts();
		return {
			status: s.status,
			lastPollAt: s.lastPollAt,
			counts: s.counts,
			lastError: s.lastError,
			backlog,
			inboxTotal: total,
			dedupeSize: this.dedupeSize(),
			cursorEpoch: this.getCursor().epoch,
			cursorPresent: this.getCursor().epoch > 0,
		};
	}
}
