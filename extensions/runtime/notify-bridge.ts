/**
 * runtime/notify-bridge.ts — 让 `ctx.ui.notify` 的输出也能到达 GUI（2026-10-21）
 *
 * ## 为什么需要（根因，源码直读）
 * `ctx.ui.notify` 是 `ExtensionUIContext` 的 TUI 方法（`types.d.ts:80`），由 pi 在
 * `interactive-mode.js:1983` 造出（`notify: (message, type) => this.showExtensionNotify(...)`）。
 * pi **不提供任何 notification 类事件钩子**（已核 `pi.on` 全部事件名）。
 *
 * ⇒ 本仓 **137 个 `ctx.ui.notify(...)` 调用点、11 个文件**的输出**只有 TUI 能看见**。
 * 这不是「某个命令没适配」，是**整个 notify 通道单向只通 TUI**。典型症状：
 * `/today-usage` 在 TUI 里输出完整统计，GUI 一个字都没有。
 *
 * ## 拦截点（不改 137 个调用点）
 * pi 的 `pi` 对象是普通 object literal（`dist/core/extensions/loader.js:242`），
 * 而 handler 的唯一调用点是 `agent-session.js:1579` `await command.handler(args, ctx)`。
 * ⇒ 在扩展 init 最早期**影子化 `pi.registerCommand`**，把每个 handler 包一层，
 * 注入一个 `ui.notify` 被代理的 ctx：先落盘、**再照常调原 notify**（TUI 行为零变化）。
 *
 * ## 已知限制（本模块只做 command 侧）
 * - **只覆盖 command handler 内**的 notify。事件钩子（`session_start`/`agent_end` 等）
 *   拿的是 `ExtensionContext`，不经过 `registerCommand` ⇒ 这套代理够不着。
 * - `ui.select/confirm/input` 不代理：它们是交互式对话框，远程呈现语义完全不同。
 *
 * ## 存储：JSONL 追加 + 按天切
 * `state/notify/<sessionId>-<YYYYMMDD>.jsonl`，**追加写不覆盖**：
 * - 天然并发安全（单行 < 4KB）
 * - 天然可 tail（GUI 按字节 offset 增量读）
 * - 不需要 ring buffer 重写（避免「读-改-写」丢数据）
 *
 * never-throw：落盘失败绝不能阻断原 notify（notify 是诊断通道，不是主链路）。
 */

import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { defaultRuntimeDir } from "./journal.ts";

/** notify 级别（与 pi 的 `notify(message, type?)` 对齐）。 */
export type NotifyLevel = "info" | "warning" | "error";

export interface NotifyRecord {
	id: string;
	at: string;
	sessionId: string;
	level: NotifyLevel;
	/** 原文（**不截断**：GUI 侧自己决定怎么省略；截断就丢信息了）。 */
	text: string;
	/** 来源：`command:<name>` / `event:<name>` / `unknown`。 */
	source: string;
	pid: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** 保留天数（启动时清理更早的天文件）。 */
export const NOTIFY_RETENTION_DAYS = 7;

/** notify 目录（缺省 `<runtimeDir>/state/notify`）。 */
export function notifyDir(runtimeDir: string = defaultRuntimeDir()): string {
	return join(runtimeDir, "state", "notify");
}

/** 本地日键 YYYYMMDD（与 `/today-usage` 的「本地日」口径一致）。 */
export function dayKey(d: Date): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	return `${y}${m}${dd}`;
}

/** 会话 + 日 → 文件路径。sessionId 非法时用 `_unknown`（fail-open，见 plan §6）。 */
export function notifyFilePath(sessionId: string, now: Date, runtimeDir: string = defaultRuntimeDir()): string {
	// sessionId 只允许安全字符（防路径穿越）；其余归一为 _unknown
	const safe = /^[A-Za-z0-9_.-]+$/.test(sessionId) ? sessionId : "_unknown";
	return join(notifyDir(runtimeDir), `${safe}-${dayKey(now)}.jsonl`);
}

let seq = 0;

/** 造一条记录（纯函数，便于测试）。 */
export function makeNotifyRecord(input: {
	sessionId: string;
	level: NotifyLevel;
	text: string;
	source: string;
	now: Date;
	pid?: number;
}): NotifyRecord {
	seq = (seq + 1) % 1_000_000;
	const rand = Math.random().toString(36).slice(2, 8);
	return {
		id: `ntf_${input.now.getTime().toString(36)}_${seq.toString(36)}_${rand}`,
		at: input.now.toISOString(),
		sessionId: input.sessionId,
		level: input.level,
		text: input.text,
		source: input.source,
		pid: input.pid ?? process.pid,
	};
}

/**
 * 追加一条 notify 到盘面。**never-throw**（落盘失败只返回 false）。
 */
export function appendNotify(rec: NotifyRecord, runtimeDir: string = defaultRuntimeDir()): boolean {
	try {
		const dir = notifyDir(runtimeDir);
		mkdirSync(dir, { recursive: true });
		const path = notifyFilePath(rec.sessionId, new Date(rec.at), runtimeDir);
		// 单行 JSON + \n：追加写，天然并发安全（单次 write 远小于 PIPE_BUF）
		appendFileSync(path, `${JSON.stringify(rec)}\n`, "utf8");
		return true;
	} catch {
		return false;
	}
}

/** 清理超过保留期的天文件（best-effort；返回删除数）。 */
export function pruneNotifyFiles(runtimeDir: string = defaultRuntimeDir(), now = new Date()): number {
	let removed = 0;
	try {
		const dir = notifyDir(runtimeDir);
		const cutoff = now.getTime() - NOTIFY_RETENTION_DAYS * DAY_MS;
		for (const f of readdirSync(dir)) {
			const m = /-(\d{8})\.jsonl$/.exec(f);
			if (m === null) continue;
			const key = m[1]!;
			const d = new Date(
				Number(key.slice(0, 4)),
				Number(key.slice(4, 6)) - 1,
				Number(key.slice(6, 8)),
			);
			if (Number.isNaN(d.getTime())) continue;
			// 用「天文件代表的那一天 00:00」与 cutoff 比：整天的都被过期才删
			if (d.getTime() < cutoff) {
				try {
					rmSync(join(dir, f), { force: true });
					removed += 1;
				} catch {
					/* 单文件失败不影响其他 */
				}
			}
		}
	} catch {
		/* never-throw */
	}
	return removed;
}

// ── 读取（GUI 侧，按 offset 增量）─────────────────────────────

export interface NotifyReadResult {
	records: NotifyRecord[];
	/** 下次请求的 offset（字节）。 */
	nextOffset: number;
	/** 文件不存在 = true（无害空态，不是错误）。 */
	absent: boolean;
}

/** 单次最大返回条数（防一次刷屏）。 */
const MAX_RETURN = 50;
/** 超过此大小只读尾部（性能纪律，Item 57 教训）。 */
const TAIL_CAP_BYTES = 1024 * 1024;

/**
 * 读 notify（三态）。
 *
 * - `after` 缺省/0 ⇒ 读**当前天文件**尾部（首屏，最多 MAX_RETURN 条）
 * - `after>0` ⇒ 只解析该 offset 之后的新行
 *
 * **只读一个天文件**，绝不扫目录、绝不全量读（>1MB 时只读尾块）。
 */
export function readNotify(
	sessionId: string,
	after: number | undefined,
	now: Date,
	runtimeDir: string = defaultRuntimeDir(),
): NotifyReadResult {
	const path = notifyFilePath(sessionId, now, runtimeDir);
	let size = 0;
	try {
		size = statSync(path).size;
	} catch {
		return { records: [], nextOffset: 0, absent: true };
	}
	if (size === 0) return { records: [], nextOffset: 0, absent: false };
	// offset 倒退/越界（文件被轮转）⇒ 当首屏处理
	const from = after !== undefined && after > 0 && after <= size ? after : 0;
	const start = Math.max(0, from);
	// 尾部裁剪：首屏且文件很大时，只读最后 1MB（保证拿到最近的）
	const readStart = start === 0 && size > TAIL_CAP_BYTES ? size - TAIL_CAP_BYTES : start;
	let buf: Buffer;
	try {
		const fd = readFileSync(path);
		buf = fd.subarray(readStart);
	} catch {
		return { records: [], nextOffset: from, absent: false };
	}
	const records: NotifyRecord[] = [];
	for (const line of buf.toString("utf8").split("\n")) {
		const t = line.trim();
		if (t.length === 0) continue;
		try {
			const o = JSON.parse(t) as NotifyRecord;
			// 形状校验：坏行跳过（与 transcript 同口径），不让一条坏行炸整个响应
			if (typeof o?.id === "string" && typeof o?.text === "string" && typeof o?.at === "string") {
				if (o.sessionId === sessionId) records.push(o);
			}
		} catch {
			/* 坏行跳过 */
		}
	}
	const nextOffset = start === 0 && size > TAIL_CAP_BYTES ? size : readStart + buf.length;
	// 首屏取最后 MAX_RETURN 条；增量全给（但同样封顶防爆）
	const out = records.length > MAX_RETURN ? records.slice(-MAX_RETURN) : records;
	return { records: out, nextOffset, absent: false };
}

// ── 拦截层：影子化 pi.registerCommand ────────────────────────

/** 包装所需的 pi 最小面（结构化，便于测试注入）。 */
export interface NotifyBridgeApi {
	registerCommand: (name: string, options: Record<string, unknown>) => void;
}

type LooseCtx = {
	ui?: { notify?: (msg: string, type?: string) => void };
	sessionManager?: { sessionId?: string };
};

/**
 * 影子化 `pi.registerCommand`：给每个 handler 注入 `ui.notify` 代理。
 *
 * 语义保证（N2）：
 * 1. **原 notify 照常调用**（TUI 行为零变化）
 * 2. 落盘在先、原调用在后；落盘失败也不影响原调用
 * 3. handler 抛错原样向上抛（不吞，pi 的 `_tryExecuteExtensionCommand` 有 catch）
 *
 * 返回 restore 函数（主要给测试用；生产不调）。
 */
export function installNotifyBridge(
	pi: NotifyBridgeApi,
	opts: { runtimeDir?: string; now?: () => Date; enabled?: boolean } = {},
): () => void {
	if (opts.enabled === false) return () => { /* 显式关闭 */ };
	const origRegister = pi.registerCommand;
	if (typeof origRegister !== "function") return () => { /* 不可用 */ };
	const now = opts.now ?? (() => new Date());

	const patched = function (this: unknown, name: string, options: Record<string, unknown>): void {
		const origHandler = options?.handler;
		if (typeof origHandler === "function") {
			const wrapped = async (args: unknown, ctx: LooseCtx): Promise<unknown> => {
				// 构造代理 ctx：只替换 ui.notify，其余（含 reload/compact/setModel 等）原样透传
				const proxy = proxyCtx(ctx, name, now, opts.runtimeDir);
				// 用 call 保持 this 绑定（pi 用 command.handler(args, ctx) 直接调，无 this）
				return (origHandler as (a: unknown, c: unknown) => unknown).call(undefined, args, proxy);
			};
			return origRegister.call(pi, name, { ...options, handler: wrapped });
		}
		return origRegister.call(pi, name, options);
	};

	try {
		pi.registerCommand = patched as NotifyBridgeApi["registerCommand"];
	} catch {
		return () => { /* 不可写 ⇒ 桥不可用，静默降级 */ };
	}
	return () => {
		try {
			pi.registerCommand = origRegister;
		} catch {
			/* ignore */
		}
	};
}

/** 造代理 ctx：只换 ui.notify，其余引用原对象（不 deep clone，避免性能与语义偏差）。 */
function proxyCtx(ctx: LooseCtx, source: string, now: () => Date, runtimeDir: string | undefined): LooseCtx {
	const baseNotify = ctx?.ui?.notify;
	const sid = typeof ctx?.sessionManager?.sessionId === "string" ? ctx.sessionManager.sessionId : "";
	const proxiedNotify = (message: string, type?: string): void => {
		try {
			const level: NotifyLevel = type === "warning" || type === "error" ? type : "info";
			appendNotify(
				makeNotifyRecord({ sessionId: sid, level, text: String(message ?? ""), source: `command:${source}`, now: now() }),
				runtimeDir,
			);
		} catch {
			/* never-throw：落盘失败绝不影响原 notify */
		}
		if (typeof baseNotify === "function") {
			baseNotify.call(ctx.ui, message, type as never);
		}
	};
	// 只替换 ui 的一层（浅拷贝 ui），其余字段（reload/compact/model/modelRuntime…）保持同引用
	return {
		...ctx,
		ui: ctx?.ui !== undefined ? { ...ctx.ui, notify: proxiedNotify } : { notify: proxiedNotify },
	};
}
