/**
 * runtime/session-resume.ts — 「向任意 session 发消息时，会话不在就把它拉起来」
 *
 * owner 裁决（2026-10-30）：
 *   > 既然我们有了 GUI，那么应当允许用户发送消息给任意 session 就拉起这个 session
 *   > —— 避免只能让 global 打开这个 session
 *   > 2. 能不能是让 runtime-deamon 操作？然后应当只能由 gui 操作
 *   > 3. 新开一个可见 wt tab。这样用户想去 wt 中看也行想在 gui 继续说话也行
 *
 * 现状（实测）：`session.message` 已存在（`POST /v1/commands`，`pi://<sid>`），
 * 但只是**写 outbox**，然后依赖目标会话进程活着去消费（fs.watch / tick）。
 * 会话死了 ⇒ 消息躺在 outbox 里，24h 后转 expired。**消息收了，但没人读。**
 *
 * 本模块只做**纯判定**；真正 spawn 由调用方（daemon）注入，
 * 保持纯函数可单测、不碰盘、不 spawn。
 */

/** 会话当前是否可投递。 */
export type SessionLiveness = "alive" | "dead";

/** 拉起裁决。 */
export type ResumeDecision =
	| { action: "send"; reason: "session-alive" }
	| { action: "spawn-then-send"; sessionFile: string; reason: "session-dead" }
	| { action: "reject"; reason: "no-session" | "spawn-not-permitted" | "cwd-missing" };

/**
 * 判定「发消息给某会话」时该怎么做。**纯函数**。
 *
 * @param sessionFile  目标会话文件绝对路径；null = 找不到该会话（`no-session`）
 * @param liveness     进程是否活着
 * @param sessionCwd   会话记录里的 cwd；null = 读不出
 * @param cwdExists    cwd 是否仍存在（**硬约束**：实测 pi 对不存在的 cwd 直接拒启）
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

	// ② 活着：完全走现状（写 outbox，等它自己消费）。**零行为变化。**
	if (input.liveness === "alive") return { action: "send", reason: "session-alive" };

	// ③ 死了：要拉起 ⇒ 必须过权限门。
	//    拉起是**新能力**（副作用：在用户桌面上开一个可见窗口），
	//    比"给已存在的会话发消息"重，所以单独门控，不复用既有 token 的隐含授权。
	if (!input.permitted) return { action: "reject", reason: "spawn-not-permitted" };

	// ④ cwd 不存在 ⇒ pi 会拒绝启动（实测 `Stored session working directory does not exist`）。
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
