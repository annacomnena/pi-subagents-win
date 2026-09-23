/**
 * _test_master_home_guard.ts — 0923 Global Master home 会话守卫。
 *
 * 覆盖（隔离临时 PI_RUNTIME_DIR，不碰真实用户目录；fake home/cwd 经 env 注入，
 * 不改 USERPROFILE、不 monkeypatch process.cwd）：
 *   ① isExactHomeCwd 纯函数矩阵（win32/posix）
 *   ② checkMasterHomeAttach 地址门（缺省 global 受限 / local 放行）
 *   ③ 控制层零写集成（repo genesis 拒且无文件；token/forceStale/同会话刷新不放行；
 *      fake home 持原 token 接管成功；local 在 repo 可认领）
 *   ④ 入口级：masterAttachLogic repo 拒（含 token）/home 成功/中文提示；
 *      initialCwd=repo + 当前 home 仍拒绝；unknown 身份优先 bad-session
 *
 * 运行：npm run test:master-home-guard
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "runtime-master-home-guard-env-"));

import {
	checkMasterHomeAttach,
	formatNotHomeDirMessage,
	isExactHomeCwd,
} from "./runtime/master-home-guard.ts";
import { attachCurrentSession } from "./runtime/master-control.ts";
import { masterAttachLogic } from "./master-tools.ts";
import { clearSessionStartCwd, readSessionStartCwd, recordSessionStartCwd } from "./runtime/master-session-cwd.ts";
import { attachmentPathFor, readAttachment, readHandoffToken } from "./runtime/registry.ts";
import { masterAddress } from "./runtime/address.ts";
import { localMasterAddress } from "./runtime/scope.ts";
import { defaultJournalPath } from "./runtime/journal.ts";

let n = 0;
const ok = (name: string) => { n++; console.log(`ok ${n} - ${name}`); };

// env 注入的 fake 家目录（win32/posix 双平台字面量；仅作字符串比较，不访问磁盘）
const WIN_HOME = "C:\\Users\\Annacomnena";
const POSIX_HOME = "/home/annacomnena";
const GATE = (home: string, platform: NodeJS.Platform) => ({ home, platform });

// ① 纯函数矩阵 ─────────────────────────────────────────────
{
	// win32 同目录：大小写/斜杠/尾斜线/./.. 归一
	assert.equal(isExactHomeCwd("C:\\Users\\Annacomnena", WIN_HOME, "win32"), true);
	assert.equal(isExactHomeCwd("c:\\users\\annacomnena", WIN_HOME, "win32"), true);
	assert.equal(isExactHomeCwd("C:/Users/Annacomnena/", WIN_HOME, "win32"), true);
	assert.equal(isExactHomeCwd("C:\\Users\\Annacomnena\\.", WIN_HOME, "win32"), true);
	assert.equal(isExactHomeCwd("C:\\Users\\Annacomnena\\sub\\..", WIN_HOME, "win32"), true);
	// win32 拒绝：子目录 / 同前缀 / 伪造用户 / 跨盘 / UNC / 相对 / drive-relative / root-relative / 空
	assert.equal(isExactHomeCwd("C:\\Users\\Annacomnena\\repo", WIN_HOME, "win32"), false);
	assert.equal(isExactHomeCwd("C:\\Users\\Annacomnena\\OneDrive", WIN_HOME, "win32"), false);
	assert.equal(isExactHomeCwd("C:\\Users\\Annacomnena\\.pi", WIN_HOME, "win32"), false);
	assert.equal(isExactHomeCwd("C:\\Users\\Annacomnena2", WIN_HOME, "win32"), false);
	assert.equal(isExactHomeCwd("C:\\Users\\Administrator", WIN_HOME, "win32"), false);
	assert.equal(isExactHomeCwd("D:\\Users\\Annacomnena", WIN_HOME, "win32"), false);
	assert.equal(isExactHomeCwd("\\\\srv\\share\\Annacomnena", WIN_HOME, "win32"), false);
	assert.equal(isExactHomeCwd("Users\\Annacomnena", WIN_HOME, "win32"), false);
	assert.equal(isExactHomeCwd("C:Users\\Annacomnena", WIN_HOME, "win32"), false);
	assert.equal(isExactHomeCwd("\\Users\\Annacomnena", WIN_HOME, "win32"), false);
	assert.equal(isExactHomeCwd("", WIN_HOME, "win32"), false);
	ok("win32 纯函数矩阵");
}
{
	// posix：严格大小写；子目录/同前缀/相对/空拒绝
	assert.equal(isExactHomeCwd("/home/annacomnena", POSIX_HOME, "posix"), true);
	assert.equal(isExactHomeCwd("/home/annacomnena/", POSIX_HOME, "posix"), true);
	assert.equal(isExactHomeCwd("/home/annacomnena/./", POSIX_HOME, "posix"), true);
	assert.equal(isExactHomeCwd("/HOME/annacomnena", POSIX_HOME, "posix"), false);
	assert.equal(isExactHomeCwd("/home/annacomnena/repo", POSIX_HOME, "posix"), false);
	assert.equal(isExactHomeCwd("/home/annacomnena2", POSIX_HOME, "posix"), false);
	assert.equal(isExactHomeCwd("home/annacomnena", POSIX_HOME, "posix"), false);
	assert.equal(isExactHomeCwd("", POSIX_HOME, "posix"), false);
	// 风格交叉：posix 下的 win32 字面量不是绝对路径 → 拒绝
	assert.equal(isExactHomeCwd("C:\\Users\\Annacomnena", WIN_HOME, "posix"), false);
	ok("posix 纯函数矩阵");
}

// ② 地址门 ────────────────────────────────────────────────
{
	const repo = join(WIN_HOME, "repo");
	// 缺省 == 显式 global：同样受限
	assert.equal(checkMasterHomeAttach(undefined, repo, WIN_HOME, "win32").ok, false);
	assert.equal(checkMasterHomeAttach(masterAddress(), repo, WIN_HOME, "win32").ok, false);
	assert.equal(checkMasterHomeAttach(undefined, WIN_HOME, WIN_HOME, "win32").ok, true);
	// local 不受限（repo 放行）
	assert.equal(checkMasterHomeAttach(localMasterAddress("repo/x"), repo, WIN_HOME, "win32").ok, true);
	// cwd 缺失 fail closed
	assert.equal(checkMasterHomeAttach(undefined, null, WIN_HOME, "win32").ok, false);
	assert.equal(checkMasterHomeAttach(undefined, "", WIN_HOME, "win32").ok, false);
	ok("checkMasterHomeAttach 地址门");
}

// ③ 控制层零写集成（fake home 经 env 注入） ─────────────────
const REPO = "C:\\Users\\Annacomnena\\repo";
{
	// 无 owner 的 global genesis 在 repo 被拒：attachment/handoff/journal 均不产生
	const r = attachCurrentSession({
		sessionId: "sess_repo_gen", cwd: REPO, initialCwd: REPO, ...GATE(WIN_HOME, "win32"),
	});
	assert.equal(r.ok, false);
	if (!r.ok) assert.equal(r.reason, "not-home-dir");
	assert.equal(readAttachment(masterAddress()), null);
	assert.equal(readHandoffToken(masterAddress()), null);
	assert.equal(existsSync(attachmentPathFor(masterAddress())), false);
	assert.equal(existsSync(defaultJournalPath()), false);
	ok("repo genesis 拒绝且零写");
}
{
	// home genesis 成功 → detach 发 token → repo 持 token 仍被拒（token 不放行，
	// 且拒绝不消费 token）→ repo forceStale+confirm 被拒 → 同会话刷新被拒 →
	// home 持原 token 接管 bump 成功
	const g = attachCurrentSession({
		sessionId: "sess_home_1", cwd: WIN_HOME, initialCwd: WIN_HOME, ...GATE(WIN_HOME, "win32"),
	});
	assert.equal(g.ok, true);
	const { issueMasterHandoffToken } = await import("./runtime/master-control.ts");
	const tok = issueMasterHandoffToken({ sessionId: "sess_home_1", reason: "t" });
	assert.equal(tok.ok, true);
	const token = tok.ok && "token" in tok ? tok.token! : "";
	const before = readAttachment(masterAddress())!;
	const handoffBefore = readHandoffToken(masterAddress())!;

	const withToken = attachCurrentSession({
		sessionId: "sess_repo_2", token, cwd: REPO, initialCwd: REPO, ...GATE(WIN_HOME, "win32"),
	});
	assert.equal(withToken.ok, false);
	const stale = attachCurrentSession({
		sessionId: "sess_repo_3", forceStale: true, cwd: REPO, initialCwd: REPO, ...GATE(WIN_HOME, "win32"),
	});
	assert.equal(stale.ok, false);
	const refresh = attachCurrentSession({
		sessionId: "sess_home_1", cwd: REPO, initialCwd: REPO, ...GATE(WIN_HOME, "win32"),
	});
	assert.equal(refresh.ok, false);
	// 拒绝后 gen/heartbeat/handoff 不变（旧 owner 保留，token 未消费）
	const after = readAttachment(masterAddress())!;
	assert.equal(after.generation, before.generation);
	assert.equal(after.lastHeartbeatAt, before.lastHeartbeatAt);
	assert.equal(readHandoffToken(masterAddress())?.token, handoffBefore.token);

	const home = attachCurrentSession({
		sessionId: "sess_home_2", token, cwd: WIN_HOME, initialCwd: WIN_HOME, ...GATE(WIN_HOME, "win32"),
	});
	assert.equal(home.ok, true);
	if (home.ok) assert.equal(home.attachment.generation, before.generation + 1);
	ok("token/forceStale/同会话刷新不放行；home 持原 token 接管 bump");
}
{
	// cd 绕过：initialCwd=repo + 当前 home → 仍拒绝；缺快照（null）→ 拒绝
	const moved = attachCurrentSession({
		sessionId: "sess_home_2", cwd: WIN_HOME, initialCwd: REPO, ...GATE(WIN_HOME, "win32"),
	});
	assert.equal(moved.ok, false);
	const noSnap = attachCurrentSession({
		sessionId: "sess_home_2", cwd: WIN_HOME, initialCwd: null, ...GATE(WIN_HOME, "win32"),
	});
	assert.equal(noSnap.ok, false);
	ok("initialCwd 门挡住 cd 绕过；缺快照 fail closed");
}
{
	// local 在 repo 可认领（无 home 门）；unknown 身份优先 bad-session（委托 lifecycle）
	const local = attachCurrentSession({
		sessionId: "sess_local_1", agent: localMasterAddress("repox"),
		cwd: REPO, initialCwd: REPO, ...GATE(WIN_HOME, "win32"),
	});
	assert.equal(local.ok, true);
	const unk = attachCurrentSession({
		sessionId: "unknown", cwd: WIN_HOME, initialCwd: WIN_HOME, ...GATE(WIN_HOME, "win32"),
	});
	assert.equal(unk.ok, false);
	if (!unk.ok) assert.equal(unk.reason, "bad-session");
	ok("local 放行；unknown 优先 bad-session");
}

// ④ 入口级（masterAttachLogic） ────────────────────────────
{
	// repo 持 token 被拒：中文可操作提示 + 不回显 token
	const r = masterAttachLogic(
		"sess_tool_repo", { token: "ho_secret" }, { cwd: REPO, initialCwd: REPO, env: GATE(WIN_HOME, "win32") },
	);
	assert.equal(r.isError, true);
	assert.match(r.text, /只能在用户 home/);
	assert.match(r.text, /local Master/);
	assert.ok(!r.text.includes("ho_secret"), "不得回显 token");
	// forceStale 缺 confirm 的既有报错顺序保持（先于 home 门）
	const cf = masterAttachLogic(
		"sess_tool_repo", { forceStale: true }, { cwd: REPO, initialCwd: REPO, env: GATE(WIN_HOME, "win32") },
	);
	assert.equal(cf.isError, true);
	assert.match(cf.text, /confirm/);
	// session-cwd 快照集成：record 后读取一致；清理后读 null
	recordSessionStartCwd("sess_tool_repo", REPO);
	assert.equal(readSessionStartCwd("sess_tool_repo"), REPO);
	recordSessionStartCwd("sess_tool_repo", WIN_HOME); // 首写优先，不覆盖
	assert.equal(readSessionStartCwd("sess_tool_repo"), REPO);
	clearSessionStartCwd("sess_tool_repo");
	assert.equal(readSessionStartCwd("sess_tool_repo"), null);
	ok("masterAttachLogic repo 拒 + 中文提示 + forceStale 报错顺序 + 快照首写优先");
}
{
	// 文案：有/无 token 双版本都不硬编码用户名
	const withTok = formatNotHomeDirMessage(WIN_HOME, { hasToken: true });
	const genesis = formatNotHomeDirMessage(WIN_HOME, { hasToken: false });
	assert.match(withTok, /用原 token 接管/);
	assert.match(genesis, /再执行 \/master-attach/);
	assert.ok(!withTok.includes("Annacomnena2"));
	ok("共用文案双版本");
}

console.log(`\n# pass ${n}`);
