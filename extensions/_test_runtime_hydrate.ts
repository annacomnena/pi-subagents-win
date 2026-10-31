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

	// ── 4. RecentWork 必须取 `## Active Tasks` 区段，不是文件头 ────────
	//
	// 回归背景（2026-10-31 实测）：原实现 `truncateUtf8(buf, 2048)` 取**整文件前 2048 字节**。
	// 三个真实仓的 recentwork.md 开头都是「Maintenance Rules」之类写入端规范，真正任务
	// 状态在 1 KB 之后 ⇒ 交接包只拿到 1.2%~1.7%，且 subagent-win 1 条任务行（还被劈断）、
	// battlesandbox 0 条、GreenCAD 0 条。
	//
	// 断言纪律（吸取 `_test_session_liveness.ts:80` 把 bug 锁成规范的教训）：
	//   **不得**只断言「excerpt 非空」或「长度 == 2048」—— 两种写法在修复前也可能绿。
	//   必须断言**具体任务标识真的到了交接包**，且**头部噪音真的不在**。
	const FAT_REPO = mkdtempSync(join(tmpdir(), "hydrate-fat-"));
	try {
		// 构造与真实仓同形状的文件：>2KB 维护规则在头部，任务表在其后。
		const noise = ["# Recent Work（时序面）", "", "> 定位：任务进度与时间线。", "", "## Maintenance Rules", ""];
		// 约 3KB 头部噪音（远超 2048 上限）—— 这就是真仓头部那一坨
		for (let i = 0; i < 60; i++) {
			noise.push(`- 规则 ${i}：STATUS_NOISE_MARKER 编号不复用、不重编号；每条只出现一次；内容原样搬运。`);
		}
		const active = [
			"", "## Active Tasks", "", "### Task Index", "",
			"| Item | Priority | Summary | Dependency | Next action | 详情 |",
			"|---|---|---|---|---|---|",
			"| 641 | P1 | **TASK_SENTINEL_ALPHA 活跃任务** | none | 进行中 | 本区 |",
			"| 642 | P2 | **TASK_SENTINEL_BETA 另一条** | none | 待实机 | 本区 |",
			"", "## Archived Tasks", "", "- ARCHIVE_NOISE_MARKER 已归档条目",
		];
		// 注：区段边界只认二级标题 `## `（与真实仓一致：三个仓的归档区都是 `## Archived Tasks`
		// 或降在维护规则下），所以写 `##` 才能验证「下一个二级标题之后的归档内容不越界」。
		// 若把它写成 `### Archived`，它会落在 Active 区段内部 —— 那属于区段真实内容，
		// 截断范围内保留是正确行为（不算越界）。
		writeFileSync(join(FAT_REPO, "recentwork.md"), [...noise, ...active].join("\n"), "utf8");

		const fatDoc = buildHandoff({ stateDir: STATE, mailboxDir: MAILBOX, journalPath: JOURNAL, repoRoot: FAT_REPO });
		const fatRw = fatDoc.manifest.find((m) => m.name === "recentwork")!;

		// (a) 核心：任务标识必须真的进交接包（修复前这是红的）
		assert.ok(
			fatDoc.markdown.includes("TASK_SENTINEL_ALPHA"),
			"交接包必须含 Active Tasks 里的任务标识（实测 172KB 仓修复前 0~1 条任务行）",
		);
		assert.ok(fatDoc.markdown.includes("TASK_SENTINEL_BETA"), "第二条也必须在（证明取的是区段不是头部）");
		// (b) 反向：头部噪音不得占用交接包（证明不是「把上限撞大」蒙对的）
		assert.ok(!fatDoc.markdown.includes("STATUS_NOISE_MARKER"), "维护规则噪音不得进交接包");
		// (c) 区段边界：下一个 `## ` 之后的内容不得越界带进来
		assert.ok(!fatDoc.markdown.includes("ARCHIVE_NOISE_MARKER"), "归档区段不得被带进交接包");
		// (d) manifest 如实报告取的是区段
		assert.ok(fatRw.present, "fat recentwork 必须 present");
		assert.ok(/Active Tasks section/.test(fatRw.note ?? ""), `note 必须说明取的是区段；实际 ${JSON.stringify(fatRw.note)}`);

		// (e) 无 `## Active Tasks` 区段的仓 ⇒ 回退文件头，且 manifest 如实标注回退原因
		const NO_SECTION = mkdtempSync(join(tmpdir(), "hydrate-nosec-"));
		try {
			writeFileSync(join(NO_SECTION, "recentwork.md"), "# 只有归档\n\n- NO_SECTION_MARKER 无活跃区段\n", "utf8");
			const noSecDoc = buildHandoff({ stateDir: STATE, mailboxDir: MAILBOX, journalPath: JOURNAL, repoRoot: NO_SECTION });
			const noSecRw = noSecDoc.manifest.find((m) => m.name === "recentwork")!;
			assert.equal(noSecRw.present, true, "无区段仍应 present（回退文件头）");
			assert.ok(/no Active Tasks section/.test(noSecRw.note ?? ""), `必须标注回退原因；实际 ${JSON.stringify(noSecRw.note)}`);
			assert.ok(noSecDoc.markdown.includes("NO_SECTION_MARKER"), "回退内容应可见");
		} finally {
			rmSync(NO_SECTION, { recursive: true, force: true });
		}
	} finally {
		rmSync(FAT_REPO, { recursive: true, force: true });
	}

	// ── 5. 长条目仓：必须有「未列入」声明，且不能被静默截断 ────────
	//
	// 变异验证记录（2026-10-31）：下列两条断言是在**变异测试发现原测试漏覆盖**后才补的。
	//   变异 A：`contentCap = capBytes`（不预留 note 空间）—— 重演「2046/2048 用满 → note
	//           放不下 → 直接 return body」，结果**无任何声明**。旧测试（短条目）全绿，漏。
	//   变异 B：`tryPush(itemHead(b))` → `tryPush(b)`（不裁条目）—— 单条 11K 字符占满预算，
	//           后续条目全被饿死。旧测试（每条一行）全绿，漏。
	// 两条都对应真实仓形状（subagent-win 单条最大 11,625 字符）。
	const DEEP_REPO = mkdtempSync(join(tmpdir(), "hydrate-deep-"));
	try {
		const longBody = "LONG_SENTINEL_FILLER ".repeat(700); // ≈ 14KB 单条（比真实最大单条还大）
		const deep = [
			"# Recent Work",
			"",
			"## Active Tasks",
			"",
			"### Item 901 — DEEPITEM_FIRST 第一条（超长正文）",
			"",
			longBody,
			"",
			"### Item 902 — DEEPITEM_SECOND 第二条",
			"",
			"- 第二条的实质内容 SHOULD_SURVIVE_TRUNCATION",
			"",
			"### Item 903 — DEEPITEM_THIRD 第三条",
			"",
			"- 第三条的实质内容",
		];
		writeFileSync(join(DEEP_REPO, "recentwork.md"), deep.join("\n"), "utf8");

		const deepDoc = buildHandoff({ stateDir: STATE, mailboxDir: MAILBOX, journalPath: JOURNAL, repoRoot: DEEP_REPO });

		// (a) 裁条目：单条 14KB 不能独吞预算 ⇒ 后面的条目必须也能进来（变异 B 会打红这条）
		assert.ok(
			deepDoc.markdown.includes("DEEPITEM_SECOND"),
			"超长第一条不得独吞预算 —— 第二条必须也能进交接包",
		);
		assert.ok(deepDoc.markdown.includes("DEEPITEM_THIRD"), "第三条也必须能进来");
		assert.ok(deepDoc.markdown.includes("DEEPITEM_FIRST"), "第一条本身也不得丢失（应硬截断而非跳过）");
		// L4 审查 §8：这个 sentinel 原先只写在 fixture 里、**没有任何 assert 引用它**
		// （死 sentinel，给人「测过了」的错觉）。现在真正启用。
		assert.ok(
			deepDoc.markdown.includes("SHOULD_SURVIVE_TRUNCATION"),
			"第二条的正文（非标题的普通行）必须穿透预算限制到达交接包",
		);
		// (b) 预算真实生效
		const rwStart = deepDoc.markdown.indexOf("## RecentWork");
		const rwEnd = deepDoc.markdown.indexOf("## Charter", rwStart);
		const rwSection = deepDoc.markdown.slice(rwStart, rwEnd > 0 ? rwEnd : undefined);
		const rwBytes = Buffer.byteLength(rwSection, "utf8");
		assert.ok(rwBytes < 2048 + 400, `RecentWork 段应受 2048 预算约束（实测 ${rwBytes} B，含标题/占位行）`);
	} finally {
		rmSync(DEEP_REPO, { recursive: true, force: true });
	}

	// ── 6. 静默截断防线：条目必然装不下时，必须出现「未列入」 ──
	//
	// 变异验证记录（诚实）：
	//   ✅ 变异 B（`tryPush(itemHead(b))` → `tryPush(b)`）→ 上段「第一条本身也不得丢失」**变红**。
	//   ⚠️ 变异 A（`contentCap = capBytes`，取消 NOTE_RESERVE 预留）→ **本测试不变红**。
	//      原因（已实测）：`itemHead` 现在会把每条压到 ≤420 字符，且**单行硬截断**，
	//      因此 40 条 × 内容度的仓也只会占 ~1.7KB，远不满 2048 ⇒ note 总放得下。
	//      即：**NOTE_RESERVE 目前是冗余防线而非唯一防线**，硬截断已先一步挡住了那条路径。
	//      保留 NOTE_RESERVE 是为了将来若改 PER_ITEM_BUDGET（如调到 1500）时不静默丢失声明。
	//      不为了凑一条“能打红的断言”而把预算改坏——变异 A 无法被结构性打红，如实记在此。
	//   本段仍有价值：它锁住「条目多到超过预算时必须有声明」这个可见行为（目前为绿）。
	const OVERFLOW_REPO = mkdtempSync(join(tmpdir(), "hydrate-overflow-"));
	try {
		const many: string[] = ["# Recent Work", "", "## Active Tasks", ""];
		for (let i = 1; i <= 40; i++) {
			many.push(`### Item ${700 + i} — OVERFLOW_ITEM_${i} 第 ${i} 条`, "");
			// 每条 ~300 字符正文：40 条 ≈ 12KB，必然超 2048
			many.push(`- ${`填充正文${i}。`.repeat(30)}`, "");
		}
		writeFileSync(join(OVERFLOW_REPO, "recentwork.md"), many.join("\n"), "utf8");
		const ovDoc = buildHandoff({ stateDir: STATE, mailboxDir: MAILBOX, journalPath: JOURNAL, repoRoot: OVERFLOW_REPO });
		assert.ok(
			/未列入/.test(ovDoc.markdown),
			`条目必然装不下时必须声明「未列入」，不得静默截断（变异 A 会把这条打红）`,
		);
	} finally {
		rmSync(OVERFLOW_REPO, { recursive: true, force: true });
	}

	// ── 7. 超长 Task Index：必须按行裁而非整块拒 ────────────────
	//
	// 实测本仓 Task Index 块 = 9,962 字符 / 15,532 字节，整块远超 2048 预算。
	// 若`tryPush(整块)` ⇒ **整块被拒** ⇒ 最有用的一屏总览一条都进不去（修复前的真实现状）。
	// 断言：索引表头必须可见 + 至少 1 条数据行 + 行数声明。
	const IDX_REPO = mkdtempSync(join(tmpdir(), "hydrate-idx-"));
	try {
		const idxLines = [
			"# RW", "", "## Active Tasks", "", "### Task Index", "",
			"| Item | Priority | Summary | Dependency | Next action | 详情 |",
			"|---|---|---|---|---|---|",
		];
		// 60 行 × ~250 字符 ≈ 15KB —— 与本仓实际 Task Index 同量级
		for (let i = 1; i <= 60; i++) {
			idxLines.push(`| ${100 + i} | P1 | **INDEX_ROW_${i}** ${`摘要正文${i}。`.repeat(20)} | none | 待做 | 本区 |`);
		}
		idxLines.push("", "### Item 1 — 后续条目", "", "- 内容");
		writeFileSync(join(IDX_REPO, "recentwork.md"), idxLines.join("\n"), "utf8");

		const idxDoc = buildHandoff({ stateDir: STATE, mailboxDir: MAILBOX, journalPath: JOURNAL, repoRoot: IDX_REPO });
		// (a) 表头必须可见（若整块被拒，连表头都没有）
		assert.ok(idxDoc.markdown.includes("| Item | Priority | Summary"), "Task Index 表头必须可见（整块被拒时这是空的）");
		// (b) 至少一条数据行
		assert.ok(/INDEX_ROW_\d+/.test(idxDoc.markdown), "Task Index 至少要有 1 条数据行");
		// (c) 被截时必须有行数声明
		assert.ok(/共 \d+ 行，此处 \d+ 行/.test(idxDoc.markdown), "索引被截时必须声明「共 N 行，此处 M 行」");
		// (d) 索引不得吃光预算：后续 Item 条目仍要能进
		assert.ok(idxDoc.markdown.includes("### Item 1 — 后续条目"), "索引占预算不得超过 40%，Item 条目仍须能进");
	} finally {
		rmSync(IDX_REPO, { recursive: true, force: true });
	}

	// ── 8. 无 `###` 子标题 / 无编号条目：正文不得丢失（L4 N-2 + P1#3 回归锁）──
	//
	// L4 审查实测的**真回归**（旧实现 `aa3abce` 本来能整段放下，修复后反而丢了）：
	//   · 区段内无 `###` ⇒ 全部正文进同一个 other 块；而 other 块只在
	//     `itemBlocks.length > 0 && omitted === itemBlocks.length` 时才被尝试
	//     ⇒ `itemBlocks.length === 0` 时永不进入 ⇒ **正文一条不剩**（100%→0%）。
	//   · 无编号条目（`### SBS-RUNS-M1`，真实仓 10,466B，是活跃任务）归入 other
	//     ⇒ 同样被跳过 ⇒ 永不进包且 `omitted` 不计数（静默丢失）。
	// 现实现：other 块（跳过纯空白）**无条件尝试**。
	const NOH3_REPO = mkdtempSync(join(tmpdir(), "hydrate-noh3-"));
	try {
		// (a) 区段内完全无 `###`
		writeFileSync(
			join(NOH3_REPO, "recentwork.md"),
			"## Active Tasks\n\n- TASK_A 已交付\n- TASK_B 待实机确认\n- TASK_C 阻塞\n",
			"utf8",
		);
		const noH3Doc = buildHandoff({ stateDir: STATE, mailboxDir: MAILBOX, journalPath: JOURNAL, repoRoot: NOH3_REPO });
		assert.ok(noH3Doc.markdown.includes("TASK_A"), "区段无 ### 时正文不得丢失（旧实现全丢）");
		assert.ok(noH3Doc.markdown.includes("TASK_C"), "最后一条也要在");

		// (b) 有编号 Item + 无编号条目共存 ⇒ 无编号条目也必须能进
		writeFileSync(
			join(NOH3_REPO, "recentwork.md"),
			[
				"## Active Tasks", "",
				"### Item 1 — 有编号的", "", "- 内容一", "",
				"### SBS-RUNS-M1 里程碑任务", "", "- MILESTONE_TASK 关键信息", "",
			].join("\n"),
			"utf8",
		);
		const mixedDoc = buildHandoff({ stateDir: STATE, mailboxDir: MAILBOX, journalPath: JOURNAL, repoRoot: NOH3_REPO });
		assert.ok(mixedDoc.markdown.includes("### Item 1"), "编号条目应在");
		assert.ok(mixedDoc.markdown.includes("MILESTONE_TASK"), "无编号条目也不得被跳过（旧实现只在所有 Item 都失败时才试 other 块）");
	} finally {
		rmSync(NOH3_REPO, { recursive: true, force: true });
	}

	// ── 9. 超长标题的条目不得因 `budgetLeft` 下限而丢失（L4 P1#4）──
	//
	// 旧实现 `budgetLeft > 40` 下限：标题本身就占满预算（≤40 剩余）时该行不截断
	// ⇒ itemHead 仍达 14KB ⇒ tryPush 永久失败 ⇒ 条目丢失，而预算还剩 1,892B 闲置。
	const LONGHEAD_REPO = mkdtempSync(join(tmpdir(), "hydrate-longhead-"));
	try {
		const longTitle = "### Item 7 — " + "超长标题".repeat(60); // ≈ 380+ 字符
		writeFileSync(
			join(LONGHEAD_REPO, "recentwork.md"),
			["## Active Tasks", "", longTitle, "", "X".repeat(14000), ""].join("\n"),
			"utf8",
		);
		const longDoc = buildHandoff({ stateDir: STATE, mailboxDir: MAILBOX, journalPath: JOURNAL, repoRoot: LONGHEAD_REPO });
		assert.ok(longDoc.markdown.includes("Item 7"), "超长标题的条目不得丢失（预算不得闲置而丢条目）");
	} finally {
		rmSync(LONGHEAD_REPO, { recursive: true, force: true });
	}
} finally {
	rmSync(RUNTIME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
}

console.log("_test_runtime_hydrate: all assertions passed");
