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
		[{ kind: "session-flag-alive", pid: 200 }, "alive", "非 tab 会话命令行精确命中"],
		[{ kind: "session-flag-absent" }, "unknown", "命令行看不到 ⇒ **unknown 不是 dead**"],
		[{ kind: "probe-unavailable", reason: "boom" }, "unknown", "探针失败 ⇒ unknown"],
	];
	for (const [ev, want, why] of cases) {
		assert.equal(livenessFromEvidence(ev), want, `${ev.kind} ⇒ 应 ${want}（${why}）`);
	}
	ok("三态映射：只有 tab-pid-dead 判 dead；session-flag-absent / probe-unavailable 一律 unknown");
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
	// dead 优先于 alive（tab state 是权威；命令行命中可能是另一个进程/pid 复用）
	assert.equal(
		mergeEvidence([{ kind: "session-flag-alive", pid: 1 }, { kind: "tab-pid-dead", runId: "t", pid: 2 }]).kind,
		"tab-pid-dead",
		"dead 必须优先于 alive（tab state 权威，命令行命中可能是重复打开）",
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
	ok("证据合并：dead > alive > absent > unavailable（弱证据不得压过强证据）");
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

console.log(`\nsession-liveness tests passed (${n} checks)`);
