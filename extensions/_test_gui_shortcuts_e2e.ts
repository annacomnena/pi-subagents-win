/**
 * _test_gui_shortcuts_e2e.ts — /v1/gui/shortcuts 系列端点的端到端回归（P1+P2）。
 *
 * 真实入口：进程内起 createRuntimeHostServer（同一份生产 server.ts，全隔离注入）→
 * 真实 HTTP GET/POST → 真实 gui-shortcuts.ts 落盘。变异必须打注册点（删 case / 改 POST 分支）
 * 才能红；只变异纯库函数体不算验证接线（AGENTS.md §4.2）。
 *
 * 运行：npm run test:gui-shortcuts-e2e
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "gui-shortcuts-e2e-runtime-"));

import { createRuntimeHostServer } from "./runtime-host/server.ts";

let n = 0;
const ok = (msg: string): void => { n += 1; console.log(`ok ${n} - ${msg}`); };

interface Resp { status: number; body: any }
async function req(port: number, path: string, opts: { method?: string; token?: string; body?: unknown } = {}): Promise<Resp> {
	const headers: Record<string, string> = {};
	if (opts.token !== undefined) headers["x-command-token"] = opts.token;
	if (opts.body !== undefined) headers["content-type"] = "application/json";
	const res = await fetch(`http://127.0.0.1:${port}${path}`, {
		method: opts.method ?? "GET", headers,
		...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
	});
	const text = await res.text();
	let body: unknown = null;
	try { body = text.length > 0 ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
	return { status: res.status, body };
}

const D = mkdtempSync(join(tmpdir(), "gui-shortcuts-e2e-"));
const stateDir = join(D, "state");
const sessionsDir = join(D, "sessions");
const agentDir = join(D, "agent");
const shortcutsDir = join(D, "gui-shortcuts");
const cfgPath = join(D, "config.json");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });
writeFileSync(cfgPath, JSON.stringify({ gui: { autoStart: false } }), "utf8");
const CWD = "G:/code/GreenCAD";
const q = encodeURIComponent(CWD);

const handle = await createRuntimeHostServer({
	hostPath: join(D, "host.json"),
	stateDir, sessionsDir, agentDir, shortcutsDir,
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
	const GET = `/v1/gui/shortcuts?cwd=${q}`;

	// ── P1: 读空配置 ──
	const empty = await req(port, GET);
	assert.equal(empty.status, 200, JSON.stringify(empty.body));
	assert.equal(empty.body.ok, true);
	assert.equal(empty.body.exists, false);
	assert.equal(empty.body.config.actions.length, 0);
	assert.equal(typeof empty.body.contentHash, "string");
	const h0 = empty.body.contentHash;
	ok("GET 空配置 → 200 空 actions + contentHash");

	// ── 鉴权：无 token 的 POST 401 ──
	const noAuth = await req(port, "/v1/gui/shortcuts", {
		method: "POST", token: "wrong", body: { cwd: CWD, expectedHash: h0, action: {} },
	});
	assert.equal(noAuth.status, 401, JSON.stringify(noAuth.body));
	ok("POST 无/错 token → 401（沿用 authorizeCommand）");

	// ── P1: 新增 url action ──
	const urlAction = { id: "ci", label: "CI 面板", kind: "url", url: "http://localhost:8080" };
	const w1 = await req(port, "/v1/gui/shortcuts", {
		method: "POST", token, body: { cwd: CWD, expectedHash: h0, action: urlAction },
	});
	assert.equal(w1.status, 200, JSON.stringify(w1.body));
	assert.equal(w1.body.config.actions.length, 1);
	assert.equal(w1.body.config.actions[0].id, "ci");
	const h1 = w1.body.contentHash;
	assert.notEqual(h1, h0);
	ok("POST 新增 url action → 200，hash 变化");

	// ── P1: 乐观锁冲突（用旧 hash）──
	const stale = await req(port, "/v1/gui/shortcuts", {
		method: "POST", token, body: { cwd: CWD, expectedHash: h0, action: { id: "x", label: "X", kind: "url", url: "http://x.com" } },
	});
	assert.equal(stale.status, 409, JSON.stringify(stale.body));
	assert.equal(stale.body.error, "conflict");
	ok("POST 用过期 hash → 409 conflict（不覆盖）");

	// ── 校验：危险 script command（含路径分隔符）被拒 ──
	const badScript = await req(port, "/v1/gui/shortcuts", {
		method: "POST", token, body: { cwd: CWD, expectedHash: h1, action: { id: "b", label: "B", kind: "script", command: "../evil.ps1", confirm: true } },
	});
	assert.equal(badScript.status, 400, JSON.stringify(badScript.body));
	ok("POST 非法 script command（含 ..）→ 400");

	// ── P1: 再读，确认落盘 ──
	const reread = await req(port, GET);
	assert.equal(reread.body.config.actions.length, 1);
	assert.equal(reread.body.contentHash, h1);
	assert.equal(reread.body.exists, true);
	ok("GET 复核 → 配置已落盘，hash 稳定");

	// ── P1: 删除 action ──
	const del = await req(port, "/v1/gui/shortcuts/delete", {
		method: "POST", token, body: { cwd: CWD, id: "ci", expectedHash: h1 },
	});
	assert.equal(del.status, 200, JSON.stringify(del.body));
	assert.equal(del.body.config.actions.length, 0);
	const h2 = del.body.contentHash;
	ok("POST delete → 200，action 已删除");

	// ── P2: agent 写提案文件 + GET 看到提案卡 ──
	const { createHash } = await import("node:crypto");
	const PROPOSAL_ID = createHash("sha256").update("proposal-1").digest("hex").slice(0, 32);
	const proposal = {
		version: 1, proposalId: PROPOSAL_ID, cwd: CWD, baseHash: h2,
		reason: "加个编译按钮", sourceSession: "a3f2-session", createdAt: new Date().toISOString(),
		ops: [{ op: "add", action: { id: "build", label: "编译", kind: "script", command: "build.ps1", args: ["-c", "Release"], confirm: true } }],
	};
	mkdirSync(join(shortcutsDir, "proposals"), { recursive: true });
	writeFileSync(join(shortcutsDir, "proposals", `${PROPOSAL_ID}.json`), JSON.stringify(proposal), "utf8");
	const withProposal = await req(port, GET);
	assert.equal(withProposal.body.proposals.length, 1, JSON.stringify(withProposal.body.proposals));
	assert.equal(withProposal.body.proposals[0].status, "pending");
	assert.equal(withProposal.body.proposals[0].proposal.proposalId, PROPOSAL_ID);
	ok("agent 写提案文件 → GET 显示 pending 提案卡");

	// ── P2: 点同意 → 决策记录落盘 ──
	const decide = await req(port, "/v1/gui/shortcuts/proposal/decide", {
		method: "POST", token, body: { cwd: CWD, proposalId: PROPOSAL_ID, decision: "approved" },
	});
	assert.equal(decide.status, 200, JSON.stringify(decide.body));
	assert.equal(decide.body.decision.decision, "approved");
	const afterDecide = await req(port, GET);
	assert.equal(afterDecide.body.proposals[0].status, "approved");
	ok("POST decide approved → 提案变 approved");

	// ── P2: 重复同意幂等 ──
	const decide2 = await req(port, "/v1/gui/shortcuts/proposal/decide", {
		method: "POST", token, body: { cwd: CWD, proposalId: PROPOSAL_ID, decision: "approved" },
	});
	assert.equal(decide2.status, 200);
	assert.equal(decide2.body.decision.decidedAt, decide.body.decision.decidedAt);
	ok("重复 decide → 幂等（decidedAt 不变）");

	// ── P2: 模拟 agent 用 Write 改主配置 → GET 推断 applied ──
	const cfgPathShortcuts = join(shortcutsDir, `${(await import("./gui-shortcuts.ts")).repoKey(CWD)}.json`);
	const appliedConfig = {
		version: 1, cwd: CWD, updatedAt: new Date().toISOString(),
		actions: [{ id: "build", label: "编译", kind: "script", command: "build.ps1", args: ["-c", "Release"], timeoutMs: 120000, confirm: true }],
	};
	writeFileSync(cfgPathShortcuts, JSON.stringify(appliedConfig), "utf8");
	const afterAgent = await req(port, GET);
	assert.equal(afterAgent.body.proposals[0].status, "applied");
	assert.equal(afterAgent.body.config.actions[0].id, "build");
	ok("agent 直写主配置 → GET 推断 applied");

	// ── P2: host 降级应用（另一个提案）──
	const PID2 = createHash("sha256").update("proposal-2").digest("hex").slice(0, 32);
	const proposal2 = {
		version: 1, proposalId: PID2, cwd: CWD, baseHash: afterAgent.body.contentHash,
		reason: "加 CI", sourceSession: "a3f2-session", createdAt: new Date().toISOString(),
		ops: [{ op: "add", action: { id: "ci2", label: "CI", kind: "url", url: "http://ci.local" } }],
	};
	writeFileSync(join(shortcutsDir, "proposals", `${PID2}.json`), JSON.stringify(proposal2), "utf8");
	await req(port, "/v1/gui/shortcuts/proposal/decide", { method: "POST", token, body: { cwd: CWD, proposalId: PID2, decision: "approved" } });
	const hostApply = await req(port, "/v1/gui/shortcuts/host-apply", {
		method: "POST", token, body: { cwd: CWD, proposalId: PID2 },
	});
	assert.equal(hostApply.status, 200, JSON.stringify(hostApply.body));
	assert.equal(hostApply.body.applied, true);
	assert.equal(hostApply.body.config.actions.length, 2);
	ok("host-apply → 服务端合并 ops，配置 2 项");

	// ── 幂等：再次 host-apply 不重复 ──
	const hostApply2 = await req(port, "/v1/gui/shortcuts/host-apply", {
		method: "POST", token, body: { cwd: CWD, proposalId: PID2 },
	});
	assert.equal(hostApply2.status, 200);
	assert.equal(hostApply2.body.config.actions.length, 2);
	assert.equal(hostApply2.body.applied, false);
	ok("重复 host-apply → 幂等（不重复加 action）");

	// ── P2 回注：同意后把自包含指令注入真实存在的来源会话 ──
	const SID = "sess-gui-shortcuts-approve";
	writeFileSync(
		join(sessionsDir, `2026-11-20T00-00-00-000Z_${SID}.jsonl`),
		`${JSON.stringify({ type: "session", id: SID, cwd: CWD, timestamp: new Date().toISOString() })}\n`,
		"utf8",
	);
	const PID3 = createHash("sha256").update("proposal-3-inject").digest("hex").slice(0, 32);
	const finalHash = (await req(port, GET)).body.contentHash;
	const proposal3 = {
		version: 1, proposalId: PID3, cwd: CWD, baseHash: finalHash,
		reason: "回注测试", sourceSession: SID, createdAt: new Date().toISOString(),
		ops: [{ op: "add", action: { id: "inject-test", label: "注入", kind: "url", url: "http://inject.local" } }],
	};
	writeFileSync(join(shortcutsDir, "proposals", `${PID3}.json`), JSON.stringify(proposal3), "utf8");
	const decide3 = await req(port, "/v1/gui/shortcuts/proposal/decide", {
		method: "POST", token, body: { cwd: CWD, proposalId: PID3, decision: "approved" },
	});
	assert.equal(decide3.status, 200, JSON.stringify(decide3.body));
	assert.equal(decide3.body.injected, true, JSON.stringify(decide3.body));
	// outbox 里应有这条 session.message，且正文含配置绝对路径 + ops（自包含）。
	const { outboxDir } = await import("./runtime/message-outbox.ts");
	let outboxFiles: string[] = [];
	try { outboxFiles = readdirSync(outboxDir(stateDir)); } catch { /* 目录缺失 */ }
	const injectedItem = outboxFiles
		.map((f) => { try { return JSON.parse(readFileSync(join(outboxDir(stateDir), f), "utf8")); } catch { return null; } })
		.find((x: any) => x?.sessionId === SID && typeof x?.text === "string");
	assert.ok(injectedItem, "outbox 应有注入到来源会话的 session.message");
	assert.match(injectedItem.text, /gui-shortcuts[\/\\]/, "正文含主配置路径");
	assert.match(injectedItem.text, /inject\.local/, "正文含提案 ops（url）");
	ok("decide approved → 自包含指令回注来源会话（outbox 含路径+ops）");

	// ── L4 复审负向回归：applied 推断必须比对 kind / command / args，不能只比 id ──
	const { repoKey } = await import("./gui-shortcuts.ts");
	const cfgPathShortcuts2 = join(shortcutsDir, `${repoKey(CWD)}.json`);
	const negCases: Array<{ tag: string; propose: any; written: any }> = [
		{
			tag: "neg-kind",
			propose: { id: "negkind", label: "N", kind: "url", url: "http://good.local", confirm: false },
			written: { id: "negkind", label: "N", kind: "script", command: "good.ps1", args: [], timeoutMs: 120000, confirm: true },
		},
		{
			tag: "neg-command",
			propose: { id: "negcmd", label: "N", kind: "script", command: "good.ps1", args: ["a"], timeoutMs: 120000, confirm: true },
			written: { id: "negcmd", label: "N", kind: "script", command: "evil.ps1", args: ["a"], timeoutMs: 120000, confirm: true },
		},
		{
			tag: "neg-args",
			propose: { id: "negargs", label: "N", kind: "script", command: "good.ps1", args: ["a"], timeoutMs: 120000, confirm: true },
			written: { id: "negargs", label: "N", kind: "script", command: "good.ps1", args: ["b"], timeoutMs: 120000, confirm: true },
		},
	];
	for (const nc of negCases) {
		const pid = createHash("sha256").update(nc.tag).digest("hex").slice(0, 32);
		const curHash = (await req(port, GET)).body.contentHash;
		writeFileSync(join(shortcutsDir, "proposals", `${pid}.json`), JSON.stringify({
			version: 1, proposalId: pid, cwd: CWD, baseHash: curHash,
			reason: nc.tag, sourceSession: SID, createdAt: new Date().toISOString(),
			ops: [{ op: "add", action: nc.propose }],
		}), "utf8");
		const d = await req(port, "/v1/gui/shortcuts/proposal/decide", {
			method: "POST", token, body: { cwd: CWD, proposalId: pid, decision: "approved" },
		});
		assert.equal(d.status, 200, `${nc.tag} decide: ${JSON.stringify(d.body)}`);
		// agent 写成"同 id 不同内容"——不得推断为 applied（否则用户会以为改动已落地）。
		writeFileSync(cfgPathShortcuts2, JSON.stringify({
			version: 1, cwd: CWD, updatedAt: new Date().toISOString(), actions: [nc.written],
		}), "utf8");
		const g = await req(port, GET);
		const pv = g.body.proposals.find((x: any) => x.proposal.proposalId === pid);
		assert.equal(pv?.status, "approved", `${nc.tag} 不得推断 applied：${JSON.stringify(pv)}`);
		ok(`负向回归：同 id 不同 ${nc.tag.slice(4)} → 仍 approved（不误判 applied）`);
	}

	// ── L4 终审重要项：update-op 的 applied 推断（双 id 口径）──
	const updateCases: Array<{
		tag: string; targetId: string; propose: any; written: any[]; expect: string;
	}> = [
		{
			tag: "update-keep-id", targetId: "upda",
			propose: { id: "upda", label: "U", kind: "url", url: "http://upda.local/", confirm: false },
			written: [{ id: "upda", label: "U", kind: "url", url: "http://upda.local/", confirm: false }],
			expect: "applied",
		},
		{
			tag: "update-renamed", targetId: "updb",
			propose: { id: "propb", label: "U", kind: "url", url: "http://propb.local/", confirm: false },
			written: [{ id: "propb", label: "U", kind: "url", url: "http://propb.local/", confirm: false }],
			expect: "applied",
		},
		{
			// 双查顺序判别：targetId 正确、proposed.id 错误 ⇒ 必须命中 targetId；
			// 若退回 proposed.id ?? targetId 写法，此项会误判 approved 而变红。
			tag: "update-both-ids", targetId: "tgtc",
			propose: { id: "propc", label: "U", kind: "url", url: "http://correct.local/", confirm: false },
			written: [
				{ id: "tgtc", label: "U", kind: "url", url: "http://correct.local/", confirm: false },
				{ id: "propc", label: "U", kind: "url", url: "http://wrong.local/", confirm: false },
			],
			expect: "applied",
		},
		{
			tag: "update-wrong-id", targetId: "tgtd",
			propose: { id: "propd", label: "U", kind: "url", url: "http://propd.local/", confirm: false },
			written: [{ id: "otherd", label: "U", kind: "url", url: "http://propd.local/", confirm: false }],
			expect: "approved",
		},
	];
	for (const uc of updateCases) {
		const pid = createHash("sha256").update(uc.tag).digest("hex").slice(0, 32);
		const curHash = (await req(port, GET)).body.contentHash;
		writeFileSync(join(shortcutsDir, "proposals", `${pid}.json`), JSON.stringify({
			version: 1, proposalId: pid, cwd: CWD, baseHash: curHash,
			reason: uc.tag, sourceSession: SID, createdAt: new Date().toISOString(),
			ops: [{ op: "update", targetId: uc.targetId, action: uc.propose }],
		}), "utf8");
		const d = await req(port, "/v1/gui/shortcuts/proposal/decide", {
			method: "POST", token, body: { cwd: CWD, proposalId: pid, decision: "approved" },
		});
		assert.equal(d.status, 200, `${uc.tag} decide: ${JSON.stringify(d.body)}`);
		writeFileSync(cfgPathShortcuts2, JSON.stringify({
			version: 1, cwd: CWD, updatedAt: new Date().toISOString(), actions: uc.written,
		}), "utf8");
		const g = await req(port, GET);
		const pv = g.body.proposals.find((x: any) => x.proposal.proposalId === pid);
		assert.equal(pv?.status, uc.expect, `${uc.tag}: 期望 ${uc.expect}，实际 ${JSON.stringify(pv)}`);
		ok(`update 推断 ${uc.tag} → ${uc.expect}`);
	}

	// ── 终审次要项：decide 的 baseHash 过期必须被拒（此前只有 upsert 有负向用例）──
	const stalePid = createHash("sha256").update("decide-stale").digest("hex").slice(0, 32);
	writeFileSync(join(shortcutsDir, "proposals", `${stalePid}.json`), JSON.stringify({
		version: 1, proposalId: stalePid, cwd: CWD, baseHash: h2,
		reason: "stale", sourceSession: SID, createdAt: new Date().toISOString(),
		ops: [{ op: "add", action: { id: "staleadd", label: "S", kind: "url", url: "http://stale.local", confirm: false } }],
	}), "utf8");
	const staleDecide = await req(port, "/v1/gui/shortcuts/proposal/decide", {
		method: "POST", token, body: { cwd: CWD, proposalId: stalePid, decision: "approved" },
	});
	assert.notEqual(staleDecide.status, 200, "过期 baseHash 的提案不得被批准");
	ok(`decide 用过期 baseHash → ${staleDecide.status} 拒绝`);

	console.log(`\nALL ${n} ASSERTIONS PASSED`);
} finally {
	await handle.close();
	try { rmSync(D, { recursive: true, force: true }); } catch { /* ignore */ }
}
