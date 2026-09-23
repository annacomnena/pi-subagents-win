/**
 * runtime/master-session-cwd.ts — 会话启动 cwd 快照（0923 home 守卫配套）。
 *
 * 解决“仓库会话 cd 到 home 冒充 home 会话”：session_start 最早时按持久
 * session UUID 记录 initialCwd；slash/tool 要求 initialCwd 与当前 cwd
 * 两者都是 home。首写优先（first-wins）——严禁从后来变化的 cwd 回填；
 * 缺快照（热重载、恢复旧会话、事件顺序不确定）调用方 fail closed。
 * 记录生命周期跟随 session shutdown/切换清理。
 *
 * 纯内存、无 IO；cwd 来源由调用方（session-hooks）从可信 Pi ctx 传入。
 */

const startCwdBySession = new Map<string, string>();

/** session_start 记录：同 UUID 已有快照则保留最早值（不覆盖）。 */
export function recordSessionStartCwd(sessionId: string, cwd: string): void {
	if (!sessionId || sessionId === "unknown") return;
	if (typeof cwd !== "string" || !cwd) return;
	if (!startCwdBySession.has(sessionId)) startCwdBySession.set(sessionId, cwd);
}

/** 守卫读取：无快照 → null（调用方必须拒绝，不得回填放行）。 */
export function readSessionStartCwd(sessionId: string): string | null {
	return startCwdBySession.get(sessionId) ?? null;
}

/** 清理：指定会话或（无参时）全部。session shutdown/切换时调用。 */
export function clearSessionStartCwd(sessionId?: string): void {
	if (sessionId) startSessionCleanup(sessionId);
	else startCwdBySession.clear();
}

function startSessionCleanup(sessionId: string): void {
	startCwdBySession.delete(sessionId);
}
