/**
 * runtime/autonomy/gate.ts — Autonomy Suite v2 L2 装配层：唤醒总门（Task 2006 · plans/0923_autonomy_suite_v2_plan.md）。
 *
 * - 唯一生产入口：wake.ts evaluateWakes 在 owner 门后、ws 遍历前调用 evaluateAutonomyWakeGate
 *   （D-A：套件级门；cutover off / non-owner 提前返回，不触本层——省 IO）。
 * - D-E 默认 no-op：cfg.enabled !== true → 完全旁路（不读 kill、不评估 wake-gate、不审计、
 *   不写任何文件）；唯一额外成本 = 每 tick 一次 config.json 读。kill 文件仅在 enabled===true
 *   时被唤醒路径消费——kill 是 autonomy 套件内灭火开关（gating 套件内 kill > enabled > active，
 *   kill-switch.ts:83），不是唤醒循环总开关；紧急停 legacy 唤醒的既有手段 = /master-cutover off。
 * - enabled 模式 fail-closed：collect 失败 → gating inactive（collect-failed）→ wake-gate no-wake 压制；
 *   装配层自身崩溃（不应发生）→ fail-open 走 legacy（"autonomy 永不破坏唤醒循环"，与 tick 级 catch 同精神）。
 *   二者不对称的理由：前者在显式 opt-in 模式内（其决策机器失败 → 不自动行动）；后者在无法判定
 *   模式时保住 v2 之前既有的安全行为（D-E，R7 文档化）。
 * - 红线延续（C1/C4）：只经 collect.ts/kill-switch.ts/config.ts 的既有窄 IO 面写自有 namespace；
 *   本层不直接 import node:fs（"批量 IO 只在 collect.ts"的 v1 约束延续）；不 claim/不 spawn/不 ack。
 * - 学术诚实：所有审计行 acted=false——wake=true 只放行既有 legacy 唤醒链（该链 v2 之前已存在，
 *   受 cutover/owner/policy/cooldown/maxSpawns/in-flight 门管辖）；v2 不新增任何自动动作。
 */
import { readAutonomyConfig } from "./config.ts";
import {
	appendAuditEvent,
	collectAutonomyInputs,
	readWakeGateState,
	writeNoticeAckKeys,
	writeWakeGateState,
} from "./collect.ts";
import type { FrontierDiff } from "./frontier.ts";
import { noticeAckKey } from "../expectations.ts";
import { evaluateAutonomyGating, readKillSwitch } from "./kill-switch.ts";
import { evaluateWakeGate, type WakeGateState } from "./wake-gate.ts";

export interface AutonomyGateDecision {
	/** true = autonomy 模式 engaged（本门有决策权）；false = 旁路（disabled）或 fail-open（gate-error）。 */
	engaged: boolean;
	/** true = 放行既有 legacy 唤醒链；false = 压制（kill / collect-failed / wake-gate no-wake）。 */
	proceed: boolean;
	reason: string;
}

/** 进程内 per-reason 去重（仿 wake.ts auditedSkip，防 30s tick 刷屏）：kill 压制行内容恒定；
 *  去重后进程重启/理由变化各再落一行。gate-error 审计并入此去重（D-E）。 */
const auditedGating = new Set<string>();

/**
 * D-G debounce 锚点维护（v1 wake-gate.ts 注释"由 L2 装配层维护"在此落实）。
 *
 * ## 2026-11-01 修正：原实现会让锚点永久卡死
 *
 * 原式：
 * ```
 * const hasDiff = triggers.length > 0 || recordOnly.length > 0;
 * return { ...state, batchFirstSeenAt: hasDiff ? (state.batchFirstSeenAt ?? now) : null };
 * ```
 * `?? now` ⇒ **只在 batchFirstSeenAt===null 时置一次，之后永不刷新**。
 * 而生产路径 `recordOnly` 几乎恒非空（`RECORD_ONLY_NOCARRIER` 常量，只在 expectations
 * 账本不存在时才 3 条 / 存在时 2 条，都 >0）⇒ `hasDiff` 恒为 true ⇒ 重置分支永不执行
 * ⇒ 锚点永久停在首次值。
 *
 * **真机实测**：`batchFirstSeenAt` 卡在 `2026-09-25T10:40:10Z` 共 **36.2 天** ——
 * 这就是「累积阈值逻辑写着但不推进」的直接证据。
 *
 * ## 改法：按 **diff 指纹**刷新，而不是按「有没有 diff」
 *
 * 锚点的语义是「**当前这批待处理变化是什么时候出现的**」。所以只要指纹变了，
 * 就是新一批 ⇒ 重置锚点为 now；指纹不变 ⇒ 继续累积（这才是 debounce 要的效果）。
 *
 * 指纹只取**有判别力的字段**：rule + project + evidence + approximate。
 * - 不含 `runId` / `requestRev`：它们在同一条触发反复出现时会变（如 blocked_overdue
 *   每帧选最重 runId），把它们算进指纹会让「同一件事」被当成「新一批」。
 * - `recordOnly` 也进指纹：它变了说明载体/账本可用性变了，属于真实变化。
 *
 * 纯函数（无 IO）。旧签名保持向后兼容（新增可选第三参 `prevFingerprint`）。
 */
export function maintainBatchAnchor(
	state: WakeGateState & { lastDiffFingerprint?: string | null },
	diff: FrontierDiff,
	now: number,
): WakeGateState & { lastDiffFingerprint?: string | null } {
	const hasDiff = diff.triggers.length > 0 || diff.recordOnly.length > 0;
	if (!hasDiff) {
		// diff 全空 ⇒ 无待处理变化，锚点归零（下一批重新计时）
		return { ...state, batchFirstSeenAt: null, lastDiffFingerprint: null };
	}
	const fingerprint = diffFingerprint(diff);
	const sameBatch = state.batchFirstSeenAt !== null && state.lastDiffFingerprint === fingerprint;
	if (sameBatch) return state; // 同一批 ⇒ 保持原锚点（这才是 debounce）
	// 新一批 ⇒ 重置锚点
	return { ...state, batchFirstSeenAt: now, lastDiffFingerprint: fingerprint };
}

/**
 * diff 指纹：只取有判别力的字段，**排序后再拼**（triggers 顺序不得影响指纹）。
 *
 * 为什么不含 runId / requestRev：同一条触发反复出现时它们会变（blocked_overdue 每帧
 * 选最重 runId），算进指纹会让「同一件事」每帧都被当成新一批 ⇒ 锚点每帧重置
 * ⇒ debounce 彻底失效（反向的 bug）。
 */
export function diffFingerprint(diff: FrontierDiff): string {
	const t = diff.triggers
		.map((x) => `${x.rule}|${x.project}|${x.evidence}|${x.approximate ? 1 : 0}`)
		.sort()
		.join(";");
	const r = [...diff.recordOnly].sort().join(";");
	return `T:${t}//R:${r}`;
}

/**
 * v2 唤醒总门（每 tick 一次；never-throw：任何异常收敛为 fail-open legacy）。
 *
 * opts.configPath / agentDir 为 test-only 注入面（生产 wake.ts 只传 stateDir + now + autonomyConfigPath，
 * 后者缺省 = 包根 config.json）：不注入则 enabled 路径读真实 ~/.pi/agent（defaultAgentDir 不受
 * PI_RUNTIME_DIR 隔离，global-view.ts:156）且 collect 无参双读真实包根 config（工程约束 3）。
 */
export function evaluateAutonomyWakeGate(opts?: {
	stateDir?: string;
	configPath?: string;
	agentDir?: string;
	/** test-only：不传 = defaultMailboxDir()（生产行为逐字节不变）。 */
	mailboxDir?: string;
	now?: number;
}): AutonomyGateDecision {
	try {
		const cfg = readAutonomyConfig({ configPath: opts?.configPath });
		// D-E：enabled !== true → 完全旁路（无 kill 读、无判定事件、无审计、零写盘）。
		// "默认关闭零留痕"与此处的裁决：默认态不存在判定事件，故无行可落（D-H 张力裁决）。
		if (cfg.enabled !== true) return { engaged: false, proceed: true, reason: "autonomy-disabled" };

		const kill = readKillSwitch({ stateDir: opts?.stateDir });
		const gating = evaluateAutonomyGating(cfg, kill);
		if (!gating.active) {
			// 套件内 kill > enabled：最高门（fail-closed 压制）
			if (!auditedGating.has(gating.reason)) {
				auditedGating.add(gating.reason);
				appendAuditEvent("gating", "no-wake", gating.reason, opts?.stateDir);
			}
			return { engaged: true, proceed: false, reason: gating.reason };
		}

		const now = opts?.now ?? Date.now();
		const inputs = collectAutonomyInputs({ stateDir: opts?.stateDir, configPath: opts?.configPath, agentDir: opts?.agentDir, mailboxDir: opts?.mailboxDir, now });
		// never-throw；内部已产 v1 审计行 + frontier 快照。configPath/agentDir 全透传：否则 collect
		// 无参 readAutonomyConfig() 双读真实包根 config → 判定分叉 + 误导性 "gating no-wake
		// reason=autonomy-disabled" 杂行（工程约束 3 / W6 断言）。
		const gating2 = inputs.gating.active ? inputs.gating : gating; // 计划伪码原式：collect 内部 kill 复评优先
		const diff = inputs.frontier?.diff ?? { triggers: [], recordOnly: [], meaningfulChanges: 0 };
		const state = readWakeGateState({ stateDir: opts?.stateDir }) ?? { lastDecisionAt: null, lastWakeAt: null, batchFirstSeenAt: null };
		const anchored = maintainBatchAnchor(state, diff, now);
		const decision = evaluateWakeGate({ gating: gating2, diff, state: anchored, cfg: cfg.wakeGate, now });
		// ⑧ wake 级 ack（0928 P2，r9）：wake 放行后才 ack——本帧 ⑧ 触发对应的期望记为「已处理」，
		// 此后 frontier 不再为该 (id,rev) 出触发（attention 条目仍在，level 出口）。cooldown 窗内
		// decision.wake=false → 不 ack → 下一帧触发仍在 → 边沿不丢。红线延续：只写自有命名空间、
		// IO 只经 collect.ts 窄 helper（本层不 import node:fs）。
		if (decision.wake) {
			const ackKeys = diff.triggers
				.filter((t) => t.rule === "expected_event_timeout" && typeof t.requestId === "string")
				.map((t) => noticeAckKey(t.requestId!, t.requestRev ?? 0));
			if (ackKeys.length > 0) writeNoticeAckKeys(ackKeys, { stateDir: opts?.stateDir });
		}
		// 任务书目标 4 字面执行：engaged 模式每次判定落一行（含 no-wake）；体积代价见 R5（本批不补轮转）。
		appendAuditEvent("wake", decision.wake ? "wake" : "no-wake", decision.reason, opts?.stateDir);
		writeWakeGateState(
			{ ...anchored, lastDecisionAt: now, lastWakeAt: decision.wake ? now : anchored.lastWakeAt, lastReason: decision.reason },
			{ stateDir: opts?.stateDir },
		);
		return { engaged: true, proceed: decision.wake, reason: decision.reason };
	} catch (e) {
		// fail-open：装配层崩溃不应破坏既有唤醒循环（区别于 collect-failed 的 opt-in 模式内 fail-closed）
		const reason = `gate-error:${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`;
		if (!auditedGating.has(reason)) {
			auditedGating.add(reason);
			appendAuditEvent("gating", "pass", reason, opts?.stateDir);
		}
		return { engaged: false, proceed: true, reason: "gate-error" };
	}
}
