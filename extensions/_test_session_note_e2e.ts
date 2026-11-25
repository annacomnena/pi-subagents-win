/**
 * _test_session_note_e2e.ts — /v1/session-note 的**端到端**回归（设计稿 §8.2）。
 *
 * 真实入口：进程内起 createRuntimeHostServer（同一份生产 server.ts，全隔离注入）→
 * 真实 HTTP GET/POST → 真实 readSessionNote/writeSessionNote 落盘。
 * 变异必须打注册点（删 case / 改 POST 分支）才能红；只变异纯库函数体不算验证接线。
 *
 * 运行：npm run test:session-note-e2e
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 与 _test_s2_resume_e2e.ts 同款隔离：本套件会走 journal/claims 默认目录，不隔离会污染真实 agentDir。
process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "session-note-e2e-runtime-"));

import { createRuntimeHostServer } from "./runtime-host/server.ts";

let n = 0;
const ok = (msg: string): void => { n += 1; console.log(`ok ${n} - ${msg}`); };

interface Resp { status: number; etag: string | null; body: any }
async function req(port: number, path: string, opts: { method?: string; token?: string; body?: unknown; inm?: string } = {}): Promise<Resp> {
	const headers: Record<string, string> = {};
	if (opts.token !== undefined) headers["x-command-token"] = opts.token;
	if (opts.body !== undefined) headers["content-type"] = "application/json";
	if (opts.inm !== undefined) headers["if-none-match"] = opts.inm;
	const res = await fetch(`http://127.0.0.1:${port}${path}`, {
		method: opts.method ?? "GET",
		headers,
		...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
	});
	const text = await res.text();
	let body: unknown = null;
	try { body = text.length > 0 ? JSON.parse(text) : null; } catch { /* 非 JSON 原样忽略，断言看 status */ }
	return { status: res.status, etag: res.headers.get("etag"), body };
}

const D = mkdtempSync(join(tmpdir(), "session-note-e2e-"));
const stateDir = join(D, "state");
const sessionsDir = join(D, "sessions");
const agentDir = join(D, "agent");
const cfgPath = join(D, "config.json");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });
writeFileSync(cfgPath, JSON.stringify({ gui: { autoStart: false } }), "utf8");
const SID = "b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e";

const handle = await createRuntimeHostServer({
	hostPath: join(D, "host.json"),
	stateDir,
	sessionsDir,
	agentDir,
	configPath: cfgPath,
	journalPath: join(D, "events.jsonl"),
	tabRunsDir: join(D, "tab-runs"),
	runsDir: join(D, "runs"),
	distDir: join(D, "dist"),
	lockWaitMs: 0,
});
try {
	const port = handle.info.port;
	const token = handle.info.token;
	const path = `/v1/session-note?sessionId=${SID}`;

	const empty = await req(port, path);
	assert.equal(empty.status, 200, JSON.stringify(empty.body));
	assert.equal(empty.body.ok, true);
	assert.equal(empty.body.note.version, 0);
	assert.equal(empty.body.note.text, "");
	assert.ok(empty.etag !== null, "GET 必须带 ETag");
	ok("1. GET 空 note → 200 + ETag（文件不存在不 404）");

	const inm = await req(port, path, { inm: empty.etag! });
	assert.equal(inm.status, 304);
	ok("2. If-None-Match 命中 → 304");

	const badToken = await req(port, path, { method: "POST", token: "definitely-wrong", body: { sessionId: SID, text: "x" } });
	assert.equal(badToken.status, 401, JSON.stringify(badToken.body));
	const noTokenGet = await req(port, path);
	assert.equal(noTokenGet.status, 200, "GET 读投影与 /v1/sessions 一样本机不鉴权（设计稿 §3.2）");
	ok("3. POST 错 token → 401；GET 无 token → 200（不开新鉴权面）");

	const w1 = await req(port, "/v1/session-note", {
		method: "POST", token,
		body: { sessionId: SID, text: "## 给 agent 的规则\n- 改完必须 build", expectedVersion: 0 },
	});
	assert.equal(w1.status, 200, JSON.stringify(w1.body));
	assert.equal(w1.body.note.version, 1);
	const afterWrite = await req(port, path);
	assert.equal(afterWrite.status, 200);
	assert.equal(afterWrite.body.note.text, w1.body.note.text);
	assert.equal(afterWrite.body.note.version, 1);
	ok("4. POST 写入 → version=1；再 GET 读回同一份（消费面验证）");

	const conflict = await req(port, "/v1/session-note", {
		method: "POST", token,
		body: { sessionId: SID, text: "should-not-win", expectedVersion: 0 },
	});
	assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
	assert.equal(conflict.body.error, "version-conflict");
	assert.equal(conflict.body.current.version, 1);
	assert.equal((await req(port, path)).body.note.text, w1.body.note.text, "冲突不得覆盖原文件");
	ok("5. 冲突 expectedVersion → 409 + current，原文件不动");

	const badSid = await req(port, "/v1/session-note?sessionId=..%2Fetc%2Fpasswd");
	assert.equal(badSid.status, 400, JSON.stringify(badSid.body));
	const tooLong = await req(port, "/v1/session-note", {
		method: "POST", token,
		body: { sessionId: SID, text: "x".repeat(70 * 1024) }, // 70KiB < 128KiB body 限，> 64KiB 正文限
	});
	assert.equal(tooLong.status, 413, JSON.stringify(tooLong.body));
	ok("6. 非法 sid → 400；超长 text → 413");

	// 坏文件：必须 500 + 明确错误，不能伪装成空 note（R-2 的核心断言）
	const BAD_SID = "c2d3e4f5-a6b7-4c8d-9e0f-1a2b3c4d5e6f";
	writeFileSync(join(agentDir, "session-notes", `${BAD_SID}.json`), "{ broken", "utf8");
	const corrupt = await req(port, `/v1/session-note?sessionId=${BAD_SID}`);
	assert.equal(corrupt.status, 500, JSON.stringify(corrupt.body));
	assert.equal(corrupt.body.error, "corrupt");
	assert.notEqual(corrupt.body.note?.text, "");
	ok("7. 坏 JSON 文件 → 500 corrupt（不伪装成空便签）");

	// 方法守卫：POST 在 405 之前；PUT 这种非 GET 非 POST 仍应被读投影守卫拦住
	const put = await req(port, path, { method: "PUT", token });
	assert.equal(put.status, 405, JSON.stringify(put.body));
	ok("8. PUT → 405（写端点只开 POST，读投影仍只 GET）");
} finally {
	await handle.close();
	for (const d of [D, process.env.PI_RUNTIME_DIR!]) {
		try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
	}
}
console.log(`\n[session-note-e2e] ${n} passed`);
