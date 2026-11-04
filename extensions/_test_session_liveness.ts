/**
 * _test_session_liveness.ts — 会话存活状态机（2026-10-30 两次事故的回归锁）
 *
 * 事故 ①：用 `sessionAlive()` 当「进程活着」。它是「最近 15s 有活动」，
 *         模型思考 >15s 就过期 ⇒ 误判 dead ⇒ 每发一句拉起一个 tab。
 * 事故 ②：枚举命令行找 sessionId。但 pi tab 的**常态**形态是
 *         `pi --tab-run-id X @prompt.md` —— 命令行里**没有 sessionId**！
 *         实测活着的 tab pid 90508 正是此形态 ⇒ 永远判 dead。
 *
 * 本测试锁三条不变量：
 *   1. 只有明确观测到「pid 已死」才判 dead
 *   2. 「命令行看不到」只判 unknown（绝不 dead）
 *   3. GUI 的 activity 由 liveness 单一派生（active/inactive/unknown）
 */

import assert from "node:assert/strict";
import { filterContestedLegacyPairs } from "./runtime-host/server.ts";
import {
	activityOf,
	decideSendActionAllowed,
	livenessFromEvidence,
	livenessFromTabState,
	mergeEvidence,
	type LivenessEvidence,
} from "./runtime/session-liveness.ts";

let n = 0;
const ok = (msg: string): void => { n += 1; console.log(`ok ${n} - ${msg}`); };

// ── ① 三态映射：只有 pid 死才 dead ──────────────────────────────────
{
	const cases: Array<[LivenessEvidence, string, string]> = [
		[{ kind: "tab-pid-alive", runId: "t1", pid: 100 }, "alive", "tab 的 pid 活着"],
		[{ kind: "tab-pid-dead", runId: "t1", pid: 100 }, "dead", "tab 的 pid 已死（唯一可安全拉起的证据）"],
		[{ kind: "owner-pid-alive", pid: 300 }, "alive", "session-owner 记录的 pid 活着（普通 TUI 会话的唯一活证据）"],
		[{ kind: "owner-pid-dead", pid: 300 }, "dead", "session-owner 记录的 pid 已死（普通 TUI 会话可安全拉起）"],
		[{ kind: "session-flag-alive", pid: 200 }, "alive", "非 tab 会话命令行精确命中"],
		[{ kind: "session-flag-absent" }, "unknown", "命令行看不到 ⇒ **unknown 不是 dead**"],
		[{ kind: "probe-unavailable", reason: "boom" }, "unknown", "探针失败 ⇒ unknown"],
	];
	for (const [ev, want, why] of cases) {
		assert.equal(livenessFromEvidence(ev), want, `${ev.kind} ⇒ 应 ${want}（${why}）`);
	}
	ok("三态映射：只有 pid 死才 dead；session-flag-absent / probe-unavailable 一律 unknown");
}

// ── ② 【事故②回归】@prompt 形态绝不判 dead ─────────────────────────
{
	// 这是最关键的一条：pi tab 走 `@prompt.md` 时命令行没有 sessionId，
	// 旧实现据此判 dead ⇒ 每发一条消息拉起一个 tab。
	// 正确行为：判 unknown ⇒ decideSendAction 只发不拉。
	assert.equal(
		livenessFromEvidence({ kind: "session-flag-absent" }),
		"unknown",
		"@prompt 形态（命令行无 sessionId）必须判 unknown，绝不能判 dead",
	);
	ok("【事故②回归】session-flag-absent ⇒ unknown（绝不 dead）");
}

// ── ③ tab state 的 pid 判定（S2 主路径）────────────────────────────
{
	const isAlive = (pid: number): boolean => pid === 90508 || pid === 1;
	// 活 pid
	const alive = livenessFromTabState({ pid: 90508 }, isAlive);
	assert.equal(alive.liveness, "alive");
	assert.equal(alive.evidenceKind, "tab-pid-alive");
	// 死 pid
	const dead = livenessFromTabState({ pid: 99999 }, isAlive);
	assert.equal(dead.liveness, "dead");
	assert.equal(dead.evidenceKind, "tab-pid-dead");
	// state 缺失 / pid 未写 ⇒ unknown（进程刚起还没首心跳）
	for (const st of [null, {}, { pid: 0 }, { pid: -1 }, { pid: 1.5 as unknown as number }]) {
		const r = livenessFromTabState(st as { pid?: number } | null, isAlive);
		assert.equal(r.liveness, "unknown", `非法 state=${JSON.stringify(st)} ⇒ unknown（不得判 dead）`);
	}
	ok("tab state pid 判定：活→alive / 死→dead / 缺失或非法→unknown（不判死）");
}

// ── ④ 证据合并优先级 ──────────────────────────────────────────────
{
	// 【曾经的错误】旧版这里断言「dead 必须优先于 alive」，理由写作「tab state 是权威」
	// —— **那条断言把 bug 当成了规范锁死**，这正是 6 个测试全绿却抓不住重复拉起的原因。
	//
	// 正确语义分层：`tab-pid-dead` 只证明「**某个历史实例**退了」，
	// 它不能证明「**这个逻辑会话现在没有活进程**」。
	// 「要不要拉起」只能看「现在有没有活实例」。
	assert.equal(
		mergeEvidence([{ kind: "session-flag-alive", pid: 291780 }, { kind: "tab-pid-dead", runId: "t", pid: 242324 }]).kind,
		"session-flag-alive",
		"当下观测到的活进程必须高于历史 tab 记录的 dead",
	);
	assert.equal(
		mergeEvidence([{ kind: "tab-pid-dead", runId: "old", pid: 1 }, { kind: "tab-pid-alive", runId: "new", pid: 2 }]).kind,
		"tab-pid-alive",
		"同一会话旧实例 dead + 新实例 alive ⇒ alive",
	);
	assert.equal(
		mergeEvidence([{ kind: "tab-pid-alive", runId: "new", pid: 2 }, { kind: "tab-pid-dead", runId: "old", pid: 1 }]).kind,
		"tab-pid-alive",
		"顺序不得影响结果",
	);
	// alive 优先于 absent
	assert.equal(
		mergeEvidence([{ kind: "session-flag-absent" }, { kind: "tab-pid-alive", runId: "t", pid: 3 }]).kind,
		"tab-pid-alive",
	);
	// 空证据 ⇒ unknown
	assert.equal(livenessFromEvidence(mergeEvidence([])), "unknown", "无证据 ⇒ unknown");
	// 弱证据不会把强证据压下去
	assert.equal(
		mergeEvidence([
			{ kind: "tab-pid-dead", runId: "t", pid: 9 },
			{ kind: "probe-unavailable", reason: "x" },
			{ kind: "session-flag-absent" },
		]).kind,
		"tab-pid-dead",
	);
	ok("证据合并：alive(当下) > dead(历史) > absent/unavailable（弱证据不得压过强证据）");
}

// ── ⑤ GUI「活跃中」筛选 ──────────────────────────────────────────
{
	assert.equal(activityOf("alive"), "active");
	assert.equal(activityOf("dead"), "inactive");
	assert.equal(activityOf("unknown"), "unknown", "unknown 不得显示成 inactive（会误导用户以为死了）");
	ok("GUI activity：alive→active / dead→inactive / unknown→unknown（不误报为 inactive）");
}

// ── ⑥ 端到端：liveness 驱动 decideSendAction（假 tab 场景）────────
{
	// 活 tab：只发不拉（这是 owner 报的 bug 的直接回归）
	const live = decideSendActionAllowed("alive");
	assert.equal(live, false, "活着 ⇒ 绝不拉起");
	const unknown = decideSendActionAllowed("unknown");
	assert.equal(unknown, false, "unknown ⇒ 绝不拉起（缺证据 = 不动）");
	const dead = decideSendActionAllowed("dead");
	assert.equal(dead, true, "只有 dead 才允许拉起");
	ok("端到端：alive/unknown 不拉，只有 dead 才拉（owner 报的 bug 直接回归）");
}

// ── ⑦ 【关键回归】两次消息，spawn 次数必须为 1 ──────────
//
// 这是 sol 在 plans/20261030_sol_diagnosis_session_respawn.md §7 设计并实测红的用例。
// 它验的是**环境变化**：第一次消息把会话拉起来了（新进程出现），
// 第二次消息必须看到那个新进程、复用而不重复拉起。
//
// 旧测试全部只验「单个证据的静态映射」，没有一条验「一次副作用改变了下一次读的结果」。
{
	// 模拟真实现场：旧 tab 记录 pid 242324 已死，命令行探测到新实例 291780
	const oldTabDead: LivenessEvidence = { kind: "tab-pid-dead", runId: "tab_old", pid: 242324 };
	let resumedPid: number | null = null; // 拉起后才有：291780
	let spawns = 0;

	const decideFor = (): "send" | "spawn-then-send" => {
		const evs: LivenessEvidence[] = [oldTabDead]; // 旧 tab 永远在那里（历史不会消失）
		if (resumedPid !== null) evs.push({ kind: "session-flag-alive", pid: resumedPid });
		return decideSendActionAllowed(livenessFromEvidence(mergeEvidence(evs))) ? "spawn-then-send" : "send";
	};

	const reads: Array<{ message: number; action: string; spawns: number }> = [];
	for (let message = 1; message <= 2; message++) {
		const action = decideFor();
		if (action === "spawn-then-send") {
			spawns += 1;
			resumedPid = 291780; // 拉起产生新进程，从下一次读开始可见
		}
		reads.push({ message, action, spawns });
	}

	assert.equal(spawns, 1, "第二次消息必须复用第一次拉起的进程，不能再开一个 tab");
	assert.equal(reads[0].action, "spawn-then-send", "第一次：旧实例死了 ⇒ 应拉起");
	assert.equal(reads[1].action, "send", "第二次：新实例活着 ⇒ 只发不拉");
	ok("【关键回归】两次消息 ⇒ spawn 恰为 1（旧 tab dead + 新实例 alive 共存场景）");
}

// ── ⑧ 【关键回归】旧 dead 不能被「命令行缺失」或「探针失败」洗白，但也不能被当成当下死 ──
{
	// 只有旧 dead ⇒ 仍应拉起（合法恢复）
	assert.equal(
		livenessFromEvidence(mergeEvidence([{ kind: "tab-pid-dead", runId: "t", pid: 1 }])),
		"dead",
		"只有历史 dead ⇒ 仍应拉起（不能因为改成 alive 优先就永远不恢复死会话）",
	);
	// 旧 dead + absent ⇒ absent 不参与拉高，仍是 dead
	assert.equal(
		livenessFromEvidence(mergeEvidence([{ kind: "tab-pid-dead", runId: "t", pid: 1 }, { kind: "session-flag-absent" }])),
		"dead",
		"absent 不得把 dead 抹成 unknown",
	);
	// 旧 dead + 探针失败 ⇒ **仍有风险**（sol §8 明确指出未解决）：
	// 探针失败时不能确认“无活实例”，理论上应 unknown；但 现在为保持“死会话能恢复”仍是 dead。
	// 此处只如实锁定当前行为，不假装已解决。
	assert.equal(
		livenessFromEvidence(mergeEvidence([{ kind: "tab-pid-dead", runId: "t", pid: 1 }, { kind: "probe-unavailable", reason: "timeout" }])),
		"dead",
		"已知残留风险：旧 dead + 探针超时仍会拉起（sol §8 第 1 条，未修）",
	);
	ok("残留风险已如实锁定：旧 dead + 探针失败仍会拉起（未解决，不掩盖）");
}

// ── ⑨ 【2026-10-31 实测回归】多会话共享同一 legacy tab 记录 ⇒ 全弃用 ──
//
// 现场：同 cwd（G:\code\GreenCAD）隔 2 分半的两个会话
// `01a175ba-c020` / `01a175bd-1178` 都被 legacy 就近配对到同一个 `pid 433784`（已死）。
// 旧行为：两个都报 dead / 同一个 pid —— 至少有一个是错的，且无法判断是哪个。
{
	const kept = filterContestedLegacyPairs([
		{ sessionId: "01a175ba-c020", tabId: "tab_shared" },
		{ sessionId: "01a175bd-1178", tabId: "tab_shared" },
	]);
	assert.equal(kept.length, 0, "同一 tab 被两个会话争抢 ⇒ 两个都弃用（降 unknown，不自动拉起）");

	// 不争抢的正常情况必须保留
	const normal = filterContestedLegacyPairs([
		{ sessionId: "s1", tabId: "tab_a" },
		{ sessionId: "s2", tabId: "tab_b" },
	]);
	assert.equal(normal.length, 2, "一对一无争抢 ⇒ 全部保留");

	// 三个会话抢两个 tab：争抢的那个丢掉，单独的保住
	const mixed = filterContestedLegacyPairs([
		{ sessionId: "s1", tabId: "tab_x" },
		{ sessionId: "s2", tabId: "tab_x" },
		{ sessionId: "s3", tabId: "tab_y" },
	]);
	assert.deepEqual(mixed.map((m) => m.sessionId), ["s3"], "只保留唯一认领的配对");

	// 同一会话重复候选同一 tab（应视为一个认领，不算争抢）
	const same = filterContestedLegacyPairs([
		{ sessionId: "s1", tabId: "tab_z" },
		{ sessionId: "s1", tabId: "tab_z" },
	]);
	assert.equal(same.length, 2, "同一会话的重复候选不算争抢（按 sessionId 去重判）");
	ok("【实测回归】同一 legacy tab 被多会话争抢 ⇒ 全部弃用降 unknown（防邻居记录误判）");
}

// ── ⑩ 【2026-11-04 新增】owner 证据：普通 TUI 会话的存活判据 ─────────
//
// 背景（真机实测，plans/20261103_S2_resume_capability_regression.md）：
// S2 拉起能力对**普通 TUI 会话** 100% 失效 —— 1043 个会话里 S2 只判出 3 个
// （覆盖率 0.29%），其余 1040 个判 unknown ⇒ `decideSendAction` 走
// `send/liveness-unknown` ⇒ 只入队不拉起。
//
// 根因：S2 的两条取证路径都依赖 tab 概念，而 TUI 会话不是 tab。
// 方案 A（session-owner 全生命周期 pid 记录）已于 2026-11-03 实现，
// 但**只被 B 通道（outbox 死信）使用，S2 探针完全没接** ⇒ 能力断链。
//
// 本组测试锁住「接上 owner 之后」的三条行为：
{
	// ⑩-1 owner 判 dead ⇒ S2 允许拉起（这是修复的核心目的）
	assert.equal(
		livenessFromEvidence(mergeEvidence([{ kind: "owner-pid-dead", pid: 337844 }])),
		"dead",
		"owner 说 pid 已死 ⇒ 判 dead（普通 TUI 会话终于能被拉起了）",
	);
	assert.equal(
		decideSendActionAllowed(livenessFromEvidence(mergeEvidence([{ kind: "owner-pid-dead", pid: 337844 }]))),
		true,
		"owner 判 dead ⇒ 允许拉起",
	);

	// ⑩-2 【反向风险】owner 判 alive ⇒ 绝不拉起（防「活着被判死」误开窗）
	assert.equal(
		livenessFromEvidence(mergeEvidence([{ kind: "owner-pid-alive", pid: 22064 }])),
		"alive",
		"owner 说 pid 活着 ⇒ 判 alive",
	);
	assert.equal(
		decideSendActionAllowed(livenessFromEvidence(mergeEvidence([{ kind: "owner-pid-alive", pid: 22064 }]))),
		false,
		"owner 判 alive ⇒ 绝不拉起（防误开窗口）",
	);

	// ⑩-3 【核心不变量】alive 恒高于 dead —— owner 的 dead 不得压过 owner 的 alive
	// 这条是 2026-10-30「第五次修正」锁定的：dead 只证明「某个历史实例退了」，
	// 不能证明「这个逻辑会话现在没有活进程」。
	assert.equal(
		mergeEvidence([{ kind: "owner-pid-dead", pid: 1 }, { kind: "owner-pid-alive", pid: 2 }]).kind,
		"owner-pid-alive",
		"同会话旧实例 dead + 新实例 alive ⇒ alive（owner 证据不得打破这条不变量）",
	);
	assert.equal(
		mergeEvidence([{ kind: "owner-pid-alive", pid: 2 }, { kind: "owner-pid-dead", pid: 1 }]).kind,
		"owner-pid-alive",
		"顺序不得影响结果",
	);
	// owner-alive 也要压过 tab-dead（否则旧 tab 记录又会让活会话被判死 ⇒ 重复开窗）
	assert.equal(
		mergeEvidence([{ kind: "tab-pid-dead", runId: "old", pid: 1 }, { kind: "owner-pid-alive", pid: 2 }]).kind,
		"owner-pid-alive",
		"owner-alive 必须压过 tab-dead（tab 记录是历史，owner 是当下）",
	);
	// 反向：owner-dead 与 tab-alive 并存时，alive 赢（当下观测优先）
	assert.equal(
		mergeEvidence([{ kind: "owner-pid-dead", pid: 1 }, { kind: "tab-pid-alive", runId: "t", pid: 2 }]).kind,
		"tab-pid-alive",
		"当下活实例（tab-alive）压过历史死记录（owner-dead）",
	);

	// ⑩-4 owner 证据不得掩盖弱证据的 unknown 语义（无记录 ⇒ 仍 unknown）
	assert.equal(
		livenessFromEvidence(mergeEvidence([{ kind: "probe-unavailable", reason: "no-owner-record" }])),
		"unknown",
		"无 owner 记录 ⇒ 仍 unknown（缺证据 = 不动，绝不判死）",
	);

	// ⑩-5 【端到端】普通 TUI 会话的完整生命周期：
	//   活着 → 只发不拉；进程死了 → 拉起；拉起后新实例出现 → 又变回只发不拉。
	// 这是「两次消息只开一个窗口」在 owner 证据路径上的等价锁。
	{
		let ownerPid: number | null = 22064; // 会话活着
		let spawns = 0;
		const decide = (): "send" | "spawn-then-send" => {
			const evs: LivenessEvidence[] = [];
			if (ownerPid !== null) {
				evs.push({ kind: "owner-pid-alive", pid: ownerPid });
			} else {
				evs.push({ kind: "owner-pid-dead", pid: 22064 });
			}
			return decideSendActionAllowed(livenessFromEvidence(mergeEvidence(evs))) ? "spawn-then-send" : "send";
		};

		assert.equal(decide(), "send", "会话活着 ⇒ 只发不拉");
		ownerPid = null; // 进程退出（owner 记录仍在，pid 已死）
		assert.equal(decide(), "spawn-then-send", "进程已死 ⇒ 应拉起");
		spawns += 1;
		ownerPid = 99999; // 拉起产生新实例
		assert.equal(decide(), "send", "拉起后新实例活着 ⇒ 又变回只发不拉");
		assert.equal(spawns, 1, "整轮生命周期只应拉起 1 次");
	}
	ok("owner 证据：普通 TUI 会话可判 dead 可拉起；alive 恒压 dead；缺记录仍 unknown；生命周期只拉起 1 次");
}

console.log(`\nsession-liveness tests passed (${n} checks)`);