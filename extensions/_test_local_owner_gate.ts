/**
 * _test_local_owner_gate.ts — local owner 派发平面验收（计划 §4 W/L 编号 + §9 补充用例）
 *
 * 任务：`plans/20261019_local_master_dispatch_plane_plan.md`（唯一实施依据 = §8；§3 已被替代）
 * 独立审查：`plans/20261019_local_master_dispatch_plane_plan_review.md`
 * 参照实现：`extensions/supervise-gate.ts`（同类门，形状必须一致）
 * 实现报告：`plans/20261019_local_master_dispatch_plane_report.md`
 *
 * 覆盖地图
 * ─────────────────────────────────────────────────────────────────────────
 *  L1–L7   纯函数矩阵（`localOwnerGate`：全注入零 IO）+ `resolveOwnerTargetCwd` 路径政策
 *  W0      真实 extension factory 注册（真子进程 + PI_TAB_RUN_ID + PI_SESSION_PROFILE）+ 身份时序
 *  W1/W2/W3/W4  `launch-tabs` 经**真实 execute**（owner 本仓成功 / 他仓拒 / 非 owner tab 拒 / main 原路径）
 *  W5/W6/W7/W7b `master-dispatch` 经**真实 execute → index.dispatchTab → masterDispatchLaunch →
 *               launchWorkflowTab**（local owner / global owner / local 他仓 / global 他仓）
 *  W8/W9/W10/W11 + 新增变异  源码级变异断言（注册门 / 最终 reader / 固定地址 / ownerKind）
 *  W12     固定地址（同 sid/gen 跨地址接力必须拒；改非选中地址不影响）
 *  W13     第三读（gate 后落账前替换附件 ⇒ stale + 五账本零新增 + spawn=0）
 *  W14     路径（本仓子树 / 他仓 / 同前缀兄弟 / `..` 逃逸 / 空白 / 相对 / 省略 / detail 回退）
 *  W15     防扩散与原行为（sub / trace-worker / 非 owner tab / 父派生 child / 空批 / 超上限 / timers）
 *  W16     地址一致性（文件路径 local、正文 global，及反向 ⇒ 全部 fail-closed）
 *
 * 纪律（AGENTS §4）：
 *   - 断言必须走**真实入口**（真 factory 注册 / 真 execute / 真 dispatchTab 接线），
 *     变异"真实接线"而非只变异函数体。
 *   - 永不真开 Windows Terminal：`child_process.spawn` 模块级拦截（先例 `_test_launch.ts`）。
 *   - 隔离：PI_RUNTIME_DIR / PI_TAB_RUNS_DIR / PI_LINKS_PATH / PI_CLI_PATH 全指临时目录。
 *
 * 运行：
 *   node --experimental-strip-types --import ./extensions/runtime-host/pi-deps-loader.mjs \
 *        ./extensions/_test_local_owner_gate.ts
 */
import assert from "node:assert/strict";
import cp, { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ── 隔离（先于任何本仓模块 import）───────────────────────────────────
const ENV_TMP = mkdtempSync(join(tmpdir(), "local-owner-gate-"));
process.env.PI_RUNTIME_DIR = join(ENV_TMP, "runtime");
process.env.PI_TAB_RUNS_DIR = join(ENV_TMP, "tab-runs");
process.env.PI_LINKS_PATH = join(ENV_TMP, "links.jsonl");
delete process.env.PI_TAB_RUN_ID;
delete process.env.PI_SUBAGENT;
delete process.env.PI_SESSION_PROFILE;

import { LOCAL_OWNER_GATE_TEXT, localOwnerGate, localOwnerStillFresh, readLocalOwnerAttachmentStrict } from "./local-owner-gate.ts";
import { resolveOwnerTargetCwd } from "./runtime/target-cwd.ts";
import { makePinnedOwnerReader, masterDispatchGate } from "./master-tools.ts";
import { attachMaster, readAttachment, type MasterAttachment } from "./runtime/registry.ts";
import { localMasterAddress, localMasterScope } from "./runtime/scope.ts";
import { masterAddress, type ObjectAddress } from "./runtime/address.ts";
import { listLinks } from "./links.ts";
import { listTabDispatches } from "./tab-runs.ts";
import { listOpenSupervisionEntries } from "./runtime/supervision.ts";
import { listRuntimeEnvelopes } from "./runtime/journal.ts";

const REPO_ROOT = dirname(fileURLToPath(import.meta.url)) ? join(dirname(fileURLToPath(import.meta.url)), "..") : process.cwd();
const PI_CLI = join(REPO_ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, fn: () => void): void {
	try {
		fn();
		passed++;
		console.log(`  ✓ ${name}`);
	} catch (e) {
		failed++;
		failures.push(name);
		console.error(`  ✗ ${name}`);
		console.error(`    ${String((e as Error)?.message ?? e)}`);
	}
}
async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
	try {
		await fn();
		passed++;
		console.log(`  ✓ ${name}`);
	} catch (e) {
		failed++;
		failures.push(name);
		console.error(`  ✗ ${name}`);
		console.error(`    ${String((e as Error)?.message ?? e)}`);
	}
}
const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();

// ════════════════════ L1–L7：纯函数矩阵（全注入、零 IO）════════════════
console.log("L1–L7 localOwnerGate 纯函数矩阵（零 IO）");
{
	const REPO = "C:/tmp/gate/repo-under-test";
	const OWNER_SID = "01a1518c-0000-7000-8000-local-owner";
	const localAddr = localMasterAddress(localMasterScope(REPO));
	const ownerAtt = (over: Partial<MasterAttachment> = {}): MasterAttachment => ({
		agentAddress: localAddr,
		sessionId: OWNER_SID,
		generation: 3,
		attachedAt: iso(60_000),
		lastHeartbeatAt: iso(1_000),
		attemptId: "att_test",
		detail: REPO,
		...over,
	});
	const base = (over: Partial<Parameters<typeof localOwnerGate>[0]> = {}) => ({
		isSub: false,
		isTab: true,
		isWorkflowTabProfile: true,
		sessionId: OWNER_SID,
		ownerCwd: REPO,
		readAttachment: () => ownerAtt(),
		targetCwds: [`${REPO}/src/nested`] as ReadonlyArray<string | undefined>,
		defaultCwd: REPO,
		...over,
	});

	check("L1 isSub=true ⇒ 拒 subagent（且优先级高于 owner 放行）", () => {
		const r = localOwnerGate(base({ isSub: true }));
		assert.equal(r.ok, false);
		assert.equal((r as { reason: string }).reason, "subagent");
		const r2 = localOwnerGate(base({ isSub: true, isTab: false }));
		assert.equal((r2 as { reason: string }).reason, "subagent", "sub 硬挡必须高于 R3 主会话放行");
	});

	check("L2 非 tab ⇒ 放行 via:main / ownerKind:main，且**零附件 IO**（R3）", () => {
		let reads = 0;
		const r = localOwnerGate(base({ isTab: false, readAttachment: () => { reads++; return ownerAtt(); } }));
		assert.equal(r.ok, true);
		const ok = r as Extract<typeof r, { ok: true }>;
		assert.equal(ok.via, "main");
		assert.equal(ok.ownerKind, "main");
		assert.equal(ok.ownerRoot, null);
		assert.equal(reads, 0, "R3：非 tab 不得读 attachment（主会话路径零额外 IO）");
		// 主会话不收紧 cwd（原路径逐字节不变）
		const wide = localOwnerGate(base({ isTab: false, targetCwds: ["D:/other/repo"] }));
		assert.equal(wide.ok, true, "main 跨仓必须仍然放行");
	});

	check("L3 tab + 本仓 owner（同 sid 同 gen）⇒ ok via:owner / ownerKind:local + ownerRoot=detail", () => {
		const r = localOwnerGate(base());
		assert.equal(r.ok, true, JSON.stringify(r));
		const ok = r as Extract<typeof r, { ok: true }>;
		assert.equal(ok.via, "owner");
		assert.equal(ok.ownerKind, "local", "launch-tabs 例外只产生 local 档（global 档属 master-dispatch）");
		assert.equal(ok.ownerRoot, REPO);
		assert.ok(ok.attachment, "owner 路径必须回传 attachment");
		assert.equal(ok.checkedCwds.length, 1);
		assert.equal(ok.checkedCwds[0], resolve(`${REPO}/src/nested`), "回传的必须是已检查的绝对路径（检查值=派发值）");
	});

	check("L4 tab + 非 owner ⇒ 拒 tab-session（不是放行、不是 unknown-session）", () => {
		assert.equal((localOwnerGate(base({ sessionId: "sid-other-tab" })) as { reason: string }).reason, "tab-session");
		assert.equal((localOwnerGate(base({ readAttachment: () => null })) as { reason: string }).reason, "tab-session");
	});

	check("L5 tab + owner 但双读 gen 变 ⇒ 拒 generation-mismatch（gate 双读必须保留）", () => {
		let n = 0;
		const r = localOwnerGate(base({
			readAttachment: () => {
				n++;
				return ownerAtt({ generation: n === 1 ? 3 : 4 });
			},
		}));
		assert.equal((r as { reason: string }).reason, "generation-mismatch");
		assert.ok(n >= 2, "必须真的双读");
	});

	check("L6 tab + owner 但 detail 缺失 ⇒ ownerRoot 回退可信 cwd；两者都不可解析 ⇒ fail-closed", () => {
		const ok = localOwnerGate(base({
			readAttachment: () => ownerAtt({ detail: undefined }),
			ownerCwd: REPO,
			targetCwds: [`${REPO}/sub`],
		})) as Extract<ReturnType<typeof localOwnerGate>, { ok: true }>;
		assert.equal(ok.ok, true);
		assert.equal(ok.ownerRoot, REPO, "detail 缺失必须回退 ctx.cwd");
		const bad = localOwnerGate(base({
			readAttachment: () => ownerAtt({ detail: undefined }),
			ownerCwd: "",
			targetCwds: [`${REPO}/sub`],
		}));
		assert.equal(bad.ok, false);
		// 注意：owner 地址派生也回退 process.cwd()，所以这里必须校验「仓根不可判定」而不是别的
		// ownerCwd 为空时 local 地址也回退 process.cwd()（与 REPO 不同）⇒ 天然落 address-mismatch；
		// 三者都是 fail-closed。真正不可解析仓根的纯函数用例见 P6。
		assert.ok(
			["owner-root", "tab-session", "address-mismatch"].includes((bad as { reason: string }).reason),
			`实得 ${(bad as { reason: string }).reason}`,
		);
	});

	check("L7 sid = unknown / 空 + tab ⇒ 拒 unknown-session", () => {
		assert.equal((localOwnerGate(base({ sessionId: "unknown" })) as { reason: string }).reason, "unknown-session");
		assert.equal((localOwnerGate(base({ sessionId: "" })) as { reason: string }).reason, "unknown-session");
	});

	check("L-extra(a) 全部 reason 都有非空且可辨的文案", () => {
		const reasons = Object.keys(LOCAL_OWNER_GATE_TEXT) as Array<keyof typeof LOCAL_OWNER_GATE_TEXT>;
		assert.ok(reasons.length >= 10, `reason 数量 ${reasons.length}`);
		for (const r of reasons) assert.ok((LOCAL_OWNER_GATE_TEXT[r] ?? "").length > 10, `${r} 缺文案`);
		assert.notEqual(LOCAL_OWNER_GATE_TEXT.subagent, LOCAL_OWNER_GATE_TEXT["tab-session"], "subagent 与 tab-非-owner 必须可辨");
	});

	check("L-extra(b) profile 不是 workflow-tab（trace-worker 形态）⇒ 拒 not-workflow-tab（即使持有附件）", () => {
		const r = localOwnerGate(base({ isWorkflowTabProfile: false }));
		assert.equal(r.ok, false);
		assert.equal((r as { reason: string }).reason, "not-workflow-tab");
	});

	check("L-extra(c) 地址形状不一致（正文 agentAddress 是 global）⇒ 拒 address-mismatch 而非 tab-session", () => {
		const r = localOwnerGate(base({ readAttachment: () => ownerAtt({ agentAddress: masterAddress() }) }));
		assert.equal((r as { reason: string }).reason, "address-mismatch");
	});
}

// ── 路径政策（resolveOwnerTargetCwd，单处实现，两处消费）──────────────
console.log("L-path resolveOwnerTargetCwd 目标 cwd 政策");
{
	const REPO = "C:/tmp/gate/repo-under-test";
	const DEF = "C:/tmp/gate/default-cwd";

	check("P1 本仓根 / 子树 / 反斜杠形状 ⇒ ok，且回传已 resolve 的绝对路径", () => {
		for (const c of [REPO, `${REPO}/src/deep`, `${REPO.replace(/\//g, "\\")}\\src`]) {
			const v = resolveOwnerTargetCwd(c, REPO, DEF);
			assert.equal(v.ok, true, `${c} 应放行：${JSON.stringify(v)}`);
			assert.equal((v as { cwd: string }).cwd, resolve(c));
		}
	});

	check("P2 他仓 / 同前缀兄弟目录 ⇒ cross-repo（分段判，前缀相似不算子树）", () => {
		assert.equal((resolveOwnerTargetCwd("D:/other/repo", REPO, DEF) as { reason: string }).reason, "cross-repo");
		assert.equal((resolveOwnerTargetCwd(`${REPO}-2`, REPO, DEF) as { reason: string }).reason, "cross-repo");
		assert.equal((resolveOwnerTargetCwd(`${REPO}2/x`, REPO, DEF) as { reason: string }).reason, "cross-repo");
	});

	check("P3 绝对路径含 `..` 逃出仓 ⇒ cross-repo（canonicalize 先于比较）", () => {
		const v = resolveOwnerTargetCwd(`${REPO}/../repo-other`, REPO, DEF);
		assert.equal(v.ok, false);
		assert.equal((v as { reason: string }).reason, "cross-repo");
		// 反向对照：`..` 绕回来仍在仓内 ⇒ 放行（证明不是一刀切拒 `..`）
		assert.equal(resolveOwnerTargetCwd(`${REPO}/../repo-under-test/sub`, REPO, DEF).ok, true);
	});

	check("P4 显式空白 ⇒ blank；相对路径 / 盘符相对 ⇒ relative（都不 resolve）", () => {
		assert.equal((resolveOwnerTargetCwd("   ", REPO, DEF) as { reason: string }).reason, "blank");
		assert.equal((resolveOwnerTargetCwd("src/nested", REPO, DEF) as { reason: string }).reason, "relative");
		assert.equal((resolveOwnerTargetCwd("C:repo", REPO, DEF) as { reason: string }).reason, "relative");
	});

	check("P5 省略 cwd ⇒ 用派发原语的默认（不是 ctx.cwd），并校验该默认值", () => {
		const insideDefault = `${REPO}/default`;
		const v = resolveOwnerTargetCwd(undefined, REPO, insideDefault);
		assert.equal(v.ok, true);
		assert.equal((v as { cwd: string }).cwd, resolve(insideDefault), "省略时必须走 defaultCwd");
		const outsideDefault = "D:/outside";
		assert.equal((resolveOwnerTargetCwd(undefined, REPO, outsideDefault) as { reason: string }).reason, "cross-repo");
		// 空串 ≠ 省略（显式空白拒，避免「默认值猜测」）
		assert.equal((resolveOwnerTargetCwd("", REPO, insideDefault) as { reason: string }).reason, "blank");
	});

	check("P6 owner 仓根不可解析 ⇒ owner-root（fail-closed，不猜）", () => {
		assert.equal((resolveOwnerTargetCwd(`${REPO}/a`, "", DEF) as { reason: string }).reason, "owner-root");
		assert.equal((resolveOwnerTargetCwd(`${REPO}/a`, "   ", DEF) as { reason: string }).reason, "owner-root");
		assert.equal((resolveOwnerTargetCwd(`${REPO}/a`, "relative/root", DEF) as { reason: string }).reason, "owner-root");
	});
}

// ════════════════════ W12：固定地址 pin（纯函数层，双地址 reader）════════════════
console.log("W12 固定地址（makePinnedOwnerReader：先选地址，再固定读到底）");
{
	const CWD = "C:/tmp/gate/repo-pinned";
	const SID = "sid-shared-across-addresses";
	const localAddr = localMasterAddress(localMasterScope(CWD));
	const globalAddr = masterAddress();
	const snap = (addr: ObjectAddress, sid: string, gen: number): MasterAttachment => ({
		agentAddress: addr,
		sessionId: sid,
		generation: gen,
		attachedAt: iso(60_000),
		lastHeartbeatAt: iso(1_000),
		attemptId: `a_${gen}`,
	});

	check("W12(a) local(S,1) → global(S,1) 跨地址接力 ⇒ **必须拒**（旧 find() 草案的假 pass）", () => {
		// 真实接力场景：第一读时 global 不匹配 sid（未持有），local(S,1) 命中 ⇒ pin local；
		// 第二读前 local 被 takeover、同时 global 恰好变成「同 sid 同 gen」⇒ 旧 candidates.find()
		// 会改选 global 并让 gate 误判「同一 lease 未被接管」。固定地址后必须拒。
		let readIndex = 0;
		const reader = makePinnedOwnerReader({
			sessionId: SID,
			cwd: CWD,
			readAttachment: (a: ObjectAddress) => {
				readIndex++;
				if (readIndex <= 2) {
					// 首次解析（global→local 两个候选都读一遍）：只有 local 匹配
					return a === localAddr ? snap(localAddr, SID, 1) : snap(globalAddr, "sid-not-owner", 1);
				}
				// 后续读（gate 第二读）：local 已被 takeover、global 变成同 sid+同 gen
				return a === localAddr ? snap(localAddr, "sid-took-over", 2) : snap(globalAddr, SID, 1);
			},
		});
		const gate = masterDispatchGate({ sessionId: SID, isSub: false, isTab: true, isMain: false, readAttachment: reader.read });
		assert.equal(reader.pinned()?.kind, "local", "首次必须选中 local");
		assert.equal(gate.ok, false, "跨地址接力必须被拒（不得靠另一个地址的同 sid/gen 续命）");
		assert.equal((gate as { reason: string }).reason, "generation-mismatch");
	});

	check("W12(b) 选中 global 后 global 被 takeover ⇒ generation-mismatch（不得换回 local 接力）", () => {
		let globalGen = 1;
		const reader = makePinnedOwnerReader({
			sessionId: SID,
			cwd: CWD,
			readAttachment: (a: ObjectAddress) =>
				a === globalAddr
					? (globalGen === 1 ? snap(globalAddr, SID, 1) : snap(globalAddr, "sid-new", globalGen))
					: snap(localAddr, SID, 1), // local 一直「合法」——旧实现会在这里接力通过
		});
		const gate = masterDispatchGate({
			sessionId: SID, isSub: false, isTab: true, isMain: false,
			readAttachment: () => {
				const r = reader.read();
				if (reader.pinned()) globalGen = 2; // 第一次读后再 takeover
				return r;
			},
		});
		assert.equal(gate.ok, false, "跨地址接力必须被拒");
		assert.equal((gate as { reason: string }).reason, "generation-mismatch");
	});

	check("W12(c) 反向切换（选中 local 后 local detach，global 同 sid/gen）⇒ 仍拒", () => {
		let localReads = 0;
		const reader = makePinnedOwnerReader({
			sessionId: SID,
			cwd: CWD,
			readAttachment: (a: ObjectAddress) => {
				if (a === globalAddr) return null; // 首次选择时 global 不存在 ⇒ 落 local
				localReads++;
				return localReads === 1 ? snap(localAddr, SID, 1) : null; // 第二读 detach
			},
		});
		const gate = masterDispatchGate({ sessionId: SID, isSub: false, isTab: true, isMain: false, readAttachment: reader.read });
		assert.equal(gate.ok, false, "detach 必须拒");
		assert.equal(reader.pinned()?.kind, "local");
	});

	check("W12(d) 改变**非选中**地址不影响本次授权（global 被改，local owner 已 pin）", () => {
		let localReads = 0;
		const reader = makePinnedOwnerReader({
			sessionId: SID,
			cwd: CWD,
			readAttachment: (a: ObjectAddress) => {
				if (a === globalAddr) return snap(globalAddr, "someone-else", 9); // 非选中地址，怎么变都无关
				localReads++;
				return snap(localAddr, SID, 5);
			},
		});
		const gate = masterDispatchGate({ sessionId: SID, isSub: false, isTab: true, isMain: false, readAttachment: reader.read });
		assert.equal(gate.ok, true, JSON.stringify(gate));
		assert.equal(reader.pinned()?.kind, "local");
		assert.ok(localReads >= 2);
	});

	check("W12(e) 地址形状不一致（读 local 路径、正文写 global 地址）⇒ 按 null 拒", () => {
		const reader = makePinnedOwnerReader({
			sessionId: SID,
			cwd: CWD,
			readAttachment: (a: ObjectAddress) => snap(a === localAddr ? globalAddr : localAddr, SID, 1),
		});
		const gate = masterDispatchGate({ sessionId: SID, isSub: false, isTab: true, isMain: false, readAttachment: reader.read });
		assert.equal(gate.ok, false, "地址与读路径不符必须 fail-closed");
		assert.equal(reader.pinned(), null);
	});

	check("W12(f) 两边都不匹配 ⇒ 恒 null（且粘住，不重新选地址），由 gate 走 main/tab 分支", () => {
		let calls = 0;
		const reader = makePinnedOwnerReader({
			sessionId: SID,
			cwd: CWD,
			readAttachment: () => {
				calls++;
				return snap(globalAddr, "someone-else", 1);
			},
		});
		assert.equal(reader.read(), null);
		const afterFirst = calls;
		assert.equal(reader.read(), null);
		assert.equal(calls, afterFirst, "解析为无 owner 后不得再读（粘住）");
		const gate = masterDispatchGate({ sessionId: SID, isSub: false, isTab: false, isMain: true, readAttachment: reader.read });
		assert.equal(gate.ok, true);
		assert.equal((gate as { via: string }).via, "main", "main 非 owner 时仍走原 main 路径");
	});
}

// ════════════════════ 真 factory / 真 execute 的接线测试 ════════════════════
// 说明：这一节用**真实 extension factory**（index.ts default export）注册工具，再调真实
// execute 入口。终端进程边界用 fake spawn 替换（`child_process.spawn` 模块级拦截）——
// 与 `_test_launch.ts` 同款，永不真开 WT；也不写用户真实 attachment（PI_RUNTIME_DIR 隔离）。

/** 模块级 child_process 拦截（syncBuiltinESMExports 让已捕获绑定一起生效）。 */
const ORIG_CP = { spawn: cp.spawn, spawnSync: cp.spawnSync, execFileSync: cp.execFileSync };
const spawnCapture: Array<{ exe: string; args: string[]; env?: NodeJS.ProcessEnv; cwd?: string }> = [];
function installSpawnStub(opts: { spawnError?: string } = {}): void {
	spawnCapture.length = 0;
	(cp as unknown as { spawnSync: unknown }).spawnSync = () => ({ status: 0, stdout: "", stderr: "" });
	(cp as unknown as { spawn: unknown }).spawn = ((exe: string, args: string[], o: { env?: NodeJS.ProcessEnv; cwd?: string }) => {
		if (opts.spawnError) throw new Error(opts.spawnError);
		spawnCapture.push({ exe, args, env: o?.env, cwd: o?.cwd });
		return { on() {}, unref() {}, pid: 4242 };
	}) as unknown;
	syncBuiltinESMExports();
}
function restoreSpawn(): void {
	(cp as unknown as { spawn: unknown }).spawn = ORIG_CP.spawn;
	(cp as unknown as { spawnSync: unknown }).spawnSync = ORIG_CP.spawnSync;
	(cp as unknown as { execFileSync: unknown }).execFileSync = ORIG_CP.execFileSync;
	syncBuiltinESMExports();
}

interface FakePi {
	tools: Map<string, { name: string; description?: string; execute: (...a: unknown[]) => Promise<unknown> }>;
	commands: Map<string, unknown>;
	cleanups: Array<() => void | Promise<void>>;
}
function makeFakePi(flags: Record<string, string> = {}): FakePi {
	const pi: FakePi = { tools: new Map(), commands: new Map(), cleanups: [] };
	const fake = {
		registerTool(t: { name: string }) { pi.tools.set(t.name, t as never); },
		registerCommand(n: string, o: unknown) { pi.commands.set(n, o); },
		registerFlag() {},
		on(ev: string, h: () => void | Promise<void>) { if (ev === "session_shutdown") pi.cleanups.push(h); },
		getFlag(n: string) { return flags[n] ?? ""; },
		sendUserMessage() {}, sendMessage() {}, exec() {},
	};
	(pi as unknown as { fake: unknown }).fake = fake;
	return pi;
}
async function bootFactory(pi: FakePi, env: Record<string, string | undefined>): Promise<void> {
	const saved: Record<string, string | undefined> = {};
	for (const [k, v] of Object.entries(env)) {
		saved[k] = process.env[k];
		if (v === undefined) delete process.env[k]; else process.env[k] = v;
	}
	try {
		const mod = await import("./index.ts");
		const fake = (pi as unknown as { fake: unknown }).fake;
		await (mod.default as (p: unknown) => Promise<void>)(fake);
	} finally {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k]; else process.env[k] = v;
		}
	}
}
/** 测试隔离根（每个用例独立）。目录布局**镜像真实的 `~/.pi/agent/**`**：
 * `index.ts` 里的 `defaultTabRunsDir()` / `defaultTimersDir()` 只读 `os.homedir()`，
 * **不读** `PI_TAB_RUNS_DIR` —— 所以隔离必须靠 `USERPROFILE`/`HOME`（同 `_test_recent_calls.ts`
 * 的手法），否则测试会写用户真实附件/账本（已实测踩到过一次）。 */
const REAL_HOME = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
function mkIsolated(tag: string): { root: string; agentDir: string; runtimeDir: string; runsDir: string; linksPath: string; timersDir: string; dispose: () => void } {
	const root = mkdtempSync(join(tmpdir(), `log-${tag}-`));
	const agentDir = join(root, ".pi", "agent");
	return {
		root,
		agentDir,
		runtimeDir: join(agentDir, "runtime"),
		runsDir: join(agentDir, "tab-runs"),
		linksPath: join(agentDir, "links.jsonl"),
		timersDir: join(agentDir, "timers"),
		dispose: () => {
			process.env.USERPROFILE = REAL_HOME.USERPROFILE;
			process.env.HOME = REAL_HOME.HOME;
			rmSync(root, { recursive: true, force: true });
		},
	};
}
/** 在隔离 runtime 里真写 owner 附件（走 registry.attachMaster，不是自造对象）。 */
function seedOwner(iso2: { runtimeDir: string }, cwd: string, sid: string, addr?: ObjectAddress): void {
	process.env.PI_RUNTIME_DIR = iso2.runtimeDir;
	const target = addr ?? localMasterAddress(localMasterScope(cwd));
	const r = attachMaster({ sessionId: sid, agent: target, detail: cwd });
	assert.equal(r.ok, true, `attach 必须成功：${JSON.stringify(r)}`);
}
/**
 * 把进程切到给定隔离环境。**必须在 bootFactory 之前**调（工厂内部大量同步 import 的模块
 * 会在调用期读 env）；`bootFactory` 之后再次调用可以切换运行期读取的 env。
 */
function useEnv(iso2: { root: string; runtimeDir: string; runsDir: string; linksPath: string; timersDir: string }): void {
	process.env.PI_RUNTIME_DIR = iso2.runtimeDir;
	process.env.PI_TAB_RUNS_DIR = iso2.runsDir;
	process.env.PI_LINKS_PATH = iso2.linksPath;
	process.env.PI_CLI_PATH = PI_CLI;
	// `defaultTabRunsDir()` / `defaultTimersDir()` 只认 homedir ⇒ 必须同时改 USERPROFILE/HOME
	process.env.USERPROFILE = iso2.root;
	process.env.HOME = iso2.root;
}

/** boot 一个真实 factory 并把进程切到它的隔离 env（工厂读取期与调用期都用同一套）。 */
async function bootIn(iso2: { root: string; runtimeDir: string; runsDir: string; linksPath: string; timersDir: string }, flags: Record<string, string>, env: Record<string, string | undefined>): Promise<FakePi> {
	useEnv(iso2);
	const pi = makeFakePi(flags);
	await bootFactory(pi, { ...env, PI_RUNTIME_DIR: iso2.runtimeDir, PI_TAB_RUNS_DIR: iso2.runsDir, PI_LINKS_PATH: iso2.linksPath, PI_CLI_PATH: PI_CLI });
	// 工厂的 env 恢复会把 PI_* 还原成旧值 ⇒ 调用期再切回本用例的隔离值
	useEnv(iso2);
	return pi;
}
/** 统计「派发副作用」四个账本 + 监管账本 + spawn 次数（W13/W14 零副作用断言用）。 */
function sideEffects(iso2: { runtimeDir: string; runsDir: string; linksPath: string; timersDir: string }) {
	// timer 落盘位置是 <timersDir>/mail/<tabRunId>/<timerId>.json ⇒ 必须下钻一层
	const countFiles = (dir: string): number => {
		let n = 0;
		try {
			for (const entry of readdirSync(dir)) {
				if (entry.endsWith(".json")) { n++; continue; }
				try {
					n += readdirSync(join(dir, entry)).filter((f) => f.endsWith(".json")).length;
				} catch { /* 非目录 */ }
			}
		} catch {
			return 0;
		}
		return n;
	};
	return {
		dispatches: listTabDispatches(iso2.runsDir, 10_000).length,
		links: listLinks(iso2.linksPath).length,
		journals: listRuntimeEnvelopes().envelopes.length,
		timers: countFiles(join(iso2.timersDir, "mail")),
		supervision: listOpenSupervisionEntries({ stateDir: join(iso2.runtimeDir, "state") }).length,
		spawns: spawnCapture.length,
	};
}

// ── W0：真实 factory 注册 + 身份时序（真子进程）──────────────────────
await (async () => {
	console.log("W0 真实 extension factory 注册与身份时序（真子进程 + PI_TAB_RUN_ID + PI_SESSION_PROFILE）");
	const iso0 = mkIsolated("w0");
	const CHILD_REPO = join(iso0.root, "repo-child");
	mkdirSync(CHILD_REPO, { recursive: true });
	useEnv(iso0);
	const SID_OWNER = "01a1518c-1111-7000-8000-w0-owner";
	seedOwner(iso0, CHILD_REPO, SID_OWNER);

	// 子进程脚本：真 factory → 捕获注册工具 → 调真实 execute（两次：owner 在位 / owner 被 takeover 后）
	const childPath = join(iso0.root, "w0-child.mts");
	writeFileSync(
		childPath,
		[
			`import { mkdtempSync } from "node:fs";`,
			`import cp from "node:child_process";`,
			`import { syncBuiltinESMExports } from "node:module";`,
			`import { tmpdir } from "node:os";`,
			`import { join } from "node:path";`,
			`const spawns: any[] = [];`,
			`(cp as any).spawnSync = () => ({ status: 0, stdout: "", stderr: "" });`,
			`(cp as any).spawn = (exe: string, args: string[]) => { spawns.push({ exe, args }); return { on() {}, unref() {}, pid: 1 }; };`,
			`syncBuiltinESMExports();`,
			`const mod = await import(${JSON.stringify(`file:///${join(REPO_ROOT, "extensions", "index.ts").replace(/\\/g, "/")}`)});`,
			`const tools = new Map<string, any>();`,
			`const fake = { registerTool(t: any) { tools.set(t.name, t); }, registerCommand() {}, registerFlag() {}, on() {}, getFlag(n: string) { return ""; }, sendUserMessage() {}, sendMessage() {}, exec() {} };`,
			`await mod.default(fake as never);`,
			`const lt = tools.get("launch-tabs");`,
			`const ctx = { cwd: ${JSON.stringify(CHILD_REPO)}, sessionManager: { sessionId: ${JSON.stringify(SID_OWNER)} } };`,
			`const r1: any = await lt.execute("", { tasks: [{ taskId: "T-A", prompt: "p", cwd: ${JSON.stringify(CHILD_REPO)} }] }, undefined, undefined, ctx);`,
			`const out1 = { isError: !!r1.isError, text: r1.content?.[0]?.text ?? "", spawns: spawns.length };`,
			// takeover：另一会话抢占 local owner（gen+1）
			`const reg = await import(${JSON.stringify(`file:///${join(REPO_ROOT, "extensions", "runtime", "registry.ts").replace(/\\/g, "/")}`)});`,
			`const addr = ${JSON.stringify(localMasterAddress(localMasterScope(CHILD_REPO)))};`,
			`const t = reg.attachMaster({ sessionId: "sid-took-over", agent: addr as never, forceStale: true, staleAfterMs: -1 });`,
			`const spawnsBefore = spawns.length;`,
			`const r2: any = await lt.execute("", { tasks: [{ taskId: "T-B", prompt: "p", cwd: ${JSON.stringify(CHILD_REPO)} }] }, undefined, undefined, ctx);`,
			`const out2 = { isError: !!r2.isError, text: r2.content?.[0]?.text ?? "", spawns: spawns.length - spawnsBefore, takeoverOk: !!t.ok };`,
			`console.log("W0_RESULT " + JSON.stringify({ tools: [...tools.keys()].sort(), out1, out2 }));`,
		].join("\n"),
		"utf8",
	);
	writeFileSync(join(iso0.root, "package.json"), JSON.stringify({ type: "module" }), "utf8");
	let childOut = "";
	let childErr = "";
	try {
		childOut = execFileSync(process.execPath, ["--experimental-strip-types", "--import", pathToFileURL(join(REPO_ROOT, "extensions", "runtime-host", "pi-deps-loader.mjs")).href, childPath], {
			encoding: "utf8",
			timeout: 180_000,
			env: {
				...process.env,
				PI_RUNTIME_DIR: iso0.runtimeDir,
				PI_TAB_RUNS_DIR: iso0.runsDir,
				PI_LINKS_PATH: iso0.linksPath,
				PI_CLI_PATH: PI_CLI,
				PI_TAB_RUN_ID: "tab_lms_child",
				PI_SESSION_PROFILE: "workflow-tab",
				USERPROFILE: iso0.root,
				HOME: iso0.root,
				PI_SUBAGENT: undefined as never,
			},
		});
	} catch (e) {
		childErr = String((e as { stderr?: string })?.stderr ?? e);
	}
	const line = childOut.split("\n").find((l) => l.startsWith("W0_RESULT ")) ?? "";
	const parsed = JSON.parse(line.slice("W0_RESULT ".length) || "{}") as {
		tools?: string[];
		out1?: { isError?: boolean; text?: string; spawns?: number };
		out2?: { isError?: boolean; text?: string; spawns?: number; takeoverOk?: boolean };
	};

	check("W0(a) workflow-tab profile 下 launch-tabs **已注册**（移除注册门的直接证据）", () => {
		assert.ok(line, `子进程必须给出结果行。stdout=${childOut.slice(-800)} stderr=${childErr.slice(-800)}`);
		assert.ok(parsed.tools?.includes("launch-tabs"), `workflow-tab 必须注册 launch-tabs，实得 ${JSON.stringify(parsed.tools)}`);
	});
	check("W0(b) 加载时还不是 owner → 调用前成为 owner ⇒ 成功派发（execute 当前授权，不用工厂期布尔）", () => {
		assert.equal(parsed.out1?.isError, false, `应成功：${parsed.out1?.text}`);
		assert.match(parsed.out1?.text ?? "", /已并行启动 1\/1/, parsed.out1?.text ?? "");
		assert.equal(parsed.out1?.spawns, 1, "必须真的走到 spawn 边界（fake spawn 计数）");
	});
	check("W0(c) owner 失效后，同一已注册工具必须拒绝（零 spawn）", () => {
		assert.equal(parsed.out2?.takeoverOk, true, "夹具：takeover 必须成功");
		assert.equal(parsed.out2?.isError, true, `必须拒：${parsed.out2?.text}`);
		assert.equal(parsed.out2?.spawns, 0, "拒绝时零 spawn");
	});
	await checkAsync("W0(d) trace 注册面不扩大（/trace-fusion-loop 在 workflow-tab 下仍不注册）", async () => {
		// 同进程复核：主会话注册面（含 /trace-fusion-loop）与 tab 注册面的差集必须仍包含它
		const iso0b = mkIsolated("w0b");
		installSpawnStub();
		const mainPi = await bootIn(iso0b, {}, { PI_TAB_RUN_ID: undefined, PI_SESSION_PROFILE: undefined, PI_SUBAGENT: undefined });
		const tabPi = await bootIn(iso0b, { "tab-run-id": "tab_probe" }, { PI_TAB_RUN_ID: "tab_probe", PI_SESSION_PROFILE: "workflow-tab", PI_SUBAGENT: undefined });
		assert.ok(mainPi.commands.has("trace-fusion-loop"), "主会话必须有 /trace-fusion-loop");
		assert.equal(tabPi.commands.has("trace-fusion-loop"), false, "workflow-tab 不得注册 /trace-fusion-loop（trace 权限面不扩大）");
		assert.ok(tabPi.tools.has("launch-tabs"), "但 launch-tabs 必须注册");
		restoreSpawn();
		iso0b.dispose();
	});
	iso0.dispose();
})();

// ── W1–W4：launch-tabs 经真实 execute ────────────────────────────────
await (async () => {
	console.log("W1–W4 launch-tabs 经真实 factory 注册 + 真实 execute");
	const isoW = mkIsolated("w1");
	const REPO = join(isoW.root, "repo-local");
	const OTHER = join(isoW.root, "repo-other");
	mkdirSync(join(REPO, "src", "nested"), { recursive: true });
	mkdirSync(OTHER, { recursive: true });
	useEnv(isoW);
	const SID_OWNER = "01a1518c-2222-7000-8000-w1-owner";
	seedOwner(isoW, REPO, SID_OWNER);

	installSpawnStub();
	const tabPi = await bootIn(isoW, { "tab-run-id": "tab_lms_w1" }, { PI_TAB_RUN_ID: "tab_lms_w1", PI_SESSION_PROFILE: "workflow-tab", PI_SUBAGENT: undefined });
	const lt = tabPi.tools.get("launch-tabs")!;
	const ctxFor = (cwd: string, sid: string) => ({ cwd, sessionManager: { sessionId: sid } });

	await checkAsync("W1 owner 派**本仓** cwd ⇒ 经真实 launchWorkflowTab 成功（dispatch+link+spawn 真发生）", async () => {
		const before = sideEffects(isoW);
		const r = (await lt.execute("", { tasks: [{ taskId: "W1", prompt: "干活", cwd: join(REPO, "src", "nested") }] }, undefined, undefined, ctxFor(REPO, SID_OWNER))) as { isError?: boolean; content: Array<{ text: string }>; details?: { results?: Array<{ runId?: string; cwd?: string }> } };
		assert.equal(r.isError, false, `本仓 owner 必须成功：${r.content[0]?.text}`);
		const after = sideEffects(isoW);
		assert.equal(after.dispatches, before.dispatches + 1, "必须真写 dispatch 账本");
		assert.equal(after.links, before.links + 1, "必须真写 link");
		assert.equal(after.spawns, before.spawns + 1, "必须真到 spawn 边界");
		assert.equal(r.details?.results?.[0]?.cwd, resolve(join(REPO, "src", "nested")), "派发 cwd 必须是检查过的绝对路径");
	});

	await checkAsync("W2 owner 派**他仓** cwd ⇒ 拒绝且**零副作用**（整批预检先于任何写盘）", async () => {
		const before = sideEffects(isoW);
		const r = (await lt.execute("", { tasks: [{ taskId: "W2", prompt: "越界", cwd: OTHER }] }, undefined, undefined, ctxFor(REPO, SID_OWNER))) as { isError?: boolean; content: Array<{ text: string }>; details?: { reason?: string } };
		assert.equal(r.isError, true, "他仓必须拒");
		assert.equal(r.details?.reason, "cross-repo");
		assert.match(r.content[0]!.text, /只能在本仓内派发/);
		const after = sideEffects(isoW);
		assert.deepEqual(after, before, `拒绝时零副作用：${JSON.stringify({ before, after })}`);
	});

	await checkAsync("W2b 混合批次（本仓合法 + 他仓非法）⇒ 整批拒、前几项也不得派发", async () => {
		const before = sideEffects(isoW);
		const r = (await lt.execute("", { tasks: [
			{ taskId: "W2b-1", prompt: "合法", cwd: REPO },
			{ taskId: "W2b-2", prompt: "非法", cwd: OTHER },
		] }, undefined, undefined, ctxFor(REPO, SID_OWNER))) as { isError?: boolean };
		assert.equal(r.isError, true);
		const after = sideEffects(isoW);
		assert.deepEqual(after, before, `混合批次必须零副作用（不得先派前几项）：${JSON.stringify({ before, after })}`);
	});

	await checkAsync("W3 非 owner 任务 tab ⇒ 拒绝（原最小权限不变，零副作用）", async () => {
		const before = sideEffects(isoW);
		const r = (await lt.execute("", { tasks: [{ taskId: "W3", prompt: "x", cwd: REPO }] }, undefined, undefined, ctxFor(REPO, "sid-unrelated-tab"))) as { isError?: boolean; details?: { reason?: string } };
		assert.equal(r.isError, true);
		assert.equal(r.details?.reason, "tab-session");
		assert.deepEqual(sideEffects(isoW), before);
	});

	await checkAsync("W4 主会话（无 tab 身份）⇒ 原路径成功（逐字节不变的旧能力，跨仓也放行）", async () => {
		const isoM = mkIsolated("w4main");
		installSpawnStub();
		const mainPi = await bootIn(isoM, {}, { PI_TAB_RUN_ID: undefined, PI_SESSION_PROFILE: "main", PI_SUBAGENT: undefined });
		const tool = mainPi.tools.get("launch-tabs")!;
		const before = sideEffects(isoM);
		const r = (await tool.execute("", { tasks: [{ taskId: "W4", prompt: "x", cwd: OTHER }] }, undefined, undefined, { cwd: REPO, sessionManager: { sessionId: "sid-main-any" } })) as { isError?: boolean; content: Array<{ text: string }> };
		assert.equal(r.isError, false, `主会话原路径必须成功（含跨仓）：${r.content[0]?.text}`);
		assert.equal(sideEffects(isoM).spawns, before.spawns + 1);
		isoM.dispose();
	});

	await checkAsync("W4b 主会话 owner（global）同样不受本仓约束", async () => {
		const isoG = mkIsolated("w4global");
		const SID_GLOBAL = "01a140e8-3333-7000-8000-global-owner";
		useEnv(isoG);
		seedOwner(isoG, REPO, SID_GLOBAL, masterAddress());
		installSpawnStub();
		const pi = await bootIn(isoG, {}, { PI_TAB_RUN_ID: undefined, PI_SESSION_PROFILE: "main", PI_SUBAGENT: undefined });
		const r = (await pi.tools.get("launch-tabs")!.execute("", { tasks: [{ taskId: "W4b", prompt: "x", cwd: OTHER }] }, undefined, undefined, { cwd: REPO, sessionManager: { sessionId: SID_GLOBAL } })) as { isError?: boolean; content: Array<{ text: string }> };
		assert.equal(r.isError, false, `main 路径不收紧（global owner 也走 main）：${r.content[0]?.text}`);
		isoG.dispose();
	});

	restoreSpawn();
	isoW.dispose();
})();

// ── W5/W6/W7/W7b：master-dispatch 经完整生产链 ─────────────────────────
// 生产链：master-dispatch.execute → index.dispatchTab 闭包 → masterDispatchLaunch（最终 fencing）
//         → launchWorkflowTab（账本/link/timer/spawn）→ spawnPiTab（fake spawn 边界）
// 关键：不注入 fake dispatchTab（那会跳过 gate→落账之间的最终 reader，W5 会虚绿）。
await (async () => {
	console.log("W5–W7b master-dispatch 经真实 factory → dispatchTab → masterDispatchLaunch → launchWorkflowTab");
	const isoD = mkIsolated("w5");
	const REPO = join(isoD.root, "repo-md");
	const OTHER = join(isoD.root, "repo-md-other");
	mkdirSync(join(REPO, "sub"), { recursive: true });
	mkdirSync(join(OTHER, "deep", "x"), { recursive: true });
	useEnv(isoD);
	const SID_LOCAL = "01a1518c-4444-7000-8000-md-local";
	const SID_GLOBAL = "01a140e8-5555-7000-8000-md-global";
	seedOwner(isoD, REPO, SID_LOCAL); // local owner
	seedOwner(isoD, REPO, SID_GLOBAL, masterAddress()); // global owner（独立地址，独立 sid）

	installSpawnStub();
	const pi = await bootIn(isoD, { "tab-run-id": "tab_lms_md" }, { PI_TAB_RUN_ID: "tab_lms_md", PI_SESSION_PROFILE: "workflow-tab", PI_SUBAGENT: undefined });
	const md = pi.tools.get("master-dispatch")!;
	const ctxFor = (cwd: string, sid: string) => ({ cwd, sessionManager: { sessionId: sid } });

	await checkAsync("W5 local master 经真实链派本仓 tab ⇒ via owner 成功（最终 reader 读 local 地址，断点 #2）", async () => {
		const before = sideEffects(isoD);
		const r = (await md.execute("", { taskId: "W5", prompt: "干活", cwd: join(REPO, "sub") }, undefined, undefined, ctxFor(REPO, SID_LOCAL))) as { isError?: boolean; content: Array<{ text: string }>; details?: { runId?: string; text?: string } };
		assert.equal(r.isError, undefined, `local owner 必须派发成功：${r.content[0]?.text}`);
		assert.ok(r.details?.runId, "必须返回 runId");
		const after = sideEffects(isoD);
		assert.equal(after.dispatches, before.dispatches + 1, "真写 dispatch");
		assert.equal(after.links, before.links + 1, "真写 link");
		assert.equal(after.spawns, before.spawns + 1, "真到 spawn 边界");
		assert.equal(after.supervision, before.supervision + 1, "自动监管登记必须发生");
	});

	await checkAsync("W6 global master 经真实链派他仓 cwd ⇒ 仍成功（**最易踩的回归**）", async () => {
		const before = sideEffects(isoD);
		const r = (await md.execute("", { taskId: "W6", prompt: "跨仓", cwd: OTHER }, undefined, undefined, ctxFor(REPO, SID_GLOBAL))) as { isError?: boolean; content: Array<{ text: string }>; details?: { runId?: string } };
		assert.equal(r.isError, undefined, `global owner 跨仓必须成功：${r.content[0]?.text}`);
		assert.ok(r.details?.runId);
		const after = sideEffects(isoD);
		assert.equal(after.spawns, before.spawns + 1);
		assert.equal(after.dispatches, before.dispatches + 1);
	});

	await checkAsync("W7 local owner 派他仓 cwd ⇒ 拒绝，零副作用（local 档才加仓约束）", async () => {
		const before = sideEffects(isoD);
		const r = (await md.execute("", { taskId: "W7", prompt: "越界", cwd: OTHER }, undefined, undefined, ctxFor(REPO, SID_LOCAL))) as { isError?: boolean; content: Array<{ text: string }>; details?: { reason?: string } };
		assert.equal(r.isError, true, "local owner 越仓必须拒");
		assert.equal(r.details?.reason, "local-cwd:cross-repo");
		assert.deepEqual(sideEffects(isoD), before, "拒绝时零副作用");
	});

	await checkAsync("W7b global owner 派他仓 cwd ⇒ **必须成功**（W11 变异的目标断言）", async () => {
		const before = sideEffects(isoD);
		const r = (await md.execute("", { taskId: "W7b", prompt: "全球派", cwd: join(OTHER, "deep", "x") }, undefined, undefined, ctxFor(REPO, SID_GLOBAL))) as { isError?: boolean; content: Array<{ text: string }>; details?: { runId?: string } };
		assert.equal(r.isError, undefined, `global 跨仓必须成功，实得：${r.content[0]?.text}`);
		assert.ok(r.details?.runId);
		assert.equal(sideEffects(isoD).spawns, before.spawns + 1);
	});

	await checkAsync("W7c 最终 reader 必须读**选中的**地址：把 global 附件改成不匹配、local 保持匹配 ⇒ local 仍成功", async () => {
		// 这条是「index.ts:3310 纯 global reader」的直接反证：若最终 reader 仍读 global，
		// local owner 会在这里变 stale（因为 global 附件 sid 不等于本次 local owner 的 sid）。
		const before = sideEffects(isoD);
		const r = (await md.execute("", { taskId: "W7c", prompt: "再来一次", cwd: REPO }, undefined, undefined, ctxFor(REPO, SID_LOCAL))) as { isError?: boolean; content: Array<{ text: string }> };
		assert.equal(r.isError, undefined, `local owner 必须仍成功（最终 reader 读 local 地址）：${r.content[0]?.text}`);
		assert.ok(!r.content[0]!.text.includes("stale"), "不得因读错地址变成 stale");
		assert.equal(sideEffects(isoD).spawns, before.spawns + 1);
	});

	await checkAsync("W6b 同 sid 同时拥有 global/local ⇒ global 优先（保留全局编排能力）", async () => {
		const isoB = mkIsolated("w6b");
		useEnv(isoB);
		const SID_BOTH = "01a1518c-6666-7000-8000-md-both";
		seedOwner(isoB, REPO, SID_BOTH); // local
		seedOwner(isoB, REPO, SID_BOTH, masterAddress()); // 同 sid 也持有 global
		installSpawnStub();
		const piB = await bootIn(isoB, { "tab-run-id": "tab_lms_both" }, { PI_TAB_RUN_ID: "tab_lms_both", PI_SESSION_PROFILE: "workflow-tab", PI_SUBAGENT: undefined });
		// 跨仓 cwd：若错选 local 就会被 cross-repo 拒；选 global 才允许
		const r = (await piB.tools.get("master-dispatch")!.execute("", { taskId: "W6b", prompt: "x", cwd: OTHER }, undefined, undefined, ctxFor(REPO, SID_BOTH))) as { isError?: boolean; content: Array<{ text: string }> };
		assert.equal(r.isError, undefined, `同 sid 双 owner 时必须选 global（否则跨仓被拒）：${r.content[0]?.text}`);
		isoB.dispose();
	});

	await checkAsync("W6c master-dispatch unknown / subagent 仍拒（原判决不变）", async () => {
		const r1 = (await md.execute("", { taskId: "W6c", prompt: "x" }, undefined, undefined, { cwd: REPO, sessionManager: { sessionId: "unknown" } })) as { isError?: boolean };
		assert.equal(r1.isError, true, "unknown session 必须拒");
		const saved = process.env.PI_SUBAGENT;
		process.env.PI_SUBAGENT = "1";
		try {
			const r2 = (await md.execute("", { taskId: "W6c2", prompt: "x" }, undefined, undefined, ctxFor(REPO, SID_LOCAL))) as { isError?: boolean; content: Array<{ text: string }> };
			assert.equal(r2.isError, true, "subagent 必须拒");
			assert.match(r2.content[0]!.text, /子 agent/);
		} finally {
			if (saved === undefined) delete process.env.PI_SUBAGENT; else process.env.PI_SUBAGENT = saved;
		}
	});

	restoreSpawn();
	isoD.dispose();
})();

// ── W13：第三读（gate 后、落账前替换附件 ⇒ stale）─────────────────────
await (async () => {
	console.log("W13 第三读（最终 fencing）：gate 通过后替换附件 ⇒ stale，五账本零新增 + spawn=0");
	const isoE = mkIsolated("w13");
	const REPO = join(isoE.root, "repo-fence");
	mkdirSync(REPO, { recursive: true });
	useEnv(isoE);
	const SID_OWNER = "01a1518c-7777-7000-8000-w13-owner";
	seedOwner(isoE, REPO, SID_OWNER);

	installSpawnStub();
	const pi = await bootIn(isoE, { "tab-run-id": "tab_lms_w13" }, { PI_TAB_RUN_ID: "tab_lms_w13", PI_SESSION_PROFILE: "workflow-tab", PI_SUBAGENT: undefined });
	const md = pi.tools.get("master-dispatch")!;
	const lt = pi.tools.get("launch-tabs")!;
	const ctx = { cwd: REPO, sessionManager: { sessionId: SID_OWNER } };

	// 直接驱动 launch-workflow 的最终 fencing（生产接线：dispatchTab 会把 args.owner.agentAddress
	// 交给 masterDispatchLaunch 的 reader；这里用同一入口但让 gate 与落账之间的附件被替换）。
	const { masterDispatchLaunch } = await import("./launch-workflow.ts");
	type WorkflowSpawnFn = Parameters<typeof masterDispatchLaunch>[1] extends { spawn?: infer S } ? NonNullable<S> : never;
	// fake spawn：只替换终端进程边界（不真开 WT），账本/link/timer 仍走真实原语。
	// 计数落这个私有变量（sideEffects().spawns 统计的是模块级 spawnPiTab 边界，这里被替换掉了）。
	let fakeSpawnCalls = 0;
	const okSpawnFake: WorkflowSpawnFn = (_wt, _pi, cwd, title, prompt, model) => {
		fakeSpawnCalls++;
		return { title, prompt, model, cwd };
	};
	const { readAttachment: readAtt } = await import("./runtime/registry.ts");
	const localAddr = localMasterAddress(localMasterScope(REPO));

	await checkAsync("W13(a) global 附件在 gate 后 gen bump ⇒ stale + 零账本 + 零 spawn", async () => {
		const before = sideEffects(isoE);
		const snap = (gen: number): MasterAttachment => {
			const att = readAtt(masterAddress())!;
			return { ...att, generation: gen };
		};
		const res = masterDispatchLaunch(
			{ taskId: "W13", prompt: "x", mode: "workflow", sessionId: "sid-g", owner: { ...snap(1), agentAddress: masterAddress() } },
			{
				wtPath: "wt.exe", piCli: "pi-cli.js",
				env: { wtPath: "wt.exe", piCli: "pi-cli.js", runsDir: isoE.runsDir, timersDir: isoE.timersDir, linksPath: isoE.linksPath },
				spawn: okSpawnFake,
				readAttachment: () => snap(2),
			},
		);
		assert.equal(res.stale, true, "gen change 必须 stale");
		assert.equal(res.runId, undefined);
		assert.deepEqual(sideEffects(isoE), before, "stale 必须零新增");
	});

	await checkAsync("W13(b) 最终 reader 读 local 地址时 detach ⇒ stale（地址形状不符也拒）", async () => {
		const before = sideEffects(isoE);
		const localSnap = readAtt(localAddr)!;
		const res = masterDispatchLaunch(
			{ taskId: "W13b", prompt: "x", mode: "workflow", sessionId: SID_OWNER, owner: localSnap },
			{
				wtPath: "wt.exe", piCli: "pi-cli.js",
				env: { wtPath: "wt.exe", piCli: "pi-cli.js", runsDir: isoE.runsDir, timersDir: isoE.timersDir, linksPath: isoE.linksPath },
				spawn: okSpawnFake,
				readAttachment: () => ({ ...localSnap, agentAddress: masterAddress() }), // 地址不符
			},
		);
		assert.equal(res.stale, true, "地址不符必须 stale（registry 不代劳此校验）");
		assert.deepEqual(sideEffects(isoE), before);
	});

	await checkAsync("W13(c) 对照：同快照 ⇒ 放行（证明上面的红不是「一律 stale」）", async () => {
		const localSnap = readAtt(localAddr)!;
		const before = sideEffects(isoE);
		const res = masterDispatchLaunch(
			{ taskId: "W13c", prompt: "x", mode: "workflow", sessionId: SID_OWNER, owner: localSnap },
			{
				wtPath: "wt.exe", piCli: "pi-cli.js",
				env: { wtPath: "wt.exe", piCli: "pi-cli.js", runsDir: isoE.runsDir, timersDir: isoE.timersDir, linksPath: isoE.linksPath },
				spawn: okSpawnFake,
				readAttachment: () => readAtt(localAddr),
			},
		);
		assert.ok(!res.stale && !res.error && res.runId, `同快照必须放行：${JSON.stringify(res)}`);
		assert.equal(fakeSpawnCalls, 1, "同快照必须真的走到 spawn 边界");
		assert.equal(sideEffects(isoE).dispatches, before.dispatches + 1, "且必须写账本");
	});

	await checkAsync("W13(e) **gate 通过后、写账本前**被 takeover ⇒ stale-owner 整批拒（真实 fs 边界注入）", async () => {
		// 这条专打 §8.2.6 的「写入前重读」：gate 双读都看过合法快照，第三读（index.ts 里
		// `localOwnerStillFresh`）才看到被 takeover 的附件。注入点是**文件系统边界**
		// （同进程真实 execute / 真实 reader，只把「另一个进程改附件」提前到第 2 读之后），
		// 因此删掉写入前重读（MUTATION-M9）本用例必须实红。
		const { attachmentPathFor: pathFor } = await import("./runtime/registry.ts");
		const targetFile = pathFor(localAddr);
		const norm = (x: string): string => x.split("\\").join("/").toLowerCase();
		const original = readFileSync(targetFile, "utf8");
		const realReadFileSync = fs.readFileSync;
		let reads = 0;
		const before = sideEffects(isoE);
		// syncBuiltinESMExports 让 registry.ts 已捕获的 `readFileSync` 具名绑定一起被替换
		// （同 `_test_launch.ts` 对 child_process 的手法）。
		(fs as unknown as { readFileSync: unknown }).readFileSync = ((p2: unknown, ...rest: unknown[]) => {
			const out = (realReadFileSync as unknown as (...a: unknown[]) => string)(p2, ...rest);
			if (typeof p2 === "string" && norm(p2) === norm(targetFile)) {
				reads++;
				if (reads === 2) {
					// 第 2 读（gate 的 generation fencing）之后立刻模拟他进程 takeover
					const parsed = JSON.parse(out) as MasterAttachment;
					writeFileSync(targetFile, JSON.stringify({ ...parsed, sessionId: "sid-takeover-mid-flight", generation: parsed.generation + 1, detail: parsed.detail }), "utf8");
				}
			}
			return out;
		}) as unknown;
		syncBuiltinESMExports();
		let r: { isError?: boolean; details?: { reason?: string }; content: Array<{ text: string }> };
		try {
			r = (await lt.execute("", { tasks: [{ taskId: "W13e", prompt: "x", cwd: REPO }] }, undefined, undefined, ctx)) as typeof r;
		} finally {
			(fs as unknown as { readFileSync: unknown }).readFileSync = realReadFileSync;
			writeFileSync(targetFile, original, "utf8");
			syncBuiltinESMExports();
		}
		assert.ok(reads >= 3, `写入前重读必须真的发生（实际读次数 ${reads}）`);
		assert.equal(r.isError, true, `中途 takeover 必须拒：${r.content[0]?.text}`);
		assert.equal(r.details?.reason, "stale-owner", `必须是 stale-owner，实得 ${r.details?.reason}`);
		assert.deepEqual(sideEffects(isoE), before, "整批拒绝 ⇒ 零副作用");
	});

	await checkAsync("W13(d) launch-tabs owner 批次「写入前重读」：takeover 后整批拒（零副作用）", async () => {
		// 让 owner 失效（takeover 成别人）后，owner 路径必须拒绝且零副作用
		const { attachMaster: attach } = await import("./runtime/registry.ts");
		const t = attach({ sessionId: "sid-took-over-w13", agent: localAddr, forceStale: true, staleAfterMs: -1 });
		assert.equal(t.ok, true, "夹具：takeover 必须成功");
		const before = sideEffects(isoE);
		const r = (await lt.execute("", { tasks: [{ taskId: "W13d", prompt: "x", cwd: REPO }] }, undefined, undefined, ctx)) as { isError?: boolean; details?: { reason?: string } };
		assert.equal(r.isError, true);
		assert.equal(r.details?.reason, "tab-session", "原 owner 已被 takeover ⇒ 不再是 owner");
		assert.deepEqual(sideEffects(isoE), before);
	});

	restoreSpawn();
	isoE.dispose();
})();

// ── W14：路径政策经真实入口 ────────────────────────────────────────
await (async () => {
	console.log("W14 路径政策（经真实 launch-tabs execute 的 local owner 分支）");
	const isoP = mkIsolated("w14");
	const REPO = join(isoP.root, "repo-path");
	const OTHER = join(isoP.root, "repo-path-other");
	const SIBLING = `${REPO}-2`;
	mkdirSync(join(REPO, "deep", "nested"), { recursive: true });
	mkdirSync(OTHER, { recursive: true });
	mkdirSync(SIBLING, { recursive: true });
	useEnv(isoP);
	const SID = "01a1518c-8888-7000-8000-w14-owner";
	seedOwner(isoP, REPO, SID);
	installSpawnStub();
	const pi = await bootIn(isoP, { "tab-run-id": "tab_lms_w14" }, { PI_TAB_RUN_ID: "tab_lms_w14", PI_SESSION_PROFILE: "workflow-tab", PI_SUBAGENT: undefined });
	const lt = pi.tools.get("launch-tabs")!;
	const ctx = { cwd: REPO, sessionManager: { sessionId: SID } };
	const run = async (cwd: string | undefined) =>
		(await lt.execute("", { tasks: [{ taskId: "W14", prompt: "x", ...(cwd === undefined ? {} : { cwd }) }] }, undefined, undefined, ctx)) as { isError?: boolean; content: Array<{ text: string }>; details?: { reason?: string } };

	await checkAsync("W14(a) 本仓根 / 子树 / 反斜杠 ⇒ 成功", async () => {
		for (const c of [REPO, join(REPO, "deep", "nested"), REPO.replace(/\//g, "\\")]) {
			const r = await run(c);
			assert.equal(r.isError, false, `${c} 应成功：${r.content[0]?.text}`);
		}
	});
	await checkAsync("W14(b) 他仓 / 同前缀兄弟 / `..` 逃逸 ⇒ cross-repo，零副作用", async () => {
		const before = sideEffects(isoP);
		for (const c of [OTHER, SIBLING, `${REPO.replace(/\\/g, "/")}/../repo-path-other`]) {
			const r = await run(c);
			assert.equal(r.isError, true, `${c} 必须拒`);
			assert.equal(r.details?.reason, "cross-repo", `${c} reason`);
		}
		assert.deepEqual(sideEffects(isoP), before, "全部拒绝 ⇒ 零副作用");
	});
	await checkAsync("W14(c) 显式空白 / 相对路径 ⇒ blank / relative", async () => {
		assert.equal((await run("   ")).details?.reason, "blank");
		assert.equal((await run("deep/nested")).details?.reason, "relative");
	});
	await checkAsync("W14(d) 省略 cwd ⇒ 用 process.cwd() 校验（本进程 cwd 在本仓外 ⇒ 拒，且不是静默放行）", async () => {
		const r = await run(undefined);
		// 本进程 cwd = 仓库根（subagent-win），不在 isoP 的临时仓内 ⇒ 必须拒
		assert.equal(r.isError, true, `省略 cwd 且 process.cwd() 在仓外必须拒（不得静默放行）：${r.content[0]?.text}`);
		assert.equal(r.details?.reason, "cross-repo");
	});
	await checkAsync("W14(e) 混合合法/非法批次 ⇒ 零副作用", async () => {
		const before = sideEffects(isoP);
		const r = (await lt.execute("", { tasks: [
			{ taskId: "W14-ok", prompt: "x", cwd: REPO },
			{ taskId: "W14-bad", prompt: "x", cwd: OTHER },
		] }, undefined, undefined, ctx)) as { isError?: boolean };
		assert.equal(r.isError, true);
		assert.deepEqual(sideEffects(isoP), before);
	});
	await checkAsync("W14(f) detail 空白 ⇒ 回退可信 cwd；两者都无效 ⇒ 拒", async () => {
		const { attachMaster: attach } = await import("./runtime/registry.ts");
		const addr = localMasterAddress(localMasterScope(REPO));
		// detail 空白（gen bump 保留 sessionId=自己 ⇒ 仍是 owner）
		const t = attach({ sessionId: SID, agent: addr, forceStale: true, staleAfterMs: -1, detail: "   " });
		assert.equal(t.ok, true);
		const r = await run(REPO);
		assert.equal(r.isError, false, `detail 空白应回退 ctx.cwd：${r.content[0]?.text}`);
	});

	restoreSpawn();
	isoP.dispose();
})();

// ── W15：防扩散 / 原行为 / 上限 / timers ───────────────────────────
await (async () => {
	console.log("W15 防扩散与原行为（sub / trace-worker / 父派生 child / 空批 / 上限 / timers）");
	const isoF = mkIsolated("w15");
	const REPO = join(isoF.root, "repo-diff");
	mkdirSync(REPO, { recursive: true });
	useEnv(isoF);
	const SID = "01a1518c-9999-7000-8000-w15-owner";
	seedOwner(isoF, REPO, SID);
	installSpawnStub();

	await checkAsync("W15(a) subagent ⇒ 拒（即使恰好持有 owner 附件；launch-tabs 早期 fast-path 也不注册）", async () => {
		const pi = await bootIn(isoF, {}, { PI_SUBAGENT: "1", PI_TAB_RUN_ID: undefined, PI_SESSION_PROFILE: undefined });
		assert.equal(pi.tools.has("launch-tabs"), false, "subagent 进程走 fast-path，不注册 launch-tabs（原纵深不变）");
	});

	await checkAsync("W15(b) trace-worker（有 tabRunId + 恰好持有 owner 附件）⇒ 拒 not-workflow-tab", async () => {
		const pi = await bootIn(isoF, { "tab-run-id": "tab_trace_worker", "session-profile": "trace-worker" }, { PI_TAB_RUN_ID: "tab_trace_worker", PI_SESSION_PROFILE: "trace-worker", PI_SUBAGENT: undefined });
		const before = sideEffects(isoF);
		const r = (await pi.tools.get("launch-tabs")!.execute("", { tasks: [{ taskId: "W15b", prompt: "x", cwd: REPO }] }, undefined, undefined, { cwd: REPO, sessionManager: { sessionId: SID } })) as { isError?: boolean; details?: { reason?: string }; content: Array<{ text: string }> };
		assert.equal(r.isError, true, "trace-worker 不在例外内");
		assert.equal(r.details?.reason, "not-workflow-tab");
		assert.deepEqual(sideEffects(isoF), before);
	});

	await checkAsync("W15(c) 父派生 child（不同 durable UUID，父存活）⇒ child 拒（不因同 cwd 继承 owner）", async () => {
		const pi = await bootIn(isoF, { "tab-run-id": "tab_child_of_lms" }, { PI_TAB_RUN_ID: "tab_child_of_lms", PI_SESSION_PROFILE: "workflow-tab", PI_SUBAGENT: undefined });
		const r = (await pi.tools.get("launch-tabs")!.execute("", { tasks: [{ taskId: "W15c", prompt: "x", cwd: REPO }] }, undefined, undefined, { cwd: REPO, sessionManager: { sessionId: "01a1518c-aaaa-7000-8000-derived-child" } })) as { isError?: boolean; details?: { reason?: string } };
		assert.equal(r.isError, true, "子 tab 用不同 UUID ⇒ 不是 owner");
		assert.equal(r.details?.reason, "tab-session");
	});

	await checkAsync("W15(d) 空批 / 超 MAX_CONCURRENCY ⇒ 原判决不变（且先于 owner 校验）", async () => {
		const pi = await bootIn(isoF, { "tab-run-id": "tab_lms_w15" }, { PI_TAB_RUN_ID: "tab_lms_w15", PI_SESSION_PROFILE: "workflow-tab", PI_SUBAGENT: undefined });
		const lt = pi.tools.get("launch-tabs")!;
		const ctx = { cwd: REPO, sessionManager: { sessionId: SID } };
		const empty = (await lt.execute("", { tasks: [] }, undefined, undefined, ctx)) as { isError?: boolean; content: Array<{ text: string }> };
		assert.equal(empty.isError, true);
		assert.match(empty.content[0]!.text, /at least one task/);
		const huge = Array.from({ length: 51 }, (_, i) => ({ taskId: `H${i}`, prompt: "x", cwd: REPO }));
		const over = (await lt.execute("", { tasks: huge }, undefined, undefined, ctx)) as { isError?: boolean; content: Array<{ text: string }> };
		assert.equal(over.isError, true);
		assert.match(over.content[0]!.text, /at most 50/);
	});

	await checkAsync("W15(e) owner 批次 timers 仍按既有规则落盘（合法写、非法跳过），且监管自动登记", async () => {
		const pi = await bootIn(isoF, { "tab-run-id": "tab_lms_w15e" }, { PI_TAB_RUN_ID: "tab_lms_w15e", PI_SESSION_PROFILE: "workflow-tab", PI_SUBAGENT: undefined });
		const before = sideEffects(isoF);
		const r = (await pi.tools.get("launch-tabs")!.execute("", { tasks: [{
			taskId: "W15e", prompt: "x", cwd: REPO,
			timers: [
				{ delayMs: 60_000, message: "推进" },
				{ delayMs: -5, message: "非法延时" },
				{ delayMs: 60_000, message: "   " },
			],
		}] }, undefined, undefined, { cwd: REPO, sessionManager: { sessionId: SID } })) as { isError?: boolean; content: Array<{ text: string }>; details?: { supervision?: { registered: number } } };
		assert.equal(r.isError, false, r.content[0]?.text);
		const after = sideEffects(isoF);
		assert.equal(after.timers, before.timers + 1, "只应写入 1 个合法 timer");
		assert.equal(after.supervision, before.supervision + 1, "监管自动登记");
		assert.equal(r.details?.supervision?.registered, 1);
	});

	await checkAsync("W15(f) spawn 同步失败 ⇒ 既有回账规则不变（launch_failed）", async () => {
		const pi = await bootIn(isoF, { "tab-run-id": "tab_lms_w15f" }, { PI_TAB_RUN_ID: "tab_lms_w15f", PI_SESSION_PROFILE: "workflow-tab", PI_SUBAGENT: undefined });
		installSpawnStub({ spawnError: "boom-spawn" });
		const r = (await pi.tools.get("launch-tabs")!.execute("", { tasks: [{ taskId: "W15f", prompt: "x", cwd: REPO }] }, undefined, undefined, { cwd: REPO, sessionManager: { sessionId: SID } })) as { isError?: boolean; content: Array<{ text: string }> };
		assert.equal(r.isError, true, "spawn 失败必须报错");
		const dispatches = listTabDispatches(isoF.runsDir, 10_000).filter((d) => d.taskId === "W15f");
		assert.ok(dispatches.length >= 1, "必须落账");
		assert.equal(dispatches[dispatches.length - 1]!.dispatchStatus, "launch_failed", "必须回账 launch_failed");
		installSpawnStub();
	});

	restoreSpawn();
	isoF.dispose();
})();

// ── W16：地址一致性（读路径 vs 快照正文）────────────────────────────
await (async () => {
	console.log("W16 地址一致性（文件路径 local / 正文 global，及反向 ⇒ 全部 fail-closed）");
	const isoA = mkIsolated("w16");
	const REPO = join(isoA.root, "repo-addr");
	mkdirSync(REPO, { recursive: true });
	useEnv(isoA);
	const SID = "01a1518c-bbbb-7000-8000-w16-owner";
	const localAddr = localMasterAddress(localMasterScope(REPO));
	const globalAddr = masterAddress();
	seedOwner(isoA, REPO, SID); // 先写一份合法的 local 附件
	// 篡改正文：文件在 local 路径，正文 agentAddress 写 global（sid/gen 保持不变）
	const { attachmentPathFor } = await import("./runtime/registry.ts");
	const localFile = attachmentPathFor(localAddr);
	const original = JSON.parse(readFileSync(localFile, "utf8")) as MasterAttachment;

	check("W16(a) launch helper 严格读：正文地址不符 ⇒ null（不把 global 当 local lease）", () => {
		writeFileSync(localFile, JSON.stringify({ ...original, agentAddress: globalAddr, generation: 2 }), "utf8");
		try {
			assert.equal(readLocalOwnerAttachmentStrict(localAddr), null, "地址不符必须 null");
			// registry 本身仍能读到（证明这是本层的额外校验，不依赖 registry 代劳）
			assert.ok(readAttachment(localAddr), "registry.readAttachment 只验形状（对照）");
		} finally {
			writeFileSync(localFile, JSON.stringify(original), "utf8");
		}
	});

	check("W16(b) 双地址 pin reader：两端正文互串 ⇒ 恒 null（fail-closed）", () => {
		const reader = makePinnedOwnerReader({
			sessionId: SID,
			cwd: REPO,
			readAttachment: (a: ObjectAddress) => ({ ...original, agentAddress: a === localAddr ? globalAddr : localAddr, sessionId: SID, generation: 1 }),
		});
		assert.equal(reader.read(), null);
		assert.equal(reader.pinned(), null);
	});

	check("W16(c) 最终第三读：正文地址被替换 ⇒ stale（localOwnerStillFresh 也校地址）", () => {
		assert.equal(
			localOwnerStillFresh({ attachment: original, readAttachment: () => ({ ...original, agentAddress: globalAddr }) }),
			false,
			"最终 reader 必须比地址",
		);
		assert.equal(localOwnerStillFresh({ attachment: original, readAttachment: () => original }), true, "对照：同快照放行");
	});

	await checkAsync("W16(d) 非 owner main 仍保留原 main fallback（不被地址校验收紧）", async () => {
		installSpawnStub();
		const pi = await bootIn(isoA, {}, { PI_TAB_RUN_ID: undefined, PI_SESSION_PROFILE: "main", PI_SUBAGENT: undefined });
		const r = (await pi.tools.get("launch-tabs")!.execute("", { tasks: [{ taskId: "W16d", prompt: "x", cwd: REPO }] }, undefined, undefined, { cwd: REPO, sessionManager: { sessionId: "sid-not-an-owner" } })) as { isError?: boolean; content: Array<{ text: string }> };
		assert.equal(r.isError, false, `main 非 owner 必须走原路径：${r.content[0]?.text}`);
		restoreSpawn();
	});

	isoA.dispose();
})();

// ── 清理 + 汇总 ─────────────────────────────────────────────────────
restoreSpawn();
rmSync(ENV_TMP, { recursive: true, force: true });
console.log("");
if (failed > 0) {
	console.error(`_test_local_owner_gate: FAILED (${failed} failed / ${passed} passed)`);
	for (const f of failures) console.error(`  - ${f}`);
	process.exit(1);
}
console.log(`_test_local_owner_gate: all ${passed} checks passed`);
