/**
 * _test_runtime_interactions.ts — G6-P3 测试（待决策交互投影 + /v1/interactions + WS interactions 主题
 * + client 身份日志前缀；plans/0920_g6_webconsole_plan.md P3 段 + task 拍板）
 *
 * 覆盖：
 *   T1 纯函数性质（同 state 同输出）：相同 state 两次构建 deepEqual；加入无关文件输出不变；
 *      输出与 buildAttentionItems（open 过滤后）id 序 1:1
 *   T2 映射 + response 语义：五源（runtime-risk / pending proposal / escalation / question /
 *      blocked）逐一投影；仅 pending handoff 提案带 response={command:"master.handoff.accept"}
 *      （§29 决策走既有命令）；accepted/failed 提案无 response；failed(resolved) 不出现
 *   T3 零状态 → []；零写盘（treeDigest 前后不变，attention 同款纪律）
 *   T4 HTTP GET /v1/interactions：200 契约 {version,count,interactions} 与纯函数一致；空态 count=0
 *   T5 WS topic "interactions"：订阅 → ack(snapshot, head:null) + seq=1 全量状态帧；无变化静默；
 *      state 变化（提案 declined）→ 下一帧全量替换（待决策消失=答后同步退场）
 *   T6 双 client 交互主题隔离：各自独立种子帧 + 各自独立变更帧（per-connection lastJson）
 *   T7 client 身份日志前缀：`[ws <hex>]` connected/subscribe/closed（多端附着可归因）
 *
 * 运行：npm run test:runtime-interactions
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, lstatSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "interactions-env-"));
process.env.PI_SESSIONS_DIR = mkdtempSync(join(tmpdir(), "interactions-sessions-"));

import { buildInteractions, type InteractionItem } from "./runtime-host/interactions.ts";
import { buildAttentionItems } from "./runtime-host/attention.ts";
import { createRuntimeHostServer, type RuntimeHostHandle } from "./runtime-host/server.ts";
import { deliverLetter } from "./runtime/mailbox.ts";
import { masterAddress } from "./runtime/address.ts";
import { newEnvelopeId } from "./runtime/ids.ts";
import { newMessageFrame, type MessageKind } from "./runtime/protocol.ts";
import { IMPLEMENTED_COMMAND_TYPES } from "./runtime/command-executor.ts";
import { wsHandshake, isAck } from "./_test_ws_client.ts";

// ── 种子 helpers（同 _test_runtime_host_projections 模板）────────────

const T0 = "2026-09-20T10:00:00.000Z";
const at = (min: number): string => new Date(Date.parse(T0) + min * 60000).toISOString();

const DIRS: string[] = [];
const tmp = (prefix: string): string => {
	const d = mkdtempSync(join(tmpdir(), prefix));
	DIRS.push(d);
	return d;
};

function writeJson(p: string, v: unknown): void {
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`, "utf8");
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

function deliver(mailboxDir: string, kind: MessageKind, sentAt: string, summary = `sum-${kind}`): string {
	const { letter } = deliverLetter(
		newMessageFrame({
			id: newEnvelopeId("msg"),
			kind,
			from: "agent://worker_a",
			to: masterAddress(),
			sentAt,
			summary,
		}),
		{ mailboxDir },
	);
	return letter.frame.frame === "message" ? letter.frame.id : "";
}

/** 目录树 + 内容哈希（零写盘断言，G3 T7 同款）。 */
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

/** 全五源环境：runtime-risk + pending proposal + escalation + question + blocked。 */
function seedAllSources(stateDir: string, mailboxDir: string): void {
	seedAttention(stateDir);
	seedProposal(stateDir);
	deliver(mailboxDir, "ESCALATION", at(3), "worker 卡死");
	deliver(mailboxDir, "QUESTION", at(4), "要不要重试");
	seedWorkstream(stateDir, "ws_a", "blocked", at(5));
}

async function getJson(base: string, path: string): Promise<{ status: number; body: any }> {
	const res = await fetch(`${base}${path}`);
	const text = await res.text();
	let body: unknown = null;
	try {
		body = text.length > 0 ? JSON.parse(text) : null;
	} catch {
		body = { __raw: text };
	}
	return { status: res.status, body };
}

function isEvent(f: unknown): f is { type: "event"; topic: string; seq: number; op?: { kind: string; patch?: { interactions?: InteractionItem[] } } } {
	return typeof f === "object" && f !== null && (f as { type?: unknown }).type === "event";
}

// ── 主流程 ───────────────────────────────────────────────────────

async function main(): Promise<void> {
	// ── T1 纯函数性质：同 state 同输出 ─────────────────────────────
	{
		const D = tmp("ix-t1-");
		const stateDir = join(D, "state");
		const mailboxDir = join(D, "mailbox");
		seedAllSources(stateDir, mailboxDir);

		const a = buildInteractions({ stateDir, mailboxDir });
		const b = buildInteractions({ stateDir, mailboxDir });
		assert.deepEqual(b, a, "同 state 两次构建 deepEqual（确定性）");
		assert.equal(JSON.stringify(b), JSON.stringify(a), "字节级一致");

		// 无关文件不进任何原料目录 → 输出不变
		writeJson(join(stateDir, "unrelated.json"), { noise: true });
		assert.deepEqual(buildInteractions({ stateDir, mailboxDir }), a, "无关文件不影响输出（纯投影）");

		// id 序与 attention（open 过滤）1:1 直投
		const att = buildAttentionItems({ stateDir, mailboxDir, includeResolved: false }).filter((x) => x.status === "open");
		assert.deepEqual(
			a.map((i) => i.id),
			att.map((x) => x.id),
			"交互 id 序 = attention open 条目 id 序（1:1 直投）",
		);
		assert.ok(a.length >= 5, `五源齐出（实际 ${a.length}）`);
	}

	// ── T2 映射 + response 语义 ────────────────────────────────────
	{
		const D = tmp("ix-t2-");
		const stateDir = join(D, "state");
		const mailboxDir = join(D, "mailbox");
		seedAllSources(stateDir, mailboxDir);
		const ix = buildInteractions({ stateDir, mailboxDir });
		const byId = new Map(ix.map((i) => [i.id, i] as const));

		// pending 提案：唯一带 response 语义的待决策（§29：决策走既有 master.handoff.accept）
		const hp = byId.get("master-handoff:hp_test1");
		assert.ok(hp, "pending 提案在投影");
		assert.equal(hp!.kind, "master-handoff");
		assert.deepEqual(hp!.response, { command: "master.handoff.accept" }, "response 语义 = 既有确定性命令");
		assert.ok(
			IMPLEMENTED_COMMAND_TYPES.includes(hp!.response!.command),
			"response.command 在 executor 已实现命令白名单内",
		);
		assert.equal((hp!.payload as any)?.proposalId, "hp_test1", "payload 透传");

		// 其余四源：待决策但 v1 无确定性命令 → 无 response 键
		const rr = ix.find((i) => i.kind === "runtime-risk");
		assert.ok(rr && rr.response === undefined, "runtime-risk 无 response");
		const esc = ix.find((i) => i.kind === "escalation");
		assert.ok(esc && esc.response === undefined, "escalation 无 response");
		const q = ix.find((i) => i.kind === "question");
		assert.ok(q && q.response === undefined, "question 无 response");
		const bl = ix.find((i) => i.kind === "blocked");
		assert.ok(bl && bl.response === undefined, "blocked 无 response");
		assert.ok(bl!.id === "blocked:ws_a" && (bl!.payload as any)?.workstreamId === "ws_a", "blocked id/payload 直投");

		// accepted：仍在途（attention open）→ 出现在投影但无 response（不可再决）
		seedProposal(stateDir, { status: "accepted", decidedAt: at(6) });
		const acc = buildInteractions({ stateDir, mailboxDir }).find((i) => i.id === "master-handoff:hp_test1");
		assert.ok(acc && acc.response === undefined, "accepted 提案无 response（已决不可重复决）");
		assert.ok(acc!.kind === "master-handoff", "accepted 提案仍是 open 待关注项");

		// failed：resolved → 投影不出现（待决策视图不含历史）
		seedProposal(stateDir, { status: "failed", decidedAt: at(7) });
		const failed = buildInteractions({ stateDir, mailboxDir }).find((i) => i.id === "master-handoff:hp_test1");
		assert.equal(failed, undefined, "failed 提案退场（resolved 不出现在待决策投影）");
	}

	// ── T3 零状态 → []；零写盘 ─────────────────────────────────────
	{
		const D = tmp("ix-t3-");
		const stateDir = join(D, "state");
		const mailboxDir = join(D, "mailbox");
		mkdirSync(stateDir, { recursive: true });
		mkdirSync(mailboxDir, { recursive: true });
		assert.deepEqual(buildInteractions({ stateDir, mailboxDir }), [], "零状态 → []");

		seedAllSources(stateDir, mailboxDir);
		const before = treeDigest(D);
		buildInteractions({ stateDir, mailboxDir });
		buildInteractions({ stateDir, mailboxDir });
		assert.equal(treeDigest(D), before, "零写盘（投影纯读）");
	}

	// ── T4 HTTP GET /v1/interactions ───────────────────────────────
	{
		const D = tmp("ix-t4-");
		const stateDir = join(D, "state");
		const mailboxDir = join(D, "mailbox");
		const journalPath = join(D, "events.jsonl");
		const handle = await createRuntimeHostServer({ stateDir, mailboxDir, journalPath, tailMs: 30, pingMs: 200 });
		try {
			const base = `http://127.0.0.1:${handle.info.port}`;

			const empty = await getJson(base, "/v1/interactions");
			assert.equal(empty.status, 200);
			assert.deepEqual(empty.body, { version: 1, count: 0, interactions: [] }, "空态契约");

			seedAllSources(stateDir, mailboxDir);
			const r = await getJson(base, "/v1/interactions");
			assert.equal(r.status, 200);
			assert.equal(r.body.version, 1);
			assert.equal(r.body.count, r.body.interactions.length);
			assert.ok(r.body.count >= 5);
			assert.deepEqual(r.body.interactions, buildInteractions({ stateDir, mailboxDir }), "HTTP = 纯函数直出");
			const hp = r.body.interactions.find((i: InteractionItem) => i.id === "master-handoff:hp_test1");
			assert.deepEqual(hp?.response, { command: "master.handoff.accept" }, "HTTP 契约含 response 语义");
		} finally {
			await handle.close().catch(() => undefined);
		}
	}

	// ── T5/T6/T7 WS interactions 主题 + 双 client 隔离 + 日志前缀 ──
	{
		const D = tmp("ix-t5-");
		const stateDir = join(D, "state");
		const mailboxDir = join(D, "mailbox");
		const journalPath = join(D, "events.jsonl");
		seedAllSources(stateDir, mailboxDir);
		const handle = await createRuntimeHostServer({ stateDir, mailboxDir, journalPath, tailMs: 30, pingMs: 200 });
		try {
			const base5 = handle.info.port;
			const wsPath = `/v1/events/stream?token=${encodeURIComponent(handle.info.token)}`;

			// T7 日志捕获：console.error 收集，断言前缀 [ws <hex>]
			const logs: string[] = [];
			const origErr = console.error;
			console.error = (msg?: unknown): void => {
				logs.push(typeof msg === "string" ? msg : "");
			};

			const c1 = await wsHandshake(base5, wsPath);
			assert.ok(c1.ok);
			c1.ws!.sendText(JSON.stringify({ type: "subscribe", topic: "interactions" }));
			const ack1 = await c1.ws!.recvJson();
			assert.ok(isAck(ack1) && (ack1 as any).mode === "snapshot" && (ack1 as any).head === null, "状态投影 ack：snapshot + head:null（无可续传 base）");
			const seed1 = await c1.ws!.recvJson();
			assert.ok(isEvent(seed1) && (seed1 as any).seq === 1, "种子帧 seq=1");
			assert.equal((seed1 as any).op.kind, "state.updated", "op = state.updated（键级整体替换）");
			const seedItems1 = (seed1 as any).op.patch.interactions as InteractionItem[];
			assert.ok(Array.isArray(seedItems1) && seedItems1.length >= 5, "种子帧 = 当前全量");
			assert.deepEqual(
				seedItems1,
				buildInteractions({ stateDir, mailboxDir }),
				"WS 种子 = 纯函数直出（可回放：订阅即全量）",
			);

			// 无变化 → 静默（重算命中 lastJson 不发帧）
			const quiet = await c1.ws!.recvJson(400);
			assert.equal(quiet, null, "无变化静默（不重发相同状态）");

			// 第二个 client 加入（多端附着）：独立种子帧（seq 计数独立从 1 起）
			const c2 = await wsHandshake(base5, wsPath);
			assert.ok(c2.ok);
			c2.ws!.sendText(JSON.stringify({ type: "subscribe", topic: "interactions" }));
			const ack2 = await c2.ws!.recvJson();
			assert.ok(isAck(ack2) && (ack2 as any).head === null);
			const seed2 = await c2.ws!.recvJson();
			assert.ok(isEvent(seed2) && (seed2 as any).seq === 1, "client2 独立种子帧 seq=1");
			assert.deepEqual((seed2 as any).op.patch.interactions, seedItems1, "两 client 种子内容一致（状态非内存推送）");

			// state 变化：提案 declined → 两 client 各自下一帧（内容一致；seq 各自推进）
			seedProposal(stateDir, { status: "declined", decidedAt: at(8) });
			const u1 = await c1.ws!.recvJson(2000);
			const u2 = await c2.ws!.recvJson(2000);
			assert.ok(isEvent(u1) && (u1 as any).seq === 2, "client1 变更帧 seq=2");
			assert.ok(isEvent(u2) && (u2 as any).seq === 2, "client2 变更帧 seq=2（per-connection 独立计数）");
			const afterItems = (u1 as any).op.patch.interactions as InteractionItem[];
			assert.equal(afterItems.find((i) => i.id === "master-handoff:hp_test1"), undefined, "提案 declined → 待决策退场（答后同步消失）");
			assert.deepEqual((u2 as any).op.patch.interactions, afterItems, "两 client 状态一致");
			const beforeSilence = treeDigest(stateDir);

			c1.ws!.destroy();
			c2.ws!.destroy();
			await new Promise((r) => setTimeout(r, 900)); // ≥ 两拍 ping 超时（400ms）+ 250ms 排空销毁 → closed 日志必达

			console.error = origErr;
			// T7：前缀归因——connected/subscribe/closed 全带 [ws <hex>]
			const wsLogs = logs.filter((l) => l.startsWith("[ws "));
			assert.ok(wsLogs.length >= 6, `日志行数（实际 ${wsLogs.length}）`);
			const cids = new Set(wsLogs.map((l) => l.slice(4).split("]")[0]));
			assert.ok(cids.size >= 2, "两连接两 cid（可归因）");
			for (const l of wsLogs) assert.match(l, /^\[ws [0-9a-f]{6}\] /, `日志前缀格式：${l}`);
			assert.ok(wsLogs.some((l) => l.includes("subscribe interactions")), "subscribe 行带主题");
			assert.equal(treeDigest(stateDir), beforeSilence, "收尾零写盘");

			// T5 补：非 subscribe 帧 / 未知 topic 照旧 error（红线的表亲：interactions 主题同样只读）
			const c3 = await wsHandshake(base5, wsPath);
			assert.ok(c3.ok);
			c3.ws!.sendText(JSON.stringify({ type: "subscribe", topic: "interactions" }));
			assert.ok(isAck(await c3.ws!.recvJson()));
			const seed3 = await c3.ws!.recvJson();
			assert.ok(isEvent(seed3), "先消费种子帧再发干扰帧");
			c3.ws!.sendText(JSON.stringify({ type: "command", commandKey: "ix-hack", payload: {} }));
			const err = await c3.ws!.recvJson();
			assert.ok(typeof err === "object" && err !== null && (err as any).type === "error", "interactions 主题下 command 帧仍 → error（WS 只读红线）");
			c3.ws!.destroy();
		} finally {
			await handle.close().catch(() => undefined);
		}
	}

	console.log("_test_runtime_interactions: all assertions passed");
}

try {
	await main();
} finally {
	for (const d of DIRS) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}
	try {
		rmSync(process.env.PI_RUNTIME_DIR!, { recursive: true, force: true });
		rmSync(process.env.PI_SESSIONS_DIR!, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
}
