/**
 * _test_runtime_host_projections.ts — G3 测试（runtime-host attention + timeline 投影，
 * plans/0920_G3_attention_plan.md §5 + 主会话拍板①②③：
 * ①同源双条去重（source key 最新胜出）+ resolved 默认过滤（?includeResolved=1 看历史）；
 * ②timeline 仅 limit（默认 200，尾部 N 条 at 升序）；③snapshot.ts 只做加法不收紧类型）
 *
 * 覆盖：
 *   T1 五源逐字段映射（各源隔离 → 1 条，§31 九字段 + 无损 payload；master-attention 原 7 字段全保留）
 *   T2 多源聚合 + 输出序（severity 降 → createdAt 降 → id）
 *   T3 同源双条去重：proposal(failed) 与 attention 共享 transferId → 1 条（createdAt 最新胜出；
 *      同刻同 severity → 先构造者，确定性）；空 transferId → 退回自身 id 不成同源 → 2 条
 *   T4 proposal 7 态逐一：open/resolved 派生 + severity 表 + 默认过滤 + includeResolved 放行
 *   T5 mailbox frame.kind 过滤：ESCALATION/QUESTION 出现；REPORT/RESULT/DELEGATION/ACK 不出现；
 *      claimed 信排除（只 pending）
 *   T6 workstream：blocked 出现；active/waiting/completed 不出现；坏文件跳过不炸
 *   T7 零写盘：构建前后目录树（目录条目 + 文件内容哈希）不变
 *   T8 timeline：at 升序（乱序写入也排正）/ 三类条目齐全 / state: id 与事件不撞 /
 *      人话模板（run·handoff 精修 + 通用兜底）/ 无 raw JSON 泄漏 / enrichment（wake→ws woke、
 *      links→actor）+ 缺席降级 / limit（默认 200 尾部、limit=50、非法值回退）/ 全缺席 → []
 *   T9 双端点契约（随机端口 127.0.0.1）：200 契约字段；?includeResolved=1；?limit=2；
 *      POST→405；未知路径→404；/v1/snapshot attention/timeline 位已填充
 *   T10 S3 OFF 现网常态：master-attention.json 缺席 → runtime-risk 段 [] 无异常；
 *      各源缺失/坏文件 → 两端点 + snapshot 均降级 200 不崩
 *
 * 500 路径说明：两端点 handler 契约 never-throw（每源独立 try/catch 段降级），
 *   onReq 的 catch→500 JSON 与 G2 三端点同形（G2 T10 已锁定该 catch 路径），不重复造故障注入。
 *
 * 运行：npm run test:runtime-host-projections
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

function mkdtempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}
process.env.PI_RUNTIME_DIR = mkdtempDir("runtime-host-proj-env-");

import { buildAttentionItems, type AttentionItem } from "./runtime-host/attention.ts";
import { buildTimelineItems, TIMELINE_DEFAULT_LIMIT, TIMELINE_LIMIT_MAX, type TimelineItem } from "./runtime-host/timeline.ts";
import { buildRuntimeSnapshot } from "./runtime-host/snapshot.ts";
import { createRuntimeHostServer, type RuntimeHostHandle } from "./runtime-host/server.ts";
import { deliverLetter } from "./runtime/mailbox.ts";
import { masterAddress, tabRunAddress } from "./runtime/address.ts";
import { newEnvelopeId } from "./runtime/ids.ts";
import { newEventEnvelope } from "./runtime/envelope.ts";
import { newMessageFrame, type MessageKind } from "./runtime/protocol.ts";

// ── 种子 helpers ───────────────────────────────────────────────────

const T0 = "2026-09-20T10:00:00.000Z";
const at = (min: number): string => new Date(Date.parse(T0) + min * 60000).toISOString();

const DIRS: string[] = [];
const tmp = (prefix: string): string => {
	const d = mkdtempDir(prefix);
	DIRS.push(d);
	return d;
};

function writeJson(p: string, v: unknown): void {
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`, "utf8");
}

function seedAttention(stateDir: string, over: Record<string, unknown> = {}): void {
	writeJson(join(stateDir, "master-attention.json"), [
		{
			id: "attn_1",
			at: at(2),
			kind: "auto-handoff-failed",
			transferId: "tr_1",
			error: "spawn failed",
			generation: 2,
			pressure: 0.8,
			...over,
		},
	]);
}

function seedProposal(stateDir: string, over: Record<string, unknown> = {}): void {
	writeJson(join(stateDir, "master-succession.json"), {
		version: 1,
		proposalId: "hp_test1",
		generation: 2,
		sessionId: "sess-X",
		pressure: 0.76,
		status: "pending",
		proposedAt: at(1),
		...over,
	});
}

function seedWorkstream(stateDir: string, id: string, status: string, updatedAt: string): void {
	writeJson(join(stateDir, "workstreams", `${id}.json`), {
		version: 1,
		kind: "workstream",
		id,
		masterId: "master_default",
		mission: `mission ${id}`,
		status,
		createdAt: updatedAt,
		updatedAt,
	});
}

function deliver(
	mailboxDir: string,
	kind: MessageKind,
	sentAt: string,
	summary = `sum-${kind}`,
	to = masterAddress(),
): string {
	const { letter } = deliverLetter(
		newMessageFrame({
			id: newEnvelopeId("msg"),
			kind,
			from: "agent://worker_a",
			to,
			sentAt,
			summary,
		}),
		{ mailboxDir },
	);
	return letter.frame.frame === "message" ? letter.frame.id : "";
}

function appendEvent(
	journalPath: string,
	type: string,
	over: { subject?: string; at?: string; payload?: unknown } = {},
): string {
	const env = newEventEnvelope({
		type,
		source: masterAddress(),
		subject: over.subject,
		at: over.at ?? at(4),
		dedupeKey: `${type}:${over.subject ?? "x"}:${Math.random().toString(36).slice(2, 8)}`,
		payload: over.payload,
	});
	mkdirSync(dirname(journalPath), { recursive: true });
	appendFileSync(journalPath, `${JSON.stringify(env)}\n`, "utf8");
	return env.id;
}

/** 目录树 + 各文件内容哈希（零写盘断言：目录条目 + 内容不变；同 G1 treeHash 去 mtime 版）。 */
function treeDigest(dir: string): string {
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
				continue;
			}
			if (st.isDirectory()) {
				entries.push(`${relP}/:dir`);
				walk(p, relP);
			} else if (st.isFile()) {
				entries.push(`${relP}:${createHash("sha256").update(readFileSync(p)).digest("hex")}`);
			}
		}
	};
	walk(dir, "");
	return createHash("sha256").update(entries.join("\n")).digest("hex");
}

const att = (stateDir: string, mailboxDir: string, includeResolved = false) =>
	buildAttentionItems({ stateDir, mailboxDir, includeResolved });

// ── 主流程 ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
	// ── T1 五源逐字段映射 ──────────────────────────────────────────
	{
		// 1a runtime-risk（master-attention.json）：§31 九字段 + 无损 payload（原 7 字段全保留）
		const D = tmp("t1a-");
		seedAttention(join(D, "state"));
		const items = att(join(D, "state"), join(D, "mailbox"));
		assert.equal(items.length, 1, "单源单条");
		const i = items[0];
		assert.equal(i.id, "runtime-risk:attn_1", "id = <type>:<源 id>");
		assert.equal(i.type, "runtime-risk");
		assert.equal(i.severity, "critical", "v1 默认表：runtime-risk=critical");
		assert.ok(i.title.includes("tr_1"), "title 模板内插源 id");
		assert.ok(i.summary.includes("spawn failed") && i.summary.includes("gen 2"), "summary 模板内插数值");
		assert.equal(i.status, "open");
		assert.equal(i.createdAt, at(2), "createdAt = master-attention.at");
		assert.equal(i.source, undefined, "master-attention 无 address → source 缺省（plan §2）");
		assert.equal(i.actions, undefined, "v1 actions 恒缺省（G4）");
		assert.deepEqual(
			i.payload,
			{ id: "attn_1", at: at(2), kind: "auto-handoff-failed", transferId: "tr_1", error: "spawn failed", generation: 2, pressure: 0.8 },
			"无损：原 7 字段全在 payload",
		);

		// 1b master-handoff（pending proposal）
		const D2 = tmp("t1b-");
		seedProposal(join(D2, "state"));
		const i2 = att(join(D2, "state"), join(D2, "mailbox"))[0];
		assert.equal(i2.id, "master-handoff:hp_test1");
		assert.equal(i2.type, "master-handoff");
		assert.equal(i2.severity, "warning", "pending=warning（v1 默认表）");
		assert.equal(i2.status, "open");
		assert.equal(i2.createdAt, at(1), "createdAt = proposal.proposedAt");
		assert.ok(i2.summary.includes("76%") && i2.summary.includes("gen 2"), "summary 模板（Handoff proposed at 76%…）");
		assert.equal(i2.payload?.proposalId, "hp_test1");
		assert.equal(i2.payload?.pressure, 0.76);
		assert.equal(i2.source, undefined, "proposal 无 address 字段 → 缺省");

		// 1c escalation / question（mailbox pending 信按 frame.kind）
		const D3 = tmp("t1c-");
		const escId = deliver(join(D3, "mailbox"), "ESCALATION", at(3));
		const qstId = deliver(join(D3, "mailbox"), "QUESTION", at(4));
		const items3 = att(join(D3, "state"), join(D3, "mailbox"));
		assert.equal(items3.length, 2);
		const esc = items3.find((x) => x.type === "escalation")!;
		const qst = items3.find((x) => x.type === "question")!;
		assert.equal(esc.id, `escalation:${escId}`, "id = <type>:<letter id>");
		assert.equal(esc.severity, "warning", "escalation=warning");
		assert.equal(esc.source, "agent://master_default", "source = recipient 目录名逆 sanitize 反解");
		assert.equal(esc.createdAt, at(3), "createdAt = frame.sentAt");
		assert.equal(qst.id, `question:${qstId}`);
		assert.equal(qst.severity, "info", "question=info");
		assert.equal(qst.status, "open");

		// 1d blocked（workstream.status === "blocked"）
		const D4 = tmp("t1d-");
		seedWorkstream(join(D4, "state"), "ws_b1", "blocked", at(5));
		const i4 = att(join(D4, "state"), join(D4, "mailbox"))[0];
		assert.equal(i4.id, "blocked:ws_b1");
		assert.equal(i4.type, "blocked");
		assert.equal(i4.severity, "warning");
		assert.equal(i4.source, "workstream://ws_b1", "workstream 逻辑地址");
		assert.equal(i4.createdAt, at(5), "createdAt = ws.updatedAt");
		assert.equal(i4.status, "open");
	}

	// ── T2 多源聚合 + 输出序 ──────────────────────────────────────
	{
		const D = tmp("t2-");
		const S = join(D, "state");
		const M = join(D, "mailbox");
		seedAttention(S);
		seedProposal(S);
		deliver(M, "ESCALATION", at(3));
		seedWorkstream(S, "ws_b1", "blocked", at(6));
		const items = att(S, M);
		assert.equal(items.length, 4, "四源各 1 条聚合");
		assert.deepEqual(
			items.map((x) => x.type),
			["runtime-risk", "blocked", "escalation", "master-handoff"],
			"输出序：severity 降（critical→warning×3）；同 severity 按 createdAt 降（blocked at6 > escalation at3 > handoff at1）",
		);
	}

	// ── T3 同源双条去重（拍板①：source key 最新胜出）──────────────
	{
		const D = tmp("t3-");
		const S = join(D, "state");
		// 3a 共享 transferId（tr_1）：attention(at2) vs proposal-failed(proposedAt at1，更早)
		//   → attention 更新胜出；proposal 是 resolved 本就被默认过滤
		seedAttention(S);
		seedProposal(S, { status: "failed", transferId: "tr_1", proposedAt: at(1), decidedAt: at(1.5) });
		let items = att(S, join(D, "mailbox"));
		assert.equal(items.length, 1, "同源双条 → 1 条");
		assert.equal(items[0].type, "runtime-risk", "createdAt 最新（attention at2 > proposedAt at1）胜出");
		// 3b proposal 更新（at9）→ 它胜出，但它是 resolved → 默认过滤后为 0；includeResolved 可见
		seedProposal(S, { status: "failed", transferId: "tr_1", proposedAt: at(9), decidedAt: at(9.5) });
		items = att(S, join(D, "mailbox"));
		assert.equal(items.length, 0, "proposal（新）胜出但其 resolved → 默认过滤");
		items = att(S, join(D, "mailbox"), true);
		assert.equal(items.length, 1, "includeResolved 放行");
		assert.equal(items[0].type, "master-handoff", "createdAt 最新者（proposal at9）胜出");
		assert.equal(items[0].status, "resolved");
		// 3c 同刻同 severity → 先构造者胜（确定性；attention 段先于 proposal 段构造）
		seedAttention(S, { at: at(7) });
		seedProposal(S, { status: "failed", transferId: "tr_1", proposedAt: at(7) });
		items = att(S, join(D, "mailbox"), true);
		assert.equal(items.length, 1, "同刻 → 仍 1 条（确定性去重）");
		assert.equal(items[0].type, "runtime-risk", "同刻同 severity → 先构造者胜");
		// 3d 空 transferId（transfer 记录未落盘归一化）→ 退回自身 id，不成同源
		seedAttention(S, { transferId: "", id: "attn_9" });
		seedProposal(S, { status: "failed", transferId: "tr_2", proposedAt: at(8) });
		items = att(S, join(D, "mailbox"), true);
		assert.equal(items.length, 2, "空 transferId 与 tr_2 不同源 → 2 条");
	}

	// ── T4 proposal 7 态逐一：状态派生 + severity + 过滤 ───────────
	{
		const D = tmp("t4-");
		const S = join(D, "state");
		const cases: Array<[string, "open" | "resolved", string]> = [
			["pending", "open", "warning"],
			["accepted", "open", "warning"],
			["transferring", "open", "critical"],
			["completed", "resolved", "info"],
			["failed", "resolved", "critical"],
			["declined", "resolved", "info"],
			["superseded", "resolved", "info"],
		];
		for (const [status, want, wantSev] of cases) {
			seedProposal(S, { status, proposedAt: at(1), ...(status === "transferring" ? { transferId: "tr_t" } : {}) });
			const openOnly = att(S, join(D, "mailbox"));
			const withResolved = att(S, join(D, "mailbox"), true);
			if (want === "open") {
				assert.equal(openOnly.length, 1, `${status} → 默认输出`);
				assert.equal(openOnly[0].status, "open");
				assert.equal(openOnly[0].severity, wantSev, `${status} severity=${wantSev}`);
				assert.equal(withResolved.length, 1, `${status} → includeResolved 同 1 条`);
			} else {
				assert.equal(openOnly.length, 0, `${status} → resolved 默认过滤`);
				assert.equal(withResolved.length, 1, `${status} → includeResolved 输出`);
				assert.equal(withResolved[0].status, "resolved", `${status} → 派生 resolved`);
				assert.equal(withResolved[0].severity, wantSev, `${status} severity=${wantSev}`);
			}
		}
	}

	// ── T5 mailbox frame.kind 过滤 + 只 pending ───────────────────
	{
		const D = tmp("t5-");
		const M = join(D, "mailbox");
		const escId = deliver(M, "ESCALATION", at(1));
		const qstId = deliver(M, "QUESTION", at(2));
		deliver(M, "REPORT", at(3));
		deliver(M, "RESULT", at(4));
		deliver(M, "DELEGATION", at(5));
		deliver(M, "ACK", at(6));
		let items = att(join(D, "state"), M);
		assert.deepEqual(
			items.map((x) => x.id).sort(),
			[`escalation:${escId}`, `question:${qstId}`].sort(),
			"只有 ESCALATION/QUESTION；REPORT/RESULT/DELEGATION/ACK 不出现",
		);
		// claimed 信排除（只读 pending）
		const dir = join(M, "agent___master_default");
		const letter = JSON.parse(readFileSync(join(dir, `${escId}.json`), "utf8"));
		writeFileSync(join(dir, `${escId}.json`), JSON.stringify({ ...letter, status: "claimed" }), "utf8");
		items = att(join(D, "state"), M);
		assert.deepEqual(items.map((x) => x.id), [`question:${qstId}`], "claimed 信排除（listLetters status=pending）");
		// run:// 地址的目录名会把第二个 / sanitize 成 `_`，不能靠目录名无损反解；
		// 投影必须仍从信内 to 恢复 recipient，而非漏掉该收件箱。
		const runId = deliver(M, "ESCALATION", at(7), "run-recipient", tabRunAddress("tab_mail"));
		items = att(join(D, "state"), M);
		const runRecipient = items.find((x) => x.id === `escalation:${runId}`)!;
		assert.equal(runRecipient.source, "run://tab/tab_mail", "不可逆 spool 目录仍映射 mailbox attention（source = frame.to）");
	}

	// ── T6 workstream：blocked 出现 / 其它不出现 / 坏文件跳过 ─────
	{
		const D = tmp("t6-");
		const S = join(D, "state");
		seedWorkstream(S, "ws_a", "active", at(1));
		seedWorkstream(S, "ws_w", "waiting", at(2));
		seedWorkstream(S, "ws_b", "blocked", at(3));
		seedWorkstream(S, "ws_c", "completed", at(4));
		writeFileSync(join(S, "workstreams", "ws_bad.json"), "{not json", "utf8"); // 真坏 JSON（tolerant 跳过；若写成合法 JSON 字符串则会打穿 listWorkstreams 的 sort——非本层责任）
		const items = att(S, join(D, "mailbox"));
		assert.deepEqual(items.map((x) => x.id), ["blocked:ws_b"], "仅 blocked 出现；active/waiting/completed 不出现；坏文件跳过不炸");
		assert.equal(items[0].type, "blocked");
		assert.equal(items[0].payload?.workstreamId, "ws_b");
	}

	// ── T7 零写盘（R1）：构建前后目录树 + 内容不变 ────────────────
	{
		const D = tmp("t7-");
		const S = join(D, "state");
		const M = join(D, "mailbox");
		const J = join(D, "events.jsonl");
		const L = join(D, "links.jsonl");
		seedAttention(S);
		seedProposal(S);
		deliver(M, "ESCALATION", at(1));
		seedWorkstream(S, "ws_b", "blocked", at(2));
		appendEvent(J, "run.dispatched", { subject: "run://tab/tab_t7", at: at(3), payload: { tabRunId: "tab_t7" } });
		writeFileSync(L, JSON.stringify({ sessionId: "sessA", kind: "tab", targetId: "tab_t7", detail: "t", at: at(0), pid: 1 }) + "\n", "utf8");
		const before = treeDigest(D);
		att(S, M);
		buildTimelineItems({ stateDir: S, journalPath: J, linksPath: L });
		assert.equal(treeDigest(D), before, "attention + timeline 构建零写盘（结构 + 内容哈希不变）");
	}

	// ── T8 timeline ───────────────────────────────────────────────
	{
		const D = tmp("t8-");
		const S = join(D, "state");
		const J = join(D, "events.jsonl");
		const L = join(D, "links.jsonl");
		// 乱序写入（e3 at1 最后追加）→ 输出必须 at 升序
		appendEvent(J, "run.dispatched", {
			subject: "run://tab/tab_a", at: at(0),
			payload: { tabRunId: "tab_a", executionKind: "tab", externalTaskId: "9101", dispatchedAt: at(0) },
		});
		const e2 = appendEvent(J, "run.completed", {
			subject: "run://tab/tab_a", at: at(2),
			payload: { tabRunId: "tab_a", status: "completed", summary: "done", finishedAt: at(2) },
		});
		appendEvent(J, "agent.session.attaching", { subject: "agent://master_default", at: at(3) });
		const e3 = appendEvent(J, "master.handoff.proposed", {
			subject: "agent://master_default", at: at(1),
			payload: { proposalId: "hp_1", generation: 2, pressure: 0.76, status: "pending" },
		});
		// 状态条目原料：pending proposal + blocked/waiting workstream
		seedProposal(S, { proposedAt: at(10) });
		seedWorkstream(S, "ws_blk", "blocked", at(11));
		seedWorkstream(S, "ws_wait", "waiting", at(12));
		// enrichment 原料：wake-state（lastTabRunId=tab_a）+ links（targetId=tab_a）
		writeJson(join(S, "wake-state", "ws_w1.json"), {
			workstreamId: "ws_w1", lastTabRunId: "tab_a", spawnAt: [], updatedAt: at(0),
		});
		seedWorkstream(S, "ws_w1", "active", at(0));
		writeFileSync(L, JSON.stringify({ sessionId: "sess-dispatcher", kind: "tab", targetId: "tab_a", detail: "t", at: at(0), pid: 1 }) + "\n", "utf8");

		const items = buildTimelineItems({ stateDir: S, journalPath: J, linksPath: L });
		// 排序：at 升序（4 事件 + 3 状态 = 7 条）
		assert.equal(items.length, 7, "事件 4 + 状态 3");
		const ats = items.map((x) => x.at);
		assert.deepEqual(ats, [...ats].sort((a, b) => a.localeCompare(b)), "at 升序（乱序写入也排正）");
		assert.deepEqual(
			items.map((x) => x.id).slice(0, 4),
			[find_id(items, "run.dispatched")!, e3, e2, find_id(items, "agent.session.attaching")!],
			"乱序 e3(at1) 排第 2（at 为准，非 journal 行序）",
		);
		// 状态条目
		const st = items.filter((x) => x.kind === "state");
		assert.equal(st.length, 3);
		const hand = st.find((x) => x.type === "master-handoff")!;
		assert.equal(hand.id, "state:handoff:hp_test1", "state: 前缀 id（与 evt_ 事件 id 不撞）");
		assert.equal(hand.summary, "handoff pending");
		assert.equal(hand.at, at(10), "at = proposedAt");
		const wsB = st.find((x) => x.id === "state:ws:ws_blk")!;
		assert.equal(wsB.summary, "ws ws_blk blocked");
		const wsW = st.find((x) => x.id === "state:ws:ws_wait")!;
		assert.equal(wsW.summary, "ws ws_wait waiting");
		assert.equal(new Set(items.map((x) => x.id)).size, items.length, "id 全局唯一（state: 与 evt_ 不撞）");
		// 人话模板（无 raw JSON 泄漏）
		const d = items.find((x) => x.type === "run.dispatched")!;		assert.equal(d.summary, "Run tab_a dispatched (task 9101)（ws ws_w1 woke）", "run.dispatched 精修 + wake enrichment");
		assert.equal(d.actor, "sess-dispatcher", "links 溯源：派发方 sessionId");
		const c = items.find((x) => x.type === "run.completed")!;
		assert.equal(c.summary, "Run tab_a completed：done", "run.completed 精修（payload 只取展示字段）");
		const h = items.find((x) => x.type === "master.handoff.proposed")!;
		assert.equal(h.summary, "Handoff proposed at 76% (gen 2), proposal hp_1", "handoff 精修模板");
		const fb = items.find((x) => x.type === "agent.session.attaching")!;
		assert.ok(fb.summary.startsWith("agent.session.attaching agent://master_default @"), "session-lifecycle 通用兜底（type + subject + at）");
		for (const x of items) {
			assert.ok(!x.summary.includes("{") && !x.summary.includes('"'), `无 raw JSON 泄漏：${x.summary}`);
		}
		// 事件条目字段：id=evt id、source 原样
		assert.equal(d.source, "agent://master_default");
		assert.equal(d.kind, "event");
		// enrichment 缺席降级：无 links/wake-state 的同原料 → 无 actor、无 woke 后缀、不炸
		const D2 = tmp("t8b-");
		const S2 = join(D2, "state");
		const J2 = join(D2, "events.jsonl");
		appendEvent(J2, "run.dispatched", { subject: "run://tab/tab_z", at: at(0), payload: { tabRunId: "tab_z" } });
		const bare = buildTimelineItems({ stateDir: S2, journalPath: J2, linksPath: join(D2, "links.jsonl") });
		const bd = bare.find((x) => x.type === "run.dispatched")!;
		assert.equal(bd.actor, undefined, "links 缺失 → actor 缺席（静默降级）");
		assert.equal(bd.summary, "Run tab_z dispatched", "wake-state 缺失 → 无 woke 后缀");
	}
	// T8b limit（拍板②：仅 limit，默认 200 尾部 N 条 at 升序）
	{
		const D = tmp("t8c-");
		const J = join(D, "events.jsonl");
		for (let i = 0; i < 250; i++) {
			appendEvent(J, "run.dispatched", { subject: `run://tab/perf_${i}`, at: at(i), payload: { tabRunId: `perf_${i}` } });
		}
		const all = buildTimelineItems({ stateDir: join(D, "state"), journalPath: J, linksPath: join(D, "links.jsonl") });
		assert.equal(all.length, TIMELINE_DEFAULT_LIMIT, "默认 limit=200");
		assert.equal(all[0].at, at(50), "尾部 200 条：起点 at(50)");
		assert.equal(all[all.length - 1].at, at(249), "末尾 = 最新");
		assert.deepEqual(all.map((x) => x.at), [...all.map((x) => x.at)].sort((a, b) => a.localeCompare(b)), "at 升序");
		const few = buildTimelineItems({ stateDir: join(D, "state"), journalPath: J, linksPath: join(D, "links.jsonl"), limit: 50 });
		assert.equal(few.length, 50, "limit=50 尾部 50 条");
		assert.equal(few[0].at, at(200));
		assert.equal(few[few.length - 1].at, at(249));
		const zero = buildTimelineItems({ stateDir: join(D, "state"), journalPath: J, linksPath: join(D, "links.jsonl"), limit: 0 });
		assert.equal(zero.length, TIMELINE_DEFAULT_LIMIT, "非法 limit（0）→ 回退默认");
		const neg = buildTimelineItems({ stateDir: join(D, "state"), journalPath: J, linksPath: join(D, "links.jsonl"), limit: -5 });
		assert.equal(neg.length, TIMELINE_DEFAULT_LIMIT, "非法 limit（负）→ 回退默认");
		const big = buildTimelineItems({ stateDir: join(D, "state"), journalPath: J, linksPath: join(D, "links.jsonl"), limit: TIMELINE_LIMIT_MAX + 10 });
		assert.equal(big.length, 250, "limit 上限 10000（此处 250 全回）");
	}
	// T8d 全缺席降级 → []
	{
		const D = tmp("t8d-");
		const items = buildTimelineItems({ stateDir: join(D, "state"), journalPath: join(D, "events.jsonl"), linksPath: join(D, "links.jsonl") });
		assert.deepEqual(items, [], "journal/state/links 全缺失 → [] 不炸");
		const attItems = att(join(D, "state"), join(D, "mailbox"));
		assert.deepEqual(attItems, [], "attention 全源缺失 → [] 不炸");
	}

	// ── T9 双端点契约（随机端口 127.0.0.1）────────────────────────
	{
		const D = tmp("t9-");
		const S = join(D, "state");
		const M = join(D, "mailbox");
		const J = join(D, "events.jsonl");
		const L = join(D, "links.jsonl");
		seedAttention(S);
		seedProposal(S);
		deliver(M, "ESCALATION", at(3));
		seedWorkstream(S, "ws_b", "blocked", at(6));
		seedWorkstream(S, "ws_w", "waiting", at(5));
		appendEvent(J, "run.dispatched", { subject: "run://tab/tab_t9", at: at(1), payload: { tabRunId: "tab_t9", externalTaskId: "9201" } });
		appendEvent(J, "run.completed", { subject: "run://tab/tab_t9", at: at(2), payload: { summary: "done" } });
		writeFileSync(L, JSON.stringify({ sessionId: "sess-d", kind: "tab", targetId: "tab_t9", detail: "t", at: at(0), pid: 1 }) + "\n", "utf8");

		const h = await createRuntimeHostServer({
			hostPath: join(D, "host.json"),
			timersDir: join(D, "timers"),
			stateDir: S,
			mailboxDir: M,
			journalPath: J,
			linksPath: L,
		});
		const base = `http://127.0.0.1:${h.info.port}`;
		try {
			const r1 = await (await fetch(`${base}/v1/attention`)).json() as any;
			assert.equal(r1.version, 1);
			assert.equal(r1.count, 4, "attention 四源各 1 条");
			assert.equal(r1.attention.length, 4);
			const first = r1.attention[0];
			for (const k of ["id", "type", "severity", "title", "summary", "status", "createdAt"] as const) {
				assert.equal(typeof first[k], "string", `契约字段 ${k} 为 string`);
			}
			assert.ok(!r1.attention.some((x: AttentionItem) => x.status === "resolved"), "resolved 默认不出（拍板①）");

			// POST → 405
			const r2 = await fetch(`${base}/v1/attention`, { method: "POST" });
			assert.equal(r2.status, 405);
			const r2b = await fetch(`${base}/v1/timeline`, { method: "POST" });
			assert.equal(r2b.status, 405, "POST /v1/timeline → 405（GET-only 纪律）");

			// timeline：200 契约 + ?limit=2 尾部 2 条
			const r3 = await (await fetch(`${base}/v1/timeline`)).json() as any;
			assert.equal(r3.version, 1);
			assert.equal(r3.count, 5, "事件 2 + 状态 3（handoff pending + ws blocked）");
			assert.equal(r3.timeline.length, 5);
			const r3b = await (await fetch(`${base}/v1/timeline?limit=2`)).json() as any;
			assert.equal(r3b.timeline.length, 2, "?limit=2 尾部 2 条");
			assert.deepEqual(r3b.timeline.map((x: TimelineItem) => x.id), r3.timeline.slice(-2).map((x: TimelineItem) => x.id), "尾部 = 全量最后 2 条");
			const ats = r3b.timeline.map((x: TimelineItem) => x.at);
			assert.ok(ats[0].localeCompare(ats[1]) <= 0, "at 升序");
			const r3c = await (await fetch(`${base}/v1/timeline?limit=abc`)).json() as any;
			assert.equal(r3c.timeline.length, 5, "?limit=abc（非法）→ 回退默认（全量 < 默认 → 全回）");

			// 404
			const r4 = await fetch(`${base}/v1/nope`);
			assert.equal(r4.status, 404);

			// /v1/snapshot：attention/timeline 位已填充（G3 拍板③）
			const r5 = await (await fetch(`${base}/v1/snapshot`)).json() as any;
			assert.equal(r5.version, 1);
			assert.equal(r5.attention.length, 4, "snapshot.attention 与端点同内容（同纯函数）");
			assert.equal(r5.timeline.length, 5, "snapshot.timeline 已填充");
			assert.equal(r5.master.attachment, null, "master 段契约不变（本目录未 attach）");

			// includeResolved=1：resolved proposal 目录（独立场景）
			const D2 = tmp("t9b-");
			seedProposal(join(D2, "state"), { status: "completed", proposedAt: at(1), decidedAt: at(2) });
			const h2 = await createRuntimeHostServer({
				hostPath: join(D2, "host.json"),
				timersDir: join(D2, "timers"),
				stateDir: join(D2, "state"),
				mailboxDir: join(D2, "mailbox"),
				journalPath: join(D2, "events.jsonl"),
				linksPath: join(D2, "links.jsonl"),
			});
			try {
				const b1 = await (await fetch(`http://127.0.0.1:${h2.info.port}/v1/attention`)).json() as any;
				assert.equal(b1.count, 0, "completed proposal → 默认过滤（count 0）");
				const b2 = await (await fetch(`http://127.0.0.1:${h2.info.port}/v1/attention?includeResolved=1`)).json() as any;
				assert.equal(b2.count, 1, "?includeResolved=1 看历史");
				assert.equal(b2.attention[0].status, "resolved");
				assert.equal(b2.attention[0].type, "master-handoff");
			} finally {
				await h2.close();
			}
		} finally {
			await h.close();
		}
	}

	// ── T10 S3 OFF 现网常态 + 各源缺失/坏文件降级 ─────────────────
	{
		const D = tmp("t10-");
		const S = join(D, "state");
		const M = join(D, "mailbox");
		const J = join(D, "events.jsonl");
		// 现网常态：无 master-attention.json（S3 OFF 不产生）
		seedWorkstream(S, "ws_a", "active", at(1));
		appendEvent(J, "run.dispatched", { subject: "run://tab/tab_x", at: at(2), payload: { tabRunId: "tab_x" } });
		const items = att(S, M);
		assert.deepEqual(items, [], "S3 OFF：无 runtime-risk 段（文件缺席 = 正常）；ws active 无 blocked");
		const tl = buildTimelineItems({ stateDir: S, journalPath: J, linksPath: join(D, "links.jsonl") });
		assert.equal(tl.length, 1);
		// 坏文件降级：master-attention.json 坏 JSON / master-succession.json 坏 JSON / 坏 workstream
		writeJson(join(S, "master-attention.json"), "{broken");
		writeJson(join(S, "master-succession.json"), "{broken");
		writeFileSync(join(S, "workstreams", "ws_bad.json"), "{broken", "utf8");
		const items2 = att(S, M);
		assert.deepEqual(items2, [], "坏文件：底层 tolerant reader 吞掉 → [] 不炸");
		// snapshot 在 S3 OFF + 全坏文件下不崩、段级错误为空（收窄语义：tolerant 吞掉不记）
		const snap = buildRuntimeSnapshot({
			stateDir: S,
			mailboxDir: M,
			journalPath: J,
			linksPath: join(D, "links.jsonl"),
		});
		assert.equal(snap.version, 1);
		assert.deepEqual(snap.attention, []);
		assert.equal(snap.timeline.length, 1, "snapshot.timeline 不受坏 state 文件影响（journal 段独立）");
		assert.deepEqual(snap.sectionErrors, [], "底层 tolerant 吞掉的坏文件不进 sectionErrors（G1 收窄语义）");
		// HTTP 层也必须把全缺席/坏源降级为 200（而非只验证纯函数）。
		const h = await createRuntimeHostServer({
			hostPath: join(D, "host.json"), timersDir: join(D, "timers"), stateDir: S, mailboxDir: M,
			journalPath: J, linksPath: join(D, "links.jsonl"),
		});
		try {
			const base = `http://127.0.0.1:${h.info.port}`;
			for (const path of ["/v1/attention", "/v1/timeline", "/v1/snapshot"]) {
				assert.equal((await fetch(`${base}${path}`)).status, 200, `${path}：缺席/坏源仍 200`);
			}
		} finally {
			await h.close();
		}
	}

	// 清理
	for (const d of DIRS) rmSync(d, { recursive: true, force: true });
	console.log("_test_runtime_host_projections: all assertions passed");
}

function find_id(items: TimelineItem[], type: string): string | undefined {
	return items.find((x) => x.type === type)?.id;
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
