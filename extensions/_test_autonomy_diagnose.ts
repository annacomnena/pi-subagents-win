/**
 * _test_autonomy_diagnose.ts — 阶段 0 诊断工具的测试（2026-11-01）
 *
 * ## 本测试要守住的最重要一条：**诊断必须零副作用**
 *
 * 诊断工具的唯一价值前提是「能反复跑而不改变状态」。如果它偷偷写了什么
 * （哪怕只加一行审计），它就不再是零风险的观察工具，而是一个新的状态源。
 *
 * 所以核心断言不是「字段对不对」，而是**跑前跑后所有文件的字节完全一致**。
 *
 * 覆盖：
 *   A. 零副作用（文件哈希前后对比，含 mtime）
 *   B. 不调用 collectAutonomyInputs（静态断言：源码里没有这个调用）
 *   C. 各层读数正确（构造种子状态逐项验证）
 *   D. 两个关键异常信号的判别力（alwaysWake / staleAnchor）
 *   E. never-throw（目录不存在 / 坏 JSON / 空文件都不抛）
 *
 * 运行：npm run test:autonomy-diagnose
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "autonomy-diagnose-env-"));
const RUNTIME = process.env.PI_RUNTIME_DIR!;
const STATE = join(RUNTIME, "state");
const AUTONOMY = join(STATE, "autonomy");

import { diagnoseAutonomy } from "./runtime/autonomy/diagnose.ts";

/** 递归采集一棵树里所有文件的 (相对路径, sha256, mtimeMs)，用于「零副作用」对比。 */
function snapshotTree(root: string): Map<string, { sha: string; mtime: number }> {
	const out = new Map<string, { sha: string; mtime: number }>();
	if (!existsSync(root)) return out;
	const walk = (dir: string, rel: string): void => {
		for (const name of readdirSync(dir)) {
			const full = join(dir, name);
			const r = rel === "" ? name : `${rel}/${name}`;
			const st = statSync(full);
			if (st.isDirectory()) {
				walk(full, r);
			} else {
				const buf = readFileSync(full);
				out.set(r, { sha: createHash("sha256").update(buf).digest("hex"), mtime: st.mtimeMs });
			}
		}
	};
	walk(root, "");
	return out;
}

function setupState(opts: {
	enabled?: boolean;
	actionsEnabled?: boolean;
	wakeGate?: Record<string, unknown> | null;
	frontier?: Record<string, unknown> | null;
	actionsLines?: string[];
	heartbeat?: boolean;
}): void {
	mkdirSync(AUTONOMY, { recursive: true });
	// config.json 在包根，不在 stateDir —— 用 readAutonomyConfig 的缺省路径。
	// 测试里不写包根配置（避免污染真仓），只验证它不崩。

	if (opts.heartbeat !== false) {
		writeFileSync(join(AUTONOMY, "heartbeat.json"), JSON.stringify({ version: 1, sessionId: "test", tickIntervalMs: 30000 }), "utf8");
	}
	if (opts.wakeGate !== null && opts.wakeGate !== undefined) {
		writeFileSync(join(AUTONOMY, "wake-gate.json"), JSON.stringify(opts.wakeGate), "utf8");
	}
	if (opts.frontier !== null && opts.frontier !== undefined) {
		writeFileSync(join(AUTONOMY, "frontier.json"), JSON.stringify(opts.frontier), "utf8");
	}
	if (opts.actionsLines) {
		mkdirSync(join(AUTONOMY, "actions"), { recursive: true });
		writeFileSync(join(AUTONOMY, "actions", "actions.jsonl"), opts.actionsLines.join("\n") + "\n", "utf8");
	}
}

function clearState(): void {
	rmSync(STATE, { recursive: true, force: true });
}

let passed = 0;
const check = (name: string, fn: () => void): void => {
	try {
		fn();
		passed += 1;
		console.log(`  ✓ ${name}`);
	} catch (e) {
		console.error(`  ✗ ${name}`);
		console.error(`    ${e instanceof Error ? e.message : String(e)}`);
		throw e;
	}
};

try {
	// ══ A. 零副作用（本测试的核心）══════════════════════════════════
	console.log("\nA. 零副作用");
	clearState();
	setupState({
		wakeGate: { lastDecisionAt: 1000, lastWakeAt: 1000, batchFirstSeenAt: 1000, lastReason: "ordinary" },
		frontier: {
			asof: 1000,
			baseline: false,
			projects: [{ project: "p1", state: "Working", supervision: { state: "ACTIVE" } }],
			triggers: [{ rule: "ws_mail_backlog", project: "p1", evidence: "pending:1", approximate: false }],
		},
		actionsLines: [JSON.stringify({ v: 1, kind: "executed", id: "a1" })],
	});

	const before = snapshotTree(STATE);
	const beforeRuntime = snapshotTree(RUNTIME);

	diagnoseAutonomy({ now: 2000 });
	diagnoseAutonomy({ now: 3000 }); // 跑两次，确认幂等
	diagnoseAutonomy({ now: 4000 });

	const after = snapshotTree(STATE);
	const afterRuntime = snapshotTree(RUNTIME);

	check("A1 状态树文件集合不变", () => {
		assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
	});
	check("A2 每个文件字节完全相同（sha256）", () => {
		for (const [k, v] of before) {
			assert.equal(after.get(k)?.sha, v.sha, `${k} 内容被改动`);
		}
	});
	check("A3 mtime 未变（连 touch 都没有）", () => {
		for (const [k, v] of before) {
			assert.equal(after.get(k)?.mtime, v.mtime, `${k} mtime 被改动`);
		}
	});
	check("A4 未新建任何文件（含 audit.jsonl / frontier.json 重写）", () => {
		assert.equal(afterRuntime.size, beforeRuntime.size, "runtime 树多了文件");
		assert.equal(existsSync(join(AUTONOMY, "audit.jsonl")), false, "**不得创建 audit.jsonl**（诊断不写审计）");
	});

	// ══ B. 静态断言：不得调用有副作用的 collect ══════════════════════
	//
	// 注意：必须**先剔掉注释**再查。 diagnose.ts 的注释里就写着「绝不调用
	// `collectAutonomyInputs()`」—— 直接正则匹配会把那句说明当成调用（本测试
	// 第一版就踩了这个，是测试本身的 bug 而不是代码的 bug）。
	console.log("\nB. 不得调用 collectAutonomyInputs");
	const stripComments = (src: string): string =>
		src
			.replace(/\/\*[\s\S]*?\*\//g, "") // 块注释
			.replace(/^\s*\/\/.*$/gm, ""); // 行注释

	check("B1 源码（剔注释后）无 collectAutonomyInputs 调用", () => {
		const src = stripComments(readFileSync(new URL("./runtime/autonomy/diagnose.ts", import.meta.url), "utf8"));
		assert.equal(
			/collectAutonomyInputs\s*\(/.test(src),
			false,
			"diagnose.ts 调用了 collectAutonomyInputs —— 它有写盘副作用，诊断绝不能调它",
		);
	});
	check("B2 源码（剔注释后）无 writeFrontierSnapshot / appendAuditLine", () => {
		const src = stripComments(readFileSync(new URL("./runtime/autonomy/diagnose.ts", import.meta.url), "utf8"));
		assert.equal(/writeFrontierSnapshot\s*\(/.test(src), false, "不得写 frontier");
		assert.equal(/appendAuditLine\s*\(/.test(src), false, "不得写审计");
	});

	// ══ C. 各层读数 ═══════════════════════════════════════════════
	console.log("\nC. 读数正确性");
	clearState();
	setupState({
		heartbeat: true,
		wakeGate: {
			lastDecisionAt: 10_000,
			lastWakeAt: 9_000, // 与 decisionAt 不同 ⇒ 不是 alwaysWake
			batchFirstSeenAt: 9_500,
			lastReason: "debounce",
		},
		frontier: {
			asof: 9_800,
			baseline: false,
			projects: [
				{ project: "g:/a", state: "Working", supervision: { state: "ACTIVE" } },
				{ project: "g:/b", state: "Working", supervision: { state: "STALLED" } },
				{ project: "g:/c", state: "Completed", supervision: { state: "DONE" } },
			],
			triggers: [
				{ rule: "ws_mail_backlog", project: "mailbox:x", evidence: "pending:2", approximate: false },
				{ rule: "blocked_to_ready", project: "g:/a", evidence: "gate", approximate: true },
				{ rule: "working_to_completed", project: "g:/c", evidence: "run:1", approximate: false },
			],
		},
		actionsLines: [
			JSON.stringify({ v: 1, kind: "executed", id: "e1" }),
			JSON.stringify({ v: 1, kind: "rejected", id: "r1", reason: "git-repo-not-found(fail-closed)" }),
			JSON.stringify({ v: 1, kind: "rejected", id: "r2", reason: "git-pre:git-unknown(fail-closed)" }),
			JSON.stringify({ v: 1, kind: "rejected", id: "r3", reason: "budget-new-per-hour" }),
			JSON.stringify({ v: 1, kind: "rejected", id: "r4", reason: "scope-owner-stale" }),
		],
	});

	const d = diagnoseAutonomy({ now: 20_000 });

	check("C1 state 直方图正确", () => {
		assert.equal(d.frontier.projectCount, 3);
		assert.equal(d.frontier.stateHistogram.Working, 2);
		assert.equal(d.frontier.stateHistogram.Completed, 1);
	});
	check("C2 supervision 直方图正确", () => {
		assert.equal(d.frontier.supervisionHistogram.ACTIVE, 1);
		assert.equal(d.frontier.supervisionHistogram.STALLED, 1);
		assert.equal(d.frontier.supervisionHistogram.DONE, 1);
	});
	check("C3 meaningful / approximate 分离正确", () => {
		assert.equal(d.frontier.triggers.length, 3);
		assert.equal(d.frontier.meaningfulCount, 2, "两条 approximate=false");
		assert.equal(d.frontier.approximateCount, 1, "一条 approximate=true");
	});
	check("C4 actions kind 分布正确", () => {
		assert.equal(d.actions.total, 5);
		assert.equal(d.actions.kindHistogram.executed, 1);
		assert.equal(d.actions.kindHistogram.rejected, 4);
	});
	check("C5 确定性失败识别正确（git-* 两条 = 2/4 = 50%）", () => {
		const det = d.actions.rejects.filter((r) => r.deterministic);
		assert.equal(det.length, 2, `确定性失败应 2 条，实际 ${JSON.stringify(d.actions.rejects)}`);
		assert.equal(det.reduce((s, r) => s + r.count, 0), 2);
		assert.equal(d.actions.deterministicRejectRatio, 0.5);
	});
	check("C6 非确定性原因不得被误标（budget-* / scope-* 是正常限流）", () => {
		const budget = d.actions.rejects.find((r) => r.reason.startsWith("budget-"));
		assert.ok(budget, "budget-new-per-hour 应在列表里");
		assert.equal(budget!.deterministic, false, "budget-* 是正常限流，不是确定性失败");
		const scope = d.actions.rejects.find((r) => r.reason.startsWith("scope-"));
		assert.equal(scope!.deterministic, false, "scope-owner-stale 会随 master 拉起而变，不算确定性");
	});
	check("C7 wakeGate 读数透传", () => {
		assert.equal(d.wakeGate.lastReason, "debounce");
		assert.equal(d.wakeGate.lastDecisionAt, new Date(10_000).toISOString());
		assert.equal(d.wakeGate.batchFirstSeenAt, new Date(9_500).toISOString());
	});

	// ══ C8-C11：阶段 2 去重账本读数（2026-11-01）═══════════════
	check("C8 账本空 ⇒ entries=0 / ages=null / working=false", () => {
		clearState();
		setupState({ heartbeat: true, wakeGate: { lastDecisionAt: 5000, lastWakeAt: 4000, batchFirstSeenAt: 4000, lastReason: "ordinary" } });
		const x = diagnoseAutonomy({ now: 6000 });
		assert.equal(x.wakeGate.dedupeEntries, 0);
		assert.equal(x.wakeGate.dedupeOldestAgeMs, null);
		assert.equal(x.wakeGate.dedupeNewestAgeMs, null);
		assert.equal(x.wakeGate.dedupeWorking, false);
	});

	check("C9 账本有 2 条 ⇒ entries=2 且 age 计算正确", () => {
		clearState();
		const now = 10_000_000;
		setupState({
			heartbeat: true,
			wakeGate: {
				lastDecisionAt: now,
				lastWakeAt: now,
				batchFirstSeenAt: now,
				lastReason: "ordinary",
				dedupe: {
					"a:b:c": new Date(now - 600_000).toISOString(), // 10 分钟前（最旧）
					"d:e:f": new Date(now - 60_000).toISOString(), // 1 分钟前（最新）
				},
			},
		});
		const x = diagnoseAutonomy({ now });
		assert.equal(x.wakeGate.dedupeEntries, 2);
		assert.equal(x.wakeGate.dedupeOldestAgeMs, 600_000);
		assert.equal(x.wakeGate.dedupeNewestAgeMs, 60_000);
	});

	check("C10 dedupeWorking：账本非空 ∧ lastReason=all-deduped ⇒ true", () => {
		clearState();
		const now = 10_000_000;
		setupState({
			heartbeat: true,
			wakeGate: { lastDecisionAt: now, lastWakeAt: now - 5000, batchFirstSeenAt: now, lastReason: "all-deduped", dedupe: { k: new Date(now - 1000).toISOString() } },
		});
		const x = diagnoseAutonomy({ now });
		assert.equal(x.wakeGate.dedupeWorking, true, "账本非空 + all-deduped ⇒ 去重在生效");
	});

	check("C11 dedupeWorking：账本非空但 lastReason=ordinary ⇒ false", () => {
		clearState();
		const now = 10_000_000;
		setupState({
			heartbeat: true,
			wakeGate: { lastDecisionAt: now, lastWakeAt: now, batchFirstSeenAt: now, lastReason: "ordinary", dedupe: { k: new Date(now - 1000).toISOString() } },
		});
		const x = diagnoseAutonomy({ now });
		assert.equal(x.wakeGate.dedupeWorking, false);
	});

	check("C12 verdict 提到账本空但 ordinary 时给警告", () => {
		clearState();
		setupState({ heartbeat: true, wakeGate: { lastDecisionAt: 5000, lastWakeAt: 5000, batchFirstSeenAt: 5000, lastReason: "ordinary" } });
		const x = diagnoseAutonomy({ now: 6000 });
		assert.ok(x.verdict.includes("去重账本为空但 lastReason=ordinary"), `verdict 应给警告，实际：${x.verdict}`);
	});

	// ══ D. 两个关键异常信号的判别力（核心）══════════════════════════
	console.log("\nD. 异常信号判别力");

	check("D1 alwaysWake：lastWakeAt===lastDecisionAt ⇒ 判 true", () => {
		clearState();
		setupState({ heartbeat: true, wakeGate: { lastDecisionAt: 5_000, lastWakeAt: 5_000, batchFirstSeenAt: 4_000, lastReason: "ordinary" } });
		const x = diagnoseAutonomy({ now: 6_000 });
		assert.equal(x.wakeGate.suspiciousAlwaysWake, true, "同一刻 ⇒ 恒 wake，必须判 true");
	});

	check("D2 alwaysWake：两者不同 ⇒ 判 false（不能误报）", () => {
		clearState();
		setupState({ heartbeat: true, wakeGate: { lastDecisionAt: 5_000, lastWakeAt: 3_000, batchFirstSeenAt: 4_000, lastReason: "debounce" } });
		const x = diagnoseAutonomy({ now: 6_000 });
		assert.equal(x.wakeGate.suspiciousAlwaysWake, false, "不同刻不得误报");
	});

	check("D3 staleAnchor：龄 > 1 天 ⇒ 判 true", () => {
		clearState();
		const now = 10 * 86_400_000;
		const anchor = now - 2 * 86_400_000; // 2 天前
		setupState({ heartbeat: true, wakeGate: { lastDecisionAt: now - 1000, lastWakeAt: now - 2000, batchFirstSeenAt: anchor, lastReason: "ordinary" } });
		const x = diagnoseAutonomy({ now });
		assert.equal(x.wakeGate.suspiciousStaleAnchor, true, "2 天龄必须判卡死");
		assert.ok((x.wakeGate.batchAnchorAgeMs ?? 0) > 86_400_000);
	});

	check("D4 staleAnchor：龄 < 1 天 ⇒ 判 false（不能误报）", () => {
		clearState();
		const now = 10 * 86_400_000;
		const anchor = now - 3_600_000; // 1 小时前
		setupState({ heartbeat: true, wakeGate: { lastDecisionAt: now - 1000, lastWakeAt: now - 2000, batchFirstSeenAt: anchor, lastReason: "ordinary" } });
		const x = diagnoseAutonomy({ now });
		assert.equal(x.wakeGate.suspiciousStaleAnchor, false);
	});

	check("D5 verdict 里两个 🔴 都会出现", () => {
		clearState();
		const now = 10 * 86_400_000;
		setupState({
			heartbeat: true,
			wakeGate: { lastDecisionAt: now, lastWakeAt: now, batchFirstSeenAt: now - 2 * 86_400_000, lastReason: "ordinary" },
			frontier: { asof: now, baseline: false, projects: [], triggers: [] },
		});
		const x = diagnoseAutonomy({ now });
		assert.ok(x.verdict.includes("门失效"), `verdict 应报门失效，实际：${x.verdict}`);
		assert.ok(x.verdict.includes("累积锚点卡死"), `verdict 应报锚点卡死，实际：${x.verdict}`);
	});

	// ══ E. never-throw ════════════════════════════════════════════
	console.log("\nE. never-throw");
	check("E1 stateDir 完全不存在也不抛", () => {
		const x = diagnoseAutonomy({ stateDir: join(RUNTIME, "no-such-dir"), now: 1000 });
		assert.ok(typeof x.verdict === "string" && x.verdict.length > 0);
	});

	check("E2 坏 JSON 也不抛（frontier / wake-gate 都坏）", () => {
		clearState();
		mkdirSync(join(AUTONOMY, "actions"), { recursive: true });
		writeFileSync(join(AUTONOMY, "frontier.json"), "{not json", "utf8");
		writeFileSync(join(AUTONOMY, "wake-gate.json"), "[[[", "utf8");
		writeFileSync(join(AUTONOMY, "actions", "actions.jsonl"), "", "utf8");
		const x = diagnoseAutonomy({ now: 1000 });
		assert.ok(typeof x.verdict === "string");
	});

	check("E3 actions.jsonl 有坏行时跳过而非中断", () => {
		clearState();
		mkdirSync(join(AUTONOMY, "actions"), { recursive: true });
		writeFileSync(
			join(AUTONOMY, "actions", "actions.jsonl"),
			[
				JSON.stringify({ v: 1, kind: "executed", id: "ok1" }),
				"{broken",
				JSON.stringify({ v: 1, kind: "rejected", id: "ok2", reason: "git-repo-not-found" }),
			].join("\n") + "\n",
			"utf8",
		);
		const x = diagnoseAutonomy({ now: 1000 });
		assert.equal(x.actions.total, 3, "总行数含坏行");
		assert.equal(x.actions.kindHistogram.executed, 1, "好行仍要被解析");
		assert.equal(x.actions.kindHistogram.rejected, 1);
	});

	console.log(`\n_test_autonomy_diagnose: ${passed} checks passed`);
} finally {
	rmSync(RUNTIME, { recursive: true, force: true });
}
