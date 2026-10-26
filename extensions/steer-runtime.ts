/**
 * steer-runtime — Master 侧「立即插入消息」工具（tab-steer / steer-status）+ sweep
 *
 * 语义（plans/20261012_immediate_injection_plan.md §3.5/§12）：
 *   - `tab-steer({ tabRunId, message, mode })`：**写前守卫**（拒绝而非写后清理）——
 *     unsafe tabRunId / 未知 tab（无派发账本）/ 已终态 tab / 超长 message / 非法 mode 一律 isError，
 *     不产生任何文件；通过后原子落盘 pending 记录。
 *   - `steer-status({ tabRunId?, id? })`：读回执（含「delivered = 已入 steering 队列，非已生效」的诚实标注），
 *     并顺带做一次惰性 sweep（无 interval 也能收敛）。
 *   - Master-only 60s sweep：pending 超 TTL **且目标不活** → undelivered；终态超 TTL → 删除；空目录删除。
 *
 * scope 语义镜像 timers-runtime::resolveWriteScope：标签页只能给自己写/查，主会话可写/查任意 tab。
 * 两档 mode（M2）：schema 用 Union("steer","abort")，validator 缺省白名单同步放开。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { getTabRunId, isMainSession, isSubagent, setCurrentSessionId } from "./identity.ts";
import { defaultTabRunsDir, isUnconfirmedFallback, readTabDispatch, readTabResultFile, readTabState, resolveTabLedger } from "./tab-runs.ts";
import {
	defaultTimersDir,
	dueAtFromDelay,
	mailboxDirForTab,
	MAX_TIMER_MESSAGE,
	newTimerId,
	validateTimerRecord,
	writeTimerAtomic,
	type TimerRecord,
} from "./timers.ts";
import {
	defaultSteerDir,
	expirePendingSteerRecords,
	isSafeSteerComponent,
	newSteerId,
	readAllSteerRecords,
	readSteerRecord,
	STEER_PENDING_TTL_MS,
	STEER_SWEEP_MS,
	STEER_TARGET_STALE_MS,
	STEER_TERMINAL_TTL_MS,
	steerHasFreshClaim,
	sweepTerminalSteerRecords,
	validateSteerRecord,
	validateSteerRequest,
	writeSteerAtomic,
	type SteerRecord,
} from "./steer.ts";

/** `tab-steer` 等待回执的硬上限（§4.3 参数表）。 */
export const MAX_STEER_WAIT_MS = 30_000;
/** 回执轮询间隔。 */
const WAIT_POLL_MS = 250;

export interface SteerRuntimeOptions {
	/** 账本根目录（缺省 ~/.pi/agent/steer/；测试注入隔离目录）。 */
	steerDir?: string;
	/** tab-runs 账本目录（缺省 PI_TAB_RUNS_DIR → 默认；测试注入隔离目录）。 */
	runsDir?: string;
	/** sweep 间隔（缺省 60s）。 */
	sweepIntervalMs?: number;
	/** timer 邮箱根目录（缺省 defaultTimersDir()；测试注入隔离目录）。 */
	timersDir?: string;
}

// ── 空闲 tab 唤醒兜底（2026-10-26 实测事故）───────────────────────────────
//
// 事故形态：`tab-steer` 只把记录写进 steering 队列，消费发生在**活跃 turn 的 tool 边界**。
// 目标 tab 若处于空闲（`turn=idle`，例如刚用 `pi -r` 重开、或已回完上一轮），则
//   - 没有 turn ⇒ 永远没有 tool 边界 ⇒ 记录**永久 pending**；
//   - 而账本 `lastActivityAt` 仍在心跳刷新 ⇒ `targetTabAlive` 判「活」⇒ sweep 也**不做 undelivered**；
//   - 主会话侧因此得到「已投递」的假象，实际**静默失联**（沉默比报错更危险）。
//
// 兜底：目标 alive 但**当前无活跃 turn** 时，往它的 timer 邮箱丢一条**立即到期**的 nudge。
// timer 由**目标进程自己的 pump**（timers-runtime::pumpDueTimers）取出并 `sendUserMessage`
// ⇒ 起一个新 turn ⇒ 下个 tool 边界消费队列里的 steer。这条通道不依赖派发账本，与
// 「归档但仍活」的代偿路径同构。

/** nudge 消息前缀（幂等判据：同一 tab 已有未消费 nudge 时不重复丢）。 */
export const STEER_IDLE_NUDGE_MARK = "[[steer-idle-nudge]]";

/**
 * 目标是否「活着但没有活跃 turn」（⇒ steer 不会被消费，需要唤醒）。
 * 判据只用 tab-runs 既有字段，零新判态逻辑。
 */
export function tabNeedsIdleWake(
	runsDir: string,
	tabRunId: string,
	opts?: { readState?: typeof readTabState },
): { needsWake: boolean; reason: string; turn?: string } {
	if (!isSafeSteerComponent(tabRunId)) return { needsWake: false, reason: "unsafe-id" };
	try {
		const readState = opts?.readState ?? readTabState;
		const state = readState(runsDir, tabRunId);
		if (!state) return { needsWake: false, reason: "no-ledger" };
		if (state.terminal === true) return { needsWake: false, reason: "terminal" };
		const turn = String(state.turn ?? "unknown");
		// 只有 working 才有「下一个 tool 边界」；idle/unknown/error 都不保证会走到边界。
		if (turn === "working") return { needsWake: false, reason: "turn-working", turn };
		return { needsWake: true, reason: `turn-${turn}`, turn };
	} catch {
		return { needsWake: false, reason: "read-error" };
	}
}

export interface IdleWakeResult {
	dropped: boolean;
	reason: string;
	timerId?: string;
}

/**
 * 往目标 tab 的 timer 邮箱丢一条立即到期的唤醒 nudge。
 *
 * 幂等：邮箱里已存在未消费（status=pending）的 nudge ⇒ 不再重复丢（防 nudge 风暴）。
 * 失败一律 best-effort 返回 `dropped:false`，不阻断 steer 主流程。
 */
export function dropIdleWakeNudge(
	timersDir: string,
	tabRunId: string,
	pendingSteerCount: number,
	opts?: { now?: Date; nudgeDelayMs?: number },
): IdleWakeResult {
	try {
		if (!isSafeSteerComponent(tabRunId)) return { dropped: false, reason: "unsafe-id" };
		const box = mailboxDirForTab(timersDir, tabRunId);
		// 幂等守卫：邮箱里已有未消费的 nudge ⇒ 不再丢（防 nudge 风暴）。
		// 先整体捕获条目再扫：目录不存在/nil 一律视为空（不阻断主流程）。
		let boxEntries: string[] = [];
		try { boxEntries = readdirSync(box); } catch { boxEntries = []; }
		for (const name of boxEntries) {
			if (!name.endsWith(".json")) continue;
			let raw: { message?: unknown; status?: unknown } | null = null;
			try { raw = JSON.parse(readFileSync(join(box, name), "utf8")) as { message?: unknown; status?: unknown }; } catch { raw = null; }
			if (raw === null) continue; // 半截文件：忽略（不当作"已有 nudge"）
			if (raw.status === "pending" && typeof raw.message === "string" && raw.message.includes(STEER_IDLE_NUDGE_MARK)) {
				return { dropped: false, reason: "nudge-already-pending" };
			}
		}

		const now = opts?.now ?? new Date();
		const body = [
			STEER_IDLE_NUDGE_MARK,
			`steer 队列有 ${Math.max(1, pendingSteerCount)} 条待消费消息。`,
			"tab-steer 只在活跃 turn 的 tool 边界消费；你当前无活跃 turn，所以一直没收到。",
			"请调用 steer-status 读取，或继续正常推进工作即可（队列会在首个 tool 边界被消费）。",
		].join(" ");
		const record: TimerRecord = {
			id: newTimerId(now),
			version: 1,
			dueAt: dueAtFromDelay(opts?.nudgeDelayMs ?? 0, now),
			message: body.slice(0, MAX_TIMER_MESSAGE),
			target: { tabRunId },
			source: "tab-steer:idle-wake",
			label: "steer-idle-nudge",
			status: "pending",
			createdAt: now.toISOString(),
		};
		const check = validateTimerRecord(record);
		if (!check.ok || !check.value) return { dropped: false, reason: `nudge-invalid:${check.errors.join(";")}` };
		writeTimerAtomic(timersDir, check.value, { tabRunId });
		return { dropped: true, reason: "nudged", timerId: record.id };
	} catch (e) {
		return { dropped: false, reason: `nudge-failed:${e instanceof Error ? e.message : String(e)}` };
	}
}

// ── 目标活性判据（§3.5：写前守卫与 sweep 共用同一组合）─────────────────

/**
 * 目标 tab 是否有「活着」的证据（**唯一**活性判据，写前守卫与 sweep 共用）。
 *
 * 判据（复用 tab-runs 纯函数，零新判态逻辑）：
 *   - readTabState 缺失        → 不活（无遥测账本）
 *   - terminal === true        → 不活
 *   - lastActivityAt 缺失/超 STEER_TARGET_STALE_MS → 不活（§3.5「无近期 lastActivityAt」）
 *   - 其余                     → 活（宁可留 pending，不误报投递失败）
 */
export function targetTabAlive(
	runsDir: string,
	tabRunId: string,
	now: Date = new Date(),
	opts?: { staleMs?: number; readState?: typeof readTabState },
): boolean {
	if (!isSafeSteerComponent(tabRunId)) return false;
	try {
		const readState = opts?.readState ?? readTabState;
		const state = readState(runsDir, tabRunId);
		if (!state) return false;
		if (state.terminal === true) return false;
		const last = state.lastActivityAt ? Date.parse(state.lastActivityAt) : NaN;
		if (!Number.isFinite(last)) return false;
		return now.getTime() - last <= (opts?.staleMs ?? STEER_TARGET_STALE_MS);
	} catch {
		return false;
	}
}

/** 目标 tab 是否已终态（写前守卫判据；与 timers-runtime::targetRunTerminal 同款组合）。
 *
 * L4 返修（SF-4）：异常 → fail-closed（视为终态，拒写），避免 IO 出错时向已死 tab 写僵尸记录。
 * 注：`readTabResultFile`/`readTabState` 自身已吞异常返回 null，本 catch 为防御性兼底。
 * RF-1（2026-10-18）：**兜底结果（unconfirmed/autoGenerated）不算终态** —— 它恰恰是「tab 没回报、
 * 需要被继续推动/核实」的信号；若在这里拒写 steer，兜底反而把唯一能纠正它的通道关死。
 */
function targetRunTerminal(runsDir: string, tabRunId: string): boolean {
	try {
		if (!isSafeSteerComponent(tabRunId)) return true; // 不安全组件：守卫层拒绝
		const result = readTabResultFile(runsDir, tabRunId);
		if (result && !isUnconfirmedFallback(result)) return true;
		return readTabState(runsDir, tabRunId)?.terminal === true;
	} catch {
		return true;
	}
}

// ── sweep ─────────────────────────────────────────────────────────────

export interface SteerSweepSummary {
	/** 置 undelivered 的 pending 数（TTL + 目标不活）。 */
	expired: number;
	/** 删除的超龄终态记录数。 */
	swept: number;
}

/**
 * 遍历全部 tab 子目录做一次 sweep（Master-only 调用点：60s interval + steer-status 惰性）。
 * 每目录两步：pending 过期（需目标不活证据）→ 终态 TTL 删除（含孤儿 .claimed/空目录）。
 */
export function sweepAllSteerDirs(
	steerDir: string,
	opts?: {
		runsDir?: string;
		now?: Date;
		pendingTtlMs?: number;
		terminalTtlMs?: number;
		/** MF-2：限定只 sweep 这些 tab 子目录（标签页身份用）；缺省遍历全部。 */
		tabRunIds?: readonly string[];
	},
): SteerSweepSummary {
	const now = opts?.now ?? new Date();
	const nowMs = now.getTime();
	const runsDir = opts?.runsDir ?? (process.env.PI_TAB_RUNS_DIR || defaultTabRunsDir());
	const summary: SteerSweepSummary = { expired: 0, swept: 0 };
	let subs: string[] = [];
	if (opts?.tabRunIds) {
		subs = opts.tabRunIds.filter((s) => isSafeSteerComponent(s));
	} else {
		try { subs = readdirSync(steerDir); } catch { return summary; }
	}
	for (const sub of subs) {
		if (!isSafeSteerComponent(sub)) continue;
		try {
			summary.expired += expirePendingSteerRecords(steerDir, sub, {
				now,
				maxAgeMs: opts?.pendingTtlMs ?? STEER_PENDING_TTL_MS,
				// SF-3：活性判据叠加「新鲜 .claimed」= 目标有消费者的证据（长单工具期防误判）
				targetAlive: () => targetTabAlive(runsDir, sub, now) || steerHasFreshClaim(steerDir, sub, { now: nowMs }),
			});
		} catch { /* 单目录失败不影响其余 */ }
		try {
			summary.swept += sweepTerminalSteerRecords(steerDir, sub, {
				now,
				maxAgeMs: opts?.terminalTtlMs ?? STEER_TERMINAL_TTL_MS,
			});
		} catch { /* ignore */ }
	}
	return summary;
}

// ── 工具注册 ──────────────────────────────────────────────────────────

function text(value: string, isError = false): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
	return isError ? { content: [{ type: "text", text: value }], isError: true } : { content: [{ type: "text", text: value }] };
}

/** 回执渲染（含 §8-R5 诚实标注：delivered ≠ 已生效）。 */
function renderRecord(r: SteerRecord): string {
	const bits = [
		`${r.status.padEnd(11)} ${r.id} mode=${r.mode}`,
		`  createdAt=${r.createdAt}`,
		r.deliveredAt ? `  deliveredAt=${r.deliveredAt}` : "",
		r.abortedAt ? `  abortedAt=${r.abortedAt}` : "",
		r.idleAt ? `  idleAt=${r.idleAt}` : "",
		r.claimedAt ? `  claimedAt=${r.claimedAt}${r.claimedBy ? ` by=${r.claimedBy}` : ""}` : "",
		r.failedAt ? `  failedAt=${r.failedAt} error=${r.error ?? ""}` : "",
		r.undeliveredAt ? `  undeliveredAt=${r.undeliveredAt} reason=${r.undeliveredReason ?? ""}` : "",
		`  msg=${r.body.slice(0, 80)}`,
		r.status === "delivered" ? "  note=已入 steering 队列（下一个 tool 边界才生效）" : "",
		r.status === "aborted" ? (r.deliveredAt
			? "  note=已打断当前 run 并起新 turn"
			: "  note=已打断当前 run（纯打断或后续消息未送达）") : "",
	];
	return bits.filter(Boolean).join("\n");
}

/**
 * 注册 Master 侧 steer 工具。返回清理函数（被 index.ts collect() 收集）。
 *
 * 标签页也能调用（只能给自己投递/查自己）；子 agent execute 直接拒绝。
 * sweep interval 推迟到 session_start 启动（pi 官方模式），且仅主会话 tick 生效。
 */
export function registerSteerTools(pi: ExtensionAPI, opts: SteerRuntimeOptions = {}): () => void {
	const steerDir = opts.steerDir ?? defaultSteerDir();
	const runsDir = opts.runsDir ?? (process.env.PI_TAB_RUNS_DIR || defaultTabRunsDir());
	const timersDir = opts.timersDir ?? defaultTimersDir();

	let sessionGen = 0;
	let interval: ReturnType<typeof setInterval> | null = null;

	// ── 工具：tab-steer ──
	pi.registerTool({
		name: "tab-steer",
		label: "Steer Tab",
		description: [
			"向某个正在运行的标签页会话**立即插入**一条消息。",
			"参数：tabRunId（目标标签页，必填）；message（插入正文，≤2048 字符，abort 档可为空串=纯打断）；mode（\"steer\" 缺省 / \"abort\"）；waitMs（>0 时等待回执至终态或超时，上限 30s）。",
			"mode=steer：在当前 assistant turn 的工具全部返回后、下一次模型请求之前送达（不打断在跑工具）；若某个工具永不返回，则该消息也不会生效。",
			"mode=abort：**会打断当前 run（含杀挂死工具进程树）**——先 abort、等目标空闲后再发消息。仅在 steer 无法送达（工具挂死）时使用。",
			"回执：steer-status({ tabRunId }) 查看 status。delivered = 消息**已入 steering 队列**，不等于已生效；aborted = 已打断（abortedAt/idleAt，若随后起新 turn 还带 deliveredAt）；目标已终态/无派发账本时本工具直接报错，不产生僵尸记录。",
			"标签页只能给自己投递；给其他 tab 投递请用主会话。",
		].join(" "),
		parameters: Type.Object({
			tabRunId: Type.String({ description: "目标标签页 runId（tab_xxx）" }),
			message: Type.String({ description: "插入的消息正文，≤2048 字符" }),
			mode: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("abort")], {
				description: "steer（缺省）= 下一个 tool 边界送达，不打断在跑工具；abort = 打断当前 run（含杀挂死工具进程树），等空闲后再发消息，仅在 steer 无法送达时使用",
			})),
			waitMs: Type.Optional(Type.Number({ description: ">0 时轮询回执至终态或超时（上限 30000ms）" })),
		}),
		renderCall(args, theme) {
			const mode = typeof args.mode === "string" ? args.mode : "steer";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("tab-steer"))} ${theme.fg("accent", `→${args.tabRunId}`)} ${theme.fg("dim", `[${mode}]`)} ${theme.fg("dim", String(args.message).slice(0, 40))}`,
				0, 0,
			);
		},
		renderResult(result, _options, theme) {
			const t = result.content[0]?.type === "text" ? result.content[0].text : "";
			return new Text(result.isError ? theme.fg("error", t) : theme.fg("success", t), 0, 0);
		},
		async execute(_toolCallId, rawParams) {
			if (isSubagent()) return text("子 agent 中不可投递 steer", true);
			const check = validateSteerRequest(rawParams, { myRunId: getTabRunId() });
			if (!check.ok || !check.value) return text(`steer 参数非法: ${check.errors.join("; ")}`, true);
			const { tabRunId, mode, body } = check.value;

			// 写前守卫（§3.5）：未知 tab / 已终态 tab 一律拒绝，绝不写僵尸记录。
			//
			// 2026-10-16 修正（实测事故：tab-steer 报 `unknown tab（无派发账本）` 但会话仍活）：
			// `archiveStaleTabRuns` 只挡 working/attached，`waiting`（活着的空闲 tab）会被移入
			// `_archived/` ⇒ 旧实现只查活跃目录就**静默丢消息**。现改用 `resolveTabLedger`：
			// 区分「仅被归档但仍活」与「真已终态」，前者**可投递**（备用通道）+ **可观测**。
			const ledger = resolveTabLedger(runsDir, tabRunId);
			if (!ledger.deliverable) {
				// 明确理由（不得笼统 "unknown tab"）：no-ledger-dead / archived-dead
				return text(`tab 不可投递 [${ledger.resolution}]: ${tabRunId} — ${ledger.reason}`, true);
			}
			// 归档/无账本但仍活：不静默 —— 落一条可观测记录（投递本身走同一 steer 目录，
			// 该目录**不依赖派发账本**，故能送达；这正是本次事故中 timer 通道能代偿的原因同构）。
			if (ledger.resolution === "archived-alive" || ledger.resolution === "no-ledger-alive") {
				try {
					appendFileSync(
						join(runsDir, "ledger-fallback.jsonl"),
						`${JSON.stringify({ at: new Date().toISOString(), tabRunId, resolution: ledger.resolution, reason: ledger.reason, source: "tab-steer" })}\n`,
						"utf8",
					);
				} catch { /* best-effort：可观测失败不阻断投递 */ }
			}
			if (targetRunTerminal(runsDir, tabRunId)) {
				return text(`tab already terminal: ${tabRunId}`, true);
			}

			const record: Record<string, unknown> = {
				id: newSteerId(),
				version: 1,
				tabRunId,
				mode,
				body,
				status: "pending",
				createdAt: new Date().toISOString(),
				source: "tab-steer",
			};
			const valid = validateSteerRecord(record);
			if (!valid.ok || !valid.value) return text(`steer 记录校验失败: ${valid.errors.join("; ")}`, true);
			try {
				writeSteerAtomic(steerDir, valid.value);
			} catch (e) {
				return text(`steer 落盘失败: ${e instanceof Error ? e.message : String(e)}`, true);
			}

			// 空闲唤醒兜底（见 STEER_IDLE_NUDGE_MARK 注释）：目标活着但无活跃 turn ⇒
			// 丢一条立即到期的 nudge，让目标自己的 pump 起 turn，否则记录会永久 pending。
			const wake = tabNeedsIdleWake(runsDir, tabRunId);
			const nudge = wake.needsWake ? dropIdleWakeNudge(timersDir, tabRunId, 1) : { dropped: false, reason: wake.reason };

			const waitMs = typeof rawParams === "object" && rawParams !== null
				? (rawParams as { waitMs?: unknown }).waitMs
				: undefined;
			let final: SteerRecord | null = valid.value;
			if (typeof waitMs === "number" && Number.isFinite(waitMs) && waitMs > 0) {
				final = await waitForTerminal(steerDir, tabRunId, valid.value.id, waitMs);
			}
			const status = final?.status ?? "pending";
			const wakeNote = nudge.dropped
				? `  wake=nudged（目标当前无活跃 turn：[${wake.reason}]；已向它的 timer 邮箱投一条立即到期唤醒，由它自己的 pump 起 turn 后消费队列）`
				: `  wake=none（${wake.needsWake ? nudge.reason : wake.reason}）`;
			return text([
				`🚩 steer ${status}: ${valid.value.id}`,
				`  target=tab:${tabRunId} mode=${mode} waitMs=${typeof waitMs === "number" ? waitMs : 0}`,
				`  message=${body.slice(0, 100)}`,
				wakeNote,
				status === "pending" ? `  note=仍为 pending；目标 turn=${wake.turn ?? "unknown"}（${wake.needsWake ? "无活跃 turn ⇒ 不会有 tool 边界，必须唤醒" : "有活跃 turn ⇒ 应会在下个边界消费"}）；用 steer-status 复查` : "",
				status === "delivered" ? "  note=delivered = 已入 steering 队列，下一个 tool 边界才生效" : "",
			].filter(Boolean).join("\n"));
		},
	});

	// ── 工具：steer-status ──
	pi.registerTool({
		name: "steer-status",
		label: "Steer Status",
		description: [
			"查看立即插入消息（tab-steer）的落盘回执：steer-status({ tabRunId?, id? })。",
			"status 语义：pending=已落盘待消费；delivered=已入 steering 队列（**下一个 tool 边界才生效**，非已生效）；aborted=abort 档已打断当前 run（abortedAt/idleAt，消息送达时另有 deliveredAt）；failed=消费方真实失败（error 字段，如 still-streaming-after-abort / no-ctx / stale-ctx）；undelivered=从未被活 tab 消费（TTL + 目标不活）。",
			"缺省（主会话）列出全部 tab 的回执；标签页只能查自己。顺带做一次惰性 sweep（超龄 pending + 目标不活 → undelivered；超龄终态 → 删除）。",
		].join(" "),
		parameters: Type.Object({
			tabRunId: Type.Optional(Type.String({ description: "目标标签页（标签页身份可省略/必须为自己）" })),
			id: Type.Optional(Type.String({ description: "只看某条 steer id" })),
		}),
		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("steer-status"))}${args.tabRunId ? theme.fg("dim", ` ${args.tabRunId}`) : ""}${args.id ? theme.fg("dim", ` #${args.id}`) : ""}`,
				0, 0,
			);
		},
		renderResult(result, _options, theme) {
			const t = result.content[0]?.type === "text" ? result.content[0].text : "";
			return new Text(result.isError ? theme.fg("error", t) : theme.fg("success", t), 0, 0);
		},
		async execute(_toolCallId, rawParams) {
			if (isSubagent()) return text("子 agent 中不可查看 steer 回执", true);
			const p = (rawParams ?? {}) as { tabRunId?: unknown; id?: unknown };
			const myRunId = getTabRunId();
			let targets: string[];
			if (myRunId) {
				const want = typeof p.tabRunId === "string" && p.tabRunId.trim() ? p.tabRunId.trim() : myRunId;
				if (want !== myRunId) return text("标签页只能查看自己的 steer 回执", true);
				targets = [myRunId];
			} else if (typeof p.tabRunId === "string" && p.tabRunId.trim()) {
				const want = p.tabRunId.trim();
				if (!isSafeSteerComponent(want)) return text(`unsafe tabRunId: ${want}`, true);
				targets = [want];
			} else {
				try {
					targets = readdirSync(steerDir).filter((s) => isSafeSteerComponent(s));
				} catch {
					targets = [];
				}
			}

			// 惰性 sweep（无 interval 也能收敛；A4/A6）。
			// MF-2：全量 sweep 仅主会话（越权写防护）；标签页身份只 sweep 自己的目录。
			const sweep = sweepAllSteerDirs(
				steerDir,
				myRunId ? { runsDir, tabRunIds: [myRunId] } : { runsDir },
			);

			const idFilter = typeof p.id === "string" && p.id.trim() ? p.id.trim() : undefined;
			const lines: string[] = [];
			for (const tabRunId of targets) {
				const records = idFilter
					? [readSteerRecord(steerDir, tabRunId, idFilter)].filter((r): r is SteerRecord => r !== null)
					: readAllSteerRecords(steerDir, tabRunId);
				for (const r of records) lines.push(`[${tabRunId}] ${renderRecord(r)}`);
			}
			const header = `steer-status: ${lines.length} 条（sweep: expired=${sweep.expired} swept=${sweep.swept}）`;
			return text(lines.length === 0 ? `${header}\n(no steer records)` : `${header}\n${lines.join("\n")}`);
		},
	});

	// ── Master-only sweep interval（session_start 启动 + generation 守卫）──
	pi.on("session_start", (_event, ctx) => {
		try {
			setCurrentSessionId(
				(ctx as { sessionManager?: { sessionId?: string } } | undefined)?.sessionManager?.sessionId,
			);
		} catch { /* ctx 不可用则保持 undefined */ }
		if (isSubagent()) return;
		const myGen = ++sessionGen;
		if (interval) clearInterval(interval);
		interval = setInterval(() => {
			if (myGen !== sessionGen) return; // stale no-op
			if (!isMainSession()) return; // Master-only（标签页不做全量 sweep）
			try {
				sweepAllSteerDirs(steerDir, { runsDir });
			} catch { /* tick 失败不影响下轮 */ }
		}, opts.sweepIntervalMs ?? STEER_SWEEP_MS);
		interval.unref?.();
	});

	return () => {
		sessionGen++;
		if (interval) clearInterval(interval);
		interval = null;
	};
}

/** 轮询回执至终态或超时（上限 MAX_STEER_WAIT_MS）；返回最后一次读到的记录。 */
async function waitForTerminal(
	steerDir: string,
	tabRunId: string,
	id: string,
	waitMs: number,
): Promise<SteerRecord | null> {
	const deadline = Date.now() + Math.min(waitMs, MAX_STEER_WAIT_MS);
	for (;;) {
		const r = readSteerRecord(steerDir, tabRunId, id);
		if (!r) return null;
		if (r.status !== "pending") return r;
		if (Date.now() >= deadline) return r;
		await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
	}
}
