/**
 * _test_runtime_snapshot.ts — G1 测试（read-only runtime snapshot，plans/0918_G1_snapshot_plan.md §4）
 *
 * 覆盖：
 *   T1 正常聚合：attach + journal 2 事件（dispatched+completed）+ workstream/task + mailbox；
 *      七段全有值、version=1、sectionErrors=[]；**不物化 state/runs**（单数据源=journal 证明）
 *   T2 空 runtime 目录：不抛、七段全空兜底、counts 全 0
 *   T3 坏文件容忍 + 不落盘：journal 1 行坏 JSON → skippedBadLines=1 且其余正常投影；
 *      attachment.json 坏 JSON → master.attachment=null 不抛（底层 tolerant reader 吞掉，
 *      按收窄语义不进 sectionErrors）；构建前后目录树（含目录条目 + 各文件 mtime）+ 内容哈希
 *      不变（R1/R7）；且能检出新增空目录与仅 mtime 变更；rm -rf state/ 后 journal 派生段
 *      与 rm 前一致（无 staleness，L1 §5）
 *   T3b sectionErrors 收窄语义可观测：state/workstreams 被换成普通文件 → readdirSync 抛
 *      ENOTDIR（底层未吞）→ 记录进 workstreams 段，其余段正常、不炸整体
 *   T6 never-throw：无效 Date 注入（new Date("invalid")）不抛，generatedAt 为合法 ISO 串
 *   T4 占位与幂等：attention=[]（D1 无 attention 源）；timeline 已填（G3 拍板③：
 *      journal 2 事件 → 2 条事件条目 at 升序）；同种子 + 同 now 两次 deepStrictEqual
 *   T5 大 journal 性能 smoke：10,000 行（5,000 dispatched + 5,000 completed）< 2000ms
 *
 * 运行：npm run test:runtime-snapshot
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "runtime-snapshot-env-"));
const D1 = process.env.PI_RUNTIME_DIR!; // T1/T4 种子目录

import { attachMaster } from "./runtime/registry.ts";
import { deliverLetter } from "./runtime/mailbox.ts";
import { newMessageFrame } from "./runtime/protocol.ts";
import { newEnvelopeId } from "./runtime/ids.ts";
import { masterAddress } from "./runtime/address.ts";
import { createTask, createWorkstream } from "./runtime/workstreams.ts";
import { newEventEnvelope } from "./runtime/envelope.ts";
import { buildRuntimeSnapshot } from "./runtime-host/snapshot.ts";

/** 每场景独立 PI_RUNTIME_DIR（master 段无参数注入，只能走 env——见 snapshot.ts 头注）。 */
const useRuntimeDir = (dir: string): void => {
	process.env.PI_RUNTIME_DIR = dir;
};

const snap = (dir: string, now?: Date) =>
	buildRuntimeSnapshot({
		stateDir: join(dir, "state"),
		mailboxDir: join(dir, "mailbox"),
		journalPath: join(dir, "events.jsonl"),
		linksPath: join(dir, "links.jsonl"), // G3 加法：timeline 溯源隔离到测试目录（不读真实 ~/.pi/agent/links.jsonl）
		now: now ?? new Date(),
	});

/** 目录树 + 目录条目 + 各文件 mtime/内容哈希（R1/R7：构建前后必须不变；
 *  纳入目录条目与 mtime 后可检出新增/删除空目录与仅 timestamp 变更，G1 L4 review 必须修复项 2）。 */
function treeHash(dir: string): string {
	const entries: string[] = [];
	const walk = (d: string, rel: string): void => {
		let names: string[] = [];
		try {
			names = readdirSync(d);
		} catch {
			return;
		}
		for (const n of names.sort()) {
			const p = join(d, n);
			const relP = rel ? `${rel}/${n}` : n;
			let st: ReturnType<typeof lstatSync>;
			try {
				st = lstatSync(p);
			} catch {
				continue; // 竞争删除：保持 tolerant，不炸测试
			}
			if (st.isDirectory()) {
				entries.push(`${relP}/:dir:mtime=${st.mtimeMs}`);
				walk(p, relP);
			} else if (st.isFile()) {
				const h = createHash("sha256").update(readFileSync(p)).digest("hex");
				entries.push(`${relP}:file:mtime=${st.mtimeMs}:sha256=${h}`);
			}
		}
	};
	walk(dir, "");
	return createHash("sha256").update(entries.join("\n")).digest("hex");
}

const S = { session: "test" };
const D2 = mkdtempSync(join(tmpdir(), "runtime-snapshot-empty-"));
const D3 = mkdtempSync(join(tmpdir(), "runtime-snapshot-bad-"));
const D6 = mkdtempSync(join(tmpdir(), "runtime-snapshot-enotdir-"));
const D5 = mkdtempSync(join(tmpdir(), "runtime-snapshot-perf-"));

const JOURNAL1 = join(D1, "events.jsonl");
const WS1 = join(D1, "state");
const MBOX1 = join(D1, "mailbox");

try {
	// ── T1 种子（ev1/ev2 种子法复用 _test_runtime_hydrate.ts；故意不物化 state/runs）──
	useRuntimeDir(D1);
	attachMaster({ sessionId: "sess-S" });
	const ev1 = newEventEnvelope({
		type: "run.dispatched", source: masterAddress(), subject: "run://tab/tab_s1",
		at: "2026-09-17T19:00:00.000Z", dedupeKey: "run.dispatched:run://tab/tab_s1",
		payload: { tabRunId: "tab_s1", executionKind: "tab", externalTaskId: "9101", mode: "workflow", dispatchedAt: "2026-09-17T19:00:00.000Z" },
	});
	const ev2 = newEventEnvelope({
		type: "run.completed", source: masterAddress(), subject: "run://tab/tab_s1",
		at: "2026-09-17T19:05:00.000Z", dedupeKey: "run.completed:run://tab/tab_s1",
		payload: { tabRunId: "tab_s1", executionKind: "tab", status: "completed", summary: "done", reportPath: "plans/done.md", finishedAt: "2026-09-17T19:05:00.000Z" },
	});
	writeFileSync(JOURNAL1, [ev1, ev2].map((e) => `${JSON.stringify(e)}\n`).join(""), "utf8");
	const ws = createWorkstream({ stateDir: WS1, session: S.session, mission: "G1 快照" });
	createTask({ stateDir: WS1, objective: "装配验证", externalTaskId: "9101", workstreamId: ws.id, session: S.session });
	deliverLetter(
		newMessageFrame({
			id: newEnvelopeId("msg"), kind: "REPORT", from: "agent://a", to: masterAddress(),
			subject: "run://tab/tab_s1", sentAt: "2026-09-17T19:06:00.000Z", summary: "pend",
			details: { tabRunId: "tab_s1", status: "completed" },
		}),
		{ mailboxDir: MBOX1 },
	);

	// ── T1 正常聚合 ─────────────────────────────────────────────────
	const s1 = snap(D1);
	assert.equal(s1.version, 1, "version:1 冻结");
	assert.deepEqual(s1.sectionErrors, [], "正常时无段级错误");
	assert.equal(s1.master.attachment?.sessionId, "sess-S", "master.attachment");
	assert.equal(s1.master.stale, false, "心跳当前 → 非 stale");
	assert.equal(s1.master.snapshot?.sessionId, "sess-S", "resolver 快照透传");
	assert.ok(s1.master.backlog.some((r) => r.recipient === "agent___master_default" && r.pending === 1), "mailbox 积压（recipient = spool 目录名）");
	assert.equal(s1.workstreams.length, 1);
	assert.equal(s1.workstreams[0].mission, "G1 快照");
	assert.equal(s1.tasks.length, 1);
	assert.equal(s1.tasks[0].externalTaskId, "9101");
	assert.equal(s1.runs.length, 1, "journal 全量 rebuild 投影（未物化 state/runs 也有值）");
	assert.equal(s1.runs[0].subject, "run://tab/tab_s1");
	assert.equal(s1.runs[0].status, "completed");
	assert.equal(s1.runs[0].summary, "done");
	assert.equal(s1.runs[0].reportPath, "plans/done.md");
	assert.equal(s1.runtime.host, null, "G1 无 host 进程 → null 占位");
	assert.deepEqual(s1.runtime.counts, { workstreams: 1, tasks: 1, runs: 1, pendingMailbox: 1 });
	assert.deepEqual(s1.runtime.journal, {
		totalEvents: 2, skippedBadLines: 0, applied: 2, skipped: 0,
		recent: s1.runtime.journal.recent, // 形状见下
	});
	assert.equal(s1.runtime.journal.recent.length, 2, "recent 尾 20 条（此处 2 条全取）");

	// ── T2 空 runtime 目录 ──────────────────────────────────────────
	useRuntimeDir(D2);
	const s2 = snap(D2);
	assert.equal(s2.version, 1);
	assert.equal(s2.master.attachment, null, "缺失 → null（tolerant，非 error）");
	assert.equal(s2.master.stale, false);
	assert.deepEqual(s2.workstreams, []);
	assert.deepEqual(s2.tasks, []);
	assert.deepEqual(s2.runs, []);
	assert.deepEqual(s2.attention, []);
	assert.deepEqual(s2.timeline, []);
	assert.deepEqual(s2.runtime.counts, { workstreams: 0, tasks: 0, runs: 0, pendingMailbox: 0 });
	assert.equal(s2.runtime.journal.totalEvents, 0);
	assert.equal(s2.runtime.journal.skippedBadLines, 0);
	assert.deepEqual(s2.runtime.journal.recent, []);
	assert.deepEqual(s2.sectionErrors, [], "缺文件属 tolerant 而非 error（readAttachment「缺失→null」同源）");

	// ── T3 坏文件容忍 + 不落盘 ──────────────────────────────────────
	useRuntimeDir(D3);
	const J3 = join(D3, "events.jsonl");
	const evd = newEventEnvelope({
		type: "run.dispatched", source: masterAddress(), subject: "run://tab/tab_b1",
		at: "2026-09-17T19:00:00.000Z", dedupeKey: "run.dispatched:run://tab/tab_b1",
		payload: { tabRunId: "tab_b1" },
	});
	writeFileSync(J3, `${JSON.stringify(evd)}\nnot-json\n`, "utf8"); // 1 行坏 JSON
	const ATT3 = join(D3, "registry", "attachments", "agent___master_default.json");
	mkdirSync(join(D3, "registry", "attachments"), { recursive: true });
	writeFileSync(ATT3, "{bad json", "utf8");
	const WS3 = join(D3, "state");
	const ws3 = createWorkstream({ stateDir: WS3, session: S.session, mission: "T3" });
	createTask({ stateDir: WS3, objective: "t3", externalTaskId: "9301", workstreamId: ws3.id, session: S.session });

	const pre = snap(D3);
	assert.equal(pre.master.attachment, null, "attachment 坏 JSON → null 不抛");
	assert.deepEqual(pre.sectionErrors, [], "收窄语义：底层 tolerant reader 吞掉的坏 attachment 不进 sectionErrors（缺失/逐文件解析错误不记）");
	assert.equal(pre.runtime.journal.skippedBadLines, 1, "journal 坏行计数（文件保持原样）");
	assert.equal(pre.runtime.journal.totalEvents, 1);
	assert.equal(pre.runs.length, 1, "坏行不影响其余投影");
	assert.equal(pre.runs[0].status, "dispatched");
	assert.equal(pre.workstreams.length, 1);

	const hashBefore = treeHash(D3);
	const during = snap(D3); // 二次构建：R1 不落盘的强断言窗口
	const hashAfter = treeHash(D3);
	assert.equal(hashAfter, hashBefore, "R1/R7：构建前后目录树 + mtime + 内容哈希不变（零写盘）");

	// 检测力验证（G1 L4 review 必须修复项 2）：空目录与仅 mtime 变更必须可被检出
	const emptyDir = join(D3, "new-empty-dir");
	mkdirSync(emptyDir);
	assert.notEqual(treeHash(D3), hashBefore, "能检出新增空目录（目录条目已入摘要）");
	rmSync(emptyDir, { recursive: true, force: true });
	assert.equal(treeHash(D3), hashBefore, "删除后恢复原摘要");
	const t3st = lstatSync(J3);
	utimesSync(J3, new Date(0), new Date(0));
	const hZero = treeHash(D3);
	assert.notEqual(hZero, hashBefore, "能检出仅 mtime 变更（timestamp 已入摘要）");
	utimesSync(J3, new Date(0), new Date(0));
	assert.equal(treeHash(D3), hZero, "同 mtime 状态 → 同摘要（treeHash 纯函数）");
	utimesSync(J3, t3st.atime, t3st.mtime); // 恢复（utimes 亚毫秒精度损失，故不做与 hashBefore 的全等复原断言）
	assert.notEqual(treeHash(D3), hZero, "恢复后与 mtime=0 状态不同");

	// state/ 可重建性（L1 §5 / R1）：journal 派生段与 rm 前一致；
	// workstreams 段直读 state/（非 journal 派生），rm 后为空属预期，不影响「snapshot 无 staleness」。
	rmSync(WS3, { recursive: true, force: true });
	assert.ok(!existsSync(WS3));
	const after = snap(D3);
	assert.deepEqual(after.runs, pre.runs, "rm state/ 后 runs 仍由 journal 全量 rebuild，不受物化缓存影响");
	assert.deepEqual(after.master, pre.master);
	assert.deepEqual(after.runtime.journal, pre.runtime.journal);
	assert.deepEqual(after.workstreams, [], "workstreams 直读 state/：rm 后为空（非 staleness，是数据源本身缺失）");
	assert.deepEqual(after.sectionErrors, [], "上述缺失均 tolerant");

	// ── T3b sectionErrors 收窄语义可观测：底层未吞掉的调用异常确实进段级错误 ─────
	// 把 state/workstreams 目录换成普通文件 → listWorkstreams 的 readdirSync 抛 ENOTDIR
	//（readAttachment 型 tolerant reader 只吞逐文件解析错误，不吞这种调用级异常），
	// 应被 buildWorkstreamsSection 的 try/catch 接住：段降级 [] + 记入 sectionErrors，
	// 其余段正常装配、不炸整体（证明“调用异常必记”侧与 T3 的“吞掉不记”侧都对）。
	useRuntimeDir(D6);
	writeFileSync(join(D6, "events.jsonl"), "", "utf8");
	mkdirSync(join(D6, "state"), { recursive: true });
	writeFileSync(join(D6, "state", "workstreams"), "i am a file", "utf8"); // 路径是普通文件（ENOTDIR 源）
	const s6 = snap(D6);
	assert.equal(s6.workstreams.length, 0, "ENOTDIR 段降级为 []");
	assert.equal(s6.sectionErrors.length, 1, "仅此段一条错误");
	assert.ok(s6.sectionErrors[0].startsWith("workstreams:"), `段名归属正确：${s6.sectionErrors[0]}`);
	assert.ok(!s6.sectionErrors[0].startsWith("top:"), "未炸到顶层兜底（其余段正常）");
	assert.equal(s6.runs.length, 0);
	assert.equal(s6.runtime.journal.totalEvents, 0);

	// ── T6 never-throw：无效 Date 注入不抛，generatedAt 合法 ISO ──────────────
	useRuntimeDir(D2);
	const s7 = snap(D2, new Date("invalid")); // 等价 buildRuntimeSnapshot({ now: new Date("invalid") })
	assert.ok(!Number.isNaN(Date.parse(s7.generatedAt)), `invalid now 不得抛且 generatedAt 为合法 ISO：${s7.generatedAt}`);
	assert.equal(s7.version, 1);
	assert.deepEqual(s7.workstreams, [], "无效 now 不影响其余段正常兜底");

	// ── T4 占位与幂等 ───────────────────────────────────────────────
	useRuntimeDir(D1);
	const fixed = new Date("2026-09-18T00:00:00.000Z");
	const a = snap(D1, fixed);
	const b = snap(D1, fixed);
	assert.deepEqual(a.attention, [], "D1 无 attention 源（mailbox 仅 REPORT，非 escalation/question）→ []");
	assert.equal(a.timeline.length, 2, "G3 填充：timeline = D1 journal 2 条事件（无 proposal、ws active → 无状态条目）");
	assert.deepEqual(
		a.timeline.map((t) => [t.kind, t.at] as const),
		[
			["event", "2026-09-17T19:00:00.000Z"],
			["event", "2026-09-17T19:05:00.000Z"],
		],
		"timeline at 升序（run.dispatched → run.completed）",
	);
	assert.deepEqual(a, b, "同种子 + 同 now → 同输出（snapshot 是复制不是状态）");
	assert.equal(a.generatedAt, "2026-09-18T00:00:00.000Z", "now 注入决定 generatedAt");

	// ── T5 大 journal 性能 smoke（10,000 行 = 5,000 对 dispatched/completed）──
	useRuntimeDir(D5);
	const J5 = join(D5, "events.jsonl");
	const lines: string[] = [];
	for (let i = 0; i < 5000; i++) {
		const subject = `run://tab/perf_${i}`;
		lines.push(JSON.stringify(newEventEnvelope({
			type: "run.dispatched", source: masterAddress(), subject,
			at: "2026-01-01T00:00:00.000Z", dedupeKey: `run.dispatched:${subject}`,
			payload: { tabRunId: `perf_${i}` },
		})));
		lines.push(JSON.stringify(newEventEnvelope({
			type: "run.completed", source: masterAddress(), subject,
			at: "2026-01-01T00:00:01.000Z", dedupeKey: `run.completed:${subject}`,
			payload: { status: "completed" },
		})));
	}
	writeFileSync(J5, `${lines.join("\n")}\n`, "utf8");
	const t0 = Date.now();
	const s5 = snap(D5);
	const elapsed = Date.now() - t0;
	assert.ok(elapsed < 2000, `T5：10k 行构建耗时 ${elapsed}ms 超 2000ms 预算（PR 记录实测值）`);
	assert.equal(s5.runs.length, 5000);
	assert.ok(s5.runs.every((r) => r.status === "completed"));
	assert.equal(s5.runtime.journal.totalEvents, 10000);
	assert.equal(s5.runtime.journal.recent.length, 20, "recent 恒尾 20 条");
	assert.deepEqual(s5.sectionErrors, []);
	console.log(`_test_runtime_snapshot: T5 10k 行全量 rebuild + 构建耗时 ${elapsed}ms`);
} finally {
	for (const d of [D1, D2, D3, D5, D6]) rmSync(d, { recursive: true, force: true });
}

console.log("_test_runtime_snapshot: all assertions passed");
