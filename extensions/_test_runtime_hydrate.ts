/**
 * _test_runtime_hydrate.ts — Phase 5b 测试（附记 A7 F19/F23/F24）
 *
 * 覆盖：
 *   - 全输入装配：runs/workstreams/tasks/mailbox/journal/recentwork/manifest 落盘命名
 *   - manifest 诚实性：charter 缺席标注、recentwork 缺席原因、无 run 空态
 *   - enrichment 复用：workstream 关联 run 显示 taskRef/wsRef + match 标注
 *   - 命名：<gen>-<timestamp>.md，同 gen 多份不覆盖
 *   - 指针纪律：artifact 只指针不内联
 *
 * 运行：npm run test:runtime-hydrate
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "runtime-hydrate-env-"));
const RUNTIME = process.env.PI_RUNTIME_DIR!;
const STATE = join(RUNTIME, "state");
const MAILBOX = join(RUNTIME, "mailbox");
const JOURNAL = join(RUNTIME, "events.jsonl");
const REPO = mkdtempSync(join(tmpdir(), "hydrate-repo-"));

import { attachMaster } from "./runtime/registry.ts";
import { deliverLetter } from "./runtime/mailbox.ts";
import { newMessageFrame } from "./runtime/protocol.ts";
import { newEnvelopeId } from "./runtime/ids.ts";
import { masterAddress } from "./runtime/address.ts";
import { createTask, createWorkstream } from "./runtime/workstreams.ts";
import { buildHandoff } from "./runtime/hydrate.ts";
import { projectJournalToState } from "./runtime/state-store.ts";
import { newEventEnvelope } from "./runtime/envelope.ts";

const S = { stateDir: STATE, session: "test" };

try {
	// ── 种子：attachment + journal(2 runs) + workstream/task + mailbox + recentwork ──
	attachMaster({ sessionId: "sess-H" });
	const ev1 = newEventEnvelope({
		type: "run.dispatched", source: masterAddress(), subject: "run://tab/tab_h1",
		at: "2026-09-17T19:00:00.000Z", dedupeKey: "run.dispatched:run://tab/tab_h1",
		payload: { tabRunId: "tab_h1", executionKind: "tab", externalTaskId: "9101", mode: "workflow", dispatchedAt: "2026-09-17T19:00:00.000Z" },
	});
	const ev2 = newEventEnvelope({
		type: "run.completed", source: masterAddress(), subject: "run://tab/tab_h1",
		at: "2026-09-17T19:05:00.000Z", dedupeKey: "run.completed:run://tab/tab_h1",
		payload: { tabRunId: "tab_h1", executionKind: "tab", status: "completed", summary: "done", reportPath: "plans/done.md", finishedAt: "2026-09-17T19:05:00.000Z" },
	});
	writeFileSync(JOURNAL, [ev1, ev2].map((e) => `${JSON.stringify(e)}\n`).join(""), "utf8");
	projectJournalToState({ journalPath: JOURNAL, stateDir: STATE });

	const ws = createWorkstream({ ...S, mission: "hydrate 演练" });
	const t = createTask({ ...S, objective: "装配验证", externalTaskId: "9101", workstreamId: ws.id });

	deliverLetter(
		newMessageFrame({
			id: newEnvelopeId("msg"), kind: "REPORT", from: "agent://a", to: masterAddress(),
			subject: "run://tab/tab_h1", sentAt: "2026-09-17T19:06:00.000Z", summary: "pend",
			details: { tabRunId: "tab_h1", status: "completed" },
		}),
		{ mailboxDir: MAILBOX },
	);
	writeFileSync(join(REPO, "recentwork.md"), "# recentwork\n- 9101 done\n", "utf8");

	// ── 1. 全输入装配 ──────────────────────────────────────────────
	const doc = buildHandoff({ stateDir: STATE, mailboxDir: MAILBOX, journalPath: JOURNAL, repoRoot: REPO });
	assert.ok(existsSync(doc.path), "落盘");
	assert.ok(doc.path.includes(`${join(RUNTIME, "handoffs")}${""}`) || doc.path.includes("handoffs"), "handoffs 目录");
	assert.match(basename(doc.path), /^\d+-.+\.md$/, "F24 <gen>-<timestamp>.md 命名");
	const byName = new Map(doc.manifest.map((m) => [m.name, m]));
	assert.equal(byName.get("master-attachment")!.present, true);
	assert.ok((byName.get("master-attachment")!.note ?? "").includes("gen=1"));
	assert.equal(byName.get("canonical-runs")!.present, true);
	assert.equal(byName.get("workstreams")!.present, true);
	assert.equal(byName.get("pending-mailbox")!.present, true);
	assert.equal(byName.get("journal-tail")!.present, true);
	assert.equal(byName.get("recentwork")!.present, true);
	assert.ok((byName.get("recentwork")!.source ?? "").includes("recentwork.md"));
	assert.equal(byName.get("charter")!.present, false, "charter 缺席为常态");
	assert.ok(doc.markdown.includes("## Manifest"), "manifest 表落文档");
	// enrichment 复用：workstream 关联 run 显示 ws 引用
	assert.ok(doc.markdown.includes("run://tab/tab_h1 [completed]"), "run 行");
	assert.ok(doc.markdown.includes("externalTaskId") || doc.markdown.includes("ext=9101"), "taskRef 派生");
	// artifact 只指针
	assert.ok(doc.markdown.includes("plans/done.md"), "artifact 指针");
	assert.ok(!doc.markdown.includes("full report content"), "不内联内容");

	// ── 2. 空态诚实性 ──────────────────────────────────────────────
	rmSync(STATE, { recursive: true, force: true });
	const empty = buildHandoff({ stateDir: STATE, mailboxDir: join(RUNTIME, "mbox-empty"), journalPath: join(RUNTIME, "nope.jsonl"), repoRoot: join(REPO, "noroot") });
	const emptyByName = new Map(empty.manifest.map((m) => [m.name, m]));
	assert.equal(emptyByName.get("canonical-runs")!.present, false);
	assert.equal(emptyByName.get("recentwork")!.present, false);
	assert.ok((emptyByName.get("recentwork")!.note ?? "").length > 0, "缺席原因记录");
	assert.ok(empty.markdown.includes("(none)") || empty.markdown.includes("(empty)") || empty.markdown.includes("(absent"), "空态标注");

	// ── 3. 同 gen 多份不覆盖 ────────────────────────────────────────
	const doc2 = buildHandoff({ stateDir: STATE, mailboxDir: MAILBOX, journalPath: JOURNAL, repoRoot: REPO });
	assert.notEqual(doc2.path, doc.path, "同 gen 多份路径不同");
	assert.ok(existsSync(doc.path) && existsSync(doc2.path), "两份并存");
	assert.equal(t.id.startsWith("task_"), true);
	assert.equal(ws.id.startsWith("ws_"), true);
} finally {
	rmSync(RUNTIME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
}

console.log("_test_runtime_hydrate: all assertions passed");
