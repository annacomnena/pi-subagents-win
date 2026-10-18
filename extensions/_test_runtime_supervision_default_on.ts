/**
 * _test_runtime_supervision_default_on.ts — 监管默认值翻转（2026-10-18 用户指令）验收
 *
 * 用户指令：「只要是我派出去的 tab，默认就进监管账本；『不监管』应该是我显式说『这个别管』。」
 * 任务书：`plans/20261018_supervision_default_on_task_brief.md`
 * 实现报告：`plans/20261018_supervision_default_on_impl.md`
 *
 * 覆盖 8 项（编号与报告一致）：
 *   1. autoRegisterDispatchedTabs：成功派发 ⇒ open/<runId>.json 存在、status=active、
 *      setBy=master:test、taskId 从 tab-runs/<runId>.json dispatch 补齐
 *   2. item.error 的条目**不**建账本（registered 不计数）
 *   3. 账本写失败（注入抛异常的 setStatus）不影响返回值：不抛、{registered:0,failed:1}、audit 收到一行
 *   4. optOut ⇒ 派生 NOT_MONITORED（走真实读路径 readSupervisionInputs → FrontierSupervision → 派生）
 *   5. stop=error ⇒ BLOCKED_USER（phase=waiting **与** phase=unconfirmed 真实形状各一条）
 *   6. working+toolUse+idle50min+账本 active ⇒ ACTIVE（防回归锁）
 *   7. 接线锚点（AGENTS R-4）：index.ts 里 launch-tabs execute 之后真有 autoRegisterDispatchedTabs 调用，
 *      且全文出现次数 ≥ 2（launch-tabs + dispatchTab 闭包）—— 防「测试直调函数 ≠ 真接线」
 *   8. `/supervise off`（关账）与 `/supervise optout`（静默留档）两个子命令都生效
 *
 * 运行：npx tsx extensions/_test_runtime_supervision_default_on.ts
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 测试隔离：defaultRuntimeDir() 全部走 temp（_test_runtime_autonomy 同款模式）
const ENV_TMP = mkdtempSync(join(tmpdir(), "runtime-sup-default-on-"));
process.env.PI_RUNTIME_DIR = ENV_TMP;

import {
	autoRegisterDispatchedTabs,
	handleSuperviseCommand,
	listSupervisedRunIds,
	readSupervisionLedger,
	setSupervisionOptOut,
	type SuperviseCommandCtx,
} from "./runtime/supervision.ts";
import { readSupervisionInputs } from "./runtime/autonomy/collect.ts";
import { buildFrontier, deriveTabSupervisionState, type FrontierSourceTab, type FrontierSupervision } from "./runtime/autonomy/frontier.ts";
import { writeTabDispatch, type TabDispatchRecord } from "./tab-runs.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

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

/** 每项测试独立 stateDir/runsDir（互不污染，失败可单独复跑）。 */
function mkIsolated(name: string): { stateDir: string; runsDir: string; dispose: () => void } {
	const root = mkdtempSync(join(tmpdir(), `runtime-sup-${name}-`));
	return {
		stateDir: join(root, "state"),
		runsDir: join(root, "tab-runs"),
		dispose: () => rmSync(root, { recursive: true, force: true }),
	};
}

function mkDispatchRecord(id: string, taskId: string, cwd: string): TabDispatchRecord {
	return { id, version: 1, taskId, mode: "workflow", cwd, dispatchedAt: new Date().toISOString(), dispatchStatus: "dispatched" };
}

/** 与 _test_runtime_autonomy 的 mkTab 同形状（真实运行时字段口径）。 */
function mkTab(over: Partial<FrontierSourceTab> = {}): FrontierSourceTab {
	return {
		runId: "tab_test_1",
		repoPath: "g:/code/x",
		phase: "waiting",
		stop: "stop",
		idleMs: 16 * 60_000,
		needsHuman: false,
		gate: "ok",
		staleOver: false,
		overdue: 0,
		resultMissing: true,
		pidAlive: true,
		...over,
	};
}

// ════════════════════ 1. 自动登记（成功派发）════════════════════════
console.log("1. autoRegisterDispatchedTabs 成功派发 ⇒ 账本 active + dispatch 补齐 taskId");
{
	const iso = mkIsolated("register");
	try {
		writeTabDispatch(iso.runsDir, mkDispatchRecord("tab_r1", "T-1018", "G:/code/x"));
		const sup = autoRegisterDispatchedTabs([{ runId: "tab_r1", title: "t" }], {
			setBy: "master:test",
			stateDir: iso.stateDir,
			tabRunsDir: iso.runsDir,
		});

		check("1(a) 返回 registered=1 / failed=0", () => {
			assert.deepEqual(sup, { registered: 1, failed: 0 });
		});
		check("1(b) open/<runId>.json 落盘且 status=active / setBy=master:test", () => {
			assert.ok(existsSync(join(iso.stateDir, "supervision", "open", "tab_r1.json")), "账本文件必须存在");
			const rec = readSupervisionLedger("tab_r1", { stateDir: iso.stateDir });
			assert.ok(rec, "账本必须可读");
			assert.equal(rec!.status, "active");
			assert.equal(rec!.setBy, "master:test");
			assert.equal(rec!.closedAt, undefined, "新登记不得是终态");
			assert.equal(rec!.optOut, undefined, "自动登记不得带 optOut");
		});
		check("1(c) taskId 从 tab-runs/<runId>.json dispatch 补齐", () => {
			assert.equal(readSupervisionLedger("tab_r1", { stateDir: iso.stateDir })!.taskId, "T-1018");
		});
	} finally {
		iso.dispose();
	}
}

// ════════════════════ 2. 派发失败不建账本 ═══════════════════════════
console.log("2. item.error 的条目 ⇒ 不建账本（静默跳过，不计数）");
{
	const iso = mkIsolated("skip-error");
	try {
		const sup = autoRegisterDispatchedTabs(
			[
				{ runId: "tab_bad", error: "spawn failed", title: "b" },
				{ runId: "tab_ok", title: "o" },
				{ error: "no runId at all", title: "n" },
			],
			{ setBy: "master:test", stateDir: iso.stateDir, tabRunsDir: iso.runsDir },
		);
		check("2(a) error 条目零账本、registered 只数成功项", () => {
			assert.deepEqual(sup, { registered: 1, failed: 0 });
			assert.equal(existsSync(join(iso.stateDir, "supervision", "open", "tab_bad.json")), false, "error 条目不得落账本");
			assert.equal(readSupervisionLedger("tab_bad", { stateDir: iso.stateDir }), null);
			assert.ok(listSupervisedRunIds({ stateDir: iso.stateDir }).includes("tab_ok"));
		});
	} finally {
		iso.dispose();
	}
}

// ════════════════════ 3. 账本写失败不影响返回值 ═════════════════════
console.log("3. 账本写失败 ⇒ never-throw、failed 计数、audit 收到一行");
{
	const iso = mkIsolated("boom");
	try {
		const auditLines: string[] = [];
		let threw = false;
		let sup: { registered: number; failed: number } | null = null;
		try {
			sup = autoRegisterDispatchedTabs([{ runId: "tab_boom", title: "x" }], {
				setBy: "master:test",
				stateDir: iso.stateDir,
				tabRunsDir: iso.runsDir,
				setStatus: () => {
					throw new Error("boom");
				},
				audit: (line) => auditLines.push(line),
			});
		} catch {
			threw = true;
		}
		check("3(a) 注入 setStatus 抛异常时函数本身不抛", () => {
			assert.equal(threw, false, "autoRegisterDispatchedTabs 绝不得 throw");
		});
		check("3(b) 返回 {registered:0, failed:1}", () => {
			assert.deepEqual(sup, { registered: 0, failed: 1 });
		});
		check("3(c) audit 收到一行 fail 记录", () => {
			assert.equal(auditLines.length, 1, `期望 1 行，实际 ${auditLines.length}`);
			assert.match(auditLines[0]!, /supervision auto-register fail runId=tab_boom/);
			assert.match(auditLines[0]!, /boom/);
		});
		check("3(d) 反例自检：audit 注入抛异常也不得穿透 never-throw", () => {
			assert.doesNotThrow(() => autoRegisterDispatchedTabs([{ runId: "tab_audit_boom" }], {
				setBy: "master:test", stateDir: iso.stateDir, tabRunsDir: iso.runsDir,
				setStatus: () => { throw new Error("write boom"); },
				audit: () => { throw new Error("audit boom"); },
			}));
		});
	} finally {
		iso.dispose();
	}
}

// ════════════════════ 4. optOut ⇒ NOT_MONITORED ════════════════════
console.log("4. optOut ⇒ 派生 NOT_MONITORED（经真实读路径 readSupervisionInputs）");
{
	const iso = mkIsolated("optout-derived");
	try {
		writeTabDispatch(iso.runsDir, mkDispatchRecord("tab_o1", "T-OPT", "G:/code/x"));
		const w = setSupervisionOptOut("tab_o1", "user:test", { stateDir: iso.stateDir, tabRunsDir: iso.runsDir });

		check("4(a) setSupervisionOptOut 落盘成功，status 仍 active 且 optOut=true", () => {
			assert.equal(w.ok, true, `写入失败：${w.reason}`);
			const rec = readSupervisionLedger("tab_o1", { stateDir: iso.stateDir });
			assert.equal(rec!.status, "active");
			assert.equal(rec!.optOut, true);
			assert.equal(rec!.taskId, "T-OPT", "新建时仍从 dispatch 补齐 taskId");
		});
		check("4(b) readSupervisionInputs 映射出 optOut，派生返回 NOT_MONITORED", () => {
			const inputs = readSupervisionInputs({ stateDir: iso.stateDir });
			assert.ok(inputs, "账本目录存在 ⇒ 不得 undefined");
			const item = inputs!.find((i) => i.runId === "tab_o1");
			assert.ok(item, "必须能读到该账本条目");
			assert.equal(item!.optOut, true);
			// 用「本来会判 STALLED」的形状（waiting + idle 16min + active）验证 optOut 抢先短路
			assert.equal(
				deriveTabSupervisionState({ tab: mkTab({ runId: "tab_o1" }), ledger: item as FrontierSupervision, attention: 0 }),
				"NOT_MONITORED",
			);
		});
		check("4(c) 连带：buildFrontier 该项目 stagnation=false", () => {
			const { next } = buildFrontier({
				snapshot: { attentionByRepo: {}, details: [mkTab({ runId: "tab_o1" })], history: [] },
				backlog: [],
				prev: null,
				now: Date.now(),
				supervision: readSupervisionInputs({ stateDir: iso.stateDir }),
			});
			const proj = next.projects[0]!;
			assert.equal(proj.supervision.state, "NOT_MONITORED");
			assert.equal(proj.stagnation, false, "optOut 不得产生 stagnation");
		});
		check("4(d) 对照：未 optOut 的同样形状 ⇒ STALLED（证明 4(b) 不是判据失效）", () => {
			const plain: FrontierSupervision = { runId: "tab_o1", status: "active", epochPushes: 0 };
			assert.equal(deriveTabSupervisionState({ tab: mkTab({ runId: "tab_o1" }), ledger: plain, attention: 0 }), "STALLED");
		});
	} finally {
		iso.dispose();
	}
}

// ════════════════════ 5. stop=error ⇒ BLOCKED_USER ═════════════════
console.log("5. stop=error ⇒ BLOCKED_USER（非 STALLED）");
{
	const ledger: FrontierSupervision = { runId: "tab_test_1", status: "active", epochPushes: 0 };

	check("5(a) stop=error ∧ phase=waiting ⇒ BLOCKED_USER（非 STALLED）", () => {
		const st = deriveTabSupervisionState({ tab: mkTab({ stop: "error" }), ledger, attention: 0 });
		assert.equal(st, "BLOCKED_USER");
		assert.notEqual(st, "STALLED", "已报错不得归 STALLED（推它没用）");
	});
	check("5(b) stop=error ∧ phase=unconfirmed（真实形状 tab-runs.ts:358-368）⇒ BLOCKED_USER", () => {
		// 真实：stopReason==="error" ⇒ phase="unconfirmed"。判据若限定 waiting 就会漏掉今晚三次卡死的实况。
		assert.equal(
			deriveTabSupervisionState({ tab: mkTab({ phase: "unconfirmed", stop: "error" }), ledger, attention: 0 }),
			"BLOCKED_USER",
		);
	});
	check("5(c) stop=error 连带 stagnation=false", () => {
		const { next } = buildFrontier({
			snapshot: { attentionByRepo: {}, details: [mkTab({ stop: "error" })], history: [] },
			backlog: [],
			prev: null,
			now: Date.now(),
			supervision: [ledger],
		});
		assert.equal(next.projects[0]!.supervision.state, "BLOCKED_USER");
		assert.equal(next.projects[0]!.stagnation, false);
	});
	check("5(d) stop=aborted 不并入（用户主动中断，不属静默卡死）", () => {
		assert.equal(deriveTabSupervisionState({ tab: mkTab({ phase: "unconfirmed", stop: "aborted" }), ledger, attention: 0 }), "ACTIVE");
	});
}

// ════════════════════ 6. toolUse 豁免（防回归锁）════════════════════
console.log("6. working+toolUse+idle50min+账本 active ⇒ ACTIVE");
{
	const ledger: FrontierSupervision = { runId: "tab_test_1", status: "active", epochPushes: 0 };
	check("6(a) toolUse 豁免仍成立（防回归）", () => {
		assert.equal(
			deriveTabSupervisionState({ tab: mkTab({ phase: "working", stop: "toolUse", idleMs: 50 * 60_000 }), ledger, attention: 0 }),
			"ACTIVE",
		);
	});
}

// ════════════════════ 7. 接线锚点（AGENTS R-4）═════════════════════
console.log("7. 接线锚点：index.ts 的 launch-tabs/dispatchTab 真调用 autoRegisterDispatchedTabs");
{
	const indexSrc = readFileSync(join(REPO_ROOT, "extensions", "index.ts"), "utf8");

	check("7(a) launch-tabs 的 execute( 之后出现 autoRegisterDispatchedTabs(", () => {
		const executeAt = indexSrc.indexOf("async execute(_toolCallId, rawParams, _signal, _onUpdate, _ctx)");
		assert.ok(executeAt > 0, "未找到 launch-tabs 的 execute(...) 签名（接线锚点失效需更新测试）");
		const after = indexSrc.slice(executeAt);
		const supAt = after.indexOf("autoRegisterDispatchedTabs(");
		assert.ok(supAt > 0, "launch-tabs execute 之后必须调用 autoRegisterDispatchedTabs");
		// 弱耦合排版：只要该调用出现在 execute 体内（后续 4000 字符内），不钉死具体行
		assert.ok(supAt < 4000, `autoRegisterDispatchedTabs 距 execute 起点过远（${supAt} 字符），疑似不在同一 handler`);
	});
	check("7(b) index.ts 中 autoRegisterDispatchedTabs( 出现 ≥ 2 次（launch-tabs + dispatchTab 闭包）", () => {
		const n = indexSrc.split("autoRegisterDispatchedTabs(").length - 1;
		assert.ok(n >= 2, `期望 ≥2 处调用点，实际 ${n}`);
	});
	check("7(c) dispatchTab 闭包内（masterDispatchLaunch 之后）也有登记调用", () => {
		const launchAt = indexSrc.indexOf("const dispatchTab: DispatchTab = (args) => {");
		assert.ok(launchAt > 0, "未找到 dispatchTab 闭包");
		const closure = indexSrc.slice(launchAt, launchAt + 2000);
		assert.ok(closure.includes("masterDispatchLaunch("), "闭包内必须调 masterDispatchLaunch");
		assert.ok(closure.includes("autoRegisterDispatchedTabs("), "闭包内必须调 autoRegisterDispatchedTabs（master-dispatch 通道）");
		assert.ok(closure.includes("!res.stale && !res.error && res.runId"), "stale/error 分支不得登记");
	});
	check("7(d) master-tools.ts 成功文本含自动登记提示", () => {
		const src = readFileSync(join(REPO_ROOT, "extensions", "master-tools.ts"), "utf8");
		assert.ok(src.includes("监管: 已自动登记"), "master-dispatch 成功文本必须告知已自动登记");
	});
}

// ════════════════════ 8. /supervise off 与 optout ══════════════════
console.log("8. /supervise off（关账）与 /supervise optout（静默留档）都生效");
{
	const iso = mkIsolated("commands");
	try {
		writeTabDispatch(iso.runsDir, mkDispatchRecord("tab_c1", "T-C1", "G:/code/x"));
		writeTabDispatch(iso.runsDir, mkDispatchRecord("tab_c2", "T-C2", "G:/code/x"));
		autoRegisterDispatchedTabs([{ runId: "tab_c1" }, { runId: "tab_c2" }], {
			setBy: "master:test",
			stateDir: iso.stateDir,
			tabRunsDir: iso.runsDir,
		});
		const lines: string[] = [];
		const ctx: SuperviseCommandCtx = { ui: { notify: (m: string) => lines.push(m) } };
		const deps = { setBy: "user:test", stateDir: iso.stateDir, tabRunsDir: iso.runsDir };

		check("8(a) /supervise off ⇒ closedAt 为 truthy（open → closed）", () => {
			handleSuperviseCommand("off tab_c1", ctx, deps);
			const rec = readSupervisionLedger("tab_c1", { stateDir: iso.stateDir });
			assert.ok(rec, "off 后条目仍可读（终态在 closed/）");
			assert.ok(rec!.closedAt, "closedAt 必须落地");
			assert.equal(rec!.closedBy, "user:test");
			assert.equal(listSupervisedRunIds({ stateDir: iso.stateDir }).includes("tab_c1"), false, "off 后离开 open 集合");
			assert.ok(lines.some((l) => l.includes("tab_c1") && l.includes("closed")), `回显缺失：${lines.join("|")}`);
		});
		check("8(b) /supervise optout ⇒ optOut=true 且仍在监管集合（留档不删）", () => {
			lines.length = 0;
			handleSuperviseCommand("optout tab_c2", ctx, deps);
			const rec = readSupervisionLedger("tab_c2", { stateDir: iso.stateDir });
			assert.equal(rec!.optOut, true);
			assert.equal(rec!.status, "active");
			assert.equal(rec!.closedAt, undefined);
			assert.equal(listSupervisedRunIds({ stateDir: iso.stateDir }).includes("tab_c2"), true, "optout 不得删条目");
			assert.ok(lines.some((l) => l.includes("静默")), `回显缺失：${lines.join("|")}`);
		});
		check("8(c) 反例自检：同 runId 重复自动登记不得清除用户 optOut", () => {
			autoRegisterDispatchedTabs([{ runId: "tab_c2" }], {
				setBy: "master:test",
				stateDir: iso.stateDir,
				tabRunsDir: iso.runsDir,
			});
			assert.equal(readSupervisionLedger("tab_c2", { stateDir: iso.stateDir })!.optOut, true);
		});
		check("8(d) /supervise on 清除 optOut（显式「要监管」覆盖静默）", () => {
			lines.length = 0;
			handleSuperviseCommand("on tab_c2", ctx, deps);
			assert.equal(readSupervisionLedger("tab_c2", { stateDir: iso.stateDir })!.optOut, undefined);
		});
		check("8(e) 用法串含 optout 子命令", () => {
			lines.length = 0;
			handleSuperviseCommand("bogus", ctx, deps);
			assert.ok(lines.some((l) => l.includes("optout")), `用法串缺 optout：${lines.join("|")}`);
		});
	} finally {
		iso.dispose();
	}
}

// ── 清理 + 汇总 ─────────────────────────────────────────────────────
rmSync(ENV_TMP, { recursive: true, force: true });
if (failed > 0) {
	console.error(`_test_runtime_supervision_default_on: FAILED (${failed} failed / ${passed} passed)`);
	process.exit(1);
}
console.log(`_test_runtime_supervision_default_on: all ${passed} checks passed`);
