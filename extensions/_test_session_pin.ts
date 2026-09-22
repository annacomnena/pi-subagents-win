/**
 * _test_session_pin.ts — /v1/sessions 置顶数据源冒烟（会话 rail 三件套 L3，host 侧）
 *
 * 覆盖（session-pin.ts 纯函数 + /v1/sessions 端点 E2E）：
 *   P1  isMaster：sessionId === 全局 master attachment 的 sessionId（registry 现有函数只读，
 *       与 masterProtected 同源）；无 attachment → 不标
 *   P2  isScopeMaster：scope attachment（agent://master_local_*）解码 basename == 会话 cwd
 *       basename（Windows 反斜杠 + 大小写不敏感）
 *   P3  e39 编码形（含空格仓库名）解码命中
 *   P4  `-worktree` 后缀先剥再解码命中（localMasterScope 编码约定）
 *   P5  解码失败（e39 + 非法 hex）→ 不标
 *   P6  cwd 不匹配 / null / 全空白 → 不标；POSIX 大小写精确
 *   P7  同名不同 owner（不同 sessionId）→ 不互标
 *   P8  passthrough e39 命名空间 round-trip（仓库名本身以 e39 开头）
 *   P9  同会话双标（全局 master 同时是本仓 scope master）；Map 仅含有标条目
 *   P10 /v1/sessions E2E：端点响应条目挂 isMaster/isScopeMaster（additive，仅 true 挂出）
 *
 * 运行：npm run test:session-pin
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 注册表/日志路径全部走 env 注入（registry/scope/transcript 的缺省目录都读 PI_*）
const RUNTIME_ROOT = mkdtempSync(join(tmpdir(), "session-pin-test-"));
process.env.PI_RUNTIME_DIR = join(RUNTIME_ROOT, "runtime");
process.env.PI_SESSIONS_DIR = join(RUNTIME_ROOT, "sessions");
mkdirSync(process.env.PI_RUNTIME_DIR, { recursive: true });
mkdirSync(process.env.PI_SESSIONS_DIR, { recursive: true });

const { attachMaster } = await import("./runtime/registry.ts");
const { masterAddress } = await import("./runtime/address.ts");
const { encodeScopeSegment, localMasterAddress } = await import("./runtime/scope.ts");
const { computeSessionPinFlags } = await import("./runtime-host/session-pin.ts");

let n = 0;
const ok = (name: string): void => {
	n += 1;
	console.log(`ok ${n} - ${name}`);
};

// ── P1 全局 master（registry 现有函数只读，与 masterProtected 同源）────────────────
// 无 attachment 基线
{
	const flags = computeSessionPinFlags([{ sessionId: "any1", cwd: "C:\\x\\y" }]);
	assert.equal(flags.has("any1"), false, "无 attachment → 无标记，Map 不含该会话");
	ok("P1a 无 attachment → 不标");
}
attachMaster({ sessionId: "g1" });
{
	const flags = computeSessionPinFlags([
		{ sessionId: "g1", cwd: "C:\\x\\y" }, // cwd 任意：isMaster 只看 sessionId
		{ sessionId: "g2", cwd: "C:\\x\\y" },
	]);
	assert.deepEqual(flags.get("g1"), { isMaster: true });
	assert.equal(flags.has("g2"), false);
	ok("P1b 全局 master 会话 isMaster（cwd 任意）；他会话不标");
}

// ── P2/P3/P4 scope attachment 解码命中 ────────────────────────────────────────────
attachMaster({ sessionId: "s1", agent: localMasterAddress(encodeScopeSegment("myrepo")) });
attachMaster({ sessionId: "s2", agent: localMasterAddress(encodeScopeSegment("my repo")) }); // 含空格 → e39 编码
attachMaster({ sessionId: "s3", agent: localMasterAddress(encodeScopeSegment("wt-repo") + "-worktree") });
{
	const flags = computeSessionPinFlags([
		{ sessionId: "s1", cwd: "C:\\work\\myrepo" },
		{ sessionId: "s1", cwd: "c:/WORK/MyRepo" }, // Windows 大小写/斜杠混写 → 同仓
		{ sessionId: "s2", cwd: "C:\\r\\my repo" },
		{ sessionId: "s3", cwd: "C:\\wt\\wt-repo" }, // worktree 后缀先剥：解码回 toplevel basename
	]);
	assert.deepEqual(flags.get("s1"), { isScopeMaster: true });
	assert.deepEqual(flags.get("s2"), { isScopeMaster: true });
	assert.deepEqual(flags.get("s3"), { isScopeMaster: true });
	ok("P2a scope 解码 basename == 会话 cwd basename（Windows 大小写不敏感）");
	ok("P3 含空格仓库名 e39 编码形解码命中");
	ok("P4 -worktree 后缀先剥再解码命中");
}

// ── P5 解码失败（e39 + 非法 hex）→ 不标 ────────────────────────────────────────────
attachMaster({ sessionId: "bad1", agent: "agent://master_local_e39zz" }); // 奇数位 hex → 解码失败
attachMaster({ sessionId: "bad2", agent: "agent://master_local_e39ff" }); // 非法 UTF-8，Buffer 不抛但会替换为 U+FFFD
{
	const flags = computeSessionPinFlags([
		{ sessionId: "bad1", cwd: "C:\\x\\e39zz" }, // 即便 basename 字面相同也不标
		{ sessionId: "bad2", cwd: "C:\\x\\ufffd" }, // 非法 UTF-8 解码绝不可冒充同名 cwd
	]);
	assert.equal(flags.has("bad1"), false);
	assert.equal(flags.has("bad2"), false);
	ok("P5 解码失败（非法 hex 或 UTF-8）→ 不标该会话");
}

// ── P6 cwd 不匹配 / null / 空白 → 不标；POSIX 大小写精确 ──────────────────────────
// 注：s4 用 CaseRepo（与 P2 的 myrepo 不碰 Windows 大小写不敏感文件名碰撞——v1 已知局限）
attachMaster({ sessionId: "s4", agent: localMasterAddress(encodeScopeSegment("CaseRepo")) });
{
	const flags = computeSessionPinFlags([
		{ sessionId: "s4", cwd: "C:\\x\\Other" }, // Windows 不匹配
		{ sessionId: "s4", cwd: null },
		{ sessionId: "s4", cwd: "   " },
		{ sessionId: "s4", cwd: "/home/x/caserepo" }, // POSIX 大小写精确 → 不匹配
		{ sessionId: "s4", cwd: "/home/x/CaseRepo" }, // POSIX 精确匹配 → 标
	]);
	assert.equal(flags.has("s4") === true, true);
	assert.deepEqual(flags.get("s4"), { isScopeMaster: true });
	ok("P6 不匹配/null/空白不标；POSIX 大小写精确（/home/x/CaseRepo 命中、小写不命中）");
}

// ── P7 同名不同 owner → 不互标 ────────────────────────────────────────────────────
{
	const flags = computeSessionPinFlags([
		{ sessionId: "g1", cwd: "C:\\work\\myrepo" }, // 全局 master，basename 与 scope s1 同仓
	]);
	// g1 ≠ s1：全局 master 不是 s1 那个 scope 的 owner → 不标 isScopeMaster
	assert.deepEqual(flags.get("g1"), { isMaster: true });
	ok("P7 同名不同 owner → 不互标（g1 只 isMaster）");
}

// ── P8 passthrough e39 命名空间 round-trip ─────────────────────────────────────────
attachMaster({ sessionId: "s5", agent: localMasterAddress(encodeScopeSegment("e39deadbeef")) });
{
	// 仓库名本身以 e39 开头 → 落入保留命名空间走 hex 编码；解码还原原名
	assert.ok(encodeScopeSegment("e39deadbeef").startsWith("e39"), "e39 前缀名走编码分支");
	const flags = computeSessionPinFlags([{ sessionId: "s5", cwd: "C:\\x\\e39deadbeef" }]);
	assert.deepEqual(flags.get("s5"), { isScopeMaster: true });
	ok("P8 e39 命名空间 round-trip 命中");
}

// ── P9 双标 + Map 仅含有标条目 ─────────────────────────────────────────────────────
attachMaster({ sessionId: "g1", agent: localMasterAddress(encodeScopeSegment("y")) }); // 再给 g1 一个 scope
{
	const flags = computeSessionPinFlags([
		{ sessionId: "g1", cwd: "C:\\x\\y" }, // 全局 master + 本仓 scope master
		{ sessionId: "n1", cwd: "C:\\x\\y" }, // 无标
	]);
	assert.deepEqual(flags.get("g1"), { isMaster: true, isScopeMaster: true });
	assert.equal(flags.has("n1"), false);
	assert.equal(flags.size, 1, "Map 仅含至少一个标记的会话");
	ok("P9 同会话双标（isMaster + isScopeMaster）；无标会话不进 Map");
}

// ── P10 /v1/sessions E2E：端点条目挂 additive 字段（仅 true 挂出）────────────────
{
	const D = join(RUNTIME_ROOT, "e2e");
	const runtimeDir = join(D, "runtime");
	mkdirSync(runtimeDir, { recursive: true });
	mkdirSync(join(D, "timers", "sessions"), { recursive: true });
	const sessionsDir = join(D, "sessions");
	mkdirSync(sessionsDir, { recursive: true });
	// 独立注册表目录（不继承 P1-P9 的 attachment）
	process.env.PI_RUNTIME_DIR = runtimeDir;
	const sidG = "g-11111111-2222-3333-4444-555555555555";
	const sidS = "s-11111111-2222-3333-4444-555555555555";
	const sidN = "n-11111111-2222-3333-4444-555555555555";
	const w = (sid: string, cwd: string): void => {
		// JSON.stringify 保证 Windows 反斜杠正确转义（手写字符串会产生非法 JSON 头）
		const header = JSON.stringify({ type: "session", version: 3, id: sid, timestamp: "2026-09-22T14:00:00.000Z", cwd });
		writeFileSync(join(sessionsDir, `2026-09-22T14-00-00-000Z_${sid}.jsonl`), `${header}\n`, "utf8");
	};
	w(sidG, "C:\\e2e\\myrepo");
	w(sidS, "C:\\e2e\\myrepo");
	w(sidN, "C:\\e2e\\other");
	// 同一 registry 下：g 为全局 master（cwd 恰在本仓）；s 为本仓 scope master；n 无标
	attachMaster({ sessionId: sidG });
	attachMaster({ sessionId: sidS, agent: localMasterAddress(encodeScopeSegment("myrepo")) });

	const { createRuntimeHostServer } = await import("./runtime-host/server.ts");
	const h = await createRuntimeHostServer({
		hostPath: join(D, "host.json"),
		stateDir: join(D, "state"),
		journalPath: join(D, "events.jsonl"),
		timersDir: join(D, "timers"),
		mailboxDir: join(D, "mailbox"),
		sessionsDir,
	});
	try {
		const res = await fetch(`http://127.0.0.1:${h.info.port}/v1/sessions`);
		assert.equal(res.status, 200);
		const body = (await res.json()) as { sessions: Array<Record<string, unknown>> };
		const byId = new Map(body.sessions.map((s) => [s.sessionId as string, s]));
		assert.ok(byId.has(sidG) && byId.has(sidS) && byId.has(sidN), "三会话可列表");
		assert.equal(byId.get(sidG)!.isMaster, true, "E2E：全局 master 条目 isMaster");
		assert.equal(byId.get(sidG)!.masterProtected, true, "E2E：isMaster 与 masterProtected 同源");
		assert.equal(byId.get(sidG)!.isScopeMaster, undefined, "E2E：g 非本仓 scope owner → 不标 isScopeMaster");
		assert.equal(byId.get(sidS)!.isScopeMaster, true, "E2E：scope master 条目 isScopeMaster");
		assert.equal(byId.get(sidS)!.isMaster, undefined, "E2E：additive 仅 true 挂出（isMaster 缺省）");
		assert.equal(byId.get(sidN)!.isMaster, undefined, "E2E：无标会话两字段均缺省");
		assert.equal(byId.get(sidN)!.isScopeMaster, undefined);
		ok("P10 /v1/sessions E2E：条目 additive 挂 isMaster/isScopeMaster（仅 true）");
	} finally {
		await h.close();
	}
}

// 清理临时目录
try {
	rmSync(RUNTIME_ROOT, { recursive: true, force: true });
} catch {
	/* best effort */
}

console.log(`_test_session_pin: all assertions passed (${n})`);
