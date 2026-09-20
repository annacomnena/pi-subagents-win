/**
 * _test_scope_stale_takeover.ts — 0920 backlog B：scope owner stale 恢复测试
 *（契约 plans/0920_backlog_A_B_plan.md §B 测试清单；v1 只做 pid 死判据）
 *
 *   T1 pid 死接管：attachment gen N + 身份匹配 liveness(pid 死) → session_start →
 *      gen N+1 新 sid + journal agent.session.takeover（含 prev/evidence）+ TUI notify
 *      + 新 owner 可正常注册唤醒循环。
 *   T2 不误杀：pid 活 / liveness 缺失 / 身份不匹配 三态均 skip，attachment 逐字节不变。
 *   T3 复活旧 owner 失效：接管后旧 sid 的 evaluateScopeWake / noteScopeWakeInbox /
 *      agent_end liveness 写手全部 no-op（UUID 身份门），liveness 不被旧 sid 覆写；
 *      新 owner agent_start/agent_end 双写生效（30s 节流：同身份窗口内跳写）。
 *   T4 unowned genesis 不回归：无 owner → 仍静默 genesis gen 1；registry CAS 并发：
 *      同 expected 二次 takeover → generation-mismatch（败者 skip）；audited 败者 →
 *      takeover_failed journal 事件（M3 类型表审计断言）。
 *   T5 M3 类型表 + 缺口③：SESSION_LIFECYCLE_TYPES 含三 takeover 事件；
 *      isProcessAlive EPERM=活 / ESRCH=不在语义单测（探针 errno 映射锁死）。
 *   T6 缺口④ 真竞争：两子进程屏障同时过 stale 判断，恰一 gen+1 成功、
 *      journal takeover terminal 恰一条，败方 skip。
 *
 * 运行：npm run test:scope-stale-takeover
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "scope-stale-takeover-env-"));
delete process.env.PI_SUBAGENT; // 测试进程非子 agent
delete process.env.PI_TAB_RUN_ID; // 非 tab
const ROOT = process.env.PI_RUNTIME_DIR!;
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

import { attachMaster, readAttachment, readCutover, setCutover, takeoverMaster, type MasterAttachment } from "./runtime/registry.ts";
import { deliverCommand } from "./runtime/mailbox.ts";
import { listRuntimeEnvelopes } from "./runtime/journal.ts";
import { isProcessAlive, readScopeLiveness, writeScopeLiveness } from "./runtime/liveness.ts";
import { SESSION_LIFECYCLE_TYPES, takeoverMasterWithAudit } from "./runtime/adapters/session-lifecycle.ts";
import {
	evaluateScopeWake,
	judgeScopeOwnerStale,
	localMasterAddress,
	localMasterScope,
	noteScopeWakeInbox,
	takeoverStaleScopeOwner,
	type ScopeWakeDecision,
} from "./runtime/scope.ts";
import { registerScopeWakeLoop } from "./mailbox-consumer.ts";
import { registerSessionHooks } from "./session-hooks.ts";
import type { ObjectAddress } from "./runtime/address.ts";

const attFileOf = (addr: ObjectAddress): string =>
	join(ROOT, "registry", "attachments", `${addr.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
const readBytes = (p: string): string => (existsSync(p) ? readFileSync(p, "utf8") : "");

// ── 工具 ───────────────────────────────────────────────────────────

/** 必死 pid：spawn 一个立即退出的子进程并等它退出。 */
function deadPid(): Promise<number> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
		if (!child.pid) return reject(new Error("spawn failed"));
		const pid = child.pid;
		child.on("exit", () => resolve(pid));
		child.on("error", reject);
	});
}

function mkGitRepo(name: string): { cwd: string; toplevel: string } {
	const dir = join(mkdtempSync(join(tmpdir(), "stale-takeover-repo-")), name);
	mkdirSync(join(dir, "sub"), { recursive: true });
	execFileSync("git", ["init", "-q", dir], { stdio: ["ignore", "ignore", "ignore"] });
	return { cwd: dir, toplevel: dir };
}

interface FakePi {
	on: (event: string, cb: (event: unknown, ctx?: Record<string, unknown>) => void) => void;
	handlers: Record<string, Array<(event: unknown, ctx?: Record<string, unknown>) => void>>;
	start: (sessionId: string) => void;
	fire: (event: string, ctx?: Record<string, unknown>) => void;
}
function fakePi(notifyTo?: string[]): FakePi {
	const handlers: FakePi["handlers"] = {};
	return {
		handlers,
		on: (event, cb) => {
			(handlers[event] ??= []).push(cb as never);
		},
		start: (sessionId) => {
			for (const cb of handlers["session_start"] ?? []) {
				cb({}, { sessionManager: { sessionId }, ...(notifyTo ? { ui: { notify: (m: string) => notifyTo.push(m) } } : {}) });
			}
		},
		fire: (event, ctx) => {
			for (const cb of handlers[event] ?? []) cb({}, ctx);
		},
	};
}

const disposers: Array<() => void> = [];

try {
	setCutover(true, "test"); // scope 消费端注册不受 cutover 门（genesis 独立），这里对齐生产常态

	// ── T1 pid 死接管 gen+1 ───────────────────────────────────────
	{
		const repo = mkGitRepo("repoT1");
		const scope = localMasterScope(repo.cwd);
		const addr = localMasterAddress(scope);
		const g = attachMaster({ sessionId: "sess-old", agent: addr, detail: repo.toplevel });
		assert.equal(g.ok, true, "旧 owner gen 1 就位");
		const dp = await deadPid();
		assert.equal(writeScopeLiveness({ scopeKey: scope, sessionId: "sess-old", generation: 1, pid: dp }), true, "liveness 落盘（pid 死）");
		const before = readBytes(attFileOf(addr));

		const spawned: ScopeWakeDecision[] = [];
		const notified: string[] = [];
		const pi = fakePi(notified);
		disposers.push(registerScopeWakeLoop(pi, {
			cwd: repo.cwd,
			intervalMs: 5,
			spawn: (d) => {
				spawned.push(d);
				return "tab_t1";
			},
		}));
		pi.start("sess-new"); // session_start：judge stale → takeover

		const att = readAttachment(addr)!;
		assert.equal(att.sessionId, "sess-new", "接管成功：新 owner");
		assert.equal(att.generation, 2, "gen+1（对齐 forceStale 语义）");
		assert.equal(att.detail, repo.toplevel, "detail（toplevel 路径）保留");
		assert.notEqual(readBytes(attFileOf(addr)), before, "attachment 已覆盖写");
		assert.equal(readScopeLiveness(scope)!.sessionId, "sess-old", "接管不碰 liveness 文件（新 owner 首个钩子才写）");

		// journal：agent.session.takeover 含 prev/evidence；attempt 事件同在
		const envs = listRuntimeEnvelopes({ path: join(ROOT, "events.jsonl") }).envelopes;
		const takeover = envs.find((e) => e.type === "agent.session.takeover");
		assert.ok(takeover, "journal takeover 事件");
		const payload = takeover!.payload as { prevSessionId: string; prevGeneration: number; generation: number; evidence: { pid: number; livenessUpdatedAt: string } };
		assert.equal(payload.prevSessionId, "sess-old");
		assert.equal(payload.prevGeneration, 1);
		assert.equal(payload.generation, 2);
		assert.equal(payload.evidence.pid, dp, "evidence.pid = 僵尸 pid");
		assert.ok(envs.some((e) => e.type === "agent.session.taking_over"), "attempt 事件同在（attachMasterWithAudit 同模式）");

		assert.equal(notified.length, 1, "TUI notify 恰一条");
		assert.ok(notified[0]!.includes("已接管僵尸 scope") && notified[0]!.includes("gen 1") && notified[0]!.includes("sess-old"), "notify 文案含 scope/上代/旧会话");

		// 新 owner 已注册唤醒循环：投 wake 信 → spawn（接管后立即可用）
		deliverCommand({ frame: "command", type: "agent.wake", to: addr, issuedBy: "agent://master_default", commandKey: "t1-wake", issuedAt: new Date().toISOString() });
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(spawned.length, 1, "新 owner 唤醒循环生效");

		// ── T3a 复活旧 owner：evaluateScopeWake / noteScopeWakeInbox 全 no-op ──
		const d = evaluateScopeWake({ sessionId: "sess-old", scope });
		assert.equal(d.fire, false);
		assert.equal(d.reason, "not-owner", "旧 owner 评估 not-owner");
		assert.deepEqual(noteScopeWakeInbox("sess-old", repo.cwd), [], "旧 owner attention 记账 no-op");
		assert.equal(readScopeLiveness(scope)!.sessionId, "sess-old", "旧 owner 路径不覆写 liveness");
	}

	// ── T2 不误杀三态 ─────────────────────────────────────────────
	{
		// (a) pid 活 → skip
		const repoA = mkGitRepo("repoT2a");
		const scopeA = localMasterScope(repoA.cwd);
		const addrA = localMasterAddress(scopeA);
		attachMaster({ sessionId: "sess-live", agent: addrA });
		writeScopeLiveness({ scopeKey: scopeA, sessionId: "sess-live", generation: 1, pid: process.pid }); // 本测试进程=活
		const beforeA = readBytes(attFileOf(addrA));
		const notifiedA: string[] = [];
		const piA = fakePi(notifiedA);
		disposers.push(registerScopeWakeLoop(piA, { cwd: repoA.cwd, intervalMs: 5, spawn: () => "tab_x" }));
		piA.start("sess-arrival");
		assert.equal(readBytes(attFileOf(addrA)), beforeA, "pid 活 → attachment 逐字节不变");
		assert.equal(notifiedA.length, 0, "无 notify");
		assert.equal(readAttachment(addrA)!.sessionId, "sess-live");

		// (b) liveness 缺失 → skip
		const repoB = mkGitRepo("repoT2b");
		const scopeB = localMasterScope(repoB.cwd);
		const addrB = localMasterAddress(scopeB);
		attachMaster({ sessionId: "sess-old-b", agent: addrB });
		assert.equal(readScopeLiveness(scopeB), null, "无 liveness 文件");
		const beforeB = readBytes(attFileOf(addrB));
		const piB = fakePi();
		disposers.push(registerScopeWakeLoop(piB, { cwd: repoB.cwd, intervalMs: 5, spawn: () => "tab_x" }));
		piB.start("sess-arrival-b");
		assert.equal(readBytes(attFileOf(addrB)), beforeB, "liveness 缺失 → attachment 不变（判不了不动）");

		// (c) 身份不匹配（前代残留）→ skip
		const repoC = mkGitRepo("repoT2c");
		const scopeC = localMasterScope(repoC.cwd);
		const addrC = localMasterAddress(scopeC);
		attachMaster({ sessionId: "sess-cur", agent: addrC });
		writeScopeLiveness({ scopeKey: scopeC, sessionId: "sess-ancient", generation: 1, pid: await deadPid() }); // 身份不匹配 + pid 死
		const beforeC = readBytes(attFileOf(addrC));
		const piC = fakePi();
		disposers.push(registerScopeWakeLoop(piC, { cwd: repoC.cwd, intervalMs: 5, spawn: () => "tab_x" }));
		piC.start("sess-arrival-c");
		assert.equal(readBytes(attFileOf(addrC)), beforeC, "身份不匹配 → attachment 不变（残留文件不授权接管）");

		// 纯函数直证三态（保守序）
		const att = readAttachment(addrC)!;
		assert.equal(judgeScopeOwnerStale(att, null).verdict, "skip");
		const lv = readScopeLiveness(scopeC)!;
		assert.deepEqual(judgeScopeOwnerStale(att, lv), { verdict: "skip", reason: "identity-mismatch" });
		const fakeAlive = judgeScopeOwnerStale({ sessionId: "sess-ancient", generation: 1 }, { ...lv, sessionId: "sess-ancient" }, { isProcessAlive: () => true });
		assert.deepEqual(fakeAlive, { verdict: "alive" });
	}

	// ── T3b agent_start/agent_end 双写 + 节流 + 旧 owner 身份门 ────
	{
		const repoScope = localMasterScope(REPO_ROOT); // agent_end 写手读 process.cwd() = 仓库根
		const repoAddr = localMasterAddress(repoScope);
		assert.equal(attachMaster({ sessionId: "sess-hook-old", agent: repoAddr }).ok, true);
		const dp = await deadPid();
		writeScopeLiveness({ scopeKey: repoScope, sessionId: "sess-hook-old", generation: 1, pid: dp });
		const snap0 = readScopeLiveness(repoScope)!;

		const piHooks = fakePi();
		registerSessionHooks(piHooks as never, { cleanups: [], isNotifyEnabled: () => false, pkgDir: REPO_ROOT });

		// 旧 owner 复活：agent_start/agent_end 全被身份门挡住（attachment 已非它）→ liveness 不覆写
		//（先制造接管：sess-hook-new 经 takeoverStaleScopeOwner 接管 gen 2）
		const r = takeoverStaleScopeOwner("sess-hook-new", REPO_ROOT);
		assert.equal(r.outcome, "took-over", "僵尸旧 owner 被接管（gen 2）");
		const livenessAfterTakeover = JSON.stringify(readScopeLiveness(repoScope));
		piHooks.fire("agent_start", { sessionManager: { sessionId: "sess-hook-old" } });
		piHooks.fire("agent_end", { sessionManager: { sessionId: "sess-hook-old" } });
		assert.equal(JSON.stringify(readScopeLiveness(repoScope)), livenessAfterTakeover, "旧 owner agent_start/agent_end 均不覆写 liveness（UUID 身份门）");
		assert.equal(readAttachment(repoAddr)!.sessionId, "sess-hook-new", "旧 owner 未能夺回 attachment");

		// 新 owner：agent_start 立即写（身份变化不被节流吞）→ agent_end 同身份 30s 内跳写
		piHooks.fire("agent_start", { sessionManager: { sessionId: "sess-hook-new" } });
		const lv1 = readScopeLiveness(repoScope)!;
		assert.equal(lv1.sessionId, "sess-hook-new", "新 owner agent_start 写入");
		assert.equal(lv1.generation, 2);
		assert.equal(lv1.pid, process.pid, "pid = 写手进程");
		assert.ok(lv1.startedAt, "startedAt 落盘");
		assert.notEqual(JSON.stringify(lv1), JSON.stringify(snap0), "旧→新身份立即写（不被节流吞）");
		piHooks.fire("agent_end", { sessionManager: { sessionId: "sess-hook-new" } });
		const lv2 = readScopeLiveness(repoScope)!;
		assert.equal(lv2.updatedAt, lv1.updatedAt, "30s 内同身份 agent_end 跳写（节流生效）");

		// 全局写手零改动断言：scope liveness 文件 ≠ master-liveness.json（分支分离）
		assert.equal(existsSync(join(ROOT, "state", "master-liveness.json")), false, "本测试未触发全局写手（分支严格分离）");
	}

	// ── T4 unowned genesis 不回归 + CAS 并发败者 skip ──────────────
	{
		// unowned → genesis（不变）
		const repoD = mkGitRepo("repoT4");
		const scopeD = localMasterScope(repoD.cwd);
		const addrD = localMasterAddress(scopeD);
		const piD = fakePi();
		disposers.push(registerScopeWakeLoop(piD, { cwd: repoD.cwd, intervalMs: 5, spawn: () => "tab_x" }));
		piD.start("sess-fresh");
		const attD = readAttachment(addrD)!;
		assert.equal(attD.sessionId, "sess-fresh");
		assert.equal(attD.generation, 1, "unowned → genesis gen 1（不回归）");
		const envsD = listRuntimeEnvelopes({ path: join(ROOT, "events.jsonl") }).envelopes;
		assert.ok(!envsD.some((e) => e.type === "agent.session.takeover" && e.subject === addrD), "无 takeover 事件");

		// registry CAS：同 expected 二次 takeover → 败者 generation-mismatch（三层防线最内层）
		const first = takeoverMaster({ sessionId: "sess-winner", agent: addrD, expected: { sessionId: "sess-fresh", generation: 1 } });
		assert.equal(first.ok, true);
		const loser = takeoverMaster({ sessionId: "sess-loser", agent: addrD, expected: { sessionId: "sess-fresh", generation: 1 } });
		assert.equal(loser.ok, false);
		assert.ok(!loser.ok && loser.reason === "generation-mismatch", "CAS 败者 skip（自然回落）");

		// M3 审计断言（确定性败者）：audited takeover 失败 → takeover_failed journal 事件
		//（类型表新三事件的失败分支走 lifecycleEvent 同一受检路径）
		const auditedLoser = takeoverMasterWithAudit({ sessionId: "sess-audited-loser", agent: addrD, expected: { sessionId: "sess-fresh", generation: 1 } });
		assert.equal(auditedLoser.ok, false);
		assert.ok(!auditedLoser.ok && auditedLoser.reason === "generation-mismatch");
		assert.equal(auditedLoser.audit.terminalEmitted, true, "失败审计也落盘");
		const failEnv = listRuntimeEnvelopes({ path: join(ROOT, "events.jsonl") }).envelopes.find(
			(e) => e.type === "agent.session.takeover_failed" && e.subject === addrD,
		);
		assert.ok(failEnv, "takeover_failed journal 事件在（公开类型表可识别）");
		const failPayload = failEnv!.payload as { ok?: boolean; reason?: string };
		assert.equal(failPayload.ok, false);
		assert.equal(failPayload.reason, "generation-mismatch");

		// 编排层败者：接管后再来一个会话 → liveness 身份不匹配 → skip（不接管在位新 owner）
		writeScopeLiveness({ scopeKey: scopeD, sessionId: "sess-winner", generation: 2, pid: await deadPid() }); // 新 owner 立刻僵尸
		const late = takeoverStaleScopeOwner("sess-late", repoD.cwd);
		assert.equal(late.outcome, "took-over", "新 owner 也死 → 后来者可再接管（gen 3）");
		assert.ok(late.outcome === "took-over" && late.prevSessionId === "sess-winner" && late.prevGeneration === 2);
	}

	// ── T5 M3 类型表 + 缺口③ isProcessAlive EPERM 语义 ──────────
	{
		// M3：导出词表含三 takeover 事件（依公开类型表消费 journal 的下游可识别新事件）
		assert.ok(
			SESSION_LIFECYCLE_TYPES.includes("agent.session.taking_over")
			&& SESSION_LIFECYCLE_TYPES.includes("agent.session.takeover")
			&& SESSION_LIFECYCLE_TYPES.includes("agent.session.takeover_failed"),
			"M3：SESSION_LIFECYCLE_TYPES 补齐三 takeover 事件",
		);

		// 缺口③：探针 errno 映射锁死（EPERM=活 是「无信号权限 ≠ 死」的 OS 语义）
		const realKill = process.kill;
		const fakeKill = (code: string): typeof process.kill =>
			(() => {
				const e = new Error("fake probe") as NodeJS.ErrnoException;
				e.code = code;
				throw e;
			}) as unknown as typeof process.kill;
		try {
			(process as { kill: typeof process.kill }).kill = fakeKill("EPERM");
			assert.equal(isProcessAlive(4321), true, "EPERM = 进程在（无信号权限 ≠ 死）");
			(process as { kill: typeof process.kill }).kill = fakeKill("ESRCH");
			assert.equal(isProcessAlive(4321), false, "ESRCH = 进程不在");
			assert.equal(isProcessAlive(0), false, "非法 pid 恒不在");
		} finally {
			process.kill = realKill;
		}
		assert.equal(isProcessAlive(process.pid), true, "真实自探活");
		assert.equal(isProcessAlive(await deadPid()), false, "真实死 pid → 不在");
	}

	// ── T6 缺口④ 真竞争：两子进程屏障同时过 stale 判断 ───────────
	{
		const repo = mkGitRepo("repoT6race");
		const scope = localMasterScope(repo.cwd);
		const addr = localMasterAddress(scope);
		assert.equal(attachMaster({ sessionId: "sess-race-old", agent: addr, detail: repo.toplevel }).ok, true, "旧 owner gen 1 就位");
		assert.equal(writeScopeLiveness({ scopeKey: scope, sessionId: "sess-race-old", generation: 1, pid: await deadPid() }), true, "liveness 落盘（pid 死）");

		// 两子进程 + 屏障：都 ready 才放行 → 双方同时过 stale 判断，registry CAS 单赢
		const barrierDir = join(ROOT, "barrier-takeover");
		mkdirSync(barrierDir, { recursive: true });
		interface TakeoverResult { outcome: string; reason?: string; prevSessionId?: string; prevGeneration?: number; attachment?: { sessionId: string; generation: number }; scope?: string; error?: string }
		const workerTs = join(REPO_ROOT, "extensions", "_test_race_worker.ts");
		const jobs = ["a", "b"].map((id) => ({
			mode: "takeover" as const,
			id,
			barrierDir,
			resultFile: join(barrierDir, `result-${id}.json`),
			sessionId: `sess-race-${id}`,
			cwd: repo.cwd,
		}));
		const children = jobs.map((j) => {
			const jobFile = join(barrierDir, `job-${j.id}.json`);
			writeFileSync(jobFile, JSON.stringify(j), "utf8");
			return spawn(process.execPath, ["--experimental-strip-types", workerTs, jobFile], { stdio: "ignore" });
		});
		try {
			const deadline = Date.now() + 90_000;
			const readyAll = (): boolean => jobs.every((j) => existsSync(join(barrierDir, `ready-${j.id}`)));
			while (!readyAll()) {
				if (Date.now() > deadline) throw new Error("race workers not ready");
				await new Promise((r) => setTimeout(r, 10));
			}
			writeFileSync(join(barrierDir, "go"), "1", "utf8");
			const doneAll = (): boolean => jobs.every((j) => existsSync(j.resultFile));
			while (!doneAll()) {
				if (Date.now() > deadline) throw new Error("race worker results missing");
				await new Promise((r) => setTimeout(r, 10));
			}
			const results = jobs.map((j) => JSON.parse(readFileSync(j.resultFile, "utf8")) as TakeoverResult);
			for (const r of results) assert.ok(!r.error, `race worker 无错误：${r.error ?? ""}`);

			// 恰一赢家 gen+1 成功，败方 skip
			const tookOver = results.filter((r) => r.outcome === "took-over");
			const skipped = results.filter((r) => r.outcome === "skipped");
			assert.equal(tookOver.length, 1, "恰一赢家接管");
			assert.equal(skipped.length, 1, "恰一败方 skip");
			assert.ok(tookOver[0]!.prevSessionId === "sess-race-old" && tookOver[0]!.prevGeneration === 1, "赢家从 gen 1 接管");
			assert.ok(skipped[0]!.reason === "takeover-failed" || skipped[0]!.reason === "identity-mismatch", `败方 skip（${skipped[0]!.reason}）`);
			const att = readAttachment(addr)!;
			assert.equal(att.sessionId, tookOver[0]!.attachment!.sessionId, "attachment 归赢家");
			assert.equal(att.generation, 2, "恰一 gen+1");

			// journal：takeover terminal 恰一条（gen 2）；attempt 审计至少赢家一条；
			// CAS 相撞败方额外落 takeover_failed（交错后到的败方则 identity-mismatch 无失败事件）
			const envs = listRuntimeEnvelopes({ path: join(ROOT, "events.jsonl") }).envelopes.filter((e) => e.subject === addr);
			const takeoverOk = envs.filter((e) => e.type === "agent.session.takeover");
			assert.equal(takeoverOk.length, 1, "journal takeover terminal 恰一条");
			assert.equal((takeoverOk[0]!.payload as { generation?: number }).generation, 2);
			assert.ok(envs.some((e) => e.type === "agent.session.taking_over"), "attempt 审计在");
			const failEnvs = envs.filter((e) => e.type === "agent.session.takeover_failed");
			if (skipped[0]!.reason === "takeover-failed") {
				assert.equal(failEnvs.length, 1, "CAS 相撞败方 → takeover_failed 审计恰一条");
			} else {
				assert.equal(failEnvs.length, 0, "后到败方 identity-mismatch → 无失败审计（judge 层已挡）");
			}
		} finally {
			for (const c of children) {
				try { c.kill(); } catch { /* ignore */ }
			}
		}
	}
} finally {
	for (const d of disposers) {
		try { d(); } catch { /* ignore */ }
	}
	rmSync(ROOT, { recursive: true, force: true });
}

console.log("_test_scope_stale_takeover: all assertions passed");
