/**
 * identity — 会话身份判定（flag 优先，env 兜底）
 *
 * 标签页身份通过 pi CLI flag `--tab-run-id <runId>` 传递（可靠，不依赖
 * wt.exe 的 env 继承——Windows 下 env 透传并不可靠，这正是"回报投错
 * 标签页"的根因）；env PI_TAB_RUN_ID 保留作向后兼容兜底。
 *
 * 时序注意：CLI flag 值由 pi 在扩展加载完成后写入 runtime.flagValues，
 * 所以不能在扩展工厂内立即 getFlag（拿不到）。这里保留 pi 引用，
 * getTabRunId() 每次调用时惰性读取——事件回调/工具执行时值早已就绪。
 *
 * 判定：
 *   - getTabRunId()  → 当前进程是否是一个已派发的标签页（有身份）
 *   - isMainSession()→ 无标签页身份 且 非子 agent（主会话，唯一消费者）
 *   - isSubagent()   → PI_SUBAGENT=1
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const FLAG_NAME = "tab-run-id";

let cachedPi: ExtensionAPI | null = null;

/** 当前进程的会话 UUID（session_start 时由 ctx.sessionManager 捕获）。 */
let currentSessionId: string | undefined;

/** session_start 时写入当前会话 UUID（标签页/子 agent 也会写入，但消费侧另有身份门槛）。 */
export function setCurrentSessionId(id: string | undefined): void {
	currentSessionId = id && id.length ? id : undefined;
}

/** 当前进程的会话 UUID（无 → undefined）。 */
export function getCurrentSessionId(): string | undefined {
	return currentSessionId;
}

/** 会话目录键（跨进程唯一身份）：tab_<runId> 或 sessionId；无身份 → undefined。 */
export function sessionScopeKey(): string | undefined {
	const tab = getTabRunId();
	if (tab) return tab;
	const sid = getCurrentSessionId();
	return sid && sid.length ? sid : undefined;
}

/** 扩展入口调用：注册 flag 并保留 pi 引用（值在 getTabRunId 时惰性读取）。 */
export function registerIdentityFlag(pi: ExtensionAPI): string | undefined {
	cachedPi = pi;
	try {
		pi.registerFlag(FLAG_NAME, {
			description: "标签页回收身份（launch-tabs 派发时注入）：该 pi 实例是哪个 runId 的标签页",
			type: "string",
			default: "",
		});
	} catch {
		/* flag 注册失败则退回 env */
	}
	// 工厂内 flag 值尚未就绪，这里不读；返回 env 兜底值（若有）
	return envTabRunId();
}

function envTabRunId(): string | undefined {
	const v = process.env.PI_TAB_RUN_ID;
	return v && v.trim() ? v.trim() : undefined;
}

/** 当前进程的标签页 runId（flag 优先，env 兜底；无则 undefined）。惰性读取。 */
export function getTabRunId(): string | undefined {
	if (cachedPi) {
		try {
			const fromFlag = cachedPi.getFlag(FLAG_NAME);
			if (typeof fromFlag === "string" && fromFlag.trim()) return fromFlag.trim();
		} catch {
			/* flag 不可用则退回 env */
		}
	}
	return envTabRunId();
}

/** 是否子 agent 进程。 */
export function isSubagent(): boolean {
	return process.env.PI_SUBAGENT === "1";
}

/** 是否主会话（唯一消费者：无标签页身份且非子 agent）。 */
export function isMainSession(): boolean {
	return !getTabRunId() && !isSubagent();
}

/** 标签页身份判断（供 tab 侧遥测/工具注册）：是标签页且非子 agent。 */
export function isTabSession(): boolean {
	return Boolean(getTabRunId()) && !isSubagent();
}
