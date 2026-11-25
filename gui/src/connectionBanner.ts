/**
 * gui/src/connectionBanner.ts — 断连横幅判定（2026-11-17）
 *
 * ## 为什么需要去抖
 *
 * 全局 `connection` 由 8 路语义不同的轮询共用（health / snapshot / events /
 * attention / interactions / sessions / timeline…）：任意一路偶发失败（events
 * 的 409 cursor-invalid 重同步、`/v1/sessions`慢到触 5s 超时、瞬时网络抖动）
 * 都会 markDown，成功的一路立刻 markUp ⇒ 横幅「与后端服务断开」频繁闪现，
 * 而后端其实一直是活的（实测 30s 并发 0 失败）。
 *
 * 判据改为**连续失败次数**：单次/偶发失败不打扰用户；真持续失败（host 重启
 * 换端口 / 凭据失效 / 服务真挂）才显示，并给出可操作指引。
 */

import type { ConnState } from "./api/client";

/** 连续失败达到该次数才显示横幅（2s 档轮询 ⇒ 约 6s 持续失败）。 */
export const DISCONNECT_BANNER_THRESHOLD = 3;
/** 达到该次数时升级为「需重新打开」提示（约 12s 持续失败）。 */
export const RECONNECT_HINT_THRESHOLD = 6;

export type DisconnectBannerLevel = "none" | "retrying" | "reconnect";

export interface DisconnectBannerDecision {
	visible: boolean;
	level: DisconnectBannerLevel;
}

/** 纯函数：由连接态 + 连续失败次数决定横幅档位。never-throw，输入可任意数。 */
export function decideDisconnectBanner(connection: ConnState, downStreak: number): DisconnectBannerDecision {
	if (connection !== "down" || !Number.isFinite(downStreak) || downStreak < DISCONNECT_BANNER_THRESHOLD) {
		return { visible: false, level: "none" };
	}
	return downStreak >= RECONNECT_HINT_THRESHOLD
		? { visible: true, level: "reconnect" }
		: { visible: true, level: "retrying" };
}
