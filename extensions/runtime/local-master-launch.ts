/**
 * runtime/local-master-launch.ts — 主会话按 cwd 幂等确保他仓 local master 存活
 * （0924 计划 §1/§2 MVP；用户裁定 1-10 落地）。
 *
 * 职责边界（**零新增权力**）：
 *   - 不写 attachment、不代替 attach、不带 forceStale/token/cutover/detach——认领一律由
 *     新会话 session_start 的既有静默路径完成（silentScopeGenesis / takeoverStaleScopeOwner，
 *     见 mailbox-consumer.ts registerScopeWakeLoop 的 session_start 处理块）；
 *   - 只收 cwd：scope/地址由 localMasterScope(cwd) 派生，参数面不收 scope/地址（防指向混淆）；
 *   - spawn 形态 = 可见 WT tab（非无头）：常驻会话唯一现成通道，可见性本身是安全特性。
 *
 * 三段幂等：
 *   1. precheck：已有**活** owner（attachment+liveness 同身份同代 + pid 活）→ `already-running`，
 *      零 spawn 零 in-flight 写（并顺手关掉历史窗口）；
 *   2. in-flight marker first-wins：`state/local-master-launch/<scope>.json`，窗口 = timeout+30s
 *      且**落盘**（`windowEndsAt`，first-wins：窗口属于最初那次 spawn，不由后续调用方的
 *      timeout 现算）；窗口内同 scope 重调 → `launched` + inFlight=true（零第二个 spawn）；
 *   3. spawn 后按就绪判据轮询（waitForReady=false 则直接 `launched`）。
 *
 * 就绪判据（用户裁定 #7，严格）：
 *   liveness && attachment && 同 sessionId && 同 generation && isProcessAlive(pid)
 *   && launchAt < liveness.updatedAt → `ready`；拿不到 liveness → 如实 `stalled`（不猜）。
 *
 * 消费侧就绪（#A → 0926 P1）：local master 的「可用」由**消费事实**证明。第一段约束是
 * launched 模式观测到 claim（attachment.generation 高于 precheck 快照）；第二段（0926）
 * 要求 tick 写入的消费进展证据（state/scope-consume/<scope>.json，唯一写手 = 消费 tick）
 * **fresh**：证据绑定 sessionId+generation+lastTickAt，旧代/异身份/陈旧证据一律不算数
 * （judgeConsumeFresh）。缺证据 → 如实降级，不猜、不 spawn、不自动 force takeover。
 *
 * 纯库：spawn/clock/sleep/fs 全可注入，无 Pi API 依赖（同 master-transfer 纪律）。
 * 审计：`state/local-master-ensure-audit.jsonl`，行 {at, by, cwd, scope, action, result}，无正文。
 */

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	openSync,
	closeSync,
	readFileSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ObjectAddress } from "./address.ts";
import { defaultRuntimeDir } from "./journal.ts";
import { isProcessAlive, readScopeLiveness, type ScopeLiveness } from "./liveness.ts";
import { readAttachment, type MasterAttachment } from "./registry.ts";
import { localMasterAddress, localMasterScope } from "./scope.ts";
import {
	judgeConsumeFresh,
	readConsumeEvidence as readConsumeEvidenceFile,
	type ConsumeFreshReason,
	type ScopeConsumeEvidence,
} from "./scope-consume.ts";

// ── 常量 ───────────────────────────────────────────────────────────

export const ENSURE_DEFAULT_TIMEOUT_MS = 60_000;
export const ENSURE_MAX_TIMEOUT_MS = 180_000;
/** in-flight 窗口 = timeout + 30s（用户裁定 #8）。 */
export const ENSURE_IN_FLIGHT_EXTRA_MS = 30_000;
/** in-flight marker 目录名（state/local-master-launch/<scope>.json）。 */
export const ENSURE_MARKER_DIR = "local-master-launch";
/** 审计行文件（state/local-master-ensure-audit.jsonl；无正文纪律同 master-injections.jsonl）。 */
export const ENSURE_AUDIT_FILE = "local-master-ensure-audit.jsonl";

/** 超时归一：缺省 60s、上限 180s、下限 100ms（非法值回落缺省）。 */
export function clampEnsureTimeout(ms?: number): number {
	if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return ENSURE_DEFAULT_TIMEOUT_MS;
	return Math.min(Math.max(ms, 100), ENSURE_MAX_TIMEOUT_MS);
}

// ── slash 参数解析（纯函数；L4-M1）─────────────────────────────────

export interface LocalMasterEnsureArgs {
	/** 第一个 positional token（trim 后；无 → 空串，由 ensure 判 invalid-cwd）。 */
	cwd: string;
	/** `--no-wait` 是否出现（→ waitForReady:false）。 */
	noWait: boolean;
	/** `--timeout` 的值（仅有限数值时给出；非法/缺失 → 不给，走 clampEnsureTimeout 缺省）。 */
	timeoutMs?: number;
	/** `--new-generation`：人已同意开新一代（默认 false=续接原 owner 会话）。 */
	forceNew?: boolean;
}

/**
 * `/local-master-ensure [--no-wait] [--timeout <ms>] [<cwd>]` 的解析（flag 与位置参数可任意顺序）。
 *
 * `--timeout` 是**带值 flag**：它的值本身不以 `--` 开头，但绝不能被当成 cwd——否则
 * `--timeout 5000 C:\repo` 会取到 `cwd="5000"`；若会话 cwd 下恰有同名目录，就会在错误目录
 * 开可见 tab，且新会话 `session_start` 会静默认领该目录 scope 的 local master（写 attachment、
 * 需人工撤）——正是层③「防指向混淆」要防的事故（L4 必须修 M1）。
 * 故：排除 `--timeout` 紧随的那个 token 后再取第一个非 flag token。
 */
export function parseLocalMasterEnsureArgs(args?: string): LocalMasterEnsureArgs {
	const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
	const tIdx = parts.indexOf("--timeout");
	// 修复（2026-10-30）：旧实现 `i !== tIdx + 1` 在 **`--timeout` 缺席时**（tIdx=-1）
	// 变成 `i !== 0` ⇒ 误把第一个位置参数（cwd）排掉 ⇒ cwd 恒为空串。
	// 只有 tIdx>=0 时才需要排除「--timeout 的值」。
	const positional = parts.filter((p, i) => !p.startsWith("--") && !(tIdx >= 0 && i === tIdx + 1));
	const raw = tIdx >= 0 ? Number(parts[tIdx + 1]) : undefined;
	return {
		cwd: (positional[0] ?? "").trim(),
		noWait: parts.includes("--no-wait"),
		// 2026-10-30 owner 裁决：默认续接；`--new-generation` 是**显式例外**（人已同意开新）。
		forceNew: parts.includes("--new-generation"),
		...(typeof raw === "number" && Number.isFinite(raw) ? { timeoutMs: raw } : {}),
	};
}

function defaultIsDirectory(p: string): boolean {
	try {
		return existsSync(p) && statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function sid12(s: string): string {
	return s.slice(0, 12);
}

// ── 结果形状 ───────────────────────────────────────────────────────

export type LocalMasterEnsureStatus =
	| "already-running"
	| "consume-unverified"
	| "launched"
	| "ready"
	| "spawn-failed"
	| "timeout"
	| "invalid-cwd"
	| "stalled";

export interface EnsureLivenessSnapshot {
	sessionId: string;
	pid: number;
	alive: boolean;
	updatedAt: string;
}

export interface LocalMasterEnsureResult {
	status: LocalMasterEnsureStatus;
	scope: string | null;
	agentAddress: ObjectAddress | null;
	runId?: string;
	liveness?: EnsureLivenessSnapshot;
	generation?: number;
	/** status=launched 且命中 in-flight 窗口（零第二个 spawn）时 true。 */
	inFlight?: boolean;
	/** 受控枚举原因（no-liveness / no-owner / claim-not-observed / identity-mismatch /
	 *  generation-mismatch / owner-pid-dead / liveness-not-updated / cwd-not-directory / in-flight …） */
	reason?: string;
	/** 仅 spawn-failed：spawn 层原始错误串（launch_failed 账本同源）。 */
	detail?: string;
	/** 消费侧就绪证据快照（ready / already-running / consume-unverified / consume-evidence-* 时给）。 */
	consumption?: EnsureConsumptionSnapshot;
}

export interface EnsureConsumptionSnapshot {
	state: "fresh" | "missing" | "stale" | "identity-mismatch" | "old-generation";
	lastTickAt?: string;
	tickCount?: number;
}

/** judgeConsumeFresh → 回执快照 state（ok → fresh）。 */
function consumptionSnapshot(
	ev: ScopeConsumeEvidence | null,
	j: { fresh: boolean; reason: ConsumeFreshReason },
): EnsureConsumptionSnapshot {
	const state: EnsureConsumptionSnapshot["state"] = j.fresh ? "fresh" : j.reason === "ok" ? "missing" : j.reason;
	return { state, ...(ev ? { lastTickAt: ev.lastTickAt, tickCount: ev.tickCount } : {}) };
}

/** status → 是否算错误回执（invalid-cwd/spawn-failed/timeout/stalled/consume-unverified 为错）。 */
export function ensureResultIsError(r: LocalMasterEnsureResult): boolean {
	return (
		r.status === "invalid-cwd" ||
		r.status === "spawn-failed" ||
		r.status === "timeout" ||
		r.status === "stalled" ||
		r.status === "consume-unverified"
	);
}

// ── 就绪判据（纯函数，可单测）──────────────────────────────────────

export interface ReadyCheckInput {
	attachment: MasterAttachment | null;
	liveness: ScopeLiveness | null;
	launchAt: string;
	isAlive?: (pid: number) => boolean;
	/** launched 模式：precheck 快照 generation（无 attachment 记 0）。给出时必须观测到前进（#A claim 判据）。 */
	claimedFromGeneration?: number;
	/** 消费进展证据（缺省视为缺席 → 第 8 条不成立；生产经 ensureLocalMaster 默认真实读取）。 */
	consumeEvidence?: ScopeConsumeEvidence | null;
	/** 新鲜度阈值（缺省 CONSUME_FRESH_MS；测试可注入）。 */
	consumeFreshMs?: number;
	/** 判新鲜度的当前时刻（缺省 Date.now()；测试随 fake clock 注入）。 */
	nowMs?: number;
}

/**
 * #7 就绪判据逐条 + #A claim 观测 + 第 8 条消费证据（0926，**append-last 只收紧不放松**：
 * 第 1–7 条 reason 优先序逐字不变，新增 reason 一律排在 claim-not-observed 之后）。
 * 首次不满足的 reason 即回执 reason（受控枚举，无正文）。不满足 ≠ 失败：调用方轮询到
 * deadline 再分类（stalled vs timeout）。
 */
export function judgeLocalMasterEnsureReady(input: ReadyCheckInput): { ready: boolean; reason: string } {
	const alive = input.isAlive ?? isProcessAlive;
	const { attachment, liveness } = input;
	if (!liveness) return { ready: false, reason: "no-liveness" };
	if (!attachment) return { ready: false, reason: "no-owner" };
	if (liveness.sessionId !== attachment.sessionId) return { ready: false, reason: "identity-mismatch" };
	if (liveness.generation !== attachment.generation) return { ready: false, reason: "generation-mismatch" };
	if (!alive(liveness.pid)) return { ready: false, reason: "owner-pid-dead" };
	if (!(input.launchAt < liveness.updatedAt)) return { ready: false, reason: "liveness-not-updated" };
	if (input.claimedFromGeneration !== undefined && !(attachment.generation > input.claimedFromGeneration)) {
		return { ready: false, reason: "claim-not-observed" };
	}
	// 第 8 条（0926 P1，append-last）：活进程 ≠ 能消费，ready 必须由消费事实证明。
	const fresh = judgeConsumeFresh(input.consumeEvidence ?? null, {
		sessionId: attachment.sessionId,
		generation: attachment.generation,
		nowMs: input.nowMs ?? Date.now(),
		...(input.consumeFreshMs !== undefined ? { freshMs: input.consumeFreshMs } : {}),
	});
	if (!fresh.fresh) return { ready: false, reason: `consume-evidence-${fresh.reason}` };
	return { ready: true, reason: "ready" };
}

/** consume-evidence-* 的 reason 集（分类/受控枚举用）。 */
export const CONSUME_EVIDENCE_REASONS = [
	"consume-evidence-missing",
	"consume-evidence-stale",
	"consume-evidence-identity-mismatch",
	"consume-evidence-old-generation",
] as const;

// ── 升级门分型（D-5，2026-10-21）──────────────────────────────────
//
// 问题：研究文档 §7(c) 要求「僵尸死角不得直接判需人工强接，须先需再次尝试 + 预计等待窗口，
// 窗口过期才升级」。但 local 上**没有可推导的时间窗口**（源码证据见
// plans/20261021_d5_escalation_gate_plan.md §1）：registry 心跳 10min 对 local 恒休真
//（registry.ts:218 / :394）、scope-liveness 按 turn 刷新不由时间决定（session-hooks.ts:46）、
// lease stale 30s 只是毫秒级并发互斥（registry.ts:330）。硬造时间窗口要么恒过期
//（= 永远直接升级），要么恒不过期（= 永不升级）。
//
// 所以把「窗口」换成**可判定的东西**：按失败**类型**决定有没有自主路径，
// 有才谈「再试一次」，没有就**第一次就升级**（否则文案在指导用户无限重试）。

/** 升级门分型。
 *
 * - `retryable`：存在自主路径，应先「再试一次」再谈人工强接。
 *   - `owner-pid-dead`：owner 的 pid 已死（僵尸 owner）⇒ 重试可能穿透
 *   - `lease-contended`：毫秒级假竞争（实证只有 6ms）⇒ 退避重试可消除
 *   - `handoff-token`：token 错/过期/代不符 ⇒ **路径存在**（去拿正确 token），不是死路
 *   - `not-stale`：心跳尚未过 10min ⇒ 等一会儿再试就是自主路径
 * - `wait-only`：只需等待既有窗口过期（窗口值现成，不新造）
 *   - `transfer-in-progress`：等 token 过期 / human cancel
 * - `hopeless`：现有代码下重试**永远**不会成功 ⇒ 必须**首次即升级**
 *   - `no-liveness` / `identity-mismatch`（`scope.ts:194/196` 恒 skip）
 *   - `bad-session`（无有效 sessionId，重跑一万次也是坏 sessionId）
 * - `insufficient-evidence`：判据不足，**不猜**
 *   - `stalled` / `consume-unverified` / `claim-not-observed` / 未列举 reason
 *
 * L4 v2 NIT（2026-10-21）：首版把 `bad-token` / `token-expired` / `generation-mismatch` /
 * `not-stale` 也归在 hopeless，**判据错了** —— 源码直读（`registry.ts:194-221`）：
 * token 类只要拿到**正确且未过期**的 handoff token 就能过；`not-stale` 只是
 * 「心跳还没过 10min（`:218-220`）」，等一等再试就是路径。把它们说成「任何重试都不会成功」
 * 是**作用域宽于证明**（AGENTS §0）。已收窄：只有真恒 skip 的才留在 hopeless。
 */
export type EscalationClass = "retryable" | "wait-only" | "hopeless" | "insufficient-evidence";

/** 两个 reason 命名空间（**重要：同名不同义**）。
 *
 * - `attach`：`registry.ts:113` 的 attach 失败 reason（owner-active / lease-contended /
 *   no-liveness / identity-mismatch / not-stale / bad-token …）。
 * - `ensure`：`judgeLocalMasterEnsureReady` 的就绪 reason（no-liveness / no-owner /
 *   claim-not-observed / consume-evidence-* …）。
 *
 * **同名不同义**：`no-liveness` 在 `attach` 里是**恒 skip、重试永远不会成功**（
 * `scope.ts:194`）⇒ hopeless；而在 `ensure` 里只意味着**spawn 出的会话还没写 liveness**
 * ⇒ 不是 hopeless，只能「不猜」（保持既有 G2/H 断言口径）。混用会直接误导用户。
 */
export type EscalationNamespace = "attach" | "ensure";

const RETRYABLE_REASONS = new Set(["owner-pid-dead", "lease-contended", "not-stale", "bad-token", "token-expired", "generation-mismatch"]);
const HOPELESS_ATTACH_REASONS = new Set([
	"no-liveness",
	"identity-mismatch",
	"bad-session",
	"not-owner",
	"no-cwd",
]);

/** 失败 reason → 升级门分型（纯函数，可单测）。
 *
 * 未列举的 reason 一律 `insufficient-evidence`（**不猜**）——宁可不给指引，也不给错指引。
 */
export function classifyEscalation(
	reason: string | undefined,
	namespace: EscalationNamespace = "attach",
): EscalationClass {
	if (reason === undefined) return "insufficient-evidence";
	if (RETRYABLE_REASONS.has(reason)) return "retryable";
	if (reason === "transfer-in-progress") return "wait-only";
	// `no-liveness` / `identity-mismatch` 只在 attach 命名空间里是恒 skip（hopeless）。
	// ensure 命名空间里它们是「会话还没起来」⇒ 保持不猜。
	if (namespace === "attach" && HOPELESS_ATTACH_REASONS.has(reason)) return "hopeless";
	return "insufficient-evidence";
}

/** 给客户端的受控文案（按分型）。
 *
 * 硬约束（plan A3）：`hopeless` **不得**出现「再试一次」类措辞 —— 否则就是指导用户
 * 无限重试一个恒失败的路径。
 */
export function escalationGuidance(cls: EscalationClass): string {
	switch (cls) {
		case "retryable":
			return "需再次尝试：本次失败有自主路径（退避重试 / 拿到正确且未过期的 handoff token / 等心跳过期均可穿透）。建议重跑一次 local-master-ensure 或在该仓开一个会话；若再次失败仍不恢复，才需人工强接（/master-attach --local --force-stale --confirm，只归用户）";
		case "wait-only":
			return "在途交接未结束：需等该交接结束或 token 过期（或用户 human cancel）后才可接管；重试无意义，不要刷";
		case "hopeless":
			return "无自主路径：该死角在现有判据下无法自动恢复（缺 liveness / 身份不匹配 / 会话 id 非法），任何重试都不会成功 —— 只能由用户走 /master-attach --local --force-stale --confirm 人工处置（本工具不带该权力）";
		case "insufficient-evidence":
			return "判据证据不足，不猜：人工在该仓开 pi 会话用 /master-status 核查（或由用户走 /master-attach --local --force-stale --confirm 处置死角）";
	}
}

/** deadline 分类：判不了/没认领/消费证据不足 → stalled（不猜）；判得了但没就绪 → timeout（带快照）。 */
export function ensureStatusForReason(reason: string | undefined): "stalled" | "timeout" {
	return reason === "no-liveness" || reason === "no-owner" || reason === "claim-not-observed" ||
		(reason !== undefined && (CONSUME_EVIDENCE_REASONS as readonly string[]).includes(reason))
		? "stalled"
		: "timeout";
}

// ── bootstrap prompt（照计划 §1：无 token、不指示 forceStale、不指示碰 global）──

export function buildLocalMasterBootstrapPrompt(scope: string, addr: ObjectAddress, repoCwd: string): string {
	return [
		`你是 ${addr} 的 local master（仓库 ${scope}），常驻本仓履职：不要 tab-finish、不要退出、不要设 timer 自续命。`,
		`工作目录：${repoCwd}（本仓）。session_start 会自动认领/接管本仓 attachment（无 owner 静默 genesis；僵尸仅按 pid 死判据接管）——先用 /master-status 核验 local 归属行 owner 是你、generation 与 liveness 一致。`,
		"若核验发现 owner 不是你（liveness 缺失/身份不匹配等死角）：如实说明并停在原地，不要自行强接（强接参数只归用户）、不要 attach 到别的地址；死角交还用户人工处置。",
		"收信处理与回信 recipe 遵循既有 wake prompt 纪律（本仓 scope 唤醒循环为 wake/命令类信拉起一次性 tab；需要回信的信按原信 from/inReplyTo 用 deliverLetter 回 RESULT）。",
		"你只持有本仓 local Master：不要触碰全局 Master（agent://master_default），不要调用 master-attach/master-detach/master-transfer/master-cutover。",
		"",
		"── 本仓接手清单（开工前先做，别凭印象）──",
		`1. 先显式 read 仓库根 \`${repoCwd}/AGENTS.md\` 并**照它执行**（pi 会自动把它放进你的上下文，但你必须显式读一遍确认）；若本仓没有 AGENTS.md → 读 README，并**向调用方报告 + 给出最小 AGENTS.md 草案待确认**（经确认后才建；不要自行在别人的仓里新建文件）。`,
		"2. 先查本仓已有知识，别重新探索：有 `Wiki/` → 用 `wiki-nav`（`tree` / `keywords` / `find`）先找**已完成功能的主题页**与相关章节，再按页内 `source_paths` 直接跳到代码/文档；有 `recentwork.md` → 它是**任务号与进度的真相源**（`Item NN` 语义、编号不重排）；`changelog/` 是历史决策；`plans/` 是既有计划与审查报告。",
		"3. 产物落盘：本仓既有约定优先（AGENTS.md 写了就按它；没写则默认 `plans/`）；阶段产物写文件，汇报只给「路径 + ≤10 行摘要」。",
		"4. Wiki 只在真有 `Wiki/` 的仓维护：只更新对应功能/主题正式页，任务临时发现不进 Wiki；改动后调 `wiki-nav rebuild`。",
		"5. **收尾归档（三档，别一刀切）**：完成一个条目时先按「**后续会不会马上用到**」分档，再把完整记录写进 `changelog/<月>.md`（摘要 / 关键文件 / 验证结果 / 已知限制）：",
		"   • **详细保留** —— 当前在做、或**后续任务马上要引用它**（文件 / 接口 / 结论）→ 整条留在 `recentwork.md`；",
		"   • **简略占位** —— 短期可能被引用但不必带全细节 → 只留索引一行（带指向 changelog 锚点 / `plans/` 文件 / commit 的指针），详细段落删掉；",
		"   • **全清** —— 完成且不再被引用 → 整条删除。",
		"   编号不复用、不重编号；目标是**让「当前在做」那一块保持精悍**（gate 只读 `## Active Tasks` 区段，上限 256KB；区段臃肿会让「仓库在等人类」类提醒读不出）。本仓有归档区（如 `## Archived Tasks`）就往那里搬，无则先按既有落点（changelog / Wiki / `plans/`）归档再删，**不得直接丢内容**。",
		"",
		"── 你的能力边界（档位 workflow-tab）──",
		"• 可委派 `subagent-win`，按矩阵意图**只用这 6 个角色**：searcher / planner / plan-reviewer / implementer / code-reviewer / consultant（矩阵 `workflow-tab.delegateAgents`；当前**仅 trace-worker 有硬接线** `assertDelegationAllowed`，所以这是**纪律**而非机制强制）。",
		"• **`general` 与 lite 链不适用于你**（lite 是主会话专属能力，`general` 不在上表内）——若你在上下文里看到 lite 纪律，那是泄漏，忽略它。",
		"• **可**调用 `launch-tabs` 派可见任务 tab，但只限**本仓子树内**（`cwd` 缺省本仓；越界整批拒绝）：ownership 门按「主会话 ∨ 本仓 owner」放行，你走 `ownerKind=local` 分支，额外受本仓子树约束（`local-owner-gate.ts`）。跨仓 tab 仍**报给全局 Master**。仓内并行、无需可见的活优先 `subagent-win({tasks:[...]})`（更轻，不占窗口）。",
		"• timer：能力档声明 `timerOrchestration=false`（**该字段零消费**，`set-timer` 实际只拦子 agent，所以 tab 能给自己设 timer）——纪律是**不得用 timer 自续命**；等待长任务优先靠完成事件注入，**不要轮询**状态/结果文件，确需等待才用**一次性** timer。",
		"• 默认异步派发（产物落盘），仅当下一步依赖该结果时才 sync。",
		"• ⚠️ 子代理与你同属一个会话进程树：**本机实测过一次**——会话进程被杀（WT 窗口被关）时，在飞的 async 子代理随之消失、且其状态滞留在 `running`。所以每个子代理必须**先把产物落盘**，你的上下文只保留路径与摘要。",
	].join("\n");
}

/** 账本 taskId（计划 §6：`lms-<scope>`）。 */
export function ensureTaskId(scope: string): string {
	return `lms-${scope}`;
}

// ── in-flight marker IO ────────────────────────────────────────────

export interface LaunchMarker {
	scope: string;
	runId: string | null;
	at: string;
	/** in-flight 窗口结束时刻（ISO；首次认领时落盘，first-wins，与后续调用方的 timeout 无关）。 */
	windowEndsAt?: string;
}

function markerPath(scope: string, stateDir: string): string {
	const safe = scope.replace(/[^A-Za-z0-9._-]/g, "_");
	return join(stateDir, ENSURE_MARKER_DIR, `${safe}.json`);
}

function tolerantReadMarker(path: string): LaunchMarker | null {
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as LaunchMarker;
		if (typeof raw?.scope !== "string" || typeof raw?.at !== "string") return null;
		if (typeof raw.runId !== "string" && raw.runId !== null) return null;
		const windowEndsAt = typeof raw.windowEndsAt === "string" ? raw.windowEndsAt : undefined;
		return { scope: raw.scope, runId: raw.runId ?? null, at: raw.at, ...(windowEndsAt ? { windowEndsAt } : {}) };
	} catch {
		return null;
	}
}

function writeMarker(path: string, marker: LaunchMarker): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
}

/**
 * first-wins 认领 in-flight 窗口（用户裁定 #8）：
 *   wx 排他创建成功 → claimed（本次 spawn），**窗口结束时刻 `windowEndsAt` 同时落盘**；
 *   EEXIST → 读旧 marker：以盘上 `windowEndsAt` 为准（无则按旧 `at`+本次 windowMs 兜底）
 *     窗口内 → 不认领（调用方回 launched(in-flight) 零 spawn）；过期 → 删旧再 wx 一轮；
 *   非 EEXIST 失败（权限/磁盘 IO）→ **fail-closed 不认领**（宁可少开一个 tab；attachment
 *     层 CAS 仍是最终单赢）——与本 JSDoc 同口径（L4 建议修 S1：原实现 fail-open 与注释矛盾）。
 * 任何 IO 异常 never-throw。
 */
export function claimLocalMasterLaunchMarker(
	scope: string,
	opts: { stateDir: string; nowMs: number; windowMs: number },
): { claimed: true; marker: null } | { claimed: false; marker: LaunchMarker } {
	const path = markerPath(scope, opts.stateDir);
	try {
		mkdirSync(dirname(path), { recursive: true });
	} catch {
		/* 目录创建失败交给 openSync 报错 */
	}
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(path, "wx");
			try {
				writeFileSync(
					fd,
					`${JSON.stringify(
						{
							scope,
							runId: null,
							at: new Date(opts.nowMs).toISOString(),
							windowEndsAt: new Date(opts.nowMs + opts.windowMs).toISOString(),
						} satisfies LaunchMarker,
						null,
						2,
					)}\n`,
					"utf8",
				);
			} finally {
				closeSync(fd);
			}
			return { claimed: true, marker: null };
		} catch (e) {
			if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") {
				// 非竞争性写失败（权限/磁盘 ENOTDIR/EACCES/ENOSPC…）→ fail-closed 不认领
				// （L4 建议修 S1：宁可少开一个 tab；attachment 层 CAS 仍是最终单赢）。
				return { claimed: false, marker: { scope, runId: null, at: new Date(opts.nowMs).toISOString() } };
			}
			const existing = tolerantReadMarker(path);
			// 窗口以盘上值为准（S2）：first-wins 的窗口属于「那次 spawn」，不属于后续调用方；
			// 无 windowEndsAt 的旧 marker 按 at + 本次 windowMs 兜底（与旧行为等价）。
			const endMs = existing
				? existing.windowEndsAt
					? Date.parse(existing.windowEndsAt)
					: Date.parse(existing.at) + opts.windowMs
				: NaN;
			if (existing && Number.isFinite(endMs) && opts.nowMs < endMs) {
				return { claimed: false, marker: existing };
			}
			try {
				unlinkSync(path);
			} catch {
				/* 删旧失败 → 下一轮 wx 仍 EEXIST → 不认领 */
			}
		}
	}
	return { claimed: false, marker: tolerantReadMarker(path) ?? { scope, runId: null, at: new Date(opts.nowMs).toISOString() } };
}

/**
 * spawn 成功后回写 runId（同窗口覆盖写；never-throw）。
 * **保留**首次认领落盘的 `windowEndsAt`（否则回写会把窗口重置为「now + 调用方窗口」，
 *  破坏 first-wins——L4 建议修 S2）。
 */
export function updateLocalMasterLaunchMarker(scope: string, runId: string, opts: { stateDir: string; nowMs: number }): void {
	try {
		const path = markerPath(scope, opts.stateDir);
		const prev = tolerantReadMarker(path);
		writeMarker(path, {
			scope,
			runId,
			at: new Date(opts.nowMs).toISOString(),
			...(prev?.windowEndsAt ? { windowEndsAt: prev.windowEndsAt } : {}),
		});
	} catch {
		/* best-effort：marker 只服务防重，不影响回执 */
	}
}

/** 窗口关闭（ready / already-running / spawn-failed）。never-throw。 */
export function clearLocalMasterLaunchMarker(scope: string, stateDir: string): void {
	try {
		rmSync(markerPath(scope, stateDir), { force: true });
	} catch {
		/* best-effort */
	}
}

/** 读 marker（测试/诊断用）。 */
export function readLocalMasterLaunchMarker(scope: string, stateDir: string): LaunchMarker | null {
	return tolerantReadMarker(markerPath(scope, stateDir));
}

// ── 审计（每次调用含被拒；无正文）─────────────────────────────────

export interface EnsureAuditEntry {
	at: string;
	by: string;
	cwd: string;
	scope: string | null;
	action: string;
	result: string;
}

export function ensureAuditPath(stateDir?: string): string {
	return join(stateDir ?? join(defaultRuntimeDir(), "state"), ENSURE_AUDIT_FILE);
}

/** 追加一行审计 {at, by, cwd, scope, action, result}（截断保护 + never-throw）。 */
export function auditLocalMasterEnsure(
	entry: { by: string; cwd: string; scope: string | null; action: string; result: string; at?: string },
	stateDir?: string,
): void {
	try {
		const line: EnsureAuditEntry = {
			at: entry.at ?? new Date().toISOString(),
			by: String(entry.by ?? "unknown").slice(0, 64),
			cwd: String(entry.cwd ?? "").slice(0, 400),
			scope: entry.scope === null || entry.scope === undefined ? null : String(entry.scope).slice(0, 120),
			action: String(entry.action ?? "ensure").slice(0, 40),
			result: String(entry.result ?? "").slice(0, 120),
		};
		const path = ensureAuditPath(stateDir);
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${JSON.stringify(line)}\n`, "utf8");
	} catch {
		/* 审计永不打断主流程（同 master-injections.jsonl 纪律） */
	}
}

/** 读全部审计行（测试/诊断用；容忍坏行）。 */
export function readLocalMasterEnsureAudit(stateDir?: string): EnsureAuditEntry[] {
	try {
		const raw = readFileSync(ensureAuditPath(stateDir), "utf8");
		const out: EnsureAuditEntry[] = [];
		for (const l of raw.split("\n")) {
			if (!l.trim()) continue;
			try {
				out.push(JSON.parse(l) as EnsureAuditEntry);
			} catch {
				/* 坏行跳过 */
			}
		}
		return out;
	} catch {
		return [];
	}
}

// ── spawn 契约 ─────────────────────────────────────────────────────

export interface LocalMasterSpawnArgs {
	/** 调用者会话（links 溯源用）。 */
	sessionId: string;
	cwd: string;
	scope: string;
	agentAddress: ObjectAddress;
	prompt: string;
	taskId: string;
	launchAt: string;
	/**
	 * 续接的会话文件（绝对路径）。undefined ⇒ 全新会话（现状）。
	 * 2026-10-30 owner 裁决：local master 默认续接原 owner 会话。
	 */
	resumeSessionFile?: string;
}

export type LocalMasterSpawn = (args: LocalMasterSpawnArgs) => { runId?: string; error?: string };

export interface LocalMasterEnsureDeps {
	spawn: LocalMasterSpawn;
	/** 毫秒时钟（测试注入 fake clock）。 */
	now?: () => number;
	/** 轮询间隔等待（测试注入；**注入方必须推进 now()**，否则永不超时）。 */
	sleep?: (ms: number) => Promise<void>;
	readAttachment?: (agent: ObjectAddress) => MasterAttachment | null;
	readLiveness?: (scope: string) => ScopeLiveness | null;
	/** 消费进展证据读取（缺省读真实 stateDir；测试注入隔离夹具）。 */
	readConsumeEvidence?: (scope: string) => ScopeConsumeEvidence | null;
	/** 消费证据新鲜度阈值（缺省 CONSUME_FRESH_MS；验收预算可调可测）。 */
	consumeFreshMs?: number;
	isAlive?: (pid: number) => boolean;
	isDirectory?: (cwd: string) => boolean;
	/** 按 sessionId 解出 session 文件绝对路径（缺省无；测试注入）。 */
	findSessionFile?: (sessionId: string) => string | null;
	/** 读会话文件头记录的 cwd（续接硬约束：必须与当前 cwd 一致）；缺省无。 */
	readSessionCwd?: (sessionId: string) => string | null;
	stateDir?: string;
	pollIntervalMs?: number;
}

// ── 续接裁决（纯函数，可单测）────────────────────────────────────

/** 续接裁决结果。`resume` 带可续接的 session 文件；`new` 走全新会话。 */
export type ResumeDecision =
	| { action: "resume"; sessionFile: string; reason: "owner-session-found" }
	| { action: "new"; reason: "no-attachment" | "session-file-missing" | "force-new" | "cwd-mismatch" };

/**
 * 判定 local master 该续接还是新建。**纯函数**，不碰磁盘（所有 IO 由调用方注入）。
 *
 * owner 裁决（2026-10-30）：「local master 本身应当续接；除非我或者 local 自己认为
 * 应当开新的一代并且用户同意了开新而不是压缩」。
 *
 * ⇒ **默认续接**；`forceNew` 是显式例外，调用方只有在**已获得用户同意**后才能传 true。
 * 本函数**绝不自动判定开新**（没有时间窗/上下文长度启发式）。
 *
 * 三个拒绝续接的理由（均回落新建，不报错）：
 * - `no-attachment`：本 scope 无 owner，无历史可续
 * - `session-file-missing`：attachment 存在但 session 文件已丢（清理/迁移），无从续
 * - `cwd-mismatch`：会话记录的 cwd 与当前 cwd 不同。**这是硬约束**：实测 pi 对
 *   `Stored session working directory does not exist` 会直接拒绝启动；即便存在，
 *   续接到跳仓的会话也会把 local master 带到错的目录
 */
export function decideResume(input: {
	ownerSessionId: string | null;
	/** 该 sessionId 对应的 session 文件绝对路径（调用方用 findSessionFile 解析）；null=找不到。 */
	sessionFile: string | null;
	/** 会话文件头记录的 cwd；null=读不出（当作不匹配）。 */
	sessionCwd: string | null;
	/** 当前 cwd（本仓）。 */
	cwd: string;
	/** 人已同意开新一代时为 true（默认 false）。 */
	forceNew?: boolean;
}): ResumeDecision {
	if (input.forceNew === true) return { action: "new", reason: "force-new" };
	if (!input.ownerSessionId) return { action: "new", reason: "no-attachment" };
	if (!input.sessionFile) return { action: "new", reason: "session-file-missing" };
	if (!input.sessionCwd || normalizeCwdKey(input.sessionCwd) !== normalizeCwdKey(input.cwd)) {
		return { action: "new", reason: "cwd-mismatch" };
	}
	return { action: "resume", sessionFile: input.sessionFile, reason: "owner-session-found" };
}

/** Windows 路径比较键：斜杠归一 + 小写 + 去尾斜杠（不碰盘，纯字符串）。 */
export function normalizeCwdKey(p: string): string {
	return p.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

// ── 编排 ───────────────────────────────────────────────────────────

/**
 * 幂等 ensure（详见头注）。不抛：spawn 抛错归 spawn-failed；IO 全部容忍读。
 *
 * 调用方（master-tools 工具 / index.ts slash 命令）负责四层授权与审计行；
 * 本函数只做 precheck → in-flight → spawn → 就绪轮询。
 */
export async function ensureLocalMaster(
	input: { cwd: string; sessionId: string; waitForReady?: boolean; timeoutMs?: number; /** 人已同意开新一代；默认 false=续接 */ forceNew?: boolean },
	deps: LocalMasterEnsureDeps,
): Promise<LocalMasterEnsureResult> {
	const now = deps.now ?? Date.now;
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const readAtt = deps.readAttachment ?? ((agent: ObjectAddress) => readAttachment(agent));
	const readLv = deps.readLiveness ?? ((scope: string) => readScopeLiveness(scope));
	const readEv = deps.readConsumeEvidence ?? ((scope: string) => readConsumeEvidenceFile(scope, { stateDir }));
	const isAlive = deps.isAlive ?? isProcessAlive;
	const isDirectory = deps.isDirectory ?? defaultIsDirectory;
	const stateDir = deps.stateDir ?? join(defaultRuntimeDir(), "state");
	const timeoutMs = clampEnsureTimeout(input.timeoutMs);
	const pollIntervalMs = Math.max(10, deps.pollIntervalMs ?? 250);

	const cwd = typeof input.cwd === "string" ? input.cwd.trim() : "";
	const scope = cwd ? localMasterScope(cwd) : null;
	const agentAddress = scope ? localMasterAddress(scope) : null;

	// 层③参数面：cwd 必须存在且为目录。invalid-cwd 零 spawn、零状态写（此处尚未碰任何状态）。
	if (!cwd || !isDirectory(cwd)) {
		return { status: "invalid-cwd", scope, agentAddress, reason: "cwd-not-directory" };
	}
	const scopeKey = scope!;
	const addr = agentAddress!;

	// ── precheck：活 owner → 已有 owner 分支（幂等零动作；顺手关掉历史 in-flight 窗口）──
	// 0926 P1：「活 owner」≠「消费侧就绪」。身份/PID 全过但**没有新鲜消费证据**时明确降级为
	// consume-unverified（isError）——不自动接管、不强接、不 spawn（零新增权力）。
	const preAtt = readAtt(addr);
	const preLv = readLv(scopeKey);
	if (preAtt && preLv && preLv.sessionId === preAtt.sessionId && preLv.generation === preAtt.generation && isAlive(preLv.pid)) {
		clearLocalMasterLaunchMarker(scopeKey, stateDir);
		const ev = readEv(scopeKey);
		const j = judgeConsumeFresh(ev, {
			sessionId: preAtt.sessionId,
			generation: preAtt.generation,
			nowMs: now(),
			...(deps.consumeFreshMs !== undefined ? { freshMs: deps.consumeFreshMs } : {}),
		});
		const liveness: EnsureLivenessSnapshot = {
			sessionId: preLv.sessionId,
			pid: preLv.pid,
			alive: true,
			updatedAt: preLv.updatedAt,
		};
		if (!j.fresh) {
			return {
				status: "consume-unverified",
				scope: scopeKey,
				agentAddress: addr,
				liveness,
				generation: preAtt.generation,
				reason: `consume-evidence-${j.reason}`,
				consumption: consumptionSnapshot(ev, j),
			};
		}
		return {
			status: "already-running",
			scope: scopeKey,
			agentAddress: addr,
			liveness,
			generation: preAtt.generation,
			consumption: consumptionSnapshot(ev, j),
		};
	}

	// ── in-flight 防重（first-wins；窗口 = 认领时的 timeout+30s，落盘 windowEndsAt 为准）──
	const claim = claimLocalMasterLaunchMarker(scopeKey, {
		stateDir,
		nowMs: now(),
		windowMs: timeoutMs + ENSURE_IN_FLIGHT_EXTRA_MS,
	});
	if (!claim.claimed) {
		return {
			status: "launched",
			scope: scopeKey,
			agentAddress: addr,
			...(claim.marker.runId ? { runId: claim.marker.runId } : {}),
			inFlight: true,
			reason: "in-flight",
		};
	}

	// ── 续接裁决（2026-10-30 owner：local master 默认续接原 owner 会话）──
	// 注意：本块**必须在 in-flight 防重之后**（只有真 spawn 时才需确定续接哪份），
	// 且**绝不能自动判定开新**——forceNew 只来自调用方（人已同意）。
	const preAttForResume = readAtt(addr);
	const resume = decideResume({
		ownerSessionId: preAttForResume?.sessionId ?? null,
		sessionFile: preAttForResume?.sessionId
			? (deps.findSessionFile ?? (() => null))(preAttForResume.sessionId)
			: null,
		sessionCwd: preAttForResume?.sessionId
			? (deps.readSessionCwd ?? (() => null))(preAttForResume.sessionId)
			: null,
		cwd,
		forceNew: input.forceNew === true,
	});

	// ── spawn：可见 tab + bootstrap prompt（不带 token/forceStale/global 指令）──
	const launchAt = new Date(now()).toISOString();
	let spawned: { runId?: string; error?: string };
	try {
		spawned = deps.spawn({
			sessionId: input.sessionId,
			cwd,
			scope: scopeKey,
			agentAddress: addr,
			prompt: resume.sessionFile
				// 续接：bootstrap prompt 追加「续接会话」提示，否则它会以为自己刚 genesis
				? `${buildLocalMasterBootstrapPrompt(scopeKey, addr, cwd)}\n\n── 续接会话 ──\n本会话是**续接**的（原 owner 会话），不是 genesis。你应保留既有对话上下文；但**务必先用 /master-status 核验当前归属行 owner 是你、generation 与 liveness 一致**——历史上下文可能已过时（其他会话可能在这段时间接管过）。以盘上现状为准，不以记忆为准。`
				: buildLocalMasterBootstrapPrompt(scopeKey, addr, cwd),
			taskId: ensureTaskId(scopeKey),
			launchAt,
			...(resume.sessionFile ? { resumeSessionFile: resume.sessionFile } : {}),
		});
	} catch (e) {
		spawned = { error: e instanceof Error ? e.message : String(e) };
	}
	if (spawned.error || typeof spawned.runId !== "string") {
		clearLocalMasterLaunchMarker(scopeKey, stateDir);
		return {
			status: "spawn-failed",
			scope: scopeKey,
			agentAddress: addr,
			...(spawned.runId ? { runId: spawned.runId } : {}),
			detail: spawned.error ?? "spawn returned no runId",
			reason: "spawn-error",
		};
	}
	updateLocalMasterLaunchMarker(scopeKey, spawned.runId, { stateDir, nowMs: now() });
	const runId = spawned.runId;

	if (input.waitForReady === false) {
		return { status: "launched", scope: scopeKey, agentAddress: addr, runId };
	}

	// ── 就绪轮询（launchAt 之前的 liveness 一律不算数）──
	const deadline = now() + timeoutMs;
	const preGen = preAtt ? preAtt.generation : 0; // #A：无 attachment 快照记 0（genesis → 1 恒前进）
	for (;;) {
		const att = readAtt(addr);
		const lv = readLv(scopeKey);
		const v = judgeLocalMasterEnsureReady({
			attachment: att,
			liveness: lv,
			launchAt,
			isAlive,
			claimedFromGeneration: preGen,
			consumeEvidence: readEv(scopeKey),
			...(deps.consumeFreshMs !== undefined ? { consumeFreshMs: deps.consumeFreshMs } : {}),
			nowMs: now(),
		});
		if (v.ready && att && lv) {
			clearLocalMasterLaunchMarker(scopeKey, stateDir);
			const ev = readEv(scopeKey);
			return {
				status: "ready",
				scope: scopeKey,
				agentAddress: addr,
				runId,
				liveness: { sessionId: lv.sessionId, pid: lv.pid, alive: true, updatedAt: lv.updatedAt },
				generation: att.generation,
				...(ev ? { consumption: { state: "fresh", lastTickAt: ev.lastTickAt, tickCount: ev.tickCount } as EnsureConsumptionSnapshot } : {}),
			};
		}
		if (now() >= deadline) {
			const ev = readEv(scopeKey);
			const consumeReason = v.reason?.startsWith("consume-evidence-") ? v.reason.slice("consume-evidence-".length) : null;
			return {
				status: ensureStatusForReason(v.reason),
				scope: scopeKey,
				agentAddress: addr,
				runId,
				reason: v.reason,
				...(att ? { generation: att.generation } : {}),
				...(lv ? { liveness: { sessionId: lv.sessionId, pid: lv.pid, alive: isAlive(lv.pid), updatedAt: lv.updatedAt } } : {}),
				...(consumeReason
					? {
						consumption: consumptionSnapshot(ev, {
							fresh: false,
							reason: consumeReason as ConsumeFreshReason,
						}),
					}
					: {}),
			};
		}
		await sleep(pollIntervalMs);
	}
}

// ── 回执文案（工具与 slash 命令共用）──────────────────────────────

export function formatLocalMasterEnsureResult(r: LocalMasterEnsureResult): string {
	const head = `local-master-ensure ${r.status}`;
	const where = `scope=${r.scope ?? "-"} ${r.agentAddress ?? "-"}`;
	const run = r.runId ? ` runId=${r.runId}` : "";
	switch (r.status) {
		case "already-running":
			return `${head}: ${where} owner=${r.liveness ? sid12(r.liveness.sessionId) : "?"} gen=${r.generation} liveness pid=${r.liveness?.pid} alive 消费证据=${r.consumption?.lastTickAt ?? "-"}（活 master 且消费侧就绪，零动作零 spawn）`;
		case "consume-unverified":
			return `${head}: ${where} owner=${r.liveness ? sid12(r.liveness.sessionId) : "?"} gen=${r.generation} liveness pid=${r.liveness?.pid} alive（进程活着，消费侧未证明，reason=${r.reason}）——不自动接管、不强接、零 spawn；请在该仓开一个会话/session_start（或由该仓会话执行 /master-attach --local），也可由用户执行 /master-attach --local --force-stale --confirm 处置死角（本工具不带该权力）`;
		case "launched":
			return r.inFlight
				? `${head}(in-flight): ${where}${run}（窗口内在途启动，零第二个 spawn）`
				: `${head}: ${where}${run}（可见 tab 已开，等待 session_start 静默认领）`;
		case "ready":
			return `${head}: ${where} owner=${r.liveness ? sid12(r.liveness.sessionId) : "?"} gen=${r.generation} liveness pid=${r.liveness?.pid} alive updated=${r.liveness?.updatedAt}${run}`;
		case "spawn-failed":
			return `${head}: ${where}（${r.detail ?? "unknown"}）——不自动重试；重调用等价手动重试（precheck 幂等）`;
		case "invalid-cwd":
			return `${head}: ${where} 目标目录不存在或不是目录（零 spawn 零状态写）`;
		case "timeout":
			return `${head}: ${where} reason=${r.reason}（会话已开但判据未满足；不杀 tab，窗口到期可重调）${r.liveness ? ` liveness=${r.liveness.sessionId.slice(0, 12)}/gen? pid=${r.liveness.pid}${r.liveness.alive ? " alive" : " dead"} updated=${r.liveness.updatedAt}` : ""}`;
		case "stalled":
			return `${head}: ${where} reason=${r.reason}（判据证据不足，不猜）。指引：人工在该仓开 pi 会话用 /master-status 核查，或由用户走 /master-attach --local --force-stale --confirm 处置死角（本工具不带该权力）`;
	}
}
