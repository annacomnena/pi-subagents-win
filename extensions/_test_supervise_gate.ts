/**
 * _test_supervise_gate.ts — 方案 C（ownership 门）验收：`supervise-push` 的 execute 层身份/目标门
 *
 * 任务书：`plans/20261019_supervise_push_gate_task_brief.md` §4（G1–G9 / W1–W7）
 * 独立审查：`plans/20261019_plan_review_supervise_gate.md`（R1/R3/R6/R8/R9 修订）
 * 实现报告：`plans/20261019_supervise_push_gate_report.md`
 *
 * 覆盖：
 *   G1–G9  纯函数矩阵（`supervisePushGate`，全注入零 IO）
 *   W1/W2  接线变异断言（源码锚点：门是否真接在 execute 里、目标约束是否真在）
 *   W4     工具描述文本含「本仓 owner」（防文档漂移）
 *   W5/W6  `spawnOneShotTab` 真接线（真写 dispatch + 假 spawn → 真监管账本 open/<runId>.json）
 *   W7     cross-repo / self-push 拒绝真写 audit 行（经真实工具入口 + 真 fake pi）
 *   E2/E3  端到端（真 local master 进程）——**本文件不伪造**，见报告 NOT-VERIFIED 说明；
 *          这里只做「本进程内可做到的最近一级」：用**真** `attachMaster` 写死的 local owner 附件 +
 *          真实工具入口，证明「owner 身份真的来自磁盘上的 local 地址、而不是自造 sid」。
 *
 * 运行：npx tsx extensions/_test_supervise_gate.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 测试隔离：runtime/links/steer/tab-runs 全部走 temp（同 _test_runtime_supervision_push 模式）
const ENV_TMP = mkdtempSync(join(tmpdir(), "supervise-gate-"));
process.env.PI_RUNTIME_DIR = ENV_TMP;
process.env.PI_TAB_RUNS_DIR = join(ENV_TMP, "tab-runs");
process.env.PI_LINKS_PATH = join(ENV_TMP, "links.jsonl");
delete process.env.PI_TAB_RUN_ID;
delete process.env.PI_SUBAGENT;

import { readLocalOwnerAttachment, supervisePushGate, SUPERVISE_GATE_TEXT } from "./supervise-gate.ts";
import { registerSupervisionTools } from "./supervision-runtime.ts";
import { readSupervisionLedger, setSupervisionStatus, writeSupervisionEntry } from "./runtime/supervision.ts";
import { attachMaster, readAttachment } from "./runtime/registry.ts";
import { buildScopeWakePrompt, localMasterAddress, localMasterScope } from "./runtime/scope.ts";
import { buildSupervisionBlock, buildWakePrompt, normRepoPath, repoPathMatches, type WakeLetter, type WakeSupervisionItem } from "./runtime/wake.ts";
import { spawnOneShotTab } from "./one-shot-tab.ts";
import { readTabDispatch, type TabState, writeTabState, writeTabDispatch } from "./tab-runs.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void): void {
	try {
		fn();
		passed++;
		console.log(`  ✓ ${name}`);
	} catch (e) {
		failed++;
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
		console.error(`  ✗ ${name}`);
		console.error(`    ${String((e as Error)?.message ?? e)}`);
	}
}

/** 每个用例独立 stateDir/runsDir（互不污染，失败可单独复跑）。 */
function mkIsolated(name: string): { root: string; stateDir: string; runsDir: string; steerDir: string; dispose: () => void } {
	const root = mkdtempSync(join(tmpdir(), `supervise-gate-${name}-`));
	return {
		root,
		stateDir: join(root, "state"),
		runsDir: join(root, "tab-runs"),
		steerDir: join(root, "steer"),
		dispose: () => rmSync(root, { recursive: true, force: true }),
	};
}

/** 在隔离 runtime 里真写一份 local owner 附件（走 registry 的真实 attachMaster，不是自造对象）。 */
function seedLocalOwner(cwd: string, sessionId: string, generation = 1): void {
	const addr = localMasterAddress(localMasterScope(cwd));
	const r = attachMaster({ sessionId, agent: addr, detail: cwd });
	assert.equal(r.ok, true, `local owner attach 必须成功：${JSON.stringify(r)}`);
	assert.equal(r.ok && "attachment" in r ? r.attachment.generation : 0, generation);
}

function seqOf(attachment: { sessionId: string; generation: number }): { sid: string; gen: number } {
	return { sid: attachment.sessionId, gen: attachment.generation };
}

// ════════════════════ G1–G9：纯函数矩阵（全注入、零 IO）════════════════
console.log("G1–G9 supervisePushGate 纯函数矩阵（零 IO）");
{
	const REPO = "C:/tmp/gate/repo-under-test";
	const TARGET_RUN = "tab_target_1";
	const OWNER_SID = "sid-owner-aaaa";

	/** 造一份 owner 附件（不写盘：纯函数只吃注入值）。 */
	const ownerAtt = (over: Partial<{ sessionId: string; generation: number; detail: string }> = {}) => ({
		agentAddress: localMasterAddress(localMasterScope(REPO)),
		sessionId: over.sessionId ?? OWNER_SID,
		generation: over.generation ?? 3,
		attachedAt: iso(60_000),
		lastHeartbeatAt: iso(1_000),
		attemptId: "att_test",
		detail: over.detail ?? REPO,
	});

	/** 一份「本仓 owner + 目标也在本仓」的基线输入。 */
	const base = (over: Partial<Parameters<typeof supervisePushGate>[0]> = {}) => ({
		isSub: false,
		isTab: true,
		selfRunId: "tab_self_local_master",
		sessionId: OWNER_SID,
		readAttachment: () => ownerAtt(),
		ownerCwd: REPO,
		targetRunId: TARGET_RUN,
		targetRepoPath: () => `${REPO}/src/nested`,
		...over,
	});

	check("G1 sub=true（任意其它条件）⇒ ok:false reason:\"subagent\"", () => {
		const r = supervisePushGate(base({ isSub: true }));
		assert.equal(r.ok, false);
		assert.equal((r as { reason: string }).reason, "subagent");
		// 优先级：sub 硬挡必须高于 owner 放行（不能被 isTab/owner 覆盖）
		const r2 = supervisePushGate(base({ isSub: true, isTab: false, targetRunId: "" }));
		assert.equal((r2 as { reason: string }).reason, "subagent");
	});

	check("G2 非 tab + 非 owner ⇒ ok:true via:\"main\"（原行为），且**零 IO**（不读 attachment/dispatch）", () => {
		let attachReads = 0;
		let dispatchReads = 0;
		const r = supervisePushGate(base({
			isTab: false,
			selfRunId: undefined,
			readAttachment: () => { attachReads++; return null; },
			targetRepoPath: () => { dispatchReads++; return null; },
		}));
		assert.equal(r.ok, true);
		assert.equal((r as { via: string }).via, "main");
		assert.equal(attachReads, 0, "R3：非 tab 不得读 attachment（主会话路径零额外 IO）");
		assert.equal(dispatchReads, 0, "R3：非 tab 不得读 dispatch");
	});

	check("G3 tab + 本仓 owner（sid 同、gen 同、非 sub）⇒ ok:true via:\"owner\" + attachment 回传", () => {
		const r = supervisePushGate(base());
		assert.equal(r.ok, true, `应放行，实得 ${JSON.stringify(r)}`);
		const ok = r as Extract<typeof r, { ok: true }>;
		assert.equal(ok.via, "owner");
		assert.ok(ok.attachment, "owner 路径必须回传 attachment（调用方 fencing 用）");
		assert.equal(ok.attachment!.sessionId, OWNER_SID);
	});

	check("G4 tab + 非 owner ⇒ ok:false reason:\"tab-session\"（masterDispatchGate 的 not-owner/tab-session 合并）", () => {
		const r = supervisePushGate(base({ sessionId: "sid-some-other-tab" }));
		assert.equal(r.ok, false);
		assert.equal((r as { reason: string }).reason, "tab-session");
		// 无 owner 附件时也必须是 tab-session（不是放行、不是 unknown-session）
		const r2 = supervisePushGate(base({ readAttachment: () => null }));
		assert.equal((r2 as { reason: string }).reason, "tab-session");
	});

	check("G5 tab + owner 但双读 gen 变化（陈旧）⇒ ok:false reason:\"generation-mismatch\"", () => {
		let read = 0;
		const r = supervisePushGate(base({
			readAttachment: () => {
				read++;
				return read === 1 ? ownerAtt({ generation: 3 }) : ownerAtt({ generation: 4 });
			},
		}));
		assert.equal(r.ok, false);
		assert.equal((r as { reason: string }).reason, "generation-mismatch");
		assert.ok(read >= 2, "generation fencing 必须**双读**（readAttachment 至少被调两次）");
	});

	check("G6 tab + owner，目标是他仓 tab（repoPath 不在本 scope 子树）⇒ ok:false reason:\"cross-repo\"", () => {
		const r = supervisePushGate(base({ targetRepoPath: () => "D:/code/other-repo" }));
		assert.equal(r.ok, false);
		assert.equal((r as { reason: string }).reason, "cross-repo");
		// 相似前缀但不是子目录（repo-under-test-2 不得被当成 repo-under-test 的子目录）
		const r2 = supervisePushGate(base({ targetRepoPath: () => `${REPO}-2` }));
		assert.equal((r2 as { reason: string }).reason, "cross-repo", "前缀相似 ≠ 子目录（必须按 / 分段判）");
	});

	check("G7 tab + owner，目标 repoPath 为 null/空 ⇒ ok:false reason:\"cross-repo\"（fail-closed，不猜）", () => {
		const r = supervisePushGate(base({ targetRepoPath: () => null }));
		assert.equal((r as { reason: string }).reason, "cross-repo");
		const r2 = supervisePushGate(base({ targetRepoPath: () => "   " }));
		assert.equal((r2 as { reason: string }).reason, "cross-repo", "空白 repoPath 等同缺失");
	});

	check("G8 tab + owner，目标在**子目录**（dispatch.cwd 是 repo 子目录）⇒ ok:true via:\"owner\"", () => {
		const r = supervisePushGate(base({ targetRepoPath: () => `${REPO}/src/deep/nested`.replace(/\//g, "\\") }));
		assert.equal(r.ok, true, `子目录必须算本仓（含反斜杠形状），实得 ${JSON.stringify(r)}`);
		// 仓根本身也算命中
		assert.equal(supervisePushGate(base({ targetRepoPath: () => REPO })).ok, true);
	});

	check("G9 tab + owner，target runId === 自身 runId ⇒ ok:false reason:\"self-push\"", () => {
		const r = supervisePushGate(base({ targetRunId: "tab_self_local_master" }));
		assert.equal(r.ok, false);
		assert.equal((r as { reason: string }).reason, "self-push");
	});

	// ── 附加：文案/边界（不属 G1-G9，但防「静默放行」的洞）──
	check("G-extra(a) 六种拒绝 reason 都有非空文案，且文案区分「subagent」与「tab 非 owner」", () => {
		const reasons = ["subagent", "tab-session", "generation-mismatch", "unknown-session", "cross-repo", "self-push"] as const;
		for (const r of reasons) assert.ok(SUPERVISE_GATE_TEXT[r]?.length > 10, `${r} 缺文案`);
		assert.notEqual(SUPERVISE_GATE_TEXT.subagent, SUPERVISE_GATE_TEXT["tab-session"], "两种拒绝必须可辨（任务书 §5.2）");
	});
	check("G-extra(b) tab + sessionId=unknown ⇒ ok:false reason:\"unknown-session\"（fail-closed）", () => {
		assert.equal((supervisePushGate(base({ sessionId: "unknown" })) as { reason: string }).reason, "unknown-session");
		assert.equal((supervisePushGate(base({ sessionId: "" })) as { reason: string }).reason, "unknown-session");
	});
	check("G-extra(c) owner 附件缺 detail ⇒ 回退 ctx.cwd 判本仓（仍能正确判 cross-repo）", () => {
		const sameRepo = supervisePushGate(base({
			readAttachment: () => ({ ...ownerAtt(), detail: undefined } as never),
			ownerCwd: REPO,
			targetRepoPath: () => `${REPO}/sub`,
		}));
		assert.equal(sameRepo.ok, true, "detail 缺失时应回退 ctx.cwd");
		const other = supervisePushGate(base({
			readAttachment: () => ({ ...ownerAtt(), detail: undefined } as never),
			ownerCwd: REPO,
			targetRepoPath: () => "D:/elsewhere",
		}));
		assert.equal((other as { reason: string }).reason, "cross-repo");
	});
	check("G-extra(d) 仓根与 ctx.cwd 都拿不到 ⇒ cross-repo（fail-closed，不猜）", () => {
		const r = supervisePushGate(base({
			readAttachment: () => ({ ...ownerAtt(), detail: undefined } as never),
			ownerCwd: "",
			targetRepoPath: () => `${REPO}/sub`,
		}));
		assert.equal((r as { reason: string }).reason, "cross-repo");
	});
	check("G-extra(e) 目标 runId 为空 ⇒ owner 放行（本层不因目标缺失而拒，runId-required 由调用方管）", () => {
		const r = supervisePushGate(base({ targetRunId: "  " }));
		assert.equal(r.ok, true);
		assert.equal((r as { via: string }).via, "owner");
	});
	check("G-extra(f) 判据复用 wake.ts 同一函数（repoPathMatches/normRepoPath 已导出且行为一致）", () => {
		assert.equal(repoPathMatches("C:\\Code\\Repo\\sub", normRepoPath("C:/code/repo")), true);
		assert.equal(repoPathMatches("C:/code/repo2", normRepoPath("C:/code/repo")), false);
		assert.equal(repoPathMatches("", normRepoPath("C:/code/repo")), false);
	});

	// ── P1–P6：路径穿越反例（2026-10-19 返工，L4 §8 实测漏洞的**可证伪**回归）──
	// 背景：`C:/repo/../OtherRepo` 曾被判成本仓 ⇒ 跨仓放行。以下每条都必须**实红**于
	// 「去掉 canonicalize」的变异；报告 §返工 给出去掉后的实测输出。
	// 纪律：既测纯函数（P0/P3/P4/P5），也测**真 supervisePushGate**（P1/P2/P6）——
	// 只测前者挡不住「门里换了另一套判据」。
	check("P0 normRepoPath 必须消解 `.` / `..`（纯函数层，Windows 语义\"/\"≡\"\\\"、盘符大小写不敏感）", () => {
		assert.equal(normRepoPath("C:/repo/../OtherRepo"), normRepoPath("C:/OtherRepo"));
		assert.equal(normRepoPath("C:/repo/sub/../.."), normRepoPath("C:/"));
		assert.equal(normRepoPath("C:\\repo\\..\\other"), normRepoPath("C:/other"));
		assert.equal(normRepoPath("C:/repo/./sub/."), normRepoPath("C:/repo/sub"));
		// 根必须保留（不能退化成空串，否则子树判据会误开）
		assert.equal(normRepoPath("C:/repo/sub/../.."), "c:/");
		// 相对路径 ⇒ 空串（fail-closed，绝不吃 process.cwd()）
		assert.equal(normRepoPath("repo/sub"), "");
		assert.equal(normRepoPath("C:repo"), "");
	});
	check("P1 反例① `C:/repo/../other` ⇒ cross-repo（真 supervisePushGate）", () => {
		const r = supervisePushGate(base({ targetRepoPath: () => `${REPO}/../other` }));
		assert.equal(r.ok, false, `必须拒，实得 ${JSON.stringify(r)}`);
		assert.equal((r as { reason: string }).reason, "cross-repo");
	});
	check("P2 反例② `C:/repo/sub/../..` == `C:/` ⇒ cross-repo（真 supervisePushGate）", () => {
		const r = supervisePushGate(base({ targetRepoPath: () => `${REPO}/sub/../..` }));
		assert.equal(r.ok, false, `上跳两层必须拒，实得 ${JSON.stringify(r)}`);
		assert.equal((r as { reason: string }).reason, "cross-repo");
	});
	check("P3 反例③ `C:/REPO` vs `C:/repo` ⇒ **命中**（盘符/大小写不敏感，别修过头）", () => {
		assert.equal(repoPathMatches("C:/REPO", "C:/repo"), true);
		assert.equal(supervisePushGate(base({ targetRepoPath: () => `${REPO.toUpperCase()}/src` })).ok, true);
	});
	check("P4 反例④ `C:/repo` vs `C:/repo/sub` ⇒ **命中**（子目录，别修过头）", () => {
		assert.equal(repoPathMatches("C:/repo/sub", "C:/repo"), true);
		assert.equal(supervisePushGate(base({ targetRepoPath: () => `${REPO}/sub` })).ok, true);
	});
	check("P5 反例⑤ 反斜杠形状 `C:\\repo\\..\\other` ⇒ cross-repo（纯函数 + 真门）", () => {
		assert.equal(repoPathMatches("C:\\repo\\..\\other", "C:/repo"), false);
		const r = supervisePushGate(base({ targetRepoPath: () => `${REPO}/../other`.replace(/\//g, "\\") }));
		assert.equal((r as { reason: string }).reason, "cross-repo", `反斜杠不得绕过：${JSON.stringify(r)}`);
	});
	check("P6 反例⑥ 相对路径（含 `..`）⇒ 不命中（fail-closed，不吃 process.cwd()）", () => {
		assert.equal(repoPathMatches("../other", "C:/repo"), false);
		// 仓根侧也不接受相对路径（不能把 "../repo" 当成某个仓根）
		assert.equal(repoPathMatches("C:/repo", "../repo"), false);
		const r = supervisePushGate(base({ targetRepoPath: () => "../OtherRepo" }));
		assert.equal((r as { reason: string }).reason, "cross-repo", `相对路径必须 fail-closed：${JSON.stringify(r)}`);
	});
}

// ════════════════════ W4：工具描述文本（防文档漂移）═══════════════════
console.log("W4 工具描述文本断言（防文档漂移）");
{
	function makeFakePi() {
		const tools: Array<{ name: string; description?: string; execute: (...a: unknown[]) => Promise<unknown> }> = [];
		return {
			tools,
			registerTool(t: { name: string; description?: string; execute: (...a: unknown[]) => Promise<unknown> }) { tools.push(t); },
			registerCommand() {},
			on() {},
			findTool(name: string) { return tools.find((t) => t.name === name); },
		};
	}
	const pi = makeFakePi();
	const iso4 = mkIsolated("w4");
	try {
		registerSupervisionTools(pi as never, { stateDir: iso4.stateDir, runsDir: iso4.runsDir, steerDir: iso4.steerDir });
		const tool = pi.findTool("supervise-push");
		check("W4 工具描述含「本仓 owner」且**不再**声称「仅主会话可用」", () => {
			assert.ok(tool, "supervise-push 必须注册");
			const d = tool!.description ?? "";
			assert.ok(d.includes("本仓 owner"), `描述必须写清 owner 通道：${d.slice(-300)}`);
			assert.ok(!d.includes("仅主会话可用"), "旧表述「仅主会话可用」必须删掉（文档与行为不得相悖）");
			assert.ok(d.includes("cross-repo") && d.includes("self-push"), "描述必须声明两类目标约束");
		});
	} finally {
		iso4.dispose();
	}
}

// ════════════════════ W7 + E2/E3-最近一级：经**真实工具入口**的 owner 通道 ═══
// 关键：owner 身份**来自磁盘上真写的 local 附件**（registry.attachMaster + localAgentFromCwd 口径），
// 不是凭空造 sid。这正是 R1 的反证点：若注入全局 masterAddress()，本组会落 tab-session 而全红。
console.log("W7 / E2-E3 最近一级：真实工具入口 + 真 local owner 附件（R1 反证）");
{
	function makeFakePi() {
		const tools: Array<{ name: string; execute: (...a: unknown[]) => Promise<unknown> }> = [];
		return {
			tools,
			registerTool(t: { name: string; execute: (...a: unknown[]) => Promise<unknown> }) { tools.push(t); },
			registerCommand() {},
			on() {},
			findTool(name: string) { return tools.find((t) => t.name === name); },
		};
	}
	const isoW = mkIsolated("w7");
	const CITY = join(isoW.root, "repo-local");        // 本仓（owner 所在）
	const OTHER = join(isoW.root, "repo-other");       // 他仓
	const SID_OWNER = "01a1518c-ecec-74ee-be07-257fa0767371"; // 形状同实盘 local master sid
	const SELF_RUN = "tab_lms_local";
	const TARGET_SAME_REPO = "tab_same_repo";
	const TARGET_OTHER_REPO = "tab_other_repo";

	mkdirSync(CITY, { recursive: true });
	mkdirSync(OTHER, { recursive: true });

	const mkDispatch = (id: string, cwd: string) => ({
		id, version: 1 as const, taskId: `T-${id}`, mode: "workflow" as const, title: id,
		cwd, dispatchedAt: iso(30 * 60_000), dispatchStatus: "dispatched" as const,
	});
	const mkState = (id: string): TabState => ({
		id, phase: "waiting", turn: "idle", terminal: false,
		pid: process.pid, lastActivityAt: iso(16 * 60_000),
		lastAssistantText: "等外部条件", lastStopReason: "stop",
	});

	writeTabDispatch(isoW.runsDir, mkDispatch(TARGET_SAME_REPO, join(CITY, "src", "nested")));
	writeTabDispatch(isoW.runsDir, mkDispatch(TARGET_OTHER_REPO, OTHER));
	// 路径穿越目标（2026-10-19 返工，L4 §8）：dispatch.cwd 写成 `<本仓>/../repo-other`——
	// 文件系统实际解析到**他仓**。这是旧实现的真实越权形状（真门曾返回 ok:true via:owner）。
	const TARGET_DOTDOT = "tab_dotdot_repo";
	writeTabDispatch(isoW.runsDir, mkDispatch(TARGET_DOTDOT, `${CITY.replace(/\\/g, "/")}/../repo-other`));
	writeTabState(isoW.runsDir, TARGET_SAME_REPO, mkState(TARGET_SAME_REPO));
	writeTabState(isoW.runsDir, TARGET_OTHER_REPO, mkState(TARGET_OTHER_REPO));
	writeTabState(isoW.runsDir, TARGET_DOTDOT, mkState(TARGET_DOTDOT));
	// 监管账本：两目标都已登记（否则七门 no-mandate 会先拒，掩盖门② 的行为——任务书 §4.2.1 的 6a 坑）
	for (const rid of [TARGET_SAME_REPO, TARGET_OTHER_REPO, TARGET_DOTDOT]) {
		const r = setSupervisionStatus({ runId: rid, status: "active", setBy: "master:test" }, {
			stateDir: isoW.stateDir, tabRunsDir: isoW.runsDir,
		});
		assert.equal(r.ok, true, `账本预置失败 ${rid}: ${JSON.stringify(r)}`);
	}

	const pi = makeFakePi();
	const auditLines: string[] = [];
	registerSupervisionTools(pi as never, {
		stateDir: isoW.stateDir,
		runsDir: isoW.runsDir,
		steerDir: isoW.steerDir,
		now: () => new Date(),
		// 预算放大到 3，使本组「先成功 1 次 + 再测无 ctx 路径」不被 budget-exhausted 掩盖
		maxPushes: 3,
		audit: (l) => auditLines.push(l),
	});
	/** 把目标的 epoch 重置（清 pushes），使每次尝试都是「本 epoch 首次」。 */
	const resetEpoch = (runId: string): void => {
		const cur = readSupervisionLedger(runId, { stateDir: isoW.stateDir });
		assert.ok(cur, `${runId} 账本必须存在`);
		writeSupervisionEntry(
			{ ...cur!, epoch: { startedAt: new Date().toISOString(), pushes: [] } },
			{ stateDir: isoW.stateDir },
		);
	};
	const tool = pi.findTool("supervise-push")!;

	// 真实写入 local owner 附件（R1：地址 = localAgentFromCwd(CITY)，由 registry 落盘）
	const ownerWritten = (() => {
		try {
			seedLocalOwner(CITY, SID_OWNER);
			return true;
		} catch {
			return false;
		}
	})();

	check("W7-prep 真 local owner 附件已落盘，且**全局**附件不存在（R1 反证的边界条件）", () => {
		assert.equal(ownerWritten, true, "local owner attach 必须成功");
		const local = readLocalOwnerAttachment(CITY);
		assert.ok(local, "readLocalOwnerAttachment(cwd) 必须读到刚写的附件");
		assert.equal(local!.sessionId, SID_OWNER);
		assert.equal(local!.generation, 1);
		// 全附件目录里不含 agent://master_default（证明若误注入全局地址，本组必落 tab-session）
		assert.equal(readAttachment("agent://master_default" as never), null, "本隔离 runtime 不得存在全局 owner");
	});

	// ctx 夹具：shape 与真实 ExtensionToolContext 对齐（durableSessionIdentity 只读 sessionManager.sessionId）
	const ctxFor = (cwd: string, sid: string) => ({ cwd, sessionManager: { sessionId: sid } });

	await checkAsync("E2-最近一级(a) 真 local owner 经真实 execute 推**本仓** tab ⇒ 成功（steer 真落盘）", async () => {
		process.env.PI_TAB_RUN_ID = SELF_RUN;
		resetEpoch(TARGET_SAME_REPO);
		try {
			const res = (await tool.execute("", { runId: TARGET_SAME_REPO }, undefined, undefined, ctxFor(CITY, SID_OWNER))) as {
				isError?: boolean; content: Array<{ text: string }>;
			};
			assert.ok(!res.isError, `本仓 owner 推本仓 tab 必须成功，实得：${res.content[0]?.text}`);
			assert.match(res.content[0]!.text, /✅ supervise-push #1\/3/, "本组 maxPushes=3");
			assert.match(res.content[0]!.text, /【监管推动 #1\/预算3】/, "模板与 pushIndex 必须一致（真 steer 已落盘）");
		} finally {
			delete process.env.PI_TAB_RUN_ID;
		}
	});

	await checkAsync("W7(a) owner 推**他仓** tab ⇒ isError cross-repo，且真写一行 audit", async () => {
		process.env.PI_TAB_RUN_ID = SELF_RUN;
		const before = auditLines.length;
		try {
			const res = (await tool.execute("", { runId: TARGET_OTHER_REPO }, undefined, undefined, ctxFor(CITY, SID_OWNER))) as {
				isError?: boolean; content: Array<{ text: string }>;
			};
			assert.equal(res.isError, true, "cross-repo 必须拒");
			assert.match(res.content[0]!.text, /why=cross-repo/, `必须给机器可读 reason：${res.content[0]!.text}`);
			const added = auditLines.slice(before);
			assert.equal(added.length, 1, `必须真写 1 行 audit，实得 ${JSON.stringify(added)}`);
			assert.match(added[0]!, /supervision-push reject-gate/);
			assert.match(added[0]!, /reason=cross-repo/);
			assert.match(added[0]!, new RegExp(`runId=${TARGET_OTHER_REPO}`));
		} finally {
			delete process.env.PI_TAB_RUN_ID;
		}
	});

	// 2026-10-19 返工（L4 §8 实测漏洞）**真实入口**回归：目标 dispatch.cwd = `<本仓>/../repo-other`。
	// 旧实现下这一条会返回 ok:true via:owner（真的跨仓推动）；现在是 cross-repo。
	// 变异自检：去掉 `normRepoPath` 里的 canonicalize ⇒ 本用例实红（报告 §返工 给原文）。
	await checkAsync("W7(c) owner 推 dispatch.cwd 含 `..` 的 tab（`<本仓>/../repo-other`）⇒ isError cross-repo", async () => {
		process.env.PI_TAB_RUN_ID = SELF_RUN;
		const before = auditLines.length;
		try {
			const res = (await tool.execute("", { runId: TARGET_DOTDOT }, undefined, undefined, ctxFor(CITY, SID_OWNER))) as {
				isError?: boolean; content: Array<{ text: string }>;
			};
			assert.equal(res.isError, true, "`..` 径越不得放行，实得：" + (res.content[0]?.text ?? ""));
			assert.match(res.content[0]!.text, /why=cross-repo/, `必须 reason=cross-repo：${res.content[0]!.text}`);
			const added = auditLines.slice(before);
			assert.equal(added.length, 1, `必须真写 1 行 audit，实得 ${JSON.stringify(added)}`);
			assert.match(added[0]!, /reason=cross-repo/);
		} finally {
			delete process.env.PI_TAB_RUN_ID;
		}
	});

	await checkAsync("W7(b) owner 推**自身** runId ⇒ isError self-push，且真写一行 audit", async () => {
		process.env.PI_TAB_RUN_ID = SELF_RUN;
		const before = auditLines.length;
		try {
			const res = (await tool.execute("", { runId: SELF_RUN }, undefined, undefined, ctxFor(CITY, SID_OWNER))) as {
				isError?: boolean; content: Array<{ text: string }>;
			};
			assert.equal(res.isError, true, "self-push 必须拒");
			assert.match(res.content[0]!.text, /why=self-push/);
			const added = auditLines.slice(before);
			assert.equal(added.length, 1, `必须真写 1 行 audit，实得 ${JSON.stringify(added)}`);
			assert.match(added[0]!, /reason=self-push/);
		} finally {
			delete process.env.PI_TAB_RUN_ID;
		}
	});

	await checkAsync("E3-最近一级(b) 普通 tab（非 owner）经真实 execute 推本仓 tab ⇒ tab-session 拒", async () => {
		process.env.PI_TAB_RUN_ID = "tab_plain_workflow";
		try {
			const res = (await tool.execute("", { runId: TARGET_SAME_REPO }, undefined, undefined, ctxFor(CITY, "sid-unrelated-tab"))) as {
				isError?: boolean; content: Array<{ text: string }>;
			};
			assert.equal(res.isError, true, "非 owner tab 必须拒（最小权限不变）");
			assert.match(res.content[0]!.text, /why=tab-session/);
		} finally {
			delete process.env.PI_TAB_RUN_ID;
		}
	});

	await checkAsync("R3-接线 主会话（无 tab 身份）经真实 execute 推同一 tab ⇒ 仍成功（旧路径不变）", async () => {
		resetEpoch(TARGET_SAME_REPO);
		const res = (await tool.execute("", { runId: TARGET_SAME_REPO }, undefined, undefined, ctxFor(CITY, "sid-main-session"))) as {
			isError?: boolean; content: Array<{ text: string }>;
		};
		assert.ok(!res.isError, `主会话路径不得被门影响：${res.content[0]?.text}`);
	});

	// gates only run when tab — 证明「非 tab 时连 sid 都不需要」
	await checkAsync("R3-接线 主会话 + **无 ctx** ⇒ 仍按旧行为走（不因 unknown session 被拒）", async () => {
		resetEpoch(TARGET_SAME_REPO);
		const res = (await tool.execute("", { runId: TARGET_SAME_REPO })) as {
			isError?: boolean; content: Array<{ text: string }>;
		};
		assert.ok(!res.isError, `ctx 缺失的主会话不得被 unknown-session 误伤：${res.content[0]?.text}`);
	});

	isoW.dispose();
}

// ════════════════════ S1–S3：§5.1 scope 路不渲染不可执行的推动指令（2026-10-19 返工）
// 背景（L4 §5.1）：两条 wake 路的执行者都是一次性 tab，**不是**本仓 owner ⇒ 推不动。
// scope 路（`buildScopeWakePrompt` / `evaluateScopeWake`）执行者是 `l2-*` ⇒ 不得渲染
// 「用 supervise-push(...) 推动」的命令式指令（否则 = 教执行者去做一件必被拒的事）。
// workstream 路（`buildWakePrompt`）本任务**有意不动**（逐字节不变的冻结基线）。
console.log("S1–S3 §5.1：scope 路 fail-closed（缺省不渲染推动指令；停滞信息保留）");
{
	const l = (subject: string): WakeLetter => ({
		messageId: "msg_s1",
		subject,
		summary: "stagnation",
		sentAt: new Date(0).toISOString(),
		requiresAck: false,
	});
	const item: WakeSupervisionItem = {
		runId: "tab_stalled_1",
		taskId: "T-S",
		repoPath: "G:/code/GreenCAD",
		idleMs: 17 * 60_000,
		stopReason: "error",
		summary: "连接错误",
		pushesUsed: 1,
		maxPushes: 2,
	};
	const SCOPE = "GreenCAD";
	const REPO = "G:/code/GreenCAD";
	const INSTRUCTION = '  用 supervise-push({runId:"tab_stalled_1"}) 推动（预算耗尽则升级用户，勿 abort）。';

	check("S1 scope 路**缺省（不传第五参）** ⇒ 无推动指令且停滞信息完整（fail-closed）", () => {
		const p = buildScopeWakePrompt(SCOPE, [l("x")], REPO, [item]);
		assert.ok(!p.includes("supervise-push"), `缺省必须不渲染推动指令：\n${p}`);
		assert.ok(!p.includes(INSTRUCTION), "不得残留命令式那行（含前导空格）");
		assert.ok(p.includes("停滞监管"), "监管块标题必须保留");
		assert.ok(
			/已停 17min stop=error push=1\/2 摘要：连接错误/.test(p),
			`停滞信息（已停/stop=/push=/摘要）必须保留：\n${p}`,
		);
	});
	check("S2 显式 false ⇒ 与缺省逐字节相同；显式 true ⇒ **只**多那一行（严格可逆）", () => {
		const pDefault = buildScopeWakePrompt(SCOPE, [l("x")], REPO, [item]);
		const pFalse = buildScopeWakePrompt(SCOPE, [l("x")], REPO, [item], false);
		const pTrue = buildScopeWakePrompt(SCOPE, [l("x")], REPO, [item], true);
		assert.equal(pFalse, pDefault, "显式 false 必须等于缺省（缺省即 fail-closed）");
		assert.ok(pTrue.includes(INSTRUCTION), `true 必须渲染推动指令（保留给未来重路由）：\n${pTrue}`);
		// 严格可逆：true 的输出去掉那一行 == false 的输出（证明没有其它连带漂移）
		const stripped = pTrue.split("\n").filter((line) => line !== INSTRUCTION).join("\n");
		assert.equal(stripped, pFalse, "true 与 false 必须**只差推动指令那一行**");
	});
	check("S3 workstream 路（buildWakePrompt）本任务**不动**：仍渲染推动指令，且与 buildSupervisionBlock(true) 同源", () => {
		const p = buildWakePrompt({ id: "ws_s", mission: "m", status: "active" } as never, [l("x")], [item]);
		assert.ok(p.includes(INSTRUCTION), `workstream 路必须保持原样（逐字节不变）：\n${p}`);
		assert.equal(
			buildSupervisionBlock([item], { executorIsOwner: true }).join("\n"),
			buildSupervisionBlock([item]).join("\n") + "\n" + INSTRUCTION,
			"true 与缺省（fail-closed）只差推动指令那一行",
		);
	});
	check("S4 传 undefined/[] 监管 ⇒ 输出与三参/四参调用逐字节相同（无监管不带空行）", () => {
		const base = buildScopeWakePrompt(SCOPE, [l("x")], REPO);
		assert.equal(buildScopeWakePrompt(SCOPE, [l("x")], REPO, undefined, false), base);
		assert.equal(buildScopeWakePrompt(SCOPE, [l("x")], REPO, [], true), base, "空监管 + true 也不得插任何东西");
	});
}

// ════════════════════ W5/W6：spawnOneShotTab 真接线（假 spawn，真副作用）═══
console.log("W5/W6 spawnOneShotTab：派发后监管账本真出现 open/<runId>.json（status=active）");
{
	const iso5 = mkIsolated("w5");
	try {
		let spawned = 0;
		const r = spawnOneShotTab(
			{
				sessionId: "sid-scope-owner",
				taskId: "l2-my-repo",
				title: "l2 my-repo (1 inputs)",
				prompt: "do the thing",
				cwd: iso5.root,
				linkDetail: "l2=my-repo",
			},
			{
				wtPath: "C:/fake/wt.exe",
				piCli: iso5.root + "/fake-pi.js",
				runsDir: iso5.runsDir,
				linksPath: join(iso5.root, "links.jsonl"),
				stateDir: iso5.stateDir,
				newRunId: () => "tab_oneshot_fixed",
				now: () => new Date("2026-10-19T01:00:00.000Z"),
				spawn: () => {
					spawned++;
					return { title: "l2", prompt: "p", model: undefined };
				},
			},
		);

		check("W5-prep 派发生效（runId 返回、spawn 真被调 1 次、无 error）", () => {
			assert.equal(r.error, undefined, `不得有 error：${r.error}`);
			assert.equal(r.runId, "tab_oneshot_fixed");
			assert.equal(spawned, 1, "spawn 必须真被调用（否则后续断言全无意义）");
		});

		check("W6 派发后监管账本 open/<runId>.json 真实存在且 status=active（withDispatch 补齐 taskId）", () => {
			const openPath = join(iso5.stateDir, "supervision", "open", "tab_oneshot_fixed.json");
			assert.ok(existsSync(openPath), `监管账本必须落盘：${openPath}`);
			const entry = readSupervisionLedger("tab_oneshot_fixed", { stateDir: iso5.stateDir });
			assert.ok(entry, "账本必须可读");
			assert.equal(entry!.status, "active");
			assert.equal(entry!.runId, "tab_oneshot_fixed");
			assert.equal(entry!.taskId, "l2-my-repo", "fromDispatch 必须从 dispatch 补 taskId");
			assert.equal(entry!.repoPath, iso5.root, "fromDispatch 必须从 dispatch 补 repoPath");
		});

		check("W6(b) 派发账本也在（dispatch → 账本登记的顺序真实）", () => {
			const d = readTabDispatch(iso5.runsDir, "tab_oneshot_fixed");
			assert.ok(d, "dispatch 必须存在");
			assert.equal(d!.dispatchStatus, "dispatched");
			assert.equal(d!.taskId, "l2-my-repo");
		});

		check("W5-smoke 关键断言：登记发生后，supervisePush 不再被 no-mandate 拦（七门第 1 条已过）", () => {
			// 走真实读路径：账本在 open/ 且 status=active ⇒ evaluatePushGuards 的 no-mandate 不命中。
			// 这里只断言「载体存在且 active」，不重复七门矩阵（那是 _test_runtime_supervision_push 的职责）。
			const entry = readSupervisionLedger("tab_oneshot_fixed", { stateDir: iso5.stateDir });
			assert.equal(entry!.optOut, undefined, "自动登记不得带 optOut（否则仍按未登记处理）");
			assert.notEqual(entry!.status, "paused");
		});

		// 真实入口闭环（任务书 W5 要求的形状）：本仓 owner 经**真实 execute** 推刚派发的 l2 tab。
		// 账本登记缺失时，这里会以 reason=no-mandate 实红（那就是「l2 tab 推不动」的真症状）。
		await (async () => {
			const SELF5 = "tab_lms_for_l2";
			const SID5 = "01a1518c-ecec-74ee-be07-257fa0767371";
			seedLocalOwner(iso5.root, SID5, 1);
			const fake5 = (() => {
				const tools: Array<{ name: string; execute: (...a: unknown[]) => Promise<unknown> }> = [];
				return {
					registerTool(t: { name: string; execute: (...a: unknown[]) => Promise<unknown> }) { tools.push(t); },
					registerCommand() {},
					on() {},
					findTool(n: string) { return tools.find((t) => t.name === n); },
				};
			})();
			registerSupervisionTools(fake5 as never, {
				stateDir: iso5.stateDir, runsDir: iso5.runsDir, steerDir: iso5.steerDir, now: () => new Date(),
			});
			const t5 = fake5.findTool("supervise-push")!;
			await checkAsync("W5(d) 本仓 owner 经真实 execute 推**刚派发的 l2 tab** ⇒ 不被 no-mandate 拦（登记接线真生效）", async () => {
				process.env.PI_TAB_RUN_ID = SELF5;
				try {
					const res = (await t5.execute("", { runId: "tab_oneshot_fixed" }, undefined, undefined, {
						cwd: iso5.root, sessionManager: { sessionId: SID5 },
					})) as { isError?: boolean; content: Array<{ text: string }> };
					const out = res.content[0]?.text ?? "";
					assert.ok(!out.includes("reason=no-mandate"), `不得被 no-mandate 拦（登记未生效）：${out}`);
					assert.ok(!out.includes("why=tab-session"), `owner 身份必须生效：${out}`);
					assert.match(out, /✅ supervise-push/, `应推进成功（派发→登记→推动全链）：${out}`);
				} finally {
					delete process.env.PI_TAB_RUN_ID;
				}
			});
		})();

		// 反向：spawn 失败 ⇒ **不**登记（账本语义是「真派出去的」）
		const r2 = spawnOneShotTab(
			{ sessionId: "sid-scope-owner", taskId: "l2-bad", title: "l2 bad", prompt: "p", cwd: iso5.root, linkDetail: "l2=bad" },
			{
				wtPath: "C:/fake/wt.exe",
				piCli: iso5.root + "/fake-pi.js",
				runsDir: iso5.runsDir,
				linksPath: join(iso5.root, "links.jsonl"),
				stateDir: iso5.stateDir,
				newRunId: () => "tab_oneshot_failed",
				spawn: () => ({ title: "l2 bad", prompt: "p", error: "preflight: cwd not found" }),
			},
		);
		check("W5(b) spawn 失败 ⇒ 回写 launch_failed 且**不**建监管账本（失败不登记）", () => {
			assert.ok(r2.error, "必须回 error");
			const d = readTabDispatch(iso5.runsDir, "tab_oneshot_failed");
			assert.equal(d?.dispatchStatus, "launch_failed");
			assert.equal(
				existsSync(join(iso5.stateDir, "supervision", "open", "tab_oneshot_failed.json")),
				false,
				"spawn 失败不得登记监管账本",
			);
		});

		// 反向：无 wt.exe ⇒ 生成 runId 之前返回（零账本）
		check("W5(c) 无 wt.exe ⇒ 在生成 runId 之前返回 error，零账本零 dispatch", () => {
			const before = readTabDispatch(iso5.runsDir, "tab_never");
			assert.equal(before, null);
			const r3 = spawnOneShotTab(
				{ sessionId: "s", taskId: "t", title: "t", prompt: "p", cwd: iso5.root, linkDetail: "l" },
				{ wtPath: null, piCli: "x", runsDir: iso5.runsDir, spawn: () => { throw new Error("must not spawn"); } },
			);
			assert.equal(r3.runId, "");
			assert.match(r3.error ?? "", /no wt\.exe/);
		});
	} finally {
		iso5.dispose();
	}
}

// ════════════════════ W1/W2：接线锚点（源码断言，补变异测试之外的静态校验）═══
// 说明：真正的变异验证见报告 §变异验证（每条变异 = 改真实接线 + 跑本文件 + 记录实红用例）。
// 这里只把「门② 必须走 supervisePushGate」「targetRepoPath 约束必须存在」钉成静态断言，
// 防止后续重构把接线悄悄换回去。
console.log("W1/W2 接线锚点（源码静态断言）");
{
	const runtimeSrc = readFileSync(join(REPO_ROOT, "extensions", "supervision-runtime.ts"), "utf8");
	const gateSrc = readFileSync(join(REPO_ROOT, "extensions", "supervise-gate.ts"), "utf8");
	const indexSrc = readFileSync(join(REPO_ROOT, "extensions", "index.ts"), "utf8");
	const oneShotSrc = readFileSync(join(REPO_ROOT, "extensions", "one-shot-tab.ts"), "utf8");

	check("W1-锚点 execute 里调 supervisePushGate，且旧门②（无条件 getTabRunId 拒绝）已消失", () => {
		assert.ok(runtimeSrc.includes("supervisePushGate({"), "execute 必须调 supervisePushGate");
		assert.ok(
			!/if\s*\(\s*getTabRunId\(\)\s*\)\s*return\s*text\(/.test(runtimeSrc),
			"旧门② `if (getTabRunId()) return text(...)` 必须已删除（否则等于没改）",
		);
		// 身份门必须在 execute 内、runId 校验之前判定（否则空 runId 会先被拒成 runId-required）
		const execAt = runtimeSrc.indexOf("async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx)");
		const gateAt = runtimeSrc.indexOf("supervisePushGate({");
		const runIdGuardAt = runtimeSrc.indexOf("runId required（目标标签页 runId）");
		assert.ok(execAt > 0 && gateAt > execAt, "门必须在 execute 内");
		assert.ok(gateAt < runIdGuardAt, "门必须在 runId required 检查之前");
	});

	check("W1-锚点 R1：注入的是 local 地址（readLocalOwnerAttachment），**不是** masterAddress()", () => {
		assert.ok(runtimeSrc.includes("readLocalOwnerAttachment(ctxCwd)"), "必须用 cwd 派生的 local 地址");
		// 注释里提到 masterAddress() 是允许的（“禁止”的说明）；出现**调用**才是 R1 致命错误。
		const execBlock = runtimeSrc.slice(runtimeSrc.indexOf("async execute("));
		assert.ok(
			!/readAttachment\s*\(\s*masterAddress\s*\(\)/.test(execBlock),
			"execute 内禁止 readAttachment(masterAddress())（全局注入 = R1 致命错误）",
		);
		assert.ok(gateSrc.includes("localAgentFromCwd(cwd)"), "readLocalOwnerAttachment 必须经 localAgentFromCwd");
	});

	check("W2-锚点 目标约束真存在（targetRepoPath 注入 + repoPathMatches 判定）", () => {
		assert.ok(runtimeSrc.includes("targetRepoPath: () => {"), "execute 必须注入目标 repoPath 读取器");
		assert.ok(runtimeSrc.includes("readTabDispatch(runsDir, runId)?.cwd"), "目标 repoPath 必须来自 dispatch.cwd");
		assert.ok(runtimeSrc.includes("PI_TAB_RUNS_DIR || defaultTabRunsDir()"), "runsDir 口径必须与 supervisePush 一致");
		assert.ok(gateSrc.includes("repoPathMatches(targetRepo, ownerRoot)"), "目标约束必须复用 repoPathMatches");
		assert.ok(gateSrc.includes("!targetRepo"), "空 repoPath 必须 fail-closed");
	});

	check("W5-锚点 index.ts 走 one-shot-tab.ts，且该模块真调 autoRegisterDispatchedTabs", () => {
		assert.ok(indexSrc.includes('from "./one-shot-tab.ts"'), "index.ts 必须引抽出的 spawnOneShotTab");
		assert.ok(indexSrc.includes("spawnOneShotTabCore(args,"), "index.ts 的闭包必须转发到 core");
		assert.ok(oneShotSrc.includes("autoRegisterDispatchedTabs([{ runId, title: args.title }]"), "core 必须登记监管账本");
	});

	check("分层锚点 两个新文件都在 extensions/ 根（不进 runtime/，否则违反 wake.ts:15 层向禁令）", () => {
		assert.ok(existsSync(join(REPO_ROOT, "extensions", "supervise-gate.ts")));
		assert.ok(existsSync(join(REPO_ROOT, "extensions", "one-shot-tab.ts")));
		assert.equal(existsSync(join(REPO_ROOT, "extensions", "runtime", "supervise-gate.ts")), false, "不得放 runtime/");
	});
}

// ════════════════════ R6：跨进程（真子进程）身份通道 ═════════════════
// 任务书 §4.2.1 要求写明「外部进程里如何伪造 tab 身份」。本组真起一个 node 子进程，
// 用 `PI_TAB_RUN_ID` env（getTabRunId 的兜底通道）造出**真 tab 身份**，用磁盘上**真写的**
// local owner 附件当 sessionId，调**真工具入口**推本仓 tab ⇒ 必须成功。
// 这一组与 E2 的差别：E2 要真的 `lms-*` 常驻 local master 进程（本任务未做，见报告 NOT-VERIFIED）；
// 这里证明的是「身份通道本身在**跨进程**环境下成立」（不是本进程 env 污染的结果）。
console.log("R6 跨进程身份通道（真 node 子进程 + env tab 身份 + 磁盘附件）");
{
	const iso6 = mkIsolated("r6");
	const CITY6 = join(iso6.root, "repo-xproc");
	const SID6 = "01a1518d-0b2d-73af-cross-proc-owner";
	const SELF6 = "tab_xproc_lms";
	const TARGET6 = "tab_xproc_target";
	mkdirSync(CITY6, { recursive: true });
	writeTabDispatch(iso6.runsDir, {
		id: TARGET6, version: 1, taskId: "T-XPROC", mode: "workflow", title: TARGET6,
		cwd: join(CITY6, "sub"), dispatchedAt: iso(30 * 60_000), dispatchStatus: "dispatched",
	});
	writeTabState(iso6.runsDir, TARGET6, {
		id: TARGET6, phase: "waiting", turn: "idle", terminal: false,
		pid: process.pid, lastActivityAt: iso(16 * 60_000),
		lastAssistantText: "xproc", lastStopReason: "stop",
	});
	setSupervisionStatus({ runId: TARGET6, status: "active", setBy: "master:test" }, {
		stateDir: iso6.stateDir, tabRunsDir: iso6.runsDir,
	});
	// 让子进程指向**同一个** runtime（附件 + 账本同一份），但自己只是一个新 node 进程
	process.env.PI_RUNTIME_DIR = iso6.root;
	seedLocalOwner(CITY6, SID6);
	// 子进程脚本：动态 import 本仓真实模块，走真工具入口
	const childPath = join(iso6.root, "xproc.ts");
	const gatePath = join(REPO_ROOT, "extensions", "supervision-runtime.ts").replace(/\\/g, "/");
	writeFileSync(
		childPath,
		[
			`import { registerSupervisionTools } from "file:///${gatePath}";`,
			`const tools: any[] = [];`,
			`const pi = { registerTool(t: any) { tools.push(t); }, registerCommand() {}, on() {} };`,
			`registerSupervisionTools(pi as never, {`,
			`  stateDir: ${JSON.stringify(iso6.stateDir)},`,
			`  runsDir: ${JSON.stringify(iso6.runsDir)},`,
			`  steerDir: ${JSON.stringify(iso6.steerDir)},`,
			`  now: () => new Date(),`,
			`});`,
			`const tool = tools.find((t) => t.name === "supervise-push");`,
			`const res: any = await tool.execute("", { runId: ${JSON.stringify(TARGET6)} }, undefined, undefined,`,
			`  { cwd: ${JSON.stringify(CITY6)}, sessionManager: { sessionId: ${JSON.stringify(SID6)} } });`,
			`console.log("CHILD_RESULT " + JSON.stringify({ isError: !!res.isError, text: res.content[0]?.text ?? "" }));`,
		].join("\n"),
		"utf8",
	);
	writeFileSync(join(iso6.root, "package.json"), JSON.stringify({ type: "module" }), "utf8");
	const out = execFileSync(process.execPath, ["--experimental-strip-types", childPath], {
		encoding: "utf8",
		timeout: 120_000,
		env: { ...process.env, PI_TAB_RUN_ID: SELF6, PI_RUNTIME_DIR: iso6.root },
	});
	const line = out.split("\n").find((l) => l.startsWith("CHILD_RESULT ")) ?? "";
	const parsed = JSON.parse(line.slice("CHILD_RESULT ".length) || "{}") as { isError?: boolean; text?: string };
	check("R6 真子进程（PI_TAB_RUN_ID=tab + 磁盘 local owner 附件）经真工具入口推本仓 tab ⇒ 成功", () => {
		assert.ok(line, `子进程必须给出结果行，实际输出：\n${out}`);
		assert.equal(parsed.isError, false, `子进程内必须放行，实得：${parsed.text}`);
		assert.match(parsed.text ?? "", /✅ supervise-push/, `应真推进：${parsed.text}`);
		assert.ok(!(parsed.text ?? "").includes("why=tab-session"), "子进程内 owner 判定必须成立（R1 local 地址）");
	});
	process.env.PI_RUNTIME_DIR = ENV_TMP;
	iso6.dispose();
}

// ── 清理 + 汇总 ─────────────────────────────────────────────────────
rmSync(ENV_TMP, { recursive: true, force: true });
if (failed > 0) {
	console.error(`_test_supervise_gate: FAILED (${failed} failed / ${passed} passed)`);
	process.exit(1);
}
console.log(`_test_supervise_gate: all ${passed} checks passed`);
