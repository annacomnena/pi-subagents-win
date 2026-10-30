/**
 * _test_session_resume.ts — 「发消息给死会话时拉起它」的判定（S2）
 *
 * owner 裁决（2026-10-30）：GUI 应能发消息给任意 session，会话不在就**拉起**它，
 * 由 runtime-daemon 操作、只允许 GUI、新开可见 WT tab。
 *
 * 核心不变式（本测试锁死）：
 *   1. 会话活着 ⇒ 只发消息（**零行为变化**，绝不 spawn）
 *   2. 会话死了 + 有文件 + cwd 在 + 有权限 ⇒ spawn-then-send
 *   3. 权限不足 ⇒ 拒绝（拉起是新能力，单独门控）
 *   4. cwd 不存在 ⇒ 拒绝（pi 会拒启，别开一个注定失败的窗口）
 *   5. 无会话文件 ⇒ 拒绝（既有 "no-session" 语义，不回归）
 */

import assert from "node:assert/strict";
import {
	decideSendAction,
	isSpawnPermitted,
	resumeTabTitle,
} from "./runtime/session-resume.ts";

let n = 0;
const ok = (msg: string): void => { n += 1; console.log(`ok ${n} - ${msg}`); };

const ALWAYS_TRUE = (): boolean => true;
const ALWAYS_FALSE = (): boolean => false;

// ── ① 会话活着：零行为变化（绝不 spawn）──────────────────────────────
{
	const d = decideSendAction({
		sessionFile: "C:/s/x.jsonl",
		liveness: "alive",
		sessionCwd: "G:/a",
		cwdExists: ALWAYS_TRUE,
		permitted: true,
	});
	assert.equal(d.action, "send", "会话活着 ⇒ 只发消息");
	assert.equal(d.reason, "session-alive");
	ok("会话活着 ⇒ send（绝不拉起，既有 outbox 路径零变化）");
}

// ── ② 活着但无权限：也必须能发（权限只拦「拉起」，不拦「发」）──────────
{
	const d = decideSendAction({
		sessionFile: "C:/s/x.jsonl",
		liveness: "alive",
		sessionCwd: "G:/a",
		cwdExists: ALWAYS_TRUE,
		permitted: false,
	});
	assert.equal(d.action, "send", "无拉起权限不影响给活会话发消息");
	ok("活会话 + 无拉起权限 ⇒ 仍 send（权限门只管 spawn，不扩权也不缩权）");
}

// ── ③ 会话死了 + 一切就绪 ⇒ spawn-then-send ────────────────────────
{
	const d = decideSendAction({
		sessionFile: "C:/s/x.jsonl",
		liveness: "dead",
		sessionCwd: "G:/a",
		cwdExists: ALWAYS_TRUE,
		permitted: true,
	});
	assert.equal(d.action, "spawn-then-send", "会话死了 ⇒ 拉起再发");
	assert.equal(d.reason, "session-dead");
	assert.equal(d.action === "spawn-then-send" ? d.sessionFile : null, "C:/s/x.jsonl",
		"必须把要拉起的会话文件传给调用方");
	ok("会话死了 + 有文件 + cwd 在 + 有权限 ⇒ spawn-then-send（带正确 sessionFile）");
}

// ── ④ 四种拒绝各自具名 ────────────────────────────────────────────
{
	const cases: Array<[string, Parameters<typeof decideSendAction>[0], string]> = [
		["无会话文件", { sessionFile: null, liveness: "dead", sessionCwd: null, cwdExists: ALWAYS_TRUE, permitted: true }, "no-session"],
		["无拉起权限", { sessionFile: "C:/s.jsonl", liveness: "dead", sessionCwd: "G:/a", cwdExists: ALWAYS_TRUE, permitted: false }, "spawn-not-permitted"],
		["cwd 已删", { sessionFile: "C:/s.jsonl", liveness: "dead", sessionCwd: "G:/gone", cwdExists: ALWAYS_FALSE, permitted: true }, "cwd-missing"],
		["cwd 读不出", { sessionFile: "C:/s.jsonl", liveness: "dead", sessionCwd: null, cwdExists: ALWAYS_TRUE, permitted: true }, "cwd-missing"],
	];
	for (const [label, input, want] of cases) {
		const d = decideSendAction(input);
		assert.equal(d.action, "reject", `${label} ⇒ 必须 reject`);
		assert.equal(d.reason, want, `${label} ⇒ reason 必须 ${want}，实际 ${d.reason}`);
	}
	ok("四种拒绝：no-session / spawn-not-permitted / cwd-missing（含读不出）各自具名");
}

// ── ⑤ 权限门：只认 GUI 两证据合取（单证据不够）─────────────────────
{
	assert.equal(isSpawnPermitted({ trustedLocal: true, guiEnabled: true }), true);
	assert.equal(isSpawnPermitted({ trustedLocal: true, guiEnabled: false }), false, "只有 trustedLocal 不够");
	assert.equal(isSpawnPermitted({ trustedLocal: false, guiEnabled: true }), false, "只有 guiEnabled 不够");
	assert.equal(isSpawnPermitted({}), false);
	assert.equal(isSpawnPermitted(null), false);
	assert.equal(isSpawnPermitted(undefined), false);
	// 严格 === true，不接受 truthy 值（防 "1"/1 之类宽松形状被当成真）
	assert.equal(isSpawnPermitted({ trustedLocal: 1 as never, guiEnabled: true as never }), false,
		"非布尔 truthy 必须拒绝（fail closed）");
	ok("权限门：trustedLocal ∧ guiEnabled 严格 === true 才放行（单证据/truthy 一律拒）");
}

// ── ⑥ 优先级：权限门先于 cwd 检查（先判「你凭什么」，再判「能不能」）──
{
	// 既无权限又 cwd 缺失 ⇒ 必须报权限问题（否则泄露「这个会话的 cwd 已删」这一信息
	// 给未授权调用方）
	const d = decideSendAction({
		sessionFile: "C:/s.jsonl",
		liveness: "dead",
		sessionCwd: "G:/gone",
		cwdExists: ALWAYS_FALSE,
		permitted: false,
	});
	assert.equal(d.action, "reject");
	assert.equal(d.reason, "spawn-not-permitted", "无权限时必须先报权限，不泄露 cwd 状态");
	ok("拒绝优先级：无权限 ⇒ 先报 spawn-not-permitted，不泄露 cwd 是否存在");
}

// ── ⑦ no-session 仍先于权限（无会话是「无从谈起」，不涉及授权）──────
{
	const d = decideSendAction({
		sessionFile: null,
		liveness: "dead",
		sessionCwd: null,
		cwdExists: ALWAYS_TRUE,
		permitted: false,
	});
	assert.equal(d.reason, "no-session", "无会话文件时必须报 no-session（保持既有语义）");
	ok("no-session 优先于权限：无会话是事实性拒绝，不涉及授权判断");
}

// ── ⑧ 标签页标题 ──────────────────────────────────────────────────
{
	assert.equal(resumeTabTitle("01a18ab7-d2b3-71b4"), "resume 01a18ab7");
	assert.equal(resumeTabTitle(""), "resume session");
	assert.equal(resumeTabTitle("   "), "resume session");
	assert.equal(resumeTabTitle("abc"), "resume abc", "短 id 原样用，不补位");
	assert.ok(resumeTabTitle("x".repeat(64)).length <= 15, "标题必须短（不泄露完整 id）");
	ok("标签标题：`resume <前8位>`；空/短 id 有兜底，长度受控");
}

// ── ⑨ 幂等/确定性：同输入恒同结果（无随机、无时间依赖）──────────────
{
	const input: Parameters<typeof decideSendAction>[0] = {
		sessionFile: "C:/s.jsonl",
		liveness: "dead",
		sessionCwd: "G:/a",
		cwdExists: ALWAYS_TRUE,
		permitted: true,
	};
	const seen = new Set<string>();
	for (let i = 0; i < 50; i += 1) seen.add(decideSendAction(input).action);
	assert.deepEqual([...seen], ["spawn-then-send"], "同输入必须恒定（无随机/无时间窗）");
	ok("确定性：50 次同输入恒定 spawn-then-send（不引入时间窗/随机）");
}

console.log(`\nsession-resume tests passed (${n} checks)`);
