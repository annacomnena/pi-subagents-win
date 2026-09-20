/**
 * no-poll.ts — 「禁止无限轮询纪律 / No busy-polling」文本单一事实源
 *
 * 背景（plans/0918_no_poll_plan.md）：las 主 agent 曾把 turn 当 sleep 对
 * tab-runs state/result 文件做 67 秒 9 轮忙轮询。诱因是插件注入文本只教
 * "一直推进"（Closed loop: ... set-timer to advance ...），未声明 STOP 是
 * 合法终态。本模块把纪律文本集中为常量，供主会话（manager）注入面引用，
 * 并可用 `_test_no_poll.ts` 直接断言。
 *
 * 两个导出：
 *   - NO_POLL_DISCIPLINE（系统级，恰好 6 行）：仅在主会话 before_agent_start
 *     的 subagent-win-config 系统块追加一处（isMainSession 门内）。
 *   - NO_POLL_HINT（消息级 compact 版，恰好 2 行）：追加到「外部事件到达 /
 *     完成或回报通知 → 模型决定是否再派下一批」语义的用户消息体尾部
 *     （event-bus 完成体 / mailbox 完成信 / 回报注入）。
 *
 * 条件追加判据：行动指令、proposal、toast 类不附加；NO_POLL_DISCIPLINE
 * 不在消息体重复。worker 面（launch.ts workflowDisciplineBlock 四模式、
 * wake prompt、launch prompt）严禁注入——"STOP 是合法终态"与 tab-finish
 * 纪律（"绝不在未调用 tab-finish 的情况下直接结束回合"）冲突。
 *
 * 测试锚点（措辞可微调，三个稳定子串不得丢失）：busy-poll / 幂等 / STOP 是合法终态。
 */

export const NO_POLL_DISCIPLINE = [
	"【禁止无限轮询纪律 / No busy-polling】",
	"① 等外部事件（tab 完成 / 子 agent 结果）时，本轮 STOP 是合法终态：靠完成事件（event-bus 自动注入）+ 一次性 set-timer 兜底唤醒，不设周期性 timer。",
	"② 禁止用 turn 轮询 state/result 文件：turn 不是 sleep；反复重调 tab-status / reclaim-tabs / 连读 state.json、result.json 不是 next step。",
	"③ 处理完成事件前先查幂等：后继已派 / 已 reclaim 则直接 STOP；同一完成的重复投递（双注入）直接丢弃。",
	"Waiting on external events: stopping this turn is a legal end state — rely on the completion event plus one one-shot set-timer fallback (no repeat timers); never busy-poll state/result files (a turn is not sleep; re-calling tab-status/reclaim-tabs in a loop is not a next step).",
	"On a completion event, check idempotence first: successor already dispatched or already reclaimed → stop; duplicate delivery → drop.",
].join("\n");

export const NO_POLL_HINT = [
	"⛔ 禁轮询: 不要用 turn 反复轮询 state/result 文件等待（busy-poll 不是 next step）；处理完本事件后若无新活可派，本轮直接 STOP，靠完成事件 + 一次性 set-timer 兜底唤醒。处理前先查幂等: 后继已派 / 已 reclaim 则直接 STOP，重复投递直接丢弃。",
	"No busy-polling: stop after this event if nothing else to dispatch; rely on the completion event + one one-shot set-timer fallback; idempotence check first (duplicate delivery → drop).",
].join("\n");
