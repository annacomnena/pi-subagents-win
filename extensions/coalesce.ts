/**
 * coalesce.ts — busy 期投递合批（hold → flush）的**纯函数层**
 *
 * 依据：`plans/20261112_delivery_coalesce_design.md`（主会话 × glm-5.3 合稿）。
 *
 * ## 要解决的问题
 * 目标会话忙碌时，N 条投递各自排一个 `followUp`，agent 空闲后逐条吐出 ⇒ 刷屏 + 逐条
 * 消耗 turn。用户要求：「当 agent busy 的时候，投递消息队列最终合成一条用户消息」。
 *
 * ## 为什么必须先有 S0（已落 `6ab3fc0`）
 * 合批只是在 busy 期**压住不投**，它不改变「投出去之后怎么收尾」。而 ACK 的到达依赖
 * 「消息进入下一次模型请求的 context」，长工具下可迟到 20 分钟。只要 `unconfirmed` 仍然
 * `releaseClaimed` 退 pending，**合批后的合成消息照样会被重投**。⇒ S0 是必要条件。
 *
 * ## 本模块的边界（刻意守卫）
 * **纯函数 + 一处薄 IO**（`readBusyGate` 只读一个 JSON 文件）。不做注入、不写信箱、
 * 不改状态机——那些留在 `mailbox-consumer.ts`（S2/S3）。理由：合批的正确性几乎全部
 * 集中在「分类 / 拼装 / 切批 / 消毒」这四个可以穷举测试的变换上。
 *
 * ## 三条硬约束（写死在实现里，不靠纪律）
 *   1. **标记区永不截断**：`[evt:...]` 是 `consumed` ACK 的唯一证据来源
 *      （`delivery-ack.ts:40-51` + `async-result-watcher.ts` 的 `pi.on("context")` 钩子）。
 *      切批/截断一律先砍正文，标记全部保留。
 *   2. **正文里的 `[evt:` 必须消毒**：`extractEventIds` 是全局正则
 *      `/\[evt:(async:[^\]\s]+)\]/g`。合成把 N 条正文拼进一条消息 ⇒ 任何一条子消息正文若
 *      含别人的 `[evt:async:...]`，就会被一起 ACK 掉（**伪造 consumed 证据 ⇒ 静默吞掉
 *      别人的信**）。合批把这个面从「1 条正文」放大到「N 条正文」，必须消毒。
 *   3. **合批目标是「合到 K 条」而不是「必为 1 条」**：50 条合成 1 条 16KB 巨物对 LLM
 *      处理质量是灾难。切多批、各自带自己的标记区。
 *
 * ## 为什么不做 `held` 状态
 * `DELIVERY_STATUSES`（`protocol.ts:207`）是封闭词表，仓内 `status === "pending"/"claimed"`
 * 的判定有 148 处；且 `scope.ts:310` 的 `listScopeWakeLetters` 只看 `pending`/stale `claimed`，
 * 新增状态会被静默漏掉。⇒ 复用 `claimed` + 可选 `hold` 字段（`Letter.hold`），零状态机改动。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { eventMarker } from "./delivery-ack.ts";
import { defaultRuntimeDir } from "./runtime/journal.ts";
import type { Letter } from "./runtime/protocol.ts";
import { NO_POLL_HINT } from "./no-poll.ts";

// ── 词表与常量 ─────────────────────────────────────────────────────

export const COALESCE_CLASSES = ["urgent", "solo", "mergeable"] as const;
export type CoalesceClass = (typeof COALESCE_CLASSES)[number];

/** `sole` 上限：超过则切多批（12/12/1）。glm 的核心理由：50 条合成 1 条对 LLM 是灾难。 */
export const MAX_BATCH_ITEMS = 12;
/** 单批正文预算（**不含**标记区；标记豁免）。 */
export const MAX_BATCH_BYTES = 16 * 1024;
/** 单封信正文超此值 ⇒ 降级为「摘要 + spill 文件指针」。 */
export const MAX_ITEM_BYTES = 4 * 1024;
/** hold 超龄 ⇒ 强制冲刷（无论 busy），防长任务把信无限期压住。 */
export const HOLD_MAX_AGE_MS = 15 * 60_000;
/** busy 标记陈旧阈值：3 × `BUSY_HEARTBEAT_MS`（15s）。 */
export const BUSY_STALE_MS = 45_000;

/** urgent 白名单（**唯一可调点**：U-4「是否把 ESCALATION 也升为 urgent」改这里即可）。 */
const URGENT_MESSAGE_KINDS = new Set<string>(["CONTROL"]);
/** solo 白名单：不参与合并，但仍受 busy 延迟（flush 时逐条独立注入）。 */
const SOLO_MESSAGE_KINDS = new Set<string>(["DELEGATION"]);
/** 命令帧里属于控制面的类型：穿透 hold（用户在等，且停机指令迟 20 分钟不可接受）。 */
const URGENT_COMMAND_TYPES = new Set<string>(["session.abort", "session.slash"]);

// ── 1. 分类 ────────────────────────────────────────────────────────

export interface CoalesceVerdict {
	cls: CoalesceClass;
	reason: string;
}

/**
 * 判定一封信在 busy 期怎么处理（纯函数）。
 *
 * - `urgent`：**不进 hold**，busy 期照常直接注入（followUp 排队交给 pi）；
 * - `solo`：进 hold，flush 时**逐条独立注入**（排在合成消息之后）；
 * - `mergeable`：进 hold，flush 时**合成**。
 *
 * 注意 `requiresAck` **不**决定分类：合成消息携带 N 个 `[evt:...]` 已被实测证明可逐条
 * ACK（`extractEventIdsFromMessages` 对单条消息内的多标记全部提取，见设计稿 §3.1）。
 */
export function classifyForCoalesce(letter: Letter): CoalesceVerdict {
	const frame = letter.frame;

	if (frame.frame === "command") {
		if (URGENT_COMMAND_TYPES.has(frame.type)) return { cls: "urgent", reason: `command-${frame.type}` };
		// 确定性执行器回执（`buildCommandReceiptBody`）：固定模板 + 受控枚举，必须独立可见，
		// 且已执行完、语义上不需要「凑一起读」。
		return { cls: "solo", reason: "command-receipt" };
	}

	const kind = String(frame.kind);
	const details = frame.body.details as { priority?: unknown } | undefined;
	if (details?.priority === "urgent") return { cls: "urgent", reason: "explicit-priority" };
	if (URGENT_MESSAGE_KINDS.has(kind)) return { cls: "urgent", reason: `kind-${kind}` };
	if (SOLO_MESSAGE_KINDS.has(kind)) return { cls: "solo", reason: `kind-${kind}` };
	return { cls: "mergeable", reason: `kind-${kind}` };
}

// ── 2. 消毒（硬约束 2）────────────────────────────────────────────

/**
 * 把正文里的 `[evt:` 前缀打断，使其不再被 `extractEventIds` 的正则命中。
 *
 * 用全角冒号（U+FF1A）替换半角：人读仍然是「[evt：…]」（一眼看出被改过、不会误以为是真标记），
 * 正则 `/\[evt:(async:...)\]/` 不再匹配 ⇒ 无法伪造别人的 consumed ACK。
 */
export function sanitizeEvtMarkers(text: string): string {
	return text.replace(/\[evt:/g, "[evt\uFF1A");
}

// ── 3. 信件 → 待渲染子项 ───────────────────────────────────────────

export interface CoalesceItem {
	/** 信件 messageId（spool 文件名去 `.json`）。 */
	id: string;
	cls: CoalesceClass;
	/** 显示用 kind（`RESULT` / `REPORT` / `cmd:session.message` …）。 */
	kind: string;
	from: string;
	/** 原信绝对时刻（ISO）。**不转相对时间**：合成与阅读隔了一个 turn，相对时间会骗 LLM。 */
	sentAt: string;
	/** 子项正文（已消毒；调用方负责 spill 降级）。 */
	body: string;
	/** 对应的交付账本 eventId（`async:…`）；有则进末尾标记区。 */
	eventId?: string;
}

/** 字面时间（UTC，秒级）：`2026-11-12T06:13:59Z` —— 无时区歧义、可确定性断言。 */
function stamp(at: string): string {
	const ms = Date.parse(at);
	if (!Number.isFinite(ms)) return at;
	return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** 信件正文（供合批渲染）：`summary` + 可选 `details.text`。 */
function letterText(letter: Letter): string {
	const frame = letter.frame;
	if (frame.frame === "command") return `命令 ${frame.type}（commandKey=${frame.commandKey}）`;
	const details = frame.body.details as { text?: unknown } | undefined;
	const text = typeof details?.text === "string" ? details.text : "";
	const summary = String(frame.body.summary ?? "");
	return text.length > 0 ? `${summary}\n\n${text}` : summary;
}

export interface ToItemOptions {
	/** 交付账本 eventId（调用方从 `ensureEvent` 取；没有则省略）。 */
	eventId?: string;
	/** 单条正文上限（缺省 `MAX_ITEM_BYTES`）。超限的判定由调用方做（见 `oversizeItemIds`）。 */
}

/**
 * 信件稳定标识（= spool 文件名去 `.json`；F7 命名不变量）。
 *
 * command 帧没有 `frame.id`（spool 落盘时才分配 messageId），所以要枚举目录才能拿到；
 * 拿不到时回退到 `commandKey`（���一 commandKey 在一个 spool 里只执行一次，够用）。
 */
export function letterId(letter: Letter, fileId?: string): string {
	if (fileId !== undefined && fileId.length > 0) return fileId;
	const frame = letter.frame;
	return frame.frame === "message" ? String(frame.id) : `cmd-${String(frame.commandKey)}`;
}

/** `Letter` → `CoalesceItem`（纯函数；正文已消毒）。 */
export function letterToItem(letter: Letter, opts: ToItemOptions & { fileId?: string } = {}): CoalesceItem {
	const frame = letter.frame;
	const id = letterId(letter, opts.fileId);
	const kind = frame.frame === "message" ? String(frame.kind) : `cmd:${frame.type}`;
	const from = frame.frame === "message" ? String(frame.from) : String(frame.issuedBy);
	const sentAt = frame.frame === "message" ? String(frame.sentAt) : String(frame.issuedAt);
	const { cls } = classifyForCoalesce(letter);
	return {
		id,
		cls,
		kind,
		from,
		sentAt,
		body: sanitizeEvtMarkers(letterText(letter)),
		...(opts.eventId !== undefined ? { eventId: opts.eventId } : {}),
	};
}

/** 需要 spill 降级的子项 id（正文超 `maxBytes`）。调用方据此把正文换成「摘要 + 路径」。 */
export function oversizeItemIds(items: readonly CoalesceItem[], maxBytes: number = MAX_ITEM_BYTES): string[] {
	return items.filter((it) => byteLength(it.body) > maxBytes).map((it) => it.id);
}

function byteLength(s: string): number {
	return Buffer.byteLength(s, "utf8");
}

// ── 4. 切批 ────────────────────────────────────────────────────────

export interface FlushBatch {
	/** `coalesced` = 合成一条；`single` = 单条独立注入（solo）。 */
	kind: "coalesced" | "single";
	items: CoalesceItem[];
}

export interface PlanOptions {
	maxItems?: number;
	maxBytes?: number;
}

/**
 * 把一批 hold 的信切成待注入的批次（纯函数）。
 *
 * 顺序契约（与设计稿 §1.4/§2.7 一致）：**所有合成批次在前、solo 单条在后**。
 *   ① 输入按 `sentAt` 升序（同刻按 id）→ 原顺序可复现；
 *   ② `mergeable` 按 `maxItems` / `maxBytes` 封口切多批；
 *   ③ `solo` 每条自成一批，排在最后；
 *   ④ `urgent` **不应出现在输入里**（它们在 hold 前就被放走了）；若出现，按 solo 处理
 *      ——「已经压住了就赶紧送」，不静默丢弃。
 */
export function planFlushBatches(items: readonly CoalesceItem[], opts: PlanOptions = {}): FlushBatch[] {
	const maxItems = Math.max(1, opts.maxItems ?? MAX_BATCH_ITEMS);
	const maxBytes = Math.max(1, opts.maxBytes ?? MAX_BATCH_BYTES);

	const sorted = [...items].sort((a, b) => {
		const d = a.sentAt.localeCompare(b.sentAt);
		return d !== 0 ? d : a.id.localeCompare(b.id);
	});

	const batches: FlushBatch[] = [];
	let current: CoalesceItem[] = [];
	let currentBytes = 0;
	const flushCurrent = (): void => {
		if (current.length === 0) return;
		batches.push({ kind: "coalesced", items: current });
		current = [];
		currentBytes = 0;
	};

	for (const it of sorted) {
		if (it.cls !== "mergeable") continue;
		const size = byteLength(renderItemBlock(it, current.length + 1));
		// 超单批预算的单条：独占一批（正文截断留给调用方的 spill 降级；标记永不丢）。
		if (current.length > 0 && (current.length >= maxItems || currentBytes + size > maxBytes)) flushCurrent();
		current.push(it);
		currentBytes += size;
	}
	flushCurrent();

	for (const it of sorted) {
		if (it.cls === "mergeable") continue;
		batches.push({ kind: "single", items: [it] });
	}
	return batches;
}

// ── 5. 合成正文（硬约束 1/3）────────────────────────────────────────

function renderItemBlock(item: CoalesceItem, ordinal: number): string {
	return [
		`## ${ordinal}. [${item.kind}] ${item.from} · ${stamp(item.sentAt)}`,
		item.body,
	].join("\n");
}

export interface ComposeOptions {
	/** 调用方决定的注入理由串（如 `session-busy`），只用于表头可读性。 */
	holdReason?: string;
	/** 覆盖「原顺序」等描述；缺省自动。 */
	title?: string;
}

/**
 * 渲染一个批次的注入正文。**标记区恒定在末尾**，且永不被截断。
 *
 * - `coalesced`（≥1 条）：表头 + 逐条块 + 分隔 + 集中标记区；
 * - `single`：单条独立样式（与 `buildInjectBody` 同风格：标题行 + 摘要 + 禁轮询纪律 + 标记）。
 */
export function composeFlushBody(batch: FlushBatch, opts: ComposeOptions = {}): string {
	const markers = batch.items
		.map((it) => it.eventId)
		.filter((id): id is string => typeof id === "string" && id.length > 0)
		.map((id) => eventMarker(id));

	if (batch.kind === "single") {
		const it = batch.items[0]!;
		const lines = [
			`📬 ${batch.items[0]!.kind} · ${it.from} · ${stamp(it.sentAt)}`,
			`摘要: ${it.body.split("\n")[0]!.slice(0, 500)}`,
			...(it.body.split("\n").length > 1 ? [it.body.split("\n").slice(1).join("\n")] : []),
			NO_POLL_HINT,
		];
		return [...lines, ...markers].join("\n");
	}

	const n = batch.items.length;
	const title = opts.title ?? `📬 批量投递（${n} 条，busy 期间积压，原顺序 · 时间为 UTC）`;
	const blocks = batch.items.map((it, i) => renderItemBlock(it, i + 1));
	const footer = [
		`以上 ${n} 条均为已发生事件，请一并处理；无需逐条确认。`,
		...(opts.holdReason !== undefined ? [`（合并原因：${opts.holdReason}）`] : []),
	];
	return [title, "", blocks.join("\n\n"), "", "---", footer.join("\n"), ...markers].join("\n");
}

// ── 6. 超龄强冲 ────────────────────────────────────────────────────

/** `hold.at` 距今超 `maxAgeMs` ⇒ 强制冲刷（不管 busy）。 */
export function shouldForceFlush(heldAt: string, nowMs: number, maxAgeMs: number = HOLD_MAX_AGE_MS): boolean {
	const at = Date.parse(heldAt);
	if (!Number.isFinite(at)) return false;
	return nowMs - at >= maxAgeMs;
}

// ── 7. busy 门（唯一的薄 IO）────────────────────────────────────────

export interface BusyGate {
	/** 会话确实在跑（文件存在、心跳新鲜、写端 pid 活着）。 */
	busy: boolean;
	/** 文件存在但心跳陈旧或写端已死（crash 残留）。`busy=false` 但它确实是一个「残留标记」。 */
	stale: boolean;
	/** 心跳距今毫秒；文件不存在时 `Infinity`。 */
	ageMs: number;
	pid?: number;
}

export interface ReadBusyGateOptions {
	/** busy 目录（缺省 `<runtime>/state/session-busy`）。 */
	dir?: string;
	staleAfterMs?: number;
	/** pid 探活（测试注入；缺省走 `process.kill(pid, 0)`）。 */
	isPidAlive?: (pid: number) => boolean;
}

function defaultIsPidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		// EPERM = 进程存在但无权限（仍算活着）；ESRCH = 不存在。
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * 读会话 busy 标记（权威信号 = `runtime/session-busy.ts` 的写端）。
 *
 * 陈旧判定两条**并联**（glm 建议采纳）：心跳超 `staleAfterMs`（缺省 45s = 3×15s 心跳）
 * **或** 写端 pid 已死。纯时间阈值在写端 crash 时会多等最多一个阈值；pid 检查更快兜住。
 *
 * never-throw：读失败一律按 `busy=false, stale=false`（fail-open 到「照常注入」），
 * 因为「误判忙碌 ⇒ 压住信」的代价远大于「误判空闲 ⇒ 多投一条」。
 */
export function readBusyGate(sessionId: string, nowMs: number, opts: ReadBusyGateOptions = {}): BusyGate {
	const dir = opts.dir ?? join(defaultRuntimeDir(), "state", "session-busy");
	const staleAfterMs = opts.staleAfterMs ?? BUSY_STALE_MS;
	const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
	const path = join(dir, `${sessionId}.json`);
	if (!existsSync(path)) return { busy: false, stale: false, ageMs: Number.POSITIVE_INFINITY };
	let snap: { at?: unknown; pid?: unknown };
	try {
		snap = JSON.parse(readFileSync(path, "utf8")) as { at?: unknown; pid?: unknown };
	} catch {
		return { busy: false, stale: false, ageMs: Number.POSITIVE_INFINITY };
	}
	const at = typeof snap.at === "string" ? Date.parse(snap.at) : Number.NaN;
	if (!Number.isFinite(at)) return { busy: false, stale: true, ageMs: Number.POSITIVE_INFINITY };
	const ageMs = nowMs - at;
	const pid = typeof snap.pid === "number" ? snap.pid : undefined;
	const pidDead = pid !== undefined && !isPidAlive(pid);
	const stale = ageMs > staleAfterMs || pidDead;
	return { busy: !stale, stale, ageMs, ...(pid !== undefined ? { pid } : {}) };
}
