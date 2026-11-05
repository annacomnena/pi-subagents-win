/**
 * `/autonomy status` 的正文构建（纯计算，never-throw）。
 *
 * **为什么独立成模块**（R-21 L4 第二轮 F4②）：它原先内联在 `index.ts` 的
 * `/autonomy` 命令 handler 里。而 `extensions/index.ts` 是扩展入口，**整包 import 会
 * stack overflow**（实测 `Maximum call stack size exceeded`）⇒ 测试根本无法加载它
 * ⇒ 这段诊断逻辑**零回归网**。L4 实测：把整段清空，11/11 测试仍绿、index 加载次数 0。
 *
 * 抽到本模块后：
 *   - `index.ts` 的 handler 调用**同一个函数**（不是为测试另写一份）
 *   - 测试可以直接断言真实分支，无需注册桩跑整个扩展入口
 *
 * 依赖全部来自 runtime 层（无 pi / pi-tui / typebox）⇒ 可以安全被测试直接 import。
 */
import { readAuditTail, readAutonomyHeartbeat, readFrontierSnapshot, readWakeGateState, frontierFreshness, listNonOwnerTicks } from "./collect.ts";
import { journalUnavailableSnapshot } from "../journal.ts";
import { evaluateAutonomyGating, readKillSwitch } from "./kill-switch.ts";
import { readAutonomyConfig } from "./config.ts";
import { readAttachment } from "../registry.ts";
import { masterAddress } from "../address.ts";
import { summarizeActionsStatus } from "./action/run.ts";
import { supervisionLedgerLines } from "../supervision.ts";

export function buildAutonomyStatusBody(): string {
	let body: string;
	try {
		const cfg = readAutonomyConfig();
			const kill = readKillSwitch();
			const gating = evaluateAutonomyGating(cfg, kill);
			const frontier = readFrontierSnapshot();
			const gate = readWakeGateState();
			const tail = readAuditTail({ limit: 5 });
			const actionsLines = summarizeActionsStatus(); // P1 动作面尾行（never-throw，≤5 行）
			const iso = (t: number): string => new Date(t).toISOString().slice(0, 19);
			// 2026-10-17（INC：autonomy 静默死亡 29h）：旧 status 只打 `asof=<绝对时间>`，
			// 读的人**看不出“多久之前”**，因此 29 小时陈旧也没被发现。此处加：年龄 + STALE 标记
			// + 心跳 + “tick 活着但 frontier 旧 ⇒ 怀疑被关”判别（与“从未开启”区分）。
			const hb = readAutonomyHeartbeat();
			const fresh = frontierFreshness(frontier, hb);
			const ageTxt = fresh.ageMs === null ? "(无快照)"
				: fresh.ageMs < 60_000 ? `${Math.round(fresh.ageMs / 1000)}s 前`
				: fresh.ageMs < 3_600_000 ? `${Math.round(fresh.ageMs / 60_000)}min 前`
				: `${(fresh.ageMs / 3_600_000).toFixed(1)}h 前`;
			const staleTag = fresh.stale ? ` ⚠️STALE(>${Math.round(fresh.threshold / 60_000)}min)` : "";
			const hbTxt = hb ? `心跳 ${Math.round(Math.max(0, Date.now() - hb.at) / 1000)}s 前 pid=${hb.pid} session=${hb.sessionId?.slice(0, 13) ?? "null"} tick=${Math.round(hb.tickIntervalMs / 1000)}s` : "心跳 (none) —— tick 未注册或旧版本代码";
			// R-2 规则 3 要求区分三态：①进程/tick 死 ②功能被关 ③正常工作。
			// 2026-11-05 事故：旧判据只覆盖 ② / ③，**缺 ①** —— 而真实故障（mailbox 消费链死亡）
			// 正是 ①：心跳文件还在（只是停了 46min，周期 30s），三个分支全 false ⇒ 只报「诊断：未知」。
			// 现在 `fresh.heartbeatStale` 把 ① 显式拿出来（见 AGENTS.md R-20）。
			// L4 F1（2026-11-05）：**心跳带 sessionId，必须判它是否就是当前 owner**。
			// 旧写法无条件把最新写者当 owner —— 而若共享槽位被非 owner 覆盖，
			// 「owner tick 已停」会被读成「tick 活着」。现在把不匹配显式报为「无法归因」。
			const ownerSid = (() => {
				try {
					return readAttachment(masterAddress())?.sessionId ?? null;
				} catch {
					return null;
				}
			})();
			const hbIsOwner = Boolean(hb && ownerSid && hb.sessionId === ownerSid);
			// F3：心跳时间在未来（时钟倒退/串改）⇒ 既不算新鲜也不算死，显式报「无法判定」
			// N1（2026-11-05 L4 复验）：**先做有效性/身份校验，再判新鲜/陈旧/疑似关闭**。
			// 旧写法把 suspectedDisabled / heartbeatStale 排在最前 ⇒ 上一任 owner 留下的陈旧心跳
			// （交接后完全自然的状态）会被当成「当前 owner tick 活着但被关」或「当前 owner tick 停了」，
			// 也就是说 hbIsOwner 算了却没接入前两个分支（L4 N1 实测复现）。
			// F3（L4 第二轮）：clockSkew **必须用算子归一化后的结论**，不得在此重算。
			// 旧写法用原始 `hb.tickIntervalMs`（可能是 1e400/1e308/非法值）算容差 ⇒
			// 与 collect 的归一化 tick（回落 30000）分裂 ⇒ `at=now+120s` + `tick=3600001` + 新快照
			// 会被判 `hasClockSkew=false` 然后走「诊断：正常」（L4 实测复现）。
			const clockSkewMs = hb ? hb.at - Date.now() : 0;
			const hasClockSkew = Boolean(hb) && fresh.clockSkew;
			// 心跳读数是否**可用于归因当前 owner**：存在 + 非未来 + 属于当前 owner
			const hbAttributable = Boolean(hb) && !hasClockSkew && hbIsOwner;
			const clockSkewLine = hasClockSkew
				? `⚠️ 诊断：心跳时间在**未来** ${Math.round(clockSkewMs / 60_000)}min（时钟倒退或文件被串改）⇒ 既不能判新鲜也不能判死，**无法判定**`
				: "";
			const otherTicks = listNonOwnerTicks();
			// N2（L4）：区分「总记录」与「活跃记录」——旧文案把全部文件数叫「活跃记录」
			const otherActive = otherTicks.filter((t) => Date.now() - t.at <= 5 * 60_000);
			const otherTickLine = otherTicks.length
				? `非 owner tick：共 ${otherTicks.length} 条记录，其中 ${otherActive.length} 条活跃（≤5min）；最近一条 ${Math.round(Math.max(0, Date.now() - otherTicks[0].at) / 1000)}s 前（session=${otherTicks[0].sessionId?.slice(0, 13) ?? "?"}）；它们**不在** owner 槽位，不参与「被关」判定`
				: "非 owner tick：(none)";
			const diagLine = hb && !hbIsOwner
					? `⚠️ 诊断：心跳的 sessionId 与当前 global owner 不一致（心跳=${hb.sessionId?.slice(0, 13) ?? "null"} / owner=${ownerSid?.slice(0, 13) ?? "null"}）⇒ **无法归因**（交接刚发生或共享槽位被旧写者遗留）；心跳年龄 ${Math.round(Math.max(0, Date.now() - hb.at) / 1000)}s`
					: hasClockSkew
						? clockSkewLine
						: !hbAttributable
							? (!hb && frontier ? `⚠️ 诊断：无心跳（读数不存在或无法解析）但 frontier 快照 ${Math.round(Math.max(0, Date.now() - (frontier.asof ?? 0)) / 60_000)}min 前 ⇒ 无法确定 tick 状态（可能是 tick 未跑，也可能是读盘失败）` : "诊断：未知")
							: fresh.suspectedDisabled
								? "⚠️ 诊断：owner tick 活着且心跳读数有效，但 frontier 不新鲜 ⇒ **autonomy 很可能被关**（查 enabled 键是否还在 config）"
								: fresh.heartbeatStale
									? `⚠️ 诊断：**owner wake 心跳已 ${Math.round(Math.max(0, Date.now() - hb!.at) / 60_000)}min 未更新**（pid=${hb!.pid} tick=${Math.round(fresh.tickMs / 1000)}s）⇒ owner wake **心跳未更新**（疑 tick 未注册/停摆，或写盘失败——写心跳是 never-throw，失败不会阻止 tick 后续的维护/唤醒）；**注意这不能证明 mailbox 消费链也停了**（独立 10s interval，需单独用消费证据判）`
									: hb && !fresh.stale ? "诊断：正常（owner tick 活着且快照新鲜）"
									: "诊断：未知";
			body = [
				`autonomy: enabled=${cfg.enabled === true ? "on" : "off"}（切换：/autonomy on|off，或 GUI 设置区的「主动性套件」开关）`,
				`kill-switch: ${kill ? `on (reason=${kill.reason} @${kill.at.slice(0, 19)} by=${kill.by})` : "off"}`,
				`gating: ${gating.active ? "active" : `inactive (${gating.reason})`}`,
				`frontier: ${frontier ? `asof=${iso(frontier.asof)} (${ageTxt})${staleTag} baseline=${frontier.baseline} projects=${frontier.projects.length} triggers(last)=${frontier.triggers.length}` : "(none)"}`,
				`${hbTxt}`,
				`${otherTickLine}`,
				`${diagLine}`,
				`wake-gate: ${gate?.lastReason ? `${gate.lastReason} @${gate.lastDecisionAt !== null ? iso(gate.lastDecisionAt) : "?"}` : "(never)"}`,
				// journal 写入口存活信号（R-2，2026-11-05）：claim 机制坏掉 / 磁盘满 / 权限时
				// 8 个 journal 写点会**全部静默停写**。这里把它变成可见读数。
				`journal-unavailable: ${(() => {
					const j = journalUnavailableSnapshot();
					if (!j.degraded) return "none（全部写点正常）";
					return `⚠️ ${j.count} 次（首 ${j.firstAt?.slice(0, 19)} / 末 ${j.lastAt?.slice(0, 19)}）lastError=${j.lastError}`;
				})()}`,
				// ⑨ 监管账本（2026-10-17 P0）：每个 active 账本的状态（state + idle）——只读显示，零动作。
				// 2026-11-05 修复（R-20 家族）：这里原本写 `supervisionLines(frontier)`，
				// 但**这个函数不存在** —— 真实导出是 `supervisionLedgerLines({...})`（import 在文件头）。
				// 后果：`/autonomy status` 每次执行到这行都抛 ReferenceError ⇒ 被下方 catch 吞掉
				// ⇒ 整个 status **永远**只返回「autonomy status: (状态不可读)」。
				// 这正是 L4 说「诊断层无回归网」的另一面：它根本没跑通过，所以没人发现。
				...supervisionLedgerLines({}),
				`audit (最近 ${tail.length} 行):`,
				...(tail.length ? tail.map((l) => `  ${l}`) : ["  (空)"]),
				...actionsLines,
			].join("\n");
	} catch {
		body = "autonomy status: (状态不可读)";
	}
	return body;
}
