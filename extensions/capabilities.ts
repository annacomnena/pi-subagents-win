/**
 * capabilities — 会话能力矩阵（session profile → capability gate）
 *
 * trace-fusion-loop 设计稿 §6/§54：subagent-win 承载四类会话身份，
 * 各自拥有不同的能力面（workflow / lite / launch-tabs / 角色委派 /
 * timer 编排 / 直接执行）。身份判定沿用 identity.ts 的双轨经验：
 * CLI flag 是 authoritative source，env 是兜底；flag 值在扩展加载
 * 完成后才可读，所有消费点必须惰性读取（同 getTabRunId 的时序约束）。
 *
 * Profile 判定优先级（惰性，每次调用都重读）：
 *   1. flag --session-profile（trace-fusion 派发时注入；Commit 4 接线）
 *   2. env PI_SESSION_PROFILE（显式声明兜底 / 调试）
 *   3. identity 推导：PI_SUBAGENT=1 → subagent；有 tab-run-id → workflow-tab；否则 main
 *
 * 行为兼容性：Commit 1 阶段矩阵与现有 isMainSession/isTabSession/isSubagent
 * 判定完全等价——trace-worker 检测处于休眠态（flag 未在入口注册、env 无人
 * 设置，只能命中推导分支 main/workflow-tab/subagent）。后续提交在
 * subagent-win.execute / before_agent_start / resources_discover /
 * /lite / /launch 接入硬 guard 时，语义变化由 Commit 4 承担并更新测试。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isSubagent, isTabSession } from "./identity.ts";

/** 会话身份：主会话 / workflow 任务标签页 / trace-fusion worker / 无头子 agent。 */
export type SessionProfile = "main" | "workflow-tab" | "trace-worker" | "subagent";

/** 单个 profile 的能力面。字段缺失语义见 CAPS 注释。 */
export interface SessionCapabilities {
	/** 是否允许编排/加载 Full workflow（含 workflow-orchestrator skill）。 */
	workflow: boolean;
	/** 是否允许 Lite 工作流语义（/lite 与 lite 链注入）。 */
	lite: boolean;
	/** 是否允许 launch-tabs / /launch（tab 编排只属于 main）。 */
	launchTabs: boolean;
	/** 可委派的角色 agent："*" 全部；列表 = 白名单；空数组 = 禁止一切委派。 */
	delegateAgents: "*" | string[];
	/** 是否允许 timer 编排（set-timer / cancel-timer / list-timers）。 */
	timerOrchestration: boolean;
	/** 是否允许直接动手（edit/write/build/test）。 */
	directExecution: boolean;
}

/** 能力矩阵（设计稿 §54）。改字段必须同步更新 _test_capabilities.ts 快照断言。 */
const CAPS: Record<SessionProfile, SessionCapabilities> = {
	main: {
		workflow: true,
		lite: true,
		launchTabs: true,
		delegateAgents: "*",
		timerOrchestration: true,
		directExecution: true,
	},
	"workflow-tab": {
		workflow: true,
		lite: false,
		launchTabs: false,
		delegateAgents: ["searcher", "planner", "plan-reviewer", "implementer", "code-reviewer", "consultant"],
		timerOrchestration: false,
		directExecution: false,
	},
	"trace-worker": {
		workflow: false,
		lite: false,
		launchTabs: false,
		// 设计稿 §8/§55：trace worker 只能委派窄化的 searcher；禁止 agent omitted。
		delegateAgents: ["searcher"],
		timerOrchestration: false,
		directExecution: true,
	},
	subagent: {
		workflow: false,
		lite: false,
		launchTabs: false,
		delegateAgents: [],
		timerOrchestration: false,
		directExecution: true,
	},
};

const PROFILE_FLAG = "session-profile";
const TRACE_RUN_FLAG = "trace-run-id";
const TRACE_LANE_FLAG = "trace-lane";
const PROFILE_ENV = "PI_SESSION_PROFILE";

let cachedPi: ExtensionAPI | null = null;

/**
 * 扩展入口调用：注册 session-profile flag 并保留 pi 引用。
 * 与 identity.registerIdentityFlag 同一时序约束——工厂内 flag 值未就绪，
 * 这里只注册，不读取；消费点（currentProfile）惰性读取。
 * Commit 4 起在 index.ts 工厂接线；Commit 1 仅提供函数与测试覆盖。
 */
export function registerCapabilityFlags(pi: ExtensionAPI): void {
	cachedPi = pi;
	try {
		pi.registerFlag(PROFILE_FLAG, {
			description:
				"会话身份（trace-fusion-loop 派发时注入）：main | workflow-tab | trace-worker | subagent；flag 优先于 env PI_SESSION_PROFILE",
			type: "string",
			default: "",
		});
	} catch {
		/* flag 注册失败则退回 env / identity 推导 */
	}
	// C6：trace run/lane 身份旗标（派发时注入 worker tab；不注册会导致 worker 在
	// CLI 解析时死于未知选项）。supervisor 侧不经此读取——meta.json 是真相源。
	for (const [flag, desc] of [
		[TRACE_RUN_FLAG, "trace-fusion run 身份（trace-fusion-loop 派发时注入 worker tab）"],
		[TRACE_LANE_FLAG, "trace lane：A | B | C（trace-fusion-loop 派发时注入 worker tab）"],
	] as const) {
		try {
			pi.registerFlag(flag, { description: desc, type: "string", default: "" });
		} catch {
			/* 同上：env 兼容 */
		}
	}
}

function normalizeProfile(v: unknown): SessionProfile | undefined {
	return v === "main" || v === "workflow-tab" || v === "trace-worker" || v === "subagent" ? v : undefined;
}

/** 当前进程的会话 profile（惰性：flag → env → identity 推导）。 */
export function currentProfile(): SessionProfile {
	if (cachedPi) {
		try {
			const fromFlag = normalizeProfile(cachedPi.getFlag(PROFILE_FLAG));
			if (fromFlag) return fromFlag;
		} catch {
			/* flag 不可用则退回 env */
		}
	}
	const fromEnv = normalizeProfile(process.env[PROFILE_ENV]);
	if (fromEnv) return fromEnv;
	if (isSubagent()) return "subagent";
	if (isTabSession()) return "workflow-tab";
	return "main";
}

/** 当前（或指定）profile 的能力面。 */
export function capabilities(profile?: SessionProfile): SessionCapabilities {
	return CAPS[profile ?? currentProfile()];
}

/** trace run 身份读取（flag > env PI_TRACE_RUN_ID；空串视同未设）。worker tab 诊断用。 */
export function traceRunId(): string | undefined {
	const read = (): string | undefined => {
		if (cachedPi) {
			try {
				const v = String(cachedPi.getFlag(TRACE_RUN_FLAG) ?? "").trim();
				if (v) return v;
			} catch {
				/* flag 不可用则退回 env */
			}
		}
		const env = (process.env.PI_TRACE_RUN_ID ?? "").trim();
		return env || undefined;
	};
	return read();
}

/** trace lane 读取（flag > env PI_TRACE_LANE；仅认 A/B/C）。 */
export function traceLane(): "A" | "B" | "C" | undefined {
	const read = (): "A" | "B" | "C" | undefined => {
		let v = "";
		if (cachedPi) {
			try {
				v = String(cachedPi.getFlag(TRACE_LANE_FLAG) ?? "").trim();
			} catch {
				/* flag 不可用则退回 env */
			}
		}
		if (!v) v = (process.env.PI_TRACE_LANE ?? "").trim();
		return v === "A" || v === "B" || v === "C" ? v : undefined;
	};
	return read();
}

/** 是否允许向指定角色 agent 委派（subagent-win.execute 的 agent 白名单 gate）。 */
export function canDelegateAgent(name: string, profile?: SessionProfile): boolean {
	const d = capabilities(profile).delegateAgents;
	return d === "*" || d.includes(name);
}

/** 是否 trace worker（Commit 4 的 hard guard 消费点）。 */
export function isTraceWorker(): boolean {
	return currentProfile() === "trace-worker";
}

/** 是否 workflow 任务标签页。 */
export function isWorkflowTab(): boolean {
	return currentProfile() === "workflow-tab";
}

/**
 * 委派白名单 gate（设计稿 §55，subagent-win.execute 消费）：
 * 非主会话按 profile 白名单校验；trace worker 只允许 agent=searcher，
 * 且 **agent omitted 必须拒绝**（omitted 会变成 unrestricted child）。
 * 纯函数，单测锁定；返回 { ok:false, reason } 时调用方直接拒绝派发。
 */
export function assertDelegationAllowed(
	requestedAgents: string[],
	profile?: SessionProfile,
): { ok: true } | { ok: false; reason: string } {
	const p = profile ?? currentProfile();
	if (p === "main") return { ok: true };
	const requested = requestedAgents.map((a) => (typeof a === "string" ? a.trim() : ""));
	if (requested.length === 0 || requested.some((a) => !a)) {
		return { ok: false, reason: `agent omitted 会变成 unrestricted child；当前 profile "${p}" 必须显式指定白名单内 agent` };
	}
	const denied = requested.filter((a) => !canDelegateAgent(a, p));
	if (denied.length > 0) {
		const allowed = capabilities(p).delegateAgents;
		return {
			ok: false,
			reason: `当前 profile "${p}" 只允许委派 ${JSON.stringify(allowed)}；被拒：${[...new Set(denied)].join(", ")}`,
		};
	}
	return { ok: true };
}
