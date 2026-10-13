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
import { readdirSync } from "node:fs";
import { Type } from "typebox";
import { getTabRunId, isMainSession, isSubagent, setCurrentSessionId } from "./identity.ts";
import { defaultTabRunsDir, readTabDispatch, readTabResultFile, readTabState } from "./tab-runs.ts";
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
 */
function targetRunTerminal(runsDir: string, tabRunId: string): boolean {
	try {
		if (!isSafeSteerComponent(tabRunId)) return true; // 不安全组件：守卫层拒绝
		if (readTabResultFile(runsDir, tabRunId)) return true;
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

			// 写前守卫（§3.5）：未知 tab / 已终态 tab 一律拒绝，绝不写僵尸记录
			if (!readTabDispatch(runsDir, tabRunId)) {
				return text(`unknown tab（无派发账本）: ${tabRunId}`, true);
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

			const waitMs = typeof rawParams === "object" && rawParams !== null
				? (rawParams as { waitMs?: unknown }).waitMs
				: undefined;
			let final: SteerRecord | null = valid.value;
			if (typeof waitMs === "number" && Number.isFinite(waitMs) && waitMs > 0) {
				final = await waitForTerminal(steerDir, tabRunId, valid.value.id, waitMs);
			}
			const status = final?.status ?? "pending";
			return text([
				`🚩 steer ${status}: ${valid.value.id}`,
				`  target=tab:${tabRunId} mode=${mode} waitMs=${typeof waitMs === "number" ? waitMs : 0}`,
				`  message=${body.slice(0, 100)}`,
				status === "pending" ? "  note=仍为 pending（目标可能正忙/未消费）；用 steer-status 复查" : "",
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
