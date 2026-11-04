/**
 * runtime/session-resume.ts — 「向任意 session 发消息时，会话**确认已死**才把它拉起来」
 * * owner 裁决（2026-10-30）：
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

import { readFileSync, statSync } from "node:fs";

import { probeSessionOwner } from "./session-owner.ts";
import { findSessionFile } from "./transcript.ts";

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

/**
 * 【2026-11-04 新增】该会话**是否仍有可能被 S2 拉起**（B 通道协调用）。
 *
 * ## 为什么需要这个函数（B/S2 语义冲突）
 *
 * B 通道（`sweepTargetDeadOutboxItems`）判「目标已死 ⇒ 标 failed（消息永远送不到）」；
 * S2 判「目标已死 ⇒ **拉起它**（消息送得到）」。同一事实，相反处置。
 * 不协调的后果（真实场景）：
 * ```
 * t=0    用户发消息给死会话 → S2 拉起它 → 消息等新实例起来消费
 * t=10m  B 扫到这条 pending（过宽限期）→ 判目标死 → 标 failed ❌ 消息在送达前被判死
 * ```
 *
 * ## 判据口径（与 S2 的 decideSendAction **同源**，避免两处各写一份）
 *
 * 「能拉起」= **S2 的裁决链条会走 spawn**：
 *   ① 有会话文件（否则无从拉起）
 *   ② 会话的工作目录存在（否则 pi 拒启）
 *   ③ 存活判定**是 dead**（与 decideSendAction 的「只有 dead 才拉起」完全一致）
 *
 * ## 为什么 ③ 必须要求 `dead` 而不是「不是 alive」（L4 审查 B3）
 *
 * 旧口径（unknown 也算「能拉起」）会让 **B 通道整体失效**：
 * 真机 1046 个会话里 1038 个（99.24%）**没有 owner 记录** ⇒ 判 unknown
 * ⇒ 全被算成「能拉起」⇒ B **永不**标 failed ⇒ 消息悬挂到 24h TTL
 * ⇒ 正是 2026-11-03 事故「3 条消息卡 10 小时」的形态。
 *
 * ⇒ 口径必须与 `decideSendAction` 一致（要求 dead）。
 *
 * ## 那「历史会话靠 GUI 显式拉起」怎么办？
 *
 * 由**另一条通道**解决，不靠放宽本判据：
 * 用户点「拉起」时消息带 `forceResume` 标记 ⇒ outbox 项携带该标记
 * ⇒ B 看到「这条消息用户明确要求拉起」⇒ **不标 failed**（等 S2 拉起后送达）。
 * 见 `message-outbox.ts` 的 `forceResume` 字段与 sweep 里的对应分支。
 *
 * ## 取舍方向
 *
 * 宁可让消息多等一会儿（B 不标 failed），**不可**把还能送的消息判死
 * （本仓 R-5：异步交付宁可重发不可漏发）。
 */
export function decideRescuable(input: {
	/** 会话文件是否存在（S2 的必要条件之一）。 */
	sessionFileExists: boolean;
	/** 会话记录里的 cwd；null = 读不出。 */
	sessionCwd: string | null;
	/** cwd 是否仍存在。 */
	cwdExists: boolean;
	/** 存活三态。 */
	liveness: SessionLiveness;
}): boolean {
	if (!input.sessionFileExists) return false;
	if (input.sessionCwd === null || !input.cwdExists) return false;
	// **必须与 decideSendAction 同源**：只有 dead 才算「会被拉起」。
	// alive ⇒ 不需要拉起；unknown ⇒ 自动路径不会拉起（缺证据 = 不动）。
	return input.liveness === "dead";
}

/**
 * 【2026-11-04 新增】生产实现：某会话**是否仍有可能被 S2 拉起**。
 *
 * ## 为什么放在这里（而不是 host 侧）
 *
 * B 通道有**两个**执行体，都会标 failed：
 *   - host 侧：每 60s 扫一次（`runtime-host/server.ts`）—— 对**全部** outbox 项有视野
 *   - 桥侧：每 10s 扫一次（`outbox-bridge.ts`）—— 跑在某个会话的进程里
 *
 * 桥**比 host 频繁**（10s < 60s）⇒ 只在 host 侧协调是**不够的**
 * （桥会先把消息标死，host 的协调来不及）。
 *
 * 而桥侧**没有**拉起能力（无 wt.exe / spawnPiTab）⇒ 它只能「问判据」，
 * 不能「执行拉起」。⇒ 判据必须是**共享的纯逻辑**，两个执行体都能调用。
 *
 * ## 判据来源（与 S2 同源）
 *
 * 复用 `session-owner` 记录（方案 A）+ 会话文件存在性 + cwd 存在性，
 * 与 `decideSendAction` 的必要条件一致。
 *
 * never-throw：任何异常 ⇒ false（按「不能拉起」处理）。
 */
export function canSessionBeRescued(input: {
	sessionId: string;
	/** sessions 根目录（找会话文件）。 */
	sessionsDir: string;
	/** runtime state 根（读 session-owner 记录）。 */
	stateDir: string;
	/** pid 探针（测试可注入；缺省走 liveness.ts::probePidState）。 */
	probePid?: (pid: number) => { state: "alive" | "dead" | "unknown"; basis: string };
}): boolean {
	try {
		const file = findSessionFile(input.sessionsDir, input.sessionId);
		if (file === null) return false;
		const cwd = readSessionCwdFromFile(file);
		if (cwd === null) return false;
		let cwdExists = false;
		try {
			cwdExists = statSync(cwd).isDirectory();
		} catch {
			cwdExists = false;
		}
		if (!cwdExists) return false;
		// 存活判定：owner 记录（方案 A）。**不删僵尸记录**（证据要留给 S2）。
		const owner = probeSessionOwner(input.sessionId, {
			stateDir: input.stateDir,
			deleteZombie: false,
			...(input.probePid !== undefined ? { probePid: input.probePid } : {}),
		});
		// alive ⇒ 不需要拉起；dead / unknown ⇒ 仍可能（unknown 含历史会话无记录的情形）
		return decideRescuable({
			sessionFileExists: true,
			sessionCwd: cwd,
			cwdExists: true,
			liveness: owner.state,
		});
	} catch {
		return false;
	}
}

/**
 * 读会话文件首行的 cwd（会话记录形状：`{type:"session", cwd}`）。
 * never-throw（读不出 → null）。
 *
 * 只读**首行**（不整文件解析）：大会话文件可能几十 MB，而 cwd 只在首行。
 */
export function readSessionCwdFromFile(file: string): string | null {
	try {
		const head = readFileSync(file, "utf8").split("\n", 1)[0] ?? "";
		const rec = JSON.parse(head) as { type?: unknown; cwd?: unknown };
		return rec.type === "session" && typeof rec.cwd === "string" ? rec.cwd : null;
	} catch {
		return null;
	}
}
