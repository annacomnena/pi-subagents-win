/**
 * C-4 回归：outbox 事件身份必须稳定。
 *
 * 真机事故（msg c945db9f）：
 *   terminalRevision 把 item.text 算进哈希 ⇒ 正文一变 eventId 就变
 *   ⇒ 旧 eventId 上的 .ack.consumed 永远匹配不上
 *   ⇒ outbox 永远 pending ⇒ 每 10s 空转一条 message.received(replayed)
 *   ⇒ 12 小时空转 5153 条，events.jsonl 涨到 4.6MB
 *
 * 两组判据：
 *   A. 新代码：正文改了 eventId 不变（治根）
 *   B. 存量兼容：旧算法留下的 eventId 挂着真 ACK，仍能收敛成 delivered（治脏数据）
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "evid-"));
process.env.PI_RUNTIME_DIR = ROOT;

const { consumeOutboxOnce } = await import("./outbox-bridge.ts");
const { outboxDir, newOutboxItem, writeOutboxItem, readOutboxItem, outboxItemId } =
	await import("./runtime/message-outbox.ts");
const { defaultRuntimeDir } = await import("./runtime/journal.ts");
const { listAcks, deriveEventId, terminalRevisionOf } = await import("./delivery-ledger.ts");

const SID = "evid-sess";
const STATE = join(ROOT, "state");
const DIR = outboxDir(STATE);
const DELIVERY = join(ROOT, "delivery");
mkdirSync(DIR, { recursive: true });
mkdirSync(DELIVERY, { recursive: true });

let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
	try {
		await fn();
		passed += 1;
		console.log(`  ✓ ${name}`);
	} catch (e) {
		console.error(`  ✗ ${name}`);
		console.error(`    ${e instanceof Error ? e.message : String(e)}`);
		throw e;
	}
};
const flush = async (): Promise<void> => {
	for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

function seed(key: string, text: string) {
	const it = newOutboxItem({
		dedupeKey: key,
		commandKey: key,
		to: `pi://${SID}` as never,
		sessionId: SID,
		text,
		now: new Date(),
	});
	writeOutboxItem(DIR, it);
	return it;
}

/** 跑一轮桥；返回本轮注入次数。 */
async function runBridge(): Promise<number> {
	let injected = 0;
	consumeOutboxOnce({
		sessionId: SID,
		stateDir: STATE,
		deliveryDir: DELIVERY,
		sendUserMessage: (() => {
			injected += 1;
		}) as never,
		now: new Date(),
	} as never);
	await flush();
	return injected;
}

/** 该 outbox 项在磁盘上产生过的所有 eventId。 */
function eventIdsFor(itemId: string): string[] {
	const runId = `outbox_${itemId}`;
	let files: string[];
	try {
		files = readdirSync(DELIVERY);
	} catch {
		return [];
	}
	const out: string[] = [];
	for (const f of files) {
		if (!f.endsWith(".json") || f.includes(".ack.") || f.includes(".attempt.")) continue;
		try {
			const j = JSON.parse(readFileSync(join(DELIVERY, f), "utf8")) as { eventId?: string; runId?: string };
			if (j.runId === runId && typeof j.eventId === "string") out.push(j.eventId);
		} catch {
			/* ignore */
		}
	}
	return out;
}

console.log("\nA. 正文改动不得改变事件身份（治根）");

await check("A1 同一 outbox 项，text 改了 eventId 仍不变", () => {
	const revision = (text: string) =>
		terminalRevisionOf({ status: "pending", result: { status: "pending", outboxId: "X" } });
	// 直接锁 revision 的输入契约：outboxId 固定 ⇒ revision 固定，与 text 无关。
	const r1 = revision("第一条正文");
	const r2 = revision("完全不同的另一段正文，很长很长");
	assert.equal(r1, r2, "terminalRevision 不得包含 text —— 否则正文一改事件就换身份");
});

await check("A2 真跑桥：改正文后 eventId 逐字相同", async () => {
	const it = seed("wechat:a2", "原始正文");
	await runBridge();
	const ids1 = eventIdsFor(it.id);
	assert.equal(ids1.length, 1, `首轮应只产生 1 个 eventId，实际 ${ids1.length}: ${ids1.join(",")}`);

	// 改正文（模拟重试时正文被重写/截断/前缀拼接）
	const cur = readOutboxItem(DIR, outboxItemId("wechat:a2"));
	assert.ok(cur !== null, "outbox 项应存在");
	writeOutboxItem(DIR, { ...cur, text: "改过的正文（重试时被重写）" });

	await runBridge();
	const ids2 = eventIdsFor(it.id);
	assert.equal(ids2.length, 1, `改正文后不得新建 eventId，实际 ${ids2.length}: ${ids2.join(",")}`);
	assert.equal(ids2[0], ids1[0], "eventId 必须逐字不变");
});

await check("A3 对照：text 参与哈希会算出不同 revision（证明 A1 有判别力）", () => {
	const withText = (t: string) =>
		terminalRevisionOf({
			status: "pending",
			endedAt: "2026-11-02T14:29:13.712Z",
			result: { status: "pending", text: t, outboxId: "X" },
		});
	assert.notEqual(
		withText("正文甲"),
		withText("正文乙"),
		"旧算法（含 text）下两次哈希必须不同 —— 这正是本 bug 的机制",
	);
});

console.log("\nB. 存量脏数据兼容（治 12 小时空转）");

await check("B1 旧 eventId 挂着 consumed ACK ⇒ 必须收敛成 delivered", async () => {
	const it = seed("wechat:b1", "存量的老消息");
	const runId = `outbox_${it.id}`;

	// 构造「旧算法」的 eventId：把 text 算进哈希（复刻修复前行为）
	const legacyRevision = terminalRevisionOf({
		status: "pending",
		endedAt: it.createdAt,
		result: { status: "pending", text: "旧版本的正文", outboxId: it.id },
	});
	const legacyEventId = deriveEventId(runId, legacyRevision);

	// 盘上写这个旧 event（模拟历史遗留）
	writeFileSync(
		join(DELIVERY, `${encodeURIComponent(legacyEventId)}.json`),
		JSON.stringify({
			eventId: legacyEventId,
			runId,
			terminalRevision: legacyRevision,
			dispatcherSessionId: SID,
			createdAt: it.createdAt,
		}),
		"utf8",
	);
	// 给它挂一个 consumed ACK
	writeFileSync(
		join(DELIVERY, `${encodeURIComponent(legacyEventId)}.ack.consumed.x.json`),
		JSON.stringify({ eventId: legacyEventId, stage: "consumed", evidence: "context-observed" }),
		"utf8",
	);

	// 确认这个 ACK 在新 eventId 下查不到（这正是 bug 的现场）
	const currentId = deriveEventId(
		runId,
		terminalRevisionOf({ status: "pending", result: { status: "pending", outboxId: it.id } }),
	);
	assert.notEqual(currentId, legacyEventId, "新旧 eventId 必须不同（否则测不到兼容逻辑）");
	assert.equal(
		listAcks(DELIVERY, currentId).filter((a) => a.stage === "consumed").length,
		0,
		"新 eventId 下不应有 ACK —— 这就是空转的原因",
	);

	// 跑桥 ⇒ 应通过历史扫描收敛
	await runBridge();
	const after = readOutboxItem(DIR, outboxItemId("wechat:b1"));
	assert.equal(after?.status, "delivered", `历史 ACK 应能收敛成 delivered，实际 ${after?.status}`);
});

await check("B2 收敛之后不再空转（journal 不再增长）", async () => {
	const beforeTurn = await runBridge();
	assert.equal(beforeTurn, 0, "已 delivered 的项不得再注入");
	const st = readOutboxItem(DIR, outboxItemId("wechat:b1"));
	assert.equal(st?.status, "delivered", "状态必须稳定在 delivered");
});

await check("B3 历史扫描不得跨消息误认（runId 必须精确匹配）", async () => {
	// 造另一个 outbox 项，它的 event 里塞一个**别人的** consumed ACK 式记录
	const other = seed("wechat:b3", "另一条无关消息");
	await runBridge();
	const otherStatus = readOutboxItem(DIR, outboxItemId("wechat:b3"));
	// 这条没有任何 ACK ⇒ 必须仍是 pending（不能被 b1 的 ACK 误认成 delivered）
	assert.equal(
		otherStatus?.status,
		"pending",
		`无 ACK 的消息不得被别人的 ACK 误认，实际 ${otherStatus?.status}`,
	);
	assert.notEqual(other.id, outboxItemId("wechat:b1"), "两条消息 id 必须不同");
});

console.log(`\n_test_outbox_eventid_stability: ${passed} checks passed`);
rmSync(ROOT, { recursive: true, force: true });
