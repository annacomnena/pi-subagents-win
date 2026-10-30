/**
 * runtime/session-resume.ts — 「向任意 session 发消息时，会话**确认已死**才把它拉起来」
 *
 * owner 裁决（2026-10-30）：
 *   > 既然我们有了 gui，那么应当允许用户发送消息给任意 session 就拉起这个 session
 *   > 2. 能不能是让 runtime-deamon 操作？然后应当只能由 gui 操作
 *   > 3. 新开一个可见 wt tab。
 *
 * ── 2026-10-30 事故与修正（必读）────────────────────────────────────
 *
 * 首版把 `sessionAlive()` 当成「会话进程活着」用，**完全错了**：
 * `sessionAlive` 的语义是「**最近 15 秒内有过活动**」（读 timers/sessions/<sid>.json
 * 的 `lastActiveAt`，阈值 `SESSION_HEARTBEAT_GRACE_MS = 15_000`）。
 *
 * 后果（owner 实测撞到）：正常对话时，模型思考超过 15 秒 ⇒ 心跳过期 ⇒ 判 dead
 * ⇒ **每发一条消息就拉起一个新 tab**。这不是「偶尔误判」，是稳定复现的功能性故障。
 *
 * 修正原则：**「不是确定的活」不等于「死」**。拉起窗口是有副作用的动作
 * （在用户桌面上开可见窗口、可能重复消耗额度），必须用**强证据**触发：
 *   - 只有**观测到该会话的活进程**才算 `alive`（不自伤）
 *   - 「心跳过期」「查不到 pid」这类**弱信号/缺证据**一律当作 `unknown` ⇒ **不拉起**
 *   - 只有**明确判定无活进程**（枚举进程表后确证没有该 sessionId 的 pi 进程）才算 `dead`
 *
 * 这与本仓既有纪律同源：**判不了 = 不动**（`judgeScopeOwnerStale` 的 `skip:no-liveness`
 * 是同一条原则）。
 */

/**
 * 会话存活三态。**三态而不是两态**是本次修正的核心：
 * 把「缺证据」从「死」里拆出来，否则弱信号会触发有副作用的动作。
 */
export type SessionLiveness = "alive" | "dead" | "unknown";

/** 拉起裁决。 */
export type ResumeDecision =
	| { action: "send"; reason: "session-alive" | "liveness-unknown" }
	| { action: "spawn-then-send"; sessionFile: string; reason: "session-dead" }
	| { action: "reject"; reason: "no-session" | "spawn-not-permitted" | "cwd-missing" };

/**
 * 判定「发消息给某会话」时该怎么做。**纯函数**。
 *
 * @param sessionFile  目标会话文件绝对路径；null = 找不到该会话
 * @param liveness     会话进程存活三态（**必须是真进程证据，不是心跳新鲜度**）
 * @param sessionCwd   会话记录里的 cwd；null = 读不出
 * @param cwdExists    cwd 是否仍存在（硬约束：pi 对不存在的 cwd 直接拒启）
 * @param permitted    调用方是否有拉起权限（GUI + trustedLocal + guiEnabled）
 */
export function decideSendAction(input: {
	sessionFile: string | null;
	liveness: SessionLiveness;
	sessionCwd: string | null;
	cwdExists: (cwd: string) => boolean;
	permitted: boolean;
}): ResumeDecision {
	// ① 无会话文件：无从拉起，也发不出去（既有行为：reject "no-session"）
	if (!input.sessionFile) return { action: "reject", reason: "no-session" };

	// ② 活着：走现状（写 outbox，等它自己消费）。零行为变化。
	if (input.liveness === "alive") return { action: "send", reason: "session-alive" };

	// ③ **缺证据（unknown）⇒ 只发不拉。**
	//    这是 2026-10-30 事故的直接修复点：心跳过期/查不到 pid 属于弱信号，
	//    不足以支撑「拉起一个窗口」这种有副作用的动作。
	//    代价：真死掉的会话在证据不足时不会自动拉起（用户重发一次或手动开）。
	//    收益：绝不会在正常对话中反复拉起新 tab。
	if (input.liveness === "unknown") return { action: "send", reason: "liveness-unknown" };

	// ④ 确证死亡：要拉起 ⇒ 必须过权限门。
	//    拉起是**新能力**（副作用：在用户桌面上开一个可见窗口），
	//    比"给已存在的会话发一条消息"重，所以单独门控，不复用既有 token 的隐含授权。
	if (!input.permitted) return { action: "reject", reason: "spawn-not-permitted" };

	// ⑤ cwd 不存在 ⇒ pi 会拒绝启动（实测 `Stored session working directory does not exist`）。
	//    这种情况下**不拉起**：如实拒绝，让 GUI 显示「会话的工作目录已不存在」，
	//    而不是开一个立刻失败的窗口。
	if (!input.sessionCwd || !input.cwdExists(input.sessionCwd)) {
		return { action: "reject", reason: "cwd-missing" };
	}

	return { action: "spawn-then-send", sessionFile: input.sessionFile, reason: "session-dead" };
}

/**
 * 拉起权限门的单一事实源。
 *
 * owner 裁决「应当只能由 gui 操作」：
 * - **GUI 面**：`trustedLocal` + `guiEnabled`（与既有 `session.message` 三证据同源）
 * - **微信端天然够不到**：它只能与 global 通信，不发 `session.message`
 *
 * 单独抽成函数是为了让「权限口径只有一处」，避免将来两个调用点各写一份判断
 * （`tab-runs.ts` 的 mode 硬编码漂移就是同类教训）。
 */
export function isSpawnPermitted(policy: {
	trustedLocal?: boolean;
	guiEnabled?: boolean;
} | null | undefined): boolean {
	return policy?.trustedLocal === true && policy?.guiEnabled === true;
}

/**
 * 从「进程表枚举结果」推导会话存活三态。**纯函数**。
 *
 * @param verdict  枚举结论：
 *   - `has-live-process`：确证存在带该 sessionId 的 pi 进程
 *   - `no-live-process`：枚举成功且**确证没有**该会话的进程
 *   - `probe-unavailable`：枚举失败/平台不支持（**不得当作死**）
 *
 * 之所以要调用方传入枚举结论而不是自己查：保持纯函数可单测，
 * 且进程枚举的实现（PowerShell CIM / ps）留在 I/O 边界。
 */
export function livenessFromProbe(
	verdict: "has-live-process" | "no-live-process" | "probe-unavailable",
): SessionLiveness {
	if (verdict === "has-live-process") return "alive";
	if (verdict === "no-live-process") return "dead";
	return "unknown"; // 探不到 ≠ 已死（AGENTS §0）
}

/** 拉起参数的形状（调用方据此 spawn 可见 WT tab）。 */
export interface SpawnSessionTabArgs {
	/** 要拉起的会话文件绝对路径。 */
	sessionFile: string;
	/** 会话的工作目录（spawn 的 cwd）。 */
	cwd: string;
	/** 标签页标题。 */
	title: string;
}

/** 标签页标题：`resume <sessionId 前 8 位>`（可读 + 不泄露完整 id）。 */
export function resumeTabTitle(sessionId: string): string {
	const short = String(sessionId ?? "").trim().slice(0, 8);
	return short ? `resume ${short}` : "resume session";
}
