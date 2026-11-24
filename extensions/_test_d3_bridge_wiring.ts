/**
 * D3 接线回归网（2026-11-10）—— 必须走**真实桥入口** `consumeOutboxOnce()`。
 *
 * ## 为什么不能只测 `decideInjectionRecovery`
 *
 * AGENTS.md R-4 的教训（同 `_test_outbox_duplicate_injection.ts` 第一版）：
 * 直接调内部函数 = 绕开真实决策点 ⇒ 把 `outbox-bridge.ts` 里那段接线整段删掉，测试**仍然绿**。
 * 那次事故的后果是「变异函数体 ⇒ 5 项实红（假的）；变异接线 ⇒ 23 组全绿（真缺陷）」。
 *
 * ⇒ 本套件每个用例都构造真实盘面（outbox 项 + injected 收据 + 旧 unconfirmed attempt
 *   + 会话 JSONL），然后只调 `consumeOutboxOnce()`，断言**盘上发生了什么**
 *   （收据是否还在原路径、隔离文件数、trace、outbox 状态、是否真的再注入）。
 *
 * ## 判别力对照表（每条都写明「变异哪里会红」）
 *
 * | 用例 | 要防的错误 | 变异点 |
 * |---|---|---|
 * | A1 | marker 在 user 消息里却仍放行（= 双投） | 删 `probe-found ⇒ keep` |
 * | A2 | 没证据却放行（= 不确定就重发） | 删 `inconclusive ⇒ keep` |
 * | A3 | 有证据却不放行（= D3 根本没接线） | 删整个 `if (strict && eventId)` 块 |
 * | A4 | 放行了但收据没让路（= 收据仍短路，等于没放） | 删 `quarantineReceipt(...)` |
 * | A5 | 无界重投（= 每 tick 撞墙，比原缺陷更糟） | 删次数闸 / 去掉 attempts 过滤 |
 * | A6 | 冷却缺失（= JSONL 没 flush ⇒ 假阴性） | 删 `D3_MIN_ATTEMPT_AGE_MS` 闸 |
 * | A7 | role 不加限定（= 真死锁被判已送达） | probe 去掉 `type==="message"` |
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "d3-wire-"));
process.env.PI_RUNTIME_DIR = ROOT; // receipts.ts 从这里读 receipts/
process.env.PI_DELIVERY_STRICT = "1";

import { consumeOutboxOnce } from "./outbox-bridge.ts";
import { eventMarker } from "./delivery-ack.ts";
import { outboxDir, newOutboxItem, writeOutboxItem, readOutboxItem, outboxItemId } from "./runtime/message-outbox.ts";
import { ensureEvent, listAttempts, terminalRevisionOf, recordAttempt } from "./delivery-ledger.ts";

const SID = "01a1cccc-0000-7000-8000-0000000000cc";
const SESSIONS = join(ROOT, "sessions");
const STATE = join(ROOT, "state");
const DIR = outboxDir(STATE);
const DELIVERY = join(ROOT, "delivery");
const RECEIPTS = join(ROOT, "receipts");
const SESS_FILE = join(SESSIONS, `2026-11-10T00-00-00-000Z_${SID}.jsonl`);
for (const d of [DIR, DELIVERY, RECEIPTS, SESSIONS]) mkdirSync(d, { recursive: true });

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void): void => {
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

const flush = async (): Promise<void> => {
	for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
};

const T1 = new Date("2026-11-10T03:00:00.000Z"); // 首次注入
const T2 = new Date("2026-11-10T03:05:00.000Z"); // 第二轮（5min 后 ⇒ 过了 60s 冷却）

function seedItem(key: string): string {
	const item = newOutboxItem({
		dedupeKey: `wechat:${key}`,
		commandKey: key,
		to: `pi://${SID}` as never,
		sessionId: SID,
		text: `msg-${key}`,
		now: T1,
	});
	writeOutboxItem(DIR, item);
	return item.id;
}

const userLine = (t: string) => JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: t }] } });
const assistantLine = (t: string) => JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: t }] } });
const writeSession = (lines: string[]): void => writeFileSync(SESS_FILE, `${lines.join("\n")}\n`, "utf8");

/**
 * 造「首轮已注入但未确认」的完整盘面：
 *   - injected 收据（`outbox_<id>.json`）存在 ⇒ claimInjection 短路 injected-already
 *   - 账本里有一条 `unconfirmed` attempt（时间 = attemptAt）
 */
function seedInjectedOnce(itemId: string, attemptAt: Date): string {
	writeFileSync(
		join(RECEIPTS, `outbox_${itemId}.json`),
		JSON.stringify({ key: `outbox:${itemId}`, recordedAt: attemptAt.toISOString(), by: `outbox-bridge:${SID}` }),
		"utf8",
	);
	const { event } = ensureEvent(DELIVERY, {
		runId: `outbox_${itemId}`,
		terminalRevision: terminalRevisionOf({ status: "pending", result: { status: "pending", outboxId: itemId } }),
		terminalSnapshotPath: join(DIR, `${itemId}.json`),
		dispatcherSessionId: SID,
		observedAt: attemptAt.toISOString(),
		terminalAt: attemptAt.toISOString(),
	});
	recordAttempt(DELIVERY, event.eventId, {
		attemptId: `${event.eventId}@A@${attemptAt.getTime()}`,
		channel: "A",
		at: attemptAt.toISOString(),
		status: "unconfirmed",
		leaseOwner: "OB:1",
		leaseUntil: new Date(attemptAt.getTime() + 15_000).toISOString(),
	});
	return event.eventId;
}

/** 记录本轮所有注入的正文（按 dedupe:outbox:<id> 归属，避免多条 pending 互相干扰计数）。 */
let injectedBodies: string[] = [];

/** 跑一轮真实桥；返回本轮实际调用 send 的次数（用于证明「让路后真的能再注入」）。 */
async function runBridge(at: Date): Promise<number> {
	injectedBodies = [];
	consumeOutboxOnce({
		sessionId: SID,
		stateDir: STATE,
		deliveryDir: DELIVERY,
		sessionsDir: SESSIONS,
		sendUserMessage: ((body: string) => {
			injectedBodies.push(body);
			// 生产形态：不 return ⇒ classifySendReturn 判 unconfirmed
		}) as never,
		now: at,
	});
	await flush();
	return injectedBodies.length;
}

/** 本轮注入里属于某条 outbox 项的次数（正文首行带 `dedupe:outbox:<id>`）。 */
const injectedFor = (id: string): number => injectedBodies.filter((b) => b.includes(`dedupe:outbox:${id}`)).length;

const quarantined = (): string[] => readdirSync(RECEIPTS).filter((n) => n.includes("d3-quarantined"));
const traceEntries = (): Array<Record<string, unknown>> => {
	const p = join(DELIVERY, "trace.jsonl");
	if (!existsSync(p)) return [];
	return readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
};

const main = async (): Promise<void> => {
	console.log("\nA. 接线判别力（走真实 consumeOutboxOnce）");

	// ── A1 marker 在 user 消息里 ⇒ 不放行 ─────────────────────────
	const k1 = outboxItemId("wechat:d3-a1");
	seedItem("d3-a1");
	const e1 = seedInjectedOnce(k1, T1);
	// 目标会话：user 消息里确实带着 marker（= 真进了）
	writeSession([userLine(`（Web Console 远程输入）\nmsg-d3-a1\n${eventMarker(e1)}`), assistantLine("收到")]);
	const inj1 = await runBridge(T2);
	check("A1 marker 在 role=user ⇒ 不放行：收据保留、零隔离文件、无 d3 trace", () => {
		assert.equal(existsSync(join(RECEIPTS, `outbox_${k1}.json`)), true, "收据必须仍在（已进会话，不该让路）");
		assert.equal(quarantined().length, 0, `不该有隔离文件，实际 ${quarantined().length}`);
		const d3 = traceEntries().filter((t) => String(t.kind).startsWith("d3-"));
		assert.equal(d3.length, 0, `不该有 d3 trace，实际 ${JSON.stringify(d3)}`);
		assert.equal(readOutboxItem(DIR, k1)?.status, "pending", "仍须 pending（delivered 归 ACK）");
		assert.equal(inj1, 0, `本轮不该注入（收据在 + 已进会话），实际 ${inj1}`);
	});

	// ── A2 找不到会话文件 ⇒ 不放行 ─────────────────────────────────
	// 先把 SESS_FILE 改名，让 probe 对 SID 找不到任何候选文件
	const { renameSync } = await import("node:fs");
	renameSync(SESS_FILE, join(SESSIONS, `2026-11-10T00-00-00-000Z_other-session.jsonl`));
	const k2 = outboxItemId("wechat:d3-a2");
	seedItem("d3-a2");
	const e2 = seedInjectedOnce(k2, T1);
	const inj2 = await runBridge(T2);
	check("A2 找不到目标会话文件 ⇒ 不放行（inconclusive 不是证据），并留 not-released trace", () => {
		assert.equal(existsSync(join(RECEIPTS, `outbox_${k2}.json`)), true, "收据必须保留（没证据）");
		const noRelease = traceEntries().filter((t) => t.kind === "d3-probe-not-released" && t.outboxId === k2);
		assert.equal(noRelease.length, 1, `应留一条「没放行」trace，实际 ${noRelease.length}`);
		assert.equal(noRelease[0].reason, "probe-inconclusive");
		assert.equal(inj2, 0, `本轮不该注入，实际 ${inj2}`);
	});
	// 复原会话文件（后面用例要用）
	renameSync(join(SESSIONS, `2026-11-10T00-00-00-000Z_other-session.jsonl`), SESS_FILE);
	void e2;

	// ── A3 marker 只在 assistant 行 ⇒ 放行（收据被隔离）───────────
	const k3 = outboxItemId("wechat:d3-a3");
	seedItem("d3-a3");
	const e3 = seedInjectedOnce(k3, T1);
	writeSession([userLine("别的消息"), assistantLine(`agent 回述：${eventMarker(e3)}`)]);
	const inj3 = await runBridge(T2);
	check("A3 marker 只在 assistant 行 ⇒ 放行一次：原收据路径消失、隔离文件 +1、留 released trace", () => {
		assert.equal(existsSync(join(RECEIPTS, `outbox_${k3}.json`)), false, "原路径必须消失（否则 claim 仍短路）");
		const rel = traceEntries().filter((t) => t.kind === "d3-released-for-retry" && t.outboxId === k3);
		assert.equal(rel.length, 1, `应留一条放行 trace，实际 ${rel.length}`);
		assert.equal(rel[0].reason, "absent-evidenced");
		assert.equal(rel[0].quarantined, true, "quarantined 必须为 true（改名成功）");
		assert.equal(rel[0].probeVerdict, "absent");
		assert.equal(readOutboxItem(DIR, k3)?.status, "pending", "放行不是终态，仍须 pending");
		assert.equal(inj3, 0, `让路的当轮不注入（下轮才 claim），实际 ${inj3}`);
	});

	// ── A4 下一 tick 真的能重新注入（证明让路有效）─────────────────
	await runBridge(T2);
	check("A4 收据让路后下一 tick 真能重新注入（这就是 D3 的全部价值）", () => {
		const forK3 = injectedFor(k3);
		assert.equal(forK3, 1, `本条应再注入 1 次（之前被收据挡住），实际 ${forK3}（本轮总注入 ${injectedBodies.length}，含其它 pending 项）`);
		// 重投后 confirmInjection 会在**原路径**写新收据 ⇒ 语义自然恢复
		const re = traceEntries().filter((t) => t.outboxId === k3 && t.kind === "C3-attempted-unconfirmed");
		assert.ok(re.length >= 1, "重投后应记录新的 unconfirmed attempt trace");
	});

	// ── A5 已有 2 次 unconfirmed ⇒ 不再放行 ───────────────────────
	const k5 = outboxItemId("wechat:d3-a5");
	seedItem("d3-a5");
	const e5 = seedInjectedOnce(k5, T1);
	recordAttempt(DELIVERY, e5, {
		attemptId: `${e5}@A@${T2.getTime()}`,
		channel: "A",
		at: T2.toISOString(),
		status: "unconfirmed",
		leaseOwner: "OB:1",
		leaseUntil: new Date(T2.getTime() + 15_000).toISOString(),
	});
	writeSession([assistantLine(`回述 ${eventMarker(e5)}`)]); // absent
	const beforeQ = quarantined().length;
	const inj5 = await runBridge(new Date("2026-11-10T03:30:00.000Z"));
	check("A5 已有 2 次 unconfirmed ⇒ 不放行（防每 tick 撞墙，比原缺陷更糟）", () => {
		assert.equal(existsSync(join(RECEIPTS, `outbox_${k5}.json`)), true, "收据必须保留（额度用完）");
		assert.equal(quarantined().length, beforeQ, `隔离文件数不应增加（仍 ${beforeQ}）`);
		const att = listAttempts(DELIVERY, e5).filter((a) => a.status === "unconfirmed");
		assert.equal(att.length, 2, "前置：应确有 2 次 unconfirmed");
		assert.equal(inj5, 0, `不该注入，实际 ${inj5}`);
	});

	// ── A6 冷却：距上次注入 <60s ⇒ 不放行 ─────────────────────────
	const k6 = outboxItemId("wechat:d3-a6");
	seedItem("d3-a6");
	const e6 = seedInjectedOnce(k6, new Date("2026-11-10T05:00:00.000Z"));
	writeSession([assistantLine(`回述 ${eventMarker(e6)}`)]);
	const beforeQ6 = quarantined().length;
	await runBridge(new Date("2026-11-10T05:00:30.000Z")); // 只过 30s
	check("A6 距上次注入 30s（<60s）⇒ 不放行（等会话 JSONL flush）", () => {
		assert.equal(existsSync(join(RECEIPTS, `outbox_${k6}.json`)), true, "收据必须保留");
		assert.equal(quarantined().length, beforeQ6, "隔离文件数不应增加");
		const l = traceEntries().filter((t) => t.outboxId === k6 && t.kind === "d3-probe-not-released");
		assert.equal(l[0]?.reason, "attempt-too-fresh", `应记录 attempt-too-fresh，实际 ${String(l[0]?.reason)}`);
	});

	// ── A7 【P0-b · 生产形状】落盘滞后 ⇒ 不放行（这条是 QC 假 absent 的直接复刻）──
	// 盘面：注入发生在 03:00，会话文件最后修改在 02:59（**注入后没有任何追加** = 还没 flush），
	// 反查时刻 03:06（年龄 360s > 300s 冷却 ⇒ 冷却闸放行，只剩「落盘滞后」这一道闸能拦住）。
	// 若桥没把 `injectedAtMs` 传给探针（或探针没有这条判据）⇒ 判 absent ⇒ 放行重投 ⇒ 本用例红。
	const k7 = outboxItemId("wechat:d3-a7");
	seedItem("d3-a7");
	const e7 = seedInjectedOnce(k7, new Date("2026-11-10T03:00:00.000Z"));
	writeSession([assistantLine(`回述 ${eventMarker(e7)}`)]);
	utimesSync(SESS_FILE, new Date("2026-11-10T02:59:00.000Z"), new Date("2026-11-10T02:59:00.000Z"));
	const beforeQ7 = quarantined().length;
	const injected7 = await runBridge(new Date("2026-11-10T03:06:00.000Z"));
	check("A7 文件 mtime 早于注入时刻（还没 flush）⇒ 不放行（收据保留、零隔离）", () => {
		assert.equal(injected7, 0, "本轮不得注入");
		assert.equal(existsSync(join(RECEIPTS, `outbox_${k7}.json`)), true, "收据必须保留（不许放行）");
		assert.equal(quarantined().length, beforeQ7, "零隔离文件");
		const l = traceEntries().filter((t) => t.outboxId === k7 && t.kind === "d3-probe-not-released");
		assert.equal(l[0]?.reason, "probe-inconclusive", `应记 probe-inconclusive（实得 ${String(l[0]?.reason)}）`);
		assert.equal(l[0]?.probeVerdict, "inconclusive", `probeVerdict 必须是 inconclusive（实得 ${String(l[0]?.probeVerdict)}）`);
	});

	console.log(`\nd3-wire: ${pass} passed, ${fail} failed`);
	if (fail > 0) process.exitCode = 1;
};

void main();
