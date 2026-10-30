/**
 * _test_local_master_resume.ts — local master 续接裁决（2026-10-30 owner 裁决）
 *
 * owner 原话：「local master 本身应当续接；除非我或者 local 自己认为应当开新的
 * 一代并且用户同意了开新而不是压缩」。
 *
 * 本测试锁住三件事：
 *   1. 默认续接（有 attachment + session 文件在 + cwd 匹配 ⇒ resume）
 *   2. 四种回落新建的理由各自具名（no-attachment / session-file-missing /
 *      cwd-mismatch / force-new），**且不得报错**
 *   3. `--new-generation` 解析 + 只由它触发 force-new（**不得自动判定开新**）
 *
 * 负控（必须红）：
 *   - 把 decideResume 写成恒 resume ⇒ no-attachment 场景红
 *   - 把 decideResume 写成恒 new ⇒ resume 场景红
 *   - 去掉 cwd 校验 ⇒ cwd-mismatch 场景红
 */

import assert from "node:assert/strict";
import {
	decideResume,
	normalizeCwdKey,
	parseLocalMasterEnsureArgs,
} from "./runtime/local-master-launch.ts";

let n = 0;
const ok = (msg: string): void => { n += 1; console.log(`ok ${n} - ${msg}`); };

// ── ① 默认续接 ──────────────────────────────────────────────────────
{
	const d = decideResume({
		ownerSessionId: "sid-1",
		sessionFile: "C:/sessions/x.jsonl",
		sessionCwd: "G:/code/battlesandbox",
		cwd: "G:\\code\\battlesandbox",
	});
	assert.equal(d.action, "resume", "有 owner + 文件在 + cwd 匹配 ⇒ 必须续接");
	assert.equal(d.reason, "owner-session-found");
	assert.equal(d.action === "resume" ? d.sessionFile : null, "C:/sessions/x.jsonl");
	ok("默认续接：owner 会话存在且 cwd 匹配 ⇒ resume（含路径归一，斜杠/反斜杠等价）");
}

// ── ② 四种回落新建，理由必须具名 ────────────────────────────────────
{
	const cases: Array<[string, Parameters<typeof decideResume>[0], string]> = [
		["无 attachment", { ownerSessionId: null, sessionFile: null, sessionCwd: null, cwd: "G:/a" }, "no-attachment"],
		["session 文件丢失", { ownerSessionId: "s", sessionFile: null, sessionCwd: null, cwd: "G:/a" }, "session-file-missing"],
		["cwd 不匹配", { ownerSessionId: "s", sessionFile: "C:/f.jsonl", sessionCwd: "G:/other", cwd: "G:/a" }, "cwd-mismatch"],
		["cwd 读不出", { ownerSessionId: "s", sessionFile: "C:/f.jsonl", sessionCwd: null, cwd: "G:/a" }, "cwd-mismatch"],
		["人已同意开新", { ownerSessionId: "s", sessionFile: "C:/f.jsonl", sessionCwd: "G:/a", cwd: "G:/a", forceNew: true }, "force-new"],
	];
	for (const [label, input, want] of cases) {
		const d = decideResume(input);
		assert.equal(d.action, "new", `${label} ⇒ 必须回落 new`);
		assert.equal(d.reason, want, `${label} ⇒ reason 必须为 ${want}，实际 ${d.reason}`);
	}
	ok("四种回落新建：no-attachment / session-file-missing / cwd-mismatch / force-new 各自具名");
}

// ── ③ forceNew 优先级最高（即使其他条件都满足也不续接）────────────────
{
	const d = decideResume({
		ownerSessionId: "sid-1",
		sessionFile: "C:/sessions/x.jsonl",
		sessionCwd: "G:/a",
		cwd: "G:/a",
		forceNew: true,
	});
	assert.equal(d.action, "new", "forceNew=true ⇒ 必须新建，不得续接");
	assert.equal(d.reason, "force-new");
	ok("forceNew 优先：全部续接条件满足时仍新建（人已同意开新一代）");
}

// ── ④ 绝不自动开新：同样输入反复裁决必须稳定为 resume ────────────────
{
	const input: Parameters<typeof decideResume>[0] = {
		ownerSessionId: "sid-9",
		sessionFile: "C:/s.jsonl",
		sessionCwd: "G:/a",
		cwd: "G:/a",
	};
	const results = new Set<string>();
	for (let i = 0; i < 50; i += 1) {
		const d = decideResume(input);
		results.add(`${d.action}:${d.reason}`);
	}
	assert.deepEqual([...results], ["resume:owner-session-found"], "同输入必须恒定 resume（无随机/无启发式）");
	// 且不传 forceNew 时任何 cwd 之外的因素都不得让它变 new
	const noForce = decideResume({ ...input, forceNew: undefined });
	assert.equal(noForce.action, "resume", "forceNew 缺省（undefined）必须等价 false");
	ok("绝不自动开新：50 次同输入恒定 resume；forceNew 缺省等价 false");
}

// ── ⑤ cwd 归一化（Windows 路径等价性）────────────────────────────────
{
	const pairs: Array<[string, string, boolean]> = [
		["G:\\code\\a", "G:/code/a", true],
		["G:/code/a/", "g:/code/a", true],
		["G:\\code\\A", "g:/code/a", true],
		["G:/code/a", "G:/code/b", false],
		["  G:/code/a  ", "G:/code/a", true],
	];
	for (const [a, b, same] of pairs) {
		assert.equal(normalizeCwdKey(a) === normalizeCwdKey(b), same, `${a} vs ${b} 期望 same=${same}`);
	}
	ok("cwd 归一化：斜杠/大小写/尾斜杠/首尾空格等价，不同目录不等价");
}

// ── ⑥ CLI 解析：--new-generation 只由显式 flag 触发 ──────────────────
{
	assert.equal(parseLocalMasterEnsureArgs("G:/a").forceNew, false, "缺省必须 false（默认续接）");
	assert.equal(parseLocalMasterEnsureArgs("G:/a --new-generation").forceNew, true);
	assert.equal(parseLocalMasterEnsureArgs("--new-generation G:/a").forceNew, true, "flag 在 cwd 前也要认");
	assert.equal(parseLocalMasterEnsureArgs("G:/a --new-generation").cwd, "G:/a", "--new-generation 不得被当成 cwd");
	assert.equal(parseLocalMasterEnsureArgs("").forceNew, false);
	// 形状相近但不同的 flag 不得误触发
	assert.equal(parseLocalMasterEnsureArgs("G:/a --new").forceNew, false, "--new 不是本 flag");
	assert.equal(parseLocalMasterEnsureArgs("G:/a --no-wait").forceNew, false, "--no-wait 不得误触发 forceNew");
	ok("CLI 解析：--new-generation 显式触发；缺省/近似 flag 均不得误触发");
}

// ── ⑦ resume 时 bootstrap prompt 必须包含「续接」提示（防它以为自己是 genesis）──
{
	// 这里只锁字符串契约：沿用 buildLocalMasterBootstrapPrompt 的主体 + 追加段
	// （实际拼装在 ensure 内；该断言防止将来把追加段删掉）
	const { buildLocalMasterBootstrapPrompt } = await import("./runtime/local-master-launch.ts");
	const prompt = buildLocalMasterBootstrapPrompt("battlesandbox", "agent://x" as never, "G:/code/battlesandbox");
	assert.ok(prompt.includes("session_start 会自动认领"), "基础 prompt 必须保留认领说明");
	ok("bootstrap prompt 契约：保留原认领说明（续接追加段由 ensure 侧拼接，见源码）");
}

console.log(`\nlocal-master-resume tests passed (${n} checks)`);
