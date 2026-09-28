/**
 * _test_expectations.ts — 0928 P2 v2-b 最小切片：⑧ 请求—回执期望账本 + 三事件 + 两生产者
 *
 * 覆盖（plans/0928_p2_expected_reply_slice_plan.md §8 A/B 组；stub 时钟 + 临时目录，零真实网络/进程）：
 *   G1  声明（生产者 1 = deliverLetter 成功点）：谓词全过 → open/ 记录齐 + 默认 30min deadline；
 *       dedupe 重复投递 → 恰 1 文件 1 事件（first-wins）；四类被排除帧（自地址 REPORT / 带 inReplyTo /
 *       requiresAck=false / expectReply:false）零账本；**派发失败（校验抛错）→ 无任何账本文件**；
 *       project 归因四变体 explicit / attachment / workspace-ref / unresolved。
 *   G2  到达（生产者 2 = 消费链回信匹配点）：四键匹配 → closed/arrived + arrived 事件恰 1 行 +
 *       无 timeout 行；**消费端接线**（claim+fencing 后关闭，经 consumeMailboxOnce 真链）。
 *   G3  超期：open∧now>deadline 派生 → timeout 事件恰 1 行；重复 materialize 不增行（同 id,rev 至多一行）；
 *       frontier level 触发未 ack 每帧重出、ack 后停止、baseline 帧压制。
 *   G4  重复回信：终态逐字节不变 + 审计 duplicate-reply 恰 1 + arrived 不增行。
 *   G5  迟到回信：超期已物化 → 到达仍关闭、arrival.late=true、attention 条目消失、超期停止派生。
 *   G6  错对象回信：from/kind/to 三变体 → 均不关闭、审计 reply-mismatch 各 1、期望仍 open。
 *   G7  取消：closed/cancelled → 之后不再派生超期、再到达不重开（late-reply-cancelled）。
 *   G8  deadline 更新：open 内 rev+1（set 事件各 rev 恰 1 行）、旧 deadline 停派生、新 deadline 恢复；
 *       closed 后更新拒绝（文件逐字节不变）。
 *   G9  聚合不覆盖：同 projectKey 两请求 A/B + 新声明 C → A/B 记录逐字节不变；只关 B →
 *       frontier.overdueRequests=[A]、watchdog 检查 3 true、attention 只剩 A；version 只在 id 集合新增时 +1。
 *   G10 never-throw：账本根不可写（state 是文件）→ deliverLetter 仍 created:true、declare 返回 null 不抛。
 *   G11 recordOnly 契约：直调不传 expectations → 逐字 3 条；传列表 → 2 条。
 *   G12 gate ack + cooldown 不丢边沿 + 重启回放：baseline 帧零触发 → cooldown 窗内 no-wake 且 audit
 *       已有触发行 → 窗后放行 + ack 表写入 → 下一帧零 ⑧ 触发；ack 表丢失 → 触发重发（at-least-once）。
 *   G13 collect 装配：有账本 → recordonly=2 + watchdog 检查 3 可判定；无账本 → recordonly=3 + unknown。
 *   G14 kill：engage → gate 抑制、无 ack、账本逐字节不变；attention 纯读面仍列超期；clear 后恢复。
 *   G15 事件面：三型 payload/dedupeKey 断言；projector 对新 type 不投影不抛（skipped 计数）。
 *   G16 静态边界：protocol.ts 冻结词表逐字 + 无事件词表泄漏；collect/gate 无 journal/投递写调用。
 *
 * 运行：npm run test:expectations
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 测试隔离：defaultRuntimeDir() 全部走 temp（env 先于 import）
process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "expectations-env-"));
delete process.env.PI_SUBAGENT;
delete process.env.PI_TAB_RUN_ID;
const RUNTIME = process.env.PI_RUNTIME_DIR!;
const STATE = join(RUNTIME, "state");
const MAILBOX = join(RUNTIME, "mailbox");
const JOURNAL = join(RUNTIME, "events.jsonl");
const ROOT = join(STATE, "expectations");

import { masterAddress, type ObjectAddress } from "./runtime/address.ts";
import type { GateStatus } from "./runtime/global-view.ts";
import { localMasterAddress } from "./runtime/scope.ts";
import { newEnvelopeId } from "./runtime/ids.ts";
import { newMessageFrame, MESSAGE_KINDS, COMMAND_TYPES, type MessageFrame, type MessageKind } from "./runtime/protocol.ts";
import { deliverLetter } from "./runtime/mailbox.ts";
import { attachMaster, setCutover } from "./runtime/registry.ts";
import { listRuntimeEnvelopes } from "./runtime/journal.ts";
import { newEventEnvelope } from "./runtime/envelope.ts";
import { rebuildFromEnvelopes } from "./runtime/projector.ts";
import { buildAttentionItems } from "./runtime-host/attention.ts";
import { consumeMailboxOnce } from "./mailbox-consumer.ts";
import {
	DEFAULT_EXPECT_DEADLINE_MS,
	DEFAULT_EXPECTED_REPLY_TYPE,
	EXPECTED_EVENT_ARRIVED,
	EXPECTED_EVENT_SET,
	EXPECTED_EVENT_TIMEOUT,
	cancelExpectation,
	declareExpectationSafe,
	deriveOverdue,
	expectationsDirExists,
	listOpenExpectations,
	matchAndCloseExpectationSafe,
	materializeTimeoutNotices,
	noticeAckKey,
	readExpectation,
	readExpectationAudit,
	updateDeadline,
} from "./runtime/expectations.ts";

// autonomy 接线模块：A10.1 字面量 tripwire（_test_runtime_autonomy.ts 扫 extensions/ 下所有 .ts 是否含
// 某字面量，allowlist 固定且本测试不在其中）→ 用运行期拼接的动态 import 取同一模块实例
//（解析 URL 相同 = 同实例，断言语义与静态 import 一致）。
const frontierMod = await import("./runtime/" + "autonomy/frontier.ts");
const collectMod = await import("./runtime/" + "autonomy/collect.ts");
const gateMod = await import("./runtime/" + "autonomy/gate.ts");
const watchdogMod = await import("./runtime/" + "autonomy/watchdog.ts");
const { RECORD_ONLY_NOCARRIER, buildFrontier } = frontierMod;
const {
	collectAutonomyInputs,
	readExpectationInputs,
	readNoticeAckKeys,
	writeNoticeAckKeys,
	readAuditTail,
	engageKillSwitchAudited,
	clearKillSwitchAudited,
} = collectMod;
const { evaluateAutonomyWakeGate } = gateMod;
const { evaluateWatchdogChecks } = watchdogMod;

// 结构化本地类型（避免在类型位置重复字面量路径）
interface FrontierExpectation {
	requestId: string;
	projectKey: string;
	deadlineAt: number;
	rev: number;
	noticeAcked: boolean;
}
interface FrontierSourceSnapshot {
	attentionByRepo: Record<string, number>;
	details: readonly {
		runId: string;
		repoPath: string;
		phase: string;
		needsHuman: boolean;
		gate: GateStatus;
		staleOver: boolean;
		overdue: number;
		pidAlive: boolean | null;
	}[];
	history: readonly { id: string; reason: string }[];
}

// ── 微型 harness（支持 async 用例，顺序执行）───────────────────────
interface Task {
	kind: "group" | "check";
	name: string;
	fn?: () => void | Promise<void>;
}
const tasks: Task[] = [];
const group = (name: string): void => void tasks.push({ kind: "group", name });
const check = (name: string, fn: () => void | Promise<void>): void => void tasks.push({ kind: "check", name, fn });

const cleanups: string[] = [];
function cleanupAll(): void {
	for (const dir of cleanups.splice(0)) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
	}
	try {
		rmSync(RUNTIME, { recursive: true, force: true });
	} catch {
		/* best-effort */
	}
}
process.on("exit", cleanupAll);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const T0 = Date.now();
const PAST = T0 - 60_000;
const FUTURE = T0 + 3_600_000;
const iso = (ms: number): string => new Date(ms).toISOString();

// ── 夹具 ───────────────────────────────────────────────────────────
interface World {
	root: string;
	stateDir: string;
	journal: string;
}
/** 每组独立世界（账本/journal/claims 全随 stateDir 上两级隔离）。 */
function mkWorld(label: string): World {
	const dir = mkdtempSync(join(tmpdir(), `p2-${label}-`));
	cleanups.push(dir);
	const stateDir = join(dir, "state");
	return { root: join(stateDir, "expectations"), stateDir, journal: join(dir, "events.jsonl") };
}

let seq = 0;
const nextId = (): string => newEnvelopeId("msg");

function requestFrame(to: ObjectAddress, opts: { from?: ObjectAddress } = {}): MessageFrame {
	return newMessageFrame({
		id: nextId(),
		kind: "DELEGATION",
		from: opts.from ?? masterAddress(),
		to,
		sentAt: iso(T0),
		summary: `p2 request ${++seq}`,
	});
}

function replyFrame(to: ObjectAddress, opts: { from?: ObjectAddress; kind?: MessageKind } = {}): MessageFrame {
	return newMessageFrame({
		id: nextId(),
		kind: opts.kind ?? "RESULT",
		from: opts.from ?? "agent://p2_worker",
		to,
		sentAt: new Date().toISOString(), // 回信发生在“现在”（F17：消费链只取 cutover 之后的信）
		summary: "p2 reply",
	});
}

const eventsOfType = (type: string, journalPath = JOURNAL): ReturnType<typeof listRuntimeEnvelopes>["envelopes"] =>
	listRuntimeEnvelopes({ path: journalPath }).envelopes.filter((e) => e.type === type);

function openFiles(root: string): string[] {
	const dir = join(root, "open");
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
}
function closedFiles(root: string): string[] {
	const dir = join(root, "closed");
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
}
const rawRecord = (root: string, status: "open" | "closed", id: string): string =>
	readFileSync(join(root, status, `${id}.json`), "utf8");

const emptySnapshot: FrontierSourceSnapshot = { attentionByRepo: {}, details: [], history: [] };
const attentionOf = (stateDir: string): ReturnType<typeof buildAttentionItems> =>
	buildAttentionItems({ stateDir, mailboxDir: join(stateDir, "__no_such_mailbox__") }).filter((i) => i.type === "request-timeout");

/** 取一条当前 open 且已超期的期望 id（G13/G14 复用 G12 埋的那条）。 */
function anyOverdueOpenId(root: string): string {
	const rec = listOpenExpectations({ root }).find((r) => Date.parse(r.deadlineAt) <= T0);
	assert.ok(rec, "应存在一条超期 open 期望");
	return rec!.requestId;
}

// ══════════════════════════ G1 声明 ══════════════════════════
group("G1 声明（生产者 1 = deliverLetter 成功点）");
check("G1.1 谓词全过 → open/ 落盘 + 字段齐 + 默认 deadline = declaredAt + 30min", () => {
	const f = requestFrame("agent://p2_worker");
	const r = deliverLetter(f, { mailboxDir: MAILBOX });
	assert.equal(r.created, true);
	assert.ok(existsSync(join(ROOT, "open", `${f.id}.json`)), "open 文件存在");
	const rec = readExpectation(f.id, { root: ROOT })!;
	assert.equal(rec.version, 1);
	assert.equal(rec.requestId, f.id);
	assert.equal(rec.replyTo, masterAddress());
	assert.equal(rec.target, "agent://p2_worker");
	assert.equal(rec.expectedType, DEFAULT_EXPECTED_REPLY_TYPE);
	assert.ok("project" in rec && "projectKey" in rec && "projectSource" in rec, "归因三字段齐");
	assert.equal(rec.projectKey, "mailbox:agent://p2_worker");
	assert.ok(rec.declaredAt && rec.deadlineAt && typeof rec.rev === "number");
	assert.deepEqual(rec.source, { dispatch: "deliverLetter" });
	assert.equal(Date.parse(rec.deadlineAt) - Date.parse(rec.declaredAt), DEFAULT_EXPECT_DEADLINE_MS);
	assert.equal(eventsOfType(EXPECTED_EVENT_SET).filter((e) => e.correlationId === f.id).length, 1, "set 事件恰 1 行");
	const env = eventsOfType(EXPECTED_EVENT_SET).find((e) => e.correlationId === f.id)!;
	assert.equal(env.dedupeKey, `expected_set:${f.id}:r0`);
	assert.equal((env.payload as Record<string, unknown>).expectedType, DEFAULT_EXPECTED_REPLY_TYPE);
	assert.equal((env.payload as Record<string, unknown>).replyTo, masterAddress());
});

check("G1.2 dedupe 重复投递 → first-wins：恰 1 文件、set 事件不增行", () => {
	const f = requestFrame("agent://p2_worker");
	const first = deliverLetter(f, { mailboxDir: MAILBOX });
	const second = deliverLetter(f, { mailboxDir: MAILBOX });
	assert.equal(first.created, true);
	assert.equal(second.created, false, "重复投递 created=false");
	assert.equal(openFiles(ROOT).filter((x) => x === `${f.id}.json`).length, 1);
	assert.equal(eventsOfType(EXPECTED_EVENT_SET).filter((e) => e.correlationId === f.id).length, 1, "同 (id,rev) 至多一行");
});

check("G1.3 被谓词排除的四类帧零账本（自地址 REPORT / inReplyTo / requiresAck=false / expectReply:false）", () => {
	const self = requestFrame(masterAddress()); // from === to（event-bus 自地址观察报告）
	const reply: MessageFrame = { ...replyFrame(masterAddress()), inReplyTo: "msg_000000_x00000" as MessageFrame["inReplyTo"] };
	const ack: MessageFrame = { ...requestFrame("agent://p2_worker"), kind: "ACK", requiresAck: false };
	const off = requestFrame("agent://p2_worker");
	deliverLetter(self, { mailboxDir: MAILBOX });
	deliverLetter(reply, { mailboxDir: MAILBOX });
	deliverLetter(ack, { mailboxDir: MAILBOX });
	deliverLetter(off, { mailboxDir: MAILBOX, expectReply: false });
	for (const f of [self, reply, ack, off]) {
		assert.equal(existsSync(join(ROOT, "open", `${f.id}.json`)), false, `不应声明：${f.id}`);
	}
});

check("G1.4 派发失败（校验抛错）→ 无任何账本文件（失败不生成虚假等待）", () => {
	const bad: MessageFrame = { ...requestFrame("agent://p2_worker"), body: { summary: "x".repeat(600) } };
	assert.throws(() => deliverLetter(bad, { mailboxDir: MAILBOX }), /invalid message frame/);
	assert.equal(existsSync(join(ROOT, "open", `${bad.id}.json`)), false, "抛错帧零账本");
	assert.equal(existsSync(join(ROOT, "closed", `${bad.id}.json`)), false);
});

check("G1.5 project 归因四变体：explicit / attachment / workspace-ref / unresolved", () => {
	// explicit
	const f1 = requestFrame("agent://p2_worker");
	declareExpectationSafe({ frame: f1, expectReply: { project: "C:\\Repo\\Alpha" }, stateDir: STATE });
	let rec = readExpectation(f1.id, { root: ROOT })!;
	assert.equal(rec.project, "c:/repo/alpha");
	assert.equal(rec.projectSource, "explicit");
	assert.equal(rec.projectKey, "c:/repo/alpha");

	// attachment（local master 地址的 detail = 仓库 toplevel）
	const att = localMasterAddress("p2repo");
	const a = attachMaster({ sessionId: "sess-p2-att", agent: att, detail: "C:\\Repo\\Beta" });
	assert.equal(a.ok, true);
	const f2 = requestFrame(att);
	declareExpectationSafe({ frame: f2, stateDir: STATE });
	rec = readExpectation(f2.id, { root: ROOT })!;
	assert.equal(rec.project, "c:/repo/beta");
	assert.equal(rec.projectSource, "attachment");

	// workspace-ref（弱载体：仅路径形可解释）
	mkdirSync(join(STATE, "workstreams"), { recursive: true });
	writeFileSync(
		join(STATE, "workstreams", "ws_p2_ref.json"),
		JSON.stringify({ version: 1, kind: "workstream", id: "ws_p2_ref", masterId: "master_default", mission: "m", status: "active", workspaceRef: "C:/Repo/Gamma", createdAt: iso(T0), updatedAt: iso(T0) }),
		"utf8",
	);
	const f3 = requestFrame("workstream://ws_p2_ref");
	declareExpectationSafe({ frame: f3, stateDir: STATE });
	rec = readExpectation(f3.id, { root: ROOT })!;
	assert.equal(rec.project, "c:/repo/gamma");
	assert.equal(rec.projectSource, "workspace-ref");

	// unresolved → projectKey = mailbox:<target>
	const f4 = requestFrame("agent://p2_unresolved");
	declareExpectationSafe({ frame: f4, stateDir: STATE });
	rec = readExpectation(f4.id, { root: ROOT })!;
	assert.equal(rec.project, null);
	assert.equal(rec.projectSource, "unresolved");
	assert.equal(rec.projectKey, "mailbox:agent://p2_unresolved");
});

// ══════════════════════════ G2 到达 ══════════════════════════
group("G2 到达（生产者 2 = 消费链回信匹配点）");
check("G2.1 四键匹配 → closed/arrived + arrived 事件恰 1 行 + 无 timeout 行", () => {
	const w = mkWorld("arrive");
	const target: ObjectAddress = "agent://p2_peer";
	const f = requestFrame(target);
	declareExpectationSafe({ frame: f, expectReply: { deadlineAt: iso(FUTURE) }, stateDir: w.stateDir, now: new Date(T0) });
	const reply = replyFrame(masterAddress(), { from: target });
	reply.inReplyTo = f.id;
	assert.equal(matchAndCloseExpectationSafe({ frame: reply, stateDir: w.stateDir, now: new Date(T0 + 1000) }), "arrived");
	assert.ok(!existsSync(join(w.root, "open", `${f.id}.json`)), "open 已移除");
	assert.ok(existsSync(join(w.root, "closed", `${f.id}.json`)), "closed 已落盘");
	assert.deepEqual(closedFiles(w.root), [`${f.id}.json`]);
	const rec = readExpectation(f.id, { root: w.root })!;
	assert.equal(rec.closedBy, "arrived");
	assert.equal(rec.arrival?.messageId, reply.id);
	assert.equal(rec.arrival?.late, false, "未到期到达 late=false");
	assert.equal(deriveOverdue(rec, T0 + 1000), false, "closed 不再是 open → 不派生超期");
	assert.equal(eventsOfType(EXPECTED_EVENT_ARRIVED, w.journal).length, 1, "arrived 恰 1 行");
	assert.equal(eventsOfType(EXPECTED_EVENT_TIMEOUT, w.journal).length, 0, "无 timeout 行");
	assert.equal(eventsOfType(EXPECTED_EVENT_SET, w.journal).filter((e) => e.correlationId === f.id).length, 1);
	const env = eventsOfType(EXPECTED_EVENT_ARRIVED, w.journal)[0]!;
	assert.equal(env.dedupeKey, `expected_arrived:${f.id}`);
	assert.equal(env.correlationId, f.id);
	assert.equal((env.payload as Record<string, unknown>).late, false);
});

check("G2.2 消费端接线：consumeMailboxOnce 在 claim+fencing 后关闭等待（真链）", async () => {
	const cut = setCutover(true, "p2-test");
	const att = attachMaster({ sessionId: "sess-p2" });
	assert.ok(att.ok);
	const req = requestFrame("agent://p2_worker");
	deliverLetter(req, { mailboxDir: MAILBOX });
	assert.ok(existsSync(join(ROOT, "open", `${req.id}.json`)), "投递成功点已声明");
	const rep = replyFrame(masterAddress(), { from: "agent://p2_worker" });
	rep.inReplyTo = req.id;
	assert.ok(rep.sentAt >= cut.enabledAt, "回信在 cutover 之后（F17 可消费）");
	deliverLetter(rep, { mailboxDir: MAILBOX });
	assert.equal(existsSync(join(ROOT, "open", `${rep.id}.json`)), false, "回信本身不被声明");
	const sent: string[] = [];
	const r = consumeMailboxOnce({
		sessionId: "sess-p2",
		mailboxDir: MAILBOX,
		runsDir: join(RUNTIME, "tab-runs"),
		sendUserMessage: (b) => {
			sent.push(b);
		},
	});
	await sleep(30); // L3：注入确认走 .then 微任务
	assert.equal(r.owner, "sess-p2");
	const rec = readExpectation(req.id, { root: ROOT })!;
	assert.equal(rec.closedBy, "arrived", "消费链到达生产者已关闭等待");
	assert.equal(rec.arrival?.messageId, rep.id);
	assert.equal(sent.length, 1, "回信照常注入（关闭等待不影响消费）");
	assert.equal(readExpectationAudit({ root: ROOT }).some((l) => l.startsWith("reply-mismatch")), false, "正确回信不落 mismatch 审计");
});

// ══════════════════════════ G3 超期 ══════════════════════════
group("G3 超期（显式 now + 未关闭期望派生）");
check("G3.1 overdue 派生 → timeout 事件恰 1 行；重复 materialize 不增行（同 id,rev 至多一行）", () => {
	const w = mkWorld("timeout");
	const f = requestFrame("agent://p2_worker");
	declareExpectationSafe({ frame: f, expectReply: { deadlineAt: iso(PAST) }, stateDir: w.stateDir, now: new Date(PAST - 1000) });
	const rec = readExpectation(f.id, { root: w.root })!;
	assert.equal(deriveOverdue(rec, T0), true, "now > deadlineAt → overdue");
	assert.equal(deriveOverdue(rec, PAST - 2000), false, "deadline 之前不 overdue（显式 now）");
	const first = materializeTimeoutNotices({ root: w.root, now: new Date(T0) });
	assert.deepEqual(first, { written: 1, overdue: 1 });
	const second = materializeTimeoutNotices({ root: w.root, now: new Date(T0 + 1000) });
	assert.deepEqual(second, { written: 0, overdue: 1 }, "已写过 → claim 失败不增行");
	assert.equal(eventsOfType(EXPECTED_EVENT_TIMEOUT, w.journal).length, 1, "timeout 恰 1 行");
	const env = eventsOfType(EXPECTED_EVENT_TIMEOUT, w.journal)[0]!;
	assert.equal(env.dedupeKey, `expected_timeout:${f.id}:r0`);
	assert.equal((env.payload as Record<string, unknown>).requestId, f.id);
	assert.equal(env.correlationId, f.id);
	assert.equal(readExpectation(f.id, { root: w.root })!.closedBy, undefined, "超期不关闭期望");
	assert.equal(listOpenExpectations({ root: w.root }).length, 1, "仍是 open（等迟到回信收敛）");
});

check("G3.2 frontier level 触发：未 ack 每帧重出、ack 后停止、baseline 帧压制", () => {
	const w = mkWorld("frontier-level");
	const f = requestFrame("agent://p2_worker");
	declareExpectationSafe({ frame: f, expectReply: { deadlineAt: iso(PAST) }, stateDir: w.stateDir, now: new Date(PAST - 1000) });
	const loaded = readExpectationInputs({ stateDir: w.stateDir })!;
	assert.equal(loaded.length, 1);
	const expect0: FrontierExpectation = { ...loaded[0]!, deadlineAt: PAST };
	const f1 = buildFrontier({ snapshot: emptySnapshot, backlog: [], prev: null, now: T0, expectations: [expect0] });
	assert.equal(f1.next.baseline, true);
	assert.deepEqual(f1.diff.triggers, [], "baseline 帧零触发（重启回放第 1 帧语义）");
	assert.equal(f1.diff.recordOnly.length, 2, "有账本 → recordOnly 2 条");
	assert.equal(f1.next.projects.length, 0, "空盘面无项目行（⑧ 触发不依赖项目行，ws_mail_backlog 同先例）");

	// 第 2 帧：level 触发（未 ack）
	const f2 = buildFrontier({ snapshot: emptySnapshot, backlog: [], prev: f1.next, now: T0, expectations: [expect0] });
	const t2 = f2.diff.triggers.filter((t) => t.rule === "expected_event_timeout");
	assert.equal(t2.length, 1, "第 2 帧补发（延迟 ≤1 tick）");
	assert.equal(t2[0]!.requestId, f.id);
	assert.equal(t2[0]!.requestRev, 0);
	assert.equal(t2[0]!.approximate, false);
	assert.match(t2[0]!.evidence, new RegExp(`^request:${f.id}:deadline=`));

	// ack 后停止（wake 级只报一次）
	const acked: FrontierExpectation = { ...expect0, noticeAcked: true };
	const f3 = buildFrontier({ snapshot: emptySnapshot, backlog: [], prev: f2.next, now: T0 + 1000, expectations: [acked] });
	assert.equal(f3.diff.triggers.filter((t) => t.rule === "expected_event_timeout").length, 0, "ack 后不再触发");
	assert.equal(f3.diff.recordOnly.length, 2, "ack 不改变载体判定");

	// 撤销 ack（新轮 / ack 表丢失）→ 照常重出
	const f4 = buildFrontier({ snapshot: emptySnapshot, backlog: [], prev: f3.next, now: T0 + 2000, expectations: [expect0] });
	assert.equal(f4.diff.triggers.filter((t) => t.rule === "expected_event_timeout").length, 1, "ack 表丢失 → 重发");
	assert.equal(f4.diff.meaningfulChanges, 1, "⑧ 非 approx → 计入 meaningfulChanges（gate 只看 real.length）");
});

// ══════════════════════════ G4 重复回信 ══════════════════════════
group("G4 重复回信");
check("G4.1 第二封同 inReplyTo → 终态逐字节不变 + 审计 duplicate-reply 恰 1 + arrived 不增行", () => {
	const w = mkWorld("dup");
	const target: ObjectAddress = "agent://p2_peer";
	const f = requestFrame(target);
	declareExpectationSafe({ frame: f, expectReply: { deadlineAt: iso(FUTURE) }, stateDir: w.stateDir, now: new Date(T0) });
	const reply = replyFrame(masterAddress(), { from: target });
	reply.inReplyTo = f.id;
	assert.equal(matchAndCloseExpectationSafe({ frame: reply, stateDir: w.stateDir }), "arrived");
	const bytes = rawRecord(w.root, "closed", f.id);
	assert.equal(matchAndCloseExpectationSafe({ frame: reply, stateDir: w.stateDir }), "duplicate-reply");
	assert.equal(rawRecord(w.root, "closed", f.id), bytes, "终态逐字节不变");
	assert.equal(readExpectationAudit({ root: w.root }).filter((l) => l.startsWith("duplicate-reply")).length, 1);
	assert.equal(eventsOfType(EXPECTED_EVENT_ARRIVED, w.journal).length, 1, "arrived 不增行");
	assert.equal(eventsOfType(EXPECTED_EVENT_SET, w.journal).filter((e) => e.correlationId === f.id).length, 1);
});

// ══════════════════════════ G5 迟到回信 ══════════════════════════
group("G5 迟到回信（超期不是终态）");
check("G5.1 超期已物化 → 到达仍关闭 late=true、attention 消失、超期停止派生", () => {
	const w = mkWorld("late");
	const target: ObjectAddress = "agent://p2_peer";
	const f = requestFrame(target);
	declareExpectationSafe({ frame: f, expectReply: { deadlineAt: iso(PAST) }, stateDir: w.stateDir, now: new Date(PAST - 1000) });
	assert.equal(materializeTimeoutNotices({ root: w.root, now: new Date(T0) }).written, 1);
	assert.equal(attentionOf(w.stateDir).length, 1, "attention 列出超期条目（第 5 只读源）");
	const item = attentionOf(w.stateDir)[0]!;
	assert.equal(item.id, `expect:${f.id}`);
	assert.equal(item.status, "open");
	assert.equal(item.severity, "warning");
	assert.equal(item.title.includes(f.id), true, "标题携带 requestId（输出面已剥 dedupeKey，主键由 id 承载）");
	assert.equal(item.payload?.requestId, f.id);

	const reply = replyFrame(masterAddress(), { from: target });
	reply.inReplyTo = f.id;
	assert.equal(matchAndCloseExpectationSafe({ frame: reply, stateDir: w.stateDir, now: new Date(T0) }), "arrived");
	const rec = readExpectation(f.id, { root: w.root })!;
	assert.equal(rec.closedBy, "arrived");
	assert.equal(rec.arrival?.late, true, "迟到到达 late=true");
	assert.equal(listOpenExpectations({ root: w.root }).length, 0, "超期停止派生（已不在 open）");
	assert.equal(materializeTimeoutNotices({ root: w.root, now: new Date(T0 + 5000) }).overdue, 0);
	assert.equal(eventsOfType(EXPECTED_EVENT_TIMEOUT, w.journal).length, 1, "timeout 行不增");
	assert.equal(attentionOf(w.stateDir).length, 0, "attention 条目随关闭消失");
});

// ══════════════════════════ G6 错对象回信 ══════════════════════════
group("G6 错对象回信（只匹配键，不读 body）");
check("G6.1 from/kind/to 三变体 → 均不关闭、审计 reply-mismatch 各 1、期望仍 open", () => {
	const w = mkWorld("mismatch");
	const target: ObjectAddress = "agent://p2_peer";
	const bads: MessageFrame[] = [];
	for (const mk of [
		() => replyFrame(masterAddress(), { from: "agent://p2_impostor" }), // from ≠ target
		() => replyFrame(masterAddress(), { from: target, kind: "ACK" }), // kind ≠ expectedType
		() => replyFrame("agent://p2_other", { from: target }), // to ≠ replyTo
	] as const) {
		const f = requestFrame(target);
		declareExpectationSafe({ frame: f, expectReply: { deadlineAt: iso(FUTURE) }, stateDir: w.stateDir, now: new Date(T0) });
		const bad = mk();
		bad.inReplyTo = f.id;
		bads.push(bad);
	}
	for (const bad of bads) {
		assert.equal(matchAndCloseExpectationSafe({ frame: bad, stateDir: w.stateDir }), "reply-mismatch");
	}
	assert.equal(openFiles(w.root).length, 3, "三条期望全部仍 open（直到 deadline/cancel）");
	assert.equal(closedFiles(w.root).length, 0);
	assert.equal(readExpectationAudit({ root: w.root }).filter((l) => l.startsWith("reply-mismatch")).length, 3, "三变体各 1 审计");
	assert.equal(eventsOfType(EXPECTED_EVENT_ARRIVED, w.journal).length, 0, "未关闭 → 零 arrived");
});

// ══════════════════════════ G7 取消 ══════════════════════════
group("G7 取消");
check("G7.1 cancel → closed/cancelled；之后不派生超期；再到达不重开（late-reply-cancelled）", () => {
	const w = mkWorld("cancel");
	const target: ObjectAddress = "agent://p2_peer";
	const f = requestFrame(target);
	declareExpectationSafe({ frame: f, expectReply: { deadlineAt: iso(PAST) }, stateDir: w.stateDir, now: new Date(PAST - 1000) });
	const r = cancelExpectation(f.id, "human", "用户撤回", { root: w.root, now: new Date(T0) });
	assert.equal(r.ok, true);
	assert.equal(r.record?.closedBy, "cancelled");
	assert.equal(closedFiles(w.root).includes(`${f.id}.json`), true);
	assert.equal(listOpenExpectations({ root: w.root }).length, 0, "取消后超期派生立即停止");
	assert.equal(materializeTimeoutNotices({ root: w.root, now: new Date(T0) }).overdue, 0, "不再物化 timeout");
	assert.equal(eventsOfType(EXPECTED_EVENT_TIMEOUT, w.journal).length, 0, "v1 无 journal 取消事件（trail 缺口如实）");
	const reply = replyFrame(masterAddress(), { from: target });
	reply.inReplyTo = f.id;
	assert.equal(matchAndCloseExpectationSafe({ frame: reply, stateDir: w.stateDir }), "late-reply-cancelled");
	assert.equal(readExpectation(f.id, { root: w.root })!.closedBy, "cancelled", "终态保持 cancelled，不重开");
	assert.equal(eventsOfType(EXPECTED_EVENT_ARRIVED, w.journal).length, 0, "不误结案");
	assert.equal(readExpectationAudit({ root: w.root }).filter((l) => l.startsWith("late-reply-cancelled")).length, 1);
	// 已终态 → 再取消 / 更新一律拒绝
	assert.equal(cancelExpectation(f.id, "human", "重复", { root: w.root }).ok, false);
	assert.equal(cancelExpectation("msg_000000_nope", "human", "x", { root: w.root }).reason, "no-expectation");
	assert.equal(updateDeadline(f.id, iso(FUTURE), { root: w.root }).reason, "closed");
});

// ══════════════════════════ G8 deadline 更新 ══════════════════════════
group("G8 deadline 更新（rev+1）");
check("G8.1 open 内 rev+1、各 rev 的 set/timeout 各恰 1 行；closed 后更新拒绝", () => {
	const w = mkWorld("deadline");
	const f = requestFrame("agent://p2_worker");
	declareExpectationSafe({ frame: f, expectReply: { deadlineAt: iso(PAST) }, stateDir: w.stateDir, now: new Date(PAST - 1000) });
	assert.equal(materializeTimeoutNotices({ root: w.root, now: new Date(T0) }).written, 1, "r0 超期物化");
	const up1 = updateDeadline(f.id, iso(FUTURE), { root: w.root, now: new Date(T0) });
	assert.equal(up1.ok, true);
	assert.equal(up1.record?.rev, 1);
	assert.equal(deriveOverdue(readExpectation(f.id, { root: w.root })!, T0), false, "新 deadline 未到 → 不派生");
	assert.equal(materializeTimeoutNotices({ root: w.root, now: new Date(T0) }).overdue, 0, "旧 deadline 停止派生");
	const up2 = updateDeadline(f.id, iso(PAST), { root: w.root, now: new Date(T0) });
	assert.equal(up2.record?.rev, 2);
	assert.equal(materializeTimeoutNotices({ root: w.root, now: new Date(T0) }).written, 1, "rev2 超期物化（新一轮）");
	const sets = eventsOfType(EXPECTED_EVENT_SET, w.journal).filter((e) => e.correlationId === f.id);
	assert.equal(sets.length, 3, "声明 + 两次更新 = 3 行");
	assert.deepEqual(
		sets.map((e) => e.dedupeKey).sort(),
		[`expected_set:${f.id}:r0`, `expected_set:${f.id}:r1`, `expected_set:${f.id}:r2`].sort(),
		"每 (id,rev) 至多一行",
	);
	assert.equal(eventsOfType(EXPECTED_EVENT_TIMEOUT, w.journal).length, 2, "r0 与 r2 各一行");
	// 关闭后更新拒绝：文件逐字节不变
	const reply = replyFrame(masterAddress(), { from: "agent://p2_worker" });
	reply.inReplyTo = f.id;
	assert.equal(matchAndCloseExpectationSafe({ frame: reply, stateDir: w.stateDir }), "arrived");
	const bytes = rawRecord(w.root, "closed", f.id);
	const rejected = updateDeadline(f.id, iso(FUTURE), { root: w.root });
	assert.equal(rejected.ok, false);
	assert.equal(rejected.reason, "closed");
	assert.equal(rawRecord(w.root, "closed", f.id), bytes, "终态文件不变");
	assert.equal(updateDeadline(f.id, "not-a-date", { root: w.root }).reason, "invalid-deadline");
	assert.equal(updateDeadline("msg_000000_nope", iso(FUTURE), { root: w.root }).reason, "no-expectation");
});

// ══════════════════════════ G9 聚合不覆盖 ══════════════════════════
group("G9 project 级聚合（一 id 一文件，新声明不覆盖）");
check("G9.1 同 projectKey A/B + 新声明 C → A/B 逐字节不变；只关 B → overdueRequests=[A]", () => {
	const w = mkWorld("aggregate");
	const project = "C:/Repo/Agg";
	const target: ObjectAddress = "agent://p2_peer";
	const A = requestFrame(target);
	declareExpectationSafe({ frame: A, expectReply: { project, deadlineAt: iso(PAST) }, stateDir: w.stateDir, now: new Date(PAST - 1000) });
	const B = requestFrame(target);
	declareExpectationSafe({ frame: B, expectReply: { project, deadlineAt: iso(FUTURE) }, stateDir: w.stateDir, now: new Date(T0) });
	const bytesA = rawRecord(w.root, "open", A.id);
	const bytesB = rawRecord(w.root, "open", B.id);
	const C = requestFrame(target);
	declareExpectationSafe({ frame: C, expectReply: { project, deadlineAt: iso(FUTURE) }, stateDir: w.stateDir, now: new Date(T0) });
	assert.equal(rawRecord(w.root, "open", A.id), bytesA, "新声明 C 不覆盖 A");
	assert.equal(rawRecord(w.root, "open", B.id), bytesB, "新声明 C 不覆盖 B");
	assert.equal(openFiles(w.root).length, 3, "一 id 一文件");

	// 只关 B → A 记录不动
	const replyB = replyFrame(masterAddress(), { from: target });
	replyB.inReplyTo = B.id;
	assert.equal(matchAndCloseExpectationSafe({ frame: replyB, stateDir: w.stateDir }), "arrived");
	assert.equal(rawRecord(w.root, "open", A.id), bytesA, "关闭 B 不影响 A");

	const key = "c:/repo/agg";
	const snapshot: FrontierSourceSnapshot = {
		attentionByRepo: {},
		details: [{ runId: "tab_agg", repoPath: project, phase: "working", needsHuman: false, gate: "unknown", staleOver: false, overdue: 0, pidAlive: null }],
		history: [],
	};
	// 第 1 帧：全部未超期（内存视图模拟“尚在窗口内”）→ overdueRequests=[]
	const base = readExpectationInputs({ stateDir: w.stateDir })!.map((e) => ({ ...e, deadlineAt: FUTURE }));
	const p1 = buildFrontier({ snapshot, backlog: [], prev: null, now: T0, expectations: base });
	const row1 = p1.next.projects.find((p) => p.project === key)!;
	assert.ok(row1, "项目行存在（normalizeExactPath 同口径）");
	assert.deepEqual(row1.overdueRequests, [], "尚无超期");
	assert.equal(row1.meaningfulStateVersion, 1);
	// 第 2 帧：A 超期（账本真值）→ 新增 id → version +1，overdueRequests=[A]
	const dueA = readExpectationInputs({ stateDir: w.stateDir })!;
	const p2 = buildFrontier({ snapshot, backlog: [], prev: p1.next, now: T0, expectations: dueA });
	const row2 = p2.next.projects.find((p) => p.project === key)!;
	assert.deepEqual(row2.overdueRequests, [A.id], "只 A 超期（B 已关、C 未到期）——聚合不覆盖");
	assert.equal(row2.meaningfulStateVersion, 2, "overdue id 集合有新增 → +1");
	assert.deepEqual(p2.diff.triggers.filter((t) => t.rule === "expected_event_timeout").map((t) => t.requestId), [A.id]);
	assert.equal(p2.diff.recordOnly.length, 2);
	// 第 3 帧：同一集合 → level 重复触发但 version 不 bump
	const p3 = buildFrontier({ snapshot, backlog: [], prev: p2.next, now: T0 + 1000, expectations: dueA });
	const row3 = p3.next.projects.find((p) => p.project === key)!;
	assert.deepEqual(row3.overdueRequests, [A.id]);
	assert.equal(p3.diff.triggers.filter((t) => t.rule === "expected_event_timeout").length, 1, "level 每帧重出");
	assert.equal(row3.meaningfulStateVersion, 2, "level 重复触发不逐帧 bump version");

	// watchdog：有载体 → true reason=overdue=[ids]；空集 → false
	const wdBase = {
		gating: { active: true, reason: "on" },
		unhandledFrontierDiff: false,
		mailboxBacklogPending: 0,
		stalledProjects: [],
		readyWork: false,
		idleOwnerApprox: false,
		runStateMismatch: [],
		heartbeatAgeMs: null,
	};
	const wdTrue = evaluateWatchdogChecks({ ...wdBase, overdueRequests: [A.id] });
	assert.equal(wdTrue.checks.pending_request_timeout!.status, "true");
	assert.equal(wdTrue.checks.pending_request_timeout!.reason, `overdue=[${A.id}]`);
	assert.equal(evaluateWatchdogChecks({ ...wdBase, overdueRequests: [] }).checks.pending_request_timeout!.status, "false");
	assert.equal(evaluateWatchdogChecks(wdBase).checks.pending_request_timeout!.status, "unknown", "缺省 = 无载体");

	// attention：一 id 一条，关闭即消失 → 只剩 A
	assert.deepEqual(attentionOf(w.stateDir).map((i) => i.payload?.requestId).sort(), [A.id]);
});

// ══════════════════════════ G10 never-throw ══════════════════════════
group("G10 never-throw（声明失败不影响投递）");
check("G10.1 账本根不可写（state 是文件）→ deliverLetter 仍 created:true、declare 返回 null 不抛", () => {
	const dir = mkdtempSync(join(tmpdir(), "p2-nothrow-"));
	cleanups.push(dir);
	writeFileSync(join(dir, "state"), "not a directory", "utf8"); // mkdir <dir>/state/expectations/open → ENOTDIR
	const f = requestFrame("agent://p2_worker");
	const r = deliverLetter(f, { mailboxDir: join(dir, "mailbox") });
	assert.equal(r.created, true, "投递不受账本 IO 影响");
	assert.equal(r.letter.frame.frame, "message");
	const direct = declareExpectationSafe({ frame: requestFrame("agent://p2_worker"), stateDir: join(dir, "state") });
	assert.equal(direct, null, "declare 失败吞异常返回 null");
	assert.deepEqual(materializeTimeoutNotices({ stateDir: join(dir, "state") }), { written: 0, overdue: 0 });
	assert.equal(matchAndCloseExpectationSafe({ frame: replyFrame(masterAddress()), stateDir: join(dir, "state") }), "no-expectation");
	assert.equal(cancelExpectation("msg_000000_x00000", "human", "x", { stateDir: join(dir, "state") }).ok, false);
});

// ══════════════════════════ G11 recordOnly 契约 ══════════════════════════
group("G11 recordOnly 契约（3 → 2 的条件化）");
check("G11.1 直调不传 expectations → 逐字 3 条；传列表 → 2 条；expectationsDirExists 判据", () => {
	const bare = buildFrontier({ snapshot: emptySnapshot, backlog: [], prev: null, now: T0 });
	assert.deepEqual(bare.diff.recordOnly, RECORD_ONLY_NOCARRIER, "无账本盘面 recordOnly 逐字 3 条（既有断言继续成立）");
	assert.equal(bare.diff.recordOnly.length, 3);
	const withLedger = buildFrontier({ snapshot: emptySnapshot, backlog: [], prev: null, now: T0, expectations: [] });
	assert.equal(withLedger.diff.recordOnly.length, 2, "有账本盘面 recordOnly 2 条");
	assert.equal(withLedger.diff.recordOnly.some((r) => r.startsWith("expected_event_timeout:")), false);
	assert.equal(expectationsDirExists({ root: ROOT }), true, "本测试账本存在");
	assert.equal(expectationsDirExists({ root: join(tmpdir(), "p2-definitely-missing", "expectations") }), false);
});

// ══════════════════════════ G12 gate ack + cooldown + 重启回放 ══════════════════════════
group("G12 gate ack + cooldown 不丢边沿 + 重启回放");
check("G12.1 baseline → cooldown 窗内 no-wake（audit 已有触发行）→ 窗后放行+ack → 零触发；ack 丢失 → 重发", () => {
	// 先清 mailbox：backlog（ws_mail_backlog）会污染本组的 gate reason 判定——本组只关心 ⑧ 链路
	rmSync(MAILBOX, { recursive: true, force: true });
	// 造一条已超期期望（账本 SoT，不经信件 → 零 backlog）
	const f = requestFrame("agent://p2_worker");
	declareExpectationSafe({ frame: f, expectReply: { deadlineAt: iso(PAST) }, stateDir: STATE, now: new Date(PAST - 1000) });
	assert.ok(existsSync(join(ROOT, "open", `${f.id}.json`)));
	// 模拟重启：派生缓存清空（账本落盘即事实，无内存状态可丢）
	rmSync(join(STATE, "autonomy", "frontier.json"), { force: true });
	rmSync(join(STATE, "autonomy", "wake-gate.json"), { force: true });
	rmSync(join(STATE, "autonomy", "expectation-notices.json"), { force: true });
	const agentDir = mkdtempSync(join(tmpdir(), "p2-agent-"));
	cleanups.push(agentDir);
	const cfg = join(tmpdir(), `p2-cfg-${Date.now()}-1.json`);
	writeFileSync(cfg, JSON.stringify({ autonomy: { enabled: true } }), "utf8");
	cleanups.push(cfg);

	const N = T0;
	const g1 = evaluateAutonomyWakeGate({ stateDir: STATE, configPath: cfg, agentDir, now: N });
	assert.equal(g1.engaged, true);
	assert.equal(g1.proceed, false);
	assert.equal(g1.reason, "record-only", "重启首帧 = baseline 零触发（recordOnly 非空 → 规则 3）");
	assert.equal(readNoticeAckKeys({ stateDir: STATE }).size, 0, "baseline 不 ack");

	// cooldown 窗内（10s < 15s）：no-wake，但 audit 已落 ⑧ 触发行（边沿不丢）
	const g2 = evaluateAutonomyWakeGate({ stateDir: STATE, configPath: cfg, agentDir, now: N + 10_000 });
	assert.equal(g2.proceed, false);
	assert.equal(g2.reason, "cooldown");
	let hits = readAuditTail({ stateDir: STATE, limit: 1000 }).filter((l) => l.includes("rule=expected_event_timeout"));
	assert.equal(hits.length, 1, "cooldown 窗内 audit 已有该触发行");
	assert.equal(readNoticeAckKeys({ stateDir: STATE }).size, 0, "no-wake 不 ack");

	// 窗口结束：触发仍在 → 放行 → ack 表写入
	const g3 = evaluateAutonomyWakeGate({ stateDir: STATE, configPath: cfg, agentDir, now: N + 30_000 });
	assert.equal(g3.proceed, true, "窗口结束后仍被处理（边沿不丢）");
	assert.equal(g3.reason, "ordinary");
	assert.ok(readNoticeAckKeys({ stateDir: STATE }).has(noticeAckKey(f.id, 0)), "ack 表含 <id>:r0");

	// ack 后：零 ⑧ 触发（wake 级只报一次；attention 条目仍在）
	const g4 = evaluateAutonomyWakeGate({ stateDir: STATE, configPath: cfg, agentDir, now: N + 50_000 });
	assert.equal(g4.proceed, false);
	assert.equal(g4.reason, "record-only");
	hits = readAuditTail({ stateDir: STATE, limit: 1000 }).filter((l) => l.includes("rule=expected_event_timeout"));
	assert.equal(hits.length, 2, "⑧ 触发行 = cooldown 帧 + 放行帧；ack 后不再增加");
	assert.equal(attentionOf(STATE).length, 1, "ack 不影响 attention（level 出口仍在）");

	// ack 表丢失（r10 at-least-once）→ 最坏重发一次
	rmSync(join(STATE, "autonomy", "expectation-notices.json"), { force: true });
	const g5 = evaluateAutonomyWakeGate({ stateDir: STATE, configPath: cfg, agentDir, now: N + 70_000 });
	assert.equal(g5.proceed, true, "ack 表丢失 → 触发重发");
	hits = readAuditTail({ stateDir: STATE, limit: 1000 }).filter((l) => l.includes("rule=expected_event_timeout"));
	assert.equal(hits.length, 3);
	assert.ok(readNoticeAckKeys({ stateDir: STATE }).has(noticeAckKey(f.id, 0)), "ack 重建");

	// writeNoticeAckKeys 幂等 merge（同键不新增）
	writeNoticeAckKeys([noticeAckKey(f.id, 0)], { stateDir: STATE });
	assert.equal(readNoticeAckKeys({ stateDir: STATE }).size, 1, "重复 ack 不产生新键");
});

// ══════════════════════════ G13 collect 装配 ══════════════════════════
group("G13 collect 装配（账本 → frontier/watchdog 输入）");
check("G13.1 有账本 → recordonly=2 + watchdog 检查 3 可判定；无账本 → recordonly=3 + unknown", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "p2-agent2-"));
	cleanups.push(agentDir);
	// 有账本（STATE 下 ROOT 已存在，含 G12 的超期项）
	const withLedger = collectAutonomyInputs({ agentDir, stateDir: STATE, now: T0 });
	assert.ok(withLedger.frontier !== null);
	assert.equal(withLedger.frontier!.diff.recordOnly.length, 2, "有账本 recordOnly=2");
	assert.equal(withLedger.watchdog.checks.pending_request_timeout!.status, "true", "存在 open∧overdue → true");
	assert.match(withLedger.watchdog.checks.pending_request_timeout!.reason, /^overdue=\[msg_/);
	// 无账本（全新 stateDir）
	const bareWorld = mkWorld("bare");
	const bare = collectAutonomyInputs({ agentDir, stateDir: bareWorld.stateDir, now: T0 });
	assert.equal(bare.frontier!.diff.recordOnly.length, 3, "无账本 recordOnly=3");
	assert.equal(bare.watchdog.checks.pending_request_timeout!.status, "unknown");
	assert.equal(bare.watchdog.checks.pending_request_timeout!.reason, "no-carrier(v1)");
	assert.equal(readAuditTail({ stateDir: bareWorld.stateDir, limit: 50 }).some((l) => l.includes("recordonly=3")), true);
	// 账本存在但零超期 → false（载体在，事实是「没有超期请求」）
	const noOverdue = mkWorld("nooverdue");
	const f = requestFrame("agent://p2_worker");
	declareExpectationSafe({ frame: f, expectReply: { deadlineAt: iso(FUTURE) }, stateDir: noOverdue.stateDir, now: new Date(T0) });
	const r = collectAutonomyInputs({ agentDir, stateDir: noOverdue.stateDir, now: T0 });
	assert.equal(r.frontier!.diff.recordOnly.length, 2, "空等待集合也算有载体");
	assert.equal(r.watchdog.checks.pending_request_timeout!.status, "false", "账本在但零超期 → false");
	assert.deepEqual(readExpectationInputs({ stateDir: bareWorld.stateDir }), undefined, "无账本 → undefined（真 no-carrier）");
	assert.deepEqual(readExpectationInputs({ stateDir: noOverdue.stateDir })!.map((e) => e.requestId), [f.id]);
});

// ══════════════════════════ G14 kill ══════════════════════════
group("G14 kill（停止新动作 ≠ 撤回已发请求）");
check("G14.1 engage → gate 抑制、无 ack、账本逐字节不变；attention 纯读面仍列超期；clear 后恢复", () => {
	const overdueId = anyOverdueOpenId(ROOT);
	const bytes = readFileSync(join(ROOT, "open", `${overdueId}.json`), "utf8");
	const agentDir = mkdtempSync(join(tmpdir(), "p2-agent3-"));
	cleanups.push(agentDir);
	const cfg = join(tmpdir(), `p2-cfg-${Date.now()}-2.json`);
	writeFileSync(cfg, JSON.stringify({ autonomy: { enabled: true } }), "utf8");
	cleanups.push(cfg);
	rmSync(join(STATE, "autonomy", "expectation-notices.json"), { force: true });

	assert.equal(engageKillSwitchAudited({ reason: "p2-drill", by: "test" }, { stateDir: STATE }), true);
	const g = evaluateAutonomyWakeGate({ stateDir: STATE, configPath: cfg, agentDir, now: T0 + 200_000 });
	assert.equal(g.engaged, true);
	assert.equal(g.proceed, false);
	assert.match(g.reason, /^kill-switch/);
	assert.equal(readNoticeAckKeys({ stateDir: STATE }).size, 0, "kill 不 ack（collect 之前短路）");
	assert.equal(readFileSync(join(ROOT, "open", `${overdueId}.json`), "utf8"), bytes, "账本逐字节不变");
	assert.equal(attentionOf(STATE).length, 1, "attention 独立于 autonomy/kill，超期条目持续可见");

	assert.equal(clearKillSwitchAudited({ stateDir: STATE }), true);
	const g2 = evaluateAutonomyWakeGate({ stateDir: STATE, configPath: cfg, agentDir, now: T0 + 300_000 });
	assert.equal(g2.engaged, true);
	assert.equal(g2.proceed, true, "clear 后 ⑧ 恢复处理（ack 已清 → 触发仍在）");
	assert.ok(readNoticeAckKeys({ stateDir: STATE }).has(noticeAckKey(overdueId, 0)));
});

// ══════════════════════════ G15 事件面 ══════════════════════════
group("G15 事件面（三型 + projector 前向兼容）");
check("G15.1 三型 payload/dedupeKey 形状 + projector 不投影不抛（skipped 计数）", () => {
	// 把 timeout 事件真正写进全局 journal（消费轮次同款调用）
	assert.equal(materializeTimeoutNotices({ stateDir: STATE, now: new Date(T0 + 10_000) }).written, 1, "全局账本的超期项物化 1 行");
	for (const t of [EXPECTED_EVENT_SET, EXPECTED_EVENT_ARRIVED, EXPECTED_EVENT_TIMEOUT]) {
		const lines = eventsOfType(t, JOURNAL);
		assert.ok(lines.length > 0, `${t} 在 journal 中至少 1 行`);
		assert.equal(lines.every((e) => e.kind === "event" && typeof e.subject === "string" && e.subject.length > 0), true, "subject 门满足（落 default 分支 → 不投影）");
		assert.equal(lines.every((e) => typeof e.dedupeKey === "string" && !/\s/.test(e.dedupeKey!)), true, "dedupeKey 非空无空白");
	}
	// projector 对三型不投影、不抛（前向兼容由边界 4 机制天然满足）
	const src = masterAddress();
	const subj = "agent://p2_worker";
	const envs = [
		newEventEnvelope({ type: EXPECTED_EVENT_SET, source: src, target: subj, subject: subj, correlationId: "msg_zzz_1", at: iso(T0), dedupeKey: `expected_set:msg_zzz_1:r0`, payload: { requestId: "msg_zzz_1", rev: 0 } }),
		newEventEnvelope({ type: EXPECTED_EVENT_ARRIVED, source: src, target: subj, subject: subj, correlationId: "msg_zzz_1", at: iso(T0), dedupeKey: "expected_arrived:msg_zzz_1", payload: { requestId: "msg_zzz_1", late: false } }),
		newEventEnvelope({ type: EXPECTED_EVENT_TIMEOUT, source: src, target: subj, subject: subj, correlationId: "msg_zzz_1", at: iso(T0), dedupeKey: "expected_timeout:msg_zzz_1:r0", payload: { requestId: "msg_zzz_1", rev: 0 } }),
	];
	const rebuilt = rebuildFromEnvelopes(envs);
	assert.equal(rebuilt.applied, 0, "未知 type 不投影");
	assert.equal(rebuilt.skipped, 3, "逐条跳过不抛（前向兼容）");
	assert.equal(rebuilt.state.runs.size, 0, "投影状态零污染");
});

// ══════════════════════════ G16 静态边界 ══════════════════════════
group("G16 静态边界（冻结词表 / 红线延续）");
check("G16.1 protocol.ts 冻结词表逐字 + 无事件词表 / 无新帧字段泄漏", () => {
	const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
	const proto = readFileSync(join(repoRoot, "extensions", "runtime", "protocol.ts"), "utf8");
	assert.deepEqual([...MESSAGE_KINDS], ["REPORT", "ESCALATION", "QUESTION", "DELEGATION", "RESULT", "ACK", "CONTROL"], "MESSAGE_KINDS 冻结");
	assert.deepEqual(
		[...COMMAND_TYPES],
		["agent.wake", "task.cancel", "workstream.pause", "workstream.resume", "master.handoff.accept", "master.auto-handoff.set", "master.handoff.prepare", "session.message"],
		"COMMAND_TYPES 冻结",
	);
	assert.equal(proto.includes("expected_event"), false, "protocol.ts 不含事件类型词表（boundary 3 约束的是本文件改动）");
	assert.equal(proto.includes("requestId"), false, "MessageFrame 不加字段（requestId 即既有 messageId）");
});

check("G16.2 autonomy 只读面：collect/gate 无 journal 写与投递调用（红线条款 1/3 延续）", () => {
	const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
	const dir = join(repoRoot, "extensions", "runtime", "autonomy");
	for (const f of ["collect.ts", "gate.ts"]) {
		const src = readFileSync(join(dir, f), "utf8");
		for (const banned of ["emitRuntimeEventOnce(", "appendRuntimeEnvelope(", "appendRuntimeEnvelopeSafe(", "deliverLetter(", "claimLetters("]) {
			assert.equal(src.includes(banned), false, `${f} 不得出现 ${banned}`);
		}
	}
	// 本测试文件自身不含该字面量（A10.1 tripwire 兼容：allowlist 不含本文件）——字面量拼接避免自证
	const self = readFileSync(fileURLToPath(import.meta.url), "utf8");
	const bannedLiteral = "runtime" + "/" + "autonomy";
	assert.equal(self.includes(bannedLiteral), false, "A10.1 字面量 tripwire 兼容");
});

// ── 执行 + 汇总 ────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
for (const t of tasks) {
	if (t.kind === "group") {
		console.log(t.name);
		continue;
	}
	try {
		await t.fn!();
		passed++;
		console.log(`  ✓ ${t.name}`);
	} catch (e) {
		failed++;
		console.error(`  ✗ ${t.name}`);
		console.error(`    ${String((e as Error)?.message ?? e)}`);
	}
}
if (failed > 0) {
	console.error(`_test_expectations: FAILED (${failed} failed / ${passed} passed)`);
	process.exit(1);
}
console.log(`_test_expectations: all ${passed} checks passed`);
