/**
 * supervision-runtime — 主动推动（P1）主会话工具 `supervise-push`
 *
 * 方案：`plans/20261017_stagnation_supervision_plan.md` §C.1–C.5 + §E-P1；
 * 实现规格：`plans/20261018_P1_supervision_push_spec.md` §1（权威交接件）；
 * 任务书：`plans/20261018_P1_push_task_brief.md`（七条拒绝路径 + 模板逐字 + 四项纪律）。
 *
 * ## 为什么是「机械强制点」而不是靠 LLM 自觉
 * C.3 的原话：不推清单（NOT_MONITORED / PAUSED_USER / BLOCKED_USER / DONE / pid-dead / toolUse）
 * 必须由**代码**挡，而不是写在 prompt 里等人记得。所以本模块的核心是两个纯函数：
 *   - `evaluatePushGuards` —— 七条拒绝路径（先命中先返回，reason 字符串逐字固定）
 *   - `pushTemplate`       —— C.2 模板（逐字，含全角标点）
 * 编排 `supervisePush` 把「读账本 → 组模板 → 写 steer → 记 pushes[] → 审计」串起来。
 *
 * ## 复用而非重写（任务书硬要求）
 * - 写 steer 记录：`steer.ts::writeSteerAtomic`（原子 tmp+rename）+ `newSteerId()`（不自己造 id）
 * - 写监管账本：`runtime/supervision.ts::writeSupervisionEntry`（不自写文件）
 * - 判态：`tab-runs.ts::composeTabStatus` + `tab-runs-runtime.ts::classifyForReclaim`（与 frontier 同口径）
 *
 * ## 档位（C.1 / C.3 末句）——2026-10-18 修正为「按相位自动选档」
 * `mode` 的取值顺序：**显式传入永远优先**；否则按派生相位自动选——`phase === "working"` ⇒ `"steer"`
 * （不打断在跑的工具），其余（waiting / 其它空闲相位）⇒ `"abort"`。
 * 本工具只写记录，真实执行（abort → 等 idle → 发消息）仍在 `steer-consumer.ts::runAbortTier`。
 *
 * ### C.3「绝不自动升级」的解读边界（**这一段是修正，P1 原注释是误读**）
 * C.3 原文「绝不用 abort 档自动杀工具」约束的是**不打断正在运行的工具**。这条已由 `tool-use` 门
 * 机械保证（`phase=working ∧ stop=toolUse` ⇒ 拒绝，根本不会推），**与档位选择无关**。
 * 它**不**约束「idle tab 也不许用 abort」：idle tab 没有 run 可打断，abort 只是无害前置
 * （`steer-consumer.ts`：abort → 等 idle ≤30s → 发消息起新 turn），而且**是 idle tab 唯一能起新 turn 的档**
 * （`steer` 档带 `deliverAs:"steer"`，要等下一个 tool 边界；已 settled 的 tab 没有 tool 边界 ⇒ 永不起 turn）。
 * P1 交付时把「缺省 steer、abort 必须显式传入」当成 C.3 的要求是**误读**：STALLED 的定义（idle 超阈值）
 * 与缺省档位互相抵消 ⇒ 本工具对它唯一的目标场景完全无效（P1-1 报告已如实登记该症状）。
 * 边界：`working ∧ stop≠toolUse` 自动选 steer ⇒ 不打断；`working` 且确实在跑工具 ⇒ 被 tool-use 门挡掉。
 *
 * ## 失败语义（spec §1.4 裁定）
 * 七条策略门各自独立 reason；**基础设施失败不是策略门**，单独 `reason:"io-error"`（不计入七条），
 * 保证「七条断言」互斥干净、拒绝语义不被借用。全函数 never-throw。
 *
 * ## 已知边界（登记而非当成不存在）
 * 1. `writeSteerAtomic` 成功但 `writeSupervisionEntry` 失败 ⇒ 返回 `io-error` 但 **steer 已落盘**
 *    （detail 里带 steerId）。取舍同 AGENTS R-5：宁可重发（多条推动消息，tab 能忽略），不可漏发；
 *    单小时 4 次的上限仍会兜住这种情况下的重复推。
 * 2. 并行工具（同时两个 `tool_execution_start`）时 `tab-runs-runtime` 的 `currentToolStartedAt`
 *    只会记最后一个、并在任一工具结束时清除（spec §3 的字面实现，未做嵌套计数）。
 * 3. epoch 计数用 `max(epoch.startedAt, state.lastActivityAt)` 做**读侧**重置——不写盘重置，
 *    避免推动这条路径额外写监管账本（见 spec §1.2）。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { basename } from "node:path";
import { Type } from "typebox";
import { getTabRunId, isSubagent } from "./identity.ts";
import { isProcessAlive } from "./runtime/liveness.ts";
import {
	readSupervisionLedger,
	writeSupervisionEntry,
	type SupervisionEntry,
	type SupervisionPushRecord,
} from "./runtime/supervision.ts";
import {
	defaultSteerDir,
	readSteerRecord,
	validateSteerRecord,
	newSteerId,
	writeSteerAtomic,
	type SteerMode,
} from "./steer.ts";
import {
	composeTabStatus,
	defaultTabRunsDir,
	readTabDispatch,
	readTabResultFile,
	readTabState,
} from "./tab-runs.ts";
import { classifyForReclaim } from "./tab-runs-runtime.ts";

// ── 常量 ───────────────────────────────────────────────────────────

/** 每停滞 epoch 的推动上限（方案 §C.3；运行时 clamp 到 [1,3]）。 */
export const SUPERVISION_MAX_PUSHES = 2;
/** 单 runId 近 1 小时的滚动节流线（方案 §C.3「防抖振荡」）。 */
export const SUPERVISION_PUSH_HOURLY_CAP = 4;
/** 模板摘要截断长度（方案 §C.2「summary 截断120字」）。 */
export const SUPERVISION_SUMMARY_MAX = 120;
/** 账本里推动记录的 `reason`（唯一来源：STALLED 停滞；needs-human 等已被策略门拒）。 */
export const SUPERVISION_PUSH_REASON = "stalled";

// ── 纯函数：七条拒绝路径 ───────────────────────────────────────────

/** 七条策略门（`reason` 字符串逐字固定，测试逐条断言）。 */
export type PushRejectReason =
	| "no-mandate"
	| "paused"
	| "terminal"
	| "needs-human"
	| "budget-exhausted"
	| "pid-dead"
	| "tool-use";

export interface PushGuardInput {
	/** 监管账本条目；null = 未登记（或已关账）。 */
	ledger: SupervisionEntry | null;
	/** `composeTabStatus` 派生的 phase。 */
	phase: string;
	/** `state.lastStopReason ?? "unknown"`。 */
	stopReason: string;
	/** result.json 存在 ∨ state.terminal。 */
	terminal: boolean;
	/**
	 * 「真的在等人」（只告不推）：`gate==="awaiting"` ∨ `attention>0`。
	 * **`stop="error"` 不属于此项**（2026-10-18 修正：那是「出错了要重试」，由 4b 单独判定）。
	 */
	needsHuman: boolean;
	attention: number;
	gate: string;
	/** `state.pid` 探活；无 pid → null（不拒）。 */
	pidAlive: boolean | null;
	pushesThisEpoch: number;
	pushesLastHour: number;
	/** clamp [1,3]。 */
	maxPushes: number;
}

export type PushGuardResult =
	| { ok: true }
	| { ok: false; reason: PushRejectReason; detail: string };

/** maxPushes 钳制：非法/缺失 → 常量缺省；超界 → [1,3]。 */
export function clampMaxPushes(v: unknown): number {
	const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : SUPERVISION_MAX_PUSHES;
	return Math.min(3, Math.max(1, n));
}

/**
 * 七条拒绝路径判定（**纯**；判定顺序严格按 spec §1.1 表格，先命中先返回）。
 *
 * 顺序的设计理由（不是随意的）：
 *   1. `no-mandate`  —— 连监管意图都没有，后面所有判据都无载体（也含 `optOut === true`，
 *                       与 `deriveTabSupervisionState` 的 NOT_MONITORED 同口径）
 *   2. `paused`      —— 用户显式停：最优先的**意图**否决
 *   3. `terminal`    —— 已终态：该回收而不是推
 *   4. `needs-human` —— 在等人（C.4「BLOCKED_USER 只告不推」）；含 4b「stop=error 且已推过」
 *   5. `budget-exhausted` —— 策略预算（含 1h 节流）
 *
 * 4b 的设计（2026-10-18 修正）：`stop=error` **不是**「在等人」，是「出错了，需要重试」，因此
 * 第一次（本 epoch 未推过）**放行**去试复活；推过一次仍 error ⇒ 才升级给人（`needs-human`）。
 * 放行路径不受任何豁免：预算门（2 次/epoch、4 次/1h）、pid-dead、tool-use 照旧约束。
 *   6. `pid-dead`    —— 推是写空气
 *   7. `tool-use`    —— 在跑工具（最弱的软门：只挡 idle 假象）
 */
export function evaluatePushGuards(input: PushGuardInput): PushGuardResult {
	// 1) 无监管授权（含显式静默）
	if (!input.ledger) {
		return { ok: false, reason: "no-mandate", detail: "无监管账本条目（该 runId 未被登记监管）" };
	}
	if (input.ledger.optOut === true) {
		return { ok: false, reason: "no-mandate", detail: "账本 optOut=true（用户显式静默＝等同未登记）" };
	}
	// 2) 用户显式暂停
	if (input.ledger.status === "paused") {
		return { ok: false, reason: "paused", detail: "账本 status=paused（用户显式暂停：不报不推）" };
	}
	// 3) 已终态
	if (input.terminal === true) {
		return { ok: false, reason: "terminal", detail: "tab 已终态（result.json 存在或 state.terminal）→ 该回收而非推动" };
	}
	// 4) 在等人（BLOCKED_USER 只告不推）。这里也复核 gate/attention（不只信调用方的聚合值），
	//    保证「有人在等」这条**永不被** stop=error 的放行路径稀释（任务书硬约束）。
	const hardBlocked = input.needsHuman === true || input.gate === "awaiting" || input.attention > 0;
	if (hardBlocked) {
		return {
			ok: false,
			reason: "needs-human",
			detail: `需人介入（attention=${input.attention} gate=${input.gate} stop=${input.stopReason}）→ 只告不推`,
		};
	}
	// 4b) 瞬时错误：stop=error 是「出错了，要重试」而非「在等人」。
	//     - 本 epoch 未推过 ⇒ 放行去试复活（继续走 budget/pid-dead/tool-use 门，预算照旧兜住）
	//     - 已推过 ≥1 次仍 error ⇒ 错误不是瞬时的，升级给人（needs-human，不新增 reason）
	const errored = input.stopReason === "error";
	if (errored && input.pushesThisEpoch >= 1) {
		return {
			ok: false,
			reason: "needs-human",
			detail: `stop=error 且本 epoch 已推 ${input.pushesThisEpoch} 次仍出错（非瞬时错误→升级给人）`,
		};
	}
	// 5) 预算（本 epoch 满 或 1h 超节流）
	const maxPushes = clampMaxPushes(input.maxPushes);
	if (input.pushesThisEpoch >= maxPushes) {
		return {
			ok: false,
			reason: "budget-exhausted",
			detail: `本 epoch 已推 ${input.pushesThisEpoch}/${maxPushes}（预算耗尽→升级用户）`,
		};
	}
	if (input.pushesLastHour >= SUPERVISION_PUSH_HOURLY_CAP) {
		return {
			ok: false,
			reason: "budget-exhausted",
			detail: `近 1 小时已推 ${input.pushesLastHour}/${SUPERVISION_PUSH_HOURLY_CAP}（节流）`,
		};
	}
	// 6) 进程已死（推是写空气）
	if (input.pidAlive === false) {
		return { ok: false, reason: "pid-dead", detail: "state.pid 探活失败（进程已死：推是写空气→转重派决策）" };
	}
	// 7) 在跑工具
	if (input.phase === "working" && input.stopReason === "toolUse") {
		return { ok: false, reason: "tool-use", detail: "phase=working ∧ stop=toolUse（在跑工具，推了会打断/排队）" };
	}
	return { ok: true };
}

// ── 纯函数：模板（C.2 逐字）────────────────────────────────────────

export interface PushTemplateParams {
	/** `pushesThisEpoch + 1`。 */
	pushIndex: number;
	maxPushes: number;
	taskId: string;
	/** 缺省/空 → "unknown"。 */
	repoPath: string | null;
	idleMs: number;
	stopReason: string;
	summary: string;
}

/**
 * C.2 模板（**逐字**；标点/全角字符一律不得美化改写）。
 *
 * 第 2 条是关键设计：把「未知原因的停」转化成显式 BLOCKED 信号——今天 48min 等解封的事故里，
 * 这条推动会在 15min 时就把「我在等 master 解封」顶到台面，而不是 48min 后猜。
 */
export function pushTemplate(p: PushTemplateParams): string {
	const repo = p.repoPath && p.repoPath.length > 0 ? basename(p.repoPath) : "unknown";
	const idleMin = Math.max(0, Math.round((Number.isFinite(p.idleMs) ? p.idleMs : 0) / 60_000));
	const summary = p.summary.length > SUPERVISION_SUMMARY_MAX ? p.summary.slice(0, SUPERVISION_SUMMARY_MAX) : p.summary;
	const stop = p.stopReason && p.stopReason.length > 0 ? p.stopReason : "unknown";
	return [
		`【监管推动 #${p.pushIndex}/预算${p.maxPushes}】任务 ${p.taskId}（${repo}）已停 ${idleMin}min。`,
		`最后状态：stop=${stop}，摘要：${summary}。`,
		"1) 若仍可推进：继续当前任务，不要重做已完成部分（先读你自己的交接/计划文件再续）。",
		"2) 若在等外部条件（解封/窗口/他人）：回报【等什么|谁解锁|预计何时】，我转告用户。",
		"3) 若已完成：立即调用 tab-finish 回报（不调 = 未完成）。",
	].join("\n");
}

// ── 编排 ───────────────────────────────────────────────────────────

export interface SupervisionRuntimeOptions {
	/** 缺省 `defaultSteerDir()`（~/.pi/agent/steer）。 */
	steerDir?: string;
	/** 缺省 `PI_TAB_RUNS_DIR || defaultTabRunsDir()`。 */
	runsDir?: string;
	/** 缺省 undefined（= `<defaultRuntimeDir()>/state`）。 */
	stateDir?: string;
	/** fake clock（测试注入）。 */
	now?: () => Date;
	/** 审计行接收器；缺省 no-op（生产 `index.ts` 注入 `appendAuditLine`）。 */
	audit?: (line: string) => void;
	/** 仓 attention 载体（可选；缺省 `() => 0` = 不猜）。 */
	attentionFor?: (repoPath: string) => number;
	/** 仓 gate 载体（可选；缺省 `() => "unknown"` = 不猜）。 */
	gateFor?: (repoPath: string) => string;
	/** 单 epoch 推动上限覆盖（**仅测试用**；生产恒缺省 → `SUPERVISION_MAX_PUSHES`）。 */
	maxPushes?: number;
}

export interface SupervisePushInput {
	runId: string;
	/**
	 * 显式档位（**永远优先**）。缺省 ⇒ 按派生相位自动选：`working` ⇒ `steer`，其余 ⇒ `abort`。
	 * 见文件头「C.3 解读边界」：自动选 abort 只对**没有 run 可打断**的场合（idle/waiting）发生，
	 * 而真正在跑工具（`working ∧ stop=toolUse`）已被 tool-use 门挡掉，不会被 abort 打断。
	 */
	mode?: "steer" | "abort";
}

export type SupervisePushResult =
	| { ok: true; steerId: string; pushIndex: number; remainingBudget: number; mode: "steer" | "abort" }
	| { ok: false; reason: PushRejectReason | "io-error"; detail: string };

/** 推动记录（v1 账本可选字段；`SupervisionPushRecord` 的运行时超集，读侧宽容）。 */
interface PushRecordExt extends SupervisionPushRecord {
	mode?: SteerMode;
	reason?: string;
}

function pushRecordsOf(entry: SupervisionEntry | null): PushRecordExt[] {
	const raw = entry?.epoch?.pushes;
	return Array.isArray(raw) ? (raw as PushRecordExt[]) : [];
}

/**
 * 本 epoch / 近 1 小时的推动计数（spec §1.2）。
 *
 * epoch 重置**只在读侧**发生：`effectiveEpochStart = max(epoch.startedAt, state.lastActivityAt)`
 * ⇒ tab 在上次推动之后有过活动，那些 push 就不再计入本 epoch。不写盘重置的理由：
 * `supervise-push` 是「只写 steer + 记 pushes」的窄路径，多一次账本写就多一个竞态窗口
 * （frontier 侧多写者共写已被 AGENTS R-3 登记），读侧算最便宜。
 */
export function countPushes(
	pushes: readonly PushRecordExt[],
	opts: { nowMs: number; epochStartMs: number },
): { thisEpoch: number; lastHour: number } {
	let thisEpoch = 0;
	let lastHour = 0;
	for (const p of pushes) {
		const t = Date.parse(String(p?.at ?? ""));
		if (!Number.isFinite(t)) continue;
		if (t > opts.epochStartMs) thisEpoch++;
		if (opts.nowMs - t <= 3_600_000) lastHour++;
	}
	return { thisEpoch, lastHour };
}

function epochStartMsOf(entry: SupervisionEntry | null, stateLastActivityAt: string | undefined): number {
	const started = Date.parse(String(entry?.epoch?.startedAt ?? ""));
	const activity = Date.parse(String(stateLastActivityAt ?? ""));
	const startMs = Number.isFinite(started) ? started : 0;
	const actMs = Number.isFinite(activity) ? activity : 0;
	return Math.max(startMs, actMs);
}

function idleMsOf(stateLastActivityAt: string | undefined, nowMs: number): number {
	const actMs = Date.parse(String(stateLastActivityAt ?? ""));
	return Number.isFinite(actMs) ? Math.max(0, nowMs - actMs) : 0;
}

/**
 * 推一次（spec §1.4 七步）。**never-throw**：所有 IO 异常收敛为 `{ok:false, reason:"io-error"}`。
 */
export function supervisePush(
	input: SupervisePushInput,
	deps: SupervisionRuntimeOptions = {},
): SupervisePushResult {
	const audit = (line: string): void => {
		try {
			deps.audit?.(line);
		} catch {
			/* 审计失败不得影响推动（同 autoRegisterDispatchedTabs 纪律） */
		}
	};
	const runId = typeof input?.runId === "string" ? input.runId.trim() : "";
	const requestedMode = input?.mode;
	/** 显式传入优先；null ⇒ 等 view 派生后再按相位自动选（见下方 2.5）。 */
	const explicitMode: SteerMode | null =
		requestedMode === "abort" || requestedMode === "steer" ? requestedMode : null;
	const nowDate = (() => {
		try {
			return deps.now ? deps.now() : new Date();
		} catch {
			return new Date();
		}
	})();
	const nowMs = nowDate.getTime();
	const nowIso = nowDate.toISOString();
	const runsDir = deps.runsDir ?? (process.env.PI_TAB_RUNS_DIR || defaultTabRunsDir());
	const steerDir = deps.steerDir ?? defaultSteerDir();

	if (!runId) {
		const detail = "invalid-input: runId required（空 runId 非策略门，按基础设施失败收敛）";
		audit(`supervision-push io-error runId=(empty) detail=${detail}`);
		return { ok: false, reason: "io-error", detail };
	}

	try {
		// 1) 账本 + 派发 + 遥测 + 结果
		const ledger = readSupervisionLedger(runId, { stateDir: deps.stateDir });
		const dispatch = readTabDispatch(runsDir, runId);
		const state = readTabState(runsDir, runId);
		const result = readTabResultFile(runsDir, runId);

		// 2) 组合判态（与 frontier 同口径；probe=null 不猜 JSONL）
		const view = composeTabStatus({
			runId,
			dispatch,
			state,
			result,
			probe: null,
			dispatchedAt: dispatch?.dispatchedAt,
			now: nowMs,
		});

		// 2.5) 档位：显式传入优先；否则按相位自动选（2026-10-18 修正）。
		//   working ⇒ steer（不打断工具；真在跑工具时 stop=toolUse 会被 tool-use 门挡掉，见 evaluatePushGuards 7）
		//   其余   ⇒ abort（idle/waiting 无 run 可打断，且是唯一能给已 settled 的 tab 起新 turn 的档）
		const mode: SteerMode = explicitMode ?? (view.phase === "working" ? "steer" : "abort");

		// 3) needsHuman 聚合 = **只含「真的在等人」**（gate=awaiting / attention>0）。
		// 刻意不把 reclaim=awaitingInput 纳入：tab-runs 将 settled 的 phase=waiting 映射为 awaitingInput
		//（「等人给下一句」），但这正是 C.4 要机械推动的 STALLED 形状。
		// 2026-10-18 修正：`stop=error` 也已移出本聚合——它是「出错了要重试」，由 evaluatePushGuards 的
		// 4b 门单独判定（首次放行、推过仍错才升级给人）。原先把 error 算进 needsHuman ⇒ error tab 永不推，
		// 而 error 恰恰是最该推的一类（今天 SBS / P1-1 / RF-1 都是被瞬时 Connection error 卡住的）。
		// 与 frontier-carriers 的展示口径不同：frontier 的 BLOCKED_USER 沿用既有广义 reclaim 判据（P0 已定稿），
		// 本工具按 C.3 只告不推的实质阻塞载体聚合，不改变 P0 状态机。
		classifyForReclaim(view); // 保留真实分类链调用，便于与 P0 判态保持同一视图；不作为 needsHuman 判据。
		const repoPath = dispatch?.cwd ?? ledger?.repoPath ?? "";
		const gate = safeGate(deps.gateFor, repoPath);
		const attention = safeAttention(deps.attentionFor, repoPath);
		const stopReason = state?.lastStopReason ?? "unknown";
		const needsHuman = gate === "awaiting" || attention > 0;
		/** stop=error 的放行标记：**只进 audit 行**（不新增账本字段，不动 validateEntry 校验）。 */
		const erroredRetry = stopReason === "error";
		const terminal = view.terminal === true || result !== null;
		const pidAlive = typeof state?.pid === "number" && Number.isFinite(state.pid)
			? safePidAlive(state.pid)
			: null;

		const pushes = pushRecordsOf(ledger);
		const epochStartMs = epochStartMsOf(ledger, state?.lastActivityAt);
		const { thisEpoch, lastHour } = countPushes(pushes, { nowMs, epochStartMs });
		const maxPushes = clampMaxPushes(deps.maxPushes ?? SUPERVISION_MAX_PUSHES);

		// 4) 七条策略门（先命中先返回）
		const guard = evaluatePushGuards({
			ledger,
			phase: view.phase,
			stopReason,
			terminal,
			needsHuman,
			attention,
			gate,
			pidAlive,
			pushesThisEpoch: thisEpoch,
			pushesLastHour: lastHour,
			maxPushes,
		});
		if (!guard.ok) {
			audit(`supervision-push reject runId=${runId} reason=${guard.reason} detail=${guard.detail}`);
			return { ok: false, reason: guard.reason, detail: guard.detail };
		}

		// 5) 组模板 → 写 steer（复用 writeSteerAtomic + newSteerId，不自己造 id/文件）
		const pushIndex = thisEpoch + 1;
		const body = pushTemplate({
			pushIndex,
			maxPushes,
			taskId: (dispatch?.taskId ?? ledger?.taskId ?? "unknown") || "unknown",
			repoPath: repoPath || null,
			idleMs: idleMsOf(state?.lastActivityAt, nowMs),
			stopReason,
			summary: state?.lastAssistantText ?? result?.finalText ?? result?.summary ?? "",
		});
		const steerId = newSteerId(nowDate);
		const candidate: Record<string, unknown> = {
			id: steerId,
			version: 1,
			tabRunId: runId,
			mode,
			body,
			status: "pending",
			createdAt: nowIso,
			source: "supervise-push",
		};
		const valid = validateSteerRecord(candidate);
		if (!valid.ok || !valid.value) {
			const detail = `steer 记录校验失败: ${valid.errors.join("; ")}`;
			audit(`supervision-push io-error runId=${runId} detail=${detail}`);
			return { ok: false, reason: "io-error", detail };
		}
		try {
			writeSteerAtomic(steerDir, valid.value);
		} catch (e) {
			const detail = `writeSteerAtomic 失败: ${msgOf(e)}`;
			audit(`supervision-push io-error runId=${runId} detail=${detail}`);
			return { ok: false, reason: "io-error", detail };
		}

		// 6) 记 pushes[] → 回写账本（复用 writeSupervisionEntry，不自写文件）
		const push: PushRecordExt = {
			at: nowIso,
			mode,
			steerId,
			reason: SUPERVISION_PUSH_REASON,
			outcome: "pending",
		};
		const nextEntry: SupervisionEntry = {
			...ledger!,
			epoch: { ...ledger!.epoch, pushes: [...pushes, push] as SupervisionPushRecord[] },
		};
		const written = writeSupervisionEntry(nextEntry, { stateDir: deps.stateDir });
		if (!written.ok) {
			// steer 已落盘（真实推动已发生）——按 R-5「宁可重发」登记，detail 带 steerId 便于追责
			const detail = `writeSupervisionEntry 失败（${written.reason ?? "error"}）；steer 已落盘 steerId=${steerId}`;
			audit(`supervision-push io-error runId=${runId} detail=${detail}`);
			return { ok: false, reason: "io-error", detail };
		}

		// 7) 审计一行（事后可追责：方案 §D.3 第 ⑤ 层防线）
		const remainingBudget = maxPushes - pushIndex;
		audit(
			`supervision-push ok runId=${runId} steerId=${steerId} push=${pushIndex}/${maxPushes} remaining=${remainingBudget} mode=${mode} task=${nextEntry.taskId} idle=${Math.round(idleMsOf(state?.lastActivityAt, nowMs) / 60_000)}min${erroredRetry ? " erroredRetry=1" : ""}`,
		);
		return { ok: true, steerId, pushIndex, remainingBudget, mode };
	} catch (e) {
		const detail = `unexpected: ${msgOf(e)}`;
		audit(`supervision-push io-error runId=${runId} detail=${detail}`);
		return { ok: false, reason: "io-error", detail };
	}
}

function msgOf(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

function safeGate(fn: ((repoPath: string) => string) | undefined, repoPath: string): string {
	try {
		const v = fn?.(repoPath);
		return typeof v === "string" && v.length > 0 ? v : "unknown";
	} catch {
		return "unknown";
	}
}

function safeAttention(fn: ((repoPath: string) => number) | undefined, repoPath: string): number {
	try {
		const v = fn?.(repoPath);
		return typeof v === "number" && Number.isFinite(v) ? v : 0;
	} catch {
		return 0;
	}
}

function safePidAlive(pid: number): boolean | null {
	try {
		return isProcessAlive(pid);
	} catch {
		return null; // 判不出 → null（不拒，不猜）
	}
}

// ── 工具注册 ───────────────────────────────────────────────────────

function text(value: string, isError = false): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
	return isError ? { content: [{ type: "text", text: value }], isError: true } : { content: [{ type: "text", text: value }] };
}

/** 拒绝原因的中文一句话（给人读；reason 字符串本身给机器读）。 */
const REJECT_HINT: Record<PushRejectReason | "io-error", string> = {
	"no-mandate": "该 tab 未被登记监管（或已 optout）⇒ 不推（先 /supervise on <runId>）",
	paused: "用户显式暂停了该 tab 的监管 ⇒ 不推",
	terminal: "该 tab 已终态 ⇒ 不推，该回收（reclaim-tabs）",
	"needs-human": "该 tab 在等人（gate=awaiting / attention>0），或 stop=error 且已推过一次 ⇒ 只告不推",
	"budget-exhausted": "推动预算已尽 ⇒ 停止推，升级用户并附时间线",
	"pid-dead": "该 tab 进程已死 ⇒ 推是写空气，转用户/master 决策重派",
	"tool-use": "该 tab 正在跑工具 ⇒ 不推（避免打断/无效排队）",
	"io-error": "基础设施失败（读账本/写 steer/写账本）⇒ 不是策略拒绝，可重试",
};

/**
 * 注册主会话工具 `supervise-push`。返回 cleanup（被 `index.ts` collect() 收集）。
 *
 * 身份门（C.5：推理由被唤醒的 master 执行）：
 *   - 子 agent 进程 → 拒绝（同 `/supervise` 手动运维命令口径）
 *   - 标签页会话（`getTabRunId()` 存在）→ 拒绝（tab 不得推动其他 tab，也不得自我推动）
 */
export function registerSupervisionTools(pi: ExtensionAPI, opts: SupervisionRuntimeOptions = {}): () => void {
	pi.registerTool({
		name: "supervise-push",
		label: "Supervise Push",
		description: [
			"对**停滞（STALLED）**的标签页推一次有界提醒（C.2 模板），并把它记进监管账本的 pushes[]。",
			"参数：runId（目标标签页，必填）；mode（可选 \"steer\"/\"abort\"；**不传时按相位自动选**：phase=working ⇒ steer（不打断工具），其余 ⇒ abort（idle tab 唯一能起新 turn 的档）。显式传入永远优先）。",
			"七条拒绝路径（各自独立 reason，先命中先返回）：no-mandate（无账本/optout）、paused（用户暂停）、terminal（已终态）、needs-human（真的在等人：attention/gate awaiting；**或** stop=error 且本 epoch 已推过 1 次）、budget-exhausted（本 epoch 满 maxPushes=2 或近 1h≥4 次）、pid-dead（进程死）、tool-use（phase=working∧stop=toolUse）。",
			"stop=error 且本 epoch 未推过 ⇒ **放行**推一次试复活（推过的记录只标记 audit 行 erroredRetry=1，不新增账本字段）；预算门照旧兜住。",
			"基础设施失败（读/写文件异常）单独用 reason=io-error，不计入七条策略门。",
			"预算是机械强制的：推满 maxPushes 后一律 budget-exhausted —— 此时应升级用户（附账本 pushes[] 时间线），不要换 runId 绕过。",
			"仅主会话可用（子 agent / 标签页身份调用一律拒绝）。",
		].join(" "),
		parameters: Type.Object({
			runId: Type.String({ description: "目标标签页 runId（tab_xxx）" }),
			mode: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("abort")], {
				description: "不传 = 按相位自动选（working ⇒ steer；其余 ⇒ abort）；steer = 下一个 tool 边界送达；abort = 打断当前 run 等空闲后再发。显式传入永远优先",
			})),
		}),
		renderCall(args, theme) {
			const mode = typeof args.mode === "string" ? args.mode : "auto";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("supervise-push"))} ${theme.fg("accent", `→${String(args.runId ?? "")}`)} ${theme.fg("dim", `[${mode}]`)}`,
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const t = result.content[0]?.type === "text" ? result.content[0].text : "";
			return new Text(result.isError ? theme.fg("error", t) : theme.fg("success", t), 0, 0);
		},
		async execute(_toolCallId, rawParams) {
			if (isSubagent()) return text("子 agent 中不可推动（supervise-push 仅主会话可用）", true);
			if (getTabRunId()) return text("监管推动仅主会话可用（标签页会话不得推动）", true);
			const p = (rawParams ?? {}) as { runId?: unknown; mode?: unknown };
			const runId = typeof p.runId === "string" ? p.runId.trim() : "";
			if (!runId) return text("supervise-push: runId required（目标标签页 runId）", true);
			// 不传 mode 时**不得**在此处补缺省——自动选档在 supervisePush 内部按派生相位做（见文件头 C.3 解读边界）
			const explicitMode: "steer" | "abort" | undefined =
				p.mode === "abort" || p.mode === "steer" ? p.mode : undefined;

			const res = supervisePush({ runId, mode: explicitMode }, opts);
			if (!res.ok) {
				return text(
					[
						`❌ supervise-push 拒绝: reason=${res.reason}`,
						`  target=tab:${runId} mode=${explicitMode ?? "auto"}`,
						`  detail=${res.detail}`,
						`  ⇒ ${REJECT_HINT[res.reason] ?? "不推"}`,
					].join("\n"),
					true,
				);
			}
			const steerDir = opts.steerDir ?? defaultSteerDir();
			let preview = "";
			try {
				preview = readSteerRecord(steerDir, runId, res.steerId)?.body ?? "";
			} catch {
				preview = "";
			}
			return text(
				[
					`✅ supervise-push #${res.pushIndex}/${res.pushIndex + res.remainingBudget} → steerId=${res.steerId} remaining=${res.remainingBudget}`,
					`  target=tab:${runId} mode=${res.mode}`,
					res.remainingBudget <= 0
						? "  note=本 epoch 预算已用尽：再停就升级用户（附 pushes[] 时间线），不要换 runId 绕过"
						: "",
					preview ? `  body:\n${preview.split("\n").map((l) => `    ${l}`).join("\n")}` : "",
				]
					.filter(Boolean)
					.join("\n"),
			);
		},
	});

	return () => {
		/* 无 interval/watcher：工具注册本身无需清理（保留统一 cleanup 形状，供 index.ts collect()） */
	};
}
