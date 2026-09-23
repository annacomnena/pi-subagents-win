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
	writeWakeGateState,
} from "./collect.ts";
import type { FrontierDiff } from "./frontier.ts";
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
 * D-G debounce 锚点维护（v1 wake-gate.ts 注释"由 L2 装配层维护"在此落实）：
 * 本帧 diff 有内容（triggers 或 recordOnly）且 batchFirstSeenAt===null → 置 now；
 * diff 全空 → 重置 null。（生产路径 recordOnly 恒非空——frontier.ts:281 ④⑥⑧ no-carrier 常量每帧
 *  输出——重置分支在 collect 路径休眠，由 W4.4 单测直测钉死。）
 * 纯函数（无 IO）：lastDecisionAt/lastWakeAt/lastReason 由调用方在 writeWakeGateState 时更新。
 */
export function maintainBatchAnchor(state: WakeGateState, diff: FrontierDiff, now: number): WakeGateState {
	const hasDiff = diff.triggers.length > 0 || diff.recordOnly.length > 0;
	return { ...state, batchFirstSeenAt: hasDiff ? (state.batchFirstSeenAt ?? now) : null };
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
		const inputs = collectAutonomyInputs({ stateDir: opts?.stateDir, configPath: opts?.configPath, agentDir: opts?.agentDir, now });
		// never-throw；内部已产 v1 审计行 + frontier 快照。configPath/agentDir 全透传：否则 collect
		// 无参 readAutonomyConfig() 双读真实包根 config → 判定分叉 + 误导性 "gating no-wake
		// reason=autonomy-disabled" 杂行（工程约束 3 / W6 断言）。
		const gating2 = inputs.gating.active ? inputs.gating : gating; // 计划伪码原式：collect 内部 kill 复评优先
		const diff = inputs.frontier?.diff ?? { triggers: [], recordOnly: [], meaningfulChanges: 0 };
		const state = readWakeGateState({ stateDir: opts?.stateDir }) ?? { lastDecisionAt: null, lastWakeAt: null, batchFirstSeenAt: null };
		const anchored = maintainBatchAnchor(state, diff, now);
		const decision = evaluateWakeGate({ gating: gating2, diff, state: anchored, cfg: cfg.wakeGate, now });
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
