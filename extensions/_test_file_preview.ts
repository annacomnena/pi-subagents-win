/**
 * _test_file_preview.ts — 2026-11-20 GUI 文档预览端到端（真实 HTTP 路由，不直调纯函数判定接线）。
 *
 * 覆盖：
 *  T1 未带 token ⇒ 401（鉴权同 /v1/commands）
 *  T2 POST /v1/files/read 读 UTF-8 / GBK / 相对路径（cwd 生效）/ 目录 / 二进制 / 大文件 / 不存在
 *  T3 控制字符 / URL / 坏 body ⇒ 400，且给出 hint（静默失效禁止）
 *  T4 open/reveal 经过 server 路由到注入的 launcher（真实接线；不弹真 explorer）
 *  T5 GET 这些路径 ⇒ 405（写端点不混进读投影）
 *
 * 运行：node --experimental-strip-types --import ./extensions/runtime-host/pi-deps-loader.mjs ./extensions/_test_file_preview.ts
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, parse } from "node:path";

const D = mkdtempSync(join(tmpdir(), "file-preview-test-"));
process.env.PI_RUNTIME_DIR = D;

const { createRuntimeHostServer } = await import("./runtime-host/server.ts");
const { FILE_PREVIEW_MAX_BYTES, launchSystemAction, deriveWorkspaceRoots } = await import("./runtime-host/file-preview.ts");

const launchCalls: Array<{ action: string; path: string }> = [];
let launcherShouldFail = false;
const h = await createRuntimeHostServer({
	hostPath: join(D, "host.json"),
	timersDir: join(D, "timers"),
	stateDir: join(D, "state"),
	mailboxDir: join(D, "mailbox"),
	journalPath: join(D, "events.jsonl"),
	distDir: join(D, "dist"),
	// N-6：reconciler 等后台循环读的 runs 目录也隔离，杜绝测试进程扫真实 ~/.pi/agent/subagent-runs
	runsDir: join(D, "runs"),
	sessionsDir: join(D, "sessions"),
	agentDir: join(D, "agent"),
	systemActionLauncher: async (action, path) => {
		launchCalls.push({ action, path });
		if (launcherShouldFail) return { ok: false, error: "launch-failed", hint: "stub: 外部程序启动失败" };
		return { ok: true, launched: true };
	},
	// 范围固定为夹具目录：任何其他路径（含真实会话 cwd）都必须被挡住
	fileRootsProvider: () => [D],
});
const base = `http://127.0.0.1:${h.info.port}`;
const auth = { "X-Command-Token": h.info.token! };

const post = (p: string, body: unknown, headers: Record<string, string> = auth) =>
	fetch(`${base}${p}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});

let passed = 0;
const ok = (label: string): void => {
	passed += 1;
	console.log(`  ok  ${label}`);
};

try {
	// 夹具：UTF-8 Markdown / GBK 中文 / 二进制 / 大文件 / 子目录
	mkdirSync(join(D, "plans", "sub"), { recursive: true });
	const mdPath = join(D, "plans", "report.md");
	writeFileSync(mdPath, "# 报告\n\n正文中文 ✅\n", "utf8");
	writeFileSync(join(D, "plans", "sub", "nested.md"), "nested", "utf8");
	writeFileSync(join(D, "gbk.md"), Buffer.from([0xd6, 0xd0, 0xce, 0xc4])); // 中文（GBK）
	writeFileSync(join(D, "bin.md"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
	writeFileSync(join(D, "huge.txt"), Buffer.alloc(FILE_PREVIEW_MAX_BYTES * 9, 0x41));

	// T1 鉴权
	{
		const r = await fetch(`${base}/v1/files/read`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
		assert.equal(r.status, 401);
		ok("T1 无 token ⇒ 401");
	}

	// T2 read 各分支
	{
		const r = await post("/v1/files/read", { path: mdPath });
		assert.equal(r.status, 200);
		const d = await r.json() as { content: string; encoding: string; path: string; size: number; truncated: boolean };
		assert.match(d.content, /正文中文 ✅/);
		assert.equal(d.encoding, "utf-8");
		assert.equal(d.path, mdPath);
		assert.equal(d.truncated, false);
		ok("T2a 绝对路径 UTF-8 预览");
	}
	{
		const r = await post("/v1/files/read", { path: "plans/sub/nested.md", cwd: D });
		assert.equal(r.status, 200);
		const d = await r.json() as { content: string; path: string; base: string };
		assert.equal(d.content, "nested");
		assert.equal(d.path, join(D, "plans", "sub", "nested.md"));
		assert.equal(d.base, D);
		ok("T2b 相对路径按 cwd 解析");
	}
	{
		const r = await post("/v1/files/read", { path: join(D, "gbk.md") });
		assert.equal(r.status, 200);
		const d = await r.json() as { content: string; encoding: string };
		assert.equal(d.content, "中文");
		assert.equal(d.encoding, "gb18030");
		ok("T2c GBK 回退解码");
	}
	{
		const r = await post("/v1/files/read", { path: join(D, "bin.md") });
		assert.equal(r.status, 400);
		assert.equal((await r.json() as { error: string }).error, "binary");
		ok("T2d 二进制拒绝");
	}
	{
		const r = await post("/v1/files/read", { path: join(D, "huge.txt") });
		assert.equal(r.status, 413);
		assert.equal((await r.json() as { error: string }).error, "too-large");
		ok("T2e 大文件拒绝");
	}
	{
		const r = await post("/v1/files/read", { path: join(D, "plans") });
		assert.equal(r.status, 400);
		assert.equal((await r.json() as { error: string }).error, "is-directory");
		ok("T2f 目录不冒充文件");
	}
	{
		const r = await post("/v1/files/read", { path: join(D, "nope.md") });
		assert.equal(r.status, 404);
		assert.equal((await r.json() as { error: string }).error, "not-found");
		ok("T2g 不存在 ⇒ 404");
	}

	// T3 坏输入必须出声（AGENTS.md §2 静默失效禁止）
	{
		const r = await post("/v1/files/read", { path: "a\u0000b" });
		assert.equal(r.status, 400);
		const d = await r.json() as { error: string; hint: string };
		assert.equal(d.error, "bad-path");
		assert.ok(d.hint.length > 0);
	}
	{
		const r = await post("/v1/files/read", { path: "https://example.com/a.md" });
		assert.equal(r.status, 400);
		assert.equal((await r.json() as { error: string }).error, "bad-path");
	}
	{
		const r = await fetch(`${base}/v1/files/read`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{bad" });
		assert.equal(r.status, 400);
		assert.equal((await r.json() as { error: string }).error, "invalid-body");
		ok("T3 坏输入/URL/坏 JSON ⇒ 400 + hint");
	}

	// T4 open/reveal 真实接线（注入 launcher，验证路由 → 解析 → launcher 的参数）
	{
		const r = await post("/v1/files/open", { path: mdPath });
		assert.equal(r.status, 200);
		const d = await r.json() as { ok: boolean; action: string; path: string; launched: boolean };
		assert.deepEqual({ ok: d.ok, action: d.action, path: d.path, launched: d.launched }, { ok: true, action: "open", path: mdPath, launched: true });
		const rr = await post("/v1/files/reveal", { path: mdPath });
		assert.equal(rr.status, 200);
		assert.equal((await rr.json() as { action: string }).action, "reveal");
		assert.deepEqual(launchCalls, [
			{ action: "open", path: mdPath },
			{ action: "reveal", path: mdPath },
		]);
		ok("T4 open/reveal 经真实 HTTP 路由到 launcher");
	}

	// T5 写端点不混入读投影
	{
		const r = await fetch(`${base}/v1/files/read`, { headers: auth });
		assert.equal(r.status, 405);
		ok("T5 GET ⇒ 405");
	}

	// T6 L4 阻断项回归：open 的范围门禁 / UNC / ADS / 可执行文件 / 启动失败回流
	{
		// 范围门禁只加在 open 上：read/reveal 只读/定位，不按工作区挡（否则家目录里的文档看不了）。
		const outsideDir = mkdtempSync(join(tmpdir(), "file-preview-outside-scope-"));
		try {
			const outsideMd = join(outsideDir, "out.md");
			writeFileSync(outsideMd, "OUT", "utf8");
			const outsideOpen = await post("/v1/files/open", { path: outsideMd });
			assert.equal(outsideOpen.status, 400, "open 越界必须拒");
			assert.equal((await outsideOpen.json() as { error: string }).error, "out-of-scope");
			const outsideRead = await post("/v1/files/read", { path: outsideMd });
			assert.equal(outsideRead.status, 200, "readonly 预览不该被工作区挡住");
			assert.equal((await outsideRead.json() as { content: string }).content, "OUT");
		} finally {
			rmSync(outsideDir, { recursive: true, force: true });
		}
		const escape = await post("/v1/files/open", { path: "../escape.md", cwd: D });
		assert.equal(escape.status, 400);
		assert.equal((await escape.json() as { error: string }).error, "out-of-scope");
		const unc = await post("/v1/files/read", { path: "\\\\attacker\\share\\evil.bat" });
		assert.equal(unc.status, 400);
		assert.equal((await unc.json() as { error: string }).error, "bad-path");
		const ads = await post("/v1/files/read", { path: `${mdPath}:stream` });
		assert.equal(ads.status, 400);
		assert.equal((await ads.json() as { error: string }).error, "bad-path");
		ok("T6a open 越界/逃逸被拒；read 越界可读；UNC/ADS 全被拒");

		for (const name of ["evil.bat", "payload.py", "payload.js", "run.ps1"]) writeFileSync(join(D, name), "payload\n");
		for (const name of ["evil.bat", "payload.py", "payload.js", "run.ps1"]) {
			const exec = await post("/v1/files/open", { path: join(D, name) });
			assert.equal(exec.status, 400, `open ${name} must be rejected`);
			assert.equal((await exec.json() as { error: string }).error, "executable-rejected");
		}
		assert.equal(launchCalls.length, 2, "脚本/可执行文件绝不进 launcher（T4 两次，本轮全被拒）");
		const revealBat = await post("/v1/files/reveal", { path: join(D, "evil.bat") });
		assert.equal(revealBat.status, 200); // reveal（定位）仍可用
		ok("T6b .bat/.py/.js/.ps1 拒绝执行但允许定位");

		launcherShouldFail = true;
		const failed = await post("/v1/files/open", { path: mdPath });
		assert.equal(failed.status, 400);
		const fe = await failed.json() as { error: string; hint: string };
		assert.equal(fe.error, "launch-failed");
		assert.match(fe.hint, /stub/);
		launcherShouldFail = false;
		ok("T6c 启动失败回流到 HTTP（不再吞掉报成功）");
	}

	// T7 L4 二轮：真实 launchSystemAction 的 error/exit 回流 + 允许根收窄
	{
		type spawnStub = (...args: unknown[]) => EventEmitter;
		const fakeSpawn = (event: "error" | "exit"): spawnStub => {
			return ((..._args: unknown[]) => {
				const e = new EventEmitter() as EventEmitter & { unref(): void };
				e.unref = (): void => {};
				queueMicrotask(() => (event === "error" ? e.emit("error", new Error("ENOENT stub")) : e.emit("exit", 9)));
				return e;
			}) as spawnStub;
		};
		const errRes = await launchSystemAction("open", mdPath, fakeSpawn("error") as never);
		assert.equal(errRes.ok, false);
		assert.equal(errRes.error, "launch-failed");
		const exitRes = await launchSystemAction("open", mdPath, fakeSpawn("exit") as never);
		assert.equal(exitRes.ok, false);
		assert.equal(exitRes.error, "launch-failed");
		// 真实顺序：先 spawn 再非零 exit（explorer 启动成功但无关联程序）——必须在 300ms 观察窗内判失败
		const spawnThenExit = (() => {
			const e = new EventEmitter() as EventEmitter & { unref(): void };
			e.unref = (): void => {};
			queueMicrotask(() => { e.emit("spawn"); e.emit("exit", 9); });
			return e;
		})();
		const seqRes = await launchSystemAction("open", mdPath, (() => spawnThenExit) as never);
		assert.equal(seqRes.ok, false, "spawn→非零 exit 不得报成功");
		assert.equal(seqRes.error, "launch-failed");
		// N-2：exit(null) = 被信号杀死，不能当成功
		const signalExit = (() => {
			const e = new EventEmitter() as EventEmitter & { unref(): void };
			e.unref = (): void => {};
			queueMicrotask(() => { e.emit("spawn"); e.emit("exit", null, "SIGTERM"); });
			return e;
		})();
		const sigRes = await launchSystemAction("open", mdPath, (() => signalExit) as never);
		assert.equal(sigRes.ok, false, "exit(null)/被信号杀死不得报成功");
		assert.equal(sigRes.error, "launch-failed");
		ok("T7a error / 非零 exit / spawn→exit / exit(null) 四种失败都回流");

		const roots = deriveWorkspaceRoots([homedir(), tmpdir(), parse(homedir()).root, join(D, "sub")], join(D, "daemon"));
		assert.equal(roots.includes(homedir()), false, "家目录不得是允许根");
		assert.equal(roots.includes(tmpdir()), false, "临时目录不得是允许根");
		assert.equal(roots.includes(parse(homedir()).root), false, "盘符根 C:\\ 不得是允许根");
		assert.ok(roots.includes(join(D, "sub")));
		// N'-2：daemon 从盘根启动且无会话 ⇒ 推导为空（兜底不得把过宽根放回）
		const emptyRoots = deriveWorkspaceRoots([], parse(homedir()).root);
		assert.equal(emptyRoots.length, 0, "盘根 daemon + 无会话必须推导为空，避免兜底放回过宽根");
		ok("T7b 允许根剔除家目录/临时目录/盘符根 + 空集兜底不自相矛盾");
	}

	// T8 glm-5.3 I-1：cwd 侧也必须过形状/UNC 检查（变异 cwd 检查必须红）
	{
		const uncCwd = await post("/v1/files/read", { path: "a.md", cwd: "\\\\attacker\\share" });
		assert.equal(uncCwd.status, 400);
		assert.equal((await uncCwd.json() as { error: string }).error, "bad-cwd", "UNC cwd 不得进入 statSync");
		const adsCwd = await post("/v1/files/read", { path: "a.md", cwd: `${D}:stream` });
		assert.equal(adsCwd.status, 400);
		assert.equal((await adsCwd.json() as { error: string }).error, "bad-cwd");
		const ctrlCwd = await post("/v1/files/read", { path: "a.md", cwd: `${D}\u0000` });
		assert.equal(ctrlCwd.status, 400);
		assert.equal((await ctrlCwd.json() as { error: string }).error, "bad-cwd");
		const fileAsCwd = await post("/v1/files/read", { path: "x.md", cwd: mdPath });
		assert.equal(fileAsCwd.status, 400, "cwd 是文件不得静默回退 daemonCwd");
		assert.equal((await fileAsCwd.json() as { error: string }).error, "bad-cwd");
		ok("T8 cwd 的 UNC/ADS/控制字符/非目录全被拒（I-1 变异必须红）");
	}

	// T9 glm-5.3 I-2：工作区内 junction/symlink 指向根外 ⇒ realpath 二次判范围拦截
	{
		const outsideDir = mkdtempSync(join(tmpdir(), "file-preview-outside-"));
		const secret = join(outsideDir, "secret.md");
		writeFileSync(secret, "TOP-SECRET", "utf8");
		const linkDir = join(D, "linked");
		mkdirSync(linkDir, { recursive: true });
		let linkMade = false;
		try {
			// junction 优先（Windows 无需管理员权限）；失败退回 dir symlink；都不行则跳过并如实说明。
			try { symlinkSync(outsideDir, join(linkDir, "escape"), "junction"); linkMade = true; }
			catch { try { symlinkSync(outsideDir, join(linkDir, "escape"), "dir"); linkMade = true; } catch { /* 平台不支持 */ } }
		} catch { /* ignore */ }
		if (linkMade) {
			// 范围/realpath 门禁只加在 open：经链接指向根外时 open 必须拒；
			// read/reveal 只是显示文本/定位，不执行目标，按策略放行。
			const viaLinkOpen = await post("/v1/files/open", { path: join(linkDir, "escape", "secret.md") });
			assert.equal(viaLinkOpen.status, 400, "open 经链接指向根外必须被拒");
			assert.equal((await viaLinkOpen.json() as { error: string }).error, "out-of-scope");
			const viaLinkRead = await post("/v1/files/read", { path: join(linkDir, "escape", "secret.md") });
			assert.equal(viaLinkRead.status, 200, "只读预览不按工作区挡");
			assert.equal((await viaLinkRead.json() as { content: string }).content, "TOP-SECRET");
			const revealLink = await post("/v1/files/reveal", { path: join(linkDir, "escape", "secret.md") });
			assert.equal(revealLink.status, 200, "reveal 只定位不执行，放行");
			// N'-3：cwd 本身是指向根外的 junction ⇒ strict 模式词法在 D 内但 realpath 落根外，open 必须拒绝
			const cwdLinkOpen = await post("/v1/files/open", { path: "secret.md", cwd: join(linkDir, "escape") });
			assert.equal(cwdLinkOpen.status, 400, "open 时 cwd 经 junction 指向根外必须被拒");
			assert.equal((await cwdLinkOpen.json() as { error: string }).error, "out-of-scope");
			ok("T9 junction 逃逸在 open 被 realpath 拦截；read/reveal 按只读策略放行");
		} else {
			ok("T9 跳过（当前平台/权限不支持创建 junction，已如实标注）");
		}
		rmSync(outsideDir, { recursive: true, force: true });
	}

	// T10 glm-5.3 I-4：不注入 fileRootsProvider，验证 deriveWorkspaceRoots 的生产接线
	// （sessionsDir 扫描 → cwd 入根 → HTTP 判定）。变异 server 的 listPiSessions push/缓存必须红。
	{
		const D2 = mkdtempSync(join(tmpdir(), "file-preview-roots-"));
		const sessionsDir = join(D2, "sessions");
		const wsRoot = join(D2, "ws-root");
		mkdirSync(sessionsDir, { recursive: true });
		mkdirSync(wsRoot, { recursive: true });
		writeFileSync(join(sessionsDir, "s1.jsonl"), `${JSON.stringify({ id: "s1", cwd: wsRoot, timestamp: "2026-01-01T00:00:00Z" })}\n`, "utf8");
		writeFileSync(join(wsRoot, "in.md"), "IN-SCOPE", "utf8");
		const outside2 = mkdtempSync(join(tmpdir(), "file-preview-out2-"));
		writeFileSync(join(outside2, "out.md"), "OUT", "utf8");

		const h2 = await createRuntimeHostServer({
			hostPath: join(D2, "host.json"),
			timersDir: join(D2, "timers"),
			stateDir: join(D2, "state"),
			mailboxDir: join(D2, "mailbox"),
			journalPath: join(D2, "events.jsonl"),
			distDir: join(D2, "dist"),
			runsDir: join(D2, "runs"),
			sessionsDir,
			agentDir: join(D2, "agent"),
			// 注意：不注入 fileRootsProvider（roots 仍走真实会话扫描）；
			// 只注入 launcher，避免真实 explorer 无关联程序时把 200 变成 launch-failed。
			systemActionLauncher: async () => ({ ok: true, launched: true }),
		});
		try {
			const base2 = `http://127.0.0.1:${h2.info.port}`;
			const auth2 = { "X-Command-Token": h2.info.token!, "content-type": "application/json" };
			const inRes = await fetch(`${base2}/v1/files/read`, {
				method: "POST", headers: auth2, body: JSON.stringify({ path: join(wsRoot, "in.md") }),
			});
			assert.equal(inRes.status, 200, "会话 cwd 下文件应可读（生产 roots 接线生效）");
			assert.equal((await inRes.json() as { content: string }).content, "IN-SCOPE");
			// 生产 roots 只守 open；只读预览按策略放行工作区外文件
			const outRead = await fetch(`${base2}/v1/files/read`, {
				method: "POST", headers: auth2, body: JSON.stringify({ path: join(outside2, "out.md") }),
			});
			assert.equal(outRead.status, 200, "read 不按工作区挡");
			assert.equal((await outRead.json() as { content: string }).content, "OUT");
			const outOpen = await fetch(`${base2}/v1/files/open`, {
				method: "POST", headers: auth2, body: JSON.stringify({ path: join(outside2, "out.md") }),
			});
			assert.equal(outOpen.status, 400, "open 越界必须被拒（生产 roots 接线生效）");
			assert.equal((await outOpen.json() as { error: string }).error, "out-of-scope");
			const inOpen = await fetch(`${base2}/v1/files/open`, {
				method: "POST", headers: auth2, body: JSON.stringify({ path: join(wsRoot, "in.md") }),
			});
			assert.equal(inOpen.status, 200, "会话 cwd 内文件允许 open");
			ok("T10 生产 roots 接线（会话 cwd 入根 + open 越界拒绝）经真实 HTTP 生效");
		} finally {
			await h2.close();
			rmSync(D2, { recursive: true, force: true });
			rmSync(outside2, { recursive: true, force: true });
		}
	}

	// T11 用户实测场景：会话 cwd 是家目录、agent 给的路径相对仓库 ⇒ 只读预览必须能找到文件
	{
		const relName = "relaxed-cwd-fallback.md";
		writeFileSync(join(D, relName), "FOUND-VIA-FALLBACK", "utf8");
		const read = await post("/v1/files/read", { path: relName, cwd: homedir() });
		assert.equal(read.status, 200, "cwd=家目录 + 相对路径应经候选基准找到文件（变异 relaxed 搜索必须红）");
		const rd = await read.json() as { path: string; base: string; content: string };
		assert.equal(rd.path, join(D, relName));
		assert.equal(rd.base, D, "应把实际命中的基准回给前端展示");
		assert.equal(rd.content, "FOUND-VIA-FALLBACK");
		const open = await post("/v1/files/open", { path: relName, cwd: homedir() });
		assert.equal(open.status, 400, "同一路径的 open 仍受 strict 工作区门禁（家目录不是允许根）");
		assert.equal((await open.json() as { error: string }).error, "out-of-scope");
		ok("T11 家目录 cwd + 相对路径只读可预览、open 仍被拒（按动作分级）");
	}

	console.log(`\nFILE_PREVIEW_E2E_OK passed=${passed}`);
} finally {
	await h.close();
	rmSync(D, { recursive: true, force: true });
}
