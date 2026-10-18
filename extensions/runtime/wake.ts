/**
 * runtime/wake.ts — Sub-Master 唤醒评估（Phase 5c，A7 F20 + 仲裁裁决）
 *
 * 独立模块（失败模式 D：不内联进 consumeMailboxOnce，由 tick 末尾调用）。
 * 触发集 v1：workstream 地址 mailbox 任一 pending letter（含 agent.wake command）。
 *
 * 评估链（per workstream）：
 *   cutover/owner 双门 → status active + policy.enabled（pause 全跳过）
 *   → cooldown（先查，后扫信，省 IO）→ mailbox 有信 → debounce（最新信龄）
 *   → maxSpawns 滚动 24h → in-flight（wake-state tab 无终态且 dispatch 年轻）
 *   → claim 全 inbox → 派生监管块（P1 修正 ③：读 supervision 账本 + tab 账本）→ fire（含 prompt）
 *
 * 依赖方向（无循环）：本模块 import `./supervision.ts`（纯库）与 `../tab-runs.ts`；
 * 而 `supervision.ts` 只 import `../tab-runs.ts` + `./journal.ts` + `frontier.ts` 类型，
 * 两者都**不** import 本模块 ⇒ 不成环。本模块**不得** import `../supervision-runtime.ts`（Pi tool 层）。
 *
 * 确认（调用方 spawn 成功后）：confirmWakeSpawn 写 wake-state + ack 同 holder 信
 *   + 审计 wake.spawn。spawn 抛错 → 审计 wake.spawn-failed，信留 claimed（stale 恢复）。
 * 审计纪律：spawn/spawn-failed/capped 恒记；其余 skip 每进程每 ws 只记一次（防 tick 刷屏）。
 * 遥测（lastSpawnAt/tabRunId/spawnAt）落 state/wake-state/<ws>.json，永不进
 * WorkstreamRecord（F18 双真相源纪律）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { defaultRuntimeDir } from "./journal.ts";
import { masterAddress, workstreamAddress, type ObjectAddress } from "./address.ts";
import { readAttachment, readCutover } from "./registry.ts";
import {
	ackClaimedBy,
	claimLetters,
	defaultMailboxDir,
	listLetters,
	type Letter,
} from "./mailbox.ts";
import { defaultTabRunsDir, readTabDispatch, readTabResultFile, readTabState, composeTabStatus } from "../tab-runs.ts";
import { listOpenSupervisionEntries, thresholdsOf, type SupervisionEntry } from "./supervision.ts";
import { evaluateAutonomyWakeGate } from "./autonomy/gate.ts";
import { runAutonomyActions } from "./autonomy/action/run.ts";
import {
	auditWorkstreamOp,
	listWorkstreams,
	type WorkstreamRecord,
} from "./workstreams.ts";

export type WakeSkipReason =
	| "paused"
	| "disabled"
	| "cooldown"
	| "no-mail"
	| "debounced"
	| "capped"
	| "in-flight";

export interface WakeLetter {
	messageId: string;
	subject?: string;
	summary: string;
	sentAt: string;
	/** 原信发信方（message 帧 frame.from / command 帧 issuedBy）= 回信目标 */
	from?: ObjectAddress;
	/** 原信收件方（frame.to / to）= 回信的 from（本收件地址） */
	to?: ObjectAddress;
	/** 仅 message 帧有：requiresAck（kind !== "ACK"）；true → prompt 要求回 RESULT */
	requiresAck?: boolean;
}

export interface WakeDecision {
	workstreamId: string;
	fire: boolean;
	reason?: WakeSkipReason;
	letters: WakeLetter[];
	/** fire 时的 bounded prompt（调用方经 launch 纪律块包装后 spawn） */
	prompt?: string;
}

export interface WakeOptions {
	stateDir?: string;
	mailboxDir?: string;
	runsDir?: string;
	sessionId: string | undefined;
	/** fake clock（毫秒，测试用；缺省 Date.now()） */
	now?: number;
	inFlightWindowMs?: number;
	/** test-only：autonomy config.json 注入（同 now/inFlightWindowMs 先例；生产不传，gate 读包根缺省） */
	autonomyConfigPath?: string;
}

export interface WakeState {
	workstreamId: string;
	lastSpawnAt?: string;
	lastTabRunId?: string;
	/** 滚动发射 log（ISO，confirm 时追加；读时剪 >24h） */
	spawnAt: string[];
	updatedAt: string;
}

/** 每进程每 ws 只审计一次的 skip 原因（防 tick 刷屏；spawn 类恒记） */
const auditedSkip = new Set<string>();

// ── 评估（读 + claim，不 spawn 不 ack）──────────────────────────────

export function evaluateWakes(opts: WakeOptions): WakeDecision[] {
	const now = opts.now ?? Date.now();
	const cutover = readCutover();
	if (!cutover?.enabled) return []; // 与消费端同门：未切换零动作零审计
	const attachment = readAttachment(masterAddress());
	if (!attachment || !opts.sessionId || opts.sessionId !== attachment.sessionId) return [];

	const stateDir = opts.stateDir ?? join(defaultRuntimeDir(), "state");
	const mailboxDir = opts.mailboxDir ?? defaultMailboxDir();
	// v2 autonomy 总门（Task 2006 L2，D-A/D-E）：owner 门后、ws 遍历前；传已解析 stateDir。
	// enabled!==true → 完全旁路（零行为零写盘）；enabled → kill/collect fail-closed 压制 legacy fire。
	const autonomyGate = evaluateAutonomyWakeGate({ stateDir, configPath: opts.autonomyConfigPath, now });
	if (autonomyGate.engaged && !autonomyGate.proceed) return [];
	// P1 可回滚动作面（设计 D2 批准）：autonomy gate 块后 +1 个 never-throw 调用。
	// actions.enabled 默认 false ⇒ 除一次 config 读外零 IO、零新文件（独立 fail-closed，
	// 与 wake 面 fail-open 不混淆）；不搭 legacy 唤醒 spawn 通道（§1.4 结构性防火墙）；
	// 只写自有 namespace <stateDir>/autonomy/actions/**。
	runAutonomyActions({ stateDir, configPath: opts.autonomyConfigPath, sessionId: opts.sessionId, now });
	const decisions: WakeDecision[] = [];

	for (const ws of listWorkstreams(stateDir)) {
		const d = evaluateOne(ws, { ...opts, now, stateDir, mailboxDir });
		decisions.push(d);
	}
	return decisions;
}

function evaluateOne(
	ws: WorkstreamRecord,
	opts: WakeOptions & { now: number; stateDir: string; mailboxDir: string },
): WakeDecision {
	const skip = (reason: WakeSkipReason): WakeDecision => {
		if (!auditedSkip.has(`${ws.id}:${reason}`)) {
			auditedSkip.add(`${ws.id}:${reason}`);
			auditWorkstreamOp(opts.stateDir, opts.sessionId, `wake.skip-${reason}`, ws.id, ws.mission.slice(0, 80));
		}
		return { workstreamId: ws.id, fire: false, reason, letters: [] };
	};

	// (a) 灭火开关 + 使能（F20 day-one）
	if (ws.status !== "active") return skip("paused");
	const policy = ws.wakePolicy;
	if (!policy?.enabled) return skip("disabled");

	// cooldown 先查（省 IO）
	const state = readWakeState(ws.id, opts.stateDir);
	if (state.lastSpawnAt && opts.now - Date.parse(state.lastSpawnAt) < policy.cooldownMs) {
		return skip("cooldown");
	}

	// ws mailbox 有信
	const wsAddr = workstreamAddress(ws.id);
	let pending: Letter[];
	try {
		pending = listLetters(wsAddr, "pending", opts.mailboxDir);
	} catch {
		return skip("no-mail");
	}
	if (!pending.length) return skip("no-mail");

	// debounce：最新信龄
	if (policy.debounceMs && policy.debounceMs > 0) {
		const newest = Math.max(...pending.map((l) => Date.parse(letterTime(l))));
		if (Number.isFinite(newest) && opts.now - newest < policy.debounceMs) return skip("debounced");
	}

	// maxSpawns 滚动 24h（超限恒审计，不改 status——status 是用户意图）
	const windowStart = opts.now - 24 * 60 * 60 * 1000;
	const recentSpawns = state.spawnAt.filter((t) => Date.parse(t) >= windowStart);
	if (policy.maxSpawns !== undefined && recentSpawns.length >= policy.maxSpawns) {
		auditWorkstreamOp(opts.stateDir, opts.sessionId, "wake.capped", ws.id, `spawns=${recentSpawns.length}/${policy.maxSpawns}`);
		return { workstreamId: ws.id, fire: false, reason: "capped", letters: [] };
	}

	// in-flight：上次 spawn 的 tab 无终态且 dispatch 年轻 → 等
	if (state.lastTabRunId && isInFlight(state.lastTabRunId, opts)) {
		return skip("in-flight");
	}

	// claim 全 inbox（ws 信无其他消费者，无竞争；holder 供确认时 ackClaimedBy）
	const holder = wakeHolder(opts.sessionId!, ws.id);
	const claimed = claimLetters(wsAddr, { claimedBy: holder, mailboxDir: opts.mailboxDir });
	if (!claimed.length) return skip("no-mail"); // list→claim 窗口被他人取走（防御性）

	const letters: WakeLetter[] = claimed.map(describeLetter);
	// P1 主动推动（2026-10-18 修正 ③）：把「需推动的 tab」派生进 wake prompt。
	// 无监管账本 / 读失败 / 无匹配 ⇒ undefined ⇒ buildWakePrompt 输出**逐字节不变**（既有保证）。
	const supervision = deriveSupervisionItems({
		stateDir: opts.stateDir,
		runsDir: opts.runsDir ?? defaultTabRunsDir(),
		now: opts.now,
	});
	return { workstreamId: ws.id, fire: true, letters, prompt: buildWakePrompt(ws, letters, supervision) };
}

// ── P1：停滞监管派发（供 buildWakePrompt 第三参）────────────────────

/** 每 epoch 推动上限缺省（与 `supervision-runtime.ts::SUPERVISION_MAX_PUSHES` **双写**，见下）。 */
const WAKE_PUSH_MAX_DEFAULT = 2;

/**
 * 本 epoch 推动计数（**与 `supervision-runtime.ts::countPushes` 同口径，双写**）。
 *
 * 为什么不直接 import：`supervision-runtime.ts` 是 **Pi tool 层**（import `@earendil-works/pi-coding-agent`
 * / `pi-tui` / typebox），wake 是 runtime 纯库层 —— 反向 import 会把 tool 层拖进 wake 的依赖闭包
 * （且 mailbox-consumer 已在 Pi 宿主外跑）。口径只有两行逻辑（`at > max(epoch.startedAt, lastActivityAt)`），
 * 双写成本低于破层成本；两边改动必须同步（本注释 = 双写登记点）。
 */
function pushesThisEpochOf(entry: SupervisionEntry, stateLastActivityAt: string | undefined): number {
	const started = Date.parse(String(entry?.epoch?.startedAt ?? ""));
	const activity = Date.parse(String(stateLastActivityAt ?? ""));
	const epochStartMs = Math.max(Number.isFinite(started) ? started : 0, Number.isFinite(activity) ? activity : 0);
	const pushes = Array.isArray(entry?.epoch?.pushes) ? entry.epoch.pushes : [];
	let n = 0;
	for (const p of pushes) {
		const t = Date.parse(String((p as { at?: unknown })?.at ?? ""));
		if (Number.isFinite(t) && t > epochStartMs) n++;
	}
	return n;
}

/** maxPushes 钳制（**与 `supervision-runtime.ts::clampMaxPushes` 同口径，双写**）。 */
function clampPushMax(v: unknown): number {
	const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : WAKE_PUSH_MAX_DEFAULT;
	return Math.min(3, Math.max(1, n));
}

/**
 * 路径归一（仅用于 repo 过滤比较）：反斜杠 → 斜杠、去尾斜杠、小写。
 * 本地小函数（不引新依赖，也不复用 `frontier.ts::normalizeExactPath`：那个还要规范化盘符大小写，
 * 且会把 `C:` 单独降小写；这里只要「同仓判等」这一个语义，多带行为反而难推理）。
 */
function normRepoPath(p: string): string {
	return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * 仓归属判据：相等 ∨ 候选在该仓**子目录**下（dispatch.cwd 可能是 repo 子目录）。
 * `filter` 必须是已经 `normRepoPath` 过的值。
 */
function repoPathMatches(candidate: string, filter: string): boolean {
	const c = normRepoPath(candidate);
	if (!c) return false; // 无仓载体 ⇒ 不命中（不猜）
	return c === filter || c.startsWith(`${filter}/`);
}

/**
 * 从监管账本 + tab 账本派生 `WakeSupervisionItem[]`（P1 修正 ③：让第三参真正有生产调用方）。
 *
 * 取两类（任务书 §③）：
 *   - `stopReason === "error"` —— BLOCKED_USER 里**唯一该被推**的子类（瞬时错误，推一次可复活）；
 *   - STALLED 形状 —— `phase === "waiting" ∧ idleMs > thresholdsOf(entry).pushMs ∧ stop ∉ {toolUse,error,aborted}`。
 * 其余（terminal / working / 短 idle / 跑工具）不进块：wake prompt 越短，被唤醒的 master 越不容易跑偏。
 *
 * **整段 never-throw**：任何读失败/异常 ⇒ 返回 `undefined`（保持 buildWakePrompt 逐字节不变的既有保证）。
 *
 * 2026-10-18 G1-1：导出 + 新增 `repoPath` 可选过滤（scope 路复用；见 `buildScopeWakePrompt` 第四参）。
 *   - 不给 `repoPath` ⇒ 行为**逐字节不变**（workstream 路跨仓，需要全机视角）；
 *   - 给了 ⇒ 只保留该仓条目（scope wake 是 per-repo 的，把别的仓的 tab 塞进去只会让被唤醒的
 *     local master 跑偏：它无权也无力推动他仓 tab）；
 *   - 过滤后为空 ⇒ 返回 `undefined`（**关键**：保证「本仓无监管 ⇒ prompt 逐字节不变」）。
 */
export function deriveSupervisionItems(opts: {
	stateDir: string;
	runsDir: string;
	now: number;
	/** 给出时只保留该仓条目（归一比较，覆盖 dispatch.cwd 在子目录的情形）。 */
	repoPath?: string | null;
}): WakeSupervisionItem[] | undefined {
	try {
		const entries = listOpenSupervisionEntries({ stateDir: opts.stateDir });
		const repoFilter = opts.repoPath ? normRepoPath(opts.repoPath) : null;
		if (!entries.length) return undefined;
		const items: WakeSupervisionItem[] = [];
		for (const entry of entries) {
			try {
				if (entry.status !== "active" || entry.optOut === true) continue; // paused / 静默：不问不动
				const dispatch = readTabDispatch(opts.runsDir, entry.runId);
				const state = readTabState(opts.runsDir, entry.runId);
				const result = readTabResultFile(opts.runsDir, entry.runId);
				const view = composeTabStatus({
					runId: entry.runId,
					dispatch,
					state,
					result,
					probe: null,
					dispatchedAt: dispatch?.dispatchedAt,
					now: opts.now,
				});
				if (view.terminal === true) continue; // 已终态：该回收而非推动
				const stopReason = state?.lastStopReason ?? "unknown";
				const actMs = Date.parse(String(state?.lastActivityAt ?? ""));
				const idleMs = Number.isFinite(actMs) ? Math.max(0, opts.now - actMs) : 0;
				const errored = stopReason === "error";
				const stalled =
					view.phase === "waiting" &&
					idleMs > thresholdsOf(entry).pushMs &&
					stopReason !== "toolUse" &&
					stopReason !== "error" &&
					stopReason !== "aborted";
				if (!errored && !stalled) continue;
				const itemRepoPath = dispatch?.cwd ?? entry.repoPath ?? "";
				// repo 过滤（scope 路）：命中判据见 normRepoPath 注释；未给过滤 ⇒ 恒命中。
				if (repoFilter !== null && !repoPathMatches(itemRepoPath, repoFilter)) continue;
				items.push({
					runId: entry.runId,
					taskId: entry.taskId || dispatch?.taskId || "unknown",
					repoPath: itemRepoPath,
					idleMs,
					stopReason,
					summary: state?.lastAssistantText ?? "",
					pushesUsed: pushesThisEpochOf(entry, state?.lastActivityAt),
					maxPushes: clampPushMax((entry as { maxPushes?: unknown }).maxPushes), // 账本 v1 无此字段 ⇒ 缺省 2（clamp [1,3]）
				});
			} catch {
				continue; // 单条失败只影响单条（不让一条坏账本吃掉整块）
			}
		}
		return items.length > 0 ? items : undefined;
	} catch {
		return undefined;
	}
}

// ── 确认（调用方 spawn 成功后）──────────────────────────────────────

export function confirmWakeSpawn(
	workstreamId: string,
	tabRunId: string,
	opts: { stateDir?: string; mailboxDir?: string; sessionId: string; now?: number },
): void {
	const now = opts.now ?? Date.now();
	const stateDir = opts.stateDir ?? join(defaultRuntimeDir(), "state");
	const state = readWakeState(workstreamId, stateDir);
	const windowStart = now - 24 * 60 * 60 * 1000;
	const spawnAt = [...state.spawnAt.filter((t) => Date.parse(t) >= windowStart), new Date(now).toISOString()];
	writeWakeState(stateDir, {
		workstreamId,
		lastSpawnAt: new Date(now).toISOString(),
		lastTabRunId: tabRunId,
		spawnAt,
		updatedAt: new Date(now).toISOString(),
	});
	const wsAddr = workstreamAddress(workstreamId);
	const n = ackClaimedBy(wsAddr, wakeHolder(opts.sessionId, workstreamId), opts.mailboxDir ?? defaultMailboxDir());
	auditWorkstreamOp(stateDir, opts.sessionId, "wake.spawn", workstreamId, `tab=${tabRunId} letters=${n}`);
}

/** spawn 抛错记账（信留 claimed，stale 恢复；不碰 wake-state——失败不占 cooldown）。 */
export function auditWakeSpawnFailed(
	workstreamId: string,
	error: string,
	opts: { stateDir?: string; sessionId?: string } = {},
): void {
	auditWorkstreamOp(opts.stateDir, opts.sessionId, "wake.spawn-failed", workstreamId, error.slice(0, 200));
}

// ── Bounded prompt（调用方经 launch 纪律块包装）─────────────────────

/**
 * mailbox.ts 的绝对 file:// URL（与本模块同目录）——回信 recipe 的动态 import 目标，
 * 加载时解析一次。本机 node v22 类型剥离下以 file:// URL 形式可被动态 import 接受
 *（已实测）；Windows 裸反斜杠绝对路径会被 ESM loader 拒绝
 *（"On Windows, absolute paths must be valid file:// URLs"）。
 */
export const MAILBOX_MODULE_URL = new URL("./mailbox.ts", import.meta.url).href;

/**
 * 回信 recipe（内嵌进 wake prompt；tab 无发信工具，用 bash + 临时脚本调 deliverLetter）。
 * mailboxUrl = mailbox.ts 的绝对 file:// URL；尖括号占位符由执行方按当前那封信填值。
 * 脚本体刻意不用模板字符串（避免与外层 TS 模板字面量转义冲突）。
 */
export function buildReplyRecipe(mailboxUrl: string): string {
	return [
		"【回信 recipe — 每封需回执的来信执行一次（你无发信工具，用 bash + 下面的脚本调 deliverLetter）】",
		"1) 把下面脚本里的 <原信 to> / <原信 from> / <原信 messageId> / <回执摘要> 替换为当前这封信的值（原信 to = 你的收件地址，原信 from = 回信目标），写进一个临时 .mjs（路径自定，如 reply_<messageId>.mjs）：",
		"```mjs",
		`import { deliverLetter, mailboxDirFor } from "${mailboxUrl}";`,
		"const REPLY = {",
		'  frame: "message",',
		'  id: "msg_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8),',
		'  kind: "RESULT",',
		'  from: "<原信 to>",',
		'  to: "<原信 from>",',
		'  inReplyTo: "<原信 messageId>",',
		"  requiresAck: true,",
		"  sentAt: new Date().toISOString(),",
		'  body: { summary: "<回执摘要，≤512 字节>" },',
		"};",
		"const r = deliverLetter(REPLY);",
		'console.log("DELIVERED created=" + r.created + " id=" + r.letter.frame.id);',
		'console.log("recipientDir=" + mailboxDirFor(REPLY.to));',
		"```",
		"2) 运行：node <临时脚本.mjs>（本机 node v22 类型剥离默认可用，能直接 import 上面的 .ts；若报类型/解析错误改用 node --experimental-strip-types <脚本>；不要用 npx，它依赖网络）",
		"3) 确认：ls <上一步打印的 recipientDir>（= mailboxDirFor(回信的 to)；目录名规则：非 [A-Za-z0-9._-] 的字符一律替换为 _），断言出现新的 msg_*.json",
		"4) 删除临时脚本",
	].join("\n");
}

/**
 * 停滞监管块的单条输入（P1：`plans/20261017_stagnation_supervision_plan.md` §C.4/C.5）。
 * 由 `deriveSupervisionItems`（本文件，读监管账本 + tab 账本派生）产出；`buildWakePrompt` 只负责渲染。
 * （2026-10-18 修正 ③：旧注释说「本模块不读账本」，但第三参因此永远没有生产调用方——
 *   监管块在生产上从未出现过。现在读账本就在 `evaluateOne` 的 fire 分支里，仍全部 never-throw。）
 */
export interface WakeSupervisionItem {
	runId: string;
	taskId: string;
	repoPath: string;
	idleMs: number;
	stopReason: string;
	summary: string;
	pushesUsed: number;
	maxPushes: number;
}

/** 摘要截断（与 C.2 模板同口径：≤120 字符）。 */
const WAKE_SUMMARY_MAX = 120;

/**
 * 停滞监管块（仅在 `supervision` 非空时插入；空/undefined ⇒ 完全不调用本函数）。
 *
 * 为什么要塞进 wake prompt：C.5 的执行主体是**被唤醒的 master**——它没有别的渠道知道
 * 「哪个 tab 停了多久、还能推几次」，只能由 wake prompt 带过去。
 */
export function buildSupervisionBlock(items: readonly WakeSupervisionItem[]): string[] {
	const shown = items.slice(0, 10);
	return [
		`停滞监管（需推动的 tab，按 budget 余量决定是否推）：`,
		...shown.map((s) => {
			const repo = basename(s.repoPath || "") || "unknown";
			const idleMin = Math.max(0, Math.round((Number.isFinite(s.idleMs) ? s.idleMs : 0) / 60_000));
			const summary = s.summary.length > WAKE_SUMMARY_MAX ? s.summary.slice(0, WAKE_SUMMARY_MAX) : s.summary;
			const stop = s.stopReason && s.stopReason.length > 0 ? s.stopReason : "unknown";
			return [
				`- ${s.runId} task=${s.taskId} repo=${repo} 已停 ${idleMin}min stop=${stop} push=${s.pushesUsed}/${s.maxPushes} 摘要：${summary}`,
				`  用 supervise-push({runId:"${s.runId}"}) 推动（预算耗尽则升级用户，勿 abort）。`,
			].join("\n");
		}),
	];
}

export function buildWakePrompt(ws: WorkstreamRecord, letters: WakeLetter[], supervision?: WakeSupervisionItem[]): string {
	const shown = letters.slice(0, 10);
	// 硬要求（spec §2）：undefined / [] ⇒ 与旧输出逐字节相同（现有调用方零改动）。
	const supervisionBlock = Array.isArray(supervision) && supervision.length > 0 ? buildSupervisionBlock(supervision) : [];
	const replies = shown.filter((l) => l.requiresAck === true && Boolean(l.from) && Boolean(l.to));
	const replyBlock: string[] = [];
	if (replies.length) {
		replyBlock.push(
			"回执（round-trip：处理完必须逐封回信给来信者）：",
			...replies.map(
				(l) => `- 回执：${l.messageId} → 用 deliverLetter 回 kind=RESULT 到 ${l.from}（from=${l.to}, inReplyTo=${l.messageId}）`,
			),
			buildReplyRecipe(MAILBOX_MODULE_URL),
		);
	}
	const lines = [
		`你是 workstream ${ws.id} 的 Sub-Master（runtime wake 层唤醒，有终态的一次执行）。`,
		`mission=${ws.mission}`,
		ws.successCriteria ? `criteria=${ws.successCriteria}` : null,
		`待处理输入（${letters.length}）：`,
		...shown.map((l) => `- [${l.subject ?? "no-subject"}] ${l.summary.slice(0, 200)}`),
		...supervisionBlock,
		...replyBlock,
		`规则：单次有界执行，做完即 tab-finish（天然 sleep）；禁止设 timer 自续命，再入只能经 wake 层；`,
		...(replies.length
			? [
				"硬规则：处理完必须逐封用 deliverLetter 回 kind=RESULT 给来信者；禁止只依赖 tab-report（它是派发者归属通道，wake 场景的来信者收不到）；command 帧不要求回信。",
			  ]
			: []),
		`无 actionable 输入时立即 tab-finish 报 no-op，不许挂等；`,
		`workstream 暂停时你不会被唤醒（由 wake 层保证）。`,
	].filter((l): l is string => l !== null);
	return lines.join("\n");
}

// ── wake-state IO ──────────────────────────────────────────────────

function wakeStateDir(stateDir: string): string {
	return join(stateDir, "wake-state");
}

export function readWakeState(workstreamId: string, stateDir?: string, now: Date = new Date()): WakeState {
	const dir = stateDir ?? join(defaultRuntimeDir(), "state");
	try {
		return JSON.parse(
			readFileSync(join(wakeStateDir(dir), `${workstreamId}.json`), "utf8"),
		) as WakeState;
	} catch {
		// G5.2：now 可注入（snapshot 确定性投影用）；缺省 = 实时（原有调用方零行为变化）。
		return { workstreamId, spawnAt: [], updatedAt: now.toISOString() };
	}
}

/** 导出供 local master v1 复用：wake-state 以 <scope> 命名落盘（per-workstream 结构不变）。 */
export function writeWakeState(stateDir: string, state: WakeState): void {
	const dir = wakeStateDir(stateDir);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${state.workstreamId}.json`);
	const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}

/** 导出供 local master v1 复用（id 传 scope，同构 holder 规则）。 */
export function wakeHolder(sessionId: string, workstreamId: string): string {
	return `wake:${sessionId}:${workstreamId.slice(0, 14)}`;
}

// ── 小件 ───────────────────────────────────────────────────────────

function letterTime(letter: Letter): string {
	return letter.frame.frame === "message" ? letter.frame.sentAt : letter.frame.issuedAt;
}

function describeLetter(letter: Letter): WakeLetter {
	if (letter.frame.frame === "message") {
		return {
			messageId: letter.frame.id,
			subject: letter.frame.subject,
			summary: letter.frame.body.summary,
			sentAt: letter.frame.sentAt,
			from: letter.frame.from,
			to: letter.frame.to,
			requiresAck: letter.frame.requiresAck,
		};
	}
	return {
		messageId: `cmd:${letter.frame.commandKey}`,
		summary: `command ${letter.frame.type}`,
		sentAt: letter.frame.issuedAt,
		from: letter.frame.issuedBy,
		to: letter.frame.to,
	};
}

/**
 * 在飞判定：无 result.json 且 dispatch 年轻（窗口内）→ 等；
 * dispatch 缺失/不可读/年老 → 视为 orphaned，可重生（at-least-once）。
 */
/** 导出供 local master v1 复用（同规则：无终态且 dispatch 年轻 → 在飞）。 */
export function isInFlight(
	tabRunId: string,
	opts: { runsDir?: string; now: number; inFlightWindowMs?: number },
): boolean {
	const runsDir = opts.runsDir ?? defaultTabRunsDir();
	if (existsSync(join(runsDir, `${tabRunId}.result.json`))) return false; // 有终态 → 不在飞
	const windowMs = opts.inFlightWindowMs ?? 2 * 60 * 60 * 1000;
	try {
		const dispatch = readTabDispatch(runsDir, tabRunId);
		if (!dispatch) return false;
		const age = opts.now - Date.parse(dispatch.dispatchedAt);
		return Number.isFinite(age) && age < windowMs;
	} catch {
		return false;
	}
}

/** 供测试重置进程内审计去重集合。 */
export function _resetWakeAuditForTest(): void {
	auditedSkip.clear();
}
