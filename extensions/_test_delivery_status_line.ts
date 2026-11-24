/**
 * P1 回归网（2026-11-24，QC 反馈 #3/#4/#5/#7）：**补投正文自包含** + **status 截断有声 + 交付面**。
 *
 * ## 这套测试要防的具体错误
 *
 * ① **正文没写「业务已完成」**（QC #3/#7）⇒ 读的人以为任务没做完，去重新派活。
 *    旧正文只有「终态交付未确认」，且**没有** `NO_POLL_HINT`（实测 grep 0 命中）⇒ 与
 *    「禁轮询」纪律冲突（正文写着「下一步用 status 取全文」）。
 * ② **「确认」的判据没写** ⇒ 不知道要不要手工 ack（手工 ack = 把送达退化成模型自述，已被否决）。
 * ③ **status 截断无声**（QC #4）：旧 `status` 是 `text.slice(0,500)`，无任何标记。
 * ④ **status 不显示交付面**（QC #5）：账本里有 `consumed` ACK / incident，status 一个字不显示
 *    ⇒ 「业务完成」与「交付确认」被混成一个（QC #7 的「完成 vs 未确认矛盾」）。
 *
 * ## 纪律
 * 每条断言都走**真实入口**（`buildReconcileWakeBody` / 真实账本文件 → `deliveryStatusFacts`），
 * 不为测试另写一份实现（R-4）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "p1-status-"));
// 隔离到临时运行时（避免任何模块读到生产 ~/.pi/agent）
process.env.PI_RUNTIME_DIR = ROOT;

const sl = await import("./runtime/delivery-status-line.ts");
const { buildReconcileWakeBody } = await import("./runtime-host/delivery-reconciler-loop.ts");
const { NO_POLL_HINT } = await import("./no-poll.ts");
const ledger = await import("./delivery-ledger.ts");
const { eventMarker } = await import("./delivery-ack.ts");

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void) => {
	try {
		fn();
		pass++;
		console.log(`  ok ${pass} - ${name}`);
	} catch (e) {
		fail++;
		console.log(`  NOT OK ${pass + fail} - ${name}`);
		console.log(`    ${e instanceof Error ? e.message : String(e)}`);
	}
};

const EVT = { eventId: "async:run_x:abcdef01", runId: "run_x", terminalAt: "2026-11-24T00:00:00Z", terminalSnapshotPath: "C:/runs/run_x.json" };

// ── ① 补投正文：四件自包含信息（业务状态 / 判据 / 全文路径 / 禁轮询）────
check("① 补投正文自包含：业务已完成 + 判据 + 全文路径 + NO_POLL_HINT + eventId 标记", () => {
	const body = buildReconcileWakeBody(EVT, 1);
	assert.ok(body.includes("业务已完成"), `必须写明业务已完成（实得首行：${body.split(String.fromCharCode(10))[0]}）`);
	assert.ok(body.includes("终态交付未确认"), "兼容：仍保留「终态交付未确认」原文（既有识别/测试依赖）");
	assert.ok(body.includes("不要**手工 ack") || body.includes("不要手工 ack"), "必须写明不要手工 ack");
	assert.ok(body.includes("本地 context 钩子"), "必须写明送达判据是本地钩子检出 marker");
	assert.ok(body.includes("C:/runs/run_x.json"), "必须给出全文盘的绝对路径（status 预览会截断）");
	assert.ok(body.includes(NO_POLL_HINT), "必须带上 NO_POLL_HINT（QC #3：正文与禁轮询纪律冲突）");
	assert.ok(body.includes(eventMarker(EVT.eventId)), "marker 必须在（consumed ACK 的唯一驱动）");
	assert.ok(body.trimEnd().endsWith(eventMarker(EVT.eventId)), "marker 必须在**尾部**（context 钩子按尾部约定检出）");
});

check("② 第 N 次补投：序号可见，且未传序号时无「第 」字样（兼容既有断言）", () => {
	const b2 = buildReconcileWakeBody(EVT, 2);
	assert.ok(b2.includes("第 2 次补投（第 1 次未确认）"), `第 2 次必须带序号（实得首行：${b2.split(String.fromCharCode(10))[0]}）`);
	const b0 = buildReconcileWakeBody(EVT);
	assert.ok(!b0.includes("第 "), "未传序号 ⇒ 不出现「第 」（既有断言 S4 依赖）");
});

check("③ 缺 terminalSnapshotPath 时退化为「用 status 取」，不得凭空编路径", () => {
	const body = buildReconcileWakeBody({ eventId: EVT.eventId, runId: EVT.runId, terminalAt: EVT.terminalAt }, 1);
	assert.ok(!body.includes("全文在:"), "没有盘路径 ⇒ 不得出现 `全文在:`");
	assert.ok(body.includes('action: "status"'), "退化为用 status 取（并提示预览会截断）");
});

// ── ④ 截断标记（H4）────────────────────────────────────────────
check("④ truncatePreview：未超限逐字不变；超限必带「已截断 + 总数 + 上限」", () => {
	const short = "a".repeat(500);
	assert.equal(sl.truncatePreview(short, 500), short, "恰好等于上限 ⇒ 不改（旧 slice 也如此）");
	const long = "b".repeat(1200);
	const p = sl.truncatePreview(long, 500);
	assert.ok(p.startsWith("b".repeat(500)), "前 500 字符保留");
	assert.ok(p.includes("已截断"), "必须标「已截断」");
	assert.ok(p.includes("1200"), "必须给出总字符数（否则读者无法判断缺多少）");
	assert.ok(p.includes("500"), "必须给出截断上限");
});

check("⑤ truncatePreview：给 fullPath 时把绝对路径写进标记（省一次猜测）", () => {
	const p = sl.truncatePreview("c".repeat(600), 500, "C:/runs/run_y.json");
	assert.ok(p.includes("C:/runs/run_y.json"), `标记里必须有全文路径，实得尾部：${p.slice(-60)}`);
});

// ── ⑥ 交付面：真实账本文件 → 事实 → 一行文案（H5）──────────────────
const DELIV = join(ROOT, "delivery");
const mkRunRecord = (id: string) => ({ id, status: "completed", endedAt: EVT.terminalAt, agent: "general", result: { status: "completed", text: "done", error: null } });

/** 造一个真实事件（走 ensureEvent），返回 eventId。 */
const seedEvent = (runId: string) => {
	const { event } = ledger.ensureEvent(DELIV, {
		runId,
		terminalRevision: ledger.terminalRevisionOf(mkRunRecord(runId)),
		terminalSnapshotPath: join(ROOT, `${runId}.json`),
		dispatcherSessionId: "01a1aaaa-0000-7000-8000-000000000001",
		observedAt: EVT.terminalAt,
		terminalAt: EVT.terminalAt,
	});
	return event.eventId;
};

check("⑥ 账本里没有该事件 ⇒ facts=null、line=null（不推断、不显示）", () => {
	assert.equal(sl.deliveryStatusFacts(DELIV, "run_absent", mkRunRecord("run_absent")), null);
	assert.equal(sl.deliveryStatusLine(null), null);
});

check("⑦ 有 attempt 但无 consumed ⇒ 文案必须说「不代表业务未完成」（QC #7 的矛盾来源）", () => {
	const runId = "run_att";
	const eid = seedEvent(runId);
	ledger.recordAttempt(DELIV, eid, { attemptId: `${eid}@A@1`, channel: "A", at: EVT.terminalAt, status: "sent" });
	const f = sl.deliveryStatusFacts(DELIV, runId, mkRunRecord(runId));
	assert.ok(f !== null);
	assert.equal(f.stage, "attempted", `实得 stage=${f.stage}`);
	assert.equal(f.consumedAt, null, "无 ACK ⇒ consumedAt 必须 null（不得用发送侧事实冒充）");
	assert.equal(f.attempts, 1);
	const line = sl.deliveryStatusLine(f)!;
	assert.ok(line.includes("不代表"), `必须显式否认「业务未完成」，实得：${line}`);
	assert.ok(line.includes("consumed"), "必须点明缺的是 consumed ACK");
});

check("⑧ 有 consumed ACK ⇒ stage=consumed 且文案带 ✅/时刻/证据", () => {
	const runId = "run_ok";
	const eid = seedEvent(runId);
	ledger.recordAttempt(DELIV, eid, { attemptId: `${eid}@A@2`, channel: "A", at: EVT.terminalAt, status: "sent" });
	ledger.writeAck(DELIV, { eventId: eid, stage: "consumed", attemptId: `${eid}@A@2`, recipientGeneration: 1, at: "2026-11-24T00:01:00Z", evidence: "context-observed" } as never);
	const f = sl.deliveryStatusFacts(DELIV, runId, mkRunRecord(runId))!;
	assert.equal(f.stage, "consumed", `实得 stage=${f.stage}`);
	assert.equal(f.consumedAt, "2026-11-24T00:01:00Z");
	assert.equal(f.consumedEvidence, "context-observed");
	const line = sl.deliveryStatusLine(f)!;
	assert.ok(line.includes("✅"), `送达必须一眼可辨，实得：${line}`);
	assert.ok(line.includes("context-observed"), "必须给接收侧证据");
});

check("⑨ 已发 incident ⇒ stage=failed_delivery，文案必须说「不是业务失败」", () => {
	const runId = "run_fail";
	const eid = seedEvent(runId);
	const ev = ledger.loadEvent(DELIV, eid)!;
	ledger.publishIncident(DELIV, ev, "deadline-exceeded(deadline=x,stage=attempted)", Date.now());
	const f = sl.deliveryStatusFacts(DELIV, runId, mkRunRecord(runId))!;
	assert.equal(f.stage, "failed_delivery", `实得 stage=${f.stage}`);
	assert.ok(f.incidentId !== null, "必须带 incidentId（可定位）");
	const line = sl.deliveryStatusLine(f)!;
	assert.ok(line.includes("不是**业务失败") || line.includes("不是业务失败"), `必须区分交付失败与业务失败，实得：${line}`);
});

// ── ⑩ never-throw：账本目录不可读 ⇒ null，不抛 ──────────────────
check("⑩ 账本目录是文件（ENOTDIR）⇒ facts=null，不抛", () => {
	const bad = join(ROOT, "not-a-dir");
	writeFileSync(bad, "x", "utf8");
	assert.equal(sl.deliveryStatusFacts(bad, "run_x", mkRunRecord("run_x")), null);
});

console.log(`p1-status: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
rmSync(ROOT, { recursive: true, force: true });
